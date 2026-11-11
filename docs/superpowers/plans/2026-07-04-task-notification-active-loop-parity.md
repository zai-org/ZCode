# Runtime Command Active Loop Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** background task completion 的 `<task-notification>` 仍进入 runtime command queue，但 active query loop 在即将发起下一次模型请求的合法边界前，应按 command priority 尽早消费 pending runtime commands；如果 runtime 已空闲，则保留现有 idle wake / next command 行为。

**Architecture:** 在 runtime command queue 提供 priority 候选能力，让 `runRegularTurnLoop()` 在每次 provider request projection 前查看“priority rank 不大于 `next`”的 pending runtime commands，也就是优先级至少为 `next` 的 `now` / `next` commands。候选集进入 active loop 前还必须经过显式白名单；本阶段只允许 `task-notification` 在 active loop 合流，普通 `prompt` / target continuation 仍留在 outer runtime command queue。idle 路径继续由 `task-notification` command 调 `executeTurnCommand()`；subagent child runtime terminal 后的 nested Bash cleanup-only suppression 在 active-loop 和 idle 消费侧共用同一个判定。

**Tech Stack:** TypeScript, Vitest, zcode runtime command queue, `MessageHistoryImpl`, runtime task notification, conversation-session E2E fixtures.

## Execution Status

- [x] Phase 0 baseline / acceptance reviewed.
- [x] Phase 1 queue priority API implemented as `getByMaxPriority("next")` + explicit `removeById()`, with unit coverage.
- [x] Phase 2 active-loop runtime command intake helper implemented; task-notification persists as model-only synthetic input; prompt commands remain queued for the outer runtime command queue.
- [x] Phase 3 wired into `runRegularTurnLoop()` only for post-first-request active-loop roundtrips (`modelStepCount > 0`), preserving idle command fallback.
- [x] Phase 4 idle wake fallback verified by focused tests.
- [x] Phase 5 goal interaction covered by existing and updated focused runtime tests.
- [x] Phase 6 nested subagent/background Bash cleanup and active child runtime boundaries covered by focused runtime tests.
- [x] Phase 7 compact/visibility regression covered by `runtime-compact.test.ts`.
- [x] Phase 8 coverage docs updated and coverage audit passed.
- [x] Phase 9 focused tests, root `pnpm typecheck`, root `pnpm lint`, direct core/adapters/bootstrap `tsc`, and `git diff --check` executed.
- [ ] Phase 9 `apps/zcode-cli` package-level `pnpm typecheck` / `turbo run typecheck` is blocked by current workspace dependency resolution: `@zcode/shared@workspace:*` is referenced by `packages/adapters`, but the workspace only contains `@zcode/shared-types`.
- [x] Phase 9 E2E formalization gates executed with the correct package scripts: `pnpm --filter @zcode/desktop typecheck:e2e` and `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/background/conversation-session-background.test.ts`.

## Global Constraints

- 只以当前仓库实现为准，不参考其他分支。
- 不重写 subagent/background 架构，只修正 runtime command 从 outer command queue 到 active query loop 的合流策略。
- 不打断 in-flight provider request，不插入工具执行中间，只能在下一次合法模型请求前消费。
- active-loop command 先按 priority rank 上限取候选：`now = 0`、`next = 1`、`later = 2`，取 `rank <= rank(next)`，语义是“优先级至少为 next”；随后必须经过显式白名单。本阶段白名单只放行 `task-notification`，其它 command mode 保持在 outer runtime command queue，不静默吞掉、不改 promise 生命周期。
- provider-visible content 继续使用现有 `<task-notification>` 文案；Bash 单 output-file surface、Workflow output-file artifact、手动 background controls 均不在本计划范围。
- subagent child runtime 已 terminal/sealed 后完成的 nested Bash 仍只做 terminal record/artifact/event cleanup，不复活 child model turn，不回写 parent Agent output。
- 不自动提交；每个 phase 完成后只报告验证结果，由用户显式要求再提交。
- 每个 phase 开始前必须重新阅读本 plan 和当前 `git diff`，确认没有被后续改动改变前提。

