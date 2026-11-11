# Plugin 能力设置页

## 目标

设置页只保留一个以 `plugin` 命名的入口，正式 section id 为 `plugin`，由 `PluginsSection.tsx` 集中管理已配置的 Plugins、MCPs 与 Skills；MCP、技能、命令、Hooks 是复用同一能力外壳的独立分区，详见「独立设置页收敛」。旧 `customize` id 完全移除，不参与类型、解析或迁移；历史 `plugins`、`mcp`、`skills` 导航值只用于兼容迁移。插件市场是与自动化同级的 Workspace 主页面，由 `PluginStorePage.tsx` 渲染，不属于设置页。

## 信息架构

设置侧栏的 Agent capabilities 固定按 `Memory → 子智能体 → 插件 → MCP → 技能 → 命令 → Hooks` 排列；插件入口使用 `Blocks` 图标，MCP 入口使用 `Cable` 图标。MCP 列表中的直接服务器仍使用 `Server`，用于区分导航能力与具体服务实例。

```text
Plugin（设置页导航）
└─ 插件（页面标题）
   ├─ Scope：User / Workspace 1 / Workspace 2 / ...
   ├─ Plugins：当前 Scope 已安装插件
   ├─ MCPs：当前 Scope MCP 与待处理状态
   └─ Skills：当前 Scope Skill，按自身与插件来源分组
```

顶部 Scope 与能力 Tab 是两个独立状态：切换 Scope 保留当前 Tab，切换 Tab 保留当前 Scope。首次进入默认选择 User 与 Plugins。Scope 是三个 Tab 共用的严格数据边界，不展示其它 Scope 的继承项。

顶部控制行左侧排列 Scope 与能力 Tabs，右侧提供当前 Tab 的搜索框。搜索框有内容时，右侧使用 `X` 图标按钮清空当前 Tab 搜索，不使用浏览器原生文字关闭控件；按钮复用 `Button` 的 `icon-sm` 尺寸并使用 `rounded-full`，图标为 `size-3.5`。Plugins 搜索插件名与来源，MCPs 搜索服务器名及配置内容，Skills 搜索名称与简介；三个 Tab 的搜索均忽略大小写。每个 Tab 独立保留搜索词；切换 Scope 时继续用当前 Tab 的搜索词过滤新 Scope。Plugin 使用顶部搜索框时不重复显示 MCPs/Skills 原有的内部搜索框，独立 MCP 与 Skills 设置页仍保留原搜索交互。

## Scope 语义

