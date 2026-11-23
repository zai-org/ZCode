# Task SQLite Index

> 历史文档：2026-09 虚拟项目重构已替代本文的运行模型。当前行为以[虚拟项目设计](../superpowers/specs/2026-09-09-virtual-project-design.md)为准。分组表已由[分组视图](../ui/task-grouped-view.md)恢复为运行态，新增 `task_group_admissions` 记录首次归组和创建 placement；workspace bootstrap 不再执行。CLI 拥有会话事实，Host 拥有项目与组织态。下文只作历史设计记录。

## Scope

`~/.zcode/v2/tasks-index.sqlite` is the app/host-side index for task list queries. ZCode Agent owns core session content and runtime state; the sqlite index owns fast list metadata and product shell state.

The index is not a replacement for ZCode Protocol session snapshots.

## 库级迁移（Todo109）

`tasks-index.sqlite` 还容纳 Automation 与 Off-Peak 表。三个 Repo 在开放读写前
复用 `runTasksDatabaseMigrations`；库级 `tasks_schema_migration` 对已登记迁移只读校验
checksum；有待应用迁移时通过 `BEGIN IMMEDIATE` 串行复查并应用，失败回滚且不记成功。
`0001_adopt_task_schema` 接管八张已有表、历史补列和索引；
`0002_provider_selection` 收口已裁决的 Automation 转换。之后只追加新迁移，
不得修改已发布 SQL、冻结转换实现或其语义版本。checksum 覆盖声明式 SQL/列清单及
转换语义版本，不使用会被打包器改写的函数文本。

### R3 附加表纳入库级账本

修复原因：R3 的 Controller/Source Repo 自行建表、补列，绕过了
`tasks_schema_migration` 的 checksum 和事务门禁。结构升级统一由
`runTasksDatabaseMigrations` 执行，按调用用途选择迁移集合：

- 默认 `base` 保持既有 `0001`–`0003`；不创建 Controller/Source 专属表。
- `controller-remote` 应用 `0004_controller_remote_identity`，接管
  `controller_remote_identity_migrations`；已有审计记录保留。
- `source-server` 应用 `0005_source_server_workspace_schema`，接管 alias、合并
  ledger、conflicts 的当前结构及旧 v1/v2/v3 升级。旧
  `workspace_migration_schema_version=3` 仅保留给旧二进制兼容，正式执行记录以
  `tasks_schema_migration` 为准；接管时遇到未来旧格式版本明确拒绝。

三个集合共用同一个物理库的账本和 `BEGIN IMMEDIATE` 执行器，可按任意初始化顺序
应用各自集合，不在只读取 Source 管理信息时触发无关业务表/模型选择转换。
所有新迁移兼容「表已存在但正式账本未登记」；既有 migration/checksum 不变，失败时
结构与记账一起回滚，不手工补成功记录。校验和必须覆盖冻结 SQL 与结构转换语义。

#### 已完成迁移的只读重开

`dc16292fa1` 将迁移入口接入每次 Controller 重连与 Source workspace 解析后，已登记
迁移也会申请写锁，绕过原有无待迁移数据的只读路径。真实 WAL 库中另一连接持有写锁时，
父版本约 1–2 ms 完成，目标版本等待约 5 秒后报 `database is locked`。

修复边界是 App 库迁移执行器与 Source session identity 迁移入口：

- 物理库账本仍是唯一已应用状态，不新增进程级缓存或修改历史 SQL、checksum、identity。
- 所选迁移全部已登记且 checksum 一致时，只读校验后返回，不申请写锁。
- 账本或迁移缺失时，取得 `BEGIN IMMEDIATE` 后重新读取账本；并发初始化由该事务串行化，
  结构和成功记录原子提交。checksum 不符仍明确失败，不以锁错误掩盖。
- Agent 完整启动迁移继续持有原有库级事务；这次只改变重开时的锁获取条件，
  不改变 workspace identity、合并计划、UI/RPC 或桌面 continuous / 手机 replayable 边界。

```text
重连 / Source 查询 → 只读账本与 checksum
                      ├─ 全部已登记 → 返回
                      └─ 存在缺项 → 写锁 → 锁内复查 → 结构升级 + 记账 → 提交
```

回归以 `remoteSchemaMigrations.test.ts` 的真实 SQLite 双连接覆盖：已迁移 Controller
无源行重连、Source 管理查询、已有 alias 的 session 解析在另一连接持有 WAL 写锁时均成功；
成功账本/业务审计不变，错误 checksum 仍拒绝。继续执行新库并发初始化和故障回滚用例。
已有远程重连 E2E 操作合同保持不变；按远程矩阵 `R3A-P-02`，迁移锁分支用真实存储集成
覆盖，不复制各数据库状态的 Electron 用例。

