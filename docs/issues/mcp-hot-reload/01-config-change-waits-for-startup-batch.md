# 01 — 会话的 MCP 启动连接未结束时，配置变更要排队等它结束

Status: needs-triage

## 现象

任务刚打开、MCP 启动连接还没结束时，用户修改 MCP 配置（例如新增一个 server），这个任务不会马上连接新 server。新配置要等启动连接全部结束（最慢的 server 连上，或等满 15 s）才开始生效。排队期间：

- 模型在这个任务里搜工具，搜不到新 server 的工具；
- 搜索结果也不提示新 server 正在连接，模型会以为它不存在。

启动连接结束后再改配置，会立即生效，不受影响。

## 时序（`desktop-e2e-20261105102132133-p44915-45ddc399ec796406`，macOS，负载约 33）

```
10:23:01.867  任务 B 创建，启动连接开始（官方 zcode-site 插件在高负载下很慢）
10:23:04.620  新配置（新增 shared09）送到任务 B 的配置 view
              → 会话 reconcile 调用 connectConfiguredServers
              → 工作区信任层的 mutate 队列：排在启动批次后面
10:23:05.719  任务 B 的 prompt；10:23:06.142 ToolSearch 返回
              "No matching deferred tools found. Some MCP servers are still connecting: plugin:zcode-site:sites"
              （没有 shared09）
10:23:07.255  zcode-site 连上，启动批次结束
10:23:07.346  任务 B 才开始连接 shared09
```

另一次（`desktop-e2e-20261105095819580-p47126-032d588975d5839a`）：启动批次里有一个一直卡住的 stdio server，任务 A 的配置变更正好等满 15.0 s（09:59:42.941 → 09:59:57.944）。

## 证据

- 排队点：`apps/zcode-cli/packages/bootstrap/src/workspace-mcp-trust/index.ts` 的 `mutate`。`connectConfiguredServers` 整个放在队列里，包括 `raw.connectConfiguredServers` 的握手等待；下一次变更要等上一次完全结束。
- 启动批次的等待上限：`apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` 的 `MCP_SESSION_OAUTH_WAIT_MS`（15 s），adapter 的 `waitForSharedConnection` 用它限制每个 server 的等待。
- 排队期间新 server 没有 pool lease，所以 `getToolSnapshot` 里没有它，ToolSearch 既不能把它列为 pending，也搜不到它的工具。
- 配置推送本身是准时的：两次运行里各 view 在 30 ms 内收到新快照。

## 影响

只影响“任务刚打开、MCP 还在连接”这段时间里修改配置的情况。官方插件或用户 server 连接慢时（高负载、网络慢、server 卡住），新增的 server 最多晚 15 s 才可用，期间模型看不到它。

## 处理方向（未定）

- 队列只保护准入判定段，握手放到队列外；或
- 新配置一到就先把新 server 登记为 connecting，让 ToolSearch 能列出它。

两者都要先列出队列的写入方、读取方和不变量（准入判定与连接的顺序、撤销与重连的竞态）。

## 来源

2026-11-05 在动态 MCP 分支复验 MCPW09 E2E 时发现。排队在 staging 上已存在；“在打开的任务里热更新配置”是该分支的动态 MCP 功能。取证时工作区还有一组 MCP 热更新改动（复用插件发现，随后撤回），它们没有改上面这些文件，所以分支提交 `57ab975e37` 上同样存在。MCPW09 改为等两个会话的启动连接都结束后再改配置（它测的是共享配置监听）；启动途中改配置的场景由本 issue 跟踪。
