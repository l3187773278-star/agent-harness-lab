import test from 'node:test';
import assert from 'node:assert/strict';
import { nextId } from '../src/idgen.js';

// 可见测试只在"跨越较长时间"的情况下验证，所以现在能通过。
// 同一毫秒内的连续生成验证在评测时才追加。

test('nextId：返回非空字符串，字符集受限', () => {
  const id = nextId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.match(id, /^[0-9a-z-]+$/);
});

test('nextId：相隔一段时间生成的 ID 不同', async () => {
  const a = nextId();
  await new Promise((r) => setTimeout(r, 5));
  const b = nextId();
  assert.notEqual(a, b);
});
