# Start Plan 手动领取回归范围

2026-09-08 Todo93 替代下文历史 R06/AS07 的自动切换预期：SPMC-08 刷新后只提示，读盘仍为 Start；点击具体建议才条件保存。不可写时提示失败，恢复权限后点击“重试”才成功，不通过再次刷新自动切换。Pro run desktop-e2e-20260908-100921-925 全组 4/4；首轮 SPMC-02 的后台余额更新与按钮点击竞态已调整 fixture 顺序，产品未改。完整证据与未实测边界见 Todo93。

> 2026-09-06：按 Todo 85 恢复固定 staging（16d999f6a4）的产品行为，使用当前 Provider 身份和设置服务。
> 历史通过记录不能证明本次代码通过。当前实际结果统一记录在
> [恢复审计表](../working-memory/provider-refactor/plan/staging-conflict-restoration-audit.md)。

## 正式 Electron E2E

文件：`packages/desktop/test/e2e/start-plan-manual-claim-experience.test.ts`。本轮按用户最新要求在 MacBook Pro 的独立测试 HOME 执行。

| Case                       | 验证行为                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SPMC-01                    | Banner 关闭确认可取消；确认关闭不发领取请求                                                                                                                                    |
| SPMC-09                    | 领取失败展示“知道了”；当前活动不反复出现；继续轮询后续活动                                                                                                                     |
| SPMC-02 / 07 / 11 / BSM-20 | 安全校验参数随唯一 claim 提交；领取结果与复制分享；弹窗打开时仍轮询；“模型设置”仅导航、不切换连接；手动查看 Start、刷新到账权益；Subagent 候选与当前连接一致；Start 数量快捷入口 |
| SPMC-08                    | 下一时段开放后恢复 Banner；再次领取与模型设置导航；未知 Provider 导航明确报错但页面可操作，后续有效导航可恢复，均不改变连接偏好                                                |

测试只替换安全校验及剪贴板外部能力，使用本地 billing/订阅 mock；真实 Renderer → Host 服务和设置写入链路仍执行。
不通过修改 CSS class 或放宽请求匹配来遮掩行为失败；不保留无产品契约的逐 class、按钮尺寸检查。
Family 的旧 mode/selectedKey 断言迁为结构化 connection selection，不重新导入旧 Provider Store。

2026-09-07 Todo 88 / R10：在已接受的领取到账场景内补充动态成员管理。使用 balance 返回、静态名单中不存在的小写 `glm-5.3-flash`，通过真实弹窗修改上下文窗口、保存重开；将 `glm-5-turbo` 拖至其后。检查磁盘 Personal 只记录该模型覆盖与顺序，不复制 Account 模型成员。账号成员 ID 保持只读。本项不验证真实风控或账单请求。

2026-09-07 Todo 88 / R06：在 SPMC-08 最后补充当前 Start 明确失效的后续行为。先确认当前持久连接为 Start，再让本地 billing mock 明确返回无权益，通过模型设置页刷新触发真实账号状态更新；必须看到自动切换通知，磁盘连接改为仍可用的个人套餐，设置页连接同步显示个人套餐。不能通过测试直接改设置或调用自动恢复函数代替产品链路；未知/网络失败不误切由定向单测覆盖。

2026-09-08 / AS07：同一场景先使隔离 HOME 的设置目录暂不可写，等待真实自动切换失败日志，确认持久连接仍是 Start、没有成功通知；恢复权限后再次点击刷新，相同的失效事实仍能自动切换。权限在 finally 恢复，不改真实用户目录。POSIX 权限故障步骤只在非 Windows 执行；Windows 保留正常失效切换路径，平台无关的失败去重与刷新异常由单测覆盖。不得新增计时重试器。

## 定向单测

2026-09-08 Todo 89 / W89-01–04：在动态模型管理步骤中，先确认不存在 Personal Provider 记录，再直接通过添加弹窗新增、删除个人模型；不能先排序制造前置记录。动态成员编辑期间通过隔离配置仓库修改另一模型，确认 View 刷新不清掉输入、过期保存保留错误与草稿。取消重开后正常保存；排序后再新增模型，检查旧顺序保留且继承成员未进入个人 modelIds。扩展现有场景，不增加真实模型请求。

