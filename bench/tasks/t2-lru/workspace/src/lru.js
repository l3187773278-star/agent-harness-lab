/**
 * 一个固定容量的 LRU 缓存。
 *
 * 已知问题（评测任务 T2 的目标）：
 * get() 命中时没有把该键移动到"最近使用"的位置，导致淘汰顺序按插入顺序而不是使用顺序。
 */

export class LruCache {
  /**
   * @param {number} capacity 容量上限（必须为正整数）
   */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('capacity 必须是正整数');
    }
    this.capacity = capacity;
    /** @type {Map<any, any>} */
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get size() {
    return this.map.size;
  }

  /**
   * 读取一个键。命中时该键应成为"最近使用"。
   * @param {any} key
   * @returns {any} 不存在时返回 undefined
   */
  get(key) {
    if (!this.map.has(key)) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // 只返回了值，没有更新使用顺序
    return this.map.get(key);
  }

  /**
   * 写入一个键。写入后该键是最"最近使用"的；超容量时淘汰最久未使用的键。
   * @param {any} key
   * @param {any} value
   */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      // Map 的迭代顺序是插入顺序，第一个就是"最久未使用"
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  has(key) {
    return this.map.has(key);
  }

  /** 当前键的顺序，从最久未使用到最近使用。 */
  keys() {
    return [...this.map.keys()];
  }

  clear() {
    this.map.clear();
  }
}
