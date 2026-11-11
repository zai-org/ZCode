# Goal State Reminder Implementation Plan

> **For agentic workers:** 使用 `executing-plans` 按 phase 执行；每个 phase 完成单测和 review 后再进入下一 phase。本计划不依赖 subagent 执行。

**Goal:** 移除 `target_continuation` 的 projection-time filter，并通过持久化、MCS-capable 的 goal state reminder 让模型稳定感知 `/goal pause|clear|resume` 状态变化。普通 `/goal set|replace` 由真实 user objective 表达，不重复写 state reminder；若 replace 同时造成 `paused -> active`，仍追加一次 resume reminder。

**Architecture:** 把 goal continuation 和 goal state change 都作为 append-only provider-visible history 事实。`target_continuation` 不再靠过滤隐藏；后续 goal pause/clear/resume 通过新的 persisted system reminder source 覆盖旧 continuation 语义。`/goal set|replace` 依靠真实 user objective 表达新目标；只有从 paused 状态重新变为 active 时才追加 active-again reminder。支持 MCS 的 provider 投成 mid-conversation `system`，否则 fallback 为 `<system-reminder>` user message。若 pause 发生在 active regular turn，target DB 与 `target_changed` 仍在发起该操作的 command mutation 内完成，并且早于 abort；只有 reminder 延迟到 cancelled tool results 全部持久化并进入 live history 后、turn terminal event 前物化。idle 状态变化仍立即物化。

**Tech Stack:** TypeScript, Vitest, zcode-cli runtime message history, session store hydration, provider request projection.

## Global Constraints

- 不做过度设计，不引入新的全局状态机。
- 不靠 projection filter 修正历史；目标是 append-only provider-visible history。
- 不靠 provider projection 重排修复 active-turn goal reminder 的写入时机。
- 新 reminder 必须持久化，冷恢复后仍可进入 provider history。
- 新 reminder 必须支持 MCS；不支持 MCS 时自然 fallback。
- `target_continuation` 继续代表 goal continuation，不再被普通请求过滤。
- UI-facing snapshot 仍不应把 model-only synthetic notice 渲染成普通用户气泡。
- 每个 phase 先补失败单测，再实现，再跑相关测试。

---

## Phase 1: 新增 Goal State Change Reminder Source

**目标:** 增加一个专门表达 goal 状态变化的 persisted + MCS-capable system reminder source。

**Files:**
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/system-reminder/source.ts`
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/tests/runtime-provider-request-messages.test.ts` 或现有 provider projection 测试文件

**Checklist:**
- [x] 新增 source：`goal_state_change`
- [x] 加入 `SYSTEM_REMINDER_PERSISTED_SOURCES`
- [x] descriptor 使用 meta/provider-visible，建议 `descriptor("mid_turn_event", "mid_turn_event", true, "sr.goal_state_change")`
- [x] 不加入 `NON_MID_CONVERSATION_SYSTEM_SOURCES`
- [x] hydrate 时 synthetic notice 可恢复成 `messageHistory.addAttachment("goal_state_change", body)`
- [x] provider projection 在 MCS capable 时输出 mid-conversation system
- [x] provider projection 在非 MCS 时 fallback 为 `<system-reminder>`

**Suggested Tests:**
- [x] `hydrates persisted goal_state_change synthetic notice as runtime attachment`
- [x] `projects goal_state_change as mid-conversation system when MCS is supported`
- [x] `falls back goal_state_change to system-reminder user message when MCS is unsupported`

**Pass Criteria:**
- [x] 单测证明 `goal_state_change` 可持久化恢复
- [x] 单测证明 MCS/fallback 两条 provider-visible 路径正确
- [x] 不影响现有 `resume_goal_state`、`todo_reminder`、`queued_system_notification`

---

## Phase 2: 持久化 Goal 状态变化 Reminder

**目标:** 在 `/goal pause|clear|resume` 发生时追加 model-only synthetic notice，表达最新 goal 状态。`set|replace` 的目标正文已经是真实 user message，不再重复写 reminder。

