# ZCode CLI Hooks 设计 v2

## 文档定位

本文是 hooks 能力的 v2 规划，成熟度为 `L3 Implementation Contract`。它定义事件、配置、运行时边界、权限交互、可观测性和测试要求，并与根目录
`docs/hooks-runtime-contract.md` 共同作为现有 7 个事件的验收依据。

Hooks 的目标不是把业务逻辑散落到用户脚本里，而是在 agent loop 的关键安全边界提供可审计、可取消、可测试的扩展点。ZCode 的核心原则仍然成立：core 只表达意图，不直接触碰文件系统、网络、子进程或环境变量；所有外部 I/O 通过 adapter/port 收敛。

## 设计取舍

采用：

- 配置来源分层（user/project/local/policy settings、plugin hook、session hook、builtin hook），启动时捕获 hooks config snapshot，避免会话中隐式修改配置导致行为漂移。
- 完整事件语义，包括 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`UserPromptSubmit`、`SessionStart`、`Stop`、`PreCompact`、`PostCompact` 等。
- matcher 是事件相关字段的正则。tool 类事件匹配 `tool_name`，session start 匹配 source，compact 匹配 trigger。
- 执行层支持 per-hook timeout、abort、进度事件、stdout/stderr 捕获、JSON 输出、exit code 2 阻断。
- 单条 Hook 的 `onError`（`allow` 缺省 / `deny`）：`PreToolUse` Hook 自身失败（其他非零退出、超时、已知字段类型错误）时，`deny` 按 exit code 2 拦截工具调用；契约见 `docs/hooks-runtime-contract.md`「stdout、退出码与事件效果」。
- 决策有聚合优先级：deny/block 优先，其次 ask，再其次 allow；hook 可以修改 tool input、补充上下文、替换部分工具输出。
- 独立 hook progress/response 事件、权限 request hook。
- 类型安全的 hook 名称、input/output 分离、顺序稳定、插件级能力聚合。
- 安全上要求 workspace trust、managed policy 开关、插件 root 隔离、hook 去重、Windows shell/path 处理。

不采用：

- 默认 shell 字符串命令、过多初版事件、hook 直接散布在 UI/AppState 层。
- hook 通过 mutable output 隐式改变状态；ZCode 需要事件化、schema 化，避免输出契约靠对象引用约定。

## 设计目标

1. 提供 NL->Code 主链路关键扩展点：用户输入、工具执行前后、权限请求、会话开始/结束、停止前、压缩前后。
2. 所有 hook 输入和输出都有 runtime schema，跨进程、配置、插件、SDK 边界时不只依赖 TypeScript 类型。
3. hook 执行必须携带并传播 `traceId`、`sessionId`、`turnId`、`toolCallId`。
4. hook 自身的副作用通过 `HookExecutionPort`、`HttpClient`、`ExecutionPort` 等 adapter 收敛。
5. hook 结果可以影响 agent 行为，但必须通过显式 `HookDecision`，不能直接修改 core 内部状态。
6. hook 进度、结果、失败和阻断都进入 session event stream，UI 只消费 projection。
7. 第一版避免新增 `ZCODE_` 环境变量。配置走 config file、CLI/session override 或 SDK 注入。

## 非目标

- 第一版不增加现有 7 个事件之外的新 Hook 事件。
- 第一版不实现 prompt hook、agent hook、file watcher hook、worktree hook。
- 第一版不实现 `if`、`once`、`asyncRewake`。
- 第一版不让 hook 绕过 plan mode、显式 deny rule、sandbox 或 tool contract。
- 第一版不把大体积 hook 输出直接注入模型上下文。

## P0 事件集合

