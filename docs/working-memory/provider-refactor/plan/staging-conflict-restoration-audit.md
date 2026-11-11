# staging 冲突恢复与裁决记录

> Todo 85 的唯一过程记录；2026-09-07 用户重新进入目标模式，继续执行。代码已写不等于验收完成；历史停留点保留，当前任务见“新目标续接”。
> 本次起点 a43049c265；同一工作区原有领取、迁移、E2E 等未提交改动，逐 hunk 接续并保留。

## 最终审阅入口（2026-09-07）

本轮固定范围的恢复、适配和审计已完成。下方按时间保留的“待实施/失败/阻塞”是历史记录，以本节及功能表的最终状态为准；没有未裁决的恢复阻塞项，也没有合入后续 staging。

- **直接恢复**：R01 Hook 详情、R02 消息/附件布局、R03 MCP 进程隔离及插件 UI、R04 CUA 生命周期、R05/R06 测试凭据与 mock、R07 领取卡完整行为。R11 的早期 Markdown“已保留”结论在 Todo88 二次复审发现装配遗漏；下方补充记录取代该部分结论。

### 2026-09-07 Todo88 二次复审纠正

`626f939c29` 的 Markdown 引用 helper / 面板虽仍在，`0ed79bae571` 人工合并却漏接 SessionPane 的 reference 参数和阻塞状态。此前仅凭文件相同不足以证明完整行为。现已补回，保留当前 Submission/Side Chat 架构；真实组件测试先红后 8/8，Pro 正式 MPS01/02/06/08/09 验证引用、主草稿和实际发送路径通过（`desktop-e2e-20260907-162820-560`）。下文 R11 与“未发现新缺口”是当时审查记录，不再作为当前完整性结论。详见 [Todo88 复审 AS01](../research/todo88-completion-and-commit-audit.md)。

- **按当前架构接回**：R08 Account State/Overlay/独立套餐检查/可恢复导航；R09 原子 Submission 和 Goal 首发；R10 Map 决定请求字段；R12 保留 Host/凭据/Registry 分层，不恢复旧混合 node.ts。
- **D02 已实现**：`cd6c4ff87c` 公共解析、`ac00daec9c` Composer、`a3517b732f` Wiki、`e401dbcbb4` 定时及闲时只读保护、`f0047c4430` Bot。普通账号同模型/档位对应，只读结果不写原意图；长期任务配置与本次 run 分开，既有 run/历史不改。
- **明确不恢复**：D01 发送前远端强制同步；旧 Account-first/套餐首模型回退；闲时跨账号自动换 Provider/Ticket；显式 Subagent 自动对应（用户本轮确认保留 Agent 原校验，后续单独设计协议）。继承型 Subagent 不改。
- **提交补漏**：`524f1ba2e5` 领取/账号、`e99d1ee193` 非法导航、`5278ed453b` OAuth 启动检查 pending Start。R09 Goal 恢复提交为 `e406c20fbf`。

### 最后验证与复查

- 推送前扩大检查追加：2026-09-07，关联测试 2299 通过、4 失败，推送被拦截；定向复现仍为 4 失败。两个 Server 物化断言使用旧 Built-in `matchRules` 字节格式，stdio 装配 fixture 在 Personal 配置中写入已禁止的 `matchRules`（运行日志明确 schema 拒绝），Account Source 测试仍把非 current 的已授权 Start 当作无权益。处理约束：仅更新当前格式 fixture 和已裁决权益断言；保留不可变版本文件、损坏拒绝、远端身份贯穿及非当前连接不执行的原目标，不放宽生产 schema 或恢复旧权益门禁。完成结果在验证后追加。
- 修正后这三个文件 **6/6**，相邻 materializer/Account resolver 扩大 **46/46**，typecheck/lint 通过。Account Source 新增同快照 `entitled=true/current=false` 断言，避免只改期望值而丢掉当前连接边界。stdio fixture 内原有未提交的 `supportsJsonSchemaOutput` 单行更名属于本例正式 schema 前提，随这次 fixture 修正一并提交；其他并行更名不纳入。仅测试/记录改动，无新增产品交互，沿用前述 Air 行为证据；推送仍须完整 pre-push 检查通过。
- 第二次推送通过前五批关联测试后，在更大 UI 关联批次发现另两文件 16 失败（该批 9017 通过）：Subagent 15 条旧断言仍要求缺失/失效档位自动补 high/max/disabled；权益缓存 1 条断言依赖嵌套快照 JSON 的未转义字符串。定向 16 失败可复现；按照既有 Selection spec 保持未选档为空、手动选档再保存，并保留已有明确 high/max 的保存及失败回滚测试。缓存改验实际请求身份 `planKind`，Provider/Team 身份隔离断言仍保留。无生产组件或显式 Subagent 账号对应变更；按 React 规范复查只读派生与保存边界后，两文件 **41/41**、typecheck/lint 通过。提交后重新运行完整推送门禁，不将分批成功当整体通过。
- 第三次推送：上述大批次已通过，第八批再发现 `modelThoughtOption.test.ts` 一条同类旧默认 max 断言（该批 3040 通过）。改为缺失值空，并补合法 high 保留/非法 medium 置空两条，不改公共控件实现。预先执行余下三批分别 **366/366、638/638、661/661**；typecheck/lint 通过。期间与其他批次并跑的一次 Subagent 乐观状态断言得到 high 而非 max，单文件复跑 **35/35**；保留该偶发记录，未放宽断言，也不宣称已定位原因。
- Air 重新构建，`desktop-e2e-20260907070548318-p30080-06b6be60d739cc50`：领取/设置 4、Hook 6、附件 1、Goal 1，共 **12/12**。不是只读类型检查。
- Air `20260907065952975-p28059-0bad7191e84258e7`：SR87 Composer/定时后台 **2/2**，后者独立准备账号，不依赖前一 case；请求与 run/原配置分别校验。
- SR87 最终独立回放 `20260907072021631-p34243-aef47a1b1507ff9a` **2/2**；Account 数据面捕获 3 条请求，3 条响应均含 case-local fixture 的唯一消息 ID `sr87-effective-selection-main`。同时把回复断言改为实际助手返回文本，不再匹配用户正文内的 reply token。
- fixture 复查发现：此前 `20260907071558076-p32629-60b040d8ce1d421b` 虽然 **2/2**，显式装载的 DeepSeek fixture 并未被 Account 请求消费，因此它只能证明行为通过，不能证明独立 fixture 命中。现已让该 spec 的 Account 数据面读取同一 case-local SSE，其他 spec 继续原响应；以上最终抓包补齐消费证据。fixture 校验通过，变量名/草稿标记与前缀 matcher 的扫描 warning 保留。首次独立命令另有路径前置错误：runner 按仓库根解析，修正为 `packages/desktop/...` 后解除 ENOENT；未进入 case，不计产品失败。
- Air `20260907070214992-p29305-2647349615bc9fb5`：Bot 新有效/失效选择 **2/2**，原交互卡/流式卡/终态回推 **5/5**。新 Bot 用例是受控服务集成，不宣称飞书线上网络或真实模型 SSE。
- Air 其他入口：Wiki 生成 **1/1**、闲时管理 **2/2**（`063653634-p19967-a275f6886f7e448a`），Automation 管理 **1/1**（`063339125-p18513-c886f019298e39aa`）。账号/Ticket 更细组合由单测守住，不据此声称跨账号续票通过。
- 最后扩大单测：Provider/Facade/Hook/Draft **224/224**；Automation/Off-Peak/Bot/Root OAuth **220/220**。Wiki 最后 **75/75**；之前 R01～R12 每组的单测证据见对应行。root typecheck、lint、E2E typecheck 均通过；lint 40 条原有 warning、0 error。
- 两个 revert 的并集再次机械核对：**65 文件，索引遗漏 0**。再查人工 SessionPane、混合 node.ts 及后补提交，未发现未经裁决的新缺口；模型原意图写入、fixed run、Bot 菜单、Wiki 补页、Off-Peak 校验在派发前的边界已反向检查。
- Feature Graph YAML 可解析；本轮新增两个代码种子文件与符号存在。全图另有 12 个既有失效路径，未扩大修整；codegraph 不可用，不把此结果当完整图索引通过。

