# Permission Broker 设计 v2

## 背景

早期权限层已经能把一次 tool 调用判定为 `allow`、`ask` 或 `deny`，但 `ask` 只能产出 `permission_requested` 事件，随后把 tool 视为被拒绝。当前核对确认该缺口已经落地：core 会把 `ask` 交给 `PermissionBrokerPort` 等待客户端选择，并根据 `allow`、`modify`、`deny`、`escalate` 继续或终止 tool 执行。

权限记忆第一版只支持 project 级规则。用户侧只暴露：

- `Allow once`：本次 tool 调用通过，不写入规则。
- `Always allow in this project`：写入当前 project 的 permission ruleset，后续同 project 命中规则时直接通过。
- `Deny`：本次拒绝，不写入规则。

第一版不做 session 级和 global 级持久化，也不在审批 UI 中展示 scope 列表。后续如果要支持 user/global settings，可以在不改变 `Allow once` 语义的前提下扩展新的 destination。

v2 将 `PermissionService` 和 `PermissionBroker` 明确拆开：

- `PermissionService` 只做同步策略判断：基于 mode、tool capability、allow/deny 规则、风险级别和副作用范围返回 `allow`、`ask`、`deny`。
- `PermissionBroker` 只处理异步客户端协商：把 `ask` 请求发布给客户端，等待 `allow`、`deny` 或 `modify`，并支持取消、超时和可观测事件。
- `edit` permission mode 是 `build` 的窄自动化变体：project deny/ask、project allow 和 allowedTools 仍按既有优先级处理；如果 tool capability 声明 `permission: "edit"` 且副作用范围是 `workspace`，同步判定直接 `allow`；其它操作回落到 `build` 策略。

## 当前实现核对

本轮核对时间：2026-05-08。以下主线已经实现，不应再按“待实现 broker”重复建设：

