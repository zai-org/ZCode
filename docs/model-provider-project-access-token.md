# 第一方 Token 鉴权迁移

状态：Token-only 请求入口已接入，Key ID 持久化已实现；相关本地回归通过，CLI 全量检查仍有已复现的历史基线失败，详见下方验证记录。2026-09-23 用户最终确认：保留专用 Key 查找/创建，取返回的 apiKey ID 换 Token；删除 Copy Secret 与旧 Key 回退。
[迁移评审](https://internal-docs.example.invalid/redacted)和
[测试交接](https://internal-docs.example.invalid/redacted)随最终实现更新。

## 已确认行为

- 个人/团队/Standalone 查找专用 Key；不存在时创建。个人名称 zcode-api-key；团队名称 zcode-team-api-key，保留 keyType=2；创建显式 usageScene=1。查询不增加 usageScene 过滤。
- 返回的 apiKey 是非 Secret 的 Key ID，作为签发路径参数。组织、项目和 Key ID 分别编码，不跨项目挑选 Key。
- POST /api/biz/v1/organization/{org}/projects/{project}/api_keys/{id}/access_tokens，使用 Bearer 登录 JWT，body 包含 clientType=zcode 与真实 clientVersion。
- 所有原先使用 API Key 的业务接口可使用 Token；通过逐接口测试表复测，不继续把兼容性作为实施前置阻塞。
- 新客户端只走 Token；没有旧 Key 回退。明确 enable=false 或畸形响应时记录脱敏日志并失败。无可用 PAT 时，签发请求按下述一次临时故障重试规则处理，耗尽后失败；已有未过期 PAT 的提前刷新仅按下文的临时故障规则容错；省略 enable 时按默认开启处理，但仍严格校验 Token 和有效期。
- Project Access Token 由平台签发，仍遵守官方版本的请求安全校验准入规则，不能因使用 Token 而跳过；用户手工 Key 的既有安全校验行为保留。
- CLI 有明确 manual 来源标记的手工 Key 保持独立语义；旧记录无来源标记且无 OAuth 时无法判定是否为旧派生 Key，须重新登录或重新选择手工 Key，不猜测来源而回退。第三方 Provider Key 保持原契约；Start Plan、官方 MCP、reset 既有 JWT 身份通道保持。
- 不再读取/存储 OAuth 派生的长期 Secret，不删除旧客户端共享的登录态；手工 Key 不被清理。旧版本使用原服务端接口的能力不由新客户端改写。

## 专用 Key 管理兼容契约

- 个人仍按名称复用 zcode-api-key；同名条目缺少 ID 时失败，不重复创建。团队只复用名称 zcode-team-api-key、keyType=2 且 ID 非空的条目，创建响应也必须满足这三个条件，否则禁止继续换证。无关坏条目不影响有效条目。
- customerInfo 两 family 均用原始登录 JWT，和登录身份核验一致，避免 Bearer 格式拒绝被误判为登录失效。Key 列表/创建保留旧 Authorization：个人 BigModel 用原始登录 JWT，Z.AI 用 Bearer；团队两 family 均用原始登录 JWT，并保留组织项目头。access_tokens 统一使用 Bearer。
- 桌面个人选择非团队项目（projectType 去空白后不为 2），跳过无组织 ID 的候选；Standalone 保留默认机构/默认项目优先、否则首项的规则，不新增项目类型过滤。团队成员归属比较继续去除 ID 两端空白。
- 项目选择策略由调用端明确传给公共换证客户端，参与内存与持久化 ID 作用域，防止桌面和 CLI 共用记录时覆盖彼此的选择。既有 Token owner、刷新和退出失效时序不变。
- 验收覆盖错误团队创建响应、无关坏条目、个人同名坏 ID、两 family 管理/签发请求头、混合项目选择和跨策略 ID 隔离。

## 旧凭据依赖检查与升级约束

OAuth 账号恢复、可用性判断及请求鉴权均不得读取、解密或依赖旧 account-provider:\*:api-key；登录态有效且旧 Key 缺失或密文损坏时，仍按原账号身份换 Token。Standalone 无来源标记但有 OAuth 的旧记录自动使用 OAuth；只有明确 manual 才读取手工 Key，手工模式不依赖另存的 OAuth 是否可解密。无登录态的历史歧义记录仍要求重新选择登录方式。
远程 Provisioning 仅同步 OAuth allowlist，远端通过自身的 Token owner 签发；不导出旧账号 Key 或短期 Token，也不跨环境复制 Key ID 缓存。schemaVersion=1 的旧 account-provider 条目仅接受格式校验后忽略，不读取、覆盖或删除现存旧/手工 Key。Personal Config 中显式手工 Provider 的 Key 仍沿原配置通道同步。
团队 Key ID 就绪检查和请求期凭据非空校验必须保留；`apiKey` 传输字段暂保兼容，其 OAuth 值为 Token。移除无调用的 UI Key 指纹刷新函数及无效 Credential Store 注入，避免再次引入“Key 必须落盘才可用”的条件。登录 Token 失效、无权限和团队 ID 创建失败保持显式错误，不回退旧 Key。
Desktop 附加远程工作区的用量鉴权优先复用 sourceServices 中现有 Local Host owner；旧附加入口没有 owner 时，在原本本机服务边界内使用同一换证工厂，不能保留只读旧 Key、解析回调恒为空的实现。个人/团队共用一个 Token 客户端与 ID Store，登录变更清理缓存；不改变手机 replayable 路由。
验收：旧 Key 缺失/坏密文但 OAuth 有效可恢复；手工 Key 不受坏 OAuth 影响；本地/远端有坏旧 Key 不阻断同步且原记录不动；旧信封可接收但不应用 Key；OAuth 删除、回滚、幂等和手机/桌面既有 owner/流边界保持。

本轮核查保留的判断：手工配置 `api-key` 的非空校验；团队 `apiKeyStatus` 的 ID 就绪校验；请求期 `auth.apiKey` 的非空校验（OAuth 值为 Token）。这些均不检查旧 account-provider Secret 是否存在。UI 保存时的 Key 变化比较仅作用于手工 access，OAuth 返回空值并由账号/权益事件刷新。

升级兼容范围：本版 Host 不修改旧 Key 记录；旧 Source → 新 Target 的 schema v1 信封有回归。新 Source 输出 v2，旧 Target 的 v1 校验在任何写入前拒绝，因此同步报错但不会删除已有凭据；需要升级 Target 才能继续同步；正常远程资源使用客户端版本对应 CDN 路径。

## 状态与边界

```text
登录态 / 稳定账号身份 → 既有账号鉴权 owner → 有效 Token → 单次 HTTP attempt
                         │                     ↑
                         └─ 内存缓存 / 并发合并 ┘
退出 / 切账号 → 清缓存及失效 generation → 拒绝迟到请求结果
```

Host 沿用 IAccountRequestAuthService；Standalone 沿用请求 adapter。
Key ID 可持久化：只存 organizationId/projectId/apiKeyId，按环境、family、稳定账号、个人/团队项目隔离；短期 Token 与登录 JWT 不进入该记录。重启复用 ID 直接换证，签发端明确 404 时清除元数据，下次重新查找/创建；其他鉴权错误只报错，不回退旧 Key。
Token 不写 Provider Config、Registry、Session、UI 快照、日志或 credentials.json。
按签发响应有效期刷新，提前 120 秒加 0–60 秒抖动；保留已建立 SSE，新 HTTP attempt 重新检查有效期。提前刷新仅在明确的网络/超时或 HTTP 429/5xx 临时故障时复用当前仍未过期、未被模型拒绝的 PAT，最多使用到原 expiresAt，每 5 秒才允许再次刷新，并记录固定脱敏事件 project_token_refresh_deferred。缓存与 pending 仍由同一个 owner 管理，并发请求共享刷新及降级结果。401/403/404、enable=false、取消、未知异常和畸形响应立即失败并清缓存；退出或切账号期间的迟到失败不得返回旧 PAT。显式拒绝指纹匹配时先移除旧值，刷新失败不能复用它。该容错不读取长期 API Key、不延长有效期、不重放模型请求。
签发与管理响应共用成功码契约：数字或字符串的 0/200；Token 类型、非空值和有效期仍严格校验。真实后端样例联调另行记录，兼容测试不等于已完成联调。

```text
同一 PAT owner：提前刷新 → 成功替换缓存
                         → 临时故障 + 原 PAT 有效且未拒绝 → 共享旧值，5 秒退避
                         → 认证拒绝 / 过期 / 退出 / 无效响应 → 清除并失败
```

账号身份不能取短期 Token 的哈希。桌面 continuous、手机 replayable 和 workspaceIdentity 隔离保持。

### 换证失败错误码

公共换证客户端只向调用方和 observe 事件传播固定错误码，不保留上游 message、cause、URL、响应体或 Token。I/O adapter（Host `readApiJson`、CLI HttpClientPort）负责把请求失败归类为结构化类别，客户端按类别映射：

| 失败类别                                                                                       | 错误码                                                                                 | 是否属于临时故障 |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------- |
| 无 HTTP 响应的传输失败（连接、DNS、TLS 等）                                                    | `project_token_network_error`                                                          | 是               |
| 内部请求超时                                                                                   | `project_token_timeout`                                                                | 是               |
| HTTP 状态非 2xx（404 除外）                                                                    | `project_token_http_<status>`，例如 `project_token_http_401`、`project_token_http_503` | 仅 429/5xx       |
| HTTP 404（签发端会先清除 Key ID 位置）；2xx 响应但正文不是 JSON，或 envelope/数据不满足 schema | `project_token_invalid_response`                                                       | 否               |
| 其他未分类异常                                                                                 | `project_token_request_failed`                                                         | 否               |

是否允许提前刷新复用旧 PAT 仍只看“临时故障”类别，与错误码细分无关；错误码分类继续服务日志与 runtime headers 失败文本；不按错误文案猜测重试，不新增 Key 回退或 UI 分支。

### PAT 签发的一次临时故障重试（2026-10-28）

已解析出组织、项目及 Key ID 后，每次 PAT 签发最多发送两次 HTTP 请求。第一次由 I/O adapter 明确归类为网络错误、内部超时、HTTP 429 或 5xx 时，先由原缓存 owner 判断失败时是否仍有未过期、未被拒绝的 PAT：有则立即沿用原提前刷新降级规则，不增加第二次签发等待；没有才在同一共享操作内重试一次。其他错误、HTTP 401/403/404、业务拒绝、响应解析失败以及未分类异常均不重试。第二次失败后沿用原固定错误码，不放宽有效期校验。

HTTP 429 不立即重试。Host 与 CLI 只传递安全的 `Retry-After` 相对等待量（支持秒数与 HTTP 日期），共享 owner 在 1 秒等待上限内加抖动后重试；无有效响应头时等待 250–1000 毫秒。若服务端要求等待超过 1 秒，本次操作直接保留 429 错误，不提前重试，也不新增后台任务或第二套模型重试预算。等待结束后重新检查登录代次；旧 PAT 若在首次请求期间已经过期，不能因为请求开始时有效就继续返回它。

重试仅包住 `POST .../api_keys/{id}/access_tokens`。组织/项目查询、Key 查询和创建、OAuth 和业务 JWT 换证均不进入此重试；一次 Key 创建成功后签发重试仍使用相同 ID，不重复创建 Key。

共享 `ProjectAccessTokenClient` 仍是 Host 与 Standalone 的唯一 owner。两次签发共用原 cache pending；并发调用共享结果。失败后、重试前和结果提交前均核对原登录代次；clear 或切账号后旧操作不再重试，也不能写入新账号缓存。取消仍按现行边界：取消单个等待者不取消其他等待者持有的共享请求；全部等待者取消后，owner 的有界请求可结束，但不会恢复已取消调用。

```text
同一 owner + Key ID + pending
  -> 签发 1 -> 成功 -> 原有效期校验 -> 共享结果
           -> 已归类临时失败 -> 原 owner 仍有有效 PAT -> 提前刷新降级
                            -> 无有效 PAT -> 429 有界等待（其他临时失败不等待）
                                         -> 复核代次 -> 签发 2 -> 成功或最终失败
           -> 其他失败 -> 立即失败
clear / 账号变化 -> 旧代次作废 -> 禁止继续重试或提交
```

每次实际重试只记录固定事件 `project_token_request_retry`；Host 对应文案为“项目 Token 签发临时失败，准备重试”，与最终失败区分。不记录 URL、Token、响应体或异常原文。验收覆盖首签临时失败后成功、两次失败停止、有效 PAT 刷新不增加一次等待、429 的等待/超限/等待期间退出、非临时拒绝、Key 创建不重试、并发单飞、取消等待者及切账号的迟到失败/成功。桌面保留原登录并可自动恢复签发；不改变手机 replayable、桌面 continuous、模型选择或已输出 SSE 的处理。

2026-10-28 定向验证（早于 2026-10-29 增加的 429 退避及有效 PAT 直接降级，只证明当时的范围）：CLI 4 文件共 68 项通过；真实本地 HTTP 的 Host/CLI 25 个场景通过，首次超时后成功约 15 秒，两次超时后在约 30 秒停止，401/403 各一次、Key 创建失败一次。Electron 原位置恢复与新增冷缓存 503 恢复两项通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261028-144449-869`。未使用生产凭据，未验证真实平台、Windows/Linux 或实体手机。

## 长任务与业务登录凭据刷新

闲时模型每个物理 HTTP attempt 必须通过现有 Provider Runtime Headers 私有通道向 Host 换取当前 PAT。派发时仅冻结票据和账号作用域约束，不把派发时 PAT 当作整轮有效凭据。`requestAuth.accountScope` 是 Host 生成的不可逆作用域校验值（登录生命周期、family、个人/团队、组织/项目/产品），不作为账号身份、不包含短期 PAT、不持久化或写日志。后续请求带 `expectedAccountScope`；账号/套餐变化或换证期间作用域变化立即失败，不把原票据套到新账号。Mock 无真实 PAT，原静态注入保持。

```text
派发 → Host 账号 owner 生成作用域校验值 + 原票据
每次模型 attempt → 私有 runtime headers 通道（携带预期作用域）
                 → 同一 Host owner 校验作用域 → PAT TTL 检查/换证 → 再校验作用域
                 → CLI 仅更新 Coding Plan Token，保留原票据与该轮 JWT
退出/切账号/切套餐 → 作用域不匹配 → 当前轮失败，不回退旧凭据
桌面 continuous / 手机 replayable → 沿用原 task owner、workspaceIdentity 与事件顺序
```

Desktop Z.AI 的 deep link 和 polling 均在 `ZaiProviderAdapter` 登录边界调用 `/api/auth/z/login`；`oauth:zai:access_token` 已是业务 JWT，个人/团队 PAT owner 直接使用该值，不能二次兑换。Standalone 存储原始 OAuth Token，因此换证位置不同。回归覆盖 polling → 业务 JWT 落盘 → 个人/团队元数据 → PAT 签发的完整顺序。

Standalone Z.ai 的 `/api/auth/z/login` 成功结果按 `expires_in` / `expiresIn` 和 JWT `exp` 的最早值缓存，提前 120 秒刷新；无有效期元数据最多缓存 5 分钟。并发刷新合并；clear/登录变化拒绝迟到结果。业务接口 HTTP 401 时只允许重新交换业务 JWT 并重试换证一次，403/网络错误不触发此恢复；二次 401 清掉失败业务 JWT，后续调用仍可重新尝试。该恢复仅覆盖元数据/签发请求，不重放模型推理。

业务 JWT 提前刷新复用 HTTP adapter 的临时故障分类（网络、超时、429、5xx）。仅当已知原始有效期尚未结束、该 JWT 未被拒绝且登录代次未变时，所有并发调用共享旧值并退避 5 秒；不延长有效期，记录固定 `project_token_business_login_refresh_deferred` 事件。缺少有效期元数据的 5 分钟缓存上限不代表真实有效期，因此不允许临时故障降级。认证拒绝、取消、未知错误、畸形响应、退出和账号切换均不降级。

```text
CLI ZaiBusinessTokenCache（唯一 owner）
  → 提前换证 → 成功：替换业务 JWT
             → 临时故障 + 已知未过期 + 未拒绝 + 同一登录：共享原值，5 秒退避
             → 其他失败：清理原值并报错
  → clear / 登录切换：拒绝在途结果；invalidate：禁止被拒绝 JWT 降级
```

Standalone 的 PAT、Key ID 定位与 Z.AI 业务 JWT 单飞请求由 resolver/cache owner 管理，不能继承任何单个模型请求的 AbortSignal（含 execution context 内的 abortSignal）。共享 HTTP 仅保留 trace/logger 上下文，每次请求有 15 秒超时；每个调用方在 `resolve` / `resolveMaterial` 外层独立等待，取消立即终止自己的等待并移除监听器，不清除共享缓存、不影响其他等待者。已取消的调用不启动换证；所有等待者取消后，已有换证仍受超时和登录代次约束，晚到失败被消费。logout/clear 仍使在途结果失效，不重放已建立的模型流。

```text
会话 A ─ 独立等待（取消只结束 A） ─┐
                                   ├─ resolver/cache owner → 单飞换证 HTTP（15 秒超时）
会话 B ─ 独立等待 ─────────────────┘                       → 缓存结果 → B
```

普通模型 HTTP 401 允许一次 PAT 恢复：仅个人/团队套餐及闲时的 OAuth PAT 请求生效，手填 Key、Start Plan 和加速卡不参与。模型调用持有一次恢复预算，复用现有 `auth_refresh` 重试状态与物理请求循环；重新签发失败或再次 401 立即失败，不回退 Key。401 是尝试恢复的触发条件，不被当作已确认的 Token 过期原因。`VERIFY_APIKEY_EXPIRED` / `VERIFY_SIGNATURE_INVALID` 属于官方版本请求安全校验自身的错误恢复，保持原有独立处理。

```text
模型 HTTP 401（未提交输出）→ 私有请求携带原账号作用域 + 失败 PAT 的 SHA-256 指纹
→ 原鉴权 owner 核对作用域 → 仅失效指纹匹配的 PAT → 合并并发签发
→ 新 PAT 重试一次 → 成功 / 终止报错
```

所有 OAuth 模型请求返回账号作用域约束；重试换证前后均校验，切账号/项目不得串用。迟到的旧 401 不能清除已更新的 PAT；指纹不进入持久化，不传到模型上游，也不记录凭据原文。SSE 已输出文本、思考或工具调用后不重放；compact 保留原 response-body 边界。取消不触发恢复。桌面 continuous 与手机 replayable 的状态 owner、会话路由和回放规则不变，SSH 仍通过原私有 Runtime Headers 通道换证。

验收：闲时同一轮跨 TTL 后新请求使用新 PAT且票据不变；切账号/项目和换证中途变化失败；无 owner 时不能沿用过期快照；Z.ai 业务 JWT 跨 TTL 与并发刷新、单次 401 恢复、403/网络不重试、退出竞态均覆盖。已建立 SSE 不重放。

模型 PAT 恢复验收：首次 401 后实际使用新 PAT；普通请求预算为 1 时仍有一次恢复机会；二次 401 / 换证失败终止；SSE 首个错误块可恢复、文本或工具输出后不可重放；并发和迟到 401 不重复签发或清除新 PAT；取消、手工 Key、Start Plan、安全校验错误不触发 PAT 恢复；SSH 私有协议与子会话路由保留原作用域和失败指纹。

## 订阅查询与用途

企业套餐 pricing/customerInfo 保留组织项目及专用 Key 元数据预热，不 Copy Secret。
1=套餐、2=按量、3=存量映射、-1=缓存哨兵；创建类型仅允许1/2。
所有现有自动创建均为套餐，使用1。未发现按量自动创建入口，不虚构新增入口。

## 接口测试表（2026-09-23）

以下结果区分本地自动化与真实后端联调；mock 通过不等于线上兼容已验证。`…` 表示已确认的 `/api/biz/v1/organization/{org}` 管理路径前缀。

| ID  | 方法 / 路径                                                  | 复测要点                                                               | 改后鉴权                                | 实际结果                                                   |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| K01 | GET /api/biz/customer/getCustomerInfo                        | 首次定位个人/团队组织项目；有持久化 ID 时跳过                          | 登录 JWT                                | 公共/服务/CLI 单测；桌面 E2E通过                           |
| K02 | GET …/projects/{project}/api_keys                            | 仅复用专用名称的 ID；不增加 usageScene 过滤                            | 登录 JWT                                | 两 family、个人/团队、已有/缺失组合通过                    |
| K03 | POST …/projects/{project}/api_keys                           | 缺失时创建；usageScene=1；团队另传 keyType=2                           | 登录 JWT                                | 单测 + BigModel/Z.AI 桌面 E2E通过                          |
| T01 | POST …/api_keys/{apiKeyId}/access_tokens                     | 返回短期 Token；默认启用；显式关闭/异常失败                            | Bearer 登录 JWT                         | 单测 + 两 family 桌面 E2E通过                              |
| T02 | 本地 ID 记录 / Token 缓存                                    | ID 可跨重启；按账号/环境/项目隔离；Token 不落盘；404 清 ID、403 不创建 | 仅 ID 持久化                            | 重启复用/隔离/失效专项通过                                 |
| T03 | GET …/api_keys/copy/{id}                                     | 第一方 OAuth 路径不再调用                                              | 无请求                                  | 静态引用清理 + 单测/E2E Copy=0                             |
| M01 | POST <provider-base>/v1/messages                             | 每次新 attempt 通过请求期鉴权取得 Token，沿用 SSE/续轮协议             | Project Token                           | 鉴权服务/安全校验传输单测通过；真实推理未执行              |
| M02 | POST <provider-base>/chat/completions                        | 配置支持该协议时使用同一请求期 Token                                   | Project Token                           | 共用凭据入口；本轮无独立协议 E2E                           |
| S01 | GET /api/v1/agent/configs；POST /api/paas/c1f3a7e2/v2/client | Project Token 遵守官方版本的请求安全校验准入；手工 Key 保持            | Project Token 进入既有安全校验          | 2026-10-09 修正此前 Token 豁免规则，回归结果见对应主题文档 |
| U01 | GET /api/monitor/usage/quota/limit                           | 个人/团队使用 Token；团队保留 type=2 与 org/project 头                 | Project Token                           | usage/quota 服务回归通过；真实后端未执行                   |
| U02 | GET /api/monitor/usage/model-usage                           | 时间范围和团队 type=2 保持                                             | Project Token                           | 用量服务回归通过；真实后端未执行                           |
| U03 | GET /api/monitor/usage/tool-usage                            | 时间范围、团队隔离和空数据行为保持                                     | Project Token                           | 用量服务回归通过；真实后端未执行                           |
| U04 | GET /api/monitor/credit-usage/activity                       | 个人 type=1、团队 type=3 保持                                          | Project Token                           | 用量服务回归通过；真实后端未执行                           |
| U05 | GET /api/monitor/credit-usage/usage-detail                   | usageType=MODEL/MCP、时间范围、团队 type=3 保持                        | Project Token                           | 用量服务回归通过；真实后端未执行                           |
| U06 | GET /api/monitor/usage/model-performance-day                 | 性能统计及日期参数保持                                                 | Project Token                           | 用量服务回归通过；真实后端未执行                           |
| O01 | GET /api/v1/off-peak/ticket/availability                     | 闲时可用性使用当前套餐身份                                             | 既有 JWT + X-Coding-Plan-Api-Key: Token | 闲时 client/integration 回归通过                           |
| O02 | POST /api/v1/off-peak/ticket                                 | 领取票据的账号项目归属保持                                             | 既有 JWT + Project Token                | 闲时回归通过；真实后端未执行                               |
| O03 | POST /api/v1/off-peak/ticket/status                          | 状态轮询重新解析当前凭据                                               | 既有 JWT + Project Token                | 闲时回归通过；跨 TTL 真实排队未执行                        |
| O04 | POST /api/v1/off-peak/ticket/{id}/settle                     | 结算及幂等契约保持                                                     | 既有 JWT + Project Token                | 闲时回归通过；真实后端未执行                               |
| O05 | POST /api/v1/off-peak/anthropic/v1/messages                  | 沿用票据头及业务 Token                                                 | Project Token + 既有票据上下文          | 共用请求入口；真实推理未执行                               |
| A01 | 加速 / Start Plan / 官方 MCP / reset                         | 保留既有登录 JWT 通道；消费套餐凭据的部分自动改用 Token                | 按既有通道解析                          | 加速/reset/鉴权服务回归通过；端到端未执行                  |
| C01 | Standalone OAuth 登录/模型请求/退出                          | source=oauth 不读旧 Key；稳定身份；退出拒绝迟到 Token；manual 独立     | 登录 JWT → Project Token                | CLI adapters 19 + bootstrap 24 项通过                      |
| R01 | 桌面/手机/远程 workspace 请求期鉴权                          | 同一 Host owner 和原 continuous/replayable 边界                        | 私有请求鉴权通道                        | 桌面创建/换证通过；手机端到端本轮未执行                    |

最终接口测试表必须记录方法/路径、改前/改后凭据来源、测试数据、预期、实际结果、证据与未验证原因。
此前批次证据：21 个公共层/服务层文件共 304 测试通过；CLI adapters 19、bootstrap 24 共 43 测试通过；桌面 Token 创建/换证 E2E 2 项通过（首次 WebDriver 启动超时，90s 启动请求上限重跑通过）。
E2E runId：desktop-e2e-20260923035859355-p42258-c98f5ad1034a9175。
根 typecheck/lint/architecture 与 CLI typecheck 通过。CLI 全量 lint 仍有既有 max-lines 失败；auth-login.ts 基线已超 400 行，本轮亦未消除该问题。test:unit:affected 只读已提交差异，因 HEAD 未变化而跳过，不能算作本轮单测证据。接口语义和参数由 mock 回归验证；未宣称真实线上 Token 签发/模型调用/手机端到端联调通过。
必要验证按根与 CLI AGENTS.md 执行；当前仍有 CLI lint 基线问题，不自动提交失败的检查。

### 专用 Key 兼容修正复测（2026-09-23 12:34）

本轮公共/服务 8 文件 145 项、CLI auth 20 项与 bootstrap 24 项，共 189 项通过；包括新增 11 项专用 Key 边界测试与 CLI 混合项目选择回归。两 family 个人/团队的已有/创建 8 个组合新增逐阶段请求头断言。
桌面 E2E 2 项通过：desktop-e2e-20260923043115034-p70752-f786c1770da8630d。
根 typecheck、lint、architecture 与 CLI typecheck 通过。CLI 全量 lint 仍有既有 max-lines 错误。
适配器 test 脚本额外执行了全包：130 文件通过、4 文件失败，2015 项通过、51 项失败、4 项跳过，另有一处套件导入失败；不能视为全量通过。改前 HEAD 源码快照复现这些失败（模型配置、旧安全校验预期及缺失 catalog 模块），本轮没有扩大到修复这些基线问题。
证据日志：/tmp/key-contract-green.log、/tmp/key-contract-cli-auth.log、/tmp/key-contract-cli-bootstrap.log、/tmp/key-contract-e2e.log、/tmp/key-contract-cli-green.log、/tmp/key-contract-baseline-tests.log、/tmp/key-contract-baseline-wire.log。

### 旧 Key 依赖完整检查复测（2026-09-23 15:08）

覆盖桌面 OAuth 恢复、CLI snapshot/请求期鉴权、个人与团队用量、UI 判定、远程 Provisioning、旧远程附加服务组装、Token 缓存及安全校验。31 个相关文件 506 项通过；远程服务组装追加团队场景后独立复测 10 项通过（与前批有重叠，不累加）。CLI bootstrap 3 文件 27 项通过。

| 场景                                | 预期与证据                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| OAuth 有效、旧 Key 不存在或不可解密 | CLI snapshot/请求成功；桌面 Z.AI 冷启动恢复并换证，无重新登录，旧记录不改       |
| 明确手工 Key、有损坏 OAuth          | 只读手工 Key，独立鉴权                                                          |
| 远程同步、本地或远端有损坏旧 Key    | 只同步 OAuth；旧信封 Key 忽略；原旧记录不覆盖、不删除                           |
| 远程附加个人/团队用量               | 原 owner 存在则复用；无 owner 时真实换证流程；quota header 为测试 Token，Copy=0 |
| UI 可用性及 Token 失败              | 保留权益/ID/请求期凭据校验；无旧 Key 存在性门槛，无失败回退                     |

最终桌面 E2E 2 项通过：`desktop-e2e-20260923070315610-p85476-12717808333f5136`，覆盖 BigModel 无旧 Key、Z.AI 坏旧 Key 的创建/换证和 Copy=0。根 typecheck/lint/architecture、CLI typecheck、E2E typecheck 通过。CLI lint 与前述全包测试的已复现基线失败仍未解决，因此仍不 commit/push/MR。真实后端推理、手机 E2E、混版本远端没有验证。
日志：`/tmp/key-audit-broad.log`、`/tmp/key-audit-remote-final.log`、`/tmp/key-audit-cli-green.log`、`/tmp/key-audit-e2e-final.log`。

### CLI 退出复查（2026-09-23 15:23）

新增发现并修复 logout 批量解密历史 Key 的问题：只有明确 manual 才读取和条件删除私有 Key；OAuth/无来源旧 Key 不读取、不删除。两项坏密文退出回归先失败后通过。登录文件按契约与持久化拆分，主入口 352 行，公共导出不变；本次 CLI 修改文件 lint 无错误。最终 CLI 4 文件 32 项通过，根与 CLI typecheck、根 lint/架构通过。全量 CLI 未改动文件仍有历史 max-lines 失败，前述 auth-login.ts 自身超限现已解决。

### Rebase 后验证（2026-09-23）

已同步 origin/staging 至 `4f97793bc6`，恢复全部 51 个改动文件；唯一自动合并文件为 services/node.ts，上游 CUA 修正与本次 Token 组装均保留，无冲突。Rebase 后根 typecheck 和账号/远程相关 4 文件 22 项回归通过。先前批次结果与未验证项仍按上述记录区分；提交记录不表示 CLI 历史基线失败已经修复。

## agent/configs 的账号标识

GET `/api/v1/agent/configs` 不再发送 `x-api-key` 或登录/PAT Authorization。账号套餐使用同一次换证返回的真实 `apiKeyId`，通过 `x-api-key-id` 发送；不得将 PAT 改名后塞入 ID Header，也不得从 PAT/手工 Key 解析 ID。手动 Provider 不发送 Key 或 Key ID，仍可读取公共配置。

```text
本地 Host / SSH Server / 独立 CLI 的鉴权 owner
  └─ 平台换证返回 { token, apiKeyId }
       └─ 请求期 requestAuth（严格协议校验）
            ├─ token → 模型鉴权
            └─ apiKeyId → agent/configs: x-api-key-id
手工 Provider → agent/configs: 无凭据 Header
```

ID 仅随请求期鉴权材料传递，不写入模型静态配置、不添加到模型请求 Header；重试沿用当前 owner 的身份检查。路由缓存仍为进程级公共映射，成功五分钟、失败三十秒冷却；缓存命中不重新请求配置。上游已移除安全校验开关请求：手工 Provider 直接沿用默认安全校验逻辑，只有路由配置读取 agent/configs，且不发送手工 Key。桌面和 SSH 共用 Host/Server 鉴权服务；手机复用已有 host，continuous/replayable 消息语义不变。

验收：个人/团队及 BigModel/Z.AI 返回 ID 与 PAT 配对；独立 CLI OAuth 返回 ID、手工登录无 ID；协议往返保留 ID；配置请求仅含真实 ID，模型请求仍含 PAT 且没有 ID Header；手工 Provider 的路由配置请求不泄露 Key，安全校验逻辑不再请求配置开关；换证/切换账号后的新请求使用对应 ID。

本次验证：服务/Host 回归 76 项、CLI 专项 201 项、协议 ID 透传 1 项通过（共 278 项，含本地 HTTP 实际 Header 验证）。根 typecheck、lint、architecture 检查及 CLI contracts/adapters/bootstrap 独立类型检查通过。CLI 总入口缺少 turbo；三个包的完整 lint 有 50 个既有 max-lines 错误，变更文件排除该存量规则后通过。扩大执行时另有 3 个旧安全校验测试、2 个旧协议测试失败，已用 HEAD 测试/实现复现对应失败，不计入本次通过数。真实平台及 SSH 环境尚未联调；需使用包含 apiKeyId 私有协议的配套 Host/Server 与 Agent。

## Retry-After 的可重复验收

Host 的真实 HTTP 响应必须先经过 `readApiJson` 的诊断响应头白名单，再由 `createAccountProjectTokenClient` 解析为相对等待量，最后交给共享 owner。响应头大小写由 Headers 处理，不得在白名单中丢弃 `retry-after`。

MR 自动检查通过 `pnpm --filter @zcode/desktop test:project-token-retry-after-smoke` 执行该链路。修改响应头读取、Host adapter、共享 PAT owner、脚本或相关依赖/CI 配置时，`test:project-token-retry-after` 必须自动运行；正常模式必须通过，移除响应头的隔离变异必须在“60 秒不得提前重试”断言失败。仅运行解析器单测不能替代 Host 透传回归。该 job 不启动应用、不连接生产接口、不打包或部署；日志与结果按流水线 artifact 保留。

运行 `node packages/desktop/scripts/project-token-retry-after-smoke.mjs` 覆盖真实 HTTP 的 60 秒超预算（一次请求并保留 429）、1 秒、小数秒、HTTP 日期、非法及缺失响应头。变异命令加 `--omit-retry-after-header` 只改变隔离探针构建，应在超预算用例失败，证明该测试覆盖 Host 透传链路。另在隔离签名完整包验证实际 Host 的请求次数、时间间隔、日志与登录保留；使用合成凭据，不能视为生产账户验收。App 业务单测已退役，此处使用可重复运行时验收，不新增 shared/services 业务单测。

2026-11-02 新增验证：CLI 2 个文件 59 项通过，包含 9 个 Retry-After 解析边界；真实 HTTP 的 Host 透传链路 6 个场景通过，删除诊断头透传的变异探针按预期失败。签名完整包 3.17.111 的 5 个场景通过：1 秒等待、HTTP 日期、长等待不进入自动重试、有效旧 PAT 刷新失败降级、原 PAT 过期后重新签发；登录及独立凭据未改写，PAT 未持久化。长等待的单次 owner 调用在 HTTP 探针中只发 1 次；完整 App 启动有多个独立调用，本次观测共 5 次请求、0 个自动重试事件，不把它误写为全应用总共 1 次请求。本轮不引入全局限流冷却策略。使用隔离合成账号，不代表生产限流或原机网络验收。
