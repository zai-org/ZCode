# V4 Conversation Cold Hydration Performance

## Feature Summary

| Field                 | Value                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | 把长会话首次 `v4/conversation/subscribe` 的冷恢复从逐事件全投影事务改成有界批量重放，消除随历史长度增长的重复 clone、全行 action 扫描和 snapshot 序列化 |
| User-visible surfaces | 打开已持久化的长会话；首个 conversation snapshot 到达前的等待时间                                                                                       |
| Existing docs         | `docs/v4-refactor/02-projection.md`、`docs/v4-refactor/05-transport-and-backpressure.md`、`docs/v4-refactor/07-persistence.md`                          |
| Existing code owners  | CLI `V4Gateway`、`ConversationTopicPublisher`、`ProductProjection`                                                                                      |
| Out of scope          | renderer 渲染优化、wire schema 变化、SQLite migration、持久 projection checkpoint、手机独立 runtime、改变 desktop/mobile delivery profile               |

## Clarification Log

| Round | Question                               | User answer                              | Boundary fixed                                                    | Follow-up needed |
| ----- | -------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| 1     | 构造 2000 轮、含工具调用的消息并测加载 | 用户要求直接测量                         | 目标是长历史 cold open，而不是普通 streaming 吞吐                 | no               |
| 2     | 瓶颈在 V4 还是 CLI 读数据              | 用户要求继续定位                         | SQLite/runtime resume 与 V4 projection hydration 分段取证         | no               |
| 3     | 是否接受当前随历史增长的 N 方复杂度    | “这个 N 方的复杂度不靠谱”                | 这是实现 bug 修正，不是增加 timeout 或降低历史保真度              | no               |
| 4     | 是否进入 worktree 开发                 | “如果你有方案了就在 worktree 里开发试试” | 在独立 worktree 实现；本轮默认不引入 persistence/schema migration | no               |

## Boundary Decisions

| Boundary         | Decision                                                                  | Includes                                                                  | Excludes / prunes                                                     | Source                                              |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| 冷热语义         | 保持 `reduce(transcript) ≡ reduce(events)`                                | transcript 继续先合成 canonical events，再进入同一个 reducer              | 直接 `message/part -> row` 的第二套投影器                             | `docs/v4-refactor/07-persistence.md`                |
| 原子性           | candidate 完整成功后一次 adopt                                            | reducer 异常时旧 projection/log/subscription reservation 完整保留         | 在权威 publisher 上原地半重放                                         | current publisher contract                          |
| payload gate     | 正常批量路径必须证明不可能跨过 16 MiB；不能证明时回退严格逐事件 admission | terminal reserve、oversized historical event skip、后续 terminal 继续归约 | 增大限额、截断 snapshot、静默接受不可传输 projection                  | `docs/v4-refactor/05-transport-and-backpressure.md` |
| delivery profile | 只优化 CLI 的共享 cold materialization                                    | desktop continuous 与 mobile replayable 获得同一终态 projection           | 把 replayable gap/snapshot 规则扩散到 desktop continuous              | conversation protocol                               |
| persistence      | 本轮不改 DB schema                                                        | 复用现有 message/part/session_entry 读取                                  | projection checkpoint、row ordinal migration、store-backed lazy range | user-authorized scoped implementation               |
| 性能门禁         | 性能阈值是回归门禁，不是产品功能合同                                      | 代表性 2000 轮 tool-heavy fixture 与 focused synthetic benchmark          | 依赖墙钟的跨机器严格 E2E pass/fail                                    | catalog PERF scope                                  |

## Domain Scope

| Domain                        | Include?      | Why it can change behavior                                     | Primary sources                      |
| ----------------------------- | ------------- | -------------------------------------------------------------- | ------------------------------------ |
| Conversation/session behavior | yes           | cold/live projection、row actions 和 command target 必须等价   | conversation declaration、PV4-09     |
| Persistence/index/snapshot    | yes           | transcript 是 completed body 权威，冷订阅需要读取并合成 events | `docs/v4-refactor/07-persistence.md` |
| Rendering/performance         | yes           | 首帧前 CLI CPU 饱和，renderer 尚未收到正文                     | 2000 轮 runtime measurement          |
| Mobile remote/replayable      | boundary only | 共用同一 CLI projection，但交付恢复语义必须隔离                | trusted delivery invariants          |
| UI/render implementation      | no            | 本次耗时发生在 initial frame 产生前                            | runtime trace                        |

## Concept Map

```text
persisted message / part / session_entry
                |
                v
loadPersistedConversationMaterialization
                |
                v
synthesize + merge canonical SessionEvent[]
                |
                v
ConversationTopicPublisher.rehydrate
                |
                +-- candidate ProductProjection (not externally visible)
                |      |
                |      +-- batch reduce through the same normalizer/reducer
                |      +-- materialize row actions once at the end
                |      +-- measure the bounded wire tail in fixed event windows
                |
                +-- success: one atomic adopt + snapshot recovery boundary
                `-- failure/uncertain size: discard or strict fallback
                                |
                                v
              desktop-continuous / web-remote-replayable subscribe
