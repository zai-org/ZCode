# 工作区独立面板布局

## 目标

桌面和宽屏 Web 保持侧栏，将原本共用外框的会话与 Side Pane 拆成独立面板；窗口根背景、侧栏保持原语义。

Workspace layout 的平台圆角：Windows 为 `rounded-md`（默认 6px），macOS Sequoia 及更早版本为 6px，Tahoe 26+ 为 12px，未知 macOS 版本暂用 6px；Linux 和 Web 为 `xl`（12px）。Windows 设置页同步使用 6px。

SPT-E2E-000 的圆角 token 验收区分 Side Pane 状态：展开时仅检查 Side Pane 外框的 `rounded-md` / `rounded-l-md`，会话外框通过 `--workspace-panel-radius` 保持独立面板圆角；收起后再检查会话外框的 chrome token。两种状态均检查实际计算圆角，避免把展开状态的动态变量误判为缺少 token。

## 平台外沿尺寸（2026-10-09，取代下文历史尺寸）

- Windows 工作区右侧、底部、顶部额外间隔和 Sidebar 收起后的左留白均为 6px；Linux 均保留 4px，主面板圆角保留 12px。
- Windows 设置页同步右侧、底部和顶部 6px 留白与 6px 圆角；导航与内容相接的左侧不增加间距。macOS、Web、手机保持现有规则。
- 新任务、会话、插件、Automations 复用共享工作区边界，终端和 Side Pane 同步圆角；对话与 Side Pane 之间为 3px 拖动热区，Sidebar 和 Terminal 保留 4px。
- 拖动指示线保留 2px、foreground-subtlest/50、沿边延伸及现有显隐规则。Sidebar 指示线端点按平台外沿留白加圆角内缩，Windows 为 12px，Linux 为 16px。
- SPT-E2E-000 验证平台尺寸、收起左留白和拖动，UP-00 验证设置页；平台函数单测覆盖 Linux、Windows 能力未知、普通和最大化窗口。

macOS 版本必须通过 `IPlatformService.getDesktopWindowChromeState` 查询并订阅窗口状态事件，再由 `useAppChromeState` 传入工作区圆角计算。此前 hook 排除了 macOS，导致所有 macOS 都走未知版本的 6px 分支；桌面各平台共用已有查询/事件 revision 防覆盖机制，Web 不查询桌面状态。回归测试须运行真实 hook，验证异步查询后的 Sequoia/Tahoe 圆角及订阅清理，不能只给半径函数注入版本。

```text
Window / Sidebar / transparent body layout
                  + conversation frame ---+ 3px + side frame --------+
                  | WorkspaceHeader       |     | Side Pane tab bar  |
                  | conversation          |     | preview/browser    |
                  +-----------------------+     |                    |
                  | 4px resize handle     |     |                    |
                  + terminal frame -------+     |                    |
                  | terminal (optional)   |     |                    |
                  +-----------------------+     +--------------------+
```

- 会话和底部终端各自使用独立的 `bg-background`、`rounded-xl`、`border-border` 外框，WorkspaceHeader 位于会话外框内部；终端关闭时，会话填满左列。
- macOS 窗口根背景使用 `bg-background-alt`；Windows、Linux 和 Web 继续使用 `bg-background-win-alt`。
- Side Pane 的 launcher/标签栏/内容共用独立 `bg-background` 外框，两个面板顶部底部对齐。
- 内部面板默认 `xl` 圆角、`border-border` 弱边框；贴 Windows 系统外沿的一侧继续遵循已有 native corner / maximized 规则。布局外框不计入内容圆角层级。
- 对话与 Side Pane 间保留 3px 透明间距，间距承载 resize handle；关闭 Side Pane 时不保留间距，会话恢复填满。
- 工作区 Sidebar、Terminal 保留 4px 透明拖拽热区，Side Pane 使用 3px，指示线宽 2px，使用第三层文字色 `foreground-subtlest/50`（在主题色基础上再降低至 50% 不透明度）。默认隐藏，hover、键盘聚焦和拖动时显示。指示线不使用 mask，竖线恢复沿面板高度延伸、横线恢复沿面板宽度延伸，两端按面板圆角内缩，端点圆润，拖拽、间距和手机隐藏规则不变。

