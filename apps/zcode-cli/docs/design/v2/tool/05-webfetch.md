# WebFetch Tool

## 定位

`WebFetch` 抓取 URL 内容，转换为 markdown，并用小模型按 prompt 提取结果。

ZCode v2 第一版实现遵循本文的 L2 runtime 契约：工具本身只表达“抓取并提取网页内容”的意图，实际 HTTP I/O、权限判断、缓存、artifact 写入和二级模型调用都必须通过显式 port 或 service 完成。

实现状态（2026-05-08）：L2a 主线已经落地。`packages/contracts/src/tools/webfetch.ts` 定义运行时和 provider JSON schema，`packages/core/src/tool/handlers/webfetch*.ts` 实现 URL 规范化、host 形态校验、`HttpClientPort` GET、manual safe redirect、HTML/text 提取、内存 fetch cache、lite model prompt 处理、结果预算和网络状态事件。权限层通过 `packages/core/src/permission/service.ts` 使用 `domain:<hostname>` 优先匹配 WebFetch project rule。当前仍未落地跨 session 持久 cache、robots/meta 策略，以及真正的 binary artifact 保存；非 text-like content 目前会返回结构化失败。

实现状态（2026-06-28 provider-visible 约定）：`WebFetch` 会把用户显式提供的 `http:` URL 规范化为 `https:` 后再发起抓取；`https:` URL 保持原协议。工具结果里的 `url` 保留用户原始输入，`finalUrl` 表示实际请求 URL。安全约束继续由 host 形态校验、权限规则、manual redirect 校验和代理/审计链路负责。

实现状态（2026-07-07 修正）：`WebFetch` 主链路移除外部 `domain_info` / WebFetchPreflight 前置校验。此前调用第三方 domain safety service 会在企业网络、代理或安全策略阻断该服务时，让原本可访问的目标 URL 在真实 fetch 前失败。当前契约改为：通过 URL runtime schema、用户/项目 `domain:<hostname>` 权限规则、`HttpClientPort` 统一网络入口、manual safe redirect、egress proxy 响应和网络事件审计承担边界；handler 不再在目标请求前依赖外部域名判定服务。

实现状态（2026-07-08 安全边界调整）：ZCode 的 `WebFetch` 请求从 agent runtime 所在机器发出，而不是强制经过远端 WebFetch proxy。移除外部 `domain_info` 后，当前只保留 URL 字面量层面的本地/私网目标阻断：普通域名不做本地 DNS lookup preflight，避免公网目标因为本机 DNS 慢或企业网络解析策略在真实 fetch 前失败；字面量 IP、`.localhost` 等本地目标仍在进入 `HttpClientPort` 前阻断。IP 解析和基础 range 判断复用 `ipaddr.js`，ZCode 只保留 WebFetch 专用 public policy、IPv4-mapped IPv6、DNS64 `64:ff9b::/96` 解包、`198.18.0.0/15`、`64:ff9b:1::/48`、`100::/64`、`2001:2::/48`、`2001:10::/28`、`2001:20::/28` 等 URL 字面量安全覆盖。该 guard 不能被 `network.noProxy` / `NO_PROXY` 绕过。

## 输入契约

`WebFetch` 输入是严格对象：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | `string` | 是 | 完整合法 URL |
| `prompt` | `string` | 是 | 对抓取内容要执行的提取或分析指令 |

设计要求：

- URL 必须可由标准 `URL` 解析。
- 仅支持 `http:` 和 `https:`；`http:` 会在权限和网络请求前规范化为 `https:`，`https:` 保持原协议。
- URL 长度最大 2000 字符。
- URL 不能携带 username/password，避免凭据进入日志、权限规则和模型上下文。
- host 必须先满足公开域名形态：hostname 至少包含两个以 `.` 分隔的片段。该规则会拒绝
  `localhost` 等 single-label host。
- 每次真实 GET 前必须执行 URL 字面量 egress guard：拒绝 `.localhost`、loopback、
  link-local、private、carrier-grade NAT、multicast、unspecified、broadcast、reserved 等
  非公网字面量 IP。普通域名不再做本地 DNS resolve preflight；IP parse/range 使用
  `ipaddr.js`，同时对 IPv4-mapped IPv6 和 DNS64 `64:ff9b::/96` 解包后复用 IPv4 public
  policy；`198.18.0.0/15`、`64:ff9b:1::/48`、`100::/64`、`2001:2::/48`、
  `2001:10::/28`、`2001:20::/28` 等库标记为 unicast 但不应被
  WebFetch 访问的特殊段由 ZCode policy 继续阻断。