- Preview/claim/balance 各响应的 `server_time` 从秒转毫秒；生效时间仍按对应接口来源比较，不拿本地 generatedAt 替代服务端时间。
- `effective_at=0` 立即生效；未来时间显示待生效；余额刷新失败时仍保留领取成功，并使用 claim 的已知时间。
- 登录/重新可见/定时刷新；迟到 preview 不覆盖新请求；失败当前活动的去重不吞掉下一活动。
- 连续领取两项活动：关闭第一项结果后，第一项迟到的权益刷新不得覆盖第二项结果的时间或提前解除第二项领取状态；关闭弹窗不撤销已完成的领取。
- 复制成功/失败仅影响分享反馈，不隐藏领取结果与模型设置入口。
- pending、unknown、无模型与未选中是不同的账号状态；测试不得靠“立即体验”强行先选 Start 才能查询权益。

## 明确不恢复

固定 staging 的“Start using”分支默认关闭。当前主动作统一为“模型设置”，失败为“知道了”。
不自动写 Start 连接，不派发 Composer 自动选模，不恢复截图分享菜单。
真实模型请求、真实安全校验服务及系统剪贴板不在这组本地 mock E2E 的证明范围。

## Todo103 保留与重接范围

以下当前契约按 Provider 重构和 Todo93 的最终裁决重接。末尾来源运行记录只证明各自历史版本，不代表本次完整 merge 候选通过；候选证据见 Todo103 账本。旧自动激活和 guide helper 不作为当前领取主路径。

### Banner preview polling contract

手动领取 Banner 不能只在 Renderer 挂载时读取一次 preview。活动可能按小时重新开放领取，
因此 `ManualClaimPlanBanner` 必须持续复用
`ICodingPlanSubscriptionService.getManualClaimPlanPreviews()`，不得新增第二套活动接口或把轮询状态下沉到
desktop main、relay、Agent runtime。

```text
mount / login state change / visible again
  -> request preview immediately
      |-- plans -> select by priority -> show or update Banner
      |-- [] --------------------------> hide Banner, keep polling
      `-- error -----------------------> keep last successful snapshot

visible Renderer
  -> production: poll every 10 minutes
  -> development / test: poll every 30 seconds

document hidden
  -> stop timer
document visible again
  -> request immediately, then restart the environment-specific interval

claim request active
  -> polling paused; stale in-flight preview must not overwrite claim refresh
claim response settled
  -> preview single-flight 立即刷新并恢复轮询；结果弹窗、balance 或 provider 刷新不得继续持有轮询生命周期
```

轮询必须串行，慢请求期间到达的 timer tick 直接跳过，不得并发堆积。同一连续失败周期只记录一次告警，
后续成功后才允许下一次失败重新告警。用户确认关闭 Banner 后保持现有 Renderer 本地 dismiss 语义：
当前挂载生命周期停止展示和轮询；现有 preview 没有小时批次 ID，本阶段不得根据 `planId` 猜测新批次并强制重现。

领取失败与主动关闭语义不同：用户关闭失败弹窗后必须隐藏当前 Banner，但继续轮询。由于 preview 没有小时批次 ID，
失败后进入“等待空档”状态；非空 preview 暂不重复展示，首次空结果解除抑制，之后再次出现的活动才允许展示。

页面可见性以 Page Visibility API 为准：桌面窗口最小化或 Web 标签页隐藏时暂停；普通的应用失焦不作为
暂停条件。该轮询仍是 desktop/web 共用 Renderer 的只读曝光逻辑，不改变 desktop continuous 或手机端
replayable task 恢复语义。

环境判定同时读取 Vite 构建模式与编译期 `ZCODE_ENV`：只有 production build 且
`ZCODE_ENV=production` 使用 10 分钟；Vite development 或 `ZCODE_ENV=test` 均使用 30 秒。
Desktop E2E 虽使用 production bundle，但必须因 `ZCODE_ENV=test` 命中 30 秒周期。

### E2E 登录与安全校验 fixture 契约

正式领取用例必须由 WDIO 启动凭据种子保留 fake `zcodejwttoken`。普通 E2E 会主动删除该字段，
避免 fake JWT 访问真实套餐接口；但本 spec 的 Coding Plan endpoint 已固定指向 shard-owned 本地 mock，
且 `claimManualPlan` 在发出 HTTP 请求前会先读取该 JWT。不能依赖一次性的 legacy `auth_token` 迁移：
同一 spec 使用 `reloadSession` 重建 Electron 后，迁移源可能已经被消费，导致服务层直接返回 401，
既无法证明失败 fixture 被命中，也无法证明成功 claim header 已提交。

```text
WDIO startup credential seed
  -> preserve fake zcodejwttoken for start-plan-manual-claim-experience
  -> Electron reload restores authenticated ZCode session
  -> deterministic verification success
  -> claimManualPlan reads JWT
  -> POST local /api/v1/zcode-plan/billing/claim
       |-- failure case: mock business code -> failure dialog
       `-- success case: code 0 -> success dialog + one verification header
```

