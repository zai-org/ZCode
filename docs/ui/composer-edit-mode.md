# Composer 编辑态：复用底部输入框编辑最后一条消息与排队消息

> **状态**：2026-10-30 已实现，本文为当前事实。

## 目标

编辑最后一条 real-user 消息和编辑排队消息，都改为复用底部主输入框（`ConversationComposer`）。
主输入框的组件、工具栏、发送按钮和快捷键保持原样，只新增两样东西：

1. 输入框顶部的**编辑状态条**，表明正在编辑哪条消息，并提供「取消」。
2. 原消息位置的**占位提示**「正在下方编辑」。

进入编辑态前，暂存当前草稿。取消或提交成功后，恢复这份草稿；提交成功时工具栏保留提交用的模型、reasoning 与 mode，
见「退出编辑态的工具栏配置」。

不再使用历史消息行内的 `ChatPromptEditor` 编辑器；`ChatPromptEditor` 仍作为 composer 的输入核心。

## 入口与范围

| 入口                              | 可编辑条件（唯一事实源）                                                       | 提交命令        |
| --------------------------------- | ------------------------------------------------------------------------------ | --------------- |
| 最后一条 real-user 消息的「编辑」 | `row.actions.canEdit === true`（CLI 投影）                                     | `editUserQuery` |
| 排队消息的「编辑」                | queue item 存在，kind 不是 `compact`，`dispatch.state=queued`，没有 `editLock` | `editQueueItem` |

`guide`、`compact` 队列项与历史上较早的消息仍然没有编辑入口。

## 界面

```text
┌─ 时间线 ─────────────────────────────────────────┐
│                     ┌──────────────────────┐     │
│                     │ 帮我重构 xxx          │     │  ← 原气泡不变，隐藏编辑入口
│                     └──────────────────────┘     │
│                          ✎ 正在下方编辑           │  ← 占位提示
├─ 排队面板 ───────────────────────────────────────┤
│  1. 跑一下测试                  [原操作按钮…]     │
│  2. 补充文档                  ✎ 正在下方编辑      │  ← 本行操作按钮换成占位提示
├─ 输入框 ─────────────────────────────────────────┤
│ ✎ 正在编辑上一条消息        [对话 + 文件重置] [取消] │  ← 编辑状态条
│ ┌──────────────────────────────────────────────┐ │
│ │ （原输入框，行为不变）                         │ │
│ └──────────────────────────────────────────────┘ │
│ [原工具栏]                            [原发送按钮] │
└──────────────────────────────────────────────────┘
```

- **状态条**放在输入框卡片内顶部。左侧文案：「正在编辑上一条消息」或「正在编辑排队消息」。右侧依次是
  「对话 + 文件重置」（仅编辑历史消息时显示）和「取消」。
- 「对话 + 文件重置」从行内编辑器移到状态条，含义、可用性和 tooltip 不变：恢复本轮文件、重置对话并发送
  （`editUserQuery.workspaceMode=rewind`），见 [file-summary-safe-rewind.md](../file-summary-safe-rewind.md)。
- **发送按钮、Enter 和工具栏不变**。编辑态只改变「发送」的路由：发往编辑命令，不走普通
  `inputRouting`（不入队、不引导、不弹暂停队列确认）。
- 进入编辑态时，状态条、附件行与正文在同一帧显示，输入框高度只变化一次；不能先出状态条、下一帧再载入正文。
- 不支持 Esc 取消，只能点「取消」。
- **占位提示**可点击，点击只聚焦输入框，不滚动。
- **能力完全复用**：编辑态下 composer 的全部能力照常可用——添加/删除附件（选择、拖入、粘贴）、长粘贴转附件、
  mention、prompt enhance，以及工具栏的模型、reasoning、mode、Plan。提交时与普通发送一样携带 composer 当前的
  附件与配置，见下文「内容与配置」。
- 颜色、圆角、尺寸、深浅主题与 i18n 遵守 [DESIGN.md](../../DESIGN.md)；文案进入中英文 locale。

## 状态与时序

