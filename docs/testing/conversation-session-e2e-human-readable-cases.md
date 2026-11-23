# Conversation Session E2E 人工验收用例

本文把 conversation session 的 A-J 主路径，以及 goal、fork、queue、compact、模型、edit 和 subagent 专项矩阵整理成一份面向产品、开发和 QA 的读者视图。每条用例只保留三件事：用户怎么操作、应该看到什么、去哪里追踪自动化状态。环境故障、纯展示 UI、工具全叉乘和性能压测仍保留在各自专项 catalog，不混入这份主路径人工验收清单。

权威 case 定义仍在 [Conversation Session Case Catalog](../conversation-session-case-catalog.md)，自动化状态仍在 [Conversation Session E2E Coverage Matrix](./conversation-session-e2e-coverage-matrix.md)。本文不重新定义产品语义；原始文档状态变化时，应同步更新本文备注。

备注中的状态含义：`已覆盖` 对应 `covered`，`部分覆盖` 对应 `partial`，`已计划` 对应 `planned/pending`，`待补` 对应 `missing`，`剪枝` 对应 `pruned`。备注只写“产品 accepted”时，表示产品语义已经确认，不代表 E2E 已经覆盖。同一行合并多个等价 case 时，备注会保留全部原始 ID。

```text
草稿首发 -> 运行中 -> 后续输入入队 -> 当前轮完成
                         |               |
                         |               +-> 自动消费 / Goal 继续 / 自动压缩
                         +-> Stop -> 暂停队列 -> 继续 / 立即发送 / 撤回编辑

父会话 -> Agent/Subagent child -> 后台完成通知 -> 父会话继续
   |              |
   |              +-> 右侧只读详情 / 子智能体目录
   +-> fork 只复制稳定历史，不复制 queue 或后台运行态
```

## 1. 会话基础生命周期

| 操作路径                                                  | 结果预期                                                                                   | 备注                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| 新建对话 → 输入普通文本 → 点击发送                        | 创建 session，进入正式会话页；用户消息可见，会话进入预热或运行中                           | 来源：A01；已覆盖           |
| 首条消息刚发送、仍在预热 → 再发送一条普通文本             | 第二条输入进入队列，不打断首轮                                                             | 来源：A02；已覆盖           |
| 草稿首发已被接收 → sessionId 已绑定但首个权威消息尚未到达 | 输入框只从居中布局移动到底部，编辑器实例和内容连续；时间线不伪造用户消息，也不显示空态提示 | 来源：A11；部分覆盖         |
| 会话运行中、队列为空 → 等待 assistant 正常完成            | 会话进入完成态，输入框恢复可发送                                                           | 来源：C01；已覆盖           |
| 已完成会话、队列为空 → 继续发送普通文本                   | 立即开始下一轮                                                                             | 来源：C03；已覆盖           |
| 运行中、队列为空 → 点击停止 → 再发送普通文本              | 当前轮以“已中断”收口；下一条消息立即开始新一轮，不被旧运行态误判入队                       | 来源：B01、B05、B12；已覆盖 |
| Session A 运行中 → 切到 Session B → 在 B 发送消息         | A 在后台继续，B 也能独立运行；两边时间线、队列和状态互不覆盖                               | 来源：J01、J02、J04；已覆盖 |
| A、B 都在运行 → 新建或切到 C 并发送                       | C 也可以运行，产品层不限制不同 session 的并发数                                            | 来源：J03；已覆盖           |

## 2. 队列与 Stop

