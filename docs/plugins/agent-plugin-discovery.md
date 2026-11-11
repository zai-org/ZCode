# Agent 官方插件发现与安装推荐

## 产品合同

设置页「插件自动推荐」默认关闭，旧配置缺省同样按关闭处理。关闭时完全不暴露对话中的插件搜索和推荐工具，用户明确要求时也不可调用；设置页手动搜索和安装保留。开启后，Agent 可在任务明显受益时主动查询官方市场。设置保存在应用设置中，经已有运行时偏好通道下发，由每次输入捕获，从下一条输入生效；不追溯中断正在执行的安装确认。这里在可信 Host 输入边界控制工具可用性，不靠提示词劝模型遵守；不改变已展示卡片的人工确认、已有插件可用性或自动 reload。搜索只返回可信候选，不安装；推荐卡片必须由有权限的用户明确确认。同一 session 首个有效答复生效，跳过和取消不触发安装。安装、会话重载、插件可用是三个独立事实。

```text
SearchPlugins → 官方目录快照 → 精确名称优先、BM25 → 候选摘要
SuggestPluginInstall → 当前连接能力校验 → CLI 待确认 → 桌面/手机回答
   跳过 → 记录工具结果，继续原任务
   确认 → 刷新并复核身份、动作、scope → 在目标存储根的锁内安装/恢复/启用
       → 保存工具结果 → turn 收尾、已接纳输入和活动工作完成
       → 生命周期控制器同步取得资格 → restart 同一 session
       → 恢复历史和订阅；下一条用户输入可使用新实例实际就绪的能力
```

## 工具曝光

两个工具均为 deferred 工具（`shouldDefer`），与其他 deferred 工具一样由 ToolSearch 公告名称、按需加载 schema，不常驻每次请求。上述设置与可信输入开关仍决定本轮是否进入候选集。暂不注入 Session-specific guidance 中的插件推荐提示，代码保留注释以便恢复。

## 检索与分页

每次调用只读取一次候选数组。排除个人来源、隐藏、退役及身份冲突后再统计；安装状态不加分。每页最多 10 条，返回 bounded 摘要、状态、stale 与 cursor。沿用官方目录刷新节流及在途请求合并，失败时可搜索旧目录，安装前强制刷新失败则不写入。

名称字段由 name、默认及所有语言显示名组成，词元去重；详情字段使用描述及翻译、分类和示例提示，完全相同的归一化字段值去重，保留实际词频。NFKC 后小写；连续汉字按相邻双字片段切分，标点与字段边界不跨越；其余连续字母、数字按完整词匹配。查询词元去重，单汉字仅精确名称匹配。完整 ID 不参加普通词频统计。先排完整 ID 或规范名精确匹配，再排显示名精确匹配，其他候选按分数降序，同分按原始 ID 固定顺序。每字段使用非空文档数与平均字段长度：idf = ln(1+(N-df+0.5)/(df+0.5))，贡献为 idf × tf × (k1+1)/(tf+k1×(1-b+b×len/avgLen))。名称和详情分别计算、权重 4:1，k1=1.2，b 分别为 0、0.75。空字段贡献 0。只保留精确或正分结果。游标绑定算法版本、完整归一化查询和稳定候选快照，拒绝跨查询、过期与越界游标。无持久化索引；不修改 ToolSearch 或页面拼音搜索。

## 多语言载荷边界

插件名称与描述的每个翻译表最多 16 项；语言键最多 64 个 UTF-16 码元，每项文本最多 4,000 个码元且 JSON 字符串的 UTF-8 编码最多 4 KiB；每张翻译表序列化后最多 24 KiB。默认文本保留，不计入翻译表预算，但仍受既有独立字段长度校验。
目录转候选与创建安装交互时使用同一裁剪器，协议校验使用同一组上限。优先保留全部受支持界面语言的精确匹配或语言前缀回退，因此同会话的桌面与手机无需争用一个“当前语言”。其他语言按原始顺序填充剩余预算；超长键丢弃，文本按预算截断且不拆开有效代理对，超额条目不进入事件。绕过裁剪直接发送的超限载荷由 schema 拒绝。该边界不修改插件身份、安装确认或退役策略。

## 安装、能力与重载边界

