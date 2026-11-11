# 全进程 CPU / 内存监控埋点（Process Resource Telemetry）

状态：**已实现**（v3.12.1）。2026-09-14 设计定稿，2026-09-15 完成契约收口。
验收执行状态见「验收 Case」与「收口验证记录」；平台限定和真实远端验证单独列出，不等同于全部验收通过。
本文是 CPU / 内存资源遥测的当前规范；[性能监控](./performance-monitoring.md)、
[CLI 资源上报](./zcode-cli-resource-telemetry.md)与[MCP 生命周期](./mcp-process-arms-telemetry.md)
中的旧资源内容均已替换为本文入口。旧事件的停发版本见[事件字典](./performance-telemetry-catalog.md)。

### 复审修复契约（2026-09-15）

本节固定 R1–R7、N1/N2 的修复语义，执行结果另记；影响面见
[复审修复影响与验证](./process-resource-telemetry-fixes.md)。

- **R1 / N2**：Server 在 `/api/server-info` 的 `capabilities.processResourceTelemetry` 可选字段
  声明支持这组资源旁路事件。Host 仅向声明支持的 Server 订阅；旧 Server 缺字段时继续正常连接，
  跳过遥测订阅。两个 Server 实现都声明能力。本地保持原订阅路径；R3 的 SSH/WSL/Docker
  会复用版本兼容的 Source Server，也必须检查能力，并在重连换代后重新检查和订阅。
  不增加版本号判断、UI 提示或协议主版本变更。
- **R2**：CLI 为每条慢 Bash 完成事实生成随机 `completionToken`，只在协议内传递。
  main 是唯一去重 owner，使用最多 1024 项的近期集合，使同一事实经多个连接、多个 window Host
  到达时只上报一次。不同 token 的相同指标仍各计一次；token 不进入 ARMS，也不新增业务日志；显式开启的原始协议诊断 tap 保留既有帧记录语义。
  字段可选以兼容旧 CLI，缺 token 时保留旧事件行为，不用指标内容猜测命令身份。
- **R3**：CLI 的新读数按角色、运行面、运行环境、硬件分组判断；只有含新读数的组产生角色样本。
  设备级总量按进程实例保留读数真实到达时间，过期判断不得被 main 的交付时刻或同组其他实例续期。
  外部样本预算为 128 项（64 个 CLI 实例及原有 64 个 MCP 来源预算），保持有界且不因实例化挤掉 MCP。
  60 秒节拍、错相位多组交付和退出残窗共用同一套规则。
- **R4**：Host 复用 `buildRemoteEnvironmentKey(target)`（Server 优先使用返回的 serverId）
  构造环境身份，并哈希后放入 Host→main 的可选 `environmentKey`。CLI/MCP 的实例存储、
  分组与最终窗口均包含该身份，保证同规格不同环境不相加、同环境多连接仍能归并。
  本地及旧 Host 缺字段时使用原有空身份分组。身份仅用于内存隔离，ARMS 属性白名单不变。
- **R5**：同一 tick 多个 Host 的 heap 取已到达读数的最大值，交付后清空，避免后到低值覆盖峰值。
- **R6**：CI 扫描覆盖 `telemetry`、`process-probe`、`process-resource`、`processResource` 命名；
  所有实际来源模块都须受保护。资源管理器按需采样器保留有依据的关键字豁免。
- **R7 / N1**：注释剥离须识别正则、转义和字符类；正则中的反引号不得打开模板字符串，
  正则中的 `/*` 不得打开块注释。有效代码中的禁用调用须命中，真实注释中的禁用词须忽略。

```text
旧 Server 无能力 ──> Host 跳过资源订阅 ──> 连接继续工作
新 Server 有能力 ──> Host 转发环境身份和完成标识 ──> main 分组 / 去重 ──> 白名单上报
CLI 真实读数时间 ──> 分组新读数 ──> 有界窗口；交付不刷新读数年龄
```

这些旁路事实不进入 task/session、CommandInbox、snapshot 或恢复流；桌面
`desktop-continuous` 与手机 `web-remote-replayable` attachment 继续返回空遥测事件。

### 已实现的链路与兼容边界

- main 以来源注册表统一采集 Chromium 七角色、CLI 两角色与 MCP；设备级来源在同一 tick 第二阶段
  读取各来源精确合计。heap 读数、CLI / MCP 最近样本与 Bash 即时事件沿下文唯一 owner 链路汇入。
- host 与主 renderer 复用既有内存日志定时器；日志写盘门控不影响遥测。main 只接受已登记主窗口
  webContents 的 heap，资源管理器、about、DevTools 与 webview guest 的读数丢弃。
  heap 交付即清空，本 tick 没有完整角色样本时丢弃；各窗口定时器相位不同，因此 renderer heap
  mean 是各 tick 已到达窗口中最大读数的平均，peak 是最大单窗口读数。
- CLI 每 60 秒交出存活实例的最近合计，只有新读数才计样本；正常退出通过 `flushPending` 补交
  已收到但未交付的事实。`instanceToken` 只在 main 内存中区分实例，不进入 ARMS；lane 由 services
  按进程管理器标记，CLI 自身不携带 lane。节拍常量由 shared 单点声明。
- 旧 CLI → 新 app 保持兼容（heap、uptime、内存总量、instanceToken 可选，硬件缺项逐字段回落到
  桌面值）；新 CLI → 旧 app 的 strict schema 会拒绝新字段，遥测静默丢弃。旧独立 server 的事件
  订阅风险与真实远端验收方式见 PRT-030。
- 每个远端 service collection 只订阅一次，寿命随 connection handle 的 dispose 收口；手机
  attachment 得到空事件，不增加底层订阅。运行机维度进入窗口分组 key，远端样本不计设备总量。
- MCP tracker 唯一持有连接、owner 与实例；进程重启、关闭或 tracker 停止后丢弃在途旧结果。
  main 按实例与采样时间去重，每次 flush 只投影一份分组合计（sample_count=1），最多 32 个 MCP
  分组，超出只写 debug。旧 memory 通知在新 main 丢弃。
- Bash 在实际 spawn 边界建立每命令 owner，复用已有一秒轮询器，15 秒起最多 20 次探针；退出或
  stop 封口后迟到样本丢弃。Windows 不创建资源采样定时器，只发送 10 项零成本属性。
- main 的 ps 线程数探针、10% 角色抽样、互斥旧属性布局、GPU 显存与磁盘 IO 字段均已删除。
  MCP / Bash 共用 CLI 通用探针，全链路受遥测关键字门禁保护。

### 收口约定（票 11）

三个新事件以 shared 属性白名单为代码契约；spec 与事件字典逐项列出属性，由 PRT-026 的契约测试
检查两份文档与白名单一致。只收窄无调用方的导出，不改变来源注册表、窗口 owner、采样时序、
失败语义与 desktop continuous / mobile replayable 边界。验证沿用下文已约定测试缝，UT 与 E2E 按本票
用户要求仅跑受影响 case；分别记录实际通过、跳过或阻塞，不把测试文件存在等同于运行通过。

全仓门禁收口同时修复已存在契约文档的误报：managed 模块的文件枚举必须包含 `CONTRACT.md`，
但文档不参与源码 import / 行数分析；文档真实缺失时仍报 `missing-module-artifact`。
回归沿用 `checkArchitecture` 的临时模块 fixture 边界，不修改架构策略或刷新 baseline。

## Problem Statement

产品与开发团队现在无法用一句话回答"ZCode 的哪个进程、在哪个版本、在哪类机器上占了多少 CPU 与内存，
有没有变差"。现有 ARMS 资源埋点分散在三个事件（`perf_resource_window`、`perf_resource_agent`、
`perf_mcp_memory`）里，三种 schema、三条链路，且存在以下缺陷：

- 进程角色明细只对 10% 设备采集，低频问题（某个插件在某类机器上吃内存）几乎不可见。
- Linux 上 ARMS 的 CPU 是单核口径，资源管理器 UI 是整机口径，同一指标两个数。
- main 进程每 10 秒起一次 `ps` 取线程数，违反项目"main 不起外部进程"的规则，本身消耗 CPU。
- MCP 子进程只有内存没有 CPU；cron scheduler 没有角色，混在 `other` 里；远端 workspace 的 CLI
  文档写了上报链路但代码没有接线。
- 用户反馈"Bash 工具非常耗时非常卡"时，没有任何数据能区分是命令本身重、机器没内存、还是 CLI 自己在忙。
- 为绕过 ARMS 单事件 20 属性上限，同一事件在"命中角色采样"与"未命中"时使用两套互斥属性布局，
  看板难以直接查询。

历史上还发生过一次事故：一个进程相关埋点让 Windows 用户机器每隔几秒调用 PowerShell，显著拖慢电脑。
性能埋点反而损害性能，这是本 spec 必须杜绝的。

## Solution

一套统一的进程资源埋点，覆盖桌面端全部进程角色，三个事件、一套 schema：

- `perf_process_window`：每个进程角色每 5 分钟一条，CPU 与内存的 mean / p95 / peak，多进程角色同时带
  总量与最大单进程，附运行时长与前后台占比。全量设备、全部角色，不抽样。
- `perf_system_window`：每台设备每 5 分钟一条，整机 CPU、剩余内存、应用总量与遥测自身开销。
- `perf_tool_exec_resource`：每条超过 15 秒的 Bash 命令一条，命令进程树的内存峰值与 CPU 时间，
  以及当时 CLI 自身与整机的内存状态。

应用只负责准确、完整、有代表性地上报；"什么算异常"由自建监控平台读取 RUM 数据源后按本文
「平台侧告警规则」判定。所有采集点都以进程内 API 为主，外部进程探针只允许两个白名单项并有硬性节流，
main 进程零外部进程，全链路禁止 PowerShell。

## User Stories

