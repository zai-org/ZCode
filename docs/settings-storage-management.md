# 存储管理（Storage Management）规划

> Bash 输出优先写入系统 tmp，目录不可用时复用 `cli/exec`。本页统计仍仅覆盖现有 `.zcode` 数据根：
> tmp 输出暂不计入占用数字，也不增加清理入口；历史及降级的 `cli/exec` 继续归入工具输出与临时缓存。
> 文件读取和打开入口使用实际输出路径，不受统计范围影响。路径合同见 `tmpdir-storage-paths-spec.md`。

> 状态：**已实现（2026-09-10）**。裁决记录见 §8，实现落点见 §11。
> 位置：**资源管理器窗口 → 「存储」tab**（2026-09-10 裁决：从设置页「数据与统计」整体迁入资源管理器，与 CPU / 内存并列；设置页不再有入口）。窗口本身的架构见 `docs/electron/resource-manager.md`。

## 1. 背景与现状

### 1.1 用户诉求

打开分区后立即开始计算 ZCode 的磁盘占用，展示：

- 每块磁盘（卷）上 `.zcode` 占了多少空间；
- 每块磁盘里的数据按类别拆分（数据库、日志、轨迹……），每类可下钻看明细；
- 可清理的类别（如模型调用轨迹）提供清理动作。

### 1.2 历史包袱：数据根目录实际上有两个

App 允许设置「数据存储路径」（`setting.json.dataBaseDir`），但**只有 app 侧的 `v2` 跟着走**，agent 侧数据始终留在用户家目录。当前事实：