| Event                | 触发点                                                            | 可阻断             | 可修改                            | 模型可见输出                                        |
| -------------------- | ----------------------------------------------------------------- | ------------------ | --------------------------------- | --------------------------------------------------- |
| `SessionStart`       | session 创建、resume、fork 后的首轮 prompt 前；每次 compaction 后 | 否                 | 可追加 session context            | 是，受预算限制                                      |
| `UserPromptSubmit`   | 用户输入进入 turn 前                                              | 是                 | 可追加 context，不改原始用户文本  | 是，受预算限制                                      |
| `PreToolUse`         | tool input schema 校验后、permission check 前                     | 是                 | 可替换完整 tool input             | 可追加 context，批次后附件                          |
| `PermissionRequest`  | permission service 返回 ask、broker UI 前                         | 是                 | 可允许、拒绝或替换完整 input      | 否，除拒绝原因                                      |
| `PostToolUse`        | tool 成功后、结果序列化给模型前                                   | 否                 | 可追加 context；P1 再支持替换输出 | 是，批次后附件；Hook stdin 获得完整 `tool_response` |
| `PostToolUseFailure` | tool 失败后、错误返回模型前                                       | 否                 | 可追加 recovery context           | 是，批次后附件                                      |
| `Stop`               | turn 即将 complete 前                                             | 是，可要求继续一轮 | 可追加 feedback context           | 是                                                  |

实现状态：

- contract/config schema/runner 只声明并支持：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`。
- 已接入 tool executor：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`。
- 本阶段补齐 runtime 主链路接入：`SessionStart`、`UserPromptSubmit`、`Stop`，并补齐 `PreToolUse.additionalContext` 的模型可见行为。

P1 再考虑：

- `PreCompact` / `PostCompact`
- `SubagentStart` / `SubagentStop`
- `ModelRequest` / `ModelResponse`
- `ConfigChange`
- `CommandExecuteBefore`

## Hook 配置草案

