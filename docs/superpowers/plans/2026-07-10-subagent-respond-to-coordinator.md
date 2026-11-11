# Subagent RespondToCoordinator 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为普通 ZCode subagent 增加 child-only 的 `RespondToCoordinator` 工具，使 child 收到 main 通过 `SendMessage` 注入的 coordinator 消息后，可以把回复投递回父 runtime，同时继续当前长程任务。

**Architecture:** 保留现有 `main -> SendMessage -> child steerTurn` 路径不变。新增 `child -> RespondToCoordinator -> CoordinatorResponsePort -> parent runtime command queue` 路径；父 runtime 使用独立的 `subagent-message` command，在 active loop 下一次合法 provider request 前合流，或在 idle 时启动 model-only turn。回复不会成为真实用户消息，不复用 background task completion 的 `task-notification` 语义，也不会直接并发调用父模型。

**Tech Stack:** TypeScript、Zod、Vitest、ZCode tool registry/executor、AgentRuntime command queue、ZCode Protocol、WebdriverIO provider replay E2E。

## Execution Baseline

- 本计划基于 `e458e18b902a467251153972688ca8461eb5a418` 编写；开始 Phase 0 前先运行 `git rev-parse HEAD`。
- 若 HEAD 已变化，先重新核对本计划列出的源码入口、测试文件和命令，再把下述 baseline 更新为实际起点；禁止在未知 branch drift 上机械执行。
- 实现期间以 `BASE_SHA=e458e18b902a467251153972688ca8461eb5a418` 作为完整范围审查基线。最终使用 `git diff "$BASE_SHA"...HEAD` 查看已提交变更，同时单独检查 staged、unstaged 和 untracked 文件。
- 当前 plan 文件本身是 Phase 0 deliverable，必须随 feature spec 一起纳入 Phase 0 commit，不能留在 untracked 状态。

## Global Constraints

- Provider-visible 工具名固定为 `RespondToCoordinator`。
- `SendMessage` 继续只暴露给 main runtime；普通 child 不获得完整 `SendMessage`、`Agent` 或 sibling routing 能力。`RespondToCoordinator` 只在 `taskType === "subagent_child"`、coordinator port 存在且未被全局 `toolDisallowlist` 禁用时注册。
- `RespondToCoordinator` 输入只包含 `{ summary, message }`，不允许模型提供 `to`、`agentId`、`sessionId` 或 parent 标识。
- child session identity、agent identity 和 parent 路由必须由 runtime 创建 child 时注入，模型输入、handler request 都不能覆盖。
- P0 不增加 `replyTo` 字段，也不维护“必须先收到某条 SendMessage 才能回复”的隐藏状态机；工具允许回复 coordinator，也允许简短主动进度汇报。
- 工具成功只表示消息已同步进入父 runtime command queue，不表示 parent model 已读取或回复。
- 父侧 provider-visible carrier 为 user-role、`visibility: "model-only"`、`source: "subagent_message"` 的 synthetic input。
- 父侧消息内容使用 `<subagent-message>`，不能伪装成真实用户输入，也不能复用 `<task-notification>`。
- parent active 时，首次 model step 不读取 runtime command；只有后续 model step 在 compact/request prepare 前读取一次 command snapshot，并将其中的 `task-notification` / `subagent-message` 合流。snapshot 后到达的回复留给后续 step 或 outer queue，不增加 provider request 前的第二次扫描。parent idle 时由 runtime command queue 串行 wake。禁止新增并发 `executeTurnCommand()` 入口。
- `subagent-message` 不触发 background task 专属的 post-command goal continuation；已有 active goal 继续遵循现有普通 turn 语义。
- child 当前正在执行一个 tool batch 时不被中断；消息仍在该 batch 完成后、下一次 child model request 前由现有 steer drain 消费。
- `RespondToCoordinator` 可与 `Read`、`Glob`、`Grep` 等 concurrent-safe 工具进入同一 parallel group；不得为了与 `Bash`、`Write`、`Edit` 真并行而放宽现有 scheduler 安全规则。
- tool result 无论 enqueue 成功还是失败，都必须提醒 child 继续原任务，除非 coordinator 明确修改或终止目标；最终任务结果仍使用普通 assistant final / Agent completion 返回。
- 工具保持 `readOnly: false`、`sideEffectScope: "session"`。为 Plan mode 增加窄 `allowedInPlanMode` capability；它只能允许非破坏、无需审批的 session-local control action，且不得绕过全局 disallow、project deny 或 project ask。
- 回复指导只写入 `RespondToCoordinator.metadata.modelInstructions`。不得向所有 child 的 common system prompt 无条件注入一个可能不存在的工具名。
- `subagent_message` 除普通消息列表和标题外，也不得进入 `ReadSessionContext` 的用户可见历史摘要。
- P0 保留现有 child tool-event mirror：`RespondToCoordinator` 可作为 parent Agent card 内的嵌套 child tool block 展示以便观察；只有 synthetic reply carrier 必须禁止显示为顶层 user bubble。
- 不新增 app-to-agent RPC 方法。只为新的 synthetic source 更新 `packages/shared/src/zcode-protocol/index.ts` 运行时 schema。
- 桌面 `desktop-continuous` 和手机 `web-remote-replayable` 继续共享同一 host/agent runtime；本轮 E2E 只证明桌面主路径，shared protocol/visibility 单测证明 replayable payload 不被 schema 拒绝或渲染成用户气泡。
- 不修改 workspace identity、workspace path、remote session routing 或 client command queue 语义。
- 新增功能先写 spec 和 case/matrix，再写实现。
- 新增 bug 原因或不明显的 runtime ordering 注释使用中文。
- 最终必须运行 `pnpm typecheck` 和 `pnpm lint`。
- 当前工作区可能存在用户未提交改动。执行时禁止还原、覆盖或顺手提交无关改动；提交前必须检查 staged 文件集合。

---

## Acceptance Criteria

- [ ] 配有 subagent messaging capability 的 main provider-visible tools 包含现有 `SendMessage`，不包含 `RespondToCoordinator`。
- [ ] coordinator port 存在且未被全局禁用时，Explore、general-purpose 和 custom child provider-visible tools 包含 `RespondToCoordinator`，且不包含完整 `SendMessage`；port 缺失或全局禁用时工具与相关指导均不存在。
- [ ] main runtime 即使误注入 coordinator port 也不暴露 `RespondToCoordinator`；main 继续暴露 `SendMessage`。
- [ ] Explore 的 profile allowlist 和后续 `EXPLORE_AGENT_ALLOWED_TOOLS` 投影都不会再次移除该 child control tool，direct/embedded-search 两种分支均覆盖。
- [ ] Plan-mode child 可调用 `RespondToCoordinator`，工具仍保持非只读；全局 disallow、project deny/ask 继续优先。
- [ ] child 收到 `Message from coordinator: <summary>` 后，可以在同一个 assistant model step 中产出 `RespondToCoordinator` 和下一项工作 tool call。
- [ ] `RespondToCoordinator` tool result 写明“queued”而非“read/replied”，并提醒 child 继续当前任务。
- [ ] enqueue 失败的 tool result 也明确提醒 child 继续当前任务；P0 不承诺 parent process 销毁后的 durable delivery。
- [ ] parent active 时，`<subagent-message>` 与当前 tool results 一起进入下一次父 provider request，且 parent model request 最大并发数仍为 1。
- [ ] parent active turn 已无后续 roundtrip 时，command 留在 outer queue，并在该 turn terminal 后启动独立 model-only turn。
- [ ] parent idle 时，回复 command 自动启动 model-only turn。
- [ ] parent session store 中保留 synthetic message，但普通用户消息列表、标题输入和 UI 顶层消息中不可见。
- [ ] session hydrate 后，`subagent_message` 仍恢复为直接 user-like provider input，不被包装成旧 `queued_system_notification`。
- [ ] child response command 和随后发生的 Agent completion notification 均为 `priority: "next"`，按 enqueue 顺序消费；既允许合流到同一 provider request，也允许进入相邻请求，但回复的首次 provider-visible 位置必须早于 completion notification。
- [ ] coordinator port 缺失时工具不注册；异常手工调用返回明确 configuration error。
- [ ] XML 内容完成转义，20,000 字符输入上限生效。
- [ ] 顶层 synthetic user bubble 不可见；现有 mirror 下嵌套 `RespondToCoordinator` child tool block 可见且不结束 Agent task。
- [ ] `BG07` 继续只证明 main-to-child steer；新增 `BG25` 单独证明 child-to-main response 和 child continuation。

## Current Behavior Baseline

```text
main model
  -> SendMessage({ to, summary, message })
  -> SubagentPort.sendMessage()
  -> RuntimeTaskMessageSink.send()
  -> childRuntime.steerTurn()
  -> activeTurn.pendingInputs
  -> current child tool batch completes
  -> drainPendingInput()
  -> provider sees "Message from coordinator: ..."
```

当前关键事实：

- `apps/zcode-cli/packages/core/src/subagent/message-steering.ts` 已负责 coordinator 文案和 child steer。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts` 在下一次 model request 前 drain steer 和 active-loop runtime commands。
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts` 已负责 command 串行执行和 idle wake。
- `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts` 当前只处理 task notification persistence 和 active-loop intake。
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 是 child runtime、tool allowlist 和 parent closure 的组装入口。
- `apps/zcode-cli/packages/core/src/tool/scheduler.ts` 已根据 `concurrentSafe` 决定工具执行分组，本功能不修改调度算法。

## Target Data Flow

```text
child provider response
  -> RespondToCoordinator({ summary, message })
  -> CoordinatorResponsePort.respond()
  -> authoritative child identity is attached by runtime closure
  -> parent.enqueueSubagentMessage()
  -> RuntimeCommandQueue.enqueue(mode = "subagent-message", priority = "next")
  -> parent active: active-loop intake persists before next provider request
  -> parent idle: outer command drain persists and executes model-only turn
  -> parent provider sees <subagent-message>...</subagent-message>
```

Provider-visible payload：

```xml
<subagent-message>
<agent-id>agent_xxx</agent-id>
<agent-type>Explore</agent-type>
<summary>已完成权限入口检查</summary>
<message>目前定位到两个调用点，正在继续核对异常路径。</message>
</subagent-message>
```

