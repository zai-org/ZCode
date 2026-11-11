# Chat Find Re-focus Implementation Plan

> **状态：已由 V4 find 链路实现，本文保留为历史实施计划。** 当前行为见
> [Task Find Dialog](../../ui/task-find-dialog.md)，当前代码入口是
> `packages/ui/src/v4/useConversationTimelineFind.ts` 与 `packages/ui/src/quickpick/TaskFindDialog.tsx`；
> 下文 `ChatView` / `useConversationFindHighlights` 路径已删除。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow repeated previous/next/Enter/Shift+Enter navigation to re-center a single search match in both conversation content and file-change diffs.

**Architecture:** Keep query and active index as selection state, and add independent monotonically increasing navigation request ids for conversation and file-change scopes. Explicit navigation events increment the appropriate id; `useConversationFindHighlights` includes the id in its effect and scroll dedupe key, while GitPane also re-runs virtual-row positioning for a repeated file-change request.

**Tech Stack:** React 19, TypeScript, Vitest, Electron/WebdriverIO E2E.

## Global Constraints

- Update the existing chat-find spec and conversation catalog/matrix before code.
- Preserve desktop `desktop-continuous` and mobile `web-remote-replayable` boundaries; navigation ids remain renderer-local.
- Support conversation and file-change scopes independently.
- Support previous, next, Enter, and Shift+Enter with identical repeated-navigation semantics.
- Preserve existing DOM-mutation scroll deduplication.
- Use absolute `@/` imports and Chinese bug-cause comments.
- Run `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, and `pnpm lint` before completion.

---

### Task 1: Focused navigation and highlight regression tests

**Files:**
- Test: `packages/ui/test/conversationFindSearch.test.ts`

**Interfaces:**
- Consumes: navigation direction/request helpers and highlight scroll-key helper.
- Produces: failing proof that repeated navigation must create a distinct scroll request even when the index stays `0`.

- [x] **Step 1: Write the failing navigation test**

Assert previous, next, Enter, and Shift+Enter resolve to the shared directions, and that a single match wraps to index `0` for both directions while still producing a navigation request.

- [x] **Step 2: Write the failing highlight dedupe test**

Assert the highlight scroll key changes when only `navigationRequestId` changes. The repository Vitest environment does not include jsdom, so this pure test keeps the RED focused on the missing behavior instead of failing on an unavailable test environment.

- [x] **Step 3: Run tests to verify RED**

Run:

```bash
pnpm exec vitest run packages/ui/test/conversationFindSearch.test.ts
```

Expected: FAIL because `TaskFindDialog` has no explicit navigation callbacks and the highlight hook has no navigation request id.

### Task 2: Renderer-local navigation request state

**Files:**
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/quickpick/TaskFindDialog.tsx`
- Modify: `packages/ui/src/ChatView/useConversationFindHighlights.ts`
- Modify: `packages/ui/src/ChatView/ChatViewConversation.tsx`
- Modify: `packages/ui/src/ChatView.tsx`
- Modify: `packages/ui/src/ChatView/types.ts`
- Modify: `packages/ui/src/GitPane.tsx`
- Modify: `packages/ui/src/app-shell/types.ts`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Modify: `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`

**Interfaces:**
- Produces: `conversationFindNavigationRequestId: number`, `fileChangeFindNavigationRequestId: number`.
- Produces: `onConversationFindNavigate(query: string, activeIndex: number)` and `onFileChangeFindNavigate(query: string, activeIndex: number)`.
- Consumes: `navigationRequestId?: number` in `useConversationFindHighlights`.

- [x] **Step 1: Add explicit dialog navigation callbacks**

Keep `on*FindChange` for query/scope synchronization. Route only `moveSelection()` through the new `on*FindNavigate` callbacks so buttons and keyboard share one event path.

- [x] **Step 2: Add independent request ids in App**

Use functional updates:

```ts
setConversationFindNavigationRequestId((requestId) => requestId + 1);
setFileChangeFindNavigationRequestId((requestId) => requestId + 1);
```

Each navigation handler also updates query/index. Reset ids is unnecessary because they are transient monotonic counters scoped to the mounted App.

- [x] **Step 3: Thread request ids through chat and Git surfaces**

Pass the conversation id through `WorkspaceShellLayout -> ChatView -> ChatViewConversation -> useConversationFindHighlights`. Pass the file id through `WorkspaceShellLayout -> AnimatedSidePanePanel -> GitPane -> useConversationFindHighlights` and include it in the Git virtual-row positioning effect dependencies.