| 操作路径                                                                  | 结果预期                                                                                                                                  | 备注                             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 当前轮运行中 → 连续发送 1、2、3 条及更多普通文本                          | 每条输入按接纳顺序追加到同一 FIFO；当前轮不被打断，`3+` 可折叠显示                                                                        | 来源：A03-A06；已覆盖            |
| 当前轮运行中 → 发送 `/goal ...`                                           | 命令先作为 goal 类型队列项展示；轮到时才设置或更新目标                                                                                    | 来源：A07、H03、H04；已覆盖      |
| 当前轮运行中 → 发送 `/compact`                                            | `/compact` 作为 compact 类型维护项入队并提示已排队；不显示成普通用户消息，不启动并行压缩                                                  | 来源：A08、M04、G1-03；已计划    |
| 当前轮运行中 → 依次发送普通文本、`/goal ...`、`/compact`                  | 三种输入共用同一接纳顺序；消费时分别走文本、goal、compact 原语义，不能串类型                                                              | 来源：M05、G1-09；已计划         |
| 运行中已有 1、2 或 `3+` 个队列项 → 点击停止                               | 当前轮中断；所有队列项原样保留，自动消费关闭                                                                                              | 来源：B02-B04；已覆盖            |
| 当前轮运行中、queue 非空且自动消费开启 → 当前轮正常完成                   | 自动提升队首并开始下一轮；被消费文本必须成为可见真实用户消息，不能只从队列消失                                                            | 来源：C02；已覆盖                |
| 暂停队列存在 → 在输入框发送普通文本                                       | 弹出队列处置确认：可清空旧队列并发送，也可保留旧队列并立即发送；取消后草稿和附件不丢                                                      | 来源：B06、C08；部分覆盖         |
| 暂停队列存在 → 发送 `/goal <新目标>`                                      | 与普通文本共用队列处置确认；`/goal resume` 等目标控制命令不走此确认                                                                       | 来源：B07；部分覆盖              |
| 暂停队列存在 → 点击某个队列项“立即发送”                                   | 先锁定目标项，再跨过 stop barrier 启动；只有启动成功才删除原项，失败或超时后原位保留；其它项相对顺序不变                                  | 来源：B08、M07a、M07b；部分覆盖  |
| 运行中快速连续点击两次“立即发送”                                          | 同一队列项最多发送一次，不能重复请求或误删相邻项                                                                                          | 来源：M07g；当前 failing，需回归 |
| 暂停队列、输入框完全为空 → 点击普通文本队列项“编辑”                       | 先从权威队列删除；成功后仅在发起操作的原 session 输入框恢复完整原文，不自动发送                                                           | 来源：B09；部分覆盖              |
| 暂停队列、输入框为空 → 编辑 goal 队列项                                   | 恢复成完整 `/goal ...` 文本；再次发送会重新获得新的队列身份                                                                               | 来源：B09a、B09e；已覆盖         |
| 暂停队列项带多个附件 → 点击编辑 → 直接重发                                | 原附件顺序和引用完整恢复，不重复上传或 adopt；重新发送生成新的 commandId 和 queueItemId                                                   | 来源：B09b、B09e；已覆盖         |
| 队列项是 `/compact` → 查看可用操作                                        | 允许删除、重排或立即执行，但不提供撤回到输入框的文本编辑入口                                                                              | 来源：B09f、B13；剪枝            |
| 输入框已有文字、附件、网页上下文、选区引用或上传中内容 → 点击队列项“编辑” | 拒绝撤回，不发送删除命令；现有草稿和队列都保持不变，并提示先处理当前草稿                                                                  | 来源：B09c；已覆盖               |
| 点击队列项“编辑”后，另一端先消费或删除该项，或本端切换 session/workspace  | stale/noop/失败时不恢复旧草稿；只有 accepted/duplicate 且仍处于原 session 和 workspaceKey 时才幂等恢复                                    | 来源：B09d；部分覆盖             |
| 队列处置确认框已打开 → 另一端增删或撤回了队列项 → 本端确认发送            | 旧确认失效，不清空用户没看到的新队列项；基于最新投影重新确认。仅重排同一批 ID 不使确认失效                                                | 来源：B16；已计划                |
| 暂停队列 → 拖动重排或删除一项                                             | 只改变权威队列顺序或删除目标项，不触发消费                                                                                                | 来源：B10、B11；已覆盖           |
| 暂停队列、target 已完成或不存在 → 点击“继续”                              | 打开自动消费，从队首按 FIFO 消费到空；goal 和 compact 仍保持各自类型                                                                      | 来源：B14；部分覆盖              |
| 主轮仍在运行、队列已暂停 → 点击“继续”                                     | 只开启自动消费，不抢占当前轮；当前轮收口后再从队首消费                                                                                    | 来源：B15；已覆盖                |
| 桌面和手机同时向同一 busy session 提交输入                                | 所有已接收输入由同一个 CLI 队列串行排序；桌面 continuous 和手机 replayable 只影响交付方式，不形成两套队列                                 | 来源：PV4-03；待补完整正式证据   |
| CLI 重启前有尚未进入终态的已接收输入 → 重连或查询命令结果                 | 输入明确标记为 discarded；`queue/guide` 静默结算，只有未进 transcript 的 `startNow`/`unknown` 允许确认后以新 commandId 重发；禁止自动重放 | 来源：PV4-06、PV4-25；协议专项   |

## 3. Goal

| 操作路径                                                                              | 结果预期                                                                                                 | 备注                                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 已完成会话、没有 goal → 发送 `/goal 修完登录流程`                                     | 创建目标；时间线立即显示一条与原命令完全一致的真实用户消息，目标摘要展示解析后的 objective               | 来源：C04、H01、G0-01；已覆盖                                               |
| 已有 goal → 发送 `/goal replace 修完登录流程`                                         | 替换目标，objective 去掉命令前缀和 `replace`；原始命令仍按原文显示为用户消息                             | 来源：H02、G0-02；已覆盖                                                    |
| 手动或自动压缩进行中 → 发送 `/goal ...`                                               | goal 输入进入 future queue；压缩完成并轮到它时才更新目标和显示真实用户消息                               | 来源：H05、G2-01、G2-07；主路径已覆盖，auto 专项曾有 failing 记录需持续回归 |
| goal continuation 或 verifier 运行中 → 发送普通文本、`/goal ...`、`/compact`          | 三种输入都进入 future queue，不启动同 session 并行请求                                                   | 来源：H06、H12、G1-14；H06 已覆盖，H12 已计划                               |
| 同一目标连续经历多轮执行和验证 → 再设置一个新目标                                     | 每轮只显示一个紧跟对应 assistant 的验证时间线；新目标从第 1 轮开始，不串到旧目标                         | 来源：H07；已覆盖                                                           |
| active/paused/budget-limited 目标未完成，队列非空 → verifier 一轮结束或点击队列“继续” | 队列仍不消费；显式通过或 fail-open 必须先把 target 更新为 complete，之后才按 FIFO 消费；手动取消不算通过 | 来源：H08、G1-10；待补                                                      |
| goal verifier 正在请求 → 点击停止 → 发送普通文本                                      | verifier 终止并清理主运行态；新文本立即进入新的 provider 请求，不被残留 verifier 阻塞                    | 来源：H09；已覆盖                                                           |
| 已停止 goal verifier → 手动 `/compact` → 压缩完成后发送普通文本                       | 允许压缩和后续发送，不受旧 verifier 或旧 active goal 锁住                                                | 来源：H10；已覆盖                                                           |
| guide 模式、goal verifier 运行中 → 发送引导文本                                       | verifier 不可 steer；同一输入保留身份并回退 future queue，不丢失、不停止目标、不并行发请求               | 来源：H11、G1-14；部分覆盖                                                  |
| active goal → 点击摘要里的暂停                                                        | 目标进入 paused，累计耗时冻结；如有当前 goal work 则终止，但不按普通 Stop 规则清空或消费队列             | 来源：H13、G0-07；已覆盖                                                    |
| paused goal → 点击三角继续                                                            | 目标恢复 active，累计耗时不清零，并沿原 goal continuation 继续                                           | 来源：H14、G0-08；已覆盖                                                    |
| goal 已完成 → 打开或恢复状态面板                                                      | 显示冻结耗时和绿色完成图标，不再显示暂停/继续；桌面 live 与恢复后的结果一致                              | 来源：H15、H16、G0-09、G0-10；部分覆盖                                      |
| Plan 模式 → 在 composer 提交 `/goal` 或别名                                           | 只提示 goal 在 Plan 模式不可用；保留输入原文，不创建 session、不写历史、不发送 goal command              | 来源：PG01、G0-11；已覆盖                                                   |
| Session A 有 active/queued goal → 切到 B → 再切回 A                                   | B 不显示 A 的目标或队列；回到 A 后恢复 A 自己的 target 和 queued goal；新 session 不继承历史 goal/queue  | 来源：G4-01-G4-04；已覆盖                                                   |
| queued goal 等待消费 → 在当前 session 切换模型或思考深度                              | goal 真正执行时使用当前 session 最新模型配置                                                             | 来源：G1-08、N02；已覆盖                                                    |

