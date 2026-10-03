/**
 * SSE（Server-Sent Events）解析与工具调用分片归并。
 *
 * 这是整个项目最容易被低估、也最容易写错的一层。三个真实的坑：
 *
 * 1. **行会被网络切碎**：一次 chunk 可能停在半行中间，`data: {"cho` 就来了。
 *    所以必须缓冲到见到换行符再解析，不能对每个 chunk 直接 JSON.parse。
 *
 * 2. **一个响应里可能有多个工具调用，且分片交错到达**：
 *    OpenAI 兼容协议用 `index` 标识第几个调用，delta 形如
 *      {index:0, id:"call_a", function:{name:"read_file", arguments:""}}
 *      {index:1, id:"call_b", function:{name:"run_test",   arguments:"{\"na"}}
 *      {index:0,                function:{                arguments:"{\"path\""}}
 *      {index:1,                function:{                arguments:"me\":\"x\"}"}}
 *    `arguments` 是**字符串拼接**，且不能假设同一 index 的分片连续到达。
 *    只能按 index 建桶、各自累积，最后统一 parse。
 *
 * 3. **arguments 可能是空串或半截 JSON**：模型可能在流结束前被截断。
 *    这种情况必须显式报错，而不是把半截 JSON 当合法参数传下去。
 */

/** 单个工具调用分片的累加器。 */
class ToolCallAccumulator {
  constructor() {
    /** @type {Map<number, {id: string, name: string, argsText: string}>} */
    this.buckets = new Map();
  }

  /**
   * 吸收一个 delta.tool_calls 元素。
   * @param {{ index?: number, id?: string, function?: { name?: string, arguments?: string } }} piece
   */
  absorb(piece) {
    if (!piece || typeof piece !== 'object') return;
    // 协议上 index 一定存在；容错时退化为 0，避免整条流因个别实现不规范而崩掉。
    const index = Number.isInteger(piece.index) ? /** @type {number} */ (piece.index) : 0;

    let bucket = this.buckets.get(index);
    if (!bucket) {
      bucket = { id: '', name: '', argsText: '' };
      this.buckets.set(index, bucket);
    }
    if (piece.id) bucket.id = piece.id;
    const fn = piece.function;
    if (fn) {
      // name 正常只在首片出现，但用 += 更稳：个别网关会重复发送。
      if (fn.name) bucket.name = bucket.name ? bucket.name : fn.name;
      if (typeof fn.arguments === 'string') bucket.argsText += fn.arguments;
    }
  }

  /**
   * 收尾：按 index 升序输出，解析参数 JSON。
   * 解析失败不抛异常（否则一个坏调用会毁掉整轮），而是标记 invalid 交由上层决策。
   * @returns {Array<{ index:number, id:string, name:string, args:any, argsText:string, invalid:boolean, error?:string }>}
   */
  finalize() {
    return [...this.buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, b]) => {
        const raw = b.argsText.trim();
        if (raw === '') {
          return { index, id: b.id, name: b.name, args: {}, argsText: '', invalid: false };
        }
        try {
          const parsed = JSON.parse(raw);
          return { index, id: b.id, name: b.name, args: parsed, argsText: raw, invalid: false };
        } catch (err) {
          return {
            index,
            id: b.id,
            name: b.name,
            args: null,
            argsText: raw,
            invalid: true,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
  }
}

/**
 * 增量式 SSE 解析器。喂入任意切分的文本片段，产出完整事件。
 */
export class SseParser {
  constructor() {
    this.buffer = '';
    /** @type {string[]} */
    this.dataLines = [];
    /** 流结束时若缓冲区仍有未收尾的数据，标记为截断 —— 上层据此判断"响应不完整"。 */
    this.truncated = false;
  }

  /**
   * @param {string} chunk
   * @returns {Array<{ data: string }>} 已完整解析出的事件
   */
  push(chunk) {
    this.buffer += chunk;
    /** @type {Array<{ data: string }>} */
    const events = [];

    let newlineAt;
    while ((newlineAt = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        // 空行 = 事件边界
        if (this.dataLines.length > 0) {
          events.push({ data: this.dataLines.join('\n') });
          this.dataLines = [];
        }
        continue;
      }
      if (line.startsWith(':')) continue; // 注释/心跳
      if (line.startsWith('data:')) {
        let value = line.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        this.dataLines.push(value);
      }
      // 其余字段（event:/id:/retry:）本场景用不到，忽略
    }
    return events;
  }

  /**
   * 流结束时冲掉残留。
   *
   * 只吐出"字段完整、仅缺少最后那个分发空行"的事件 —— 这是部分服务端的常见行为。
   * 如果缓冲区里还有没有换行符收尾的残缺数据，说明流被截断，**必须丢掉**：
   * 把它当事件解析只会得到半个 JSON，然后在上层伪装成一次"模型返回了坏参数"。
   * 截断应该由 finish_reason 缺失来体现，而不是伪装成一次成功的解析。
   */
  flush() {
    if (this.buffer !== '') {
      this.truncated = true;
      this.buffer = '';
      this.dataLines = [];
      return [];
    }
    if (this.dataLines.length > 0) {
      const data = this.dataLines.join('\n');
      this.dataLines = [];
      return [{ data }];
    }
    return [];
  }
}

/**
 * 把一次 chat/completions 的流式响应聚合成一条完整 assistant 消息。
 *
 * @param {AsyncIterable<string>} chunks SSE 文本片段
 * @param {{ onDelta?: (ev: {type:string, text?:string}) => void }} [opts]
 * @returns {Promise<{ content:string, toolCalls:Array<any>, finishReason:string|null, usage:any, reasoning:string, invalidToolCalls:Array<any> }>}
 */
export async function accumulateStream(chunks, opts = {}) {
  const onDelta = opts.onDelta;
  const parser = new SseParser();
  const acc = new ToolCallAccumulator();

  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;

  const handleEvent = (data) => {
    if (data === '[DONE]') return false;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      // 非 JSON 的 data 行（部分网关会插调试信息）直接跳过，不让它中断整条流
      return true;
    }
    if (payload?.error) {
      const msg = payload.error.message || JSON.stringify(payload.error);
      throw new Error(`模型返回错误：${msg}`);
    }
    const choice = payload?.choices?.[0];
    if (payload?.usage) usage = payload.usage;
    if (!choice) return true;

    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onDelta) onDelta({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      if (onDelta) onDelta({ type: 'content', text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const piece of delta.tool_calls) acc.absorb(piece);
    }
    return true;
  };

  for await (const chunk of chunks) {
    for (const ev of parser.push(chunk)) {
      if (handleEvent(ev.data) === false) {
        // 见到 [DONE] 也要 flush 一次：只为判断尾部是否被截断，不再处理新数据
        parser.flush();
        return finish(acc, content, reasoning, finishReason, usage, parser.truncated);
      }
    }
  }
  for (const ev of parser.flush()) {
    if (handleEvent(ev.data) === false) break;
  }
  return finish(acc, content, reasoning, finishReason, usage, parser.truncated);
}

function finish(acc, content, reasoning, finishReason, usage, truncated) {
  const all = acc.finalize();
  return {
    content,
    reasoning,
    finishReason,
    usage,
    truncated: Boolean(truncated),
    toolCalls: all.filter((t) => !t.invalid),
    invalidToolCalls: all.filter((t) => t.invalid),
  };
}

export { ToolCallAccumulator };
