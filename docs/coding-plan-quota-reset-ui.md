# Coding Plan 五小时/周额度重置客户端联调规范

## 背景与结论

客户端已具备“重置机会、手动重置、自动/运营重置完成提示”的 UI。本次接入 ZCode Server 最新重置接口，使 Personal Coding Plan 与 Team Plan 都以服务端状态为权威来源。

后端文档：`coding_plan_reset_mechanism_design.md`（2026-08-11 版本）。

产品语义已经确认：**重置机会由服务端判断和发放，客户端不做本地资格判断**。最新后端契约要求客户端调用 `/opportunity` 触发一次服务端资格判断；这个调用不是用户“申请机会”的交互。客户端本期调用：

- `GET /api/v1/coding-plan/reset/status`
- `POST /api/v1/coding-plan/reset/opportunity`
- `POST /api/v1/coding-plan/reset/use`
- `POST /api/v1/coding-plan/reset/history/read`

`GET /status` 只读取已经发放的机会，不创建机会。客户端在 status 没有有效机会（FIVE_HOUR 或 WEEK）、也没有刚发现的 completed history 时调用 `POST /opportunity`；`/opportunity` 是 scope 级请求，一次即覆盖五小时与周两类机会。后端根据用量、时间窗口和当日次数决定是否发放。客户端不展示“申请机会”按钮，也不根据本地额度阈值自行判断或发放机会。

## 范围

- 仅 Personal Coding Plan 或 Team Plan scope 进入机会判断；最终只在服务端 `status` 返回有效机会时展示重置入口。
- 五小时与周额度各自独立承载手动重置和自动/运营重置完成提示；机会徽标合并为一个，两类机会次数累加、倒计时取最早到期的一档。「设置 → 使用统计」、模型 Provider 状态卡、输入框 Context 用量面板中的额度标题旁「重置」按钮只打开统一重置弹窗，不直接核销，也不按点击类型过滤；真正的 `/use` 仅由弹窗内对应类型的「重置」按钮触发。周额度手动重置发送 `reset_type: "WEEK"`，完成后按 7 天乐观改写下一次重置时间。
- Personal 与 Team 使用完整 source scope 隔离状态；Team key 必须包含 organization + project，不能只按 provider id。
- 手动重置期间展示 processing；成功后刷新 status 和真实 entitlement/quota。
- 自动/运营重置由轮询发现 `latest_five_hour_reset_history.used_at` 或 `latest_week_reset_history.used_at` 变化后展示 completed。后端没有 processing 字段，业务判断与额度校正只依赖服务端 `used_at`；Composer 触发器仅在客户端合成一小段“正在重置”观感（约 1 秒）后切换为“已重置”，该合成阶段是纯前端视觉，不据此改写任何服务端状态。
- 完成时间使用服务端 Unix 毫秒 `used_at`，不使用客户端 `Date.now()` 作为完成依据。
- `observed_at` 只表示客户端首次观察到当前 `used_at` 的时刻，用于保证 5 分钟轮询发现自动/运营重置后仍能完整播放短提示；hover/focus 展示和业务判断仍只使用服务端 `used_at`。
- `has_unread_history=true` 且完成提示已写入客户端状态后，上报 history read。
- 支持桌面、Web、手机 `/remote`、浅色/深色、中文/英文和 reduced motion。

不在本期：

- 客户端本地判断重置资格或额度阈值。
- 服务端 processing/SSE/WebSocket；后端未提供这些契约。
- 把 reset 状态写入 relay、desktop main、Agent runtime 或 session/task realtime 流。

## 服务与进程边界

```text
Desktop renderer / Web remote renderer
              |
              | hook 调用；不读取 credential、不直接 fetch
              v
       IUsageStatsService (现有 Host RPC)
              |
              | 读取 zcode JWT + 当前 Coding Plan credential
              | 构造 Personal/Team scope headers
              v
       ZCode Server /api/v1/coding-plan/reset
              |
              | status / opportunity / use / history-read
              v
       Zustand window-local reset state
         |             |             |
         v             v             v
   Composer       Provider 设置      Usage 页
```

- Desktop 本地窗口继续使用 window-scoped Local Host。
- 手机 `/remote` 继续通过 shared-host attachment 使用桌面已存在的 host service，不创建独立 Agent、local host 或远程 runtime。
- 本功能不修改 task/session stream、snapshot、queue、owner/lease；因此不改变 desktop `continuous` 与 Web remote `replayable` 边界。
- UI 只通过 hook 访问 `IUsageStatsService`；Service 层不引用 Runtime 具体实现。

## API 契约

### Scope 请求

```ts
interface CodingPlanResetScopeRequest {
  preferredProviderId: string;
  organizationId?: string | null;
  projectId?: string | null;
}
```

Service 根据 scope 构造：

```text
Authorization: Bearer <zcode_jwt>
X-Bigmodel-Authorization: <current_provider_business_jwt>
Bigmodel-Target-Type: PERSONAL | TEAM
Bigmodel-Organization: <TEAM only>
Bigmodel-Project: <TEAM only>
```

约束：

- JWT 从 credential service 的 `zcodejwttoken` 读取。
- `X-Bigmodel-Authorization` 传当前 Coding Plan provider family 对应的业务 JWT，直传且不套 `Bearer`，**不是 Coding Plan API key**：Z.ai family 使用 credential service 的 `oauth:zai:access_token`，BigModel family 使用 `oauth:bigmodel:access_token`。两类凭据禁止互相回退，避免当前 provider identity 与服务端校验身份串用（2026-08-14 Z.ai reset 鉴权修正）。
- Coding Plan provider 解析用于确认套餐已配置、选择与 provider family 一致的业务 JWT，并推导 Personal/Team scope；Team scope 完全由 `Bigmodel-Organization` / `Bigmodel-Project` header 承载，客户端不再为 reset 请求复制团队项目 API Key。
- credential 值不得写日志、不得进入 UI store、不得持久化。
- URL 使用 `buildRuntimeZCodeApiUrl(env, path)`，随 test/production/custom endpoint 设置切换。

