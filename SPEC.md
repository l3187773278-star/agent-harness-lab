# SPEC · agent-harness-lab

> 一个从零手写的 AI Agent 运行时与评测台。**零外部运行时依赖**，只用 Node.js 内置模块。
> 目的：用可复现的数字回答一个问题 —— *结构化的 Agent 运行时，到底比"直接问模型"强多少？*

---

## 1. 为什么做这个项目（而不是再做一个小工具）

市面上的 AI 应用项目，绝大多数长这样：调一个云端 API，套一层聊天界面，加几个 prompt。
这类项目在面试里撑不过三个追问，因为它的难度不在工程，在调 API。

这个项目不同。它把重点放在**真正难的地方**：

| 难点 | 为什么难 | 本项目怎么解 |
| --- | --- | --- |
| 模型输出是流式的、工具调用是分片到达的 | 一次响应里可能同时有多个 tool_call，且每个的 `arguments` 被切成多个 delta 分片，拼接顺序、索引错位都是坑 | `provider.js` 手写 SSE 解析 + 按 `index` 归并分片 |
| 工具必须能安全执行 | 模型会给出 `../../` 之类的路径、会写死循环命令 | `tools.js` 沙箱根校验 + 超时 + 输出截断 |
| 上下文会爆炸 | 长任务几十轮后历史撑爆窗口 | `context.js` 预算制压缩 + 关键节点保留 |
| 长任务会中途失败 | 网络抖动、限流、进程被杀 | 重试退避 + 检查点续跑 |
| "它能用"是主观判断 | 没有数字就无法改进 | `bench/` 标准化任务集 + 自动判分 + 基线对照 |

**一句话定位**：别人做"用 Agent"，我做"Agent 本身"，并且证明它有效。

---

## 2. 核心命题与对照实验

### 命题

> 在需要多步推理与外部信息才能完成的任务上，带工具调用 + 上下文管理 + 失败重试的
> 结构化运行时，任务完成率显著高于"把同样信息一次性喂给模型"的单发基线。

### 基线怎么设（公平性在这里）

**不能把基线做弱来制造好看的数字**，否则面试官一问就穿。基线设计：

- `single-shot`：把任务描述和所有相关文件的**全文**一次性放进 prompt，让模型直接给出最终答案或补丁。
  —— 给它同样的信息，但不给它多步试探、执行反馈、自我纠错的机会。
- 公平点：基线拿到的信息量 **不少于** Agent 在第一步拿到的东西。

### 要产出的数字（全部可复现）

| 指标 | 定义 |
| --- | --- |
| `task_success_rate` | 通过自动判分的任务数 / 总任务数 |
| `baseline_success_rate` | 同上，单发基线 |
| `tool_call_validity` | 参数能通过 schema 校验的调用数 / 总调用数 |
| `tool_call_accuracy` | 调用序列与人工标注的最优序列的一致率 |
| `recovery_rate` | 注入故障后仍能完成的比例 |
| `avg_steps` / `avg_tokens` | 平均步数与平均 token 消耗（含缓存命中） |
| `compaction_ratio` | 压缩后 token / 压缩前 token |
| `p50_latency_ms` / `p95_latency_ms` | 单步延迟分位 |

---

## 3. 工程约束

1. **运行时零依赖**：`package.json` 的 `dependencies` 必须为空。
   开发期允许 `eslint` / `prettier`（devDependencies），但 `node src/cli.js` 不能 import 任何第三方包。
   —— 这不是炫技，是为了证明每一行都是自己写的，且面试官 clone 下来就能跑。
2. **Node >= 18**，ESM（`"type": "module"`）。
3. **测试用内置 `node:test`**，不引入测试框架。
4. **所有网络调用可录制、可回放**。测试与 CI **绝不**调真实 API（无 key 也能全绿）。
5. **冻结评测集**：`bench/tasks/*` 与 `bench/expected/*` 一旦用于出报告就冻结，
   prompt、判分器、任务内容都不许为了刷分改动；改动必须在报告里注明版本号。

---

## 4. 仓库结构

