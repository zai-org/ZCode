# WebSearch Client Wrapper Tool

## 结论

`WebSearch` 是主模型可见的普通 client-side tool。模型调用 `WebSearch`
后，ZCode 在 tool handler 内部发起一个只包含 provider-native `web_search`
的 model request。内部 request 返回后，ZCode 把 links/sources 格式化为
普通 tool result，回灌给主模型继续生成最终答案。

主模型请求不得直接暴露 provider-native `web_search`。

## 设计目标

1. 主 loop 的 provider-visible tool name 是 `WebSearch`，执行模式是 `client`。
2. `WebSearch` 必须进入 `ToolExecutor`、permission、scheduler、hooks、事件、
   resultBudget、tool result history 和 replay 生命周期。
3. provider-native `web_search` 只允许出现在 `WebSearch` handler 发起的内部
   side request 中，并由 adapter 投影成 provider SDK helper。
4. public input schema 保持核心字段：`query`、`allowed_domains`、
   `blocked_domains`；同时保留当前 Anthropic provider-native `web_search`
   实际消费的 `maxUses` 可选调参字段。`searchContextSize`、`numResults`、
   `safeSearch` 不对主模型可见。
5. 不支持 native web search 的 provider/model 默认不向主模型暴露 `WebSearch`；
   如果运行时无法解析 provider capability，也不暴露 `WebSearch`。
6. handler 输出必须提取 provider 返回的 sources/results/usage，并用普通 tool result
   提醒主模型在最终答案中使用 markdown links 引用来源。

## Public Tool Contract

主模型看到的 contract：

| 字段 | 值 |
| --- | --- |
| `name` | `WebSearch` |
| `capability` | `web_search` |
| `executionMode` | `client` |
| `providerNative` | 不存在 |
| `readOnly` | `true` |
| `concurrentSafe` | `true` |
| `sideEffectScope` | `network` |
| `needsApproval` | `false` |

public input:

| 字段 | 说明 |
| --- | --- |
| `query` | 要搜索的自然语言 query |
| `allowed_domains` | 可选，只允许这些 domain 的结果 |
| `blocked_domains` | 可选，排除这些 domain 的结果 |
| `maxUses` | 可选，内部 provider-native 搜索次数上限，默认 `8` |

`allowed_domains` 和 `blocked_domains` 不能同时传入。domain 只接受 hostname，不接受
protocol、path 或 wildcard。

模型可见描述是固定文本。月份一行写作
`The current month is (provided in the conversation below)`，不写入真实月份：模型从会话中的
当前日期得知月份。描述里写真实月份会让 tools 段每个月变化一次，整个请求的缓存前缀随之失效。

## Internal Provider-Native Request

`WebSearch` handler 负责把 public input 转成内部 provider-native args：

| public 字段 | 内部 provider-native args |
| --- | --- |
| `allowed_domains` | `allowedDomains` |
| `blocked_domains` | `blockedDomains` |
| `maxUses` | `maxUses`，未传时默认 `8` |

内部 request 固定：

- system message: `You are an assistant for performing a web search tool use.`
- user message: `Perform a web search for the query: <query>`
- tools: 只包含 `web_search`
- toolChoice: 不设置。BigModel 的 Anthropic 兼容端点会拒绝 named forced
  `web_search` tool choice（1210）；当前依靠单工具请求和 prompt 触发 provider-native 搜索。
- metadata.querySource: `web_search_tool`

## Provider 映射

core 不 import `@ai-sdk/anthropic` 或 `@ai-sdk/openai`。adapter 是唯一把
provider-native contract 转成 SDK provider tool 的地方。

### Anthropic-compatible

内部 `web_search` 使用 `anthropic.tools.webSearch_20260209()`，并由 AI SDK 在内部
请求中生成：

```json
{
  "type": "web_search_20260209",
  "name": "web_search"
}
```

支持条件：

- provider kind 是 `anthropic`。
- resolved baseURL host 是 `bigmodel.cn`、`z.ai`、`deepseek.com` 或其子域。
- 未命中 allowlist 的 Anthropic-compatible provider 不投影 provider-native search。

### OpenAI

当前不投影 `openai.web_search`，即使 baseURL host 命中 WebSearch allowlist 也不暴露
`WebSearch`。WebSearch gate 必须同时满足 `providerKind === "anthropic"` 和 baseURL
host allowlist。

### 其他 Provider

`openai-compatible`、`gateway`、`custom` 当前不投影 WebSearch provider-native tool。
不要把它降级为普通 function tool，也不要恢复旧 BigModel Web Search REST API 或
DuckDuckGo HTML fallback。

## 注册、权限与执行

- `WebSearch` 注册进 `builtInTools`，默认主 agent 和 Explore agent 都可以按各自
  tool pool/allowlist 暴露它。
- `web_search` 仅作为 legacy allowlist alias 映射到 `WebSearch`；不得出现在主请求
  `tools[].name`。