- 保留 `workspace-body-layout`、`conversation-column`、`browser` 和会话/终端的现有持久化 key、最小宽度、拖动和显式关闭边界。Side Pane 不因开关或主视图切换卸载，Browser Guest 截图承载保持原路径。
- Windows/Linux 窗控属于最右侧 Header 的内联操作组：Side Pane 关闭时由 WorkspaceHeader 承载，打开时由 Side Header/空态顶部承载；不保留独立悬浮层和原生窗控占位。
- 桌面 Side Pane 标签栏的空白区域支持拖动窗口；标签与按钮排除窗口拖拽，保留标签排序、切换、关闭和菜单操作。Web 与手机覆盖面板不启用窗口拖拽区域。
- 收起时，WorkspaceHeader 显示展开按钮；展开时该按钮移至 Side Header 右侧，空态也保留同一收起入口。复用现有开关与快捷键，手机覆盖面板继续使用抽屉关闭入口。
- Side Header 标签总览、新增标签按钮和 tab item 统一使用 ghost 风格。Tab 默认与头部背景一致，hover 使用 `bg-hover`、选中使用 `bg-selected`，均不显示 outline 边框；关闭按钮绝对定位，不占标题空间、不叠加背景遮罩，拖动预览也不显示边框，保留键盘焦点提示。
- Tab 关闭按钮仅在选中、hover 或键盘焦点位于 tab 内时显示；隐藏时不接收鼠标点击；icon 和文字归入独立 item-content，溢出仅用 mask 淡出，不显示省略号；关闭按钮显示时仅将渐隐区域左移，内容宽度、位置不变。触屏用户先选中 tab，再操作关闭按钮。
- 选中 tab 在 hover 时继续保持 `bg-selected`，不切换为 `bg-hover`。
- WorkspaceHeader 与 Side Header 的分隔线使用 `border-border/50`；新任务草稿的 WorkspaceHeader 始终使用透明分隔线，包括展开 Side Pane 时。
- 已有任务的 WorkspaceHeader 在名称前显示 ghost 工作区图标按钮：本地为 Folder，云端/远端为 Cloud，沿用现有工作区身份判断。名称后的工作区胶囊和分支切换入口移除；hover、键盘聚焦或触屏点按图标时显示工作区名称（含现有远端主机标识）及当前分支。Detached HEAD 使用现有本地化文案，非 Git 工作区不显示分支。新任务草稿仍不显示此上下文入口。不修改工作区身份、连接、任务菜单和其他分支切换入口。
- WorkspaceHeader 工作区信息浮层复用 `ControlHintTooltip` 默认 2px offset 和 Tooltip 的 `rounded-lg` 圆角，不单独覆盖距离或圆角。
- Side Header 的 tab 列表使用 `gap-1`（4px），溢出宽度预算使用相同间距。
- 底部终端 tab 没有前置图标，左内边距使用 `pl-2`（8px）。
- 底部终端 tab 同样使用 ghost：选中背景 hover 不变，内容用 mask 淡出；关闭按钮参与普通 flex 布局，仅在选中、hover、focus-within 时显示，隐藏时保留占位，mask 不随显示状态左移。Tab 间距为 4px，宽度跟随内容，最大 144px，不设置固定宽度或最小宽度。「终端」标题保持原样，shell 名称使用普通辅助文字，不使用 pill 背景、圆角或内边距。
- 新任务、普通会话、插件、Automations 都使用同一主面板边界，不创建第二份业务状态。
- 手机远控保持单列/覆盖抽屉路径，无额外双面板间距；响应式收缩不能挤掉输入区或造成横向滚动。

- Windows 验证通过：SPT-E2E-000 `desktop-e2e-20261009070445229-p20968-57b667c6addfb7fa`；UP-00 `desktop-e2e-20261009070918592-p12424-e7971ff15e21066b`。65 项相关单测通过、1 项既有跳过；typecheck、typecheck:e2e、lint 和架构检查通过。Linux/macOS 真机、手机实际浏览器及插件/Automations 页面逐页视觉待补，已有平台和手机布局单测通过。

## 桌面拖动指示线颜色（2026-10-09）

