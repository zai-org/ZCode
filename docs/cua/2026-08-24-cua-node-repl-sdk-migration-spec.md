# CUA：SDK + `node_repl` 迁移规格

## 状态

Completed

## 目标

CUA 不再作为 30 个独立 MCP 工具注入模型。模型只调用统一的 `node_repl` MCP，
在每次 JS Worker 中 bootstrap CUA SDK，再通过私有 bridge 执行现有 CUA contract。

## 模型与 SDK contract

模型可见的工具面固定为 node_repl 的三个工具：`js`、`js_add_node_module_dir`、
`js_reset`。CUA 插件 manifest 不再声明 MCP server。

SDK 入口为：

```js
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const computerUseRoot =
  process.env.ZCODE_CUA_PLUGIN_ROOT ??
  process.env.ZCODE_PLUGIN_ROOT ??
  process.env.CLAUDE_PLUGIN_ROOT;
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(computerUseRoot, "scripts", "computer-use-client.mjs")).href,
);

await setupComputerUseRuntime({ globals: globalThis });
const app = await agent.computerUse.getApp("Notes");
await app.getAXState();
```

`agent.computerUse` 暴露的是**绑定对象 API**（`getApp` / `getState` / `listApps` /
`requestAccess` / `stop`，加 Target 上的 `getAXState` / `click` / `setValue` / `elements` 等
camelCase 方法）；原来那批 snake_case 工具收敛为逃逸口
`agent.computerUse.computer.<tool>`，方法名由 SDK 的固定 union `COMPUTER_METHOD_NAMES` 冻结
（现存 14 个，事实来源是 zcode-cua `src/tools/manifest.ts` 的 `TOOL_NAMES`；`open_application`
等 16 个已在 producer 侧删除，启动/激活并入 `get_app_state` 的透明拉起）。参数 schema 与
producer `.strict()` 的 zod 逐字一致，不再把内部 runtime 的 MCP envelope 暴露给
Worker。私有 bridge 使用 `{ method, input, context }`，bridge 内部再适配当前 staging
`ComputerUseRuntime.execute({ toolName, arguments, ... })`，因此 BrokerClient、Helper、
frame freshness 和 action-state 语义仍由 staging runtime 统一实现。SDK 不能访问 broker
socket、token 或 native module。

每个 `mcp__node_repl__js` 调用都创建 fresh Worker，因此 bootstrap 是单次 cell 的前置契约，
不是一次 session 初始化：每个使用 CUA 的 cell 必须先重新导入并执行
`setupComputerUseRuntime({ globals: globalThis })`，再在同一个 cell 调用
`agent.computerUse.<method>()`。禁止把 bootstrap 放在前一个调用、把动作放在后一个调用，
也禁止依赖前一个 Worker 的 `agent`、`runtime` 或 import binding。bootstrap 模板只写在 skill 与
按需文档里，两处必须一致；`js` tool description 只提醒每次调用都 bootstrap，不重复模板与 CUA 用法。

Browser Use 与 Computer Use 可以在同一个 Worker 共存；两者共享
`agent.documentation.get`，分别路由自己的文档名，不互相覆盖文档 loader。
共享的是 `node_repl` 通道，不是插件运行时目录：CUA 的 `ZCODE_CUA_PLUGIN_ROOT`
优先提供 `sharp` 等 native closure 与 CUA 文档，Browser Use 的 root 只负责 browser
bridge 和 host server。截图、缩放和带截图的状态读取不依赖 Browser Use 的 `node_modules`。

### 结构化结果与 Worker 输出

CUA SDK 不向 Worker 暴露 producer 的 legacy MCP `content` envelope，也不创建内容相同的
`content[0].text`、`text`、`message` 镜像。单个 JSON object 文本结果（例如
`list_windows` 的窗口表）归一化为顶层 SDK 字段；普通成功动作只返回稳定 receipt
字段。非 JSON 的读取结果才保留单一 `text` 字段。

Host structured-result sink 只承载两类信息：

