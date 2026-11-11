# WSL 任务状态不一致：根因分析与修复方案

日期：2026-08-21（T1/T2）、2026-09-04（T3） ｜ 状态：分析与修复完成 ｜ 分支：`fix/wsl-status`

## 用户症状

WSL 连接项目时，左侧任务栏与聊天区的任务运行状态持续不一致，双向都出现过：

- 症状①：任务列表在转圈（loading），聊天区任务已结束；
- 症状②：任务列表没有转圈，聊天区任务仍在进行中。

事发环境：ZCode 3.9.0（commit cb07e825，Windows 11，production），workspace `remote:wsl:default:/home/dev`。
证据材料：用户日志 bundle `zcode-logs-20260821-202010-wsl-status`（含 4 天桌面日志、Windows 侧 CLI 日志、tasks-index.sqlite）。

## 结论

**probable（根因机制已确认）**。左侧任务栏与聊天区来自同一份 CLI 权威状态的**两条独立订阅链路**
（sessions-index topic vs conversation topic），分叉发生在发布门禁 / 传输 / 恢复层，
由两处违反"已声明不变量"的实现 bug 固化成持续不一致：

1. **消费侧（T1）**：renderer `SessionsIndexStore` 进入 `status="error"` 后保留旧投影、
   消费方不检查 status、且 error 是无自愈终态——旧 `phase=running` 无 live 证明却继续渲染转圈；
   订阅死亡后新 turn 的 running 帧也永远到不了。
2. **权威侧（T2）**：CLI 网关在无订阅者窗口用 `hasSubscribers()` 门禁静默丢弃 phase 迁移，
   且重订阅命中已存在 publisher 时不重放 live 投影种子——之后任何 subscribe/resync
   拿到的 snapshot phase 停留旧值。

聊天区没有这两个缺陷（conversation store 每次打开会话全新建立；hydration 把未收口 turn
强制合成 `TurnComplete(cancelled)` 收口），所以两个 surface 分道扬镳。WSL 场景高频触发
进入条件：事发当天 WSL Agent CLI 换代 3 次（用户重开工作区即硬杀重启）、sessions-index
订阅抖动 7 轮（19:33–19:36）、同传输栈 SSH 桥 ECONNRESET 1 次。

判级为 probable 而非 confirmed 的唯一原因：生产构建下 renderer 全部日志是 no-op
（`packages/ui/src/logger.ts:38`），截图时刻两个 store 的状态序列无法回放。

## 被违反的不变量（均为代码/spec 已声明）

- "任务列表的 loading 必须由当前 runtime 明确证明"
  （`packages/ui/src/lib/taskListItemPresentation.ts:28` 注释；
  `packages/ui/src/v4/sessionsIndexStore.ts:585` dormant 分支注释）。
- "断线按 snapshot 恢复 / 冷订阅用当前在册 live projection 覆盖"
  （`docs/v4-refactor/14-sessions-index.md:15,54`）。
- "CLI runtime restart 时现有 listener 收到 restart 信号后，各活跃 store 恰好 full re-subscribe 一次"
  （`docs/v4-refactor/04-sync-and-recovery.md:204,215-216`）。

## 因果链与事件序

```
触发：WSL 桥抖动 / 用户重开 WSL 工作区（CLI 换代）
   │
   ▼
T1（消费侧）：resync/recovery 在抖动窗口失败
   → failRecovery() 只置 status="error"，不清投影、不重试
     （sessionsIndexStore.ts:522-527；resync 失败同 :459-468；
      handleFrame 永不把 status 改回 live）
   → 旧 phase=running 无 live 证明却继续存在
   │
T2（权威侧）：无订阅者窗口内 TurnStarted/TurnComplete 被门禁丢弃
     （v4-gateway.ts:816），重订阅走 existing 分支不重放 live 种子
     （v4-gateway.ts:932-940）
   → 之后任何 snapshot 停留旧 phase
   │
   ▼
下游症状：useWorkspaceSessionsIndexItems 无条件消费 store.getSessions()
     （useWorkspaceSessionsIndexItems.ts:177-191，不查 status）
   → 陈旧 running → 转圈（症状①）；订阅已死则新 running 不可见（症状②）；
     聊天区经独立 conversation 订阅 + hydration 自愈显示真值 → 持续不一致
```

