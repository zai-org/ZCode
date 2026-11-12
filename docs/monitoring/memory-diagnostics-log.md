# 进程内存本地诊断日志

状态：**已确认，按本 spec 实现**

## CLI 分配诊断（3.18.1）

在下述 60 秒基础日志之外，CLI app-server 就绪后启用独立、有界的诊断记录。
目的是关联内存增长与发布代码位置，不改变任务调度、恢复或模型行为。

- CLI adapter 是采集和文件留存的唯一 owner。Bootstrap 只提供只读计数器并随 runtime 停止采集。
- 每 15 秒读取内存细分和只读计数，保留最近 8 个读数；只读会话数与 V4 容器大小，
  不调用会遍历历史事件的 `eventStore.getStats()`。完整事件统计保持原有 60 秒周期，
  不遍历消息正文、不重新序列化业务对象。
- 使用进程内 inspector Session，不开放调试端口，不读取脚本源码，不生成/加载 source map，
  不拍 heap snapshot，不主动 GC。分配采样间隔 1 MiB，栈深 16；每 60 秒重置采样窗口。
- 每 15 秒取样，最多检查 4096 个 profile 节点，只输出前 32 个分配热点及每个热点最后 8 层栈。
  profile 不是 retained-size/持有链，Buffer backing store 也未必反映在 JS profile 中，必须结合 external。
- 只保存发布 bundle 的函数名与从 0 开始的行列号。其他脚本不保存路径、函数名或源码。保存 bundle SHA-256、
  构建版本、Node/V8 版本、进程实例和 PID，便于在内部同版本产物上定位。
- 每轮最多一个采集/写盘操作，忙时丢本轮，不排队。单次同步采样/投影超过 25ms 或节点数超限，
  本进程永久降级为纯指标。采样异常同样降级；不得向任务抛错。启动和退出不等待磁盘采集。
  降级后的记录保留最后一次有效热点及其采集时间，避免纯指标轮转覆盖已有证据。
  堆使用达到上限的 80% 后同样降级，不在临近 OOM 时物化 profile。
  写盘在途而采样窗口到期时释放 profiler，慢磁盘不能导致采样状态无限积累。
- 所有 CLI 进程共用 `~/.zcode/cli/memory-diagnostics`：每个实例最多 2 个完成文件，全目录最多 16 个，每个 64 KiB，
  完成文件合计不超过 1 MiB。目录锁串行执行淘汰和写入，竞争只作短暂尝试后丢本轮。
  先淘汰再写，原子替换；锁内清理上次崩溃留下的临时文件，因此额外最多一个 64 KiB 临时文件。
  文件超过 7 天也淘汰。JSONL 不追加，不能随运行时长或进程重启无限增长。
- 反馈 full/compact 和手动日志导出都携带记录。反馈将此目录放在普通日志前，
  仅接受指定文件名和结构化数字/位置字段，不能因通用正文脱敏而整段丢弃 profile；
  不上传环境变量、对话、工具参数、配置或脚本内容。反馈未选择附带日志时，不打包或上传此目录。
- 远端 CLI 在远端记录；本机反馈不自动下载远端诊断。手机仍复用 Host，不增加重复采集器。

```text
app-server ready → adapter 分配采样 + 15s 指标 → 有界文件（目录锁唯一写入）
                        ↓ 60s 重置                    ↓
                   超预算只留指标           既有反馈/日志导出 → 结构化安全投影
runtime stop → 停表、断开 inspector；崩溃依赖此前已经写好的文件
```

验收：CLI 回归覆盖采样窗口重置、超预算降级、stop 后不再写入、慢写无排队、并发留存上限、
过期/临时文件清理和禁止数据字段；真实运行时验证压缩 bundle 的分配位置与 Buffer 的 external
增长；真实归档函数用合成记录验证 full/compact 携带、隐私过滤及总预算。执行同负载采样开关
交替对比，记录 CPU/耗时和单次采集成本；不以“低采样频率”代替性能证据。

