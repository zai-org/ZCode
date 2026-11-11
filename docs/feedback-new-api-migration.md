# 问题反馈新接口迁移 Spec

## 背景

问题反馈服务从旧的独立反馈域名接口迁移到 ZCode Server 新接口：

- 旧接口：`https://feedback.example.invalid/v1/tickets`
- 生产新接口：`https://zcode.z.ai/api/v1/feedback/*`
- 测试新接口：`https://zcode.z.ai/api/v1/feedback/*`

UI 和 RPC 服务接口暂不扩展，`IFeedbackService` 继续向 UI 暴露现有的创建、列表、详情、评论和附件上传能力。迁移只收敛在 services 层的 HTTP 协议、鉴权和字段映射。

默认 feedback API base 必须跟随统一的 ZCode endpoint resolver：

- `ZCODE_ENV=production` 或未显式设置时，默认 `https://zcode.z.ai/api/v1`。
- `ZCODE_ENV=test` 时，默认 `https://zcode.z.ai/api/v1`。
- `ZCODE_BASE_URL`、`ZCODE_TEST_BASE_URL`、`ZCODE_PRODUCTION_BASE_URL` 等统一 endpoint 覆盖继续生效。
- `ZCODE_FEEDBACK_API_BASE` 或显式传入的 `apiBaseUrl` 只作为人工覆盖，优先级高于环境默认值。

反馈 API 的 HTTP 出口必须通过 services 层统一 `ApiClient` 收口，不直接调用全局 `fetch`。统一 `ApiClient` 负责 ZCode Server endpoint 重写、`x-request-id` 以及 `buildZCodeSourceHeaders()` 中的通参注入；反馈模块只在此基础上叠加接口自身关注的 header 和请求体。这样后续新增 ZCode Server 通参时，只需要修改统一 API client/source headers，不需要逐个业务模块补字段。

## 新接口契约

所有反馈 API 响应统一为：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {}
}
```

`code !== 0` 或 HTTP 非 2xx 均视为失败，错误消息优先使用 `msg`，其次使用响应正文。业务失败保留服务端 `code`，services 层据此识别 access token 无效（`3601`）。

核心接口：

- `POST /feedback/access-token`：为未登录客户端签发匿名 access token，不要求登录。
- `POST /feedback/ticket`：创建反馈工单。
- `GET /feedback/ticket`：查询当前身份的工单列表。
- `GET /feedback/ticket/{ticket_id}`：查询工单详情。
- `POST /feedback/ticket/{ticket_id}/message`：追加消息。
- `POST /feedback/attachment/upload-credential`：获取 OSS 表单直传凭证。

除签发接口外，以上接口登录用户都走 Bearer JWT，未登录用户都走 `X-Feedback-AccessToken`。

## 鉴权与匿名身份

未登录用户的反馈身份是服务端签发的 access token。device_mid 会出现在通用请求头、日志和远控设备列表中，不能作为访问凭证。

- access token 保存在 services 统一凭据存储（`credentials.json`，加密），key 为 `zcodefeedbackaccesstoken`，与 `zcodejwttoken` 同级保护。
- 只在第一次匿名提交时申请。只看列表、详情或登录状态下都不申请。
- 一个 access token 就是一个匿名身份。本地凭据丢失后，之前的匿名反馈无法找回；登录后也看不到匿名期间的反馈。登录不删除 access token，退出登录后匿名期间的反馈重新可见。
- 升级前用 device_mid 提交的匿名反馈不再出现在新版客户端的列表中；旧的本地缓存 `tickets.json` 不再读取，也不专门清理。

请求头规则：

- 反馈请求通过统一 `ApiClient` 发送，自动携带 ZCode Server 通参，例如 `User-Agent`、`HTTP-Referer`、`X-ZCode-App-Version`、`X-Platform`、`X-Release-Channel`、`X-Client-Language`、`X-Client-Timezone`、`X-Os-Category`、`X-Os-Version`、`X-Device-Mid` 和 `x-request-id`。服务端按通参里的 `X-Device-Mid` 记录工单设备，用于设备维度统计。
- 已登录（本地凭据存在 `zcodejwttoken`）时只发送 `Authorization: Bearer <token>`。
- 未登录时只发送 `X-Feedback-AccessToken: <access token>`。
- 未登录且本地没有 access token 时：列表直接返回空，不请求服务端；详情、追加消息和上传附件直接报错。不能发送不带凭证的请求，否则服务端会按通参里的 `X-Device-Mid` 走旧版鉴权。
- 反馈模块不再单独处理 device_mid：不读取宿主 deviceMid、不自行发送 `X-Device-Mid`、创建请求体不带 `device_mid`。
- 不再发送旧接口使用的 `X-Feedback-Client-Id` 和 `X-Feedback-Account-Id`。

列表统一以服务端 `GET /feedback/ticket` 为准，登录和匿名都不维护本地票据缓存。

### 申请与并发

签发是匿名创建工单的第一段请求，属于这一次创建：

- 本地没有 access token 时，每次匿名创建各自签发，不在进程内合并成共享请求。共享请求不属于任何一次创建：签发悬挂时，取消只能中止创建本身，后续提交还会复用同一个悬挂的请求。
- 签发与创建工单使用相同的 30 秒超时，并随用户取消一起中止。签发失败、超时或被取消时，本次提交结束，不保存任何值；下次提交重新签发。
- 签发成功后立即保存。之后再取消，本次不创建工单，已保存的 access token 留给下次提交复用。

同一 Host 进程内的多次提交，以及多个窗口各自的 Host 进程，都可能同时第一次匿名提交：

```text
 提交 A                credentials.json（文件锁内）              提交 B
   │── 签发 → tA                                                 │── 签发 → tB
   │── 没有才写 tA ─────▶ 存入 tA                                 │
   │                      已有 tA，不覆盖 ◀───── 没有才写 tB ─────│
   │                      返回 tA ──────────────────────────────▶│ 丢弃 tB，改用 tA
   │── 用 tA 创建工单                                             │── 用 tA 创建工单