1. official CUA image 与相邻的 `image_ref`，以及签发这些内容所需的 `_meta`；
2. 不应进入模型正文的 app-display `_meta`、action-state 等 sideband，此时 `content` 必须为空。

错误结果可以保留 producer 的错误 `content`。成功的纯文本 action/metadata 结果不得再次
通过 structured sink 进入 tool result，否则它会与 cell 末尾的 `nodeRepl.write(...)`
拼成两段输出。`toMcpRunResult` 继续把 structured image 视为权威来源，避免误写
`console.log(JSON.stringify(result))` 时破坏 official CUA 的 `image`/`image_ref` 邻接关系。
观察方法（`getAXState` / `getScreenshot` / `getAXStateAndScreenshot` / `getState` /
`listApps`）**自己展示结果**，所以 skill 明确禁止再把它们的返回值传给 `nodeRepl.write(...)`
或 `nodeRepl.emitImage(...)`：一个结果里出现第二张栅格会违反 one-raster 规则，整帧会被移除，
最终一张图都拿不到。要拿值不展示就传 `{ emit: false }`。`getApp` 只绑定、不展示。

CUA bridge 的 broker credential 注入资格与 official CUA frame authority 是两个独立集合。
`node_repl` 可以拿到前者以访问 shared-host CUA runtime，但只有携带真实 plugin authority
的 CUA MCP descriptor 才能拿到后者；通用 node_repl/Browser Use 结果不得因此进入 exact-raster
校验路径。对于 shared node_repl 内的 CUA SDK 结果，Host 只在同一结果同时具备 producer
签发的 `zcode.cua/official-frame-integrity-v1`、合法相邻 `image_ref` 和 raster 时动态启用
该保护；同一 server 中的 Browser Use 结果继续走普通媒体路径。

## 运行时边界

```text
node_repl MCP / shared host
  └─ CuaRuntimePool（按 workspaceKey + sessionId + remoteSessionId 隔离）
       └─ AccessibilitySession + KillSwitch + InputHoldRegistry
            └─ BrokerClient → signed Computer Use Helper
```

每次 `js` 调用的 Worker 都是短生命周期；CUA session、frame registry、action-state
和 kill switch 由 shared host runtime 持有。`js_reset` 只重置 JS Worker，不销毁 CUA
runtime。

所有 workspace identity 使用：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

远程 `/remote` 只能 attachment 到已有 desktop shared host，不能创建独立 Helper、
独立 Agent runtime 或 relay 侧 CUA 状态。桌面保持 `desktop-continuous`，手机保持
`web-remote-replayable`。

## 授权与错误

外层 `mcp__node_repl__js` 只做一次高风险审批；内层复用 Helper/TCC、kill switch、
frame freshness、possibly-sent 和 input-hold cleanup。`request_access` 仍可触发
系统权限流程，但不新增模型级逐动作审批。

stale frame、Helper unavailable、权限拒绝、`possibly_sent`、attachment 丢失均必须
fail closed，并以结构化结果返回。subagent 请求直接返回 CUA unavailable。

## 动作后的观察边界

动作工具默认只返回动作结果，不在动作内部自动调用 `get_app_state`。元素发生写入后，
shared runtime 仍会将旧状态标记为需要刷新，并在未完成刷新时拒绝复用旧 `state_id`；
因此关闭隐式观察不会放宽 stale-state 安全校验。模型生成的每个含一个或多个 UI 动作的
`node_repl` cell 必须在最后显式调用一次观察（`app.getAXState()`），由该方法自行展示结果 ——
**不要**再包一层 `nodeRepl.write(state.text)`（见上一节的输出契约）；动作与观察位于同一个外层
tool call，避免再发起一次独立 `mcp__node_repl__js`。同一 cell 可以批量执行紧密相关的动作，
但末尾只观察一次。

默认动作结果不携带 `state_sync_status`；显式要求 `return_state="compact"|"full"` 时，
结果才会附带一次 post-state 及其 `state_sync_status`。普通 workflow 保持
`return_state="none"`，由 cell 末尾的显式 `get_app_state` 统一捕获一次，避免每个 SDK 动作
内部各自产生 `capture_app`，也避免操作后再发一个独立 node_repl tool call。