`RuntimeConfig` 增加 `hooks` 候选字段：

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash|Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["scripts/check-tool.mjs"],
              "enabled": true,
              "timeoutMs": 30000
            }
          ]
        }
      ]
    }
  }
}
```

配置原则：

- `events.<event>[]` 是 matcher 列表，顺序稳定。
- `matcher` 是正则字符串。tool 类事件匹配 tool name。
- P0 持久化配置支持 `process` 和 `command` 两类 hook；in-memory `callback` 只作为 core/SDK 注入能力，不写入配置。
- `process` 必须使用 `command + args[]`，通过 adapter 的 spawn/execFile 语义执行，不默认 shell 拼接。
- `command` 使用显式 shell execution mode，主要兼容 Claude Marketplace；Windows shell/path fallback 由 ExecutionPort 负责。
- 每个 hook 的 `enabled` 缺省为 `true`；`enabled:false` 必须在 Runner 注册前跳过。
- `command.async:true` 使用 fire-and-forget 语义，stdout 不能阻断、修改输入或注入上下文；后台完成/失败仍需记录 lifecycle event。
- process hook 输入通过 stdin JSON 传入，stdout 解析为 hook output，stderr 进入诊断和 hook result event。
- 配置合并沿用现有优先级：system < user < project < session < env < CLI。P0 不声明环境变量入口。

## Hook 输入契约

所有 hook input 都继承基础字段：

- `hookEventName`
- `sessionId`
- `turnId`
- `traceId`
- `cwd`
- `mode`
- `agentName`
- `timestamp`

事件专属字段：

- `PreToolUse`：`toolCallId`、`toolName`、`toolInput`、`riskLevel`、`sideEffectScope`
- `PermissionRequest`：`requestId`、`toolCallId`、`toolName`、`toolInput`、`reason`、`riskLevel`、`sideEffectScope`
- `PostToolUse`：`toolCallId`、`toolName`、`toolInput`、完整 `toolResponse`、`toolResultPreview`、`artifactRefs`
- `PostToolUseFailure`：`toolCallId`、`toolName`、`toolInput`、`error`、`isInterrupt`
- `UserPromptSubmit`：`prompt`、`attachmentsSummary`
- `SessionStart`：`source`
- `Stop`：`responsePreview`、`toolCallCount`

模型侧仍只接收受 result budget 约束的工具结果；Hook 兼容边界按 Claude Code 传递完整结构化
`tool_response`。`toolResultPreview` 和 artifact 引用作为 ZCode 扩展保留，不能替代
`tool_response`。

## Hook 输出契约

P0 使用一个统一 JSON 输出：

```json
{
  "continue": true,
  "reason": "optional human-readable reason",
  "suppressOutput": false,
  "systemMessage": "optional user-visible message",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {}
  }
}
```

事件专属输出：

- `PreToolUse`
  - `permissionDecision`: `allow | ask | deny`
  - `permissionDecisionReason`
  - `updatedInput`: 完整替代 input，必须重新经过 tool input schema 校验。
  - `additionalContext`
- `PermissionRequest`
  - `decision.behavior`: `allow | deny`
  - `decision.updatedInput`
  - `decision.permissionUpdates`
- `UserPromptSubmit`
  - `additionalContext`
  - `continue: false` 表示阻断本次 prompt。
- `SessionStart`
  - `additionalContext`
- `PostToolUse` / `PostToolUseFailure`
  - `additionalContext`
- `Stop`
  - `continue: false` 或未返回输出表示 turn 可以结束。
  - `continue: true` 且带 `additionalContext` 表示把反馈注入下一轮模型请求。
  - `continue: true` 但没有 `additionalContext` 视为 no-op，避免空循环。

非 JSON stdout 在 P0 不进入模型上下文，只作为 hook diagnostic event 记录。未知 JSON 字段
忽略，不能导致整个 Hook 失败；已知字段类型错误仍归为单 Hook contract violation。

### 事件感知语义

`continue` 字段不能在所有事件中解释成同一个动作：

- `UserPromptSubmit continue:false`：阻断当前 prompt，不写入用户消息、不发起模型请求，返回 hook reason。
- `PreToolUse continue:false`：阻断当前 tool，等价于 hook deny。
- `PermissionRequest continue:false`：拒绝当前权限请求，等价于 hook deny。
- `PostToolUse` / `PostToolUseFailure continue:false`：P0 不阻断已完成的 tool，只记录 hook blocked event 和 reason。
- `SessionStart continue:false`：P0 忽略阻断，只记录 blocked diagnostic；会话仍可继续。
- `Stop decision:"block"`：仅当存在 reason 或 `additionalContext` 时继续下一轮模型请求。
- 为兼容已有 ZCode 配置，`Stop continue:true` 且存在 `additionalContext` 也继续下一轮。

## 决策优先级

Tool 执行路径：

1. `ToolExecutor` 校验原始 input。
2. `HookRunner.run(PreToolUse)`。
3. 如果任何 hook 返回 deny，tool 不执行，记录 hook blocked 与 tool error。
4. 如果 hook 返回 updatedInput，使用完整替代 input，并重新校验 schema。
5. `PermissionService.checkPermission` 对有效 input 执行静态策略。
6. 显式 deny rule、plan mode 写入禁令、tool contract hard guard 不可被 hook allow 绕过。
7. 如果需要 ask，`PermissionRequest` hooks 与交互 broker **并发竞速**（详见
   `permission-responder-race.md`）：broker 的应答通道先建立，hook 链同时启动。
8. 先到的决定生效：hook allow/deny/modify 先到则收口并 abort broker 等待；用户经
   broker 应答先到则收口并 abort hook 链。hook 无决定或失败按退赛处理，只剩 broker
   单边等待。hook 决定不再保证先于用户应答；需要用户不可越过的强制拒绝用
   `PreToolUse` deny 或 permission deny rule 表达。
9. tool 成功后运行 `PostToolUse`，失败后运行 `PostToolUseFailure`。

聚合规则：

- deny/block > ask > allow > passthrough。
- 多个 `updatedInput` 时按执行顺序应用“最后一个有效完整替代 input”。如果后续校验失败，归因为 hook contract violation，tool 不执行。
- 工具 Hook 的多个 `additionalContext` 按 hook 顺序保留为多条，不拼接。生命周期 Hook（`SessionStart` / `UserPromptSubmit` / `Stop`）仍把多条合成一条 `hook_context`，每条带 `#n` 编号。
- 工具 Hook（`PreToolUse` / `PostToolUse` / `PostToolUseFailure`）的每条 context 写成
  `<Event>:<ToolName> hook additional context: <context>`，作为 `tool_hook_context` 附件排在这批
  tool result 之后、其他批次提示之前；按 tool result 顺序分组，同一工具 Pre 在前。tool_result 只放工具原文，
  Hook 文本不占 tool result 预算，也不进 `tool_call_result` 事件。PreToolUse 拒绝、Hook 改写后校验失败、
  权限拒绝等提前失败同样只带附件。附件随历史持久化，MCS 下与同批附件合成同一条 system。microcompact 只清 tool result，不清 `tool_hook_context` 附件。
