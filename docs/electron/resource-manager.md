# Resource Manager — 资源管理器

> 取代旧的 “Process Monitor / 进程监视器”。本文是当前事实文档；旧的进程树视图与 `GetProcessMetrics` 通道已删除。

## 功能概述

桌面端提供两处 **资源管理器** 入口，都打开同一个独立单例窗口：macOS 原生菜单栏的 Help 菜单，以及所有桌面平台右上角的问号帮助菜单（`WorkspaceHelpMenuButton`，2026-09-11 补入——Windows/Linux 没有原生菜单栏，Windows 自绘标题栏箭头菜单又已下线，此前 Windows 上没有任何入口）。Web 端不渲染该菜单项（`isDesktop` 由挂载处注入，见 `docs/windows-caption-help-menu.md`）。窗口顶部有四个 tab：**CPU**、**内存**、**存储**、**网络**（2026-09-10 裁决：存储管理从设置页整体迁入这里）。

- **CPU / 内存 tab**：实时展示 ZCode 的 CPU 或内存占用，布局相同，只是指标卡与列表指标列换成当前 tab 的指标。切到「存储」或「网络」tab 时停止 CPU/内存的 1s 轮询。
- **存储 tab**：本机 `.zcode` 数据目录的磁盘占用，按卷汇总、按类别拆分、可下钻与清理。产品与实现细节见 `docs/settings-storage-management.md`；下面「存储 tab 数据通路」只写与本窗口相关的接线。

CPU / 内存 tab 的内容：

- 左侧两块指标卡：**CPU**、**内存**。每块都有一根双层进度条——**灰色**表示整机总占用，**彩色（brand）**表示 ZCode 自身占用；数字显示 ZCode 占用与整机占用。
- 右侧按四类分组列出进程，每组显示小计，可展开看到每个进程的名称、PID、CPU、内存：
  - **基础服务**：Electron main、GPU、所有 renderer（含 DevTools / WebContentsView）、window-scoped Host（utility）、Host 派生的非 Agent 子进程（终端 shell 等）、Agent CLI 进程本身、其它 Electron utility（network service 等）。
  - **任务进程**：Agent 派生的非插件进程树，例如 Bash、PowerShell、Node、Python 与构建命令。它们的占用取决于用户任务，独立显示 CPU / 内存小计；不按可执行文件名判断，也不推断具体 task/session 的归属。
  - **内置插件**：官方市场（`zcode-plugins-official`）插件的 MCP 子进程树——当前即 `browser-use`（`node_repl` + plugin host）与 `computer-use`。
  - **社区插件**：其余全部 MCP 子进程树——第三方市场插件与用户自定义 MCP（`custom`）。

**网络 tab**：只在资源管理器窗口存活期间观测本机 Main、Host、App Renderer、CLI 的 HTTP(S) 请求与 WebSocket 建连，不采集正文。窗口关闭即取消监听并释放记录；具体边界、代理兼容和验收见 [网络请求观测](resource-manager-network.md)。磁盘占用即「存储」tab。

## 存储 tab 数据通路

该窗口按设计不接 RPC / MessagePort（见 `preload/resourceManager.ts`），因此存储服务不走 Window Host，而是由 **main 进程持有唯一的 `StorageService` 实例**（`@zcode/services` 的 storage 模块），遍历放在 `worker_threads` 里（entry `main/storageScanWorker`），不阻塞 main 事件循环；这与「main 禁止起外部进程采样」不冲突，扫盘只是 fs 遍历。

```
Resource Manager Renderer            preload (window.resourceManager.storage)        Main
  │ 切到存储 tab → startScan() ──────► ipc invoke StorageStartScan ─────────────────► resourceManagerStorage.ts
  │                                                                                   │ 懒创建 StorageService(Worker runner)
  │◄─ subscribeScanProgress ◄──────── ipc on StorageScanProgress ◄────────────────── │ onScanProgress → webContents.send
  │ 切走 / 关窗 → cancelScan(jobId) ─► ipc invoke StorageCancelScan ────────────────► │ 窗口 closed 也会取消最近 job
  │ clean({rootId,categoryId}) ─────► ipc invoke StorageClean ─────────────────────► │
  │ revealPath(abs) ────────────────► ipc invoke StorageRevealPath ────────────────► │ 校验路径在数据根内 → shell.showItemInFolder
```