### 仍需知道的边界

新 E2E 尚未人工转正，也未据本次结果宣称全量 Desktop、真实手机、所有 SSH/WSL/Docker 组合完成上线回归。历史偶发失败、前置条件错误均留在时间记录中，没有把复跑通过冒充已定位每次失败。启动个人权益无法确认后改选 Team 在固定 staging 也存在，本轮不新增启动策略裁决。

当前源码仍叠加其他任务的未提交命名/迁移改动，均保留；本轮提交按文件/hunk 隔离。Air 隔离 repo 的 Git metadata 仍为 a43049c265，实际受测为本工作区明确同步的源码，不将该 metadata 或任一单独提交冒充受测完整树。没有 push。

## 固定证据

- staging 基线：`16d999f6a4`；合并 `aaa68edbca` 的第二父提交。
- 第一父提交 `88fdfc34e0` 是原当前分支，包含先前人工移植；不能把它当 staging。此前调查曾以第一父提交作比较，相关判断以本表更正为准。
- `7016d1e09a` 撤销合并，50 文件；`cb16b3c8fd` 撤销插件混合提交，15 文件。
- 人工处理 `0ed79bae57`；插件 UI 后补 `2ee9b8d0c6`。其他后补沿每组历史核实。
- 不能用 ancestry 证明功能保留，也不能把当前与 staging 的全量 diff 都当误删。后续 staging 不在本轮范围。
- 时间校正（提交时间转北京时间）：2026-09-04 14:13:05 人工处理 SessionPane，14:18:49 合并，14:24:03 撤销合并，14:29:48 撤销插件混合提交。审计不是按“今天中午”的相对记忆选范围。

## 功能裁决与实施

| 编号 | 原意／来源                                                                                                           | 当前结果及裁决                                                                                                                                    | 实施／证据／下一步                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01  | Hook 阻断原因与详情：52287597d0、8bf8aa2715；7016 撤销                                                               | 无 Provider 冲突，直接保留                                                                                                                        | 已恢复 Core 生命周期、Bootstrap 投影、协议和 UI；19 条定向测试通过；Air 181201-837 整组 6/6 通过，包含阻断、失败详情、Stop 上限和 compact 首轮隔离                                                                                                                                                                                                                                       |
| R02  | 主会话和侧栏短消息自适应宽度：7016 撤销                                                                              | 无产品冲突，直接保留                                                                                                                              | 已提交 6f0eaeaf66；Air 023154 附件布局完整通过，包含 gallery 与失败图片占位。本轮随领取组重新构建复测，旧“待 Air 解锁”已解除                                                                                                                                                                                                                                                             |
| R03  | MCP 探测不阻塞插件卸载；空闲回收和进程归因：b9118cc192、原始 17abce059e；cb16 撤销                       | UI 后补并未恢复服务进程隔离。当前 mcp/list 与 plugins/uninstall 共用串行连接，是真实遗漏；直接保留                                                | 从原提交只恢复 MCP 专用 manager、请求归零事件、5 分钟空闲回收、lane 协议/监控字段及释放；不导回混合提交中的旧 Provider 实现。4 条子进程测试先红后绿，完整 service 45/45；已独立提交 996787bc11                                                                                                                                                                                           |
| R04  | Helper 恢复不能重启普通 Agent：44da9e013d 和 producer 95ca9ede；7016 撤销 pin/测试，Host 人工移植漏接 | 与 Provider 无冲突，已恢复 Helper/Agent 生命周期隔离                                                                                              | 已提交 b09a43f2b9；原子 bump 到固定 producer，Host 配套恢复。Linux/Air 各 35/35；Air 原生模块及 Desktop/CLI 构建通过。旧网络阻碍已解除，不再保留为当前阻塞                                                                                                                                                                                                                               |
| R05  | 普通 E2E 不注入触发真实 401 的假 JWT；专项保留 JWT：7016 撤销                                                        | 保留；兼容当前 Personal-only 无账号 fixture                                                                                                       | 已恢复普通 OAuth 展示态的 JWT 过滤，保留当前无账号用例；恢复专项测试；与 R02/R06 合跑 51 条通过                                                                                                                                                                                                                                                                                          |
| R06  | 领取 mock 支持失败、下轮活动和服务端时间：7016 撤销                                                                  | 直接保留，避免成功/失败状态泄漏                                                                                                                   | 已恢复并提交 5e5495f162；与 R02/R05 合跑 51 条通过；Air 023950 领取 4/4，本轮扩展连续领取再验证                                                                                                                                                                                                                                                                                          |
| R07  | 领取卡轮询、结果动作、复制分享、server_time：固定 staging 的 Banner/Dialog/helper                                    | 固定 SHA 中“立即体验”代码存在但默认 false，默认“模型设置”；当前额外启用它不应保留。staging 分享为直接复制文字，当前恢复成旧图片菜单也属于反向回退 | 已恢复默认模型设置入口、直接复制、预览请求代次/过期回包隔离、失败后下一活动窗口、登录刷新与秒/毫秒边界。修复 Sidebar 丢失 section intent 和连续领取迟到回包竞态。提交 `524f1ba2e5`；Air 领取 4/4，相邻单测 568/568；`e99d1ee193` 进一步收紧弹窗点击范围，最终 Air 领取仍 4/4                                                                                                             |
| R08  | Account/Start 独立权益、设置入口和非法导航：Todo83 与旧 family 文档                                                  | **不能按 Todo83 标题“已实施”认定完成**；其末尾只完成领取门禁，收缩了原方案。接续原裁决，不恢复旧 Provider Store                                   | `524f1ba2e5`：Account State/Overlay 同 revision；独立 Start/个人查询、具体 Team 身份；pending 可查看无执行资格，current 仅约束账号 Registry；空模型白名单及同身份快照隔离。`e99d1ee193`：未知导航显错并消费，保持页面可操作、不写连接偏好。Air 最终领取/导航 4/4；相邻 UI 208/208、typecheck/lint/E2E typecheck 通过                                                                     |
| R09  | SessionPane 发送时模型/mode/附件一致，切换最新值、草稿持久化：0ed79bae57                                             | 旧 config CAS 的发送目的已由原子 Submission 取代，不能整段导回旧 scheduler；查到 `/goal` 独立遗漏                                                 | sendText、预热、firstInput、附件和队列保留冻结的 Submission；但 slash goal 在等待后重读 Composer。新增用例先失败（low 被 high 覆盖），再把同一 Submission 传入 slash 分发；continuity 8/8 通过。Side Conversation/分叉及 D01/D02 另列核实，不扩大自动选模                                                                                                                                |
| D01  | 发送前强制远端 Registry 同步及 notInRegistry 重试：f0edfd69cf、0ed79 删除                                            | **已裁决：不恢复**                                                                                                                                | 保留连接/保存触发的现有同步；发送不等待最新配置，不新增 Renderer 同步或 notInRegistry 重试                                                                                                                                                                                                                                                                                               |
| D02  | 账号切换后自动改已有会话模型：6ce53c6ec4、0ed79 删除                                                                 | **已完成：Todo 87 统一有效选择解析**                                                                                                              | 普通账号按当前连接匹配同模型/同档位；有效结果临时派生，原意图不随读取改写。公共层/Composer/Automation/Bot/Wiki 已分别提交及验证；闲时仅保护原意图。不恢复旧批量切模或 Account-first，显式 Subagent 按本轮裁决排除；证据见最终审阅入口                                                                                                                                                    |
| R10  | Output token 相关请求与测试                                                                                          | 当前是等价架构替换，不恢复旧字段二次改写                                                                                                          | 正式 Built-in Map 在 zcode-builtin.json:1802/1814 分别为 Anthropic max_tokens、OpenAI Chat max_completion_tokens。OTB fixture 是 OpenAI Chat，断言与其 Map 一致；adapter 的 model-output-tokens-wire 测试证明不会按 Snowflake 名称偷偷改写 body。本轮与 Session 测试合跑 50/50 通过；不展开 Todo80                                                                                       |
| R11  | Markdown 选择/来源、浏览器隔离、插件 UI、配额标题等已移植功能                                                        | 固定范围的独立生产实现已保留；未发现应再整文件还原的差异                                                                                          | 检查 70a2e4d5dc、39f4f614ce、b30c53df5d、626f939c29、dad6ad8856、52684e5fa0、c4bd934a37、24f6e1e191、ec9b6d05bd、b12864b981 的最终文件。Markdown 引用/面板、browserGuestManager/弹窗隔离、opencode-session、空 reasoning blocks 与固定 staging 相同；插件 UI 与 2ee9 恢复后相同。StatusCards 配额字号保留，变化为新 access/Team 身份等适配。13 文件 234/234 通过；不以此冒充桌面行为验收 |
| R12  | 其他人工冲突处理及混合 node.ts                                                                                       | 已逐 hunk 阅读 node.ts 对固定 staging 的差异；唯一确认的独立遗漏为 R04 CUA                                                                        | ProviderRuntime/Config/Provisioning、账号请求鉴权、Bot 新 Selection 迁移属于现架构；旧 ZAPI probe/signing 删除符合既定产品裁决。Git/RepoWiki 使用目标 Host 选择、Official MCP/Off-Peak 使用当前凭据边界；Hook/trust 仍保留。不要把 node.ts 整体回滚，不把后续 WSL/Installer/Help 变更算此次遗漏                                                                                          |

