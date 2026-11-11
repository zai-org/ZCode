# Desktop E2E Runtime Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate platform-dependent `/tmp` usage from Desktop E2E runtime files while preserving existing conversation product semantics.

**Architecture:** Keep `.e2e-home` as the isolated HOME and place runtime files under the Agent execution workspace `ZCodeProject/.zcode-e2e`. Specs use a shared path helper, Bash uses workspace-relative POSIX paths, and replay fixtures expand `{{e2eRuntimeRoot}}` before matching requests. Runtime evidence confirms conversation child agents execute from `ZCodeProject`, not the conversation backing workspace.

**Tech Stack:** TypeScript, Vitest, WebdriverIO, JSON replay fixtures, Node.js filesystem/path APIs.

## Global Constraints

- Update specs before implementation and preserve the existing BG21/BG25 product semantics.
- Do not change desktop continuous or web remote replayable behavior.
- Every bug-fix comment added to source code must explain the cause in Chinese.
- `packages/desktop/test/e2e` must contain no raw `/tmp` literal after migration.
- Run `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, and `pnpm lint` before completion.

---

### Task 1: Define and test the cross-platform runtime path contract

**Files:**
- Create: `packages/desktop/test/e2e/helpers/e2e-runtime-paths.ts`
- Create: `packages/desktop/test/e2eRuntimePaths.test.ts`

**Interfaces:**
- Produces: `E2E_RUNTIME_RELATIVE_ROOT`, `E2E_RUNTIME_ROOT_REPLAY_TOKEN`, `resolveE2EHomeDir()`, `resolveE2ERuntimeRoot()`, `resolveE2ERuntimePath()`, `resolveE2EToolPath()`, and `resolveE2EShellPath()`.

- [ ] **Step 1: Write failing tests** proving runtime files resolve below `<home>/ZCodeProject/.zcode-e2e`, tool paths use `/`, shell paths remain workspace-relative, and the E2E tree contains no raw `/tmp`.

```ts
expect(resolveE2ERuntimeRoot("C:\\e2e-home")).toContain(".zcode-e2e");
expect(resolveE2EShellPath("bg25", "release-child-bash")).toBe(
  ".zcode-e2e/bg25/release-child-bash",
);
expect(findRawSystemTmpReferences()).toEqual([]);
```

- [ ] **Step 2: Run `pnpm --filter @zcode/desktop exec vitest run test/e2eRuntimePaths.test.ts`** and verify failure is caused by the missing helper/current raw literals.
- [ ] **Step 3: Implement the minimal pure path helper** using `node:path` and the existing E2E HOME environment precedence.

```ts
export function resolveE2ERuntimePath(...segments: string[]) {
  return join(resolveE2ERuntimeRoot(), ...segments);
}

