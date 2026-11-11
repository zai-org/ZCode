# Provider 设置本批浏览器用例

## 重命名关闭动画焦点回归（2026-10-28）

PRN-01（accepted，pending）：390px 中文浅色／1200px 英文深色，真实 Header/Card 点击重命名后，在菜单关闭动画内移动鼠标，再移动到菜单外。菜单完成关闭后，名称输入框必须保留且拥有焦点；直接键盘输入应写入名称，Enter 只保存一次且不改变启停状态。再次使用键盘选择重命名，Esc 放弃输入且不额外保存。

测试通过 Web Animations API 暂停并完成真实关闭动画，明确命中仍挂载的关闭菜单，不靠固定等待猜测动画窗口；不主动聚焦或 fill 名称输入框来掩盖焦点丢失。复用隔离保存路由，不写真实配置。焦点交接规格见 [标题栏操作](../working-memory/provider-refactor/steps/todo-115-provider-header-actions-and-toggle-hit-area.md)。

运行：`node --test --test-name-pattern='provider rename keeps focus|header name and option feedback' packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs`。覆盖共享组件桌面／手机宽度，不替代完整 Electron 或手机 shared-host 验证。

验证结果：旧实现两例均在鼠标移动后失去名称输入焦点；修复后新增两例与既有标题栏两例合跑 4/4 通过。未新增产品延时、重试或全局菜单行为，保持浏览器 pending 分类。

## MiMo 模板拆分（2026-10-14）

MIMO-03（accepted，pending）：390px 中文浅色 / 1200px 英文深色，真实模板选择器分别显示 Xiaomi MiMo API 和 Xiaomi MiMo Token Plan，tooltip 和图标一致；分别点击后仅发送对应 templateId 的创建动作，详情 Base URL 分别为按量与中国 Token Plan 地址；无横向溢出、页面错误或额外写入。规格及官方核验见 [MiMo 模板](../provider-mimo-templates.md)。复用现有浏览器 fixture，不宣称原生 Electron、手机 shared-host 或真实付费请求已验证。

运行：`node --test --test-name-pattern='mimo templates' packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs`。

本轮两例通过，截图已复查：两张模板、图标、两种地址、中文浅色与英文深色正常。配置相关定向 18 项及最终 affected 17 项通过；保持 pending 身份。

## Todo148 Dock 应用图标纠正（2026-09-15）

Todo150 名称补充：现有 `zai app icon` 双尺寸／语言用例同时断言两张模板卡片及 tooltip 分别为 `Z.ai Coding Plan`、`Z.ai API`，图标与协议不变。

OpenRouter 名称回归：390 中文浅色／1200 英文深色的添加模板卡片显示 `OpenRouter`，不含 Anthropic 后缀；悬停提示沿用相同名称。配置单测同时验证生产／测试名称及协议、URL 未改变。

新增 `zai app icon` 两例：390 中文浅色／1200 英文深色。真实模板选择器中两家 Z.AI 模板、选中后的导航和详情使用同一 128px 应用 PNG，图片实际解码成功、保持正方形、不反色；纯展示不写入，点击模板仅触发原有创建动作，无额外保存或页面异常。截图供视觉复审，仍属浏览器 pending，不代替手机 shared-host 或完整 Electron 验收。

## 整页旧用例对齐（2026-09-12）

Pro 首次运行现有 `settings-ui-polish`，发现 MP-UI-04 仍找独立垃圾桶、MP-UI-06 仍把分组标题当 label，两处与 Todo115／125 已裁决实现冲突。测试改为真实点击更多菜单内删除、按帮助入口定位对应分组标题，原删除落盘、样式及编辑保存断言保留。MP-UI-01 的滚动检查移到创建步骤之后，仍然执行并断言，避免独立滚动失败遮蔽模板创建证据；不删除检查、不调整产品布局或放宽创建标准。

完整设置滚动用例与本轮基线相同，目前 Pro 报滚轮后外层未滚动，归因未定。失败继续记录，不算本轮全绿；新增运行诊断只记录几何／命中元素／滚动量，不读取账号数据。

后续定位：MP-UI-01 单独运行含完整滚动断言通过；合批时前置 UP-01 打开头像菜单后没有关闭，后续 DOM click 越过模态菜单继续操作，而真实滚轮命中根 HTML、未进入 main。修复测试收尾：UP-01 正常关闭菜单并等待指针屏障释放，不改产品滚动，不删失败断言。此项为既有测试隔离问题。

第二轮 MP-UI-04／06 已通过，MP-UI-01 暴露旧目录预期：Todo113 第二轮官方 DeepSeek 模板为 `deepseek-flash`／`deepseek-v4-pro` 两成员，旧 `deepseek-v4-flash` 规则仍保留但不再列为官方默认成员。按最终目录更新该精确断言，不删除模型规则或恢复重复默认项。

最终合批 `provider-20260912-pro-settings-polish4` 通过：8项实际执行、UP-00 非 Windows 提前返回、1项 SSH 跳过。WDIO 的9 passing 包含该 Windows no-op，不能声称 Windows 已测。完整创建/返回、删除、调序、编辑保存和视口/滚动断言均执行；390px 中英深浅截图已查看。详细证据见 `ui-polish-e2e-coverage-matrix.md` 的2026-09-12节。

