# 08 — MO01 期望只有一次授权后 initialize，草稿会话也会连上

Status: needs-triage

## 现象

- E2E `conversation-session-mcp-oauth-status-isolation` 的 MO01/MO03 在设置页完成插件 OAuth 授权后断言 `authorizedInitializeCount: 1`，实际是 2，用例失败。
- 多出的一次来自应用启动时预热的草稿会话（默认项目 `ZCodeProject`）：它在 `session/create` 时就连接全部 MCP server，包括插件的 authorization-code HTTP server。

## 时序（发布基线运行 `desktop-e2e-20261026-214541-765` 的 Agent 日志）

```
时间(ms)  草稿会话租约                                   设置页租约
0         session/create（应用启动时预热草稿）
+263      连接插件 OAuth server → 401 → 发起授权
+709                                                     连接 → 401 → "already in progress elsewhere"，跟随
          用户在设置页点授权 → 回调完成
+4762     凭据发布
+4771     initialize（已授权）#1 → connected
+4986                                                    initialize（已授权）#2 → connected
```

谁先发起授权取决于先后：发布基线上草稿会话先发起、设置页跟随；当前分支上设置页先发起、草稿会话跟随。两种情况下两个租约都会用新凭据各 initialize 一次。

## 证据

- 发布基线 `2a04205f08` 的独立 worktree：`desktop-e2e-20261026-214541-765`，同一断言失败（期望 1，实际 2）。Agent 日志：`session_87dd…` 在 `session/create` 后 260 ms 记录 `MCP OAuth authorization required`，设置页租约记录 `already in progress elsewhere`，两者随后都 `MCP server connected`。
- 当前分支工作区：`desktop-e2e-20261026-212859-631`、`desktop-e2e-20261026-213109-679`（后者 helper 换回 HEAD 版本），失败相同。
- 分支 HEAD `2e67d50cc3` 不能用于比较：设置页 `mcp-sync.listWorkspaceMcpServerStatuses` 因协议 schema `unrecognized_keys` 失败，用例在更早一步失败（`desktop-e2e-20261026-214202-827`）。

## 影响

- 该 E2E 在发布基线上已经失败，不能作为回归证据。
- 产品侧：用户尚未使用的预热草稿会话也会参与 OAuth 授权（发起或跟随）。是否应该这样，需要确认。

## 处理方向（未定）

- 只改用例：按租约分别计数，或在断言前排除草稿会话的连接；或
- 改产品：预热草稿会话不发起交互授权，只在真正发送后才进入授权流程。

## 来源

2026-10-27 动态 MCP 分支回归 MO01 时发现。发布基线已存在，不是该分支引入；该分支不修复。

## Comments

- 2026-10-27：用户决定只改用例断言，不改产品。MO01 改为：授权、注册、换 token 各 1 次；用新凭据 initialize 1–2 次（设置页租约，加预热草稿会话租约）；之后两个 status poll 周期内不再增加。运行 `desktop-e2e-20261027-035558-255` 通过了这几条断言。
- 同一次运行发现用例后半段也已过期：返回工作区后等待 `TID_CHAT_VIEW`，但这个 test id 随旧 ChatView 编排层在 `ac897fb5f69`（2026-07-05，早于发布基线）删除，用例停在「制造 MCP 配置读取失败前工作区没有恢复」。后半段仍用旧 ChatView 辅助函数（`startNewTask`、`sendPrompt`、`waitForChatState`），需要整体迁到 v4 辅助函数。未处理，本 Issue 保持 `needs-triage`。
