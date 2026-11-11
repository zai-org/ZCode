# Agent Step Message Scope E2E Design

> 状态（2026-07-15）：修复已实施，本文保留为历史 E2E 设计记录。原正式 E2E 已随 V4 测试迁移
> 进入 `manual-review/pending`；当前自动覆盖事实以
> `docs/testing/conversation-session-e2e-coverage-matrix.md` 为准。

## Feature Summary

| Field | Value |
| --- | --- |
| Change | 修复 `message_completion` 错误累计整个 session 历史的问题，并以失败复现 E2E 锁定 message scope |
| User-visible surfaces | 无 UI 新行为；验证 `/report` 的 `agent_trace` payload |
| Existing docs | `docs/monitoring/business-monitoring.md`、`docs/monitoring/performance-telemetry-catalog.md`、`docs/conversation-session-case-catalog.md` |
| Existing code owners | `packages/ui/src/lib/messageTelemetry.ts`、`packages/ui/src/hooks/useZCodeChat.ts`、`packages/ui/src/hooks/taskStreamEventHandlers.ts` |
| Out of scope | queue/stop、跨 session、手机 replayable 恢复协议、真实 telemetry 服务端接收 |

## Clarification Log

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| --- | --- | --- | --- | --- |
| 1 | 覆盖历史累计问题（A），还是同时覆盖活动 tool step 未收口（A+B） | A | 只验证 `agent_step_cnt` 的 message scope | no |
| 2 | 使用日志对账、preload mock，还是 endpoint 改写 | 日志对账 | 优先从本地可观测证据对账，不依赖外部 telemetry 服务端 | no |
| 3 | production renderer 禁用本地日志，无法读取原计划 payload | 使用 Electron `net.fetch` mock 的调用历史作为等价且更强的本地证据 | 对账主进程实际 HTTP transport 入参，不为测试重新打开生产日志 | no |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| 客户端链路 | `desktop-continuous` | 桌面 renderer 的正常 session stream | `web-remote-replayable`、snapshot/gap recovery | user |
| 会话形态 | 同一 session 连续两轮 | 第二轮必须能看到第一轮历史 | 跨 session、fork/edit/compact | user |
| step 形态 | 每轮一个普通 generation step | 确定性纯文本 replay | reasoning、tool call、permission/elicitation | design |
| 对账主键 | `talkId + messageId` | 同一 completion 与它的逐 step 事件 | 仅按 talkId 聚合 | monitoring spec |
| 证据 | Electron 主进程 telemetry fetch 调用参数 | 最终 HTTP body 中的 `agent_step`、`message_completion` | 外部 telemetry 服务端落库结果 | code constraint + user-approved local reconciliation |

## Domain Scope

| Domain | Include? | Why it can change behavior | Primary sources |
| --- | --- | --- | --- |
| Conversation/session behavior | yes | 必须证明两轮属于同一 session 且都完成 | conversation catalog/workflow |
| Monitoring/telemetry | yes | 被测字段和逐事件对账都属于 `/report agent_trace` | monitoring specs |
| Provider replay | yes | 两轮需要确定性、无工具的纯文本响应 | E2E fixture workflow |
| Mobile remote/replayable | no | message scope 缺陷不需要恢复链路即可复现 | user pruning |

## Concept Map And State Owners

| Concept | State owner | Evidence |
| --- | --- | --- |
| 当前 prompt telemetry | UI `activePromptTelemetryByTask` | completion 的 `messageId` |
| agent step lifecycle | UI `agentStepTelemetryByTask` | 同 `talkId + messageId` 的 `agent_step` payload |
| session message history | Agent runtime/session + UI projection | 第二轮发送前第一轮已完成；同一 `talkId` |
| telemetry transport input | renderer `reportAppTelemetryEvent` → main `createDesktopTelemetryFetch(net)` | Electron `net.fetch` mock calls 中的最终 request body |
| E2E observation boundary | WDIO Electron service | `browser.electron.mock("net", "fetch")` 调用历史 |

## Production Fix Design

`message_completion` 与逐条 `agent_step` 必须共享同一个 active prompt 生命周期：

1. `activatePromptTelemetry()` 激活一条用户消息时，初始化本轮 step 聚合和从 `1`
   开始的 `loop_index`。
2. 每个 step 只在 `finalizeAgentStep()` 收口时累计一次；因此
   `agent_step_cnt` 等于当前 `message_id` 实际上报的 `agent_step` 数。
3. 收口的 `tool_call` step 同时累计 `tool_call_total`；失败或超时工具累计
   `tool_call_failed`，并保留本轮第一个工具错误用于 completion 失败兜底。
4. `finalizePromptTelemetry()` 只读取 active prompt 中的聚合值，不再扫描
   session 全量 `taskMessages`。
