# 扩展进程（Extension Host）

> 状态：P1 与 P2 已实现。P1：阶段 2a（进程基础设施、贡献表、两个插槽、重新加载）、2b（六个能力、数据泵、Renderer 报告、扩展视图）、2c（示例插件 context-inspector，§11）。P2：P2a（静态声明移到 Window Host、清单顶层 `slots`、§16.11 的三处 API 修正）、P2b（视图门面拆分、`nav.primary`、`file.viewer`）、P2c（`composer.mention`）、P2d（插件设置与能力 `settings.*`）、P2e（日志控制台）。P3 已实现（§17）：P3a（授权骨架与 facade 读，§17.10 第 1 步）、P3b（读连接与商店安装后的激活确认，第 2 步）、P3c-1（八个写动作、来源标识、写审计）与 P3c-2（插件项目，第 3 步）、P3d（类型包 `@zcode-dev/plugin-api`，第 4 步）；P4 的宿主能力 H1–H12（§18.1）已实现，H13 不做；示例插件 Jarvis（§18.3，§18.4 Jarvis 第 1–8 步）已实现；GitLab 插件本体（§18.4 GitLab 第 4–9 步）与开发者文档未做；P5 只列要点，动工前补全对应章节。
> 基线：staging `2015563fc3`。文中代码位置按该基线核对。

## 1. 背景与目标

插件今天只能在会话里运行：MCP App 插件的 MCP server 由 CLI 在会话里启动，页面必须挂在会话上。插件无法在没有会话时显示数据，也无法常驻运行代码。

本设计给插件增加**扩展（Extension）**：插件可以带一段运行时代码，在全 App 唯一的扩展进程里运行。扩展向壳层预留的**插槽**提供数据，能打开自己的**扩展视图**，并经**能力**调用 App 的功能。

| 需求                                               | 本文章节  | 阶段 |
| -------------------------------------------------- | --------- | ---- |
| A 唯一扩展进程、VS Code 式注册、静态插槽           | §3–§8     | P1   |
| B context-inspector：TPS 与 context 组成           | §9–§11    | P1   |
| C 插件入口：主导航、文件查看器、`@` 条目、插件设置 | §14       | P2   |
| D 插件日志控制台                                   | §14       | P2   |
| E 插件操作会话                                     | §3.5、§14 | P3   |
| F 其他能力暴露                                     | §3.5、§14 | P5   |
| G 类型包 `@zcode-dev/plugin-api`                   | §7.4、§14 | P3   |
| H 开发者文档                                       | §14       | P4   |
| I 示例插件 Jarvis、GitLab                          | §14       | P4   |

术语：

- **插件（Plugin）**：安装单元，有一个 `plugin.json`。
- **扩展（Extension）**：插件清单里 `extension` 键声明的组件。一个插件最多一个扩展。
- **插槽（Slot）**：壳层预留的界面位置。扩展只提供数据，样式由壳层组件决定。
- **扩展视图（Extension View）**：扩展提供的页面，以侧栏标签页显示，不依赖会话。
- **能力（Capability）**：扩展可以调用的一项 App 功能。能力表（§7.2）列出全部能力，表里没有的就不存在。

## 2. 不做什么

- 不按插件隔离进程。所有扩展在一个进程里运行（用户决策）。后果见 §7.3。
- 不支持多窗口。产品只有一个窗口，扩展进程只连一个 Window Host（用户决策）。
- CLI 不连接扩展进程。扩展要的 CLI 数据由 Window Host 转交（用户决策）。
- Renderer 不连接扩展进程。Renderer 只经 Window Host 的服务访问扩展。
- 业务服务不知道插件存在。插件对 App 的全部访问只经 Window Host 的 `extensions-service`（§3.5）。
- 不支持远程工作区的插件运行扩展代码。扩展进程在本机，远程工作区的插件包在远端主机上。
- 扩展没有工作区级别。工作区级启用不激活扩展代码（见 §13）。
- 插槽不接受插件提供的 HTML、SVG 或样式。要自由绘制，用扩展视图。
- Web 与手机远控不显示插槽，也没有扩展视图。

## 3. 进程拓扑与数据归属

### 3.1 进程

```text
Electron Main
 ├── Window Host            utilityProcess，每窗口一个（产品只有一个窗口）──stdio──► CLI agent
 ├── cron scheduler         utilityProcess，全 App 一个（现有）
 └── 扩展进程               utilityProcess，全 App 一个（新增）
```

事实：

- Main 只管窗口、进程、广播中转、日志与远控调度，不持有业务状态（`docs/agents/runtime-boundaries.md`「进程归属」）。业务服务都在 Window Host。
- Main 用 `utilityProcess.fork` 起 Window Host（`packages/desktop/src/main/desktopHostProcess.ts:267`），以 webContents id 为键（`desktopWindowLifecycle.ts:145,218`）。
- cron scheduler 是现有唯一的 App 级常驻 utilityProcess（`main/desktopCronScheduler.ts:62`），数据库就绪后起一次（`main/index.ts:2275-2287`）。它要执行任务时，由 Main 转给 Window Host（`main/index.ts:724-727`）；没有 Window Host 时回执 transient，scheduler 退避重试（`desktopCronScheduler.ts:119-130`）。**扩展进程照抄它的进程管理、日志转发、退出收口和构建目标。**
- 现有 utilityProcess 崩溃后都不自动重启（`desktopHostProcess.ts:710-728`、`desktopCronScheduler.ts:202-205`）。扩展进程的崩溃恢复是新机制，见 §12。

### 3.2 连接

```text
                     Main
          ┌───────────┼─────────────┐
   parentPort 控制     │              │ parentPort 控制
          ▼           │ 牵线：        ▼
     Window Host ◄────┘ MessageChannelMain ──► 扩展进程
          ▲             一对，之后直连           ▲
          │                                      │
          └──────── @zcode/rpc 双向 ─────────────┘
          ▲
          │ @zcode/rpc（现有服务通道）
       Renderer
```

- **L0 控制面**：Main ⇄ 扩展进程、Main ⇄ Window Host 走 parentPort 普通消息，只管生命周期（初始化、牵线、退出、日志、存活探测、扩展进程状态、重新加载）。
- **L1 业务面**：Main 创建一对 `MessageChannelMain`，两端分别发给 Window Host 和扩展进程。之后两者直连，Main 不在数据路径上。端口上跑双向 `@zcode/rpc`，两个频道：
  - `extension-host`：Window Host 调扩展进程（清单、命令、视图、贡献表订阅）。
  - `extension-window`：扩展进程调 Window Host。只有能力表的两个通用入口 `call`、`subscribe`（§7.2），外加生命周期方法。**不为单个能力加方法。**
- Main 同一时刻只给一个 Window Host 牵线。当前没有已连接的 Window Host 时，给下一个就绪的 Window Host 牵线。Window Host 重启、窗口关闭后重开，都走这一条。
- 牵线写法照抄现有服务端口（`desktopHostProcess.ts:675-688`、`host/index.ts:2700-2736`）。

### 3.3 跨进程约束（事实）

- `@zcode/rpc` 不是 JSON-RPC，是自有二进制格式，支持事件订阅（`packages/rpc/src/proxy-channel.ts:41-44`）。
- 函数、`AbortSignal`、类实例不能跨进程（走 JSON 序列化，`serialization.ts:152-186`）。
- ProxyChannel 不传取消 token（`proxy-channel.ts:85-95`）。**需要取消的调用一律设计显式的 cancel 方法**，照现有 `voice-input/contract.ts:38-39`。契约上不出现 `AbortSignal` 参数。

### 3.4 数据归属（唯一事实源）

| 数据                                                             | 唯一 owner                                                                          | 其他方怎么拿                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 插件清单、启用状态、`userConfig` 值                              | CLI（`plugins/list`；普通值在 `~/.zcode/cli/config.json`，敏感值在私有文件，§16.7） | 清单与启用状态：Window Host 读出后推给扩展进程；设置值：扩展经能力 `settings.*` 按需读（§16.7） |
| 插件清单「变了」                                                 | Window Host 的插件管理服务（安装、卸载、启停、配置都经过它）                        | Window Host 操作成功后重推                                                                      |
| 静态声明：`slots`、命令、视图、清单状态（invalid、incompatible） | Window Host 的 `extensions-service`（§16.1）                                        | 带 `rev` 的整份静态表，推给 Renderer；合法兼容的扩展声明推给扩展进程                            |
| 扩展运行状态（activating、active、failed）                       | 扩展进程                                                                            | 带 `gen`/`rev` 的整份快照，推给 Window Host，再推给 Renderer                                    |
| 插槽动态值（`text`、`tooltip`、`visible`）                       | 扩展进程                                                                            | 按「条目 + 作用域」推增量，与快照共用 `rev`（§6）                                               |
| context 组成                                                     | CLI（`buildContextUsageSnapshot`）                                                  | Window Host 转发变更通知（只带修订号），扩展按需拉取                                            |
| 生成速率                                                         | CLI 遥测事实 → Window Host 聚合（只此一处）                                         | 有扩展订阅时，Window Host 推给扩展进程                                                          |
| 屏幕上的会话（窗格、是否草稿、焦点）                             | Renderer                                                                            | Renderer 报告给 Window Host；扩展经 `workbench` 能力读                                          |
| App 环境（界面语言）                                             | Renderer                                                                            | Renderer 报告给 Window Host；扩展经 `env` 能力读（§16.11）                                      |
| 草稿的所选模型                                                   | Renderer（发送前不下发 CLI，`v4/SessionPane.tsx:4895-4897`）                        | Renderer 报告给 Window Host，只用于 context 预演查询（§9）                                      |
| 正式会话的模型                                                   | CLI                                                                                 | 随 context 组成、生成速率一起返回                                                               |
| 侧栏标签（含扩展视图标签）                                       | Renderer（`hooks/useAppPanels.ts:285`，只在内存）                                   | 扩展经 `views.open` 能力请 Renderer 打开                                                        |
| 扩展进程状态（运行、重启中、已停止）                             | Main 的监管器（它决定是否重启）                                                     | Main 经 parentPort 推给 Window Host                                                             |
| 扩展日志缓冲（最近 2000 条）                                     | Main 的监管器（§16.8）                                                              | Main 推追加的批次；快照经 Window Host 转发                                                      |

规则：

- 除 owner 外，各方只持有最近一份快照。快照按 `gen`/`rev` 整份替换；增量只用来更新这份快照，不维护第二份业务状态。
- 状态同步用事件加修订号，不用超时轮询。

事实：插件变更通知今天在 Renderer 里发（`packages/ui/src/store/pluginManagementStoreLoading.ts:45`），由 Renderer 在调用返回后自己触发。扩展需要的是 Window Host 侧的信号，所以在 Window Host 的插件管理服务成功返回处产生，不让 Renderer 通知回去。

### 3.5 能力的位置

App 的能力几乎都在 Window Host。例外只有两类：Renderer 独有的界面状态，Main 独有的日志与系统通知。所以插件面向 App 的实现**只放在 Window Host 的 `extensions-service` 一处**。

| 能力                  | 现在的 owner                                                                          | 插件后端                                   | 阶段  |
| --------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ | ----- |
| context 组成          | CLI                                                                                   | ② zcode-agent 服务 `getContextComposition` | P1    |
| 生成速率              | CLI 遥测 → Window Host                                                                | ② Window Host 聚合                         | P1    |
| 屏幕上的会话          | Renderer                                                                              | ③ Renderer 报告                            | P1    |
| 打开扩展视图          | Renderer（`useAppPanels.ts:285`）                                                     | ③ Renderer 执行                            | P1    |
| 开预填草稿            | Renderer（Root 的新建任务，插件市场「试用」同一路径）                                 | ③ Renderer 执行                            | P4    |
| 日志                  | Main 写盘（`main/logger.ts:93-117`）                                                  | 扩展进程经 parentPort 直接发给 Main        | P1/P2 |
| 插件设置 `userConfig` | CLI 配置 `plugins.options[pluginId]`                                                  | ① `IPluginManagementService`               | P2/P4 |
| 会话列表              | Window Host `TaskIndexRepo` + 同步器（`zcode-agent/zcodeTaskIndexSyncer.ts:445-459`） | ② 插件自己的连接作用域                     | P3    |
| 会话正文              | CLI                                                                                   | ② 插件自己的连接作用域                     | P3    |
| 会话写                | Window Host `AppControlService` → CLI（`app-control/execution.ts:131-145`）           | ① `AppControlService` 加插件绑定           | P3    |
| 打开某个会话          | Window Host → Main → Renderer（`packages/desktop/src/app-control-navigation/`）       | ① 现有导航端口（`open_session` 已在用）    | P3    |
| 插件管理              | Window Host 薄服务 → CLI 管理面（`plugins/pluginManagementService.ts:39-211`）        | ① `IPluginManagementService`               | P5    |
| 定时任务              | Window Host `AutomationService`（`session/automationService.ts:71`）                  | ① 同一服务                                 | P5    |
| MCP 配置              | Main 与 Window Host 各一份等价实现                                                    | ① 只用 Window Host 的 `IMcpSyncService`    | P5    |
| 模型与 provider       | Window Host `IProviderSettingsService` / `IModelSelectionService`                     | ① 同一服务，只读                           | P5    |
| 系统通知              | Main 弹出，文案由 Renderer 生成                                                       | 没有现成的 Window Host 路径，P4 设计       | P4    |

插件后端只有三种。`extensions-service` 内部就分这三块：

```text
扩展进程 ──extension-window──► Window Host / extensions-service
                                 │  能力网关：查表 → 校验入参 → 授权 → 审计 → 分派
                                 │
                                 ├─ ① 调现有服务   请求/响应。插件管理、定时任务、MCP、模型、会话写
                                 ├─ ② 数据泵       订阅 + 修订号；大内容只推修订号，按需拉。
                                 │                 context 组成、生成速率、会话列表与正文
                                 └─ ③ 请 Renderer  Renderer 报告的快照 + 变更事件；请 Renderer 执行并等回执。
                                                   屏幕上的会话、打开视图。走 IExtensionsService 与 IExtensionViewsService 已有的通道

扩展进程 ──parentPort──► Main       只有生命周期与日志
Window Host ──静态表───► Renderer    插槽条目、命令、视图声明、清单状态（§16.1）
扩展进程 ──贡献表──────► Renderer    运行状态与插槽动态值。方向相反，不经能力网关
```

- 一个能力属于哪一块，由它的 owner 决定，不由调用方便利决定。
- 只有 P3 的会话写要改业务模块（给 `AppControlService` 加插件绑定）。其他能力都是筛出现有服务的方法，业务服务不改。
- 打开扩展视图不借用 app-control 的导航桥。借用会让扩展代码散进 app-control 模块。

## 4. 模块边界

新增代码只落下面六个模块（`plugin-api` 由 P3d 加入，§17.9）。每个模块按 `architecture-policy.yaml` 登记为 managed 模块，带 `module.ts`、`contract.ts`、`contract.example.ts`、`CONTRACT.md` 四件套。登记用 `pnpm architecture:adopt <id> --root <dir>`。

| 模块 id                   | 根目录                                                                                                                                                                                                                               | 职责                                                                                                                                                                   | 层                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `extension-host-protocol` | `packages/shared/src/extension-host/`                                                                                                                                                                                                | 清单 schema、插槽目录、贡献表 schema、能力表、`ExtensionContext` 接口、跨进程接口、控制消息、错误码。只放 schema、类型与纯函数                                         | domain                       |
| `extension-host`          | `packages/desktop/src/extension-host/`、`packages/desktop/src/main/extensionHostSupervisor.ts`                                                                                                                                       | 扩展进程入口、注册表、`ctx` 运行时；Main 侧监管（崩溃预算、存活探测、环境变量白名单、重新加载）                                                                        | adapters                     |
| `extensions-service`      | `packages/services/src/extensions/`                                                                                                                                                                                                  | Window Host 门面 `IExtensionsService` 与 `IExtensionViewsService`（§8）；插件访问 App 的唯一适配层：能力网关与三块后端（§3.5）；按代际连接扩展进程；扩展视图的沙箱登记 | app                          |
| `extension-slots`         | `packages/ui/src/extension-slots/`                                                                                                                                                                                                   | Renderer：贡献表快照、插槽组件、扩展视图标签页、`workbench` 报告、执行 `views.open`                                                                                    | domain / app / adapters / ui |
| `context-composition`     | `packages/shared/src/zcode-protocol-v4/context-composition/`、CLI 的 `core/src/runtime/context-composition/` 与 `bootstrap/src/zcode-protocol/context-composition/`、`packages/services/src/zcode-agent/contextCompositionClient.ts` | context 组成的线格式、CLI 生成与预演、修订号与协议处理、App 侧查询与通知。见 CLI spec                                                                                  | app                          |
| `plugin-api`              | `packages/plugin-api/src/`、`packages/plugin-api/tsup.config.ts`                                                                                                                                                                     | 插件作者用的类型包 `@zcode-dev/plugin-api`：只转出 extension-host-protocol 与 v4 协议的类型，不含运行时代码（§17.9）                                                   | contract                     |

为什么这样分：

- 进程边界就是模块边界。每个进程的代码在一个模块里，跨进程的形状只在 `extension-host-protocol` 定义一次。
- `extension-host-protocol` 是纯 schema，三个进程都依赖它，它不依赖任何进程。
- 扩展视图的页面复用 MCP App 的页面层。`extension-slots` 依赖 `plugin-ui` 的页面原语，反过来不行。

**禁止出现的模式：**

| 不允许                                                         | 理由                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Renderer 直连扩展进程；扩展进程连 CLI                          | 违反 §2；绕过 Window Host 的作用域补全与校验                                                                                               |
| 在 `extensions-service` 以外接插件调用；业务服务里出现插件分支 | 插件适配只在一处（§3.5）                                                                                                                   |
| 给 `extension-window` 频道加单个能力的方法                     | 能力只经能力表的 `call` / `subscribe`（§7.2）。加方法就绕过了查表、校验、授权与审计                                                        |
| Window Host 或 Renderer 维护第二份贡献表；别处再解析清单       | 贡献表只有扩展进程能写，静态表只有 Window Host 能写；其他方只持最近快照。扩展进程不读 `plugin.json`（§16.1）                               |
| 用超时、轮询同步状态                                           | 用事件加修订号。存活探测（§12.1）判断进程是否卡死，不同步状态                                                                              |
| 跨进程传 `AbortSignal` 或函数                                  | 过不去，见 §3.3。这类缺陷进程内单测发现不了，只有跨 RPC 才暴露                                                                             |
| 在 Renderer 可达的模块顶层调用 `createServiceLogger`           | 它在创建时读 `process.pid`，沙箱 Renderer 没有 `process`，会让主窗口白屏（`plugin-ui-bridge/pluginUiBridgeService.ts:109-111` 有事故记录） |
| 扩展代码写进 `plugin-ui` / `plugin-ui-bridge` / app-control    | 那是 MCP App 与会话控制的模块。共用的入口形状放 `extension-host-protocol`                                                                  |
| 新增插槽时在多处写死插槽 id                                    | 插槽目录 `EXTENSION_SLOTS` 是唯一定义，清单校验、渲染、文档都读它                                                                          |
| 扩展视图登记沙箱时伪造会话 id                                  | 用 `contentKind: "extension"`，不填 `sessionId`，见 §8                                                                                     |
| 扩展进程继承 Window Host 的完整环境变量                        | Window Host 的环境里有遥测凭据与 OAuth 配置（`main/desktopRuntimeEnv.ts:160-172`），见 §12.1                                               |

## 5. 清单

插件在 `plugin.json` 顶层加 `extension` 键。入口条目写在清单顶层 `slots`，条目用 `target` 指向打开对象，带扩展的插件与只有 MCP App 的插件写法相同（§16.2）。P1 的 `extension.contributes.slots` 已删除。

事实：CLI 解析清单时用 `{...parsed}` 展开（`apps/zcode-cli/packages/adapters/src/plugins/index.ts:826-833`），未知顶层键原样保留，不报错。所以加 `extension` 不影响插件的其他组件，旧 CLI 也不会拒绝这个插件。

```jsonc
{
  "name": "context-inspector",
  "version": "0.1.0",
  "extension": {
    "engines": { "zcode": "^1.0.0" },
    "main": "./dist/extension.js",
    "activationEvents": ["onAvailable"],
    "contributes": {
      "commands": [
        {
          "id": "open-context",
          "title": { "zh-CN": "查看上下文组成", "en-US": "Open context breakdown" },
        },
      ],
      "views": [
        {
          "id": "context",
          "title": { "zh-CN": "上下文组成", "en-US": "Context breakdown" },
          "icon": "pie-chart",
        },
      ],
    },
  },
  "slots": {
    "composer.status": [{ "id": "tps", "icon": "gauge", "target": { "command": "open-context" } }],
    "sidePane.launcher": [{ "id": "open-view", "target": { "view": "context" } }],
  },
}
```

| 字段                   | 必填 | 规则                                                                                           |
| ---------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| `engines.zcode`        | 是   | 扩展 API 版本范围。只支持 `^x.y.z` 与精确版本；主版本必须与宿主的 `EXTENSION_API_VERSION` 一致 |
| `main`                 | 否   | 相对插件根目录，不能用 `../` 跳出。没有时只有静态声明                                          |
| `activationEvents`     | 否   | `onAvailable`、`onCommand:<id>`、`onView:<id>`；后两种由清单自动推导                           |
| `contributes.commands` | 否   | `{ id, title }`                                                                                |
| `contributes.views`    | 否   | `{ id, title, icon? }`。页面资源 URI 固定为 `ui://<pluginId>/<viewId>`，清单不写               |
| 顶层 `slots`           | 否   | 按插槽 id 分组的条目，见 §6、§16.2。不在 `extension` 里                                        |

- `EXTENSION_API_VERSION` 在 `extension-host-protocol` 里定义，是扩展 API 的版本，不是 App 版本。P1 为 `1.0.0`。
- `id` 用小写字母、数字、`.`、`_`、`-`。全局 id 是 `<pluginId>/<id>`。
- `title` 是字符串，或按语言的映射。
- `icon` 是 Lucide 图标名。壳层只渲染白名单里的图标，其余显示通用插件图标。
- **校验在 Window Host**（§16.1），都用 `extension-host-protocol` 的 zod schema。`extension` 键分两步：
  1. 只读 `engines.zcode`。缺失或格式错误判 `invalid`；版本不兼容判 `incompatible`，不再看其余字段。新版本插件装在旧宿主上，得到的是「版本不兼容」，不是「清单非法」。
  2. 版本兼容后，按严格对象校验整个 `extension`。未知字段判 `invalid`，并给出字段路径。
- 两种状态都只影响扩展，不影响插件的其他组件。引用这个扩展的视图、命令的插槽条目不可用（§16.2）。

## 6. 插槽目录

插槽在 `extension-host-protocol` 的 `EXTENSION_SLOTS` 唯一定义，每个插槽声明接受的 target 种类与每插件上限（P2 全表见 §16.3）。P2a 有两个：

| 插槽                | 位置                                     | 条目                                   | 接受的 target | 作用域                 | 每插件上限 |
| ------------------- | ---------------------------------------- | -------------------------------------- | ------------- | ---------------------- | ---------- |
| `composer.status`   | 输入框工具栏，上下文用量圆环左边         | 图标 + 短文字 + 悬停说明，点击执行命令 | command       | 会话（草稿为预热会话） | 1          |
| `sidePane.launcher` | 右侧面板「新标签页」启动页的「扩展」分区 | 视图条目：点击打开扩展视图             | view          | 工作区                 | 5          |

- 壳层组件渲染条目。扩展只提供标题、图标、排序和动态值（`text`、`tooltip`、`visible`）。
- 清单顶层 `slots` 里的条目：`{ id, target, icon?, title?, order? }`，`target` 只有一个键（§16.2）。条目 `id` 在插件内跨插槽唯一。
- 动态值长度上限：`text` 40 字符，`tooltip` 200 字符；超出时 `slots.update` 抛 `invalid-input`。
- 动态值按作用域存放：`app`、`ws:<workspaceKey>`、`session:<sessionId>`。渲染时逐字段合并，优先级会话 > 工作区 > App。
- 动态值只在扩展进程内存里。扩展进程重启后清空，由扩展重新设置。
- `composer.status` 只在设置了 `text` 时显示。

**动态值与快照分开推送。** 生成速率每秒最多更新 2 次。如果每次都推整份贡献表，整张表要过两跳，所有插槽组件都要重渲染。条目本身是静态声明，在 Window Host 的静态表里（§16.1），不在贡献表里。

```text
扩展进程                        Window Host                    Renderer
运行状态变了（激活、失败、停用）
  └─ 快照 {gen, rev, 运行状态, 当前全部动态值} ──► 替换 ──► 替换
slots.update(...)
  └─ 增量 {gen, rev, 条目全局 id, 作用域键, 值|null} ──► 合入 ──► 合入，只重渲染该条目
                                静态表 {rev, 插件[...]} ─────► 替换
                                                    Renderer：静态表 ⊕ 运行状态 ⊕ 动态值 → 插槽
```

- 快照和增量共用同一个 `rev`，每代际内单调递增。接收方丢弃 `gen` 不同或 `rev` 不大于已有值的消息。
- 新连上的一方先收一份快照，再收增量。

**启动页「扩展」分区还显示扩展问题**（清单问题在静态表里，`failed` 在快照里）：

- 每个有问题的插件占一行，显示插件名和状态标签，悬停显示原因（带字段路径时显示路径）。优先级：`extension` 非法（`invalid`）或版本不兼容（`incompatible`）→ 激活失败（`failed`）→ 有不可用的插槽条目（标签「清单非法」，显示第一条的字段路径）。问题行只读，没有点击操作。
- 扩展进程已停止时（§12.1），分区顶部显示一行「扩展已停止」，带「重新加载」操作。视图条目照常显示，标签为「扩展已停止」，操作改为「重新加载」（§16.1）。问题行照常。
- 没有任何要显示的行时，分区不显示。

事实（`packages/ui/src/...`）：

- 用量圆环 `ChatContextUsage` 在 `V4ComposerModelControls` 里，位于模型选择器左边（`v4/composer/V4ComposerToolbar.tsx:1291-1346`）。`composer.status` 放在它前面。
  - 实现：插槽渲染在 `ConversationComposer` 里、紧挨 `V4ComposerModelControls` 之前，视觉上就是圆环左边。会话作用域取有效会话 `pluginUiSessionId`（正式会话，或草稿的预热会话），与插件 UI 同一来源；模型控件组只拿到正式会话 id，草稿时为空。
- 工具栏空间不足时按写死的档位 `["0","1","2","3"]` 依次收起（`prompt-editor/useComposerToolbarFit.ts:37`）。插件条目要**最先收起**，所以加一个排在 `"0"` 之前的档位。布局契约在 `composer-toolbar-layout/CONTRACT.md`，要同步更新。
- 启动页由 `openTabLauncher` 渲染（`app-shell/AnimatedSidePanePanel.tsx:824-891`），每行是 `SidePaneLauncherRow`。扩展分区复用同一个行组件。现有「UI 插件」分区只在有会话时显示，扩展分区不受这个限制。

样式规则写进 `DESIGN.md` 的「Extension slots」小节（P1 新增）。

## 7. 运行时 API

### 7.1 `ExtensionContext`

插件入口导出 `activate(ctx)`，可选导出 `deactivate()`。`ctx` 分两部分：本地部分在扩展进程内完成；能力部分由能力表生成，经 Window Host 执行。

