/**
 * 结构化轨迹记录。
 *
 * 为什么不用 console.log：
 * 评测要回答"它为什么失败"，就必须能回放每一步——模型看到了什么 messages、
 * 返回了哪些工具调用、工具结果是什么、这一步花了多少 token 与多少毫秒。
 * 一次性打印到屏幕上的日志无法回答这类问题。
 *
 * 落盘格式选 JSONL（一行一个事件）：
 *   - 追加写，进程被杀也不会丢已写部分
 *   - 可以用 grep / jq 直接查，不需要专门工具
 *   - 天然适合流式消费
 */
import fs from 'node:fs';
import path from 'node:path';

export class Trace {
  /**
   * @param {{ file?: string|null, runId?: string, echo?: boolean }} [opts]
   */
  constructor(opts = {}) {
    this.runId = opts.runId || `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.file = opts.file ?? null;
    this.echo = Boolean(opts.echo);
    this.seq = 0;
    /** @type {Array<Record<string, unknown>>} */
    this.events = [];
    this.startedAt = Date.now();

    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, '', 'utf8');
    }
  }

  /**
   * 记录一个事件。
   * @param {string} type
   * @param {Record<string, unknown>} [data]
   */
  emit(type, data = {}) {
    const event = {
      seq: ++this.seq,
      t: Date.now() - this.startedAt,
      type,
      runId: this.runId,
      ...data,
    };
    this.events.push(event);
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
      } catch {
        // 轨迹写失败不应中断任务本身
        this.file = null;
      }
    }
    if (this.echo) {
      const brief = summarize(event);
      if (brief) process.stderr.write(`${brief}\n`);
    }
    return event;
  }

  /** 便捷方法：一次模型调用。 */
  llmStep(step, info) {
    return this.emit('llm.step', { step, ...info });
  }

  /** 便捷方法：一次工具执行。 */
  toolStep(step, info) {
    return this.emit('tool.step', { step, ...info });
  }

  /** 便捷方法：一轮结束。 */
  finish(outcome, info = {}) {
    return this.emit('run.finish', { outcome, ...info });
  }

  /** 汇总统计，供评测报告使用。 */
  summary() {
    const llm = this.events.filter((e) => e.type === 'llm.step');
    const tool = this.events.filter((e) => e.type === 'tool.step');
    /** @type {number[]} */
    const latencies = llm.map((e) => Number(/** @type {any} */ (e).latencyMs) || 0).filter((n) => n > 0);
    latencies.sort((a, b) => a - b);

    return {
      runId: this.runId,
      events: this.events.length,
      llmSteps: llm.length,
      toolSteps: tool.length,
      promptTokens: llm.reduce((s, e) => s + (Number(/** @type {any} */ (e).usage?.prompt_tokens) || 0), 0),
      completionTokens: llm.reduce(
        (s, e) => s + (Number(/** @type {any} */ (e).usage?.completion_tokens) || 0),
        0,
      ),
      cachedTokens: llm.reduce(
        (s, e) => s + (Number(/** @type {any} */ (e).usage?.prompt_cache_hit_tokens) || 0),
        0,
      ),
      retries: this.events.filter((e) => e.type === 'provider.retry').length,
      latency: percentiles(latencies),
      wallMs: Date.now() - this.startedAt,
    };
  }
}

/**
 * @param {number[]} sorted
 */
export function percentiles(sorted) {
  if (!sorted || sorted.length === 0) return { p50: 0, p95: 0, max: 0, n: 0 };
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], n: sorted.length };
}

function summarize(event) {
  switch (event.type) {
    case 'llm.step':
      return `  [${event.step}] llm ${event.latencyMs}ms tools=${event.toolCalls ?? 0}`;
    case 'tool.step':
      return `  [${event.step}] tool ${event.name} ${event.ok ? 'ok' : 'FAIL'} ${event.durationMs}ms`;
    case 'run.finish':
      return `  → ${event.outcome}`;
    default:
      return null;
  }
}
