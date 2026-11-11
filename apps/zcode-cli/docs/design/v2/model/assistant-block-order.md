# Assistant 内容块顺序

Status: Implemented（2026-11-04，基于 `origin/feat/2.1.296` `7749873762`）

## 目标

一次模型响应里有思考、文字和工具调用三类块。本规格定义：

- 按模型输出的顺序保存这些块。
- 按固定规则把它们放回下一次请求。
- live 请求和冷恢复请求对同一条消息发出相同的字节。
- 旧消息（没有顺序信息）发出的请求字节不变。带浏览器轮尾截图的旧消息是例外，见「兼容」。

不改表结构，不做迁移。

## 问题

改动前，一条 assistant 回复存成三部分：

- `reasoning[]`；
- 一段文字，多个文字块之间直接拼接，没有分隔；
- `toolCalls`。

回放时固定排成 `[全部思考, 一段文字, 全部 tool_use]`。库里 part 的顺序是写库顺序，不是流顺序：
只读工具在流中写库，reasoning 和文字在流结束后写库。这带来三个问题：

1. 文字后面还有思考块时，文字被移到这些思考块后面。Anthropic 会校验思考块签名对应的前缀（这个块
   前面的全部内容）。在执行该校验的渠道上，前缀改变的请求返回 400
   （`The block is bound to a different conversation`）。真实 provider 回放已经证实：移动文字块、
   改变思考块前面的内容返回 400；只移动 tool_use 返回 200。
2. 多个文字块拼成一段，例如 `"Let me check.Now edit."`。
3. live 界面每个文字块一行，冷恢复后只剩一行。

## 术语

- **块**：一次 provider 响应里的一个 reasoning、text 或 tool 内容块。服务端执行的工具也是块。
- **blockIndex**：块在这次响应里的到达序号，见下文。
- **有序消息**：满足下文"有序判定"的 assistant 消息。其他 assistant 消息是**旧消息**。
- **条目**：MessageHistory 里的一个 assistant entry。含服务端工具的消息会拆成多个条目，
  见 [Anthropic Stream Compat](./anthropic-stream-compat.md)「Provider 内置工具多轮回放」。

## 数据流

```text
provider 流事件
   │  core 组装器为每个块分配 blockIndex（非流式路径由 adapter 按 result.content 分配）
   ▼
写库：reasoning / text / tool part 都带 blockIndex（写库时机不变）
   │
   ├─► 读取边界（session-store repository）：assistant 消息的 part 按 blockIndex 稳定排序
   │        └─► V4 冷恢复、旧协议映射、services、fork 都拿到流顺序
   │
   ├─► live：buildAssistantEntries(有序块) ─┐
   └─► 冷恢复：hydrator 判定为有序消息 ──────┴─► 同一个构造函数，产出相同条目
                    ▼
请求投影：transform 按 blockIndex 排列 content 与 toolCalls（所有 provider）
          Anthropic：空白文字过滤 + 工具调用后移 + 末尾思考块 ─► 其余交给 AI SDK
```

## blockIndex

### 含义

- 一次模型响应里块的到达序号，从 0 开始。
- reasoning、text、tool（包括服务端执行的工具）共用一个序号空间。
- 序号可以不连续，只用于排序，不表示数量。
- 服务端工具让响应分成多轮时，计数器不重置。

### 位置

| 位置                                                         | 字段                                                                                            | 校验                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 库：`TextPart` / `ReasoningPart` / `ToolPart`                | 顶层可选 `blockIndex?: number`，存在 `part.data` JSON 里，和 `ToolPart.declarationIndex` 同一层 | part 没有 strict schema；不进入 App 协议，message-mapper 只复制已知字段                                                            |
| 内存：`ModelToolCall` / `ToolCallInput`                      | 可选 `blockIndex`                                                                               | `modelInputMessageJsonSchema` 的 `toolCalls` 是宽松数组                                                                            |
| 内存：`ModelTextContentBlock` / `ModelReasoningContentBlock` | 可选 `blockIndex`                                                                               | 在 strict 的 `modelInputMessageJsonSchema` text / reasoning 分支里显式声明 `{ type: "integer", minimum: 0 }`；其他未知字段仍被拒绝 |

