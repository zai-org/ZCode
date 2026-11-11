# Conversation Session Tool Cross Product Matrix

目标：补齐 conversation-session 的 compact、fork、goal 在“含工具调用历史”下的覆盖。旧口径只用 `Read /tmp/zcode-e2e-readonly-tool.txt` 证明单一只读工具存在，无法代表文件编辑、命令、网络失败态、计划模式、用户问询、session-local 状态和失败态 tool block。

## 覆盖边界

强叉乘工具名以 `packages/shared/src/tool-identity.ts`、`apps/zcode-cli/packages/core/src/tool/handlers/index.ts` 和计划模式工具为边界。默认 active 工具要覆盖成功态；条件注册或当前未注册工具也要进入 UI 叉乘，但可以用快速失败态收束，不把工具业务成功率混进 conversation UI spec。没有暴露到本链路的工具不纳入本矩阵。

| 工具                 | 默认状态                     | E2E 输入策略                                                    | 结果形态                     | 清理要求                          |
| -------------------- | ---------------------------- | --------------------------------------------------------------- | ---------------------------- | --------------------------------- |
| `Read`               | active                       | 读取专用 fixture 文件                                           | success                      | 删除专用目录                      |
| `Write`              | active                       | 新建专用文件                                                    | success                      | 删除专用目录                      |
| `Edit`               | active                       | 用空 `old_string` 新建专用文件                                  | success                      | 删除专用目录                      |
| `Bash`               | active                       | `printf` 输出 marker                                            | success                      | 无文件写入                        |
| `Glob`               | active                       | 匹配专用目录下 fixture 文件                                     | success                      | 删除专用目录                      |
| `Grep`               | search-branch conditional    | direct 分支搜索专用 fixture；embedded search 分支用 registry miss 快速失败 | success / failed tool result | 删除专用目录                      |
| `WebFetch`           | active                       | 使用合法但非公开 loopback URL 触发受控快速失败；业务成功闭环由 `WF/O10` 覆盖 | failed tool result           | 无外部写入                        |
| `TodoRead`           | active                       | 读取当前 session todo                                           | success                      | session-local；goal 后用 renderer store 断言历史 toolCalls |
| `TodoWrite`          | active                       | 写入当前 session todo                                           | success                      | session-local                     |
| `GoalRead`           | 当前未注册                   | 空输入；若未来注册则读当前 session goal                         | failed tool result / success | session-local                     |
| `EnterPlanMode`      | active                       | 空输入进入 plan mode                                            | success                      | 后续动作和下一 case 前重设 `yolo` |
| `ExitPlanMode`       | active                       | 非 plan mode 下调用，验证快速失败 tool block                    | failed tool result           | 无                                |
| `AskUserQuestion`    | active                       | 单题双选项，测试自动选择第一项                                  | success                      | session-local                     |
| `SendMessage`        | conditional                  | 指向不存在的 `agent_*`，或未注册时快速失败                      | failed tool result           | session-local                     |
| `Agent`              | conditional/default subagent | 非法 `subagent_type`，避免真的派生子 agent                      | failed tool result           | 无                                |
| `Skill`              | active                       | 加载不存在 skill，验证快速失败 tool block                       | failed tool result           | 无                                |
| `Workflow`           | 当前未注册                   | 空输入，若未来注册也因缺少 script/name/resumeFromRunId 快速失败 | failed tool result           | 无                                |

快速失败态也纳入本矩阵，是因为本矩阵验证的是 conversation UI 对 tool block + 后续 compact/fork/goal 的稳定性，不验证外部网络、子 agent、skill registry 的业务成功率。工具自身成功语义应在对应 tool/service 测试中覆盖。

## 未注册工具终态闭合

工具是否出现在 provider schema 与执行时 registry 是两个时间点的事实。模型仍可能返回已被 capability
分支隐藏、配置热切换后失效或自行生成的工具名；registry miss 不能只返回 provider-visible error，必须同步
闭合 conversation projection。

```text
provider tool_use(id)
  -> projection tool row: inputStreaming
  -> executor registry lookup: missing
  -> ToolCallError(id)
  -> projection tool row: error
  -> TurnComplete(success)
  -> cold snapshot / replay profile: terminal
```

| Case ID | 代表状态 | 关键断言 | 覆盖层 |
| --- | --- | --- | --- |
| TLT-01 | `Grep` 在 embedded search 分支未注册 | handler 前失败仍发布同 `toolCallId` 的 `ToolCallError` | core executor focused test |
| TLT-02 | terminal 前仍有 `inputStreaming/pendingApproval/running` foreground tool，或父 turn 先于 background subagent child tool 结束 | `TurnComplete` 把遗漏的 foreground 行收口为 error/cancelled；显式 background child tool 不伪收口，并允许迟到 terminal 收口同一行 | bootstrap projection/profile test |
| TLT-03 | 单 turn 超过 60 行，cold tail 缺 `turnHeader` | terminal `session.phase` 压住行级 running fallback，不显示 ChatLoading | UI focused test + desktop cold snapshot E2E |

