# Composer 触发器路由与 Mention Panel 布局

> 状态：已实现并通过 focused tests 与 Desktop E2E（2026-07-31）；2026-08-20 补充
> Composer Skill catalog 的 workspace/session 生命周期，见
> [conversation-skill-catalog-lifecycle.md](./conversation-skill-catalog-lifecycle.md)。
> 本轮只调整输入框的主入口、分组顺序和默认提示，不删除旧候选能力、触发器、canonical Markdown、历史解析或恢复兼容。

## 产品决策

Composer 以 `@`、`/` 和 `$` 作为三个主发现入口：

| 主入口 | 主分组顺序                      | 语义                                                                                               |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@`    | 1. Plugins；2. 文件；3. 对话    | 引用当前任务需要的上下文。文件分组同时包含文件和文件夹；对话保持当前 workspace 的 sessions-index。 |
| `/`    | 1. 命令；2. Skills；3. Subagent | 选择要执行的命令或能力。                                                                           |
| `$`    | Skills                          | 直接选择技能。                                                                                     |

旧能力继续保留：

- `@` 中已有的 Whiteboards 分组继续展示，排在上述三个主分组之后，不删除 provider、chip 或历史渲染能力。
- `#` 仍可直接打开原有对话候选面板。
- `$`、`¥`、`￥` 仍可直接打开原有 Skills 候选面板，其中 `¥`、`￥` 继续归一为 `$`。
- 旧草稿、历史消息和外部入口产生的 file、whiteboard、session、skill、subagent mention 继续按原格式解析和展示。
- 其它未放入主分组的能力仍可通过普通自然语言 prompt 使用；本次不删除 runtime capability。

输入框的 `+` action menu 显式突出 `@`、`/` 和 `$`，不再单独展示 `#` 对话快捷项，因为对话已进入 `@` 主入口；但用户手动输入 `#` 时，原候选面板仍正常打开。
`@` 面板的空 query 搜索提示只列出插件、文件和对话，不再提及画板。

```text
Composer
├─ @  引用上下文
│  ├─ 1. Plugins
│  ├─ 2. 文件 / 文件夹
│  ├─ 3. 对话
│  └─ 4. Whiteboards（旧能力保留）
├─ /  选择能力
│  ├─ 1. 命令
│  ├─ 2. Skills
│  └─ 3. Subagent
├─ $  选择技能
├─ #  对话候选（兼容入口保留）
└─ ¥ / ￥  Skills 候选（兼容入口保留）
```

## 入口与 canonical 载体解耦

发现入口只决定“从哪个面板找到候选”，不得改变发送后的稳定载体：

| 候选          | 发现入口                    | 选中后沿用的 canonical 载体                  |
| ------------- | --------------------------- | -------------------------------------------- |
| Plugin        | `@`                         | `[@Plugin](plugin://stable-id)`              |
| 文件 / 文件夹 | `@`                         | 既有 file/directory Markdown link            |
| 对话          | `@` 或兼容 `#`              | 既有 `[#Title](#sess_id)` / `#sess_id`       |
| Whiteboard    | `@`                         | 既有 whiteboard mention                      |
| 命令          | `/`                         | `/command`                                   |
| Skill         | `/` 或兼容 `$` / `¥` / `￥` | 既有 `$skill` 或带路径的 Skill Markdown link |
| Subagent      | `/`                         | 既有 `@agent-name`                           |

因此，把“对话”加入 `@` 不新增 session-reference 协议；把 Skill 和 Subagent 放在 `/` 下也不把它们序列化成 slash command。发送、编辑、queue、retry、fork、cold resume 继续消费原有 canonical text。

## UI Surface Matrix

| 用户场景                               | UI 入口                          | 候选来源                                                                      | 本地状态                                | 提交结果                                     | 模式边界                                                    | 必须隔离                                                             |
| -------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| 引用 Plugin / 文件 / 对话 / Whiteboard | `MentionPlugin` 的 `@` 面板      | plugin reference catalog、file provider、sessions-index、whiteboard provider  | Lexical active trigger + selected index | 插入对应原 canonical Markdown                | Desktop/Web/Mobile 共享；remote 使用目标 workspace services | 不改变 Plugin catalog 冻结、文件路径语义或 session catalog authority |
| 选择命令 / Skill / Subagent            | `SlashCommandPlugin` 的 `/` 面板 | CLI command catalog、Skills、Subagents                                        | Lexical active trigger + selected index | 分别插入 `/command`、Skill mention、`@agent` | workspace identity 隔离保持不变                             | 不把 Skill/Subagent 误当成 command 执行                              |
| 使用兼容入口                           | `#`、`$`、`¥`、`￥`              | sessions/skills provider；仅 `#` 聚合同 authority 的 workspace sessions-index | 原 trigger state                        | 原 canonical Markdown                        | `#` 不跨 Agent Host；其它触发器与现状相同                   | 不因 `#` 扩容改变 `@` 对话范围或破坏旧草稿                           |
| 从输入框 `+` 菜单发现入口              | `ChatPromptActionMenu`           | 静态入口                                                                      | 无持久状态                              | 插入 `@`、`/` 或 `$` 触发字符                | 各端只做布局适配                                            | 不再重复暴露 `#`，但不得影响手动输入 `#`                             |

