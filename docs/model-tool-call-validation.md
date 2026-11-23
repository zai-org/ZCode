# Model Tool Call Validation

## 背景

provider 可能返回两类不同问题：

- 工具名为空，例如 `{ id: "call_x", name: "", input: {...} }`；
- id 与非空工具名存在，但 final `tool-call.input` 是 malformed JSON 或 `null`。

client-executed 调用的空字符串/纯空白工具名虽然无法命中 registry，但在 call id 可闭合时仍能
生成配对的 error tool result。该分支保留 provider 原始名称，按稳定恢复行为处理，
不猜测真实工具。参数损坏时同样保留调用身份，通过普通工具 schema / lookup 生成结果并让模型在
当前 run 中恢复，而不是把错误升级成整个模型请求失败。

## 工具身份

- 本次只恢复 `typeof toolName === "string" && toolName.trim().length === 0` 的
  client-executed 调用。原始空字符串或空白字符串必须保留，不得被 wire / storage 占位值覆盖。
- `toolName` 缺失或为 `null`、数字、对象等非字符串时，继续返回
  `invalid_model_response`。这是本次范围选择，不覆盖非字符串工具名的恢复。
- `providerExecuted=true` 的空字符串/纯空白名称继续返回 `invalid_model_response`。
- 合法非空名称继续 trim 后执行。
- 非空工具名即使未注册，也继续进入既有 tool lookup。找不到工具时，模型看到
  `<tool_use_error>Error: No such tool available: <name></tool_use_error>`（内部错误 message 仍是 `Tool not found: <name>`），runtime 生成与原 call id 配对的 `is_error=true` tool result。
- 缺失 call id 的既有兼容行为不在本 ticket 中修改，也不能与 malformed 参数恢复混为一类。
  `generateText` 继续使用现有 `toolCallId ?? id ?? crypto.randomUUID()`；streaming 不增加
  新的 id fallback。空名称仅在当前路径已有可闭合 id 时恢复。

空字符串/纯空白名称使用既有 registry-miss 生命周期：

```text
provider final tool call（原始名称）
                 │
                 ▼
client-executed + name.trim()==="" + id 可闭合
                 │
                 ├── 正常 finish ──> 强制 registry miss
                 │                     ├── 不运行 Hook / permission / handler
                 │                     ├── 同 id ToolCallError + error result
                 │                     └── sibling batch 闭合后 continuation
                 │
                 └── finish 前断流 ──> 既有 stream_recovery_interrupted_tool
                                       不改写为 registry-miss 错误
```

空名称 registry miss 使用两份明确分离的错误内容：

- UI / log error：`Model returned an invalid tool call: tool name is empty.`
- provider `modelContent`：
  `<tool_use_error>Error: No such tool available: ${rawToolName}</tool_use_error>`

普通非空 unknown tool 与空名使用同一段模型可见文本：`<tool_use_error>Error: No such tool available: <name></tool_use_error>`。

### 未知工具的后缀

基础句后面可以接一个后缀，放在 `</tool_use_error>` 之前：
`<tool_use_error>Error: No such tool available: <name><后缀></tool_use_error>`。
后缀只有一个来源：`describeUnavailableTool`（`core/src/runtime/helpers/runtime-tools.ts`），
按下面的顺序判定，取第一个命中的规则：

1. MCP 工具：server 仍在连接，或 server 不可用时，用既有的 MCP 状态句（见 `docs/mcp-async-tool-catalog-cache.md`）。
2. `Grep` 或 `Glob`（名称完全相同）：
   - 本上下文有 Bash：
     - ``. Grep is not available in this session — search file contents with `grep` via the Bash tool instead.``
     - ``. Glob is not available in this session — find files with `find` via the Bash tool instead.``
   - 没有 Bash：`. Grep is disabled for this session.` / `. Glob is disabled for this session.`
   - 破折号是 U+2014。这一条排在第 3 条之前：开启 embedded search 时 `Grep`、`Glob` 是没有注册的内置工具。
3. 内置工具（`builtInTools` 里有这个名称）但本上下文没有注册：
   - 子代理（`taskType` 是 `subagent_child`）：`. <name> is not available inside subagents. Complete the task with the tools provided and return your findings in your final response.`
   - 其他：`. <name> is not among the tools available here. Continue with the tools you have.`
