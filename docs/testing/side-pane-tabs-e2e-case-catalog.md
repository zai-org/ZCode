# Side Pane Tabs E2E Case Catalog

## 范围

本文记录 Side Pane Tab strip 的响应式宽度、溢出、操作按钮和标题 Tooltip 的桌面端 UI E2E 语义。该能力属于 UI shell presentation，不依赖 Agent、provider fixture、session realtime 或持久化恢复。

## 状态维度与剪枝

| 维度          | 等价类                                                       | 决策                                                                                  |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 可用宽度      | 可容纳 156px / 需要在 156px 与 60px 间收缩 / 60px 仍无法容纳 | 三类均覆盖                                                                            |
| Tab 类型      | Browser / Terminal / Diff / Code Viewer / session-scoped tab | 使用可重复创建的 Terminal 代表共享 `SidePaneTabTrigger`；类型专属内容不在本组重复覆盖 |
| Tab 状态      | active / inactive                                            | 关闭按钮 case 同时覆盖                                                                |
| Tooltip hover | 未满 1500ms / 满 1500ms / 跨 Tab                             | 三类均覆盖                                                                            |
| 客户端        | Desktop / mobile Web touch                                   | Desktop 覆盖；触屏不依赖 hover，剪枝 Tooltip；移动布局由组件级响应式测试覆盖          |
| 鼠标中键      | active / inactive tab                                        | Desktop 覆盖；中键关闭不激活目标 tab，并阻止浏览器默认中键滚动                        |
| 其他交互      | 拖拽、右键、标签总览                                         | 不属于本次改动，使用既有组件测试，不在本组重复覆盖                                    |

## 接受的 Case

### STF05–07 富内容会话的侧栏动画性能

接受 [布局开销规格](../performance/sidebar-toggle-rendering.md) 的真实长会话、表格跟随、锚点及交替生产构建对照。新增候选保持 manual-review/pending；合成回归与真实会话性能证据必须分开标注。表格专属交互复用既有 Markdown table layout/enhanced-scroll E2E。

### DGJ01–03 草稿标题适配与输入框稳定