- 通道：`PlatformChannels.StorageStartScan / StorageCancelScan / StorageGetSnapshot / StorageClean / StorageRevealPath`（invoke），`StorageScanProgress`（main → renderer 推送）。
- 类型：`packages/shared/src/storage.ts`（`StorageUsageSnapshot`、`StorageManagementBridge` 等），services / main / UI 共用。
- UI：`packages/ui/src/resource-manager/storage/*`，`useStorageUsage({ bridge, enabled: tab === "storage" })`。

## 口径

- **CPU 统一为整机归一化百分比**：`100%` = 整机所有逻辑核心全部占满。左侧灰色条即 `os.cpus()` 两次采样间 busy/total；ZCode 占用 = 所有进程行 CPU 之和；各进程行也用同一口径，因此分组小计与总计可以直接相加。旧版进程监视器在 macOS 上按 Activity Monitor（单核 = 100%）展示，本版不再沿用。
  - Electron 自身进程来自 `app.getAppMetrics().cpu.percentCPUUsage`：darwin / win32 已是整机口径；linux 上 Chromium 返回单核口径，进入快照前除以逻辑核心数（`normalizeElectronCpuToMachinePercent`）。
  - 外部进程（Agent / MCP / 终端）由 Host 侧采样器按 `Δcputime / Δwall / 逻辑核心数` 计算，首个样本没有差分基线，CPU 记 0。
- **内存**：Electron 进程用 `workingSetSize`；外部进程用 RSS（macOS/Linux）或 WorkingSet（Windows）。整机总量 `os.totalmem()`，整机已用 `total - os.freemem()`（macOS 上与 `top` 的 PhysMem used 同口径，包含文件缓存）。
- Chromium 进程之间的共享内存会被重复计数，与 Task Manager / Activity Monitor 的进程列表一致，不做去重。
- 远程 workspace（SSH/WSL/Docker/Server）的 Agent 运行在远端，不在本机可观测范围内，不展示。

### 任务进程分类（2026-11-06）

`resource-manager` 模块登记既有 Host 采样文件与资源管理器 UI，公共指标类型仍在 shared，UI 的注入接口由 `contract.ts` 声明。Host 采样器是分类的唯一 owner。沿用当前 OS 进程表与最近已知祖先的递归归属，只把
Agent 的非根、非插件后代从 `base` 移到 `task`；`groupKey/groupLabel` 仍为 `cli`。
共享类型与 Host 响应 schema 同时接受 `task`；Main 仍按 PID 合并快照并汇总全部行；UI
仅按 category 分组，任务行显示名称、PID 和当前指标，不显示内部 `cli` 标签。

```text
Host → Agent 根进程                 → base
             ├─ Bash → Node/Python → task
             └─ MCP 根 → 后代       → builtin-plugin / community-plugin
OS 采样 → Host 分类 → Main 合并与总计 → UI 四组小计
```

- 分类调整不改变 CPU 归一化、RSS/WorkingSet、采样频率、取消或缓存生命周期。
- ZCode 总占用仍包含任务进程；四组互斥，每个 PID 只记一次。
- MCP 与 Host 直管内置插件的已知根优先于继承的 Agent 归属，插件后代仍归对应插件。
- 范围仍限于本机；Web/手机不新增资源管理器入口。普通后代失去可追踪父子关系的采样边界不变。
- 验收：资源管理器 CPU/内存两页均显示四组与独立折叠；真实后台 Bash 产物 PID 出现在
  `task` 且内存大于 0，Agent 根仍为 `base`，总量等于全部进程行之和，进程退出后从组内消失。
  桌面窄/宽窗口、Zai Light/Dark、中英文沿用现有分组布局。
- 回归入口：`resource-manager.test.ts` 与既有后台 Bash `BGV01`；分类/插件边界另用真实
  OS 进程树采样场景核验，不恢复 App 业务单测。

