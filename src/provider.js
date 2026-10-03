/**
 * Provider 层：只负责"把 messages 发给模型，把响应拿回来"。
 *
 * 边界纪律（整个项目的依赖是单向的，不许反向 import）：
 *   本文件不认识 loop.js、不认识 tools.js。
 *   它只做协议、重试、超时、录制/回放。
 *
 * 重试策略的选择理由见 docs/adr/0002-为什么重试放在协议层.md
 */
import { accumulateStream } from './sse.js';

/** 可重试的 HTTP 状态码：限流与 5xx 属于暂时性故障，重试有意义；4xx 其余是请求本身的错，重试只会重复犯错。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean, body?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = meta.status;
    this.retryable = Boolean(meta.retryable);
    this.body = meta.body;
    if (meta.cause) this.cause = meta.cause;
  }
}

/** 指数退避 + 抖动。抖动是为了避免多个任务同时重试造成再次撞限流。 */
export function backoffDelay(attempt, baseMs = 500, capMs = 15_000) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAbortError(err) {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export class Provider {
  /**
   * @param {{
   *   baseURL: string, apiKey: string, model: string,
   *   timeoutMs?: number, maxRetries?: number, temperature?: number,
   *   fetchImpl?: typeof fetch,
   *   onRetry?: (info: { attempt: number, delayMs: number, reason: string }) => void,
   *   sleepImpl?: (ms: number) => Promise<void>,
   * }} config
   */
  constructor(config) {
    if (!config || !config.baseURL) throw new ProviderError('Provider 需要 baseURL');
    this.baseURL = String(config.baseURL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.temperature = config.temperature ?? 0;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.onRetry = config.onRetry;
    this.sleepImpl = config.sleepImpl || sleep;
    this.requestCount = 0;
  }

  get endpoint() {
    return `${this.baseURL}/chat/completions`;
  }

  /**
   * 构造请求体。抽出来单独存在，是为了让录制/回放能按"请求指纹"匹配。
   * @param {Array<any>} messages
   * @param {{ tools?: Array<any>, temperature?: number, stream?: boolean, maxTokens?: number, effort?: string }} [opts]
   */
  buildBody(messages, opts = {}) {
    /** @type {Record<string, unknown>} */
    const body = {
      model: this.model,
      messages,
      stream: opts.stream !== false,
      temperature: opts.temperature ?? this.temperature,
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    // 推理强度档位（如 deepseek-v4-pro 支持 low/high/max）。
    // 只在显式指定时发送 —— 不发空值，避免老接口不认识这个字段而 400。
    if (opts.effort) body.reasoning_effort = opts.effort;
    if (body.stream) body.stream_options = { include_usage: true };
    return body;
  }

  /**
   * 发一次请求，流式聚合结果。含重试。
   * @param {Array<any>} messages
   * @param {{ tools?: Array<any>, temperature?: number, maxTokens?: number, effort?: string, onDelta?: Function, signal?: AbortSignal }} [opts]
   */
  async chat(messages, opts = {}) {
    const body = this.buildBody(messages, opts);
    let lastErr = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.#attempt(body, opts);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof ProviderError ? err.retryable : isAbortError(err);
        if (!retryable || attempt === this.maxRetries) break;

        const delayMs = backoffDelay(attempt);
        if (this.onRetry) {
          this.onRetry({
            attempt: attempt + 1,
            delayMs,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        await this.sleepImpl(delayMs);
      }
    }
    throw lastErr;
  }

  /**
   * 单次尝试。
   * @param {Record<string, unknown>} body
   * @param {{ onDelta?: Function, signal?: AbortSignal }} opts
   */
  async #attempt(body, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (opts.signal) opts.signal.addEventListener('abort', onOuterAbort, { once: true });

    this.requestCount += 1;

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await safeText(res);
        throw new ProviderError(`HTTP ${res.status}：${truncate(text, 400) || res.statusText}`, {
          status: res.status,
          retryable: RETRYABLE_STATUS.has(res.status),
          body: text,
        });
      }
      if (!res.body) {
        throw new ProviderError('响应没有 body（服务端未返回流）', { retryable: true });
      }

      const result = await accumulateStream(toAsyncIterable(res.body), { onDelta: opts.onDelta });
      return { ...result, requestBody: body };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (isAbortError(err)) {
        throw new ProviderError(`请求超时（${this.timeoutMs}ms）或被取消`, {
          retryable: true,
          cause: err,
        });
      }
      // 网络层异常（DNS、断连）通常值得重试
      throw new ProviderError(`网络异常：${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** 把 fetch 的 ReadableStream 转成异步可迭代的字符串片段。 */
export async function* toAsyncIterable(stream) {
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const item of stream) {
      yield typeof item === 'string' ? item : new TextDecoder().decode(item);
    }
    return;
  }
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield typeof value === 'string' ? value : new TextDecoder().decode(value);
    }
  } finally {
    if (typeof reader.releaseLock === 'function') reader.releaseLock();
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
