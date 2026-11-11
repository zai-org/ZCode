# 设置：项目管理

用户要求（2026-10-24 设计评审通过）：打开的项目很多时，逐个删除很繁琐。设置 → 数据与统计新增「项目管理」页，位于归档管理之前。页面先算出疑似不再使用的项目，用户复核后一次确认批量移除；移除可撤销，已移除的本机项目可恢复。设计稿方向 A（A0–A4）为验收基准。

## 行为

### 入口

- 设置菜单与页头共用 `projectManagement.nav`：中文为「项目管理」，英文为「Project Management」，其他语言使用对应译文（2026-11-05）；工作区的普通「项目」文案不变。验收覆盖桌面和手机窄屏、深浅主题下的名称与显示。
- 设置导航分区 id `projects`，图标 Folders，分组 dataAndStats，排在 archives 前；可用范围与归档管理相同（不加入 desktop-only）。
- 侧栏项目行「更多」菜单末尾、分隔线后新增「管理项目…」：桌面端显示，写设置分区意图后打开设置页签（复用设备设置入口的 `setPendingSettingsSectionIntent` + `openSettingsTab`）。侧栏不加角标、提示或常驻入口。
- 页头标题下一行说明：移除只把项目从侧栏和项目选择器中拿掉，会话仍在最近与搜索中，磁盘不受影响。

### 列表

- 行集合 = 共享 `ProjectDirectoryProvider` 树中未删除的项目（本地 + 本机入口对应的远程，含离线）。页面不另读 Host，不缓存副本。
- 每行：复选框、项目文件夹图标（复用侧栏 `ProjectFolderIcon` 的 root 数量规则：多 root 显示 Folders；主目录缺失时显示 FolderX）、名称（置顶显示图钉）、主目录（等宽；多 root 时其后跟「+N」标签，N 为其余目录数，悬停、键盘聚焦或点按标签以提示列出其余目录，主目录行不变高）、设备（本地「本机」；远程用连接类型标签 + 设备名）、会话数、最近活动、疑似原因标签、更多菜单（「编辑项目」及「移除…」，移除走同一确认）。
- 会话数 = 树中同 Host + projectId 的任务数（含已归档）；最近活动 = 这些任务 CLI `updatedAt` 最大值，无任务显示「从未」。离线或未解析的远程项目没有任务事实，两列显示「—」。
- 搜索（名称、roots、设备名，不分大小写）、筛选（全部项目 / 疑似不再使用）、排序（最近活动 / 名称 / 会话数）。每页 50 行，「显示更多」+50。

### 编辑项目（2026-11-02）

- 每行更多菜单在「移除…」之前提供「编辑项目」，复用首页的 `ProjectEditor`。桌面悬停或键盘聚焦显示菜单按钮；窄屏和触屏常显。
- 沿用首页编辑边界：项目服务可用、所属 Host 在线、项目已解析且非 `legacySingleRoot` 才显示编辑入口。本地可编辑名称、文件夹和主目录；远程沿用单个固定目录限制。
- 页面仅保存正在编辑的 `projectKey`（Host + ID），从共享目录取得项目，不按名称或 cwd 匹配。项目移除、设备离线或能力失效时关闭旧编辑器。
- 表单草稿、取消、保存、错误与删除行为均由共享编辑器处理。保存后刷新共享目录，列表和首页侧栏同步；留在当前设置页，不创建会话或切换 workspace。编辑器内删除沿用首页的所属 Host 软删除；列表「移除…」仍遵守本页的本机入口移除规则。

```text
行菜单编辑 → projectKey → ProjectEditor（唯一表单草稿）
保存 → 原 saveProject → refresh → 共享目录 → 项目管理 / 首页侧栏
取消 → 丢弃草稿；Host + 项目身份失效 → 卸载编辑器
```

