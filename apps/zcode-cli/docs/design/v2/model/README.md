# ZCode CLI Model 设计 v2

> **历史设计说明（2026-08-24）**：本文记录 Provider Refactor 之前的模型层设计，文中的
> mutable AI SDK Registry、Model Catalog、`models.dev`、按 modelId 推导能力/思考档位和
> `providerOptionsByLevel` Runtime 投影均已退役，不再是当前实现契约。当前权威设计见
> [Model Contract](../../../../../../docs/working-memory/provider-refactor/design/model/contract.md)、
> [Registry Configuration](../../../../../../docs/working-memory/provider-refactor/design/registry/configuration.md)
> 与 [Model Creation](../../../../../../docs/working-memory/provider-refactor/design/registry/model-creation.md)。
> 本文后续内容只保留为历史背景，不能作为新增实现依据。

## 文档定位

本文是 ZCode v2 的模型层设计。`ModelRef`、provider-neutral request/result、
AI SDK registry/runner、model capability catalog 与 core runtime 接线已经进入
`L2 Implemented Contract`；用户可配置的 gateway/custom provider、远端 catalog 同步和
复杂 provider fallback 仍保持 `L1 Candidate Contract`。

上一版设计过重。这里重来，只围绕两条线：

- provider-agnostic：模型层以多 provider 为基础抽象，不绑定某一家 API 形态或少数兼容后端。
- Vercel AI SDK：TypeScript 生态里统一不同 provider API 的运行时抽象。

---

## 一、核心判断

ZCode 不应该自己从零实现每家模型 API 的请求格式。

模型层的主路径应是：

```text
ZCode core intent
  -> adapters/model 将消息、工具、配置转换为 AI SDK 调用
  -> Vercel AI SDK provider / OpenAI-compatible provider
  -> adapters/model 将 stream、tool call、usage、error 转回 ZCode event
```

AI SDK 是 adapter 里的运行时依赖，不进入 core。core 只知道 ZCode 自己的消息、工具、权限、session event 和 trace。

默认 AI SDK provider transport 还可以按
[`provider-endpoint-routing.md`](./provider-endpoint-routing.md) 的远端配置，在最终网络出口前重写明确的
provider endpoint。该能力不修改 provider 配置，也不进入 core/session 状态。

这样做的收益：

- 不为每个 provider 重写 streaming、tool calling、structured output。
- 第一版配置面只直接支持 `anthropic`、`openai`、`openai-compatible` 三种 provider kind。
- 用户可声明的自定义 provider 第一版优先走 `openai-compatible`；AI SDK provider registry、`gateway` 和 custom factory 只用于受信内部扩展。
- ZCode 只保留 coding agent 必须自己控制的部分：工具权限、session、compact、trace、artifact、跨平台 I/O。

---

## 二、设计依据

### 2.1 Provider-agnostic 边界

多 provider coding agent 的模型层需要这些工程边界：

- 用户可见模型是 `provider/model`。
- provider 配置包含 kind、API 地址、环境变量、options、models。
- provider runtime 负责 `list`、`getProvider`、`getModel`、`getLanguage`、`defaultModel`。
- 请求最终交给 Vercel AI SDK 的 `streamText`。
- 所有 provider 差异集中在 `ProviderTransform`，例如消息清洗、tool call id、cache marker、reasoning 参数、unsupported media、providerOptions。
- message history 记录产生消息的 `providerID` 和 `modelID`，切换模型后不复用旧 provider 的私有 metadata。

ZCode 的做法：

- 使用 `provider/model` 作为 CLI、配置和 session event 的统一模型引用。
- 内部尽早解析成 `{ providerId, modelId }`。
- 用一个集中 transform 层处理 provider 差异。
- 每条 assistant/tool 历史都记录当时使用的模型，避免切换模型时污染请求。

### 2.2 Vercel AI SDK

AI SDK 的关键能力：

- `generateText` 和 `streamText` 是文本生成与流式生成的统一入口。
- provider registry 可以把多个 provider 放在一个 registry 中，并用简单字符串访问模型。
- AI SDK provider 覆盖主流模型服务与云平台 provider。
- `@ai-sdk/openai-compatible` 支持 OpenAI-compatible API。
- tool calling、structured output、reasoning、providerOptions 和 middleware 都有统一抽象。
- Vercel AI Gateway 支持用 `<provider>/<model>` 形式的字符串指定 provider/model，并通过统一入口处理多 provider。

ZCode 的做法：

- adapter 里调用 `streamText` / `generateText`，而不是自己实现 provider wire protocol。
- provider registry 用于组装可用模型；`gateway` 和 custom factory 只属于 adapter/bootstrap 的受信内部配置，不能通过用户文件配置声明。
- provider-specific 高级能力通过受控 `providerOptions` 进入 adapter，不进入 core。
- Gateway/代理在用户配置面第一版仍应走 `openai-compatible`。adapter 内部可以接收已构造好的 `gateway` provider config，用于受信 bootstrap 注入或测试，但文件配置 schema 不接受 `gateway` kind；后续若要开放给用户配置，必须先补鉴权、代理、审计、错误和测试契约。

AI SDK 文档入口：

- <https://ai-sdk.dev/docs/ai-sdk-core/provider-management>
- <https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry>
- <https://ai-sdk.dev/docs/ai-sdk-core/generating-text>
- <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>
- <https://ai-sdk.dev/providers/openai-compatible-providers>
- <https://vercel.com/docs/ai-gateway/models-and-providers>

---

## 三、模块边界

模型层只拆四块，不再过度拆分。

### 3.1 Model Config

负责读配置并生成 provider 定义。模型运行配置必须来自用户、项目、session 或 CLI 显式配置；系统默认配置不提供可直接调用的 provider/model。

最小用户配置形态使用 provider-first：`provider` 声明连接和模型元数据，`model`
只保存当前主模型的 `provider/model` 引用。

```json
{
  "$schema": "https://zcode.ai/schema/config-v2.json",
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro"
        }
      }
    }
  },
  "model": "deepseek/deepseek-v4-pro"
}
```

需要显式区分主力模型和轻量模型时，`model` 展开为 role map，但 role 值仍然只能是
`provider/model` 引用：

```json
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {},
        "deepseek-chat": {}
      }
    }
  },
  "model": {
    "main": "deepseek/deepseek-v4-pro",
    "lite": "deepseek/deepseek-chat"
  }
}
```

`model` 和 `model.main` / `model.lite` 必须指向 `provider` 中显式声明的 provider/model。
配置文件不支持 inline model target，也不支持旧 `small_model` / `model.small` 兼容键。

```json
{
  "$schema": "https://zcode.ai/schema/config-v2.json",
  "provider": {
    "provider-auth-zai": {
      "kind": "openai-compatible",
      "name": "Z.AI",
      "options": {
        "baseURL": "https://api.z.ai/api/coding/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "glm-5": {
          "name": "GLM-5",
          "reasoning": {
            "enabled": true,
            "levels": ["low", "medium", "high"],
            "defaultLevel": "medium"
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 200000,
            "output": 8192
          }
        },
        "glm-4.7": {
          "name": "GLM-4.7"
        }
      }
    }
  },
  "model": {
    "main": "provider-auth-zai/glm-5",
    "lite": "provider-auth-zai/glm-4.7"
  }
}
```

