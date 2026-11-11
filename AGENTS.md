## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                                      |
| ---------------- | --------------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                          |
| Lint             | `pnpm lint` / `pnpm lint:fix`                             |
| 格式检查         | `pnpm fmt:check`                                          |
| 桌面开发         | `pnpm dev:desktop`                                        |
| Web 开发         | `pnpm dev:web`                                            |
| 提交前检查       | `pnpm verify:pre-push`（工作区、Lint、schema 与架构检查） |
| 架构检查         | `pnpm architecture:check --changed`                       |
| 模块阅读包       | `pnpm architecture:context <module-id>`                   |
| 未使用依赖与导出 | `pnpm knip`                                               |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`                     |

App 业务单测已退役，不新增或恢复 App 业务单测 test/spec 或 `contract.test.ts`；保留 CLI、CUA、E2E、浏览器验收和工程门禁测试。工程 Vitest 使用 `pnpm test:engineering <文件>`，push 自动运行 `pnpm test:engineering:affected --scope push`，CLI/CUA 使用各包独立入口，不默认全量。范围见 [测试规格](docs/testing/unit-test-quality.md)，推送合同见 [pre-push 说明](docs/testing/pre-push-hook.md)。

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `apps/zcode-cli`：Agent CLI 与运行时。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- App 行为改动先更新 spec，确定 E2E、浏览器验收或可重复运行时场景；交互改动先维护 E2E 再改实现。工程工具、CLI/CUA 先补其回归测试。实际执行必要验证，未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- PR 描述须说明背景、设计意图与修改前后行为；包含 bugfix 时逐项说明触发场景、根因证据、修复机制及回归验证，并尽量关联已有工单链接。未确认的根因或引入提交如实标注，不根据模块或时间接近推断归因。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 修改 React 组件或 hooks 后，必须运行 `pnpm lint`（Oxlint），检查 `react/exhaustive-deps` 和 `react/rules-of-hooks`。复核本次改动新增及相关的缺失、多余、不稳定依赖与调用位置诊断，不能因仅告警或退出码为 0 就忽略，也不机械补齐整个对象依赖或禁用规则。被根配置忽略的文件须按 [React Hooks 检查](docs/testing/react-hooks-lint.md) 补做专项扫描；渲染问题仍须运行时验证。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
