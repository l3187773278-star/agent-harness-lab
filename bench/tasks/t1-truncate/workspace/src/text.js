/**
 * 文本工具集。
 *
 * 已知问题（评测任务 T1 的目标）：
 * truncate 在补省略号时没有给省略号留出位置，导致返回结果比 maxLength 长，
 * 且边界处（正好等于上限、比上限长 1）的语义与契约不符。
 */

/**
 * 把字符串截断到最多 maxLength 个字符。
 *
 * 契约：
 *   - 返回值长度**永远不超过** maxLength
 *   - 只有在真的发生了截断时才补省略号（调用方可自定义）
 *   - 省略号本身计入 maxLength
 *   - 退化情况：当省略号长度**大于或等于** maxLength 时（包括恰好相等），
 *     没有空间同时放下正文与省略号，必须退化为**纯截断**（不补省略号）。
 *     例如 truncate('abcdef', 3, '...') 应返回 'abc'，而不是 '...'。
 *
 * @param {string} text
 * @param {number} maxLength
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncate(text, maxLength, ellipsis = '…') {
  const s = String(text ?? '');
  if (!Number.isInteger(maxLength) || maxLength < 0) {
    throw new RangeError('maxLength 必须是非负整数');
  }
  if (s.length <= maxLength) return s;
  return s.slice(0, maxLength) + ellipsis;
}

/**
 * 把字符串补齐到指定长度。
 * @param {string} text
 * @param {number} length
 * @param {string} [pad]
 * @returns {string}
 */
export function pad(text, length, pad = ' ') {
  const s = String(text ?? '');
  if (s.length >= length) return s;
  return s + pad.repeat(length - s.length);
}