| 写入方                                         | 根目录解析                                                                                       | 是否跟随「数据存储路径」 | 代码                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------- |
| app services（host 进程）                      | `{dataBaseDir}/.zcode`，默认 `~/.zcode`                                                          | 是                       | `packages/services/src/paths.ts` `getZCodeDataRootDir()`                         |
| 「数据存储路径」切换时的迁移                   | 只复制 `.zcode/v2`，且是复制不是移动                                                             | —                        | `packages/services/src/paths.ts` `copyDataDirectory()`                           |
| zcode-cli（agent 进程）                        | `~/.zcode/cli/config.json` 的 `storage.dir`，默认 `~/.zcode`；app **不下发** `ZCODE_STORAGE_DIR` | 否                       | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:184`                    |
| 模型调用轨迹 model-io                          | 直接 `homedir()/.zcode/cli/{debug,rollout}`                                                      | 否（硬编码）             | `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` `getModelIOBaseDir` |
| hooks 信任库 / subagents / skills / commands   | 读 `~/.zcode/cli/config.json` 的 `storage.dir`                                                   | 否                       | `packages/services/src/hooks/hooksService.ts:153-173` 等                         |
| Computer Use Helper、日志导出对 cli 目录的引用 | `homedir()/.zcode/...`                                                                           | 否（硬编码）             | `packages/desktop/src/main/exportLogs.ts:34-48`                                  |
| `v2/setting.json` 本身                         | 永远写在真实 HOME（bootstrap 文件）                                                              | 刻意不跟随               | `packages/services/src/setting/settingService.ts:36-46`                          |
| GLM provider 的 workspace 配置目录             | `getDataBaseDir()/.zcode/cli/...`，与上面 CLI 读 `~/.zcode/cli` 两套口径并存                     | 是                       | `packages/services/src/paths.ts:295-299, 355-362`                                |
| 轨迹查看器读 model-io                          | 同时扫 `homedir()` 与 `dataBaseDir` 两处                                                         | 两处都读                 | `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts:16-22`             |

结论：存储管理必须同时扫描两个根：

```text
R1 = ~/.zcode                       （永远存在：cli/、agents/、computer-use/、旧 v2 副本……）
R2 = {dataBaseDir}/.zcode           （仅在设置了数据存储路径且 ≠ HOME 时存在：v2/、workspace/、export-log/、feedback/……）
```

本期只**如实展示**两个根，不修复分裂本身；是否让 CLI 跟随 `dataBaseDir` 是独立设计决策（见 §8）。注意现有 E2E `conversation-session-configurable-data-directory.test.ts` 明确断言「切换后 `{custom}/.zcode/cli` 不存在、`~/.zcode/cli/db/db.sqlite` 仍在」，即这是当前有意保留的产品边界。

### 1.3 真实机器目录普查（2026-09-10，开发机，总计 25 GB）

| 路径                                                                                                                                                                    | 大小     | 写入方 / 用途                                                   | 分类                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- | ----------------------------------------- |
| `cli/db/backup`, `cli/db/backups`, `cli/db/*.bak`, `cli/db/*.backup-*`                                                                                                  | ≈6 GB    | CLI 库迁移前备份                                                | 备份                                      |
| `cli/db/db.sqlite(+wal/shm)`                                                                                                                                            | 0.77 GB  | CLI 会话/任务库（在用）                                         | 会话记录与数据库                          |
| `backup/*`（session-projects、before-\*-restore…）                                                                                                                      | 7.2 GB   | 脚本/迁移备份，含 cli-db 与 v2 全量副本                         | 备份                                      |
| `v2/dev/stdio-traffic`                                                                                                                                                  | 2.4 GB   | 开发态 stdio 协议抓包（`zcodeStdioTapDevConfig.ts`）            | 开发诊断抓包                              |
| `v2/migrations`, `v2/backup`, `v2/*.bak`, `v2/setting.json.corrupt-*`, `v2/config.json.pre-*`                                                                           | ≈0.8 GB  | 迁移前快照 / 损坏文件留档                                       | 备份                                      |
| `v2/acp-config`, `v2/acp-traffic-proxy`, `v2/acp-auth`                                                                                                                  | ≈0.8 GB  | 已退役的 ACP runtime 目录（exportLogs 已按退役目录跳过）        | 开发诊断抓包 / 配置                       |
| `cli/debug`（开发态）、`cli/rollout`（生产态）                                                                                                                          | 1.35 GB  | 模型调用轨迹 model-io JSONL                                     | 模型调用轨迹                              |
| `cli/agents/sess_*`                                                                                                                                                     | 0.94 GB  | subagent 运行产物                                               | 工具输出与子代理产物                      |
| `cli/exec`                                                                                                                                                              | 0.65 GB  | Bash 工具持久化输出（tmpdir 收口规范）                          | 命令输出与临时缓存                        |
| `cli/plugins/{cache,data,marketplaces}`                                                                                                                                 | 0.62 GB  | 插件缓存与数据                                                  | Agent 运行时与插件                        |
| `cli/artifacts`, `cli/image-cache`                                                                                                                                      | 0.64 GB  | 工具结果留档、图片缓存                                          | 工具输出与子代理产物 / 命令输出与临时缓存 |
| `lite/releases/*`, `bundled-agents/*.tgz`, `agents/{claude-code,opencode,codex,gemini-cli}`, `computer-use/*`                                                           | ≈2.2 GB  | CLI 运行时发布包、内置外部 agent、CUA Helper app                | Agent 运行时与插件                        |
| `export-log`, `export-log-stage`, `feedback`                                                                                                                            | ≈1 GB    | 日志导出结果 / 异常残留的 staging / 反馈包                      | 导出与反馈包                              |
| `v2/logs`, `cli/log`, `logs`, `agent/logs`, `v2/crash`                                                                                                                  | ≈0.15 GB | app 日志（14 天轮转）、CLI 日志（7 天轮转）、旧版日志、崩溃捕获 | 日志与崩溃报告                            |
| `v2/sessions`, `v2/session-bindings`, `v2/checkpoints`, `agent/sessions`（旧版）                                                                                        | ≈0.2 GB  | 会话快照 / 绑定 / checkpoint（`agent/` 为旧版残留→其他）        | 会话记录与数据库                          |
| `v2/*.sqlite*`（tasks-index、automation、task-index）                                                                                                                   | ≈20 MB   | app 任务索引 / 自动化库（在用）                                 | 会话记录与数据库                          |
| `v2/*.json`, `cli/config.json`, `security`, `v2/certs`, `v2/provider`, `cli/models`, `cli/memories`, `cli/workflows`, `commands`, `skills`, `agents/*.md`, `workspace/` | 小       | 配置、凭据、记忆、默认对话工作区（含用户文件）                  | 配置、凭据与工作区                        |

普查结论：真正的大头是「备份」「开发诊断抓包」「模型调用轨迹」三类，占比 > 80%，都可清理。

#### 1.3.1 几个易混目录的核实结果

| 目录                               | 写入方                                                                                | 内容                                                                                                                                                                       | 是否被回读                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/artifacts/<sess>/`            | `apps/zcode-cli/packages/adapters/src/storage/index.ts` `createNodeToolArtifactStore` | **不是用户附件**。是工具结果留档：超长 Bash 输出（`.txt`）、Edit/Write 的修改前后快照与 structuredPatch（`.json`）、截图（`.png`），以 `zcode-artifact://<sess>/<id>` 引用 | 是：文件变更 checkpoint 汇总/回滚（`cold-file-change-summaries.ts`）、后续轮次引用历史媒体附件（`prompt-input.ts`）、UI 查看完整工具输出 |
| `cli/agents/<sess>/<agent>/`       | `apps/zcode-cli/packages/core/src/subagent/runner.ts`                                 | subagent 运行产物：`metadata.json`、`output.txt`、`task.output`、`transcript.jsonl`（单文件可达 64 MB）                                                                    | 仅 resume 进行中的 subagent 时按 `task.outputFile` 回读；已结束会话不再读                                                                |
| `cli/sessions/<sess>/workflows/`   | `script-workflow-tool-port.ts`                                                        | 会话内生成的 workflow 脚本                                                                                                                                                 | 会话内                                                                                                                                   |
| `v2/sessions/<hash>/<taskId>.json` | `packages/services/src/paths.ts` `getLegacyTaskSessionSnapshotPath`                   | 旧格式任务快照；**仍在用**：`readLegacyTaskSnapshot` 兜底读取，Claude 原生会话导入（`persistImportedClaudeTask.ts`）仍写入这里                                             | 是                                                                                                                                       |
| `agent/sessions/`、`agent/logs/`   | 当前代码无写入方（2026-04/05 的 ACP 时代残留）                                        | 旧版会话 JSON/JSONL                                                                                                                                                        | 否                                                                                                                                       |

## 2. 目标 / 非目标

目标：

- 新增设置分区「存储管理」，打开即异步扫描两个数据根，按磁盘（卷）汇总并按类别拆分，扫描过程中展示进度。
- 每个类别可下钻查看明细（子目录 / 文件、大小、所属根目录）。
- 对标记为可清理的类别提供清理动作，带确认与结果反馈。
- 分类规则是单一事实源（services 层 catalog），单测覆盖。

非目标：

- 不改变任何模块的写入路径，不修复「CLI 不跟随数据存储路径」（§8 单独立项）。
- 不做自动定时清理、不做配额告警（可后续基于同一 catalog 扩展）。
- 不清理 `.zcode` 之外的任何路径（例如 `~/.claude`、系统 TMPDIR）。
- 手机 `/remote` 与 Web 端首期不显示该分区（§6.3）。

## 3. 分类目录（catalog）

分类是 services 层的静态表 `storageCatalog.ts`：每条规则 = `{ categoryId, root?: "home" | "dataBaseDir", pattern(相对根的路径匹配), cleanable, protect?: [...] }`。匹配按**最长前缀优先**，未命中的条目归入「其他」。

| id                    | 名称               | 匹配路径（相对根）                                                                                                                                                                                                                                                                                                                                                                     | 可清理                                      | 清理规则                                                                                 |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `sessionStore`        | 会话记录与数据库   | `v2/*.sqlite{,-wal,-shm}`, `cli/db/db.sqlite{,-wal,-shm}`, `v2/sessions`, `v2/session-bindings`, `v2/checkpoints`（除 pending/tmp）                                                                                                                                                                                                                                                    | 否                                          | 走任务删除 / 自动归档，不在此处清理                                                      |
| `subagentTranscripts` | 子代理产物         | `cli/agents/<sess>/<agent>/transcript.jsonl`                                                                                                                                                                                                                                                                                                                                           | 是                                          | 只清理**最近 24 小时未更新**的会话目录（避免删掉进行中 subagent 的记录）；按会话目录聚合 |
| `toolOutputs`         | 工具输出与临时缓存 | `cli/artifacts`, `cli/agents`（除 transcript.jsonl）, `cli/sessions`, `cli/exec`, `cli/image-cache`, `cli/pdf-cache`, `clipboard`, `git-checkpoint-index`, `editor-icon`, `tmp`, `cache`, `v2/coding-plan-cache.json`, `v2/bots-model-cache*.json`, `v2/checkpoints/**/{pending,tmp}`                                                                                                  | 否（2026-09-10 裁决：暂不可删，待逐项确认） | —                                                                                        |
| `modelTrajectory`     | 模型调用轨迹       | `cli/debug`, `cli/rollout`                                                                                                                                                                                                                                                                                                                                                             | 是                                          | 删除全部 `model-io-*.jsonl`；正在写入的文件删除失败时计入 `failures`，不阻塞             |
| `devTraces`           | 开发诊断抓包       | `v2/dev`, `v2/acp-traffic-proxy`, `v2/acp-stream-diagnostics`                                                                                                                                                                                                                                                                                                                          | 是                                          | 删除目录内容；保留 `v2/dev/zcode-stdio-tap.json`（开关状态）                             |
| `logs`                | 日志与崩溃报告     | `v2/logs`, `cli/log`, `logs`, `agent/logs`, `v2/crash`, `v2/perf`, `feedback/logs`, `computer-use/run/*.log`                                                                                                                                                                                                                                                                           | 是                                          | 删除**非当天**日志文件；`v2/crash/live`、`computer-use/run/.tokens` 不删                 |
| `backups`             | 备份               | `backup`, `v2/backup`, `v2/migrations`, `cli/db/backup`, `cli/db/backups`, `cli/db/*.bak*`, `cli/db/*.backup-*`, `v2/*.bak`, `v2/*.backup.json`, `v2/setting.json.corrupt-*`, `v2/config.json.pre-*`, `cli/config.json.bak-*`                                                                                                                                                          | 是（需二次确认）                            | 全部删除                                                                                 |
| `exports`             | 导出与反馈包       | `export-log`, `export-log-stage`, `feedback`                                                                                                                                                                                                                                                                                                                                           | 是                                          | 全部删除                                                                                 |
| `runtimes`            | Agent 运行时与插件 | `agents/<runtime>/`, `bundled-agents`, `lite`, `computer-use`, `cli/plugins`（含 cache，2026-09-10 裁决不可删）                                                                                                                                                                                                                                                                        | 否                                          | 由安装 / 更新流程管理                                                                    |
| `config`              | 配置、凭据与工作区 | `v2/*.json`, `v2/agent-config`, `v2/bots-runtime-locks`, `v2/certs`, `v2/acp-auth`, `v2/acp-config`, `v2/provider`, `cli/config.json`, `cli/models`, `cli/memories`, `cli/workflows`, `security`, `commands`, `skills`, `agents/*.md`, `workspace`, `mailbox`, `server`, `controller`, `launcher`, `dev-signing`, `cua-helper-dev-identity`, `perf-task-manifests`, `plugin-workspace` | 否                                          | —                                                                                        |
| `other`               | 其他               | 未命中的路径；启用自定义数据路径后 `~/.zcode/v2` 整个旧副本；`agent/`（旧版残留）                                                                                                                                                                                                                                                                                                      | 否                                          | 下钻可见具体路径，便于后续补规则                                                         |

约束：

- `cleanable` 的规则只允许删除**规则自身匹配到的路径**，删除前再次用 `path.relative(root, target)` 校验不越界，且拒绝符号链接目标。
- 受保护文件白名单（`setting.json*`, `credentials.json`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `v2/dev/zcode-stdio-tap.json`）在任何类别里都不删除。
- catalog 与 `exportLogs.ts` 里已有的跳过列表（`RETIRED_ACP_RUNTIME_ARCHIVE_PATHS`、`HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS`、`NON_LOG_STATE_ARCHIVE_PATHS`）语义一致；后续可让 exportLogs 引用同一 catalog，本期不改 exportLogs。

## 4. 数据模型

```ts
// packages/services/src/storage/storage.ts
export type StorageRootId = "home" | "dataBaseDir";
export type StorageCategoryId =
  | "sessionStore"
  | "subagentTranscripts"
  | "toolOutputs"
  | "modelTrajectory"
  | "devTraces"
  | "logs"
  | "backups"
  | "exports"
  | "runtimes"
  | "config"
  | "other";
export type StorageCleanability = "none" | "safe" | "confirm";

export interface StorageVolume {
  /** 同一物理卷的稳定 key：stat().dev；同 dev 的根合并进同一张磁盘卡片 */
  deviceId: string;
  /** 向上遍历直到 dev 变化得到的挂载点：mac/Linux 为路径，Windows 为盘符 */
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageEntryUsage {
  relativePath: string; // 相对根目录
  bytes: number;
  fileCount: number;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  cleanability: StorageCleanability;
  entries: StorageEntryUsage[]; // 下钻明细：按规则匹配到的一级路径聚合
}