---

## File Map

- Modify: `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`
  - 增加 queue 级别的受控 drain API，用于取出 priority rank 不大于 `"next"` 的 commands，保持现有优先级顺序。
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
  - 暴露 runtime 内部 active-loop runtime command drain 方法。
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
  - 将新内部方法纳入 `AgentRuntimeInternal` 类型。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
  - 将新方法挂到 runtime prototype。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
  - 复用现有 `persistBackgroundTaskNotificationCommand()`，新增 active-loop runtime command intake helper。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
  - 在下一次 provider request projection 前调用 active-loop runtime command drain。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
  - idle `task-notification` command path 保持现有语义；必要时复用提取出的 helper，避免 persistence 逻辑分叉。
- Modify/Test: `apps/zcode-cli/packages/core/tests/runtime-command-queue.test.ts`
  - 覆盖 queue drain API 的优先级上限、移除语义和 FIFO 行为。
- Modify/Test: `apps/zcode-cli/packages/core/tests/subagent-background.test.ts`
  - 更新“active prompt 后 notification 才作为独立 next turn”的旧断言；新增 active-loop 合流断言。
- Modify/Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
  - 覆盖 main runtime background Bash/Agent notification 在工具结果后、下一次 provider request 前被合流。
- Modify/Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`
  - 覆盖 active-loop 合流发生在 compact projection 前后不会破坏 model-only synthetic history。
- Modify: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
  - 更新 background notification active-loop coverage 状态。
- Modify: `docs/conversation-session-case-catalog.md`
  - 如现有 BG case 语义描述提到“next turn only”，改为“active-loop intake or idle wake fallback”。
- Optional Modify: `packages/desktop/test/e2e/conversation-session/background/conversation-session-background.test.ts`
  - 如果 fixture replay 可稳定观察 active-loop 合流，则补 case；否则只更新 manual-review/coverage 文档，不强行新增 flaky E2E。

---

## Phase 0: Freeze Baseline And Acceptance

**Purpose:** 在动代码前固定当前偏差、目标行为和本次验收口径，避免继续 patch-on-patch。

**Checklist:**

- [ ] 重新阅读本 plan。
- [ ] 运行 `git diff --stat`，确认当前 worktree 仍是 background/subagent/BG06 相关改动，没有混入不相关 UI 或 remote-control 改动。
- [ ] 确认目标 queue 语义：
  - command queue 支持 `prompt` / `task-notification` 和 `now < next < later`。
  - background Agent completion enqueue `mode: "task-notification", priority: "next"`。
  - Bash completion enqueue `mode: "task-notification", priority: "next"`。
- [ ] 复查当前 zcode 偏差：
  - `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`：`task-notification` 作为 outer command 调 `executeTurnCommand(command.text)`。
  - `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`：下一次 provider request 前只 drain steer 和旧 subagent notification，没有 drain runtime command queue task-notification。
- [ ] 记录验收口径：
  - Active loop 正在跑且会进入下一次 provider request：pending task notification 必须进入这次 request。
  - Active loop 已结束或 runtime idle：pending task notification 必须按现有 idle command wake 路径执行。
  - Subagent child sealed 后的 nested Bash completion：notification 必须被 suppress，不触发 child model turn。

**Pass Criteria:**

- [ ] 没有代码修改。
- [ ] 能用上面的目标 queue 语义和当前源码位置解释“当前偏差”和“目标行为”。

---

## Phase 1: Add Queue-Level Drain API

**Purpose:** 让 active loop 可以从 runtime command queue 中查看优先级至少为 `next` 的 pending command 候选。rank 模型为：`now = 0`、`next = 1`、`later = 2`，所以判断写作 `rank <= rank(next)`。queue 层只负责 priority ordering，不关心 command mode；真正消费时由 runtime intake 按 id 显式 `removeById()`。

**Interfaces:**

- Add type export:

```ts
export interface RuntimeCommandQueue {
  getByMaxPriority(maxPriority: RuntimeCommandPriority): readonly RuntimeCommand[];
}
```

- Selection rule:
  - 只返回 `RUNTIME_COMMAND_PRIORITY_ORDER[command.priority] <= RUNTIME_COMMAND_PRIORITY_ORDER[maxPriority]`。
  - 这里的 `<=` 比的是 rank，不是自然语言里的“优先级更低”；rank 越小优先级越高。
  - 每次选择仍复用现有 priority ordering；同 priority 保持原入队顺序。
  - 被返回的 command 不从 queue 中移除；调用方确认要消费后再用 `removeById()` 删除。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 在 `apps/zcode-cli/packages/core/tests/runtime-command-queue.test.ts` 先写失败测试：
  - `getByMaxPriority("next")` 返回所有 `now` 和 `next` commands。
  - 不返回 `later` commands。
  - 同 priority FIFO。
  - 候选读取后 queue 仍可由 `dequeue()` 正常取出。
- [ ] 运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-command-queue.test.ts --run
```