```text
                     点击编辑(target)
   normal ─────────────────────────────────▶ editing(target, stash)
     ▲   1. composer busy（上传中/发送中）→ 拒绝并提示   │
     │   2. 排队消息：lockQueueItemEdit，accepted 才继续 │
     │   3. 完整暂存当前草稿到 stash                    │
     │   4. 把 target 内容载入 composer，聚焦           │
     │                                                 │
     │  取消 ──────────────────────────────────────────┤ 排队消息发 releaseQueueItemEdit；恢复 stash
     │                                                 │
     │  发送 ──▶ 编辑命令 ACK ─┬─ accepted/duplicate ───┤ 退出编辑，恢复 stash（保留提交的模型/mode）
     │                        ├─ blocked（文件冲突）───┤ 打开现有冲突对话框，保持编辑态
     │                        ├─ rejected/failed ──────┤ 保持编辑态与当前内容，提示重试
     │                        └─ 目标已失效 ───────────┤ 进入 invalid
     │                                                 │
     │  投影显示目标失效 ─────────────────────────────▶ invalid(target, stash)
     │                                                   状态条改为失效文案
     │                                                   发送 = 普通新消息（走正常 inputRouting）
     └─────────────── 取消 / 普通发送成功：恢复 stash ───┘
```

失效只看 CLI 投影，不用计时器猜：

| 编辑目标     | 失效条件                                                                             | 状态条文案                               |
| ------------ | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| 最后一条消息 | 该 row 的 `actions.canEdit` 变为 false，例如队列续跑产生了新的 real-user 消息        | 这条消息已不是最后一条，发送将作为新消息 |
| 排队消息     | queue item 已不在队列：已被提升执行、被「清空队列并发送」删除，或 CLI 重启后队列丢失 | 原排队消息已不在队列中，发送将作为新消息 |
| 排队消息     | `editLock` 已不属于本编辑器（被其他端解除）                                          | 编辑已被其他设备解除，发送将作为新消息   |

## 草稿暂存（edit scope）

「暂存原草稿」用独立的 edit scope 实现，不复制原草稿：

- 进入编辑态时新建一个 edit scope（`<sessionId>::composer-edit:<nonce>`），把目标内容预置进去：文本、附件、
  code comment、web element、pptx 引用、会话引用与工具栏配置。composer 随后切到这个 scope。
  原 task scope 的草稿、附件与 chip 都不被改写，因此就是 stash。
- edit scope 的草稿只存在 renderer 内存（`composerDraftStore` 对 edit scope 不写 localStorage），
  code comment / web element / pptx 也不进入按 scope 的缓存。
- 编辑态按 workspace + session 存放在 `useComposerEditStore`（内存）。切换 task 再切回，编辑态保持。
- composer busy（附件上传中、发送事务未结算）时不进入编辑态，提示先等待。
- 页面刷新或应用重启后编辑态丢失，composer 回到原 task scope，即原草稿。排队消息的锁由下文「锁的释放」收口。
- 取消、编辑提交成功、invalid 状态下普通发送成功，都退出编辑态，composer 回到原 scope。提交失败保持编辑态。
- 回到原 scope 时，工具栏配置状态沿用进入编辑态前的那份，不按 Session 快照重新初始化；否则首帧快照会覆盖原草稿的 mode/Plan。
  提交成功时在此基础上换入提交的模型与 mode，见「退出编辑态的工具栏配置」。
- 提交与 ACK 结算复用现有发送事务；结算按提交时捕获的 scope 进行，ACK 返回前切走 task 不会写进新 scope。
  composer 结算该 edit scope 后才退出编辑态。离开 edit scope 时，按未发送规则清理其中的附件。
- 排队消息的 `lockQueueItemEdit` ACK 返回前切走 task/workspace：不进入编辑态，并立即 `releaseQueueItemEdit`。
- lock ACK 与 `editLock` 投影不保证先后。ACK 先到时，发起端以本地编辑态把该行显示为本端占位，投影确认后只看投影；
  中间不得回到普通行。

已在编辑态时再点另一条消息的「编辑」：输入文本与载入时一致则直接切换目标（排队消息先释放旧锁）；
不一致则先弹 `ConfirmDialog`，确认后丢弃当前编辑内容再切换。原草稿始终是进入编辑态前的那份。

## 内容与配置

载入（进入编辑态）：