```
当前：
CLI(WSL)              renderer sessionsIndexStore           任务列表      聊天区
  │ TurnStarted ──▶     live, phase=running                  转圈 ●       流式中
  ✕ 桥抖动/换代: resync 失败 / recovery 超时
  │                     failRecovery → status=error
  │                     （保留旧 running，无重试）             转圈 ●(陈旧)
  │ TurnComplete ──▶ (订阅已死或门禁丢弃，帧不达)
  │                     error=终态，永不收敛                   转圈 ●(永久)  已结束 ←→ 不一致

修复后：
  ✕ 同样的失败
  │                     failRecovery → status=error + 清空投影  无转圈（不宣称无证明状态）
  │                     有界退避 fresh subscribe（forceSnapshot）
  │  ◀── subscribe ──   snapshot = 权威当前值（R-B 保证归约态新鲜）
  │                     status=live, phase=真值                与聊天区一致 ✓
```

## 事发日志事件链（本地时间 UTC+8，2026-08-21）

```
17:35:22  连接 WSL(target=wsl:Ubuntu:dev) → WSL 内 remote host pid 1061
17:35:42  Agent CLI gen1 启动 (pid 1094)
18:05:48  [同传输栈 SSH 连接] read ECONNRESET（桥式连接确实会断，log:15098）
18:53:23  用户重开 WSL 工作区 → gen1 被杀 (log:25108) → 18:53:34 gen2 (pid 15160)
19:32:20  再次重开 → gen2 被杀，turn 未收口 (log:28225)
          → 持久化状态停留 running+activeTurnId（分叉温床）
19:32:33  gen3 启动 (pid 15402)
19:33:24  sess_5f6c01d1 readSession 快照 = sessionStatus:'running',
          activeTurnId:turn_60441ab9 残留实锤 (log:28667,28673,28677)
19:33-19:36  sessions-index 订阅抖动 7 轮（subscribe→数秒后 unsubscribe 循环）
19:48-19:53  app 整体重启
20:19:52  第 5 次连接 WSL (log:35050) → 20:20:02 remote host(818) + agent 再换代
20:19:58  用户导出日志（bundle 截止 20:20:10）
```

红信号脚本（只读断言，连续两次运行一致 CONFIRMED）：
`A1(agent gen2 退出)=1  A2(gen3 启动)=1  A3(running+activeTurn 残留快照)=1  B(renderer 日志行)=0  C(远程桥断连)=1  D(WSL 手动重连)=5`

## 关键证据索引

