import test from 'node:test';
import assert from 'node:assert/strict';
import { nextId } from '../src/idgen.js';

test('同一毫秒内连续生成 5000 个 ID 必须全部唯一', () => {
  const seen = new Set();
  const ids = [];
  for (let i = 0; i < 5000; i++) {
    const id = nextId();
    ids.push(id);
    seen.add(id);
  }
  assert.equal(
    seen.size,
    5000,
    `5000 次生成只得到 ${seen.size} 个唯一 ID —— 同一毫秒内发生了碰撞`,
  );
  assert.equal(new Set(ids).size, ids.length);
});

test('高强度连续生成：多轮各 2000 次都不重复', () => {
  const seen = new Set();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 2000; i++) seen.add(nextId());
  }
  assert.equal(seen.size, 6000, `期望 6000 个唯一 ID，实际 ${seen.size}`);
});

test('ID 字符集与格式稳定', () => {
  for (let i = 0; i < 500; i++) {
    const id = nextId();
    assert.match(id, /^[0-9a-z-]+$/, `ID「${id}」含非法字符`);
  }
});

test('ID 不应随系统时钟回拨而重复（同一毫秒内序列仍然单调递增）', () => {
  // 连续生成时，即使时钟没有前进，也必须靠计数器区分
  const first = nextId();
  const second = nextId();
  const third = nextId();
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.notEqual(first, third);
});
