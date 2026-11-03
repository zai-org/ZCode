# EnterPlanMode / ExitPlanMode

## 目标

提供 plan mode provider tools，让模型能主动请求进入计划模式、完成只读探索后向用户提交计划，并在用户批准后退出计划模式开始实现。

ZCode 第一版不引入 plan file、auto mode gate、teammate mailbox、专用 plan model 等当前运行时没有的一体化功能。计划正文通过 `ExitPlanMode.plan` 直接传入，后续如要引入 plan artifact/file，需要单独扩展本 spec。

## 工具

### EnterPlanMode

- 名称：`EnterPlanMode`
- 输入：空对象 `{}`
- 输出：`{ message, previousMode, mode: "plan" }`
- 能力：直接进入 plan mode，用于复杂实现任务开始前的探索和方案设计。
- 权限：`EnterPlanMode` 不弹用户审批，调用成功即切换到 plan mode。进入 plan 不放宽任何工具的权限：
  plan 只在原模式之上收紧，见 [Plan Mode Approval Boundary](../../../../../../docs/plan-mode-approval-boundary.md)。
- 副作用：`sideEffectScope: "session"`，不是 read-only。
- 并发：不安全，必须串行。mode 变更不能和其它 session mutation 并行。
- 失败：
  - 工具执行失败：返回 tool error，mode 不变。
  - runtime 未注入 session mode port：configuration error。

模型可见说明需覆盖：

- 非平凡实现任务应主动使用该工具，先拿到用户对方案方向的同意，避免直接写代码后返工。
- 除简单任务外，以下场景优先进入 plan mode：新功能实现、多种可行方案、修改既有行为或结构、架构决策、多文件变更、不明确需求、实现方式明显受用户偏好影响。
- 进入后只能用 `Glob`、`Grep`、`Read` 等只读工具探索，识别既有模式和架构，设计实现方案。
- 需要澄清方案时用 `AskUserQuestion`；计划审批必须用 `ExitPlanMode`。
- 单行/少量显然修复、明确的小函数、用户已经给出详细实现步骤、纯研究/探索任务不要滥用；纯研究/探索提示使用 `Agent`，不在该句绑定具体 agent type。
- 模型提示需包含正反例：认证、数据库优化、暗色模式、删除按钮、API 错误处理应进入 plan mode；README typo、简单 debug log、询问路由文件不应进入 plan mode。

### ExitPlanMode

- 名称：`ExitPlanMode`
- 输入：
  - `plan: string`：展示给用户审批的计划正文。
  - `allowedPrompts?: { tool: "Bash"; prompt: string }[]`：第一版仅保留到输入/输出和 UI/permission projection，不自动写 permission rules。
- 输出：`{ plan, previousMode, mode, approved: true, allowedPrompts? }`
- 能力：在 plan mode 下提交最终计划，并请求用户同意退出 plan mode。
- 权限：默认必须走用户审批。审批通过后恢复进入 plan mode 前的 mode；没有记录时恢复 `build`。如果进入前是 `yolo`（bypass permissions），`ExitPlanMode` 直接恢复 `yolo`，不再弹审批。
- 副作用：`sideEffectScope: "session"`，不是 read-only。
- 并发：不安全，必须串行。
- 失败：
  - 当前不是 plan mode：稳定失败，不弹无意义审批。
  - `plan` 为空：schema 校验失败。
  - 用户拒绝：返回 permission denied tool error，保持 plan mode。

模型可见说明需覆盖：