## File Structure

### New files

| File                                                                                                                                | Responsibility                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `docs/subagent-respond-to-coordinator.md`                                                                                           | 产品语义、状态边界、非目标和验收标准的 source-of-truth spec                     |
| `apps/zcode-cli/packages/contracts/src/tools/respond-to-coordinator.ts`                                                             | tool input/runtime output schema 和常量                                         |
| `apps/zcode-cli/packages/contracts/src/interfaces/coordinator-response.port.ts`                                                     | child tool 到父 runtime 的窄端口                                                |
| `apps/zcode-cli/packages/core/src/tool/handlers/respond-to-coordinator.ts`                                                          | provider-visible tool metadata、handler 和 model result formatting              |
| `apps/zcode-cli/packages/core/src/subagent/coordinator-response.ts`                                                                 | 绑定 authoritative child identity，并把结构化回复提交给 parent enqueue callback |
| `apps/zcode-cli/packages/core/src/runtime/methods/subagent-messages.ts`                                                             | parent command enqueue、XML formatting、persistence                             |
| `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-active-loop.ts`                                                   | active loop 对允许 command 类型的统一 intake                                    |
| `apps/zcode-cli/packages/contracts/tests/respond-to-coordinator.test.ts`                                                            | schema 边界测试                                                                 |
| `apps/zcode-cli/packages/core/tests/runtime-tool-allowlist.test.ts`                                                                 | Explore/custom child 最终 built-in allowlist 投影测试                           |
| `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts`                       | 独立 formal BG25 replay spec，使用正常 context window                         |
| `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-respond-to-coordinator.json`        | BG25 case-local provider replay fixture                                         |
| `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-subagent-respond-to-coordinator.json`           | BG25 replay manifest                                                            |

### Modified files

| File                                                                           | Change                                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `docs/superpowers/plans/2026-07-10-subagent-respond-to-coordinator.md`         | 本可执行计划，随 Phase 0 纳入版本控制                                             |
| `docs/conversation-session-case-catalog.md`                                    | 新增 BG25 accepted case                                                           |
| `docs/testing/conversation-session-background-e2e-coverage-matrix.md`          | 增加 response channel 维度和 planned/covered 状态                                 |
| `docs/testing/conversation-session-e2e-coverage-matrix.md`                     | 登记 BG25                                                                         |
| 历史差异审计文档（已删除）                                        | 标记为 ZCode narrow extension，不误报为完整 Agent Teams 能力                      |
| `apps/zcode-cli/packages/contracts/src/tools/index.ts`                         | 导出 tool contract                                                                |
| `apps/zcode-cli/packages/contracts/src/index.ts`                               | 导出 coordinator port                                                             |
| `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`       | 增加 `subagent_message` synthetic source                                          |
| `packages/shared/src/zcode-protocol/index.ts`                                  | 接受 `subagent_message` source/inputSource                                        |
| `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`                      | 注册 child-only tool                                                              |
| `apps/zcode-cli/packages/core/src/tool/types.ts`                               | ToolExecutionContext 增加 coordinator port，并增加 `allowedInPlanMode` capability |
| `apps/zcode-cli/packages/core/src/tool/executor/types.ts`                      | executor options/deps 增加 coordinator port                                       |
| `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`                       | 透传 coordinator port                                                             |
| `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`                | 将 coordinator port 放入 handler context                                          |
| `apps/zcode-cli/packages/core/src/permission/service.ts`                       | 在既有 deny/ask 之后允许显式 Plan-mode session capability                         |
| `apps/zcode-cli/packages/core/src/runtime/types.ts`                            | AgentRuntimeDeps 增加 coordinator port                                            |
| `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`                    | 增加 `SubagentMessageRuntimeCommand`                                              |
| `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`                 | 声明 enqueue/persist intake 方法                                                  |
| `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`                    | 绑定新 runtime methods                                                            |
| `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-tools.ts`            | 条件注册工具并透传 port                                                           |
| `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`           | 在 Explore 最终交集后保留 child control tool                                      |
| `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts` | 移出 generic active-loop drain，保留 task notification 专属逻辑                   |
| `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`    | 执行 idle `subagent-message` command                                              |
| `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`                 | child tool allowlist 和 coordinator port wiring                                   |
| `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`           | 恢复 `subagent_message` user-like metadata                                        |
| `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`        | 映射 `subagent_message` runtime metadata                                          |
| `apps/zcode-cli/packages/core/src/session-context/parts.ts`                    | 从 ReadSessionContext 摘要中排除 internal coordinator reply                       |
| `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`                    | provider tool exposure 和 metadata 测试                                           |
| `apps/zcode-cli/packages/core/tests/runtime-hooks.test.ts`                     | handler/port 参数和 ack 测试                                                      |
| `apps/zcode-cli/packages/core/tests/permission-service.test.ts`                | Plan-mode capability 优先级测试                                                   |
| `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`                 | active/idle command、ordering 和单并发测试                                        |
| `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`                  | child tool surface、双向消息和继续工作测试                                        |
| `apps/zcode-cli/packages/core/tests/scheduler.test.ts`                         | concurrent-safe 分组边界回归                                                      |
| `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`          | hydrate 语义测试                                                                  |
| `apps/zcode-cli/packages/core/tests/read-session-context-tool.test.ts`         | model-only coordinator reply 不进入 session context                               |
| `packages/shared/test/zcodeProtocol.test.ts`                                   | protocol source 解析测试                                                          |
| `packages/shared/src/zcode-session-visible-content.ts`                         | 增加 `subagent_message` source-only visibility fallback                           |
| `packages/shared/test/zcodeSessionVisibleContent.test.ts`                      | model-only 消息不可见测试                                                         |
| `docs/design/v2/tool/00-tool-change-chain.md`                                  | 记录 `allowedInPlanMode` 的窄语义和禁止伪装 read-only 约束                        |
| `scripts/test-desktop-e2e-container.sh`                                        | Docker admission 后把正式 BG25 spec 纳入 verified preset                          |
| `docs/testing/conversation-session-docker-automation-plan.md`                  | Docker admission 工具同步准入记录                                                 |

## Phase Checklist

- [ ] Phase 0：锁定 spec、case 和非目标
- [ ] Phase 1：建立 contracts、protocol source 和窄端口
- [ ] Phase 2：实现 child-only tool 和 executor wiring
- [ ] Phase 3：实现 parent `subagent-message` runtime command
- [ ] Phase 4：接入 child runtime、tool-scoped guidance 和 continuation 行为
- [ ] Phase 5：补齐 persistence、hydrate、ordering 和失败分支
- [ ] Phase 6：完成独立 formal BG25 spec、fixture 和 replay E2E
- [ ] Phase 7：执行全量校验、审查 diff 并提交

## Acceptance Traceability

| Concern                                              | Implementation proof                                | Behavioral proof                                               |
| ---------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| child-only exposure / missing port / global disallow | Phase 2 registration gate + Phase 4 final allowlist | `tool-contracts`、`runtime-tool-allowlist`、`subagent-explore` |
| Plan mode without fake read-only                     | Phase 2 `allowedInPlanMode` capability              | `permission-service` + real executor integration               |
| active / idle / terminal-race serialization          | Phase 3 runtime command + active-loop intake        | `runtime-tool-loop`，含 max model concurrency = 1              |
| authoritative identity / enqueue failure             | Phase 4 closure-bound port                          | contract negative cases + adapter failure test                 |
| same-step response + continued child work            | Phase 4 child wiring and concurrent-safe metadata   | child integration + scheduler regression                       |
| FIFO across coalesced/separate requests              | Phase 3/5 `priority: "next"` command order          | `(requestIndex, contentIndex)` ordering tests                  |
| persistence / hydrate / visibility                   | Phase 1 protocol source + Phase 5 mappings          | shared visibility/title、hydrate、ReadSessionContext tests     |
| real provider/UI path                                | Phase 6 BG25                                        | capture、isolated/default replay、Docker admission             |

---

## Phase 0：Spec 与覆盖边界

### Task 1：写功能 spec 并登记 BG25

**Files:**

- Modify: `docs/superpowers/plans/2026-07-10-subagent-respond-to-coordinator.md`
- Create: `docs/subagent-respond-to-coordinator.md`
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify: 历史差异审计文档（已删除）

**Interfaces:**

- Consumes: 本计划的 Global Constraints、Acceptance Criteria 和 Target Data Flow。
- Produces: 实现和 E2E 使用的正式产品语义；稳定 case id `BG25`。

- [ ] **Step 0：确认 execution baseline 和工作区边界**

Run:

```bash
git rev-parse HEAD
git status --short
```

Expected: HEAD 为 `e458e18b902a467251153972688ca8461eb5a418`，除本 plan 外没有未识别改动。若 HEAD 不同，先审查 branch drift 并更新 `Execution Baseline`；若有用户改动，记录路径并在后续每次 staged-path gate 中排除。

- [ ] **Step 1：创建 feature spec**

`docs/subagent-respond-to-coordinator.md` 必须完整写入以下内容：

