import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ToolBox,
  ToolError,
  validateToolCall,
  isInside,
  clip,
  TOOL_SCHEMAS,
  TOOL_NAMES,
  DEFAULT_ALLOWED_COMMANDS,
} from '../src/tools.js';

/** 造一个隔离的沙箱：root 里放几个文件，外面放一个"机密"文件用于验证越权被挡。 */
function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-tools-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\nconst secret = 42;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'readme.md'), '# 标题\nhello world\n', 'utf8');
  fs.writeFileSync(path.join(outside, 'secret.txt'), '这是工作区外的机密内容', 'utf8');

  return { base, root, outside };
}

function makeBox(root, overrides = {}) {
  return new ToolBox({ root, ...overrides });
}

// ---------------------------------------------------------------- 路径沙箱

test('resolvePath：正常相对路径解析为工作区内的绝对路径', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const resolved = await box.resolvePath('src/a.js', { mustExist: true });
  assert.equal(resolved, path.join(root, 'src', 'a.js'));
});

test('resolvePath：拒绝 ../ 越权路径', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  for (const bad of ['../outside/secret.txt', 'src/../../outside/secret.txt', '..', '../../']) {
    await assert.rejects(
      () => box.resolvePath(bad),
      (err) => err instanceof ToolError && err.code === 'PATH_ESCAPE',
      `应拒绝 ${bad}`,
    );
  }
});

test('resolvePath：拒绝绝对路径（Windows 盘符与 POSIX 都拒）', async () => {
  const { root, outside } = makeSandbox();
  const box = makeBox(root);
  await assert.rejects(() => box.resolvePath(path.join(outside, 'secret.txt')), /绝对路径/);
  await assert.rejects(() => box.resolvePath('C:\\Windows\\System32\\drivers\\etc\\hosts'), /绝对路径/);
  await assert.rejects(() => box.resolvePath('/etc/passwd'), /绝对路径/);
});

test('resolvePath：拒绝空路径与含空字节的路径', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  await assert.rejects(() => box.resolvePath(''), /不能为空/);
  await assert.rejects(() => box.resolvePath('   '), /不能为空/);
  await assert.rejects(() => box.resolvePath('a\0b'), /空字节/);
});

test('resolvePath：符号链接指向工作区外时必须被挡住（只查字符串前缀会漏掉这种）', async (t) => {
  const { root, outside } = makeSandbox();
  const link = path.join(root, 'link-to-outside');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    t.skip('当前环境不允许创建符号链接，跳过该项');
    return;
  }

  const box = makeBox(root);
  await assert.rejects(
    () => box.resolvePath('link-to-outside/secret.txt', { mustExist: true }),
    (err) => err instanceof ToolError && err.code === 'PATH_ESCAPE',
    '经符号链接读取工作区外文件必须被拒绝',
  );

  // 读整个工具也要被挡住，不能只在 resolvePath 层面拦
  const res = await box.execute({ name: 'read_file', args: { path: 'link-to-outside/secret.txt' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PATH_ESCAPE');
  assert.equal(box.stats.blocked >= 1, true);
});

test('resolvePath：目标不存在但祖先目录在工作区内时允许（写入新文件场景）', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const target = await box.resolvePath('new/deep/file.txt');
  assert.equal(target, path.join(root, 'new', 'deep', 'file.txt'));
});

test('isInside：边界判断正确（自身算在内，前缀相似的兄弟目录不算在内）', () => {
  const root = path.resolve('/tmp/root');
  assert.equal(isInside(root, path.join(root, 'a.js')), true);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.resolve('/tmp/root2/a.js')), false);
  assert.equal(isInside(root, path.resolve('/tmp/other')), false);
});

// ---------------------------------------------------------------- schema 校验

test('validateToolCall：未知工具、缺必填参数、多余参数、类型错误都能识别', () => {
  assert.equal(validateToolCall({ name: 'read_file', args: { path: 'a.js' } }).ok, true);
  assert.equal(validateToolCall({ name: 'list_files', args: {} }).ok, true, '无必填参数的工具可空参调用');

  const unknown = validateToolCall({ name: 'rm_rf', args: {} });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知工具/);

  const missing = validateToolCall({ name: 'read_file', args: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /缺少必填参数「path」/);

  const extra = validateToolCall({ name: 'read_file', args: { path: 'a', typo: 1 } });
  assert.equal(extra.ok, false);
  assert.match(extra.error, /不支持参数「typo」/);

  const wrongType = validateToolCall({ name: 'read_file', args: { path: 'a', start_line: '1' } });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /类型应为 integer/);

  const notObject = validateToolCall({ name: 'read_file', args: [1, 2] });
  assert.equal(notObject.ok, false);
  assert.match(notObject.error, /必须是 JSON 对象/);
});