1. 作为性能负责人，我希望每个进程角色每 5 分钟都有 CPU 与内存的 mean / p95 / peak，以便发版后 1 小时内看出某个进程是否变差。
2. 作为性能负责人，我希望所有设备都上报全部角色而不是 10% 抽样，以便某插件在某类机器上吃内存这类低频问题也能被看到。
3. 作为性能负责人，我希望多进程角色同时带总量与最大单进程，以便区分"用户开了很多 workspace"和"某个进程泄漏"。
4. 作为性能负责人，我希望事件带进程运行时长，以便在平台上按运行时长分桶发现内存随时间增长，而不需要客户端做泄漏判断。
5. 作为性能负责人，我希望 Node 进程带 JS 堆用量，以便区分 JS 堆泄漏与 native / ArrayBuffer / 子进程侧的增长。
6. 作为性能负责人，我希望有设备级的整机 CPU、剩余内存与应用总量事件，以便判断问题是 ZCode 造成的还是用户机器本身压力大。
7. 作为性能负责人，我希望旧事件停发、新事件一次性替换，以便看板口径不混杂、过渡期不双倍上报。
8. 作为值班工程师，我希望 spec 给出可直接落地的告警规则清单，含指标、分组、阈值与含义，以便在自建平台上配置而不依赖 ARMS 告警能力。
9. 作为值班工程师，我希望告警规则按群体占比和版本对比定义，以便不被单台设备的正常波动打扰。
10. 作为值班工程师，我希望有数据质量类规则，以便采集链路断了或上报量失控时最先知道。
11. 作为插件负责人，我希望 MCP 按 mcp_id 上报内存与 CPU，以便找到吃资源的插件并推动修复。
12. 作为插件负责人，我希望能看到 MCP 在应用后台时的 CPU，以便发现在后台轮询的插件。
13. 作为 Agent 开发者，我希望超过 15 秒的 Bash 命令有一条资源摘要，以便回答用户反馈的"卡"是命令本身重、机器没内存还是 CLI 自己在忙。
14. 作为 Agent 开发者，我希望 Bash 摘要带命令进程树的 CPU 时间，以便区分命令在忙和命令在等输入或网络。
15. 作为 Agent 开发者，我希望远端 workspace 的 CLI 也上报并标记 runtime_surface=remote，以便远端场景不再是盲区。
16. 作为最终用户，我希望遥测不会让我的电脑变慢，以便性能监控不成为新的性能问题。
17. 作为 Windows 用户，我希望后台永远不会因为遥测出现 PowerShell 进程或 CPU 抖动，以便历史事故不再重演。
18. 作为最终用户，我希望我的文件路径、workspace、session、命令内容、模型名不出现在遥测里，以便隐私不被泄露。
19. 作为桌面端开发者，我希望 CPU 口径在所有平台上与资源管理器 UI 一致，以便用户看到的和后台看到的是同一个数。
20. 作为桌面端开发者，我希望每个进程只有一个采样源同时喂本地诊断日志与 ARMS，以便两处数据一致且定时器不翻倍。
21. 作为桌面端开发者，我希望 cron scheduler 有自己的角色，以便它的资源不再淹没在 `other` 里。
22. 作为桌面端开发者，我希望应用正常退出时排空未满窗口，以便短会话的数据不丢。
23. 作为桌面端开发者，我希望本地 `[memory]` 诊断日志保留，以便单机定位仍有领域计数器可用。
24. 作为 UI 开发者，我希望 renderer 的 JS 堆进入 ARMS，以便 renderer 泄漏能在群体层面看到，而不只在用户日志里。
25. 作为数据分析师，我希望所有角色共用一个 schema，以便一条 SQL 按 process_role 分组就能出图。
26. 作为数据分析师，我希望事件带 sample_count 与 telemetry_self_ms，以便判断数据质量与遥测自身开销。
27. 作为数据分析师，我希望角色事件的平台、架构、核数、内存总量描述"该进程实际运行的机器"，以便远端 CLI 不被错误地归到桌面机硬件下。
28. 作为成本负责人，我希望每设备每天上报量可预估并有规则守护，以便按条数计费的成本不失控。
29. 作为 QA，我希望有 E2E 断言三个事件名在开发态窗口内出现且属性数不超过 20，以便回归时立刻发现漏报或超限。
30. 作为 QA，我希望 Windows 上有门禁证明 main 与 CLI 都不会启动 PowerShell，以便红线有机器验证而不是口头承诺。

## 进程模型与角色

桌面端运行期的进程树（源码核实，local 模式）：

```text
Electron App（单实例）
├─ main（Browser）                        常驻 ×1
│   ├─ GPU                                 Chromium 托管 ×0~1
│   ├─ Chromium utility（network 等）      Chromium 托管，按需
│   ├─ renderer 主窗口                     ×1/主窗口
│   │    └─ <webview> guest renderer       ×N/内置浏览器 tab
│   ├─ 辅助 renderer                       按需短命：update-status / 资源管理器 / about / DevTools 等
│   ├─ Host（utilityProcess）              ×1/主窗口
│   │    ├─ zcode-cli chat lane            ×1/workspaceKey
│   │    │    ├─ MCP stdio 子进程          ×1/已连接 MCP
│   │    │    └─ Bash 工具子进程            ×N，短命
│   │    ├─ zcode-cli plugin / mcp-status lane
│   │    ├─ node-pty shell、git 等短命子进程
│   │    ├─ Windows CUA Helper             Windows，×1/Host
│   │    └─ wsl.exe / docker exec          ×1/远端连接
│   └─ cron scheduler（utilityProcess）    常驻 ×1
└─ macOS CUA Helper.app                    由 launchd 拉起，故意不是子进程
```

remote 模式桌面端不新增进程，远端 zcode-server 及其 CLI / MCP / pty 全部在远端机器。手机远控桌面端
不新增进程，也不参与本 spec。

### 角色定义（第一期 10 个）

| process_role     | 覆盖的进程                                                                  | CPU 与 RSS 来源                                                                                       | heap 来源                                                   | 上报粒度                |
| ---------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------- |
| `main`           | Electron 主进程                                                             | main 的 `app.getAppMetrics()`，10 秒                                                                  | 自采，60 秒                                                 | 单进程                  |
| `renderer_main`  | 主窗口 webContents 的 renderer                                              | 同上                                                                                                  | renderer 60 秒采 `performance.memory`，经 preload 桥送 main | 聚合：总量 + 最大单进程 |
| `renderer_guest` | 内置浏览器 `<webview>` guest 进程                                           | 同上                                                                                                  | 无                                                          | 聚合：总量 + 最大单进程 |
| `gpu`            | GPU 进程                                                                    | 同上                                                                                                  | 无                                                          | 单进程                  |
| `chromium_other` | network 等 utility、辅助窗口 renderer、DevTools，及其余未归类 Chromium 进程 | 同上                                                                                                  | 无                                                          | 聚合                    |
| `host`           | 窗口 Host                                                                   | 同上                                                                                                  | 自采，60 秒，parentPort 送 main                             | 聚合：总量 + 最大单进程 |
| `scheduler`      | cron scheduler                                                              | 同上                                                                                                  | 自采，60 秒，parentPort 送 main                             | 单进程                  |
| `cli_chat`       | 每 workspace 一个 zcode-cli                                                 | CLI 自采 60 秒，经 Host 转 main                                                                       | 同一次采样                                                  | 聚合：总量 + 最大单进程 |
| `cli_aux`        | plugin、mcp-status 两个 lane 的 zcode-cli                                   | 同上                                                                                                  | 同一次采样                                                  | 聚合                    |
| `mcp`            | 每个 MCP 服务的进程树                                                       | CLI 每 5 分钟采一次；macOS `ps` 读取进程表后筛选根与后代，Linux 读 `/proc`，Windows `tasklist` 仅内存 | 无                                                          | 每 mcp_id 一条          |

角色归属规则：main 用 `collectChromiumProcessRolePids` 同源的 pid 集合归类。主窗口 webContents 的
OS 进程为 `renderer_main`；`getType() === "webview"` 的 webContents 进程为 `renderer_guest`；
Host 与 scheduler 的 utilityProcess pid 分别由各自的 spawn 点注册；其余 Chromium 进程一律
`chromium_other`。cli 角色由 **services 打在样本上的 `lane`** 决定（CLI 进程不知道自己的 lane，
lane 不是 CLI 协议字段）：`chat` 归 `cli_chat`，`plugin` / `mcp-status` 归 `cli_aux`。

### 不采的进程

Bash 短命令（见慢命令方案）、git、node-pty shell、worker_threads（线程，计入宿主进程）、
没有走 CLI tracker / Bash 执行器的远端子进程、手机远控。`cua_helper` 角色移到二期，原因见「Out of Scope」。

## 采集架构

```text
renderer_main ──60s heap，preload 桥 IPC─────────────┐
host ──60s 自采（cpuUsage + memoryUsage），parentPort─┤
scheduler ──60s 自采，parentPort─────────────────────┤
CLI ──60s 自采 + 5min MCP 样本，protocol 通知──► Host ──转发──┤   local 与 remote 同一路径
CLI ──Bash 慢命令完成事件，protocol 通知────────► Host ──转发──┤
                                                            ▼
                           main：10s getAppMetrics + os 整机指标 + 有界聚合窗口
                                                            │ 每 5 分钟（开发构建 1 分钟）
                                                            ▼
                                       ARMS sendCustom（只有 main 持有凭据）
```

### 各来源细则

- **Chromium 体系（main 侧）**：每 10 秒调用一次 `app.getAppMetrics()`，读取每个进程的
  `percentCPUUsage`、`workingSetSize`、`creationTime`。Linux 上 `percentCPUUsage` 是单核口径，进入
  聚合前除以逻辑核数，与资源管理器使用同一个归一化函数。同一 tick 顺带读取 `os.cpus()` 差分得到整机
  CPU、`os.freemem()` 得到整机剩余内存。
- **Node 进程自采（main、host、scheduler、CLI）**：`process.cpuUsage()` 与单调时钟差分得到 CPU
  核数与整机归一化百分比，`process.memoryUsage()` 一次拿到 `rss` 与 `heapUsed`。每进程只有一个 60 秒
  定时器；host、renderer 复用现有内存诊断日志的定时器，一次读数同时喂本地日志与 ARMS 样本，与 CLI
  现有形态一致。
- **renderer heap**：复用现有 60 秒 `performance.memory` 采样，除写本地日志外，经 preload 桥向 main
  单向发送一条样本。Web 端无桥时 no-op。CPU 与 RSS 仍由 main 的 `getAppMetrics()` 提供。
- **MCP（CLI 侧）**：CLI 的 MCP tracker 持有 pid 与 mcp_id 映射。每 5 分钟采一次全部活跃 MCP 进程树：
  macOS 一次 `ps -eo pid=,ppid=,rss=,cputime=`（进程树要 ppid 才能展开后代，`-p <pid 列表>` 只回列表
  自身，拿不到 `npx` 这类包装进程的子进程）；Linux 先读全部 `/proc/<pid>/stat` 拿 ppid、pgid 与
  utime/stime，再只对树内 pid 读 `/proc/<pid>/status` 的 `VmRSS`，不起进程；Windows 一次
  `tasklist /FO CSV /NH`，只有内存、没有 ppid，进程树退化为直连进程。CPU 取相邻两次
  `cputime` 差分除以间隔，为 5 分钟均值。每窗口 1 个样本，`sample_count=1`。mcp_id 沿用
  mcp-process-arms-telemetry.md 的定义与脱敏规则。