## 4. Fork

| 操作路径                                                                                  | 结果预期                                                                                                                       | 备注                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 已完成会话 → 在稳定的最终 assistant 消息上点击 fork                                       | 创建 child session；复制 fork 点及之前的可见历史和 fork 点配置，child queue 为空                                               | 来源：C06、E01、FX01；已覆盖   |
| assistant 流式回复被 Stop → 对中断的 partial 尝试 fork                                    | fork 入口不可用或命令被拒绝；不创建 child，父 queue 保持暂停                                                                   | 来源：E02、E03、FX02；已覆盖   |
| 对 user message、tool block 或 timeline marker 尝试 fork                                  | 不提供 fork 入口，也不创建 child                                                                                               | 来源：E04、E05、FX05；已覆盖   |
| 父 session 正在运行，但更早已有稳定 assistant → fork 该稳定消息                           | child 只复制稳定前缀；父当前 primary/subagent/goal work、queue 和 workspace 继续原样运行                                       | 来源：A09、E06、FX06；部分覆盖 |
| 父 session 在 fork 点前已有 goal，且当前还有 queue → fork 稳定 assistant                  | child 继承 fork 点前的 target、iteration 和 verifier timeline；父 queue 保留，child queue 为空                                 | 来源：E07、FX03、G3-07；已覆盖 |
| assistant 只有 failed/error partial、没有稳定完成态 → 尝试 fork                           | fork 入口不可用或命令拒绝；不写 fork timeline                                                                                  | 来源：E08、FX04；待补          |
| 编辑最后一条用户消息并完成重跑 → fork 新分支的 assistant                                  | child 只包含编辑后的 active branch，不带已被 rewind 的旧 user/assistant 分支                                                   | 来源：E09、FX07；已覆盖        |
| 一个逻辑 turn 内先有工具调用和文件变更，最后才有 assistant 文本 → fork 最终可见 assistant | child 按逻辑 turn 边界整体复制最终回复、对应工具块和该 turn 已产生的文件事实，不从中间 raw assistant 截断                      | 来源：E10、FX08；已覆盖        |
| 父 session 有运行中的 background Bash/subagent 或未消费后台结果 → fork 稳定 assistant     | child 不复制 live background work、pending result 或 continuation inbox；后台完成只唤醒父 session                              | 来源：FX09、K02；待补          |
| compact 正在运行 → 尝试 fork；或尝试 fork 当前未收口 assistant                            | compact operation lock 拒绝 fork；当前 streaming/interrupted/failed/middle assistant 也不可 fork，但更早稳定 target 的规则不变 | 来源：FX10、PV4-14；部分覆盖   |

## 5. Edit 与对话重置

| 操作路径                                                                     | 结果预期                                                                                                              | 备注                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 已完成会话 → 点击最后一条真实用户消息 Edit → 修改 → 在行内发送               | 原 session 从该输入重跑，后续历史被新 active branch 替换；主输入框草稿不参与本次编辑                                  | 来源：C07、D01；已覆盖                          |
| 当前 active work 正在运行 → 编辑最后一条真实用户消息并提交                   | 先跨过 Stop barrier 让当前 work 终态，再在原 session 按原输入类型重跑；已有 queue 保留且不自动消费                    | 来源：A10、PV4-13；已计划                       |
| assistant 被 Stop 后 → 编辑对应已发送用户消息并提交                          | 通过稳定 messageId 找到原消息并立即重跑；中断回复被新分支替换，不出现 turnIndex 解析错误                              | 来源：D02、D10；已覆盖                          |
| 会话已中断且有暂停队列 → 编辑最后一条真实用户消息                            | 编辑重跑，队列 ID、顺序和内容原样保留，自动消费仍关闭                                                                 | 来源：D03、PV4-20；已覆盖                       |
| edit 重跑正在运行 → 发送普通文本、`/goal ...`、`/compact`                    | 三种输入进入 future queue，不打断当前 edit 重跑；compact 轮到时才执行                                                 | 来源：D04-D06；文本/goal 已覆盖，compact 已计划 |
| edit 重跑中 → 再次编辑最后一条真实用户消息                                   | 先停止当前重跑，再用最新编辑文本重跑；queue 保留                                                                      | 来源：D07；已覆盖                               |
| 对非 latest 的真实用户输入尝试 Edit                                          | UI 不提供入口或命令拒绝，不能把 active branch 回退到更老输入                                                          | 来源：D11、PV4-10；待补正式 UI + command 证据   |
| 对 assistant 或 tool message 尝试 Edit                                       | 不提供 Edit 入口                                                                                                      | 来源：D08、D09；已覆盖                          |
| latest 输入是 `/goal ...` → 点击统一 Edit → 修改后提交                       | 仍按 goal intent 重放，更新 target/iteration；不能退化成普通文本，也不额外生成 goal marker                            | 来源：PV4-12、PV4-13；已计划                    |
| latest 输入已被一次或多次 compact summary 覆盖 → Edit 并提交                 | 在原 session 做 append-only branch cut；旧记录保留但退出 active projection，失效的 compact 派生状态不再进入模型上下文 | 来源：PV4-11、PV4-19；已覆盖                    |
| 被 compact 覆盖的 latest 输入带附件 → Edit 文本并保留附件提交                | 重放完整附件 intent；不重新读取 workspace、不丢附件、不创建 child                                                     | 来源：PV4-18；已覆盖                            |
| latest turn 有安全文件 checkpoint → 选择“对话 + 文件重置”                    | 倒序恢复文件、裁剪对话并在原 session 重发；不创建 child，也不出现中间 workspace-only 成功态                           | 来源：PV4-21；已覆盖                            |
| 文件已被外部修改或 checkpoint 不安全 → 尝试组合重置 → 选择“仅重置对话并发送” | 第一次操作结构化阻止且文件/对话不变；降级操作使用新 commandId，只重置对话并重发                                       | 来源：PV4-22；部分覆盖                          |
| 被裁 turn 启动了 background Bash/subagent → Edit latest 输入                 | 先取消该 turn 的可取消后台工作；取消无法确认则整体失败；迟到 completion 不得进入新 branch、queue、UI 或模型上下文     | 来源：PV4-23；已覆盖                            |