```markdown
# Subagent RespondToCoordinator

## Goal

普通 subagent 收到 main 通过 SendMessage 发来的 coordinator 消息后，可以通过
RespondToCoordinator 把回复投递给父 runtime，同时继续原任务。

## Product Contract

- SendMessage 保持 main-only。
- RespondToCoordinator 保持 child-only，输入为 summary 和 message。
- runtime 绑定 child identity 和 parent route，模型不能选择目标。
- 成功只表示已进入 parent runtime command queue。
- 工具只在 child runtime 已配置 coordinator port 且未被全局禁用时出现；相关指导只随工具 description 出现。
- parent active 时在下一次合法 model request 前合流；idle 时启动 model-only turn。
- parent provider-visible payload 为 user-like <subagent-message>。
- persisted source 为 subagent_message，visibility 为 model-only。
- child final assistant text 仍表示任务最终结果；RespondToCoordinator 不结束任务。
- RespondToCoordinator 保持 readOnly=false、sideEffectScope=session；Plan mode 通过显式 allowedInPlanMode capability 放行，且不绕过 disallow/project deny/project ask。
- synthetic reply 不显示为顶层 user message，也不参与标题或 ReadSessionContext；现有 child tool mirror 可在 parent Agent card 内展示 RespondToCoordinator tool block。

## Scheduling

RespondToCoordinator concurrentSafe=true。它可以和其它 concurrent-safe 工具并行；
Bash、Write、Edit 仍遵循现有安全串行规则。模型应优先发出回复调用，并在同一
assistant step 中继续发出下一项工作工具调用。

## Failure Semantics

- coordinator port 未配置：工具不注册。
- 测试强制注册但未配置 port：handler 抛明确 configuration error。
- enqueue callback 抛错：工具返回 failed result，并明确提醒 child 继续工作。
- parent runtime/process 已销毁：当前 queue 无 disposed acknowledgement，P0 不宣称可探测该状态，也不提供 durable retry/outbox。
- 单个长时间工具未返回：child model 尚未重新获得控制，不能即时调用回复工具。

## Out Of Scope

- 完整 Agent Teams、teammate mailbox、sibling routing。
- child 侧完整 SendMessage。
- replyTo、消息已读回执、durable inbox/outbox。
- 中断正在执行的单个工具。
- 修改 scheduler 使 Bash/Write/Edit 与回复工具强制并行。
- 新增 app-to-agent RPC。
- 隐藏 parent Agent card 内已有的 child tool observability。
```

- [ ] **Step 2：在 case catalog 新增 BG25**

在 BG 表追加：

```markdown
| BG25 | `running`，background Agent 正在长程任务中，且已收到 main 的 `SendMessage` coordinator input | child 在下一次 model step 调用 `RespondToCoordinator`，并同时继续普通工作 tool call | subagentBidirectionalCoordinatorMessage + modelOnlySyntheticInput | 回复通过 parent runtime command queue 投递；parent active 时合流、idle 时 wake；provider request 包含 `<subagent-message>`；UI 不显示真实 user 气泡；child 在回复后继续原任务并最终正常 completion | accepted |
```

- [ ] **Step 3：更新 background 和主 coverage matrix**

新增维度与 planned row：

```markdown
| child response channel | RespondToCoordinator + continued work | active parent in core; idle parent in E2E | 不覆盖 sibling/teammate routing |
```

```markdown
| `BGR` | `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts` |

| BG25 | planned | BGR、RT | BGR 验证 SendMessage -> RespondToCoordinator + continued child tool -> parent model-only `<subagent-message>` -> child completion；RT 覆盖 active/idle command intake、FIFO ordering 和单模型请求并发 |
```

- [ ] **Step 4：更新 subagent historical gap audit**

增加一条 scope note，明确：

```markdown
RespondToCoordinator 是 ZCode 为普通 local_agent 增加的窄 child-to-parent reply channel。
它不表示已实现 Agent Teams，也不改变默认 main-only SendMessage 的语义。
```

- [ ] **Step 5：运行文档覆盖审计**

Run:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
```

Expected: exit code `0`，BG25 在 catalog 和 matrix 中能够互相映射；不存在 duplicate id 或 missing matrix row。

- [ ] **Step 6：审查 Phase 0 diff**

Run:

```bash
git add docs/superpowers/plans/2026-07-10-subagent-respond-to-coordinator.md docs/subagent-respond-to-coordinator.md docs/conversation-session-case-catalog.md docs/testing/conversation-session-background-e2e-coverage-matrix.md docs/testing/conversation-session-e2e-coverage-matrix.md docs/subagent-historical-gap-audit.md
git diff --cached --check
git diff --cached --name-only
```

Expected: 无 whitespace error，且 cached paths 恰好是上面六个文档。先 stage 再检查是必要的，因为本 plan 和新 spec 在 Phase 0 开始时是 untracked，普通 `git diff` 看不到它们。

- [ ] **Step 7：提交 Phase 0**

只有在这些文件没有混入用户未提交改动时执行：

```bash
git diff --cached --name-only
git commit -m "docs: specify subagent coordinator responses"
```

Expected staged paths: 仅上面六个文档。若任一文件已有不可分离的用户改动，停止该 commit，保留改动并在交付说明中列出。

---

## Phase 1：Contracts 与 Protocol

### Task 2：定义 RespondToCoordinator schema 和 CoordinatorResponsePort

**Files:**

- Create: `apps/zcode-cli/packages/contracts/src/tools/respond-to-coordinator.ts`
- Create: `apps/zcode-cli/packages/contracts/src/interfaces/coordinator-response.port.ts`
- Create: `apps/zcode-cli/packages/contracts/tests/respond-to-coordinator.test.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/tools/index.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/index.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`
- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Modify: `packages/shared/test/zcodeProtocol.test.ts`

**Interfaces:**

- Consumes: spec 中固定的 `{ summary, message }` 输入和同步 enqueue 语义。
- Produces:

```ts
export const RESPOND_TO_COORDINATOR_TOOL_NAME = "RespondToCoordinator";
export interface CoordinatorResponsePort {
  respond(request: CoordinatorResponseRequest): CoordinatorResponseResult;
}
```

- [ ] **Step 1：先写 contracts failing tests**

创建 `apps/zcode-cli/packages/contracts/tests/respond-to-coordinator.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS,
  RespondToCoordinatorInputSchema,
  RespondToCoordinatorOutputSchema,
} from "../src/index.js";

describe("RespondToCoordinator contract", () => {
  it("accepts summary and message only", () => {
    expect(
      RespondToCoordinatorInputSchema.parse({
        summary: "进度更新",
        message: "已完成入口定位，正在验证异常路径。",
      }),
    ).toEqual({
      summary: "进度更新",
      message: "已完成入口定位，正在验证异常路径。",
    });
    expect(() =>
      RespondToCoordinatorInputSchema.parse({
        to: "agent_parent",
        summary: "进度更新",
        message: "继续检查。",
      }),
    ).toThrow();
  });

  it("enforces content limits", () => {
    expect(() => RespondToCoordinatorInputSchema.parse({ summary: "", message: "x" })).toThrow();
    expect(() =>
      RespondToCoordinatorInputSchema.parse({
        summary: "x",
        message: "x".repeat(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS + 1),
      }),
    ).toThrow();
  });

  it("keeps provider-private routing fields out of runtime output", () => {
    expect(
      RespondToCoordinatorOutputSchema.parse({
        status: "success",
        responseId: "response_1",
        message: "Response queued for the coordinator.",
      }),
    ).toMatchObject({ status: "success", responseId: "response_1" });

    for (const routingField of ["agentId", "childSessionId", "parentSessionId", "to"]) {
      expect(() =>
        RespondToCoordinatorOutputSchema.parse({
          status: "success",
          responseId: "response_1",
          message: "Response queued for the coordinator.",
          [routingField]: "model_supplied_route",
        }),
      ).toThrow();
    }
  });
});
```

- [ ] **Step 2：运行 contracts test，确认先失败**

Run:

```bash
pnpm --filter @zcode/contracts exec vitest run tests/respond-to-coordinator.test.ts
```

Expected: FAIL，提示 `RespondToCoordinatorInputSchema` 等 export 不存在。

- [ ] **Step 3：实现 tool schemas**

`apps/zcode-cli/packages/contracts/src/tools/respond-to-coordinator.ts`：

```ts
import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESPOND_TO_COORDINATOR_TOOL_NAME = "RespondToCoordinator";
export const RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS = 20_000;

export const RespondToCoordinatorInputSchema = z
  .object({
    summary: z.string().min(1).max(200).describe("Short summary of the response."),
    message: z
      .string()
      .min(1)
      .max(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS)
      .describe("Response or progress update for the coordinator."),
  })
  .strict();

export type RespondToCoordinatorInput = z.infer<typeof RespondToCoordinatorInputSchema>;
export const RespondToCoordinatorInputJsonSchema = toToolJsonSchema(
  RespondToCoordinatorInputSchema,
);

