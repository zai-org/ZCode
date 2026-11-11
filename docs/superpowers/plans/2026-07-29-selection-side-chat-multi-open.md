# Auxiliary Conversation Multi-Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持同一父会话多开辅助对话，并把主时间线划词引用追加到当前激活的辅助对话；当前未激活辅助对话时新建。

**Architecture:** CLI 的 `createSelectionSideSession` 已允许创建多个 child，本次只调整 renderer。Side Pane tab 以 `childSessionId` 唯一标识实例；runtime 只管理“显式新建”的并发去重与 child blocked 状态；当前目标从 Side Pane 的 `activeTabId` 解析后透传给主 `SessionPane`。

**Tech Stack:** React 19、TypeScript、Zustand/renderer registry、Vitest、WebdriverIO Electron E2E。

## Global Constraints

- 先更新 `docs/ui/conversation-selection-side-chat.md`、case catalog 与 coverage matrix，再修改代码。
- 工作区隔离统一使用 `workspaceIdentity?.trim() || workspacePath`；文件与命令路径继续使用 `workspacePath`。
- 桌面 Electron 与桌面 Web 共享语义；手机 `/remote` 不新增入口，不改变 replayable 恢复链路。
- UI 文案国际化；多 tab 标题使用既有“辅助对话”文案加稳定序号。
- 关闭单个/其他/全部 tab 时，只关闭对应 child runtime。
- 完成前执行 focused tests、coverage audit、`pnpm typecheck` 与 `pnpm lint`。

---

### Task 1: Freeze product semantics in specs

**Files:**

- Modify: `docs/ui/conversation-selection-side-chat.md`
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**

- Produces: SSC25（多开）、SSC26（当前激活路由）、SSC27（无激活目标时新建）验收定义。

- [ ] **Step 1:** 把单一 parent→child 绑定改为 parent→children tab registry。
- [ ] **Step 2:** 记录固定入口每次新建、划词优先当前激活辅助 tab、无激活时新建。
- [ ] **Step 3:** 更新 E2E 剪枝和覆盖状态。

### Task 2: Add failing registry and tab tests

**Files:**

- Modify: `packages/ui/test/selectionSideChatRuntime.test.ts`
- Modify: `packages/ui/test/workspaceSidePane.test.ts`

**Interfaces:**

- Consumes: `buildSelectionSideChatKey(workspaceKey, parentSessionId)` 作为 opener scope。
- Produces: `createSelectionSideChatInstance()` 的并发创建合同、child 唯一 tab id、序号标题、active tab resolver 合同。

- [ ] **Step 1:** 新增同父两次显式创建产生两个 child 的失败测试。
- [ ] **Step 2:** 新增同一创建手势的并发调用只创建一次的失败测试。
- [ ] **Step 3:** 新增两个 child 生成两个 tab、标题为 `辅助对话 1/2` 的失败测试。
- [ ] **Step 4:** 新增 active tab 为辅助对话时返回目标，否则返回 null 的失败测试。
- [ ] **Step 5:** 运行 focused Vitest，确认新断言在旧实现上失败。

### Task 3: Implement multi-instance renderer state

**Files:**

- Modify: `packages/ui/src/lib/selectionSideChatRuntime.ts`
- Modify: `packages/ui/src/lib/workspaceSidePane.ts`
- Modify: `packages/ui/src/app-shell/SidePaneTabTrigger.tsx`
- Modify: `packages/ui/src/app-shell/sidePaneTabPresentation.ts`

**Interfaces:**

- Produces: child-scoped blocked lookup；tab `title`；`getActiveSelectionSideChatTab(state, workspaceKey, parentSessionId)`。
- Produces: selection tab id `selection-side-chat:<workspace>:<parent>:<child>`。

- [ ] **Step 1:** 将 pending creation 与 child blocked 状态分离，显式 launcher 每个完成手势可创建新 child。
- [ ] **Step 2:** tab id 纳入 `childSessionId`，不再覆盖同父已有 tab。
- [ ] **Step 3:** 依据同父现存 tab 的已用序号分配最小可用标题序号。
- [ ] **Step 4:** tab 展示与搜索使用实例标题。
- [ ] **Step 5:** 跑 focused tests 直到通过。

### Task 4: Route selection to the active auxiliary tab

**Files:**

- Modify: `packages/ui/src/v4/SessionPane.tsx`
- Modify: `packages/ui/src/v4/V4WorkspaceChatArea.tsx`
- Modify: `packages/ui/src/v4/WorkbenchPane.tsx`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Modify: `packages/ui/src/hooks/useAppPanels.ts`
- Modify: `packages/ui/src/app-shell/SelectionSideChatPane.tsx`

**Interfaces:**

- Consumes: active selection tab's `childSessionId`.
- Produces: `activeSelectionSideChatSessionId?: string | null` down to the focused main `SessionPane`。
- Produces: opener request mode `"new"` for fixed launcher and `"selection"` for selection tooltip。

- [ ] **Step 1:** 从 `sidePaneState.activeTabId` 解析当前父会话的 active selection tab。
- [ ] **Step 2:** 沿 shell props 将 child id 下发到主 `SessionPane`，不写入全局业务状态。
- [ ] **Step 3:** 划词动作校验 active child 存在后追加引用并激活；不存在或 sessionNotFound 时创建新 child。
- [ ] **Step 4:** 固定 launcher 始终触发新建，pending 期间忽略重复手势。
- [ ] **Step 5:** 关闭时按 `childSessionId` 清理 blocked/reference/runtime，不影响兄弟 tab。

### Task 5: Expand E2E coverage

**Files:**

- Modify: `packages/desktop/test/e2e/conversation-session/branching/conversation-session-selection-side-chat.test.ts`

**Interfaces:**

- Produces: SSC25/26/27 desktop-continuous manual-review evidence。

- [ ] **Step 1:** 通过固定入口连续创建两个辅助 tab，并断言 childSessionId 不同。
- [ ] **Step 2:** 激活第一个 tab 后主时间线划词，断言引用只进入第一个 composer。
- [ ] **Step 3:** 激活非辅助 tab 后划词，断言创建第三个辅助 child。
- [ ] **Step 4:** 关闭其中一个 tab，断言其余 child 草稿和引用保持。

### Task 6: Verify all boundaries

**Files:**

- Verify only.

- [ ] **Step 1:** 运行 selection runtime/workspace side pane focused Vitest。
- [ ] **Step 2:** 运行 conversation selection 与相关组件 tests。
- [ ] **Step 3:** 运行 `pnpm audit:conversation-session-coverage`。
- [ ] **Step 4:** 运行 `pnpm typecheck`。
- [ ] **Step 5:** 运行 `pnpm lint`。
- [ ] **Step 6:** 在桌面开发环境执行 SSC25/26/27 交互检查；若当前 Node/Electron 环境阻塞，明确记录未验证项。
