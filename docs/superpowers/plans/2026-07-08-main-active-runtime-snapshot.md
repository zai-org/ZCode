# Main Active Runtime Snapshot Implementation Plan

> 状态（2026-07-15）：历史 legacy UI 实施计划。`isMainActive` 仍存在于 task compatibility 层，
> 但 V4 conversation 主链路以 snapshot 的 phase、active works、rows/control projection 判断前台工作；
> 下文 `useTaskRestore`、task-stream handler 和旧 E2E 路径不是当前实现入口。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `isMainActive` 从本地临时 UI 猜测收敛为 runtime snapshot / live monitor 同步的临时投影，确保 main idle + background running 时不显示底部 fake loading、普通消息不进 queue、queued prompt 可以正常 drain，同时 restore / reconnect 不会误判仍在运行的 main turn。

**Architecture:** `mainActive` 作为 `ZCodeSessionRuntimeSnapshot.runtime` 的 ephemeral 字段，从 agent runtime active turn 投影生成；UI 通过 `applyTaskSnapshotEphemeralRuntimeState()` 和 live stream/background monitor 统一同步到 `TaskUiState.isMainActive`。旧的 `runtime.status`、`activeInputId`、`activeTurnKind` 状态流保持不变，`isMainActive` 只被三类消费点读取：main loading 展示、普通发送 queue 判定、queued prompt drain 判定。

**Tech Stack:** TypeScript、Zod protocol schema、Zustand store、Vitest、WDIO conversation-session E2E、pnpm workspace。

## Global Constraints

- 不要自动提交；实现完成和验证通过后保持工作区改动等待用户确认。
- 不要把 `runtime.activeTurnId` 写入 `activeInputId`；二者语义不同。
- 不改变现有 `runtime.status` / `displayedStatus` / `activeInputId` 主状态流。
- 不让 background-only event 把 `isMainActive` 设置为 `true`。
- snapshot 同步必须尊重现有 stale / terminal freshness 判定，不能让旧 snapshot 把 `isMainActive` 回滚到错误状态。
- 每个 phase 必须先补对应单测并跑通过，再进入下一 phase。
- 最终必须跑 targeted E2E 验证 foreground、background-only、queue/drain 三条用户可见路径。

---

## Scope And Non-Goals

### In Scope

- 在 protocol/runtime snapshot surface 中加入 `mainActive`。
- mapper/projection 层从 runtime active turn 生成 `mainActive`。
- UI snapshot restore / snapshot sync 同步 `mainActive`。
- background monitor / foreground live stream event 继续维护 `isMainActive`。
- 补充 unit tests 与 targeted E2E。

### Out Of Scope

- 不改 background task control、TaskStop、subagent runtime registry、Bash auto-background 行为。
- 不调整 provider-visible content。
- 不重构 ChatView 整体 status 体系。
- 不新增 DB 持久字段；`mainActive` 是 runtime ephemeral snapshot，不是 task-index 持久状态。

---

## Current Files And Responsibilities

- `packages/shared/src/zcode-protocol/index.ts`
  - 定义 session runtime snapshot 的 Zod schema。
  - 新增 `runtime.mainActive?: boolean`。

