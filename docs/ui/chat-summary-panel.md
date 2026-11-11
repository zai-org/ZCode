# Chat Status Panel

> **当前状态**：本文描述 V4 `ConversationStatusPanel` 的当前产品语义与投影边界。

Chat status panel 是 V4 conversation pane 右上角的常驻状态面板，用来集中展示 Git 工具、goal 进度、终态计划目录、todo 和后台运行资源。`packages/ui/src/v4/ConversationStatusPanel.tsx` 用同一 shell 承载收起 / 展开两种内容。

## 对话主列的布局稳定性

- 打开或切换对话、草稿进入会话、容器跨过响应式断点、状态面板收展时，消息历史、活动轮和 composer dock 直接使用当前 CSS 布局，不对 `width`、`max-width` 或横向位移做过渡。避免每次进入对话都出现输入框伸缩，并减少动画期间的反复排版和虚拟列表测高。
- 保留 `conversationLayout` 的草稿宽度、864px / 1280px 容器断点和宽屏状态面板让位；不增加 JS 宽度状态、延时或尺寸缓存。桌面与手机 Web 共用该规则，深浅主题一致。状态面板自身的收展反馈不受影响。

```text
打开 / 切换对话或容器变化 → conversation CSS container query
                                  ├─ 消息历史 / 活动轮：最终宽度和偏移
                                  └─ composer dock：同一帧应用布局，无插值动画
```

## 显示规则

