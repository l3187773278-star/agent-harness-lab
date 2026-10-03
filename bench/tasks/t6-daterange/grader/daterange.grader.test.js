import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRange, isWithin, formatRange } from '../src/daterange.js';

/** 用本地时区构造时间，避免测试本身依赖运行环境的时区。 */
function localDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

test('dayRange：起点是当地 00:00:00.000，终点是当地 23:59:59.999', () => {
  const r = dayRange(localDate(2026, 3, 15, 12));
  assert.equal(r.start.getFullYear(), 2026);
  assert.equal(r.start.getMonth(), 2);
  assert.equal(r.start.getDate(), 15, '区间起点必须落在当地 3 月 15 日');
  assert.equal(r.start.getHours(), 0);
  assert.equal(r.start.getMinutes(), 0);
  assert.equal(r.start.getSeconds(), 0);
  assert.equal(r.start.getMilliseconds(), 0);

  assert.equal(r.end.getDate(), 15, '区间终点也必须落在当地 3 月 15 日');
  assert.equal(r.end.getHours(), 23);
  assert.equal(r.end.getMinutes(), 59);
  assert.equal(r.end.getSeconds(), 59);
  assert.equal(r.end.getMilliseconds(), 999);
});

test('dayRange：当地凌晨与深夜的时间戳都必须算在当天', () => {
  const r = dayRange(localDate(2026, 3, 15, 12));

  assert.equal(isWithin(localDate(2026, 3, 15, 0, 0, 0, 0), r), true, '当天 00:00 必须在区间内');
  assert.equal(isWithin(localDate(2026, 3, 15, 0, 30), r), true, '当天凌晨必须在区间内');
  assert.equal(isWithin(localDate(2026, 3, 15, 23, 30), r), true, '当天深夜必须在区间内');
  assert.equal(isWithin(localDate(2026, 3, 15, 23, 59, 59, 999), r), true, '当天最后一毫秒必须在区间内');
});

test('dayRange：相邻日期的时刻必须被排除（时区错位会在这里暴露）', () => {
  const r = dayRange(localDate(2026, 3, 15, 12));

  assert.equal(isWithin(localDate(2026, 3, 14, 23, 59, 59, 999), r), false, '前一天最后一毫秒不该在区间内');
  assert.equal(isWithin(localDate(2026, 3, 16, 0, 0, 0, 0), r), false, '第二天第一毫秒不该在区间内');
  assert.equal(isWithin(localDate(2026, 3, 14, 12), r), false);
  assert.equal(isWithin(localDate(2026, 3, 16, 12), r), false);
});

test('dayRange：跨月与跨年的边界', () => {
  const endOfMonth = dayRange(localDate(2026, 1, 31, 12));
  assert.equal(endOfMonth.start.getMonth(), 0);
  assert.equal(endOfMonth.start.getDate(), 31);
  assert.equal(endOfMonth.end.getDate(), 31);
  assert.equal(isWithin(localDate(2026, 2, 1, 0, 0, 0, 0), endOfMonth), false, '2 月 1 日不该在 1 月 31 日的区间内');

  const endOfYear = dayRange(localDate(2026, 12, 31, 12));
  assert.equal(endOfYear.start.getFullYear(), 2026);
  assert.equal(endOfYear.end.getFullYear(), 2026);
  assert.equal(isWithin(localDate(2027, 1, 1, 0, 0, 0, 0), endOfYear), false);
});

test('dayRange：区间长度为 24 小时减 1 毫秒', () => {
  const r = dayRange(localDate(2026, 6, 10, 12));
  assert.equal(r.end.getTime() - r.start.getTime(), 24 * 60 * 60 * 1000 - 1);
});

test('formatRange：按当地日期格式化，不因时区偏移串到相邻日', () => {
  const r = dayRange(localDate(2026, 3, 15, 12));
  assert.equal(formatRange(r), '2026-03-15 ~ 2026-03-15');
});

test('isWithin：非法时间戳抛 TypeError', () => {
  const r = dayRange(localDate(2026, 3, 15, 12));
  assert.throws(() => isWithin('not-a-date', r), TypeError);
});
