# Background Subagent Failure Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a background subagent provider failure message through task notification, user-visible Agent result, existing failure hover, and snapshot restore.

**Architecture:** The child turn already throws a structured error whose cause retains the provider message. The background finalizer will select that existing primary message once, place it in both the failed summary and `<error>`, and the shared notification parser will carry it into desktop-continuous and replayable projections. Existing Agent/ToolLayout UI consumes `toolCall.error`; no component, copy, or i18n change is required.

**Tech Stack:** TypeScript, Vitest, WDIO Electron E2E, case-local DeepSeek replay fixtures.

## Global Constraints

- Keep the visible status copy `执行失败` and the existing hover/copy interaction unchanged.
- Append the provider message directly after `Agent <type> task "<description>" failed.`; do not translate it or synthesize HTTP/code labels.
- Exclude the empty `finishReason=stop` subagent and main-model 429 queue/retry semantics.
- Preserve desktop `desktop-continuous` and mobile/service `web-remote-replayable` projection boundaries.
- Add tests before production code and observe the E2E/unit regression fail for the expected missing-error behavior.
- Do not modify `ToolLayout.tsx`, Agent renderer styling, or locale files.

---

### Task 1: Lock the accepted case and fixture contract

**Files:**

- Modify: `apps/zcode-cli/docs/design/v2/tool/07-subagent.md`
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-background-e2e-coverage-matrix.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**

- Produces: accepted `BG26` setup/action/assertion and `BGE` automation mapping.

- [x] Record the exact failed summary, `<error>`, hover, idle, and restore assertions.
- [x] Record that 429 is a representative child failure only; main-model 429 and empty stop remain out of scope.

### Task 2: Write the failing E2E first

**Files:**

- Create: `packages/desktop/test/e2e/conversation-session/background/conversation-session-background-subagent-rate-limit.test.ts`
- Create: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background-subagent-rate-limit.json`
- Create: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-background-subagent-rate-limit.json`

**Interfaces:**

- Consumes: existing conversation helpers, tool diagnostics, and task switching helpers.
- Produces: a case-local fixture that launches one background Agent, returns repeatable child-only 429 responses with `retry-after: 0`, and consumes the failed task notification in the parent.

- [x] Create a main fixture that emits `Agent(run_in_background=true)` with stable parent/child markers.
- [x] Create an unlimited child-only 429 fixture using `lastUserMessageIncludes` so parent requests cannot match it.
- [x] Assert the provider-visible notification contains `<status>failed</status>`, the provider message in `<error>`, and the same message immediately after `failed.` in `<summary>`.
- [x] Assert renderer store and DOM show failed, expanded output contains the exact summary, and hovering `执行失败` exposes the provider message.
- [x] Switch to a new draft and back; repeat status/output/hover assertions from restored snapshot.
- [x] Run fixture check and explicit-fixture WDIO. Expected RED: current output remains generic or restored status is completed/error is missing.

### Task 3: Add focused failing tests for each data boundary

**Files:**

- Modify: `apps/zcode-cli/packages/core/tests/subagent-background.test.ts`
- Modify: `packages/shared/test/backgroundTaskNotifications.test.ts`
- Modify: `packages/ui/test/zcodeSessionProjection.test.ts`
- Modify: `packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts`

**Interfaces:**

- Produces: focused contracts for structured cause selection, failed summary formatting, XML parsing, live event error, and snapshot terminal overlay.

- [x] Make a background child reject with a wrapper `Turn execution failed` whose cause message is the provider rate-limit text; assert notification/registry/SubagentStopped use the cause message.
- [x] Assert `<error>` XML entities decode exactly once.
- [x] Assert both live projection functions emit `status: "failed"` and `error: providerMessage`.
- [x] Assert completed launch ACK plus failed notification restores as a failed persisted tool with the same error.
- [x] Run the four focused test files and confirm failures are caused by the missing behavior.

### Task 4: Implement the minimal source fix

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/subagent/runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/subagent/completion-notification.ts`
- Modify: `packages/shared/src/background-task-notifications.ts`
- Modify: `packages/ui/src/lib/zcodeSessionProjection.ts`
- Modify: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`

**Interfaces:**

- Consumes: `selectExecutionErrorMessage(error)` and existing notification/status helpers.
- Produces: one provider-message string propagated as summary suffix and tool error across live/restore paths.

- [x] In `finalizeBackgroundFailure`, select the wrapper cause's original message without whitespace normalization or truncation for Error objects, and preserve `String(error)` for non-Error values.
- [x] Use trim only to reject empty failed errors, but append the unmodified value; leave completed/stopped byte-for-byte unchanged.
- [x] Parse `<error>` in the shared notification parser.
- [x] Map failed live notifications to `tool_call_update.error` in UI and service projections.
- [x] When a completed launch ACK has a matching failed notification, overlay failed/error in both snapshot mappers; preserve stopped/killed and native `state.status === "error"` behavior.
- [x] Run focused tests until GREEN without changing their expected product behavior.

### Task 5: Prove the original symptom and regression safety

**Files:**

- Test: all files listed above.

**Interfaces:**

- Produces: replay artifacts and verification output.

- [x] Re-run explicit-fixture WDIO and default replay for `conversation-session-background-subagent-rate-limit.test.ts`.
- [x] Run `pnpm --filter @zcode/desktop typecheck:e2e`.
- [x] Run the conversation coverage audit.
- [x] Run `pnpm typecheck`, `pnpm lint`, and `git diff --check`.

### Task 6: Dependency and code-review closeout

**Files:**

- Review: complete working-tree diff against the worktree base SHA.

**Interfaces:**

- Produces: concrete import/reference inventory and an independent merge-readiness verdict.

- [x] Use `pnpm dep:refs --list-exports` on the changed shared/core files, then unscoped `pnpm dep:refs <file>:<export>` for every changed exported symbol.
- [x] Use `rg` for non-exported duplicate implementations and string-based `<task-notification>` consumers that static symbol tracing cannot detect.
- [x] Dispatch independent read-only reviewers with the requirements, base SHA, full working-tree diff, and fresh verification evidence.
- [x] Fix every Critical/Important issue, rerun affected tests, and repeat review if production code changed.
- [x] Re-run the complete final verification set immediately before reporting completion.
