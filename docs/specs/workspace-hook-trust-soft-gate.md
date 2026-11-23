# Workspace Hook Trust 软门禁(Soft Gate)设计

> 状态:已实施。2026-08-13 的持久信任简化由
> [`workspace-hook-trust-persistent-only.md`](./workspace-hook-trust-persistent-only.md) 定义；
> 本文涉及 `allow_once`、`keep_blocked`、独立审核面板与 SessionStart 补跑的旧描述均由该规格取代。

## 1. 第一性原理

从安全与产品的基本公理出发,而不是从现有实现出发:

1. **未信任代码绝不执行。** default-deny 是底线,任何交互设计不得放宽它。
2. **对话不可被安全决策劫持。** 被卡住的用户会为了解锁对话而点"全部信任"——受胁迫的同意不是同意(consent fatigue 反模式)。信任决策必须在无压力的带外场景中做出。
3. **策略改变了行为,就必须可见。** hook 被跳过时,用户必须能在聊天现场看到"为什么没生效"以及"去哪里处理"。
4. **信任是异步行为,作用于未来,不回溯解锁过去。** 不存在"turn 停下来等审核结果再继续"的语义。
5. **执行点复杂度留在准入层。** 不把安全状态机扩散到协议 RPC、队列、UI 跳转等远端层次。

由公理 2+4 推出:**turn 永不停等审核**;由公理 1 推出:**pending hook 本轮直接跳过(blocked)**;由公理 3 推出:**composer 图标提醒 + 一键去审核**;由公理 5 推出:**删除 parked-turn 全套协议机制**。

## 2. 行为对比

```
旧(硬门禁):
  user prompt ──ACK──> turn 停在 activate() ──强制打开 Settings/Hooks──> 用户被迫决策
                        │                                                    │
                        └──── 10min watchdog / turnStartTimeout（超时不写 Trust） ────┘
                        (审核完成后 turn 才继续;用户被丢在设置页)

新(软门禁):
  user prompt ──ACK──> turn 立即执行,pending hooks 一律跳过(HookRunBlocked)
                        │
                        └─> 事件: WorkspaceHookAdmissionUpdated { pendingCount>0 }
                              └─> snapshot.workspaceHookAdmission
                                    └─> composer 权限右侧 Hook 图标 + 未读点 → 点击浮层 [N 个 Hook 待审核] [去审核] [忽略]
                                          └─(用户主动点击)─> requestWorkspaceHookReview
                                                └─> controller 开 review flow(受 supervisor 监管)
                                                      └─> Settings/Hooks 未信任行显示[信任]
                                                            └─> exact persistent trust 落盘,revision bump
                                                                  └─> 只影响未来自然发生的 Hook event
```

时序(信任生效链路,涉及状态同步,按规范画图):

```
Renderer                     V4 Server(bootstrap)                Core Runtime
   │                              │                                   │
   │ prompt #1                    │                                   │
   ├─────────────────────────────>│ startPromptTurn                   │
   │                              ├──────────────────────────────────>│ activate(): pending → skip
   │                              │        WorkspaceHookAdmission     │ 记录 skippedSessionStart
   │<── snapshot{pendingCount:2} ─┤<──────── Updated(2) ──────────────┤ + securityRevision R1
   │ [Hook 图标出现]               │                                   │ turn 正常执行(无 hooks)
   │                              │                                   │
   │ 点击[去审核]                  │                                   │
   ├─ requestWorkspaceHookReview >│ openReviewFlow + supervise        │
   │<── ReviewRequested ──────────┤                                   │
   │ 行内点击[信任]                 │                                   │
   ├─ respondWorkspaceHookReview >│ exact grant → 落盘 → revision R2  │
   │<── ReviewSettled ────────────┤                                   │
   │<── snapshot{pendingCount:0} ─┤<──── AdmissionUpdated(0) ─────────┤
   │ [Hook 图标消失]               │                                   │
   │ prompt #2                    │                                   │
   ├─────────────────────────────>│ startPromptTurn                   │
   │                              ├──────────────────────────────────>│ 不补跑旧 SessionStart
   │                              │                                   │ 仅后续自然事件使用新 Trust
```

## 3. 设计决策

### D1. 准入层:pending 即跳过,不再开 flow、不再等待(core)

`workspace-hook-runtime-admission.ts`:

- 删除 `reviewPendingSnapshot()` 及其在 `activate()` 中的调用、`reviewActivation` 状态、`review` port 的等待用途。
- pending 声明的运行时语义与既有 headless 路径**完全一致**:runner 逐条发 `HookRunBlocked`(`errorCode: workspace_hooks_pending_trust`),turn 照常执行。桌面与 headless 语义合流,不再有分叉。
- `activate()` 计算 pending 快照后,通过新 port 上报 `{ pendingCount, bundleDigest, workspaceIdentity }`(见 D2)。
- `waitForWorkspaceHookAdmission` 保留(trust-store bootstrap 仍需要),仅删除 review 等待的调用点。
- fail-closed 路径(`bootstrapFailed` / `invalidatedReason`)语义不变。

