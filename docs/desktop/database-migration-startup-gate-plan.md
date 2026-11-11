# 进入 ZCode 前统一准备数据库

状态：2026-09-14 已实现，完成代码复审；自动化验证和平台限制见 [实施复审](./database-startup-implementation-review.md)。执行与验收清单见 [Todo 145](../working-memory/provider-refactor/steps/todo-145-global-database-startup-loading.md)。

## 目标和冻结边界

桌面窗口先显示独立启动页，本地必需数据库及服务装配完成后才挂载业务 Root。新用户没有工作区也执行。原迁移 ID、SQL、checksum、执行顺序、事务及账本不变；不增加 batch、索引、清理、空库兜底或 SQL 优化。Provider 读失败保护保留。

## 启动依赖和所有权

```text
Main 创建窗口 + window-scoped Host
  ├─ Renderer 独立启动页 ← Main 透传 ← Host 启动状态快照
  └─ Host 准备协调器（每窗口一个，单个在途 attempt）
       → 解析真实数据路径
       → Host Worker：tasks-index.sqlite 原迁移 + 必需 Repo 初始化
       → Host 所属 Worker 加载配套 CLI 存储命令：原 db.sqlite 迁移，关闭后退出
       → createLocalServices / 发布服务端口
       → ready → Renderer 挂载业务 Root；Main 启动既有 scheduler
失败 → failed → 停留错误页 → 用户点击重试 → 新 attempt / 重读账本
```

Host 是启动状态和重试的唯一所有者；SQLite 账本是持久化完成事实。Main 只保存可丢弃的通知镜像、透传控制消息、记录遥测和调度进程。状态通过独立 IPC 控制面建立，不能依赖普通服务已发布。Renderer reload 读取当前快照，不重新启动迁移。服务端口早到时保留，ready 前不构建业务服务消费者。

覆盖清单：TaskIndexRepo、AutomationRepo、OffPeakTaskRepo 共用真实 `getTasksIndexDatabasePath()`；Worker 串行完成原迁移及 TaskIndexRepo 的历史 ID/分组修复、OffPeak 遗留状态修复，再释放连接。Host 中 Repo 仅复用当前启动已完成的路径准备结果，不新增持久化标记；路径变化重新走原准备入口。Worker 内 SQL 与业务 Repo 共用实现。

会话库由 Agent 的 `createConfig` / `getSessionDbPath` 解析，存储专用入口在 Provider Registry、登录、MCP、遥测及业务 runtime 之前返回。执行 cwd 是已有实际目录，不创建/绑定虚构 workspace。相对 `sessionDbPath` 按 Main 提供的本地启动恢复/预热目录（最多三个）逐一解析和准备；无目录时使用真实 fallback cwd。目录去重，短生命周期 Worker 串行，避免同时迁移多个大库。之后新增的不同物理库仍受正常 Agent 协议准入保护。私有准备协议先公布解析后的路径供 Host 采样；路径不进入 ARMS。正常 Agent 仍保留按实际物理库的协议准入，覆盖之后更换配置或新增库。

Host 同步 SQLite 放在所属 Worker，Host 事件循环可持续采样和应答。Main scheduler 延后至本地准备成功，避免抢先迁移同库。Host 必需服务装配成功前不发布正常 RPC；预热、bot、Wiki 和 scheduler 不提前访问未准备库。

远端 SSH/WSL/Docker 不成为本地启动前置条件；连接时沿用远端 Agent 存储准入。手机继续附着既有 shared-host，不另起 Host/runtime；保留 workspaceIdentity、desktop continuous 和手机 replayable 边界。准备期间的端口 attachment 等待既有 Host 就绪。

## 状态、失败与重试

阶段：`starting → preparing_host_storage → preparing_session_storage → starting_services → ready`，任意阶段可进入 failed。数据库子阶段 checking / waiting_for_lock / migrating / committing。状态携带启动/attempt ID、单调序号、开始时间、阶段、标准错误及诊断 ID；快照和事件同源。

