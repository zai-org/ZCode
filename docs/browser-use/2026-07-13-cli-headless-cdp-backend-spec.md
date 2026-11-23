# CLI Headless CDP Browser Backend 规格

> 状态：已实现。
>
> 日期：2026-07-13。
>
> 上位规格：`2026-07-10-browser-use-spec.md`、
> `2026-07-13-node-repl-mcp-runtime-spec.md`。

## 1. 功能摘要

Linux 服务机上的 ZCode CLI 需要能够直接运行 ZCode 自己的 Browser Use，而不是依赖
Desktop IAB、`agent-browser` 或有图形界面的内置浏览器。CLI 通过显式参数创建并托管一个
独立 Chromium，把它作为现有 browser-client 可发现的真实 `cdp` backend 暴露：

```text
model
  -> mcp__node_repl__js
  -> browser-use plugin scripts/browser-client.mjs
  -> authenticated Node REPL browser broker
  -> BrowserControlPort
  -> managed CDP backend
  -> headless Chromium
```

`headless` 是 `cdp` backend 的 launch/display mode，不是新的 backend family。未来由 CLI
启动 headed Chromium，descriptor 仍为 `type: "cdp"`；IAB 即使内部也使用 CDP，仍因 UI、
ownership 和生命周期语义不同而保持 `type: "iab"`。

## 2. 澄清记录与固定边界

| 问题 | 用户确认 | 固定边界 |
| --- | --- | --- |
| CLI 自启动还是连接外部 CDP | 采用建议方案 | P0 由 CLI managed launch；attach-cdp 留后续 |
| 是否默认启动 | 采用建议方案 | 必须显式 `--browser-use=headless` |
| 浏览器 profile | 采用建议方案 | 每个 CLI 进程使用临时 profile，不跨进程恢复登录态；登录态可以通过只读快照注入，见 `2026-11-17-cli-browser-state-spec.md` |
| 生效入口 | 采用建议方案 | `--prompt`、`--target` 和 TUI；ZCode app-server 排除 |
| 浏览器分发 | 采用建议方案 | P0 不下载/捆绑浏览器；显式路径优先，再查已安装 Chromium |

## 3. CLI 合同

新增全局参数：

```text
--browser-use=headless
--browser-executable=<absolute path>
```

示例：

```bash
zcode --browser-use=headless \
  --browser-executable=/usr/bin/chromium \
  --prompt "打开 http://127.0.0.1:4173 并测试登录流程"
```

规则：

- `--browser-use` P0 只接受 `headless`；未知值在 CLI 参数边界失败。
- `--browser-executable` 只能和 `--browser-use=headless` 一起使用。
- 显式路径必须解析为绝对路径并且是可执行文件；路径错误时不创建 App/session。
- 未显式给路径时，adapter 按平台查找已安装的 Chrome/Chromium，以及 Playwright cache 中
  已存在的 Chromium；P0 不联网下载浏览器。
- `--no-browser` 保持 OAuth 登录参数语义，不能复用为 Browser Use 开关。
- `zcode app-server` / `zcode app-server --stdio` 使用该参数时 fail closed；不能为 Desktop、
  Web Remote 或 mobile shared-host 链路另起 CLI browser runtime。
- 不新增环境变量；后续配置文件入口必须先定义优先级和来源审计。
- 登录态注入参数 `--browser-state` / `--no-browser-state` 及默认文件规则见 `2026-11-17-cli-browser-state-spec.md`。

## 4. Descriptor 与 capability

完成 Chromium 启动和 CDP handshake 后才能返回 descriptor：

```ts
{
  id: `cdp:${runtimeId}`,
  generation,
  type: "cdp",
  name: "ZCode Headless Chromium",
  capabilities: {
    browser: [{ id: "viewport", description: "..." }],
    tab: []
  },
  metadata: {
    provider: "zcode-cli",
    launchMode: "managed",
    headless: "true"
  }
}
```

`metadata` 不得包含 executable path、临时 profile path、CDP endpoint、token、query 或其它敏感值。
启动失败、browser crash 尚未恢复或握手未完成时，`list()` 不能返回 stub descriptor。

P0 支持并向对象图暴露：

- browser discovery/default/URL selection；
- tabs list/get/new/selected/close；
- goto/back/forward/reload、url/title/state；
- DOM snapshot、Playwright locator/action/wait/evaluate；
- screenshot、viewport；
- CUA keyboard/mouse/scroll/drag；
- 基础 JavaScript dialog。

P0 必须通过 `apiSupportOverrides` 隐藏未完成能力：

- user history/claim；
- visibility；
- handoff/deliverable/finalize；
- file chooser/upload、download/media；
- clipboard、dev logs、raw CDP/pageAssets/content。

