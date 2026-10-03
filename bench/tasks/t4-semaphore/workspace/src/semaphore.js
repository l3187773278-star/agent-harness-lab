/**
 * 异步信号量：限制同时进行的操作数量。
 *
 * 已知问题（评测任务 T4 的目标）：
 * release() 在存在等待者时，把等待队列**整个清空、全部唤醒**。
 * 但许可只有一个 —— 正确做法是只唤醒队首的那一个，把许可转交给它。
 * 全部唤醒会让所有等待者以为"我拿到许可了"，于是同时涌入，
 * 实际并发数远超 limit，信号量形同虚设。
 */

export class Semaphore {
  /**
   * @param {number} limit 允许的最大并发数
   */
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('limit 必须是正整数');
    }
    this.limit = limit;
    this.available = limit;
    /** @type {Array<() => void>} */
    this.waiters = [];
    this.peak = 0;
    this.active = 0;
  }

  /**
   * 获取一个许可。没有可用许可时排队等待。
   * @returns {Promise<void>}
   */
  async acquire() {
    if (this.available > 0) {
      this.available -= 1;
      this.#enter();
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.#enter();
  }

  /** 释放一个许可。 */
  release() {
    this.active -= 1;
    if (this.waiters.length > 0) {
      // 缺陷：一次唤醒所有等待者，而不是只把许可交给队首的那一个
      const woken = this.waiters.splice(0, this.waiters.length);
      for (const wake of woken) wake();
      return;
    }
    this.available += 1;
  }

  /** 用信号量包住一个异步函数，自动获取与释放。 */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  #enter() {
    this.active += 1;
    if (this.active > this.peak) this.peak = this.active;
  }

  /** 当前等待中的调用者数量。 */
  get pending() {
    return this.waiters.length;
  }
}