```

| Concept                | Why it matters                                                                                                | Source                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| candidate publisher    | 外层已经隔离旧权威状态，逐事件 clone 是重复事务                                                               | `conversation-topic-publisher.ts` |
| action materialization | 当前每个 event 都扫描全部 rows，且 assistant 分支包含嵌套 `find/some`                                         | `product-projection.ts`           |
| immutable delta apply  | replay 期间每次 append/upsert 都复制增长中的 row array                                                        | shared `apply.ts`                 |
| wire tail              | initial snapshot 只下发最后 60 rows；完整历史仍由 CLI 为 range/targets 保留                                   | protocol limits / projection docs |
| recovery boundary      | batch 延迟派生 actions；rehydrate 后旧中间 base 必须 snapshot，当前水位后的新事件仍可 resume | publisher retention contract      |

## State Owners

| State / fact                      | Authority                               | Mirrors / caches                       | Evidence                                              |
| --------------------------------- | --------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| persisted conversation facts      | CLI session store                       | runtime message history                | DB counts、cold resume log                            |
| canonical conversation projection | CLI `ProductProjection`                 | publisher snapshot/log、renderer store | strict-vs-batch golden                                |
| subscription ownership/profile    | CLI publisher + host trusted connection | renderer/mobile store                  | existing publisher/gateway tests                      |
| payload limit                     | shared V4 limits + CLI admission        | wire assembler                         | logical byte measurement and oversized fallback tests |

## Dimensions

| Dimension          | Values / equivalence classes                             | Include?            | Reason                                                                         |
| ------------------ | -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| persistence source | durable transcript、existing healthy live publisher      | yes                 | durable transcript 才需要批量 cold replay；健康 live publisher 已由 guard 跳过 |
| history size       | small、2000 turns tool-heavy、增长比例                   | yes                 | 同时验证语义与复杂度趋势                                                       |
| projection payload | safely bounded、uncertain/over limit                     | yes                 | 决定 fast path 或 strict fallback                                              |
| replay outcome     | success、ordinary reducer error、payload-too-large event | yes                 | 原子性和 fail-closed                                                           |
| delivery profile   | continuous、replayable                                   | representative only | 终态 projection 相同，profile 只影响过滤/恢复，不做重复全排列                  |
| workspace kind     | local、SSH/WSL/Docker                                    | pruned              | hydration 算法只消费 session facts，不执行路径操作；workspace identity 不变    |
| tool shape         | text/reasoning + mixed terminal/pending/error tools      | yes                 | tool-heavy fixture 是本次复现主体                                              |

## Candidate Combinations

| Candidate ID | State                                                   | Event                         | Expected guard/effect                                         | Status                   | Notes                                |
| ------------ | ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| V4HYD-01     | completed durable transcript，projection safely bounded | first subscribe               | batch replay，同 reducer，最终一次 adopt                      | accepted                 | 主要性能修正                         |
| V4HYD-02     | same facts                                              | strict replay vs batch replay | snapshot、row actions、command target、seq/revision 相同      | accepted                 | semantic golden                      |
| V4HYD-03     | history 可能跨 16 MiB                                   | first subscribe               | fast proof 不成立，回退 strict per-event payload admission    | accepted                 | 保留 skip bad event + later terminal |
| V4HYD-04     | candidate reducer 抛 ordinary error                     | first subscribe               | 抛错且旧 projection/log/subscription reservation 不变         | accepted                 | 已有回归扩展 batch path              |
| V4HYD-05     | healthy live publisher                                  | subscribe                     | 复用 live publisher，不 cold replay                           | pruned                   | 现有 gateway guard                   |
| V4HYD-06     | desktop vs mobile same facts                            | subscribe/recover             | 共用同一终态；分别保留 continuous/replayable delivery         | pruned to representative | 协议不变量已有专项覆盖               |
| V4HYD-07     | persist projection checkpoint/lazy rows                 | cold subscribe                | 将首屏成本与总历史完全解耦                                    | ignored                  | 后续架构阶段，需要 migration         |
| V4HYD-08     | client 持有 rehydrate 前同 epoch 的中间 base            | rehydrate 后 subscribe        | 走 snapshot recovery boundary；当前 seq 后的新事件仍可 resume | accepted                 | action delta 时序不对旧 base 开放    |

## Pruning Decisions

| Decision ID | Pruned combinations                        | Guard/invariant             | Product reason                            | Representative coverage                         |
| ----------- | ------------------------------------------ | --------------------------- | ----------------------------------------- | ----------------------------------------------- |
| V4HYD-P1    | client profile × history/tool shape 全排列 | canonical projection shared | profile 不改变 reducer 终态               | strict-vs-batch golden + existing profile tests |
| V4HYD-P2    | workspace kind × hydration                 | no path execution           | session facts 与 workspace transport 隔离 | bootstrap unit representative                   |
| V4HYD-P3    | renderer CPU/render cases                  | initial frame not emitted   | 本轮根因在 CLI projection                 | 既有 2000 轮 runtime trace                      |
| V4HYD-P4    | 增大 subscribe timeout                     | complexity invariant        | 延迟失败不减少 CPU/RSS                    | ignored                                         |

## Accepted Cases

| Case ID  | Setup                                                        | Action                 | Assertions                                                                                          | Evidence layers                                         | E2E status             |
| -------- | ------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------- |
| PERF03-A | 生成 2000 轮、4000 messages、混合工具状态的持久 session      | 冷进程首次 subscribe   | initial snapshot 到达；CLI 不再 180s timeout；tool/user/assistant tail 可见；耗时和 RSS 留 artifact | CLI log + process CPU/RSS + protocol ACK/frame + UI/CDP | manual performance run |
| PERF03-B | synthetic small/mid/large event logs                         | strict 与 batch replay | 最终 snapshot、message target、row action、seq/revision 完全相同；增长倍率不呈平方级                | focused unit/perf test                                  | covered                |
| PERF03-C | 正常 history 与超大 history                                  | batch hydrate          | 正常 history fast path；bound 不可证明时 strict fallback；16 MiB 行为与旧实现一致                   | publisher unit                                          | covered                |
| PERF03-D | 已有 projection/subscription reservation，candidate 中途抛错 | rehydrate              | 旧 projection/log/reservation 不被修改                                                              | publisher unit                                          | covered/extend         |
| PERF03-E | provider compact active tail 为 939 messages / 3523 parts，UI active branch 至少 10621 messages，另有 1805 个 workspace checkpoint | cold merge 后首次 rehydrate + subscribe | 同时校验 provider tail 与 UI full active branch 规模；完整 initial snapshot 到达；记录分段耗时与首帧结构 | opt-in CLI perf spec + production fixture | fixed；production verified |
| PERF03-H | PERF03-E production fixture | V4 cold activation → initial frame | 正常路径只完整读取一次 parent messages；并发订阅共享同一 operation materialization；compact 修补路径刷新一次 | bootstrap/core focused tests + production A/B | fixed；production verified |

## Matrix Backfill

| File                                                       | Change                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `docs/conversation-session-case-catalog.md`                | 增加 PERF03 cold hydration performance case                             |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | 登记 focused benchmark + manual 2000-turn fixture，避免冒充正式 GUI E2E |

## Implementation Contract

1. transcript 仍合成为 `SessionEvent[]`，不能新建 cold-only row reducer。
2. `rehydrate` 先在不可见 candidate 上批量重放；结束时只做一次全行 actions 收敛。
3. fast path 按固定事件窗口精确测量协议固定的 60 行 wire tail，窗口内只累计仍在 tail 的 delta，并为延迟 actions 预留完整 schema 上界；历史行滑出 tail 后不累计。上界不成立时从干净 candidate 走现有严格路径。
4. ordinary reducer error 不 fallback、不吞错，旧 publisher 保持原状。
5. batch 与 strict 的 final snapshot、row command targets、sequence/revision 必须由 golden test 逐字段比较。
6. batch 延迟派生 actions，因此成功 rehydrate 后建立 snapshot recovery boundary；旧中间 base 不续 batch log，当前 seq 之后的 live delta 继续正常 resume。
7. 生产高频逐 event 细节不新增 `info` 日志；阶段耗时如需记录必须聚合为一次 hydration 生命周期事件。

## Performance Acceptance

- 以 500/1000/2000 turn 代表样本记录 wall time；目标是单轮成本趋于稳定，2000/1000 的倍率显著低于 4。
- 同一 2000 轮 fixture 不再触发 180 秒 `v4/conversation/subscribe` timeout。
- 性能数字记录环境与 artifact，不写成跨机器产品 SLA。
- 分块 yield 或 hydration scheduler 只能作为 responsiveness/并发保护，不能代替消除重复工作。

### PERF03-E 工单形状复现合同（2026-08-11）

该用例最初只固定复现；修复后继续作为等价性与性能观测用例。它针对工单
`ZCT-2087119663734751232` 中
`hydrate_three_source_merge` 完成后到 `v4/conversation/subscribe` 返回前的 CLI CPU 区间；
renderer 自动补历史、文件摘要 query 和 provider 请求均不计入 focused 用例的核心计时。

```text
SQLite full active branch (>= 10621 messages)
              |
              +-- runtime/provider history applies latest compact boundary
              |      -> 939 messages / 3523 parts
              |
              +-- UI cold projection retains the full active branch
                     +-- timeline + rows/range history
                     +-- checkpoint_created x 1805
                              |
                              v
                     three-source merge
                              |
                              v
             ConversationTopicPublisher.rehydrate
                              |
                              v
                     initial snapshot frame
