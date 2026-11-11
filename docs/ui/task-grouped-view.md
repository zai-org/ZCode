# Task Grouped View

## 2026-10-13 恢复裁决（当前）

状态：已实现，GUI 用例保持 manual-review/pending。以下裁决覆盖本文后面的历史实现说明。

- 筛选菜单依次为“按项目 / 按分组 / 最近更新 / 按未读”，不恢复旧两级切换器。
  “按未读”遵守[任务未读状态](task-unread-state.md)的共享集合、排序与已读合同。
- 一个任务最多属于一个项目和一个分组。分组允许混放本机和远程项目任务，
  仅组织成员和顺序，不改变 project_id、cwd、附加目录、配置、权限或 CLI 活动时间。
- 保留已有手工、自动生成、空组、定时与闲时系统组；不再按 workspace 自动建组。
  查询只读，不恢复 7 天强制归档；自动归档沿用 Host 调度器和用户设置。
- 恢复名称、七种颜色、折叠、全部展开/收起、手动拖拽、吸顶、虚拟列表和取消分组。
  取消分组把全部成员按原顺序移回原顶层位置，不删除或归档任务。
- 按分组顶部复用全局置顶任务区，主体不重复显示置顶；归档任务隐藏但保留成员和位置。
  pin/unpin、archive/unarchive 不改分组关系；明确删除才清理引用。
- 四种视图的任务菜单共用加入/移出分组。项目移动与分组移动分别表达、互不修改。
- 组内新建固定 placement 到该组；执行项目仍由 Composer 选择。普通项目选择和聊天连接后的远程目录确认都沿用该草稿 placement；既有会话发起新草稿不读取残留草稿的分组。
  分组视图的全局新建继承当前任务所在组，否则进入顶层。fork 新任务进入顶层。
- placement 绑定稳定 draft identity，首次发送复用现有预热 single-flight；
  创建成功后幂等入组，不能由普通任务导航推断入组。目标组已取消则进入顶层。
  组织提交失败只重试组织动作，不再次创建 session。
- 首发目录确认与组织提交分开完成：权威任务行到达后立即发布共享目录并完成详情提升，
  分组登记独立执行，分组重读不进入首发屏障。导航取消立即结束 UI 等待；若任务行尚未到达，
  原目录 owner 保留这次创建的组织回调，确认后只执行一次，不能导航回已离开的详情。
  登记挂起或失败不得占住目录读取、阻塞其他任务或触发重复创建；失败沿用原 creationId 重试。
- 系统组继续接收新定时/闲时任务；首次登记与成员/顺序同事务提交，
  重复同步不重新置顶，用户移出或整理后重启不得拉回。
- 展示偏好归当前客户端；优先沿用有效新视图。新偏好尚不存在时迁移旧 `zcode-sidebar-task-preferences.organizeBy`：
  `grouped` → 按分组、`chronological` → 最近更新、`project` → 按项目；无有效偏好默认按项目。
  升级前选分组的用户，升级后默认仍选按分组；之后显式切换以新偏好为准。
  项目和分组顺序互不影响，Composer 项目目录不响应视图切换。

```text
所属 Host 任务/项目投影 ──┐
                         ├─ 共享目录 owner ── 按项目 / 按分组 / 最近更新 / 按未读
控制端 Host 分组结构 ────┘
菜单/拖拽 -> Host 校验 -> SQLite 单事务 -> 提交 -> 广播失效 -> 重读
草稿 -> 捕获 identity/placement -> 同一次创建 -> 权威目录确认 -> 发布目录 / 提升真实任务
                                                        └-> 独立入组提交 -> 分组重读
桌面 continuous / 手机 replayable -> 同一组织 owner，原会话链路不变
```

- 复用 task_groups、task_group_members、task_group_view_node_orders；bootstrap 表仅保留历史。
  分组服务提供结构读取、CRUD、单节点移动和首次任务登记，保存到控制端 tasks-index.sqlite。
- 任务引用保留 Host、canonical workspace identity、taskId；临时 remoteSessionId 不入持久化键。
  复用当前共享任务树，不另建任务事实缓存，不为分组查询连远程或拉起 Agent。
- 移动只提交涉及节点和锚点，事务内复检来源与目标，失效拒绝并刷新。
  不用可见列表覆盖全库，保留离线/归档/置顶成员。断线或快照缺行不等于删除。
  远程 identity 迁移同时更新成员和顶层 key；迟到响应不能恢复已移除入口。
- 取消 Group → Project 转换，保留 workspace → Project 和 CLI 事实交接。
  不修改既有 migration ID/SQL checksum，不重跑已记账迁移；必要初始化状态使用加法迁移。
  本次重构未发布，已转换的开发库不按名称或目录猜测删除项目。

### 2026-10-14 旧版呈现与交互恢复

呈现和交互以 `fd2f4f38a4a^1`（分组删除合入前）的 `workspace-grouped-tasks/`、
`WorkspaceGroupedTasksSection.tsx` 和侧栏工具栏源码为准，截图仅辅助核对。
恢复原组件，接线适配当前目录与组织服务，不重新设计样式或手势。