- 当前 V4 pane 已绑定 session 且有可展示内容时展示 status panel；无用户 override 时由具名 `conversation` container query 裁决形态：容器不足 `1280px` 时显示 mini 且会话不偏移，达到 `1280px` 时展开完整面板，并让消息列和 Composer 左移 `168px`。始终展开模式复用同一 `@min-[1280px]` 偏移规则，窄容器不偏移；始终收起模式永不偏移。Conversation 的 `max-w-6xl` 宽布局也统一在 `1280px` 后启用。该裁决不得读取 `window.innerWidth`、不得注册 `ResizeObserver`，分屏和右侧 pane 变化统一由 CSS 容器尺寸驱动。
- 新建任务 / 草稿态不展示 status panel，避免 Git tools 区块挤占空态和输入入口。
- 已有 task 只有在当前 worktree `added + removed > 0` 时才展示 Git tools 区块；clean repo 不因为“是 Git repository”而单独挂载 status panel。
- 已有 task 但 Git、goal、todo、running 都没有可展示内容时，不挂载 status panel，不预留完整面板的 inline offset。只有已结束 subagent 不单独挂载 mini/status panel；用户已打开的目录 tab 不受影响。
- `ChatViewEmptyState` 组件根节点在完整 status panel 使用 inline 布局时复用 `CHAT_VIEW_SUMMARY_PANEL_INLINE_OFFSET_CLASS_NAME`，和消息列、输入区保持横向对齐；外层 empty region 与 task restore loading placeholder 共用居中布局，不应用该偏移。
- Workspace header 不展示 status panel 开关；展开态通过面板右上角按钮收起，收起态通过摘要行点击展开。
- 收起态摘要行只展示一项摘要，不把主状态与实时活动拼在同一胶囊。**在跑的工作流排在最前**：只要有 pending / running 的 workflow run，胶囊就显示第一条（启动序）的名称、状态灯、phase 词与 `+n`（规则见 `docs/dynamic-workflow/presentation.md`「Other places a run appears」）。它说的是名字和位置而不是一个计数，所以不与输入框的后台计数重复。点击显示工作流的胶囊时，展开面板并同时打开「工作流」分区——展开后看到的不能比胶囊还少。没有在跑的工作流时，主状态优先级沿用 Progress current、Goal active、Git、Goal done、Progress finish、Progress fallback：只要其中任一项可见，胶囊就只显示该主状态；只有没有任何主状态时，才用正在运行的资源作为兜底摘要。Progress current 使用 arrow-right 图标和当前 todo 标题；Goal active 使用 target 图标和 goal 标题；Git 只在 `added + removed > 0` 时使用 Git 变更图标以及 `Changes +added -removed / 更改 +added -removed`，其中 added / removed 使用 diff 语义色；Goal done 使用 target/goal 图标和 goal 标题；Progress finish 使用 circle-check-big 图标和最后一个已完成 todo 标题；Progress fallback 使用列表图标和 `Progress completed/total` / `进程 completed/total`。实时兜底中 Bash 从 `backgroundWorks` 统计，Subagent 从统一 `session/subagents.running` 统计；只有 Bash 时显示 terminal 图标，只有 Subagent 时显示 Bot 图标，两类并存时显示 Activity 图标，文字只显示 running 总数且不显示持续计时。已结束 subagent 不进入 mini。收起态摘要行内所有文字都使用普通 UI 字体，不使用 `font-mono`。
- Status panel shell 始终是同一个 `aside`。收起态视觉尺寸、高度和 padding 参考原摘要胶囊，但 shell 圆角和展开态统一使用 `rounded-2xl`。收起态胶囊常驻 DOM；展开态只通过 `opacity` / `visibility` / `pointer-events` 把它藏起来。收起态的 shell 宽度由 CSS 决定：`w-max`，上限 `max-w-[min(20rem,calc(100cqw-2rem))]`，即量的是 conversation 容器（`@container/conversation`）而不是窗口。不再用 JS 测量摘要宽度写进 CSS 变量：那套测量是为了给宽度做插值动画，shell 早已不过渡宽度，而测量值会比内容晚一次渲染、上限又按 `100vw` 算，两者都能让文字落到胶囊外面。展开态沿用原完整面板宽度 `w-80`（上限同一个容器表达式），高度上限统一取 `min(64dvh, 32rem)`，避免桌面断点用固定 `36rem` 覆盖相对视口约束。`p-2` 放在展开内容容器上，避免影响收起态胶囊尺寸。收展动画挂在 shell 上，过渡最大高度、圆角、padding、背景和阴影；内容只做轻量透明度切换，避免独立胶囊和面板卸载导致动画断裂。
- Status panel 外层相对 conversation pane 固定使用 `pt-4 right-4`（顶部和右侧均为 16px）；自动、始终展开和 mini 共用该外边距，不在窄屏降为 12px。
- 收起态胶囊跟随摘要内容宽度，单条摘要内容高度为 `h-8`，宽度上限即 shell 的容器上限；内部摘要内容使用 `truncate`，避免长 goal / todo / 工作流标题撑开布局。
- 收起态摘要行 hover / focus 时左侧状态图标切换为 `maximize-2`，提示点击可展开完整 status panel。
- 用户点击面板右上角收起按钮或收起态摘要行写入当前 workspace shell 的手动偏好：`panel` 表示始终展开，`mini` 表示始终收起，`null` 表示 CSS 自动响应。自动模式下展开内容和 mini 摘要同时保持在同一个 shell 内，由 `@container/conversation` 互斥显示；React 不根据宽度切换 variant。展开态右上角的更多菜单只显示“自动”选项，选择后把偏好恢复为 `null`；“始终展开 / 始终收起”不再作为菜单选项，但既有收起/展开按钮及内部 `panel` / `mini` 逻辑继续保留。偏好只保存在当前 renderer 的 workspace shell 内，不写入 task、session、relay 或 main process，因此不会影响 desktop continuous 和 web remote replayable 的实时链路语义。

## 区块

所有区块标题使用普通字重且不做全大写转换，避免状态面板标题在紧凑布局里过度抢占注意力。Git Tools、Goal、计划、进程、终端和智能体按实际渲染顺序堆叠，第二个及后续区块顶部使用 `border-border` 分割线，缺失的区块不占位也不显示多余分割线。除固定内容的 Git Tools 外，Goal、计划、进程、终端和智能体都由 `StatusSection` 的区块类型统一获得滚动视口，调用方不得自行决定是否限高；标题固定在各自滚动视口之外。Goal、计划、终端和智能体展开内容最多占 `12rem`；进程区块最多占 `20rem`，用于容纳 6 个双行 Todo。超出各自上限后只滚动本区块内容。此约束与区块组合无关：即使只有一个区块内容超限、同时还存在其它短区块，长区块也必须保持自己的上限和滚动位置。多个展开区块的标题和受限内容合计仍超过 shell 上限时，展开内容容器提供整张面板的兜底纵向滚动，禁止再次直接裁掉后续区块。智能体区块展示统一投影中的正在运行项；其后用单行 `已结束 · N / Ended · N` 打开或复用 Subagent 目录，不在摘要内预览 terminal item。