- **Bash 慢命令（CLI 侧）**：Bash 工具子进程运行满 15 秒时开始采样，此后每 15 秒一次，命令结束时
  发一条完成通知。macOS 以进程组为边界 `ps -o pid=,rss=,cputime= -g <pgid>`；Linux 读 `/proc` 并按
  pgid 过滤；Windows 不采进程树，只带零成本字段。Bash 默认超时 5 分钟，单条命令最多约 20 个样本。
  短于 15 秒的命令不产生任何事件。
- **CPU 口径**：全部为整机归一化百分比，100 表示所有逻辑核占满。事件携带 `logical_cpu_count`，
  平台侧可换算为核数。
- **内存口径**：主指标 RSS（Windows 为 working set），单位 KB。Node 进程与 renderer_main 附
  `heap_used_kb`。不上报 private、shared、GPU 显存。
- **前后台**：main 每个 10 秒 tick 记录一次 scene，存在可见且聚焦的窗口为前台。窗口内
  `background_ratio = 后台 tick 数 / 总 tick 数`。
- **运行时长**：Chromium 进程用 `creationTime`；CLI 与 MCP 样本自带 `uptimeMinutes`。多进程角色取最大值。
- **硬件维度**：角色事件的 `platform`、`arch`、`logical_cpu_count`、`total_memory_gb` 一律描述
  该进程实际运行的机器。远端 CLI 与远端 MCP 的样本自带这四项并覆盖全局默认值；本机角色取桌面机的值。

## 事件契约

所有事件带全局属性 `platform`、`app_version`、`arms_env`、`device_mid`。全局与事件属性合并后
不超过 ARMS 单事件 20 个属性上限；值为 `undefined` 的属性不发送，不计入上限。`group=resource`。

### `perf_process_window`

每角色 / runtime_surface / 运行机分组每窗口一条，MCP 再按 mcp_id 分组。`value` 为 `cpu_percent_mean`。

| 类别 | 属性                      | 说明                                                               |
| ---- | ------------------------- | ------------------------------------------------------------------ |
| 维度 | `process_role`            | 上表 10 个枚举值                                                   |
| 维度 | `runtime_surface`         | `local` / `remote`                                                 |
| 维度 | `arch`                    | 运行机架构                                                         |
| 维度 | `logical_cpu_count`       | 运行机逻辑核数                                                     |
| 维度 | `total_memory_gb`         | 运行机物理内存，取整 GB                                            |
| 维度 | `mcp_id`                  | 仅 `mcp` 角色                                                      |
| 状态 | `background_ratio`        | 0 到 1，两位小数                                                   |
| 状态 | `uptime_minutes`          | 该角色内最老进程的运行分钟数                                       |
| CPU  | `cpu_percent_p95`         | 窗口内角色总 CPU 的 p95                                            |
| CPU  | `cpu_percent_peak`        | 窗口内角色总 CPU 的最大值                                          |
| 内存 | `rss_kb_total_mean`       | 角色内全部进程 RSS 之和的均值                                      |
| 内存 | `rss_kb_total_peak`       | 角色内全部进程 RSS 之和的最大值                                    |
| 内存 | `rss_kb_max_process_peak` | 窗口内单个进程 RSS 的最大值                                        |
| 内存 | `heap_used_kb_mean`       | 仅 Node 与 renderer_main；多进程取每次收到读数的最大单进程再求均值 |
| 内存 | `heap_used_kb_peak`       | 同上，取最大值                                                     |
| 质量 | `process_count_peak`      | 窗口内该角色同时存活的最大进程数                                   |
| 质量 | `sample_count`            | 窗口内样本数；main 侧角色预期 30，CLI 角色预期 5，mcp 为 1         |

属性数：Node 角色与 renderer_main 最多 20 个（heap 缺采时省略两项）；mcp 19 个（无 heap 两项，有 mcp_id）；gpu、renderer_guest、
chromium_other 18 个。

### `perf_system_window`

每设备每窗口一条。`value` 为 `app_cpu_percent_mean`。属性 17 个。

| 类别 | 属性                                             | 说明                                                               |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------ |
| 维度 | `arch`、`logical_cpu_count`、`total_memory_gb`   | 桌面机                                                             |
| 状态 | `background_ratio`、`app_uptime_minutes`         | `background_ratio` 与角色事件同源；uptime 取 main 进程运行时长     |
| 整机 | `system_cpu_percent_p95`                         | `os.cpus()` 差分                                                   |
| 整机 | `system_free_memory_kb_min`                      | 窗口内 `os.freemem()` 最小值                                       |
| 应用 | `app_cpu_percent_p95`                            | 全部本机 ZCode 进程合计                                            |
| 应用 | `app_rss_kb_total_mean`、`app_rss_kb_total_peak` | Chromium 体系每 10 秒精确合计，加 CLI 与 MCP 最近一次已知样本      |
| 应用 | `process_count_total_peak`                       | 全部本机 ZCode 进程数峰值                                          |
| 质量 | `sample_count`                                   | 首个 tick 无 CPU 基线不产生样本，5 分钟窗口预期 29                 |
| 质量 | `telemetry_self_ms`                              | 窗口内 main 侧采样与聚合代码累计墙钟毫秒数，`performance.now()` 计 |

应用总量的两类来源：

- **Chromium 体系**：每 10 秒 `getAppMetrics()` 的精确合计，与角色事件同一次读数。
- **外部来源（CLI、MCP）**：不在 `getAppMetrics()` 里，采样周期也不是 10 秒，因此只保留每个来源
  最近一次已知样本，并按该来源自身的采样周期判定过期——超过两个周期没有新样本即不再计入
  （CLI 为 120 秒，MCP 为 600 秒）。远端进程的样本不计入设备级总量。宁可少算，也不拿旧值
  充当当前事实。

### `perf_tool_exec_resource`

每条超过 15 秒的 Bash 命令一条，命令结束时即时上报。`value` 为 `duration_ms`。属性 12 个，
Windows 缺 `tree_*` 两项。

09 落地约定：执行适配器在 Bash 的实际 spawn 边界创建每命令采样器，准备 shell / 输出文件的时间不计入
`duration_ms`。前台转后台沿用同一采样器；根进程退出或既有 stop 结算时封口一次，不等待探针或输出读取。
15 秒整开始具备上报资格，5 秒结束无事件；Windows 不创建采样定时器，结束时仅取零成本上下文，
`sample_count=0`。非 Windows 最多尝试 20 次，只有成功且非空的探针结果计入 `sample_count`；
无成功样本时 tree 两项为 0。RSS 为各次进程组 RSS 总和的最大值；CPU 按 PID 累加首次累计值及后续
非负增量，保留已消失进程的已观测 CPU，避免短命后代退出导致累计值倒退（两次采样间出生又退出的进程不可见）。
复用 Bash 已有的一秒共享轮询器，以单调时钟按命令起点门控；错相位命令允许最多一轮调度误差，
首采不早于 15 秒，采样间隔不少于 15 秒；事件循环迟滞不补采。每命令不新增 interval。
同命令不重叠采样，封口后的迟到结果丢弃；探针失败或通知回调异常只丢遥测，不修改工具结果。
正常 exit（含非零 code）为 completed，超时为 timeout，取消 / 杀树 / signal exit 为 killed，spawn error 为 error；
短于门槛的 spawn error 同样不发通知。

```text
adapter spawn → 每命令 owner → 15s / 30s / …（最多 20 次）
                    └→ root exit / stop → 同步封口 → process/toolExecResource
                         → services strict schema → trusted Host → main sendCustom
```

通知经既有 Host 资源旁路传递，terminal-client（desktop-continuous / web-remote-replayable）不订阅。
不新增 task 状态、队列、重试或 replay；硬件 platform 描述 CLI 所在机器。验收边界沿用 PRT-010/011/012，
并由执行适配器真实子进程回归验证 timeout、cancel、后台移交和原输出不变。

| 类别   | 属性                    | 说明                                                     |
| ------ | ----------------------- | -------------------------------------------------------- |
| 维度   | `runtime_surface`       |                                                          |
| 维度   | `tool_name`             | 第一期固定 `bash`                                        |
| 维度   | `exit_kind`             | `completed` / `timeout` / `killed` / `error`             |
| 命令   | `tree_rss_kb_peak`      | 命令进程树 RSS 之和的峰值                                |
| 命令   | `tree_cpu_time_ms`      | 命令进程树累计 CPU 时间；与 `duration_ms` 相除得到忙闲比 |
| 命令   | `sample_count`          | 采到的样本数                                             |
| 上下文 | `cli_rss_kb`            | 命令结束时 CLI 自身 RSS                                  |
| 上下文 | `system_free_memory_kb` | 命令结束时整机剩余内存                                   |

### 隐私边界

任何事件不携带 pid、文件路径、workspace 标识、session / task id、命令文本、模型名、提示词。
`mcp_id` 沿用既有脱敏规则。属性 key 集合在单测中白名单校验。

## 上报节奏、窗口与退出

| 项                   | 值                                         |
| -------------------- | ------------------------------------------ |
| 趋势窗口             | 生产 5 分钟；开发构建与 E2E 1 分钟便于验证 |
| main 侧采样          | 10 秒                                      |
| Node 进程自采        | 60 秒                                      |
| MCP 采样             | 5 分钟，每窗口 1 个样本                    |
| Bash 慢命令          | 门槛 15 秒，间隔 15 秒                     |
| 每角色每序列样本上限 | 32（容忍定时器漂移）                       |
| 每窗口 mcp_id 上限   | 32，超出丢弃                               |
| Bash 单命令样本上限  | 20                                         |

正常退出时 main 排空所有角色与系统事件的未满窗口，`sample_count` 如实反映残窗，不做持久化与重试。
CLI 进程退出时在途样本直接丢弃。崩溃、强杀、断电允许丢失未上报窗口。

E2E 跑的是打包构建（`app.isPackaged === true`），因此 1 分钟窗口的判据是「开发构建」或
「`ZCODE_ENV=test` 且带 `ZCODE_E2E_RUN_ID`」；生产客户端始终 5 分钟。

量级估算：每 5 分钟约 14 条（10 个角色若全部存活，约 3 个 mcp_id，1 条系统事件），每天在线 8 小时
约 1350 条趋势事件每设备，Bash 事件按慢命令条数另计。现状约 480 到 576 条。计费按条数，效果优先。

## 平台侧告警规则与看板