export const RespondToCoordinatorOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    responseId: z.string(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type RespondToCoordinatorOutput = z.infer<typeof RespondToCoordinatorOutputSchema>;
```

- [ ] **Step 4：实现同步窄端口**

`apps/zcode-cli/packages/contracts/src/interfaces/coordinator-response.port.ts`：

```ts
import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface CoordinatorResponseRequest {
  childToolCallId: ToolCallId | string;
  summary: string;
  message: string;
  trace: TraceContext;
}

export interface CoordinatorResponseResult {
  status: "success" | "failed";
  responseId: string;
  message: string;
  error?: string;
}

export interface CoordinatorResponsePort {
  // child session/agent/parent identity 由 port closure 绑定；request 只携带 handler 生成的数据。
  // 同步返回确保 response command 已进入父队列后，child tool result 才能完成。
  respond(request: CoordinatorResponseRequest): CoordinatorResponseResult;
}
```

`SessionId` 不再由 `CoordinatorResponseRequest` 导入；child session identity 在 Phase 4 的 `CreateCoordinatorResponsePortOptions` 中固定，避免 handler 或后续调用者把 identity 当作可路由字段。

在 `tools/index.ts` 导出 `./respond-to-coordinator.js`，在 contracts root `index.ts` 导出 `./interfaces/coordinator-response.port.js`。

- [ ] **Step 5：增加 synthetic source 和 protocol schema**

在两个枚举中加入同一字符串：

```ts
"subagent_message",
```

修改位置：

- `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`
- `packages/shared/src/zcode-protocol/index.ts`

在 `packages/shared/test/zcodeProtocol.test.ts` 增加 user message 和 TurnStarted payload 对 `subagent_message` 的成功解析断言。

- [ ] **Step 6：运行 focused tests**

Run:

```bash
pnpm --filter @zcode/contracts exec vitest run tests/respond-to-coordinator.test.ts
pnpm exec vitest run packages/shared/test/zcodeProtocol.test.ts
```

Expected: PASS。

- [ ] **Step 7：运行 contracts/shared typecheck**

Run:

```bash
pnpm --filter @zcode/contracts typecheck
pnpm exec tsc -p packages/shared/tsconfig.json --noEmit
```

Expected: 两条命令 exit code `0`。

- [ ] **Step 8：提交 Phase 1**

```bash
git add apps/zcode-cli/packages/contracts/src/tools/respond-to-coordinator.ts apps/zcode-cli/packages/contracts/src/interfaces/coordinator-response.port.ts apps/zcode-cli/packages/contracts/src/tools/index.ts apps/zcode-cli/packages/contracts/src/index.ts apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts apps/zcode-cli/packages/contracts/tests/respond-to-coordinator.test.ts packages/shared/src/zcode-protocol/index.ts packages/shared/test/zcodeProtocol.test.ts
git diff --cached --name-only
git commit -m "feat(cli): define subagent coordinator response contracts"
```

Expected staged paths: 仅 Phase 1 文件。

---

## Phase 2：Child-only Tool Surface

### Task 3：实现 RespondToCoordinator handler 和依赖注入

**Files:**

- Create: `apps/zcode-cli/packages/core/src/tool/handlers/respond-to-coordinator.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/permission/service.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-tools.ts`
- Modify: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/runtime-hooks.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/permission-service.test.ts`
- Modify: `docs/design/v2/tool/00-tool-change-chain.md`

**Interfaces:**

- Consumes: `CoordinatorResponsePort`、tool input/output schemas。
- Produces: `respondToCoordinatorToolEntry`；`ToolExecutionContext.coordinatorResponsePort`；conditional registration flag `includeRespondToCoordinator`；不伪装 read-only 的 `allowedInPlanMode` permission capability。

- [ ] **Step 1：先写 tool exposure failing tests**

在 `tool-contracts.test.ts` 增加：

```ts
it("only exposes RespondToCoordinator when coordinator response is configured", () => {
  const defaultRegistry = createToolRegistry();
  registerBuiltInTools(defaultRegistry);

  const childRegistry = createToolRegistry();
  registerBuiltInTools(childRegistry, { includeRespondToCoordinator: true });

  expect(defaultRegistry.has("RespondToCoordinator")).toBe(false);
  expect(childRegistry.has("RespondToCoordinator")).toBe(true);
  expect(childRegistry.get("RespondToCoordinator")?.metadata).toMatchObject({
    allowedInPlanMode: true,
    concurrentSafe: true,
    needsApproval: false,
    readOnly: false,
    sideEffectScope: "session",
  });
});
```

同时断言：

- provider input schema 只有 `summary`、`message`，provider output schema 只有 `success`、`message`；
- provider description 包含精确触发提示 `Message from coordinator:`、调用回复工具而非 assistant text、回复后继续原任务；
- 未注册工具的 registry/provider contracts 中不存在该 description，证明没有 common prompt 残留指导；
- `disallowedTools: ["RespondToCoordinator"]` 即使与 `includeRespondToCoordinator: true` 同时传入也会最终移除工具。

- [ ] **Step 2：先写 handler failing test**

在 `runtime-hooks.test.ts` 构造一个 `CoordinatorResponsePort` spy，通过 tool executor 调用：

```ts
{
  id: "call_respond_to_coordinator",
  name: "RespondToCoordinator",
  input: {
    summary: "权限链路进度",
    message: "已完成入口检查，继续验证异常路径。",
  },
}
```

断言 port 收到 `childToolCallId`、`summary`、`message` 和 trace，且 request 中没有 `childSessionId`、`agentId` 或 parent route；断言 tool result 包含 `queued for the coordinator` 和 `Continue the current task`。

再增加两个分支：

1. 强制注册工具但不给 executor coordinator port，调用后断言 `ConfigurationError` 文案为 `Coordinator response port is not configured for RespondToCoordinator`。
2. port 返回 `{ status: "failed", responseId: "response_failed", message: "Response failed to queue.", error: "injected enqueue failure" }`，断言 provider-visible result 同时包含失败原因和 `Continue the current task`。

最后让 executor 的 `getMode()` 返回 `plan`，使用真实 tool entry 和已配置 port 调用一次，断言无需 permission broker 即成功到达 port。这条 integration assertion 证明 metadata -> permission-flow -> PermissionService 的 capability 没有在透传中丢失。

- [ ] **Step 3：先写 Plan-mode capability failing tests**

在 `permission-service.test.ts` 定义 `allowedInPlanMode: true`、`readOnly: false`、`sideEffectScope: "session"`、`destructive: false`、`needsApproval: false` 的 response capability，并覆盖：

```text
plan + explicit session capability -> allow / mode.plan.explicitSessionCapability
plan + 同一 capability + global disallow -> deny / rule.disallowedTools
plan + 同一 capability + project deny -> deny / rule.project.deny
plan + 同一 capability + project ask -> ask / rule.project.ask
plan + 非只读 session capability 但没有 allowedInPlanMode -> deny / mode.plan.nonReadOnly
plan + allowedInPlanMode 但 destructive/needsApproval/非 session -> deny / mode.plan.nonReadOnly
```

这些断言固定优先级：新 capability 不能绕过已有显式策略。

- [ ] **Step 4：运行 tests，确认先失败**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/tool-contracts.test.ts tests/runtime-hooks.test.ts -t "RespondToCoordinator"
pnpm --filter @zcode/core exec vitest run tests/permission-service.test.ts -t "explicit session capability|non-read-only session"
```

Expected: FAIL，工具尚未注册、context 缺少 port，且 permission capability 尚不存在。

- [ ] **Step 5：实现 Plan-mode capability，不修改 read-only 语义**

依次增加可选字段：

```ts
allowedInPlanMode?: boolean;
```

修改位置：

- `ToolMetadata`
- `ToolRuntimePermissionCapability`
- `PermissionToolCapability`
- `ResolvedPermissionCapability`
- `PermissionService.resolveCapability()`

`checkPlanMode()` 保留现有 read-only 和 non-destructive MCP 分支，并在 generic deny 之前增加：

```ts
if (
  capability.allowedInPlanMode &&
  capability.sideEffectScope === "session" &&
  !capability.destructive &&
  !capability.needsApproval
) {
  return this.allow(
    context,
    capability,
    "mode.plan.explicitSessionCapability",
    "Plan mode allows this explicit non-destructive session control action",
  );
}
```

不要改 `checkPermission()` 中现有顺序：global disallow、project deny、project ask 必须继续先于 `checkPlanMode()`。不要把 `RespondToCoordinator` 或其它 session mutation 标记为 `readOnly: true`。

- [ ] **Step 6：实现 handler**

`respond-to-coordinator.ts` 必须遵循 `send-message.ts` 的 provider/runtime output 分离方式：

```ts
const respondToCoordinatorHandler: ToolHandler = async (input, context) => {
  const parsed = RespondToCoordinatorInputSchema.parse(input);
  if (context.runtimeScope !== "subagent" || !context.coordinatorResponsePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Coordinator response port is not configured for RespondToCoordinator",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: RESPOND_TO_COORDINATOR_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.coordinatorResponsePort.respond({
    childToolCallId: context.toolCallId,
    summary: parsed.summary,
    message: parsed.message,
    trace: context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    },
  });
};
```

provider-visible output schema 和 formatter 固定为：

```ts
const RESPOND_TO_COORDINATOR_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