验收 PJM08：同 cwd 多项目中只修改选中项目；取消不落盘；保存名称和主目录后列表与侧栏更新，已有会话 cwd/归属不变。PJM06 同时验证中英文、深浅主题、1200/390px 的菜单和编辑器可达与布局。PJM09 验证手机远控编辑及桌面同步。

### 疑似不再使用

纯函数按当前树派生，不落盘。置顶项目、已删项目、离线或未解析的远程项目、本页不能移除的行（legacy 单 root、无入口）不参与。一个项目只取第一条命中的原因：

| 原因         | 条件                                                                  |
| ------------ | --------------------------------------------------------------------- |
| 文件夹不存在 | `primaryRootStatus === "missing"`                                     |
| 没有会话     | 零任务，且 `createdAt` 早于 7 天（`createdAt` 为 0 的缓存项目不判定） |
| N 个月未使用 | 有任务，最近活动早于 90 天                                            |

全部项目视图且存在候选时，列表上方显示建议卡片（总数与三类计数）和「复核 N 个」。点击后筛选切到「疑似不再使用」，并选中全部候选；用户只需取消要保留的。

### 选择与移除

- 选择是 UI 草稿：以 `projectKey`（Host + ID）为键；搜索或筛选变化时清空；树刷新后只保留仍可见的行。表头复选框作用于当前筛选的全部行（不受分页限制）。
- 有选择时，列底部浮出操作栏：已选数量、清除、「移除 N 个项目」。窄屏宽度不足时换行，保证行菜单和批量操作均不产生横向溢出。
- 确认对话框（AlertDialog）列出总数、会话总数和按设备拆分：本机项目软删除；远程项目只从本机移除，远端项目与其其他客户端不受影响。
- 每个项目的移除命令：
  - 本地项目：`projectService.deleteProject(id, "local")`（现有软删除）。
  - 有本机入口的远程项目（含在线可编辑）：`remoteProjectService.removeEntry(entryId)`。批量不调用远端 `deleteProject`。
  - 既非本地又无入口的行不可选。
- 同一页面的批次（移除、撤销、恢复、重试）按发起顺序依次执行，不并发、不丢弃；确认时冻结候选；逐项发送，成功/失败分别记录，结束后只刷新一次树。

### 撤销、失败与恢复

- 有成功项时弹 toast「已移除 N 个项目」，带「撤销」。toast 在本批结束（刷新完成）后才弹出，刷新失败也弹。另一批在途时点撤销，撤销排在其后执行，不会被丢弃。撤销对本批成功项逐个反向执行：本地 `restoreProject`；远程 `addEntry`（同 Host、原 projectId、名称、roots，带当时的 membershipId）。入口 projectId 为空的旧入口不能撤销，计入失败。
- 有失败项时页面顶部显示警告横幅：失败数量与第一个失败项名称、原因，「重试」只重跑失败项（仍在树中才执行）。下一个批次开始时清除横幅。
- 「已移除的项目」折叠区（默认收起）：本地 Host 已软删除的项目，按删除时间（`updatedAt`）倒序，每行「恢复」。远程入口移除后不再保留，重新添加走现有远程项目选择器（虚拟项目 spec E1a）。

## 彻底删除数据

用户要求（2026-10-24 第二轮设计评审，方向 A「移除对话框里多一个选项」，A1–A3 为验收基准）：移除项目时可同时彻底删除这些项目在本机留下的 ZCode 数据。

### 范围

只针对选中的**本机**项目（`removal === "delete"` 且 Host 为 local）。远程项目的数据在其设备上，照旧只移除本机入口。