- 不放进 reasoning 的 `metadata`。hydrator 会把 `metadata` 原样变成 `providerOptions`，放在那里会
  让空 reasoning 的判定失效，也有进入请求的风险。
- 内存里的消息不落库，运行时也不校验 `modelInputMessageJsonSchema`。在 schema 里声明这个字段不会造成
  降级时丢数据。
- `transform.ts` 逐个字段构造 AI SDK part，`blockIndex` 不进入 provider 请求。

### 分配

只在两处分配：

**流式**（`core/src/runtime/methods/model.ts`，每次模型请求一个计数器）：

| 块        | 分配时机                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------ |
| reasoning | `getOrCreateReasoningBlock` 新建块时（覆盖没有 start 事件的 delta）                              |
| text      | `text_start` 新建块时。`text_delta` 找不到对应块，或者该块之后已经分配过其他块，就新开一个块     |
| tool      | `tool_input_start` 时。没有 start 事件的 `tool_call`（例如 `mcp_tool_use`）在 `tool_call` 时分配 |

- 不使用 provider 的序号。Anthropic 的 `tool_use` 事件 id 是 `toolu_…`，不是块位置。
- openai-compatible 在工具调用之后不关闭文字块，文字 id 会复用（`txt-0`），所以需要上面的"新开块"规则。
  这次响应里已经有文字块、新块又没有 `text_start` 时，补发一个 `text_start` 事件，让 live 界面分行。
  第一个文字块不补发，事件流和改动前相同。
- 工具调用的 `blockIndex` 在 push、`onStreamToolCall` 和服务端工具分轮之前写入调用对象。
- 结果和快照新增 `textBlocks`（`RuntimeModelTextResult`、`RuntimeModelStreamSnapshot`、
  `ProviderToolRound`、contracts `ModelTextResult`）。`text` 仍然是所有文字直接拼接，
  `modelResponse`、Stop hook、TUI 去重和 turn machine 不变。

**非流式**（`adapters/src/model/runner-generate.ts`）：按 AI SDK `result.content` 的顺序给 reasoning、
text、tool-call 编号，跳过 tool-result、source、file 等其他类型。结构化输出不分配。

### 写入

写库时机不变。每一次写入都带 `blockIndex`：

- reasoning part 带所属块的序号。
- 文字按 `textBlocks` 每块写一个 text part。空字符串块不写。
- 服务端工具轮次（`provider-tool-rounds/cards.ts`）里的 reasoning、每段文字和服务端工具 part 都带序号。
- tool part 的 pending、running、completed / error 每一次写入都带序号。同一个 part 的后续写入在
  `savePart` 里走冲突更新，整体替换 `data`（只保留 `fromModel` / `toModel` / `model`），漏写一次就会
  丢失序号。丢失后整条消息按旧消息处理，不报错也不打日志，排序回到改动前的布局。**维护约束**：新增
  tool part 写入点时，必须带上调用对象的 `blockIndex`。
- 取消时按快照里的 `textBlocks` 写（`cancelled-stream-persistence.ts`）。
- automation fallback 替换文字时，只写一个 fallback 文字块，序号取当前最大值加 1。
- `declarationIndex` 不再写入；读取逻辑保留给旧数据。

浏览器轮尾截图 part（`state.input.source === "browser_turn_end"`）不是模型块，不带 `blockIndex`。
识别时 `state` 或 `state.input` 缺失（损坏数据）按普通 tool part 处理，一个坏 part 不会中断整个会话的读取。

### 工具执行与结果顺序

本地工具的结果按 `blockIndex` 稳定排序后的顺序提交，排序只在 `executeToolCallsForModelStep` 做一次。
流中提前执行的只读工具在 `tool_call` 到达时就写 pending part 并开始执行；其余工具的调度、pending part 写入
和执行也按排序后的顺序进行。正常结束、断流恢复、执行模型回退三条提交路径都经过这里。

