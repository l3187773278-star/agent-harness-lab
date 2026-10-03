import test from 'node:test';
import assert from 'node:assert/strict';
import { topoSort, hasCycle } from '../src/topo.js';

/** 校验排序结果确实满足"每个节点都在其依赖之后"。 */
function assertValidOrder(graph, order) {
  const position = new Map(order.map((n, i) => [n, i]));
  assert.equal(order.length, Object.keys(graph).length, '结果必须包含所有节点且不重复');
  assert.equal(new Set(order).size, order.length, '结果里不能有重复节点');
  for (const [node, deps] of Object.entries(graph)) {
    for (const dep of deps) {
      assert.ok(
        position.get(dep) < position.get(node),
        `节点「${node}」排在了它的依赖「${dep}」之前`,
      );
    }
  }
}

test('有环图必须抛错，且错误里给出环上的节点', () => {
  const graph = { a: ['c'], b: ['a'], c: ['b'] };
  assert.throws(
    () => topoSort(graph),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(Array.isArray(err.cycle), 'err.cycle 应是数组');
      assert.deepEqual([...err.cycle].sort(), ['a', 'b', 'c'], '环上三个节点都要报告出来');
      return true;
    },
  );
  assert.equal(hasCycle(graph), true);
});

test('自环必须被识别为环', () => {
  assert.throws(() => topoSort({ a: ['a'] }), (err) => {
    assert.deepEqual(err.cycle, ['a']);
    return true;
  });
  assert.equal(hasCycle({ a: ['a'], b: [] }), true);
});

test('部分节点在环上、部分不在时，cycle 只包含真正成环的节点', () => {
  // d 依赖 b，b 在环上，所以 d 也永远无法完成；但环本身是 b<->c
  const graph = { a: [], b: ['c'], c: ['b'], d: ['b'] };
  assert.throws(() => topoSort(graph), (err) => {
    assert.ok(err.cycle.includes('b') && err.cycle.includes('c'), '环成员 b、c 必须报告');
    return true;
  });
});

test('多个前驱阻塞的节点不能被误报成环', () => {
  // 这是一个无环图：f 依赖 c 和 e，必须等 e 处理完才轮到 f
  const graph = { a: [], b: ['a'], c: ['b'], d: ['a'], e: ['d'], f: ['c', 'e'], g: ['f'] };
  const order = topoSort(graph);
  assertValidOrder(graph, order);
  assert.equal(order[0], 'a');
  assert.equal(order[order.length - 1], 'g');
  assert.equal(hasCycle(graph), false, '无环图不能被误报为有环');
});

test('依赖指向未知节点时应抛错', () => {
  assert.throws(
    () => topoSort({ a: ['missing'] }),
    (err) => {
      assert.match(String(err.message), /missing/);
      return true;
    },
  );
});

test('复杂无环图的排序结果满足全部依赖约束', () => {
  const graph = {
    build: ['compile', 'assets'],
    compile: ['parse'],
    assets: ['parse'],
    parse: ['read'],
    read: [],
    test: ['build'],
    deploy: ['test', 'assets'],
  };
  const order = topoSort(graph);
  assertValidOrder(graph, order);
  assert.equal(order[0], 'read');
});

test('环形依赖链能被完整报告（三段环）', () => {
  const graph = { x: ['z'], y: ['x'], z: ['y'], w: [] };
  assert.throws(() => topoSort(graph), (err) => {
    assert.deepEqual([...err.cycle].sort(), ['x', 'y', 'z']);
    return true;
  });
  assert.equal(hasCycle(graph), true);
});

test('空图与单节点图', () => {
  assert.deepEqual(topoSort({}), []);
  assert.deepEqual(topoSort({ only: [] }), ['only']);
});

test('非对象入参抛 TypeError', () => {
  assert.throws(() => topoSort(null), TypeError);
  assert.throws(() => topoSort([]), TypeError);
  assert.throws(() => topoSort({ a: 'not-array' }), TypeError);
});
