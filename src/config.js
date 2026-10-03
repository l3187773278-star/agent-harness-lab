/**
 * 配置与密钥解析。
 *
 * 设计原则：
 * 1. 密钥只从环境或本地文件读，**永不写入代码、永不进 git**。
 * 2. 零依赖 —— 不引 dotenv，自己解析 .env.local；不引 yaml，只认需要的那一行。
 * 3. 报错要指明"去哪儿配"，而不是抛一句 undefined。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 默认的 OpenAI 兼容接入点与模型。 */
export const DEFAULTS = Object.freeze({
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  timeoutMs: 120_000,
  maxRetries: 3,
  temperature: 0,
});

export class ConfigError extends Error {
  constructor(message, hint) {
    super(hint ? `${message}\n提示：${hint}` : message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

/**
 * 极简 .env 解析：只支持 KEY=VALUE、# 注释、可选的引号包裹。
 * 明确不支持多行值、变量插值等特性 —— 用不到就不写，能少一个依赖就少一个。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnvText(text) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 从 DSH 的凭证文件里取 DeepSeek Key。
 * 本机若已登录 DSH，可直接复用，免去手工复制。
 * @param {string} [home]
 * @returns {string|null}
 */
export function readKeyFromDshCredentials(home = os.homedir()) {
  const file = path.join(home, '.dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 按优先级解析 API Key：显式传入 > 环境变量 > 本地 .env.local > DSH 凭证文件。
 * @param {{ cwd?: string, env?: Record<string,string|undefined>, explicit?: string|null, home?: string }} [opts]
 * @returns {string|null}
 */
export function resolveApiKey(opts = {}) {
  const { cwd = process.cwd(), env = process.env, explicit = null, home = os.homedir() } = opts;
  if (explicit) return explicit;
  if (env.DEEPSEEK_API_KEY) return env.DEEPSEEK_API_KEY;

  const envFile = path.join(cwd, '.env.local');
  if (fs.existsSync(envFile)) {
    const parsed = parseEnvText(fs.readFileSync(envFile, 'utf8'));
    if (parsed.DEEPSEEK_API_KEY) return parsed.DEEPSEEK_API_KEY;
  }

  return readKeyFromDshCredentials(home);
}

/**
 * 组装完整配置。
 * @param {Record<string, unknown>} [overrides]
 * @param {{ cwd?: string, env?: Record<string,string|undefined>, home?: string }} [ctx]
 */
export function loadConfig(overrides = {}, ctx = {}) {
  const { cwd = process.cwd(), env = process.env, home = os.homedir() } = ctx;
  const apiKey = resolveApiKey({ cwd, env, home, explicit: /** @type {any} */ (overrides).apiKey });

  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    baseURL: String(overrides.baseURL || env.DEEPSEEK_BASE_URL || DEFAULTS.baseURL).replace(/\/+$/, ''),
    model: String(overrides.model || env.DEEPSEEK_MODEL || DEFAULTS.model),
    apiKey,
    timeoutMs: num(overrides.timeoutMs, DEFAULTS.timeoutMs),
    maxRetries: num(overrides.maxRetries, DEFAULTS.maxRetries),
    temperature: num(overrides.temperature, DEFAULTS.temperature),
    offline: Boolean(overrides.offline) || env.AHL_OFFLINE === '1',
  };
}

/**
 * 需要真实调用模型时的前置校验：缺 key 就给出可操作的提示。
 * @param {{ apiKey?: string|null, offline?: boolean }} config
 */
export function assertKeyAvailable(config) {
  if (config.apiKey) return config.apiKey;
  throw new ConfigError(
    '缺少 DEEPSEEK_API_KEY，无法调用模型。',
    [
      '三选一：',
      '  1) 设置环境变量：$env:DEEPSEEK_API_KEY="sk-..."',
      '  2) 在项目根目录建 .env.local，写入 DEEPSEEK_API_KEY=sk-...',
      '  3) 若本机已登录 DeepSeek Harness，会自动读取 ~/.dsh/.credentials.yaml',
      '只想跑测试或离线评测：设置 AHL_OFFLINE=1',
    ].join('\n'),
  );
}
