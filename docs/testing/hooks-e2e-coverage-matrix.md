# Hooks E2E Coverage Matrix

## Feature Summary

| Field                 | Value                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Change                | 让现有 7 个 Hooks 事件形成可配置、可执行、可观测、可回归的完整生命周期                                   |
| User-visible surfaces | Settings > Hooks；conversation runtime；plugin hook 只读来源                                             |
| Existing docs         | `docs/hooks-runtime-contract.md`、`docs/hooks-implementation-analysis.md`、`docs/plugin-hooks-compat.md` |
| Existing owners       | Agent HookRunner/configured runner；HooksService；HooksSection；plugin protocol                          |
| Out of scope          | 新事件；prompt/agent/http；`if`、`once`、`asyncRewake`；legacy 隐式执行                                  |

## Clarification Log

| Round | Question                               | User answer                                                                                 | Boundary fixed                                   | Follow-up needed |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------- |
| 1     | 本期是否扩展到全部 hook 事件类型       | “目前只支持这 7 个已有的 hook”                                                              | 只覆盖 7 个现有事件                              | no               |
| 1     | 是否逐事件验证并增加整体 E2E lifecycle | “确保这 7 个 hook 都是能用的，挨个测试，对 hook 整体的能力添加一个 e2e case lifecycle 测试” | 7 条 focused contract case + 1 条窗口级组合 case | no               |
| 0     | 设置页和来源如何处理                   | 按已确认方案实施                                                                            | `.zcode` 可编辑，plugin 只读，legacy 显式导入    | no               |

## Domain Scope

| Domain                   | Include?            | Reason                                                            | Primary sources                                               |
| ------------------------ | ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Agent runtime/config     | yes                 | 决定 Hook 是否真实执行和影响 turn/tool                            | `apps/zcode-cli/packages/{contracts,core,adapters,bootstrap}` |
| Permission/tool          | yes                 | 4 个 tool 事件横跨校验、permission、success/failure               | `apps/zcode-cli/packages/core/src/tool/executor`              |
| Conversation/session     | yes                 | SessionStart、UserPromptSubmit、Stop 位于 turn lifecycle          | `apps/zcode-cli/packages/core/src/runtime`                    |
| Settings UI/source       | yes                 | 用户需要配置 `.zcode` 并查看 plugin hooks                         | `packages/{services,ui}`                                      |
| Mobile remote/replayable | representative only | Hook 在共享 Agent runtime 执行，不改变 stream/snapshot/queue 语义 | 架构 invariant                                                |

## State Owners

| State / fact              | Authority                            | Mirrors / caches         | Evidence                              |
| ------------------------- | ------------------------------------ | ------------------------ | ------------------------------------- |
| 当前 session 的 Hook 配置 | Agent runtime snapshot               | Settings UI 文件视图     | runtime Hook events、Hook trace file  |
| `.zcode` Hook 配置        | user config file；project 只展示编辑 | hooksStore               | 文件 round-trip、service/runtime test |
| plugin Hook 生效状态      | Agent plugin resolver                | pluginManagementStore    | `plugins/list` payload、runtime trace |
| Hook 执行结果             | HookRunner + event-specific consumer | session event projection | tool result/model request/trace file  |

## Dimensions And Pruning

| Dimension      | Values                     | Decision                                                       | Reason                            |
| -------------- | -------------------------- | -------------------------------------------------------------- | --------------------------------- |
| Event          | 7 existing events          | accepted all                                                   | 用户明确要求逐个可用              |
| Hook source    | user/project/plugin/legacy | user+plugin runtime；project/legacy 不执行                     | 防止 workspace 任意命令静默执行   |
| Hook type      | process/command            | accepted                                                       | 当前 runtime 已有类型             |
| Execution mode | process/command sync/async | E2E 分别走真实 argv、shell 和 fire-and-forget 路径             | 执行器能力必须有窗口级证据        |
| Client         | desktop/mobile Web         | E2E 代表 desktop-continuous；共享 UI 做响应式/类型测试         | 不改变 mobile replayable 业务状态 |
| Platform       | macOS/Linux/Windows        | argv/shell 由 ExecutionPort 单测；macOS 与 Linux Docker 跑 E2E | 仍不能证明 Windows                |
| Provider       | case-local DeepSeek replay | accepted representative                                        | Hook 语义与 provider 无关         |

剪枝：