```ts
export function activate(ctx: ExtensionContext): void | Promise<void>;
export function deactivate(): void | Promise<void>;

interface ExtensionContext {
  // —— 本地部分 ——
  extension: { id: string; version: string; path: string; dataPath: string }; // dataPath：§18.1 H6
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  commands: { register(id: string, run: (call: CommandCall) => unknown): Disposable };
  slots: { update(itemId: string, patch: SlotItemPatch, scope?: ScopeInput): void };
  views: {
    register(id: string, view: ViewDefinition | ViewServerFactory): Disposable; // §8
    open(id: string, scope?: ScopeInput): Promise<void>; // 能力 views.open，本地先校验 id
  };

  // —— 能力部分（P1） ——
  workbench: {
    visibleSessions(): Promise<WorkbenchSession[]>;
    onDidChange(listener: (e: { sessions: WorkbenchSession[] }) => void): Disposable;
  };
  env: {
    get(): Promise<{ locale: string }>; // §16.11
    onDidChange(listener: (e: { locale: string }) => void): Disposable;
  };
  models: { onDidGenerate(listener: (m: GenerationMetrics) => void): Disposable }; // §10
  context: {
    get(input: { sessionId: string }): Promise<ContextComposition | null>; // §9
    onDidChange(listener: (e: { sessionId: string; revision: number }) => void): Disposable;
  };
}

// 扩展传入的作用域。传 sessionId 即可，宿主补全工作区。省略时为 "app"。
type ScopeInput = "app" | { workspace: WorkspaceRef } | { sessionId: string };

// 宿主传给扩展的作用域（命令调用、视图实例、事件）一律是补全后的形式。
type ResolvedScope =
  | { kind: "app" }
  | { kind: "workspace"; workspace: WorkspaceRef }
  | { kind: "session"; workspace: WorkspaceRef; sessionId: string };

interface WorkbenchSession {
  sessionId: string;
  workspace: WorkspaceRef;
  isDraft: boolean;
  focused: boolean;
}
```

规则：

- `id` 必须在清单里声明过，否则 `register` / `update` / `open` 抛 `not-declared`。
- 所有注册与监听返回 `Disposable`，挂在扩展生命周期上，停用时自动回收。
- `ctx` 及其子对象冻结。扩展停用后再调用，抛 `disposed`。
- 跨进程的调用一律返回 Promise。
- 宿主传给扩展的作用域由 Window Host 校验后补全，扩展与页面不能伪造。
- 会话 id 是 `sess_<uuid>`，全局唯一。所以 `slots.update` 的会话作用域只需要 `sessionId`，不需要先查工作区。
- 扩展代码里的未捕获错误只记日志，并标明所属插件（用 `AsyncLocalStorage` 归因），不让进程退出。扩展调用 `process.exit` 会抛错。
- P1 没有写会话的能力。`ctx.sessions` 留给 P3 的会话读写（§14）。
- 命令收到的参数是 `CommandCall = { scope: ResolvedScope; args? }`。`composer.status` 点击时作用域为当前会话（草稿为预热会话），没有会话时为工作区，没有 `args`，返回值被忽略。`composer.mention` 的查询带 `args = { query }`，命令返回候选项（§16.6）。
- `ctx.views.open` 是能力 `views.open` 的本地包装：先在扩展进程内校验视图 id 已声明（否则抛 `not-declared`），再经能力网关调用。能力表用 `LOCALLY_WRAPPED_CAPABILITIES` 标出这类能力，`ctx` 的通用生成跳过它们。

错误统一是 `ExtensionError`，带稳定的 `code`。不依赖错误文本做判断：

| `code`             | 含义                                                        |
| ------------------ | ----------------------------------------------------------- |
| `not-declared`     | id 没有在清单里声明                                         |
| `invalid-input`    | 入参不符合能力表的 schema                                   |
| `disposed`         | 扩展已停用                                                  |
| `host-unavailable` | 当前没有已连接的 Window Host（Window Host 重启、窗口关闭）  |
| `internal`         | 宿主内部错误，原始原因进日志                                |
| `not-granted`      | 清单声明了档位，用户还没有授予（P3，§17.7）                 |
| `incompatible`     | 清单声明的协议版本与宿主不一致（P3，§17.6）                 |
| `forbidden`        | 目标不在授权范围内（P3，session-control `forbidden`）       |
| `unavailable`      | 目标或宿主能力暂不可用（P3，session-control `unavailable`） |
| `conflict`         | 与 owner 当前状态冲突（P3，session-control `conflict`）     |
| `cancelled`        | 调用被取消：换代、断开或撤销授权（P3）                      |
| `limit-exceeded`   | 超过上限，例如同时在途的 wait（P3）                         |

### 7.2 能力表

能力表在 `extension-host-protocol` 里定义，是能力的唯一定义。每一行：

```ts
interface CapabilityDef {
  id: string; // "<命名空间>.<名字>"，例如 "context.get"
  kind: "call" | "subscribe";
  input: ZodType; // 入参 schema
  output: ZodType; // call 的返回，或 subscribe 的事件
  backend: "service" | "pump" | "renderer"; // §3.5 的三块
  grant: "none" | "sessions.read" | "sessions.write"; // P3 起有需要授权的档位，write 包含 read（§17.3）
  protocol?: "sessions" | "rows"; // 返回值属于哪个稳定投影（§17.6）
}
```

P1 的能力（P2a 加了 `env.*` 两行，P2d 加了 `settings.*` 两行，P4 加了 `settings.update` 与 `workbench.startDraft`）：

| id                          | kind      | 后端     | 入参                 | 返回 / 事件                        |
| --------------------------- | --------- | -------- | -------------------- | ---------------------------------- |
| `context.get`               | call      | pump     | `{ sessionId }`      | `ContextComposition \| null`       |
| `context.onDidChange`       | subscribe | pump     | —                    | `{ sessionId, revision }`          |
| `models.onDidGenerate`      | subscribe | pump     | —                    | `GenerationMetrics`                |
| `workbench.visibleSessions` | call      | renderer | —                    | `WorkbenchSession[]`               |
| `workbench.onDidChange`     | subscribe | renderer | —                    | `{ sessions: WorkbenchSession[] }` |
| `workbench.startDraft`      | call      | renderer | `{text, workspace?}` | 无（P4 H2，§18.1）                 |
| `env.get`                   | call      | renderer | —                    | `{ locale }`（P2a，§16.11）        |
| `env.onDidChange`           | subscribe | renderer | —                    | `{ locale }`（P2a，§16.11）        |
| `views.open`                | call      | renderer | `{ viewId, scope? }` | 无                                 |
| `settings.get`              | call      | service  | —                    | `{ values }`（P2d，§16.7）         |
| `settings.onDidChange`      | subscribe | service  | —                    | `{ values }`（P2d，§16.7）         |
| `settings.update`           | call      | service  | `{values?, clear?}`  | 无（P4 H1，§18.1）                 |

- 能力表 `EXTENSION_CAPABILITIES` 以能力 id 为键，所以行里不再重复 `id` 字段。`ctx` 能力部分的类型由表推导（`CapabilityContext`），表为空时为空对象。
- `extension-window` 频道在 `@zcode/rpc` 的 ProxyChannel 上暴露为 `call` 与 `onDynamicSubscribe`（ProxyChannel 的动态事件命名约定），语义就是表里的 `call` / `subscribe`。
- **扩展进程侧**：`ctx` 的能力部分按 `kind` 由同一组通用包装生成。`call` 包成 `(input) => Promise<output>`；`subscribe` 包成 `(listener) => Disposable`。第一个监听注册时向 Window Host 订阅，最后一个回收时退订。每个 `ctx` 按插件创建，调用自动带上插件 id。
- **Window Host 侧**：能力网关收到 `call` / `subscribe` 后，依次查表、按 `input` 校验、查授权、写审计，再分派给处理函数。处理函数表写成 `satisfies CapabilityHandlerMap`（即 `{ [K in CapabilityId]: CapabilityHandler<K> }`），少写一个就编译失败。审计按 debug 级别记日志。
- Window Host 重新连上后，扩展进程侧自动重新订阅仍在监听的能力。`workbench.onDidChange` 重新订阅后的第一个事件是整份列表。
- P1 的能力都只读，只给名字和大小，不给正文，所以 `grant` 都是 `none`。`settings.*` 只给调用方自己插件的设置（含敏感值，用户决策），也是 `none`；`settings.update` 只写调用方自己的插件，也是 `none`（P4，§18.1）。需要授权的能力从 P3 开始（§14）。
- `workbench.*` 与 `context.get` 都读 Renderer 的最近一份报告（③）。Renderer 只报告本机工作区的主对话窗格（不含只读观察视图、辅助对话、远程工作区），每项是有效会话（草稿为预热会话）、工作区、是否草稿、是否焦点，草稿另带所选模型。窗格、焦点或草稿模型变化时整份报告，同一轮事件循环里的多次变化合并成一次，内容没变不发。
- `context.get` 的会话不在报告里时返回 `null`：Window Host 不知道它的工作区，也就没有可查的 CLI。
- 已知局限：分屏的 solo 模式隐藏的窗格仍挂载，仍算在报告里。
- 新增一个能力只改两处：表里加一行，网关里加一个处理函数。`ctx` 与类型包自动跟上。

### 7.3 按插件授权不是安全边界

所有扩展在一个进程里（§2），一个插件可以冒充另一个插件调用网关。所以：

- 真正的边界是**能力表加用户授权**：扩展进程整体只能做表里有、并且用户授权过的事。
- 按插件的授权与审计用于归因和防误用，不防恶意插件。
- 后果：安装任何一个带扩展的插件，等于让它拿到「已授予任一插件」的全部能力。P3 的授权界面与开发者文档必须写明。

### 7.4 类型的唯一定义

`ExtensionContext` 接口、能力表、作用域、错误码都在 `extension-host-protocol` 里定义。

- 扩展进程的运行时用 `satisfies ExtensionContext` 钉住，接口与实现不会漂移。
- P3 的类型包 `@zcode-dev/plugin-api` 从这里导出，不手写第二份。

## 8. 扩展视图

扩展视图的页面是 MCP App 页面，后端是扩展进程里的一个 MCP server。扩展有两种写法，之后走同一条路径：

```ts
// 写法一（默认）：宿主帮手。插件不依赖 MCP SDK。
ctx.views.register("context", {
  entry: "./dist/view.html", // 相对插件根目录，每次打开视图时读取
  tools: {
    snapshot: {
      description: "读取当前组成",
      inputSchema: { type: "object", properties: {} }, // 普通 JSON Schema
      run: async (input, call) => ctx.context.get({ sessionId: call.view.sessionId! }),
    },
  },
  resources: {
    "ui://context-inspector/state": { read: async (call) => JSON.stringify(state) },
  },
});
// 有变化时：view.notify("ui://context-inspector/state")

// 写法二（高级）：返回自己的 McpServer，完全控制 MCP 行为。
ctx.views.register("context", (view) => createMyMcpServer(view));
```

```ts
interface ViewDefinition {
  entry: string;
  onDidOpen?(view: ViewInstance): void | Promise<void>; // 实例打开时调用（P2a，§16.11）
  tools?: Record<string, ViewTool>;
  resources?: Record<string, ViewResource>;
}
interface ViewTool {
  description?: string;
  inputSchema?: JsonSchemaObject; // 宿主原样放进 tools/list，不替插件校验入参
  run(input: unknown, call: ViewCall): unknown | Promise<unknown>;
}
interface ViewResource {
  mimeType?: string;
  read(call: ViewCall): string | Promise<string>;
}
interface ViewCall {
  view: ViewInstance;
}
interface ViewInstance {
  id: string; // 实例 id，每次打开唯一
  viewId: string; // 清单里声明的视图 id
  scope: ResolvedScope;
  sessionId?: string; // scope 是会话时的简写
  input?: { kind: "file"; path: string; workspace: WorkspaceRef }; // file.viewer 打开时（§16.5）
  notify(uri: string): void; // 只发给订阅了该 uri 的页面
  onDidClose(listener: () => void): Disposable;
}
type ViewServerFactory = (view: ViewInstance) => McpServerLike | Promise<McpServerLike>;
```

- 宿主把 `ViewDefinition` 在内部包成一个 MCP server，替插件处理 `resources/subscribe`。两种写法之后都用进程内 transport 连一个 MCP Client，走下图的同一条路径。
- 页面资源固定在 `ui://<pluginId>/<viewId>`。写法一由宿主从 `entry` 提供；写法二由插件的 McpServer 在这个 URI 上注册。
- 写法二注册工具时，`inputSchema` 必须是 MCP SDK 要求的 Standard Schema（如 zod 对象）。传裸 JSON Schema 会在注册时抛错，开发者文档要写明。写法一没有这个问题。

```text
Renderer                Window Host                 扩展进程
扩展视图标签页
  │ prepareView ──────►  openView ────────────────►  调扩展注册的视图
  │                      │                            （写法一由宿主包成 McpServer）
  │                      │                            用进程内 transport 连一个 MCP Client
  │                      │ ◄── HTML + 资源 meta ───── 读 ui://<pluginId>/<viewId>
  │                      │ 登记沙箱（contentKind:"extension"）
  │ ◄── 沙箱句柄 ─────── │
  │
  │ 页面的 tools/call、resources/*
  │ viewRequest ───────► viewRequest ─────────────►  Client 调 McpServer
  │ ◄────────────────── 结果 ◄──────────────────────
  │ ◄── viewNotification（resources/updated 等，按实例路由）
```

- **沙箱**：复用现有插件沙箱（`packages/desktop/src/main/pluginSandbox/`）。新增 `contentKind: "extension"`，这一类登记时不填 `sessionId`。
  - 事实：沙箱的 origin 和 partition 只由 `appIdentity` 派生（`pluginSandbox/registry.ts:150-162`）；`sessionId` 只进幂等键与记录，没有隔离或清理逻辑依赖它（同文件 `:60-82`）。所以去掉它不削弱隔离。
  - `appIdentity` 按插件派生：同一插件的视图共享存储，不同插件隔离。
- **标签页**：新增侧栏标签类型 `extension-view`，工作区级。
  - 事实：现有 `plugin-ui` 标签必须带 `parentSessionId`，按会话可见（`plugin-ui/contract.ts:72-89`、`lib/workspaceSidePane.ts:1172-1177`），所以扩展视图不能复用它。
  - 可见规则照 `developer-tools`：按工作区可见，草稿发送首条消息、切换会话后保留。
  - 同一视图在一个窗格只开一个标签。
- **`views.open`**：Window Host 经 `IExtensionViewsService` 的事件请 Renderer 打开，Renderer 打开后回执。作用域是会话时，在显示该会话的窗格打开；不在屏幕上时，在焦点窗格打开。
- **实例生命周期**：标签页组件挂载时创建实例，卸载时关闭。扩展进程换代（`gen` 变化）后旧实例全部失效，标签页按新代际重建。
- **页面 API**：页面经现有的 MCP App 页面层（`window.zcode`）读写，与 MCP App 页面一致。页面不能直接调用 `ctx`。

实现（2b）：

- **门面**（P2b 拆分）：视图的六个方法（`prepareView`、`viewRequest`、`closeView`、`onDynamicViewNotifications`、`onDynamicViewOpenRequests`、`ackViewOpen`）在 `IExtensionViewsService`（`extensions-service/views/contract.ts`，频道 `extension-views`），不在 `IExtensionsService`。原因：架构门禁限制每个 `contract.ts` 最多 12 个公开方法，P2 的入口、设置与日志还要往 `IExtensionsService` 加方法。两个门面是同一个 Window Host 实现、同一份状态，只是两个频道；都只在桌面本机 Host 注册，不在手机远控白名单里，Renderer 用同一个开关创建两个代理。P4 在视图门面加了 `workbench.startDraft` 的请求与回执两个方法（`onDynamicDraftRequests`、`ackDraftRequest`，§18.1 H2）。
- **实例**：Renderer 的标签页挂载时调 `IExtensionViewsService.prepareView({ viewId, scope, ownerWebContentsId })`。Window Host 生成实例 id，调扩展进程 `openView`（必要时按 `onView` 激活），扩展进程建 server 与进程内 Client、读 `ui://<pluginId>/<viewId>` 返回原始 contents；Window Host 用 MCP App 的同一套 HTML 挑选与限额（`pickHtmlResource`）取 HTML 与资源 `_meta`，再登记沙箱。返回 `{ instanceId, gen, sandbox }`。
- **请求与通知**：页面的 `tools/list`、`tools/call`、`resources/list`、`resources/templates/list`、`resources/read`、`resources/subscribe`、`resources/unsubscribe`（`EXTENSION_VIEW_REQUEST_METHODS`，表外拒绝）经 `viewRequest` 按实例 id 转给该实例的 Client。server 的 `resources/updated`、`resources/list_changed`、`tools/list_changed` 经 `onDynamicViewNotifications({ instanceId })` 回页面。订阅在请求层记账，两种写法共用：`view.notify(uri)` 只在该实例订阅了 uri 时发出，Renderer 侧也只把 `resources/updated` 投给订阅了它的页面。
- **取消**：不为单个请求设计取消方法。关闭实例（`closeView`）时 Client 关闭，在途请求随之失败。
- **凭证与沙箱**：Window Host 签发实例凭证 `{ runtimeId: "extension-host:<gen>", generation: gen, appIdentity: sha256(["extension-view", pluginId]), token: 实例 id }`，登记 `contentKind: "extension"`，带 `pluginId`，不带 `sessionId` 与 `serverName`，也不能声明原生权限（camera 等）。`scopeId` 为 `extension-view:<实例 id>`。沙箱注入的 `window.zcode` 兼容层与 MCP App 相同。
- **SDK**：扩展进程用 `@modelcontextprotocol/client` 的 `Client` 与 `InMemoryTransport`，写法一用 `@modelcontextprotocol/server` 的低层 `Server`。Client 的读与列表一律不走 SDK 缓存（`cacheMode: "bypass"`），页面每次读到最新值。SDK 内联进扩展进程产物，不依赖安装包的 node_modules 布局。
- **作用域**：产品只有一个侧栏。实例作用域跟随侧栏当前目标：焦点窗格的会话（草稿为预热会话），没有会话时为工作区。目标换到别的会话或别的工作区时，标签页按新作用域重建实例；草稿发送首条消息时会话 id 不变，实例保留。
  - 草稿首发交接期间窗格的会话不消失（§16.11 修复），标签页按目标直接派生作用域，不需要「沿用上一个会话」。
- **`views.open`**：Window Host 补全作用域（会话不在报告里时按 `app`），经 `onDynamicViewOpenRequests` 请 Renderer 打开，Renderer 在当前工作区的侧栏打开或聚焦该视图标签后 `ackViewOpen`。没有 Renderer 订阅时直接返回 `host-unavailable`；Renderer 断开时在途请求失败，不靠超时。视图不在 Renderer 的静态表里时回执失败（`internal`）。
- **视图声明**：P2a 起在静态表里（§16.1）。`prepareView` 从 Window Host 的静态表查视图；标签页按静态表判断视图是否存在，按贡献表快照的 `gen` 判断扩展进程是否连上。
- **换代**：扩展进程换代或 Window Host 断开时，扩展进程关闭全部实例，Window Host 作废实例记录；标签页看到贡献表快照的 `gen` 变化后按新代际重建。扩展停用时关闭它的全部实例。

## 9. context 组成

详细设计见 CLI spec：`apps/zcode-cli/docs/design/v2/model/context-composition.md`。要点：

- 扩展现有的 `buildContextUsageSnapshot`（`apps/zcode-cli/packages/core/src/runtime/methods/context-usage.ts:119-253`），修掉它的漏算，不另建第二套分解。
- 输入框用量圆环的线格式（`zcode-protocol-legacy-types.ts:499-514` 的 7 个类别枚举）**一字不改**。新增的细类别只出现在新的查询方法里。
- 新增 v4 查询方法与变更通知（只带修订号）。修订号的唯一 owner 是 CLI 协议层的 tracker。
- 草稿态返回首个请求的预演，没有副作用：不写历史、不让草稿变成持久会话、不发请求。
- App 侧接口：`IZCodeAgentService.getContextComposition`（existing-only，旧 CLI 返回 `null`）与 `onDynamicContextCompositionChanged`。类型 `ContextComposition` 从 `@zcode/shared/zcode-protocol-v4` 导入。

**模型只有一个来源。** Window Host 查询时：

- 会话是草稿（据 Renderer 的 `workbench` 报告）：带上 Renderer 报告的所选模型。草稿的模型只在 Renderer 里（§3.4）。
- 正式会话：不带模型。CLI 用会话自己的模型。
- 草稿换模型时 CLI 不知道，不会发变更通知。Window Host 在报告里看到草稿的所选模型变了，就为该草稿补发一条 `context.onDidChange`，`revision` 沿用该会话已知的最新 CLI 修订号（不自造修订号）。扩展收到通知即重新拉取，不按修订号去重。
- 通知订阅：有扩展订阅 `context.onDidChange` 时，Window Host 订阅报告里出现过的工作区，只增不减，没有扩展订阅时全部退订；订阅本身不启动 CLI。只增不减的原因：离开屏幕的工作区可能还有在途请求，它的通知也要收到。（P1 时草稿首发的报告空档也是原因之一，P2a 已在源头修掉，§16.11。）

数据流：

```text
CLI                         Window Host                扩展进程
 每次主轮请求、compact 完成、
 工具变化、前缀重建、换模型
   │ contextCompositionChanged {sessionId, revision}
   └─────────────────────►  能力 context.onDidChange ─►  ctx.context.onDidChange
                                                        │ 扩展决定是否刷新
                             能力 context.get ◄─────────┘ ctx.context.get({sessionId})
   ◄── v4/conversation/contextComposition ──┘
   （草稿带 Renderer 报告的模型；正式会话不带）
```

## 10. 生成速率（TPS）

- **流式估算**：Window Host 订阅 `stream.chunk` 遥测事实，按字符数估算 token（复用 `packages/shared/src/usage-stats.ts:9` 的除数常量），除以距本请求首个 chunk 的时间。最多每 500ms 推一次。
- **准确值**：请求结束后，用服务商返回的 output tokens 与首 token 时间算，复用现有的 `calculateOutputTps`（`packages/shared/src/session-debug.ts:86-101`），与开发者工具面板同一定义：生成时长 = `durationMs - timeToFirstContentMs`（两者都有且前者更大时），否则不出准确值（`bootstrap/src/zcode-protocol/session-debug.ts:103-106`）。数据来自 `model.request.metrics` 事实（见下）。
- 只统计主轮请求（`querySource === "main_turn"`）。标题生成、compact 等旁路请求不计入。
- 没有扩展订阅 `models.onDidGenerate` 时，Window Host 不做聚合。有订阅时订阅 Renderer 报告里出现过的工作区，规则同 §9（只增不减）。

实现（2b）：

- `stream.chunk` 不带 `requestId`。Window Host 按会话记当前主轮请求：`model.request.status` 的 `model_request_started`（`querySource === "main_turn"`）开始，`completed` / `failed` 结束，`model_retry_scheduled` 清零首个 chunk 时间与字符数。带 `parentToolCallId` 的子代理 chunk 不计。
- 首个 chunk 时间与经过时间都用事实的 `occurredAt`（CLI 时钟）。经过时间不大于 0 时不出速率：回放或批量到达的流可能同一时刻到达。500ms 节流用 Window Host 本地时钟，只在 chunk 到达时判断，不设定时器。
- 准确值只在 `calculateOutputTps` 有结果时推送（`model.request.metrics` 的 `querySource === "main_turn"`）；没有准确值时扩展保留最后一次流式估算。

```ts
interface GenerationMetrics {
  sessionId: string;
  workspace: WorkspaceRef;
  requestId: string;
  model: { providerId: string; modelId: string };
  phase: "streaming" | "final";
  outputTokensPerSecond: number;
  outputTokens?: number; // final 时为服务商报告值
  timeToFirstTokenMs?: number; // final 时提供
}
```

事实：

- 遥测事实全部 live-only（`zcode-protocol-v4/transport.ts:434-435`），App 经 `onDynamicConversationTelemetryFact` 收（`services/src/zcode-agent/zcodeAgent.ts:1061`）。
- `stream.chunk` 的 `firstChunk` 按 part 判定，不是按请求（`bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts:424-447`）。Window Host 自己按 `requestId` 记首个 chunk 的时间。
- 模型 completed 事件有 usage 和 `timeToFirstContentMs`（`contracts/src/model/index.ts:217-229`），旧的 telemetry fact 丢掉了它们。
- 请求用途能区分：`model.request.status` 带 `querySource`（主轮 `main_turn`，标题 `session_title`，compact `compact`，子代理 `subagent` 等，来自请求 trace 属性）。`usage.delta` 不带 `querySource`，不用它算 TPS。

**P1 的处理（兼容性决定）**：精确数据不加进现有的 `model.request.status`，改为一条独立的 live 事实 `model.request.metrics`，走新通知 `v4/telemetry/model-request-metrics`。

- 原因：`conversationTelemetryFactSchema` 每个分支都是 `.strict()`。旧 App 解析到未知字段时整条事实 `safeParse` 失败，记一条 warn 并**丢弃整条事实**（`services/src/zcode-agent/zcodeAgentService.ts:2730-2745`）。远程工作区的 CLI 可以比 App 新；往 completed fact 加字段会让旧 App 丢掉全部 `model.request.status`，埋点断掉。往同一通知加新的 `kind` 也会让旧 App 每个请求记一条 warn。
- 旧 App 遇到不认识的通知方法时，通知处理链没有匹配分支，直接忽略，不记日志。所以新通知对旧 App 无影响；新 App 对旧 CLI 收不到这条通知，Window Host 只有流式估算。
- 形状与触发规则见 [V4 对话埋点兼容规范](../monitoring/conversation-telemetry-v4.md) 的「模型请求指标」。App 侧经 `IZCodeAgentService.onDynamicModelRequestMetrics` 订阅。

## 11. 示例插件 context-inspector

> 迁移（2026-11-07，[插件发布](./plugin-publishing.md) §6）：源码在市场仓库 `zcode-plugins` 的 `ui-plugins/context-inspector`，从插件商店安装，插件 id 带市场 id。z-code 里的示例与用例 PLM-EXT-2C 已删除；它断言的宿主能力移到 fixture 用例 PLM-EXT-2B（对照表见 [覆盖矩阵](../testing/plugin-management-lifecycle-e2e-coverage-matrix.md) 的「示例插件迁出」）。插件自己的页面只做构建、清单校验与人工验收（[插件发布](./plugin-publishing.md) §6.1）。下文是它的设计，记录宿主能力怎么用。

以前放 `examples/plugins/context-inspector/`，经 `~/.zcode/cli/config.json` 的 `plugins.dirs` 加载（用户决策：仓库内本地插件，不做内置），插件 id 是 `context-inspector@inline`。