| 内容                            | 最后一条消息                                                             | 排队消息                                         |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| 文本、prompt contexts、会话引用 | 载入原始 canonical 输入；goal 显示为 `/goal ...`                         | 同左                                             |
| 附件                            | 原有序 `AttachmentRef[]` 载入为 ready chip                               | 同左                                             |
| 模型、reasoning、mode、Plan     | 载入该消息提交时的配置（userInput 行投影）；旧消息缺少的字段保留当前配置 | 载入队列项记录的配置；旧项缺少的字段保留当前配置 |

两个入口同一规则：编辑一条消息，从它当初提交时的配置开始，工具栏显示的就是将要执行的配置，用户可以再改。
userInput 行的 `modelSelection`/`mode`/`planEnabled` 来自该输入的 canonical intent，所有 userInput 行构造点
（`TurnStarted`、queue/guide drain）共用同一投影：实时来自 `TurnStarted` 或 `TurnSteerDrained`，
冷恢复来自持久化消息的 `conversationInputIntent`，不需要数据迁移。2026-09-15 前的旧消息没有这三项，按当前配置处理。
Highspeed 单轮 provider 不载入工具栏（与队列项一致），改用当前配置的模型。

已发送的媒体附件没有本地文件。进入编辑态后按原序号读回（与消息行同一读取接口），补上缩略图与 gallery 预览；
视频带 row target 与持久化原序号，删除前面的附件后预览仍读到正确的分块。

提交：

- 编辑态与普通发送走同一条附件管线：新增附件按普通发送的现有上传事务（附件预传、长粘贴转附件）
  得到 `AttachmentRef`，上传未完成时发送按钮与普通发送一样处于等待态。提交时显式携带当前完整附件数组：
  原有 ref 与新 ref 混合，`[]` 表示清空。
- 原有 ref 已由 session 接管，提交时不重新 upload/adopt；新 ref 与 `sendText` 一样由 CLI 接收。取消编辑时，
  新上传但未提交的附件按普通草稿丢弃附件的现有规则清理，原有 ref 不清理。
- 提交时携带 composer 当前的 `modelSelection`、`mode`、`planEnabled`，规则与 `sendText` 相同；
  执行凭据（`modelExecution`）不进入队列，与普通入队一致。
- 提交时 kind 必须与原目标一致（goal 保持 goal），不一致时提示并不提交。
- 退出编辑态时的工具栏配置见下节。

### 退出编辑态的工具栏配置

| 内容                                   | 取消           | 提交成功（两种编辑、invalid 下的普通发送） |
| -------------------------------------- | -------------- | ------------------------------------------ |
| 文本、附件、chip                       | 恢复原草稿     | 恢复原草稿                                 |
| 模型（含 reasoning）、mode（执行权限） | 恢复原草稿的值 | 保留提交用的值                             |
| Plan                                   | 恢复原草稿的值 | 恢复原草稿的值                             |

理由：用户在编辑态里改模型或权限，是对接下来对话的选择，与普通发送后工具栏保留所选配置一致；
提交后下一条消息不能悄悄回到旧模型。Plan 是一次性的工作方式，编辑一条消息时打开 Plan 不代表之后都要 Plan，
因此 Plan 回到原草稿的值，之后照常跟随 Session 的 Plan 切换。取消表示放弃本次编辑，全部恢复。

实现：退出编辑态的同一次渲染里，原 scope 状态由进入前的那份与 edit scope 的模型、mode 合成，并按普通草稿写盘；
不在退出后再改工具栏，避免出现先显示旧模型、再跳到新模型的一帧。是否保留只看 composer 是否结算了这次提交
（`onSubmissionSettled`），不看计时。

### 提交后应用到其他排队消息

编辑提交被接纳（ACK accepted/duplicate）后，若队列中还有其他排队消息，且其中有项的模型（含 reasoning）
或 mode 与本次提交不同，发起端弹 `ConfirmDialog` 询问是否一并应用：

```text
编辑提交 ──▶ ACK accepted/duplicate ──▶ 退出编辑态（工具栏保留新模型/mode）
                                          │
                     取当前投影中的候选项：dispatch.state=queued、无 editLock、kind≠compact、不是本次编辑的项
                                          │
                     候选项里有模型或 mode 与提交不同？── 否 ──▶ 不提示
                                          │ 是
                                          ▼
          「您将执行权限改为 xx，模型改为 yy，是否也应用于所有排队消息？」
                 │                                         │
           应用到排队消息                                 仅本条
                 │                                         │
   applyQueueItemsConfig { queueItemIds, modelSelection?, mode? }    不发命令
                 │
   CLI 逐项原地改写（同 editQueueItem 路径，正文不变）；
   此间已被提升、删除、加锁的项跳过；一项都没改到返回 noop
```