2026-09-15 修复验证：新增三例先在 `dc16292fa1` 全部复现 `database is locked`，
再修改入口；App/Source 六个测试文件 60 项、Agent 三个存储/迁移文件 57 项全部通过。
根类型检查、Lint（57 个既有警告，0 错误）、架构检查（0 违规）通过。未运行桌面/手机
实机 E2E 或 Windows/Linux 回归；证据限于 macOS Node 24.14.0 的真实 SQLite 集成。

```text
Controller / Source 待应用迁移 → 同库事务锁 → 结构升级 + 成功账本
                                                     ↓ 提交后
                             workspace 数据迁移（仍有独立备份、进度、恢复记录）
```

CLI `db.sqlite` 的 `zcode_database_identity` 由共享的
`0024_session_database_identity` 定义纳入 `schema_migration`。Agent 初始化与
Source 合并前接管复用同一 SQL、checksum 和应用原语；Source 只应用该独立附加表迁移，
不代跑 Agent 的其他迁移。建表不生成或覆盖 identity；其值仍由冻结合并计划管理。
旧备份接管也走相同门禁，已登记但结构损坏时明确失败，不重新建表伪装恢复。

未发布迁移的编号按 CLI 清单统一分配：`0023_session_soft_delete_outcome` 后接
`0024_session_database_identity`，两者引入版本均为 CLI `0.16.9`。迁移测试检查完整
ID、四位数字编号唯一及清单按编号递增，防止不同分支合并后重复占号。此次仅修正
identity 的编号，SQL 与 checksum 不变，不新增旧 ID 别名。开发库先停止旧写入进程并
备份，再在单个事务内核对 ID、checksum 和旧版本，修正 identity ID 及误填的
soft-delete `3.12.0`；保留执行时间和业务数据，重复运行不重放迁移。

验证覆盖真实 SQLite 的新库、存量表接管、v2 缺列、重复打开、checksum 不符、
故障回滚、多连接初始化，以及 Agent/Source 两种先后顺序。只改存储结构初始化，
不改 UI/RPC、workspace key、合并裁决或桌面 continuous / 手机 replayable 链路。

#### 2026-09-15 验证记录

- 修复基线 `b7881b4c2fe08e5f2b50d89db3e9dea96521c795`。真实临时 SQLite 中先复现
  Controller/Source/Agent 缺少正式记账、Source 不受账本故障注入约束；修复后通过。
  追加「旧版本标记缺失但 generation 已存在」的失败用例，确认接管不能清空冻结代际。
- App/Source 的 7 个测试文件 54 项通过；Agent 存储/迁移的 4 个测试文件 76 项通过；
  contracts 重建后，额外 runtime reasoning replay 16 项通过，共 146 项不重复专项检查。
  包含旧 v2 真正缺列的恢复、晚到空库排除、多线程初始化、checksum、事务回滚、
  Agent/Source 初始化先后顺序。对照 HEAD 的真实模块确认 22 条旧 Agent 定义完全相同，
  3 条旧 App 账本记录（含 checksum/时间）不变。
- 根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 及改动文件格式
  检查通过；Agent adapters `npm run typecheck` 在重建过期 contracts dist 后通过。
- 按 Agent 要求执行 adapters `npm test -- --run`：120 文件中 11 失败，1750 项中
  87 失败、1659 通过、4 跳过；另有 config suite 缺失模块。它不是本次专项通过记录。
  用临时 Vitest loader 恢复 HEAD 的两个迁移模块，5 个关联失败文件仍复现 51 项失败
  （模型 options fixture、签名配置、MCP 环境和缺失 catalog 模块）。旧产物导致的
  runtime replay 失败在重建后已消失；全量负载下的 session 并发超时在聚焦重跑通过。
  其余扩展测试失败未全部完成基线归因，未扩大修复。
- Agent adapters `npm run lint` 仍被既有多文件 `max-lines` 超限阻止；包含原有
  900 多行的 migration 定义文件。本次未修改旧 SQL 以拆分/规避该门禁。
- 未操作真实用户数据库，未做桌面/手机实机或 Windows/Linux 联合回归；本次没有
  UI/RPC 交互变更，已有远程交互 E2E 的操作步骤不变。Agent schema 发布前需按
  - 回退本次代码时保留新增表/账本和旧兼容标记；不删 schema 行，不重跑已完成的数据合并。
    数据迁移故障仍使用原有备份及业务恢复入口，不以手工补成功记录解除阻塞。

```text
任意 Repo 首次打开 → 库级账本/事务 → 所有表就绪 → Repo 正常读写
其他 Repo / 其他进程 → 同一账本校验 → 跳过已应用版本
```

