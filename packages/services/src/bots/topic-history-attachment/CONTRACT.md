# bot-topic-history-attachment

`topicHistoryAttachment.ts` 把飞书话题增量写成一个 `text/plain` 附件，随用户消息交给模型；服务端归档用于权限与检查点，不生成模型隐藏消息。

- 公开面：`../topicHistoryAttachment.ts` 的 `createTopicHistoryAttachment`，签名见 `contract.ts`。
- 附件包含快照 ID、覆盖范围与消息正文；文件和图片只列资源索引（A1、A2…），内容不展开。每个索引项是 `{ inputId, messageId, index }`，即 `ReadTopicResource` 的输入（[会话工具设计](../../../../../docs/architecture/zcode-app-control-design.md) 0.8）。
- 超过协议附件上限时抛错，不截断正文。
