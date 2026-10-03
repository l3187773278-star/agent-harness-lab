# agent-harness-lab

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

<!-- 上表数字由评测自动生成于 docs/report.md，两者保持一致 -->

## 快速开始

```bash
# 零依赖：无需 npm install 即可跑（Node >= 18）

node src/cli.js selftest        # 离线自检：不联网、不需要 Key，7 项全过
node src/cli.js demo            # 真实任务：让 Agent 优化 demo 里 O(n²) 的去重函数
node src/cli.js bench --list    # 列出评测任务
node src/cli.js bench           # 跑全部评测（需要 DEEPSEEK_API_KEY）
# 正式评测（与 docs/report.md 一致，谷时价更低）：
# node src/cli.js bench --model deepseek-v4-pro --effort max --timeout 900000
```

API Key 三选一（程序自动按顺序找）：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 项目根目录 `.env.local` 里写 `DEEPSEEK_API_KEY=sk-...`
3. 已登录 DeepSeek Harness 时会自动读取 `~/.dsh/.credentials.yaml`

## 目录结构

```
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

## 工程纪律

- **零运行时依赖**：CI 里有"dependencies 必须为空"的硬断言。
- **测试不联网**：`npm test` 在无网络、无 Key 的环境下必须全绿。
- **评测集双向验证**：每个任务的评分器都证明过"能抓住种子缺陷、不误伤正确实现"。
- **单向依赖**：`tools.js` 不认识 `provider.js`，模块不许反向 import。
- **每个数字可复现**：报告带 runId、模型、时间与环境，轨迹 JSONL 全程留痕。

## 许可

MIT · © 2026 李光兆