旧列及时间戳不被 Provider 转换覆盖；正常 Reader/派发只使用新列。
Automation 的 JSON `null` 表示明确使用默认配置，SQL NULL 表示配置缺失，需要重选。
回滚产生的新旧格式记录不通过重复执行既有迁移追赶，内容仍须可列出、打开。
Off-Peak 缺失 Provider 的旧选择不查询当前账号补猜，不改变 Ticket 或读取时补迁；
缺配置只影响后续执行资格。TaskIndex 既有关联清理与投影维护不属于 Provider 转换。

## Responsibilities

- Keep task list queries fast without starting every workspace agent.
- Persist product shell state such as title, pinned, archived, deleted, unread, and title override.
- Store a compact `ZCodeTaskMeta` snapshot in `meta_json` for list rendering.
- Store bounded searchable text for global task search.
- Keep remote workspace identity isolation consistent through `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

## Table

The `tasks` table is keyed by `(workspace_key, task_id)`.

Core columns:

- `workspace_key`
- `workspace_path`
- `workspace_identity`
- `task_id`
- `title`
- `task_status`
- `provider`
- `mode`
- `model`
- `migration_source`
- `forked_from_task_id`
- `created_at`
- `updated_at`
- `unread_at`
- `last_unread_at`
- `pinned`
- `archived`
- `deleted`
- `title_overridden`
- `searchable_text`
- `meta_json`

Indexes cover active workspace list queries, pinned list queries, archived list queries, deleted list queries, recent global timeline, and bounded text search.

## Runtime Rules

- Writes are serialized per `(workspace_key, task_id)` to avoid concurrent metadata overwrites.
- `unread_at` is the current unread membership/CAS marker. `last_unread_at` is an internal
  allocation watermark that survives clearing `unread_at`; repository writes allocate each new
  unread marker above that watermark so same-millisecond writes and clock rollback cannot reuse
  a stale compare-and-clear version.
- `unread_at` is authoritative over the copy in `meta_json`. Writes that do not explicitly mutate
  unread state must preserve the current row value at the SQLite conflict boundary, so a stale
  snapshot from another Host cannot roll back a newer marker.
- Every task-index connection uses a bounded SQLite busy timeout. Additive schema migrations are
  idempotent under concurrent Host startup: after lock contention, a duplicate-column result is
  accepted only when the column is present.
- `meta_json` is parsed with `zcodeTaskMetaSchema`; invalid rows fall back to scalar columns and log a warning.
- SQLite row columns are authoritative for entity coordinates: reads must overwrite `meta_json` values with
  `task_id` and `workspace_path`. Because `(workspace_key, task_id)` is the actual query/primary-key boundary,
  a valid remote `workspace_key` is authoritative over a missing or stale `workspace_identity` projection;
  non-remote rows use the identity column only when it equals `workspace_key`. This keeps list queries and
  sessions-index joins on the same isolation key without ever falling back to a remote path.
- `searchable_text` is capped so long tasks cannot grow the sqlite file without bound.
- Query scopes must pass `workspaceIdentity` for remote workspaces; `workspacePath` remains the execution/display path.
- Task-list queries and dynamic workspace-event listeners are passive observers. Registering either one must not
  start a workspace Agent runtime, reconnect a remote workspace, or promote a dormant runtime retry.
- The desktop Main startup warmup is an explicit lifecycle action rather than a task-list side effect. When multiple
  local workspaces are restored, it may start at most three deduplicated targets selected from the last active
  workspace and persisted recent-project order. A failed warmup does not pull in a fourth target.
- The task-index `sessions-index` / `workspace-config` ingestion subscriptions attach only after an explicit
  workspace operation has made that exact `workspaceKey` runtime available. Their subscribe and retry paths use
  an `existing-only` policy, so a stopped runtime returns to dormant state instead of being started by observation.
- Runtime availability is keyed by `workspaceIdentity?.trim() || workspacePath`. An available event for one SSH,
  WSL, or Docker identity must not attach observers belonging to another identity with the same execution path.
- The first authoritative `sessions-index` snapshot is a silent reconciliation boundary: non-draft sessions seed
  only missing task rows, existing product-shell state is never overwritten, and no per-row list-change broadcast
  is emitted. This keeps late attachment/reconnect safe without replaying historical terminal events or causing a
  startup broadcast storm.

## Relationship To Session State

ZCode Agent session state remains authoritative for messages, model/runtime settings, permission requests, stream events, and active turn state.

The task index may cache enough metadata for list rendering, but it must not become the source of truth for session content. Missing rows are seeded from the authoritative `sessions-index` summary during initial reconciliation; opening, resuming, or completing a task later enriches that row from the full session snapshot (including model and searchable message text).

### Index read profile（2026-09-30）

Host task-index 回源（`resyncTaskIndexRowFromAgent`：`phase.completed/error`、`meta.titleUpdated`、
`session.became-visible`）调用 `session/read` 时带 `contentProfile: "index"`：

```text
task-index syncer ──session/read {runtimePolicy: existing-only, contentProfile: "index"}──▶ CLI
                                                          │ 按 index 读取全部 message/part，逐条解析
                                                          │ SQLite 先裁剪不用的 display content，再计算原 snapshot
                                                          │ 再只剥离大载荷字段（不增删 message/part）
