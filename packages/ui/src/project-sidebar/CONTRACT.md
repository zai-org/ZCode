# 项目侧栏

Host projectService 的 readTree 决定行集合、项目归属和 CLI 事实镜像；UI 只保存折叠、视图与表单草稿。实时 sessions-index 只附加 activity，不补行、不写回归属。读取以请求序号拒绝迟到结果；workspace/remote endpoint 变化立即取消旧结果资格。

设置页复用公开的 `useOptionalProjectDirectory` 读取同一目录 owner；最近项目通过 `resolveRecentRemoteProjectPreference` 按 Source + 目录固定唯一入口 ID，继续既有项目恢复链路。缺失或歧义不生成创建意图，连接完成仍复验原入口。

session 标题通过 `useOptionalProjectSelectionDirectory` 读取同一 owner 的项目/设备投影，
不订阅展开偏好或任务活动；无 Provider 的嵌入场景返回 null。顶部导航与列表标题按原输入
隔离项目展开更新，真实目录、导航、视图及语言变化仍传播，不新增目录缓存或偏好 owner。

恢复时通过公开的 `resolveEntryProject` 从所属 Host 项目树解析有效项目，复用旧入口的唯一匹配规则。原项目 ID 显式传给 Root 草稿 owner，同时更新内存与持久化草稿范围，不从同目录缓存反推归属。

创建经 Host prepareSession 固化 cwd，草稿持有 projectId，首发前由 Host 原子预留归属。选择其他项目会重建尚未提升的预热实例，已提交任务不受影响。拖动只发 moveTask，缺 root 经确认重试，失败保持原树。软删项目保留任务归属；时间线可见；恢复需用户显式选择同 roots 的已删项目。

桌面和手机共用组件；沿用现有 task 行操作、shared-host attachment、continuous/replayable 传输。CLI 不接收项目 ID。

SCT03 显式 App 导航通过桌面平台注入的单窗口请求调用 `useProjectTaskNavigation`，复用任务行的同一导航 owner 和实际查看/未读规则。返回 `opened` 必须观察到原任务选择入口已把精确 workspace identity + task 设为活动任务；发送事件、连接完成或 Controller open 校验均不代表导航完成。取消、卸载、请求被替换或 owner 拒绝选择返回 `unavailable`，迟到远端结果不得重新选择。手机不注册桌面导航处理器；后台 read/send 不调用此入口。目标必须已出现在当前窗口目录投影；尚未水合或归档过滤导致缺行时明确返回 `project.task-not-found`，不创建连接、重试导航或将未知目标冒充打开。见 `docs/architecture/zcode-app-control-design.md`。

composer 的“创建项目”复用侧栏 ProjectCreation：当前为远程会话时默认该设备，其余默认本地。项目服务可用即可创建，不能沿用打开原生文件夹的能力门禁。保存只刷新目录，取消不写入，两者不切换项目/工作区或改写聊天草稿。独立设备连接后的创建继续受当前聊天返回资格约束，普通创建不继承该设备。

远控模式的自动未读由 desktop base 目录 owner 唯一提交。Main 验证后的 Web 实际查看逐事件进入该 owner，同一任务的完成写与查看读/CAS 串行；精确读取所属 Source 当前 marker，不使用列表缓存。重复查看不清手动未读，旧 attachment 回包不再写入，Web 共享组件不成为第二个自动写者。详见 [任务列表刷新语义](../../../../docs/task-list-refresh-semantics.md)。

本机入口 ID 决定远端可见项目集合，远端 readTree 决定这些项目的权威内容；离线缓存只含名称和 roots，不含会话索引。请求提交前重读入口列表，拒绝移除后迟到结果；旧入口仅唯一 cwd 匹配才解析。未添加的远端项目不自动进入树。同名/同 ID 跨 Host 的排序、选择和去重必须使用 Host + 项目 ID。