### status 映射

```ts
interface CodingPlanResetStatusSnapshot {
  availableFiveHourResets: Array<{ expireAt: number }>;
  availableWeekResets: Array<{ expireAt: number }>;
  latestFiveHourResetHistory: { usedAt: number } | null;
  latestWeekResetHistory: { usedAt: number } | null;
  hasUnreadHistory: boolean;
}
```

服务层必须运行时校验 envelope 和字段，不信任远端 JSON；客户端不得根据 `msg` 分支。

### opportunity 判断与幂等

```ts
interface CodingPlanResetOpportunityRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
}

interface CodingPlanResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}
```

请求体固定为：

```json
{
  "idempotency_key": "<uuid>"
}
```

- 每次新的服务端资格判断生成新 UUID，长度不得超过 64 字符。
- 相同 service + scope 的同时调用由客户端 single-flight 合并，同一网络请求只使用一个幂等 key。
- `granted=true` 后 `nextTryAt=null`，立即强制刷新 `/status`，以服务端返回的 opportunity 内容为准；Coordinator 至少 10 分钟后再做下一次资格判断。
- 业务码 `3301` 必须返回 `granted=false` 和 Unix 毫秒时间戳 `next_try_at`；Service 映射为 `nextTryAt`，Coordinator 保存该服务端时间，到期前只轮询 status。
- 服务端未返回有效 `nextTryAt` 时使用 10 分钟兜底；过去时间至少延后 5 分钟，避免短时间内重复判断。已有某一类型机会不永久阻塞 scope 级判断，到期后仍允许服务端评估另一类型。
- `granted=false` / `3301` 保持入口隐藏，不弹错误 toast；`code=2007`、网络中断和超时等瞬时错误固定 5 分钟后重试，并复用失败请求的幂等 key。
- 后端在请求过快/发卡锁竞争时可能直接返回裸 HTTP 429（无 3301 信封、无 `next_try_at`）。Service 映射为稳定错误 `coding_plan_reset_opportunity_throttled`；Coordinator 固定冷却 10 分钟后再生成新 key 判断。鉴权、业务拒绝、协议解析等稳定错误同样等待 10 分钟并生成新 key，避免缺少凭据时高频空轮询和生产 warn 刷屏。
- 客户端不得根据当前五小时用量是否低于 80% 等阈值跳过或伪造发放；后端是资格判断唯一来源。

### use 幂等

```text
新的一次用户点击 -> 生成新 UUID（<= 64 字符）
同一次请求失败 -> 保留 UUID
用户点击重试   -> 复用原 UUID
used=true 成功 -> 清除 UUID
```

请求体固定为：

```json
{
  "idempotency_key": "<uuid>",
  "reset_type": "FIVE_HOUR"
}
```

## 状态模型

```text
                status: 无机会、无新历史                 opportunity: granted=true
HIDDEN / IDLE ------------------------------> CHECKING ------------------------+
     |                                                                         |
     | status: 有有效 FIVE_HOUR opportunity                                    v
     +------------------------------------------------------------------> AVAILABLE
     ^                                                            |
     | opportunity: false / 3301 + next_try_at                    | 页面按钮打开弹窗；弹窗内点击某类型「重置」
     | （冷却期只轮询 status，不再 POST opportunity）              v
     |                                                      CONFIRMING(type)  ← 弹框内确认页，不发请求
     |                                                            |
     |                       取消 / 返回 / Esc / 关闭弹框 / 目标失效 -> 回列表（仍是 AVAILABLE，不核销）
     |                                                            | 进入确认页 500ms 后点击「重置」
     |                                                            v
     |                                                      LOCAL_PROCESSING
     |                                                            |
     |                                     use 失败（保留 key）    | use used=true
     |                                      +---------------------+
     |                                      |                     v
     |                                      +--------------- REFRESH_STATUS
     |                                                            |
     |                             status latest used_at 更新       v
     +-------------------------------------------------------- COMPLETED
                                                                  |
                                                                  | 展示完成提示后
                                                                  v
                                                          history/read
```

COMPLETED 与机会余额正交（同一份 status 快照同时给出两类信息）：

```text
完成维度  used_at / observed_at / quota_override_pending / next_reset_at
          └─ 已重置提示、100% 乐观覆盖、重置时间兜底
机会维度  opportunity_count / opportunity_expires_at（同快照余下的有效机会）
          └─ 徽标张数、额度标题旁「重置」、弹框行张数与倒计时、reset() 放行

COMPLETED(余下 0 张) ── 标题旁「已重置」；弹框行成功反馈后收起
COMPLETED(余下 N 张) ── 标题旁「重置」；弹框行保留并展示 N 张与下一张倒计时
      │
      └─ 弹框内再次点击重置 ─> CONFIRMING ─> 确认 ─> LOCAL_PROCESSING ─> /use ─> status 新 used_at ─> COMPLETED(余下 N-1 张)
         （不必等下一轮轮询让位回 AVAILABLE，也不必重开弹框）
```

规则：