本轮验证（2026-11-06）：

- macOS 桌面：资源管理器两例通过，四组展示及中英文、640/1200px、Zai Light/Dark 截图在
  `packages/desktop/.e2e-artifacts/desktop-e2e-20261106124135492-p16677-ea39ec4b7c7a7d20`。
- 真实后台 Bash：定向 `BGV01` 通过，包含任务进程读数、独立折叠、Agent 分类、总量及退出移除；
  证据在 `packages/desktop/.e2e-artifacts/desktop-e2e-20261106124345420-p26153-139649c7017a716b`。同目录保存真实 OS
  进程树采样脚本与结果，覆盖 Bash/Node 后代、两类插件树、Host 直接子进程共 8 个 PID。
- 类型检查、E2E 类型检查、Lint（存量警告保留，本次资源管理器文件无 Hooks 诊断）、
  架构检查、61 项架构工程检查、受影响工程检查（346 通过 / 1 跳过）通过。
- Windows/Linux 桌面未实跑；手机/Web 无该功能入口。首轮命令行筛选未生效，额外执行到
  BGV04 子会话冷恢复后中止；不将该轮记为完整后台 Bash 套件通过，最终仅以定向 BGV01 收口。

## 架构

```
Resource Manager Renderer         Main (Electron)                 Window Host (utility)                 Agent CLI
   │ 1s 轮询                          │                                 │                                    │
   │─ invoke GetResourceUsageSnapshot ►│                                 │                                    │
   │                                  │─ ResourceUsageSnapshotRequest ─►│  (fan-out 到每个存活 Host,          │
   │                                  │   {requestId}                   │   900ms 超时, 超时用上次结果)        │
   │                                  │                                 │─ 异步 ps / /proc / CIM ────┐        │
   │                                  │                                 │◄───────────────────────────┘        │
   │                                  │                                 │─ request process/childProcesses ───►│
   │                                  │                                 │◄─ {processes:[{pid,serverName,     │
   │                                  │                                 │     mcpSource,pluginName?}]}        │
   │                                  │                                 │  按 Host 子树归属: agent / mcp 根   │
   │                                  │◄─ ResourceUsageSnapshotResult ──│                                    │
   │                                  │   {requestId, processes[]}      │                                    │
   │                                  │ + app.getAppMetrics()           │                                    │
   │                                  │ + os cpu/mem 总量               │                                    │
   │                                  │ + Agent 注册表兜底 (未采到=0)    │                                    │
   │◄──────── ResourceUsageSnapshot ──│                                 │                                    │
```

### 只读采样生命周期与回归约束

- Main 的资源管理器窗口是采样启停的唯一 owner：CPU/内存页挂载后启用；切到存储页、窗口关闭或 renderer 退出时停用。未启用或非该窗口发来的查询不得向 Host 发请求。
- 每个 Host 最多一轮在途采样。Main 的 900ms 展示等待超时只返回缓存，不追加采样；完成后才允许下一轮。停用时按 requestId 取消在途请求，迟到结果不得写回缓存或投影。Host 不保存采样队列。
- `process/childProcesses` 是 observation 请求：只查询已经存在且存储已就绪的 runtime，不等待迁移、不启动进程；失败、超时和取消只影响该次查询，不发布 runtime 故障、不回收进程，也不刷新业务空闲计时。普通业务 RPC 的 watchdog 保持原有语义。
- Host 将取消传到进程表读取和 CLI 查询；取消只终止本次采样创建的辅助命令，不能终止被观察的 Agent/MCP。Linux 文件读取完成后的迟到结果也必须丢弃。
- 采样只覆盖本地进程，不创建远端连接，不改变桌面 continuous / 手机 replayable 的业务消息恢复边界。

```text
CPU/内存页 → Main 启用 → 单轮 Host 采样 → OS 进程表 + CLI observation
切页/关窗 → Main 停用 → cancel(requestId) → 取消 IO/查询，丢弃迟到结果
CLI observation 超时 → 本轮无映射；Agent 生命周期与业务 idle 计时不变
```