## 6. Compact

| 操作路径                                                                        | 结果预期                                                                                                                                        | 备注                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 已完成或已中断会话、队列为空 → 手动 `/compact`                                  | 进入手动压缩并显示 started marker；成功后 marker 变为 success，会话回到可继续状态                                                               | 来源：C05、F01、F02、F08；已覆盖                              |
| 暂停队列存在 → 手动 `/compact`                                                  | compact 追加到队尾，保持暂停；不弹文本队列处置确认，也不立即发压缩请求                                                                          | 来源：B13、C09、F03；已计划                                   |
| 当前轮或 foreground subagent/goal work 运行中 → 手动 `/compact`                 | 作为 compact 类型队列项严格入 FIFO，不停止当前 work；轮到时才进入 compact lifecycle                                                             | 来源：A08、H12、compact worksheet；已计划                     |
| 手动 compact 正在运行 → 发送普通文本或 `/goal ...`                              | 新输入进入 future queue，不打断压缩                                                                                                             | 来源：F04、F05；已覆盖                                        |
| compact 正在运行或队列里已有 compact → 再发 `/compact`                          | 明确拒绝并提示已有压缩；不新增队列项、不启动第二次请求、不显示普通用户消息                                                                      | 来源：F06、G07；已覆盖                                        |
| 手动 compact 正在运行 → 点击 Stop                                               | marker 标记 interrupted；会话进入 completed(interrupted)，queue 原样保留并暂停自动消费                                                          | 来源：F07；待补                                               |
| 手动 compact 请求失败                                                           | 不自动重试；回到 compact 前的 completed 状态，保留 queue 和 autoDrain；显示 failed marker 与重试入口，文本/goal/fork/edit/再次 compact 全部恢复 | 来源：F09；产品已裁决，待补 E2E                               |
| 普通发送、队首文本、queued goal 或 edit 重跑即将执行 → 系统判断需要自动 compact | 先自动压缩；成功后继续原 pendingAction，顺序不能颠倒                                                                                            | 来源：G01-G04；部分覆盖，真实触发窗口仍需稳定 fixture         |
| 自动 compact 正在运行 → 发送普通文本或 `/goal ...`                              | 输入进入 future queue；pendingAction 完成后再按 FIFO 消费                                                                                       | 来源：G05、G06；已覆盖                                        |
| 自动 compact summary 第 1、2 次无效，第 3 次成功                                | 最多重试 3 次；pendingAction 一直保留，第 3 次成功后继续执行                                                                                    | 来源：G08-G10；已覆盖                                         |
| 自动 compact 连续 3 次失败                                                      | 保留 retrying/failed marker，但继续无压缩执行 pendingAction；circuit breaker 生效，手动 compact 成功后重置计数                                  | 来源：G11；产品已裁决，待补 E2E                               |
| 自动 compact 正在运行 → 点击 Stop                                               | 与普通 Stop 对齐：pendingAction 作为当前轮 interrupted 用户输入保留，不复制回 queue；显式追加的 queue 全部保留并暂停消费                        | 来源：G12；产品已裁决，待补 E2E                               |
| queued manual compact 轮到前刚发生过 auto compact                               | 仍按用户显式意图执行；runtime 可以返回 noop marker，但不能静默删除该队列项                                                                      | 来源：compact worksheet；accepted，需随 typed queue case 验证 |

## 7. 切换模型、思考深度与草稿配置