- 只在 plan mode 中、已经完成实现计划、准备交给用户审批时调用。
- 工具必须通过 `plan` 参数传入完整计划；模型不要假设存在 plan file，也不要只发空输入。
- `plan` 参数就是用户审批时看到的内容，必须完整、明确、可执行。
- 正常模式下调用本工具会请求用户审批；从 `yolo` 进入 plan 时，本工具直接退出回 `yolo`，不会请求审批。
- 只用于需要写代码的实现任务；纯研究、搜索文件、阅读文件、理解代码库时不要调用。
- 若需求或方案仍有未解问题，先用 `AskUserQuestion` 澄清。
- 不要用 `AskUserQuestion` 问“计划是否可以”或“是否继续”；审批就是本工具职责。
- 工具结果批准后，模型可以开始实现，并优先更新 todo（如果适用）。
- 模型提示需包含正反例：理解 vim mode 实现不应调用；实现 yank mode 应在规划完成后调用；认证功能若认证方式未定，应先 `AskUserQuestion`，再 `ExitPlanMode`。

### 审批后 plan file 连续性

当前过渡实现仍保留 `ExitPlanMode({ plan, allowedPrompts? })` 的 provider-visible 输入形态。审批通过后，runtime 会把最终批准的 plan 原始字符串写入 workspace root 下的 `.zcode/plans/plan-${sanitizedSessionId}.md`；写入失败不阻断已批准的退出 plan mode，只会让后续 compact continuity 降级为没有 plan file reference。

这个文件不是新的 provider-visible input，也不是完整的 plan-file schema；它只用于 compact/resume continuity。compact 成功时，如果该 plan file 存在且非空，runtime 会在 compact 后历史中持久化 `plan_file_reference` model-only reminder：

```text
A plan file exists from plan mode at: ${planFilePath}

Plan contents:

${planContent}

If this plan is relevant to the current work and not already complete, continue working on it.
```

这样即使 `ExitPlanMode` 后立即 compact，恢复后的下一轮 provider context 仍能拿到完整批准计划。

投影角色：`plan_file_reference` 和其他 compaction 附件一样参与冒泡，附件之间保持生成顺序（文件恢复之后、runtime_mode 之前）。支持 MCS 时它进入 user run 末尾的 mid-conversation system 消息，不留在 user 侧；不支持 MCS 时它是 user 侧 reminder。

当前过渡实现没有新增 plan file retention cleanup。如需按保留天数清理 plans 目录中过期的 `.md`，应作为独立 retention cleanup 改造接入，而不是在 compact/session 时即时删除。

## 规划提醒

主会话完整提醒使用五阶段流程；规划期间仍禁止写文件，不授予 plan file 编辑例外：

1. Initial Understanding：保留 Explore 探索指引，先查找可复用实现，最多并行三个探索任务。
2. Design：基于探索结果说明背景、文件路径、需求和约束，形成详细方案。当前没有专用 Plan
   agent 类型，因此由当前 agent 设计，不提示调用不存在的类型。
3. Review：回看探索中识别的关键文件，核对用户意图，并用 AskUserQuestion 澄清剩余问题。
4. Final Plan：准备作为 `ExitPlanMode.plan` 参数的完整正文。以 Context 说明动机、问题和预期
   结果；只给推荐方案；保持易读且可执行；列关键修改路径，重复模式只举代表路径；引用可复用
   的函数和工具及路径；包含端到端验证方法。模型不创建或编辑计划文件。
5. Call ExitPlanMode：使用 `plan` 参数提交完整正文；澄清走 AskUserQuestion，计划审批走
   ExitPlanMode，不用普通文本问题请求批准。

