/**
 * 评测执行器：在隔离工作区里跑 Agent 与单发基线，产出可复现报告。
 *
 * 设计原则（见 SPEC §2）：
 *   1. 任务工作区每次都复制到全新目录 —— Agent 的改动绝不污染评测集本身；
 *   2. 评分器文件在 Agent 跑完之后才注入 —— Agent 改不了判分逻辑；
 *   3. 判分 = 在最终工作区里跑 `node --test`，全绿才通过（确定性判分）；
 *   4. 单发基线拿到**同样的文件全文**，但没有多步试探、执行反馈、纠错机会 ——
 *      这是"结构化的 Agent 运行时 vs 直接问模型"的公平对照；
 *   5. 所有数字都记录时间、模型、版本，跑一次就存一次，可复现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/loop.js';
import { ToolBox } from '../src/tools.js';
import { Trace } from '../src/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/** 每任务的最长墙钟时间（分钟）。任务卡死也要能出报告。 */
const TASK_TIMEOUT_MS = 12 * 60_000;
/** 判分测试的最长执行时间。 */
const GRADER_TIMEOUT_MS = 120_000;

/**
 * 判分进程固定时区。
 *
 * t6-daterange 的任务语义与时区强相关：种子缺陷（用 UTC 取日期）只在非 UTC 时区下显现。
 * 若判分进程跟随宿主机时区，CI runner（默认 UTC）会连种子缺陷都抓不到，
 * 判分器被误判成「接线有误」。固定为项目文档声明的环境时区，保证本机与 CI 结果一致。
 */
const GRADER_TZ = 'Asia/Shanghai';

/**
 * 深度递归复制目录。
 */
export function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** 收集工作区里所有"对模型可见"的文件（跳过 node_modules 等噪声）。 */
export function collectVisibleFiles(workspace) {
  /** @type {Array<{path:string, content:string, bytes:number}>} */
  const files = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'package-lock.json') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(abs, 'utf8');
          files.push({ path: relPath, content, bytes: Buffer.byteLength(content, 'utf8') });
        } catch {
          // 二进制文件跳过
        }
      }
    }
  };
  walk(workspace);
  return files;
}

/**
 * 在最终工作区里跑评分器，返回是否通过与失败细节。
 * @param {string} workspace
 * @param {{graderTarget:string, graderFiles:string[], taskDir:string}} taskInfo
 */
export function runGrader(workspace, taskInfo) {
  const target = path.join(workspace, taskInfo.graderTarget);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const f of taskInfo.graderFiles) {
    fs.copyFileSync(path.join(taskInfo.taskDir, 'grader', f), target);
  }

  const started = Date.now();
  try {
    const out = execFileSync(process.execPath, ['--test'], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GRADER_TIMEOUT_MS,
      env: { ...process.env, TZ: GRADER_TZ },
    });
    return { pass: true, durationMs: Date.now() - started, output: tail(out) };
  } catch (err) {
    const output = String((err && err.stdout) || '') + String((err && err.stderr) || '');
    return { pass: false, durationMs: Date.now() - started, output: tail(output) };
  }
}

/**
 * 跑单发基线：把工作区文件全文一次性给模型，让它直接产出完整补丁。
 * 注意基线不是"随便问一句" —— 它拿到与 Agent 同等的信息量，只是没有行动/反馈机会。
 *
 * @param {{
 *   provider: import('../src/provider.js').Provider,
 *   task: { prompt: string, taskDir: string },
 *   workspace: string,
 *   effort?: string,
 * }}
 */
