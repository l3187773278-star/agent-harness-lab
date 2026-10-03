#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 子命令：
 *   run <任务>      在一个工作区里跑一个真实任务
 *   demo            在自带的示例工作区上跑一个真实任务（不需要自己准备工程）
 *   bench           跑评测集并与单发基线对照（见 bench/）
 *   selftest        离线自检：不联网、不需要 Key，验证各层接线正常
 *
 * 设计取舍：CLI 只做参数解析与装配，不含任何业务逻辑。
 * 这样每条逻辑都能被单测直接调用，不需要通过命令行去测。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig, assertKeyAvailable, ConfigError } from './config.js';
import { Provider, ProviderError } from './provider.js';
import { ToolBox, TOOL_NAMES } from './tools.js';
import { runAgent, FaultInjector, DEFAULT_LOOP_LIMITS } from './loop.js';
import { Trace } from './trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const VERSION = '0.1.0';

export const USAGE = `agent-harness-lab v${VERSION} —— 从零手写的 AI Agent 运行时与评测台

用法：
  node src/cli.js run <任务描述> [选项]
  node src/cli.js demo [选项]
  node src/cli.js bench [任务id列表] [选项]
  node src/cli.js selftest

选项：
  --workspace <目录>   任务所在的工作区（默认：当前目录）
  --model <名称>       模型名（默认 deepseek-flash；可指定 deepseek-v4-pro）
  --effort <档位>      推理强度 low / high / max（deepseek-v4-pro 支持）
  --timeout <ms>       单次请求超时毫秒数（默认 120000；deepseek-v4-pro 加 effort=max 建议 ≥ 600000）
  --max-steps <n>      最大步数（默认 ${DEFAULT_LOOP_LIMITS.maxSteps}）
  --budget <n>         单次请求的 prompt token 预算（默认 ${DEFAULT_LOOP_LIMITS.maxPromptTokens}）
  --inject <工具:次数> 注入故障，可重复，例如 --inject run_command:1
  --trace <文件>       轨迹输出到 JSONL 文件
  --quiet              不打印每一步细节
  --json               以 JSON 输出最终结果（便于脚本消费）
  --list               bench 用：列出全部评测任务
  --no-baseline        bench 用：只跑 Agent，不跑单发基线
  -h, --help           显示帮助

示例：
  node src/cli.js demo
  node src/cli.js run "把 src/util.js 里的 O(n^2) 去重改成 Set 实现，并跑通测试" --workspace ./demo
  node src/cli.js bench --list
  node src/cli.js bench "t1-truncate,t3-idgen"
  node src/cli.js selftest
`;

/**
 * 极简参数解析。刻意不引 commander/yargs —— 零依赖是硬约束。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = { _: [], inject: [], quiet: false, json: false, list: false, noBaseline: false };
  const takesValue = new Set(['workspace', 'model', 'max-steps', 'budget', 'trace', 'inject', 'base-url', 'effort', 'timeout']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (token === '--quiet') {
      args.quiet = true;
      continue;
    }
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--list') {
      args.list = true;
      continue;
    }
    if (token === '--no-baseline') {
      args.noBaseline = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (!takesValue.has(key)) throw new Error(`未知选项：--${key}\n\n${USAGE}`);
      let value;
      if (eq !== -1) {
        value = token.slice(eq + 1);
      } else {
        value = argv[++i];
        if (value === undefined) throw new Error(`选项 --${key} 缺少值`);
      }
      if (key === 'inject') args.inject.push(value);
      else args[camel(key)] = value;
      continue;
    }
    args._.push(token);
  }
  return args;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** 把 --inject run_command:1,read_file:2 解析成 FaultInjector 的计划。 */
export function parseInjections(list) {
  /** @type {Record<string, {failTimes:number}>} */
  const plan = {};
  for (const item of list || []) {
    for (const piece of String(item).split(',')) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const [tool, timesRaw] = trimmed.split(':');
      const times = Number(timesRaw ?? 1);
      if (!TOOL_NAMES.includes(tool)) {
        throw new Error(`--inject 里的工具名「${tool}」不存在。可用：${TOOL_NAMES.join('、')}`);
      }
      if (!Number.isInteger(times) || times < 1) {
        throw new Error(`--inject ${tool}:${timesRaw} 的次数必须是正整数`);
      }
      plan[tool] = { failTimes: times };
    }
  }
  return plan;
}

