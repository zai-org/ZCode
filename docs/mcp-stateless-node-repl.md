# MCP 2026-07-28 无状态 Node REPL 规格

> 状态：实施中。
> 日期：2026-08-06。
> 协议依据：MCP `2026-07-28`、SEP-2567 Sessionless MCP。
> 产品边界：Browser Use 继续使用 `mcp__node_repl__js`，不新增模型可见的
> `browser_use` server、context handle 或替代工具语义。

## 1. 目标

本次只改变 `node_repl` 的运行时生命周期和 MCP wire era：

1. 内置 `node_repl` 固定使用 MCP `2026-07-28`，同一
   `workspaceKey = workspaceIdentity?.trim() || workspacePath` 的 session 复用一个 MCP frontend。
2. 每次 `js` 调用使用独立的一次性 worker 和 `NodeReplSession`；调用结束后销毁 worker，禁止
   `globalThis`、timer、动态 import module cache、response meta 或 Browser wrapper 跨调用延续。
3. Browser Use 与 Computer Use 共用同一个模型入口 `mcp__node_repl__js`（本规格成文时只有
   Browser Use，CUA 于 2026-08 接入同一宿主）。页面、tab、权限和 backend generation 继续由现有
   BrowserControl/session registry 管理，模型每次调用重新 bootstrap 并按稳定 tab id 找回页面；
   CUA 侧对应 shared-host 的 `CuaControlPort` 与 frame registry。
4. 保留 code-only 运行时兼容，避免改变既有工具身份和回放合同。`js_reset` 与
   `js_add_node_module_dir` 已于 2026-09-18 连同 moduleDirs 能力一并删除（见下文「已删除的两个工具」），
   回放合同由 UI 名称映射承担。
5. 普通第三方 MCP 继续使用 dual-era `auto`；已知 legacy server 和 SSE 继续走 legacy。

“无状态”特指执行 kernel 无状态，不表示删除所有兼容配置，也不表示关闭浏览器页面：

```text
session A ─┐
           ├─ lease ─> workspace-scoped node_repl MCP frontend (2026-07-28)
session B ─┘                         |
                                      +─ js(A) -> one-shot worker A -> dispose
                                      +─ js(B) -> one-shot worker B -> dispose
                                      `─ small session-keyed module-dir config

Browser/page authority
sessionId -> BrowserControlPort.requireSession -> workspace/remote/clientMode
          -> Browser backend/tab registry (existing owner; not MCP frontend state)
```

## 2. 模型可见工具合同

模型只看到一个宿主工具：

- `mcp__node_repl__js`

`node_repl` 的 server instructions 和该 tool description 用一句话同时说明能力与路由禁令：

- **能力**：`js` 以 ZCode agent 的权限运行、没有沙箱（unsandboxed），可加载任意本地模块。文案不得暗示存在
  模块白名单或能力限制。vm context 只负责每次调用的全局状态隔离；协议保护 `process` facade 只保护
  MCP stdio 和宿主进程生命周期。
- **审批路径与 Bash 不同**：`js` 按 MCP 的 high/system 能力审批。build 模式每次询问（可始终允许）；
  guarded 模式没有危险命令匹配，按 YOLO 基础策略放行；Bash 的命令前缀规则也管不到它。因此不能说
  “安全边界与 Bash 相同”。
- **路由禁令**：只在 Browser Use 或 Computer Use 官方 skill 指示控制浏览器或电脑时使用；明确禁止用于 shell、
  文件、包检查、数据处理，要求改用专门工具。禁令以“不经过 Bash 危险命令确认”为理由写出，不得弱化成建议，
  否则模型把 `js` 当 shell 用就绕过了 guarded 的确认。不得提示模型改用专门的 `browser_use` 工具。
- 不写 import 规则。任何解析规则的描述都会被读成模块白名单；import 写法以官方 skill 的 bootstrap 示例为准。
- 文案保持简短，不列举具体能力（读写文件、启动进程等），避免读起来像使用指引。
- tool description 与 server instructions 只写跨 skill 的运行时契约：路由与能力、`title`、`timeout_ms`、
  `nodeRepl.write` / `nodeRepl.emitImage` 输出 API、每次调用都 bootstrap。Browser Use 与 Computer Use 的用法
  （tab 恢复、观察输出、元素目标、坐标、bootstrap 模板）只写在各自 skill；工具描述随每次请求发送，重复一份会和
  skill 漂移。

（2026-11-05 改写：旧文案的 “Import only …” 被外部安全评估理解为受限运行时，进而把加载
`node:child_process` 判定为“沙箱逃逸”。能力本身未变，改的是描述；路由禁令保持原强度。）

（2026-11-06 删除 import 句：上一版的 “`node:*` 或绝对 `file://` URL，裸包名不解析” 仍被读成白名单，且
“裸包名不解析”不准确——`require` 由 `createRequire(cwd)` 创建，裸包名会从工作区 `node_modules` 解析。）