- AVAILABLE 来自服务端未过期的 `available_five_hour_resets` / `available_week_resets`，各自取最早有效 `expire_at` 作为倒计时；五小时与周额度互不影响。
- `has_unread_history` 是五小时与周共享的单一游标，但 `latest_{five_hour,week}_reset_history` 相互独立。某一类型只有在其 `used_at` 是两类中最新时才“拥有”该未读标记并进入完成态：`ownsUnread = has_unread_history && latestUsedAt != null && (otherUsedAt == null || latestUsedAt >= otherUsedAt)`。这样一次周重置翻起共享标记时，不会把过期的五小时历史误判为刚完成（反之亦然）。
- 页面额度标题旁按钮只打开统一重置弹窗；它不进入 LOCAL_PROCESSING，也不直接调用 `/use`。LOCAL_PROCESSING 只由弹窗内确认页的「重置」按钮触发，弹窗按钮展示 loading/禁用。
- 弹框内二次确认（五小时与周额度同一流程）。Bugfix：核销不可撤回，曾经点一下行内「重置」就直接 `/use`，误触白白消耗机会。
  - 点行内某类型「重置」只切到该类型的确认页（`CONFIRMING(type)`），不发请求。确认页替换列表，标题为「重置 5 小时额度？」/「重置本周额度？」，展示该类型当前剩余 → 100%，并写明将用掉最早到期那次机会的到期日（服务端 `/use` 总是核销最早到期的一张）。
  - 确认页「取消」、左上「返回」、Esc 都只退回列表，不核销；Esc 在确认页不关闭整个弹框。关闭弹框同样不核销，重开时回到列表。
  - 确认页「重置」与行内「重置」位置相近：进入确认页的 500ms 内忽略确认点击，防止连点穿透成核销。该时刻只在点行内「重置」进入确认页时记录。
  - 确认目标失效：确认期间该类型机会过期、被别处核销（`isResetItemUsable` 为假），或被其它入口发起核销进入 processing，确认页立即退回列表并清掉确认类型，由列表行展示进行中状态，不保留可点却被忽略的确认按钮。本页自己的确认先清确认类型再进入 processing，不受此规则影响。此后同类型机会再次出现也保持列表，用户必须重新点行内「重置」进入确认页，并重新走 500ms 防连点。Bugfix：旧实现只把确认目标派生为空、确认类型残留，机会重新出现时自动跳回旧确认页且沿用旧进入时刻，一点就核销。
- 额度标题旁操作按「是否仍可核销」取态：该类型仍有可核销机会时展示可点击「重置」（打开弹窗）；否则 COMPLETED 展示「已重置」与服务端完成时间。自动/运营完成且同类型仍有余下机会时，面板内没有「已重置」锚点，补播撒花跳过、arm 保留到完成态让位后被清理，完成反馈由 Composer 触发器 Tooltip 承担。
- 手动重置从 LOCAL_PROCESSING 进入 COMPLETED 后，按钮先展示 600ms 成功勾选并播放一次烟花，再切换为“已重置”；不展示“正在重置”或“已重置” Tooltip。
- 手动核销轨迹按 service + scope 在多个 UI 入口间共享。任一入口点击重置后，其他入口观察到同一个新 `used_at` 时也必须识别为手动完成，不能把输入框误触发成自动/运营重置提示。
- 自动/运营重置没有服务端 processing 信号：轮询发现新的 `used_at` 时直接进入 COMPLETED。Composer 触发器据此合成一小段“正在重置”（约 1 秒，纯前端视觉）后切换为“已重置”，该“已重置” Tooltip 一直保留，直到用户 hover 触发器展开额度面板后才收起。
- COMPLETED 使用服务端 `used_at`；自动/运营重置的合成“正在重置”从客户端首次观察到该 `used_at` 的 `observed_at` 起算，重复轮询同一历史不得重放或续期。hover 展开额度面板时，从面板内「已重置」重置项位置（与手动重置同一位置）补播一次撒花，按 `used_at` 去重，只播一次。“已重置”操作和 hover/focus 时间持续使用服务端 `used_at`，直到后续 status/quota 校正。
- 自动/运营重置的撒花 arm 只能在面板内「已重置」DOM 已挂载且实际调用撒花函数后消费；若浮层刚打开时锚点尚未就绪，必须保留 arm 并在锚点挂载后补播，不能提前标记已播放。
- Root Store 按 source + 类型记录自动完成**首次观察**时的 `(used_at, auth_session_seq)`。同一个 `used_at` 的后续轮询不得把观察记录改写为当前鉴权会话；设置页或 Usage 页在**同一鉴权会话**先写入完成态后，Composer 后挂载仍必须展示该次新自动重置；只有用户从未登录重新进入登录态、`auth_session_seq` 已变化且 `used_at` 仍相同时，才把 `observed_at` 置空，避免退出重登后重播旧 Tooltip/撒花。已登录状态下刷新用户信息或连接额外 provider 不推进该序号；上一鉴权会话尚未完成的异步 status 回写必须被 Store 原子拒绝。
- 自动完成提示在**同一桌面应用的多窗口间只播放一次**（Bugfix：`has_unread_history` 游标清理存在秒级时滞，多窗口独立轮询会重复播放）。status 写入只表示“观察到完成”，设置页、Usage 页等非 Composer 入口不得据此占用播放资格。Composer 准备展示 Tooltip/撒花前，必须用 `(sourceKey, reset_type, used_at)` 向 BroadcastHub 申请带 token 的临时 reservation；只有组件确认仍 mounted、source/candidate 仍匹配并即将展示时，才把 reservation commit 为永久 claim，同时写入 played、进入合成 processing/completed Tooltip、arm 撒花并广播 played。若等待 reservation 期间组件卸载、切换 source 或候选失效，winner 必须用 token release；Main 也必须在 host 注销或 reservation TTL 到期时回收未 commit 的占用。claim busy 只表示另一窗口正在准备展示，loser 不得据此写 played 或清空 `observed_at`，只能等待真实 played 广播，或在临时 reservation 释放/过期后重试。BroadcastHub 只保存有上限的 opaque reservation/claim，不承载 Coding Plan 业务状态；Web/无 parentPort 环境由 broadcast service 的进程内 reservation 提供相同语义。played 广播用于让其他窗口收起已观察但尚未播放的提示，其合并必须按 `used_at` 单调递增，旧广播晚到不得覆盖更新记录。
- 机会过期后立即隐藏，下一轮 status 再校正。
- 只要该类型持有未过期的有效机会，三个入口（机会徽标、额度标题旁「重置」按钮、弹框重置行）都必须展示，并展示剩余张数；额度剩余 100% 不再作为隐藏条件。Bugfix：核销会把对应额度剩余乐观改写成 100%（见下条），若按「剩余 100% 则重置无收益」隐藏入口，用户刚用掉一张就连带看不到余下的机会，会以为卡被吞掉。机会是用户资产，满额时是否核销由用户判断，「重置」按钮保持可点击。入口只在机会耗尽或全部过期后消失。
- COMPLETED 在同一 `used_at` 周期内保持（重复轮询不清空完成态）；但后端在同一周期内再次下发有效机会时，完成态让位回到 AVAILABLE（视为新一轮周期开始），否则新机会会被完成态永久遮蔽。刚发现的未读完成仍优先于新机会展示一轮，手动 `/use` 的 processing 对账不受影响。
- COMPLETED 同样携带同一 status 快照里余下的有效机会（张数与最早 `expire_at`）。「是否仍可核销」只有一个判定：非 LOCAL_PROCESSING、张数 > 0 且最早到期晚于当前时刻；AVAILABLE 与 COMPLETED 都用它决定徽标张数、标题旁「重置」、弹框行与 `reset()` 是否放行。完成态下的余下机会可直接再次核销（COMPLETED → LOCAL_PROCESSING，生成新幂等 key），跨入口防双核销的强制对账照常执行。Bugfix：旧实现进入 COMPLETED 时把张数/到期清零，余下的卡要等下一次 status（≤5 分钟轮询，或重开弹框、重挂载入口触发的立即校正）才恢复；期间弹框行把空到期渲染成「0 分 0 秒后过期」，再次点击被 `reset()` 静默忽略却仍播放成功反馈。弹框为绕开该问题维护的本地张数对账属于第二数据源，一并删除。
- completed 时 UI 可先乐观覆盖对应额度剩余为 100%，并标记 `quota_override_pending=true`，同时强制刷新 entitlement；真实 quota 刷新成功后清除该标记，后续重复轮询同一 `used_at` 不得重新开启覆盖，界面以服务端 quota 为准。乐观改写的下一次重置时间按类型计算：五小时额度为 `used_at + 5h`，周额度为 `used_at + 7d`。

