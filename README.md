# agent-harness-lab

[![CI](https://github.com/l3187773278-star/agent-harness-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/l3187773278-star/agent-harness-lab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-0-blue.svg)](package.json)

> 从零手写的 AI Agent 运行时与评测台。**零运行时依赖**，只用 Node.js 内置模块。
>
> 它回答一个问题：*结构化的 Agent 运行时，到底比"直接问模型"强多少？*

[English](README.en.md)

---

## 这个项目做什么

大多数 AI 应用项目 = 调 API + 套聊天界面 + 加 prompt。这个项目不这么做。

它手写了 Agent 的每一层：

| 层 | 文件 | 解决的真实问题 |
| --- | --- | --- |
| SSE 协议 | `src/sse.js` | 流式响应被网络切碎；并行工具调用分片交错到达；截断流的识别 |
| 协议与重试 | `src/provider.js` | 限流/5xx 退避重试、超时、错误分类（哪些值得重试） |
| 上下文管理 | `src/context.js` | 长任务历史爆炸：token 预算、渐进压缩、什么能压什么不能压 |
| 工具沙箱 | `src/tools.js` | 模型输出不可信：路径越权（含符号链接）、命令注入、输出爆炸 |
| 决策循环 | `src/loop.js` | 步数预算、重复调用打断、参数错误回灌自纠、故障注入测恢复率 |
| 评测台 | `bench/` | 留出测试判分、单发基线对照、双向验证的评测集 |

然后用一个**留出测试判分的评测集**，测出 Agent 相对单发基线的真实差距。

## 核心结果

> 完整报告：[docs/report.md](docs/report.md)（含逐任务明细、轨迹与复现方法）

| 指标 | 结果 |
| --- | --- |
| 任务通过率（Agent / 单发基线） | **6/6（t6 修复后复跑） / 6/6** |
| 平均步数 | 8.5 |
| prompt 缓存命中率 | 94.2% |
| 单元测试 | 102 个全绿（离线、无 Key） |
| 运行时依赖 | **0** |

评测过程中被测试与 CI 抓出并闭环修复的真实缺陷有 8 个（协议截断、上下文计数、工具调用协议、
超时预算、判分时区等），每个都带「症状 → 根因 → 修复 → 回归验证」，记录在
[docs/report.md](docs/report.md) 第 5 节。

## 快速开始

要求：**Node.js >= 18**。运行时零依赖 —— 不装任何包即可运行。

```bash
node src/cli.js selftest        # 离线自检：不联网、不需要 Key，7 项全过
node src/cli.js demo            # 真实任务：让 Agent 优化 demo 里 O(n²) 的去重函数
node src/cli.js bench --list    # 列出评测任务
node src/cli.js bench           # 跑全部评测（需要 DEEPSEEK_API_KEY）
# 正式评测（与 docs/report.md 一致；--timeout 要放宽到 v4-pro 的思考时间之上）：
# node src/cli.js bench --model deepseek-v4-pro --effort max --timeout 900000
```

API Key 三选一（程序自动按顺序找）：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 项目根目录 `.env.local` 里写 `DEEPSEEK_API_KEY=sk-...`
3. 已登录 DeepSeek Harness 时会自动读取 `~/.dsh/.credentials.yaml`

### 跑起来长这样

离线自检（不需要 Key、不联网）：

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

评测（真实运行的一行输出，对应 [docs/report.md](docs/report.md) 的 t5 任务）：

```text
━━━ t5-graph（hard）修复拓扑排序的环检测误报与漏报 ━━━
  Agent：✅ 通过 · 7 步 · 113612↑/24686↓ tok（缓存 110720） · 240s
  基线：✅ 通过 · 1 个文件 · 301s
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层图、一次工具调用的完整数据流、三条安全边界 |
| [docs/report.md](docs/report.md) | 评测报告：实验设计、逐任务明细、缺陷修复闭环、复现方法 |
| [docs/adr/](docs/adr/) | 架构决策记录（7 篇）：零依赖、重试位置、token 估算、压缩策略、留出判分、基线公平性、许可交接模型 |
| [SPEC.md](SPEC.md) | 项目宪法：命题、指标定义、工程约束、里程碑 |

## 目录结构

```text
src/           运行时：sse → provider → context → tools → loop → cli
test/          单元测试（全部离线，录制回放驱动）
bench/
  tasks/       评测集：6 个含缺陷的种子工作区 + 留出评分器（冻结）
  runner.js    评测执行器（隔离运行、判分、基线对照、报告）
  reference-solutions.mjs   双向验证：种子必须被抓、参考解法必须过
  smoke.mjs    评测流水线冒烟（不联网）
demo/          示例工作区：O(n²) 去重优化任务
docs/          架构文档、ADR（每个非平凡决定都有记录）、评测报告
```

## 开发与测试

```bash
npm install                          # 只装开发期依赖（ESLint / Prettier），运行时依然零依赖
npm test                             # 102 个单元测试（离线、无 Key）
npm run lint                         # ESLint
node src/cli.js selftest             # 离线自检 7 项
node bench/smoke.mjs                 # 评测器冒烟：用假 Provider 校验判分接线
node bench/reference-solutions.mjs   # 评测集双向验证：种子必须被抓、参考解法必须过
```

CI 在 Node 18 / 20 / 22 上跑同样的步骤，并额外断言 `dependencies` 为空。

## 工程纪律

- **零运行时依赖**：CI 里有"dependencies 必须为空"的硬断言。
- **测试不联网**：`npm test` 在无网络、无 Key 的环境下必须全绿。
- **评测集双向验证**：每个任务的评分器都证明过"能抓住种子缺陷、不误伤正确实现"。
- **单向依赖**：`tools.js` 不认识 `provider.js`，模块不许反向 import。
- **每个数字可复现**：报告带 runId、模型、时间与环境，轨迹 JSONL 全程留痕。

## 已知局限

诚实说明边界，避免过度解读上面的数字：

- **评测集只有 6 个任务**，样本量小；通过率是工程可行性验证，不是统计结论。
- **判分依赖留出测试**，只能覆盖"能自动判定的任务"（代码修复、算法正确性），开放域任务测不了。
- **单机串行执行**，没有分布式并发与多机调度。
- **token 估算用字符启发式**（见 ADR-0003），不是真 tokenizer，预算判断会有偏差。
- **安全边界是路径/命令白名单**，工具仍在同一进程内执行，不是容器级隔离。
- **只对接 OpenAI 兼容的对话接口**（DeepSeek 实测），未接多模态与工具协议扩展。

## 许可

MIT · © 2026 李光兆 · 见 [LICENSE](LICENSE)