剪枝：desktop E2E 用 60 个 embedded-search `Grep` registry miss 加 1 个必定未注册的 Grep
sentinel 代表所有未注册工具，并用 61 个同类 call 稳定越过 60 行尾窗；`Workflow` 继续不进入正式
TX 工具集合。手机 replayable 只复用 TLT-02 的 profile convergence，不复制 GUI 或 relay 重连排列。

## 叉乘场景

| 场景                 | 初始动作                                                                        | 后续动作                                         | 关键断言                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `compact-after-tool` | 发送带工具 marker 的 prompt，replay 返回指定 tool_use，再返回 `upstream-e2e-ok` | `/compact`                                       | 原 tool block 存在；compact marker `started` -> `completed`；compact 请求包含 tool marker                      |
| `fork-after-tool`    | 同上                                                                            | fork 包含 `upstream-e2e-ok` 的 assistant message | 新 task/session id 不同；派生会话保留原 user prompt、assistant token 和对应 tool block                         |
| `goal-after-tool`    | 同上                                                                            | `/goal E2E_TOOL_CROSS_PRODUCT_GOAL_*`            | target objective 更新；原工具历史仍存在；不会把 `/goal` 当普通可见 user message 泄漏内部 goal continuation；`EnterPlanMode` 保留计划态语义，只断言 target 更新，不要求 provider continuation；`TodoRead` 空结果可只保留为 renderer store toolCalls |

## Guide × Tool Result Batch 覆盖

guide 的消费 guard 依赖“一次 model step 的完整 tool result batch 是否已提交”，不依赖具体
tool 名。因此不把上表每个工具与 guide 做全排列；用成功单工具、成功 parallel batch、失败 tool
result 三个等价类证明共同不变量。

```text
tool calls emitted: T1, T2, ... Tn
  -> commit result(T1)
  -> ...
  -> commit result(Tn), success or failure
  -> batch terminal
  -> drain waiting guides (turn-steering.md「Drain 边界」)
  -> next provider request in the same product turn
```

| Case ID | Tool shape | Guide timing | 关键断言 | 状态 |
| --- | --- | --- | --- | --- |
| GTB-01 | single readonly `Read` success | tool call 前已 admission | `ToolCallResult` 先于 `TurnSteerDrained`，drain 后才发下一 provider request | pending：GS/P06 controlled-stream |
| GTB-02 | two parallel readonly tool calls | 两个 sibling 执行期间已有 guide | 单个 sibling 完成不 drain；全部 results 提交后按 admission FIFO 一次取出全部已等待的 guide | missing |
| GTB-03 | deterministic failed tool result | tool call 前或执行中已有 guide | failed result 仍是 batch terminal 的组成部分；失败事实先提交，再 drain 已等待的 guide | missing |
| GTB-04 | text-only model step，no tool | guide 已 admission | text-only assistant 先提交；随后按 admission FIFO 一次取出全部已等待的 guide，逐条以 user role 追加并在同一 active turn 发起下一 provider request | core covered；desktop pending：GS/P06 |
| GTB-05 | two guides + two tool batches | 两条 guide 均在第一个 batch terminal 前 admission | 第一个 batch 后按 admission FIFO 一次取出两条，成为相邻 guided row 并共用首条开启的工作段；第二个 batch 没有残留 guide | missing |

剪枝：`Write/Edit/Bash/WebFetch/AskUserQuestion/Agent` 等具体工具继续由本矩阵原有
compact/fork/goal 叉乘证明 tool block 稳定性；guide 只增加 batch-ordering invariant。interaction
tool 的用户等待态不单独排列，直到它形成 tool result 才进入相同 batch terminal。desktop
continuous 用 controlled-stream E2E 证明时序，mobile replayable 用同一 CLI facts 的 cold/live
projection 等价测试代表，不复制工具业务矩阵。

## Replay 约束

`provider-conversation-tool-cross-product.json` 使用 `response.toolUse` 和 `response.text` 简写生成 Anthropic SSE。首段 fixture 匹配 latest user message 中的 `E2E_TOOL_CROSS_PRODUCT_<TOOL>`；第二段通用 final fixture 匹配 `E2E_TOOL_CROSS_PRODUCT` + `toolu_e2e_tool_cross_product`，并排除 compact/title/goal continuation。这样不会被系统提示词里的 `tool_result` 文案误伤，每个工具名也能重复用于 compact、fork、goal 三个场景，不依赖 `maxMatches` 次数。

## 清理约束

所有文件系统副作用必须落在：

```text
/tmp/zcode-e2e-tool-cross-product
```

测试在每个工具 turn 前创建 fixture，`afterEach` 和 `after` 都执行 recursive cleanup。任何新增写文件工具或 shell 写入 case，都必须先进入这个目录，再补矩阵里的清理说明。