- 仅卡片实际改变状态才为发起会话登记自动重载；已经启用、失败、跳过及商店手动安装不触发。真实写入决定触发，不用无锁预读猜测。scope、授权和官方稳定 ID 由目标 Host 核对，客户端不指定下载地址或凭据。插件包仍由既有 user 安装入口管理；会话确认默认授权当前 workspace 启用，不修改其他工作区覆盖。
- 所有合作写入者以同一实际插件存储根跨进程互斥；读取当次状态、复核、缓存激活和配置写回都在互斥边界内。等待锁后重新检查取消。不得递归获取同一锁。不同 Host、不同存储根独立。
- CLI 生命周期是重载的唯一 owner，每实例合并待处理意图；重载前须确认工具结果持久化、轮次及协议收尾结束、没有已接受队列、待交互、后台工作或冲突操作。查看器不阻止重载。先到的接纳租约优先；取得换代资格后关闭旧实例准入。不通过定时器猜空闲。手动重启/实例释放后旧请求失效；失败沿用生命周期错误，不循环重启或扩大为工作区重启。
- 刷新只共享仍有调用方的请求。最后一位调用方取消 → 立即移除并中止旧请求 → 后续调用可重新刷新。旧请求晚结束不更新缓存结果，也不算一次节流尝试。
- 默认安装卡片明确显示“安装并在当前工作区启用”，一次确认授权安装与当前工作区启用，不新增设置开关。`action=install, scope=workspace` 表达该组合动作；插件包仍安装到用户存储。CLI 在同一个存储锁内复核并安装，再用既有启用入口写当前工作区 `true`，保留用户级显式禁用和其他工作区配置。已安装但禁用时只启用当前工作区。
- 历史 `install/user` 卡片保留原文案；新执行端重校验动作和作用域，不把旧确认升级为工作区启用授权。安装后启用失败需明确报告已安装但未完成启用，不宣称 ready；重试从当前已安装状态继续。成功后只登记一次安全重载，OAuth/必填配置仍单独完成。
- 缺配置也登记安全重载，返回 needsConfiguration；其余尚未就绪返回 refreshRequired，不在旧工具调用内等待 restart，不伪称 ready。安装副作用不因刷新失败而回滚。不发送新用户消息，不重放上一轮。skip 由会话工具结果恢复；新用户消息明确要求才可 reconsider。
- 新旧客户端的能力以当前可信连接为准，不从历史工具调用推断。新工具仅在插件自动推荐开关开启时，对支持卡片的有权输入开放，旧/只读端不得借其他端的能力发起或批准。快照、增量和 replay 按连接投影；能力档变化重新获取快照。保留桌面 continuous、手机 replayable、workspaceIdentity 和 remoteSessionId。支持端同实例断线保留待确认，旧端看到普通会话帧。未知 CLI 不发送新严格字段。
- 验收：真实 ZIP Skill 在同一 session 下一条输入中成功执行；无合成输入、旧输入丢失或重复执行；双进程并发成功后安装记录、缓存和启用项都保留；能力升降级、冷恢复和多端重试不泄露交互。冻结真实目录与至少 60 条标注查询，留出集 Recall@10、nDCG@10 不低于旧规则并改善预定弱例；真实目录纯搜索 p95 ≤ 50 ms，另测 1,000 / 10,000 条。

## Impact Brief

变更层：option-source / validation / commit-effect / presentation / recovery。工作区无 CodeGraph 索引，使用源码符号与直接调用方进行深度 2 的静态扫描。

| 场景                | 入口与共享实现                                                   | 权威 owner / 提交落点                     | 默认与校验                   | 平台边界 / 隔离                         |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------- | ---------------------------- | --------------------------------------- |
| Agent 发现插件      | runtime tools -> PluginDiscoveryPort -> plugins overview         | 官方 canonical catalog                    | 官方 ID、商店可见性、分页    | 目标 Host；不混入个人市场               |
| 推荐安装            | V4InteractionDialogs -> 插件卡片 -> resolveInteraction           | CLI interaction registry / plugin storage | 明确安装或跳过；User 安装    | 桌面 continuous，手机 snapshot/gap 恢复 |
| 原商店与推荐 Prompt | PluginStoreListView / ConversationDraftSuggestedPromptsContainer | 既有 plugin management                    | 保持现有安装、恢复、启用行为 | 不改变草稿与自动发送语义                |

| 分级           | 关系与证据                                                     | 处理                               |
| -------------- | -------------------------------------------------------------- | ---------------------------------- |
| must-inspect   | runtime-tools -> handlers -> executor context                  | 端口贯穿、按宿主能力注册           |
| must-inspect   | V4 registry -> product-projection -> pendingInteractions -> UI | 专用交互、无自动结束、双端一次应答 |
| must-inspect   | plugins.ts -> marketplace adapter / storage lock               | 复用安装/恢复/启用及 SHA 校验      |
| should-inspect | Store Listing / 官方刷新 / 商店隐藏规则                        | 同源、缓存状态、隐藏规则单点       |
| invariant-only | session plugin catalog / CommandInbox / owner route            | 安全重载当前实例、不新增队列       |