- `packages/shared/src/zcode-task-types.ts`
  - 定义 UI/service 侧消费的 snapshot TypeScript interface。
  - 新增 `ZCodeSessionRuntimeSnapshot.mainActive?: boolean`。

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`
  - 将 agent runtime projection / active turn 转成 ZCode protocol snapshot。
  - 负责设置 `mainActive: Boolean(input.activeTurn)`。

- `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`
  - 覆盖 session mapper 对 `mainActive` 的生成。

- `packages/ui/src/hooks/taskSnapshotRuntimeStateSync.ts`
  - UI 统一恢复 runtime ephemeral state。
  - 增加 `runtime.mainActive` 到 `TaskUiState.isMainActive` 的同步。

- `packages/ui/src/hooks/taskStreamEventSnapshotSync.ts`
  - live event 后拉 snapshot 的对齐入口。
  - 只在 accepted snapshot 路径应用 `mainActive`，不能绕过现有 stale 判断。

- `packages/ui/src/hooks/useTaskRestore.ts`
  - 切换/恢复 task 时读取 fresh snapshot 并调用 `applyTaskSnapshotEphemeralRuntimeState()`。
  - 确认 restore path 通过新字段恢复 `isMainActive`。

- `packages/ui/src/store/zcodeSessionStoreTaskSlice.ts`
  - 已有 `setTaskMainActive()` 和 `setTaskRuntimeState(non-running)` 清理逻辑。
  - 只在必要时小幅调整，避免新增重复清理路径。

- `packages/ui/src/hooks/taskStreamEventHandlers.ts`
  - foreground live stream event handler。
  - 保留 main activity event 设置 `isMainActive=true`；不让 background child tool event 设置 true。

- `packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts`
  - inactive/background task event monitor。
  - 保留 active task run started / main chunks 设置 true；terminal 通过 runtime non-running 清 false。

- `packages/ui/test/chatStatus.test.ts`
  - 覆盖 mainActivity status 派生。

- `packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts`
  - 覆盖普通发送是否进入 queue。

- `packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts`
  - 覆盖 queued prompt drain。

- `packages/ui/test/taskSnapshotRuntimeStateSync.test.ts`
  - 如已存在则修改；若不存在则创建。
  - 覆盖 snapshot 同步 `mainActive`。

- `packages/desktop/test/e2e/conversation-session/background/conversation-session-background.test.ts`
  - targeted E2E 覆盖 foreground loading、background-only no fake loading、background running 普通消息直发。

---

## Phase 0: Baseline Audit And Red Test Plan

**Purpose:** 在改实现前确认当前 `isMainActive` 的消费面和缺失面，写出本轮必须失败的测试。

**Files:**
- Inspect: `packages/ui/src/store/zcodeSessionStoreTaskSlice.ts`
- Inspect: `packages/ui/src/hooks/taskSnapshotRuntimeStateSync.ts`
- Inspect: `packages/ui/src/hooks/taskStreamEventSnapshotSync.ts`
- Inspect: `packages/ui/src/hooks/useTaskRestore.ts`
- Inspect: `packages/ui/src/hooks/taskStreamEventHandlers.ts`
- Inspect: `packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts`
- Inspect: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`
- Inspect: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

### Checklist

- [ ] Run current usage scan:

```bash
rg -n "isMainActive|setTaskMainActive|mainActive|activeTurnId|activeTurnKind" \
  packages/ui/src packages/ui/test packages/shared/src apps/zcode-cli/packages/bootstrap
```

Expected:
- `isMainActive` appears only in store, explicit main-active writers, send/queue/drain/display consumers, and tests.
- No existing `mainActive` protocol field yet.

- [ ] Confirm current tests still pass before starting:

```bash
pnpm exec vitest run \
  packages/ui/test/chatStatus.test.ts \
  packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts \
  packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts
```

Expected: PASS before this plan starts changing snapshot behavior.

- [ ] Write down the RED expectations for Phase 1 and Phase 2:
  - Protocol snapshot from active turn should contain `runtime.mainActive === true`.
  - Protocol snapshot from idle runtime should contain `runtime.mainActive === false`.
  - UI snapshot sync should set `TaskUiState.isMainActive` from `runtime.mainActive`.
  - Accepted terminal runtime should leave `isMainActive === false`.

**Phase 0 Exit Criteria**

- [ ] Current baseline tests pass.
- [ ] No code has been changed except, if desired, local notes in this plan.
- [ ] Proceed to Phase 1 only after confirming the test targets and file paths.

---

## Phase 1: Add `runtime.mainActive` To Protocol Snapshot Surface

**Purpose:** 让 snapshot 自身携带 main 是否 active 的事实，避免 UI 从 `activeTurnId` 临时猜测。

