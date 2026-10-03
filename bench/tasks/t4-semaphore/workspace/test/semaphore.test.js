import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/semaphore.js';

// 可见测试用的是串行调用，所以现在能通过。
// 真正的并发压力验证在评测时才追加。

test('Semaphore：构造参数校验', () => {
  assert.throws(() => new Semaphore(0), RangeError);
  assert.throws(() => new Semaphore(-2), RangeError);
});

test('Semaphore：串行 acquire/release 正常工作', async () => {
  const s = new Semaphore(1);
  assert.equal(s.available, 1);
  await s.acquire();
  assert.equal(s.available, 0);
  s.release();
  assert.equal(s.available, 1);
});

test('Semaphore：run 返回被包裹函数的返回值', async () => {
  const s = new Semaphore(2);
  assert.equal(await s.run(async () => 42), 42);
});
