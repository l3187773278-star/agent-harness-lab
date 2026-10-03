import test from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, ToolCallAccumulator, accumulateStream } from '../src/sse.js';
import { splitString } from '../src/recorder.js';

/** 用异步生成器把字符串片段喂给 accumulateStream。 */
async function* feed(chunks) {
  for (const c of chunks) yield c;
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('SseParser：单个完整事件', () => {
  const p = new SseParser();
  const events = p.push('data: {"a":1}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"a":1}');
});

test('SseParser：事件被切成任意大小的片段仍能解析', () => {
  const raw = 'data: {"hello":"world"}\n\ndata: [DONE]\n\n';
  for (const size of [1, 2, 3, 5, 7, 13]) {
    const p = new SseParser();
    const collected = splitString(raw, size).flatMap((c) => p.push(c)).concat(p.flush());
    assert.equal(collected.length, 2, `切分长度 ${size} 时事件数不对`);
    assert.equal(collected[0].data, '{"hello":"world"}');
    assert.equal(collected[1].data, '[DONE]');
  }
});

test('SseParser：CRLF 换行与 data: 后空格可选', () => {
  const p = new SseParser();
  const events = p.push('data:{"x":1}\r\n\r\ndata: {"y":2}\r\n\r\n');
  assert.deepEqual(
    events.map((e) => e.data),
    ['{"x":1}', '{"y":2}'],
  );
});

test('SseParser：注释行与心跳被忽略，不影响事件边界', () => {
  const p = new SseParser();
  const events = p.push(': keep-alive\n\ndata: {"z":3}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"z":3}');
});

test('SseParser：多行 data 按协议用换行拼接', () => {
  const p = new SseParser();
  const events = p.push('data: line1\ndata: line2\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'line1\nline2');
});

test('SseParser：缺最后那个空行时，flush 仍能吐出字段完整的事件', () => {
  const p = new SseParser();
  // 有换行符收尾、但没有结尾空行 —— 部分服务端就是这样结束流的
  assert.equal(p.push('data: {"tail":true}\n').length, 0);
  const rest = p.flush();
  assert.equal(rest.length, 1);
  assert.equal(rest[0].data, '{"tail":true}');
});

test('SseParser：流被截断（尾部没有换行符）时丢弃残缺数据，不伪装成完整事件', () => {
  const p = new SseParser();
  const complete = p.push('data: {"complete":1}\n\ndata: {"trunc');
  assert.equal(complete.length, 1, '前面那个完整事件应正常吐出');
  assert.equal(complete[0].data, '{"complete":1}');

  const rest = p.flush();
  assert.equal(rest.length, 0, '被截断的半截 JSON 必须丢掉');
  assert.equal(p.buffer, '');
  assert.equal(p.dataLines.length, 0);
  assert.equal(p.truncated, true, '应标记为发生了截断，供上层判断响应不完整');
});

test('ToolCallAccumulator：单个工具调用的参数分片按顺序拼接', () => {
  const acc = new ToolCallAccumulator();
  acc.absorb({ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '' } });
  acc.absorb({ index: 0, function: { arguments: '{"pa' } });
  acc.absorb({ index: 0, function: { arguments: 'th":"a' } });
  acc.absorb({ index: 0, function: { arguments: '.js"}' } });
  const out = acc.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'read_file');
  assert.deepEqual(out[0].args, { path: 'a.js' });
  assert.equal(out[0].invalid, false);
});

test('ToolCallAccumulator：多个工具调用的分片交错到达，各自归并到正确的桶', () => {
  const acc = new ToolCallAccumulator();
  // 真实协议里两个调用的分片会交错，必须按 index 分桶而不是按到达顺序
  acc.absorb({ index: 0, id: 'c0', function: { name: 'read_file', arguments: '' } });
  acc.absorb({ index: 1, id: 'c1', function: { name: 'run_test', arguments: '' } });
  acc.absorb({ index: 0, function: { arguments: '{"path":"src/' } });
  acc.absorb({ index: 1, function: { arguments: '{"name":"au' } });
  acc.absorb({ index: 0, function: { arguments: 'auth/login.js"}' } });
  acc.absorb({ index: 1, function: { arguments: 'th"}' } });

  const out = acc.finalize();
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'read_file');
  assert.deepEqual(out[0].args, { path: 'src/auth/login.js' });
  assert.equal(out[1].name, 'run_test');
  assert.deepEqual(out[1].args, { name: 'auth' });
});

test('ToolCallAccumulator：乱序到达（先 index 1 再 index 0）输出仍按 index 升序', () => {
  const acc = new ToolCallAccumulator();
  acc.absorb({ index: 1, id: 'b', function: { name: 'second', arguments: '{"n":2}' } });
  acc.absorb({ index: 0, id: 'a', function: { name: 'first', arguments: '{"n":1}' } });
  const out = acc.finalize();
  assert.deepEqual(
    out.map((t) => t.name),
    ['first', 'second'],
  );
});

