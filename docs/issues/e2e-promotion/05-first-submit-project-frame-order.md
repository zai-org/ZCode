# 项目首发列表行先于详情绑定出现

Status: needs-triage

2026-10-17 转正回放记录。按用户要求只记录，暂不修改业务实现或放宽断言。

- 规格：[首发可见性 FSV05](../../task-first-submit-visibility.md) 要求列表与详情同次提交，草稿帧不得提前出现新任务行。
- 回归：[first-submit-visibility](../../../packages/desktop/test/e2e/conversation-session/composer/manual-review/pending/conversation-session-first-submit-visibility.test.ts)。测试已修正全局分支，明确从全局入口创建草稿；全局分支通过，项目分支仍失败。
- 证据：`packages/desktop/.e2e-artifacts/pending-promotion-repair-state-1-2-20261016-02001f1247/FSV05-project-frames.json`。共 32 帧：第 30、31 帧 pane 仍为 draft，新增侧栏行数已为 1；第 32 帧才绑定正式 session，行存在且选中。
- 结论：已复现与当前规格不符的可见顺序。列表存在与选中断言通过，失败项是两帧提前显示；不是 Provider 未返回，也不是控件定位失效。具体业务状态提交位置仍待定位，不能将 E2E 的逐帧断言改成最终状态等待。

验收：保留真实逐帧采样，首次正式详情帧存在同一选中行，之前的 draft 帧新增行数始终为零；全局与项目入口分别通过。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-908-pending-20261019` 的全局与项目入口均失败。逐帧文件 `FSV05-global-frames.json` 共 174 帧，第 172、173 帧仍是 draft，但新增行数已为 1；第 174 帧才绑定详情。项目共 31 帧，第 29、30 帧提前显示行，第 31 帧绑定详情。两者首次正式详情帧的行和选中状态均正确；失败仍是提前出现的两帧。