- provider capability gate 优先在 runtime projection 过滤 `WebSearch`；handler 的
  `assertProviderSupportsWebSearch` 是第二道防线。
- capability gate 由 provider kind 和 resolved baseURL 共同决定；只有 `anthropic`
  且 baseURL host 是 `bigmodel.cn`、`z.ai`、`deepseek.com` 或其子域时才暴露。
- `WebSearch` 进入本地 `ToolExecutor` 并触发普通 tool lifecycle：
  `ToolCallScheduled`、`ToolCallStarted`、`ToolCallResult`、permission、hook、
  scheduler、resultBudget 和 session history。
- 内部 provider-native request 的 network status 通过 tool context 继续转发为
  `ModelNetworkStatus` 事件。

### 动态工作流子代理的搜索预算（2026-11-02）

- tool context 可带 `webSearchBudget`（`WorkflowWebSearchBudgetPort`）。只有动态工作流子代理
  的 runtime 注入它；主会话、`Agent` 子代理、legacy `Workflow` 子代理没有这个端口，也就没有上限。
- handler 在校验模型能力之后、发出内部请求之前调用 `charge()`。端口回 `exhausted` 时，handler
  不发请求，返回 `ToolHandlerFailure`（`WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE`），文案取端口给的
  `message`：本任务的搜索预算已用完，不要再调 WebSearch，用已有信息完成，并在结果里说明搜索被截断。
- 计数、上限与重置都归 driver：每个 ask 默认 128 次，persona 的 `budget.webSearch` 可改为
  0–1024；nudge、repair 轮共用同一计数，下一个 ask 归零。合同见
  `packages/dynamic-workflow/docs/execution-engine.md`「Search budget」与根目录
  `docs/dynamic-workflow/authoring.md`「A subagent's search budget」。
- 工具 schema、描述、权限与 tools 段字节不变；被拒的调用照常产生 tool lifecycle 事件，
  `tool_usage` 记为 error。

## 删除与迁移

删除或不恢复：

- 主请求直接追加 provider-native `web_search` contract。
- 旧 BigModel Web Search adapter tool。
- DuckDuckGo HTML fallback。
- `searchContextSize` / `numResults` / `safeSearch` 字段。
- public schema 中的 `allowedDomains`、`blockedDomains` legacy camelCase domain
  字段。

保留：

- `WEBSEARCH_PROVIDER_NATIVE_SPEC` 作为内部 request adapter 映射依据。
- `packages/adapters/src/model/tool-transform.ts` 中的 provider-native helper 映射。
- `ModelUsage.serverToolUse.webSearchRequests` 汇总 provider usage，并作为 nested usage
  计入主 turn。

## 测试要求

Core：

- public JSON Schema 暴露 `query`、`allowed_domains`、`blocked_domains`、
  `maxUses`，但不暴露 `allowedDomains`、`blockedDomains`、`searchContextSize`、
  `numResults` 或 `safeSearch`。
- `registerBuiltInTools()` 注册 `WebSearch`，不注册 `web_search`。
- 主 runtime 和 Explore child request 的 `tools[]` 包含 `WebSearch`，不包含
  `web_search`。
- `toolAllowlist: ["web_search"]` 能作为兼容 alias 暴露 `WebSearch`。
- handler 发起的内部 request 只包含 provider-native `web_search`，不设置
  `toolChoice`。
- `WebSearch` 作为只读并发安全 tool 进入 permission、scheduler 和 lifecycle event。

Adapters：

- 只有内部 provider-native `web_search` contract 会被映射为
  `anthropic.web_search_20260209`。
- 只有 Anthropic provider kind 且 baseURL host 命中 `bigmodel.cn`、`z.ai`、
  `deepseek.com` allowlist 时投影；官方 OpenAI、MiniMax、任意自定义/网关 provider
  不暴露 WebSearch。
- public client-side `WebSearch` 保持普通 function tool。

Trajectory：

- 主请求 request body 只出现 `WebSearch`。
- 内部 `metadata.querySource === "web_search_tool"` 的 request body 只出现 `web_search`。
- 当前 prompt-trajectory mock proxy 会影响 runtime provider capability 注入；后续若要恢复
  WebSearch trajectory testcase，需要让 harness 显式提供 allowlisted Anthropic baseURL。

回归：

- `CI=true pnpm typecheck`
- `CI=true pnpm lint`
- focused core/adapters vitest
- prompt-trajectory P-12 testcase；WebSearch testcase 需要先补 harness capability baseURL

## 剩余风险

- 当前先不实现 streaming progress；内部 request 使用 `generateText`，只保证
  request shape、tool lifecycle 和 tool result 符合本文契约。
- 不同 provider 对 citations、sources、providerExecuted tool result 的暴露不完全一致；
  handler 需要同时兼容 provider `sources`、typed tool result output 和 source-like
  result payload。