export interface StorageRootUsage {
  id: StorageRootId;
  path: string;
  volume: StorageVolume | null; // statfs 失败时为 null，仅展示占用不展示磁盘容量
  bytes: number;
  categories: StorageCategoryUsage[];
}

export interface StorageUsageSnapshot {
  jobId: string;
  status: "scanning" | "complete" | "cancelled" | "failed";
  startedAt: number;
  finishedAt?: number;
  roots: StorageRootUsage[];
  errors: Array<{ path: string; code: string }>; // EACCES/ENOENT 等，不中断扫描
}

export interface IStorageService {
  startScan(): Promise<{ jobId: string }>;
  cancelScan(jobId: string): Promise<void>;
  getSnapshot(jobId: string): Promise<StorageUsageSnapshot | null>;
  /** 进度事件：≥300ms 节流一次，payload 为增量后的完整 snapshot */
  onScanProgress(listener: (snapshot: StorageUsageSnapshot) => void): () => void;
  clean(params: { rootId: StorageRootId; categoryId: StorageCategoryId }): Promise<{
    freedBytes: number;
    deletedCount: number;
    failures: Array<{ path: string; code: string }>;
  }>;
}
export const IStorageService = createServiceDescriptor<IStorageService>("storage");
```

大小口径：`lstat().size` 求和，不跟随符号链接，硬链接/APFS clone 可能重复计数，UI 文案注明「估算值」。

复用：desktop 已有一个只用于遥测的递归大小扫描器（`packages/desktop/src/main/zcodeDataSizeScanner.ts`，Worker 内跑、不跟随符号链接，由 `desktopZCodeDataSizeTelemetry.ts` 调用）。本功能把它下沉到 services 层并扩展为「按 catalog 分类累加 + 进度回调 + 取消」，遥测改为调用同一实现，避免两份目录遍历逻辑。

RPC 接线沿用 `ISettingService` 的既有模式：`packages/shared/src/channels.ts` 增加 `ServiceChannels.Storage` → services 定义描述符与实现 → host collection（`packages/desktop/src/host/remoteConnectionServiceCollection.ts`）`.register` → `packages/client/src/remoteServiceAccess.ts` 增加代理并加进 `IServiceAccessor` → UI 通过 `useServices().storageService` 调用。

## 5. 时序与状态

```text
Renderer <StorageSection>                 Host StorageService                       FS
  │ 进入分区                                      │                                      │
  ├─ startScan() ───────────────────────────────▶│ 新建 job(jobId, AbortController)      │
  │                                              │ 解析根：R1=~/.zcode                    │
  │                                              │        R2={dataBaseDir}/.zcode (可选)  │
  │                                              │ 每根：stat dev → 向上找挂载点 → statfs ─▶│
  │                                              │ readdir(withFileTypes) 有界并发(8) ────▶│
  │◀─ onScanProgress(snapshot 节流 300ms) ────────┤ 逐条 lstat → catalog.classify → 累加   │
  │   UI: 「计算中…」+ 已累计数字实时跳动            │                                      │
  │◀─ onScanProgress(status=complete) ───────────┤                                      │
  │ 离开分区 ─ cancelScan(jobId) ────────────────▶│ abort → status=cancelled              │
  │                                              │                                      │
  │ 点「清理」→ 确认框(confirm 类) ─ clean() ─────▶│ 按 catalog 解析目标 → 越界/保护校验 ──▶│ rm
  │◀─ {freedBytes, failures} ────────────────────┤                                      │
  │ toast 结果 → 重新 startScan()                  │                                      │
