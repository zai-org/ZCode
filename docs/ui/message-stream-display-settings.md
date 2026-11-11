# Message Stream Display Settings

「Agent 能力 → 行为与工具」中的两个开关独立控制对话详情消息流的展示内容：

- `messageStreamShowReasoning`：开启时展示全部 reasoning / thought 行；关闭时每个 assistant 轮次仍展示第一条 reasoning，后续 reasoning 隐藏。
- `messageStreamShowTodos`：开启时展示 Todo 工具卡片，关闭时不展示。

四种开关组合都必须成立：首条 reasoning 始终展示；“显示思考过程”只控制同一轮的后续 reasoning，“显示待办”独立控制 Todo。设置变化通过共享设置快照传入 V4 `SessionPane` 的行渲染上下文；每轮首条 reasoning 的 `rowId` 由 `ConversationTurnGroup` 根据该轮全序行派生，不复制 renderer-local 可见性状态。

“显示思考过程”对新用户默认开启。切换默认值的版本使用
`messageStreamShowReasoningMigrationInitialized` 执行一次性迁移：

- 旧 `setting.json` 没有迁移标记时，无论 `messageStreamShowReasoning` 原值为
  `true`、`false` 还是缺失，都统一迁移为 `true`，并把迁移标记与结果一起通过设置服务的串行写入队列原子落盘。
- 迁移标记存在后，磁盘中的 `true` / `false` 都是权威用户选择；用户再次关闭时，后续读取和升级不得重新开启。
- 新安装直接解析为 `messageStreamShowReasoning=true` 且迁移已完成；首次正常设置写入会把这两个字段一起持久化。

```text
settings read
  |
  +-- migration marker missing --> force reasoning on --> persist marker
  |
  +-- migration marker present --> preserve stored true/false
```

这两个开关只裁剪 UI 渲染，不修改 CLI projection、session snapshot、工具执行结果或持久化消息。`ConversationStatusPanel` 继续按 `plan` / `todoGroups` 展示会话进度摘要，不受 `messageStreamShowTodos` 影响。

桌面端 `desktop-continuous` 与手机 Web 端 `web-remote-replayable` 复用同一渲染规则；开关不参与传输、恢复、队列或 workspace identity 判定。
