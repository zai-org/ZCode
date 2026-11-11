# 模型请求输出上限策略

更新日期：2026-08-13

本文说明 zcode-cli 如何把模型级 `maxOutputTokens` 转换为每次请求的输出预算。桌面本地、
远程 workspace 和手机 Web 远控复用同一条 agent 请求链路，策略一致。

## 模型级预算

ModelFactory 根据 Effective Model Config 创建 Active Model。普通 Turn 从
`model.optionSpecs.maxOutputTokens.max` 选择输出预算，再应用本轮 preflight cap；Compact summary
取该上限与 20,000 的较小值。最终预算通过请求级 `options.maxOutputTokens` 传入 Model，
不属于长期 ModelSelection，也不从 Settings 旧结构、Catalog、Provider ID 或 modelId 重新推断。

```ts
const effectiveMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
```

32K 不是独立的全局 hard cap。模型声明 64K 时 effective 为 64K，声明 16K 时 effective
为 16K；不再用 `min(modelMaxOutputTokens, 32K)` 二次裁剪。

Built-in 通用 Model Config Rule 负责声明完整默认 Option Spec；具体模型和 Personal Rule 只覆盖差异叶子。
因此 Active Model 的 `optionSpecs.maxOutputTokens` 总是完整；请求级预算仍须通过 Model 校验。

## Provider 请求字段

core 只计算本轮最终 `maxOutputTokens`，不再附带请求类别或 Provider 字段提示。Active Model 的
`optionSpecs.maxOutputTokens.map` 将这个最终数值映射为目标 API Schema 的原始 JSON 字段：

- **Anthropic Messages**：通常映射为 `max_tokens`；
- **OpenAI Chat Completions**：通常映射为 `max_completion_tokens`，兼容协议可以声明 `max_tokens`；
- **OpenAI Responses**：映射为 `max_output_tokens`。

Adapter 在 AI SDK 完成基础序列化和协议兼容之后、请求安全校验与网络发送之前执行该 Map。它不再同时向
AI SDK 传递通用 `maxOutputTokens`，也不再保留 32K fallback、Provider ID 分支、fixed-thinking
加减或原始字段清洗。具体映射只属于命中当前 `providerId/modelId/api.type/baseURL` 的 Model Config
Rule，完整契约见
[Model Option Map 与原始请求体](./working-memory/provider-refactor/design/model/model-option-map.md)。

## 固定预算策略（3.12.2）

所有新 Runtime（桌面本地、远程 workspace、手机 shared-host、纯 CLI、子 Agent）统一使用
`preflight-v1`。不再消费 `client/configs.modelContextBudget.strategy`；兼容旧 Host 的协议字段
仍接受 `legacy`，但在本版本 Runtime 边界归一到共享常量 `DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY`。
运行中的旧进程不热切换；升级后创建或冷恢复的 Runtime 采用新规则。

`getModelContextBudgetStrategy()` 保留服务兼容接口，但仅返回共享常量，不读缓存、不发请求、
不启动计时器或后台刷新。本地 Host 与 remote workspace 偏好桥直接使用共享常量；
`runtime-materialization` 和 `user-execution` 都只读取必要本地 Settings，仍保持 scope 隔离。
预算值不写 Settings、数据库或 provider 配置；已有 client-config 请求与其他消费者完全不变。

```text
必要本地 Settings + 固定 preflight-v1 -> runtime preferences -> Runtime -> 子 Agent
client/configs -> 套餐/页面/实际闲时工具创建（不参与预算或聊天启动）
```

原因：旧实现为可回退算法在每次 Runtime 创建时等待远端最多 5 秒，重复创建会串行放大等待。
统一算法后删除远端选择和 legacy 分支，不用额外缓存、超时或后台任务补偿。

## Auto Compact 输入窗口

统一最多保留 21K 输出窗口，不再应用 legacy 的 95% threshold：