## 每次验证与工程决策

### 2026-09-07 新目标续接

#### D02 当前进度（下方早期阶段记录按时间保留）

- 07:01 UTC：Wiki 已独立提交 `a3517b732f`；新增生成解析有效配置，既有失败补页沿用冻结配置。Air 后续 `20260907065130921-p25386-8424c12abe0001c7`、`20260907065253859-p26073-35dc905d91f2ac90` 的 SR87-01/06 均 2/2。测试选择连接后等待该次设置保存完成再返回，不增加生产发送同步；再次让 SR87-06 自行 seed/restart，`20260907065952975-p28059-0bad7191e84258e7` 仍 2/2，消除 case 顺序依赖。
- 启动 Individual -> Team 对照：固定 staging `oauthProviderFamilySelectionRefresh.ts:242` 同样仅明确保护 Start/Team，个人查询 unknown 后调用 automatic selection；本轮日志明确为无可用授权，再选已订阅 Team。该现象不是 Todo87 新增回退；本轮不扩大为重设启动套餐策略。相关 pending Start inspection 查询修复独立保留，临时诊断日志删除。此前一次手动选 Individual 失败不能单凭后续通过宣称已定位产品根因；条件等待修正与该失败均留档。

- 显式 Subagent 已经用户二次裁决：本轮保留原校验，后续单独接入协议；不做仅设置页生效的半套对应。Agent profile.modelSelection/父 Runtime 的固定选择边界保持。此项明确排除，不能写成已完成自动对应。

