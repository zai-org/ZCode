# 全局数据库启动：实施复审

日期：2026-09-14。分支：`codex/fix-database-migration-startup`。
范围与恢复规则见 [spec](./database-migration-startup-gate-plan.md)，执行清单见 [Todo 145](../working-memory/provider-refactor/steps/todo-145-global-database-startup-loading.md)。

## 已实现

- Host 单 attempt 协调器；独立 Main/preload 控制和快照通道；Renderer 在业务 Root 外展示真实阶段、耗时、错误、复制诊断、导出日志和退出。无自动迁移重试。
- Host 所属 Worker 串行准备 tasks-index 的原迁移/原 Repo 后置修复，再以配套 CLI bundle 的存储专用入口准备会话库。两者都随 Host 退出；不启动完整 Provider/MCP/业务 Agent。
- 服务装配成功才发布 ready；Main scheduler 延迟启动，准备期间附着请求排队。业务 Repo 新连接仍校验真实账本，不能只相信进程内已准备路径。
- 原 SQL、migration ID、checksum 输入和单库事务边界保留；原始异常不会被 rollback/close 的第二个异常覆盖。
- Host 异步 statfs 每 2 秒、至多一个查询在途，汇总观测可用空间下降峰值；失败沿用缓存，缺基线不报 0，各 scope 不相加。
- ARMS 阶段/终态耗时、安全错误和磁盘摘要；沿 SDK reporter 原请求检查 HTTP 返回，明确失败最多 3 次，15 秒未确认不复制仍在途请求。

## 本次复审修正

1. 独立 CLI 子进程可能在 Host 异常退出后残留，改为 Host 所属 Worker；真实 bundle 验证虚拟 stdio 和相对 sessionDbPath。
2. Main 启动 relay 的 import 必须位于早期数据目录、Chromium 配置及 ARMS bootstrap 之后，避免读取旧路径。
3. 服务装配失败禁止原地重复创建服务，提示退出重开；数据库失败仍可手动重试并读取实际账本。
4. Host 退出尚无首状态时也生成失败快照；reload 补快照，旧序号与并发/旧 attempt 重试被拒绝。
5. Worker 完成后关闭 SQLite 连接再发布完成；准备结果交接仍验证账本，换空文件不能假 ready。
6. Node SQLite 在 Worker bundle 中沿既有 createRequire 方式加载，避免构建器改写为不存在的 npm sqlite。

## 验证记录

- 根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；Lint 有警告但无错误，架构无新增违规。
- CLI 子 workspace 的 `pnpm typecheck` 因本环境缺 turbo 未启动；改用 tsc 顺序检查 adapters、bootstrap、cli，通过。
- tsup（含任务库 Worker）、CLI `build.mjs --desktop-agent`、Vite renderer 构建通过。
- 原迁移差分/回滚/锁/崩溃/Reader 套件 7 文件 56 用例通过；随后涉及首因保留的增量 3 文件 12 用例通过。
- 最终全量：1710 文件通过、2 文件失败、2 跳过；14996 用例通过、2 失败、26 跳过。两项失败是未修改的 provider-node 文件监听和 CUA socket 时序断言，单独重跑 2 文件 38 用例全部通过，首轮全量这两项也通过；保留偶发失败记录，不声称全量命令全绿。本次新增启动用例全部通过。首轮 3 个旧 mock/返回值适配问题已修正并回归。
- Node 直接运行最终 tasks Worker 和 CLI bundle Worker：任务账本 3 项；会话相对路径落到传入真实 cwd，完成帧晚于关闭，均退出 0。探针只操作隔离临时目录。
- 额外 main/preload/renderer 分项目 tsc 仍失败：存在 rootDir/shared 导入、浏览器类型、Window.zcode 与 CSS 声明等错误；未将其计为通过。新增协调/采样/遥测文件没有该检查诊断。

测试入口：desktop 的 databaseStartup / databaseStartupDisk / databaseStartupRelay / databaseStartupTelemetry / hostDatabaseStartup / storagePreparationProtocol / storagePreparationWorker / startupTelemetryDelivery；services 的 tasksStartupPreparation / zcodeStorageStartupGate；UI 的 globalDatabaseStartupLoading。

## 尚未通过的发布验收

- Electron GUI：隔离最小 BrowserWindow 也在创建窗口前退出 133（Trace/breakpoint trap）；WDIO 返回 `session not created: Chrome instance exited`。新用例保持 manual-review/pending，不宣称 GUI 已通过。日志 `/tmp/zcode-global-startup-e2e.log`；报告 `packages/desktop/.e2e-artifacts/desktop-e2e-20260914-144856-843/summary.md`。
- Windows/macOS 打包 Worker、主题/窗口交互、手机 shared-host 和远端真实回归尚未执行；Node Worker 测试不能替代这些平台结果。手机准备时继续既有连接状态，未新增手机数据库阶段页面。
- ARMS 实际后台入库未发送生产事件验证；HTTP 接收确认不等于后台可查询。无跨重启 outbox / 周期 checkpoint；整应用强杀、离线、SDK 禁用可能丢终态。
- 不做 20 GB 性能承诺，不减少原迁移峰值资源需求；未对真实用户数据库执行测试。
- codegraph 工具不可用：未执行自动影响面扫描，使用受控 context 与人工源码审查；不声称全量静态调用图证明。