Web 远端 attachment 的整体可选 `windowProjectDirectory` 能力提供窗口项目服务、远端入口服务和只读项目变化流。目录 owner 一次选择完整组，读取、修改、accepted snapshot 身份与订阅不可混用窗口和 Source；无能力时沿用 base 目录。有能力但就绪校验失败必须报错。原工作区 project/broadcast 服务不替换，非目录消费者保持 Source 语义。bridge 服务换代释放旧订阅并拒绝迟到结果。详见 `docs/web-remote-control/wide-screen-task-list.md`。

本地和远程项目平铺混排，设备标识与连接状态放在项目行，连接状态只读连接管理器；离线可连接或移除本机成员，在线可显式选择已有项目或创建并添加入口。选择器 readTree 不写入口，只有用户选择/创建成功调用 addEntry。新建使用 Host 分配的 workspaceIdentity；同 cwd 不跨 Source 复用 logical attachment。Host 移除后重连不得创建成员或重建入口。

远端项目 prepare/历史 task 已确定 cwd 与 identity，导航将两者一起传给原 open-project/Host bind；普通目录选择才执行 canonical resolver。不得再次 realpath 后以别名重建身份，不能放宽绑定后精确 identity 检查来掩盖路径分叉。

UI 纠偏：分区复用 WorkspacePurposeSection 和原折叠/顺序偏好；项目行恢复旧行高、间距及 hover/focus/touch 操作。项目菜单用非模态右键导航，编辑弹窗独占模态限制。时间线通过插件市场下的筛选菜单开放为「最近更新」。项目加号直接显示名称、设备、源文件夹。ProjectEditor 持有唯一草稿，桌面设备全集从 Source 投影读取，不取项目 open set；无 Source 管理能力的 Web／手机只投影既有 Host 目录，不扩大管理权限。选择设备无连接副作用；有目录须先确认再原子清目录并切设备。离线设备在显式选择文件夹或已有项目时复用 Root 唯一连接向导，保持原项目页签；只有新增设备进入设置。连接层收起期间保留表单。设备切换、取消和卸载使旧目录结果失效。创建前只为没有成员的已识别设备显式登记，已有成员严格复查 membership；远端保存后按原 ID 登记本机入口，登记失败重试不再创建项目。不打开 workspace tab 或 Agent。

桌面本地项目添加目录通过 IPlatformService.selectDirectories 调起系统多选；结果仅合并去重到编辑器草稿，保存才提交。远端与 Web/手机目录浏览通过 projectService.readDirectory(hostId)，不从当前 tab 推导文件服务；DirectoryBrowser 的迟到响应沿用请求序号判定。选择在途与保存/关闭互斥，取消不修改草稿。见 docs/ui/project-local-directory-picker.md。

有源文件夹的新建（含恢复）在 Host 成员登记和 saveProject 前显示本次目录信任确认，展示所选设备及完整 roots。ProjectEditor 是唯一草稿和确认请求 owner；取消保留表单，隐藏/卸载令旧查询与确认失效，单次保存以在途引用去重。确认只授权本次创建，不持久化、不改变 Hook Trust；重复使用目录仍确认，本地零 roots 直接创建。编辑和添加已有远程项目保持原行为；已保存项目的入口登记重试复用 created，不再次创建或确认。见 docs/specs/project-creation-folder-confirmation.md。

本地项目行根据 roots 数量和展开态显示文件夹：0/1 root 使用 Folder/FolderOpen，多个 root 使用 Folders/FoldersOpen。composer 当前项目和菜单候选复用同一数量规则，保持收起图标。图标直接派生自当前项目，不维护副本。远程项目行复用连接展示模型的五态图标，已连接为中性云，展开/收起不改变设备图标。不显示独立箭头；连接进度与错误诊断沿用原有入口。hover/focus/touch 保留更多、查看文件、新建任务三个入口，右键复用相同操作定义；按钮不触发行折叠。查看文件沿用现有 WorkspaceFileTree，多 root 先选择，空 root 禁用；远端经现有连接/身份绑定，手机经 shared-host 切换，迟到结果不能覆盖新目标。

每个 Host + project ID 的折叠状态归常驻侧栏，项目行只接收值与切换命令；文件树替换列表后返回不能重置折叠状态。