```

状态约束：

- 同一时刻最多一个进行中的 job；再次 `startScan` 会先取消旧 job（用户点「重新计算」或重复进入分区）。
- 扫描/清理都在 host 进程执行，全部异步 `fs/promises`；禁止 `readdirSync`/`statSync`。
- 进度事件走既有服务事件通道（与 `IUsageStatsService` 等服务的事件订阅方式一致），UI 只消费 snapshot，不自己累加。
- 本功能只涉及本机磁盘，不进入 task realtime 链路，不触碰 `desktop-continuous` / `web-remote-replayable` 语义。

性能约束（裁决 Q7：实时刷新、性能优先）：

- 生命周期与分区绑定：进入「存储管理」才 `startScan`，切到其他分区 / 关闭设置页 / 窗口失焦超过 60s 立即 `cancelScan`；回来重新开始。不做后台常驻扫描。
- 遍历跑在 Worker 线程（复用 `zcodeDataSizeScanner.ts` 的 Worker 形态），host 主事件循环只收节流后的进度；Worker 内全部 `fs/promises`，`readdir({ withFileTypes: true })` 减少 stat 次数，目录级有界并发（默认 4，可配），每处理 N 个条目 `setImmediate` 让出一次。
- 取消用 `AbortSignal`，每进入一个目录检查一次；取消后 Worker 立即停止而不是跑完再丢弃。
- 进入分区时若内存里有上一次 `complete` 快照，先展示旧值再在后台重扫（stale-while-revalidate），避免每次进入都从 0 开始跳数字。
- 进度事件 ≥300ms 一次且只在数字变化时发；快照体积受控：`entries` 只聚合到规则命中的一级路径，不携带逐文件列表。
- 清理同样异步、有界并发删除，返回后 UI 重扫；清理过程中禁用其他清理按钮。

## 6. UI

### 6.1 布局（参考用户给的截图）

```text
┌─ 存储管理 ───────────────────────────────────────────────────────────────┐
│ 总占用 25.0 GB · 上次计算 12:03  [重新计算]                              │
│ ┌ 磁盘 Macintosh HD ───────────┐  ┌ 类别（当前选中磁盘）────────────────┐ │
│ │ ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇░░░░░░░ │  │ ▤ 备份             12.9 GB  [清理] › │ │
│ │ ZCode 占用 25.0 GB / 剩余 6.9 GB│  │ ▤ 开发诊断抓包      3.2 GB  [清理] › │ │
│ │ ● 备份             12.9 GB      │  │ ▤ 模型调用轨迹      1.4 GB  [清理] › │ │
│ │ ● 开发诊断抓包      3.2 GB      │  │ ▤ Agent 运行时与插件 2.2 GB         › │ │
│ │ ● 模型调用轨迹      1.4 GB      │  │ ▤ 会话与任务数据    1.8 GB         › │ │
│ │ ● …                            │  │ ▤ 日志与崩溃报告    0.15 GB [清理] › │ │
│ │ 根目录：~/.zcode (25.0 GB)      │  │ ▤ 数据库            0.8 GB         › │ │
│ └────────────────────────────────┘  │ ▤ 其他              …               › │ │
│ ┌ 磁盘 /Volumes/Data ───────────┐  └──────────────────────────────────────┘ │
│ │ …（仅当 R2 在另一块盘时出现）    │                                          │
│ └────────────────────────────────┘                                          │
└───────────────────────────────────────────────────────────────────────────┘
```

- 左列每块卷一张卡片（`bg-card border-card-border rounded-xl`）；进度条按类别着色，图例按大小降序；卡片底部列出该卷上的根目录及占用。多张卡片时点选切换右侧类别列表；只有一张时不显示选中态。
- 右列类别行：图标 + 名称 + 大小 + （可清理时）「清理」按钮 + `›`。点击进入明细视图（同分区内二级页，面包屑返回，复用插件详情的导航方式）：列出 `entries`，每行大小、所属根目录、「在文件管理器中显示」。
- 扫描中：总占用与各行数字随进度事件更新，右上角 `Loader2` 旋转；`errors` 非空时在底部以 caption 提示「部分目录无法读取」。
- 清理确认：`safe` 类直接执行 + toast；`confirm` 类弹 Dialog，正文说明后果（见 §3），主按钮红色 destructive 语义。
- 窄屏（< 900px）左右列改为上下堆叠；字体全部用 `text-ui-*`；深浅色主题、zh/en 文案齐全（i18n key 前缀 `settings.storage.*`）。
- 分区注册：`settingsPageConfig.ts` 在 `dataAndStats` 分组加入 `{ id: "storage", icon: HardDrive, titleId: "settings.storage.title" }`，`settingsNavigation.ts` 补 id。

### 6.2 类别图标

会话记录与数据库 `Database`，工具输出 `FileOutput`，轨迹 `Route`，抓包 `Activity`，日志 `FileText`，备份 `Archive`，导出 `PackageOpen`，缓存 `Layers`，运行时 `Blocks`，配置 `KeyRound`，其他 `Folder`（lucide）。

### 6.3 多端

- 桌面端：完整功能，服务注册在本地 host 的 service collection。
- Web 端 / 手机 `/remote`：**不显示**（裁决 Q5），通过 `createSettingsPageConfig({ isDesktop })` 隐藏，与 Computer Use 同一门控方式。

## 7. 测试

单测（`packages/services/src/storage/*.test.ts`）：

- catalog：fixture 树逐路径分类正确；最长前缀优先；未知路径 → `other`；受保护文件永不进入可清理目标。
- scanner：临时目录 fixture → 各类 bytes/fileCount 精确；符号链接不跟随；EACCES 记入 `errors` 且不中断；`cancelScan` 后不再产生进度；两根同 dev 合并为一卷、不同 dev 为两卷（mock `stat`）。
- cleaner：只删匹配路径；越界路径拒绝；`logs` 保留当天文件；`confirm` 类未确认不执行（service 层无确认概念，此项在 UI 测）；失败项进 `failures`。

E2E（`packages/desktop/test/e2e/settings/settings-storage-management.test.ts`，隔离 HOME 内 seed fixture）：

| Case                     | Setup                                                                                                  | Action                            | Assertion                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------- |
| SM-01 scan               | 等启动迁移完成，清空隔离 HOME 的 `backup/`，再 seed 4 KiB `cli/debug`、6 KiB `backup/` 与昨日/今日日志 | 打开资源管理器 › 存储             | 扫描完成后轨迹为 4.0 KB、备份为 6.0 KB；总量包含应用正常运行数据    |
| SM-02 drill-down         | 同上                                                                                                   | 点「模型调用轨迹」                | 明细列出 2 个文件与根目录 `~/.zcode`；面包屑可返回                  |
| SM-03 clean safe         | 同上                                                                                                   | 点轨迹行「清理」                  | 无确认框；toast 释放大小；文件已删；行大小变 0                      |
| SM-04 clean confirm      | 同上                                                                                                   | 点「备份」行「清理」→ 取消 / 确认 | 取消不删；确认后删除                                                |
| SM-08 stop on leave      | seed 大量小文件                                                                                        | 扫描中切到其他分区再切回          | 切走后 host 收到 cancel（无进度事件）；切回重新开始且先显示上次结果 |
| SM-09 tool outputs guard | seed 一个 mtime 为 1 小时前、一个 3 天前的 `cli/artifacts/sess_*`                                      | 清理「工具输出与子代理产物」      | 只删 3 天前的目录                                                   |
| SM-05 logs keep today    | 同上                                                                                                   | 清理日志                          | 昨日文件删除，今日文件保留                                          |
| SM-06 two roots          | `setting.json.dataBaseDir` 指向另一目录并 seed `v2`                                                    | 打开分区                          | 磁盘卡片列出两个根目录及各自占用；同盘时仍是一张卡片                |
| SM-07 i18n/theme         | —                                                                                                      | 切 en + light                     | 文案与配色正确（代表样本）                                          |

## 8. 裁决记录（2026-09-10）

| #   | 问题                                           | 裁决                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 分类粒度                                       | 「数据库」与旧「会话与任务数据」合并为 **会话记录与数据库**（不可清理）；`cli/artifacts`、`cli/agents`、`cli/sessions` 独立为 **工具输出与子代理产物**（需确认可清理，24h 保护）。核实结果见 §1.3.1：artifacts 不是用户附件，是工具结果留档 |
| 2   | 命令输出与临时缓存是否可清理                   | 可清理，`confirm` 并说明后果                                                                                                                                                                                                                |
| 3   | 备份与迁移残留                                 | 可清理（`confirm`），类别改名为 **备份**                                                                                                                                                                                                    |
| 4   | 启用自定义路径后的 `~/.zcode/v2` 旧副本        | 归入 **其他**，不提供清理                                                                                                                                                                                                                   |
| 5   | 端范围                                         | 只做桌面端                                                                                                                                                                                                                                  |
| 6   | CLI 不跟随数据存储路径的根因                   | 本次不修，只做管理（修了也仍有残留问题）                                                                                                                                                                                                    |
| 7   | 进度                                           | 实时刷新；切走即停、进来再算；异步 IO、性能优先（见 §5 性能约束）                                                                                                                                                                           |
| 8   | 工具输出 / 缓存到底能不能删（2026-09-10 追加） | 拆成两类：**子代理产物** = `cli/agents/**/transcript.jsonl`，可直接清理（保留 24h 内活动会话）；**工具输出与临时缓存** = 原「工具输出与子代理产物」其余 + 原「命令输出与临时缓存」，暂不可删，待逐项确认                                    |

## 9. 实施拆分（裁决后）

1. MR-1 `feat(storage): catalog + scanner + cleaner + IStorageService`（services 层 + 单测）
2. MR-2 `feat(settings): 存储管理分区`（host 注册、UI 扫描与展示、i18n、E2E SM-01/02/06/07）
3. MR-3 `feat(settings): 存储清理动作`（确认框、toast、E2E SM-03/04/05）

每个 MR 先跑 `pnpm architecture:check --changed`、`pnpm typecheck`、`pnpm lint`。

## 10. 代码架构设计（按 `architecture-governance` skill）

依据 `.agents/skills/architecture-governance/SKILL.md` 与 `references/ai-guidance.md`：先给决策记录，再定 managed 模块的分层与契约，最后列接线点。实现前跑 `pnpm architecture:context storage`，实现后跑 `pnpm architecture:check --changed`，新违规为零才允许提交。

### 10.1 决策记录

```text
owner:              packages/services/src/storage（新 managed 模块）里的 StorageService 单实例，
                    唯一持有「当前扫描 job、最近一次完成快照、清理进行中标志」。
                    Renderer 只保留投影（当前 snapshot + 选中磁盘/类别），不自己累加、不缓存第二份真值。