- [x] **Step 4: Include request id in highlight dedupe**

Use:

```ts
const scrollKey = `${normalizedQuery}:${resolvedActiveIndex}:${ranges.length}:${navigationRequestId}`;
```

and add `navigationRequestId` to the effect dependency list. Keep mutation-driven calls deduped within one request id.

- [x] **Step 5: Run focused tests to verify GREEN**

Run the Task 1 Vitest command. Expected: all tests pass.

### Task 3: Pending Electron regression case

**Files:**
- Create: `packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts`

**Interfaces:**
- Consumes: WDIO-only `window.__zcodeSessionStoreE2E` bridge.
- Produces: `CFR` pending manual-review evidence for catalog `CF01`; no provider requests.

- [x] **Step 1: Write the E2E reproduction**

Use the WDIO-only Zustand store bridge to create a completed task with one long assistant message containing `E2E_CHAT_FIND_REFOCUS_NEEDLE`. Open Cmd/Ctrl+F, search the marker, scroll away, then verify next, previous, Enter, and Shift+Enter each return the same marker to the viewport center while the counter remains `1/1`.

- [x] **Step 2: Run the case**

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts'
```

Expected: PASS after Task 2. The spec stays pending until human review; do not promote it automatically.

### Task 4: Full verification and implementation commit

**Files:**
- Review all modified files above.

- [x] **Step 1: Run focused and required verification**

```bash
pnpm exec vitest run packages/ui/test/conversationFindSearch.test.ts
pnpm --filter @zcode/desktop typecheck:e2e
pnpm typecheck
pnpm lint
git diff --check
```

- [x] **Step 2: Review diff and repository state**

Confirm no unrelated tracked files or the pre-existing untracked `.agents/skills/zcode-rum-crash-triage/` are staged.

- [x] **Step 3: Commit implementation**

```bash
git add packages/ui/src packages/ui/test/conversationFindSearch.test.ts packages/ui/test/chatViewConversation.test.ts packages/ui/test/gitPaneVirtualList.test.ts packages/ui/test/linuxDesktopTitlebarOverlay.test.ts packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts docs/superpowers/plans/2026-07-10-chat-find-refocus.md
git commit -m "fix(ui): refocus repeated chat find navigation"
```

### Task 5: Review follow-up navigation state and keyboard guards

**Files:**
- Create: `packages/ui/src/quickpick/taskFindNavigationState.ts`
- Create: `packages/ui/test/taskFindNavigationState.test.ts`
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/quickpick/conversationFindSearch.ts`
- Modify: `packages/ui/src/quickpick/TaskFindDialog.tsx`
- Modify: `packages/ui/test/conversationFindSearch.test.ts`
- Modify: `packages/ui/test/taskFindDialogNavigation.test.ts`

**Interfaces:**
- Produces: `TaskFindNavigationState` with `query`, `activeIndex`, and `navigationRequestId`.
- Produces: `changeTaskFindSelection(state, query, activeIndex)` that preserves the request id.
- Produces: `navigateTaskFindSelection(state, query, activeIndex)` that increments the request id even when the index is unchanged.
- Renames: `createConversationFindNavigationRequest` to `resolveConversationFindNavigationSelection`, because the dialog helper does not create the complete request identity.

- [x] **Step 1: Write failing state-transition and dialog tests**

Assert that two consecutive same-index navigations produce request ids `1` and `2`, ordinary query/index changes preserve the current id, ArrowUp/ArrowDown enter the real dialog navigate callback, and every keyboard navigation entry is ignored when `total === 0`.

- [x] **Step 2: Run tests to verify RED**

```bash
pnpm exec vitest run packages/ui/test/taskFindNavigationState.test.ts packages/ui/test/taskFindDialogNavigation.test.ts
```

Expected: FAIL because the App-owned transition helper does not exist, Arrow keys are not covered by the component helper, and zero-match keyboard navigation still invokes `on*FindNavigate`.

- [x] **Step 3: Implement the minimal state transition and zero-match guard**

Use two independent `TaskFindNavigationState` objects in `App`. Keep match counts separate. Route ordinary change through `changeTaskFindSelection`, route explicit navigation through `navigateTaskFindSelection`, and make `TaskFindDialog.moveSelection` return before creating a request when `activeFindState.total === 0`.