`provider.*.kind` 是用户文件配置里的 provider adapter 解析方式。第一版只允许 `anthropic`、`openai`
和 `openai-compatible`；其它 kind（包括 adapter 内部可用的 `gateway` / `custom`）必须被 config schema 拒绝。配置文件不暴露 `npm`
字段，避免把动态包加载做成用户契约。后续若支持动态 npm provider，必须先补权限、
安装、缓存、审计和错误契约。

`provider.*.models.*` 是模型能力元数据，加载时会投影成 `modelCatalog.overrides`：
models map 的 key 默认就是运行时 model id，会原样传给对应 AI SDK provider；`name`
只作为显示名。若未来支持别名，必须通过独立字段和测试明确 key 与运行时 id 的映射。
`reasoning` 表示是否支持思考和可选思考级别，`modalities.input` / `attachment` 表示是否支持图片，
`limit.context` 和 `limit.output` 表示上下文窗口与最大输出。能力元数据不能单独让模型可用；
可运行模型仍必须由 `model` 或 `model.main` / `model.lite` 显式选择。
`models.*.options` 和 `reasoning.providerOptionsByLevel.*` 可以写该 kind 的原始参数；
加载时由 config service 按 `kind` 包成 AI SDK 的 `providerOptions` 命名空间，例如
`openai-compatible` 会归一化为 `openaiCompatible`。
当 `provider.*.models.*` 没有显式 `reasoning` metadata 时，配置派生的默认 reasoning
必须按 provider kind 生成 provider options：模型 id 推导出的 GLM / DeepSeek 默认值不能先按
OpenAI-compatible 套用再交给 Anthropic-compatible transport，否则 TUI/ZCode app-server 会显示 thinking
已开启，但最终 Anthropic-compatible 请求体不会包含 `thinking`。`kind: "anthropic"` 的
GLM / 非 V4 DeepSeek 默认开关必须映射到 `providerOptions.anthropic.thinking.type`；
`deepseek-v4*` 必须映射到 `providerOptions.anthropic.thinking.type = "enabled"` 和
`providerOptions.anthropic.effort = level`。

### 3.1.1 DeepSeek V4 Pro 兼容

DeepSeek V4 的 thinking 开关默认启用，用户只选择 reasoning effort。OpenAI-compatible
接口把 thinking 开关和 reasoning effort 拆成两个参数：ZCode 配置/策略层通过
`providerOptions.openaiCompatible.thinking.type` 表达 thinking 扩展，adapter 将 canonical
namespace 投影到 SDK 实际读取的 provider-name namespace，最终 HTTP body 顶层发送
`thinking.type` 且不得包含字面量 `extra_body`；
`reasoning_effort` 只接受 `high` / `max`。Anthropic-compatible
接口最终请求同样只暴露 `high` / `max` 两档，通过 `output_config.effort` 控制强度；
ZCode 传给 AI SDK 的输入字段是 `providerOptions.anthropic.effort`，由 SDK 映射到最终
`output_config.effort`。
ZCode 对 `deepseek-v4*` 保持同一契约：

- model default policy 声明 DeepSeek V4 的 canonical reasoning levels 为
  `high` / `max`，默认档位为 `max`。
- OpenAI-compatible transport 下，每个 DeepSeek V4 reasoning level 都必须同时生成 ZCode
  canonical provider options：`providerOptions.openaiCompatible.reasoningEffort` 和
  `providerOptions.openaiCompatible.thinking.type = "enabled"`。两者由 SDK 分别映射为顶层
  `reasoning_effort` 和 `thinking.type`；最终请求不得包含字面量 `extra_body`。
- Anthropic-compatible 注入 target 下，ZCode app-server 同样只展示 `high` / `max`，并输出
  `providerOptions.anthropic.effort = level` 与
  `providerOptions.anthropic.thinking.type = "enabled"`。
- DeepSeek V4 的 model id 不能决定 transport。ZCode app-server 注入模型仍默认走 Anthropic-compatible；
  只有 client 显式传入 provider kind、配置 target，或命中独立的 GPT 前缀 OpenAI native
  路由策略时，才切到其它 transport。
- 兼容旧 thought level 时，`low` / `medium` 归一化为 `high`，`xhigh` 归一化为 `max`；
  这些 alias 不作为新会话对外展示的 canonical level。
- runtime 请求仍必须来自显式 `model` / `provider` 配置；catalog 只提供显示名和能力元数据。
- Model transform 识别 model id 中的 `deepseek-v4` 系列，并在历史 assistant 消息上回放
  `providerOptions.openaiCompatible.reasoning_content`。普通 assistant 历史只有在存在非空
  reasoning 文本（包括已有的非空 `reasoning_content`）时才发送该字段；没有非空 reasoning 时不创建
  空字段。带 tool call 的 assistant 历史继续保留现有兼容行为：即使暂时没有可回放的 reasoning 文本，
  也可以发送空字符串，以满足后端对 tool-call 续轮消息形态的要求。
- 该 `reasoning_content` 兼容逻辑只适用于 OpenAI / OpenAI-compatible transport。
  如果 DeepSeek 或聚合网关通过 Anthropic-compatible transport 接入，历史 assistant
  里的 `reasoning` block 必须保留为 Anthropic reasoning/thinking 内容，不得改写到
  `openaiCompatible` provider options。
- runtime 必须把模型返回的 reasoning/thinking 作为 provider-visible assistant content block
  保存到 in-memory history 和 session part；后续 tool result 请求回放同一个 assistant turn 时，
  不能只保留 tool call 而丢弃 reasoning block。
- 该 history 回放契约是 Anthropic-compatible 的通用策略，不是 DeepSeek 或 MiMo
  特判。任何 Anthropic-compatible provider 在 thinking mode 下返回
  `thinking` + `tool_use` 时，下一次带 `tool_result` 的请求都必须回放同一条
  assistant message 里的 thinking block。
- AI SDK Anthropic provider 只有在 reasoning part 携带 Anthropic reasoning metadata
  时才会发送 `thinking` block；如果兼容后端没有返回 signature，ZCode 在 Anthropic
  transport 的 history transform 中必须补 `anthropic.signature = ""`，避免
  reasoning 被 AI SDK 以 `unsupported reasoning metadata` 静默丢弃。
- DeepSeek V4 Anthropic-compatible 回放 assistant tool-call 历史时，如果运行时没有
  捕获到可回放的 reasoning block，也必须在 `tool_use` 前合成空 `thinking` block 并补
  `signature = ""`。这是为了覆盖流式恢复、provider 未暴露 thinking delta 等场景，
  保证 DeepSeek thinking mode 的 `content[].thinking` 字段存在性要求不会在后续
  `tool_result` 请求中丢失。
- Runtime 聚合流式 reasoning 时不能假设 provider 一定先发送 `reasoning_start`；
  收到孤立的 `reasoning_delta` 时也必须创建并保存 reasoning block。
- 最终请求投影必须移除 `text === ""` 且没有任何 `providerOptions` 键的 reasoning block，
  避免无 provider 语义的流式空壳被发送给后端。该规则只作用于 request-local transform，
  不修改 in-memory history 或 session part；空白字符不等于空字符串，任何已知或未知
  provider metadata 都按不透明数据保留。DeepSeek V4 Anthropic-compatible 的 tool-call
  空 thinking 占位在过滤后按上一条规则合成，因此不受影响。
- DeepSeek OpenAI-compatible 回放时，adapter 把非空 `reasoning` block 聚合到 message-level
  `providerOptions.openaiCompatible.reasoning_content`，并从 `content` 数组移除 reasoning block。
  普通 assistant 的空 reasoning block 必须一并移除，且不能因此创建空的
  `reasoning_content`；带 tool call 的 assistant 仍遵循上面的空字符串兼容行为。