Sidebar、Side Pane 和底部终端统一使用 `resize-handle` token：浅色主题 sky-500、深色主题 sky-400；覆盖 macOS、Windows、Linux 桌面端。Web 保留 foreground-subtlest/50，手机隐藏规则不变。保留 2px 粗细、圆润端点、沿边长度及 hover、键盘聚焦、拖动时显示，默认隐藏。Sidebar、Terminal 保留 4px 热区，Side Pane 为 3px；不改变拖动逻辑。SPT-E2E-000 在双主题验证三条指示线颜色、长度、显隐及实际拖动。

## 兼容边界

仅改变 React 布局与样式，无协议/服务/Host 改动。桌面 `desktop-continuous` 与手机 `web-remote-replayable` 的 attachment、恢复和 CommandInbox 边界保持不变；workspaceIdentity / remoteSessionId 原样透传。

## Linux 对齐 Windows（2026-09-04）

本节取代下文历史记录中 Linux 保持旧布局的约定。Linux 桌面使用与 Windows 相同的 4px 外层留白、四角 5px 完整边框、顶部工具组左侧 13px 和顶部 5px 偏移、Header 两侧 8px padding。普通和最大化窗口一致，Linux 不套用 Windows 10 原生外角例外。

Windows/Linux 复用同一内联窗控组件，28px 按钮、16px 图标、2px 间距，关闭 hover 为 destructive；收起时跟随 WorkspaceHeader 的 Side Pane 开关，展开时跟随 Side Header（含空态）。删除 Linux 旧悬浮窗控与 120px 占位，WorkspaceHeader 使用常规帮助入口，不保留独立下箭头。设置页窗控与 Windows 一样跟随菜单组。macOS、Web、手机布局不变；Linux 已有 frameless 和 DesktopCommand/状态事件继续复用。

验收沿用 SPT-E2E-000/007，Windows/Linux 均执行展开收起、布局尺寸和原生窗控操作断言；平台单测覆盖 Linux 与 Web/macOS 隔离。Windows 环境不能代替真实 Linux 窗口管理器验证，提交记录需明确待补项。

## 验收

- macOS Sequoia（15）及更早版本的工作区面板使用 6px 圆角；Tahoe（26）及更高版本使用 12px。版本未知先使用 6px。会话、Side Pane、底部 Terminal 共用该版本选择。Windows、Linux、Web 的现有半径不变。

- 设置页主内容面板在 Windows 使用 5px 圆角，与 Windows 主工作区一致；macOS 和 Linux 暂时保持既有 12px。圆角仅作用于有 4px 外层留白的内容面板，不改变窗口原生外沿。
- 设置页 Sidebar 比原尺寸增加 4px：紧凑宽度 68px，桌面宽度 268px。Sidebar 与主内容不额外增加间距，内容框左侧保持原有连接方式。

- 设置页在 Windows/Linux 移除独立 caption 下箭头，复用 macOS 的问号帮助入口；问号与内联窗控组成同一右侧操作组，窗控行为、关闭 hover 和 8px 右边距保持不变。macOS 继续使用原生窗控，Web 继续只显示问号。

- 设置页主内容框在 macOS、Windows、Linux 桌面统一使用 4px 外层 padding：保留左侧导航相邻边的既有 0px 间距，并以 4px 顶部拖拽留白承接内容面板；Web 不增加桌面外框留白。此项只统一大结构边距，不改变设置内容区自身 padding。

- Side Header 与 WorkspaceHeader 统一使用 8px 左右内边距：标签总览左侧、窗控操作组右侧及 launcher 空态一致，按钮尺寸与标签内部间距不变。
- 职业引导页的 Windows/Linux 窗控与 Workspace、Settings 对齐：48px 标题区域计入 4px 外层留白和 1px 边框，控件距窗口顶部 15px、右侧 13px。深浅主题及窗口尺寸变化时保持同一 CSS 几何；macOS 和手机 Web 不显示该组自绘窗控。

- Windows 自绘窗控采用普通 flex 布局，紧跟 Side Pane 开关，复用其 `icon-md` 尺寸、默认圆角和 2px 间距，关闭 hover 保持红色。Side Pane 收起时属于 WorkspaceHeader，展开时属于 Side Header（含 launcher 空态）；不使用绝对定位覆盖层，也不为它额外预留 native caption 空白。设置页窗控跟随其现有菜单操作组。

