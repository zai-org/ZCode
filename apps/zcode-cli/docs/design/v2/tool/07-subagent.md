# Subagent Tool

模型可见工具名是 `Agent`，历史别名是 `Task`。本设计文档称为 `Subagent`，但实现时需要保留 `Agent` 作为模型可见工具名，与兼容的 Claude Code 插件生态中的 agent 配置、transcript 和 SDK 事件保持一致。

## 定位

`Agent` 不是一个普通函数调用，而是一个小型 agent runtime 入口。它根据输入选择一种执行形态：

| 形态 | 触发条件 | 说明 |
| --- | --- | --- |
| fresh subagent | 指定 `subagent_type`，或未启用 fork 时省略 `subagent_type` | 新建独立 agent 对话，只拿到本次 `prompt` 和该 agent 自己的 system prompt |
| fork subagent | fork gate 开启且省略 `subagent_type` | 子 agent 继承父会话历史、system prompt 和精确 tool pool，用于 prompt cache 共享 |
| background subagent | `run_in_background`、agent 定义 `background: true`、coordinator、assistant mode、fork gate 或 proactive 强制 | 立即返回 task 引用，完成后以通知重新进入主会话 |
| worktree subagent | `isolation: "worktree"` 或 agent 定义自带 worktree isolation | 在临时 git worktree 中运行，完成后无变更自动清理，有变更保留路径和 branch |
| remote agent | `isolation: "remote"` | 远程环境执行；ZCode 当前不支持 |
| teammate spawn | `team_name` 和 `name` 同时存在 | 这是 agent team/swarm，不是普通 subagent，应作为独立工具或独立模式处理 |

关键边界：普通 subagent 不是 OS 子进程，而是在同一进程内创建新的子执行上下文，再运行新的 query loop。外部进程、tmux、in-process teammate 和 remote agent 属于 agent team 或 remote task 分支，不应和普通 subagent 混成一个概念。

## 输入契约

模型可见基础输入：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `description` | `string` | 是 | 3 到 5 个词的短描述，用于 UI、task 状态、activity 文案 |
| `prompt` | `string` | 是 | 给子 agent 的任务正文 |
| `subagent_type` | `string` | 否 | 要使用的 agent 类型。fork gate 关闭时省略则默认为 `general-purpose`，开启时省略则触发 fork |
| `run_in_background` | `boolean` | 否 | 请求后台运行。后台任务禁用或 fork gate 开启时 schema 会隐藏该字段 |

`Agent` 模型可见输入不包含 invocation 级 `model` 覆盖。旧 transcript 可以保留历史
`model` 字段，但当前输入 schema 会忽略该字段；child runtime 只消费 Settings 或 Markdown
定义解析出的 Agent profile 模型。

扩展输入：

| 字段 | 类型 | 适用范围 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | background subagent 或 teammate | 给 spawned agent 起可寻址名称。background subagent 可通过 `SendMessage({ to: name })` 继续 |
| `team_name` | `string` | agent team | 与 `name` 一起触发 teammate spawn。省略时可使用当前 team context |
| `mode` | permission mode | agent team | 主要用于 spawned teammate，例如 `plan` 模式。普通 subagent 不应把它当作子 agent permission override |
| `isolation` | `"worktree" \| "remote"` | subagent | `worktree` 创建临时 git worktree。`remote` 当前不支持 |
| `cwd` | `string` | gated | 让子 agent 在指定 cwd 中运行。要求绝对路径，并且与 `isolation: "worktree"` 互斥 |

ZCode 需要把 schema gating 做成能力协商结果，而不是在 tool 内散落 feature flag。`cwd` 的绝对路径和与 worktree 的互斥关系也应进入 `validateInput`，不能只放在 prompt description。

## 输出契约

公开 output schema 主要有两类：

| `status` | 字段 | 说明 |
| --- | --- | --- |
| `completed` | `prompt` 加 `agentToolResultSchema` | 同步完成，返回子 agent 最终文本、usage、tool use 数、耗时和 `agentId` |
| `async_launched` | `agentId`、`description`、`prompt`、`outputFile`、`canReadOutputFile` | 后台启动成功，结果稍后通过 task notification 返回 |

内部还有两个分支：

| `status` | 说明 |
| --- | --- |
| `teammate_spawned` | team/swarm 分支，返回 teammate id、name、team、pane 等信息 |
| `remote_launched` | remote 分支，返回 remote task id、session URL 和 output file |

`agentToolResultSchema`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `agentId` | `string` | 子 agent ID，也是 transcript/task/output 的关联键 |
| `agentType` | `string?` | agent 类型。用于 one-shot 内建 agent 跳过 continuation trailer |
| `content` | `{ type: "text"; text: string }[]` | 子 agent 最终文本块 |
| `totalToolUseCount` | `number` | 子 agent 内部 tool use 总数 |
| `totalDurationMs` | `number` | 总耗时 |
| `totalTokens` | `number` | 最后一条 assistant usage 汇总出的 token 数 |
| `usage` | provider usage object | input、output、cache、server tool use、service tier 等 |

模型可见序列化不是原样 JSON：

- 同步完成时把 `content` 直接交给父 agent，再追加 `agentId` 和 `<usage>` trailer。`agentId` 行：
  `(use SendMessage with to: '<id>', summary: '<5-10 word recap>' to continue this agent)`。usage 缺失时不输出 `subagent_tokens` 行。
