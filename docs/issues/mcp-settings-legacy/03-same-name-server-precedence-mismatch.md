# 03 — 同名 MCP server 的优先级，设置页与 CLI 相反

Status: needs-triage

## 现象

- 设置页：同名 server 时 workspace 层优先于 user 层。
- CLI：MCP server 发现规则是 user 层覆盖 project 层（按名称整项替换）。
- 同名时，设置页显示的条目可能不是会话里实际运行的条目。

## 证据

- 设置页：`packages/ui/src/store/mcpStoreHelpers.ts:167-171`（`getServerPriority`）。
- CLI 启动路径：`apps/zcode-cli/packages/adapters/src/config/config-factory.ts` 的 `resolveEffectiveMcpServers`，注释写明 "user config shadows project config"。
- CLI 动态加载路径：`apps/zcode-cli/packages/adapters/src/mcp/config-loader.ts`，同样是 project 先、user 后。

## 影响

用户在设置页看到并修改的条目，可能不是会话实际连接的条目。

## 处理方向（未定）

先定一条全局规则，再让设置页和 CLI 共用这条规则（可以放在共享包的纯函数里）。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
