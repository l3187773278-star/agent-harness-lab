/**
 * 录制 / 回放层。
 *
 * 解决的问题：协议层与循环层的逻辑必须有测试，但测试不能依赖真实网络——
 *   1) 真实调用花钱、慢、不确定，CI 里跑不起来
 *   2) 没有 API Key 的人 clone 下来 `npm test` 必须是绿的
 *
 * 做法：把一次真实 HTTP 往返（请求体 + 原始 SSE 分片）存成夹具文件，
 * 测试时用 createReplayFetch() 顶替 globalThis.fetch。
 * Provider 完全不知道自己面对的是真网络还是夹具——这层透明性来自 provider 接受注入的 fetchImpl。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} FixtureEntry
 * @property {string} name
 * @property {any} request        发给模型请求体（不含密钥）
 * @property {number} status
 * @property {string[]} chunks     原始 SSE 文本分片（保持录制时的切分边界，便于复现解析边界问题）
 * @property {string} [note]
 *
 * @typedef {Object} Fixture
 * @property {string} version
 * @property {string} [recordedAt]
 * @property {string} [model]
 * @property {FixtureEntry[]} entries
 */

/**
 * 造一个假的 fetch，按顺序返回夹具里录好的响应。
 *
 * @param {Fixture} fixture
 * @param {{ onRequest?: (body: any, index: number) => void }} [opts]
 * @returns {typeof fetch}
 */
export function createReplayFetch(fixture, opts = {}) {
  let cursor = 0;

  return async function replayFetch(_url, init = {}) {
    const entry = fixture.entries[cursor];
    if (!entry) {
      throw new Error(
        `回放夹具已用完：第 ${cursor + 1} 次请求没有对应记录。` +
          `夹具共 ${fixture.entries.length} 条。若是循环步数变多，应重新录制夹具。`,
      );
    }
    cursor += 1;

    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (opts.onRequest) opts.onRequest(body, cursor - 1);

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of entry.chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });

    return new Response(stream, {
      status: entry.status ?? 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

/**
 * 包装真实的 fetch，把每一次往返录下来。
 *
 * @param {typeof fetch} realFetch
 * @param {{ note?: string }} [opts]
 */
export function createRecordingFetch(realFetch, opts = {}) {
  /** @type {FixtureEntry[]} */
  const entries = [];

  const recordingFetch = async function recordingFetch(url, init = {}) {
    const requestBody = init.body ? JSON.parse(String(init.body)) : null;
    const res = await realFetch(url, init);

    // 错误响应直接透传，不作为可回放夹具（夹具只记录成功路径）
    if (!res.ok || !res.body) return res;

    const chunks = [];
    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        chunks.push(text);
        fullText += text;
      }
    } finally {
      reader.releaseLock();
    }

    entries.push({
      name: opts.note ? `${opts.note}#${entries.length + 1}` : `entry-${entries.length + 1}`,
      request: requestBody,
      status: res.status,
      chunks,
    });

    // 把已读干净的流重新组装成一个新 Response，交给上层正常消费
    return new Response(fullText, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/event-stream' },
    });
  };

  recordingFetch.dump = () => ({
    version: '1',
    recordedAt: new Date().toISOString(),
    entries,
  });

  return recordingFetch;
}

/**
 * 把夹具写到磁盘。
 * @param {string} file
 * @param {Fixture} fixture
 */
export function writeFixture(file, fixture) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 读夹具。
 * @param {string} file
 * @returns {Fixture}
 */
export function loadFixture(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`夹具格式不对（缺少 entries 数组）：${file}`);
  }
  return parsed;
}

/**
 * 由若干"模型回复"合成夹具，供单元测试手写场景用。
 * 把一条完整 assistant 消息切成 SSE 分片，可以精确控制切分位置——
 * 这正是测试"分片跨界解析"所需要的。
 *
 * @param {Array<{ content?: string, toolCalls?: Array<{id?:string,name:string,args:any,argsRaw?:string}>, finishReason?: string, reasoning?: string, usage?: any }>} turns
 * @param {{ splitEvery?: number }} [opts]
 * @returns {Fixture}
 */
export function buildFixtureFromTurns(turns, opts = {}) {
  const splitEvery = opts.splitEvery ?? 0;

  const entries = turns.map((turn, i) => {
    const events = [];

    if (turn.reasoning) {
      events.push({ choices: [{ delta: { reasoning_content: turn.reasoning }, index: 0 }] });
    }
    if (turn.content) {
      events.push({ choices: [{ delta: { content: turn.content }, index: 0 }] });
    }
    (turn.toolCalls || []).forEach((tc, idx) => {
      // 首片带 id 与 name，参数留空 —— 与真实协议一致
      events.push({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: idx, id: tc.id || `call_${i}_${idx}`, type: 'function', function: { name: tc.name, arguments: '' } },
              ],
            },
            index: 0,
          },
        ],
      });
      const raw = tc.argsRaw !== undefined ? tc.argsRaw : JSON.stringify(tc.args ?? {});
      // 把参数切成多片，模拟真实流式到达；如果用户给了 argsRaw 就原样发一片，用于测坏 JSON
      const pieces = tc.argsRaw !== undefined ? [raw] : splitString(raw, 3);
      for (const piece of pieces) {
        events.push({
          choices: [{ delta: { tool_calls: [{ index: idx, function: { arguments: piece } }] }, index: 0 }],
        });
      }
    });

    events.push({ choices: [{ delta: {}, finish_reason: turn.finishReason || 'stop', index: 0 }] });
    if (turn.usage) events.push({ choices: [], usage: turn.usage });

    const chunks = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
    chunks.push('data: [DONE]\n\n');

    return {
      name: `turn-${i + 1}`,
      request: { model: 'test-model' },
      status: 200,
      chunks: splitEvery > 0 ? chunks.flatMap((c) => splitString(c, splitEvery)) : chunks,
    };
  });

  return { version: '1', recordedAt: new Date().toISOString(), entries };
}

/**
 * 把字符串按固定长度切碎，模拟网络分片。
 * @param {string} s
 * @param {number} n
 * @returns {string[]}
 */
export function splitString(s, n) {
  if (!n || n <= 0 || s.length <= n) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
