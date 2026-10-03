# 架构与数据流

## 分层

```
cli.js           参数解析与装配（无业务逻辑）
  │
  └─ loop.js     决策循环：步数预算、终止条件、重复调用检测、故障注入
       │
       ├─ context.js  每步构造发送的 messages（token 预算内、渐进压缩）
       ├─ provider.js 协议层：发请求、收流、归并 tool_calls、失败重试
       │      └─ sse.js   SSE 解析与工具调用分片归并（最底层）
       └─ tools.js    工具执行：沙箱路径校验、命令白名单、输出截断
              └─ trace.js  全过程落盘（JSONL）
```

依赖严格单向，**任何模块不许反向 import**：
`tools.js` 不认识 `provider.js`，`provider.js` 不认识 `loop.js`。
这条纪律让每个模块都能单独测试，也是分层设计的主要收益。

## 一次工具调用的完整数据流

```
模型返回流（SSE 分片，可能任意切分）
  → sse.js 按 index 归并并行 tool_calls 的参数分片
  → loop.js 校验调用（validateToolCall）
  → tools.js 执行（路径 realpath 校验 → 沙箱内操作）
  → 结果 JSON 化，作为 role=tool 消息回灌
  → context.js 在预算内组装下一步 messages
  → provider.js 发下一步请求（prompt cache 命中系统提示前缀）
```

## 三条安全边界（tools.js）

1. 路径：只收相对路径，`..` 与绝对路径拒绝；再经 realpath 校验，
   符号链接指向工作区外也会被拒。
2. 命令：execFile + argv 数组，不走 shell（元字符失效）；可执行文件白名单
   （刻意不含 shell/powershell/cmd）；白名单内另有危险子命令黑名单
   （git push / reset / clean / remote / filter-branch）。
3. 输出：所有返回值有字符上限，截断时**显式告知**并给出继续读取的线索
   （如"已显示到第 N 行，请从 N+1 继续"）。

## 评测流水线

```
bench/tasks/<id>/
  ├─ task.json       任务元数据与 prompt（冻结）
  ├─ workspace/      Agent 看到的初始工作区（含缺陷）
  └─ grader/         评分器（Agent 看不到，跑完才注入）

runBenchmark：
  复制 workspace → Agent 运行 → 注入评分器 → node --test 判分
  复制 workspace → 单发基线出补丁 → 应用 → 同一评分器判分
  → report.json + report.md（含逐任务轨迹、token、结束原因）
```

## 离线测试分层（全部不联网）

| 层 | 手段 | 位置 |
| --- | --- | --- |
| 单元 | node:test + 录制回放夹具 | test/*.test.js |
| 接线自检 | cli selftest（回放模型回复跑通整个循环） | src/cli.js |
| 评测集质量 | 双向验证（种子必须被抓、参考解法必须过） | bench/reference-solutions.mjs |
| 评测流水线 | 假 Provider 冒烟（Agent 0/6、基线 6/6） | bench/smoke.mjs |
| CI | 上述全部 + 零依赖断言 | .github/workflows/ci.yml |
