# task-row-hover

会话行悬停卡片的展示模块。侧栏的按项目、置顶、时间线、按分组四种会话行共用同一份卡片，避免字段和触发逻辑各写一套。

意图：

- 悬停时给出任务真正的工作目录、最近活动和当前 HEAD，而不是让用户从 worktree 图标或行内元信息猜测。
- 卡片只读：不修改任务、workspace、Git 状态，也不写任何 store。

不变量：

- 本地和远程会话都挂载卡片；远程任务显示设备徽标，但不显示地址、连接类型、连接状态详情或设置入口。项目身份详情仍只由项目入口和会话头部承载。
- 本地任务固定使用 `useBaseWorkspaceServices()` 读取本机 home 和 Git；不能因为同路径远程标签页处于活动状态而继承 remote session。远程任务才使用 `useWorkspaceServicesResolution`。
- 路径和 Git 查询使用任务的 `cwd ?? workspacePath`；worktree 任务的 `workspacePath` 是项目主目录，不能用于显示或 Git 查询。
- 标签与 worktree 名来自任务的 `worktreeRoot`，与头部胶囊、行内图标同源。
- Git 快照只在卡片打开后查询一次；关闭即丢弃，不轮询。
- 远程未连接（`rpcReady=false`）时不发 `system.info` 或 Git 请求，显示原始远程路径并隐藏分支；卡片本身仍然显示。
- `hoverEnabled=false`（手机远控 / Web remote）时项目、置顶、时间线行不挂载；分组行由 `disabled` 显式禁用；分组拖拽期间不挂载。

与其他模块的交集：

- 行组件（`TaskListItem`、`ProjectTaskSidebar` 的 grouped row）只负责把任务事实和行元素传进来；触发、定位和关闭都在本模块内完成。
- `WorkspaceHeaderSections` 的头部卡片是另一处展示面，字段口径应保持一致；不要在行组件里复制字段推导。
- 行为规格见 `docs/ui/task-row-hover-details.md`，worktree 命名规则见 `docs/git/worktree.md` §3.7。