function formatRespondToCoordinatorModelContent(output: unknown): string {
  const result = RespondToCoordinatorOutputSchema.parse(output);
  const continuation =
    "Continue the current task unless the coordinator explicitly changed or ended it.";
  if (result.status === "success") {
    return `Response ${result.responseId} was queued for the coordinator. ${continuation}`;
  }
  return `Response ${result.responseId} failed to queue for the coordinator: ${result.error ?? result.message}. ${continuation}`;
}
```

metadata 必须包含：

```ts
{
  name: RESPOND_TO_COORDINATOR_TOOL_NAME,
  description: "Respond to the coordinator that owns this subagent.",
  modelInstructions: [
    'When you receive an input beginning with "Message from coordinator:", use this tool to answer it.',
    "Use this tool for a concise response or progress update to the coordinator.",
    "When replying while work remains, do not use assistant text as the reply.",
    "Place this call before or alongside the next work tool call when possible.",
    "Continue the current task unless the coordinator explicitly changed or ended it.",
    "Do not use this tool as a substitute for the final task result.",
  ],
  allowedInPlanMode: true,
  readOnly: false,
  destructive: false,
  concurrentSafe: true,
  timeoutMs: 10_000,
  maxOutputBytes: 4_096,
  sideEffectScope: "session",
  riskLevel: "low",
  needsApproval: false,
}
```

ToolEntry 的其余 contract policy 固定为：

```ts
{
  permission: {
    permission: "agent.message.respond",
    reason: "RespondToCoordinator writes a message to the parent runtime queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 4_096,
    maxModelBytes: 4_096,
    strategy: "truncate",
    preview: { maxBytes: 4_096, direction: "head" },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "RespondToCoordinator was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
}
```

成功 model content：

```text
Response <responseId> was queued for the coordinator. Continue the current task unless the coordinator explicitly changed or ended it.
```

- [ ] **Step 7：透传 coordinator port**

依次增加可选字段：

```ts
coordinatorResponsePort?: CoordinatorResponsePort;
```

修改链路：

```text
AgentRuntimeDeps
  -> initializeRuntimeTooling/createToolExecutor
  -> ToolExecutorOptions/ToolExecutorDeps
  -> call-runner ToolExecutionContext
  -> RespondToCoordinator handler
```

`registerRuntimeBuiltInTools()` 使用：

```ts
includeRespondToCoordinator:
  runtime.config.taskType === "subagent_child" &&
  Boolean(deps.coordinatorResponsePort),
```

因此 main runtime 即使被测试错误注入 port 也不能注册工具。handler 的 `runtimeScope === "subagent"` 检查继续保留，作为 defense-in-depth。

- [ ] **Step 8：条件注册工具**

在 `handlers/index.ts` import `respondToCoordinatorToolEntry` 并加入 `builtInTools`，否则 registry 永远不会遍历到新工具：

```ts
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";

export const builtInTools: ToolEntry[] = [
  // existing entries...
  respondToCoordinatorToolEntry,
];
```

然后在 `RegisterBuiltInToolsOptions` 增加 `includeRespondToCoordinator?: boolean`，并在 `registerBuiltInTools()` 增加过滤：

```ts
if (
  entry.metadata.name === RESPOND_TO_COORDINATOR_TOOL_NAME &&
  options.includeRespondToCoordinator !== true
) {
  continue;
}
```

此阶段不改变通用 allowed/disallowed filtering；`disallowedTools` 仍在 registry 最终投影生效。Phase 4 同时修正 child profile allowlist 和 Explore 最终 built-in allowlist。

- [ ] **Step 9：记录 capability 设计约束**

更新 `docs/design/v2/tool/00-tool-change-chain.md`：

- `allowedInPlanMode` 只表示一个显式、非破坏、无需审批的 session-local control action 可在 Plan mode 执行；
- 它不等于 read-only，也不允许网络/workspace mutation；
- explicit disallow、project deny/ask 继续优先；
- `RespondToCoordinator` 是首个使用者，后续工具必须单独经过 permission tests。

- [ ] **Step 10：运行 focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/tool-contracts.test.ts tests/runtime-hooks.test.ts -t "RespondToCoordinator"
pnpm --filter @zcode/core exec vitest run tests/permission-service.test.ts -t "explicit session capability|non-read-only session"
```

Expected: PASS。

- [ ] **Step 11：提交 Phase 2**

```bash
git add apps/zcode-cli/packages/core/src/tool/handlers/respond-to-coordinator.ts apps/zcode-cli/packages/core/src/tool/handlers/index.ts apps/zcode-cli/packages/core/src/tool/types.ts apps/zcode-cli/packages/core/src/tool/executor/types.ts apps/zcode-cli/packages/core/src/tool/executor/impl.ts apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts apps/zcode-cli/packages/core/src/permission/service.ts apps/zcode-cli/packages/core/src/runtime/types.ts apps/zcode-cli/packages/core/src/runtime/helpers/runtime-tools.ts apps/zcode-cli/packages/core/tests/tool-contracts.test.ts apps/zcode-cli/packages/core/tests/runtime-hooks.test.ts apps/zcode-cli/packages/core/tests/permission-service.test.ts docs/design/v2/tool/00-tool-change-chain.md
git diff --cached --name-only
git commit -m "feat(cli): add RespondToCoordinator tool"
```

---

## Phase 3：Parent Runtime Command

### Task 4：实现 subagent-message active intake 和 idle wake

**Files:**

- Create: `apps/zcode-cli/packages/core/src/runtime/methods/subagent-messages.ts`
- Create: `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-active-loop.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
- Modify: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**

- Consumes: structured child identity/message from Phase 2 port adapter。
- Produces:

```ts
enqueueSubagentMessage(input: EnqueueSubagentMessageInput): undefined;
persistSubagentMessageCommand(command: SubagentMessageRuntimeCommand): Promise<MessageId>;
```

- [ ] **Step 1：写 active parent failing test**

在 `runtime-tool-loop.test.ts` 新增 test：

```text
parent model request #1 -> NotifyWithSubagentMessage tool
tool handler -> runtime.enqueueSubagentMessage(...)
parent model request #2 -> 必须同时看见 tool result 和 <subagent-message>
```

断言：

```ts
expect(modelCallCount).toBe(2);
expect(maxConcurrentModelCalls).toBe(1);
expect(secondRequestText).toContain("tool-ok");
expect(secondRequestText).toContain("<subagent-message>");
expect(secondRequestText).toContain("<agent-id>agent_progress</agent-id>");
expect(secondRequestText).toContain("继续验证异常路径");
```

- [ ] **Step 2：写 idle parent failing test**

构造已完成首轮的 runtime，调用私有测试入口 `enqueueSubagentMessage()`，等待 model call count 增加。断言 wake request 最新 user-like message 包含 `<subagent-message>`，TurnStarted payload 为：

```ts
{
  inputSource: "subagent_message",
  inputVisibility: "model-only",
}
```

- [ ] **Step 3：写 terminal-race failing test**

使用 deferred model response 精确制造“active turn 已经完成本轮 drain，但最后一个 provider request 仍在飞行”的窗口：

```text
parent final request #1 starts and is held
enqueueSubagentMessage(response_terminal_race)
release request #1 with assistant final and no tool calls
active turn reaches terminal
outer runtime command queue starts exactly one model-only request #2
```

断言 request #1 不包含该 marker，request #2 包含 `<subagent-message>`；`modelCallCount === 2`、`maxConcurrentModelCalls === 1`，且没有第三次 wake。这个测试专门覆盖 Acceptance Criteria 中“active turn 已无后续 roundtrip”的分支。

- [ ] **Step 4：写 XML escaping failing test**

直接测试 `formatSubagentMessage()`，让 `agentId`、`agentType`、`summary`、`message` 都包含 `<>&"'` 以及 `</message><task-notification>` 注入文本。断言：

- 只有一个 `<subagent-message>` root 和一个合法 closing tag；
- payload 中不存在原始注入 closing sequence；
- 五类 XML 特殊字符均按现有 `escapeXml()` 规则转义；
- 转义后仍可区分四个字段内容。

- [ ] **Step 5：运行 tests，确认先失败**

本 Phase 新增 test title 统一包含 `subagent message`，确保下面的 focused filter 会覆盖 active、idle、terminal race 和 XML escaping 四组断言。

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts -t "subagent message"
```

Expected: FAIL，`enqueueSubagentMessage` 或 command mode 尚不存在。

- [ ] **Step 6：扩展 runtime command union**

先在 `runtime/types.ts` 定义唯一的 enqueue input，adapter、runtime method 和 tests 都复用该类型：

```ts
export interface EnqueueSubagentMessageInput {
  responseId: string;
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  childToolCallId: string;
  parentToolCallId?: string;
  summary: string;
  message: string;
  traceContext: TraceContext;
}
```

在 `command-queue.ts` 增加：

```ts
export interface SubagentMessageRuntimeCommand extends RuntimeCommandBase {
  readonly mode: "subagent-message";
  readonly source: "subagent_message";
  readonly responseId: string;
  readonly agentId: string;
  readonly agentType: string;
  readonly childSessionId: string;
  readonly childToolCallId: string;
  readonly parentToolCallId?: string;
  readonly summary: string;
  readonly messageLength: number;
  readonly text: string;
}
```

并把 `"subagent-message"` 加入 `RuntimeCommandMode`，把 interface 加入 `RuntimeCommand` union。

- [ ] **Step 7：实现 XML formatter、enqueue 和 persistence**

`subagent-messages.ts` 使用现有 `escapeXml()`：

```ts
export function formatSubagentMessage(input: {
  agentId: string;
  agentType: string;
  summary: string;
  message: string;
}): string {
  return [
    "<subagent-message>",
    `<agent-id>${escapeXml(input.agentId)}</agent-id>`,
    `<agent-type>${escapeXml(input.agentType)}</agent-type>`,
    `<summary>${escapeXml(input.summary)}</summary>`,
    `<message>${escapeXml(input.message)}</message>`,
    "</subagent-message>",
  ].join("\n");
}
```

enqueue 使用：

```ts
this.enqueueRuntimeCommand({
  responseId: input.responseId,
  agentId: input.agentId,
  agentType: input.agentType,
  childSessionId: input.childSessionId,
  childToolCallId: input.childToolCallId,
  ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
  summary: input.summary,
  messageLength: input.message.length,
  traceContext: input.traceContext,
  createdAt: new Date(),
  id: createRuntimeCommandId(),
  mode: "subagent-message",
  priority: "next",
  source: "subagent_message",
  text: formatSubagentMessage(input),
});
```

`enqueueSubagentMessage()` 必须保持同步：return 时 command 已进入 queue；这就是 tool success ack 的完整语义。它不能直接调用 `executeTurnCommand()`，也不能根据 active/idle 状态另开 provider request。

persistence 使用完整函数，显式创建并返回 `MessageId`：

```ts
export async function persistSubagentMessageCommand(
  this: AgentRuntimeInternal,
  command: SubagentMessageRuntimeCommand,
): Promise<MessageId> {
  await this.ensureContextInitialized(command.traceContext);
  const messageID = createMessageId();
  this.messageHistory.addUser(command.text, legacySyntheticRuntimeMetadata());
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "subagent_message",
    text: command.text,
    traceContext: command.traceContext,
    visibility: "model-only",
    metadata: {
      subagentMessage: {
        responseId: command.responseId,
        agentId: command.agentId,
        agentType: command.agentType,
        childSessionId: command.childSessionId,
        childToolCallId: command.childToolCallId,
        ...(command.parentToolCallId ? { parentToolCallId: command.parentToolCallId } : {}),
      },
    },
  });
  return messageID;
}
```

- [ ] **Step 8：提取 generic active-loop intake**

把 `drainPendingRuntimeCommandsForActiveLoop()` 从 `background-notifications.ts` 移到新文件 `runtime-command-active-loop.ts`。只消费白名单 command：

```ts
switch (removed.mode) {
  case "task-notification":
    if (shouldSuppressTaskNotificationRuntimeCommand.call(this, removed)) continue;
    messageId = await persistBackgroundTaskNotificationCommand.call(this, removed);
    break;
  case "subagent-message":
    messageId = await persistSubagentMessageCommand.call(this, removed);
    break;
  default:
    continue;
}
```

实现时仅在 `modelStepCount > 0` 的 active-loop 边界读取一次 `priority <= next` 的 command snapshot，按 snapshot 原顺序消费其中的 `task-notification` / `subagent-message`。首次 model step 不读取 runtime command；compact、MCP 初始化和 request prepare 完成后不再进行第二次扫描；snapshot 处理期间新入队的 command 也不加入当前批次。普通 `prompt`、target continuation 仍留在 outer queue。错过 snapshot 的 command 不丢弃、不并发执行，由后续 active step 或 turn terminal 后的 outer queue 处理。

- [ ] **Step 9：实现 idle command 执行**

在 `runRuntimeCommand()` 增加独立分支：

```ts
if (command.mode === "subagent-message") {
  const messageId = await persistSubagentMessageCommand.call(this, command);
  await this.executeTurnCommand(command.text, undefined, {
    inputSource: "subagent_message",
    inputVisibility: "model-only",
    recordedInputMessageId: messageId,
    skipInputRecord: true,
    skipUserPromptSubmitHooks: true,
    traceContext: command.traceContext,
  });
  return;
}
```

不得调用 `runPostCommandActiveTargetLoop()`；该行为只保留给 `task-notification`。

- [ ] **Step 10：使用低频 debug/warn 日志**

- enqueue/start/completed 使用 `debug`，字段包括 `responseId`、`agentId`、`commandId`、`queueSize`。
- command execution failure 使用现有 `warn` 分支。
- 日志不得写完整 `message` 内容，只写 `messageLength` 和 `summary` 截断值。

- [ ] **Step 11：运行 active/idle/terminal-race tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts -t "subagent message"
pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts -t "runtime task notifications before the next active tool-loop"
```

