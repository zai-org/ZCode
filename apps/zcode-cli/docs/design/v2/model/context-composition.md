# Context 组成（Context Composition）

> 状态：P1 第 1 段已实现（CLI 生成、预演、协议、App 侧接口）。总设计见 [扩展进程](../../../../../../docs/plugins/extension-host.md)。
> 基线：staging `2015563fc3`，实现时按代码重新核对，差异已改进本文。

## 1. 目标

让 App 外的消费方（第一个是扩展插件）读到「当前模型请求里各部分占多少」。

- 只给类别、条目名和大小，不给正文。
- 发送前（草稿）给出首个请求的预演。预演没有副作用。
- 变化时通知，通知只带修订号，消费方按需拉取。

## 2. 现状（实现前的事实）

- 每次模型请求前，runtime 已经在算一份分解：`buildContextUsageSnapshot`（`packages/core/src/runtime/methods/context-usage.ts:119-253`），调用点 `model.ts:147-149`。分 7 类，每类带 `chars`、`tokens`、`tokenMethod`、明细。
- 这份分解有两个出口：
  - debug 日志 `context_usage_snapshot`（`context-usage.ts:45-57`）。按 [debug-observability](../debug-observability.md) 的定义，它不是稳定 API。
  - 降维成 `{source, chars}`，作为 `ModelComplete.contextUsageBreakdown` 下发，只在主轮请求（`turn-model-step.ts:749-751`）。App 用它画输入框用量圆环的分段条（[分段条 spec](../../../../../../docs/superpowers/specs/2026-06-11-context-usage-breakdown-bar.md)）。
- 圆环线格式的 `source` 是严格枚举，7 个值（`packages/shared/src/zcode-protocol-legacy-types.ts:499-514`）。
- 没有 context 预演 API。

### 2.1 现有分解的缺口

| 缺口                                                                                                                                                         | 位置                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 以 `<system-reminder>` 开头的 user 消息被排除出 messages，environment、agent listing、ToolSearch 公告、todo 等提醒漏算；MCS 下提醒变成 system 消息，同样漏算 | `context-usage.ts:147-155`                            |
| `deferLoading` 工具仍按全量 schema 计入                                                                                                                      | 工具分类处                                            |
| `app__` 工具被算成内置工具，因为只认 `mcp__` 前缀                                                                                                            | `runtime/helpers/tool-result.ts:144-157`              |
| compact summary 没有单独类别，归在 messages                                                                                                                  | `compact-active.ts:624-627` 的 `compactBoundary` 消息 |
| skills 与指令按 builder sections 估算，不读真实 attachment 文本                                                                                              | `context-usage.ts:134-140`                            |

来源信息可用：`buildProviderRequestMessages` 返回与 messages 同索引的 `sourceEntries`（`runtime/helpers/provider-request-messages.ts:33-43,106-113`），`metadata.source` 能区分提醒来源、真实用户输入与 `compactBoundary`（`agent/message-history.ts:63-96`）。MCS 投影出的 system 提醒，`sourceEntries` 指回原 attachment；context 前缀的 system 消息没有 metadata，靠 `latestContextBuildResult.sections` 归因。

## 3. 设计

### 3.1 一份分解，两个出口

`buildContextUsageSnapshot` 改为调用分类纯函数 `classifyContextComposition`，不另建第二套。它产出**细类别**；圆环需要的粗类别由纯函数 `projectContextCompositionToUsageSources` 从细类别投影出来。只有一处计算。