Status Panel 字号统一使用 UI Token：Goal 序号圆点使用 `text-ui-xs`；分区标题、Git 行、Goal 正文、计划、进程、停止按钮、终端与智能体正文及元信息、已结束行和收起摘要使用 `text-ui-base`；只有分区标题右侧摘要、Git 变更数量和 Goal 进度使用 `text-ui-sm`。

### Git Tools

Git Tools 展示 workspace 级 Git 状态，不依赖当前 task 是否运行：

- 当当前 workspace 不是 Git repository，或 worktree `added`、`removed` 都为 0 时，不展示 Git Tools 区块，收起态摘要行也不展示 Git 变更指标。
- Git Tools 标题支持折叠 / 展开，默认展开；左侧标题和箭头可点击，收起后标题行最右侧展示 `+added -removed` 变更摘要。
- Changes：展示当前 worktree 的 added / removed 行数。点击后打开已有 Git review pane，并优先选择有内容的 worktree source。
- Branch：复用 `GitBranchSwitcher`，以和 Changes 一致的整行按钮样式展示；status panel 内分支菜单从左侧弹出，触发器箭头紧跟分支文字之后，继续走现有 Git service 和分支切换阻塞处理。
- Commit / Push / Create branch：复用 `GitActionMenu`，由菜单自身根据当前仓库状态展示主动作名称；status panel 内触发器保留主动作和更多菜单的两段式交互，点击父级整行区域触发主动作；更多入口使用普通 icon button 样式的 `...` 图标并紧跟动作文字之后，默认文字色使用 secondary 层级，点击时只打开菜单；父级行 hover 时，`...` 按钮显示 `surface` 背景。没有 commit / push 可执行时，整行按钮展示 `Create branch`。

Git Tools 不直接发起 Git RPC。Git 数据来自 `useGitRepository` 已维护的 `gitSummary` 与 worktree dataset 汇总。

### Goal

Goal 展示目标/prompt 进度，不再承载 todo 明细：

