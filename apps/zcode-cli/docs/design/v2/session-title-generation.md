# Session Title Generation

## 背景

ZCode 目前在首次持久化 session 时直接从用户输入截断得到 `session.title`。这个标题稳定、便宜，但对长 prompt、带上下文的需求、中文/英文混合输入和文件附件场景不够可读。

核心约束：

- 用户标题和 AI 标题分开，用户手动标题永远优先，AI 标题是增强元数据，每个会话至多生成一次。
- 在 root session 的首条真实用户消息后异步生成标题，并写回 session metadata。
- 标题生成是低风险 sidecar 能力，不能影响主 agent loop，不能覆盖用户明确命名，必须进入数据库和 session event，方便本地 TUI 的 session list、resume 和 debug 复用。

## 目标

1. 仅本地 TUI root interactive session 的首条真实用户消息完成后，自动生成更可读的标题。
2. 标题生成使用 `ModelRole.Lite`。如果未配置 `model.lite`，必须使用当前默认/main 模型，不能报错或强制用户配置第二模型。
3. 标题生成默认禁用继承自主会话的 thinking/reasoning 控制字段，避免短 sidecar 请求跟随 high/max 思考档位变慢或浪费输出预算。
4. AI 生成标题只能覆盖默认/首输入标题，不能覆盖已生成的 AI 标题或用户自定义标题。
5. 标题结果写入 `SessionStorePort`，并由 SQLite adapter 持久化。
6. 标题更新发出可观测的 session event，包含 traceId/sessionId/turnId/modelRef/source。
7. 生成失败、超时、不可解析或模型尝试返回无效内容时保留当前标题，不影响主 turn。

## 非目标

- 不新增环境变量。是否启用、超时、模型选择走 runtime config/session config。
- 不给 child session、subagent session、workflow child、fork session 自动改名。
- 不把标题生成做成 tool，也不允许调用工具。
- 不在 TUI 层直接访问模型或数据库；TUI 只负责启用 runtime config，并消费 session projection/list/event。
- 不给 ZCode app-server、headless `--prompt`、SDK/测试宿主默认开启标题生成。它们只有在显式传入 `runtimeConfig.titleGeneration` 时才会触发。
- 不在第一版实现手动 `/rename` 命令，但数据库和 port 必须为 `custom` 标题保留不可覆盖语义。

## 数据契约

`SessionInfo` 增加可选标题元数据：

```ts
type SessionTitleSource = "default" | "first_input" | "generated" | "custom";

interface SessionInfo {
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  time: {
    titleUpdated?: number;
  };
}
```