Windows 操作指示器和 macOS PiP 继续消费 shared-host 的 sideband 事件；对于
`mcp__node_repl__js`，sideband 只携带从 SDK 调用名解析出的固定 `operationAction`，不携带
JS 源码、参数或凭据。仅调用 Browser Use 的 `agent.browsers.*` 不会触发 CUA 指示器。

> **已被取代（2026-09-14）**：这里的 `operationAction` 约定依赖从模型源码里抽取动作名，
> `e2d7a9f2e9` 重塑 SDK 面之后整体失配，Windows 指示器随之失效。现在 sideband 只携带
> 布尔事实 `computerUse`（锚点是引导语句 `setupComputerUseRuntime`）。见
> `2026-09-14-windows-cua-indicator-repair-spec.md`。"不携带源码/参数/凭据"与
> "Browser Use 不触发指示器"两条结论不变。

### 2026-08-25 日志驱动的观察契约加固

`get_app_state` 的 `structuredContent` 是 Worker SDK 的唯一结构化事实来源，必须贯穿

```text
Helper capture_app
  -> CuaRuntime / observation mapper
  -> broker JSON response
  -> node_repl bridge
  -> computer-use-client.mjs
```

完整、`delta` 和 `no_change` 三种观察模式都必须返回同一套 AppState 字段（至少包括
`state_id`、`elements`、`app`、`window`、`text`）；增量模式可以把 AX 树文本压缩为变化摘要，
但不能省略结构化的可操作元素列表。因为每次 `js` 都是 fresh Worker，SDK 不能依赖上一次
Worker 内存来补回缺失的 `state_id` 或元素。

若 SDK 收到没有完整 AppState 的 `get_app_state` 响应，必须抛出稳定的
`STRUCTURED_STATE_UNAVAILABLE` 契约错误（`ComputerUseError.code`）并停止后续动作，禁止让模型
得到 `undefined` 后自行猜测或硬编码旧 `state_id`。观察结果由 SDK 自动 emit（`{ emit: false }`
可关闭），模型不再手工回灌 AX 文本。

不展示结果的观察必须自报：`getApp` 的绑定观察、`getScreenshot`（不给树文本）与 `elements()`
（只回结构化数组）都要传 `tree_shown_to_model: false`，否则 producer 的索引位移台账会把模型
没看过的树记成看过的，校验退化成当前树跟当前树自比；同时这几条路径要清掉 SDK 侧的 `treeSeen`，
让下一次 `getAXState` 强制整树，避免模型收到相对未展示树的 diff。

Worker 视图只保留模型需要的 SDK 字段，移除 legacy `content`、重复 `message`、`_meta`、
图片 base64 和内部帧授权，避免 `console.log(JSON.stringify(result))` 时重复倾倒敏感/大体积
envelope。skill 必须将“动作 cell 末尾显式观察并写出 AX 文本”作为固定模板，禁止把动作
结果 JSON 作为 cell 输出。

## 迁移与历史

- 删除 CUA 独立 MCP server、旧工具投影、aliases 和新的执行路径。
- 新调用统一使用通用 node_repl renderer；截图/结构化结果继续沿用 node_repl 图片路径。
- 对历史 transcript 保留只读的旧 `mcp__computer-use__*` 解析，禁止重新注册或执行。

## 验收

1. 新会话工具列表不包含任何 `mcp__computer-use__*`，首轮只包含 node_repl 工具描述。
2. 存活的 14 个 CUA contract 通过 SDK 调用保持原有 schema、状态校验和外部 oracle 覆盖；
   已删除的工具名不得出现在任何模型可见文档里（contract test 钉死）。
3. 同一 shared host 多次 Worker 调用不会创建独立 CUA MCP 进程，也不会线性增长 runtime 内存。
4. Browser Use、桌面 continuous、手机 replayable、subagent 隔离和旧 transcript 回放均通过回归。
