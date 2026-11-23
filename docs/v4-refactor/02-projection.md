# Conversation Product Projection 当前实现

更新日期：2026-10-29

Activity 长历史恢复：持久化查询按父会话索引定位 run，actor 沿 run 索引读取；仅本会话历史影响结果规模。同一 child 恢复使用 outcome 非终态点更新，不触发 TransactionalMap 删除既有键时的全表备份；非终态不计成功，之后真实终态替换该值。只有真实身份移除／回退才删除键，完整 seed 仍可重建索引。回归独立检查实际 Map 迭代复制次数及成功数，包含候选拒绝／异常后的全状态一致、再次结算和两种 delivery profile 重连。

Activity 增量发布回归约束：完整成功计数与有界预览分别比较并在同一事务发布。第 101 个结束 child 的有效状态更新即使未改变最近 100 条预览，仍发布 `completedActivityCount`；候选拒绝或抛错时索引与计数一起回滚。continuous/replayable 的增量与重连 snapshot 均验证 100→101。普通 Bash 后台启动、结束若未改变受阻 child 身份集合，不重建子代理投影；真实 child 阻塞／解除仍更新状态。万级历史回归禁止无关 Bash 事件遍历或写入完整 outcome 索引。

`ConversationProductProjection` 是 CLI 面向 App/Web 的会话读模型。产品语义以
[conversation-product-protocol.md](../conversation-product-protocol.md) 为准，wire schema 以
`packages/shared/src/zcode-protocol-v4/` 为准；本文说明当前代码如何从 runtime 事实生成并恢复该投影。

## 回退后的完整 child 身份

conversation rewind 由 Core 在提交分支截断后发布 `removedMessageIds`，内容仅为截断前活动分支的实际后缀。冷恢复 child 校验种子同时保留该 child 在活动分支上的全部来源消息 ID；来源来自同一个候选解析器，包括旧 `part.state.metadata` 与 live relation。来源只保存在 CLI 结果索引，不增加 App wire 字段。

完整计数不能以“没有可见行”为删除依据。回退时仅删除来源全部被撤销且没有保留行的 child；较早来源仍有效的 child 保留。多次引用同一 child 时保留未撤销来源，真实行删除仍撤销没有持久来源的 live child。旧事件缺少来源清单时仅凭明确的行删除撤销对应 live 身份，不推测无行历史已被删除。来源更新、结果、数量与 delta 在同一候选事务提交或回滚，不异步补种、不引入等待定时器。

回归同时覆盖：旧无行成功保留、新无行及有行 child 删除、同身份跨轮引用、连续回退、拒绝与异常回滚，以及 continuous/replayable 增量和重连与活动分支冷种子的计数一致。

## 权威链路

```text
runtime SessionEvent / persisted transcript
  -> event-normalizer.ts             统一 live/cold 的 canonical fact
  -> ProductProjection               归约 control/config/queue/rows 等产品态
  -> ConversationTopicPublisher      生成 snapshot/delta、seq、logEpoch
  -> Host connection scope           只做订阅 ownership 与 frame 转发
  -> ConversationProjectionStore     原子 apply，不重新解释业务事件
  -> SessionPane                     按 rows 与显式 availability 渲染
```

当前实现入口：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/event-normalizer.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `packages/ui/src/v4/conversationProjectionStore.ts`
- `packages/ui/src/v4/sessionDataLayer.ts`

## 投影拥有的状态

snapshot 的 A 区显式承载：

- `control`：phase、stop 状态、active works、最近错误与 API retry；
- `availability`：fork、compact、模型/模式切换、queue 操作、goal 操作是否可用；
- `inputRouting`：`startNow | enqueue | guide | reject | choice`；
- `meta`、`config`、`usage`；
- `queue`、`pendingInteractions`、`pendingCommands`、`backgroundWorks`；
- `goal`、`plan`；
- `rows` 与窗口信息。

UI 不得再从消息数组、最后一条消息、tool 状态或本地 task runtime 推导这些字段。renderer 只拥有
draft、焦点、滚动、布局以及按 `commandId` 关联的临时 optimistic overlay。

## 五种 delta

增量集合是封闭的：

```text
row.appended { row }
row.upserted { row }
row.removed  { fromRowId }
row.delta    { rowId, path, append }
state.updated { patch }
```

`state.updated` 对键整体替换，禁止深合并；`row.removed` 从指定 rowId 起截断。无法由这五种操作
无歧义表达的结构变化必须触发 snapshot/resync，不能在客户端新增修补算法。

每个用户输入、timeline marker 或 child-session 事实尽量保留 `sourceCommandId`。它是命令去重、
ACK 丢失后的 `commands/query` 以及 optimistic overlay 收口的共同锚点。