- Windows 主窗口与设置窗口采用应用自绘窗控：28px 按钮、16px 图标、5px 圆角、4px 间距，关闭 hover 使用 destructive 色。最大化显示还原图标，复用 DesktopCommand 与窗口状态事件。主窗口控件中心与 Header 对齐，原生 titleBarOverlay 不启用；缩放时自绘控件及预留使用 CSS 像素同步缩放。macOS/Linux 不变。Windows 原生最大化按钮 hover Snap Layout 菜单不属于自绘按钮能力。

- Windows Header 的终端/Side Pane 按钮采用与 macOS 相同的紧凑样式，不使用 Windows caption 的 48px 整高点击背景和零间距；系统最小化/最大化/关闭按钮预留仍独立保留。

- Windows 左侧顶部工具组使用 12px 水平 padding 加 1px 左 margin，实际左边距 13px，较原来右移 5px；纵向对齐与 Linux/macOS 定位不变。

- Windows 左侧顶部工具组整体偏移 4px 外层留白 + 1px 面板边框，与主工作区 48px Header 中心线对齐；侧栏展开/收起均适用，macOS/Linux/Web 原有定位不变。

- 移除 Windows Header 独立下箭头后，操作区恢复共享 `p-2`，右侧 padding 为 8px；不再保留为旧 caption 菜单设置的 `pr-0`。系统窗口按钮区域的预留独立保留。

- Windows WorkspaceHeader 与 macOS 共用常规操作区，移除终端右侧独立的 caption 下箭头菜单及分隔占位；保留标准帮助入口、系统窗口按钮预留。Linux 和设置页的菜单入口不变。

- Windows 普通窗口和最大化窗口的会话、终端、Side Pane 统一使用 `rounded-md`（6px）布局圆角和完整 1px 边框：面板有外层留白（尺寸以本文开头的平台规则为准），不再直接承担系统窗口外沿。能力未知时采用相同默认值；Windows 10 既有外侧直角规则暂保留，macOS 按版本使用 Sequoia 6px / Tahoe 12px。

- Windows 与 macOS 主工作区统一保留顶部、右侧、底部 4px 外层 padding；侧栏收起后左侧同样保留 4px。侧栏拖拽线端点同步计入这层留白。Linux、Web 和手机布局保持原有规则，Windows caption 控制区仍按原规则预留。

- 展开 Side Pane：Header 属于会话面板，两面板独立圆角与背景；顶部/底部差 <= 1px，面板间距 3px。
- 关闭 Side Pane：左面板恢复原宽度；反复展开不丢失 tab、终端内容或会话。

- 两种主题分别验证背景与边框；现有手机远控、Windows/Linux caption 单测通过。
- 执行相关单测、Electron E2E、typecheck、lint，记录无法完成的独立平台视觉验证。

## 验证结果

- 2026-09-10 恢复原长度：指示线沿面板边缘延伸、按圆角内缩，保留 foreground-subtlest/50，无 mask。Windows Electron SPT-E2E-000 首轮 hover 超时，同一构建复测通过（`desktop-e2e-20260910-034045-447`）；覆盖长度、亮暗主题和拖拽。typecheck、typecheck:e2e、lint 通过（44 个既有警告）。其他平台未实机复测。

- 2026-09-10 固定长度 handle：指示线改为居中 48px，保留 2px 粗细和 foreground-subtlest/50，移除 mask。Windows Electron SPT-E2E-000 验证亮暗主题下固定长度、无 mask、显隐与真实拖拽通过（`desktop-e2e-20260910-033653-782`）；typecheck、typecheck:e2e、lint 通过（44 个既有警告）。其他平台未实机复测。

- 2026-09-10 渐隐线降为 foreground-subtlest/50：Windows Electron SPT-E2E-000 最终通过（`desktop-e2e-20260910-033454-339`）。首轮修正参照节点缺少 Tailwind utility 的测试误报，次轮 hover 超时，同一构建复跑通过。typecheck、typecheck:e2e、lint 通过（44 个既有警告），其他平台未实机复测。

- 2026-09-10 渐隐线改用第三层颜色 foreground-subtlest：Windows Electron SPT-E2E-000 通过，运行 ID `desktop-e2e-20260910-032826-700`；typecheck、typecheck:e2e、lint 通过（44 个既有警告）。渐隐、拖拽与显隐行为不变；其他平台未实机复测。

