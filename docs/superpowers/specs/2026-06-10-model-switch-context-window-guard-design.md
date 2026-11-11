# Model Switch Context Window Guard Design

## Feature/change summary

V4 composer 当前直接执行 `switchModelConfig`，没有恢复 legacy toolbar 的模型切换上下文守卫。已有产品语义要求：当当前会话已使用上下文超过目标模型可用于输入侧的预算时，不能直接切换，必须先使用当前模型压缩，压缩后确认可容纳才切换。

本次恢复同时调整旧语义：运行中的 task 不再拒绝 guard。确认按钮显示“立即停止并压缩”，由 CLI 原子地停止当前 foreground work、冻结但保留已有队列，并让本次 guard compact 抢在队列前执行。普通 `/compact` 仍保持现有 FIFO，不受本特例影响。

当前 V4 未实现上述行为，属于 `bug-candidate`；本文是实现前事实源，不代表代码已经完成。

## Clarification log

| 日期       | 问题                                                      | 用户裁决               | 固定边界                                                                         |
| ---------- | --------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| 2026-07-15 | 目标窗口不足且 task 正在运行时，是拒绝切换还是等待/抢占？ | 提供“立即停止并压缩”   | 用户确认后停止当前 foreground work，不保留一个等待当前轮自然结束的隐式 UI intent |
| 2026-07-15 | 已有 queue 是否阻止 guard compact？                       | 不阻止，点击后直接压缩 | guard compact 越过已有 queue；queue 内容和相对顺序不删除、不修改                 |
| 2026-07-15 | guard 是否改变普通 `/compact`？                           | 否                     | 仅模型切换 guard 使用抢占语义；A08/B13 的普通 `/compact` FIFO 语义保留           |
| 2026-07-15 | 成功后 queue 如何恢复？                                   | 恢复操作前状态         | 原来 `autoDrain=true` 则模型切换落稳后继续消费；原来 held 则继续 held            |
| 2026-07-15 | compact 失败或仍超窗怎么办？                              | 保持安全停态           | 不切模型；已停止的 turn 不恢复；queue 保留并保持 held                            |
| 2026-07-15 | 已有 auto compact 怎么办？                                | 不重复压缩             | 等已有 compact 终态后复核 usage，不中断、不创建第二个 compact                    |

## Goals

- 只拦截已有 active session 的模型选择；draft workspace 默认模型选择不变。
- 在真正切换前判断 `currentUsedTokens > targetEffectiveContextWindow`。
- 目标窗口不足时显示确认弹窗；空闲态确认按钮为“压缩”，运行态为“立即停止并压缩”。
- 空闲态使用当前模型立即 compact；运行态原子停止当前 foreground work 后立即 compact。
- guard compact 不受已有 queue/held choice 阻挡，但必须保留 queue 内容、顺序和提交端信息。
- 压缩成功且 fresh usage 满足目标预算后才执行目标模型切换。
- 模型切换成功后，仅在 guard 前 `autoDrain=true` 时恢复 queue 消费。
- 保持 desktop continuous 与 mobile web-remote replayable 共用同一 CLI session/command 状态机。

## Non-goals

- 不改变普通 `/compact` 的 FIFO：running 时追加队尾，held 时仍追加暂停队列。
- 不改变 agent 自动 compact 阈值或 auto compact lifecycle。
- 不为 draft session 增加 guard。
- 不删除、编辑或重排已有 queue item。
- 不自动恢复已被 stop 的 assistant turn、tool work 或 goal continuation。
- 不允许用户强制忽略目标窗口不足继续切换。
- 不在 relay、desktop main 或 remote bridge 中保存 guard、queue、compact 或模型切换业务状态。

## Domain scope and high-risk cross-products

| Domain                   | State owner                                                    | 本次责任                                                                      | 高风险交叉                                                     |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| V4 composer/model config | `packages/ui/src/v4/SessionPane.tsx` + CLI `switchModelConfig` | 解析用户目标、显示确认、消费权威投影、提交最终模型切换                        | 迟到选择、revision CAS、custom/native provider metadata        |
| Context usage/compact    | CLI session runtime + V4 projection                            | 以当前模型执行 compact，产出 marker 和 fresh usage                            | compact ACK 不等于完成、重复 compact、失败/取消                |
| Stop/queue               | CLI command core                                               | 冻结 auto-drain、停止 foreground work、保留 queue、使 guard compact 抢占 FIFO | stop 终态迟到、held queue、运行中新增输入、goal pause          |
| Client delivery          | shared host/CLI session                                        | desktop continuous 与 mobile replayable 观察同一命令事实                      | 重连、另一端改模型、`workspaceIdentity`/`remoteSessionId` 隔离 |