Expected: 新增测试失败，错误应指向 `getByMaxPriority` 未实现或行为不符。

- [ ] 修改 `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`，实现 `getByMaxPriority()`。
- [ ] 再次运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-command-queue.test.ts --run
```

Expected: PASS。

**Pass Criteria:**

- [ ] Queue API 单测通过。
- [ ] `dequeue()` / `peek()` / `snapshot()` 现有行为未改。
- [ ] Queue API 没有按 command mode 过滤；mode-specific 行为只在 runtime intake processor 中处理。

---

## Phase 2: Extract Active-Loop Runtime Command Intake Helper

**Purpose:** 复用现有 persistence，把 active loop 按 priority 候选 + 白名单取出的 pending runtime commands 转成下一次 provider request 前应该进入 runtime history 的 entries。本阶段只实现 `task-notification` adapter；普通 prompt / target continuation 不进入 active-loop intake。

**Interfaces:**

- Add internal method:

```ts
drainPendingRuntimeCommandsForActiveLoop(traceContext: TraceContext): Promise<{
  drained: number;
  messageIds: MessageId[];
  consumedCommandIds: RuntimeCommandId[];
}>;
```

- Behavior:
  - 从 `runtimeCommandQueue.getByMaxPriority("next")` 取得候选 commands。
  - 对 `mode === "task-notification"` 的 command 调用 `persistBackgroundTaskNotificationCommand()`，保持 model-only synthetic input。
  - 对 `mode === "prompt"` 的 command 不做 active-loop 消费，保持在 queue 中，继续等待 outer runtime command queue drain。
  - 对 `mode === "target-continuation"` / `mode === "target-continuation-loop"` 必须保持原有 queue 执行语义，不能在 active loop 内直接转成 history entry。
  - 不调用 `executeTurnCommand()`，不创建新 turn。
  - 不触发 `runPostCommandActiveTargetLoop()`；active-loop 本轮结束后仍走现有 prompt/target post-turn 逻辑。
  - 如果没有 commands，返回 `{ drained: 0, messageIds: [], consumedCommandIds: [] }`。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 在 `apps/zcode-cli/packages/core/tests/subagent-background.test.ts` 或更合适的 runtime test 中先写失败测试：
  - enqueue 两条 task-notification。
  - 调用内部 helper。
  - 断言 `sessionStore.savedMessages` 中有两条 `source === "background_task"`、`visibility === "model-only"`。
  - 断言 `messageHistory.toRuntimeEntries()` 包含两条 `<task-notification>`。
  - 断言 modelAdapter 未被调用。
  - enqueue 一条 `prompt` command 后调用内部 helper；断言该 command 仍留在 queue 且 promise 未 settle。
- [ ] 运行 focused test，确认失败：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/subagent-background.test.ts --run
```