```text
手动点击： AVAILABLE -> LOCAL_PROCESSING -> SUCCESS(600ms) -> COMPLETED
UI 反馈：  重置按钮     按钮 loading         成功勾选+按钮烟花    “已重置”
Tooltip：  关闭         关闭                 关闭                关闭

自动/运营： HIDDEN/AVAILABLE ----轮询发现新 used_at----> 合成“正在重置”(~1s) -> COMPLETED --hover 触发器--> 收起 Tooltip
UI 反馈：                                              触发器合成转圈           触发器“已重置”常驻   面板内同手动位置补播撒花
Tooltip：                                              “正在重置”              “已重置”(常驻)       关闭
```

## 轮询、共享与时序

同一 Renderer 内按 `authSessionSeq + usageStatsService + preferredProviderId + organizationId + projectId` 建立一个共享 Coordinator。Composer 触发器、Composer HoverCard、设置 Provider 卡和 Usage 页只订阅状态，不各自创建计时器或直接驱动周期请求。不同个人/团队 scope 分开轮询；不同窗口本期不做前端 leader election，仍由服务端幂等和限流兜底。

```text
Composer Trigger ───┐
Composer HoverCard ─┤
Provider Card ──────┼── subscribe ──> scope Coordinator
Usage Page ─────────┘                     |
                                         | document visible: 首次立即 + 每 5min
                                         v
                                  GET /reset/status
                                         |
                          processing / 本轮新完成?
                              | yes              | no
                              |                  v
                              |          now >= nextOpportunityAt?
                              |             | no       | yes
                              |             |          v
                              |             |   POST /reset/opportunity
                              |             |          |
                              |             |     granted / next_try_at
                              |             |          |
                              |             |     更新共享调度时间
                              |             |          |
                              |             |   granted=true 时强制 GET status
                              v             v
                             Zustand 共享状态投影
```

```text
订阅数 0 --首个入口挂载--> 1: 绑定 visibility + 启动唯一 5min timer + 立即校正
订阅数 N --其他入口挂载--> N+1: 只订阅，不新增 timer，不立即放大网络请求
订阅数 1 --最后入口卸载--> 0: 停止 timer + 移除 visibility；保留 scope 调度时间
订阅数 0 --入口重新挂载--> 1: 立即查 status；未到 nextOpportunityAt 不查 opportunity
```