Expected: 新测试 PASS；既有 task notification active-loop test 继续 PASS。

- [ ] **Step 12：提交 Phase 3**

```bash
git add apps/zcode-cli/packages/core/src/runtime/methods/subagent-messages.ts apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-active-loop.ts apps/zcode-cli/packages/core/src/runtime/command-queue.ts apps/zcode-cli/packages/core/src/runtime/types.ts apps/zcode-cli/packages/core/src/runtime/internal-methods.ts apps/zcode-cli/packages/core/src/runtime/methods/index.ts apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts
git diff --cached --name-only
git commit -m "feat(cli): route subagent messages through runtime commands"
```

---

## Phase 4：Child Runtime Wiring 与 Continuation

### Task 5：把 authoritative child identity 绑定到 CoordinatorResponsePort

**Files:**

- Create: `apps/zcode-cli/packages/core/src/subagent/coordinator-response.ts`
- Create: `apps/zcode-cli/packages/core/tests/runtime-tool-allowlist.test.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/scheduler.test.ts`

**Interfaces:**

- Consumes: `CoordinatorResponsePort`、`AgentRuntimeInternal.enqueueSubagentMessage()`。
- Produces: 所有 production child runtime 的 `coordinatorResponsePort`；child-only forced control tool；不会被 Explore 最终交集二次移除的 allowlist。

- [ ] **Step 1：写 child tool surface failing tests**

在 `subagent-explore.test.ts` 分别启动 direct Explore、embedded-search Explore、general-purpose、`tools: ["Read"]` 的 custom child，断言：

```ts
expect(childToolNames).toContain("RespondToCoordinator");
expect(childToolNames).not.toContain("SendMessage");
expect(childToolNames).not.toContain("Agent");
```

main request 继续断言：

```ts
expect(mainToolNames).toContain("SendMessage");
expect(mainToolNames).not.toContain("RespondToCoordinator");
```

另外覆盖四个负向 surface：

```text
child config + missing coordinator port -> tool absent
child config + global toolDisallowlist -> tool absent
main config + accidentally injected coordinator port -> tool absent
tool absent -> provider tool descriptions/common system notes 均不包含 RespondToCoordinator
```

在新建的 `runtime-tool-allowlist.test.ts` 直接测试 `resolveBuiltInToolAllowlist()`：Explore child 在 `EXPLORE_AGENT_ALLOWED_TOOLS` 交集后仍包含回复工具；main Explore 不会被添加；custom child 的显式 `Read` allowlist 变成 `Read + RespondToCoordinator`；general child 的 `undefined` 仍保持 `undefined`（表示不做 built-in allowlist 过滤）。

- [ ] **Step 2：写 reply + continued work failing integration test**

扩展现有 `can SendMessage to a running background local_agent` 附近测试，使用以下脚本化模型序列：

```text
child request #1 -> BlockingTool
main -> SendMessage
BlockingTool resolves
child request #2 sees Message from coordinator
child response #2 -> RespondToCoordinator + Read
child request #3 sees both tool results -> another normal work tool
child request #4 -> final assistant result
parent receives <subagent-message> before <task-notification>, either in one request or two
```

关键断言：

```ts
expect(childSecondToolCalls.map((call) => call.name)).toEqual(["RespondToCoordinator", "Read"]);
expect(childRequests).toHaveLength(4);
expect(parentMessageText).toContain("<subagent-message>");
expect(parentMessageText).toContain("权限链路进度");
expectProviderMarkerBefore(parentRequests, "<subagent-message>", "<task-notification>");
```

`expectProviderMarkerBefore()` 比较 marker 的“首次 provider-visible 位置” `(requestIndex, contentIndex)`：request index 较小即在前；若两个 `priority: "next"` command 被同一次 active-loop drain 合流，则比较同一 request 内的 content index。不要使用严格的 `parentMessageRequestIndex < parentCompletionRequestIndex`，因为同请求合流是合法行为。

- [ ] **Step 3：运行 tests，确认先失败**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts -t "RespondToCoordinator|SendMessage to a running"
```

Expected: FAIL，child tool surface 尚未包含回复工具或 parent 未收到 reply command。

- [ ] **Step 4：实现 coordinator response adapter**

`subagent/coordinator-response.ts`：

```ts
import type { CoordinatorResponsePort, SessionId } from "@zcode/contracts";
import type { EnqueueSubagentMessageInput } from "../runtime/types.js";

export interface CreateCoordinatorResponsePortOptions {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  parentToolCallId?: string;
  enqueue(input: EnqueueSubagentMessageInput): undefined;
}

export function createCoordinatorResponsePort(
  options: CreateCoordinatorResponsePortOptions,
): CoordinatorResponsePort {
  return {
    respond(request) {
      const responseId = `response_${crypto.randomUUID()}`;
      try {
        options.enqueue({
          responseId,
          agentId: options.agentId,
          agentType: options.agentType,
          childSessionId: options.childSessionId,
          childToolCallId: String(request.childToolCallId),
          ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
          summary: request.summary,
          message: request.message,
          traceContext: request.trace,
        });
        return {
          status: "success",
          responseId,
          message: `Response ${responseId} was queued for the coordinator.`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          responseId,
          error: message,
          message: `Response ${responseId} failed to queue for the coordinator: ${message}`,
        };
      }
    },
  };
}
```

- [ ] **Step 5：在 child runtime 注入 port**

创建 child `AgentRuntime` 时传入：

```ts
coordinatorResponsePort: createCoordinatorResponsePort({
  agentId: request.agentId,
  agentType: request.agentType,
  childSessionId: request.sessionId,
  parentToolCallId: traceStringAttribute(
    request.traceContext,
    "parentToolCallId",
  ),
  enqueue: (input) => this.enqueueSubagentMessage(input),
}),
```

该 port 只能出现在 child deps；父 runtime bootstrap 不注入。`CoordinatorResponseRequest` 中没有 `childSessionId`，因此 identity 只能来自创建 child 时绑定的 closure。

- [ ] **Step 6：强制加入 child control tool allowlist**

第一层，在 `resolveSubagentToolAllowlist()` 的最终结果外包一层去重 helper，确保 profile `tools`/`disallowedTools` 不移除 child control tool：

```ts
function includeCoordinatorResponseTool(
  toolNames: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!toolNames) return toolNames;
  return Array.from(new Set([...toolNames, RESPOND_TO_COORDINATOR_TOOL_NAME]));
}
```

对 Explore、general-purpose、custom profile 三条分支都调用。profile `tools`/`disallowedTools` 不移除该 control tool；显式全局 runtime `toolDisallowlist` 仍由 generic registration policy 最后裁决。

第二层，修改 `runtime/helpers/tool-allowlist.ts`，在 Explore 交集完成后再次应用 child-only helper：

```ts
function includeSubagentControlTools(
  config: AgentRuntimeConfig,
  toolNames: readonly string[] | undefined,
): readonly string[] | undefined {
  if (config.taskType !== "subagent_child" || toolNames === undefined) {
    return toolNames;
  }
  return Array.from(new Set([...toolNames, RESPOND_TO_COORDINATOR_TOOL_NAME]));
}
```

`resolveBuiltInToolAllowlist()` 的非 Explore 返回值和 Explore 交集返回值都经过该 helper。Explore 在没有显式 allowlist 时以 `EXPLORE_AGENT_ALLOWED_TOOLS` 为基础再追加；global `toolDisallowlist` 仍在 registry 最后裁决。增加 model branch refresh 回归，确认 embedded-search 切换只替换 Glob/Grep，不移除已注册的回复工具。当前 refresh 不会 unregister 该工具；若实现时改成重建 registry，`includeRespondToCoordinator` 必须沿用初始注册能力（例如读取 refresh 前 `registry.has()`），不能仅凭 `taskType` 注册一个没有 port 的工具。

- [ ] **Step 7：验证 tool-scoped guidance，不修改 common prompt**

`RespondToCoordinator.metadata.modelInstructions` 已在 Phase 2 包含：

```text
When you receive an input beginning with "Message from coordinator:", use this tool to answer it.
When replying while work remains, do not use assistant text as the reply.
Place this call before or alongside the next work tool call when possible.
Continue the current task unless the coordinator explicitly changed or ended it.
```

不要修改 `subagent/system-prompt.ts`。registry 只会把 `modelInstructions` 拼进实际注册工具的 provider description，因此 port 缺失或 global disallow 时，不会要求模型调用不存在的工具。surface test 必须同时证明存在和不存在两种状态。

- [ ] **Step 8：验证 scheduler 边界，不修改 scheduler**

在 tool contract 或 scheduler focused test 中断言：

```ts
expect(respondMetadata.concurrentSafe).toBe(true);
```

并保留现有 Bash metadata：

```ts
expect(bashMetadata.concurrentSafe).toBe(false);
```

测试只证明工具可以同一 model step 产出；不得断言 RespondToCoordinator 与 Bash 位于同一 parallel group。

- [ ] **Step 9：运行 child integration tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts -t "RespondToCoordinator|SendMessage to a running"
pnpm --filter @zcode/core exec vitest run tests/runtime-tool-allowlist.test.ts
pnpm --filter @zcode/core exec vitest run tests/scheduler.test.ts
```

Expected: PASS。

- [ ] **Step 10：提交 Phase 4**

```bash
git add apps/zcode-cli/packages/core/src/subagent/coordinator-response.ts apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts apps/zcode-cli/packages/core/tests/runtime-tool-allowlist.test.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts apps/zcode-cli/packages/core/tests/scheduler.test.ts
git diff --cached --name-only
git commit -m "feat(cli): let subagents respond to coordinators"
```