- [ ] 修改：
  - `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
  - `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
  - `apps/zcode-cli/packages/core/src/runtime/internal.ts`
  - `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
- [ ] 再次运行 focused test。

**Pass Criteria:**

- [ ] Active-loop runtime command helper 只做 command intake/persistence，不启动额外 turn。
- [ ] 没有启动额外 model request。
- [ ] 非 `task-notification` command mode 没有被静默吞掉，仍保留在 outer runtime command queue。
- [ ] idle command path 仍可复用 `persistBackgroundTaskNotificationCommand()`。

---

## Phase 3: Wire Active-Loop Intake Before Provider Projection

**Purpose:** 将 helper 接到 `runRegularTurnLoop()` 的合法边界：steer drain 之后、compact/provider projection 之前。这样 background completion 如果赶上下一个 roundtrip，会合进这一轮模型请求。

**Placement:**

In `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`:

```ts
await this.drainPendingSubagentNotifications(state.turnTraceContext);
const drainedRuntimeCommands =
  await this.drainPendingRuntimeCommandsForActiveLoop(state.turnTraceContext);
if (drainedRuntimeCommands.drained > 0) {
  state.repeatedToolCallSignature = undefined;
  state.repeatedToolCallStreakCount = 0;
}
```

The exact placement must remain before:

```ts
const providerProjection = buildRuntimeProviderRequestMessages(this, {
  entries: this.messageHistory.toRuntimeEntries(),
  applyCacheControl: true,
});
```

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 在 `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts` 写失败测试：background Bash 在一个 tool step 执行完成后、下一次 provider request 前 enqueue notification。
  - 第一次 model request 返回一个 foreground tool call，tool result 触发 background notification enqueue。
  - 第二次 model request 的 `messages` 必须同时包含 tool result 和 `<task-notification>`。
  - 断言没有第三个“notification-only” model request。
- [ ] 运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-tool-loop.test.ts --run -t "background notification"
```

Expected: 新测试先失败，表现为 notification 只在当前 prompt command 完成后作为独立 request 出现。

- [ ] 修改 `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`，接入 helper。
- [ ] 更新旧测试：
  - `apps/zcode-cli/packages/core/tests/subagent-background.test.ts` 里“queues task-notification commands behind an active prompt command”如果只断言 active prompt 期间不打断 in-flight request，应保留；如果断言 prompt 完成后一定是独立 notification turn，应改成 active-loop 合流或 idle fallback 分别覆盖。
- [ ] 运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/subagent-background.test.ts packages/core/tests/runtime-tool-loop.test.ts --run
```

**Pass Criteria:**

- [ ] Notification 不打断当前 in-flight provider request。
- [ ] 如果 active loop 还会继续下一次 provider request，notification 出现在下一次 request。
- [ ] 如果 active loop 不再继续，仍保留 idle wake fallback。
- [ ] Prompt command 没有被 active-loop processor 静默吞掉；若本期消费 prompt，必须有 resolve/visibility 测试覆盖；若本期不消费 prompt，必须仍按 next-turn queue 语义执行。

---

## Phase 4: Preserve Idle Wake Fallback

**Purpose:** 确保 runtime idle 时的 background notification 仍按当前 command queue 路径唤醒 main agent；这条路径是 background subagent/bash 主链路的基础。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 保留并必要时更新 `apps/zcode-cli/packages/core/tests/subagent-background.test.ts` 中的 idle wake 测试：
  - `runs each idle background notification as a model-only task-notification command`
  - `wakes idle runtime synchronously when a background notification is enqueued`
- [ ] 新增或更新测试，明确 active-loop runtime command helper 不会吞掉 idle notification：
  - runtime idle。
  - enqueue notification。
  - `enqueueRuntimeCommand()` 触发 drain。
  - model request latest message 包含 `<task-notification>`。
- [ ] 运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/subagent-background.test.ts --run
```

**Pass Criteria:**

- [ ] Idle notification 仍然启动 model-only synthetic notification turn。
- [ ] `persistBackgroundTaskNotificationCommand()` 仍只落 model-only session message，不在用户可见内容里泄漏。
- [ ] `runtime-command-queue.ts` 的 post-notification goal continuation 逻辑仍只服务 idle notification command，不影响 active-loop intake。

