# Workspace File Tree

Workspace 文件树入口位于项目和任务行的操作区，也可从右侧内置应用中的“文件”打开。入口在右侧创建独立文件标签页，左侧任务列表保持可用。目录在左、文件预览在右，目录显隐开关位于标题栏左端；目录顺序变更后旧版保存的宽度随布局 key 重置为默认 192px。目录宽度可拖拽调整，分割线与边框重合。收起目录后预览填满区域，展开恢复目录宽度，并保留目录搜索、展开状态和滚动位置。用户通过目录开关选择的显隐状态按 `workspaceIdentity?.trim() || workspacePath` 持久化：从对话等入口直接打开已选文件时，同一 workspace 的文件标签与 session 共用最后状态，关闭并重启 App 后仍恢复；不同 workspace 互不影响。新建未选中文件的文件管理器标签默认展开目录，仅覆盖当前标签，不改写工作区偏好；用户手动切换显隐后恢复使用并更新工作区偏好。目录与预览之间的 resize 高亮上下贴边，不保留圆角缩进。面包屑、文件操作和目录开关共用一行，不再重复显示项目绝对路径。

窄面板及手机视图中，目录和预览交替显示；选择文件后只临时收起当前紧凑布局中的目录，不改写 workspace 的显式显隐偏好，恢复宽屏后继续使用该偏好。标签页导航只更新对应实例，不改变任务归属或激活其他标签。内置应用按文件、浏览器、终端、审查、辅助对话排列；不支持的入口仍按现有能力条件隐藏。

跨工作区文件入口先激活目标工作区，再由目标工作区恢复后的 side-pane owner 消费一次性请求；不得用来源工作区或来源任务给标签补归属。请求只保存在窗口导航 store，不写入持久化设置。临时外部目录继续属于发起入口的工作区。手机 Home 的同工作区入口同时进入 Chat；跨工作区入口将 Chat 与文件打开意图交给新 Root，旧页面不再重复创建标签。

实现约束：

