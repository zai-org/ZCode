# UI Render Stability Optimization

## Background

The 2026-06-27 DevTools trace for the big session branch shows that most of the selected main-thread time is DevTools/Inspector overhead (`CpuProfiler::StartProfiling`, `V8Console::runTask`, `v8::Debugger::*`). Project-attributed self time is much smaller, but the React Components track still shows repeated workspace-level render bursts.

Observed project-side symptoms:

- `DesktopWindowFrame` re-renders large parts of the workspace shell in repeated bursts.
- Workspace task rows re-render even when the task data is semantically unchanged.
- Each task row carries menu/tooltip structures, so row re-renders multiply Radix `ContextMenu` / `Popper` / `Tooltip` work.
- Chat composer and toolbar props recreate equivalent objects and callbacks during stream updates.

## Goals

- Keep desktop continuous and web remote replayable behavior unchanged.
- Reduce render propagation by stabilizing props at the TaskList, shell, and composer boundaries.
- Avoid mounting heavy per-row menu content until the user opens a row context menu.
- Preserve current visual design, theme behavior, i18n strings, and keyboard/pointer interactions.

## Plan

1. **Task row actions**
   - Keep `TaskList` callbacks stable across list-local state changes by reading mutable values through refs where the action only needs the latest value at invocation time.
   - Keep task row props stable when task identity, active state, pinned state, mobile active state, and visible metadata are unchanged.

2. **Task row menu cost**
   - Keep the row itself mounted as the context-menu trigger.
   - Keep `TaskListItemContextMenu` and its file/provider-path loading limited to the opened context menu.
   - Defer hover-only archive tooltip/action controls until the row is hovered or already in archive-confirming state.
   - Avoid rendering menu and hover action content for every idle task row.

3. **Workspace shell props**
   - Memoize shell `resetKeys`, render callbacks, and small object props that are passed into memoized/error-boundary children.
   - Do not change the boundary scopes or reset semantics.

4. **Composer and toolbar props**
   - Memoize equivalent action objects, submit controls, and toolbar callbacks that React DevTools reported as referentially unstable.
   - Keep all command behavior and remote/mobile behavior unchanged.

5. **Follow-up trace findings**
   - The uploaded `p6` trace still shows repeated React scheduler long tasks after excluding DevTools profiler startup and inspector overhead.
   - Layout and paint are not the dominant cost; the remaining project-side cost is React render/commit work.
   - `TaskListItem`, `ContextMenu`, `ContextMenuTrigger`, `MenuProvider`, `Popper`, `ControlHintTooltip`, `TaskRenameDialog`, and `ModelConfigSelect` remain visible in repeated component render bursts.
   - Move task row context menu content and Radix context-menu ownership to list-level singletons so idle rows no longer each carry a menu root/trigger/content tree.
   - Mount task rename dialogs only while a rename is active.
   - Compare task row display fields semantically so equivalent task meta object replacement does not re-render unchanged rows.
   - Render model selector menu content only while the dropdown is open.

## Verification

- Add targeted render-stability tests for TaskList row props and TaskListItem context-menu content mounting.
- Add follow-up tests proving list rows do not mount per-row context menus, rename dialogs are closed-state unmounted, equivalent task meta references do not re-render a row, and model menu content is not built while closed.
- Run the affected tests first to confirm they fail before implementation.
- Run targeted UI tests after implementation.
- Run `pnpm typecheck` and `pnpm lint` before committing.

## 2026-06-28 p9 Trace Follow-up

The uploaded `p9` DevTools trace shows the previous task-list/sidebar work is effective for the recorded scenario: task row and workspace task-section components are no longer the dominant React component costs. After discounting DevTools profiler startup and React DevTools timing overhead, the remaining user-visible delay is still main-thread React work during streaming.

Observed project-side hotspots:

- `FunctionCall` time is dominated by `react-dom_client.js` scheduled work; layout and paint are not the bottleneck.
- Interaction handlers are short, but pointer/scroll events land between repeated 60-128 ms React `RunTask` blocks, so INP is delayed by streaming render pressure.
- `ChatBottomDock` still receives freshly-created prop objects and JSX children from `ChatView` on each render.
- `ToolbarControls` still receives an inline `codingPlanUsageRemaining` object and inline provider/usage callbacks; it also recreates portal children and thought-level callbacks during parent renders.
- `ChatViewConversation` recreates `renderHistoryLoader` and `renderTurnGroup` callbacks, which prevents `ChatConversationContent` from becoming a stable boundary when streaming updates are unrelated to old turn groups.

Follow-up repair plan:

- Memoize `ChatBottomDock` prop objects and JSX controls in `ChatView`, then make `ChatBottomDock` itself a memo boundary.
- Memoize toolbar usage callbacks and `codingPlanUsageRemaining` in `ChatInputToolbar`.
- Memoize portal/control subtrees inside `ToolbarControls` and wrap the component with `memo`; keep the model menu deferred until open.
- Memoize `ModelConfigSelect` so unchanged model picker props do not rerender when context usage changes.
- Memoize conversation render callbacks and wrap `ChatConversationContent` with `memo`, preserving existing streaming, history loading, search, and remote-control behavior.

## 2026-06-28 p10 Trace Follow-up

The uploaded `p10` trace was recorded on top of `834994d60`. The previous changes are partially effective: `ChatBottomDock` no longer appears in the React Components track, and first-party `localhost` main-thread time is lower than `p9`. The remaining delay is still JavaScript/React work rather than browser layout or paint.

Observed remaining hotspots:

- `ToolbarControlsComponent` still rerenders during streaming because model/config change callbacks are referentially unstable, and `codingPlanUsageRemaining.entitlements` is deeply equal but recreated.
- `ModelConfigSelectComponent` still rerenders because its `onValueChange` prop changes with the toolbar callback.
- The old message-level rewind callback was one source of streaming prop churn; that UI entry has since been removed, so current conversation render work should be checked against the remaining toolbar, summary, and visible active-turn paths.
- CPU sampling also shows workspace chrome and hidden overlay/dialog trees (`WorkspaceSidebarFooter`, `WorkspaceSidebar`, `CommandCenterDialog`, `WebRemoteControlDialog`, feedback dialogs, Radix dialog/tooltip/menu primitives) being re-executed during chat streaming. These are parent-render fanout costs, not layout/paint costs.

Follow-up repair plan:

- Add a tiny stable event callback hook for UI callbacks that only need latest values when invoked.
- Use the stable event hook for toolbar model/config callbacks and conversation rewind callbacks.
- Stabilize filtered Coding Plan usage entitlement arrays by semantic keys before crossing the toolbar memo boundary.
- Add memo boundaries to workspace shell chrome and shared overlay/dialog components that do not need to rerender for every chat token batch.

## 2026-06-28 p12 Trace Follow-up

The uploaded `p12` trace shows the p10 follow-up changes are effective for the old hotspots: `TaskList*`, `WorkspaceSidebar*`, `ModelConfigSelectComponent`, and `ToolbarControlsComponent` no longer dominate the React Components track. `ChatBottomDockComponent` is reduced to the expected inline-layout transitions. After discounting DevTools profiler startup, inspector events, and unattributed profiling-like long tasks, the remaining project-side delay is concentrated in chat content rendering and forced style/layout work.

Observed remaining hotspots:

- `MarkdownTable` recreates scroll/resize observers whenever streaming markdown replaces `children`, then immediately reads `scrollWidth` / `clientWidth`. This shows up as repeated `markdown-table.tsx` callback time and contributes to `UpdateLayoutTree` / `Layout`.
- `ChatViewSummaryPanel` remains a hot component because summary arrays and variant callbacks cross the panel boundary with new references even when their visible content is unchanged.
- The active streaming turn still rerenders chat message/tool-call components as real `parts` / `toolCalls` change. This is expected, but old turns and summary chrome should not be pulled into the same render burst.

Follow-up repair plan:

- Keep `MarkdownTable` observers mounted for the table lifetime instead of keying the observer effect to `children`; store the latest measurement callback in refs and skip `setMaskState` when the resolved mask state is unchanged.
- Reuse goal verification summary arrays when their semantic signatures are unchanged, so streaming body changes do not cause deeply equal summary props to cross memo boundaries.
- Stabilize the summary panel variant callback in `ChatView`, wrap `ChatViewSummaryPanel` with `memo`, and memoize small object/function props inside the panel that React DevTools reported as referentially unstable.

## 2026-06-28 p13 Trace Follow-up

The uploaded `p13` trace was recorded on top of `8f858f9fb`. The previous React render-stability fixes are effective: `ChatViewSummaryPanel` dropped from repeated render bursts to the expected two variant/layout renders, and the old `ChatViewConversation` / `Collapsible` / `Tooltip` fanout is no longer dominant. The remaining user-visible delay has moved from React component execution to browser style/layout work over a large DOM.

Observed remaining hotspots:

- Three long project-side layout tasks spend roughly 90 ms each in `UpdateLayoutTree` plus `Layout`, with about 13k elements recalculated and about 22k layout objects dirty.
- `DOMStats` reports about 13.8k elements, a single `DIV` with 1634 children, and a deep image path from file icons. This points to large visible chat/tool content still participating in layout.
- The trace contains non-composited animations from `transition-all` on the Git status action row. Chrome reports `scrollbar-color` as an unsupported animated property, which forces style/layout work.
- The summary panel expand/collapse transition animates `max-height`; Chrome reports `max-height` as unsupported for compositor animation, so opening or resizing the panel can relayout the whole document.
- Chat turn shells need explicit containment at the chat content / turn boundary, while avoiding full virtualization because native find, scroll restoration, fork/rewind anchors, and web remote replayable snapshots depend on the existing DOM semantics. Do not use paint containment on the turn shell: wide markdown tables are allowed to overflow the normal message text width and must remain visible.

Follow-up repair plan:

- Replace `transition-all` on the Git action row with color-only transitions so hover/state changes do not animate scrollbar/layout-related properties.
- Remove `max-height` from summary panel shell transitions. The panel may still snap between compact and expanded heights, but border/background/shadow transitions remain.
- Add explicit `contain: layout style` boundaries around chat content and turn content. Avoid `content-visibility:auto`, `contain:paint`, and `contain:size` on turn shells so scroll height, message sizing, and visible table overflow semantics are unchanged.

## 2026-06-28 Runtime CDP Follow-up

The live app was inspected through Electron CDP after reproducing the resize gesture: double-clicking the application edge blank area to shrink and grow the window. Deep DOM traversal, including open shadow roots, matched the trace-scale DOM count and found the current large container:

- `document > shadow(diffs-container) > DIV[data-gutter]` has 1634 direct children.
- `document > shadow(diffs-container) > DIV[data-content]` has 1634 direct children and about 8.3k descendants.
- The host is the code-viewer tab inside the right side pane. Its rect was roughly `x=1737, width=486` while the viewport was `1745px` wide, so only a narrow sliver was visible but the full `@pierre/diffs` DOM still participated in style/layout.
- The 1634 rows came from the `FILE_VIEWER_CHUNK_BYTES = 128 * 1024` file preview chunk used when this trace was captured; changing chunk size or virtualizing `@pierre/diffs` would affect visible code navigation, comments, search, and scroll anchoring, so that was not the first repair.

As of 2026-07-28, ordinary text preview no longer renders transport chunks as separate documents: files up to `256KB` render once as a complete document, while larger files show a bounded-preview message. The heavy-content visibility gate remains necessary because an allowed complete document can still contain many rows.

Follow-up repair plan:

- Keep the side-pane shell, tabs, source state, and file read state mounted so existing animations and tab memory remain stable.
- Gate only the heavy PreviewPane body. A code-viewer tab may render `PreviewPaneContent` only when its tab is active, the side pane is logically visible, and the side pane has enough viewport-intersecting inline width.
- Preserve scroll metrics with a lightweight spacer while the heavy body is deferred, then restore `scrollTop` when the pane becomes visible again.
- Skip auto-loading adjacent file chunks while the heavy body is deferred; otherwise an empty body can look like an under-filled viewport and trigger unnecessary hidden reads.

## 2026-11-03 项目展开渲染隔离（SPT07）

开发窗口运行时确认：展开回调随 `preferences` 重建，使一个项目的折叠更新传播到所有项目。
300ms 高度/透明度动画仍在，但同步渲染占用了大部分动画时间，表现为突然展开。

- `useProjectSidebarPreferences` 继续作为视图、顺序和展开偏好的唯一 owner；单项目命令保持稳定引用，以函数式更新读取最新偏好。
- 单项目切换只更新目标项目的内容；保持完整 props 比较，真实目录、任务和回调变化仍传播。
- 沿用共享 Collapsible 的 300ms 双向动画，不修改动画时长、不延时提交展开状态。
- 连续切换不同项目、全部展开/收起及 storage 事件后的单项操作保留其它项目、视图和顺序；刷新恢复持久化偏好。项目展开不选择任务或新建草稿。

```text
点击项目 → 稳定 setExpanded → 唯一偏好 owner 的函数式更新
                              ├─ 保存完整偏好
                              └─ 目标行 expanded 变化 → 原有高度/透明度动画
                                 其它行参数不变 → 跳过内容渲染
```

SPT07 复用 `new-task-rendering` 的实际目录 Provider、偏好 hook 和项目组件，覆盖 44 项目、桌面/手机布局、Zai Light/Zai Dark。记录 React 提交、动画事件和逐帧高度/透明度；渲染范围与动画行为作为断言，耗时只留作证据。浏览器和 macOS Electron 独立 renderer 不代表完整 App、真实手机传输或 Windows/Linux 整机。

前次验证（2026-11-03）：同一 44 项目夹具修复前四组均记录全量 44 行更新；修复后 Chromium 与 macOS Electron 的四组均仅目标 1 行更新，双向 300ms 动画仍有中间高度/透明度帧，连续反向操作及 storage 更新后的持久化正常。浏览器整文件 16/16、Electron 独立 renderer 4/4、完整 macOS App 项目交互 E2E 14/14 通过；后者覆盖批量展开/收起、刷新恢复、快速反向切换及相邻项目操作。证据见覆盖矩阵 SPT07。原有 SPT06 的“双旋转图标”断言已与当前侧栏旋转、消息区像素动画对齐；该过期断言在未改的基线上也失败。Windows/Linux 原生端及手机实机未验证。

额外的全局 conversation 覆盖审计未通过；未改的 staging 基线 `681c5f2d5b` 也报相同四项：background 与 dynamic-workflow 两份正式用例清单缺少 request ledger ID，以及覆盖表两处总数为 121、实际为 120。本次 pending 回归不修改这些正式用例及全局统计。

### 2026-11-04 补充：顶部区域与 session 标题

运行时确认：单项目展开只改变目录 Context 的 `preferences`，但顶部导航、列表标题和
`WorkspaceHeaderTitleSection` 都随之更新；session 标题的 props 并未变化。

- 目录和偏好仍由现有 `DirectoryOwner` 持有。session 标题复用不含展开偏好的项目选择投影，
  只缩小订阅，不另建目录缓存；无 Provider 的嵌入场景仍返回空值。
- 顶部导航和列表标题按实际输入隔离父更新。导航接收稳定的新建命令，继续省略项目参数，
  保持原来的当前项目继承行为。视图、导航选中态、语言和真实回调变化必须正常更新。
- 展开/收起一个项目时，顶部导航、列表标题和 session 标题新增 render 均为零。
  当前项目任务的卸载/重挂载、标题宽度测量及 300ms 动画保持既有生命周期。