- `Explore` 可以用 SendMessage 继续，所以同步结果同样带 `agentId` 和 usage trailer。
- 同步报告：先输出 `[Subagent hand-back]` 说明段（报告是模型输出，不代表用户授权），再输出报告；报告先把 `\r\n`、`\r`、`\u2028` 等换行变体统一成 `\n`，再逐行缩进两格，报告里顶格的伪造框架行因此可以识别。空报告用 "(Subagent completed but returned no output.)"，同样套框架。框架只按返回路径决定：后台运行（含前台超时转后台）完成时，task-notification 的 `<result>` 是原始报告，不套框架、不缩进；默认前台还是后台不影响这条规则。这段文本只给模型：父对话里的 Agent 卡片只有单行摘要、不展开，过程和输出从右侧 tab / 手机抽屉按 child session 查看，所以框架前缀不出现在界面上。
- 后台启动文案：首行带 "(This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)"，第三行说明结果到达前不得报告或猜测；无 output file 时以 "In your own words, briefly tell the user what you launched — do not echo this tool result. …" 结尾。有 output file 时给出 `output_file` 和不读取提示；提示不提 transcript，因为输出文件是子代理输出文本，不是 JSONL transcript。只有父 agent 拥有 `Read` 或 `Bash` 时才提示 output file。App 按 "Async agent launched successfully." 前缀等四个片段识别后台启动，新文案仍满足。
- 后台终态通知（`<task-notification>`）：每个字段单独一行，顺序是 `task-id`、`tool-use-id`、`output-file`、`status`、`summary`、`note`、`result`、`usage`。只转义 `& < >`，引号和撇号原样保留。
  - `status` 只有 `completed`、`failed`、`killed` 三个值。
  - summary：completed 是 `Agent "<description>" finished`；failed 是 `Agent "<description>" failed: <原因>`，原因为空或只有空白时写 `Unknown error`（结构化 error 相同）；killed 按停止者区分：模型用 TaskStop 停止是 `Agent "<description>" was stopped by ZCode`，用户在 App 里停止是 `… was stopped by user`，系统停止（rewind、闲时任务收尾等）是 `… was stopped`。
  - `<note>` 每条都有，固定文字：`A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.` child 结束时封存自己的后台通知，不会自己恢复，所以 completed 且还有后台子任务时也用这一句。
  - `<result>` 只在 completed 时出现，内容是原始报告。failed 和 killed 不带 `<result>`（暂不采集子 agent 已输出的部分文字）。
  - `<usage>` 只在 completed 时出现：`<usage><subagent_tokens>N</subagent_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>`，缺的字段不输出。
  - 不再输出 `<error>`。终态和失败原因另由通知命令的 `originMeta.subagentResult`（`{ status, error? }`，error 只在 failed 时出现，与 summary 里的原因同一字符串；超过 2000 字符时截到 2000 字符并以 `…` 结尾，summary 不截断）结构化下发，随通知消息的 metadata 持久化。App 读状态和失败原因以它为准，不解析 summary；旧会话没有它，读 `<status>` / `<error>`。多条通知合并成一轮时，合成的 originMeta 只保留基字段，不带 subagentResult，失败详情退回该任务自己的整句 summary。App 按 `<task-notification>` 块逐条解析：每块只读块内的标签，按各自的 `tool-use-id` 更新对应的行；只有一个块时才使用 `originMeta.subagentResult`。跨块读取会把下一条通知的 `<result>` 当成前一条失败任务的原因，后面的任务也得不到终态。
  - 整条通知超过 120 000 字符时截断（防止单条通知过长）。
- remote 启动时提示父 agent 简短告知用户已启动，然后结束本轮。
- 子 agent 的结果不会自动展示给最终用户，父 agent 必须负责总结或继续执行。

## Agent 定义契约

ZCode 的用户／项目自定义 Markdown 仅从各自 `agents` 根目录直接文件加载
（`.md` / `.markdown`，大小写规则不变），不扫描子目录；独立 CLI、Host 和 Settings
使用同一范围。插件 agent 继续遵循已有插件发现规则。详见根目录 `docs/subagent-runtime-refresh.md`。

agent definition 有三类来源：

| 来源 | 说明 |
| --- | --- |
| built-in | 代码内建，system prompt 动态生成 |
| custom | 用户、项目、policy、flag settings 中的 markdown 或 JSON agent |
| plugin | plugin 提供的 agent，agent type 会带 plugin namespace |

agent definition 的核心字段：

| 字段 | 说明 |
| --- | --- |
| `agentType` | 模型调用 `subagent_type` 时使用的稳定名称 |
| `whenToUse` | 写入 Agent tool prompt 的选择说明 |
| `getSystemPrompt` | 子 agent system prompt |
| `tools` | 允许 tool spec。省略或 `["*"]` 表示可用全集经过 filter 后全部允许 |
| `disallowedTools` | 在允许全集上再次剔除 |
| `model` | agent 默认模型，`inherit` 表示继承父模型 |
| `effort` | 推理 effort 覆盖 |
| `permissionMode` | agent 内部工具权限模式。ZCode 省略时继承父会话模式与 Plan 状态（内置 Explore 相同）；父为 guarded 时，yolo（含 `bypassPermissions`、`dontAsk`）一律收紧为 guarded。用户级 profile 按声明生效，项目级 profile 忽略，插件 profile 只能收紧，见「ZCode 当前实现」 |
| `maxTurns` | agent 内部 query loop 最大轮数 |
| `skills` | 启动时预加载的 prompt skill |
| `mcpServers` | child 可见的 parent MCP server 范围；设计上可支持引用或 inline config，ZCode 当前只接受 parent server name 列表 |
| `requiredMcpServers` | agent 可用性前置条件，必须有匹配 server 且有工具 |
| `hooks` | agent 生命周期内注册的 session scoped hooks |
| `background` | agent 总是后台运行 |
| `initialPrompt` | agent 初始 prompt 扩展 |
| `memory` | user/project/local agent memory |
| `isolation` | agent 默认隔离模式 |
| `injectAgentsMd` | 是否向 child 注入 AGENTS.md；只读内建 agent 默认不注入以省 token，见下文 |

加载优先级是 built-in、plugin、user、project、flag、managed 逐组覆盖，同名 agent 后面的源会覆盖前面的源。解析失败的 markdown 只在看起来像 agent 文件时进入 `failedFiles`。

### ZCode AGENTS.md 注入契约