## Todo127 桌面刷新整链补充

BR117-N02（accepted，pending）：隔离完整 Electron 应用通过测试 HTTPS 代理取得两个版本化 Built-in URL。初始版本提供测试模型容量 500K 与请求映射标记 0.17；仅将测试控制面切至新 URL 后，点击设置页刷新，界面变为 700K，随后真实连接测试 wire 使用新标记 0.37。Personal 文件和预置的最近选择缓存不变。复用正式下载、Account／Registry 更新及 Model 创建路径，不直接写 Active 或 stub Settings View。代理只替代外部网络响应，不放宽 HTTPS 校验；不访问真实账号，不自动发布，不新增模型请求外的业务行为。旧执行冻结另由已有 Core/SDK 测试证明，此例不冒充运行中 Model 验收。

```text
设置页刷新 -> Host 正式下载 -> 测试控制面 URL -> 测试 HTTPS CDN
  -> Active 原子替换 -> Account/Registry -> 700K UI
  -> 连接测试新 Model -> 实际 wire 0.37
```

该项不替代手机 shared-host／SSH Environment 联合验证。用例位于 settings/manual-review/pending，保持待人工晋级。

## Todo116 原生打开补充（2026-09-12）

K116-N01（accepted，pending）：在隔离 Electron profile 写入两个预设模板创建的手动 Provider，分别为普通 API Key／Coding Plan API Key，并使用非空／空 Key。每个 Provider 的 `apiKeyManagementUrl` 指向测试进程本机随机端口下的唯一路径。真实设置页应只有一个获取入口；点击前服务器没有该路径请求，点击后系统默认浏览器请求精确配置的路径，配置文件字节保持不变。不开启模型请求，不访问真实账号或读取默认浏览器其他页面。纯自定义、无 templateId 的 Provider 按已有裁决不显示此入口。

```text
隔离 Personal Config 单 URL -> Settings View -> 唯一按钮
    -> IPlatformService -> preload / IPC -> shell.openExternal
    -> 系统默认浏览器 -> 本机唯一 canary GET
```

用例：`packages/desktop/test/e2e/settings/providers/provider-key-native-open.test.ts`。需要有默认浏览器的交互桌面，不纳入无桌面的 Docker gate；请求抵达只证明原生打开链路，不证明官方控制台登录态或手机 shared-host。模板官方 URL 的精确值及有／无 Key 双尺寸组合复用既有测试，不作额外排列。测试会打开两张无账号内容的本机验收页。

Todo131/125：真实编辑 Hook+弹窗增加6例（双尺寸各3）：原子恢复及失败保留；编辑/模式/供应商/关闭/重复恢复/保存开始/ID 变化时旧成功和失败均失效；9处帮助 hover/focus/tap、Escape、定稿富文本、视口边界与不修改草稿。原130两例补空 ID 恢复无请求/无写入。新增6例定向通过，合批结果见 Goal 账本；布局截图在同一临时目录。已更新三个 Electron 设置用例，但本组尚未实跑 Electron；中文字体显示仍受 Linux 字库限制。

Todo130：新增 manual editable fields and pending cancellation 两例，真实 useProviderModelDraft+弹窗验证空 ID 可切换且不发请求、在途切手动后旧成功/失败均不能覆盖草稿、无保存。390 中文浅色和1200英文深色均通过；推荐与保存网络用测试路由隔离，不等价于 Electron/远控实机。手动 schema 与实际文件往返另由 Provider/Node 测试验证。

Todo122：新增 subagent selection error copy 两例，真实 ToolLayout 展示测试注入的公共错误 message，验证 390 中文浅色/1200 英文深色详情及复制完整原因和选择身份。两例通过；Core 的真实解析、投影、前后台 runner 另有 84 项测试，不将 fixture 冒充跨进程实机链路。

Todo126 新增两个 coding plan vision badge 用例：相同双尺寸/主题下遍历个人、团队与手动套餐 Key，用真实 ModelConfigSelect 菜单与设置 Card 验证 GLM-5.3 无视觉标、Flash 保留；服务端桥接及图片能力原样保留。两项定向运行通过。

2026-09-11 Todo115/132：新增两个 header name and option feedback 用例（390 中文浅色/1200 英文深色）。真实 Header/Card 的菜单焦点、停顿不保存、Esc 不保存、Enter 一次提交、长名布局、Tooltip 不覆盖开关状态和扩展热区不碰菜单；真实 Modality/Boolean 组件验证同位置点击底色有变化，文字/图标/边框/尺寸不变。六项合跑通过，保存路由隔离；不替代整页 Electron/手机 Host 链路。本轮 Linux 字库缺少中文字形，中文文案/交互可断言，但不算中文字形视觉通过。

2026-09-11 Todo117 补充：390/中文/浅色与1200/英文/深色下，真实账号 Provider 卡片不显示总开关，模型开关仍在，挂载不写入 enabled；原手动 Coding Plan Key 用例继续验证启停。套餐选择与保存副作用另由真实 ModelProviderSection 回调测试覆盖，浏览器卡片 fixture 不冒充整页 Host 联调。

