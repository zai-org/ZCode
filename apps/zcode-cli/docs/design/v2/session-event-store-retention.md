# Session Event Store 保留策略（内存 event store 的 turn 窗口淘汰）

状态：**已确认，按本 spec 实现**

## 问题

每个 ZCode Protocol session record 持有一个进程内 `InMemorySessionEventStore`。它承担两件事：
为每条 `SessionEvent` 分配 `sequenceNumber`（live / replay / snapshot 的唯一顺序事实源），以及给
legacy 回放、V4 冷恢复、rewind / fork / checkpoint 提供事件读取。

问题在于它把 `model_streaming`（逐 token）、`tool_call_progress` 等与消息流同频的瞬态事件永久驻留，
`append` 还每次 `[...events, e]` 全量拷贝。session 驻留期间内存按 token 线性增长，GC 压力按 O(n²)
增长；桌面端 legacy `session/subscribe` 又让 session 常驻不回收，两者叠加就是"越用越大"。

## 结论

只改**保留策略**，不改 `SessionEventStorePort` 接口、不改序号分配位置、不改 live sink 收到的对象。

1. `append` 原地 `push`；`getLatestSequenceNumber` 由独立单调计数器返回，不再取"最后一个仍驻留的事件"。
2. 瞬态事件（`TRANSIENT_SESSION_EVENT_TYPES`）按 `turnId` 分桶。turn 结束（`turn_complete` / `turn_error`）
   后**不立刻**淘汰；下一个 `turn_started` 到达时淘汰所有已结束 turn 的瞬态桶（一 turn 滞后）。
3. 时间兜底：已结束 turn 若在 `SEALED_TURN_TRANSIENT_GRACE_MS = 120_000` 内没有后继 turn，由协议 server 借既有
   60s 资源采样节拍调用 `pruneSessionEventStores()` 淘汰。原因是 subagent 子 session 只有一个 turn，永远等不到
   下一个 `turn_started`；真机上一次子 session 曾留下约 1 万条 delta 直到 record 被池子回收。进行中 turn 不受影响。
4. 非瞬态事件保留条数，但淘汰 sealed turn 时对其 `model_request` 做**元数据瘦身**（见下节），其余非瞬态事件原样永久保留。
5. session record 释放（`session/close`、创建失败、idle 去激活）时调用 `deleteSession`。
6. 保留模式是构造参数：`turn-window`（默认）与 `unbounded`（回滚 / 对照测试）。

### model_request 元数据瘦身（2026-09-30 修订）

原第 4 条写"非瞬态事件数量与消息同阶，本身有 compact 边界"，实测不成立：`model_request.payload.messages`
是每次请求发给模型的**完整上下文**，每个工具迭代一条，compact 只截断后续请求的上下文，不会回收已驻留的旧事件。
同一 session 214 轮（99 次 compact）实测 CLI GC 后堆从 102MB 线性涨到 264MB，event store 驻留增长约 150MB，
主体就是这些历史请求的 messages。

内存 store 里 `messages` 没有读者：

| 读者 | 用到的字段 |
| --- | --- |
| `bootstrap/src/zcode-protocol/session-mapper.ts mapModelRequestPayload` | 只用 `messages.length`（且注释明确不向桌面推全量上下文） |
| `core/src/runtime/methods/usage-observability.ts` | 只用 timestamp |
| `tui/src/app-events.ts` | 只设状态 |
| `server-operations.ts` title 过滤 | 只用 `querySource` |
| debug analyzer（`packages/debug/server`） | 读 event sink 写出的 JSONL，**不读内存 store**；live sink 仍收到完整事件 |
| rewind / fork / checkpoint / V4 投影 | 不消费 `model_request` |

