# 会话能力归因 Header：`x-zcode-session-features`

## 背景

线上统计需要按"会话用过哪些能力"筛选模型请求，例如只看用过动态工作流的会话。现有归因头
回答的是别的问题：

| Header                 | 回答的问题               | 取值                       |
| ---------------------- | ------------------------ | -------------------------- |
| `x-zcode-session-type` | 请求属于哪类会话         | 4 个固定值，服务端已在使用 |
| `x-zcode-query-source` | 本次请求由哪个调用点发出 | 单值、互斥                 |

"用过哪些能力"是多值的，并且随会话推进而累积，上面两个头都表达不了。没有专门的头时，统计方只能
扫描请求体文本。请求体在长上下文时会被截断或置空，扫描既慢又漏。

## 目标

- 所有会话内的出站模型请求都发送 `x-zcode-session-features`，值为本会话**至今**用过的能力标签。
- 标签只增不减：compact、rewind、冷恢复都不撤销已有标签。
- 每个 session 只报自己用过的能力。子 agent、workflow 子 actor 是独立 session，出生时没有标签，
  也不继承父会话的标签。
- 所有能力标签共用一个头和一份词表，后续新增能力只追加标签，不新增头。
- 与其他归因头相同：只用于统计、诊断与审计，不作为鉴权、计费、限流或业务路由依据。

## 非目标

- 不修改 provider 静态配置里的 headers。
- 不在 header 里放代码、路径、工具参数等内容，只放固定的标签名。
- 不把子会话的标签上卷到父会话。统计方按 `x-zcode-trace-id` 自行聚合。

## Header 格式

- 值是逗号分隔的标签，按字典序排列、去重，例如 `workflow_auto,workflow_cmd`。
- 每个标签匹配 `^[a-z0-9_]{1,64}$`，整个值不超过 256 个字符。
- 本会话没有标签时不发送该头。值不合法时整头省略，不回退到 provider 静态配置里的同名 header。
- provider 静态配置里的同名 header（不区分大小写）一律剔除，归因值不能被静态配置覆盖。
- 工作区独立请求（`scope: "workspace"`，例如 git commit message、连接测试）不发送该头：
  这类请求会借用同一工作区里某个会话的 runtime，带上标签会把那个会话的能力串到无关请求上。

## 标签词表

词表定义在 `contracts/src/model/invocation-context.ts` 的 `ModelRequestSessionFeature`。规则：

- 标签名是小写 snake_case，含义一旦发布不再修改。
- 只追加，不改名；废弃的标签保留常量，不复用它的名字。