- 只在编辑场景提示，普通发送不提示：普通发送前改工具栏的意图更不确定，且没有「编辑了哪条」的上下文。
- 文案只写实际变化的部分：只改了模型就只说模型，只改了 mode 就只说执行权限；不写条数。
- 只应用模型（含 reasoning）与 mode；不改 Plan、正文、附件。命令只带与提交不同的字段。
- 只在发起端提示，其他端只看到队列项投影变化。弹窗打开期间队列继续正常消费，不暂停、不加锁；
  点「应用」时以当时投影重新取候选项，已离开队列的项不发送。
- yolo 已在编辑态选择时确认过，这里不再二次确认。
- 应用失败（rejected/failed）提示「应用到排队消息失败」，不重试；本条编辑不受影响。

协议变更：

| 命令                    | 变更                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editUserQuery`         | 新增 `mode`、`planEnabled`，与 `modelSelection` 一起按 `sendText` 规则作为重跑配置                                                                                                                                                                                                                  |
| `editQueueItem`         | 新增 `attachments`、`conversationQuotes`、`modelSelection`、`mode`、`planEnabled`、`editorId`（见下节）；core 原地替换这些字段。不走 CAS，见下节                                                                                                                                                    |
| `applyQueueItemsConfig` | 新命令 `{ queueItemIds, modelSelection?, mode? }`：一条命令内逐项原地改写模型/mode，正文不变；跳过不存在、非 `queued`、`compact`、有 `editLock` 的项；全部跳过返回 noop（`queue.itemMissing`）。改了模型时丢弃该项的 Highspeed 卡与暂存凭据（同 `editQueueItem`）。不走 CAS，理由同 `editQueueItem` |

## 排队消息冻结（CLI 权威）

编辑排队消息期间，这一条在 CLI 中被冻结。前面的消息正常消费；续跑到这一条时暂停，后面的消息保持原顺序等待。

```text
队列: [A] [B] [C❄ editLock] [D]

当前轮结束 → 提升 A → 提升 B → 队首是 C 且有 editLock → 停止自动 promotion（D 等待）
                                       │
           ┌───────────────────────────┼───────────────────────────┐
     取消（发起端）              发送（发起端）               其他端点「解除」
  releaseQueueItemEdit     editQueueItem(C, 内容, editorId)   releaseQueueItemEdit
           │                原地替换并释放锁（同一命令）              │
           └──────────────── 队首 C 无锁，自动 promotion 继续 ─────────┘
```

### 协议

| 变更                                                                                               | 说明                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queueItem.editLock?: { editorId, clientId, inputOrigin }`                                         | 进入投影，所有端可见。`inputOrigin` 由 Host 可信注入，用于展示「桌面 / 手机」                                                                             |
| `lockQueueItemEdit { queueItemId, editorId }`                                                      | 只对 `dispatch.state=queued` 且无锁的项成功；`reserved/promoting` 返回 `guard.queueItemReserved`，已有锁返回 `guard.queueItemEditLocked`，不存在返回 noop |
| `releaseQueueItemEdit { queueItemId }`                                                             | 任意端可调用；无锁或项不存在返回 noop                                                                                                                     |
| `editQueueItem { queueItemId, newText, attachments, modelSelection, mode, planEnabled, editorId }` | 原地替换文本、附件与配置并释放锁，保留 ID、位置、来源 command 与 kind。锁不属于该 `editorId` 返回 `guard.queueEditLockLost`；项不存在返回 noop            |

`editQueueItem` 不在 `COMMANDS_REQUIRING_BASE_REVISION` 中，UI 不发送 `baseRevision`。原因：运行中 revision 随
control/queue 投影持续递增，CAS 会把编辑提交误判为 `proto.staleRevision`，编辑态无法退出。并发保护由编辑锁承担：
提交时 `editorId` 必须仍持有该项的锁。

