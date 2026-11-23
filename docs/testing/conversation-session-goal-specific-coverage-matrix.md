# Conversation Session Goal Specific Coverage Matrix

> `retired:` 逐处标记已退役 App 单测，仅供追溯；原通过记录不代表现行覆盖。独立断言缺口需由后续验收补齐。

> 2026-10-26：App 业务单测已按[测试规格](unit-test-quality.md)退役。本文中的相关单测路径和历史通过记录不再代表现行覆盖；CLI/CUA、工程测试、E2E 与浏览器验收证据仍按各自状态解释。未补验收的场景不得自动视为已覆盖。

本文只统计 goal 专项组合，避免把普通 running/queue/compact 的通用覆盖误算成 goal 覆盖。

注意：goal 相关 spec 当前随 conversation 主路径一起迁入 `packages/desktop/test/e2e/conversation-session/manual-review/pending/`。本文件里的 `covered` 表示已有历史专项 setup/action/assert；在人工 review 并升格回默认路径前，它们不代表默认 conversation 质量门禁已经收口。

Goal 与 fork 的交叉组合按 fork 不变量剪枝，详见 [conversation-session-fork-cross-product-matrix.md](./conversation-session-fork-cross-product-matrix.md)。

状态含义：

| 状态        | 含义                                             |
| ----------- | ------------------------------------------------ |
| `covered`   | 已有 goal 专项 setup/action/assert               |
| `partial`   | 被相邻通用 case 覆盖了一部分，但缺 goal 专项断言 |
| `missing`   | 产品预期已明确，但还没有自动化                   |
| `failing`   | 已有探针但当前实现不满足                         |
| `undefined` | 产品预期或失败语义未确认                         |

## 当前专项统计

| 范围                 | covered | partial | missing | failing | undefined |
| -------------------- | ------: | ------: | ------: | ------: | --------: |
| Goal 基础状态        |      10 |       2 |       0 |       0 |         0 |
| Goal + queue         |      11 |       2 |       1 |       0 |         0 |
| Goal + compact       |       4 |       1 |       0 |       1 |         3 |
| Goal + fork/edit     |       3 |       1 |       1 |       0 |         3 |
| Goal + session/model |       4 |       1 |       0 |       0 |         0 |
| Goal 验证手段        |       1 |       5 |       0 |       0 |         0 |
| Goal 环境异常        |       0 |       0 |       0 |       0 |         7 |
| Goal 恢复同步        |       2 |       0 |       0 |       0 |         0 |

## G0. Goal 基础状态