ZCode 的 custom agent Markdown 额外支持可选 frontmatter 字段 `injectAgentsMd: boolean`。它只控制 child request 是否注入父 runtime 已解析的 AGENTS.md，不改变 agent system prompt：

| Profile | `injectAgentsMd` 缺省行为 |
| --- | --- |
| 内建 `general-purpose` | 注入 |
| 内建 `Explore` | 不注入 |
| custom | 注入；显式设为 `false` 时关闭 |

child runtime 只接收父 runtime `contextSourceSnapshot.userInstructions` 的快照；父级没有 snapshot 时不注入，也不在 child 中重新读取文件或构造 fallback。provider-visible 位置与 Main 相同，复用 Main 的 Request User Context formatter：

```text
父 runtime 已解析的 userInstructions
              |
              v
child initial system（产品 prefix；专用 prompt + 启动方消息段 + Notes）
MCS 开：user [context_prefix, child task] -> system [environment, model, skills, date]
MCS 关：user [environment, model, skills, context_prefix, date, child task]
```

context_prefix 只在允许注入且 AGENTS.md 非空时出现。child task 由 coordinator 以
`coordinator_input` 提交（首轮任务和恢复终态 child 的新任务），投影位置等同 Main 的真实用户
prompt：请求前的公告排到它之前，它前面紧挨的 user 文本以换行结尾。它的身份仍不是真实用户。

AGENTS.md 不得拼入 agent-specific prompt、common Notes 或 environment announcement；child 也不继承 Main 的 Project Context 或 Project Memory。Settings 的 user custom agent 表单在 system prompt 编辑器下方以单行“注入 AGENTS.md”开关展示该字段，文案与 Switch 垂直居中，不显示辅助说明；修改在下一次 runtime/profile 加载时生效，不增加热刷新链路。
指令正文与 Main 共用同一 formatter，并按聚合 request-user-context 是否非空渲染一次。
环境与当前执行模型共用 `buildEnvironmentSections`，通过各自会话的动态公告历史下发，
不再放入 child 初始 system；普通 custom child 的专用正文不触发 Main 的 custom-system 跳过规则。
child 不继承 Main Project Memory，因此在 child 链路中实际判断仍等价于父 snapshot 是否包含非空
AGENTS.md；Explore、显式关闭注入的 custom agent 以及父 snapshot 没有 AGENTS.md 时均不渲染。

child 的初始 context snapshot 只由父级传下的配置组成（envInfo、日期、指令快照），初始化时不调用
`resolveContextSources`，不重新查找 project root，也不探测 Project Context。child 仍持有父级的
`ContextSourcePort`，只用于 child 内 cwd 变化后、以及 child 冷恢复后第一次环境公告的
`resolveEnvironment`（见 `meta-user-context.md`）。

## Tool Pool

子 agent 不是简单继承父工具。普通 subagent 使用：

1. 用 agent 的 `permissionMode` 生成 worker permission context。ZCode 省略时继承父会话模式，按来源的规则见「ZCode 当前实现」。
2. 按 worker permission context 和当前 MCP tools 组装候选工具。
3. 应用 agent 的 `tools`、`disallowedTools` 和全局 subagent 过滤（区分同步与后台 agent）。
4. agent 专属 MCP server 初始化后，其 MCP tools 与 resolved tools 合并并按 name 去重。

全局过滤规则：

- MCP tools 对所有 agents 可用。
- `ExitPlanMode` 只在 plan-mode agent 中特殊允许。
- `TaskOutput`、`ExitPlanMode`、`EnterPlanMode`、`AskUserQuestion`、`TaskStop` 等默认禁止给 subagent。
- 禁止 subagent 再调用 `Agent`，避免递归。
- 自定义 agent 继承同一批 disallowed tools。
- async agent 只能使用后台 agent 允许工具集，包括 read/search/web fetch/shell/edit/write/notebook/skill/tool search/worktree enter-exit 等。
- in-process teammate 有额外允许的 task tools 和 `SendMessage`，用于 team 协作。

`Agent(...)` tool spec 有特殊含义：在主线程可以携带允许的 agent type 列表，限制模型能选择哪些 `subagent_type`。在 subagent 内部这个 spec 只保留元数据，不真正解析出 `Agent` 工具。

fork 路径例外：fork child 使用父 agent 的精确 tool array，同时继承父 thinking config 和 non-interactive 设置。这是为了让 system prompt、tools、model、messages 和 thinking config 保持 byte-identical，从而命中 prompt cache。

## 执行流程

普通 fresh subagent：

1. 校验 agent team 权限和嵌套 teammate 限制。
2. 解析 `effectiveType`：显式 `subagent_type` 优先，省略时根据 fork gate 选择 fork 或 `general-purpose`。
3. 按 MCP requirement 和 permission deny rule 过滤 agent。
4. 如果 required MCP server 还在 pending，最多等待 30 秒，每 500ms 轮询。
5. 解析模型，记录 agent 选择事件。
6. 获取 agent system prompt，加入环境细节和可用工具信息。
7. 构造单条 user message，内容为 `prompt`。
8. 组装 worker tool pool。
9. 如需要，创建 worktree 并让后续执行在该 cwd 下运行。
10. 创建子执行上下文并运行 child query loop。
11. 外层 runner 必须同时监听父级 abort signal，并维护 foreground child activity watchdog。
    watchdog 默认复用模型流 idle timeout 窗口，并在 child session event 上重置；如果 child
    promise 在静默窗口后仍无响应，应以 `ToolTimeout` 结束并写入 `SubagentStopped`。如果父级
    abort 后 child promise 不 settle，应以 `ToolCancelled` 结束，避免 foreground `Agent` 长期
    停在 running。
12. 收集子 agent messages，转发 tool progress、bash/powershell progress、token metrics。
13. 结束时提取最后 assistant text、usage 和 tool use 总数。
14. 如 auto mode classifier 开启，对 subagent handoff 做安全复核。
15. 清理 foreground task、hooks、skills、dump state、worktree。

