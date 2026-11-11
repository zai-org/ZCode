# Browser Use Node REPL MCP 运行时规格

> 状态：历史规格；2026-08-06 起由 `docs/mcp-stateless-node-repl.md` 取代。
> 日期：2026-07-13。

> 迁移说明：工具 identity、Browser Use-only 路由、`code + title` 模型 schema 与 code-only 运行时兼容
> 继续有效；持久 kernel、session-scoped MCP process 和独立 `browser_use` handle 方案已废弃。
> 当前实现为 workspace 共享的 MCP `2026-07-28` `node_repl` frontend，每次 `js` 使用一次性 kernel。

## 1. 目标与事实裁决

browser-use plugin 本身不声明 MCP server。它只提供 skill、文档和
`scripts/browser-client.mjs`，skill 要求通过宿主提供的 Node REPL MCP 执行：

```text
mcp__node_repl__js
mcp__node_repl__js_reset
mcp__node_repl__js_add_node_module_dir
```

目标形态中 `node_repl` 是独立 stdio MCP server；`js` 再启动持久 Node kernel。browser client
在 kernel 中初始化 `agent.browsers`，经产品受信 bridge 访问 browser backend。

ZCode 当前的 `js/js_reset/js_add_node_module_dir` 是 Agent core 内建 tool，REPL 也运行在 Agent
进程内。虽然对象图和多数 cell 语义已经就位，但 tool identity、进程生命周期、MCP status/tool
discovery 和 stdio 故障隔离都不符合目标形态。

本轮目标是把 ZCode 的模型可见边界改为真实 MCP server，并保持现有 BrowserControl 产品链不回退：

```text
model
  -> mcp__node_repl__js
  -> host-reserved server: node_repl (stdio child; not declared by browser manifest)
  -> persistent NodeReplSession
  -> import browser-use plugin scripts/browser-client.mjs
  -> authenticated local pipe
  -> current Agent session BrowserControlPort
  -> existing ZCode Protocol interaction/browserExecute
  -> shared host -> desktop main/IAB
```

## 2. 工具合同

### 2.0 Browser Use 模型路由边界

`node_repl` 是 Browser Use 的受信执行机制，不是提供给模型自由选择的通用 JavaScript、
文件处理、Shell、包检查或数据处理工具。模型可见的 MCP server instructions 和 `js` tool
description 必须在开头明确：

- 只在 Browser Use skill 要求控制浏览器时使用 `node_repl`；
- 非浏览器任务不得因为可以用 JavaScript 实现，就选择 `node_repl`；
- `js_reset` 和 `js_add_node_module_dir` 只服务于同一 Browser Use 工作流。

该约束属于模型路由合同，不改变底层 persistent kernel 的执行能力，也不在执行层拒绝历史调用；
否则旧 provider、历史回放和 browser-client 初始化代码会因合同升级失效。

2026-07-28 缺陷原因：host MCP 只描述了 persistent JavaScript kernel 的能力，没有描述 Browser Use
使用边界。模型会把它识别成通用代码执行器，在与浏览器无关的任务中错误选择高权限
`mcp__node_repl__js`。ZCode 中 `node_repl` 只有 Browser Use
一个合法场景，因此必须把这个单一场景和反向禁用条件同时写入 server instructions 与三个 tool
descriptions，并由 `tools/list` 自动化锁定。

当前模型路由与 Browser Use guidance 合同以 Browser Use plugin `0.3.0` 发布。插件包 `package.json`、
`.zcode-plugin/plugin.json`、`OFFICIAL_PLUGIN_DEFINITIONS`、SEA `officialSeaPlugins` 与
`NODE_REPL_SERVER_VERSION` 的版本必须完全一致；bootstrap 自动化负责校验前三处，SEA build
自动化负责校验 package/manifest/SEA 清单，MCP server 自动化负责校验 serverInfo 与 package，
通过重叠事实源把五处版本机械闭环。禁止再次出现插件内容已升版、官方 seed、SEA asset path 或
MCP runtime 仍写入旧版本的漂移。

### 2.1 `js`

模型侧输入合同复用 `@zcode/contracts` 的 `JsInputJsonSchema`，禁止 MCP server 另写一份会漂移的
JSON Schema：

- `code: string`，必填。
- `timeout_ms?: integer >= 1`，默认 60000ms，最大 120000ms。默认值覆盖整个 cell 执行，包含
  browser 操作和所有异步等待。模型预计整个 cell 超过 30000ms 时必须显式传入 `timeout_ms`，
  取值至少为预计总时长加 15000ms 开销；若结果超过 120000ms，必须拆分为多个调用。