**Files:**
- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Modify: `packages/shared/src/zcode-task-types.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

**Interfaces Produced:**

```ts
// packages/shared/src/zcode-task-types.ts
export interface ZCodeSessionRuntimeSnapshot {
  mainActive?: boolean;
}
```

```ts
// packages/shared/src/zcode-protocol/index.ts
mainActive: z.boolean().optional()
```

**Implementation Notes:**

- In the session mapper, compute:

```ts
const mainActive = Boolean(input.activeTurn);
```

- Include `mainActive` in the runtime snapshot object.
- Keep `activeTurnId` and `activeTurnKind` unchanged.
- Emit explicit `false` for idle snapshots when the mapper owns the runtime object. Keep schema optional for backward compatibility with older snapshots.

### Checklist

- [ ] Add RED protocol test for active turn snapshot.

Add a test near existing active turn snapshot tests in:
`apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

Test intent:

```ts
it("marks runtime mainActive while a session active turn exists", async () => {
  // Arrange fake app runtime with getActiveTurnInfo() returning a regular active turn.
  // Act buildSessionSnapshot(...).
  // Assert snapshot.runtime.mainActive === true.
  // Assert snapshot.runtime.activeTurnId is still the runtime turn id.
});
```

Expected RED before implementation:

```bash
pnpm --filter @zcode/zcode-cli-bootstrap test -- zcode-protocol.test.ts -t "marks runtime mainActive"
```

If the package script differs locally, use:

```bash
pnpm exec vitest run apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts -t "marks runtime mainActive"
```

Expected: FAIL because `runtime.mainActive` is missing.

- [ ] Add RED protocol test for idle snapshot.

Test intent:

```ts
it("marks runtime mainActive false when no session active turn exists", async () => {
  // Arrange fake runtime getActiveTurnInfo() returns undefined.
  // Assert snapshot.runtime.mainActive === false.
  // Assert snapshot.runtime.activeTurnId is undefined.
});
```

- [ ] Implement schema/type changes.

Change:
- `packages/shared/src/zcode-protocol/index.ts`
- `packages/shared/src/zcode-task-types.ts`

- [ ] Implement mapper change.

Change:
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`

Add `mainActive` to the runtime snapshot object generated from active turn state.

- [ ] Run Phase 1 tests.

```bash
pnpm exec vitest run apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts -t "mainActive"
pnpm typecheck
```

Expected:
- New protocol tests pass.
- Typecheck passes.

**Phase 1 Exit Criteria**

- [ ] Active runtime snapshot has `mainActive: true`.
- [ ] Idle runtime snapshot has `mainActive: false`.
- [ ] `activeTurnId` is still not used as `activeInputId`.
- [ ] Phase 1 tests and `pnpm typecheck` pass before Phase 2.

---

## Phase 2: Sync `mainActive` From Accepted Snapshots Into UI Store

**Purpose:** 让 restore / reconnect 使用 snapshot 中的 `mainActive`，并且只在 accepted snapshot path 应用，避免 stale snapshot 回滚状态。

**Files:**
- Modify: `packages/ui/src/hooks/taskSnapshotRuntimeStateSync.ts`
- Modify: `packages/ui/src/hooks/taskStreamEventSnapshotSync.ts`
- Test: `packages/ui/test/taskSnapshotRuntimeStateSync.test.ts` or create it if missing
- Test: `packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts`

**Interfaces Consumed:**

```ts
runtime?: Pick<
  ZCodeSessionRuntimeSnapshot,
  | "activeTurnKind"
  | "mainActive"
  | "contextUsage"
  | "apiRetry"
  | "goalStats"
  | "goalVerifications"
  | "plan"
  | "todoGroups"