| 细类别 id               | 内容                                                                          | 来源                                                                                | 投影到圆环的粗类别                                              |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `system_prompt`         | 系统提示词                                                                    | sections：`system` 注入、来源不是 `skills`/`tools`                                  | `system_prompt`                                                 |
| `meta_user_context`     | 指令（AGENTS.md、记忆索引）                                                   | 请求里 `context_prefix` 公告的真实文本；无 metadata 的旧版 `<system-reminder>` 前缀 | `meta_user_context`                                             |
| `skills`                | 技能列表                                                                      | 请求里 `skills_listing` 公告的真实文本                                              | `skills`                                                        |
| `tool_prompt`           | 工具说明                                                                      | sections：来源 `tools`                                                              | `tool_prompt`                                                   |
| `system_tool_schemas`   | 内置工具定义                                                                  | 请求 tools，非 `mcp__`/`app__`、非延迟加载                                          | `system_tool_schemas`                                           |
| `mcp_tool_schemas`      | MCP 工具定义                                                                  | 请求 tools，`mcp__` 前缀                                                            | `mcp_tool_schemas`                                              |
| `app_tool_schemas`      | 页面工具定义（`app__` 前缀）                                                  | 请求 tools，`app__` 前缀                                                            | `system_tool_schemas`（与改前一致）                             |
| `deferred_tool_schemas` | 延迟加载的工具，只计 `{name, description}`                                    | 请求 tools，`deferLoading: true`                                                    | `mcp__` 前缀归 `mcp_tool_schemas`，其余归 `system_tool_schemas` |
| `reminders`             | 其余提醒（环境、模型、日期、Git、模式、子代理列表、ToolSearch 公告、todo 等） | 请求里其余已知 reminder 来源的消息                                                  | `meta_user_context`                                             |
| `compact_summary`       | 压缩摘要                                                                      | 带 `metadata.compactBoundary` 的消息                                                | `messages`                                                      |
| `messages`              | 对话消息                                                                      | 其余消息；`inputPresentation: "task_notification"` 的新轮通知也在此                 | `messages`                                                      |

- 每条消息按 `JSON.stringify({role, content, toolCalls, toolCallId, toolName})` 计 `chars`，用 `estimateTokens` 估 token（与改前 messages 的口径相同）。工具按完整契约 JSON 计；延迟加载工具只计 `{name, description}`。
- 现有 7 个 id 不改名。圆环线格式的枚举**一字不改**，新类别只出现在 §3.3 的查询结果里。理由：远程工作区的 CLI 版本可以和 App 不同；往严格枚举里加值，旧的一方会解析失败。
- 修掉缺口后，圆环的数值会更准（提醒计入「其他」，指令按真实文本计），形状和枚举不变。
- 已知局限：模型能力 `foldRemindersIntoToolResults` 为真时，紧跟工具批次的提醒会并进 tool 消息，这部分计入 `messages`。`sourceEntries` 对合并后的消息只保留代表条目，无法再拆。
- 细类别的类型来自 shared 线格式（§3.2），`runtime/types.ts` 不改（原设计计划扩 `ContextUsageCategory.source`，实现时改为粗/细两套类型分开，避免 1048 行的文件再变大）。
- CLI 新代码放 `packages/core/src/runtime/context-composition/`（分类、状态、预演）与 `packages/bootstrap/src/zcode-protocol/context-composition/`（修订号与协议处理）。两个目录与 shared 线格式同属 managed 模块 `context-composition`。

### 3.2 线格式

放 `packages/shared/src/zcode-protocol-v4/context-composition/contract.ts`（managed 模块 `context-composition`），zod schema 是唯一定义，经 `@zcode/shared/zcode-protocol-v4` 导出。

```ts
interface ContextComposition {
  sessionId: string;
  revision: number; // 每会话单调递增，见 §3.4
  phase: "request" | "draft-preview";
  measuredAt: number; // 毫秒时间戳
  model: { providerId: string; modelId: string; contextWindow: number | null };
  tokenMethod: "estimated";
  estimatedTokens: number; // 各类别 token 之和
  providerInputTokens?: number; // 只在 phase=request：该请求服务商报告的 input tokens
  providerContextTokens?: number; // 只在 phase=request：与输入框用量圆环同一个值（input + 本次 output）
  freeTokens: number | null; // max(0, contextWindow - estimatedTokens)；contextWindow 未知时为 null
  categories: Array<{
    id: ContextCompositionCategoryId; // §3.1 的细类别
    tokens: number;
    chars: number;
    items?: Array<{ name: string; tokens: number }>; // 按 token 降序，最多 50 条
  }>;
}
```

- 只给名字和大小：工具名、技能名、指令文件路径、提醒来源名、section 名、消息角色。不给消息正文、工具 schema、提醒正文。
- 条目名最长 200 字符。0 值类别不返回。
- token 是估算值（`context/utils.ts:12-18` 的 `estimateTokens`），`providerInputTokens` 供对照，取 `getModelUsageInputWindowTokens(usage)`。
- `providerContextTokens` 取 `getModelUsageContextTokens(usage)`，与 V4 状态 `usage.contextWindow.usedTokens`（输入框用量圆环）用同一个函数、同一份 usage，所以两者相等。它比 `providerInputTokens` 多出这次请求的 output tokens：这些 token 会进下一次请求的上下文。消费方要和圆环对齐时用它，不要自己用 input 加 output 再算一遍。
- 兼容：App 侧的 schema 是 strict。新字段可选；查询只来自本机工作区（扩展进程的 `context.get`，见 `docs/plugins/extension-host.md` §16），本机 CLI 与 App 同一个构建，不会出现新 CLI 对旧 App。远程工作区的 CLI 可以比 App 新，以后给远程会话开放这个查询时要先加能力位。

