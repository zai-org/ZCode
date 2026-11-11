# Sidebar Task View Switcher

## 当前行为（2026-10-20）

侧栏筛选为“按项目 / 按分组 / 最近更新 / 按未读”，各项保留图标，不恢复旧两级切换。
“按未读”使用 Bell，集合与系统角标同源；排序、分页与已读行为见[任务未读状态](task-unread-state.md)。
分组与项目互相独立，具体契约见[分组视图](task-grouped-view.md)。
客户端有有效新 `view` 时沿用；否则迁移旧 `organizeBy`：`grouped` → `grouped`、
`chronological` → `timeline`、`project` → `projects`。无有效历史偏好默认按项目。
后续显式切换以新偏好为准；切换不改任务、项目顺序或执行目录。
桌面鼠标下，任务行单击立即打开会话，双击打开重命名弹窗；两种行为都不改变任务身份、排序或持久化偏好。「按未读」视图第一击会清未读并移除行，因此不启用双击重命名，保留右键菜单。

## 历史两级切换（不再使用）

侧栏任务区的视图入口分为两级：

1. 一级滑块：`Group` / `Project`
2. `Project` 模式下的筛选菜单：`By project` / `Timeline`，以及 `Created` / `Updated`

目标是把用户最常用的“按项目看任务”和“自定义分组”做成显式切换，避免把 `Project`、`Group`、`Timeline`、排序全部压在同一个下拉菜单里。非项目对话不增加一级 tab，而是在 `Project + By project` 中成为独立二级 section。

## 状态映射

现有任务视图数据状态继续复用，不新增服务端或协议字段：

- `Group` -> `taskOrganizeBy = "grouped"`
- `Project` + `By project` -> `taskOrganizeBy = "project"`
- `Project` + `Timeline` -> `taskOrganizeBy = "chronological"`
- `Created` -> `taskSortBy = "created"`
- `Updated` -> `taskSortBy = "updated"`

`Group` 视图不响应 `Created` / `Updated` 排序。切回 `Project` 后，继续沿用上次项目子视图和排序偏好。

`Project + By project` 与 `Project + Timeline` 的排序是两层语义，不是直接对全表应用
`taskSortBy`：

1. `prewarming/running` task，以及 `hasBackgroundWork` 为真（挂着动态工作流 run / 后台 bash /
   分离子代理）的 task，永远排在当前普通任务列表最上方（2026-09-09 追记：后台工作并入运行层）；
2. running 层内部按 `createdAt` 倒序，并只用稳定 `taskId` 处理同创建时间；
3. 非 running 层才应用 `Created` / `Updated` 偏好。

因此并发运行的原 task 与 fork child 不会因 `lastActivityAt` 随流式事件交替更新而换位；fork
child 创建更晚，运行期间稳定排在原 task 上方。两个各跑一个后台 workflow run 的会话同理：
run 进度事件持续推进 `lastActivityAt`，但两行都在运行层内按 `createdAt` 固定，不再互换。

挂着 workflow run 的会话在三种视图（Project / Group / Timeline）里都在标题下多出一行「Workflow 图标 +
迷你轨道灯 + 当前 phase 名」（2026-09-14 追记：工作流运行行），数据来自 sidecar `workflowActivity`；该行只绘制，
不参与排序、不改前置 16px 槽的优先级。行高随之 32 → 52（最多两行）。
转圈图标仍只认 `prewarming/running`，后台工作不点亮转圈。Pinned 仍是独立结构区，Grouped 仍服从用户
持久化的显式 `sort_order`，两者不被 running 层跨区打散。

`Projects` / `Tasks` 二级 section 使用独立 renderer-local 偏好 `zcode-sidebar-purpose-section-preferences`，分别持久化 `projectsExpanded`、`conversationsExpanded` 与 `sectionOrder`；首次、旧版偏好、坏数据或 storage 不可用时默认全部展开并按 `Projects -> Tasks` 排列。

## 交互布局

任务工具栏直接显示紧凑的两段式滑块，不额外显示 `Tasks` 标题：

```text
[ Group | Project ] [expand]   [new group] [archive] [filter]
Pinned
  • task
```

- 任务工具栏外层使用 `pl-2.5 pr-3`，滑块使用轻量 pill 样式：tabs shell 实际高度固定为 `h-7`，tab 本体高度为 `h-6`，水平 padding 使用 `pl-1.5 pr-2`，图标和文案使用 `gap-1`，宽度跟随 `Group` / `Project` 图标和文案内容，不横向撑满工具栏；tabs shell 使用 `bg-surface`，active 背景使用无边框的 `bg-background` 独立 pill indicator 跟随当前项的位置和宽度滑动，不使用大面积品牌色。
- `Group` tab 排在左侧，`Project` tab 排在右侧；初始化仍保留 `Project` 视图，避免已有默认任务入口变化。
- `Group` / `Project` / `Timeline` / `Archived` 模式下的 pinned 区固定渲染在滑块和动作按钮下面，普通任务列表上面；列表容器不额外添加上下外边距，避免和滑块之间形成过大的空白。
- `Group` 主体继续只接收非 pinned、非 archived task；置顶 task 迁移到同页的全局 pinned 区，只出现一次。右上角共享任务菜单执行置顶后，当前 task 必须仍能在 `Group` 页面找到，不能因为 grouped 主体过滤 pinned membership 而整页消失。
- pinned task 原有的 group membership 和用户排序保持不变；取消置顶后回到原 group 或顶层位置。置顶区无数据且不在加载时继续隐藏，不额外渲染空标题。
- `Expand all` / `Collapse all` 按钮固定贴在滑块右侧，属于当前视图切换的近邻动作；`New group`、归档、筛选等次级动作留在工具栏右侧。
- 切换视图时，`Expand all` / `Collapse all` 先按上一帧展示模型乐观保留位置、图标和 disabled 状态；等新视图回传确认为空后再移除，避免动作区先少一个按钮或短暂变灰再补回来造成整行闪动。
- `New group` 在 `Group` 视图下保留原来的纯图标按钮；通过 tooltip 和 `aria-label` 暴露文案，避免右侧动作区过宽。
- `Group` 被选中时，右侧保留 `Expand/Collapse all`、`New group`、归档等通用动作；隐藏项目子视图和排序筛选菜单，任务工具栏不再展示搜索按钮。
- `Project` 被选中时，筛选菜单展示：

