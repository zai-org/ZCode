# Model HTTP Proxy

## 目标

模型 provider 的 HTTP(S) 请求必须支持 ZCode 显式代理配置，便于桌面端、debug app 或用户通过受控入口观察请求 URL、host、状态和流式响应。

同一套代理解析规则也必须复用于 `HttpClientPort`，这样 `WebFetch` 等非 provider HTTP I/O 不会和模型请求出现“一个走代理、一个直连”的漂移行为。`WebSearch` handler 发起的内部 provider-native `web_search` side request 仍走 provider transport，因此继续跟随模型请求代理策略。

同一套网络出口策略还必须进入子进程与扩展边界。ZCode 自己启动的 `Bash`、后台终端、stdio MCP server 等子进程如果可能发起网络请求，应先隔离 app/provider 运行时，再在 tool 边界恢复用户 shell 里的 `HTTP_PROXY` / `http_proxy` / `NODE_EXTRA_CA_CERTS` 等网络变量，避免这些变量意外污染模型请求，同时保留用户命令自己的网络环境。

桌面端 renderer 里的 `fetch`、XHR、页面资源和内嵌浏览器 WebView 同样属于 ZCode 自身出口。它们必须从设置页的显式 HTTP 代理读取策略，通过 Electron `session.setProxy` 分别应用到 `defaultSession` 与 `persist:zcode-embedded-browser`；不得依赖用户 shell 环境变量，即不继承 `HTTP_PROXY` / `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS`。设置页留空时两个 Session 的兜底行为不同：`defaultSession` 直连，把 ZCode 自身的后端与模型流量收敛到显式配置；`persist:zcode-embedded-browser` 跟随本机系统代理，因为它承载的是用户自己的浏览行为，必须与用户本机浏览器可达的站点保持一致。系统代理读取的是 OS 网络设置而非 shell 环境变量，因此不与上面的「不继承 shell 环境变量」冲突。

Desktop Window Host 在 SSH/WSL/Docker 部署期间发起的远程资源 manifest、组件归档和进度 `HEAD` 请求也属于 app-managed 出口。它们必须通过 Host 生命周期内冻结的 request-scoped transport 消费同一份设置页代理、No Proxy 和自定义 CA；禁止依赖裸 `globalThis.fetch` 或进程全局 dispatcher。`remote-download` 的组件归档仍由远端 `curl`/`wget` 下载，不继承桌面代理。

## 配置来源与优先级

1. 桌面端 `AppSettings.httpProxy`，由设置页显式填写并在启动 agent 时注入。
2. `network.httpProxy` 配置，适用于显式配置的统一模型代理。
3. `ZCODE_HTTP_PROXY` 环境变量，适用于 app/debug server/CLI runtime 显式注入。

Provider/app/通用 `HttpClientPort` 自身只使用以上显式来源；`WebFetch` 专用
`HttpClientPort` 在未命中显式 proxy 时，还可以读取 runtime 封存到
`ZCODE_TOOL_ENV_PASSTHROUGH_JSON` 的用户标准 proxy 变量作为 fallback。该 fallback 只读取封存副本，不直接继承当前进程里的裸标准环境变量，顺序为
`https_proxy`、`HTTPS_PROXY`、`http_proxy`、`HTTP_PROXY`、`all_proxy`、`ALL_PROXY`，即小写优先，与 undici 的读取顺序一致。

No Proxy 来源：

1. 桌面端 `AppSettings.httpProxyNoProxy`，由设置页显式填写并在启动 agent 时注入。
2. `network.noProxy` 配置，适用于显式配置的统一模型代理绕过规则。
3. `ZCODE_NO_PROXY` 环境变量，适用于 app/debug server/CLI runtime 显式注入。

No Proxy 对以上代理来源都生效，支持 `*`、精确 host、host:port、`.example.com` 和 `*.example.com` 形式。Provider/app/通用 `HttpClientPort` 不读取用户 shell 里的 `NO_PROXY` / `no_proxy`，避免绕过显式代理策略；`WebFetch` 专用 `HttpClientPort` 只在未命中显式 proxy 时读取 runtime 封存副本，按 `no_proxy`、`NO_PROXY` 小写优先。tool 子进程会在 passthrough 边界恢复用户自己的 no-proxy 环境，并由显式 No Proxy 配置覆盖同名变量。