```

- 并发申请都在凭据文件锁内“没有才写入，已有就用已有值”，避免后写覆盖导致先写一方的工单无法访问。未被采用的 access token 只在服务端留下一条没有工单的记录。

### access token 失效

- 只有服务端返回 `3601`（access token 格式错误或未签发）时才丢弃本地 access token。网络错误、超时和其他错误码不丢弃。
- 丢弃时在凭据文件锁内比较：本地值仍等于被拒绝的值才删除，避免误删其他窗口刚写入的新值。
- 创建工单收到 `3601` 时，丢弃后重新申请一次再重试创建。服务端在鉴权阶段拒绝，工单尚未创建，重试不会重复建单。
- 列表、详情、追加消息和上传附件收到 `3601` 时只丢弃并报错，不申请新 access token：新 access token 访问不到旧工单。
- 切换测试/生产环境时，另一环境的 access token 会收到 `3601`，按上述规则丢弃并在下次匿名提交时重新申请。

## 字段映射

创建工单时，旧 UI 输入映射到新请求：

- `title` -> `title`
- `description` -> `content.description`
- `type` -> `content.function`
- `severity` -> `content.severity`
- `contact` -> `contact`
- `device` -> `environment`

`environment` 至少包含：

- `app_version`
- `platform`
- `release_channel`
- `os_category`
- `os_version`

`platform` 使用和 `GET /client/configs?platform=...` 一致的系统架构键，例如 `darwin-aarch64`、`darwin-x86_64`、`windows-x86_64`。`os_version` 使用短系统 release（`node:os.release()`），避免 macOS 的完整 Darwin kernel 字符串超过后端 `feedback_tickets.os_version` 长度限制。

设备快照中的额外字段以 snake_case 扁平写入 `environment`，不再嵌套在 `device` 字段内。UI 侧详情仍将 `environment` 映射回 `FeedbackDeviceInfo`，保持现有组件可读。

状态映射：

- `submitted` -> `已提交`
- `closed` -> `已归档`
- 未识别状态 -> `已提交`

其中 `已归档` 是服务层为兼容现有 `FeedbackTicketStatus` 保留的内部状态值；“我的反馈”列表和详情对用户展示为中文“已完成”、英文 `Completed`，不把接口兼容命名暴露给用户。

新接口没有旧的 type/module/assignee/event 语义。服务层保留 UI 类型兼容：

- 创建返回使用本次输入的 `type`、`module`、`severity`。
- 服务器列表没有类型时默认映射为 `bug`。
- 详情中的消息映射为 `comments`，并生成展示用系统事件。

## 附件上传

新接口不再支持旧的 `attachments:init`、chunk PUT、`attachments:complete` 协议。服务层统一使用 OSS 表单直传：

1. 调用 `POST /feedback/attachment/upload-credential`，传入 `ticket_id`、可选 `message_id`、`file_name` 和 `size`。
2. 用返回的 OSS `host`、`path`、policy、签名和 callback 信息构造 `multipart/form-data` 表单。
3. 文件字段放在表单最后上传，并向 UI 上报上传进度。
4. OSS 返回 2xx 后，服务层按当前文件信息构造 `FeedbackAttachment` 返回。

取消上传继续通过 `AbortController` 中断当前 OSS 请求，并抛出 `FeedbackUploadCanceledError`。

反馈表单默认上传诊断日志时仍使用完整归档流程，但归档内容只覆盖反馈定位需要的日志与轻量配置。日志附件客户端预检上限为 1GB；为避免上传高频协议流或插件缓存导致归档膨胀，full archive 会排除：

- `dev`
- `sessions`
- `session-bindings`
- `checkpoints`
- `repo-snapshots`
- `repo-wiki`

其中 `repo-snapshots` / `repo-wiki` 是已退役 Repo 快照上传与 Repo Wiki 功能的历史数据目录：升级用户数据根仍可能残留（快照加密包可达 GB 级，Wiki 正文含仓库路径与引用信息），退役功能的归档隐私边界必须继续生效。

## 网络错误与重试边界

反馈 API 通过 Node.js `fetch` / Undici 发出。网络错误必须在 services 的统一 API 网络错误分类器中归一化，反馈、模型连通性等调用方不得各自维护互相分叉的错误码列表。

只有能够确认请求尚未到达后端的建连阶段错误可以自动重试，包括：

- `UND_ERR_CONNECT_TIMEOUT`
- `UND_ERR_CONNECT_ERROR`
- `ENOTFOUND`
- 明确包含 `connection attempts timed out` 或 `connect ETIMEDOUT` 建连证据的 `ETIMEDOUT`
- `ENETUNREACH`
- `EHOSTUNREACH`
- `ECONNREFUSED`
- 明确发生在 TLS 建立前的 `ECONNRESET`

请求体发送后发生的普通 socket 断开、用户取消、业务超时和 HTTP 失败不得按建连错误自动重试。`POST /feedback/ticket` 在后端提供幂等键契约前，只允许重试上述“请求尚未到达后端”的失败，避免响应丢失时重复创建工单。

重试耗尽后，services 日志应保留脱敏后的目标 URL、错误码、尝试次数和耗时。UI 必须按工单是否已经创建分流提示与后续动作：

- 创建工单前失败时，不直接展示 `fetch failed` 等运行时原始消息，而是按当前语言提示用户检查网络、VPN 或代理后重试；提交草稿、截图和联系方式必须继续保留，用户可以在原表单重新提交。
- 工单已经创建、日志等后续材料上传失败并进入错误状态时，不得提示用户重新提交整个表单。后台状态必须明确提示“工单已创建，但后续材料上传失败”，点击后直接打开已有工单，避免重复创建工单。截图仍保持现有的逐附件降级语义：失败后写入系统评论并继续提交，不因本次错误路由修复改成整体失败。

## 多端影响

本次迁移只修改 `packages/services` 的反馈 HTTP 协议和凭据，不改变：

- app 与 agent 的 stdio 协议。
- task stream、snapshot、queue、owner command。
- 桌面端 `desktop-continuous` 与手机远控 `web-remote-replayable` 边界。
- main process、relay 或 remote host attachment 逻辑。

桌面本地与远程窗口都通过 host process 中的同一反馈服务访问新接口；Web/mobile 远控链路不新增独立 Agent runtime 或业务状态。

Web/mobile 切到远端 workspace 后，attachment 必须显式发布控制端 Window Host 的反馈服务，
因为 Source 工作区集合不拥有反馈账号、设备身份和本机诊断包。不能用延长 channel 超时修复
漏注册，也不能将反馈路由到 Source 凭据。回归见远控架构的 MRS01。

## 验证

必须覆盖：

- 创建工单走 `/feedback/ticket`，请求体包含 `content`、`environment`，不包含 `device_mid`；已登录只发送 Bearer JWT，未登录只发送 `X-Feedback-AccessToken`。
- 反馈 API 请求必须通过注入的统一 `ApiClient` 发出，不能绕过通参收口直接调用全局 `fetch`；服务端按通参 `X-Device-Mid` 记录工单设备。
- 未登录第一次创建时签发 access token 并加密写入凭据存储；之后复用，不重复签发。
- 未登录且没有 access token 时，列表返回空且不请求服务端；详情、追加消息、上传附件直接报错，不发送不带凭证的请求。
- 未登录列表、详情、追加消息和上传附件都带 access token 请求服务端，列表展示服务端结果。
- 同一进程内或多个反馈服务实例同时第一次匿名提交时，各自签发，最终使用同一个 access token。
- 签发悬挂时取消创建，本次提交立即结束，下一次提交重新签发；签发 30 秒未返回时，本次提交以超时失败，下一次提交重新签发。
- 签发成功后取消创建，不创建工单，access token 保留并在下次提交复用。
- 创建收到 `3601` 时丢弃本地 access token、重新签发并重试一次，重新签发同样随本次创建超时和取消；其他接口收到 `3601` 只丢弃；网络错误不丢弃。
- 有 JWT 列表调用服务器接口并映射状态。
- 附件通过 upload credential + OSS 表单直传完成，并支持进度与取消。
- 网络握手阶段的可重试失败仍会重试。
- Undici `UND_ERR_CONNECT_TIMEOUT` 首次失败、后续恢复时能够自动重试成功。
- Undici 建连错误连续三次失败后停止重试，并记录尝试次数和错误码。
- 建连错误耗尽后，反馈表单展示本地化网络提示，不展示原始 `fetch failed`，并保留当前描述、截图和联系方式供用户重试。
- 工单创建后日志等后续材料上传发生网络错误并进入错误状态时，展示本地化的“工单已创建”提示，后台入口打开已有工单而不是重新打开提交表单。
- 全量执行 `pnpm typecheck` 和 `pnpm lint`。
