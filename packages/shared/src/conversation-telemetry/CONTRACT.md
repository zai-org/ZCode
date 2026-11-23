# 对话执行遥测契约

唯一状态 owner 为一个 workspace 的 live fact 归集器；只产生统计，不接纳或重排业务输入。
通过注入的 reporter 输出事件；shared 不依赖 UI、Node I/O 或网络。Desktop UI 保留 ARMS adapter，
扫码远控执行服务仅输出 completion/step。输入来源按 command 固定，snapshot/replay 不补报。

协议与验收见 [对话埋点规范](../../../../docs/monitoring/conversation-telemetry-v4.md)。

Main 注入 `trackPendingReport`，dispatcher 在接收事件时同步登记完整投递 Promise。
退出等待与超时由 TelemetryCore 单独管理，dispatcher 不创建第二份 pending 集合或退出计时器。

首响归属仅由本 owner 冻结。旧 strict fact 通道不可新增字段；独立的 admission 与
model.request.metrics 通过 App 内部 ConversationTelemetryInput 合流，复用现有有界缓冲。
补充通知与原事实同 eventId 时分通道去重，Token 指标不再次参与累计。
本次审核要求的定向时序测试入口：
`pnpm exec vitest run --config packages/shared/vitest.config.ts`。配置只发现
`packages/shared/test/messageTelemetry.test.ts`，不恢复 App 全量单测。
