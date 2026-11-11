# 虚拟项目设计规划

> 新建草稿、模型与权限默认值及未归类任务目录生命周期以 [统一设计](../../ui/project-task-draft-lifecycle.md) 为准：按客户端、目标主机及项目 ID 隔离；首发接纳后消费未归类待发送目录。本文其他组织态与执行目录约束继续适用。

> 2026-10-13 裁决覆盖：Project 与 Group 并存。恢复筛选菜单中的“按分组”，
> Group 是控制端保存的跨项目、跨设备组织视图，不决定执行目录或项目归属。
> 首次升级保留 workspace → Project，取消 Group → Project；旧分组表继续作为权威数据。
> 不恢复 workspace 自动建组和分组查询时的强制归档。具体行为与验收见
> [任务分组视图](../../ui/task-grouped-view.md)。下文有关合并 Group、两种视图、
> F9/F10 手工 Group 转项目、M6 分组转换与分组 API 下线的旧裁决均由本条替代。
> 已执行旧转换的开发库不自动反向清理；不修改既有 migration ID 或 SQL checksum。
>
> 2026-10-15 裁决补充（远端旧任务归入项目）：桌面控制的旧版远程工作区清单只保存在控制端
> setting.json（`kind=remote`），远端 Source Server 自己的 `lastWorkspaceSession` 为空。
> 原 F8/M5 只读持库 Host 自己的清单，远端首次迁移建出 0 个项目，旧会话全部被判定为未归类，
> 而远端未归类会话不进入侧栏，升级后选择原目录只能新建空项目。现按 F8 例外处理：
> 持库 owner 不是 local 时，首次迁移也按历史任务目录建单 root 项目并归入。
> 已执行过 `0005_projects` 的库不补跑、不修复；migration ID 与 SQL checksum 不变。
>
> 2026-10-19 止血补充（同机多持库 owner）：同一台机器上本机桌面（owner=local）与 Source Server
> （owner=server）共用 `~/.zcode/v2/tasks-index.sqlite`。`0005_projects` 按库只执行一次，只写入
> 首个打开者的 host 行；后打开的 owner 缺少自己的 hosts 行，新建项目因 `projects.host_id` 外键失败。
> 每个 owner 每次启动在 `reconcileLegacy` 中幂等补齐自己的 host 行（`INSERT OR IGNORE`），
> 不改 schema、migration ID 与 checksum，不改任何任务的 `host_id` 与项目归属。
> 遗留问题（未修复）：旧行 `host_id IS NULL` 由首个处理者认领；local 按 workspace_key 形态判定，
> server 不看 key 全部归自己，A 本机旧会话可能被 Source Server 认领、SSH 旧会话可能被本机归入
> ssh 地址 host。认领规则与已错归数据的修正另行裁决。

状态：**实施中**（2026-09-10）。第 3 节是裁决记录（2026-09-09 至 09-10 与 维护者 逐条对齐），第 4 节起是按裁决展开的方案。实现前若发现与裁决冲突，以裁决记录为准并回来更新本文。实施边界、测试与进度见 [实施记录](../plans/2026-09-10-virtual-project-implementation.md)。

## 1. 产品结论（输入）

1. Group 与 Project 合并，产品中只保留 Project。
2. Project 不再等同于一个 Folder Path，而是按任务主题组织 Session 的容器；一个 Project 可以有 0 个或多个本地文件夹（Repo / Worktree / Remote Workspace 本次不做）。
3. UI 采用传统「项目 / 文件夹」层级，不采用 Chrome 标签组式。
4. 可以不先建 Project 直接建未归类 Session，之后拖拽移入 / 移出。
5. 移除 group 与 project 的公共管理入口。
6. 本地与远程 Session 不混合管理；远程项目与本地项目平铺展示，设备仅作为身份与连接信息。
7. 数据库改造是核心：丢掉 `tasks-index.sqlite`，收敛为单一数据源；迁移可降级、可跨版本、迁移前备份。

## 2. 现状（调研结论）

### 2.1 左侧列表的数据源今天有 4 个

```text
setting.json (~/.zcode/v2/settings/setting.json)
  ├─ recentProjects: string[]              本地路径历史（最多 10）
  └─ lastWorkspaceSession: Entry[]          真正的侧栏 workspace 列表（顺序 = 侧栏顺序）
       ├─ {kind:"local",  workspacePath, workspacePurpose}
       └─ {kind:"remote", workspacePath, workspaceIdentity, target(快照), lastConnectionStatus...}

tasks-index.sqlite (~/.zcode/v2/tasks-index.sqlite，注意文件名带 s)
  ├─ tasks                      title / searchable_text / pinned / archived / deleted / unread / status
  │                              PK = (workspace_key, task_id)
  ├─ task_groups                 group 元数据（title/color）
  ├─ task_group_members          task ↔ group（一 task 一组）
  ├─ task_group_view_node_orders 顶层混排顺序
  ├─ task_group_workspace_bootstraps  "按 workspace 自动建组"一次性标记
  ├─ off_peak_tasks              闲时任务
  └─ automations / automation_runs   定时任务

cli/db/db.sqlite (~/.zcode/cli/db/db.sqlite，CLI 自有，有正规 migration runner)
  └─ session / message / part / local_setting / session_task_link ...  会话正文与 CLI 侧状态

renderer localStorage
  └─ 视图偏好、折叠状态、workbench 分屏 group（与侧栏 group 无关）
```

UI 在 `useGroupedTaskView` / `useWorkspaceTaskLists` 里做客户端 join：`listGroupedTaskViewStructure` + `listTasks/listPinned/listArchived/...` + v4 `sessions-index` 实时帧 → 内存拼装。这就是 bug 多的根源。

### 2.2 `workspace_key` 的污染

- 口径：`workspaceKey = workspaceIdentity?.trim() || workspacePath`（`packages/shared/src/task-realtime-core.ts:92`）。
- remote 落库值形如 `remote:ssh:dev.internal:22:developer:/work/demo`，即把 ssh 账号写进了主键。
- 同一口径还被用于：`~/.zcode/v2/sessions/{hash}`、`agent-config/{provider}/{hash}`、CLI memory 目录 hash、web-remote bridge key、automation/off-peak 的 `workspaceKey` 字段。**改主键的同时这些派生 hash 也会变**，需要一并迁移或保留兼容映射。
- remote 的 `zcodeTaskService` 是 RPC 代理到远端 Host，写的是远端机器自己的 `tasks-index.sqlite`，本机没有远程 session 的索引副本。

### 2.3 现有迁移基础设施

- app 侧：**没有** schema 版本号、没有「上次运行版本」记录。sqlite 用 `CREATE TABLE IF NOT EXISTS + ensureColumn`，setting.json 用 zod preprocess 链就地迁移。
- CLI 侧：`schema_migration(id, checksum, app_version)` + 18 条顺序 migration（`apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts`），可以直接复用这套模式。
- 备份/压缩：已有 `yazl`（exportLogs、feedback）、`backupCorruptFile`、`copyDataDirectory`（basedir 切换用）。**没有**磁盘空间检查。
- 启动链：main `whenReady` → `mainSettingService.get()` → spawn cron scheduler → 建窗口 → Host `InitLocal` 时首次打开 sqlite。renderer 有 `RootStartupLoading`（`shouldShowRootStartupLoading`）可加一个 `isMigrating` 输入。

### 2.4 agent 侧「按目录解析」的配置清单（当前根规则）

| 配置                                    | 用户级                                    | 项目级路径                                                                  | 解析根                                  | 多层合并规则                                                                                   |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| settings（model/permission/ui/storage） | `~/.zcode/cli/config.json`                | `<dir>/zcode.json`、`<dir>/.zcode/config.json`                              | cwd 向上到 git root，根在前 cwd 在后    | 深合并，后者覆盖                                                                               |
| MCP servers                             | 同上 `mcp.servers`                        | 同上                                                                        | 同上                                    | 按 name：system → project → **user** → env → cli（用户级覆盖项目级）；project 来源标 untrusted |
| hooks                                   | `config.json.hooks` 直接可执行            | 同上                                                                        | 同上                                    | 项目级只生成 hookCandidate，走 workspace hook trust                                            |
| skills                                  | `~/.zcode/skills`、`~/.agents/skills`     | `<dir>/.zcode/skills`、`<dir>/.agents/skills`                               | cwd 向上到 git root 每一级              | 全部可见；同名先发现者胜（用户级 shadow 项目级）                                               |
| commands                                | `~/.zcode/commands`、`~/.agents/commands` | `<dir>/.zcode/commands`、`<dir>/.agents/commands`                           | 同 skills                               | 同名先到先赢 + duplicate diagnostic                                                            |
| subagents                               | `~/.zcode/cli/agents/*.md`                | `<cwd>/.zcode/agents/*.md`                                                  | **仅 cwd 本级，不向上**                 | Map 按 name，后加载覆盖（项目级覆盖用户级）                                                    |
| AGENTS.md                               | `~/.zcode/AGENTS.md`                      | `<dir>/AGENTS.md`                                                           | cwd 向上到 git root，**只取第一个命中** | user + workspace 两段拼接                                                                      |
| agent 自写 memory                       | —                                         | `~/.zcode/cli/memories/projects/<slug>-<sha(identity‖path)>/memory`         | 按 workspaceKey hash                    | 一目录一份                                                                                     |
| permissions ruleset                     | —                                         | sqlite `local_setting(scope=project, scope_id=projectIdFromDirectory(cwd))` | cwd 精确目录                            | 一目录一份                                                                                     |
| plugins                                 | `~/.zcode/cli/plugins` + `config.json`    | 项目 config 的 plugin 段                                                    | 同 settings                             | `resolvePluginConfigSources`                                                                   |
| workspace-config topic（设置页）        | —                                         | —                                                                           | key = `workspace-config/<workspaceId>`  | 一 workspace 一份                                                                              |

CLI 侧已有一份多工作区草案 `apps/zcode-cli/docs/design/v2/multi-workspace.md`（`WorkspaceScope{primaryRoot, additionalRoots}`、`--add-dir`、roots 存 `local_setting(scope=workspace)`），尚未实现，可作为本次 agent 侧改动的落点。

> 2026-10-10：远程单目录、无 Host 分组、项目先于会话、控制端统一混排的最新裁决见 [整合规格](2026-10-10-session-manage-upstream-integration.md)。本篇与其冲突的历史过程记录不再作为实现依据。

## 3. 裁决记录（2026-09-09 ～ 09-10，维护者）

### 3.1 概念与边界

| #   | 问题                      | 裁决                                                                                                                                                                                                            |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 侧栏两种形态              | 形态一 = 「项目 / 任务」两个区块；形态二 = 按时间排序（时间线）                                                                                                                                                 |
| A2  | 真实目录是否作为可见节点  | 不作为节点，只是项目的 root 属性                                                                                                                                                                                |
| A3  | 公共管理移除              | 移除 Group/Project 视图切换器、group 管理菜单与新建 group 入口、集中管理页；图 7 工具栏整体移除，排序（按时间 / 按项目）放入「项目」标题右键菜单；时间线保留实现但隐藏入口，归档入口与展开/折叠全部图标不再保留 |
| A4  | 视图模式                  | 只保留项目树 + 时间线                                                                                                                                                                                           |
| A5  | 「任务」区                | 未归类 session 的分类：`project_id IS NULL`，不限制绑定目录；session 一定有 workspace，全局新建任务默认创建 `~/.zcode/workspace/<唯一目录>` 作为 cwd；项目里的 session 只能拖到另一个项目，不能拖到项目外       |
| A6  | 同一真实目录属于多个项目  | 允许                                                                                                                                                                                                            |
| A7  | 0 root 项目新建 session   | 自动创建 `~/.zcode/workspace/<时间戳>`，并把它加为该项目的 root 且设为主要目录                                                                                                                                  |
| A8  | session 绑定目录（cwd）   | 创建后永远不变                                                                                                                                                                                                  |
| A9  | 项目内新建 session 的 cwd | 固定为主要目录，不提供选择                                                                                                                                                                                      |

### 3.2 运行模型与 agent 侧配置

| #   | 问题                                    | 裁决                                                                                                              |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| B1  | 运行模型                                | 单 cwd（session 绑定目录）+ 项目当前 roots 中除该 cwd 外的目录作为附加目录                                        |
| B2  | CLI 是否感知项目                        | 不感知，只收目录列表；`multi-workspace.md` 草案作废，数据结构由本文重新设计                                       |
| B3  | AGENTS.md                               | 只读 session 绑定目录链                                                                                           |
| B4  | skills / commands                       | 全部 roots 可用；同名并存标来源；模型也能看到全部 roots 的 skill                                                  |
| B5  | subagents                               | 全部 roots 加载，同名并存标来源                                                                                   |
| B6  | MCP（项目级 mcp.servers）               | 只读 session 绑定目录链                                                                                           |
| B7  | settings（model/permission/ui/storage） | 只读 session 绑定目录链                                                                                           |
| B8  | hooks                                   | 执行只跑 session 绑定目录链；设置页展示与 trust 按真实工作区                                                      |
| B9  | plugins 项目级配置                      | 只按 session 绑定目录链生效；其他 roots 仅在设置页扫描展示                                                        |
| B10 | permissions ruleset                     | 按 session 绑定目录                                                                                               |
| B11 | agent 自写 memory                       | 按 session 绑定目录                                                                                               |
| B12 | 工具路径策略 / 沙箱                     | 全部 roots 可读写                                                                                                 |
| B13 | composer @文件                          | 全部 roots 可 @，文件名右侧追加 root 名                                                                           |
| B14 | 实现原则                                | 保留 CLI 按 workingDirectory 的配置消费链；附加目录用于 skills、subagents、可写范围，并在环境 prompt 中仅列出路径 |
| B15 | roots 变更生效时机                      | 会话运行实例下次重建时生效；普通订阅、重订阅和网络重连不刷新运行实例的目录范围（见 4.3.1）                        |
| B16 | 同名 skill 标来源                       | CLI 赋予限定名（`<rootName>/<skill>`），prompt 与 UI 共用                                                         |
| B17 | 附加目录来源                            | Host 统一解析目录，覆盖 create / 显式 resume / V4 订阅触发的冷恢复；普通任务不存创建时目录快照（见 4.3.1）        |
| B18 | agent 管理页 / 定时闲时                 | agent 能力管理的 workspace 切换用真实工作区；定时任务、闲时任务、Bots 用虚拟项目                                  |

### 3.3 列表与交互

| #   | 问题                      | 裁决                                                                                                                                                                             |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 置顶                      | 保留全局置顶 session 区；项目也可置顶，置顶到全局置顶区并排在 session 之下；远程 session 也可置顶                                                                                |
| D2  | 拖拽                      | session 跨项目、从「任务」区拖入项目、项目排序；不做项目内手动排序与多选拖拽；目标项目不含该 session 的真实工作区时弹窗确认加入                                                  |
| D3  | 新建任务入口              | 项目行在该项目主要目录建草稿；Cmd/Ctrl+N 与左上角新建继承当前会话或草稿的项目，无项目才在自动创建的 `~/.zcode/workspace/<唯一目录>` 建未归类草稿；任务分区新建显式创建未归类草稿 |
| D4  | 项目右键菜单              | 编辑项目、置顶、删除项目；可编辑的远程项目与本地项目一致，不显示「从本机移除」「添加远程项目」；「从本机移除」只在不可编辑（离线 / error、legacy 单 root）时显示（2026-10-16）   |
| D5  | Web / 手机远控侧栏        | 都显示项目层级                                                                                                                                                                   |
| D6  | 右侧 workbench 分屏 group | 与本次无关，不动                                                                                                                                                                 |

2026-10-15 侧栏新建与展开规则：

- 项目分区、任务分区的新建按钮与项目行的新建 session 按钮右边缘对齐；深浅主题、桌面和手机共用布局。
- 项目分区新建按钮左侧提供「收起全部项目 / 展开全部项目」。有任一可展开项目展开时收起全部，否则展开全部；包含置顶项目。离线项目仍不可展开，不触发连接。无可展开项目时按钮禁用。
- 批量操作一次更新现有按 Host + projectId 索引的展开偏好，保留分区自身的折叠、排序和当前会话，刷新后保持。
- 当前会话的项目归属取 Host 的 task 索引，以 workspaceKey + taskId 精确查找，不能按 cwd 猜项目；当前草稿读取 draftProjectId。显式 projectId（包括 null）优先。桌面与手机在同一入口解析意图，手机仍由 bridge 准备目录并交接；异步读取后导航已改变则丢弃结果。
- 继承的本地项目必须仍存在于所属 Host 的有效项目列表。项目已删除时，历史会话保留原归属与当前页面；再次点击左上角新建或快捷键时创建未归类草稿，不把历史 project_id 当成有效创建目标。草稿继承同样复验项目；显式选择项目失败仍报错，读取失败不视为已删除。远端无项目创建门禁保持不变。

```text
快捷键 / 左上角新建 → 当前会话或草稿 → 项目归属 → Host prepareSession → 草稿
任务分区新建       → 显式无项目 ────────────────┘
全部收起 / 展开    → 现有 expanded 偏好 → 项目行展示（不导航、不连接）
```

### 3.4 新建 / 编辑 / 删除

| #   | 问题       | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 删除项目   | 软删除容器：项目行标记 deleted，session 保留 project_id，CLI 库不受影响（消息、标题原样）；时间线仍可见、可打开、可拖入其他项目；远程项目离线时的删除仅移除本机入口（G5），不执行本条的远端软删除；远程项目在线删除后保留本机入口，在线刷新把远端删除态写入入口缓存，离线或读取远端失败时不展示该入口，远端恢复后由下一次在线刷新清除                                                                                                                                            |
| E1a | 恢复       | 两个入口：① 新建项目时若 roots 集合与某个同 host 已删项目完全相等（不看顺序与主要目录）则提示恢复；恢复 = deleted 置 0 并按本次填写更新名称 / 主要目录，session 原样回来；拒绝则新建空项目。② 设置 → 项目的撤销与「已移除的项目」恢复（2026-10-24）：`IProjectService.restoreProject` 复用①的仓库恢复写路径并原样传回 roots，主要目录 / 置顶 / 顺序不变，重名加序号，不校验目录存在，见 `2026-10-24-project-management.md`。重新添加已从本机移除的远程项目入口不属于恢复远端项目 |
| E1b | 彻底删除   | 不提供；软删除项目永久保留                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| E2  | 移除 root  | 绑定该目录的 session 留在项目里                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| E3  | 运行中确认 | 删除项目 / 移除 root 不弹确认                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| E4  | 项目名     | 未手改则跟随首个 root 名（`name_overridden`）；同 host 内唯一，重名自动加序号；无 root 无名时叫「新项目」                                                                                                                                                                                                                                                                                                                                                                        |
| E5  | roots 校验 | 允许父子嵌套；完全重复去重；不存在的目录拒绝添加                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 3.4.1 新建项目默认排在最前（2026-09-15）

显式新建、恢复或添加的项目在当前控制端所属展示区首位；本地和远程统一混排。偏好键为 (hostId, projectId)，重连、刷新、改名保留位置。置顶与普通区分离，拖动不改 pinned，不向远端写 position。

Host 项目仓库在现有创建写事务中分配同 Host 的 `min(position) - 1`，该 Host 没有项目时为 0；不重排历史行，不按 UI 时间倒排，不在保存后再发一次 reorder。失败随同一事务回滚，串行 admission 下后提交的新建自然在前。Host 的 `projects.position` 提供首次展示和新项目批次的顺序；各控制端的既有侧栏偏好继续拥有手动显示顺序，不向远端回写。

2026-11-04 新项目同步补充：桌面、手机收到权威目录后，按完整 `(hostId, projectId)` 识别本端排序记录中尚未出现的项目，将它们按目录返回顺序插到已记录项目之前。已记录项目之间的相对顺序完全保留，包括暂时离线、隐藏后重新出现的项目；重命名、普通刷新和重复快照不重新置前。首次加载没有排序记录时直接沿用目录顺序。显式创建端原有 `prepend` 继续用于当前操作，其他端不依赖此本地回调，也必须在刷新与重载后保持新项目在前。置顶与普通项目仍各自成区。