command path:       UI <StorageSection> → useStorageUsage() → IStorageService(RPC ProxyChannel)
                    → StorageService.startScan/cancelScan/clean → ScanRunnerPort(Worker) → fs
derived views:      snapshot.roots[].categories[].entries 全部由 domain 纯函数从 Worker 上报的
                    (relativePath, bytes, mtimeMs) 折叠得到；卷分组由 deviceId 折叠得到；
                    UI 的图例/进度条/明细都是 snapshot 的投影。
ordering/idempotency: jobId 单调递增；startScan 先 abort 旧 job 再建新 job；进度事件携带 jobId，
                    UI 丢弃 jobId ≠ 当前的事件；cancelScan(jobId) 对非当前 job 为 no-op；
                    clean() 在扫描中先 cancel 当前 job，删除完成后由 UI 重新 startScan。
delivery:           desktop-continuous only（本机磁盘，不进入 task realtime；Web/手机不注册）。
contracts/spec/tests: 本文 §3/§4/§5；storage/contract.ts + contract.test.ts；
                    packages/services/src/storage/**/*.test.ts；E2E SM-01..09。
```

拒绝的形态（对照 ai-guidance 反模式）：

- Renderer 直接 `fs` 扫盘或自建队列 ❌ —— 只走 `IStorageService`。
- 第二套目录遍历器 ❌ —— desktop main 的 `zcodeDataSizeScanner.ts` 遍历逻辑迁入本模块 adapters，遥测 Worker 改为 import 同一实现。
- domain 里出现 `fs` / `path.resolve(homedir)` / 定时器 ❌ —— 分类、折叠、清理计划全是纯函数。
- 深层 import `@zcode/services/src/storage/app/...` ❌ —— 只允许 `contract.ts`。

### 10.2 模块布局与分层

`architecture-policy.yaml` 新增 managed 模块（layerOrder 语义：前面的层不能 import 后面的层）：

```yaml
- id: storage
  roots: [packages/services/src/storage]
  managed: true
  requires: [shared, rpc] # 若 checker 对 ../descriptors.js 报 deep-import，改为在 requires 里加 services 并把 descriptor 创建放到 contract.ts；以首次 architecture:check 结果为准
  publicEntrypoints: [packages/services/src/storage/contract.ts]
  layers: { domain: domain, app: app, adapters: adapters }
  layerOrder: [domain, app, adapters]
  owner: desktop-settings
