# agent-harness-lab

> A hand-written AI agent runtime and evaluation harness. **Zero runtime dependencies** — Node.js built-ins only.
>
> It answers one question: *how much does a structured agent runtime beat "just ask the model"?*

[中文](README.md)

---

## What this project does

Most AI app projects = API call + chat UI + prompts. This one builds every layer of an agent from scratch:

| Layer | File | Real problem it solves |
| --- | --- | --- |
| SSE protocol | `src/sse.js` | Streams sliced by the network; interleaved parallel tool-call fragments; truncated-stream detection |
| Protocol & retry | `src/provider.js` | Backoff for rate limits/5xx, timeouts, error classification |
| Context management | `src/context.js` | History blow-up on long tasks: token budget, progressive compaction |
| Tool sandbox | `src/tools.js` | Untrusted model output: path escapes (incl. symlinks), command injection, output floods |
| Decision loop | `src/loop.js` | Step budget, repeated-call breaks, invalid-call feedback, fault injection |
| Evaluation | `bench/` | Held-out tests as judges, single-shot baseline, bi-directionally verified task set |

Then it measures the real gap between the agent and a single-shot baseline on a held-out-test benchmark.

## Key results

> Full report: [docs/report.md](docs/report.md) (per-task details, traces, reproducibility)

| Metric | Value |
| --- | --- |
| Task pass rate (agent / baseline) | **<!--BENCH_AGENT--> / <!--BENCH_BASELINE-->** |
| Average steps | <!--BENCH_STEPS--> |
| Prompt cache hit ratio | <!--BENCH_CACHE--> |
| Unit tests | 101 passing (offline, no key) |
| Runtime dependencies | **0** |

## Quick start

```bash
# Zero dependencies — no npm install required (Node >= 18)

node src/cli.js selftest        # offline self-check, no network, no key
node src/cli.js demo            # real task: optimize the O(n²) dedupe in demo/
node src/cli.js bench --list    # list benchmark tasks
node src/cli.js bench           # run the full benchmark (needs DEEPSEEK_API_KEY)
```

The API key is resolved automatically from, in order: the `DEEPSEEK_API_KEY`
environment variable, a `.env.local` file, or `~/.dsh/.credentials.yaml`
when DeepSeek Harness is logged in.

## Layout

```
src/           runtime: sse → provider → context → tools → loop → cli
test/          unit tests (all offline, replay-driven)
bench/
  tasks/       frozen task set: seeded-bug workspaces + held-out graders
  runner.js    isolated execution, grading, baseline, reports
  reference-solutions.mjs   bi-directional fixture verification
  smoke.mjs    offline pipeline smoke test
demo/          sample workspace: O(n²) dedupe optimization task
docs/          architecture, ADRs, benchmark report
```

## Engineering discipline

- **Zero runtime dependencies**, enforced by a CI assertion.
- **No network in tests**: `npm test` must pass without network or keys.
- **Bi-directionally verified tasks**: every grader is proven to catch the seeded bug and accept the correct solution.
- **One-way dependencies**: `tools.js` doesn't know `provider.js`; no reverse imports.
- **Reproducible numbers**: every report carries a run id, model, timestamp and environment; traces are logged as JSONL.

## License

MIT · © 2026 李光兆