- 筛选“按分组”使用 `Hash`；新建分组与全部折叠入口放回列表工具栏，不在列表里再插“按分组”标题。
- 原任务行密度、标题渐隐、时间/状态/悬停操作、右键菜单、重命名对话框和文件入口恢复。
- 原分组颜色圆标、标题后箭头、数量、MessageCirclePlus、彩色竖线、可点击虚线空态恢复。
  点击圆标改色；标题/头部折叠；右键改名、改色或取消分组。系统组按旧组件禁止改名与取消。
  新建先产生组，再进入名称编辑并打开颜色菜单；保留 IME 与菜单焦点保护。
- 改名期间只禁用拖拽，不把输入框标成不可用；菜单收尾回焦不能重新全选已输入文字，
  非 IME 的 Enter 明确提交。以上由真实组件回归及手机长按改名验证。
- 恢复整行拖动、方向决定前后插入、组头/组尾/空组落点、拖动组临时折叠与取消还原、
  预览动画及 Workbench 分屏交接；分屏接管时不提交分组移动。原虚拟列表和 mask 外吸顶复用。
- 组内草稿展示使用当前 Composer draft 的 placement，不能再建一份任务事实或持久化组织副本。
  空正文不持久化后，当前草稿展示订阅现有 workspace 内存草稿的 `draftTaskGroupId`；查看会话时只展示实际保存的未提交文字草稿，首发后不残留空行。关闭仅清除内存意图及已保存正文中的分组字段，保留正文、项目、模型和预热状态。
- 闲时系统组的新建入口仍打开 Automations；关闭草稿行只撤销分组意图，保留正文和项目选择。
- 旧组件需要的 view 只是当前任务树和 Host 分组结构的展示投影。拖动预览仅在该次手势和提交期间存活，完成或失败即清除；
  松手只提交当前节点及锚点，保留原来源校验，不能恢复旧的全量 applyOrder 写回。
  首发目录与独立分组登记的 CR-01 修复保持不变。

GRP11（accepted）：桌面与手机、深浅主题核对旧组件；实际点击颜色、右键改名/取消、
空组新建、草稿、整行跨组/顶层移动、组排序、取消和吸顶，断言 Host 归属及当前任务不串线。

本轮手机 Web shared-host 1/1 通过（`desktop-e2e-20261014050943064-p51374-dd60ab66d87ef0e2`）：
触摸圆标改色、展开/折叠、长按改名与取消分组，经真实 Host 读回；浅深主题截图与视口边界已核对。
桌面最终结果见[覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)。
GUI 用例保持 manual-review/pending，不据此扩展到实体手机、Windows/Linux 或真实远端重连。

### 恢复验收

| Case  | Setup → Action → Assertion                                                                 | 证据               |
| ----- | ------------------------------------------------------------------------------------------ | ------------------ |
| GRP01 | 旧组/空组/系统组/混合设备 fixture → 升级两次 → 分组保留，无 Group 项目，workspace 项目正常 | SQLite 哈希/ledger |
| GRP02 | 三视图 → 切换/重载 → 偏好与折叠恢复，项目顺序和当前任务不变                                | GUI/localStorage   |
| GRP03 | 创建/改名/改色/取消组 → 重启 → 持久化且不删任务                                            | GUI/SQLite         |
| GRP04 | 顶层/组内/空组和不可见成员 → 菜单/拖拽 → 只变目标节点，执行范围不变                        | GUI/Host           |
| GRP05 | 组内任务 → pin/archive/恢复/delete → 无重复、位置恢复、明确删除清引用                      | GUI/SQLite         |
| GRP06 | 预热草稿 → 首发/切组/切项目/取消组/延迟 ACK → 一个 session，placement 不串组               | GUI/创建调用       |
| GRP07 | 定时/闲时首次标记 → 同步/移出/重启 → 入组一次，尊重整理                                    | Host/GUI           |
| GRP08 | 不同 Host 同路径同 taskId → 混组/离线/重连/identity 迁移 → 不串任务、不丢成员              | identity/GUI       |
| GRP09 | 两窗口/手机并发移动 → 交错提交 → 不覆盖无关节点，失效锚点拒绝                              | 两连接/SQLite      |
| GRP10 | 大列表/持续活动/分屏拖拽 → 滚动和切换 → 无闪空，分屏不改排序                               | GUI/runtime        |

验收覆盖桌面与手机 shared-host、深浅主题和中英文。窄屏截图不替代手机证据。
新增 GUI 用例先进入 manual-review/pending，实际跑通与正式准入分别记录。
模型/provider 全排列、调度器重构和真实开发库修复不在范围内。

### 本轮验证（2026-10-13）

- macOS 桌面 4/4 通过，runId：`desktop-e2e-20261013112431949-p31219-24a66fb6a84a439e`。
  覆盖旧分组偏好迁移、新视图重载优先、组编辑、首发、置顶/归档恢复、跨组手柄移动、
  千行列表虚拟滚动、吸顶和折叠重载；截图覆盖中文浅色和英文深色。
- 数据库、并发组织命令、Host 归属、草稿 placement 与视图投影由受影响单测验证。
  既有 migration SQL/checksum 保持不变；新增 `0006_task_group_admissions` 记录首次登记，
  防止系统任务被用户移出后重复同步拉回。schema baseline 与生成结果一致。