（2026-11-09 删除 skill 专属内容：tool description 里的 CUA 段仍是 v1 SDK 写法——要求 `nodeRepl.write(state.text)`
并用 `state.state_id`，与现行 skill“观察结果自行展示、不要再 write”相反；`state_id` 也已不在模型可见文本中。
其余 tab 恢复、坐标、bootstrap 同 cell 等句子已由 skill 覆盖，一并删除。）

模型 guidance 以升级前 `control-browser` skill 和 Browser API 文档为内容基线。除下列与 kernel
生命周期直接冲突的语句外，导航、定位、popup 恢复、截图、安全、tab 生命周期和错误恢复规则必须保留：

- `persistent kernel/binding/module cache` 改为每次 `js` 调用 fresh；
- `globalThis.browser/globalThis.tab` 跨 cell 复用改为每次 bootstrap 后按当前用户选择重新取得 browser，
  再用完整 tab facts 和稳定 id 找回 tab；
- `js_reset` 与 `js_add_node_module_dir` 已删除，guidance 不得再提它们，也不得暗示存在一个待重建的
  持久 kernel 或可由模型配置的模块搜索根。

禁止为了说明无状态而压缩或重写其他 guidance。每次调用的 bootstrap 示例只负责加载
`scripts/browser-client.mjs` 和执行 `setupBrowserRuntime`，不得在通用模板中硬编码
`agent.browsers.getDefault()`，以免覆盖用户已经明确选择的 IAB、extension 或 CDP backend。

### `js`

- `tools/list` 模型 schema 继续要求 `code + title`，并保持 `additionalProperties: false`。
- `code` 字段描述必须同时适用于 core 的兼容 REPL 和 fresh-kernel MCP，不得继续向 Browser Use 模型
  声明 “persistent Node REPL session”，也不得伪造跨调用状态。
- 运行时 parser 继续接受历史 code-only 输入；UI 对旧数据使用既有本地化 fallback。
- `timeout_ms` 继续使用 60 秒默认值、120 秒上限和既有超时文案。
- 每次调用创建一次性 worker；worker 内创建 `NodeReplSession`、注入 Browser bridge、执行、
  返回结果并销毁。
- 模块加载不设白名单，也不做宿主注入（`resolveSpecifier` 与 moduleDirs 已随工具一并删除）。实际解析规则：
  `require` 由 `createRequire(cwd)` 创建，裸包名从工作区 `node_modules` 解析；动态 `import()` 改写为
  `importModule` 后直通宿主 `import()`，`node:*`、绝对路径与 `file://` URL 可加载，裸包名与相对路径
  按宿主模块位置解析而不是工作区。这些规则不写进模型可见文案（见上文 §2）。
- 同一 session 的 `js` 调用串行；不同 session 可并发。

### 已删除的两个工具（2026-09-18）

`js_reset` 与 `js_add_node_module_dir` 从 `tools/list`、handler 和执行链中整体移除，`node_repl`
只保留 `js`。调用它们返回工具不存在的错误（`<tool_use_error>Error: No such tool available: …</tool_use_error>`）。两者实测调用量均为 0（310 个本地会话、17134 次真实
`js` 调用）。

`js_reset`：fresh-kernel 改造后已无可执行语义——下一次 `js` 本来就是新 kernel，它唯一的残余行为是
排进同 session 的串行队列，而模型 tool_use 天然串行、不同 session 用不同 sessionKey，那个 barrier
恒为空。它每轮请求携带约 117 token 的工具定义，而且因为固定返回成功、永不失败，弱模型不会换策略
（工单 ZCT-2100503886992535552：155 次连调、19 分钟 4837 万输入 token 直到 429）。失败结果才是
模型换策略所需的信号。

