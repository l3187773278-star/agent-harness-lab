/**
 * 参考解法 + 双向验证。
 *
 * 作用：证明每个任务的评分器既"能抓住 bug"（种子实现失败）又"不会误判"（正确实现通过）。
 * 这份文件只是验证脚手架，不参与 Agent 评测。
 *
 * 用法：node bench/reference-solutions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(HERE, 'tasks');

const T1 = [
  '/**',
  ' * 文本工具集（参考解法）。',
  ' */',
  '',
  'export function truncate(text, maxLength, ellipsis = \u2018…\u2019) {',
  '  const s = String(text ?? "");',
  '  if (!Number.isInteger(maxLength) || maxLength < 0) {',
  '    throw new RangeError("maxLength 必须是非负整数");',
  '  }',
  '  if (s.length <= maxLength) return s;',
  '',
  '  const mark = String(ellipsis ?? "");',
  '  // 省略号比上限还长（或正好占满）时退化为纯截断，否则长度会越界',
  '  if (mark.length >= maxLength) return s.slice(0, maxLength);',
  '  return s.slice(0, maxLength - mark.length) + mark;',
  '}',
  '',
  'export function pad(text, length, pad = " ") {',
  '  const s = String(text ?? "");',
  '  if (s.length >= length) return s;',
  '  return s + String(pad).repeat(length - s.length);',
  '}',
  '',
].join('\n').replace(/\u2018|\u2019/g, "'");

const T2 = [
  '/**',
  ' * 定容 LRU 缓存（参考解法）：用 Map 的插入顺序维护"最近使用"。',
  ' */',
  '',
  'export class LruCache {',
  '  constructor(capacity) {',
  '    if (!Number.isInteger(capacity) || capacity < 1) {',
  '      throw new RangeError("capacity 必须是正整数");',
  '    }',
  '    this.capacity = capacity;',
  '    this.map = new Map();',
  '    this.hits = 0;',
  '    this.misses = 0;',
  '  }',
  '',
  '  get size() {',
  '    return this.map.size;',
  '  }',
  '',
  '  get(key) {',
  '    if (!this.map.has(key)) {',
  '      this.misses += 1;',
  '      return undefined;',
  '    }',
  '    this.hits += 1;',
  '    const value = this.map.get(key);',
  '    // 命中即刷新：先删再插，使它排到迭代顺序末尾（最近使用）',
  '    this.map.delete(key);',
  '    this.map.set(key, value);',
  '    return value;',
  '  }',
  '',
  '  set(key, value) {',
  '    if (this.map.has(key)) this.map.delete(key);',
  '    this.map.set(key, value);',
  '    while (this.map.size > this.capacity) {',
  '      const oldest = this.map.keys().next().value;',
  '      this.map.delete(oldest);',
  '    }',
  '  }',
  '',
  '  has(key) {',
  '    return this.map.has(key);',
  '  }',
  '',
  '  keys() {',
  '    return [...this.map.keys()];',
  '  }',
  '',
  '  clear() {',
  '    this.map.clear();',
  '  }',
  '}',
  '',
].join('\n');

const T3 = [
  '/**',
  ' * 短 ID 生成器（参考解法）：时间戳 + 同毫秒内自增序列，保证唯一。',
  ' */',
  '',
  'const BASE = 36;',
  'const TIME_WIDTH = 9;',
  'const SEQ_WIDTH = 4;',
  'const SEQ_MAX = BASE ** SEQ_WIDTH;',
  '',
  'let lastTime = -1;',
  'let seq = 0;',
  '',
  'function encode(value, width) {',
  '  return Math.floor(value).toString(BASE).padStart(width, "0").slice(-width);',
  '}',
  '',
  '/**',
  ' * 生成一个短 ID。',
  ' *',
  ' * 唯一性保证：同一毫秒内靠 seq 自增区分；跨毫秒时 seq 归零。',
  ' * 若时钟回拨（now <= lastTime），沿用 lastTime 并继续自增 seq ——',
  ' * 宁可让 ID 略微"超前"，也绝不重复。',
  ' */',
  'export function nextId() {',
  '  const now = Date.now();',
  '  if (now <= lastTime) {',
  '    seq += 1;',
  '    if (seq >= SEQ_MAX) {',
  '      lastTime += 1;',
  '      seq = 0;',
  '    }',
  '  } else {',
  '    lastTime = now;',
  '    seq = 0;',
  '  }',
  '  const a = encode(lastTime, TIME_WIDTH);',
  '  const b = encode(seq, SEQ_WIDTH);',
  '  return "id-" + a + "-" + b;',
  '}',
  '',
  'export function lastTimestamp() {',
  '  return lastTime;',
  '}',
  '',
].join('\n');