### 3.1.2 MiMo reasoning_content 回放兼容

MiMo 系列在 thinking mode 开启并存在 tool call 历史时，后续多轮请求必须完整回传
assistant 历史里的 `reasoning_content`。ZCode 对任意 MiMo 模型保持和 DeepSeek V4
OpenAI-compatible 回放一致的契约：

- Model transform 识别 provider id 为 `mimo`，或 model id 大小写不敏感地以 `mimo`
  开头的模型。
- 该兼容逻辑只适用于 OpenAI / OpenAI-compatible transport；Anthropic-compatible
  transport 不改写 reasoning blocks。
- OpenAI-compatible 回放时，adapter 把 assistant 历史中的非空 `reasoning` block 聚合到
  message-level `providerOptions.openaiCompatible.reasoning_content`，并从 `content`
  数组移除 reasoning block。
- 普通 assistant 没有可回放 reasoning 文本时不发送空字符串；带 tool call 的 assistant
  保留现有空字符串兼容行为，保证后续 tool result 请求的消息形态稳定。

原则：

- ZCode 自有环境变量继续使用 `ZCODE_` 前缀。
- 如果没有加载到包含模型配置的 `~/.zcode/cli/config.json`、项目配置、session 配置或 CLI override，模型请求必须失败，错误码为 `model_config_missing`。
- `modelCatalog.overrides` 和 `ZCODE_API_KEY` 都不能单独让模型变成可用；它们只提供能力元数据或密钥 fallback。
- `ZCODE_MODEL` 是唯一能从环境变量声明当前可运行模型的入口。存在非空 `ZCODE_MODEL` 时，env scope 生成一个完整的 main model target，并按配置优先级覆盖 user/project `config.json` 中的 `model` 配置；这等价于本次进程忽略文件里的模型选择和 provider 连接。CLI/session override 仍高于 env。
- env model target 默认使用 `anthropic` adapter。`ZCODE_MODEL` 可以是裸 model id，此时 provider id 默认为 `anthropic`；也可以是 `provider/model`，此时 provider id 取斜杠前缀，但 adapter kind 仍为 `anthropic`，用于 Anthropic-compatible gateway。`ZCODE_BASE_URL` 只在 `ZCODE_MODEL` 生效时作为该 target 的 base URL；单独设置 `ZCODE_BASE_URL` 不会让模型可用，也不改写文件配置。
- 非空但无法解析的 `ZCODE_MODEL` 是配置错误，启动必须失败并保留原始 parse error cause；不能静默回落到文件模型配置。
- env model target 不把 `ZCODE_API_KEY` 写进 runtime config。API key 继续在 model registry 边界按现有 fallback 解析：标准 provider key、provider 派生 key、最后 `ZCODE_API_KEY`。
- API key 优先从 `model.apiKey` / `model.main.apiKey` / `model.lite.apiKey` 读取；配置未提供时，adapter 可以从环境变量 fallback，例如 provider 派生 key、标准 provider key 或 `ZCODE_API_KEY`。
- 不暴露 `apiKeyEnv` 作为用户配置字段。环境变量名是 adapter 内部兼容策略，不进入长期用户配置面。
- `headers` 支持自定义 string map，原样传给 provider adapter，但日志、错误和 session event 必须经过敏感字段 redaction。
- CLI 入口负责在运行时从当前工作目录向上查找最近的 `.env` 并加载到环境中；已存在的 shell 环境变量优先，不被 `.env` 覆盖。
- 构建流程不得读取 `.env` 或把 API key 内联进 `dist` 产物，避免 stale secret 和 secret 泄露。
- core 不读 `process.env`。
- 配置只声明模型目标和 provider 连接参数，不能直接创建网络请求或 SDK 实例。
- model capability metadata 不保存 API key，也不决定当前使用哪个模型；它只提供 provider/model 的能力元数据，用户显式配置永远优先。

### 3.2 Model Registry

负责把 provider config 装配成 AI SDK provider 或 provider factory。

职责：

- 注册 built-in provider。
- 注册 OpenAI-compatible provider。
- 文件配置第一版拒绝 `anthropic`、`openai`、`openai-compatible` 之外的 provider kind。
- registry typed API 可以装配受信调用方传入的 `gateway` provider config 和 custom provider factory；这些不是长期用户配置面，不能绕过 config schema、权限和审计边界。
- 后续如需把 AI Gateway 或自定义 provider 包开放给用户配置，必须先补权限、安装、缓存、审计和错误契约。
- 解析 `provider/model`。
- 返回 provider model handle 给 request runner。

不做：

- 不在 core 暴露 AI SDK `LanguageModel`。
- 不把 secret 写进 session event。
- 不静默吞掉 provider init error。

### 3.3 Model Runner

负责一次模型请求。

职责：

- 接收 core 的 provider-agnostic request intent。
- 调用 transform，把 ZCode messages/tools 转成 AI SDK `ModelMessage` / `ToolSet`。
- 调用 `streamText` 或 `generateText`。
- 调用 AI SDK 时必须显式设置 `allowSystemInMessages: true`。ZCode 的 system message
  由 core/context builder 统一构造和审计，属于本项目的正式上下文契约；不要让 AI SDK
  的通用安全提示直接写入用户可见 `stderr`，runner 层也不要用全局
  `AI_SDK_LOG_WARNINGS` 或粗粒度 stderr 静默隐藏其他 provider 诊断。ZCode Protocol
  stdio 入口可以安装专用 warning logger，把 AI SDK warning 写入结构化日志，避免普通文本
  污染 stdout 上的 NDJSON 协议帧。
- 把 AI SDK stream 转回 ZCode model event。
- 把 tool call 交给 ZCode ToolRuntime，而不是让工具绕过权限系统。
- 归一化 usage 和错误。
- 在每次出站模型请求的 HTTP header 中传播当前 `TraceContext.traceId`，保证 provider、gateway、proxy 和本地日志可以用同一个 `traceId` 串联。

原则：

- 工具执行仍走 ZCode tool lifecycle：schema、permission、trace、adapter I/O、artifact。
- AI SDK 只负责模型侧 tool calling 协议和 streaming。
- 有副作用的工具不依赖 AI SDK 的 approval 作为唯一安全边界。
- header 注入发生在 adapter per-request 调用层，而不是 provider 静态配置层；同一个 provider factory 会被多个 session/turn 复用，不能把动态 `traceId` 固化在 provider config 中。

出站模型请求由 adapter per-request 层统一发送以下归因 header：

- `x-request-id`：必填，等于当前物理 model request 的 `requestId`。
- `x-zcode-trace-id`：必填，等于当前 model request 的 `traceId`。
- `x-session-id`：存在 session 时发送，使用剥离内部前缀后的 session id。
- `x-query-id`：存在 query 时发送，使用剥离内部前缀后的 query id。
- `x-zcode-session-type`：必填，只能为 `main`、`subagent`、`side_chat` 或 `other`。
  `selection_side_chat`（含 `/side`、`/btw`）映射为 `side_chat`。由 runtime 模型句柄
  统一绑定宿主会话类型，标题、Memory 和工具内部请求继承宿主；工作区独立请求为 `other`。
  与下述用途字段独立，不根据用途覆写会话类型。完整语义见
  `docs/superpowers/specs/2026-06-09-agent-model-request-session-header-design.md`。
