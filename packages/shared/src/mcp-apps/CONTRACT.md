# mcp-apps-protocol

纯 domain 模块，零 IO。持有 MCP Apps 的 ZCode 扩展常量、工具 `_meta` 归一化结果、`display.ui` 投影 schema 与沙箱契约类型。页面 ↔ 宿主的线协议（`ui/*` 方法、握手、版本协商、JSON-RPC、错误码）由官方 `@modelcontextprotocol/ext-apps` 承担，本模块不再复制方法名或 schema。

类型与测试之外的不变量：

- `resourceUri` 来源按优先级：`_meta.ui.resourceUri` → 弃用扁平键 `_meta["ui/resourceUri"]`（规范 MUST 兼容）→ `openai/outputTemplate`；必须以 `ui://` 开头且不超过 2048 字符，否则整个 `ui` 描述视为不存在，而不是部分接受。
- `visibility` 缺省等于 `["model", "app"]`；不含 `"model"` 的工具不得进入 provider contracts；`readMcpToolVisibility(meta)` 独立于 resourceUri 读取。
- agent 对每个 MCP server 的 `initialize` 必须宣告 `extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]`（`buildMcpAppsClientCapabilities`），否则按官方模板写的 server 只会注册纯文本工具。
- ZCode 扩展能力一律放 `hostCapabilities.experimental["zcode/…"]`（widgetState、resourceSubscribe、surface、csp、nestedFrames），官方 SDK 的 zod 会剥掉标准位之外的未知键。
- `experimental["zcode/nestedFrames"]` 宣告插件文档内部的子 frame 导航不会被当作页面重载；旧宿主不宣告此键，嵌套预览的插件应据此降级。
- CSP 缺省按规范块；`'unsafe-eval'` / `'wasm-unsafe-eval'` 只在资源 `_meta["zcode/csp"]` 声明为 true 时放行，未知键与非布尔值丢弃。
- 沙箱句柄的 `shellUrl` 由 `sandboxId` 派生（`zcode-sandbox://shell-<id>/`）；`partition` 由 server 身份派生（`persist:plugin-sandbox-v1-<hash>`），同一 server 的页面共享持久存储，卡片关闭不清；`sandboxId` 只含 `[A-Za-z0-9-]`（CSP host-source 字符集）。
- 宿主 renderer ↔ relay shell 只有一条 MessageChannel（`PLUGIN_SANDBOX_PORT_NAME`），上面跑原始 JSON-RPC；shell 不解析协议。
- `widgetState` 是 ZCode 扩展：初值经 hostContext 的 `zcode/widgetState` 键随握手下发，页面经 `ui/set-widget-state { widgetState }` 交给宿主 renderer 内存保存（不持久化、无可见性参数；模型可见信息一律走 `ui/update-model-context`）。
- `_meta.ui.surface` 与清单 surface id 共用字符集 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`、≤ 128 字符，非法即丢弃。
- 页面发起的 `resources/read` 边界常量在这里：`MCP_APPS_UI_READ_RESOURCE_MAX_BYTES`（8 MiB）与 `MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST`（以 `/` 结尾为前缀匹配，忽略参数与大小写）；执行方是 agent 的 mcp-ui。
- 常见文档、图片、音视频、归档和字体按明确 MIME 条目接纳，不新增大类前缀；未知 MIME 与缺失 MIME 的 blob 仍拒绝。范围与回归要求见 [资源 MIME spec](../../../../docs/mcp-apps-resource-mime-spec.md)。

Gen UI 复用沙箱登记载荷，显式 `contentKind: "gen-ui"`，pluginId/serverName 留空且不允许权限声明；普通 MCP App 仍必须提供原来的插件与 server 归属。扩展视图（`docs/plugins/extension-host.md` §8）显式 `contentKind: "extension"`：只有它不属于会话，不填 `sessionId`（不伪造会话 id）、不填 serverName、不允许权限声明，必须带 pluginId；MCP App 与 Gen UI 的 `sessionId` 仍必填（类型上是判别联合，运行时由登记 schema 与 Main 注册表校验）。Gen UI 的页面业务 schema 独立位于 `@zcode/shared/gen-ui`。

页面资源 `_meta.ui.backgroundRetention` 仅接受布尔值，工具 metadata 不授予保留。归一化后通过沙箱登记和 resourceMeta 句柄传递；缺省 false，宿主执行窗口级 4/30 回收策略。