export async function runBaseline({ provider, task, workspace, effort = undefined }) {
  const files = collectVisibleFiles(workspace);
  const listing = files
    .map((f) => `### 文件：${f.path}（${f.bytes} 字节）\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const system = [
    '你是软件工程修复专家。你会收到一个工作区里全部文件的完整内容和一个任务描述。',
    '请**一次性**直接给出修复后的完整文件内容，不要问问题，不要分步。',
    '',
    '输出格式（严格 JSON，不要 markdown 代码块围栏）：',
    '{',
    '  "files": {',
    '    "相对路径": "该文件修复后的完整内容",',
    '  }',
    '}',
    '',
    '规则：',
    '- files 里只包含你修改过的文件；未修改的文件不要列出。',
    '- 每个文件的内容必须**完整**，不是 diff、不是片段。',
    '- 不要改测试文件。',
  ].join('\n');

  const started = Date.now();
  let response;
  try {
    response = await provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: `任务描述：\n${task.prompt}\n\n工作区文件全文：\n\n${listing}` },
      ],
      { temperature: 0, effort },
    );
  } catch (err) {
    return {
      kind: 'baseline',
      pass: false,
      appliedFiles: 0,
      error: `模型调用失败：${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - started,
    };
  }

  const durationMs = Date.now() - started;
  const usage = response.usage || {};

  // 解析模型给出的 JSON 补丁
  const stripped = (response.content || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let patch;
  try {
    patch = JSON.parse(stripped);
  } catch (err) {
    return {
      kind: 'baseline',
      pass: false,
      appliedFiles: 0,
      parseError: `无法解析模型输出为 JSON：${err instanceof Error ? err.message.slice(0, 200) : ''}`,
      raw: (response.content || '').slice(0, 400),
      durationMs,
      tokens: { prompt: Number(usage.prompt_tokens) || 0, completion: Number(usage.completion_tokens) || 0 },
    };
  }

  const filesToApply = patch && typeof patch.files === 'object' && !Array.isArray(patch.files) ? patch.files : {};
  let applied = 0;
  for (const [rel, content] of Object.entries(filesToApply)) {
    const abs = path.resolve(workspace, rel);
    const realRoot = fs.realpathSync(workspace);
    // 补丁路径不允许越出工作区（防御模型幻觉路径）
    if (!abs.startsWith(realRoot)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content), 'utf8');
    applied += 1;
  }

  return {
    kind: 'baseline',
    pass: null, // 判分在 apply 之后由调用方统一做
    appliedFiles: applied,
    durationMs,
    tokens: { prompt: Number(usage.prompt_tokens) || 0, completion: Number(usage.completion_tokens) || 0 },
  };
}

/** 加载全部任务定义（按 id 排序）。 */
export function loadTasks() {
  const dir = path.join(HERE, 'tasks');
  return fs
    .readdirSync(dir)
    .filter((id) => fs.existsSync(path.join(dir, id, 'task.json')))
    .sort()
    .map((id) => {
      const taskDir = path.join(dir, id);
      const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
      return { id, taskDir, ...meta };
    });
}

/**
 * 跑完整评测。
 *
 * @param {{
 *   providerFactory: () => import('../src/provider.js').Provider,
 *   taskIds?: string[],
 *   includeBaseline?: boolean,
 *   maxSteps?: number,
 *   effort?: string,
 *   onProgress?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{ report: object, runDir: string }>}
 */
