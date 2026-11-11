# Todo 99：单连接架构的可靠过渡——账号状态交付与有效选择消费

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：本轮裁决范围实现及复审完成；2026-09-09。五项修复、逐入口审查及两项局部竞态已闭环，Pro 真实 Worker 请求与 Electron 验证通过。W99-E05 手机 shared-host＋SSH 联合实机验收经用户明确延期（同版本 Web 测试页尚未就绪），不计本轮完成门槛，也不宣称已经验证。提交及最终检查见末尾记录和复审账本。
> 基线：86bbe157c88e8e599694afb53c39f6dac125ac08。事实依据：[Todo100 调查报告](../research/todo100-account-provider-selection-investigation.md)。旧版 Todo99 的“只补 states/Subagent、不调整同步时机”由本计划取代；调查报告保留为历史证据。
> 范围收缩（2026-09-09 用户二次裁决）：同步沿用既有时机、队列、检查和失败路径；取消生命周期重整、新增重试系统、latest 合并队列及批量移除 ensure。只修传输漏字段、错误确认等确定且局部的问题。下面的阶段、用例与完成门槛已同步缩减。
> 本轮按现有单连接产品上线；[Todo101 多 Account Provider 并存](./todo-101-concurrent-account-providers-draft.md) 仍为延期 Draft，不提前实现，不改变持久化/迁移格式。
> 第二轮逐入口复审、确定性竞态复现及持续验证记录：[Todo99 实现复审账本](../research/todo99-implementation-review.md)。产品 E2E 仍按原完成门槛补证据，不以单测数字取代。

## 1. 目标、非目标和优先级

让现有模型选择链路可靠工作：事实完整、快照自洽、新意图正确解析、派发不丢选择、固定执行不被重新解释。同步机制是临时的数据运输，不把它建设成第二套状态平台。

- **必须修**：P100-01 丢 Account states；P100-02 收到冒充应用；P100-03 显式 Subagent 绕过公共解析；P100-05 附件分支漏传选择/执行上下文。
- **按既定边界补齐**：P100-04 Bot 已有任务的空闲新轮次。同步保留已有触发与检查；不以完善所有 Worker 生命周期为完成前提。
- **局部验证、量力修复**：R100-01 账号查询期间切连接/身份的发布竞态；R100-02 排队前读取快照的时序风险。优先已有确定性测试可覆盖的部分；需要大范围编排改造时记录并延期，不作为本次消费修复前置条件。
- **审查但不机械改写**：Composer、定时任务、Wiki、标题、Compact、Memory、各类 child。区分新意图、继承执行、已经接纳的 Submission。

本项不做：多个人/Team 同时连接、设置页纯导航、Provider 身份新格式、持久化迁移、独立终端 CLI 账号能力统一、删除临时同步、每次发送追平最新配置、Factory/bind 内自动换 Provider、重写 SSH provisioning 或手机 attachment。

唯一登录账号决定 BigModel/Z.ai 闲时域；已绑定 Ticket 不跨账号/域重绑。本次不增加“闲时从哪个个人/Team 扣费”的选择。

### 1.1 最终裁决清单（实施与复审入口）

以下七项是本轮完整范围。后文的设计、阶段和用例服务于这份清单，不得反过来把已取消的同步重构重新列成必做。

| 类别 / 事项       | 已确认的问题或审查对象                                      | 本轮处理与边界                                                          | 验收依据                                                              |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 修复 1 / P100-01  | Host -> Worker 丢 states，使非当前账号套餐被错误放行        | 补齐完整传递；不把 current 扩到普通 Provider/Off-Peak                   | 实际 Registry 集合和协议往返，W99-01/02/05                            |
| 修复 2 / P100-02  | 输入版本冒充已应用版本；同值重交可能跳过失败后的刷新        | 局部纠正确认语义及重刷条件，不重建交付系统                              | Source/Registry 版本分别核对、错配后匹配、失败恢复，W99-06/07/08      |
| 修复 3 / P100-03  | 显式 Subagent 未使用公共 Effective Selection                | Worker 本地公共解析，覆盖直接/嵌套/Workflow/Script 装配；固定后精确执行 | 真实 child 请求、原 profile 不变、继承/override 对照，W99-03/04/12/13 |
| 修复 4 / P100-05  | 带附件分支漏传 Selection 和 modelExecution                  | 补齐到执行端，与纯文本保持相同选择合同；不先改 Session 模型绕过         | 实际命令/请求、附件顺序、执行范围/Ticket，W99-14                      |
| 修复 5 / P100-04  | Bot 已有任务空闲新轮未重新取得有效选择                      | 派发前解析，并真正传递结果；不改写已接纳 busy/Guide/queue 输入          | 新轮实际请求及原 Bot 配置不变，W99-15                                 |
| 审查 1 / 消费入口 | Composer、定时任务、Wiki、标题、Compact、Memory、各类 child | 区分新意图与固定/继承执行；查结果是否丢失、持久意图是否误写；正确的保持 | 第 3 节逐入口结论及 W99-16；发现新语义不机械修改                      |
| 审查 2 / 局部竞态 | R100-01/02：新旧身份混合、过期结果/确认归属                 | 有确定性证据、可低风险局部修复才修；大改记录延期                        | 局部测试/日志或明确未验证记录，不设全局同步整治门槛                   |

保留三条具体界限：

