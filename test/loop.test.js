import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, FaultInjector, DEFAULT_LOOP_LIMITS } from '../src/loop.js';
import { ToolBox } from '../src/tools.js';
import { Provider } from '../src/provider.js';
import { Trace } from '../src/trace.js';
import { buildFixtureFromTurns, createReplayFetch } from '../src/recorder.js';

/** 造一个隔离工作区。 */
function makeWorkspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-loop-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

/**
 * 用录制的轮次造一个 Provider。
 * turns 的每一项对应循环里的一次模型调用。
 */
function providerFromTurns(turns, opts = {}) {
  const fixture = buildFixtureFromTurns(turns, { splitEvery: opts.splitEvery ?? 0 });
  return new Provider({
    baseURL: 'https://api.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    fetchImpl: createReplayFetch(fixture, { onRequest: opts.onRequest }),
    maxRetries: 0,
    sleepImpl: async () => {},
  });
}

function quietTrace() {
  return new Trace({ file: null, echo: false });
}

test('runAgent：模型直接调用 finish，一步结束且 ok=true', async () => {
  const root = makeWorkspace();
  const provider = providerFromTurns([
    {
      toolCalls: [{ name: 'finish', args: { summary: '任务已完成' } }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
  ]);

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '随便做点什么然后结束',
    trace: quietTrace(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.stopReason, 'finished');
  assert.equal(res.answer, '任务已完成');
  assert.equal(res.steps, 1);
  assert.equal(res.tokenTotals.prompt, 100);
  assert.equal(res.tokenTotals.completion, 20);
});

test('runAgent：多步任务（读文件 → 改文件 → 跑验证 → finish）', async () => {
  const root = makeWorkspace({ 'a.js': 'const x = 1;\n' });

  const provider = providerFromTurns([
    { toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }], finishReason: 'tool_calls' },
    {
      toolCalls: [{ name: 'edit_file', args: { path: 'a.js', old_string: 'const x = 1;', new_string: 'const x = 2;' } }],
      finishReason: 'tool_calls',
    },
    { toolCalls: [{ name: 'run_command', args: { command: 'node', args: ['-e', 'console.log(require("fs").readFileSync("a.js","utf8"))'] } }], finishReason: 'tool_calls' },
    { toolCalls: [{ name: 'finish', args: { summary: '已把 x 改成 2 并验证' } }], finishReason: 'tool_calls' },
  ]);

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '把 a.js 里的 x 改成 2',
    trace: quietTrace(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.stopReason, 'finished');
  assert.equal(res.steps, 4);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'const x = 2;\n', '真实文件被改动了');
});

test('runAgent：工具返回 PATH_ESCAPE 时不算崩溃，计入 blockedCalls 并把错误回灌给模型', async () => {
  const root = makeWorkspace();
  let sawToolMessage = null;

  const provider = providerFromTurns(
    [
      { toolCalls: [{ name: 'read_file', args: { path: '../../etc/passwd' } }], finishReason: 'tool_calls' },
      { toolCalls: [{ name: 'finish', args: { summary: '越权被拒后放弃' } }], finishReason: 'tool_calls' },
    ],
    {
      onRequest: (body) => {
        sawToolMessage = body.messages.find((m) => m.role === 'tool');
      },
    },
  );

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '读一个越权文件',
    trace: quietTrace(),
  });

  assert.equal(res.ok, true);
  assert.equal(res.blockedCalls, 1, '越权调用应被统计');
  assert.ok(sawToolMessage, '工具错误必须作为 tool 消息回灌给模型');
  assert.match(sawToolMessage.content, /PATH_ESCAPE|越出工作区/);
});

test('runAgent：参数不是合法 JSON 的调用被隔离，循环继续且 invalidCalls 计数正确', async () => {
  const root = makeWorkspace({ 'a.js': 'ok\n' });

  const provider = providerFromTurns([
    { toolCalls: [{ name: 'read_file', argsRaw: '{"path":"a.' }], finishReason: 'tool_calls' },
    { toolCalls: [{ name: 'finish', args: { summary: '修好了参数' } }], finishReason: 'tool_calls' },
  ]);

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '读 a.js',
    trace: quietTrace(),
  });

  assert.equal(res.invalidCalls, 1);
  assert.equal(res.ok, true);
  assert.equal(res.stopReason, 'finished');
});