`js_add_node_module_dir`：它把宿主职责推给了模型。模型无法自行知道该传哪个 `node_modules`，能告诉
它的只有 skill 文档，而文档知道的路径宿主自己就能注入。两个官方 SDK 的 bootstrap 都只用 `node:*`
内置模块加基于 skill root 的绝对 `file://` URL，从不需要裸包名解析。随之删除的还有
`NodeReplExecuteInput.moduleDirs`、worker 传递链、`NodeReplSession` 的 `moduleDirs`/`addModuleDir`/
`getModuleDirs` 与 `resolveSpecifier`（其两个分支都有 `moduleDirs.length > 0` 守卫，在恒空的生产
路径下从未触发，因此删除不改变任何既有行为）。将来若官方 skill 真要携带第三方包，由宿主在创建
runtime 时注入，不要再给模型开配置工具。

删除只作用于可执行路径。历史 transcript 的渲染继续依赖 `packages/shared/src/tool-identity.ts`
和 `packages/ui/src/lib/nodeReplToolDisplay.ts` 的名称映射，必须保留：它们只读取历史记录里的
toolName，与当前 `tools/list` 无关，删掉会让旧会话的调用块退化成 unknown fallback renderer。

### 无进展提示（2026-10-26）

`js` 永不因「没有进展」而失败，弱模型会在一个 turn 内反复调用直到额度耗尽。工单
ZCT-2114629172776046592（3.16.3，GLM-5.3，automation 定时任务）：单个 turn 443 次模型请求、
439 次 `js`，66 分钟后由用户手动取消。模型已在 title 和正文反复写「本轮结束」「结束。」，
core 的重复调用提醒一次也没有触发——它按完整 input 计签名，模型每次改动 code 即重置。
模型缺的不是做法，而是「可以结束」的许可。

node_repl 宿主在 `tools/call` 内按 `session_id + turn_id` 维护一份计数，同一 session 的调用已串行，
状态只在串行区内读写。缺少 `turn_id` 的请求不计数。turn 变化时全部清零。

| 信号 | 判据 | 提示档位 |
| --- | --- | --- |
| 同码 | `code` 与上一次完全相同 | 连续 5、15、45 …（×3） |
| 无进展 | 模型可见结果（content 与 isError）与上一次完全相同 | 连续 10、30、90 …（×3） |
| 调用量 | 本 turn 累计 `js` 次数 | 30、80、200，之后每 200 |

命中时在结果 content 末尾追加一个 text block，同一次调用最多一条，优先级同码 > 无进展 > 调用量：

```text
[node_repl] Same call ×5. You may end this turn.
[node_repl] No progress ×10. You may end this turn.
[node_repl] 30 calls this turn. You may end this turn.
```

- 文案只授权结束，不要求换做法：换做法式文案会把已经想结束的模型推回去继续调用。
- 结果指纹在追加提示之前计算，提示本身不影响下一次比较。
- 不改变 `isError`、schema、超时、图片顺序或工具身份；不硬停、不拒绝调用。
- 空 `code` 与抛出的执行异常（中止、超时）不计数。
- 提示触发时向 stderr 写一行 `[node_repl] no-progress hint`，只含档位、计数与 session/turn id，
  不含 code 或结果正文。
- 宿主进程重启后计数丢失，只退化为不提示。

## 3. Browser Use 与请求身份

MCP `2026-07-28` 的 `_meta` 是请求 envelope/context，不是独立授权凭证。内置链路按以下顺序校验：

```text
tools/call _meta["com.zcode/request-context"]
  -> node_repl 只读取宿主命名空间，不读取模型参数里的 session 字段
  -> child 使用进程私有 broker socket + 256-bit token
  -> broker 校验 token（不再按 runtimeScope 拒绝 subagent）
  -> BrowserControlPort.list/execute
  -> requireSession(sessionId；子会话经 forChildSession 登记映射到父会话)
  -> 恢复 workspaceIdentity / remoteSessionId / clientMode
  -> 当前 session 的 backend/tab/permission policy
```

因此不能“只信任 `_meta.session_id`”；可信边界是私有 stdio child、私有 broker token、宿主写入的
namespaced request context 与 session registry 共同成立。页面连续性不再需要额外 opaque handle：
`BrowserControlPort` 已按 session 管理 tab/page，fresh kernel 只重建临时 `agent/browser/tab` wrapper。

