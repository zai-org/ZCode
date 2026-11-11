# Task-scoped composer drafts

## 背景

聊天输入框的未发送状态必须跟随 task 隔离，而不是跟随当前组件实例。用户在 A task 输入文本、添加附件或上下文 chip 后切到 B task，再切回 A task，应看到 A 自己的草稿；B task 也同理。

## 缓存边界

- workspace 隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
- 草稿作用域使用 `taskId`；新建任务态使用 `null`，在 store 中映射为 `__draft__`。
- 每个作用域缓存完整 composer draft：文本、普通附件、code comment、web element context 和本地 revision。
- 桌面端恢复时优先重放 Lexical editor JSON 快照，保留 mention / token 节点；旧草稿或快照缺失时回退到纯文本恢复。
- focus、拖拽高亮、提示词增强 loading 等瞬时 UI 状态不进入草稿缓存。

## 持久化规则

- 当前 renderer 内存里按 workspace/task 独立保存，切换 task、卸载、页面隐藏、进入/退出 composer 编辑态、首发 task promotion 都要保存/恢复。
- composer 编辑态（[Composer 编辑态](composer-edit-mode.md)）期间，原草稿（含草稿级模型、reasoning、mode、Plan）暂存为 stash，持久化目标仍是 stash；编辑内容不写 localStorage。取消或提交成功后恢复 stash；刷新或重启后丢弃编辑态，只恢复原草稿。
- 输入热路径只更新 Lexical、本地 ref、正文空值派生状态和 revision，不按每个字符写父级草稿 state 或 localStorage；Windows IME 的 composition 中间态遵守同一边界。完整草稿在 350ms 输入静默窗口，或切换 task、卸载/隐藏、prefill/queued edit、首发 promotion、发送失败/成功边界合并最新正文后保存或清理，避免大附件、长文本和多草稿 scope 造成高频重渲染或同步存储写入。
- 静默窗口未到达时，提交、切换模式/模型和生命周期 flush 必须读取当前 Lexical/ref 中的最新正文；发送门禁、实际消息、Prompt History、`submittedDraftText` 和发送事务必须复用同一份 Lexical 快照，不能在 composition 中间态回退到过期的 `textRef`。普通异步回调必须同时校验 scope key 和每次进入 scope 时生成的不可复用 incarnation，A₁→B→A₂ 后的 A₁ 回调不得因 key 再次相同而覆盖 A₂。旧 scope 的普通延迟回调仍由 current-scope guard 拒绝，只有该 scope effect setup 捕获的一次性 lifecycle commit 可以写回自己的持久化目标，且绝不能更新新 scope state。发送事务必须在 claim 时捕获提交 scope 的 incarnation、持久化目标和正文 mutation revision；失败只在该 scope 此后没有新正文时恢复到原 scope，恢复完成后立即解除写盘抑制。accepted/duplicate/authoritative 只按 revision 结算原 scope；rejected/failed/discarded 恢复仍属于本次提交的正文后释放事务；查询 unknown 只表示暂未命中，不结束提交。compositionend 只把最终正文发布到父级草稿 owner；候选阶段不做逐次正文投影，但只更新发送控件所需的 raw/trimmed 布尔状态，保持候选期按钮行为。task/workspace 切换、页面隐藏或卸载等显式生命周期边界必须直接读取 Lexical 当前候选快照，并通过旧 scope 捕获的持久化目标保存，不能因 React text ref 尚未更新而丢正文。候选阶段仅允许不携带正文的首输入 timing 信号，保持 `input_first_char_time` 监控口径。
- 桌面端重启恢复使用 localStorage 的小型 JSON 缓存；key 中必须包含 workspace key，避免远程 workspace 同路径串线。
- 普通附件只持久化可恢复引用：带 `localPath` 的文件附件可以恢复；没有可恢复路径的浏览器 `File` 不复制到应用存储，重启后丢弃并提示用户重新添加。
- task 删除或发送成功后清理对应草稿，避免旧附件引用继续出现在后续会话。

## 提交与查询交接（2026-10-28）

发送与恢复查询可以并发：Host 尚在准备发送时，CLI 查询可以先返回 `unknown`。
它不证明命令失败，不发出 terminal resolution，不删除待确认记录或结算订阅。
记录继续由 accepted/duplicate、明确失败、权威投影或既有 TTL 收口；不自动重发。

草稿事务是 claim/restore/finalize 的唯一状态 owner。finalize 仅执行一次；成功后迟到的
传输异常不得恢复已发送正文。Composer 不再另外维护 claimed/resolved/settled 三组标志。
ACK 与权威投影、发送 Promise 返回共用同一幂等结算入口；无命令的本地 slash 成功继续
使用该入口。scope incarnation、正文 revision 和冻结的 Lexical 快照继续保护新输入。
断连后卸载重挂的正文恢复继续复用现有模块级结算订阅，不新增持久状态或计时器。
首发接纳后的导航必须使用草稿 owner 的交接结果：原 scope 已切走或换代时，不执行过期导航，
也不修改新草稿；已接纳任务仍按原命令正常保留。

```text
提交 → claim → 等待命令结果 ── unknown → 保持待确认
                         ├─ accepted / 权威投影 → finalize 一次
                         └─ 明确拒绝 → restore + release
传输异常 → 恢复原正文但保留待确认 → 迟到接纳仍可结算
```

回归 CST01–04：自然单次 Enter 的清空与 placeholder；查询先到后成功；发送期间继续输入；
发送期间切走后的新草稿隔离。桌面与手机使用同一结算代码；手机 Enter 换行/按钮发送、
continuous/replayable 传输语义保持不变。ACK 丢失并重挂继续由 R3A-B-07 场景验证。
CST05 通过实际 Web 配对验证手机按钮首发清空与 placeholder 交接，并保持 Enter 换行及深浅主题。

## 输入响应性回归（ZCT-2112490732581797888）

Windows 中文输入法会在一次候选提交前产生多次 composition 更新。每次更新若同步序列化前后两份全文、提交 `SessionPane` 草稿并读写整份 localStorage，会阻塞 renderer，表现为文字和退格约数百毫秒后才出现。输入显示由 Lexical DOM 直接负责；父级草稿只接收合并后的最终快照。

```text
字符 / 退格 / IME 中间态 → Lexical + text ref + revision
                                      │
                                      ├─ raw/trimmed 布尔量 → 发送控件状态
                                      │
                                      ├─ 350ms 静默 → current-scope commit
                                      │
                                      └─ scope 切换/卸载 → scope-bound lifecycle commit
                                                               │
                                                               ▼
                                                   只写目标 scope 草稿
```

回归验证必须分别覆盖普通字符、退格、composition 最终提交、task/workspace 切换、窗口隐藏/卸载和发送成功/失败。单元门禁使用父级提交与存储写入次数，不使用机器相关耗时；Windows 运行时候选另记录真实按键的 key-to-paint 分布、长任务与 CPU profile。CLI/session 日志不包含 renderer 输入、React commit 或 paint，不能单独作为输入卡顿归因。