**Files:**
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` 如需要补 protocol 边界行为
- Add: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/runtime/methods/goal-state-reminder.ts`
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/runtime/internal-methods.ts` 如需要新增 runtime helper
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` 如需要声明 helper
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/bootstrap/tests/session-persistence.test.ts`
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

**Reminder 文案建议:**
- pause:
  `The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.`
- resume:
  `The session goal is active again and will be pursued.`
- clear:
  `The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.`

**Checklist:**
- [x] 新增小 helper，例如 `persistGoalStateChangeReminder(...)`
- [x] helper 内部调用 `persistSyntheticUserNoticeForSession({ source: "goal_state_change", visibility: "model-only" })`
- [x] idle 状态变化同步写入 `messageHistory.addAttachment("goal_state_change", body)`，保证当前 runtime 立即可见
- [x] active regular turn 中只暂存一条 turn-local reminder，在 cancelled tool results 闭合后、terminal event 前写入 history 与 session store
- [x] `/goal pause` 成功时写 pause reminder
- [x] `/goal clear` 成功或显式 clear 时写 clear reminder
- [x] `/goal resume` 成功时写 resume reminder
- [x] `/goal set` 成功时只写真实 user objective，不写 state reminder
- [x] `/goal replace` 写真实 user objective；仅当旧目标为 paused、replace 造成 `paused -> active` 时再写 resume reminder
- [x] no-op 场景不写 misleading reminder，例如 “No goal to pause/resume”

**Pass Criteria:**
- [x] pause 后退出恢复，provider history 含 pause reminder
- [x] clear 后退出恢复，provider history 含 clear reminder
- [x] replace 后 provider history 保留旧 continuation，并追加新的真实 user objective；paused replace 之后再追加 resume reminder
- [x] UI 不出现普通用户气泡

---

## Phase 3: 移除 target_continuation Projection Filter

**目标:** 删除普通请求过滤 `target_continuation` 的特殊逻辑，让 goal continuation 成为稳定 history 事实。

**Files:**
- Modify: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.ts`
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Checklist:**
- [x] 删除 `includeTargetContinuationReminders` 分支过滤
- [x] 删除 `withoutTargetContinuationReminderEntries`
- [x] 清理 `includeTargetContinuationReminders` 参数，如无其它用途
- [x] 更新旧测试 `filters stopped target continuation reminders from following user turns`
- [x] 新测试改成：follow-up request 保留旧 continuation，但其后有 pause/clear reminder 覆盖语义；replace 依靠新的真实 user objective 覆盖语义
- [x] 确认 goal continuation 当前 turn 仍包含 continuation prompt

**Pass Criteria:**
- [x] 没有 projection-time 删除 `target_continuation`
- [x] provider-visible history append-only
- [x] pause/clear/replace 后普通 user prompt 不会被旧 continuation 误导，因为后续 state reminder 更晚且 authoritative

---

## Phase 4: Goal 更新与 Race 回归

**目标:** 确认 pause/replace/clear 与正在运行的 verifier/continuation 不会串目标。

**Files:**
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

**Checklist:**
- [x] verifier 返回期间用户 replace goal：旧 targetID 不继续，新 targetID 继续
- [x] continuation 排队期间用户 pause：队列执行时读到 paused，不继续
- [x] background notification 后 goal verifier 之前用户 clear：不再 verifier 旧 goal
- [x] `/goal pause` abort active turn 后，cancelled tool results 先于 pause reminder 进入 history 与 session store
- [x] `/goal resume` 后，history 有 resume reminder，并触发 continuation loop

**Pass Criteria:**
- [x] 所有 race case 都以 session target 权威状态为准
- [x] 没有 stale objective 被当作 active goal 继续执行
- [x] command queue 顺序不被绕过

### 2026-07-12 Stop / Tool Result Ordering Bugfix

