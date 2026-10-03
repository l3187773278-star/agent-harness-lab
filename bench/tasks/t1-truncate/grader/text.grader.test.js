import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate, pad } from '../src/text.js';

test('truncate：返回值长度永远不超过上限', () => {
  for (const maxLength of [0, 1, 2, 3, 5, 10]) {
    for (const text of ['', 'a', 'abcdefghijklmnop', '中文测试字符串', '🙂🙂🙂🙂🙂']) {
      const out = truncate(text, maxLength);
      assert.ok(
        out.length <= maxLength,
        `truncate(${JSON.stringify(text)}, ${maxLength}) 返回长度 ${out.length}，超过上限`,
      );
    }
  }
});

test('truncate：没发生截断时不加省略号', () => {
  assert.equal(truncate('abc', 3), 'abc', '正好等于上限不该截断');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(truncate('', 0), '');
});

test('truncate：发生截断时省略号计入上限', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(truncate('中文测试字符串', 3), '中文…');
});

test('truncate：上限很小时退化为纯截断，不硬塞省略号', () => {
  assert.equal(truncate('abcdef', 0), '');
  assert.equal(truncate('abcdef', 1), 'a');
});

test('truncate：支持自定义省略号，且同样计入上限', () => {
  assert.equal(truncate('abcdefghij', 6, '...'), 'abc...');
  assert.equal(truncate('abcdefghij', 3, '...'), 'abc', '省略号比上限还长时应退化为纯截断');
});

test('truncate：非法上限抛 RangeError', () => {
  assert.throws(() => truncate('abc', -1), RangeError);
  assert.throws(() => truncate('abc', 1.5), RangeError);
});

test('pad：补齐与超长返回', () => {
  assert.equal(pad('ab', 5), 'ab   ');
  assert.equal(pad('abcdef', 3), 'abcdef');
  assert.equal(pad('ab', 4, '0'), 'ab00');
});
