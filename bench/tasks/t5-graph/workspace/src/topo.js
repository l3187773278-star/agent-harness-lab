/**
 * 有向图的拓扑排序。
 *
 * 已知问题（评测任务 T5 的目标）：
 * 1. 环检测退化成了"整轮没进展就算有环"，误报与漏报并存；
 *    A→B→C→A 这种环会被报成"存在环"，但只给出了一个节点，无法定位环上的全部成员；
 *    更重要的是，当某个节点被多个前驱阻塞时，实现会在错误的时机宣布有环。
 * 2. 自环（A→A）没有被单独识别。
 * 3. 依赖指向图外节点时行为不明确。
 */

/**
 * 对一个有向图做拓扑排序。
 *
 * 契约：
 *   - 返回一个数组，包含**所有**节点，且每个节点都排在它依赖的节点之后
 *   - 没有依赖关系的节点之间，按传入顺序稳定输出
 *   - 图中有环时抛出 Error，错误信息里要包含环上的节点（cycle 属性给出环的节点数组）
 *   - 依赖指向未知节点时应抛出 Error
 *
 * @param {Record<string, string[]>} graph 邻接表：节点 → 它依赖的节点列表
 * @returns {string[]}
 */
export function topoSort(graph) {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new TypeError('graph 必须是对象形式的邻接表');
  }

  const nodes = Object.keys(graph);
  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const node of nodes) {
    const deps = graph[node];
    if (!Array.isArray(deps)) throw new TypeError(`节点「${node}」的依赖必须是数组`);
    remaining.set(node, deps.length);
  }

  const result = [];
  const placed = new Set();

  for (;;) {
    let progressed = false;
    for (const node of nodes) {
      if (placed.has(node)) continue;
      const deps = graph[node];
      const allReady = deps.every((d) => placed.has(d));
      if (allReady) {
        result.push(node);
        placed.add(node);
        progressed = true;
      }
    }
    if (placed.size === nodes.length) return result;
    if (!progressed) {
      const err = new Error('图中存在环，无法完成拓扑排序');
      err.cycle = nodes.filter((n) => !placed.has(n));
      throw err;
    }
  }
}

/**
 * 判断图中是否存在环。
 * @param {Record<string, string[]>} graph
 * @returns {boolean}
 */
export function hasCycle(graph) {
  try {
    topoSort(graph);
    return false;
  } catch (err) {
    if (err && err.cycle) return true;
    throw err;
  }
}