const T4 = [
  '/**',
  ' * 异步信号量（参考解法）。',
  ' *',
  ' * 核心模型：用 inUse 作为**唯一权威**计数，available 由它派生。',
  ' * 这样做的好处是不会有"两份账各自加减"导致的漂移。',
  ' *',
  ' * 常见的两种错误写法：',
  ' *  1) release 遇到等待者时只唤醒、不归还许可，也不把许可记到对方名下',
  ' *     → 同一份许可被算作"已释放"又"被持有"，额度凭空变多；',
  ' *  2) 等待者被唤醒后重新扣减 available → 与 release 的归还重复递减，',
  ' *     available 会被减成负数，后续 acquire 全部永久阻塞。',
  ' *',
  ' * 正确做法：许可在 release 时就完成转移（inUse 不变，等待者记入 permits=1），',
  ' * 等待者被唤醒时不重复记账。',
  ' */',
  '',
  'export class Semaphore {',
  '  constructor(limit) {',
  '    if (!Number.isInteger(limit) || limit < 1) {',
  '      throw new RangeError("limit 必须是正整数");',
  '    }',
  '    this.limit = limit;',
  '    this.inUse = 0;',
  '    this.peak = 0;',
  '    this.waiters = [];',
  '  }',
  '',
  '  get available() {',
  '    return this.limit - this.inUse;',
  '  }',
  '',
  '  get active() {',
  '    return this.inUse;',
  '  }',
  '',
  '  async acquire() {',
  '    if (this.inUse < this.limit) {',
  '      this.inUse += 1;',
  '      this.#trackPeak();',
  '      return;',
  '    }',
  '    // 无可用额度：排队。被唤醒时许可已在 release 中转移到自己名下。',
  '    await new Promise((resolve) => this.waiters.push(resolve));',
  '  }',
  '',
  '  release() {',
  '    if (this.inUse <= 0) return;',
  '',
  '    const next = this.waiters.shift();',
  '    if (next) {',
  '      // 许可直接转交：inUse 不变（释放者 -1、等待者 +1 相互抵消），',
  '      // 同时把等待者补记进 inUse，保证峰值统计正确。',
  '      next();',
  '      return;',
  '    }',
  '    this.inUse -= 1;',
  '  }',
  '',
  '  async run(fn) {',
  '    await this.acquire();',
  '    try {',
  '      return await fn();',
  '    } finally {',
  '      this.release();',
  '    }',
  '  }',
  '',
  '  #trackPeak() {',
  '    if (this.inUse > this.peak) this.peak = this.inUse;',
  '  }',
  '',
  '  get pending() {',
  '    return this.waiters.length;',
  '  }',
  '}',
  '',
].join('\n');

