/**
 * 工具层：模型想动世界，只能通过这里。
 *
 * 这一层是**安全边界**，不是便利函数集合。三条不可让步的规则：
 *
 * 1. **路径不许越狱。** 模型的输出是不可信输入。`../../.ssh/id_rsa`、绝对路径、
 *    指向外部的符号链接，全部拒绝。校验必须发生在 realpath 之后 —— 只看字符串
 *    前缀会被符号链接绕过。
 *
 * 2. **命令不许过 shell。** 用 execFile + argv 数组，不拼字符串、不走 shell。
 *    这样 `; rm -rf /`、`$(...)`、反引号全部失效，因为根本没有 shell 去解释它们。
 *    另加可执行文件白名单，防止模型直接调 powershell/cmd 把上面的保护绕过去。
 *
 * 3. **输出必须有界。** 模型一条 `cat` 大文件就能把上下文撑爆。所有返回值都截断，
 *    并且**显式告知被截断**——悄悄截断会让模型以为自己看全了。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** 默认允许执行的程序。刻意不含 shell、powershell、cmd —— 否则前两条规则形同虚设。 */
export const DEFAULT_ALLOWED_COMMANDS = Object.freeze([
  'node',
  'npm',
  'npx',
  'python',
  'python3',
  'git',
  'rg',
  'eslint',
  'prettier',
]);

/**
 * 即便在白名单内也禁止的危险子命令。
 * `git push` / `reset --hard` 这类会破坏评测环境或外发数据，评测必须可重复。
 */
const FORBIDDEN_ARG_PATTERNS = Object.freeze([
  { re: /^push$/i, why: '禁止 push：评测环境不允许外发' },
  { re: /^remote$/i, why: '禁止操作 remote' },
  { re: /^--force(-with-lease)?$/i, why: '禁止强推' },
  { re: /^reset$/i, why: '禁止 reset：会破坏评测现场' },
  { re: /^clean$/i, why: '禁止 clean：会删除未跟踪文件' },
  { re: /^filter-branch$/i, why: '禁止改写历史' },
  { re: /^(-c|--config)$/i, why: '禁止通过 -c 注入配置执行外部命令' },
]);

export const DEFAULT_LIMITS = Object.freeze({
  maxOutputChars: 8_000,
  maxFileBytes: 256 * 1024,
  maxListEntries: 500,
  commandTimeoutMs: 20_000,
});