```ts
const outputReserve = Math.min(effectiveMaxOutputTokens, 21_000);
const inputWindow = Math.max(0, contextWindow - outputReserve);
const compactThreshold = Math.max(0, inputWindow - 13_000);
```

128K context、64K output 时，reserve 为 21K，effective input 为 107K，compact threshold 为 94K。
输入 `legacy` 或旧 percent override 也不改变该算法；小于 21K 的输出上限原样保留。
Auto Compact 的 token 来源、13K buffer、失败熔断和时间线语义不变。

## 主请求 Preflight Cap

在每个主模型 step（包含 tool continuation）发送前复用 Auto Compact 已有的
usage estimation：从当前 provider-visible message projection 尾部向前查找最近一条已经提交、且
带有有效 `tokens` 的真实 assistant。该 assistant 的 provider usage 作为上下文基线，只对它之后的
消息做本地增量估算；找不到有效 assistant 时继续做全量本地估算。usage 归属直接来自既有的
`AssistantMessageInfo.tokens`，不新增第二份 `providerUsage` 持久化字段，也不持久化绝对消息下标
作为 anchor。响应尚未提交到 history 时不会参与扫描。Compact 替换 provider-visible 的旧前缀后，
preserved assistant 的原始 usage 不再代表当前上下文；运行时和冷启动 projection 只在 preserved
消息的副本上将 usage 归零。Compact 之后新增的 assistant 不在该范围内，仍保留自己的 tokens；
持久化 transcript 中的原始 tokens 不被修改。没有 preserved segment 的旧 Compact 数据继续使用
兼容路径。

本地增量复用 Compact 的共享估算器：每条消息按 `ceil(provider-visible 字符数 / 3)` 估算，
assistant 的 tool call 名称和序列化入参也计入字符数。OTB09 以 `inputTokens=1` 和
255,984 字符 user message 锁定边界；该 provider usage anchor 已覆盖上一轮 assistant，
因此 suffix 只估算 anchor 后的两条消息：新用户消息 85,328，以及同轮 token 预算提醒
（独立隐藏 user 行，`<system-reminder>` 包裹后 86 字符）29：
`estimatedCurrentUsage = 1 + 85,328 + 29 = 85,358`。因此 128K context 下本轮发送
`max_tokens = 128,000 - 85,358 - 1,000 = 41,642`。

```ts
const estimatedAvailable = Math.floor(contextWindow - estimatedCurrentUsage - 1_000);
const finalMaxOutputTokens =
  Number.isFinite(estimatedAvailable) && estimatedAvailable > 0
    ? Math.min(effectiveMaxOutputTokens, estimatedAvailable)
    : effectiveMaxOutputTokens;
```

- 不设置 minimum sendable，也不对 `<3000` 增加分支；2,999 或 1 都按计算值发送。
- Reasoning Map 与输出上限 Map 分别读取各自的最终 Option value；core 不在此处推断 Provider 的
  thinking budget。
- Cap 仅属于当前 model step，不修改 request、Settings 或模型配置；Compact 后重新计算。
- Compact summary、title、TCV、workspace/internal 请求不使用 Preflight Cap。
- 裁剪后仍超窗时不做 provider 数字解析或 reduction retry，继续进入既有错误分类和 reactive
  compact。

### 混合长度 Smoke 合同

使用两组固定 seed 验证从 baseline、连续 cap 到 Auto Compact 的完整链路：

| 场景                                  | effective input window |                 cap 起点 | Auto Compact threshold |
| ------------------------------------- | ---------------------: | -----------------------: | ---------------------: |
| `64K context + 48K maxOutputTokens`   |      `64K - 21K = 43K` |   `64K - 48K - 1K = 15K` |      `43K - 13K = 30K` |
| `200K context + 128K maxOutputTokens` |    `200K - 21K = 179K` | `200K - 128K - 1K = 71K` |    `179K - 13K = 166K` |

