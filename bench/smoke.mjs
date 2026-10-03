/**
 * 评测器离线冒烟测试：不联网、不花钱，验证评测流水线接线正确。
 *
 * 用一个"假 Provider"驱动整套 runBenchmark：
 *   - Agent 每次都直接调用 finish（什么都不改）→ 评分器必然失败；
 *   - 基线根据任务返回对应参考解法 → 评分器必然通过。
 *
 * 因此一份正确接线的评测器应该输出：Agent 0/6、基线 6/6。
 * 如果数字不是这个，说明评测流水线本身有 bug —— 这就是这份脚本存在的意义。
 *
 * 用法：node bench/smoke.mjs
 */
import { runBenchmark } from './runner.js';
import { REFERENCE_SOLUTIONS } from './reference-solutions.mjs';

const TASK_MARKERS = {
  'src/text.js': 't1-truncate',
  'src/lru.js': 't2-lru',
  'src/idgen.js': 't3-idgen',
  'src/semaphore.js': 't4-semaphore',
  'src/topo.js': 't5-graph',
  'src/daterange.js': 't6-daterange',
};

function detectTask(userContent) {
  for (const [marker, id] of Object.entries(TASK_MARKERS)) {
    if (String(userContent).includes(marker)) return id;
  }
  return null;
}

function fakeProvider() {
  return {
    model: 'smoke-fake',
    async chat(messages, opts = {}) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user') || {};
      const taskId = detectTask(lastUser.content || '');

      // 基线调用：返回该任务的参考解法作为补丁
      if (taskId && !opts.tools) {
        const patch = {};
        for (const [rel, content] of Object.entries(REFERENCE_SOLUTIONS[taskId])) {
          patch[rel] = content;
        }
        return {
          content: JSON.stringify({ files: patch }),
          reasoning: '',
          finishReason: 'stop',
          usage: { prompt_tokens: 1000, completion_tokens: 800, prompt_cache_hit_tokens: 0 },
          toolCalls: [],
          invalidToolCalls: [],
        };
      }

      // Agent 调用：直接 finish，什么都不改 → 必然判失败
      return {
        content: '冒烟测试：直接结束。',
        reasoning: '',
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 500, completion_tokens: 30, prompt_cache_hit_tokens: 0 },
        toolCalls: [
          {
            index: 0,
            id: 'smoke_finish',
            name: 'finish',
            args: { summary: '冒烟测试直接结束，不做任何修改' },
            argsText: JSON.stringify({ summary: '冒烟测试直接结束，不做任何修改' }),
            invalid: false,
          },
        ],
        invalidToolCalls: [],
      };
    },
  };
}

const { report, runDir } = await runBenchmark({
  providerFactory: fakeProvider,
  includeBaseline: true,
  maxSteps: 8,
  onProgress: (msg) => process.stderr.write(`${msg}\n`),
});

const agentPassed = report.summary.agent.passed;
const baselinePassed = report.summary.baseline ? report.summary.baseline.passed : 0;
const tasks = report.tasks.length;

const expected = agentPassed === 0 && baselinePassed === tasks;
console.log('\n===== 冒烟测试结果 =====');
console.log(`任务数：${tasks}`);
console.log(`Agent 通过：${agentPassed}（期望 0）`);
console.log(`基线通过：${baselinePassed}（期望 ${tasks}）`);
console.log(`评测器接线：${expected ? '✅ 正确' : '❌ 有误'}`);
console.log(`运行目录：${runDir}`);

if (!expected) process.exitCode = 1;