## Live 与 cold 恢复

CLI 事件日志是进程内有界日志，不是跨重启的持久化事实。正常运行时，publisher 从 live canonical
events 增量推进 projection；CLI 重启或首次冷订阅时，`transcript-hydration.ts` 从持久化的
message/part、timeline part、session input ledger 与 session metadata 合成等价事件，再交回同一个
normalizer/projection。

因此当前保证是“同一份持久事实恢复到相同产品终态”，不是“任意历史 revision 都可回溯”。如果
live 日志只覆盖部分 transcript，gateway 会按 footprint 检查选择完整 hydration/merge，禁止在 UI
旁路渲染数据库消息。

## 命令 actions 的物化时机

行上的 `actions`（`canEdit` 及其 `editDisposition`、`canRetry`、`canFork`、`canRewindFiles`）与快照的
`availability` 由 `materializeCommandRowActions` 生成：每个 live 事件归约后，对“当前快照 + 本事件 delta”
（prospective）整窗计算，变化的行以 `row.upserted` 一并发出，`availability` 变化时追加一条
`state.updated`，并同步更新命令层使用的当前可编辑目标。edit/retry/fork target 的侧表由 reducer 登记，
不在这里生成。strict replay 逐事件走同一规则；cold batch hydration 期间不逐事件物化，只在结束时收敛一次。

例外：事件是对已打开流式行的追加，且本事件归约结果只有 `row.delta` 或为空，跳过物化。归约结果为空
的情况有三种：文件工具预览被节流；文件工具在节流窗口外，但累积内容与本次 delta 都为空；工具输入已
定稿后迟到的原始流。“已打开流式行的追加”与 publisher
快路径用同一个判据 `establishedStreamingAppend(event) !== null`，即 running 或 prewarming 状态下，
已打开 text/reasoning 行的 delta 和已登记工具行的 input delta。这类追加若同时带出其他增量（例如清除
`apiRetry` 的 `state.updated`、subagent 增量），照常物化。

- 等价理由：行 actions 读取 prospective 行的种类、状态、轮次、userInput 的 `origin`、rowId 顺序与现有
  `actions`，turnHeader 的 `fileChanges.state`，`control.activeWorks`（只看是否有 compact 或任一 active
  work，用于 edit/retry），以及 messageId / entityId / edit target / turnHeader 四张侧表；`availability`
  读取 `control.phase`、`control.activeWorks`、`goal.status`、`queue` 与 `pendingInteractions`。输出行
  `actions`、`availability` 并更新当前可编辑目标。`row.delta` 只追加文本字段，流式追加路径也不写这些侧表，
  所以物化结果必为空、可编辑目标不变。
- 前提：事件到达前 actions 与 `availability` 已与当前状态一致。现在由三点保证：其他 live 事件都会物化；
  cold batch 结束时收敛一次；事件之外的写入方（`seed*`、`setRuntimeInitialization`）都不改写上述输入。
- 原因：此前每个 token 都整窗物化，长会话流式输出时每个事件的 CLI 成本随历史线性增长。以下数字来自
  Node 合成回放（每轮 3 行，临时脚本未入库，只作量级参考），`ProductProjection.applyEvent` 处理一个
  text_delta：3000 行 473µs → 16µs，8100 行 1319µs → 36µs，24000 行 4924µs → 166µs。剩余成本基本是
  不可变 apply 复制 `rows.window`（同规模约 21 / 39 / 152µs），属于 snapshot 表示的线性成本，不在本规则
  范围内。
- 约束：新增只产生 `row.delta` 的 reducer 若同时改写上述任一输入，必须让它不满足这个判据；在事件之外
  改写这些输入的写入方必须自己物化。否则 actions 与 `availability` 会停在旧值。
- 整窗物化本身：turnHeader、每轮最新 assistant 和 retry 所需的本轮首条 realUser 行在同一遍正向扫描里收集；
  逐行由 `nextRowActions` 先快速证明 actions 不变，证明不了才展开对象并做 JSON 比较，输出与原实现完全一致。
  每种行的 action 分组（`*_ACTION_GROUPS`）只定义一次，快速判等与慢路径共用，分组与键的顺序决定 JSON 键序。
  给已有 action 增加写入的键只改分组常量；新增 action 还要在物化里算出开关，按分组位置传入。Node 合成回放
  10800 行、运行中时，同一进程交替测量单次物化约 4.6ms → 1.25ms（绝对值随机器负载变化，倍数约 3.7）。