test('runAgent：无效调用也要进 assistant.tool_calls 并有对应 tool 响应（t6 400 回归）', async () => {
  const root = makeWorkspace({ 'a.js': 'ok\n' });
  const requests = [];

  const provider = providerFromTurns(
    [
      {
        // 同一批里一个合法调用 + 一个坏 JSON 调用（带真实 id）
        toolCalls: [
          { name: 'read_file', args: { path: 'a.js' } },
          { name: 'read_file', argsRaw: '{"path":"a.js' },
        ],
        finishReason: 'tool_calls',
      },
      { toolCalls: [{ name: 'finish', args: { summary: '完成' } }], finishReason: 'tool_calls' },
    ],
    { onRequest: (body) => requests.push(body) },
  );

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '读 a.js 然后结束',
    trace: quietTrace(),
  });

  assert.equal(res.invalidCalls, 1);
  assert.equal(res.ok, true);

  // 第二次请求（坏调用之后的下一轮）必须符合协议：assistant 的每个 tool_call 都有 tool 响应
  const second = requests[1];
  assert.ok(second, '应有第二次请求');
  const assistant = second.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(assistant, '第二次请求应包含带 tool_calls 的 assistant 消息');
  const ids = assistant.tool_calls.map((t) => t.id);
  assert.ok(ids.includes('call_0_0'), '合法调用的 id 应在 tool_calls 里');
  assert.ok(ids.includes('call_0_1'), '无效调用的 id 也必须在 tool_calls 里（否则孤儿 tool 消息 → 400）');

  const toolIds = second.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  for (const id of ids) {
    assert.ok(toolIds.includes(id), `tool_call ${id} 必须有对应 tool 响应`);
  }
  // 无效调用的回灌内容必须是错误反馈
  const badResponse = second.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_0_1');
  assert.match(badResponse.content, /INVALID_ARGS_JSON/);
});

test('runAgent：同一个调用重复达到上限时主动打断，避免无限烧 token', async () => {
  const root = makeWorkspace({ 'a.js': 'x\n' });
  const repeated = { toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }], finishReason: 'tool_calls' };

  const provider = providerFromTurns([repeated, repeated, repeated, repeated, repeated]);

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '一直读同一个文件',
    limits: { maxRepeatedCalls: 3, maxSteps: 10 },
    trace: quietTrace(),
  });

  assert.equal(res.ok, false);
  assert.equal(res.stopReason, 'repeated_call');
  assert.match(res.repeatedCallBreak, /read_file/);
  assert.equal(res.steps, 3, '第 3 次重复时就应打断');
});

test('runAgent：达到步数上限时以 max_steps 结束，不抛异常', async () => {
  const root = makeWorkspace({ 'a.js': 'x\n' });
  const turns = Array.from({ length: 4 }, (_, i) => ({
    toolCalls: [{ name: 'list_files', args: { pattern: `nothing-${i}` } }],
    finishReason: 'tool_calls',
  }));

  const res = await runAgent({
    provider: providerFromTurns(turns),
    toolbox: new ToolBox({ root }),
    task: '空转到上限',
    limits: { maxSteps: 2 },
    trace: quietTrace(),
  });

  assert.equal(res.ok, false);
  assert.equal(res.stopReason, 'max_steps');
  assert.equal(res.steps, 2);
});

test('runAgent：模型只回文本不调工具时，如实标记 answered_without_finish', async () => {
  const root = makeWorkspace();
  const provider = providerFromTurns([{ content: '我觉得已经好了。', finishReason: 'stop' }]);

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '做点事',
    trace: quietTrace(),
  });

  assert.equal(res.ok, false, '没有调用 finish 不能算完成');
  assert.equal(res.stopReason, 'answered_without_finish');
  assert.match(res.answer, /我觉得已经好了/);
});