- 输入框圆环左边显示当前会话主轮请求的 `tok/s`（`composer.status`，按会话作用域设置）。只显示请求结束后的准确值（`phase: "final"`，服务商报告的 output tokens ÷ 生成时长）；流式阶段的估算不显示，插槽保持上一次请求的准确值（用户决策，2026-11-06：输出过程中不用估算）。宿主的 `models.onDidGenerate` 仍推流式估算（§10），这是插件的选择。悬停说明是模型 id、速率、输出 token 数与首 token 时间，按 App 语言本地化（`ctx.env`：中文「输出 N tok · 首 token 用时 X 秒」，英文「N output tok · TTFT X s」）；语言变化时扩展按 `env.onDidChange` 重写每个会话最近一次的说明。点击执行命令，经 `ctx.views.open` 打开 context 视图。会话还没有生成过时不设置文字，插槽不显示（§6「只在设置了 `text` 时显示」）。
- 启动页「扩展」分区打开「上下文组成」视图：模型、阶段（预演 / 最近请求）、估算总量与上下文窗口、剩余 token、按类别的比例条，以及类别列表（中英文名称、token、占比）。展开类别显示占用最多的条目（工具名、技能名、指令文件），默认 8 条，其余点「再显示 N 项」。草稿态显示首个请求的预演；正式会话换模型后显示下一个请求的预演；请求后显示该请求的组成。
- 视图的数字（用户决策，2026-11-06：总量与 App 输入框用量圆环对齐）：
  - 总量：最近请求有 `providerContextTokens` 时用它。它与圆环的「已用」（V4 状态 `usage.contextWindow.usedTokens`，`packages/ui/src/chat-input-toolbar/contextUsage.tsx` 的 `renderableTaskUsage.used`）由 CLI 用同一个函数、同一份服务商 usage 算出（`getModelUsageContextTokens`），所以相等：input + 这次回复的 output。插件不自己用 input 加 output 再算。
  - 只有 `providerInputTokens`（旧 CLI）时总量用它，比圆环少这次回复的 output。两个都没有时（预演，或服务商没报 usage）总量是 CLI 估算值，旁边标「估算」/「Estimated」。
  - 已用比例、剩余 token、比例条的空白段都按这个总量算：剩余 = `max(0, contextWindow - 总量)`。
  - 类别 token：CLI 估算的占比分摊到服务商的 input（`round(类别估算 × providerInputTokens / 估算总量)`），条目同样分摊。类别列的列头标「估算」/「Estimated」。
  - 「最近一次回复」：`providerContextTokens - providerInputTokens` 大于 0 时，类别列表最后加一行（「最近一次回复」/「Latest reply」），是服务商报告的 output tokens，不带条目。它会进下一次请求的上下文。
  - 占比列都按总量算，所以各行加起来是 100%（只差取整）。
  - 总量用了服务商数字时，底部右侧另起一项显示 CLI 的原始估算总量（「估算 2.7万」/「Estimated 27K」），供对照。
  - CLI 的估算与服务商计数可能差很多：实测一个会话估算 2.7万，服务商报告 1.4万。改进估算器不在这次范围。
  - 页面把总量来源写进 `body` 的 `data-headline`（`provider` / `estimate`）、`data-total`（总量）、`data-estimated`（原始估算），E2E 读 DOM 与圆环对照。
- 视图用写法一（宿主帮手），不依赖 MCP SDK：
  - 工具 `snapshot` 返回 `{ status, sessionId, isDraft, composition }`，资源 `ui://<pluginId>/context/state` 只作变更信号。
  - 视图看的会话：实例作用域是会话时就是它（侧栏跟随焦点窗格，换会话时宿主重建实例，§8）；作用域是工作区或 App 时取其中的焦点会话。
  - 实例在 `onDidOpen` 里登记、`onDidClose` 时移除（§16.11）。
  - 刷新只靠事件：`context.onDidChange` 命中视图的会话，或 `workbench.onDidChange` 里视图目标（会话、是否在报告里、是否草稿）变了，扩展调 `view.notify`；页面收到 `resources/updated` 后重新调 `snapshot`，同一时刻只有一次在途，期间的通知合并成结束后的一次。不轮询。
  - 状态：`ready`；`unsupported`（会话在 workbench 报告里但 `context.get` 返回 `null`：旧 App 或旧 CLI，或会话还没有可用模型），页面显示「当前版本不支持上下文组成」；`unavailable`（会话不在报告里，如远程工作区）；`no-session`。草稿首发时会话一直在报告里（§16.11），页面不需要保留上一份组成。
- 页面样式：语言取 hostContext 的 `locale`（`zh` 开头用简体中文，其余英文）；颜色、字号、圆角都取 hostContext 的样式变量，主题切换时随 `host-context-changed` 更新。比例条与类别按 token 降序，色阶由宿主前景色在背景色里的占比生成（占比越高越深，与圆环同一排序规则），不写死品牌色。页面状态写在 `body` 与类别行的 `data-*` 属性上，排查与 E2E 读 DOM。
- 构建（迁移前，在 z-code 里）：`node examples/plugins/context-inspector/build.mjs` 用仓库根目录的 esbuild 把 `src/extension.ts` 打成 ESM 的 `dist/extension.js`，把页面脚本 `src/view/main.ts` 打成 IIFE 内联进 `dist/view.html`（沙箱页面不能加载插件目录里的其他文件）。每次构建先清空 `dist/`。源码只有类型导入（`@zcode/shared/extension-host`、`@zcode/shared/zcode-protocol-v4`），产物自包含，插件目录里不需要 `node_modules`。插件根目录的 `package.json` 声明 `"type": "module"`（扩展进程按 ESM 加载 `main`）。`dist/` 不入 git。
- 类型检查（迁移前）：示例的 `tsconfig.json` 引用 `packages/shared`，按真实的 `ExtensionContext` 与 `ContextComposition` 编译；根目录 `pnpm typecheck` 的 `tsc -b` 列表包含它。迁移后从 npm 安装 `@zcode-dev/plugin-api`，在市场仓库里构建，根目录 typecheck 不再包含它。
- 插槽文字只有数字与单位，中英文通用；悬停说明经 `ctx.env` 本地化（P2a，§16.11）。

## 12. 生命周期

### 12.1 扩展进程

```text
       spawn
  ──────────────► ready ─────────────► 连上 Window Host
                    │
   崩溃或卡死 ───────┤
                    ▼
   预算内？── 是 ──► 退避后重启（gen + 1）
        │
        否
        ▼
     已停止（不再自动重启；启动页显示「扩展已停止」）
        │
   重新加载 ──────► 清零预算，重启（gen + 1）
```

- 每次启动 `gen` 加一。旧代际的消息、连接、视图实例一律作废。
- 启动时机：首个 Window Host 报告服务就绪（L0 `extension-host/window-ready`）时拉起。没有 Window Host 就没有插件清单，提前拉起没有用处，也不进入首窗启动关键路径。
- Main 推给 Window Host 的状态：`starting`（正在启动：读网络设置、fork，还未就绪）、`running`、`restarting`（退避中）、`stopped`（预算耗尽）。
- **崩溃预算**：5 分钟内最多自动重启 3 次，退避 1s、2s、4s；第 4 次崩溃时停止，不再自动重启。上限从退避表的长度推出，两者只有一个来源。
- **存活探测**：Main 每 5 秒经 parentPort 发一次探测。连续 3 次（15 秒）没有回应，判为卡死：杀掉进程，计入崩溃预算。探测由扩展进程的事件循环回应，所以一个扩展写了死循环也能发现。所有构建行为相同（P1 不支持给扩展进程挂断点调试）。
- **环境变量白名单**：扩展进程不继承 Window Host 的环境（里面有遥测凭据与 OAuth 配置，`main/desktopRuntimeEnv.ts:160-172`）。只传：`PATH`、`HOME`、`USERPROFILE`、`TMPDIR`、`TEMP`、`TMP`、`LANG`、`LC_ALL`、`LC_CTYPE`、`SystemRoot`、`windir`、`APPDATA`、`LOCALAPPDATA`、`NODE_ENV`，以及 `ZCODE_PROCESS_LABEL=extension-host`。白名单在监管器里一处定义。代理、No Proxy 与 `NODE_EXTRA_CA_CERTS` 不在白名单里，只由设置页注入（见下一条）。
  - 事实：系统在子进程启动时还会注入少量键，不来自 Window Host 的环境，也不含凭据。macOS 上实测为 `MACH_PORT_RENDEZVOUS_PEER_VALDATION`（Chromium 子进程启动器）与 `__CF_USER_TEXT_ENCODING`（CoreFoundation）。白名单约束的是 Main 传给扩展进程的环境，不清理这些系统键。
- **网络跟随设置页**（P4 H3，§18.1）：监管器每次启动扩展进程前，经 Main 的设置服务读一次设置页的 HTTP 代理、No Proxy 与自定义证书（与 Window Host 读的是同一个 `~/.zcode/v2/setting.json`）。翻译方式与 CLI 给工具子进程的相同（`apps/zcode-cli/packages/adapters/src/network/subprocess-env.ts`）：
  - 代理：裸 `host:port` 补 `http://`，写 `HTTP_PROXY`、`HTTPS_PROXY` 与两个小写形式。No Proxy：按逗号拆开、去掉空项，写 `NO_PROXY`、`no_proxy`。证书路径写 `NODE_EXTRA_CA_CERTS`。
  - 只认设置页（用户决策，2026-11-05）：和 CLI 一样，代理、No Proxy 与证书只来自设置页；设置页留空就直连，不读 shell 环境里的同名变量。两种大小写都写（Node 的环境代理小写优先）；Windows 的变量名不分大小写，只写一份。读设置失败时记一条 warn，按留空处理（直连）。日志只记每项是否由设置页配置，不记地址与路径。
  - 扩展进程启动时、加载任何扩展之前调一次 `http.setGlobalProxyFromEnv()`（Electron 44 的 Node 24.21 提供，无需替代方案），全局 `fetch` 与 `http(s).request` 从此走环境代理并遵守 No Proxy。这是全局状态，只由宿主调。代理地址不合法时只记错误码，扩展照常加载，请求直连。`NODE_EXTRA_CA_CERTS` 由 Node 在进程启动时读取，utilityProcess 实测生效（Electron 44.7.0：自签 CA 的 https 请求在设置后成功，未设置时报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`；PLM-EXT-H3 里经 MITM 代理、环境里是另一个 CA 时报 `CERT_SIGNATURE_FAILURE`）。
  - 改设置后经「重新加载扩展」生效（每次启动都重读），App 重启也生效。扩展插件的 MCP 服务由 CLI 启动，网络由 CLI 注入，不经这里（§18.2「网络」）。
  - 日志只记每项的来源：`network proxy=settings|env|none noProxy=… ca=…`，扩展进程另记 `environment proxy: enabled|not configured`。不记地址与路径：代理地址可能带账号密码。
  - 读设置是异步的：`starting` 状态在读设置之前就推出（含义是「正在启动，还未就绪」）；读的期间又有重启或退出时，这一代作废，不再 fork。
- **计划重启**：已激活扩展的清单变了（升级、改清单），Node 无法卸载已加载的模块，由扩展进程请求 Main 重启。计划重启不计入崩溃预算。
- **重新加载**：命令中心 `app` 分区加「重新加载扩展」（`packages/ui/src/quickpick/quickPickCommands.ts`），启动页「扩展已停止」一行也有这个操作。链路：Renderer → `IExtensionsService.reload()` → Window Host 经 parentPort 发给 Main → Main 做计划重启，并清零崩溃预算。不经过扩展进程，所以扩展进程卡死或已停止时也能用。开发插件时改完代码，用它代替重启整个 App。
- **Window Host 断开**：能力调用返回 `host-unavailable`，订阅暂停。扩展代码照常运行，动态值保留在扩展进程内存里。Window Host 重新就绪后 Main 重新牵线，扩展进程推一份完整快照，并重新订阅仍在监听的能力。
- **退出**：接入 `prepareAppQuit` 的并行收口（`main/index.ts:1287-1332`）。Main 发 dispose，扩展的 `deactivate` 共用 1 秒预算，Main 在 1.5 秒后强杀。
- **日志**：扩展进程经 parentPort 发日志，Main 以 `[extension-host]` 前缀写进 `~/.zcode/v2/logs/<日期>.log`，照 `hostLogRelay.ts`。同一行同时进监管器的环形缓冲，供日志控制台使用（§16.8）。
- **构建**：照 scheduler 加 tsup 目标（`tsup.config.ts:378-406`）、`tsconfig.extension-host.json`、dev ready 标记、E2E 产物清单（`scripts/ensure-e2e-desktop-build.mjs:30-66`）、`desktopRuntimeEnv.ts` 的模块路径。
  - `resourceManagerWindow.ts` 的资源角色登记推迟：新增角色要改共享的 `PROCESS_RESOURCE_ROLES`（`shared/src/processResourceTelemetry.ts`），即资源埋点的 `process_role` 取值，属于埋点变更，需单独按埋点流程验收。在此之前扩展进程的资源计入 `chromium_other`。
  - 事实：scheduler 现在有几处不一致——dev ready 标记的类型不含它（`tsup.config.ts:238`），`scripts/dev.mjs:14-16` 只等三个标记，生产构建清理列表没有它（`run-production-build.mjs:14-25`）。扩展进程不复制这些遗漏。

### 12.2 单个扩展

- **激活是事务**：`activate` 期间的注册先缓存，成功返回后一起生效。抛错或超过 10 秒，全部丢弃，扩展进入 `failed`，本次扩展进程内不再激活。原因写进快照，启动页可见（§6）。
- 状态：`resolved` → `activating` → `active`；或 `failed`、`invalid`（清单不合法）、`incompatible`（`engines.zcode` 不兼容）。
- 激活时机：
  - `onAvailable`：扩展在本扩展进程里第一次出现在插件清单中时激活。App 启动、运行中安装或启用、计划重启或重新加载之后，都满足这一条。
  - `onCommand`：首次执行命令时激活。
  - `onView`：首次打开视图时激活。

## 13. 插件清单与变更

- Window Host 用 `IPluginManagementService.listPlugins({ configScope: "user" })` 读已启用插件，交给扩展进程：插件 id、名称、版本、根目录。设置值不随声明下发，扩展经能力 `settings.*` 读（§16.7）。过滤条件：`enabled`、`enabledSource` 不是 `workspace`、包已物化（没有 `packageStatus: "missing"`）。Window Host 读各插件的 `plugin.json` 并校验，扩展进程只收合法兼容的扩展声明（§16.1）；P1 时由扩展进程自己读。清单目录优先级与 CLI 相同（`.zcode-plugin`、`.claude-plugin`、`.codex-plugin`）。
- 每次 Main 牵线（新代际或 Window Host 重连）后 Window Host 推一次整份扩展声明。
- 变更信号来自 Window Host 插件管理服务的成功返回（§3.4）。Window Host 重读静态表并重推整份扩展声明，扩展进程对比后激活新出现的扩展，停用消失的扩展；已激活扩展的声明变了就请求计划重启（§12.1）。

**决策（已确认）**：扩展没有工作区级别，默认全局。只认**用户级启用**。理由：

1. 扩展进程是全 App 唯一的，不属于任何工作区，无法做到「工作区 A 启用、工作区 B 停用」。
2. 远程工作区的插件包在远端主机，本机扩展进程拿不到。
3. 工作区配置可以进 Git（`docs/plugins/workspace-level-plugin-architecture.md` §1）。让克隆的仓库决定本机常驻进程跑哪段代码，风险过大。

工作区级启用仍然控制 MCP、技能这些按会话加载的组件，只是不激活扩展代码。

## 14. 后续阶段要点

每个阶段动工前先补全本节对应的设计，再实现。新能力一律按 §3.5 找后端，按 §7.2 加进能力表。

- **P2 插件入口、设置与日志控制台**：详细设计见 §16。
- **P3 插件操作会话与类型包**：详细设计见 §17。
- **P4 示例插件与文档**：详细设计见 §18。开发者文档推迟到 P3d 之后。
- **插件发布**：类型包发布、版本门槛、示例插件迁到市场仓库，见[插件发布](./plugin-publishing.md)。
- **P5 其他能力暴露**：插件管理、定时任务、MCP 配置、模型与 provider，后端都是 ① 现有服务（§3.5），只往能力表加行。MCP 配置只接 Window Host 的 `IMcpSyncService`，不接 Main 那份，也不加第三份。

## 15. 验收（P1）

新增桌面 E2E，放 `packages/desktop/test/e2e/plugins/manual-review/pending/`，用隔离 HOME 和 `plugins.dirs` 加载插件。全部在桌面端真实跑通才算完成。

| 项   | 用例                                                                                            | 插件                                                                       |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1–3  | PLM-EXT-2C（2026-11-07 随示例迁出删除）；宿主一侧由 PLM-EXT-2B 覆盖                             | 示例在市场仓库 `ui-plugins/context-inspector`，人工验收                    |
| 4–10 | PLM-EXT-2A `plugin-extension-host-runtime.test.ts`、PLM-EXT-2B `plugin-extension-views.test.ts` | 纯 JS fixture 插件（死循环、清单非法、版本不兼容、环境变量需要专门的插件） |

第 9 项的截图两边都有：2C 是示例的视图与 `composer.status`，以及窄工具栏收起；2A / 2B 是 fixture 插件的插槽、启动页与视图。场景与证据见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 与 [覆盖矩阵](../testing/plugin-management-lifecycle-e2e-coverage-matrix.md)。

1. 草稿态打开「新标签页」，扩展分区有「上下文组成」；打开后是 `extension-view` 标签，显示系统提示词、内置工具等类别，数值不为 0。**打开预演后草稿仍是草稿**（没有变成持久会话）。
2. 发送一条消息：流式阶段输入框出现 `tok/s` 并变化；结束后换成准确值。视图自动刷新，出现消息类别。
3. 切换模型：视图显示新模型。
4. 杀掉扩展进程：自动重启，插槽与视图重建。
5. 卡死与重新加载：一个测试插件在命令里写死循环。15 秒内被判卡死并重启；连续触发到预算耗尽后，启动页显示「扩展已停止」；从命令中心执行「重新加载扩展」后恢复。
6. 问题扩展可见：一个清单非法、一个版本不兼容的测试插件，在启动页分别显示「清单非法」（悬停有字段路径）与「版本不兼容」。
7. 环境变量：测试插件把 `process.env` 的键名写进日志。日志里只有白名单里的键。
8. 退出 App：扩展进程在退出收口内结束，没有残留进程。
9. 深浅主题、中英文截图。Web 与手机远控不显示插槽。
10. 运行时证据：日志里有扩展进程生命周期、激活、贡献表代际。流式期间贡献表快照的 `rev` 只因增量增加，没有整份快照推送。

## 16. P2：插件入口、设置与日志控制台

> 用户决策（2026-11-05）：静态声明移到 Window Host；入口统一写在清单顶层 `slots`；敏感设置值存进 CLI 私有文件；扩展只拿得到本插件的敏感值。

### 16.1 静态声明归 Window Host

P1 让扩展进程读 `plugin.json`，静态声明和动态值合成一份快照。扩展进程停止后快照清空，所有入口一起消失。P2 的入口还包括没有扩展代码的 MCP App 插件，它们不能因为别的扩展卡死而消失。

| 数据                                                                           | 唯一 owner                          |
| ------------------------------------------------------------------------------ | ----------------------------------- |
| 静态声明：`slots`、`extension` 的命令与视图、清单状态（invalid、incompatible） | Window Host 的 `extensions-service` |
| 扩展运行状态（activating、active、failed）与插槽动态值                         | 扩展进程                            |

```text
CLI plugins/list ──► Window Host：读每个插件的 plugin.json（异步），用协议模块的 schema 校验
                      → 静态表 {rev, 插件[清单状态, 条目, 命令, 视图]}
                      ├──► Renderer：静态表
                      └──► 扩展进程：只给带合法、兼容 extension 的插件（根目录、main、声明的 id）
扩展进程 ──► Window Host ──► Renderer：运行状态 + 动态值（gen/rev，与 P1 相同）
Renderer：静态表 ⊕ 运行状态 ⊕ 动态值 → 插槽
```

- 扩展进程停止：所有静态条目照常显示。target 是扩展（view、command）的条目显示「扩展已停止」，点击改为「重新加载」。MCP App 条目不受影响。
- 扩展进程不再读 `plugin.json`。只有一处解析。
- 重读时机：插件清单变化（启动、插件管理成功返回）与「重新加载扩展」。不监听文件变化。

实现（P2a，已完成）：

- **读与校验**：`extensions-service` 的 `manifestReader.ts` 按 CLI 的目录优先级异步读第一个存在的 `plugin.json`；协议模块的纯函数 `resolvePluginManifest` 校验并生成静态表的一项与扩展声明。插件清单里的每个插件都在表里，包括没有 `extension` 键的插件。
- **静态表形状**（`extension-host-protocol` 的 `extensionStaticTableSchema`）：

```ts
interface ExtensionStaticTable {
  rev: number; // 一个 Window Host 内单调递增，整份替换
  plugins: Array<{
    pluginId: string;
    name: string;
    version?: string;
    extension: // 没有 extension 键时为 null
      | {
          state: "ok";
          main?: string;
          activationEvents: string[];
          commands: StaticCommand[];
          views: StaticView[];
        }
      | { state: "invalid"; path: string; reason: string }
      | { state: "incompatible"; required: string; reason: string }
      | null;
    slotItems: Array<{
      id: string; // 条目全局 id
      pluginId: string;
      slot: ExtensionSlotId;
      order: number;
      icon?: string;
      title?: LocalizedText;
      target: { kind: "view" | "command" | "surface" | "tool"; id: string }; // view、command 是全局 id
    }>; // 只有可用的条目
    problems: Array<{ path: string; reason: string }>; // 不可用的条目、读不出的清单
    ignored: Array<{ path: string; reason: string }>; // 未知插槽 id，只作诊断
  }>;
}
```

- **扩展声明**（`extensionDeclarationsSchema`，经 `IExtensionHostChannel.setDeclarations`）：每个合法、兼容的扩展一项 `{ pluginId, version?, rootPath, main?, activationEvents, commands, views, slotItems }`，后三项是本地 id。扩展进程按它判断 `register` / `slots.update` / `open` 是否声明过；声明变了，已激活扩展请求计划重启。设置值不在声明里（P2d 删掉了 P1 留下、从没用过的 `userConfig`），设置变化不重启扩展。
- **推送**：静态表与贡献表走同一条流 `IExtensionsService.onDynamicContributions`，消息 `kind: "static"`。订阅时先收当前静态表，再收当前快照（或 `detached`）。重读与推送声明在 Window Host 里串行：牵线时的推送排在在途的重读之后，扩展进程总是收到最新一份。「重新加载扩展」先请 Main 重启，再重读，不等 CLI。
- **合并**：Renderer 的 `extension-slots` 只持三份最近数据（静态表、贡献表快照、扩展进程状态），合并只在 `domain/slotSelectors.ts`：`selectSlotEntries(sources, slot, scope)` 返回 `{ item, pluginName, value, hostStopped }[]`。激活失败的扩展的条目不返回（问题行显示原因）；动态值 `visible: false` 的条目不返回；扩展进程停止时 target 是扩展的条目带 `hostStopped`。新插槽只加一个选择函数，不维护第二份条目表。

```text
启动 / 插件管理成功 / 重新加载
  └─ Window Host：listPlugins → 逐个读 plugin.json → resolvePluginManifest
       ├─ 静态表 rev+1 ──onDynamicContributions {kind:"static"}──► Renderer：替换静态表
       └─ 扩展声明 ──setDeclarations──► 扩展进程：对比、激活、停用
                                          └─ 快照 / 增量（运行状态、动态值）──► Window Host ──► Renderer
Renderer：selectSlotEntries(静态表, 快照, 扩展进程状态) → 插槽组件
```

### 16.2 清单：顶层 `slots`

```jsonc
{
  "name": "gitlab",
  "mcpServers": { "gitlab": {} },
  "ui": {
    "surfaces": [
      {
        "id": "panel",
        "server": "gitlab",
        "resourceUri": "ui://gitlab/panel",
        "availability": "session",
      },
    ],
  },
  "extension": {
    "engines": { "zcode": "^1.0.0" },
    "main": "./dist/extension.js",
    "contributes": {
      "commands": [
        {
          "id": "search-mrs",
          "title": { "zh-CN": "搜索合并请求", "en-US": "Search merge requests" },
        },
      ],
      "views": [
        {
          "id": "mrs",
          "title": { "zh-CN": "合并请求", "en-US": "Merge requests" },
          "icon": "git-merge",
        },
      ],
    },
  },
  "slots": {
    "nav.primary": [
      {
        "id": "mrs",
        "title": { "zh-CN": "GitLab", "en-US": "GitLab" },
        "icon": "git-merge",
        "target": { "view": "mrs" },
      },
    ],
    "composer.mention": [
      {
        "id": "mr",
        "title": { "zh-CN": "合并请求", "en-US": "Merge requests" },
        "target": { "command": "search-mrs" },
      },
    ],
  },
}
```

- `target` 只能有一个键：`view`（扩展视图 id）、`command`（扩展命令 id）、`surface`（`ui.surfaces[].id`）、`tool`（插件 MCP server 的工具名）。每个插槽接受的种类见 §16.3。
- 引用 `view`、`command` 但扩展不合法或不兼容：只有这个条目不可用，带字段路径；插件的其他条目照常。
- 未知插槽 id：忽略并记一条诊断，不让插件 invalid（向前兼容）。条目内的未知字段：该条目 invalid。
- P1 的 `extension.contributes.slots` 删除。还没有发布的插件，不做兼容。

实现（P2a，已完成）：

- `EXTENSION_SLOTS` 的每一项声明 `targets`（接受的 target 种类）与 `maxItemsPerPlugin`，清单校验与渲染都读它。P2a 只有 `composer.status`（command）与 `sidePane.launcher`（view）。
- 条目 `{ id, target, title?, icon?, order? }` 按严格对象校验。不可用的情况与字段路径：条目内未知字段（如 `slots["composer.status"][0].titel`）、超过每插件上限（`slots["sidePane.launcher"][5]`）、id 重复（`...[1].id`）、target 不被插槽接受或引用的视图/命令不可用（`...[0].target.view`）。不可用的条目不进静态表的 `slotItems`，记进 `problems`，Window Host 记一条 warn；未知插槽 id 记进 `ignored`，记一条 info。
- 启动页问题行也显示不可用的条目（§6）：插件的 `extension` 没问题、也没有激活失败时，显示「清单非法」与第一条的字段路径。

### 16.3 插槽目录（P2）

| 插槽                | 位置                     | 接受的 target | 作用域 | 每插件上限 |
| ------------------- | ------------------------ | ------------- | ------ | ---------- |
| `composer.status`   | 输入框，用量圆环左边     | command       | 会话   | 1          |
| `sidePane.launcher` | 启动页「扩展」分区       | view          | 工作区 | 5          |
| `nav.primary`       | 左侧导航「插件市场」下方 | view、surface | App    | 1          |
| `file.viewer`       | 打开文件时               | view、surface | 工作区 | 5          |
| `composer.mention`  | 输入框 `@` 面板          | command、tool | 会话   | 3          |

打开规则（时机不同，形状相同）：

- `view`：打开扩展视图标签（§8）。
- `command`：执行扩展命令。命令可以返回 JSON 值，由 Window Host 按插槽的 schema 校验。
- `surface`：打开 MCP App 页面，要有会话。焦点窗格有会话就用它；没有就先进根草稿再打开（现有 `handleOpenDraftPluginUi`，`app-shell/WorkspaceShellLayout.tsx:1433-1449`）。远程工作区或没有插件沙箱时，沿用现有的「不支持」提示。
- `tool`：只用于 `composer.mention`，见 §16.6。

实现（P2b）：

- `EXTENSION_SLOTS` 加 `nav.primary`（view、surface，App，每插件 1 项）与 `file.viewer`（view、surface，工作区，每插件 5 项）。插槽自己的条目字段写在目录项的 `itemFields` 里（`file.viewer` 的 `fileExtensions`），清单校验从目录读，不在别处写死插槽 id。
- `surface` 条目在 Window Host 只校验形状，不查 `ui.surfaces` 里有没有这个 id：MCP App 页面的 owner 是 CLI（`IPluginUiBridgeService.listSurfaces`），Window Host 不再解析一份。点击时查不到，沿用现有的「不可用」提示（`settings.plugins.store.ui.unavailable`）。
- 打开 `surface` 的流程只有一处（`extension-slots/adapters/useOpenSlotSurface.ts`），与插件市场打开界面用同一组原语：
  1. 没有插件沙箱、没有 `pluginUiBridgeService`、远程工作区：提示「不支持」（`settings.plugins.store.ui.unsupported`）。
  2. `listSurfaces` 按插件 id 与 surface id 找页面。
  3. 焦点窗格有会话（`usePluginUiPaneTarget`，草稿为预热会话）：在该会话打开 `plugin-ui` 标签。
  4. 没有会话（例如主视图不是对话、预热还没就绪）：交给 Shell 的 `handleOpenDraftPluginUi`，先进根草稿，草稿的 `SessionPane` 在预热会话就绪后打开。

```text
点击 surface 条目
  ├─ 不支持（无沙箱 / 无 bridge / 远程）──► 提示「不支持」
  ├─ listSurfaces 找不到 ──────────────────► 提示「不可用」
  ├─ 焦点窗格有会话 S ─────────────────────► openPluginUi({ parentSessionId: S })
  └─ 没有会话 ─► handleOpenDraftPluginUi ─► startDraft + requestPluginUiOpen
                                              └─ SessionPane：预热会话就绪 ─► openPluginUi