| #   | 事实                                                                                   | 位置                                                                                                 |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | 列表 spinner 只采信 sessions-index 实时 phase，持久化 status 不采信                    | `packages/ui/src/v4/taskListRowActivity.ts:35`、`packages/ui/src/lib/taskListItemPresentation.ts:24` |
| 2   | error 态保留旧投影且无出口；dormant 分支才正确清空                                     | `packages/ui/src/v4/sessionsIndexStore.ts:522-527,459-468`（对照 :585-590）                          |
| 3   | 消费方不查 status，error 排除在 hydrating 外                                           | `packages/ui/src/v4/useWorkspaceSessionsIndexItems.ts:85-91,177-191`                                 |
| 4   | store 是 workspace 级长命对象，切 tab/关面板不重建，error 卡死无用户可救               | `packages/ui/src/v4/sessionsIndexRegistry.ts:88-142`                                                 |
| 5   | CLI 无订阅者门禁 + existing publisher 不重放种子                                       | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:816,932-960`                  |
| 6   | `flushIndex` 对空订阅自 no-op、deltaLog 有界（去门禁安全）                             | `v4-gateway.ts:845-850`、`sessions-index-publisher.ts:93-99`                                         |
| 7   | sessions-index 是 conversation 投影的下游窄投影（两 surface 同源）                     | `v4-gateway.ts:817-822`                                                                              |
| 8   | 冷启动种子无条件 completedSuccess（不会发布 running）                                  | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts:1239-1250`                        |
| 9   | hydration 把未收口 turn 合成 cancelled 收口（聊天区自愈）                              | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts:786-788`            |
| 10  | 远程 lifecycle/restart 靠两跳 RPC 隐式透传，无显式 relay；RepoWiki 有失效前科          | `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts:173,300-307`                          |
| 11  | conversation 侧换代走 ReplaceableConversationTransport.replace()，每次打开会话全新建立 | `packages/ui/src/v4/workspaceConnectionRegistry.ts:167-189`                                          |
| 12  | 生产构建 renderer 全部日志 no-op（本次定位最大盲区）                                   | `packages/ui/src/logger.ts:38-41`                                                                    |

## 已排除的候选原因

- CLI 冷启动把持久化 running 原样发布 → 反证：冷种子强制 `completedSuccess`（v4-bridge.ts:1239）。
- sqlite tasks-index 的 `status=running` 残留直接导致转圈 → 反证：UI 明确不采信持久化 status。
- 两 surface 在 CLI 侧就是两个状态机 → 反证：sessions-index 是 conversation snapshot 的下游投影。
- conversation 帧 30–150ms debounce 时差 → 亚秒级，解释不了可截图的持续不一致。
- 手机远控链路干扰 → 截图为桌面端，web-remote bridge 日志全部指向本地 test-00x 工作区。
- 远程 lifecycle 事件完全不转发 → 反证：per-remote-session attachment 通道 + ProxyChannel
  延迟发现分支可透传（`packages/rpc/src/proxy-channel.ts:64-80`），Local Host 自身消费到了
  remote lifecycle（`zcodeAgentConnectionScope.ts:627-645`）。可靠性未被 e2e 覆盖，列为后续项。

## 推荐修复（最小连贯变更，两处互补，均为根因修复）

### R-A：`packages/ui/src/v4/sessionsIndexStore.ts` —— 恢复"loading 必须有 live 证明 + 最终收敛"

1. `failRecovery`、resync 失败分支、`connect` 非瞬态失败分支：进入 `error` 时与 `dormant`
   一致清空投影（`this.state = EMPTY_SESSIONS_INDEX_STATE; this.cachedList = null`）。
2. `error` 不再是终态：进入后以有界退避（如 5s/15s/60s 封顶循环）自动发起 fresh
   `connect(transport, { forceSnapshot: true })`；撞到 runtime-unavailable 错误时沿既有分支
   转 `dormant`（防重连风暴，dormant 由 lifecycle available 唤醒）。

### R-B：`apps/zcode-cli/.../v4-gateway.ts` `publishCurrentSummaryToIndex` —— 恢复"归约态忠实"

- 把 `!indexPublisher.hasSubscribers()` 从早退条件移除（保留 `!indexPublisher`）；
  `flushIndex` 对空订阅集自然 no-op，帧语义/seq 记账/schema 全部不变。
  此后任何时刻的 subscribe/resync snapshot 都反映权威当前 phase。

### R-C（defense in depth，强烈建议但不属于本症状修复）

- renderer `logger.ts` 生产构建至少放行 `warn/error` 经 bridge 落盘——本次定位最大盲区，
  也是验证修复效果、把 probable 升级为 confirmed 的前提。

### 需架构决策（不自作主张，独立于本修复）

- 远程两跳事件透传缺显式 relay 契约（RepoWiki 有前科）：建议补跨桥 lifecycle 事件的 e2e 断言。
- sessions-index 无 keepalive/水位校验帧：R-A+R-B 落地后增量价值有限，可缓。
- workspace-dispose 硬杀 agent 导致 running+activeTurnId 持久化残留：聊天区 hydration 已收口、
  冷种子已 completedSuccess，属卫生改进非本症状根因。

## 根因消除证明（repair-sufficiency gate）

1. 被消除的 cause-producing transition：T1 = "恢复失败后 store 停留在携带旧 running 的无自愈终态"
   （R-A 使其不可再产生：无证明即清空，且必然重试）；T2 = "无订阅者窗口的 phase 迁移永久缺席于
   归约态"（R-B 使归约态无条件跟随 live 投影）。
2. 不变量在任何恢复/兜底运行之前即恢复为真：R-A 在进入 error 的同一同步路径清空（先于重试）；
   R-B 在事件 ingest 点修正（先于任何订阅/resync 读取）。
3. 关闭新增重试也依然成立：仅 R-A 清空已消除"陈旧 running 转圈"；仅 R-B 后任何一次 snapshot
   都是当时真值。
4. 不把可见失败变成静默腐败：`status=error` 仍保留可观测；清空只撤销"无证明的 running 宣称"，
   持久任务行由 tasks-index 继续显示，不丢行。
5. 两者组合才完整：只修 R-A，重试可能拿到 stale snapshot（T2 场景）；只修 R-B，error 终态
   卡死 + 旧 running 渲染依旧（T1 场景）。

## 风险评估

- 协议、schema、持久化格式、公共 RPC 契约零变化；两处改动互相独立、可单独 revert。
- R-A 只收紧 `error` 分支并新增退避重试，`live/connecting/dormant` 路径不动；重试失败落入既有
  dormant 分支，无风暴。
- R-B 行为差仅是无订阅者时归约态照常推进：CPU 为 summariesEqual 级比较（ModelStreaming 已排除），
  内存受 `maxDeltaLog` 上限约束；host syncer 与手机链路同样受益。
- 桌面 continuous 与手机 replayable 边界不受触碰（不改 stream/snapshot/队列语义）。

## 验证方案（先写测试，后改代码）

1. 回归测试 1（修复前必红）：`packages/ui/test/sessionsIndexStore.test.ts`
   —— store live 且含 `phase=running` → 注入 recovery fail-closed → 断言投影清空、无 running；
   推进 fake timer → 断言自动 fresh subscribe 成功后 `status=live` 且投影为新 snapshot。
2. 回归测试 2（修复前必红）：`apps/zcode-cli/packages/bootstrap/tests/v4-gateway-sessions-index.test.ts`
   —— 首次订阅→全部退订→无订阅者窗口注入 TurnStarted+TurnComplete→重订阅
   → 断言 snapshot phase 为当前真值而非窗口前旧值。
3. 不变量测试：error 进入路径全枚举（failRecovery/resync 失败/connect 非瞬态失败）均不残留
   sessions；无订阅者 ingest 不发帧、deltaLog 不超上限。
4. 邻接测试：`notOwned` 自愈分支、dormant→available 唤醒、重试撞 runtime-unavailable 转 dormant
   不循环。
5. 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test:unit:affected`。
6. 运行时回放（修复后必绿）：连接 WSL → 发长任务 → 运行中重开工作区（复现 19:32 换代序列）
   → 断言 30s 内列表 spinner 与聊天区收敛一致；R-C 落盘后在日志断言 store 走 fresh subscribe
   收敛而非兜底路径。