| 操作路径                                                                                | 结果预期                                                                                                                | 备注                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Session A 使用 M1/D1，Session B 使用 M2/D2 → A/B 来回切换                               | 工具栏恢复各 session 自己的 provider、model 和 thought；同名模型也不能丢 provider 身份                                  | 来源：I01、I02、I06；已覆盖            |
| Session A 运行中或 queue 中有 Q1 → 切到 B 修改 B 模型 → A 继续或消费 Q1                 | A 的当前请求和后续队列请求继续使用 A 自己的配置，不受 B 变化污染                                                        | 来源：I05、I12、J05；已覆盖            |
| 用户在会话中显式选择 M3/D3 → 新建空草稿                                                 | 新草稿继承最后一次被 runtime 确认的 provider + model + thought 元组                                                     | 来源：I03、I11；已覆盖                 |
| 已完成会话 → 切换模型或思考深度 → 继续发送                                              | 历史不变；后续真实请求使用新配置                                                                                        | 来源：N01；已覆盖                      |
| 空草稿显式选择 high → 完成 A/B → 只把 A 改为 max → 依次续发 B/A                         | B 保持 high，A 保持 max；工具栏与真实请求都按 session 隔离，不能依赖 provider 默认档位                                  | 来源：I55；已覆盖                      |
| 当前请求运行中、queue 非空 → 切换到无需 context guard 的模型 → 等队列消费               | 已发请求继续使用创建时的旧配置；队列项消费时使用当前 session 最新配置                                                   | 来源：N02、I04；已覆盖                 |
| 切换模型 → Edit latest 用户消息                                                         | edit 重跑请求使用新模型和思考深度                                                                                       | 来源：N03；已覆盖                      |
| 切换模型 → fork 稳定 assistant → 在 child 继续发送                                      | child 不复制父 queue，并继承 fork 时父 session 的当前模型和思考深度                                                     | 来源：N04；已覆盖                      |
| 已完成会话、目标模型窗口太小 → 选择目标模型 → 取消或确认压缩                            | 取消时不切换；确认后使用旧模型做 guard compact，fresh usage 能放入目标窗口才完成切换，否则保持旧模型                    | 来源：N05；已计划                      |
| 当前轮运行中、queue 为空、目标模型窗口太小 → 选择“立即停止并压缩”                       | 原子停止 foreground work，等待锁释放，再用旧模型做 guard compact；压缩后满足预算才切换                                  | 来源：N09；已计划                      |
| 当前轮运行中、queue 非空且自动消费开启 → 选择过小模型并确认                             | 冻结自动消费并停止当前轮；queue 内容、顺序和提交端信息不变；guard compact 抢在 queue 前，成功切换后恢复原先的自动消费   | 来源：N10；已计划                      |
| 已中断且 queue 暂停 → 选择过小模型并确认                                                | guard compact 越过暂停队列立即执行；不弹 clear/keep 确认，不删除或重排 queue；切换后 queue 仍暂停                       | 来源：N11；已计划                      |
| guard compact 失败、被取消、usage 缺失或仍超预算                                        | 保持旧模型；已被停止的 turn 不恢复；queue 保留并保持暂停，UI 明确提示切换取消                                           | 来源：N12；已计划                      |
| guard compact 期间 → 同 session 再选模型、切换 task 或另一端更新配置                    | 旧选择 token 不得迟到切错模型或串到新 task；只按最新 session config/revision 收敛                                       | 来源：N13；已计划                      |
| auto compact 已运行 → 选择无需 guard 的模型                                             | 不打断 auto compact；配置立即生效，pendingAction 在真正消费时读取最新配置                                               | 来源：N06；部分覆盖                    |
| auto compact 已运行 → 选择窗口过小的模型                                                | 不启动第二次 compact；等待当前 auto compact 结束后读取 fresh usage，再决定是否切换                                      | 来源：N14；已计划                      |
| 当前 turn 正在执行工具调用 → 切换模型                                                   | 当前工具链使用原请求快照继续；切换只影响后续 turn 或 queue 消费                                                         | 来源：N07；现有为 probe                |
| 历史含图片 → 切换到明确声明 text-only 的模型 → 继续发送                                 | UI/恢复仍保留图片；新 provider 请求把历史图片投影为文本 placeholder，不携带 image block 或 data URL                     | 来源：N08；已覆盖                      |
| 默认工作区启动 → 打开模型列表 → 用默认 DeepSeek 模型首发                                | 列表展示目标模型；首发请求使用当前模型和思考深度，assistant 正常回复                                                    | 来源：I07；已覆盖                      |
| Settings 从 Template 创建两个 Provider 实例 → 编辑目标实例模型 Overlay → 首发           | Template 继承不复制成员；实例 Overlay 隔离；模型菜单和真实请求保留目标 provider 身份                                    | 来源：I08；已覆盖                      |
| provider 列表同时有可用和 disabled/缺凭据/缺 endpoint 项 → 打开模型菜单                 | 只展示真正可用的 provider/model；选择可见模型后能正常首发                                                               | 来源：I09；已覆盖                      |
| 空草稿 → 切到另一个模型或同名模型的另一个 provider → 立即首发                           | 工具栏、菜单选中态和真实请求都使用目标 provider/model；不能被已有 session 或迟到 workspace default 回弹                 | 来源：I10、I22；已覆盖                 |
| primary/alternate provider 暴露不同模型 → 选择 alternate 并首发                         | currentValue 保留 alternate provider id；请求 body 和 URL 都命中 alternate provider 的目标模型                          | 来源：I13；已覆盖                      |
| 分别选择 GLM、DeepSeek、Claude fixed/adaptive、GPT 模型的代表 thought 档位 → 首发或续发 | 请求字段严格使用对应 provider 协议形态，不能串入其它 provider 的 reasoning/thinking 字段                                | 来源：I14-I18；已覆盖                  |
| 冷启动时没有任何可用 provider/model → 跳过登录进入草稿 → 随后补齐 provider              | 未配置时不启动会话 Agent，显示模型配置提示；配置变为可用后只启动一次 Agent，水合草稿并清除提示                          | 来源：I23、I24；已覆盖                 |
| 重启前最后选择是可用外部模型或当前 Account Provider 内非首个模型 → 重启                 | 可用的完整 Provider/Model/Reasoning 选择继续保留，不能回退到模型列表首项                                                | 来源：I25-I26；已覆盖                  |
| GLM-5-Turbo 选择 off/enabled → 重启、首发或连续切 thought                               | 始终保持 Turbo 二态能力和正确请求；迟到 workspace 配置不能注入三态选项或改变模型                                        | 来源：I35-I38；已覆盖                  |
| Composer 快速连续切模型、thought 或 mode                                                | 控件立即显示选择并同步保存完整 Draft；最终只保留最后一次选择，迟到目录或 Session 状态不回弹旧值                         | 来源：I50、I51；已计划                 |
| Composer 刚切到新模型/thought/mode → 立即发送首条消息                                   | 在任何等待前冻结最新选择；真实请求和 session mode 使用冻结值。选择无效时不拿旧配置静默发送，正文和选择保留              | 来源：I52；已计划                      |
| 模型切换 ACK 已 accepted、目标 projection 尚未到达 → 立即新建草稿                       | 新草稿先继承目标模型且 thought 置空，不能继承源模型 thought；权威 projection 到达后再整体补实际 thought                 | 来源：I54；已计划                      |
| GLM-5.2/high 与 GLM-5-Turbo/enabled 之间切换                                            | model、thought current 和可选 thought 列表原子切换；不能把源模型档位套到目标模型                                        | 来源：I39、I42；I39 已覆盖，I42 已计划 |
| 只有旧版分离 model/thought 偏好，或打开了另一个历史 session                             | 只迁移能组成合法模型配置的元组；孤立 thought 被忽略；浏览历史 session 不改写最后一次显式选择                            | 来源：I43、I44；已计划                 |
| Workspace A 的未发送草稿切到 yolo/edit → 打开本地或 SSH Workspace B 新草稿              | B 使用自己的 Root Draft 和默认 mode，不继承 A；返回 A 后仍恢复 A 的选择                                                  | 来源：I45、I46；已计划                 |
| Root Draft 已设置 mode → 打开历史 session 并切换其 mode → 返回 Root Composer            | Session 与 Root scope 分别保存自己的 mode，互不覆盖                                                                      | 来源：I47；已计划                      |
| 草稿 mode localStorage 缺失、非法或不可读 → 进入新草稿                                  | 确定性回落 build，不继承旧 workspace/project mode，且不阻断输入框                                                       | 来源：I48；已计划                      |
| 草稿 mode 已选 edit → 迟到 workspace config/broadcast 返回其它 mode → 首发              | toolbar、预热 session 和首发都保持 edit，不被迟到配置覆盖                                                               | 来源：I49；已计划                      |
| V4 切换 custom provider 返回 `provider.notInRegistry`                                   | 强制重推 provider registry，并用相同目标配置只重试一次；第二次失败不得无限循环                                          | 来源：I40；待补                        |
| workspace prepare/configOptions 已失败 → 从恢复菜单选择可用 custom provider             | 写入选择并重启/重新 prepare；成功后回填模型目录和 toolbar，恢复发送能力                                                 | 来源：I41；待补                        |
| SSH 草稿 → 切模型/thought/mode → 立即首发                                               | 只更新精确 workspaceKey 对应的既有 prewarm session/App，不另起 Host、Agent runtime 或 SSH session；贯穿 remoteSessionId | 来源：I53；已计划                      |

