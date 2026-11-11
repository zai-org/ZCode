# Electron Service Context Reload 与 I55 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 6 个 Electron service ContextId preflight 超时、I38/I39/I42 的真实重启竞态，以及 I55 未显式建立 `high` 前置状态的问题。

**Architecture:** 保留现有 `wdio-electron-service@9.2.1` launcher/capability 合同，并用项目 E2E service wrapper 把 main-process probe 纳入 `before` 完成条件；旧 service 吞掉首次 ContextId 失败时只重连 bridge 一次。真实 App reload 通过 `overwriteCommand` 把旧 PID 退出屏障插入 WebdriverIO `reloadSession` 内部 delete 与新 session 创建之间；wrapper 的 `onReload` 重新初始化 CDP bridge 和窗口绑定。I55 在创建 Session A 前通过真实 toolbar/V4 command 显式选择 `high`，再验证 B 继承和 A/B 隔离。

**Tech Stack:** WebdriverIO 9、`wdio-electron-service` 9.2.1、Electron 41、Mocha、Vitest、TypeScript。

## Global Constraints

- 不增加固定 sleep；健康启动只允许一次 readiness probe。
- bridge retry 最多一次，第二次失败必须传播为 infrastructure failure。
- `reloadSession()` 内部 delete 完成后、创建新 session 前必须等待旧 Electron 主 PID 退出，之后必须通过 `onReload` 重建 service；禁止在外层重复 `deleteSession()`。
- I55 的 `high` 只能由真实用户配置动作建立，不能靠 renderer 挂载后的 localStorage seed 伪造。
- bug 原因与修复理由保留中文注释。
- 执行 focused unit、fixture check、目标 E2E、desktop E2E typecheck、全量 typecheck 和 lint。
- 最终提交 Conventional Commit。

---

### Task 1: 锁定 Electron service readiness 与 reload 合同

**Files:**

- Create: `packages/desktop/test/e2e/helpers/e2e-electron-service.ts`
- Create: `packages/desktop/test/e2e/helpers/e2e-electron-service-lifecycle.ts`
- Create: `packages/desktop/test/e2eElectronServiceLifecycle.test.ts`
- Modify: `packages/desktop/wdio.conf.ts`

- [x] 先写失败测试：健康初始化只调用一次；首次 probe 失败会 reset/reconnect；第二次失败传播；service module 同时导出官方 launcher 与自定义 worker。
- [x] 配置 WDIO 加载本地 reload-aware service module，保持原 `wdio-electron-service` launcher 能力和 rootDir 配置。
- [x] wrapper 在 root preflight 前完成 main-process bridge probe，错误中区分 service readiness 与 renderer readiness。

### Task 2: 为真实 App reload 增加旧进程退出屏障和 service 重连

**Files:**

- Create: `packages/desktop/test/e2e/helpers/e2e-electron-reload.ts`
- Create: `packages/desktop/test/e2eElectronReload.test.ts`
- Modify: `packages/desktop/test/e2e/helpers/model-provider-restart.ts`

- [x] 先写失败测试：quit 请求返回旧主 PID；等待存活进程退出；超时必须报出 PID；退出完成后才调用 reload。
- [x] `restartIntoWorkspace()` 保存偏好后调用安全 reload helper；helper 包裹 WDIO 内部 delete，等待旧 PID 后再建新 session，随后恢复 localStorage 并 reload renderer。
- [x] 修正 `waitForSelectedModel()` 诊断读取原子 `zcode-last-agent-config`，删除旧分离 key 的误导输出。

### Task 3: 按确认语义修复 I55

**Files:**

- Modify: `packages/desktop/test/e2e/conversation-session/models/conversation-session-thought-level-session-isolation.test.ts`
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify: `docs/testing/conversation-session-e2e-human-readable-cases.md`

- [x] 在 `prepareV4ConversationE2E()` 后、首发 A 前，真实切换 DeepSeek thought 为 `high` 并等待 V4 projection。
- [x] A 首发、B 继承、A→max、B/A 续发均保留 network capture 断言。
- [x] 不修改 provider 默认档位和共享 localStorage seed 来迁就 case。

### Task 4: 验证与提交

- [x] 运行 Electron lifecycle/reload、window target、偏好 seed focused unit。
- [x] 对 I55、Turbo switch/recovery 运行 fixture check。
- [x] 分别运行 I55、I38/I39/I42 目标 E2E；I55 修复后连续 3 次通过，I38/I39/I42 真实 reload 3/3 通过。
- [x] 运行 `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint`。
- [x] 检查运行后无 Electron/host/agent/Chromedriver 残留并复核最终 diff。
- [x] 仅暂存本任务文件并提交 Conventional Commit。