`editorId` 标识一个编辑器实例：每个窗口（Web 每个标签页）一个，保存在 `sessionStorage`，刷新后不变，
不同窗口不同。`clientId` 存在 localStorage，同一台设备的多个窗口共享，因此不能单独作为锁的归属。

浏览器「复制标签页」会连同 `sessionStorage` 一起复制，两个在线标签页可能拿到同一个 `editorId`。为此每个页面
在生命周期内持有一把同名 Web Lock（`navigator.locks`，名称含 `editorId`）：启动时以 `ifAvailable` 申请，
申请不到说明另一个在线页面正在使用该 id，本页面改用新 id 并写回 `sessionStorage`。锁随页面卸载自动释放，
所以刷新后的页面仍能沿用原 id，不需要超时。身份确认前不发锁命令，也不自动释放遗留锁。
不支持 Web Locks 的环境沿用 `sessionStorage` 的 id。桌面窗口由主进程独立创建，不会复制 `sessionStorage`。

### CLI 规则

- 自动 promotion guard 增加一项：`head.editLock` absent。`sendQueuedNow` 等显式路径不受影响，但不能作用于有锁的项。
- 有锁的项拒绝 `sendQueuedNow`、`deleteQueueItem`、`reorderQueueItem`，返回 `guard.queueItemEditLocked`。
  其他项可以照常删除、重排、立即发送。
- 暂停队列确认中的「清空队列并发送」会删除包括有锁项在内的全部已确认项；发起端进入 invalid。
- 队首有锁、`autoDrain=true` 且 session 空闲时，新输入的 `inputRouting` 为 `enqueue`，排到队尾，不弹确认。
  `autoDrain=false` 时仍按现有暂停队列确认处理。
- 队列不持久化：CLI 进程退出后队列与锁一起消失。

### 锁的释放（不使用超时）

| 场景                   | 释放方式                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发起端取消             | `releaseQueueItemEdit`                                                                                                                                          |
| 发起端发送             | `editQueueItem` 在同一命令中替换内容并释放锁                                                                                                                    |
| 发起端刷新或重启       | 重新收到投影后，发现 `editLock.editorId` 是自己但本地没有该编辑态，立即 `releaseQueueItemEdit`；失败（ACK 非 accepted/noop 或命令异常）后在下一次投影更新时重试 |
| 发起窗口关闭、手机断开 | 锁保留；其他端该行显示「正在其他窗口或设备编辑」和「解除」，由用户手动解除                                                                                      |
| 其他端解除             | 发起端在投影中看到锁消失，进入 invalid                                                                                                                          |

「本端锁」只指 `editorId` 相同**且**本地有针对该项的编辑态。`editorId` 相同但本地没有编辑态的是遗留锁：
自动释放进行中或失败时，该行与其他端持有的锁一样显示「正在其他窗口或设备编辑」和「解除」，用户总能手动解除。

锁的内存状态与锁事件同生同灭：加锁先写内存、事件写入失败时撤回；解锁（取消、解除、编辑提交、清空队列）
都先写入解锁或丢弃事件，成功后才删除内存锁。事件写入失败时锁仍在投影与内存中，可重试或解除。

其他端解除空闲队首的锁后，该项会被自动续跑立即提升并离开队列。发起端只按当前投影派生失效原因：
先收到解锁投影时为 `editLockLost`，解锁与提升合并到达时直接为 `queueItemRemoved`。
投影只说明该项已不在队列，不区分「已被提升执行」与「已被删除」，因此 `queueItemRemoved` 的文案保持中性
（「已不在队列中」），不能写成「已删除」：否则用户会以为已执行的消息丢失而重复发送。

## 多端

- 编辑态与 stash 只属于发起端 renderer，不进入 snapshot、relay 或 main process。
- 其他端只看到权威投影：历史消息编辑对其他端不可见；排队消息只看到 `editLock`。
- 桌面与手机 `/remote` 共用 `SessionPane` / `ConversationComposer` 的同一套逻辑，状态条、占位与锁行为一致；
  桌面 continuous 与手机 replayable 的传输语义不变。

## Renderer 引用生命周期