- `User` 展示用户安装的 Plugins、Built-in Plugins、用户独立 MCP/Skills，以及这些 Plugins 贡献的 MCP/Skills。Plugins Tab 中 Built-in 位于 Installed 分组下方并单独计数；Built-in 不计入 Installed 数量。
- Workspace 展示该 Workspace 安装的 Plugins、该 Workspace 独立 MCP/Skills，以及这些 Workspace Plugins 贡献的 MCP/Skills。
- Scope 菜单只展示当前可连接的 Workspace：本地目录不可用时隐藏；远端 identity/target 没有对应 `remoteSessionId` 时视为未连接并隐藏。可用的本地 Workspace 使用 `Folder`，已连接的远端 Workspace 使用 `Cloud`；触发按钮与菜单项必须使用同一图标语义。当前选择失效时设置页回退到 User scope。
- Plugin 贡献资源的归属跟随所属 Plugin 的安装 scope；`Skill.scope=plugin` 或 Plugin MCP 来源本身不能绕过 Scope。
- Built-in 以缺少 marketplace 安装记录且 runtime `source=official` 为准，属于 User Scope；存在安装记录时必须优先服从记录的 user/workspace scope，不能因使用 official cache 被误判为 Built-in。
- 宿主运行时插件 `node-repl-host@zcode-plugins-official` 不对用户显示：它是 Browser Use 与 Computer Use 共用的 node_repl 宿主，没有 skill、没有 listing，也不能由用户启停。Agent 在 `plugins/list` 与 `plugins/overview`（availablePlugins / installedPlugins / restorableBuiltins）投影里统一剔除它，判定为 `@zcode/shared` 的 `isUserFacingPlugin`；Plugins、MCPs 与插件商店都不再自行过滤。它提供的宿主 `node_repl` MCP 同样不在 MCPs 页显示：Agent 不再在 `plugins/list` 投影 `hostMcpServerNames`，设置页也不再读取该字段，所以 Browser Use / Computer Use 分组下不再出现 `node_repl` 行，MCP 计数不含它。协议 schema 仍保留该可选字段，只为兼容旧版 Agent 的严格解析，App 忽略其内容。Agent 内部的插件加载、seed、node_repl 注册与资源管理器的进程归属（`resolveOfficialPluginNameByHostMcpServerName`）不受影响。
- Plugins 分组标题使用 base 主文字，数量使用 sm 次要文字，避免数量与分组名称争夺视觉层级。
- Plugins 列表图标容器使用 `bg-background`，与列表的 `bg-surface` 层级区分。
- 点击 Plugin 的插件列表项进入内联详情页，复用插件商店的 `PluginStoreDetailView`（介绍、Hero、示例提示词、能力清单与信息区），不再打开简化管理弹窗；已安装态的启停、更新、卸载和高级配置继续复用同一套动作。进入详情时隐藏 Scope/Tabs/Search，使用设置页包屑返回列表。
- Installed 标题行的插件商店入口显示为 `New`，使用 Button 的 default variant、default 尺寸和 `rounded-lg`。
- 顶部 Plugins、MCP、Skills Tab 以 `Name count` 展示；count 使用 sm 次要文字，并跟随当前 Scope、搜索词及列表筛选结果更新。三个内容面板通过 `forceMount` 预加载，同时以 `data-[state=inactive]:hidden` 保证只有激活项可见，确保无需点击 Tab 即可加载全部计数且不会并排显示内容。
- 顶部 Tab 的 count 在激活项使用 `text-foreground-subtle`，未激活项使用更弱的 `text-foreground-subtlest`，名称与计数共享同一选中状态但保持文字层级。
- MCPs 列表复用 Plugins 的列表层级：`bg-surface` 无边框容器、`bg-hover` 行悬停、`bg-background` 圆角图标容器，以及独立的 `bg-border/50` 分割线元素；MCP 状态、来源标识、授权和开关交互保持不变。
- MCP 与 Skills、Commands 统一采用“直属 Installed + 每个 Plugin 独立分组”的信息架构。直属配置只进入 Installed；Plugin MCP 按稳定 `pluginId` 分组，标题使用规范化 Plugin display name 与过滤后的数量。同名但不同 id 的 Plugin 不合并。
- 删除全局 Needs Attention 与扁平 Plugins 分组。授权、连接失败、停用等状态不改变资源归属；需要处理的行只在所属分组内排到正常行之前。
- Plugin MCP 名称后不重复显示 User/Workspace、marketplace 或 `Plugin` Badge；分组标题已经表达来源。MCP 特有的状态、授权按钮、工具数量与诊断信息继续保留。
- 插件贡献的 MCP 行首使用所属插件的商店图标，通过 pluginId 关联 listing 并复用 `PluginStoreAvatar`；没有图标或加载失败时使用该组件的统一 fallback。直接 MCP 使用 Cable 图标。
- Plugin 的 Plugins 与 MCPs 分组标题统一使用 `h-7 items-center`，保证 Installed、Built-in、Needs Attention、Plugins 标题高度一致。
- Plugin MCPs 不显示 “Manage MCP server configurations used by ZCode Agent.” 页面说明；Import 与 New 操作位于 Installed 分组标题右侧，两者参考 Plugins 的 New 按钮使用 default 尺寸与 `rounded-lg`。普通 MCP 设置页仍保留说明和原顶部 Import/Create 操作区，远程同步操作不随之移动。
- 当前 Scope 真的没有直接安装项时，Plugins Installed 显示 Browse plugins 引导，MCPs Installed 显示 New MCP server 与 Import 引导；Built-in 或插件贡献资源存在时仍保留 Installed 空引导。存在搜索词时，各 Tab 只显示有匹配项的分组：直属 Installed 为 0 时连同标题、数量和 New/Import 操作一起隐藏；Built-in、Needs Attention 与各插件来源分组遵循同一规则。全部分组都无结果时，只显示统一的透明虚线“没有匹配结果”反馈，避免把搜索空结果误认为未安装。
- Plugins、MCPs 与 Skills 共用的“尚未安装”引导容器，以及 Plugin 的无匹配/不可用空状态，均使用透明背景和 `border-border` 虚线边框，不与正常的 `bg-surface` 列表混淆；容器内操作按钮统一使用 `size="lg"`。Plugin loading 状态复用同一容器层级和留白。
- Plugin Skills 保留“当前 Scope 直属技能 + 每个插件独立分组”的来源结构。直属技能分组统一命名为 `Installed`，Scope 只由顶部选择器表达；技能名称后不再重复显示 User、Workspace 或 Plugin 标签。分组标题、列表容器、显式分割线、图标底色与行 hover 对齐 MCPs，标题右侧只放置 Import 与 New，不提供手动刷新；导入、新建、同步或启停等数据变更完成后自动刷新列表。Skills 不提供启用状态筛选菜单，列表始终包含当前 Scope 中已启用和已停用的技能。当前 Scope 没有直属技能时显示新建或导入引导，插件技能仍按插件分组继续展示；搜索导致的空结果不显示安装引导。
- Plugin Skills 的直属技能使用 WandSparkles 缺省图标；插件技能通过对应插件的 marketplace listing 显示插件图标，找不到匹配插件时回退到缺省图标。
- Plugin Skills 的插件分组标题复用 `formatCanonicalPluginName` 做名称转换，与 Plugins 和 MCPs 的插件显示名保持一致；其中 `mcp`、`aws`、`zcode` token 固定显示为 `MCP`、`AWS`、`ZCode`，内部分组 key 仍使用原始规范化名称。
- MCP 授权操作统一使用 `<ExternalLink size-4> Authenticate` 的 link variant 按钮，并明确使用 `text-sky-500 dark:text-sky-400` 及对应 hover 色；不能使用会在 Zai 主题变成黑/白的 `text-brand`。直接 MCP 与插件 MCP 保持一致。
- 直接 MCP 的缺省图标始终为 Cable，插件 MCP 使用对应插件图标。两类 MCP 的状态 dot 统一叠放在图标容器右下角，不再占用名称行空间；父容器固定为 `size-4 bg-background` 并居中内容，静态圆点使用 `size-2.5`，确保切换到连接中旋转状态时外层尺寸不跳动。状态颜色和原因 Tooltip 保持不变。
- 进入 MCP 新建或编辑子页面时隐藏 Plugin 的 Scope、Tabs 与 Search 工具栏，并移除列表态顶部间距；保存、删除或取消回到列表后恢复工具栏。
- MCP 新建/编辑表单复用顶部完整 Scope 菜单（User 与当前窗口全部 Workspace），不再使用仅有 User/Workspace 的简化 Select。新建表单打开时快照父级当前 Scope；编辑表单显示资源实际归属并锁定，避免一次编辑隐式迁移配置。新建表单内切换 Scope 只改变本次保存目标，不修改父级 Scope；关闭表单后父级仍显示打开表单前的选择。
- MCP 表单的 Form/JSON 模式切换复用自动化详情 Settings/History 的设置分段 Tabs：`bg-surface` 圆形外壳、`bg-background` 圆形激活项；两处由同一个通用组件维护，不复制视觉 class。
- 新建 MCP 保存前必须先按表单 Scope 解析具体 workspace target，并等待对应 `workspacePath + workspaceIdentity` 的 MCP 配置加载完成；User 使用当前可用 host 的用户目录，Workspace 写入所选 Workspace 的 `.zcode/config.json`。目标切换期间不得使用上一个 workspace 的 path 或远程 directory service。
- Workspace 不混入 User 资源；User 不混入任意 Workspace 资源；不同 Workspace 之间也不共享资源投影。
- Workspace 列表来自当前窗口已打开的 workspace tabs，保持标签顺序并按 workspace identity 去重。
- Workspace 显示 tab label；身份 key 必须使用 `workspaceIdentity?.trim() || workspacePath`。
- Scope 菜单中的 User 使用 `Monitor` 图标，表达本机用户级配置；当存在用户名时，仅在下拉菜单的用户名后显示 `User` 标签。选中 User 后，顶部触发器只显示 Monitor 与用户名，不重复显示标签。没有用户名时只显示本地化的 User 文案。Workspace 继续使用 Folder 图标且不显示 User 标签。
- 服务调用继续传递实际 `workspacePath`；远程 workspace 同时传递 `workspaceIdentity`、`remoteSessionId` 与 `remoteTarget`。
- 关闭当前选中的 workspace 后，回退到 User；User 所依赖的 host 不可用时展示不可用空状态，不另起 runtime。

