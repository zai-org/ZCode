# 定时任务执行会话丢失自动化归属

Status: needs-triage

2026-10-17 批量 E2E 转正期间记录。本轮只修 E2E，业务代码未修改。

- 回归：[TSL38](../../../packages/desktop/test/e2e/conversation-session/automations/manual-review/pending/conversation-session-automation-run-unread-clear.test.ts)。真实 scheduler 派发，模型请求完成；Provider Selection 迁移正确。
- 运行证据：`packages/desktop/.e2e-artifacts/pending-promotion-repair-closeout-final-1-1-20261016-02001f1247/`。`automation_runs.session_id` 对应真实 task，`dispatch_status=dispatched`、`error=null`；task 的 `unread_at` 有值，但 `cron_automation_id=null`，`meta_json` 也没有 `cronAutomationId`。
- 影响：按自动化归属查询不到执行会话；未读本身并未缺失。不能把该失败解释为模型没有返回数据。
- 定位边界：[Host 派发](../../../packages/desktop/src/host/index.ts) 已向 `createTask` 传入 automationId；[task adapter](../../../packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts) 创建时也补写了 cronAutomationId。需要继续追查后续索引同步中何处丢失，尚未确认具体覆盖语句。
- E2E 使用运行台账中的 session ID 继续验证点击未读，并保留任务归属等于 automationId 的严格断言，不用 join 的结果冒充归属字段正常。

验收：定时执行完成及后续索引同步后，task 保留 cronAutomationId；对应会话可见，点击后 UI 和索引的未读同时清除。

2026-10-17 后续复跑 `pending-promotion-repair-verified-current-1-4-20261016-02001f1247`：沿 `automation_runs.session_id` 找到任务后，UI「任务」分区仍没有蓝点，因而未进入点击清除步骤。数据库 `unread_at` 存在不等于 UI 投影正常；蓝点缺失的具体原因仍待定位，不能直接归因于缺少 `cronAutomationId`。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-902-pending-20261019` 再次在 UI 蓝点处失败。失败时的只读数据库记录显示：scheduler 已 dispatched，error 为 null，执行 task 已 completed 且 unread_at 有值；cron_automation_id 仍为 null，meta_json 不含该归属。UI 的任务分区显示“暂无任务”。这同时确认归属缺失和列表投影异常，仍不能仅凭前者断言后者的具体因果。