**迁移失败后绝不自动重试。** 用户先看到原因和处理建议，点击“重试”才启动下一次准备；运行中的重复点击、旧 attempt 的请求和迟到通知不得建立第二个执行者。已成功提交的库不回退，失败库依 SQLite 事务恢复并重新检查账本。原始异常优先于 rollback/close/通知异常，不能承诺整个多库启动原子回滚。checksum 不匹配/坏库需要诊断处理，不鼓励重复点击。若数据库已准备好、失败发生在服务装配阶段，则提示退出重开：不在可能已部分装配的 Host 中再次构造服务，避免重复后台副作用。

启动首状态预算 30 秒；外部写锁最多等待 60 分钟，业务 busy timeout 仍为 5 秒。不为长 SQL 设自动杀进程/跳过超时。10 分钟仅显示等待提示。执行者异常退出或状态通道断开可观察为失败；用户退出仍使用既有窗口/Host 清理，不另起迁移。

错误分类检查原始 cause 的结构化码及 SQLite primary code（`errcode & 0xff`）：FULL/ENOSPC/EDQUOT、权限、IOERR、CANTOPEN、NOMEM、坏库、checksum、锁超时及未知退出。错误文本不用于推断磁盘满或 OOM。FULL 可以来自临时盘或容量上限，不能因主库盘尚有空间否定它。

空间不足提示：**存储空间不足或已达到容量限制，无法完成数据更新。请检查数据目录及系统临时目录所在磁盘的可用空间，释放空间或调整存储额度后重试。** 失败页提供诊断 ID、复制诊断、导出日志、手动重试（适用时）、退出。复制内容不含 Key/账号/聊天正文。启动页复用主题、国际化及响应式规范，无假百分比。

导出日志复用 Help 菜单的同一导出链路（`packages/desktop/src/main/exportLogs.ts`），只依赖 Main 进程，不要求 Host 或 Agent 已就绪，因此迁移阶段失败时仍可打包日志。导出成功后由 Main 在文件管理器中定位 zip；失败时失败页内联提示，不退出启动页、不触发重试。按钮只在失败页出现，导出过程中禁用，避免重复打包。

## 磁盘观测和 ARMS

沿用 Todo 145 §9 的合同。每个可靠识别的存储 scope 记录 `max(0, baselineAvailable - minObservedAvailable)`；名称明确为观测可用空间下降峰值，并非迁移独占物理字节。默认每 2 秒一次异步 statfs，同一时刻最多一个查询，慢查询跳过不排队；不遍历目录、不读 DB 内容、不记录逐样本数组或磁盘日志。SQL Worker 与采样隔离。

基线必须早于写入才可计算全程峰值；晚到/失败标为 partial 或 unknown，未知值不填 0。相同 scope 共用基线，多 scope 不相加；回滚后保留历史最小余量，终态使用缓存，不依赖故障盘再次可读。

Host 向 Main 发送有限的聚合快照，Main 持有最新摘要，执行者崩溃也可报告已观测值。ARMS 只发送开始、阶段、终态及终态磁盘摘要；本版不发送周期网络 checkpoint，也不实现跨重启 outbox；整应用中途被杀可能缺少终态。记录 attempt、耗时、状态、统一错误、采样质量/陈旧度；不发送路径、消息、Key、全部采样。

**上报的有限重试与数据库重试完全分开。** 发送结果区分 SDK 入队、HTTP 接收确认和后台可查询。HTTP 非成功、网络异常/超时可有限退避，稳定 event ID 便于去重；上报故障不阻塞启动或错误页。若实现跨重启摘要，终态 outbox 上限 64 KiB/7 天，满盘写失败走内存。不承诺离线、满盘和整个应用同时被强杀时 100% 送达。

## 验证和交付

先写测试再实现，隔离临时数据库，不使用真实用户库，不测 20 GB 性能。GLOBALDB-01 至 26 见 Todo 145；新 UI 用例进入 manual-review/pending，不擅自晋级。必须验证冻结迁移兼容、新/老/已迁移库、手动重试、首状态缺失、锁/提交/清理失败、磁盘采样缺失、SDK 失败、reload、服务准入及进程资源清理。

执行 architecture check、typecheck、lint、受影响单测、桌面构建及启动 E2E。开发后再 review 实际 diff、跨端边界及资源/错误路径。未运行或环境阻塞的验证明确记录，旧测试通过不能代表新启动体验已验收。

## 实施中的边界澄清

