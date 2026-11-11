# GLM-5.2 Suffixed Variant Media Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing unknown third-party GLM image fail-closed behavior while leaving unknown `glm-5.2-*` suffixed variants fail-open without encoding any private identifier.

**Architecture:** Keep capability precedence and the existing GLM-family matcher unchanged. Add a public structural predicate in the bootstrap capability resolver, normalize only the final provider-visible model ID segment before matching a non-empty hyphen suffix, then cover the fallback boundary with neutral unit fixtures and keep N08 scoped to its explicit text-only E2E contract.

**Tech Stack:** TypeScript, Vitest, ZCode Protocol model catalog, conversation-session case catalog and coverage audit.

## Global Constraints

- Do not add private model IDs, provider IDs, base URLs, suffix tokens, hashes, encoded identifiers, or obfuscated equivalents to source, tests, docs, fixtures, logs, or comments.
- Keep explicit `supportsImages: true` and `supportsImages: false` precedence unchanged.
- Keep canonical GLM-5.2, GLM-5.1, and other existing GLM-family unknown-provider behavior unchanged.
- Do not modify GLM reasoning, dated-model, context-window, protocol-schema, provider-registry, desktop-continuous, or web-remote-replayable semantics.
- Update conversation-session catalog and matrix language before changing test or implementation code.
- Use neutral model fixtures such as `GLM-5.2-variant`.
- Do not commit unless the user explicitly requests a commit.

---

### Task 1: Narrow the documented N08 contract

**Files:**
- Modify: `docs/conversation-session-case-catalog.md:275`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md:176`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-10-glm-52-suffixed-variant-media-fallback-design.md`.
- Produces: an accepted explicit text-only GLM-5.2 provider-visible strip contract without claiming that the E2E covers the unknown provider-aware fallback.

- [ ] **Step 1: Update the N08 catalog row before code**

Replace the N08 event text with:

```text
用户切到第三方、明确声明 text-only 的 GLM-5.2 后继续发送
```

Keep the existing provider-visible placeholder expectation, then add this paragraph immediately after the N table:

```markdown
N08 只覆盖明确声明 text-only 时的 provider-visible 媒体投影合同。能力 unknown 时，canonical `GLM-5.2` 触发 fail-closed、`GLM-5.2-*` suffixed variant 保持 unknown 的边界由 bootstrap capability unit test 覆盖；unknown 不被 capability projection 主动 strip 的语义由 core media capability unit test 覆盖，后续仍受统一 media-budget projection 约束。
```

- [ ] **Step 2: Update the coverage matrix description**

Replace the N08 note with:

```text
completed 历史含图片后切到第三方、明确声明 text-only 的 GLM-5.2，后续 provider-visible 请求把历史图片替换为 placeholder，且不携带 image block/data URL
```

- [ ] **Step 3: Run the authoritative documentation audit**