此修复只改变共享侧栏偏好的合并规则，不同步各端完整手动顺序，不增加时间戳、定时器、服务字段或第二份项目状态；已有客户端记录过的项目不追溯重排。无 schema/迁移变更，本地与远端共用该规则，桌面 continuous、手机 replayable 及 workspace 身份边界不变。

```text
保存新项目 → Host 原子分配首位 position → 权威目录
                                           ├→ 桌面：未记录项目前插 + 保留旧手动顺序
                                           └→ 手机：未记录项目前插 + 保留旧手动顺序
手动拖拽 → 当前控制端侧栏偏好；重复目录 / 离线恢复 → 保留已记录位置
```

PRO01（accepted/pending）：已有项目时创建新项目，侧栏立即排首位，刷新后仍在首位；沿用 `workspace/projects/project-native-directory-picker.test.ts` 的真实创建路径。仓库单测覆盖空库、连续创建、手动重排后新建、编辑/恢复保序以及不同 Host 隔离。不以本地 E2E 声称真实手机/远端传输已验证。

PRO01 验证：`desktop-e2e-20260915130441227-p90013-a508c06fba08fa3a` 1/1 通过，断言保存后与刷新后的实际项目行顺序；相关单测 8 文件 / 54 项通过，root/E2E typecheck、lint（0 errors / 47 既有 warnings）、相对 HEAD 架构检查通过。默认 staging 基线仍有开工前既存的 root resolver unmanaged-new-file；真实远端/手机链路及 Windows/Linux GUI 未复跑。保持 pending。

PRO02：已有项目 A/B 的手动顺序与 Host 默认顺序不同；手机保存该既有顺序并保持 shared-host 连接。桌面新建 C 后，两端均显示 C 在前、A/B 相对位置不变；随后直接通过 Host 创建 D，验证两个接收端均将 D 前插。手机和桌面重载后顺序不变。浏览器回归另覆盖批量新增、重复目录、已知离线项目恢复和升级身份替换；不以浏览器模拟声明实体手机或远端操作系统已验证。

2026-11-04 验证：旧实现的桌面/手机浏览器前插断言均失败；修复后浏览器回归 3/3、真实 Electron + 390px 触摸浏览器 shared-host 的 PRO02 1/1 通过。证据见[覆盖矩阵](../../testing/conversation-session-e2e-coverage-matrix.md)。实体手机、Windows/Linux GUI 和真实 SSH/WSL 未在本次重跑。

### 3.5 数据归属

| #   | 问题                          | 裁决                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 单一数据源                    | 两库并存、每个字段唯一归属：**会话事实归 CLI，组织态归 Host**                                                                                                                                                                                                                                                                          |
| C2  | CLI 唯一写 db.sqlite          | 存在性与软删除、title + title_source、time_created/updated、正文、goal、fork、trace、last_outcome                                                                                                                                                                                                                                      |
| C3  | Host 唯一写 app 库            | `project_id`、pinned、archived、unread + CAS、`sort_order`、项目 / roots / hosts / 定时 / 闲时；这些组织态只存在原列，不做副本。CLI 事实以 `cli_*` 镜像列存放，唯一写者 taskIndexSyncer；Host 不再写任何推导时间 / 状态。旧列 `deleted`、`title_overridden+title` 在新设计中定义为「Host 的删除 / 重命名意图」，需交接给 CLI（见 7.4） |
| C4  | 标题离线重命名                | 经 CLI renameSession 命令，必要时拉起 CLI；成功后再镜像                                                                                                                                                                                                                                                                                |
| C5  | 归档                          | Host 独有；CLI 删除死列 `time_archived`（以 migration 标记废弃，不物理删）                                                                                                                                                                                                                                                             |
| C6  | 删除                          | CLI 软删除：新增 `time_deleted`，deleteSession 语义改为删除；冷种子 / listSessions / TUI 过滤；app `deleted` 列 = Host 删除意图（立即隐藏并待交接），`cli_deleted` = CLI 已确认；显示规则 `deleted OR cli_deleted`。snapshot 缺席不等于删除，必须经 `sessionsIndex/reconcile` 确认（见 5.2、7.4）                                      |
| C7  | 一轮结束结果                  | CLI 新增 `last_outcome` 与 summary 字段；app task_status 退为镜像                                                                                                                                                                                                                                                                      |
| C8  | searchable_text               | 保留现状                                                                                                                                                                                                                                                                                                                               |
| C9  | tasks-index 与 sessions-index | app 库 = 行集合 + 组织态 + CLI 事实只读镜像；sessions-index = CLI 权威实时活性流                                                                                                                                                                                                                                                       |
| C10 | app 库形态                    | 就地升级现有 `tasks-index.sqlite`，引入版本化 migration                                                                                                                                                                                                                                                                                |
| C11 | 主键                          | 物理主键保持 `(workspace_key, task_id)`；新增 `UNIQUE(host_id, task_id)` 作为逻辑键；新增 hosts 表                                                                                                                                                                                                                                     |
| C12 | 派生目录 hash                 | 保留不动                                                                                                                                                                                                                                                                                                                               |
| C13 | 远程组织态                    | 远端 app 库保存项目内容、roots 与 session 归属的权威数据；本机持久化 hosts 连接记录、已添加的远程项目入口列表及名称 / roots / 主要目录等基础信息缓存。入口列表归本机所有，缓存不替代远端组织态；未连接不可展开，离线删除只移除本机入口与缓存（见 4.2.1）                                                                               |
| C14 | 项目字段                      | 名称、roots、主要目录、置顶、排序、软删除；不要颜色 / 图标 / 归档 / 描述                                                                                                                                                                                                                                                               |
| C15 | 顶层排序                      | 项目区与任务区独立，不混排                                                                                                                                                                                                                                                                                                             |

### 3.6 兼容与迁移

| #   | 问题                                                                             | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 降级纪律                                                                         | 两库只加不删不改旧列语义；Host 拥有的组织态（`pinned/archived/unread/title_overridden+title/deleted` 意图）只存在于原列不复制；CLI 事实以 `cli_*` 镜像列存放；每次启动对全表做「旧列意图 vs 镜像」对账（见 7.4），不只补 NULL；`schema.baseline.sql` + CI 只增 diff；e2e 覆盖升级→降级（含修改既有行）→再升级                                                                                                                                                                                                                                                                                      |
| F2  | 兼容退场                                                                         | 三阶段，包袱不永久保留：V1 **只从新列/新表读**，旧列只写不读（双写仅供 V1 之前版本）；V2 写 `schema_floor=V1`、低于 floor 拒绝打开，停止双写与 setting.json 派生写回与 NULL 补齐，upsert 改用 `ON CONFLICT(host_id, task_id)`；V3 物理删旧列、旧 group 四表、CLI `time_archived`，重建主键 (host_id, task_id)。V2→V1、V3→V2 降级仍完整可用                                                                                                                                                                                                                                                         |
| F3  | 无归属 session 首次归位（首次迁移遗留、降级期新建、CLI 首次发现的新 session 等） | 仅在首次迁移或首次发现时判定一次：绑定目录恰好是同 host 下唯一一个未删除项目的 root → 归入；匹配零个或多个项目 → 保留 `project_id = NULL`，显示在任务区。不按主要目录优先选项目、不自动建项目、不改 cwd。全局新建任务显式保持未归类；已完成判定的 NULL 是合法组织态，后续启动、对账或新增项目不再自动归位                                                                                                                                                                                                                                                                                          |
| F4  | 降级期 group 增删改                                                              | 忽略；group→项目只在首次升级迁移一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| F5  | setting.json                                                                     | 继续双写 lastWorkspaceSession / recentProjects；远程条目从本机仍保留的远程项目入口派生，移除入口后清理对应旧条目，不从远端全量项目列表重新生成                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F6  | 执行位置                                                                         | main whenReady 后、起 Host 前同步执行；失败 fail-closed（重试 / 打开备份目录），不做第二套实现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F7  | 备份                                                                             | 定位：只保证「迁移失败 / 迁移把库写坏」时能恢复到升级前，不作为降级机制，也不作为通用数据保险；正常流程只产生不消费。做法：通用表级备份（见 7.1），仅在有待执行 migration 时、事务前，把这些 migration 声明的 `touchedTables` 在同一读事务里逐表导出到 `~/.zcode/backup/<版本>-<时间>/<库名>.sqlite`，写 backup.json，保留 2 份；不做整库快照（本机实测整库 770MB/12s，gzip 160MB/19s；表级 CLI 1.9MB/70ms、tasks-index 14MB/165ms）。当前卷不足依次试其他可写卷，都不足则跳过并提示，不删轨迹                                                                                                     |
| F8  | 老 workspace                                                                     | 本地及远端各自仅将旧 lastWorkspaceSession 中保留的项目 workspace → 同名单 root 项目，其下全部 session 归入；仅历史 tasks 或 recentProjects 中的目录不建项目，其任务保留原 cwd 与组织态，无匹配项目时保持未归类；本机 lastWorkspaceSession 中的 remote 条目只在首次迁移时导入本机远程项目入口及基础信息缓存，不在本机创建远端权威项目。远端例外（2026-10-15）：持库 owner 不是 local 时，首次迁移另把仍有未删除任务、不在 `*/.zcode/workspace/*` 系统目录下、且未被 settings 标为 conversation 的历史任务 root 建为同名单 root 项目并归入；远端项目只经本机入口进入桌面侧栏，推断不会复活已移除入口 |
| F9  | 手建 group                                                                       | 仅迁移包含未删除 session 的手建 group（归档成员有效），空/悬空/仅已删成员跳过；roots = 有效成员目录去重，主要 = 成员最多的目录；名字沿用并标 name_overridden；颜色丢弃                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F10 | 混合 host 的 group                                                               | 按 host 拆成多个项目，名字后缀 host 名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F11 | 系统组（定时 / 闲时）                                                            | 不转项目，成员归各自 workspace 项目，保留 cron / off-peak 图标                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F12 | 自动归档                                                                         | bootstrap 的 7 天强制归档随 Group 视图下线。设置页自动归档（`taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays`）必须继续生效：触发点是 Host 定时扫描（服务启动后首轮、之后每小时、两个自动归档设置键变更后立即补扫；2026-09-14 裁决，见文末），不挂在项目树查询或任何 UI 动作上；范围 = 当前 host 全部项目 roots 与任务区 session 的绑定目录（去重，含默认目录之外的 cwd；远程在远端 host 执行），判据（2026-09-15 裁决）：纯按时间，`cli_updated_at` 早于 N 天即归档；只有置顶与 syncer 观察到的运行中会话除外，不再看 completed / error / 未读                                            |
| F13 | 启动预热                                                                         | 只预热上次活动的目录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

#### 2026-10-15 旧执行后端会话可见性修复

项目树与既有任务列表/Controller 使用同一执行后端准入规则：只读取 `tasks.provider = ZCODE_AGENT_PROVIDER`（当前为 `glm`）的任务。此列是执行后端，不是模型供应商；新导入到当前 CLI 的会话仍保留，不能按 `migration_source` 或标题过滤。项目、置顶、未归类、时间线、归档与未读展示均消费该 Host 项目树，远端在所属 Host 执行相同读取。

根因：迁移为旧行补齐 `cli_*` 后，项目仓库漏掉旧列表的 provider 过滤，使旧后端行可见，Controller 操作前的列表却找不到它。修复只收口读取，不删除旧行、不重写 provider/时间/组织态、不改已发布 migration/checksum；已有迁移 ledger 的库同样立即生效。不按目录是否存在或是否打开 tab 隐藏正常历史。

```text
首次迁移 / 已迁移数据库 -> Host 按当前执行后端读取 -> 桌面 / 手机共享项目树
                       -> 原任务列表相同准入     -> Controller 任务操作
```

验收补充 VP28：旧后端的普通、置顶、归档行均不可见，数据库原行保持；正常 CLI 会话与新导入会话可见且可取消置顶/归档。覆盖首次升级、已有 ledger、本地与远端 owner；真实桌面升级和手机 shared-host 读取，零模型请求夹具不代表真实旧 CLI 执行。

### 3.7 远程与关联能力

| #   | 问题                  | 裁决                                                                                                                                                                                                                                        |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 远端旧库              | 远端 server bundle 升级时跑同一套迁移；本机新版连旧远端时按旧协议降级展示为单 root 项目                                                                                                                                                     |
| G2  | 远程单 root           | 创建时必须选择一个有效目录，创建后固定；本地仍允许 0..n roots                                                                                                                                                                               |
| G3  | 自动连接              | 启动自动连接所有已保存 host；连接成功后只刷新本机已添加的远程项目入口，不自动导入远端全部项目，也不重新添加已从本机删除的项目                                                                                                               |
| G4  | 上限                  | 远程 host 保存数量不设硬上限（2026-10-26）；连接执行继续受既有并发门禁控制                                                                                                                                                                  |
| G5  | 离线 / error 态操作   | 远程虚拟项目不可展开，不能改名、编辑 roots 或主要目录，项目操作仅允许删除本机保存的入口和缓存；保留远端项目、roots 与会话，不创建待同步删除操作。连接级仍允许重连、删除本机 host 连接记录；删除 host 一并移除其本机项目入口，不删除远端数据 |
| G6  | 重新添加远程项目      | 用户主动连接并选择远端已有项目后，重新建立本机入口并读取最新信息；仍访问原项目及会话。在线创建远程项目成功后也显式添加入口；常规重连或刷新不执行添加                                                                                        |
| H1  | 定时 / 闲时 / Bots    | 绑定虚拟项目；创建时取主要目录为 cwd、其余 roots 为附加目录，之后固定                                                                                                                                                                       |
| H2  | 设置页 agent 配置目录 | 所有项目 roots 去重平铺                                                                                                                                                                                                                     |
| H3  | composer # 提及       | 按项目分组                                                                                                                                                                                                                                  |
| H4  | 全局搜索              | 维持现状                                                                                                                                                                                                                                    |
| H5  | 手机远控 bridge key   | 维持 workspaceKey                                                                                                                                                                                                                           |
| I1  | 上线                  | 分 MR、同一版本发布                                                                                                                                                                                                                         |
| I2  | E2E                   | 项目 CRUD、拖拽与拒绝、升降级与备份、4.3.2 多目录恢复、自动归档在项目树下生效；任务区归属与首次归位覆盖 6.1 验收场景；远程离线入口管理覆盖 6.2 验收场景                                                                                     |

### 3.8 取消保存连接数量上限（2026-10-26）

已确认取消 G4 原有的 20 个远程 host 硬上限。历史或未完成连接记录也会计入该数量，
导致实际设备较少时，新连接在 SSH probe 前被拒绝。现在保存新连接、确认新 Source 身份
均不得因已保存记录数量失败；不使用更大的固定值替代。此变更不清理存量记录、不改删除语义。
连接实例、启动重连并发、凭据、身份校验与旧地址合并继续由现有 owner 负责。

```text
保存连接 → 原有输入与身份校验 → 事务写入 → 现有连接管理器 → SSH/WSL/Docker/Server
确认新 Source → 原有 membership 与确认校验 → 事务写入
```

验收 SSH-P0-CONN-10：已有 20 条保存记录时，真实 SSH 新连接及第二个同设备项目成功，
旧记录保留且同设备只占一条稳定 Source 记录；超过 20 条时仍可经确认新增不同 Source，
旧 Source 与入口不迁移。普通 SSH 双项目任务链与已有连接管理用例继续回归。

## 4. 目标架构

G1 按握手 virtualProjects 能力选择适配器，不以 RPC proxy 是否存在判断，也不把新版读取错误当作旧版。旧 Server 的项目列表从其旧 settings 中本地目录投影成稳定 ID 的单 root 只读容器，任务行仍读取远端 app 索引；conversation 目录的任务保持未归类。旧版仅在有效单目录项目内支持创建/恢复会话且附加目录固定为空；不展示项目编辑、置顶、排序、移动或创建多 root 的能力，不把这些操作缓存在本机。正常任务命令继续走现有远端 owner。

旧单 root 入口的 ID 使用明确的 legacy-single-root 前缀，仅是读适配器标识；Server 升级后，按已保留入口的单 root 唯一匹配真实项目，并在原 entry ID/版本上 CAS 换为真实 ID。零个或多个匹配保持未解析，用户显式选择；迟到响应仍不得新增入口。本机不会创建远端权威项目行。

旧 Server 不一定保存 Controller 的目录打开记录；适配器的目录候选同时接受本机仍保留入口里的 roots/旧 cwd。该输入只是旧协议查询的寻址信息，不创建远端或本机权威项目，不从已删除的旧 settings/history 重建入口。

套用同一物理连接及 logical attachment：

```text
server handshake → virtualProjects=true  → remote project RPC
                 → absent/false         → single-root read adapter
retained entry + request version → remote read → CAS refresh retained entry
```

### 4.1 概念模型

```text
Host（实体机）  local | remote:ssh:<host>:<port>:<user> | remote:wsl:<distro>[:<user>] | remote:docker:<c> | remote:server:<id>
 ├─ Project（本地 0..n roots；远程恰好一个固定 root）
 │    ├─ roots[]: {root_path, position, is_primary}
 │    ├─ name(+name_overridden) / position / pinned / deleted
 │    └─ sessions[]（project_id 唯一归属）
 └─ 「任务」区：project_id 为空的 session，不限制 root_path

Session
 ├─ 绑定目录 root_path（= CLI directory，永不变）  ├─ host_id  ├─ project_id?（可空）
 ├─ Host 组织态：pinned / archived / unread_at / sort_order
 └─ CLI 事实镜像：cli_title / cli_title_source / cli_updated_at / cli_created_at / cli_last_outcome / cli_deleted
```

普通分区由项目归属决定；置顶、归档和 session 删除继续按各自规则过滤。`~/.zcode/workspace/*` 是全局新建任务的默认执行目录，不是任务区筛选条件。

```text
Session（cwd 始终不变）
  |
  +-- project_id 指向正常项目 --> 项目区
  |
  +-- project_id = NULL ------> 任务区（任意 cwd）
  |
  +-- project_id 指向已删项目 -> 时间线（沿用 E1，保留归属）
```

### 4.2 进程与数据流

```text
CLI（每 workspace 一进程，可不在线）                      Host（每窗口一进程）                               Renderer
────────────────────────────────                         ─────────────────────────                          ────────
db.sqlite  ── sessions-index / conversation snapshot ──►  taskIndexSyncer ──写 cli_* 镜像列──► tasks-index.sqlite ──► useProjectTree()
  ▲                                                        ▲                                       ▲               （一次查询：projects ⨝ tasks，
  │ renameSession / deleteSession / createSession           │ pin / archive / read / move / project CRUD │                叠 sessions-index 实时字段）
  └──────────── Host 经 v4 命令写会话事实 ◄────────────────┘ Host 直接写组织态 ◄────────────────────────┘
禁止：CLI 写 app 库；Host 写 db.sqlite；Host 对 cli_* 列写 Date.now() 或推导值。
```

#### 4.2.1 本机远程项目入口与远端组织态

本机保存“用户已添加的远程虚拟项目列表”，用于侧栏展示；hosts 保存连接目标与重连所需信息。项目入口中的名称、roots 和主要目录是最近一次成功读取的缓存，只供离线展示与定位。项目内容、任务归属及运行目录仍由远端 Host 的 app 库提供权威数据，不能用本机缓存执行远端项目编辑或恢复任务。

```text
本机 hosts 连接记录 ----------------------> 重连指定 host
                                                |
本机已添加的远程项目入口列表                     v
  |                                  读取这些入口对应的远端项目
  +-- 离线：显示缓存，不可展开                   |
  |                                             v
  +-- 删除：移除本机入口与缓存 <------ 仅更新仍存在的入口缓存
                                                |
                                     不插入或恢复已移除的入口

远端项目 / roots / session 归属：本机离线删除不改变这些数据
```

- 本机项目服务提供明确的移除入口操作；它不调用远端项目软删除、session 删除或停止任务，也不写待同步删除队列。该操作与在线删除权威项目（E1）分开；在线删除遇到断线失败时，不得自动切换为本机移除并报告成功。
- 重连刷新只对仍存在的入口更新缓存，不使用无条件 upsert。用户在请求发出后删除入口，迟到的响应也不能重新插入；setting.json 写回以本机已提交的入口列表为准。

