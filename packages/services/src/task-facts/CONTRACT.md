# task-facts

会话事实摄入和命令交接的唯一应用入口。无 SQLite、Agent 进程、计时器、UI 或第二份状态缓存；存储、CLI 来源和事件发布通过端口注入。

- CLI 拥有 title/source、created/updated、lastOutcome 与 deleted；Host 只投影这些事实。
- `ingest` 接收已通过协议 schema 校验的 sessions-index 摘要，不使用 Host 时钟。摘要与 reconcile 均传递持久 `parentSessionId` 为 `forkedFromTaskId`，让存储层首次接纳使用同一父身份；本模块不推断项目。
- `mutate` 先执行 CLI 原生命令，再 reconcile 确认；失败直接抛出，不乐观写 SQLite。
- `reconcile` 只查询快照缺席或有降级交接意图的行，每批最多 256。缺席/不存在标记 orphan 并保留行，明确 deleted 才隐藏。
- 每次 await 后核对订阅代际/水位；迟到结果不能覆盖新帧。组织态由 project 服务拥有，此模块不修改 pin/archive/read/project。
- 桌面 continuous / 手机 replayable 共用 CLI owner；协议传输、READY、CommandInbox 的 FIFO 与去重保留在原有协议层。
- 标题/删除意图仅是旧版本交接。bit 1=删除，bit 2=标题，bit 4=orphan，bit 8=归属已判断；确认后的位清理由存储事务完成。

冷恢复 child 索引修复通过最小 listSessions/listTaskMetas/removeSubagentIndexRow 端口执行，每批 64 条、existing-only，逐条核对工作区身份和订阅代际；只删被 CLI 明确标为 subagent_child、workflow_child、nested_workflow_child、selection_side_chat 的隐藏索引，不删正文。fork、workflow_parent、未知类型及身份未确认的记录保留；列表隐藏不改变辅助对话的聊天能力。