- 手机 shared-host 的结果与证据见[覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)。
  真实 SSH/WSL/Docker 分组整机交互、断网后创建 ACK 恢复、长时持续活动压力未验证。
  不据此声称 GRP01–GRP10 的所有组合已覆盖，不自动转正。
- `pnpm typecheck`（含 E2E 类型）、`pnpm lint`、`pnpm architecture:check --changed`、
  `pnpm db:schema:check` 通过；受影响单测首跑的 8 个文件修正旧断言/服务 mock 后定向复验
  50/50 通过，最终核心回归 26/26、侧栏回归 20/20。未调用全量根单测。
  开源词扫描的 10 处命中均在原有历史文档，本次新增为 0。

## 历史实现说明（不作为当前数据链路）

> 下文记录 2026-09 及更早的分组实现，当前行为以上面的恢复裁决为准。旧的 workspace bootstrap、分组查询自动归档和旧两级切换器不恢复。

`Group` 是侧栏任务区的用户可见视图入口，用于把用户自定义的跨 workspace task group 和未分组 task 放在同一个混排列表里展示。内部状态、接口和持久化仍沿用 `grouped` / `Grouped` 命名，避免破坏已有数据结构。

当前实现支持 `Group` 视图入口、`New Group`、跨 workspace task/group 混排展示、菜单移动到 group / 移出 group、SQLite 持久化、乐观提交、group rename、group color、group header 右键菜单，以及限定的 task over task 拖拽移动排序。

侧栏进入 `Group` 时，仍在 grouped 主体上方复用全局 `Pinned` 区。Grouped 主体只展示非 pinned、非 archived task；置顶 task 只迁移到同页的 `Pinned` 区，不重复出现在 group 内或顶层。pin/unpin 不修改 task 原有的 group membership 和用户排序，取消置顶后必须回到原位置。

## 视图顺序

任务视图菜单顺序固定为：

1. `Group`
2. `Workspace`
3. `Timeline`

`Workspace` 保留当前按 workspace 分组的任务视图；`Timeline` 保留当前按时间线展示的任务视图。

## 列表结构

`Grouped` 视图主体结构如下：

```tsx
<task-group-list>
  <new-group-item />
  <new-task-item />

  <task-item />
  <task-item />
  <group-item>
    <group-title />
    <task-list>
      <task-item />
      <task-item />
    </task-list>
  </group-item>
  <task-item />
  <group-item>
    <group-title />
    <task-list>
      <task-item />
      <task-item />
    </task-list>
  </group-item>
  <task-item />
</task-group-list>
```

- `new-group-item` 和全局 `new-task-item` 固定在混排列表顶部，不参与用户排序持久化。
- 点击 `new-group-item` 新建出的真实 group 需要立即写入顶层用户排序，并放到混排列表最顶部。
- 顶层 `task-item` 表示未加入任何 group 的 task。
- `group-item` 表示用户自定义 group。
- group 内的 `task-item` 不再出现在顶层。
- archived 或 deleted task 在 `Grouped` 视图中完全不可见，包括 group 内部。
- pinned task 不进入 `Grouped` 主体，但在同一个 `Group` 页面顶部的全局 `Pinned` 区可见；这不是删除、归档或解除 group membership。
- 空 group 保留展示，避免用户创建的容器因为成员暂时不可见而消失。
- `Grouped` 的 group 归属和混排顺序独立于全局任务排序方式；切换 `Workspaces`/`Timeline` 的创建时间或更新时间排序，不应该改变 `Grouped` 视图。
- Grouped 视图首次挂载时，在 structure/membership 的第一次请求结束且 sessions-index 首个 snapshot 水合完成前，主体内容区保持为空，不渲染“正在获取任务”、store 中暂存的 grouped draft、group 容器、空状态或空列表；页面顶部已有的 Pinned 区不受影响。两份数据源都 ready 后才一次性展示 draft 和权威列表；后续后台刷新保留已有内容，避免列表闪空或用加载文案打断视线。

## New Task 草稿归属

`Grouped` 模式下，全局 `New task` 入口需要根据当前 active task 推导草稿位置：

- 当前 active task 位于某个 group 内时，点击全局 `New task` 应在同一个 group 内创建 grouped draft，并自动展开该 group，保证草稿可见。
- 当前 active task 是顶层未分组 task 时，点击全局 `New task` 应创建顶层 grouped draft。
- 当前没有 active task、active task 不在当前 grouped view 中，或 grouped view 尚未完成挂载时，沿用顶层 grouped draft 作为兜底。
- 如果当前已经处于 grouped draft 态，再次点击全局 `New task` 复用当前 draft 的 placement，避免把正在编辑的 group draft 意外移动到顶层。
- 单个 group header/menu 内的 `New task` 始终显式创建到对应 group，不受当前 active task 影响。
- grouped draft 的 placement 只能在 draft session 实际创建或预热 session 实际提升成功后，显式绑定到新 task id。创建命令必须在第一次异步等待前捕获稳定的 draft identity 与 placement；ACK 或 pending command 重发完成时只提交该快照，并仅在当前 draft identity 仍匹配时清除草稿。null-session pending create 还必须持久化来源 workspace scope，并按 `workspaceIdentity?.trim() || workspacePath` 过滤恢复入口，禁止在其他 workspace 展示或消费。普通任务选择、fork 跳转和恢复已有 session 只负责导航，不得据此推断为草稿提升，避免误改已有 task 的 group 归属和排序。
- root draft 首发提升时，Host 必须在同一个 SQLite transaction 内提交 task row 与顶层 `sort_order`，事务提交后才允许发布 sessions-index/task list 刷新。Renderer 即使先收到 sessions-index 内容帧、后收到 grouped structure，也必须继续沿用 optimistic root 顶部位置，禁止把尚未取得权威 `sort_order` 的新 task 临时补到列表末尾后再上移。