export async function runBenchmark(opts) {
  const { providerFactory, taskIds = null, includeBaseline = true, maxSteps = 24, effort = undefined, onProgress } = opts;

  const runId = `bench-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const runDir = path.join(PROJECT_ROOT, 'bench', 'results', runId);
  const workspaceRoot = path.join(runDir, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const tasks = (taskIds ? loadTasks().filter((t) => taskIds.includes(t.id)) : loadTasks()).map((t) => ({
    ...t,
    workspace: path.join(workspaceRoot, t.id),
  }));

  const startedAt = new Date().toISOString();
  const results = [];
  const log = (msg) => (onProgress ? onProgress(msg) : process.stderr.write(`${msg}\n`));

  log(`\n评测开始：${runId}`);
  log(`任务 ${tasks.length} 个，模型：${providerFactory().model}，基线：${includeBaseline ? '开' : '关'}\n`);

  for (const task of tasks) {
    log(`\n━━━ ${task.id}（${task.difficulty}）${task.title} ━━━`);

    // ---- Agent 运行 ----
    copyTree(path.join(task.taskDir, 'workspace'), task.workspace);
    const traceFile = path.join(runDir, 'traces', `${task.id}.agent.jsonl`);
    const trace = new Trace({ file: traceFile });
    const agentProvider = providerFactory();
    const toolbox = new ToolBox({ root: task.workspace });

    const agentStarted = Date.now();
    let agentResult;
    try {
      agentResult = await withTimeout(
        runAgent({
          provider: agentProvider,
          toolbox,
          task: task.prompt,
          limits: { maxSteps, maxPromptTokens: 24_000 },
          effort,
          trace,
        }),
        TASK_TIMEOUT_MS,
        `agent_${task.id}`,
      );
    } catch (err) {
      agentResult = {
        ok: false,
        stopReason: 'bench_error',
        error: err instanceof Error ? err.message : String(err),
        steps: 0,
        tokenTotals: { prompt: 0, completion: 0, cached: 0 },
        compactions: 0,
        blockedCalls: 0,
        invalidCalls: 0,
        summary: null,
      };
    }
    const agentDurationMs = Date.now() - agentStarted;

    const graderInfo = { taskDir: task.taskDir, graderTarget: task.graderTarget, graderFiles: task.graderFiles };
    const agentGrade = runGrader(task.workspace, graderInfo);

    // ---- 基线运行（在**另一份**全新工作区副本上） ----
    let baseline = null;
    let baselineGrade = null;
    if (includeBaseline) {
      const baselineWorkspace = path.join(workspaceRoot, `${task.id}--baseline`);
      copyTree(path.join(task.taskDir, 'workspace'), baselineWorkspace);
      baseline = await runBaseline({ provider: providerFactory(), task, workspace: baselineWorkspace, effort });
      if (baseline.error || baseline.parseError) {
        baselineGrade = { pass: false, output: baseline.parseError || baseline.error };
      } else {
        baselineGrade = runGrader(baselineWorkspace, graderInfo);
      }
      baseline.pass = baselineGrade.pass;
    }

    results.push({
      task: {
        id: task.id,
        title: task.title,
        difficulty: task.difficulty,
        tag: task.tag,
      },
      agent: {
        pass: agentGrade.pass,
        ok: agentResult.ok,
        stopReason: agentResult.stopReason,
        error: agentResult.error || null,
        steps: agentResult.steps || 0,
        compactions: agentResult.compactions || 0,
        blockedCalls: agentResult.blockedCalls || 0,
        invalidCalls: agentResult.invalidCalls || 0,
        tokens: agentResult.tokenTotals,
        durationMs: agentDurationMs,
        trace: path.relative(PROJECT_ROOT, traceFile),
        gradeOutputTail: agentGrade.pass ? null : agentGrade.output,
      },
      baseline: baseline
        ? {
            pass: baseline.pass,
            appliedFiles: baseline.appliedFiles,
            parseError: baseline.parseError || null,
            tokens: baseline.tokens,
            durationMs: baseline.durationMs,
            gradeOutputTail: baselineGrade && baselineGrade.pass ? null : (baselineGrade && baselineGrade.output) || null,
          }
        : null,
    });

    log(
      `  Agent：${agentGrade.pass ? '✅ 通过' : `❌ 未通过（${agentResult.stopReason}）`} · ${agentResult.steps || 0} 步 · ` +
        `${fmtTokens(agentResult.tokenTotals)} · ${Math.round(agentDurationMs / 1000)}s`,
    );
    if (baseline) {
      log(`  基线：${baseline.pass ? '✅ 通过' : `❌ 未通过`} · ${baseline.appliedFiles} 个文件 · ${Math.round(baseline.durationMs / 1000)}s`);
    }
  }

  const agentRows = results.map((r) => r.agent);
  const baselineRows = results.filter((r) => r.baseline).map((r) => r.baseline);
  const sum = (arr, pick) => arr.reduce((s, r) => s + (pick(r) || 0), 0);

  const report = {
    meta: {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      project: 'agent-harness-lab',
      version: '0.1.0',
      model: providerFactory().model,
      taskIds: tasks.map((t) => t.id),
      includeBaseline,
      maxSteps,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
    tasks: results,
    summary: {
      tasks: results.length,
      agent: {
        successRate: rate(agentRows.filter((r) => r.pass).length, agentRows.length),
        passed: agentRows.filter((r) => r.pass).length,
        avgSteps: mean(agentRows.map((r) => r.steps)),
        totalPromptTokens: sum(agentRows, (r) => r.tokens && r.tokens.prompt),
        totalCompletionTokens: sum(agentRows, (r) => r.tokens && r.tokens.completion),
        totalCachedTokens: sum(agentRows, (r) => r.tokens && r.tokens.cached),
        avgBlockedCalls: mean(agentRows.map((r) => r.blockedCalls)),
        avgInvalidCalls: mean(agentRows.map((r) => r.invalidCalls)),
        stopReasons: countBy(agentRows.map((r) => r.stopReason)),
      },
      baseline: baselineRows.length
        ? {
            successRate: rate(baselineRows.filter((r) => r.pass).length, baselineRows.length),
            passed: baselineRows.filter((r) => r.pass).length,
            avgAppliedFiles: mean(baselineRows.map((r) => r.appliedFiles)),
            totalPromptTokens: sum(baselineRows, (r) => r.tokens && r.tokens.prompt),
            totalCompletionTokens: sum(baselineRows, (r) => r.tokens && r.tokens.completion),
          }
        : null,
    },
  };

  fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'report.md'), renderMarkdown(report), 'utf8');
  log(`\n报告已写入：bench/results/${runId}/report.json 与 report.md`);
  log(`Agent 通过率：${report.summary.agent.successRate}`);
  if (report.summary.baseline) {
    log(`基线通过率：${report.summary.baseline.successRate}`);
  }

  return { report, runDir };
}

/**
 * 把报告渲染成人可读的 Markdown（README 与正式报告引用的数字出处）。
 */
export function renderMarkdown(report) {
  const lines = [];
  const { meta, tasks, summary } = report;

  lines.push(`# agent-harness-lab 评测报告`);
  lines.push('');
  lines.push(`- 运行：${meta.runId}`);
  lines.push(`- 时间：${meta.startedAt} → ${meta.finishedAt}`);
  lines.push(`- 模型：${meta.model}`);
  lines.push(`- 环境：Node ${meta.environment.node}，${meta.environment.platform} ${meta.environment.arch}，时区 ${meta.environment.timezone}`);
  lines.push(`- 版本：${meta.version}，最大步数 ${meta.maxSteps}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | Agent | 单发基线 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 任务通过率 | ${summary.agent.successRate} | ${summary.baseline ? summary.baseline.successRate : '—'} |`);
  lines.push(`| 平均步数 | ${summary.agent.avgSteps ?? '—'} | 1（固定） |`);
  lines.push(`| prompt token | ${summary.agent.totalPromptTokens} | ${summary.baseline ? summary.baseline.totalPromptTokens : '—'} |`);
  lines.push(`| completion token | ${summary.agent.totalCompletionTokens} | ${summary.baseline ? summary.baseline.totalCompletionTokens : '—'} |`);
  lines.push(`| 缓存命中 token | ${summary.agent.totalCachedTokens} | — |`);
  lines.push(`| 平均越权拦截/任务 | ${summary.agent.avgBlockedCalls ?? '—'} | — |`);
  lines.push(`| 平均非法调用/任务 | ${summary.agent.avgInvalidCalls ?? '—'} | — |`);
  lines.push('');
  lines.push('### 结束原因分布（Agent）');
  lines.push('');
  for (const [reason, count] of Object.entries(summary.agent.stopReasons)) {
    lines.push(`- ${reason}：${count}`);
  }
  lines.push('');
  lines.push('## 逐任务明细');
  lines.push('');
  lines.push('| 任务 | 难度 | Agent | 步数 | 结束原因 | token（↑缓存/↓输出） | 基线 | 基线应用文件 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of tasks) {
    const a = row.agent;
    const b = row.baseline;
    const aTok = a.tokens ? `${a.tokens.prompt}（缓存${a.tokens.cached}）/${a.tokens.completion}` : '—';
    lines.push(
      `| ${row.task.id} ${row.task.title} | ${row.task.difficulty} | ${a.pass ? '✅' : '❌'} | ${a.steps} | ${a.stopReason} | ${aTok} | ${b ? (b.pass ? '✅' : '❌') : '—'} | ${b ? b.appliedFiles : '—'} |`,
    );
  }
  lines.push('');
  lines.push('## 可复现性');
  lines.push('');
  lines.push(`- 报告 JSON：\`bench/results/${meta.runId}/report.json\``);
  lines.push(`- 每个任务的 Agent 轨迹：\`bench/results/${meta.runId}/traces/*.jsonl\``);
  lines.push('- 评测集与评分器冻结于本仓库 `bench/tasks/`，判分逻辑对 Agent 不可见、不可修改。');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 工具函数

function rate(pass, total) {
  if (!total) return null;
  return `${pass}/${total} = ${((pass / total) * 100).toFixed(1)}%`;
}

function mean(values) {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!nums.length) return null;
  return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
}

function countBy(items) {
  return items.reduce((acc, item) => {
    const key = String(item ?? 'null');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function fmtTokens(tokens) {
  if (!tokens) return '0 tok';
  return `${tokens.prompt}↑/${tokens.completion}↓ tok（缓存 ${tokens.cached}）`;
}

function tail(text, lines = 20) {
  return String(text || '').split('\n').slice(-lines).join('\n');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`「${label}」超时（${Math.round(ms / 1000)}s），已中止`)), ms).unref?.(),
    ),
  ]);
}