自定义 TLS CA 来源：

1. `network.caCertFile` 配置。
2. 桌面端 `AppSettings.httpProxyCaCertPath`，由设置页显式填写。
3. `ZCODE_AGENT_CA_CERT` 环境变量，适用于 app/debug server/CLI runtime 显式注入。

运行时继承环境会过滤 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`、`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` / `GIT_SSL_CAINFO` 以及包管理器代理/CA 变量。过滤前会把这些用户 shell 网络变量封存到 ZCode 内部 `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`；该变量不参与 app/provider/通用 `HttpClientPort` 的代理解析，只作为 `WebFetch` 专用 fallback，或在 tool 子进程环境构造时恢复。

子进程代理与证书环境先恢复用户 shell 网络变量，再由显式网络策略覆盖同类目标。如果命中 `network.httpProxy`、`AppSettings.httpProxy` 或 `ZCODE_HTTP_PROXY`，adapter 会补齐 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写形式；如果命中 `network.noProxy`、`AppSettings.httpProxyNoProxy` 或 `ZCODE_NO_PROXY`，adapter 会补齐 `NO_PROXY` 与 `no_proxy`；如果命中 `network.caCertFile`、`AppSettings.httpProxyCaCertPath` 或 `ZCODE_AGENT_CA_CERT`，adapter 会补齐 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE` 和 `GIT_SSL_CAINFO`，提升 Node、OpenSSL/curl、Python requests 和 git 的一致性。`env.base: "empty"` 的命令不恢复用户 shell passthrough，只保留显式网络配置和命令级 overlay。

## 行为

- 代理解析逻辑由 adapter 统一实现，并同时服务模型请求与 `HttpClientPort`。
- 只代理 AI SDK provider 发起的模型 HTTP(S) 请求，不改写 provider `baseURL`。
- 动态 provider endpoint routing 必须先按
  [`provider-endpoint-routing.md`](./provider-endpoint-routing.md) 解析最终 URL，再执行 Proxy/No Proxy
  匹配；配置接口自身使用独立 `HttpClientPort`，不得进入 routing 形成递归。