```
agent-harness-lab/
├─ SPEC.md                    ← 本文件，项目宪法
├─ README.md / README.en.md   ← 中英双语门面
├─ LICENSE                    ← MIT
├─ package.json               ← dependencies 必须为空
├─ eslint.config.mjs
├─ .github/workflows/ci.yml   ← lint + test + 离线评测
├─ docs/
│  ├─ architecture.md         ← 分层图与数据流
│  ├─ adr/                    ← 架构决策记录，每个决定一篇
│  └─ report.md               ← 评测报告（真实数字，带环境与日期）
├─ src/
│  ├─ cli.js                  ← 入口：run / bench / replay 三个子命令
│  ├─ config.js               ← 配置与密钥解析（env > .env.local > 报错）
│  ├─ provider.js             ← OpenAI 兼容协议：流式、并行 tool_calls 归并、重试
│  ├─ loop.js                 ← Agent 主循环：步数预算、终止条件、检查点
│  ├─ context.js              ← token 预算与历史压缩
│  ├─ tools.js                ← 工具注册表与内置工具（沙箱校验）
│  ├─ trace.js                ← 结构化轨迹记录（JSONL）
│  └─ recorder.js             ← 网络层录制/回放，供离线测试与 CI
├─ bench/
│  ├─ runner.js               ← 评测执行器：任务隔离、并发、打分
│  ├─ baseline.js             ← 单发基线
│  ├─ judge.js                ← 判分器（确定性为主）
│  ├─ report.js               ← 生成 report.json / report.md
│  ├─ tasks/                  ← 任务定义 + 自带缺陷的夹具工程
│  └─ expected/               ← 期望结果与判分规则
└─ test/                      ← node:test 单元测试（全部离线）
```

---

## 5. 分层与数据流

```
cli.js
  └─ loop.js ──────────── 决策循环（有状态、可中断、可续跑）
       ├─ context.js ──── 每步构造发给模型的 messages（预算内）
       ├─ provider.js ─── 发请求、收流、归并 tool_calls、失败重试
       └─ tools.js ────── 执行工具，返回结果给下一轮
            └─ trace.js ─ 全过程落盘（谁在什么时候调了什么、花了多少 token）
```

单向依赖，**不许反向 import**。`tools.js` 不认识 `provider.js`，`provider.js` 不认识 `loop.js`。
这条纪律让每个模块都能单独测试——也是面试时最能体现工程素养的地方。

---

## 6. 分阶段交付（每阶段都有可验证产出）

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| P0 | 骨架、配置、LICENSE、CI、SPEC | CI 绿灯，`node src/cli.js --version` 有输出 |
| P1 | `provider.js` 流式与并行工具调用 | 单测覆盖分片归并的错位/乱序/跨调用边界 |
| P2 | `tools.js` 沙箱工具集 | 越权路径、超时命令、超大输出全部被拦并有测试 |
| P3 | `loop.js` + `context.js` | 能真实跑通一个多步任务，trace 完整 |
| P4 | `recorder.js` 离线回放 | 无 key 环境 `node --test` 全绿 |
| P5 | `bench/` 评测台与基线 | 本地出 `report.json` |
| P6 | 冻结评测集、跑正式评测 | `docs/report.md` 产出真实数字 |
| P7 | 门面：README、截图、ADR、简历改写 | GitHub 首页可读，简历单页版 |

---

## 7. 验收标准

- [ ] `npm test` 全绿，且**在无网络、无 API Key 的环境下**也能全绿
- [ ] `npm run lint` 无错误
- [ ] `dependencies` 为空对象
- [ ] `node src/cli.js run "<任务>"` 能真实跑通
- [ ] `node src/cli.js bench` 能产出 `report.json`
- [ ] `docs/report.md` 里每个数字都能追溯到一次可复现的运行
- [ ] 每个非平凡设计决定都有对应 ADR

---

## 8. 明确不做（控制范围）

- 不做 Web UI（评测台出 markdown 报告即可，界面不是本项目的难点）
- 不做多 Agent 协作（先把单 Agent 循环做扎实，多 Agent 是另一个命题）
- 不接入向量数据库（需要检索时用关键词 + 结构索引，避免把难度外包给依赖）
- 不追求刷榜（评测集是自己的，数字的意义在于可复现，不在于排名）
