/**
 * Agent 主循环：把"模型决策 → 工具执行 → 结果回灌"串成一个可中断、可续跑、可观测的过程。
 *
 * 这个文件要处理的是"跑长任务"才会暴露的问题：
 *
 *   - 上下文会涨 → 超预算时压缩后继续，而不是报错退出
 *   - 模型会犯错 → 参数错的调用不能崩掉循环，要作为反馈回给它自纠
 *   - 模型会绕圈 → 同一个调用重复太多次要主动打断
 *   - 进程会死 → 每步落检查点，可以从断点续跑
 *   - 工具会偶发失败 → 故障注入用来量化"恢复率"，这是评测指标而非调试功能
 */
import { buildSystemPrompt, buildRequestMessages, compactionRatio, ContextOverflowError } from './context.js';
import { TOOL_SCHEMAS, TOOL_NAMES } from './tools.js';
import { Trace } from './trace.js';
import { estimateTokens } from './tokens.js';
import { createHash } from 'node:crypto';

export const DEFAULT_LOOP_LIMITS = Object.freeze({
  maxSteps: 24,
  maxPromptTokens: 24_000,
  /** 同一个工具调用（同名同参）连续重复达到该次数即打断，防止死循环烧 token。 */
  maxRepeatedCalls: 3,
  maxParallelTools: 6,
  /** 上下文溢出时的最大压缩重试次数。 */
  maxCompactionRetries: 2,
});

/**
 * 故障注入器：让指定工具的前 N 次调用返回可复现的失败。
 *
 * 为什么这是核心功能而不是测试脚手架：
 * "模型遇到工具失败能不能自己绕过去"是真实生产里最重要的鲁棒性指标，
 * 不注入故障就只能靠运气等它自然出错，那样得到的数字不可复现、不能进报告。
 */
export class FaultInjector {
  /**
   * @param {Record<string, { failTimes: number, message?: string, code?: string }>} plan 工具名 → 注入方案
   */
  constructor(plan = {}) {
    this.plan = plan;
    /** @type {Map<string, number>} */
    this.seen = new Map();
    this.injected = 0;
  }

  /**
   * @param {string} toolName
   * @returns {{ fail: true, message: string, code: string } | null}
   */
  check(toolName) {
    const rule = this.plan[toolName];
    if (!rule) return null;
    const n = (this.seen.get(toolName) || 0) + 1;
    this.seen.set(toolName, n);
    if (n > rule.failTimes) return null;
    this.injected += 1;
    return {
      fail: true,
      message: rule.message || `注入故障：工具「${toolName}」第 ${n} 次调用失败`,
      code: rule.code || 'INJECTED_FAULT',
    };
  }
}