## 展开与收起

`Grouped` 视图复用侧栏任务区标题旁的 `Expand all` / `Collapse all` 工具按钮。

- 当当前 grouped view 至少存在一个 group 时显示批量按钮。
- 展开/收起是当前用户、当前设备/浏览器的显示偏好，持久化在 UI 侧 `localStorage`，key 为 `zcode-grouped-task-collapsed-groups`。
- 持久化值只保存 `{ [groupId]: true }` 形式的收起 group id；未出现的 group 视为展开。这样新建 group 默认展开，也避免把全量 group 顺序复制进 UI 偏好。
- 若所有 group 都未收起，按钮显示 `Collapse all`，点击后把当前 view 内所有 group id 写入 collapsed set 并同步 localStorage。
- 若任意 group 已收起，按钮显示 `Expand all`，点击后清空 collapsed set 并同步 localStorage。
- group 删除或 view 刷新后，需要按当前 group id 列表清理 stale collapsed id，并把清理后的结果写回 localStorage，避免后续新 group 被旧状态误命中。
- 单个 group 内点击 `New task` 时仍会自动展开该 group，保证新草稿可见。
- draft task item 的项目标签使用 `text-ui-sm`，hover 时保持显示且位置不变；状态点和关闭按钮共享固定宽度 action 槽并在 hover 时原位切换，点击关闭只清除当前 grouped draft，不归档、不删除真实 task。

## Group 语义

Group 是用户自定义的全局任务组织容器：

- 支持命名。
- 支持设置颜色，颜色参考 macOS Finder tag color。
- 可以包含不同 workspace 的 task。
- 一个 task 最多只能属于一个 group。
- 删除 group 只解除成员关系，不删除、不归档其中的 task。

## Group Header 菜单

Group header 用于展开/收起。右键 header 时显示上下文菜单，菜单结构如下：

```txt
New task
---
Rename
Change Color >
  Gray
  Red
  Orange
  Yellow
  Green
  Blue
  Purple
---
Ungroup
```

- `New task` 复用侧栏已有的新建 task 入口，不改变当前 group 的成员关系。
- `Change Color` 使用二级菜单，颜色项只显示文本和小色点。
- `Rename` 进入和 bot channel 相同语义的标题 inline edit。
- `Ungroup` 将该 group 内所有 task 移回 root 顶层，同时删除 group；这里不做二次确认，因为 task 本身不会被删除或归档。
- `Ungroup` 的持久化顺序是先保存新的 root/grouped view 排序，再删除 group。这样删除 group 触发的 membership cascade 不会让原 group 内 task 丢失用户可见顺序。

## Task Item 菜单

`Grouped` 视图里的所有 task item 都显示右键菜单，包括 root task 和 group 内 task。菜单结构如下：

```txt
Move to group >
  Remove from group
  ---
  <dot color> <group title>
  <dot color> <group title>
---
Rename task
Archive task
Mark as unread
---
Open in Finder / File Explorer / File Manager
Copy path
Copy task path
Copy log path
Copy session id
Go to config
---
Feedback
```

- `Move to group` 是二级菜单，列出当前 grouped view 内全部 group，并在名称前显示 group color dot。
- 当前所在 group 在二级菜单内禁用，避免重复移动。
- root task 的 `Remove from group` 禁用；group 内 task 点击后移回 root。
- `Remove from group` 会把 task 放到原 group 后面，保持用户操作后的空间上下文。
- `Rename task`、`Archive task`、`Mark as unread`、路径复制、配置跳转和反馈入口沿用 workspace 视图的 task 级语义。
- Grouped task item 在桌面鼠标下支持双击打开同一个 `TaskRenameDialog`；右键菜单与双击是等价入口。双击的第二次点击不再重复打开任务；行内文件树、关闭、移动到顶部、交互胶囊和工作流运行行不触发重命名。右键菜单已打开、拖拽进行中、只读 workspace 或触摸设备会忽略双击。
- dnd-kit 的 6px 拖拽激活阈值保持不变：无位移的双击不会进入拖拽，也不会提交排序。

## Task 拖拽移动排序

Grouped 视图支持 task item 之间的直接拖拽移动，交互参考 dnd-kit virtualized sortable list：

