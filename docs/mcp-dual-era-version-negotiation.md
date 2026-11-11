# MCP Dual-Era 客户端版本协商规格

> 状态：已实现。
> 日期：2026-08-04。
> 协议依据：MCP `2026-07-28` Versioning and Compatibility、stdio/Streamable HTTP
> Backward Compatibility。

## 1. 目标

ZCode MCP client 同时支持两类 server：

- modern：MCP `2026-07-28` 及以后，使用逐请求 `_meta` 和 `server/discover`，不发送
  `initialize` / `initialized`；
- legacy：MCP `2025-11-25` 及以前，使用 `initialize` / `initialized` 握手。

普通 MCP server 默认由 client 自动识别 era；内置 `node_repl` 固定使用 modern
`2026-07-28`，保持 per-call execution stateless 和 workspace-scoped process sharing。

## 2. 配置语义

```ts
protocolVersion?: "legacy" | "auto" | "2026-07-28";
```

| 配置                                        | client 行为                                                                  | 用途                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 未配置，`stdio` / `http`                    | 等价于 `auto`                                                                | 普通第三方 MCP，自动兼容两个 era       |
| `auto`                                      | 先探测 modern；只有确定为 legacy 才回退 `initialize`                         | 显式声明 dual-era                      |
| `legacy`                                    | 不发送 modern probe，直接走旧握手                                            | 已知旧 server、避免 stdio sibling      |
| `2026-07-28`                                | pin modern；server 不支持时失败，不允许回退                                  | 内置无状态 `node_repl`                 |
| 未配置或任意非 modern 配置，`sse` transport | 直接走 legacy；旧 HTTP+SSE transport 不承载 MCP `2026-07-28` per-request era | 已经显式选中的 deprecated SSE endpoint |

内置 server 固定配置：

- `node_repl`：`protocolVersion="2026-07-28"`、`isolation="workspace"`；每次 `js` 使用一次性 worker/kernel；
- 不再注册独立的内置 `browser_use` server。

版本协商只决定 wire era，不改变 process sharing。普通第三方 MCP 即使协商到 modern，也继续使用
默认 session isolation；只有内置 `node_repl` 显式选择 workspace isolation。

配置文件入口必须接受并原样保留上述三个 `protocolVersion` 枚举值，覆盖 stdio/http/sse；省略时不注入默认值。
非法枚举值或未知字段仍按单个 server 记录 diagnostics 并跳过，不影响其他 server 或插件配置。

## 3. 连接时序

```text
普通 stdio/http server（protocolVersion 未配置或 auto）
        |
        v
server/discover + preferred modern version
        |
        +-- DiscoverResult ----------------------> modern
        |                                           |
        |                                           `-- 每个请求携带 modern _meta
        |
        +-- recognized modern error -------------> modern
        |    例如 UnsupportedProtocolVersion         |
        |                                           `-- 按 supported version 修正；不 initialize
        |
        `-- legacy evidence ----------------------> legacy
             stdio: 非 modern error / 合理超时         |
             HTTP: 4xx 且 body 非 modern error         `-- initialize -> initialized

内置 node_repl
        |
        v
pin 2026-07-28 -> server/discover
        |
        +-- 支持 2026-07-28 -> modern / stateless
        `-- 不支持或无法确认 ----> 连接失败；禁止 legacy fallback