```

### 16.4 `nav.primary`

- 渲染在 `ProjectSidebarNavigation` 的「插件市场」之后（`project-sidebar/ProjectSidebarNavigation.tsx:52-64`），一个插件一项，按标题排序。
- 点击在右侧面板打开，不切换主视图，不新增 `WorkspaceMainView`。没有选中态。
- 手机远控模式下隐藏，与「自动化」「插件市场」相同（同文件 `:37`）。

实现（P2b）：

- 插槽组件 `NavPrimarySlot`（`extension-slots/components/`）。`ProjectSidebarNavigation` 只在「插件市场」之后挂它，手机远控时不挂。Shell 经侧栏 props 的 `navPrimarySlot` 给它三样：当前任务 id（`usePluginUiPaneTarget` 的 Shell 会话）、`handleOpenDraftPluginUi`、回到对话主视图。没有扩展门面（Web）时组件不渲染。
- 条目：`selectNavPrimaryItems`（`domain/slotSelectors.ts`）从 `selectSlotEntries` 取（`visible: false` 的不显示，激活失败的扩展的 view 条目不显示，view target 找不到视图声明时不显示）。标题：条目 `title` → 视图标题（view target）→ 插件名；`sortNavPrimaryItems` 按当前语言的标题排序，相同时按插件 id。图标只从白名单渲染。悬停说明取动态值的 `tooltip`（App 作用域）。
- 点击：主视图不是对话时先回到对话，再打开。事实：右侧面板只在对话主视图显示（`app-shell/WorkspaceShellLayout.tsx` 的 `useAnimatedResizablePanel({ open: workspaceMainView === "chat" && isSidePaneOpen })`），停在自动化或插件市场时打开的标签看不见。这不是新的主视图，也没有选中态。`view` 打开扩展视图标签（与启动页条目同一入口）；`surface` 走 §16.3 的流程。
- 扩展进程已停止：`view` 条目照常显示，带 `bg-tag`「已停止」与「重新加载」（导航行窄，用短标签保住标题；悬停说明与无障碍名称是完整的「扩展已停止 · 重新加载」），点击重新加载扩展；`surface` 条目不受影响，照常打开页面（§16.1）。

### 16.5 `file.viewer`

条目多一个字段 `fileExtensions`（如 `[".csv"]`，大小写不敏感）。打开文件时按顺序找查看器（`hooks/useAppPanels.ts` 的 `handleOpenCodeViewer`）：

1. 现有的 `.xlsx` 官方路由（`plugin-ui/officeViewerOpen.ts`），本版不迁移。
2. 插件声明的查看器。多个插件声明同一扩展名时，取插件 id 字典序第一个，并记一条 warn。
3. 现有的内置预览与代码查看器。

- 只对本机工作区的文件生效。远程工作区跳过第 2 步。
- `view`：每个文件一个视图实例与标签（键含文件的相对路径），标题是文件名。视图实例多一个 `view.input = { kind: "file", path, workspace }`。
- `surface`：沿用 Office 路由的流程，路由表改为「内置 `.xlsx` 常量 + 清单声明」。页面就绪后调页面的 `open_document({ path })` 工具。这是 MCP App 查看器的约定，开发者文档写明。

实现（P2b）：

- 清单字段：`fileExtensions` 是 1–20 个扩展名，每个以 `.` 开头，后面是字母、数字、`.`、`_`、`-`（如 `.csv`、`.tar.gz`）。缺失或格式错误时该条目不可用，带字段路径（如 `slots["file.viewer"][0].fileExtensions[0]`）；其他插槽的条目写了它，按未知字段判不可用。静态表的条目带小写后的 `fileExtensions`。
- 查找：`selectFileViewer(sources, 文件名, 工作区)`（`extension-slots/domain/slotSelectors.ts`）在打开文件时算一次，读 `useFileViewerRouter` 调用时 store 的最近一份（不订阅渲染）。同一插件内取第一个（按 `order`、id）；多个插件声明同一扩展名时取插件 id 字典序第一个，每份静态表只记一次 warn（`[extension-slots] file viewer conflict`）。扩展进程已停止时 `view` 条目不参加选择（打不开视图）；没有别的可用条目时走第 3 步。激活失败的扩展本来就不返回。文件名以条目的某个扩展名结尾就算匹配（如 `.tar.gz`），不按最长扩展名优先。
- 接线只在 `useAppPanels.ts` 的文件路由一处：`handleOpenCodeViewer` 与文件管理标签内的导航（`handleNavigateFileManager`）共用它，这两处都是「打开文件」。
- 只对本机工作区：与 `.xlsx` 路由同一条判断（文件属于当前 Shell 的本机工作区，没有远程会话），相对路径严格解析（`resolveOfficeViewerDocumentPath`，工作区外或越界时走第 3 步）。
- `view`：标签 id `extension-view:<视图全局 id>:file:<相对路径>`，同一文件再次打开时聚焦同一个标签；标题是文件名；图标取视图声明。标签带 `input = { kind: "file", path: <相对路径>, workspace }`，`prepareView` 把它带给 Window Host，Window Host 按协议的 `extensionViewInputSchema` 校验后经 `openView` 交给扩展进程，扩展收到 `view.input`（`ViewInstance.input`，从启动页或 `views.open` 打开时没有）。`path` 是工作区相对的 posix 路径，绝对路径是 `workspace.workspacePath` 加上它。
- `surface`：与 `.xlsx` 同一个流程。路由表 = `matchOfficeViewerSurfaceRoute`（内置常量，先查）+ 清单声明。要有会话（焦点窗格的会话，草稿为预热会话）；没有时走第 3 步，与 `.xlsx` 相同。标签按文件建实例（`instanceId: file:<相对路径>`）；页面 `running` 后宿主代调一次 `open_document({ path: <相对路径> })`，结果经 `ui/notifications/tool-result` 投给页面；工具报错、调用异常或 30 秒内页面没就绪，回退第 3 步。
  - 面板侧原来只为 Office 的 surface id 订阅待开文件（`isOfficeViewerSurfaceId`）。路由表加了清单声明后这个判断删掉：每个 surface 标签都按自己的标签 id 订阅，只有排过队的标签会收到文件。
- 工具调用经 CLI 的 `mcp/uiCallTool`，与页面自己调工具相同，按会话的权限规则可能先请求授权。

```text
打开文件（handleOpenCodeViewer / 文件管理导航）
  ├─ 1. .xlsx 内置常量 ──────► 官方 spreadsheets 面板（不变）
  ├─ 2. 插件查看器（本机工作区、相对路径可解析）
  │     ├─ view ────► extension-view 标签（每文件一个，view.input = {kind:"file", path, workspace}）
  │     └─ surface ─► plugin-ui 标签（每文件一个）─ 页面 running ─► open_document({ path })
  │                                                    └─ 报错 / 超时 ─► 3
  └─ 3. 内置预览与代码查看器
```

### 16.6 `composer.mention`

- `@` 面板为每个条目加一个分组，组名是条目标题。候选项形状：`{ id, label, description?, icon?, insertText }`，最多 50 项，`insertText` 最长 4000 字符。
- 选中后插入一个提及块，序列化成 `insertText` 原文（`mentions/promptSerialization.ts`）。CLI 不改，它收到的是普通文本。
- `command`（扩展）：Renderer → `IExtensionsService.provideMentionItems({ entry, query, scope, seq })` → 扩展命令，参数 `{ query }`，返回候选项。
- `tool`（MCP App）：要有会话（草稿用预热会话）。新 CLI 方法 `plugins/mentionItems { sessionId, pluginId, tool, query }`，CLI 在该会话的 MCP 连接上调插件的工具，返回 `structuredContent.items`，按 schema 校验。旧 CLI 返回 method-not-found 时这一组不显示。
- 不设计取消。每次查询带递增的 `seq`，Renderer 只采用最新一次的结果。

实现（P2c）：

- **插槽目录**：`composer.mention` 接受 `command`、`tool`，会话作用域，每插件 3 项。目录项多一个 `commandResult`：command target 返回值的 schema。这里是 `zcodePluginMentionItemsSchema`，与 CLI 校验工具结果的是同一份（`plugin-host-queries` 模块）。没有 `commandResult` 的插槽忽略命令的返回值（`composer.status` 的点击照旧）。
- **命令参数与返回值**：`CommandCall` 加 `args?`，`composer.mention` 传 `{ query }`。命令返回候选项数组。`extension-host` 频道的 `executeCommand` 改为返回命令的返回值（入参 `commandInvocationSchema` = Renderer 的 `{ commandId, scope }` 加 `args`）。返回值按 JSON 带回；不能序列化时按 `undefined` 处理并记一条 warn，否则 RPC 回包失败，连点击都会报错。带参数的调用是按键级查询，扩展进程不再为它记 `run command` 的 info。
- **门面**：`IExtensionsService.provideMentionItems({ entry, query, scope, seq })` 返回 `{ seq, status: "ok", items } | { seq, status: "unsupported" } | { seq, status: "error", code }`。入参与结果的 schema 在协议模块 `mention.ts`。错误不抛给 Renderer：`@zcode/rpc` 跨进程只带错误文本，Renderer 要按码分支。Window Host 只认静态表里 `composer.mention` 的可用条目（否则 `not-declared`）：
  - `command`：扩展进程没连上 → `host-unavailable`；命令抛错 → `command-failed`（原因在扩展日志）；返回值不合 schema → `invalid-result`（warn 只记 schema 路径）。
  - `tool`：请求带 `invalidateConnectionOnTimeout: false`：首次调用可能在会话里等用户审批，等得久不说明 CLI 卡死，协议 client 的默认超时（3 分钟）只让这次查询失败，不回收工作区的 CLI。作用域不是会话 → `no-session`；`getPluginMentionItems` 返回 `supported: false`（旧 CLI）→ `unsupported`；CLI 错误的 `data.code` 原样带回（如 `plugin_mention_tool_denied`）；会话不在 CLI 内存（`-32004`）或没有运行中的 CLI → `session-unavailable`。
  - 日志：每次查询一条 debug（条目、target 种类、seq、项数或错误码、耗时）；错误另记一条 warn（条目与错误码）。都不记 query 与候选内容。
- **Renderer**（`extension-slots/adapters/useComposerMentionSlot.ts`）：每个条目只持「最近一次发出的查询（键与 seq）」和「最近采用的结果」。
  - 查询键 = 作用域 + query。键变了才发新查询；结果的 seq 仍是该条目最近一次的 seq 才采用，更早的结果晚到时丢弃。
  - 新查询在途时继续显示上次采用的候选项；还没有任何结果时显示加载。
  - 面板关闭不清结果，同一个键不重发。原因：`tool` 的首次调用会在会话里弹审批，审批卡片替换输入框，编辑器失焦，`@` 面板随之关闭。如果重新打开就重发，拒绝或「允许一次」后每次打开都会再弹审批，永远看不到结果。代价：在同一个输入框里再次输入完全相同的查询时显示上次的结果，再输入一个字就会重查。
  - 不显示这一组：`unsupported`、空结果；`tool` 条目没有会话或在远程工作区（扩展门面在本机 Host，远程会话不在本机 CLI 里）。`command` 条目在远程工作区照常（扩展在本机运行）。
  - 错误：组内一行（`plugin_mention_tool_denied` 显示「已拒绝调用插件工具」，其他码显示「候选项加载失败」），不影响别的组。扩展进程已停止：`command` 组显示一行「扩展已停止」，不发查询。
  - 条目来自 `selectComposerMentionEntries`（`domain/slotSelectors.ts`）。组名：条目标题 → 命令标题（`command`）→ 插件名。查询只依赖条目 id 列表，不随动态值增量重查。命令作用域与 `composer.status` 共用 `composerCommandScope`。
- **`MentionPlugin`** 只加一个候选来源（`extension-slots/adapters/useExtensionMentionGroups.ts`，候选行 `components/ExtensionMentionOptionContent.tsx`），只在 `@` 面板，用即时的 query（不用内置分组的 deferred query：面板刚打开时 deferred 值还是上一次的空串，会多发一次查询，tool 条目还会因此多弹一次审批）：分组排在内置分组之后，总是显示组名（`MentionResultGroup.showHeader`）。候选行：白名单图标 + 标题 + 说明；同一组里重复的候选 id 只留第一项。选中后插入 `extensions` 类别的提及块：显示 `label`，插件图标与插件配色，序列化是 `insertText` 原文。

```text
输入 @query（MentionPlugin，deferred query）
  └─ useComposerMentionSlot：作用域 + query 变了 → 该条目 seq + 1，记为最近一次
       └─ IExtensionsService.provideMentionItems({ entry, query, scope, seq })
            Window Host：查静态表里 composer.mention 的条目
              ├─ command ─► 扩展进程 executeCommand({ commandId, scope, args: { query } })
              │               └─ 返回值 ─► EXTENSION_SLOTS["composer.mention"].commandResult 校验
              └─ tool ────► IZCodeAgentService.getPluginMentionItems（CLI plugins/mentionItems，
                            会话的授权链；首次可能在会话里弹审批，请求一直等）
            ◄─ { seq, status: ok | unsupported | error }
  Renderer：seq 仍是该条目最近一次 → 采用；否则丢弃

已知限制（CLI，运行时证据见 PLM-EXT-P2C）：草稿的预热会话没有持久化，选「始终允许本项目」时 CLI 只放行这一次并记 `Project permission update skipped without persisted session`，同一会话的下一次查询仍然询问。发过第一条消息后才按项目记住。

审批与面板（tool 首次调用）：
  @q ─► 查询 seq=1 ─► 会话弹审批，输入框隐藏，面板关闭（结果保留，不清）
        用户回应 ─► seq=1 的结果到达，仍是最近一次 → 采用
        回到输入框，面板重新打开，键没变 → 不重发，直接显示结果（或「已拒绝」）
```

### 16.7 插件设置

- 设置界面沿用现有的 `settings/PluginConfigControls.tsx`，不需要会话。
- 敏感值的存储见 CLI spec「Sensitive Option Storage」（`apps/zcode-cli/docs/design/v2/plugin-compat.md`）。
- 能力表新增两行，都只作用于调用方自己的插件（网关注入插件 id，入参里没有插件 id）：

| id                     | kind      | 后端    | 返回 / 事件                                         |
| ---------------------- | --------- | ------- | --------------------------------------------------- |
| `settings.get`         | call      | service | 用户级有效值，含敏感值（`plugins/readUserOptions`） |
| `settings.onDidChange` | subscribe | service | `{ values }`，本插件的设置保存或重置成功后触发      |
| `settings.update`      | call      | service | 写本插件的 user 层设置（P4 H1，§18.1）              |

- 旧 CLI 没有 `plugins/readUserOptions` 时，`settings.get` 只返回非敏感值，并记一次 warn。
- 敏感值经 §7.3 的同一进程边界：别的扩展理论上能读到。授权界面与开发者文档写明。

### 16.8 日志控制台（P2e 已实现）

实现（P2d）：

- **能力表**：`settings.get()` 返回 `{ values }`，`settings.onDidChange` 的事件也是 `{ values }`；`values` 是 `Record<string, string | number | boolean>`。两行都没有入参：网关把调用方插件 id（`CapabilityCallContext.pluginId`）交给处理函数。这是归因，不是安全边界（§7.3）。
- **后端**（`extensions-service/settingsBackend.ts`，① 调现有服务）：
  - `get(pluginId)`：用 Window Host 进程内的读取器 `getPluginUserOptionsReader(services)`（经 `createWindowHostExtensions` 的依赖 `userOptionsReader` 传入）调 `plugins/readUserOptions`。读取器不在任何 RPC 频道上，结构上只有能力网关能用。
  - 旧 CLI（读取器返回 `supported: false`）或没有读取器：从 `plugins/list`（user 视图）取非敏感值：清单默认值（非敏感键）⊕ `configuredOptions`。整个 Window Host 只记一次 warn。
  - `onDidChange(pluginId)`：只推给该插件的订阅者；没有订阅者时不读值。订阅后不推初始值，扩展先调 `get`。
  - 不记任何值。日志只有插件 id 与键数。
- **信号**：插件管理服务的成功信号带上动作、插件 id 与 scope：`onMutationSucceeded({ action, pluginId?, scope? })`（`action` 与遥测的动作名相同）。Window Host 收到后照旧重读静态表；动作是 `configure` 或 `reset_config`，且 scope 不是 `workspace`（扩展只认 user 层）时，再通知该插件的设置订阅者。通知串行执行（先读值再推），后一次排在前一次之后，订阅者最后收到的总是最新的值。
- 不监听文件变化：直接改 `~/.zcode/cli/config.json`、`plugin-secrets.json`，或用 CLI 改设置，不触发 `onDidChange`（与静态表的重读时机一致）。

```text
设置页保存（PluginConfigControls → IPluginManagementService.configurePlugin，scope user）
  └─ CLI plugins/configure：敏感键写 plugin-secrets.json（0600），普通键写 config.json
  └─ 成功 ─► onMutationSucceeded({ action: "configure", pluginId, scope: "user" })
       Window Host / extensions-service
        ├─ 重读静态表（不变）
        └─ settings：该插件有订阅者 ─► readUserOptions(pluginId) ─► onDidChange { values }
扩展：ctx.settings.get() ─► 能力网关（注入调用方插件 id）─► readUserOptions(本插件)
                                                   └─ 旧 CLI：plugins/list 的非敏感值（warn 一次）
```

### 16.8 日志控制台

```text
扩展进程 ──parentPort──► Main 监管器：环形缓冲（最近 2000 条，每条 ≤ 4KB）+ 写日志文件（不变）
                           │ 追加的条目按事件循环批量推送（setImmediate），不用定时器
                           ▼
                        Window Host：只转发 ──► Renderer
                           IExtensionsService.getLogs({ sinceSeq? })   快照
                           IExtensionsService.onDynamicLogs            追加
```

- 缓冲的唯一 owner 是 Main。扩展进程崩溃后日志还在。条目：`{ seq, ts, level, gen, pluginId?, message }`，含监管器的生命周期行（没有插件 id）。
- Renderer 记最后的 `seq`。收到不连续的 `seq`（例如 Window Host 重连后），用 `getLogs({ sinceSeq })` 补齐。
- 侧栏标签类型 `extension-logs`，工作区级，可见规则照 `developer-tools`，每个窗格一个。入口：启动页「扩展」分区的「扩展日志」一行，命令中心「打开扩展日志」。
- 界面：按插件、级别过滤；自动滚到底可开关；「清空」只清视图；可复制。等宽字体，遵守 `DESIGN.md`。

细化（P2e）：

```text
Main 监管器                     Window Host（只转发）                 Renderer 日志 store
────────────                    ─────────────────────                 ───────────────────
                                                                       ① 订阅 onDynamicLogs
                                                                       ② getLogs({})
               ◄─ logs-request {requestId} ───────────────────────────
  当场回整个缓冲 ─ logs-snapshot {requestId, entries, lastSeq} ─────►  整份替换，lastSeq = 回包的 lastSeq
                                                                       （①到②回包之间的批次先排队，回包后按 seq 去重合入）
  追加 seq=n+1… ──setImmediate──► logs {entries} ───────────────────►  首条 = lastSeq + 1 → 追加
                                                                       首条 > lastSeq + 1（例如 Window Host 重连）
               ◄─ logs-request {requestId, sinceSeq: lastSeq} ────────  → getLogs({ sinceSeq }) 补齐，丢弃这一批
  当场回 sinceSeq 之后的全部 ──── logs-snapshot ────────────────────►  补齐结果为准：被环形缓冲挤掉的条目不再补
```

- 条目来源：扩展的 `ctx.log.*`（带插件 id）；扩展进程自己的日志、没有归因到插件的未捕获错误、扩展进程 stdout/stderr 的每一行（`[stdout]` / `[stderr]` 开头，没有插件 id）；监管器的生命周期行（fork、状态、牵线、退出、退避、卡死、预算耗尽、计划重启、重新加载，没有插件 id）。扩展的 `console.debug/log/info/warn/error` 在插件归因上下文里（激活、命令、监听器、视图都在其中）转成带插件 id 的日志，级别按方法映射；不在插件上下文里的输出（宿主自身、依赖库）仍是 `[stdout]` / `[stderr]` 行。
- `seq` 在 Main 的生命周期内从 1 开始递增；`ts` 是 Main 收到的时间（毫秒）；`gen` 是该行所属的扩展进程代际（监管器行取它描述的代际）。`message` 不含日志文件里的 `[extension-host] gen=N [pluginId]` 前缀；超过 4KB（UTF-8 字节）时截断，末尾加 `…[truncated]`。日志文件仍写完整内容，格式不变。
- 只有 parentPort 发送失败的告警只写日志文件、不进缓冲：进缓冲会再触发一次推送，发送一直失败时形成循环。
- 推送对象与状态推送相同：每个已发出 `window-ready` 的 Window Host（产品只有一个窗口）。没有就绪的 Window Host 时只进缓冲。
- `getLogs` 是 Window Host 到 Main 的一次请求/回包（`extension-host/logs-request` / `extension-host/logs-snapshot`，`requestId` 配对）。Main 收到即回，不等待；Window Host 不留副本，退出或重建时在途请求失败。没有超时。
- Renderer：每个 `IExtensionsService` 一份日志 store，第一个日志标签挂载时订阅、最后一个卸载时退订（侧栏收起时内容卸载，展开后重新取快照）。最多留 2000 条。取快照失败时丢弃排队的批次，下一批到达时再取，不用定时重试。
- 「清空」记下当前 `lastSeq`，之后只显示更新的条目；标签关闭再打开、侧栏收起再展开都保持，直到 Renderer 重载。不影响 Main 的缓冲和日志文件。过滤与自动滚动是标签内的状态，标签内容卸载后回到默认（全部来源、全部级别、自动滚动开）。
- 过滤：来源为「全部来源」「扩展进程」（没有插件 id 的行）或某个插件 id（列出当前条目里出现过的插件）；级别为「全部级别」「警告及以上」「仅错误」。复制当前过滤后的条目，每行 `时间 级别 [来源] 消息`。
- 启动页的「扩展日志」一行只在静态表里有带 `extension` 的插件（任何清单状态）或扩展进程已停止时显示：没有扩展时缓冲里只有监管器的行，用处不大。命令中心的「打开扩展日志」只要有扩展门面（桌面本机 Host）就有，与「重新加载扩展」相同。
- 不额外输出任何内容：界面只显示扩展和宿主自己写的日志，不显示环境变量或配置。

### 16.9 模块落点

| 模块                      | P2 新增                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `extension-host-protocol` | 顶层 `slots` schema、target、三个新插槽、提及候选项、日志条目、`settings.*` 两行 |
| `extensions-service`      | 清单读取与静态表、提及路由、设置后端、日志转发                                   |
| `extension-host`          | 接收 Window Host 给的声明，不再读清单；命令返回值                                |
| `extension-slots`         | 导航分组、文件查看器路由、`@` 分组、日志标签                                     |
| CLI                       | `plugins/readUserOptions`、`plugins/mentionItems`、敏感值私有文件                |

已有文件只加接线：`ProjectSidebarNavigation`（一个插槽组件）、`handleOpenCodeViewer`（一次查询）、`MentionPlugin`（一个候选来源）、`workspaceSidePane.ts` 等的标签类型登记。

### 16.10 分步与验收

每一步都在桌面端跑通 E2E 才进入下一步：

1. **P2a 重构**（已完成）：静态声明移到 Window Host，清单改顶层 `slots`。P1 的三个用例（PLM-EXT-2A、2B、2C）全部重跑通过；新增断言：扩展进程停止后，启动页的问题行与静态条目仍在，扩展目标的条目显示「扩展已停止」与「重新加载」（P2a 的两个插槽都不接受 MCP App target，MCP App 入口的断言随 P2b 加）；草稿首发时屏幕会话报告没有空档；示例的悬停说明跟随 App 语言。同时修掉 context-inspector 示例暴露的三处 P1 API 问题（§16.11）。
2. **P2b 导航与文件查看器**（已完成，PLM-EXT-P2B）：扩展视图与 MCP App 页面两种 target 各一个 fixture；草稿与正式会话都试；`.xlsx` 仍走官方路由。先把视图的六个方法拆到 `IExtensionViewsService`（§8），PLM-EXT-2A、2B、2C 重跑通过。
3. **P2c `@` 条目**（已完成，PLM-EXT-P2C）：扩展命令与 MCP App 工具各一组；快速连续输入只采用最新结果；选中后发送的文本就是 `insertText`。
4. **P2d 设置**（已完成，PLM-EXT-P2D）：CLI 先按 spec 写 7 个测试再实现；E2E：保存敏感值后 `config.json` 里没有它，扩展的 `settings.get` 拿得到，别的插件的 `settings.get` 拿不到。
5. **P2e 日志控制台**（已完成，PLM-EXT-P2E）：扩展日志实时出现；杀掉扩展进程后旧日志还在；过滤与清空。PLM-EXT-2A 重跑通过。

### 16.11 P1 示例暴露的 API 问题（P2a 一起修）

写 context-inspector 时，插件作者要绕开三处宿主的问题。示例是别的插件作者照抄的范本，这些绕法会被复制出去，所以在源头修（P2a 已完成，示例与 fixture 里的绕法已删）：

| 问题                                            | 示例里的绕法                                 | 修法                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 视图没有「打开」回调                            | 页面第一次调工具或读资源时，才登记视图实例   | `ViewDefinition` 加 `onDidOpen?(view)`；写法二的 factory 本身就是打开回调，不变                                                                                                                                       |
| 草稿首发时 Renderer 报告里约 360ms 没有这个会话 | 插件自己判断「暂时不在屏幕上」，忽略这次变化 | 在 Renderer 报告的源头查清交接过程（预热会话转为正式会话），让窗格的会话在交接期间不消失；删掉 Window Host 视图重建与示例里的对应绕法。数据泵「按工作区订阅、只增不减」另有理由（离开屏幕的工作区仍有在途请求），保留 |
| `ctx` 拿不到 App 语言                           | 插槽悬停说明只能写中性文字                   | 能力表加 `env.get`（call，renderer）返回 `{ locale }`，`env.onDidChange`（subscribe）。语言只在 Renderer，照 `workbench` 的报告路径                                                                                   |

修复记录（P2a）：

- **`onDidOpen`**：`viewHost.ts` 在实例登记后、连接 server 前调用 `ViewDefinition.onDidOpen(view)`；抛错时本次打开失败，已登记的 `onDidClose` 照常执行。示例与 fixture 改在这里登记实例。
- **草稿首发交接**：根因在 Renderer 的预热协调器（`v4/composer/useDraftSessionPrewarm.ts` 的 `promote()`）。首发 `sendText` accepted 后它把草稿槽位脱离，同时向订阅者推 `null`，窗格的 `prewarmSessionId` 立刻清空；正式 `sessionId` 要等 Shell 提交新任务（任务树刷新后 `onSessionCreated`，再由 Shell 绑定）才到。E2E 运行时日志（`desktop-e2e-20261105023450754-p85419-f37b6e75780fb657`）：

```text
03.435  promote sess_2626…                 预热 binding 被清空
03.443  effective=null（sessionId=null, prewarm=null）  lease 退回 keep_warm
03.460  workbench report {"sessions":0}
03.480  commit（commitCreatedTask 等到任务树刷新）
03.703  effective=sess_2626…（sessionId 到达）  lease 从 keep_warm 取回
03.704  workbench report {"sessions":1,"drafts":0}
```

修法：`promote()` 只把槽位脱离，不再通知当前订阅者；窗格保留已提升的 binding，直到绑定正式会话（预热停用，generation 换代）。`useSessionPaneLease` 原本就按「草稿晋升复用预热 lease」设计，这个空档让它失效。修复后删掉了扩展视图标签页的「同一工作区里沿用上一个会话」、示例 `targetKey` 的 `null` 分支与页面「同一会话保留上一份组成」。数据泵「按工作区订阅、只增不减」保留（离开屏幕的工作区仍有在途请求）。

- **`env`**：能力表加 `env.get`（call，renderer）与 `env.onDidChange`（subscribe，renderer）。Renderer 的 `ExtensionViewsProvider` 在语言变化时调 `IExtensionsService.reportEnv({ locale })`，Window Host 的 `envState.ts` 只持最近一份。`env.get` 在 Renderer 还没报告时抛 `host-unavailable`（与 `views.open` 相同）；`env.onDidChange` 订阅后先收当前值。

## 17. P3：插件操作会话与类型包

> 用户决策（2026-11-05）：插件是与手机远控同级的完整客户端；读走插件自己的连接，写走 session-control facade，12 个动作全开；每个插件一个项目放它建的会话；调用方在类型上是「客户端」；写范围与模型的跨会话工具一致；启用任何带代码的扩展都要确认；未授权时扩展照常激活，调用报 `not-granted`；可见标识与审计必做。

### 17.1 总览

```text
扩展 ctx.sessions.*
   │ call / subscribe（能力表：12 个写动作 + 4 个读）
   ▼