```text
空 Session
   |
   v
固定 seed 的不同长度真实用户消息
   |
   +-- estimated usage <= cap 起点 --> max_tokens=baseline
   |
   +-- cap 起点 < estimated usage < Auto Compact threshold
   |        `--> max_tokens=min(baseline, context - usage - 1K)，至少连续两轮单调缩小
   |
   `-- estimated usage >= Auto Compact threshold
            `--> Auto Compact summary(max_tokens=20K)
                                      |
                                      v
                              继续原 pending user message
                                      |
                                      v
                              按压缩后 usage 重新计算 cap
```

200K/128K 场景的尾部使用少量细粒度消息，把实际 `max_tokens` 依次推进到约 34.3K、
33.1K；理论边界为 `200K - 166K - 1K = 33K`。下一条消息刚跨过 166K threshold 后必须先
Compact，不应再发送等于或低于 33K 的主请求。这样同时覆盖边界两侧，但不引入大量微小轮次。

这里的“用尽窗口”指用到 preserve 21K 与 13K buffer 共同定义的 effective input threshold，
不是绕过 Auto Compact 强行填满原始 context window。测试只固定两组输入长度序列与 synthetic
provider usage，不引入运行时随机 seed、provider 错误、工具调用、queue 或远程控制组合。

## Compact 请求边界

Compact summary 使用 effective 值与现有 20K 任务预算中的较小者：

```ts
const compactSummaryMaxOutputTokens = Math.min(effectiveMaxOutputTokens, 20_000);
```

因此 effective=16K 时 Compact 请求使用 16K，effective=64K 时使用 20K。
Compact 只决定本轮 `maxOutputTokens` value；它与 reasoning level 按相同 Option Map 链在最终原始
请求体上投影，不再经过 Adapter 的 fixed-thinking 预算换算。

## Output-limit Continue 恢复

正常 Main Agent、Subagent 和 workflow child 共用同一条 output-limit 恢复逻辑。一次模型成功响应在
没有完整 tool call，且满足以下任一 stop reason 时进入恢复：

- normalized `finishReason === "length"`；
- raw reason 为 `max_tokens`、`max_output_tokens` 或 `model_context_window_exceeded`。

成功响应的 `model_context_window_exceeded` 有有效 partial 时仍按上述 Continue 恢复。
新增例外仅为明确超窗且没有正文、有效 reasoning（含 opaque metadata）或完整工具调用：
Adapter 在成功 finish/completed 前将其转换为已有 `ModelContextExceeded`，由 Core 原有异常
恢复路径执行 Reactive Compact，再重试当前请求，不追加 Continue。usage 不参与空输出判定。

原来空内容也走三次 Continue 是有意设计；此次只修改该空超窗边界。有效 partial 继续保留
正文/思考并按原规则续写，普通 `length` 和输出 token 上限不改，Core 原有成功超窗兼容分支
及其解释注释保持不变。Adapter 不判断能否 Continue，也不改变非流式 metadata 透传。

协议 adapter 的标准归一化边界如下；runtime 只消费 normalized/raw 事实，不从 HTTP event 名称重新推断：

| 协议                 | provider raw 终态                                                     | adapter normalized finish reason |
| -------------------- | --------------------------------------------------------------------- | -------------------------------- |
| Anthropic Messages   | `stop_reason=max_tokens`                                              | `length`                         |
| Chat Completions     | `finish_reason=length`                                                | `length`                         |
| OpenAI Responses API | `response.incomplete` + `incomplete_details.reason=max_output_tokens` | `length`                         |

部分非标准 OpenAI-compatible 服务会在 Chat Completions 返回
`finish_reason=max_tokens`。AI SDK 对该未知枚举保留 `rawFinishReason=max_tokens`，normalized 值可能为
`other`；runtime 的 raw-reason 兼容分支仍会继续恢复。adapter focused wire test 固定这个
`other + raw=max_tokens` 例子，Desktop OTC11 则使用两种标准协议各自的原生终态验证端到端归一化。
Runtime 一旦结合 normalized/raw reason 和完整 tool-call 事实确认本 step 属于 output-limit，必须在生成
`ModelComplete`、usage fact 和 transcript finish 前把 canonical `finishReason` 统一为 `length`；adapter
network/model-io、Runtime diagnostics 与 `providerMetadata.rawFinishReason` 仍保留 provider 原始事实。

真正以 request error 抛出的 context overflow 不属于本节，继续走既有 Reactive Compact。完整 tool
call 的优先级高于 output-limit；判断使用 adapter 已经完成组装的全部 tool calls，而不是只看本地可执行
tool calls。例外是服务端内置工具轮次（见 `apps/zcode-cli/docs/design/v2/model/anthropic-stream-compat.md`
「Provider 内置工具多轮回放」）：这些调用在流中已切成带结果的前序轮次单独提交，不属于本 step 的最终调用，
不参与本判断；最后一轮被截断时照常续写。web_search 等未切轮的 provider 调用仍按完整 tool call 处理。只有命中上述 output-limit 判据时，text、reasoning 和 usage 全空的响应才允许恢复；其他空
响应继续走 suspicious-empty 错误。

恢复最多追加 3 条 user-role Continue，因此一次恢复链最多产生 4 次正常模型请求。文案必须保持
完全一致：

```text
Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.
```

Continue 是 query-local 普通 user message，不包装为 `<system-reminder>`。它对本轮后续 provider 请求
可见，但不进入 canonical `MessageHistory`、Session event/transcript、UI user bubble、hydration、fork /
edit 输入或 latest-real-user 判定。Turn 结束时 query-local 状态直接消亡，不执行清理、history cursor
同步或整体 copyback。

Compact 同样遵守这一边界：待总结部分即使含有先前的 Continue，实际 provider 请求仍保留它，
但 `querySource=compact` 的 `ModelRequest` 事件必须使用过滤后的 recordable projection，
不能把实际请求数组直接写入事件。回归测试覆盖两次 Continue 后触发 Reactive Compact，
确保 Continue 对 summary 请求可见、对事件和持久化消息不可见。
Anthropic wire 验收同时覆盖一条和三条 Continue：相邻 user 合并后，准确文案及出现次数不变，
不引入 `<system-reminder>` 包装。

```text
Turn 入口
  query.entries = [...borrowReadOnlyRuntimeEntries()]   # O(n) 指针浅快照
        |
        v