- prompt 不能为空，最大 8000 字符。
- prompt 描述要提取的信息，不能替代权限。
- 如果有 MCP 提供的认证 web fetch，应优先使用 MCP 工具。
- GitHub URL 优先建议用 `gh` CLI，因为可能需要认证和结构化 API。

## Prompt 约束

ZCode 为 `WebFetch` 提供完整的 tool prompt 语义，而不是只给模型一行
“Fetch a URL”。provider-visible tool description 应由短 `description` 加
`modelInstructions` 组成，投影后至少表达：

- 必须显式警告：`WebFetch WILL FAIL` 于认证或私有 URL；使用前要判断 URL 是否指向
  Google Docs、Confluence、Jira、GitHub 等认证服务，并优先寻找可认证访问的专用
  MCP tool。
- `WebFetch` 会抓取指定 URL，把 HTML 转成 markdown，再用小而快的模型按 `prompt`
  处理网页内容，并返回模型对页面内容的回答。
- 需要检索并分析网页内容时使用；输入由 URL 和 prompt 组成，`prompt` 应描述要从页面中
  提取或分析的信息。
- 如果 MCP 提供 web fetch tool，应优先用 MCP 版本，因为它可能有更少限制或认证能力。
- URL 必须是完整合法 URL；`http:` 会按 provider-visible 约定先规范化为 `https:` 后抓取，`https:` 保持原协议。
- 说明 `localhost` 等不含 `.` 的主机名会失败，本地服务改用 Bash 的 curl（与上文 host 形态校验一致）。
- tool 是只读能力，不修改任何文件，但会执行网络 GET，并可能写入 session artifact/cache。
- 大内容可能被摘要化；同一 URL 结果会进入自清理的 15 分钟、50 MB 内存 cache，重复访问更快。
- ZCode 只自动跟随同 host/`www.` 级别的安全 redirect；跨 host redirect 不会自动抓取新主机，
  错误信息必须带出 redirect URL，模型只能在用户意图和权限允许时用新 URL 重新发起请求。
- GitHub URL 优先考虑 `gh` CLI / GitHub API，例如 `gh pr view`、`gh issue view`、`gh api`，
  因为它们通常更适合认证、PR、issue 和结构化数据读取。

## 输出契约