```

复现数据与观测要求：

1. 工单的 `session.resumed.messageCount=939 / partCount=3523` 是 compact 后的 provider-active
   tail，不是 SQLite 全量。随后同一 session 的 rewind 日志记录
   `keptMessageCount=10621`，证明 compact 前有效分支至少有 10621 条 message。复现必须同时
   固定这两个数量级，不能把 939 当作 full transcript。
2. fixture 使用真实 active compaction boundary，使 provider/runtime 的
   `activeSessionMessages()` 精确得到 939 messages / 3523 parts；cold projection 输入保留
   10621 以上的完整有效分支，以恢复 UI timeline 和 `rows/range` 历史。这是生产分层语义：
   `loadPersistedConversationMaterialization()` 通过 `selectActiveConversationBranch()` 处理
   rewind/branch cut，但不把 provider compact tail 误用为 UI projection 的历史边界。
3. 1805 个 checkpoint 分布到历史 user message，但不引入 subagent lifecycle；该维度保留工单
   event-store 形状，不把 child query 混入核心计时。
4. opt-in CLI spec 依次执行 `mergeColdConversationEvents`、
   `ConversationTopicPublisher.rehydrate` 与首次 `subscribe`，输出 full/active message 和 part 数、
   merge/rehydrate/subscribe/total、event/row 数、initial frame bytes/hash；不以绝对墙钟作为
   跨机器断言。
5. production build 的 fresh app-server 只用于端到端证据；测试和 fixture 工具留在 test/skill
   范围，不进入生产启动路径。

状态组合裁剪：只覆盖本地 `desktop-continuous` 的首次 cold subscribe 作为代表；mobile
`web-remote-replayable` 的终态等价沿用 PERF03-B/PV4 既有覆盖。UI 全历史分页、remote
workspace、provider 续发和真实 artifact 文件内容不属于本次 projection 复现。

修复边界：只在 `tryBatchHydration()` 已开启的 cold hydration accumulator 内，根据 reducer
产出的 delta 判断 subagent 派生态是否失效。只有 subagent row 的新增、更新、流式变化、任意
后缀删除，以及 `pendingInteractions`、`backgroundWorks` 变化，才重新执行
`materializeSubagentProjection()`；其他事件仍正常 normalize/reduce、推进 `snapshot.seq`，但不再
扫描全部 conversation rows。live `ingest()`、payload proof 失败后的 strict fallback、cold merge、
EventStore、checkpoint 文件摘要/rewind 消费与 hydration 后的 store-verified subagent seed 保持原状。
优化前后 initial frame bytes/hash、event/row 数、最终 seq 与两种 delivery profile 终态必须等价。

同一用例中的 `TurnComplete` 还需固化最后一条 assistant 的 fork 能力。该查找只允许在当前
product turn 的 header 之后原数组倒序遍历、命中即停；禁止为每一轮复制并反转整个 rows
窗口。若旧历史缺少 turn header，则从窗口起点兼容查找。该优化只替换查找算法，不新增可变
索引，也不改变 cold/live、rewind、clone 或 stable-fork 语义。

`TurnComplete` 对缺失 terminal event 的 foreground tool 仍需保留兜底收口，但不得每轮扫描
全部 rows。投影维护 `openForegroundToolCallIds` 派生索引：tool row 处于 `inputStreaming`、
`pendingApproval`、`running` 且未 background 时加入，进入任意终态或 background 时移除；
`row.removed` 同步清理被 rewind 的项。索引只由已物化的 tool row delta 推导，权威状态仍是
snapshot；收口前必须用当前 row 再校验。clone/adopt、atomic reject、cold batch 和 strict replay
必须保持索引隔离及最终 snapshot 等价，迟到 upsert 导致 closed → open 时必须重新加入。

同一 cold batch 的 wire payload proof 不再按固定 32-event 窗口无条件精确序列化。无 delta
事件只推进 `snapshot.seq`，必须用数字位数变化维护该字段的安全增长上界，不得构造 wire tail
rowId 集合或序列化空 delta；`state.updated`、`row.appended` 可直接计入保守增长，只有
`row.upserted`、`row.delta` 需要惰性构造 tail rowId 集合判断是否影响 60-row wire window。
`row.removed` 可能把旧行带入 tail，必须立即精确重测；最终事件必须在 actions 收敛后精确重测；
其他事件仅在保守上界触及当前 terminal/non-terminal payload limit 时精确重测，重测后连同
未收敛 actions 的安全预留仍无法证明可传输才回退 strict admission。该优化只能减少证明成本，
不得改变 16 MiB fail-closed、terminal reserve、单个 oversized historical event 跳过后继续终态、
initial frame bytes/hash 或 cold/live 最终 snapshot。

上述 cold-only delta 增长仍需按真实 JSON UTF-8 字节数精确计量，但无需为此创建临时
`Uint8Array`：CLI bootstrap 可对同一份 `JSON.stringify` 结果使用 Node
`Buffer.byteLength(json, "utf8")`。该替换仅限 `tryBatchHydration()` 的增长计数；shared/browser
编码器、live delta、snapshot 精确测量、16 MiB limit 与 terminal reserve 判断保持原实现。
测试必须逐值覆盖 ASCII、中文、emoji、引号/反斜杠、控制字符和顶层 `undefined`，并证明新旧
结果相等；payload limit 前后 1 byte、临时超限后的 strict fallback 与最终 frame 结构继续由
publisher 边界测试覆盖。

subagent 派生态需要看到“当前 snapshot 应用本事件 delta 后”的 prospective 状态，但不得为每次
materialization 复制完整 rows 数组。cold 与 live 共用的 materializer 应直接遍历当前 rows，并只对
本事件涉及的 `row.appended`、`row.upserted`、`row.delta`、`row.removed` 建立局部 overlay；
`pendingInteractions` 与 `backgroundWorks` 读取同一 batch 中最后一次 `state.updated` 替换值。该优化
只消除数组复制，仍保留现有全表扫描、latest-row-wins、ghost child 过滤、waiting/blocked 优先级、
revision 和 delta 顺序。strict replay 与 cold batch 必须在 spawn/message/stop、waiting、blocked、
rewind、重复 child 与 ghost child 组合下逐事件及最终 snapshot deep-equal；若扫描本身仍是热点，
再以独立 profiling 证据决定是否引入索引。

同一 production fixture 在移除 prospective 数组复制后仍触发 2180 次 materialization，剩余
全表扫描中位数 255.7ms，超过 50ms 的继续优化阈值。下一步只复用现有
`subagentRowIdByAgentId` 与 `rowIndexById`：去重当前 subagent rowId、按当前 row index 恢复原
时间线顺序，再叠加本事件新 append 的 prospective row；不得新增第二套 row/child 权威索引。
`row.removed` 应用完成后，必须以当前 snapshot 为权威一次性删除目标 row 已不存在的 stale agent
映射；普通事件不得为此遍历 `subagentRowIdByAgentId`。synthetic/real agent alias 必须按 rowId
去重，`row.upserted` 把非 subagent 转为 subagent 时仍需纳入本次局部 overlay。性能测试应证明
普通 conversation rows 不再进入 prospective subagent 计算，重复 rewind 也不会让 alias 数量随已删除
历史持续增长。

## Measured Results

### 2026-08-14 exact byte length + indexed subagent overlay

环境为 Apple M4、Node 24.14.0。先保留修改前 production bundle，使用只读备份数据库和同一
fixture `sess_perf_large_20260811150224_4929c823`；每组先预热一次，再各启动 5 个 fresh
`app-server --stdio` 进程。随后强制重建 15/15 CLI production tasks，再运行完全相同的 runner。

| Production boundary | 修改前 samples / median | 最终 samples / median | 中位数变化 |
| --- | --- | --- | ---: |
| process → provider-registry ready | 464.6 / 442.7 / 442.7 / 438.2 / 473.3 / **442.7ms** | 441.6 / 453.4 / 445.2 / 442.0 / 457.4 / **445.2ms** | +2.5ms；启动噪声 |
| ready → complete initial frame | 1889.7 / 1950.2 / 1922.2 / 1927.9 / 1879.8 / **1922.2ms** | 1443.6 / 1497.7 / 1418.7 / 1463.2 / 1455.7 / **1455.7ms** | **-466.5ms（-24.3%）** |
| process → complete initial frame | 2354.2 / 2392.9 / 2364.9 / 2366.0 / 2353.1 / **2364.9ms** | 1885.2 / 1951.1 / 1863.9 / 1905.1 / 1913.0 / **1905.1ms** | **-459.8ms（-19.4%）** |

只切换 exact `Buffer.byteLength` 与无复制 prospective overlay 后，`ready → frame` 中位数先降到
1662.5ms（-259.7ms）；在 profile 证明全表扫描仍为热点后，再复用已有 subagent/row 索引，最终
再降 206.8ms。前后 10 个正式样本均保持 157745-byte initial frame、157547-byte snapshot、
29950 total rows、60-row wire window 与 `seq=74164`；移除每进程随机 `logEpoch` 后，snapshot
SHA-256 均为 `5c8290e8489b2951be8cfc2fc03556f806a691200f4f3697ab5a0663b4b1e11d`。

临时 production 打点对同一 74164-event replay 的热点拆分如下；数字包含打点开销，只用于同机
方向判断：

| Implementation | subagent materialization（2180 次） | exact wire-delta byte count（72357 次） | publisher rehydrate |
| --- | ---: | ---: | ---: |
| 修改前记录 | 324.1ms | 354.5ms | 1014.0ms |
| exact Buffer + no-copy overlay | 255.7ms | 226.4ms | 781.3ms |
| 再加 indexed subagent enumeration | **68.2ms** | **225.3ms** | **589.5ms** |

索引层已经去掉普通 conversation rows 的扫描；剩余约 68ms 是完整 subagent 派生态计算，不再为
低于 50ms 的旧“全表扫描”阈值继续新增缓存。byte count 仍精确且仍是当前约 225ms 热点，本轮
不改成近似计数，也不改变 16 MiB/terminal reserve/strict fallback。

不含 subagent row 的 PERF03-E focused fixture 单独验证 byte-count slice：修改前 rehydrate 为
264.5 / 264.8 / 266.3 / 266.9 / 269.4ms，中位数 266.3ms；修改后为 235.0 / 251.3 /
240.0 / 239.8 / 238.1ms，中位数 239.8ms（-26.5ms，-10.0%）。两组 initial frame 均为
25016 bytes、30500 rows，hash 均为
`2ff4f3816dc88f2f050f1ec52c1772fa137f35192f3bd5ec6a55c42afdf8c881`。

rewind stale alias 清理补丁完成后，同一无 rewind focused fixture 复测为 235.6 / 233.8 /
237.7 / 235.8 / 236.0ms，中位数 235.8ms；initial frame bytes/hash 与上述结果相同。该清理直接
挂在原有 `row.removed` 分支，普通事件不新增 alias 遍历；结构测试同时固定一段 16-event replay
只在两次 rewind 上各清理一次，并在重复删除后只保留仍指向当前 snapshot row 的 alias。

除下方单独标注的 PERF03-E 外，历史结果环境为 Apple M2 Pro、10 logical CPU、16 GiB RAM、Electron 41.0.3；renderer 使用 Vite dev server，CLI 使用 `ZCODE_ENV=production`。以下数字是本机诊断证据，不是跨机器 SLA。

### PERF03-H 单次冷恢复物化（2026-08-12；2026-08-13 复核）

单读数据来自一次性本地只读数据库备份诊断；该 probe 不保留在仓库生产或测试代码中，也不作为
可移植 CI 门禁。

本轮先用集成 spy 固定调用事实：fake app 不执行真实 runtime 读取时，一次 V4 cold subscribe 对父
session 调用 `messages()` **4 次**；真实 runtime 另读 1 次，因此 production 正常路径合计 **5 次**。
随后对同一数据库的只读备份预热一次，5 次单读样本为 293.9 / 385.1 / 400.3 / 441.5 /
349.8ms，中位数 **385.1ms**。按相同单读成本推导，5 次完整物化约 1925.7ms，其中 4 次重复读取
约 1540.6ms；该数字只用于解释上界，不与端到端墙钟强行逐项求和。

实现只在当前 cold-resume operation 内传递第一次读取的 messages/parts；settings、runtime resume、
V4 transcript、parent subagent manifest 和 late usage seed 复用同一数组。没有增加 session cache、TTL、
schema 或 store API。若 runtime 恢复时修补了 `started/retrying` compact timeline，则刷新一次再交给
V4；仅 interrupted compact 修补路径允许刷新到第二次读取。

同一 production fixture、Node 24.14.0、文件缓存预热后，每次启动全新 `app-server --stdio`，5 次
结果如下：

| 实现 | 5 次 subscribe → initial frame | 中位数 | 变化 |
| --- | --- | ---: | ---: |
| 优化前：父 messages 完整物化 5 次 | 4131.1 / 4121.8 / 3849.3 / 3818.9 / 3991.9ms | **3991.9ms** | - |
| 优化后：正常路径单次 operation materialization | 2874.4 / 2714.3 / 2517.5 / 2681.6 / 2531.7ms | **2681.6ms** | **-1310.3ms（-32.8%，约 1.49x）** |

前后共 10 次结果均保持 158038-byte physical frame、29950 total rows、60-row wire window、
`toSeq=74164`、0 running subagents，stderr 为空。frame 内的随机 `logEpoch/subscriptionId` 使整帧
SHA-256 每进程不同，因此结构等价由上述稳定字段与 focused cold-resume snapshot deep-equal 测试
共同验证，不把随机信封 hash 当作回归门禁。

最终 production bundle 再做一次 warmup 后的 5 个 fresh-process 复核，样本为 2162.3 / 2019.0 /
1887.3 / 1980.7 / 2020.9ms，中位数 **2019.0ms**；首帧结构仍全部一致。由于这组与优化前基线
不处于同一缓存状态，只作为最终构建 smoke，不替代上表同条件 A/B 的收益结论。

2026-08-13 使用工作区最新源码和仓库声明的 Node 24.14.0，对 CLI 全依赖图执行强制
production rebuild（15/15 build tasks 成功，0 cache hit）后，再次复核同一 PERF03-E fixture。
数据库先做只读 backup，每个样本从该 backup 创建独立副本；先预热一次，再启动 5 个 fresh
`app-server --stdio` 进程。fixture 仍为 10622 messages / 35811 parts / 1805 checkpoints。

为与上表 3991.9ms / 2681.6ms 的历史 A/B 严格对齐，先沿用当时 runner 的请求顺序：进程启动后
连续写入 provider registry 与 subscribe，并从 subscribe 写入计到完整 initial frame。5 次样本为
2615.2 / 2612.1 / 2663.0 / 2649.4 / 3637.6ms，中位数 **2649.4ms**。相对 2026-08-12 的
post-fix 中位数 2681.6ms 低 32.2ms（-1.2%），确认优化后量级稳定；3991.9ms 仍是历史
pre-fix baseline，本次没有重新构建旧实现，因此不能把二者写成新的同轮 A/B。若仅作历史参考，
3991.9ms → 2649.4ms 对应 -1342.5ms（-33.6%）。

另按当前 production 的实际 preflight 顺序——等待 provider registry ACK 后再 subscribe——测得：

| Production boundary | 5 samples (ms) | Median |
| --- | --- | ---: |
| process → provider-registry ready | 450.4 / 538.9 / 442.5 / 441.4 / 453.0 | **450.4ms** |
| ready → complete initial frame | 2006.4 / 2063.9 / 1785.4 / 1781.1 / 1775.3 | **1785.4ms** |
| process → complete initial frame | 2456.8 / 2602.8 / 2227.9 / 2222.6 / 2228.3 | **2228.3ms** |

两种口径均保持 29950 total rows、60-row wire window、`toSeq=74164`、0 running subagents，
stderr 为空。最新完整 physical NDJSON notification 为 158037 bytes，历史 A/B 记录为 158038
bytes；旧 physical frame artifact 未保留，无法定位这一字节差异，因此本次只确认上述稳定结构
等价，不宣称跨 fresh process 逐字节相同，也不把随机/动态信封 hash 作为回归门禁。

### PERF03-E compact full-history reproduction

2026-08-11 在 Apple M4、10 logical CPU、16 GiB RAM、macOS 15.3.1 上测量。focused spec
`compacted-full-history-cold-hydration.perf.test.ts` 每次启动独立 Vitest 进程，5 次结果如下：

| Metric | Samples (ms) | Median |
| --- | --- | ---: |
| cold merge | 119.8 / 135.1 / 130.5 / 120.3 / 121.6 | 121.6 ms |
| publisher rehydrate | 10067.3 / 12876.1 / 10061.3 / 9997.1 / 10392.3 | 10067.3 ms |
| merge → initial frame | 10189.4 / 13013.9 / 10195.5 / 10119.8 / 10516.2 | 10195.5 ms |

focused 用例固定 10623 persisted messages / 35811 parts、939 active messages / 3523 parts、
1805 checkpoints、77372 merged events 与 30500 rows；五次 initial frame 均为 25016 bytes，
hash 均为 `2ff4f3816dc88f2f050f1ec52c1772fa137f35192f3bd5ec6a55c42afdf8c881`。

2026-08-11 紧邻修复前再次独立复跑 5 次，merge → initial frame 为 10.28～13.63s，
中位数 10.92s；其中 rehydrate 中位数 10.79s。仅在 cold batch hydration 对 subagent
派生输入做 dirty-check 后，最终代码于 2026-08-12 按每次独立 Vitest 进程复跑 5 次：

| Metric | Samples (ms) | Median | 相对紧邻修复前中位数 |
| --- | --- | ---: | ---: |
| cold merge | 117.9 / 135.2 / 119.9 / 119.3 / 120.9 | 119.9 ms | 不属于修复区间 |
| publisher rehydrate | 756.8 / 775.5 / 767.4 / 767.6 / 762.0 | 767.4 ms | -92.9%（约 14.1x） |
| merge → initial frame | 876.9 / 913.0 / 889.5 / 889.2 / 885.2 | 889.2 ms | -91.9%（约 12.3x） |

五次输出继续保持 77372 merged events、30500 rows、25016-byte initial frame 与相同 hash；
说明收益来自跳过无关事件的重复 subagent 全行物化，不是裁剪事件、行或 wire snapshot。

随后只把 `markStableForkAssistant()` 从“复制并反转完整 rows”改为“当前 turn header 后原数组
倒序、命中即停”，在同一工作区修改前后各跑 5 个独立 Vitest 进程。当前 shell 使用
Node 25.6.0，仓库声明 Node 24.14.0，因此以下只作为同机增量诊断：

| Metric | 修改前 samples (ms) / median | 修改后 samples (ms) / median | 中位数变化 |
| --- | --- | --- | ---: |
| publisher rehydrate | 777.0 / 767.7 / 773.2 / 809.6 / 783.5 / **777.0** | 643.8 / 641.4 / 652.9 / 642.2 / 644.6 / **643.8** | -17.1%（-133.2ms） |
| merge → initial frame | 902.1 / 889.5 / 895.5 / 926.8 / 902.5 / **902.1** | 809.7 / 770.4 / 774.0 / 786.5 / 762.6 / **774.0** | -14.2%（-128.1ms） |

两组均保持 77372 events、30500 rows、25016-byte initial frame 和相同 SHA-256；该 slice
没有改动 tool 终态扫描或任何 projection 状态机。

继续将 `closeOpenToolRows()` 的全 rows 扫描替换为由 tool row delta 维护的 foreground-open
派生索引后，同样按 5 个独立进程复跑：

| Metric | 修改前 samples (ms) / median | 修改后 samples (ms) / median | 中位数变化 |
| --- | --- | --- | ---: |
| publisher rehydrate | 643.8 / 641.4 / 652.9 / 642.2 / 644.6 / **643.8** | 352.6 / 354.6 / 351.8 / 355.5 / 358.0 / **354.6** | -44.9%（-289.2ms） |
| merge → initial frame | 809.7 / 770.4 / 774.0 / 786.5 / 762.6 / **774.0** | 470.4 / 479.3 / 471.6 / 481.3 / 482.4 / **479.3** | -38.1%（-294.7ms） |

五次仍保持 77372 events、30500 rows、25016-byte initial frame 和相同 SHA-256；迟到
reopen、rewind、atomic reject/adopt、cold batch/strict 等价由独立状态测试覆盖。
相对紧邻全部修复前的 10.79s rehydrate / 10.92s merge → initial frame，中位数累计下降到
354.6ms / 479.3ms，分别约为 -96.7%（30.4x）和 -95.6%（22.8x）。

继续移除 cold batch payload proof 的固定 32-event 精确测量，并为 no-delta、tail membership
与接近限额的保守估值增加按需路径后，使用仓库声明的 Node 24.14.0 按 5 个独立 Vitest 进程复跑：

| Metric | Samples (ms) | Median |
| --- | --- | ---: |
| cold merge | 112.4 / 115.4 / 129.6 / 117.5 / 115.7 | 115.7 ms |
| publisher rehydrate | 257.9 / 257.3 / 261.7 / 257.8 / 256.1 | **257.8 ms** |
| merge → initial frame | 374.8 / 375.0 / 393.7 / 377.6 / 374.1 | **375.0 ms** |

相对上一段 Node 25 记录的 354.6 / 479.3ms，中位数方向性下降 96.8 / 104.3ms；因 Node 版本
不同，不把该差值作为严格 A/B。五次仍保持 77372 events、30500 rows、25016-byte initial frame
和相同 SHA-256。

2026-08-12 对 CLI 全依赖图执行强制 production rebuild 后，在同一 PERF03-E fixture 上再次按
5 个独立 Node 24.14.0 / Vitest 进程复跑。cold merge 为 123.2 / 115.8 / 118.8 / 145.4 /
137.7ms，中位数 **123.2ms**；publisher rehydrate 为 384.5 / 260.6 / 282.5 / 341.4 /
302.3ms，中位数 **302.3ms**。第一进程偏冷时 rehydrate 也只有 384.5ms；因此此前诊断中的
约 0.95s 不再代表当前 rehydrate 热点。五次仍保持 77372 events、30500 rows、25016-byte
initial frame 和相同 SHA-256。

同一强制 rebuild 的 production bundle 采用只读备份数据库，先预热一次、再启动 5 个 fresh
`app-server --stdio` 进程；每次均先完成 provider registry preflight，再计
`ready → v4/conversation/subscribe → initial frame`。正式样本为 1875.7 / 2992.4 /
1899.5 / 2875.8 / 2043.0ms，中位数 **2043.0ms**；`process → initial frame` 中位数
**2531.8ms**。本轮机器存在明显调度噪声，所以下表同时保留五次样本和中位数；各行是日志/协议
边界，不应直接相加成单次虚构 timeline：

| Production stage | 5 samples (ms) | Median | 说明 |
| --- | --- | ---: | --- |
| process → provider-registry ready | 455.7 / 427.8 / 463.4 / 454.4 / 488.7 | **455.7** | fresh process 与协议/registry preflight |
| subscribe → runtime preferences request | 309.6 / 590.9 / 306.3 / 322.1 / 307.9 | **309.6** | 首次完整 message/part 物化和 settings 推导发生在该请求前 |
| runtime preferences response → app startup start | 2 / 20 / 2 / 2 / 2 | **2** | host 应答后立即构造 app |
| app startup | 116 / 567 / 141 / 125 / 123 | **125** | config/plugins/adapters/runtime 构造；一轮受调度抖动影响 |
| app completed → user-execution preferences request | 56 / 107 / 59 / 72 / 58 | **59** | model/settings reconcile 后进入 resume shell boundary |
| user-execution preferences response → `session.resumed` | 187 / 291 / 157 / 178 / 157 | **178** | context 初始化并复用已物化 active tail，恢复 939 messages / 3523 parts |
| `session.resumed` → three-source merge completed | 197 / 322 / 181 / 198 / 257 | **198** | durable transcript/event 合成与 cold merge；日志点在 merge 后 |
| merge completed → subscribe ACK | 995.7 / 1088.4 / 1040.3 / 1961.6 / 1125.4 | **1088.4** | 复合区间：rehydrate、subagent/usage seed、snapshot/ACK 编码；不是纯 rehydrate |
| ACK → complete initial frame | 13.0 / 15.1 / 13.1 / 17.2 / 13.6 | **13.6** | physical NDJSON frame 出站 |

五次首帧均为 157746 bytes、29950 total rows、60-row wire window、`toSeq=74164`、0 running
subagents；随机 `logEpoch/subscriptionId` 仍使信封 hash 每进程不同。单次 SQLite
`messages()` 只读备份采样为 315.9 / 340.4 / 312.4 / 366.0 / 296.1ms，中位数
**315.9ms**，与 subscribe 前首次物化区间量级吻合。当前 production 最大可见剩余区间是
merge 后约 1.09s 的复合工作，不能再把它标成 0.95s rehydrate；focused rehydrate 应按本轮
**约 0.26～0.38s、中位数 0.30s** 记录。

以下仅记录本轮三项 projection 优化之前的 production baseline，
不是当前实现结果。持久 fixture `sess_perf_large_20260811150224_4929c823` 含 10622 messages /
35811 parts，active tail 精确为 939 messages / 3523 parts，并含 1805 checkpoints。production
`app-server --stdio` 文件缓存预热后，每次启动全新进程，5 次 cold subscribe → initial frame 为
17523.7 / 16875.4 / 17984.8 / 17560.2 / 17101.6 ms，中位数 **17523.7 ms**。每次均收到完整
157745-byte snapshot、29950 total rows、60-row wire window、0 running subagents。运行时日志同时
确认 resume 只应用 939/3523 active tail，而 cold merge 仍保留 1805 个 checkpoint；该 fixture
因此在真实 SQLite + production 协议路径上稳定复现了用户感知约 20 秒的同类卡顿。

三项 projection 优化完成后，使用 Node 24.14.0 运行同一 production bundle；文件缓存预热后，
每次启动全新 `app-server --stdio`，5 次 cold subscribe → initial frame 为
5802.0 / 5721.8 / 5449.4 / 5467.4 / 5356.8 ms，中位数 **5467.4 ms**。相对上述修复前
中位数下降 12056.3 ms（-68.8%，约 3.2x）。五次均保持 157745-byte snapshot、29950 total
rows、60-row wire window、0 running subagents 与 `toSeq=74164`，production fresh-process
端到端结果已验证。focused 479.3 ms 与 production 5467.4 ms 的差值仍包含 Agent runtime
activation、真实 SQLite 读取、transcript/event 合成及协议进程启动，不属于本轮三个 projection
热点的剩余耗时断言。

### Persisted 2000-turn fixture

fixture `sess_perf_large_20260714130421_2dee7a7b` 含 2000 turns、4000 messages、13339 parts、4000 tool parts 和 60 todos。基线 artifact 位于 `packages/desktop/.e2e-artifacts/large-task-2000-turns-20260714/`。

| Implementation checkpoint                    | `subscribeConversationV4` | Observation                                                                                   |
| -------------------------------------------- | -------------------------: | --------------------------------------------------------------------------------------------- |
| 原实现                                       |           > 180023.4 ms     | 180 s timeout；持久化 resume/read 仅 737 ms，CLI 单核满载，renderer 尚未收到 conversation body |
| 只移除 action 嵌套扫描，payload proof 回退严格路径 |              67913.4 ms | 证明主要剩余成本仍是逐事件 immutable snapshot apply/serialization                             |
| 每事件精确测量 60-row wire tail              |              12571.5 ms | 已消除全历史 snapshot 序列化，但测量频率仍过高                                                |
| 固定 32-event 窗口测量 bounded wire tail     |               1817.2 ms | persistence resume 约 624 ms；CDP 首屏已收到正文，viewport 中存在 21 个虚拟化 row              |

相对 180 秒 timeout 下界，最终同 fixture 至少快约 99 倍；其中 V4 subscribe 阶段不再掩盖约 0.6-0.7 秒的持久化读取成本。

### Synthetic tool-heavy scaling

每 turn 合成 user、assistant text、tool input、tool scheduled、tool result 和 terminal 共 8 个事件；先 warm-up，再各运行 3 次取中位数。

| Turns | Events | Median   | Samples (ms)          | Growth ratio |
| ----: | -----: | -------: | --------------------- | -----------: |
|   500 |   4001 |  37.4 ms | 39.5 / 37.4 / 35.8    |            - |
|  1000 |   8001 |  68.2 ms | 70.7 / 68.2 / 66.7    |        1.82x |
|  2000 |  16001 | 137.6 ms | 142.7 / 136.8 / 137.6 |        2.02x |

turn/event 翻倍时耗时约翻倍，未再呈现原先的平方增长趋势。synthetic 数字只测 `ConversationTopicPublisher.rehydrate`，因此小于包含 SQLite、RPC、Electron 调度和 renderer 首帧的端到端数字。

### 2026-07-24 runtime activation / legacy snapshot 解耦

另一个 1,000-turn fixture `sess_perf_large_20260724034221_af2e36b8` 含 2,000 messages、
6,671 parts、2,000 tool parts、334 reasoning、200 patch 与 60 todos。每次测量启动全新 production
`app-server`；改动前 HEAD 与当前源码分别独立构建，文件缓存预热后各取三次。

| 实现 | 三次 cold subscribe → initial frame | 中位数 | frame bytes |
| --- | --- | ---: | ---: |
| 改动前 full legacy snapshot × 2 | 3352.1 / 3169.5 / 3070.2 ms | 3169.5 ms | 143,690 |
| activation-only + usage 窄投影 | 2704.8 / 2701.5 / 2607.6 ms | 2701.5 ms | 143,690 |

中位数下降 468.0 ms（14.8%），且首帧字节完全一致。该结果只证明去掉重复 legacy projection 的
本机收益；剩余约 2.7s 仍包含 Agent runtime activation、持久 transcript 读取/合成、V4 projection
rehydration 与 wire 编码，不应归因成单一阶段。具体职责边界与功能不变量见
[`17-cold-resume-runtime-activation.md`](../v4-refactor/17-cold-resume-runtime-activation.md)。

## 本地性能 fixture 的工作区身份

`zcode-large-task-fixture` 生成的本地会话必须与真实本地会话使用相同的身份约定：
CLI `session.workspace_id` 留空，`directory` / `path` 保存工作区绝对路径；App 任务索引的
`workspace_identity` 留空，`workspace_key` / `workspace_path` 使用同一路径。
manifest 中的 `workspaceHash` 仅供 fixture 标识使用，不能写入显式工作区身份字段，否则
冷恢复会将哈希与本地路径比较并报 `project.session-lineage-invalid`。

回归场景：在临时目录中使用当前两库 schema 生成 fixture，检查两库工作区身份一致且
消息、内容片段正常落盘。修复旧 fixture 时先备份，只修正已确认的错误身份，不改变会话
目录、正文或项目组织态；随后用真实 CLI 验证冷恢复。

## E2E Handoff Notes

- Provider fixture: 不需要；使用 `zcode-large-task-fixture` 直接构造持久 conversation。
- File-system fixture: 无。
- Timing strategy: 单独 manual performance run；focused benchmark 只守复杂度趋势，避免 CI 绝对墙钟抖动。
- Docker preset: 不进入常规 conversation suite。
- Review risks: payload fallback、snapshot recovery boundary、row actions/command target 的 strict-vs-batch 等价。
