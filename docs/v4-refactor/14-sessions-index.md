# sessions-index topic 当前规格

更新日期：2026-07-22

`sessions-index/<workspaceId>` 是侧栏和任务列表的会话活性与实时详情数据源。持久 task 行集合由
`tasks-index.sqlite` 决定；summary 缺失只表示实时详情尚不可用，不能据此删除左侧行。schema 位于
`packages/shared/src/zcode-protocol-v4/sessions-index.ts`；CLI projection/publisher 与 UI
store/transport 已投入主链路。

## 定位

- CLI 权威、客户端只读：列表不再扫描 conversation rows 推导会话状态；该权威仅覆盖 session activity
  和详情字段，不覆盖持久 task 行存在性。
- workspace 维度：`workspaceId = workspaceIdentity?.trim() || workspacePath`。
- conflated 最新态：同一 session 连续更新只保留最后摘要；断线按 snapshot 恢复，不把它当完整事件日志。
- 与 conversation topic 正交：index 提供列表摘要，`conversation/<sessionId>` 提供完整 rows、config、
  control 和 action。

## Schema

### 关闭保护的活动摘要（2026-11-12）

`SessionSummary.hasCompactWork` 是可选布尔字段，由当前快照的
`control.activeWorks.some(work => work.kind === "compact")` 派生。新 CLI 总是写布尔值；旧帧缺失时按
false 读取，冷存储摘要不恢复运行中的 compact。该字段参与摘要判等，开始与结束都必须产出 upsert。

桌面关闭保护按 session 去重：`phase` 为 `prewarming`/`running`、`hasBackgroundWork === true` 或
`hasCompactWork === true` 任一成立即活动。不改变 phase、列表 spinner 或持久 task status 的含义。
pending commands、pending interactions、其他独立 activeWorks、手动终端和未来的自动任务不新增保护条件。

Host 的既有 task-index syncer 在完整快照/增量批次应用后派生活动数，复用 taskRuntimeReporter 上报 Main。
初始快照也必须上报当前活动数，不能因静默落库而漏报；同一 session 同时前台/后台/compact 只计一次。
runtime unavailable 撤销该代际贡献，旧帧不得复活；新代际等新快照建立基线，dispose 发布零。
同代断档恢复沿用最近已证实的计数，不能因为重订阅短暂清空而假装任务结束。

```text
CLI session snapshot -> sessions-index summary -> Host syncer 原子归约 -> Main 活动数 -> 现有退出确认
```

关闭行为与验收边界见 [会话活动退出确认](../desktop/session-activity-close-confirmation.md)。

`SessionSummary` 当前包含会话身份、workspaceId、phase、标题及 title source、父会话、创建/活动时间、
usage 摘要，以及 permission/user-input 的轻量计数。它不能承载完整 interaction payload、conversation
rows 或 tasks-index 组织态。

帧遵守 V4 topic 五件套：

- subscribe / unsubscribe；
- snapshot；
- delta（`session.upserted` / `session.removed`）；
- seq/logEpoch；
- resync。

schema 边界：

- **sessions-index 只含纯会话状态**，**不含 pin/archive/groups**：组织态（用户对列表的标注）走 host 侧 tasks-index.sqlite 的 slim CRUD（pin/archive/groups 三面），侧栏状态层**客户端 join**——归属 M5 ②，不进本 topic、不破坏 schema 冻结。
- **未读不进 schema**：未读属于 tasks-index 组织态，以 `unreadAt` 与 pin/archive 平行查询并在客户端 join；`lastActivityAt` 只负责活动排序，禁止由未读读写修改。
- **定时任务身份不进 schema**：`cronAutomationId` 属于 tasks-index 持久化元数据，继续以 `tasks.meta_json` / `cron_automation_id` 为权威。所有 sessions-index 派生列表必须在客户端 membership join 时按 `taskId` 回填该字段，供 workspace、grouped、timeline 和 pinned/archived 行统一判断 clock icon；禁止只依赖 `SessionSummary`，也禁止为此破坏已冻结的 sessions-index schema。
- **阻塞交互只进轻量摘要**：侧栏需要同步 permission/userInput attention，但不订阅完整 conversation rows。summary 只携带可选 kind/count 摘要；完整 pending interaction payload 仍只属于 conversation snapshot。
- **archived 不进 sessions-index**：归档行和分区归属由 tasks-index 提供，客户端再 join 可用的 session detail。