test('runAgent：既无内容也无工具调用时提示模型继续，而不是空转结束', async () => {
  const root = makeWorkspace({ 'a.js': 'x\n' });
  const provider = providerFromTurns([
    { content: '', finishReason: 'stop' },
    { toolCalls: [{ name: 'finish', args: { summary: '第二次才给出结论' } }], finishReason: 'tool_calls' },
  ]);

  let secondRequestHadNudge = false;
  const root2 = root;
  const p2 = providerFromTurns(
    [
      { content: '', finishReason: 'stop' },
      { toolCalls: [{ name: 'finish', args: { summary: 'ok' } }], finishReason: 'tool_calls' },
    ],
    {
      onRequest: (body) => {
        if (body.messages.some((m) => typeof m.content === 'string' && m.content.includes('没有返回任何内容'))) {
          secondRequestHadNudge = true;
        }
      },
    },
  );

  const res = await runAgent({ provider: p2, toolbox: new ToolBox({ root: root2 }), task: 't', trace: quietTrace() });
  assert.equal(res.ok, true);
  assert.equal(secondRequestHadNudge, true, '应插入一条提示模型继续的消息');
  assert.ok(provider);
});

test('runAgent：provider 硬失败时返回 provider_error，不把异常抛穿', async () => {
  const root = makeWorkspace();
  const failing = {
    model: 'test-model',
    chat: async () => {
      const e = new Error('HTTP 401：鉴权失败');
      e.status = 401;
      throw e;
    },
  };

  const res = await runAgent({
    provider: failing,
    toolbox: new ToolBox({ root }),
    task: 't',
    trace: quietTrace(),
  });

  assert.equal(res.ok, false);
  assert.equal(res.stopReason, 'provider_error');
  assert.match(res.error, /401/);
});

test('runAgent：并行工具调用按调用顺序回灌结果（协议要求顺序一致）', async () => {
  const root = makeWorkspace({ 'a.txt': 'A', 'b.txt': 'B' });
  let toolMessages = [];

  const provider = providerFromTurns(
    [
      {
        toolCalls: [
          { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'call_2', name: 'read_file', args: { path: 'b.txt' } },
        ],
        finishReason: 'tool_calls',
      },
      { toolCalls: [{ name: 'finish', args: { summary: 'done' } }], finishReason: 'tool_calls' },
    ],
    {
      onRequest: (body) => {
        toolMessages = body.messages.filter((m) => m.role === 'tool');
      },
    },
  );

  const res = await runAgent({ provider, toolbox: new ToolBox({ root }), task: '读两个文件', trace: quietTrace() });

  assert.equal(res.ok, true);
  assert.equal(res.steps, 2);
  // 第二次请求里应包含按顺序排列的两条 tool 消息
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0].tool_call_id, 'call_1');
  assert.equal(toolMessages[1].tool_call_id, 'call_2');
  assert.match(toolMessages[0].content, /A/);
  assert.match(toolMessages[1].content, /B/);
});

test('runAgent：并行调用超过上限时，被截掉的调用也必须有结果（否则历史非法）', async () => {
  const root = makeWorkspace({ 'a.txt': 'A' });
  let toolMessages = [];

  const provider = providerFromTurns(
    [
      {
        toolCalls: [
          { id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'c2', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'c3', name: 'read_file', args: { path: 'a.txt' } },
        ],
        finishReason: 'tool_calls',
      },
      { toolCalls: [{ name: 'finish', args: { summary: 'done' } }], finishReason: 'tool_calls' },
    ],
    {
      onRequest: (body) => {
        toolMessages = body.messages.filter((m) => m.role === 'tool');
      },
    },
  );

  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '一次读三个',
    limits: { maxParallelTools: 2 },
    trace: quietTrace(),
  });

  assert.equal(res.ok, true);
  assert.equal(toolMessages.length, 3, '每个 tool_call 都要有对应结果');
  assert.match(toolMessages[2].content, /TOO_MANY_PARALLEL/);
  assert.equal(res.blockedCalls >= 1, true);
});

// ------------------------------------------------------------------ 故障注入

test('FaultInjector：按计划在前 N 次注入失败，之后放行', () => {
  const inj = new FaultInjector({ run_command: { failTimes: 2, message: '模拟命令偶发失败' } });
  assert.equal(inj.check('run_command').fail, true);
  assert.equal(inj.check('run_command').fail, true);
  assert.equal(inj.check('run_command'), null, '第 3 次应放行');
  assert.equal(inj.check('read_file'), null, '未配置的工具不受影响');
  assert.equal(inj.injected, 2);
});

