# Z.AI / BigModel Start Plan Provider

## 当前 Provider 架构（Todo154：Start 独立）

账号选择继续保存 `providerFamilyDomain` 与 `providerFamilyConnectionSelections`；不增加迁移。
Account Source 每轮同时发布账号状态（availability/current/effectiveAt）及 Config Overlay
（entitled/动态模型成员），Settings 和 Registry 消费同一 revision。Off-Peak 沿用静态 hidden，
不设置 current；普通 Personal/Template Provider 也不受 current 限制。

```text
账号查询 + Family 选择
  -> Account 状态 + Overlay（同轮）
     -> Settings：可查看 available/pending
     -> Registry：匹配当前账号访问上下文 + entitled + 完整且启用的模型
```

Start 余额查询与个人 Coding Plan 查询独立；Team 需要具体组织/项目身份，不能猜某个团队。
待生效为 pending/entitled=false，保留 Unix 秒 effectiveAt；已生效但无模型仍 entitled=true，
模型成员为空，不沿用旧白名单。查询未知只保留同一账号/Team 的最近成功结果。
非法连接只提示并回到可操作的设置入口，不改写保存的 Family 选择，也不替换会话模型。
领取结果默认只打开模型设置，不切换 Start；此前的自动“立即体验”不属于固定 staging 默认行为。

Start 跟随当前 App 登录，无需单独连接。`current` 表示匹配账号访问上下文：同一品牌的 Start 与当前个人／团队可以同时为 true；Start 的 connectionKey 不包含付费套餐选择。到期、未知、模型禁用等仍按原权益及 Registry 校验，登录不代表自动领取。