- 原因：工具的 `blockIndex` 在 `tool_input_start` 分配，`toolCalls` 却按 `tool_call` 到达排列。两者不同时，
  live 的结果按到达顺序，冷恢复（`selectToolPartsForHistory`）按 `blockIndex`，请求字节不同。只用一个顺序来源，
  live 与冷恢复的 tool_use 和结果顺序才一致。
- 只在所有调用都有合法 `blockIndex` 时排序；旧数据、未编号的非流式结果保持原顺序。
- Anthropic、Responses 的块依次到达，两种顺序相同，行为不变。openai-compatible 在流结束时按 index 发出
  全部 `tool_call`，只有后一个调用的名字先到达时两种顺序才不同；这时执行和结果顺序变为块开始的顺序。

## 读取

### 有序判定

一条 assistant 消息满足以下两条时是有序消息：

1. 至少有一个 reasoning、text 或 tool part；
2. 所有 reasoning / text / tool part 都有合法 `blockIndex`。浏览器轮尾截图 part 不参与判定。

不满足时按旧消息处理。不存在"部分有序"的处理方式。

`blockIndex` 是否合法，库、runtime、请求投影三层都用 contracts 的 `isBlockIndex`（非负整数）判定。
只有库这一层要求至少一个块 part：没有块 part 的旧消息留在旧路径，空消息的处理不变。

### 读取边界排序

session-store repository 的两个解码点（`messages()`、`messageWithParts()`）对有序消息做稳定排序：

- 只在 reasoning / text / tool part 占用的位置之间按 `blockIndex` 重排。
- step-start、step-finish、file 等其他 part 的位置不变。
- 序号相同时保持物理顺序。同一工具调用的重试 part 共用序号，"同一 callID 取最后一个 part"仍然成立。
- 旧消息保持物理顺序。

### 模型历史恢复

`session-history-hydrator.ts` 对每条 assistant 消息：

1. 先跳过浏览器轮尾截图 part。它不进入模型历史。live 从来不把它放进模型历史；以前冷恢复会把它变成
   一个工具调用加结果，导致冷恢复请求和 live 不同。UI 仍然从原始 parts 显示它。这一步对新旧消息都生效，
   带截图的旧消息因此有一次缓存未命中，见「兼容」。
2. 有序消息：把 part 映射成块，调用统一构造函数 `buildAssistantEntries`。本地工具结果按 `blockIndex`
   顺序输出。
3. 旧消息：现有逻辑不变。工具按 `selectToolPartsForHistory` 选择和排序：全部有 `blockIndex` 时按它，
   否则全部有 `declarationIndex` 时按它，否则按物理顺序。同一 callID 只取最后一个 part。

### 统一构造函数

`buildAssistantEntries({ blocks, model, usage, groupKey, keepEmptyFinal })`
（`core/src/agent/message-history.ts`）是 live 与冷恢复构造有序 assistant 条目的唯一入口：

- 按 `blockIndex` 稳定排序。
- 去掉没有内容的 reasoning（`hasAssistantReasoningContent`）和空字符串文字。
- 遇到服务端工具时分轮，分轮规则不变。
- 本地工具放进最后一个条目。
- `content` 是不合并的块数组，`toolCalls` 带 `blockIndex`。
- usage 只在没有分轮时附加。

live 调用方：`commitAssistantToTurnRequest`、取消路径、streaming coordinator 恢复路径、服务端工具轮次。
`createRuntimeAssistantEntry` 只用于旧消息、memory agent 和 turn-stop 的空 usage 锚点。它构造的是旧条目，
不带 `blockIndex`：非流式结果会在原对象上给 reasoning 编号，这里复制时去掉，旧条目不会被当成部分有序。

两个函数共用条目外壳和工具调用复制函数：工具调用只复制 id、name、input、modelCallWrapper，
`providerExecuted` 等运行时标记不进入历史；有序条目另外带 `blockIndex`。服务端工具的分组键都由
`withCompactGroupKey` 写入。

## 请求投影

### 排列（所有 provider）

`transform.ts` 构造 assistant 消息时，用 `orderedAssistantItems` 判定和排列：

