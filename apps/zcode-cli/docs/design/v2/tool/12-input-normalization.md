# Tool Input Normalization 设计 v2

实现状态（2026-05-08）：已落地。adapter 层通过
`packages/adapters/src/model/tool-input-normalization.ts` 处理 `generateText()` 和
`streamText()` 返回的字符串化 tool input；executor 层通过
`packages/core/src/tool/input-normalization.ts` 在初始输入、`PreToolUse` hook 更新输入、
permission broker 修改输入后统一执行顶层 JSON safe parse 和 `runtimeInputSchema.safeParse()`。
回归覆盖位于 `packages/adapters/tests/tool-input-normalization.test.ts` 和
`packages/core/tests/tool-input-normalization.test.ts`，包含 malformed JSON 降级、runtime schema 默认值、
hook updated input 以及 broker modified input。

## 背景

部分 provider / model adapter 会把 tool input 以 JSON 字符串形式返回，而不是直接返回对象。例如：

```json
{
  "name": "Bash",
  "input": "{\"command\":\"python3 -c \\\"print(1)\\\"\"}"
}
```

如果 runtime 直接把这个字符串交给 tool handler，`inputSchema` / runtime schema 很容易在执行前失败，严重时还会把异常路径扩散到不该崩的边界。ZCode v2 需要把这类异常输入收敛为“可恢复的输入错误”，而不是让进程因为 JSON 解析或 tool 解析抛出未预期异常。

## 目标

1. 对“顶层 tool input 被包成 JSON 字符串”的 provider 异常做兼容。
2. 兼容逻辑必须分两层，避免把所有脏输入假设都压到单个 tool handler。
3. 两层都必须使用 safe parse；解析失败只能降级、记录诊断、继续走可恢复错误路径，不能直接打崩进程。
4. tool-aware 归一化必须通过显式契约完成，不能让 handler 之外的模块依赖某个 tool 的内部实现细节。

## 两层策略

### 第一层：Model Adapter 通用归一化

位置：`packages/adapters/src/model/*`

职责：

- 当 provider 返回的 `toolCall.input` / `toolCall.args` 是字符串时，尝试把它当成 JSON 解析。空串或只含空白的串
  直接当作 `{}`（没给参数），不算解析失败。
- 若解析成功，则把解析后的值作为 tool call input 继续向下游传递。
- 若解析失败，则返回带解析失败标记的 `{}`：标记是 symbol 键，值为原始字符串前 200 个码元的 preview 与原始长度
  （根目录 `docs/model-tool-call-validation.md`「Malformed tool input JSON」），并记录最小化诊断信息，例如 tool name、
  来源阶段、字符串长度。
- 诊断中不得写入完整原始 input，避免日志泄露用户内容。

失败语义：

- 不能抛出异常。
- 不能在 adapter 层把失败输入伪造成合法业务对象：`{}` 带着标记，executor 据此返回无法解析 JSON 的错误，不执行工具。
- 原始字符串不作为 input 往下传：tool_use 的 input 会进入 provider 历史与持久化 tool part，字符串在部分 provider
  协议下不是合法的 tool_use input，冷恢复时也会被写成 `{ value: <字符串> }`，与实时请求不一致。symbol 键不进 JSON，
  所以历史、持久化与 model-io 都是 `{}`。

覆盖范围：

- `generateText()` 的 `toolCalls`
- `streamText()` 中的 `tool_call` 事件

### 第二层：Tool Runtime 的 Tool-aware 归一化

位置：`packages/core/src/tool/*`

职责：

- executor 在 `validateInput`、permission、hook、handler 之前，对 tool input 再做一次 tool-aware 归一化。
- 这层先再次尝试处理“顶层字符串 JSON”残留，覆盖旧 transcript、hook 修改输入、permission broker 修改输入等非 adapter 来源。
- 然后使用 `runtimeInputSchema.safeParse()` 做安全归一化：
  - 若成功，使用解析后的标准化结果继续执行。
  - 若失败，保留前一步输入，继续走现有 `inputSchema` 校验与可恢复错误返回。

这里的“tool-aware”指：

- 每个 tool 的 runtime schema 决定默认值、字段裁剪、严格性和额外约束。
- executor 不写死 Bash / Read / Edit 的内部规则，只消费显式的 `runtimeInputSchema` 契约。
- 若未来某个 tool 需要 legacy 字段映射或更复杂兼容，应在同一层扩展，而不是散落到 handler 内部。
- `Read` 的 runtime schema 用 preprocess 修正 `offset` / `limit` / `length`（包括 `length` 改名为 `limit`），再做字段校验
  （规则见 [01-read.md「输入修正」](./01-read.md#输入修正)）。preprocess 只属于 runtime schema；provider-visible
  JSON Schema 仍从未包装的字段 schema 生成，tools 段字节不变。

失败语义：

- `safeParse` 失败不能抛出。
- 失败必须降级为正常的 schema validation / permission error 路径。
- 模型原始输入（initial）：JSON Schema 通过、但 runtime schema 失败且有可读 issues 时，executor 在 `validateInput`
  之前返回 `InputValidationError`（规则见根目录 `docs/model-tool-call-validation.md`）。需要友好文字的语义检查写在
  `validateInput`，不写进 runtime schema。
- hook 或 permission broker 返回 `modifiedInput` 后，必须重新执行第二层归一化。

## 执行顺序

tool runtime 调度顺序更新为：

1. adapter 层归一化 provider 返回的原始 tool input
2. executor 层 tool-aware 归一化
3. JSON Schema 校验；JSON Schema 或 runtime schema 失败时返回 `InputValidationError`
4. `validateInput`
5. `PreToolUse` hook
6. 若 hook 更新了 input，则再次执行第二层归一化
7. permission check / broker
8. 若 broker 修改了 input，则再次执行第二层归一化
9. handler 执行

## 非目标

- 不在本次实现中支持任意深度的递归嵌套字符串 JSON 自动展开。
- 不为了兼容错误输入而绕过 tool 的显式 schema。
- 不把 malformed JSON 静默替换成业务默认对象并继续执行有副作用的 tool。

## 测试要求

至少覆盖以下场景：

1. adapter 层把字符串化对象成功还原为对象。
2. adapter 层遇到非法 JSON 字符串时不抛异常，返回带解析失败标记的 `{}`；executor 不执行工具，返回无法解析 JSON 的错误。
3. stream `tool_call` 事件也使用同一归一化策略。
4. executor 层在 adapter 未处理到的情况下，仍能把字符串化对象恢复为对象。
5. executor 层会消费 `runtimeInputSchema.safeParse()` 的默认值或标准化结果。
6. executor 层遇到非法 JSON 字符串时不抛异常，而是返回现有的可恢复输入错误。
7. `PreToolUse` hook 返回 `updatedInput` 时，executor 必须重新执行第二层归一化。
8. permission broker 返回 `modifiedInput` 时，executor 必须重新执行第二层归一化。
9. `Read` 的 `offset` / `limit` / `length` 修正在 JSON Schema 校验之前生效，修正后的输入进入 handler。