| 内容                                               | 位置                                                                                                                          | 写者 / 删除者                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 会话（正文、工具输出、用量、待办、工作流运行记录） | CLI `db.sqlite` 中项目会话及其后代会话（`parent_id`、`session_task_link`）的行                                                | CLI                          |
| 会话文件                                           | `cli/artifacts/<sid>`、`cli/exec/<sid>`、`cli/agents/<sid>`、`cli/sessions/<sid>`、`cli/{debug,rollout}/model-io-<sid>.jsonl` | CLI                          |
| 记忆                                               | `cli/memories/projects/<slug>-<hash>`（按目录派生，与 CLI 记忆解析同一函数）                                                  | CLI                          |
| 文件检查点                                         | `v2/checkpoints/<workspaceHash>`                                                                                              | Host（git checkpoint store） |
| 任务索引行                                         | `tasks`、`task_group_members`、`task_group_admissions` 中这些会话的行；无引用时连同 `projects`/`project_roots` 行             | Host                         |

不删除：用户的项目文件夹（包括 ZCode 自建的 `~/.zcode/workspace/<id>`）、应用与 CLI 日志（已有 14 天 / 7 天轮转）、git 仓库里的检查点引用、远程设备上的数据。

项目的会话 = Host 树中该项目的全部任务（含已归档、已软删除）。目录集合 = 项目 roots ∪ 这些会话的 cwd，减去仍被范围外的项目作为 root（**含已软删除的项目**：它们可以恢复，2026-10-25 裁决宁可保留不删）、或被不在本次删除范围内的会话作为 cwd 使用的目录（共享目录的记忆与检查点保留）。「范围外的会话」= 本 Host 上 `tasks.deleted=0` 的任务行：移除项目只软删除项目行，其任务行保持 `deleted=0`，因此已移除项目的会话 cwd 照样受保护；`deleted=1` 只表示会话本身已删除（用户删除会话，或本流程目录失败时标记的行），已删除的会话无法恢复，其 cwd 不再保护。目录集合在删除任务索引行**之前**计算，否则已删任务曾用的 cwd（如项目 roots 变更前的旧目录）会漏删。

**数据库文件不收缩（2026-10-24 裁决）**：CLI 库 `auto_vacuum = none`，删除行只把页留给库内复用，文件大小不变。切换增量 vacuum 需要一次整库 VACUUM，持有写锁约 10 s/2 GB，超过其他进程 5 s 的锁等待，会让运行中的会话写入失败；属于 CLI 存储维护的独立决策，本期不做。因此所有展示的大小只统计**真正从磁盘删除的文件**；数据库行照样删除但不计入大小。

### 交互（A1–A3）

- 确认对话框选中项含本机项目时，在设备拆分下方显示选项卡片「同时删除它们的 ZCode 数据」+ 总大小，说明行「这 M 个本机项目的会话、会话文件、检查点和记忆」。每次打开都**默认不勾选**，不记忆。
- 对话框打开即对本机候选调用 `measureProjectData`；结果返回前大小显示「正在计算…」。测量失败（旧 CLI 不支持、Agent 不可用）或本机候选既无会话也无文件时，不显示该选项，对话框保持原样。
- 勾选后：卡片改为 destructive surface，逐行列出「N 个会话及其文件」「文件检查点」「记忆」的大小（检查点、记忆为 0 时省略该行），末行「不会删除：你的文件夹、应用日志，以及 <远程设备名> 上的数据」（无远程项目时省略设备部分）。标题改为「移除 N 个项目并删除其数据？」；描述改为「它们会离开侧栏和项目选择器。这 M 个本机项目的 S 个会话会连同文件一起删除。磁盘上的文件夹不受影响。」；原「可恢复」两行改为一行「这 M 个本机项目之后无法恢复。」
- 勾选后出现「输入 delete 以确认」（中文输入「删除」），输入完全一致前主按钮禁用；主按钮文案「移除并删除 X」，带垃圾桶图标。取消勾选时清空输入。
- 确认后：先按原流程移除全部候选；再对本批**成功移除**的本机项目逐个调用 `deleteProjectData`。期间显示常驻进度 toast「正在删除 M 个项目的数据…」+ 进度条 +「已删除 A / 共 X」（X 为确认时的测量总量，A 为逐项累加的实际释放量）。
- 结束后进度 toast 换成结果 toast「已移除 N 个项目 · 释放 A」，**不带撤销**（本机项目已无法恢复，只撤销远程会误导）。删除数据失败或有会话被保留（仍在运行，或其附件仍被别的会话引用）的项目，计入警告横幅（kind `purge`，原因见下），「重试」只重跑这些项目的 `deleteProjectData`；同一批里既有移除失败又有数据删除失败时，横幅显示移除失败，其「重试」先重跑移除（连同其数据删除），再重跑先前数据删除失败的项目；这些项目仍是软删除状态，可在「已移除的项目」中恢复。
- 本批没有勾选时，行为与之前完全相同（带撤销）。

