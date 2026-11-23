# 01 — 设置页挂载时传入的 workspace scope 被重置为 User

Status: needs-triage

## 现象

- 设置页的插件区和 MCP 区共用 `PluginsSection`。挂载时如果传入 workspace 的 `initialScopeKey`，兜底 effect 会立即把 scope 改回 `"user"`，并弹出"目标 workspace 不可用"的提示。
- 原因：workspace 列表异步加载，首次渲染时 `workspaceTabs` 为空，兜底 effect 判定选中的 workspace 不存在。

## 证据

- 兜底 effect：`packages/ui/src/settings/PluginsSection.tsx:1099-1113`。
- 初始值：`packages/ui/src/settings/PluginsSection.tsx:1005`。
- 插件区传入 `initialScopeKey`：`packages/ui/src/SettingsPage.tsx:2104`；MCP 区不传（`:2118`），所以 MCP 区每次进入都是 User。
- jsdom 探针（隔离 HOME，渲染真实 `PluginsSection(mode="mcp")`）：挂载时传入 workspace scope，首次渲染与加载完成后都是 `"user"`。

## 影响

- 插件区从市场返回、带着 workspace scope 进入时，可能被错误地切回 User 并提示不可用。需要在插件区复现确认。
- 以后若让 MCP 区默认进入当前会话的 workspace，必须先修这个问题。

## 处理方向（未定）

兜底判定只在 workspace 列表加载完成后执行，不在列表为空的首次渲染时执行。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