- 不把 7 个事件与所有 tool 名、mode、provider、theme、locale 做笛卡尔积。
- E2E 使用一个 Node recorder：`process` 覆盖 7 事件，`command` 同步/异步分别代表 shell 与
  fire-and-forget 路径；不扩展为 7 事件 x 3 执行模式的重复组合。
- `PreToolUse` 和 `PermissionRequest` 使用需要审批的成功工具；`PostToolUseFailure` 使用确定失败工具。
- plugin 展示和 legacy 导入由设置页/service focused tests 证明；整体 lifecycle E2E 聚焦 runtime 闭环。
- 手机 Web 复用同一 HooksSection 和 Agent runtime，不新增独立 runtime，也不改变
  `desktop-continuous` / `web-remote-replayable` 边界。

## Accepted Cases

| Case ID  | Setup                                                                                           | Action                      | Assertions                                                                                          | Evidence                                                     | Status  |
| -------- | ----------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| HK-01    | SessionStart process hook                                                                       | 创建新 session 并首发       | hook 只运行一次；source/stdin/context 正确                                                          | `hooks-seven-events.test.ts`、`runtime-hooks.test.ts`        | covered |
| HK-02    | UserPromptSubmit process hook                                                                   | 提交 prompt                 | prompt 字段正确；block/context 生效                                                                 | `hooks-seven-events.test.ts`、`runtime-hooks.test.ts`        | covered |
| HK-03    | PreToolUse process hook                                                                         | 模型调用 tool               | matcher、updatedInput/deny/context 生效；deny 提前返回仍保留 context                                | `hooks-seven-events.test.ts`、`tool-executor-trace.test.ts`  | covered |
| HK-04    | PermissionRequest process hook                                                                  | ask permission tool         | hook allow/deny/modify 替代 broker                                                                  | `hooks-seven-events.test.ts`、`tool-executor-trace.test.ts`  | covered |
| HK-05    | PostToolUse process hook                                                                        | tool 成功                   | `tool_response` 是完整输出；context 进入下一请求                                                    | `hooks-seven-events.test.ts`、`tool-executor-trace.test.ts`  | covered |
| HK-06    | PostToolUseFailure process hook                                                                 | tool 抛错                   | string error/is_interrupt；recovery context 生效                                                    | `hooks-seven-events.test.ts`                                 | covered |
| HK-07    | Stop process hook                                                                               | final assistant 即将结束    | transcript/last message 正确；block 可续跑且最多连续 3 次                                           | `hooks-seven-events.test.ts`、`runtime-hooks.test.ts`        | covered |
| HK-LC-01 | 隔离 user 配置 7 事件 process hooks，加同步/异步 command；provider 固定修改、审批、成功、失败链 | 从 UI 首发并等待最终 marker | 7 事件、三种执行模式、兼容 stdin、Pre/Permission 两级输入修改、allow、成功/失败 context 和最终 idle | desktop UI + runtime file + isolated/default replay requests | covered |
| HK-EF-01 | PreToolUse 按输入依次 deny、返回非法 updatedInput、要求 PermissionRequest deny                  | provider 连续触发三个 Write | handler 均未执行；每个提前失败的 Pre context 附在批次后；PermissionRequest 只在 ask 路径触发        | desktop runtime file + provider-visible tool results         | covered |
| HK-ST-01 | Stop 每次 block；fixture 仅提供初始响应和三次续跑响应                                           | 发送 Stop cap marker        | Stop 执行 4 次但只续跑 3 次；第 4 个 context 不进入新请求；最终响应和 idle 正确                     | request count + trace + desktop UI                           | covered |
| HK-UP-01 | 同一 UserPromptSubmit 上配置同步 process block 和异步 command block                             | 发送 prompt block marker    | 同步 block 在模型前结束；异步 command 启动/完成但输出不改变当前边界                                 | zero main request + trace + desktop UI                       | covered |

补充回归边界：

- `command async:true` 必须立即返回、忽略后台决策，并在调用方取消时终止执行且记录
  `outcome: "cancelled"`。
- `PermissionRequest` 分别验证 deny 与 allow + `updatedInput`/`updatedPermissions` 映射。
- 插件显式关闭后 runtime hooks 为空；插件详情仍保留在 `plugins/list`，供设置页只读展示关闭态。

## Full-chain Hooks Suite

正式 spec：

`packages/desktop/test/e2e/conversation-session/hooks/conversation-session-hooks-lifecycle.test.ts`

Case-local artifacts：

- Provider fixture：
  `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-hooks-lifecycle.json`