---

## Phase 5：Persistence、Hydration 与 Ordering

### Task 6：确保 model-only 可见性、恢复和失败分支稳定

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Modify: `apps/zcode-cli/packages/core/src/session-context/parts.ts`
- Modify: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/read-session-context-tool.test.ts`
- Modify: `packages/shared/src/zcode-session-visible-content.ts`
- Modify: `packages/shared/test/zcodeSessionVisibleContent.test.ts`

**Interfaces:**

- Consumes: persisted `source: "subagent_message"` 和 `visibility: "model-only"`。
- Produces: live/hydrated provider history 一致；UI-visible history、标题和 ReadSessionContext 始终隐藏 internal carrier。

- [ ] **Step 1：写 hydrate failing test**

构造 persisted synthetic user message：

```ts
{
  role: "user",
  synthetic: true,
  source: "subagent_message",
  visibility: "model-only",
}
```

text part 包含 `<subagent-message>`。断言 hydrate 后 runtime entry：

```ts
expect(entry.message.role).toBe("user");
expect(entry.metadata?.source).toBe("legacy_synthetic");
expect(providerText).toContain("<subagent-message>");
expect(providerText).not.toContain("<system-reminder");
```

- [ ] **Step 2：写 visibility fallback 和 title failing tests**

在 `zcodeSessionVisibleContent.test.ts` 增加三组断言：

```ts
// canonical persisted shape：当前 visibility 逻辑应直接隐藏，用作回归断言。
expect(getZCodeUserVisibleMessages([messageWithInfoVisibilityModelOnly])).toEqual([]);

// source-only replay fallback：没有 visibility 但 source= subagent_message 时也必须隐藏。
expect(getZCodeUserVisibleMessages([sourceOnlySubagentMessage])).toEqual([]);

// title 不得采用 synthetic reply；仍选择真实 user text 或 target title fallback。
expect(
  resolveZCodeVisibleSessionTitle({
    messages: [sourceOnlySubagentMessage, realUserMessage],
    target: null,
  }),
).toBe("真实用户问题");
```

其中 source-only case 是本阶段的预期红测；分别覆盖 `message.info.source` 和 `part.metadata.source` 两种 fallback shape。只带 canonical `visibility: "model-only"` 的 case 在修改前可能已经通过，不能把它当作 TDD failure 证据。

- [ ] **Step 3：写 ReadSessionContext failing test**

在 `read-session-context-tool.test.ts` 仿照现有 `goal_state_change` case，加入 `synthetic: true`、`metadata.source/source: "subagent_message"` 的 text part，调用 local relevant snippets 路径，断言 output 不包含 response marker。该工具不得把内部 coordinator carrier 当作真实用户上下文再次摘要给模型。

- [ ] **Step 4：写 FIFO ordering 和 injected enqueue failure tests**

Runtime tests 覆盖两种合法消费形态。第一组在同一次 active-loop drain 前依次 enqueue：

```text
subagent-message(response_1)
task-notification(agent completed)
```

断言首次包含二者的同一 provider request 中，`response_1` 的 content index 小于 `<task-notification>`。

第二组让 response command 先由 idle/outer queue 消费，再 enqueue task notification；断言 response 的首次 request index 小于 notification 的首次 request index。两组均断言 `maxConcurrentModelCalls === 1`。

Coordinator port test 让 enqueue callback 主动抛出 `injected enqueue failure`，断言 tool runtime output：

```ts
{
  status: "failed",
  error: "injected enqueue failure",
}
```

provider-visible model content 必须同时包含失败原因和 `Continue the current task`，且 child 后续 model request 仍可继续普通工具调用。不要把该测试命名成 `parent runtime disposed`：当前 queue 没有 disposed acknowledgement，这个测试只证明 adapter 能处理同步 enqueue 异常；process 销毁后的 durable delivery 仍是明确非目标。

- [ ] **Step 5：运行 tests，确认先失败**

本 Phase 新增 core/shared test title 统一包含 `subagent message`，避免 focused `-t` 漏跑新 case。

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/session-history-hydrator.test.ts tests/runtime-tool-loop.test.ts tests/subagent-explore.test.ts -t "subagent message"
pnpm --filter @zcode/core exec vitest run tests/read-session-context-tool.test.ts -t "subagent message"
pnpm exec vitest run packages/shared/test/zcodeSessionVisibleContent.test.ts -t "subagent message"
```

Expected: FAIL，hydrate source 尚未映射，source-only visibility fallback 和 ReadSessionContext skip 尚未实现。

- [ ] **Step 6：实现 runtime metadata、visibility 和 context 映射**

`runtimeMetadataForSyntheticUserMessageSource()` 增加：

```ts
if (source === "background_task" || source === "subagent_message") {
  return legacySyntheticRuntimeMetadata();
}
```

`metadataFromSyntheticTextPart()` 使用同样判断，确保 hydrate 不走 legacy `source === "subagent"` 的 system reminder 分支。

在 `packages/shared/src/zcode-session-visible-content.ts` 的 `MODEL_ONLY_SYNTHETIC_NOTICE_SOURCES` 增加：

```ts
"subagent_message",
```

并让 `isZCodeModelOnlySyntheticUserMessage()` 同时检查 `message.info.source`，不能只检查 text part metadata：

```ts
if (MODEL_ONLY_SYNTHETIC_NOTICE_SOURCES.has(String(message.info.source ?? ""))) {
  return true;
}
```

在 `apps/zcode-cli/packages/core/src/session-context/parts.ts` 的 `SKIPPED_SYNTHETIC_TEXT_SOURCES` 增加同一 source。canonical `visibility` 是主判据，source set 是旧数据、replay 和局部 metadata 丢失时的 defense-in-depth fallback。

- [ ] **Step 7：运行 persistence/visibility/context tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/session-history-hydrator.test.ts tests/runtime-tool-loop.test.ts tests/subagent-explore.test.ts -t "subagent message"
pnpm --filter @zcode/core exec vitest run tests/read-session-context-tool.test.ts -t "subagent message"
pnpm exec vitest run packages/shared/test/zcodeSessionVisibleContent.test.ts -t "subagent message"
```

Expected: PASS。

- [ ] **Step 8：运行现有 background notification 回归组**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts -t "task notification|background notification|subagent message"
```

Expected: PASS；`task-notification` 的 active/idle、goal continuation 和 sealed child cleanup 语义没有变化。

- [ ] **Step 9：提交 Phase 5**

```bash
git add apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts apps/zcode-cli/packages/core/src/session-context/parts.ts apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts apps/zcode-cli/packages/core/tests/read-session-context-tool.test.ts packages/shared/src/zcode-session-visible-content.ts packages/shared/test/zcodeSessionVisibleContent.test.ts
git diff --cached --name-only
git commit -m "feat(cli): preserve subagent response history"
```

---

## Phase 6：BG25 E2E Lifecycle

### Task 7：验证真实 provider-visible 双向协调链路

**Files:**

- Create: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts`
- Create: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-respond-to-coordinator.json`
- Create: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-subagent-respond-to-coordinator.json`
- Modify: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify after Docker admission: `scripts/test-desktop-e2e-container.sh`
- Modify after Docker admission: `docs/testing/conversation-session-docker-automation-plan.md`

**Interfaces:**

- Consumes: BG25 accepted semantics 和 Phase 1-5 实现。
- Produces: 独立 formal BG25 E2E、case-local replay fixture 和 provider-visible ordering evidence。

- [ ] **Step 1：编写独立 formal BG25 spec**

使用稳定 marker：

```text
E2E_SUBAGENT_RESPOND_TO_COORDINATOR
E2E_SUBAGENT_COORDINATOR_QUESTION
E2E_SUBAGENT_RESPONSE_QUEUED
E2E_SUBAGENT_CONTINUED_WORK
E2E_SUBAGENT_COORDINATOR_CONSUMED
E2E_SUBAGENT_FINAL_RESULT
```

spec 直接放在 formal `conversation-session/` 目录，使用 provider 的正常默认 context window；不得通过
`manual-review/pending` 路径继承 `240/80` auto-compact 测试配置。spec 内创建独立临时目录，
避免依赖开发机仓库文件：

```ts
const E2E_ROOT = "/tmp/zcode-e2e-respond-to-coordinator";
const RELEASE_FILE = join(E2E_ROOT, "release-child-bash");
const CONTINUED_WORK_FILE = join(E2E_ROOT, "continued-work.txt");
```

`before` 中 `mkdir` 并写入 `CONTINUED_WORK_FILE`；`afterEach` 先写 `RELEASE_FILE` 释放可能遗留的 child Bash，再停止会话并清理目录。用现有 `ensureToolCrossProductFullAccessMode()` 和 `respondToToolCrossProductBlockers()` 处理模式/permission，不新增重复 UI helper。

场景必须按以下顺序：

1. main 调用 `Agent(run_in_background=true)`。
2. child 调用等待 `RELEASE_FILE` 的受控 Bash，制造 running steer 窗口。
3. main 从 Agent result 读取 `agentId` 并调用 `SendMessage`；case-local replay fixture 必须使用 `"to": "{{latestAgentId}}"`，禁止固化 capture 时的随机 agent id。
4. test 在 SendMessage result 进入 main 后写 `RELEASE_FILE`；child 下一次 request 同时看到 Bash tool result、`Message from coordinator:` 和 question payload。
5. child 同一 response 按顺序产出 `RespondToCoordinator` 与读取 `CONTINUED_WORK_FILE` 的 `Read`。
6. child 后续 request 同时看到两个 tool results，再执行一项普通工作 tool。
7. parent idle wake request 包含 `<subagent-message>` 和 response marker。
8. parent 对 wake request 返回包含 `E2E_SUBAGENT_COORDINATOR_CONSUMED` 的 assistant message。
9. child 最终 completion notification 包含 final marker。
10. UI 顶层可见 user messages 不包含 response marker；parent Agent card 内可找到 mirrored `RespondToCoordinator` child tool block，且 Agent 最终正常完成。

spec 使用 `findFirstUpstreamRequestIndex()` 加 request body 内 marker offset 的 helper，按 `(requestIndex, contentIndex)` 断言 `<subagent-message>` 首次位置早于 `<task-notification>`；不得假设二者一定属于不同 request。

- [ ] **Step 2：填写 case-local provider fixture 与 manifest**

每个 request 使用精确 `bodyIncludes` / `lastUserMessageIncludes`，并标注：

```json
{
  "syntheticReason": "稳定证明 child RespondToCoordinator 回复进入 parent model-only runtime command，同时 child 继续普通工作 tool。"
}
```

不得把 case-specific responses 写入 `provider-basic.json` 或 shared `common.json`。

fixture 必须包含独立 lanes/响应来证明：main Agent launch、main SendMessage、child Bash result + coordinator input、child `RespondToCoordinator + Read`、child continued work、parent model-only wake/consumed marker、child final completion。`SendMessage.input.to` 固定使用 replay server 支持的 `{{latestAgentId}}` token；`Read.file_path` 固定为上面的 `CONTINUED_WORK_FILE`；不要引用执行计划或源码文件作为运行时 fixture。

manifest 的 `spec` 必须直接指向 formal BG25 spec，不得指向 `manual-review/pending`。

- [ ] **Step 3：运行 fixture checker**

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts
```