### D2. 会话级状态载体:snapshot 附加字段(shared + bootstrap)

- `conversationSnapshotSchema` 新增 additive 字段(**必须带 `default: null`**,遵守 snapshot.ts 冻结规则):

  ```ts
  workspaceHookAdmission: {
    pendingCount: number;      // configuredEnabled && admissionClass === "pending" 的声明数
    bundleDigest: string;      // 图标已读 / 忽略的幂等 key
    workspaceIdentity?: string;
  } | null
  ```

- 新会话事件 `WorkspaceHookAdmissionUpdated`(与 `WorkspaceHookReviewRequested/Settled/Superseded` 同族),投影层据此写入/清空 snapshot 字段(`pendingCount === 0` → 置 null)。
- 触发点:
  1. `activate()`(startup / resume)完成评估后;
  2. exact persistent trust 后,由 controller 重新评估并发布;
  3. toggle 重建 bundle、revoke 之后同理。
- **不用** `pendingInteractions` 承载 admission(它是"阻塞性"的 load-bearing 语义:隐藏 composer、压 spinner、通知、侧栏);`hooksService.loadHooks` 仅用于 Settings 静态持久 Trust 视图。snapshot 走 V4 协议,桌面/Web 远控天然同源,满足多端约束。

### D3. 按需开审核 flow:新命令 `requestWorkspaceHookReview`(shared + bootstrap)

- 命令 shape 克隆 `revokeWorkspaceHookTrust` 的 non-flow target 变体(`sessionId + workspaceIdentity + bundleDigest`,无 interactionId)。
- Handler → controller 现成的 `openReviewFlowForNewPendingItems(getCurrentSnapshot())`;已有活跃 flow 时复用(`openOrReuseFlow` 幂等)。
- **必须走 `superviseFlow`**——否则重蹈"撤销后面板永久失效"UAT bug(见 `workspace-hook-review-supervisor.ts` 头注)。
- flow deadline 只使 immutable request 过期并发送 `ReviewSettled(timed_out)`；不创建 Trust、
  不写负向决定，也不清除 admission pending。用户可从图标浮层重新请求新 generation。

### D4. UI: composer Hook 图标提醒 + 点击浮层（2026-10-26）

- `WorkspaceHookPendingIndicator` 放在 `ConversationComposer` 权限选择器紧右侧、CUA 入口左侧；移除 composer 上方的常驻横幅。
- 唯一业务数据源仍为 `snapshot.workspaceHookAdmission`。仅实际会话 `pendingCount > 0` 且当前 `sessionId + bundleDigest` 未忽略时显示图标；草稿、无 pending、只读会话不显示。
- 图标复用设置页 Hooks 的 `Anchor`，使用 composer 标准 28px 图标按钮。右上角 Sky 色圆点表示未读，复用 `workspace-admission-unread` token（浅色 sky-500、深色 sky-400），不随黑白品牌色变化；按钮使用本地化名称和 pending 描述，不能只靠颜色传达提醒。
- 点击、Enter/Space 或触摸打开图标上方的轻量 Popover（产品表现为可点击的 tooltip）。浮层包含原文案、原“去审核”和“忽略”按钮；hover 不自动展开。Esc、外部点击或再次点击图标关闭，关闭后仍可重开。
- 首次展开即标记当前 `sessionId + bundleDigest` 已读，圆点消失，图标保留。已读/忽略共用 renderer 内存状态，切换会话后返回仍保留，刷新后重置；bundle 变化重新未读。业务 admission 和 Trust 不受已读影响。
- 浮层展开状态仅归当前组件；会话或 bundle 变化时关闭，避免旧浮层自动展示新内容。snapshot pending 归零后图标和浮层一起移除。
- [去审核] 关闭浮层，继续 `setPendingSettingsSectionIntent("hooks")` + `openSettingsTab()` + 现有 command binding 的 `requestWorkspaceHookReview`；命令失败继续既有 warn 记录，不增加重试或定时同步。
- [忽略] 关闭浮层并隐藏当前 key 的图标，不写 Trust；后续新 bundle / 新会话重新提醒。
- Popover 使用现有主题 token 和共享组件；窄屏限制在 viewport 内，文案换行，两个操作始终可达。支持中英文、Zai Light/Dark、desktop 与手机 Web 共享 composer。
- `workspaceHookReview` 继续不阻塞 composer、不自动跳转设置。Settings 仍仅逐条持久信任；不新增审核操作或改变 Hook 执行规则。