/** 把 CLI 参数整理成 runAgent 需要的配置。 */
export function buildRunOptions(args, config) {
  const workspace = path.resolve(args.workspace || process.cwd());
  if (!fs.existsSync(workspace)) throw new Error(`工作区不存在：${workspace}`);
  if (!fs.statSync(workspace).isDirectory()) throw new Error(`工作区不是目录：${workspace}`);

  const maxSteps = args.maxSteps ? Number(args.maxSteps) : DEFAULT_LOOP_LIMITS.maxSteps;
  const budget = args.budget ? Number(args.budget) : DEFAULT_LOOP_LIMITS.maxPromptTokens;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('--max-steps 必须是正整数');
  if (!Number.isInteger(budget) || budget < 500) throw new Error('--budget 必须是不小于 500 的整数');

  return { workspace, maxSteps, budget, model: args.model || config.model };
}

function makeProvider(config, args, trace, quiet) {
  return new Provider({
    baseURL: args.baseUrl || config.baseURL,
    apiKey: config.apiKey,
    model: args.model || config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    temperature: config.temperature,
    onRetry: (info) => {
      if (!quiet) process.stderr.write(`  ↻ 重试第 ${info.attempt} 次（${info.reason}），等待 ${info.delayMs}ms\n`);
      trace.emit('provider.retry', info);
    },
  });
}

function demoTask() {
  return [
    '这个工作区里有一个小的 JavaScript 工具库和它自带的测试。',
    '请完成以下工作：',
    '1. 先读 src/dedupe.js 和 test/dedupe.test.js，弄清现状。',
    '2. src/dedupe.js 里的 dedupeBy 目前是 O(n^2) 的两层循环实现，请改成利用 Map/Set 的 O(n) 实现，',
    '   保持对外行为完全一致（包括"保留首次出现的元素"这一语义）。',
    '3. 用 node --test test/ 跑测试，必须全部通过。',
    '4. 在 src/dedupe.js 顶部注释里补一行说明复杂度，然后调用 finish 汇报你改了什么、测试结果如何。',
  ].join('\n');
}