共享行为：目录、存储、安装原语、V4 交付。差异：新入口等待当前会话确认，旧推荐 Prompt 只修改未发送草稿。可变状态由 CLI 持有；Host/Renderer 只路由与投影。没有迁移现有存储格式。

Graph delta：新增 capability.agent-plugin-discovery，与官方市场来源、V4 交互、插件存储建立语义关系；原图未覆盖该能力，属于新增节点，无需变更旧能力定义。未决产品问题：无，按已确认计划执行。

## 已接受验收场景

| ID    | Setup -> Action -> Assertion                                                               | 证据                                                           |
| ----- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| APD01 | 中英文官方条目/个人条目/隐藏条目 -> 查询 -> 只返回相关可见官方条目；分页无漏重             | bootstrap 单测                                                 |
| APD02 | 并发查询/过期/离线目录 -> 刷新 -> single-flight、10 分钟节流、stale 明确                   | bootstrap 单测                                                 |
| APD03 | missing / disabled / restorable -> 推荐确认 -> 对应安装/Workspace 启用/内置恢复            | adapter 单测与 Desktop E2E                                     |
| APD04 | 确认卡片 -> 等待/跳过/取消/双端点击 -> 不自动安装，最多一次 mutation，跳过可恢复           | registry/projection/runtime 与 E2E                             |
| APD05 | 伪造 ID / 隐藏 / 下架 / 刷新失败 -> 推荐或确认 -> 无安装副作用                             | bootstrap 单测                                                 |
| APD06 | 卡片实际安装 -> 当前工作收尾后重载同一 session -> 下一条用户输入调用 ZIP Skill             | bootstrap/core 单测及 PLM-LC-021 桌面 E2E                      |
| APD07 | 新/旧客户端、独立 CLI、子 Agent -> 创建/执行 -> 只有开关开启且支持交互的客户端获得推荐工具 | 注册与协议测试                                                 |
| APD08 | 桌面/手机同 session -> 手机断连重连 -> 卡片从同一 snapshot 恢复，回答仅一次                | V4 profile/schema/registry 回归通过；实际手机 relay E2E 待验证 |
| APD09 | 需要外部服务与普通代码任务 -> 真实模型 -> 有帮助时查询，普通任务不过度推荐                 | 未运行：缺少测试模型配置；独立于 replay                        |

状态维度取目录可用性、插件生命周期、交互决策、客户端能力、delivery profile 的高风险组合。自动安装、第三方目录、同轮热加载、无人值守安装剪枝为 out-of-scope；手动审批无超时批准。E2E 新用例保持 manual-review/pending，未获人工 review 不进入 formal CI。

## 2026-11-04 设置开关验收

「设置 → Agent 能力 → 行为与工具 → 插件自动推荐」默认关闭。2026-11-06 迁移入口，以下运行记录对应迁移前的控件行为。macOS Desktop E2E 1/1 通过，运行 `desktop-e2e-20261104033807665-p58349-3fcf657995c2b204`：默认关闭时明确请求也未获得搜索和推荐工具；开启后工具出现且安装后自动重载正常；再次关闭后同会话的新输入不再获得工具。开关在重开设置页后保留，中文深色和英文浅色窄屏已复核。实际手机 relay 未在本次运行。

## 2026-11-03 验收

本次验收基于合入的 `staging@9e6d2f72d4`。15 个受影响的 CLI 测试文件共 423 项通过；桌面端重新构建后运行以下用例，录屏使用系统 FFmpeg。

- PLM-LC-021（macOS Desktop）：1/1 通过，运行 `desktop-e2e-20261103124904313-p61172-59e756836ce2d8a0`。先跳过并确认未安装，再用另一个任务确认安装。该任务的 generation 只增加 1，主对话回放只有查询、推荐、安装结果三次请求；下一条用户输入调用真实 ZIP Skill，工具结果包含归档中的正文。标题生成属于后台工作，独立于主对话请求计数。本例不会自动晋升 CI。
- P2：CLI / Core 定向回归 6 文件、150 项通过，含 SQLite 冷恢复、后续输入切换能力、同实例内两种客户端的 snapshot/delta/replay，以及旧客户端应答不能批准安装。协议测试不等同于旧客户端或手机 relay 实机验收。
- P1：双进程真实 ZIP 安装回归覆盖两条记录、两份缓存和两个启用项。BM25 的冻结目录、标注查询和指标见[搜索评估](../../apps/zcode-cli/packages/bootstrap/tests/data/plugin-discovery-search/README.md)。固定模型回放只证明工具链路，不证明模型自主推荐质量。

评审修复复验：最后一位读者取消后立即重试、旧刷新晚到、用户级安装保留显式禁用，均有 CLI 回归。重新构建 CLI 后回放 PLM-LC-021，运行 `desktop-e2e-20261103131023883-p21774-062cb58fecfdf9b2`，1/1 通过。