## 剩余风险与后续材料

- 截图时刻端内状态不可回放（renderer 无日志），判级 probable；R-C 落地后可闭环。
- 下次复现请让用户额外导出 WSL 内 `~/.zcode/cli/log`（当前 bundle 只含 Windows 侧 CLI 日志）。
- 远程两跳事件隐式透传可靠性未被 e2e 覆盖，独立跟进。

## 修复实施记录

本次核对确认 R-A/R-B 与当前实现和回归现象一致，新增修复如下：

- `SessionsIndexStore` 在 recovery 或非瞬态 subscribe 失败时立即清空 sessions-index 投影，撤销无
  live 证明的 `running` 状态；随后以 5s/15s/60s 封顶的有界退避发起 `forceSnapshot` fresh
  subscribe。runtime-unavailable 继续进入 `dormant`，不启动轮询。
- `ConversationV4Gateway.publishCurrentSummaryToIndex` 去除 `hasSubscribers()` 早退。无订阅者时
  `SessionsIndexPublisher` 仍归约并记账，`flushIndex` 自然 no-op；下一次 subscribe/resync 的
  snapshot 因而反映窗口内的当前 phase。

回归测试覆盖：

- `packages/ui/test/sessionsIndexStore.test.ts`：recovery fail-closed 清空与 fresh subscribe、非瞬态
  subscribe 的 5s/15s 退避。
