/**
 * 日期区间工具。
 *
 * 已知问题（评测任务 T6 的目标）：
 * dayRange() 用 toISOString() 取日期部分。toISOString 返回的是 **UTC** 时间，
 * 在非 UTC 时区（例如 UTC+8）下，当地时间的凌晨/深夜会被算到相邻的一天，
 * 导致区间错位。
 */

/** 返回某个时间戳"当天"的起止时间。 */
export function dayRange(date) {
  const d = date === undefined ? new Date() : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('无效的日期');

  // 取 ISO 字符串的日期部分再解析成当天 00:00:00
  const dayText = d.toISOString().slice(0, 10);
  const start = new Date(`${dayText}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/** 判断某个时间戳是否落在给定区间的闭区间内。 */
export function isWithin(ts, range) {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) throw new TypeError('无效的时间戳');
  return t >= range.start.getTime() && t <= range.end.getTime();
}

/**
 * 把区间格式化成 YYYY-MM-DD。
 * @param {{start: Date, end: Date}} range
 */
export function formatRange(range) {
  return `${range.start.toISOString().slice(0, 10)} ~ ${range.end.toISOString().slice(0, 10)}`;
}