test('validateToolCall：整数与数字类型互通，但小数不能当整数', () => {
  assert.equal(validateToolCall({ name: 'read_file', args: { path: 'a', start_line: 2 } }).ok, true);
  assert.equal(validateToolCall({ name: 'read_file', args: { path: 'a', start_line: 2.5 } }).ok, false);
});

// ---------------------------------------------------------------- 工具行为

test('list_files：递归列出文件、跳过 node_modules 与 .git、支持 pattern 过滤', async () => {
  const { root } = makeSandbox();
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), '', 'utf8');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '', 'utf8');

  const box = makeBox(root);
  const all = await box.execute({ name: 'list_files', args: {} });
  assert.equal(all.ok, true);
  assert.deepEqual(all.result.files.sort(), ['readme.md', 'src/a.js']);
  assert.equal(all.result.truncated, false);

  const filtered = await box.execute({ name: 'list_files', args: { pattern: '.js' } });
  assert.deepEqual(filtered.result.files, ['src/a.js']);
});

test('read_file：返回带行号内容与总行数，支持行区间', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);

  const full = await box.execute({ name: 'read_file', args: { path: 'src/a.js' } });
  assert.equal(full.ok, true);
  assert.equal(full.result.total_lines, 3);
  assert.match(full.result.content, /1\| export const a = 1;/);

  const range = await box.execute({ name: 'read_file', args: { path: 'src/a.js', start_line: 2, end_line: 2 } });
  assert.match(range.result.content, /2\| const secret = 42;/);
  assert.doesNotMatch(range.result.content, /export const a/);
  assert.equal(range.result.start_line, 2);
  assert.equal(range.result.end_line, 2);
});

test('read_file：读目录给出可操作提示，超出大小上限明确拒绝', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);

  const dir = await box.execute({ name: 'read_file', args: { path: 'src' } });
  assert.equal(dir.ok, false);
  assert.equal(dir.code, 'IS_A_DIR');
  assert.match(dir.error, /list_files/);

  const small = makeBox(root, { limits: { maxFileBytes: 5 } });
  const big = await small.execute({ name: 'read_file', args: { path: 'src/a.js' } });
  assert.equal(big.ok, false);
  assert.equal(big.code, 'TOO_LARGE');
  assert.match(big.error, /start_line/);
});

test('read_file：行区间不合法时报错而不是返回空', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const res = await box.execute({ name: 'read_file', args: { path: 'src/a.js', start_line: 5, end_line: 2 } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BAD_RANGE');
});

test('write_file：自动创建父目录并返回字节数与行数', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const res = await box.execute({ name: 'write_file', args: { path: 'out/deep/new.txt', content: '第一行\n第二行\n' } });
  assert.equal(res.ok, true);
  assert.equal(res.result.bytes, Buffer.byteLength('第一行\n第二行\n', 'utf8'));
  assert.equal(res.result.lines, 3);
  assert.equal(fs.readFileSync(path.join(root, 'out', 'deep', 'new.txt'), 'utf8'), '第一行\n第二行\n');
});