每次 outer loop
  requestEntries = [...query.entries]                   # 请求前浅展开
        |
        +-- output-limit --> query = [...request, partial assistant?, Continue]
        +-- tool ---------> query = [...request, assistant, tool results]
        +-- Compact ------> query = compactResult.entries
        `-- 正常完成 -----> Guide / Stop Hook / Turn complete
```

entry/message/content 在进入 `MessageHistory` 或 query state 后按不可变值使用。同步即时只读使用
`borrowReadOnlyRuntimeEntries()`；跨 `await` 的 query/Compact 边界只复制数组指针，不调用
`toRuntimeEntries()` 深克隆内容。provider projection 是请求前唯一必要的内容克隆边界。

### Partial、Compact 与外部输入

- 有真实 text 或 reasoning 时，当前 assistant 按既有 step 路径提交；恢复尚未耗尽且两者都为空时，
  不向 canonical/query-local history 追加空 assistant。第 4 次耗尽的持久错误边界见下节。
- `TurnResult.response` 仍只返回最后一次真实模型响应，不把多段 partial 拼接成一个字符串。
- output-limit 分支在 Guide 和 Stop Hook 之前返回 outer loop。恢复链正常结束后，两者恢复既有行为。
- 恢复期间暂停 pending runtime commands、异步 project-memory update 和新 runtime notice 的消费，保证
  `partial assistant → Continue` 是原子序列；Abort、Micro/Auto Compact、MCP/tools、projection 与
  token budgeting 保持运行。
