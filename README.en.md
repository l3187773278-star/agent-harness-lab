# agent-harness-lab

[![CI](https://github.com/l3187773278-star/agent-harness-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/l3187773278-star/agent-harness-lab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-0-blue.svg)](package.json)

> An AI agent runtime and evaluation harness written from scratch. **Zero runtime dependencies** —
> Node.js built-ins only.
>
> It answers one question: *how much better is a structured agent runtime than simply asking the model?*

[中文](README.md)

---

## What this project does

Most AI app projects = call an API + wrap a chat UI + add prompts. This one does not.

Every layer of the agent is hand-written:

| Layer | File | Real problem it solves |
| --- | --- | --- |
| SSE protocol | `src/sse.js` | Streams sliced by the network; interleaved parallel tool-call fragments; truncated-stream detection |
| Protocol & retry | `src/provider.js` | Backoff for rate limits/5xx, timeouts, error classification |
| Context management | `src/context.js` | History blow-up on long tasks: token budget, progressive compaction |
| Tool sandbox | `src/tools.js` | Untrusted model output: path escapes (incl. symlinks), command injection, output floods |
| Decision loop | `src/loop.js` | Step budget, repeated-call breaks, invalid-call feedback, fault injection |
| Evaluation | `bench/` | Held-out tests as judges, single-shot baseline, bi-directionally verified task set |

It then measures the real gap between the agent and a single-shot baseline on a held-out-test benchmark.

## Key results

> Full report: [docs/report.md](docs/report.md) (per-task details, traces, reproducibility)

| Metric | Value |
| --- | --- |
| Task pass rate (agent / baseline) | **6/6 (t6 re-run after fix) / 6/6** |
| Average steps | 8.5 |
| Prompt cache hit ratio | 94.2% |
| Unit tests | 102 passing (offline, no key) |
| Runtime dependencies | **0** |

The evaluation and CI surfaced 8 real defects that were fixed with regression evidence
(protocol truncation, context accounting, tool-call protocol, timeout budget, grading timezone, …).
Each one is documented as symptom → root cause → fix → regression in
[docs/report.md](docs/report.md), section 5.

## Quick start

Requires **Node.js >= 18**. Zero runtime dependencies — run it without installing anything.

```bash
node src/cli.js selftest        # offline self-check: no network, no key, 7 checks
node src/cli.js demo            # real task: optimize the O(n²) dedupe in demo/
node src/cli.js bench --list    # list benchmark tasks
node src/cli.js bench           # run the full benchmark (needs DEEPSEEK_API_KEY)
# official run (matches docs/report.md; --timeout must exceed the model's thinking time):
# node src/cli.js bench --model deepseek-v4-pro --effort max --timeout 900000
```

The API key is resolved automatically from, in order: the `DEEPSEEK_API_KEY`
environment variable, a `.env.local` file, or `~/.dsh/.credentials.yaml`
when DeepSeek Harness is logged in.

### What it looks like

Offline self-check (no key, no network):

```text
✅ 工具写入：写入 x/y.txt 5 字节
✅ 工具读取：内容一致
✅ 沙箱拦截：越权路径被拒绝
✅ 上下文压缩：2804 → 386 token
✅ 请求装配：5 条消息，约 3090 token
✅ 协议解析（离线回放）：内容与 1 个工具调用都解析正确
✅ 循环端到端（离线回放）：2 步完成

自检全部通过（共 7 项，未联网、未使用 API Key）
```

Benchmark output (one real task from the run behind [docs/report.md](docs/report.md)):

```text
━━━ t5-graph（hard）修复拓扑排序的环检测误报与漏报 ━━━
  Agent：✅ 通过 · 7 步 · 113612↑/24686↓ tok（缓存 110720） · 240s
  基线：✅ 通过 · 1 个文件 · 301s
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Layer diagram, full data flow of one tool call, the three safety boundaries |
| [docs/report.md](docs/report.md) | Evaluation report: design, per-task details, defect fixes, reproduction |
| [docs/adr/](docs/adr/) | 7 architecture decision records: zero deps, retry placement, token estimation, compaction, held-out grading, baseline fairness, permit hand-off model |
| [SPEC.md](SPEC.md) | Project charter: thesis, metric definitions, engineering constraints, milestones |

## Layout

```text
src/           runtime: sse → provider → context → tools → loop → cli
test/          unit tests (all offline, replay-driven)
bench/
  tasks/       6 seeded buggy workspaces + held-out graders (frozen)
  runner.js    evaluation runner (isolated runs, grading, baseline, reports)
  reference-solutions.mjs   bi-directional check: seeds must fail, solutions must pass
  smoke.mjs    evaluation-pipeline smoke test (no network)
demo/          sample workspace: O(n²) dedupe optimization task
docs/          architecture, ADRs, evaluation report
```

## Development & testing

```bash
npm install                          # dev dependencies only (ESLint / Prettier); runtime stays zero-dep
npm test                             # 102 unit tests (offline, no key)
npm run lint                         # ESLint
node src/cli.js selftest             # 7 offline self-checks
node bench/smoke.mjs                 # evaluation smoke test with a fake provider
node bench/reference-solutions.mjs   # bi-directional task-set verification
```

CI runs the same steps on Node 18 / 20 / 22 and additionally asserts that
`dependencies` is empty.

## Engineering discipline

- **Zero runtime dependencies** — CI hard-asserts that `dependencies` is empty.
- **Tests never touch the network** — `npm test` must pass offline and without a key.
- **Bi-directionally verified task set** — every grader is proven to catch the seeded bug and to pass the reference fix.
- **One-way dependencies** — `tools.js` does not know about `provider.js`; no reverse imports.
- **Every number is reproducible** — reports carry runId, model, time, environment, and JSONL traces.

## Known limitations

Stated plainly, so the numbers above are not over-read:

- **Only 6 benchmark tasks** — a feasibility check, not a statistical result.
- **Grading uses held-out tests**, so it only covers automatically verifiable tasks (code fixes, algorithmic correctness).
- **Single-machine, sequential execution** — no distributed scheduling.
- **Token counts use a character heuristic** (ADR-0003), not a real tokenizer.
- **The safety boundary is a path/command allowlist** — tools run in-process, not in a container.
- **Only OpenAI-compatible chat APIs** are wired up (tested with DeepSeek); no multimodal or extended tool protocols.

## License

MIT · © 2026 李光兆 · see [LICENSE](LICENSE)