export function resolveE2EShellPath(...segments: string[]) {
  return posix.join(E2E_RUNTIME_RELATIVE_ROOT, ...segments);
}
```

- [ ] **Step 4: Re-run the focused test** and retain the expected raw-literal failure until fixture migration is complete.

### Task 2: Expand static replay variables before request matching

**Files:**
- Modify: `packages/desktop/test/e2e/helpers/upstream-replay-server.ts`
- Modify: `packages/desktop/test/upstreamReplayServer.test.ts`
- Modify: `packages/desktop/wdio.conf.ts`

**Interfaces:**
- Consumes: `resolveE2ERuntimeRoot()` and `E2E_RUNTIME_ROOT_REPLAY_TOKEN` from Task 1.
- Produces: `StartUpstreamReplayServerOptions.fixtureVariables?: Readonly<Record<string, string>>`.

- [ ] **Step 1: Add a replay server test** whose matcher and response/tool input contain `{{e2eRuntimeRoot}}`.

```ts
const server = await startUpstreamReplayServer({
  artifactPath,
  fixturePaths: [fixturePath],
  fixtureVariables: { e2eRuntimeRoot: "C:/e2e/.zcode-e2e" },
});
const response = await fetch(`${server.baseUrl}/messages`, {
  body: JSON.stringify({ messages: [{ role: "user", content: "Read C:/e2e/.zcode-e2e/file.txt" }] }),
  method: "POST",
});
expect(await response.text()).toContain("C:/e2e/.zcode-e2e/file.txt");
```

- [ ] **Step 2: Run the focused replay test** and verify it returns Missing Fixture before implementation.
- [ ] **Step 3: Recursively replace static tokens in parsed fixtures during `loadFixtureFile`**; retain request-derived `latestAgentId` replacement for response time.

```ts
const fixtures = options.fixturePaths.flatMap((path) =>
  loadFixtureFile(path, options.fixtureVariables ?? {}),
);
```

- [ ] **Step 4: Pass `e2eRuntimeRoot` from WDIO** as a slash-normalized absolute path derived from `E2E_HOME_DIR`.
- [ ] **Step 5: Re-run replay server tests** and verify matcher and response replacement pass.

### Task 3: Migrate specs and helpers to the runtime root

**Files:**
- Modify: `packages/desktop/test/e2e/helpers/conversation-session.ts`
- Modify: `packages/desktop/test/e2e/helpers/conversation-session-tool-cross-product.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/permissions/conversation-session-v4-bash-command-prefix-permission.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/permissions/conversation-session-v4-permission.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/permissions/conversation-session-v4-refresh-permission.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/presentation/conversation-session-v4-turn-navigator.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-background.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-compact-auto.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/planning/conversation-session-plan-mode-capabilities.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/telemetry/conversation-session-telemetry-parity-core.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/tools/conversation-session-tool-actions.test.ts`
- Modify: `packages/desktop/test/e2e/bots/helpers/bots-service-harness.ts`
- Modify: `packages/desktop/test/e2e/bots/delivery/feishu-streaming-card-lifecycle.test.ts`

**Interfaces:**
- Consumes: native/tool/shell path resolvers from Task 1.

- [ ] **Step 1: Replace Node filesystem constants** with native runtime paths scoped by case.
- [ ] **Step 2: Replace user-visible/tool prompt paths** with portable absolute tool paths.
- [ ] **Step 3: Replace Bash paths** with `.zcode-e2e/<case>/...` shell paths.
- [ ] **Step 4: Keep setup and cleanup case-local** and add Chinese root-cause comments at the shared helper/barrier boundaries.

### Task 4: Migrate provider fixtures, manifests, and E2E snapshots

**Files:**
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-compact-interrupted.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-compact-manual-queue.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-edit.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-running-actions.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-telemetry-parity-core.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-tool-cross-product.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-v4-bash-command-prefix-permission.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-v4-permission.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-v4-refresh-permission.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-v4-turn-navigator.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/common.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-compact-interrupted.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-plan-mode-capabilities.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-running-guide-steer.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-interaction-delegate.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-subagent-respond-to-coordinator.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-telemetry-parity-core.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-tool-cross-product.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-unregistered-tool-cold-snapshot.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-bash-command-prefix-permission.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-permission.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-refresh-permission.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-turn-navigator.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/provider-basic.json`
- Modify: `packages/desktop/test/e2e/fixtures/upstream/provider-conversation-tool-cross-product.json`

**Interfaces:**
- Consumes: `{{e2eRuntimeRoot}}` for absolute tool/matcher values and `.zcode-e2e/<case>` for Bash commands.

- [ ] **Step 1: Replace Read/Write/Edit/Glob/Grep absolute values** with `{{e2eRuntimeRoot}}/<case>/...`.

```json
{ "file_path": "{{e2eRuntimeRoot}}/conversation-session-tool-cross-product/read-fixture.txt" }
```

- [ ] **Step 2: Replace Bash command values** with `.zcode-e2e/<case>/...`.

```json
{ "command": "while [ ! -f '.zcode-e2e/conversation-session-subagent-respond-to-coordinator/release-child-bash' ]; do sleep 0.05; done" }
```

- [ ] **Step 3: Replace manifest file paths** with workspace-relative `.zcode-e2e/<case>/...` metadata.
- [ ] **Step 4: Replace non-executed `/tmp` E2E snapshot values** with runtime-root tokens so the tree has one mechanical contract.
- [ ] **Step 5: Run the path contract test** and verify the raw-literal audit passes.

### Task 5: Verify fixtures and the original cross-platform failure path

**Files:**
- Verify: `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-subagent-respond-to-coordinator.test.ts`
- Verify: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-background.test.ts`
- Verify: `packages/desktop/test/e2e/conversation-session/permissions/conversation-session-v4-permission.test.ts`
- Verify: `packages/desktop/test/e2e/conversation-session/permissions/conversation-session-v4-refresh-permission.test.ts`
- Verify: `packages/desktop/test/e2e/conversation-session/presentation/conversation-session-v4-turn-navigator.test.ts`
- Verify: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-tool-cross-product.test.ts`

**Interfaces:**
- Consumes: migrated specs, replay fixtures, and manifests.

- [ ] **Step 1: Run focused Vitest suites** for runtime paths, replay variables, and fixture resolution.
- [ ] **Step 2: Run `e2e:fixture:check`** for BG25, BG21, v4 permission, refresh permission, turn navigator, and tool cross product specs.
- [ ] **Step 3: Run strict case-local BG25 replay** and verify the Bash barrier releases, coordinator reply is consumed, and child completes.
- [ ] **Step 4: Run representative permission and tool-cross-product replays** to verify absolute tool paths and relative Bash paths converge.
- [ ] **Step 5: Run `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, and `pnpm lint`** and report any pre-existing warnings separately.
- [ ] **Step 6: Review `git diff`, stage the scoped files, and commit** with a Conventional Commit message.