```text
Runtime admission → V4 snapshot → Composer Hook 图标
                      │                 │ 点击
                      │                 v
                      │       renderer 已读 + 打开浮层
                      │          ├─ 去审核 → 既有 review 命令 → Hooks 设置
                      │          └─ 忽略 → renderer 隐藏当前 session+bundle
                      └─ pending=0 → 图标与浮层移除

desktop continuous / mobile replayable → 同一 snapshot 语义
renderer 已读、忽略、浮层开关不参与远端 Trust 同步
```

验收扩展既有 HK05–HK07：权限右邻位置、无旧横幅、首次未读、打开即已读、关闭重开、键盘退出、去审核、忽略不写 Trust、新会话重新未读、pending 清零移除。桌面/窄屏、中英文和两主题验证浮层不越界；真实手机远控链路单独记录验证边界。pending 清零、bundle 变化和会话已读隔离由共享组件的真实 Chromium 验收补足：

```bash
node --test packages/ui/test/browser/manual-review/pending/workspace-hook-pending.test.mjs
```

2026-10-26：Desktop Hook Trust E2E 3/3、Chromium 桌面/触摸验收 8/8 通过，覆盖中英文和两主题；完整记录见 `docs/testing/conversation-session-e2e-coverage-matrix.md` HK05–HK07。

### D5. SessionStart 不补跑(core)

- 第一次真实 SessionStart 到达时，未信任声明被跳过，该事件即结束。
- 后续 prompt 不得把已结束的 SessionStart 伪装成 catch-up 再执行。
- 当前 task 中建立的 Trust 只影响后续自然事件；SessionStart 最早在下一新 task/session 生效。
- 删除 skipped digest、revision-at-skip 与 catch-up filter 状态，避免信任动作反向触发历史代码执行。

### D6. 协议层删除清单(bootstrap)

parked turn 消失后,以下机制整体退役(近期 deadlock/超时监管 bug 的高发区):

| 位置                | 删除内容                                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt-turn.ts`    | review observer 全套(`workspaceHookReviewProgress`、deferred/waiters、`observeWorkspaceHookReview` 等)、early-ACK 分支(`requestAuthority: "workspace_hook_review"`)、`monitorTurnStartedAfterWorkspaceHookReview`、`admittableHookTimeoutMs` 延时、`WORKSPACE_HOOK_REVIEW_SETTLE_GRACE_MS`、相关类型与头注双权威条款 |
| `prompt-turn.ts`    | `observeAcknowledgedPromptInputFailure`(review-only,3 个 call site 一并清理)                                                                                                                                                                                                                                         |
| `handlers/queue.ts` | `finalizeReviewedQueuePromotion` review 分支(确认无其他 caller 后删)                                                                                                                                                                                                                                                 |

保留:review flow/controller/supervisor(按需生成 immutable 操作快照)、`WorkspaceHookReviewRequested/Settled/Superseded` 事件与投影。删除独立 panel、once/user-block 分支；flow timeout 只使快照过期。

### D7. 兼容性

- snapshot 字段 additive + default → 旧 client 解析不受影响。
- `requestWorkspaceHookReview` 仅由新 UI 发送,桌面端 server 与 UI 同版本捆绑,无需新增 capability 协商;`workspaceHookReview` capability 保持原样。
- headless CLI 行为不变(本来就是 skip + 诊断);desktop 与其语义合流。
- web-remote:图标数据源为 V4 snapshot,replayable 链路天然携带;不触碰 stream/queue/blocking request 语义。

## 4. 测试计划(先写测试)

- **core**:admission skip 语义(pending → 不等待、port 上报 pendingCount);SessionStart 在 Trust 变化后也不补跑——回归测试。
- **shared**:snapshot 字段 default 解析;`requestWorkspaceHookReview` schema。
- **bootstrap**:命令 handler(幂等复用 flow、必受 supervise);settle/toggle/revoke 后 `WorkspaceHookAdmissionUpdated` 重算;投影写入/清空 snapshot 字段;prompt-turn 不再 park(改写 `v4-native-commands.test.ts:968` 起五案、`v4-native-queue.test.ts` 三案为"直接 TurnStarted + AdmissionUpdated")。
- **ui**:图标与浮层显隐、已读/忽略幂等 key、去审核动作；Hook 行只在未信任且有匹配 generation 时显示“信任”，成功后刷新消失；旧 panel/状态徽章不渲染；i18n zh/en parity。
- 手册:`docs/testing/workspace-hook-trust-manual-acceptance.md` §1 重写为软门禁验收。

## 5. 明确不做(本期)

- 会话创建时(首个 prompt 之前)即推送 pendingCount——首次评估仍发生在 activate();图标最早出现于第一条消息之后,与旧行为的拦截时点一致。
- 批量选择、全选和设置页内撤销入口。
- 区分"本地刚编辑的 hook"与"仓库带来的 hook"的差异化确认。