本机验证（2026-11-11，macOS，随桌面端分发的 Node 24.21.0）：压缩且没有 source map 的
合成 bundle 成功记录分配位置和匹配的 SHA-256，单次检查耗时 13.8ms。8 次交替开关采样的
同负载测试中，耗时中位数为关闭 441.9ms、开启 446.6ms（约 +1.1%），CPU 中位数没有增加。
该短测试衡量分配采样成本，15 秒定时检查成本另行测量，不能外推为所有真实任务的性能保证。
8 个进程竞争写入 400 次后保留 14 个有效文件、合计 10,164 字节，无残留锁或临时文件。
真实反馈归档保留分配位置并剔除注入的正文与环境变量字段；Windows/Linux 运行时尚未验证。

## 问题

用户反馈桌面端内存持续增长时，拿到日志压缩包无法回答三个问题：哪个进程在涨、涨的是
JS heap 还是 native、哪张内存表在涨。现有 ARMS 资源遥测只有 RSS / working set 的 5 分钟聚合，
本地日志里不落任何数值；renderer 完全没有内存维度。全仓静态审计
（`docs/analysis/memory-leak-audit-2026-09-03.md`）列出的高危增长点分散在 main / renderer /
host / agent CLI 四类进程，必须先有运行时证据才能决定修哪一条。

本功能只解决**本机定位**：每个进程按门控规则往自己已有的本地日志写一行「heap 细分 +
领域计数器」。它不上报 ARMS、不改 ZCode Protocol schema、不新增 host→main 或 renderer→main
消息类型、不改任何业务逻辑。

## 产品合同

1. 四类进程各自采样自己的内存：main、renderer（每窗口）、utility_host（每窗口 Local Host）、
   agent_node（每 workspace 的 `zcode-cli`）。基础日志采样周期固定 `60_000ms`；agent_node 复用既有的
   `process/resourceSample` sampler 节拍。3.18.1 的分配诊断另用上述 15 秒定时器。
2. 采样与写盘分离。每次采样后按以下任一条件写盘，否则丢弃：
   - 首次采样（`reason=first`）；
   - `heapUsedKb` 相对**上一次写盘值**变化超过 `5%`，或 `rssKb` / `externalKb` 变化超过 `10%`，或任一领域计数器
     与上一次写盘值不同（`reason=changed`）；native / external 单独参与判定，因为真机上出现过 host RSS 从 240MB
     冲到 1.5GB 而 heap 几乎不动的情况；
   - 距上一次写盘已满 `300_000ms`（`reason=heartbeat`）。
3. 最坏情况每进程每分钟一行，空闲时每 5 分钟一行。按 8 个进程估算，全天约 3.4MB，
   占现有日志量约一成。
4. 日志行只包含数字与低基数枚举，不包含 pid、路径、workspace / session / task id、模型名、
   prompt 或文件内容。
5. 采样、计数器读取、格式化、写盘任一环节失败只丢当前样本，不重试、不排队、不影响业务。
6. 门控与格式化逻辑只有一份实现：`packages/shared/src/memoryDiagnostics.ts`，四类进程复用。

## 数据流

```text
 renderer(每窗口)                 host(每窗口)                    zcode-cli(每 workspace)
 60s: performance.memory          60s: process.memoryUsage()      60s sampler(已存在) onSample 内
      + ui 领域计数器                  + services 领域计数器             process.memoryUsage()
      │ logger.logMemoryDiagnostics    │ host logger.info                + server 领域计数器
      │ (绕过生产门控, 走 window.zcode.log) │ (既有 [host-log] 转发)          │ CLI logger.info
      v                                v                                 v
 ~/.zcode/v2/logs/YYYY-MM-DD.log  ←── main 60s: memoryUsage + 按角色 working set + main 计数器
                                                                ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl
```