fork subagent：

1. 省略 `subagent_type` 且 fork gate 开启。
2. 先用 `querySource` 和消息中的 fork boilerplate tag 防止 fork child 再 fork。
3. 使用合成的 fork agent 定义，其 `agentType` 是 `fork`、`model` 是 `inherit`、`permissionMode` 是 `bubble`、`tools` 是 `["*"]`。
4. 子 agent 使用父会话已经渲染好的 system prompt。若不可用才重算，但这可能破坏 cache。
5. 克隆父 assistant message 的全部 tool_use/thinking/text block，给每个 tool_use 填同一个 placeholder tool_result，再追加 per-child directive。
6. fork child 被强制后台运行，最终通过 task notification 回到主循环。
7. fork + worktree 时追加 worktree notice，提醒路径来自父 cwd，需要转换到 worktree 并重读可能过期的文件。

background subagent：

1. 预先创建 `agentId`，注册 `LocalAgentTask`。
2. task 输出路径写入 `output.txt` 和 `task.output`；子 agent 的 messages/parts 和恢复所需 session state 由 session store（默认 SQLite）持久化。
3. 返回 `async_launched`，父 agent 继续处理别的工作或结束本轮。
4. 后台 lifecycle 消费 child 消息流，持续更新 progress。
5. 完成后先把 task 标记为 completed，避免 output 读取方被 classifier 或 worktree cleanup 卡住。
6. 通过 `<task-notification>` 把 status、summary、output file、usage、worktree 信息重新送进主会话。
7. 停止标记 killed，通知带停止者（`SubagentStopOptions.initiator`：TaskStop 传 `model`，App 停止传 `user`，系统路径不传）；其他异常标记 failed。failed notification 必须从异常 cause 链取最接近 provider 的原始 message：summary 写成 `Agent "<description>" failed: <原文>`，不翻译、不映射错误码，也不把失败伪装成 `<result>`。
8. 父侧 Agent 工具最初的 `completed` 只表示后台任务已成功启动；匹配 `tool-use-id` 的 failed notification 才能覆盖 launch ACK。live event 与 snapshot/restore 都必须用 notification 的 failed 状态和失败原因覆盖，保证现有“执行失败”状态文案和 hover 错误详情在切换任务后不丢失。失败原因取自 `originMeta.subagentResult.error`（旧会话读 `<error>`）；单条通知的轮次 hover 只显示原文，不带 `Agent "…" failed:` 前缀；多条通知合并成一轮时没有结构化原因，hover 显示该任务自己的整句 summary（见上文后台终态通知）。V4 投影（桌面、Web、手机）把 `killed` 和旧会话的 `stopped` 都显示为已停止；legacy 快照路径（bots 的 `getTaskSnapshot`、`zcodeSessionProjection`）只用 failed 覆盖 launch ACK，killed 仍显示为完成。

sync 转 background：

- 同步 agent 一开始也注册 foreground task。
- 超过 2 秒后 UI 可展示 background hint。
- 用户或自动 background 触发后，当前 iterator 先 `return()` 清理，再以同一个 task id 重新以后台方式运行 child。
- 返回给父 agent 的结果改成 `async_launched`。

## 子上下文隔离

子执行上下文默认隔离所有可变状态：

| 状态 | 默认行为 |
| --- | --- |
| read file state | 从 parent clone，结束时 clear |
| abort controller | 新 child controller。同步 Agent 可以显式共享 parent controller，后台 agent 使用独立 controller |
| app state 读取 | 默认标记为避免权限弹窗，防止后台 agent 弹交互权限 |
| app state 写入 | 默认 no-op。需要 task 注册和 kill 时只通过 task 专用入口写 root store |
| response length | 可选择共享，让子 agent 计入父响应 metrics |
| memory/skill/dynamic triggers | fresh Set |
| content replacement state | clone parent，fork 用于保持 cache replacement 决策一致 |
| query tracking | 新 chain id，depth 在 parent 基础上加一 |

child 运行时还会：

- 创建或使用传入的 `agentId`。
- 为 fork 过滤不完整 tool call，避免 orphaned tool use 破坏 API 请求。
- 加载 user/system context，read-only built-in agent 可省略部分 context。
- 执行 `SubagentStart` hooks，并把 hook additional context 作为 attachment message 加进初始消息。
- 注册 agent frontmatter hooks，Stop hook 会转换成 `SubagentStop`。
- 预加载 agent frontmatter 中指定的 prompt skills。
- 初始化 agent 专属 MCP servers，结束时清理。
- 写输出 artifact 和 metadata；不再额外写入 `transcript.jsonl`，子 agent history 由 session store（默认 SQLite）落库。
- 在 finally 中清理 MCP、session hooks、prompt cache tracking、read cache、todos、background shell/monitor tasks。

## Transcript 与 Resume

ZCode 不再写入独立的 `transcript.jsonl` 文件。子 agent 的 messages/parts 与恢复所需 session state
由 session store（默认 SQLite）持久化；session event store 负责运行期事件排序、live sink 和
进程内事件回放。任务 artifact 目录只保存 `output.txt`、`task.output` 和 `metadata.json`。

metadata 至少保存：

| 字段 | 说明 |
| --- | --- |
| `agentType` | resume 时恢复原 agent 类型。fork resume 需要知道它是 `fork` |
| `worktreePath` | worktree agent resume 时恢复 cwd |
| `description` | notification 用原始描述 |

`SendMessage` 可以继续一个已 spawned subagent：