- 公共层已独立提交 `cd6c4ff87c`，未推送。显式 Subagent 本轮保留原校验的用户裁决已同步 Todo87 和影响表，不能再按已自动对应计数。
- Composer 独立提交 `ac00daec9c`。Air `desktop-e2e-20260907063653634-p19967-a275f6886f7e448a`：闲时管理 2/2、Wiki 生成 1/1。Wiki 档位菜单已捕获真实 option 后选择 disabled，真实生成产物通过；不是跳过门禁。Wiki 最后定向单测 75/75。
- 2026-09-07 06:49 UTC：定时后台 SR87-06 在 Air `/tmp/todo87-automation-run-air3.log` 通过：先以 Individual/high 保存任务，切 Team 后从列表直接 Run now；SQLite 长期选择仍 Individual，同 run 固定 Team/high，真实 Agent 请求同模型/high。没有经过编辑页提前重写。该组 SR87-01 本次启动后切 Individual 未出现模型项，1 通过/1 失败，不能计为整组通过；继续调查启动恢复/手动切换时序。前两次 SR87-06 前提失败分别为错用菜单 role、未用统一 encodeCustomModelValue 转义 Account ID，已修正测试。
- R08 追加发现：OAuth 启动/登录恢复仍用 entitled 执行身份查询套餐，漏了 pending Start 的独立查询。针对该边界测试先 2 失败/13 通过，改用 inspection access 和明确 planKind 后 18/18；此改动不等于已解释 Individual 启动变 Team，后者仍未收口。临时诊断不含密钥，结束后清理。
- 当前扩大检查：Automation/Off-Peak 113/113，Bot 92/92；root typecheck 与 lint 再过（40 warnings/0 error）。Bot 档位菜单也按同一原意图解析，避免先把失效副本变空，再误用 preferred 的二次解析。
- 2026-09-07 06:35 UTC：Composer/Bot/控制面隔离回归 12 文件 223/223，root typecheck、lint 通过。Air `desktop-e2e-20260907062148638-p15078-fcbb3b7c53d556ac` 再次通过含逐字段 accepted 校验的 Composer；`desktop-e2e-20260907063339125-p18513-c886f019298e39aa` 的 Automation 创建/编辑/暂停/恢复/删除通过。该表单用例此前误把会话选择当全局默认，现显式选择模型/high，不改变产品默认规则。
- Bot 菜单补齐：`/model`、模型分组和档位菜单展示有效副本，主动修改档位时以所展示模型保存；查看菜单仍不覆盖原草稿。新回归证明当前 Team 标记和 Individual 原意图保留。原先仅状态/派发已接入，菜单属于 review 找到的实际遗漏。
- 闲时用例补充账号控制面与 OAuth 前提后已进入表单；网关 mock 不提供 Registry 模型，不能绕过真实模型授权。空首页本来没有 tab；已有任务才分 Scheduled/Idle。旧用例仍需显式选档位和从设置返回会话，不可把这些前提失败写成调度失败。
- Wiki 用例运行时确认停在“选择思考档位”；模型选择不会自动补档，继续补完整用户操作，尚未取得生成产物通过结果。
- Composer 已接按原意图读取的 View，正文/模式保存不覆盖自动派生结果，accepted ACK 采用有效选择时校验 scope 和原意图引用。最初 11 个文件 135/135 单测通过；真实请求证据见后续条目。
- 定时任务后台改为目标 Host 首次解析后固定 run；scheduler 和手动 runNow 不再提前冻结长期配置。同 run 已固定值直接复用。Repo/Host helper 66/66 单测通过；编辑页和后台真实 E2E 仍在接入。
- 闲时 list/get 对已有新 Selection 只返回临时 repair-required/schedulable=false，不调用 invalidate 写库；终态不新增失效诊断。原 Selection/Ticket 保留，执行前既有同账号校验仍在。17/17 单测通过；不承诺跨账号运行或换票。
- Bot 已接状态/草稿选项和首次提交统一解析，不修改已有 task 的执行选择；消息流/配置/状态 96/96。Composer、定时编辑、Bot、闲时合跑 346/346，root typecheck/lint 通过（40 warning、0 error）；菜单路径及真实后台执行仍需反查。
- Air `desktop-e2e-20260907060716154-p10707-86d63a7f6b7d2581`：SR87-01 1/1（10 秒），确认同模型/high 对应、正文修改不覆盖 Individual 原意图、真实 Agent 请求 Team/high、接纳后保存 Team。此前两类失败属于测试误判：套餐请求不经过 DeepSeek capture；JSON 字符串比较错误依赖对象键顺序。均保留失败日志并修正取证方式，不算产品 Bug 已修。随后 review 在 accepted 比较中发现同类键顺序风险，受控测试先红（1/14）后改为逐字段比较；需再跑 Air 最终版。
- Wiki：新生成和同 Wiki 补齐失败页明确分开。前者调用统一输入解析并固定本轮，后者沿用原固定模型。后台 60/60；旧服务测试显式补 disabled 档位并适配输入型 View，不在生产层为旧测试偷偷补默认档位。界面原意图/有效结果拆分、失效档位不补首档；扩大验证中。
- Wiki/Composer 扩大单测 14 文件 170/170；包括缺失档位控件不补首档、既有 Wiki 选择失效不退 preferred。相关旧测试只改 fixture 的显式 disabled 与读取输入，原未提交迁移改动仍属并行工作，提交时需按 hunk 隔离。
- Air 五 spec 合跑 `desktop-e2e-20260907061348889-p12123-1986382b2c0de733`：Composer、Wiki 设置通过；Automation 在项目菜单选择失败，Off-Peak 创建入口缺失，Wiki 生成前置 Ready 失败。多个 spec 会同时影响 runner 的 Built-in/Mock 装配，正在单 spec 隔离，不能先断言都是产品回归。此前表述“接纳未保存”已撤回：属于测试键顺序误判；生产同类潜在风险另有红绿单测证明。
- 闲时执行保护反查：`desktop/src/host/index.ts:dispatchOffPeakRun` 先 `runtime.validateSelection`，失败抛模型不可用，之后才 `buildRequestAuth(ticket)` / createTask / resumeTask。因此只读列表不写 invalidate 并不放开错误模型执行；还需 Air 与调度回执证据确认用户路径。
- Air SR87 初版手写 localStorage 后 reload，原意图未保留，失败在前置选择而非账号转换。改用真实菜单后发现启动恢复已将 seeded Individual 改成 Team，Individual 无法选中；日志有个人 entitlement `未找到可用授权` 后写 Team。不能据此断言账号切换已通过。新增独立排查项：检查 OAuth 启动恢复的个人授权/快照时序及与固定 staging 的差异；测试则通过设置页主动选 Individual 建立切换前提。仅在隔离 repo/profile 操作。