### 命令

`IProjectService.measureProjectData(ids, hostId?)` → `{ projects: { id, sessions, sessionBytes, checkpointBytes, memoryBytes }[] }`；`IProjectService.deleteProjectData(id, hostId?)` → `{ freedBytes, deletedSessions, runningSessions, referencedSessions, failed }`（`runningSessions` / `referencedSessions` = 因运行中 / 附件被引用而保留的会话数；`failed` = 删除失败的会话数 + 目录数）。

- 只在本机 Host 执行；路由到远程 Host 报 `project.data-local-only`，legacy 单 root 只读。
- `deleteProjectData` 只接受**已软删除**的项目（否则 `project.data-requires-removed`），保证不会删到仍在使用的项目。
- 会话按 cwd 分组：该 cwd 已有运行中的 Agent 进程时交给该进程执行（它持有会话运行态，能判断运行中并释放已加载的会话）；否则交给不寄居真实项目的管理面进程（与全局工作流、插件管理同一进程）。测量只读，与全局工作流同一载体选择：本机已有活跃 Agent 进程时用它，否则用管理面进程。
- CLI 删除：运行中的会话（已加载且有在途 turn）保留并返回 `kept`（`reason: "running"`）。附件仍被本次不删除的未删除会话引用的会话树整棵保留（`reason: "referenced"`）：fork、回退与工作流转录按值复制 part，`zcode-artifact://<源会话>/…` 仍指向源会话的附件目录，删掉会让存活的 fork 读不到图片与工具产物；引用按 part 内容中的 artifact URI 判定（覆盖所有复制路径，不依赖 fork 谱系），保留一棵会让引用它的树也变成「本次不删除」，按不动点迭代。已加载的空闲会话按 `deleteSession` 的释放顺序关闭，但**不**发布 `session.removed`（只释放运行态）；随后删除文件，再在一个事务里删除会话行（`pragma foreign_keys = on`，级联 message/part/usage 等；无外键的 `input_history`、`dwf_run`、`workflow_run` 显式删除），最后才从 sessions-index 移除。文件删除失败不删行，记入 `failed`，sessions-index 与 Host 镜像保持原样，下次重试仍能找到。
- Host 在 CLI 返回后计算目录集合（保留或失败会话的 cwd 不删记忆与检查点），删除目录，再处理已删会话的任务索引行：目录全部删除成功时删除这些行，项目不再被任何任务、自动化、闲时任务引用时删除项目行；有目录删除失败时只把这些行标为 CLI 已删除（`deleted=1, cli_deleted=1`，列表不再显示），项目保持软删除，重试时仍能按这些行找回目录。命令正常返回部分结果，不因保留而抛错（释放量要计入进度）；UI 对 `runningSessions > 0` 记原因 `project.data-session-running`、对 `referencedSessions > 0` 记 `project.data-session-referenced`、对 `failed > 0` 记 `project.data-delete-failed`。
- 结果以 `state:projects` 广播；sessions-index 的 `session.removed` 迟到时，对已不存在的行是空操作。

### 协议

新增 V4 query（只读测量 / 幂等删除，旧 CLI 返回 method-not-found，Host 据此隐藏选项）：