---

## Phase 5: Goal Interaction Regression

**Purpose:** 保护 goal + background 的既有结论：goal verification 必须等 running background settle，并且 notification 被消费后再做 verifier/continuation。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 更新或新增 `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts` goal 相关用例：
  - Active loop 合流 notification 后，同一 prompt command 的 post-turn goal loop 会继续检查 active target。
  - 如果 `RuntimeTaskRegistry` 仍有 running background task，verifier defer。
  - 多个 notification 中第一个合流、第二个 idle fallback 时，goal loop 不抢跑 queued command。
  - `targetCompletionVerification.enabled === false` 时，notification 不无条件启动 active target continuation。
- [ ] 运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-tool-loop.test.ts --run -t "target"
```

- [ ] 再运行完整 runtime tool-loop focused suite：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-tool-loop.test.ts --run
```

**Pass Criteria:**

- [ ] Goal verification 不会先于 notification consumption。
- [ ] Running background task 仍会 defer verifier。
- [ ] Queued prompt 仍优先于 post-notification goal loop 的后续迭代。
- [ ] 没有恢复“goal steer 后 pause/卡住”的旧问题。

---

## Phase 6: Subagent And Nested Background Bash Semantics

**Purpose:** 将 BG06 语义和新的 active-loop intake 对齐：child runtime 活跃时可以消费 nested Bash notification；child runtime sealed 后只 cleanup，不复活。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 在 `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts` 或 `subagent-background.test.ts` 更新 BG06 单测：
  - subagent child runtime 内 Bash background completion 发生在 child loop 下一次 provider request 前。
  - child 第二次 provider request 包含 nested Bash `<task-notification>`。
  - parent Agent result 不因为 nested Bash 后续结果被重写。
- [ ] 保留 sealed 后 cleanup-only 测试：
  - child `executeTurn()` 已返回并 seal。
  - nested Bash completion 只更新 task terminal/event/artifact。
  - 不 enqueue child task-notification command。
  - 不触发 child model request。
- [ ] 运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-tool-loop.test.ts packages/core/tests/subagent-background.test.ts --run -t "background"
```

**Pass Criteria:**

- [ ] Child runtime active-loop 合流只发生在 child still active 的合法边界。
- [ ] Child sealed 后 notification suppression 保持。
- [ ] Main runtime queue 不被 child nested Bash 污染。
- [ ] Parent Agent output 不追加 nested Bash completion result。

---

## Phase 7: Compact, Prompt Projection, And Visibility Regression

**Purpose:** 确保 active-loop runtime command intake 插入 synthetic user entry 后，不重新引入 non-incremental trajectory、cache anchor 漂移或 UI 可见泄漏。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 更新 `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`：
  - active-loop runtime command drain 后触发 mid-turn compact 时，`<task-notification>` 仍保留在 provider-visible history 中。
  - compact 不把 model-only notification 变成 real user message。
  - cache-control 仍由 `buildRuntimeProviderRequestMessages()` 统一投影。
- [ ] 运行：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-compact.test.ts --run -t "task-notification"
```

- [ ] 如有轨迹转换 helper 测试覆盖，补充一次 “active-loop notification 合流后 append-only” fixture 或 snapshot 检查。

**Pass Criteria:**

- [ ] Provider request body 中 notification 位置稳定且 append-only。
- [ ] Session visible content 不展示 model-only `<task-notification>`。
- [ ] 不恢复之前已修复的 non-incremental snapshot 问题。

---

## Phase 8: E2E Coverage And Docs

**Purpose:** 将语义变化反映到 conversation-session background coverage 中，避免文档仍描述旧的 “next turn only” 行为。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 更新 `docs/testing/conversation-session-background-e2e-coverage-matrix.md`：
  - 为 active-loop intake 增加或更新 coverage row。
  - 明确 idle wake fallback 仍覆盖。
  - 明确 BG06 nested Bash terminal cleanup-only 仍是边界语义。