draft prewarm session 由 gateway 的 `isDraftSession` 过滤，不进入侧栏；首条输入提升为正式 session 后，
事件 fan-out 才把它加入 index。

## CLI 写侧

```text
session runtime/product projection event
  -> SessionsIndexProjection.deriveSessionSummary
  -> SessionsIndexPublisher upsert/remove
  -> conflation + seq/logEpoch
  -> owner subscription wire frame
```

### 事件 fan-out 节奏

默认每条会话事件 fan-out 一次：摘要有变化就立刻 flush 给列表订阅者。高频事件流必须先降频，
否则列表订阅者会按事件频率重算 task 行：

- `ModelStreaming`（正文流式增量）完全不触发列表重算，预览在 turn 收口或其他事件时更新；
- `DynamicWorkflowRunProgress`（工作流运行进度，一次运行可达每秒数百条）按 leading + trailing
  窗口节流：静默后的第一条立即发布，`WORKFLOW_PROGRESS_INDEX_FANOUT_MS`（250ms）窗口内的后续
  进度合并为窗口末尾的一次发布。侧栏运行行（`workflowActivity`）刷新率因此不超过 4Hz，运行终态
  仍在一个窗口内送达；
- 其余事件保持即时发布。窗口内发生的任何即时发布都满足待发的 trailing，并把它取消，不重复发帧。

节流只改变帧节奏：`record.updatedAt` / `lastActivityAt` 语义与 delta 顺序都不变。窗口定时器按
session 持有，会话清理与 gateway dispose 必须清除它，且不得阻止进程退出。

冷订阅先从持久 session store 构造轻量摘要，再用当前在册 session 的 live projection 覆盖。远程 workspace
读取时必须把完整 identity 解析为实际 directory 执行路径，同时按完整 `workspace_id` 精确过滤：

- 本地 session 继续使用 path + `workspace_id is null`；
- 远程 session 写入完整 `workspaceIdentity`；
- 旧 `workspace_id is null` 数据不能只凭相同路径自动 claim 成某个远程 identity；
- 同一路径的不同 SSH/WSL/Docker identity 不能互相出现在 index。

### 3.3.6 SSH/WSL 历史会话升级兼容

3.3.6 创建远程 session 时，CLI session store 尚未持久化 `workspace_id`，但远端 host 的
`tasks-index.sqlite` 已按完整 `workspaceIdentity` 隔离任务。因此 3.4+ 首次订阅 SSH 或 WSL
`sessions-index` 时，允许 host 把当前 identity 的 task index 中已验证的 `taskId` 作为有限
allowlist 随 subscribe 传给 CLI。CLI 只能对同时满足以下条件的 session 做一次性归属迁移：

- `session.id` 在 host 提供的 allowlist 中；
- `session.directory` 与 identity 解析出的实际路径完全相等；
- `session.workspace_id is null`；
- 当前 topic 是合法的远程 workspace identity。

迁移必须原子写入当前完整 `workspaceIdentity`，再按正常的严格 identity 条件构造 snapshot。
已带其他 identity 的 session 禁止覆盖；本地路径订阅禁止消费该 allowlist；空 allowlist 禁止退化为
按路径认领。allowlist 由 host 按精确 `workspaceKey` 从 tasks-index 读取，只取未删除的 GLM task，
并限制为 sessions-index 单次冷种子的上限，避免同路径不同 SSH authority 串读或无界放大协议帧。
tasks-index 读取失败时必须放弃旧数据迁移并继续严格 identity 订阅，不得因兼容逻辑阻断当前会话列表。

迁移机会不能绑定到 `sessions-index` publisher 的首次构造。对同一 `workspaceId` 的冷种子与迁移操作
必须串行化；后续订阅只要携带非空 allowlist，就必须重新执行幂等 claim，并在 claim 完成后重新按
严格 identity 读取 store。即使本次 `claimedCount = 0` 也必须完成重读，因为上一次执行可能已经成功
claim、但在读取或合并摘要前失败。读取成功后，此前缺失的摘要必须合并到已有 publisher，并作为
正常 `session.upserted` delta 推给现有订阅者；迁移或读取失败只能让本次订阅沿用当前严格快照，不能
留下“已迁移”标记，后续携带 allowlist 的订阅仍可重试。重读只把 publisher 中此前缺失的 store
摘要补入 index，已存在的 live 或旧种子摘要继续由既有事件投影更新，不能被冷存储默认态降级覆盖。