- 工具 Hook 的每条 context 单独计长，上限 10000 字符；生命周期 Hook 不受此限。不超过上限时原样使用。
  超过时整条写入 session artifact，`<context>` 换成 `<persisted-output>` 外壳：原文大小、完整文件路径、
  前 2KB 预览（与 Bash 落盘结果同一格式）。写入失败或没有 artifact store 时保留前 10000 字符，后接
  `\n\n[Hook additionalContext truncated at 10000 chars — persist-to-disk failed: <原因>]`。官方 CUA 帧凭据过滤
  在落盘之前执行，被过滤的 context 不写文件。
- `Stop` 最多允许连续续跑 3 次；超过后强制结束并记录 hook diagnostic，避免 hook 配置导致无限循环。

## 运行时架构

模块边界：

- `packages/contracts/src/hooks/`
  - hook event enum
  - hook input/output JSON schema
  - hook config schema
  - hook result/error 类型
- `packages/core/src/hooks/`
  - `HookRunner`
  - `HookRegistry`
  - matcher resolver
  - decision aggregator
- `packages/adapters/src/hooks/`
  - `NodeProcessHookExecutionAdapter`
  - 后续 `HttpHookAdapter`
- `packages/bootstrap`
  - 从 config 装配 hook registry 和 adapter
  - 注入 `HookRunner` 到 `AgentRuntime`

核心边界：

- core 不直接 `spawn`、不直接读 config file、不直接读取 `process.env`。
- process hook 使用现有执行 adapter 或专用 `HookExecutionPort`，二者都必须支持 timeout、abort、output truncation、cwd、Windows executable resolution。
- hook runner 只返回结构化 `HookRunResult`，不直接写 UI。
- runtime lifecycle hooks 通过 `packages/core/src/runtime/methods/hooks.ts` 统一触发，避免把 hook 调用散落在 turn loop 各处。
- lifecycle hook 的 additional context 以 synthetic user/system reminder 注入 message history；原始用户文本不被 hook 修改。写库和位置见下节。

### 生命周期 Hook 上下文的持久化

`SessionStart`、`UserPromptSubmit`、`Stop` 的 additional context 是 `hook_context` 隐藏提醒。
它先写库，再进入 message history 和当轮请求。冷恢复按原位置回放，所以热态请求和冷恢复后的请求前缀相同。