接受 [问候语规格](../ui/chat-empty-time-greeting.md#回归验收) 中的 DGJ01–03。真实桌面回归检查右侧面板开关、拖动时的中间布局；共享组件浏览器验收补充连续宽度、快速反向、语言切换和手机紧凑模式。只改变布局，不请求模型。候选保留 manual-review/pending。

### SPT-E2E-000 独立面板平台圆角与拖动指示线

- Setup：桌面新任务草稿，展开 Side Pane 和底部 Terminal，分别使用亮暗主题。
- Action：等待平台状态和布局就绪，hover 并拖动 Sidebar、Side Pane、Terminal 手柄。
- Assertions：Windows 5px，Sequoia 及更早 macOS 6px，Tahoe 26+ 12px，Linux 12px；三处热区保持 4px，指示线为沿边 2px foreground-subtlest/50、无 mask，默认隐藏且 hover/拖动可见，尺寸真实变化。
- 数据链路补充：useAppChromeStateAutoUpdate.test.ts 运行真实 hook，以平台异步查询返回 macOS 15/26，验证半径与订阅清理；用于在非 macOS CI 中捕获 macOS 查询被守卫跳过的问题。不能替代 macOS 原生视觉验收。

### SPT-E2E-001 默认宽度与跟随加号

- Setup：桌面窗口打开 Side Pane，仅创建一个 Terminal tab，空间足以容纳默认宽度。
- Action：观察 tab strip。
- Assertions：Tab 宽度为 156px（允许亚像素误差）；横向 viewport 无溢出；新增按钮位于滚动内容内并紧跟最后一个 Tab。

### SPT-E2E-002 等宽收缩但不滚动

- Setup：创建三个 Terminal tabs，把窗口调整到需要收缩但仍能让每个 Tab 大于 60px 的宽度。
- Action：等待 ResizeObserver 完成布局。
- Assertions：所有 Tab 宽度相等；宽度处于 `[60px, 156px)`；横向 viewport 无溢出；新增按钮仍位于滚动内容内。

### SPT-E2E-003 达到最小宽度后滚动

- Setup：继续创建 Terminal tabs，使 60px 最小宽度之和超过可用空间。
- Action：等待溢出状态更新。
- Assertions：所有 Tab 不小于 60px；viewport 的 `scrollWidth > clientWidth`；新增按钮移到 viewport 外、固定在右侧操作区。

### SPT-E2E-004 选中或 hover 时显示关闭按钮且不激活

- Setup：至少两个 Tab，第二个为 active，第一个为 inactive。
- Action：移开鼠标并清除焦点，检查关闭按钮可见性；hover inactive Tab 后点击其关闭按钮。
- Assertions：active Tab 的关闭按钮可见；inactive Tab 未 hover 时隐藏、hover 后可见；inactive Tab 被关闭；原 active Tab 保持 active。

### SPT-E2E-005 Tooltip 独立等待 1500ms

- Setup：至少两个 Tab。
- Action：hover 第一个 Tab 不满 1500ms，移到第二个 Tab，再等待到第二个 Tab 自己满 1500ms。
- Assertions：第一个等待窗口内不显示 Tooltip；跨 Tab 后不会继承已等待时长；第二个 Tab 满 1500ms 后显示包含完整标题的 Tooltip。

### SPT-E2E-006 鼠标中键关闭且不激活

- Setup：至少两个 Tab，第二个为 active，第一个为 inactive。
- Action：在 inactive Tab 的标签主体上派发鼠标中键（`button=1`）事件。
- Assertions：inactive Tab 被关闭；原 active Tab 保持 active；事件默认行为被阻止，且不会触发标签激活。

### SPT-E2E-007 插件面板的空态与新标签页双入口

- Setup：真实 `AnimatedSidePanePanel`、插件发现 hook 与打开动作；fixture 通过 `activateNewTabSidePane` 和统一归属函数创建并激活标签。推荐名单收录两个 surface，另一个开发 surface 不推荐；覆盖 1200px/en-US/亮色与 390px/zh-CN/暗色。
- Action：从首次展开的默认 new-tab launcher 打开插件，再点击「+」创建 new-tab，从 active tabpanel 的 launcher 重复打开同一插件；新建另一个标签，使用 Tab/Enter 打开第二个插件。
- Assertions：两入口展示相同推荐与本地化标题；请求保留工作区/会话字段，重复打开复用 plugin tab；安装、启用后必须另点打开。草稿会话隐藏整个应用插件区及分隔线、查看所有插件入口；已有会话从默认空态或显式新标签页进入市场均可返回来源，默认空态返回后保持面板展开。无宿主、无 bridge 无插件项；推荐为空或配置失败显示空态；冷加载显示 skeleton。新标签页保持可见，窄屏无横向溢出。
- 操作进度回归：控制安装/启用响应，确认只有目标插件显示加载并禁用，其他插件保留原文案与可点击状态。连续提交两个不同插件安装，各自保留进度；一个失败或成功只清理自身，已启用插件仍可打开。同一插件重复点击只提交一次，失败可重试，成功不自动打开。覆盖空态与新标签页、桌面亮色英文与手机暗色中文。
- 加载图标回归：等待响应期间，目标入口显示可见的旋转图标与 `aria-busy`；成功或失败后全部清除。同一插件的两个 surface 同步显示进度，其他插件无进度；减少动画偏好下图标保留但不旋转。
- 推荐展示回归：混合安装态时已安装优先，暂停插件仍置前且组内稳定；安装完成后刷新排序。社区标签位于描述前，仅标识官方市场的社区条目，个人来源自声明不显示；覆盖桌面英文亮色与窄屏中文暗色。
- 边界：服务由浏览器 fixture 注入，在 plugin tab owner 边界检查请求，不启动沙箱、Agent 或真实手机远控。
- 当前验证：2026-10-19 自动浏览器 E2E 16/16 通过，含 4 组并发安装与操作互不阻塞、8 组操作进度，以及同插件多 surface / 减少动画偏好回归。夹具按当前面板 owner 初始化默认 new-tab；仍为 manual-review/pending，不代表真实 Agent 安装、插件沙箱或手机远控验证。

### SPT-E2E-008 对话隔离的关闭与恢复（manual-review/pending）

- Setup：同一工作区的 A/B 两个对话各有 Browser 和站点权限设置 tab。
- Action：B 关闭其他、关闭全部；切回 A 检查保留，再关闭 A 的设置 tab；切 B 检查最近关闭，再切回 A 重新打开。
- Assertions：B 的关闭不删除 A 的隐藏 tab；最近关闭仅显示当前 owner 的记录；A 重新打开恢复原设置 tab；Browser main 关闭与 UI 一致。
- 证据：真实 Electron 菜单/标签/设置页面与 renderer 日志。不请求模型，不改网页权限决策，不需要 provider fixture。自动通过仍保持人工 review pending。
- 单测补充：同路径不同 workspaceIdentity、公共/对话/草稿 tab、各 intrinsic owner 类型、无可见标签、异步关闭等待中切换工作区/对话或打开新 tab、main 拒绝关闭。

## 不变量

左右侧栏开关性能的 STF01–04 accepted 场景见 [布局开销规格](../performance/sidebar-toggle-rendering.md)。必须验证左右两侧展开和收起的真实尺寸动画、快速反向、减少动画偏好、拖动 / 窗口 resize 及输入框防抖；禁止用尺寸瞬切或仅裁剪代替。使用真实 shell、保留标签和合成重内容负载；不请求模型。候选保留 manual-review/pending，性能数据与行为断言分别记录。

- `+` 不参与 Tab 等宽计算。
- 滚动只能发生在所有 Tab 已达到 60px 下限之后。
- 关闭按钮点击不得触发 Tab 激活或拖拽。
- 鼠标中键关闭不得先激活目标 Tab，也不得触发浏览器默认中键滚动。
- Tooltip 的定时状态不得改变 Tab 的 flex shrink 行为。
- 本组测试不得启动模型请求或依赖 provider replay fixture。

## 通用 / 编程界面模式 M1

范围与 MODE-01～07 用例见 [模式验证矩阵](general-coding-mode-verification.md)。新增桌面用例位于 `packages/desktop/test/e2e/ui-shell/navigation/general-coding-mode.test.ts`，覆盖设置偏好、入口隐藏和已有面板保留；已人工验收并转为 ui-shell 正式用例，尚未加入 Docker preset。对话展示由组件单测补充，验证状态以该矩阵为准。

### 新标签页多开与标准标签行为

- Setup：打开一个 Terminal 标签。
- Action：连续点击两次「+」，选择第一个新标签页，再分别关闭两个新标签页。
- Assert：两个 id 独立、最新页激活、标题为新标签页、宽度不超过 156px；旧页可重新聚焦并显示启动入口，关闭仅移除目标标签。
- 入口调整：原加号菜单选择改为新标签页内的启动行，仍使用既有应用打开动作。

### SPT-E2E-009 默认新标签页与工具替换

- Setup：新任务草稿，无当前 scope 标签。
- Action：展开、选择终端、收起再展开、点击加号、关闭新增标签及最后一个工具标签。
- Assertions：首次恰有一个新标签页及加号；终端替换该标签；收起恢复保留原 id；加号独立新增；关闭最后一个标签后面板收起；再次展开创建新标签页。
- 范围：桌面交互及共享 UI 状态，跨 scope 和异步关闭由 hook 回归补充。

SPT-E2E-009 补充：末标签关闭后面板收起且无补建；重新展开创建新标签页。真实关闭菜单命令关闭唯一新标签页后，下一次关闭上下文事件不被 App 拦截，可进入关窗 fallback。

## 完整视图（SPFV，spec：`docs/ui/side-pane-full-view.md`）

### 状态维度与剪枝

| 维度     | 等价类                               | 决策                                                                 |
| -------- | ------------------------------------ | -------------------------------------------------------------------- |
| 入口     | 按钮 / 快捷键                        | 两者都覆盖进入与退出                                                 |
| surface  | 对话 tab / 面板 tab / 无可见面板 tab | 前两类覆盖；无可见 tab 时启动页由组件逻辑承接，不单独覆盖            |
| 浮窗形态 | 收起 / 收起 + 操作栏 / 展开 / 最小化 | 全部覆盖                                                             |
| 退出方式 | 按钮 / 快捷键 / ◫ / 关闭最后一个 tab | 前三类覆盖；关闭最后一个 tab 复用既有收起逻辑，由 owner 记忆单测覆盖 |
| owner    | 同 session 切回 / 不同 session       | 由 provider 用例覆盖                                                 |
| 阻塞交互 | 收起态出现 / 最小化时出现            | 最小化时出现覆盖（同时证明卡片在浮窗内）                             |
| 客户端   | 桌面 / Web / 手机远控                | 只做桌面；Web 与远控不渲染入口，由组件条件单测覆盖                   |

### SPFV-E2E-001 进入、退出与单实例

- Setup：桌面草稿，打开 Side Pane 并新建一个 Terminal tab；给主 SessionPane 根节点打上 DOM 标记。
- Action：点「进入完整视图」；再用快捷键退出；再点按钮进入。
- Assertions：完整视图中左侧任务列表宽度不变、左上角按钮组仍在、WorkspaceHeader 不存在、Side Pane 外框宽度接近 `#content` 宽度；tab 栏第一个为对话 tab，且计算样式 `-webkit-app-region` 为 `no-drag`（真实鼠标可点击）；退出后侧栏和面板宽度回到进入前；全过程 SessionPane 根节点仍带同一 DOM 标记（未重新挂载）。

### SPFV-E2E-002 对话 tab 全宽与面板 tab 浮窗

- Setup：接 001，完整视图中当前为 Terminal tab。
- Action：点对话 tab；再点 Terminal tab。
- 动画断言：切回面板 tab 的首个浮窗绘制帧已在最终位置与尺寸，宿主不产生 `left/top/width/height` 过渡；不得只等待动画结束后检查终态。
- Assertions：对话 tab 激活时对话宿主覆盖 slot（误差 2px 内），浮窗不存在，输入框为两行布局（`data-composer-layout=stacked`）且有草稿项目栏；回到 Terminal tab 后浮窗出现在 slot 右下角（距边 16px），只露出输入区：输入区与浮窗同宽、底边对齐，没有外层留白，抽屉不可见；输入框为单行（`data-composer-layout=inline`，浮窗高度不超过 64px，「+」、输入区、发送按钮从左到右排在同一行、垂直居中误差 2px 内，输入区至少占一半宽度），没有草稿项目栏；切换前打在输入框节点上的 DOM 标记仍在（编辑器未重新挂载）。

### SPFV-E2E-003 操作栏、最小化与恢复

- Setup：接 002，浮窗收起态。
- Action：点击浮窗输入框并输入文字；点击面板空白处；再聚焦输入框后点「−」；点击圆形按钮。
- Assertions：输入框有焦点时抽屉滑出、操作栏可见且不含标题（空闲时也没有 loading），抽屉一直延伸到输入框底边（底边误差 1.5px 内，两侧没有凹口）；失焦后隐藏；「−」后只剩圆形按钮；点击后恢复收起态并且输入框获得焦点、文字仍在；切到对话 tab 后主输入框显示同一段文字。

### SPFV-E2E-004 拖动吸附与菜单

- Setup：接 003，浮窗收起态。
- Action：拖动 ⠿ 到 slot 左上区域松手；点击 ⠿ 打开菜单，选「在完整视图中打开」。
- 动画断言：拖动松手后的吸附仍产生位置过渡，最终准确落到吸附点。
- Assertions：松手后浮窗贴 slot 左上（16px）；全局偏好 `zcode:side-pane-full-view:floating-anchor` 写为 `top-left`；菜单项选择后切到对话 tab，且浮窗展开态不被菜单点击改变（回归：portal 事件沿 React 树冒泡）。

### SPFV-MODEL-001 浮窗模型菜单关闭（pending）

- Setup：完整视图浮窗，背后为独立插件页面；有两个可用模型及一个锁定模型。
- Action：打开模型菜单后点击插件区域；再次打开并选择模型（包括当前模型和键盘确认），再点击外侧关闭；调档和切换 Provider；Escape 关闭。
- Assertions：一次外侧点击关闭菜单，且不触发底层插件操作；可用模型被选择后选择生效、菜单保持打开，锁定模型不关闭；调档与 Provider 导航保持打开；选模型后仍可点击外侧一次关闭，关闭后插件仍可交互。桌面 Electron 使用真实 webview，浏览器手机宽度使用独立 iframe，覆盖深浅主题。
- 候选自动化：`packages/ui/test/browser/manual-review/pending/composer-menu-dismiss.test.mjs`；配合既有 `ui-shell/panels/side-pane-full-view.test.ts` 验证完整 App 的浮窗行为。组件级夹具不覆盖插件安装、Agent 握手和远控连接。

### SPFV-E2E-005 展开与收起消息流

- Setup：浮窗收起 + 操作栏。
- Action：点「⌃」按钮；再点「⌄」按钮。
- 动画断言：展开与收起均保留宿主高度过渡。
- Assertions：展开后浮窗高度大于 400px 且时间线可见，按钮 `aria-expanded=true`；消息滚动容器底边在输入区顶边之上至少 8px（滚动条不延伸到输入框后面）；再点回到收起态。

### SPFV-E2E-009 插件页面层不被面板外框遮挡

- Setup：接 005，完整视图浮窗形态，当前为 Terminal tab。
- Action：按 `pluginUiPagePlane` 的同一套样式，在 `body` 末尾的停靠层（`[data-sandbox-page-parking]`，`position:fixed; inset:0`，无 z-index）放入一个 `position:fixed; z-index:10`、覆盖 slot 的页面节点；在 slot 右下区域取 `elementFromPoint`。
- Assertions：命中该页面节点，不是面板外框内的元素（回归：外框 `z-10` 遮住插件 UI，插件 tab 空白）。

### SPFV-E2E-006 面板开关退出

- Setup：完整视图。
- Action：点面板开关 ◫；再点 WorkspaceHeader 上的面板开关重新打开。
- Assertions：关闭后回到普通布局；重新打开后仍是普通视图（不回到完整视图）。

### SPFV-E2E-007 浮窗发送与按 session 记忆（provider）

- Setup：已有会话 A（首条消息完成），打开 Terminal tab，进入完整视图。
- Action：在浮窗输入框发送一条消息；完整视图下用命令面板（⌘K → New task）新建草稿；在左侧任务列表切回 A。
- Assertions：消息出现在 A 的时间线并收到回复；回答结束后浮窗上方弹出回答气泡，只含回答正文（无图标、无标题）；草稿为普通视图；切回 A 后恢复完整视图与浮窗，气泡仍在（只有 × 或点击才消失）；点气泡后浮窗展开、气泡消失，收起后不再出现（回归：切换会话不出现 React #185，面板不停在收起态）。

### SPFV-E2E-008 最小化时出现 AskUserQuestion（provider）

- Setup：接 007，会话 A 在完整视图，当前为 Terminal tab。
- Action：在浮窗发送触发 AskUserQuestion 的提示（回放延迟 4s），用户消息出现后立即最小化，等待问答请求。
- Assertions：用户消息出现后（问答请求到达前，对话运行中）操作栏「⌃ / ⌄」右侧显示 loading，输入框占位文字为「工作中 N 秒」/ `Working for …`，使用整秒摘要且运行中顶部没有折叠入口（消息流底部计时单独保留十分之一秒）；浮窗自动恢复为收起态，问答卡片显示在浮窗内；提交回答后卡片消失、输入框恢复；回答结束弹出新气泡（`spfv-ask-done`），点 × 后气泡消失、浮窗保持收起；对话空闲后聚焦浮窗，操作栏可见但没有 loading。

### 不变量

- 完整视图切换不得重新挂载 SessionPane，不得写入面板占比或侧栏宽度持久化。
- 浮窗与对话 tab 共用同一份草稿。
- 面板 tab 的 webview / 终端实例在 surface 切换时保持挂载。