- `x-zcode-query-source`：存在合法 `metadata.querySource` 时发送，保留 `compact`、
  `session_title`、`project_memory_extract` 等调用用途。去掉首尾空白后只接受 1–128 个
  ASCII 字母、数字、下划线、点、冒号或短横线；缺失或非法值时省略，不回退到同名静态
  header。generate/stream、重试和跳过 transcript 的请求共用此规则。
- `x-zcode-session-features`：本会话至今用过的能力标签（如 `workflow_cmd`、`workflow_auto`），
  逗号分隔、字典序、只增不减。没有标签或值不合法时省略；工作区独立请求不发送；provider 静态
  同名 header 被剔除。owner、继承与冷恢复规则见 [session-features-header.md](session-features-header.md)。

模型请求的来源 header（`buildCliZCodeSourceHeaders`，以及 provider endpoint routing 配置 GET
复用的共享来源 header）中，`X-Client-Language` 按以下优先级取值：

1. 环境变量 `ZCODE_CLIENT_LANGUAGE`：Desktop 启动 Agent 子进程时写入当前界面语言
   （BCP-47，如 `zh-CN`、`en-US`、`ja-JP`、`ru-RU`、`ko-KR`）。
   - 用途：Agent 进程的 `Intl` 只代表系统语言；App 从 Finder/Dock 启动时没有 `LANG`，
     Node ICU 回退为 `en-US`，界面选了日语/俄语/韩语时模型请求仍发 `en-US`。
   - 取值去掉首尾空白，必须是可打印 ASCII；空值或非法值视为未设置，回落下一项，不报错、不阻断请求。
   - 只在 spawn 时读取：界面语言切换后，下一次启动的 Agent 进程生效（已有进程不重启）。
   - 独立 CLI/TUI 不设置该变量；用户手动设置时同样生效。
2. 进程 `Intl.DateTimeFormat().resolvedOptions().locale`（原有规则）。
3. 都没有时为 `unknown`。

注入方：本地 Desktop Host 在 `resolveSpawnEnv` 中写入（`resolveClientLanguage`，即 Main 推送的实时界面语言）；
desktop-attached 远端 Host（SSH/WSL/Docker Source Server）是多个 Desktop 共享的常驻 daemon，没有
Desktop→Agent 的语言通道，仍按第 2 项回落，跨环境同步另行设计。测试：`tests/model-config.test.ts`、
`tests/provider-endpoint-routing-source-headers.test.ts`。

`turnId`、`spanId`、`parentSpanId` 等细粒度诊断信息只进入 model status event、session event、
trace span 和结构化日志，不进入 provider-visible HTTP header。上述归因 header 只用于统计、
诊断与审计，不作为鉴权、计费、限流或业务路由依据。

如果 legacy 调用没有传入 `TraceContext` 或 metadata trace，adapter 可以创建 fallback `traceId`，但必须保证 status event、日志和请求 header 使用同一个值。运行时主路径仍必须显式传入 `TraceContext`。

### 3.4 Model Transform

这是模型层最重要的边界。

职责：

- ZCode message -> AI SDK message。
- ZCode tool contract -> AI SDK tool。
- ZCode artifact/attachment -> provider 支持的内容。
- providerOptions 注入。
- usage/error/event 归一化。

第一版只做必要 transform：

- 切换模型时丢弃不兼容 provider metadata。
- 不支持的图片、PDF、音频等输入转成明确的模型可见提示或用户可见错误。
- tool result 超预算时截断并返回 artifact 引用。
- pending/running tool call 在恢复请求时补成 interrupted result。
- providerOptions 只允许来自配置白名单或调用方显式 role policy。

后续 provider quirks 可以继续加在这里，但不能散落到 agent loop。

---

## 四、核心数据

### 4.1 ModelRef

ZCode session 内部保存结构化模型引用：

```text
providerId
modelId
source
role
variant?
```

用户可以输入 `zai/glm-5`，但 session event 不保存裸字符串作为唯一事实。

### 4.2 ModelLevel 与 ModelRole

ZCode 第一版只定义两个模型能力级别：

- `main`：主力模型，负责普通对话、代码修改、工具循环、复杂推理和默认子任务。
- `lite`：轻量模型，负责标题、短摘要、hook 判断、轻量分类、低风险结构化小任务。

`lite` 是可选配置。未配置 `lite` 时，运行时必须把 `lite` 解析为当前 `main`，而不是强制引入第二模型、第二 provider 或额外环境变量。

ModelRole 描述一次请求的用途，不等同于模型级别。第一版只支持少量 role：

- `main`
- `lite`
- `compact`
- `review`
- `subagent`

默认策略：

- `main` 来自用户配置或 CLI 参数。
- `lite` 来自 `model.lite`；未配置时继承 `main`。
- `compact` 默认继承 `main`，后续可通过 role policy 指向 `lite` 或独立模型。
- `review` 默认继承 `main`，后续可通过 role policy 指向更强或更保守的模型。
- `subagent` 默认继承 parent；agent 配置可以显式覆盖为 `main`、`lite` 或完整 `provider/model`。

配置策略：

- 单模型配置直接使用 `model: "provider/model"`，多角色配置使用 `model.main` / `model.lite`。
- 旧 `small_model`、`model.small`、inline model target 都不再作为配置输入；配置 schema 应拒绝这些形态。
- 旧实现里的 `model.compact` 不作为用户配置项；compact 是请求 role，默认解析到 `main`。
- session event 必须记录最终解析后的 `ModelRef` 和 role，例如 `role: "lite"`，避免恢复时重新受配置漂移影响。

实施计划见 [`lite-model-plan.md`](./lite-model-plan.md)。

### 4.3 Model Config（兼容性配置）

Model Config 与 Agent/Tools 是**两个独立维度**：

| 维度              | 决定因素   | 归属           |
| ----------------- | ---------- | -------------- |
| **Agent + Tools** | 角色/能力  | 决定"能做什么" |
| **Model Config**  | API 兼容性 | 决定"怎么做"   |

Model Config 主要是为了处理**不同模型的 API 兼容性差异**，代码里通常薄薄一层 `if` 就解决了。

| 兼容性场景     | 示例                                                            |
| -------------- | --------------------------------------------------------------- |
| **能力支持**   | 某些模型不支持 tool calling、不支持 streaming、不支持 reasoning |
| **参数默认值** | 不同模型的 maxTokens、temperature 默认值不同                    |
| **请求格式**   | 某些模型需要特殊的 header、body 字段或 prompt 格式              |
| **响应解析**   | 不同模型的 error 格式、tool call 结构需要归一化                 |

**设计原则：**

- Model Config 保持薄，不要过度抽象
- 兼容性处理收敛在 adapter 层，不进入 core
- 用 `if` 能解决的不做配置，用配置解决的不做代码分支

```typescript
interface ModelConfig {
  supportsTools?: boolean; // 默认 true
  supportsStreaming?: boolean; // 默认 true
  supportsReasoning?: boolean; // 默认 false
  maxContextTokens?: number; // 用于 context window 计算
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  requiresThoughtTag?: boolean; // 某些模型需要在 prompt 里加 tag
}
```

### 4.4 Model Catalog 与 Reasoning Level

模型能力元数据不再来自 bundled `catalog.json` 或本地 `models-catalog.json`。有效 catalog 从空集合开始，由 `provider.*.models.*` 投影、`config.json` 的 `modelCatalog.overrides` 和 deterministic model default policy 共同组成。覆盖 key 使用 `provider/model`，按第一个 `/` 分割 provider 与 model，允许 model id 自身包含 `/`。catalog 不能提供默认可运行模型；ZCode app-server/TUI 只能把显式配置的模型作为当前 session 可选项，catalog 仅用于补充这些模型的能力、显示名和 reasoning level。