三条设计原则：看群体占比而不看单台设备；三种判断方式为版本回归对比、绝对水位占比、随运行时长增长；
阈值先起步再用真实 p95 校准。所有规则要求分组内至少 100 台设备，否则不评估。"基线"指同一角色上一个
稳定版本近 7 天的值。优先级 P1 立即处理，P2 当天处理，P3 周报。

### 第一期配置（20 条）

**A 类：版本回归**（发版后 24 到 48 小时，P1）

| 规则             | 指标与统计                                                 | 分组                       | 触发条件                         | 含义                                   |
| ---------------- | ---------------------------------------------------------- | -------------------------- | -------------------------------- | -------------------------------------- |
| A1 内存回归      | `rss_kb_total_mean` 的设备级 p95                           | process_role × app_version | 新版本大于基线 1.2 倍            | 某进程在新版本上普遍变大               |
| A2 闲置 CPU 回归 | `background_ratio ≥ 0.9` 的窗口中 `cpu_percent_p95` 的 p95 | process_role × app_version | 大于基线 1.5 倍，或绝对值大于 5% | 后台仍在烧 CPU，通常是定时器或轮询泄漏 |
| A3 前台 CPU 回归 | `background_ratio ≤ 0.1` 的窗口中 `cpu_percent_p95` 的 p95 | process_role × app_version | 大于基线 1.3 倍                  | 交互时更卡                             |
| A4 进程数回归    | `process_count_peak` 均值                                  | process_role × app_version | 大于基线 1.5 倍                  | 进程回收失效                           |
| A5 应用总量回归  | `perf_system_window.app_rss_kb_total_mean` 的 p95          | app_version                | 大于基线 1.2 倍                  | 用户直观感受到的 ZCode 占内存          |

**B 类：绝对水位**（滚动 1 小时，P2）。统计"近 1 小时内出现过超阈值窗口的设备占全部活跃设备的比例"，
触发条件统一为"占比大于基线 2 倍且大于 3%"。

| 规则 | 角色                  | 指标                                       | 初始阈值                    |
| ---- | --------------------- | ------------------------------------------ | --------------------------- |
| B1   | renderer_main         | `rss_kb_max_process_peak`                  | 1.5 GB                      |
| B2   | main                  | `rss_kb_max_process_peak`                  | 800 MB                      |
| B3   | host                  | `rss_kb_max_process_peak`                  | 800 MB                      |
| B4   | cli_chat              | `rss_kb_max_process_peak`                  | 1.5 GB                      |
| B5   | mcp，再按 mcp_id 分组 | `rss_kb_max_process_peak`                  | 1 GB                        |
| B6   | gpu                   | `rss_kb_max_process_peak`                  | 1 GB                        |
| B7   | scheduler             | `rss_kb_max_process_peak`                  | 300 MB                      |
| B8   | cli_aux               | `rss_kb_max_process_peak`                  | 1 GB                        |
| B9   | renderer_guest        | `rss_kb_total_peak`                        | 2 GB                        |
| B10  | 系统事件              | `app_rss_kb_total_peak / total_memory`     | 大于 40%                    |
| B11  | 系统事件              | `system_free_memory_kb_min / total_memory` | 小于 5%；整机压力上下文，P3 |

**G 类：数据质量**（滚动 1 小时，P1，保护其他所有规则）

| 规则          | 指标                                           | 触发条件        | 含义                                                    |
| ------------- | ---------------------------------------------- | --------------- | ------------------------------------------------------- |
| G1 采样丢失   | main 侧角色事件 `sample_count < 15`            | 设备占比大于 5% | main 事件循环被阻塞超过一半时间，本身就是 main 卡顿信号 |
| G2 角色缺失   | 有 renderer_main 事件但同窗口无 host 事件      | 设备占比大于 2% | 采集链路断了或 Host 没起来                              |
| G3 上报量异常 | 每设备每天事件总数                             | 大于预期 1.5 倍 | 上报逻辑失控，成本告警                                  |
| G4 数值异常   | `cpu_percent_* > 100` 或 `rss_kb_* = 0` 的事件 | 占比大于 0.1%   | 口径 bug，Linux 归一化问题会在这里暴露                  |

### 第二期配置（13 条，等一个版本的数据积累后）

**C 类：泄漏**（滚动 24 小时，P2）。按 `uptime_minutes` 分 4 桶：0 到 1 小时、1 到 4 小时、4 到 8 小时、8 小时以上。

| 规则                | 指标与统计                             | 分组                       | 触发条件                            | 含义                                           |
| ------------------- | -------------------------------------- | -------------------------- | ----------------------------------- | ---------------------------------------------- |
| C1 内存随时长增长   | 各桶 `rss_kb_total_mean` 中位数        | process_role × app_version | 8 小时以上桶大于 0 到 1 小时桶 2 倍 | 典型泄漏曲线                                   |
| C2 native 泄漏      | 各桶 `heap_used_kb_mean` 与 rss 中位数 | 同上，仅 Node 角色         | rss 满足 C1 但 heap 增长不到 1.3 倍 | 涨的不是 JS 堆                                 |
| C3 进程数随时长增长 | 各桶 `process_count_peak` 中位数       | process_role               | 8 小时以上桶大于 1 小时桶 2 倍      | 进程未回收，重点 cli_chat、renderer_guest、mcp |

**D 类：CPU 行为**（滚动 1 小时，P2）

| 规则              | 指标与统计                                                     | 分组          | 触发条件 | 含义                 |
| ----------------- | -------------------------------------------------------------- | ------------- | -------- | -------------------- |
| D1 后台空转       | `background_ratio ≥ 0.9` 且 `cpu_percent_p95 > 10%` 的设备占比 | process_role  | 大于 5%  | 用户没在用，进程在忙 |
| D2 前台持续高 CPU | `background_ratio ≤ 0.1` 且 `cpu_percent_p95 > 50%` 的设备占比 | renderer_main | 大于 5%  | UI 卡顿风险          |
| D3 GPU 进程高 CPU | `cpu_percent_p95 > 30%` 的设备占比                             | gpu           | 大于 3%  | 渲染层问题           |
| D4 MCP 闲置耗 CPU | 同 D1                                                          | mcp × mcp_id  | 大于 5%  | 某插件后台轮询       |
| D5 整机 CPU 饱和  | `system_cpu_percent_p95 > 90%` 且 app 占比超一半的设备占比     | app_version   | 大于 3%  | ZCode 是整机卡顿主因 |

cli_chat 不设 CPU 告警，Agent 工作时 CPU 高是正常的。

**E 类：进程拓扑**（滚动 1 小时，P2）

| 规则               | 指标                                              | 初始阈值                 | 含义                                               |
| ------------------ | ------------------------------------------------- | ------------------------ | -------------------------------------------------- |
| E1 CLI 进程堆积    | cli_chat `process_count_peak`                     | 大于 6 的设备占比大于 3% | 启动预热上限 1，超过 6 说明 workspace 关闭后未回收 |
| E2 浏览器 tab 堆积 | renderer_guest `process_count_peak`               | 大于 20                  | 内置浏览器 tab 泄漏                                |
| E3 MCP 实例过多    | 同一窗口不同 mcp_id 数                            | 大于 10                  | 插件重复启动                                       |
| E4 cli_aux 常驻    | cli_aux `process_count_peak` 连续 12 个窗口大于 0 | 设备占比大于 10%         | mcp-status lane 本应 5 分钟空闲回收                |

**F 类：Bash 慢命令**（滚动 24 小时，P3）

| 规则                  | 指标与统计                                                              | 触发条件              | 含义                                                 |
| --------------------- | ----------------------------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| F1 重命令             | `tree_rss_kb_peak > 2 GB` 的慢命令占比                                  | 大于 10%              | 命令本身吃内存                                       |
| F2 命令在等           | `tree_cpu_time_ms / duration_ms < 0.05` 且 `duration_ms > 120 s` 的占比 | 大于 20%              | 命令在等输入或网络，应改进超时或提示；Windows 不评估 |
| F3 整机压力下的慢命令 | `system_free_memory_kb` 小于总量 5% 的慢命令占比                        | 大于 10%              | 机器没内存导致慢                                     |
| F4 CLI 自身膨胀       | `cli_rss_kb > 1.5 GB` 的慢命令占比                                      | 大于 5%               | 命令期间 CLI 自己涨了                                |
| F5 慢命令频率回归     | 每活跃设备每天慢命令条数                                                | 新版本大于基线 1.5 倍 | 工具链变慢                                           |

### 规则落地示例

```sql
-- B1：renderer 单进程内存超 1.5GB 的设备占比（近 1 小时）
SELECT app_version,
       COUNT(DISTINCT CASE WHEN rss_kb_max_process_peak > 1572864 THEN device_mid END) * 1.0
         / COUNT(DISTINCT device_mid) AS over_ratio
FROM perf_process_window
WHERE process_role = 'renderer_main' AND ts > now() - interval '1 hour'
GROUP BY app_version
HAVING COUNT(DISTINCT device_mid) >= 100
```

### 看板

1. 各角色内存 p50 / p95 按 app_version 对比。
2. uptime 分桶 × 角色的内存热力图。
3. MCP 按 mcp_id 的内存与后台 CPU 排行。
4. 单设备按 device_mid 下钻的时间线，叠加系统事件。

## 性能红线（硬约束）

任何遥测改动不得让用户机器变慢。以下 7 条写入验收，并配 CI、单测、E2E 三层门禁。

1. **main 进程零外部进程**。删除现有每 10 秒的 `ps` 线程数探针。现有 Windows E2E 门禁
   `PERF-RES-01` 保留。
2. **全链路禁止 PowerShell、WMI、CIM、wmic**。CI 对遥测模块路径做关键字检查；单测断言 execFile
   从未以 powershell 为参数被调用。
3. **外部进程白名单只有两项**：CLI 进程内的 macOS `ps` 与 Windows `tasklist`。每次调用带 1 秒超时，
   超时即丢样本；同一探针实例连续 3 次失败后停用，直到显式 `reset()`。MCP 在下一次五分钟
   采样前重置，Bash 在单条命令内不重置失败预算。Linux 一律读 `/proc`，不起进程。
4. **每进程一个遥测定时器**，复用已有定时器，Node 进程 `unref()`，不延长进程寿命，不新增定时器。
5. **内存有界**：样本数组按上表上限截断，溢出丢弃；无队列、无持久化、无重试。
6. **失败即丢**：采样、校验、转发、`sendCustom` 任一步失败只丢当前样本，不阻塞业务、不抛到主循环。
7. **自证开销**：main 侧采样与聚合代码用 `performance.now()` 累计墙钟耗时，以 `telemetry_self_ms`
   上报，上线后可直接观察遥测自身成本。