- `apps/zcode-cli/packages/bootstrap/tests/v4-gateway-sessions-index.test.ts`：无订阅者窗口内
  `TurnStarted` 后重订阅 snapshot 返回 `phase=running`。

R-C（生产 renderer 放行 `warn/error`）以及远程 lifecycle e2e 仍是独立后续项，本次未改变。

## 修复审查记录（2026-08-21，审查对象 commit `41ef87616e`）

结论：**修复方向正确、实现质量高，可以保留；发现 1 处同类遗漏，已在后续修复中补齐。**

### 已验证正确

- **R-B**（`v4-gateway.ts` `publishCurrentSummaryToIndex`）：与方案一致，仅移除
  `hasSubscribers()` 门禁、保留 `!indexPublisher` 早退；`flushIndex` 对空订阅自 no-op、
  deltaLog 有界（`sessions-index-publisher.ts` `record()` 以 `maxDeltaLog` shift 截断），改动安全。
- **R-A**（`sessionsIndexStore.ts`）：实现比方案更细致，竞态点逐条核对通过：
  - `failAndScheduleRecovery` 清空投影 + 置 error + best-effort 退订旧订阅 + 5s/15s/60s
    封顶循环重试；重试回调带 `closed / transport 引用 / generation` 三重守卫，任何外部
    connect / replaceTransport / 换代都会令旧计时器失效；
  - 清空后 `subscriptionId = null`，`handleFrame` 自然拒收死订阅迟到帧，无"error 态吸帧"中间态；
  - 重试链以 `errorRecoveryRetryAttempt` 线程化传递，外部 connect 才重置计数，
    与瞬态重试（EBUSY 等）两套退避互不干扰；
  - connect / resync 失败中新增 runtime-unavailable 分流统一走 `handleRuntimeUnavailable()`
    转 dormant（不对已死 runtime 空转），并顺带修复了原"connect 失败进 dormant 但不清投影"
    的隐性残留；
  - `notOwned` 特判、dormant→available 唤醒、restart 退避等既有路径未被破坏。

### 非回归证明（红→绿）

- 红验证：在父提交 `dc810f6df8` 源码上仅保留新测试运行——
  `sessionsIndexStore.test.ts` 2 条新用例失败、`v4-gateway-sessions-index.test.ts`
  1 条新用例失败（新测试确实抓得住原缺陷）。
- 绿验证：修复代码上两文件全绿（28 + 16 通过）。
- 门禁：根 `pnpm typecheck` 通过；`pnpm lint` 0 errors（39 个 warnings 均不涉及本次改动文件）。
  `apps/zcode-cli/packages/bootstrap` 局部 `tsc --noEmit` 有 3 个存量/环境错误
  （`product-projection.ts:2457`、`workspace-model-catalog.ts:22-23`），均不在本次改动文件内，
  以 CI 为准复核。

### 遗漏（已补修）

- `v4-gateway.ts` `cleanupSessionRuntime` 的会话删除路径（审查时位于 :1927）仍保留同款门禁：
  `if (indexPublisher?.hasSubscribers() && indexPublisher.removeSession(sessionId))`。
  这是"归约态忠实"不变量的另一个写点：无订阅者窗口内被删除的会话不执行 `removeSession`，
  归约态残留 → 重订阅 snapshot 中已删除任务"复活"（可能带旧 phase=running 转圈）。
  已按 R-B 同样移除 `hasSubscribers() &&`，并补充退订窗口内 cleanup 后重订阅 snapshot
  不含该 session 的回归测试。
