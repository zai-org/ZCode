# Chat Message Queue（当前事实）

聊天队列的唯一事实源是每个 workspace CLI 的 runtime command queue，并通过 `ConversationSnapshot.queue` 投影给所有客户端。renderer 不维护 accepted queue，也不存在桌面 renderer queue 与手机 host queue 两套产品顺序。

## 状态链路

```text
desktop / mobile input
  -> V4 command admission
  -> inputRouting: startNow | enqueue | guide | choice
  -> CLI runtime queue
  -> ProductProjection.queue
  -> snapshot/delta
  -> queue UI
```

running 时，普通 `sendText` 与 `sendGoalCommand` 都由 CLI admission 决定是否入队。held queue 下的新输入必须带用户对现有队列的处置选择，不能由 UI 猜测清空或保留。

## 操作

| 用户动作 | V4 command         | 权威结果                         |
| -------- | ------------------ | -------------------------------- |
| 删除     | `deleteQueueItem`  | projection 移除 queue item       |
| 编辑     | `lockQueueItemEdit` → `editQueueItem` / `releaseQueueItemEdit` | 编辑期间原位冻结；提交时原地替换并解锁，取消时解锁 |
| 立即发送 | `sendQueuedNow`    | CLI 按 stop barrier/优先规则消费 |
| 排序     | `reorderQueueItem` | projection 返回新顺序            |
| 自动续跑 | `setAutoDrain`     | snapshot 更新 auto-drain 状态    |

UI 可对点击做短暂 pending/disabled 反馈，但不能只改本地数组。刷新、切 pane、桌面与手机同时在线时，均以 snapshot/delta 为准。

第一方桌面、Web 与手机 UI 的“编辑”复用底部 composer，编辑期间队列项留在原位并被 CLI 冻结。
完整交互、草稿暂存、失效处理与锁释放见 [Composer 编辑态](composer-edit-mode.md)。

```text
点击编辑(queueItem, sessionId, workspaceKey)
  -> composer busy（上传中/发送中）? 是: 不发 command，提示稍后再试
  -> lockQueueItemEdit(queueItemId, editorId)，目标行显示 pending
       ├─ reserved / 已被锁 / noop / failed -> 不进入编辑态，提示原因
       └─ accepted（且仍是原 session + workspaceKey）
            -> 暂存当前草稿（stash），composer 载入原 kind + text + AttachmentRef[] + 模型/mode/Plan 配置
                 ├─ 取消 -> releaseQueueItemEdit -> 恢复 stash
                 ├─ 发送 -> editQueueItem(内容, 附件, 配置, editorId) 原地替换并解锁 -> 恢复 stash
                 └─ 项被删除/被其他端解除 -> invalid，发送作为普通新消息
```

冻结项保留 `queueItemId`、`sourceCommandId`、位置与 kind。自动续跑到冻结项时暂停，后面的项保持顺序等待；
冻结项不能被删除、重排或立即发送，其他项不受影响。锁只在 CLI 内存中，不使用超时释放。

`workspaceKey = workspaceIdentity?.trim() || workspacePath`。编辑态绑定点击时的 session 与 workspaceKey；
ACK 返回前切换 task/workspace 时，不得把旧 payload 写进新 composer，并立即 `releaseQueueItemEdit`。

普通文本和 goal 可以编辑；goal 显示为 `/goal ...`，提交时 kind 不变。`compact` 继续没有编辑入口。附件按 queue 中的
原顺序、完整 `AttachmentRef` 显示为 ready session-owned chip，提交时不重新 upload/adopt；编辑态可像普通发送一样
追加附件。队列项记录的模型、reasoning、mode、Plan 载入工具栏，用户修改后随 `editQueueItem` 原地写回。

队列只有一项时，点击编辑到进入编辑态的全过程，目标行保持同一 DOM：先显示加锁中的 pending，lock 接受后
直接变为「正在下方编辑」占位，中间不得回到普通行（重新变亮或露出操作按钮），占位出现后不回退，编辑期间该行
不被移除。lock ACK 与 `editLock` 投影不保证先后：ACK 先到时以发起端本地编辑态显示本端占位，投影随后确认；
不使用定时器或固定等待。composer 只在 lock 接受后载入一次正文；载入后的高度变化只发生一次。短文本、多行和
附件遵守同一顺序。对应 E2E（B09g）在单次点击前启动 DOM/逐帧采样，并验证手机发起编辑时桌面草稿不变。
图片没有本地 object URL 时显示文件名和类型图标，不新增缩略图下载协议。

编辑态与 stash 保持 renderer-local，不写入 conversation snapshot、relay 或 main process；其他桌面或手机端只看到
权威 `editLock`，并可手动「解除」。

`compact` 队列项只显示 `/compact` 命令文本，不在文本前增加维护命令图标。它继续通过“立即执行”按钮和不可编辑行为与普通消息区分。

`guide` 是对 active turn 的引导语义，不作为普通 queue item 提供编辑、删除或立即发送。Stop 只停止当前执行；queue 是否 held/续跑由 CLI projection 明确表达。Goal 暂停、恢复和 queue drain 也由 CLI reducer/handler 统一裁决。

## 当前入口

- Schema：`packages/shared/src/zcode-protocol-v4/command.ts`、`snapshot.ts`
- CLI handlers：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`
- UI：`packages/ui/src/v4/SessionPane.tsx`