task-index syncer ◀── 同结构 snapshot（几十 KB~数百 KB，而非 15 MB）──┘
   └─ buildMetaFromSnapshot / searchableText / hasUserVisibleContent：结果与 full 逐字节一致
```

- 剥离规则（`elideSessionSnapshotForIndex`，`@zcode/shared`）：tool part 的 `state.input` → `{}`、
  `state.output/raw/error` → `""`、`state.metadata` → `{}`；reasoning part 的 `text` → `""`；
  file part 的 `data:` URL → `data:,`。message 数量与顺序、`info`、所有 part 的 `type/id/metadata`、
  text/compaction/timeline/subagent 等其它 part 全部原样保留。
- 为什么不用 `messageLimit`：它保留尾部 N 条，而 searchable text 取开头 200K 字符、标题回退取
  第一条真实用户消息、可见性判断看全部消息，截尾会改变索引结果。
- 修订原因：旧实现每轮 turn 完成都读完整 snapshot，长 session 单行 NDJSON 达 15 MB（主要是 3 MB
  级 tool output），Host 每轮做一次 15 MB JSON/zod 解析；task index 实际只用文本、info 和 part 结构。
- 这是只给 task index 用的读取视图：其它 `session/read` 调用方不得传 `index`，拿到的 snapshot
  也不得回写到 UI/conversation 状态。缺省或 `full` 行为不变。

#### 读取内存约束（2026-11-11）

- `SessionStorePort.messages` 的 `contentProfile: "index"` 是构建索引快照的中间读取视图：
  SQLite 仅提前清空 reasoning 的 `text`、pending tool 的 `state.raw`、completed tool 的
  `state.output`、error tool 的 `state.error`。最终仍由 `elideSessionSnapshotForIndex` 执行完整裁剪。
- 工具 `input`、两层 `metadata`、时间、状态、message info、text/file/compaction/timeline 等数据
  均保留；`TodoWrite` 分组与来源判定依赖 input/metadata，不能提前按最终索引形状裁剪。
- 消息和 part 不限条数、不改变既有排序及 active-branch 选择；不新增缓存、数据库写入或恢复动作。
  缺省/full 仍读完整内容。两种读取都逐条解析 part，避免同时保留全量原始 JSON 行数组。
- 同一持久化输入下，新 index 响应必须等于旧 full 响应经最终 index 裁剪后的结果，包括标题、
  正文、可见性、运行态、用量、goal stats 与 todo groups；index 读取不能影响后续 full 读取。
- 此优化不限制正文、工具输入、元数据或图片附件总大小；它降低读取峰值，不构成整个 CLI 的固定内存上限。
- 回归检查覆盖索引与 full 后裁剪的整份响应等价、goal/用量/待办派生、读取后 full 内容不变、
  工具各状态与跨会话隔离。macOS arm64、Electron 44.7.0 / Node 24.21.0 的合成回放中，
  11,136 条消息、每段助手内容约 32 KiB，阶段采样的 JS 堆峰值由 999 MiB 降至 464 MiB，
  索引响应 SHA-256 相同；该结果不代表已复现或修复某个用户的具体崩溃。

## Task Status Projection

`task_status` is a product task state, not a direct mirror of `session.status`.

- `session.status=running|waiting|paused` maps to `task_status=running` when the snapshot still has active runtime.
- `session.status=error|completed` maps directly to the same terminal task status.
- `session.status=idle` only means the agent engine has no active turn. If the latest user-visible assistant message has a completed timestamp and is not a tool-call continuation boundary, the task status is `completed`.
- `projection.lastError` takes precedence over a previously completed assistant message, because provider failures can happen before a new assistant message is persisted.

All snapshot-to-task-status callers must use the shared projection helper from `@zcode/shared`. UI projection, service adapter, and sqlite index sync must not carry separate copies of this logic, otherwise switching workspaces can restore a task from a different terminal-status interpretation than the one used while streaming.

## Implementation

- `packages/services/src/session/taskIndexRepo.ts`
- `packages/services/src/session/zcodeTaskService.ts`
- `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`
- `packages/shared/src/zcode-task-types.ts`
- `docs/ui/pinned-task-storage.md`