- 起点 `5de4909268`；用户已删除旧目标并授权重新建立目标。范围为固定 staging 的 Todo 85 完整恢复及已裁决 D02/Todo 87 替代实现；不合后续 staging、不展开 Todo 80/86、不自动 push。
- 顺序：先 review/验证/提交 R07/R08 领取与账号组，复查其余 R 项的当前结果；再按 Todo 87 分阶段实施，每步测试及 review 后推进；最后核对全部去向和证据。遇到新语义冲突记录并讨论，不将普通技术适配反复交给用户裁决。
- 新鲜度检查通过；当前工作区有 73 个已跟踪修改文件及未跟踪 Account State 文件，包含并行命名/迁移/测试改动。提交前按 hunk 核对归属，不整包提交，不清除既有工作或临时测试产物。
- 上轮通过结果是历史证据；本轮变更后需要补相应验证。仍采用 Air 已存在的隔离目录，不操作日常账号配置或真实领取。当前无未决产品裁决；待实施不等于已完成。
- 04:40 UTC：R07 最终 review 找到迟到权益跨弹窗竞态。关闭第一项领取结果后可开始第二项，第一项慢回包仅按 success 判断而修改第二项生效时间，旧 finally 还可能解除第二项 busy。新增受控交互测试先红（第二项 pending 被改成 available），再以领取代次隔离旧回包/finally，测试转绿。此为已裁决刷新行为的正确性修复，无新增产品语义。
- 04:42 UTC：Provider/领取相邻 23 文件 568/568；root typecheck 通过、lint 40 warning/0 error。两个 revert 的 65 个唯一文件均仍在索引中；索引覆盖不代替行为 review。
- 04:43 UTC：Air 隔离目录重新同步当前受测源码与新增 Account State 文件；保留其 Git 基点 a43049c265，因此构建元数据 SHA 不能冒充当前代码 SHA，实际受测内容为本地 5de4909268 加当前工作区变更。标准 runner 重建 Desktop/CLI，运行领取、Hook、附件、Goal 四组；新增连续领取 Electron 断言，精确迟到时序由上述受控组件测试证明。不使用真实领取接口。
- 04:46 UTC：Air `desktop-e2e-20260907044332070-p90173-23c38c1cfe5c5b34`：领取 4/4、Hook 6/6、Goal 1/1；附件在 hover 删除按钮断言失败。04:50 单独同源码复跑 `desktop-e2e-20260907045002060-p92356-50ad667e8d5d8bf0` 附件 1/1 通过。保留偶发失败，尚无证据归因为产品、外部指针干预或驱动；未通过放宽断言掩盖。
- 04:55 UTC review：WorkspaceSidebar 大量差异为格式化；用原 HEAD 仅补新增 imports、模型设置回调及 Banner prop/dependency，和当前文件比较转译后语法节点（忽略冗余括号）一致，没有带掉其他 Sidebar 行为。R08 当前覆盖的是非法持久连接；`resolveCodingPlanIntentProviderId` 对未知导航 ID 返回 null，调用方静默忽略且 pending prop 不消费，是另一项已有裁决的遗漏。先提交已验证的领取/账号恢复，随后补该导航错误链及 E2E。
- R07/R08 主恢复已独立提交 `524f1ba2e5`（49 文件）；没有 push，没有带入并行迁移命名或 Todo86。
- R08 导航补漏：未知指令只置页面错误并消费，不写连接、不清除正常页面；有效指令/用户重选清除此错误。Air `045559541-p93554` 先红于缺少错误提示；`045911831-p94914` 修复后 4/4。失败现场同时暴露测试点击未限定弹窗：背景 Settings 导航也叫“模型设置”，可能绕过领取卡主动作。已限制最上层可见 dialog/alertdialog 并断言结果关闭；最终 `desktop-e2e-20260907050155506-p96150-bc4f03dcf14068fa` 领取 4/4，确认真正关闭结果、合法/非法导航及持久连接不变。相邻 UI 208/208，root typecheck/lint（40 warning、0 error）与 E2E typecheck 通过。
- D02/Todo87 基础层：新增纯解析、Facade 同快照解析、Service 按输入返回以及公共 hook 输入隔离。API 首轮 2 条失败、hook 首轮 2 条失败后修复，追加首读重试用例；当前 Provider/Facade/Runtime/hook 合计 204/204。未接入 Composer/任务，不能算用户体验完成。Runtime 装配测试原本没有 Configured Default 却期待自动首个模型，与 `a43049c265` 已取消该行为冲突；本次给 fixture 显式配置默认选择，保留装配断言，不恢复旧产品规则。
- D02 读取重试：未找到适合 browser-safe 只读/可取消场景的现成 retry utility；在现有公共 hook 内统一首读重试 2 次（500/1500ms），仅明确临时 IO/fetch 错误。鉴权、配置、dispose 和普通不完整结果不重试；成功/换输入/换 Host/卸载取消。该计时不是等待同步或模型就绪，更不触发领取/写入/派发重试。
- D02/Todo87 开始实施：正式 Selection spec 与 SR87 catalog/matrix 已登记计划；纯解析先写测试，模块缺失时套件红，实现后 Registry 文件 10/10。这只是算法阶段，Host/hook/Composer/后台入口尚未接入，不算 D02 交付；后续记录继续按入口列证据。

### R08 接续方案（沿用 Todo83 已裁决的层级，不新增持久化）

```text
Family 连接偏好 + 账号查询
   -> Account 状态（availability/current/effectiveAt）
      + Account Config Overlay（entitled/模型成员）
   -> 同一 Account Source 快照、同一 revision
      -> Settings 可查看 pending/非当前连接
      -> Registry 仅接纳当前连接的可执行模型
```

保留 `current` 为运行时事实，Off-Peak 没有 current；未选中的套餐不再因此被写成无权益。
未知查询保留同账号上一份事实；明确 pending 清除可执行资格但保留生效时间；空模型清空模型成员，不复用旧白名单。
套餐展示查询不应要求该套餐已是当前模型请求连接；只读查看与执行期凭据检查分开。
Team 没有具体组织/项目身份时不得任选团队猜权益，保持未知并由既有订阅产品入口提供具体身份。