test('runAgent：工具被注入故障后模型改换策略并完成 → 恢复成功', async () => {
  const root = makeWorkspace({ 'a.js': 'const v = 1;\n' });

  // 第 1 步：用 run_command 验证（被注入失败）；第 2 步：改用 read_file 绕开；第 3 步 finish
  const provider = providerFromTurns([
    { toolCalls: [{ name: 'run_command', args: { command: 'node', args: ['-e', 'process.exit(1)'] } }], finishReason: 'tool_calls' },
    { toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }], finishReason: 'tool_calls' },
    { toolCalls: [{ name: 'finish', args: { summary: '改用读文件确认，恢复成功' } }], finishReason: 'tool_calls' },
  ]);

  const injector = new FaultInjector({ run_command: { failTimes: 1, message: '模拟临时故障' } });
  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '确认 a.js 的内容',
    faultInjector: injector,
    trace: quietTrace(),
  });

  assert.equal(res.ok, true, '注入故障后仍应完成任务');
  assert.equal(res.stopReason, 'finished');
  assert.equal(injector.injected, 1);
  assert.equal(res.steps, 3);
});

test('runAgent：注入故障后模型无法恢复 → 任务失败（恢复率的分母）', async () => {
  const root = makeWorkspace({ 'a.js': 'x\n' });
  const provider = providerFromTurns([
    { toolCalls: [{ name: 'run_command', args: { command: 'node', args: ['-e', '0'] } }], finishReason: 'tool_calls' },
    { content: '我放弃了。', finishReason: 'stop' },
  ]);

  const injector = new FaultInjector({ run_command: { failTimes: 5 } });
  const res = await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: '跑个命令',
    faultInjector: injector,
    trace: quietTrace(),
  });

  assert.equal(res.ok, false);
  assert.equal(res.stopReason, 'answered_without_finish');
});

// ------------------------------------------------------------------ 轨迹与统计

test('runAgent：trace 记录每一步的模型调用与工具调用，summary 统计 token', async () => {
  const root = makeWorkspace({ 'a.js': 'x\n' });
  const trace = quietTrace();

  const provider = providerFromTurns([
    {
      toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 20 },
    },
    {
      toolCalls: [{ name: 'finish', args: { summary: 'ok' } }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 60, completion_tokens: 8, prompt_cache_hit_tokens: 30 },
    },
  ]);

  const res = await runAgent({ provider, toolbox: new ToolBox({ root }), task: 't', trace });

  const types = trace.events.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'llm.step').length, 2);
  assert.equal(types.filter((t) => t === 'tool.step').length, 2);
  assert.equal(types.includes('run.finish'), true);

  assert.equal(res.summary.llmSteps, 2);
  assert.equal(res.summary.toolSteps, 2);
  assert.equal(res.summary.promptTokens, 110);
  assert.equal(res.summary.completionTokens, 18);
  assert.equal(res.summary.cachedTokens, 50);
});

test('runAgent：onStep 回调按步触发，便于外部显示进度', async () => {
  const root = makeWorkspace({ 'a.js': 'x\n' });
  const seen = [];
  const provider = providerFromTurns([
    { toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }], finishReason: 'tool_calls' },
    { toolCalls: [{ name: 'finish', args: { summary: 'ok' } }], finishReason: 'tool_calls' },
  ]);

  await runAgent({
    provider,
    toolbox: new ToolBox({ root }),
    task: 't',
    trace: quietTrace(),
    onStep: (info) => seen.push(info.step),
  });

  assert.deepEqual(seen, [1], 'finish 那一步之前会触发一次 onStep');
});

test('DEFAULT_LOOP_LIMITS：默认值合理且被冻结', () => {
  assert.equal(Object.isFrozen(DEFAULT_LOOP_LIMITS), true);
  assert.ok(DEFAULT_LOOP_LIMITS.maxSteps >= 10);
  assert.ok(DEFAULT_LOOP_LIMITS.maxRepeatedCalls >= 2);
});