```text
View
✓ By project
  Timeline
---
Sort by
✓ Updated
  Created
```

`Project + By project` 的任务区固定为：

```text
Pinned
Projects          [drag]     [chevron] [+]
  workspace rows
Tasks             [drag]     [chevron] [new task]
  conversation rows
```

- `Pinned` 仅在有数据或加载中时显示；conversation/project pinned task 均只出现一次。
- `Projects` 和 `Tasks` 标题始终显示，并各自独立展开/收起；点击标题及右侧 action、拖拽手柄之外的剩余标题行切换 section，展开显示向下箭头，收起显示向右箭头。
- 专用拖拽手柄支持鼠标、触摸和键盘。用户可以交换两个 section 的位置；空或收起 section 仍可移动，展开态和内容跟随 section，换位后立即持久化 `sectionOrder`。
- 箭头和右侧 action 在 pointer 默认态隐藏，section hover、键盘 `focus-within`、菜单打开或设备不支持 hover 时显示；action 是 trigger 的 sibling，点击只执行动作，不改变 section 展开态。
- `Projects` 右侧 `+` 菜单复用 `Open folder` 和 `Remote connection`；`Tasks` 右侧 `MessageCirclePlus` 固定在 conversation backing workspace 新建草稿。
- `Tasks` 中的任务使用和普通 workspace 任务一致的单行 row：不展示内部 backing workspace 的目录名（例如 `default`），也不为普通 idle 状态显示灰点；未读、错误、运行中等真实状态指示继续保留。
- section 收起只隐藏内容，不清除 workspace 行展开状态、任务缓存或 DnD 顺序。没有真实项目、没有 conversation backing tab 或恢复期间 workspace tabs 暂时为空时，仍渲染两个标题及各自空状态。
- 任务查询使用全部 workspace target；只有 workspace rows、DnD、展开收起和项目空状态过滤为 `workspacePurpose=project`。
- `Group` 继续显示非项目任务：默认顶层未分组，可进入普通分组；不得为 backing path 自动生成 `default` workspace group。
- `Group` 顶部 pinned 区和 grouped 主体使用同一组 workspace scope，但各自保持独立 membership：前者只显示 pinned，后者排除 pinned，禁止重复行。

- `Expand all` / `Collapse all` 继续按当前视图语义工作：Group 模式控制 group；Project 模式同时控制 `Projects` section 和全部项目任务组，不影响 `Tasks`；Timeline 没有可批量展开对象时不展示。
- 窄宽度下允许工具栏换行：滑块优先占据可用宽度，动作按钮换到下一行也必须保持可见，避免长翻译文本挤压图标按钮。

## Web 远控约束

Web 远控侧栏仍只使用 `Project` 一级模式，不展示 `Group` 滑块项。原因是远控任务列表来自 `listWorkspaces()` / replayable 任务索引，当前没有用户自定义 group 的远控恢复语义。

移动端远控仍保持顶部导航区域的纵向滚动和高度拖拽逻辑；本变更不修改 `clientMode`、`deliveryKind`、task stream、snapshot 或 replayable 恢复边界。

section 顺序是 renderer-local 偏好：当前窗口立即更新，其他已打开窗口不要求实时同步；重新挂载后读取同一持久化值。完整边界与用例见 `docs/ui/sidebar-purpose-section-order.md`。

## 兼容性

- 继续复用 `readSidebarTaskPreferences()` / `persistSidebarTaskPreferences()`。
- 继续兼容桌面端、Web 端、macOS、Windows、Linux，以及 Zai Light / Zai Dark。
- 文案走现有 i18n key；新增文案必须同时补 `en-US` 和 `zh-CN`。

## 手机远控任务列表手势（2026-10-14）

手机 `/remote` 复用项目侧栏组件，由入口的 `isWebRemoteControl` 决定交互能力，不按窗口宽度推断桌面能力。

- 项目标题不注册排序拖动（包括键盘排序），允许纵向触摸滚动；点击仍展开或收起。置顶区项目同样适用。
- 所有会话视图（项目、置顶、分组、时间线）不响应 hover，也不因触摸产生的 focus 切换操作区或隐藏元信息。一次点击打开会话。触摸端不启用双击重命名；长按打开任务菜单。
- 手机保留已有常驻操作和键盘打开能力；桌面继续支持项目排序、会话 hover 与 focus 操作。
- 不改变任务身份、排序持久化、共享 Host 或 replayable 链路。

```text
手机入口 → 共享侧栏展示配置 → 项目禁用排序 / 会话固定展示 → 点击 → 既有打开链路
桌面入口 → 默认交互配置 → 项目排序 / 会话 hover + focus → 点击 → 既有打开链路
```
