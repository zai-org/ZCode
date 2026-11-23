# 02 — MCP 列表的 scope badge 在运行时不显示，与 spec 不一致

Status: needs-triage

## 现象

- spec 要求 MCP server 行在名称旁显示 User / Workspace scope badge。
- 运行时 MCP 列表传了 `hideMetadata`，badge 不渲染。
- 现有单测只检查源码文本，所以没有发现这个差异。

## 证据

- spec：`docs/settings-mcp-list.md:3-8`。
- 隐藏：`packages/ui/src/settings/McpSettingsSection.tsx:1518`、`packages/ui/src/settings/McpServerList.tsx:125`。
- 单测：`packages/ui/test/settingsMcpScopeBadge.test.ts`（源码文本断言，不是渲染断言）。
- jsdom 探针：User 和 Workspace 两个视图的行上 badge 都为空。

## 影响

用户看不出 server 来自哪一层配置。

## 处理方向（未定）

二选一：按 spec 显示 badge 并补渲染测试；或者更新 spec，写明 MCP 列表不显示 badge。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
