# 01 — 高优先级配置层整体替换低优先级层的嵌套字段

Status: needs-triage

## 现象

`mergeConfigs` 在 `Object.assign(result, config)` 之后才展开嵌套字段，那时 `result.xxx` 已是本层的值，所以下层被整体替换，不是按键合并。只有 `plugins`、`hooks`，以及 skill 实时目录一起修复的 `skillOverrides`、`commandOverrides` 先保存了旧值。

受影响的字段：`permission`、`network`、`storage`、`features`、`memory`、`modelStream`、`logging`、`toolConcurrency`、`modelAnomalyGuard`、`ui`、`skills`。`mcp` 外层也被替换，`mcp.servers` 另由 `resolveEffectiveMcpServers` 决定。

例子（隔离 HOME 探针，宿主传 `mode: "yolo"`，环境变量设置代理与存储目录）：

| 用户配置                                                            | 现在的结果                              |
| ------------------------------------------------------------------- | --------------------------------------- |
| `permission.allowedTools`、`disallowedTools`、`autoApproveHighRisk` | 全部回到默认值，用户写的不生效          |
| `network.caCertFile`                                                | 设了 `ZCODE_HTTP_PROXY` 时被丢弃        |
| `storage.sessionDbPath`                                             | 设了 `ZCODE_STORAGE_DIR` 时回到默认路径 |
| `network.httpProxy`                                                 | 设了 `ZCODE_HTTP_TIMEOUT` 时被丢弃      |

Desktop 新建会话总会传 `mode`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` 的 `createWorkspaceZCodeApp` 调用），经 `createConfigCliOverrides` 变成 `cliOverrides.permission`，所以第一行影响所有 Desktop 会话。

## 证据

- 代码：`apps/zcode-cli/packages/adapters/src/config/config-merger.ts` 的 `mergeConfigs`。
- 探针：用户配置写上述字段，`createConfig` 带 `cliOverrides.permission.mode` 与 `ZCODE_HTTP_PROXY`、`ZCODE_STORAGE_DIR`；改为按键合并后，三项权限字段、`caCertFile`、`sessionDbPath` 全部开始生效。

## 影响

按键合并会改变产品行为，需要逐项决定：

- 权限：用户手写的 `autoApproveHighRisk: true` 与免审批列表开始在 Desktop 会话生效，是放宽权限；`disallowedTools` 开始生效，相应工具会被拒绝。
- 网络：失效的 `caCertFile` 路径开始被读取，可能让所有请求失败。
- 存储：beta、docker 环境下用户配置的 `sessionDbPath` 开始生效。
- 其余字段（`ui`、`logging` 等）按键合并是修复，例如 `--locale` 不再冲掉主题。

## 处理方向（未定）

逐个字段决定"按键合并"还是"高优先级层整体决定"，写进 `apps/zcode-cli/docs/design/v2/architecture.md` §1.4，再改 `mergeConfigs` 并补回归测试。`permission` 需要产品和安全一起确认宿主传 `mode` 时是否保留用户的权限列表。

## 来源

2026-11-11 skill 实时目录评审时发现。发布基线已存在，不是该分支引入；该分支只修复 `skillOverrides`、`commandOverrides`。