>
```

**Implementation Notes:**

- `applyTaskSnapshotEphemeralRuntimeState()` should apply `runtime.mainActive` only when the field is present:

```ts
if (runtime?.mainActive !== undefined) {
  store.setTaskMainActive(workspacePath, taskId, runtime.mainActive, workspaceIdentity);
}
```

- Do not infer `mainActive` from `activeTurnId` in UI.
- Do not write `activeTurnId` into `activeInputId`.
- `setTaskRuntimeState(non-running)` remains the terminal cleanup path and still clears `isMainActive=false`.
- In `syncTaskSnapshotAfterEvent()`, keep calling `applyTaskSnapshotEphemeralRuntimeState()` only after the existing freshness/stale decisions have accepted the snapshot for ephemeral sync.
- If a test exposes that stale terminal snapshots still apply ephemeral fields, adjust the call site by passing a filtered runtime object for stale terminal branches rather than adding ad hoc guards inside the store.

### Checklist

- [ ] Add RED test: snapshot runtime restores main active.

Create or update:
`packages/ui/test/taskSnapshotRuntimeStateSync.test.ts`

Test intent:

```ts
it("restores isMainActive from runtime.mainActive", () => {
  applyTaskSnapshotEphemeralRuntimeState({
    runtime: {
      mainActive: true,
      activeTurnKind: "regular",
    },
    workspacePath,
    taskId,
  });

  expect(getTaskUiState(workspaceState, taskId).isMainActive).toBe(true);
});
```

Expected RED:

```bash
pnpm exec vitest run packages/ui/test/taskSnapshotRuntimeStateSync.test.ts -t "restores isMainActive"
```

Expected: FAIL before implementation.

- [ ] Add RED test: snapshot runtime can clear main active.

Test intent:

```ts
it("clears isMainActive when accepted runtime.mainActive is false", () => {
  store.setTaskMainActive(workspacePath, taskId, true);
  applyTaskSnapshotEphemeralRuntimeState({
    runtime: { mainActive: false },
    workspacePath,
    taskId,
  });

  expect(getTaskUiState(workspaceState, taskId).isMainActive).toBe(false);
});
```

- [ ] Implement `mainActive` sync in `applyTaskSnapshotEphemeralRuntimeState()`.

- [ ] Run Phase 2 focused tests.

```bash
pnpm exec vitest run \
  packages/ui/test/taskSnapshotRuntimeStateSync.test.ts \
  packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts
```

Expected: PASS.

- [ ] Run regression tests for send/queue policy.

```bash
pnpm exec vitest run \
  packages/ui/test/chatStatus.test.ts \
  packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts \
  packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts
```

Expected: PASS.

**Phase 2 Exit Criteria**

- [ ] Restore path can set `isMainActive=true` from snapshot.
- [ ] Accepted snapshot can clear `isMainActive=false`.
- [ ] No UI code infers `mainActive` from `activeTurnId`.
- [ ] Focused UI tests pass before Phase 3.

---

## Phase 3: Align Live Event And Background Monitor Updates

**Purpose:** 确保切后台后 monitor 像更新其他 runtime 状态一样维护 `isMainActive`，而 background-only event 不污染 main active。

**Files:**
- Modify: `packages/ui/src/hooks/taskStreamEventHandlers.ts`
- Modify: `packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts`
- Test: `packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts`
- Test: `packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts`

**Implementation Notes:**

- Keep setting `isMainActive=true` for main turn facts:
  - `task_run_started`
  - `goal_iteration_started`
  - running context compaction timeline
  - `agent_message_chunk`
  - `agent_thought_chunk`
  - background monitor `task_run_started` for inactive task
- Do not set `isMainActive=true` for background-only facts:
  - `background_bash_jobs_update`
  - mirrored child `tool_call` / `tool_call_update` from background subagent
  - background control UI updates
- Do not duplicate terminal cleanup; terminal/non-running remains centralized in `setTaskRuntimeState(non-running)`.

### Checklist

- [ ] Audit live writers.

```bash
rg -n "setTaskMainActive" packages/ui/src/hooks packages/ui/src/lib
```

Expected:
- Writers correspond to main turn start/chunk paths or queued prompt drain/direct send.
- No background-only update path writes `true`.

- [ ] Add or confirm test: background-only streaming does not queue normal prompt.

Existing target:
`packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts`

Expected assertion:

```ts
expect(
  shouldQueuePromptForMainActivity({
    currentStatus: "idle",
    runtimeState: { activeInputId: "background-run", status: "streaming" },
    isMainActive: false,
    stopRequested: false,
    queuedPromptCount: 0,
  }),
).toBe(false);
```

- [ ] Add or confirm test: main-active streaming still queues normal prompt.

Expected assertion:

```ts
expect(
  shouldQueuePromptForMainActivity({
    currentStatus: "idle",
    runtimeState: { activeInputId: "main-run", status: "streaming" },
    isMainActive: true,
    stopRequested: false,
    queuedPromptCount: 0,
  }),
).toBe(true);
```

- [ ] Add or confirm test: queued drain proceeds when only background keeps runtime streaming.

Existing target:
`packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts`

Expected assertion:
- runtime status can be `streaming`
- activeInputId can be set to a background id
- `isMainActive` remains false
- `triggerTaskQueuedPromptDrain(...)` calls `sendPrompt(...)`

- [ ] Run Phase 3 focused tests.

```bash
pnpm exec vitest run \
  packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts \
  packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts
