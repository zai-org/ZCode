# 项目新建入口的会话来源埋点错误

Status: needs-triage

2026-10-17 批量 E2E 转正期间记录。按用户要求，本轮仅维护 E2E，暂不修改业务逻辑。

- 规格：[TEL11](../../conversation-session-case-catalog.md)。
- 复现：从项目入口首发后，`session_create.create_source` 应为 `project`，实际为 `session`。
- 根因：`useRootWorkspaceActions.startDraftInWorkspace` 漏传 `createSource`，store 使用默认 `session`。
- 代码：[项目入口](../../../packages/ui/src/root/useRootWorkspaceActions.ts)。
- 回归：[create-telemetry](../../../packages/desktop/test/e2e/conversation-session/telemetry/manual-review/pending/conversation-session-create-telemetry.test.ts)。保留失败断言。
- 证据：`packages/desktop/.e2e-artifacts/pending-promotion-resume-3-20261016-02001f1247/`。

验收：修复来源传递后，以 common + case-local fixture 回放通过，并保留后续发送不重复上报的断言。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-907-pending-20261019` 再次捕获项目入口的 `session_create.create_source=session`，预期仍为 `project`。保留原埋点断言与 pending 状态。