- 回归：`apps/zcode-cli/packages/bootstrap/tests/product-projection-streaming-actions.test.ts`。
  逐事件断言哪些事件不调用物化，以锁定判据；同时与总是物化的参考投影比较 delta、snapshot 与 edit
  target，防止输出回归。参考比较能抓到“只产 `row.delta` 却改写侧表”而让 `canEdit` 或历史轮 `canFork`
  变化的回归；运行中的轮次里 `canRetry` 和本轮 `canFork`、`canRewindFiles` 本来就关闭，参考比较分辨
  不出判据宽窄，这一点由调用断言锁定。

## 原子事件事务

Activity 的完整 child/run outcome 和 actor 归属也纳入按写入记录的事务；actor 归属
使用值为 true 的事务 Map，复用已有机制。派生成功总数随候选复制标量、接受后采用，
拒绝或异常不污染原值。普通 Workflow 节点、文本和非子代理工具流更新不遍历完整活动索引；生命周期变更和
首次 actor 归属按单个身份的前后贡献更新计数。完整 child 种子替换可以批量重算。
回归必须覆盖万级历史下的迭代次数、重复/旧事件、同 run 恢复、actor 去重，以及
候选拒绝和抛错后的索引/水位/计数一致性。该约束适用于 continuous 和 replayable 的共同投影。

publisher 对不能用字节上界放行的事件走 `applyEventAtomically`：在候选投影上归约，accept（16MiB 帧上限）
通过才提交；拒绝、accept 抛错或归约抛错时，当前投影保持不变，客户端仍能从最后一个可传输快照恢复。

- 最大的八张侧表（按行或按轮增长：`rowIndexById`、`toolRowIdByCallId`、`messageIdByRowId`、
  `entityIdByRowId`、`editTargetByEntityId`、`turnHeaderRowIdByTurnId`、`productTurnIdByRuntimeTurnId`、
  `runtimeTurnIdByProductTurnId`）不复制：候选与当前投影共享同一个 `TransactionalMap`，事务内记录每个键第一次
  写入前的状态，拒绝或抛错时撤销，接受时丢弃记录。另外三张 Activity 完整历史表也共享事务；
  其余侧表与标量照旧复制；其中 hook 调用、subagent 行索引、
  compact/goal 标记与诊断数组也随历史增长，但通常很小，仍按原样整份复制。
- 回滚必须恢复迭代顺序：`rowIdForMessageId` 等按插入顺序取第一个匹配。新增键与改写已有键的值不改变顺序，
  按记录撤销；事务内第一次删除事务前已有的键（或 `clear`）时，先还原并保存事务开始时的完整内容，回滚时整表
  恢复。这类删除只发生在 rewind 等少数事件上，代价与原来的整份复制相同。
- 不变量：hydration 之外，这十一项字段始终是 `TransactionalMap`。批量回放期间 `rowIndexById` 与 accumulator
  共用一个普通 Map，回放结束时换成 `TransactionalMap`；rewind 重建索引时直接生成 `TransactionalMap`。万一遇到
  普通 Map，原子事件照原来的方式复制一次（只是变慢），不共享无法回滚的表。
- 结束时逐张提交或回滚，每张表单独处理：某张表回滚抛错时，其余表照常回滚，所有事务都会关闭（回滚先关事务
  再恢复内容），不会因残留事务让之后每个事件都失败。抛错那张表可能只恢复了一部分，错误（连同归约或 accept
  的原始错误）统一以 `AggregateError` 抛出，由调用方按投影故障处理。
- 约束：大侧表只能通过 `set` / `delete` / `clear` 改写；值对象只能整体替换，不能原地修改（与原来的浅复制
  相同）。新增要共享的侧表时，用 `TransactionalMap`、在 `cloneProjection` 里共享，并加进回归测试的共享表清单。
  `accept` 只能读传入的 snapshot 与 deltas，不能调用投影的查询方法：它执行时共享大侧表已带候选写入，当前
  snapshot 仍是旧的，读投影得到的是新旧混合的状态，不论最终接受还是拒绝都可能判错。
- 原因：此前每个原子事件把所有侧表各复制一份，10800 行时一个工具事件约 1.7ms 花在复制上，随历史线性增长。
- 回归：`apps/zcode-cli/packages/bootstrap/tests/product-projection-atomic-transaction.test.ts` 对每个事件
  依次拒绝、让 accept 抛错、在归约写完侧表后注入异常、让第一张共享表回滚后抛错，断言投影全部字段（含 Map /
  Set 顺序）不变，再接受并与直接 `applyEvent` 比较；每一步之后断言十一项字段都是 `TransactionalMap` 且没有残留
  事务；另有一组用例先冷恢复前两轮，再对其余事件做同样检查。`tests/transactional-map.test.ts` 覆盖新增、改写、
  删除再加入、清空等组合的回滚与提交，以及回滚中途抛错后事务已关闭。