编辑器的 roots/primary 只属于表单草稿，保存才通过 saveProject 提交；有 roots 显示紧凑列表和末行添加，空 roots 才展示整块空态。已有项目的删除入口复用 deleteProject，并携带原 hostId；成功刷新后关闭，失败保留弹窗，保存/删除互斥。主要目录只决定后续新任务 cwd，不重绑旧任务。

旧体验保留：按项目选择器复用运行层稳定排序和更新时间，从同 Host/project 的未归档成员（含置顶）派生收起未读点。偏好 hook 只拥有视图/折叠的 browser persistence；项目点击无导航。任务交互 owner 只保存尚在途的 pin 意图，Host 树始终是唯一已提交行集合；归档成功复用 UI 清理。任务行按 Shell 当前 workspaceKey 定位选中态，手机标记按完整目标地址；只有置顶区任务提供文件树按钮，按任务固化 cwd 与精确 identity/session 打开，不读取项目新主目录。远端同步/日志沿用既有接口与桌面 SSH/WSL、手机 replayable 边界，不新增业务状态所有者。

项目折叠复用共享 Collapsible 的 300ms 高度与淡入淡出，单一 open 值仍来自偏好 owner；不能条件卸载跳过收起动效。普通任务行不传递文件树回调；置顶区任务复用同一文件树 owner 和请求序号，手机沿用可信切换，晚到结果不得覆盖关闭或新选择。项目文件入口与原右键/归档/置顶保留。

## 当前任务与归档

项目树读取 owner 接受新快照后，仅对同 Host + workspaceKey + taskId 的未归档到已归档转换调用既有 removeTaskState。归档后的当前详情退出到原工作区草稿，不自动选择下一条同名任务；首次已归档、离线缺行、不同 attachment、失败/迟到结果不触发清理；读取在途期间已有导航提交打开该任务时，以之后的导航为准，本轮不清理（快照可能已过期，清理不可撤回）。标题由 active-task hook 经已有 scoped TaskService.getTaskMeta 读取同一 Host 索引，正文冷恢复不参与标题 authority。

## 输入框项目选择器

`ProjectDirectoryProvider` 是 shell 内项目树读取和排序偏好的唯一 UI owner；`ProjectSidebar` 与公开 `ProjectComposerMenu` 共用该投影。菜单不得从 tabs/cwd 生成项目或推断归属。候选为未删除项目（包括离线入口），按侧栏顺序，搜索名称和 roots；离线不可选。选中来自草稿 projectId + Host 身份，命令复用 onCreateTask -> prepareSession，目录绑定与桌面/手机导航仍由 Root/Host 承担。零 roots 不被过滤。旧 ChatEmptyState 的 tab 菜单退场。

归档管理经 index 公开，属于 project-sidebar/ui。RootWorkspaceContent 提供单一项目目录 owner，嵌套 Provider 复用；设置、侧栏、composer 共用树。归档按 Host+projectId 分组，删除容器和未归类不按目录重绑；操作复用模块内 mutation adapter 与现有 Controller/TaskService。页面只保存筛选/分页/确认候选和在途状态，批量部分失败不伪造全部成功。见 `docs/superpowers/specs/2026-09-11-archive-management.md`。

项目管理（设置 › 项目）同样经 index 公开、复用同一目录 owner。行、疑似原因、筛选与排序是 `project-management-view.ts` 的纯派生；`useProjectManagement` 只持有在途批次锁与最近一次失败，本地走 `deleteProject` / `restoreProject`，远程只增删本机入口（`removeEntry` / `addEntry`），每批结束只刷新一次树。选择是页面草稿，生效集合取草稿与当前可见可移除行的交集。侧栏更多菜单末尾的「管理项目…」仅桌面端。见 `docs/superpowers/specs/2026-10-24-project-management.md`。

侧栏分区标题与置顶行保留旧字号/缩进，空态由 ProjectTaskRows 统一展示。SortableProjects 持有 dnd-kit 暂态位移，排序只在同 Host/置顶分区内经原 reorderProjects 提交，任务原生拖入仍发 moveTask。