### 3.3 协议

- 查询：`v4/conversation/contextComposition`，参数 `{ sessionId, modelSelection? }`（strict），返回 `{ composition: ContextComposition | null }`。
  - 会话不在内存时返回 `null`，不为查询冷启动或恢复会话（existing-only）。
  - 会话没有模型选择、参数也没给时返回 `null`。
  - 最近一次请求组成有效（§3.4）且模型与所查模型的 `providerId`/`modelId` 相同：返回该请求的组成，`phase: "request"`。思考档位不影响组成，不参与比较。
  - 否则（草稿、还没发送、刚换模型、请求组成已作废）：返回按所查模型预演的下一个请求，`phase: "draft-preview"`。
  - `modelSelection` 是完整模型选择（含思考档位）；省略时用会话当前模型。所查模型在 provider 注册表里不存在时，模型工厂的错误原样返回给调用方。
- 通知：`v4/conversation/contextCompositionChanged`，参数 `{ sessionId, revision }`。live-only，不进 snapshot。
- 旧 CLI 不认识方法时返回 method-not-found（-32601）。App 侧把它当作 `null`，界面显示「当前版本不支持」。
- `transport.ts` 的 `V4_METHODS.conversationContextComposition` / `V4_NOTIFICATIONS.conversationContextCompositionChanged`；`bootstrap/src/zcode-protocol/server.ts` 只加一行 case，逻辑在 `zcode-protocol/context-composition/handler.ts`。

### 3.4 变更触发与修订号

修订号的唯一 owner 是 bootstrap 的 `ContextCompositionRevisionTracker`（每个协议 server 一份）。

- 每会话从 0 开始，CLI 进程内单调递增；runtime 重建（冷恢复）不重置。CLI 进程重启后从 0 重新开始，消费方以通知为准刷新，不跨进程比较。
- 查询在测量**之前**读修订号。测量期间又有变化时，后到的通知带更大的修订号，消费方按修订号丢弃旧结果。
- runtime 在下列事件同步调用监听器；tracker 用 `queueMicrotask` 把同一会话同一轮事件循环内的多次触发合并成一次「修订号加一 + 一条通知」，不用定时器。

| 事件                                  | 位置                                                                                             | 请求组成                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 主轮请求的分解算好                    | `model.ts` 的 `runModelTextRequest`                                                              | 记为最近一次请求组成                                  |
| 该请求完成，服务商 usage 到达（新增） | 同上，返回结果前                                                                                 | 补上 `providerInputTokens` 与 `providerContextTokens` |
| compact 完成                          | `compact-active.ts` 替换历史之后                                                                 | 作废                                                  |
| 工具缓存失效（MCP、页面工具变化）     | `config.ts` 的 `invalidateToolCache`                                                             | 作废                                                  |
| 上下文前缀重建                        | `context-refresh.ts` 的 `rebuildContextPrefix`                                                   | 作废                                                  |
| 换模型                                | `bootstrap/src/app/session-facade.ts` 的 `setModel` 调 `runtime.markContextCompositionChanged()` | 作废                                                  |

「作废」：这些事件之后下一个请求的组成必然不同，再返回旧请求的组成会误导，所以查询改为预演，直到下一次主轮请求算好分解。轮开始时也会重建前缀，因此每轮首个请求之前的查询都是预演。

事实：MCP 的 `list_changed` 在回合之间不会主动产生事件，只在回合开始时检查（`mcp.ts:222-266`、`turn-loop.ts:94`）。所以回合之间 MCP 工具变化要到下一轮才反映。本版不改。

### 3.5 草稿预演

runtime 方法 `getContextComposition({ modelSelection?, traceContext? })` 在需要预演时按下面顺序走，在 entries 的**副本**上模拟：

