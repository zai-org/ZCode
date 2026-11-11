# 闲时任务完成后恢复对话，Composer 仍引用隐藏闲时模型

Status: needs-triage

2026-10-17 转正回放记录。本轮只记录业务问题，不修改业务实现。

- 规格：[D23/D33](../../off-peak-task/decisions.md) 要求 idle-plan 只属于自动执行轮，不写常驻会话选择；终态后的人工输入使用用户 Provider。
- 用例：[闲时子代理模型继承](../../../packages/desktop/test/e2e/conversation-session/automations/manual-review/pending/conversation-session-offpeak-subagent-model-inheritance.test.ts)。前台子代理、后台子请求及唤起轮的模型和票据断言均已通过。
- 新增只读证据在 `packages/desktop/.e2e-artifacts/pending-promotion-repair-observed-current-1-4-20261016-02001f1247/`。`offpeak-selection-before-background-wakeup.json` 记录真实 UI 已选择 `e2e-upstream / deepseek-v4-flash / high`；`offpeak-selection-after-reopening-completed-task.json` 记录重开后变为 `account:bigmodel-offpeak-idle-plan / GLM-5.3 / max`，可用档位为空。
- 重开后显示“选择模型”，输入普通消息后发送按钮不可用，请求未到普通 Provider。此时草稿持久化为空；“只改模型的空草稿是否保留”可能影响用户选择，但不能解释为何恢复值落到不可供人工选择的隐藏 Provider。还需追踪常驻选择的写入与恢复来源。
- 未用重选模型、增加等待或跳过普通消息断言掩盖问题。验收应同时证明后台唤起保留本轮闲时模型，终态后人工消息可以使用用户 Provider，且 idle-plan 不泄漏到常驻选择。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-912-pending-20261019` 的两份 offpeak-selection 诊断再次显示：后台唤起前为 `e2e-upstream / deepseek-v4-flash / high`，恢复已完成任务后为 `account:bigmodel-offpeak-idle-plan / GLM-5.3 / max`，可用档位为空。普通消息发送按钮不可用，请求未到普通 Provider。