test('write_file：拒绝写到工作区之外', async () => {
  const { root, outside } = makeSandbox();
  const box = makeBox(root);
  const res = await box.execute({ name: 'write_file', args: { path: '../outside/hacked.txt', content: 'x' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PATH_ESCAPE');
  assert.equal(fs.existsSync(path.join(outside, 'hacked.txt')), false, '越权写入不能真的发生');
});

test('edit_file：精确替换唯一字符串并返回改动行号', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const res = await box.execute({
    name: 'edit_file',
    args: { path: 'src/a.js', old_string: 'const secret = 42;', new_string: 'const secret = 43;' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.changed_line, 2);
  assert.match(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), /const secret = 43;/);
});

test('edit_file：找不到原文、出现多次、空 old_string 三种情况都拒绝并说明原因', async () => {
  const { root } = makeSandbox();
  fs.writeFileSync(path.join(root, 'dup.txt'), 'same\nsame\n', 'utf8');
  const box = makeBox(root);

  const noMatch = await box.execute({ name: 'edit_file', args: { path: 'readme.md', old_string: '不存在的内容', new_string: 'x' } });
  assert.equal(noMatch.ok, false);
  assert.equal(noMatch.code, 'NO_MATCH');

  const ambiguous = await box.execute({ name: 'edit_file', args: { path: 'dup.txt', old_string: 'same', new_string: 'x' } });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS');

  const empty = await box.execute({ name: 'edit_file', args: { path: 'readme.md', old_string: '', new_string: 'x' } });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'BAD_ARGS');
});

test('search_text：正则搜索返回文件与行号，非法正则报错', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);

  const hit = await box.execute({ name: 'search_text', args: { pattern: 'secret\\s*=\\s*\\d+' } });
  assert.equal(hit.ok, true);
  assert.equal(hit.result.matches.length, 1);
  assert.equal(hit.result.matches[0].file, 'src/a.js');
  assert.equal(hit.result.matches[0].line, 2);

  const bad = await box.execute({ name: 'search_text', args: { pattern: '([' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_REGEX');
});

test('search_text：同一文件多行分别匹配，不会因正则状态残留而漏匹配', async () => {
  const { root } = makeSandbox();
  fs.writeFileSync(path.join(root, 'many.txt'), 'hit one\nmiss\nhit two\n', 'utf8');
  const box = makeBox(root);
  const res = await box.execute({ name: 'search_text', args: { pattern: 'hit' } });
  assert.equal(res.ok, true);
  assert.equal(res.result.matches.length, 2, '同一文件的第 1 行与第 3 行都应命中');
  assert.deepEqual(
    res.result.matches.map((m) => m.line),
    [1, 3],
  );
});

test('search_text：正则里自带 ^ 锚点只匹配行首（按行扫描的正确语义）', async () => {
  const { root } = makeSandbox();
  fs.writeFileSync(path.join(root, 'anchor.txt'), 'start here\nthe start is later\n', 'utf8');
  const box = makeBox(root);
  const res = await box.execute({ name: 'search_text', args: { pattern: '^start' } });
  assert.equal(res.ok, true);
  assert.equal(res.result.matches.length, 1);
  assert.equal(res.result.matches[0].line, 1);
});

// ---------------------------------------------------------------- 命令执行安全

test('run_command：拒绝白名单外的命令（尤其不能调用 shell 本身）', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  for (const cmd of ['powershell', 'cmd', 'bash', 'sh', 'rm', 'curl', 'del']) {
    const res = await box.execute({ name: 'run_command', args: { command: cmd, args: ['-c', 'echo hi'] } });
    assert.equal(res.ok, false, `${cmd} 应被拒绝`);
    assert.equal(res.code, 'COMMAND_NOT_ALLOWED');
  }
  assert.ok(DEFAULT_ALLOWED_COMMANDS.includes('node'));
  assert.equal(DEFAULT_ALLOWED_COMMANDS.includes('bash'), false);
});

test('run_command：拒绝危险的 git 子命令', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  for (const sub of ['push', 'reset', 'clean', 'remote', 'filter-branch']) {
    const res = await box.execute({ name: 'run_command', args: { command: 'git', args: [sub] } });
    assert.equal(res.ok, false, `git ${sub} 应被拒绝`);
    assert.equal(res.code, 'COMMAND_FORBIDDEN');
  }
});

test('run_command：参数中的 shell 元字符不会被执行（不走 shell 的直接证据）', async () => {
  const { root, outside } = makeSandbox();
  const box = makeBox(root);
  const canary = path.join(outside, 'pwned.txt');

  // node -e 里的 JS 确实会执行；重点是外面的 shell 不能先解释这些字符。
  // 如果实现走了 shell，`&` 之后的 touch 命令会真的运行。
  const res = await box.execute({
    name: 'run_command',
    args: { command: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(canary)}, 'x') & echo ok`] },
  });

  assert.equal(fs.existsSync(canary), false, 'shell 元字符必须原样作为参数传入，不能被 shell 解释');
  // node 自身会因语法错误或正常执行结束，总之不应是"命令未找到"这类外壳错误
  assert.notEqual(res.code, 'COMMAND_NOT_ALLOWED');
});

test('run_command：正常命令返回退出码与输出，工作目录被限制在沙箱内', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const res = await box.execute({
    name: 'run_command',
    args: { command: 'node', args: ['-e', 'console.log(process.cwd()); console.log(1+1)'] },
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.exit_code, 0);
  assert.match(res.result.stdout, new RegExp(escapeRegExp(root)));
  assert.match(res.result.stdout, /2/);
});

test('run_command：非零退出码如实返回，而不是抛异常', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const res = await box.execute({ name: 'run_command', args: { command: 'node', args: ['-e', 'process.exit(3)'] } });
  assert.equal(res.ok, true, '工具本身执行成功');
  assert.equal(res.result.exit_code, 3, '退出码要如实反映');
});

test('run_command：超时会终止进程并标记 timed_out', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root, { limits: { commandTimeoutMs: 400 } });
  const res = await box.execute({
    name: 'run_command',
    args: { command: 'node', args: ['-e', 'setTimeout(()=>{}, 10000)'] },
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.timed_out, true);
});

// ---------------------------------------------------------------- 输出截断与统计

test('clip：超长输出被截断且显式标注', () => {
  const short = clip('abc', 10);
  assert.deepEqual(short, { text: 'abc', truncated: false });

  const long = clip('x'.repeat(100), 10);
  assert.equal(long.truncated, true);
  assert.match(long.text, /输出被截断/);
  assert.match(long.text, /共 100 字符/);
});

test('read_file：内容超长时按整行截断，并给出"从第几行继续"的可操作提示', async () => {
  const { root } = makeSandbox();
  fs.writeFileSync(path.join(root, 'long.txt'), Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 行内容`).join('\n'), 'utf8');
  const box = makeBox(root, { limits: { maxOutputChars: 120 } });

  // 整读会被截断，但必须留下可继续的线索
  const whole = await box.execute({ name: 'read_file', args: { path: 'long.txt' } });
  assert.equal(whole.ok, true);
  assert.equal(whole.result.truncated, true);
  assert.equal(whole.result.total_lines, 300, '即使截断也要告知总行数，模型才知道要分段');
  assert.match(whole.result.content, /继续读取/, '截断提示里要给出下一步动作');
  assert.ok(whole.result.end_line < 300, '截断时 end_line 应反映真实显示到的行');
  assert.ok(
    whole.result.content.length < 400,
    `截断后的内容不能明显超限，实际 ${whole.result.content.length} 字符`,
  );
  assert.equal(box.stats.truncated, 1, '截断次数要计入统计（这个数字会进评测报告）');

  // 缩小到窗口能一次读完，不被截断
  const part = await box.execute({ name: 'read_file', args: { path: 'long.txt', start_line: 100, end_line: 103 } });
  assert.equal(part.result.truncated, false, '窗口够小时应完整返回');
  assert.equal(part.result.start_line, 100);
  assert.equal(part.result.end_line, 103);
  assert.match(part.result.content, /100\| 第 100 行内容/);
  assert.match(part.result.content, /103\| 第 103 行内容/);

  // 末尾行也读得到
  const tail = await box.execute({ name: 'read_file', args: { path: 'long.txt', start_line: 299, end_line: 300 } });
  assert.match(tail.result.content, /300\| 第 300 行内容/);
});