Reasoning 能力同时保留两个层次：

- `supportsReasoning`: 粗粒度开关，用于判断模型是否具备 reasoning/thinking 能力。
- `reasoning.levels`: 可选等级列表，用于 ZCode app-server、TUI 或其它客户端展示选择项。

示例：

```json
{
  "modelCatalog": {
    "overrides": {
      "openai/glm-4.7": {
        "supportsReasoning": true,
        "reasoning": {
          "enabled": true,
          "levels": ["low", "medium", "high"],
          "defaultLevel": "medium",
          "providerOptionsByLevel": {
            "high": {
              "reasoningEffort": "high"
            }
          }
        }
      }
    }
  }
}
```

规则：

- capability metadata 只声明能力，不决定当前 session 用哪个模型。
- config override 只覆盖指定字段，不要求复制整条模型声明。
- 只配置 `supportsReasoning` 时，表示布尔能力覆盖；如果 provider/model id 能命中
  `Model Default Policy`，catalog service 会补齐对应 reasoning level 或 thinking toggle。
  完全未知且没有默认策略命中的模型不会凭空生成等级。
- 配置 `reasoning.levels` 时，默认视为 `supportsReasoning: true`，除非显式 `reasoning.enabled: false`。
- session 只保存当前选择的 model 和 thought level；模型切换后由 catalog 重新计算可用等级。

### 4.4.1 Model Default Policy

ZCode 允许在 catalog 之外维护一层很薄的模型默认策略，用于处理“模型 id 已经能识别，
但用户没有在 `config.json` 写完整能力元数据”的场景。策略只补能力默认值，不让模型变成可用；
可运行模型仍必须通过 `model` / `model.main` / `model.lite` 显式选择，并且 provider 必须可配置。

合并与兜底顺序：

1. `provider.*.models.*` 先投影成 `modelCatalog.overrides`；显式 `modelCatalog.overrides` 再覆盖同 key 的投影字段。
2. Catalog service 从空集合开始；每条 override 会按 provider/model id 先取 model default policy，再用配置字段覆盖默认值。
3. 纯 catalog 查询命中可识别 model id 时，可以返回只包含默认策略字段的 synthetic capability，但不会出现在 `listCapabilities()` 中，也不会让模型变成可运行。
4. Runtime 仍可在能力缺失时使用自身兜底，例如 compact policy 的 200000 token 默认窗口。

默认策略：

- 如果 model id（允许兼容网关前缀）精确命中 `kimi-k3`、`k3` 或 `k3-256k`，
  默认 `contextWindow` 分别为 `1048576`、`1048576` 和 `262144`，三者的
  `maxOutputTokens` 都为 `131072`，并支持视觉输入；reasoning 包含 `low` / `high` / `max`
  三档，默认 `max`。OpenAI-compatible 映射为
  `openaiCompatible.reasoningEffort`，Anthropic-compatible 映射为 `anthropic.effort`
  （AI SDK 输出 `output_config.effort`）；两条链路都不注入 K2.x 的 `thinking` 开关。
- 如果 model id 大小写不敏感地以 `-[1m]` 结尾，默认 `contextWindow` 为 `1000000`。
- 如果 model id 大小写不敏感地等于 `deepseek-v4-pro` 或 `deepseek-v4-flash`，
  默认 `contextWindow` 为 `1000000`；兼容网关把 provider 编进 model id 时，
  例如 `deepseek/deepseek-v4-flash` 或 `deepseek-ai/deepseek-v4-pro`，按最后一个
  `/` 后面的模型名匹配。
- 该策略会影响 context usage 展示、auto compact threshold、模型切换后的 runtime
  context window 等依赖模型上下文窗口的逻辑。
- 如果 model id 大小写不敏感地包含 `claude`，默认 reasoning 使用深度档位
  `low` / `medium` / `high` / `xhigh`，默认档位为 `medium`，并映射到 Anthropic
  固定 budget thinking：`anthropic.effort = level`、`anthropic.thinking.type = "enabled"`。
- 如果 provider id 为 `openai` 且 model id 大小写不敏感地包含 `gpt`，默认 reasoning
  使用 `low` / `medium` / `high` 深度档位，默认档位为 `medium`，并映射到
  OpenAI native `reasoningEffort = level`。OpenAI-compatible GPT 模型使用同样档位，
  但 provider option 命名空间为 `openaiCompatible.reasoningEffort = level`。Native OpenAI
  的 canonical 字段只在 Adapter runner 边界合并进 `openai` namespace，保留同 namespace
  的静态 options 后再交给 Responses SDK。
- 如果 model id 大小写不敏感地以 `deepseek-v4` 开头，默认 reasoning 使用
  `high` / `max` 两个 canonical 档位，默认档位为 `max`。两个档位都启用
  `openaiCompatible.thinking.type = "enabled"`，并分别设置
  `openaiCompatible.reasoningEffort = "high"` / `"max"`。Anthropic-compatible
  注入模型使用同一组 canonical 档位，但 provider options 输入映射到
  `anthropic.effort`，最终请求体由 AI SDK 输出为 `output_config.effort`。
  兼容旧 level 时，`low` / `medium` 会映射为 `high`，`xhigh` 会映射为 `max`。
- 如果 model id 大小写不敏感地包含 `glm`，或包含 `deepseek` 但不是 `deepseek-v4`
  系列，默认 reasoning 不是 `low` / `medium` / `high` 等等级，而是
  `enabled` / `disabled` 两档开关。默认档位为 `enabled`。
- 通过 `config.json` 的 `provider.*.models.*` 声明、但没有显式 reasoning metadata 的
  其他 `anthropic` 或 `openai-compatible` 模型，也默认使用 `enabled` / `disabled` 两档开关；
  这样 TUI/CLI/ZCode app-server 对配置模型始终有可选 thought level。纯 catalog 查询不会为完全未知模型
  合成通用开关，避免扩大 catalog 查询语义。
- OpenAI-compatible 开关 `enabled` 映射到 request provider option：
  `openaiCompatible.thinking.type = "enabled"`；`disabled` 同理映射为
  `"disabled"`。Anthropic-compatible 非 Claude 开关映射到 `anthropic.thinking.type`，
  不输出 Claude 专属 `anthropic.effort`。
- GLM 默认策略不设置 `clear_thinking: false`。只有在 ZCode 能完整保存并回传
  assistant 历史里的 `reasoning_content` 后，才可以考虑暴露“保留式思考”策略。
- 如果 model id 大小写不敏感地包含 `opus-4.7` 或 `opus-4-7`，默认 reasoning
  等级包含 `low`、`medium`、`high`、`xhigh`、`max`，默认档位仍为 `medium`。
  每个 level 的默认 Anthropic provider options 使用 `anthropic.effort = level` 和
  `anthropic.thinking.type = "adaptive"`，因此 TUI、CLI 和 ZCode app-server 都能从 catalog/config
  共享同一份 Opus 4.7 thinking depth 兼容逻辑。
  该规则用于兼容用户配置里的 Claude Opus 4.7 及其
  短横线变体；只补 reasoning metadata 和 provider options，不改变 provider 连接或可运行模型选择。
- 如果请求走 `@ai-sdk/anthropic`，调用方未显式传 `maxOutputTokens` 时，model adapter
  默认补 `64000`。显式请求值优先；该规则只作用于请求层，不改变 catalog 或 model default policy。
