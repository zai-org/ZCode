# V4 跨端权威输入队列

## 结论

旧的“桌面 renderer-local queue + 手机 host runtime command queue”双队列语义已经退出 V4。
所有桌面与手机已提交的 busy/running 输入直接进入同一个 CLI/runtime `CommandInbox`，FIFO 顺序以
CLI 串行 admission 顺序为准。host 的 owner/lease 只做路由，不再拥有第二份 accepted input queue。

```text
Desktop continuous command ─┐
                            ├─> owner route -> CLI serialized admission -> one FIFO
Mobile replayable command ──┘                                      |
                                                                    ├─ queue
                                                                    ├─ guided row
                                                                    ├─ transcript
                                                                    └─ rejected/failed/discarded
```

最终不变量：UI 清空已提交 payload 前，权威层必须已经记录其唯一去向；不能出现“UI 已清空，但 CLI
没有 queue/guided row/transcript/explicit terminal result”。

## 连接与路由边界

- Desktop（包含 SSH/WSL/Docker 窗口）由 host 可信标记为 `desktop-continuous`。
- Mobile `/remote` / Web remote 可信标记为 `web-remote-replayable`。
- `clientMode` 由 attachment 注入，不能由 UI command 伪造。
- 手机 V4 绕过 `IZCodeTaskService.enqueueTaskCommand` 的 host runtime command queue。
- remote workspace、bot/proxy 或跨 host fallback 仍通过 owner/lease/stale-run 把 command 路由到正确 CLI。
- 远程链路贯穿 `workspaceIdentity` 与 `remoteSessionId`；身份 key 不能只用 `workspacePath`。
- 每个桌面窗口只有一个 Window Host 和一个 realtime `hostId`；local/remote command 在 Host 内按
  `workspaceKey + taskId` 路由，`remoteSessionId` 只选择窗口内 source，不能替代 workspace identity。

## ConversationInputIntent

每条 admitted input 自包含并沿 queue/runtime/transcript 全字段守恒：

- 原始 `sourceCommandId` 和稳定 `queueItemId`。
- `clientId`、kind、原文、attachments。
- delivery requested/admitted 与 fallback reason。
- CLI admission 顺序和 queue position。
- steer 与 dispatch 状态。

QueueItem、drain/guided event、user row、message anchor 使用同一个原始 `sourceCommandId`。promotion、
edit 或 send-now 不能换成操作 command 的 id。

持久化时，message metadata 与 session-input ledger 都写完整 `conversationInputIntent`；message anchor
另写同一个 `sourceCommandId` 供查重索引。旧 `metadata.inputIntent` 仅兼容读取，不是新写入权威格式。

guide 不适用、带 attachments、compact/verifier busy 或 runtime steer reject 时，完整 intent 回退普通
queue。empty、超限或 runtime reject 返回显式 `rejected/failed`，UI 保留文本和附件。

## Queue 操作

`editQueueItem` 原地更新，保留 item ID、来源 command、原位置、kind、client 与 admission 顺序；
只改变用户明确提交的文本、附件与模型/mode/Plan 配置，并释放编辑锁。编辑期间该项由 `lockQueueItemEdit` 冻结（`editLock` 进入投影），
手机与桌面都可看到并手动 `releaseQueueItemEdit`，见 [Composer 编辑态](ui/composer-edit-mode.md)。reorder/delete 也通过 CLI command 修改同一份权威 queue。

`sendQueuedNow` 不先删后发：

```text
reserve(item)
  -> stop barrier
  -> start/promote(item)
  -> remove(item) only after start succeeds

timeout/failure -> release reservation -> 原 item 原位、原字段保留
```

同 item 的连续点击或多端竞争只有一个 reservation owner。
reservation 位于共享 CLI runtime；`reserved/promoting` 经事件流投影给所有 desktop/mobile
订阅者，并暂停普通 drain。提升读取完整 QueueItem，沿用原 `sourceCommandId` 和 attachments；
start 成功后才按相同 reservationId remove。该 remove 使用 `promoted` 原因，只摘 queue、不把
durable ledger 标 cancelled；user message 原子提交后由 `SessionInputPromoted` 解 pin，提交前崩溃则
恢复为 explicit discarded。

## ACK、查询与 UI 对账

UI 建立 24 小时 pending-command registry：普通 text/goal 保存可重发 payload；敏感 interaction 只保存
digest。QueueItem/guided projection 出现即证明权威层已接收，立即删除对应 registry 记录；该 registry
不是跨 runtime 的第二份 queue。

ACK 丢失或重连时调用 `commands/query`，每次最多 64 个 `{sessionId, commandId}`。CLI 查询顺序固定为：

```text
memory LRU
  -> transcript/message anchor sourceCommandId
  -> timeline marker sourceCommandId
  -> fork child metadata sourceCommandId
  -> discarded input ledger
  -> unknown
```

同 key 查询与执行 single-flight；查询不能在执行已开始、结果尚未写回的窗口返回 `unknown` 并诱发重复副作用。
sendText/sendGoal/createSession.firstInput 在 handler 前先保存完整 `conversationInputIntent` 并 pin；
promotion 事件先失效旧 transcript query seed 再解 pin，因此即使随后发生 512 条 ACK churn，回源也只能
看到 transcript 或 explicit discarded，不能退化成 unknown。

## 恢复与进程边界

queue 只保证当前 CLI 进程内可靠，覆盖 UI 重建、手机网络断线和 attachment 重连，但不承诺 CLI
restart 后继续执行。CLI restart 时，尚未进入 transcript/显式终态的 admitted input 写入 discarded ledger；
`commands/query` 返回失败原因 `fault.command.inputDiscardedOnRestart` 及持久 `delivery`。

若任务尚未 resume，首次 `commands/query` 也会把上个 CLI 进程遗留的 admitted ledger 收口为
discarded，因此不会出现“先 unknown、订阅后才 discarded”的竞态。timeline/child 这类无 user message
的成功副作用写 `v4/command_fact`，重启查询仍返回原 ACK/result。

`queue/guide` 属于旧 runtime，客户端静默清账；只有未进入 transcript 的 `startNow` 或 `unknown`
显示“确认重发”入口，绝不自动重放。普通手机断线仍由当前 runtime 的 replayable snapshot 恢复权威
queue；relay、desktop main 和 host 不能通过私有持久队列绕过该产品边界。

### 2026-09 虚拟项目目录导航

手机 home 复用 ProjectSidebar，经当前 base attachment 读取 Host 项目行集合；手机 shell 仅拥有 home/chat 与浏览器返回状态。`workspace-bridge-open.project` 是严格的 projectId/hostId 意图，由 main 转交窗口 Host 的 ProjectService 准备执行目录。它允许在已在线物理 Source 上创建或复用目录 logical scope，不允许隐式新建物理连接、Host 或 Agent。准备前后检查会员身份、项目入口与物理连接对象；main 只保留当前导航的 RPC promise，同一 bridge identity 的重试不重复分配目录，取消/关窗/后续导航使迟到结果失效。

Host 返回可信 workspaceIdentity、remoteSessionId、cwd 后沿原 shared-host attachment 建立手机 replayable bridge。项目/provider/初始输入只在 Web 的 Root 交接中传递，main 不存草稿或任务业务状态。桌面 direct continuous、手机 snapshot/gap 恢复、owner/lease 和 CLI CommandInbox 的单队列规则保持不变。