- `title: string`，1..120 字符，必填；必须使用当前用户语言描述本次操作目标，不得使用
  `js`、`JavaScript`、`node_repl` 等实现术语。
- `additionalProperties: false`。

模型合同与运行时兼容合同必须分离：`tools/list` 暴露的 schema 要求 `code + title`，确保所有新调用
都有用户可见标题；MCP server 的执行解析继续接受缺少 `title` 的旧调用，保证历史记录、旧 provider
和回放链路不会因合同升级失效。UI 只对这些旧数据使用本地化 fallback，不能为新调用猜测标题。

2026-07-14 缺陷原因：node_repl 从 core built-in 迁移为 host MCP 后，server 手写 schema 将 `title`
标为 optional 且 `required` 只有 `code`，覆盖了 core 已有的“模型必填、运行时兼容”合同。模型因此连续
发出无 title 的 browser-use 调用，UI 只能显示固定的 `Operation completed`。修复必须消除这份手写
模型 schema，并用自动化断言 `tools/list.required` 同时包含 `code` 与 `title`。

2026-07-14 超时缺陷原因：模型在一次 browser cell 中先发送消息，再固定等待 30000ms；旧 MCP 默认
超时同为 30000ms，尚未计入点击、输入和结果读取开销就会中止。默认值调整为 60000ms，并要求执行层、
server instructions 与 tool description 复用同一常量，避免模型文案和真实超时再次漂移。显式
`timeout_ms` 的 120000ms 上限保持不变。

模型侧 `timeout_ms` 字段描述和 `js` tool description 必须同时携带上述 30000ms 决策阈值、
15000ms 预留规则和 120000ms 拆分边界；不能只写成 “Optional per-call timeout”，否则模型无法从
字段类型推导何时必须覆盖默认值。

输出使用 MCP `CallToolResult`：

- 文本输出进入 `content: [{type:"text", text}]`。
- `nodeRepl.emitImage(...)` 每次追加一个 MCP image content block。
- `nodeRepl.setResponseMeta(...)` 与 browser response meta 浅合并到顶层 `_meta`。
- JS 异常以 `isError: true` 和可读 text 返回，不让 MCP server 崩溃。

kernel 跨 `js` 调用持久；timeout/cancel 后必须废弃旧 context，迟到 continuation 不得写入新 cell。

### 2.2 `js_reset`

- 输入为空对象、禁止额外字段。
- 重建 kernel，清空 cell binding 和旧 browser/tab binding。
- 已添加的 module search roots 保留。
- annotations：`readOnlyHint:true`、`destructiveHint:false`、`openWorldHint:false`。

### 2.3 `js_add_node_module_dir`

- 输入为 `{path: string}`；只接受绝对 `node_modules` 目录。
- 新增返回 `true`，重复添加返回 `false`。
- search root 在本 MCP server 生命周期内保留，包括 `js_reset` 之后。
- annotations 与 `js_reset` 相同。

## 3. 宿主与 Plugin 命名边界

- `node_repl` 由 bootstrap 作为宿主保留 stdio MCP server 注入，browser-use plugin manifest 不声明 MCP，
  即 MCP server 归宿主、skill 与资产归插件。browser-use package 只是当前 server bundle 随产品发布的物理资产载体。
- 宿主 `node_repl` 是 ZCode 内置运行时，设置页（插件页与 MCP 页）不展示它，也不展示 `node-repl-host` 插件
  （2026-11-05，见 `docs/plugin-capabilities-settings.md`「Scope 语义」）。官方插件定义里的
  `hostMcpServerNames` 只供 Agent 内部反查进程归属，不再投影到 `plugins/list`；运行时名称仍是 `node_repl`，
  不改成 `plugin:browser:node_repl`。
- 宿主 `node_repl` 在用户/plugin MCP 合并后覆盖同名项；第三方/inline plugin 仍强制
  `plugin:<plugin>:<server>` namespace，不能冒充 `mcp__node_repl__*`。
- browser-use plugin 增加 `scripts/browser-client.mjs`。skill 必须从宿主注入的
  `ZCODE_PLUGIN_ROOT`（兼容 `CLAUDE_PLUGIN_ROOT`）读取插件根目录，再通过 `node:path.join` 和
  `node:url.pathToFileURL` 生成跨平台绝对 file URL 后动态导入；禁止保留 `<plugin root>` 占位符，
  也禁止根据 Skill base directory 猜测插件根目录。这样既不依赖模型路径推理，也不依赖 core 在每个
  REPL context 中提前注入 `agent.browsers`。