- 16:43 MCP 原测试在恢复后的当前契约运行：4/4 失败，分别为卸载阻塞、缺生命周期、缺回收、重试连坐插件进程。16:52 恢复后 4/4 通过，真实子进程 fake transport，无真实模型请求。
- 16:53 CUA 原测试：35 条中 4 失败；证实既有 producer 仍轮换 broker、调用 Agent 回收，Host 文案也是旧 recycle 语义。原测试支持恢复原行为，不降低断言。
- 16:54 E2E 启动凭据、领取 mock、消息气泡单测：3 文件 51/51 通过。
- 先前 Hook 定向 19/19 通过；全链类型检查被 project-memory-recall.ts 的 supportsJsonSchemaOutput 缺失阻断，尚未归因，不能标全量通过。
- Air 当前 /Users/dev/Desktop/projects/z-code-e2e 位于 fed3705326，含 7 条未提交/未跟踪改动，不能 reset 或覆盖。需用独立验证工作树；Node 通过 /Users/dev/.local/share/mise/shims。
- 为恢复固定 CUA producer 创建临时目录 /tmp/zcode-todo85-producer-1N45YP；不修改用户账号数据。
- 17:06 领取/余额相关测试 146/146 通过；恢复前服务时间测试 5 失败/94 通过。不是仅改断言，生产边界现统一输出毫秒 serverTime，effectiveAt/startsAt 仍为 Unix 秒。
- CUA producer 拉取：本机代理 HTTPS 握手失败，直连与 Air 连接超时；尚未改 pin，继续其他独立恢复。无系统网络配置变更。
- root `pnpm typecheck` 已通过；`pnpm lint` 0 error、40 条既有 warning。先前 CLI core 检查缺 supportsJsonSchemaOutput 是待重建声明：Air 按标准构建 shared-types/contracts/core/adapters/bootstrap 后已通过，不修改正确的接口源码。
- MCP 全文件 45/45 通过；已确认卸载/探测隔离不只是四条专项通过。
- Air 隔离工作树：`/Users/dev/Desktop/projects/zcode-todo85-verify.ljqwZv/repo`，基于 a43049c265 加当前受测 diff；原 E2E 工作树与日常应用数据未覆盖。安装使用 `pnpm install --offline --frozen-lockfile`；源 bundle/patch 位于同级目录，本机快照在 `/tmp/zcode-todo85-air-snapshot-17aUUe`。标准构建已成功。
- Air 首轮 `desktop-e2e-20260906-171733-561`：3 specs 失败。领取 spec 加载发现已删除的 Start 数量快捷入口常量；Hook/附件因测试仅写 Recent、当前持久草稿仍为空而无法发送。不能降低断言：恢复快捷入口上下游；公共 prepare helper 在新草稿上真实选择模型及档位，skipProvider 分支不变。第二轮验证中。
- Start 数量快捷入口恢复：原固定 staging 的 Header、Detail、文案和测试一起被删除。已加新架构下的显式数量 props，复用现有 onSelectNavItem，不恢复 API mode 或 enabled 标签。新增显示条件测试先红后绿；完整 modelProviderCodingPlan 197/197 通过。
- Air 第二轮 172426：7 条仍失败，Hook 首发错误进一步定位为 `fault.command.executionFailed`。第三轮隔离 HK-LC-01，Agent 日志确认 Registry 有 2 个 Provider，但新建 Runtime 强制要求 Configured Default；与当前“无默认选择也可打开空白会话、提交前显式选择”的规则冲突。R09 补齐创建/提交边界：允许未绑定 Runtime，执行校验保持，不自动补模型或 reasoning。新增测试修复前 1 失败/8 通过；正在验证修复。
- R08 第一轮定向 6 文件 93/93 通过；包含 pending 秒时钟、独立查询、空模型、状态与 Overlay 同轮发布及设置页查看。Provider 全量 374 条中 2 条旧 Personal match 测试失败；Todo76 已明确禁止 Personal match，这两条不靠恢复旧规则修绿，另记录为测试契约债。
- 17:52 Air `175145-973`：HK-LC-01 通过。前两轮真实失败定位并修复两道错误门禁：Runtime 强制 Configured Default；V4 创建记录后仍生成随即丢弃的旧版 snapshot。V4 改走同一初始化/清理流程的 record 投影，不修改旧协议 snapshot 契约；新会话可未绑定，实际发送仍要求有效 Selection。Runtime 44/44，V4/恢复/请求体专项 50/50 通过。
- 17:57 Air `175533-938`：Hook 整组 4/6；后续 case 新草稿未显式选择、沿用旧 Recent 假设。已补 case-local 真实选模；附件用例 seed 明确图片能力，未扩展普通文本 fixture。复测中。
- 18:00 手工标准构建缺 E2E Store Bridge，runner 在 onPrepare 正确拒绝；这次没有实际执行 case，不算产品失败。改回 WDIO 标准构建入口注入仅测试用 bridge；没有修改生产构建默认值。
- 18:01 Account/导航 222/222 通过；设置读取失败原测试要求 null，会让详情永远 loading，已按既定兜底裁决改为明确错误与同 Family 可操作入口，不自动改变连接。补同账号 last-known-good 隔离测试：切账号/Team 后 unknown 不沿用旧权益（新增测试先红后绿）；不新增持久化。
- R09 Side Conversation/分叉：当前命令由 CLI 创建 child，UI 保留 workspaceIdentity/remoteSessionId、父子关联、选中文本引用和首条输入；fork 继续带 revision/logEpoch CAS。没有恢复 Renderer 提前改 Runtime 模型；CLI 原生 Side/Fork、未绑定恢复及 wire 测试合跑 50/50。Desktop continuous 与 Web replayable 命令边界保持，单测不冒充手机真实交互证据。
- CUA producer 18:00 再次只读 ls-remote 超时；仍未改 pin，R04 不标恢复完成。
- 18:08 基线新鲜度复查被远端 fetch 连接关闭阻断；没有据此修改固定审计 SHA，也没有合入后续 staging。
- 18:10 领取真实 E2E 发现点击“模型设置”实际落到 General。WorkspaceSidebar 合并后丢失 section intent；已恢复 modelProvider 导航意图，带当前 Start Provider ID，只查看、不更改 Family 连接。181004-765 复测已通过导航、领取余额刷新，停在后续 Subagents 的旧 Family 分组定位；将定位改为当前 Registry Provider 身份，保留套餐标记及模型候选断言。
- 18:12 Hook 全组 6/6 通过（181201-837）。失败详情 case 隔离通过、连跑时的 10 秒清空等待却早于 Hook 执行完成；改为有上限的 60 秒条件等待，没有固定 sleep 或更改产品清空时序。全部 case 实际约 15–16 秒。
- 本轮 Account 隔离/导航、MCP、Composer continuity 五文件合跑 276/276；root typecheck、lint 再次通过。CLI Side/Fork/未绑定创建/输出请求四文件 50/50；不把 root unit 的 CLI 排除范围当已执行证据。
- MCP 恢复独立提交 996787bc11，未包含并行工作或未通过的 CUA producer 修改；没有 push。
- 18:27 机械核对两个 revert 的 65 个唯一文件，全部在逐文件索引有对应功能行，无漏项；索引覆盖并不等于各功能均已验收。
- 18:28 本地扩大复查发现三条旧断言：领取只读查询仍断言旧 access config；两条 Resolver 测试仍构造已禁用的 Personal 全局 match。前者改为正式查询的 family/planKind；后者保留 Built-in 完整字符串匹配和 Personal 精确覆盖的原测试目标，不恢复旧生产规则。之后 Provider 全包及相邻服务/UI/同步协调器 25 文件 581/581。
- Air 181938-851 明确显示 Start 候选为 `account:bigmodel-start-plan/glm-5.3-flash`，旧测试期待大写。Start capability 与个人静态模型身份不同；修 fixture，不在生产中按显示名改写真实模型 ID。
- Air 附件请求实际有 image/base64/png，只有原始图片文件名不在请求中（转换为 image-cache 路径）。两处回放改匹配图片载荷；界面文件名、编辑、主题、窄屏及 gallery 断言未删除。182129-016 已到最后失败图片场景，尚非整条通过。
- Air 在北京时间 02:21:58 锁屏（IOConsoleLocked/CGSSessionScreenIsLocked 均 Yes）；182421-628 三个 worker 均未创建 WebDriver session。不能当三个产品失败，也不能因外层命令 exit 0 就当成功；没有完成报告。不尝试绕过锁屏或修改机器安全设置，停止反复启动。
- CUA 18:26 补查 SSH 22 也超时；本地/远端无已验证的目标 producer 克隆可用于原子 bump。18:30 将本轮 node.ts 的 CUA hunk 暂撤回，避免半套新旧生命周期混用。仅保留恢复测试/spec 与明确 SHA 依据。

## 本轮停留点与后续动作

### 2026-09-07 恢复执行

- 02:31 UTC：Air 已解锁，Git 访问恢复，基线新鲜度检查通过；未合入后续 staging。继续使用原隔离测试目录，先核对三份 spec 和附件 fixture 的 SHA-256 与本机一致。
- `desktop-e2e-20260907-023154-481`：附件布局整条通过（包括失败图片占位与 gallery 隔离），`/goal` 整条通过（包含首条请求 low 档位）；领取 3/4，综合 case 在轮询后找不到成功弹窗文案，继续抓取页面状态定位，不能标领取通过。
- R04 网络阻碍已解除：使用原子 `bump:producer 95ca9ede5f308c1fcf33ea1081da4d9550bd439d` 完成 catalog、lock、provenance 和契约同步，并恢复 44da9e013d 的 Host 专属改动。脚本基线检查及 Skill 校验通过；CUA 两文件 35/35。它只恢复固定 staging 对应 producer，不升级到远端最新 HEAD。
- CUA、消息布局和 Composer continuity 四文件合跑 76/76；root typecheck、lint（40 warning、0 error）及 desktop E2E typecheck 全部通过。CUA 配套改动后的 Air 构建和验证仍需补跑。