- 2026-09-10 次要颜色渐隐线：Windows Electron SPT-E2E-000 通过，覆盖三个 handle 的次要色、渐变 mask、默认隐藏、hover/拖动态显示、真实拖拽及亮暗主题。运行 ID `desktop-e2e-20260910-032455-191`。17 项单测通过、1 项既有跳过；typecheck、typecheck:e2e、lint 通过（44 个既有警告）。macOS/Linux、手机实机未复测。

- 2026-09-10 移除 handle 指示线：Windows Electron SPT-E2E-000 通过，三个透明热区的 hover、拖动态与亮暗主题均无指示线，真实尺寸调整仍有效。17 项相关单测通过、1 项既有跳过；typecheck、typecheck:e2e、lint 通过（44 个既有警告）。macOS/Linux 和手机实机未复测。

- 2026-09-10 handle sky 配色：浅色 sky-500、深色 sky-400，不额外降低透明度。Windows Electron SPT-E2E-000 通过，覆盖三个 handle 的尺寸、真实拖拽及亮暗色断言；运行 ID `desktop-e2e-20260910-031310-945`。16 项相关单测、typecheck、typecheck:e2e、lint 通过（44 个既有警告）。macOS/Linux 和手机实机未复测。

- 2026-09-10 Sequoia 圆角修复：20 项版本识别及半径单测通过；typecheck、typecheck:e2e、lint 通过（44 个已有警告）。Windows Electron 首轮 6/8（标签 hover、最小化时序失败），同一 renderer 构建复测 8/8，运行 ID `desktop-e2e-20260910-030905-004`。Sequoia/Tahoe 原生窗口外观仍需 macOS 实机验证。

- 2026-09-10 handle 第三层文字色：Windows Electron SPT-E2E-000～007 共 8/8 通过，覆盖三个 handle 的拖拽与 Zai 浅色/深色颜色；相关单测 14 通过、1 既有跳过。typecheck、typecheck:e2e、lint 通过（46 个既有警告）。macOS/Linux 和手机实机未运行，修改仅涉及共享指示线颜色，手机隐藏规则不变。

- 2026-09-07 E2E 补齐：三个 handle 均验证 4px 热区、2px `bg-foreground` 指示线、默认隐藏、hover/拖动态显示与真实尺寸变化；同时验证设置页 Sidebar 桌面宽度 268px。测试发现并修复 Terminal 指针离开热区后拖动态指示线消失的问题。Workspace E2E 7/7、Settings E2E 5/5、相关单测 47/47 通过；运行 ID 分别为 `desktop-e2e-20260907065558567-p30371-3b85b0c85fbbae83`、`desktop-e2e-20260907065702167-p33040-7fa462d329a4436b`。
- 2026-09-07 Windows 设置页圆角对齐：主内容面板使用 5px，macOS/Linux 保持 12px。14 项相关单测、4 项 Windows Electron 设置页 E2E、typecheck、lint 通过（44 个已有警告、0 错误）；E2E 运行 ID `desktop-e2e-20260907034259243-p15484-0c781c55b70b3943`。

- 2026-09-07 设置页 caption 入口对齐：Windows/Linux 删除旧下箭头和 native overlay 动态占位，复用 macOS 问号帮助入口并与三个内联窗控组成 134px 操作区。15 项相关单测、4 项 Windows Electron 设置页 E2E、typecheck、lint 通过（44 个已有警告、0 错误）；E2E 运行 ID `desktop-e2e-20260907033146942-p24568-0c3e36ba64f67d99`。

- 2026-09-07 设置页桌面外框对齐：macOS、Windows、Linux 主内容框统一使用 4px 外层 padding，Web 保持 0px；22 项相关单测、typecheck、lint 通过（41 个已有警告、0 错误）。当前环境未独立执行 Linux/macOS 视觉验证。

- 2026-09-04 Linux 对齐 Windows：60 项相关单测通过；Windows Electron 8 项交互回归通过，运行 ID `desktop-e2e-20260904131942845-p10384-c7851f1c1af7bbc7`，涵盖共享窗控真实 minimize/close、最大化/还原及面板展开收起。typecheck、lint 通过（41 个已有警告、0 错误）。Linux 分支已纳入相同 E2E 断言，当前 Windows 环境未执行真实 Linux/X11/Wayland 窗口管理器验证；macOS 与手机未独立视觉复测。