| 来源                             | 何时运行                                                       | 何时写库                     | 位置                                                                                   |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `SessionStart` `startup`         | 首轮 context 初始化后                                          | 首轮会话写库后               | 首轮输入之前                                                                           |
| `SessionStart` `resume` / `fork` | `resumeFromStore` 时                                           | 下一轮会话写库后             | 下一轮输入之前；通知类轮次的输入在轮开始前已写库，这时排在该输入之后                   |
| `SessionStart` `compact`         | 每次 compaction 生成摘要之后、提交之前（手动、auto、reactive） | 与 compaction 产出同一次提交 | compaction 附件的最后一项（边界、摘要、保留尾部、附件之后）                            |
| `UserPromptSubmit`               | 用户输入写入前（可阻断）                                       | 本轮第一次输入附件收集       | prompt 之后，本轮输入附件之后、请求前公告（instructions / session_context / date）之前 |
| `Stop`                           | 准备结束前                                                     | 立即                         | 该次 assistant 之后                                                                    |

规则：

- `SessionStart` 的 startup / resume / fork 结果先放进 runtime 内存里的待写槽，不直接写库。原因：startup 时会话行还没创建；resume 只是打开会话，写库会让每次打开都多一行。
  下一轮在会话写库（`ensureSessionPersisted`）之后提交待写槽：先写库，再进入历史。
  只打开会话、不发消息时不写库。runtime 释放时，待写槽一起丢弃。
- 每个 runtime 只运行一次 `startup` / `resume` / `fork`，所以多次 resume 同一个 runtime 不会重复写入。
- 提交待写槽之前，先在当前历史里从后往前找最近一条 `SessionStart hook additional context: ` 开头的 `hook_context`。
  两份正文逐字相同就丢弃待写内容，不写库、不进历史；不同就照常提交。判断只依赖历史，不加新状态。
  - 原因：常驻池空闲 10 分钟就释放 runtime，每次重开并发消息都会运行一次 resume。输出不变的 hook 若每次都写，上下文会持续累积。
  - 比较放在提交时，不放在暂存时：重开和下一轮之间可能发生 rewind，切掉最近那一份；提交时的历史才是这一轮真正发给模型的历史。
  - 待写槽在提交前不在历史里，提交又在本轮请求之前，所以相同的内容不会进入任何请求。
  - 输出每次都不同的 hook（例如带时间、git 状态）仍会每次重开写一份，只靠去重，不做额外策略。
- 待写槽只保留最新一次非空结果。
- `fork`：子会话在 fork 提示之后还没有任何输入（prompt、通知等不是隐藏提醒的 user 行）时，每次打开都用 `fork`；有了第一条输入之后用 `resume`。由历史推出，不另存状态。
  从父会话复制来的 startup 上下文保留；`fork` 的正文与它相同时，按上面的规则不再写入。
- `compact`：
  - 不受每个 runtime 只运行一次的限制，每次 compaction 都运行。
  - 和其他来源一样先经过 workspace hook admission：每次都调用 `activate("compact")`，重新评估 Trust 状态，并上报一次 `WorkspaceHookAdmissionUpdated` 会话事件。
  - 摘要生成之后、提交之前运行。结果作为 compaction 附件的最后一项，与边界、摘要、附件同一次提交，并计入压缩后 token。
    不能在提交之后单独写入：那一步出错会把已提交的 compaction 当作失败，压缩后 token 也算不上它。
  - 一轮中间的 auto / reactive compaction 直接用压缩后的条目继续本轮请求，下一次请求就带上。
  - 同样去重：和压缩后保留部分里最近一份 SessionStart 上下文比较，相同就不写。压缩后的历史里，只有保留部分可能含 SessionStart 上下文。
    手动 compaction 不保留尾部，所以总是写入；只有 auto / reactive 可能因去重不写。
  - hook 有结果时（包括因去重而不写），compaction 提交成功后丢弃还没提交的 startup / resume 结果；没有结果时保留它们，下一轮照常提交。
  - hook 在提交前运行：提交失败时 hook 已经运行过；auto 重试会再运行一次。
  - hook 运行期间用户停止：按取消收尾，compaction 不提交。
    原因：hook runner 把取消当作单个 hook 失败，不抛错；hook 返回后要再检查一次取消，否则 compaction 照样提交。