- MCP initialize 返回的 `serverInfo.version` 与 browser-use package 当前版本一致，并由自动化与
  `package.json` 机械比对；它表示当前随包 server 实现版本，不维护一份无法解释的独立版本线。
- 禁用 browser-use plugin 只移除 skill/browser bootstrap 能力，不移除通用 `node_repl` MCP server。
- MCP server 禁用或连接失败时，不回退暴露同名 core 内建 `js`，避免模型看到两套状态所有者。

## 4. Browser bridge 与安全边界

MCP child 不直接持有 desktop/main/service 实现。当前 Agent session 在 bootstrap 时为 Node REPL 创建
一个本机 IPC broker：

- Unix 使用 session 专属 Unix domain socket；Windows 使用 session 专属 named pipe。
- endpoint 使用随机 UUID，另带独立随机 token；每条请求校验 token。
- wire 使用一行一条 JSON request/response；请求只允许 `list` 和 `execute`。
- broker 对 command 做 runtime schema 校验，再调用注入的 `BrowserControlPort`。
- MCP tool `_meta` 显式携带 `sessionId`、`turnId` 和 trace；child 不从 cwd/path 推导身份。
- socket 断开或 MCP call cancel 时中止 BrowserControlPort 请求，继续沿现有
  `cancelRequest` 链路通知 desktop backend。
- kernel generation 变化后，旧 browser bridge 立即报 stale；旧异步 continuation 不得借用新 call 的
  session/turn/signal。
- browser broker 只在 browser-use plugin 启用、BrowserControlPort 可用时注入；纯 CLI 的通用 REPL 仍可执行 JS，
  browser client discovery 返回明确 unavailable。

`node_repl` MCP 仍具有与 shell 同级的本机代码执行能力，权限系统必须按高风险 MCP tool 处理。本轮不
把 browser command action confirmation 下沉到 relay/main，也不让 MCP child绕过现有 URL、下载、
文件选择和 backend capability policy。

MCP kernel 使用协议保护 `process` facade（`protectProtocolStdio`），并拦截 `require/import("node:process")`，
不让 cell 直接访问 stdin/stdout/stderr、exit/kill/chdir，以免写坏 MCP stdio 或关闭 child。它只保护协议通道与
宿主进程生命周期，不限制能力：cell 仍可通过 `node:child_process`、`node:fs`、`node:net` 或任意本地模块做
agent 能做的任何事。`node_repl` 不是沙箱。`js` 的审批路径与 Bash 不同：按 MCP high/system 能力审批，
guarded 模式下不做危险命令匹配、按 YOLO 基础策略放行，也不受 Bash 前缀规则约束；把它限定在官方 skill
用途内的是模型可见文案里的路由禁令（见 `docs/mcp-stateless-node-repl.md` §2）。

## 5. 多端与 workspace 边界

- MCP child 是当前 Agent session 的执行 runtime，不是手机端独立 Agent runtime/local host。
- desktop `desktop-continuous` 与手机 `web-remote-replayable` 继续共享既有 host attachment 和
  BrowserControlPort；本轮不新增 task event、snapshot、queue 或 replay 状态。
- `workspaceIdentity` / `remoteSessionId` / `clientMode` 仍由 ProtocolBrowserControlBroker 根据 session
  record 注入。MCP pipe 只传 `sessionId/turnId/trace`，不得自行用 `workspacePath` 建隔离 key。
- MCP server lifecycle 归当前 session 的 MCP adapter；session close 同时关闭 child、pipe broker 和
  browser session，不把连接状态放进 relay 或 desktop main。
- macOS、Linux 使用 Unix socket；Windows 使用 named pipe。路径只能由 `node:path`、`node:os` 和
  `node:net` 生成，不硬编码 POSIX 分隔符。

## 6. 迁移与兼容

- 删除 browser runtime 对 core built-in `js/js_reset/js_add_node_module_dir` 的注册；保留底层
  `NodeReplSession` 作为 MCP server 的可复用执行引擎。
- UI node-repl renderer 同时识别旧历史工具名和新 MCP fully-qualified 名；历史 session 不重写。
- permission、result budget、image artifact 和 response `_meta` 使用现有 MCP tool bridge；必要的
  node-repl 专属预算按精确 MCP tool name 配置，不反向解析 UI 文本。
- subagent 只有在 allowlist/required MCP server 明确包含 `node_repl` 时获得同一 MCP server；不得另起
  一个能连接桌面 tab 的无 owner runtime。

## 7. 验收用例

