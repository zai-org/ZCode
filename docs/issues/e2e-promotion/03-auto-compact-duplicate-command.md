# 自动压缩期间重复 compact 被错误入队

Status: needs-triage

2026-10-17 批量 E2E 转正期间记录。按用户要求，本轮仅维护 E2E，暂不修改业务逻辑。

- 规格：[K05](../../conversation-session-case-catalog.md) 要求同一会话压缩期间拒绝重复 compact。
- 复现：自动摘要请求受控挂起时再次发送 `/compact`，该命令被入队；自动压缩完成后又发起手动压缩，后续 text/goal 被挡住。
- 根因：[compact admission](../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts) 只检查 `activeTurn.kind=compact`、手动 controller 和已排队 compact。自动压缩是 prompt turn 的内部阶段，未命中重复检查。
- 回归：[compact-auto-actions](../../../packages/desktop/test/e2e/conversation-session/context/manual-review/pending/conversation-session-compact-auto-actions.test.ts)。保留失败断言，不额外释放错误创建的手动压缩来绕过问题。
- 证据：`packages/desktop/.e2e-artifacts/pending-promotion-recheck-extra-2-1-20261016-02001f1247/`。日志先出现 `compact.auto.completed`，随后出现 `compact.started`（`inputLength=8`）；网络捕获显示第二个摘要请求保持 pending。

验收：自动压缩期间重复命令被明确拒绝，队列不增加维护项；释放原摘要后，pending 输入及 text/goal 队列继续消费。

2026-10-19 正式回放新增独立现场：`conversation-session-compact-timeline-projection.test.ts` 第一条。
`pending-promotion-formal-isolated-186-20261019` 在 `08:51:09.606` 记录
`compact.auto.completed`，随后 `08:51:10.026` 记录 `compact.started`（`inputLength=8`）。
额外摘要在 `.240` 发起，并因没有夹具返回 500，SDK 随后又请求两次；默认轮则误命中旧共享响应。
旧 E2E 的 UI 断言在额外摘要前结束，因此两轮退出码均为零，不能算通过。
该 E2E 已改为核对重复命令的 compact lock 拒绝 ACK，移除短暂无请求观察窗；
不为额外摘要增加响应。正式转正需保留此失败，第二条 manual failed 投影需独立判断。

## staging 52cd1bc1d3 续跑

`pending-resume-52cd-e-186-pending-20261019` 再次确认第一条为业务缺陷：
自动摘要处于受控挂起期间，单次 `/compact` 的结构化 ACK 为
`{"revisionAtDecision":20,"status":"accepted","type":"compact"}`，没有按契约拒绝。
此轮在错误准入处立即失败，没有增加摘要响应或重发命令；网络捕获无 Missing Fixture。
同文件第二条 manual failed 历史投影 1/1 通过，第一条后续的 pending assistant 收口仍未验证。
保留 pending，本轮不修改业务实现。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-905-pending-20261019` 也重现同一链路：Agent 在 `16:18:15.343Z` 记录 `compact.auto.completed`，随后 `.689Z` 记录 `compact.started`，`inputLength=8`。额外摘要请求一直挂起，导致 UI 等待 auto/success 超时。不能将最后的超时归因为缺少成功响应；错误创建的手动压缩本身已违反准入契约。
