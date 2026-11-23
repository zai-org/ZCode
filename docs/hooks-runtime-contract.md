# Hooks Runtime Contract

> 状态：Implementation Spec
>
> 本文是 ZCode 当前 Hooks 实现、桌面设置页和自动化测试的共同验收依据。

## 目标与边界

本期只支持 ZCode 已存在的 7 个事件：

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`

本期不增加新的 Hook 事件。每个已支持事件都必须形成完整闭环：配置可加载、matcher
语义明确、stdin 与 Claude Code 兼容、stdout 能影响对应运行时行为、失败可观测，并有独立
自动化测试。

持久化 Hook 类型限定为：

- `process`：`command + args[]`，通过 argv 执行，不经过 shell。
- `command`：完整 shell command，兼容 Claude Marketplace 插件。

本期不实现 `prompt`、`agent`、`http`、`callback` 持久化配置，也不实现 `if`、`once`、
`asyncRewake`。这些字段和新增事件不能被 UI 写入，也不能被文档标记为已支持。

## 状态所有权

```text
user config + enabled plugin hooks
  -> executable RuntimeConfig
  -> HookRunner

project/workspace Hook declarations
  -> isolated discovery candidate
  -> immutable bundle/declaration digests
  -> rollout gate + managed policy + Trust admission
  -> admitted project registrations or blocked lifecycle

HooksService / conversation projection
  -> 设置 → 钩子 → 工作区
  -> Runtime-owned review command
  -> atomic Trust mutation / supersede / revoke
