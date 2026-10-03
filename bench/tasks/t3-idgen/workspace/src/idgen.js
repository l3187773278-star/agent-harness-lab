/**
 * 短 ID 生成器。
 *
 * 已知问题（评测任务 T3 的目标）：
 * nextId() 只用"当前毫秒时间戳的低位"拼前缀，没有毫秒内计数器，
 * 因此同一毫秒内连续调用会生成**完全相同**的 ID。
 */

const lastTime = { value: 0 };

/** 把数字转成定长 36 进制片段。 */
function toBase36(value) {
  return Math.floor(value).toString(36).padStart(4, '0');
}

/**
 * 生成一个短 ID。
 *
 * 契约：
 *   - 同一进程内连续调用**绝不重复**
 *   - 同一毫秒内连续调用也要不同
 *   - 返回值只含 [0-9a-z-]
 *
 * @returns {string}
 */
export function nextId() {
  const now = Date.now();
  lastTime.value = now;
  return `id-${toBase36(now % 1_000_000)}`;
}

/** 当前内部记录的时间戳，供调试用。 */
export function lastTimestamp() {
  return lastTime.value;
}