ProjectNode 从同一 dnd-kit active/over 派生项目插入蓝线的位置；只标记同置顶分区的其它可排序节点，允许跨 Host，释放/取消随拖拽暂态清除，不新增排序状态。见 `docs/project-drag-insertion-indicator.md`。

拖拽 context 仅进入 ProjectNode 排序外壳；菜单/标题/任务内容通过 memo 浅比较复用，活动项只在 activator attributes 变化时更新。内容仍由原项目投影和回调驱动，不维护第二份排序/项目状态。

主目录可用性见 `docs/project-primary-root-availability.md`：所属 Host 在 readTree/readProjects 中异步探测主目录，返回可选 primaryRootStatus，不写库、不持久缓存；prepareSession 再次检查，失效直接拒绝，不复活或替换 cwd。侧栏消费同一投影置灰标题并禁用新建与查看文件入口（含多 root 菜单和右键），标题仍可展开已有任务并读取历史，focus 刷新沿用请求序号；空项目与附加目录失效不误禁用，远端仅经已有 owner attachment 检查。

分区标题兼作折叠与拖拽入口，操作按钮保持独立；PurposeSections 持有 dnd-kit 暂态并限制纵轴，WorkspacePurposeSection 从 active/over 派生目标蓝线。提交只写原 renderer-local sectionOrder，取消不写；侧栏滚动容器禁止横向滚动。见 `docs/ui/sidebar-purpose-section-order.md`。

首发完成接线见 `docs/task-first-submit-visibility.md`：共享目录接收真实 Host 行后，同次提交目录与既有详情回调；并发失效合并为后续读取，不能持续取消在途结果。服务换代/卸载取消旧结果及待完成导航。

## 侧栏视图

插件市场下胶囊按钮打开原全局搜索，旁侧筛选仅 projects / timeline。偏好 owner 保存 view，默认 projects，忽略旧 sort/time 偏好，保留展开状态。项目与 composer 读取当前控制端侧栏偏好的复合身份顺序。projects 保留全局置顶和运行优先；timeline 只取未归档任务（含置顶与已删除项目历史），按 CLI updatedAt / createdAt / taskId 倒序和完整身份稳定排序，20/+20；分页后只插入本地日历日期标题，不显示项目/Host 分组、不重排、不改变任务 key。最近更新向共享 TaskList 显式传递 timeline 行样式，显示标题、绑定 cwd 末级名、相对时间；无状态不显示圆点但保留对齐槽；按项目保留 default 行。筛选两项左侧使用 Folder/Clock，右侧保留单选勾。选择器和行渲染使用同一模式，不能再次按运行状态排序。切换只修改本客户端偏好，不改导航、归属、Host/CLI 时间或 continuous/replayable 边界。详见 virtual-project-design 的 SBV01–SBV06。

## 2026-10-10 平铺项目与控制端排序

项目区不按 Host 分组，本地/远程按复合 projectKey 在同一区排序。显示顺序由现有侧栏偏好唯一持有，远端组织态不接收 UI 排序写入；离线可排序，跨置顶边界不改变 pinned。远程项目显示设备状态，只有先选定并保存唯一固定目录才能新建会话；任务区只显示本地未归类任务。远程项目编辑器不允许更换/追加目录。

目录首次带来未记录的完整 projectKey 时，共享偏好合并按目录顺序将新项目前插，桌面与手机相同；其余已记录项目保留本端手动相对顺序。重复刷新、改名、暂时缺席后恢复和升级身份替换不重新置前，不按创建时间重排历史项目。创建端的显式 prepend 不代替接收端合并。

远程项目菜单、离线项目占位及详情断线横幅共享连接状态投影 hook；组件仅读取 Source/attachment 状态并发送原重连命令，不能按路径推断身份。拖拽浮层只读当前拖拽数据，不提交项目顺序。

桌面项目连接由 Root 分派：已有 tab 走原地重连；未加载的已保存项目通过公开
`remote-project-connection.ts` 从本机成员目录解析目标并复用 Host connectHost。
需要认证、安装、升级时复用原 dispatcher/唯一向导，携带目录和 Profile；普通成功不创建 tab。
交接前重读项目与 host membership，移除/替换后的迟到结果不打开旧意图。手机仍走既有 Host 连接。