- 同文件 :1898 的 `hasConversationSubscribers` 是 conversation 侧驻留回收判定，与本修复无关，已排除。

### 其他观察（不阻塞）

- R-C 未实施：线上"probable → confirmed"的观测闭环尚未建立，复现时仍看不到 store 状态迁移。
- 既有 dormant 测试已通过 stale running 预置间接覆盖首次进入 dormant 后的清空；未增加额外
  生产行为变更。

> Todo103：以下保留 staging T3 历史调查与裁决；本轮证据另记整合账本，不把历史验证当成本轮通过。

## 第二次事故（2026-09-04，ZCode 3.11.1）：Settings 覆盖远程 workspace 顶掉侧栏 sessions-index 订阅（T3）

### 症状与判级

同一用户在 3.11.1（commit 87a07145）再次反馈"左侧任务转圈、聊天区已完成"，本次只有症状①且只影响
一个任务。判级 **confirmed**：Windows 桌面日志 + WSL 侧 CLI 日志 + 代码路径三方吻合。R-A/R-B 已经落地，
但它们只覆盖"有 error"与"无订阅者门禁"两类失效；本次是第三条机制 **T3：订阅被静默替换**，全程不产生
任何 error，因此 R-A 的退避重试链路根本不会被触发。

### 因果链

```
远程 workspace（remote:wsl:default:root:/root/src/plancov，remoteSessionId df0312a2…）激活态下打开 Settings tab
  → Root.resolveRootWorkspaceShellTarget 走 fallback：identity 保留，workspaceRemoteSessionId=undefined
    （packages/ui/src/root/rootWorkspaceShellTarget.ts，提交 a38a37f862 只补了 identity）
  → App.useWorkspaceTerminalTaskNotifications 的 scope 无 endpointKey
    → sessionsIndexRegistry 键 "__base__\0<identity>" ≠ 侧栏 useWorkspaceTaskLists 的 "<remoteSessionId>\0<identity>"
    → 新建第二个 SessionsIndexStore + transport，对同一 topic 再发 subscribeSessionsIndexV4
  → 两条订阅经同一 host-rpc facade / relay facade 到 CLI 时 connectionId 相同
    → SessionsIndexPublisher.subscribeReserved "每连接单订阅"：侧栏那条订阅被删除，无任何信号
  → 关闭 Settings → 通知 hook 的 store 退订 → 该 attachment 上该 topic 订阅归零
  → 侧栏 store 仍 status=live，永远收不到帧：冻结瞬间正在跑的任务永久转圈、时间停在打开设置页那一刻；
    之后新建的任务在 store 里不存在，行退回 tasks-index → 运行中不转圈、待输入无徽标
```

事发日志锚点（本地时间 UTC+8）：12:50:41 侧栏订阅 plancov（583ms）；12:50:54 EDGES 任务续跑；
**12:51:03 打开 Settings → 第二条 subscribe（11ms，远程往返）**；12:51:53 关闭 Settings → 远程 unsubscribe；
之后 12:56/13:39/14:04/14:32 四次同样的开关；15:36:56 CLI `turn.completed` 且远端 syncer 广播终态
（tasks-index 已写 completed、用户点开任务前先 mark-read）；≈16:21 截图侧栏仍 running + "3小时"
（冻结的 lastActivityAt≈12:51）。WSL CLI 日志确认单进程、单工作区键、无 agent 重启，排除 CLI 投影停更。

### 修复（root-cause repair，最小连贯变更）