1. `ensureContextInitialized(trace, model)`（`context.ts:43-100`）
2. `initializeMcp`
3. 按所查模型新建 context builder 并 `build()`，`persistEnvInfo: false`，不写回 `contextBuilder`/`latestContextBuildResult`/历史（不调 `rebuildContextPrefix`）。前缀换成新结果，其后接历史的对话部分。
4. 用纯函数模拟输入附件与请求前公告，顺序同 `turn-loop.ts`：环境、模型、output style 指令 → ToolSearch 公告（`buildToolSearchAnnouncement`）→ 子代理列表（`collectRuntimeAgentListing`）→ 技能列表（`collectSkillsListing`）→ 计划模式提醒（`buildRuntimeModeReminderBody`）→ output style 提醒 → 指令、Git、日期（`buildRequestAnnouncements`）。
5. `prepareRuntimeProviderRequest`（内含 `buildToolExposure`）
6. 用 §3.1 的同一分类函数出结果

**不做**：

- 不调 `persistAnnouncements`。事实：它会落库，草稿上调用会让会话从 deferred 升为 immediate 持久化（`v4-bridge.ts:1273-1320`、`server-operations.ts:3213-3216`）。
- 不写历史，不发请求，不跑 hooks。
- 不做 IO 探测：环境公告沿用历史或启动快照（不重新探测 cwd 的仓库属性），Git 公告取启动快照（不调 `resolveGitContext`，也不消费 `sessionStartGitPrefetch`）。
- 不模拟需要 IO 或会消费一次性状态的提醒：todo 提醒（读 todo）、计划模式退出提醒、silent turn 提醒（只在非首步）、Memory 更新（取出即消费）。

**可接受的副作用**：`ensureContextInitialized` 会启动 MCP 连接、建记忆与 gen-ui 目录、在内存里装好 context 前缀（`context.ts:81,89,97,195`）。已有先例：技能面板也走这条路（`skill-reference-catalog.ts:21-24`）。这些在草稿首次发送时本来也会发生，都不落库。

### 3.6 App 侧

`IZCodeAgentService`（`packages/services/src/zcode-agent/zcodeAgent.ts`）加两个可选方法，实现在 `contextCompositionClient.ts`，`zcodeAgentService.ts` 只做接线：

```ts
getContextComposition?(
  params: ZCodeAgentContextCompositionParams, // { workspacePath, workspaceIdentity?, remoteSessionId?, sessionId, modelSelection? }
): Promise<ContextComposition | null>;
onDynamicContextCompositionChanged?(
  target: ZCodeAgentWorkspaceTarget,
): Event<ContextCompositionChangedEvent>; // { sessionId, revision }
```

- `getContextComposition` 是 existing-only：工作区没有运行中的 CLI 时返回 `null`，不为查询启动 CLI。CLI 返回 method-not-found 时返回 `null`，不抛错。其他错误照常抛出。
- 通知按 `sessionId` 路由到工作区；参数不合法时丢弃并记 debug 日志。
- 只服务本机工作区。远程工作区不接扩展数据泵（由第 2 段的 Window Host 决定）。

## 4. 测试（先写测试再实现）

| #   | 内容                                                                                                                | 测试文件                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | 分类：提醒（含 MCS system 提醒）、`app__` 工具、延迟加载工具、compact summary、指令与技能真实文本各落到正确的细类别 | `packages/core/tests/context-composition/classifier.test.ts`                                                                |
| 2   | 投影：粗类别只有现有 7 个值，且每个细类别投影到 §3.1 表里的粗类别                                                   | 同上                                                                                                                        |
| 3   | 预演无副作用：调用前后会话仍是草稿（未持久化），对话历史条目数不变，没有落库的公告                                  | `packages/core/tests/context-composition/runtime.test.ts`                                                                   |
| 4   | 修订号：每个 §3.4 事件触发监听器；同一轮内多次触发只发一条通知、修订号只加一                                        | 同上 + `packages/bootstrap/tests/context-composition/tracker.test.ts`                                                       |
| 5   | 查询：模型相同返回 `request`；换模型后返回 `draft-preview`；会话不在内存返回 `null`                                 | `packages/core/tests/context-composition/runtime.test.ts` + `packages/bootstrap/tests/context-composition/protocol.test.ts` |
| 6   | 条目上限：超过 50 条只取前 50；条目名截断到 200 字符                                                                | `packages/core/tests/context-composition/classifier.test.ts`                                                                |

协议层集成：`packages/bootstrap/tests/context-composition/protocol.test.ts` 真实走 `ZCodeProtocolAgentServer`，建草稿会话 → 调 `v4/conversation/contextComposition` → 拿到 `draft-preview`，系统提示词与内置工具不为 0 → 断言会话仍是草稿（`record.persistence === "deferred"`，存储里没有会话行）。