- [x] regular model/tool loop 中记录 pause 时不立即写入 `messageHistory` 或 synthetic notice
- [x] turn-local pending reminder 不引入 cursor、history 扫描、target DB 回读、CAS 或 compact/rewind 耦合
- [x] cancelled tool result 的 part 持久化和 `messageHistory.addToolResult(...)` 均完成后才物化 reminder
- [x] reminder 物化发生在 success/cancel/error terminal event 之前，避免 terminal race 丢失正常收尾的状态变化
- [x] idle pause/resume/clear 保持立即物化；重复状态变化仍不写重复 reminder
- [x] Stop -> turn finalization -> Resume 保留 pause 与 resume 两条 append-only reminder，不做 request-boundary coalescing
- [x] hard crash 前未 flush 的 transition reminder 允许缺失；权威 target DB 与 cold-resume current-state reminder 继续保证 paused 状态恢复
- [x] pending reminder 物化失败时记录 warning 并继续 terminal；权威 target 与 `target_changed` 已落库，不增加 retry/cursor

#### Review regression locks

- [x] Stop 发生在 assistant `tool_use` 已进入 history、tool handler 尚未启动时，仍先合成并持久化 cancelled `tool_result`，再物化 pause reminder
- [x] Stop 发生在 file-mutation checkpoint 期间时，checkpoint cancellation 不截断后续 sibling `tool_result` 的 DB 与 live-history 闭合
- [x] reminder deferral 仅覆盖 `runRegularTurnLoop`，并由 loop 外层唯一的 `finally` 同步关闭后物化 pending
- [x] Stop 发生在最后一次 reminder drain 之后、`TurnComplete` 真正持久化之前时，pause reminder 不丢失，并且仍早于 terminal event 物化
- [x] 三个竞态时序均使用确定性同步点编写回归测试，不依赖 sleep 或概率性竞态

#### Integration impact audit

- [x] producer 顺序保持为 target store -> pending/immediate reminder -> `target_changed`；`/goal pause` 与 `session/stop` 在 command mutation 完成后才 abort
- [x] deferral 只属于 regular model/tool loop；idle、manual compact、rewind 和 loop 关闭后的 late pause 保持立即物化
- [x] Stop 前尚未启动的 tool handler 不执行，但已经进入 history 的每个 `tool_use` 都会得到 cancelled result
- [x] checkpoint cancellation 延迟抛出到 sibling results 全部写入 DB 与 live history 之后；非 cancellation checkpoint 行为不变
- [x] synthetic persistence、cold hydration、compact selection、MCS/fallback projection 与 UI model-only 过滤均复用既有通路
- [x] protocol active controller 在 `sendInput` 完成 finalization 后才释放，下一条 desktop/remote host prompt 不能越过 tool result 或 reminder
- [x] compact/rewind、renderer queue、`clientMode`、`deliveryKind`、workspace identity 和远控 owner/lease 均无生产代码改动

---

## Phase 5: Visible Content / UI / Compact 回归

**目标:** 确认新 synthetic reminder 对 UI、visible content、compact、session context 没有副作用。

**Files:**
- Modify if needed: `/Users/dev/Desktop/Z/z-code/packages/shared/src/zcode-session-visible-content.ts`
- Modify if needed: `/Users/dev/Desktop/Z/z-code/packages/ui/src/lib/zcodeChatMessages.ts`
- Test: `/Users/dev/Desktop/Z/z-code/packages/shared/test/zcodeSessionVisibleContent.test.ts`
- Test: `/Users/dev/Desktop/Z/z-code/packages/ui/test/zcodeSessionProjection.test.ts`
- Test: `/Users/dev/Desktop/Z/z-code/apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`

**Checklist:**
- [x] `goal_state_change` model-only synthetic notice 不显示为普通 user bubble
- [x] transcript/debug/history 中仍可追踪 raw notice
- [x] compact 后 provider-visible goal state change 不丢失
- [x] session context/read-session-context 不把 model-only reminder 当真实用户输入摘要
- [x] non-incremental diff 中不再因为过滤 `target_continuation` 改变 assistant 邻接关系