| Case   | 场景              | 断言                                                                                                                                      |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| NRM-01 | app bootstrap     | MCP status 有宿主 `node_repl`，模型工具名为 `mcp__node_repl__js*`，无裸 `js*`                                                             |
| NRM-02 | MCP tools/list    | 三个工具的名称与严格 schema 正确；`js` 模型合同要求 `code + title`，运行时仍接受旧的 code-only 调用                                       |
| NRM-03 | 两次 `js`         | 顶层 binding 持久；不同 MCP process/session 隔离                                                                                          |
| NRM-04 | `js_reset`        | binding/browser generation 清空，module roots 保留                                                                                        |
| NRM-05 | add dir           | 绝对路径首次 true、重复 false、相对路径拒绝                                                                                               |
| NRM-06 | output            | write/console/result、BigInt/circular error、image blocks、`_meta` 投影正确                                                               |
| NRM-07 | timeout/cancel    | kernel reset，旧 async continuation 和旧 browser bridge 不可复用                                                                          |
| NRM-08 | browser bootstrap | 使用宿主 `ZCODE_PLUGIN_ROOT` 构造跨平台 file URL 并 import `scripts/browser-client.mjs` 后 `agent.browsers` 可用；不从 Skill 目录猜路径   |
| NRM-09 | browser command   | pipe 校验 token/schema/context，调用同 session BrowserControlPort                                                                         |
| NRM-10 | forged pipe       | 错 token、非法 op/command、错误 session 均 fail closed                                                                                    |
| NRM-11 | plugin disabled   | browser skill/client bridge 不注入，宿主 `node_repl` 仍可执行通用 JS                                                                      |
| NRM-12 | namespace         | user/plugin 同名 server 不能覆盖宿主保留 `node_repl`                                                                                      |
| NRM-13 | desktop/mobile    | clientMode/workspaceIdentity/remoteSessionId 仍由 shared-host session record 决定                                                         |
| NRM-14 | packaging         | filesystem seed、SEA、Desktop、production remote、development remote 均包含 server 与 browser-client；development hash 覆盖 client script |
| NRM-15 | MCP settings      | browser-use 插件下只读展示 `node_repl`，状态和 3 个工具来自真实 `mcp/list`，runtime name 无 plugin 前缀                                   |

## 8. 实施结果与剩余风险

已完成：

- 宿主保留 `node_repl`、真实 stdio MCP server、显式 browser-client bootstrap、本机鉴权 broker、
  MCP `_meta` 透传、UI 新旧 identity、SEA/Desktop/production remote 资产收集均已实现并有自动化覆盖；
  development remote 必须复用同一顶层资产合同并显式覆盖 `scripts`。
- MCP 设置页通过官方 browser-use 插件的宿主 MCP 关联元数据展示 `node_repl`，不改变宿主
  identity；filesystem seed 与 SEA 使用一致的顶层资产白名单，Dev 缓存必须包含
  `scripts/browser-client.mjs`。
- browser bootstrap 不再让模型把 `scripts/browser-client.mjs` 相对到 `skills/control-browser`；插件根目录
  由 `node_repl` MCP child 的只读 `process.env.ZCODE_PLUGIN_ROOT` 提供，并在 Skill 模板内用
  `pathToFileURL(join(...))` 转为可移植的 ESM import URL。
- `node_repl` MCP 的模型输入 schema 复用 `@zcode/contracts`；新调用强制提供用户可读 title，执行层继续
  接受旧 code-only 调用，避免 UI 再次退回固定完成文案，同时保持历史兼容。
- 已按本规格做黑盒合同核验：ZCode 的 tools/list、严格 schema、空代码、
  module dir 首次/重复结果及非法路径 `-32602` 边界均符合预期。
- browser-use-plugin typecheck/lint/build/test 通过；core、bootstrap、adapter、UI、SEA、Desktop 的相关定向
  测试通过；Agent workspace 全量 typecheck 通过。
- root `pnpm typecheck` 通过；root `pnpm lint` 通过（78 条当前仓库既有 warning，0 error）。
- 真实 ZCode MCP stdio child smoke 通过：tools/list 为三个预期工具，cell 得到 `42`，标准
  `await import("node:path")` 可用，受限 `process.stdout` 不可见。带 fake BrowserControlPort 的
  MCP → browser-client → pipe → broker 集成链通过。

当前工作树同时存在不属于本功能的 Browser Settings 开发改动；其门禁已恢复通过，但本提交不会修改
或暂存这些并发文件。

仍需实机补验：

- ZCode Dev IAB 的真实 navigate + DOM snapshot（本轮完成 broker 集成测试，未用 mock 结果冒充真机）。
- Windows named pipe、手机 Web remote、SSH/WSL/Docker remote workspace 回归。
- SEA 与 Electron 三平台安装包的启动级 smoke；当前只有资产收集与 bundle contract 自动化。