## 上一版全流程视觉证据（不证明自动重载）

候选 E2E 从输入需求前开始连续录制 Electron 窗口，覆盖查询、确认卡片、跳过结果、新任务确认安装、安装结果及设置页已安装详情；每个关键动作保存编号截图。录屏使用现有 `electron_capture_page` 采集器，`finally` 停止并输出视频及步骤清单。录屏与截图来自真实应用执行；模型决策仍由 case-local replay 驱动，不作为真实模型推荐质量或手机 relay 验收。

2026-09-16 补录通过：run `desktop-e2e-20260916132529990-p47686-fae27eb93008b51f`，1/1 E2E；视频 21.8 秒、109 帧，11 张编号截图，设置页实际启用开关为 true。产物位于 `packages/desktop/.e2e-artifacts/plugin-management/plm-lc-021/`：`full-flow.webm`、兼容播放版 `full-flow.mp4`、`full-flow-screenshots.zip`、步骤时间点 `full-flow.json`。已解码验证视频帧数和时长，并复核窄屏与结尾详情画面。补录后的根 typecheck/lint、Desktop typecheck:e2e、fixture check 和架构检查通过，既有 warning 保留。

## 验证命令

根目录 typecheck/lint/architecture，CLI typecheck/lint 与 contracts/core/bootstrap 受影响测试；Desktop E2E typecheck、插件推荐候选 E2E 及手机交互验证。验证记录写实际命令与结果，真实模型验证不可用时明确记录，不用固定回放代替模型选择能力证明。

### 2026-09-16 实施验证

实施基线：`origin/staging@c32957bdad0002b0bebb42d87ddfa257288f94a4`；使用隔离功能分支。以下命令在仓库固定的 mise Node/pnpm 环境执行。

| 检查                                                | 实际结果                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm architecture:check --changed`                 | 通过，0 架构违规                                                                                                       |
| `pnpm typecheck`                                    | 通过                                                                                                                   |
| `pnpm exec pnpm --dir apps/zcode-cli typecheck`     | 通过，24 tasks                                                                                                         |
| `pnpm lint`                                         | 通过，51 条既有 warning、0 error                                                                                       |
| CLI 全量 `pnpm exec pnpm --dir apps/zcode-cli lint` | 未通过：基线已有 max-lines 违规。对本次 CLI 文件与 HEAD 用相同规则比较，6 个超限文件基线均已有，新增诊断 0；未关闭规则 |
| CLI 受影响回归                                      | 13 files / 378 tests 通过；最后增量检查 5 files / 27 tests 通过，两者有重叠                                            |
| Protocol adapter 定向测试                           | 4 tests 通过：恢复入口、Workspace 启用覆盖、配置缺失、activation 的 workspace identity 透传                            |
| App 协议/连接/UI 回归                               | 10 files / 121 tests 通过                                                                                              |
| `pnpm --filter @zcode/desktop typecheck:e2e`        | 通过                                                                                                                   |
| 候选 fixture check                                  | 通过；完成标记不作为请求 matcher 的 2 条 warning 保留                                                                  |
| Desktop 候选 E2E                                    | macOS 1/1 通过，实际 ZIP 安装与状态读取；仍为 pending                                                                  |
| `git diff --check`                                  | 通过                                                                                                                   |

Desktop 最终运行 ID：`desktop-e2e-20260916115741578-p84753-08fac10243dccf5a`。使用 `ZCODE_E2E_SOURCE_EVIDENCE=1`、`ZCODE_E2E_MANUAL_REVIEW=1` 和 case-local replay fixture。报告位于 `packages/desktop/.e2e-artifacts/<run-id>/summary.md`，截图位于 `packages/desktop/.e2e-artifacts/plugin-management/plm-lc-021/`。

实测覆盖查询官方目录、卡片等待、跳过后不安装、英文深色安装确认、实际安装成功，以及工具结果保持 `refreshRequired`。390px 中文浅色截图已复核卡片与按钮的视口边界。旧轮次迟到请求不会在新轮次重新弹卡片；registry 只接受匹配 session 的首个应答，等待 10 分钟也不会自动批准。

未完成的必要证据：真实模型主动推荐/不乱推荐评测（当前测试环境未配置 E2E 模型凭据）；手机 `/remote` 经实际 relay 的双端点击、断线重连 E2E。现有测试证明 shared component、协商、snapshot schema 和 first-answer-wins 语义，但不代表手机实际链路验收。Windows/Linux 未实机验证。依据根 AGENTS.md，保留工作区改动，必要验证未完成时不自动 commit。