## Plugins Tab

- 标题为 `Installed N`，只展示当前 Scope 已安装的插件。
- 行展示图标、插件名和来源。
- `New` 进入插件市场入口；插件市场 Installed 区域的管理按钮也回到此 Tab。
- 点击普通行进入复用的完整插件详情；列表行直接提供启停、更新与卸载能力，不创建第二套安装状态。

## MCPs Tab

- 需要认证、配置缺失或连接异常的项目保留在其直属或 Plugin 分组内，并在组内优先展示。
- 插件贡献的 MCP 由具体 Plugin 分组表达来源；可认证项提供 `Authenticate` 主操作。
- 提供 `New MCP Server / Add a Custom MCP Server` 固定入口，在当前 Scope 新建 MCP。
- 直属 MCP 位于 Installed，Plugin MCP 按具体 Plugin display name 分组；三个页面复用同一分组标题、列表容器、间距和显式分割线组件。

## Skills Tab

- 先按 Scope 严格过滤，再按来源分组。当前 Scope 自己拥有的 Skill 位于 `User` 或 workspace 分组；插件贡献 Skill 按具体插件 display name 分组。
- 分组标题显示数量；每行展示图标、名称、简介及更多操作。
- `New` 只作用于当前可写 Scope，不向插件贡献分组写入文件。