- document visible 时 Coordinator 首次立即查询、之后每 5 分钟查询 `/status`；hidden 时停止网络请求，恢复 visible 后立即校正。
- 相同 service + auth session + scope 只有一个周期轮询 owner；`/status` 与 `/opportunity` 仍各自合并 in-flight 请求，手动重置对账可绕过 status freshness 强制刷新。
- 每轮先读取 status。手动核销 processing 或本轮刚发现 completed history 时跳过 opportunity；其他场景（包括某一类型仍持有机会）在共享调度到期后继续做 scope 级判断，避免周机会长期存在时饿死五小时机会。
- `granted=false` 且服务端返回有效 `nextTryAt` 时，保存为该 Coordinator 的 `nextOpportunityAt`；到期前只查 status，不重复触发资格判断。过去时间至少延后 5 分钟，防止机会接口在短时间内重复判断。
- `granted=true` 后绕过 status freshness 强制对账，并至少 10 分钟后再检查 opportunity。
- 服务端未返回有效 `nextTryAt` 时使用 10 分钟兜底；429 使用固定 10 分钟冷却。
- 网络/依赖错误使用固定 5 分钟重试，不做指数退避；重试复用本轮 opportunity 幂等 key，拿到明确业务结果后清除该 key，下一轮资格判断生成新 key。
- `authSessionSeq` 变化时使用新的 Coordinator key，旧登录会话的冷却、幂等 key 与轮询不得泄漏到新登录会话。
- Coordinator 在订阅数归零时停止计时器，但保留 scope 调度状态，避免 HoverCard 关闭后重开立即重复调用 opportunity。
- 手动 `/use` 开始时记录 service + scope 级轨迹及点击前的 `used_at`；新 `used_at` 到达后绑定该完成时间，供 Composer、设置页和 Usage 页共同识别。后续出现不同 `used_at` 时清除旧轨迹，并按自动/运营重置处理。
- LOCAL_PROCESSING 只在 status 返回**不同于点击前基线**的 `used_at`（即上条轨迹绑定到新的完成时间）时进入 COMPLETED。status 仍读到基线 `used_at` 时，即使 `has_unread_history` 仍为 true（上一张的 history/read 尚未生效），也保持 LOCAL_PROCESSING 继续对账；`/use` 后的 4 次对账都未见新 `used_at` 时走失败恢复。Bugfix：旧判定只要求 processing 且 `used_at` 非空。从 COMPLETED(余下 N 张) 再次核销时，基线就是几秒前上一张的 `used_at`，服务端读数稍有滞后，第一次对账就会把旧历史当成本次完成：弹框在服务端确认前播放成功反馈，行内张数停留在消费前快照，再点一次又因轨迹未绑定而被静默忽略，同时再播一次成功反馈。
- 点击重置时若同 service + scope + 类型已存在手动核销轨迹（本窗口其他入口发起），先强制对账：对方 `/use` 仍在进行、或对账后本入口不再 available（额度已被核销），都不再发起第二次 `/use`，避免携带新幂等键的重复核销；对账后仍 available（新机会已发放）才放行为新的一次核销。多窗口与手机 `/remote` 不共享该轨迹，跨窗口并发由服务端按机会核销兜底。
- 手动成功后绕过 freshness，立即刷新 status。
- 发现新的 `used_at` 后，每个 source 只播放一次完成动效，并强制刷新 entitlement/quota。
- 观察到 `has_unread_history` 完成后**立即**上报 history/read，不等待 entitlement 强刷完成（Bugfix：旧实现先 await 秒级的 entitlement 刷新再标记已读，服务端游标清理被拉长，放大了多窗口重复播放窗口；刷新失败也不得阻止已读上报）。

```text
窗口 A Composer              Main BroadcastHub              窗口 B Composer
      | status(T)                    |                             | status(T)
      | 仅写 observation             |                             | 仅写 observation
      | acquire(key=T) ------------->|                             |
      |<-- reservation(token=A) -----|<------------- acquire(key=T)
      |                               |------------- busy(retryable) ->|
      | mounted/source/candidate OK   |                             | 保留 observed_at
      | 本组件进入即将展示边界         |                             | 等 played 或稍后重试
      | commit(token=A) ------------>|                             |
      | 写 played(T) + 广播           |                             |
      | 展示 Tooltip / arm 撒花       |                             |
      |---------------- played(T) ---------------------------------->|
      |                               |                             | 写 played / observed_at=null

窗口 A 在 acquire 等待期间卸载或切换 source
      | acquire(key=T) ------------->|
      |<-- reservation(token=A) -----|
      | mounted/source/candidate 失效 |
      | release(token=A) ----------->|
      |                               | 删除未 commit reservation
      |                               |<------------- 窗口 B 重试 acquire
      |                               |------------- reservation(token=B) ->|
      |                               |                             | commit + played + 展示

非 Composer（设置页 / Usage 页）
      status(T) -> 只写 observation / 完成态 / 额度刷新，不调用 acquire
```

```text
设置页先发现自动完成（同一登录会话）
    status(new used_at) -> Store(entry + auth_session_seq=N)
    Composer 后挂载     -> seq 仍为 N -> 保留 observed_at -> 正常播放

退出后重新登录
    setUser(null) -> setUser(user) -> auth_session_seq=N+1
    Composer/status 读取相同 used_at
        -> Store 记录仍为 N
        -> 静音旧 observed_at，并把观察记录推进到 N+1
    后续 new used_at -> completedAt 不同 -> 正常播放
```

## 错误处理

| 场景                                    | 客户端行为                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| 401                                     | 不展示机会，记录 warn，等待登录/credential 状态恢复                          |
| 400 / code 3001                         | 隐藏错误 scope 的入口，不自动改写 scope                                      |
| 403 / code 3101                         | 提示重置失败，等待账号绑定/credential 修复                                   |
| 429 / code 3002                         | 回到可重试状态，保留本次幂等 key                                             |
| 500 / code 2001/2002/2007               | 回到可重试状态，保留本次幂等 key                                             |
| malformed response                      | 视为协议错误，不进入 completed                                               |
| status 失败                             | 保留上一次已展示状态，后台轮询继续校正                                       |
| opportunity `granted=false` / code 3301 | 保存 `next_try_at`；到时前只查 status，到时后的首次可见轮询使用新 key 再判断 |
| opportunity `2007` / 网络中断 / 超时    | 保留 status；固定 5 分钟后复用本轮幂等 key 重试                              |
| opportunity 429                         | 保留 status；固定冷却 10 分钟，使用新幂等 key                                |
| opportunity 鉴权 / 业务拒绝 / 协议错误  | 保留 status；固定冷却 10 分钟，使用新幂等 key，避免稳定错误高频空轮询        |

非 2xx 响应如果仍携带统一 envelope，客户端必须优先提取 `code` 并转换为稳定错误标识
`coding_plan_reset_api_error:<code>`，不得依赖 `msg` 文案。这样测试环境返回
`HTTP 403 / code=3101` 时，日志和重试判断不会只剩不稳定的 `coding plan is required` 字符串。

## 2026-08-10 测试环境联调记录

旧客户端运行时链路只到达 reset status 接口，status 本身不会发放机会：

```text
renderer
  -> IUsageStatsService RPC
  -> Local Host BigModelUsageQuotaProvider
  -> GET /api/v1/coding-plan/reset/status
  -> code=0, available_five_hour_resets=[]
```

