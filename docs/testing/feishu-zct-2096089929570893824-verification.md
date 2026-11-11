# ZCT-2096089929570893824 本机验收记录

> 历史来源：staging `35ba050592`（2026-09-07）。以下保留原作者当时的验收事实，
> 不是 Todo103 整合版本的当前验收，也不据此扩大本轮修复范围。
> 本轮 Bot 重接与新证据见 `../working-memory/provider-refactor/research/todo103-staging-integration-ledger.md` 第 20 节。

日期：2026-09-07。环境：macOS arm64、本地生产环境配置的 ZCode Dev、验收机器人的飞书私聊、
BigModel Coding Plan / GLM-5.3-Flash。操作通过 Computer Use 完成，未向群聊发送测试消息。

## 修复范围

- `65ad97769b`：已删除的机器人活动任务不再被继续复用。
- `3c53fe008f`：保留飞书发送错误的业务码和 log ID，在连接状态之外展示投递失败，成功发送后清除。
- `8e7fe75d0f`：严格协议 schema 接收 CLI 已存在的可选 `scheduled.assistantMessageId`。

私聊发送保持 open_id，不在失败时切换 chat_id；群聊仍不支持。已有卡片通过 message_id 更新。

## 实机结果

| 验证              | 结果                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| CUA60ROUND 长任务 | 60 次串行工具调用，每次等待 20 秒并计算校验值；60 个开始与完成标记齐全                                          |
| 长任务实际耗时    | 模型轨迹 04:35:21.232Z 至 05:02:31.568Z，27 分 10 秒；卡片中的模型估时不作为计时依据                            |
| 长任务飞书终态    | 解锁后通过 Computer Use 确认第 60 轮结果、CUA60ROUNDDONE 和 Completed 均可见                                    |
| 最新构建回归      | 正常退出旧进程，重新构建并启动包含 8e7fe75d0f 的开发版；CUAFIX1405 六轮计算全部完成，桌面显示 Worked for 1m 14s |
| 协议运行时        | CLI 日志确认发送 6 条含 assistantMessageId 的 scheduled 事件，新进程日志中无效 session event 丢弃告警为 0       |
| 后续消息          | 飞书与桌面均显示 CUAFIXFOLLOWUPOK，飞书为 Completed                                                             |
| 连接状态          | Bots → 验收机器人 显示 Feishu WebSocket is running / Connected，无投递错误提示                                  |

长任务与修复后回归的会话标识保留在本机验收证据中，不写入公共文档。

本机截图存于 `/tmp/zct-closure-evidence/`，包含长任务终态、修复后桌面/飞书结果和机器人连接状态。
修复后日志为 `/tmp/zct-closure-runtime-final.log`。这些是本机临时证据，不作为仓库可移植测试夹具。

## 自动化证据与边界

- 协议修复前，新增四种组合均因未识别 assistantMessageId 失败；修复后协议/stdio 测试 74 项通过、1 项按平台条件跳过。
- 类型检查通过；Lint 0 错误、43 条既有警告。
- 既有 BOT-E2E-DF-01 使用合成飞书业务拒绝验证诊断、成功清除、open_id 发送及群聊不创建任务；不能视为真实租户拒发复现。
- 本次未观察到飞书 `Sending messages to users is temporarily unavailable`。客户端修复和本机正常链路验收完成，不据此宣称飞书侧拒发根因已消除。
- 未发布或合并；Windows/Linux、手机实机和原用户租户不在本次验收范围。协议测试覆盖两种 deliveryKind 的字段校验，不等同于完整跨端恢复测试。