- `to` 可以是注册过的 name，也可以是 raw `agentId`。
- running task 收到消息时，只把文本放入 `pendingMessages`，在下一次 tool round 边界 drain。
- stopped task 会通过 `resumeAgentBackground()` 自动恢复。
- task 已从 registry evict 时，当前不会仅凭磁盘 artifact 重新发现目标。
- resume 会读取 session store 中的 messages/parts 和 session entries，过滤未配对 tool use、重建 content replacement state、恢复 worktree cwd，并把新 prompt 追加为 user message。
- fork resume 必须重建父 system prompt，且不会重复传入原 fork parent context slice，避免重复 tool_use id。

当前持久化边界是：session store（默认 SQLite）负责 child history 和 session state；session event store
负责运行期事件排序、live delivery 和进程内 replay。resume 从 session store 读取，不再维护第二份
transcript sidecar。

## 权限与副作用

如果 `Agent` 的只读声明固定为 `true`（理由是它只负责编排，实际副作用由子 agent 调用的底层工具做权限检查），对 tool framework 方便，但对 ZCode 的审计语义不够细。

ZCode 建议拆成两层声明：

| 维度 | 建议 |
| --- | --- |
| `orchestrationReadOnly` | `true`，spawn 本身不直接写文件、跑命令或联网 |
| `effectiveReadOnly` | 动态，取决于 agent tool pool、permission mode、prompt intent、isolation 和 background |
| `sideEffectScope` | `session`、`workspace`、`git`、`network`、`system`、`userInteraction` 的并集 |
| `concurrencySafe` | spawn 编排可并发，但同一 worktree/cwd 的写工具仍需由底层工具和 file locks 保护 |
| `destructive` | 如果 agent 可用写入、shell、git 或 network tool，则应提升为潜在 destructive |

权限规则：

- `Agent(...)` permission deny 可以禁止某个 agent type。
- auto mode 下直接 allow。
- 子 agent 不应自动继承父 agent 的 tool 限制；它通过自己的 tool pool 和 permission mode 重新组装。
- 但当父权限模式是 `bypassPermissions`、`acceptEdits` 或 `auto` 时，子 agent 会继承该能力边界，不允许 agent definition 覆盖成更低权限。这是高风险点。
- ZCode 当前规则与上一条不同：子会话模式按 profile 来源决定，插件声明只能收紧，见「ZCode 当前实现」。
- async agent 默认避免弹权限 prompt，除非 permission mode 是 `bubble` 或显式允许显示 prompt。
- `AskUserQuestion` 在 subagent 内默认不可用，避免子 agent 直接向用户发起交互。

ZCode 的权限系统应在 spawn 前生成 `SubagentPolicy` 快照，记录 agent type、allowed tools、permission mode、side effect scopes、是否允许 background、是否允许 resume、是否允许 worktree 和是否允许 user prompt。

## Hooks、MCP、Skills

### 官方 Computer Use 子 Agent边界

子 Agent 借用 parent MCP port 时，官方 `zcode-cua` 不能通过 wildcard 继承。Core 使用冻结的
official server authority 将其从 child snapshot、tool allowlist 和 SkillPort 中移除；profile
显式声明官方 CUA server、tool、selector 或 Skill 时，在 child 首次模型请求前返回
`SUBAGENT_COMPUTER_USE_UNAVAILABLE`。这条规则适用于 Explore、general-purpose、custom、
background 和 resume。

该过滤只改变 child 视图，不改变 parent snapshot、MCP lifecycle 或主 Agent 的官方 CUA 工具。
Producer 仍需在 `runtime_scope=subagent` 时拒绝所有 CUA tool call，作为不能由 tool surface 绕过的
执行期 backstop。完整契约见 `docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md`。

subagent 不是只跑模型和工具，还会触发扩展系统：

- `SubagentStart` hooks 输入包含 `agent_id` 和 `agent_type`，可返回 additional context。
- agent frontmatter hooks 注册为 session scoped hooks，并在 agent lifecycle 结束时清理。
- agent Stop hooks 会以 `SubagentStop` 事件执行。
- agent frontmatter `mcpServers` 设计上可在父 MCP clients 基础上 additive 合并，inline MCP client
  结束时 cleanup；ZCode 当前 child 只借用 parent-owned MCP 连接，不创建 inline client。
- plugin-only policy 下，用户可控 frontmatter MCP 和 hooks 会被跳过或限制。
- `skills` 会在 agent 启动时解析并预加载为 meta user message；plugin skills 可通过 bare name、plugin prefix 或 suffix match 解析。

ZCode 应把 hook/MCP/skill 都视为外部 I/O 或扩展边界，必须带 trace、权限、timeout、cleanup 和 source trust。

## 失败路径

关键失败路径：

- agent teams 未启用却传 `team_name`。
- teammate 试图再 spawn teammate。
- in-process teammate 试图 spawn background subagent，或选中的 agent definition `background: true`。
- fork child 再次触发 fork。
- `subagent_type` 不存在。
- `subagent_type` 存在但被 `Agent(agentType)` deny rule 禁止。
- required MCP server pending 超时、failed、未认证或没有工具。
- remote agent eligibility 不满足，bundle 或 session 创建失败（remote 当前不支持）。
- agent system prompt 获取失败，fallback 到 default agent prompt。
- agent-specific MCP 初始化失败。
- child 运行完成后没有 assistant message，结果收尾阶段报错。
- sync agent AbortError。
- sync agent 中途异常但已有 assistant message，尽量返回 partial finalized result。
- async agent AbortError，标记 killed；通知不带 `<result>`（暂不采集已输出的部分文字，见上文后台终态通知）。
- async agent 普通异常，标记 failed。
- async agent 普通异常的 provider 原始 message 必须同时进入 task notification summary、runtime task error 和 `SubagentStopped.payload.error`；外层 `Turn execution failed` 只能作为 detail 保留，不能覆盖父模型或 Agent 卡片看到的失败原因。
- worktree cleanup 失败或 worktree 已被外部删除，resume 时回退到 parent cwd。
- classifier 不可用或判定 handoff 危险，需要把 warning 插入父 agent 可见结果。
- session store 中 child history 缺失，resume 失败。
- output file 或 task state 被 evict，`SendMessage` 不会仅凭磁盘 artifact 重新发现目标。