## Concept map and current facts

- V4 模型入口：`packages/ui/src/v4/composer/V4ComposerToolbar.tsx` 当前把选择直接交给 `onSelectModel`。
- V4 模型写入：`packages/ui/src/v4/SessionPane.tsx` 当前通过 `switchModelConfigWithRecovery` 和 revision CAS 写 session config。
- usage 权威字段：`packages/shared/src/zcode-protocol-v4/snapshot.ts` 的 `usage.contextWindow.usedTokens/maxTokens/autoCompactThresholdTokens`。
- 目标模型 metadata：`ModelProviderModelConfig.contextWindow/maxOutputTokens`；`resolveModelProviderContextWindow()` 负责 fallback 与 `[1m]`。
- 普通 compact：`commandPayloadSchemas.compact` 当前为空 payload；CLI `goal-compact.ts` 在 busy/held 下把它追加到 FIFO。
- stop：CLI `session-flow.ts` 先 pause active goal，再 abort 当前 controller；既有 B02-B04 语义要求 queue 保留并关闭 auto-drain。
- projection：command ACK 只证明 admission，guard 必须等待 compact marker 终态和后续 fresh usage，不能把 ACK 当作压缩成功。
- 旧 `packages/desktop/test/e2e/conversation-session/models/conversation-session-model-switch-auto-compact.test.ts` 只作历史证据，不能计为当前 V4 正式覆盖。

## Budget rule

目标有效输入预算与 agent auto compact policy 保持一致：

```text
outputReserve = positive(maxOutputTokens) ?? 64_000
effectiveReserve = min(outputReserve, contextWindow)
targetEffectiveContextWindow = max(0, contextWindow - effectiveReserve)
needsGuard = currentUsedTokens > targetEffectiveContextWindow
```

- native/custom/modelIdByKind 都必须解析到同一条目标模型 metadata。
- `[1m]` 等模型继续复用 `resolveModelProviderContextWindow()`。
- 当前 usage 或目标 metadata 缺失/无效时保持 legacy fail-open，不因陈旧 metadata 卡死既有切换链路；该分支用单测覆盖，不扩成 E2E 矩阵。
- compact 后 usage 缺失/无效则 fail-closed：不能证明可容纳时不切换。

## Product state and sequence

```text
desktop-continuous / web-remote-replayable renderer
                         |
                  select target model
                         |
             resolve target effective budget
                         |
             +-----------+-----------+
             | used <= budget        | used > budget
             v                       v
       switchModelConfig CAS    confirmation dialog
                                     |
                     +---------------+---------------+
                     | idle/completed                | running/stoppable
                     v                               v
              button: “压缩”              button: “立即停止并压缩”
                     |                               |
                     +---------------+---------------+
                                     |
                         guard compact command
                                     |
             CLI: snapshot previous autoDrain + set false
                                     |
             CLI: stop foreground work + wait active lock idle
                                     |
             CLI: start compact before every preserved queue item
                                     |
                  compact terminal projection + fresh usage
                                     |
                revalidate session / selection / revision
                         +-----------+-----------+
                         | fits                  | failed/stale/too large
                         v                       v
              switchModelConfig CAS       keep old model
                         |                 keep queue held
              restore autoDrain only
              when it was previously true
```

## Command/protocol design

不能在 renderer 连续发送 `stop` 和普通 `compact`：两个 command 之间存在 queue auto-drain/跨端命令插入竞态，普通 compact 还会按当前协议落到队尾。

计划在 `packages/shared/src/zcode-protocol-v4/index.ts` 导出的严格 command schema 中增加独立的 guard 抢占命令（实现命名建议 `preemptCompact`）：