同日 Todo119/124：禁用后模型测试按钮 disabled，重新开启恢复；成功提示使用 Fixture Provider 而非内部 fixture ID，语义绿色背景/文字/边框与关闭按钮同时存在。四个浏览器用例合跑通过。名称回传、成功/失败/异常及资格提示本地化由真实 React 组件事件测试补充；签名网络错误原样透传由服务测试覆盖。

关联：[Todo107](../working-memory/provider-refactor/steps/todo-107-provider-settings-feedback-enablement-and-template-links.md)、[Todo111](../working-memory/provider-refactor/steps/todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md)。

用例文件：`packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs`，配套 fixture 使用真实 TemplatePicker、ProviderCard、Navigation、反馈组件，服务写入由测试路由隔离；不写真实用户数据。

| 用例                           | 尺寸/主题/语言       | 验证                                                                                                                                                                                |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider batch 390/zh-CN/light | 手机宽度、浅色、中文 | 四智谱模板分组与顺序、页面无横向溢出；有 Key／无 Key 均只有一个获取 API Key 入口，点击交付模板主 URL；启停写外层字段、Key 保留；横拖 x 不变；删除失败重试原操作；连接成功提示可关闭 |
| provider batch 1200/en-US/dark | 桌面宽度、深色、英文 | 同一组行为，验证共享组件和本地化，不创建第二套 Web Provider 判断                                                                                                                    |

2026-09-10 原用例两条通过；2026-09-11 按 Todo116 将双入口断言改为上述单入口及空 Key 断言，新结果以 Todo116 为准。截图位于测试输出临时目录 `zcode-provider-settings-batch`。保持 pending 分类，未擅自晋级正式 Electron 回归。

运行：`CHROME_EXECUTABLE_PATH=<Chromium> node --test packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs`。Linux 需 Chromium 运行依赖及中文字库。本次使用环境已有隔离共享库和临时官方发行版 Noto CJK 字库。

既有 Electron `settings-ui-polish` 已按最终 DeepSeek 两成员、菜单与帮助标题更新并在 Pro 实跑通过，`provider-settings-write-recovery` 也已在 Pro 合批通过。前者 SSH 分支仍跳过；二者不等于手机 shared-host 联合验证。原生控制台打开由 K116-N01 单独证明，不借此宣称官方登录态通过。

2026-09-12 Todo137 已确认新增覆盖：现有 vision badge 浏览器用例增加 Z.ai／BigModel Start Plan。两个尺寸/语言/主题下，设置列表和模型菜单均隐藏 GLM-5.3 视觉标，Flash 仍显示；只验证共用展示组件，实际图片能力由单测验证不变。先红后绿，2项浏览器用例通过；保持 pending 分类。

2026-09-12 Todo138 已验证：新增模型空 ID 档位为空；输入 ID 接收推荐档位、清空恢复空列表；显式编辑档位在解析回包后保留。复用真实 ProviderCard 新增入口，覆盖 390/中文/浅色和 1200/英文/深色，服务路由隔离。

Todo138 新增两项先红后绿；全文件22项中21项首次通过，手机 provider batch 受文件热更新干扰，固定文件后两项 provider batch 独立重跑通过。保留 pending 身份，未晋级完整 Electron/远控回归。

## Todo141 补充验收（2026-09-12）

在既有真实编辑器浏览器用例上补充：390px 中文浅色、1200px 英文深色，基础字段顺序、标题区智能开关、底部重置／取消／保存、文本锁定勾选框、无卡片及无横向溢出；展开收起保留局部草稿，推理等级／映射错误重复展开聚焦，基础最大输出错误不展开；重置不落盘、保存中标题开关不可操作、重开默认收起。继续覆盖原有手动配置、个人覆盖与异步过期结果，不改输入法实现，不把浏览器夹具当作桌面／手机真实 RPC 联合验收。

本轮完整批次 **26/26 通过**，含 Todo141 四例（其中推理等级校验覆盖 reduced motion）。截图已补齐 Noto CJK 字库并查看，字段间距实测 16px；保留 `/tmp/zcode-provider-settings-batch/todo141-{390,1200}.zip` 交互 trace 和基础／高级截图。两入口、普通／减弱动画、重复错误、局部编辑保留、重开及联合保存通过。原生 E2E 选择器和文案已对齐，本轮仅通过类型检查，未重跑 Mac Electron／真实手机远控；不改变 pending 分类。

## Todo143 勾选框颜色回归

在既有 `header name and option feedback` 两例增加系统 Checkbox 的真实样式对照：390px 中文浅色／1200px 英文深色，输入类型、普通能力、个人覆盖能力的选中与未选中框体颜色，对号反色和 16px／12px 尺寸；键盘单次切换，外层边框、文本锁定保持。旧实现两例均红，修复后与 Todo141 四例合批 6/6 通过。已查看选中截图；Linux 当前缺部分中文字形，不声称字体视觉验收通过。仅修改浏览器 pending 用例，不晋级，不冒充原生实机／手机 shared-host 验证。