4. 不区分大小写时恰好匹配一个已注册的工具：`. Tool names are case-sensitive: call <已注册名称> instead.`
5. 其他情况没有后缀。

修复原因：原来只有 MCP 工具有后缀。大小写写错（`read`）、调用已移除的 `Grep`、子代理里调用 `Agent` 时，
模型只看到 `No such tool available`，不知道该换哪个工具，容易重复同一个调用。后缀只追加在新结果里，
已发送的历史不改写；UI 与日志里的 `Tool not found: <name>` 不变。

## Provider、持久化与 App 投影

runtime assistant/tool-result history 始终保存 provider 原始名称。只有协议要求非空的边界使用
固定占位值 `empty_tool_name`：

| API 格式 | assistant tool call | tool-result wire |
| --- | --- | --- |
| `anthropic-messages` | 原始空字符串/空白字符串 | `tool_result` 不携带 name |
| `openai-chat-completions` | `empty_tool_name` | tool message 不携带 name |
| `openai-responses` | `empty_tool_name` | `function_call_output` 不携带 name |

- 显式 `apiFormat` 优先；格式缺失时仅 `providerKind="anthropic"` 保留原始名称，其他 provider
  使用 `empty_tool_name`。不得根据 URL 猜测协议。
- `ToolPart.tool` 保存 `empty_tool_name`，`ToolPart.metadata.providerToolName` 保存原始名称。
  判断 metadata 是否存在必须使用 `providerToolName !== undefined`，不能使用 truthy 判断。
- pending、running、completed/error 及 streaming synthetic 生命周期都保留同一 top-level
  metadata。hydration 优先恢复原始名称，再由当前 provider 格式决定 wire 投影，因此 provider
  切换不会把存储占位值误当成模型原始名称。
- App 可见产品态只按空名恢复的结构化证据静默过滤，不能只比较固定占位字符串：live
  `model.streaming` 中原始名称 trim 后为空时不生成 V4 `ToolCallRow`；持久化 `ToolPart` 只有在
  `ToolPart.tool="empty_tool_name"` 且 `metadata.providerToolName` 存在并在 trim 后为空时，才不映射
  legacy message tool part、cold hydration 工具行或可见 footprint。过滤同时适用于 desktop
  continuous 与 web remote replayable。
- 空名恢复调用不发布 `ToolCallScheduled`。scheduler、registry-miss、持久化 `ToolPart`、provider
  error result 和 continuation 均保持不变；后续 `ToolCallError` / batch terminal 事件不会反向创建
  产品工具行。
- `empty_tool_name` 不是保留工具名。没有上述 metadata 的裸 `ToolPart.tool="empty_tool_name"`，以及
  live 中模型原始返回的同名非空调用，都按普通合法工具名执行和展示。这样内置、alias、MCP 或插件
  注册同名工具时不会发生“实际执行但产品静默”的身份碰撞。
- App / remote mapper 不暴露 `providerToolName`；公共协议与旧 session 无需迁移。旧数据没有
  metadata 时继续使用 `ToolPart.tool`，包括按普通工具展示裸 `empty_tool_name`。普通非空 unknown
  tool 不经过静默过滤，仍显示既有 terminal error 工具行。
- `tool_input_start` 与 `model.streaming` 保留原始空名称；占位值只用于要求合法非空名称的
  App / storage 或 OpenAI-compatible wire 边界。

## Malformed tool input JSON

Adapter 只解析 AI SDK final `tool-call.input`；流式 delta 仅用于展示。AI SDK 解析失败时，final `tool-call` 的
`input` 就是模型发出的原始字符串（`invalid: true`），流式与非流式相同。统一归一化规则为：

- `undefined`、缺失 input、空字符串或只含空白的字符串 → `{}`，不记录 parse-fail（只含空白与空串同样当作没给参数，
  不报“无法解析 JSON”）；
- string input 至多剥离一个前导 BOM，再使用严格 `JSON.parse`；
- JSON 解析失败 → warn 一次（`recovery: "unparsed_marker"`），返回带解析失败标记的 `{}`（见下）；
- 解析结果为 `null`、或原生 input 为 `null` → warn 一次（`recovery: "empty_object"`）并降为普通 `{}`；
- 其他非 string 值保持原值，由普通工具 schema 判断；
- 不进行 partial JSON repair，不裁剪尾部或补括号猜测模型意图。