- Micro/Auto/Reactive Compact 使用当前 query-local entries。Compact boundary 和 summary 立即按既有
  规则持久化；独立存在的 Continue 从 canonical post-compact entries 过滤，恢复计数不因 Compact 重置。
  Manual Compact 没有 query-local 输入，继续直接使用 canonical history。
- Compact recent-preserve 沿用既有边界：普通 assistant 可以进入 preserved segment，带
  `info.error` 的 transcript error carrier 不进入 provider history。次数耗尽时真实 partial 与 error
  carrier 分开持久化，因此不需要扩展 Compact 的消息分类规则。
- 恢复链视为一个原子 Turn：链内模型、语言或 output-style 刷新不改写当前 query-local prefix；若刷新与
  turn-local Compact 并发，Compact 提交 canonical history 时保留已经刷新的 canonical prefix，使变更只
  在下一独立 Turn 生效。
- canonical transcript 仍逐请求保存每条真实 partial assistant，`TurnResult.response` 也仍只返回最后一次
  response；展示归约只发生在 V4 ProductProjection。只有 `ModelComplete` 同时明确携带
  `stopReason="length"`、`toolCallCount=0`，且下一正文位于同一 product turn 并与上一条
  `assistantText` 视觉紧邻时，投影才重新打开原 row 并直接追加，不插入换行。最终 row 的稳定 `rowId`
  不变，message/action 身份推进到最后一条 assistant。tool、reasoning、可见 user、timeline、不同
  product turn、非 `length` 以及缺失 tool-call 事实都会保留原有分段。

```text
p1 text ─ ModelComplete(length, tools=0) ─ p2 text ─ ... ─ p3 text
   │                    同 turn 且紧邻                    │
   └──────── ProductProjection: 同一 assistant row ──────┘

tool / reasoning / user / timeline / turn boundary
   └──────── ProductProjection: 新 assistant row
```

### 次数耗尽与 usage

第 4 次响应仍命中 output-limit 时，不发送第 5 次请求。若响应存在真实 text 或 reasoning，先把它作为
不带 `info.error` 的普通 assistant 连同真实 usage 提交；随后用新的 message ID 向 Session transcript
单独写入一条 error-only assistant 和对应 `step-finish`。若响应完全为空，则只写入 error-only carrier。
carrier 的 `tokens` 使用全零占位，不能成为 usage anchor，也不进入 live 或 cold-hydrated provider
history。它直接使用既有 assistant error 结构：稳定错误码放在 `error.name`，
`data.message/retryable/attribution` 分别恢复错误文案、UI recoverable 和 provider source，不扩展通用
hydration 规则。请求级真实 usage 仍由既有 `ModelComplete` 和 usage observability 记录。
随后复用现有 `ModelError` / `TurnError` 收口向实时 UI 展示错误，不再追加 `TurnComplete(success)`。
该错误只终止当前 Turn command，不新增 `CoreErrorType`、不结束 Agent runtime 或交互式 CLI 进程，
错误展示文案也不进入 provider history。所有上述 output-limit reason 统一使用中性文案
`The model's response exceeded the output token maximum.`。

恢复链不维护额外的 usage snapshot 或绝对 message cursor。带有真实 text、reasoning 或 tool call 的
partial assistant 会连同归一化后的 `tokens` 一起提交到 canonical 与 query-local history；下一次请求继续
使用既有的反向扫描，从最近一条有效 assistant usage 开始，只对其后的 Continue 等消息做本地增量估算。
Anthropic Messages 协议下，只有思考的 partial 在请求投影第一步被删除（见
[Anthropic Reasoning History Replay](../apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md)），
反向扫描看不到它的 usage，从更早一条有效 assistant usage 开始估算；思考用完输出上限的处理另行设计。
空 output-limit 在前三次恢复中间态不生成 assistant entry 或 transcript message；次数耗尽时仅保留上述
durable error-only assistant。它在 live 和 cold hydration 后都不覆盖上一条有效 usage，也不进入 provider
history；有真实 partial 时，普通 assistant 保留原始 usage，独立 error carrier 仍为零 usage。
恢复结束后 query-only Continue 自然消失，下一独立用户消息仍位于最近一条 canonical assistant 之后，
因此无需重锚或清理临时 usage 状态。
Compact 继续通过 post-compact entries 自身的 assistant tokens 决定有效基线，不增加 Continue 专用失效逻辑。