test('ToolCallAccumulator：参数为空串视为无参调用，不算坏 JSON', () => {
  const acc = new ToolCallAccumulator();
  acc.absorb({ index: 0, id: 'x', function: { name: 'list_files', arguments: '' } });
  const out = acc.finalize();
  assert.equal(out[0].invalid, false);
  assert.deepEqual(out[0].args, {});
});

test('ToolCallAccumulator：被截断的半截 JSON 标记为 invalid 而不是抛错', () => {
  const acc = new ToolCallAccumulator();
  acc.absorb({ index: 0, id: 'x', function: { name: 'edit_file', arguments: '{"path":"a.js","con' } });
  const out = acc.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].invalid, true);
  assert.equal(out[0].args, null);
  assert.match(out[0].error, /JSON/);
});

test('ToolCallAccumulator：缺少 index 时容错归入 0 桶', () => {
  const acc = new ToolCallAccumulator();
  acc.absorb({ id: 'noidx', function: { name: 'ping', arguments: '{}' } });
  const out = acc.finalize();
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'ping');
});

test('accumulateStream：完整一轮（思考 + 正文 + 两个工具调用）', async () => {
  const chunks = [
    sse({ choices: [{ delta: { reasoning_content: '先看代码。' }, index: 0 }] }),
    sse({ choices: [{ delta: { content: '我来读文件。' }, index: 0 }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'read_file', arguments: '' } }] }, index: 0 }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.js"}' } }] }, index: 0 }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'run_test', arguments: '{"name":"auth"}' } }] }, index: 0 }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }),
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ];

  const res = await accumulateStream(feed(chunks));
  assert.equal(res.reasoning, '先看代码。');
  assert.equal(res.content, '我来读文件。');
  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.toolCalls.length, 2);
  assert.deepEqual(res.toolCalls[0].args, { path: 'a.js' });
  assert.deepEqual(res.toolCalls[1].args, { name: 'auth' });
  assert.equal(res.usage.prompt_tokens, 10);
  assert.equal(res.invalidToolCalls.length, 0);
});

test('accumulateStream：[DONE] 之后的内容不再被处理', async () => {
  const chunks = [
    sse({ choices: [{ delta: { content: '有效' }, index: 0 }] }),
    'data: [DONE]\n\n',
    sse({ choices: [{ delta: { content: '不该出现' }, index: 0 }] }),
  ];
  const res = await accumulateStream(feed(chunks));
  assert.equal(res.content, '有效');
});

test('accumulateStream：逐个字符喂入也不丢内容（最极端的切分）', async () => {
  const raw =
    sse({ choices: [{ delta: { content: '你好' }, index: 0 }] }) +
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"k":"v"}' } }] }, index: 0 }] }) +
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }) +
    'data: [DONE]\n\n';

  const res = await accumulateStream(feed(splitString(raw, 1)));
  assert.equal(res.content, '你好');
  assert.equal(res.toolCalls.length, 1);
  assert.deepEqual(res.toolCalls[0].args, { k: 'v' });
});

test('accumulateStream：坏 JSON 的调用被隔离到 invalidToolCalls，好调用不受影响', async () => {
  const chunks = [
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'good', function: { name: 'ok_tool', arguments: '{"a":1}' } },
              { index: 1, id: 'bad', function: { name: 'bad_tool', arguments: '{"a":' } },
            ],
          },
          index: 0,
        },
      ],
    }),
    sse({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }),
    'data: [DONE]\n\n',
  ];
  const res = await accumulateStream(feed(chunks));
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'ok_tool');
  assert.equal(res.invalidToolCalls.length, 1);
  assert.equal(res.invalidToolCalls[0].name, 'bad_tool');
});

test('accumulateStream：带 error 字段的事件会抛出可读错误', async () => {
  const chunks = [sse({ error: { message: '余额不足' } })];
  await assert.rejects(() => accumulateStream(feed(chunks)), /余额不足/);
});

test('accumulateStream：非 JSON 的 data 行被跳过而不是中断整条流', async () => {
  const chunks = ['data: not-json-at-all\n\n', sse({ choices: [{ delta: { content: '继续' }, index: 0 }] }), 'data: [DONE]\n\n'];
  const res = await accumulateStream(feed(chunks));
  assert.equal(res.content, '继续');
});

test('accumulateStream：onDelta 回调按类型收到增量', async () => {
  const seen = [];
  const chunks = [
    sse({ choices: [{ delta: { reasoning_content: 'R' }, index: 0 }] }),
    sse({ choices: [{ delta: { content: 'C' }, index: 0 }] }),
    'data: [DONE]\n\n',
  ];
  await accumulateStream(feed(chunks), { onDelta: (ev) => seen.push(ev.type) });
  assert.deepEqual(seen, ['reasoning', 'content']);
});