| ID    | 场景                                            | 期望                                                                                                                                        | 状态    | 自动化                                                                                                                                                                         |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G0-01 | completed + 无 goal + `/goal`                   | 设置 goal；原始命令立即显示为 real-user query；UI 展示目标；不出现 `validating` 锁                                                          | covered | bootstrap live/cold projection regression + `conversation-session-goal.test.ts`                                                                                                |
| G0-02 | completed + 已有 goal + `/goal replace`         | 替换为去前缀后的新目标；原始命令仍按原文显示；不生成两套错乱目标                                                                            | covered | bootstrap command/persistence regression + `conversation-session-goal.test.ts`                                                                                                 |
| G0-03 | running + 无 goal + `/goal`                     | 只入队，不立即发目标请求；消费时原始命令显示为 real-user query                                                                              | covered | bootstrap command regression + `conversation-session-goal.test.ts`                                                                                                             |
| G0-04 | running + 已有 goal + `/goal`                   | 只入队，消费时更新目标并显示原始命令 query                                                                                                  | covered | bootstrap command regression + `conversation-session-goal.test.ts`                                                                                                             |
| G0-05 | goal continuation 被 stop                       | 退出 streaming；queue 保留；默认不自动消费；不出现 paused 产品态                                                                            | covered | `conversation-session-goal-session-model.test.ts`                                                                                                                              |
| G0-06 | goal 验证阶段                                   | 不产生独立 validating 禁止态，不额外禁 compact/fork/edit                                                                                    | covered | `conversation-session-goal.test.ts`                                                                                                                                            |
| G0-07 | active goal 摘要点击 pause                      | 独立 `pauseGoal` 结算耗时并进入 paused；有 active work 时终止，没有 active work 时也可暂停；不复用 stop queue disposition                   | covered | bootstrap command/projection + UI focused + `conversation-session-v4-goal.test.ts`                                                                                             |
| G0-08 | paused goal 摘要点击 resume                     | `resumeGoal` 保留累计耗时并开启新 active 区间；继续既有 goal                                                                                | covered | bootstrap command/projection + UI focused + `conversation-session-v4-goal.test.ts`                                                                                             |
| G0-09 | 同一 target 多轮 todo/verifier                  | 每轮 action/status/progress 都显示；todo 非空且全完成才显示绿色编号圈                                                                       | partial | projection/UI focused；待 provider replay formal case                                                                                                                          |
| G0-10 | verified goal 摘要                              | 冻结耗时、绿色圆圈对勾，隐藏 pause/resume；cold/live 一致                                                                                   | partial | projection/UI focused；待 desktop + replayable formal gate                                                                                                                     |
| G0-11 | Plan 模式从 composer 提交 `/goal` 或 goal alias | 只 toast；保留输入；不创建/更新/恢复 goal，不 dispatch command                                                                              | covered | 退役单测的独立断言待补；历史记录：`retired:packages/ui/test/v4SessionPaneModelSwitchRecovery.test.ts` + `retired:packages/ui/test/v4ConversationComposerPromptHistory.test.ts` |
| G0-12 | completed 历史切换模型后立即 `/goal`            | 模型切换 marker 仍显示，但只记录原始 query 的 control-only turn 不显示“工作中/已工作”；真实 continuation 只显示一个工作状态；live/cold 一致 | covered | bootstrap live/cold projection + UI render-unit/component focused regression                                                                                                   |

### G0-07 / G0-08 暂停时序回归（2026-11-11）

