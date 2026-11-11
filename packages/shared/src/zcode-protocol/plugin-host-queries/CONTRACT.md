# plugin-host-queries

扩展进程 P2 需要 CLI 提供的插件宿主能力：敏感设置值的私有存储、App 读取本插件设置值的查询，以及输入框 `@` 面板的 MCP 工具候选项。完整规格见 `apps/zcode-cli/docs/design/v2/plugin-compat.md`「Sensitive Option Storage」「Composer Mention Items」。

本模块由几处组成：

- 本目录 `contract.ts`：App ↔ CLI 线格式（严格 schema）与稳定错误码。
- CLI `adapters/src/config/plugin-secrets.adapter.ts`：私有文件 `plugin-secrets.json` 的读写、锁、损坏备份与纯数据变换。
- CLI `bootstrap/src/plugin-secrets.ts`：读取时按配置层叠加、保存时分流与迁移、重置与卸载的清理规则。
- CLI `bootstrap/src/zcode-protocol/plugin-user-options.ts`：`plugins/readUserOptions` 处理。
- CLI `bootstrap/src/zcode-protocol/plugin-mention-items.ts`：`plugins/mentionItems` 处理（会话现有的 MCP 连接，结果按严格 schema 校验）。
- `packages/services/src/zcode-agent/pluginHostQueriesClient.ts`：App 侧客户端；旧 CLI 的 method-not-found 变成 `{ supported: false }`。`getPluginMentionItems` 是 `IZCodeAgentService` 的可选方法；`readPluginUserOptions` 不在任何服务对象上，只经 `packages/services/src/node.ts` 的 `getPluginUserOptionsReader(services)` 在 Window Host 进程内取得。

不变量：

- 一份有效值：运行时 MCP 展开、`plugins/list` 投影、`plugins/readUserOptions` 读的是同一次叠加结果；每个 scope 内私有文件优先，scope 优先级不变。
- 值不外泄：日志、诊断、错误信息只含插件 id、键名与文件路径；`plugins/list` 继续过滤敏感值；含敏感值的读取器不进任何 RPC 频道（结构上不可达，不靠黑名单剥离）。
- 不在启动时迁移：只读路径从不写 `config.json` 或私有文件；迁移只发生在保存时。
- 写入顺序：先私有文件，后 `config.json`；中途失败时两处都有值，读取以私有文件为准。
- 候选项只在内存里的会话上取：不启动、不恢复会话；工具调用走与 `mcp/uiCallTool` 相同的授权链（hook、权限规则、审批），拒绝映射为 `plugin_mention_tool_denied`；错误只带稳定码与插件、server、工具名，不带 query、拒绝原因与工具返回的内容。
- 旧 CLI 返回 method-not-found，App 当作「不支持」。
- 演进：线格式是 strict；新增字段会让旧 App 解析失败，必须另起方法或能力位。