- 拖拽排序由 dnd-kit `over` 结果驱动：`collisionDetection` 只负责选出当前 over droppable，`onDragOver` 根据 droppable type 更新 preview view，不再通过 `dragMove` 扫描所有 task 或用指针中线决定插入位置；`dragMove` 只记录相邻两帧 delta 变化得到的当前拖拽方向，并在方向反转但 over 目标不变时复用最近一次 over 目标刷新 preview。
- 拖拽自动滚动使用 dnd-kit `autoScroll.threshold = { x: 0.1, y: 0.1 }`，即拖拽矩形进入可滚动祖先容器上下左右边缘 10% 区域才触发滚动，避免默认 20% 触发区在短列表容器里过于敏感。
- 只允许命中 task、group header、group footer、收起 group、empty drop zone 和 group 排序目标；草稿 task、固定的 `New group` / `New task` 行或空白区域不参与排序。
- 拖拽命中 root task 时，目标父级为 root。
- 拖拽命中 group task 时，目标父级为该 group。
- task over task 的插入位置由拖拽过程中持续刷新的当前方向决定：向下移动插到目标 task 后，向上移动插到目标 task 前；同一个 over task 内不再通过 `dragMove` 中线反复切换。
- group 收起时，收起的 group item 作为独立 droppable；task over 收起 group 由 `dragOver` 方向决定 root 层插到 group 前/后。
- group 展开时，结构语义为 `<group><header /><content /><footer /></group>`：header 作为独立 droppable，task over header 由 `dragOver` 方向决定，向上移动表示移出到 root 并插到 group 前，向下移动表示移入 group 并插到第一个 task 前；content 内继续按 task over task 排序；footer 是正常布局流里的独立 droppable，不使用 absolute bottom padding，task over footer 由 `dragOver` 方向决定，向上移动插入到 group list 尾部，向下移动则移出到 root 并插到 group 后。
- group 展开且为空时，empty drop zone 作为独立 droppable，task over empty drop zone 由 `dragOver` 移入该 group 的第一位。
- empty group drop zone 随空 group 状态同步挂载/卸载，不使用 opacity 淡入淡出，避免隐藏过渡期间仍影响拖拽命中判断。
- group header 是 group 拖拽手柄；开始拖拽 group 时会临时收起该 group，拖拽结束或取消后恢复拖拽前的收起状态。
- group 拖拽浮层必须复用正常 header 的展示标题；系统 cron 分组在普通 header、sticky header 和拖拽浮层中都显示本地化名称，不得暴露持久化占位值 `cron`。
- group 拖拽只在 root 层移动整个 group 块：group over root task 和 group over group 都由 `dragOver` 进入目标时的拖拽方向决定前/后；group over group task/content 不产生嵌套。
- 同父级移动表现为 reorder；不同父级移动表现为先移出原父级，再插入目标父级。
- 支持的移动类型限定为：
  - root task over root task
  - root task over group task
  - group A task over group B task
  - group task over root task
  - task over group item 区域
  - task over empty group drop zone
  - group over root task
  - group over group
- 拖拽结束后通过 `applyGroupedTaskViewOrder` 一次性提交最终 root 顺序和 group membership；取消拖拽或保存失败时回滚到拖拽前 view。
- 虚拟列表里的 task 以 workspace identity + task id 的稳定 key 作为 draggable/droppable id，避免滚动窗口重挂载时用 index 导致错位。
- 拖拽 preview 指列表内当前预览落位的 active task row，不是鼠标浮层；root preview 和 group preview 的行样式统一为不可见占位，不显示边框和背景，仅保留所在容器天然的缩进、group 左侧边线等结构差异。
- 拖拽 overlay 指跟随鼠标的纯展示浮层，通过 portal 挂到 `document.body`，不渲染在 grouped task 的滚动容器内，避免受滚动条和裁剪上下文影响；overlay 使用 `bg-background`，宽度跟随列表内当前 preview row 的实际宽度并在宽度变化时短过渡，不带 tooltip、右键菜单或 hover 操作态，松手后使用短 drop animation 收进最终落点。
- Grouped task 拖到会话区 Workbench pane 的四个边缘时，复用 Project task 的分屏落点与 session identity 规则；成功分屏不得提交 grouped 排序预览，task 在 grouped 视图中的原有层级与顺序保持不变。拖动 group header 仍只负责 grouped 内部排序，不允许创建分屏。
- 拖拽移动时对当前已挂载的可见 task row 做 FLIP 让位动画；task 移入/移出 group 时，group 容器高度变化和后续顶层节点位置变化也参与同一节奏的动画；虚拟列表窗口外未挂载的节点不参与动画，并遵守系统 reduced motion 偏好。
- 拖拽只改变 Grouped 视图的用户组织顺序，不改变 ZCode session、task realtime stream、desktop continuous 或 web remote replayable 的消息恢复语义。

## Fork 与新任务置顶

顶层新建 task 和 fork 后出现的新 task 必须写入 `task_group_view_node_orders` 的顶层排序，并使用新的最小 `sort_order` 插到 Grouped 列表顶部。group 内的 New task 从草稿提升后必须写入该 group 的 membership，并使用新的最小成员 `sort_order` 插到组内第一位。UI 的乐观落位只是即时反馈，刷新后的真相源仍然是 SQLite。