function signatureOf(call) {
  return createHash('sha1')
    .update(`${call.name}:${JSON.stringify(call.args ?? {})}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * 跑一个任务。
 *
 * @param {{
 *   provider: import('./provider.js').Provider,
 *   toolbox: import('./tools.js').ToolBox,
 *   task: string,
 *   limits?: Partial<typeof DEFAULT_LOOP_LIMITS>,
 *   effort?: string,
 *   trace?: Trace,
 *   faultInjector?: FaultInjector,
 *   systemPrompt?: string,
 *   onStep?: (info: any) => void,
 * }} opts
 * @returns {Promise<{
 *   ok: boolean, stopReason: string, answer: string|null,
 *   history: Array<any>, steps: number, tokens: any, compactions: number,
 *   blockedCalls: number, invalidCalls: number, repeatedCallBreak?: string,
 *   checkpoint?: any,
 * }>}
 */
export async function runAgent(opts) {
  const {
    provider,
    toolbox,
    task,
    limits: limitOverrides = {},
    trace = new Trace(),
    faultInjector = null,
    onStep = null,
  } = opts;

  const limits = { ...DEFAULT_LOOP_LIMITS, ...limitOverrides };
  const systemPrompt = opts.systemPrompt || buildSystemPrompt({ toolNames: TOOL_NAMES });
  const toolsTokens = estimateTokens(JSON.stringify(TOOL_SCHEMAS));

  /** @type {Array<any>} */
  let history = [{ role: 'user', content: task }];

  let steps = 0;
  let compactions = 0;
  let blockedCalls = 0;
  let invalidCalls = 0;
  let apiRetries = 0;
  const tokenTotals = { prompt: 0, completion: 0, cached: 0, reasoning: 0 };
  const callCounts = new Map();

  trace.emit('run.start', { task: task.slice(0, 300), model: provider.model, limits });

  for (steps = 1; steps <= limits.maxSteps; steps++) {
    // 1) 按预算构造这一步要发的 messages
    let request;
    try {
      request = buildRequestMessages({
        systemPrompt,
        history,
        maxPromptTokens: limits.maxPromptTokens,
        toolsTokens,
        keepRecentMessages: 6,
      });
    } catch (err) {
      if (err instanceof ContextOverflowError) {
        trace.finish('context_overflow', { detail: err.message, steps });
        return finishResult({
          ok: false,
          stopReason: 'context_overflow',
          answer: null,
          history,
          steps,
          tokenTotals,
          compactions,
          blockedCalls,
          invalidCalls,
          trace,
          error: err.message,
        });
      }
      throw err;
    }

    if (request.compacted) {
      compactions += 1;
      history = request.stats ? applyCompactionToHistory(history) : history;
      trace.emit('context.compacted', {
        step: steps,
        ratio: compactionRatio(request.stats),
        toolResultsCompacted: request.stats?.toolResultsCompacted ?? 0,
        tokens: request.tokens,
      });
    }

    // 2) 调模型
    const t0 = Date.now();
    let response;
    let compactionRetries = 0;
    for (;;) {
      try {
        response = await provider.chat(request.messages, {
          tools: TOOL_SCHEMAS,
          effort: opts.effort || undefined,
          onRetry: (info) => {
            apiRetries += 1;
            trace.emit('provider.retry', { step: steps, ...info });
          },
        });
        break;
      } catch (err) {
        // 服务端因超长拒绝时，压缩后重试而不是直接失败
        const overLong = /context|length|too long|maximum/i.test(err instanceof Error ? err.message : '');
        if (!overLong) {
          // 非超长的硬失败（鉴权、网络彻底不通等）：如实报告，不要把异常抛穿整个评测
          trace.finish('provider_error', { steps, error: err instanceof Error ? err.message : String(err) });
          return finishResult({
            ok: false,
            stopReason: 'provider_error',
            answer: null,
            history,
            steps,
            tokenTotals,
            compactions,
            blockedCalls,
            invalidCalls,
            trace,
            apiRetries,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (compactionRetries >= limits.maxCompactionRetries) {
          trace.finish('context_overflow', { steps, error: String(err?.message || err) });
          return finishResult({
            ok: false,
            stopReason: 'context_overflow',
            answer: null,
            history,
            steps,
            tokenTotals,
            compactions,
            blockedCalls,
            invalidCalls,
            trace,
            apiRetries,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        compactionRetries += 1;
        compactions += 1;
        const extra = clampHistory(history, Math.max(2, 6 - compactionRetries * 2));
        history = extra;
        trace.emit('context.forced_compaction', { step: steps, attempt: compactionRetries });
        request = buildRequestMessages({
          systemPrompt,
          history,
          maxPromptTokens: limits.maxPromptTokens,
          toolsTokens,
          keepRecentMessages: Math.max(2, 6 - compactionRetries * 2),
        });
      }
    }
    const latencyMs = Date.now() - t0;

    const usage = response.usage || {};
    const stepPrompt = Number(usage.prompt_tokens) || 0;
    const stepCompletion = Number(usage.completion_tokens) || 0;
    const stepCached = Number(usage.prompt_cache_hit_tokens) || 0;
    tokenTotals.prompt += stepPrompt;
    tokenTotals.completion += stepCompletion;
    tokenTotals.cached += stepCached;

    const validCalls = response.toolCalls || [];
    const badCalls = response.invalidToolCalls || [];
    invalidCalls += badCalls.length;

    trace.llmStep(steps, {
      latencyMs,
      toolCalls: validCalls.length,
      invalidToolCalls: badCalls.length,
      contentChars: (response.content || '').length,
      finishReason: response.finishReason,
      usage: {
        prompt_tokens: stepPrompt,
        completion_tokens: stepCompletion,
        prompt_cache_hit_tokens: stepCached,
      },
      truncated: response.truncated,
    });

    // 3) 把 assistant 这一步完整记入历史（含它请求的工具调用）。
    //    无效调用也必须进 assistant 的 tool_calls：OpenAI 兼容协议要求每个
    //    tool_call 后面都要有对应的 tool 响应。若这里只记 validCalls，坏调用的
    //    错误回灌就会变成「没有对应 tool_call 的孤儿 tool 消息」，接口直接 400
    //    （t6-daterange 评测中真实触发过：invalid_request_error）。
    const allCalls = [
      ...validCalls.map((c) => ({ id: c.id, name: c.name, args: c.args, argsRaw: c.argsText })),
      ...badCalls.map((bad) => ({
        id: bad.id || `invalid_${bad.index}`,
        name: bad.name || 'unknown',
        args: {},
        argsRaw: bad.argsText || '',
      })),
    ];
    history.push({
      role: 'assistant',
      content: response.content || '',
      reasoning: response.reasoning || '',
      toolCalls: allCalls,
    });

    // 4) 处理坏调用：作为错误反馈回灌，让模型自我修正。
    //    toolCallId 必须与上面 assistant.tool_calls 里的 id 完全一致（同一表达式），
    //    否则还是会产生孤儿 tool 消息。
    if (badCalls.length > 0) {
      for (const bad of badCalls) {
        history.push({
          role: 'tool',
          toolCallId: bad.id || `invalid_${bad.index}`,
          name: bad.name || 'unknown',
          ok: false,
          content: JSON.stringify({
            ok: false,
            code: 'INVALID_ARGS_JSON',
            error: `工具参数不是合法 JSON（可能被截断）：${bad.error}。请重新调用并确保参数完整。`,
          }),
        });
      }
    }

    if (validCalls.length === 0) {
      // 没有工具调用：要么它认为任务完成，要么它只是在说话
      if (response.content && response.content.trim()) {
        trace.finish('answered_without_finish', { steps });
        return finishResult({
          ok: false,
          stopReason: 'answered_without_finish',
          answer: response.content,
          history,
          steps,
          tokenTotals,
          compactions,
          blockedCalls,
          invalidCalls,
          trace,
        });
      }
      // 既没工具调用也没内容：空转，提示它继续
      history.push({
        role: 'user',
        content: '你上一步没有返回任何内容或工具调用。请继续：要么调用工具推进任务，要么调用 finish 提交结论。',
      });
      continue;
    }

    // 5) 重复调用检测：同样的调用在**连续多步**里反复出现，说明模型卡住了。
    //
    // 关键语义：同一批并行调用里出现多个相同调用**不算重复**。
    // 模型一次读同一个文件三次是低效，不是绕圈；真正的绕圈是"这一步和上一步做一模一样的事"。
    // 曾经在这里写错过一次：把批内重复也计数，导致合法的并行读操作在第 1 步就被误杀。
    const stepSignatures = new Set();
    const batchDuplicates = [];
    for (const call of validCalls) {
      const sig = signatureOf(call);
      if (stepSignatures.has(sig)) batchDuplicates.push(call.name);
      stepSignatures.add(sig);
      const prev = callCounts.get(sig) || { step: -1, count: 0 };
      const count = prev.step === steps - 1 ? prev.count + 1 : 1;
      callCounts.set(sig, { step: steps, count });

      if (count >= limits.maxRepeatedCalls) {
        trace.finish('repeated_call', { steps, signature: sig, call: { name: call.name, args: call.args } });
        return finishResult({
          ok: false,
          stopReason: 'repeated_call',
          answer: null,
          history,
          steps,
          tokenTotals,
          compactions,
          blockedCalls,
          invalidCalls,
          trace,
          repeatedCallBreak: `${call.name}(${JSON.stringify(call.args)}) 已连续 ${count} 步重复出现`,
        });
      }
    }
    if (batchDuplicates.length > 0) {
      // 只记录不打断：批内重复是低效，不是绕圈
      trace.emit('loop.batch_duplicate', { step: steps, tools: batchDuplicates });
    }

    // 6) 执行工具（并行，但结果顺序必须与调用顺序一致 —— 协议要求）
    const results = await runToolsInParallel({
      calls: validCalls.slice(0, limits.maxParallelTools),
      toolbox,
      faultInjector,
      step: steps,
      trace,
    });

    // 被 maxParallelTools 截掉的调用也要给出结果，否则历史里会出现没有结果的 tool_calls，协议非法
    for (const call of validCalls.slice(limits.maxParallelTools)) {
      results.push({
        id: call.id,
        name: call.name,
        ok: false,
        code: 'TOO_MANY_PARALLEL',
        content: JSON.stringify({
          ok: false,
          code: 'TOO_MANY_PARALLEL',
          error: `本步并行工具调用超过上限 ${limits.maxParallelTools}，该调用未执行。请分步重试。`,
        }),
      });
      blockedCalls += 1;
    }

    for (const r of results) {
      if (r.code === 'PATH_ESCAPE' || r.code === 'COMMAND_NOT_ALLOWED' || r.code === 'COMMAND_FORBIDDEN') {
        blockedCalls += 1;
      }
      history.push({ role: 'tool', toolCallId: r.id, name: r.name, ok: r.ok, content: r.content });
    }

    // 7) finish 是终止信号
    const finished = results.find((r) => r.name === 'finish' && r.ok);
    if (finished) {
      const answer = safeParse(finished.content)?.result?.summary ?? '';
      trace.finish('finished', { steps });
      return finishResult({
        ok: true,
        stopReason: 'finished',
        answer,
        history,
        steps,
        tokenTotals,
        compactions,
        blockedCalls,
        invalidCalls,
        trace,
        apiRetries,
      });
    }

    if (onStep) {
      onStep({ step: steps, toolCalls: validCalls.length, latencyMs, tokens: tokenTotals });
    }
  }

  trace.finish('max_steps', { steps: limits.maxSteps });
  return finishResult({
    ok: false,
    stopReason: 'max_steps',
    answer: null,
    history,
    steps: limits.maxSteps,
    tokenTotals,
    compactions,
    blockedCalls,
    invalidCalls,
    trace,
    apiRetries,
  });
}

/**
 * 并行执行工具。用 Promise.all 而不是串行：多个独立读操作串行毫无收益，
 * 而并行能显著缩短一步的墙钟时间。结果顺序按调用顺序返回。
 */
async function runToolsInParallel({ calls, toolbox, faultInjector, step, trace }) {
  const jobs = calls.map(async (call) => {
    const injected = faultInjector ? faultInjector.check(call.name) : null;
    if (injected) {
      trace.toolStep(step, {
        name: call.name,
        ok: false,
        durationMs: 0,
        injected: true,
        args: truncateArgs(call.args),
      });
      return {
        id: call.id,
        name: call.name,
        ok: false,
        code: injected.code,
        content: JSON.stringify({ ok: false, code: injected.code, error: injected.message }),
      };
    }

    const res = await toolbox.execute({ id: call.id, name: call.name, args: call.args });
    const content = res.ok
      ? JSON.stringify({ ok: true, result: res.result })
      : JSON.stringify({ ok: false, code: res.code, error: res.error });

    trace.toolStep(step, {
      name: call.name,
      ok: res.ok,
      durationMs: res.durationMs,
      code: res.code,
      args: truncateArgs(call.args),
      resultChars: content.length,
    });

    return { id: call.id, name: call.name, ok: res.ok, code: res.code, content };
  });

  return Promise.all(jobs);
}

function truncateArgs(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 压缩后把历史替换成压缩版本。
 * 直接从 request.messages 反推内部结构是不可靠的（协议格式与内部格式不同），
 * 所以这里只做一件事：保留最近若干条，丢弃更早的正文。
 */
function clampHistory(history, keep) {
  if (history.length <= keep) return history;
  let boundary = history.length - keep;
  while (boundary > 0 && history[boundary]?.role === 'tool') boundary -= 1;
  return [
    history[0], // 任务描述必须保留
    ...(boundary > 1 ? [{ role: 'user', content: '[早期步骤已压缩省略]' }] : []),
    ...history.slice(boundary).filter((m) => m !== history[0]),
  ];
}

function applyCompactionToHistory(history) {
  // 压缩发生在协议层，但历史要继续增长。这里用"保留尾部"的方式与压缩保持一致，
  // 避免下一步又把刚压掉的内容原样发出去（那样压缩就白做了，token 会再次飙升）。
  const keep = Math.max(4, Math.min(history.length, 8));
  return clampHistory(history, keep);
}

function finishResult(info) {
  const { trace, ...rest } = info;
  return {
    ...rest,
    tokenTotals: info.tokenTotals,
    summary: trace?.summary ? trace.summary() : null,
  };
}