```

stdio 的 `auto` / pin probe 由 MCP TypeScript SDK 在 disposable sibling process 中执行。ZCode
必须给 probe 设置有界预算：不超过 5 秒，且不超过 server 总连接预算的一半；剩余预算用于 legacy
server 的真实 session child 启动和 `initialize`。总连接超时仍由现有 `timeoutMs` 控制。

HTTP probe 超时表示网络故障，不能据此把 server 判断为 legacy；SDK 应返回连接失败。只有收到符合规范的
legacy HTTP 响应才允许回退。

## 4. 状态和缓存边界

- 当前连接协商结果通过 `McpServerStatus.protocolEra` 暴露为 `modern` / `legacy`，仅用于诊断和
  control-plane 展示，不作为 tool catalog readiness 的替代事实。
- 每次成功连接的生产日志事件 `mcp.server.connected` 必须同时记录：
  - `mcpClientName` / `mcpClientVersion`：发送给 server 的 MCP client identity；
  - `mcpVersionNegotiationMode`：配置实际采用的 `auto` / `legacy` / `2026-07-28` 策略；
  - `mcpProtocolEra` / `mcpProtocolVersion`：SDK 握手完成后的实际协商结果。
  - `mcpConnectionId` / `mcpIsolation` / `workspaceKey`：连接池中的稳定连接标识、隔离范围和
    workspace 身份；session isolation 连接还必须记录 `sessionId`。
  - `mcpTransportPid`：stdio 最终会话 transport 的直接子进程 PID；HTTP/SSE 不记录该字段。
- 配置策略不是协商结果；排障时必须以 `mcpProtocolVersion` 为准。
- 连接归属和 session 租约必须分开记录。`mcp.pool.lease.acquired` /
  `mcp.pool.lease.released` 使用相同 `mcpConnectionId`，并记录 `sessionId`、`workspaceKey`、
  `mcpIsolation` 和 `refCount`。workspace isolation 的共享连接不得在
  `mcp.server.connected` 上伪造唯一 `sessionId`；应通过 lease 事件表达多 session 共享关系。
- `mcp.pool.connection.created` 和 `mcp.server.closed` 必须携带同一个 `mcpConnectionId`，使日志可以
  沿 `sessionId -> lease -> connection -> stdio PID` 追踪创建、复用与回收。
- 一个 client connection 的 era 在 connect 完成后不可切换；重连重新协商。
- probe 协商失败（`SdkError(EraNegotiationFailed)` / `UnsupportedProtocolVersionError`）在
  `McpServerStatus.failureKind` 上映射为 `protocol_negotiation_failed`（adapter 按结构化错误类型
  识别，不匹配错误文本）；settings UI 据此展示"将协议版本切换为「兼容旧版」"的失败引导，而不是
  误导性的"网络不可达"。协议版本可在 MCP server 编辑表单（`protocolVersion` 下拉，sse 形态隐藏）
  或 JSON 配置中手工设置。
- ZCode 不新增跨 session 的 era 持久化。SDK/transport 内部可缓存当前连接结果，但不得把一个 server 的
  结果复用于不同 server config、workspace identity 或 remote runtime。
- desktop `desktop-continuous` 与 mobile `web-remote-replayable` 只承载既有 session/tool 事件；版本协商
  不进入 relay、snapshot、queue 或 owner state。

## 5. 失败与安全规则

1. 不得把所有 JSON-RPC error 都视为 legacy。`UnsupportedProtocolVersionError` 等 recognized modern
   error 证明 server 属于 modern，client 只能修正版本或失败。
2. stdio legacy 判定不得绑定单一错误码；旧 server 可能返回 `-32601`、`-32602`、关闭 probe child
   或在合理时限内无响应。
3. `protocolVersion="2026-07-28"` 是严格 pin，不得为了“可用”静默降级；这保证共享 `node_repl`
   不会退回 legacy 持久 session/kernel 语义。
4. `protocolVersion="legacy"` 必须保持 byte-compatible 旧握手，不新增 modern header 或 `_meta`。
5. Browser Use 的 broker token、session registry 和 workspace identity 校验不受协商结果影响；modern
   `_meta` 只提供宿主路由上下文，不能脱离私有 child/broker 与 `requireSession` 单独成为授权事实。

## 6. 验收用例

| ID    | 配置/Server                      | 期望                                                                                                           |
| ----- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| MVN01 | 普通 stdio，未配置版本，modern   | 默认 `auto`，协商 `modern`，不发送 legacy initialize                                                           |
| MVN02 | 普通 stdio，未配置版本，legacy   | sibling probe 判定 legacy，真实 child 完成 initialize，工具可用                                                |
| MVN03 | 普通 Streamable HTTP，未配置版本 | 默认 `auto`；recognized modern error 不降级，legacy response 才降级                                            |
| MVN04 | 任意 transport，显式 `legacy`    | 不 probe，保持旧 initialize 行为                                                                               |
| MVN05 | 内置 `node_repl`                 | pin `2026-07-28`、`protocolEra=modern`，server 不支持时连接失败；workspace 可共享连接                          |
| MVN06 | 显式 legacy / `sse`              | 固定 legacy，不产生 disposable modern probe                                                                    |
| MVN07 | auto stdio server 不响应 probe   | probe 在有界预算内结束；fallback/总连接超时后无残留 sibling process 或其派生进程                               |
| MVN08 | 任意 server 成功连接             | `mcp.server.connected` 同时包含 client identity、协商策略、实际 era 和精确协议版本                             |
| MVN09 | session/workspace isolation 连接 | 连接、lease 与关闭日志可用 `mcpConnectionId` 关联；stdio 连接记录 PID，共享连接通过多条 lease 日志关联 session |

focused adapter/process tests 证明协商与清理；Browser Use bundle smoke test 继续证明真实 modern stdio
server。该变更不改变 conversation UI/product state，不新增 conversation E2E 状态组合。

另增 Desktop 真实进程 E2E `packages/desktop/test/e2e/settings/mcp/mcp-dual-era-version-negotiation.test.ts`，
用隔离 HOME 中的真实 CLI 配置启动 modern/legacy stdio fixture，并从 worker 专属
`ZCODE_LOG_DIR` 读取 `mcp.server.connected` JSONL。这条 E2E 必须同时锁定：

- modern fixture 实际协商 `2026-07-28`，无 legacy `initialize`；
- legacy fixture 经 disposable probe 后由真实 session child 完成 `initialize`；
- 配置文件显式指定 `legacy` 的独立 fixture 被保留，日志策略为 `legacy`，wire 只有旧握手、没有 `server/discover`；
- 日志中的配置策略、era 和精确协议版本与 fixture wire 记录一致；
- probe child 退出后，每个 active consumer 只保留自己的真正会话进程；Desktop 同时存在 settings 与
  draft/session consumer 时，E2E 通过 wire 中缺少 `tools/list` 的存活 PID 识别残留 probe，不再把
  fixture 的全局存活进程数错误限定为 1。

该用例不发送 provider 请求；真实性来自 Electron -> Local Host -> ZCode Agent -> MCP
client -> stdio server 的完整产品进程链。