F5 的写入边界：`lastWorkspaceSession` / `recentProjects` / `lastActiveTabIndex` 由 Host 在 settings 文件锁内读取已提交的 projects/roots 与本机 remote_project_entries 派生，远端全量目录、tab 列表和重连响应均无权写入入口集合。旧字段只供降级使用；新版启动仅恢复新的 `lastActiveWorkspace`（可空），项目列表直接读取 SQLite。该字段只表达上次活动的执行目录，不创建项目或连接成员；初次升级可从旧 active index 取一次选择，之后不再回读旧字段。远程选择必须仍有本机连接成员；普通项目目录还必须属于仍保留的项目入口，conversation 目录仅要求连接成员仍存在。清空选择用显式 null，避免被旧字段重新填回。

settings 更新的文件锁覆盖完整的「重读最新配置 → 合并补丁 → 从 SQLite 派生 → 原子替换」，不只锁 rename；同一机器多个窗口的 Host 不得各自从旧快照覆盖其他字段。派生端口只读取本机数据库，不调用 settings、连接管理器或网络，避免递归和锁内握手。项目/入口 mutation 提交后等待兼容派生再广播；若兼容写失败，SQLite 提交仍有效，错误显式返回，下一次读取/更新重试派生。无远端删除队列。desktop continuous 与 mobile replayable 的会话通道和 owner 不变。

main 启动目录选择、Renderer 恢复和草稿预热均使用 lastActiveWorkspace 已绑定的 cwd。新版的独立 conversation cwd 不再套用旧的“归一到 default”规则；只有没有活动选择时才准备默认空白入口。

项目主目录失效时，侧栏标题置灰但可展开历史，新建与查看文件入口禁用；状态由所属 Host 实时派生，编辑入口保留。行为、刷新与新建复检边界见 [项目主目录可用性](../../project-primary-root-availability.md)。

```text
project / retained-entry mutation → SQLite commit → settings file lock
                                                    ├─ latest settings + latest catalog
                                                    └─ legacy projection → atomic replace → broadcast
renderer activation → lastActiveWorkspace ───────────┘
```

- 远端全量项目列表只用于用户主动选择添加项目；远端新增项目或旧项目名称 / roots 与缓存相同，都不是自动添加本机入口的依据。删除某个入口不删除 host 或同 host 的其他入口，删除最后一个入口也不影响用户之后重连并手动添加。
- 本机移除入口不触发 E1/E1a 的远端软删除或恢复逻辑。用户以后重新添加同一个远端项目时，使用原项目 ID，读取现有内容及会话。

保存的物理连接启动时均可进入现有重连批次，不按最近在线时间淘汰；继续尊重 `remoteStartupAutoReconnectEnabled=false` 和静默凭据要求，不为了项目展开新建 Agent。旧 workspace history 恢复逻辑 tab 的独立门禁不改变此物理连接资格。

连接成员关系与连接运行态分开：本机 remote-projects 是保存了哪些物理 Host/项目入口的唯一写者；现有 Source Directory 继续拥有 Profile 路由与凭据引用，ConnectionManager 继续拥有连接实例/重试。新建或显式重加连接获得不可变 `hosts.membership_id`；握手只可凭开始时的 membership ID 将旧地址 Host 合并为稳定 Source Host。移除再重加生成新 membership ID，旧握手不得复活或改绑新入口。合并与入口 host_id 调整在同一 app 库事务中进行；不移动远端权威项目、不复制 task 索引。已知稳定 Source 发生身份更换仍走现有显式确认，不把旧 Source 项目入口迁到另一台机器。

```text
显式保存 → Host membership ID → 现有 ConnectionManager 连接/握手
                              → 比较 membership ID → 合并到稳定 Source ID
移除连接 → 删除 membership + 本机入口
迟到握手 → membership 不匹配 → 丢弃，不能 INSERT
```

ConnectionManager 在 probe 前通过注入端口取得成员实例，握手确认之后、发布 online 之前提交绑定；拒绝时释放本次连接。用户显式连接可新增成员，启动及故障自动重连只能保留已存在成员，不能重新保存。用户确认 Source 身份更换时，在旧成员仍有效的条件下新增独立的新 Source 连接记录，旧 Source 及其入口留在原位；新 Source 单独计算容量。该条件检查与写入在同一事务执行。

本机入口服务的 connectHost 是已有连接器的窄重连入口，只针对仍保留成员；其装配端口使用 retain admission，不保存新成员或入口。连接状态从 ConnectionManager 读取并附加在 readDirectory 结果中，不落 SQLite、不另建状态机。scope 内当前服务不支持连接管理时显式拒绝。

URL Server 的物理连接仍由 WindowRemoteConnectionRegistry 唯一持有。项目查询/启动重连通过 Registry 的 Host 连接入口，不创建 logical session 或 Agent；打开执行目录时才创建 workspace attachment，并复用同一物理连接。Registry 提供当前连接的只读枚举和稳定 Source 查询，不新增连接状态存储。SSH/WSL/Docker 继续由原 SourceManager 持有物理连接。

URL 握手前保存/取得 Host membership，token 只进 CredentialService，hosts 只存 credential key。自动重连只读已有成员和凭据；已移除/重加的旧握手必须失效。URL 未知 serverId 时的地址身份可在首次握手后绑定稳定 Source，绑定同时固化 target.serverId；已有 serverId 发生变化显式报错，不把旧项目迁走。连接失败释放尚未发布的 socket；同一 URL/稳定 Source 的并发请求复用 Registry owner。移除成员不终止现有 task，但禁止新目录/项目连接和自动重连。桌面 continuous 与手机 replayable 继续走同一个既有 workspace owner。

```text
saved URL member → credential lookup → Registry physical connection → membership CAS
                                                       ├─ project read (no logical session)
                                                       └─ workspace attachment → existing task owner
```

远端连接列表只枚举有可用连接目标的本机 hosts 记录；历史 task 影子所需的 target_json=NULL 身份占位不表示用户保存了连接，不展示；保存连接不设数量上限。缓存刷新始终推进比较交换版本，内容未变时不发项目变更广播，避免 read → refresh → broadcast → read 的反馈循环。

迁移的旧 workspace 入口只在同 Host 唯一项目包含旧 cwd 时解析项目 ID；零个或多个匹配保留待选择入口。多个旧 cwd 解析到同一项目时保留已解析入口的 ID，删除重复旧入口；该去重与 CAS 刷新同一事务执行。侧栏只聚合本机保留入口的远端项目和任务；保存 Host 下的未归类任务进入任务区，已软删项目的历史仍进时间线。离线不展示或缓存远端 task 索引。

侧栏读取先取本机入口目录（`remote-projects.readDirectory`），再并行读取本地树和各远端 Host 树；单个 Host 读取失败只影响该 Host。入口目录读取或入口缓存刷新失败时（2026-10-21）：

- 本窗口还没有成功读取过目录（冷启动）：本地项目树照常展示，远程项目本轮不展示，侧栏显示已有的错误行；下次刷新（项目变化、tab 变化、窗口获得焦点）重试。禁止让入口目录故障把本地项目一起清空。
- 已有成功读取的快照：保留上一次完整快照（含远程项目）并显示错误行，不清空远程部分。远程项目在一轮中消失会取消进行中的远程任务导航、卸载项目编辑表单、挂起首发提交。

直接接入远端 owner 的 Web/客户端，projectService 返回该 owner 的权威树，remote-projects 入口查询返回空目录；不能伪造 Controller 成员表，入口写命令拒绝。桌面窗口的 Controller 查询仍使用本机 base attachment，与 workspace-scoped 的远端服务分开。

### 4.3 与 CLI 的接口（B14 增量）

附加目录是项目中除会话默认工作目录外、供该任务一起使用的其他文件夹。例如项目包含前端和后端两个目录，任务绑定前端目录时，后端就是附加目录。新建任务和重启后打开历史任务都必须完整加载对应目录提供的能力。

```text
createSession / 显式 resume / v4/conversation/subscribe 参数新增（可选）
  additionalDirectories: string[]        // Host 解析的目录列表；本地绝对路径或远端实际路径
                                        // 仅初始化运行实例时消费；live subscribe 不更新目录范围
CLI 消费点
  1. skillPort.discoverSkills/loadSkill(roots?)  → 为每个附加目录追加 <dir>/.zcode/skills、<dir>/.agents/skills、<dir>/.zcode/commands
                                                   来自附加目录的 skill.qualifiedName = `${basename(dir)}/${name}`；prompt 与 mention 列表使用 qualifiedName
  2. subagents roots                             → 追加 <dir>/.zcode/agents；同名并存，qualifiedName 同上
  3. tool path policy                            → additionalDirectories 并入可读写根
  4. 环境 prompt                                 → 仓库状态之后列出 Additional working directories，仅含路径；空列表不输出
不变：AGENTS.md、config(settings/mcp/hooks/plugins)、memory、permissions 仍只按 workingDirectory 解析。
```

环境 prompt 使用本次运行实例初始化时收到的 `additionalDirectories`，逐项保留路径，不扫描附加目录内容、不增加权限说明。该列表经 Runtime 配置透传，随环境公告的快照 metadata 写入会话历史，不新增 session 字段或数据库列；目录变更仍按 4.3.1 在运行实例重建时生效，冷恢复后按最近一次公告追加 `Additional working directories added/removed` 增量，原环境块不改写。格式见 `apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`。

#### 4.3.1 目录来源与生效时机

