# Browser Use 对话级标签页隔离规格

> 状态：对话隔离已实现；guest 后台常驻的绝对边界已由
> `2026-07-31-browser-tab-residency-budget-spec.md` 更新为“切换本身不卸载，预算超限后可挂起”。
> 轨迹证据：`model-io-sess_e97033af-cf74-4f32-b9e8-fbc702a88837.jsonl`

## 1. 问题与根因

同为新对话首次执行 `browser.user.openTabs()`：

- 期望：显式 IAB binding 返回 `[]`，不会观察到其它对话的标签页。
- 实际：ZCode 返回同一 window/workspace 下 5 个 user tabs，其中 4 个是 `about:blank` 或 URL/title 均为空。

ZCode 的泄漏来自两个已有设计叠加：

1. 普通右侧 Browser tab 向 main attach guest 时只携带 `workspaceKey`，没有携带它已经存在于 UI 状态中的
   `ownerTaskId`；main 因而只能把它登记为 workspace 级全局可认领 tab。
2. `turnEnded` / `finalizeTabs` / `closeSession` 释放控制权时会把 tab 的 session 改成通用
   `unclaimed`，使其它 session 的 `listUserTabs` 可以再次发现它。

空白项不是模型伪造，而是已 mount 的 `<webview>` 在首次导航前以 `about:blank` ready，且
`openUserTabs()` 没有排除空白或尚未加载的 guest。

## 2. 冻结语义

### 2.1 对话隔离是强制边界

IAB tab 的可观察/可认领边界继续使用完整 browser scope；human tab 在 attach 阶段至少冻结：

```text
(windowId, workspaceKey, sessionId)
```

- renderer 必须把 tab 自身的 `ownerTaskId` 作为 `sessionId` 传给
  `BrowserViewAttachGuest`，不得读取事件到达时的当前 active task。
- `browser.user.openTabs()` 只返回与调用方 `windowId + workspaceKey + sessionId` 全部匹配的未受控
  user tabs。
- tab 被 claim、deliverable、turn cleanup 或 session cleanup 释放后，仍保留原始 session ownership；
  “释放控制权”不等于“发布给其它对话”。
- 缺少 `sessionId` 的旧 renderer attach 只能保留可见 UI，不得成为任一新 session 可认领的 tab。
- 相同 workspacePath 的不同远程 workspace 仍以既有 `workspaceKey = workspaceIdentity?.trim() ||
workspacePath` 隔离；不得退化成只比较路径。

### 2.2 空白/未加载 tab 不属于 `BrowserUser.openTabs`

user tab 只有在 guest 存活且当前 URL 为非空、非精确 `about:blank` 时才可发现。

- 空字符串：未完成有效页面加载，过滤。
- `about:blank`：UI 占位页，过滤。
- 其它 URL：保持可发现；是否允许 agent 导航仍由 browser-client 的 http/https/about:blank action
  allowlist 独立裁决。
- 当前 session 通过 `tabs.new()` 创建的受控 `about:blank` 仍可出现在 `browser.tabs.list()`；本规则只约束
  `browser.user.openTabs()`，不能破坏 agent 新建 tab 后再导航的标准流程。

### 2.3 生命周期

- `turnEnded()` 继续只取消请求，不关闭当前 session 的 agent tabs。
- `finalize({deliverable})` / `finalizeTabs({keep})` 可以释放 tab 的控制权，但 tab 只能回到原 session 的
  user-tab 集合。
- `closeSession()` 可以保留用户可见 view，但必须清除该 scope 的可控状态；其它 session 不得枚举或 claim
  这些 view。同一个 sessionId 后续恢复时可以重新发现属于自己的非空 user tabs。
- `closeSession({ closeTabs: true })` 真正关闭该 session 名下的全部 tab：仍受控的，以及此前经
  finalize / deliverable 释放回该 session user-tab 集合的。其它 session 的 tab 不受影响。它只给永远不会
  再回来认领的 session 用——dwf 子代理的 sessionId 不是任何对话，保留的 view 无人可见、无人可认领，
  只会一直挂着 guest（`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`「Subagent sessions」）。
- 任务被归档或永久删除后，真正关闭以该 taskId 为属主 sessionId 的全部 tab：用户打开的 Browser tab
  和 browser-use tab 都包括。触发源是任务事实流，不是命令入口：Window Host Controller 收到当前 source
  的 `workspace_task_list_changed`（reason 为 `task_archived` / `task_deleted` 且带 taskId）时，经
  host→main browser 桥对该 taskId 发送 `closeSession({ closeTabs: true })`，属主 scope 取该 source 的
  workspaceKey 与 remoteSessionId。手动归档/删除、手机远控、自动归档（扫描后逐条发 `task_archived`）
  和 CLI 侧删除 session 都经过这条事实流。批量永久删除只发一次不带 taskId 的事件，它只作用于已归档
  任务，tab 在归档时已关闭。main 关闭 guest 后照常通知 renderer 移除壳。任务离开列表后没有
  可见 scope，残留的 tab 没有 UI 可以关闭，出声的 tab 又受 residency 保护，不会被逐出。清理失败只记
  warn，不改写已提交的归档或删除结果。取消归档不恢复已关闭的 tab。子代理 session 名下的 tab 不在此
  范围，仍按子代理自己的 closeSession 处理。