```text
AI SDK final tool-call(input)
              │
              ▼
       严格归一化一次
        │             │                    │
        │ valid       │ null               │ JSON 解析失败
        ▼             ▼                    ▼
   parsed input   warn + {}        warn + {} 带解析失败标记
        │             │                    │
        └──────┬──────┘                    ▼
               ▼                  工具存在 → 不执行，返回
       普通工具 lookup / schema    InputValidationError（无法解析的 JSON）
```

解析失败标记是 `{}` 上的一个 symbol 键（`@zcode/contracts` 的 `markUnparsedToolInput` /
`readUnparsedToolInput`），值为 `{ preview, length }`：`preview` 是原始字符串的前 200 个 UTF-16 码元（末尾是高位代理时
去掉它），`length` 是原始字符串的 UTF-16 长度。symbol 键不进 JSON：provider 请求、持久化 tool part、model-io、
协议事件与日志看到的都是 `{}`，与原来相同；标记只在进程内跟着同一个 input 对象到达 executor。

executor 先查工具是否存在（未知工具仍返回 `No such tool available`），再看标记；有标记时在 schema 校验、
`validateInput`、hook 与权限之前返回同 id 的 `is_error=true` 结果，工具不执行：

```text
<tool_use_error>InputValidationError: <Tool> was called with input that could not be parsed as JSON.
You sent (first <n> of <len> bytes): <preview>
Common causes: unescaped backslashes in file paths (use / or \\), unescaped control characters, or truncated output. Retry with valid JSON.</tool_use_error>
```

`<Tool>` 是规范工具名；`<n>` 是 preview 的长度；文字里写 `bytes`，计数实际是 UTF-16 码元。
`(use / or \\)` 是两个反斜杠。UI 与日志的 `error.message` 是 `Tool input could not be parsed as JSON`。
DeferredToolCall 的包装入参解析失败时，名称是 `DeferredToolCall`（`19-tool-search.md`）。

修复原因：原来解析失败降为 `{}` 后走普通 schema：有必填参数的工具报“缺少参数”，原因写错，模型会补字段重试，
不会修正转义；没有必填参数的工具直接用空输入执行。

## Provider-visible input validation error

首次模型输入未通过 `inputSchema.safeParse` 时，runtime 格式化完整校验错误，
并返回同一 tool call id 的 error tool result：

```text
<tool_use_error>InputValidationError: ${formattedError}</tool_use_error>
```

Provider projection 必须保留以下字段和值，不增加内部 telemetry metadata：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "<原 tool call id>",
      "is_error": true,
      "content": "<tool_use_error>InputValidationError: ...</tool_use_error>"
    }
  ]
}
```

该 formatter 先把 issues 分成四类：

1. missing：`invalid_type` 且 message 包含 `received undefined`；
2. unexpected：`unrecognized_keys`，每个 key 拼在 issue 自身 path 之后（`a.b`、`a[0].b`）；
3. wrong type：其余 `invalid_type`；
4. other：其余所有 issue。

精确行模板为：

```text
The required parameter `${path}` is missing
An unexpected parameter `${path}` was provided
The parameter `${path}` type is expected as `${expected}` but provided as `${received}`
The parameter `${path}` is invalid: ${message}
```

路径使用字符串字段的 `.` 与数字字段的 `[n]` 连接，空 path 输出空字符串。wrong type 的
`received` 从 issue message 使用 `/received (\w+)/` 提取，无法提取时使用 `unknown`。
other 行的 message 去掉开头的 `Invalid input: `（或整句 `Invalid input`），超过 500 个码元时保留前 500 个并加
`… [+<剩余数> chars]`；path 为空时主语写 `The input`；message 为空时，`invalid_union` 写
``The parameter `${path}` matches none of the accepted forms``，其他写 ``The parameter `${path}` is invalid``。

前三类存在任一项时，输出 missing → unexpected → wrong type 的行，再接最多 20 行 other；other 超过 20 行时加一行
`(<n> more issue not listed)`（`n` 大于 1 时写 `issues`）：

```text
${toolName} failed due to the following ${lineCount > 1 ? "issues" : "issue"}:
${lines.join("\n")}
```

`lineCount` 是输出的全部行数。修复原因：原来有前三类时，同一批的其他错误（范围、格式、枚举）
整行丢掉，模型修好缺参后还要再错一次；嵌套对象里的多余参数只写 key，看不出在哪一层。

前三类均不存在时，完整返回 Zod 4 error
message：issues 数组使用 zod 自带的英文默认 message（不设置自定义 error map 或 locale），
并通过带 bigint-to-string replacer 的 `JSON.stringify(issues, replacer, 2)` 序列化。
provider-visible formatter 使用完整 issue 列表，不受内部日志最多保留 20 条错误的限制。

首次模型输入同时存在 runtime normalization 与 provider JSON Schema 两个既有边界：

```text
runtimeInputSchema.safeParse（zod 4）
       │
       ├── success ──> normalized input ──┐
       │                                  ▼
       │                     provider JSON Schema gate
       │                        │ success        │ failure
       │                        ▼                ▼
       │                  validateInput     JSON Schema issues ──┐
       │                  → hooks / permission                   │
       │                                                         │
       └── failure                                               │
             ├── 有可读 issues ──> runtime issues + provider 补充 ─┤
             │                                                   ▼
             └── 无可读 issues ──> raw input ──> JSON Schema gate（同上）
                                                                 │
                                                                 ▼
                                               exact error modelContent
                                                                 │
                                                                 ▼
                                               same-id, is_error=true tool result