## ZCode Explore MVP（历史基线）

本节记录最初 Explore MVP 的收窄范围，不再代表当前完整能力：

- 模型可见工具名为 `Agent`，输入包含 `description`、`prompt`、可选 `subagent_type` 和可选 `run_in_background`。
- 当时第一版仅支持 `subagent_type: "Explore"`，省略时默认 `Explore`。
- `Explore` 支持同步 one-shot 和 `run_in_background: true` 后台运行；后台完成后通过父会话 notification 进入下一轮模型请求。
- 当时第一版未支持 resume、fork、worktree、team、MCP、hooks、agent skills 或 `SendMessage`。
- child runtime 使用独立 session id，但继承父 `traceId`，`SubagentSpawned` / `SubagentStopped` 事件写入父 session，child tool/model/turn 事件写入 child session。
- child `tool_call_scheduled` / `tool_call_started` / `tool_call_progress` / `tool_call_result` /
  `tool_call_error` 事件必须镜像到父 runtime 的 live event sink，供兼容消费者、运行态诊断和 telemetry 观察
  Explore 内部正在运行的工具。镜像事件使用父 session id、父 turn id 和 namespaced toolCallId，
  payload 保留 `source: "subagent"`、`parentToolCallId`、`childSessionId`、`childToolCallId`、
  `agentId`、`agentType` 和 `description`。镜像事件不写入父 event store；事实来源仍是 child
  session 中已经持久化的原始事件，避免把 child tool 误计为父 agent 的模型可见工具调用。
- ZCode Protocol V4 把 Agent/Task 详情统一放在 child session。父 ProductProjection 在 materialize
  tool row 前必须丢弃 `source: "subagent"` 的 mirrored lifecycle，不能生成父 `ToolCallRow`、plan
  或文件摘要；child topic 仍按原始事件生成完整工具行。foreground child 的等待态由父 Agent tool
  和 main turn phase 表达，background child 由 subagent manifest/background work 表达；权限、提问等
  阻塞交互继续按 subagent origin 代理到父会话。桌面 continuous 与手机 replayable 使用同一投影边界。
- child runtime 的模型只来自已解析的 Agent profile；profile 未配置模型时继承父 runtime 当时的 `modelRef` 和 `modelProviderOptions`。`Agent` tool input 不提供 invocation 级模型覆盖，避免历史 tool call 参数覆盖 Settings 或 Markdown profile 的当前配置。
- 主 runtime 当前默认采用 embedded search 分支；主模型请求和
  Explore child 请求都隐藏 direct `Glob/Grep`，并通过 Bash `find` / `grep` function 承接
  broad file/code search。Windows CMD 或 legacy shell fallback 无法注入 Bash function 时，
  才回到 non-embedded/direct 分支并暴露 `Glob/Grep`。
- child tool pool 按 embedded search branch 切换：默认为 `Bash`、`Read`、`WebFetch`、`WebSearch`、`TodoWrite`；direct fallback branch 额外包含 `Glob`、`Grep`。它始终显式排除 `Agent`、`Write`、`Edit`、`ApplyPatch`、`Skill`、`AskUserQuestion` 等递归、写入或用户交互能力。
- `Agent` 自身声明为编排层 read-only、`sideEffectScope: session`、不需要审批；实际文件读取仍由 child 的 read-only tool 走各自 schema、权限和 trace。`Bash` 是 child tool pool 中唯一可能产生副作用的入口；它的只读约束由权限层（继承父会话模式与 Plan 状态，shell AST 判定只读，见下一条）、Explore system prompt 的 read-only 禁令和缺失文件写工具共同承担。
- child runtime 继承父会话的权限模式、Plan 状态和权限服务（allowedTools、disallowedTools、会话内授权），配专用 Explore system prompt。Bash 是否只读由 shell AST 判定：只读命令放行；非只读命令在父会话 build/edit 下请求审批（代理回父会话），在 Plan 下拒绝，在 yolo 下放行，在 guarded 下命中危险命令规则时单次确认、其余放行；WebFetch 同样按父会话模式判定。修复原因：Explore 曾固定以 yolo 和独立权限服务运行，只靠 prompt 约束只读，提示注入后模型可经 `Agent(Explore)` 在 build 或 Plan 父会话下免审批执行任意 Bash。业务代码通过 `SubagentPort` 调度，不直接依赖 runtime 内部实现。

后台 subagent 的原始设计来源见 [Background Subagent 第一版实施规划（历史）](./07-subagent-background-plan.md)。该文档用于解释第一版 lifecycle 取舍，不覆盖本节和 `RespondToCoordinator` 当前契约。

该阶段规划后续增加新 agent 类型时必须先补：

- `AgentDefinitionRegistry` 或等价契约，声明 agent type、描述、system prompt 来源、tool pool、权限边界、是否允许 background/resume/worktree/user prompt。
- `ToolPoolResolver`，把 agent 声明解析成模型可见 tool contracts，并用测试证明递归 Agent、用户交互和写入工具不会意外泄露。
- 子 agent session history / task state 存储契约，支持 resume、kill、progress、notification 和 event replay。
- hooks、MCP、skills、remote agent 等扩展边界的 capability、权限、timeout、cleanup、trace 声明。

## ZCode 当前实现

当前实现已经从最初 Explore MVP 扩展为 profile-backed local agent：

