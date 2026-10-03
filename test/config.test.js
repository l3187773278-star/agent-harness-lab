import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseEnvText,
  resolveApiKey,
  loadConfig,
  assertKeyAvailable,
  ConfigError,
  DEFAULTS,
} from '../src/config.js';

test('parseEnvText：基本键值、注释、空行、引号', () => {
  const parsed = parseEnvText(
    [
      '# 注释行',
      '',
      'DEEPSEEK_API_KEY=sk-abc',
      'QUOTED="有 空格"',
      "SINGLE='单引号'",
      'WITH_EQUALS=a=b=c',
      'NO_VALUE_LINE',
    ].join('\n'),
  );
  assert.equal(parsed.DEEPSEEK_API_KEY, 'sk-abc');
  assert.equal(parsed.QUOTED, '有 空格');
  assert.equal(parsed.SINGLE, '单引号');
  assert.equal(parsed.WITH_EQUALS, 'a=b=c');
  assert.equal(parsed.NO_VALUE_LINE, undefined);
});

test('resolveApiKey：显式传入优先级最高', () => {
  const key = resolveApiKey({
    explicit: 'sk-explicit',
    env: { DEEPSEEK_API_KEY: 'sk-env' },
    home: path.join(os.tmpdir(), 'definitely-not-a-real-home'),
  });
  assert.equal(key, 'sk-explicit');
});

test('resolveApiKey：环境变量优先于本地文件与 DSH 凭证', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-cfg-'));
  fs.writeFileSync(path.join(dir, '.env.local'), 'DEEPSEEK_API_KEY=sk-from-file\n', 'utf8');
  const key = resolveApiKey({
    cwd: dir,
    env: { DEEPSEEK_API_KEY: 'sk-from-env' },
    home: path.join(os.tmpdir(), 'nope'),
  });
  assert.equal(key, 'sk-from-env');
});

test('resolveApiKey：环境变量缺失时读 .env.local', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-cfg-'));
  fs.writeFileSync(path.join(dir, '.env.local'), 'DEEPSEEK_API_KEY=sk-from-file\n', 'utf8');
  const key = resolveApiKey({ cwd: dir, env: {}, home: path.join(os.tmpdir(), 'nope') });
  assert.equal(key, 'sk-from-file');
});

test('resolveApiKey：都没有时读 DSH 凭证文件，读不到则返回 null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-home-'));
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.dsh', '.credentials.yaml'),
    ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-from-dsh', 'records: {}'].join('\n'),
    'utf8',
  );
  assert.equal(resolveApiKey({ cwd: os.tmpdir(), env: {}, home }), 'sk-from-dsh');

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ahl-home-'));
  assert.equal(resolveApiKey({ cwd: os.tmpdir(), env: {}, home: emptyHome }), null);
});

test('loadConfig：默认值、baseURL 末尾斜杠清理、数值覆盖', () => {
  const cfg = loadConfig({}, { env: {}, cwd: os.tmpdir(), home: path.join(os.tmpdir(), 'nope') });
  assert.equal(cfg.baseURL, DEFAULTS.baseURL);
  assert.equal(cfg.model, DEFAULTS.model);
  assert.equal(cfg.temperature, 0);
  assert.equal(cfg.apiKey, null);
  assert.equal(cfg.offline, false);

  const cfg2 = loadConfig(
    { baseURL: 'https://example.com/v1///', model: 'm1', timeoutMs: 1234, maxRetries: 0 },
    { env: {}, cwd: os.tmpdir(), home: path.join(os.tmpdir(), 'nope') },
  );
  assert.equal(cfg2.baseURL, 'https://example.com/v1');
  assert.equal(cfg2.model, 'm1');
  assert.equal(cfg2.timeoutMs, 1234);
  assert.equal(cfg2.maxRetries, 0);
});

test('loadConfig：环境变量可指定模型与接入点，AHL_OFFLINE 可开离线', () => {
  const cfg = loadConfig(
    {},
    {
      env: { DEEPSEEK_MODEL: 'env-model', DEEPSEEK_BASE_URL: 'https://env.example', AHL_OFFLINE: '1' },
      cwd: os.tmpdir(),
      home: path.join(os.tmpdir(), 'nope'),
    },
  );
  assert.equal(cfg.model, 'env-model');
  assert.equal(cfg.baseURL, 'https://env.example');
  assert.equal(cfg.offline, true);
});

test('assertKeyAvailable：有 key 返回 key，没 key 抛带操作提示的 ConfigError', () => {
  assert.equal(assertKeyAvailable({ apiKey: 'sk-x' }), 'sk-x');

  assert.throws(
    () => assertKeyAvailable({ apiKey: null }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /DEEPSEEK_API_KEY/);
      assert.match(err.message, /\.env\.local/);
      assert.match(err.message, /AHL_OFFLINE/);
      return true;
    },
  );
});