- 2026-09-04 Windows 内联自绘窗控：8 项 Windows Electron E2E 通过，覆盖展开/收起后的归属和相邻 2px 间距、28px 尺寸、最大化/还原图标、真实 minimize/close 事件及原有面板交互。运行 ID `desktop-e2e-20260904125135324-p11372-6864a58ebc85a27d`。相关单测、typecheck、lint 通过（41 个已有警告）。Windows 原生 hover Snap Layout 未实现；macOS/Linux/手机保持原路径，未独立视觉复测。旧窗口需重启才能应用 frameless 创建参数。

- 2026-09-04 Windows 布局圆角最终调整为 5px：CDP 实测四角均为 5px；28 项单测、7 项 Windows Electron E2E、typecheck、lint 通过（41 个已有警告）。

- 2026-09-04 Windows Header 按钮恢复 macOS 紧凑样式：CDP 实测终端和 Side Pane 开关高度均为 28px；10 项 Header 单测、7 项 Windows Electron E2E、typecheck、lint 通过（41 个已有警告）。

- 2026-09-04 Windows 顶部工具组对齐：CDP 实测调整前左右中心为 24px/29px，调整后均为 29px；3 项相关单测、7 项 Windows Electron E2E、typecheck、lint 通过（41 个已有警告）。

- 2026-09-04 Windows Header 右边距修复：移除旧 `pr-0`，CDP 实测由 0px 恢复至 8px；10 项 Header 单测、7 项 Windows Electron E2E、typecheck、lint 通过（41 个已有警告）。

- 2026-09-04 Windows Header 移除独立下箭头：运行时确认只保留常规帮助和终端操作；33 项相关单测、7 项 Windows Electron E2E、typecheck 和 lint 通过（41 个已有警告）。

- 2026-09-04 最大化 Side Pane 修复：运行时确认旧样式为 0px 圆角、仅左侧 1px 边框；修复后四角 6px、四边 1px。28 项单测、typecheck、lint 通过；包含真实 maximize/unmaximize 的 Windows Electron E2E 7/7 通过，运行 ID `desktop-e2e-20260904121343959-p7064-eb22b5d3fbfec48a`。

- 2026-09-04 Windows 布局圆角统一 `rounded-md`：28 项单测、typecheck、lint 通过（41 个已有警告）；CDP 实测会话与 Side Pane 四角均为 6px。Windows Electron E2E 首次 6/7，Tooltip 延时断言失败，复用相同构建重跑 7/7 通过；布局圆角断言两次均通过。macOS、Linux 和手机未进行本次独立视觉复测。

- 2026-09-04 Windows 外层 padding 对齐 macOS：23 项布局单测、7 项 Windows Electron E2E、`pnpm typecheck`、`pnpm lint` 通过（41 个已有警告）。CDP 实测主面板顶部 4px，content 右/底 padding 均为 4px。E2E 运行 ID：`desktop-e2e-20260904120237923-p17680-a5f5b3aeaa873805`。macOS、Linux、手机未进行本次独立视觉复测。

