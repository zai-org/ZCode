# ZCode Hooks 实现现状

> 文档目的：供后续同学快速理解 ZCode hooks 的分层架构、已支持能力，以及已知缺口与演进方向。
>
> 更新时间：2026-07-10
> 相关规范：`docs/plugin-hooks-compat.md`、`apps/zcode-cli/docs/design/v2/hooks.md`

---

## 1. 架构分层（必读）

ZCode hooks **不是单一模块**，分两层，行为可能不一致：

| 层级               | 路径                                                                                                     | 职责                                      | 实际执行？                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------ |
| **UI / 设置层**    | `packages/services/src/hooks/hooksService.ts`<br>`packages/ui/src/store/hooksStore.ts`                   | 读取、展示、编辑并写入 runtime hooks 配置 | 通过 `.zcode/config.json` 生效 |
| **CLI Runtime 层** | `apps/zcode-cli/packages/core/src/hooks/`<br>`apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts` | agent loop 中触发、执行、聚合决策         | **是**                         |

**重要结论**：UI 层能读到 `.claude/settings.json` / `.agents/settings.json` 里的 legacy hooks，但 **runtime 不会自动执行** 这些配置；只有写入 `.zcode/config.json` 或通过**已启用插件**注入的 hooks 才会在会话中运行。

---

## 2. Runtime 支持的事件（7 个）

定义：`apps/zcode-cli/packages/contracts/src/hooks/index.ts`

| Event                | 触发点                                        | 可阻断                         | 主要代码入口                                         |
| -------------------- | --------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `SessionStart`       | session 创建/resume 后、首轮 prompt 前        | 否（P0 忽略 `continue:false`） | `runtime/methods/hooks.ts` → `turn.ts` / `resume.ts` |
| `UserPromptSubmit`   | 用户输入进入 turn、写入 message history 前    | 是                             | `runtime/methods/turn.ts`                            |
| `PreToolUse`         | tool input schema 校验后、permission check 前 | 是                             | `tool/executor/hook-flow.ts`                         |
| `PermissionRequest`  | permission 返回 `ask`、broker UI 前           | 是                             | `tool/executor/hook-flow.ts`                         |
| `PostToolUse`        | tool 成功后、结果序列化给模型前               | 否                             | `tool/executor/hook-flow.ts`                         |
| `PostToolUseFailure` | tool 失败后                                   | 否                             | `tool/executor/hook-flow.ts`                         |
| `Stop`               | turn 即将 complete 前                         | 是（可续跑，上限 3 次）        | `runtime/methods/turn-stop.ts`                       |

`SessionStart` 的 `source` matcher 值：`startup | resume | fork | clear | compact`（分叉会话在第一条输入之前打开时用 `fork`）。

---

## 3. Hook 类型

| 类型                    | Runtime 支持  | 说明                                                                       |
| ----------------------- | ------------- | -------------------------------------------------------------------------- |
| `process`               | ✅            | argv 形式：`command` + `args[]`，经 `ExecutionPort` 执行，**不默认 shell** |
| `command`               | ✅            | shell 字符串，为兼容 Claude 插件（如 superpowers `run-hook.cmd`）          |
| `prompt`                | ❌            | LLM 评估型 hook                                                            |
| `agent`                 | ❌            | Agentic verifier hook                                                      |
| `http`                  | ❌            | HTTP POST hook                                                             |
| `callback` / `function` | ⚠️ 仅测试/SDK | `InMemoryHookRunner` 内存回调，非用户配置持久化形态                        |

实现入口：`apps/zcode-cli/packages/core/src/hooks/configured-runner.ts`

---

## 4. 配置来源与合并顺序

### 4.1 Runtime 生效配置

1. **用户级**：`~/.zcode/cli/config.json` → `hooks` 字段
2. **项目级**：`<workspace>/.zcode/config.json` → `hooks` 字段
3. **插件级**：已启用插件的 `hooks/hooks.json` 或 manifest `hooks` 字段

合并逻辑：`apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` 的 `mergeRuntimeHooks()`  
→ 用户/项目 hooks 在前，**插件 hooks 追加在后**。

插件发现规范见 `docs/plugin-hooks-compat.md`：

- manifest 优先级：`.zcode-plugin` > `.claude-plugin` > `.codex-plugin`
- 标准路径 `hooks/hooks.json` 自动加载
- 未知 event 记 warning，不阻断插件加载

### 4.2 设置页来源与写回

`hooksService.loadHooks()` 按顺序读取：

```
project: .zcode → .agents → .claude
user:    .zcode → .agents → .claude
```

来源行为：

- ZCode 原生：`process` / `command` 都可编辑、逐条启停，user/project 分别写回对应
  `.zcode/config.json`。
- Legacy Claude/Agents：以 import-only、disabled 状态展示；一键导入会复制为同 scope 的 ZCode
  hook，绝不静默执行或回写 legacy 文件。
- 插件：设置页从 plugin runtime catalog 只读展示插件名、事件、matcher、命令和插件启用状态；
  启停入口仍归插件管理页。