不允许把未实现成员暴露后返回 `NotImplemented`。

## 5. Ownership、隔离与生命周期

状态 owner 是 CLI adapter，不是 Agent core、MCP child、relay 或 desktop main：

| 状态 | owner | 生命周期 |
| --- | --- | --- |
| Chromium process | managed CDP adapter | 当前 CLI/TUI app runtime |
| BrowserContext | managed CDP adapter | 每个 ZCode session 一个隔离 context |
| target/tab registry | managed CDP adapter | `workspaceKey + sessionId` scope |
| request/cancel ledger | managed CDP adapter | request/turn，受 AbortSignal 控制 |
| Browser/Tab JS binding | Node REPL kernel | kernel generation；backend generation 另外校验 |

行为：

- 首次 `list()` 执行 launch + handshake；只有成功后才可发现 backend。
- 同一 TUI 进程可以复用 Chromium process，但不同 session 使用不同 BrowserContext，tab 不互见。
- turn 结束只取消该 turn 的 pending request，tab 保持到 session/app 关闭。
- `tab.close()` 只关闭目标 tab。
- `closeSession()` 关闭该 session 的 pages/context；没有剩余 context 时关闭 managed Chromium。
- browser crash/relaunch 必须递增 `generation`，旧 Browser/Tab binding 返回 stale/unavailable。
- CLI 进程退出不承诺恢复 tab；临时 profile 必须清理。
- P0 不接受外部 CDP endpoint，所以 adapter 始终拥有并负责关闭它启动的 Chromium。

CLI local session 没有 `workspaceIdentity` 时继续使用 `workspacePath` fallback；本功能不修改
Desktop/Web Remote 的 workspace identity、clientMode 或 deliveryKind 路由。

## 6. I/O、安全与错误合同

- Chromium 启动、临时目录和 CDP socket 都位于 adapter；core 只依赖 `BrowserControlPort`。
- 使用 `child_process.spawn(executable, args)`，不得经 shell 拼命令。
- 默认使用原生 `--headless=new`，不要求 `DISPLAY` 或 Xvfb。
- 默认不增加 `--no-sandbox`；CI 应使用非 root 用户。P0 不提供绕过 sandbox 的 CLI 参数。
- CDP 使用 Chromium 自动分配的 loopback endpoint，不绑定公网地址；endpoint 不进入日志/metadata。
- 导航继续复用 http/https/about:blank allowlist，禁止 file/data/javascript 和其它 about URL。
- adapter 必须传播 AbortSignal。动作已发出后取消但无法证明结果时，返回
  `sideEffect: "uncertain"`；排队期取消返回 `cancelled/none`。
- 错误使用稳定分类：`backend_unavailable`、`navigation_blocked`、`timeout`、`cancelled`、
  `capability_unsupported`、`execution_error`。底层 spawn/CDP 错误保留 cause，但用户消息不得泄露
  endpoint、profile path 或页面敏感内容。
- browser-use plugin 禁用时不注入 browser broker，也不启动 Chromium；通用 node_repl 仍可用。

## 7. 打包合同

- 默认发布路径仍是标准 Node.js CLI bundle；headless adapter 必须能从该入口启动系统 Chromium。
- 公共 browser command runtime 可以依赖 pinned Playwright injected script，但不能依赖
  `agent-browser`，也不能要求用户另起测试服务。
- 普通 Node bundle 从安装依赖解析 injected script；SEA 必须把同一 pinned source 作为只读 asset
  嵌入，不能在运行时联网获取。
- 找不到 injected runtime asset 时 `cdp` backend 不可发现并返回可操作错误，不能降级为语义不同的
  DOM selector 实现。

## 8. 状态空间与剪枝

主域：permission/tool/MCP、architecture/process boundary、desktop lifecycle、CLI packaging。

| Candidate | 组合 | 分类 | 理由 |
| --- | --- | --- | --- |
| HCDP-001 | prompt + explicit headless + real Chromium | accepted | Linux 自动化主路径 |
| HCDP-002 | TUI 多 session + headless | accepted | context/tab 隔离高风险 |
| HCDP-003 | app-server + headless | pruned/rejected | 违反 shared-host ownership |
| HCDP-004 | plugin disabled + headless | accepted | 必须 fail closed 且不启动进程 |
| HCDP-005 | missing executable | accepted | 不得留进程或 fake descriptor |
| HCDP-006 | external attach CDP | pruned | P0 不拥有外部 browser 生命周期 |
| HCDP-007 | persistent profile | pruned | P0 以 CI 可重复性优先；登录态复用改为只读快照注入，见 `2026-11-17-cli-browser-state-spec.md` |
| HCDP-008 | Linux × real CDP × no DISPLAY | accepted | 用户目标环境 |
| HCDP-009 | macOS/Windows path resolution | accepted pairwise | 跨平台解析，实机风险单列 |
| HCDP-010 | mobile/web remote 自建 headless | pruned | 继续依赖 existing shared host |

