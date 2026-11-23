# 06 — 启动路径在安装事务进行中把 backup 当作插件执行根

Status: needs-triage

## 现象

- 插件安装事务进行中（writer 仍存活）启动会话时，启动路径的插件发现会读取 backup 目录，并把它作为插件执行根（如 `ZCODE_PLUGIN_ROOT` 指向 `.inflight.backup`）。
- 动态 MCP 加载器在同一状态下不发布这个插件。两条路径结论不同。

## 证据

- 启动路径：`apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:754`、`:782` 调用 `recoverAtomicTargetSync`（`apps/zcode-cli/packages/adapters/src/plugins/atomic-directory.ts:177`）。发布基线的注释说明这是有意的"读取已提交的一代"。
- spec：`docs/mcp-async-tool-catalog-cache.md:31` 要求"事务中可从 backup 识别已提交来源，但不发布 backup 执行路径"。
- 隔离 HOME 探针：启动路径得到 `ZCODE_PLUGIN_ROOT=.inflight.backup`，动态加载器得到空结果。

## 影响

安装进行中启动的会话，插件在 backup 目录里运行；事务提交后 backup 被删除，执行路径可能失效（推断，未复现）。

## 处理方向（未定）

在插件加载异步化时一起定规则。修复会同时影响 skills 和 hooks。

## 来源

2026-10-26 动态 MCP 分支评审时发现。发布基线 `2a04205f08` 已存在，不是该分支引入；该分支不修复。
