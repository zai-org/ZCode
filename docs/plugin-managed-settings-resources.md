# Plugin 注册资源的设置页分组

ZCode 设置页中的 Skills、Commands、MCP Servers 会把本地配置资源和 plugin 注册资源分开展示。

Plugin item 的描述与辅助元数据统一使用 `text-ui-sm text-foreground-subtle`，与其他设置列表 item 保持一致。

## 分组规则

- 本地资源：来自工作区或用户配置目录，例如 `.zcode/skills`、`.zcode/commands`、用户/工作区 MCP 配置。
- Plugin 资源：来自已启用 plugin manifest 中声明的 `skills`、`commands`、`mcpServers`。
- Plugin 资源在对应设置页中只读展示，并提示“由插件注册，修改请到对应插件中进行”。
- manifest `skills` 数组项按 Claude 规范指向「技能目录本身」（项内直接是 `SKILL.md`），
  字符串形式指向「技能集合目录」；两种形态均可被发现（共享扫描规则见
  `docs/claude-marketplace-triplet-plugin-compat.md` 的 skills 字段语义一节）。
  显式声明的路径扫描为 0 个技能时，插件详情页「警告」区会展示
  `plugin_skill_root_empty` 诊断，不再静默。

## 数据来源

- Skills：`skillsService.list()` 返回 `scope: "plugin"` 的技能。
- Commands：`commandsService.list()` 返回 `source: "plugin"` 的命令。
- MCP Servers：设置页从 plugin 管理数据中的 `mcpServerNames` 生成普通 plugin MCP 只读列表；完整 MCP 配置仍由 agent runtime 在启动时从 plugin outcome 注入。
- 宿主内建 MCP（Browser Use / Computer Use 共用的 `node_repl`）不在设置页展示（2026-11-05）。Agent 不再投影 `hostMcpServerNames`，设置页也不读取它；协议 schema 只为兼容旧版 Agent 保留该可选字段。宿主 MCP 的运行时名称与注册方式不变，资源管理器仍按官方插件定义反查进程归属。
- Plugin MCP 列表需要按 runtime 注入名 `plugin:<pluginName>:<serverName>` 关联 `mcp/list` 返回的 live status snapshot。若 snapshot 带有 pending OAuth authorization URL，设置页在只读 plugin MCP 行展示“打开授权”按钮，点击后通过平台 `openExternal` 打开该 URL。
- Plugin MCP OAuth 授权完成后，设置页不能只依赖 pending authorization URL 是否仍存在来决定停止刷新。授权回调完成到 MCP 重新连通之间可能出现短暂无 `authorizationUrl` 的中间态；设置页需要保留短 follow-up 刷新窗口，并在用户从浏览器回到 app 时立即刷新一次，避免行状态停留在授权前。
- Plugin MCP 行需要显式展示 live snapshot 的 `connecting`、`connected`、`disconnected` 和 `error` 状态；“插件内置”只用于尚无 runtime snapshot 的已启用插件，不能覆盖真实运行态。
- Plugin MCP 行在窄窗口和手机 Web 下必须保留授权按钮的可操作性；较长 marketplace 名称允许截断，不能挤压主信息列或造成横向溢出。

## 维护边界

本地资源仍在对应管理页编辑、删除或开关。Plugin 资源的内容、命令根、MCP server 配置和启停入口属于插件本身；需要通过 Plugins 设置页或 plugin 源文件维护。

Plugin MCP 的 OAuth 授权按钮只打开当前 runtime 暴露的授权入口，不允许在设置页编辑 plugin MCP 配置、OAuth client secret 或 token。