- CI 暂停失败发生在首个输出到达窗口。本地受控释放首个输出后立即点击，复现 `pauseGoal` ACK 为 `stale / proto.staleRevision`（artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20261111120818371-p35937-d94f52f325cb4608`）。点击脚本返回成功不能证明命令接纳。
- 用例先等待首个正文输出进入真实时间线，fixture 在第三个 SSE chunk 后挂起，再点击暂停；真实暂停负责中止挂起请求。移除固定 45 秒结束窗口，不增加重试或放宽超时。
- 暂停与继续分别断言真实 ACK `accepted`，随后保留 `paused` 与恢复状态断言。该用例验证稳定运行态的暂停/继续，不修改产品 CAS 规则；并发版本冲突的产品交互不在本次修复范围。
- 修复后 macOS 桌面回放 1/1 通过，暂停与继续 ACK 均为 `accepted`：`packages/desktop/.e2e-artifacts/desktop-e2e-20261111120930601-p36774-2fa4d0e55c34502b`。App 与 Agent 在诊断首轮完整重建，修复只涉及测试，复用同一产物。fixture 校验、E2E 类型检查、根类型检查、lint（0 错误）、架构检查通过。Windows CI 尚未验证，未运行 Docker 或手机。

## G1. Goal + Queue

| ID    | 场景                                                      | 期望                                                                                                                                                                           | 状态    | 自动化                                             |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------- |
| G1-01 | queue 里多个 `/goal`                                      | running 中保持 FIFO；stop 后 held queue 不自动消费；连续消费覆盖目标由 send-now/goal-run 专项覆盖                                                                              | covered | `conversation-session-goal-queue.test.ts`          |
| G1-02 | queue 混合普通文本和 `/goal`                              | 保持 FIFO；kind 分别是 `text` / `goal`                                                                                                                                         | covered | `conversation-session-goal-queue.test.ts`          |
| G1-03 | running 中输入 `/compact`                                 | 作为 `kind=compact` 入队，不触发并行 compact 请求、不产生 user row                                                                                                              | planned | 待补 compact queue accepted case                    |
| G1-04 | queue 中 goal 可编辑                                      | 只更新该 queue item，kind 仍是 `goal`，不触发请求                                                                                                                              | covered | `conversation-session-goal-queue.test.ts`          |
| G1-05 | queue 中 goal 可删除                                      | 只删除目标 queue item，不触发请求                                                                                                                                              | covered | `conversation-session-goal-queue.test.ts`          |
| G1-06 | queue 中 goal 可调整位置                                  | 只改变 queue 顺序，不触发请求                                                                                                                                                  | covered | `conversation-session-goal-queue.test.ts`          |
| G1-07 | “立即引导”遇到 goal                                       | running 中点击 queued goal 的立即引导时，动作自身负责 stop 当前会话并按 goal 请求执行；连续 queued goal 覆盖目标不并入 GQ gate                                                 | covered | `conversation-session-running-send-now.test.ts` |
| G1-08 | goal 入队后切换模型                                       | 消费时使用当前 session 最新模型和思考深度                                                                                                                                      | covered | `conversation-session-goal-session-model.test.ts`  |
| G1-09 | queue 混合 `/compact`、普通文本、`/goal`                  | 三种 kind 按 CLI admission 严格 FIFO；消费时 text/goal/compact 各走原始语义，compact 不生成 user row                                                                            | planned | 需要补 UI + protocol kind/FIFO 断言                 |
| G1-10 | active goal 未达标时 queue 等待 target complete          | 单次 `goal_verification completed`、`task_complete` 或 `setAutoDrain(true)` 不能触发 queue 消费；target 仍 active/paused/budget_limited 时 text/goal/compact 全部保留；显式 pass 与 fail-open 都先写 `passed=true` 并更新 target `complete`，之后才按 FIFO 消费；手动终止 verifier 是 cancelled/paused，不算 pass | partial | BG34 已覆盖 background notification verifier 的 explicit-pass + text queue 代表；fail-open、未达标保持与 cancel 仍待专项 case |
| G1-11 | 普通 queue + active goal 输出中点击 queue item 立即执行   | 等价 Stop：终止 active target 自动续跑和当前 assistant 输出；被点 item 成为下一轮 active input，其余 queue 保持相对顺序                                                        | covered | `conversation-session-goal-run-cases.test.ts`      |
| G1-12 | 普通 queue + goal verifier 进行中点击 queue item 立即执行 | 等价 Stop：终止当前 verifier 和后续 goal continuation；旧 target verifier 结果不得覆盖被点 queue item 或触发额外自动续跑                                                       | covered | `conversation-session-goal-run-cases.test.ts`      |
| G1-13 | guide 模式 + active goal output/continuation 中发送引导文本 | 等完整 tool result batch 后，按 turn-steering.md「Drain 边界」 取出等待的 guide，进入同一 turn 的 guided user message；不得 Stop、暂停或终止 active target；verifier request 本身不 steer，归 G1-14 fallback queue | covered | `conversation-session-running-guide-steer.test.ts` 覆盖 V4 Composer、完整 tool-batch 顺序与 active target 不被 stop |
| G1-14 | active goal verifier 中发送 guide/普通文本/`/goal`/`/compact` | guide 因 verifier busy 以同一 intent fallback queue，其余直接进入 future queue；都不打断 verifier；单次 verification terminal 不提前 drain，target complete 后才按原 kind/FIFO 消费 | partial | formal `conversation-session-running-guide-steer.test.ts` 已覆盖 guide fallback queue 与 target 不被 stop；BG34 覆盖普通文本代表，`/goal`、`/compact` 继续与 G1-10 共用 typed controlled-stream case |
| G1-15 | active goal verifier 中点击 Stop，随后发送普通文本 | Stop 按点击时的 `foregroundExecutionId` 取消同一 goal execution；verifier cancelled、target paused、queue `autoDrain=false`。旧 execution 已终止并切换到无关新 execution 时 noop；成功 Stop 后普通文本启动新的 provider request | partial | Runtime、V4 handler、projection/UI 自动回归已补；`conversation-session-goal-interruptions.test.ts` 仍在 manual-review/pending，隔离 replay 需在 Docker 环境恢复后补跑并人工 review |
| G1-16 | inactive task 有 active goal，经历普通 turn 终态、notSatisfied continuation，最终 explicit pass/fail-open；另取 Stop/cancel 与 error 代表 | 普通 turn、notSatisfied、continuation 和 Stop/cancel 都不产生完成未读；explicit pass/fail-open 在 target 投影为 `verified` 后仅产生一次 task/Dock 未读；error 仍作为失败提醒                                                                                                                                      | covered | 退役单测的独立断言待补；历史记录：`retired:packages/services/test/zcodeTaskIndexSyncer.test.ts`、`taskStatusUnreadSync.test.ts`；复用 G1-10 对 explicit pass/fail-open 的 target-complete 语义，不再与 queue kind 做全排列 |

## G2. Goal + Compact

| ID    | 场景                                        | 期望                                                 | 状态      | 自动化                                              |
| ----- | ------------------------------------------- | ---------------------------------------------------- | --------- | --------------------------------------------------- |
| G2-01 | manual compacting 中 `/goal`                | 入队，不触发额外模型请求                             | covered   | `conversation-session-compact-actions.test.ts`      |
| G2-02 | manual compact 被 stop 后 queued goal       | queue 保留且默认不自动消费                           | covered   | `conversation-session-compact-actions.test.ts`      |
| G2-03 | manual compact 失败后 queued goal           | 手动 compact 不重试；queued goal 怎么处理待定义      | undefined | F09                                                 |
| G2-04 | auto compact 前置于 queued goal 成功        | compact 成功后继续消费 queued goal                   | covered   | `conversation-session-compact-auto.test.ts`         |
| G2-05 | auto compact 前置于 queued goal 失败        | 失败后 goal 是否保留、是否继续消费待定义             | undefined | G11                                                 |
| G2-06 | auto compact 重试 3 次仍失败                | pending goal 处理待定义                              | undefined | G11                                                 |
| G2-07 | auto compacting 中用户再发 `/goal`          | `/goal` 入队，不抢占 compact                         | failing   | `conversation-session-compact-auto-actions.test.ts` |
| G2-08 | auto compacting 中重复 `/compact` + `/goal` | 重复 `/compact` reject；`/goal` 入队且不新增模型请求 | covered   | `conversation-session-compact-auto-actions.test.ts` |
| G2-09 | auto compact 被 stop 后 queued goal         | pendingAction/queued goal 处理待定义                 | undefined | G12                                                 |

## G3. Goal + Fork/Edit

| ID    | 场景                                                                        | 期望                                                                                                                                                          | 状态      | 自动化                                                                                      |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| G3-01 | goal continuation 或 goal verifier running 中 assistant fork                | 可 fork 更早 `completedSuccess` turn 的最后一段 completed assistant；当前未收口 turn 仍拒绝；child 不复制 active goal work/continuation inbox，父 target 继续 | missing   | 旧 `conversation-session-goal-session-model.test.ts` 的全局禁用断言已过时；待 `PV4-08/FX06` |
| G3-02 | goal continuation running 中最后一轮 user query edit                        | 允许；提交时先 stop 当前 goal active work，再从最后一轮 query 重跑，queue 原样保留                                                                            | planned   | 需要补 latest edit 专项覆盖                                                                 |
| G3-03 | goal completed 后 fork/compact/edit 恢复                                    | 按 completed 通用规则恢复                                                                                                                                     | partial   | 通用 `fork/edit/compact` 有覆盖，缺 goal completed 专项                                     |
| G3-04 | edit 旧 user query，已有 goal                                               | 是更新目标、保留旧目标，还是仅重跑内容待定义                                                                                                                  | undefined | 需要产品定义                                                                                |
| G3-05 | edit 旧 user query，没有 goal                                               | 是否相当于设置 goal 待定义                                                                                                                                    | undefined | 需要产品定义                                                                                |
| G3-06 | goal continuation running 中 user edit 入口                                 | 只在最后一轮 real user query 上显示 edit；历史 user query 不显示                                                                                              | planned   | 需要补 latest edit 专项覆盖                                                                 |
| G3-07 | 父 session fork 前已有 goal/target，父 queue 可非空                         | child 继承 fork 点之前的 goal target、iteration、verifier timeline；父 queue 保留；child queue 为空                                                           | covered   | `conversation-session-fork.test.ts`；对应 `FX03`                                            |
| G3-08 | Goal 父 session 创建 selection side chat，状态为 active、paused 或 complete | 三类状态均允许创建；child 保留 provider 正文，不复制 `goalBoundary`、target、verifier entries、queue 或 active work                                           | covered   | `session-fork.test.ts`；对应 `SSC23`，`budget_limited` 与 paused 按未完成 snapshot 剪枝     |

## G4. Goal + Session / Model

| ID    | 场景                               | 期望                                                                                                        | 状态    | 自动化                                              |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------- |
| G4-01 | A goal running，切到 B             | B 的主视图、target、queue 不串到 A                                                                          | covered | `conversation-session-goal-session-model.test.ts`   |
| G4-02 | A 有 queued goal，切到 B，再切回 A | A 的 target 和 queued goal 恢复                                                                             | covered | `conversation-session-goal-session-model.test.ts`   |
| G4-03 | 历史 session 有 goal               | 打开后目标状态跟随当前 session                                                                              | covered | `conversation-session-goal-session-model.test.ts`   |
| G4-04 | 新建 session                       | 不继承历史 session 的 goal/queue；模型和思考深度继承归 I03/`conversation-session-model-config.test.ts` 覆盖 | covered | `conversation-session-goal-session-model.test.ts`   |
| G4-05 | 右侧 sidebar 跟随当前 session goal | 不串 session                                                                                                | partial | 当前只断言 chat root/store，缺 sidebar 专用 test-id |

## G5. Goal 验证手段

| ID    | 证据层                                                             | 当前状态                                                                                  | 状态    |
| ----- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------- |
| G5-01 | UI `data-testid` / data attrs                                      | `chat-view` 有 `data-target-*`，queue item 有 `data-kind=goal`                            | partial |
| G5-02 | 专门 goal target/objective/status test-id                          | 还没有独立 test-id                                                                        | partial |
| G5-03 | 协议层 `/goal` 同时保留控制命令与 visible real-user query 双重语义 | command intent 持久化 canonical objective，message/part 与 live row 保留原始 display text | covered |
| G5-04 | 日志 goal set/update/queued/consumed                               | 尚未形成稳定日志断言                                                                      | partial |
| G5-05 | 文件/session snapshot 持久化                                       | session 切换有内存/恢复断言，缺文件级断言                                                 | partial |
| G5-06 | 网络区分 goal continuation / auto compact / 普通请求               | capture 可按 body 区分，尚无统一 request kind 字段                                        | partial |

## G6. Goal 环境异常

这些暂不写稳定 E2E，先进入环境故障 catalog 的产品决策队列。

| ID    | 场景                            | 状态      | 来源      |
| ----- | ------------------------------- | --------- | --------- |
| G6-01 | goal 请求 429                   | undefined | `N03`     |
| G6-02 | goal 请求 503                   | undefined | `N04`     |
| G6-03 | goal SSE 中断                   | undefined | `S02/S03` |
| G6-04 | goal 非流式/sidecar 请求失败    | undefined | `N09/C01` |
| G6-05 | 断网后 goal queue 保留          | undefined | `N06/L07` |
| G6-06 | app 关闭重开后 goal/queue 恢复  | undefined | `L02/L03` |
| G6-07 | 磁盘满导致 goal snapshot 写失败 | undefined | `D01`     |

## G7. Goal 恢复同步

| ID    | 场景                                                                                                          | 期望                                                                                                                                              | 状态    | 自动化                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| G7-01 | 恢复历史 task 时 agent `session_target` 已 paused/complete，但 app task meta 仍残留 active，且已有 queue item | 以恢复 snapshot/agent target 为权威绕过 stale active；点击“立即发送”后被点 queue item 直接发送，不继续 goal verifier                              | covered | `conversation-session-goal-resume-stale-target.test.ts`         |
| G7-02 | 首轮 `/goal` 已提交并持久化，随后重新订阅或冷恢复                                                             | live projection 与 cold hydration 都只显示一条原始 `/goal` real-user query；target objective 保持 canonical；continuation reminder 不产生用户气泡 | covered | bootstrap session persistence + transcript hydration regression |

剪枝：`/target`、大小写与 `replace` 只作为 display/canonical 解析等价类进入 command/parser 单测；queued goal 只选一个 FIFO 消费代表。desktop continuous 与 mobile replayable 不重复排列业务终态，后者通过同一持久 transcript 的 cold projection 等价性证明，不修改 shared-host attachment/relay 边界。