修改 Hook 会废弃尚未启动的 draft session；正在运行或已有历史的 session 保持配置快照语义。

---

## 5. 执行模型

```text
Hook 触发
  → InMemoryHookRunner.run()
    → matcher 正则匹配（无 matcher = 全匹配）
    → 串行执行匹配的 hooks
      → stdin: HookInput JSON（camelCase + Claude snake_case 兼容字段）
      → ExecutionPort: process(argv) 或 command(shell)
      → stdout: 解析为 HookJSONOutput
      → processHookOutput() 聚合决策
  → 注入 additionalContext / 阻断 / 修改 tool input
```

### 5.1 Matcher 匹配字段

| Event                                                                     | `matchValue`                          |
| ------------------------------------------------------------------------- | ------------------------------------- |
| `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` | `toolName`                            |
| `UserPromptSubmit`                                                        | 无 query；执行该事件下全部 matcher 组 |
| `SessionStart`                                                            | `source`                              |
| `Stop`                                                                    | 无 query；执行该事件下全部 matcher 组 |

实现：`apps/zcode-cli/packages/core/src/hooks/output.ts` → `matchesHookMatcher()`。简单
`A|B` 使用精确选项匹配，`*` 全匹配，其他字符串按正则处理；工具名同时支持兼容 alias。

### 5.2 stdin / stdout 契约

- **stdin**：结构化 `HookInput`；工具事件保留 `toolName` / `toolInput` / `toolCallId`，并补齐 Claude 兼容 alias `tool_name` / `tool_input` / `tool_use_id`；所有事件带临时 `transcript_path` / `transcriptPath`；`PostToolUse` 带完整 `tool_response`，失败事件的 `error` 固定为字符串并带 `is_interrupt`
- **stdout**：空输出或非 JSON 文本作为成功 diagnostic；JSON 输出校验已知字段，未知字段忽略
- **exit code 0**：正常，解析 stdout
- **exit code 2**：阻断（PreToolUse / PermissionRequest / UserPromptSubmit；Stop 的 continue 语义另算）
- **其他 exit code**：非阻断错误，记 diagnostic；`PreToolUse` Hook 配了 `onError: "deny"` 时按 exit code 2 拦截（见 `docs/hooks-runtime-contract.md`「stdout、退出码与事件效果」）

Claude 兼容输入投影集中在 `configured-runner-input.ts`，避免不同事件分别拼接后产生字段漂移。

### 5.3 环境变量与模板替换

子进程注入（节选）：

- `ZCODE_SESSION_ID` / `CLAUDE_SESSION_ID` / `CLAUDE_CODE_SESSION_ID`
- `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR`
- 插件：`ZCODE_PLUGIN_ROOT`、`ZCODE_PLUGIN_DATA`、`ZCODE_PLUGIN_ID`、`ZCODE_PLUGIN_NAME`
- 兼容：`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`

命令字符串支持 `${ZCODE_PLUGIN_ROOT}` 等模板替换；`${CLAUDE_SKILL_DIR}` / `${ZCODE_SKILL_DIR}` 无 skill 上下文时会显式报错。

### 5.4 决策聚合

优先级：**deny/block > ask > allow > passthrough**

- 多个 `updatedInput`：按执行顺序，**最后一个有效完整替代 input** 生效
- 多个 `additionalContext`：按顺序拼接，受预算限制（lifecycle 注入上限约 24k chars）
- `Stop` 续跑：最多连续 3 次（`MAX_STOP_HOOK_CONTINUATIONS`）

### 5.5 可观测性

Session events（`HookRunStarted` / `Completed` / `Failed` / `Blocked`）经 `InMemoryHookRunner` 发出。  
Lifecycle additional context 以 `hook_context` attachment 注入 message history。
`command.async:true` 以 fire-and-forget 执行，当前 turn 不等待其输出；完成或失败仍发出 lifecycle event。

---

## 6. Hook 输出能力（ZCode 已支持）

### 6.1 通用字段

- `continue`、`reason` / `stopReason`
- `additionalContext`、`additional_context`（snake_case 别名归一化）
- `suppressOutput`、`systemMessage`
- `hookSpecificOutput`（按 `hookEventName` 分支）

### 6.2 事件专属

| Event                                | 输出能力                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `PreToolUse`                         | `permissionDecision`（allow/ask/deny）、`permissionDecisionReason`、`updatedInput`、`additionalContext` |
| `PermissionRequest`                  | `decision.behavior`（allow/deny）、`updatedInput`、`permissionUpdates`                                  |
| `UserPromptSubmit`                   | `additionalContext`；`continue:false` 阻断 prompt                                                       |
| `SessionStart`                       | `additionalContext`                                                                                     |
| `PostToolUse` / `PostToolUseFailure` | `additionalContext`                                                                                     |
| `Stop`                               | `additionalContext`；`continue:true` + context 续跑；兼容 `decision:"block"`                            |

### 6.3 尚未支持的输出字段