## 9. 验收用例

| Case | Setup / action | Assertions | Evidence |
| --- | --- | --- | --- |
| HCDP-001 | 显式 headless，首次 list | 启动一次；返回一个真实 `cdp` descriptor | adapter integration + real Chrome |
| HCDP-002 | plugin disabled | 无 broker、无 Chromium process、node_repl 可用 | bootstrap/CLI integration |
| HCDP-003 | executable 缺失/不可执行 | CLI 明确失败；无 session、无 zombie、无 descriptor | CLI unit + process probe |
| HCDP-004 | 真实模型脚本调用 Browser Use | MCP js → browser-client → broker → port → Chromium 完整成立 | CLI E2E artifact |
| HCDP-005 | 本地 HTTP fixture | navigate、DOM、locator、click/fill、screenshot 正确 | real Chromium E2E |
| HCDP-006 | 无 DISPLAY | native headless 成功，不启动 Xvfb | Linux container E2E |
| HCDP-007 | turn end / session close | turn 保留 tab；close 清 context/process/temp profile | integration + process evidence |
| HCDP-008 | cancel/timeout | 无迟到串请求；副作用不确定性正确 | adapter unit/integration |
| HCDP-009 | browser crash/restart | generation 递增；旧 binding stale | adapter integration |
| HCDP-010 | unsupported API | 成员从对象图和文档隐藏 | manifest contract |
| HCDP-011 | URL scheme | http/https/about:blank 允许，其它 scheme 拒绝 | runtime unit + real smoke |
| HCDP-012 | Node bundle / SEA | injected asset 可解析，启动 smoke 成功 | build contract + startup smoke |
| HCDP-013 | context/browser close 永不 settle | 每个 close 有 deadline；Browser 失败不阻断 Execution/MCP；CLI 最终有界退出 | adapter + session/CLI focused tests |

真实 E2E 必须经过 `mcp__node_repl__js` 和 plugin browser-client；直接调用 adapter 只能证明
adapter，不足以证明 ZCode Browser Use。

本机真实浏览器链路：

```bash
pnpm --dir apps/zcode-cli test:browser-headless
```

Linux、非 root、无 `DISPLAY`/Xvfb 的容器验收：

```bash
pnpm --dir apps/zcode-cli test:browser-headless:linux
```

## 10. 非目标

- 不使用或封装 `agent-browser`。
- 不新增 `headless` backend family。
- 不在 P0 下载、更新或捆绑 Chromium。
- 不支持 persistent user profile、外部 CDP attach、extension 或 user-tab claim。登录态复用见
  `2026-11-17-cli-browser-state-spec.md`。
- 不修改 Desktop IAB、mobile replayable、remote workspace shared-host 业务语义。

## 11. 实现与验证记录

- CLI prompt、target 与 TUI 通过依赖注入把 managed `BrowserControlPort` 交给现有
  `createZCodeApp`；app-server 在参数边界拒绝。
- adapter 以一个 Chromium process + 每 session 一个 BrowserContext 管理 tab、generation、取消与
  close；snapshot ref 由 adapter 持有 ElementHandle，不暴露给页面 `globalThis`。
- context、browser 和 late launch cleanup 都执行有界等待；单个 Playwright close 悬空时继续其它
  session 资源清理，并由 CLI 最终 watchdog 防止未知 handle 永久保活进程。
- 普通 Node bundle 延迟解析 pinned `playwright-core@1.59.1`；SEA collector 嵌入同一 package 的
  465 个带 hash asset，并在用户 cache 中校验后解包。
- 自动化覆盖 adapter 12 个 lifecycle/concurrency/cancel/timeout/generation/安全用例、CLI 参数与 prompt/TUI wiring、core
  manifest capability hiding、SEA asset contract。
- 真实 E2E 已在 macOS 上删除 `DISPLAY` 后通过：MCP `js` → browser-client → authenticated broker →
  BrowserControlPort → headless Chromium，验证 DOM snapshot、locator fill/click、状态读取和 screenshot。
- host SEA 已完成真实 build、注入、ad-hoc sign 和 `--version` smoke。Linux Docker harness 已落盘；当前
  开发机 Docker daemon 未启动，因此 Linux 容器实跑留给 CI/服务机执行。
