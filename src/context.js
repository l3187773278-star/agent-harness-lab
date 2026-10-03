/**
 * 上下文管理：决定"这一步发给模型的 messages 长什么样"。
 *
 * 长任务一定会撞到窗口上限。撞上之后有两条路：
 *   (a) 直接报错退出 —— 任务失败，前功尽弃
 *   (b) 压缩历史继续跑 —— 但压得不好会丢掉关键信息，模型开始胡猜
 *
 * 这个模块做 (b)，并且把"什么能压、什么不能压"写死成规则：
 *
 *   不能压：system 提示（稳定前缀，也是 prompt cache 的锚点）
 *           用户的任务描述（丢了它模型就不知道要干什么）
 *           最近 N 条消息（当前推理的直接上下文）
 *
 *   可以压：**旧工具结果**（长任务里体积最大的部分，且价值随时间衰减）
 *           旧 assistant 的长篇正文（结论重要，推导过程不重要）
 *           reasoning 内容（只在当步有用，绝不回灌历史）
 *
 * 压缩必须**可解释**：每一步压掉了多少、压了什么，都要能报告出来。
 * 否则"压缩比"这个指标就成了黑箱数字，既无法解释也无法优化。
 */
import { estimateTokens as estimate } from './tokens.js';

export { estimate };

/** 默认预算。窗口 128k 的情况下留足输出与工具结果的空间。 */
export const DEFAULT_BUDGET = Object.freeze({
  maxPromptTokens: 24_000,
  keepRecentMessages: 6,
  compactedToolResultChars: 400,
  compactedAssistantChars: 800,
});

export class ContextOverflowError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ContextOverflowError';
    Object.assign(this, detail);
  }
}

/**
 * 构造系统提示。
 *
 * 刻意做成**常量**：它每一步都原样发送，形成稳定前缀，
 * 让服务端的 prompt cache 能命中（DeepSeek 会自动缓存重复前缀，命中部分计费更低）。
 * 实测数据里 cached_tokens 就是靠这个拿到的。
 */
export function buildSystemPrompt(opts = {}) {
  const toolList = opts.toolNames || [];
  return [
    '你是一个严谨的软件工程 agent，在一个受限工作区内完成任务。',
    '',
    '工作方式：',
    '1. 先弄清现状再动手：用 list_files / read_file / search_text 获取事实，不要凭猜测修改。',
    '2. 每次只做必要的改动；小改用 edit_file，整文件重写才用 write_file。',
    '3. 改完必须验证：用 run_command 跑测试或执行脚本，把结果作为下一步依据。',
    '4. 得出结论后调用 finish 提交，不要在任务未验证时声称完成。',
    '',
    '约束：',
    '- 路径只能用工作区内的相对路径；绝对路径与 .. 会被拒绝。',
    '- run_command 不走 shell，没有管道与重定向；命令必须在白名单内。',
    '- 工具失败会以错误信息返回，请据此调整参数重试，而不是重复同样的调用。',
    `- 可用工具：${toolList.join('、')}`,
  ].join('\n');
}

/**
 * 把内部消息结构翻译成 OpenAI 兼容协议的 messages。
 *
 * 内部结构（与 provider 无关，便于测试）：
 *   { role:'user', content }
 *   { role:'assistant', content, toolCalls:[{id,name,args}], reasoning }
 *   { role:'tool', toolCallId, name, content, ok }
 *
 * @param {Array<any>} messages
 */
export function toApiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      /** @type {Record<string, unknown>} */
      const out = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            // 参数必须是字符串形式的 JSON，不能传对象 —— 协议要求
            arguments: typeof tc.argsRaw === 'string' ? tc.argsRaw : JSON.stringify(tc.args ?? {}),
          },
        }));
      }
      // reasoning_content 不回灌：DeepSeek 文档明确要求多轮里不要回传上一轮的思维链，
      // 回传既浪费 token 也可能干扰后续推理。
      return out;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }
    return { role: m.role, content: String(m.content ?? '') };
  });
}

/** 消息占用的 token 估算（基于 tokens.js 的字符启发式）。 */
export function messagesTokens(messages) {
  return messages.reduce((sum, m) => {
    let n = estimate(m.content || '');
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        n += estimate(tc.name || '') + estimate(typeof tc.argsRaw === 'string' ? tc.argsRaw : JSON.stringify(tc.args ?? {}));
      }
    }
    return sum + n + 4; // 每条消息的固定开销
  }, 0);
}

/**
 * 压缩历史。返回**新数组**，不改动入参。
 *
 * @param {Array<any>} messages
 * @param {{ keepRecentMessages?: number, compactedToolResultChars?: number, compactedAssistantChars?: number }} [opts]
 * @returns {{ messages: Array<any>, stats: { before:number, after:number, toolResultsCompacted:number, assistantsCompacted:number, droppedReasoning:number } }}
 */