- “使用旧的解析结果”指用 Worker 当时已应用的**完整旧快照**进行公共解析，不是继续让显式 Subagent 绕过公共算法。
- “谨慎小改”允许保留同步时效性不足，不允许在本次修改中重新制造混合账号事实、假成功、静默替换模型或持久意图丢失。发现必须大改才能解决的风险，应记录具体影响供二次裁决，不隐瞒为已修。
- 保留既有同步时机、队列、ensure 和失败路径；不新增普通发送等待，不统一生命周期、不新增定时重试/latest 合并，不改 Factory/bind、不改持久化/迁移、不实现 Todo101 或独立 CLI 账号改造。

## 2. 必须守住的两条链

### 2.1 事实生产、交付与应用

```text
Host 设置/账号查询                     Host/Worker 各自的配置来源
        |                                        |
        v                                        |
一次完整 Account 结果                            |
[revision + basedOnBuiltin + overlays + states]   |
        |                                        |
        +--> Host Registry 完整应用快照           |
        |                                        |
        '--> 既有 Host -> Worker 同步              |
                  |                              |
                  v                              v
             Account Source ------------> Worker Registry
             接收事实                     匹配来源、整体应用
                  |                              |
                  v                              v
             receivedRevision             已应用完整快照
             只证明已送达                 供 View/解析/执行读取
```

这段来源匹配和保留旧快照是基线 Registry 已有机制，不是本项新建的同步状态机。这里的“配套配置”具体指 Account 的 basedOnZCodeBuiltinRevision 与 Config 的 zcodeBuiltinRevision 相符，不是要求所有配置内容或两端全局版本一模一样。

允许 Host 已应用 B、Worker 暂时应用完整 A。不允许 Worker 把 A 的模型和 B 的账号事实混用，也不允许实际 A 却报告 B 已应用。初始没有完整可用结果时明确不可用，不伪造账号可执行性。

revision 复用现有内容标识，包含 Built-in 来源、Overlay、states；只变 current 也产生不同结果。它不是递增时钟，禁止按字符串大小判断先后，不另建第二套全局 revision。

### 2.2 新意图、固定选择和创建 Model

```text
原配置/原草稿/显式子任务模型意图
                |
                v
公共解析（目标执行环境的一份已应用快照）
                |
                v
临时有效选择 + 不完整/不可用原因
                |
        完整才进入既定提交/派发边界
                |
                v
固定本次 Selection / 已接纳 Submission
                |
                v
ModelFactory 精确校验 -> 创建 Model -> 请求
       不再 remap            不因后台变化换模型
```

- 解析失败、刷新、打开菜单都不清除持久意图。写回仍由各业务原有 accepted/显式保存边界负责，不统一改成“读完即写”或“所有业务发送后写”。
- 已固定选择直接精确校验。用户后来显式提交切模/Guide 是新的合法输入，不等于后台可以改写旧请求。
- 原账号选择按当前普通 Account Provider 对应同模型/同档位；没有同模型不选首模型，档位不支持不补默认档位。普通 Provider 保持原身份。
- 请求期鉴权和 Factory 最终校验保留；解析成功不承诺未来请求一定成功。失败不得偷偷切 Provider 重试。

## 3. 影响面与逐入口处理

R100-01 的局部发布保护：本轮读取的设置与账号身份在查询结束时再次校验。期间变更则拒绝本轮结果，并且不推进 Resolver 的 previousScopes（否则未发布结果会污染下一轮 last-known-good 判断）。保留已有 AccountService 刷新/错误路径，不新增轮询、重试或全局事务。只保证可观察到的作用域变化不被发布，不宣称解决身份 A→B→A 等缺少单调身份版本的全局竞态。

| 入口 / owner                  | 输入与结果                           | 本轮处理                                   | 保存/固定边界                         |
| ----------------------------- | ------------------------------------ | ------------------------------------------ | ------------------------------------- |
| Host AccountService           | 设置、身份、权益 -> Overlay + states | 完整生产；查跨作用域混合                   | 仅发布内存事实，不新增持久 current    |
| Host -> 普通/Wiki Worker      | 完整 Account 信封                    | 既有通路补齐字段与确认；触发时机不重整     | 不写用户配置                          |
| Worker Registry / Facade      | config + account -> 已应用快照       | 复用来源匹配、generation 和公共解析        | 整体发布，不拆字段通知                |
| Composer / UI hook            | 原草稿 -> View + 有效选择            | 回归订阅、目标隔离、旧回包丢弃             | 原 accepted 边界；不因阅读改历史      |
| 显式 Subagent                 | profile 结构化选择 -> 有效选择       | 必改，Worker 本地公共解析；贯穿 child 装配 | 子执行前固定；profile/Markdown 不改   |
| 隐式 Subagent / 内部 override | 父 Active Model / 固定覆盖           | 保持继承及 override 优先级                 | 不重映射父执行，不用继承掩盖显式失败  |
| 定时任务                      | 保存选择 -> 新 run 选择              | 审计/回归现有派发解析                      | 固定 run 后不再解析；任务原配置不变   |
| Bot 首次创建                  | Bot 草稿 -> 新任务                   | 回归已接入的公共 View                      | 原创建/accepted 边界                  |
| Bot 已有任务空闲新轮          | 原意图 -> 本次有效选择               | 补解析并实际传递，不能只校验后丢结果       | 新输入派发前固定                      |
| Bot busy / Guide / queue      | 已接纳 Submission                    | 保留 CommandInbox、原固定选择和顺序        | 不在排队/出队时自动 remap             |
| 带/不带附件任务发送           | Selection + modelExecution + payload | 修附件分支漏传，合同保持一致               | 不绕路先改 Session 全局模型           |
| Wiki                          | 新生成 / 固定后重试                  | 前者已有公共解析；后者保持固定             | retry 不重新换模型                    |
| 标题 / Compact / Memory       | 独立选择或继承中的 Model             | 逐项分类，未调用 Facade 不自动判 Bug       | 继承执行不动；独立新工作先确认合同    |
| Off-Peak                      | 选择 + Ticket scope                  | 回归上下文不丢、绑定不变                   | 不跨账号/域换票                       |
| SSH / 手机                    | 目标 Host + workspaceIdentity        | 目标隔离及协议回归                         | 不新建手机 runtime，不改两类 delivery |