## 共享与差异行为

- `@` 与 `/` 继续复用 `MentionPanel` 的虚拟列表、键盘导航、禁选态和滚动 mask。
- 两个主面板共享布局，不共享候选 authority：Plugin、文件、对话、命令、Skill、Subagent 仍由各自 provider/hook 负责。
- 文件候选由 workspace 所属 Host 的 `listWorkspaceFiles` 统一建立索引，并遵循 [Workspace 文件搜索默认过滤器](../superpowers/specs/2026-08-07-workspace-file-search-default-filter-design.md)；UI 不维护第二份黑名单。普通隐藏目录只隐藏目录候选并继续扫描后代，未来自定义规则通过替换 service 过滤器接入，本期不提供配置来源。左侧 Workspace File Tree 搜索态复用同一文件索引和匹配排序，但不继承 `@` 面板分组、空 query preview limit、键盘候选提交或 canonical Markdown mention 插入；文件树搜索结果继续按文件树语义打开预览或定位目录。
- `@` 的跨分组搜索按固定分组顺序展示，不做全局相关度重排；分组内部沿用现有过滤和排序。
- `/` 保持命令 → Skills → Subagent 的固定顺序；键盘默认选中仍可使用跨分组最佳匹配，不改变视觉分组顺序。
- `/` 与 `$`/`¥`/`￥` 的 Skill 候选共用同一目录 authority：新建草稿在 prewarm ready 前读取
  workspace 当前目录，ready 后读取 `prewarmSessionId` 对应 runtime 的冻结目录；已有 Session 读取正式
  `sessionId` 对应 runtime 的冻结目录；cold resume/runtime restart 后随新 runtime 重新查询。
  Settings 的实时管理目录保持独立，不能回填或热更新已有 Session。完整时序见
  [Composer Skill Catalog 生命周期](./conversation-skill-catalog-lifecycle.md)。
- 空 query 时展示各分组预览；有 query 时只隐藏默认辅助说明，不隐藏空结果、loading 或 error 状态。
- 对话 provider 根据触发器选择 scope：`@` 保持当前 workspace，只有 `#` 聚合同一 Agent
  service/session store authority 下全部 workspace；`#` 中当前 workspace 候选优先，其余按最近
  更新时间排序，并继续在候选描述中展示 workspace 名称。`#` 空 query 时每个 workspace 最多展示
  最近 20 条；搜索时先匹配该 workspace 的全部历史，再对匹配结果保留最多 20 条。该限制不应用于 `@`。

## 布局与交互

- 候选列表优先展示在面板上方；空 query 的辅助说明位于列表下方。
- 列表保持紧凑菜单密度，分组标题使用 `text-ui-base`、`text-foreground-subtle` 和 `h-8`（32px）垂直居中，虚拟行高度与命令项一致为 34px；并遵循 `DESIGN.md` 规定的菜单 surface 和键盘焦点样式。
- 虚拟列表滚动时，对滚动容器使用上下渐隐 mask；只有对应方向仍可滚动时才显示。
- Enter 和 Tab 选择当前候选；上下键跨分组连续导航；Esc 只关闭当前面板，不改写输入。
- 禁选 Plugin 保持可见并展示冲突原因；禁选态不能被 Enter 或 Tab 选中。
- Desktop、普通 Web 和 Mobile 保持相同分组语义；窄屏只调整尺寸和可视数量，不改变分组或 canonical 载体。

## 边界与剪枝

- 2026-07-31 的入口分组属于 `presentation + option-source`，未修改消息协议。2026-08-20 的 Skill
  生命周期补充新增只读 `skills/referenceCatalog` 查询和 Session runtime catalog 投影，但不修改
  provider request、canonical input、session/task stream、continuous/replayable 或远控恢复链路。
- `@` 与 `#` 仍复用同一个 provider 和当前 Agent Host authority，但触发器范围显式隔离：`@` 只取当前
  workspace，`#` 才启用跨 workspace 聚合。
- `#` 的“全部 workspace”以当前 window-scoped Tab Store 中已打开或恢复、且与 composer 共享同一会话存储
  authority 的 workspace 为边界。local-local 与同一 remote authority 可聚合；local-remote、不同
  remote authority 不共享 SQLite session store，本轮剪枝，避免选择后 Agent 用 `ReadSession` 读不到会话。