export function compactMessages(messages, opts = {}) {
  const keep = opts.keepRecentMessages ?? DEFAULT_BUDGET.keepRecentMessages;
  const toolChars = opts.compactedToolResultChars ?? DEFAULT_BUDGET.compactedToolResultChars;
  const assistantChars = opts.compactedAssistantChars ?? DEFAULT_BUDGET.compactedAssistantChars;

  const stats = { before: 0, after: 0, toolResultsCompacted: 0, assistantsCompacted: 0, droppedReasoning: 0 };
  if (messages.length === 0) return { messages: [], stats };

  // 找出最近 keep 条消息的起点。注意不能把一个 assistant 的 tool_calls
  // 和它对应的 tool 结果拆开 —— 拆开会产生"孤立的 tool 结果"，
  // 协议上是非法的，服务端会直接报错。
  let boundary = Math.max(0, messages.length - keep);
  while (boundary > 0 && messages[boundary]?.role === 'tool') boundary -= 1;

  const head = messages.slice(0, boundary);
  const tail = messages.slice(boundary);

  const compactedHead = head.map((m) => {
    if (m.role === 'tool') {
      const content = String(m.content ?? '');
      if (content.length <= toolChars) return m;
      stats.toolResultsCompacted += 1;
      return {
        ...m,
        content: `${content.slice(0, toolChars)}\n…[早期工具结果已压缩，原长 ${content.length} 字符]`,
      };
    }
    if (m.role === 'assistant') {
      /** @type {Record<string, unknown>} */
      const out = { ...m };
      delete out.reasoning;
      if (m.reasoning) stats.droppedReasoning += 1;
      if (typeof m.content === 'string' && m.content.length > assistantChars) {
        stats.assistantsCompacted += 1;
        out.content = `${m.content.slice(0, assistantChars)}…[早期说明已压缩]`;
      }
      return out;
    }
    // user 消息一律保留原样：任务描述与用户补充是判断依据，压了就失去基准
    return m;
  });

  const result = [...compactedHead, ...tail];
  stats.before = messagesTokens(messages);
  stats.after = messagesTokens(result);
  return { messages: result, stats };
}

/**
 * 按预算构造最终发送的 messages，必要时反复压缩直到进入预算。
 *
 * 压缩是**渐进**的：先压工具结果，还不够就减少"保留最近消息"的条数。
 * 一次压到最狠会过早丢失上下文；逐步加压只在需要时付出代价。
 *
 * @param {{
 *   systemPrompt: string,
 *   history: Array<any>,
 *   maxPromptTokens?: number,
 *   toolsTokens?: number,
 *   keepRecentMessages?: number,
 * }} opts
 * @returns {{ messages: Array<any>, stats: any, compacted: boolean, tokens: number }}
 */
export function buildRequestMessages(opts) {
  const {
    systemPrompt,
    history,
    maxPromptTokens = DEFAULT_BUDGET.maxPromptTokens,
    toolsTokens = 0,
    keepRecentMessages = DEFAULT_BUDGET.keepRecentMessages,
  } = opts;

  const budget = maxPromptTokens - toolsTokens;
  if (budget <= 0) {
    throw new ContextOverflowError(
      `工具定义本身已超出预算：工具约 ${toolsTokens} token，预算 ${maxPromptTokens} token`,
      { toolsTokens, maxPromptTokens },
    );
  }

  const system = { role: 'system', content: systemPrompt };
  const systemTokens = messagesTokens([system]);
  const estimateFor = (h) => systemTokens + messagesTokens(h);

  let current = history;
  if (estimateFor(current) <= budget) {
    const messages = [system, ...toApiMessages(current)];
    return { messages, stats: null, compacted: false, tokens: estimateFor(current) };
  }

  const lastStats = { before: 0, after: 0, toolResultsCompacted: 0, assistantsCompacted: 0, droppedReasoning: 0 };
  let keep = keepRecentMessages;
  for (let round = 0; round < 6; round++) {
    const { messages: next, stats } = compactMessages(current, {
      keepRecentMessages: keep,
      compactedToolResultChars: Math.max(120, DEFAULT_BUDGET.compactedToolResultChars >> round),
      compactedAssistantChars: Math.max(200, DEFAULT_BUDGET.compactedAssistantChars >> round),
    });
    current = next;
    Object.assign(lastStats, {
      toolResultsCompacted: lastStats.toolResultsCompacted + stats.toolResultsCompacted,
      assistantsCompacted: lastStats.assistantsCompacted + stats.assistantsCompacted,
      droppedReasoning: lastStats.droppedReasoning + stats.droppedReasoning,
    });

    if (estimateFor(current) <= budget) {
      // 逐步收紧保留窗口，但绝不少于 2 条（至少保住最近的问答对）
      keep = Math.max(2, keep - 2);
      if (keep === 2 && round < 5) continue;
      const messages = [system, ...toApiMessages(current)];
      return { messages, stats: { ...lastStats, before: stats.before, after: stats.after }, compacted: true, tokens: estimateFor(current) };
    }
    keep = Math.max(2, keep - 2);
  }

  throw new ContextOverflowError(
    `压缩 ${6} 轮后仍超出预算：约 ${estimateFor(current)} token > ${budget} token`,
    { tokens: estimateFor(current), budget },
  );
}

/**
 * 计算两次压缩之间的收益，用于报告里的"压缩比"。
 * @param {{ before:number, after:number }} stats
 */
export function compactionRatio(stats) {
  if (!stats || !stats.before) return 1;
  return Number((stats.after / stats.before).toFixed(4));
}