核查消费模型的 Worker 是否沿现有路径收到修正后的信封；普通/Wiki 现有路径都要回归，但不强行并成统一生命周期入口。不新给 Plugin/MCP 或只读 Client 增加账号门禁。

## 4. 具体实施设计

### A. 完整 Account 合同，不扩大 current 的含义

1. 同时检查 Host 序列化、shared 严格协议 schema、Worker 解码、Mutable Source、Registry 输入。不能只让一条 mock 测试看见字段。
2. 信封明确携带 states，不把“旧 Worker 不认识/发送方没发”当成完整账号事实。初始 fail-closed 可以没有可用套餐，但不能因此放行 entitled=true、current 丢失的普通账号套餐。
3. 普通模板/自定义 Provider、Off-Peak 不需要 current。缺失检查限定于托管 Worker 的普通账号事实合同，不通过全局修改 Resolver 误伤独立 CLI 和非账号 Provider。
4. states 不是凭据；不把 OAuth token、Key secret 塞进新字段或日志。连接身份沿现有可信通道，诊断脱敏。
5. Host/Worker 使用相同配置基础时，对比最终可执行集合；基础暂时不同则验证各自完整快照，不要求瞬时相等。

主要入口：packages/provider/src 的 sources、registry-service、resolver；services 的 zcodeAgentService；shared/zcode-protocol；bootstrap 的 process-provider-registry-runtime 和 zcode-protocol/account-provider-config。

### B. 同步保留旧机制，只修确定的局部错误

局部时序补充（R100-02）：每个 Client 的既有串行队列应包含 Source.read，而不只是 RPC；否则较早开始但较晚返回的 read 会把旧结果插到新结果之后。把读取移入原队列，不新增合并、重试或业务等待入口。用延迟 Source 的确定性测试验收。

**取消上一版生命周期重构方案。**保留现有 source change 推送、各入口 ensure、每 Client 串行队列和 revision 去重。不新增注册器、latest 合并队列、有限退避重试系统，不批量删除操作前检查。后续要删除临时同步，不值得在这一轮完善成独立平台。

普通消息发送不新增“必须等最新账号同步”的屏障。原来创建/恢复等入口已有的同步检查暂时保留，不宣称已经消除全部业务同步依赖。允许继续用完整旧快照解析，或在所选模型尚不可用时明确失败；不偷偷换模型、不清除原意图。

保留三个小修：

1. A 节的完整 states 端到端传递。
2. 回执不能把输入 revision 冒充 appliedRevision。局部对齐为接收确认（如 receivedRevision），同步改对应缓存/调用者；Registry 实际应用版本仍从已有快照取得。不新加反向应用通知、等待应用的握手或第二套状态机。
3. Source 没变化不代表上次 Registry 刷新成功：同一结果重交时仍能重试未完成的 refresh。失败不记录假成功，后续恢复沿已有调用/事件入口，不新增定时重试。

如果协议回执调整发现影响远超发送/接收/缓存这条局部链，先记录实际影响再讨论，不能借机扩大协议平台。版本/能力检查沿现有部署机制做回归，不另造自动升级方案。

已有 Registry 行为如下：

```text
当前已应用完整 A
    |
Account B 到 Source，标明它基于 Built-in B
    |
Registry 刷新：本地 Built-in 还是 A，不匹配
    |
保留已应用 A（不发布拼接结果）
    |
已有 Config Source change：Built-in B 到达
    |
再次刷新：来源匹配 -> 一次性应用完整 B
```

这不需要保存多版本队列：Account Source 保留最新收到的事实，Registry 保留上一次完整应用结果。Config/Account 两边已有变更订阅，任一边变化会驱动刷新。配套配置始终不到，则不保证自动追平，只保留旧完整结果；首次尚无旧快照时也不能假装已有可执行账号。这些限制保留，不在本轮扩成初始化等待/恢复工程。

回归重点：错配不发布、匹配后可应用、回执不撒谎、同值重交能刷新。发送失败/应用失败不承诺立即自愈，不因这次修复引入无限等待或重试。

### C. 新意图入口复用解析，不下沉到 Factory/bind

显式 Subagent 经依赖注入获取同进程只读解析端口，内部复用公共 ModelSelectionFacade 和同一个已应用快照。Core 不导入 Host 服务/Runtime 具体实现，不做反向 Host RPC。

1. 保留公共结果中的有效选择和问题原因，不只返回 selection 或 null 后丢失错误含义；不复制第二套 DTO/算法。
2. 托管 Worker 必须装配端口，缺失不能默默绕过解析。独立 CLI 按已裁决范围维持现状：这是明确的装配区别，不由偶然漏传决定。
3. 用户 Markdown 和内置 Subagent JSON 进入 Core 前已是结构化选择，共用显式分支；不重读老字段，不修改用户文件。
4. 直接 child、嵌套 child、workflow、script child 贯穿依赖。验证真实创建链和请求，不只测 helper。
5. 隐式继承、内部 override 和固定执行不变；显式不完整按原错误机制失败，不回退父模型、套餐首模型或最高档位。