### 受保护遥测文件命名约定（红线第 2 条的执行细则）

关键字门禁不可能扫全仓库（`packages/services/src/process/` 下的进程回收链路、CLI 的剪贴板实现都
合法使用 PowerShell），因此红线第 2 条落到一条命名约定上：**遥测代码放进名字带 `telemetry` /
`Telemetry` / `process-probe` / `process-resource` / `processResource` 的文件或目录**，门禁只扫这批文件。

- **受保护范围**：`packages/desktop/src/**`、`packages/services/src/**`、`packages/shared/src/**`、
  `apps/zcode-cli/**/src/**` 中，**相对路径**含 `telemetry`、`Telemetry`、`process-probe`、`process-resource` 或 `processResource` 的源码
  文件（`.ts` / `.tsx` / `.js` / `.mjs` 等）。判定看整条路径而不只是文件名——只看文件名会让
  `apps/zcode-cli/packages/telemetry/src/`（`agent-metrics.ts`、`otlp-exporter.ts` 等）与
  `*/src/telemetry/` 这类整目录的遥测代码集体逃逸。受保护文件数从实际 Git 跟踪集动态统计，以门禁输出为准；来源注册表中的模块也由交叉回归保证进入扫描集。
- **禁用关键字**：`powershell`、`Get-CimInstance`、`wmic`、`Get-Process`（大小写不敏感）。
- **注释不算违规**：扫描前先剥离行注释与块注释，保证 spec 注释和 bugfix 注释能正常写清「为什么禁止
  PowerShell」；字符串字面量保留，`execFile("powershell.exe", …)` 一定会被抓到。扫描器识别正则转义与字符类，正则内的反引号不再污染后续注释；
  模板插值内按代码处理，除法不被当成正则。真实调用与真实注释分别有整仓回归。
- **测试文件不受检查**：`*.test.*`、`*.spec.*` 与 `test/` `tests/` `__tests__/` 目录排除——单测需要
  正面断言「execFile 从未以 powershell 为参数被调用」，必须能写出关键字。
- **`packages/ui` 不在范围内**：渲染进程代码起不了子进程，renderer heap 样本经 preload 桥上报。
- **实现位置**：`scripts/ci/ci-telemetry-keyword-guard.mjs`，由 `scripts/ci/ci-repo-hygiene.mjs`
  在 CI 第一站调用（`.gitlab/ci/30-build.yml`），脚本单测在
  `scripts/ci/ci-telemetry-keyword-guard.test.mjs`（已接入 `pnpm test:engineering`，含「当前仓库必须通过」
  这条回归）。本地可直接 `node scripts/ci/ci-telemetry-keyword-guard.mjs`。
- **所有遥测模块必须遵守**：新增或拆分的探针、来源与聚合模块都要按该命名落文件或落进 telemetry 目录，
  否则等于自动脱离门禁。

豁免清单（写在门禁脚本的 `TELEMETRY_GUARD_EXEMPTIONS`，条目指向的文件必须存在，否则门禁按 `K2`
失败，防止清单腐烂）。条目明确区分是否实际进入扫描；当前两项均为生效豁免，未登记的关键字仍会失败：