验收：未打开零查询；慢采样不积压；切页/关窗取消在途且不再查询；重新打开不接收旧结果；观测超时后业务请求仍可执行；观测成功或挂起均不延长 mcp-status 的空闲寿命。

### 为什么这样分层

- **main 进程禁止起外部进程采样**（历史 bug：同步 `ps` / PowerShell 曾把整个 App 卡死；异步 `execFile` 的 CreateProcess 阶段同样会阻塞 main）。所以外部进程的 CPU/内存一律在 **Window Host（utility 进程）** 内异步采样，且只在资源管理器窗口发起请求时才采样；窗口关闭后 Host 不再有任何周期性开销。
- **插件归属只有 CLI 知道**：MCP 子进程由 Agent CLI 拉起，`ZCODE_PLUGIN_ID` / server name / `source.kind` 都在 CLI 内存里；现有 `process/mcpTelemetry` 通道为了遥测脱敏刻意不带 pid。因此新增一个纯内存、无 I/O 的协议请求 `process/childProcesses`，Host 用它把 pid 映射到插件。
- **Host 做进程树归属**：Host 是 Agent 的父进程，一次 `ps -axo pid=,ppid=,rss=,cputime=,comm=`（darwin）/ 扫描 `/proc/*/stat` + `/proc/<pid>/status`（linux）/ `Get-CimInstance Win32_Process`（win32）就能覆盖 Host 全部后代。每个后代按“最近的已知祖先”归属：MCP 根 pid → 对应插件；Agent 根 pid → 基础服务 `cli`，其非插件后代 → 任务进程 `task`；无归属 → 基础服务 `host` 子进程。
- **main 只合并**：`app.getAppMetrics()`（Electron 进程）+ 系统总量 + Host 回报；Agent 注册表里已知但 Host 尚未回报的 Agent 仍会出现在列表中（`sampled=false`，指标为 0），保证拓扑始终可见，E2E 也依赖这一点。

### 数据类型（`packages/shared/src/protocol.ts`）

```ts
type ResourceUsageCategory = "base" | "task" | "builtin-plugin" | "community-plugin";

interface ResourceUsageProcess {
  pid: number;
  name: string; // zcode-main / zcode-renderer-main / zcode-agent-<provider>-<ws> / MCP server name / 命令名
  category: ResourceUsageCategory;
  groupKey: string; // base: main|gpu|renderer|host|cli|utility；插件: 插件名或 MCP server name
  groupLabel: string; // 分组展示名（插件名 / server name）
  cpuPercent: number; // 整机归一化
  memoryBytes: number;
  sampled: boolean; // false = 仅拓扑已知，指标尚未采到
}

interface ResourceUsageSnapshot {
  sampledAt: number;
  logicalCpuCount: number;
  system: { cpuPercent: number; memoryTotalBytes: number; memoryUsedBytes: number };
  app: { cpuPercent: number; memoryBytes: number }; // = processes 之和
  processes: ResourceUsageProcess[];
}
```

### 协议新增（`packages/shared/src/zcode-protocol/index.ts`）

- `zcodeProtocolMethods.processChildProcesses = "process/childProcesses"`，params `{}`。
- 结果 `zcodeProcessChildProcessesResultSchema`：`{ processes: Array<{ pid, serverName, mcpSource: "builtin"|"plugin"|"custom", pluginName?: string }> }`。
- CLI 实现：`McpTelemetryTracker.listProcesses()` 直接读取已注册连接的 `process.pid`、`serverName`、`mcpSource`；`pluginName` 由 `plugin:<name>:<key>` 命名空间或官方插件 `hostMcpServerNames`（`node_repl` → `browser-use`）解析。不做任何 I/O。

### main ↔ host 消息

- main → host `HostMessageTypes.ResourceUsageSnapshotRequest { requestId }`。
- host → main `HostResponseTypes.ResourceUsageSnapshotResult { requestId, sampledAt, processes: HostResourceUsageProcess[] }`，其中 `HostResourceUsageProcess = { pid, name, category, groupKey, groupLabel, cpuPercent, memoryBytes }`。
- 校验在 `packages/shared/src/validation.ts` 的 `hostIncomingMessageSchema` / `hostResponseMessageSchema` 中。