规则：`turn-window` 策略淘汰 sealed turn（同一 turn 滞后 / 时间兜底节拍）时，把该 turn 的 `model_request`
驻留副本替换为 `payload` 去掉 `messages`、补 `messageCount` 的新对象（`slimRetainedModelRequest`）；事件本身、
`sequenceNumber`、其它 payload 字段不变，`append` 返回给 live sink 的对象不变。进行中 turn 与 `unbounded`
模式保持完整 messages（测试替身与对照测试依赖它断言请求轨迹）。`mapModelRequestPayload` 优先读 `messageCount`，
兼容旧的完整 payload。

### 为什么滞后一个 turn

`appendEvent` 先 `eventStore.append`，再把消息落 sqlite，再通知 live sink。turn 刚结束时消息可能还没落盘；
V4 冷恢复对未持久化的 turn 会回退到内存瞬态事件拼文本。等到下一个 turn 开始（用户又发了消息），上一个
turn 的消息必定已经持久化，此时淘汰是安全的，且不需要把持久化结果反馈给 store。代价是内存里始终多保留
一个已完成 turn 的瞬态事件，是有界常数。

## 时序

```text
turn 1 started ──► delta ×N ──► model_complete ──► turn_complete ──► turn 2 started ──► ...
     │               │                                   │                 │
     │  retain       │  retain (turn 1 open)             │ seal turn 1     │ evict turn 1 transient
     │               │                                   │ (仍保留)         │ open turn 2
seq  1               2..N+1                              N+3               N+4 (计数器不回退)
```

## 合同（实现前逐条核实过的依赖）

| 依赖 | 出处 | 约束 |
| --- | --- | --- |
| seq 单一来源 | `core/src/runtime/methods/events.ts` `appendEvent`；`v4-gateway.ts normalizeRuntimeEventSequence` 按 raw seq 连续 drain | 瞬态事件仍经 store 分配 seq 并原样交给 live sink |
| `getLatestSequenceNumber()+1` 追加新事件 | `assistant-feedback-persistence.ts`、`v4-bridge.ts` | 序号来自独立计数器，淘汰不回退 |
| V4 冷恢复游标 | `v4-bridge.ts loadPersistedEvents`：原用 `max(events.sequenceNumber)` | 改为与 `getEvents` 同步取 `getLatestSequenceNumber`（`Promise.all`，两次调用之间无 await，快照一致） |
| legacy 协议 seq | `server-operations.ts getProtocolEventSeq` 用 record 级 `seqBySourceEventKey / lastSeq` | 已淘汰事件的协议 seq 仍保留在 record 上，回放只是跳过它们，seq 连续单调 |
| V4 投影 | `product-projection.ts` 只在 `isRunning()` 消费 `model_streaming`；`cold-event-merge.ts` 把 `model_streaming / model_complete` 列为 transcript-derived，已完成 turn 由 `transcript-hydration.ts synthesizeEventsFromMessages` 从消息合成 | 进行中 turn 必须保留；已完成且已持久化 turn 的瞬态事件冗余 |
| `model_complete.content` 携带全文 | `contracts/src/events/session.events.ts` | 完成 turn 的文本不依赖 delta |
| reducer / rewind / fork / checkpoint / file-changes / subagent 子会话 | 各消费者只 filter 低频类型 | 不受影响 |
| legacy 回放 `session/events` / `session/subscribe afterSeq` | `server-operations.ts readProtocolSessionEvents` | **行为变化**：已完成 turn 的 `model.streaming` 合批不再回放；legacy 文本一直来自 snapshot messages / `session/messages`，`ModelComplete` 本身不映射为协议事件 |

## 瞬态事件集合

`TRANSIENT_SESSION_EVENT_TYPES = { model_streaming, tool_call_progress, streaming_tool_ledger_updated, model_network_status }`，
单一出处 `@zcode/contracts`。新增事件类型时若与消息流同频，必须同时加入该集合并补 reducer 忽略断言。

## 调用与回放缓存的独立释放边界