- 2026-09-04 终端独立外框：39 项相关单测、7 项 Electron E2E、typecheck 与 lint 通过；E2E 验证终端位于会话框外、同属左列、间距 4px，以及三面板深浅主题背景一致。运行 ID：`desktop-e2e-20260904104922835-p29510-089fd6229a80617c`。Windows 原生边缘逻辑保留，Windows/Linux 和手机独立视觉验证待补。
- 2026-09-04：相关 8 个单测文件，51 项通过、1 项已有跳过。新增 Header 归属与控制区预留用例先失败后通过。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint` 通过；Lint 41 个已有警告、0 错误。
- macOS Electron 最终 4px 版本：7/7 通过；运行 ID `desktop-e2e-20260904084050358-p6937-68e000533efda13e`。
- 运行时验证包含：4px 间距、上下对齐、双 xl 外框、Header 归属、真实指针拖动改变宽度、底部终端独立外框、关闭后宽度恢复、标签栏开关与缩放交互，以及浅色/深色背景一致性。两种主题截图已检查。
- Windows/Linux caption 和手机远控路径有单测覆盖，尚未执行这些平台的独立视觉 E2E；截图中的透明窗口底层不等同于操作系统最终合成的 vibrancy 材质。

## 当前会话最近活动

信息浮层的名称/路径下方显示时钟图标与“最近活动 2 分钟前”（英文 Last active 2 minutes ago），替代工作区 tasks/active 统计。使用当前会话 meta 的实时 activity.lastActivityAt，缺失时读取 updatedAt；时间未知时不显示。打开浮层期间每分钟刷新相对时间，关闭后清理计时器。删除原统计组件与列表查询；不新增服务、协议或持久化。

## 工作区信息排版

工作区图标与名称同行，名称下方显示路径并与名称左边缘对齐。路径使用次级前景与 text-ui-sm；只有属于当前工作区所在主机的 home 目录时缩写为 `~`，未取得 home 时显示原路径。下方显示当前会话最近活动，分支前增加 border-border/50 分隔线；非 Git 工作区不显示分支或分隔线。

排版验证：相关单测 7/7、macOS Electron TTL01–TTL07 7/7，路径实测 `~/ZCodeProject`；typecheck、lint 通过（46 个已有警告）。运行记录：`desktop-e2e-20260907080616432-p60066-d11800800bd11757`。

- 2026-09-10 MR !2586 CR-01：修复 macOS 窗口状态查询被 hook 守卫跳过。新增两条真实 hook 回归先失败后通过；26 项相关单测、typecheck、lint（44 个既有警告、0 错误）通过。Windows Electron SPT-E2E-000 通过，运行 ID desktop-e2e-20260910-040930-907。macOS 原生视觉与手机实机未验证。

- Workspace Sidebar 底部 footer 左内边距保持 16px（`pl-4`），右内边距为 12px（`pr-3`）；上下内边距不变。此覆盖仅由 Workspace 调用方传入，Settings 复用的 footer 保持默认左右 16px（`px-4`）。

2026-10-09 圆角补正：Windows 工作区及设置页统一为 6px，保留 6px 外沿留白，Sidebar 指示线端点为 12px。50 项相关单测通过；Windows SPT-E2E-000 run desktop-e2e-20261009071323579-p14952-58feeab7544382d9 和 UP-00 run desktop-e2e-20261009071448683-p19548-4169d17082d86dfb 均通过。typecheck、typecheck:e2e、lint 和架构检查通过。

2026-10-09 指示线颜色验证：Windows 双主题 SPT-E2E-000 通过（desktop-e2e-20261009071748019-p456-09549c1404406786），39 项相关单测、typecheck、typecheck:e2e、lint 与架构检查通过；Linux/macOS 真机待补。

## 平台圆角 token（2026-10-12）

Windows 和旧版本 macOS 的 6px 面板圆角使用 `rounded-md`，Windows 非原生圆角路径的左侧使用 `rounded-l-md`。设置页复用同一 token。保留平台半径计算中的 6px、拖动指示线内缩和其他平台半径；桌面与手机布局、交互不变。Logo 底座沿用现有 `rounded`。单测验证 token 选择，E2E 同时验证平台 class 与计算后的圆角。

验证记录：44 项相关单测通过；typecheck、typecheck:e2e、lint（0 errors）及架构检查通过。macOS SPT-E2E-000 尝试在 ChromeDriver 下载阶段因代理证书校验失败退出，0 项用例执行；Windows/Linux 真机与手机浏览器未执行。本次不改变平台半径计算或布局事件。

窗控回归边界：OccupationOnboarding 全屏引导继续使用 4px 顶部/右侧偏移；设置页的独立面板按 Windows 6px、Linux 4px 外沿留白定位窗控。两者保持相同的 1px 边框补偿、48px 高度和 8px 横向内边距。旧测试误把两种容器的偏移强制相等，改为分别检查各自偏移与共享尺寸，不改变界面。

## 2026-10-29 Side Pane 间距调整

对话面板与 Side Pane 之间的竖向分隔区域由 2px 调整为 3px，让两个面板之间保留稍多留白。当前尺寸以本文上方布局规则为准；Sidebar 和底部 Terminal 的分隔尺寸不变。Side Pane 关闭或全屏时不保留此间距，手机堆叠布局继续隐藏该拖动条。

Side Pane 的 2px 指示线固定距拖动条左边 1px，避免 3px 容器内居中引入半像素偏移。SPT-E2E-000 宽度断言同步为 3px；本次未重新运行该 E2E，旧运行记录不代表新断言已验证。