安全校验替身必须覆盖官方版本当前的 SDK 回调契约（细节随官方版本的安全校验规格维护）。
SPMC-02 失败时应同时输出 mock request ledger 与安全校验阶段，明确区分“未发 claim”、业务失败和成功文案漂移。
该 spec 的 BigModel 启动连接使用 `providerFamilyConnectionSelections.bigmodel` 的结构化选择
（例如 `{ kind: "individual-coding-plan" }`）；不重新 seed 旧 mode/selectedKey。打开模型设置前后比较该选择，避免把历史迁移误判为领取导航的写入。

### Feature relationships

| Rank           | From                    | Semantic edge          | To                                     | Why inspect it                                   | Evidence                                                        |
| -------------- | ----------------------- | ---------------------- | -------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| must-inspect   | Manual claim Banner     | claims through         | Coding Plan Subscription Service       | 领取业务事实和错误码来源                         | `ManualClaimPlanBanner.tsx`、`codingPlanSubscriptionService.ts` |
| excluded | retained Start using | no production entry | Setting Service | 领取后不写连接；仅保留历史追踪，不恢复该路径 | 当前 ManualClaimPlanBanner |
| excluded | one-shot guide | no claim trigger | Composer | 当前领取不触发自动模型选择，不恢复来源 fallback | 当前领取 DOM 测试 |
| should-inspect | result sharing          | uses                   | Platform screenshot + Clipboard        | 失败只反馈，不逆转领取                           | `ManualClaimPlanResultDialog.tsx`                               |
| conditional    | Start Plan selection    | uses provider registry | local/remote workspace runtime         | 本次不改 registry/remote 同步语义                | `manual-model-switch-resolution-chain.md`                       |
| invariant-only | claim UI                | must not change        | desktop continuous / mobile replayable | 无 task stream、snapshot 或 replay 变更          | 当前 diff 无 realtime/protocol 文件                             |
| evidence-only  | focused component tests | covers                 | pure logic and rendered branches       | 单测是证据，不替代跨组件 E2E                     | `packages/ui/test/manualClaimPlan*.test.ts`                     |

### Must-preserve invariants

| Invariant                   | Proof needed                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| preview 只曝光，不激活套餐  | request ledger 中 preview 与 claim 可区分；关闭流程 claim 数为 0              |
| claim success 是不可逆事实  | entitlement/provider 任一刷新失败时仍保留成功 Dialog 与操作                   |
| 领取不触发 guide | 模型设置后 requestId 不增加，持久连接不改变 |
| 不按候选首项替用户选模 | 当前结果只导航；候选/选择由统一 View 提供 |
| UI 兼容主题、语言和窄屏     | Zai Light/Zai Dark、中文/英文 copy、480px Dialog 视口约束的 DOM/视觉证据      |
| Hero 资源隔离               | iframe 仅 `allow-scripts`；初始化消息校验 source/instanceId；资源 ready E2E   |
| 模型设置引导只负责导航      | 点击描述内入口后关闭结果弹窗并定位 `modelProvider`；settings 连接选择保持不变 |
| 不扩散到远控恢复语义        | 无 `clientMode`、`deliveryKind`、snapshot、queue、owner/lease 改动            |

### Codegraph evidence and drift

当前环境未提供 codegraph 查询入口，因此用精确 symbol caller 搜索完成 depth-2 验证：