- SPT07 增补上述零更新断言，并验证 session 标题改名、远端设备目录变化及导航操作仍生效。
  覆盖桌面/手机布局、深浅主题；另在完整 Dev App 重放实际项目展开，区分夹具与真实链路证据。

```text
展开命令 → DirectoryOwner.preferences → 项目列表与目标行
项目/设备变化 → 同一 owner 的项目选择投影 → session 标题
导航输入变化 → 顶部导航；视图变化 → 列表标题
```

本次回归：浏览器 SPT03/SPT07/RRI06 12/12、macOS Electron 独立 renderer 的 SPT07 4/4；
完整 Dev App 深浅主题共 8 次切换，三处额外 render 均为零。保留标题改名、设备目录变化与导航选中态正例。
整文件中的 SPT06 旧加载像素断言在原始 HEAD 对照同样失败，未记为通过；证据与平台边界见覆盖矩阵。

## 2026-11-04 会话切换的侧栏渲染隔离（SPT08）

点击已有 session 时，文件预览回调随活动会话变化；侧栏未使用该回调却仍接收它，
项目文件操作又依赖整个 props，导致所有项目行的 memo 失效。每个单行 TaskList
还订阅整个 workspace 的 activeTaskId，使无关会话行重复执行。

- 侧栏契约移除未使用的代码预览回调。项目文件操作只依赖实际使用的导航、连接与文件入口，
  顶部导航状态变化不得重建所有项目的文件操作；真实文件入口变化仍使用最新回调。
- 单行从现有 session store 派生自身是否选中，身份继续使用 workspaceIdentity 或 workspacePath。
  同工作区切换只更新原/新选中行；其他工作区的同名 session 不受影响。
- 纯选中态变化时项目内容零更新；首次打开未读会话仍清除 Host 的 unreadAt，
  只允许该会话所属项目更新。运行时记录变更字段，禁止把真实未读更新当作多余渲染屏蔽。
- 不新建选中态缓存，不改变 Host 行集合、导航完成、未读 CAS、文件入口取消代际或
  desktop-continuous / web-remote-replayable 边界。

```text
点击 session → session store 唯一选中态 → 原/新选中行
导航 chrome 变化 → 侧栏父组件 → 文件操作实际依赖未变 → 项目内容跳过更新
真实文件回调变化 → 最新回调 → 原文件导航/连接链路
```

SPT08：44 项目，桌面/手机布局、深浅主题；草稿进入会话与 A/B 连续切换、
跨 workspace 的同名 task 隔离、最新文件入口、项目/任务 DOM 身份不变。
浏览器/独立 Electron 记录组件执行范围，完整 App 回放实际选择与文件入口。
渲染次数作为断言；耗时只作为观测，不以开发模式结果推导生产 FPS。

新建会话回归（SPT08）：从已有会话点击新建，活动会话清空及草稿预热取得 session ID
是两个独立提交阶段。两阶段均不得更新无关项目内容；只允许原选中行取消选中。
保留草稿准备、项目归属、会话导航及文件操作取消语义，不通过隐藏更新或比较器忽略 props 修复。
首次从历史会话进入 workspace 后，新建会补全 tab 的 workspacePurpose；这类分类更新
同样不得传播到全列。导航点击从窗口 tab store 读取最新目标；远端同步菜单仅订阅
workspaceIdentity → localWorkspacePath 映射，真实映射变化仍更新同步目标。
会话行的连接解析也只订阅 workspacePath、workspaceIdentity、remoteSessionId、remoteTarget，
避免分类字段更新穿透单行 memo；远端身份与连接切换仍触发原解析逻辑。
完整 Dev App 需在至少 40 项目的现场分别记录点击和 Cmd/Ctrl+N 的 React commit、
草稿预热完成与列表 DOM 身份；独立浏览器夹具覆盖桌面/手机布局及深浅主题。

```text
已有会话 → 点击新建 → 活动会话清空 → 草稿预热完成
                        └─ 仅原选中行更新
无用预览回调不进入侧栏；实际文件导航输入未变 → 项目内容零更新
```