```

- runtime parse 成功时，用 JSON Schema 校验归一化后的输入；失败时使用 JSON Schema issues。
- runtime parse 失败且有可读 issues 时，在 `validateInput`、hook 与权限之前返回
  `<tool_use_error>InputValidationError: …</tool_use_error>`。可读 issue 指带 `path` 数组、字符串 `code` 与 `message`
  的 issue 对象。issues 以 runtime issues 为准（顺序不变），provider schema 比 runtime schema 严格的地方由 JSON Schema
  issues 补上：
  - runtime 在某个位置报 `invalid_union`、JSON Schema 在同一位置没有 union 失败时（例如 Skill 的 runtime schema
    兼容旧字段 `name`，provider schema 只有 `skill`），换成 JSON Schema 在这个位置之下的 issues；
  - 多余参数（`unrecognized_keys`），以及 provider schema 要求、没有默认值、runtime 没有报的缺参，追加在后面。
- runtime parse 失败但没有可读 issues 时，raw input 进入 JSON Schema gate；JSON Schema 也通过时保持原流程。
- 没有 runtime schema 的动态工具（MCP 等）继续使用完整 JSON Schema issues。
- JSON Schema 校验器检查两种 union：`anyOf` 至少匹配一个分支，`oneOf` 恰好匹配一个分支；不满足时都报
  `invalid_union`。同一节点同时写了 `anyOf` 和 `oneOf` 时两个都检查，都要满足，各自报自己的 `invalid_union`。
  同一节点上的其他关键字（`type`、`required`、`properties`、`additionalProperties` 等）照常检查。
  工具契约生成的 union 与 nullable 字段都是 `anyOf`。修复原因：校验器原来只认 `oneOf`，工具 schema 改成 `anyOf`
  后，hook / 权限改写后的输入和只靠 JSON Schema 的输出校验不再检查这些字段；union 检查完原来直接返回，同一节点的
  其他关键字被跳过，MCP schema 里“anyOf + required / additionalProperties”的节点因此少查。MCP 工具 schema 里的
  `anyOf` 从这次起也会检查；必填的 union 字段缺失时报 `invalid_union`（与 zod 4 相同），不报缺参。之后的修复原因：
  支持 `anyOf` 时最初写成“有 `anyOf` 就只查 `anyOf`”，MCP schema 里与它同级的 `oneOf` 被跳过，不合契约的入参会
  进入 hook、权限和 MCP 调用。

修复原因：JSON Schema 查不了 URL / regex 格式、`exclusiveMinimum`、去空白后的长度和跨字段规则。这些输入原来
一路通过 hook 和权限（有的还弹出确认窗），到 handler 的 runtime parse 才失败，模型收到没有包装的原始 ZodError
JSON。例如 `WebFetch {"url": "not a url"}` 要先确认再失败。

这些输入不再运行 PreToolUse hook，所以 hook 的 `updatedInput` 不能修正 runtime schema 不通过的原始输入（例如给
不带 scheme 的 url 补上 `https://`）。顺序与目标版本相同：先校验，再运行 hook。