- main / host / renderer 三类进程的行都落在 Desktop 主日志（host 经既有 `[host-log]` 转发，
  renderer 经既有 preload `window.zcode.log` 桥）。
- agent_node 写 CLI 自己的 JSONL 日志。远端 workspace 的 CLI 日志留在远端机器上；这是刻意的，
  资源样本不经协议新增字段。
- 日志导出（`exportLogs.ts`）与用户反馈压缩包（`prepareCompactLogArchive`）已覆盖上述文件，
  无需改动。

## 行格式

Desktop 侧（main / host / renderer）一行 `key=value`：

```text
[memory] role=main reason=changed rssKb=412300 heapUsedKb=91234 heapTotalKb=120000 externalKb=30211 arrayBuffersKb=2048 app.willDownloadListeners=3 app.windows=2 taskBus.leases=1 taskBus.sessionRoutes=14 taskBus.streamBatches=0 ws.chromium_other=120000 ws.gpu=88000 ws.host=380000 ws.main=412300 ws.renderer_main=910000 ...
```

- 固定字段顺序：`role`、`reason`、`rssKb`、`heapUsedKb`、`heapTotalKb`、`externalKb`、
  `arrayBuffersKb`，缺失的字段省略（renderer 没有 rss / external）。
- 计数器按 `<provider>.<key>` 命名，按字典序输出，值取整。
- 所有 KB 值取整。

CLI 侧写结构化日志：`event=zcode_protocol.process.memory_sample`，`module=bootstrap.zcode_protocol`，
`context` 里放 `reason`、五个内存字段和 `counters` 对象。

## 领域计数器

| role         | provider.key                                                                                                                              | 语义                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent_node   | `sessions`                                                                                                                                | 协议 server 常驻 session record 数                                                                                                                                                              |
| agent_node   | `eventRows`                                                                                                                               | 全部 record 的内存 event store 行数之和                                                                                                                                                         |
| agent_node   | `eventEvicted` / `eventTransientRetained`                                                                                                 | 按 turn 窗口策略累计淘汰的瞬态事件数 / 当前仍驻留的瞬态事件数（`apps/zcode-cli/docs/design/v2/session-event-store-retention.md`）                                                               |
| agent_node   | `v4.publishers` / `v4.detachedLive` / `v4.detachedTerminal` / `v4.rawSeqStates`                                                           | V4 gateway 的 publisher、detached 子 session、已终态待释放的 detached 子 session、raw seq 状态表大小                                                                                            |
| utility_host | `agent.sessionEmitters` / `agent.seqStates` / `agent.pendingPermissions` / `agent.pendingUserInputs`                                      | `zcodeAgentService` 的 per-session 镜像表                                                                                                                                                       |
| utility_host | `task.runtimeCommands` / `task.toolMemoryTasks` / `task.taskEmitters` / `task.overlays`                                                   | `zcodeTaskServiceAdapter` 的 per-task 表                                                                                                                                                        |
| utility_host | `terminal.open` / `fileWatcher.open`                                                                                                      | pty 与 `fs.watch` 实例数                                                                                                                                                                        |
| utility_host | `bots.streamSubs` / `bots.runningTasks` / `bots.typingIntervals` / `bots.liveStatusProgress`                                              | bots 的 per-task 状态                                                                                                                                                                           |
| main         | `app.windows` / `app.willDownloadListeners`                                                                                               | 窗口数、`defaultSession` 上的 `will-download` 监听数                                                                                                                                            |
| main         | `taskBus.streamBatches` / `taskBus.leases` / `taskBus.sessionRoutes`                                                                      | `TaskRealtimeBus` 三张表                                                                                                                                                                        |
| main         | `guest.tabs` / `guest.closedTabIds`                                                                                                       | `BrowserGuestManager`                                                                                                                                                                           |
| main         | `broadcast.claims` / `broadcast.processes`                                                                                                | `BroadcastHub`                                                                                                                                                                                  |
| main         | `ws.<process_role>`（`ws.main` / `ws.renderer_main` / `ws.renderer_guest` / `ws.gpu` / `ws.chromium_other` / `ws.host` / `ws.scheduler`） | `app.getAppMetrics()` 按 `process_role` 求和的 working set（KB）。角色词表与 ARMS `perf_process_window` 同源（`docs/monitoring/process-resource-telemetry.md`），只输出本 tick 有存活进程的角色 |
| renderer     | `shiki.tokensCache` / `shiki.highlighters`                                                                                                | 代码高亮 token 缓存条数                                                                                                                                                                         |
| renderer     | `taskSnapshotCache.entries` / `taskSnapshotCache.persisted`                                                                               | task snapshot 内存缓存与持久缓存条数                                                                                                                                                            |
| renderer     | `sessionStore.workspaces`                                                                                                                 | `zcodeSessionStore` 的 workspace 桶数                                                                                                                                                           |
| renderer     | `projection.stores` / `projection.rows`                                                                                                   | 存活的 V4 projection store 数与其 `rows.window` 行数之和                                                                                                                                        |
| renderer     | `xterm.sessions`                                                                                                                          | 常驻侧栏终端实例数                                                                                                                                                                              |
| renderer     | `taskQueryCache.queryKeys` / `taskQueryCache.taskMetas`                                                                                   | task 列表查询缓存条数                                                                                                                                                                           |
| renderer     | `toolLayout.openState`                                                                                                                    | 工具卡片展开状态表大小                                                                                                                                                                          |