补充已确认的优先级：先判定本次内部执行 override，再决定是否需要解析 profile。override 存在时不调用 profile 解析器，避免闲时等已固定执行被无关的失效 profile 阻断；override 自身仍由 Factory 精确校验。Subagent 恢复已有 child 的路径也必须验证最终执行选择，不以新建成功代替恢复成功。

主要入口：Core runtime/methods/subagent、Runtime deps；bootstrap create-app、protocol entrypoint、workflow/script child 装配。Factory 和 bind 保持精确执行含义，不新建临时“双工厂”体系。

### D. 修复消费和派发断点

**附件：**沿 task adapter -> Agent Service -> protocol -> runtime 查 Selection/modelExecution。与纯文本语义相同，附件顺序和执行 scope 不变。需补协议字段时同步严格 schema；不能先 setModel 再发送绕过漏传，不重写全部附件传输。

实施复审补充：旧后台发送把 `sendInput` 的 admission 返回误作整轮结束，提前释放 active controller 与 Bot/automation turn 归属。只修该生命周期错误：ACK 仍立即返回；后台等待 `started_turn.completion` 后清理，明确处理 admission rejection。复用 Core 的 busy/执行约束校验，不新增队列或等待最新账号。

**Bot：绑定 Session，复用 Session 既有机制，不绕过。**这是用户最终裁决，不再等待“默认配置”讨论：

1. 未绑定时允许创建草稿；绑定后同一个 Session 的持久化 ModelSelection 是唯一原意图。Bot 不维护第二份绑定后的模型配置，不从 Bot 默认值覆盖 Session。
2. `/status`、模型与档位菜单读取该 Session；桌面和 Bot 修改的是同一份 Session。`/new` 的既有继承行为保留，不能混同于旧 Session 每次发送重新选默认。
3. `/model` 与单独改思考档位是已提交的 Session 配置命令，立即生效并保存，**用户已确认允许**。不改成 Composer 的未提交草稿，也不新增 Bot pending selection。
4. 修复完整选择丢失：Bot 已传 provider/model/reasoning，旧 `session/setModel` 却格式化成字符串，Session setter 又只保留身份。共享 Session 修改入口必须完整校验、应用并保存选择；不能由 Bot 分两次命令补丁式修复，不能只修状态文案而实际执行仍丢档位。
5. 已有任务空闲新消息，在既定派发边界从 **Session 原选择** 经公共 View 求有效值，真正送入该次输入。失败不改默认模型、不清原意图；解析本身不写持久数据。提交后的保存沿 Session 既有边界。
6. 已接纳 busy/Guide/queue 输入不重解释，CLI admission 为权威，不新增 Host 队列。附件同样携带 Selection/modelExecution；不用先修改 Session 再发送绕过漏传。远程目标仍沿既有 Task Service 路由和 workspaceIdentity 隔离。

实现读边界：Task Service 提供只读 `getTaskModelSelection`，沿目标 Agent 的 Session read 返回结构化原选择；Session settings 的 `model.current` 保留完整原值（包括暂时无效的档位），候选/展示校验仍由对应 View 负责。不能从菜单的可选项或经过过滤的 thoughtLevel 反推原意图。这不是增加持久字段或第二个模型状态。

```text
未绑定 Bot：创建草稿 -> 公共解析 -> 创建 Session -> 清理创建草稿
已绑定 Bot：同一个 Session 原选择
               +-> /model 配置命令 -> 完整校验/应用/立即保存 -> 既有状态投影
               +-> 空闲新输入 -> 公共有效解析 -> 固定本次输入 -> 既有 admission/执行/保存
已固定执行、继承子任务、已接纳输入：不重新映射
```

**其余入口：**逐项记“已正确/确定缺口/语义未定”并附调用链和测试。标题、手动 Compact、Dream 若有独立模型意图，先说明来源和固定边界；不直接把所有 ModelFactory 调用换成 resolver。

**Bot 默认初始化保持现状：**“使用默认配置”不是模型编辑页的智能配置。仅创建草稿无 Selection 时取目标 Host preferredSelection（有效的 configured default，否则 Registry 顺序第一个可初始化模型及最高档位）；已有 Selection 失败不能改走 preferredSelection。绑定 Session 后不再以此初始化规则覆盖其选择。本轮不另行设计默认策略。

### E. 保留完整快照原则，谨慎处理额外竞态

不新增全局事务层。沿已有边界收口：Account 一轮结果整体发布；Registry 配置/账号匹配后整体应用；组合事实的消费者只读一次已应用快照。

- R100-01：用可控 promise，在查询 A 期间切连接/账号 B，交错完成身份、权益、配置回包，检查 scope/current/models/LKG。完整旧 A 可短暂存在，但 A 的事实不能贴成 B 的身份。若复现混合或旧回包覆盖新作用域，在生产层捕获来源、拒绝过期提交，不在 UI 加 timeout 补丁。
- R100-02：优先通过现有队列/Client 测试检查旧回包归属，不把内容 revision 当时间戳。需要新建 latest 合并、生命周期或全局时序机制的方案延期，不作为本次验收要求。

上述调查若只能揭示旧同步的时效性不足，记录限制即可；若确认混合身份、错误放行等问题，评估局部修补。需要大改的明确登记未修风险与影响，交用户裁决，不能悄悄扩大本轮。

## 5. 实施顺序与阶段退出条件

每阶段：核对 spec -> 红灯测试 -> 最小实现 -> 定向验证 -> 全面 review -> 写执行记录。小环境阻塞登记后继续独立项；产品语义/权限变化才暂停讨论。阶段通过不代表整个 Todo 完成。