根因是客户端漏调 `POST /opportunity`，后端没有收到资格判断请求，因此 `/status` 一直只能返回空机会。本次修复补齐 opportunity 调用；客户端仍不得回退普通 API Key、个人 key 或本地伪造机会。

日志：

- Service 生命周期/失败使用 `createServiceLogger("usage-stats")`，不得记录 token 或 API key。
- UI 高频轮询细节只使用 `packages/ui/src/logger.ts` 的 `debug`；失败使用 `warn`。

## UI 与响应式

- 复用现有 `Button`、`ControlHintTooltip`、Lucide 图标和 usage chart token。
- 所有字号使用 `text-ui-*`，不增加硬编码主题色。
- processing 时按钮禁用并显示 spinner，防止重复提交；手动流程不显示 processing Tooltip。
- use 成功且 status 返回服务端历史后才播放按钮烟花；按钮成功勾选持续 600ms 后显示“已重置”，手动流程不显示 completed Tooltip，请求失败不撒花。
- 自动/运营重置在 Composer 触发器先合成约 1 秒“正在重置”后切换为常驻“已重置” Tooltip，保留到用户 hover 触发器；hover 展开额度面板时收起 Tooltip，并从面板内重置项位置（同手动位置）补播一次撒花。
- 已重置 hover/focus 显示服务端完成时间。
- 机会总数为 1 时保持紧凑入口：展示“1 次重置额度”和该机会倒计时，额度条旁保留单项“重置”操作。
- Composer 自动展示重置额度机会提醒时，点击提醒触发器或提醒内容保持展示；点击页面其他区域将当前阶段标记为已读并关闭。初始阶段的外部点击不阻止同一机会进入最后三分钟后再次展示紧急提醒。
- 机会总数大于 1 时，合并入口改为可点击的“获得 N 次重置额度”，其中 N 为当前有效机会总数；入口本身不展示倒计时，点击后打开“可重置额度”弹框。设置 Usage 页与 Composer HoverCard 的五小时/周额度标题旁都必须保留各自的“重置”按钮，允许直接核销对应类型，不强制先进入弹框。
- 多机会弹框以当前服务端状态为唯一数据源：标题只保留“可重置额度”文案，不再汇总机会次数；“剩余用量”展示当前五小时、周和工具额度；“可重置额度”只列出当前确实可核销且重置后有收益的 `FIVE_HOUR` / `WEEK` 类型，并分别调用既有 `reset()`。
- 弹框内每个重置项展示该类型最早机会的独立到期倒计时；同一类型持有多张机会时，在该行类型名旁展示“N 次”次数药丸（与徽标一致的确认色），并将倒计时文案标注为“最快 …”以免误读成统一期限，单张不展示药丸、保持原倒计时文案。手动核销仍以 `/use` 后 status 返回不同于点击前基线的新 `used_at` 为成功依据，成功后从点击按钮播放一次撒花，不触发自动/运营重置 Tooltip；成功反馈（600ms）结束时按最新服务端投影决定去留：同类型仍有可核销机会则该行保留，直接展示余下张数与下一张倒计时并恢复「重置」可点击，无需关闭或重开弹框；机会耗尽才收起该行，收起动画期间倒计时行留空，不把空到期渲染成「0 分 0 秒」。弹框不维护本地张数对账。
- Composer HoverCard 打开弹框时保持自身挂载；关闭弹框后再收起 HoverCard，避免 Dialog Portal 因父浮层卸载而瞬间关闭。
- 手机 Web 的弹框宽度不超过 `calc(100vw - 2rem)`；剩余用量卡片纵向排列、按钮可聚焦可点击，不产生横向溢出。
- reduced motion 下跳过撒花和非必要动效。

多机会交互状态：

```text
服务端 status
    |
    +-- 有效机会总数 = 1
    |      └─ 紧凑徽标 + 单机会倒计时
    |             └─ 额度条旁单项“重置” -> 对应 reset(type)
    |
    +-- 有效机会总数 > 1
           ├─ “获得 N 次重置额度”（无入口倒计时）
           │      └─ click
           │          └─ 可重置额度 Dialog
           │              ├─ FIVE_HOUR 行 -> resetUi.reset()
           │              └─ WEEK 行      -> resetUi.week.reset()
           └─ 设置 Usage 页与 Composer HoverCard 的额度标题旁保留直接操作
                  ├─ 五小时“重置” -> resetUi.reset()
                  └─ 周“重置”     -> resetUi.week.reset()

Dialog 中点击重置
    -> POST /use
    -> 强制 status 对账
    -> 服务端 used_at 更新
    -> 按钮成功反馈 + 撒花（不触发自动重置 Tooltip）
    -> 按最新投影决定该行去留
         ├─ 同类型余下 N 张 -> 行保留，展示 N 张与下一张倒计时，按钮恢复「重置」（可直接再次核销）
         └─ 余下 0 张       -> 该行收起（收起期间倒计时行留空）
```

## 验收用例