| 标签                 | 何时打上                                                                                                                                                                                                                                                                                                   | 冷恢复时能否从历史推出                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow_cmd`       | 用户输入的内置 `/workflow` 命令被展开为工作流模板。灰度关闭、命令未展开时不打                                                                                                                                                                                                                              | 能：用户消息原文以 `/workflow` 开头                                                                                                                    |
| `workflow_auto`      | 模型调用 `CreateWorkflow` 成功启动了后台 run（工具输出 `status: "backgrounded"`）。编译失败、宿主没有 run 端口时不打。GUI 直接启动已保存的工作流不是模型调用，不打                                                                                                                                         | 能：`CreateWorkflow` 工具结果的 display 为 `create_workflow` 且 `ok: true`                                                                             |
| `workflow_auto_attempt` | 模型调用 `CreateWorkflow` 且这次调用有了结算结果，不论成败：成功启动、编译失败、没有 run 端口、参数校验失败、handler 抛错都打。错误类型为 `permission_denied`（权限确认时拒绝、hook 或规则拦截）或 `tool_not_found`（本会话没有注册该工具）时不打。GUI 直接启动不打（见下文） | 部分能：`CreateWorkflow` 工具 part 状态为 `completed`；`error` 状态的 part 分不出权限拒绝，只靠 entry（见下文） |
| `tool_search_native` | 主循环请求的 ToolSearch **实际生效**模式为 native。取请求准备结果 `prepared.toolSearch`（`enabled` 为真且 `mode` 为 `native`），不取设置值：设置为 `auto` 时按 Model 解析成 native 或 local；没有 deferred 工具或缺少控制工具时实际关闭，不打                                                              | 不能，只靠 entry（见下文）                                                                                                                             |
| `tool_search_local`  | 同上，实际生效模式为 local                                                                                                                                                                                                                                                                                 | 不能，只靠 entry                                                                                                                                       |
| `tool_search_called` | 模型调用 ToolSearch 且执行成功。local 模式下模型看到的名字是 `LocalToolSearch`，执行器统一换成规范名 `ToolSearch`；判断用 `isToolSearchName`。没有匹配结果（`No matching deferred tools found`）也算成功调用。执行失败（例如请求未启用 ToolSearch）不打                                                    | 能：assistant 的工具 part 名满足 `isToolSearchName` 且状态为 `completed`。pending/running 阶段写的是原始名，completed 阶段写的是规范名，两种写法都覆盖 |
| `browser_use`        | 模型代码经 node_repl 调用了浏览器运行时：`list` 或 `execute` 请求到达 node-repl-host 主线程的浏览器代理 broker 就打，不论结果成功还是失败。模型只在代码里提到、代码没执行到调用时不打；请求在 Worker 里就被拒绝、没有到达 broker 时也不打（见下文）                                                        | 不能，只靠 entry（见下文）                                                                                                                             |
| `computer_use`       | 模型代码经 node_repl 调用了任一 CUA API：请求到达主线程的 CUA broker 就打，不论成败，在 broker 侧被拒绝也打；只做引导、在 Worker 线程里被拒绝时不打（见下文）。旧版 MCP 工具只认通过官方 CUA 认证注册工具（registry entry 的 `permissionCapabilityGroup` 为 `official_cua`），有结算结果就打，同样不论成败 | 不能，只靠 entry（见下文）                                                                                                                             |
| `site_deploy`        | 官方命令端点收到本会话的 `POST /api/v1/sites/{siteId}/deployments` 就打，不看结果：没有登录身份、上游不可达、非 2xx 都打。其他方法和路径不打（见下文） | 不能，只靠 entry |

`workflow_auto` 只表示事实"CreateWorkflow 成功过"，不排除 `/workflow`。用户先输入 `/workflow`、
模型再调用 CreateWorkflow 时两个标签同时出现。"由模型自行发起"这类口径由统计方组合得出。

CreateWorkflow 尝试口径的补充规则：

- 为什么新增标签：`workflow_auto` 是"成功启动"口径，调用了 CreateWorkflow 但每次都编译失败、校验失败或
  抛错的会话不会被统计方选中，样本里的失败率就会偏低（与 BUA/CUA 改用"真实尝试"口径的理由相同）。
  已发布标签的含义不能改，所以新增 `workflow_auto_attempt`，`workflow_auto` 保持不变。成功启动时两个标签
  同时出现，`workflow_auto_attempt` 是 `workflow_auto` 的超集。
- 打点在工具结果结算时（`settleToolResults`），与 `workflow_auto` 同一入口，从下一次请求起带上。参数校验、
  `resolveInput`（技能门、读盘）、hook 改写后的校验、权限判定都在 executor 内早退，返回的失败结果同样经过
  结算，不另接打点。
- 排除 `permission_denied`：能力没有真正用上。结果层面只保留错误类型，分不出拒绝来自谁，所以下面几种
  一并排除：用户在确认窗拒绝或 Refine；PreToolUse hook 拦截、PermissionRequest hook 应答 deny；
  disallowedTools、项目 deny 规则、auto 模式；非 guarded 模式下 broker 抛出非 CoreError
  （`permission-flow.ts` 包成 `Permission request failed`）。
- 计入的权限阶段失败：guarded 模式下 broker 失败（`tool_execution_failed`、`permission_timeout`、
  `configuration_error`）、broker 超时（`permission_timeout`），以及等待确认或执行前用户停止
  （`tool_cancelled`）。模型确实发起了调用，统计方可从完整日志里区分。plan mode 不拦截 CreateWorkflow：
  它声明了 `alwaysAsk`，任何模式下都弹窗确认，与普通模式相同。
- 排除 `tool_not_found`：workflow 子 actor 结构性禁用 CreateWorkflow，灰度关闭或按需激活之前也不注册；
  模型凭空调用时结果的工具名仍是 `CreateWorkflow`，不排除会把这些会话误标。`DeferredToolCall` 包装调用
  在准入阶段失败时结果保留包装名，本来就不命中。
- GUI 直接启动已保存的工作流不经过结算：它只写一条带 `workflowLaunch` 元数据的 user 消息，并用合成的
  描述子登记后台任务，不写 CreateWorkflow 工具 part，所以两个标签都不打，历史推导也不命中。
- 历史推导只认 `completed` 的 CreateWorkflow 工具 part（成功启动、没有 run 端口、编译失败都落成
  `completed`），不看 display。`error` 状态的 part 只保存自由文本 `error` 与 `metadata.modelContent`，不保存
  错误类型；用户的拒绝反馈和 hook 的 reason 都是任意文本，分不出权限拒绝，所以不采用，只靠 entry。
  影响有限：只有 entry 缺失（读写失败、fork 子会话、升级前的会话）并且每次尝试都以 `error` 结束的会话才
  少带标签。pending/running 的 part 没有结算结果，不命中。

ToolSearch 标签的补充规则：

- 模式标签只打在主循环请求上，也就是 `turn-loop` 发出的 main_turn / subagent / workflow_child 请求。
  compact、目标完成校验、Memory 也调用 `prepareRuntimeProviderRequest`，但不打标签。compact 请求即使
  带着 ToolSearch 定义，也只用于摘要、不执行工具。打点在调用方 `turn-loop` 里做，请求准备环节本身仍不写
  任何状态（`docs/design/v2/tool/19-tool-search.md`「独立请求准备环节」）。
- 模式标签在请求准备之后、模型调用之前打，所以本次请求就带上。`tool_search_called` 在工具结果结算时打，
  从下一次请求起带上。
- 模式在新建和冷恢复时按最新设置固定，同一会话前后可能用过两种模式，这时 `tool_search_native` 和
  `tool_search_local` 同时出现。
- 模式标签推不出历史：公告 metadata `toolSearchAnnouncement` 与模式无关，模式只影响渲染出来的文案；
  ToolSearch 结果在两种模式下都以同样的 `tool_reference` 数组落盘（`state.metadata.modelContent`），
  local 在请求投影时才展开成文本。local 虽然在经
  `DeferredToolCall` 调用的工具 part 上留下 `modelCallWrapper`，但只覆盖实际包装调用过的会话，
  与 native 不对称，所以不采用。影响有限：每个新 turn 都会在首个请求前按当时的生效模式重新打标签，
  只有 entry 缺失时才丢掉冷恢复之前的模式。

BUA/CUA 标签的补充规则：

- 口径是"真实尝试"，不是"成功"。标签决定统计方把哪些会话归入 BUA/CUA 类别，统计方再从完整日志里算
  成功率。如果只给成功的会话打标签，调用全部失败的会话（没有权限、找不到应用、没连上浏览器）不会被
  选中，样本里的失败率就会偏低。所以只要请求到达主线程 broker 就打，结果是 `ok: false`、`isError`、
  抛错都不影响；整个工具结果是否 `isError` 也不看：一个 cell 可能先调用成功、后面的代码再出错。
- node_repl 在 `node-repl-host` 子进程里执行，core 只能从工具结果的 `_meta` 得知调用过运行时。两个 key
  由 node_repl 调用账本产出（`docs/design/v2/tool/20-node-repl-call-ledger.md`），与 `zcode/nodeReplCuaApp`、
  截图下标同一来源：
  - 浏览器代理 broker 收到带本次调用 token 的 `list` / `execute` 请求时记 `facts.browserUse`。记在检查
    上游和转发之前，所以上游报错、命令 `ok: false` 也算。
  - CUA broker 收到带本次调用 token 的请求时记 `facts.computerUse`。记在校验请求格式和 subagent 检查之前，
    所以 broker 侧的拒绝、runtime 抛错、结果 `isError` 都算。
  - token 无效（伪造、过期、调用已结束）的请求不记。
  - `toMcpRunResult` 先删除 `_meta` 里的同名 key（模型可以经 `nodeRepl.setResponseMeta`、
    `nodeRepl.emitStructuredResult` 或内嵌的 `_meta` 写入），再只根据账本的 facts 写回
    `zcode/nodeReplBrowserUse: true` / `zcode/nodeReplComputerUse: true`。Worker 发来的结果消息只当作内容，
    cell 经 `require("node:worker_threads").parentPort.postMessage(...)` 冒充结果也写不出这两个 key
    （MR !3207 评审 CR-01）。
  - core 只在工具名为 `mcp__node_repl__js` 时读这两个 key。第三方 MCP 也能在自己的结果里写同名 key，
    不能采信。
- 已知缺口（与账本相同）：cell 可以经 `node:inspector` 连到 node-repl-host 主线程执行代码，改动账本或结果
  组装（20-node-repl-call-ledger.md「可信边界」）。这两个 key 同样受影响，在这条缺口堵住之前，不能当作
  对 cell 的强保证。受影响的只是统计信号，触发需要刻意编写这类代码。
- 只在 broker 侧记账，换来的是 key 不能经冒充 Worker 结果伪造；代价是请求在 Worker 里就被拒绝、没有
  到达 broker 的尝试不再计入：
  - 只执行了 `setupComputerUseRuntime` 引导、一次 CUA 方法都没调的 cell：SDK 引导时只调用 Worker 侧
    bridge 的 `assertAvailable`，不发请求。
  - subagent 里的 CUA 尝试：Worker 侧 bridge 在引导和每次方法调用前检查 `runtime_scope`，发现是 subagent
    就直接报 `Computer Use is not available in subagent`。broker 侧的同名检查只兜住绕过 bridge、直接连
    socket 的请求，这类请求计入。
  - node-repl-host 没有拿到 CUA Helper 凭据，或 ZCode 没有配置浏览器上游时：Worker 里没有 broker 地址，
    bridge 直接报不可用。
  - kernel 重置后旧 cell 的调用：bridge 报 binding stale，不发请求。
- 已知边界：超时、崩溃、停止时不产出可信 key。记账在 broker 侧，超时之前已到达 broker 的请求也已记进
  账本；但 cell 超过 `timeout_ms`（默认 60s，上限 120s）或 Worker 提前退出时，`tools/call` 以 MCP 协议错误
  结束（例如 `The operation was aborted due to timeout`、`node_repl worker exited before returning a result`），
  不经过 `toMcpRunResult`，账本条目随调用结束关闭，facts 不进入任何结果；用户停止时 core 直接取消本次
  调用。core 给 node_repl 的超时是 600s（`bootstrap/src/app/built-in-node-repl.ts`），所以超时都发生在宿主侧。
  标签是会话级的，只有"每个调用过运行时的 cell 都以超时、崩溃或停止结束"的会话会漏掉，例如 CUA Helper
  一直起不来。统计方可以用不依赖本标签的随机样本估计这类会话的占比。补上的方案是让超时、崩溃返回带
  facts 的 `isError` 结果；这会改变所有 node_repl 超时时模型看到的内容（现在只有一行错误，超时前的日志也
  会丢失），另开 MR 评估。
- 不复用现有的 `zcode/browserUse`：它在浏览器后端返回 meta 时就写，命令失败也会写，而且是 Browser Use
  meta 契约的一部分（`docs/browser-use/2026-07-10-browser-use-spec.md`），含义不随本规则改变。
- 到达浏览器代理的调用全部来自模型代码，包括 `browser.finalize()`、`nameSession()` 这类 SDK 方法；
  closeSession、turnEnded 等生命周期命令由宿主经 `browserControlPort` 发出，不经过 Worker 里的 bridge 和
  代理。所以 `list` 和 `execute` 收到请求就打，不设排除列表。
- node_repl 路径推不出历史：工具 part 落盘时只保存 `display`、`serialization` 等，不保存 `_meta`；
  node_repl 的 display 里也没有浏览器标记。CUA 的 display 带目标应用 `app` 字段，但 `list_apps`、
  `request_access` 没有这个字段，只能推出一部分，所以不采用。不用 `code` 字段做字符串推导：模型只在
  注释里提到、代码没执行到调用时也会命中。影响有限：只有 entry 缺失时（读写失败、fork 子会话）才少带
  标签，会话再次调用运行时就会补上。
- 旧版 computer-use MCP 工具只认官方 CUA 认证：registry entry 的 `permissionCapabilityGroup` 为
  `official_cua`，这个值只在不可伪造的官方 authority 门成立时由 `core/src/mcp/index.ts` 写入。不按工具名
  前缀判断：2026-09-18 起官方 CUA 已改走 node_repl，插件不再声明 MCP server，名字带
  `mcp__computer-use__` / `mcp__computer_use__` 的工具多半来自第三方同名 server。落盘的工具 part 不带认证
  信息，所以这条路径同样推不出历史，只靠 entry。

Sites 部署标签的补充规则：

- 在官方命令端点打（`docs/design/v2/official-command-endpoint.md`）。`zcode-site` CLI 不持有凭证，Sites 接口都经过
  这个端点，端点按 session token 认出会话。只看是否调用了创建部署的接口，不看结果。
- 端点收到请求时先回调该 session 的 observer，再取身份、转发，所以 Bash 结束之前标签已经在内存里，之后的
  第一个模型请求一定带上。CLI 在发请求之前就失败（例如本地检查不通过）时，端点收不到请求，不打。
- 例外：子 agent 共用父会话的执行端口和端点 token，所以子 agent 里的部署打在父会话上，子 agent 自己的请求
  不带。
- 推不出历史：消息里只有命令文本和 CLI 输出，不按文本推导。

## 状态 owner 与时序

```text
打点（只调 owner 的唯一入口）               owner：AgentRuntime（每个 session 一个实例）
─────────────────────────────────          ───────────────────────────────────────────
/workflow 展开（bootstrap create-app） ──┐    sessionFeatures: Set（内存，唯一事实源）
工具结果结算（settleToolResults）     ──┤
主循环请求准备之后（turn-loop）       ──┤
官方命令端点收到创建部署（create-app）──┴─▶  recordSessionFeature(tag)
                                              ├ 已有该标签：no-op
                                              ├ 新标签：同步加入 Set
                                              └ 会话已落盘：排队写 session entry
                                                （串行；先读 entry 合并再写；失败只记 warn）