| 阶段                           | 工作                                                           | 退出条件                                                                 |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| D99-0 基线/实验整理            | freshness、dirty 归属、暂停 diff、spec/catalog/matrix 对齐     | 哪些采纳/重写/删除有清单，不混入用户改动                                 |
| D99-1 状态完整性               | A + ACK/重复刷新正确性                                         | W99-01/02/05/06/07/08；实际 Registry 对比，不只测 JSON                   |
| D99-2 既有同步回归（范围缩减） | 保留现有触发/队列/ensure，核查普通与 Wiki 通路；不重整生命周期 | W99-09/10 按原机制回归；W99-11 延期；无新增发送屏障                      |
| D99-3 显式 Subagent            | C：公共端口、真实 child 和全部装配                             | W99-03/04/12/13；真实请求正确，继承/override 不变                        |
| D99-4 其他消费断点             | D：附件、Bot 空闲新轮；逐入口审计                              | W99-14/15/16；未定语义单列，不扩大 busy/Ticket 边界                      |
| D99-5 局部风险与全链复审       | E；与本次改动相关的 SSH/手机/重启回归；文档回写                | W99-17/19；W99-18 能局部验证则推进，否则记录延期；不以全局同步整治为门槛 |

**发布不可拆断：**补 states 可能暴露之前被错误放行掩盖的显式 Subagent 失败。因此 D99-1 和 D99-3 必须成套验收才能对外宣称可用；可分提交，不能用“状态修好”代替消费链完成。

暂停实验复审：

| 已有试改                            | 处理计划                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| states 信封/传递与 round-trip 测试  | 方向可复用；补缺失语义、Registry 断言和 ACK，不直接认完成                      |
| 共享 Facade、Core 回调、child 传播  | 按 C 复核；保留单算法、完整问题结果、明确托管装配，删除同义 helper             |
| 只返回 effectiveSelection 或 null   | 补不完整结果的错误合同，避免误继承                                             |
| bootstrap 旧 fixture/依赖产物失败   | 按真实 schema 更新隔离 fixture、构建必要依赖后重测，不放宽生产校验             |
| 文档“操作前 ensure”“必须 Host 反查” | ensure 作为现有事实保留，不要求清理；显式 child 复用本地解析，不增加 Host 反查 |
| 他人 dirty 文件、无关测试/临时产物  | 不回滚，不打包进本项提交                                                       |

## 6. 验证合同与组合剪枝

保留既有编号，避免裁决轨迹丢失；W99-11 明确延期，W99-18 为可推进的局部调查，其余按缩减后的合同验证。以下没有新增通过证据；Todo100 的 52 条既有单测和 ACK 内存复现不证明本修复通过。

| Case   | Setup -> Action                                                  | 必须断言 / 证据层                                                                      |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| W99-01 | 两套餐 entitled，仅 Team current -> 真协议往返                   | states 无损；同基础下两端可执行集合相等，个人不被放行                                  |
| W99-02 | 只改 current -> 发布/交付                                        | revision 变；模型/current 来自同一 applied snapshot                                    |
| W99-03 | 显式个人选择，Team 有同模型/档位 -> Subagent                     | 实际 child 请求为 Team 同模型/档位，profile 原意图不变                                 |
| W99-04 | 缺模型、失效档位、未指定、内部 override -> child                 | 前两项不完整失败；后两项继承/override 不变，不补选                                     |
| W99-05 | 坏/漏 states、初始无权益、API、Off-Peak -> 应用                  | 坏信封不宽松放行；合法 fail-closed 可表达；非账号/闲时不需 current                     |
| W99-06 | 已应用 A；Account B 先到、Builtin B 未到 -> 同步                 | Source B、Registry A；只确认 received B，无假 applied B                                |
| W99-07 | 承接 06，Builtin B 到达 -> 配置通知                              | 不重发 Account B 也应用完整 B，Facade 随应用更新                                       |
| W99-08 | replace B 后 refresh 抛错 -> 重交 B；再测应用侧恢复              | 不缓存假成功，changed=false 不挡恢复，旧完整结果可读                                   |
| W99-09 | 现有 Worker 初始化/重建 -> 按原入口同步                          | 修正字段/回执能作用于新 Client；不引入新注册器和计时器                                 |
| W99-10 | 普通/Wiki 沿原触发入口 -> 账号同步/执行                          | 两条既有通路传完整状态；不新增只读门禁，不新增普通发送 latest barrier                  |
| W99-11 | 原计划：latest 合并队列、有限退避、生命周期统一                  | **延期/本轮不做**；保留编号记录用户缩减决定，不计入完成门槛                            |
| W99-12 | 父请求固定，后台切账号 -> 隐式 child/重试                        | 原 Model/范围不变，不暗中 remap                                                        |
| W99-13 | 直接/嵌套/workflow/script child -> 显式选择                      | 实际装配贯通，非只测 helper                                                            |
| W99-14 | 相同选择，带/不带附件 -> runtime                                 | Selection/modelExecution 等价，附件有序，Ticket scope 不丢                             |
| W99-15 | Bot 已有任务空闲，切套餐 -> 下一条消息                           | 有效值实际派发，Bot 原配置不变；已固定 busy 输入不 remap                               |
| W99-16 | Composer/定时/Wiki 意图失效或未知 -> 刷新/派发                   | 原意图保留，新派发明确失败；固定 run/Wiki retry 不换模型                               |
| W99-17 | SSH + 手机 attachment + Worker 重启 -> 发送                      | workspaceIdentity 不串，手机复用目标 Host，两类 delivery 不混用                        |
| W99-18 | 延迟查询中切连接/身份/配置 -> 交错完成（可推进调查）             | 能局部验证则记录结果；需大改则登记风险延期，不要求本轮完成全局时序整治                 |
| W99-19 | 旧协议 Worker/协议失败 -> 启动交付                               | 明确不兼容/现有重部署，不 silent fallback、不假确认                                    |
| W99-20 | 绑定 Bot `/model` 跨模型并选 reasoning，随后读状态、冷恢复、发送 | 完整 Selection 立即保存且实际请求一致；非法显式档位不产生半次修改；不新增 Bot 持久选型 |