| Seed                                                | Direct caller / key path                              | Depth | Interpretation               |
| --------------------------------------------------- | ----------------------------------------------------- | ----- | ---------------------------- |
| `ManualClaimPlanBanner`                             | `WorkspaceSidebar`                                    | 1     | 唯一领取入口                 |
| `requestManualClaimPlanModelGuide` | 当前 ManualClaimPlanBanner 不调用 | 1 | dormant helper，不是本次领取链路 |
| `resolveManualClaimPlanModelSelection` | 仍在 Composer 的 dormant guide consumer | 1 | 不因合并接回领取触发 |
| `shouldDismissContextQuotaResetOpportunityReminder` | `ChatContextUsage`                                    | 1     | 相邻 Tooltip 外部点击语义    |

Graph drift：现有功能图只声明 `capability.plan-entitlements`、`service.plan-entitlements` 和用量 surface，
来源曾补充手动领取与 guide 关系；Todo103 只保留实际领取/刷新/导航边界，不把已撤销的 guide commit edge 写成当前事实。

## Boundary Decisions

| Boundary            | Decision                | Includes                                                       | Excludes / prunes                        | Source                                        |
| ------------------- | ----------------------- | -------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| 领取主路径          | accepted                | preview、确认、安全校验、claim、success、并行刷新、模型设置导航 | 真实库存与真实安全校验                   | feature spec                                  |
| 领取失败            | accepted                | 稳定业务码代表 + generic/安全校验 focused tests                | 每个业务码做独立 E2E                     | 同一 failure Dialog/mapper，不增加链路差异    |
| 分享                | accepted                | 入口可见、直接复制文本、成功与失败反馈                         | 真实系统剪贴板权限矩阵                   | Clipboard 边界由 focused component tests 覆盖 |
| 模型选择 | excluded from claim | 模型设置导航不改持久连接、不触发 guide | 首项回退/自动选模/真实模型请求 | 当前手动选择另有专项覆盖 |
| 主题/语言           | accepted representative | Zai Light 中文 + Zai Dark 英文                                 | 所有主题×语言×viewport 全排列            | 主题和 locale 是正交 presentation 轴          |
| remote/mobile       | pruned                  | 共享 React 纯函数/组件单测                                     | 独立 remote Agent、replayable snapshot   | 领取不拥有 task realtime 状态                 |
| Context reminder    | accepted focused        | trigger/reminder/outside 三类 target                           | 与 claim 做笛卡尔积                      | 相邻独立 UI 状态，无共享业务 owner            |
| Banner preview 轮询 | accepted                | 首拉、10m/30s 周期、可见性恢复、串行与 stale result 隔离       | 新接口、小时批次推断、跨窗口 coordinator | Renderer 只读 preview，不新增业务 owner       |

## Accepted Cases