### 自动化证据边界

Continue 的自动化按责任边界分三层，不把同一状态矩阵复制到 Desktop：

- Core runtime tests 覆盖 normalized/raw reason、空响应、text/reasoning partial、三次上限、次数耗尽、
  partial assistant 与 error-only carrier 分离、carrier 的零 usage/provider 隔离和 cold error 恢复、streaming/non-streaming/tool 优先级、Abort、Guide/Stop Hook、
  外部通知、Main/Subagent 共用循环，以及 raw-compatible output-limit 向 live/durable `length` 的统一归一化。
- Compact focused tests 覆盖 Micro/Auto/Reactive 对 query-local entries 的处理以及恢复次数不被 Compact
  重置；既有 Manual Compact tests 继续证明 canonical 默认路径。
- Agent E2E 使用本地 scripted OpenAI-compatible provider，穿过 Bootstrap app、真实 adapter、HTTP request、
  SessionStore 和冷恢复，验证准确 Continue wire、无第 5 次请求、真实 partial 持久化、耗尽终态的
  durable error-only assistant、下一 Turn/runtime 可继续以及该 carrier/Continue 都不泄漏到冷恢复请求。
- E2E helper 必须等待异步 App 创建，并透传 `resume/sessionId`；冷恢复断言确认 session 身份和原历史，
  不能仅检查新请求没有 Continue。case 声明的 context/output 上限必须进入完整、有效的 Provider Registry，
  输出 Option Map 按协议写入真实请求体；Continue case 固定 100,000 context 和 16,000 output，
  正常恢复及冷恢复请求均验证 `max_tokens=16000`，不得被 helper 的通用默认值覆盖。
- ProductProjection focused tests 验证 live 的严格复用谓词、累计正文、最终 action/message 锚点和边界
  负例；transcript hydration focused tests 验证持久化 `assistant.info.finish="length"` 能重建相同 cold
  结果，不把 Continue user 注入事件或协议。
- Desktop OTC08 使用 case-local provider replay，验证三次真实主请求最终只形成一个累计 assistant DOM
  block；该 pending manual-review case 在确认转正前不进入默认 conversation gate。
- Desktop OTC11 将 OTC09 的相同 Markdown 拼接缝分别穿过 Chat Completions 与 Responses API，验证两种
  标准协议都归一化为 `length`、触发相同 Continue 链并形成一个累计 assistant DOM block。
- OpenAI-compatible adapter wire test 单独固定非标准 Chat `finish_reason=max_tokens` 对应
  normalized `other` 与 `rawFinishReason=max_tokens`，避免 Desktop 标准协议 case 混淆兼容输入。
- Anthropic wire test 只补相邻 user 序列化后的准确文案；不为每个 BYOK provider 复制完整恢复循环。

Continue 不形成新的 user row、协议事件、delivery state 或 React 特判。desktop `continuous` 与 mobile
`replayable` 消费同一份服务端 ProductProjection 结果；实时 `TurnError` 到既有产品投影的通用映射继续
由 Bootstrap 的错误投影测试承担。

## 派生 child runtime

Subagent 继承父 runtime 创建时固定的 context-budget strategy；在实际 `childModelRef` 确定后，
从当前 runtime catalog/overlay 解析对应模型的
`contextWindow` 和 `maxOutputTokens`，再由同一个 32K fallback 公式构造 child runtime。
registry refresh 只影响之后创建的 child；已经运行的 child 不动态改变预算。