- window close / 用户显式 close 仍真正关闭 tab。

### 2.4 对话切换时的可见性与后台保活

普通 Browser tab 与 browser-use tab 的 renderer registry 不得绑定当前 active session。单纯切换 task
不立即卸载 guest；但切换后成为 eligible background 的 guest 可以由窗口 residency 预算挂起。用户从有
Browser/browser-use tab 的 Session A 切到没有 tab 的 Session B，再切回 A 时：

```text
A active：registry[A] + mounted webview[A] + side pane expanded
  -> switch B
B active：registry[A] + live-background webview[A] + side pane collapsed
  -> optional budget suspend
B active：registry[A] + suspended shell[A] + side pane collapsed
  -> switch A
A active：resolve active tab from registry[A] + ensureResident[A] + side pane expanded
```

- 切到 B 只改变当前可见 scope，不得从 workspace 级 side-pane registry 删除 A 的 tab；切换事件本身不卸载
  A 的 `<webview>`，后台 guest 先保持页面、CDP 与进程内状态。
- 只有当前对话的 tab 出声。renderer 上报 residency 时的 `currentTask` 与标签栏可见性共用同一个 scope
  判定（`getVisibleSidePaneTabs`）；main 据此对 guest 调用 `setAudioMuted(!currentTask)`。当前对话内
  未选中的 tab 不静音。新 guest（含 rebind）沿用最近一次上报值；main 收到首次上报前不静音。
- 若所属 BrowserWindow 的 live-detached guest 超过 32，residency coordinator 可以在保护规则允许时挂起
  A 的 guest；挂起只卸载页面资源，stable tabId、归属与 shell 不变。
- B 没有归属自己的可见 tab 时必须收起 side pane，不能显示 A 的 tab 或空 tab strip。
- 切回 A 时，只要 A 仍有归属自己的可见 tab，就必须选中 A 的 preferred/current/latest tab 并主动展开；
  suspended tab 必须先惰性恢复，不能继承 B 的 `collapsed=true`。
- 用户在 A 内手动收起面板后，如果离开 A 再切回 A，仍按“当前对话存在 tab 就主动展开”恢复；显式关闭 tab
  才终止该 tab 的恢复资格。
- 普通 Web / 手机 `/remote` 不支持 Electron 内嵌 browser-use pane，本规则不新增 mobile snapshot 字段，
  也不改变 `web-remote-replayable` 的恢复边界。

## 3. 协议与分层

- `packages/shared` 的 platform channel 为 `BrowserViewAttachGuest` 增加可选 `sessionId`，保持旧 renderer
  wire 兼容。
- `packages/ui` 只通过 `IPlatformService.browserViewAttachGuest` 上报 tab ownership，不直接访问 Repo/main。
- `packages/desktop` main 从发送方绑定 `windowId`，并把 renderer 提供的 `workspaceKey + sessionId` 交给
  `BrowserGuestManager`；renderer 不能伪造 windowId。
- 本变更不修改 ZCode protocol 的 agent stdio BrowserCommand，不新增 main/relay 业务状态，也不改变
  desktop `continuous` 与手机 `replayable` 消息流。
- 手机 Web 没有 Electron `<webview>` attach；保持现有 fallback，不另起 browser runtime。

## 4. 验收案例

| Case    | Setup                                                    | Action                              | 断言                                   |
| ------- | -------------------------------------------------------- | ----------------------------------- | -------------------------------------- |
| BCP-176 | session A、B 位于同 window/workspace，A 有非空 human tab | B 调用 `user.openTabs()`            | 返回 `[]`                              |
| BCP-177 | session A 有非空 human tab                               | A 调用 `user.openTabs()`            | 返回 A 的 tab，且可 claim              |
| BCP-178 | A claim 后 turn end / deliverable / closeSession         | B 调用 `user.openTabs()`            | B 始终看不到；A 恢复时仍可看到非空 tab |
| BCP-179 | A 有 URL `""`、`about:blank`、https 三个 human tabs      | A 调用 `user.openTabs()`            | 只返回 https tab                       |
| BCP-180 | A 调用 `tabs.new()`，guest 当前为 `about:blank`          | A 调用 `tabs.list()`                | 仍返回受控 tab                         |
| BCP-181 | 旧 renderer attach 缺少 sessionId                        | 任意 session 调用 `user.openTabs()` | 旧 tab 不可认领，不跨对话泄漏          |
| BCP-182 | 相同 path、不同 workspaceIdentity/session                | 两侧分别枚举                        | 不串 workspace、不串 session           |
| BCP-206 | A 已有 mounted Browser/browser-use tab；B 无归属 tab     | 无预算压力下 A → B → A 切换对话     | A 的 webview 保持挂载；B 收起；切回 A 重新选中原 tab 并主动展开 |
| BCP-217 | A 的后台 guest 因窗口预算已挂起                          | 切回 A                              | stable tabId/shell 不变；新 guest 恢复后展示；B 的状态不泄漏    |