- `v4/storage/sessionData/measure`：`{ sessionIds, directories: { workspacePath, workspaceIdentity? }[] }` → `{ sessions: { sessionId, bytes }[], memory: { workspacePath, bytes }[] }`。会话大小含后代会话的文件。
- `v4/storage/sessionData/purge`：同入参 → `{ deleted: { sessionId, bytes }[], kept: { sessionId, reason: "running" | "referenced" }[], failed: { sessionId?, workspacePath?, code }[], memory: { workspacePath, bytes }[] }`。重复调用幂等：已不存在的会话按 0 字节删除成功。

## 恢复命令

`IProjectService.restoreProject(id, hostId?)`，与 `deleteProject` 对称：

- 幂等：未删除直接返回当前项目；不存在报 `project.not-found`；跨 Host 报 `project.cross-host-move`。
- 服务层读取该项目后，复用仓库已有的恢复写路径 `saveProject({ restoreProjectId, roots })` 并原样传回 roots：主要目录、置顶、顺序不变，名称按保存规则重新派生、与未删除项目重名时加序号（E4）。仓库契约不新增方法。
- 不经服务层 `saveProject` 的目录校验。主目录失效继续由 `primaryRootStatus` 展示、`prepareSession` 拒绝新建，与删除前一致；否则「文件夹不存在」的项目无法撤销。
- 远程 Host 经现有 route 转发；旧 Server 没有该方法时返回错误，页面只对本地项目调用它。
- 现有「新建时 roots 相同提示恢复」（`saveProject.restoreProjectId`）不变。

## 时序与 owner

```text
Host readTree ─► ProjectDirectoryProvider（唯一目录 owner）─► 侧栏 / composer / 归档管理 / 项目管理
                                                          └► 纯派生：行、原因、筛选、排序
项目管理页只持有：搜索/筛选/排序/分页、选择草稿、正在编辑的项目键、在途批次、最近一次结果

确认 ─► 冻结候选 ─► 逐项命令 ──► 本地：deleteProject      ┐
                             └► 远程：removeEntry       ├─► 成功/失败列表 ─► refresh() 一次
                                                         ┘        │
                             toast(撤销) ◄── 成功项 ◄─────────────┤
                             警告横幅(重试) ◄── 失败项 ◄──────────┘
撤销 ─► restoreProject / addEntry（只针对本批成功项）─► refresh() ─► toast

勾选「同时删除数据」时，同一批次内接着执行（仍在批次队列里，不与其他批次并发）：
移除成功的本机项目 ─► 逐个 deleteProjectData ─► 进度 toast（累加释放量）
  deleteProjectData ─► Host 读树：会话 + 目录（扣除共享目录）
                    ├► 按 cwd 选进程：已有 Agent 进程 / 管理面进程 ─► CLI purge（保留运行中 / 被引用，删文件，删行）
                    ├► Host 算目录（任务行仍在）─► 删记忆 + v2/checkpoints/<hash>
                    └► 目录全成功：Host 删任务索引行（无引用再删项目行）
                       目录有失败：任务行标为已删除，项目保持软删除 ─► state:projects
结果 toast（无撤销）◄── 释放量 ；警告横幅(重试) ◄── 失败或保留了会话的项目
```

- 写入后侧栏经既有 `state:projects` 广播或 Window 目录变化流刷新，页面不维护第二份项目状态。
- 批次在途时禁用选择、筛选和移除（toast 的撤销仍可点，进入队列）；页面卸载不取消已发出的命令，结果回到 Host 后由下一次读取呈现。
- 桌面 continuous 与手机 replayable 链路不变；编辑复用首页已有服务合同。

## 架构

UI 属于 managed 模块 project-sidebar/ui：`project-management-view.ts`（纯派生）、`useProjectManagement.ts`（批次、撤销、恢复）、`ProjectManagement.tsx` 及子组件，经 index 公开 `ProjectManagement`；SettingsPage 只注册分区并渲染。服务层改动：project 服务 `restoreProject`（路由、zod 校验、复用仓库恢复写路径）、legacy 单 root 只读。