- `updatedMCPToolOutput`
- `initialUserMessage`
- `watchPaths`（FileChanged / CwdChanged 联动）
- `WorktreeCreate.worktreePath`
- Elicitation 相关 `action` / `content`
- `PermissionDenied.retry`

---

## 7. 插件兼容点

为兼容 Claude Marketplace 插件的 hooks，ZCode 覆盖以下方面：

- 核心 7 事件的语义与决策优先级设计目标
- `command` hook + Claude 环境变量 / 路径模板
- `SessionStart` → `additionalContext` → `hook_context` 注入
- `Stop` + `transcript_path` 兼容（ralph-loop 等）
- 插件 `hooks/hooks.json` 发现与合并
- `hookSpecificOutput` 主结构
- exit code 2 阻断语义（tool / permission / prompt 路径）
- 非 JSON stdout diagnostic、未知 JSON 字段忽略
- `PostToolUse.tool_response`、failure string error / `is_interrupt`
- `command.async:true` fire-and-forget

---

## 8. 已知缺口与风险

### 8.1 用户体验边界

设置页明确拆分“已配置 Hooks”“兼容配置”“插件 Hooks”：只有 ZCode 原生配置和已启用
插件进入 runtime；legacy 配置必须由用户显式导入。设置页修改影响新建或尚未启动的 draft，
不会热改正在运行的 session。

### 8.2 功能缺口（按优先级粗排）

| 优先级  | 缺口                                                   | 说明                       |
| ------- | ------------------------------------------------------ | -------------------------- |
| P1 生态 | `PreCompact` / `PostCompact`                           | 与 context compaction 联动 |
| P1 生态 | `SubagentStart` / `SubagentStop`                       | subagent 场景插件依赖      |
| P1 生态 | `SessionEnd`                                           | 清理/上报类 hook           |
| P2      | `prompt` / `agent` / `http` hook 类型                  | 高级 hook 形态             |
| P2      | `asyncRewake` / `once` / `if` 预过滤                   | 性能与安全精细化           |
| P2      | Config snapshot                                        | 防止会话中配置漂移         |
| P3      | Notification / Elicitation / Worktree / FileChanged 等 | 完整事件覆盖               |

设计文档中的 P1 规划见 `apps/zcode-cli/docs/design/v2/hooks.md`。

### 8.3 内部特例

`AgentRuntime` 在启用 session mailbox 时会额外注册内存 hook（`createSessionMailboxHookRegistrations`），属于内部机制，非用户配置 hook。

---

## 9. 关键代码索引

| 模块                   | 路径                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| 事件 / 输入输出 schema | `apps/zcode-cli/packages/contracts/src/hooks/index.ts`                                        |
| Hook runner            | `apps/zcode-cli/packages/core/src/hooks/runner.ts`                                            |
| 配置 → 回调适配        | `apps/zcode-cli/packages/core/src/hooks/configured-runner.ts`                                 |
| 输出解析与聚合         | `apps/zcode-cli/packages/core/src/hooks/output.ts`                                            |
| Lifecycle 触发         | `apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts`                                   |
| Tool 链路触发          | `apps/zcode-cli/packages/core/src/tool/executor/hook-flow.ts`                                 |
| Runtime 配置合并       | `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`                                 |
| 插件 hook 发现         | `apps/zcode-cli/packages/adapters/src/plugins/index.ts`                                       |
| UI 配置读写            | `packages/services/src/hooks/hooksService.ts`                                                 |
| Shared 类型（UI）      | `packages/shared/src/hooks.ts`                                                                |
| 插件兼容规范           | `docs/plugin-hooks-compat.md`                                                                 |
| v2 设计 / 验收         | `apps/zcode-cli/docs/design/v2/hooks.md`                                                      |
| 7 事件合同测试         | `apps/zcode-cli/packages/core/tests/hooks-seven-events.test.ts`                               |
| 整体桌面 E2E           | `packages/desktop/test/e2e/conversation-session/hooks/conversation-session-hooks-lifecycle.test.ts` |

---

## 10. 后续分析建议

1. **Compact / Subagent 事件**：查现有插件与市场依赖，确定 P1 事件最小集。
2. **async rewake**：只有插件确实依赖后台完成后唤醒模型时，再引入 registry/rewake 状态。
3. **安全**：明确 workspace trust 与 project hook 显式启用策略。
4. **测试矩阵扩展**：核心 7 事件已覆盖；后续按新事件与高风险来源增量扩展，不做无收益全叉乘。

---

## 11. 参考测试命令

```bash
# 单元测试（lifecycle + tool hooks）
pnpm --filter @zcode/core test runtime-hooks
pnpm --filter @zcode/core test tool-hook-context

# hooksService + 设置页
pnpm exec vitest run packages/services/test/hooksService.test.ts packages/ui/test/hooksSection.test.ts

# 整体 7 事件桌面 lifecycle
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec './test/e2e/conversation-session/hooks/conversation-session-hooks-lifecycle.test.ts'
```