- 必须携带 `baseRevision`，在 CLI 开始 destructive stop 前拒绝陈旧确认。
- commandId 是幂等边界；同一 session 已有 manual/guard compact running 或 queued 时返回 `compactOperationLock`。
- CLI command core 在同一裁决中依次：读取原 `autoDrain`、设置 `false`、按既有 Stop 语义 pause goal/abort foreground controller、等待 idle、直接调用唯一 `startManualCompact` 路径。
- 抢占命令不进入普通 input FIFO；queue item 原样保留。
- compact 运行期间新增输入仍进入 queue，不能打断 compact。
- compact 终态由既有 timeline marker/usage projection 表达，不新增 relay/main 状态。
- renderer 只有在 compact 成功、fresh usage 合格、原 session/选择仍有效时才调用既有 `switchModelConfigWithRecovery`。
- 模型切换成功后以新的 revision 调 `setAutoDrain(true)`；仅 guard 开始前为 true 时执行。失败、usage 不明、仍超窗时不恢复 auto-drain。
- 若发起 renderer 在 compact 后断连，CLI 保持旧模型和 held queue；重连后用户能从权威投影继续操作，不执行幽灵模型切换。

## UI behavior

- 弹窗只在 `needsGuard=true` 时出现。
- 空闲态标题沿用“需要压缩上下文后再切换模型”，确认按钮为“压缩”。
- running/stoppable 时说明当前响应会立即停止、已有队列会保留；确认按钮为“立即停止并压缩”。
- 取消、Esc、遮罩关闭均不停止、不 compact、不切换模型。
- guard 进行中禁用同一动作的重复确认，并展示现有 compact lifecycle；不能额外伪造 user message。
- 等待期间用户在同一 session 选择别的模型时，旧目标 selection token 失效；已经开始的 compact 可以完成，但旧目标不得迟到覆盖新选择。
- 用户切换到其他 task 时，原 session 的 compact 继续按 CLI 事实收口，但不得把模型切到新 task。
- desktop、Web、手机 Web 复用相同组件和 i18n；遵守 `DESIGN.md` 的现有 ConfirmDialog、语义色、紧凑尺寸、双主题和响应式规则。

## Dimensions and pruning

| Dimension     | Equivalence classes                                                               | 处理                                                                                                      |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Session phase | draft / completed / running / compacting                                          | draft pruned；completed、running accepted；已有 auto compact 复用 N14                                     |
| Queue         | empty / auto-drain queue / held queue                                             | 三类保留；数量 `1/2/3+` 由“内容与相对顺序不变”不变量折叠，代表值取 2                                      |
| Guard result  | cancel / compact success fits / success still too large / failed or usage unknown | cancel、fits、fail-closed 都必须证明                                                                      |
| Client        | desktop continuous / mobile replayable                                            | 产品语义相同但投影证据分开；不把 replay gap 逻辑扩散到 desktop                                            |
| Provider      | native / custom / mapped runtime id / metadata unknown                            | resolver 用单测做 pairwise；E2E 取可控的 native fixture                                                   |
| Active work   | assistant output / tool or goal foreground / independent background work          | 共用既有 Stop foreground 不变量；background work 不因本 guard 扩大停止范围                                |
| Workspace     | local / SSH-WSL-Docker identity                                                   | command 按 session 隔离；remote 用 `workspaceIdentity + remoteSessionId` 聚焦验证，不全量叉乘 OS/provider |

Pruning decisions：

- 普通 `/compact` × 抢占语义：`pruned`，由命令入口 invariant 隔离，A08/B13 不变。
- queue 数量全笛卡尔积：`pruned`，queue 不删除、不重排，代表值覆盖即可。
- draft × guard：`pruned`，没有 active session usage。
- unknown metadata × E2E：`pruned` 到 resolver unit test；产品保持 fail-open。
- 每种 provider × desktop/mobile：`pruned`，metadata resolver 与 delivery projection 分层证明。
- 当前 V4 直接切换过小模型：`bug-candidate`，实现后由 N05/N09-N14 收口。

## Accepted cases