出站请求：runtime 模型句柄在每次 generate/stream 调用时读取 Set 的快照
          → 调用上下文 modelRequestSessionFeatures → adapter 写出 header
```

- 打点同步更新内存，所以打点之后发出的第一个模型请求一定带着新标签，不依赖落盘结果。
- session entry 类型为 `runtime/session_features`，id 固定为 `${sessionId}:runtime-session-features`，
  data 为 `{ features: string[] }`。写入是幂等 upsert，`touchSession: false`。
- 写入串行执行，并在执行时读取最新集合、与 entry 现有标签合并，所以后完成的写入一定包含先完成的写入的全部标签。
- 会话尚未落盘时只更新内存；首次落盘（`ensureSessionPersisted`）后补写一次。
- 状态放在 runtime 字段，不放在 config：workflow 子 actor 会展开父 runtime 的整份 config，
  放进 config 会把父会话的标签带给子会话。

## 继承与恢复

| 场景                        | 行为                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| compact                     | 不变。标签在 runtime 内存和 entry 中，与消息裁剪无关                                                                                                                                                              |
| rewind                      | 不变。"用过"不随分支回退                                                                                                                                                                                          |
| 冷恢复                      | 标签 = entry 中的标签 ∪ 从全部持久化消息（含 rewind 前的）推出的标签。并集比 entry 多时补写 entry                                                                                                                 |
| fork                        | 不复制父会话的 entry。fork 子会话恢复时从复制过来的历史推出标签，所以继承到 fork 点为止已有的标签。辅助对话（side chat，`x-zcode-session-type: side_chat`）也经 fork 创建，同样继承；统计方可按 session-type 区分 |
| subagent、workflow 子 actor | 新 runtime 出生时为空，只记录自己用过的能力                                                                                                                                                                       |
| 热恢复                      | 复用同一 runtime，标签不变                                                                                                                                                                                        |

entry 里出现词表外的标签（例如从更新的版本降级回来）时忽略该标签：它不进入内存，也不随后续写入保留，
所以降级期间只要再打一次新标签，它就会从 entry 中删除。需要跨版本保留时，另行设计存储规则。

entry 的读写都是 best-effort，标签只用于统计，不能改变主流程的结果：

- 每次写入前先读 entry，与内存集合取并集再写，读到的标签同时并回内存；读不到就跳过这次写入。
  因此 entry 中**当前版本能识别的标签**永远不会被较少的标签覆盖，包括历史推导不出的标签；
  词表外标签不在此保证内（见上）。
- 写入失败只记 warn，内存标签保留。
- 冷恢复时读取 entry 失败（例如 SQLite busy）只记 warn，标签只取历史推导的部分，恢复照常完成，
  也不补写。之后的打点在写入前重新读 entry 并合并，读成功时 entry 里原有的标签也回到内存。

## 实现位置

| 层          | 文件                                                                                                                                  | 职责                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| contract    | `contracts/src/model/invocation-context.ts`、`contracts/src/interfaces/session-store.port.ts`、`contracts/src/interfaces/mcp.port.ts` | 标签词表与调用上下文字段、entry 类型、node_repl 可信 meta key                  |
| app（core） | `core/src/runtime/session-features/`（managed 模块 `session-features`）                                                               | owner：打点入口、entry 读写、冷恢复、从工具结果和历史推导标签                  |
| app（core） | `core/src/runtime/methods/runtime-model.ts`                                                                                           | runtime 层在每次调用时读取标签；workspace scope 不带                           |
| adapters    | `adapters/src/model/runner-attribution.ts`、`runner-options.ts`                                                                       | 校验并写出 header，剔除静态同名 header                                         |
| bootstrap   | `bootstrap/src/app/create-app.ts`                                                                                                     | `/workflow` 展开时打 `workflow_cmd`；端点回调创建部署时打 `site_deploy`        |
| bootstrap   | `bootstrap/src/official-command-endpoint/endpoint.ts`                                                                                 | 收到创建部署的请求时回调该 session 的 observer                                 |
| app（core） | `core/src/runtime/methods/turn-loop.ts`                                                                                               | 主循环请求准备之后按生效模式打 ToolSearch 模式标签                             |
| node_repl   | `node-repl-host/src/call-ledger/`（managed 模块 `node-repl-call-ledger`，含浏览器代理 broker）、`cua-broker.ts`、`result.ts`          | broker 收到请求时记账；结果组装时删除伪造的同名 key，只按账本 facts 写可信 key |

## 验证

- adapter：generate/stream 都带头；标签排序去重；空集合、非法标签、超长时整头省略；静态同名 header
  （含大小写变体）被剔除；retry 时值不变。
- runtime 层：同一模型句柄在会话中途新增标签后，下一次调用带上新值；标题、compact、工具内部请求继承
  宿主会话的标签；workspace scope 不带；subagent 复用父句柄时只带子会话自己的标签。
- owner：重复打点幂等；未落盘时不写 entry、首次落盘后补写；写入失败只记 warn 且内存标签保留；
  并发打点后 entry 含全部标签。
- 推导：`CreateWorkflow` 只有 `backgrounded` 才打 `workflow_auto`；编译失败、无端口不打。历史推导覆盖
  `/workflow` 原文、`CreateWorkflow` 成功 display，以及不应命中的情况。
- CreateWorkflow 尝试：成功启动、编译失败、无端口、handler 抛错、参数校验失败、取消都打
  `workflow_auto_attempt`，成功时与 `workflow_auto` 同时出现；`permission_denied`、`tool_not_found` 不打。
  历史推导认 `completed` 的工具 part（不论 display），`error`、pending、running 的 part 与 GUI 直接启动的
  消息不命中。端到端：handler 抛错、参数校验失败、编译失败各一轮，结算之后的下一次请求带上标签并写入
  entry；broker 拒绝时不带；子 agent 只记在自己的会话上，父会话不带；workflow 子 actor 调用未注册的
  CreateWorkflow 不打。
- ToolSearch：成功调用（含无匹配结果）打 `tool_search_called`，失败不打；历史只认 completed 的工具 part，
  规范名和 `LocalToolSearch` 都覆盖。生效模式为 native/local 时打对应标签，`enabled` 为假时不打。
  端到端：native 和 local 各一轮，首次请求带模式标签，搜索之后的请求再带 `tool_search_called`，并写入
  entry；off 不带标签；compact 与目标完成校验请求不打模式标签。
- BUA/CUA：可信 key 为真时打对应标签，工具名不是 `mcp__node_repl__js` 时不认；结果为 `isError` 也打。
  node-repl-host：浏览器代理收到 `list`、`execute`（含上游 `ok: false`、上游断开）记账，无效 token 不记；
  CUA broker 收到请求（含 runtime 抛错、结果 `isError`、broker 侧 subagent 拒绝）记账；结果组装只按 facts
  写可信 key，模型经 `setResponseMeta`、`emitStructuredResult`、内嵌 `_meta` 写入的同名 key 被删除；cell
  只提到运行时、只做 CUA 引导时不写。真实 Worker：cell 经 `worker_threads` 冒充的结果不带这两个 key。旧版 MCP 工具只认官方认证注册的，成败都打；第三方同名
  server（`computer-use`、`computer_use`）不打；历史推导不出这两个标签。端到端：结算之后的下一次请求带上标签。
- Sites 部署：端点收到 `POST /api/v1/sites/{siteId}/deployments` 就回调该 token 所属 session 的 observer，响应是
  2xx 还是 409 都回调；其他方法和路径不回调。端到端：部署请求被上游拒绝时，之后的请求同样带上
  `site_deploy` 并写入 entry。
- 冷恢复：只有 entry、只有历史、两者并集；并集比 entry 多时补写；词表外标签被忽略；读取 entry
  抛错时恢复完成、标签来自历史、不补写；之后打新标签时合并回 entry 原有标签；写入前读仍失败时跳过写入。