- 启动专用 Repo 连接在 Worker 内等待外部写锁，迁移后修复也使用启动等待预算；准备后关闭连接，业务 Repo 的 5 秒策略不变。
- `http_received` 仅表示 SDK 原请求返回 HTTP 成功。当前 SDK 不提供 AbortSignal；单请求 15 秒未完成记未确认，不叠加新连接。明确失败/HTTP 非成功最多尝试三次。此版本不实现跨重启 outbox，离线或整个应用被杀仍可能只有开始事件；不宣称必达。
- 未取得基线的磁盘摘要使用单独的 unavailable 事件，不以 0 混入峰值分布。

- 生命周期复审修正：会话准备也由 Host 所属 Worker 加载配套 CLI bundle 的存储专用入口（虚拟 stdio 控制帧）。不启动独立持锁子进程，Host 被杀时线程随进程一起结束。普通业务 Agent 的子进程生命周期不变。CLI 存储模式不改 Host 进程名，显式传入 cwd 解析相对库路径。

## 2026-09-15：Host 代际和失效项目目录修复

- Main 为每个新 window-scoped Host 分配唯一 databaseStartupId，作为 Host coordinator 的 startupId，同时放进初次及 reload 的本地 ServicePort 消息。它只标识进程代次，不代替数据库账本、workspaceIdentity 或 task owner。
- 每窗口只有一个有效启动 relay；新 Host 绑定时撤销旧 relay 的控制监听。旧 Host 退出后将镜像改成 transport_closed，不能重放 ready；旧代迟到状态不更新当前窗口。失败镜像仍可供当前窗口刷新读取。
- Renderer 必须同时拿到相同 startupId 的 ready 和服务端口才挂业务 Root；状态先到/端口先到均可，缺 ID 或跨代不放行。reload 复用存活 Host 的 ID，不重新执行迁移。手机 scoped attachment 和 remote replayable 协议不改。

```text
Main 分配 B → InitLocal(B) → Host 的状态(B)
           └→ ServicePort(B)
Renderer：ready(B) + port(B) → Root
          ready(A) + port(B) → 继续等待
```

- 原 Agent 与全局准备共用异步工作目录选择：项目路径不存在、ENOTDIR、无权限或不是目录时，仅在原备用目录可用时采用备用目录；自定义 command.cwd 不属于默认 workspace fallback 的场景仍保留原行为。
- 这只处理执行 cwd；数据库打开、配置读取、磁盘满和数据库权限错误继续失败，不能切换数据库或创建空库兜底。新增异步 preflight 后在真正 spawn 前复查取消/销毁/代际。
- 回归：旧 Host ready 后退出/重建、旧代迟到消息、两种到达顺序、存活 Host reload、端口缺 ID；真实 ENOTDIR、普通文件、EACCES 注入、备用目录不可用、实际 SQL 错误仍失败。E2E 追加 GLOBALDB-27/28，保持 pending。

## 2026-09-15：无待迁移项时静默启动（Todo 146）

本节取代旧的“准备阶段均展示文案”规则。详见 [Todo 146](../working-memory/provider-refactor/steps/todo-146-silent-database-startup.md)。正常启动仅 Logo；确认存在待执行 migration 后才展示初始化/升级、保存、完成启动文字。失败始终显示。维护不再报告 migrating；空检查事务不显示升级结果。Host 聚合执行端的迁移种类、实际执行与提交数量，Renderer 与 ARMS 消费同源事实。SQLite 预检仅用于显示，拿写锁后重查账本，原 SQL/ID/checksum/事务边界不变。本次成功会话库按真实路径复用，失败与新 attempt 不复用。静默不等于跳过维护或保证零 IO。

## 2026-09-15：上报迁移前最后已应用编号