新增计数器时在对应模块用 `registry.register(name, provider)` 自注册，provider 必须是纯读取
（只读 `Map.size` / `Set.size` / 数组长度），不得改状态、不得做 IO。

## 强制边界

- 不改 `zcodeProcessResourceSampleSchema`；协议样本仍只发 `rssKb` / CPU 字段。
- 不把内存样本接入 `session/event`、V4 conversation frame、task realtime bus、snapshot、
  queue、continuous 或 replayable 恢复链路；手机 `/remote` 不参与。
- renderer 通过 `packages/ui/src/logger.ts` 的 `logMemoryDiagnostics` 写入；它是
  `docs/performance/renderer-production-logging.md` 中"正式监控链路"例外，生产构建仍走桥，
  Web 端无桥时 no-op。UI 模块不得直接调用 `window.zcode.log`。
- main 不用 `ps` / PowerShell 补采其他进程；只用 `process.memoryUsage()` 与
  `app.getAppMetrics()`。
- CLI 的基础日志复用资源采样定时器；分配诊断独立持有一个 `unref()` 定时器，并随 runtime 停止。

## 如何看

```bash
# Desktop 主日志：按角色画 heapUsed 曲线
grep '\[memory\] role=renderer' ~/.zcode/v2/logs/2026-09-03.log \
  | sed -E 's/^\[([^]]+)\].*heapUsedKb=([0-9]+).*shiki\.tokensCache=([0-9]+).*/\1 \2 \3/'

# CLI 日志
grep memory_sample ~/.zcode/cli/log/zcode-2026-09-03.jsonl | jq -c '[.time, .context.heapUsedKb, .context.counters.eventRows]'
```

判读顺序：先看哪个 `role` 的 `heapUsedKb` 单调上升；再看同一行里哪个计数器同步上升；
`rssKb` 涨而 `heapUsedKb` 不涨说明是 native / ArrayBuffer 侧，看 `externalKb` /
`arrayBuffersKb`。

## 实现

> 采样源与 [全进程 CPU / 内存监控埋点](./process-resource-telemetry.md) 共用：host 与 renderer 的 60 秒定时器一次读数同时喂本地日志与 ARMS 样本，
> main 的 heap 读取并入资源遥测的 10 秒 tick（每 6 个 tick 一次），CLI 已是共用形态。
> 本文的门控与行格式不变；main 的 `ws.*` 计数器随资源遥测的角色分类器一起改用新的
> `process_role` 词表（`ws.renderer` → `ws.renderer_main` / `ws.renderer_guest`，
> `ws.utility_host` → `ws.host`，`ws.other` → `ws.chromium_other`，新增 `ws.scheduler`），
> 避免同一份分类逻辑在两处各留一套角色名。