| 文件                                                                 | 状态 | 豁免关键字                      | 原因                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ---- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/services/src/process/processResourceSampler.ts`            | 生效 | `powershell`、`Get-CimInstance` | 资源管理器 Host 侧进程表采样器：只在资源管理器窗口打开并主动请求时读一次整机进程表，属于**按需 UI 采样而非常驻遥测**；Windows 上需要同时拿到 RSS 与 CPU 时间，只能走 CIM。运行在 Host utility 进程，不在 main，也不参与 `perf_process_window` 上报。该文件因 processResource 命名进入扫描集，仅按此明确理由豁免两个关键字。 |
| `apps/zcode-cli/packages/contracts/src/telemetry/agent-execution.ts` | 生效 | `powershell`                    | 纯类型文件：`powershell` 只是 `CommandShellKind` 枚举里「用户命令用的是哪种 shell」的上报标签，不启动任何进程。                                                                                                                                                                                                             |

各采集点成本核算见下表，作为红线的依据。

| 采集点                       | 进程     | 方式                          | 频率                 | 外部进程          | 与现状比               |
| ---------------------------- | -------- | ----------------------------- | -------------------- | ----------------- | ---------------------- |
| Chromium 体系 CPU 与 RSS     | main     | getAppMetrics                 | 10 秒                | 否                | 不变                   |
| main 线程数                  | main     | ps                            | 删除                 | 删除              | 净减少                 |
| main / host / scheduler 自采 | 各自     | cpuUsage、memoryUsage         | 60 秒                | 否                | 复用定时器             |
| renderer heap                | renderer | performance.memory + 1 条 IPC | 60 秒                | 否                | 复用定时器             |
| CLI 自采                     | CLI      | 已有 sampler                  | 60 秒                | 否                | 不变                   |
| MCP                          | CLI      | ps / /proc / tasklist         | 5 分钟               | macOS、Windows 是 | 沿用旧链路五分钟节拍   |
| Bash 慢命令进程树            | CLI      | ps / /proc                    | 仅慢命令期间每 15 秒 | macOS 是          | 新增，相对重命令可忽略 |
| 整机指标                     | main     | os.cpus、os.freemem           | 10 秒                | 否                | 新增，可忽略           |

## Implementation Decisions

- **shared 协议层**：`process/resourceSample` 通知的 schema 新增可选字段 `heapUsedKb`、
  `uptimeMinutes`、`totalMemoryGb` 与 `instanceToken`（CLI 进程启动时随机生成，字符集限定
  `[A-Za-z0-9_-]{8,64}`，只供 main 统计进程数与最大单进程，不进 ARMS、不含 pid）；新增通知
  `process/mcpResourceSamples`（数组，每项含 `mcpId`、
  `processCount`、`rssKbTotal`、`rssKbMaxProcess`、`cpuTimeMsDelta`、`uptimeMinutes`）与
  `process/toolExecResource`（Bash 完成事件）。全部新增字段可选，旧 CLI 发来的样本仍能通过校验。
  **不递增协议握手版本号**：握手版本是兼容性开关而非字段版本，遥测字段变更走可选字段。
  **`lane` 不在 CLI 协议 schema 里**：CLI 进程不知道自己被哪个进程管理器拉起，lane 由 app 侧
  services 打标，因此它只出现在 app 内部的 `agentLaneResourceSampleSchema`
  （= CLI 协议 schema + 可选 `lane`，仍 `strict`）；CLI 自报 lane 会被协议层直接拒绝。
  Host 到 main 的响应消息新增 `HostResourceSample`（Host 自采，payload 为
  `nodeSelfResourceSampleSchema`：`cpuPercent` / `rssKb` / `heapUsedKb` 三项且 `strict`）、
  `McpResourceSamples`、`ToolExecResource`，现有 `AgentResourceSample` 的 `sample` 改用
  `agentLaneResourceSampleSchema`；main 入口沿用 host 响应 schema 严格校验。scheduler 走自己的私有协议
  （`scheduler/schedulerProtocol.ts` 的 `scheduler-resource-sample`），payload 复用同一个 schema，
  main 摄入时再校验一次，非法样本直接丢弃。
  新增 `ProcessResourceRole` 枚举、`PROCESS_RESOURCE_CLI_LANES` 词表与
  `resolveCliProcessResourceRole`（lane → 角色，缺省按 `cli_chat`），以及三个事件的属性 key
  白名单常量，供 main 与单测共用。
- **CLI**：现有进程资源 sampler 扩展输出 heap、uptime、total memory 与 instanceToken（lane 由 app 侧
  打标，CLI 不参与）；新增 MCP 资源采样器，
  每 5 分钟从 MCP tracker 取 pid 与 mcp_id 映射并按平台采样；新增 Bash 慢命令采样器，挂在执行适配器
  的子进程生命周期上，15 秒门槛后按进程组采样，结束时发完成通知。CLI 自采仍使用进程内 API；
  MCP 与 Bash 共享同一个平台探针模块
  `adapters/src/device/process-probe.ts`（`sampleProcessTrees(rootPids)`、
  `sampleProcessGroup(pgid)`、`reset()`、`treeScope`），
  实现超时、连续失败停用与 Windows 无 CPU 的策略。失败预算属于探针实例：每个采样场景持有一个
  长生命周期实例（MCP 一个、每条 Bash 命令一个），场景间互不干扰。MCP 每次五分钟采样前
  `reset()`；Bash 的失败预算持续到该命令结束。
  Windows 的进程树口径由 `treeScope` 自报（`direct_process`），调用方不再自己判平台。
  现有 5 分钟 `perf_mcp_memory` 采集停用，MCP 生命周期事件（start / crash / session-startup）不变。
  **口径变更风险**：MCP 采样超时从原来的 5 秒收紧到红线要求的 1 秒，Windows 上 `tasklist` 在高负载机器
  可能超过 1 秒，对应窗口静默无样本；上线后需观察 `perf_process_window` 的 mcp 角色
  在 Windows 的窗口覆盖率是否下降。
- **services**：Agent service 解析新通知并以 dynamic event 分发；remote workspace 的 service
  collection 也接线资源遥测订阅，runtime_surface=remote。
  落地位置（05）：`wireClient` 新增 lane 形参，四个调用点分别传 `chat`（workspace 级 Agent
  两条路径）、`plugin`、`mcp-status`；`onDynamicProcessResourceSample` 的载荷类型
  从 `ZCodeProcessResourceSample` 变为 `AgentLaneResourceSample`（多一个可选 `lane`）。
  lane 只能在这里补：进程管理器是唯一知道「这个 client 属于哪条 lane」的地方。
  落地位置（06）：远端订阅走的是既有的 `zcodeAgentConnectionScope` 边界，不新增 services 层代码——
  远端 zcode-server 对桌面 Host 的连接是 `trusted-host-relay`（`packages/server` 的 stdio 与
  `zcode-server-cli` 的 `/ws/host`），只有该角色能订阅 `onDynamicProcessResourceSample` /
  `onDynamicMcpTelemetry` / `onDynamicMcpResourceSamples`；renderer 与手机远控 attachment 是 `terminal-client`，拿到 `RpcEvent.None`。
- **Host**：资源遥测注册模块统一转发 CLI 样本、MCP 样本、Bash 事件；Host 自身样本复用内存诊断日志的
  60 秒定时器，增加 CPU 差分，一次读数同时写本地日志与发 parentPort 消息。
  落地位置（03）：`desktop/src/host/hostSelfResourceTelemetry.ts` 是 host/index.ts 的唯一入口，
  内部包住 `hostMemoryDiagnosticsLog`（新增 `onMemoryUsage` 钩子，在写盘门控之前、与门控无关地
  把同一次读数交给遥测）。
  落地位置（06）：`desktop/src/host/hostServiceResourceTelemetry.ts` 的
  `registerHostServiceResourceTelemetry({ services, postMessage, runtimeSurface, onError })` 是
  「一份 service collection 的资源遥测订阅」的唯一入口，内部只组合 `hostAgentResourceTelemetry`
  与 `hostMcpTelemetry` 两条转发。调用点两处：本地 host services 初始化（`runtime_surface=local`）、
  `createWindowRemoteConnectionHandle` 里远端 services 建成之后（`runtime_surface=remote`，
  订阅由 handle 持有并在 `dispose()` 中释放）。缺少 Agent service 或单条订阅抛错时返回 no-op 并
  释放已建立的那条，绝不改变 Host 初始化与远程连接结果。
- **scheduler**：新增 60 秒自采，经 parentPort 发送；spawn 点向 main 的进程角色注册表登记 pid。
  落地位置（03）：`desktop/src/scheduler/schedulerResourceTelemetry.ts`（唯一的 unref 定时器，
  在 `main()` 启动、`dispose()` 停止）。
- **Node 自采换算**：`packages/shared/src/node/nodeSelfResourceTelemetry.ts` 的
  `createNodeSelfResourceSampler` 是 host 与 scheduler 共用的一份差分逻辑（构造即建立 CPU 基线，
  基线不可用时返回 null）；它不持有定时器、不负责发送，因此"定时器只有一个"的约束留在调用方。
- **renderer**：内存诊断采样器在写本地日志的同一次采样中，经 preload 桥向 main 发送 heap 样本；
  Web 端无桥 no-op。UI 层不得直接调用 `window.zcode.log` 或 ipc。
  落地位置（04）：
  - `packages/ui/src/lib/memoryDiagnostics.ts` 的 `startMemoryDiagnosticsLogger` 新增
    `reportHeapSample` 注入点，在写盘门控之前调用；桥抛错只丢这条遥测样本，本地日志照旧写出
  - `IPlatformService.reportRendererHeapSample`（`packages/shared/src/platform.ts`）是 UI 唯一的出口，
    由 `App.tsx` 注入给采样器；desktop 在 `desktopPlatform.ts` 接 preload 桥，Web 与手机远控不实现
  - `PlatformChannels.ReportRendererHeapSample` + `rendererHeapSampleSchema`（`strict`，只有 `heapUsedKb`）；
    preload 只暴露 `ipcRenderer.send`，不提供 invoke
  - `desktop/src/main/processResourceRendererHeapSource.ts`：来源注册表第四行，同时是该通道的 main 侧
    落点与信任边界（通道只允许一个监听器，重复注册不叠加）。按 `event.sender.id` 经
    `resourceManagerWindow.isMainApplicationWindowWebContents()` 判定归属（与角色 pid 同一份数据源），
    只取 heap 并在下一个 tick 通过 `addRoleHeapSample` 交出，交付即清空；多窗口取本 tick 已到达读数的最大值
- **main**：资源遥测模块重写。10 秒 tick 读取 getAppMetrics 与整机指标、Linux 归一化、按角色分类并
  记录 scene；接收各来源样本进入有界窗口；5 分钟 flush 每角色一条 `perf_process_window` 与一条
  `perf_system_window`；Bash 事件即时 `sendCustom`；正常退出排空残窗。删除线程数探针、10% 角色抽样、
  互斥属性布局、`perf_resource_window`、`perf_resource_agent`、`perf_mcp_memory`。角色分类器扩展
  `renderer_guest`、`chromium_other`、`scheduler`。Linux CPU 归一化函数从资源管理器模块提升为
  两处共用。
  落地后的模块划分（01）：
  - `packages/shared/src/processResourceTelemetry.ts`：角色枚举、事件名、属性 key 白名单、属性计数与隐私校验
  - `desktop/src/main/electronCpuNormalization.ts`：`normalizeElectronCpuToMachinePercent`（资源管理器 UI 与遥测共用）
  - `desktop/src/main/processResourceRoleClassifier.ts`：Chromium 进程 → 角色归类与单 tick 聚合（纯函数）
  - `desktop/src/main/processResourceWindowAggregator.ts`：有界窗口与报告投影（纯函数）
  - `desktop/src/main/processResourceWindowEvent.ts`：`perf_process_window` 的属性投影
  - `desktop/src/main/processResourceSampleSources.ts` + `processResourceSampleSourceRegistry.ts`：
    按来源注册的摄入表；**03 到 09 各新增一个来源文件并在注册表数组追加一行**，单个来源抛错只丢自己的样本。
    采样分两个阶段：`sample()` 产出角色样本与本 tick 的精确合计，`sampleDevice()` 供需要「同一 tick
    其他来源已采到的事实」的来源使用（02 的设备级窗口）
  - `desktop/src/main/processResourceChromiumSource.ts`：Chromium 体系来源（唯一 `getAppMetrics()` 读点，
    同时导出本 tick 的体系精确合计供设备级事件使用）
  - `desktop/src/main/desktopResourceTelemetry.ts`：定时器、scene 记录、ARMS 出口与退出排空
    落地后新增的模块（02）：
  - `desktop/src/main/processResourceSystemSource.ts`：设备级来源（注册表第二行），
    `os.cpus()` 差分与 `os.freemem()` 的唯一读点，基线缺失时本 tick 不产生样本
  - `desktop/src/main/processResourceSystemWindowAggregator.ts`：设备级有界窗口与报告投影
  - `desktop/src/main/processResourceSystemWindowEvent.ts`：`perf_system_window` 的 17 个属性投影
  - `desktop/src/main/processResourceExternalAppSamples.ts`：外部样本入口
    （`recordExternalAppResourceSample`，按来源保留最近样本、按各自周期过期、条目有界，05 与 08 调用）
  - `desktop/src/main/processResourceAppTotals.ts`：「一批进程的资源合计」这个值与相加逻辑的唯一实现，
    Chromium 精确合计与外部样本合计共用
  - 角色 pid 的唯一数据源是 `resourceManagerWindow.collectChromiumProcessRolePids()`；
    主窗口由 `createWindow` 调 `registerMainApplicationWindow`，scheduler 由 `spawnCronScheduler` 调
    `registerSchedulerProcess`，`<webview>` guest 用 `webContents.getType() === "webview"` 判定
  - ARMS 出口同时写入 `desktopArmsCustomEvent` 的共享 E2E 捕获环，E2E 才能读到 main 自己发出的事件
    落地后新增的模块（03）：
  - `desktop/src/main/processResourceSelfHeapSource.ts`：host / scheduler 自采 heap 的来源
    （注册表第三行），`ingestHostSelfResourceSample` / `ingestSchedulerSelfResourceSample` 由
    `desktopHostProcess` 与 `desktopCronScheduler` 的消息分发点调用；只取 heap 并在下一个 tick
    通过 `addRoleHeapSample` 交出，交付即清空
  - `ProcessResourceSampleContext.addRoleHeapSample(role, heapUsedKb)`：只贡献 heap 读数的来源共用的
    钩子（04 的 renderer heap 复用它）。heap 并入同一 tick 内该角色的完整样本，该角色本 tick 没有
    完整样本时这次读数丢弃——heap 只是角色事件的附加维度，不足以独立开窗。main 自身的 heap 也走这条
    合并路径，不再在 `takeSample` 里单独特判
    落地后新增的模块（05）：
  - `desktop/src/main/processResourceCliSource.ts`：CLI 角色来源（注册表第五行）。
    `ingestCliResourceSample(sample, runtimeSurface)` 由 `desktopHostProcess` 的
    `AgentResourceSample` 分发点调用，按「角色 × runtime_surface × instanceToken」保留每进程最近
    一次读数；`sample()` 每 60 秒交出一次当前存活进程的合计，并把本机合计喂给
    `recordExternalAppResourceSample`。**不采用「交付即清空」**：多个 CLI 进程的 60 秒定时器相位
    不同，一个 tick 通常只到达其中一部分读数，清空式交付会让 `process_count_peak` 与总量偏小；
    角色事件要的恰恰是「同时存活几个进程、合计多少」。过期判据与设备级外部样本一致（2 个周期）
  - `ProcessResourceHardwareOverride` 与 `processResourceHardwareKey`
    （`processResourceWindowAggregator.ts`）：样本自报的运行机信息改为可缺字段，出口
    `{ ...desktopHardware, ...report.hardware }` 逐字段覆盖——旧 CLI 只带 platform / arch / 核数时，
    `total_memory_gb` 仍取桌面机的值；Host 运行环境身份与硬件指纹同时进窗口 key，一条事件只描述一个运行环境
  - `ProcessResourceSampleSource.flushPending`：退出排空时把「已收到、未交付」的读数补进窗口，
    08 的 MCP 样本复用同一个钩子
  - 删除 `desktop/src/main/agentResourceTelemetryWindow.ts` 与 `perf_resource_agent` 出口
- **文档**：事件字典新增三个事件并标注旧事件停发版本；性能监控文档资源章节、CLI 资源上报文档、
  MCP 文档内存章节改为指向本文；内存诊断日志文档补充"采样源与资源遥测共用"。

## Testing Decisions

好的测试只断言外部行为：给定一组输入样本与时钟推进，断言发出的事件名、value、属性集合与属性数；
给定平台，断言没有启动任何外部进程；给定失败注入，断言样本被丢弃且不抛错、不阻塞。不测内部数据结构。

测试缝（优先复用既有缝，自高向低）：

1. **main 聚合器缝**：注入伪造的 `getAppMetrics`、`os` 指标、时钟与 `armsRum.sendCustom` 间谍，
   推进 tick 与 flush 断言事件。先例：`desktopResourceTelemetry.test.ts`、`desktopMcpTelemetry.test.ts`。
2. **CLI 采样器缝**：注入 `readCpuUsage`、`readMemoryUsage`、`readMonotonicTimeNs`、定时器与平台探针
   桩。先例：CLI bootstrap 的 process-resource-sampler 单测。
3. **Host 转发缝**：伪造 agentService 的 dynamic event 与 `postMessage` 间谍。先例：
   `hostAgentResourceTelemetry.test.ts`、`hostMemoryDiagnosticsLog.test.ts`。
   collection 级接线（06）用同一个缝再高一层：往真实 `ServiceCollection` 里注册一个只实现两个
   `onDynamic*` 的 Agent service 桩，断言订阅数、转发消息的 `runtimeSurface` 与 dispose 后不再转发；
   手机远控用真实 `windowHostAttachmentRegistry` + 真实 `createZCodeAgentConnectionScope` 建 attachment，
   断言 attachment 侧拿不到样本、底层订阅数不变。先例：`hostServiceResourceTelemetry.test.ts`。
4. **renderer 缝**：伪造 `performance.memory` 与 preload 桥。先例：UI 的 memoryDiagnostics 与 logger 单测。
5. **E2E 缝**：开发态 1 分钟窗口，用现有 `ReadFinalArmsCustomEventsE2E` 通道读取 main 侧最终
   ARMS 自定义事件。先例：`desktopArmsCustomEventE2E.test.ts` 与使用该通道的 E2E。
6. **Windows 探针缺席 E2E**：现有 `windows-agent-metric-probe-absence.test.ts` 保留并扩展断言
   runtime log 不含 `powershell`。
7. **CI 关键字门禁**：`ci-repo-hygiene` 增加遥测模块路径的禁用关键字检查。先例：该脚本已有的
   node-gyp 产物与 `.playwright-mcp/` 拒绝规则。

纯函数（角色分类、统计、属性白名单、归一化、门控）全部单测；协议 schema 兼容性在 shared 与 services 单测。

### 验收 Case

| Case ID | Setup                                                                                                                | Action                           | Assertions                                                                                                                              | Layer          | 验证与对应测试（2026-09-15）                               |
| ------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| PRT-001 | 伪造 getAppMetrics 含 main / 主窗口 renderer / webview guest / GPU / host utility / scheduler utility / 其他 utility | 推进 30 个 10 秒 tick 后 flush   | 7 条 `perf_process_window` 角色正确，1 条 `perf_system_window`；每条属性数不超 20                                                       | unit           | [x] 通过；[desktop][prt-desktop]、[system][prt-system]     |
| PRT-002 | platform=linux，8 核，percentCPUUsage=80                                                                             | tick                             | 角色 cpu 为 10                                                                                                                          | unit           | [x] 通过；[desktop][prt-desktop]                           |
| PRT-003 | renderer_guest 3 个进程 RSS 100 / 200 / 300                                                                          | flush                            | `rss_kb_total_peak`=600，`rss_kb_max_process_peak`=300，`process_count_peak`=3                                                          | unit           | [x] 通过；[desktop][prt-desktop]                           |
| PRT-004 | 30 个 tick 中 9 个后台                                                                                               | flush                            | `background_ratio`=0.3                                                                                                                  | unit           | [x] 通过；[desktop][prt-desktop]                           |
| PRT-005 | creationTime 分别 90 分钟与 10 分钟前                                                                                | flush                            | 单进程角色 uptime 正确，多进程角色取最大                                                                                                | unit           | [x] 通过；[desktop][prt-desktop]                           |
| PRT-006 | host 样本含 heapUsedKb；gpu 无                                                                                       | flush                            | host 事件有 heap 两项共 20 属性；gpu 事件无 heap 共 18 属性                                                                             | unit           | [x] 通过；[desktop][prt-desktop]                           |
| PRT-007 | CLI 样本 2 条 lane=chat、1 条 lane=plugin                                                                            | flush                            | cli_chat `process_count_peak`=2，cli_aux=1，总量与最大单进程正确                                                                        | unit           | [x] 通过；[cli][prt-cli]                                   |
| PRT-008 | CLI 样本 runtimeSurface=remote，platform=linux，arch=x64                                                             | flush                            | 事件 platform=linux、runtime_surface=remote，覆盖桌面机全局值                                                                           | unit           | [x] 通过；[cli][prt-cli]                                   |
| PRT-009 | 两个 mcp_id 的 MCP 样本                                                                                              | flush                            | 2 条 mcp 事件各带 mcp_id，无 heap，19 属性                                                                                              | unit           | [x] 通过；[desktop][prt-desktop]                           |
| PRT-010 | Host 转发 Bash 完成通知                                                                                              | 收到即刻                         | 1 条 `perf_tool_exec_resource`，value=duration_ms，12 属性；Windows 样本 10 属性                                                        | unit           | [x] 通过；[desktop][prt-desktop]                           |
| PRT-011 | CLI Bash 采样器，伪造时钟与 ps 桩                                                                                    | 命令运行 40 秒后结束             | 在 15 秒与 30 秒各采一次，peak 正确，完成通知只发一次；命令 5 秒结束不发通知                                                            | unit           | [x] 通过；[bash][prt-bash]                                 |
| PRT-012 | CLI Bash 采样器 platform=win32                                                                                       | 命令 40 秒                       | 无 tree 字段，未调用任何外部进程                                                                                                        | unit           | [x] 通过；[bash][prt-bash]                                 |
| PRT-013 | CLI MCP 采样器                                                                                                       | 推进 5 分钟                      | macOS 调用一次 ps 且根与后代展开正确；Linux 读 /proc 不 spawn；Windows 调用一次 tasklist；1 秒超时丢样本；连续 3 次失败后停用直到 reset | unit           | [x] 通过；[probe][prt-probe]、[mcp][prt-mcp]               |
| PRT-014 | main 模块，间谍 child_process                                                                                        | 全平台 tick + flush + 退出 flush | child_process 从未被调用                                                                                                                | unit           | [x] 通过；[desktop][prt-desktop]、[system][prt-system]     |
| PRT-015 | CI 卫生脚本                                                                                                          | 扫描遥测模块路径                 | 不含 powershell / Get-CimInstance / wmic / Get-Process                                                                                  | CI             | [x] 通过；[guard][prt-guard]                               |
| PRT-016 | 已有 12 个 tick                                                                                                      | 调用带 flush 的 stop             | 发出残窗事件，`sample_count`=12；stop 后不再采样                                                                                        | unit           | [x] 通过；[desktop][prt-desktop]、[system][prt-system]     |
| PRT-017 | 任意窗口                                                                                                             | flush                            | `perf_system_window.telemetry_self_ms` 存在且不小于 0                                                                                   | unit           | [x] 通过；[system][prt-system]                             |
| PRT-018 | 40 个 tick 不 flush                                                                                                  | flush                            | `sample_count` 不超过 32                                                                                                                | unit           | [x] 通过；[window][prt-window]                             |
| PRT-019 | 任意窗口                                                                                                             | flush                            | 不出现 `perf_resource_window`、`perf_resource_agent`、`perf_mcp_memory`                                                                 | unit           | [x] 通过；[desktop][prt-desktop]、[legacy][prt-legacy]     |
| PRT-020 | host 60 秒 tick                                                                                                      | 推进定时器                       | 一条 `HostResourceSample` 含 cpuPercent / rssKb / heapUsedKb；本地日志行仍按门控写出；只有一个定时器                                    | unit           | [x] 通过；[host][prt-host]                                 |
| PRT-021 | renderer 60 秒 tick                                                                                                  | 推进定时器                       | 桥收到 heap 样本；本地日志仍写；无桥时 no-op                                                                                            | unit           | [x] 通过；[renderer][prt-renderer]                         |
| PRT-022 | scheduler 60 秒 tick                                                                                                 | 推进定时器                       | parentPort 收到样本                                                                                                                     | unit           | [x] 通过；[scheduler][prt-scheduler]                       |
| PRT-023 | 开发态 1 分钟窗口                                                                                                    | 冷启动进入 workspace 等待 90 秒  | E2E 通道读到 `perf_process_window`（至少 main、renderer_main、host）与 `perf_system_window`；属性数不超 20且符合白名单；无旧事件名      | e2e            | [x] 通过；[e2e][prt-e2e]                                   |
| PRT-024 | Windows，PERF-RES-01 场景                                                                                            | 跨过一个采样周期                 | 原断言保留；runtime log 不含 powershell                                                                                                 | e2e（Windows） | [ ] macOS 按条件跳过，待 Windows；[windows][prt-windows]   |
| PRT-025 | 旧格式 CLI 样本（无新字段）                                                                                          | services 解析                    | 通过校验并分发                                                                                                                          | unit           | [x] 通过；[compat][prt-compat]                             |
| PRT-026 | 三个事件的属性 key                                                                                                   | 白名单校验                       | 无隐私 key；spec / 事件字典属性表与代码白名单逐项一致                                                                                   | unit           | [x] 通过；[contract][prt-contract]                         |
| PRT-027 | 远端 workspace 的 service collection（Agent service 为远端 zcode-server 的 RPC 代理）                                | Host 建立远端连接                | 注册了资源遥测订阅，CLI 样本与 MCP 事件都以 `runtimeSurface=remote` 送 main                                                             | unit           | [x] 通过；[remote][prt-remote]                             |
| PRT-028 | 同一份远端 collection 上再建立 `web-remote-replayable` attachment                                                    | attach 手机远控                  | attachment 侧订阅资源样本得到空事件，底层订阅数不变，转发给 main 的仍只有 Host 那一条                                                   | unit           | [x] 通过；[remote][prt-remote]                             |
| PRT-029 | 已订阅的远端连接                                                                                                     | 释放 connection handle           | 两条订阅随之释放（重复 dispose 幂等），后续样本不再转发；缺 Agent service 或单条订阅抛错时不订阅、不抛错                                | unit           | [x] 通过；[remote][prt-remote]                             |
| PRT-030 | 真实远端 workspace（SSH / WSL / Docker / Server）+ 开发态 1 分钟窗口                                                 | 连接后停留 90 秒                 | E2E 通道读到 `runtime_surface=remote` 的 `cli_chat` 事件，`platform` / `arch` 为远端机器的值；手机远控接入时不出现重复事件              | 手工           | [ ] 真实远端手工待补；仅订阅 UT 通过；[remote][prt-remote] |

[prt-desktop]: ../../packages/desktop/test/desktopResourceTelemetry.test.ts
[prt-system]: ../../packages/desktop/test/desktopResourceSystemWindow.test.ts
[prt-cli]: ../../packages/desktop/test/processResourceCliSource.test.ts
[prt-bash]: ../../apps/zcode-cli/packages/adapters/tests/bash-resource-telemetry.test.ts
[prt-probe]: ../../apps/zcode-cli/packages/adapters/tests/process-probe.test.ts
[prt-mcp]: ../../apps/zcode-cli/packages/adapters/tests/mcp-resource-telemetry.test.ts
[prt-legacy]: ../../packages/desktop/test/desktopMcpTelemetry.test.ts
[prt-host]: ../../packages/desktop/test/hostSelfResourceTelemetry.test.ts
[prt-renderer]: ../../packages/ui/test/memoryDiagnostics.test.ts
[prt-scheduler]: ../../packages/desktop/test/schedulerResourceTelemetry.test.ts
[prt-e2e]: ../../packages/desktop/test/e2e/resource-manager/telemetry/process-resource-telemetry-roles.test.ts
[prt-windows]: ../../packages/desktop/test/e2e/resource-manager/telemetry/windows-agent-metric-probe-absence.test.ts
[prt-compat]: ../../packages/services/test/zcodeAgentService.resourceTelemetry.test.ts
[prt-contract]: ../../packages/shared/test/processResourceTelemetry.test.ts
[prt-remote]: ../../packages/desktop/test/hostServiceResourceTelemetry.test.ts
[prt-guard]: ../../scripts/ci/ci-telemetry-keyword-guard.test.mjs
[prt-window]: ../../packages/desktop/test/processResourceWindowAggregator.test.ts

### 收口验证记录（2026-09-15）

- 受影响 UT：app / shared / services / renderer 29 文件、234 case；CLI adapters / bootstrap
  6 文件、51 case（含 macOS 真实 Node 子进程和 16.5 秒 Bash 资源烟测）；架构门禁 12 case。
  按本票用户要求未执行全量 UT。两个新增回归均已验证先失败后通过：PRT-026 文档缺属性表，
  以及全仓门禁漏枚举 CONTRACT.md。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e` 通过；`pnpm lint` 为
  0 error / 42 条存量 warning；修改文件格式检查通过。