- 无代理配置或命中显式 No Proxy 时继续使用原生 `fetch`。
- 启用代理时通过 adapter 层统一 fetch 转发，保留响应流，避免破坏 streaming。
- 当命中了自定义 CA 配置时，adapter 必须确保直连 HTTPS、HTTPS proxy 和 HTTP CONNECT 路径都使用同一份额外信任链。
- Desktop main 必须在创建首个窗口前把 Electron 网络策略独立应用到 `defaultSession` 与 `persist:zcode-embedded-browser`：设置页存在 `httpProxy` 时两个 Session 都使用 `session.setProxy({ mode: "fixed_servers", proxyRules, proxyBypassRules })`，其中 `proxyBypassRules` 来自 `httpProxyNoProxy`；留空时 `defaultSession` 使用 `mode: "direct"`，`persist:zcode-embedded-browser` 使用 `mode: "system"`，并在更新策略后关闭旧连接池。留空时不下发 `proxyBypassRules`——bypass 规则只对 `fixed_servers` 有意义，`system` 模式的例外列表由 OS 自己维护。两个 Session 中任意一个应用失败都不得阻止另一个继续配置；配置变更只保证下次应用启动生效，设置页必须提示用户重启。
- Desktop Window Host 必须把其托管的 proxy-aware transport 作为 `RemoteAssetNetworkPort` 注入 desktop-attached remote 部署。manifest、组件归档和进度 `HEAD` 不得在 transport 缺失或失败时回退裸 `fetch`；standalone server 未注入该 port 时保持原有直连合同。
- Chromium Session 的自定义 CA 不读取 `NODE_EXTRA_CA_CERTS`。仅当设置页存在 `httpProxyCaCertPath` 时，main 进程读取 PEM bundle，并分别用两个 Session 的 `setCertificateVerifyProc` 对链路中包含该 CA 的证书放行；留空时恢复 Chromium 默认校验。
- `persist:zcode-coding-plan` 等其它专用 WebView Session 不继承内置浏览器的网络策略。该边界只修复 renderer 与内置 Browser / Browser Use 的显式出口配置，不增加全局证书忽略开关，也不放行未配置的自签名证书。
- adapter 自己发请求（代理、自定义 CA、`WebFetch` 公网 DNS 校验）时，对上游状态码的处理必须与原生 `fetch` 一致，且**一次响应永远不能打死 agent 进程**：`HttpClientPort` 原样带回任何状态码，包括 200–599 之外的非标准码（LinkedIn 对爬虫回 `999`），由调用方按普通非 2xx 处理；204 / 205 / 304 等无正文状态得到空正文。proxy-aware fetch 必须返回 WHATWG `Response`，它表示不了 200–599 之外的状态，所以那一次请求以带 `code: "ZCODE_UNSUPPORTED_HTTP_STATUS"` 与 `status` 的 `TypeError` 失败，与网络错误同一条路径。把 Node 响应转成上层对象的代码一律在 `http.request` 回调里 try/catch，失败即销毁响应并 reject 这一次请求。
- `HttpClientPort` 响应应携带脱敏后的 `egress` 摘要，至少包含是否走代理、代理来源、代理 host、是否命中 `NO_PROXY`、是否使用自定义 CA。
- `ExecutionPort` 在 spawn 子进程前必须从基础设施层构造环境变量：先选择继承或空环境并过滤通用运行时/代理/证书变量，再恢复已封存的用户 tool 网络环境，然后注入显式网络出口策略，最后应用单次执行的 `env.set` / `env.unset` overlay。这样普通命令默认拿到用户 shell 网络配置，同时保留 app/provider 的显式网络边界和命令级例外。
- 当 `network.httpProxy` 或 `ZCODE_HTTP_PROXY` 存在时，子进程环境必须补齐 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及对应小写变量；用户标准代理变量不作为 provider/app/通用 `HttpClientPort` 继承输入，只能通过 `WebFetch` 专用 fallback 或 tool passthrough 进入受控边界。
- 当 `network.noProxy` 或 `ZCODE_NO_PROXY` 存在时，子进程环境必须同时补齐大小写形式；标准 `NO_PROXY` / `no_proxy` 不作为 provider/app/通用 `HttpClientPort` 继承输入，但可作为 `WebFetch` 专用 fallback，或作为用户 tool passthrough 恢复。
- stdio MCP server 的启动环境必须走同一个子进程网络环境构造函数；HTTP/SSE MCP transport 必须传入 proxy-aware fetch，不能依赖 Node 的 global fetch 自动读取代理环境。
- core、bootstrap、CLI、TUI 和普通业务 adapter 不得直接调用 `fetch`、`http.request` 或 `https.request`；例外只允许在明确的网络 adapter/provider transport 边界中出现，并由架构测试守住。

## 边界

本阶段是“默认网络出口收敛”，不是不可绕过的系统级防火墙。子进程仍可以在命令内部删除代理环境、使用自带网络栈或通过非 HTTP 协议出网。强制所有网络流量必须经过统一出口，需要后续引入 OS sandbox、容器网络策略或本机防火墙级别能力。

## 取消与资源寿命

请求归一化沿用调用方的有效 signal（init.signal 优先，其次 Request.signal；显式 null 表示不继承）。不能只留下临时 Request 生成的从属 signal：Request 的 controller 被 GC 后，父信号的取消可能不再传入。响应正文未读完时，取消仍须关闭连接。

每次请求的 signal 同时传给代理连接建立层。HTTPS CONNECT 等待响应期间 socket 尚未移交 ClientRequest，单独 destroy ClientRequest 无法释放它。取消必须关闭该 socket，且不能影响其它请求。回归使用本地真实 server，覆盖 GC 后流取消、CONNECT 未响应时取消和并发隔离。

