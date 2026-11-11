# Subagent RespondToCoordinator

## Goal

普通 subagent 收到 main 通过 `SendMessage` 发来的 coordinator 消息后，可以通过
`RespondToCoordinator` 把回复投递给父 runtime，同时继续原任务。

## Product Contract

- `SendMessage` 保持 main-only。
- `RespondToCoordinator` 保持 child-only，provider input 只有 `summary` 和 `message`。
- child session、agent identity 和 parent route 由 runtime closure 绑定，模型不能选择或覆盖目标。
- 工具只在 `taskType === "subagent_child"`、coordinator port 已配置且未被全局
  `toolDisallowlist` 禁用时注册；使用指导只随实际工具 description 出现。
- 成功只表示 response command 已同步进入 parent runtime command queue，不表示 parent model
  已读取、接受或回复。
- parent active 时，首次 model step 不读取 runtime command；只有当前 turn 进入后续 model step 时，
  active-loop 才会在 compact 和 request prepare 前读取一次 `priority <= next` 的 command snapshot，
  将 snapshot 内的 `task-notification` / `subagent-message` 与当前 tool result 合流。
- active-loop 不在 compact、MCP 初始化或 provider request 前再次扫描 queue，也不持续消费 snapshot
  处理期间新入队的 command。错过本次 snapshot 的回复留给后续 model step；若当前 turn 结束，则由
  outer runtime command queue 串行启动 model-only turn。
- 普通 `prompt` 和 target continuation 不由 active-loop snapshot 消费，继续留在 outer queue。
- parent provider-visible carrier 是 user-like `<subagent-message>`，持久化 source 为
  `subagent_message`、visibility 为 `model-only`。
- synthetic carrier 不显示为顶层 user message，不参与 session title，也不进入
  `ReadSession` 的读取结果。child tool lifecycle mirror 仍可供兼容消费者和诊断使用，但父 V4
  ProductProjection 不把普通 child tool mirror 物化成 `ToolCallRow`；专属
  `RespondToCoordinator` 卡片只在 child session conversation 中展示，父会话继续只显示
  Agent/Task 摘要。
- child final assistant text 仍表示任务最终结果；`RespondToCoordinator` 不结束任务。

## Persistence And Visibility

- response command 被 parent runtime drain 时，完整 `<subagent-message>` carrier 才写入 parent
  model history 和 session store，其中包含经过 schema 校验、XML 转义但不做额外语义截断的
  `summary` 和 `message`。这样 active/idle 投递、session hydrate 和 parent resume 使用同一份模型
  上下文；enqueue success 本身仍不代表已经持久化。
- 这里的 synthetic user message source `subagent_message` 与
  `SessionEventType.SubagentMessage` lifecycle/progress event 是两套结构。后者只用于进度摘要；前者是
  coordinator response 的完整 model input，不能依据历史 progress-event 约束截断成摘要。
- `model-only` 是展示和上下文投影边界，不是“不落盘”标记。用户可见消息 projection、session
  title 和 `ReadSession` 必须过滤该 carrier；读取原始 parent session store 的导出、诊断、
  隐私审查和存储预算必须按可能包含完整回复处理。
- compact 前，该 carrier 可以进入 parent provider history；compact 后不要求把 model-only 原消息
  原样保留在 compact tail，但其语义可能进入 compact summary。UI 隐藏不能被解释为数据已经删除。
- child 的普通 tool/model/turn transcript 仍只保存在 child session；本通道只持久化 child 通过
  `RespondToCoordinator` 明确发送的单条回复，不复制 child 全量 transcript。

## Scheduling

`RespondToCoordinator` 使用 `concurrentSafe: true`。它可以和 `Read`、`Glob`、`Grep` 等
concurrent-safe 工具进入同一 parallel group；`Bash`、`Write`、`Edit` 继续遵循现有 scheduler
安全规则。模型应优先发出回复调用，并在同一 assistant step 中继续发出下一项工作工具调用。