- 所有内容块和工具调用都有合法 `blockIndex`：放在一起按 `blockIndex` 稳定排序，序号相同时内容块在前。
- 否则保持旧拼接 `[...content, ...tools]`。

这一步只改变顺序，不合并块。下面的 Anthropic 规则也用 `orderedAssistantItems`，所以两边的有序判定和
排列结果相同。

### Anthropic 规则

在 `reasoning-history-normalization.ts` 里按条目执行。只处理有序条目，在跨模型过滤之后计算。
这些规则只删除或移动块，不合并块。

**逐块合并**

规则 a 和 b 不是对整个条目各执行一次，而是按 `blockIndex` 顺序逐块加入：

1. 第一个块单独成为结果。
2. 之后每加入一个块，对"上一步结果 + 新块"先执行 a，再执行 b，得到新的结果。

前一步已经删除或移动的块不会恢复。所以结果和"对整个条目执行一次"在两种形态上不同：

- 空白文字是当前最后一块时，它后面还没有块，不满足"前后都是思考块"，会被删除（只剩思考块时除外）。
- 工具后面的思考块加入时，如果它前面的内容块不是思考块，工具已经被移到末尾；之后再出现
  "思考 → tool_use → 思考"也只影响剩余顺序。

**a. 空白文字过滤**

- 去掉纯空白的文字块。前后两个块都是思考块时保留。
- 过滤后只剩思考块时，放弃这次过滤，使用过滤前的块。

**b. 工具调用后移**

- 第一个 tool_use 后面还有非工具块时，把所有 tool_use 移到末尾，工具之间保持相对顺序。
- 例外：出现"思考 → tool_use(s) → 思考"时，保持原顺序。

请求里的顺序通过重新编号 `blockIndex` 表达，只改请求副本，不改 canonical history。

| 模型输出                          | 回放                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `[思考A, 文字P, t1, 文字Q]`       | `[思考A, 文字P, 文字Q, t1]`                                                   |
| `[思考A, t1, 思考B, t2]`          | 命中例外，原样                                                                |
| `[思考A, 文字P, t1, 思考B, t2]`   | `[思考A, 文字P, 思考B, t1, t2]`                                               |
| `[思考A, 文字P, t1, t2]`          | 原样（工具后面没有其他块）                                                    |
| `[文字P, t1, 思考A, t2, 思考B]`   | `[文字P, 思考A, t1, t2, 思考B]`（加入思考A时 t1 已后移；加入思考B时命中例外） |
| `[思考A, 空白, 思考B, 文字P, t1]` | 原样（空白在两个思考块之间）                                                  |
| `[文字P, 思考A, 空白, 思考B, t1]` | `[文字P, 思考A, 思考B, t1]`（加入空白时它是最后一块，被删除）                 |
| `[空白, 思考A, 文字P, t1]`        | `[思考A, 文字P, t1]`                                                          |
| `[t1, 文字P, t2]`                 | `[文字P, t1, t2]`                                                             |

**c. 末尾思考块**

`removeTrailingReasoning` 只处理请求里的最后一条消息。对有序条目，按请求顺序删掉末尾连续的思考块，
不重新执行 a、b。旧条目仍使用原规则。

**签名修复**

`removeRejectedReasoning` 追加的 `[Thinking removed]` 文字块，`blockIndex` 取最大序号加 1，然后重新
执行逐块合并。`repairEmptyAssistantContent` 不变。

修复成功后的 `signedReasoningReset` 标记（[Anthropic Reasoning History Replay](./anthropic-reasoning-history-replay.md)）
对有序条目同样生效：live 在 `buildAssistantEntries` 的结果上用 `markRepairedStep` 标记第一条 assistant；
冷恢复的有序分支按消息 metadata 对同一个构造结果做同样的标记，两边条目一致。之后的请求删除标记之前的
签名思考时也调用 `removeRejectedReasoning`，有序条目同样重新执行逐块合并，和修复那次发出的字节一致。

**d. 没有可见内容的回复**