- V4 的目标摘要只读取 CLI `ProductProjection` 中的 `goal` 权威状态。投影必须保留当前 target 的 `targetId`、`summaryTitle`、`timeUsedSeconds`、`activeRunStartedAtMs`、逐轮 todo 和 verifier 的 `reason/nextAction`；live delta 与 cold snapshot 使用同一份投影结构，renderer 不自行持久化目标状态。
- Goal 处于 active 时，标题右侧显示累计耗时并提供独立 `pauseGoal`；paused 时显示冻结耗时和三角形 `resumeGoal`；verified 时显示冻结耗时和绿色圆圈对勾。pause/resume 是 target 控制命令，不复用通用 stop，也不改变 queue 的 stop/hold 语义。
- Goal 标题支持折叠 / 展开，默认展开；左侧标题和箭头可点击，右侧只展示 goal 级 `elapsed`，不展示 goal/token 用量；收起时追加 `· 状态图标`，例如 `1m 42s · <icon>`。active / paused 的收起态状态图标仍是可点击的暂停 / 继续 icon button，tooltip 和 aria-label 继续走本地化文案；complete 使用完成图标。状态摘要和 goal 级指标使用普通辅助文本样式，不使用胶囊背景。折叠后隐藏 prompt 列表。
- Goal 摘要只消费当前 `target.targetID` 对应的 verifier timeline、goal iteration todo 和 goal stats。切换到新 goal 后，旧 target 的 verifier 仍保留在聊天 timeline 中，但不能继续驱动右上角摘要的标题、迭代编号或耗时。
- 行标题来自 goal iteration 标题：第 1 轮默认优先使用 `target.summaryTitle`；replace 到新 goal 后，第 1 轮优先展示当前 `target.objective`，旧 target 的 `summaryTitle` 或 session title fallback 不能继续作为新目标标题；后续轮次标题仍优先来自当前 target 上一轮 verifier 的 `nextAction`。
- 每个 prompt item 使用紧凑横向布局：左侧状态图标，右侧 prompt 标题最多三行，`completed/total` 进度固定在标题区域右上角，例如 `0/5`；prompt item 不重复展示 goal 级 elapsed，也不承载暂停 / 继续按钮，避免把 goal 级信息误表达成 iteration 级信息。
- Prompt item 排序以完成态优先，已完成的 iteration 展示在未完成 / 运行中的 iteration 上方；同一完成态内保持原有 iteration 顺序。
- 未完成 / 进行中的 prompt item 左侧统一使用 goal 图标，例如 `prompt... 3/5` 仍表达为当前目标推进中；已完成的 prompt item 左侧显示对应 iteration 序号，并用 10px 绿色文字 + 绿色描边圆形包裹，避免完成历史继续被误读为当前进行状态。pause / resume 只作为标题行控制按钮出现。
- 每一轮都必须保留可见 action 与状态。第 1 轮 action 优先取 `summaryTitle`，否则取 objective；后续轮次优先取上一轮 verifier 的非内部 fallback `nextAction`，缺失时显示本地化轮次标题。只要某轮存在 todo，就展示 `completed/total`；仅当 todo 非空且全部完成时，左侧才改为绿色编号圆圈。没有 todo 的轮次仍保留 goal 图标和轮次 action，不因投影数据稀疏而整轮消失。
- Goal prompt 列表完整渲染并限制在区块内部的 `12rem` 滚动视口中；标题、累计耗时和 pause / resume 控件不随列表滚动。不得因为 iteration 数量增长而把 Goal 后面的进程、终端或智能体区块直接裁掉。
- 非 latest running 的 prompt item 如果带有 iteration todo，hover 时在左侧展示轻量预览面板：上方显示进程标题，标题样式参考 Progress 标题的普通辅助文本样式但不提供折叠控制，下方展示该 iteration 的 todo 列表，不重复展示 prompt；预览面板使用 `rounded-xl`，边框和阴影对齐 Branch 菜单，出现位置和距离参考 Branch 菜单的左侧顶部对齐与 4px 间距；todo 内容可能很长，预览面板限制最大高度，标题固定，todo 列表区域滚动；latest running prompt item 不展示 hover 预览，避免遮挡当前控制。

verifier 的 `reason` 继续由对话时间线承载；右上角 Goal 区块不在 iteration action 之后额外追加灰色验证摘要卡。todo 明细统一进入进程区块。

目标计时与命令链路：

```text
TargetChanged / TodoWrite / verifier
                 |
                 v
CLI ProductProjection (持久事实 + 每轮状态)
                 |
       snapshot / ordered delta
                 |
                 v
SessionDataLayer -> UI goal summary
                         |
                         +-- active: base + (now - startedAt) 仅显示刷新
                         +-- paused/verified: base 冻结

UI pauseGoal/resumeGoal -> Host -> CLI command handler -> target state event
```

### 计划

计划区块是当前 conversation 有效分支的终态 `ExitPlanMode` 目录，不等同于进程区块里的 todo：

- 列表完整保留当前有效分支中的终态计划并按 `rowId` 降序；点击条目按稳定的 parent session + tool call 身份打开对应 Side Pane。
- 计划标题固定在滚动视口之外；计划条目超过 `12rem` 时只滚动计划列表，不得撑高整个 status panel，也不得因为前后同时出现进程、终端或智能体而失去限高。
- 计划、进程、终端和智能体可以同时存在；各区块保留独立 `scrollTop`，外层兜底滚动只负责让区块标题可达，不替代任何一个长区块的内部滚动。

### 进程

进程区块统一展示待办：