日志保留于本机 `/tmp/zcode-global-startup-*`；本文件记录可审查结论，临时日志不会入库。合并/发布前需补齐上述 GUI 与目标平台验收。

## 提交状态

代码与文档保留在工作区。仓库要求交互改动 E2E 通过后才能提交；本次 GUI 环境阻塞，因此尚未创建提交或推送更新。没有绕过验证钩子，也没有把 pending 用例标为通过。

## 2026-09-15 两处 review 问题修复

1. 修复旧 Host 的 ready 重放：Main 为 Host 分配的启动 ID 同时进入 InitLocal、Host 快照和本地 ServicePort；Renderer 两者同代才放行。新 Host 绑定撤销旧监听；退出后旧快照变为失联失败，旧代迟到消息不更新窗口。存活 Host reload 仍复用同一 ID。
2. 修复历史项目异常扩大为全局失败：普通 Agent 与准备入口共用异步 cwd 选择函数。ENOENT、ENOTDIR、EACCES、普通文件等按既有备用目录规则处理；无可用备用目录或自定义 command.cwd 不符合 fallback 条件则保留原路径。真实数据库错误仍失败，未改 SQL/checksum，也没有空库兜底。
3. 异步 cwd preflight 放在最终 admission/销毁/代际检查之前，避免目录探测期间退出后仍派生 Agent。仅桌面本地启动端口增加 ID；手机 scoped attachment、remote workspaceIdentity、continuous/replayable 语义不变。

验证：先运行新增回归，旧实现失败；修复后将端口到达顺序与跨代用例分开加强，最终 8 文件 87 项全部通过（`/tmp/zcode-startup-fixes-verified-tests.log`）。根 typecheck、desktop typecheck:e2e、lint（45 warnings / 0 errors）、architecture（0 violations）、tsup 和 Vite 构建通过。额外 Main/preload/renderer tsc 仍有此前的基线问题（已对比 9 月 14 日日志），不计通过；新增 ID/准入/cwd 文件未产生诊断。

新增 GLOBALDB-27/28 E2E 已进入原 pending spec。实际 WDIO 执行在用例前失败：`session not created: Chrome instance exited`；不加载项目的最小 Electron BrowserWindow 同样以 SIGTRAP 退出。报告：`packages/desktop/.e2e-artifacts/desktop-e2e-20260915-030844-230/summary.md`；日志 `/tmp/zcode-startup-fixes-e2e.log`、`/tmp/zcode-startup-fixes-minimal-electron.log`。不把环境失败标成 GUI 验收通过。

本轮继续遵守交互 E2E 通过后提交的要求，修复保留在工作区，未提交/推送。

## 2026-09-15 再次复审与交付

- 只读复审后，相关 12 个测试文件 35 项通过，日志 `/tmp/zcode-startup-second-review-tests.log`。
- 隔离事件探针确认两个未处理边界：Host 绑定前退出按钮没有监听器接收；迁移期间窗口关闭会解除 Host 终态遥测监听，漏报本次中断与缓存磁盘摘要。尚未复现实际 fork 创建失败，不能把按钮接收探针视为进程创建故障证据。正常启动早期、Host 尚未创建的窗口期同样没有退出接收方。
- 2026-09-15 用户明确要求按当前代码提交、推送并提供 MR 链接，本次按此授权交付，保留上述边界问题，不扩大实现范围。之前“未提交/推送”的记录描述当时状态；本次交付后以 Git 和 MR 为准。
- MR 保持 Draft；Electron GUI 环境阻塞、目标系统打包与手机远控实测、ARMS 后台入库验证仍未完成，不标为通过。正常执行提交与推送钩子，不绕过校验。

## 2026-09-15 Todo 146：按真实迁移需求静默启动

执行细节与验证记录见 [Todo 146](../working-memory/provider-refactor/steps/todo-146-silent-database-startup.md)。执行端只读预检账本并上报 kind / executedCount / committedCount，Host 按数据库聚合、本次重试清空；Renderer 从事实派生显示，阶段名称不直接触发升级文字。

- 无待执行项（或尚未确认）全程只保留 Logo；不挂正文计时器，也不因进入原维护/服务装配显示文字。错误仍有提示与既有手动恢复入口。
- 确认需求后保持初始化/升级提示；中间库提交和维护不宣告全局保存/完成；最后数据库真实提交时可显示保存，最终就绪/服务装配显示完成启动。阶段太快会自然略过，不做人为延迟或百分比。
- 单次 Host 准备复用已成功关闭的真实会话库路径，重试/新 Host 不复用；旧 Host 的 ready 与端口必须同代的约束保留。
- ARMS 增加迁移需求种类及执行/提交数，失败保留已知事实；不增加采样或网络周期任务。无迁移不等于零 IO 或无需等锁。
- 冻结 SQL、checksum 输入、迁移 ID 和单库事务边界未改。代码复审与运行测试完成；GUI 环境仍在进入用例前失败，发布前继续补目标平台、GUI 与手机链路验证。