没有工具调用、每个块都是思考或纯空白文字（含 `(no content)`）时，删除这条 assistant，有序条目和旧条目用同一条
判断。删除在 core 请求投影的第一步，只在 Anthropic Messages 协议执行
（[Anthropic Reasoning History Replay](./anthropic-reasoning-history-replay.md)「Core: which assistant messages exist」）。
adapter 不删除也不合并消息。字符串 content 和空数组不删除：完全没有输出的回复存成空字符串，带着 usage，
留作估算锚点；空数组的每个块都满足条件，也单独排除。

- 只有空白文字的有序回复（例如模型只回了 `"\n\n"`）会被删除。这是本次带来的变化：
  改动前没有思考块的回复 content 是字符串，这条规则只处理数组，所以不生效。live 发出 `"\n\n"`；
  冷恢复在没有 usage 时跳过这条回复，有 usage 时也发出 `"\n\n"`，两边可能不一致。现在有序条目的
  content 是数组，live 和冷恢复都删除，两边一致。旧消息仍是字符串，请求字节不变。
- `[思考A, "\n\n"]` 这类只有思考和空白的回复也删除，和只有思考块的回复相同。改动前它原样进入请求（规则 a
  删掉空白后只剩思考块，所以放弃过滤）；已有这类回复的会话升级后，从这条回复起前缀缓存失效一次；校验前缀的渠道
  还可能拒绝一次，由签名修复恢复（见 Anthropic Reasoning History Replay 的「Accepted effects」）。
- 删除按条目判断，不按相邻条目整段判断。相邻的 assistant 条目由 AI SDK 合成一条消息，只有下面两种来源；
  按条目删除都不会带来新的前缀变化：
  - 输出上限续写：续写提示只在本轮请求里，不写入历史，所以下一轮两段回复相邻。产出第二段的请求里，只有思考的
    第一段已经被删除（那时它后面是续写提示）。按条目删除时，第二段思考块前面的内容和产出时一致，只少续写提示
    （原有差异）；整段保留反而会把第一段的思考放回去。
  - 没有结果的服务端工具：只在中断收口本身失败时出现，而且只在 live 出现（冷恢复回放为 INTERRUPTED 结果，
    条目带工具调用，不删除）。这时这次调用已经从历史里丢掉，后面思考块前面的内容本来就变了。

### 交给 AI SDK 的行为

ZCode 不自己合并消息或文字块。所有协议都接受 AI SDK 的序列化结果：

- Anthropic：`groupIntoBlocks` 合并相邻 assistant 条目；只有请求的最后一条消息是 assistant 时，它的最后
  一个文字 part 被 trim；空字符串文字 part 被丢弃；消息级 cache control 只放在最后一个 part 上。服务端工具让一条消息
  拆成多个条目时，上面的规则只在各自条目内执行，不跨条目移动块。
- chat-completions：文字由 AI SDK 直接拼接。
- Responses：按顺序生成多个 item。只影响新消息。

## App 投影

- 冷恢复按排序后的 part 输出行，和 live 一样每个文字块一行。
- 反馈：`onAssistantFeedbackUpdated` 作用在该 entity 的最后一个文字行。UI 从最后一个文字行读取反馈；
  以前作用在第一行，多行时反馈不显示。
- 搜索索引：`zcodeTaskIndexSyncer` 把一条 assistant 消息的所有文字 part 按顺序直接拼接，还原成改动前
  那一个文字 part 的内容，再按原规则处理（trim、跳过空文字、总长上限）。普通消息的索引内容和改动前相同。
  服务端工具分轮的消息以前只取最后一个文字 part，现在包含所有轮的文字。
- session-transcript 和 subagent 查询用 `"\n\n"` 拼接文字 part。多个文字块的消息从 `"AB"` 变成
  `"A\n\nB"`，和 UI 复制结果一致。
- bots `/status` 的进度：任务运行中没有实时进度时，读最近一条 assistant 消息按顺序的最后一个块
  （`readLatestTaskProgress`）。多个文字块的消息现在显示最后一个文字块，以前显示整段文字。

## 兼容