Window Host 网关：查表 → 校验 → 清单声明了档位吗（not-declared）→ 用户授权了吗（not-granted）→ 审计
   ├─ 写：AppControlService.bindClient(...)   与模型的跨会话工具共用同一个 facade
   │        connectionId = extension-host:<gen>:<pluginId>   代际变了，旧连接上的写被拒绝
   │        消息带 source {kind:"extension", pluginId}，CLI 持久化 → 桌面与手机显示「来自插件 X」
   │        createSession 不指定项目 → 放进该插件的项目
   └─ 读：每个代际一个进程内连接作用域（replayable 投递）
            会话镜像按会话在插件之间共享，换代时整体释放
```

### 17.2 调用方：会话类与客户端类

事实：`bind()` 必须读到调用方自己的会话（`services/src/app-control/index.ts:303-313`）；self_wait 只拿调用方根会话比较（`session-control/src/application/common/wait.ts:43`）；写授权只到本 Host（`index.ts:316`）。

- `session-control` 的 App 上下文把调用方分成两类：`session`（模型，现状不变）与 `client`（可信的非会话客户端）。`rootSession` 只在 `session` 类上存在；self_wait 只对 `session` 类检查；`boundary.ts` 改读判别字段。CLI 上下文不变。
  - 实现（P3a）：判别字段是 `caller`。会话类的 `caller` 可以缺省（缺省即会话类），CLI 与既有构造方不写它；客户端类必须写 `caller: "client"`，没有 `rootSession`。`TrustedContext<R, S>` 只在 S 含 App 范围时包含客户端类，所以 CLI 端口收到的上下文类型仍只有会话类。CLI 侧只把 App 绑定的 `context()` 类型收窄为会话类（`AppSessionTrustedContext`），行为不变。
  - 实现（P3a）：app-control 的 `requireTarget` 只对会话类复验根会话；客户端类的 `createSession` / `sendToSession` 需要 §17.8 的来源，P3c 之前报 `unavailable`。
- `app-control` 新增 `bindClient`。业务层只知道「可信的非会话客户端」，不知道插件。

```ts
interface AppControlClientBinding {
  kind: "client";
  clientId: string; // "extension:<pluginId>"，跨代际不变，是幂等键的一部分
  connectionId: string; // "extension-host:<gen>:<pluginId>"，即 fence
  sourceServerId: string;
  inputSource?: ConversationInputSource; // 由网关注入
  signal: AbortSignal;
  assertCurrent(): void; // gen 没变、未释放、授权仍在
}
```

- `AppControlService` 由 `createLocalServices` 的一个选项回调交给 `extensions-service`（照 `appControlNavigation` 选项的注入方式），不注册进 ServiceCollection，不出现在 RPC 上。
  - 实现（P3a）：选项是 `onAppControlServiceCreated({ service, sourceServerId })`，Window Host 收到后作为依赖交给 `createWindowHostExtensions`。`AppControlClientBinding` 在 P3a 只有 `kind`、`clientId`、`connectionId`、`sourceServerId`、`signal`、`assertCurrent`；`inputSource` 随 P3c 的写动作加入；原计划的 `defaultProjectId` 不加，插件项目在进入 facade 前填进入参（§17.4 的 P3c-2 说明）。发现端口与导航端口改为只依赖两类共有的连接事实 `AppControlCallerConnection`。
- 写范围与模型工具一致：本机 Host 的全部会话可读写；远端来源的会话能列出，不能写（用户决策）。
- `requestId` 在扩展进程的本地包装里生成（`randomUUID()`），可选。Window Host 断开时，插件用同一个 `requestId` 重试，靠现有幂等对账（`app-control/execution.ts:194-213`）。
- 每个插件同时在途的 wait 不超过 4 个。

### 17.3 能力表 `sessions.*`

`grant` 扩成 `"none" | "sessions.read" | "sessions.write"`，write 包含 read。

- 12 个 facade 动作：kind 都是 call，后端 ①，入参与返回直接用 session-control 的端口 schema（`packages/shared/src/app-control/contract.ts:53-78`），能力名用 `actionSchema` 的动作名，不另写一份。读档：`listProjects`、`listSessions`、`readSession`、`waitSessions`；写档：`createSession`、`forkSession`、`sendToSession`、`interruptSession`、`renameSession`、`openSession`、`setSessionArchived`、`setSessionPinned`。
- 4 个读（后端 ②，读档）：

| id                                 | kind      | 入参                                 | 事件 / 返回                                                                              |
| ---------------------------------- | --------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `sessions.onDidChangeList`         | subscribe | —                                    | 先 `{kind:"snapshot",rev,sessions,truncated?}`，后 `{kind:"delta",rev,upserted,removed}` |
| `sessions.onDidChangeConversation` | subscribe | `{sessionId}`                        | `{sessionId,logEpoch,revision,phase}`，只带修订号                                        |
| `sessions.onDidChangeRows`         | subscribe | `{sessionId}`                        | `{kind:"reset",rows}`、`{kind:"rows",upserted}`、`{kind:"stale"}`                        |
| `sessions.readRows`                | call      | `{sessionId,beforeRowId?,limit≤200}` | `{logEpoch,revision,rows,hasMore}`                                                       |

- 带入参的订阅在 ctx 上生成 `(input, listener) => Disposable`（`capabilities.ts` 的类型与 `extensionContext.ts` 的运行时都要改成透传 input）。
- 新错误码：`not-granted`、`incompatible`、`forbidden`、`unavailable`、`conflict`、`cancelled`、`limit-exceeded`。session-control 错误码按名映射，其余归 `internal`。
- `EXTENSION_API_VERSION` 升一个 minor。

实现（P3a）：

- 能力表加四行 `sessions.listProjects`、`sessions.listSessions`、`sessions.readSession`、`sessions.waitSessions`：kind call，后端 service，档位 `sessions.read`，`protocol: "sessions"`；入参与返回 import 自 `@zcode/session-control/contracts` 的端口 schema（`appListProjectsInputSchema` 等），不另写一份。`extension-host-protocol` 因此依赖 `session-control`。
- 网关顺序：查表 → 校验入参 → 清单声明的档位覆盖吗（否则 `not-declared`）→ 清单声明的协议版本对得上吗（声明了且不等于宿主的版本时 `incompatible`；没有声明按当前版本）→ 用户授权覆盖吗（否则 `not-granted`）→ 审计（调用按 debug 记一行，订阅记开始与结束）→ 分派。清单声明来自静态表（`extension.grants` 去掉被覆盖的档位、`extension.protocols`）。网关按连接创建，调用上下文带这条连接的 `gen`。
- 会话后端 `sessionsBackend.ts`：每次调用 `bindClient({ clientId: "extension:<pluginId>", connectionId: "extension-host:<gen>:<pluginId>" })`，`assertCurrent` 检查代际与授权；结束时再查一次，换代报 `cancelled`、撤销报 `not-granted`。在途调用按插件登记：换代或断开时全部中止，撤销授权时中止该插件的。每个插件同时在途的 wait 最多 4 个，超出 `limit-exceeded`。原始错误文本不进日志，只记错误类型或 session-control 码。
- `EXTENSION_API_VERSION` 为 `1.1.0`。
- 四个读动作都没有 `requestId`，所以扩展侧生成 `requestId` 的本地包装随 P3c 的写动作一起做。

实现（P3b）：

- 能力表再加四行，档位都是 `sessions.read`：`sessions.onDidChangeList`（subscribe，无入参，`protocol: "sessions"`）、`sessions.onDidChangeConversation`（subscribe，`{ sessionId }`，`protocol: "sessions"`）、`sessions.onDidChangeRows`（subscribe，`{ sessionId }`，`protocol: "rows"`）、`sessions.readRows`（call，`{ sessionId, beforeRowId?, limit 1–200 }`，`protocol: "rows"`）。`EXTENSION_API_VERSION` 为 `1.2.0`；P4 的 H5、H6、H8、H9、H11、H12 与 P3b 一起进入 `1.2.0`，不再单独升版。
- 事件形状（上表补全）：
  - 列表：`{ kind: "snapshot", rev, sessions, truncated? }`，之后 `{ kind: "delta", rev, upserted, removed }`。`removed` 是会话引用。订阅后第一个事件总是 snapshot。
  - 会话状态：`{ sessionId, logEpoch, revision, phase }`。镜像有快照后先推一次当前值，之后这四项任一变化才推。
  - 行：`{ kind: "reset", logEpoch, revision, rows }`、`{ kind: "rows", logEpoch, revision, upserted }`、`{ kind: "stale", logEpoch, revision }`。行按 `rowId` 升序。镜像有快照后先推一次 `reset`。行被删除（回退、压缩改写）时推 `reset`，不单独推删除。
  - `readRows` 返回 `{ logEpoch, revision, rows, hasMore }`，取自 v4 `rows/range`（`atLogEpoch`、`atRevision`）。
- **订阅的错误**（所有 subscribe 能力共用）：原先网关拒绝订阅时只在扩展进程的 RPC 层打一行日志，扩展收不到。现在 ctx 的订阅多一个可选的最后参数 `onError(error)`：`(listener, onError?)`、`(input, listener, onError?)`。线上的事件改成信封：`{ kind: "event", event }` 或 `{ kind: "error", code, message }`。错误结束这次订阅：Window Host 释放后端，扩展进程删掉这条订阅，重连后也不重订。准入错误（`not-declared`、`incompatible`、`not-granted`、`invalid-input`）与后端错误（`limit-exceeded`、`forbidden`、`unavailable`）都这样送达。插件没给 `onError` 时，扩展进程按该插件记一条 warn。
- 授权撤销或收窄后，网关里仍开着的需授权订阅以 `not-granted` 结束：网关按连接监听授权状态，变化时逐个复查清单声明与用户授权。

实现（P3c-1，写动作）：

- 能力表再加八行写档动作，档位都是 `sessions.write`，`protocol: "sessions"`，kind call，后端 ①：`sessions.createSession`、`forkSession`、`sendToSession`、`interruptSession`、`renameSession`、`openSession`、`setSessionArchived`、`setSessionPinned`。入参与返回 import 自 `@zcode/session-control/contracts` 的端口 schema（`appCreateSessionInputSchema` 等，与 `createSessionResultSchema`、`sendToSessionResultSchema`、`forkSessionResultSchema`、`mutationResultSchema`、`openSessionResultSchema`），不另写一份。`EXTENSION_API_VERSION` 为 `1.3.0`：在 `1.2.0`（P3b 的读与 P4 的宿主能力）之上加这八个写动作与 H10 的 `model`。
- **请求身份**：端口 schema 的 `requestId` 必填；能力定义多一个 `requestIdentity: true` 标记（七个带 `requestId` 的动作，`openSession` 没有）。ctx 的类型对这些动作把 `requestId` 改成可选；扩展进程的通用包装在插件没传时补 `randomUUID()`，按标记处理，不按能力名分支。插件要靠幂等重试（Window Host 断开、结果不明）就自己传 `requestId`，重试时传同一个；回执里的 `requestId` 就是这次用的值。
- **来源注入**：网关对写动作构造的客户端绑定带 `inputSource: { kind: "extension", pluginId }`（§17.2 的 `AppControlClientBinding.inputSource`）。app-control 对客户端类调用方的 `createSession` / `sendToSession`：绑定没有来源时报 `unavailable`；目标工作区的 CLI 没有 `extensionInputSource` 能力位时报 `unavailable`（不去掉来源后发送）；否则 `createSession.firstInput.source` / `sendText.source` 填这个来源。客户端类没有根会话，原先「派发前复验根会话」那一步改为复验授权 fence 与连接代际（`assertCurrent`）。
- **拒绝伪造**：渲染进程、手机与 relay 的 V4 命令都经 `createZCodeAgentConnectionScope` 的 `sendConversationCommandV4` 进入 Host（桌面与手机的 RPC attachment 各一个作用域，Source Server 的 WebSocket 与 stdio 也是）。这里拒绝 `sendText.source` 或 `createSession.firstInput.source` 为 `extension` 的命令（`fault.command.extensionSourceUntrusted`）。app-control 直接调基础 agent 服务，不经这个入口，所以扩展网关是唯一能发出 `extension` 来源的地方。
- **消息标识**：用户行的 `source.kind` 为 `extension` 时，与 `pluginUi` 显示同一句「来自插件 X」（`pluginUi.fromPlugin`）。X 与 `pluginUi` 相同，取插件 id 里 `@` 前的名字：手机没有扩展静态表，桌面与手机用同一条规则，显示一致。行上带 `data-v4-user-input-source-kind="extension"`。
- `createSession` 不指定项目时放进插件项目（§17.4，实现见该节的 P3c-2 说明）；P3c-1 里插件必须传 `project`。
- 错误码沿用 P3a 的映射（session-control 错误码按名映射，其余 `internal`）。结果里的 `status: "rejected"` / `admission: "rejected"` 是正常返回，不是错误。

### 17.4 插件项目（用户提议）

- 每个插件一个项目，放它建的会话。插件第一次调 `createSession` 且没有指定项目时，由 `extensions-service` 建项目，项目名是插件显示名，唯一目录（即主要目录）是插件数据目录下的 `workspace`（H7，§18.1）。先例：定时任务与 Bots 也绑定项目（`docs/superpowers/specs/2026-09-09-virtual-project-design.md` H1）。
- 只走现有逻辑（用户决策，2026-11-05）：建项目调现有项目服务的 `saveProject`，与侧栏「新建项目」同一条路径；建会话走 app-control 的 `createSession`，与模型的跨会话工具同一条路径。数据库只由这两个现有服务写，插件与 `extensions-service` 都不直接访问数据库，不新增表、列、migration 或数据库代码。`saveProject` 提交前校验目录存在，所以 `extensions-service` 先建好 `workspace` 目录。
- 插件与项目的对应不另存：插件项目就是目录含该插件 `workspace` 的本机项目（P3c-2 说明）。用户删了这个项目，下次 `createSession` 重新创建。
- 插件仍可以显式指定别的项目建会话；`sendToSession` 等动作照常作用于任意本机会话。
- 任务列表里，插件项目本身就是「由插件建的会话」的可见标识。不另做归因表与列表图标。

实现（P3c-2，`extensions-service` 的 `pluginProjects.ts`）：

```text
扩展 ctx.sessions.createSession({ prompt })            （没有 project）
  │ 网关：查表 → 校验 → 声明 → 协议 → 授权
  ▼
sessionsBackend.run（客户端绑定、来源注入、审计，与带 project 的调用相同）
  └─ invoke：project = await pluginProjects.ensure(pluginId)
       ├─ 同一插件同时只有一次 ensure 在途（进程内 single-flight），并发的调用共用它
       ├─ workspace = <dataPath>/workspace；mkdir -p（每次都做，目录被删了就重建）
       ├─ readProjects() ─ 找本机未删除、roots 含 workspace 的项目（主要目录优先）─ 有 ─► 用它
       └─ 没有 ─► saveProject({ name: 插件名, roots: [workspace], primaryRoot: workspace }) ─► 用新项目
     control.createSession(ctx, { ...input, project: { kind: "app", projectId, sourceServerId: 本机 } })
       与显式传 project 是同一条路径：授权、预留、cwd = 项目主要目录（H7）
```

- **不另存映射**：插件项目就是「目录含 `<dataPath>/workspace` 的本机未删除项目」，项目库是唯一事实源，不写映射文件。原因：映射文件与项目库是两份状态，写映射失败或文件丢失会建出重复项目；按目录找没有这个问题，也少一个文件。`<dataPath>` 每个插件一个（H6），所以这个目录能唯一标识插件。
- **用户的改动以用户为准**：改名后照常找到（按目录，不按名字）。移除项目（软删除）后 `readProjects` 不再返回它，下次 `createSession` 新建一个，重名时项目服务照常加序号。把 workspace 从项目目录里去掉，也视为没有插件项目，下次新建。把别的目录设为主要目录，会话 cwd 跟着变成那个目录（H7 不再成立），这是用户的选择。
- **插件名**：静态表里该插件的 `name`（`plugins/list` 的插件名）。扩展声明与静态表来自同一次读取，能运行的扩展一定在静态表里。
- **数据目录**：只用 H6 的 `dataPath`（扩展声明，来自 CLI 的 `plugins/list`），App 不自己拼。没有 `dataPath`（旧 CLI）时报 `unavailable`。
- **入参**：能力 `sessions.createSession` 的入参是端口 schema 把 `project` 改成可选（在能力表里由 `appCreateSessionInputSchema` 派生，不另写一份）。模型的工具与 facade 的端口仍要求 `project`。
- **不加 `defaultProjectId`（与 §17.2 不同）**：项目在进入 facade 前就填进入参，facade 与 app-control 看到的是带 `project` 的普通调用，不需要认识「默认项目」。
- **只在本机**：项目服务用本机 Host 的；`createSession` 的写范围本来就只到本机 Host（§17.2）。数据库只由现有的 `saveProject` 与 `createSession` 写，本服务只调这两个方法与 `readProjects`。
- 日志：新建项目记 info（插件 id、项目 id），复用记 debug；失败只记错误码，不记路径。

### 17.5 读：插件自己的连接

- `extensions-service` 每个代际懒建一个进程内连接作用域：`createZCodeAgentConnectionScope(agent, { connectionId: "extension-host:<gen>", clientMode: "web-remote-replayable" })`，并在进程内握手（`helloConversationV4` → `initializeConversationV4`）。先例：Bot 在进程内建作用域（`zcode-agent/zcodeTaskServiceAdapter.ts:252-262`）。
- 复用 `web-remote-replayable`，不新增 clientMode：新取值要改 30 多处，且发给 CLI 的线格式是严格枚举，旧 CLI 会拒绝。日志靠 connectionId 前缀 `extension-host:` 区分插件与手机。
- 会话列表来自 Window Host 控制器的投影（`packages/desktop/src/host/windowHostControllerService.ts` 的 `readTaskRows` / `subscribeTaskRows`），与桌面侧栏、手机同一份。
- 会话正文：每个被订阅的会话在 Window Host 保留一份客户端镜像（`TopicWireFrameAssembler` + `applyConversationDeltas`），推给插件的是 apply 之后的整行。断档或 epoch 变化时强制快照重同步，对插件发 `reset`。
- 镜像按 sessionId 在插件之间共享，按 (pluginId, sessionId) 计数，最后一个监听回收时退订。换代、Window Host 断开时 `scope.dispose()` 全部退订；扩展进程重连后自动重订阅，首个事件是 `reset`。
- 上限：每插件 8 个会话订阅、全局 32 个，超出 `limit-exceeded`；每个镜像 8 MiB；单个事件 1 MiB，超出发 `stale`；`readRows` 每页 200 行；列表快照最多 1000 行，带 `truncated`。

实现（P3b，`extensions-service` 的 `sessionReads.ts`）：

```text
扩展 ctx.sessions.onDidChangeRows({ sessionId })
  │ 网关：查表 → 校验 → 声明 → 协议 → 授权
  ▼
sessionReads（每个连接一份，换代或断开时整体释放）
  ├─ 解析会话：facade readSession({ sessionId, view: "summary" }) → 会话引用（与模型工具同一份授权，远端来源 forbidden）
  ├─ 上限：该插件的不同会话 ≤ 8、全局镜像 ≤ 32，否则 limit-exceeded
  └─ 镜像（按会话共享）
       scope = createZCodeAgentConnectionScope(agent, { connectionId: "extension-host:<gen>", clientMode: "web-remote-replayable" })
       scope.service.onDynamicConversationFrame(工作区) ──► TopicWireFrameAssembler ──► 帧
       subscribeConversationV4({ visibility: "background" })
       snapshot 帧        ─► 替换镜像 ─► reset + 会话状态
       deltas 帧（fromSeq = 镜像 seq）─► applyConversationDeltas ─► rows(upserted) + 会话状态
       断档 / 组装失败    ─► resyncConversationV4({ base: null, forceSnapshot: true }) ─► 下一个 snapshot ─► reset
       会话 stopping      ─► 等；会话 starting / ready ─► 重新订阅（不带 base）─► reset
       运行时重启         ─► 重新订阅（不带 base）─► reset
       订阅或重同步失败   ─► 该镜像的订阅以 unavailable 结束