剪枝与证据安排：

- 普通账号用个人 -> Team 同模型代表 remap；不同 Team 身份、BigModel/Z.ai 用集中分类/协议测试补边界，不给套餐、主题、语言做全排列。
- 时序用受控 promise/故障注入，不靠真实网络碰运气或长 sleep。新意图、固定 Submission、隐式继承、内部 override、Ticket 不能剪成一个成功用例。
- UI 与请求/协议/持久数据联合断言；Bot/附件/child 的 helper 单测不冒充 E2E。
- 代表交互用例登记到 [Case Catalog](../../../conversation-session-case-catalog.md) 与 [Coverage Matrix](../../../testing/conversation-session-e2e-coverage-matrix.md) 的 Todo99 专节。目前均 missing/planned，不是正式覆盖。
- 新 E2E 先入 manual-review/pending，复用 V4 helper、case-local fixtures/manifest。普通文本 fast-text；运行窗口 controlled-stream 并写原因。审查证据后才按既有流程转正、fixture check、replay、Docker isolated 准入，不因移动目录认定通过。
- E2E 主机优先可用的 MacBook Air；Pro 可替代，记录实际主机。SSH/手机待环境可用推进，未跑明确保留，不以桌面代表全端。隔离测试数据，不擅自改真实账号/任务或清理远端数据。

## 7. 文档、图谱与阶段复审

实施前核对当前对应 spec，尤其 Account/Registry、Model/Submission、Subagent 装配与远控事实文档。conversation-protocol-declaration 的 Model 章节仍有旧类型、旧 readiness/fallback 口径，不得据此新增同步屏障或模型替换；既有 ensure 本轮保留。只修本项确认影响的条款，不重写整个会话协议。

Codegraph 当前不可用，采用 Todo100 定向调用链和功能图种子，不声称全仓自动索引完成。实现后回写确认事实：Worker 本地公共解析；Bot 首次/后续分开；Source received/Registry applied 分开。不能把目标设计提前记成实现。

每阶段 review 必答：

1. 修了根因还是堆兜底？本次改动内能否删除重复算法/临时接线？这不授权批量清理既有同步 ensure。
2. 结果来自哪份完整事实？有无拼接 Source 新值和 Registry 旧值？
3. 输入是新意图还是固定执行？谁保存、何时保存？是否偷偷清空/替换？
4. 普通/Wiki Worker 和 child 是否都覆盖？协议/装配是否仍漏字段或绕过？
5. 非账号、Ticket、workspaceIdentity、desktop continuous/mobile replayable、CLI 范围是否守住？
6. 哪些失败测试/实际请求/日志证明通过？哪些未验证？Todo 条款逐项标状态。

## 8. 执行记录和完成定义

W99-E04 实机补充（2026-09-09）：ModelFactory 在 Turn 内层错误处理前抛错时，旧实现只记录后台异常，已接纳命令没有终态事件、界面无错误。本轮对创建 Model 的失败复用现有 Turn outcome 事件报告（同一 inputId），不补造模型请求、不切换选择、不等待账号交付。已经由内层处理的失败不得重复上报；取消仍保持取消语义。不借机重写其他初始化阶段的整套错误处理。

状态：待实施、实施中、已验证、待环境验证、待裁决、明确不改。记录发现、证据、决策、改动、commit/run/artifact，不能把分析完成记成已修。

| 项目                                                        | 当前状态                     | 证据 / 下一步                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 最终五项修复、两类审查                                      | 实施中                       | 2026-09-09，见第 1.1 节；最终缩减决定优先于旧计划                                                                              |
| P100-01 完整状态                                            | 已验证                       | 严格信封、真实 Built-in Registry 集合、Pro Host→Worker 切 Team 后的请求；部署跨版本未冒充已验                                  |
| P100-02 确认/失败重刷                                       | 已验证                       | 协议 received 与 Registry applied 分开；同值重刷；Pro 受控旧 A→交付 B→新提交实际恢复                                           |
| P100-03 显式 Subagent                                       | 已验证                       | DI 贯穿 Core/Workflow/Script；真实 child 请求、Workflow 子执行、resume 集成；Pro 个人 profile→Team/high，父选择与 profile 不改 |
| P100-05 附件派发                                            | 已验证                       | 严格协议/Task adapter/真实 Worker 请求；附件有序、执行 high 不覆盖 Session low、Ticket 隔离合同不变                            |
| P100-04 Bot 空闲新轮                                        | 已验证                       | Bot 输入→生产 Task adapter→实际 Worker Team 请求；/model、档位、进程冷恢复保持 Session 权威                                    |
| 其他消费入口审查                                            | 已完成，逐项见复审账本       | Composer、定时、Wiki、标题、Compact、Memory、各类 child、Bot busy、Off-Peak 按新意图/固定执行分类，不机械修改                  |
| 局部竞态审查                                                | 已完成局部修复               | R100-01 前后身份/设置核对；R100-02 read 纳入原 Client 队列。全局原子性未声称实现                                               |
| D99-0 基线与暂停实验复核                                    | 已复核本批影响面             | 2026-09-09 freshness 通过；保留其他 dirty 文件                                                                                 |
| D99-1～D99-5（缩减版）                                      | 本轮范围闭环                 | 分层测试、Pro 请求和失败恢复证据见账本；联合多端实机延期单列                                                                   |
| Bot Session 权威 / 配置命令提交时机                         | 已验证                       | 完整模型和档位一次校验/保存；非法档位零部分更新；Pro Worker 重启后保留，同版本手机观察待延期项                                 |
| W99-E05 联合多端实机                                        | 用户明确延期                 | 2026-09-09 用户答复“还没有，你甭管了先”；不部署 Web 包、不记实机已通过                                                         |
| 生命周期统一 / 批量删除 ensure / latest 合并 / 新增定时退避 | 明确不在本轮实施             | 用户 2026-09-09 二次裁决：临时同步谨慎小改                                                                                     |
| W99-11 / R100 全局时序整治                                  | 延期                         | 仅局部问题有低风险修补时考虑，不作为发布门槛                                                                                   |
| Bot busy 新意图/辅助独立调用的额外语义                      | 保留原边界；新增需求才待裁决 | 不影响先修空闲新轮和已查实缺口                                                                                                 |
| Todo101 / 独立 CLI                                          | 明确不在本轮实施             | 以后另行设计                                                                                                                   |