5. 删除 `FinalizePromptTelemetryInput.taskMessages` 以及两个历史扫描 helper，调用方
   不再为 completion 计数读取消息 store。

上述状态由 `PromptTelemetryState` 持有，`AgentStepTelemetryState` 继续只负责活动 step
和 `loop_index`。计数发生在统一的 step 收口出口，使 completion 聚合与实际逐 step
事件保持同源，避免根据最终消息投影反推流式生命周期。

### 计数不变量

- 对任意 `talk_id + message_id`，`agent_step_cnt` 等于实际产出的 `agent_step` 条数。
- 同一 message 的 `loop_index` 连续从 `1` 递增；新 prompt 激活后重新从 `1` 开始。
- `tool_call_total` 等于当前 message 中 `step_type=tool_call` 的终态 step 数。
- `tool_call_failed` 等于其中 `status=fail/timeout` 的数量。
- 前一轮 message 的任何 step 或工具都不得进入后一轮 completion。

### 兼容边界

- 本修复只改变 UI telemetry 聚合来源，不修改 stream、snapshot、queue、owner、
  relay、host 或协议。
- desktop continuous 与 web remote replayable 都按各自激活的 prompt 聚合；不会把
  replayable 恢复语义扩散到桌面主链路。
- 工具事件乱序仍沿用现有 fallback step 和 permission waiting 归因；计数只在该
  fallback step 最终收口时发生。

## Candidate Combinations And Pruning

| Candidate ID | State | Event | Expected effect | Status | Reason |
| --- | --- | --- | --- | --- | --- |
| R01 | 同一 desktop session，第一轮已完成 | 第二轮纯文本完成 | 第二轮 `agent_step_cnt` 等于同 message 的实际 step 数 1 | accepted | 最小稳定生产缺陷复现 |
| R02 | 同一 session，第二轮含工具 | 第二轮完成 | tool/reasoning/generation 全量对账 | pruned | 属于后续 step 类型覆盖，不是本次 A 的最小边界 |
| R03 | 两个不同 session 各发一轮 | 两轮完成 | 各 session 独立计数 | pruned | 不经过历史累计条件 |
| R04 | 手机 replayable 恢复历史后发送 | 第二轮完成 | 恢复链路仍按 message 计数 | ignored | 高风险跨端语义单独规划 |
| R05 | 运行中 stop/error | completion 收口 | 中断 step 与 completion 对账 | ignored | fault/terminal lifecycle 单独规划 |

## Accepted Case

### R01: 同一 session 第二轮 agent step 按 message 隔离

Setup:

1. 使用 `prepareConversationE2E()` 启动隔离桌面应用。
2. 两个带稳定 `E2E_AGENT_STEP_MESSAGE_SCOPE_*` marker 的 prompt 分别匹配 case-local fixture。
3. fixture 每轮只返回一个纯文本 content block，因此每轮确定产生一个 `generation` step。

Action:

1. 发送第一轮并等待 `idle`。
2. 发送第二轮并等待 `idle`。
3. 在发送前 mock Electron `net.fetch` 并返回成功响应；完成后从 mock 调用历史解析 telemetry endpoint 的 request body。

Assertions:

1. 第一、二轮 completion 具有相同 `talkId`、不同 `messageId`。
2. 第二轮同 `talkId + messageId` 恰有一个 `agent_step`，类型为 `generation`，`loop_index=1`。
3. 第二轮 `message_completion.agent_step_cnt` 必须为 `"1"`。
4. 当前缺陷下第 3 条得到 `"2"`，测试以明确的 count mismatch 失败。

Evidence layers:

- UI/session：两轮均回到 `idle`，第二轮复用第一轮 session。
- Provider：两个稳定 marker 都命中 case-local replay。
- Telemetry/transport：按 `talk_id + message_id` 对账最终 HTTP body 中的逐 step 与 completion。

## E2E Handoff Notes

- Spec：`packages/desktop/test/e2e/conversation-session/presentation/conversation-session-agent-step-message-scope.test.ts`
- Provider fixture：`packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-agent-step-message-scope.json`
- Timing：`fast-text`
- Request classification：两条 marker 请求均为 `main`
- Synthetic：是；稳定纯文本响应用于固定每轮 step 数，manifest 必须记录 `syntheticReason`
- File-system fixture：无
- Promotion：已基于人工 review 转为 formal case；修复后状态为 `covered`
- Verification：GREEN artifact `desktop-e2e-20260703-090147-683`
- Docker：formal case 已通过本地 isolated replay；Docker preset 准入仍按独立 admission 流程执行
- Review risk：telemetry 上报是异步的，测试必须轮询 mock calls，不能依赖固定 sleep；mock 只替换 Electron `net.fetch`，provider replay 由 agent 独立 HTTP 链路处理
