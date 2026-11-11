# 切到新草稿时内嵌浏览器 guest 被销毁

Status: needs-triage

2026-10-17 批量 E2E 转正期间记录。本轮未修改业务逻辑。

- 规格：[对话切换与后台保活](../../browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md#24-对话切换时的可见性与后台保活) 要求切换本身不卸载 guest。超过 32 个后台 guest 才适用 residency 挂起；本用例只有一个。
- 回归：[BU-E2E 全链路](../../../packages/desktop/test/e2e/conversation-session/browser-use/manual-review/pending/conversation-session-browser-use-iab-full-chain.test.ts)。真实 Node REPL 浏览器输入、提交、截图和画廊均已完成，随后从有浏览器的会话切到新草稿。
- 运行证据：`packages/desktop/.e2e-artifacts/pending-promotion-repair-browser-final-1-4-20261016-02001f1247/`。点击新建后，原 webContentsId 不在已挂载 webview 中；同一时段 Main 日志记录 `Object has been destroyed`、`reason=guest-destroyed`、重新 attach 和 `guest rebind restore complete`。
- 这与轮尾正常释放 CDP 不同：正常 detach 不销毁 guest，也不需要重新导航。旧断言因正常 idle DPR 恢复造成的假失败已修，本次失败发生在保活身份校验。
- 尚需定位触发 webview 重挂载的组件边界。未删除身份或页面状态断言；后续切回、缩放和冷恢复步骤尚未通过。

验收：仅切换任务时保留原 guest 与页面状态；后台隐藏，切回主动展开；窗口关闭和显式关闭 tab 才销毁页面，预算挂起按独立合同处理。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-903-pending-20261019` 再次在新建草稿后发现原 webContents 不在 webview 列表。日志 `00:17:00.555` 记录 Object has been destroyed 与 guest-destroyed，`.805` 才完成 guest 重建。原浏览器输入、提交和图库步骤已通过；失败是切换任务时 guest 身份被销毁。