- 共用：`packages/shared/src/memoryDiagnostics.ts`（`createMemorySampleWriteGate`、
  `formatMemorySampleLine`、`createMemoryDiagnosticsRegistry`、`memoryUsageToSampleFields`）
- CLI：`apps/zcode-cli/packages/bootstrap/src/process-resource-sampler.ts`、
  `zcode-protocol-entrypoint.ts`、`zcode-protocol/server.ts`、`zcode-protocol-v4/v4-gateway.ts`、
  `apps/zcode-cli/packages/adapters/src/storage/index.ts`
- services：`packages/services/src/memoryDiagnostics.ts` 与五个 service 的自注册
- host：`packages/desktop/src/host/hostMemoryDiagnosticsLog.ts`（门控与行格式）；
  host/index.ts 的入口是 `hostSelfResourceTelemetry.ts`，它包住本模块，把同一次 `memoryUsage()`
  读数同时交给资源遥测（`onMemoryUsage` 钩子与写盘门控无关：本地行可能被门控跳过，遥测样本每 60 秒都发）
- main：`packages/desktop/src/main/mainMemoryDiagnostics.ts`、`desktopResourceTelemetry.ts`
- renderer：`packages/ui/src/lib/memoryDiagnostics.ts`、`packages/ui/src/logger.ts`；
  采样器的 `reportHeapSample` 注入点在写盘门控之前，把同一次 `performance.memory` 读数经
  `IPlatformService.reportRendererHeapSample` 交给资源遥测（本地行可能被门控跳过，遥测样本每 60 秒
  都发；Web 端与手机远控没有桥即 no-op）

## 验收 Case

| Case ID | Setup                     | Action                  | Assertions                                                                                                                 | Layer |
| ------- | ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| MEM-001 | 空 gate                   | 首次 evaluate           | 返回 `first`                                                                                                               | unit  |
| MEM-002 | 上次 heap 100000          | heap 104000、计数器不变 | 返回 `null`                                                                                                                | unit  |
| MEM-003 | 上次 heap 100000          | heap 106000             | 返回 `changed`                                                                                                             | unit  |
| MEM-004 | 计数器某 key 变化         | evaluate                | 返回 `changed`                                                                                                             | unit  |
| MEM-005 | 全部不变                  | 满 300s                 | 返回 `heartbeat`，之后重新计时                                                                                             | unit  |
| MEM-006 | registry 有 provider 抛错 | collect                 | 其余 provider 正常返回，抛错者跳过                                                                                         | unit  |
| MEM-007 | CLI sampler               | 注入 readMemoryUsage    | onSample 第二参数为完整 memoryUsage，协议样本形状不变                                                                      | unit  |
| MEM-008 | host 60s tick             | 推进 timer              | logger.info 一行含 `role=utility_host heapUsedKb=`；stop 后不再输出；同一次读数同时经 parentPort 发出 `HostResourceSample` | unit  |
| MEM-009 | main 6 个 10s tick        | 推进 timer              | logger.info 一行含 `role=main` 与 `ws.<process_role>=`；同一次读数同时作为 `perf_process_window` 的 main heap 样本         | unit  |
| MEM-010 | renderer 生产构建         | `logMemoryDiagnostics`  | 仍调用桥；无桥 no-op                                                                                                       | unit  |
| MEM-011 | renderer 60s tick         | 推进 timer              | 同一次读数既经 preload 桥发出 heap 样本，又按门控写本地行；门控跳过写盘的 tick 仍发样本；桥抛错不影响本地行                | unit  |
