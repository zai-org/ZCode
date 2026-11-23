# 01 — 同一项目新建任务后立即发送，首条消息失败

Status: needs-triage

## 现象

- 在任务 A 的视图里，点"新建任务"进入同一项目（同一 workspace）的草稿，0.5–1 秒内发送。
- 发送在约 10 ms 内失败，出现 SEND_FAILED 横幅（"Failed to send. Try again later."），原文留在输入框。Agent 没有收到这条消息。
- 稍等再发送就能成功。

## 时序（2026-10-27 桌面 E2E 运行时证据）

```
Renderer (SessionPane)                                        Agent
0     任务 A -> 同 workspace 草稿（readiness gateKey 不变）
      首帧沿用旧状态 "ready" -> 预热会话 #1 的 createSession 发出 ──▶ 排队
      同一次 commit 里，readiness effect 改为 "checking"
+126  gate=checking -> 预热被禁用 -> #1 标记 retiring（请求在途，无法取消）
+157  gate=ready -> 预热重新启用 -> 等 #1 收口
+305  发送按钮已可点
+513  点击发送 -> waitForSession 发现 current.retiring -> 抛"草稿会话已切换，请重新发送"
+865  ◀── #1 ack -> deleteSession(#1) -> createSession #2 ──▶
+1209 ◀── #2 绑定（此后发送才成功）
```

## 证据

- 任务视图下 gate 未启用时状态写成 "ready"：`packages/ui/src/v4/composer/useDraftModelReadinessGate.ts:68`、`:144`；切到同 workspace 草稿时 gateKey 不变，首帧沿用该状态。
- 预热会话 retiring 时发送直接失败：`packages/ui/src/v4/composer/useDraftSessionPrewarm.ts:227-228`、`:245-249`。
- 运行记录：`desktop-e2e-20261026-192330-465`、`desktop-e2e-20261026-195806-698`。Agent 日志里 B 的预热会话 #1 一 ack 就被关闭并新建 #2，B 一直没有 `v4 prompt admitted`；ARMS 缓冲有 `send_result status=fail reason_code=composer_error`。

## 影响

真实用户在同一项目里新建任务后很快发送（包括草稿上的一键发送入口），会遇到一次发送失败，需要手动重发。

## 处理方向（未定）

- readiness gate 从未启用切到启用时不沿用旧的 "ready"；或
- 预热重建期间禁止发送，或等新的预热会话绑定后再发送。

## 来源

2026-10-27 动态 MCP 分支编写 E2E MCPW09 时发现。相关文件自发布基线 `2a04205f08` 起没有改动，不是该分支引入；该分支不修复。

## Comments

- 2026-10-27：用户决定 MCPW09 不修产品、不重发，改为新建草稿后固定等待 2 s 再发送（`MCPW09_DRAFT_PREWARM_SETTLE_MS`）。产品竞态仍在，本 Issue 保持 `needs-triage`。