- Contract：`packages/contracts/src/interfaces/permission.port.ts` 定义 `PermissionBrokerPort`、`PermissionBrokerRequest`、`PermissionBrokerResult`、project 级 `PermissionUpdate` 和 `PermissionRuleset`。
- Core service：`packages/core/src/permission/service.ts` 负责同步 `allow` / `ask` / `deny` 判断，并支持 project `allow` / `ask` / `deny` 规则匹配。
- Core broker：`packages/core/src/permission/broker.ts` 提供默认 fail-closed `DenyPermissionBroker` 和可检查、可手动 resolve 的 `ManualPermissionBroker`，覆盖 pending、timeout、abort cleanup。
- Tool executor：`packages/core/src/tool/executor.ts` 在 `ask` 时发布 `permission_requested`，等待 broker 或 `PermissionRequest` hook，发布 `permission_resolved`，支持 `allow` 执行、`modify` 替换完整 input、`deny` 结构化失败、`escalate` 失败，以及 `permissionUpdates` 写入 project permission ruleset。
- Runtime/TUI：`packages/core/src/runtime/agent-runtime.ts` 把 broker 注入 executor；`packages/tui/src/app-permission.ts` 使用队列式 approval UI，支持 `Allow once`、`Always allow in this project`、`Deny`，并为 `AskUserQuestion` 复用同一 broker 通道展示澄清问题。TUI 在挂载时经 `registerPermissionRequester` 把审批入口登记到 `packages/cli/src/tui-prompt-handler.ts` 的 broker，卸载时注销；入口不随单次提交切换，所以忙时输入、resume 后 continuation、排队输入、通知驱动的回合和后台会话（`CreateSession` / `ForkSession` 建的根复用同一个 broker，见 [会话工具设计 0.5](../../../../../docs/architecture/zcode-app-control-design.md)）都能到达同一个审批队列。未登记时 fail closed。
- TUI 渲染：普通 approval prompt 优先展示 tool input 中的 `description` 作为用户可读说明；命令类 input 预览只展示 `command` 值，不展示完整 JSON，也不在面板中展示 risk/mode 策略元数据。说明和命令预览必须按当前面板宽度 word wrap，并按渲染行数扩展面板高度，避免窄终端中权限文本覆盖决策选项或帮助行。
- ZCode app-server：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` 注入 ZCode app-server broker，普通 tool 通过 ZCode app-server `requestPermission` 转成 `Allow once`、`Always allow in this project` 或 `Deny`；project allow 会返回 `permissionUpdates` 交给 core 写入当前 project ruleset；`AskUserQuestion` 当前走 `zcode.dev` elicitation 扩展请求。

已有测试覆盖：

- `packages/core/tests/permission-broker.test.ts`：pending request、client resolution、timeout cleanup、abort cleanup。
- `packages/core/tests/permission-service.test.ts`：build/plan/yolo 模式、project rules、user-interaction tool 的权限判断。
- `packages/core/tests/tool-executor-trace.test.ts`：默认无 broker fail closed、broker allow 后执行、project `permissionUpdates` 落盘并被后续调用命中、broker `modify` 替换输入、hook allow/deny。
- `packages/core/tests/runtime-tool-loop.test.ts`：runtime 等待 broker approval 后才执行 side-effecting tool，并保证 `permission_resolved` 早于 `tool_call_started`。
- `packages/cli/tests/cli.unit.test.ts`：登记后 TUI `submitPrompt`、`sendInput` 和回合之外的 approval request 都接入 runtime permission broker，未登记时 fail-closed。
- `packages/tui/tests/tui.unit.test.ts`：TUI approval UI、project allow update、Esc/关闭/取消等交互路径。

剩余边界：session/global 级 permission ruleset 仍不在第一版范围内；ZCode app-server 和 TUI 当前都只暴露 project 级 remember allow，不暴露 reject always；更细粒度的 Bash/WebFetch 规则建议仍应由后续 tool policy 提供。

## 运行时流程

Tool 执行前的权限流程：

1. `ToolExecutor` 调用 `PermissionService.checkPermission`。
2. 返回 `allow`：直接执行 tool。
3. 返回 `deny`：记录 `permission_denied`，tool 不执行。
4. 返回 `ask`：记录 `permission_requested`，随后 `PermissionBroker.requestPermission`
   与 `PermissionRequest` hooks 并发竞速，先到的决定生效（见
   `permission-responder-race.md`；broker 必须在 `requestPermission` 调用内同步建立
   应答通道，abort 时清理 pending 提示）。
5. 客户端返回：
   - `allow`：记录 `permission_resolved`，用原始输入执行 tool。
   - `modify`：记录 `permission_resolved`，用 `modifiedInput` 执行 tool。
   - `deny`：记录 `permission_resolved`，tool 不执行，返回结构化 `permission_denied` 错误。
6. 如果客户端返回 `permissionUpdates`，core 在执行 tool 前先写入 project permission ruleset，并更新当前权限判断上下文。

`ask` 不是错误态。只有客户端拒绝、请求超时、执行被取消或 broker 自身失败时，才转换成 tool error。

## Broker 契约

`PermissionBrokerPort` 属于客户端边界契约，输入必须包含可展示、可审计、可恢复的信息：

- `requestId`：本次权限请求 ID。
- `sessionId`、`turnId`、`traceId`、`toolCallId`：完整调用链标识。
- `toolName`、`input`：原始 tool 调用。
- `mode`、`ruleId`、`reason`：策略来源和用户可见原因。
- `riskLevel`、`sideEffectScope`：风险和副作用范围。
- `requestedAt`：进入 pending 状态的时间。

返回值：

- `decision`：`allow`、`deny`、`modify` 或保留的 `escalate`。
- `reason`：客户端可选说明。
- `modifiedInput`：仅 `modify` 有意义，必须作为完整替代输入，而不是 patch。
- `permissionUpdates`：可选 project 级规则更新。第一版只支持 `addRules`，用于表达“本项目以后允许/询问/拒绝这类调用”。
- `resolvedAt`：客户端响应时间；缺省时由 core 填充。

Broker 必须支持 `AbortSignal`。如果 turn 被取消，pending permission 也必须被清理，避免后台悬挂 promise。超时由调用方显式传入；没有配置超时时，broker 可以一直等待客户端。

## 事件与状态

事件语义：

- `permission_requested`：进入 broker 前记录，projection 将请求加入 `pendingPermissions`。
- `permission_resolved`：客户端对 `ask` 的最终回复，projection 移除 pending；`deny` 会把 tool 状态标为 denied。
- `permission_denied`：同步策略直接拒绝，或 broker 无法进入 pending 的不可恢复拒绝。

工具状态语义：

- `scheduled` -> `waiting_permission` -> `running` -> `completed`
- `scheduled` -> `waiting_permission` -> `permission_denied`
- 同步 `deny` 可以直接进入 `permission_denied`

## 默认行为

没有客户端 broker 时，默认 broker 必须 fail closed：立即返回 `deny`，理由说明没有配置可交互权限客户端。这保证 headless CLI、测试和后台任务不会无界等待。

客户端需要交互权限时，应显式注入 broker：

- TUI/IDE：展示请求，用户点击允许/拒绝后调用 resolver。
- SDK：把请求暴露成事件或 callback，由宿主进程回复。
- 自动化：可以实现 policy broker，根据外部规则自动 allow/deny，但仍要记录 `permission_resolved`。

## TUI 最小交互

TUI 作为第一版交互客户端时，只实现 `ask` 请求的最小可用 UI：

- runtime 仍通过 `PermissionBrokerPort.requestPermission` 等待结果，TUI 不直接执行 tool。
- TUI 展示审批框不依赖当前 turn 是否 busy，包含 `toolName`、`riskLevel`、`sideEffectScope`、`reason` 和截断后的 `input` 预览；请求的 `sessionId` 不是当前主会话时，在审批框上方标明来源后台会话。
- 键盘操作使用显式选择确认：审批框展示 `Allow once`、`Always allow in this project` 和 `Deny`。默认选中 `Deny`；`Up`/`Down` 在选项间移动，`Enter` 返回当前选项，`Escape` 返回 `deny`；`Ctrl-C` 继续取消当前 TUI 会话并通过 abort signal 清理 pending。
- `Always allow in this project` 只返回 project 级 `permissionUpdates`。第一版可以先生成 tool-only 规则；Bash/WebFetch 等更细粒度规则由 tool policy 后续提供建议。
- TUI 同一时间只展示队首审批请求；如果后续支持并发请求，应在 TUI 层排队，不改变 broker 契约。
- `--prompt`、后台任务和没有交互客户端的入口继续使用默认 deny broker，避免无界等待。

## 测试要求

新增或修改权限能力时至少覆盖：

- `ask` 后客户端 `allow`，tool 确实执行。
- `ask` 后客户端 `allow` 且携带 project `permissionUpdates`，规则写入 project ruleset，后续同 project 命中规则不再 ask。
- `edit` mode 下 `Write`、`Edit`、`ApplyPatch` 这类文件编辑工具直接 allow，而 Bash、MCP、用户交互、网络或系统级操作不因 `edit` mode 自动通过。
- `ask` 后客户端 `modify`，tool 收到替代输入。
- `ask` 后客户端 `deny`，tool 不执行，并移除 pending。
- 没有 broker 时默认拒绝，不悬挂。
- 取消或超时会清理 pending，并保留 traceId。

## Group session isolation (2026-09)

The project-only restriction above has one scoped extension: a trusted group input initializes `SessionInfo.permission.scope = "session"` before tools execute. Executor rule loading and remembered updates use that session's permission object, never `ProjectPermission`. Initialization drops inherited rules once; subsequent turns and cold resumes keep the task's own grants. Normal tasks without this marker retain project behavior. The marker is protocol metadata, not interpreted prompt text. See the root `docs/permission-project-approval.md` and `docs/bots-feishu-group-collaboration.md` for group authorization and client boundaries.
