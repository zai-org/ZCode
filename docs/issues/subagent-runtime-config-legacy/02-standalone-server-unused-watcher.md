# 02 — Server / Web 模式下 Host 建了没人读的 subagent watcher

Status: needs-triage

## 现象

- `standalone-server` 模式下，Host 拉起 CLI 时仍会执行 `prepareRuntimeState`，建立 subagent 监听。
- 这时 workspace identity 是远程形态，CLI 不读取 Host 快照，这份监听没有消费者。

## 证据

- 只跳过 `desktop-attached-remote`：`packages/services/src/node.ts:2337`。
- Server Host 使用 `standalone-server`：`packages/services/src/node.ts:3242`。
- CLI 是否读取 Host 快照：`packages/services/src/zcode-agent/zcodeAgentService.ts:2510-2515`（远程 identity 时为 false）。
- 远程 identity 前缀：`packages/shared/src/remote-workspace-identity.ts:25`。

## 影响

Server / Web 模式多占监听资源和启动时的全量读取。（`standalone-server` 下 identity 一定是远程形态，是推断，需要确认。）

## 处理方向（未定）

`prepareRuntimeState` 与 `subagentRuntimeConfigEnabled` 用同一个判定。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
