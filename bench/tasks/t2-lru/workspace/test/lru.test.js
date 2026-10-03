import test from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/lru.js';

// 可见测试只验证了基本存取与"写入也刷新顺序"。
// 完整的淘汰顺序验证在评测时才追加。

test('LruCache：写入与读取基本可用', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('nope'), undefined);
});

test('LruCache：超出容量会淘汰最旧的键', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.has('c'), true);
});

test('LruCache：容量参数校验', () => {
  assert.throws(() => new LruCache(0), RangeError);
  assert.throws(() => new LruCache(-1), RangeError);
});
