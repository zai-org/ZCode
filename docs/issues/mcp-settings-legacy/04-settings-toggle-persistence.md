# 04 — 设置页 MCP 开关的持久化与显示状态不可靠

Status: needs-triage

## 现象

1. 写盘失败只记 warn，开关照样翻转。界面显示已停用，磁盘上仍是启用。
2. 内存里的 `enabledStates` 优先于磁盘值。其他进程或手工修改配置后，界面仍显示旧状态。
3. 编辑一个已停用的 server 并保存时，写入的是旧字段 `enable: false`，不是 `enabled: false`。

## 证据

1. `packages/ui/src/store/mcpStore.ts:413`（`persist MCP enabled override failed` 之后仍更新 `enabledStates`）。
2. `packages/ui/src/store/mcpStoreHelpers.ts:123`。
3. `packages/ui/src/settings/McpSettingsSection.tsx:1291`。

## 影响

开关状态与实际配置不一致，用户以为已经停用的 server 仍在运行，或者反过来。

## 处理方向（未定）

- 写盘成功后再翻转开关，失败时提示用户。
- 显示状态以磁盘为唯一数据源。
- 保存时统一写 `enabled` 字段。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