```

- Hook 的执行权只在 `apps/zcode-cli` Agent runtime。
- UI 和 `packages/services` 只管理配置和只读来源展示，不执行 Hook。
- 每个 session 启动时捕获 Hook 配置快照。配置修改只保证新 session
  生效；设置页保存后要关闭尚未使用的 deferred draft session，避免下一次首发继续复用旧快照。
- 远程 workspace 的 HooksService 必须来自远端 service collection。`workspacePath` 用于文件
  读写；UI 缓存和并发请求隔离使用 `workspaceIdentity?.trim() || workspacePath`。

## 配置来源与合并

| 来源                           | Runtime 执行 | 设置页编辑 | 生效规则                                               |
| ------------------------------ | ------------ | ---------- | ------------------------------------------------------ |
| `~/.zcode/cli/config.json`     | 是           | 是         | user hooks 先执行                                      |
| workspace `.zcode/config.json` | 条件执行     | 是         | rollout 开启且 exact Trust/policy admission 通过后执行 |
| 已启用插件 hooks               | 是           | 否         | 按现有 plugin 来源规则执行                             |
| `.agents/settings.json`        | 否           | 否         | 只读展示，可显式导入 `.zcode`                          |
| `.claude/settings.json`        | 否           | 否         | 只读展示，可显式导入 `.zcode`                          |

配置合并约束：

1. runtime executable config 只直接合并 user 与已启用插件 hooks；workspace project hooks 保留在隔离的
   immutable snapshot side-channel。未 admission 前不得创建可执行 callback；发现诊断统一使用
   `config_project_hooks_pending_trust`，Runtime blocked reason 进一步区分 pending、feature-disabled、policy、
   store failure 与 snapshot mismatch。
2. 单个受信配置来源的 `hooks.enabled:false` 只禁用该来源内的 hooks，不能关闭其他来源。
3. 插件 hooks 只在插件启用时注入 runtime；插件关闭后新 session 不再执行。
4. 每个 `process` / `command` 支持 `enabled?: boolean`，缺省为 `true`。Runner 必须跳过
   `enabled:false`，不能只在 UI 中隐藏或变灰。
5. UI 只把 `.zcode` hooks 写回原 user/project 文件，不修改 plugin、`.agents` 或 `.claude` 文件。
6. 单条 Hook 的未知扩展字段必须在设置服务中往返保留，并由 Agent 配置 schema 接受；runtime
   可以忽略当前版本不识别的字段，不能因此让整个配置文件失效。

示例：

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["scripts/check-write.mjs"],
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

## Matcher 契约

Matcher 规则：

- 缺省、空字符串和 `*`：match all。
- 只包含字母、数字、下划线和 `|`：按精确名称或精确名称列表匹配。
- 其他字符串：按 JavaScript 正则匹配；非法正则不执行该 matcher，并记录诊断。
- tool 事件匹配 `tool_name`，同时兼容 `Agent` / `Task` 等 ZCode alias。
- `SessionStart` 匹配 `source`。
- `UserPromptSubmit` 和 `Stop` 没有 matcher query；即使配置带 matcher，也执行该组 hooks。

## Claude 兼容 stdin

所有 Hook stdin 都是单行 JSON 加换行，同时保留 ZCode camelCase 字段和 Claude Code
snake_case 字段。

基础字段：

- `session_id`
- `transcript_path`
- `cwd`
- `permission_mode`
- `hook_event_name`
- `agent_type`（存在时）

事件字段：

| Event                | 必需的 Claude 兼容字段                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `SessionStart`       | `source`，可选 `agent_type`、`model`                                     |
| `UserPromptSubmit`   | `prompt`                                                                 |
| `PreToolUse`         | `tool_name`、`tool_input`、`tool_use_id`                                 |
| `PermissionRequest`  | `tool_name`、`tool_input`、可选 `permission_suggestions`                 |
| `PostToolUse`        | `tool_name`、`tool_input`、`tool_use_id`、完整 `tool_response`           |
| `PostToolUseFailure` | `tool_name`、`tool_input`、`tool_use_id`、字符串 `error`、`is_interrupt` |
| `Stop`               | `stop_hook_active`、`last_assistant_message`                             |

`PostToolUse.tool_response` 使用工具 handler 的完整结构化输出；`toolResultPreview` 继续作为
ZCode 扩展字段保留，但不能替代 `tool_response`。

`PostToolUse` 和 `PostToolUseFailure` 每次工具调用一般只运行一个（Hook 运行之后的步骤抛错时，
会再运行一次 `PostToolUseFailure`）。工具结果是错误结果时运行
`PostToolUseFailure`，判定与 tool_result 的 `is_error` 相同：Bash 按命令语义的非零退出、超时、
取消，MCP 返回 `isError: true`。这时字符串 `error` 是模型看到的 tool_result 正文，
`is_interrupt` 为 `false`，没有 `tool_response`。grep、rg 等退出 1 不算错误。详见
`apps/zcode-cli/docs/design/v2/hooks.md`「失败的定义」。

ZCode 当前没有 Claude JSONL transcript 文件，因此 configured runner 为每次 Hook 创建临时
兼容 transcript：Stop 至少包含最后一条 assistant message，其他事件至少提供存在且可读的
JSONL 文件。Hook 完成后清理临时目录。

## stdout、退出码与事件效果

stdout 规则：

- 空 stdout：成功，无额外效果。
- 非 JSON stdout：成功，只作为诊断，不注入模型上下文。
- 以 `{` 开头的合法 JSON：校验已知字段并消费。
- 未知 JSON 字段忽略，不能导致整个 Hook 失败。
- 已知字段类型错误或 `hookSpecificOutput.hookEventName` 错误：该 Hook 失败；失败与其他 Hook 隔离。

退出码规则：

- `0`：成功并解析 stdout。
- `2`：请求阻断；对可阻断事件产生对应 block/deny，Stop 产生继续一轮反馈。
- 其他非零：可恢复 Hook 失败，不让整个 turn 崩溃。

`PreToolUse` 拒绝时模型看到的文字（tool_result 正文，不加 `<tool_use_error>`，2026-11-14）：

- JSON deny 带 `permissionDecisionReason`：原样使用。
- JSON deny 或 `continue:false` 没有理由：`Hook PreToolUse:<Tool> denied this tool`（原来是 `Blocked by PreToolUse hook`）。
- 退出码 `2`：`PreToolUse:<Tool> hook error: [command hidden]: <stderr>`；stderr 为空时写 `No stderr output`，不再用 stdout；
  插件 Hook 再加一行 `This hook comes from the <插件名> plugin.`。方括号里固定写 `command hidden`，不写 Hook 命令：
  命令可能带凭据（例如 `curl -u user:pass`、`mysql -p<密码>`、Cookie 头），而这段文字会进入模型上下文、会话持久化和之后
  每次 provider 请求。不能改回写脱敏后的命令：脱敏是黑名单，规则没有覆盖的写法会原样外发。占位词用中性的
  `command hidden`，不写“出于安全”之类的理由，以免模型去读 Hook 配置找原命令。
  stderr 去掉首尾空白，超过 4000 字符截断并加 `...`。退出码 2 时不解析 stdout，所以这段文字就是这次拒绝的理由。
- Hooks 明细的 `blockReason` 不变：仍是 stderr 预览（为空时 stdout 预览，再为空时 `Hook blocked execution`），
  不显示命令。

`updatedInput` 不符合 tool schema 时的文字见根目录 `docs/model-tool-call-validation.md`。

Hook 自身失败时的处置（单条 Hook 的 `onError` 字段，`process` 与 `command` 都可写）：

- `allow`（缺省）：放行，工具照常执行，失败只记 `HookRunFailed` 事件与 warn 日志。
- `deny`：只对 `PreToolUse` 生效。其他非零退出、超时、已知字段类型错误都等同于退出码 `2`：
  工具调用被拒，终态事件是 `HookRunBlocked`，`blockReason` 写明是 Hook 失败触发的拦截，
  `errorMessage` 保留原始失败。已信任的工作区 Hook 在派发前复核时发现入口脚本不可用（脚本被删、不可读、
  内容变化、复核超时）也算失败。用户中断不算失败；未受信任或被撤销而没有运行的工作区 Hook、
  会话开始时入口脚本已不可用的工作区 Hook、`async: true` 的 Hook 与其他事件不受影响。
- 工作区 Hook 的 `onError: "deny"` 进声明摘要：加上或去掉它都要重新信任；不写或写 `allow`
  的声明摘要不变。

放行也留痕：用户、项目、插件配置的 `PreToolUse` Hook 每放行一次工具调用，记一条 info 日志
`hook.run.allowed`（含 source、sourceKind、toolName、toolCallId、耗时）。内置 Hook 不记。

事件输出效果：

| Event                | 可阻断           | 可修改                                       | 模型可见上下文                                   |
| -------------------- | ---------------- | -------------------------------------------- | ------------------------------------------------ |
| `SessionStart`       | 否               | 否                                           | `additionalContext` 注入首轮前                   |
| `UserPromptSubmit`   | 是               | 不修改原 prompt                              | `additionalContext` 注入本轮前                   |
| `PreToolUse`         | 是               | `updatedInput`，并重新做 tool schema 校验    | 成功、失败都在工具批次后附上 `additionalContext` |
| `PermissionRequest`  | 是               | allow 时可返回 `updatedInput` 和 permissions | 否                                               |
| `PostToolUse`        | 否               | 本期不替换 tool output                       | 工具批次后附上 `additionalContext`               |
| `PostToolUseFailure` | 否               | 否                                           | 工具批次后附上 recovery `additionalContext`      |
| `Stop`               | 是，表示不要结束 | 否                                           | block reason/context 注入下一轮，最多连续 3 次   |

兼容字段：

- 顶层 `decision:"approve"|"block"`。
- 顶层 `continue:false` 在 `UserPromptSubmit`、`PreToolUse`、`PermissionRequest` 中阻断。
- Stop 使用 `decision:"block"`；为兼容已发布的 ZCode 配置，`continue:true` 且带
  `additionalContext` 也可继续一轮。
- `PermissionRequest` 同时接受 Claude 的 `updatedPermissions` 和 ZCode 历史字段
  `permissionUpdates`。
- `suppressOutput:true` 表示不投影 Hook stdout；它不抑制结构化 decision/context。

`PreToolUse` 的失败结果包括 Hook 自身 deny、后续权限拒绝和工具 handler 失败；这些提前返回路径
也必须保留已产生的 `additionalContext`，不能只在 handler 成功或抛错路径追加。

工具 Hook 的 `additionalContext` 不进 tool result：每条写成
`<Event>:<ToolName> hook additional context: <context>`，作为这批 tool result 之后的
`tool_hook_context` 附件，按 tool result 顺序分组，同一工具 Pre 在前，多个 Hook 不合并。
tool result 只放工具原文。MCS 下与同批附件合成同一条 system；非 MCS 下按普通 user 侧提醒投影
（Anthropic Messages 协议并入这批最后一个 tool result）。附件随历史持久化；App 工具卡不显示 Hook 文本。

## async 契约

`command` hook 支持 `async:true`：

1. Agent 启动命令后立即继续当前事件，不等待命令退出。
2. async stdout 不能 block、修改输入或注入 context；这些输出被忽略。
3. 后台命令仍受 timeout 和调用方 cancellation 管理；调用方取消后必须终止命令，并产生
   `outcome: "cancelled"` 的 Hook lifecycle event。
4. 后台 Promise 必须捕获错误，不能产生 unhandled rejection。

`process` hook 本期保持同步。`asyncRewake` 不在本期能力声明中。

## 设置页契约

Hooks 设置页必须在 desktop 和 Web UI 使用同一组件，并满足：

- `.zcode` hooks 支持新增、编辑、删除、启停和 user/workspace scope。
- 表单支持 7 个事件、`process` / `command` 类型、matcher、argv、timeout、`statusMessage`
  和 command async。
- `.agents` / `.claude` hooks 标记为兼容来源、不可直接编辑或启停，并提供显式导入 `.zcode`。
- 插件 hooks 单独分组；列表只读展示 event 与 command，并以分组标题和插件图标表达来源。
  matcher、type、source path 与 effective enabled 状态保留为数据事实，不在列表行重复堆叠。
- 插件 Hook 的 User / Workspace 分栏只使用 overview 安装记录中的权威 scope。overview
  降级或安装记录缺失时必须保留 `unknown`，不得默认为 User；未知 scope 的 Hook 在两个
  Tab 中均保持可见并显示“作用域未知”标签，避免伪造来源或静默丢失数据。
- 插件 Hook 的启停跟随插件设置，不在 Hooks 页创建第二套 override。
- 页面文案支持 `zh-CN` / `en-US`，使用语义颜色和现有控件；窄屏下内容和操作不能重叠。
- 页面明确提示：修改应用于新 session。
- 页面遵循 MCP、Skills、Commands 设置页的统一信息架构：顶部使用共享 Scope 菜单、当前
  Scope 的 Hook 总数与搜索入口；当前 Scope 下按 `Installed`、具体插件、`Legacy` 分组。
- 搜索后只展示存在匹配 Hook 的分组；无结果时展示统一空状态，不保留计数为 0 的分组标题。
- 组内使用单个圆角 surface 列表容器和元素分割线。Hook Item 以 Event 为主标题，command
  使用 `font-mono text-ui-sm`；直接配置显示开关并可整行进入编辑，插件 Hook 只读且使用插件
  图标，兼容来源显示 Import。
- 从当前 Scope 新建 Hook 时，表单默认选择相同 scope；表单复用 `PluginScopeMenu`。
  编辑已有 Hook 时 Scope 不可迁移。没有可用 workspace 时菜单只提供 User。
- 新增/编辑页复用资源设置页的返回链接、标题和说明层级；desktop 与手机 Web 使用相同的
  响应式布局。
- HooksSection 必须接收并透传 `workspaceIdentity`，远程工作区的读取、写入和 session
  invalidation 以 `workspaceIdentity?.trim() || workspacePath` 隔离。

## 验收矩阵

| ID    | Event                | 证明点                                                                            | 自动化层                 |
| ----- | -------------------- | --------------------------------------------------------------------------------- | ------------------------ |
| HK-01 | `SessionStart`       | startup matcher、snake_case stdin、首轮 context                                   | core + desktop E2E       |
| HK-02 | `UserPromptSubmit`   | prompt stdin、matcher 不过滤、block/context                                       | core + desktop E2E       |
| HK-03 | `PreToolUse`         | tool matcher、deny/ask/allow、updatedInput、context；三个提前失败出口不丢 context | core + desktop E2E       |
| HK-04 | `PermissionRequest`  | 仅 ask 路径触发、allow/deny/modify、permission updates                            | core + desktop E2E       |
| HK-05 | `PostToolUse`        | 完整 `tool_response`、context                                                     | core + desktop E2E       |
| HK-06 | `PostToolUseFailure` | 字符串 error、interrupt、recovery context                                         | core + desktop E2E       |
| HK-07 | `Stop`               | last assistant、transcript、block 续跑上限                                        | core + desktop E2E       |
| HK-08 | Config/source        | user+project+plugin 顺序、逐 Hook disabled 真跳过                                 | adapter/bootstrap/core   |
| HK-09 | Settings             | `.zcode` 可写、legacy 可导入、plugin 只读可见                                     | service/UI + desktop E2E |
| HK-10 | Executors/async      | process argv、command shell/fire-and-forget、父级取消、后台 lifecycle、错误隔离   | core + desktop E2E       |

完整窗口级 suite 使用 `HK-LC-01`、`HK-EF-01`、`HK-ST-01`、`HK-UP-01`，定义在
`docs/testing/hooks-e2e-coverage-matrix.md`。其中父级取消保留在 core 的确定性 AbortSignal
测试；窗口级验证 async command 真实启动/完成且其 stdout 决策不会反向改变已继续的事件。