- [x] **Step 4: Run tests to verify GREEN**

Run the Task 5 Vitest command. Expected: all tests pass.

### Task 6: CF01 confirmation and CF02 pending manual-review evidence

**Files:**
- Modify: `packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**
- Keeps: the existing provider-free `CFR` pending case and `window.__zcodeSessionStoreE2E` conversation injection.
- Adds: a case-local Git workspace file with one file-change marker and enough lines to prove scroll-away/re-center behavior.
- Produces: manual-review evidence for both accepted catalog cases CF01 and CF02 without promotion or replay fixture admission.

- [x] **Step 1: Extend the pending E2E with CF02**

Initialize Git in `DEFAULT_WORKSPACE`, commit an empty baseline plain-text file, then add 1,300 lines with one `E2E_FILE_CHANGE_FIND_REFOCUS_NEEDLE` near the start so GitPane uses its light-DOM plain-text fallback while retaining a long scroll region. Switch the open find dialog to file-change scope, wait for `1/1`, scroll the expanded diff away, and verify previous/next/Enter/Shift+Enter each re-center the same marker.

- [x] **Step 2: Update the coverage matrix honestly**

Keep CF01/CF02 status `planned`, record that CFR now provides pending manual-review evidence for both scopes, and continue to state that no formal replay fixture, Docker admission, or CI promotion exists.

- [x] **Step 3: Run the pending case**

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts'
```

Expected: both conversation and file-change scenarios pass. Keep the spec under `manual-review/pending/` until a human explicitly approves promotion.

- [x] **Step 4: Run final gates and commit**

```bash
pnpm exec vitest run packages/ui/test/conversationFindSearch.test.ts packages/ui/test/taskFindNavigationState.test.ts packages/ui/test/taskFindDialogNavigation.test.ts packages/ui/test/chatViewConversation.test.ts packages/ui/test/gitPaneVirtualList.test.ts packages/ui/test/linuxDesktopTitlebarOverlay.test.ts
pnpm --filter @zcode/desktop typecheck:e2e
pnpm typecheck
pnpm lint
git diff --check
git add docs/superpowers/plans/2026-07-10-chat-find-refocus.md docs/testing/conversation-session-e2e-coverage-matrix.md packages/ui/src/App.tsx packages/ui/src/quickpick/conversationFindSearch.ts packages/ui/src/quickpick/taskFindNavigationState.ts packages/ui/src/quickpick/TaskFindDialog.tsx packages/ui/test/conversationFindSearch.test.ts packages/ui/test/taskFindNavigationState.test.ts packages/ui/test/taskFindDialogNavigation.test.ts packages/desktop/test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts
git commit -m "fix(ui): align chat find navigation edge cases"
```

### Task 7: Keep mobile chat find outside the inert surface