内置工具的 runtime schema 都使用 zod 4（工具契约 `@zcode/contracts` 与 core 用同一个 zod 版本），runtime
issues 的结构、message 与顺序就是目标版本的输出，不再转换结构或重排顺序。superRefine 的 issue 按 `addIssue` 对象
的 key 顺序输出，所以工具契约里的 `addIssue` 按 `code`、`path`、`message` 书写，与 refine 生成的 issue 顺序相同。
修复原因：工具契约原来使用 zod 3，executor 先把 zod 3 issue 转成 zod 4 结构，再与 JSON Schema issues 逐条配对、
补充和重排。转换只覆盖一部分 issue 类型，JSON Schema 一侧有参数问题时 runtime 独有的问题不输出，数组边界的
顺序也要单独调整。工具契约改用 zod 4 后删除转换与配对，只保留上面两条 provider schema 补充规则。

需要友好文字或错误码的语义检查写在工具的 `validateInput`，不写进 runtime schema 的 refine：runtime schema 失败会
先返回上面的 InputValidationError，refine 的文字会变成 JSON。这次从 refine 移到 `validateInput` 的有 Read 的 `pages`、
设备文件与二进制扩展名（01-read.md）、SendMessage 只有空白的 `message`、WebSearch 同时给 `allowed_domains` 和
`blocked_domains`（13-websearch.md）。hook 改写后的输入不再经过 `validateInput`，这三个工具的 handler 用同一个检查再
拒绝一次。AskUserQuestion 的唯一性等规则仍在 runtime schema 里，按 InputValidationError 返回。

这样默认值与 preprocess/transform 语义来自实际 parser，不在 JSON Schema validator 中重新
推断；formatter 只消费一份 issues（runtime 失败时是上面选出的 issues，否则是 JSON Schema issues）。
参数类错误仍按 missing → unexpected → wrong type 分类输出。

本契约仅对应模型原始 arguments 的首次 schema failure。schema 成功后执行的
工具级 `validateInput` 属于语义/环境校验，失败内容不经过参数错误 formatter；REPL inner tool call 是独立调用点。
延迟工具还没有被 ToolSearch 发现时，
schema failure 会在错误正文后接一段发现提示，这段提示在 `</tool_use_error>` 之内，规则见
`apps/zcode-cli/docs/design/v2/tool/19-tool-search.md`。

PreToolUse hook 改写后的输入用 JSON Schema 再校验一次。失败时用同一个 formatter 输出逐条问题，结果不包装
（与 hook 拒绝相同）：

```text
PreToolUse hook for <Tool> returned updatedInput that failed schema validation: <formatter 输出>
The tool input from the model was valid; the hook's rewrite of it was not.
```

修复原因：原来只有 `Tool input failed inputSchema validation`，模型以为是自己的输入错了，会改输入重试。
ZCode 合并多个 hook 的结果后不知道改写来自哪一个 hook，所以不写 hook 来源。

该逻辑没有 provider/model gate；所有支持工具调用的模型共用同一分支，不增加模型专属判断。

实时执行与冷恢复必须向模型投影同一份 error content：

```text
live ToolExecutionResult.modelContent
                │
                ├──> 当前 turn 的 provider history
                │
                └──> error tool part metadata.modelContent
                                      │
                                      ▼
                         resume / hydration provider history
```

- `ToolStateError.error` 继续保存通用 UI / log 错误，不改成 provider wrapper。
- error result 仅在 `modelContent` 本身为 string 时将其附加保存到
  `ToolStateError.metadata.modelContent`；本次不扩展结构化内容的持久化协议。
- hydration 优先使用 string 类型的 `metadata.modelContent`，旧数据、缺失值或非 string 值继续
  fallback 到 `state.error`，无需迁移。
- `metadata.modelContent` 仅供 Agent 冷恢复使用，映射 App / remote 消息时必须移除，不改变
  ZCode protocol 或 UI 可见 tool metadata。
- hydration 不根据当前工具 schema 重新格式化历史错误，避免 schema 或 formatter 版本变化改写
  模型当时实际看到的内容。

## 数据与诊断边界

- 原始 malformed string/null 不得进入 provider-visible history、持久化 tool part 或结构化 warn；
  JSON 解析失败时，原始字符串只以前 200 个码元的 preview 出现在无法解析 JSON 的错误正文里。