完成必须同时满足：P100-01～05 在约定范围闭环；同步小修有对应回归、其余限制明确记录；全部消费入口有审计结论；无假 applied ACK、无新增 per-send 门禁、无固定执行 remap；对应 spec/测试/图谱已对齐。不要求完成生命周期统一、额外重试系统或全局竞态整治。

实现后执行定向测试、pnpm typecheck、pnpm lint；改 E2E 还需 desktop typecheck:e2e 及对应 fixture/replay 检查。不能凭旧测试通过背书新实现。按规范记录真实已知的 Agent 会话 ID（不猜）；提交列清未通过/未跑项，不使用 --no-verify。

真实多端证据尚缺不得记成已验证。2026-09-09 用户明确将 W99-E05 从本轮收尾门槛延期，因此本轮可按其余约定范围完成；该项继续保留“待环境验证”，不能以本轮完成推导全端上线已验。需扩大产品语义时只暂停相关子项，列出影响与建议供二次裁决。

### 2026-09-09 第一批实施与验证记录

- 修改链路：shared Account 信封/回执 → Host 交付缓存 → bootstrap Account 解码/进程 Runtime。同步触发、串行队列、既有 ensure 均保留。未增加发送屏障或重试定时器。
- 测试先失败再修复：缺 states 仍被接收、旧 applied 回执、缺 current 放行、同值交付不再刷新；对应新增 `accountProviderSnapshotProtocol.test.ts` 与 `account-config-delivery.test.ts`。后者通过真实协议 Server 调用生产交付方法，观察 Source B 与 Registry A，不只是 mock 回执。
- `createNodeModelSelectionFacade` 复用 Host/Worker 原有身份分类；Core 只接受解析端口。`EffectiveModelSelectionResult` 原类型移至 shared/model-selection 并由 Provider 原入口重导出，没有复制第二份 DTO/解析算法。缺档位部分结果保留 selectionIssue 并阻断子执行。
- 新增真实 Core 子 Runtime 请求测试：显式 profile、隐式继承、内部 override、显式不可用；验证取模、请求及原 profile/父 Selection 不变。Factory/bind 未新增账号对应。直接 child 通过不代表嵌套/workflow/script/resume 全部通过，相关端到端仍待补。
- 定向结果：shared/Host 20 条通过；bootstrap 账号交付、真实 Built-in current 切换与协议 7 条通过（筛选执行，117 条跳过）；Core helper/实际子请求/执行作用域 20 条通过。
- 更大范围回归：bootstrap 两个原测试文件加交付测试合计当次 117 通过、5 失败。失败包括 process runtime 的旧 template fixture 缺 nameMap/config、Standalone 凭据/导入断言，以及远程 Cron denylist 断言；另有失败清理 ENOTEMPTY。不得据定向通过宣称全包回归通过，也未把这些失败擅自修成新的 CLI/Cron 语义。
- 检查：根 pnpm typecheck、pnpm lint 通过（lint 有既有警告）；Core build / lint、Bootstrap typecheck 通过。Bootstrap 原 lint 脚本受 ignore 影响报 no files；补 `oxlint src --no-ignore` 暴露既有 max-lines 等错误，未借机重整包。最终修改后的检查继续记录。
- 最终补验：公共结果类型收口后，根 typecheck、Core build、Bootstrap typecheck 再次通过；Core 20 条、shared/Host 20 条再次通过。Bootstrap 修改文件定向 no-ignore lint 仍受已有 types.ts/create-app.ts 的 max-lines 错误阻塞，未新增忽略规则冒充通过。git diff --check 通过。
- 尚未运行桌面/手机/SSH 产品 E2E，未提交或推送。协议已改变，发布必须使用匹配的 Host/Worker 制品；旧 Worker 不能宽松兼容为完整状态，部署回归仍待验证。
- 当时 Bot 默认产品预期待讨论；随后用户已裁决绑定后 Session 为权威，详见 D 节与第二批记录。`/new` 现有继承、已有任务、失效显式选择是不同分支，不能一起归入“每条消息重新用默认”。

### 2026-09-09 第二批：Bot 与附件链路