- 有 goal iteration todo 时，只展示当前 goal 的最新 todo 列表，不再按 goal iteration 分组；列表样式复用普通 todo。当前 goal iteration 还没有 todo 时，不回退展示上一轮旧 todo。
- 没有当前 goal todo 时，展示 live `plan`；再缺失时展示 `todoGroups` 中 `source === "session"` 的 todo。
- completed 项保留显示，通过样式弱化；pending / in_progress / completed 继续使用现有状态图标。
- 进程列表严格保持当前 todo snapshot（`plan.items`）的权威原始顺序；状态变化只更新对应项的图标和弱化样式，不得把 completed 项移动到列表末尾。
- Todo 不超过 6 条时按 snapshot 原序完整展示。超过 6 条时进入精简窗口：优先定位 `in_progress`，没有运行项时定位第一个未完成项，全部完成时定位末尾；默认展示连续 3 条，靠近末尾时从前面回补。窗口之前和之后的项目分别收敛为位置桶：前桶全部完成时显示“已完成 n 项”，否则显示“前面 n 项”；后桶全部 pending 时显示“待处理 n 项”，否则显示“后面 n 项”，禁止用位置切片虚报状态。
- “已完成 n 项 / 待处理 n 项”入口使用主 UI 正文字号 `text-ui-base`。桌面 hover 或键盘 focus 时，参考 Goal item hover 卡片在 Status Panel 左侧 4px 打开轻量预览，不再把明细插入面板文档流；无 hover 输入可点击入口打开同一卡片。卡片与触发器之间可安全移动，宽度、圆角、边框、阴影和 `120ms / 80ms` 开关延迟沿用 Goal 预览，内容过长时只滚动卡片内列表。
- 每条 Todo 文案最多展示两行，超过两行时在第二行末尾显示省略号；该限制只作用于视觉渲染，完整内容仍保留在 snapshot 和 DOM 文本中，不得截断 model 数据。
- Todo 的 id、内容或状态变化形成新 snapshot 时，已打开的隐藏分组预览关闭并重新计算聚焦窗口；该状态只属于 renderer，不写入 session、store 或 protocol。
- 进程区块标题行可折叠，左侧仅标题和箭头可点击；标题行最右侧始终展示 `completed/total`；收起时参考 Goal 标题右侧的辅助信息样式追加 `· 状态图标`，例如 `3/4 · <icon>`，右箭头同样仅在标题内容区域 hover / focus 时显示。
- 进程 model 必须保留完整 todo snapshot，renderer 只应用上述用户可逆的聚焦窗口，不得在投影层丢弃项目。区块内容最多占 `20rem`，必须能容纳 6 个各占两行文案的 Todo；更长文案或展开分组后在进程区块内部滚动，标题和 `completed/total` 始终固定可见。

goal todo 和普通 todo 都是 `ZCodePlanStep[]`；goal todo 的轮次语义只用于 Goal prompt 行，不再影响进程区块的列表结构。

### 终端与智能体

后台运行资源按 kind 拆成两个独立区块，不再共用 Running 列表：`kind === "bash"` 进入“终端”，`kind === "subagent"` 进入“智能体”。两区块各自折叠、各自统计和各自计算最长运行耗时；某类型为零时对应区块不占位。