## 8. Subagent 与后台任务

### 8.1 执行、通知与父子通信

| 操作路径                                                                          | 结果预期                                                                                                                       | 备注                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 父 assistant 启动 background Agent → 父 turn 先完成 → child 后完成                | child 完成后自动唤醒父 agent；provider 请求包含 task notification，UI 不出现伪造用户气泡                                       | 来源：BG01、BG05；已覆盖 |
| 父 assistant 启动 background Bash → Bash 完成                                     | 若父 active loop 仍在则把通知合流到下一次合法 roundtrip，否则 idle wake；原 Bash 工具块和历史保持稳定                          | 来源：BG02、BG04；已覆盖 |
| active goal continuation 启动 background Agent → goal 准备 verifier               | background task 仍运行时不发 verifier 请求；通知被父会话消费后才继续 verifier                                                  | 来源：BG03；已覆盖       |
| background Agent 正在执行本地工具 → 父模型调用 `SendMessage`                      | 消息投递到正确 child；child 工具结束后的下一次模型请求包含 coordinator message                                                 | 来源：BG07；已覆盖       |
| child 收到 coordinator message → 调用 `RespondToCoordinator` 并继续自己的工具工作 | 回复经父 runtime command queue 合流或唤醒父会话，provider 请求含 subagent message；UI 不显示真实用户气泡，child 继续并最终完成 | 来源：BG25；已覆盖       |
| background subagent 内部又启动 background Bash → child 首轮结束 → Bash 后完成     | 只做 child runtime cleanup；不再驱动 child 模型、不改写父 Agent 输出、不重复通知父会话                                         | 来源：BG06；已覆盖       |
| background Agent 运行中 → 用户在统一后台控制入口点击 Stop                         | child runtime 中止，父会话收到 stopped notification；running 控件消失，主会话仍可输入                                          | 来源：BG09；已覆盖       |
| background Agent 运行中 → 模型调用 `TaskStop`                                     | 使用同一 runtime dispatcher 停止任务；tool result 与 stopped notification 同源，不绕过命令队列                                 | 来源：BG10；已覆盖       |
| child 内触发 `AskUserQuestion` → 用户在父 task 回答                               | 问答卡出现在父 task 并标记 subagent 来源；答案进入 child 下一次请求，child 完成后父 continuation 正常收口                      | 来源：T01；已覆盖        |
| child 内触发 Bash permission → 用户在父 task 允许一次                             | 权限卡出现在父 task 并保留 child/parent 来源；Bash 结果进入 child 下一次请求，最终父会话收口                                   | 来源：T02；已覆盖        |

### 8.2 后台任务与普通对话、queue、compact 的关系

| 操作路径                                                                       | 结果预期                                                                                                   | 备注                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 只有 background Bash/subagent 在运行，主 turn 已 idle → 发送普通文本           | 立即开始新的主 provider 请求，不能因为后台任务仍运行而入 queue                                             | 来源：BG15；已覆盖                              |
| background-only running、主 turn idle、已有暂停队列 → 点击队列项“立即发送”     | 直接启动该队列项，不先 Stop background task；后台任务继续并按标准通知收口                                  | 来源：BG16；已覆盖                              |
| 主 turn 正在启动 background Agent → 连续发送 Q2/Q3/Q4                          | 主 turn active 时 Q2/Q3/Q4 进入权威 FIFO；主 turn 收口后依次消费，后台 Agent 独立完成并通知                | 来源：BG17；已覆盖                              |
| foreground Agent 与 background Agent 的 child tool 都在更新                    | foreground child 可让主聊天保持 streaming/loading；background child 更新不得把 idle 主聊天误标为 streaming | 来源：BG13、BG14；已覆盖                        |
| background Agent 仍运行、主会话已 idle → 手动 `/compact` → 后台完成            | 允许压缩；后台完成通知基于压缩后的摘要继续父请求，不显示 synthetic 用户气泡                                | 来源：BG19；已覆盖                              |
| guide 模式下 background Agent launch tool result 尚未进入下一轮 → 发送引导文本 | 引导与 launch result 在同一后续请求合流，不落普通 future queue                                             | 来源：BG20；历史覆盖，当前 V4 formal 仍 pending |
| background result 形成独立 assistant turn → 查看 retry/fork                    | 结果轮没有普通 retry capability，也不会让更早真实用户轮重新获得 retry；稳定结果仍可按 fork 规则处理        | 来源：BG33；已覆盖                              |