## 状态与时序

```text
scope/tab change
      │
      ▼
resolve workspace target ──失败──> unavailable empty state
      │
      ▼
request with path + identity
      │
      ├─ target key unchanged ──> commit result
      └─ target key changed   ──> discard stale result

parent scope ── open new ──> form scope snapshot
server owner ── open edit ─> locked form scope
form scope change ────────> resolve form-only target
save ────────────────────> await target config -> persist
cancel/save ─────────────> restore unchanged parent scope
```

桌面端保持 `desktop-continuous` 链路；手机远控保持 `web-remote-replayable` 链路。Plugin 只消费现有 shared-host 服务，不建立新的 local/remote host，不改变 snapshot、queue、owner 或重连恢复语义。

## 响应式与可访问性

- 桌面顶部同一行展示 Scope 与 Tabs；窄屏允许换行，Tabs 可横向滚动。
- Scope 菜单在窄屏限制到可视宽度，长 workspace 名称截断但保留完整 accessible name。
- 所有触发器支持键盘操作和可见焦点；图标按钮必须提供本地化 accessible label。
- 使用语义颜色、`text-ui-*` 字号和现有 Button、Tabs、DropdownMenu 等基础组件，兼容亮色、暗色与 Zai 主题。

## 验收

1. 设置页只显示一个「插件」能力管理入口，不显示 Plugin 或旧插件市场入口。
2. 插件设置内容默认显示 User + Plugins；Workspace Sidebar 的「插件」打开独立插件市场主页面。
3. Scope 菜单列出 User 与所有已打开 workspace，并按 workspace identity 隔离。
4. 三个 Tab 的选择在 Scope 切换后保持，列表只展示目标 Scope 数据；插件贡献 MCP/Skills 必须关联到当前 Scope 的 Plugin 安装记录。
5. 顶部搜索框随 Tab 使用对应 placeholder 与过滤规则；三个 Tab 的搜索词彼此独立，Scope 切换后继续过滤当前 Scope。
6. 桌面、手机 Web 均可操作；不新增 runtime，不破坏远程 replayable 边界。
7. 父级选择 User 或任一 Workspace 后打开 New，表单显示同一 Scope；新建表单可选择完整 Scope 列表，切换后父级选择不变，保存写入表单所选目标。编辑表单显示 MCP 实际归属且不可迁移。