subagent 可以使用 Browser Use：父 runtime 经 `BrowserControlPort.forChildSession`（`tabOwner: "parent"`）
登记后，子会话的请求以当前对话为 tab 归属下发，子代理看得到对话全部 tab，它开的 tab 在面板里展开，
结束时不关 tab（`docs/browser-use/2026-07-16-subagent-browser-unavailable-spec.md`）。未登记的子会话、伪造顶层
`_meta.session_id`、workspace path 或 browser id 都不能绕过 session registry。

## 4. 共享、回收与日志

- `node_repl` 配置固定为 `protocolVersion="2026-07-28"`、`isolation="workspace"`。
- 连接池 key 保持 `server config fingerprint + workspaceKey`；第三方 server 默认仍为 session isolation。
- 每个 session 持有 lease；最后一个 lease 释放后按现有 grace period 关闭 frontend。
- `mcp.server.connected` 记录 `mcpConnectionId`、`workspaceKey`、`mcpIsolation=workspace`、
  `mcpProtocolEra=modern`、`mcpProtocolVersion=2026-07-28` 和 stdio PID。
- `mcp.pool.lease.acquired/released` 用同一 `mcpConnectionId` 分别记录每个 sessionId；共享连接日志不伪造唯一 owner。
- frontend 崩溃后下一次调用按现有 adapter 逻辑重连。因为 kernel 无持久状态，重连不需要恢复 JavaScript；
  Browser tab/page 仍由 Agent/host 的既有 owner 决定。

## 5. 多端边界

```text
desktop / desktop-continuous ──┐
                               ├─ existing shared host -> Agent -> node_repl lease
mobile / web-remote-replayable ┘

relay/main: auth + attachment + frame transport only
Agent: MCP pool + request routing
BrowserControl/desktop guest manager: tab/page authority
```

- 手机 `/remote` 只 attachment 到桌面窗口已有 host/Agent，不另起 Agent、MCP 或 browser runtime。
- 本改动不新增 task event、snapshot、queue、owner 或 replay state。
- desktop continuous 不拼接 replayable 恢复消息；mobile replayable 不绕过 gap/snapshot 边界。
- remote workspace 的身份继续贯穿 `workspaceIdentity + remoteSessionId`，不能退化为 `workspacePath`。

## 6. 验收

- 工具 identity 仅为 `mcp__node_repl__js`；`js_reset` 与 `js_add_node_module_dir` 不在 `tools/list` 中，
  调用返回工具不存在的错误；不存在内置 `mcp__browser_use__*` 或 `mcp__computer-use__*` 模型工具。
- 连续两次 `js`：第二次看不到第一次的 global、timer、import module singleton 修改和 response meta；
  同一 Browser tab 的 DOM/page state 仍连续。
- Desktop IAB full-chain 与 multi-tab replay 中，每个独立 `js` 都重新 bootstrap；下一次调用使用上一条
  真实 tool result 中的动态 stable tab id 执行 `tabs.get`。每次工具终态先断言 completed 和结果 marker，
  V4 投影滞后时以模型收到的 `tool_result.is_error` 为准；`ReferenceError` 等失败必须在工具边界直接
  暴露，不能退化成后续 UI 或 provider matcher 超时。
- 同 workspace 两个 session 只保留一个稳定 `zcode-node-repl-mcp` frontend/PID；A/B 的 global、
  module dirs、tool result、权限和 tab 隔离。
- `tools/list` 仍要求 title；直接 runtime call 接受 code-only。
- `control-browser` 与 Browser API 文档保留升级前全部非状态 guidance；只替换 persistent/fresh、
  跨 cell binding 和 reset 语义。通用 bootstrap 不选择默认 backend。
- 模型可见 `js.code` schema 不包含与 fresh kernel 冲突的 persistent 文案。
- `js_reset` 与 `js_add_node_module_dir` 的模型可见描述、handler、schema 与 moduleDirs 执行链全部
  移除；UI 名称映射保留供历史回放渲染。
- 无进展提示按档位出现在 content 末尾；turn 切换清零；两个 session 互不影响；缺少 turn_id 不提示。
- main 与 subagent Browser Use 都可用；subagent 与当前对话共用 tab，结束后 tab 保留；返回 main 后原 tab/page 可继续。
- modern/legacy 第三方 MCP 协商回归、focused tests、Desktop pending E2E、`pnpm typecheck`、`pnpm lint` 通过。