- 文件树实现集中在 `packages/ui/src/workspace-file-tree/`，根部 `packages/ui/src/WorkspaceFileTree.tsx` 保留兼容导出，并提供文件目录与预览的组合容器 `FileManagerPane`。
- 文件树节点不使用 `Collapsible`，目录展开状态由 `expandedPaths` 控制。
- 入口按 workspace 绑定，打开时会传递该 workspace 的 `workspacePath`、`workspaceIdentity` 和 `remoteSessionId`，避免多 workspace 或远程 workspace 串用当前服务。
- task row 入口统一按 `workspaceIdentity?.trim() || workspacePath` 查找对应 workspace tab。本地 task 可以直接打开；远端 task 只有在对应 tab 已取得 `remoteSessionId` 后才显示可执行入口，禁止缺少远端 session 时降级到本地文件服务。
- Pinned task 的文件树入口只负责 workspace 导航，不改变 pin 状态、任务排序、group membership、active task 或 conversation realtime 状态。
- 标题显示 workspace 行上的名称；没有传入名称时再退回到路径末尾。
- 目录内容通过 `fileService.readdir({ path, includeHidden: true })` 按需加载，只读取当前展开目录，不递归扫描整个 workspace；文件树会显示 `.gitignore`、`.env`、`.github` 等 dotfiles。
- 文件树刷新按钮会重读 workspace 根目录以及当前已加载或已展开目录。ZCode/Agent 在已加载子目录里重命名或新增文件后，用户点击刷新必须看到最新文件列表，旧路径不能继续留在树里导致打开失败。
- 文件系统 watcher 只覆盖 workspace 根目录和当前展开目录；目录折叠时必须释放对应 watcher，避免用户浏览过的目录长期占用 OS 监听句柄。展开目录内新增、删除或重命名文件时，文件树应在 watcher 事件后自动刷新对应目录；已加载但折叠的目录通过刷新按钮更新缓存。watcher 的异步目录身份检查按事件批次收口：检查开始前的变更归当前批次，检查等待期间到达的事件必须保留并在后续批次刷新，不能被前一批清理。未加载的深层目录仍遵循懒加载语义，不做全仓递归扫描。
- 可见节点通过 `flattenWorkspaceFileTreeRows` 扁平化，再交给 `@tanstack/react-virtual` 渲染，避免大目录一次性挂载大量 DOM。
- 项目名称上方提供文件名搜索框，项目名称右侧按钮组在 Git 状态可用时提供 Git 变更过滤按钮。搜索框为空时保持当前懒加载文件树，只显示 `readdir` 已加载出的节点；搜索框非空时进入 search results mode，调用当前 workspace 所属 Host 的 `fileService.listWorkspaceFiles({ rootPath: workspacePath })` 建立候选，并复用 `@` 文件候选的文件名、相对路径、绝对路径 fuzzy 匹配与排序规则。文件树搜索不在 renderer 维护第二份黑名单，默认过滤器与 `@` 文件候选一致；远程 workspace 必须由对应 Remote Host 扫描，禁止回退到本地文件服务。Git 变更过滤按钮使用 `GitCommitVertical` 图标，位于更多菜单之后、刷新按钮之前，激活后只显示有直接变更的文件和包含变更后代的目录；非 Git workspace 或临时外部目录不显示该按钮。
- 已加载的空壳目录链会按 compact folders 方式合并显示，例如 `src/features/auth`；展开时只沿单子目录链继续懒加载，不递归扫描普通大目录。
- compact folders 只压缩展示层级；展开其后代目录时，`readdir` 子节点的原始 depth 必须根据 `workspacePath` 与目录物理路径计算，不能使用已经压缩过的 `row.depth`。扁平化阶段再统一扣除 compact offset，确保子内容比父目录深一级，并让 sticky folders 能找到正确父级。
- 上下层都存在 compact folders 时，每段链只扣除本段合并的目录数，不能重复扣除祖先的 offset。例如 `api/architecture` → `chat/transport` → 文件的展示 depth 依次为 `0/1/2`；同目录的文件保持相同缩进与引导线，折叠重开后也必须一致。
- 合并目录的展开显示与单击切换使用相同语义：组成路径中任一路径在 `expandedPaths` 中即为展开。懒加载将 `chat` 合并为 `chat/transport` 后，即使集合中只有 `chat`，第一次单击也必须移除该合并行所有组成路径的展开标记；再次单击展开末段目录。切换在函数式更新中读取最新集合，不依赖旧渲染状态，也不修改祖先或兄弟目录的展开状态。
- 滚动到深层文件时，当前可见行的目录祖先会组合在滚动容器内、虚拟列表之前的单个零高度 CSS sticky 容器中，点击可跳回对应目录；原虚拟行继续保留在原槽位，不迁移。每个子层级的吸顶触发线等于 `scrollTop + 已吸顶祖先数 × 28px`，必须与组合容器内的行位置一致，不能让所有层级都等到滚动容器绝对顶部才吸顶。sticky 定位外层和内部组合子容器都保持透明且不使用 backdrop blur，内部子容器只负责统一裁切所有吸顶层级的圆角。虚拟列表自身使用随 `scrollTop` 和吸顶层数移动的顶部 mask，只隐藏从吸顶区域下方经过的原始列表行，不遮挡 sticky 容器，也不参与高度计算；mask 偏移必须由原生 `scroll` 事件直接写入列表 CSS 变量，不能等待 virtualizer 状态触发 React 重渲染。吸顶切换不得改变滚动容器高度、滚动条长度或主动改写 `scrollTop`；滚动容器仅保留底部渐隐提示。
- 单击目录直接展开或收起；单击文件会通过 `onOpenPreview` 打开右侧 `PreviewPane`，Git deleted 虚拟文件只允许选中和复制路径。搜索结果态只复用文件索引与搜索排序，不继承 `@` 面板的分组、preview limit 或 Markdown mention 插入语义；点击搜索结果中的文件仍打开 `PreviewPane`，点击目录仍按文件树语义定位/展开，必要时按路径逐级懒加载祖先。清空搜索必须恢复原本的 `expandedPaths`、已加载目录缓存、sticky folders 和 watcher 边界，不得把全仓索引灌入懒加载树缓存。
- 右键文件会显示文件操作菜单：`Open` 复用行主动作，`Copy path` 复制文件绝对路径；目录暂不显示该菜单。
- 栅格、行高、缩进、选中态和 hover 态全部使用 Tailwind class 与设计 token；文件行选中态边框使用 `--color-input-border-focused`，和输入聚焦边框保持一致。
- 文件树行与虚拟槽高度均为 `28px`，不额外保留行间距；行使用 `0.5rem` 基础左边距，嵌套节点按每级 `0.75rem` 缩进。缩进区域按 `row.depth` 绘制连续的竖向层级引导线，根层级不显示。引导线整体从 `0.625rem` 开始，并按每级 `0.75rem` 重复，线宽 `1px`，使最后一条线的右边缘与当前层级图标左边缘精确保留 `4px`；引导线使用 `-inset-y-px`，相对行的上下边界各向外延伸 `1px`，使用 `--color-border` 语义色，并作为不接收指针事件的装饰层置于行内容下方，不能改变行高、点击、拖拽、选中或键盘焦点行为。
- 层级引导线由普通虚拟行和 sticky folders 共用的 `WorkspaceFileTreeRowView` 统一渲染；在桌面、普通 Web 和手机 Web，以及 Zai Light / Zai Dark 下保持相同结构，不引入平台或主题分支。
- 打开文件树时通过当前 workspace-scoped `gitService` 读取 staged / unstaged changes，并在文件名右侧显示 Git 状态：`M` modified、`A` added、`D` deleted、`R` renamed、`U` untracked。目录行使用 `●` descendant 聚合提示其后代包含 Git 改动；ignored 路径不显示字母，沿用 `--color-git-ignored` 弱化文本样式；deleted 文件行只允许选中和复制路径，不再打开预览、本地编辑器或文件管理器。
- descendant 目录 `●` 的样式优先级参考 VS Code Git resource priority：`modified` 高于 `added` / `deleted` / `renamed` / `untracked`，同优先级保持 Git 状态收集顺序。
- Git 状态颜色统一走设计 token：`--color-git-modified`、`--color-git-added`、`--color-git-deleted`、`--color-git-renamed`、`--color-git-untracked`、`--color-git-none`、`--color-git-ignored`、`--color-git-descendant`，避免文件树把状态色散落为 diff / warning 的临时借用。
- 标题栏刷新按钮左侧提供更多菜单：本地 workspace 可打开系统文件管理器定位 workspace 根目录，也可以复制 workspace 路径；远程 workspace 禁用本机文件管理器入口，避免把远端路径交给本机打开。
- Desktop Project Memory 项目列表可复用 Markdown 本地目录链接的 Shell 分流入口，将通过 Base Local Host 安全解析出的 Memory 根目录作为 temporary external directory 打开；该入口不改变当前 workspace 身份，也不向 Web Remote / Mobile 暴露本机路径。
- 文件拖拽使用 `application/x-zcode-workspace-file` 自定义 MIME，同时写入 `text/plain` 作为降级文本。
- 文件或目录开始拖拽后隐藏拖拽源行的层级引导线，拖拽结束、放下或窗口失焦时恢复，避免竖线穿过系统拖拽预览。
- Prompt 输入框接收该 MIME 后转成和 `@` 文件提及一致的 Markdown mention。

性能原则：

- 初次只加载 workspace 根目录。
- 展开目录时才请求子目录。
- 已加载目录会缓存；刷新按钮在非搜索态只强制刷新已加载/已展开目录和根目录，并同步刷新 Git 状态，避免全仓递归扫描。搜索态刷新可以同步刷新 `listWorkspaceFiles` 搜索索引，但刷新后的搜索结果仍作为独立结果集展示，不能写入 `childrenByDirectory`。watcher 生命周期必须以根目录和当前展开目录为边界，不得随 loaded cache 或搜索索引无界增长。
- `workspaceIdentity?.trim() || workspacePath` 语义由拖拽 payload 保留，路径读写仍使用 `workspacePath` 与文件绝对路径。