SQLite `session` 表增加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title_source` | text not null default `first_input` | 标题来源。 |
| `title_message_id` | text null | 生成/设置标题所依据的 user message。 |
| `time_title_updated` | integer null | 标题最近更新时间。 |

`SessionStorePort.updateSession` 支持标题 CAS：

```ts
interface UpdateSessionInput {
  title?: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId | null;
  expectedTitleSources?: SessionTitleSource[];
}
```

当 `expectedTitleSources` 不为空且当前 `title_source` 不在列表中时，adapter 必须 no-op 并返回当前 session。AI 标题写入使用 `["default", "first_input"]`，因此已生成的 `generated` 和用户自定义 `custom` 都不会被迟到或重复的 AI 结果覆盖。

## 触发规则

标题生成由 core runtime 发起，但必须由外层宿主显式启用。第一版只有 CLI TUI 入口传入 `runtimeConfig.titleGeneration`；headless `--prompt`、ZCode app-server session、workflow child 和外部 SDK 宿主默认不传这个配置。

启用后仍需满足：

1. `sessionStore` 和 `modelAdapter` 都存在。
2. `titleGeneration.enabled !== false`。
3. 当前 session 为 root interactive session：无 `parentSessionId`，`taskType` 缺省或为 `interactive`。
4. 当前 turn 是恢复后计数意义上的首个真实用户 turn。
5. user prompt 不是 summary、compact、rewind、hook synthetic、slash command 展开或纯空白。
6. 持久化的 session title source 是 `default` 或 `first_input`。

第 4 条的 turn 计数和 runtime 内存里的“已尝试”标记都会在冷恢复时重建：compact 后 active 历史如果只剩摘要和隐藏提醒（保留段里没有真实用户消息），计数会回到 0，新 runtime 的标记也是初始值。所以“是否已生成”只以第 6 条的持久化来源为准：发请求前读一次，`generated` / `custom` 直接跳过，不发标题模型请求；写回时再用 CAS 兜住并发。例外是首次 `/goal`：它借同一个标题请求生成 goal 摘要标题，来源为 `generated` / `custom` 时仍会请求，但结果只写 goal 摘要，不写会话标题。

第一版在主 turn 完成后启动异步 sidecar 请求；它不进入主 `TurnResult.usage`，但会发自己的 model request/model complete/session title event。

## Bootstrap 与入口边界

bootstrap 不做全局自动启用。它只在已经存在 `runtimeConfig.titleGeneration` 时补齐标题模型引用和 provider options。

CLI TUI 入口创建 app 时传入：

```ts
runtimeConfig: {
  titleGeneration: {},
}
```

headless `--prompt` 和 `--target` 不传 `titleGeneration`，因此不会多发一个后台模型请求，也不会影响脚本输出和退出时机。app-server 会话同样不传 `titleGeneration`，避免协议客户端在一次 prompt 之外收到额外成本、事件和模型调用；未来若 ZCode protocol client 明确需要标题，可先设计协议能力和展示语义，再显式打开。

测试或外部宿主注入自定义 `modelAdapter` 时，除非显式传入 `runtimeConfig.titleGeneration`，否则不自动发起标题请求，避免破坏宿主自定义模型调用编排。

## 模型选择

当入口显式启用标题生成时，bootstrap 生成 `titleGeneration.modelRef`。

模型选择顺序：

1. 如果配置了 `model.lite`，使用 `model.lite` 的 provider/model。
2. 如果没有 `model.lite`，使用当前默认/main provider/model。
3. 两种情况下 event 中的 `modelRef.role` 都是 `lite`，表示请求用途是轻量 sidecar。

provider options 与最终 provider/model 对齐；`model.lite` 没有配置时复用默认/main provider options。发送标题请求前会做 title 专用转换：

- 保留 endpoint、apiFormat、metadata、extra body 中与连接或非思考行为有关的字段。
- 先读取原始 reasoning options，再移除继承自主请求的 `effort`、`reasoningEffort`、`reasoning_effort`；禁止在删除后根据空 options 反推模型能力。
- Anthropic namespace 如果带有 `thinking`，改为 `thinking.type = "disabled"`，并移除 effort。
- OpenAI namespace 仅对明确支持 `none` 的 GPT 基础模型写入 `reasoningEffort = "none"`；其他模型只移除继承的 effort，不伪造 provider 不支持的禁用值。
- OpenAI-compatible namespace 优先按已有形态禁用：`thinking.type = "disabled"` 或 `enable_thinking = false`。GLM-5.2 以及明确支持 `none` 的 GPT 基础模型如果原始 options 仅有 effort，则转换为 canonical `reasoningEffort = "none"`。
- MiniMax M3 即使没有 reasoning options，也按已有 `apiFormat` 写入官方关闭参数：OpenAI Chat 使用 `openaiCompatible.thinking.type = "disabled"`，Anthropic 使用 `anthropic.thinking.type = "disabled"`，Responses 使用 `openai.reasoningEffort = "none"`。这只影响 title sidecar，不改变主请求或模型档位。
- Kimi K3、GPT Pro/Codex、MiniMax M2.x 等没有安全 off 合同的模型只移除 inherited effort，不伪造 `none` 或其他关闭字段。其余没有 reasoning options 的模型保持原样。

这样主对话仍可使用用户选择的思考强度；标题、goal summary title 这些共享 title sidecar 的短请求不会继承主链路的 high/max thinking。

## Prompt 与输出清洗

系统 prompt 要求：

- 生成 3-7 个词的可识别标题。
- 历史里有 `language` 公告时，用最近一次公告的语言：`Write the title in <Language>. Keep technical terms and code identifiers in their original form.`；没有公告或最近一次是清除公告时，跟随用户主要语言（`Use the user's primary language.`）。会话标题与 goal 摘要标题共用这条规则。`<Language>` 从公告正文按模板反解，再用它重建正文，与原正文逐字相等才用（附件 metadata 只有来源名）；不额外向 Host 读取（见 [Agent 回复语言](../../../../../docs/i18n/agent-reply-language.md)）。
- 句子式大小写；保留专有名词、文件名和技术名。
- 不输出解释、markdown、编号、引号或多行文本。

清洗逻辑：

1. 去除 `<think>...</think>`。这是兼容模型未遵守禁用字段的输出清洗，不代表请求侧允许继承 thinking。
2. 优先解析 JSON `{ "title": "..." }`；兼容模型把 JSON 包在完整 Markdown fenced code block（语言标记为 `json`）中的返回；失败则取首个非空文本行。
3. 去除外围引号和 markdown 标记。
4. 折叠空白，限制最大长度。
5. 空结果、过短噪声或只包含标点时视为失败。

## 事件

新增 `session_title_updated`：

```ts
interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  modelRef?: ModelRef;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}
```

标题生成还应发普通 `model_request` / `model_complete`，`querySource: "session_title"`，以便 debug 和成本分析能看到这次 sidecar 请求。

## 错误处理

- 模型请求失败、超时、取消、返回空内容或 CAS 失败都不影响主 turn。
- runtime 只写结构化 warn/debug 日志，不向用户刷一条可见 assistant 消息。
- CAS 失败不是错误，记录为 `session_title_generation.skipped`，原因是 `title_source_changed`。

## 测试

最低覆盖：

- SQLite migration 给旧 session 默认 `first_input`。
- `createSession` 写入 `title_source`，`updateSession` 可以更新 generated 标题。
- generated 标题 CAS 不能覆盖 custom 标题，也不能覆盖已有的 generated 标题。
- 已生成标题的会话经 compact 和冷恢复后再发消息，不再发标题模型请求，标题保持不变。
- 未配置 `model.lite` 时，标题请求使用 main provider/model 且 role 为 `lite`。
- 配置 `model.lite` 时，标题请求使用 lite provider/model。
- 标题请求会清洗 inherited thinking/reasoning provider options；主请求仍保留原始 provider options。
- 标题模型失败时主 turn 仍成功，session title 保留首输入 fallback。
- TUI 显式启用后 root interactive 首 turn 触发，child/fork/workflow/subagent 不触发。
- headless prompt 和 ZCode app-server 默认不传 `titleGeneration`，不会触发标题模型请求。
