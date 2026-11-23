# MCP 运行期边界

完整规格见 `docs/mcp-async-tool-catalog-cache.md`。

- adapter 拥有连接记录、目录和恢复任务，是连接与失败的唯一提交方；pool 只管理租约。配置源发布完整配置，同一进程内输入相同的会话共用一个配置源，每个会话持有一个可幂等释放的 view；session 拥有配置订阅与 reconcile，只从内存快照投影视图。缓存 publication 负责回写去重，不拥有连接。
- 授权失败（`oauth_authorization_failed`）的记录保留最后有效目录，下一次工具执行时重连；其他失败清空目录。
- 配置身份统一用 `mcpConfigKey`；可用性统一用 `classifyServer`。普通 step 固定工具与公告，ToolSearch 可实时读取。
- 配置加载器通过 `plugin-host-queries` 的私有配置入口读取插件选项，复用启动分层规则；共享 watcher 监听私有文件，保存与删除后重新发布配置。仓库选项不能进入 MCP 变量展开。
- 所有权由端口标记决定：借用端口固定范围，无生命周期权限，只等待自己需要的 pending server（`mcpServers` 与 `tools` 引用的 server 的并集）。
- 模型工具调用晚绑定当前 client，只在会话过期或连接关闭时重连并重试一次；MCP App 调用固定连接身份与 generation，不重试。
- 订阅意图只来自宿主上的 MCP App 实例；adapter 记录当前 client 上的远端确认，不在重连后重放旧订阅。
