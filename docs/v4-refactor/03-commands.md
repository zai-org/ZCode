# V4 Command 模型当前规格

更新日期：2026-08-25

所有 conversation 写操作都通过 `v4/command` 进入 CLI。schema 位于
`packages/shared/src/zcode-protocol-v4/command.ts`，admission 位于
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`，业务 handler 位于
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/`。

## 信封与单写者

```text
client command
  { commandId, clientId, sessionId, baseRevision?, baseLogEpoch?, type, payload, issuedAt }
       |
       v
CLI CommandInbox
  -> schema / epoch / revision / row target / product guard
  -> per-session FIFO admission
  -> native V4 handler
  -> ACK
  -> canonical fact + projection delta
       |
       `-> 所有订阅端按同一权威顺序收口
```

- `commandId` 由客户端生成，重试时保持不变；
- `issuedAt` 只用于遥测，不能参与定序或冲突裁决；
- CAS 命令必须带 `baseRevision`；row-targeting 命令还必须带 `baseLogEpoch`；
- `createSession` 的 `sessionId` 为 `null`，成功 ACK 返回真实 session id；
- 客户端是意图提议者，CLI 是唯一写者。不同客户端的命令按 CLI 实际 admission 顺序串行。

命令全集以 `commandPayloadSchemas` 为准，目前包括 session 创建/删除/重命名、输入与 goal、stop、
compact、fork/edit/retry/file rewind、queue 操作、interaction 应答与 snooze、模型/模式/followup 切换、
goal pause/resume 和 background work 取消。文档不得再把 legacy `session/*` operation 当作 V4 UI 写入口。

## ACK 语义

ACK 状态是：

- `accepted`：命令已被当前 CLI 接受；
- `rejected`：schema、guard 或目标不允许；
- `stale`：epoch/revision/row target 已过期；
- `duplicate`：同一 command 已有结果；
- `noop`：命令合法但事实已经处于目标状态；
- `failed`：命令执行失败。

ACK 不是 projection snapshot，也不替代后续 topic 更新。UI 的长期状态必须由 projection 收口；
`sourceCommandId` 用于把权威 row/marker 与本地 overlay 对齐。fork、create session、interaction 等需要
立即导航或展示结果的命令可在 ACK 的 `result` 中返回最小结果。

## 内存 inbox 与持久事实

CommandInbox 本身是内存结构：

- in-flight 与 live input 永远 pinned；
- settled ACK 按 session 放入有界 LRU；
- CLI 重启不会恢复一张“待执行 command inbox 表”，也不会盲目重放命令。

跨重启幂等依赖命令已经产生的持久事实，而不是持久化 inbox：

1. transcript message anchor 的 `sourceCommandId`；
2. timeline part 的 `sourceCommandId`；
3. child/fork command fact；
4. `session_input` ledger 的 promoted/cancelled/discarded/failed 终态。

`v4/commands/query` 先查内存 pinned/LRU，再按以上来源精确查找。查不到返回 `unknown`，由客户端展示并
让用户决定是否重发；禁止静默重发 stop、fork、输入等有副作用命令。

session bucket 的查询项可带可选的 `turn: { turnId, state }`：owner 全量投影中 `sourceCommandId` 等于该
commandId 的第一个 `turnHeader`（与客户端在尾窗中的匹配规则相同）。快照只下发尾窗，长回合的 header 可能不在窗口里；客户端用它判定
命令对应回合的当前状态，尾窗中有该行时以尾窗为准。global bucket 不带该字段。

`session_input` 是输入生命周期账本，不是可恢复执行队列。`startNow`、`queue`、`guide` 在执行前都先
durable admission；promotion 与 user message 持久化原子关联。CLI 重启时仍处于 `admitted` 的输入会
明确转为 `discarded(session_resumed)`，防止输入静默蒸发或被自动重复执行。

## Queue 与阻塞交互

运行中的 accepted input 由 CLI runtime command queue 承载，renderer 不再建立第二个 busy queue。
queue item 保留 `sourceCommandId`、附件、client、admission order 与 dispatch 状态；desktop 与 mobile
共享事实，但各自仍遵守 continuous/replayable 投递边界。

permission、elicitation 与 AskUserQuestion 作为 `pendingInteractions` 投影。客户端通过
`resolveInteraction` 应答；先到者生效，重复或迟到操作幂等收口。owner/lease 仍负责跨 host 命令
路由、阻塞响应和 stale-run 防护，不能因 shared-host attachment 存在而删除。

### Prompt admission 与 turn 调度

`CommandInbox` 负责每个 session 的命令 FIFO、幂等和 `session_input` admission；它不负责判断
runtime 当前能否启动 turn。这个判断只由对应的 `AgentRuntime` 实例原子完成：

```text
Session A                         Session B
  CommandInbox -> Core admission    CommandInbox -> Core admission
       idle -> reservation/start         idle -> reservation/start
       busy -> existing Core FIFO        busy -> existing Core FIFO
```

- 同一个 session 同时最多有一个前台 turn。`activeTurn`、`activeTurnStartReservation`、
  `activeForegroundExecution`、runtime command drain 和已有 runtime 命令都属于 Core 的 busy
  边界；不能先由 Bootstrap 查询这些状态，再自行决定 start 或 queue。
- 不同 session 使用各自的 `AgentRuntime` 状态和 runtime FIFO，可以并行执行；一个 session 的
  provider/网络卡住不能阻塞另一个 session。
- Core admission 返回 `started`、`queued` 或 `rejected` receipt。`started` 只表示 reservation
  已建立并且 prompt command 已进入该 runtime 的执行队列；模型执行、`TurnStarted` 事件和
  projection 更新继续通过现有事件流异步完成。
- `TurnStarted` 的 `inputId/sourceCommandId` 用于后续事件关联，`messageId` 可以不出现在初始
  ACK 中。projection commit 不是 prompt admission ACK 的边界，也不是 session busy/idle 的事实。
- reservation、active turn 和 foreground execution 统一由 Core turn 的 `finally` 释放。Bootstrap
  的 controller 不能被用来推断 Core 已 idle；Stop 优先调用 Core 的
  `stopActiveForegroundExecution`。
- 桌面端 `desktop-continuous` 继续消费 Core 的实时事件流；手机端 `web-remote-replayable`
  继续通过 snapshot/gap 恢复同一个 Core 队列。两者只是 delivery/recovery 语义不同，不各自
  维护 prompt queue，也不把队列状态下沉到 relay 或 renderer。

## Optimistic overlay 纪律

- overlay 只存在于发起端局部 UI，不进入 projection store；
- overlay 只按 `commandId` 被权威事实覆盖，不和权威 row 合并；
- 发起端也必须消费自己的订阅帧；
- `sendText` 的 `accepted|duplicate` ACK 只启动一次投影确认窗口：同
  `sourceCommandId` 的 queue item 或 real-user `userInput` row 出现即收口；窗口超时只复用当前
  owned subscription 的 same-sub resync，禁止补造消息、建立第二队列或自动重放 command；
- 断线时保留 draft，但不接受离线 command queue；
- transport 恢复不能改变命令的 admission/queue 顺序。