- 决策：Bot 只是 Session 的入口；绑定后不另存模型，不绕过公共解析、协议、准入和保存机制。`/model` 与档位命令立即保存获用户确认；Composer 草稿仍到提交边界才保存。未绑定的初始化默认策略不改。
- 修复原因：旧 `session/setModel` 将完整 Selection 格式化为 provider/model 字符串，reasoning 被共享 setter 丢掉。现在结构化输入先整体校验，再一次更新/保存；原字符串入口只改身份的语义保留。`session-facade.test.ts` 证明完整保存、非法选择零写入；真实协议 Server 证明 payload 不丢。
- Bot 读取 Task Service 的 `getTaskModelSelection`，由目标 Session snapshot 的完整 `settings.model.current` 提供原值；不可用模型/档位不经菜单过滤。新测试覆盖同路径的远程 workspaceIdentity；不新增第二份持久选型。
- 空闲新输入将公共有效结果实际传到 sendPrompt；不可用/缺原选择拒绝，preferredSelection 不作为兜底。首次创建继续固定当次有效选择。`botsService.messageFlow.test.ts` 85 条全文件通过，包括已有状态、命令、流式回推、busy、新建及新增三种后续输入情况。
- 附件旧 session/send 路径补传 Selection/modelExecution；V4 与旧协议共用严格执行约束 schema、凭据依赖构造。凭据只进入本轮非持久依赖，不进入 intent。Host 不能通过旧参数兼容重试把这两个字段删除。
- 执行复审发现旧后台将 admission 当成 completion，提前清理 controller 和 Bot/automation 归属。红灯测试证明第一轮未结束时第二次仍被接纳；修复后后台等待 started_turn.completion，外层 ACK 保持立即返回；rejected 走失败终态。旧 prompt_completed fixture 原用 rejected 冒充成功，已改为真实 started_turn/completion 形状，不放宽生产判断。
- 验证：shared/adapter/Bot config/status 分组通过；bootstrap Selection 协议、V4 native commands、Core execution scope 共 62 条通过；Host 真子进程 send 参数定向 1 条通过。完整协议回归曾 111 通过、2 失败：Cron denylist 是先前已记录问题，另一个是上述错误 fixture；修正后 prompt_completed 定向通过。最终全量回归结果另行补记。
- 之前 messageFlow 全文件曾两次 OOM，本次相同产品代码以单 worker/verbose 重跑 85 条在约 4 秒通过。未定位偶发 OOM 根因、不宣称修好了，也未改测试并发/内存配置。
- E2E 技能要求下，先补 Bot catalog/matrix，再扩展既有 `packages/desktop/test/e2e/bots/runtime/bot-effective-selection.test.ts` 的 SR99 synthetic 用例与 harness；这只证明服务消费边界，不能替代 W99-E03/E06 的真实 Worker、冷恢复、跨端证据。未晋级。
- 根 typecheck、desktop typecheck:e2e 已通过；最终 lint、bootstrap typecheck 与 diff 检查继续记录。仍未提交/推送，不把本批通过记成 Todo99 全部完成。

本批最终补验：

- `botsService.messageFlow.test.ts`：85/85；shared attachment schema、Task adapter、Bot config/status：110/110；新的 adapter 用例确认无效档位原值及 workspaceIdentity 原样读取、不写模型。
- `session-selection-protocol` + `session-facade` + 原 `zcode-protocol`：112 通过、1 失败；仅剩原远程 Cron denylist 差异，不能标全包绿灯。没有借此新增远程定时任务禁用策略。
- `account-config-delivery`、Core 显式选择/实际子执行/执行作用域、原 script-workflow：31/31；额外真实 Core resume 用例 1/1：已完成 child 接收新输入时重新解析显式 profile，前后请求的 Provider 各自正确，原 profile 不变。该用例不是重映射运行中 turn。
- 既有 Bot pending spec 在 Vitest Node harness 下 5/5（SR87 三条 + SR99 两条）；不是 Electron/WDIO/真实模型运行，无人工晋级。
- 根 typecheck、desktop typecheck:e2e、Bootstrap typecheck、lint 通过；lint 39 条既有 warning、0 error。`git diff --check` 通过。未提交/推送；没有已确认的当前 SessionStart ID 可写 commit trailer，且真实产品验收仍待补。

继续审查记录（不冒充新增运行证据）：

| 边界                             | 当前查实结果                                                                                                        | 剩余验证                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Session read / Bot 后续派发      | 完整 current 原选择 -> 公共 View -> 同一个 Task send；读取不写入                                                    | 真 Worker 请求、冷恢复及桌面观察                                                                     |
| 旧附件协议 ensure                | `ensureSessionModelAvailableUnlocked` 当前为保留原意图的 no-op，不会先用旧 Selection 阻挡新的有效输入；未增账号等待 | W99-E02 实机                                                                                         |
| Core child resume                | 同一装配再次解析显式 profile；运行期固定模型不重解释，真实请求测试通过                                              | 跨进程恢复产品证据                                                                                   |
| Core child / Script child 的嵌套 | 当前配置明确 `subagents.enabled=false`；不为测试擅自开启嵌套。解析端口已透传，但不能声称已运行不存在的产品路径      | Workflow 可启用路径仍需专门实际请求测试；Script 的 opts.model 是另一种独立显式 API，不等同于 profile |
| UI 公共 Hook                     | 已有 generation/requestId/revision、目标输入隔离与 dispose；无新 Bot hook/订阅平台                                  | 多端 W99-E05，保留既有瞬时落后边界                                                                   |

最终裁决轨迹：初版曾计划统一 Worker 生命周期、合并待发结果并新增退避；用户随后明确“临时同步谨慎小改”，上述工作取消出本轮。最终确认以五项具体修复为主、两类审查为辅。实施记录逐项补充改动文件/commit、测试命令与结果、请求或日志证据、剩余风险；不得用“已完成分析”或既有 52 条单测代替新增修复验收。