- string 只记录真实 `inputLength`；原生 null 记录 `inputType: "null"`，不伪造长度。
- warn 记录 `toolName`、`source`、parse error 类型和恢复方式，每个 final malformed call
  只记录一次。
- streamText、generateText 与 model-io 复用同一归一化结果，避免二次解析、重复 warn，
  或诊断内容与 runtime 实际输入不一致。
- AI SDK 为 invalid call 生成的 `tool-error.input` 按 call id 复用 final call 的归一化 input；
  不允许 raw malformed string/null 从 `toolResults` 进入 runtime 或 model-io。
- model-io 的结构化 `response.toolCalls` 与 `response.toolResults` 记录归一化后的 `{}`，
  不记录 raw malformed input。
- 空字符串/纯空白工具名的 model-io、runtime history 与内部持久化 metadata 保留原始值；
  由空名投影产生的 `empty_tool_name` 仅用于上述非空边界，不得回流 registry lookup。provider 原始
  返回的同名非空字符串仍是普通工具身份，可以正常 registry lookup。
- 更底层 provider raw 取证继续遵守既有采集与脱敏边界。

## 验收标准

- client-executed 空字符串/纯空白工具名生成同 id `is_error=true` tool result，模型收到
  `<tool_use_error>Error: No such tool available: ${rawToolName}</tool_use_error>`，同一 turn
  继续请求。
- 空名称强制 registry miss，handler、Hook、permission 与 `ToolCallStarted` 均不运行；普通
  非空 unknown tool 文案不变。
- Anthropic assistant history 保留原始名称；Chat Completions 与 Responses 的 assistant
  tool call 仅在 wire 边界使用 `empty_tool_name`，三者 tool-result wire 均不携带 name。
- 正常 streaming finish 进入 registry miss；final 后、finish 前断流仍返回既有
  `stream_recovery_interrupted_tool`。
- live/cold hydration 都恢复 `providerToolName` 和精确 `modelContent`；App message/snapshot
  不物化原始空名称或带空 `providerToolName` metadata 的占位工具行，也不暴露 provider 原始空名称
  metadata。裸 `empty_tool_name` 无该 metadata 时按普通工具展示；旧 session 无需迁移。
- 注册名或 alias 恰为 `empty_tool_name` 的合法调用正常发布 streaming/scheduled/result 生命周期、
  执行 handler 并在 live/cold/legacy 产品态展示，不得被空名恢复静默逻辑误伤。
- missing/非字符串名称、provider-executed 空名称、既有 id normalization 和一般 ToolCall Hook
  lifecycle 均不改变。
- 884 字符 malformed AskUserQuestion fixture 输出 `input={}`（带解析失败标记），只 warn 一次，不抛
  `invalid_model_response`。
- string `"null"`、原生 null、BOM、undefined、空字符串和合法 object 均按上述矩阵处理。
- partial JSON 不修复。
- JSON 解析失败的调用不执行，生成同 id `is_error=true` 的无法解析 JSON 错误，并在同一 run 发起下一次模型请求；
  `"null"` 与原生 null 降成的普通 `{}` 仍走 schema：required-schema 工具报 InputValidationError，接受 `{}` 的工具正常执行。
- 未注册但非空的工具名生成同 id `Tool not found` error result（JSON 解析失败时也一样）。
- parallel batch 中 malformed、正常和未知调用都闭合后，再进入下一次模型请求。
- provider-visible 下一轮消息使用 `tool_use.input={}` 和配对的
  `tool_result.is_error=true`；原始字符串只以 200 个码元的 preview 出现在错误正文里，冷恢复读持久化的同一段正文。
- 首次 schema failure 的 `tool_result.content` 使用完整
  `<tool_use_error>InputValidationError: ...</tool_use_error>`；不得退化为
  `Tool input failed inputSchema validation`。
- session 恢复后仍使用持久化的同一份 string provider content；旧 session 缺少该 metadata 时
  保持使用既有 `state.error`。
- missing、unexpected、wrong type 与非参数 fallback 的顺序、换行、单复数、路径及
  Zod 4 JSON message 均以源码 golden 做 byte-for-byte 验证。
- runtime parse 失败时，issues 的顺序与 runtime parser 相同，provider schema 补充的 issues 在后；
  至少覆盖 regex + sibling bound、field refine + sibling enum 两类生产 schema，以及多余参数、provider 独有缺参、
  runtime union 换成 provider issues 三种补充。