- `pnpm architecture:check` 与 `pnpm architecture:check --changed` 通过，baseline / new 均为 0。
  门禁原本将磁盘上已存在的 `packages/services/src/storage/CONTRACT.md` 误报为缺失：文件枚举只收
  源码。现已纳入契约文档并排除文档的源码分析；真实缺失仍失败，未更新 baseline。
- `pnpm knip` 的存量问题仍使命令非零退出；对比任务起点，未使用值导出 707 → 704，类型导出
  915 → 914，无新增未使用导出。去掉 CLI 实例上限与系统 CPU 内部函数 / 类型的 export 前，
  已用全仓 `dep:refs` 确认无外部引用；保留采样实现。
- 生产源码中的三个旧事件名、hardware_profile、role_detail_sampled 均零命中；测试保留旧事件
  停发的负向断言。遥测关键字门禁通过（56 个受保护文件、2 个已登记豁免）。
- E2E：按用户最新要求仅运行受影响的 PRT-023 / PRT-024，命令退出码 0：PRT-023
  **1 passed（59.7s）**，PRT-024 **1 skipped**（macOS 平台条件，需 Windows 补验）。
  使用 `ZCODE_E2E_SPEC` 指定 `process-resource-telemetry-roles.test.ts` 与
  `windows-agent-metric-probe-absence.test.ts`；运行 ID：
  `desktop-e2e-20260915090553275-p30388-8c6c049d47706164`。先前全量尝试已按用户要求中止，
  套餐、后台会话等失败保留在对应产物中，不作为本票受影响验收结果，不继续扩大范围。
  PRT-030 需要真实远端 workspace，本机尚未执行；不能以订阅单测代替真实远端验收。