**Pass Criteria:**
- [x] UI 快照无新增可见噪声
- [x] compact/resume 后模型仍能看到最近 goal 状态变化
- [x] trajectory 转换不再因为 `target_continuation` filter 产生对应 non-incremental diff

---

## Phase 6: Final Verification

**Commands:**
- [x] `pnpm --dir apps/zcode-cli exec vitest packages/core/tests/runtime-tool-loop.test.ts --run`
  - 2026-07-12 全量 129 条通过，包含调度前、checkpoint 期间和 terminal 持久化窗口三个确定性 Stop 竞态。
- [x] `pnpm --dir apps/zcode-cli exec vitest packages/core/tests/session-history-hydrator.test.ts packages/core/tests/provider-request-messages.test.ts --run`
  - 2026-07-12 共 51 条通过，覆盖 cold hydration、MCS system 与 legacy fallback。
- [x] `pnpm --dir apps/zcode-cli exec vitest packages/bootstrap/tests/session-persistence.test.ts --run -t 'persists model-only goal state change reminders for goal lifecycle changes|persists replacement goal objective as real user prompt without state reminders'`
  - 2026-07-12 focused 2 条通过。
- [ ] `pnpm --dir apps/zcode-cli exec vitest packages/bootstrap/tests/session-persistence.test.ts --run`
  - 2026-07-12 全量仍有 12 个既有 system-prompt/shell/tool fixture 预期失败；本改动相关的 goal lifecycle focused 用例通过。
- [x] `pnpm --dir apps/zcode-cli exec vitest packages/bootstrap/tests/zcode-protocol.test.ts --run`
- [x] `pnpm --dir apps/zcode-cli exec vitest packages/bootstrap/tests/zcode-protocol.test.ts --run -t 'allows session goal pause to stop a running prompt|pauses an active goal when session stop cancels goal continuation'`
  - 2026-07-12 focused 2 条通过，覆盖 `/goal pause` 与 Generic Stop 两个上游入口。
- [x] `pnpm exec vitest packages/shared/test/zcodeSessionVisibleContent.test.ts --run`
- [x] `pnpm exec vitest packages/ui/test/zcodeSessionProjection.test.ts --run`
  - 2026-07-12 两个文件合计 108 条通过，model-only reminder 未变成可见 user bubble。
- [x] `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/execution/conversation-session-stop-empty.test.ts'`
  - 2026-07-12 B12 等 2 条通过；tool call 运行中 Stop 且 queue=0 后，下一条普通消息立即发起并完成。
- [x] `pnpm --filter @zcode/desktop typecheck:e2e`
- [x] `pnpm typecheck`
- [x] `pnpm --dir apps/zcode-cli typecheck`
- [x] `pnpm lint`
  - 根仓库 lint 通过（75 个既有 warning、0 error）；本次所有变更 TypeScript 文件的 targeted oxlint 通过。`apps/zcode-cli` 全量 lint 仍被既有 max-lines/unused 基线阻断。

**Manual / Evidence Checks:**
- [ ] 创建 goal，跑出一次 continuation
- [ ] pause goal，退出恢复，检查 provider-visible request 含 pause reminder
- [ ] replace goal，检查旧 continuation 后有新的真实 user objective
- [ ] clear goal，检查后续 prompt 不继续旧 goal
- [ ] MCS-capable provider 下检查 role 为 `system`
- [ ] 非 MCS provider 下检查 fallback 为 `<system-reminder>`

**Done Definition:**
- [x] `target_continuation` 不再被 projection filter 删除
- [x] goal state change 是持久化、MCS-capable、model-only synthetic notice
- [x] pause/clear/resume 都有 provider-visible 状态转折；set/replace 通过真实 user objective 进入 provider-visible history，paused -> active 的 replace 额外写 active-again reminder
- [x] 冷恢复后模型仍能感知最近 goal 状态
- [x] UI 不新增普通用户气泡
- [x] 本次范围测试通过，且无 unrelated refactor