### 2026-09-07 最新结果及用户要求暂停

- R02 已提交 `6f0eaeaf66`，附件布局完整 E2E 通过；R09 `/goal` 冻结提交已提交 `e406c20fbf`，真实首条请求的 low 档位断言通过。
- R04 已提交 `b09a43f2b9`。Air 安装相同 producer 后，原生模块构建成功，CUA 两文件 35/35，并完成新的 Desktop/CLI 标准构建。Air 的 Git keychain 鉴权失败，使用官方仓库已核实 Git 对象的 bundle、本次隔离目录内 bare mirror 和单条安装命令的 URL 重写完成安装；未修改全局 Git 配置、未传送凭据、未改变依赖 pin。
- `desktop-e2e-20260907-023559-026` 单独领取综合用例已通过之前的弹窗位置，最终失败是 count 断言仅接受英文 Start Plan、页面实际为中文“体验套餐”；调整为接受两种语言，数量仍必须为 2。首轮轮询后成功弹窗缺失未再次复现，不能宣称已定位或用这次文案修订解释它；保留失败时页面状态采集。
- 新构建运行 `desktop-e2e-20260907-023950-099`：领取整组 **4/4**、Hook 整组 **6/6**，两个 spec 全部通过，没有重试。产物位于 Air `/Users/dev/Desktop/projects/zcode-todo85-verify.ljqwZv/repo/packages/desktop/.e2e-artifacts/desktop-e2e-20260907-023950-099/summary.md`。因此 R06/R07/R08 的前轮桌面阻塞已解除，但本次通过不等于穷尽所有账号场景。
- 本轮 Provider/领取相邻模块实际重跑 23 文件 **567/567**；与前轮 25 文件 581/581 分开记录，不混用次数。
- 当前未提交：R07/R08 领取、时间、账号实时状态和设置导航组；需要后续最终 review 与独立提交。D01/D02 仍待用户决定。此次三个代码提交均未 push；未合入后续 staging，未处理 Todo80/86 或原有无关工作区改动。
- 用户要求“干完手头的活先停一下”。已等上述正在运行的领取/Hook 测试结束，仅补记结果后暂停；不再启动新测试或修复，Goal 不标完成。

### 前一轮停留点（历史记录，以上述续跑结果为准）

- 已提交：996787bc11（MCP 隔离），22d5f63479（Todo/过程记录），e6d3674788（V4 未绑定创建），197dca353c（Hook 完整链路），5e5495f162（启动凭据与领取 mock）。未 push。
- 未提交但已实施：R02 消息宽度及附件 fixture；R07/R08 领取、时间、账号实时状态与设置导航；R09 `/goal` 冻结提交。保留工作区，不能因为已实现就将其标为验收完成。
- Air 解锁后：跑 `conversation-session-v4-attachment-layout`、`start-plan-manual-claim-experience`、`conversation-session-v4-goal` 三份 spec。Goal 已新增真实首条目标请求的 low 档位断言；异步准备期间不回读草稿的竞态由组件测试证明。不能把未运行的新断言算通过。
- 依赖仓库恢复可访问后：原子 bump 到 `95ca9ede5f308c1fcf33ea1081da4d9550bd439d`，并移植 44da9e013d 的 CUA 专属 Host hunk，运行 35 条恢复测试及基线检查。不得手改 pin、只改 Host 或忽略失败断言。
- D01/D02 已分析到可选择的程度，见下节；其他组不需要用户重新理解同事全部提交后逐一判决。
- 并行工作 `todo-86-provider-source-driven-refresh-draft.md` 及原有迁移/命名清理等未提交改动未纳入本轮提交；不清理工作区既有 `.lint-staged-vitest-*.json`。
- 18:31 最后一次 root `pnpm typecheck && pnpm lint` 通过（40 warning、0 error），`git diff --check` 通过；Hook Core/Projection 三文件 191/191、Hook UI 三文件 19/19，均另行实际执行。尚未运行全量桌面 E2E，不宣称此次合并事故已全部收口。

## 留待用户选择的两项（其余技术恢复不要求用户逐行裁决）

> 2026-09-07 后续讨论已裁决并实施：D01 明确不恢复，用户此前“可以恢复”仅指 D02；D02 不恢复旧事件驱动批量改写，已由 [Todo 87](../steps/todo-87-selection-view-unified-resolution.md) 承接。以下两节是原调查背景，不再表示待用户决定；最终结果见顶部。
>
> 同日用户补充：测试期间看到领取成功，并手动点击“模型设置”。这与首次成功弹窗缺失吻合，该次运行存在人工干预，不能作为已确认产品缺陷；没有足够证据精确关联那一刻，亦不宣称已定位。后续无人干预的领取整组 4/4 通过。

### D01：远端发送是否等待最新模型配置

原提交 f0edfd69cf。不是新增一套模型配置，原意是避免远端 Agent 重启丢内存 Registry，或保存后同步还没结束时，立即发送找不到模型。旧代码对发送、compact、重试、分叉等执行命令先同步，再交给 Agent；明确排除手机 replayable。

```text
当前：连接/保存 -> Environment 级同步（独立执行）
      点击发送 -> 提交当前 Selection -> 目标 Host 按当时 Registry 执行或拒绝

如恢复：点击发送 -> 等目标 Environment 当前配置同步完成 -> 提交同一 Selection
                    同步失败 -> 显示错误、保留草稿，不发送
```

现在并非完全没有同步：已有连接屏障、保存/账号/默认模型触发、同 Environment 合并与尾随刷新。但它不保证每次发送等待最新同步。用户先前明确接受这一短暂时间差，之后又提出可以恢复，故待再次确认。

建议如需要恢复，只增加现有同步协调器的目标 Environment 等待能力，不能从 Renderer 重新下发旧 RuntimeModel，也不能再按每个 Workspace 重复同步。当前 coordinator 没有公开等待某代成功的接口，且已连接后失败按降级处理；必须明确区分“等待结束”和“同步成功”。本轮没有擅自追加该行为。

### D02：换账号套餐是否自动替换已有会话的模型

原提交 6ce53c6ec4。原意是用户从已过期 Start 切到个人套餐后，旧会话不再显示/请求过期 Start；旧实现监听 Family 状态，自动向该会话发切模命令。

```text
当前：账号连接改变 -> Registry 更新 -> 原选择失效则留空，用户重选
如恢复：账号连接改变 -> 选新套餐内替代模型/档位 -> 改写已有会话选择
```