```

Expected: PASS.

**Phase 3 Exit Criteria**

- [ ] Live main events set `isMainActive=true`.
- [ ] Background-only events do not set `isMainActive=true`.
- [ ] Terminal cleanup is not duplicated.
- [ ] Queue policy and drain tests pass before Phase 4.

---

## Phase 4: Restore / Reconnect Regression Coverage

**Purpose:** 补齐本轮真正缺口：restore/reconnect 时 `isMainActive` 和 runtime snapshot 保持一致。

**Files:**
- Test: `packages/ui/test/taskSnapshotRuntimeStateSync.test.ts`
- Test: `packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts`
- Optional Test: `packages/ui/test/taskStreamEventSnapshotSync.test.ts` if existing helpers make stale snapshot behavior easy to isolate

### Checklist

- [ ] Add unit test: restore active snapshot makes normal send queue.

Test structure:

```ts
// 1. Apply snapshot ephemeral runtime { mainActive: true, activeTurnKind: "regular" }.
// 2. Set task runtime state to streaming.
// 3. Call shouldQueuePromptForMainActivity(... isMainActive from store ...).
// 4. Expect true.
```

- [ ] Add unit test: restore completed snapshot allows direct send.

Test structure:

```ts
// 1. Set isMainActive true.
// 2. Apply accepted runtime { mainActive: false } or setTaskRuntimeState(..., "completed").
// 3. Call shouldQueuePromptForMainActivity(...).
// 4. Expect false when no queued prompt, stop, timeline, or goal active.
```

- [ ] Add stale-snapshot regression if feasible.

Test intent:
- Current store has a new main active run.
- A stale terminal snapshot for an older run is processed.
- Existing stale guard prevents runtime terminal application.
- `isMainActive` remains true.

If the current test harness cannot call `syncTaskSnapshotAfterEvent()` cleanly without heavy setup, record this as covered by existing stale runtime tests and do not introduce a brittle mock-heavy test.

- [ ] Run Phase 4 tests.

```bash
pnpm exec vitest run \
  packages/ui/test/taskSnapshotRuntimeStateSync.test.ts \
  packages/ui/test/chatStatus.test.ts \
  packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts \
  packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts
```

Expected: PASS.

**Phase 4 Exit Criteria**

- [ ] Active snapshot -> `isMainActive=true` -> normal send queues.
- [ ] Completed snapshot / terminal runtime -> `isMainActive=false` -> normal send can direct-send.
- [ ] Stale snapshot does not overwrite current active main semantics.
- [ ] Phase 4 tests pass before E2E.

---

## Phase 5: Targeted E2E Validation

**Purpose:** 验证用户可见行为没有回归，特别是 background-only 不再造成 fake loading，同时 foreground 仍保持原 loading。

**Files:**
- Modify if needed: `packages/desktop/test/e2e/conversation-session/background/conversation-session-background.test.ts`
- Modify if needed: `docs/conversation-session-case-catalog.md`
- Modify if needed: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
- Modify if needed: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify if needed: E2E fixture JSON files under:
  - `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-background.json`
  - `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json`

### Checklist

- [ ] Confirm or add E2E: background subagent child tool update does not show main loading.

Expected:
- Background Agent control row is visible.
- Renderer store may receive child tool update.
- `chat-view` remains idle for main.
- No visible bottom `chat-loading`.

- [ ] Confirm or add E2E: foreground subagent child tool update still shows main loading.

Expected:
- Foreground Agent child tool update keeps main streaming.
- Bottom `chat-loading` appears.

- [ ] Confirm or add E2E: background running does not queue normal user prompt.

Expected:
- Main is idle.
- Background task is still running.
- User sends ordinary text.
- Provider receives the message as a new request.
- `queueCount` remains 0.

- [ ] Run targeted E2E only.

```bash
# workdir: packages/desktop
./node_modules/.bin/wdio run wdio.conf.ts \
  --spec ./test/e2e/conversation-session/background/conversation-session-background.test.ts \
  --mochaOpts.grep "background subagent 的 child tool update|foreground subagent 的 child tool update|background task running 时用户普通消息应直接发送"