完成历史页到草稿的切换、等待既有 keep-warm 结束后，旧历史的 `ConversationSnapshot` 和已关闭
store 必须可回收。回收契约同时覆盖仍属于 store 的 snapshot 与已脱离 store 的 snapshot，不能
只用活跃 store 数、监听器数或 RSS 判定。该约束仅调整 renderer 引用，不改变 CLI、协议或持久化。

- 完整 snapshot 的投影校验与长期编辑操作回调使用独立词法作用域。校验继续随投影更新；操作
  通过已有 `snapshotRef` 读取当前投影，异步 ACK 仍核对发起时的 workspace/session 身份。
  预置 edit scope 与配置 reader 只捕获所需参数，不通过共享作用域连带保留旧命令回调或 pane lease。
- Composer 拥有实际拖拽处理器。Shell 仅持有当前绑定及 `active/kind` 显示状态，稳定入口只转发
  当前处理器；替换或卸载只释放对应 owner，旧 cleanup 不能清空新绑定。
- 长期能力与订阅回调只捕获其必要数据。agent 颜色能力不捕获 SessionPane render，transport 的
  上游事件分发不捕获首次注册的订阅者，Lexical 更新监听不捕获旧 appCommands。
  预热等待函数只捕获 acquired ref、enabled、generation 和 invalidationVersion，不连带捕获创建命令回调。
- 草稿头部的工作树开关与分支选择回调只捕获 store action、workspacePath 和 workspaceIdentity；
  不捕获 Shell render 的共享环境，防止 memo 中的旧头部 JSX 串起历次 Shell 与文件链接回调。
- 不通过清空仍有效的投影、强制 remount、修改 keep-warm 或增加回收定时器实现此契约。
- 工具栏 memo 先提取 Hook/MCP admission 与 backgroundWorks，再捕获这些展示字段；不能
  通过共享 render 闭包让稳定的发送回调保留完整 snapshot。持续更新历史后也必须释放旧版本。
- Lexical 撤销属于当前编辑 scope incarnation。切换到另一个 scope 时，在恢复目标草稿前
  清理旧 undo/redo；同 scope 的输入、失败重试、Root 晋升与项目解绑转移仍保留原编辑周期。
  持久草稿正文和 mention 恢复不变，不用重新挂载编辑器实现释放。
- 远控状态 hook 在调用 React setter 前过滤语义相同的状态。连续事件按最后已发布状态比较，
  不能只比较上次 render 的状态；停用/平台替换后仍忽略原订阅和原轮询的迟到结果。

```text
snapshot → 独立投影校验 → invalid/锁确认
编辑事件 → 当前 snapshotRef + 发起身份 → 原有 command/ACK
Shell 拖拽入口 → 当前绑定 → Composer 处理器
替换/卸载 → 核对绑定 owner → 释放旧处理器
```

回归采用 SPR04/SPR05：同工作区历史与草稿长循环、focus/slash 操作、两次 GC 与独立堆快照；
另在单个操作连接中连续往返多个不同会话，中途不采堆、不重连、不强制 GC，最后统一验收。
原始失败表现是 snapshot 随返回草稿次数增长，而 closed store 和 Lexical listener 数量保持稳定。
所有检查点必须保存，不因前面失败丢弃后续增长与闲置对照。

## 验收场景

case 见 [conversation-session-case-catalog.md](../conversation-session-case-catalog.md) 的 B09 系列（B09–B09p，排队消息冻结编辑与应用到其他排队消息）与
C07、D01、D12–D18、D21–D28（最后一条消息编辑态）。交互变更先维护对应 E2E，再改实现；覆盖桌面、手机、深浅主题与中英文。

## 代码入口

- 编辑态模块：`packages/ui/src/composer-edit-mode/`（store、`useComposerEditMode`、`ComposerEditBar`）
- composer 接入与提交路由：`packages/ui/src/v4/ConversationComposer.tsx`、`packages/ui/src/v4/SessionPane.tsx`
- 占位与入口：`packages/ui/src/v4/ConversationRowView.tsx`、`packages/ui/src/v4/ConversationQueuePanel.tsx`
- 协议：`packages/shared/src/zcode-protocol-v4/command.ts`、`snapshot.ts`
- CLI：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`（命令）、
  `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`（锁与原地编辑）、
  `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/queue-auto-drain.ts`（冻结队首暂停）