Run:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
```

Expected: exit code `0` and no stale catalog/matrix coverage error for N08.

### Task 2: Add the failing capability boundary tests

**Files:**
- Test: `apps/zcode-cli/packages/bootstrap/tests/model-selection.test.ts:136-220`

**Interfaces:**
- Consumes: `resolveRuntimeModelInputCapabilities(modelRef, modelCatalog)`.
- Produces: regression coverage proving suffixed GLM-5.2 variants stay unknown while canonical and other GLM-family models remain fail-closed.

- [ ] **Step 1: Add a failing suffixed-variant test**

Add inside `describe("resolveRuntimeModelInputCapabilities", ...)`:

```ts
it.each([
  "GLM-5.2-variant",
  "vendor/GLM-5.2-variant",
  "GLM-5.2-variant[1m]",
])("keeps unknown suffixed GLM-5.2 variant capability unknown for %s", (modelId) => {
  expect(
    resolveRuntimeModelInputCapabilities(
      { providerId: "custom-glm", modelId },
      { overrides: {} },
    ),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Add canonical normalization assertions**

Add:

```ts
it.each(["GLM-5.2", "vendor/GLM-5.2", "GLM-5.2[1m]", "GLM-5.2-[1m]"])(
  "keeps canonical GLM-5.2 image-unsupported for unknown non-official provider %s",
  (modelId) => {
    expect(
      resolveRuntimeModelInputCapabilities(
        { providerId: "custom-glm", modelId },
        { overrides: {} },
      ),
    ).toEqual({ supportsImages: false });
  },
);
```

Retain the existing `GLM-5.1` and `private-glm-next` assertions unchanged.

Also assert that `GLM-5.2-variant/other-model` remains image-unsupported, proving a matching non-final path segment cannot trigger the exception. Cover explicit `supportsImages: true` and `supportsImages: false` on the neutral suffixed variant so capability precedence is locked down.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/model-selection.test.ts
```

Expected: the three neutral suffixed-variant cases fail because the current broad GLM fallback returns `{ supportsImages: false }`; existing tests remain green.

### Task 3: Implement the public structural exception

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/model-input-capabilities.ts:1-179`
- Test: `apps/zcode-cli/packages/bootstrap/tests/model-selection.test.ts`

**Interfaces:**
- Consumes: `normalizeModelIdForProviderRequest(modelId: string): string` from `@zcode/adapters/model`.
- Produces: `isGlm52SuffixedVariant(modelId: string): boolean`, used only by the provider-aware media fallback.

- [ ] **Step 1: Import provider-request model ID normalization**

Extend the existing `@zcode/adapters/model` import with:

```ts
normalizeModelIdForProviderRequest,
```

- [ ] **Step 2: Add the public structural matcher**

Near the existing GLM provider-side media constants, add:

```ts
const GLM_5_2_SUFFIXED_VARIANT_PATTERN = /^glm-5\.2-.+$/i;
```

After `isGlmFamilyModelId`, add:

```ts
function isGlm52SuffixedVariant(modelId: string): boolean {
  const finalModelIdSegment = modelId.trim().split("/").filter(Boolean).at(-1);
  return finalModelIdSegment
    ? GLM_5_2_SUFFIXED_VARIANT_PATTERN.test(
        normalizeModelIdForProviderRequest(finalModelIdSegment),
      )
    : false;
}
```

- [ ] **Step 3: Preserve unknown capability for suffixed variants**

In `applyProviderAwareMediaFallback`, insert the exception after the existing GLM-family check and before the official-provider check:

```ts
if (isGlm52SuffixedVariant(modelRef.modelId)) return;
```

Add the required Chinese bug-cause comment immediately above it:

```ts
// 修复原因：最终模型 ID 段为 `glm-5.2-*` 时代表独立于 canonical `glm-5.2` 的真实变体；
// 仅凭共享的 GLM 家族命名，不能把未声明的图片能力判定为不支持。
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/model-selection.test.ts
```

Expected: all model-selection tests pass, including the new neutral suffixed-variant and canonical normalization cases.

- [ ] **Step 5: Run adjacent media projection tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/media-capability.test.ts
```

Expected: all tests pass; explicit false still strips, while unknown remains unchanged by capability projection before the separate media-budget projection runs.

### Task 4: Clear stale active-session media capabilities on registry refresh

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts:964-1056`
- Test: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts:3964-4141`

**Interfaces:**
- Consumes: `resolveRuntimeModelInputCapabilities(...)` and `AgentRuntime.updateConfig(...)` property-presence semantics.
- Produces: a `ProviderModelLimits` patch that explicitly carries `modelInputMediaCapabilities: undefined` when a newer registry revision removes the previous media capability facts.

- [ ] **Step 1: Write the failing active-session refresh test**

Add a parameterized protocol integration test using the neutral model ID `GLM-5.2-variant`, with independent cases for `supportsImages` and `supportsPdf`. Create the session while the capability is unknown, update a second registry revision to `{ [capabilityKey]: false }` so the fake runtime holds the same old state as production, then let a third revision omit the capability. Capture the runtime config patch and assert:

```ts
expect(runtimeModelInputMediaCapabilities).toEqual({ [capabilityKey]: false });

expect(runtimeUpdateConfig).toHaveBeenLastCalledWith({
  contextWindow: undefined,
  maxOutputTokens: undefined,
  modelInputMediaCapabilities: undefined,
});
const lastPatch = runtimeUpdateConfig.mock.lastCall?.[0];
expect(Object.hasOwn(lastPatch ?? {}, "modelInputMediaCapabilities")).toBe(true);
expect(runtimeModelInputMediaCapabilities).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts -t "clears active session"
```

Expected: both parameterized cases FAIL because the current patch omits `modelInputMediaCapabilities`, leaving each captured runtime value at `{ [capabilityKey]: false }`.

- [ ] **Step 3: Make property presence explicit in `ProviderModelLimits`**

Make `modelInputMediaCapabilities` a required property whose value may be `undefined`, then return it unconditionally:

```ts
interface ProviderModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
  modelInputMediaCapabilities: ModelInputMediaCapabilities | undefined;
}

return {
  contextWindow: positiveInteger(model.contextWindow),
  maxOutputTokens: positiveInteger(model.maxOutputTokens),
  modelInputMediaCapabilities,
};
```

Add a Chinese bug-cause comment explaining that `AgentRuntime.updateConfig(...)` relies on property presence to clear stale `false` values when capabilities become unknown.

If `resolveProviderModelLimits(...)` cannot find the model, return `{ modelInputMediaCapabilities: undefined }` so the required patch shape remains type-safe.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts -t "clears active session"
```

Expected: PASS; the patch includes the key and the captured runtime capability becomes `undefined`.

- [ ] **Step 5: Run the adjacent provider registry refresh tests**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts -t "refreshes active session context window when provider registry changes the current model|clears active session"
```

Expected: both active-session refresh tests pass, including context/max-token clearing and media-capability clearing.

### Task 5: Run repository verification without committing

**Files:**
- Verify only: all files modified by Tasks 1-4.

**Interfaces:**
- Consumes: completed documentation and code changes.
- Produces: focused, E2E-contract, type, lint, and whitespace evidence for handoff.

- [ ] **Step 1: Check the existing N08 fixture contract**

Run:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-switch-image-strip.test.ts
```

Expected: fixture check passes; the explicit text-only GLM-5.2 request contract remains complete.

- [ ] **Step 2: Run conversation E2E type checking**

Run:

```bash
pnpm --filter @zcode/desktop typecheck:e2e
```

Expected: exit code `0`.

- [ ] **Step 3: Run package and repository gates**

Run:

```bash
pnpm --filter @zcode/bootstrap typecheck
pnpm typecheck
pnpm lint
```

Expected: all commands exit `0`. If an unrelated dirty-worktree failure occurs, record the exact file and error separately without modifying unrelated work.

- [ ] **Step 4: Run final structural checks**

Run:

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
git diff --check -- apps/zcode-cli/packages/bootstrap/src/app/model-input-capabilities.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts apps/zcode-cli/packages/bootstrap/tests/model-selection.test.ts apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts docs/conversation-session-case-catalog.md docs/testing/conversation-session-e2e-coverage-matrix.md docs/superpowers/specs/2026-07-10-glm-52-suffixed-variant-media-fallback-design.md docs/superpowers/plans/2026-07-10-glm-52-suffixed-variant-media-fallback.md
```

Expected: audit and diff check exit `0`.

- [ ] **Step 5: Review the final diff and leave it uncommitted**

Confirm the final diff contains only public `GLM-5.2-*` structural semantics and no private identifier. Do not stage or commit.