### Host 侧采样（`packages/services/src/process/processResourceSampler.ts`）

- `readProcessResourceTable()`：按平台异步读取整机进程表 `{ pid, ppid, rssKb, cpuTimeMs, command }`，超时 3s（win32 5s），失败返回 `undefined`（本轮跳过，不抛错）。
- `createProcessResourceSampler()`：保存上一轮各 pid 的 `cpuTimeMs` 与时间戳，输出整机口径 `cpuPercent`；pid 消失后基线自动淘汰。
- `attributeHostProcessTree()`（纯函数）：输入进程表、Host pid、Agent 列表（pid/workspacePath/provider）、各 Agent 的 MCP 子进程映射，输出 `HostResourceUsageProcess[]`。

Host 入口 `packages/desktop/src/host/hostResourceUsage.ts` 把上述三者与 `IZCodeAgentService.collectLocalRuntimeChildProcesses()` 串起来，收到请求后回帖结果。

## 架构治理决策记录

按 `.agents/skills/architecture-governance` 的要求补记（本条在实现后补写，属于流程补课）：

```text
owner:            main 进程 resourceManagerWindow（Host / Agent pid 注册表 + 快照合并）；
                  外部进程指标的瞬时事实由 Window Host 采样器持有（cputime 差分基线）；
                  MCP 子进程 ↔ 插件映射只由 CLI McpTelemetryTracker 持有
command path:     renderer invoke GetResourceUsageSnapshot → main buildResourceUsageSnapshot
                  → HostMessageTypes.ResourceUsageSnapshotRequest → host createHostResourceUsageResponder
                  → CLI process/childProcesses（纯内存）
derived views:    ResourceUsageSnapshot（main 合并 Electron 指标 + 系统总量 + Host 回报）；
                  UI 的 groupResourceUsage 只做分组/排序/格式化，不持有任何指标状态；
                  main 的 lastHostResults 是超时兜底缓存，不是第二份事实源
ordering:         每个 Host 最多一轮在途采样；Main 超时返回缓存但复用原 requestId，Host 不排队；
                  活跃请求迟到回帖可更新缓存，取消后的回帖丢弃；pid 复用靠 command 变化 / cputime 倒退重建基线
idempotency:      请求无副作用，可任意重放；Host 不维护定时器，窗口关闭后零开销
delivery:         desktop-only（独立 BrowserWindow + 专用 preload）；不接 conversation continuous / replayable 链路
reuse decision:   未复用 services/process/processTreeSnapshot.ts（同步 spawnSync，为 app quit 设计，列不同）
                  与 CLI mcp/process-memory.ts（5 分钟内存遥测，Windows 只有 tasklist）——采样需要异步、cputime、
                  在 Host 内执行，三者职责不同；PowerShell CIM 命令格式与 processTreeSnapshot 相近，属已知重复
contracts/spec:   packages/shared protocol.ts / channels.ts / validation.ts / zcode-protocol；本文；
                  desktop、services、ui、CLI 四组单测 + e2e resource-manager.test.ts
```

## 文件清单

