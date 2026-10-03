import test from 'node:test';
import assert from 'node:assert/strict';
import { Provider, ProviderError, backoffDelay, toAsyncIterable } from '../src/provider.js';
import { buildFixtureFromTurns, createReplayFetch } from '../src/recorder.js';

const enc = new TextEncoder();

/** 造一个只返回一次的假 fetch。 */
function stubFetch(handler) {
  return async (url, init) => handler(url, init);
}

function sseResponse(chunks, status = 200) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const done = 'data: [DONE]\n\n';

function makeProvider(overrides = {}) {
  return new Provider({
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    sleepImpl: async () => {},
    ...overrides,
  });
}

test('buildBody：流式请求带 stream 与 stream_options.include_usage，模型名来自配置', () => {
  const p = makeProvider();
  const body = p.buildBody([{ role: 'user', content: 'hi' }]);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.temperature, 0);
  assert.equal(body.tools, undefined, '没给工具时不应带 tools 字段');
});

test('buildBody：给了工具才带 tools 并把 tool_choice 设为 auto', () => {
  const p = makeProvider();
  const body = p.buildBody([], { tools: [{ type: 'function', function: { name: 'x' } }] });
  assert.equal(body.tools.length, 1);
  assert.equal(body.tool_choice, 'auto');
});

test('chat：请求地址、鉴权头、body 内容正确', async () => {
  let captured = null;
  const p = makeProvider({
    fetchImpl: stubFetch((url, init) => {
      captured = { url, init };
      return sseResponse([sse({ choices: [{ delta: { content: 'ok' }, index: 0 }] }), done]);
    }),
  });

  const res = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
  const sent = JSON.parse(String(captured.init.body));
  assert.equal(sent.model, 'test-model');
  assert.equal(res.content, 'ok');
});

test('chat：真实响应经协议层聚合成内容与工具调用', async () => {
  const fixture = buildFixtureFromTurns([
    {
      content: '先读文件。',
      toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    },
  ]);
  const p = makeProvider({ fetchImpl: createReplayFetch(fixture) });
  const res = await p.chat([{ role: 'user', content: 'x' }]);

  assert.equal(res.content, '先读文件。');
  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.toolCalls.length, 1);
  assert.deepEqual(res.toolCalls[0].args, { path: 'a.js' });
  assert.equal(res.usage.prompt_tokens, 12);
});

test('chat：429 限流会重试，第二次成功', async () => {
  let n = 0;
  const delays = [];
  const p = makeProvider({
    sleepImpl: async (ms) => delays.push(ms),
    fetchImpl: stubFetch(() => {
      n += 1;
      if (n === 1) return new Response('rate limited', { status: 429 });
      return sseResponse([sse({ choices: [{ delta: { content: '终于成功' }, index: 0 }] }), done]);
    }),
  });

  const res = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(res.content, '终于成功');
  assert.equal(n, 2);
  assert.equal(delays.length, 1, '应恰好退避一次');
});

test('chat：503 也重试，且重试次数到上限后抛出 ProviderError', async () => {
  let n = 0;
  const p = makeProvider({
    maxRetries: 2,
    fetchImpl: stubFetch(() => {
      n += 1;
      return new Response('bad gateway', { status: 503 });
    }),
  });

  await assert.rejects(
    () => p.chat([{ role: 'user', content: 'hi' }]),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(n, 3, 'maxRetries=2 时应共请求 3 次（首次 + 2 次重试）');
});

test('chat：400 属于请求本身的错，不重试', async () => {
  let n = 0;
  const p = makeProvider({
    fetchImpl: stubFetch(() => {
      n += 1;
      return new Response('{"error":{"message":"invalid tool schema"}}', { status: 400 });
    }),
  });

  await assert.rejects(() => p.chat([]), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    assert.match(err.message, /invalid tool schema/);
    return true;
  });
  assert.equal(n, 1, '400 不应重试');
});

test('chat：网络异常属于可重试，最终失败时报网络异常', async () => {
  let n = 0;
  const p = makeProvider({
    maxRetries: 1,
    fetchImpl: stubFetch(() => {
      n += 1;
      throw new TypeError('fetch failed');
    }),
  });

  await assert.rejects(() => p.chat([]), /网络异常/);
  assert.equal(n, 2);
});

test('chat：超时以 AbortSignal 生效并归类为可重试', async () => {
  const p = makeProvider({
    timeoutMs: 20,
    maxRetries: 0,
    fetchImpl: stubFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }),
  });

  await assert.rejects(() => p.chat([]), /超时|取消/);
});

test('chat：onRetry 回调收到尝试次数、退避时长与原因', async () => {
  let n = 0;
  const seen = [];
  const p = makeProvider({
    sleepImpl: async () => {},
    onRetry: (info) => seen.push(info),
    fetchImpl: stubFetch(() => {
      n += 1;
      return n === 1 ? new Response('busy', { status: 429 }) : sseResponse([done]);
    }),
  });

  await p.chat([]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].attempt, 1);
  assert.ok(seen[0].delayMs >= 0);
  assert.match(seen[0].reason, /429/);
});

test('chat：返回的 requestBody 可用于排查与录制', async () => {
  const p = makeProvider({
    fetchImpl: stubFetch(() => sseResponse([done])),
  });
  const res = await p.chat([{ role: 'user', content: 'hi' }], { maxTokens: 64 });
  assert.equal(res.requestBody.model, 'test-model');
  assert.equal(res.requestBody.max_tokens, 64);
});

test('requestCount 统计实际发出的请求数（含重试）', async () => {
  let n = 0;
  const p = makeProvider({
    sleepImpl: async () => {},
    fetchImpl: stubFetch(() => {
      n += 1;
      return n < 3 ? new Response('x', { status: 500 }) : sseResponse([done]);
    }),
  });
  await p.chat([]);
  assert.equal(p.requestCount, 3);
});

test('backoffDelay：随尝试次数指数增长且不超过上限，带抖动', () => {
  // 抖动是随机的，所以断言要用宽松区间或不依赖抖动的性质，避免偶发失败
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = 100 * 2 ** attempt;
    const d = backoffDelay(attempt, 100, 10_000);
    assert.ok(d >= base * 0.75, `第 ${attempt + 1} 次退避 ${d} 不应低于下界 ${base * 0.75}`);
    assert.ok(d <= base * 1.25, `第 ${attempt + 1} 次退避 ${d} 不应高于上界 ${base * 1.25}`);
  }

  // 上限截断：无论重试多少次都不会超过 cap 的 1.25 倍
  for (let i = 0; i < 50; i++) {
    assert.ok(backoffDelay(20, 100, 10_000) <= 12_500, '应被上限截断');
  }

  // 单调性用期望值判断，避开抖动：大 attempt 的期望退避一定不小于小 attempt
  assert.ok(backoffDelay(3, 100, 10_000) > backoffDelay(1, 100, 10_000));
});

test('toAsyncIterable：既支持 ReadableStream 也支持异步可迭代对象', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('a'));
      c.enqueue(enc.encode('b'));
      c.close();
    },
  });
  let out = '';
  for await (const s of toAsyncIterable(stream)) out += s;
  assert.equal(out, 'ab');

  async function* gen() {
    yield 'x';
    yield 'y';
  }
  let out2 = '';
  for await (const s of toAsyncIterable(gen())) out2 += s;
  assert.equal(out2, 'xy');
});

test('Provider：缺少 baseURL 直接报错，避免出现 undefined/chat/completions', () => {
  assert.throws(() => new Provider({ apiKey: 'k', model: 'm' }), /baseURL/);
});