- **旧消息**：走旧逻辑，请求字节不变，升级后没有一次性缓存未命中。例外是带浏览器轮尾截图的旧消息：
  以前冷恢复把截图回放成一次工具调用加结果，升级后不再回放（和 live 一致），所以从这条消息开始有一次
  缓存未命中。这是接受的代价。这条消息里其他工具的顺序也会变：截图 part 没有 `declarationIndex`，以前整条
  消息因此按物理顺序排列工具；跳过截图后，其余工具都有 `declarationIndex`，改按声明顺序排列。这个变化
  包含在同一次缓存未命中里。
- **混合消息**：只要有一个模型块 part 缺少 `blockIndex`，整条消息按旧消息处理，不报错也不打日志。
  当前所有写入点都带序号。混合消息只会来自降级后旧版本改写同一个 part，或者以后新增的写入点漏写
  （见「写入」的维护约束）。
- **降级**：旧版本忽略 `blockIndex`。它用 `"\n\n"` 拼接多个文字 part，把思考块放到最前，工具按物理
  顺序排列：新写入不带 `declarationIndex`，旧版本没有声明序号可用，流中先写库的只读工具排在前面。
  结果和新版本发出的字节不同，会有一次缓存未命中。如果某条消息里文字后面还有思考块，
  在执行签名校验的渠道上可能返回 400。旧版界面会多出几行，旧版搜索索引只取最后一段文字。

## 已知差异（不在本规格范围内）

- 服务端工具没有结果时：流结束、失败或取消时先按中断收口（[Anthropic Stream Compat](./anthropic-stream-compat.md)
  「中断收口」），live 与冷恢复都回放为 tool_use + INTERRUPTED 错误结果。只有收口本身失败时，live 才丢掉
  这次调用，冷恢复仍按 INTERRUPTED 回放。
- 已有本地工具提交时的断流恢复：live 不带这次 attempt 的服务端轮次，冷恢复却回放它（改动前已存在），见
  [本地 issue](../../../../../../docs/issues/stream-recovery-provider-round/01-cold-resume-replays-dropped-provider-round.md)。
- 用户中途停止时：live 不保留本地工具，冷恢复按 INTERRUPTED 回放。
- 停止时进行中的文字不单独成块。
- 空文字块（`""`）不写库，也不进入请求。两个思考块之间的空文字块因此不占位置：模型输出
  `[思考A, "", 思考B, 文字P]` 时，请求是 `[思考A, 思考B, 文字P]`。
- 在工具调用后移的例外形态下，assistant 条目可能以思考块结尾。这条 assistant 是最后一条非 system
  消息时，AI SDK 会丢掉消息级 cache control。

## 测试

- contracts / core：`json-schema.test.ts` 接受带 `blockIndex` 的 text / reasoning 块，仍拒绝其他未知字段。
- core：
  - 流式分配：Anthropic 事件序列；openai-compatible 工具后复用文字 id 的拆块；没有 start 事件的
    `tool_call`；服务端工具分轮时计数器不重置。
  - 每个写库点都写 `blockIndex`，包括 pending → running → completed 的重复写入。
  - 统一构造函数、hydrator 有序分支、`selectToolPartsForHistory`、截图 part 不进入模型历史。
  - 请求投影按条目删除：两条相邻 assistant 条目中只删只有思考的那条（输出上限续写的形态）。
- 字节一致性：真实 SQLite + 抓取 Anthropic 请求体，同一条交错消息 live 请求等于冷恢复请求。
- 旧数据：工具写库顺序和 `declarationIndex` 不一致、单个文字 part、带 reasoning 的旧消息，冷恢复后的
  历史与请求体和改动前布局完全相同。
- adapters：transform 排列且 `blockIndex` 不进入请求；逐块合并的形态表（缩写与 E2E I76 相同）、末尾思考块、
  adapter 不删除只有思考和空白的有序回复、签名修复（修复标记之前的有序条目在之后的请求里
  与修复那次重发的字节一致）；非流式结果对不上时整条不编号；
  repository 排序对旧数据和混合数据保持物理顺序，
  `state` 或 `input` 缺失的损坏 tool part 不中断读取。