- 目标：与当前 `app_version`、已有失败 `migration_id` 联合定位迁移起点，不上传完整账本或 checksum。
- 执行端在 `BEGIN IMMEDIATE` 成功后、任何版本迁移 SQL 执行前，从小型账本按 ID 降序读取最后一项；冻结编号均以补零序号排序。新建账本为空记 `null`，未取得锁或未成功读取记字段缺失。后续提交/回滚不得覆盖这个起点。
- 可选 `migration.lastAppliedMigrationId` 通过现有严格启动协议传递。Host 为本次 attempt 保留每个已识别数据库的起点，任务库/会话库分别记录，失败保留、重试清空；不把各库起点塞入累计迁移统计。
- 在既有 `database_startup_result` 时机，额外按数据库发送一条 `database_startup_baseline`，value=1，属性为 `database_id`（已有内部标识/哈希）、`database_kind`（tasks-index/session）、`last_applied_migration_id`（编号/none/unknown）。事件 ID 包含数据库标识以区分同一 attempt 下不同库。首次上报后不重复；未识别出数据库的早期故障不伪造起点事件。
- 非法账本编号不上传原文，标记 unknown；真实读取故障沿原数据库异常路径处理。UI、磁盘采样、迁移 SQL/checksum/事务、手机 shared-host 和 continuous/replayable 边界均不变，无新增交互，现有 GUI E2E 不需修改。

```text
SQLite 拿锁 → 读取起点 → 原迁移/COMMIT 或失败
                  ↓              ↓
            原状态协议 → Host 按库保留 → Main 在准备结果时上报
```

验收：空库 none、旧库准确起点、重开为最新编号；另一写者先提交后读到其结果；执行失败保留迁移前编号；未知与无记录区分；多库不混淆、重复快照不重复上报、手动重试清空；原 SQL 和 checksum 不变。

验证记录：应用侧 7 文件 39 项、CLI 原迁移/异步锁/崩溃恢复/session-store 4 文件 60 项通过；root `pnpm typecheck`、`pnpm lint`（45 warnings / 0 errors）、architecture（0 violations）、CLI adapters/bootstrap tsc 与 adapters lint、桌面 tsup 通过。构建后的真实 tasks Worker 在隔离临时库验证：空库起点 null；只缺 0003 时起点 0002 且提交 1 项；再次打开起点 0003 且执行 0 项。没有修改 UI/E2E 交互，没有发送生产 ARMS 事件；后台入库仍待验证。日志在本机 `/tmp/zcode-migration-baseline-*.log`。

## 大表备份与恢复的内存边界（2026-10-27）

旧实现把 touchedTables 全部行保存在 JS 数组，再把排序后的行 JSON 合成一个字符串。多 GB 会话库可能先耗尽堆内存，增大堆后仍可能触发 V8 单字符串长度限制。备份、校验和恢复必须逐行处理，JS 内存只随最大单行增长，不能随表行数增长。

```text
原库 BEGIN IMMEDIATE → 锁内重读账本 → 逐行估算空间
  → 逐行复制到独立备份连接，同时计算行摘要
  → 临时 SQLite 文件排序摘要 → 增量计算表哈希 → 提交备份、写完成元数据
  → 原迁移 SQL → 原库 COMMIT
```

- 共享 sqlite-migrations 模块继续唯一持有备份与恢复逻辑；Host/CLI 不新增另一套执行器。历史 SQL、checksum、单事务和 touchedTables 范围不变，不按数据大小自动跳过备份。
- 新备份元数据 version=2。每行沿用整数、BLOB 的类型编码，计算行 JSON 的 SHA-256；将固定 32 字节摘要按二进制升序排列（保留重复行），再以 `sqlite-table-v2\0` 为前缀增量计算 SHA-256。排序由临时 SQLite 文件承担，限制页缓存并使用磁盘临时存储；不收集整表数据或整表字符串。
- 恢复同时接受 version=1/2，未知版本拒绝。旧版按原 JS UTF-16 字符串顺序做磁盘排序，再增量重现原外层 JSON 数组哈希，保持已有备份可用。旧版程序不支持读取新版备份；普通降级仍不消费迁移备份。
- 恢复期间持有备份库读事务，逐表校验后逐行写原库；保留外键关闭、防级联、原库单事务、恢复后行数/哈希/外键检查及失败回滚。未触及表不变。
- 保留原磁盘候选目录、空间不足处理和最近两份备份规则。数据库内存不足、损坏、校验失败仍按真实错误报告，不伪装成空间不足。
- 验收使用 CLI 独立回归：受限堆子进程处理总正文超过 V8 单字符串上限的数据，完成迁移备份、关闭重开和恢复；另验证 v1 Unicode/整数/BLOB 兼容、v2 行顺序无关与重复行、备份篡改拒绝和迁移失败回滚。GUI 交互与手机协议未改变。
