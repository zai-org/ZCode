# Browser Use Guest scope 冻结与绑定自愈规格

> 状态：已实现（§5 human Browser tab：2026-10-23）
> 适用范围：Desktop `desktop-continuous` 的 Browser / Browser Use `<webview>` guest。
> 不适用：手机 `web-remote-replayable` 的独立恢复语义、relay/main 中的 session/stream 业务状态。

## 1. 问题定义

Browser Use tab 的 ownership 在 `BrowserViewReady` 创建时冻结为：

```text
(windowId, workspaceKey, remoteSessionId?, sessionId, browserId, browserGeneration)
```

其中：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

`workspaceKey` 只用于身份与隔离；`workspacePath` 只用于执行和展示。已经创建的 tab 不得因为用户切换
当前 workspace、task 或 remote connection 而重新读取 ambient scope。

线上曾出现 renderer 以旧/当前 workspace scope 上报 guest，main 按 owner scope 拒绝后没有返回结构化
结果，调用方继续等待 attach timeout，最终把 scope 错误显示成 `browser guest not attached`。本规格把
scope 拒绝、guest recovery 和 stale command 防护收敛为一条状态机。

## 2. 状态与事件链路

```text
main owner scope W1/S1
        |
        | BrowserViewReady(W1/S1/tabId/generation)
        v
renderer side-pane tab 冻结 W1/S1
        |
        | did-attach + attachGuest(W1/S1/generation)
        v
main 校验并绑定 guest
        |
        +--> accepted -> resolve recovery flight -> 执行命令
        |
        +--> scope-mismatch / stale / destroyed
                |
                v
          标记当前 generation 失效
                |
                v
          request rebind（沿用 tab owner scope）
                |
                v
          renderer detach ACK -> 替换 webview generation
                |
                v
          新 guest did-attach -> 重新 attach
                |
                v
          一次有界重试；失败则返回 typed error
```

同一 tab 的并发命令共享一个 recovery flight。guest A 被 B 替换期间，捕获 A 的旧命令必须在实际 CDP
dispatch 前返回 `stale_guest`，不得把动作发送到 B。

## 3. 实现合同

### 3.1 scope 传递

- `BrowserUseSidePaneTab` 保存并使用创建时的 `workspaceKey`、`sessionId`、`remoteSessionId`。
- `AnimatedSidePanePanel`、`BrowserUseSidePaneContent`、`UnifiedBrowserView` 不从当前 active workspace
  回填已有 tab 的 identity scope。
- attach 去重 fingerprint 必须包含 guest id、active、workspaceKey、remoteSessionId、sessionId 和
  residency generation；scope 变化即使 guest id 不变也必须重新 attach。
- 远程 workspace 始终保留 `workspaceIdentity` 对应的 workspaceKey 与 `remoteSessionId`，不得只按 path
  判等。

### 3.2 attach 结果

`browserViewAttachGuest` 返回结构化结果。main 仍然 fail-closed，但 scope/session/generation 拒绝不得
静默吞掉或等到通用 timeout；被拒绝且不是当前 guest 的 incoming guest 必须清理，防止 orphan WebContents。

### 3.3 自愈边界

- main 为每个 tab 维护 attaching/recovering 的 single-flight；恢复成功后一次性唤醒所有 waiter。
- scope mismatch 只触发一次受控 rebind/attach retry；不允许无界循环。
- renderer 重建继续先等待 main 的 CDP detach ACK，再替换 webview。
- 正常 task/workspace 切换不卸载存活 guest；guest crash、eviction 或 attach timeout 才进入恢复。
- 完整应用重启不恢复 Browser Tab；32-tab residency 和现有 close 语义保持不变。

## 4. 验收用例

| Case    | 场景                            | 断言                                                        |
| ------- | ------------------------------- | ----------------------------------------------------------- |
| BGR-001 | Tab 属于 W1/S1，界面切到 W2/S2  | attach 仍携带 W1/S1，不发生 scope 漂移                      |
| BGR-002 | 同一 webContentsId 只改变 scope | attach fingerprint 变化，重新上报并由 main 校验             |
| BGR-003 | main 返回 workspace-mismatch    | renderer 收到 typed rejection，不等待通用 10 秒 timeout     |
| BGR-004 | 多个命令同时遇到 missing guest  | 只创建一个 recovery flight，成功后所有 waiter 收敛          |
| BGR-005 | Guest A 在命令等待期间被 B 替换 | 旧命令返回 `backend_unavailable`，不向 B dispatch           |
| BGR-006 | 一次 rebind 仍失败              | 有界 retry 后返回 `backend_unavailable`，tab shell 不泄漏   |
| BGR-007 | local/remote 相同 path          | workspaceIdentity/remoteSessionId 不串，命令与 tab 互不可见 |

## 5. Human Browser tab（`browser:*`）

Human Browser tab 指用户或 webview popup 打开、当前没有被 Agent 认领的 `browser:*` tab。main 侧判据：
`tab.owner` 就是 `tab.userOwner`。

