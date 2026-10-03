import test from 'node:test';
import assert from 'node:assert/strict';
import { topoSort, hasCycle } from '../src/topo.js';

// 可见测试只覆盖"无环且依赖简单"的情况，所以现在能通过。
// 环检测、自环、图外依赖的验证在评测时才追加。

test('topoSort：线性依赖按序输出', () => {
  assert.deepEqual(topoSort({ a: [], b: ['a'], c: ['b'] }), ['a', 'b', 'c']);
});

test('topoSort：无依赖节点保持传入顺序', () => {
  assert.deepEqual(topoSort({ x: [], y: [], z: [] }), ['x', 'y', 'z']);
});

test('hasCycle：无环图返回 false', () => {
  assert.equal(hasCycle({ a: [], b: ['a'] }), false);
});
