/**
 * dedupeBy：按指定键对数组去重，保留**首次出现**的元素。
 *
 * 注意：当前实现是两层循环，复杂度 O(n^2)。
 * 这是 demo 工作区故意留下的性能问题，供 Agent 优化练习使用。
 * （运行 `node src/cli.js demo` 可以看到 Agent 把它优化成 O(n) 并跑通测试）
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => unknown} keyOf
 * @returns {T[]}
 */
export function dedupeBy(items, keyOf) {
  if (!Array.isArray(items)) throw new TypeError('items 必须是数组');
  if (typeof keyOf !== 'function') throw new TypeError('keyOf 必须是函数');

  const result = [];
  for (let i = 0; i < items.length; i++) {
    const key = keyOf(items[i]);
    let seen = false;
    for (let j = 0; j < result.length; j++) {
      if (keyOf(result[j]) === key) {
        seen = true;
        break;
      }
    }
    if (!seen) result.push(items[i]);
  }
  return result;
}

/**
 * 按对象某个字段去重的便捷封装。
 * @template T
 * @param {T[]} items
 * @param {keyof T} field
 * @returns {T[]}
 */
export function dedupeByField(items, field) {
  return dedupeBy(items, (item) => item[field]);
}
