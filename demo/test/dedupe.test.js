import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeBy, dedupeByField } from '../src/dedupe.js';

test('dedupeBy：保留首次出现的元素', () => {
  const out = dedupeBy([{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 1, v: 'c' }], (x) => x.id);
  assert.deepEqual(out, [
    { id: 1, v: 'a' },
    { id: 2, v: 'b' },
  ]);
});

test('dedupeBy：保持原有顺序', () => {
  const out = dedupeBy([3, 1, 3, 2, 1], (x) => x);
  assert.deepEqual(out, [3, 1, 2]);
});

test('dedupeBy：空数组与全重复数组', () => {
  assert.deepEqual(dedupeBy([], (x) => x), []);
  assert.deepEqual(dedupeBy([1, 1, 1], (x) => x), [1]);
});

test('dedupeBy：键为 undefined/null 时也按值去重', () => {
  const out = dedupeBy([{ k: null }, { k: null }, { k: 0 }], (x) => x.k);
  assert.equal(out.length, 2);
  assert.equal(out[0].k, null);
  assert.equal(out[1].k, 0);
});

test('dedupeBy：不修改入参数组', () => {
  const input = [1, 1, 2];
  dedupeBy(input, (x) => x);
  assert.deepEqual(input, [1, 1, 2]);
});

test('dedupeBy：参数类型错误时抛 TypeError', () => {
  assert.throws(() => dedupeBy('not-array', (x) => x), TypeError);
  assert.throws(() => dedupeBy([1], 'not-fn'), TypeError);
});

test('dedupeByField：按字段名去重', () => {
  const out = dedupeByField([{ id: 'a' }, { id: 'b' }, { id: 'a' }], 'id');
  assert.deepEqual(out, [{ id: 'a' }, { id: 'b' }]);
});

test('dedupeBy：一万条数据下的键函数调用次数应在 O(n) 量级（复杂度回归保护）', () => {
  const items = Array.from({ length: 10_000 }, (_, i) => ({ id: i % 1000, n: i }));

  let keyCalls = 0;
  const out = dedupeBy(items, (x) => {
    keyCalls += 1;
    return x.id;
  });

  assert.equal(out.length, 1000);

  // 用"键函数被调用多少次"来判断复杂度，而不是用耗时。
  // 理由：计时会随机器性能波动，且一万条数据下 O(n^2) 也只要几十毫秒，
  // 计时断言既不稳定又抓不住问题；调用次数是确定性的。
  //
  //   两层循环实现：每处理一条都要拿已有结果逐个比对 → 约 50 万次
  //   Map/Set 实现：每条只算一次键 → 1 万次
  assert.ok(
    keyCalls < 50_000,
    `keyOf 被调用了 ${keyCalls} 次，远超 O(n) 量级（预期约 10000 次），去重算法仍是两层循环`,
  );
});