```text
同 workspace 订阅 A（无 allowlist） -> 严格读取/初始化 publisher
                                      |
                                      v（串行边界）
同 workspace 订阅 B（有 allowlist） -> 幂等 claim -> 严格重读 -> merge + delta
```

本地 workspace 不消费 allowlist，也不进入上述迁移分支，继续保持 `workspace_id is null + directory`
的既有查询和 publisher 生命周期语义。

3.4.2 曾把带显式 user 的 WSL identity（`remote:wsl:<distro>:<user>:<path>`）错误解析成执行
路径，导致部分持久 session 的 `directory/path` 被写成 identity 本身，或
`<workspacePath>/<workspaceIdentity>`。冷恢复在 materialize runtime 前必须修复这些确定、可逆的历史形态：

- `workspace_id` 已存在时，只接受合法 remote identity，并把上述两种污染形态还原为 identity 解析出的
  `workspacePath`；正常路径、合法子目录不改写；包含 identity 但不属于已知形态的数据 fail-closed；
- `workspace_id is null` 时，只有当前恢复 workspace 的合法 identity 能从上述污染形态中得到完整证明；
  修复必须原子写入 `workspace_id + directory + path`；写入未命中后必须重新读取，只有并发请求已经写入同一
  identity 和真实 `directory/path` 时才能继续，否则以可恢复的 session corruption fail-closed，禁止物化 runtime；
- 已有 identity 的路径修复必须使用只更新 `directory/path` 与单调 `time_updated` 的窄 CAS，禁止复用会把
  title、summary、permission、revert、archive 等并发事实写回的通用 `updateSession`；CAS 未命中时重新读取并
  重新裁决，暂时性写盘异常可用同一确定性内存结果继续本次恢复并保留后续重试机会；
- 修复不得依赖 client mode，也不得改变 desktop `continuous` 与 mobile `replayable` 的消息恢复边界。

```text
host task allowlist + clean path + null identity -> atomic claim -> strict sessions-index read
known polluted path + proven remote identity     -> path repair -> runtime materialize -> resume
unknown/mismatched shape                         -X-> no claim / fail-closed
```

remote identity 解析必须 fail-closed：任何以 `remote:` 开头但不符合统一 parser 的 workspace id 都不能
回退为本地路径。这样修复的是 3.4.2 的错误持久化根因，而不是在发送按钮处增加兜底。

实现入口：

- `packages/services/src/zcode-agent/zcodeAgentService.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-publisher-registry.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`

## UI 读侧

`agentSessionsIndexTransport` 把 service 的 V4 帧转给 `SessionsIndexStore`。store 原子应用 snapshot，要求
delta 连续；gap、runtime generation 变化或 wire assembly fault 触发 recovery，恢复失败时 fail-closed。

任务列表订阅采用 `existing-only` runtime policy。scope acquire 只登记观察关系；workspace Agent 尚未运行时，
store 进入 `dormant`，不发起 spawn、不计作 hydration，也不把此前 live summary 的 `running` 当成当前 activity。
持久行继续由 tasks-index 展示。显式草稿预热、打开 session、发送命令或其它真实运行入口发布 runtime
available 后，dormant store 才 fresh subscribe；Host task-index syncer 的 dormant state 必须在第一次 available
时先幂等安装 workspace 级 sessions-index/workspace-config frame listener，再发起 subscribe，确保同一次 stdio
read 中在 ACK promise resolve 后、await continuation/subscription ownership 生效前到达的 initial frame 不丢失。
后续 runtime generation 换代复用同一组 listener，只重订阅；
runtime unavailable 后撤销订阅与重试并回到 dormant。

```text
restored inactive workspace -> tasks-index row + dormant observer -X-> Agent spawn
explicit runtime operation  -> runtime available -> install listener -> fresh subscribe -> live detail
runtime unavailable         -> clear live ownership/retry -> dormant -X-> implicit restart
```

