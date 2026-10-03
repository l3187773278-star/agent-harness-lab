import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/text.js';

// 这份可见测试只覆盖了最基本的情况，所以现在能跑过。
// 完整的边界验证在评测时才追加进来 —— 请按 src/text.js 里的契约实现。

test('truncate：短字符串原样返回', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abc', 3), 'abc');
});

test('truncate：超长字符串会被截断并带省略号', () => {
  const out = truncate('abcdefghijklmnop', 5);
  assert.ok(out.length < 'abcdefghijklmnop'.length, '应该真的截断了');
  assert.ok(out.includes('…'), '截断后应带省略号');
});