- desktop continuous 的 `createSession` 和 `forkSession` 都通过 `ZCodeTaskIndexSyncer.syncSnapshotAndBroadcast(..., { moveGroupedTaskToTop: true })` 写入 task index 和 grouped 顶层顺序。
- web remote replayable/shared-host 创建 task 时通过 task adapter 写入 grouped 顶层顺序。
- 已存在于某个 group 内的 task，以及从 group 草稿提升的新 task，不应因为普通 snapshot 同步被移出 group；顶层置顶只用于 root 新建/fork 这类“新 task 首次进入列表”的入口。
- 新 task 的顶层顺序初始化必须幂等：同一个 session 的可见状态、首标题和完整 snapshot 可能并发回源，只有第一次发现该 task 尚无 group membership 且尚无顶层顺序时才能分配新的最小 `sort_order`。后续重复同步只更新 task meta，不得再次置顶，否则较慢的旧任务回源会越过其后创建的新任务。
- 首次顶层顺序写入成功后必须发出 `task_created` 语义事件，让运行中的 Grouped structure 缓存失效并重拉；sessions-index 的可见帧可能早于 SQLite 顺序写入，不能只依赖会话列表变化刷新，否则当前进程会把缺序 task 补到末尾、重启后才恢复正确顺序。
- group 草稿提升后的 placement 不能依赖 `optimisticTaskListByTaskId` 才生效。V4 首发只保证 active session 与 sessions-index 权威 task 可见；只要 promoted marker 和权威 task 已同时出现，就必须按 marker 写入 group membership 与组内第一位排序。
- grouped draft 在 create/send accepted 边界提升为真实 task id 时，必须在同一次 renderer store 事务中同时写入 promoted placement 和最小可渲染的 `optimisticTaskListByTaskId` 元数据。不得先清除 draft row 再等待 sessions-index，否则 ACK 与权威列表投影之间会出现任务行空档。该元数据只是短期 UI overlay，不伪造 conversation projection；其 `updatedAt` 必须使用低于任何权威 session 时间的哨兵值，不得用 renderer 本地时钟参与排序或字段权威竞争。desktop continuous 和 web remote replayable 都以后续 sessions-index 权威元数据对账收口。对账必须使用 task meta 字段级合并，最小 overlay 的空标题、默认 mode/provider/status 都不得覆盖 sessions-index 后续下发的权威字段。

颜色不直接存储 CSS 值，应存储语义枚举，并由 UI 按主题映射为可读颜色：

```ts
type TaskGroupColor = "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";
```

## 数据模型

建议在 service 层新增 task group repo/service，避免 UI 直接访问 repo。

```ts
interface TaskGroup {
  id: string;
  title: string;
  color: TaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

interface TaskGroupMember {
  groupId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sortOrder?: number;
  addedAt: number;
}
```

未分组 task 也需要顶层用户排序，因此需要单独记录 `Grouped` 视图里的顶层节点顺序：

```ts
interface TaskGroupViewNodeOrder {
  nodeType: "task" | "group";
  nodeKey: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}
```

task 类型的 `nodeKey` 必须包含 workspace 身份信息，不能只使用 `taskId`。凡涉及身份隔离或跨 workspace 匹配，统一使用：