彻底删除数据：project 服务新增 `measureProjectData` / `deleteProjectData`，通过注入的 `ProjectDataPort`（node.ts 装配：zcode-agent 服务的会话数据测量/删除 + git checkpoint 目录）执行副作用，project 模块不依赖 Agent 实现；project-storage 仓库新增 `purgeTasks`、`purgeProjectIfUnreferenced`（只删 Host 自有行）。CLI 新增两条 V4 query、session store `purgeSessions`、adapters 会话文件端口。无 schema、migration 变化。

## 测试

App 业务单测已按[退役规格](../../testing/unit-test-quality.md)移除。以下 services/UI 原单测断言保留为待补验证范围，不计现行覆盖；CLI 测试与 pending E2E 继续保留，不能将退役单测自动计为 E2E 覆盖。

- services：`restoreProject` 对目录缺失项目可恢复、幂等、重名加序号、保留 roots/置顶/顺序、未知与跨 Host 拒绝；远端路由；legacy 只读。
- ui：纯派生（原因优先级、7 天/90 天边界、置顶与离线排除、搜索/排序/计数）；批次 hook（本地/远程命令分派、部分失败、撤销、重试、冻结候选）。
- 彻底删除数据：CLI `purgeSessions` 级联与后代、文件端口测量/删除与越界拒绝、purge 保留运行中/被引用会话（含不动点链）、释放空闲会话不发 removed、文件失败不移出列表、幂等、artifact 引用查询；services 目录扣除共享规则（含已移除项目的 roots 与会话 cwd）、目录先于任务行计算（旧 cwd）、目录失败保留项目并隐藏任务行后重试成功、非软删除拒绝、远程拒绝、任务行与项目行清理、运行中/被引用保留报错；ui 选项显隐（无本机、测量失败、零数据）、勾选文案切换、输入确认门禁、确认后先移除再删除、进度与结果 toast 无撤销、失败横幅重试、移除失败与数据失败同批时一起重试、被引用原因文案。E2E PJM07（pending）：勾选删除后会话从 Recent 消失、`cli/artifacts/<sid>` 被删除、项目不在已移除列表。
- E2E（pending，PJM01–PJM09，`manual-review/pending/conversation-session-project-management.test.ts`）：设置入口与侧栏入口；建议卡片复核并保留一项；确认对话框按设备拆分、软删除后会话归属不变；撤销只恢复本批；已移除区恢复缺失目录项目；中英文、明暗、1200/390px 不横向溢出；勾选删除数据后会话、会话文件与项目行删除。

2026-11-02 验证：PJM01–PJM09 在 macOS 共 9 项通过；覆盖桌面 1200/390px、中英文、深浅主题，以及 Chrome 触屏视口的手机共享 Host 编辑和桌面同步。证据 `packages/desktop/.e2e-artifacts/desktop-e2e-20261102072543389-p405-86d835c273376265`。用例仍为 pending，未自动转正或加入 CI；真实远程 Host、Windows/Linux 桌面和实体手机未验。

2026-11-05 名称调整验证：PJM01、PJM06 定向回放 2/2 通过，覆盖菜单与页头名称、中英文、深浅主题及 1200/390px 布局；证据 `packages/desktop/.e2e-artifacts/desktop-e2e-20261105031714863-p56806-a6ed8f47824c0a79`。首轮整份 spec 为 8/9 通过，PJM09 手机触屏视口通过；PJM04 撤销断言读到 `pjm-empty` 尚未恢复，本次未修改该流程或断言，不能将整份 spec 记为通过。首轮证据 `packages/desktop/.e2e-artifacts/desktop-e2e-20261105031152882-p27417-7f94e477c01f8d17`。Windows/Linux 与实体手机未验证。