const T5 = [
  '/**',
  ' * 有向图拓扑排序（参考解法）。',
  ' * 用 DFS 三色标记检测环：白色未访问 / 灰色在栈上 / 黑色已完成。',
  ' * 遇到指向灰色节点的边即为回边，回边到当前节点之间的栈内容就是环。',
  ' *',
  ' * 复杂度：O(V + E)',
  ' */',
  '',
  'export function topoSort(graph) {',
  '  if (graph === null || typeof graph !== "object" || Array.isArray(graph)) {',
  '    throw new TypeError("graph 必须是对象形式的邻接表");',
  '  }',
  '',
  '  const nodes = Object.keys(graph);',
  '  for (const node of nodes) {',
  '    if (!Array.isArray(graph[node])) throw new TypeError("节点 " + node + " 的依赖必须是数组");',
  '  }',
  '  const known = new Set(nodes);',
  '  for (const node of nodes) {',
  '    for (const dep of graph[node]) {',
  '      if (!known.has(dep)) {',
  '        throw new Error("节点 " + node + " 依赖了图中不存在的节点 " + dep);',
  '      }',
  '    }',
  '  }',
  '',
  '  const WHITE = 0;',
  '  const GRAY = 1;',
  '  const BLACK = 2;',
  '  const color = new Map(nodes.map((n) => [n, WHITE]));',
  '  const stack = [];',
  '  const result = [];',
  '  const cycleMembers = new Set();',
  '',
  '  const visit = (node) => {',
  '    color.set(node, GRAY);',
  '    stack.push(node);',
  '',
  '    for (const dep of graph[node]) {',
  '      const c = color.get(dep);',
  '      if (c === GRAY) {',
  '        // 回边：从 dep 在栈中的位置到栈顶构成环',
  '        const from = stack.indexOf(dep);',
  '        for (let i = from; i < stack.length; i++) cycleMembers.add(stack[i]);',
  '      } else if (c === WHITE) {',
  '        visit(dep);',
  '      }',
  '    }',
  '',
  '    stack.pop();',
  '    color.set(node, BLACK);',
  '    result.push(node);',
  '  };',
  '',
  '  // 按传入顺序遍历，保证无依赖节点之间的输出顺序稳定',
  '  for (const node of nodes) {',
  '    if (color.get(node) === WHITE) visit(node);',
  '  }',
  '',
  '  if (cycleMembers.size > 0) {',
  '    const err = new Error("图中存在环，涉及节点：" + [...cycleMembers].join(", "));',
  '    err.cycle = [...cycleMembers];',
  '    throw err;',
  '  }',
  '',
  '  return result;',
  '}',
  '',
  'export function hasCycle(graph) {',
  '  try {',
  '    topoSort(graph);',
  '    return false;',
  '  } catch (err) {',
  '    if (err && err.cycle) return true;',
  '    throw err;',
  '  }',
  '}',
  '',
].join('\n');

const T6 = [
  '/**',
  ' * 日期区间工具（参考解法）：全部用本地时间构造，不混用 UTC 表示。',
  ' */',
  '',
  'export function dayRange(date) {',
  '  const d = date === undefined ? new Date() : new Date(date);',
  '  if (Number.isNaN(d.getTime())) throw new TypeError("无效的日期");',
  '',
  '  // 用本地年月日构造当天 00:00:00.000；',
  '  // 不用 toISOString()，因为它返回 UTC 表示，在非 UTC 时区会串到相邻日期。',
  '  const y = d.getFullYear();',
  '  const m = d.getMonth();',
  '  const day = d.getDate();',
  '  const start = new Date(y, m, day, 0, 0, 0, 0);',
  '  const end = new Date(y, m, day, 23, 59, 59, 999);',
  '  return { start, end };',
  '}',
  '',
  'export function isWithin(ts, range) {',
  '  const t = new Date(ts).getTime();',
  '  if (Number.isNaN(t)) throw new TypeError("无效的时间戳");',
  '  return t >= range.start.getTime() && t <= range.end.getTime();',
  '}',
  '',
  'export function formatRange(range) {',
  '  const fmt = (d) => {',
  '    const mm = String(d.getMonth() + 1).padStart(2, "0");',
  '    const dd = String(d.getDate()).padStart(2, "0");',
  '    return d.getFullYear() + "-" + mm + "-" + dd;',
  '  };',
  '  return fmt(range.start) + " ~ " + fmt(range.end);',
  '}',
  '',
].join('\n');