```

```text
packages/services/src/storage/
├─ module.ts                 { id:"storage", requires:["shared","rpc"], provides:["storage-service"], publicEntrypoints:["contract.ts"] }
├─ contract.ts               IStorageService + 全部对外类型（§4）+ createServiceDescriptor（≤300 行，≤12 方法）
├─ contract.example.ts       用 fake port 演示「进入分区→订阅进度→取消→清理」
├─ contract.test.ts          契约行为断言（事件带 jobId、cancel 幂等、clean 返回结构）
├─ CONTRACT.md               类型与测试表达不了的不变量（见 10.3）
├─ domain/                   纯函数，禁止 IO
│  ├─ storageCatalog.ts      规则表 + classify(relativePath) → {categoryId, cleanability, protected}
│  ├─ usageAggregate.ts      fold(entries) → StorageRootUsage；entries 聚合到规则命中的一级路径
│  ├─ volumeGrouping.ts      按 deviceId 把多个根合并成卷视图
│  └─ cleanPlan.ts           planClean(listing, categoryId, now) → 待删路径；含 24h 保护、受保护文件白名单、越界拒绝
├─ app/                      用例编排，只依赖 domain 与 ports
│  ├─ ports.ts               ScanRunnerPort / VolumeProbePort / FsCleanerPort / RootsResolverPort
│  ├─ scanJob.ts             单 job 生命周期：jobId、AbortController、300ms 节流、状态机
│  └─ storageService.ts      createStorageService(deps: ports) → IStorageService；Emitter<snapshot>
└─ adapters/                 IO 实现
   ├─ fsWalker.ts            opendir/lstat 遍历（自 desktop main zcodeDataSizeScanner 迁入），有界并发、AbortSignal、setImmediate 让出、产出 (relativePath, bytes, mtimeMs)
   ├─ volumeProbe.ts         stat().dev + 向上找挂载点 + statfs → StorageVolume
   ├─ fsCleaner.ts           按 cleanPlan 结果异步有界并发 rm，收集 failures
   └─ scanWorkerProtocol.ts  Worker 消息类型与 isSnapshot 守卫（Worker 入口本身在 desktop 包）