普通新建会话恢复 `sess_${crypto.randomUUID()}`，后缀为带连字符的 UUID v4，不再使用命令哈希。V4 命令工厂只分配一次，pending payload 与重试保留原 ID，Host 以该 ID 预留归属。3.16 已落库的 `session_<32hex>` / `session_<UUID>` 作为不透明身份原样恢复，不迁移主键、不生成别名。读取、引用与邮箱兼容规则见 [Session identity compatibility](../../session-context-tool.md#session-identity-compatibility)。

创建时序：UI 只传选中的 `projectId`（全局创建显式为 NULL）；Host 按 create command 的幂等 ID 分配稳定 session ID，在 app 同一事务预留归属并读取目录，然后才向 CLI 发送 create/firstInput。预留行的 `cli_created_at` 为空，所有列表隐藏，直到 CLI 发布持久会话事实。重复 create 不覆盖已经移动过的归属；失败不伪造会话事实。CLI 不接收项目 ID，只接收 session ID 和 `additionalDirectories`，并拒绝覆盖已存在的运行实例或持久会话；命令重试仍由 CommandInbox 去重。

```text
选择项目 → Host 预留 session 归属 + 读取 roots（事务）
                         ↓
         CLI CommandInbox 去重 → 创建 runtime → 首条输入 → 持久事实
                         ↓
                  Host 镜像后列表可见
```

#### 4.3.1a Fork 的首次项目归属（2026-10-30）

显式 fork 在 Host 首次接纳子会话时继承父会话当时的项目归属。同目录可以属于多个项目，不能以目录唯一匹配替代已知父会话的归属；父会话明确未归类时，子会话也保持 NULL。父子关系来自 CLI 持久事实，实时 sessions-index 与按 ID reconcile 均传递 `parentSessionId`，CLI 不接收项目 ID。

Host 在子行首次写入的同一个事务内，以可信 hostId、workspaceKey 和 parentSessionId 读取父行并写入子行归属及首次判定位。已完成归属判定的行（包括 NULL）保持原值；重复摘要、ACK 重放、对账或重启不能覆盖用户后续移动。父行缺失、身份不符或所引用项目缺失时明确失败并回滚本次首次入库，不按目录猜项目、不把错误转换为已决定的 NULL。普通非 fork 发现继续使用既有唯一 root 规则；不改 cwd、CLI 时间、标题、置顶、归档或未读。旧版本已决定的空归属不批量重算，通过现有移动项目操作修复。

```text
CLI fork / 持久恢复 → 父子关系（summary / reconcile）
  → Host 写事务：首次子行 + 同 Host/workspace 父归属 + 首次判定位
  → 提交 → 列表广播 → 父项目内显示子行
重复帧 / 重连 / 重启 → 已决定归属 → 保留用户组织操作
桌面 continuous / 手机 replayable → 同一持库 Host 的首次接纳规则
```

验收 TSL41：A、B 共用一个目录，父会话属于 A；真实 fork 后立即断言子行 project_id=A、仅在 A 的 DOM 容器出现，不在 B 或未归类区。切走与重启后重复断言；手动移到 B 后再同步/恢复不得被拉回 A。父会话未归类、首次对账与实时摘要先后、父行缺失/身份隔离、重复首次接纳使用同一事务规则验证。测试保存持久归属和项目容器证据，不能只断言 workspace 下有记录或全页面存在任务行。

项目归属与 roots 的唯一持久来源仍是 Host 的 app 库。Host 项目服务提供统一目录解析逻辑，供创建、显式恢复和 V4 冷恢复入口复用；CLI 只接收目录列表，不读取 app 库、不理解 project_id，也不新增普通任务的 roots 持久化副本或目录同步协议。新版 Host 在解析成功后显式传入数组（含 `[]`）；字段可选只为兼容旧调用，不能用省略参数掩盖查询失败。

- 新建普通任务：Host 使用本次选定并校验的项目；恢复普通任务：按任务的 workspaceKey + taskId 查询其明确的 project_id，再读取项目当前 roots。不能按 cwd 猜项目，因为同一真实目录可以属于多个项目。一次读取中的任务归属与 roots 必须来自同一数据库读快照。
- `additionalDirectories = 项目当前 roots 去重后排除 session 固定 cwd`。排除的是会话绑定目录，不是项目当前主要目录；换主要目录或从项目移除原 cwd，都不改变历史任务的 cwd。路径规范化与去重复用所在 Host 的平台路径规则。
- 未归类任务明确使用 `[]`；软删除项目仍保留归属与 roots，历史任务沿用这些 roots 恢复。三种缺失分开处理：app 库无该 task 行（TUI 新建、sessions-index 先于 seed 到达）视为未归类传 `[]`；行存在但 `project_id` 指向不存在的项目 → 显式报错；app 库读取失败 → 显式报错。报错必须冒泡到 UI（错误提示 + 重试），不得当作 `[]` 启动不完整的运行实例，也不得静默失败。
- 定时任务、闲时任务和 Bots 沿用 H1：Host 从该能力创建时固化的配置提供 cwd 与附加目录，恢复时也不重新取项目当前 roots。生成新 session 的归属预留同事务写入 `tasks.execution_directories` 不可变快照（nullable TEXT JSON）；普通 session 为 NULL，仍从项目当前 roots 解析。该快照属于生成 session 的初始化配置，唯一写者是 Host 创建预留；删除调度/Bot 定义或重试预留不得清除/覆盖，手动打开历史任务的三种恢复入口也读取它。它不是普通项目 roots 的同步副本。会话内绑定定义沿用既有 session，不把工作会话改成永久冻结目录。
- CLI 仅在创建或真正重建会话运行实例时使用传入列表，作为本次运行的固定初始化参数。运行实例已存在时，普通订阅、重订阅、手机重连及显式 resume 的复用路径均不刷新目录；项目编辑或任务移动的影响在下次重建时生效。多个订阅并发恢复同一会话，复用现有 Gateway READY / cold-resume single-flight；本次恢复采用一次确定的目录列表，后续订阅不合并或覆盖它。
- 远程任务由拥有该项目组织数据的远端 Host 解析，传递远端实际路径；workspaceIdentity、remoteSessionId 和可信 clientMode 继续沿现有 attachment 链路传递。桌面保持 desktop-continuous，手机保持 web-remote-replayable，并共享原有会话运行实例。

```text
Host app 库：任务归属 + 项目当前 roots（唯一配置来源）
                         |
                Host 统一解析目录列表
                         |
          +--------------+-------------------+
          |              |                   |
       create        显式 resume        V4 subscribe
          |              |                   |
          +--------------+-------------------+
                         |
               CLI 是否已有运行实例？
                 /                 \
               否                   是
               |                    |
      使用目录列表初始化一次      复用现有实例和目录范围
               |
       本次运行期间目录范围固定
```

实现落点：在 Host 的 `subscribeConversationV4` 发出请求前调用同一目录解析逻辑；可沿用已有 `resumeThoughtLevel` 的参数传递路径，但目录查询错误不能被静默吞掉。同步更新 `packages/shared/src/zcode-protocol/index.ts` 的 create/resume schema 和 `packages/shared/src/zcode-protocol-v4/transport.ts` 的 subscribe schema；将 `additionalDirectories` 贯穿 Gateway → `ColdSessionResumeCoordinator` → `resumePersistedSession` → `activateSessionForResume`，在运行实例构建前交给能力与环境 prompt 消费点。Host 通过服务接口注入解析能力，Renderer 不负责拼装目录列表。

实施补充（2026-09-10）：当前 rowsRange / search 等查询也可能先于 subscribe 触发冷恢复。该路径复用既有 `session/requestRuntimePreferences` 的 runtime-materialization 请求，从 Host 同一目录解析接口取得 `additionalDirectories`；不建立另一个目录缓存或同步协议。显式 create/resume/subscribe 的数组仍只在新实例初始化时使用；Host 查询失败必须拒绝初始化。该反向请求已由 READY single-flight 覆盖，因此查询与订阅竞争时只读取一次目录快照。

子会话冷恢复补充（2026-10-22）：CLI 统一从持久化 `sessionKind / parentSessionId` 解析
`directorySessionId`，沿四类 auxiliary 父链到最近的独立任务；interactive、fork、workflow_parent
均停止继承。逐层校验 workspace identity 与 cwd，拒绝缺失、已删、成环或跨 workspace 的父链。
历史 child 缺少 identity 时，仅允许同 cwd 的持久化父链证明归属。查询不激活父 runtime、不回写两库。

Host 在现有 runtime/capabilities 请求中声明 `hostCapabilities.sessionDirectorySource`；CLI
确认同名能力后，才在显式 session/list 元数据和 runtime-materialization 回调中携带
`directorySessionId`。旧 Host 不收到新字段；旧 CLI 仍走现有元数据父链查询，完整冷恢复修复
要求双方支持该能力。协商随 CLI 连接重建，不保存项目或目录副本。

```text
CLI 持久化父链 → directorySessionId ─┬─ session/list → Host 订阅 / 显式恢复
                                    └─ 冷恢复反向请求 → Host 本地 / 外部设置应答
                                                         ↓
                                             同一项目仓库校验并读取目录
                                                         ↓
                                             初始化原 child，目标 ID 不变
```

冷恢复反向请求必须自带归属事实：CLI 正等待 Host 回包，此时 Host 再发 session/list 会排在
当前请求之后，造成循环等待。Host 回调只读自身项目仓库；不增加并发协议旁路、重试计时器、
child 主任务行或目录缓存。新建独立任务仍使用已经预留的自身 ID，自动化固定目录合同不变。
复现与验收要求见 SAT30：真实进程退出后重开 child，检查正文、原 ID、主列表隔离及两种 delivery 模式。

#### 4.3.2 本地多目录恢复验收

远程项目固定单目录，下表涉及附加目录/更换 roots 的场景仅适用于本地；远端创建及冷恢复均要求空附加目录，禁止用改项目目录验证远端恢复。

| 场景                                                                         | 预期                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 项目有主目录 A、附加目录 B；创建任务后重启 CLI，再仅通过 V4 订阅打开历史任务 | cwd 仍为 A，B 的技能、subagent 与工具目录范围和显式 resume 一致；不能只验证列表显示 |
| 运行中把项目附加目录 B 改成 C，再切页或手机断线重连                          | 当前实例仍使用 B；运行实例重建后才使用 C                                            |
| 项目主要目录从 A 改成 B，再冷恢复绑定 A 的历史任务                           | cwd 仍为 A，B 作为附加目录；不能按新主要目录排除 B                                  |
| 两个项目都含 A，但分别附加 B、C；两个任务 cwd 均为 A                         | 各自按明确 project_id 取目录；同一 CLI 进程内不同会话也不串用目录范围               |
| 桌面与手机并发订阅同一冷会话                                                 | 只初始化一个运行实例，两个订阅共享本次目录范围，保留各自 delivery profile           |
| 未归类任务、已软删除项目的历史任务、项目查询失败                             | 分别使用空附加目录、保留项目的 roots、显式错误；不能把这三种情况合并成空目录兜底    |
| 修改项目 roots 后恢复已有定时任务、闲时任务或 Bot                            | 继续使用该能力创建时固化的 cwd 与附加目录                                           |

协议与 CLI 单测覆盖参数贯穿、目录消费及并发恢复；Host 单测覆盖归属解析、路径去重和失败分支。E2E 覆盖桌面与手机、本地与远程的创建和冷恢复入口，并验证附加目录不会改变 AGENTS.md / settings / MCP / hooks 的绑定目录规则。所有远端固定单 root；旧远端能力降级仍按 G1，不展示多目录操作；上述均为实施阶段待执行的验收项。

## 5. 数据模型

### 5.1 app 库 `tasks-index.sqlite`（只加法，V1）

```sql
CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hosts (
  host_id TEXT PRIMARY KEY,            -- 'local' | remote authority（identity 去掉 path 部分）
  kind TEXT NOT NULL,                  -- local|ssh|wsl|docker|server
  target_json TEXT,                    -- RemoteTargetSnapshot（凭据仍在 credentials.json）
  position INTEGER NOT NULL DEFAULT 0, last_connection_status TEXT, last_connection_error TEXT, last_opened_at INTEGER);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(host_id),
  name TEXT NOT NULL, name_overridden INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_roots (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  root_path TEXT NOT NULL, position INTEGER NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, root_path));
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_host_name ON projects(host_id, name) WHERE deleted = 0;
-- tasks：ensureColumn 追加，全部可空
ALTER TABLE tasks ADD COLUMN host_id TEXT;            -- 由 workspace_key 推导，NULL=旧版本写入
ALTER TABLE tasks ADD COLUMN root_path TEXT;          -- = workspace_path
ALTER TABLE tasks ADD COLUMN project_id TEXT;         -- 可空；软删除项目仍保留
ALTER TABLE tasks ADD COLUMN sort_order INTEGER;      -- 预留（本次不做手动排序）
ALTER TABLE tasks ADD COLUMN cli_title TEXT;          -- 镜像列；旧列 title/title_overridden/updated_at/task_status 继续按旧语义写
ALTER TABLE tasks ADD COLUMN handoff_pending INTEGER NOT NULL DEFAULT 0;  -- 位标志：1=删除意图待交接 2=手动标题待交接 4=CLI 无此 session(orphan) 8=空归属归位已判定
ALTER TABLE tasks ADD COLUMN cli_title_source TEXT;
ALTER TABLE tasks ADD COLUMN cli_created_at INTEGER;
ALTER TABLE tasks ADD COLUMN cli_updated_at INTEGER;
ALTER TABLE tasks ADD COLUMN cli_last_outcome TEXT;
ALTER TABLE tasks ADD COLUMN cli_deleted INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_host_task ON tasks(host_id, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, archived, cli_updated_at DESC) WHERE deleted = 0;
```

镜像列与旧列的关系：Host 组织态（`pinned/archived/unread/title_overridden/deleted` 意图）**只有原列**，无副本。CLI 事实：代码只读 `cli_*`，旧列 `title`（非 override 时）、`updated_at`、`task_status` 仅供 V1 之前版本读，由 syncer 双写。显示规则：标题 = `title_overridden ? title : cli_title`；隐藏 = `deleted OR cli_deleted`；排序 = `cli_updated_at`。automations / off_peak_tasks 增加可空 `project_id`、`host_id`。

运行时删除接受整份 `TaskMeta` 的通用持久化入口。恢复快照只更新模型、目标、错误详情和搜索正文；标题、时间、存在性和结果必须先经 CLI reconcile 摄入。无持久事实的草稿只返回临时展示值，不插入列表。Claude 导入必须先创建真实 CLI session，再通过同一事实入口摄入；备份 JSON 不承担索引写入或复活删除会话的职责。显式再次导入创建新的 CLI 会话 ID，不按外部来源 hash 覆盖已有或已删除会话；旧确定性 ID 只用于已有备份的读取与修复。回归测试人为污染旧事实列与 `meta_json`，验证所有列表排序、搜索和展示仍只读镜像。

旧 `session/create` 与 V4 创建也共用归属预留：Host 在 wire 请求前生成会话 ID，并原子保存 project_id（未指定时为 NULL）；CLI 接受尚不存在的分配 ID，统一拒绝覆盖内存、持久化或正在创建的同 ID。创建期间只保留短期 ID 占用，失败即释放；它不接收用户输入，不构成第二个命令队列。V4 幂等结果仍由 CommandInbox 保存。旧 native 创建的附加目录由 Host 归属解析，定时/闲时等已固化配置沿显式参数传递。

### 5.2 CLI 库 `db.sqlite`（新增 migration 0020）

`0019_dwf_journal` 已被历史版本占用，本次使用 `0020_session_soft_delete_outcome`，不改历史 SQL 与 checksum。

```sql
ALTER TABLE session ADD COLUMN time_deleted INTEGER;   -- 软删除
ALTER TABLE session ADD COLUMN last_outcome TEXT;      -- completed|error|interrupted，turn 结束时写
-- time_archived 保留列，代码标记 @deprecated，不再读写
```

`listSessions` / sessions-index 冷种子增加 `time_deleted is null` 过滤；`SessionSummary` 新增可选 `lastOutcome`，冷种子 phase 由 `last_outcome` 推导（NULL 回退 completedSuccess）。v4 `deleteSession` 改为写 `time_deleted` 并 closeSession，发 `session.removed`。

新增请求式命令 `sessionsIndex/reconcile { workspaceId, sessionIds[] }` → 每个 id 返回 `{ exists, deleted, title, titleSource, updatedAt, lastOutcome }`（含软删除行）。用途：Host 订阅 snapshot 后对「本地未标删除但 snapshot 缺席」的行对账，以及交接后的回读校验。snapshot 缺席本身永不导致 app 删行。

### 5.3 本机远程项目入口与缓存

在本机 app 库单独保存入口及基础信息缓存，避免把它们作为远端 `projects` / `project_roots` 的第二份可编辑组织态。连接参数继续保存在 `hosts.target_json`，凭据仍沿用现有凭据存储。

```sql
CREATE TABLE IF NOT EXISTS remote_project_entries (
  entry_id TEXT PRIMARY KEY,              -- 本机入口身份，离线移除按它定位
  host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
  remote_project_id TEXT,                 -- 远端项目 ID；旧 workspace 待解析时可空
  cached_name TEXT NOT NULL,
  cached_roots_json TEXT NOT NULL DEFAULT '[]', -- 最近读取的 roots / 顺序 / 主要目录
  legacy_workspace_json TEXT,             -- 首次迁移时保留原 workspace 路径与 identity
  last_synced_at INTEGER,
  UNIQUE (host_id, remote_project_id));
```

首次迁移的旧远程 workspace 可在尚未连接时保存入口及原始标识；连接成功后，只对仍存在的入口解析远端项目 ID 并更新缓存，旧远端沿用 G1 的单 root 展示。入口新增只来自首次迁移、用户明确添加或在线创建项目成功；普通刷新没有创建入口的权限。删除入口即删除这一行及其缓存，重启后也不从旧 setting.json 或远端列表重建。该表不保存远程 session 索引、任务内容或待执行的远端删除意图。

项目服务在 base attachment 上按显式 `hostId` 路由。当前 Host 的请求进入自身仓库；其他 Host 只从现有连接管理器取得在线的项目服务代理，断线直接失败，不落本机库。读取远端树后通过既有 Source workspace identity 解析登记 canonical/stable 映射。手机也复用该 base attachment 路由，不申请被禁止的 source-settings attachment，不创建新的 runtime。

workspace attachment 同样转发远端项目服务，入口目录始终从 Controller base attachment 读取。新增服务不加入旧版 v1 必需频道集合，避免旧 Server 因缺频道连不上；握手以可选 `capabilities.virtualProjects` 明确声明新能力，缺省代表旧版单 root，不能仅凭客户端生成的代理对象判断远端支持。远端全局新建每次分配独立 cwd，已经绑定任意 workspace 的 logical session 不得重绑到新 cwd；复用同一物理连接并新建 logical attachment。

项目树包含未打开 tab 的远端任务。其列表命令复用 Window Controller 的 mutateTask 路由：以稳定 Source + workspaceIdentity 定位现有在线物理连接，先读取该 owner 的任务行验证地址，再执行同一 task service；重命名也转交原 CLI 命令。查询和 pin/archive/read 不为列表创建 logical workspace、切换 tab 或启动 Agent。打开会话时才建立/复用 workspace attachment，手机仍走 shared-host replayable switcher；不能为未打开 tab 的列表命令伪造 remoteSessionId。离线或身份不匹配直接拒绝，绝不落本机。

本机入口管理收口到 `remote-projects` 服务契约：`readDirectory / saveHost / removeHost / addEntry / refreshEntry / removeEntry`。项目服务只处理持库 Host 的权威项目，入口服务不接收任务索引或远端写操作。新增入口产生新的 entry ID；缓存刷新必须携带请求发出时的 entry ID 与 lastSyncedAt，SQL 只 UPDATE 并做比较交换。入口删除后，迟到响应不再有写入目标；移除后主动添加同一 project ID 会产生新 entry ID，旧响应仍不能覆盖它。Host 删除与所属入口删除在同一 SQLite 事务。保存新连接和确认不同 Source 身份均不按已有 host 数量拒绝；同一 host 的更新、地址身份合并和 membership 校验保持原合同。连接运行态继续归现有连接管理器，凭据继续归凭据服务，不能保存在 target JSON。

```text
显式添加 → 本机入口行（新 entry ID）→ 发起远端读取
                                      │
移除入口 ────────────────── DELETE    │
                                      ↓
迟到读取 → UPDATE WHERE entry_id AND last_synced_at → 0 行，无重建
```

连接 admission 每次 await 后都要复查取消与当前 owner：在线连接复用也不能在成员提交等待后返回已断开的旧对象。新建 transport 在发布 online 前由当前 connect 调用独占；目录记录、身份确认或成员提交任一失败，都通过同一清理路径释放未发布连接。未发布连接的 close 不能触发另一个已在线连接的恢复逻辑；发布前已关闭则拒绝。

自动化与闲时定义的 `project_id / host_id / additional_directories` 在创建提交时固化。表单选择项目只提交项目 ID，Host 用项目服务解析 cwd 与附加目录；无效或已删项目必须在取号/落定义前失败。定时调度、重试与闲时恢复读取已保存配置，不重新按项目当前 roots 求值；项目之后的 roots 编辑不修改这些定义。会话内绑定任务的既有语义继续保留，绑定不会因目录选项重构变成新建会话。绑定 task 与新选项目不得同时提交。派发携带 Host 已保存的附加目录（含明确空数组），归属预留仅校验项目仍存在且同 Host，不再用当前 roots 或软删除位否定既有定义；普通新建仍校验当前 roots 和未删除项目。CLI 仅接收目录，不接收项目 ID。

## 6. UI 行为要点

### 创建后选择草稿项目（2026-10-16）

侧栏「新项目」与草稿左上角项目菜单共用创建完成行为：项目保存成功（远端还需登记本机入口）并刷新目录后，若发起时的聊天仍是同一草稿，自动选中新项目。沿用 Root/Host 项目导航，保留当前草稿的正文、富文本 mention、附件和分组意图，不发送消息。普通手动选择项目仍按各工作区恢复草稿。已有会话、创建失败、取消、添加已有项目和编辑项目不触发此动作。

```text
ProjectEditor 保存 → ProjectCreation 登记并刷新 → 校验原 tab / workspace / 草稿代次
                                               ├─ 同一草稿 → 读取编辑器快照 → Root 准备新项目 → 恢复正文与附件
                                               └─ 已切换或发送 → 仅保留创建结果
```

项目和目录仍归 Host；组织意图仍归 session store，正文归 composer draft owner，附件归现有上传 owner。快照仅作 renderer 内存中的一次性交接命令；正文写目标草稿，附件使用原始 File/路径在目标重新准备，不复用旧 session 的上传引用，也不新增附件落盘。手机 Root 重建后使用相同交接命令；附件交接只允许目标草稿的同一代次消费一次。准备失败时源草稿保持原状。保存或刷新期间切换 workspace、选择会话或重建草稿后，迟到结果不能切换当前工作区。桌面与手机复用同一完成动作，各自沿用 continuous / replayable 导航。验收 PCD01–03 覆盖本地/远端完成、两种入口、草稿失效及失败隔离。

实施清理：新项目树替代旧 WorkspaceSidebarItem、SortableWorkspaceSidebar、旧 Timeline/Pinned/Archived 分区与 useWorkspaceTaskLists；引用审计确认无生产调用后删除，不保留并行任务列表聚合和 workspace/group 排序状态。共享的任务行展示、workbench 拖拽、搜索和 Header 仍使用原公共能力。逐条引用稳定化继续复用既有 taskListItemStabilization：相同快照不重建整树，项目归属或 activity 真正变化才更新相应行；Host + 项目 ID、workspaceKey + task ID 分别作为身份。

旧 workspace store 的 draftSessionId / setDraftSessionId 已无生产写入者，随旧 session 管理路径删除。预热 session 只由 V4 pane 持有；项目、技能或插件变化通过 workspaceIdentity 隔离的失效版本通知 pane 回收并重建。配置 UI 不直接 close 草稿 session，不向全局 store 复制运行态 ID；侧面板仅按正式 activeTaskId 归属，草稿按现有空归属语义处理。

- 侧栏：顶部全局置顶区（session + 置顶项目）→「项目」区（标题右键菜单：按时间 / 按项目排序）→「任务」区。时间线实现保留，当前隐藏切换入口。
- 新建项目向导：类型（本地 / 远程）→ 远程先选连接 → 多选文件夹（可不选）→ 名称（默认首 root 名 / 「新项目」）→ 主要目录（默认第一个）。
- 编辑弹窗：名称、roots 增删、设主要（主要被删自动后补首位）。项目操作菜单使用非模态导航，只有编辑弹窗拥有模态指针/焦点限制；菜单退出动画尚未结束时打开并快速保存弹窗，也必须恢复页面交互，不能手动改 body 样式或用超时解锁。
- 拖拽：session → 其他项目（同 host 才可投放；仅本地目标缺该 root 时弹窗「将文件夹加入项目」，远程目标目录不匹配直接拒绝）；任务区 session → 项目（同上，使用该 session 的真实绑定目录，允许默认目录之外的 cwd）；项目节点排序。
- 删除项目：本地项目及在线远端权威项目沿用 E1 软删除；时间线仍显示其 session；新建 roots 集合完全相等（同 host）的项目时弹窗「发现已删除的项目 P（N 个会话），是否恢复」，恢复即 undelete；侧栏不提供彻底删除。2026-10-24 起设置 → 项目页的批量移除可勾选「同时删除 ZCode 数据」，只对本机项目彻底删除其会话、会话文件、文件检查点与记忆（见 `2026-10-24-project-management.md`「彻底删除数据」）。
- 远程项目节点：离线或连接失败时显示缓存及离线 / error 状态，不可展开，不可改名、编辑 roots 或主要目录；项目操作仅允许“删除”，语义为从本机移除入口及缓存，远端项目和会话保留。连接级仍可重连或删除本机 host；重连不自动恢复已移除的项目入口。
- composer：@文件跨 roots 加 root 后缀；skill / subagent 用 qualifiedName；# 提及按项目分组。
- 设置页 agent 配置管理：目录下拉 = 所有 roots 去重平铺；hooks trust 按真实目录。
- 定时 / 闲时 / Bots：选项目；创建时固化 cwd = 主要目录、附加目录 = 其余 roots。表单候选来自项目服务，与已打开的目录 tab 无关；同 cwd 的多个项目按项目 ID 独立选择。空 roots 项目可直接选中，只在提交时由 Host 创建默认目录，模型列表预览使用该 Host 的模型服务。编辑已存在定义保留其原 cwd/目录快照。

#### 6.0.1 Bot 项目绑定与旧状态交接

Bot 的多项目授权沿用既有 `allowedWorkspaces` 字段与 `/workspace` 命令，但新版候选 ID 表示 Host + 项目，不再表示 cwd。候选共用项目目录读取契约：当前 owner 的项目，以及本机仍保留入口的在线远端项目；不从 tab/history 造项目、不为枚举启动 Agent。相同 cwd 的多个项目分别展示；目录/名称输入有歧义时要求选择明确项目。

Bot context 是该 Bot 执行绑定的唯一持久来源。首次创建 context（含 provider offset 首次持久化），或用户明确切换项目时，调用该 Host 的 `prepareSession`，保存 projectId、hostId、cwd、workspaceIdentity 与 additionalDirectories。此后 `/new`、状态读取、模型预览、重启均保留这份快照，不按最新 roots 改写 cwd。新生成任务将此快照传入既有任务创建预留；恢复已存在任务继续以其自身 Host 预留为准。

Bot Repo 在同一文件锁内读取并更新单个 context，命令、provider cursor 与删除均走该入口，禁止用服务层读出的整份旧 state 覆盖其他 Bot。首次绑定以 Repo 内当前 context 为 CAS 依据；命令更新保留独立 writer 的 Telegram/微信 cursor。文件地址在 Repo 实例创建时固定，异步操作不重新解释环境路径。

历史 context 仅在缺少 hostId 时交接一次：保留原 cwd，补全可唯一确认的身份/项目归属，additionalDirectories 为 `[]`。多个同 cwd 项目不猜测归属，保存明确 NULL；已处理 NULL 不因后来新增项目自动归入。旧路径授权仅在候选唯一时转换为项目 ID，歧义不扩大权限。选择菜单的迟到点击必须再次验证当前授权、入口成员和项目存在性，不能直接执行旧菜单对象。

`/task` 的候选从所属 Host 项目树读取，只包含当前固定 cwd/identity 与明确 projectId 的任务；同 cwd 其他项目不能混入，任务 ID 或旧菜单也不能绕过这条校验。切换既有任务只改 activeTaskId，不覆盖 Bot 的项目选择 ID 或执行目录快照。

```text
项目/入口 owner → 读取候选（前后校验成员与入口）
明确选择 → prepareSession → Bot Repo 固化执行绑定 → 既有任务创建预留
roots 编辑 ─────────────────╳ 不改 Bot context
桌面 continuous / 手机 replayable → 原 owner、CommandInbox 与恢复链路
```

- 自动归档：设置页开关与天数保留；扫描器在单个写事务内纯按 CLI 最后活动时间镜像筛选，只改 archived；只排除置顶与 syncer 已观察到的非终态会话（2026-09-15 起不再看结果与未读），不为查询启动 CLI，也不持久化实时 phase。触发点是 Host 定时扫描器（启动首轮 + 每 5 分钟 + 设置变更补扫），项目树查询与点击任务都不再触发；覆盖全部项目 roots 与任务区 session 的绑定目录；归档后行进入时间线的归档态，不影响项目归属。

#### 6.0.2 Bot 远端执行的 Host 依赖注入

Bot 远端执行直接使用窗口 Host 中已在线的 SourceServerConnectionManager / URL Registry 服务，不再经 main 查询 workspace session、创建 Bot logical session 或转交第二条 runtime MessagePort。`/reconnect` 只调用已保留 host 的 connectHost；删除成员后的请求失败，不读旧 settings 复活连接。Server 自身的 Bot 使用所属 Host 本地服务。

旧 Bot canonical identity 通过已保留入口的 legacyWorkspace 解析持库 host，只在首次交接时保存 hostId；后续以保存的 hostId 路由，入口移除不改写已绑定 cwd/identity。稳定 server identity 与显式 hostId 不一致时拒绝。项目绑定前后同时检查 host membershipId 与入口 ID，移除再添加不能接受旧 prepareSession 结果。

远端目录 admission 复用 Source workspace alias；等待期间按物理连接对象及 membershipId 校验，迟到结果拒绝。配置候选、项目归属及 CLI 内容仍分别由现有 owner 决定，router 不存项目、TaskMeta 或连接状态副本。Bot 的动态事件维持 `bot-channel-continuous`：连接换代只更换 live 订阅，不拼接手机 snapshot/replay；命令沿原 task service / owner lease / CommandInbox。

Bot router 可持有自己消费者的订阅句柄，源连接通知驱动重订阅，关闭后丢弃迟到事件；不能用定时器轮询连接或创建第二份已接受输入队列。App runtime preferences 从现有设置读取，只有已持久化 Bot 绑定的在线目标参与主动同步。

```text
Bot context 固定地址 → Host router → 已存在 Source/URL services → 同一 CLI owner
显式 /reconnect      → retained host connectHost
Source 连接换代       → 替换 Bot live subscription（不做 replay）
desktop continuous / mobile replayable → 各自原 attachment，不受 Bot 路由替换影响
```

#### 6.0.3 手机项目新目录的 shared-host admission

手机 home 与桌面 sidebar 挂载同一个 ProjectSidebar，从同一 base attachment 的项目契约读取行集合；删除手机专属的 workspace 分组、标题/状态推导和重复的列表缓存。手机 shell 只负责 home/chat、浏览器 back 和侧栏弹层，不拥有项目/任务副本。ProjectSidebar 的打开事件经原 replayable switcher 成功后进入 chat；新草稿经下述 Host admission。视图/排序共用项目侧栏控件，不继续读取已退场的手机 workspace 分组偏好。

home-only（初始目标工作区不能建 bridge，Root 没有 projectService）时没有 base attachment，也就没有项目契约。此时 ProjectSidebar 的项目/任务区改为展示 relay 层 `listWorkspaces` 返回的桌面窗口工作区列表，手机和宽屏共用；项目树读取失败不在这里展示。列表事实只来自桌面：挂载时请求一次，之后只采用 `workspace-list-updated` 推送，不轮询。请求发出后若收到推送或新请求，迟到的旧响应丢弃。每行展示工作区名称与连接状态：

- 可建 bridge（本地，或远程且带 workspaceIdentity + remoteSessionId）：点击经 `switchWorkspace` 打开该工作区的 bridge Root，落在首页，不自动进入聊天。
- 不能建 bridge：显示“未连接 · 连接”（有 `lastConnectionError` 时显示连接失败），点击经 `reconnectWorkspace` 交给桌面已有重连 owner；成功后重新请求列表，行变为可打开，不自动切换。
- 桌面报告 `reconnecting` 或本页请求进行中：行禁用并显示连接中。请求失败用 toast 提示，列表保持桌面最新事实。

```text
home-only Root (无 projectService)
  ProjectSidebar → listWorkspaces ─┐   desktop workspace-list-updated ─┐
                                    └→ 工作区行（迟到响应丢弃）←─────────┘
  可 bridge 行 → switchWorkspace → bridge Root（首页）
  断开行     → reconnectWorkspace → desktop 重连 owner → 列表带回 remoteSessionId → 可 bridge 行
```

手机发出项目/host 意图，由窗口 Host 调用同一个 ProjectService.prepareSession 解析目录。手机不先调用一次 prepare 再通过 main 重复准备。main 只转交请求与 Host 返回的脱敏 workspace descriptor，不读取项目/任务库。全局任务的每次用户创建分配新目录，同一导航请求的重试不得重复创建。多个导航 join 同一个目录 scope 时，共享首次 Provider 配置同步屏障；scope 换代使旧 bridge identity 立即失效。手机创建的 scope 后来由桌面显式采用时，仍等待 desktop renderer ready 后才记为连接成功。

远端 admission 只可复用当前已在线的物理 Source 连接，在该窗口 Registry 中创建或复用目录对应的 logical scope；不得隐式建立新 SSH/WSL/Docker/URL transport、独立 Host 或 Agent。准备前后验证保留 host 的 membershipId 与物理连接 owner，创建 scope 后再次验证，移除/换代的迟到结果拒绝。离线保留当前 bridge 和草稿，显式重连沿原入口执行。

手机 scope 的 remoteSessionId、workspaceIdentity 与 cwd 必须匹配 Host descriptor。新 scope 仍经现有 shared-host attachWorkspaceHost，以可信 web-remote-replayable 创建独立订阅；桌面 continuous 原链路不变。手机 Root 替换时携带项目草稿、provider 与初始输入，先完成草稿初始化，再允许 prewarm；旧 Root 不在异步返回后写入新 Root 的状态。

未提交项目归属与正文/模型一样属于浏览器草稿：在既有 V4 composer 的 workspaceKey + `__draft__` scope 中保存可选 projectId（null 为显式未归类）。普通文本/模型保存不得清除归属，显式新建覆盖它，任务创建成功后随原 draft promotion 清理。手机 replayable 的 Root 重建与页面 reload 从同一草稿读取归属，显式 initialTaskDraft 优先，已有 initialTaskId 不读取草稿；desktop continuous 仍按原初始 workspace 语义进入新草稿。不得为此增加 main/relay 的项目状态副本或 accepted input queue。

```text
mobile draft edit -> existing browser composer scope (workspaceKey, __draft__)
bridge recovery / reload -> Root restores projectId before prewarm
first submit -> Host validates project -> CLI accepts -> existing draft promotion
```

打开项目树中的既有任务也使用这一 admission：客户端只提交 taskId、workspaceKey 与所属 hostId，Host 从权威任务树确认该地址确实存在，再 resolveSessionDirectories；不得调用 prepareSession 或为历史任务分配新目录。远端先检查已保留 Host 与在线物理 owner，再确认本机保留的项目入口；打开未分类任务只要求 Host 成员仍在。所有迟到结果沿同一 membership/entry/physical owner 校验。bridge 的 workspaceKey 仍为原执行目录身份，不改成项目 ID。

```text
mobile project intent -> main request routing -> Window Host ProjectService
                                                     | prepare cwd
                                             online Source lease check
                                                     | Registry logical scope
mobile replayable <- existing shared-host bridge <- trusted descriptor
```

#### 6.0.4 Composer 项目候选的只读边界

旧的空态命名 scratch workspace 弹窗及 Root → App → Shell 创建回调链退场。新建目录统一由已选虚拟项目的 prepareSession 或全局任务分配入口负责，不保留没有实际 UI 消费者的第二套创建动作。

`#` 从当前实际 Host 的 ProjectService.readTree 读取候选，包含未打开 tab 目录的未删除任务，按 `(hostId, projectId)` 分组；空归属显示本地化的任务区标题，软删除容器下的既有任务仍按该项目名显示。只读取当前 attachment 的 Host，禁止为了候选连接另一 Host 或从其他 Host 聚合不可读取的 session ID。每组独立搜索后最多 20 条，排序来自 CLI 活动时间镜像。`@` 中的会话候选继续限当前 workspaceKey，但行集合也改为同一权威项目树。项目事件使只读查询刷新，owner/地址变化后丢弃迟到结果。

`@` 文件覆盖绑定 cwd 与项目的其余 roots。已有任务使用 resolveSessionDirectories，草稿使用已选 projectId 的 readProjects；未分类草稿只有当前 cwd。读取候选不能调用 prepareSession、不能创建目录或 Agent。已移除 root 的旧任务仍保留自身 cwd。文件查找通过当前 Host 的 fileService 执行，真实绝对路径作为去重 key；保留原 relativePath，当前 cwd 内 canonical 链接继续相对路径，其余 root 使用绝对路径，避免同名相对路径指向错误文件。候选右侧显示 root 名，名称只是展示信息，不参与身份或执行路径。

```text
composer # -> current Host ProjectService.readTree -> project groups
composer @ -> task directories / selected project roots -> same Host fileService
                identity + request owner changed -> discard old response
desktop continuous / mobile replayable -> original attachment, no new runtime
```

### 6.1 任务区归属与首次归位验收

定时/闲时的项目选择复用 readProjects，只读取目录与项目，不为展示候选加载 task tree 或触发自动归档。此处将原“已打开的本地 workspace”改为“所有未删除的本地虚拟项目”，保留既有产品 spec 的本地新建范围、创建后目录固定及旧远端任务管理能力；开放远端新建需要独立明确裁决。

| 场景                                                                            | 预期                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 全局新建任务                                                                    | 在 `~/.zcode/workspace/<唯一目录>` 下创建，`project_id = NULL`，显示在任务区 |
| 首次发现默认目录之外的历史 session，绑定目录匹配同 host 下唯一一个未删除项目    | 归入该项目，cwd 不变                                                         |
| 首次发现默认目录之外的历史 session，绑定目录匹配多个未删除项目                  | 保持未归类，显示在任务区；不按主要目录优先选择，不新建项目                   |
| 首次发现默认目录之外的历史 session，绑定目录不匹配任何未删除项目                | 保持未归类，显示在任务区，不新建项目                                         |
| 同目录仅匹配已删除项目或其他 host 的项目                                        | 不作为有效匹配，保持未归类，不恢复已删项目、不跨 host 归入                   |
| 未归类 session 已完成首次判定（bit 8），之后新增包含其 cwd 的项目，再启动或对账 | 仍在任务区，不因目录变成唯一匹配而自动归入                                   |
| 时间线中的空归属 session 拖入同 host 项目，目标缺该目录                         | 弹窗确认加入真实绑定目录；确认后移动，拒绝则目录与归属均不变                 |
| 空归属 session 满足 F12 自动归档条件                                            | 同样触发自动归档，不因无项目归属而遗漏                                       |
| 删除本地项目或在线远端权威项目                                                  | session 保留原 `project_id`，时间线仍可见，不转入任务区                      |

以上场景在桌面与手机 Web 远控中保持一致；涉及远程时沿用同 host 限制及 workspaceIdentity 隔离，不改变桌面 continuous 与手机 replayable 的恢复边界。

### 6.2 远程离线项目入口验收

远端 Server 的 `host_id` 使用可信启动入口注入的稳定 Source Server 身份。库内 `workspace_key` 仍可保留旧 SSH/WSL canonical key，由既有 identity mapper 转换对外身份；不得从这些历史连接地址推断不同物理 host，也不改 cwd、CLI 配置 hash 或 canonical key。Server Core 在创建 services / 开放 RPC 前完成自身 app 库迁移。

| 场景                                               | 预期                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 已添加远程项目断线或连接失败                       | 本机基础信息仍可见；不可展开、改名或编辑 roots / 主要目录，项目操作仅允许删除本机入口           |
| 离线删除远程项目后重启应用，再重连同一 host        | 本机入口及缓存已移除，项目不自动回来；远端项目、roots、session 归属与内容不变，无待同步删除操作 |
| 刷新请求已发出，随后删除本机项目入口，最后收到响应 | 迟到响应不重建入口或缓存，setting.json 不重新写回已移除的远程条目                               |
| host 重连时远端返回已移除项目或新增其他项目        | 只刷新本机仍保留的入口；全量列表不会自动添加项目                                                |
| 用户主动重新添加同一远端项目                       | 恢复本机入口并读取最新信息，可访问原会话；不新建远端项目、不触发 E1a 的 undelete                |
| 删除同 host 的一个项目入口，或删除该 host          | 前者保留连接及其他项目入口；后者仅移除本机连接和所属入口，两者都不删除远端数据                  |
| 在线删除远端项目时连接中断、未确认成功             | 显式报告未确认或失败，不偷偷改为删除本机入口，不制造远端删除已成功的假象                        |

桌面各窗口与手机 Web 远控使用同一本机入口数据源，由已有 Host 服务读写；手机不额外维护一份可编辑入口清单。实施阶段补对应服务单测与桌面 / 手机 E2E，确认本机入口移除不会修改远端组织态或会话运行状态。

## 7. 迁移（启动门禁，复用同一迁移实现）

共享迁移模块通过 `@zcode/shared/sqlite-migrations` 导出；CLI/desktop agent 的构建子路径映射必须从 shared 包的 exports 派生，不维护第二份手工子路径清单。实际 bundle 构建与导入属于迁移交付验证，不能只检查 TypeScript 源码。

2026-10-10 合并后采用上游的可观测启动门禁：Host Worker 在业务服务初始化前准备 app 库，再用同一 CLI bundle 的存储准备入口准备会话库。Worker 必须读取旧 settings 并传给项目迁移，不能先记账再丢掉旧项目种子。两边复用既有 SQL、checksum、表级备份及 Repo；锁等待异步，提交成功后才发布 ready，不创建第二套会话迁移实现。失败进入启动错误/重试流程；重试以完整 migration ID 幂等跳过已完成的库，不假设两库之间存在原子事务。CLI 正常打开数据库仍检查 migration，覆盖独立 TUI 与远端运行。两个不同名称的 0004 和 CLI 双方迁移都保留，不按序号覆盖；0023_session_soft_delete_outcome 识别开发期已执行的 0020 同内容记录。

### 7.1 通用 migration runner（两库共用，抽自 CLI 现有 runner）

```text
migration 定义
  { id, appVersion, up: SQL | fn, touchedTables: string[] }   ← 显式声明会写入的表

runner（备份只为迁移失败恢复；未触及的表迁移前后是同一份数据，因此表级备份 + 未触及表 = 升级前完整状态）
  pending = SQLITE_MIGRATIONS 中未记录在 schema_migration 的项（未知 id 忽略，checksum 不符报错，沿用现有语义）
  tables  = ∪ pending[i].touchedTables
  1. 备份：ATTACH <backupDir>/<db>.sqlite AS b；对 tables 逐表 CREATE TABLE b.<t> AS SELECT * FROM main.<t>；DETACH
     空间：需要量 = 这些表体积之和；当前卷不足 → 其他已挂载可写卷 → 都不足则跳过并在 backup.json 标记 skipped
  2. BEGIN IMMEDIATE → 依次执行 up → INSERT schema_migration → COMMIT
  3. 失败 ROLLBACK，备份保留；main 弹错误（重试 / 打开备份目录）

备份元数据 backup.json：每表的列清单、行数、内容哈希（CLI 库外键 message/part/session_entry/session_target → session 均 ON DELETE CASCADE，恢复必须防级联）

恢复工具（工程用，scripts/，禁止手工 DELETE）
  恢复连接 PRAGMA foreign_keys=OFF → BEGIN IMMEDIATE
  对每张 touched 表：DELETE main.t；INSERT INTO main.t(<备份列清单>) SELECT <同列> FROM b.t（迁移新增列留默认）
  PRAGMA foreign_key_check 必须为空；逐表行数与哈希须等于 backup.json
  COMMIT；删除对应 schema_migration 行；任何校验失败则 ROLLBACK 并保留备份

机械保证
  每条 migration 一个单测：fixture 库上执行前后对全部表做内容哈希对比，只允许 touchedTables 变化，否则失败
  schema.baseline.sql + CI diff：只允许新增表 / 列 / 索引
```

本次 migration 声明：CLI `0020_session_soft_delete_outcome` → `touchedTables: ["session"]`；app `0001_projects` → `touchedTables: ["tasks","task_groups","task_group_members","task_group_view_node_orders","task_group_workspace_bootstraps","automations","off_peak_tasks"]`（group 表只读但纳入备份以便整体恢复）。

### 7.2 步骤

2026-10-19 首次升级排序补充：从 3.15 尚未执行项目迁移的控制端升级时，保留旧
`lastWorkspaceSession` 的本地/远程混排顺序。本地复用 `projects.position`，远程入口保存
可空的 `initial_position`，仅供侧栏首次排序初始化；不把控制端位置写到远端项目。
新增独立加法 migration，只有同一迁移事务实际执行了 `0005_projects` 时才写初始位置，
已有 `0005_projects` 或旧 ID `0001_projects` 的数据库不补排，不改旧 checksum。
仅带此次迁移标记的远程入口在 `legacy:<entryId>` 解析成真实项目 ID 时原位替换排序键；
沿用现有排序算法和偏好 owner，不全局切换排序身份。首屏离线、连接完成、Host 身份绑定、
刷新以及升级后手动拖动均保持位置；失败回滚后可重试，重复启动不覆盖新排序。

```text
3.15 的 A → Remote R → B → 首次事务保存 0/1/2 → 现有侧栏偏好
                                      legacy:R → project:R（同一排序槽位）
```

VP28 补充验证：真实冷启动迁移本地/remote 混排与离线刷新；SQLite 和 React 回归覆盖
连接后身份替换、同路径不同 Host、手动排序、旧 ledger 不回填与迁移幂等。沿用 shared-host
手机目录及同一排序逻辑，不改 CLI、会话归属、continuous/replayable 或连接调度。

```text
M0 探测：tasks-index 无 schema_migration 或缺 '0001_projects' → 进入迁移；否则跳过
M1 备份：按 7.1 表级备份两库 → ~/.zcode/backup/<ver>-<ts>/
M2 建表加列（5.1、5.3）；本机远程项目入口与远端权威项目分开保存
M3 hosts：'local' + 从 tasks.workspace_key / setting.json remote 条目解析出的 remote authority
M4 tasks 回填：host_id、root_path（= workspace_path）、cli_* 从旧列拷贝一份初值；`deleted=1` 的行置 handoff_pending|=1，`title_overridden=1` 的行置 handoff_pending|=2（历史 Host 事实待交接给 CLI，见 7.4）
M5 本地及远端各自仅将旧 lastWorkspaceSession 中保留的项目 workspace → 单 root 项目（name = 目录名，name_overridden=0，primary = 该 root）；
    首次 position 仅按 setting.json 的 lastWorkspaceSession 中本 Host 项目条目的原顺序分配（同目录去重、无 session 的已保存项目也保留）；conversation 条目不参与。历史 tasks、recentProjects 和 Group 都不能扩充项目集合；已移除目录、仅已归档或已删除任务的目录不因历史记录重建项目。未归属任务按 F3 保留原 cwd、标题、时间、归档/删除/置顶/未读状态；settings 缺失或列表为空时也不从任务记录推断项目。持库 owner 不是 local 时按 F8 远端例外补充：settings 条目之后，按历史任务最近活动时间倒序，把未删除、非 `*/.zcode/workspace/*`、非 conversation 条目、尚无同目录项目的 root 建为单 root 项目；归属仍由 M6a 的唯一目录匹配完成。
    position 只在首次迁移初始化；已有 ledger 时不重跑转换、不从 settings 重排，也不自动清理已生成的项目，保留升级后用户的编辑与手动排序。远端条目仍按原 Host/入口边界导入，不把本机排列写成远端权威项目顺序；默认手动模式读取 position，显式选择按活动排序或置顶时沿用对应展示规则。
    其下所有 tasks.project_id = 该项目；定时/闲时定义按同 Host + workspace_path 匹配已保存项目，远端身份 key 不作为真实目录；未匹配者保留 NULL 与原执行范围。bootstrap 组（task_group_workspace_bootstraps）不再单独建项目。
    本机 lastWorkspaceSession 的 remote 条目只在首次迁移时导入 remote_project_entries，保留基础信息与原 workspace 标识，等待连接后解析远端项目 ID；不在本机建远端权威项目。已保存 Source/有效 Profile 同时导入连接成员关系，优先已有稳定 Source ID 和首选 Profile；旧地址入口关联到同一稳定 Host，未握手过的地址保留临时地址身份。已有 migration ledger 后不再从 settings 反向导入
M6 只转换当前持库 Host 的成员；本机遗留远端影子成员保留在旧表作迁移证据，不在本机创建远端权威项目。
    手建 group → 项目：roots = 成员目录去重，primary = 成员最多者；含多 host 的按 host 拆并后缀 host 名；成员 project_id 改为新项目；系统组跳过
M6a 对 M5/M6 后仍未归属的历史 tasks 按 F3 判定一次；不覆盖已有 project_id，零个或多个匹配保留 NULL
M7 automations / off_peak_tasks 回填 project_id（按 workspaceKey → 其单 root 项目）、host_id，并把旧定义的 additional_directories 固化为 []（旧版仅绑定 cwd，不凭后来项目 roots 扩权）
M8 写 schema_migration('0001_projects')；旧 group 四表原地保留
启动每次：在同一事务内先识别 host_id IS NULL 的旧版本新增行；补齐这些行的 host_id/root_path，并仅对其中尚未归属的行按 F3 判定一次后提交。
  project_id IS NULL 本身不表示待迁移；host_id 已补齐的未归类行不重复判定。
  CLI 首次发现的新 session 在首次插入 app 行时按 F3 判定并原子写入 host_id/project_id；全局新建任务直接写入 host_id 与 project_id=NULL。
  随后执行 7.4 事实对账（不重算已有行的 project_id）；从本机 projects/hosts 及仍保留的 remote_project_entries 派生并写回 setting.json（F5）；不把旧 remote 条目再次导入入口表
```

### 7.4 对账与交接（每次启动 + 每次 workspace CLI 可用时）

```text
启动全表比对（4085 行量级，毫秒级）
  deleted=1 AND cli_deleted=0                         → handoff_pending |= 1   （旧版本或历史的删除意图）
  title_overridden=1 AND (cli_title_source<>'custom' OR cli_title<>title) → handoff_pending |= 2
  updated_at / task_status 与镜像不一致                → 忽略（V1 只读镜像）

workspace 的 CLI 因任何原因可用时（不为交接单独拉起 Agent）
  批量：bit1 → deleteSession；bit2 → renameSession(title)
  成功 → 清位并由 sessions-index 回写镜像；CLI 回 not found → bit1 清位（视为已删），bit2 置 orphan(4) 保留 app 标题

订阅 sessions-index 收到 snapshot 后
  本地 cli_deleted=0 且不在 snapshot 的行 → sessionsIndex/reconcile
    deleted=true  → cli_deleted=1（并双写 deleted=1）
    exists=false  → handoff_pending |= 4，告警日志，不删行
    exists=true   → 用返回值刷新 cli_*（说明只是 summary 尚未到达）
```

显示规则不等交接完成：隐藏 = `deleted OR cli_deleted`，标题 = `title_overridden ? title : cli_title`，因此交接前后用户所见一致。

本机实测：M2～M8 合计 175 ms；表级备份 CLI 70 ms（1.9 MB）、tasks-index 165 ms（14 MB）。

## 8. 分阶段 MR（同一版本发布）

| MR  | 内容                                                                                                                                                                                                                                                    | 主要目录                                             | 验证                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | CLI 0020 migration、time_deleted / last_outcome、deleteSession 语义、SessionSummary.lastOutcome、`sessionsIndex/reconcile` 命令、additionalDirectories 消费点及 V4 冷恢复参数贯穿、skill/subagent qualifiedName                                         | apps/zcode-cli                                       | 单测 + 协议 schema 测试                                                              |
| 2   | 通用 migration runner（抽自 CLI，加 touchedTables 与表级备份、恢复脚本、逐表哈希单测）、5.1 schema、空间守卫、main 建窗前执行、schema.baseline.sql + CI diff                                                                                            | packages/services、packages/desktop/main、scripts/ci | 单测：各分支 + 升降级 fixture                                                        |
| 3   | 归属收口：syncer 只写 cli\_\* 与旧列镜像；删 3 处 Date.now；renameTask / deleteTask 改经 CLI 命令并写意图位；7.4 启动对账、惰性交接、snapshot 缺席 reconcile                                                                                            | packages/services                                    | 单测 + e2e 标题 / 状态回归                                                           |
| 4   | 项目服务：projects/hosts/roots CRUD、move session、软删除与恢复匹配、4.3.1 统一目录解析与三入口注入、F3 首次归位与 NULL 组织态保留、setting.json 双写、预热改上次活动目录、自动归档触发点迁到项目树查询、本机远程项目入口与缓存、离线移除及防止重连重建 | packages/services、packages/shared                   | 单测：含首次归位、重复启动不改归属、默认目录之外的任务自动归档；含入口移除与迟到刷新 |
| 5   | UI：项目树、任务区、时间线、新建 / 编辑向导、拖拽与确认弹窗、右键、置顶项目、远程节点、移除工具栏与 group UI                                                                                                                                            | packages/ui                                          | e2e：项目 CRUD、拖拽与拒绝、6.1 任务区归属场景、6.2 离线入口操作                     |
| 6   | composer 与设置页：@文件后缀、qualifiedName 列表、# 按项目、设置页目录源                                                                                                                                                                                | packages/ui                                          | e2e：4.3.2 多 root 能力与冷恢复                                                      |
| 7   | 定时 / 闲时 / Bots 改选项目                                                                                                                                                                                                                             | packages/ui/settings、services                       | e2e：定时任务选项目                                                                  |
| 8   | 远端 server bundle 迁移 + 旧远端降级展示 + Web / 手机侧栏项目层级                                                                                                                                                                                       | packages/server、web、desktop/main                   | 远控 e2e：含 4.3.2 并发订阅与远端目录恢复；含 6.2 离线删除不改远端数据、手动重新添加 |
| 9   | 文档回写：废弃 grouped / bootstrap / task-sqlite-index 等 spec，标注指向本文                                                                                                                                                                            | docs                                                 | —                                                                                    |

## 9. 风险与待验证

- 2026-09-10 review 修正：恢复级联删正文（7.1 外键关闭 + 校验）、降级期修改既有行（7.4 全表意图对账）、历史 Host 事实交接（M4 标记 + 惰性交接）、删除对账来源（`sessionsIndex/reconcile`）。这四项在 MR 2 / MR 3 的单测里必须有对应用例：恢复后 message/part 行数不变；旧版本写 `deleted=1` 后再升级仍隐藏；旧 tombstone 交接与 orphan；丢失 `session.removed` 后经 reconcile 收敛。

- 远端 server bundle 与本机版本错配窗口内的降级展示需要真机验证（SSH、WSL）。
- CLI 软删除对外部 TUI 的可见性变化（旧 TUI 仍显示）已接受，需在发布说明写明。
- `UNIQUE(host_id, task_id)`：若历史数据存在同 host 不同 workspace_key 的同 task_id（ACP 迁移遗留），建索引会失败，M4 前需先探测并记录冲突，冲突时索引降级为非唯一并告警。
- 项目名同 host 唯一索引与老 workspace 同目录名冲突（如两个不同路径的 `z-code`）：M5 自动加序号。

Schema 自动门禁补充：现有表的 CHECK、表/列级自动 UNIQUE 与索引排序/collation 属于旧写入合同；删除或改写必须拒绝，不能因 sqlite_schema.sql=NULL 的自动索引被漏检。旧表新增约束可能让降级写入失败，门禁要求 CHECK/自动 UNIQUE 集合保持一致；新表可自由声明约束。SQL 比较只归一化关键字/空白，保留字符串字面量大小写，避免 WHERE 值变化漏检。此检查只读内存数据库，不修改 migration 历史 checksum 或基线。

远端实时活动复用 WindowControllerTaskListRegistry 的共享订阅。项目树仅按完整 workspaceIdentity/workspacePath + taskId 叠加 phase/pending interaction，不改变 SQLite 返回的行集合、标题、组织态或 CLI 排序时间。任务 cwd/roots 构成观察 scopes，通过既有 listTaskList 注册 owner 观察器，不创建 logical workspace 或 Agent。没有 Controller 的直接 owner 客户端继续使用自身 sessions-index。来源离线或 overlay 删除后去掉实时属性，不把旧 running 当作持久化终态。

删除已无读取者的 Renderer remotePinnedTaskStore / remoteTimelineTaskStore。连接完成只提交 attachment、目录身份与草稿；不再为这两份旧缓存读取远端任务列表。Header 的组织命令仍走原 Host task service，当前 Header/全局搜索需要的 query projection 保留，但不重复写无人读取的远端列表镜像。项目侧栏由其既有 ProjectService 查询/变更事件刷新，owner/lease 与 continuous/replayable 边界不变。

D2 原生拖拽：task 行同时服务 workbench 复制和项目归属移动，drag source 的 effectAllowed 必须允许 copyMove；workbench 继续选择 copy，项目选择 move。只在 drop 后发送 Host moveTask，缺 root 的确认取消不改变任何持久状态。不能只用构造 DataTransfer 的组件测试代替浏览器原生事件验收。

2026-10-16 远程项目菜单收口：可编辑（在线且非 legacy 单 root）的远程项目菜单与本地项目一致，不再显示「从本机移除」和「添加远程项目」；远程同步与连接动作不变。「从本机移除」只作为不可编辑时的唯一管理动作保留（G5）。只隐藏菜单项，`removeEntry`、RemoteProjectPicker 与 `addEntry` 的逻辑保留；添加远程项目仍走新建项目、设备连接后的选择器等其他入口。

2026-10-14 项目菜单图标：右键、更多和多目录文件菜单共用动作图标：新建任务 MessageCirclePlus、查看文件 ListTree、编辑 Pencil、置顶 Pin／取消置顶 PinOff、删除 Trash2、移除入口 FolderMinus、连接 Plug、添加远程项目 FolderPlus、同步 RefreshCw。图标位于文字左侧，统一 `size-4`、禁止收缩、`aria-hidden`，沿用菜单的 `gap-2` 与文字颜色（含删除、禁用和悬停）。菜单顺序、文案和动作不变；桌面及手机窄屏在 Zai Light / Zai Dark 下保持图文对齐。

置顶项目名称右侧不再常显钉子。支持 hover 的设备上，鼠标进入项目行时，左侧原图标在同一个 `size-4` 槽位切换为 Pin，移出恢复当前文件夹或远程连接图标；未置顶项目和无 hover 的触屏保持原图标。通过 CSS 派生显示，不新增状态或改变标题展开、拖拽及菜单置顶操作。验收覆盖置顶／未置顶、移入／移出、多目录展开态、远程图标、深浅主题和窄屏，文字与操作按钮位置不跳动。

2026-10-13 多目录图标：本地项目直接按当前 `project.roots.length > 1` 显示多目录标识，
不按任务数、打开 tab 数或当前 cwd 推断。0/1 个 root 使用 Folder / FolderOpen，多个 root
使用 Lucide Folders / 对应的 FoldersOpen；打开版保留叠放轮廓并展开前层文件夹。
侧栏按现有展开态选择开/关图标；composer 当前项目 chip 和项目选项使用收起图标，
不新增菜单开合语义。两处共用图标组件，roots 更新后直接重绘，无独立缓存或持久化字段。
远程项目继续使用既有连接状态/云图标。尺寸、线宽、主题色和可访问名称沿用所在控件。
验收覆盖 0/1/多 root、侧栏展开/收起、composer 当前项/候选及 roots 由多变单；
复用 VP14 桌面和 VP13 手机用例，在深浅主题检查实际图形与项目选择路径。

2026-10-13 D2 目标反馈：拖动 session 进入可编辑项目时，整个项目容器显示蓝色 2px 描边
（`border-icon-blue`）和浅色强调底（`bg-accent`），圆角使用 `rounded-xl`。范围包括标题与
当前展开的任务列表；折叠项目只覆盖当前标题，不自动展开。装饰层不接收事件、不改变尺寸。
反馈沿用原生 session payload 与现有项目接收条件，不混用项目排序的插入线。
在同一项目的标题、任务及操作按钮间移动时保持高亮；离开项目、drop 或 dragend（包括 Escape）
立即清除。无关文件/文字拖拽和离线/旧版只读项目不显示反馈。

```text
session drag -> 项目 dragenter/dragover -> 项目整体高亮（仅 renderer 临时态）
              -> 内部子节点切换 -> 保持
              -> 离开/drop/dragend -> 清除
              -> drop -> 现有 moveTask / 缺目录确认 -> Host 项目归属
```

沿用 VP15 原生拖拽用例，补充整块边界、无布局位移、离开/取消清除、确认前清除、
双向移动和深浅主题截图。原生 Escape 由组件 dragend 清理回归覆盖；WebDriver 按键未取消
Chromium 原生拖拽，桌面 E2E 使用拖离项目再松手验证取消，不把该步骤记作 Escape 验证。
手机远控目前不启用原生 session 拖拽（由 Shell 的分屏入口统一控制）；
本次检查共享项目容器在手机窄视口的深浅主题显示，并断言该入口仍关闭，不新增触屏手势。

```text
project tree (SQLite rows) ---------------------+
existing Controller -> sessions-index activity -+-> keyed UI overlay
                 metadata cursor/gap repair; conversation delivery unchanged
```

Controller 的元数据 snapshot/gap 协调沿用既有协议；会话桌面 continuous 与手机 replayable 恢复边界不变。

远端项目变更通知：物理连接 owner 在成功握手后订阅该连接的 state:projects，转发为本机同频道的“需要重读”通知；不透传项目数据、不写缓存。SourceManager 与 URL Registry 各自持有并释放自己 transport 的订阅；换代/断开后迟到事件按原 connection 对象身份丢弃。Controller 重读远端权威库后仅对本机仍保留入口执行 CAS 刷新，不能据广播新增入口。其他 settings/state 频道不进入此桥接。

所有提供项目 RPC 的独立 Server 入口使用同一 Host 装配：稳定 serverId → app migration(owner hostId) → workspace identity mapper/alias service → createLocalServices(standalone-server) → HTTP/RPC。该装配保留 CLI canonical workspace key，HTTP 与 ServerCore 都通过同一个 mapper 转译稳定 remote identity。仅完成此装配的入口声明 virtualProjects；迁移失败不开放端口。配置目录仍按 cwd/identity，serverId 不参与真实路径计算。

设置服务的配置文件地址在实例创建时固定到该 Host 的 HOME；异步投影、迁移与写队列沿同一路径读取/加锁/替换，不能因随后环境变量变化跨 Host 写入。独立 Server 装配集成测试必须使用子进程级临时 HOME，父进程不在后台任务尚可能运行时撤销隔离。

全新 URL Server 工作目录没有 SSH/WSL/Docker route hint 时，独立 Host 提供自身稳定 server identity 作为初次 canonical key；已登记 alias 与有历史的 legacy key 始终优先，不因入口升级改写旧 CLI identity。新 alias 允许合法 server route，真实 IO 仍使用 cwd。

H2 实施边界：设置页候选通过纯项目目录读取（readProjects），本机所有未删除项目 roots 与仍保留、在线远端项目 roots 按 workspaceIdentity/path 去重；不读取 task tree，不借 tab 成员判断目录存在。tab 仅补充已存在的 remoteSessionId/localWorkspacePath。候选使用配置目录类型，禁止合成 tab ID 或 fake session。远端响应返回前重读成员/入口，移除后重加也按 membership 拒绝旧结果。

Desktop 配置 hooks 可请求现有 Source settings attachment，选定 root 才请求，物理连接仍由 Registry/SourceManager 所有；配置集合不暴露 Agent，不能作为会话恢复链路。手机保持原可信 workspace attachment，Source settings 权限边界不变。

未打开 logical workspace 的远端配置写入前，配置 attachment 通过既有 sourceServerWorkspaceService 绑定 cwd 的 canonical key。Host 提供的 legacy route hint 仅用于已有历史恢复；绑定完成前保持 remote-waiting，目标/attachment 换代后的旧结果不能开放新目标写入。Source settings 仍不暴露 Agent、task、文件或 provider 写入口。

降级期新增的定时/闲时定义以 host_id IS NULL 标识尚未交接。每次启动与任务意图对账同事务补 owner、按同 Host 唯一 root 决定一次项目归属，additional_directories 固定为旧版支持的 []；不随当前项目多 roots 扩大旧定义执行范围。已经补齐 host_id 的定义（包括合法 NULL project_id）不再重算，既有目录快照不覆盖；不修改 workspace_key/cwd 或历史 migration checksum。

界面 scope 不变量补充：项目侧栏 footer 的远控入口仍接收当前执行 workspacePath、workspaceIdentity 与 remoteSessionId；项目展示重构不能丢弃这一身份链路，也不能据 cwd 推断远端归属。

远端项目导航的目录归属：ProjectService 的 prepareSession / 历史 task 已提供所属 Host 的 cwd 与 workspaceIdentity，Renderer 将这对值交给既有 Host bind，不能再次 realpath 后用另一条路径重建 identity。普通文件夹选择仍由原目录浏览器解析 canonical path。Host 保留身份/成员校验，UI 保留绑定结果的精确 identity 校验；不为 `/tmp` 与 `/private/tmp` 等路径别名放宽 owner 判断或改写历史 cwd。

```text
Host project/task -> fixed cwd + identity -> existing Host bind -> exact identity check
folder picker     -> existing canonical resolver -> existing Host bind
```

V4 远端可替换 transport 必须完整转发 createSession 的 client context（projectId），包括 service proxy 换代之后。projectId 不属于 CLI envelope，但必须到达所属 Host 的 prepareSessionCreation，才能在 CLI 创建前原子预留归属和解析附加目录；不得在恢复代理层截断该参数，也不得由 Server 按 cwd 重新猜归属。

远端历史任务重开复用已绑定 tab 时，只可释放本次额外申请的临时 logical attachment；如果传入 sessionId 就是该 tab 的 owner，必须保留它。不得因复用成功而取消当前仍承载任务的 attachment。

冷恢复与 runtime 换代：在途 subscribe 的 ACK 跨代后仍必须丢弃。`fault.subscription.runtimeRestarted` 属于已知换代中断，进入现有有界订阅恢复流程，不能落成永久 error；不重放已提交 command，不引入新队列或另一套重试计时器，desktop continuous / mobile replayable 的订阅与恢复语义保持原边界。

```text
subscribe in flight -> runtime available/restart -> old ACK rejected
                  -> existing bounded subscription recovery -> current owner ACK
```

## 2026-09-11 用户 UI 纠偏与迁移补充（覆盖旧 UI 裁决）

- 沿用本项目的项目行和分区交互，恢复项目/任务折叠、分区拖动顺序与 hover 操作，沿用原偏好。项目区新增为 Plus，任务新增为 MessageCirclePlus。时间线能力保留但暂不展示入口；项目排序移入标题右键菜单。项目行不显示独立箭头，以 Folder/FolderOpen 表达折叠状态；hover/focus/touch 保留“更多、查看文件、新建任务”三个按钮。右键包含查看文件、新建任务与更多菜单的全部操作，兼容键盘菜单键/Shift+F10 与触屏长按。
- 创建向导先选本地/远端，再填名称和源文件夹。名称使用文件夹图标组合输入，源文件夹使用整块可点击添加区；路径输入仅属于目录浏览器。0 root 项目仍合法。远端可选择已保存连接或在向导内添加连接，选择已有项目或创建远端项目；侧栏不提供独立“添加连接”。
- 名称聚焦沿用当前表单的共享 Input：边框和背景使用 DESIGN.md 的 focused token，不另叠 outline 或父容器焦点环。自动聚焦、鼠标点击和 Tab 返回均遵守此规则，深浅主题、窄屏及强制颜色模式一致。`ui-shell/manual-review/pending/command-center-focus.test.ts` 的 DIALOG-FOCUS-01 验证共享创建弹窗，并用取消退出，不写入项目。
- 复用现有连接对话框、目录浏览器和 Host 服务，不创建 workspace tab 或 Agent 来浏览目录。连接归连接管理器，表单只持有草稿，保存归所属 Host；取消/切换目标后拒绝迟到 UI 结果。只有显式选中已有项目或新项目保存成功才添加本机入口。桌面 continuous 与手机 replayable 不变。

```text
创建 -> 本地/远端 -> 连接管理器(远端) -> 文件服务选目录 -> Host.saveProject
                                                            |
                                   本机入口 <- 远端保存成功 --+
```

- 手建 Group 只有存在未删除 session 成员才迁移；空 Group、仅悬空成员、仅已删成员不创建项目。归档但未删除成员仍有效。名称与有效成员目录保留；显式新建的空项目不受影响。
- 0001_projects 已执行的 SQL/checksum 保持不可变，只修复首次升级的转换分支。已迁移的开发版数据不按名称批量删除；本机修复须通过旧 Group、成员和迁移备份核对来源，备份后只清理被证实误迁移且无任务/调度引用的空容器。

项目目录选择由 projectService.readDirectory 按 hostId 路由到所属 Host，再复用该 Host 的 fileService/systemService。UI DirectoryBrowser 只适配此契约，桌面和手机共用；不依赖 desktop-only Source settings attachment，也不解析/创建 workspace 身份。查询不读写项目数据库、不启动 Agent；路径不存在/连接断开明确报错。

创建向导连接某个已保存 Host 时，暂停其他连接入口与返回操作，连接完成或失败后再开放，避免同时进入两个连接流程。

### Migration ID 命名

两个库均使用四位补零、库内递增的序号加 `snake_case` 语义名称（`NNNN_description`），不把产品版本或 schema 代号混入 ID。task-index 第一条版本化迁移统一为 `0001_projects`，后续从 `0002_...` 递增；CLI 的 `0001_base_session_store` 至 `0020_session_soft_delete_outcome` 保持不变，两库各自编号。

此次仅修正开发期间使用的 `v3_projects` 名称，SQL 文本、checksum、app_version、执行时间和数据转换逻辑不变。正式升级使用新 ID；已运行本分支开发版的本机数据库通过一次性维护核对旧 checksum、备份，再在事务中只更新 schema_migration.id。不在公共 runner 添加历史别名或第二条转换路径，不把已执行数据当成首次升级重新迁移；本机维护须验证所有业务表内容不变。

### 项目行快捷入口补充

项目行与聊天框项目菜单共用项目详情浮层，本地和远程项目均支持 hover / focus。标题只显示一次项目名，正文不再重复「项目名称」。本地项目正文仅显示「目录」，按项目 `roots` 原顺序逐项展示完整绝对路径；零目录显示「—」，不创建目录。远程项目在相同布局中保留 Host 的连接状态、进度、设备名、连接类型和地址。长路径换行，浮层不超出可用视口；浮层较窄时标签和值改为上下排列，避免目录被挤成一字一行。沿用现有移出、失焦、Escape 关闭和文字复制行为，触屏点击仍执行原有项目操作。

2026-11-06 关闭时序：项目行与聊天框项目菜单均在离开触发区和详情区时立即关闭，不等待关闭计时器或退场动画。快速扫过多个项目不得产生迟到打开或残留叠层；同一入口的 pointer / focus 共用唯一的 300ms 打开任务，离开时撤销。触发区与详情之间的 4px 间隙作为连续命中区，允许移入详情选择、复制文字；选区不阻止离开关闭。触屏操作不排入 hover 打开任务。

```text
pointer / focus → 一个可撤销的打开任务 → 当前详情
离开区域 / 失焦 / Escape → 撤销任务 + 立即关闭
触发区 ↔ 4px 连续命中区 ↔ 详情（可选择、复制）
```

详情只读取既有项目与 Host 投影；hover 不查询目录、不建连接、不创建 workspace。桌面与手机共享组件，深浅主题及中英文遵守同一展示规则。

```text
项目 name / roots → 通用详情：标题 + 目录列表
可选远程 Host     → 追加连接状态、进度、设备、类型和地址
```

更多下拉与右键复用同一组操作定义，菜单均为非模态，快捷按钮不触发行折叠。查看文件复用现有 WorkspaceFileTree：单 root 直接打开，多 root 由文件按钮菜单选择；零 root 保留禁用按钮，不创建目录或任务。离线远端仍只允许移除本机入口，不借本机文件服务读远端路径。

项目行右键的每个查看文件条目统一显示「查看文件 · 绝对路径」，只有一个 workspace 时也显示完整的 `rootPath`；不缩写为目录名或 `~`。多目录文件菜单复用相同文案，行内文件按钮仍只显示动作提示。项目文件菜单限制在浮层可用宽度内，长路径可换行，避免窄屏裁掉路径。桌面与手机窄屏、深浅主题均沿用共享菜单样式。

文件树展示目标归侧栏 UI，项目折叠状态按 Host + project ID 归常驻侧栏，查看文件后返回列表时保持。远端连接/绑定归现有连接管理器；只有显式查看文件才请求工作区绑定，手机只走可信 shared-host switchWorkspace。迟到的旧打开请求不得覆盖新选择，任务归属和 continuous/replayable 语义不变。

```text
项目行点击 / 右键 -> 同一操作定义 -> 选 root
  本地 -> 现有文件树(path)
  桌面远端 -> 现有 Host 连接与 workspace 绑定 -> 文件树(path + identity + sessionId)
  手机 -> shared-host 切换 -> 已绑定文件树
```

### 项目编辑器源文件夹列表（2026-09-11 用户纠偏）

- 零 root 显示整块“添加 ZCode 可读取和编辑的文件夹”；已有 root 后切换为同一个带边框的列表，末行是 FolderPlus +“添加文件夹”，不继续显示空态大卡片。每个 root 行显示文件夹图标、末级目录名（完整路径放 title），右侧为“主要”标记或“设为主要”按钮，以及移除按钮。
- “设为主要”只修改编辑器草稿，保存才经既有 saveProject(primaryRoot) 写入所属 Host；取消不写入。第一个目录默认主要，移除主要目录后选择剩余首项，全部移除后无主要。新任务经 prepareSession 使用最新主要目录，已有任务 cwd 不变。
- 编辑已有项目时，底部左侧恢复删除项目按钮；创建时无删除按钮。沿用 deleteProject 的软删除语义，不删除文件或任务，不增加确认层；远端必须传原 hostId，失败停留弹窗并显示错误，不降级成本机移除。保存/删除共用提交互斥状态，成功后刷新并关闭。
- 表单草稿归 ProjectEditor，持久态归 Host projectService，复用已有目录浏览器和 API；不增加 schema、migration 或同步队列。桌面与手机使用相同 UI/服务路径，continuous/replayable 边界不变。明暗主题、长路径与 390px 布局均需验证。

```text
设为主要 / 移除 root -> 编辑器草稿 -> 保存 -> 所属 Host.saveProject
                                                 -> 新任务 prepareSession 取主要目录
                                                 -> 旧任务 cwd 保持
删除项目 -> 所属 Host.deleteProject -> 刷新 -> 关闭编辑器
```

### 旧产品体验保留（2026-09-11 用户最终确认）

#### 2026-09-14 侧栏回归修复

- 删除顺序稳定性（2026-10-15）：项目菜单、编辑器删除及离线入口移除都只通过既有命令更新权威目录。命令返回到目录刷新之间，项目保留原位置；新目录到达后直接消失，其他项目的相对顺序不变。删除不提前清理控制端排序键，否则旧目录里的项目会被当作未排序项追加到末尾。沿用偏好保留暂时不可见项目位置的规则，刷新失败仍保留旧目录和顺序；不增加删除副本、计时器或动画补偿。桌面与手机继续共用目录 owner，远端命令仍按原 hostId 路由。

```text
删除 / 移除入口 -> 所属服务命令 -> 权威目录刷新 -> 项目从原位置消失
控制端排序偏好 -------------------------------> 保持其他项目相对顺序
```

- “已置顶”恢复 `text-ui-base font-medium text-foreground-subtlest`；与项目/任务分区标题左边缘一致（约 18px）。置顶任务恢复外层 8px 横向留白。分区标题补回 8px 外层留白，不叠加到项目行。
- “任务”分区的会话列表与项目内会话共用 8px 左侧留白，整行悬停背景、文字、空态和分页入口一起内缩；明暗主题与 390px 布局保持一致（2026-10-14 纠偏）。
- 项目列表恢复 dnd-kit 垂直排序位移和过渡，支持指针及键盘。同置顶分区内允许跨 Host 交换位置；仅写当前控制端侧栏偏好，不改远端 position。任务拖入项目继续走原生 session payload 和 moveTask，不触发项目排序。点击、菜单、新建与文件入口不误启动拖拽，Escape 取消不写入。
- Host 是项目顺序的唯一已提交 owner；拖动期间只有 UI transform，落下通过 reorderProjects 提交后刷新，失败保留权威树并提示。桌面 continuous、手机 shared-host/replayable 边界不变。
- 已展开空项目、在线 Host 的空任务列表显示国际化 `taskList.noTasks`（中文“暂无任务”），沿用旧任务文字缩进；空置顶区不显示标题或空态，离线/加载态不伪造“暂无任务”。
- 系统 `~/.zcode/workspace/default` 曾因旧 settings 缺失/误写 purpose 被首次迁移建成项目。新增一次性 `0006_default_workspace_tasks`，不改已发布 0005 SQL/checksum：仅纠正旧迁移时创建、单 root 为系统 default、未改名/编辑的自动项目；任务 project_id 清空，误建容器软删。普通路径下的 default、手建/改名/多 root 项目保留。只写 Host tasks/projects，任务 cwd、CLI 镜像、置顶/归档/未读、定时/闲时执行快照不变。迁移有表级备份且事务失败回滚，重复启动不重算归属。

```text
拖动 -> UI 位移 -> 同 Host reorderProjects -> Host 顺序 -> readTree
旧迁移 default 项目 -> 0006 事务 -> tasks.project_id=NULL -> 原任务区
                               -> projects.deleted=1 -> 不显示误建项目
```

验收：VP31（字号/缩进/空态、指针排序动画、键盘取消/排序、刷新顺序，明暗与390px）；VP28 增补 purpose 误标的系统 default 升级及任务保留。存储单测覆盖已有 ledger、首次升级、Windows 路径、归档/置顶/未读与其它表哈希、同名手建项目和幂等。实际手机/SSH/WSL 未执行时单列限制。

本节覆盖实施期间简化的排序和展示规则。老 Group 及其颜色、手动成员排序、吸顶标题不恢复；点击项目仅折叠/展开，不进入目录草稿。此前明确隐藏的时间线、归档和独立连接入口不恢复。其余沿用旧产品体验：

- 项目和未归类列表默认 5 条，每次增加 5 条；置顶区保留“已置顶”标题，默认 20 条，可显示全部与显示更少。分页不随等价快照刷新重置。
- 项目和置顶任务的 running/prewarming 优先，运行层按 CLI 创建时间降序、taskId 降序；普通层按创建/更新时间偏好排序，另一时间为第二关键字，taskId 降序。复用原比较器，禁止将 Host 组织修改时间或 Date.now 写入排序；CLI 事实来源与 UI 排序策略是两个边界。
- 创建/更新时间选择放项目标题右键，和项目容器排序明确区分；旧任务时间偏好继续读取。项目容器排序模式和 Host+projectId 折叠偏好在浏览器持久化；本地单 root 历史项目初始可读原 workspace 折叠偏好，显式新偏好优先，不读取旧 Group 状态。
- 当前任务高亮必须同时匹配 Shell 当前 workspaceKey 与该 workspace 的 activeTaskId。桌面复用现有远控状态订阅，按完整 workspaceKey+taskId 显示手机访问标记，不改变 desktop continuous / mobile replayable 链路。
- 收起项目且存在未归档的未读成员时，在项目名右侧显示原大小的蓝点；包括仍属于该项目的置顶任务，排除其它 Host 的同项目 ID。展开后由任务行显示未读；点击展开不清除未读。未读从 Host readTree 派生，不新增计数表或同步状态；离线没有任务事实时不伪造未读。
- 归档成功清理对应任务 UI 状态，当前任务退出详情，与 Header 一致；失败保留会话并提示。置顶/取消置顶先显示在途意图，失败撤销并提示；权威行仍来自 Host。按完整任务地址限制同任务在途置顶，迟到旧响应不得覆盖新树。未读继续使用 expectedUnreadAt CAS。
- 普通任务行不提供右侧文件树按钮；置顶区任务恢复查看文件入口（2026-10-12）；项目行保留查看文件入口。定时任务/插件按钮恢复选中态。
- 远端项目恢复原 Skills/MCP/Plugins 同步快捷菜单及原平台适用范围（桌面在线 SSH/WSL，手机不新增同步能力）；同步使用既有 dialogs、workspace services 和刷新流程。远程以唯一固定目录为操作范围，禁止追加或合并其它 root 配置；未就绪 attachment 不发 RPC。
- 连接行复用现有重连日志展示及失败详情/复制；连接进度归连接管理器，UI 不另建连接状态机。列表错误与具体连接错误分开呈现。

分层：project-sidebar 是 UI 模块，纯选择器只派生数据；偏好 hook 只管理显示偏好；任务交互 hook 只适配既有 task command 与在途 UI 意图；远端操作组件只适配既有连接/同步接口。业务归属、命令校验与落盘仍留 Host Service，不在 UI 新建 Repository、事实缓存或已接受命令队列。现有 TaskList 仅新增必要可选展示参数/文件回调，保持其它调用兼容。

```text
Host readTree + CLI activity -> 纯选择器 -> 排序 / 折叠未读展示
Shell active workspace + task UI -> 选中态；mobileViewState -> 手机标记
用户 pin -> UI 在途意图 -> 既有 Host command -> 权威刷新 -> 释放意图
                          失败 -> 撤销意图 + 提示
用户 archive -> 既有 Host command 成功 -> 清理任务 UI + 刷新
远端菜单 -> 已有 workspace attachment -> 原同步 dialog / service
```

本次不修改 schema/migration 或本机数据库。回归包含本地/远端完整身份隔离、刷新/失败/晚到结果、390px 与明暗主题；真实手机/SSH/WSL 未实际执行时必须单列限制。

连接诊断实施补充：remote-projects.readDirectory 从同一装配端口取得连接管理器的 status/error，恢复 online 即清除旧错误，均不写 SQLite。项目连接的进度复用现有 AsyncLocalStorage requestId 日志链，关联 hostId+membershipId；UI 只展示当前成员的日志，移除/重加不能收到旧成员日志。不新建连接 owner 或重试机制。

连接日志端口继续沿用 `TransportContext.onLog`：Host 装配时注入统一上报回调，管理服务只向既有 manager 的 connect context 传递回调；不新增连接状态 owner。项目文件树保持当前 root/Host 路由与可信 shared-host attachment；关闭或新选择使迟到文件目标失效。

置顶意图生命周期：只覆盖 Host 命令和本次权威刷新在途期间；刷新完成（或失败）即释放，不以查询值必须等于期望值作为释放条件。另一客户端可能在此期间再次修改 pin，必须显示最新 Host 事实，禁止把已完成的意图保留成第二份状态。

### 项目折叠动效与任务行入口纠偏（2026-09-11）

项目展开/收起复用旧 WorkspaceSidebarItem 使用的 Collapsible、CollapsibleTrigger、CollapsibleContent：300ms 高度过渡和内容淡入淡出，收起动画结束后才卸载任务列表；快速反向点击由同一个受控 open 值驱动，不增加计时器或另一份折叠状态。折叠偏好仍归 useProjectSidebarPreferences，展开不导航、不改未读，离线不可展开。

项目、未归类和时间线行不显示文件树按钮。置顶区任务恢复右侧查看文件入口：复用 TaskRowActionButton 和 ListTree 图标，在 hover/focus/touch 时显示；点击不选择任务、不修改未读，打开任务固化的 workspacePath，而非项目当前主目录。本地任务不依赖打开的 tab；远端任务仅在对应 identity 的 session 存在时提供入口，禁止退回本机文件读取。手机先复用可信工作区切换；项目与任务文件打开/关闭共用一个请求序号，迟到切换不得覆盖新选择或关闭。保留项目行查看文件、归档/置顶与原右键动作。桌面和手机使用同一个渲染入口，不修改 Host/CLI、workspaceIdentity 或 continuous/replayable 链路，无 schema/migration 改动。

```text
点击项目 -> 原折叠偏好 owner -> Collapsible.open
                             -> 高度/透明度动画 -> 收起完成卸载内容
快速反向点击 ----------------> 同一 open 值更新（无额外 timeout）
```

共享 Collapsible 的透明度动画必须由当前 content 的 data-state 直接作用于其子层，不能用可命中任意祖先的同名 group 选择器；项目区内嵌套项目节点时，外层保持 open 不得覆盖内层 closed 的淡出。高度仍由当前 content 自身驱动，无额外动画状态。

### 2026-09-11 补充：输入框项目选择器与侧栏同源

- 项目选择器列出侧栏完整的未删除虚拟项目，包含未打开目录、零 root、自定义名称与本机保留的远程入口；不再读取 workspace tabs，不截断为前 5 项。项目排序复用侧栏偏好；置顶项目排在普通项前，区内顺序不变。搜索文案为“搜索项目” / “Search projects”，按项目名称和 roots 搜索。
- `project-sidebar` 的窗口级 Provider 单独持有项目树读取及偏好；侧栏与 composer 读取同一投影。Host 仍是项目、roots、远端入口的唯一权威，UI 不写库、不创建第二份项目缓存。读取错误显式显示，不退回 tabs。远端离线/未解析入口可见但不可选。
- 选中态取草稿 `projectId` 与 workspace 的 Host 身份，同 cwd 的不同项目独立。无项目归属显示“选择项目”。选择项只调用现有 `onCreateTask({projectId, hostId})`，由 Root/Host 的 `prepareSession` 准备主要目录（零 root 自动补齐），再进入草稿；不自行按目录推断归属、不为展示项目拉起 Agent。已提交 session 的 cwd 与归属不改。
- 维持原菜单外观、搜索、远程连接和不在项目中工作/脱离入口；长列表在菜单内部滚动。项目改名、移除及顺序变化同时反映到两处。
- 2026-10-13：底部“打开文件夹”替换为“创建项目” / “Create project”（复用 `project.create`）。选择后关闭菜单，挂载侧栏同一个 `ProjectCreation`，沿用设备/名称/roots、目录信任确认、保存与刷新流程。默认设备也与侧栏一致：已有远程会话取所属设备，其余默认本地。保存或取消不打开工作区、不创建会话、不改变当前项目/草稿；保存后可从共享列表显式选择新项目。手机同样使用项目服务，不受原生打开文件夹能力开关限制；新增远程设备仍沿用原能力限制。聊天新建远程连接完成后，按 [#21](../../issues/remote-connection-ux/21-chat-settings-round-trip.md) 进入必选目录流程；普通创建独立使用上述默认设备，不继承连接结果。

- 2026-10-13：composer 头部在分支选择器（办公模式为插件入口）之后显示 Plus 快捷按钮，提示与无障碍名称为“编辑项目” / “Edit project”。按钮只对当前选中的可编辑项目显示；无归属、已删除、离线或旧版只读项目不显示。当前项目仍由同一菜单按 projectId + Host 解析，不按 cwd 推断。点击直接打开侧栏同一个 `ProjectEditor`，可改名和管理目录，沿用原删除与远端限制。保存/删除通过原项目服务并刷新共享目录；取消不写入，编辑不触发任务创建或目录导航，文本草稿保留。聊天/草稿身份变化时旧编辑器失效，不得在切回后复活。该快捷入口仅由聊天壳层启用，自动化等复用选择器不新增按钮。

```text
Host readTree + retained remote entries -> ProjectDirectoryProvider -> sidebar / composer
composer 创建 / sidebar + -> ProjectCreation -> ProjectEditor -> 目录确认 -> Host saveProject -> refresh
                         -> 取消 / 保存完成 -> 当前会话和草稿保持
composer + -> 当前 projectId + Host -> ProjectEditor -> Host saveProject / deleteProject -> refresh
           -> 取消 -> 当前会话和草稿保持
user selects {hostId, projectId} -> existing Root createTask -> Host prepareSession -> draft
 desktop: existing continuous navigation
 mobile: existing shared-host attachment -> replayable navigation
```

异步读取复用既有请求序号和远程 membership 校验；没有新增 stream、owner、accepted queue 或持久化迁移。手机仅复用已在线 Source，仍走原 shared-host admission，不创建另一套 runtime。

### 当前任务元数据与自动归档收尾（2026-09-11）

- 详情元数据通过已有 workspace-scoped `ZCodeTaskService.getTaskMeta` 读取 Host 索引（CLI 事实镜像 + Host 组织态），不再读取 CLI active runtime 的 `readSession`，也不依赖旧列表/query cache 是否恰好含当前任务。已归档历史直接打开仍可读取标题。首发尚未落索引时只复用现有未提交乐观元数据，不新增事实写者。
- 详情读取由现有 active-task hook 拥有；监听当前 workspace 的列表变更、已有 taskListVersion 和 projects 广播重读。请求按 service/attachment + workspaceKey + taskId 隔离；后发请求优先，切换身份或卸载即丢弃迟到结果。失败记录日志，不能拿前一任务标题填当前任务，也不为标题恢复 CLI。
- 自动归档判据、七天追溯生效及未读 CAS 不变。项目树接受新结果时，只对同 Host + workspaceKey + taskId 从 `archived=false` 变为 `true` 的任务，调用既有 `removeTaskState` 清理本窗口选中态/详情；手动、自动、另一端归档保持相同效果。不把首次读到已归档记录、离线缺行、移除项目入口或失败响应当成归档事件；明确打开既有归档历史仍可查看。读取在途期间，如果有导航提交打开了这个任务（同 workspaceKey + taskId），以之后的导航为准，这一轮不清理：项目树读取是 single-flight，读取期间的新变化只排队到下一轮，所以被接受的快照可能已经过期（例如归档、取消归档、打开在一次读取内先后发生），清理又无法撤回，不能用过期快照顶掉更新的导航（2026-11-06，PLM-EXT-P3C 运行时证据）。
- 自动归档发生时退出当前详情到原工作区草稿，不自动选中下一条同名任务。导航和草稿仍由现有 session UI store 拥有；项目读取 hook 只比较两个已接受快照，不持久化第二份 archived 或新增同步计时器。
- CLI/Host schema、migration、owner/lease 以及消息流协议均不变。远端元数据经现有 scoped service/attachment，桌面保持 continuous，手机保持 shared-host + replayable；归档清理不发送停止/删除 CLI 命令。

```text
CLI 事实 -> Host tasks-index <- Host archive 命令 / 自动归档
                 |                              |
         getTaskMeta + 变更事件             readTree 已接受结果
                 |                              |
           当前任务详情标题           false -> true -> removeTaskState
正文：desktop continuous / mobile replayable，各沿原 V4 subscribe 恢复
```

验收：AMT01 冷历史正文恢复前即可读到真实标题，rename 后同步；AMT02（2026-09-14 改写）一条同名旧已读 + 一条旧未读，开启七天归档后已读那条由设置变更扫描归档并离开列表；点开未读那条只清未读，保持打开且在列，另一条不变；AMT03 已归档历史显式打开可读，缺行/离线/迟到查询不得误清当前选中态；AMT04 同路径不同远端 identity、切换任务、乱序返回不串标题/归档。单测覆盖时序和隔离；pending E2E 覆盖真实 Host/SQLite/renderer，桌面与手机/远端执行证据分别报告。

### 自动归档触发点脱离 UI 动作（2026-09-14，维护者）

用户裁决：符合判据的任务应当已经从列表消失，是否归档的判定不能由「点击某条 session」触发。此前触发点挂在项目树查询 `readTree` 上：点开旧未读任务 → CAS 清未读 → 侧栏按 taskListVersion 刷新 → readTree 顺手执行 archiveInactive → 刚打开的任务在 1 秒内被归档并退出详情，用户感知为「打不开」（`sess_aa1fce05…`，2026-09-14 CDP 复现）。

- 触发点改为 Host 定时扫描器（`packages/services/src/project/autoArchiveScheduler.ts`）：服务装配完成即扫描一次，之后每 5 分钟一次（2026-09-15 由每小时缩短）；`taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays` 变更后立即补扫。扫描串行，扫描进行中的重复请求合并为一次补扫；desktop-attached-remote 不启动，远端 Host 扫描自己的库。
- `readTree` / `readProjects` 只读，项目服务不再持有 `autoArchive` / `beforeRead` 入口；点击、刷新、切换任务不改变任何 archived。
- 判据不变；仍不豁免「正在查看的已完成任务」（沿用 2026-09-11 裁决）：定时扫描命中当前详情时，项目树 false → true 的既有清理照常退出详情。
- 删除无发射者的 `workspace_task_list_changed.reason` 取值 `auto_archive` / `realtime_sync`。

```text
设置变更 ──┐
启动首轮 ──┼─► scheduler.scan() ─► archiveInactive(cutoff, activeTasks) ─► publishProjectChange ─► 项目树 false→true ─► removeTaskState
每 5 分钟 ─┘
点击任务 ─► setTaskUnread(CAS) ─► V4 subscribe            （不再进入左侧链路）
```

验收：AMT02 改为「开启七天归档 → 已读旧任务由设置变更扫描归档并离开列表；点开旧未读任务只清未读，任务保持打开且在列」；扫描器的首轮/间隔/设置补扫/串行合并/dispose 由单测覆盖。

### 自动归档判据改为纯按时间（2026-09-15，维护者）

用户看到 31 天前的 `error` 任务仍在列表，裁决「纯按时间，置顶不受影响」。本机数据：超期、已读、未归档的任务里 error 324 条、无 CLI 结果 346 条，旧判据（仅 completed）让它们永远留在列表；未读也不再是保护条件。

- `archiveInactive` 判据：`archived=0 ∧ pinned=0 ∧ deleted=0 ∧ cli_deleted=0 ∧ cli_updated_at < now − N 天 ∧ host_id = 本 Host`，再排除 `activeTasks`（syncer 观察到的非终态会话，作为安全兜底）。`cli_updated_at` 为 NULL 的无事实预留行不满足比较，不归档。
- 归档不改未读、不改 CLI 事实；被归档的未读任务在归档管理里仍带未读。
- 扫描间隔 1 小时 → 5 分钟；触发点仍是启动首轮、定时、设置变更补扫，不挂任何 UI 动作。
- 设置页文案同步为「将最后活动时间超过保留期的任务自动归档；置顶和运行中的任务不受影响」。

验收：AMT02 改为「开启七天归档 → 28 天前的已读与未读任务都归档，置顶旧任务与 6 天前任务保留；点开 6 天前的未读任务只清未读并保持打开」；仓库单测覆盖 pinned / running / recent / nofacts 例外与 unread / error / NULL 归档。

### 自动归档修复后的重新开启（2026-10-14）

旧版本自动归档未生效时，用户可能已经打开开关。修复后不能仅凭旧值在升级首轮扫描中批量归档历史会话；必须由用户在新版重新开启。

- 设置迁移新增内部标记 `taskAutoArchiveResetVersion: 1`。原始设置缺少该标记时，一次性将 `taskAutoArchiveEnabled` 归位为 `false` 并写入标记，保留 `taskAutoArchiveOlderThanDays` 及其他设置。新用户仍默认关闭。
- 复用完整设置 schema 的迁移入口与 SettingService 的写队列、文件锁、锁内重读和原子写入。`get()` 完成迁移持久化后才返回；写入失败时扫描失败，不读取旧的开启值继续归档。并发读取不得覆盖用户刚保存的新选择。
- 用户从归档管理重新开启后，沿用设置提交事件立即扫描；后续重启、重复读取和升级保留用户选择。迁移标记只供设置迁移使用，扫描器仍只消费开关与保留天数，UI 无新增状态或确认弹窗。
- 每个 Host 的 SettingService 只迁移自己的配置；远端任务由远端 Host 执行，desktop-attached-remote 不在本机代迁移远端设置。桌面 continuous 与手机 shared-host/replayable 边界不变。
- 不改会话数据，不恢复此前已归档的会话，也不调整归档判据、周期或保留天数。

```text
Host 首轮/定时扫描 → SettingService.get → 锁内重读旧配置
                                          ├─ 无标记：关闭开关并写入标记
                                          └─ 有标记：保留当前选择
                                      → 持久化成功 → 返回策略 → 决定是否归档
用户重新开启 → SettingService.update 提交 → 设置事件 → 立即扫描
```

验收 AMT05：旧配置开启、存在超期会话 → 冷启动 → 开关关闭、天数保留、会话仍在；手动开启 → 旧会话归档；再次冷启动 → 开关保持开启。单测覆盖新配置、旧开关各取值、重复迁移、并发读写、独立 Host 设置及迁移落盘失败；E2E 复用 AMT02 的隔离历史 fixture，保持 pending。

验证：macOS Electron `desktop-e2e-20261014095631138-p83694-9cfbd531c2af7be8` 2/2 通过，覆盖旧配置冷启动关闭、手动开启后的真实 SQLite 归档、第二次冷启动保留开启，以及既有标题/置顶/未读路径。截图与 Host 日志确认仅在手动开启后归档两条超期会话。根增量单测 1432 文件 / 16280 项通过、6 项跳过，root/E2E typecheck、lint、架构与 fixture check 通过。真实手机配对、SSH/WSL 和 Windows/Linux GUI 未实测；独立 Host 配置隔离由服务单测覆盖，用例保持 pending。

## 侧栏搜索与视图切换（2026-09-15，SBV01–SBV06）

本节覆盖此前「时间线隐藏入口、右键选择项目/任务排序、读取旧时间偏好」的规则。

- 导航区（新建任务、自动化、插件市场）与列表区分开，两区之间使用 1px border-border/50 分隔线，横线延伸覆盖侧栏右侧 4px 调宽区域，装饰不接收指针事件，不改变拖拽尺寸及交互；切换文件视图时横线随任务列表隐藏；列表头部距分隔线 12px，头部下方到列表滚动区间距 8px。列表区有独立固定头部，头部不属于导航组件，也不进入列表滚动及渐隐容器；项目/任务分区在头部下方独立滚动。头部展示标题与搜索、筛选图标行：左侧总标题显示「任务列表」（分区标题保持不变），右侧依次 Search、ListFilter。两个图标按钮均为 icon-sm（24px），图标 14px，按钮间距 4px；总标题使用 text-ui-lg（默认 16px）和次级文字色 text-foreground-subtle，分区标题保持 text-ui-base（默认 14px）和 text-foreground-subtlest。搜索入口为带国际化 aria-label 和快捷键 tooltip 的按钮（提示标题与 shortcut 参数分开传入，快捷键复用 ControlShortcutBadge，不拼接分隔符），点击仍调用原 Shell 全局搜索，不显示输入框或常驻快捷键文字，不新增搜索状态或快捷键监听。明暗主题、桌面和手机沿用同一布局。
- 筛选菜单仅「按项目 / 最近更新」两项，左侧分别显示 Folder / Clock 图标，右侧勾选当前视图；移除项目分区右键中的两组排序选项，其余项目/任务操作保留。
- 按项目：保留置顶、项目、任务分区，不显示 Host 分组；项目按当前控制端复合身份偏好手动排序；任务 running/prewarming 优先，运行层创建时间倒序及 taskId 决胜，普通层更新时间倒序。项目/未归类 5/+5，置顶 20/全部/更少。
- 最近更新：从同一 ProjectTree 中取所有未归档任务，包括置顶、未归类和树中已删除项目的历史；不显示项目或 Host 分组，恢复今天、昨天、2/3 天前、本周、上周、本月、上月、更早的日期标题，无独立置顶区，每行只出现一次。严格 updatedAt 倒序，再 createdAt、taskId 倒序，以完整 Host/workspaceKey/taskId 稳定决胜；运行态不改变顺序。首屏 20，每次 +20，刷新数据不重置数量；重新进入视图从首屏开始。
- 最近更新复用现有 timeline 双行任务样式：首行状态与标题，第二行左侧为任务绑定工作目录的末级名称（不是虚拟项目名），右侧为相对更新时间及原有元信息。无状态任务不显示圆点，保留图标槽以对齐标题；未读/错误/运行/置顶/手机激活状态沿用共享行规则。按项目仍用紧凑单行。
- 日期标题只在已排序并分页的相邻日期段首项前显示，不占分页名额、不重复创建任务分组，也不改变完整任务 key。日期按客户端本地日历和语言计算（en-US 周日开周，zh-CN 周一开周），跨日以日历日期判定，避免夏令时误差；刷新投影/重新渲染时重新派生。追加分页不重复同段标题，时间变化可跨段重排，操作中的行仍由完整任务身份保持。
- 选择器和渲染层显式接收展示模式，避免渲染层重新套用运行优先。排序时间只来自 CLI 镜像，不从 Host 组织修改时间或 Date.now 派生；pin 不影响时间顺序，archive 成功后退出两种视图。
- 唯一偏好 owner 为 ProjectDirectoryProvider 中的 useProjectSidebarPreferences。既有 zcode-project-sidebar-preferences 新增 view=projects|timeline，默认/非法值回落 projects；继续保存 expanded。旧 sort 和 zcode-sidebar-task-preferences.sortBy 不再读取，旧折叠保留，Host position 仅作首次种子，项目显示顺序改存控制端 order=[hostId,projectId]。localStorage 不可用时当前窗口仍可切换，桌面/手机各自保存偏好。
- 视图切换不改任务归属、当前任务与项目折叠；composer 项目选择器继续共用目录并按手动项目顺序显示，不响应侧栏视图切换。无 Host/CLI/RPC/SQLite 变更。
- 本地/远端任务来源沿用原项目树可见范围，不为列表建立新连接或任务缓存；身份仍是 Host + (workspaceIdentity.trim() || workspacePath) + taskId。桌面 desktop-continuous 和手机 web-remote-replayable 保持原 shared-host 导航与传输边界。

```text
用户选择 -> 共享偏好 owner -> 当前客户端 localStorage
                    |
Host readTree + CLI 时间镜像 -> 纯选择器 -> 项目列表 / 最近更新列表
搜索点击 / 原快捷键 -> Shell -> 现有全局搜索
任务操作 -> 既有 Host command -> 权威树刷新 -> 当前视图重新派生
```

影响面：presentation / option-source / persistence。必须检查导航、ProjectTaskRows、view 选择器、共享目录偏好；composer 项目菜单是共享顺序消费者，归档管理只回归行集合边界。代码图查询因 unresolved_refs 索引错误失败两次，本次按真实引用追踪；功能图旧 WorkspaceSidebarItem / Group / Pinned / 行投影 seeds 已更新为当前项目侧栏入口。无新的异步 owner、队列或同步策略。

### 已接受验收

| Case  | Setup → Action → Assertion                                                                       | 非 UI 证据                     |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| SBV01 | 插件市场导航 → 点击搜索图标/原快捷键 → 同一全局搜索、菜单仅两项、正确平台键帽                    | Shell callback / 键盘测试      |
| SBV02 | 展开/收起项目并打开任务 → 切换视图/刷新 → 当前任务及折叠保留、view 恢复                          | localStorage、导航 store       |
| SBV03 | 项目/未归类/已删除项目、置顶/运行/归档、跨 Host 同路径任务 → 最近更新 → 纯时间、无重复、不含归档 | 纯选择器 fixture / Host 树     |
| SBV04 | 旧 created/updated 偏好和手动 position → 加载 → 忽略旧排序、composer 与侧栏项目顺序一致          | localStorage、同一目录读取次数 |
| SBV05 | 超过 20 条任务 → 更多/刷新/时间更新/pin/archive → 连续分页、重排、pin 不搬行、archive 移除       | fixture 镜像与命令结果         |
| SBV06 | 桌面和真实手机 shared-host → 搜索/切换/重开 → 同一任务身份、桌面 tab/Host 数不增加               | Host 进程、导航 store、身份    |

用例先落 manual-review/pending，复用隔离 HOME、case-local fixture；纯列表新增断言不发模型请求。明暗主题、390px 截图不替代真实手机验证。已确认剪枝：全局搜索范围扩展、旧排序选项、归档混排、远端连接策略、模型/provider 组合均不在本变更内；无待定产品问题。

### SBV 验证记录

桌面验证：`desktop-e2e-20260915131918480-p99856-ceccb6286a056017`，8/8 通过；含 SBV01–05、旧项目交互及 1200/390px 明暗主题截图。相关单测 7 文件 / 45 条通过；`pnpm typecheck`、`pnpm lint`（47 条既有 warning，0 error）及 desktop E2E 类型检查通过。相对 HEAD 的架构检查 0 违规；默认相对 origin/staging 仍有开工前已存在的 `packages/ui/src/root/resolveConversationWorkspaceTarget.ts` 未受管文件错误，本次不改其模块归属。

手机验证：`desktop-e2e-20260915133055419-p10183-be1302f33f03e81a`，1/1 通过；Chrome for Testing 以 390×844、hasTouch/isMobile 访问本仓 Web，经真实 relay/shared-host 完成搜索、两种视图与刷新恢复、任务重开和连续切换保留当前任务，桌面 task 标记及 Host/tab 数断言通过。用例使用隔离 HOME 与既有 synthetic provider fixture；新入口使用 touch tap，菜单关闭后继续下一操作。取 Host 证据后关闭资源管理器，避免检查器持续采样干扰待启动 CLI。通过 `ZCODE_E2E_BROWSER_NO_PROXY=1` 与 `ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE` 选用测试浏览器直连，未关闭 TLS 校验。

范围说明：手机证据为浏览器触屏模拟中的真实 shared-host 链路，不是实体手机；Windows/Linux 快捷键由单测覆盖，未在对应操作系统跑 GUI。跨 Host 同路径/同 taskId 的排序身份由单测覆盖，未新增 SSH/WSL 真机验证。默认 staging 架构基线问题保持单独记录，不记为本次增量通过。

## 查看文件的侧栏切换动效

点击项目「查看文件」后，项目导航向左移出，文件树从右侧移入；返回时反向滑动。沿用 200ms ease-out 的 transform 动效，两面板在切换期间保留 DOM，离场面板禁止交互并对辅助技术隐藏。尊重减少动态效果设置。关闭时逻辑打开状态立即为 false，最后一个文件目标仅保留到浏览器退场动画完成；完成后卸载文件树，释放目录 watcher、取消待刷新任务并丢弃迟到结果。减少动态效果或没有实际动画时立即卸载，不用固定超时决定业务生命周期。退场期间重新打开会取消旧的卸载，切换目标沿用数据层的 workspace 清理；晚到的目录解析仍由原有请求序号丢弃。桌面和手机共用此行为，不改变目录身份、主题或语言。

## Task 列表滚动边缘渐隐

项目视图和 task 时间线共用滚动容器，复用 ScrollFadeViewport 的 24px mask。内容未溢出时无 mask；顶部仅下缘渐隐，中间上下缘渐隐，底部仅上缘渐隐。内容或容器尺寸变化后重新计算，导航栏和底部账户区域不参与 mask。保留列表原有间距、纵向滚动、拖拽边界，桌面和手机、深浅主题共用透明度渐变，不增加颜色或业务状态。

MR !2897 手机文件导航：identity 的权威 session 映射与实际 services 注册共同证明连接有效，不要求 session 重复保存 identity 字段。跨 workspace 的 `workspace-bridge-open` 使用 `fileTreeTaskId` 与 `taskHostId` 定位可信任务 cwd，不能同时携带选择任务的 `taskId` 或 project 草稿。Host 复用任务目录准备，不设置 `initialTaskId`；手机新 Root 初始打开文件树，不选任务、不清除未读。旧 Root 的待返回请求仍遵循原有 generation 清理。关闭文件树后清除壳层已消费的打开请求，侧栏重挂载不得再次消费旧入口。

## 2026-10-26 fork 归属交接与远端历史空归属修复

CLI 的 fork 提交与 Host 的项目归属是两个 owner 的独立提交。Host 收到成功或重复 fork ACK 后，按同 workspace 的父任务继承项目与固化执行目录，落库成功后才将 ACK 返回界面。项目 ID 不进入 CLI 协议。sessions-index 首次摄入使用同一父任务证据，不能仅凭目录猜 fork 项目；通知早于 ACK 和 ACK 重放均不得覆盖用户已修改的归属。

```text
CLI 提交 fork → Host 继承父任务组织态 → 返回 ACK → UI 打开
      └─ sessions-index → 首次摄入继承同一父任务（顺序可交换）
重启 → Host 迁移完成 → CLI 持久化父链 → 冷订阅历史正文
```

远端已有强制项目约束，历史 remote owner 的 NULL 行是未完成的交接。新增版本化数据迁移只修复可证明的归属：优先同 owner、同 workspace、同 root 的父任务；没有父引用的独立任务只能匹配唯一未删除单 root 项目。零或多匹配、外部父任务、断链不猜测、不自动创建项目。迁移只写 tasks.project_id 与首次判定位，保留正文镜像、时间、置顶、归档、未读和执行目录。后续 CLI 事实摄入可补齐晚到的父任务/项目证据。

本地合法 NULL、已有非空归属及跨 owner 行不能被当前 Host 重分配。重复启动/摄入幂等。迁移使用现有 runner 和表级备份，旧 migration checksum 不变。

合并兼容边界：`0010_remote_task_ownership` 保留 3.17.2 已发布的迁移行为，不修改 checksum 或重跑迁移。当前事实摄入与 fork ACK 则沿用首次判定位：只有尚未完成归属判定的同 owner 远端记录可以补齐晚到证据，已判定的归属（包括 NULL）不会因重放再次继承父项目。创建回执查询与 fork 归属预留同时保留，各自沿原事务提交，不新增第二份归属状态。