- 如果用户在 `config.json` 或 catalog override 中显式写了相关能力字段，该显式值优先于
  model default policy。

### 4.4.1 Reasoning effort command surface

TUI 本地 `/effort [list|<level>]` 命令从当前模型的 `reasoning.levels` 读取可选思考深度，并把选中 level 映射为同一条 `reasoning.providerOptionsByLevel[level]` runtime provider options。`/variant` 只是输入兼容 alias，不引入独立 model variant 配置。

交互式 TUI 的 `/effort` 入口使用与 `/model` 相同形态的 composer 候选 popup：输入 `/effort` 或 `/variant` 时从 app/server 暴露的可选 level 列表过滤，Tab/Enter 选择后提交显式 `/effort <level>`。空 `/effort`、`/variant` 与 `list` 参数仍由 command center 返回纯文本列表，作为非 popup 客户端和调试路径。

`/effort` 成功切换只更新当前 session runtime `modelProviderOptions` 与全局 `local_setting(model.reasoningLevel)` 偏好，不 patch `config.json` 的 `model` 或 provider 配置。后续新 session 在没有显式 runtime provider options 时读取该全局偏好；如果当前模型不支持该 level，则按模型 catalog 的 `defaultLevel` 或首个 level 回退。

### 4.5 ModelMetadata

第一版 metadata 保持薄：

```text
displayName?
contextWindow?
maxOutputTokens?
supportsTools?
supportsJsonSchemaOutput?
cost?
```

This early metadata sketch is superseded for input/output formats. Current
runtime format facts use the complete Active Model
`properties.input_format` / `properties.output_format` contract documented in
`docs/working-memory/provider-refactor/design/model/input-output-format.md`.

来源：

- 用户配置。
- provider 静态声明。
- 可选远端 models list。
- fallback 默认值。

不做大型 model catalog。需要 catalog 时可以接入 `models.dev` 数据源，但不是 P0。

---

## 五、请求流程

```text
user turn
  -> core 选择 ModelRef
  -> Model Registry 解析 provider/model
  -> Model Transform 编译 messages/tools/providerOptions
  -> Model Runner 调 AI SDK streamText/generateText
  -> AI SDK 返回 text/tool/reasoning/usage/error stream
  -> Model Runner 转为 ZCode session events
  -> ToolRuntime 执行工具
  -> 下一轮继续
```

`workspace/generateText` 是受控短文本 sidecar：调用方只提供单条 user prompt，
不开放 tools。Git commit message 生成固定使用 `querySource = "git_commit_message"`；
这类请求输出预算很小，runtime 在调用 `modelAdapter.generateText` 前必须关闭
reasoning/thinking provider options，避免用户当前会话的高推理档位把全部
`max_tokens` 消耗在 thinking token 上，导致返回空文本。关闭转换必须同时消费
`modelRef` 与原始 provider options：已有 `thinking`/`enable_thinking` 使用对应直接
开关，GLM-5.2 等明确支持 `none` 的 effort-only 模型写入 canonical
`reasoningEffort=none`；不得只删除 effort，也不得重新合成 `extra_body`。

关键事件：

- `model.selected`
- `model.request.started`
- `model.stream.delta`
- `model.tool_call.started`
- `model.tool_call.completed`
- `model.usage.recorded`
- `model.network.started`
- `model.network.retry_scheduled`
- `model.network.failed`
- `model.network.completed`
- `model.request.failed`
- `model.request.completed`

所有事件必须带 `traceId`、`sessionId`、`turnId` 和 `ModelRef`。

Model Runner 对 UI 层只暴露 provider-neutral 的 `ModelStatusSink`，不把 AI SDK、HTTP library 或 provider 原始错误对象传给 UI。事件形态是 `ModelNetworkStatusEvent`，至少包含：

```text
type
timestamp
traceId
sessionId?
turnId?
requestId
model
transport          # http | sse | websocket
attempt
maxAttempts
```

`requestId` 表示一次物理 provider 请求，而不是整个用户 turn 的逻辑请求。adapter retry 每发起新的 HTTP/SSE provider 请求时，必须生成新的 `requestId` 并写入事件和 `x-request-id` header；同一轮重试链路通过稳定的 `traceId`、`sessionId`、`turnId` 以及递增的 `attempt` 关联。第一次 attempt 可以沿用调用方传入的 `metadata.requestId`，后续 attempt 禁止复用该值。

当前稳定事件：

- `model_request_started`
- `model_request_completed`
- `model_request_failed`
- `model_retry_scheduled`
- `model_stream_stalled`

`model_request_failed` 必须携带稳定 `reason`、`retryable`、安全 `message` 和可选 `statusCode`；`model_retry_scheduled` 必须携带 `reason`、`delayMs`、`nextAttempt` 和安全 `message`。UI 只能消费这些稳定字段，不能依赖 provider error text、headers、response body 或 SDK 私有字段。

---

## 六、错误处理

第一版只定义这些稳定错误：

- `provider_not_found`
- `provider_not_configured`
- `invalid_model_ref`
- `invalid_model_request`
- `model_not_found`
- `model_request_failed`
- `model_request_cancelled`
- `model_request_timeout`
- `model_rate_limited`
- `model_context_exceeded`

错误要求：

- 保留 original cause。
- 给用户可操作提示。
- 不依赖 provider 错误文本做流程判断。
- 不泄露 API key、headers、完整 prompt。

网络请求失败原因统一归一到稳定枚举，第一版包括：

- `rate_limited`
- `provider_overloaded`
- `server_error`
- `network_error`
- `timeout`
- `stream_idle_timeout`
- `stale_connection`
- `auth_refresh`
- `auth_failed`
- `cancelled`
- `context_exceeded`
- `invalid_request`
- `provider_not_configured`
- `proxy_error`
- `tls_error`
- `unknown`

AI SDK 默认内部 retry 不能满足可观测性要求，因为 UI 和日志看不到每次 retry 的原因。ZCode adapter 应将 SDK 内部 `maxRetries` 设为 `0`，在 adapter 边界实现自己的重试循环，并在每次失败、重试排队和最终失败时发布 `ModelNetworkStatusEvent`。默认重试只允许发生在尚未产生已提交输出的请求阶段；流式请求可以暂存并丢弃 `reasoning_delta`、`tool_input_delta` 等无副作用前奏事件后重试，但一旦 `text_delta`、`tool_call` 或 `finish` 已向上游产出，就不自动重放，避免重复内容或重复 tool call。后续如果启用模型 SSE 期间的提前 tool 执行，必须按 `streaming-tool-execution-and-recovery.md` 的 ledger 和 recovery anchor 语义重试；不能回退到 non-stream fallback，也不能从半截 assistant 文本续写来隐式恢复 tool 状态。

模型 SSE 是长连接，不应套用普通 HTTP 总请求超时。ZCode adapter 必须使用事件间隔 idle timeout：首请求默认 600000ms，可通过 `~/.zcode/cli/config.json` 的 `modelStream.idleTimeoutMs` 覆盖；从请求开始等待首个 stream event，并在每个 AI SDK stream chunk / SSE event 到达后重置计时；只要事件持续到达，即使总耗时超过初始 idle timeout 也允许继续。SSE idle timeout 在重试场景递增：每发生一次 adapter retry 或 core stream recovery retry，就在 adapter base timeout 上增加 30000ms，例如默认首请求 600s、第一次重试 630s、第二次重试 660s。超过 idle timeout 时，adapter 发布 `model_stream_stalled`，终止当前 provider 请求，将失败归一为 `stream_idle_timeout`，并按统一 retry budget 在尚未产生已提交输出时自动重试。该配置在模型 adapter 构造时读取，修改 `config.json` 后需要新建 agent/runtime 才能保证生效。