```

Worker 边界（保持 host 事件循环空闲）：

```text
desktop/src/host/storageScanWorker.ts   (tsup 新增 entry "host/storageScanWorker")
   └─ import { walk } from services/storage/adapters/fsWalker
      import { classify, fold } from services/storage/domain/*     ← 纯函数可在 Worker 内跑
      每 300ms postMessage(部分 snapshot)；收到 abort 消息即停
desktop/src/host/storageScanWorkerClient.ts  实现 ScanRunnerPort：new Worker(new URL(...)) + terminate on abort
desktop/src/main/zcodeDataSizeWorker.ts      改为 import services 的 fsWalker（删除 main 里的重复遍历实现）
```

理由：分类与折叠在 Worker 内完成，主线程只收聚合后的快照，不为每个文件跨线程传消息；进程内测试用 `createInProcessScanRunner()` 直接调用同一 walker + domain，保证 Worker 版与测试版走同一条路径。

### 10.3 CONTRACT.md 要写的不变量

- 同一时刻至多一个 running job；`startScan` 隐式取消旧 job。
- 进度快照单调：同一 job 内 `bytes` 只增不减；`status` 只能 scanning → complete | cancelled | failed。
- `clean` 只删除 catalog 显式匹配且通过 `cleanPlan` 校验的路径；受保护白名单在任何类别下都不删；返回的 `failures` 是逐路径的，不抛整体异常。
- `entries` 不包含逐文件列表，只到规则命中的一级路径；快照体积与文件数无关。
- 根目录解析来自注入的 `RootsResolverPort`（desktop 传 `homedir()` 与 `getDataBaseDir()`），模块内不读环境变量。

### 10.4 接线点（改动清单）

| 位置                                                                                              | 改动                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture-policy.yaml`                                                                        | 新增 `storage` managed 模块（10.2）                                                                                                                                                         |
| `packages/shared/src/channels.ts`                                                                 | `ServiceChannels.Storage = "storage"`                                                                                                                                                       |
| `packages/shared/src/test-ids.ts`                                                                 | `TID_SETTINGS_STORAGE_*`                                                                                                                                                                    |
| `packages/services/src/storage/**`                                                                | 新模块（10.2）                                                                                                                                                                              |
| `packages/services/src/accessor.ts`                                                               | `IServiceAccessor.storageService`                                                                                                                                                           |
| `packages/services/src/node.ts`                                                                   | 导出 `createStorageService` 与 adapters 工厂                                                                                                                                                |
| `packages/client/src/remoteServiceAccess.ts`                                                      | `ProxyChannel.toService<IStorageService>`                                                                                                                                                   |
| `packages/desktop/src/host/index.ts`                                                              | 在 `createSettingService()` 附近组装：roots resolver、Worker scan runner、fs cleaner、volume probe                                                                                          |
| `packages/desktop/src/host/remoteConnectionServiceCollection.ts`                                  | `.register(IStorageService, ...)`（连接级，机器作用域；不注册到 workspace 级 collection）                                                                                                   |
| `packages/desktop/src/host/storageScanWorker.ts` + `storageScanWorkerClient.ts`                   | Worker 入口与 ScanRunnerPort 实现                                                                                                                                                           |
| `packages/desktop/tsup.config.ts`                                                                 | host 增加 `"host/storageScanWorker"` entry                                                                                                                                                  |
| `packages/desktop/src/main/zcodeDataSizeWorker.ts` / `zcodeDataSizeScanner.ts`                    | 遍历实现迁入 services，main 侧只保留 Worker 入口                                                                                                                                            |
| `packages/ui/src/hooks/useStorageUsage.ts`                                                        | 订阅 `onScanProgress`，mount 时 `startScan`、unmount/失焦 60s 时 `cancelScan`，按 jobId 过滤                                                                                                |
| `packages/ui/src/settings/storage/`                                                               | `StorageSection.tsx`、`StorageDiskCard.tsx`、`StorageCategoryList.tsx`、`StorageCategoryDetail.tsx`、`StorageCleanConfirmDialog.tsx`、`storageCategoryPresentation.ts`（图标/文案 id/颜色） |
| `packages/ui/src/settings/settingsPageConfig.ts`、`lib/settingsNavigation.ts`、`SettingsPage.tsx` | 注册 `storage` 分区（`isDesktop` 门控）                                                                                                                                                     |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`                                                   | `settings.storage.*`                                                                                                                                                                        |
| `packages/desktop/test/e2e/settings/settings-storage-management.test.ts`                          | §7 E2E                                                                                                                                                                                      |

### 10.5 事件与类型的落点

- 进度事件走 RPC 的 `onXxx: Event<T>` 约定（`packages/rpc/src/proxy-channel.ts` 自动把 `on` 前缀属性识别为事件并 buffer），契约里写 `onScanProgress: Event<StorageUsageSnapshot>`，不引入新的 broadcast channel。
- `IStorageService` 公开方法：`startScan`、`cancelScan`、`getSnapshot`、`onScanProgress`、`clean`，共 5 个。「在文件管理器中显示」复用平台已有的 `openInFileManager` 能力，UI 用 `root.path + relativePath` 直接调用，不经过 storage 服务。
- 字节格式化复用 UI 现有的大小格式化工具（实现时先 grep `formatBytes`/`formatFileSize`，禁止新写第二个）。

## 11. 实现落点（2026-09-10，z-code-2 staging）

> 2026-09-10 迁入资源管理器后的差异：服务实例改由 **desktop main** 持有（不再注册为 host RPC 服务，无 ServiceDescriptor / channel），renderer 通过 preload 的 `window.resourceManager.storage`（`StorageManagementBridge`）调用；数据类型统一放在 `packages/shared/src/storage.ts`；UI 在 `packages/ui/src/resource-manager/storage/`；「在文件管理器中显示」经 `StorageRevealPath` 由 main 校验路径在数据根内后调用 `shell.showItemInFolder`。下表为迁移后的落点。

| 层                | 文件                                                                                                                                                                                              | 说明                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| policy            | `architecture-policy.yaml`                                                                                                                                                                        | `storage` managed 模块：`requires: [shared, rpc, services]`，layerOrder `domain → app → adapters`                                                      |
| shared            | `packages/shared/src/storage.ts`、`channels.ts`、`test-ids.ts`                                                                                                                                    | 数据类型与 `StorageManagementBridge`；`PlatformChannels.Storage*`；`TID_RESOURCE_MANAGER_STORAGE_*`、`TID_RESOURCE_MANAGER_TAB`                        |
| services/domain   | `storage/domain/{storageCatalog,usageAggregate,cleanPlan}.ts`                                                                                                                                     | 分类规则、有界聚合（每类最多 100 条 entries，其余折叠为 `…`）、清理计划；卷分组 `groupStorageRootsByVolume` 在 shared                                  |
| services/app      | `storage/app/{ports,scanJob,storageService}.ts`                                                                                                                                                   | 端口、单 job 节流与终态、`IStorageService` 单 owner                                                                                                    |
| services/adapters | `storage/adapters/{fsWalker,volumeProbe,fsCleaner,inProcessScanRunner,rootsResolver}.ts`                                                                                                          | 有界并发可取消遍历、statfs 卷探测、有界并发删除+空目录回收、`runStorageScan`（Worker 入口与单测共用的唯一扫描路径）、两根解析                          |
| desktop main      | `main/resourceManagerStorage.ts`、`main/storageScanWorker.ts`、`storageScanWorkerClient.ts`、`storageScanWorkerProtocol.ts`、`tsup.config.ts`                                                     | ipc 面 + 唯一 StorageService 实例；Worker 入口（entry `main/storageScanWorker`）与 ScanRunnerPort 实现；abort 500ms 宽限后强制 terminate；关窗取消扫描 |
| desktop preload   | `preload/resourceManager.ts`                                                                                                                                                                      | `window.resourceManager.storage` 桥                                                                                                                    |
| ui                | `resource-manager/ResourceManagerApp.tsx`（tab）、`resource-manager/storage/*`（含 `useStorageUsage`）、i18n `resourceManager.storage.*`                                                          | 存储 tab、磁盘卡片、类别列表、明细、确认框                                                                                                             |
| tests             | `packages/services/test/storage*.test.ts`、`storage/contract.test.ts`、`packages/ui/test/resourceManagerStorage{Presentation,Usage}.test.ts`、`desktop/test/e2e/resource-manager/storage/resource-manager-storage.test.ts` | 单测 + E2E SM-01~05                                                                                                                                    |

与 §4/§10 的差异：

- 服务不再走 RPC：`IStorageService` 只是 main 持有实例的接口（`StorageManagementApi` + `onScanProgress` + `dispose`），没有 descriptor / channel；`useStorageUsage` 的输入是 preload 桥而不是 `useServices()`。
- 「在文件管理器中显示」走 `StorageRevealPath`，main 用 `isPathInsideStorageRoots` 校验后调用 `shell.showItemInFolder`。
- 契约类型与 `groupStorageRootsByVolume` 放在 `packages/shared/src/storage.ts`（renderer 桥、main、services 共用，且避免 contract ↔ domain 循环依赖）。
- 数据大小的 SM-08（切走即停）与 SM-09（24h 保护）由单测覆盖（`useStorageUsage.test.ts`、`storageCleanPlan.test.ts`），E2E 不再重复。
- desktop main 的遥测扫描器 `zcodeDataSizeScanner.ts` 尚未切到 services 的 `walkStorageRoot`，留作后续小 MR（行为等价替换，需保留 file/time limit partial 语义）。