简短提醒对应五阶段；完整／简短提醒仍按现有五次用户输入间隔和每五次公告的周期切换。用户轮次按历史中的普通 user 消息计：真实的新 prompt、开启新一轮的后台通知与 agent 回复、中断标记、compact summary 都计入；轮内插入的中途消息（含人类 steer）不计入间隔（中途消息是 attachment，不是用户轮次）。
当前轮的 prompt 在模型回应它之前不计入：轮首请求前的收集不计它，该轮工具批次之后的收集才计入。
所以间隔满五次的那一轮，轮首请求不发提醒，第一个工具批次之后的请求才发；该轮只有文本回复时，
提醒在下一个 prompt 的轮首请求发出。
两种计数都只检查最近一次 `plan_mode_exit` 之后的历史。退出边界之前的用户输入和
规划提醒不参与新一段计划模式的计数；重新进入时立即发完整提醒，之后从该提醒重新
计算间隔与完整／简短周期。退出提醒的正文和权限行为保持不变。
完整、简短和退出提醒与其他动态公告一样按隐藏提醒持久化（不写顶层 source），
`runtimeMessage.source` 保留 `runtime_mode` 或 `plan_mode_exit`。保存成功后才加入
请求历史并消费退出标记；冷恢复复用现有 hydration，保留原位置、正文和计数边界，
不因重启额外注入完整提醒。旧会话缺少这些历史记录时，沿用缺少提醒时的首次注入规则。
批准后的计划持久化和 compact/resume 连续性沿用上节合同。

子会话（Agent 工具派生、`taskType: "subagent_child"`）继承父会话的 Plan 状态时，只收到精简提醒：
声明 Plan 已开启、只能做只读操作、完整回答委派的查询；子会话可见 `AskUserQuestion` 时，再提示可以用它澄清。
精简提醒不含五阶段流程，也不要求以 `AskUserQuestion` 或 `ExitPlanMode` 结束本轮（子会话没有
`ExitPlanMode`，也不能再派生子 agent）。提醒间隔、持久化与恢复规则与主会话相同，不区分完整与简短；compact 后重发提醒时
同样按会话类型选择正文，子会话重发的仍是精简提醒。
修复原因：继承父会话 Plan 的子会话曾收到主会话的完整五阶段提醒，被要求再派生 Explore、只能以
`AskUserQuestion` 或 `ExitPlanMode` 收尾，而这些工具子会话都没有。

## Runtime 和事件

工具 handler 不直接 import bootstrap 或 UI 状态。core 通过 `SessionModePort` 注入 mode 操作：

- `getMode()`
- `getPrePlanMode()`
- `enterPlanMode({ toolCallId, traceContext })`
- `exitPlanMode({ toolCallId, traceContext })`

runtime 实现负责保存 `prePlanMode`、更新 `config.mode`、写入 `SessionModeChanged` event，并在退出后设置一次性 `plan_mode_exit` reminder。事件 reducer 必须用该事件更新 `SessionProjection.mode`，使 snapshot、resume、debug 和 ZCode app-server 看到同一事实。

## UI / ZCode app-server

- permission request 仍复用现有 `PermissionRequested` / `PermissionResolved` 协议。
- `ExitPlanMode` 的 `plan` 留在 tool input / result payload 中，现有 plan mode tool panel 可解析展示。
- desktop continuous 和 web remote replayable 都只消费 session event / snapshot；relay 与 main 不保存 plan mode 业务状态。

## 测试

- contracts：输入输出 schema 成功/失败，JSON Schema 投影。
- core：registry 暴露两个工具；metadata/permission 不伪装 read-only。
- permission：`EnterPlanMode` 直接 allow；`ExitPlanMode` 在非 yolo 进入的 plan mode 下请求审批，在从 yolo 进入的 plan mode 下直接 allow；两者都不会被 read-only 禁令误挡。
- permission：其他工具在 plan 下先过 Plan 闸门再按原模式判定，plan 不比原模式宽；
  需审批的只读工具交给原模式，非只读 MCP 在 build/edit 下单次询问且 allow 规则不能跳过。
  规则见 [Plan Mode Approval Boundary](../../../../../../docs/plan-mode-approval-boundary.md)。
- runtime：`EnterPlanMode` 调用成功后 mode=plan；`ExitPlanMode` 审批通过后恢复 previous mode；拒绝后 mode 不变。
- events：`SessionModeChanged` 能更新 projection，snapshot 使用 projection mode。
- reminder：退出后下一轮注入 `plan_mode_exit`，且只注入一次。