```

Expected:
- Targeted E2E passes.

**Phase 5 Exit Criteria**

- [ ] Targeted E2E passes.
- [ ] E2E docs / matrix / fixtures stay consistent if any E2E case is added or renamed.
- [ ] No broad E2E run is required unless targeted E2E or unit tests expose shared fixture risk.

---

## Phase 6: Final Verification And Review

**Purpose:** 提交前完整验证，但不自动提交。

### Checklist

- [ ] Run focused unit tests.

```bash
# workdir: apps/zcode-cli
./node_modules/.bin/vitest run \
  packages/bootstrap/tests/zcode-protocol.test.ts -t "mainActive|last projected turn"
pnpm exec vitest run \
  packages/ui/test/taskSnapshotRuntimeStateSync.test.ts \
  packages/ui/test/chatStatus.test.ts \
  packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts \
  packages/ui/test/zcodeTaskRuntimeMonitorQueueDrain.test.ts
```

Expected: PASS.

- [ ] Run typecheck.

```bash
pnpm typecheck
```

Expected: exit 0.

- [ ] Run lint.

```bash
pnpm lint
```

Expected: exit 0. Existing warnings are acceptable only if lint exits 0 and none are introduced by this change.

- [ ] Run whitespace check.

```bash
git diff --check
```

Expected: no output.

- [ ] Run targeted E2E from Phase 5.

Expected: PASS.

- [ ] Review diff boundaries.

```bash
git diff --stat
rg -n "mainActive|isMainActive|setTaskMainActive|activeTurnId|activeInputId" \
  packages/shared/src packages/ui/src packages/ui/test apps/zcode-cli/packages/bootstrap
```

Expected:
- `mainActive` appears in protocol type/schema, mapper, UI snapshot sync, store, tests.
- `activeTurnId` is not written into `activeInputId`.
- `isMainActive` is consumed only by main loading, normal send queue decision, queued prompt drain, and tests.

**Phase 6 Exit Criteria**

- [ ] Unit tests pass.
- [ ] Typecheck passes.
- [ ] Lint exits 0.
- [ ] `git diff --check` passes.
- [ ] Targeted E2E passes.
- [ ] Final response reports verification evidence.
- [ ] Do not commit automatically.

---

## Expected Final Behavior

- Foreground main turn running:
  - `runtime.status` can be `streaming`
  - `TaskUiState.isMainActive === true`
  - bottom loading is visible
  - ordinary user send enters queue
  - queued prompt drain waits

- Background-only task running while main idle:
  - `runtime.status` may still be `streaming` because background task/control state is active
  - `TaskUiState.isMainActive === false`
  - bottom fake loading is hidden
  - ordinary user send goes directly
  - queued prompt drain can proceed

- Restore/reconnect active main turn:
  - snapshot carries `runtime.mainActive === true`
  - UI restore sets `TaskUiState.isMainActive === true`
  - bottom loading and queue behavior match an active main turn before live chunk arrives

- Restore/reconnect completed task:
  - snapshot carries `runtime.mainActive === false` or terminal runtime clears it
  - UI restore leaves `TaskUiState.isMainActive === false`
  - no fake loading
  - ordinary user send can start a new turn

---

## Self-Review Checklist

- [ ] The plan does not introduce a new durable DB field.
- [ ] The plan does not rename or repurpose `activeInputId`.
- [ ] The plan does not infer `mainActive` in ChatView/useZCodeChat from `activeTurnId`.
- [ ] The plan keeps terminal cleanup centralized in `setTaskRuntimeState(non-running)`.
- [ ] The plan includes RED/GREEN unit tests before each implementation phase.
- [ ] The plan includes targeted E2E before final completion.
- [ ] The plan explicitly says not to auto-commit.
