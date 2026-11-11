# Side Pane Tabs E2E Coverage Matrix

2026-11-10：DGJ01、STF01–04 与 STF05/06/07 对应的三份桌面文件已人工复核并转正，
独立夹具和默认回放均通过，逐文件产物见[转正清单](e2e-business-scenarios.md#2026-11-10-人工复核与转正回放)。
此轮使用既有确定性夹具，不新增真实用户会话性能或 Windows/Linux/手机实机证据；未新增 CI preset。
下方日期较早的 pending 描述保留为历史，浏览器独立脚本的状态不变。

## STF05–07 富内容性能回归（2026-11-05）

候选 `ui-shell/navigation/sidebar-rich-content-performance.test.ts` 保持 manual-review/pending，未提升 CI admission。从真实持久化历史加载含 7 张表格的会话，检查原尺寸动画、DOM 保留、底部跟随与离底阅读；快速反向结束后宽度及 scrollTop 回到原位置。生产构建 A/B 记录与边界见 [性能规格](../performance/sidebar-toggle-rendering.md)。旧 STF03 的附加纯文字负载不能覆盖此项。

- 最终 macOS Electron 生产构建回归：`desktop-e2e-20261105121330831-p40674-d34fa80c92a43cf5`，6 个 spec、33 条通过、1 条 Windows 条件跳过。包括表格布局 6 条、增强滚动 7 条、侧栏性能 2 条、问候语 1 条、标签/拖动 10 条与完整视图 7 条。输入框防跳动的深浅主题 × 中英文断言继续通过。
- 默认合成夹具入口：`desktop-e2e-20261105122829920-p93767-4daffdef1faa7d67`，2/2 通过，直接断言实际宽度变化次数；真实 A/B 的各轮采样也通过相同几何条件。合成结果只用于重复回归，不进入真实会话性能对照。
- 共享组件浏览器回归：`sidebar-rich-browser-20261105/browser.log`，70/70 通过。覆盖桌面/窄屏、深浅主题、SRM10 resize、SSV03 历史加载、SSV05/06 节点身份与流式终态，以及 STF06 表格自身展开/收回动画、模式隔离、动画中横向借位和减少动画偏好。截图和几何采样保留在同目录。
- SPFV 首轮失败的测试坐标已修正：浮窗吸附左上后，固定位置会命中浮窗，不能表示“外部点击”。最终运行的命中记录 `originalInsideFloating: true` 证明该情况；测试按实际 hit-test 选取 slot 内、浮窗外的位置，再发原生指针事件。没有修改产品失焦行为。
- 原生 Windows/Linux、手机实机远控和发布安装包未在本轮验证；窄屏浏览器回归不能替代这些路径。

## 草稿标题适配（DGJ01–03）

DGJ01–03 accepted，2026-11-03 已完成下列本地验收，候选仍保留 manual-review/pending，未人工转正或加入 CI preset。规格见 [草稿问候语](../ui/chat-empty-time-greeting.md#回归验收)。

| Case  | 验收入口                                                                        | 结果与边界                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DGJ01 | `ui-shell/composer/draft-greeting-layout.test.ts`                  | macOS Electron 生产构建，1/1 通过；深浅主题 × 中英文共 4 组，真实开关右侧面板、拖动分隔条，再收起及重开。全部采样保持单行；英文字号 30→25px，输入框随正常行高变化 6px；中文 30→29px，变化约 1.2px，无多余一行造成的下移回弹。 |
| DGJ02 | `packages/ui/test/browser/manual-review/pending/draft-greeting-layout.test.mjs` | 真实组件浏览器验收 4/4 通过，覆盖直接收窄、连续改变宽度、快速反向、父组件重渲染与语言切换；无临时换行、无 ResizeObserver 循环错误。旧实现的桌面用例捕获过标题高度 36→72→30px，修复后不再出现 72px 中间态。                    |
| DGJ03 | 同一浏览器入口的 compact 用例                                                   | 4/4 通过；390px、320px，深浅主题 × 中英文，保持 20px，文字完整且不越界。只覆盖共享组件紧凑分支，不代表手机实机或真实远控连接已验收。                                                                                          |

桌面证据位于 `packages/desktop/.e2e-artifacts/desktop-e2e-20261103071911420-p15551-807e0007df687214/`，含报告、每组布局采样和宽/窄截图；浏览器证据位于 `packages/desktop/.e2e-artifacts/draft-greeting-browser/`，含 `before.log`、`after.log`、布局采样与截图。构建基线为 `681c5f2d5b` 加本次修复；最后一次桌面复跑复用本轮生产构建。

桌面正式入口使用默认 replay，执行 `pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/ui-shell/composer/draft-greeting-layout.test.ts'`。浏览器执行 `node --test packages/ui/test/browser/manual-review/pending/draft-greeting-layout.test.mjs`，可用 `CHROME_EXECUTABLE_PATH` 指定已安装的 Chromium。

原生 Windows/Linux、手机实机与真实远控链路未验证。测试等待草稿投影就绪及字体加载完成；桌面临时调整 renderer 时区到下午并在结束时恢复，浏览器固定到下午时刻，避免短问候语随运行时间变化而不再触发缩字。冷启动 scope 回填不属于此次布局回归。

## 左右侧栏开关性能

2026-11-05：恢复左右原尺寸动画的 STF01–04 扩展 covered（限定以下环境），基线为 staging `8e60cf6c3f`。历史“无连续中间宽度”的通过记录不再证明交互等价，也不作为本轮性能目标。

- macOS arm64、生产 renderer：`desktop-e2e-20261105104311560-p68018-424ee0cf97e934ec`，动画/窗口缩放 2/2、标签/拖动 10/10 通过，1 条 Windows 窗控条件跳过。56 个开关动作覆盖空草稿、800 行合成负载、终端/Browser 标签保留、底部终端、双向快速反转和减少动画。展开、收起均采到连续中间尺寸与 200ms 过渡；右侧内容保持展开宽度；全部动作结束后无尺寸动画或锁宽残留。纯窗口 resize（未跨自动收起阈值）与指针拖动不触发尺寸过渡。双主题截图及 Electron 内部录屏 `sidebar-motion-zai-{light,dark}.webm` 已复核。
- 完整视图 SPFV 7/7 通过：`desktop-e2e-20261105103017666-p31329-99a2f474277c0fb9`。该 run 的其他两项首次失败不计通过：窗口缩放夹具误跨既有自动收起阈值；标签用例在收起动画中点击移动的标题栏按钮。后者经运行时事件记录确认仍在过渡中；功能用例改为等待真实动画完成，快速反向仍由 STF02 独立覆盖，最终结果见上一项。
- DGJ01 桌面 1/1（深浅主题 × 中英文 4 组）通过：`desktop-e2e-20261105102609971-p24596-b3c110870bf1735b`；新增左栏开关，保留右栏开关、拖动与输入框无回弹断言。DGJ02–03 浏览器 8/8 通过，含 320/390px；临时宽度边界 10/10 加原桌面/手机交互 2/2 通过，覆盖普通、完整视图、截图、手机堆叠和抽屉分支的深浅主题。日志和图片归档在同一 run 的 `draft-greeting-browser/`、`mobile-browser/` 及 `*-browser.log`。
- 负对照 `desktop-e2e-20261105102312581-p13952-3b8f5187f46c8837` 在旧实现上完成采样后，按预期失败于缺失左栏 width 过渡。中途一次复跑因类型检查输出覆盖 Host 运行构建而未进入业务场景，另一次录屏因裁剪版编码器不支持 PNG 序列失败；重新构建并使用完整编码器后完成最终回归，不将这些失败记为产品通过证据。
- 本轮保留原防抖代码、项目树 memo 和稳定回调；只在开关期间锁定右侧内容宽度并按动画生命周期释放。本机有其他并行负载，采样仅作诊断，不宣称 FPS 或整体性能提升。未验证原生 Windows/Linux、手机实机及真实远控、真实流式长会话或重型内容首次解析。候选尚未人工转正或加入 CI preset。

以下为已撤回尺寸瞬切策略的历史记录，不代表当前尺寸动画的覆盖：

STF01–04 为 accepted，候选仍为 `ui-shell/navigation/sidebar-toggle-performance.test.ts`，尚未人工转正或加入 CI preset。范围和采样边界见 [布局开销规格](../performance/sidebar-toggle-rendering.md)。

- staging `8ddfb93310` 基线复验 STF01–04 covered（限定已执行环境）：macOS 生产 renderer，性能候选 run `desktop-e2e-20261102111151415-p98010-fdd8e48c01275cda`，40 个动作通过，非快速反向场景的中间宽度变化最多 1 次。1400px 浅色中文 / 800 行合成文字下，左栏开关各 2 次布局，右栏展开 4 次、收起 2 次。标签/拖动 10 条通过、1 条 Windows 窗控条件跳过，完整视图 7/7 通过，run `desktop-e2e-20261102103105624-p15132-cf0d410d267f8efa`。共享 Side Pane 浏览器 1200px 英文浅色 / 390px 中文深色 2/2 通过，日志与截图存于性能候选 run 的 `mobile-browser/`。
- staging 首轮性能候选因左栏按钮选择器依赖原开发分支标记而未进入采样；改用受测语言的可访问名称后完成上述复验。产品代码未为测试增加入口或状态。
- 原开发基线 STF01–03 covered：macOS 生产 renderer，`packages/desktop/.e2e-artifacts/desktop-e2e-20261102101504827-p66493-20a5aa6a24a39b0b`，40 个开关动作采样通过；含底部终端开关/恢复、终端与 Browser 标签保留、快速反向、完整视图保持、800 行合成文字。
- 原开发基线 STF04 covered（限定已执行环境）：同一 run 的 SPT 标签/拖动回归 10 条通过、1 条 Windows 窗控条件跳过；完整视图最终 7/7 通过，run `desktop-e2e-20261102102024512-p79752-961de5b73403c715`。桌面两种主题、中英文及 1400/1000px 几何断言通过。共享 Side Pane 浏览器验收 1200px 英文浅色 / 390px 中文深色 2/2 通过，证据存于 `desktop-e2e-20261102100025431-p47950-a12eb481c8c926f6/mobile-browser/`。
- 回归准备修正：原开发基线的原始构建也会在草稿预热尚未完成时失败，负对照 run `desktop-e2e-20261102100542748-p51518-2c19b1613085f7bb`。诊断 run `desktop-e2e-20261102101111864-p61727-47cec774b39a28fc` 的日志确认，预热后 scope 回填把已经展开的面板重新同步为收起。布局用例改为先等待草稿投影 ready；本次未修改这条冷启动产品路径。完整视图恢复采样改为从真实按下开始，等待完整 500ms 窗口并检查所有采样高度，不再用固定帧数作为几何验收前提；高度不超出最终值的断言保留。
- 未验证原生 Windows/Linux、真实手机远控、真实流式长会话和重型文件首次解析；不将合成负载或浏览器服务夹具记为上述覆盖。

> `retired:` 逐处标记已退役 App 单测，仅供追溯；原通过记录不代表现行覆盖。独立断言缺口需由后续验收补齐。

> 2026-10-26：App 业务单测已按[测试规格](unit-test-quality.md)退役。本文中的相关单测路径和历史通过记录不再代表现行覆盖；CLI/CUA、工程测试、E2E 与浏览器验收证据仍按各自状态解释。未补验收的场景不得自动视为已覆盖。

| Case ID     | Default 156px | Equal shrink | 60px floor    | Horizontal scroll | `+` placement | Active close | Inactive close | Tooltip reset | Middle-click close | Spec                                                      |
| ----------- | ------------- | ------------ | ------------- | ----------------- | ------------- | ------------ | -------------- | ------------- | ------------------ | --------------------------------------------------------- |
| SPT-E2E-001 | covered       | n/a          | n/a           | asserts absent    | follows tabs  | n/a          | n/a            | n/a           | n/a                | `ui-shell/panels/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-002 | boundary      | covered      | asserts above | asserts absent    | follows tabs  | n/a          | n/a            | n/a           | n/a                | `ui-shell/panels/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-003 | n/a           | covered      | covered       | covered           | fixed outside | n/a          | n/a            | n/a           | n/a                | `ui-shell/panels/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-004 | n/a           | n/a          | n/a           | n/a               | n/a           | covered      | covered        | n/a           | n/a                | `ui-shell/panels/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-005 | n/a           | n/a          | n/a           | n/a               | n/a           | n/a          | n/a            | covered       | n/a                | `ui-shell/panels/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-006 | n/a           | n/a          | n/a           | n/a               | n/a           | n/a          | covered        | n/a           | covered            | `ui-shell/panels/side-pane-tabs-responsive-interactions.test.ts` |

## Coverage Notes

- SPT-E2E-009：`packages/desktop/test/e2e/ui-shell/panels/side-pane-draft-promotion.test.ts`，草稿里打开 Browser 并加载本地页面后真实首发。断言首发后同一 tab 仍可见且为活动 tab（侧栏展开）、guest 内页面标记保留、夹具页面没有被再次请求，最后从 UI 关闭成功（main 关闭入口按 owner 校验）。2026-10-28 macOS Electron：修复后 1/1 通过；负对照 A 去掉迁移，失败在「首发后草稿 Browser tab 不再可见」（即工单现象）；负对照 B 只迁移 renderer、不升级 main owner，失败在「无法关闭」，main 日志为 `attachGuest rejected reason=session-mismatch`。保留 manual-review，未宣称 Windows/Linux、手机远控或分屏草稿首发验证。

- SPT-E2E-010 / SPT-E2E-011（2026-11-09）：同一文件。010：草稿打开 Browser 后主动收起侧栏再首发。断言 tab 迁到新任务（收起时 tab 壳仍挂载）、侧栏保持收起（开关可访问名称与首发前收起态相同）、展开后它是活动 tab 且可关闭（main owner 已升级）。011：草稿展开空面板只得到新标签页，首发后新任务没有任何 tab，侧栏收起。macOS Electron 修复前：009 通过；010 失败，侧栏被展开（收到 `Collapse side pane`）；011 失败，新标签页被迁入新任务。run `desktop-e2e-20261109081950415-p20751-d1b9e245d1b1ba3e`。修复后 3/3 通过，run `desktop-e2e-20261109082327133-p27453-ba6989c71ae56ae4`。保留 manual-review。未验证 Windows/Linux、手机远控、分屏草稿首发；工作区公共 tab（Git 等）继承折叠态没有 E2E 覆盖。

- 2026-10-15 SPT-E2E-007 加载图标回归：浏览器 12/12 通过。8 组安装/启用用例验证目标入口有可见旋转图标和 `aria-busy`，其他插件无进度，成功/失败后清除；新增同一插件双 surface 共用进度、只发一次安装请求，以及减少动画偏好下静态图标的验证。覆盖桌面亮色英文、窄屏暗色中文与空态/新标签页；服务由 fixture 提供，仍为 pending。

- 2026-10-12 rebase 回归：保留侧栏 scope 修复，网页权限沿用当前基线；E2E 改用当前 `activeTaskId` 对话选择接口、通用会话准备和无账号启动，页面 fixture 只提供两个本地站点。macOS Electron SPT-E2E-008 1/1 通过（`desktop-e2e-20261012032035626-p33390-08ac35a2e03ad569`）；受影响单测、根/E2E typecheck、lint、architecture check 通过。补齐插件侧栏的 parentSessionId 归属断言，仍保持 manual-review/pending；未新增 Windows/Linux 或手机实机验证。

- 2026-10-19 SPT-E2E-007 并发安装回归：推荐区删除独立全局锁，与市场共用管理 store 的按插件忙碌判定。浏览器 16/16 通过，覆盖两个不同插件同时待处理、后一次失败不清理前一次、安装中打开其他已启用插件，以及原有重复点击、同插件双 surface、启用、失败恢复和减少动画偏好；1200px/英文/Zai Light 与 390px/中文/Zai Dark，默认新标签页和主动新增标签页均覆盖。Hook 定向 8/8 通过，含服务切换后旧操作完成隔离；最终 affected 90 个文件、1379 条通过。根 typecheck、architecture 和变更文件格式检查通过；lint 无错误，188 条警告与原基线一致。夹具按当前面板 owner 初始化默认 new-tab，避免旧空面板状态不再挂载入口。服务仍由 fixture 注入，未启动真实 Agent/沙箱或手机远控，保留 pending。

- 2026-10-21 SPT-E2E-007 推荐展示回归：浏览器 18/18、Hook 9/9、受影响单测 75 个文件 1181 条通过；根 typecheck、architecture、格式检查通过，lint 0 错误（188 条既有警告）。补充已安装/暂停条目优先、组内稳定顺序，以及描述前社区标签的来源隔离与本地化断言。原进度/并发用例改为按插件 ID 定位，避免安装态改变顺序后误点其他条目。Hook 另覆盖安装完成后的重新排序；浏览器仍使用注入服务，不代表真实 Agent 或手机远控验证，保留 pending。

- SPT-E2E-007：`packages/ui/test/browser/manual-review/pending/side-pane-plugin-menu.test.mjs`，空态 launcher + active new-tab launcher 使用真实 reducer 创建标签，覆盖鼠标、Tab/Enter、作用域与重复打开、安装/启用、草稿/无宿主门禁及冷加载；1200px/en-US/亮色与 390px/zh-CN/暗色。2026-10-14 自动浏览器 E2E 11/11 通过，其中 8 组以可控响应验证安装/启用进度仅归属目标插件、其他插件保留原文案、全局禁用、失败后换插件重试及成功后不自动打开。仍为 pending，未提升 CI admission，未声明插件沙箱或真实手机远控覆盖。
- Logo 样式迁移：SPT-E2E-000 在 Windows/Linux 验证旧 28px 点击区域及位置、18px 底座、11px 静态 SVG、真实 hover 和点击收起/恢复 Sidebar。Windows 实测通过：`desktop-e2e-20261009065750634-p17396-21ed3ac7f4753068`，1/1；Linux 真机待补，平台条件由组件测试覆盖。

- SPT-E2E-008：`packages/desktop/test/e2e/ui-shell/panels/side-pane-scope.test.ts`，覆盖对话隔离的关闭与恢复；2026-09-30 macOS Electron 1/1 通过（`desktop-e2e-20260930-063101-322`），保留 manual-review/pending。跨工作区及异步 authority 由 `retired:packages/ui/test/useAppPanelsScope.test.ts` 覆盖，归属类型由 `retired:packages/ui/test/workspaceSidePane.test.ts` 覆盖。未宣称 Windows/Linux 或手机实机验证。（retired: 为退役历史证据，不计现行覆盖。）
- 本轮小重构回归：552/552 相关单测；原侧栏交互 7 通过、1 非 macOS 窗口控件用例跳过（`desktop-e2e-20260930-062902-680`）；完整权限 22/22（`desktop-e2e-20260930-063214-472`）。根 typecheck、E2E typecheck、lint（63 个已有 warning）、architecture check 和变更代码格式检查通过。
- 修复前证据：Hook 7/8 失败；旧构建 `desktop-e2e-20260930-061702-522` 在 B 关闭其他后找不到 A 设置 tab。快捷 Browser 入口遗漏工作区另有先红后绿的单测。运行报告与逐次日志：`packages/desktop/.e2e-artifacts/side-pane-scope-20260930/README.md`。

- SPT-E2E-004 验证选中 tab 显示关闭按钮、未选中且未 hover 时隐藏，hover 后通过真实鼠标点击关闭且不激活该 tab；键盘 focus-within 也显示关闭按钮，触屏通过先选中再关闭。
- SPT-E2E-004 同时检查 item-content 使用 mask、文字不使用 ellipsis，hover 时 mask 改变而内容宽度和文字位置不变。
- SPT-E2E-001 同时检查 Electron 中 Side Header 的窗口拖拽 CSS 区域，以及标签、按钮的 no-drag 排除；既有菜单、关闭交互继续回归。此断言不替代操作系统原生窗口位移验证。
- 2026-09-04 Side Header 修复回归：`desktop-e2e-20260904085528667-p35124-05b2c42316ba4c37`，7/7 通过；typecheck、E2E typecheck、lint 通过（41 个已有警告）。测试展开条件改为真实面板宽度与透明度；Tooltip 使用语义节点检查，避免持久挂载 DOM、标题前缀和屏幕阅读器副本导致误判。Windows/Linux 原生窗口位移尚未独立验证。
- 物理宽度、scroll metrics、DOM containment 和可见性由 Electron WebDriver 读取真实渲染结果。
- Tooltip 使用受控等待窗口验证，不使用 provider stream timing。
- Mobile Web touch 不承诺 hover Tooltip；其 layout shell 保留现有组件测试，未作为本组 Desktop E2E 的覆盖声明。

## 独立面板布局（2026-09-04）

- 2026-09-10 CR-01：SPT-E2E-000 平台期望为 Windows 5px、Sequoia/更早 macOS 6px、Tahoe 26+ 与 Linux 12px；三处指示线为 foreground-subtlest/50、沿边原长度、无 mask。useAppChromeStateAutoUpdate.test.ts 补齐平台查询→hook→半径的数据链路，验证 macOS 15/26 的异步结果和订阅清理；macOS 真机视觉待补。

- 2026-09-07 补齐 resize handle 与平台圆角覆盖：SPT-E2E-000 接受 Windows 5px、macOS/Linux/Web 12px；验证 Sidebar、Terminal 的 4px 热区和 Side Pane 热区（当前期望为 3px，2026-10-29 更新断言后尚未重跑）、2px `bg-foreground` 指示线、默认隐藏及 hover/拖动态显示，并以真实指针分别改变 Sidebar 宽度、左右面板宽度和会话/终端高度。设置页 Sidebar 的 268px 桌面宽度由 `settings/general/settings-ui-polish.test.ts` 覆盖，紧凑 68px 继续由组件测试覆盖。
- 2026-09-07 补齐验收：Workspace suite 7/7 通过，运行 ID `desktop-e2e-20260907065558567-p30371-3b85b0c85fbbae83`；Settings suite 5/5 通过，运行 ID `desktop-e2e-20260907065702167-p33040-7fa462d329a4436b`。47 项相关单测通过。
- 开关按钮迁移：SPT-E2E-000 检查空态展开后 WorkspaceHeader 不再显示开关、Side Header 可收起；SPT-E2E-001 覆盖有标签时在 Side Header 收起、从 WorkspaceHeader 再展开并保留标签。
- 迁移验证：`desktop-e2e-20260904085939961-p43497-9ecade9b51e2c858`，macOS Electron 7/7；相关单测 33/33、typecheck、E2E typecheck、lint 通过（41 个已有警告）。已检查深色空态截图；Windows/Linux 与手机端未单独执行视觉 E2E。
  依据 `docs/design/workspace-independent-panels.md`，SPT-E2E-000 增加面板上下对齐、3px 间距（当前规格）、Header 归属、xl 圆角与关闭恢复宽度断言。现有 tab 展开/关闭、缩放、拖动用例继续覆盖持久挂载行为；手机分支和 Windows/Linux 控制区由针对性单测覆盖。

最终验收：`desktop-e2e-20260904084050358-p6937-68e000533efda13e`，7/7 通过。SPT-E2E-000 同时覆盖真实拖动、底部终端、双主题截图；截图文件为该 artifact 目录下 `independent-panels-zai-light.png` / `independent-panels-zai-dark.png`。其他平台独立视觉验证待补，详见布局 spec。

## 通用 / 编程界面模式 M1

范围与 MODE-01～07 用例见 [模式验证矩阵](general-coding-mode-verification.md)。新增桌面用例位于 `packages/desktop/test/e2e/ui-shell/navigation/general-coding-mode.test.ts`，覆盖设置偏好、入口隐藏和已有面板保留；已人工验收并转为 ui-shell 正式用例，尚未加入 Docker preset。对话展示由组件单测补充，验证状态以该矩阵为准。

2026-10-09 平台尺寸：SPT-E2E-000 Windows 6px 外沿／收起左留白、8px 圆角、指示线和实际拖动通过，run `desktop-e2e-20261009070445229-p20968-57b667c6addfb7fa`。Linux 4px／12px 保留，真机待补。

2026-10-09 拖动指示线：SPT-E2E-000 Windows 双主题验证 Sidebar、Side Pane、底部终端为 sky-500／sky-400，长度、显隐与实际拖动通过；run desktop-e2e-20261009071748019-p456-09549c1404406786。Linux/macOS 真机待补，Web 保留原色的布局边界单测通过。

2026-10-12 CR-01：SPT-E2E-000 展开时检查 Side Pane chrome 圆角 token，收起后检查会话 chrome token；两种状态均检查计算圆角。展开会话使用动态变量，避免对独立面板路径误报缺少 token。

验证：Windows 与 macOS Sequoia 圆角分支的渲染回归测试通过（所在文件 28/28）；macOS Tahoe 的 SPT-E2E-000 通过，run `desktop-e2e-20261012025943835-p89324-74abc1ab5327b1fe`（1/1）。Windows / Sequoia 真机、Linux 与手机实机未在本轮执行；仅修改测试断言，无产品代码或交互行为变更。

## 默认新标签页

- SPT-E2E-009：`ui-shell/panels/side-pane-tabs-responsive-interactions.test.ts`，覆盖首次展开、工具替换、收起恢复、加号及最后一个标签关闭。
- `retired:packages/ui/test/useAppPanelsBrowserViewLifecycle.test.ts` 覆盖真实 hook 的默认入口、工具替换和异步关闭。（retired: 为退役历史证据，不计现行覆盖。）
- macOS Electron 本轮 9 通过、1 平台条件跳过（Windows 菜单），含 SPT-E2E-009 与 SPT-E2E-000 深浅主题截图；run `desktop-e2e-20261016082511861-p45212-c004286dcc3d9c01`。手机实机、Windows/Linux 真机和卡顿归因未验证。

2026-10-16 评审修复：SPT-E2E-009 定向通过（1/1），run `desktop-e2e-20261016-091135-357`。覆盖末标签关闭收起、再次展开补建、真实关闭菜单命令，以及后续关闭上下文事件不被 App 拦截；测试未实际关闭宿主窗口。受影响单测 79 文件、1320 条通过。此前整文件运行其余 8 条通过、1 条平台跳过；009 的菜单回调和动画等待问题在上述定向重跑中修正。手机实机、Windows/Linux 真机未新增验证。

## 完整视图（SPFV，2026-10-16）

| Case ID      | 入口/退出     | surface      | 浮窗形态               | 拖动吸附 | owner 记忆 | 阻塞交互 | Spec                                                                    |
| ------------ | ------------- | ------------ | ---------------------- | -------- | ---------- | -------- | ----------------------------------------------------------------------- |
| SPFV-E2E-001 | 按钮 + 快捷键 | n/a          | n/a                    | n/a      | n/a        | n/a      | `ui-shell/panels/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-002 | n/a           | 对话 / 面板  | 收起（单行）           | n/a      | n/a        | n/a      | `ui-shell/panels/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-003 | n/a           | 对话 / 面板  | 收起 + 操作栏 / 最小化 | n/a      | n/a        | n/a      | `ui-shell/panels/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-004 | n/a           | 菜单切到对话 | 收起                   | 左上     | n/a        | n/a      | `ui-shell/panels/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-005 | n/a           | 面板         | 展开 / 收起            | n/a      | n/a        | n/a      | `ui-shell/panels/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-006 | ◫ 退出        | n/a          | n/a                    | n/a      | n/a        | n/a      | `ui-shell/panels/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-009 | n/a           | 面板         | 收起                   | n/a      | n/a        | n/a      | `ui-shell/panels/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-007 | 按钮          | 面板         | 收起（发送）           | n/a      | covered    | n/a      | `conversation-session/branching/conversation-session-side-pane-full-view.test.ts` |
| SPFV-E2E-008 | n/a           | 面板         | 最小化 → 自动恢复      | n/a      | n/a        | covered  | `conversation-session/branching/conversation-session-side-pane-full-view.test.ts` |

- 2026-10-16 macOS Electron：ui-shell 6/6（`desktop-e2e-20261016132641383-p65282-482172e91cde062d`）；provider 2/2（`desktop-e2e-20261016132902337-p68218-55a5106a8275c319`，replay `common.json` + case fixture）；SPT 回归 8/8。ui-shell 用例存了深浅主题截图（展开、收起 + 操作栏、最小化）。仍为 manual-review/pending，未加入 Docker preset；Windows/Linux 未执行。
- 运行时定位记录：选菜单项曾因 portal 事件沿 React 树冒泡切换展开态（004 回归断言）；用 CSS 压缩对话列 flex 会让 react-resizable-panels 的 group 尺寸为 0、展开 resize 得到 NaN（007 切回会话覆盖）；controller 引用不稳定会让 memo 的 WorkspaceShellLayout 在切换会话时出现 React #185（单测 + 007 覆盖）。
- 2026-10-16 第二轮（保留侧栏、抽屉、单行输入框、loading、恢复动画、滚动条、插件层）macOS Electron：ui-shell 7/7（`desktop-e2e-20261016152650322-p89798-2c5c15bc8942f302`，含深浅主题截图）；provider 2/2（`desktop-e2e-20261016152827854-p91091-9383fec55304cbe0`）；SPT 回归 8/8。仍为 manual-review/pending；Windows/Linux 未执行。
- 第二轮运行时定位记录：恢复动画逐帧采样显示浮窗宽 48px 时单行输入框折行到 258px，随宽度变大回落到 46px（003 断言每帧高度不超过最终值）；插件 UI 空白由外框 `z-10` 盖住 body 级停靠层造成，009 在旧构建上命中 `browser`、改为 `z-0` 后命中插件页面；004 的偶发失败是测试在宿主几何过渡中读坐标，改为等待宿主 `getAnimations()` 结束。
- 2026-10-17 转正（用户确认 review）：ui-shell 移到 `ui-shell/panels/side-pane-full-view.test.ts`；provider 用例经 `e2e:promote --reviewed --apply` 移到 `conversation-session/branching/conversation-session-side-pane-full-view.test.ts`，`audit:conversation-session-coverage` 通过，正式路径 `e2e:fixture:check` 通过。新增断言：运行中占位「工作中 N 秒」与流式消息同值（008）、回答气泡弹出 / 切回仍在 / 点击展开 / × 关闭（007、008）。macOS Electron 正式路径：provider 显式回放 2/2（`desktop-e2e-20261016172121606-p45655-10a0c044cbc26349`）、默认回放 2/2、ui-shell 7/7、SPT 8/8。Docker 隔离运行与 preset 准入未执行（本机 Docker daemon 未启动）；Windows/Linux 未执行。
- 转正时的运行时定位：正式回放下回答很快，整轮在一次渲染批次里结束，`data-running` 从未为 true；气泡改为「基线之后出现的已结束回合才弹出」，不再要求观察到运行中。
- provider 用例需要 case-local 的标题与 compact 响应：manual-review 小上下文窗口每轮都会自动 compact，compact 失败会退避重试并把后续输入留在队列。
- 2026-11-06 浮窗 tab 切换动画：macOS Electron ui-shell 7/7 通过，run `desktop-e2e-20261106083648532-p21740-36dbba30c806c0ba`。002 新增首个浮窗绘制帧即到最终几何、无宿主几何过渡的断言；004 验证拖动吸附仍有位置过渡；005 验证展开与收起仍有高度过渡。同一 run 保留深浅主题截图与草稿、编辑器单实例回归。`browser/browser-results.json` 另记录原宿主组件在 1440/900px、两主题的切换及局部动画回放，以及 390px 普通布局检查（6/6）；组件夹具不等同于真实手机远控验收。本轮未运行 Windows/Linux 和 provider 用例。