async function cmdRun(args, { taskOverride = null, useDemoWorkspace = false } = {}) {
  const config = loadConfig({ model: args.model, timeoutMs: args.timeout }, { cwd: PROJECT_ROOT });
  const opts = buildRunOptions(
    useDemoWorkspace ? { ...args, workspace: path.join(PROJECT_ROOT, 'demo') } : args,
    config,
  );

  if (config.offline) throw new Error('当前是离线模式（AHL_OFFLINE=1），run 需要真实调用模型。');
  assertKeyAvailable(config);

  const task = taskOverride || args._.slice(1).join(' ').trim();
  if (!task) throw new Error(`缺少任务描述。\n\n${USAGE}`);

  const trace = new Trace({
    file: args.trace ? path.resolve(args.trace) : null,
    echo: !args.quiet,
  });

  const provider = makeProvider(config, args, trace, args.quiet);
  const toolbox = new ToolBox({ root: opts.workspace });
  const injector = new FaultInjector(parseInjections(args.inject));

  if (!args.quiet) {
    process.stderr.write(`工作区：${opts.workspace}\n模型：${opts.model}\n任务：${task.split('\n')[0]}…\n\n`);
  }

  const result = await runAgent({
    provider,
    toolbox,
    task,
    limits: { maxSteps: opts.maxSteps, maxPromptTokens: opts.budget },
    trace,
    faultInjector: Object.keys(injector.plan).length > 0 ? injector : null,
  });

  const payload = {
    ok: result.ok,
    stopReason: result.stopReason,
    answer: result.answer,
    steps: result.steps,
    compactions: result.compactions,
    blockedCalls: result.blockedCalls,
    invalidCalls: result.invalidCalls,
    tokens: result.tokenTotals,
    toolStats: toolbox.stats,
    injectedFaults: injector.injected,
    error: result.error,
    trace: args.trace ? path.resolve(args.trace) : null,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const t = result.tokenTotals;
    process.stdout.write(
      [
        '',
        `结果：${result.ok ? '✅ 完成' : `❌ 未完成（${result.stopReason}）`}`,
        result.answer ? `答复：${result.answer}` : '',
        `步数：${result.steps} | 压缩：${result.compactions} 次 | 越权拦截：${result.blockedCalls} | 参数非法：${result.invalidCalls}`,
        `token：prompt ${t.prompt}（缓存命中 ${t.cached}）／completion ${t.completion}`,
        `工具：共 ${toolbox.stats.calls} 次，失败 ${toolbox.stats.failures} 次，截断 ${toolbox.stats.truncated} 次`,
        result.error ? `错误：${result.error}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    process.stdout.write('\n');
  }

  return result.ok ? 0 : 1;
}

/**
 * 离线自检：在无网络、无 Key 的情况下验证各层接线。
 * 这是 CI 里除单测之外的第二道保险 —— 单测各测一个模块，自检证明它们串起来能跑。
 */
async function cmdSelftest(args) {
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail });
  const bad = (name, detail) => checks.push({ name, ok: false, detail });

  // 1) 工具层能在临时目录里读写
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ahl-selftest-'));
  const box = new ToolBox({ root: tmp });
  const wrote = await box.execute({ name: 'write_file', args: { path: 'x/y.txt', content: 'hello' } });
  wrote.ok ? ok('工具写入', `写入 x/y.txt ${wrote.result.bytes} 字节`) : bad('工具写入', wrote.error);

  const read = await box.execute({ name: 'read_file', args: { path: 'x/y.txt' } });
  read.ok && read.result.content.includes('hello') ? ok('工具读取', '内容一致') : bad('工具读取', read.error);

  const escaped = await box.execute({ name: 'read_file', args: { path: '../../secret' } });
  !escaped.ok && escaped.code === 'PATH_ESCAPE'
    ? ok('沙箱拦截', '越权路径被拒绝')
    : bad('沙箱拦截', `越权路径竟然通过了：${JSON.stringify(escaped)}`);

  // 2) 上下文层能压缩
  const { compactMessages, buildRequestMessages, buildSystemPrompt } = await import('./context.js');
  const history = [
    { role: 'user', content: '任务' },
    { role: 'assistant', content: 'A'.repeat(5000) },
    { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'B'.repeat(5000) },
    { role: 'assistant', content: '最近一条' },
  ];
  const { stats } = compactMessages(history, { keepRecentMessages: 1 });
  stats.after < stats.before ? ok('上下文压缩', `${stats.before} → ${stats.after} token`) : bad('上下文压缩', '压缩没有生效');

  const built = buildRequestMessages({ systemPrompt: buildSystemPrompt({ toolNames: TOOL_NAMES }), history });
  built.messages[0].role === 'system' ? ok('请求装配', `${built.messages.length} 条消息，约 ${built.tokens} token`) : bad('请求装配', '首条不是 system');

  // 3) 协议层能解析录制流（完全离线）
  const { buildFixtureFromTurns, createReplayFetch } = await import('./recorder.js');
  const { Provider } = await import('./provider.js');
  const fixture = buildFixtureFromTurns([
    { content: '自检回复', toolCalls: [{ name: 'finish', args: { summary: 'selftest' } }], finishReason: 'tool_calls' },
  ]);
  const provider = new Provider({
    baseURL: 'https://offline.test/v1',
    apiKey: 'sk-offline',
    model: 'offline',
    fetchImpl: createReplayFetch(fixture),
    maxRetries: 0,
  });
  const response = await provider.chat([{ role: 'user', content: 'hi' }]);
  response.content === '自检回复' && response.toolCalls.length === 1
    ? ok('协议解析（离线回放）', `内容与 ${response.toolCalls.length} 个工具调用都解析正确`)
    : bad('协议解析', JSON.stringify(response).slice(0, 200));

  // 4) 循环层能端到端跑完一个任务（用回放的模型回复）
  const { runAgent } = await import('./loop.js');
  const loopProvider = new Provider({
    baseURL: 'https://offline.test/v1',
    apiKey: 'sk-offline',
    model: 'offline',
    maxRetries: 0,
    fetchImpl: createReplayFetch(
      buildFixtureFromTurns([
        { toolCalls: [{ name: 'write_file', args: { path: 'out.txt', content: 'done' } }], finishReason: 'tool_calls' },
        { toolCalls: [{ name: 'finish', args: { summary: '自检完成' } }], finishReason: 'tool_calls' },
      ]),
    ),
  });
  const loopResult = await runAgent({
    provider: loopProvider,
    toolbox: new ToolBox({ root: tmp }),
    task: '写一个文件然后结束',
    trace: new Trace({ file: null }),
  });
  loopResult.ok && fs.existsSync(path.join(tmp, 'out.txt'))
    ? ok('循环端到端（离线回放）', `${loopResult.steps} 步完成`)
    : bad('循环端到端', `stopReason=${loopResult.stopReason}`);

  const failed = checks.filter((c) => !c.ok);
  if (!args.quiet) {
    for (const c of checks) process.stdout.write(`${c.ok ? '✅' : '❌'} ${c.name}：${c.detail}\n`);
    process.stdout.write(`\n自检${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}（共 ${checks.length} 项，未联网、未使用 API Key）\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

async function cmdBench(args) {
  const config = loadConfig({ model: args.model, timeoutMs: args.timeout }, { cwd: PROJECT_ROOT });
  const { runBenchmark, loadTasks } = await import('../bench/runner.js');

  if (args.list) {
    process.stdout.write('\n评测任务：\n');
    for (const t of loadTasks()) {
      process.stdout.write(`${t.id.padEnd(16)} ${t.difficulty.padEnd(8)} ${t.tag.padEnd(14)} ${t.title}\n`);
    }
    process.stdout.write('\n用法：node src/cli.js bench [任务id,逗号分隔] [--no-baseline]\n');
    return 0;
  }

  assertKeyAvailable(config);
  if (config.offline) throw new Error('当前是离线模式（AHL_OFFLINE=1），bench 需要真实调用模型。');

  const taskIds = args._[1] ? String(args._[1]).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const maxSteps = args.maxSteps ? Number(args.maxSteps) : undefined;

  const effort = args.effort ? String(args.effort) : undefined;
  if (effort && !['low', 'high', 'max'].includes(effort)) {
    throw new Error(`--effort 只支持 low / high / max，收到：${effort}`);
  }

  const makeProvider = () =>
    new Provider({
      baseURL: args.baseUrl || config.baseURL,
      apiKey: config.apiKey,
      model: args.model || config.model,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      temperature: config.temperature,
      onRetry: (info) => process.stderr.write(`  ↻ 重试第 ${info.attempt} 次（${info.reason}）等待 ${info.delayMs}ms\n`),
    });

  await runBenchmark({
    providerFactory: makeProvider,
    taskIds,
    includeBaseline: !args.noBaseline,
    maxSteps,
    effort,
  });
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  if (args.help || (args._.length === 0 && !args.help)) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  const command = args._[0];
  try {
    switch (command) {
      case 'version':
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        return 0;
      case 'selftest':
        return await cmdSelftest(args);
      case 'demo':
        return await cmdRun(args, { taskOverride: demoTask(), useDemoWorkspace: true });
      case 'run':
        return await cmdRun(args);
      case 'bench':
        return await cmdBench(args);
      default:
        process.stderr.write(`未知子命令：${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n配置错误：${err.message}\n`);
      return 3;
    }
    if (err instanceof ProviderError) {
      process.stderr.write(`\n模型调用失败：${err.message}\n`);
      return 4;
    }
    process.stderr.write(`\n执行失败：${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    return 1;
  }
}

// 只有被当作入口执行时才跑 main，被 import 时（例如单测）不跑
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  });
}