**Files:**
- Modify: `packages/ui/test/webRemoteControlMobileShell.test.ts`
- Modify: `packages/ui/test/workspaceShellRemoteMobileLayout.test.ts`
- Modify: `packages/ui/src/WebRemoteControlMobileShell.tsx`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`

**Interfaces:**
- Adds: `chatOverlay?: ReactNode` to `WebRemoteControlMobileShell`.
- Keeps: `chatContent` inside the existing `inert` / `aria-hidden` mobile chat surface.
- Renders: `chatOverlay` as a sibling layer with `data-mobile-chat-overlay="true"`, `z-40`, and pointer events restored for its child content.

- [x] **Step 1: Write failing mobile DOM and WorkspaceShell integration tests**

In `webRemoteControlMobileShell.test.ts`, pass a real input/button subtree as `chatOverlay` while `isSidePaneOpen=true`. Assert the marker is present inside `data-mobile-chat-overlay`, absent from the serialized `<main inert>` content, and rendered after the inert main. In `workspaceShellRemoteMobileLayout.test.ts`, teach only the test double to render a `chatOverlay` prop, open `taskFindDialogProps`, and assert the find placeholder is supplied through that prop rather than `chatContent`.

- [x] **Step 2: Run the two tests to verify RED**

```bash
pnpm exec vitest run packages/ui/test/webRemoteControlMobileShell.test.ts packages/ui/test/workspaceShellRemoteMobileLayout.test.ts
```

Expected: FAIL because `WebRemoteControlMobileShell` has no `chatOverlay` slot and `WorkspaceShellLayout` still places `renderChatFindDialog()` inside mobile `chatContent`.

- [x] **Step 3: Implement the mobile overlay boundary**

Add the optional prop and render it inside the mobile content wrapper, after the side-pane overlay:

```tsx
{chatOverlay ? (
  <div
    className="pointer-events-none absolute inset-0 z-40"
    data-mobile-chat-overlay="true"
  >
    <div className="pointer-events-auto">{chatOverlay}</div>
  </div>
) : null}
```

For the dedicated mobile branch in `WorkspaceShellLayout`, remove `renderChatFindDialog()` from `chatContent` and pass `chatOverlay={renderChatFindDialog()}` to `WebRemoteControlMobileShell`. Do not change the desktop conversation-panel render site or weaken mobile `inert`.

- [x] **Step 4: Run the two tests to verify GREEN**

Run the Task 7 Vitest command. Expected: both files pass.

### Task 8: Respect handled Escape events

**Files:**
- Modify: `packages/ui/test/taskFindDialogNavigation.test.ts`
- Modify: `packages/ui/src/quickpick/TaskFindDialog.tsx`

**Interfaces:**
- Keeps: unhandled Escape closes chat-placement find.
- Adds: `event.defaultPrevented === true` prevents the window listener from closing find.

- [x] **Step 1: Write failing Escape priority tests**

Extend the minimal window event target in `taskFindDialogNavigation.test.ts` so tests dispatch the real effect-installed `keydown` handler. Assert a pre-cancelled Escape leaves `onOpenChange` untouched, while an unhandled Escape calls `onOpenChange(false)` and becomes default-prevented.

- [x] **Step 2: Run the dialog test to verify RED**

```bash
pnpm exec vitest run packages/ui/test/taskFindDialogNavigation.test.ts
```

Expected: the pre-cancelled Escape test fails because the current window listener closes find without checking `defaultPrevented`.

- [x] **Step 3: Add the minimal Escape guard**

```ts
if (event.defaultPrevented || event.key !== "Escape") {
  return;
}
```

Keep the existing `preventDefault()` and `onOpenChange(false)` calls for an unhandled Escape.

- [x] **Step 4: Run the dialog test to verify GREEN**

Run the Task 8 Vitest command. Expected: all dialog navigation and Escape cases pass.

### Task 9: Coverage notes, regression gates, and delivery

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Review: all Task 7-8 files.

**Interfaces:**
- Records: mobile DOM coverage proves the overlay is outside the inert surface.
- Preserves: `CFR` under `manual-review/pending`; no promotion, replay fixture, Docker admission, or CI claim.

- [x] **Step 1: Update catalog and matrix scope**

State that mobile Web reuses the same navigation behavior but needs a distinct DOM composition assertion because its side pane is an overlay with an inert chat surface. Record component/integration coverage honestly and keep CF01/CF02 `planned`.

- [x] **Step 2: Run focused and required verification**

```bash
pnpm exec vitest run packages/ui/test/webRemoteControlMobileShell.test.ts packages/ui/test/workspaceShellRemoteMobileLayout.test.ts packages/ui/test/taskFindDialogNavigation.test.ts packages/ui/test/taskFindNavigationState.test.ts packages/ui/test/conversationFindSearch.test.ts packages/ui/test/chatViewConversation.test.ts packages/ui/test/gitPaneVirtualList.test.ts
ZCODE_GIT_BINARY=/usr/bin/git ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/presentation/manual-review/pending/conversation-session-chat-find-refocus.test.ts'
pnpm --filter @zcode/desktop typecheck:e2e
pnpm typecheck
pnpm lint
git diff --check
```

Expected: all focused tests and the pending desktop case pass; lint reports zero errors. The desktop pending case remains evidence for desktop scrolling, not a mobile replayable E2E claim.

- [x] **Step 3: Commit and push the review follow-up**

```bash
git add packages/ui/src/WebRemoteControlMobileShell.tsx packages/ui/src/app-shell/WorkspaceShellLayout.tsx packages/ui/src/quickpick/TaskFindDialog.tsx packages/ui/test/webRemoteControlMobileShell.test.ts packages/ui/test/workspaceShellRemoteMobileLayout.test.ts packages/ui/test/taskFindDialogNavigation.test.ts docs/conversation-session-case-catalog.md docs/testing/conversation-session-e2e-coverage-matrix.md docs/superpowers/plans/2026-07-10-chat-find-refocus.md
git commit -m "fix(ui): keep mobile task find interactive"
git push
```