- `packages/ui/src/root/rootWorkspaceShellTarget.ts`：`resolveRootWorkspaceShellTarget` 新增 `workspaceTabs`
  入参；Settings 覆盖时按 `workspaceKey` 找回被覆盖的 workspace tab，回填其 `remoteSessionId`，使外壳目标与
  tab 激活态完全一致。tab 未连接或已关闭时保持 `undefined`（与激活态语义相同）。
- `packages/ui/src/Root.tsx`：调用点传入窗口内全部 workspace tab（复用既有 memo，改名 `windowWorkspaceTabs`）。
- 未改注册表、facade、CLI publisher、UI 展示规则：通知 hook 与侧栏在 Settings 模式下得到同一个注册表键，
  `acquireSessionsIndex` 走 `refCount++` 分支，第二条订阅从源头不再产生。

### 根因消除证明

1. 被消除的转换：外壳目标在 Settings 覆盖时输出不完整身份（identity 有、remoteSessionId 无）。
2. 不变量在任何恢复逻辑之前成立：acquire 时即命中同一条目，CLI 的替换语句永不执行。
3. 不依赖兜底：即便 R-A 重试、心跳、UI 覆盖规则都不存在，原场景也不再出现。
4. 不引入静默腐败：Settings 关闭只是 refCount 减一，侧栏订阅持续存活。

### 测试

- `packages/ui/test/rootWorkspaceShellTarget.test.ts`：修正原用例（它曾把 `workspaceRemoteSessionId: undefined`
  锁成预期），新增按 identity 匹配、tab 未连接、tab 已关闭、本地 tab 四例。修前 2 红。
- `packages/ui/test/rootSettingsSessionsIndexSubscription.test.ts`：单连接 CLI 替换语义 mock；侧栏 scope +
  Root 解析出的通知 scope 只产生 1 次 subscribe；关闭 Settings 后侧栏仍收到 running→completedSuccess。修前红
  （第二 store 订阅为 `six-2`，`six-1` 被替换）。
- e2e `SSH-P0-TASK-03`（pending，`packages/desktop/test/e2e/conversation-session/remote/configuration/conversation-session-ssh-remote-settings-overlay-sidebar-status.test.ts`）：
  续发响应延迟 15s，运行中开关设置页，断言侧栏先转圈、完成后收敛；fixture 合同检查通过，待真实 SSH 运行。

### 本次修复之外（不属于本症状修复，需单独决策）

- D1 观测（已实施，独立提交）：`acquireSessionsIndex` 入口按 agentService 对象身份反查它所属的远程 session
  （`findRemoteWorkspaceSessionIdForAgentService`），scope 的 `endpointKey`（缺省即 `__base__`）与之不一致时用
  `logger.lifecycle.warn` 落盘 `v4.sessions_index.scope_endpoint_mismatch`（带 endpointKey / remoteSessionId /
  workspaceKey / workspacePath），同一 scope 只记一条。只记录、不改键、不改订阅——本次生产日志里没有任何
  renderer 痕迹，只能靠 RPC 指纹（`system.listIntegratedTerminalShells` ±3s）反推，这条日志把同类键不一致
  直接暴露在用户日志里。测试：`packages/ui/test/sessionsIndexRegistryEndpointMismatch.test.ts`。
- D2 设计决策：CLI "每连接单订阅、替换不通知"（10 §3.1）+ attachment facade 统一 connectionId，使任何绕过
  注册表的二次订阅都能静默杀死第一份；上文把 keepalive 判为"可缓"的前提（失败会表现为 error）已被推翻。
  候选：CLI 替换时向旧订阅所在连接发 `subscription.replaced` fault（可直接接入 R-A 的 error→fresh subscribe），
  或 facade 在 `remember()` 驱逐 owned entry 时通知旧 owner。
- D3 mitigation（不建议）：让 tasks-index 中更新且已终态的行覆盖陈旧 running activity，会掩盖症状且与
  "loading 必须由 runtime 证明"方向相反。
- 顺带发现（另开工单）：14:50:36–14:51:38 十二次 `zcode-agent.createSession FAIL`，本地工作区键被路由到 WSL 远端服务。