- Skill 在 `/` 与 `$`/`¥`/`￥` 下共用同一 provider-filtered catalog，不做两套 enable/filter 语义。
- Whiteboard、主题、语言、task phase、模型/provider 不与分组顺序做笛卡尔积；用共享组件不变量和代表性 Desktop case 覆盖。
- Remote workspace 验证同一 `remoteSessionId`/service authority 下多 workspace 聚合，以及不同 remote
  authority 与未连接 remote 不进入候选；任何 remote scope 都不得回退到本地 base service。

## 验收

- 输入 `@` 时，主分组固定按 Plugins → 文件 → 对话展示，Whiteboards 作为保留分组排在其后。
- 输入 `/` 时，分组固定按命令 → Skills → Subagent 展示。
- 输入 `#`、`$`、`¥`、`￥` 时，原候选面板仍能打开并选择。
- 输入 `#` 时，可以选择同一会话存储 authority 下其他已打开或恢复 workspace 的对话；当前
  workspace 优先，候选行展示来源 workspace 名称。输入 `@` 时仍只显示当前 workspace 的对话。
- `#` 的候选上限按 `workspaceIdentity?.trim() || workspacePath` 分桶，每个 workspace 最多 20 条，
  不能用全局 20 条让某个 workspace 挤掉其他 workspace；搜索仍覆盖最近 20 条之外的历史会话。
- `+` action menu 直接展示添加、插件、文件、会话；底部按 `@`、`/`、`$` 顺序说明快捷符号，不显示独立 `#` 快捷项。
- `@` 选中的对话仍写入 `#sess_...` canonical session mention；`/` 选中的 Skill/Subagent 仍写入既有 Skill / `@agent` mention。
- 空 query 辅助说明在列表下方；输入 query 后隐藏。
- `@` 的空 query 辅助说明只提示可搜索插件、文件和对话，中英文均不出现画板 / whiteboards。
- 上下键、Enter、Tab、Esc、滚动 mask、Plugin 禁选态保持可用。
- 旧草稿和历史中的 Whiteboard、Session、Skill、Subagent mention 继续正确回显。

## 实现与验证

- `MentionPlugin` 通过纯路由表固定 `@` 的 plugins → files → sessions → whiteboards 顺序，同时保留 `#` sessions provider 与 `$`（含 Yen 归一）Skills provider。
- `ChatPromptActionMenu` 展示添加、插件、文件和会话候选；`@`、`/`、`$` 仅作为底部提示。
- 候选序列化函数未改：`@` 选择对话仍写入 `#session` canonical，兼容 Skills 入口仍写入原 Skill Markdown。
- sessions provider 只在 `#` 触发器下从当前窗口 workspace tabs 构造同 authority scope 集合；`@` 继续
  构造单一当前 workspace scope。两者复用 sessions-index registry；
  详细 authority、跨 Host 剪枝与覆盖见
  [跨 Workspace 对话 Mention](../superpowers/specs/2026-08-04-cross-workspace-session-mention-design.md)。
- focused tests 覆盖主入口顺序、兼容入口路由、`+` 菜单动作集合、Yen 归一与既有 canonical 构造。
- 正式 Desktop E2E `conversation-session-v4-mention.test.ts` 覆盖 `@` / `#` 共用 sessions-index、`$` / `¥` / `￥` 技能选择、`+` 菜单展示 `@` / `/` / `$` 底部提示，关闭后手动输入 `$` 打开技能候选，并在 S08 中验证旧 Session 冻结 Skill 目录、新建任务重新发现真实 `SKILL.md`。
- 完整 plugin/file/session/whiteboard 与 command/skill/subagent 键盘交互组合仍保留在 manual-review pending 语料中；覆盖矩阵不会用上述代表性门禁冒充全组合已转正。

`+` 当前分类与底部提示见 [chat-composer-action-menu.md](chat-composer-action-menu.md)：直接选择附件、目标、插件、文件和会话；`@`、`/`、`$` 在底部作为说明，不再是独立菜单项。

## 共享加载占位

首页草稿、会话输入框共用 MentionPanel；`@`、兼容引用入口、`/` 和 `+` 菜单的加载分组统一显示四行骨架，每行保留图标、名称和描述占位。窄屏隐藏描述占位，减少动态效果偏好下停用呼吸动画；加载提示通过 status 的无障碍名称保留。

加载行总高度为四个候选行高度。加载切换为结果、空态或错误时，虚拟列表按行语义重新计算高度，避免同数量行沿用旧布局；首项自动选中时保持分组标题可见。候选来源、排序、选择和提交语义保持不变。