- 模型可见工具名仍为 `Agent`；`subagent_type` 省略时默认 `general-purpose`，显式值通过当前 runtime 已加载的 agent profile 解析。
- profile-backed agent 支持同步运行和 `run_in_background: true`。后台任务继续使用 `RuntimeTaskRegistry`、child session、completion notification 和 runtime command queue，不建立第二套任务状态。
- runtime 仅在 `SubagentPort.sendMessage` 可用时注册模型可见 `SendMessage`；当前 profile-backed child 固定关闭 subagent 能力且不注入该 port，因此不会注册 `SendMessage`。若未来 child 提供该 port，tool allowlist/disallowlist 仍会继续过滤模型可见工具。
- 内建 agent 包含默认的 `general-purpose` 和只读搜索用的 `Explore`；project/user profile 可以覆盖 system prompt、tool policy、model、skills 和 background 设置，permission mode 见下一条。profile 的 `tools: ["*"]` 仍需经过全局 child tool filter、profile `disallowedTools` 和 runtime allow/disallow 规则收敛。
- 子会话权限模式：profile 省略 `permissionMode` 时继承父会话模式与 Plan 状态，内置 Explore 相同；父为 guarded 时，任何来源的 yolo（含 `bypassPermissions`、`dontAsk`）都收紧为 guarded。用户级 profile 按声明生效；项目级 profile 的声明在解析时剥离；插件 profile（官方与第三方同一规则）只在比父会话模式更严格时生效，严格程度从严到宽为 plan、build、edit、guarded、yolo，`auto` 未实现，按继承处理。规则与威胁边界见 [项目配置信任边界](../../../../../../docs/security/deep-link-project-trust-boundary.md)。
- 用 `SendMessage` 恢复已结束的子会话时，按父会话**当前**的模式与 Plan 状态重新计算子会话模式（规则同上），覆盖子会话落盘时的执行状态。修复原因：恢复路径曾沿用子会话落盘的模式，父会话从 yolo 改为 build 后恢复的子会话仍以 yolo 运行，升级前落盘为 yolo 的 Explore 与插件 bypass 子会话也不受上述规则约束，父会话开启 Plan 后恢复的子会话也不在 Plan。
- provider-visible `TaskStop` 可以停止当前 runtime 中已经 background 的 `local_agent` / `local_bash`；`local_agent` 的 result `command` 使用短 `description`，不得回退为完整 `prompt`。

### Built-in Explore 身份边界

- `AgentProfile.source` 是加载器写入的身份事实，frontmatter 不能覆盖。project/user profile 可以用
  同名 `Explore` 覆盖内置定义，但覆盖后仍保留自己的 source。
- 只有 `name === "Explore" && source === "built-in"` 才使用内置只读 prompt、动态 Explore
  tool pool、`explore` toolset、专用 permission service 和未显式设置 permission mode 时的 yolo。
- 同名自定义 Explore 与其他自定义 profile 一致，使用自己的 prompt、tools，并按自己的
  `mcpServers` 限定 parent MCP 可见范围；使用 `main` toolset，并继承普通 custom agent 的权限语义。

### Child MCP 所有权与启动快照

- MCP adapter 的连接与关闭生命周期属于 parent runtime。child 只等待并复用 parent
  `mcpStartupPromise` 保存的启动 snapshot，不在创建时重新调用 parent `status()` 或 `listTools()`。
- `mcpServers` 只接受 parent server name 字符串列表；省略或空列表表示不额外限制。非空列表按
  descriptor 原始 `serverName` 精确限定 snapshot，只有启动时状态为 connected 的 descriptor 可见。
- wildcard/继承工具集和显式 MCP tool 校验使用同一份 scoped snapshot；显式 tool 按完整模型可见名称
  匹配，不从 `mcp__<server>__<tool>` 拆分反推 server。
- child 持有 snapshot-backed borrowed port：`status()` / `listTools()` 只回放固定 snapshot，
  `callTool()` 委托 parent；connect、reconnect、disconnect 均拒绝，child close 不传播给 parent。
- 这是固定启动快照语义：parent 启动后才经 OAuth 或重连出现的新 descriptor，要到 parent runtime
  重建后才会进入 subagent 候选工具集。

```text
Parent startup -> MCP snapshot -> parent registry
                         |
Child spawn     -> scoped fixed snapshot -> provider tools -> parent.callTool
                         |
Child finish    -> no parent MCP cleanup
```

### SendMessage 当前范围

- `to` 必须是当前 runtime `RuntimeTaskRegistry` 中仍可寻址的 `local_agent` task/agent id。当前不支持名称 alias、跨 runtime 投递，也不会在 task 已从 registry evict 后仅凭磁盘 artifact 重新发现目标。
- provider-visible description 和字段说明只覆盖 local-agent 子集；teammate mailbox、shutdown、
  plan approval 等 ZCode 未支持的 team protocol 不进入工具说明。
- 输入 schema（不支持跨会话消息）：`required` 为 `["to","message"]`；`summary` 可选，
  描述为 `A 5-10 word summary shown as a one-line preview in the UI. Defaults to the first line of a plain-text message; longer summaries are truncated to 200 characters rather than rejected.`，
  provider schema 声明 `maxLength: 200`，运行时超长不拒绝：超过 200 个 UTF-16 码元时保留前 199 个码元
  （末尾是高位代理时再去掉它，不切断 emoji 等代理对）并加 `…`；`message` 描述保持 `Plain text message content`。
  交付给 child 的只有 message（无论是否带 summary；summary 只用于预览），只有空白的 message 在 PreToolUse hook 与权限之前判为输入错误，模型收到 `<tool_use_error>message must not be empty</tool_use_error>`，不触发 PostToolUseFailure；resume 终态 child 时沿用原 task 描述，summary 不改描述；App 的 SendMessage 卡片标题用 message 的第一个非空行（与描述里的 "Defaults to the first line" 一致）。`to` 的描述与长度限制不变；不支持名称、teammate 和 `"main"`。
- running agent 有 active message sink 时直接投递到当前 turn，返回 `steered` 或 `queued`；没有 sink 或 sink 投递失败时进入该 task 的 pending message queue。
- terminal agent 仍保留 profile 和 child session id 时，`SendMessage` 复用原 child session 并在后台恢复；目标、profile 或 child session metadata 缺失时返回结构化失败。
- queued 和 terminal resume 的模型可见成功文案分别固定为：
  `Message queued for delivery to ${to} at its next tool round.`；
  `Agent "${to}" was stopped (${status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${outputFile}`。
  `steered` 是 ZCode 的 active-turn 扩展，保持现有独立文案。