Retry 语义以用户可理解的“重试次数”为默认配置口径，默认 `maxRetries = 10`。运行时事件沿用 `maxAttempts` 字段表示总尝试次数，因此默认事件中 `maxAttempts = 11`，对应 1 次首请求和 10 次重试。实现不得把 `maxAttempts` 误当成重试次数；日志需要同时带上 `maxAttempts` 和派生的 `maxRetries`，方便排查等待和最终失败原因。TUI、ZCode app-server 等用户侧展示必须在投影层把 `attempt` / `maxAttempts` 转成 `retry` / `maxRetries`，默认第一次重试显示 `1/10`，而不是 `2/11` 之类的内部 attempt 口径。

退避策略默认使用指数退避加 jitter：`baseDelayMs = 2000`、`backoffFactor = 2`、普通退避上限 `maxDelayMs = 60000`。如果 provider 返回 `retry-after-ms` 或 `retry-after`，adapter 必须优先使用 provider 指示的等待时间；`retry-after-ms` 比 `retry-after` 精确，优先级更高。若 provider 同时返回 `x-should-retry: false`，adapter 必须忽略 provider `retry-after-ms` / `retry-after` 等待提示并回退到本地 retry 退避。为避免异常 header 造成不可控等待，只有 `0 <= delay <= 5min` 或者 delay 小于当前指数退避时间时才采用 provider header，否则回退到本地指数退避。`retry-after` 支持秒数和 HTTP date 两种格式。

结构化业务码明确表示长期额度耗尽、欠费或套餐失效时，adapter 必须将其归一为终止型失败，保留 provider 原始安全 message，但设置 `retryable = false` 并立即结束当前请求，不得落入通用 HTTP `429` 自动重试。分类输入只允许来自 AI SDK 已解析的 error data 或既有 `ProviderBusinessError.providerCode`，不得为某个厂商新增原始 response 字段旁路解析或匹配自然语言错误文案。同一份 AI SDK parsed error 详情必须同时供失败分类、`model_request_failed` 诊断字段和最终 adapter error context 使用，不得在分类后丢失 provider code、message 或 request id，也不得由各消费方重复解析。OpenAI-compatible 的 `insufficient_quota`、OpenAI 的 `credit_balance_exhausted` / `organization_spend_limit_exceeded` / `project_spend_limit_exceeded` / `organization_usage_limit_exceeded`、Kimi 的 `exceeded_current_quota_error`、MiniMax 的 `1008` / `2056`、BigModel 的长期额度与套餐业务码，以及 TokenHub 的 `20097` 均属于终止型信号；但只有当前 AI SDK provider schema 实际暴露到统一错误对象中的 code 才进入映射，不能为补齐字段而绕过 AI SDK。

`insufficient_quota` 的终止语义不得依赖 `Retry-After` 是否存在或等待时长；`Retry-After` 只沿用既有解析与诊断用途，不参与业务码的 `retryable` 判断。Kimi 的 `engine_overloaded_error` / `rate_limit_reached_error` 与 Anthropic 的 `overloaded_error` / `rate_limit_error` 等瞬时容量与速率 code 必须继续可重试。

模型 I/O 诊断轨迹按 session 落到 `~/.zcode/cli/{debug,rollout}/model-io-<sessionId>.jsonl`。这不是产品 timeline，也不进入 session 恢复链；它只用于调试真实 provider request/response。开发模式由 `ZCODE_RUNTIME_ENV=development` 判定，`NODE_ENV` 不参与 ZCode 运行时判定。默认使用 bounded 策略：生产态限制 session 文件数和单文件体积，开发态限制单文件体积，并对重复请求上下文使用 `full` / `delta` / `tail` 压缩。App Settings 的“完整保留模型 I/O”默认关闭；开启后从下一次模型 attempt 起不执行文件淘汰、单文件重置、消息压缩或生产字段裁剪。Header 与 request metadata 的凭据脱敏在两种模式下都必须保留，记录失败不能影响模型请求主路径。完整设置合同见 `docs/model-io-full-retention-setting.md`。

当 provider 返回 HTTP 200 但业务协议失败时，adapter 必须把它当作模型请求失败，而不是让 AI SDK 把空结果或 `finishReason: other` 继续向上游传播。兼容判断放在 provider HTTP fetch 边界：若 JSON 响应体包含 `success: false`，或 `code` / `error_code` 存在且不是 `0` / `"0"`，则抛出 provider business error。用户可见错误消息优先使用 `msg`，其次使用 `message`，再其次使用嵌套 `error.message`；没有安全消息时使用通用 provider 业务错误文案。该错误经过 Model Runner 归一为 `model_request_failed`，并保留原始 cause、业务 `statusCode` / provider code 的安全摘要，以及用于 retry 归因的 response headers。业务错误默认不自动重试，但当业务错误可以安全映射为 `HTTP 5xx` 时，应视作 provider server error，复用统一 retry budget；当 provider 业务错误的结构化 code 明确表示上游网络失败时，例如 BigModel 兼容层返回 `code=1234` 且用户可见 message 通常为“网络错误，错误id ...，请稍后重试”，或 provider 明确返回 `network_error` / `network_error_retryable`，应归一为 `network_error` 并复用统一 retry budget；BigModel 文档中表示临时账号访问异常、调用流程异常、并发/频率/平台流量限制或模型访问过载的 `1120` / `1230` / `1302` / `1303` / `1305` / `1312` 也复用统一 retry budget。4xx、权限、套餐、长期 quota reset 和其他未映射到 `5xx`、网络失败、限流或过载的业务错误仍保持非重试。诊断日志只能进入结构化日志摘要，包含 `requestId`、`traceId`、finish reason、usage、文本长度、tool call 数、stream chunk 计数和 provider body 的安全摘要，不记录完整 prompt、完整 headers 或大体积 response body。

流式 SSE 也必须执行同一类业务错误识别。部分 OpenAI-compatible provider 会在 HTTP 200 的 `text/event-stream` 中返回 `event: error`，并把业务错误放在 `data` JSON 中，例如 `{ "error": { "code": "1311", "message": "当前订阅套餐暂未开放GLM-5V-Turbo权限" }, "request_id": "..." }`，随后再发送 `[DONE]`。provider fetch 边界必须在不缓冲完整 stream、不改变正常 frame 顺序的前提下逐帧检查 SSE：当 frame 的 event 为 `error`，或 data JSON 命中上述 `success/code/error_code/error.message` 业务失败规则时，终止响应 body 并抛出 `ProviderBusinessError`。该错误必须保留 provider code、request id、response HTTP status、安全 body 摘要和 response headers；Model Runner 继续归一错误语义，并在尚未产出任何已提交模型事件且业务错误可映射为 `HTTP 5xx` 或明确表示 provider 网络失败、限流或过载时复用统一 retry budget，否则发布最终的 `model_request_failed`，用户可见消息使用 provider 提供的安全 message。非 JSON frame、`data: [DONE]` 和正常增量 frame 原样透传。

---

## 七、当前实现落点

本阶段已引入 Vercel AI SDK，并通过 adapter 接入 core runtime。实现核对时间：
2026-05-07。

