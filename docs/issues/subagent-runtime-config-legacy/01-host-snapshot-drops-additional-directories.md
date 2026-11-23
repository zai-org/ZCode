# 01 — 桌面 Host 的 subagent 快照不包含附加目录下的 agent

Status: needs-triage

## 现象

- 桌面本地会话使用 Host 的 subagent 快照时，只读取 `<workspace>/.zcode/agents`。
- CLI 自己扫描时（远程、Web、独立 CLI）还会读取 `additionalDirectories` 下的 agent。
- 同一份配置，桌面本地会话少了附加目录里的 agent。

## 证据

- Host：`packages/services/src/subagents/subagentRuntimeConfig.ts:200`。
- CLI 扫描：`apps/zcode-cli/packages/bootstrap/src/subagents.ts:60`。

## 影响

用户放在附加目录里的自定义 subagent，在桌面本地会话中不可用。

## 处理方向（未定）

Host 快照按会话的附加目录补充扫描；或者在 subagent 改由 CLI 统一监听时一起解决。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