原项目交接只携带精确 Profile/目标、目录和已有入口标识；Source 偏好表示设备选目录，不与 Profile 偏好同时提交。
处理完成由 Root 复验入口并绑定原目录，新连接仍进入项目选择。Direct Server 不走 Source Profile 向导，维持原 Host 连接与错误语义。

未加载 tab 的项目连接按 Host 默认 Profile 规则选线，只使用该线路的状态与错误；设备展示聚合不决定操作目标。
Root 的原项目完成 guard 从成员目录异步复验 entryId、membershipId 与目录，绑定与持久化返回后等待校验再提交导航。
成员失效走已有取消语义，仅清理新 attachment，不进入新建目录选择；桌面 continuous 与手机 replayable 边界保持原有归属。

已有项目通过同一 ProjectEditor 弹窗内的 RemoteProjectPicker 浏览，名称、设备和目录仍由原草稿持有。仅显式选择项目后登记所属 Host 并调用 addEntry；始终使用远端项目 ID，不能按路径复用或调用 saveProject。返回、关闭、成员换代使在途列表和选择失效。旧远端的 legacySingleRoot 只限制新建，不限制浏览或登记原项目。列表行按内容定高，超出可视高度后滚动，不压缩多行名称和路径。

```text
原创建草稿 → 显式打开已有项目 → 必要时连接 → 只读列表
     ↑ 返回（保留草稿）                    ↓ 显式选择
     └────── 取消旧请求资格         membership 校验 → addEntry(原项目 ID)
```

聊天项目菜单的「新建远程连接…」复用 Root 的设备添加返回契约。文本、附件及项目选择继续由现有 composer/store 持有，返回引用仅检查聊天实例并接收实际 Source 结果。连接成功后每次显示目标设备的文件夹选择；确认目录后唯一匹配复用原项目，多匹配显式选择，零匹配复用共享创建与信任确认。登记入口并经 Root 准备工作区完成后进入目标项目新草稿，用户手动发送；顶层取消保留原草稿并明确恢复后的目标。聊天切换、新建草稿和 owner 卸载使旧结果及旧继续操作失效；Web／手机能力门禁继续由壳层提供。

首次主动连接与已连接设备的显式目录浏览共用原版持续运行介绍；已读只使用 `remoteBoundaryIntroAcknowledgedVersion: 1`，只在「知道了」后写入。新标记缺失（含旧字段版本 2）补看一次，存量版本 3 由设置 owner 迁移；后台完成、本地目录、读取失败和失效 epoch 不消费说明。

项目菜单与所有项目行共用只读项目详情浮层；名称只在标题出现一次，本地正文仅按 roots 顺序列出完整目录，零目录显示「—」。远程项目追加设备、连接类型、地址及状态；只读既有项目与 Host 投影，hover 不发起查询或连接。远程浮层状态与项目行状态文字共用展示模型短状态。仅项目行在桌面端传入设备设置入口：`pending` 时浮层底部显示操作名入口，点击定位“设置 › 远程设备”对应设备卡，浮层不直接执行连接动作；紧凑单行保留在线/离线设备名。侧栏会话行（项目内、置顶区、最近更新）hover/focus 显示任务卡（任务 cwd、最近活动、分支、变更统计；远程任务仅设备徽标），不显示项目身份详情中的地址、连接类型、状态详情或设置入口；原有会话操作保留。鼠标移出行与浮层、键盘移出或 Escape 自动关闭，无关闭叉与点击锁定。文字可选择和复制，选区不改变关闭规则；触发区与详情区跨区移动沿用关闭缓冲，显示状态仅归身份浮层组件。

聊天的连接后目录流程由 ProjectComposerMenu 持有一次发起意图。ComposerSubmissionPendingContext 仅向当前输入框投影提交阻塞；连接后台化、取消或草稿 owner 失效解除该投影。目录确认后读取目标 Host 的项目；唯一匹配沿实际项目 ID 登记入口，Root 准备与导航完成才释放门禁。异步期间绑定原 Host membership，attachment 提交导航前再次检查 membership、项目 ID 和固定 root。详见 docs/issues/remote-connection-ux/21-chat-settings-round-trip.md。