- Manifest：
  `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-hooks-lifecycle.json`
- File fixture：WDIO 在隔离 HOME 的 user `~/.zcode/cli/config.json` 写 hooks；spec 在默认
  workspace 写 Node recorder/trace，完成后恢复 user config 并删除 workspace 产物。
- Timing：`fast-text`。Hook 运行和文件断言不依赖 SSE cadence。

本 suite 的 setup/action/assert：

1. Setup：7 个事件都指向同一个 `process` recorder；SessionStart/UserPromptSubmit 另挂同步和
   异步 `command`。recorder 把兼容 stdin、executor、phase 和 transcript 可读内容追加到 trace。
2. Action：依次运行 full-chain、early-failure、Stop cap 和 prompt block 四个新 session。
3. Assert：
   - 设置页 Hooks 导航可达，7 个已配置事件都渲染为配置行。
   - process trace 中 7 个事件全部存在；SessionStart/UserPromptSubmit/Stop 各一次。
   - Pre/Permission/Post 成功链共享同一个 tool use；两级修改后的最终输入进入 handler，
     PostToolUse 有完整 `tool_response`。
   - 失败链产生 PostToolUseFailure，error 是字符串，recovery context 进入下一请求。
   - Pre deny、非法 updatedInput、Permission deny 三个 handler 前失败出口都保留 context。
   - Stop 最多连续续跑三次；第 4 次仍执行 Hook 但不会发起第 5 个 provider request。
   - 同步 command 真正经 shell 执行；异步 command 完成后输出不改变已继续的事件。
   - 每个 case 最终 UI 回到 idle；需要模型的 case 显示最终 marker。

## Lifecycle Decision

- `manual-review/pending`：不使用。7 个事件及其效果已由用户明确确认，直接编写正式
  deterministic replay case。
- `e2e:promote`：不使用；case 不是待人工判定的 live probe。
- `e2e:fixture:check`：必跑。
- isolated case-local replay：必跑，证明不依赖 legacy shared provider fixture。
- default replay：必跑。
- Docker：先做单 spec replay-isolated 证明；只有通过后才可用 `e2e:docker:admit` 加入
  conversation preset。
- 收尾门禁：`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint`。

## Verification Record

2026-07-13 full-chain suite：

- `e2e:fixture:check`：通过，case-local fixture 共 15 条。
- isolated case-local replay：4 cases / 4 passing；artifact
  `desktop-e2e-20260713-110936-723`。
- default replay：4 cases / 4 passing；artifact `desktop-e2e-20260713-111026-804`。
- Docker 单 spec replay-isolated：Linux/amd64 断网容器中 4 cases / 4 passing；artifact
  `desktop-e2e-20260713-111159-34015`。
- focused core：3 files / 64 tests，覆盖七事件合同、runtime Stop 上限、工具执行 trace、
  Permission/updatedInput/提前失败 context。
- settings/service：2 files / 10 tests，覆盖保存、启停、workspace identity、兼容导入、plugin
  分组展示和 command async/shell 往返。
- 静态门禁：`typecheck:e2e`、根级 `pnpm typecheck`、`pnpm lint` 均通过；lint 为 0 error。

以下是扩展 full-chain suite 前的历史基线，不作为 HK-EF-01、HK-ST-01、HK-UP-01 的完成证据；
新增 case 必须在实现后追加独立 replay 记录。

- `e2e:fixture:check`：通过。
- isolated case-local replay：通过，1 case / 1 assertion group；artifact
  `desktop-e2e-20260710-061853-992`。
- default replay：通过，manifest 自动解析 common + case-local fixture；artifact
  `desktop-e2e-20260710-061945-862`。
- Docker 单 spec replay-isolated：通过，Linux/amd64 断网容器中 1 case / 1 passing；artifact
  `desktop-e2e-20260710-062035-75778`。
- focused core：4 files / 62 tests，覆盖 7 事件参数化合同、matcher、禁用、诊断 stdout、async 取消、
  PermissionRequest deny/modify、PreToolUse deny context 和 Stop 连续续跑上限。
- settings/service：4 files / 23 tests，覆盖持久化 toggle、来源保真、`statusMessage` 编辑、
  legacy 导入和 plugin 只读展示。
- 三次 WDIO 在测试完成后的 Electron teardown 都出现 ContextId 已销毁 warning；退出码仍为 0，
  Hook lifecycle 断言已全部完成，该 warning 记录为 E2E harness 清理问题，不计作 Hook 失败。