## 5. 完成条件

- 轨迹现象、代码根因和新冻结语义一致。
- shared channel、preload/platform、React view、desktop manager 的 session ownership 端到端贯穿。
- manager unit 覆盖跨 session、生命周期释放和空白过滤；UI/IPC unit 覆盖 sessionId 上报。
- 执行相关定向测试、`pnpm typecheck`、`pnpm lint`。
- 真实桌面回归至少验证：A/B 两个对话各自打开标签，切换后互不可见；空白 human tab 不进入
  `openTabs()`；原对话恢复后自己的非空 tab 仍可认领；A → 无 tab 的 B → A 时 A 的 webview 不销毁且
  side pane 自动展开。

## 6. 实施与验证记录

2026-07-14 已完成：

- `BrowserViewAttachGuest` 从 UI tab 自身贯穿 `sessionId` 到 desktop main；main 继续从 IPC sender 绑定可信
  `windowId`，并拒绝同 tabId 的跨 session 迟到 attach。
- `BrowserGuestManager` 的 human tab claim 增加 session 判等；release/closeSession 保留 owner session，
  同时切换到独立 unclaimed browser scope，避免 `tabs.list()` 与 `user.openTabs()` 混淆。
- `user.openTabs()` 过滤空 URL 与精确 `about:blank`；受控 `tabs.list()` 行为不变。
- 旧 renderer 缺 `sessionId` 时 fail closed：view 可保留，但不可被 agent 枚举或 claim。
- 自动化通过：root 相关单测 6 files / 152 tests；CLI core 2 files / 29 tests；CLI bootstrap
  1 file / 123 tests；`pnpm typecheck`；`pnpm lint`（0 errors，仓库既有 warnings 保留）。

待补实机项：

- 重启 desktop 到本次 main/preload/renderer build 后，做两个真实对话的 tab 可见性与 claim smoke。
- SSH/WSL/Docker 相同 path、不同 `workspaceIdentity` 的真实 shared-host attachment 回归。
- 手机 Web 没有 Electron `<webview>` attach，本次未新增 runtime；仍需在远控回归中确认既有
  `web-remote-replayable` 路径无回归。

2026-07-23 guest 恢复补充的澄清记录：

| 轮次 | 问题 | 用户确认 | 固定边界 |
| ---- | ---- | -------- | -------- |
| 1 | 历史对话 browser tab 是否应因切换而释放 | “即使切换对话也应该一直后台保留” | 普通切换继续保持同一 guest，不做刷新/重建 |
| 2 | 已被 Chromium 异常终止的 guest 如何处理 | 用户在收到“最后 URL + 稳定 tabId 原位恢复”的根因/方案后要求修改 | 仅替换失效 guest；显式关闭不恢复；不扩展跨进程重启持久化 |
| 3（2026-07-31） | 后台 Tab 是否引入预算挂起与跨重启恢复   | 确认引入                                                        | task 切换本身仍不卸载；每窗口超过 32 个 live-detached 后允许按保护/LRU 挂起，并新增跨重启 page-state 恢复 |

第 3 轮取代前两轮中的“始终同一 guest”和“不跨进程恢复”，但不改变对话/workspace 隔离。

2026-07-23 已完成并取得运行时证据：

- 同一 `workspaceKey` 内 A → B → A 切换时，真实 Electron `<webview>` 始终连接 DOM，
  `webContentsId=4`、节点 identity 与 URL 均保持不变，普通切换没有进入恢复分支。
- 通过 CDP `Page.crash` 强制终止 guest 2 后，renderer 捕获 `reason=crashed`，仅替换失效节点；
  guest 3 自动恢复原 `data:` 测试 URL，main 日志确认同一 browser tab key 重新
  `attachGuest ... cdp=true`。
- 第一轮实机验证额外发现：旧 guest 已销毁时，下载监听的 `removeListener` 会抛
  `Object has been destroyed`，阻断新 guest attach。`BrowserGuestManager.detachGuest` 现将该清理视为
  best-effort 并继续解绑/重绑；第二轮 crash smoke 已确认不再出现 IPC handler error。
- 跨 `workspaceIdentity` 切换仍遵守工作区隔离，不承诺复用同一个 guest；返回原工作区时使用最近 URL
  恢复。该边界不把一个工作区的 live guest 泄漏到另一个工作区。
- 自动化通过：相关 6 files / 139 tests；`pnpm typecheck`；`pnpm lint`（0 errors，
  52 条仓库既有 warnings）。