聊天连接后台收起只保留既有返回 owner，解除原草稿提交门禁；显式继续由连接 owner 校验 Source，由聊天 owner 复验发起时已有成员的 membership，Root 同步标记校验中并在异步校验后重验原意图和 tab，交付后才消费，再进入共同目录流程。目录流程继承该成员资格，迟到结果不能重建已移除成员。首次无成员仍在明确选择后登记；Web 不新增连接 owner。

连接完成前的成员资格读取失败不等同于取消或成员失效。Root 保留同一返回意图的重试资格，将错误交回等待完成的连接 flow；前台继续禁发，沿用该 flow 的实际错误、显式重试和取消。取消撤销在途资格结果，后台可见性仍只影响原聊天门禁，不对其他聊天加锁。

## 分组视图

按项目、按分组、最近更新、按未读共享同一 ProjectDirectory 任务树与任务命令。按未读与系统角标共用可见未读集合及完整身份去重，复用时间线排序、行与分页；偏好沿用现有 owner，空态显示暂无未读任务。已读提交后移除行，不改变当前导航或原 CAS 合同，详见 `docs/ui/task-unread-state.md`。分组呈现复用删除前的组件，保持原整行拖拽、右键菜单和空组新建语义。
`useTaskGroups` 只订阅控制端 Host 的结构，成员身份为 canonical workspace key + taskId；
视图不创建连接或 Agent，不以缺席清理成员，不修改项目或会话事实。
旧 grouped 偏好在没有有效新版选择时映射到按分组。
草稿 placement 独立于项目选择；普通项目选择与聊天远程目录确认均沿用原草稿分组，既有会话不读取残留草稿分组。创建 ACK 后，权威目录确认同时触发 UI 提升与独立幂等入组；组织请求不占用共享目录读取，辅助分组重读不进入首发屏障。导航取消立即结束 UI 等待，尚未确认的组织回调继续由原目录 owner 保留，确认后只执行一次；迟到结果不得重新打开详情。
分组手工移动提交节点/来源/锚点，Host 事务处理并广播刷新。`grouped/` 的嵌套 view 只做展示和当前手势预览，不恢复旧任务事实缓存或整表 applyOrder。吸顶浮层位于统一渐隐容器之外，Hash/收起全部操作挂在既有列表工具栏。关闭草稿行只从 Composer 草稿 owner 清除分组意图。

Composer 头部通过 `ProjectComposerMenu.showEditProject` 启用当前项目 Plus 编辑入口；`children` 放置分支等既有控件，顺序为项目、children、编辑按钮。当前项目解析仍由菜单持有。复用 ProjectEditor 与目录服务，在线且非 legacySingleRoot 才能编辑；Host/project 身份、会话或草稿切换使已打开编辑器失效。保存/删除仅刷新目录，不调用导航；其他选择器默认不启用入口。

设置项目管理行菜单同样复用 ProjectEditor，页面只保存 Host + projectId 键，当前项目与在线/解析状态从共享目录派生。离线、移除或 legacy 能力使旧编辑器失效；保存和编辑器内删除刷新目录，不导航。窄屏和触屏保留可点击的行菜单。

目录读取保留同一 Provider owner。只发送目录命令的 pane 使用 `useOptionalProjectDirectoryActions`，不订阅任务树；工作区选择器使用项目/设备切片。任务活动仍只广播给任务消费者，项目、设备和权限变化继续发布给相关选择器。

会话切换不属于项目内容的展示输入；侧栏不接收未使用的代码预览回调，文件操作只依赖实际导航字段。
新建补全 tab 分类不能重建项目操作；远端同步菜单只订阅 identity 到本地目录的映射，映射变更仍刷新目标。
单行读取同一 session store 中自身的选中布尔值，保持 workspace 身份隔离，不增加选中态副本。
导航状态变化不能传播到全部项目内容，真实文件回调和连接身份变化仍需生效。见 `docs/performance/ui-render-stability.md` 的 SPT08。