`start-if-needed` 只保留给具有明确用户/系统执行意图的入口；任务列表、grouped/timeline/pinned/archived
消费者和 Host task-index syncer 均不得使用它。runtime lifecycle 与订阅都按
`workspaceIdentity?.trim() || workspacePath` 隔离。

Main 的本地冷启动预热名单是另一种明确系统意图：恢复多个本地 workspace 时，只选择上次激活的
workspace（上限 1），随首次 `InitLocal` 交给同一 Host。Host 对该 target 复用既有完整
`initializeWorkspace` 路径；`recentProjects` 与其它 restored workspace 均保持 dormant。预热失败不以其它
workspace 补位，renderer reload 只 reattach 既有 Host，远端 shared-host/mobile attachment 不消费或
扩展这份本地名单。

同一 endpoint + workspaceKey 的多个消费者通过 `sessionsIndexRegistry` 共享 store/订阅并做引用计数。
多 endpoint 聚合用 `workspaceSessionsIndexSubscriptionSet` 差量协调 scope：

```text
已有 local-A + remote-A
  -> 新增 remote-B：保留 A 的 store/subscription，只 acquire B
  -> 删除 remote-B：只 release B
  -> service generation 换代：只替换受影响 scope
```

这条规则避免新远端 endpoint 水合时拆掉已就绪列表。远程 pane 必须使用自己的 endpoint service，不能向
本地 `__base__` 查询同路径 session。

实现入口：

- `packages/ui/src/v4/agentSessionsIndexTransport.ts`
- `packages/ui/src/v4/sessionsIndexStore.ts`
- `packages/ui/src/v4/sessionsIndexRegistry.ts`
- `packages/ui/src/v4/useSessionsIndex.ts`
- `packages/ui/src/v4/useWorkspaceSessionsIndexItems.ts`
- `packages/ui/src/v4/workspaceSessionsIndexSubscriptionSet.ts`

## 与 tasks-index 的 join

tasks-index 提供持久 task 基础行及以下组织态，sessions-index 只按
`workspaceKey + taskId(sessionId)` 覆盖命中的实时字段：

- pinned / archived / group membership；
- unreadAt；
- 兼容列表查询所需的搜索文本或 slim metadata。

客户端投影使用 task-index row 做左表：summary 命中时补 phase、lastActivityAt、background work、
pending interaction 和 session 标题；summary 缺失时保留持久行并禁止从历史 `status=running` 推导 spinner。
新建但尚未落库的任务只通过 renderer 已有 optimistic/live overlay 临时显示。

组织态 mutation 不会改变 sessions-index，因此
`taskListMembershipVersion.ts` 显式触发 membership 重拉；不能等待一条不存在的 index delta。
任务创建同样会改变 tasks-index 的正向行集合：Host 在 task row 与 grouped 初始顺序提交后发出
`task_created`，renderer 必须用该事件换代 task-row/membership 读取。不能只更新 session activity，
否则旧 membership Promise 会在新行已经落库后继续把它挡在 Project/Timeline/Grouped 之外。

## 恢复与多端边界

- 桌面 online continuous 与手机 replayable recovery 可以消费同一份 index 权威，但各 attachment 有独立
  subscription ownership 和 recovery 状态。
- relay/main 不缓存 index，也不把一个客户端的 saturated/resync 状态广播给其他客户端。
- snapshot 是当前 workspace 的整体替换；旧 generation 的帧必须丢弃。
- index 的 seq 只服务订阅连续性，不代表可永久回放的业务历史。

## 测试边界

当前应至少由以下层级提供证据：

- shared：session summary / snapshot / delta / topic schema 与 wire codec；
- CLI：projection 派生、publisher conflation、冷种子、draft 过滤、remote identity；
- UI：snapshot/delta/gap、store 引用复用、多 endpoint 差量生命周期、列表 join；
- WDIO：新建、打开、重命名、归档/删除后列表可见性，以及 remote scope 不串线。
- process lifecycle：单窗口恢复多个本地 workspace 时只允许启动时选出的 active workspace 这 1 个显式预热 runtime；
  展开任意 task-list 视图不得增加 Agent 数量；名单外 workspace 只有显式打开/发送/后台任务入口才能启动，
  runtime unavailable 后被动 observer 不得把它重新拉起。

覆盖矩阵中的现存测试才算自动覆盖；历史 M5 清单或建议文件名不能替代测试证据。