- bootstrap：transcript-hydration 输出多个文字行；反馈落在最后一个文字行。tool-history-order 走真实 SQLite：
  服务端调用和本地工具共用序号（write=0、native=1、read=2），没有结果的服务端调用回放为中断错误结果，
  读取边界按 `blockIndex` 返回流顺序，live、冷恢复和回退后的请求相同；断流恢复用例按「已知差异」断言
  冷恢复多出的服务端轮次。另一个用例让 `tool_input_start` 的顺序
  和 `tool_call` 的到达顺序相反，live 与冷恢复的 tool_use 和结果都按 `blockIndex` 排列。
- prompt-trajectory：请求删掉纯空白文字块后，model-io 摘要仍能认出同一条回复，轨迹不拆分。
- 桌面 E2E（I76，`conversation-session/conversation-session-assistant-block-order`）：
  - 块形态在同一会话回放（S16 单独一个用例）：live 与冷恢复的行序；续发请求逐形态块顺序等于上面的规则表；
    冷恢复前后请求只在末尾追加；全部思考签名原样带回；同一会话的相邻主请求逐个比较抓到的请求体，
    都只在末尾追加，例外只有 S19 的续写。轨迹工具用 model-io 摘要重建响应，表示不了 S20 的服务端工具
    分轮，所以不用它判定。除了 Read 的形态，还有：
    - S18：Write 不是只读工具，流结束后才执行和写库。live 与冷恢复的行序都是文字 P、Write 卡片、文字 Q。
    - S19：响应因输出上限（`max_tokens`）停止。自动续写的请求按流顺序带回已经输出的块；之后的请求里，
      续写前后的两段回复按流顺序排列。续写提示不写入历史（TS09-CONTINUE），所以之后的请求去掉续写提示，
      续写文字接在原 assistant 消息末尾，原有的块不变。
    - S20：服务端工具（未知名称的 `server_tool_use` 加 `tool_result`）把一次响应分成两轮。序号跨轮不重置，
      行序和请求都按流顺序。
  - 停止时已完成的块、反馈落在最后一个文字行并在冷恢复后保留、任务搜索找到第一段文字、手机 `/remote` 行序。
  - 只有思考和空白的回复（S16）不进入续发请求：思考文字和空白都不发出，前后两条 user 都在请求里，冷恢复前后
    请求相同。
  - openai-compatible 在工具调用后继续输出文字：live 与冷恢复都分成两行，续发请求相同。
  - 旧消息：应用退出期间，把一条已完成的消息改写成改动前的存储格式（去掉 `blockIndex`，多个文字 part
    合并成一个，工具 part 写回 `declarationIndex`）。重启后的续发请求按旧布局
    `[全部思考, 一段文字, 全部 tool_use]` 发送。之后在同一会话追加新消息，冷恢复前后请求只在末尾追加，
    旧消息的字节不变。工具写库顺序和 `declarationIndex` 不一致的旧数据由单测覆盖。
- 桌面 E2E（`manual-review/pending/conversation-session-browser-use-iab-full-chain`）：轮尾截图 part 不进入
  模型历史。一轮只打开一次页面并正常完成，产生轮尾截图；冷恢复前后各续发一次，请求里只有模型发起的这一次
  工具调用，冷恢复前后截图这一轮的消息不变。冷恢复前续发的那条 user 消息不比较：live 在内存历史里给它加了
  内置浏览器上下文，存库只存用户原文，冷恢复后两者不同（改动前已存在，与本规格无关）。
- 只由单测覆盖（桌面没有触发入口）：
  - 非流式路径：adapter 按 `result.content` 编号，与已规范化的 text / reasoning / toolCalls 对不上时不编号，
    按旧数据处理。桌面协议端固定 `modelStreaming: "on"`。
  - 末尾思考块：只在请求的最后一条消息是 assistant 时生效。桌面请求的最后一条是 user 消息、续写提示或工具结果。
  - 签名修复占位块的 `blockIndex`：占位块总是在最后，有没有序号，请求字节都相同，E2E 无法区分。签名修复的
    重试流程由 I72 覆盖。