### 8.3 子工具投影、失败与后台控制 UI

| 操作路径                                                                        | 结果预期                                                                                           | 备注                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| background Agent 的 child Bash 工具卡已出现 → 再发送一轮主消息 → child 更新到达 | child 工具仍聚合在原 Agent 卡片下，不挂到最新主回复                                                | 来源：BG18；已覆盖                                 |
| child Bash 运行中 → 切到其它 task/draft → 隐藏期间完成 → 切回                   | 原 Agent 卡下仍只有一个 child 工具块，命令、描述、输出保留，并从 running 正确收口                  | 来源：BG21；已覆盖                                 |
| child Bash 运行中 → 切走后立刻切回 → child 随后完成                             | 切回时仍显示 running；同一工具块随后更新为 terminal，不显示 Unknown 或永久执行中                   | 来源：BG22；已覆盖                                 |
| 后台控制面板有多个 running task → 其中一个完成                                  | 只移除已完成项，其余 running 行持续可见，不因 partial snapshot 闪没再出现                          | 来源：BG23；已覆盖                                 |
| 多个 background Agent 同时运行 → 通知处理中切换 task 再切回                     | 仍在运行的 Agent 控制行全程保留，restore/live overlap 或 Todo 更新不能把它们短暂清空               | 来源：BG24；已覆盖                                 |
| background Agent 的 child provider 请求以 429 失败 → 查看错误并切换 task 后返回 | Agent 卡显示 failed；摘要和 hover 保留 provider 原始错误，恢复后仍是 failed + error，父会话回 idle | 来源：BG26；已覆盖                                 |
| 三个 background Agent 依次失败、完成、失败，通知同批回传 → 查看卡片并切回 task  | 两张失败卡都为失败且只显示自己的原因，完成卡为完成；恢复后不变                                     | 来源：BG26；已覆盖                                 |
| background Agent/Bash idle wake 形成独立结果 turn → 刷新                        | 使用结构化任务标题完整展示总结，刷新后标题保持；active-loop 合流不额外插标题                       | 来源：BG27、BG28；部分覆盖                         |
| 【历史路径，已退役】Composer 较宽，只有 Bash、只有 Subagent 或两者都在运行 → hover/click 后台入口 | 图标、数量和 tooltip 按类型展示；点击直接展开 Status panel 对应区块，不聚合其它 session/workspace  | 旧面板路径不计入当前覆盖；Activity 胶囊保留本批结束结果至下次成功输入，并通过浮层目录入口查看历史。见状态胶囊规格。 |
| 【历史路径，已退役】后台任务从 running 依次完成或失败                                             | 只统计 `status=running`；某类型归零就移除该类型，最后一个 running 结束后入口立即消失               | 旧面板路径不计入当前覆盖；Activity 胶囊保留本批结束结果至下次成功输入，并通过浮层目录入口查看历史。见状态胶囊规格。 |
| 【历史路径，已退役】Composer 宽度不超过 480px、存在后台任务 → 点击合并入口                        | 显示 Activity + 总数，Status panel 以 overlay 展开；不产生横向溢出或桌面 inline offset             | 旧面板路径不计入当前覆盖；Activity 胶囊保留本批结束结果至下次成功输入，并通过浮层目录入口查看历史。见状态胶囊规格。 |
| 【历史路径，已退役】同时存在 Goal/Todo/Git 主状态和后台活动 → 查看收起胶囊                        | 有主状态时只显示最高优先级主状态；没有主状态时才用 Bash/Subagent/混合活动作兜底                    | 旧面板路径不计入当前覆盖；Activity 胶囊保留本批结束结果至下次成功输入，并通过浮层目录入口查看历史。见状态胶囊规格。 |

### 8.4 子会话详情与目录

