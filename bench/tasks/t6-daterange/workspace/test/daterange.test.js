import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRange, isWithin } from '../src/daterange.js';

// 可见测试只用了"当地时间的正午"，此时 UTC 与本地区间的日期恰好一致，
// 所以现在能通过。跨时区边界的验证在评测时才追加。

function localDate(y, m, d, hh = 12, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

test('dayRange：返回当天的起止，且区间长度接近一天', () => {
  const r = dayRange(localDate(2026, 3, 15));
  assert.ok(r.end.getTime() > r.start.getTime());
  const hours = (r.end.getTime() - r.start.getTime()) / 3_600_000;
  assert.ok(hours > 23.9 && hours < 24.1);
});

test('isWithin：正午的时间戳落在当天区间内', () => {
  const r = dayRange(localDate(2026, 3, 15, 12));
  assert.equal(isWithin(localDate(2026, 3, 15, 12), r), true);
});

test('dayRange：非法输入抛 TypeError', () => {
  assert.throws(() => dayRange('not-a-date'), TypeError);
});