国内入口（`zai_cn`）不是套餐家族，它的 Start 固定属于 BigModel（共享映射 `resolveStartPlanFamilyFromOAuthProvider`，Host 与设置页共用）。未关联 BigModel 的国内账号同样以 ZCode 主体与共享 JWT 查询、领取和使用 BigModel Start；Z.ai Start 对它不可用。身份解析规则见[登录方案 5.5](zcode-login-rework.md#55-套餐凭据解析核心链路已实现)。

设置页在“智谱”分组并列显示独立 `Start Plan`，两家共用用户提供的 Z 字图标（`model-provider-start-plan.png`，深浅主题使用同一原图），保留原 `account:*` ID；个人／团队套餐继续使用各自品牌图标。Start 详情保留权益、额度、领取和模型管理，移除连接／断开以及付费连接下拉；浏览和领取不改变付费连接。

模型选择菜单中，两家体验套餐分组标题统一为 `Start Plan`，胶囊标签中文显示“免费”、英文显示“Free”；聊天、定时任务、子智能体和 Wiki 使用同一展示规则。分组内保留实际模型列表和原有能力标签，不改变 Provider／模型选择值。

保存的 Start 选择按原 Provider ID、模型和选项精确解析，不跨品牌映射，不回退到付费额度。个人／团队继续按当前唯一付费连接映射。历史会话、任务、Automation、Subagent、Bot 和 Wiki 不批量改写，Session 沿用成功执行后的原有写回；旧 `kind: start-plan` 保留读取，启动不再通过写入它激活 Start。

会话内的模型切换分隔提示、首次使用提示及对应切换 toast，对 BigModel／Z.ai 的账号套餐模型使用 `模型名(套餐类型)`：个人套餐、体验套餐、团队套餐。例如 `GLM-5.3(团队套餐) → GLM-5.3(体验套餐)`，即使模型同名也能区分额度来源。类型分别取提示记录的前后 Provider ID，不读取当前全局连接或输入框草稿；Provider 已不在当前目录时仍可识别内置套餐。套餐名称随界面语言翻译，普通自定义供应商继续使用原名称规则；桌面和手机使用相同展示逻辑，历史数据无需迁移。

用户提交新消息、创建／修改模型后保存定时任务、手动生成 Wiki，以及保存显式 Subagent 模型时，若当前有效选择为付费模型、Start 有相同且思考选项兼容的可执行模型及明确正额度，可推荐使用体验套餐。额度未知或查询失败跳过，不为提交等待一次强制额度刷新。用户点“切换套餐”后按原提交／保存边界记住本入口的 Start 选择；点“不了”继续原选择；关闭则保留草稿、不执行本次操作。

推荐弹窗底部将“不再提示”放在左侧，“不了／切换套餐”按钮组放在右侧，同排垂直居中；窄屏或较长翻译导致空间不足时，按钮组整体换行并保持右对齐。

`startPlanRecommendationDismissed` 是当前 App／Host 的统一持久化偏好。勾选“不再提示”并确认任一按钮只关闭推荐，各入口下次仍使用自己保存的模型；关闭弹窗不保存勾选。另一入口或连接同 Host 的手机在下次提交时重新读取该偏好。实际额度／鉴权错误照常提示，不增加跨 Host 的账号云同步。

Bot、后台执行、任务列表“立即运行”、已有队列出队、重试、Wiki 失败页补齐、Subagent 继承／仅思考或文本修改不提示。全局账号连接失效提示只观察付费连接，Start 保留自身额度和不可用反馈。完整边界与 SIP-01～21 验收见 [Todo154](working-memory/provider-refactor/steps/todo-154-start-plan-independent-provider.md)。

以下旧接口说明中的 `builtin:*` 是迁移前身份；当前对应 `account:*`，不得恢复旧 Provider Store。

Start Plan is represented by dedicated built-in model provider ids:

```txt
builtin:zai-start-plan
builtin:bigmodel-start-plan
```

Both providers intentionally reuse the same `zcode-plan` runtime endpoint and
free model set. OAuth preset sync derives each Start Plan provider from its own
brand login domain, so runtime model calls can continue to use the same
`zcode-plan` endpoint while keeping credentials isolated by provider id.

Status checks are separate from paid Coding Plan checks. `builtin:zai-start-plan`
reads the active free plan identity and the daily quota bucket renewal time from
one balance request:

```http
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>
Authorization: Bearer <zcodejwttoken>          # Z.AI
Authorization: Bearer <zcodejwttoken>          # BigModel
X-Device-Mid: <telemetry-state.json deviceMid>  # required; missing -> 400 {"code":3001,"msg":"parameter error"}
```

`X-Device-Mid` is required by the backend for this endpoint even though it is an
optional field in the generic source-header rules. Every runtime that issues
this request (Desktop host, remote `zcode-server`, CLI) must therefore ensure
its own `deviceMid` exists before the first balance query; see
`docs/zcode-endpoint-device-mid-header.md`. A `400 parameter error` here is
classified as `unknown` availability and disables executable Start models, so a
missing header must never be treated as a backend outage.

`billing/current` is deprecated for Start Plan. The `balance` response must
include `data.plans` for active-plan detection and subscription metadata, plus
`data.balances` for quota/remaining display. Clients must not call `current`
before `balance` or issue a second `balance` request for the same snapshot.

`app_version` always uses the current app `ZCODE_VERSION`, including development
builds, so backend gating observes the same version identity as the running app.

`zcodejwttoken` is the OAuth backend JWT saved during Z.AI or BigModel login.
BigModel passes the one-time callback `code` directly to
`https://zcode.z.ai/api/v1/oauth/token` with `state`, `redirect_uri`, and
`provider: "bigmodel"` to save the same JWT shape used by Z.AI Start Plan.
Paid Coding Plan providers continue to use `/api/biz/subscription/list`;
monitor quota APIs remain reserved for Coding Plan usage/limit views.

## Independent Selection And Availability

Start is a permanent Provider entry for the current login brand, independent of the paid connection selection. No active entitlement, a failed query or pending activation changes the status panel, not the existence of this entry. The executable model menu remains controlled by Account Source and Registry; an unavailable Start never falls back to paid quota.

- Composer quota follows the effective Provider/model in that composer. Start does not require a saved `kind: start-plan`; paid quota still uses the exact personal/team scope.
- Unresolved legacy team identity blocks that paid access only; it does not stop Start entitlement discovery.
- Paid connection selection uses the saved/pending family selection and exact org/project/product identity, not a copied navigation item's `provider.current`. No matching choice displays the normal placeholder; a sole unselected option remains actionable.
- Start details reuse the existing loading text/spinner, active/pending subscription cards, quota buckets, zero-balance presentation, reset time and model management. There is no new skeleton, exhausted warning, persistent refresh-failure overlay or status-dot color system.
- Signed-out Start offers login; conclusive no-plan shows no available trial plan and the existing introduction/eligible campaign. A first query failure offers retry, explicit auth expiry offers login, and configuration-unavailable is reserved for actual missing configuration. Silent refresh retains existing data only under the existing cache/error rules.
- Claim success remains success if subsequent refresh fails. The settings action is “查看套餐 / View plan”; no automatic model guide or implicit model/paid-connection mutation remains.

### Recommendation freshness and account changes

Recommendation, settings and composer balance use the same Start request/cache identity for the same Host/account/Provider. Reuse the existing Provider entitlement fingerprint, refresh events and UsageEntitlement cache; do not introduce another balance owner. Settings refresh publishes new quota to the recommendation consumer.

Page entry and interactive submission perform an access refresh check with the existing 60-second throttle, in-flight merging and error backoff. Account/claim changes use the existing auth/purchase refresh path. No idle polling is introduced.

Only a successful snapshot sampled at most 60 seconds ago can support a recommendation. Reading or remounting does not renew its age. At submission time, add elapsed local time since sampling to the server reference time before checking bucket expiration. An expired bucket never supports a recommendation, even in a fresh snapshot. Missing/stale quota triggers background refresh and this submission proceeds with its original selection, without waiting or later resending. Query failures skip recommendations; they do not extend old positive quota validity. This limit applies to recommendation decisions, not automatic clearing of visible plan cards.

```text
account/claim change → existing entitlement refresh → shared quota snapshot
page entry/submit  → access freshness check ────────↗
submission → fresh snapshot + valid bucket + compatible same-model quota?
  yes → existing recommendation/choice → original owner commit
  no  → original selection commits; quota refresh stays in background
```

### Side conversation first input

`/side <text>` is also an interactive first submission. Resolve the child-inherited effective model before recommendation; never substitute an unsubmitted parent composer draft. `createSelectionSideSession.firstInput` accepts optional complete `modelSelection`, used for the child creation and first input, preserving reasoning options. Old text-only payloads keep their existing inheritance. Cancel keeps the inherited selection; closing the recommendation leaves the draft and sends no create command. Empty `/side` only opens a child and does not recommend.

The existing atomic creation/first-input command, command id, admission and ACK own execution and deduplication. Parent model/queue and global paid connection remain unchanged. Desktop continuous and mobile replayable still use the same owner and original recovery paths. Accepted regressions are SF-01 through SF-19 in [Todo156](working-memory/provider-refactor/steps/todo-156-start-plan-followup-final-decisions.md).

The settings status panel uses the Start Plan provider identity to present a
free-plan state with a paid Coding Plan upgrade entry. The panel projection is
multi-plan aware:

```text
billing/balance (server priority order)
  plans[] -------------------------------> one card per active plan
     | plan_id                                  | title / plan expiry
     |                                          v
     +---- balances[].plan_id ------------> only this plan's quota buckets
                                                | bucket expires_at
                                                v
                                           bucket-local reset time

  balances[].capabilities ----------------> model id union
                                                |
                                                v
                                      read-only Models section at the bottom
```

Field contract (server guaranteed, no legacy fallbacks on the client):

- every `plans[]` entry carries `plan_id`, `status`, and `ends_at`
- every `balances[]` entry carries `plan_id` and `expires_at`
- every `balances[]` bucket belongs to an active `plans[]` entry: the server
  must not return buckets whose `plan_id` is missing or maps to a non-active
  plan. The provider logs a tripwire warn
  (`warnOnUnattributedStartPlanBuckets`) when this contract is violated,
  because the settings multi-card path silently drops such buckets while the
  chat input bubble still shows them.
- Plan card grouping still uses `plan_id`; reset labels use `expires_at`,
  without falling back to `period_end`. Bucket reminders additionally preserve
  `bucket_id`, `user_plan_id`, `period_start`, and `period_end`: the bucket and
  period identify a single reminder, while `user_plan_id` joins the entitlement
  period label for the exact user-plan instance. See `start-plan-daily-quota-banner.md`.

- Active plans are rendered in the exact order returned by `data.plans`; the
  client must not sort them again because the server has already applied
  product priority.
- Every plan reuses the existing Plan Card surface and shows its own remote
  name, `ends_at`, and quota buckets.
- A bucket belongs to a card only when its `plan_id` matches that plan. A bucket
  without a matching `plan_id` is not attached to any card; the client must not
  fall back to plan-less buckets, otherwise the same bucket would be copied
  into every card.
- Each quota bucket formats its own `expires_at` as its reset time; a
  plan-level or earliest reset time must never be copied to sibling buckets.
  Start Plan cards do not render a plan-level renew time at all. The chat
  input toolbar context balance bubble follows the same rule: every meter reads
  only its own bucket's `expires_at` (`limit.nextResetTime`), never the
  aggregated `remaining.nextResetTime` or the plan-level renew time. Bucket
  reset time formatting is aligned with Coding Plan through the shared
  `formatQuotaResetTime({ format: "adaptive" })`: same-day resets render
  `HH:mm` only, other-day resets render the date only.
- The read-only Models section remains outside all plan cards at the bottom of
  the provider detail. Its content is the case-insensitive union of model
  capabilities from all returned buckets, preserving first occurrence order.
- This presentation does not change balance fetching, provider selection,
  runtime routing, or model synchronization. The entitlement snapshot only
  preserves the plan/bucket identity already present in the same balance
  response so the settings UI can render the correct grouping.

Telemetry identity impact: `subscription.details` now carries all active plans
in server priority order, so the `plan_product_id` reported by `send_btn`
telemetry reads `details[0]` — the highest-priority active plan. Server-side
reordering intentionally flips this id. See
`docs/monitoring/business-monitoring.md` for the reporting contract.

The shared Plan Card behavior remains:

- title: `{provider} - Start Plan`
- purchased metadata: `Start Free` badge and the plan expire time from
  `balance.data.plans[].ends_at`, rendered as a date only (year omitted for the
  current year). Bucket reset times come only from each bucket's `expires_at`.
- upgrade button is shown; pricing cards remain hidden until the user clicks
  upgrade
- manage and unlink actions are both hidden for Start Plan plan cards: the
  free tier has no management page and the login state is managed at the
  family connection level; the card keeps only the expiry date and the
  upgrade-to-Coding-Plan action (with its billing-discount badge)

The settings detail form does not expose manual connection fields for Start
Plan. `Base URL`, `API Format`, and `API Key` are replaced by a Start Plan card,
because those values are maintained by OAuth/preset sync and should not look
user-editable.

设置页只在 Start 权益实际可用（Account 快照 `availability=available`）时渲染模型列表。
待生效 `pending` 只代表套餐已领取、权益尚未到生效时间：此时余额快照同样带套餐详情
（status 投影为 purchased），但账号权益不可执行，详情页只展示套餐卡与生效排期，
不得渲染模型列表或“没有配置模型，可手动添加”的空态。未登录、未开通、查询中/查询失败、
未知同样不渲染模型区；状态卡保留对应登录、重试和购买入口。

Start Plan 的模型目录仍由 `billing/balance` 与 `client/configs.builtinModels`
共同管理，用户不能新增、删除或改名模型，也不能修改最大输出 Token、输入/输出模态等
服务端模型事实。模型行只开放两项本地操作：

- 修改上下文窗口；保存后的用户值必须在 provider 刷新时保留，并传入 runtime registry。
- 测试当前模型连通性；测试继续使用 Start Plan 当前凭据和固定 endpoint。

因此设置页必须保持模型 ID 只读、隐藏新增/删除入口，并在受限编辑弹窗中只渲染上下文
窗口字段。远端刷新仍可更新模型清单及上下文之外的 metadata；若模型已不在 entitlement
权威清单中，应照常移除，不得因为本地修改过上下文而继续保留。

## Signed-out Preview

When a user opens either Start Plan entry before logging in, the settings panel
shows the free Start Plan preview followed by the paid Coding Plan pricing
cards:

```tsx
<StartPlanCard />
<CodingPlanPricingCards />
```

Both sections read from the same unauthenticated client config endpoint, and the
service layer must share one `client/configs` payload between the preview card,
pricing cards, and any other client-config consumers in the same provider
instance:

```http
GET https://zcode.z.ai/api/v1/client/configs?app_version=<ZCODE_VERSION>&platform=<platform>-<arch>
```

`StartPlanCard` uses `configs.startPlanPreview`:

```ts
interface StartPlanPreviewConfig {
  planId: string;
  name: string;
  entitlements: {
    grantUnits: number;
    meter: string;
    period: string;
    showName: string;
    unitType: string;
  }[];
}
```

The current payload is provider-neutral, so Z.AI Start Plan and BigModel Start
Plan both show the same Start Plan preview. The provider-specific difference is
the paid pricing list underneath:

- `builtin:zai-start-plan` preview card: `configs.startPlanPreview`
- `builtin:zai-start-plan` pricing cards:
  `configs.codingPlanStaticProducts["builtin:zai-coding-plan"]`
- `builtin:bigmodel-start-plan` preview card: `configs.startPlanPreview`
- `builtin:bigmodel-start-plan` pricing cards:
  `configs.codingPlanStaticProducts["builtin:bigmodel-coding-plan"]`

If `configs.startPlanPreview` is missing, the signed-out Start Plan surface must
not render the Start free preview or the free Start SKU / 体验套餐 content. Paid
Coding Plan pricing cards may still render from `codingPlanStaticProducts`; the
free Start content is controlled only by `startPlanPreview`, not by a local
hard-coded fallback.

The BigModel signed-out purchase choice banner follows the same rule. The Start
Plan entry is rendered only when `configs.startPlanPreview` exists and has
displayable `model_usage` entitlements. Its title uses `startPlanPreview.name`,
its large quota metric is calculated from the entitlement `grantUnits`, and its
description lists the remote entitlement model names and quota groups. When the
preview is missing, the personal/team purchase entries may remain visible, but
the Start Plan entry and all Start-specific copy must be absent.

When the user unlinks the active Z.ai / BigModel OAuth session while the same
family still has an API key, the family domain remains selected, but the current
Start/Coding detail must return to the signed-out Start view. This preserves the
family settings context and re-shows the Start preview plus pricing cards when
`startPlanPreview` is present, instead of leaving the user on a disconnected
Coding Plan card with no next action.

## Manual claim banner

The workspace sidebar queries `GET /api/v1/zcode-plan/billing/preview` with the
current client version/platform. A ZCode JWT is attached when available, while
signed-out preview is sent without Authorization. It renders one banner
directly above the profile footer only when `data.plans` contains a claimable
plan. Multiple plans are resolved by descending `priority`, then ascending
`plan_id` for deterministic display. An empty response or a request failure
renders no banner on the first read. A transient refresh failure preserves the last
successful preview; an authoritative empty response removes it. Reading preview never claims or activates a plan.

`preview`、`claim` 与 `balance` 的 `data.server_time` 是各自响应内时间字段的业务权威，
接口单位统一为 Unix 秒；Service 暴露给 Renderer 时统一转换为毫秒。客户端不得用
`generatedAt` 替代 `server_time`：前者仍表示本地快照生成时间，后者用于比较同一响应内的
`starts_at`、`ends_at`、`effective_at` 与 `expires_at`。兼容旧服务端时允许字段缺失并回退
`Date.now()`，非法值按缺失处理；不得跨接口复用一次旧 `server_time`。`server_time` 不是活动
批次 ID，也不改变 10 分钟/30 秒轮询周期；下一轮活动仍以新 preview 的可领取结果为准。

### Manual claim interaction

`preview` 是公开曝光接口：未登录请求不带 Authorization，登录后可附带 ZCode
JWT。`claim` 必须登录；官方版本在 claim 前还会执行安全校验（下图 `verifying`）。Banner 点击后的状态机如下：

```text
idle -> checking-auth -> verifying -> claiming -> success-dialog -> refreshing -> hidden/idle
                                \-> failure-dialog ---------------------------> idle
```

- 未登录点击时只发起登录，不调用安全校验或 claim；登录完成后由用户再次确认领取。
- 点击 Banner 右上角关闭按钮时不得立即隐藏 Banner，应先显示标准确认弹窗，标题提示用户将错过一次领取机会，
  说明本次活动领取机会有限且关闭后可能错过本次机会；确认文案不得把 Start Plan 描述为活动，也不得断言无法再次领取。
  “确认领取”关闭确认弹窗并复用同一领取状态机；“关闭”才隐藏当前渲染周期内的 Banner。
  按 Escape、点击遮罩或其他取消方式只关闭确认弹窗，不隐藏 Banner，也不发起 claim。
- 同一时刻最多存在一次领取请求，pending 期间 Banner 禁止重复点击。
- 官方版本的领取前安全校验成功后才调用 claim；失败、取消或交互总超时则结束 pending 并显示
  领取失败结果，禁止让 Banner 无限旋转。
- `POST /api/v1/zcode-plan/billing/claim` 使用当前 ZCode JWT，body 为
  `{ "plan_id": plan.planId }`；官方版本的安全校验结果通过请求头传递。
- 请求成功时显示 Start Plan 专属结果弹窗；请求失败时复用标准 `AlertDialog` 模板。成功弹窗
  上部是随弹窗宽度响应式缩放的 `4:3` 主题 Hero 权益展示区（480px 宽时为 480 × 360px），
  并放置 ticket 样式的套餐卡，下部
  说明与操作区按内容、间距和内边距自然撑高；完整桌面弹窗宽度为 `480px`，总高度不再
  固定，窄屏时收缩到视口安全区。
  Hero 的内容描述由 `createWeekendPlanResultDialogMock()` 按未来云端协议生成；当前星空、票券、
  入场、空闲压感、指针倾斜、动态光照、点击翻转和 Replay 已迁移到独立
  `weekend-plan-hero.html` 资源，并通过 `CloudDialogHero` 在仅启用 `allow-scripts` 的 sandbox
  iframe 中加载。资源只通过带实例 ID 的 `postMessage` 接收主题、语言、减少动态效果和本次权益
  数据，不得访问 Renderer DOM、Node、preload 或业务 Service。当前阶段不请求真实云端内容；
  mock 资源 URL 由 Vite 打包生成。真实云端接入、资源签名和缓存契约见
  `docs/cloud-content-dialog.md`。
  失败弹窗使用标准 `AlertDialogContent`、Header、Title、Description、Footer 与 Action，
  只显示失败标题、按业务码本地化的失败说明和确认按钮；不得渲染状态图标、关闭按钮、Hero、
  Ticket、星空、Replay、分享文本或图片操作，也不得增加专属尺寸、居中布局或自定义按钮外形。
  Banner 是营销视觉特例；除 Banner 外，领取弹窗必须遵循根目录 `DESIGN.md`：应用界面
  字体只使用 `text-ui-*`，弹窗、底部状态区、输入框、按钮和菜单使用语义颜色与现有 UI
  组件，并兼容 Zai Light / Zai Dark。Ticket 背板必须与正面共用 `bg-primary`，在 Zai Light
  下均为黑色、Zai Dark 下均为白色；该营销视觉规则不得扩散到普通控件和正文。
  底部结果标题使用 `text-ui-xl`，描述使用 `text-ui-base/relaxed`。
  成功描述按当前语言渲染“**{showName}** is ready to use.”语义，`showName` 读取本次领取的
  entitlement `show_name`，使用真实 `<b>` 与 `font-semibold text-foreground`，不得通过解析翻译
  HTML 实现，也不得回退为固定 `Start Plan` 文案。
  Claim 成功弹窗只读取本次 Claim 响应 `plan.entitlements[].effective_at`；若 Ticket 展示的任一
  entitlement 尚未生效，使用其中最晚的 `effective_at` 作为完整权益开始时间。该时间晚于同次
  Claim 响应的 `data.server_time` 时，表示权益
  已领取但尚未开始：成功描述改为“{showName} will be available on {time}.”语义，时间按当前语言和
  本地时区格式化。无论权益立即生效还是待生效，默认主按钮都显示“模型设置 / Model settings”，
  点击后关闭弹窗并定位模型设置的供应商分区，不写入 Start Plan 连接设置，也不触发模型入口引导。
  次要按钮显示“复制分享 / Copy & share”，点击后直接复制分享文案，不打开二级分享面板。
  弹窗不得读取领取后的 balance，也不得回退 Claim 响应的 `plan.starts_at` 推测 entitlement
  生效状态。Claim 缺少有效 `effective_at` 时按立即可用反馈；领取后的 balance 刷新只负责更新
  Model Settings 的套餐、额度和 Provider 状态，不得反向覆盖已经展示的领取结果。
  待生效说明使用 `text-foreground-subtle`；其中套餐名与格式化时间使用
  `font-semibold text-foreground` 独立强调；时间额外使用虚线下划线，但保持默认鼠标指针，
  不表达可点击语义，也不使用未定义的颜色 token。

  领取成功说明（包括立即可用和待生效）不得使用固定 `Start Plan`：应读取本次领取的
  entitlement `show_name`。立即可用时中文显示“`{showName}` 已可使用”，英文显示
  “`{showName}` is ready to use”。待生效时读取决定该等待时间的 entitlement `show_name`，
  中文显示“`{showName}` 将于 `{time}` 生效”，英文显示“`{showName}` will be available on
  `{time}`”。完整时间作为不可拆分的行内整体，避免日期与时间分别换行。同一生效时间存在多个
  entitlement 时，名称去重后按语言连接。
  `effective_at = 0` 继续按立即生效处理，不展示待生效说明。
  分享面板复制文案成功后，复制按钮应原位短暂切换为“✓ 已复制”，避免用户视线离开当前操作；
  复制图片成功使用全局 Toast。剪贴板或图片生成失败时显示失败 Toast，不能只写日志后静默结束。
  分享文案必须包含 `https://zcode.z.ai` 入口，并邀请接收者下载安装 ZCode 后领取。中文链接独占最后一行；
  英文链接直接跟在完整句子后。两种语言都不使用冒号引出链接，且链接必须位于文案末尾，避免社交平台把后续文字错误识别为 URL 的一部分。

  设置页 Start Plan 套餐卡中，若套餐 entitlement 的 `effective_at` 晚于当前时间，状态行显示
  “待生效 `{date} HH:mm` · 过期时间 `{date} HH:mm` / Pending `{date} HH:mm` · Expires `{date} HH:mm`”；生效时间为
  客户端本地日期的当天或次日时，日期分别简化为“今天 / Today”和“明天 / Tomorrow”，例如
  “待生效 明天 22:00 / Pending Tomorrow 22:00”；更远日期继续展示月日。两项使用普通
  元信息样式，不把生效时间渲染为徽标；生效时间文字使用语义化成功色，分隔点与过期时间
  保持次要文字色。排期时间到达但 balance 尚未返回匹配 `plan_id` 的额度桶时，状态行切换为
  紧凑的“刷新权益 / Refresh access”outline pill 按钮与过期时间；按钮使用成功色描边、成功色
  半透明背景和成功色文字，
  文字前使用 outline 风格的刷新图标，刷新期间原位切换为旋转 loading 图标并禁用按钮。按钮复用
  Model Settings 已有的 provider、entitlement 和额度刷新链路。成功拿到该套餐额度桶后按钮消失，
  只保留过期时间。
  `effective_at = 0` 或没有排期时间的立即生效权益不得显示该按钮。余额区域仍只在 balance 返回
  匹配 `plan_id` 的额度桶后展示。

  `effective_at = 0` 是服务端“立即生效”的哨兵值，不得解释为 Unix Epoch，也不得按字段缺失
  处理。按钮直接进入可用状态，界面不展示 1970 年时间。
  底部结果区域使用 `bg-popover` 与统一 `p-6` 内边距；第二排的只读输入框和“获取图片”
  outline 按钮单独使用 `bg-background`，输入框聚焦时仍保持该背景。
  Ticket 视觉区只展示 `plan.ends_at`，按当前语言与本地时区居中单行显示“有效期至 / Valid until + 时间”，
  使用单行布局并通过更高字重、字号强调截止时间；字段缺失时显示占位符，不使用 preview
  时间推断实际权益期限。待生效描述只使用同次 Claim 返回的 entitlement `effective_at`，
  不使用 balance 或 `plan.starts_at`，Ticket 时间区不重复展示开始时间。
  桌面端指针在 ticket 内移动时，卡片按指针相对中心的位置产生轻量三维下压、动态高光
  与轮廓阴影；按下时进一步下沉，点击后沿 Y 轴完成一次 360° 横向翻转，经过背面时
  显示无镜像文字、与正面同色的主题背板，结束后回到正面。该反馈不改变领取行为，并在
  `prefers-reduced-motion` 下停用空间变换。指针未悬停时，ticket 模拟一个不可见指针按
  左上、右上、右下、左下四角循环，角点之间平滑移动，压力点、高光、倾角与阴影同步；
  真实指针进入时立即停止自动运动并切换为跟随，离开后恢复四角环绕。
  点击翻转方向须跟随按压位置：点击 ticket 左半边沿 Y 轴向左旋转 `-360°`，点击右半边
  向右旋转 `+360°`，以卡片几何中心为分界。
  Ticket 使用 `cursor-default`；压力和翻转反馈不使用链接手型指针。
  弹窗首次出现时，ticket 从远处的小尺寸主题背面向前靠近，同时沿 Y 轴翻转 180° 并
  停在近处正面；入场动画只执行一次，不替代后续点击 360° 翻转。Hero 左上角提供圆形
  Replay 图标按钮，用于初始化重播整套 Hero：银河和星轨重新开始、ticket 从远处主题色
  背面重新入场、四角压感计时归零；Replay 控件不进入导出的分享图片。
  Replay 按钮复用 Dialog 关闭按钮的 `Button` 规格：`ghost + icon-sm`、`top-4`、圆形与
  no-drag 行为一致，仅将位置从右上改为左上。两者悬浮在固定深色 Galaxy Hero 上，是主题
  语义色的局部例外：无论系统亮暗主题都固定使用半透明白色图标、白色弱 hover 背景和白色
  focus ring，不能随 `foreground` 切换而失去对比度。
  入场时 ticket 从深景深中的小尺寸正面开始，向前靠近并绕 X 轴上下连续翻转
  `2` 圈，在约 `0.9s` 内以正面落位；旋转使用起步与落位较慢、中段加速的 `ease-in-out`
  曲线。所有背面阶段只显示独立、不透明且与正面 `bg-primary` 一致的主题背景；
  点击后的手动翻转仍沿 Y 轴横向旋转。
  Ticket 中部虚线分隔线使用 `h-px`（1px），保留长线段样式。
  主题背板在远景阶段也必须保持不透明，距离感仅由景深、缩放和旋转表达，不能通过降低
  ticket 整体透明度而透出 Hero 背景。
  正反面须使用独立合成层并沿 Z 轴错开极小距离，避免共面图层在旋转途中发生穿透或
  z-fighting，导致主题背板混入正面或 Hero 颜色。背板预旋转轴必须与入场动画一致使用
  X 轴，并显式设置不透明的 `--color-primary` 与 `backface-visibility`，不得在上下翻转时沿用 Y 轴背板。
  为规避 Chromium 在 mask 与嵌套 3D 合成下偶发忽略背面隐藏，入场的正反面还须按旋转
  区间显式门控可见性：`180°` 与 `540°` 区间只允许主题背板可见，`360°` 与 `720°`
  区间只允许正面可见；切换发生在卡片侧对镜头时。入场完成后结束门控，恢复普通双面 3D。
  入场门控期间主题背板须临时允许双面绘制，避免 Chromium 再次用背面裁剪把已选中的主题
  背板隐藏；该覆盖只存在于入场 animation 内，结束后仍恢复 `backface-visibility: hidden`。
  实现上使用仅服务于入场的双面主题色遮罩，背面区间显示、正面区间隐藏；普通 3D 背板在
  入场期间完全隐藏，动画结束后再恢复给点击翻转使用，避免两种职责互相影响。
  翻转必须使用连续的单段速度曲线，避免在中间关键帧停顿。自动四角压感须等入场完成后
  再启动，避免两套三维变换与阴影计算在首屏同时运行造成卡顿。
  Hero 背景使用带明亮核心、椭圆星云盘和旋臂的深空银河，并叠加低密度中心放射星点与
  短光轨循环；动画层不可接收指针事件、不可遮挡 ticket 内容，并在减少动态效果时隐藏。
  底部结果区沿用原有主题语义颜色，只调整内容布局：标题与说明居中排版，不显示额外成功图标。成功标题
  使用“You now have access to {plan}”句式，中文使用更简洁的“{plan} 领取成功”，其中 `{plan}`
  来自本次领取结果展示的真实套餐名，不额外添加书名号。成功说明只保留模型和状态：立即生效时为“{showName}
  已可使用”，待生效时为“{showName} 将于 {time} 生效”；英文分别使用“{showName} is ready
  to use”和“{showName} will be available on {time}”。待生效时间继续用虚线下划线强调，并保持
  日期时间整体不拆行。描述中不得出现模型设置链接。操作区使用并排的
  `h-10 min-w-32 rounded-full` 主次按钮：主按钮“模型设置 / Model settings”负责导航，
  secondary 按钮“复制分享 / Copy & share”直接复制面向 Twitter/X 的分享文案；复制成功后
  原位短暂显示“内容已复制 / Text copied”，不展开额外面板。
  推文按当前语言本地化，只包含模型权益、`#ZCode` 和 `@zcode_ai`，不重复套餐名、总额度或
  起止时间，避免社交文案过长。中文格式示例：`我在 ZCode 领取了 {权益明细}。#ZCode @zcode_ai`。
  主按钮与复制分享按钮之间使用 `gap-2`。领取成功标题与说明组成
  居中状态区，内部使用 `gap-3`；状态区与操作区的外层使用 `gap-6`。
  失败文案按业务码本地化，未知错误与网络错误使用通用失败文案，不向用户暴露服务端
  内部错误。`1005` 表示当日领取额度耗尽：claim 失败响应须保留 `data.plan.ends_at`，按用户
  本地时区判断；活动当天结束时提示“今日领取名额已用完，欢迎下次再来”，明天或之后结束时
  提示“今日领取名额已用完，请明天再来”，字段缺失或无效时只提示“今日领取名额已用完”。
  `1001`、`1002`、`1003`、`1004`、`3001`、`3007` 与登录失效继续使用各自稳定文案，未知码
  才回退通用失败文案。失败态确认按钮使用“知道了 / Got it”；标准 `AlertDialog` 不增加状态图标
  或关闭按钮。失败态不启动 Ticket 动画帧，也不构造或执行分享流程。

- 领取成功后立即显示成功弹窗，并在弹窗展示期间并行重新读取 preview、刷新 billing
  balance 与 Account Source / provider/model，不得等用户关闭弹窗后才开始。
  Claim 成功是不可逆业务事实；上述领取后刷新均为 best-effort。任一刷新失败只能记录降级
  日志，不能把成功结果改写为领取失败，也不能阻止用户关闭或打开模型设置。
  preview 刷新成功时应独立更新 Banner，即使 entitlement 或 provider 刷新失败也不得丢弃该结果。
  entitlement 尚未返回时成功弹窗必须已经可见，但主操作暂时禁用；快照完成或失败后原位更新
  待生效状态并启用“查看套餐 / View plan”。成功弹窗右上角关闭只关闭弹窗。
  2026-09-06 按固定 staging 的默认行为恢复：不启用历史“Start using”开关，领取流程不写
  `providerFamilyConnectionSelections`，不派发 Composer 自动选模指令。Provider/权益刷新通过
  当前 ProviderSettingsService 与 UsageEntitlementService 完成，不恢复旧 Provider Store。
  失败状态直接复用标准 `AlertDialog` 模板：使用默认的 Content、Header、Title、Description、
  Footer 与 Action，不增加状态图标、关闭图标、专属尺寸、居中布局或自定义按钮外形。
- 历史自动选模引导及专用 consumer 已退役；领取成功不派发模型切换请求。
- Banner 右上角提供关闭按钮；关闭仅隐藏当前渲染周期内的 Banner，不发起 claim、
  不修改服务端 preview，也不持久化为永久关闭。整个 Banner 是领取触发区，支持鼠标点击
  及键盘 Enter/Space；模型副标题与右侧领取状态胶囊位于同一行；
  两者间距使用 `gap-1.5`；
  领取状态胶囊只负责装饰和 loading 展示，不是独立按钮；视觉使用组件库的 `outline`、
  `xs` 标准样式，通过 `rounded-full` 保留 pill 外形，
  按钮文字使用 `text-xs`，边框使用随主题变化的 `border-foreground`，
  并对齐 Banner 内容区最右侧；只有顶部标题行
  为右上角关闭按钮预留空间。领取期间胶囊文字替换为 `size-3` 旋转 loading 图标，
  Banner 禁止重复领取；右上角关闭图标保持不变但暂时禁用。

Banner 顶部按 `ZCode 图标与 wordmark SVG [gap-1.5] plan.name` 排列，不显示分隔点；
为避免品牌名重复，Banner 展示前从 `plan.name` 中移除独立的 `ZCode`（忽略大小写）
并清理多余空格。活动名称使用普通前景色而非蓝色，并在剩余宽度内截断。服务端原始 `plan.name` 同时用于
领取结果 Ticket 的套餐名称。Banner 最小高度为 `96px`，内部使用 `gap-1.5`，内容在容器中
整体垂直居中；内容增高时允许自然撑开。主标题取全部
`model_usage` entitlement 中最大的 `grant_units`，按当前 locale 添加数字分组并展示完整
Token 数量，不换算为 `Million` 或“亿”；`Tokens` 作为较小字号的单位跟在额度后面，
例如 `300,000,000 Tokens`。Banner 副标题只显示 `show_name` 模型名称，多个模型使用 `·` 分隔，不显示 `period` 对应的每日、一次性、
Daily、One-time 或 bonus 等额度周期信息，也不显示闪电图标。界面字号放大时，
模型名称在剩余宽度内截断。Banner
使用固定的 `10px / 18px / 12px` 字号层级，不跟随全局 UI 字号缩放。

Ticket 按 `model_usage` entitlement 逐项换行展示权益，不再把不同周期的模型合并为一句：
每行由礼物图标、`show_name`、该项 `period` 和 `grant_units` 组成；`daily` 显示“每日”，
`one_time` 不额外显示周期。

Banner 必须同时支持 Zai Light 与 Zai Dark：亮色容器使用 `bg-neutral-50`、`border-card-border` 与
`shadow-md/5`，主文字与
ZCode wordmark 使用 `text-foreground`，辅助文字使用 `text-foreground-subtle`。暗色通过 `.dark`
恢复活动 Banner 原有的 `neutral-950` 黑底、白色弱边框、内高光深阴影及中性灰文字；关闭按钮与
领取状态胶囊也分别保留亮色语义色和原暗色视觉。不得用普通暗色 `bg-card` 替代活动 Banner 的
深色质感。

## 测试与覆盖契约

手动领取体验的状态维度、剪枝决定、Desktop E2E 候选和分支覆盖率口径统一记录在
[`docs/testing/start-plan-manual-claim-e2e-coverage.md`](testing/start-plan-manual-claim-e2e-coverage.md)。
该功能的覆盖率必须以首次合入前共同提交 `ebae2814f5` 为 diff 基线；由于功能提交已经进入
`staging`，禁止使用当前 `origin/staging` 的空 diff 声称覆盖完成。验收要求新增生产源码可执行行在
focused unit/component 的标准 Istanbul line coverage 中达到 95% 以上；Desktop E2E coverage 单独作为
跨进程链路证据，禁止合并不同 instrumentation 的 statement id 虚增覆盖率。