响应正文结束与底层连接收尾是两个独立边界。proxy-aware fetch 的 `ClientRequest` 错误监听随请求对象回收，不能在响应或请求的 `close` 时提前移除，也不能只监听一次：底层 socket 与 TLS 可先后转发错误。HTTP MCP 握手读取失败响应后会立即关闭 transport；此时代理 socket 的取消错误仍可能经过 TLS socket，在请求 `close` 之后传回请求。该错误只结束当前连接，不得成为进程级未捕获异常；响应正文尚未结束时，读取方仍须收到取消错误。模型流也会这样：失败的尝试结束时才统一 abort，此时响应已读完。回归覆盖 HTTPS CONNECT 成功后的取消、正文读完后立即取消并继续发起下一次请求、普通 HTTP 代理下响应读完后调用方才取消，以及单个 MCP 握手失败后另一个 MCP 仍能调用工具。

## 测试覆盖

- `ZCODE_HTTP_PROXY` 能让模型请求经过本地 HTTP proxy。
- `network.noProxy` 或 `ZCODE_NO_PROXY` 命中时模型请求绕过代理直连上游。
- `ZCODE_HTTP_PROXY` 也能让 `WebFetch` 经过同一代理；`WebSearch` handler 内部模型请求会复用 provider 传输层代理。
- `ZCODE_AGENT_CA_CERT` 能让 `WebFetch` 信任自定义 CA；`WebSearch` handler 内部模型请求会复用 provider 证书策略。
- `network.httpProxy` 或 `ZCODE_HTTP_PROXY` 能注入到 `ExecutionPort` 子进程环境，并补齐大小写代理变量。
- `network.caCertFile`、`AppSettings.httpProxyCaCertPath` 或 `ZCODE_AGENT_CA_CERT` 能被补齐到 Node、curl、git、Python requests 常见变量。
- 桌面端设置页 `httpProxy` 能在重启后同时应用到 Electron `defaultSession` 与 `persist:zcode-embedded-browser`，使 renderer 和内置 Browser / Browser Use 流量走显式代理；留空时 `defaultSession` 直连，`persist:zcode-embedded-browser` 跟随系统代理，使内置浏览器与用户本机浏览器可达的站点保持一致。
- 桌面端设置页 `httpProxyNoProxy` 能在重启后同时应用到两个目标 Session 的 `proxyBypassRules`，并注入 agent 的 `ZCODE_NO_PROXY` / `NO_PROXY` / `no_proxy`。
- 桌面端设置页 `httpProxyCaCertPath` 能在重启后注入 agent `NODE_EXTRA_CA_CERTS`，并让两个目标 Session 信任由该 CA 签发的 TLS 证书；其它专用 WebView Session 不受影响。
- 桌面端设置页 `httpProxy`、`httpProxyNoProxy` 和 `httpProxyCaCertPath` 能控制 Window Host 的远程资源 manifest、组件归档和进度 `HEAD` 请求；显式代理失败时不得发生直连请求。
- `defaultSession` 网络策略应用失败时，`persist:zcode-embedded-browser` 仍继续配置；反向同理，并按 Session 名称记录可诊断日志。
- 用户 shell 里的标准代理/证书变量不会直接进入模型请求、app runtime 或 `WebFetch`；`WebFetch` 只读取 `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` 中封存的标准 proxy/no-proxy fallback。它们也会经该封存变量恢复到继承式 tool/MCP/Bash 子进程。命令级 env overlay 仍可显式覆盖或删除。
- stdio MCP server 能继承统一网络环境，HTTP/SSE MCP transport 能获得 proxy-aware fetch。
- 走代理时上游回 `999` / `204` / `304`：`HttpClientPort` 带回原状态码（204 / 304 正文为空）；proxy-aware fetch 对 204 / 304 返回空正文的 `Response`，对 `999` 以 `ZCODE_UNSUPPORTED_HTTP_STATUS` 失败；两者都不产生 uncaughtException（`packages/adapters/tests/http-response-status.test.ts`）。
- 架构测试扫描进程内源码，防止新增直接 HTTP 出口绕过统一网络边界。