- `UserPromptSubmit` 的上下文只在本轮第一次输入附件收集时写入，工具批次之后的收集不再写。
- `UserPromptSubmit` 的上下文在 prompt 之后，rewind / retry 切到这个 prompt 时会一起删掉。
  `SessionStart` 的上下文在 prompt 之前，会保留；同一 runtime 重跑时不再运行 SessionStart，所以不会重复。
- 新轮通知（task notification、subagent reply）的首个请求不收集输入附件，这类轮次也不运行 `UserPromptSubmit`。
- 升级前的会话：之前只在内存里的上下文无法找回。旧会话第一次冷恢复时前缀会变化一次，之后稳定。

已知限制：

- prompt 已写库、但这一轮在第一次输入附件收集之前结束（模型创建失败、中止）时，这一轮的 `UserPromptSubmit` 上下文不写入。retry 会重新运行 hook，不受影响。
- 一轮中间的 auto / reactive compaction 运行的 `compact` SessionStart，Hook 摘要行在实时界面挂在当前轮，冷合并后挂在下一轮。只影响界面，不影响模型请求。

## Session Event 与观测

新增 session event：

- `hook_run_started`
- `hook_run_progress`
- `hook_run_completed`
- `hook_run_failed`
- `hook_run_blocked`

事件 payload 至少包含：

- `hookRunId`
- `hookEventName`
- `hookSource`
- `matcher`
- `hookIndex`
- `toolCallId` 或 `requestId`
- `durationMs`
- `outcome`
- `stdoutPreview`
- `stderrPreview`
- `outputBytes`
- `truncated`

日志要求：

- 所有 hook 日志带 `traceId`。
- 默认日志不记录完整 `toolInput`、完整 prompt 或密钥。
- verbose/debug 可以通过受控 artifact 记录更完整的 hook I/O。
- hook 失败默认不让整个 turn 崩溃，除非事件语义允许阻断且 hook 明确 block/deny。

## 安全与跨平台

- P0 支持 `process` 的 argv 形式和 `command` 的显式 shell 形式；后者用于 Claude Marketplace 兼容。
- Windows 下解析 `.cmd` / `.exe`、空格路径和 cwd 失败必须由 adapter 处理。
- `process` 不默认 shell；只有 `command` 可以使用管道、重定向等 shell 语法。
- process hook 的 cwd 默认是 session working directory。
- hook 配置中的相对路径按配置文件所在目录解析，而不是按当前进程 cwd 解析。
- hook 输出大小必须限制，超出进入 artifact 或截断。
- hook 超时必须取消子进程，并记录 `hook_timeout`。
- hook 被取消必须传播 abort signal，不留下 pending promise。
- 用户/project hooks 后续应接入 workspace trust 或等价安全确认；P0 可以先在 TUI/CLI 中默认要求本地项目配置显式开启 `hooks.enabled`。
- Workspace Hook Trust 的产品规格见 `docs/specs/workspace-hook-trust.md`。CLI 侧的 Trust identity（D23）只经 `@zcode/adapters/config` 的 `resolveWorkspaceHookTrustIdentityForWorkspace` 计算。它调用 `@zcode/shared/managed-worktree` 的共享 resolver，文件端口由 adapter 提供，数据根目录沿用 `ZCODE_DATA_BASE_DIR`（为空时用 homedir），不新增环境变量。使用位置：
  - Runtime snapshot：`createZCodeApp` 先算出 identity，再经 `createConfig({ workspaceHookTrustIdentity })` 写入 snapshot；
  - `zcode hooks trust` 命令与协议 `workspaceHookTrust/grant`：record 键与 policy 评估都用 Trust identity；
  - 审核控制器：`requestReview`、`respond`、`revokeCurrent` 的 target 带 workspaceKey，先解析成 Trust identity 再与 snapshot 比较；
  - 同进程内的 Trust 重载通知：按 Trust identity 匹配活跃 session，源仓库授予后它的受管 worktree session 也会重载；跨进程通知由 Host 负责。
