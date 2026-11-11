# 编辑重发与 Fork 没有使用 Composer 当前模型

Status: needs-triage

2026-10-17 批量 E2E 转正期间记录。按用户要求，本轮仅维护 E2E，暂不修改业务逻辑。

- 规格：[N03/N04](../../conversation-session-case-catalog.md)。
- 复现：完成一次 flash 回复，在 Composer 切换到 pro，再编辑重发或 Fork；请求及子会话仍使用 flash，规格要求使用当前选择。含工具历史的同类用例也复现。
- 根因：[SessionPane](../../../packages/ui/src/v4/SessionPane.tsx) 的 `handleEdit/handleFork` 未传 Composer 当前模型选择，继续使用会话原配置。
- 回归：[普通历史](../../../packages/desktop/test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts)、[工具历史](../../../packages/desktop/test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-tool-edit-fork.test.ts)。保留失败断言。
- 证据：`packages/desktop/.e2e-artifacts/pending-promotion-recheck-final-1-8-20261016-02001f1247/` 与同批 `1-10`，含真实请求体及失败录像。

验收：两个入口携带当前选择后，模型、思考档位与 Provider 身份断言均通过；不改写预期为旧模型。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-910-pending-20261019` 再次出现完成历史编辑后使用 flash 而非 pro。工具历史 `extra-a-911` 的工具探测通过，编辑同样返回 flash；该文件 Fork 子项停在模型配置前置断言，未执行 Fork 请求，不能把该子项计作本轮 Fork 独立复现。