/** 每个任务对应的参考解法：需要替换的文件 → 正确内容。 */
export const REFERENCE_SOLUTIONS = {
  't1-truncate': { 'src/text.js': T1 },
  't2-lru': { 'src/lru.js': T2 },
  't3-idgen': { 'src/idgen.js': T3 },
  't4-semaphore': { 'src/semaphore.js': T4 },
  't5-graph': { 'src/topo.js': T5 },
  't6-daterange': { 'src/daterange.js': T6 },
};

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function runTests(dir) {
  try {
    // 与 bench/runner.js 的判分保持一致：固定时区，t6 的时区语义才可复现（CI runner 默认 UTC）。
    const out = execFileSync(process.execPath, ['--test'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: { ...process.env, TZ: 'Asia/Shanghai' },
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}

/** 把任务工作区复制到临时目录，可选地应用参考解法与评分器。 */
function makeCase(taskId, { applySolution, withGrader }) {
  const taskDir = path.join(TASKS_DIR, taskId);
  const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-ref-' + taskId + '-'));
  copyDir(path.join(taskDir, 'workspace'), dir);

  if (applySolution) {
    for (const [rel, content] of Object.entries(REFERENCE_SOLUTIONS[taskId])) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }

  if (withGrader) {
    const target = path.join(dir, meta.graderTarget);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    for (const f of meta.graderFiles) {
      fs.copyFileSync(path.join(taskDir, 'grader', f), target);
    }
  }
  return { dir, meta };
}

export function verifyAll() {
  const rows = [];

  for (const id of Object.keys(REFERENCE_SOLUTIONS)) {
    // 1) 种子实现 + 评分器 → 必须失败（否则任务没难度）
    const seeded = makeCase(id, { applySolution: false, withGrader: true });
    const seededRes = runTests(seeded.dir);

    // 2) 参考解法 + 评分器 → 必须通过（否则评分器误判）
    const solved = makeCase(id, { applySolution: true, withGrader: true });
    const solvedRes = runTests(solved.dir);

    // 3) 参考解法 + 可见测试 → 必须通过（否则解法把自带测试弄坏了）
    const solvedVisible = makeCase(id, { applySolution: true, withGrader: false });
    const visibleRes = runTests(solvedVisible.dir);

    rows.push({
      id,
      seedsFails: !seededRes.ok,
      solutionPasses: solvedRes.ok,
      visibleStillPasses: visibleRes.ok,
      detail: solvedRes.ok ? '' : tail(solvedRes.out),
    });
  }

  const allGood = rows.every((r) => r.seedsFails && r.solutionPasses && r.visibleStillPasses);
  return { rows, allGood };
}

function tail(text, lines = 14) {
  return text.split('\n').slice(-lines).join('\n');
}

function run() {
  console.log('\n双向验证：种子实现必须被评分器抓住，参考解法必须通过\n');
  console.log('-'.repeat(72));
  console.log('任务'.padEnd(16) + '种子被抓住'.padEnd(16) + '解法过评分器'.padEnd(18) + '解法过可见测试');
  console.log('-'.repeat(72));

  const { rows, allGood } = verifyAll();
  for (const r of rows) {
    console.log(
      r.id.padEnd(16) +
        (r.seedsFails ? '✅ 是' : '❌ 否').padEnd(16) +
        (r.solutionPasses ? '✅ 是' : '❌ 否').padEnd(18) +
        (r.visibleStillPasses ? '✅ 是' : '❌ 否'),
    );
    if (r.detail) console.log('\n  -- ' + r.id + ' 参考解法失败详情 --\n' + r.detail + '\n');
  }
  console.log('-'.repeat(72));
  console.log(allGood ? '\n✅ 全部任务双向验证通过' : '\n❌ 有任务未通过双向验证，需要修正');
  process.exitCode = allGood ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run();
}