| ID        | 场景                                                     | 预期                                                                                                                                                                                |
| --------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QR-INT-01 | Personal status 返回 1 个 FIVE_HOUR opportunity          | 三个入口共享显示 1 次机会和到期倒计时                                                                                                                                               |
| QR-INT-02 | Team status 查询                                         | 请求包含 TEAM、organization、project，状态按完整 source key 隔离                                                                                                                    |
| QR-INT-03 | 未订阅套餐                                               | 空机会、空历史，不显示重置入口                                                                                                                                                      |
| QR-INT-04 | 点击重置                                                 | 按钮 processing；不显示 Tooltip；请求体含 FIVE_HOUR 和新幂等 key                                                                                                                    |
| QR-INT-05 | use 依赖失败后重试                                       | 回到可点击状态；重试复用原幂等 key，不撒花                                                                                                                                          |
| QR-INT-06 | use 成功                                                 | 强制刷新 status + entitlement；使用服务端 used_at 完成；按钮显示 600ms 成功勾选并撒花，再显示“已重置”；不显示完成 Tooltip                                                           |
| QR-INT-07 | 自动/运营重置                                            | 轮询发现新 used_at，触发器先合成约 1 秒“正在重置”再切换为常驻“已重置”；hover 触发器后收起提示并从面板内同手动位置补播一次撒花                                                       |
| QR-INT-08 | has_unread_history                                       | 完成状态写入后调用 history/read                                                                                                                                                     |
| QR-INT-09 | 多入口同时挂载                                           | 相同 scope 的 status 请求合并，不出现 3~4 倍请求                                                                                                                                    |
| QR-INT-10 | 机会过期                                                 | 本地倒计时到期后入口隐藏，轮询随后校正                                                                                                                                              |
| QR-INT-11 | 手机 `/remote`                                           | 复用 shared host service；不创建新 runtime，不影响 replayable 恢复                                                                                                                  |
| QR-INT-12 | 中英文/双主题/reduced motion                             | 文案、颜色、交互和动效符合 DESIGN.md                                                                                                                                                |
| QR-INT-13 | 自动重置的 `used_at` 早于轮询发现 5 分钟                  | 首次发现后从 `observed_at` 起算合成“正在重置”→常驻“已重置”；hover 时间仍是服务端 `used_at`；重复 status 不重放合成阶段或补播撒花                                                    |
| QR-INT-14 | HTTP 403 envelope 返回 `code=3101`                       | 客户端错误为 `coding_plan_reset_api_error:3101`，不按 `msg` 分支                                                                                                                    |
| QR-INT-15 | status 无机会、无新历史                                  | 调用 opportunity；`granted=false`/3301 保持隐藏，不弹 toast                                                                                                                         |
| QR-INT-16 | opportunity `granted=true`                               | 立即强制刷新 status，并用返回的有效 FIVE_HOUR opportunity 展示入口                                                                                                                  |
| QR-INT-17 | 四个入口同时挂载同一 scope                               | 同一 auth session + service + scope 只启动一个 5 分钟轮询；首次只发送一次 status/opportunity                                                                                         |
| QR-INT-18 | status 已有单类机会或刚发现 completed history            | 单类机会不阻塞到期后的 scope 判断；本轮刚完成时跳过 opportunity                                                                                                                     |
| QR-INT-19 | opportunity 3301 返回未来 `next_try_at`                  | 保持入口隐藏且不弹 toast；Coordinator 到期前只轮询 status，到期后的首次可见轮询使用新幂等 key 判断                                                                                  |
| QR-INT-20 | 设置页/Usage 页手动重置后 Composer 轮询到新历史          | 所有入口按 service + scope 识别为手动完成；Composer 不显示自动重置 Tooltip，也不从触发器撒花                                                                                        |
| QR-INT-21 | 同窗口另一入口手动核销进行中或刚完成时点击重置           | 强制对账代替第二次 `/use`；不重复核销、不额外消耗机会；新机会发放后的点击照常放行                                                                                                   |
| QR-INT-22 | 设置页先发现自动完成，Composer 在同一登录会话后挂载      | 保留 `observed_at`，Composer 正常播放该次“正在重置→已重置”和撒花，不把共享 Store 误判为旧登录历史                                                                                   |
| QR-INT-23 | 退出后重新登录，status 仍返回相同 `used_at`              | `auth_session_seq` 已变化，旧完成态静音；随后出现不同 `used_at` 时正常播放                                                                                                          |
| QR-INT-24 | 有效机会总数为 1                                         | 三个入口继续展示单机会倒计时；不打开多机会弹框                                                                                                                                      |
| QR-INT-25 | 有效机会总数大于 1                                       | 三个合并入口显示可点击“获得 N 次重置额度”且不显示倒计时；设置 Usage 页与 Composer HoverCard 的五小时/周额度标题旁同时保留对应“重置”按钮，可直接核销或点击合并入口打开弹框           |
| QR-INT-26 | 多机会弹框数据                                           | 标题不汇总次数；同一类型持有多张机会时该行展示“N 次”药丸与“最快”倒计时，单张不展示药丸；只列出有真实额度与有效机会的 FIVE_HOUR/WEEK（含剩余 100%），剩余用量与进度条使用当前 quota  |
| QR-INT-27 | 弹框内点击某类型重置                                     | 先进入确认页、不发请求；取消/返回/Esc 不核销；进入后 500ms 内确认点击被忽略；确认后只调用对应类型 reset，used_at 确认后成功反馈、撒花并收起该项，不触发 Composer 自动重置 Tooltip |
| QR-INT-28 | Composer HoverCard 中打开多机会弹框                      | HoverCard 在 Dialog 打开期间不卸载；弹框可正常交互，关闭后收起 HoverCard                                                                                                            |
| QR-INT-29 | 手机 Web 打开多机会弹框                                  | 宽度不超过视口减 32px，额度卡纵向排列，重置列表可滚动且无横向溢出                                                                                                                   |
| QR-INT-30 | reservation 等待期间 Composer 卸载、切 source 或候选变化 | 不写 played、不广播、不展示；token reservation 被 release（或由 host 注销/TTL 回收），其他仍有效窗口可继续争抢并完成展示                                                            |
| QR-INT-31 | acquire 返回 busy、尚未收到 played 广播                  | 保留 `observed_at` 与候选，不把 busy 当作已播放；临时 reservation 可重试，永久 claim 只等待真实 played/本地 played 游标抑制                                                         |
| QR-INT-32 | HoverCard 关闭后重新打开                                 | 复用原 Coordinator 调度时间；可以立即校正 status，但未到 `next_try_at` 不重复调用 opportunity                                                                                       |
| QR-INT-33 | opportunity 网络/依赖错误后恢复                          | 固定 5 分钟后重试，复用失败请求的幂等 key；明确业务响应后下一轮生成新 key                                                                                                           |
| QR-INT-34 | opportunity 返回 429                                     | 10 分钟内不再请求 opportunity；status 轮询不受影响                                                                                                                                  |
| QR-INT-35 | 退出后重新登录相同 provider/scope                        | `auth_session_seq` 隔离旧 Coordinator，新会话立即执行自己的首次校正                                                                                                                 |
| QR-INT-36 | opportunity 鉴权、业务拒绝或协议错误                     | 10 分钟内不再请求 opportunity；冷却后使用新幂等 key，status 轮询不受影响                                                                                                            |
| QR-INT-37 | 旧入口刷新未完成时 HoverCard 卸载并重挂载                | 新入口立即复用共享 in-flight/cache 完成自己的状态投影，不等待下一次 5 分钟 tick，也不新增 opportunity 请求                                                                           |
| QR-INT-38 | 核销一张后额度剩余 100%，同类型仍有余下机会              | 三个入口继续展示该类型入口与剩余张数（含只剩 1 张的情况），「重置」按钮保持可点击；机会耗尽或全部过期后才隐藏                                                                        |
| QR-INT-39 | 同类型多张机会，弹框内核销一张且不关闭弹框               | 该行立即展示余下张数与下一张倒计时（不出现「0 分 0 秒」），标题旁为可点击「重置」、徽标计入余下张数；再次点击真实发送 `/use` 并完成核销，机会耗尽后该行收起                         |
| QR-INT-40 | 从 COMPLETED(余下 N 张) 再次核销，`/use` 后 status 仍返回上一张的 `used_at`（含 unread 未清） | 保持 processing、不播放成功反馈；读到新 `used_at` 后才完成并按新快照展示余下张数；4 次对账都未见新 `used_at` 时走失败恢复，不静默成功 |
| QR-INT-41 | 确认页中该类型机会失效，之后又重新出现                   | 失效即退回列表；机会恢复后仍停在列表、不发 `/use`；须重新点行内「重置」进入确认页并重走 500ms 防连点（E2E：QR-E2E-16）                                                              |