2026-11-18 活动历史事务回归：一万 child、一万 run、五千 actor 的种子后，连续一千个节点
事件及后续恢复、actor 去重和结算均不迭代三张完整历史索引；拒绝与三类异常回滚后，
全部投影字段与原值一致。真实 publisher 的 continuous/replayable 文本及工具流同样不迭代或写入完整 child outcome；相关权限变化不重写相同结果，合法 child 生命周期仍更新身份校验。CLI 定向 319/319、完整冷恢复单独运行 125/125 通过；并行构建时首轮 6 项超时并伴临时插件目录清理失败，未调整超时。
macOS 桌面三个 spec、六个 case 通过，证据
`packages/desktop/.e2e-artifacts/desktop-e2e-20261118-131803-202`，覆盖活动保留与真实重启恢复。
这是访问次数和功能回归证据，不代表真实端到端延迟或本轮 Windows/手机实机验收。

## 会话锁与行级资格

fork 与文件撤销各有两层条件：行级资格写在行 `actions`，session 锁写在 `availability`。UI 显示入口、CLI
校验命令都取两者的与。

| 动作     | 行级资格（`actions`）                                                                  | session 锁（`availability`）                                                                                           |
| -------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| fork     | `canFork`：所在轮 `completedSuccess`、本轮最后一段 assistant、已完成、有持久 messageId | `fork`：compact 中为 `compactOperationLock`                                                                            |
| 文件撤销 | `canRewindFiles`：turnHeader 不在 running，`fileChanges.state === "active"`            | `rewindFiles`：compact 中为 `compactOperationLock`；有 active work 或 pending interaction 时为 `fileRewindUnavailable` |

- 原因：session 锁在每轮开始/结束、compact 开始/结束时翻转。锁写在行上时，每次翻转都要给所有历史行各发
  一条 `row.upserted`。Node 合成回放（2700 轮 / 8100 行，每轮都有文件改动）中，轮开始/结束各约 2700 条、
  compact 开始/结束各约 5400 条、约 3.8MB，单次 CLI 归约 150–330ms，并超过订阅缓冲上限（500 ops / 1MB），
  退化为 snapshot 重发与客户端重拉历史。锁移到 `availability` 后每次只多一条 `state.updated`。
- `edit`/`retry` 不拆：同一时刻各自最多一行为 true，翻转不会放大。
- `availability` 只在物化时从 prospective 派生，reducer 不写它。同一事件可以由多个 reducer patch 分别改写
  `control` 与 `pendingInteractions`（例如带待处理权限请求时取消的 `TurnComplete`）；若各 patch 基于事件前
  的状态各算一次，最后写入的那份会读到另一半的旧值。
- 兼容：`availability.rewindFiles` 在 schema 中可选。旧 CLI 不下发，客户端按允许处理；旧 CLI 的
  `canRewindFiles` 本来就包含 session 锁，结果不变。新 CLI 搭配旧客户端时，旧客户端只看行级资格，锁定期间
  入口可能可点，命令由 CLI 拒绝（`guard.actionUnavailable`）。
- 回归：`apps/zcode-cli/packages/bootstrap/tests/product-projection-session-locks.test.ts`。

## 订阅与投递边界

- desktop 使用 `desktop-continuous`：保留在线流式 `row.delta`；
- mobile remote 使用 `web-remote-replayable`：依赖 snapshot/gap 恢复，可过滤不可重放的中间 delta；
- profile 可以改变中间帧，不能改变 command、row 终态或最终 projection；
- 每个 connection/subscription 独立维护 ownership、seq、logEpoch 与恢复代际；
- Host、desktop main 与 relay 不保存 projection，也不建立第二个 reducer。

## 长会话窗口

schema 已定义 rows window 与旧行范围读取语义。客户端必须以 snapshot 提供的窗口为准，不能假定每个
snapshot 永远包含完整历史。当前 UI 对超长历史的完整 `loadOlder` 交互仍属于待补能力；在其落地前，
这是一项明确限制，而不是由客户端扫描 legacy message 补齐的理由。

审批物化成本约束（2026-11-19）：pendingInteractions 变化仅在 child 等待身份集合改变时触发 child 物化，与 Bash 受阻集合使用相同依赖口径。主代理审批申请／解除不访问完整 child outcome 索引；同一 child 多个审批只在第一次进入等待、最后一次解除时更新其摘要，两种 delivery profile 均回归。