- [ ] 更新 `docs/testing/conversation-session-e2e-coverage-matrix.md` 中对应汇总项。
- [ ] 更新 `docs/conversation-session-case-catalog.md` 中 background case 描述。
- [ ] 如果新增 E2E case，更新：
  - `packages/desktop/test/e2e/conversation-session/background/conversation-session-background.test.ts`
  - `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-background.json`
  - `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json`
- [ ] 运行 coverage/doc gate：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
pnpm typecheck:e2e
```

- [ ] 如新增 fixture，运行：

```bash
pnpm e2e:fixture:check -- --case conversation-session-background
```

**Pass Criteria:**

- [ ] Coverage matrix 与测试代码一致。
- [ ] Case catalog 不再把 background notification 描述成只会 next turn。
- [ ] E2E fixture/deepseek replay JSON 结构校验通过。

---

## Phase 9: Final Verification

**Purpose:** 提交前做完整回归，确保 active-loop 合流没有破坏现有 background/subagent/bash/workflow 主链路。

**Checklist:**

- [ ] 重新阅读本 plan 和当前 `git diff`。
- [ ] 运行 focused core tests：

```bash
pnpm --dir apps/zcode-cli exec vitest \
  packages/core/tests/runtime-command-queue.test.ts \
  packages/core/tests/subagent-background.test.ts \
  packages/core/tests/runtime-tool-loop.test.ts \
  packages/core/tests/runtime-compact.test.ts \
  --run
```

- [ ] 运行 Bash/background focused tests：

```bash
pnpm --dir apps/zcode-cli exec vitest \
  packages/adapters/src/exec/index.test.ts \
  packages/core/tests/bash-run-conformance.test.ts \
  --run -t "background|auto-background|task-notification"
```

- [ ] 运行 workflow detach focused test：

```bash
pnpm --dir apps/zcode-cli exec vitest packages/bootstrap/tests/script-workflow.test.ts --run -t "background"
```

- [ ] 运行 repo gates：

```bash
pnpm typecheck
pnpm lint
git diff --check
node scripts/audit-conversation-session-case-coverage.mjs --check --json
```

- [ ] 手动 review `git diff`：
  - 确认没有新增外部产品关键字。
  - 确认没有新增过度兜底 timer/poller。
  - 确认 active-loop command intake 是 priority-first；所有被 drain 的 command mode 都有明确 adapter、保留或放回策略，没有静默吞掉。
  - 确认没有改变 Bash single output-file 未覆盖的既定 divergence。
  - 确认没有自动提交。

**Pass Criteria:**

- [ ] Focused tests 全通过。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm lint` 通过或仅有本任务无关的既有 warning。
- [ ] `git diff --check` 通过。
- [ ] Coverage audit 通过。
- [ ] 最终行为总结能清楚区分：
  - active-loop intake
  - idle wake fallback
  - subagent child sealed cleanup-only

---

## Expected End State

- Background completion 仍统一写入 runtime command queue 的 `task-notification`。
- Active loop 从 runtime command queue 取 command 时先按 `rank <= rank(next)` 得到候选，也就是取 `now` / `next`，然后按显式白名单过滤；本阶段只放行 `task-notification`。
- Main/subagent child runtime 如果正在 active loop 且即将发下一次 provider request，会先消费 priority 合法且白名单允许的 pending command；其中 background `task-notification` 会作为 model-only synthetic input 让模型在最近合法 roundtrip 看到结果。
- Runtime idle 时，notification 仍作为 model-only synthetic task-notification command 唤醒下一 turn。
- Goal verifier 仍等待 running background task settle；notification 被消费后才进入 post-turn verification/continuation。
- Subagent child runtime terminal 后的 nested background Bash 不会复活 child，不会污染 main queue，不会重写 parent Agent output。
- 当前 background subagent/bash/workflow registry -> notification -> wake 主链路不被重写，只补齐 active-query 合流缺口。
