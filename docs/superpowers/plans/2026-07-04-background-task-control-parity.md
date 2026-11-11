# Background Task Control Implementation Plan

> Status: implemented and archived. This file records the final scope, phase outcomes, verification commands, and intentionally deferred capabilities for future work.

## Goal

为已经进入 background 的 `local_bash` 和 `local_agent` 提供用户可触发的 stop/cancel 控制能力，并实现 provider-visible `TaskStop` tool。实现必须复用现有 `RuntimeTaskRegistry`、background notification、runtime command queue、session projection 和 `session/cancelBackgroundTask` 链路，不新增第二套 background manager、poller、wake 或 UI stop path。

## Final Architecture

- Runtime 内有 registry-first background task stop dispatcher。
- `TaskStop` tool 和 UI/session cancel 共用同一个 dispatcher。
- `local_bash` stop 分发到 `ExecutionPort.cancelBackgroundTask(taskId)`。
- `local_agent` stop 分发到 `SubagentPort.stopTask(taskId)`。
- `TaskStop.command` 语义：`local_bash` 使用实际命令，`local_agent` 使用短 `description`；完整 subagent `prompt` 不得进入 stop result。
- terminal 状态继续走 registry terminal update -> task notification -> runtime command queue。
- UI 只保留 SummaryPanel 这一处 background task control surface。
- `AgentToolCallBlock` 只负责 background Agent 详情展示，不复制 stop 请求逻辑。
- stop RPC ACK 只表示 runtime 接收了停止请求；UI stop pending 会等 background task control 状态不再 active 后再释放。

## Code Anchors

- `TaskStop` contract: `apps/zcode-cli/packages/contracts/src/tools/task-stop.ts`
- `TaskStop` model-facing handler: `apps/zcode-cli/packages/core/src/tool/handlers/task-stop.ts`
- Runtime background stop dispatch: `apps/zcode-cli/packages/core/src/runtime/methods/background.ts`
- UI/session cancel protocol: `session/cancelBackgroundTask` in `packages/shared/src/zcode-protocol/index.ts`
- Bash task stop: `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts`
- Agent task stop: `apps/zcode-cli/packages/core/src/subagent/runner.ts`

## Completed Phases

### Phase 0 - Spec and Baseline Guard

- [x] Fixed scope to already-background `local_bash` / `local_agent` stop control plus provider-visible `TaskStop`.
- [x] Kept foreground-to-background controls, `TaskOutput`, and non-shared task types out of this round.
- [x] Recorded code anchors and current ZCode starting points.

### Phase 1 - Runtime Stop Dispatcher

- [x] Added registry-first runtime background task stop dispatch.
- [x] Preserved idempotent UI/session behavior for missing or already-terminal tasks.
- [x] Added strict/tool behavior for `TaskStop` validation errors.
- [x] Kept dispatcher free of new queue, poller, timer, or provider-visible notification generation.

### Phase 2 - Subagent Stop Handler

- [x] Added `SubagentPort.stopTask()` for running background `local_agent`.
- [x] Background Agent stop uses the saved lifecycle controller and writes terminal state through the same background completion path.
- [x] Stop does not mutate UI projection as the source of truth.
- [x] Existing launch/run/start/backgroundTask/sendMessage behavior remains owned by the subagent runtime.

### Phase 3 - Terminal Idempotency and Notification Ordering

- [x] Stop and natural completion are terminal-idempotent for Bash and Agent.
- [x] `notified` is only marked after notification enqueue succeeds.
- [x] Background terminal order remains registry terminal update -> enqueue notification -> async event/projection.
- [x] Goal defer continues to read `RuntimeTaskRegistry` running background tasks rather than UI projection.

### Phase 4 - Provider-visible TaskStop Tool

- [x] Added `TaskStop` contract and handler.
- [x] Input supports `task_id` and deprecated `shell_id` alias.
- [x] Validation returns distinct errors for missing id, not found task, and not-running task.
- [x] Result is JSON-compatible and does not expose internal snapshots/projections.
- [x] Result `command` 对 `local_agent` 取 runtime task 的短 `description`，成功消息括号内复用同一值，不暴露完整 `prompt`。
- [x] `KillShell` / `KillBash` aliases are supported through runtime lookup without becoming provider-visible tools.
- [x] Default child runtimes can expose `TaskStop` for runtime-local background tasks; custom profiles still use existing allow/disallow filtering.

