# Plan Mode Approval Boundary

## 背景

Plan mode 的 `ExitPlanMode` 是计划审阅边界：模型提交计划后，必须等待用户明确批准，才能退出 `plan` 并继续实施。

## 语义

- `EnterPlanMode` 可以无确认进入只读计划态。
- `ExitPlanMode` 在 `plan` 模式下始终需要用户确认，包括从 `yolo` 进入 plan 的场景。
- 用户批准 `ExitPlanMode` 后，runtime 才恢复到进入 plan 前的模式，并允许后续编辑。
- 用户拒绝 `ExitPlanMode` 且没有填写修改意见时，当前 turn 必须结束，session 保持 `plan` 模式，等待用户继续输入修改意见。
- 用户在 `ExitPlanMode` 审批里填写修改意见时，runtime 保持 `plan` 模式，并把反馈持久化为一条真实、普通的 `user` message；`ExitPlanMode` 的工具结果只返回一条桥接说明，告诉模型用户反馈会跟随在下一条用户消息中。这样 UI / resume / provider-visible history 都把这段反馈当成用户新 query，而不是吞进工具结果，也不是展示成 turn steer 引导消息。

## 工具权限：Plan 闸门加原模式

Plan 只在进入前的模式（下称原模式）之上收紧，不新增放行。判定顺序：

```text
Plan 切换工具（EnterPlanMode / ExitPlanMode）   （各自的既有规则）
  → 需要用户交互的工具（AskUserQuestion 等）    → 询问
  → guarded 危险命令单次确认（未开 Plan 时）
  → alwaysAsk 工具                              → 询问；会话内授权、本会话发起的 workflow 修订放行
  → disallowedTools / 项目 deny / 项目 ask       （顺序不变，优先于 Plan）
  → ReplyToChannel 预批                         （只匹配原会话回复）
  → Plan 闸门
      只读、非 destructive、免审批              → 放行（原模式同样放行）
      声明 allowedInPlanMode 的会话控制工具     → 放行（不变）
      只读但需审批（WebFetch、readOnlyHint MCP）→ 不拦，交给原模式
      非只读、非 destructive 的 MCP
          原模式 yolo / guarded                 → 不拦，交给原模式
          其他原模式                            → 询问，单次确认
      其他非只读工具、destructive MCP           → 拒绝 mode.plan.nonReadOnly
  → guarded 的危险命令单次确认                  （闸门没拒绝且命中危险命令规则时，与单独 guarded 一致）
  → 原模式判定（yolo/guarded 放行；build/edit 走 allow 规则、预批 URL、模式默认策略）
```

- 开启 Plan 时，guarded 的危险命令单次确认排在 Plan 闸门之后：审批不能解除 Plan 的拒绝，闸门放过的
  工具命中危险命令规则时仍要单次确认。当前危险命令规则只匹配 Bash 写命令，它们会先被闸门拒绝。
- 排在 Plan 闸门之前的分支不受 Plan 约束：alwaysAsk 工具的会话内授权，以及项目 ask 规则的询问
  （同意或 PreToolUse Hook 放行后即执行）。因此 guarded + Plan 下，命中项目 ask 规则的危险命令
  走普通询问而不是单次确认。这两处是既有顺序，未在本次调整。
- 旧会话的 `mode=plan` 没有记录原模式，原模式按 build 判定。
- MCP 身份由工具权限声明 `permission.permission === "mcp"` 识别，不靠 `mcp__` 名称前缀推断。
- `readOnlyHint` 由 MCP server 自报，只用于让工具通过 Plan 闸门，不能直接放行；
  build/edit 下仍按 MCP 默认策略询问，除非命中 allow 规则。
- 非只读 MCP 在 Plan 下的询问排在 allow 规则之前：项目 allow 规则与 `allowedTools`
  不能跳过它。询问只提供单次允许与拒绝，不提供"始终允许"和"完全访问"：
  在 Plan 下记住的规则不会生效，提供这些选项会让用户以为已经授权。
  PreToolUse 与 PermissionRequest Hook 仍可按既有规则应答这次询问。
- 显式 `destructiveHint: true` 的 MCP 与其他非只读工具在 Plan 下拒绝，原模式为 yolo 也一样。
- 不改变 MCP 工具注册、模型可见 schema、输出预算、timeout、取消、日志或 UI 权限展示协议。

### 修复原因（2026-10-31）

原实现在 Plan 下用一套独立判定替换原模式：只读工具与非 destructive MCP 直接放行，不看
`needsApproval`。因此 Plan 反而比 build 宽：任意 URL 的 WebFetch、未声明 annotations 的
MCP 写工具、宿主 `node_repl` 的 `js`（可执行本机 Node 代码）在 build 下需要审批，在 Plan
下直接执行。`EnterPlanMode` 无需确认，模型被提示注入后可以先进入 Plan 再调用这些工具。
现在 Plan 闸门只负责拦截，放行只来自原模式；非只读工具与 destructive MCP 仍直接拒绝。

## 交互实现

`ExitPlanMode` 仍然是模型调用的工具，runtime 仍然通过 permission broker 创建审批边界。为了让用户在审批弹窗里直接输入修改意见，`ExitPlanMode` 的 broker 实现复用 `AskUserQuestion` 的 `interaction/requestUserInput` 通道，而不是展示普通 `interaction/requestPermission`。

- `approve` 映射为 permission `allow`。
- 关闭弹窗映射为 permission `deny`，且不携带反馈，保持停止当前 turn 的旧行为。
- 自定义输入映射为 permission `deny + reason`，并带上 `reasonSource: "plan_approval_feedback"`，用于表达“需要修改计划”；runtime 只能依赖这个显式 source 解释为“用户要求修改计划”，不能把 hook、project rule、broker 里其他 `deny + reason` 当成反馈。
- runtime 收到 `reasonSource: "plan_approval_feedback"` 后，先为 `ExitPlanMode` 注入 tool result 以闭合 provider 的 tool-use 协议，再通过带 `source: "plan_approval_feedback"` 的 active-turn pending input 路径把自定义输入写入真实用户消息历史。这个顺序保证 provider-visible history 是 `assistant tool_use` → `tool_result` → `user feedback`，同时复用 `persistUserPrompt`，让下次 resume 能看到这条反馈。UI 把缺省来源的 active-turn steer 渲染成 guided/steer 消息，计划审批反馈必须渲染为普通用户气泡。
- 普通 `AskUserQuestion` 不套用这条规则：它的回答仍然是工具调用结果，只有 `ExitPlanMode` 审批反馈会升级成新的用户消息。
- 投影层把 `ExitPlanMode` 的 pending permission 映射为 pending elicitation，并过滤对应的 `permission.requested` 实时事件，避免 UI 同时出现普通权限弹窗和可输入弹窗。

## 修复原因

之前拒绝 `ExitPlanMode` 会被包装成普通工具失败并继续喂给模型。模型收到失败结果后可能在同一 turn 内自行重新思考、重新提交另一版计划，用户还没输入修改意见就看到新的确认弹窗。现在无反馈的 `ExitPlanMode` 拒绝结果会携带 turn control，runtime 提交拒绝记录后立即停止本轮，避免计划审阅阶段自循环。

带反馈的拒绝不能停止本轮，但也不能把用户原话藏在 tool result 里。原因是这段内容来自用户主动输入，语义上等同下一条 query；如果只写入 tool result，UI 不会出现用户气泡，session resume 也无法按真实用户消息恢复审阅轨迹。因此这条路径必须复用真实用户消息持久化链路。