Expected: exit code `0`，所有 synthetic request 均有 `syntheticReason`。

- [ ] **Step 4：运行 isolated replay**

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-respond-to-coordinator.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts'
```

Expected: PASS，证明不依赖 legacy shared fixture；运行生成的 CLI config 不包含 `240/80`
auto-compact override，provider capture 不包含 compact summary request，UI 不显示 compact divider。

- [ ] **Step 5：运行 default replay**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts'
```

Expected: PASS。

- [ ] **Step 6：完成 matrix 状态**

将 BG25 从 `planned` 更新为：

```markdown
| BG25 | covered | BGR、RT | 独立 formal BG25 E2E 证明 child-to-parent model-only response 和 continued work；core tests 证明 active/idle intake、FIFO ordering 与单模型请求并发 |
```

- [ ] **Step 7：运行 coverage audit 和 E2E typecheck**

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
pnpm --filter @zcode/desktop typecheck:e2e
```

Expected: 两条命令 exit code `0`。

- [ ] **Step 8：运行单 spec 断网 Docker proof**

```bash
E2E_SPEC=./test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts pnpm run test:e2e:container
```

Expected: PASS，并记录实际 artifact 目录 `packages/desktop/.e2e-artifacts/<run-id>`。只有这一步通过后才能做 admission。

- [ ] **Step 9：执行 Docker admission 并复跑 verified suite**

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ./test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply
pnpm run test:e2e:container:conversation
```

Expected: admission 只修改 `scripts/test-desktop-e2e-container.sh` 和 `docs/testing/conversation-session-docker-automation-plan.md`，随后 verified suite PASS。若单 spec Docker proof 因当前环境无法运行，不执行 admission，也不把 BG25 标记成 Docker verified；在交付说明中明确列为待验证项。

- [ ] **Step 10：提交 Phase 6**

```bash
git add packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-respond-to-coordinator.json packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-subagent-respond-to-coordinator.json docs/testing/conversation-session-background-e2e-coverage-matrix.md docs/testing/conversation-session-e2e-coverage-matrix.md
# 仅当 Step 12 admission 已完成且这两个文件的 diff 只属于 BG25 时执行：
git add scripts/test-desktop-e2e-container.sh docs/testing/conversation-session-docker-automation-plan.md
git diff --cached --name-only
git commit -m "test(e2e): cover subagent coordinator responses"
```

若 Docker proof 未执行或未通过，跳过第二条 `git add`；admission 两个文件不应有改动。Expected staged paths 必须与实际完成的 lifecycle 状态一致。

---

## Phase 7：Final Verification 与交付

### Task 8：运行完整回归并检查范围

**Files:**

- Verify only: 所有前述文件。

**Interfaces:**

- Consumes: Phase 0-6 全部 deliverables。
- Produces: 可提交、可复现、无未声明范围扩张的最终变更。

- [ ] **Step 1：运行 contracts/core focused suite**

```bash
pnpm --filter @zcode/contracts exec vitest run tests/respond-to-coordinator.test.ts
pnpm --filter @zcode/core exec vitest run tests/tool-contracts.test.ts tests/runtime-hooks.test.ts tests/permission-service.test.ts tests/runtime-tool-allowlist.test.ts tests/runtime-tool-loop.test.ts tests/subagent-explore.test.ts tests/session-history-hydrator.test.ts tests/read-session-context-tool.test.ts tests/scheduler.test.ts
```

Expected: PASS。

- [ ] **Step 2：运行 shared focused suite**

```bash
pnpm exec vitest run packages/shared/test/zcodeProtocol.test.ts packages/shared/test/zcodeSessionVisibleContent.test.ts
```

Expected: PASS。

- [ ] **Step 3：运行 CLI package checks**

```bash
pnpm --filter @zcode/contracts typecheck
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/contracts lint
pnpm --filter @zcode/core lint
```

Expected: PASS。

- [ ] **Step 4：运行仓库强制检查**

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS。既有 warning 与本次新增 failure 分开记录。

- [ ] **Step 5：运行文档和 diff gates**

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
git diff --check e458e18b902a467251153972688ca8461eb5a418...HEAD
git diff --check
git diff --cached --check
```

Expected: exit code `0`。

- [ ] **Step 6：检查 provider-visible tool surface**

从 focused test 或 capture artifact 确认：

```text
main tools: SendMessage present, RespondToCoordinator absent
child tools: RespondToCoordinator present, SendMessage absent, Agent absent
plan-mode child: RespondToCoordinator executes with readOnly=false and mode.plan.explicitSessionCapability
missing-port/disallowed child: RespondToCoordinator and its guidance absent
```

- [ ] **Step 7：检查无范围扩张**

Run:

```bash
git diff --name-only e458e18b902a467251153972688ca8461eb5a418...HEAD
git diff --stat e458e18b902a467251153972688ca8461eb5a418...HEAD
git status --short
git diff --cached --name-only
```

人工确认：

- 没有 Agent Teams/team roster/sibling mailbox 代码；
- 没有 parent `steerTurn` 直连；
- 没有把 `subagent-message` 塞进 `task-notification` source/log/goal 分支；
- 没有修改 scheduler 并行安全规则；
- 没有新增 app-to-agent RPC；
- 没有修改 remote owner/lease、workspace identity 或 client queue。
- 没有修改 common subagent system prompt 来引用可能不存在的工具；
- 没有把 `RespondToCoordinator` 标记成 read-only；
- 没有隐藏现有 parent Agent card 内的 child tool mirror。

- [ ] **Step 8：最终提交**

Phase commits 全部完成后，默认不应有剩余 feature 文件。先检查：

```bash
git status --short
git diff --cached --name-only
```

若仍有本计划声明范围内的格式化或文档状态文件，逐个审查并显式 `git add <exact-path>`，确认 cached paths 后再使用与内容匹配的 Conventional Commit；不得运行一个没有精确 staged-path gate 的兜底 commit。若没有剩余 staged changes，不创建空 commit。用户无关改动保持原样并在交付说明中列出。

- [ ] **Step 9：生成交付证据**

交付说明至少列出：baseline 与最终 HEAD、Phase commits、focused/full test 结果、BG25 capture/replay/Docker artifact、未执行验证及原因、保留的用户改动。不要把“command enqueue 成功”描述成“coordinator 已读”；只有 E2E consumed marker 可以证明该次 replay 中 parent model 实际消费。

## Self-Review Checklist

- [ ] Spec coverage：每条 Acceptance Criteria 都能映射到 Task 1-8 的实现或测试步骤。
- [ ] Naming consistency：全局只使用 `RespondToCoordinator`、`CoordinatorResponsePort`、`SubagentMessageRuntimeCommand`、`subagent-message`、`subagent_message`。
- [ ] Directionality：main-to-child 仍是 `SendMessage`；child-to-main 只走 coordinator port。
- [ ] Runtime serialization：active intake 和 idle command 都复用同一 parent runtime command queue。
- [ ] Visibility：live、persist、hydrate、protocol、UI filter、title 和 ReadSessionContext 都覆盖 `subagent_message`。
- [ ] Continuation：测试证明 child 回复后仍有普通 tool call 和最终 completion。
- [ ] Scheduling claim：只承诺同一 assistant model step；不承诺与 unsafe tool 真并行。
- [ ] Error semantics：queue ack、injected enqueue failure、missing port 都有明确结果；disposed parent/durable delivery 明确列为非目标，不做虚假保证。
- [ ] Permission semantics：工具保持 non-read-only；Plan capability 只放行 non-destructive session action，且 deny/ask 优先级有测试。
- [ ] Tool availability：port、child task type、Explore 最终投影、global disallow 和 tool-scoped guidance 状态一致。
- [ ] Ordering semantics：同请求合流和跨请求消费都按首次 provider-visible `(requestIndex, contentIndex)` 比较。
- [ ] Terminal race：active turn 无后续 roundtrip 时由 outer queue 唤醒，模型并发仍为 1。
- [ ] Observability：顶层 synthetic user 隐藏，但 parent Agent card 内 nested child tool block 保留。
- [ ] Scope：没有引入 Agent Teams、sibling routing、replyTo 或 durable mailbox。
- [ ] Mobile boundary：没有新建手机 runtime；protocol/visibility 测试覆盖 replayable payload compatibility。
- [ ] Workspace safety：未触碰 `workspaceIdentity` / `workspacePath` 语义。
- [ ] Repository gates：coverage audit、focused tests、E2E typecheck、`pnpm typecheck`、`pnpm lint` 均有步骤。

## Execution Handoff

推荐使用 subagent-driven development：每个 Task 使用一个 fresh worker，并在 Task 结束后做一次 spec compliance review 和一次 code quality review。Phase 0 的文档语义、Phase 3 的 runtime ordering、Phase 4 的 child continuation、Phase 6 的 provider-visible E2E 是四个必须停下来检查的 review gate。

Inline 执行时按 Phase 顺序推进，不允许跳过 Phase 0，也不要把 Phase 3 与 Phase 4 合成一个大改动；这样 active/idle command 语义可以在接入真实 child 前独立验证。