- V4 raw event 缓存入库时复用 `slimRetainedModelRequest`，保留 ID、序号和 messageCount，不修改完整 live 输入。EventStore 替换对象不能释放其它缓存已持有的旧对象，每个持有者必须自行瘦身。
- 每次模型调用拥有可释放的 status sink。成功、异常、取消离开作用域时清除 runtime、events 和回调引用。ALS 拷贝可以保留 sink 外壳，不能延长 turn 数据寿命。释放后的迟到状态不再写入；释放前已进入 publish 的操作可以完成。
- 普通调用、compact、标题、目标验证、workspace 文本生成和 sampling 使用相同释放边界。
- 回归覆盖 raw cache 与 live 输入隔离、连续序号、结束后的迟到状态，以及保留 sink 外壳时 events/runtime 可被 GC 回收。

## 观测

`getStats()` 返回 `sessions / events / evictedEvents / retainedTransient`，随进程内存本地诊断日志
（仓库根 `docs/monitoring/memory-diagnostics-log.md`）写入 `eventRows / eventEvicted / eventTransientRetained`，
线上可直接验证策略生效。

## 实现

- `packages/contracts/src/events/session-event-retention.ts`：瞬态集合 + 纯状态机策略
- `packages/contracts/src/events/in-memory-session-event-store.ts`：store 实现（`@zcode/adapters/storage` 继续 re-export 同名工厂）
- `packages/bootstrap/src/zcode-protocol/server-types.ts`：`deps.createSessionEventStore(sessionId)` 注入点，默认 turn-window
- `packages/bootstrap/src/zcode-protocol/server-operations.ts` / `session-residency.ts`：record 释放调 `deleteSession`
- `packages/bootstrap/src/zcode-protocol/v4-bridge.ts`：冷恢复游标改读计数器
- `packages/core/tests/test-event-store.ts`：测试替身改为复用 contracts 实现（`unbounded`），消除替身漂移

## 验收 Case

| Case | Setup | Assertions |
| --- | --- | --- |
| RET-001 | turn-window 策略 | turn 进行中的瞬态事件 retain；`turn_complete` 后不淘汰；`turn_started(T+1)` 淘汰 T；非瞬态永不淘汰；`rewind_triggered` 不触发淘汰 |
| RET-002 | store 追加并淘汰 | `getLatestSequenceNumber` 不回退；`append` 返回 seq 严格递增；`getEvents` 按 seq 有序 |
| RET-003 | store | `getEventsAfter` 只含窗口内瞬态 ∪ 全部非瞬态；`deleteSession` 后 `getStats` 归零 |
| RET-004 | unbounded 与 turn-window 跑同一事件序列 | 非瞬态事件与 seq 完全相同，仅瞬态数量不同 |
| RET-005 | 50 turn × 200 delta | `getStats().events ≤ 非瞬态 + 2 turn 的瞬态` |
| RET-006 | 协议 server + fake app | 注入的 `createSessionEventStore` 被使用；`session/close` 后 `deleteSession` 被调用 |
| RET-007 | 协议 server 两个 turn | 第一次 `session/events` 含 turn 1 delta；turn 2 开始后回放不含 turn 1 delta，seq 严格递增，`eventSeq` 不回退 |
| RET-008 | 策略：sealed turn 无后继 | `collectExpired` 在 grace 内为空，超过 grace 交出该 turn 且只交一次；后继 turn 先到时不再重复交出 |
| RET-009 | store：一次性 session | `pruneTransientEvents` 在 grace 后淘汰其瞬态事件，序号不回退；进行中 turn 不受影响 |
| RET-010 | 协议 server：turn 结束无后继 | `pruneSessionEventStores(now + 3min)` 淘汰该 turn 的 delta，`session/events` 回放不再含 `model.streaming` |
| RET-011 | store：turn-window 两个 turn | turn 2 开始后 turn 1 的 `model_request` 无 `messages`、`messageCount` 等于原长度、其它字段与 seq 不变；turn 2 的 `model_request` 仍含完整 messages；`append` 返回对象含完整 messages；unbounded 模式不瘦身 |
| RET-012 | session-mapper | 瘦身后的 payload 映射出的 `messageCount` 与完整 payload 相同 |