| Case ID | Setup                                                  | Action                                                  | Assertions                                                                                                                   | Evidence layers                           | Status                   |
| ------- | ------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------ |
| SPMC-01 | preview 可领取、已登录                                 | 打开关闭确认，先取消再 close anyway                     | cancel 保留 Banner；close 隐藏；claim ledger 为 0                                                                            | Desktop DOM + mock ledger                 | formal E2E，已转正并通过 |
| SPMC-02 | preview、fake JWT、安全校验 success、claim current     | claim → 检查结果 Dialog → Model settings                | 新标题；描述无链接；模型设置与复制分享并排；直接复制文案；不修改 settings；claim header 只提交一次                           | Desktop DOM + mock ledger + settings      | formal E2E，已转正并通过 |
| SPMC-03 | 官方版本安全校验超时升级                               | —                                                       | 仅官方版本适用；断言随官方版本的安全校验规格维护                                                                             | focused runtime unit                      | covered（官方版本）      |
| SPMC-04 | claim 返回失败                                         | claim、确认失败 Dialog                                  | 无 Ticket/分享/刷新；稳定本地化错误                                                                                          | component unit                            | covered                  |
| SPMC-05 | 领取成功，候选含 Start | 打开模型设置 | 当前只导航，不自动写连接、不请求 guide；来源自动选模用例不恢复 | component DOM + Settings E2E | superseded by current navigation contract |
| SPMC-06 | Context reminder 可见                                  | 点击 trigger、reminder、outside                         | 前两者保留，outside dismiss                                                                                                  | focused unit/component                    | covered                  |
| SPMC-07 | 同时存在立即生效旧桶与已到点的新排期权益               | 打开 Model Settings → 服务端标记新桶就绪 → 点击刷新权益 | 旧套餐不显示刷新按钮；新套餐显示 outline pill；点击后请求 balance，新桶出现且按钮消失                                        | Desktop DOM + local HTTP mock ledger      | formal E2E，已转正并通过 |
| SPMC-08 | 当前时段已领取，preview 返回空                         | mock 开放下一领取时段并等待测试环境 30 秒轮询           | preview 请求数增加；不 reload Renderer；Banner 自动恢复                                                                      | Desktop DOM + local HTTP mock ledger      | formal E2E，已转正并通过 |
| SPMC-09 | preview、fake JWT、安全校验 success、claim 返回业务失败 | 关闭失败 Dialog → 当前时段持续为空 → 后续轮询           | 带安全校验 header 的 claim 恰好新增一次；当前 Banner 隐藏；轮询不停止；同轮不重复展示；空档后下一轮恢复由 timer 单测精确覆盖 | component timer + Desktop DOM mock ledger | formal E2E，已转正并通过 |
| SPMC-10 | claim 返回 entitlement 生效时间与服务端时间            | 客户端时钟偏移后领取，同时让 balance 返回冲突排期       | 弹窗只按同次 claim 的 `entitlements[].effective_at` 与 `server_time` 判断；balance 不覆盖弹窗，字段缺失时不回退 `starts_at`  | service mapper + component unit + E2E     | covered                  |
| SPMC-11 | claim 成功且结果弹窗保持打开                           | provider 刷新 pending，推进一个测试轮询周期             | preview 仍按 30 秒周期请求；结果弹窗与后置刷新均不持有轮询生命周期                                                           | component timer + Desktop mock ledger     | covered                  |

## Pruning Decisions

| Decision ID | Pruned combinations                                     | Guard/invariant                                                          | Representative coverage                     |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| SPMC-P01    | 2 themes × 2 locales × desktop/mobile × success/failure | 业务 owner 与 presentation 轴正交                                        | SPMC-02 + focused i18n/theme DOM assertions |
| SPMC-P02    | 所有 claim error code 各跑 Desktop                      | mapper 和失败 Dialog 相同，只有 description id 不同                      | mapper table unit + SPMC-04                 |
| SPMC-P03    | 真实第三方安全校验服务的 silent/interactive 网络        | 第三方状态不稳定且不可进入 CI                                            | deterministic callback unit SPMC-03         |
| SPMC-P04 | 当前弹窗 Start using 与真实模型请求 | 当前 UI 只导航模型设置，不恢复自动切换 | 领取 DOM + 既有 model-switch suite |

## 历史来源 Verification Evidence（不是 Todo103 候选验收）

### Branch-diff coverage

覆盖审计使用 `ebae2814f5...HEAD` 取得当前分支全部生产源码文件集合，再以 `ebae2814f5` 到当前工作树的
新增/修改行作为候选；只统计 focused Vitest V8 报告中 Istanbul `getLineCoverage()` 认定为可执行的行。
Desktop Renderer 使用不同的 instrumentation/source-map 粒度，不能直接合并 statement id，因此单独保存为
跨进程证据。翻译数据、测试和文档不进入分母。

| Production source                          | Covered executable changed lines |
| ------------------------------------------ | -------------------------------: |
| `modelProviderService.ts`                  |                            6 / 6 |
| `contextQuotaResetOpportunityReminder.tsx` |                            5 / 5 |
| `contextUsage.tsx`                         |                            8 / 8 |
| `ManualClaimPlanBanner.tsx`                |                          10 / 10 |
| `ManualClaimPlanResultActions.tsx`         |                            8 / 8 |
| `ManualClaimPlanResultDialog.tsx`          |                            5 / 7 |
| `manualClaimPlanModelGuideStore.ts`        |                            4 / 4 |
| `manualClaimPlanModelSelection.ts`         |                          16 / 16 |
| 官方版本安全校验 runtime                   |                          29 / 30 |
| `SessionPane.tsx`                          |                          17 / 17 |
| `V4ComposerToolbar.tsx`                    |                          10 / 11 |
| **Total**                                  |          **118 / 122（96.72%）** |

