import test from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/lru.js';

test('get 命中必须刷新使用顺序：被读过的键不能被淘汰', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1); // a 变成最近使用
  c.set('c', 3); // 应淘汰 b，而不是 a

  assert.equal(c.has('a'), true, 'a 刚被读取过，不该被淘汰');
  assert.equal(c.has('b'), false, 'b 才是最久未使用的，应被淘汰');
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
});

test('keys() 顺序反映使用顺序（最久未使用在前）', () => {
  const c = new LruCache(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.deepEqual(c.keys(), ['a', 'b', 'c']);

  c.get('a');
  assert.deepEqual(c.keys(), ['b', 'c', 'a'], 'a 被读取后应排到最后');
});

test('重复 set 同一个键也会刷新顺序', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10); // 刷新 a
  c.set('c', 3); // 应淘汰 b
  assert.equal(c.has('a'), true);
  assert.equal(c.get('a'), 10);
  assert.equal(c.has('b'), false);
});

test('连续读取：每次 get 都刷新顺序，最久未使用的那个被淘汰', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  // 最后一次读到的是 b，所以 a 是最久未使用
  for (let i = 0; i < 5; i++) {
    c.get('a');
    c.get('b');
  }
  c.set('c', 3);
  assert.equal(c.has('b'), true, 'b 是最后被读取的，应保留');
  assert.equal(c.has('a'), false, 'a 才是最久未使用的，应被淘汰');
});

test('命中/未命中统计正确', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.get('a');
  c.get('a');
  c.get('x');
  assert.equal(c.hits, 2);
  assert.equal(c.misses, 1);
});

test('容量为 1 的边界：只保留最近使用的键', () => {
  const c = new LruCache(1);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
  assert.equal(c.get('b'), 2);
  c.set('c', 3);
  assert.equal(c.has('b'), false, 'b 未被再次读取，应被淘汰');
  assert.equal(c.has('c'), true);
});

test('clear 之后可以继续正常使用', () => {
  const c = new LruCache(2);
  c.set('a', 1);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get('a'), undefined);
  c.set('b', 2);
  assert.equal(c.get('b'), 2);
});