- Composer 工具条在“添加菜单 → 模式选择”之后提供单一后台任务入口，入口只消费当前 session snapshot 中 `status === "running"` 的 `backgroundWorks`，不聚合其它 task、session 或 workspace。宽输入区在同一按钮内分别显示终端图标 + Bash 数量、Bot 图标 + Subagent 数量，数量为 0 的类型不占位；Composer 容器宽度 `<= 480px` 时合并为 Activity 图标 + running 总数。hover tooltip 也必须跟随非零类型：仅 Bash 为“运行中的终端”，仅 Subagent 为“打开运行中的智能体”，混合时为“打开运行中的终端与智能体”；无障碍名称继续包含 Bash、Subagent 和总数的完整计数。`resultPending`、`failed`、`cancelled` 与已经完成的任务不计数，最后一个 running task 收口后入口立即消失。
- 点击 Composer 后台入口必须把有效面板偏好切到 `panel`，同时展开当前非空的“终端”与“智能体”区块，让用户一次操作直接看到全部后台明细。两个区块之后可以分别手动折叠；session 切换时两者都重置，某类型 running 数量归零时只重置对应区块。若当前 pane 没有 workspace shell 偏好回调，使用 pane-local variant fallback，入口不能成为无效按钮。
- 当前阶段已删除窄屏的 JavaScript inline/overlay 裁决；点击入口统一切到完整 `panel`。后续 CSS 布局必须恢复窄容器 overlay 且不能让 Composer 横向溢出；手机 `/remote` 仍禁止从智能体行打开 Subagent 侧栏。
- “终端”和“智能体”标题都支持折叠 / 展开并默认收起。左侧标题和箭头可点击；展开时右侧展示该类型的本地化后台运行数量，收起时右侧展示该类型中最长运行耗时和数量，不展示多个任务累计耗时。
- “终端”和“智能体”分别完整渲染当前 running 列表，并各自在 `12rem` 高度上限内滚动；两个区块不共用滚动位置，标题、数量和折叠控制固定在滚动视口之外。
- 每个 running item 参考 Goal prompt item 使用两行布局：background subagent 使用 bot icon，bash/process 使用 terminal icon；右侧第一行只展示权威 `title`，不得把内部 `bash/subagent` kind 拼进用户可见标题；第二行展示本地化的“已运行 elapsed”和带短文字的停止按钮。
- 当 background subagent 同时带有 `childSessionId`，且当前界面已注入 subagent 右侧 tab 打开能力时，整个 running item 是可访问的会话入口：点击或按 Enter/Space 必须复用 Agent 工具摘要行的 `parentSessionId + childSessionId` 打开逻辑，在右侧创建或激活同一个完整只读 child session tab。不得在 Status panel 内另存打开状态，也不得创建第二套 child session；重复激活继续由 workspace side pane 的稳定 tab ID 去重。
- 新启动的 background subagent 必须把 Agent launch output / runtime task snapshot 中的 `childSessionId` 原样写入 `BackgroundTaskStarted/Updated/Completed`，再投影到 `backgroundWorks`；`workId` 只用于后台任务控制，不能替代 child session identity。只有缺少该字段的历史事件允许降级为不可下钻 item。
- bash/process、缺少 `childSessionId` 的 subagent，或没有右侧 tab 能力的界面保持普通非交互 item。手机 `/remote` 紧凑模式继续沿用现有入口 gate，不得因为 Status panel 可见而绕过 `web-remote-replayable` 边界。
- 停止按钮只在 projection 声明 `cancellable !== false` 时展示；UI 不根据 kind 或本地 phase 推断取消能力。
- 可打开的 subagent item 内，停止按钮仍是独立动作；点击或键盘激活停止按钮只发送 cancel，不得冒泡打开 child session tab。
- 后台 item 不展示 `outputTail`、`stderrTail`、`stdoutTail`、fallback command 或 PID 辅助文本，避免后台任务列表在紧凑面板里抢占 goal/todo 的视觉层级。
- 列表按运行时长倒序排列。任务分类来自 CLI `backgroundWorks[].kind`；UI 不读取 `toolName` 再次分类。旧事件的工具别名兼容必须在 CLI materialization 前完成。

终端与智能体区块都不展示已结束 job；终态继续由 runtime snapshot 收口。

```text
CLI backgroundWorks (current session snapshot)
        |
        +-- status=running --+--> Composer：Bash / Subagent 计数
        |                    +--> kind=bash ----> Status Panel / 终端
        |                    `--> kind=subagent -> Status Panel / 智能体
        `-- terminal ----------------> 不展示

Composer background trigger
        |
        +--> effective panel variant = panel
        +--> Bash count > 0 ----> 终端 open = true
        `--> Subagent count > 0 -> 智能体 open = true

Status capsule
        |
        +-- 有 pending / running 工作流 --> 显示第一条 run：名称 · 灯 · phase · +n
        +-- 有 Goal / Todo / Git 等主状态 --> 只显示主状态
        `-- 无主状态且有 running work ----> 显示实时活动兜底（终端 / 智能体计数）
```

## 兼容性

- Desktop local 和 web remote 都复用同一 UI 投影，不新增 agent 协议、不新增 DB 表。
- Git review 打开只操作 UI side pane 和 selected source，不改变 task stream、snapshot、queue 或 owner command 语义。
- 当前阶段移动远控不再按宽度自动切换摘要行；窄容器的 overlay 与不挤压主内容语义留待 CSS 布局重构恢复。