```

- 连接作用域在该代际第一次读正文时创建，进程内握手（`clientId: "extension-host"`）。`detach` 时 `scope.dispose()`，镜像全部释放；扩展进程重连后插件重新订阅，第一个事件是 `reset`。连接的建立与释放、镜像的订阅与退订记 info（频率与订阅次数同级）；帧与增量只记 debug。
- 会话解析每次登记都做一次（不同插件各自解析），所以授权与目标检查与 `sessions.readSession` 相同。`readRows` 同样先解析，再经同一个作用域调 `conversationRowsRangeV4`（会话不在内存时 CLI 冷恢复，与手机相同）。
- 镜像预算按窗口里各行的 JSON 字节算：超过 8 MiB 时从最旧的行丢起，丢掉的行仍可用 `readRows` 读到。丢掉的旧行之后再被更新，镜像不再推它（旧行很少更新）。
- 单个事件按 JSON 字节超过 1 MiB 时改推 `stale`，插件用 `readRows` 补读。
- 列表泵：Window Host 宿主把控制器投影以 `taskRows: { read, subscribe }` 注入（只在本进程内）。有列表订阅者时才订阅投影，最后一个退订时退订。行映射：`session = { kind: "app", sourceServerId: address.sourceServerId ?? 本机, workspacePath, workspaceIdentity?, sessionId: taskId }`，`title`、`updatedAt`（ISO）、`archived` / `pinned`（membership）、`sourceAvailability`；`status` 由 `liveStatus` 映射：`running` → `running`，`waiting` → `needs_attention`，其余 → `idle`。投影没有项目归属，所以引用不带 `project`（写操作接受不带项目的引用）。按 `updatedAt` 降序取前 1000 行，多出时 `truncated: true`；增量按这 1000 行算，掉出前 1000 的行在增量里算 `removed`。投影的每次回调都按映射后的行比较，内容没变不推（流式期间的活动时间变化不会产生增量）。

### 17.6 稳定投影

- `SESSIONS_PROJECTION_VERSION = 1`。只加字段不升版；删字段或改含义才升版。清单声明的版本对不上报 `incompatible`。
- 列表行 v1 从 session-control 派生：`sessionSummarySchema.omit({availableActions, executionId}).extend({ session, sourceAvailability })`。会话引用与写操作同一格式，读出来就能直接传给写操作。
- 正文 v1：`readSession(view:"messages")` 的 `{id, role, text}`。
- 完整行：`WireConversationRow` 加读不懂时的占位行，清单写 `protocols.rows: 4`，跟 v4 协议走（版本耦合已接受）。
- 永远不暴露：凭据、provider 配置、OAuth、环境变量；附件字节；遥测、TTFT、CUA 观察、插件 UI 结果；快照里行以外的部分（queue、config 里除权限模式以外的字段）；别的插件的设置与审计；工作区 Hook 信任审查与插件安装确认这两种交互。
- 插件项目里的会话例外（P3e，§17.12）：待处理的工具审批与 AskUserQuestion 提问、当前权限模式经 `sessions.onDidChangeInteractions` 暴露，插件可以回答、可以切换权限模式。原先「插件不能替用户审批」的规则只对插件项目以外的会话仍然成立。

### 17.7 授权

清单（`extension` 下）：

```jsonc
"extension": {
  "engines": { "zcode": "^1.2.0" },
  "grants": ["sessions.write"],
  "protocols": { "sessions": 1, "rows": 4 }
}
```

- 授权记录只由 `extensions-service` 保存：`~/.zcode/v2/extensions/grants.json`（`{ version, plugins: { <pluginId>: { grants, consentedVersion, consentedAt, consentRevision? } } }`）。没有记录就拒绝。卸载删除记录，禁用不删。`consentRevision` 是会话档位含义的版本：低于当前值的记录要重新确认（§17.12「已有授权要重新确认」）。
- 扩展进程没有授予自己权限的入口：`extension-window` 只有 call 与 subscribe。授予与撤销只走 `IExtensionsService.grant / revoke`，它不在手机远控的白名单里。
- 未授权（用户决策）：扩展照常激活，调用会话能力报 `not-granted`。启动页「扩展」分区显示「需要授权」，点击弹授权对话框。
- 启用确认（用户决策）：只要已有扩展持有会话权限，再启用任何带代码的扩展，也要确认一次，并说明它的代码同样能用这些权限。
- 插件更新：权限没超出已授予的，不再询问；变多则回到待授权（调用报 `not-granted`），等用户确认；变少则自动收窄。
- 插件详情页加「权限」区块：已授予的权限、撤销、最近操作。
- 授权对话框原文（§7.3 的后果）：
  > 扩展代码与其他扩展在同一个进程运行，彼此没有隔离。这里授予的权限，任何已启用的扩展在技术上都能使用。只启用你信任的插件。
  > 读取：所有会话的标题、状态和完整对话，包括工具输出。写入：新建、分叉、发消息、中断、重命名、打开、归档、置顶本机任意会话。如果目标会话开着免确认模式，插件发的消息会让 Agent 直接执行工具。
  > 插件项目里的会话：插件还能替你批准或拒绝工具调用、回答 Agent 的提问、切换权限模式（P3e，§17.12）。
  > 完全访问（只在清单声明了 `sessions.fullAccess` 时出现）：插件可以把它项目里的会话切到完全访问，Agent 执行工具不再询问。
  > 插件发起的操作会标出来源，并写入审计日志。
- 不禁止插件给免确认模式的会话发消息：扩展代码本来就能在本机执行任意代码，禁止这一条挡不住什么，只会给人错误的安全感。授权原文写明后果。

实现（P3a）：

- **门面拆分（与上文不同）**：授予与撤销在第三个门面 `IExtensionGrantsService`（频道 `extension-grants`），不在 `IExtensionsService` 上。它有 5 个方法：`onDynamicGrants`（整份授权状态，带 `rev`）、`grant({ pluginId, grants })`、`revoke({ pluginId })`、`describeEnable({ pluginId })`、`getRecentActions({ pluginId, limit? })`。放进 `IExtensionsService`（已有 9 个）会超过每个契约 12 个公开方法的门禁。与另两个门面一样只在桌面本机 Host 注册，不在手机远控白名单里。
- **记录与生效档位**：`grants.json` 为 `{ version: 1, plugins: { <pluginId>: { grants, consentedVersion?, consentedAt } } }`，`consentedAt` 是毫秒时间戳；原子私有写（0600），串行，异步读。生效档位按「记录 ⊕ 最近一份静态表」现算：清单声明的档位都被记录覆盖才生效（状态 `granted`），否则 `needs-consent`；插件不在静态表里（已禁用）或扩展不能运行时为 `inactive`（记录保留，可撤销）。静态表重读先等记录读完，所以激活时的会话调用能看到已有授权。授予与撤销的提交顺序是：写文件 → 写审计行 → 发布新的授权状态（rev 加一），所以 Renderer 收到新 rev 后重读「最近操作」一定能读到这次操作；写文件失败时恢复内存记录、不发布。
- **插件更新**：每次重读静态表都按清单重算：声明没超出记录 → 不询问，记下新版本（`consentedVersion`）；声明变多 → `needs-consent`，记录不动；声明变少 → 记录自动收窄（声明为空时删除记录）。生效档位变少的插件中止在途调用。
- **授权对话框**：复用全局 ConfirmDialog。标题按档位：「允许「X」读取会话？」/「允许「X」读取和操作会话？」；正文是上面的原文（en-US 是对应的译文）。`grant` 的档位必须等于清单当前声明的档位，否则拒绝（对话框打开期间清单变了）。入口：启动页「扩展」分区的「需要授权」行（每个待授权插件一行），插件详情页「权限」区块的「授权」按钮。
- **启用确认**：设置页插件列表在本机 user 层启用插件前调 `describeEnable`：已有别的扩展持有生效权限，且这个插件带扩展代码（`extension` 合法、兼容、有 `main`）时弹确认，列出持有者与档位。读不到依据时也确认。工作区层启用不激活扩展代码（§13），不确认。
  - 从插件商店安装（安装即启用）：安装前读不到清单，所以改在**安装后、激活前**确认（用户决策，2026-11-05）。安装成功、静态表读到这个插件带扩展代码，且已有别的扩展持有生效权限时，扩展进程不激活它，状态记为「待确认」；启动页「扩展」分区显示「需要确认」一行，点击弹出与设置页相同的确认框。确认后激活；拒绝则保持不激活，不卸载插件，插件的其他组件（MCP、技能）照常。确认结果与授权记录存在同一个 `grants.json` 里（按插件 id 与版本）。
    - 实现（P3b）：安装的成功信号没有插件 id（参数是插件名与市场），所以按静态表判断：`install` 成功后重读静态表，**新出现**、扩展合法且有 `main` 的插件，在已有别的插件持有生效会话权限时记为 `pending`。记录在 `grants.json` 的 `activations: { <pluginId>: { state: "pending" | "declined", version?, at } }`（可选键，旧文件照常读）。
    - `pending` 与 `declined` 的插件不进扩展声明，扩展进程不激活它；静态表的这一项带 `activation: "pending" | "declined"`，Renderer 不显示它的 view / command 条目与启动页视图行（打不开）。插件的 MCP、技能由 CLI 管理，不受影响。
    - 启动页「扩展」分区每个 `pending` 插件一行「需要确认」，点击弹出与设置页相同的确认框（持有者来自 `describeEnable`）。确认 → `decideActivation({ pluginId, allow: true })`，删除记录，重新发布静态表与声明，扩展进程激活它；按钮「不激活」→ `allow: false`，记为 `declined`，行消失；关闭对话框（Esc、遮罩）不算决定，仍是 `pending`。授权门面因此有 6 个方法；P4 再加 `grants.request` 的请求与回执（H12）和通知开关 `setNotificationsEnabled`（H8），共 9 个（§18.1）。
    - `declined` 的插件在设置页先禁用再启用即可激活：user 层 `enable` 的成功信号删除该插件的记录（设置页启用前已经确认过）。卸载也删除记录。插件更新不改记录。
- **「权限」区块**：插件详情页「信息」之后。状态标签与档位、「授权」或「撤销」、一行说明（任何已启用的扩展都能使用这些权限），以及「最近操作」（审计里该插件最近 10 行，授权状态变化时重读，不轮询）。

### 17.8 可见标识与审计

- **插件发的消息**：`conversationInputSourceSchema` 加 `{ kind: "extension", pluginId }`（`zcode-protocol-v4/input-intent.ts`）；`createSession.firstInput` 加 `source`。CLI 在 `runtime/capabilities` 声明 `extensionInputSource: true`，App 用 `ZCodeAgent.supportsExtensionInputSource` 读取；不支持时 app-control 报 `unavailable`，不退化成不标。消息行复用「来自插件 X」的文案，桌面与手机都显示。CLI 契约见 [会话输入来源](../../apps/zcode-cli/docs/design/v2/conversation-input-source.md)。
- **插件建的会话**：放在插件项目里（§17.4），项目名就是标识。
- **改名、置顶、归档、中断、打开**：进审计日志，插件详情页「最近操作」可见。
- **审计日志**：`~/.zcode/v2/extensions/audit/<日期>.jsonl`，由 `extensions-service` 写，保留 30 天。写操作每次一行；读操作只记订阅的开始与结束（debug 级进普通日志）。字段：`v, ts, gen, pluginId, capability, grant, requestId, commandId, target{sourceServerId, sessionId, projectId}, outcome, errorCode, promptChars, durationMs`。不写提示词、标题、正文、路径、设置值、错误原文。pluginId 是扩展进程自报的，审计只用于归因（§7.3）。
  - 实现（P3a）：日期是本机日期；写入串行追加（0600）；日期变化后的第一次写清理 30 天以前的文件，不用定时器。授权与撤销各记一行：`capability` 为 `grants.grant` / `grants.revoke`，`grant` 为最高档位，`gen` 为当时连接的扩展进程代际（没有时为 `null`），`outcome: "ok"`。卸载删除记录也记 `grants.revoke`。四个读动作的调用只在普通日志里按 debug 记一行（不含入参）。
  - 实现（P3c-1）：八个写动作每次调用一行，在调用结束时写（成功或失败都写）。`capability` 为能力 id，`grant` 为 `sessions.write`，`gen` 为调用到达的代际。`requestId` 是这次实际用的值（插件传的或扩展进程补的）；`commandId` 只在结果带 `operation` 时记（`createSession`、`sendToSession`），其余动作的命令 id 由 app-control 派生，不复算。`target` 记 `sourceServerId`、`sessionId`（入参的 `sessionId`、入参引用或结果里的会话）、`projectId`（`createSession` 的项目或会话引用里的项目）。`promptChars` 只在 `createSession` / `sendToSession` 记提示词长度。`outcome`：调用抛错为 `error`，`errorCode` 是扩展错误码；正常返回但结果是 `rejected` / `unknown`（`status`、`creation` 或 `admission`）也记 `error`，`errorCode` 为 `result.rejected` / `result.unknown`；其余为 `ok`。结果里的 `reason` 可能是自由文本，不记。插件详情页「最近操作」把八个写动作显示成动作名（如「重命名会话」），失败加「失败」。

### 17.9 类型包 `@zcode-dev/plugin-api`

放 `packages/plugin-api/`，只有 `export type`，全部从协议模块转出，不手写第二份。P3 只在仓库内使用，发布到 npm 放到 P4。

> 发布（设计，2026-11-06）：发布名改为 `@zcode-dev/plugin-api`（用户决策：`@zcode` 已被占用），由用户手动发布。版本规则、市场目录的版本门槛与示例插件迁到市场仓库，见[插件发布](./plugin-publishing.md)。

| 子入口                              | 内容                                                   | 来源                              |
| ----------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `@zcode-dev/plugin-api`             | ExtensionContext、Disposable、作用域、视图类型、错误码 | `@zcode/shared/extension-host`    |
| `@zcode-dev/plugin-api/manifest`    | 清单类型、插槽 id、target、权限档位、protocols         | 同上                              |
| `@zcode-dev/plugin-api/sessions`    | 投影 v1、12 个动作的入参与返回                         | session-control 契约与协议模块    |
| `@zcode-dev/plugin-api/protocol-v4` | 完整行、ContextComposition、GenerationMetrics          | `@zcode/shared/zcode-protocol-v4` |

- `package.json` 的 version 等于 `EXTENSION_API_VERSION`，工程测试钉住两者相等。
- 按 §4 登记为 managed 模块。context-inspector 改从它导入。

实现（P3d）：

- **发布**（2026-11-07 起，见[插件发布](./plugin-publishing.md) §5）：包名 `@zcode-dev/plugin-api`，去掉 `private`，Apache-2.0，由用户手动发布。此前（2026-11-05）的决策是 `private: true`、暂不发布。工程测试 `packages/plugin-api/test/version.test.ts` 钉住版本与 `EXTENSION_API_VERSION` 相等。
- **只转出**：四个入口都只有 `export type { … } from`，来源只有 `@zcode/shared/extension-host` 与 `@zcode/shared/zcode-protocol-v4`。session-control 的会话引用类型（`AppSessionRef`、`AppProjectRef`、`AppWorkspaceRef`）由 extension-host-protocol 转出，类型包不直接依赖 session-control。运行时的值（常量、类、函数）不导出：`ExtensionError` 只导出类型（按 `code` 区分错误），上限常量见本文。
- **协议补的推导类型**（定义在 extension-host-protocol，仍是唯一定义）：
  - `ExtensionCapabilityInput<K>` / `ExtensionCapabilityOutput<K>`：能力 K 在 ctx 上的入参与返回（call 的返回值、subscribe 的事件），与 ctx 成员同一份推导。所以带请求身份的写动作里 `requestId` 是可选的，与 ctx 一致；session-control 的 `App*Input` 里它是必填，不能直接给插件用。
  - `SessionAction`、`SessionActionInput<A>`、`SessionActionResult<A>`：`ctx.sessions` 上的 call 动作（12 个 facade 动作与 `readRows`），如 `SessionActionInput<"createSession">`。用泛型而不是 26 个具名类型，新增动作时不用改类型包。
  - `SessionRow`（完整行，含占位行）、`ManifestSlotTarget`、`ManifestSlots`（清单顶层 `slots`）。
- **四个入口的内容**：
  - `@zcode-dev/plugin-api`：`ExtensionContext`、`ExtensionLocalContext`、`ExtensionModule`、`CommandCall`、`Disposable`、订阅错误监听；`CapabilityId` 与上面两个泛型；`ExtensionError`、`ExtensionErrorCode`；作用域（`ScopeInput`、`ResolvedScope`、`WorkspaceRef`）与插槽值（`SlotItemPatch`、`SlotValue`、`SlotBadge`）；视图（`ViewDefinition`、`ViewServerFactory`、`ViewInstance`、`ViewCall`、`ViewTool`、`ViewResource`、`McpServerLike`、`JsonSchemaObject`、`ExtensionViewInput`）；各能力的值类型（工作区会话、草稿、生成速率、环境、设置、模型、通知、`@` 条目）。
  - `/manifest`：`ExtensionManifest`（清单的 `extension` 键）、`ManifestSlots`、`ManifestSlotItem`、`ManifestSlotTarget`、`ExtensionSlotId`、`SlotTargetKind`、`ExtensionGrant`、`ExtensionProtocols`、`ExtensionProtocolName`、`ExtensionViewScope`、`LocalizedText`。
  - `/sessions`：三个会话动作泛型；列表、会话状态、行三种事件；`SessionListRow`、`SessionRow`、`SessionTargetInput`、`SessionReadRowsInput`、`SessionReadRowsResult`；三个会话引用类型。
  - `/protocol-v4`：`ConversationRow`、`WireConversationRow`、`UnreadableConversationRow`、各行类型与 `ConversationRowKind`、`ConversationInputSource`；`ContextComposition` 及其类别、条目、阶段等类型；`GenerationMetrics`（上表把它列在这里；它定义在 extension-host-protocol，根入口也导出同一个类型）。
- **两种用法**：
  - 仓库内（2026-11-07 以前的 context-inspector、Jarvis；两个示例迁到市场仓库后，仓库内没有消费方）：`exports` 指向 `src/*.ts`，不需要先构建。示例插件不在 pnpm workspace 里，所以用 tsconfig 的 `paths` 指到类型包源码，并引用 `packages/plugin-api` 项目（与以前直接引用 shared 相同）。类型包自己也用 `paths` 解析两个协议入口：给 workspace 包写 `workspace:*` 依赖会让 `pnpm pack` 失败（shared、session-control 没有 version）。
  - 仓库外：`pnpm --filter @zcode-dev/plugin-api build` 用仓库已有的 tsup（`dts` 内部用 rollup-plugin-dts）把协议模块与 session-control 的声明内联进 `dist/*.d.ts`，共用部分拆成 chunk，只留 `zod` 一个外部依赖（类型里有 zod schema 的推导，所以 `zod` 是 `dependencies`，版本与 shared 相同）。`publishConfig.exports` 指向 `dist`，`pnpm pack` 产出的包只含 `dist`。没有另引入 api-extractor 等工具。
- **开源导出**：类型包与示例插件不含官方版本的安全校验、内部地址或个人信息，按开源规则（闭源树 − 排除项）照常导出，不改导出配置。

### 17.10 分步与验收

每一步跑通桌面 E2E 才进入下一步：

1. **P3a 授权骨架与 facade 读**（已完成，PLM-EXT-P3A）：档位、`grants`/`protocols`、新错误码、订阅带入参、`grants.json`、授权对话框、启用确认、审计、`session-control` 的客户端调用方与 `bindClient`、四个读档动作。E2E：未授权时调用报 `not-granted`，启动页显示「需要授权」；授权后能列出会话；撤销后又报 `not-granted`；审计文件有记录且没有正文；已有授权时启用第二个扩展会弹确认。
2. **P3b 读连接**（已完成，PLM-EXT-P3B）：进程内作用域、列表泵、会话镜像、三个订阅与 `readRows`、上限。E2E：在界面上发消息，测试插件的视图实时出现对应行；杀掉扩展进程后自动 `reset`；第 9 个订阅报 `limit-exceeded`；日志有 `extension-host:<gen>` 连接与退订。同一步补上 §17.7 从插件商店安装后、激活前的确认（P3a 只做了设置页启用时的确认）。
3. **P3c 写、插件项目与标识**（已完成。P3c-1，PLM-EXT-P3C：八个写动作、来源注入与拒绝伪造、消息标识、写审计、H10；P3c-2，PLM-EXT-P3C2：插件项目与 H7）：CLI 先写 spec 与测试（新来源、能力位）；8 个写动作；插件项目；消息标识。E2E：插件新建会话出现在插件项目里；插件发的消息在桌面与手机上都显示「来自插件 X」；同一个 `requestId` 重试只出现一条消息；中断成功；改名、归档、置顶、打开出现在「最近操作」。
4. **P3d 类型包**（已完成：`@zcode-dev/plugin-api`，见 §17.9 实现说明；重跑了 PLM-EXT-2A、2B、2C、P3A、P3B、P3C、JARVISHOST）：四个子入口；context-inspector 改用它；根目录 typecheck 通过；重跑 PLM-EXT 全部用例。
5. **P3e 回答审批、提问与切换权限模式**（§17.12）：三个能力、`createSession.mode`、`sessions.fullAccess`、授权原文、审计字段；Jarvis 的内联审批与模式切换。E2E：PLM-EXT-P3E、PLM-JARVIS-2（2026-11-07 随示例迁出删除，宿主断言移到 P3E）。

### 17.11 风险

- §7.3：任何扩展都能用已授予任一扩展的权限，归因也能被冒充。授权界面已写明。
- facade 没有审批。目标会话开着免确认模式时，插件一条消息就能让 Agent 执行工具。授权界面已写明。
- P3e（§17.12）之后，持有 `sessions.write` 的扩展能替用户回答插件项目里的审批；持有 `sessions.fullAccess` 的扩展能把这些会话切到完全访问。按 §7.3，任何已启用的扩展在技术上都能这样做。授权界面已写明；范围只到插件项目，用户平时工作的会话不受影响。
- 新来源的兼容（P3c 已验证）：写入一侧靠能力位拦住（旧 CLI 对 `sendText.source` 报 `proto.invalidPayload`，对 `createSession.firstInput.source` 静默剥掉）。读取一侧默认没有运行中的版本偏斜（CLI 随包、远端默认同版本、手机页面按版本发布），只在装回旧 App 时出现：旧 CLI 退回不校验的旧种子，来源原样进入行；有逐行降级的旧 App 把这一行显示成占位行，更早的 App 整个会话 `contentRejected`。排队项不跨进程保留。没有新增协商机制。决策（用户）：不处理回退，后果与考虑过的缓解见 [会话输入来源 §8](../../apps/zcode-cli/docs/design/v2/conversation-input-source.md#8-兼容旧-app-读到新来源)。
- 订阅冷会话会拉起 CLI，镜像占 Window Host 内存。靠上限控制。
- wait 最长 300 秒，跨 RPC 不能取消，只在换代时中止。

### 17.12 P3e：插件回答审批、提问与切换权限模式

> 用户决策（2026-11-06）：插件像宿主界面一样，可以替用户批准工具调用、回答 AskUserQuestion、切换会话的权限模式；不为此单独加权限档位，用已有的 `sessions.write`。完全访问（yolo）要插件在清单里申请，授权对话框单独写一行，用户授权时同意。范围只到插件自己的项目（§17.4）里的会话。只开放工具审批（`permission`）与提问（`userInput`）两种交互；工作区 Hook 信任审查与插件安装确认不暴露、不能回答。

```text
CLI（唯一事实源）
  会话快照：pendingInteractions[]、config.mode
     │ v4 订阅（扩展读连接 extension-host:<gen>，与手机同一套）        │ 桌面 / 手机的订阅
     ▼                                                              ▼
Window Host 会话镜像 ──► onDidChangeInteractions ──► 插件          宿主审批面板
  （只投影 permission / userInput 与 mode）
插件 resolveInteraction ─┐                                宿主「允许」─┐
                          ├─► V4 resolveInteraction ─► CLI：先到先得 ◄─┘
                          │   clientId = extension:<pluginId>
                          │   晚到的一方：CLI 幂等收下，不再生效
插件 setPermissionMode ───┴─► V4 switchCollaborationMode ─► CLI ─► config.mode 变化
                                                               ─► 两边订阅都看到交互消失 / 模式变化
```

- **范围**：会话必须在调用方插件的项目里（§17.4 的规则：本机未删除、目录含 `<dataPath>/workspace` 的项目）。会话引用经 facade `readSession(view:"summary")` 解析（与 §17.5 相同的授权与本机检查），引用里的 `project.projectId` 不在插件项目里时报 `forbidden`。三种操作（订阅、回答、切换）共用这条检查。插件还没有项目、或 `dataPath` 缺省时同样 `forbidden`（不为检查新建项目）。
- **完全访问的申请**：清单在 `extension.grants` 里声明 `sessions.fullAccess`。它是会话档位链的最高一档：`sessions.read` < `sessions.write` < `sessions.fullAccess`，高档包含低档，所以声明 `sessions.fullAccess` 等于同时申请读写。复用已有的授权规则：没授予时整个插件 `needs-consent`；插件更新时新加这一档算「声明变多」，回到待授权；去掉这一档时记录自动收窄。会话写操作仍按 `sessions.write` 检查；以下三种情况额外要 `sessions.fullAccess`，没声明报 `not-declared`，声明了没授予报 `not-granted`：
  - `setPermissionMode({ mode: "yolo" })`；
  - `resolveInteraction` 选 `fullAccess` 选项（`PERMISSION_FULL_ACCESS_OPTION_ID`，「允许并切到完全访问」）；
  - `createSession({ mode: "yolo" })`。
- **已有授权要重新确认**（用户决策，2026-11-06，取代原先「不需要重新确认」）：回答审批、回答提问、切换权限模式扩大了 `sessions.write` 能做的事，所以本阶段以前授予的 `sessions.write` 一律回到待授权，用户在新的授权对话框（写着这三项）里重新同意后才生效。
  - 实现：`grants.json` 每条记录多一个可选字段 `consentRevision`（整数）。当前值是 `EXTENSION_SESSION_CONSENT_REVISION = 2`（`packages/shared/src/extension-host/grants.ts`）；没有这个字段的旧记录按 1 处理。清单声明的档位覆盖 `sessions.write`（声明了 `sessions.write` 或 `sessions.fullAccess`）时，记录的 `consentRevision` 低于当前值就是 `needs-consent`，与「声明变多」相同：记录保留，会话能力报 `not-granted`，启动页显示「需要授权」，持有者列表（启用确认）不算它。用户授权时写当前值（任何档位都写）。只声明 `sessions.read` 或 `notifications` 的插件不受影响（它们的含义没变）。
  - 插件更新时的静默收窄、记下新版本照旧；旧记录不会因为插件更新而被悄悄升到当前值。新版本只声明 `sessions.read` 时，旧记录收窄后照常生效。
  - 以后会话档位的含义再变宽时，把常量加一，旧授权自动回到待授权；不需要迁移文件。变宽的档位不是 `sessions.write` 时，同时改判断的档位。

能力（档位都是 `sessions.write`；`EXTENSION_API_VERSION` 为 `1.4.0`）：

| id                                 | kind      | 入参                                                              | 返回 / 事件                                                                                           |
| ---------------------------------- | --------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sessions.onDidChangeInteractions` | subscribe | `{ sessionId }`                                                   | `{ sessionId, logEpoch, revision, mode, interactions }`；第一个事件是当前值，之后 mode 或交互变化才推 |
| `sessions.resolveInteraction`      | call      | `{ sessionId, interactionId, answer, requestId? }`                | `{ status: "accepted" \| "stale" }`                                                                   |
| `sessions.setPermissionMode`       | call      | `{ sessionId, mode: "build" \| "guarded" \| "yolo", requestId? }` | `{ status: "accepted" \| "unchanged" }`                                                               |
| `sessions.createSession`（已有）   | call      | 多一个可选的 `mode`（同上三个值）                                 | 不变                                                                                                  |

- `interactions` 是 v4 `pendingInteractionSchema` 里 `kind` 为 `permission` 或 `userInput` 的项，原样给出（选项、问题、`modeSwitch`、`fullAccessOption`），跟 `protocols.rows` 走；另外两种交互过滤掉。`mode` 是快照 `config.mode`（`build` / `edit` / `guarded` / `yolo` 等原值）。两个调用的协议都按 `rows` 检查，`setPermissionMode` 与 `createSession.mode` 的取值只开放宿主权限菜单里的三档（`edit` 是旧草稿回显值，`plan` 是单独的计划开关，都不开放）。
- `answer` 是 v4 `resolveInteraction.answer`（`optionId?`、`freeText?`、`action?`、`content?`），原样转给 CLI。网关先按镜像里的当前交互检查：交互不在当前快照里 → 不发命令，返回 `{ status: "stale" }`（已被宿主或别的客户端回答、已撤销或已结束）；`kind` 不是这两种 → `forbidden`；`permission` 的 `optionId` 必须是该交互 `options` 或 `fullAccessOption` 里的 id，否则 `invalid-input`。
- **先到先得**：网关检查与 CLI 收到命令之间，宿主也可能回答了同一个交互。CLI 对未命中的应答幂等收下（`interaction-background.ts`），所以这时插件拿到 `accepted`，但这次应答没有生效。哪一方的应答生效，以订阅里交互消失时的会话状态为准（工具行的结果、模式），插件不要用 `accepted` 判断「是我批准的」。
- `setPermissionMode`：当前 `mode` 已经是目标值时返回 `{ status: "unchanged" }`，不发命令；否则发 `switchCollaborationMode`，返回 `accepted`，新模式经订阅到达。宿主切到完全访问时弹的风险确认（`mode.yoloConfirmation`）由授权对话框的「完全访问」一行代替，插件切换时不弹。
  - 用户决策（2026-11-06）：保持现有语义——每条输入按提交时的模式开跑，`switchCollaborationMode` 不改写已提交、排队中的输入，CLI 不改。证据：轮开始时 CLI 再应用一次这条输入的模式（`apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:480`「session_persistence」→ `applySubmissionExecutionState`）；改写排队输入模式的只有授权路径（审批里选「允许并切到完全访问」，`SessionModeChanged.permissionGrant`）。所以在一条输入已提交、它的轮还没开始时切换，轮一开始模式就回到提交时的值，订阅随之收到回退（两次变化在同一帧时只收到最终值）。首轮要用别的模式用 `createSession.mode`；运行中或空闲时切换只影响之后发的消息。
- `createSession.mode`：只进端口、不进模型的工具面（与 §18.1 H10 的 `model` 相同，`withRequestIdentity` 的 port-only 字段）；会话类调用方带它报 `invalid_input`。新会话的首个提交按这个模式固定，缺省仍是 `build`。
- **命令的路径**：回答与切换经扩展读连接作用域（§17.5）发 V4 命令，与手机同一个入口；信封的 `clientId` 是 `extension:<pluginId>`，`commandId` 由请求身份派生（插件传了 `requestId` 就用它，同一 `requestId` 重试是同一个命令）。没有订阅时，网关临时挂一个镜像取当前快照，用完释放（计入每插件 8 个会话的上限）。
- **错误**：`forbidden`（不在插件项目、交互种类不开放）、`not-declared` / `not-granted`（完全访问）、`invalid-input`（选项不属于该交互）、`unavailable`（会话读不到、CLI 拒绝命令）、`cancelled` / `not-granted`（调用期间换代或撤销授权，同 §17.3）。CLI 的拒绝回执只记 `reasonCode` 进日志，扩展收到 `unavailable`。
- **审计**：每次回答、切换各记一行（§17.8 的字段），`capability` 为能力 id，`grant` 为 `sessions.write`，另加 `interactionKind`（`permission` / `userInput`）、`choice`（`permission` 记所选选项的 `kind`：`allowOnce` / `allowAlways` / `deny` / `custom`，选 `fullAccess` 时记 `fullAccess`；`userInput` 记 `answer` / `decline` / `cancel`）、`mode`（切换后的模式）。结果是 `stale` / `unchanged` 时 `outcome` 仍为 `ok`，另记 `errorCode: "result.stale"` / `"result.unchanged"` 便于区分。不记问题、选项文字、答案、自由文本。插件详情页「最近操作」显示成「回答审批」「回答提问」「切换权限模式」。
- **宿主一侧**：审批状态只在 CLI；插件回答后宿主的审批面板随快照消失，不需要宿主额外处理。工具行显示的是 CLI 记录的审批结果，不显示「由插件处理」：要显示它需要 CLI 持久化应答方，本阶段不做（不改数据库）。
- **已知限制：宿主与手机的输入框不跟随别的客户端切换的模式**（用户决策，2026-11-06：以后单独做）。插件（或手机）用 `switchCollaborationMode` 切换后，会话本身已经切换（投影 `config.mode` 变了，插件之后发的消息按新模式执行）；但输入框的草稿模式只在三种时候采用会话模式：打开会话后的第一帧、审批里选了「允许并切到某模式」、plan 切换（`packages/ui/src/v4/composer/useDraftConfigControl.ts:333-366`）。所以宿主输入框继续显示旧模式；用户从宿主发消息时带的是这个旧模式，轮开始时 CLI 按提交时的模式再设一次，会话模式被改回去。手机用同一个组件，行为相同。
- 日志：网关按 debug 记调用；后端记 info 一行（插件 id、会话 id、交互种类、结果），不记内容。

验收（PLM-EXT-P3E，fixture 插件在自己的项目里建会话）：本阶段以前的旧授权记录（没有 `consentRevision`）→ 会话能力报 `not-granted`、启动页显示「需要授权」，重新授权后可用；插件批准一次 → 工具执行；插件拒绝 → 工具被拒；插件回答 AskUserQuestion → Agent 收到答案；切换权限模式 → 订阅收到新 mode；没声明完全访问时切到 yolo 报 `not-declared`，清单加上并授权后成功，切换选项与 `createSession.mode` 同样；对插件项目以外的会话订阅或回答报 `forbidden`；插件回答后宿主审批面板消失；宿主先回答后插件再回答得到 `stale`；审计行没有内容。Jarvis 的内联审批、提问与模式切换由 PLM-JARVIS-2 覆盖。

## 18. P4：示例插件 Jarvis 与 GitLab

> 迁移（2026-11-07，[插件发布](./plugin-publishing.md) §6）：Jarvis 源码在市场仓库 `zcode-plugins` 的 `ui-plugins/jarvis`，从插件商店安装。z-code 里的 `examples/plugins/jarvis` 与用例 PLM-JARVIS-1、PLM-JARVIS-2 已删除；它们断言的宿主能力由 fixture 用例覆盖（PLM-EXT-JARVISHOST、P3B、P3C、P3C2、P3E 等，对照表见 [覆盖矩阵](../testing/plugin-management-lifecycle-e2e-coverage-matrix.md) 的「示例插件迁出」），Jarvis 自己的页面人工验收（§6.1）。下文的 Jarvis 设计与 §18.4 的步骤记录当时的实现与证据。

> 用户决策（2026-11-06）：示例插件 dot 改名为 Jarvis，插件 id 一起改成 `jarvis@inline`（清单名 `jarvis`，导航入口、视图标题与页面上显示「Jarvis」）。原因：避免与已有的「机器人」（Bots）功能混淆。接受的后果：旧 id `dot@inline` 下的本地数据（插件数据目录、人设文件、`state.json` 记的大脑、插件设置、授权记录）不迁移；改名后是一个新插件，要重新启用和授权，旧的大脑会话留在原来的 dot 项目里。宿主里按清单名显示插件的地方（授权对话框、插件列表、插件项目名、通知标题前缀）显示 `jarvis`。E2E 用例一起改名：PLM-DOT-1/2 → PLM-JARVIS-1/2，PLM-EXT-DOTHOST → PLM-EXT-JARVISHOST。

> 用户决策（2026-11-05）：GitLab 给模型读、评论、批准、合并四类工具，写工具每次审批；plan 模式自动放行非破坏性 MCP 工具的现有行为保持不变；Jarvis 的系统通知单独授权、默认开；Jarvis 要的可选宿主能力（导航未读标记、从视图请求授权）都做，确认色变量（H13）不做。
> 用户决策（2026-11-05，后续）：先做 Jarvis，GitLab 插件本体（§18.4 GitLab 第 4–9 步）往后放。Jarvis 用 TypeScript 写，类型从 `@zcode-dev/plugin-api` 导入，所以顺序是 P3b → P3c → P3d → Jarvis；当时 `@zcode-dev/plugin-api` 暂不发布到 npm（2026-11-07 起发布，见[插件发布](./plugin-publishing.md) §5）。
> 开发者文档推迟到 P3d 之后：P3 会改 `ctx`、清单的权限字段与类型的导入路径。

### 18.1 宿主要补的能力

两个插件共用。每一项按 §3.5 找后端、按 §7.2 加进能力表，不改业务服务。

| #   | 能力                                                                                                                                                                                                                                                                                                                                                        | 后端                                                                                | 谁要                         | 依赖              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- | ----------------- |
| H1  | `settings.update({ values?, clear? })`：只写调用方自己的插件，user 层，`grant: none`                                                                                                                                                                                                                                                                        | ① `IPluginManagementService.configurePlugin`，成功后照常触发 `settings.onDidChange` | GitLab 面板登录、Jarvis 设置 | 无                |
| H2  | `workbench.startDraft({ text, workspace? })`：在当前或指定工作区开一个预填文字的新草稿，不自动发送                                                                                                                                                                                                                                                          | ③ Renderer，走现有的 `onCreateTask({ initialPrompt })`（插件市场「试用」同一路径）  | GitLab「用 ZCode 审查」      | 无                |
| H3  | 扩展进程的网络跟随设置页：代理、No Proxy、自定义 CA 用与 CLI 相同的翻译注入扩展进程环境，只认设置页，留空直连（与 CLI 一致）；宿主在扩展进程启动时打开环境代理一次（插件不能自己调，它是全局的）。改设置后经「重新加载扩展」生效                                                                                                                            | Main 监管器                                                                         | GitLab（自建实例、自签证书） | 无                |
| H4  | 图标白名单加 `git-pull-request` 等 GitLab 用到的图标，DESIGN.md 同步                                                                                                                                                                                                                                                                                        | `extension-slots`                                                                   | GitLab                       | 无                |
| H5  | 视图声明 `scope: "app"`：标签不随焦点会话或工作区重建实例，跨工作区保留                                                                                                                                                                                                                                                                                     | `extension-host-protocol` + `extension-slots`                                       | Jarvis                       | 无                |
| H6  | `ctx.extension.dataPath`：插件数据目录（CLI 已有的 `~/.zcode/cli/plugins/data/<id>/`）                                                                                                                                                                                                                                                                      | `extension-host-protocol` + `extensions-service`                                    | Jarvis                       | 无                |
| H7  | 插件项目（§17.4）的唯一目录（主要目录）= `dataPath/workspace`，建项目时就给出，不走 0 目录项目自动建 `~/.zcode/workspace/<时间戳>` 的规则；扩展可以先在里面写好 `AGENTS.md` 再建会话                                                                                                                                                                        | `extensions-service`                                                                | Jarvis                       | P3c，已并入 §17.4 |
| H8  | `notifications.show({ title ≤64, body ≤240, target?: { view } })` → `{ shown, reason? }`：清单申请 `grants: ["notifications"]`，授权对话框同意，详情页单独开关，全局通知开关优先；每插件每分钟 1 条、每天 20 条；窗口有焦点时不弹；标题由宿主加插件名前缀；不允许自定义图标、声音、按钮、回复框；点击只聚焦窗口并打开本插件已声明的视图；Web 与手机远控不弹 | ③ Renderer（检查偏好）→ 新的 preload 方法 → Main 弹出                               | Jarvis                       | P3a 的授权        |
| H9  | `models.list()` → `[{ id: "provider/model", label, providerName }]`，过滤隐藏的 provider，`grant: none`（从 P5 提前）                                                                                                                                                                                                                                       | ① `IModelSelectionService.getView`                                                  | Jarvis 设置                  | 无                |
| H10 | client 类调用方的 `sessions.sendToSession` 可带 `model`（模型看到的工具 schema 不变）                                                                                                                                                                                                                                                                       | session-control + app-control                                                       | Jarvis 给大脑换模型          | P3c               |
| H11 | `nav.primary` 未读标记：动态值加 `badge`（数字或点）                                                                                                                                                                                                                                                                                                        | `extension-host-protocol` + `extension-slots`                                       | Jarvis                       | 无                |
| H12 | `grants.request()`：从视图请宿主弹授权对话框（只弹本插件清单已声明的档位）                                                                                                                                                                                                                                                                                  | `extensions-service` + `extension-slots`                                            | Jarvis                       | P3a               |
| H13 | ~~宿主下发「确认」色变量给扩展页面~~ 不做（用户决策，2026-11-05）：强调色由插件页面自己定义，见 §18.3「颜色」                                                                                                                                                                                                                                               | —                                                                                   | —                            | —                 |

实现（P4）：

- **H1 `settings.update`**（能力表一行，§7.2、§16.7）：
  - 入参 `{ values?, clear? }`，至少有一项；同一个键不能既写又清。`values` 最多 64 个键，键最长 128 字符，字符串值最长 16384 字符。不合规时报 `invalid-input`。返回 `undefined`。
  - 网关注入调用方插件 id，入参里没有插件 id。所以扩展只能写自己的插件（归因，不是安全边界，§7.3）。
  - 后端（`settingsBackend.ts`，① 调现有服务）先从 `plugins/list`（user 视图，与静态表同一个清单目录）取本插件的 `userConfig` 做校验。键不在 `userConfig` 里时报 `invalid-input`，信息只列键名。值的类型与选项类型不符时也报 `invalid-input`：`number` 要有限数字，`boolean` 要布尔值，其余类型要字符串。插件不在清单里时报 `internal`。
  - 校验通过后调 `IPluginManagementService.configurePlugin({ pluginId, options: values, clearOptionKeys: clear, scope: "user" })`，与设置页保存是同一条路径。CLI 按清单把敏感键写进 `plugin-secrets.json`，普通键写进 `config.json`；`clear` 的键两处都删。
  - 成功后走现有的成功信号（动作 `configure`，user scope）：Window Host 重读静态表，再通知本插件的 `settings.onDidChange`。`settings.update` 不等这次通知就返回。插件管理服务照常上报插件生命周期事件（`configure`，入口为 `unknown`）。
  - 空字符串是普通值，会写入。要删除一个键，用 `clear`。设置页不同：设置页里敏感键的空输入表示「不修改」。
  - 日志只有插件 id、写入键数与清除键数，失败时只记错误码。不记值，也不记键名。
- **H2 `workbench.startDraft`**（能力表一行，后端 ③ Renderer）：
  - 入参 `{ text, workspace? }`：`text` 去掉首尾空白后不能为空，最长 4000 字符（与 `composer.mention` 的 `insertText` 相同，`WORKBENCH_DRAFT_TEXT_MAX_LENGTH`）；`workspace` 是 `WorkspaceRef`。不合规时报 `invalid-input`。返回 `undefined`。
  - Window Host（`draftRelay.ts`）照 `views.open` 的请求与回执：经 `IExtensionViewsService.onDynamicDraftRequests` 把 `{ requestId, pluginId, text, workspace? }` 发给 Renderer，等 `ackDraftRequest`。两个方法放在视图门面，因为它与 `views.open` 同属「请 Renderer 执行并等回执」，`IExtensionsService` 的公开方法留给 P3。没有窗口在听时直接报 `host-unavailable`；最后一个监听退订（窗口关闭或重载）时，在途请求一起报 `host-unavailable`。不用超时。
  - Renderer：`ExtensionViewsProvider` 把请求交给 App 层的 `onStartDraft`。它先回到工作区与对话主视图（设置页、插件市场、自动化之上时也能看见新草稿），再调 Root 的 `onCreateTask({ initialPrompt: text, targetWorkspace? })`，与插件市场「试用」同一条新建任务路径。只写草稿，不发送，不新建会话；会话在用户发送时才建。
  - 回执表示窗口已接手请求，不等草稿准备完：Root 的新建任务在被更新的导航取代时直接返回，不回调，等完成会让扩展的调用一直挂着。准备草稿失败时 Root 照常提示用户（与「试用」相同），不回传扩展。没有指定 `workspace` 且当前工作区只读时，Renderer 不新建草稿，回执失败，扩展收到 `internal`。
  - 指定 `workspace` 时按 Root 的新建任务规则解析：继承该工作区当前任务所属的项目；只读由 Root 按目标判断（与 Shell 的 `handleCreateTaskInChat` 相同）。
  - 日志：Window Host 与 Renderer 都只记插件 id、文字长度、是否指定工作区与回执结果，不记文字本身。
- **H3 扩展进程的网络**：见 §12.1「网络跟随设置页」。监管器的依赖多一个 `readNetworkSettings`（Main 用自己的设置服务读 `httpProxy`、`httpProxyNoProxy`、`httpProxyCaCertPath`），`buildExtensionHostEnv` 多一个网络参数；扩展进程入口在加载扩展前调 `enableEnvironmentProxy()`。白名单不变。
- **H4 图标**：白名单（`extension-slots/components/extensionIcons.ts`）加 `git-pull-request`、`git-merge`、`log-in`、`log-out`；`git-branch` 原来就有。DESIGN.md「Extension slots」的「Icons」列出全部白名单名字，两处一起改。PLM-EXT-P2D 的 fixture 在启动页条目、导航条目与视图标签上用这几个图标，用例读 Lucide 的 `svg` class 确认没有退回通用插件图标。
- **H5 视图的 App 作用域**：
  - 清单 `contributes.views[].scope` 可选，只有 `"app"` 一个值；不写时照旧跟随侧栏目标（§8「作用域」）。静态表的视图带上 `scope`。
  - Window Host 是作用域的 owner：`prepareView` 与 `views.open` 遇到 app 视图一律按 `{ kind: "app" }` 打开，不看调用方传的作用域。Renderer 的标签页按静态表同样派生 `{ kind: "app" }`，所以切换焦点会话、草稿首发、新建会话都不重建实例；`ViewInstance.sessionId` 为空，扩展自己决定看哪个会话。
  - 标签跨工作区保留：app 视图的标签在任一时刻只存在于当前工作区的侧栏记录里（`taskSidePaneMemory` 里当前工作区那一份是唯一 owner，不另存一份 App 级标签表）。切换工作区时，侧栏把这些标签从旧工作区的记录里移走，接到新工作区标签的末尾，归属改记为新工作区；新工作区原来的当前标签与收起状态不变。标签对象与 id 不变，内容一直挂载，所以页面不卸载、实例 id 不变。在任一工作区关掉它就关掉了，回到旧工作区不会再出现。
  - 哪些标签跟着移动：打开时按静态表给标签记 `appScoped: true`（与实例作用域同一份声明）。file.viewer 打开文件的标签（带 `input`）仍是工作区级，不移动。
  - 窗口重载：侧栏标签只在内存里，与其他标签相同，重载后不恢复；扩展再次打开视图时新建实例。
  - 插件被禁用：静态表里没有这个视图，标签显示「不可用」，实例释放（与其他扩展视图相同）；标签照样跟着切换工作区，直到用户关掉。
  - 标签页的 `data-extension-view-scope` 为 `app`。E2E：打开 app 视图，切换焦点会话、切换工作区再切回，实例 id 都不变。
- **H6 `ctx.extension.dataPath`**：
  - 路径只有一个定义：CLI 发现插件时算出的 `PluginMetadata.dataPath`（`<CLI 插件存储根>/data/<净化后的插件 id>`，与 MCP server 的 `${ZCODE_PLUGIN_DATA}` 同一个值）。CLI 的 `plugins/list` 每项多一个可选字段 `dataPath`（CLI 规格见 [插件兼容 · Storage Layout](../../apps/zcode-cli/docs/design/v2/plugin-compat.md#storage-layout)）；App 不自己拼路径。
  - Window Host 读静态表时把它放进扩展声明（`extensionDeclarationSchema.dataPath`，只给扩展进程，不进推给 Renderer 的静态表）。
  - 扩展进程在调 `activate` 前 `mkdir -p` 这个目录，所以扩展拿到时目录已存在。声明里没有 `dataPath`（`plugins/list` 来自不报告它的旧 CLI）时激活失败，原因写明；建目录失败同样激活失败，日志只记错误码。
  - 插件卸载后由 CLI 按现有规则删除 `data` 目录（Storage Layout）；扩展进程不删。
- **H9 `models.list`**（能力表一行，`grant: none`，后端 ① `IModelSelectionService.getView()`，与输入框模型选择器同一份视图）：
  - 入参无；返回 `[{ id, providerId, modelId, label, providerName }]`。`id` 是 `<providerId>/<modelId>`；`providerId` 与 `modelId` 另给一份，因为模型 id 里可能有 `/`，插件不要拆 `id`。`label` 与选择器相同，就是 `modelId`（模型配置没有显示名）；`providerName` 是 provider 的显示名，没有时用 `providerId`。
  - 顺序与选择器相同（provider 顺序、provider 内模型顺序）。隐藏的 provider 由 `getView` 过滤，这里不再过滤；只看 provider 不看账号状态，与选择器列出的一致。
  - Window Host 没有模型选择服务时报 `unavailable`。不推变更事件：插件在打开设置时调用一次。
  - 日志只记返回的模型数。
- **H11 导航未读标记**：
  - 插槽动态值多一个字段 `badge`：正整数（未读数）或 `"dot"`（只表示有新内容）。`slots.update` 的补丁里 `badge: null` 清除。插槽字段对所有插槽通用，目前只有 `nav.primary` 渲染它，其他插槽忽略。
  - 渲染（DESIGN.md「Extension slots · nav.primary」）：标题之后、行尾。数字用与「已停止」相同的 `bg-tag` 小标签（`text-ui-xs tabular-nums`），超过 99 显示 `99+`；`"dot"` 用任务列表未读点同一样式（`size-[7px] rounded-full bg-icon-blue`）。扩展进程已停止时动态值随快照清空，标记不显示。
  - 可访问名称在标题后加「N 条未读」/「有新内容」（`extensions.nav.badge.count` / `extensions.nav.badge.dot`）。点击条目不自动清除标记：什么时候算已读由扩展决定（例如视图打开后清除）。
  - 行上带 `data-extension-badge`（数字、`dot` 或空），E2E 读它。
- **H12 `grants.request`**（能力表一行，`grant: none`，后端 ③ Renderer）：
  - 入参无；返回 `{ granted }`，是请求结束时本插件生效的档位（与授权状态的 `granted` 同义）。扩展用它决定接下来能不能调会话能力，不需要先订阅授权状态。
  - 只弹本插件清单当前声明的档位，用启动页「需要授权」同一个授权对话框（`useRequestExtensionGrant`，同一段原文与同一个 `grant` 调用）。插件没有声明档位、已经授予、或状态是 `inactive` 时不弹，直接返回当前的 `granted`。
  - Window Host（`grantRequestRelay.ts`）照 `workbench.startDraft` 的请求与回执：经 `IExtensionGrantsService.onDynamicGrantRequests` 把 `{ requestId, pluginId }` 发给 Renderer，等 `ackGrantRequest`。同一插件已有在途的请求时合并成一次，不叠对话框。Renderer 在用户确认或取消、授予调用结束之后才回执，所以 Window Host 收到回执时读到的授权状态已经包含这次结果。没有窗口在听时报 `host-unavailable`；最后一个监听退订时在途请求一起报 `host-unavailable`；不用超时。
  - 用户取消不是错误：返回不含新档位的 `granted`。授予失败（清单在对话框打开期间变了、写文件失败）同样返回当前的 `granted`，Renderer 照常提示用户。
  - 不能借它授予清单以外的档位，也不能跳过对话框：授予仍只走 `IExtensionGrantsService.grant`，由用户在对话框里确认（§17.7）。
  - 日志只记插件 id、是否弹出与结果档位。
- **H8 `notifications.show`**（能力表一行，`grant: "notifications"`，后端 ③ Renderer → preload → Main）：
  - 档位：`EXTENSION_GRANTS` 加 `"notifications"`，与会话档位互不覆盖。插件在清单 `extension.grants` 申请，在同一个授权对话框里同意（用户决策：单独授权）。对话框标题按会话档位不变；只申请通知时标题是「允许「X」发送系统通知？」；申请了通知时正文多一段通知说明（限额、可单独关闭、系统通知开关优先）。启动页「需要授权」一行的档位文字是「发送系统通知」。
  - 详情页开关（用户决策：默认开）：授予后插件详情页「权限」区块多一行「系统通知」开关，默认开。开关状态记在 `grants.json` 该插件的记录里（可选字段 `notificationsOff`，旧文件没有它按开处理），授权状态多一个 `notificationsEnabled`（只在通知档位生效时出现）。新方法 `IExtensionGrantsService.setNotificationsEnabled({ pluginId, enabled })`，写文件、写审计行（`grants.notifications.on` / `grants.notifications.off`）后发布。重新授权保留用户的选择；撤销授权连同开关一起删除。
  - 启用确认只看会话档位：只持有通知档位的插件不算「持有会话权限」（§17.7）。
  - 入参 `{ title, body, target? }`：`title` 1–64 字符，`body` 1–240 字符，`target.view` 是本插件清单声明的视图本地 id（否则 `not-declared`）。返回 `{ shown, reason? }`，`reason` 是 `muted`（详情页开关关了）、`rate-limited`、`disabled`（设置页的系统通知开关关了）、`focused`（窗口在前台）、`unsupported`（平台不能弹通知）。不弹不是错误。
  - 判断顺序：网关查档位 → Window Host（`notificationRelay.ts`）查详情页开关 → 限额（每插件 60 秒内 1 条、本机日期同一天 20 条，只计真正弹出的，存在内存里，Window Host 重启清零；同一插件的调用串行，避免两次同时通过）→ 经 `IExtensionViewsService.onDynamicNotificationRequests` 交给 Renderer，等 `ackNotificationRequest`（与 `workbench.startDraft` 同属「请 Renderer 执行并等回执」）→ Renderer 查设置页的系统通知开关（设置「通用」里的「任务通知」，`notificationEnabled`；产品只有这一个系统通知开关，扩展沿用它）→ preload `showExtensionNotification` → Main：任何窗口有焦点时不弹；`Notification.isSupported()` 为假时不弹；否则弹出。没有窗口在听时报 `host-unavailable`。
  - 标题由宿主加插件名前缀（`extensions.notifications.title`：「{plugin}：{title}」/「{plugin}: {title}」），正文原样。不允许自定义图标、声音、按钮或回复框：Main 用默认图标，`silent: true`，不发任务通知的提示音。
  - 点击：Main 恢复并聚焦发出请求的窗口（与任务通知相同），把 `{ pluginId, viewId }` 发回该窗口；Renderer 只打开静态表里属于这个插件的视图。没有 `target` 时只聚焦窗口。
  - Web 与手机远控：没有扩展门面，也没有 preload 方法，不弹（`unsupported`）。
  - 日志只记插件 id、结果与原因，不记标题与正文。
  - 审计：授权行的 `grant` 仍只记一个最高档位（§17.8），同时授予会话与通知时记会话档位；通知开关的变化另记一行。
  - E2E：Main 的 `Notification.prototype.show` 换成记录，窗口焦点读数换成失焦，所以不会在测试机上弹真实通知；用记录的实例触发 `click` 验证打开视图。
- **H10 `sendToSession` 的 `model`**（P3c-1）：`appSendToSessionInputSchema` 的端口 schema 多一个可选 `model`（与 `createSession` 的 `model` 同一个 `modelSchema`）；工具面 schema（`.tool`）不含它，模型看到的会话控制工具不变。`withSessionTarget` 因此多一个只进端口、不进工具面的字段组。app-control 只接受客户端类调用方带 `model`（会话类带了报 `invalid_input`），按 `createSession` 相同的规则解析成完整选择（`modelId` 或 `providerId/modelId` 必须唯一匹配、provider 不能隐藏、选项合法），作为 `sendText.modelSelection` 发出；不改 `mode` 与 `planEnabled`。不带 `model` 时行为不变（CLI admission 固定会话当前选择）。`model` 只作用于这一条输入，不改会话的常驻选择：时间线显示一次模型切换，之后不带 `model` 的输入回到会话原来的模型（PLM-EXT-P3C 的运行时证据）。要让之后每一轮都用所选模型，调用方每次发送都要带 `model`。

### 18.2 GitLab

**范围**：设置与登录、MCP 工具、review skill、面板（登录、管理 MR）、`@` 条目。不做文件查看器、OAuth、新建 MR、diff 视图与行内评论、多账号。

- **设置**：`userConfig` 两个键：`base_url`（默认 `https://gitlab.com`，只接受 `https:`；`http:` 只放行回环地址给 mock 用）与 `token`（`sensitive: true`）。用个人访问令牌：只读用 `read_api`，要评论、批准、合并用 `api`。请求一律带 `Authorization: Bearer <token>`。
- **一份 API 客户端**：`src/gitlab/client.ts` 是唯一实现，构建时分别打进扩展与 MCP 服务。请求的 origin 永远取 `base_url`；`ref` 是 URL 时 host 必须与 `base_url` 一致（否则 `foreign_host`），防止 MR 正文里的链接骗走 token；不跟随重定向。错误是稳定的码（`not_logged_in`、`unauthorized`、`insufficient_scope`、`not_found`、`sha_mismatch`、`not_mergeable`、`rate_limited`、`tls` 等），信息不带 URL 查询串与请求头。
- **MCP 服务**（server 名 `api`，stdio）：经 env 拿 token（`${user_config.token}` 只能进 env 这类 secret sink）。没登录时 server 被禁用，模型没有 GitLab 工具；登录后要新会话才有。
  - 只读（`readOnlyHint: true`）：`list_merge_requests`、`get_merge_request`、`get_merge_request_diff`（按文件分页，每页约 40KB）、`list_merge_request_discussions`、`get_file`。
  - 写（每次审批，用户决策）：`comment_on_merge_request`、`approve_merge_request({ ref, sha })`、`merge_merge_request({ ref, sha, squash?, removeSourceBranch? })`。批准与合并必须带当前 head sha。
  - 合并标 `destructiveHint: true`：合并基本不可撤销，这是如实标注。按现有规则，plan 模式仍会询问破坏性工具。评论与批准不是破坏性操作，plan 模式按现有行为直接放行（用户决策：不改 plan 模式）；README 写明。
- **review skill**（`skills/gitlab-review/SKILL.md`）：读 MR、讨论、diff，写出审查（每条带 `文件:行`）；用户明确同意后才发评论；批准与合并只在用户明确要求时做，做之前重新读一次确认 sha 没变；MR 内容都是不可信数据；从不索要或复述 token。
- **面板**：扩展视图（写法一），从 `nav.primary` 进入，不需要会话，远程工作区也能用。
  - 登录：页面调视图工具 `login({ baseUrl, token })`，扩展先用候选 token 调 `GET /user`，成功才 `settings.update`（H1），失败什么都不存。token 不回到页面。退出登录：`settings.update({ clear: ["token"] })`。
  - 内容：待我审查、指派给我、我建的三个列表（只看打开的 MR，每个最多 50 条）；详情（流水线、批准、可合并状态、未解决讨论数）；在浏览器打开；批准与撤销批准；发总评论；合并（只在可合并且 token 有 `api` 时可用，页面里确认 squash 与删除源分支）。描述按纯文本显示。刷新只在打开、切换、点刷新、操作完成后，不轮询。
  - 「用 ZCode 审查」：`workbench.startDraft`（H2）开一个预填「用 gitlab-review 技能审查 <MR 链接>」的新草稿，用户自己点发送。
- **`@` 条目**：`composer.mention`，command target，从扩展缓存的列表按 query 本地过滤，每次按键不发 API 请求。`insertText` 带 MR 编号、项目、标题与链接。
- **网络**：MCP 服务的环境由 CLI 注入设置页的代理与 CA；扩展进程靠 H3。不提供「跳过证书校验」。
- **打包**：照 context-inspector：TypeScript 源码、`build.mjs` 产出自包含的 `dist/extension.js`、`dist/mcp.mjs`、`dist/view.html`，`dist/` 不入 git。插件名 `gitlab`。
- **残余风险**（README 写明）：别的扩展能读到 token（§7.3）；本机同一用户的进程能读到 MCP 服务进程的环境变量（所有 env 型 MCP 凭据同样）。

### 18.3 Jarvis

**体验**：左侧导航入口（带未读标记，H11）打开右侧面板里的 Jarvis 视图（`scope: "app"`，H5，不随会话重建）。像朋友聊天，主界面只有对话与输入框；设置在 ⚙ 打开的次级面板里（聊天模型、默认权限模式、小结频率、安静时段、在 ZCode 里打开 Jarvis 的会话，以及一行说明系统通知在哪里开关）。

> 用户决策（2026-11-06）：
>
> - 「新会话模型」不做：设置面板没有这一项。大脑经自己的 CreateSession 工具建的会话用宿主的默认模型，提示词里也不加这方面的提示。
> - 「系统通知」Jarvis 里不放开关：每个插件唯一的开关在宿主插件详情页的「权限」区块（H8），总开关仍是设置里的「任务通知」。Jarvis 的设置面板只放一行文字指向那里。Jarvis 不保存自己的通知开关状态；`notifications.show` 返回 `{ shown: false, reason }` 时只跳过，日志只记原因码。

**样式**（用户决策，2026-11-06，取代 2026-11-05 的「颜色」决策与当天试过的多色霓虹方案）：Jarvis 的页面完全自己定样式，不受宿主设计系统约束，不读宿主的设计变量；宿主的主题只用来在 Jarvis 自己的两套色板之间选。宿主不为它新增颜色变量，所以不做 H13。

- 统一的单色系：纸面（浅色 `#fafaf8` / 底板 `#eeeeeb` / 墨 `#202220`）与碳面（深色 `#111212` / 底板 `#1d1e1d` / 墨 `#ecece8`），加唯一一个强调色钴蓝（浅色 `#2152e7`，深色提亮为同色相的 `#7396ff`），只用在扫描与检测的叠层和「等你确认」上。不用第二个强调色，不用多色渐变。正文与注记对比度都不低于 4.5:1。
- 视觉语言是量化线场：Jarvis 的星由竖向短线段画成，粗细只有 4 档（0.38 / 1.12 / 2.28 / 3.80 个单位，不透明度 .15 / .64 / .93 / 1），平头，一节节像竹子；亮度来自星形加种子值噪声的缓慢漂移，指针掠过时线段径向推开、按弹簧（刚度 145、阻尼 19）回位。小星在顶栏，大星在欢迎页、提示页与开机。
- 不用光晕、模糊、毛玻璃与大范围阴影。层次来自错位底板：同尺寸的底板在卡片下方 6px，一条偏墨色的发丝边；悬停时卡片抬起 4px、底板落到 12px，300ms ease-out。
- 字体只用本地字体栈：少数大标题用衬线，界面与正文用无衬线，`x24 / y18` 这类坐标注记用等宽。
- 动效：开机时整片线场从噪声收拢成星，钴蓝检测框锁定并显示坐标，再让顶栏、消息与输入框依次就位（约 1.9 秒，点击或按键跳过，快照与设置变化不重放）；思考与回复时顶栏的星漂得更快、一道亮带扫过，正在写的回复由一个检测框跟着（角标、扫描线、已收到的字数）；发送时一道钴蓝扫描线扫过输入框；键盘焦点处显示检测框与 x/y 坐标；新消息位移加透明度进场。顶栏有暂停按钮（`aria-pressed`）；减少动态效果时一开始就是暂停的，只留短淡入淡出。
- 视图与导航入口的图标是 `sparkles`（白名单里已有）。

**大脑会话**：Jarvis 项目（§17.4）里一个长期会话，对话历史就是它，在宿主任务列表里可见（审批在那里确认）。

- 人设写在 `dataPath/workspace/AGENTS.md`（H6、H7），扩展在建会话前写好。指令文件在上下文前缀里，压缩不会把它压掉；用户可以自己改。要点：像朋友一样短句回答；用会话工具看会话、帮用户做事；不改文件、不跑命令；不用提问工具、不进计划模式；提到会话时写 `[标题](zcode-session:sess_…)`，页面渲染成可点的标签。
- 事实：`createSession` 不能选 agent 或传系统提示（`packages/session-control/src/contract/app.ts:62-69`），所以人设不走这两条路。

**创建并管理会话**：大脑是普通 ZCode 会话，模型自带 12 个会话控制工具，只读的四个不需要审批（`needsApproval: !readOnly`）。所以扩展只做六件事：`createSession`（建大脑）、`sendToSession`（发消息，可带模型，H10）、`readRows` / `onDidChangeRows`（读回复）、`readSession(view:"summary")`（取 `executionId`）、`interruptSession`、`openSession`（带用户去宿主确认审批）；P3e 之后再加 `onDidChangeInteractions`、`resolveInteraction`、`setPermissionMode`（见下面「审批」）。需要会话写权限（清单声明 `sessions.fullAccess`，包含读写）；没授权时用 `grants.request`（H12）请宿主弹对话框。

**审批**（P3e 之后，§17.12）：大脑会话在 Jarvis 的插件项目里，Jarvis 用 `onDidChangeInteractions` 拿到待处理的审批与提问，在 Jarvis 里直接回答；「去 ZCode 里确认」（`openSession(大脑)`）保留为次要入口。卡片随交互消失而消失，不轮询。

- 审批卡片：工具摘要与该交互的选项（允许一次、始终允许本项目、拒绝；CLI 给了 `fullAccessOption` 时再显示「允许并切到完全访问」）。选项按 `kind` 用 Jarvis 自己的文字，`custom` 用 CLI 给的文字。回执回来前按钮不可用；`stale`（已在宿主里回答）不提示，卡片随快照消失。
- 提问卡片：AskUserQuestion 的每道题（单选、多选）与一个「其他回答」输入框（与宿主的提问面板相同，总是有）；「回答」走 `answer.action: "accept"` 与 `content`（形状与宿主相同：`answers` 按问题原文，`answer_<序号>`，只有一道题时另给 `answer`；没答的题不写），「跳过」走 `decline`。别的提问（例如 MCP 要的表单）只给「去确认」。有待回答的审批或提问时，这一轮显示「等你确认」。
- 权限模式：Jarvis 头部显示大脑会话的当前模式（变更前确认、自主模式、完全访问），可以切换；悬停提示与切换后输入框上方的一句都写明「从下一条消息起生效」（§17.12 用户决策：每条输入按提交时的模式开跑）。授权按插件整体生效：Jarvis 能读写会话时，清单里的 `sessions.fullAccess` 一定也已授予，所以完全访问一直可选。设置面板的「默认权限模式」（`default_mode`）在新建大脑时用（`createSession.mode`），已有的大脑不改。
- 清单 `extension.grants` 为 `["sessions.fullAccess", "notifications"]`（`sessions.fullAccess` 包含读写）。

**流式**：replayable 投递会推助手正文的流式文本（`zcode-protocol-v4/core.ts:47-58`），Jarvis 大约每 150ms 收到一份完整的回复行，能做出打字效果，不改宿主。页面照 context-inspector：同一时刻只有一次在途请求，期间的通知合并。

**定时小结**：扩展自己计时，只在 App 运行时生效。上次小结的时间从历史里找带 `[jarvis:digest]` 标记的行，不另存。App 启动时超期只补发一次。只把上次小结后有变化的会话写进提示词；没有变化不发，不花模型费用。页面把带标记的行画成分隔线加小结。小结到达且窗口没有焦点时，经 `notifications.show`（H8）弹系统通知，并在导航入口打未读标记。

**模型可配**：设置面板的模型下拉来自 `models.list`（H9），保存用 `settings.update`（H1）；下一轮经 `sendToSession` 的 `model` 生效（H10）。

**一轮对话的状态**：

```text
idle ─发送─► admitting ─accepted─► waiting ─正文流式─► streaming ⇄ tool（一行摘要）
             ├ queued ─轮到─► waiting
             └ rejected ─► error
streaming/tool ─pendingApproval─► approval［允许 / 拒绝 / 去确认］─Jarvis 或宿主里回答─► streaming/tool
运行中 ─完成─► done ─► idle；─中断─► interrupted ─► idle；─失败─► error ─［重试］─► admitting
```

实现（Jarvis，当时在 `examples/plugins/jarvis/`，现在在市场仓库 `ui-plugins/jarvis`）：

- **清单**：插件名 `jarvis`。`extension.grants` 为 `["sessions.write", "notifications"]`，第一版就声明通知档位，以后加小结通知时不用让用户重新授权（档位变多会回到待授权，§17.7）；`protocols` 为 `{ sessions: 1, rows: 4 }`。一个视图 `home`（`scope: "app"`，图标 `sparkles`，白名单里已有；导航入口用视图的图标），从 `nav.primary` 的一项 `home` 打开（`target: { view: "home" }`），不放启动页。`userConfig` 随 Jarvis 第 4–8 步加入（见下面「设置」），第一版没有设置面板。
- **代码结构**：照 context-inspector（TypeScript 源码，`build.mjs` 产出自包含的 `dist/extension.js` 与 `dist/view.html`，`dist/` 不入 git；类型全部从 `@zcode-dev/plugin-api` 导入）。扩展是状态的唯一 owner：大脑会话、行窗口、本轮状态都在扩展里，页面只渲染扩展给的快照。
- **页面与扩展的通信**（写法一，宿主帮手，与 context-inspector 相同）：页面订阅状态资源 `ui://<插件 id>/home#state`；扩展状态变了就 `view.notify`，页面收到 `resources/updated` 后调工具 `snapshot` 读整份快照。同一时刻只有一次在途读取，期间的通知合并成读完后的一次。页面的动作都是视图工具：`send({ text })`、`loadOlder()`、`openSession({ sessionId })`、`requestGrants()`、`retry()`。快照只带渲染要的投影（消息、工具摘要、本轮状态），不带原始行。
- **授权**：激活时调一次 `sessions.listProjects` 探测档位，报 `not-granted` 时快照状态为 `needs-grant`，页面显示说明与「授权」按钮，点击调 `grants.request`（H12）。宿主没有授权状态事件：用户在启动页授了权，Jarvis 不会知道；但页面的「授权」按钮在已授予时不弹框、直接返回生效档位，Jarvis 随即继续。订阅以 `not-granted` 结束（授权被撤销）时同样回到 `needs-grant`。
- **找回大脑**：大脑的会话 id 存在 `dataPath/state.json`（`{ version: 1, brainSessionId }`，原子写，只由扩展写）。不从插件项目里推断：用户可以在 Jarvis 项目里自己建任务，项目里的会话不都是大脑。会话本身仍是对话内容的唯一来源，文件只记「哪一个是大脑」。启动时有记录就订阅它的行（订阅经 facade 解析会话，与 `readSession` 同一份授权）。订阅或发送以 `forbidden` 结束（会话不再属于本机，例如已删除，见「实现（Jarvis 第 4–8 步）」的「大脑被删的信号」）时清掉记录，显示欢迎页，下一条消息建新的大脑；其余错误（`unavailable` 等）显示错误与「重试」，不清记录。
- **首发**：大脑不存在时，`send` 先确保 `dataPath/workspace/AGENTS.md` 存在（文件不存在才写，用户改过的保留），再 `createSession({ prompt })`。不带项目，所以会话进插件项目，cwd 是这个目录（§17.4、H7）。创建成功后写 `state.json`，再订阅行。之后的消息走 `sendToSession({ sessionId, prompt })`。两者的 `requestId` 都由扩展进程补（§17.3）。
- **人设**（`AGENTS.md`，一份中文，要求按用户的语言回答）：

  ```markdown
  # Jarvis

  你是 Jarvis，住在 ZCode 里的一位朋友。用户会随时来找你聊天，问问工作进展，或者请你帮忙打理 ZCode 里的会话。

  ## 说话方式

  - 像朋友聊天那样，用短句回答。用户用什么语言，你就用什么语言。
  - 不写长篇大论，不堆标题；需要时用简短的列表。

  ## 你能做的事

  - 用会话工具查看用户的会话：列出会话、读会话内容、等会话完成。
  - 帮用户在别的会话里做事：新建、分叉、发消息、中断、改名、归档、置顶、打开会话。这些操作会先请用户确认。
  - 提到某个会话时，写成 `[会话标题](zcode-session:会话 id)`，例如 `[修复登录](zcode-session:sess_…)`，用户点一下就能打开。

  ## 不要做的事

  - 不改文件，不运行命令。需要改代码时，建议用户在对应的会话里做，或者经会话工具把任务交给那个会话。
  - 不使用提问工具，不进入计划模式。有不清楚的地方，直接在回复里问。
  ```

- **行窗口与历史**：订阅 `onDidChangeRows({ sessionId: 大脑 })`。`reset` 替换整个窗口；`rows` 按 `rowId` 覆盖；`stale` 用 `readRows`（不带 `beforeRowId`，最近 200 行）补读后合并。往上翻到顶时页面调 `loadOlder`，扩展按窗口里最小的 `rowId` 调 `readRows({ beforeRowId, limit: 50 })`，结果并进窗口；`hasMore` 为假时页面不再显示「更早的消息」。`reset` 时丢掉先前翻出来的旧页（镜像窗口是权威的），用户再往上翻时重读。扩展进程换代后插件重新激活、重新订阅，第一个事件是 `reset`，页面照常恢复。
- **投影**（扩展把行变成页面的消息，页面不读原始行）：
  - `userInput` 且 `origin` 为 `realUser` → 用户气泡。
  - `assistantText` → Jarvis 气泡，`state` 为 `streaming` 时带打字态。
  - 失败（`turnHeader` 为 `failed`）且一个字都没有回复的一轮：在这一轮最后一条消息后补一条空的失败回复，页面画成一行「信号中断」。修复原因（用户截图：同一句话连着出现两次、后面只有一条回复）：模型一开始就报错的一轮没有 `assistantText` 行，投影里什么都不留，用户点「重试」重发同一句话后像是发了两次。
  - `toolCall` → 一行摘要：工具名与状态。`pendingApproval` 的「等你确认」卡片属于第 4 步。
  - `reasoning`、`turnHeader`、`hookInvocation`、`timelineMarker`、`artifact`、`subagent`、`unreadable` 与其他来源的 `userInput` 不显示（`turnHeader` 只用来算本轮状态）。
- **本轮状态**（上图映射到行；由行与扩展的在途调用现算，不另存）：
  - 发送调用在途 → `admitting`。
  - 调用返回 `rejected`（`createSession` 是 `creation` 或 `firstInput` 为 `rejected`）→ `error`。
  - 返回 `accepted` 后，还没有 `sourceCommandId` 等于回执 `operation.commandId` 的 `turnHeader` 时，按回执的 `delivery` 为 `queued` 或 `waiting`。
  - 有了这一轮的 `turnHeader` 后：`state` 为 `running` 时，有 `pendingApproval` 的 `toolCall` → `approval`；这一轮最后一行是 `inputStreaming` 或 `running` 的 `toolCall` → `tool`；有非空 `assistantText` → `streaming`；否则 `waiting`。`completedSuccess` → `idle`（done 不单独显示）；`completedInterrupted` → `interrupted`；`failed` → `error`。
  - 没有在途调用、也没有回执时（例如 App 重启后），取最后一个 `turnHeader` 套同样的规则，所以正在进行的一轮照样显示。
  - 运行中（`admitting` 到 `approval`）输入框不能发送。
- **会话链接**：助手正文是受限的 Markdown（段落、换行、粗体、斜体、行内代码、代码块、列表、链接），不渲染 HTML，文本只经 `textContent` 写入。`zcode-session:<会话 id>` 的链接画成可点的标签，点击调视图工具 `openSession`，扩展调 `sessions.openSession({ sessionId })`。`http:` 与 `https:` 链接经页面层的 `openExternal` 在浏览器打开；其他协议的链接只显示文字。
- **页面文字**：中英文两套（zh-CN、en-US），按宿主下发的 `locale` 选；其他语言用英文。
- **上限**：一条消息最长 4000 字符（与 `workbench.startDraft` 相同）；同一时刻只有一个发送在途；「更早的消息」每页 50 行。
- **设置**（第 4–8 步）：`chat_model`（聊天模型，`providerId/modelId`，空表示用会话当前的模型；每一轮经 `sendToSession` 的 `model` 带上，H10）、`digest_interval`（小结频率）、`quiet_hours`（安静时段）。没有「新会话模型」与「系统通知」两项（用户决策，见 §18.3 开头）。

实现（Jarvis 第 4–8 步）：

- **快照按修订号增量读**（第一版的风险：每份快照带全部消息，流式期间每次变化都整份重读）：扩展给每条投影消息记一个版本（内容变了就记成当时的修订号），快照带 `epoch`（每次激活随机生成）、`revision`、全部消息的 id 顺序 `order` 与 `changed`。页面调 `snapshot({ since: { epoch, revision } })`：`epoch` 对得上时 `changed` 只有版本大于 `since.revision` 的消息，否则（第一次读、扩展换代）`full: true`，`changed` 是全部消息。页面按 id 保留消息，按 `order` 排列。读取仍是同一时刻只有一次在途，期间的通知合并。
- **工具摘要**：12 个会话控制工具用中英文的一句话（如「看了看会话列表」「给会话发消息」），其他工具显示工具名；后面跟状态。
- **审批**（第 4 步）：`toolCall` 的 `status` 为 `pendingApproval` 时，在这一行的位置画「等你确认」卡片：工具摘要、说明「去 ZCode 里确认」、按钮「去确认」。按钮调视图工具 `openSession({ sessionId: 大脑 })`，宿主打开大脑会话，用户在那里批准或拒绝。卡片只由行状态决定，行变成别的状态卡片就没了，不轮询。
- **停止**（第 5 步）：运行中（`queued` 到 `approval`）发送按钮换成「停止」。视图工具 `stop` 先 `readSession({ sessionId: 大脑, view: "summary" })` 取 `executionId`，再 `interruptSession({ sessionId, expectedExecutionId })`。读不到 `executionId` 时什么都不做，返回 `not-running`。本轮的 `turnHeader` 变成 `completedInterrupted` 时显示「已停止」。
- **错误与重试**（第 5 步）：本轮 `error` 时显示错误卡片：原因与「重试」。视图工具 `retryRound`：发送被拒（`facts.error`）时重发那次的文字（只在扩展内存里，App 重启后没有这张卡片）；本轮失败（`turnHeader` 为 `failed`）时重发这一轮用户那条输入的文字（取自行，App 重启后照样能重试）。重发走普通发送，带同样的模型。
- **大脑被删的信号**（运行时观察，PLM-JARVIS-2 g）：用户删掉大脑任务（侧栏「删除」，Host `deleteTask`）后，已开着的行订阅不结束（会话仍在 CLI 里）；下一次 `sendToSession` 报 `forbidden`（app-control 在项目树里找不到这个任务），新的订阅走同一个解析，同样是 `forbidden`。Jarvis 只在 `forbidden` 时忘掉大脑（清 `state.json`），页面回到欢迎页，这次的文字留在输入框，提示「之前的对话已经不在了，再发一次，就从头开始新的对话」，用户再发一次就建新的大脑。`unavailable` 等其他错误只显示错误与「重试」，不清记录。
- **小结**（第 6 步）：
  - 提示词第一行是标记 `[jarvis:digest]`，之后是说明与变化的会话列表（每行 `[标题](zcode-session:id)`、状态、更新时间）。语言跟宿主的 `locale`（`env.get`）。只经 `sendToSession` 发给大脑，带聊天模型。
  - 投影：`origin` 为 `realUser` 且文字以标记开头的 `userInput` 画成分隔线「小结 · 时间」，不画用户气泡；同一轮的 Jarvis 回复带小结样式。
  - 上次小结的时间：窗口里最后一条标记行的 `createdAt`。窗口里没有、上面还有更早的行时，向上用 `readRows`（每页 200 行，最多 10 页）只找标记行，不并进窗口；都没有就当作从没小结过。这是从历史现算的，不另存。
  - 变化的会话：`listSessions({ limit: 200 })`（不含归档）里 `updatedAt` 晚于上次小结的会话，去掉大脑自己，最多 30 个。从没小结过时取最近一个小结周期内（`digest_interval`，为 0 时取 24 小时）更新过的。一个都没有就不发，不花模型费用；手动触发时页面提示「没有新变化」。
  - 定时：扩展自己的定时器，只在 App 运行时生效。下次时间 = max(上次小结, 上次检查) + `digest_interval` 小时；两者都没有时从读到过的大脑最早一行算，所以新建的大脑不会马上发小结，很久以前就有、从没小结过的大脑已经超期。`digest_interval` 为 0 时不定时。到点时在安静时段里就推到安静时段结束；大脑正在运行就等这一轮结束再发。App 启动时已经超期，就只补发一次（发完或检查过后按新的时间算）。上次检查的时间只在内存里，扩展换代后从上次小结重新算。扩展停用时清掉定时器。
  - 手动：大脑存在、本轮空闲时，输入框上方有「现在总结一下」按钮，调视图工具 `digestNow`，与定时走同一条路径（不受安静时段限制）。
- **通知与未读**（第 7 步）：小结这一轮完成（这次发送回执的 `commandId` 对应的 `turnHeader` 变成 `completedSuccess`）时，不在安静时段就调 `notifications.show({ title: "小结" / "Digest", body: 小结正文的纯文字前 240 字, target: { view: "home" } })`，宿主决定弹不弹（窗口在前台、开关关闭、限流都由宿主判断，Jarvis 只记 `reason`）。这时没有打开的 Jarvis 视图，就 `slots.update("home", { badge: "dot" })`；打开视图时清除。只认在途的那次小结：扩展换代或 App 重启后，之前在途的小结不再通知。
- **设置面板**（第 8 步）：页面右上的 ⚙ 打开次级面板：聊天模型（`models.list` 的列表，加「跟随会话」，即空值）、小结频率（关闭、1、2、4、8、24 小时）、安静时段（开始与结束时间，可以都不填）、按钮「在 ZCode 里打开 Jarvis 的会话」（大脑存在时）。保存调视图工具 `saveSettings`，扩展调 `settings.update`，值来自 `settings.get` 与 `settings.onDidChange`（唯一来源是插件设置，宿主的插件设置页也能改同样三个键）。之后每一轮的 `sendToSession` 都带 `chat_model`（H10 只作用于这一条输入）。
  - `userConfig`：`chat_model`（string，默认空）、`digest_interval`（number，小时，默认 4，0 表示关闭，0–24）、`quiet_hours`（string，`HH:MM-HH:MM`，默认空，可以跨午夜）。
  - 面板最后一行文字：系统通知在宿主插件详情页的「权限」里开关，总开关是设置里的「任务通知」。没有开关控件，Jarvis 不保存通知开关（用户决策）。没有「新会话模型」（用户决策）。

### 18.4 分步与验收

每一步在桌面端跑通 E2E 才进入下一步，模型用回放夹具，GitLab 用本地模拟服务（只认测试 token，记录请求但不记 token）。每个 GitLab 用例结束时做泄露检查：隔离 HOME 的日志、`config.json`、会话记录里没有 token，`plugin-secrets.json` 里有。

**GitLab**（不依赖 P3，可以和 P3 并行）：

1. H1、H4：E2E 扩展 PLM-EXT-P2D，写入敏感键后 `config.json` 里没有它，`onDidChange` 触发。
2. H3：fixture 扩展经抓包代理与自定义 CA 访问 https，请求出现在代理记录里。
3. H2：fixture 命令开出预填草稿，没有自动发送，没有新建会话。
4. 插件骨架、客户端、模拟服务、面板登录与退出：错误 token 显示 401 且什么都不存；正确 token 显示列表；退出后清空。
5. 面板列表、详情与操作：批准、评论、合并（带 sha 与确认）；只读 token 时写按钮禁用；409 提示刷新。
6. MCP 工具与 skill：没登录时没有工具；登录后新会话里模型读 MR 写出审查；同意后调评论工具，弹审批，批准后模拟服务收到评论，拒绝后没有任何写请求；合并工具在 plan 模式下也询问。
7. 「用 ZCode 审查」按钮：草稿已预填，发送后走回放完成审查。
8. `@` 条目：分组出现，选中后发出的文本就是 `insertText`。
9. 自建实例自签证书、README、截图（深浅主题、中英文）。

**Jarvis**（P3a–P3d 完成后。下面引用的 PLM-JARVIS-1、2 已在 2026-11-07 删除，见本节开头）：

1. 骨架与 H5、H11（已完成。PLM-JARVIS-1：导航入口、授权、欢迎页、切换焦点会话；切换工作区由 PLM-EXT-JARVISHOST 覆盖；未读标记的渲染由 PLM-EXT-JARVISHOST 覆盖，Jarvis 只在打开视图时清除）：导航入口、欢迎页；切换焦点会话、切换工作区后页面实例 id 不变；截图。
2. H6、H7 与首发（已完成，PLM-JARVIS-1）：首条消息创建大脑，出现在 Jarvis 项目里；回放请求带 `AGENTS.md` 的标记；流式期间气泡至少增长两次。
3. 历史与恢复（已完成，PLM-JARVIS-1）：杀掉扩展进程后收到 `reset` 并恢复；重启 App 后连到同一个大脑；长会话往上翻页。
4. 工具与审批（已完成，PLM-JARVIS-2 b）：回放 ListSessions（不审批）与 SendToSession（审批）；出现摘要行与「等你确认」；点「去确认」后宿主打开大脑会话；批准后卡片消失。
5. 中断与错误（已完成，PLM-JARVIS-2 c、d、g）：停止 → interrupted；立即报错 → 错误卡片可重试。
6. 小结（已完成，PLM-JARVIS-2 e；定时与安静时段没有桌面运行时用例）：「现在总结一下」触发，带标记的行画成小结；没有变化时不发请求。
7. H8、H12（已完成。PLM-JARVIS-2 a、e：授权对话框、失焦时弹出、未读标记；`disabled` 与限流由 PLM-EXT-JARVISHOST 覆盖）：授权对话框；通知弹出（窗口失焦时）；全局开关关闭时 `disabled`；第二条被限流。
8. H9、H10（已完成，PLM-JARVIS-2 f）：下拉列出已配置的模型；保存后下一轮请求用新模型。
