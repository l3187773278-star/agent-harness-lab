import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createReplayFetch,
  createRecordingFetch,
  buildFixtureFromTurns,
  writeFixture,
  loadFixture,
  splitString,
} from '../src/recorder.js';

test('splitString：短串原样返回，长串按长度切分且内容无损', () => {
  assert.deepEqual(splitString('abc', 5), ['abc']);
  assert.deepEqual(splitString('abcdef', 2), ['ab', 'cd', 'ef']);
  assert.deepEqual(splitString('abcde', 2), ['ab', 'cd', 'e']);
  const joined = splitString('x'.repeat(1000), 7).join('');
  assert.equal(joined.length, 1000);
});

test('buildFixtureFromTurns：生成合规夹具结构', () => {
  const fixture = buildFixtureFromTurns(
    [{ content: 'hello', finishReason: 'stop', usage: { prompt_tokens: 1 } }],
    { splitEvery: 4 },
  );
  assert.equal(fixture.version, '1');
  assert.equal(fixture.entries.length, 1);
  assert.equal(fixture.entries[0].status, 200);
  assert.ok(fixture.entries[0].chunks.length > 1, '应被切成多片以模拟网络分片');
  assert.equal(fixture.entries[0].chunks.join('').includes('data: [DONE]'), true);
});

test('createReplayFetch：按顺序返回每一轮的响应', async () => {
  const fixture = buildFixtureFromTurns([
    { content: '第一轮', finishReason: 'stop' },
    { content: '第二轮', finishReason: 'stop' },
  ]);
  const f = createReplayFetch(fixture);

  const r1 = await f('https://x', { body: '{}' });
  const r2 = await f('https://x', { body: '{}' });
  assert.equal((await r1.text()).includes('第一轮'), true);
  assert.equal((await r2.text()).includes('第二轮'), true);
});

test('createReplayFetch：夹具用完后抛出可定位的错误，而不是返回空响应', async () => {
  const fixture = buildFixtureFromTurns([{ content: 'only', finishReason: 'stop' }]);
  const f = createReplayFetch(fixture);
  await f('https://x', { body: '{}' });
  await assert.rejects(() => f('https://x', { body: '{}' }), /夹具已用完/);
});

test('createReplayFetch：onRequest 能看到每次请求体', async () => {
  const fixture = buildFixtureFromTurns([{ content: 'x', finishReason: 'stop' }]);
  const seen = [];
  const f = createReplayFetch(fixture, { onRequest: (body, i) => seen.push({ body, i }) });
  await f('https://x', { body: JSON.stringify({ model: 'm', messages: [] }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.model, 'm');
  assert.equal(seen[0].i, 0);
});

test('createRecordingFetch：录制后生成的夹具可被回放，且内容一致', async () => {
  const raw = 'data: {"choices":[{"delta":{"content":"录制内容"},"index":0}]}\n\ndata: [DONE]\n\n';
  const realFetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (const piece of splitString(raw, 5)) c.enqueue(enc.encode(piece));
          c.close();
        },
      }),
      { status: 200 },
    );

  const recording = createRecordingFetch(realFetch, { note: 'demo' });
  const res = await recording('https://x', { body: JSON.stringify({ model: 'test-model' }) });

  // 包装后仍应能正常读取完整流
  assert.equal(await res.text(), raw);

  const fixture = recording.dump();
  assert.equal(fixture.entries.length, 1);
  assert.equal(fixture.entries[0].request.model, 'test-model');
  assert.equal(fixture.entries[0].name, 'demo#1');

  // 回放应还原同样的文本
  const replay = createReplayFetch(fixture);
  const back = await replay('https://x', { body: '{}' });
  assert.equal(await back.text(), raw);
});

test('createRecordingFetch：错误响应直接透传，不进夹具', async () => {
  const realFetch = async () => new Response('nope', { status: 400 });
  const recording = createRecordingFetch(realFetch);
  const res = await recording('https://x', { body: '{}' });
  assert.equal(res.status, 400);
  assert.equal(recording.dump().entries.length, 0);
});

test('writeFixture / loadFixture：往返一致，格式错误能被识别', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-fix-'));
  const file = path.join(dir, 'nested', 'f.json');
  const fixture = buildFixtureFromTurns([{ content: 'hi', finishReason: 'stop' }]);

  writeFixture(file, fixture);
  const loaded = loadFixture(file);
  assert.deepEqual(loaded.entries, fixture.entries);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"version":"1"}', 'utf8');
  assert.throws(() => loadFixture(bad), /entries/);
});