child 当前正在执行的 tool batch 不会被 coordinator input 中断；steer drain 会在 batch
结束后、下一次 child provider request 前追加 `Message from coordinator:` input。若 coordinator
input 到达时 child 的当前 model step 正常 text-only 收口，则先持久化该 assistant，再以
`user` role 追加 coordinator input，并沿同一 active turn 续发下一次 provider request；只有
stop/cancel/interrupted 等无法继续当前 turn 的终态，或既有 FIFO barrier 阻止安全 inline
时，才回退普通 future queue。

## Permission

- 工具保持 `readOnly: false`、`destructive: false`、`sideEffectScope: "session"`。
- Plan mode 通过显式 `allowedInPlanMode` capability 允许该非破坏、无需审批的 session-local
  control action。
- 全局 disallow、project deny 和 project ask 继续先于 Plan-mode capability 生效。
- 不得把 session mutation 伪装成 read-only。

## Result Semantics

- success result 使用 queued 文案，并提醒 child 继续当前任务，除非 coordinator 明确修改或结束目标。
- 同步 enqueue 失败返回 failed result；失败文案同样提醒 child 继续当前任务。
- coordinator port 缺失时工具不注册；异常强制调用返回 configuration error。
- response command 和随后发生的 Agent completion notification 都使用 `priority: "next"`。
  两者可以出现在同一 provider request 或相邻 request，但 response 的首次 provider-visible
  位置必须早于 completion notification。

## Failure Semantics

- command enqueue 是唯一同步 acknowledgement 边界。
- child 专属卡片的摘要正文只展示 input `summary` 和失败状态，不复制 `message`、`responseId`、
  `error` 或原始 result；真实 tool execution failure 的错误原因只通过 `ToolLayout` 通用失败状态
  tooltip 在 hover/copy 时展示，业务 `status: "failed"` 不凭空生成错误详情或展开区。
- parent persistence、provider request 或 process 在 enqueue 后失败，不会反向修改已完成的 child
  tool result。
- active-loop snapshot 是一次 best-effort 的 turn 边界，不是 provider request 的投递屏障；snapshot
  后到达的 `subagent-message` 不保证进入当前请求，允许由后续 active request 或 outer queue 消费。
- P0 不提供 durable retry、inbox/outbox、read receipt 或 process restart recovery。
- 单个长时间工具尚未返回时，child model 没有控制权，不能即时调用回复工具。

## Out Of Scope

- 完整 Agent Teams、teammate mailbox、team roster 或 sibling routing。
- child 侧完整 `SendMessage`。
- `replyTo`、消息已读回执或 durable mailbox。
- 中断正在执行的单个工具。
- 修改 scheduler 使 unsafe 工具与回复工具强制并行。
- 恢复或新增 parent Agent card 内的普通 child tool row。
- 新增 app-to-agent RPC，或修改 desktop/mobile runtime ownership、workspace identity、remote
  session routing 和 client command queue。

## Verification

- contracts：strict input/output schema、20,000 字符上限和 routing field rejection。
- core：child-only tool surface、Plan-mode permission、active/idle/terminal-race command intake、
  max model concurrency 1、FIFO ordering、enqueue failure continuation 和 hydrate parity。
- shared：protocol source、model-only visibility、source-only fallback 和 title filtering。
- session context：`subagent_message` 不进入 local relevant snippets。
- E2E `BG25`：`SendMessage -> RespondToCoordinator + continued work -> parent model-only wake ->
child completion`，同时验证 child conversation 可观测性、父会话不物化普通 child tool row
  和无顶层 synthetic user bubble。
- E2E `O19`：真实 schema validation error 下，已覆盖 child 卡片正文只展示 input `summary`
  和“回复失败”、不展示 provider wrapper 或原始错误正文，且卡片不可展开。hover 失败状态后
  通用 tooltip 展示对应 `context.errorText` 的 WDIO 断言尚未补齐，当前覆盖状态保持
  `partial`。