| 文件                                                                                                    | 职责                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `desktop/src/main/resourceManagerWindow.ts`                                                             | 单例窗口、Host / Agent 进程注册表、`buildResourceUsageSnapshot()`、系统 CPU 差分                           |
| `desktop/src/main/resourceManagerHostSampling.ts`                                                       | main → Host 采样 fan-out：requestId 关联、900ms 超时、上一轮结果兜底                                       |
| `desktop/src/main/resourceManagerProcessNames.ts`                                                       | 非 BrowserWindow renderer（WebContentsView / DevTools / webview）的显示名                                  |
| `desktop/src/main/desktopHostProcess.ts`                                                                | 转发 `ResourceUsageSnapshotResult`；`requestHostResourceUsage()` fan-out                                   |
| `desktop/src/host/hostResourceUsage.ts`                                                                 | Host 侧采样 + 归属 + 回帖                                                                                  |
| `desktop/src/preload/resourceManager.ts`                                                                | 暴露 `window.resourceManager.getSnapshot()` 与 `window.resourceManager.storage`（StorageManagementBridge） |
| `desktop/src/main/resourceManagerStorage.ts`                                                            | 存储 tab 的 ipc 面：持有 StorageService、进度推送、关窗取消、定位路径校验                                  |
| `desktop/src/main/storageScanWorker.ts` / `storageScanWorkerClient.ts` / `storageScanWorkerProtocol.ts` | 扫描 Worker 入口与 ScanRunnerPort 实现                                                                     |
| `ui/src/resource-manager/storage/*`                                                                     | 存储 tab UI（磁盘卡片、类别列表、明细、清理确认）与 `useStorageUsage`                                      |
| `desktop/src/renderer/resource-manager.html` / `src/resource-manager.tsx`                               | 独立 renderer 入口，挂载 `@zcode/ui` 的 `ResourceManagerApp`                                               |
| `ui/src/resource-manager/ResourceManagerApp.tsx`                                                        | 窗口 UI（指标卡 + 分组列表），组件放在 `packages/ui` 内以纳入 Tailwind 扫描                                |
| `ui/src/resource-manager/resourceUsageView.ts`                                                          | 分组聚合与格式化纯函数                                                                                     |
| `services/src/process/processResourceSampler.ts`                                                        | 跨平台进程表读取、CPU 差分、进程树归属                                                                     |
| `services/src/zcode-agent/zcodeAgentService.ts`                                                         | `collectLocalRuntimeChildProcesses()`                                                                      |
| `shared/src/protocol.ts` / `channels.ts` / `validation.ts` / `zcode-protocol/index.ts`                  | 类型、IPC 通道、host 消息 schema、CLI 协议                                                                 |
| `apps/zcode-cli/.../mcp/telemetry.ts` / `zcode-protocol/server.ts`                                      | `listProcesses()` 与 `process/childProcesses` 处理                                                         |

## UI 细节

- 顶部 tab 用 `Tabs variant="line"`（与设置页插件 tab 同款胶囊触发器），test id `resource-manager-tab-{cpu|memory|storage}`；默认 CPU。
- 窗口 900×600，系统默认标题栏；主题与字号沿用主窗口的 `localStorage`（`zcode-theme` / UI font size），语言用 `ZCodeIntlProvider` 的本地偏好。
- 指标卡：`bg-card border-card-border rounded-xl`；进度条底色 `bg-surface-hover`、整机段 `bg-foreground-subtlest/40`（灰）、ZCode 段 `bg-brand`（彩）。
- 分组：四组固定顺序（基础服务 / 任务进程 / 内置插件 / 社区插件），组头显示进程数、CPU 小计、内存小计；空组显示“暂无进程”。四组默认展开，均可独立折叠；展开状态只存组件内。
- 列表行：名称（`font-medium`，`title` 为完整名）、PID（`font-mono`）、CPU、内存；未采样行 CPU/内存显示 `—`。
- 刷新频率 1s；请求串行（上一轮未返回不叠加）。
- 无 `window.resourceManager` 桥时展示“资源管理器接口不可用”。

## 测试

- 单测：`desktop/test/resourceManagerWindow.test.ts`（快照合并、Agent 兜底、linux CPU 归一化、系统 CPU 差分）、`services/test/processResourceSampler.test.ts`（三平台解析、CPU 差分、树归属）、`ui/test/resourceUsageView.test.ts`（分组聚合/格式化）、CLI `mcp-telemetry.test.ts`（`listProcesses`）。
- E2E：`desktop/test/e2e/resource-manager/storage/resource-manager-storage.test.ts`——存储 tab 扫描 / 下钻 / safe 与 confirm 清理 / 日志保留当天（SM-01~05）。
- E2E：`desktop/test/e2e/resource-manager/processes/resource-manager.test.ts`——菜单打开窗口、默认 CPU tab 四组分区可见、切内存 tab 换指标卡、`zcode-main` 与 `zcode-agent-*` 行出现、Agent 行在 Host 采样后 `memoryBytes > 0`。既有依赖进程监视器的 E2E helper 改读 `window.resourceManager.getSnapshot().processes`。
