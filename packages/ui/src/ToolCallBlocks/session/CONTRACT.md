# 会话工具展示

UI 模块负责 ListSessions、ReadSession、SendToSession、WaitSessions 的摘要与详情。
外部通过 contract.ts 选择 renderer 或复用只读详情分区；输入沿用 ToolCallBlockRenderContext。

- tool call 是唯一数据源，无跨会话标题缓存、服务调用或业务状态副本。
- 工具失败优先；admission、delivery 和 wait 状态分别表达，不由 completed 推断目标任务成功。
- 字段缺失只展示已知信息，不输出内部路由或整包 JSON。消息原文保留。
- ToolLayout 持有折叠状态；ToolDetailSection 仅持有剪贴板反馈；快照加载沿用注入回调。
- 完整展示规则和验收入口见 docs/ui/tool-display-rendering.md。