- `packages/contracts/src/model/index.ts`：provider-neutral 的 `ModelRef`、request、usage、tool contract、stream event 和错误码。
- `packages/contracts/src/model/catalog.ts`：`ModelCapability`、`ProviderMeta`、reasoning metadata、catalog override 与 `ModelCapabilityProvider` 查询接口。
- `packages/contracts/src/events/session.events.ts`：模型事件可以携带结构化 `ModelRef`。
- `packages/adapters/src/model/catalog.ts`、`catalog-source.ts`、`default-policy.ts`：从 `models.dev` capability catalog 开始，合并 `modelCatalog.overrides` 和 `provider.*.models.*` 投影；当注入 provider ID 无法直接匹配时可用 OpenRouter 作为事实能力锚点；并为 `-[1m]`、DeepSeek、GLM、Claude、OpenAI/GPT、Opus 4.7 等模型补默认 context window 与 reasoning provider options。catalog 只提供能力元数据，不让模型自动可运行。
- `packages/adapters/src/model/registry.ts`：装配 `anthropic`、`openai`、`openai-compatible`，并支持 adapter 内部的 `gateway` 和 custom provider factory；文件配置 schema 仍拒绝 `gateway` / `custom`。
- `packages/adapters/src/model/transform.ts`：ZCode message/tool contract 到 AI SDK `ModelMessage` / `ToolSet` 的转换。
- `packages/adapters/src/model/runner.ts`：`generateText` / `streamText` 的 adapter 封装，负责禁用不可见 SDK retry、发布模型网络状态、输出 ZCode 自己的 text result 和 stream event。
- `packages/adapters/src/config/schema.ts`：文件配置只接受 `anthropic`、`openai`、`openai-compatible` provider kind，拒绝 `gateway`、`custom`、`npm`、`small_model`、`model.small` 和 inline target；同时把 `provider.*.models.*` 投影进 model catalog overrides。
- `packages/bootstrap/src/model-config.ts`：把 runtime model config 装配成 AI SDK registry config，补 provider headers，按 provider/name 派生 API key fallback，保留 `model_config_missing` 错误边界。
- `packages/core/src/runtime/methods/model.ts`、`turn-model-step.ts`：core runtime 已通过 `runModelTextRequest` 调用 model adapter，支持 streaming event、tool call、usage、reasoning block 持久化、trace/status sink、provider context usage 和 context-overflow reactive compact。

测试锚点：

- `packages/contracts/tests/model-ref.test.ts`、`model-usage.test.ts`
- `packages/adapters/tests/model-catalog.test.ts`、`config.test.ts`、`registry.test.ts`、`runner.test.ts`、`model-transform.test.ts`
- `packages/bootstrap/tests/model-config.test.ts`、`model-selection.test.ts`
- `packages/core/tests/runtime-tool-loop.test.ts`、`runtime-trace.test.ts`、`runtime-compact.test.ts`

剩余缺口：Provider Capability 目前是模型能力 catalog + adapter 默认策略的实现形态，尚未把
network/cache/parallel-tool/retry budget 全部提升为独立稳定 capability schema。后续如果要支持
用户可配置 gateway/custom provider 或远端 catalog，需要先补权限、安装、缓存、审计、错误和测试契约。

---

## 八、实现顺序

1. 增加 protocol 里的最小 `ModelRef`、model event 和 model error。
2. 在 adapters 增加 `model` adapter，内部使用 Vercel AI SDK。
3. 支持 `provider/model` parser。
4. 支持 `anthropic`、`openai`、`openai-compatible` 的配置装配，其他 kind 拒绝加载。
5. 实现 `streamText` runner 和 stream event 归一化。
6. 增加 `main/lite` role resolver；`lite` 未配置时解析到 `main`。
7. 把现有 tool contract 转成 AI SDK tools，但执行回调仍进入 ZCode ToolRuntime。
8. 为集中 transform 层补齐 provider 差异的单元测试。
9. 再考虑远端 catalog、provider package 动态加载和复杂 providerOptions。

---

## 九、测试要求

必须覆盖：

- `provider/model` 解析，model id 内含 `/` 时仍正确。
- `lite` 未配置时解析到 `main`。
- `ZCODE_MODEL` + `ZCODE_BASE_URL` 生成 Anthropic adapter 的 env model target，并覆盖文件 model 配置。
- 非法 `ZCODE_MODEL` 会产生配置错误，而不是回退到 `config.json`。
- `ZCODE_MODEL` 不把 `ZCODE_API_KEY` 存入 runtime config，registry 仍能通过 `ZCODE_API_KEY` fallback 取得密钥。
- schema 拒绝 `small_model`、`model.small` 和 inline model target。
- provider 未配置、model 不存在、env key 缺失。
- OpenAI-compatible provider baseURL 配置。
- provider-qualified model id 内含 `/` 的解析，例如 `gateway/zai/glm-5`。
- tool call 进入 ZCode ToolRuntime。
- 切换模型时不复用旧 provider metadata。
- unsupported attachment 处理。
- stream abort 和 provider error。
- usage 缺失时仍完成 session event。

验证命令：

```text
npm run lint
npm test
```

---

## 十、设计原则

- AI SDK 是 provider API 抽象层，不是 ZCode core 类型系统。
- 统一采用 `provider/model` 引用加集中 transform 层的结构。
- ZCode 自己只实现 agent 必须拥有的状态、权限、trace 和工具生命周期。
- P0 不做大型 model catalog，不做 provider 市场，不做复杂自动 fallback。
- 任何 provider 特例都先进入 `Model Transform`，不要污染 agent loop。

## Selection side first input

App 的 `createSelectionSideSession.firstInput.modelSelection` 是可选的完整模型选择，详情见 [副屏契约](../../../../../../docs/ui/conversation-selection-side-chat.md)。存在时由原 fork 创建路径写入 child 的模型配置，首条输入沿用该配置；不更新 parent，也不分开发送切模命令。缺省保持原 runtime 继承；旧客户端继续兼容。

### App 会话选模与 Bot 输入接纳

App 已有会话的 Provider/Model 改选通过 `switchModelConfig` 提交完整 Selection。
跨模型配置先整体校验 Provider、Model 和 reasoningLevel，再更新 Session Selection；
非法档位返回失败，不先换模型再尝试补写档位。该命令不修改 Active Model 或已接纳队列。

兼容调用方传入空白 `thought` 时，从目标模型的 Registry 元数据读取默认档位，
组成完整 Selection 后一次校验、保存并发布事件，不继承旧模型的显式档位。
不能仅使用身份切换入口：它留下稀疏选择，随后发布事件创建 Model 时仍会失败。
显式非空档位仍与模型身份一次校验并保存；失败时原 Session Selection 保持不变。
回归必须经过真实 Provider Registry 与 facade，检查成功事件、持久选择和失败不变性，
不能仅 mock `setModel`；正在执行轮次和已接纳队列仍使用各自冻结的选择。

Bot 的 `sendText` / 兼容 `session/send` 可附 `modelSelectionBasis`，表示 Host 解析时读取的
原 Session Selection。接纳时若身份或 reasoningLevel 已变，使用当前 Session Selection；
否则保留 Host 已解析的 `modelSelection`。依据只用于接纳，不成为队列的动态引用。
普通显式 Submission 不带该字段，仍使用自己的冻结选择。

```text
选模命令 → Session Selection → ACK
Bot 异步解析 → CLI 核对读取依据 → 冻结 Submission → 执行 / 排队
已执行及已接纳输入 ─────────────────→ 保留原快照
```