### Phase 5 - Protocol and UI Control Surface

- [x] Kept `session/cancelBackgroundTask` protocol name to avoid protocol churn.
- [x] Added generic background task control item model for Bash and Agent.
- [x] Removed the duplicated long-running background task panel surface.
- [x] SummaryPanel is now the single background task control surface.
- [x] Bash and Agent tasks share the same stop button behavior and protocol call.
- [x] Stop button is disabled per task while stop is pending.
- [x] Stop pending is cleared only after the task is no longer active, not immediately after stop RPC ACK.
- [x] Snapshot/replay cache keys preserve `workspaceIdentity` / `workspacePath` semantics.

### Phase 6 - E2E Coverage

- [x] Updated conversation-session case catalog and coverage matrix for background control cases.
- [x] Promoted E2E coverage for background Bash UI stop.
- [x] Promoted E2E coverage for background Agent UI stop.
- [x] Promoted E2E coverage for `TaskStop` Agent path.
- [x] Background Agent natural completion display regression is covered by promoted background E2E.
- [x] Stop/control E2E cases use explicit setup, action, and assertion.

### Phase 7 - Regression Gate

- [x] Ran focused core, UI, shared, service, and E2E replay validation during implementation.
- [x] Ran `pnpm typecheck`.
- [x] Ran `pnpm lint`.
- [x] Ran `git diff --check`.
- [x] Reviewed provider-visible changes and kept background notification XML shape unchanged for this scope.

## Validation Record

Commands run during implementation and cleanup:

```bash
pnpm exec oxfmt --check apps/zcode-cli/packages/core/src/tool/executor/impl.ts apps/zcode-cli/packages/core/tests/task-stop-tool.test.ts apps/zcode-cli/packages/core/tests/tool-contracts.test.ts packages/desktop/test/e2e/conversation-session/background/conversation-session-background.test.ts
pnpm --filter @zcode/core exec vitest run tests/task-stop-tool.test.ts tests/background-task-control.test.ts tests/tool-contracts.test.ts tests/subagent-explore.test.ts -t "TaskStop|background task control|orders shared provider-visible|runs through Agent"
pnpm exec vitest --run packages/ui/test/zcodeSessionProjection.test.ts packages/ui/test/agentToolCallBlock.test.ts -t "task notification|background Agent|single background task"
pnpm exec vitest --run packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts -t "task notification|background Agent"
pnpm exec vitest --run packages/shared/test/backgroundBashJobs.test.ts packages/ui/test/chatViewSummaryPanel.test.ts packages/ui/test/zcodeBackgroundTaskControl.test.ts -t "background Agent|background task|background Bash|running task"
pnpm exec vitest --run packages/shared/test/backgroundBashJobs.test.ts packages/ui/test/chatViewSummaryPanel.test.ts packages/ui/test/backgroundTaskSnapshotSync.test.ts packages/ui/test/zcodeBackgroundTaskControl.test.ts packages/ui/test/longRunningToolCalls.test.ts
pnpm exec vitest --run packages/ui/test/zcodeBackgroundTaskControl.test.ts packages/ui/test/chatViewSummaryPanel.test.ts
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/background/conversation-session-background.test.ts'
pnpm typecheck
pnpm lint
git diff --check
```

## Intentional Deferred Scope

These are known adjacent capabilities, but they were intentionally not implemented in this plan:

- Deferred: SDK/control `background_tasks` foreground-to-background command.
- Deferred: Ctrl+B or keyboard-triggered foreground-to-background conversion.
- Deferred: `TaskOutput` / output retrieval.
- Deferred: single output-file convergence for Bash notifications.
- Deferred: manual controls for monitor/workflow unless product scope expands.
- Deferred: mobile Web replayable E2E promotion for this specific control surface; implementation preserves `workspaceIdentity` / `workspacePath` boundaries, but mobile replayable promotion remains a separate validation item.

## Final Self-Review

- [x] Changed behavior traces back to the spec scope above or current ZCode behavior.
- [x] No generic background manager was added.
- [x] `local_bash` and `local_agent` stop through one runtime dispatcher.
- [x] Stop lifecycle is registry-first rather than projection-first.
- [x] Completed/stopped background tasks still wake main through task notification.
- [x] Race cases are covered by focused tests instead of timers.
- [x] UI changes are limited to the existing background task control surface.
- [x] No automatic commit was made by this plan.
