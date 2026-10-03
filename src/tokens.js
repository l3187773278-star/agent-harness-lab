/**
 * token 估算。
 *
 * 为什么要自己估算而不是引 tiktoken：
 *   1) 零依赖约束；
 *   2) 真实 tokenizer 要到调用后才能拿到 usage，而我们要**调用前**就决定压不压缩。
 *
 * 估算必然不准，所以策略是**刻意高估**：宁可多压一点，也不要因为低估而撞窗口报错。
 * 系数校准依据见 docs/adr/0003-token-估算为什么用字符启发式.md，
 * 后续会用真实 usage 回填校准。
 */

/** 字符 → token 的经验系数。实测 DeepSeek 对中英混排大致落在 1 token ≈ 2.5~3.5 字符。 */
export const CHARS_PER_TOKEN = 2.6;

/** 每条消息的角色、分隔符等固定开销。 */
export const PER_MESSAGE_OVERHEAD = 4;

/**
 * 估算一段文本的 token 数。
 *
 * 分开统计 ASCII 与非 ASCII：ASCII 约 4 字符/token，CJK 约 1 字符/token。
 * 只用一个平均系数会让纯中文的技术文档被严重低估。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (s === '') return 0;

  let ascii = 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) <= 0x7f) ascii += 1;
    else wide += 1;
  }

  const asciiTokens = ascii / 3.6;
  const wideTokens = wide / 1.0;
  return Math.ceil(asciiTokens + wideTokens) + 1;
}

/**
 * 用真实 usage 校准估算准确度，评测报告里会用到。
 * 返回估算值相对真实值的偏差比例（正数表示高估）。
 *
 * @param {number} estimated
 * @param {number} actual
 */
export function calibrationError(estimated, actual) {
  if (!actual) return null;
  return Number(((estimated - actual) / actual).toFixed(4));
}