验证记录（2026-09-28，QR-INT-39）：lib / hook / 弹框 / 标题旁操作新增单测与既有相关单测共 18 个文件 429 项通过。macOS Electron 跑完 `coding-plan-team-usage.test.ts` 全文件 26 项通过、无跳过、无重试（含新增 QR-E2E-14，以及读取弹框状态 helper 调整后的 QR-E2E-03），运行记录 `desktop-e2e-20260928035551264-p84306-4690b59ecaa7b158`。typecheck（含 e2e tsconfig）、lint（0 错误；62 个既有警告不在本次改动行）、`architecture:check --changed` 通过；Windows/Linux 与手机实机未运行。

验证记录（2026-09-30，QR-INT-40）：lib 新增滞后快照用例、hook 新增「读数滞后 2 次（unread 未清 / 已清）」与「4 次对账都滞后走失败恢复」用例，修复前 4 项失败、修复后 lib + hook 共 45 项通过；重置相关 12 个 UI 测试文件 156 项通过。macOS Electron 新增 QR-E2E-15（mock `/use` 结果延迟 600ms 才在 status 可见）：修复前失败，五小时行停在「1 小时 59 分后过期 / 重置」可点击；修复后 `coding-plan-team-usage.test.ts` 全文件 27 项通过、无跳过、无重试，运行记录 `desktop-e2e-20260930-032927-012`。typecheck、lint（0 错误）、`architecture:check --changed` 通过；Windows/Linux 与手机实机未运行。

验证记录（2026-10-29，QR-INT-27 / QR-INT-41）：新增 QR-E2E-16（mock `weekToggle` 切换 WEEK 机会可见性，经 visibilitychange 触发 status 重拉）：修复前失败，WEEK 恢复后弹框自动跳回周额度确认页；修复后 macOS Electron 跑 QR-E2E-03/14/15/16 共 4 项通过，运行记录 `desktop-e2e-20261029123054115-p68343-102636a77ba4028c`。Windows/Linux 与手机实机未运行。

## 联调风险

1. 后端 status 没有 processing 字段；Composer 触发器的“正在重置”为纯前端合成观感（约 1 秒），不代表真实服务端处理阶段，业务判断与额度校正仍只依赖服务端 `used_at`。
2. `/opportunity` 是“触发服务端判断”，不是客户端申请或本地判断；如果后端未来改为定时主动发放，需要同步删除该触发调用。
3. `history/read` 是用户全 scope 共享游标；任一入口上报后会同时清除其他 scope 的 unread，这属于当前后端契约。
4. 如果测试环境 CORS 未放行 `X-Bigmodel-Authorization` 等 header，Web 端会失败；Desktop host 直连不受浏览器 CORS 限制。

## 设置覆盖层中的 Composer 提醒

- 打开设置标签时工作区常驻挂载，但其 Portal 提醒不得穿透设置页。首次机会、临期和重置状态 Tooltip 共用工作区可见性门槛。
- 设置期间暂停 Composer 提醒的外部点击已读监听；隐藏不等于已读，返回工作区后按当前有效机会和原已读状态决定是否显示。设置页自己的机会 Badge/Dialog 不受影响。
- 原因：工作区的 opacity/inert 不作用于挂在 body 的 Tooltip Portal，原显示条件只检查业务状态。复用与 Root 相同的活动设置标签判定，不改变服务请求、重置执行、桌面 continuous 或手机 replayable 链路。
- 回归：扩展 QR-E2E-09/10，首次/临期提醒出现后切设置、点击设置内容、返回工作区；验证设置中浮层消失且未误标已读。单测覆盖设置中机会首次到达、切层不卸载和已读监听恢复。

验证记录（2026-09-11）：新增两条组件回归先失败后通过；相关 19 项单测通过。macOS Electron QR-E2E-09/10 两项通过、无跳过，运行记录 `desktop-e2e-20260911-042939-508`，使用真实设置导航状态验证 Portal 消失、设置点击不误读及返回恢复。typecheck、typecheck:e2e、lint 通过（44 个既有警告）；Windows/Linux 与手机实机未运行，本次不声明整套额度流程覆盖。