### 5.1 scope

- 侧栏渲染 human tab 时，`workspaceKey` 使用 tab 创建时冻结的 `tab.workspaceKey`，与 Browser Use tab
  相同。当前 workspace 的 path 只用于执行和展示。
- 原因：切换 workspace 的那一次 commit 里，workspace props 已是新值，侧栏 tabs 仍是旧 workspace 的
  （tabs 在父级 effect 中才替换）。若 human tab 读当前 workspace，会以错误 scope attach，触发
  `workspace-mismatch`。

### 5.2 rebind 归属

- human tab 的 guest 只由其所属 workspace 中已有的 Browser shell 创建。
- main 对 human tab 的 rebind 只记录 `attachFailure`，不发送 `BrowserViewReady`。`BrowserViewReady` 只用于
  Browser Use tab（Agent 创建或已认领）。
- 所属 workspace 不可见时不 rebind。用户回到该 workspace、shell 重新挂载并 attach 后，main 再按恢复 URL
  恢复页面。
- 原因：renderer 把 `BrowserViewReady` 解释为 Browser Use 事件，会在当前 workspace 中为同一 tabId 新建
  隐藏的 `browser-use` shell。该 shell 能 attach 成功，于是在用户看不到的 workspace 中重新加载页面。

### 5.3 恢复 URL

恢复 URL（renderer `lastRestorableUrl` / side pane `browserUrls`、main `cachedUrl`）只记录主框架**已提交**
的 URL，即 guest `getURL()` 的值。

- 导航开始前不写恢复 URL。`initialUrl` 和外部导航请求只是导航意图。
- 一次导航结束后若没有提交（下载响应、`ERR_ABORTED`、`ERR_FAILED`），恢复 URL 回落为当前已提交的 URL。
  `about:blank` 表示没有可恢复页面。
- 主框架 `did-fail-load` 不写 `browserState.currentUrl`：失败导航没有提交，地址栏和错误态仍用
  `validatedURL` 展示；确认是下载后，仅仍显示该下载地址的地址栏回落为已提交 URL，不覆盖后续草稿。
- renderer 上报的 `restoreUrl` 只有一个来源 `lastRestorableUrl`，不得回退到 `currentUrl`。曾因回退
  把失败导航的附件地址写进 main 的 `cachedUrl`，并随下一次恢复再次触发下载。
- main 恢复（pageState 或 URL）结束后，`cachedUrl` 同样回落为 guest 已提交的 URL。
- 网络错误页会提交 document，`getURL()` 返回失败的 URL，所以仍可恢复和重试。
- 原因：`Content-Disposition: attachment` 的 URL 会开始下载，但页面不提交。若把它当作恢复 URL，每次
  rebind 或 shell 重新挂载都会再下载一次。

## 6. 验收用例（Human Browser tab）

| Case    | 场景                                                 | 断言                                                          |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| BGR-008 | human tab 属于 W1，界面切到 W2                       | attach 携带 W1，不发生 `workspace-mismatch`                   |
| BGR-009 | human tab guest 被销毁或 scope 被拒绝                | main 不发送 `BrowserViewReady`；所属 shell 重新 attach 后恢复 |
| BGR-010 | human tab 导航到附件 URL（下载、导航未提交）         | 恢复 URL 不变为附件 URL；重新挂载不再请求该 URL               |
| BGR-011 | main 恢复的 URL 没有提交                             | `cachedUrl` 回落为已提交 URL，下次 rebind 不再请求该 URL      |
| BGR-012 | human tab 主框架 `did-fail-load`（非 `ERR_ABORTED`） | 该 URL 不进入恢复状态；地址栏与错误态仍展示失败地址           |

## 7. 验证

App 业务单测已退役；实现必须通过受影响的桌面 E2E、`pnpm typecheck`、`pnpm lint` 与架构检查。Windows Electron 真实回归需要
覆盖 guest idle 后激活、新建 tab、workspace/task 切换和 `render-process-gone`，并确认桌面 continuous
链路没有引入手机 replayable snapshot/queue 语义。

### 附件导航错误展示

Electron `will-download` 是下载开始的唯一事实源。主进程按 guest 身份向所属窗口发送 URL chain；界面仅对匹配 guest 和 URL 的 ERR_FAILED(-2) 清除导航错误，不屏蔽其他网络失败。下载事件与导航拒绝可任意先后到达；新导航清除上一轮匹配信息。匹配成功时也收敛地址栏：只替换仍显示该失败下载 URL 的值，恢复地址仍复用 `settleRestorableUrl`；后续编辑的草稿不被晚到下载通知覆盖。下载保存及取消仍由 Electron 处理。

验收：本地 attachment 响应只请求一次，不显示页面错误；普通网络失败仍显示错误；切换 workspace 不重复下载。桌面各系统共用此事件链，Web 不提供此桌面事件能力。