export class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** 工具的 JSON Schema 声明。模型看到的就是这份，执行前的校验也用这份。 */
export const TOOL_SCHEMAS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区内的文件路径（相对路径）。用于了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '相对工作区根目录的子目录，默认根目录' },
          pattern: { type: 'string', description: '可选的子串过滤，只返回路径包含该子串的文件' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区内某个文件的内容，可指定行区间。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的相对路径' },
          start_line: { type: 'integer', description: '起始行（从 1 开始，含）' },
          end_line: { type: 'integer', description: '结束行（含）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入或覆盖一个文件。父目录不存在时会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的相对路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '精确替换文件中的一段文本。old_string 必须在文件中唯一出现，否则报错。用于小改动，避免整文件重写。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的相对路径' },
          old_string: { type: 'string', description: '要被替换的原文，必须唯一' },
          new_string: { type: 'string', description: '替换后的新文本' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '在工作区文件中搜索正则表达式，返回匹配的文件、行号与行内容。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          dir: { type: 'string', description: '相对子目录，默认根目录' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '执行一个白名单内的命令（node/npm/git/python 等）。不经过 shell，因此不支持管道与重定向。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '程序名，必须在白名单内' },
          args: { type: 'array', items: { type: 'string' }, description: '参数数组' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '任务完成时调用，提交最终答复。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '对完成情况的简要说明' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  },
]);

export const TOOL_NAMES = Object.freeze(TOOL_SCHEMAS.map((t) => t.function.name));

/**
 * 校验一次工具调用是否符合 schema。
 *
 * 为什么要在本地校验：模型会给出缺参数、参数名拼错、类型不对的调用。
 * 与其让它带着坏参数进入执行层（然后在文件系统上产生难以排查的副作用），
 * 不如在门口拒掉，并把**具体哪里不对**回给模型让它自我修正。
 *
 * @param {{ name?: string, args?: any }} call
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateToolCall(call) {
  const name = call?.name;
  const schema = TOOL_SCHEMAS.find((t) => t.function.name === name);
  if (!schema) {
    return { ok: false, error: `未知工具「${name}」。可用工具：${TOOL_NAMES.join('、')}` };
  }
  const params = schema.function.parameters;
  const args = call.args;

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: `工具「${name}」的参数必须是 JSON 对象` };
  }
  for (const key of params.required) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return { ok: false, error: `工具「${name}」缺少必填参数「${key}」` };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = params.properties[key];
    if (!spec) {
      return { ok: false, error: `工具「${name}」不支持参数「${key}」，支持：${Object.keys(params.properties).join('、')}` };
    }
    const expected = spec.type;
    const actual = Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
    const ok =
      expected === actual ||
      (expected === 'number' && actual === 'integer') ||
      (expected === 'integer' && actual === 'number' && Number.isInteger(value));
    if (!ok) {
      return { ok: false, error: `工具「${name}」参数「${key}」类型应为 ${expected}，实际是 ${actual}` };
    }
  }
  return { ok: true };
}

/**
 * 工具执行环境。
 */
export class ToolBox {
  /**
   * @param {{
   *   root: string,
   *   allowedCommands?: readonly string[],
   *   limits?: Partial<typeof DEFAULT_LIMITS>,
   *   execImpl?: typeof execFile,
   *   logger?: (ev: { name: string, ok: boolean, durationMs: number, error?: string }) => void,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.root) throw new ToolError('ToolBox 需要 root（工作区根目录）');
    this.root = path.resolve(opts.root);
    this.allowedCommands = opts.allowedCommands || DEFAULT_ALLOWED_COMMANDS;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.execImpl = opts.execImpl || execFile;
    this.logger = opts.logger || null;
    /** 累计统计，供评测报告使用 */
    this.stats = { calls: 0, failures: 0, truncated: 0, blocked: 0 };
  }

  /**
   * 把模型给的相对路径解析为绝对路径，并确保它没有越出工作区。
   *
   * 校验顺序很关键：先按字面判断（挡住明显的 ../ 与绝对路径），
   * 再用 realpath 判断（挡住符号链接绕过）。只做前者是不够的。
   *
   * @param {string} relPath
   * @param {{ mustExist?: boolean }} [opts]
   * @returns {Promise<string>} 绝对路径
   */
  async resolvePath(relPath, opts = {}) {
    const raw = String(relPath ?? '').trim();
    if (!raw) throw new ToolError('路径不能为空', 'BAD_PATH');
    if (raw.includes('\0')) throw new ToolError('路径包含空字节', 'BAD_PATH');

    // Windows 盘符绝对路径与 POSIX 绝对路径一律拒绝：沙箱内只接受相对路径
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
      throw new ToolError(`不允许使用绝对路径：${raw}`, 'PATH_ESCAPE');
    }

    const target = path.resolve(this.root, raw);
    if (!isInside(this.root, target)) {
      throw new ToolError(`路径越出工作区：${raw}`, 'PATH_ESCAPE');
    }

    const realRoot = await realpathOrNull(this.root);
    if (!realRoot) throw new ToolError(`工作区根目录不存在：${this.root}`, 'BAD_ROOT');

    if (opts.mustExist) {
      const real = await realpathOrNull(target);
      if (!real) throw new ToolError(`文件不存在：${raw}`, 'ENOENT');
      if (!isInside(realRoot, real)) {
        throw new ToolError(`路径经符号链接指向工作区之外：${raw}`, 'PATH_ESCAPE');
      }
      return real;
    }

    // 待写入路径可能尚不存在：校验其最近的已存在祖先目录是否仍在沙箱内
    const existingAncestor = await nearestExisting(target);
    if (existingAncestor) {
      const realAncestor = await realpathOrNull(existingAncestor);
      if (realAncestor && !isInside(realRoot, realAncestor)) {
        throw new ToolError(`路径经符号链接指向工作区之外：${raw}`, 'PATH_ESCAPE');
      }
    }
    return target;
  }

  /**
   * 执行一次工具调用。**本方法不抛异常** —— 工具失败是正常反馈，
   * 应该作为结果回给模型让它自我修正，而不是让整个循环崩掉。
   *
   * @param {{ id?: string, name: string, args: any }} call
   * @returns {Promise<{ ok: boolean, name: string, result?: any, error?: string, code?: string, durationMs: number, truncated?: boolean }>}
   */
  async execute(call) {
    const started = Date.now();
    const name = String(call?.name ?? '');

    const validation = validateToolCall(call);
    if (!validation.ok) {
      return this.#record(name, { ok: false, error: validation.error, code: 'INVALID_ARGS' }, started);
    }

    try {
      const handler = this.#handlers[name];
      if (!handler) throw new ToolError(`工具未实现：${name}`, 'NOT_IMPLEMENTED');
      const result = await handler.call(this, call.args);
      return this.#record(name, { ok: true, result }, started);
    } catch (err) {
      const code = err instanceof ToolError ? err.code : 'EXEC_ERROR';
      if (code === 'PATH_ESCAPE' || code === 'COMMAND_NOT_ALLOWED' || code === 'COMMAND_FORBIDDEN') {
        this.stats.blocked += 1;
      }
      return this.#record(
        name,
        { ok: false, error: err instanceof Error ? err.message : String(err), code },
        started,
      );
    }
  }

  #record(name, outcome, started) {
    const durationMs = Date.now() - started;
    this.stats.calls += 1;
    if (!outcome.ok) this.stats.failures += 1;
    // 截断标记在工具返回值里（outcome.result.truncated），不在 outcome 顶层 ——
    // 曾经写错过一次，导致 stats.truncated 永远是 0。这个计数会进评测报告，不能错。
    if (outcome.result?.truncated) this.stats.truncated += 1;
    const ev = { name, ok: outcome.ok, durationMs, error: outcome.error };
    if (this.logger) this.logger(ev);
    return { ...outcome, name, durationMs };
  }

  #handlers = {
    /** @this {ToolBox} */
    async list_files(args) {
      const dir = await this.resolvePath(args.dir || '.', { mustExist: true });
      const stat = await fsp.stat(dir);
      if (!stat.isDirectory()) throw new ToolError('list_files 的目标不是目录', 'NOT_A_DIR');

      const out = [];
      const walk = async (current) => {
        if (out.length >= this.limits.maxListEntries) return;
        const entries = await fsp.readdir(current, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (out.length >= this.limits.maxListEntries) return;
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(current, e.name);
          if (e.isDirectory()) await walk(full);
          else out.push(path.relative(this.root, full).split(path.sep).join('/'));
        }
      };
      await walk(dir);

      const filtered = args.pattern ? out.filter((p) => p.includes(String(args.pattern))) : out;
      const truncated = filtered.length > this.limits.maxListEntries;
      return {
        files: filtered.slice(0, this.limits.maxListEntries),
        total: filtered.length,
        truncated,
      };
    },

    /** @this {ToolBox} */
    async read_file(args) {
      const file = await this.resolvePath(args.path, { mustExist: true });
      const stat = await fsp.stat(file);
      if (stat.isDirectory()) throw new ToolError('read_file 的目标是目录，请用 list_files', 'IS_A_DIR');
      if (stat.size > this.limits.maxFileBytes) {
        throw new ToolError(
          `文件过大（${stat.size} 字节，上限 ${this.limits.maxFileBytes}）。请改用 start_line/end_line 分段读取。`,
          'TOO_LARGE',
        );
      }

      const text = await fsp.readFile(file, 'utf8');
      const lines = text.split('\n');
      const total = lines.length;

      let from = 1;
      let to = total;
      if (Number.isInteger(args.start_line)) from = Math.max(1, args.start_line);
      if (Number.isInteger(args.end_line)) to = Math.min(total, args.end_line);
      if (from > to) throw new ToolError(`行区间不合法：start_line=${from} > end_line=${to}`, 'BAD_RANGE');

      const slice = lines.slice(from - 1, to);
      // 按**整行**预算截断，而不是按字符切。
      // 理由：行号前缀本身占长度，按字符切会切在行中间，模型拿到半行内容反而更难判断；
      // 且必须先算前缀再判断预算，否则会输出超过限额的内容。
      const budget = this.limits.maxOutputChars;
      const rendered = [];
      let used = 0;
      let shownTo = from - 1;
      for (let i = 0; i < slice.length; i++) {
        const lineNo = from + i;
        const piece = `${String(lineNo).padStart(4, ' ')}| ${slice[i]}`;
        if (used + piece.length + 1 > budget && rendered.length > 0) break;
        rendered.push(piece);
        used += piece.length + 1;
        shownTo = lineNo;
      }

      const truncated = shownTo < to;
      return {
        path: args.path,
        total_lines: total,
        requested: `第 ${from}-${to} 行`,
        start_line: from,
        end_line: shownTo,
        truncated,
        content: truncated
          ? `${rendered.join('\n')}\n…[已显示到第 ${shownTo} 行，文件共 ${total} 行。请从 start_line=${shownTo + 1} 继续读取]`
          : rendered.join('\n'),
      };
    },

    /** @this {ToolBox} */
    async write_file(args) {
      const file = await this.resolvePath(args.path);
      const content = String(args.content ?? '');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, 'utf8');
      return {
        path: args.path,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content.split('\n').length,
      };
    },

    /** @this {ToolBox} */
    async edit_file(args) {
      const file = await this.resolvePath(args.path, { mustExist: true });
      const original = await fsp.readFile(file, 'utf8');

      const needle = String(args.old_string ?? '');
      if (needle === '') throw new ToolError('old_string 不能为空', 'BAD_ARGS');

      const first = original.indexOf(needle);
      if (first === -1) throw new ToolError('在文件中找不到 old_string，请先 read_file 确认原文', 'NO_MATCH');
      // 唯一性要求：多处匹配时静默替换第一处是危险的，模型可能改错地方
      if (original.indexOf(needle, first + needle.length) !== -1) {
        throw new ToolError('old_string 在文件中出现多次，替换位置不唯一。请扩大上下文使其唯一。', 'AMBIGUOUS');
      }

      const updated = original.slice(0, first) + String(args.new_string ?? '') + original.slice(first + needle.length);
      await fsp.writeFile(file, updated, 'utf8');

      const changedLine = original.slice(0, first).split('\n').length;
      return { path: args.path, changed_line: changedLine, bytes: Buffer.byteLength(updated, 'utf8') };
    },

    /** @this {ToolBox} */
    async search_text(args) {
      const dir = await this.resolvePath(args.dir || '.', { mustExist: true });
      let re;
      try {
        re = new RegExp(String(args.pattern));
      } catch (err) {
        throw new ToolError(`正则表达式无效：${err instanceof Error ? err.message : String(err)}`, 'BAD_REGEX');
      }

      const matches = [];
      let scanned = 0;
      const walk = async (current) => {
        if (matches.length >= 200) return;
        for (const e of await fsp.readdir(current, { withFileTypes: true })) {
          if (matches.length >= 200) return;
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(current, e.name);
          if (e.isDirectory()) {
            await walk(full);
            continue;
          }
          let stat;
          try {
            stat = await fsp.stat(full);
          } catch {
            continue;
          }
          if (stat.size > this.limits.maxFileBytes) continue;
          scanned += 1;
          let text;
          try {
            text = await fsp.readFile(full, 'utf8');
          } catch {
            continue; // 二进制文件读不出 UTF-8 就跳过
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= 200) return;
            // 每行单独匹配：正则带 g 标志时 lastIndex 会残留，必须重置
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              matches.push({
                file: path.relative(this.root, full).split(path.sep).join('/'),
                line: i + 1,
                text: lines[i].slice(0, 200),
              });
            }
          }
        }
      };
      await walk(dir);

      return { pattern: args.pattern, scanned_files: scanned, matches, truncated: matches.length >= 200 };
    },

    /** @this {ToolBox} */
    async run_command(args) {
      const command = String(args.command ?? '').trim();
      const argv = Array.isArray(args.args) ? args.args.map((a) => String(a)) : [];

      if (!this.allowedCommands.includes(command)) {
        throw new ToolError(
          `命令「${command}」不在白名单内。允许：${this.allowedCommands.join('、')}`,
          'COMMAND_NOT_ALLOWED',
        );
      }
      for (const a of argv) {
        const hit = FORBIDDEN_ARG_PATTERNS.find((p) => p.re.test(a));
        if (hit) throw new ToolError(`参数「${a}」被禁止：${hit.why}`, 'COMMAND_FORBIDDEN');
      }

      const result = await new Promise((resolve) => {
        const child = this.execImpl(
          command,
          argv,
          {
            cwd: this.root,
            timeout: this.limits.commandTimeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            shell: false, // 显式关闭 shell —— 让 argv 里的元字符彻底失效
          },
          (error, stdout, stderr) => {
            resolve({
              exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
              stdout: String(stdout || ''),
              stderr: String(stderr || ''),
              timedOut: Boolean(error && error.killed),
            });
          },
        );
        // 兜底：execFile 在极少数环境下可能不触发回调
        child.on?.('error', () => {});
      });

      const out = clip(result.stdout, this.limits.maxOutputChars);
      const err = clip(result.stderr, this.limits.maxOutputChars);
      return {
        command,
        args: argv,
        exit_code: result.exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timed_out: result.timedOut,
      };
    },

    /** @this {ToolBox} */
    async finish(args) {
      return { summary: String(args.summary ?? '') };
    },
  };
}

/** target 是否位于 root 之内（含 root 自身）。 */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realpathOrNull(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/** 向上找到最近的已存在目录，用于校验"即将创建的文件"的祖先是否安全。 */
async function nearestExisting(target) {
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 按字符数截断，并显式标记是否发生了截断。 */
export function clip(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, maxChars)}\n…[输出被截断，共 ${s.length} 字符，仅显示前 ${maxChars} 字符]`,
    truncated: true,
  };
}