```ts
const workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

路径执行语义仍使用 `workspacePath`。

## SQLite 持久化

Group 相关数据持久化到现有 task 索引库：

```txt
~/.zcode/v2/tasks-index.sqlite
```

不要为 group 另建 JSON 真相源，也不要把 group 状态放进 UI store、relay 或 main process。SQLite 仍由 services 层 repo 统一读写，UI 只通过 service/hook 访问。

建议新增三张表：

```sql
CREATE TABLE IF NOT EXISTS task_groups (
  group_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'gray',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_group_members (
  group_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  workspace_identity TEXT,
  task_id TEXT NOT NULL,
  sort_order INTEGER,
  added_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_key, task_id),
  FOREIGN KEY (group_id) REFERENCES task_groups(group_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_group_view_node_orders (
  node_type TEXT NOT NULL,
  node_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_type, node_key)
);
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_task_group_members_group_order
ON task_group_members (group_id, sort_order, added_at);

CREATE INDEX IF NOT EXISTS idx_task_group_view_node_orders_order
ON task_group_view_node_orders (sort_order, created_at);
```

约束说明：

- `task_group_members` 的主键是 `(workspace_key, task_id)`，机械保证一个 task 最多只能属于一个 group。
- `group_id` 删除后通过 `ON DELETE CASCADE` 自动解除成员关系。
- `task_group_view_node_orders` 保存顶层混排顺序；group 自身不再额外保存 `sortOrder`，避免排序真相源分裂。
- `node_type = 'group'` 时，`node_key = group_id`。
- `node_type = 'task'` 时，`node_key` 必须由 `workspace_key` 和 `task_id` 组成，并使用不会被 SQLite/JS 字符串截断的安全编码，例如 `JSON.stringify([workspaceKey, taskId])`。
- `workspace_key` 必须按 `workspaceIdentity?.trim() || workspacePath` 生成。

服务层实现应复用 `getTasksIndexDatabasePath()` 打开同一个 SQLite 文件，并沿用现有 task index 的初始化习惯：

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `CREATE TABLE IF NOT EXISTS` 做幂等 schema 初始化
- 需要补字段时使用 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`

菜单移动、草稿提升、取消分组产生的排序和 membership 变更必须使用 SQLite transaction 一次性提交。提交成功后再广播 task list/grouped view 失效事件。

## 查询结果

服务层应返回已经规整好的 view model，UI 只负责渲染和交互状态：

```ts
type GroupedTaskViewNode =
  | { type: "task"; task: ZCodeTaskListItem; sortOrder?: number }
  | {
      type: "group";
      group: TaskGroup;
      tasks: ZCodeTaskListItem[];
      sortOrder?: number;
    };

interface GroupedTaskView {
  nodes: GroupedTaskViewNode[];
}
```

服务层查询规则：

- 过滤 archived/deleted task。
- 已分组 task 从顶层剔除。
- group 内只保留可见 task。
- group 可跨 workspace。
- 空 group 保留。
- 查询时如果当前可见顶层 task/group 缺少 `TaskGroupViewNodeOrder.sortOrder`，服务层立即按创建时间倒序补齐用户排序。
- 查询时如果当前可见 group 内 task 缺少 `TaskGroupMember.sortOrder`，服务层立即按加入时间倒序补齐用户排序。
- 查询接口不接收 `sortBy`；`Grouped` 视图只使用 group 自己的用户排序，不跟随全局任务排序方式。

### 可见性真相源与删除收敛

Grouped 客户端投影由三份职责不同的数据合并，`sessions-index` 只提供 task 展示内容，不能单独证明 task 仍然可见：

```txt
sessions-index summary（标题/状态等内容） ───────┐
active task entity keys（可见性 allowlist） ────┼─> Grouped 客户端投影
group structure（归属和用户排序） ──────────────┘
```

- active task entity key 必须来自 task index 的 active `listTasks()` 结果，并统一按
  `workspaceKey = workspaceIdentity?.trim() || workspacePath` 与 `taskId` 组合；只存在于
  `sessions-index`、但已被 task index 标记为 deleted 的历史摘要不得进入 Grouped 投影。
- 新 task 在 task index 权威行出现前，继续通过现有 promoted/optimistic overlay 临时展示；active
  allowlist 不得吞掉已 accepted 的新建 task，也不得把 optimistic 元数据提升为持久化真相源。
- task 从 active 转为 deleted 时，必须在同一个 SQLite transaction 中写入 `tasks.deleted = 1`，
  并删除对应 `task_group_members` 与 task 类型顶层 `task_group_view_node_orders`。事务提交后才允许广播列表变更。
- task index 初始化时必须幂等清理历史 deleted task 遗留的 membership 和顶层顺序引用，修复旧版本已经产生的脏数据。
- archived/pinned task 的 group membership 和用户排序仍然保留，以支持恢复后回到原位置；上述物理清理只针对 deleted task。
- service 端 `applyGroupedTaskViewOrder` 继续拒绝不存在、archived、deleted 或 pinned task，作为最终一致性保护，不能用静默忽略替代校验。
- 禁止把 sessions-index / Controller 的 `kind: "active"` 列表当作「该行仍应留在 grouped 里」的证据。
  该口径是 `!archived`，**包含 pinned task**，而 grouped 的口径是「非 pinned 非 archived」；用它去抵消
  「行消失」会让置顶任务被复活并赖在分组里。要区分「归属真的变了」与「左表短暂落后」，只能依赖
  membership 版本与结构版本，不能依赖活跃度。

排序规则：

- 顶层 group：按 `TaskGroupViewNodeOrder.sortOrder`。
- 顶层未分组 task：按 `TaskGroupViewNodeOrder.sortOrder`。
- group 内 task：按 `TaskGroupMember.sortOrder`。
- `createdAt` 只用于首次补齐缺失的顶层用户排序，不参与后续顶层排序比较。
- `addedAt` 只用于首次补齐缺失的 group 内用户排序，不参与后续 group 内排序比较。
- 新建内容必须先分配置顶 `sortOrder`，不能依赖创建时间兜底。

## 交互

Group item 展示：

- Finder tag 风格颜色点。
- group title。
- 可见 task count。
- 展开/收起入口。
- 更多菜单。

Group 菜单：

- Rename
- Set Color
- Delete Group

Task 菜单：

- 未分组 task 支持 `Add to Group`。
- group 内 task 支持 `Remove from Group`。
- 所有 task 支持 `Move to top`，入口包括 hover action 与右键菜单；root task 执行后成为 grouped 视图顶层第一项，group 内 task 执行后移动到当前 group 第一项。
- 原有 pin、rename、archive、mark unread 等 task 操作继续复用。

## 移动与排序

Grouped task 支持拖拽移动，也支持通过 task item 右键菜单把 task 移入 group、移出 group 或移动到顶部。`Move to top` 是当前层级内的显式置顶动作；它只修改 grouped 视图排序，不改变 task 所属 workspace/session。

## 渲染稳定性（禁止整块闪）

Grouped 主体只在**首屏权威数据未就绪**时允许隐藏；一旦画出过非空列表，之后任何刷新、
重挂载或瞬时空态都必须继续渲染上一份列表——旧数据优于空白。这条约束是 grouped 专属的，
因为它是唯一把权威列表放在组件实例状态里、并且带首屏门禁的任务视图（timeline/pinned/archived
从模块级 query cache 渲染，天然不会出现空白帧）。

- 首屏门禁是一次性闩锁，禁止跟随 Controller 列表的瞬时 `loading`。运行中任务的每个流式节点
  （发出 prompt、首个 tool 展示、输出完成）都会触发一轮重查，跟随它就会整棵子树卸载重挂载。
- `loading` 只表达「首屏还没有任何权威节点」。已有列表时的后台刷新不得置位，否则空态文案
  与门禁都会闪。
- 最后一份权威视图按 workspace scope 签名缓存在模块级，祖先重挂载 / HMR 后立即接着画。
  该缓存没有主动失效：卸载期间发生的删除 / 归档 / 分组变更不会淘汰它，重挂载后旧行会短暂
  可见且可点击，脏读窗口上界是一次 refresh 往返。这是「旧数据优于空白」的显式折衷，不是缺陷；
  要缩窄只能加 TTL 或降级为占位，不得靠扩大窗口换取更少的 RPC。
- 视图与 scope 相关的 memo 一律按值签名，不按数组身份——否则父级重建同值数组会形成
  「refresh 换身份 → effect 再刷新 → 再渲染」的自激环。scope 签名的排序比较器必须逐级
  tie-break 到全部参与字段；只比较首元素时，同 workspaceKey 不同 purpose 的两个 tab
  在 tabs 数组里互换位置就会换出新签名并触发多余 refresh。
- 首屏门禁的两个闩锁（`initialized`、`hasPaintedOnce`）在渲染期直接写 ref。这只因为它们
  单调（`false→true`，永不回落）且新值完全由本次渲染的输入推导：concurrent 下被丢弃的渲染
  也会执行赋值，对单调闩锁最坏只是提前开门一帧。任何可回落或依赖提交顺序的状态禁止照搬该
  写法，必须走 effect。
- 列表与节点的引用稳定化靠内容等价判断短路，其失效是静默的（只表现为整块闪回归，无日志、
  无指标）。因此嵌套对象等价一律用忽略 key 顺序的结构比较，不用 `JSON.stringify`——上游用
  条件展开构造对象，key 插入顺序不保证跨帧一致。该口径由 `taskListItemStabilization.test.ts`
  的 key 顺序回归用例锁定。

判定口径与验证要求见 `docs/task-list-refresh-semantics.md` §4.2 / §5.1。复测必须完整重启应用：
vite HMR 会保留已挂载组件的旧状态，热替换下的观察结果不作为结论。

## 分组吸顶

Grouped 视图滚动时参考文件树吸顶目录的做法，在 masked 滚动容器外层额外渲染当前 group header 的吸顶副本，而不是只依赖原 group header 的 CSS sticky。

- 吸顶副本只在 group header 已经滚出滚动容器顶部、且该 group 内容区域仍覆盖顶部时显示。
- 折叠 group 不显示吸顶副本；折叠态没有可滚动的组内上下文，继续吸顶会误导用户以为当前仍在该 group 内。
- 吸顶副本必须作为 masked 滚动列表的 sibling/外部 slot 渲染，避免被 sidebar 顶部渐隐 mask 裁切。
- 拖拽 task/group 时隐藏吸顶副本，避免吸顶 header 与原列表 header 同时注册 dnd hit target。
- 吸顶 header 复用 group 的颜色、折叠、新建 task、改色、取消分组等入口；排序和 membership 仍由原 grouped view mutation 统一落库。

状态分层：

1. Server snapshot：service 返回的真实 `GroupedTaskView`。
2. Optimistic view：菜单移动、取消分组、草稿提升后先应用乐观 UI，再调用 service 落库。

流程：

```ts
async function applyGroupedViewChange(nextView) {
  applyOptimisticView(nextView);

  try {
    await taskGroupService.applyGroupedTaskViewOrder(viewToOrderInput(nextView));
    await refreshGroupedView();
  } catch (error) {
    rollbackOptimisticView();
    toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
  }
}
```

视图变更过程禁止 bump 无关 workspace 的 task list version，禁止把未展开 workspace 的排序误删。

## 服务层校验

落库 mutation 必须在 service 层统一校验：

- task 是否存在。
- task 是否 archived/deleted。
- group 是否存在。
- task 是否已经属于另一个 group。
- 跨 workspace task ref 是否携带 `workspaceIdentity?`。
- 排序位置是否合法。
- 最终仍满足一个 task 最多属于一个 group。

## 多端边界

`Grouped` 是跨 workspace 的 UI 组织视图，但 task 执行、归档、删除仍属于原 workspace/task 流程。

- 不把 group 状态下沉到 relay 或 main process。
- 不改变桌面端 `continuous` 与手机端 `replayable` 的 conversation/task 消息流语义。
- 远程 workspace 成员引用必须贯穿传递 `workspaceIdentity` 和 `remoteSessionId` 可用上下文，禁止只按 `workspacePath` 匹配。
- 手机 `/remote` 仍通过 shared-host attachment 复用已有 host，不为 group 视图另起独立 ZCode Agent runtime。