- code-review 双轴：Standards 0 项；Spec 复核发现的 4 处旧文档口径已修复，无遗留实现问题。
  清理仅收窄 desktop 模块内部导出；
  状态 owner、采样事件顺序、远端运行机隔离及 continuous / replayable 交付边界不变。

#### PRT-030 的手工验证方式（票 06）

1. 用 `pnpm dev:desktop` 起开发构建（开发态窗口是 1 分钟，不是 5 分钟）。
2. 连接一个真实远端 workspace（SSH / WSL / Docker / Server 任一），进入该 workspace 发一次对话，
   确认远端 zcode-cli 已拉起。
3. 停留 90 秒以上，让远端 CLI 至少自采一次（60 秒）并跨过一个上报窗口。
4. 读事件：E2E 环境用 `ReadFinalArmsCustomEventsE2E` 通道取 main 最终发出的自定义事件；
   手工联调直接看 main 的 ARMS 出口日志。筛 `perf_process_window` 且 `runtime_surface=remote`。
5. 断言：至少一条 `process_role=cli_chat`；`platform` / `arch` / `logical_cpu_count` /
   `total_memory_gb` 是远端机器的值而不是桌面机的值；同窗口本机角色（main / host / renderer_main）
   仍是 `runtime_surface=local`，两台机器的 RSS 没有被相加。
6. 关掉该远端 workspace（tab 关闭 → logical session 释放）后再等一个窗口：不再出现该远端机器的
   `cli_chat` 事件。**注意因果**：订阅是随 registry 释放 entry 一起收口的；只是网络掉线时事件也会停，
   但那是因为远端 CLI 已经不可达，不能用来证明订阅已释放——要验证释放必须走关闭 workspace 这条路径。
7. 混装场景：桌面端连接缺少 `capabilities.processResourceTelemetry` 的旧独立 Server，
   确认仍可使用业务 RPC、旧 Core 不退出，且没有资源事件订阅；再连接声明能力的 Server，
   确认四类遥测正常转发。真实旧版 Desktop E2E fixture 的缺口见修复验证文档。

**混装边界（R1 / N2 已修）**：此前 Host 对远端无条件订阅
`onDynamicProcessResourceSample`、`onDynamicMcpTelemetry`、`onDynamicMcpResourceSamples` 与
`onDynamicToolExecResource`。不仅早于前两项事件的旧版本有风险，基准 staging `26dcf8d27c`
也不具备本次新增的后两项，未知事件会经旧端 `ProxyChannel`、`ChannelServer` 和 WebSocket
读循环抛出，造成 Core 退出；桌面同步 try/catch 捕获不到对端异常。

当前 Host 在发出订阅前检查 `/api/server-info` 的可选能力字段；缺能力时跳过这组旁路事件并保留
正常连接，不按版本号猜测能力。两个 Server 实现均声明支持。本地及 Desktop 配套部署的
SSH/WSL/Docker 保留原订阅路径。旧 Server 的通用 RPC 未知事件行为并未被客户端更新改变，
但本遥测入口不再向不支持它的 Server 发送事件订阅。

## Out of Scope

- **`cua_helper` 角色**。Windows Helper 由 Host fork，运行的是 workspace 包 `packages/zcode-cua`
  构建出的 Helper runtime，自采需要改该包的 Helper 入口；macOS Helper.app 由 launchd 拉起，不在进程树里，
  Host 只能靠 `ps` 采。二期方案：Helper runtime 在已有 health 心跳中自报 CPU 与 RSS，零外部进程。
- 在 zcode-server 侧另起独立的 MCP / Bash 探针。远端 CLI 自己产生的资源事实沿既有 trusted Host relay 转发，已由 08 / 09 接线。
- Windows 上的 MCP CPU 与 Bash 进程树。方向是一个零外部进程的原生扩展（GetProcessMemoryInfo /
  GetProcessTimes），独立工程量。
- C、D、E、F 四类告警规则的配置（规则已在本文定义，等数据积累后配）。
- 资源管理器窗口及其 Windows CIM 采样。它由用户打开窗口触发，不是遥测，但与历史事故同类机制，
  建议单独评估替换为 tasklist。
- 稳定性事件（perf_crash、perf_anr、perf_process_exit 等）、数据目录体积事件、网络事件不变。
- 本地 `[memory]` 诊断日志的行格式与领域计数器不变。
- 手机远控与 Web 端不参与。
- ARMS 控制台自身的告警配置。

## Further Notes

- 计费按上报条数。设计原则为效果第一，在此基础上删除无意义上报，不设硬预算。
- 告警判定全部在自建平台完成，理由：阈值改动不需要发版；有价值的告警是群体判断；客户端判定逻辑本身会有
  bug 且漏报不可见。
- CPU 统计保留 p95 与 peak 两项，内存只保留 peak 与 mean：CPU 的危害来自持续高占用，单点尖峰是正常噪声，
  p95 过滤噪声而 peak 保留"是否出现过 100%"的诊断价值；内存的危害来自高水位，碰到一次 1.5 GB 就有
  OOM 风险，peak 是关键统计量，5 分钟内 p95 与 peak 几乎相等。
- Bash 15 秒门槛是采样策略而非异常判定：短命令没有采样机会也没有信息量。
- 与 [memory-diagnostics-log.md](./memory-diagnostics-log.md) 的关系：本地日志继续存在，但 host 与
  renderer 的采样源与本 spec 共用，CLI 已是共用形态，main 的 heap 读取并入同一 tick。
- 与 [zcode-data-size-arms-telemetry.md](./zcode-data-size-arms-telemetry.md) 的关系：数据目录体积事件
  沿用 `resolveResourceUsageScene` 判断后台，本 spec 保留该函数语义。

## 架构治理决策记录

```text
owner:            main 进程资源遥测模块（角色窗口、系统窗口、Bash 即时事件的唯一聚合与 ARMS 出口）；
                  各进程的自采瞬时事实由各自 sampler 持有；MCP pid ↔ mcp_id 映射只由 CLI tracker 持有
command path:     main 10s tick（getAppMetrics + os）→ 有界窗口 → 5min flush → sendCustom
                  renderer / host / scheduler 60s 自采 → IPC / parentPort → main ingest
                  CLI 60s 自采、5min MCP、Bash 完成 → protocol 通知 → Host 转发 → main ingest
derived views:    perf_process_window / perf_system_window / perf_tool_exec_resource；本地 [memory] 日志
                  与 ARMS 样本来自同一次读数
ordering:         窗口按 main 的 flush 时钟切分；晚到的自采样本进入当前窗口；退出 flush 不触发新采样
idempotency:      样本无副作用，丢失即丢失；无 outbox、无重试、无持久化
delivery:         desktop-only；不进入 session/event、V4 conversation frame、task realtime bus、
                  snapshot、queue、continuous 或 replayable 恢复链路；手机 /remote 不参与
performance:      main 零外部进程；全链路禁止 PowerShell/WMI/CIM/wmic；白名单探针仅 CLI 内 macOS ps
                  与 Windows tasklist，1s 超时，3 次失败停用；每进程一个 unref 定时器
reuse decision:   复用 getAppMetrics、进程角色 pid 注册表（collectChromiumProcessRolePids）、内存诊断日志定时器、CLI sampler、
                  Host 转发模块、FinalArmsCustomEvent E2E 控制器、PERF-RES-01 门禁；
                  资源管理器的 Host 侧 ps 采样器不复用（按需 UI 采样，职责不同）
contracts/spec:   本文；shared 协议 schema 与 host 响应 schema；performance-telemetry-catalog.md 事件字典
```