test('execute：未知工具与参数错误都以失败结果返回，不抛异常', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);

  const unknown = await box.execute({ name: 'nope', args: {} });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'INVALID_ARGS');

  const badArgs = await box.execute({ name: 'read_file', args: {} });
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.code, 'INVALID_ARGS');

  assert.equal(box.stats.calls, 2);
  assert.equal(box.stats.failures, 2);
});

test('execute：每次调用都带耗时，logger 能收到事件', async () => {
  const { root } = makeSandbox();
  const seen = [];
  const box = makeBox(root, { logger: (ev) => seen.push(ev) });
  const res = await box.execute({ name: 'list_files', args: {} });
  assert.equal(typeof res.durationMs, 'number');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'list_files');
  assert.equal(seen[0].ok, true);
});

test('finish：返回 summary 供循环判定任务结束', async () => {
  const { root } = makeSandbox();
  const box = makeBox(root);
  const res = await box.execute({ name: 'finish', args: { summary: '已完成' } });
  assert.equal(res.ok, true);
  assert.equal(res.result.summary, '已完成');
});

test('工具声明：名称唯一，且每个都有描述与 parameters', () => {
  const names = TOOL_SCHEMAS.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length, '工具名不能重复');
  for (const t of TOOL_SCHEMAS) {
    assert.equal(typeof t.function.description, 'string');
    assert.ok(t.function.description.length > 5, `${t.function.name} 的描述太短，模型会不知道怎么用`);
    assert.equal(t.function.parameters.type, 'object');
    assert.equal(t.function.parameters.additionalProperties, false, '应禁止额外参数');
  }
  assert.deepEqual(TOOL_NAMES, names);
});

test('ToolBox：缺少 root 时直接报错', () => {
  assert.throws(() => new ToolBox({}), /root/);
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
