# 05 — CLI MCP spec 与代码不一致

Status: needs-triage

## 现象

1. spec 写同名 `mcp.servers` 按来源顺序深合并，project 可以用 `enabled: false` 停用继承来的 server。代码是按名称整项替换，user 层覆盖 project 层；project 层只写 `{ enabled: false }` 时缺少 `type`，条目校验失败被丢弃。
2. spec 写 `/mcp disconnect` 会把 server 的工具从以后的会话中移除。代码中断开只在当前 app 的运行时有效，不落盘。

## 证据

1. `apps/zcode-cli/docs/design/v2/mcp.md:152`；代码见 `apps/zcode-cli/packages/adapters/src/config/config-factory.ts` 的 `resolveEffectiveMcpServers`。隔离 HOME 探针：user 有完整的 foo，project 只写 `{enabled:false}` → 条目被丢弃，foo 仍启用；project 写完整条目加 `enabled:false` → user 层胜出，foo 仍启用。
2. `apps/zcode-cli/docs/design/v2/mcp.md:256`；代码见 `apps/zcode-cli/packages/adapters/src/mcp/index.ts` 的 `disconnectServer`。

## 影响

按 spec 写配置的用户无法停用继承来的 server。

## 处理方向（未定）

按实际行为更新 spec，或者按 spec 实现。和 [03](./03-same-name-server-precedence-mismatch.md) 一起决定。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