| 操作路径                                                                                    | 结果预期                                                                                               | 备注                                                                |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Agent/Task 摘要已有 childSessionId → 点击，或按 Enter/Space                                 | 直接在右侧打开完整只读 child tab；标题逐字使用摘要标题，不展开行内 Prompt/输出，不改变 active task     | 来源：SAT01；自动化已覆盖，正式 desktop candidate 仍 pending review |
| 同一父 task 依次打开 6 个以上 child → 再点其中一个                                          | 可创建 6+ tabs，不受 4 pane 限制；重复点击只激活既有 tab                                               | 来源：SAT02；自动化已覆盖，正式 desktop candidate 仍 pending review |
| 多个 child tabs 已打开且持续 streaming → 切换激活 tab                                       | 激活与非激活 child 都持续接收 text/reasoning/tool/status；切回直接显示最新内容                         | 来源：SAT03；部分覆盖                                               |
| Parent A/B 都有 child tabs → A/B 来回切换                                                   | 只显示当前 parent 的 child 组；隐藏组继续订阅，切回恢复顺序和最后激活项                                | 来源：SAT04；部分覆盖                                               |
| 关闭 child tab → 从 Agent 行重新打开 → 刷新 renderer 后再打开                               | 同一 child 复用稳定 tab id 和最新标题；刷新不自动恢复 tab，但重新打开能 cold hydrate 完整历史          | 来源：SAT05、SAT09；已覆盖                                          |
| 两个远程 workspace 的 path 相同、identity/session 不同 → 分别打开 child                     | tab、父组、订阅和最近关闭互相隔离；执行仍使用各自 workspacePath                                        | 来源：SAT06；已覆盖                                                 |
| child raw event 和 parent mirror 同时更新                                                   | raw child event 只推进 child topic，不更新父活跃时间或父 timeline；选定 mirror 仍更新父 Agent 状态     | 来源：SAT07、SAT08；已覆盖                                          |
| 手机 `/remote` → 点击 Agent/Running 的 child 详情                                           | 复用现有右侧 drawer 打开只读详情；active task 不变，不新建 Host/runtime，不开放目录                    | 来源：SAT10；已计划                                                 |
| Agent/Task 暂无 childSessionId 或启动前失败 → 点击摘要                                      | 保持静态单行，无按钮/chevron/inline 详情；child id 后到只变为可点击，不自动打开                        | 来源：SAT11；已覆盖                                                 |
| Status panel 中 foreground/background subagent 有 child id → 点击 Running 行；再点击原 Stop | 复用同一 child 详情请求且不重复建 tab；详情动作不改变 Stop 仍只取消任务；Bash/无 child id 项无详情入口 | 来源：SAT12；部分覆盖                                               |
| child 当前有 `control.lastError` → 打开只读详情                                             | 显示可读、可复制的紧凑错误 notice，不新增 timeline error row                                           | 来源：SAT13；已覆盖                                                 |
| 打开“智能体”目录 → 查看 running 和 ended → 连续点击“再显示 20 个”                           | running 全量显示；ended 最新优先、每页 20 条、无重复遗漏                                               | 来源：SAT15、SAT16；已覆盖                                          |
| 【历史路径，已退役】Status panel 展开 → 收起/展开“智能体” → 点击“已结束 · N”                | mini 只统计 running；expanded 把 running 和 ended 入口放在同一“智能体”分组，点击 ended 打开或复用目录  | 旧面板路径不计入当前覆盖；Activity 胶囊保留本批结束结果至下次成功输入，并通过浮层目录入口查看历史。见状态胶囊规格。 |
| 目录已加载多页并滚动 → running child 完成                                                   | 同一项移动到 ended 顶部并更新总数，已加载页和滚动位置不重置、不重复                                    | 来源：SAT19；已覆盖                                                 |
| Edit/retry 移除了含 child 的旧分支                                                          | timeline、摘要和目录同步移除 child；详情 tab 自动关闭且不进入最近关闭                                  | 来源：SAT20；已覆盖                                                 |
| compact 后仍引用旧 child；或从稳定 turn fork                                                | compact 不删除成员或关闭 tab；fork 只继承可靠 ended child 引用，不继承 running child                   | 来源：SAT21；部分覆盖                                               |
| 历史失败 Agent 没有可靠 child id，另有可靠 completed child                                  | 不显示模糊 stub；可靠 child 可打开并 cold hydrate；目录和 child tabs 都不跨刷新自动恢复                | 来源：SAT22；已覆盖                                                 |

### 8.5 Subagent 模型与 prompt

| 操作路径                                                                             | 结果预期                                                                                                                                    | 备注                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 冷启动时 subagent profile 绑定 alternate provider → 主会话直接触发 child             | CLI 在 child 执行前已拿到完整 provider registry；child 使用 alternate provider/model 正常完成                                               | 来源：I19；已覆盖                |
| Settings 为内置 `general-purpose` / `Explore` 设置模型覆盖 → 冷启动 → 分别触发 child | Settings 回显覆盖；child 使用覆盖模型，父 continuation 仍用主模型；Explore 工具能力按最终 child 模型计算                                    | 来源：I20、BSM-01-BSM-07；已覆盖 |
| 连续触发内置和 custom subagent → 检查 child provider request                         | system prompt 只有 ZCode prefix 与 agent-specific prompt + Notes 两段，env/model/日期走 child 公告；custom markdown 进入约定 system message | 来源：I21；已覆盖                |

## 9. 多端、恢复与剪枝口径

| 操作路径                                                                | 结果预期                                                                                                               | 备注                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 桌面 continuous 与手机 replayable 同时查看同一 session → 驱动到相同终态 | 两端中间帧可不同，但终态 projection 必须逐字段一致；慢手机或 gap 恢复不能影响桌面订阅                                  | 来源：PV4-01、PV4-02；产品 accepted，E2E 待补 |
| 手机 `/remote` 对 latest turn 执行对话/文件重置                         | 命令经 shared-host attachment 在同一 runtime 执行；workspaceIdentity 和 remoteSessionId 贯穿，不新建独立 Agent/runtime | 来源：PV4-24；部分覆盖                        |
| 同一操作只改变 delivery profile，不改变产品终态                         | 不把 desktop/mobile 与每个 goal/fork/edit/compact 状态做全排列；用交付专项证明恢复，用业务 case 证明终态               | 剪枝：client mode 不是业务 guard 自由变量     |
| queue 长度从 1、2 到 `3+`                                               | 只有边界展示和 FIFO 数量变化时展开；其它 queue 行为用 `0` 与 `>0` 代表，不复制所有长度组合                             | 剪枝：A03-A06 保留长度边界，其余场景折叠      |
| fork 与每种模型、goal、queue 长度、tool 名、background 数量组合         | 分别用配置继承、goal 继承、queue 不复制、逻辑 tool turn 和 background 不复制代表；不做全笛卡尔积                       | 剪枝：FX01、FX03、FX08、FX09                  |
| subagent nested runtime、Workflow artifact、手机子智能体目录            | 当前不进入正式 E2E 产品承诺；nested 只保留 UI 身份/reducer 合同，手机只开放已有 drawer 详情                            | 剪枝：SAT14、subagent 设计文档                |
| goal 的 429/503、SSE 中断、断网、磁盘满或 app 关闭恢复                  | 不混入主路径人工验收；在环境故障 catalog 中继续保持 undefined 或专项决策                                               | 来源：G6-01-G6-07；不生成稳定主路径断言       |