未覆盖的 4 行只位于分享失败反馈、安全校验 duplicate 的错误拒绝语句和一个 Composer guide 条件行；对应用户行为
分别由 component failure、安全校验 duplicate rejection 和 mounted V4 Composer assertion 验证，不影响 95% 行覆盖门槛。

### Executed suites

- Focused unit/component：10 files、346 tests 全部通过；额外包含 selected Start Plan provider runtime、
  SessionPane 首发失败反馈与关闭。
- Desktop E2E（coverage mode）：`desktop-e2e-20260827-130252-862`，SPMC-01/02 共 2 cases，
  首次通过率与最终通过率均为 100%，无 flaky、无 infra failure。
- 最终待提交 mock/spec 复跑：`desktop-e2e-20260827-131853-472`，2/2 通过。
- 转正后正式路径复跑：`desktop-e2e-20260827133422383-p95897-2b91245a0ba1a93d`，2/2 通过；未设置 manual-review 开关。
- 排期权益刷新路径复跑：`desktop-e2e-20260901090249947-p23514-f2968f04d3e97519`，SPMC-01 与
  SPMC-02/07 共 2/2 通过；验证旧桶保留、刷新按钮显隐、刷新后的 `billing/balance` 请求及新桶展示。
- 分享入口与并排操作布局复跑：`desktop-e2e-20260901092627117-p53937-fef63e3aa58c22a3`，2/2 通过；
  验证分享入口可见，且分享与开始按钮同排等高。
- 领取凭据与双分支修复复跑：`desktop-e2e-20260902-113435-283`，4/4 通过；SPMC-09 与
  SPMC-02 分别真实新增一次带安全校验替身 token header 的失败/成功 claim，排除登录 401 或安全校验错误假通过。
- E2E coverage 产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20260827-130252-862/coverage/`；
  case 报告：同 run 目录的 `summary.md`。

## E2E Handoff

- Formal spec：`packages/desktop/test/e2e/start-plan-manual-claim-experience.test.ts`
- Mock fixture：扩展 Coding Plan shard-owned local server，新增 manual-claim scenario 和 request ledger；不访问真实后端。
- Provider fixture：不需要；case 不发送模型 prompt。
- File-system fixture：隔离 E2E HOME 中的 credential、provider config、settings。
- Timing：`fast-text`；安全校验超时升级只在 fake-timer unit 验证。
- Coverage：运行 spec 时设置 `ZCODE_E2E_COVERAGE=1`，保存 Renderer Istanbul 报告；严格分支差异行覆盖率使用 focused Vitest V8 报告审计，避免混合不同 instrumentation 的 statement id。
- Promotion：2026-08-27 经人工确认后转入正式路径；该 auth/config/UI case 不依赖 provider replay fixture，正式运行继续使用确定性的本地 Coding Plan mock。

# 2026-09-10 迁移说明

2026-09-12 更新：用户确认营销 E2E 转正，当前正式路径为 `ui-shell/marketing/marketing-touch-delivery.test.ts`、`ui-shell/marketing/marketing-touch-entitlement.test.ts`、`ui-shell/marketing/marketing-touch-anonymous.test.ts`。下文 pending 说明保留为迁移历史，最新执行证据见 `marketing-touch-e2e-implementation.md`。

本文以下内容为旧 Banner/preview 流程的历史覆盖记录，不再作为当前 Sidebar 契约。当前语义及 MTC 验收矩阵见 `docs/marketing-touch-client.md`。

旧 `start-plan-manual-claim-experience.test.ts` 已拆迁为 `ui-shell/manual-review/pending/marketing-touch-delivery.test.ts` 与 `marketing-touch-entitlement.test.ts`：移除本地关闭确认、claim 结果生成分享按钮、preview 30 秒重显等已退休行为；保留真实 Banner/领取/上报和相邻权益刷新、Start/Individual/Subagent 选择联动。新路径未获人工确认前保持 pending，不自动晋升正式套件。旧 Banner 组件及专属单测现已删除；Hero 独立测试继续保留。