这不是仅补一个调用：必须决定替代模型、reasoning、未发送草稿与正在运行的会话如何处理。它与此前“无效选择留空、不静默换模型”的裁决存在真实冲突。建议暂保留现状；如果用户希望自动跟随，应另明确适用范围，不恢复旧 Family helper 的隐含回退。

注意 1ccf6f906e 不全属于这项：它的发送失败横幅、草稿保留、切 Session 清错误，在当前 SessionPane 已存在；它修复的“选 Start 却发送 Coding”由 R08 对当前连接的集中解析承担。这两项无须等待 D02 裁决，不能因为关联提交混合就一起丢掉。

## 逐文件索引

下列 65 个文件覆盖两个 revert 的并集。对应功能行负责原意、当前结果、恢复及验证；标待核实的组不能认为文件已收口。SessionPane 与 node.ts 的人工处理另见 R09/R12/R04。

| 文件                                                                                                      | 所属功能    |
| --------------------------------------------------------------------------------------------------------- | ----------- |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`                           | R01         |
| `apps/zcode-cli/packages/bootstrap/tests/product-projection.test.ts`                                      | R01         |
| `apps/zcode-cli/packages/contracts/src/hooks/index.ts`                                                    | R01         |
| `apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts`                                    | R01         |
| `apps/zcode-cli/packages/core/src/hooks/index.ts`                                                         | R01         |
| `apps/zcode-cli/packages/core/src/hooks/runner.ts`                                                        | R01         |
| `apps/zcode-cli/packages/core/src/hooks/types.ts`                                                         | R01         |
| `apps/zcode-cli/packages/core/tests/hook-runner-dispatch-admission.test.ts`                               | R01         |
| `apps/zcode-cli/packages/core/tests/hook-runner-lifecycle.test.ts`                                        | R01         |
| `apps/zcode-cli/packages/zcode-cua-plugin/upstream.json`                                                  | R04         |
| `docs/chat/conversation-hook-turn-summary.md`                                                             | R01         |
| `docs/chat/user-message-attachment-layout.md`                                                             | R02         |
| `docs/cua-permission-broker/2026-09-02-helper-lifecycle-agent-runtime-isolation-spec.md`                  | R04         |
| `docs/model-provider-family-merge.md`                                                                     | R08         |
| `docs/superpowers/specs/2026-08-14-cua-final-raster-integrity-contract.md`                                | R04         |
| `docs/testing/start-plan-manual-claim-e2e-coverage.md`                                                    | R07         |
| `docs/zai-start-plan-provider.md`                                                                         | R08         |
| `packages/desktop/test/codingPlanUpgradeMockServer.test.ts`                                               | R06         |
| `packages/desktop/test/e2e/conversation-session/hooks/conversation-session-hooks-lifecycle.test.ts`             | R01         |
| `packages/desktop/test/e2e/conversation-session/attachments/conversation-session-v4-attachment-layout.test.ts`        | R02         |
| `packages/desktop/test/e2e/helpers/coding-plan-upgrade-mock-server.ts`                                    | R06         |
| `packages/desktop/test/e2e/helpers/hooks-lifecycle-fixture.ts`                                            | R01         |
| `packages/desktop/test/e2eStartupCredentials.test.ts`                                                     | R05         |
| `packages/services/src/coding-plan-subscription/codingPlanSubscription.ts`                                | R07         |
| `packages/services/src/model-provider/zaiStartPlanBilling.ts`                                             | R07         |
| `packages/services/test/bigmodelUsageQuotaProvider.test.ts`                                               | R07         |
| `packages/services/test/codingPlanSubscriptionService.test.ts`                                            | R07         |
| `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`                                       | R04         |
| `packages/services/test/cuaPermissionBrokerProductMcpResolver.test.ts`                                    | R04         |
| `packages/shared/src/coding-plan-subscription.ts`                                                         | R07         |
| `packages/shared/src/test-ids.ts`                                                                         | R01/R06/R07 |
| `packages/shared/src/usage-stats.ts`                                                                      | R07         |
| `packages/shared/src/zcode-protocol-v4/rows.ts`                                                           | R01         |
| `packages/ui/src/ChatErrorBanner.tsx`                                                                     | R01         |
| `packages/ui/src/WorkspaceSidebar.tsx`                                                                    | R07         |
| `packages/ui/src/components/manual-claim-plan/ManualClaimPlanResultActions.tsx`                           | R07         |
| `packages/ui/src/components/manual-claim-plan/ManualClaimPlanResultDialog.tsx`                            | R07         |
| `packages/ui/src/components/manual-claim-plan/manualClaimPlanResultDialogTypes.ts`                        | R07         |
| `packages/ui/src/components/manual-claim-plan/manualClaimPlanResultPrimaryAction.ts`                      | R07         |
| `packages/ui/src/i18n/locales/en-US.ts`                                                                   | R01/R06/R07 |
| `packages/ui/src/i18n/locales/zh-CN.ts`                                                                   | R01/R06/R07 |
| `packages/ui/src/v4/ConversationHookDetailsAction.tsx`                                                    | R01         |
| `packages/ui/src/v4/ConversationRowView.tsx`                                                              | R02         |
| `packages/ui/test/chatErrorBannerHook.test.ts`                                                            | R01         |
| `packages/ui/test/manualClaimPlanBanner.test.ts`                                                          | R07         |
| `packages/ui/test/v4ConversationComposerErrorBanner.test.ts`                                              | R01         |
| `packages/ui/test/v4ConversationHookDetailsAction.test.ts`                                                | R01         |
| `packages/ui/test/v4ConversationRowViewUserEdit.test.ts`                                                  | R02         |
| `pnpm-lock.yaml`                                                                                          | R04         |
| `pnpm-workspace.yaml`                                                                                     | R04         |
| `docs/plugin-management-lifecycle-case-catalog.md`                                                        | R03         |
| `docs/runtime-tools/mcp-status-list-control-plane.md`                                                     | R03         |
| `docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md`                                         | R03         |
| `packages/desktop/src/main/desktopStabilityTelemetry.ts`                                                  | R03         |
| `packages/desktop/test/e2e/plugins/marketplace/plugin-management-installed-menu-layout.test.ts` | R03         |
| `packages/services/src/process/runtimeProcessLifecycle.ts`                                                | R03         |
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`                                           | R03         |
| `packages/services/src/zcode-agent/zcodeAgentService.ts`                                                  | R03         |
| `packages/services/src/zcode-agent/zcodeProtocolClient.ts`                                                | R03         |
| `packages/services/test/zcodeAgentService.test.ts`                                                        | R03         |
| `packages/shared/src/validation.ts`                                                                       | R03         |
| `packages/ui/src/components/ui/dropdown-menu.tsx`                                                         | R03         |
| `packages/ui/src/settings/PluginStoreCard.tsx`                                                            | R03         |
| `packages/ui/test/dropdownMenuContentWidth.test.ts`                                                       | R03         |
| `packages/ui/test/pluginStoreItemMenuSeparator.test.ts`                                                   | R03         |