- Security Revision 按 snapshot 的 Trust identity 计数。源仓库与它的受管 worktree 共用同一个 revision 键。
- 对外字段只发会话所属 workspace 的 key（远程 = identity；本地 = 协议入口传入的 workspace key，受管 worktree 会话是项目 key，独立 CLI 缺省为工作目录），包括 `WorkspaceHookAdmissionUpdated.workspaceIdentity`、审核 request 的 `workspaceIdentity` 和由它们派生的 V4 投影。Trust identity 只用于 Trust record 读写、policy 评估、Security Revision 计数和 snapshot 内部比较。review binding 与命令路由按 workspaceKey 匹配；命令 target 带回的 workspaceKey 由控制器解析成 Trust identity 后再与 snapshot 比较。

## 实施阶段

### Phase 1: Spec + Contract

- 新增本文档。
- 在 contracts 中定义 hook event、config、input/output、result schema。
- 在 config schema 中加入 `hooks`；未配置时不执行，配置必须显式设置 `hooks.enabled:true`。
- 补 config parser 和 schema 测试。

### Phase 2: Core Runner

- 实现 matcher resolver 和 decision aggregator。
- 支持 in-memory callback hooks，方便单元测试和 SDK/ZCode app-server 后续接入。
- 在 `ToolExecutor` 接入 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`。
- 新增 hook session events。

### Phase 3: Runtime Lifecycle Hooks

- 在 `AgentRuntime` 保存同一个 `HookRunner`，供 tool executor 和 runtime lifecycle 共享。
- 接入 `SessionStart`：context 初始化后、首个用户 prompt 进入模型前触发；`source=startup|resume|fork|clear|compact`。
- 接入 `UserPromptSubmit`：用户输入转成 message history 前触发；可阻断，可追加 context，不允许修改原始 prompt。追加的 context 写在 prompt 之后。
- 接入 `Stop`：无 client-side tool call 且准备 complete 前触发；可注入 feedback 继续下一轮。
- 为 lifecycle hooks 添加 focused unit tests 和 headless runtime tests。

### Phase 4: Runtime Diagnostics + Hardening

- hook lifecycle events 补齐 stdout/stderr preview、output bytes、truncated、duration。
- process hook 相对路径按配置来源目录解析；如果来源未知，按 session working directory 解析。
- 补 timeout/cancel、invalid JSON、exit code 2、stop continuation limit 的测试。

### Phase 5: Process Adapter

- 实现 Node process hook adapter。
- 支持 stdin JSON、stdout JSON、stderr 诊断、timeout、abort、输出截断。
- 配置文件 hook 可以实际运行。

### Phase 6: User-Facing Integration（已完成桌面/Web 共用设置页）

- 设置页列出 user/project 配置、legacy import-only 配置和已启用/禁用插件 hooks。
- 设置页支持新增、编辑、删除、逐条启停与 legacy 一键导入；写回只修改 `.zcode/config.json`。
- 修改配置后废弃 deferred draft session，下一次发送使用新 runtime snapshot。
- TUI progress 和最近执行结果仍作为后续增强项。

### Phase 7: Expanded Events

- 接入 compact hooks。
- 评估 HTTP / prompt / agent hook；shell command 与 plugin hook 已完成。

## 测试要求

Phase 1：

- config schema 接受合法 hooks 配置并拒绝未知 hook event、非法 hook type、非数组 args。
- config merge 保持优先级稳定。
- 默认配置不启用任何 hook。

Phase 2：

- `PreToolUse` deny 阻止 tool 执行并发出 hook/tool 事件。
- `PreToolUse` updatedInput 会重新校验，非法 input 失败且不执行 tool。
- hook allow 不覆盖 explicit deny rule 和 plan mode。
- `PermissionRequest` allow 跳过 broker 并执行 tool。
- `PermissionRequest` deny 不执行 tool，并移除 pending permission。
- `PostToolUse` additionalContext 作为工具批次后的附件进入下一次模型请求，不改变 tool result。
- abort 会取消正在等待的 hook。

Phase 3：

- `SessionStart` 在首个 turn 前只运行一次，resume 来源可区分。
- `UserPromptSubmit continue:false` 在写入用户消息和发起模型请求前阻断。
- `UserPromptSubmit` / `SessionStart` 的 `additionalContext` 会进入下一次模型请求。
- startup、`UserPromptSubmit`、`Stop` 的上下文在冷恢复前后逐字不变，位置不变；每个来源都返回同一段静态文本时（内置 design 插件），冷恢复后的每次请求与热态逐字相同。
- resume 的上下文写在下一轮 prompt 之前；resume 后不发消息不写；多次 resume 不重复；下一轮是通知轮时写在通知之后。
- 带工具调用的一轮只写一份 `UserPromptSubmit` 上下文。
- startup / resume / fork 的正文与历史里最近一份 SessionStart 上下文相同时不写；不同时写入；重开后 rewind 切掉最近那一份时照常写入。
- fork 子会话在第一条输入之前用 `fork`，之后用 `resume`。
- 手动、auto、reactive 三种 compaction 后都运行 `compact`；上下文是 compaction 附件的最后一项，与 compaction 产出同一次提交并计入压缩后 token；与保留部分里最近一份相同时不写；有结果时（包括因去重不写）丢弃待写的 startup / resume 上下文，没有结果时保留；hook 运行期间停止时 compaction 不提交。
- 静态文本的 SessionStart 在三种 compaction 后都写回一份，压缩后的请求里只有一份，冷恢复后请求逐字不变。
- 已提交的 SessionStart 上下文不留在待写槽里：被摘要替换后，没有 compact 结果时也不会再写一份。
- retry 后不留下重复的 hook 上下文。
- `Stop continue:true + additionalContext` 会继续一轮模型请求，并受连续次数上限保护。
- `PreToolUse additionalContext` 在 tool 成功、失败和拒绝路径都作为工具批次后的附件进入下一次模型请求。

Phase 4：

- hook lifecycle events 包含 stdout/stderr preview、output bytes、truncated、duration。
- `Stop` continuation 超过上限时记录 diagnostic，且 turn 正常结束。
- abort 会取消正在等待的 lifecycle hook。

Phase 5：

- process hook stdin 收到结构化 JSON。
- stdout 合法 JSON 被解析；非 JSON stdout 仅记录 diagnostic，不使 hook 失败。
- stderr 不进入模型上下文。
- timeout 杀掉子进程并记录 `hook_timeout`。
- Windows 路径、`.cmd`、空格路径至少通过 adapter 单元测试模拟。

Phase 6：

- TUI 能展示 hook running/completed/blocked。
- session resume 不重复执行历史 hook。
- hook events 可按 traceId 关联到对应 turn/tool call。

## 建议的第一批提交拆分

1. `docs: add hooks v2 design`
2. `feat(contracts): add hook schemas and config contract`
3. `feat(core): add hook runner and in-memory callbacks`
4. `feat(core): wire tool lifecycle hooks`
5. `feat(core): wire runtime lifecycle hooks`
6. `feat(adapters): add process hook execution adapter`
7. `feat(cli): surface hook progress in TUI`

## 关键决策

- ZCode 第一版采用完整的事件语义和 deny > ask > allow 决策优先级，同时使用类型化 hook 名称与稳定顺序。
- `process` 是跨平台首选；`command` 作为显式 shell 兼容形态保留，并由类型区分。
- hook 不直接修改 core 状态，只返回显式 decision/context/input replacement。
- permission hook 不替代 permission system，只在 `ask` 阶段提供自动决策入口。
- 所有 hook I/O 都必须可观察、可取消、可测试，并挂在同一个 trace 链上。
