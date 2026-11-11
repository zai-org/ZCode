# topic-resource-tool

依据 [会话工具设计](../../../../../../../docs/architecture/zcode-app-control-design.md) 0.8。`ReadTopicResource` 是原 `ReadSessionContext(topic, attachment)` 的唯一后继。

- 公开面：`contract.ts` 的工具名、输入输出 schema；`../handlers/read-topic-resource.ts` 的 ToolEntry。`reader.ts` 是内部实现。
- 输入 `{ inputId?, messageId, index? }`，与 Host 写入话题历史附件的资源索引一致；`index` 缺省为 0。输出 `{ status, path, fileName, mime, bytes, messageId, index }`。
- 授权只来自当前会话最近一条带 `botGroupSource` 的真实用户输入；传 `inputId` 时资源必须在该快照的资源索引里；Host 端口再按授权 ID 校验。模型不能指定其他会话。
- 副作用：经 Host 端口读取资源后写入会话保留期的托管二进制 artifact，所以不是只读；`sideEffectScope: "session"`，无需审批，超时 5 分钟。
- 注册：运行时注入 `topicResourcePort` 才注册，延迟曝光；不属于动态工作流灰度门；workflow actor 禁用。
- 错误：端口缺失、无授权、资源未索引、大小或编码不符都抛错，不回退到其他来源。