输出：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bytes` | `number` | 抓取内容大小 |
| `code` | `number` | HTTP 状态码 |
| `codeText` | `string` | HTTP 状态文本 |
| `result` | `string` | prompt 处理后的结果 |
| `durationMs` | `number` | 抓取和处理耗时 |
| `url` | `string` | 原始请求 URL |

ZCode 输出结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | `string` | 原始请求 URL |
| `finalUrl` | `string` | 实际抓取 URL，包含安全 redirect 后的位置 |
| `status` | `number` | HTTP 状态码 |
| `statusText` | `string` | HTTP 状态文本 |
| `contentType` | `string` | 响应 content type |
| `bytes` | `number` | 原始响应字节数 |
| `durationMs` | `number` | 总耗时 |
| `result` | `string` | prompt 处理后的结果 |
| `cacheHit` | `boolean` | 是否命中 fetch cache |
| `redirects` | `array` | 已接受的安全 redirect 链 |
| `artifactUri` | `string?` | 原始 markdown/text 内容被落盘时的 artifact 引用 |
| `artifactPath` | `string?` | adapter 返回的本地 artifact 路径，仅用于内部/UI 追踪，不要求模型可见 |
| `truncated` | `boolean` | 输入二级模型或模型可见结果是否被预算截断 |

模型可见结果只返回 `result`，完整结构进入 tool result event 和内部 output。

## 行为语义

目标核心流程如下；带“后续”的条目不属于当前 L2a 实现：

1. 校验 URL。
2. 保留 URL 的显式协议和端口，禁止在请求前自动把 HTTP 改写为 HTTPS。
3. 检查 15 分钟 URL 内容缓存。
4. 发起 GET 请求，设置 user agent、content length 上限和 3 分钟超时。
5. HTML 转 markdown，非 HTML 按原文本处理。
6. 后续：binary content 额外落盘，并在结果末尾提示保存路径；当前非 text-like content 直接失败。
7. 非预授权或大内容调用小模型处理 prompt。
8. 后续：预授权 markdown 且长度较小时可直接返回内容；当前始终调用 lite model 执行 prompt。
9. 缓存抓取结果。

资源限制：

- URL 最大长度 2000。
- HTTP 响应最大 10 MB。
- 主 fetch 超时 3 分钟。
- same-host redirect 最大 10 次。
- markdown 输入二级模型前最多 100000 字符。
- URL cache TTL 15 分钟，总大小 50 MB。

第一版 ZCode 实现采用渐进落地策略。当前代码已经覆盖 L2a 主线，但 L2b 仍是后续工作：

- 已实现 L2a：URL 长度和 prompt 长度 schema、URL 解析、HTTP->HTTPS 规范化、host 形态校验、WebFetch URL 字面量 egress guard、domain 权限 rule、`HttpClientPort` GET、manual redirect 安全、HTML/text 提取、10 MB 响应上限、15 分钟/50 MB 内存 cache、lite model prompt、结果预算、artifact 写入接口、大内容截断、trace 传播和 `network_request_status` 事件。
- 待实现 L2b：binary artifact、跨 session 持久 cache、robots/meta 策略、更完整 HTML 清洗，以及更细粒度的 path 级网络权限规则。

## Redirect 策略

WebFetch 不会无条件跟随跨主机 redirect：

- 协议必须相同。
- port 必须相同。
- redirect URL 不能带 username/password。
- host 允许只增删 `www.` 或保持同一 host。
- 其他 redirect 返回特殊结果，要求模型用新 URL 再调用一次 `WebFetch`。

这样可以避免可信域名 open redirect 被用来绕过用户授权。

## 权限模型

`WebFetch` 是只读且并发安全，但有网络副作用。

权限规则内容是 `domain:<hostname>`，其中 hostname 必须标准化为小写并去掉末尾点：

- 预授权 host/path 可直接 allow。
- explicit deny 直接 deny。
- explicit ask 进入 ask。
- explicit allow 直接 allow。
- 无规则默认 ask，并建议在 local settings 增加 allow rule。

预授权域名只适用于 WebFetch 的 GET 请求，不应共享给 sandbox 网络权限。ZCode 应把这点写进 `NetworkPermissionPolicy`，避免 GET 预授权扩大成任意网络访问。

`PermissionService` 在处理 `WebFetch` 时应使用 `domain:<hostname>` 作为 rule subject，而不是完整 URL。用户点 “always allow” 时，建议保存 `domain:<hostname>`，不保存带 path/query 的 URL，除非后续引入 path 级规则。

## 安全和版权约束

二级模型 prompt 对非预授权域名有额外约束：

- 只基于网页内容回答。
- 精确引用有长度上限。
- 不复现歌词。
- 不输出法律自评。

ZCode 如果支持 WebFetch 摘要，也应把版权和引用限制放在 `WebFetchProcessingPolicy`，而不是散落在 prompt 字符串里。

## 校验与错误

关键失败路径：

- URL 无效。
- URL 过长。
- URL 带 username/password。
- host 不是公开可解析形态。
- egress blocked。
- redirect missing Location。
- redirect 过多。
- content length 超限。
- fetch timeout。
- 二级模型被取消或失败。

错误需要保留 domain、URL、HTTP code、是否 egress blocked 等结构化字段。

## ZCode 设计结论

`WebFetch` 应拆为：

- `WebFetchTool`：schema、权限入口、result serialization。
- `HttpClientPort`：统一网络入口，带超时、代理、证书、重试和审计。
- `NetworkPermissionPolicy`：domain rule、preapproved list、redirect safety 和 public egress safety；不依赖外部 domain safety service 前置校验。
- `ContentExtractionService`：HTML to markdown、binary persist、content budget。
- `ModelSummarizationPort`：二级模型调用，受取消和 token/cost 观测约束。
- `FetchCache`：带 TTL 和大小预算的缓存。

### `HttpClientPort`

`HttpClientPort` 是所有非 provider HTTP I/O 的基础 contract。WebFetch 第一版只需要 GET，但 port 设计必须能支持后续 remote config、telemetry 和 MCP HTTP transport 收敛。

`WebFetch` 专用 `HttpClientPort` 的网络环境要求：

- 显式 `network.httpProxy` 配置优先。
- 未显式配置时，先读取 `ZCODE_HTTP_PROXY`；再读取 runtime 已封存到
  `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` 的用户标准代理变量。不得直接继承当前进程里的
  裸 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，因为 runtime 初始化会先清理这些变量，
  只在明确的工具/网络边界恢复。
  runtime 封存代理变量按小写优先读取（与 undici 的读取顺序一致）：
  `https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY`、`all_proxy`、`ALL_PROXY`。
- `network.noProxy` 必须同时对 WebFetch 生效；`ZCODE_NO_PROXY` 和 runtime 封存的
  `no_proxy` / `NO_PROXY` 可作为 fallback，且小写优先。runtime 封存的 `no_proxy`
  只参与 WebFetch fallback，不绕过显式 `network.httpProxy` / `ZCODE_HTTP_PROXY`。
  裸标准环境变量不作为继承输入。
- 自定义 CA 至少支持 `network.caCertFile` 和 `ZCODE_AGENT_CA_CERT`；标准 CA 变量只由 runtime 派生给受控子进程。
- WebFetch 自己不得重新解析这些环境变量，必须完全复用 `HttpClientPort` 的统一解析逻辑。
- WebFetch 通过 `HttpClientPort` 使用普通 HTTP 总请求超时，默认 60000ms；该超时不适用于 provider SSE 等长流式请求。
- WebFetch 请求必须在 tool handler 层执行 URL 字面量 egress policy，再进入 `HttpClientPort`。
  修复原因：ZCode WebFetch 不强制经过远端 WebFetch proxy；
  移除外部 `domain_info` 后，只依赖普通 HTTP proxy / noProxy 会让模型驱动的 GET 访问
  agent runtime 所在机器的本地服务、云 metadata endpoint 或内网地址。当前策略暂不对普通
  域名做本地 DNS lookup，只阻断 URL 中直接出现的本地/私网目标。
- URL 字面量 egress guard 必须早于代理/noProxy 解析生效，不能被 `NO_PROXY=127.0.0.1` 等配置绕过。

请求字段：

- `url`：完整 URL。
- `method`：第一版 WebFetch 固定 `GET`。
- `headers`：由 tool/service 传入，adapter 追加 trace header。
- `timeoutMs`：外层超时，由 tool contract 和输入共同裁剪。
- `maxResponseBytes`：响应体硬上限。
- `redirect`：`manual` 或 `follow`，WebFetch 使用 `manual` 并由 tool service 判断 same-host 安全 redirect。
- `trace`：必须携带同一 `traceId`。

响应字段：

- `url`、`status`、`statusText`、`headers`、`body`、`bytes`、`durationMs`。
- `bodyTruncated` 只允许在明确的预览请求里出现；WebFetch 正式抓取超过上限应抛结构化错误，不静默截断。

已覆盖测试：

- `packages/core/tests/webfetch-tool.test.ts` 覆盖显式 HTTP URL 规范化为 HTTPS、HTML 转 markdown 后交给 lite model、模型可见结果只返回 `result`、内存 cache 命中仍按新 prompt 处理、literal local/private IP 拒绝、`.localhost` 拒绝、普通域名不触发 DNS preflight、DNS64 私网字面量映射拒绝、公网 IP 字面量允许、`198.18.0.0/15` / `64:ff9b:1::/48` / `100::/64` / `2001:2::/48` / `2001:10::/28` / `2001:20::/28` 特殊段拒绝、cross-host redirect 拒绝、single-label host 拒绝、网络 pending/complete/error 状态事件。
- `packages/core/tests/permission-service.test.ts` 覆盖 WebFetch project rule 使用规范化 `domain:<hostname>` 匹配，以及 domain deny 覆盖完整 URL allow。
- `packages/core/tests/tool-contracts.test.ts` 覆盖 WebFetch tool contract 声明为 `sideEffectScope: network` 且需要审批。
- `packages/adapters/tests/http.test.ts` 覆盖 `HttpClientPort` trace header、`ZCODE_HTTP_PROXY`、runtime 封存代理、`network.noProxy`、`ZCODE_AGENT_CA_CERT`、标准代理/证书变量过滤、响应大小上限和 unsupported protocol；`packages/adapters/tests/http-response-status.test.ts` 覆盖走代理时上游回 `999` / `204` / `304` 原样带回、不打死进程。
- `packages/desktop/test/e2e/conversation-session/tools/conversation-session-webfetch.test.ts`
  保留桌面会话 `WebFetch` 成功闭环用例，但当前位于 `manual-review/pending`，不能计入正式自动覆盖。
  fixture 仍位于 `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-webfetch.json`。

剩余测试重点：

- domain rule allow/deny/ask。
- binary 内容落盘。
- 大内容截断。
- abort signal。
- 预授权域名不扩散到 sandbox 网络权限。
- egress blocked 的结构化错误字段。