## 独立设置页收敛

- 设置侧栏在 Agent capabilities 下注册 `memory`、`subagents`、`plugin`、`mcp`、`skill`、`commands`、`hooks` 七个正式分区，以 `settingsPageConfig.ts` 的注册为准；其中 `plugin`、`mcp`、`skill` 共享同一能力管理外壳。Plugin 页面继续保留 Plugins、MCPs、Skills 三个 Tab；MCP 与 Skill 独立分区分别直达相同的 MCP/Skill 列表，不复制列表、Scope、搜索或 CRUD 实现。
- 复用同一外壳的入口共享 Scope 状态模型：User/Workspace 的过滤、插件贡献资源归属、远端 workspace identity 传递必须保持一致。独立 MCP/Skill 页面隐藏可切换的能力 Tab，但在 Scope 右侧保留竖向分隔线与只读的 `MCPs N` / `Skills N` 数量文案，右侧继续显示搜索和对应列表；数量跟随当前 Scope 与搜索结果更新。
- 旧 `customize` 不再保留，遇到该值按非法设置分区清理并回退；历史 `plugins` 迁移到 `plugin`，历史 `skills` 迁移到 `skill`，`mcp` 直接作为正式入口。
- `McpSettingsSection` 与 `SkillsSection` 只保留 Plugin 嵌入模式；删除独立页专属的标题说明、内部搜索、旧分组列表、Scope 标签和头部操作布局。
- MCP/Skills 的加载、编辑、导入、新建、启停、删除、认证、诊断和远程同步能力保持不变；仍通过实际 `workspacePath` 执行，通过 `workspaceIdentity?.trim() || workspacePath` 隔离。
- 该收敛只改变设置导航和展示组件契约，不修改 MCP/Skills 服务、协议、持久化格式，也不改变桌面 continuous 与手机 replayable 链路。
- 插件市场 Installed 区域的管理按钮直接进入设置页「插件」的 Plugins Tab；插件市场不再维护独立的“管理已安装”二级页，避免两套已安装列表、筛选和详情入口并存。

# Commands capability integration

- Plugin management exposes three capability tabs: Plugins, MCPs, and Skills. Commands is not a Plugin-page tab.
- Commands remains an independent Settings entry and continues to reuse the shared scoped capability shell. Plugin-provided commands remain visible there in plugin groups.
- The parent User/Workspace scope controls both visible commands and the default destination for newly created commands. User scope includes direct user commands and commands from user-scoped plugins; Workspace scope includes direct project commands and commands from workspace-scoped plugins.
- New/Edit Command reuses the same `PluginScopeMenu` as the parent capability header. New inherits the parent scope and may select another available scope; Edit shows the command's persisted scope and disables scope migration. The form menu aligns to the end.
- Commands use the same header, search, loading, empty-search, empty-install, grouped-list, background, separator, icon, and action sizing conventions as Skills.
- Direct commands appear under Installed. Plugin commands are grouped by their canonical plugin display name and use the corresponding plugin icon when available.

## 2026-09-16 插件本地化与添加入口

Plugins 管理列表、启停反馈按完整 pluginId 关联商店 listing，名称和简介使用商店相同本地化解析；缺失翻译回退原文。同名不同市场不共享元数据。Plugins 搜索当前语言名称/简介及原始名称、ID、marketplace，忽略大小写；与市场共用中文名称的全拼和首字母匹配（例如 feishu、fs），英文界面亦支持，详见 [搜索约定](plugin-creator.md#插件搜索)。

User 视图原 New 按钮改为“添加”菜单，提供“创建插件”和“添加插件市场”；创建只预填官方 plugin-creator Skill 引用，添加市场通过商店统一对话框。Workspace 配置视图保持无市场入口。合同及验收见 [插件创建入口](plugin-creator.md)。