普通 workflow child 和 script workflow child 通过父 main runtime 的 `runtimeConfig` 创建，因此同样
继承父 runtime 创建时固定的 context-budget strategy；它们不单独向 Host 请求 strategy，也不在
运行中热切换。本策略不改变 workflow child 的其余生命周期、模型选择或工具行为。

## Context exceeded 恢复

Adapter 在 Error、`cause` 和标准 JSON response body 中识别 provider 明确报告的超上下文错误。
标准 response body 的 `error.code` 与 `error.message` 都属于识别输入；不能只读取外层
`APICallError.message`，因为兼容层常把外层统一写成 `Bad Request`。

当前只收录官方文档或官方仓库中可以与其他 400/422 错误稳定区分的形态：

| 来源                             | 可识别信号                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| OpenAI-compatible / Azure OpenAI | `context_length_exceeded` 等既有 context code；或 `maximum context length` 的明确 token 超限文案 |
| Anthropic                        | `prompt is too long`；既有 `model_context_window_exceeded` stop reason/code                      |
| Google Gemini                    | `input token count ... exceeds the maximum number of tokens allowed`                             |
| Alibaba Cloud Model Studio       | `Range of input length should be [1, ...]`；`Total message token length exceed model limit`      |
| BigModel                         | 既有 provider business code `1261`                                                               |

资料来源：

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Anthropic context window overflow behavior](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-overflow-behavior)
- [Azure OpenAI Chat Completions context error](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
- [Google Gemini CLI official repository issue #10199](https://github.com/google-gemini/gemini-cli/issues/10199)
- [Alibaba Cloud Model Studio error codes](https://help.aliyun.com/en/model-studio/error-code)
- [Mistral known limitations](https://docs.mistral.ai/resources/known-limitations)
- [DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes/)
- [MiniMax error codes](https://platform.minimaxi.com/docs/api-reference/errorcode)
- [Amazon Bedrock runtime errors](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)

OpenAI Responses 在关闭自动截断时只承诺超窗会返回 `400`，没有给出稳定的专用错误内容；Mistral
同样只说明通用 `400 Bad Request`，DeepSeek 只列出通用 `400 Invalid Format` /
`422 Invalid Parameters`，Amazon Bedrock 只给出通用 `ValidationException` / `400`。这些状态码
不能与其他无效请求稳定区分，因此不做状态码兜底。MiniMax `1039` 同时可能表示输出
`max_tokens` 限制，也不直接归类为上下文溢出。

命中后继续归类为 `ModelContextExceeded`，交给 core 每个 model-step 重试链最多一次的 reactive
compact；完整 tool result batch 后进入下一 model step 才重新开放：

```text
provider error
      |
      v
adapter context signal classifier
      |
      +-- 未命中 --> 原有 400/422 分类
      |
      `-- 命中 --> ModelContextExceeded
                         |
                         v
                  reactive compact
                         |
                         v
                 replay current model step
```

该恢复路径复用 compact 模块的快速回填熔断，不在 adapter 新增另一套重试或压缩状态。

## 约束

- Effective Model Config 的 Option Spec 声明输出上限；执行链从该上限计算请求级预算，ModelSelection 不保存输出预算。
- Built-in 通用 Rule 提供完整默认值；32K 若作为默认值，也只能在该 Rule 中声明，不能在请求路径 fallback。
- 主请求、Target Completion Verification、Auto Compact 和 Microcompact 使用同一个
  effective 值。
- Compact summary 使用 `min(effective, 20_000)`。
- Provider 字段差异只由当前 Effective Option Spec 的 `map` 表达，不改变通用预算结果。
- 所有 Option Map 都在最终 JSON Request Body 边界执行，并先于官方版本的请求安全校验。
- 仅在现有 session runtime preferences 协议增加可选 strategy，缺失默认 `preflight-v1`；不新增 public
  capability、Settings 入口或全局环境变量。
- 非 output-limit 的空回复完成态、既有 reactive compact 次数、错误识别和其他自动重试保持不变。
- `legacy` 只保留协议输入兼容，不再保留运行期算法分支。