| ID  | Setup                                                                    | Action                                           | Assertions                                                                              | Evidence                                                         |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| N05 | completed、queue=0、used 超过目标预算                                    | 选择目标并取消/确认                              | 取消不变；确认用旧模型 compact；fresh usage 合格后才切换                                | dialog、compact request/marker、snapshot usage/config            |
| N09 | running、queue=0、used 超预算                                            | 点击“立即停止并压缩”                             | foreground turn interrupted；guard compact 随后启动；成功后切模型                       | stop/compact timeline、provider request model、config projection |
| N10 | running、queue=2、autoDrain=true                                         | 确认 guard                                       | queue 内容/顺序不变；compact 抢在 queue 前；切换后恢复 auto-drain，queue 用目标模型消费 | CLI queue projection、request order、model config                |
| N11 | completed/interrupted、queue=2、autoDrain=false                          | 确认 guard                                       | 不弹 held queue clear/keep；compact 立即启动；queue 保持 held，模型切换不触发消费       | inputRouting、queue IDs/order、compact/config projection         |
| N12 | running 或 completed、compact failed/cancelled、usage unknown 或仍超预算 | 确认 guard                                       | 不切模型；已停止 turn 不恢复；queue 保留且 held；给出明确提示                           | failed marker、usage/config、queue autoDrain                     |
| N13 | guard 已确认，compact 等待/运行中                                        | 同 session 新选模型、切 task 或另一端更新 config | 旧 selection token 不得迟到切错模型/task；新选择以最新 config/revision 为准             | command/revision、session-scoped projection、两端最终 config     |
| N14 | auto compact 已在运行且目标模型上下文不足                                | 选择模型                                         | 不停止、不发第二个 compact；等待现有 compact 后复核并执行最新有效选择                   | single compact lifecycle、pending selection、config CAS          |

## Error handling

- preempt command 因 revision stale 被拒绝：不 stop、不 compact；基于最新 snapshot 重新判断。
- operation lock：不重复 compact；如果是已有 auto compact，等待其终态后复核；如果是另一手动 compact，复用同一终态但不伪造成功。
- stop 后 compact 启动失败：旧模型不变、queue held，并保留 interrupted/failed 事实。
- compact 成功但 fresh usage 无效或仍超窗：旧模型不变、queue held，toast 说明切换取消。
- 后续模型切换失败：沿用现有 model config 错误处理，queue 不恢复 auto-drain。
- `setAutoDrain(true)` 恢复失败：模型已切换事实不回滚；queue 保持 held，并提示用户手动继续。

## Test and E2E handoff plan

文档顺序必须先于测试代码：先更新 `docs/conversation-session-case-catalog.md` 与 `docs/testing/conversation-session-e2e-coverage-matrix.md`，N05/N09-N14 初始标记为 `planned`，不得继续把 legacy MG pending spec 记作覆盖。

Unit/integration：

- metadata resolver：native、custom、`modelIdByKind`、`[1m]`、`maxOutputTokens`、64k fallback、unknown fail-open。
- budget/guard：fits、cancel、completed compact、running preempt、failed/unknown/too-large fail-closed。
- command core：revision stale 无副作用；queue 保留/顺序不变；goal pause + controller idle barrier；compact operation lock；普通 compact FIFO 回归。
- UI：按钮按 phase 显示“压缩”或“立即停止并压缩”；迟到 selection/task/revision 不应用旧目标。
- delivery：desktop continuous 与 mobile replayable 都从同一 CLI command/projection 收口；remote identity 不只按 `workspacePath` 匹配。

E2E：

- 基于 case-local provider fixture 构造可控的小目标 context window 和 compact 后 usage，不依赖线上模型碰运气。
- 优先正式覆盖 N05、N09、N10；N11-N14 先进入 manual-review/pending，证据稳定后再晋级。
- desktop formal E2E 证明 UI、provider request 顺序和 queue/config 投影；mobile replayable 用聚焦 service/integration case 证明同一命令事实、断线恢复和 identity 隔离。
- 不以“路径经过 running/queue”替代 setup/action/assert；每个 covered case 必须分别看到 stop、compact、usage、switch 和 queue 结果。

## Acceptance criteria

- completed session 选择过小模型会先确认压缩，取消不改变模型。
- running session 的确认按钮为“立即停止并压缩”，确认后当前 foreground work 被停止。
- 无论 queue 是否存在或 held，guard compact 都立即越过 queue，但 queue 内容和顺序不变。
- compact 使用切换前模型；fresh usage 满足预算后才切换目标模型。
- 成功后只恢复 guard 前已开启的 auto-drain；held queue 不被擅自启动。
- compact 失败、usage 不明或仍超窗时保持旧模型和 held queue。
- 普通 `/compact` running/held FIFO 行为无回归。
- desktop continuous 与 mobile replayable 最终观察同一 stop/compact/model/queue 事实，没有 relay/main 业务状态。