- terminal resume 继续只发布 `SubagentSpawned(background=true, resumed=true)`；V4 在同一次投影中
  复用原 `agentId` / `childSessionId` 恢复 running row 和 cancellable background work，并保留原
  `Agent` tool call 的 `parentToolCallId` 作为 row 展示锚点。不得用本次 `SendMessage` call id 覆盖，
  也不得为同一次 resume 再补发 `BackgroundTaskStarted`；Stop 继续走现有 runtime task abort 路径。
- `status: "success"` 只表示消息已被 `queued`、`steered` 或通过 `resumed_background` 接受，不表示目标 agent 已读取、接受任务或回复。
- lowercase `send_message` 是独立的 session mailbox 工具，不复用 `SendMessage` 的 local-agent 路由、output 或 display 语义。
- 当前没有独立的通用 resume tool，也不把 fork、worktree、team 或跨 session mailbox 能力隐式归入 `SendMessage`。

### RespondToCoordinator 当前范围

- `SendMessage` 保持 parent/main-only。running child 在当前 tool batch 结束后的合法 round 边界接收带
  `Message from coordinator:` 标识的 steer input，不中断正在执行的单个工具或 parallel batch。
- coordinator response port 已配置、`taskType === "subagent_child"` 且未被全局
  `toolDisallowlist` 禁用时，child 才暴露 child-only `RespondToCoordinator`。Explore runtime 会在最终
  allowlist 求交后补回这个 child control tool；Plan mode 通过显式 capability 放行，不把 session
  mutation 伪装成 read-only。
- `RespondToCoordinator` 只把回复排入 parent runtime command queue，不结束 child 当前任务；enqueue
  success 不表示 parent 已经读取、持久化或回复。
- response command 被 parent drain 后，完整 `<summary>` / `<message>` carrier 以 source
  `subagent_message`、visibility `model-only` 写入 parent model history 和 session store。它不进入用户
  可见消息、session title 或 `ReadSessionContext`，但原始 session 导出、诊断、存储预算和 compact
  必须按可能包含该内容处理。
- synthetic user message source `subagent_message` 不是 `SessionEventType.SubagentMessage`
  lifecycle/progress event，也不是 child transcript 镜像。完整契约见
  [Subagent RespondToCoordinator](../../../../../../docs/subagent-respond-to-coordinator.md)。

### SendMessage 与 TaskStop display projection

- 工具 output 和 model content 保持各自 provider-visible 契约；展示层数据通过独立 `ToolResultDisplayPayload` 生成，不得反向修改模型可见结果。
- `local_agent_message` 只包含业务 `status`、可选 `error` 和可选 `message`；`error`、`message` 分别受 4 KiB UTF-8 预算约束。
- `task_stop` 包含 `taskId`、`taskType`、可选 `command`、`message` 和可选 `truncated`；`command`、`message` 分别受 16 KiB UTF-8 预算约束。
- display 从 handler 原始 output 生成，通过 live `tool_call_result.result.display` 下发，并写入 completed tool part 的 versioned metadata，不能混入 hook additional context。
- Desktop/Web 展示规范见 `docs/ui/tool-display-rendering.md`；CLI TUI 的暂缓适配和验收条件记录在 [Tool Change Chain](./00-tool-change-chain.md) 的 `TODO(TUI display parity)`。

## ZCode 设计结论

第一版不建议把 `SubagentTool` 直接写成一个巨型工具。应拆成一组稳定接口：

- `SubagentTool`：模型可见 schema、权限入口、result serialization。
- `AgentDefinitionRegistry`：加载 built-in/project/user/plugin/policy agents，做覆盖、解析失败报告和 capability filtering。
- `ToolPoolResolver`：按 agent policy、permission mode、async/fork/team 解析可用工具。
- `SubagentContextFactory`：创建隔离的 `ExecutionContext`，负责 trace、abort、read cache、content replacement、app state proxy。
- `AgentRuntime`：执行 query loop，消费 message stream，触发 hooks、skills、MCP cleanup。
- `SubagentTaskService`：管理 foreground/background 状态、progress、kill、auto-background、notification。
- `SessionStorePort`：session messages/parts、session entries、resume hydration。
- `SubagentMessageRouter`：按 agentId/name 投递消息，支持 pending queue 和 stopped resume。
- `WorktreeIsolationPort`：创建、检测变更、清理和恢复 worktree。
- `RemoteAgentPort`：远程 agent eligibility、bundle、launch、status、notification。

最低测试集：

- 省略 `subagent_type` 在 fork off 时选择 `general-purpose`，fork on 时走 fork。
- unknown agent type 和 denied agent type 返回不同结构化错误。
- required MCP pending 后可成功，failed 或无工具时报可操作错误。
- agent tool pool 正确排除 `AskUserQuestion`、`TaskOutput`、递归 `Agent` 等。
- async agent 返回 `async_launched`，完成后产生 task notification。
- running agent 的 `SendMessage` 进入 pending queue，stopped agent 可从持久化 session history resume。
- worktree 无变更自动清理，有变更保留路径和 branch。
- fork 子 agent 继承父 system prompt、tool pool、thinking config，并禁止递归 fork。
- sync agent 可被 background，并继续用同一 task id 完成。
- abort、静默超时、异常、无 assistant message、session history 缺失都有稳定错误；其中 abort
  需要覆盖 child runner/model promise 永不 settle 时，外层 `Agent` 仍能停止等待，静默超时
  需要覆盖 child 没有任何 session event 且 promise 永不 settle 的场景。
- 所有 spawn、tool call、hook、MCP、task state、notification、resume 事件都携带同一个 `traceId`，并记录 parent session/turn/toolCall/span 关系。
