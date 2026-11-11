# Agent Step Message Scope E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a deterministic failing desktop E2E that proves `message_completion.agent_step_cnt` incorrectly accumulates prior turns instead of counting only `agent_step` events for the current `messageId`.

**Architecture:** Run two plain-text replayed turns in one desktop continuous session, while a WDIO Electron mock records the main process `net.fetch` telemetry requests. Group final HTTP bodies by `talk_id + message_id` and compare the second completion count with its actual generation-step count.

**Tech Stack:** WebdriverIO/Electron mocks, TypeScript, DeepSeek replay fixtures.

---

### Task 1: Add deterministic provider data

**Files:**
- Create: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-agent-step-message-scope.json`
- Create: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-agent-step-message-scope.json`

- [x] **Step 1:** Add two `main` synthetic `fast-text` fixtures matched by `E2E_AGENT_STEP_MESSAGE_SCOPE_FIRST_` and `E2E_AGENT_STEP_MESSAGE_SCOPE_SECOND_`.
- [x] **Step 2:** Return one plain text block per request so each turn deterministically creates one generation step.
- [x] **Step 3:** Record both requests and their `syntheticReason` in the case manifest.
- [x] **Step 4:** Validate both JSON files with `node -e` JSON parsing.

### Task 2: Write the failing E2E

**Files:**
- Create, then promote: `packages/desktop/test/e2e/conversation-session/presentation/conversation-session-agent-step-message-scope.test.ts`

- [x] **Step 1:** Prepare conversation E2E, mock Electron `net.fetch`, and make telemetry requests resolve with an HTTP-success-shaped result.
- [x] **Step 2:** Send the first marker prompt, wait for its network capture and idle completion.
- [x] **Step 3:** Send the second marker prompt in the same session, wait for capture and idle completion.
- [x] **Step 4:** Poll the mock call history and parse telemetry endpoint request bodies for `agent_step` / `message_completion`.
- [x] **Step 5:** Assert two completions share one `talkId`, use different `messageId` values, and the second message has exactly one `generation` step with `loop_index=1`.
- [x] **Step 6:** Assert the second `agent_step_cnt` equals that one step; current code must fail with expected `1`, received `2`.

### Task 3: Verify the RED reproduction

**Files:**
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

- [x] **Step 1:** Run the pending spec with manual review enabled and explicit common + case-local fixture paths.
- [x] **Step 2:** Confirm failure occurs only at the message-scoped count assertion and preserve the output as reproduction evidence.
- [x] **Step 3:** Change matrix status for R01 from `planned` to `failing`.
- [x] **Step 4:** Run `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, and `pnpm lint`.
- [x] **Step 5:** Run `git diff --check`, inspect the final diff, and commit with Conventional Commits.

### Task 4: Promote the reviewed reproduction

**Files:**
- Move: `packages/desktop/test/e2e/conversation-session/presentation/conversation-session-agent-step-message-scope.test.ts` → `packages/desktop/test/e2e/conversation-session/presentation/conversation-session-agent-step-message-scope.test.ts`
- Modify: case manifest、provider fixture、coverage matrix

- [x] **Step 1:** Run promotion dry-run with the explicit human-reviewed signal.
- [x] **Step 2:** Apply promotion and update every stored spec path to the formal location.
- [x] **Step 3:** Run fixture validation and both case-local/default replay variants.
- [x] **Step 4:** Keep the case out of Docker admission while the known count assertion remains RED.
