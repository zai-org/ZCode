# Provider 迁移实施

> 状态：持续维护
>
> 最近更新：2026-09-09

## 当前执行入口

- [Todo161：CLI 旧 config.json 首次迁移保留输出上限](todo-161-cli-legacy-output-token-migration.md)：2026-10-14 基于 staging 独立移植；仅 CLI 首次导入，已有配置和 Desktop 不处理。61 项定向回归通过，三种 API 请求预算及重启边界已验证；根与 CLI 类型/lint、架构和格式检查通过，详细证据见 Todo。

- [Todo159：连接测试输出预算统一调整为 512 Token](todo-159-connectivity-512-token-budget.md)：已实施（2026-11-02），实际预算为目标 512 与模型输出上限的较小值；保留最低推理档位、Prompt、流结束和错误契约。真实 Air / OpenCode Go 验收待跟进，仓库验证见 Todo159。

- [Todo158：权限审批框完全访问与待执行队列权限同步](todo-158-permission-dialog-full-access-and-queued-mode.md)：已实现，验收尚未全部收口。仅审批框同步当前任务、Composer 和固定待执行队列为 yolo，各自 Plan 保留；包含事务、幂等与投影恢复。必要验证的基线失败、跨端未验证项见 Todo 第 9 节。

- [Todo157：厂商套餐入口、Go 模型补齐与手动 Key Access 收口](todo-157-provider-plan-catalog-and-manual-access-cleanup.md)：待执行，新厂商保留候选状态。补齐现有套餐入口及 Go 三个目录缺项；移除手动套餐特殊 Access、取消其代理域名安全校验准入，视觉徽标改按模板身份识别。本轮仅整理 Todo 与索引，未修改产品代码或配置。

- [Todo156：Start 独立 Provider 后续修复与最终页面决策](todo-156-start-plan-followup-final-decisions.md)：**已实施并自审，用户已要求提交推送；保留基线失败记录**。Start 常驻并复用原页面状态样式；清理多余连接门禁、补余额访问参数、保留领取流程并使用“查看套餐”；付费下拉直接匹配连接选择，会话提示标注套餐类型。补齐副屏首条推荐，并统一推荐余额共享、按需刷新与 60 秒有效期。团队数据构造专项治理延期，多实例额度卡保持基线；取代 Todo155 初版范围，Pro admin SSH E2E 与全面 review 证据见本条 §14。

- [Todo155：Start 连接依赖清理与模型切换套餐标识](todo-155-start-plan-selection-dependency-cleanup.md)：初版问题清单，保留调查历史；最终范围由 [Todo156](todo-156-start-plan-followup-final-decisions.md) 取代，不再作为实施入口。

- [Todo154：Start 独立 Provider 与提交时体验套餐推荐](todo-154-start-plan-independent-provider.md)：**已实施并 review，Pro E2E 通过**。Start 免连接，保留 ID／品牌图标，独立 current 与选模；不迁移数据，提交／创建时推荐有额度且思考兼容的同模型 Start。Subagent 显式保存纳入，立即运行、Bot、后台执行排除；不再提示跨入口／重启／同 Host 手机生效。最终方案与验证见本条 §8，实施前调查归 research，稳定行为已同步正式 Start 规格。

- [Todo153：思考档位展示映射与配置顺序对齐](todo-153-thought-level-display-mapping.md)：已实现；关闭文案合并、minimal 独立为“极低 / Minimal”、新增“极致 / Ultra”，保留 extra-high／extra_high，取消模糊别名强制归类并尊重配置顺序。192 项单测、八组浏览器交互及类型／lint／架构检查通过；完整原生／手机远控未重跑，不改原始值或请求映射。

- [Todo147：Builtin Config 简化与默认基线调整](todo-147-builtin-config-simplification-feedback.md)：已实施简单前后缀匹配、具体规则后置，删除两条特殊 Model 规则，通用 context/output 上限调整为 1000000 / 128000；保留历史关闭档位只读恢复，Builtin revision 32。

- [Todo143：模型配置勾选框颜色对齐系统组件](todo-143-model-checkbox-system-colors.md)：已实现并复审；浏览器 6/6、单测 51/51、类型/lint/架构检查通过。仅修正勾选框颜色，保留外层覆盖高亮、图形和交互，未重跑原生实机。

- Todo142：Start／闲时请求的官方版本请求安全校验例外（文档仅官方版本保留）：已实现并完成本地验证／review；保留 JWT／Ticket 鉴权，189 项回归及类型/lint/架构检查通过；未重跑实机。

- [Todo141：模型编辑弹窗布局与高级配置体验对齐](todo-141-model-editor-product-ux-alignment.md)：**已完成**；2026-09-12 重新授权后实施、逐项复审，浏览器 26/26、相关单测 51/51、类型/lint/架构检查通过；原生实机未重跑，保留 Todo134 的草稿与校验边界。

- [Todo140：闲时模型列表与视觉／搜索能力更新](todo-140-offpeak-model-catalog-and-capabilities.md)：已实现并完成本地验证／review；两家仅保留 GLM-5.3／Flash，均无内置搜索，5.3 无视觉；revision 25 未线上发布。

- [Todo139：分享导入复用普通新任务的模型与模式初始化](todo-139-share-import-new-task-selection.md)：已实现，本地单测／浏览器与 review 完成；完整分享服务端→原生首条 RPC 联合验收仍待补，未宣称全部验收完成。

- Todo136：官方版本请求安全校验的准入调整（文档仅官方版本保留）：已实现；Start／闲时的 JWT 漏测与错误准入由 Todo142 纠正。

- [Todo135：恢复模型请求默认 Header 与 OpenRouter 归因](todo-135-model-default-headers-and-openrouter-attribution.md)：实现与本地验证完成；真实多端验证限制见正文。

- [Todo138：空模型草稿与 Model 层推理档位兜底](./todo-138-reasoning-level-ui-and-api-defaults.md)：已完成；空 UI 草稿不预填档位，Model 通用兜底 disabled/enabled，三种 API 通用 map 将 enabled 转为 high；保留层级及专用规则。来源 revision 23，合并版为 24。

- [Todo137：体验套餐 GLM-5.3 隐藏视觉标](./todo-137-start-plan-glm53-vision-badge.md)：已实现并通过展示回归；仅扩充共用展示范围，保留图片能力及 Flash 标识。

- [Todo117：保留账号域、补齐套餐选择并取消账号禁用](todo-117-preserve-account-domain-on-provider-save.md)／[Todo118：首次迁移保留手动 Provider 启停](todo-118-preserve-legacy-provider-enabled.md)：最新裁决已收口，待实施。内置账号 Provider 不允许禁用，已有 false 不再生效，旧账号禁用不导入；模板创建的手动 Key 实例仍可启停。当前连接、权益、凭据与模型资格不放宽，不批量改真实用户数据。

- [Todo132：模型选项底色反馈与供应商名称编辑修复](todo-132-model-option-feedback-and-provider-name-edit.md)：**待执行，方案已确认**。只增强方块选项底色差异，保留文字图标和覆盖边框；名称改为 Enter/失焦保存、Esc 取消，隔离共享自动保存，地址/API Key 时机保持。两项合并验证，本轮仅落盘。

- [Todo131：模型设置页智能配置位置与“恢复”按钮](todo-131-model-settings-smart-config-placement-and-restore.md)：**待执行，方案已确认**。缩短 ID 输入框，智能配置及问号移到同容器右侧；底部“恢复”清覆盖并开智能，只改草稿，空 ID 不禁用，仅保存中禁用。复用 Todo130 字段边界，Todo125 说明文案不变；本轮仅落盘。

- [Todo130：智能配置开关与手动配置字段边界修正](todo-130-manual-model-config-editable-field-boundary.md)：**待执行，方案已确认**。统一可编辑字段契约，修改手动 schema、系统字段合成、草稿保存与开关条件；排除旧模型回退，不让隐藏字段阻止表单保存。预计未正式发布，不预设复杂迁移；M120 验证计划已列，本轮仅落盘。

- [Todo129：Provider 埋点适配与 Team 套餐识别修复](todo-129-provider-telemetry-compatibility-and-team-classification.md)：**待执行，方向已确认**。报表侧不动，埋点输出边界最大努力恢复旧 ID／旧口径，Team 按旧版各事件事实核实，可确定项直接推进，无法还原的少数项保留真实 ID 并留证。包含两家 Team 识别、首页闲时误拦及 BigModel 分类修复；不改真实请求、存储或旧 parser，不与 Todo128 时序修复混算。

- [Todo128：Provider 启动契约与闲时资格刷新修复](todo-128-provider-start-contract-and-offpeak-eligibility.md)：**待执行，方案已确认**。四个 `start()` 及包装统一返回 `void`，业务显式读取当前快照；补齐 Registry 更新后/手动刷新资格检查，统一并发与过期结果保护。保留套餐规则，不改 Composer、持久化 schema 或 Runtime 组合边界。本轮仅落盘。

- [Todo127：Built-in 配置在线发布与更新链路修复](todo-127-builtin-online-release.md)：**待执行，详细方案已确认**。版本化 CDN URL；两阶段下载合计 20 秒、正文 10 MB；每分钟检查、正常每小时下载；Account 串行重建与未对齐恢复复用同一检查入口。已列实施顺序与验收，本轮仅落盘，不新增客户端业务完整性门禁。

- [Todo113：近期新模型目录与智能配置更新](todo-113-new-model-catalog-refresh.md)：**第二轮待执行**。补 GPT-5.4 基础版／Pro／Mini／Nano 智能配置、聚合 DeepSeek V4.1 Flash、Qwen Omni／3.7／3.6 配置、Kimi 高速版，核实并移除下线内置成员；所有新增型号必须核查聚合支持，已确定项也须深度研究。第一轮已完成证据保留，本次仅落盘。

- [Todo126：GLM 视觉标展示、Flash PDF 与 Coding Plan API Turbo 默认配置](todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md)：方案已确认，待实施。Flash PDF 移入通用模型规则，两个套餐 API 模板 Turbo 默认关闭；设置页和模型选择菜单隐藏 Coding Plan GLM-5.3 的视觉标，不改桥接图片能力，Flash 保留视觉标。Account 默认启停和个人显式覆盖不改，本次只落盘。

- [Todo125：模型设置页问号说明与定稿文案](todo-125-model-settings-help-copy.md)：裁决已确认，待实施。本次只落盘；后续严格按逐字文案及交互要求执行，不自行改布局、配置行为或扩大范围。

- Todo95C、Todo97、Todo98 已按各自最终范围完成；残余跨端验证归 Todo102，不重复列为开发待办。
- [Todo102：遗留验证统一收口](todo-102-verification-debt-closeout.md) 是残余欠测、既有失败和 pending 人工晋级的唯一排期入口；旧验证 Todo52/57/64/78 关闭并转交，历史通过/失败证据不删、不改写为通过。
- Todo96 的显式 Subagent 缺口已由 Todo99 完成；Todo87/88 中相关暂缓文字仅是历史裁决。Todo99 本轮实现已收口，Todo100 调查已完成，跨端延期仍在 Todo102 留账。
- Todo11/22/45/80/86 等旧专题继续暂放，Todo101 仍是未来 Draft；不重开已废弃 Todo15/19。m2 的 Schema Todo99 合入后编号为 Todo104，不重命名现有 Todo99/100。

- [Todo104：上线前持久化 Schema 梳理与精修](todo-104-pre-release-schema-review.md)：用户于 2026-09-10 授权实施。以最终裁决为准，分组验证；原文中的“仅讨论／未授权”是历史状态。独立实施分支不改变 Todo103 staging 候选的验收结论。

下方目录树和实施顺序保留历史过程；未被新裁决取代的原则继续有效，最新状态按本节、各 Todo 顶部和后续实施证据读取。

已完成：[Todo 85：staging 撤销与人工冲突处理后的功能恢复](./todo-85-staging-revert-behavior-restoration.md)，包含已裁决的 Todo87 替代实现。过程、裁决、提交和验证统一记录在 [恢复审计表](../plan/staging-conflict-restoration-audit.md)，新 E2E 保留 pending 等待人工转正。

本目录记录 Provider 架构如何分阶段进入代码。当前目标结构统一放在
[`../design-v2/design.md`](../design-v2/design.md)，历史矛盾的裁定见
[`../design-v2/evidence-and-contradictions.md`](../design-v2/evidence-and-contradictions.md)。本目录只回答实施问题：
这一阶段要改变什么、如何拆分、实际完成了什么、实施中出现了哪些偏差，以及还剩哪些问题。

```text
steps/
├─ steps.md
│  └─ 实施文档的职责和维护规则
├─ migration-roadmap.md
│  └─ M0 至 M6 的总体迁移顺序与独立后续专题
├─ 01-model-and-request.md
│  └─ M1 实施目标、结果和遗留项
├─ 01-model-and-request-implementation-log.md
│  └─ M1 超出原计划的自主决策与保留证据
├─ 01-model-and-request-review.md
│  └─ M1 合入后的全面复核
├─ 02-provider-config-and-registry.md
│  └─ M2 实施目标、切片、当前状态和剩余退役边界
├─ 02-provider-config-and-registry-human-in-the-loop.md
│  └─ M2 中交由人确认的架构、产品与公共契约裁决
├─ 02-provider-config-and-registry-impact.md
│  └─ M2 首个纯领域切片开工时的历史影响面和测试契约
├─ 02-provider-config-and-registry-cleanup.md
│  └─ M2 退役审计、残留链路和最终完成门禁
├─ 02-provider-config-and-registry-review.md
│  └─ M2 新增代码规模、过渡边界与后续退场条件评审
├─ 02-provider-config-and-registry-mr-review.md
│  └─ M2 Merge Request 静态审查中尚未裁决的问题与初步方向
├─ 02-provider-config-and-registry-implementation-log.md
│  └─ M2 按时间顺序保存的自主决策和审计证据
├─ 03-provider-architecture-cutover.md
│  └─ 当前大 Merge Request 的 M3 集成实施计划、删除门禁与验收矩阵
├─ 03-provider-architecture-cutover-implementation-log.md
│  └─ M3 自主工程决策、当前基线和验证轨迹
├─ 03-staging-integration.md
│  └─ M3.0 staging 语义移植方案与待裁决的 Rebase 门禁
├─ 04-model-execution-cutover.md
│  └─ M4 闲时任务、Subagent 与统一 Model 创建链的阶段设计和实施结果
├─ todo-01-core-model-adapter-boundary-cleanup.md
│  └─ Core 到 ModelFactory/Model 单链收口的已完成清理
├─ todo-02-ai-sdk-execution-registry-retirement.md
│  └─ Adapter 内旧 AI SDK 执行 Registry 的已完成退役
├─ todo-03-provider-model-ownership-and-property-totality.md
│  └─ 历史模型成员所有权与 Properties 完整性实施；启停、重复成员和设置交互已由 Todo 21 取代
├─ todo-04-core-model-connection-port-retirement.md
│  └─ Core Model Connection Port 退役的已完成清理
├─ todo-05-model-ref-retirement.md
│  └─ ModelRef 按消费者语义退役的已完成清理
├─ todo-06-config-storage-envelope-repository-privatization.md
│  └─ Config 存储外壳和 migration 收回 Repository 私有实现
├─ todo-07-account-connection-selection-and-access-context-cutover.md
│  └─ 账号连接结构化选择、Provider Account Access 与请求鉴权收口
├─ todo-08-legacy-model-catalog-retirement.md
│  └─ Legacy Model Catalog、override 和 Reasoning State 退役
├─ todo-09-off-peak-model-selection-legacy-projection-retirement.md
│  └─ Off-Peak 旧模型投影退役并统一 scoped Selection View
├─ todo-10-zcode-builtin-provider-config-naming-cutover.md
│  └─ Provider Config 的 official 命名一次性切换为 ZCode Built-in
├─ todo-11-provider-runtime-composition-boundary-cleanup.md
│  └─ Provider Runtime 组合边界、资源 owner 与进程组合根清理的待裁决草案
├─ todo-11a-provider-runtime-disposal-functional-fix.md
│  └─ Provider Runtime 完整释放的独立功能性修复
├─ todo-12-model-selection-validation-boundary-cutover.md
│  └─ 删除用户 Facade 执行校验并将权威校验归位到 ModelFactory
├─ todo-13-target-host-model-selection-authority.md
│  └─ 目标 Host 模型选择权威与旧准备链退役
├─ todo-14-post-refactor-mechanical-zero.md
│  └─ Provider Refactor 已完成的首轮机械归零
├─ todo-16-unplanned-model-abstraction-residue-cleanup.md
│  └─ 未规划 Model 抽象残留归零
├─ todo-17-provider-registry-settings-authority-boundary-closure.md
│  └─ Resolver、Registry 与 Settings 权威边界收口
├─ todo-18-zcode-builtin-client-config-sync-and-lkg.md
│  └─ ZCode Built-in Release 的远端同步、Environment Active Cache 与刷新消抖
├─ todo-20-account-overlay-atomicity-and-review-closeout.md
│  └─ Account Overlay 原子发布与 Endpoint Active 隔离；其中 enabled 旧语义已由 Todo 50 取代
├─ todo-21-zcode-builtin-config-ownership-and-model-activation-order.md
│  └─ Built-in 配置职责、Model Config 启停、Provider/Model 顺序、设置页与 ZCode V4 Access 归位
├─ todo-22-additional-builtin-providers-and-cloud-access.md
│  └─ OpenRouter、OpenCode Zen、Azure、Volcano Ark 与 AWS Bedrock 的独立接入草案
├─ todo-23-provider-refactor-decision-gap-closure.md
│  └─ 完成后反向审查发现的 Account Access、ModelSelection 与 Settings 事务缺口收口
├─ todo-24（文档仅官方版本保留）
│  └─ 取代 Todo 23 的 Access 切片，收口账号动态鉴权、Access Type 与请求安全校验唯一事实来源
├─ todo-25-zapi-product-entry-retirement.md
│  └─ 删除 ZAPI 产品入口、专属内网 Gate、旧配置迁移和当前身份残留
├─ todo-26-zhipu-access-mode-contract-cutover.md
│  └─ 用两层 Access Type/Mode 取代伪通用协议字段；Account API 旧切片已由 Todo 49 取代
├─ todo-27-provider-settings-dogfood-closeout.md
│  └─ 收口模型 Overlay 交互、窗口级成功反馈、Team 状态机与 Runtime Headers Schema 漂移
├─ todo-28-model-rule-precedence-and-order-canonicalization.md
│  └─ 收口 Personal Rule 精确优先级和 Provider/Model 三段顺序的读写一致性
├─ todo-29-model-config-resolution-and-idle-trigger-closure.md
│  └─ 收口模型默认配置解析命名、加载反馈和 Provider/Model 闲时触发
├─ todo-30-provider-settings-scroll-affordance.md
│  └─ 为 Provider 设置左右独立滚动区增加条件式边界提示
├─ todo-31-model-metadata-editor-input-consistency.md
│  └─ 收口模型 JSON 输入框、技术输入属性和中文输入法 Enter 行为
├─ todo-32-team-plan-settings-effective-provider-boundary.md
│  └─ 分离 Team 套餐状态卡与 Effective Provider 设置投影，禁止套餐状态隐藏模型配置
├─ todo-33-personal-provider-config-file-cutover.md
│  └─ 将 Personal Provider/Model Config 切换到 provider_config.json，退役旧 Store 与旧 Coding Plan Key 迁移
├─ todo-34-model-selection-async-state-and-repo-wiki-draft.md
│  └─ 显式化 Model Selection 异步状态，并用 ModelSelection 收口 Repo Wiki Draft、Fallback 与提交准入
├─ todo-43-models-api-evidence-and-minimax-m3-correction.md
│  └─ 将 Models API 定位为发布证据，并校正 MiniMax M3 的官方成员、能力与默认启用状态
├─ todo-45-models-api-publisher-evidence-tool.md
│  └─ 待执行：用执行期访问材料采集 Models API 实时目录并生成 Built-in 差异报告；全面实时校正受厂商凭据阻塞
├─ todo-46-model-reorder-visual-continuity.md
│  └─ 收口 Model 调序 pending 视觉连续性与列表单层边框
├─ todo-47-provider-connectivity-save-and-result-cleanup.md
│  └─ 连接测试复用正式 Model、等待 Provider 草稿保存，并删除重复错误分类和旧结果投影
├─ todo-48-account-api-and-manual-api-key-boundary-cleanup.md
│  └─ Account API 幻觉的调查记录；正式裁决与实施由 Todo 49 取代
├─ todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md
│  └─ 删除伪 Account API，将 Z.ai/BigModel 按量 API 归回真实 API Key Provider
├─ todo-50-provider-enabled-and-account-entitlement-separation.md
│  └─ 分离 Provider 配置参与开关与 Account Access 权益事实
├─ todo-51-provider-access-consumer-and-offpeak-auth-closeout.md
│  └─ 收口 Provider Access 消费语义、Welcome API Key Overlay 与 Off-Peak 鉴权来源
├─ todo-52-provider-e2e-regression-closeout.md
│  └─ 已完成：删除过时 Family Case、迁移正式输入 Fixture，并收口 Registry 轮询屏障
├─ todo-55-provider-template-inheritance-cutover.md
│  └─ 已完成：按量 API 与普通供应商迁入 Template，Z.ai/BigModel Family 收窄为 Account-only
├─ todo-56-remote-provider-provisioning-environment-sync.md
│  └─ 已完成：合并远端 Provisioning 基线，并以 Application 级 Environment Coordinator 收口自动同步
├─ todo-57-provider-e2e-runtime-verification-closeout.md
│  └─ 已实施：45 条 macOS Provider E2E 通过；1 条真实 SSH Remote Case 因缺少凭据未跑
├─ todo-69-provider-refactor-practical-rollback-compatibility.md
│  └─ 不做多领域持续双写；仅隔离 Bot v3 文件，保留旧文件并验证 staging 的实际读取边界
├─ todo-70-session-model-selection-migration-and-unbound-recovery.md
│  └─ 将旧 Session 迁移限制在存储边界；失效选择留空、不弹提示、不阻断历史
├─ todo-71-persistent-composer-draft-and-submission-state.md
│  └─ 持久化 Composer mode/ModelSelection；失效留空且不弹提示，收口提交与 Queue 冻结语义
├─ todo-72-legacy-builtin-provider-and-model-selection-migration.md
│  └─ 修正旧内置配置分类、仅迁 Built-in API Key，并按当前账号连接迁移旧 Coding Plan 选择身份
├─ bugfix-01-builtin-provider-overlay-recreation.md
│  └─ 删除普通 Built-in Personal Overlay 后，同一 Host 内无法重新添加的生命周期修复
├─ bugfix-02-provider-reorder-drop-flicker.md
│  └─ Provider 拖拽松手后先回弹旧位置、再跳到目标位置的乐观排序修复
├─ bugfix-03-provider-review-boundary-closeout.md
│  └─ 收口 Provider Review 发现的设置边界与模型配置语义问题
├─ bugfix-04-model-json-editor-fixed-height.md
│  └─ Model JSON 编辑器固定高度并在控件内部滚动
├─ bugfix-05-personal-config-worker-refresh.md
│  └─ 删除 Personal Config 的 fs.watch，以内容 revision 轮询和连接测试主动刷新修复 Worker Registry 陈旧
└─ bugfix-06-readonly-provider-field-affordance.md
   └─ 统一 Built-in Provider 只读 Endpoint 与 API Schema 的冻结展示语义
```

子文档按实施顺序组织：

- [`migration-roadmap.md`](./migration-roadmap.md) 给出 M0 至 M6 的总体迁移顺序、跨阶段约束和不属于本次重构的独立后续专题。
- [`01-model-and-request.md`](./01-model-and-request.md) 总结 M1 的实施目标、实际交付和遗留项。
- [`01-model-and-request-implementation-log.md`](./01-model-and-request-implementation-log.md) 保存 M1 实施中超出原计划的自主决策，并附带当时留下的验证证据。
- [`01-model-and-request-review.md`](./01-model-and-request-review.md) 保存 M1 合入后的完整性复核和风险分级。
- [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md) 记录 M2 的实施目标、切片、当前状态和剩余退役边界。
- [`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md) 记录 M2 中必须由人确认的架构、产品和公共契约裁决，并说明它们对当前实施的影响。
- [`02-provider-config-and-registry-impact.md`](./02-provider-config-and-registry-impact.md) 保存 M2 首个纯领域切片开工时的影响面、不变量和测试交接；其中的范围与未决项是历史实施证据。
- [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md) 记录 M2 退役清理结果、仍保留的窄兼容边界和上线验证证据。
- [`02-provider-config-and-registry-review.md`](./02-provider-config-and-registry-review.md) 量化 M2 新增代码，并区分目标实现、一次性迁移和仍在运行的过渡边界。
- [`02-provider-config-and-registry-mr-review.md`](./02-provider-config-and-registry-mr-review.md) 记录 M2 Merge Request 全量静态审查中发现、但尚未形成最终裁决的问题；它不改写 Design 或阶段完成状态。
- [`02-provider-config-and-registry-implementation-log.md`](./02-provider-config-and-registry-implementation-log.md) 按时间顺序保存 M2 的自主决策和审计证据；当前结论以 Design、M2 主文档和 Human in the Loop 为准。
- [`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md) 把当前 Merge Request 定义为 M3 架构切换：在已完成的 Config/Registry 基础上，一次完成原子 Submission、模型选择状态、设置页和旧链路退役。
- [`03-provider-architecture-cutover-implementation-log.md`](./03-provider-architecture-cutover-implementation-log.md) 保存 M3 当前实施基线、超出计划的自主决策和验证轨迹。
- [`03-staging-integration.md`](./03-staging-integration.md) 记录 M3 第一步如何吸收 staging 的 Video Input、模态设置和 ox-alpha reasoning，区分需要保留的产品语义与需要推翻的临时 Provider 实现。
- [`04-model-execution-cutover.md`](./04-model-execution-cutover.md) 记录 M4 如何用通用 Provider 可见性、请求期 Access、标准 Registry/ModelFactory 和 Active Model 收口闲时任务与 Subagent，并删除旧 Runtime Overlay。
- [`todo-01-core-model-adapter-boundary-cleanup.md`](./todo-01-core-model-adapter-boundary-cleanup.md) 记录 Core 删除 Adapter 旁路、统一使用 ModelFactory/Model 的已完成工作。
- [`todo-02-ai-sdk-execution-registry-retirement.md`](./todo-02-ai-sdk-execution-registry-retirement.md) 记录 Adapter 内旧 AI SDK 执行 Registry 的已完成退役。
- [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md) 记录已完成的 `builtinModelIds`/`modelIds` 与 Effective Properties 完整类型边界；其中 Model visibility、冲突 DTO 和旧设置交互是历史实施事实，已由 Todo 21 取代。
- [`todo-04-core-model-connection-port-retirement.md`](./todo-04-core-model-connection-port-retirement.md) 记录 Core Model Connection Port 的待执行退役计划。
- [`todo-05-model-ref-retirement.md`](./todo-05-model-ref-retirement.md) 记录 ModelRef 按真实消费者语义逐步退役的待执行计划。
- [`todo-06-config-storage-envelope-repository-privatization.md`](./todo-06-config-storage-envelope-repository-privatization.md) 把 Config Document、版本外壳和 migration 收回 Repository 私有实现。
- [`todo-07-account-connection-selection-and-access-context-cutover.md`](./todo-07-account-connection-selection-and-access-context-cutover.md) 记录账号连接结构化选择、Account Built-in Provider Access、Request Auth、Off-Peak 与 Official MCP 的统一收口。
- [`todo-08-legacy-model-catalog-retirement.md`](./todo-08-legacy-model-catalog-retirement.md) 删除 Legacy Model Catalog、override 与 Reasoning State，并以 Config 驱动保留的请求投影。
- [`todo-09-off-peak-model-selection-legacy-projection-retirement.md`](./todo-09-off-peak-model-selection-legacy-projection-retirement.md) 删除 Off-Peak 旧模型 DTO 投影，统一使用 scoped Registry Selection View。
- [`todo-10-zcode-builtin-provider-config-naming-cutover.md`](./todo-10-zcode-builtin-provider-config-naming-cutover.md) 将 Provider Config 的 `official` 领域、代码和物理命名一次性切换为 ZCode Built-in，不保留兼容入口。
- [`todo-11-provider-runtime-composition-boundary-cleanup.md`](./todo-11-provider-runtime-composition-boundary-cleanup.md) 保存 Provider Runtime 多层包装、Node Config 资源边界和 Host/Agent 两个组合根的现状证据与候选方案；当前仍是不得实施的待裁决草案。
- [`todo-11a-provider-runtime-disposal-functional-fix.md`](./todo-11a-provider-runtime-disposal-functional-fix.md) 独立修复 Provider Runtime 释放未贯穿 Protocol Agent 生命周期的问题，不等待 Todo 11 的架构裁决。
- [`todo-12-model-selection-validation-boundary-cutover.md`](./todo-12-model-selection-validation-boundary-cutover.md) 删除用户 Model Selection Facade 的内部执行校验入口，将权威校验归位到 Registry/ModelFactory，并保留 Off-Peak 窄提前检查。
- [`todo-13-target-host-model-selection-authority.md`](./todo-13-target-host-model-selection-authority.md) 将模型候选、默认值和执行校验统一归属目标 Environment Host。
- [`todo-14-post-refactor-mechanical-zero.md`](./todo-14-post-refactor-mechanical-zero.md) 记录已完成的 Factory、MCS、Legacy DTO 和死代码首轮机械归零。
- Todo 15 已标记为废弃，不再作为独立发布验证 Todo；后续上线验证按最终 Release Checklist 另行收口。
- [`todo-16-unplanned-model-abstraction-residue-cleanup.md`](./todo-16-unplanned-model-abstraction-residue-cleanup.md) 删除首轮规划之外仍存在的 Runtime、Protocol、Legacy Config 和文档抽象残留。
- [`todo-17-provider-registry-settings-authority-boundary-closure.md`](./todo-17-provider-registry-settings-authority-boundary-closure.md) 收口 Resolver 完整类型、Settings 三层 View、细粒度保存、写入时序和 connectivity；Provider/Model 生命周期、来源与排序的旧裁决已由 Todo 21 取代。
- [`todo-18-zcode-builtin-client-config-sync-and-lkg.md`](./todo-18-zcode-builtin-client-config-sync-and-lkg.md) 记录已完成的两层 Release、Bundled/Active/LKG 选择、Environment owner、远端同步与落盘 lease。
- Todo 19 已标记为废弃，不再作为独立发布门禁 Todo；如未来确需发布门禁，另立新的、基于当时发布流程的任务。
- [`todo-20-account-overlay-atomicity-and-review-closeout.md`](./todo-20-account-overlay-atomicity-and-review-closeout.md) 记录 Account Overlay 原子发布、Built-in 来源 revision barrier、Endpoint Active/LKG 隔离，以及 CLI、依赖和孤儿 ZIP 收口；其中 Account `enabled` 旧语义已由 Todo 50 取代。
- [`todo-21-zcode-builtin-config-ownership-and-model-activation-order.md`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md) 已完成 Built-in Provider/Model 配置职责收口：Provider 管理模型成员与顺序，Model Config `enabled` 管理模型执行门禁，Personal 专属 Rule 承载设置页单模型覆盖，Registry/Selection 统一 executable/selectable 语义，同时将官方版本的请求安全校验配置从 Model Config 归位到 Provider Access。
- [`todo-22-additional-builtin-providers-and-cloud-access.md`](./todo-22-additional-builtin-providers-and-cloud-access.md) 独立设计 OpenRouter、OpenCode Zen、Azure、Volcano Ark 与 AWS Bedrock 的 Built-in 模板、Access 和真实请求验证；不阻塞 Todo 21。
- [`todo-23-provider-refactor-decision-gap-closure.md`](./todo-23-provider-refactor-decision-gap-closure.md) 已收口同形 ModelRef、Selection 字符串和 Settings 原子事务；其 Access 切片由 Todo 24 取代。
- Todo 24（文档仅官方版本保留）取代 Todo 23 的 Access 切片：删除账号创建时绑定，收窄 Account Overlay，严格切换 Access Type，并收口官方版本请求安全校验的唯一静态准入事实。
- [`todo-25-zapi-product-entry-retirement.md`](./todo-25-zapi-product-entry-retirement.md) 删除已经退出产品的 ZAPI Provider 身份、设置入口、专属内网门禁与 Legacy 迁移特例，同时保留通用内网探测和依赖下载能力。
- [`todo-26-zhipu-access-mode-contract-cutover.md`](./todo-26-zhipu-access-mode-contract-cutover.md) 取代 Todo 24 的 Access 结构：只保留普通 `api-key` 与 `zhipu-account`，用 Built-in `family + mode` 驱动 Start、Individual、Team、Off-Peak、官方版本安全校验与请求期鉴权，并删除伪通用协议字段；其中伪 Account API 已由 Todo 49 删除。
- [`todo-27-provider-settings-dogfood-closeout.md`](./todo-27-provider-settings-dogfood-closeout.md) 收口实机体验后的剩余问题：统一模型布尔 Overlay 样式和模型级恢复默认，将成功反馈锚定窗口底部，区分 Team 未知/失败/明确不可用，并让 Runtime Headers 严格复用正式 Registry Access Schema。
- [`todo-28-model-rule-precedence-and-order-canonicalization.md`](./todo-28-model-rule-precedence-and-order-canonicalization.md) 修正 Todo 21/23 完成后仍存在的两处机械偏差：统一 `Built-in + Personal Match + Personal provider-model` Rule 优先级，并让 Resolver 与所有写入边界复用同一套 Provider/Model 三段顺序规范化。
- [`todo-33-personal-provider-config-file-cutover.md`](./todo-33-personal-provider-config-file-cutover.md) 将 Personal Provider/Model Config 独立到 `provider_config.json`，只从已发布旧 `config.json` 单向导入，并删除 `model-providers.json`、旧 Coding Plan Key 与迁移备份链。
- [`todo-34-model-selection-async-state-and-repo-wiki-draft.md`](./todo-34-model-selection-async-state-and-repo-wiki-draft.md) 将 Model Selection 的 loading、unavailable、error 与 ready 显式化，以 `ModelSelection` 取代 Repo Wiki 控件字符串状态，并删除 Renderer 的第二套 fallback。
- [`todo-45-models-api-publisher-evidence-tool.md`](./todo-45-models-api-publisher-evidence-tool.md) 规划 Built-in 发布者使用的 Models API 实时目录证据工具；工具实现可先使用 Fixture 推进，但所有厂商的实时校正受对应访问材料阻塞，且不自动改写发布配置。
- [`todo-47-provider-connectivity-save-and-result-cleanup.md`](./todo-47-provider-connectivity-save-and-result-cleanup.md) 让连接测试复用 Provider 草稿唯一提交时序，删除旧 Model Config 写入口、重复错误分类和多 Endpoint UI 残余。
- [`todo-48-account-api-and-manual-api-key-boundary-cleanup.md`](./todo-48-account-api-and-manual-api-key-boundary-cleanup.md) 是 staging 行为、凭据来源与 Account API 幻象的研究/裁决记录，不再作为独立实施 Todo。
- [`todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md`](./todo-49-manual-api-key-and-coding-plan-credential-boundary-cutover.md) 记录已完成的阶段性切换：删除两个重复 Account API Provider 与 `zhipu-account/api-key`，并将自动项目 Key 严格收窄到 Coding Plan 请求鉴权；其中 `zai-api` / `bigmodel-api` 固定占据 Family“按量 API”槽位的结论由 Todo 55 继续取代为 Provider Template。
- [`todo-50-provider-enabled-and-account-entitlement-separation.md`](./todo-50-provider-enabled-and-account-entitlement-separation.md) 保留 Provider `enabled` 作为“加入当前配置”的唯一事实，并将账号套餐资格收缩为 `zhipu-account access.entitled`，删除 Account Overlay 对顶层 `enabled` 的复用。
- [`todo-51-provider-access-consumer-and-offpeak-auth-closeout.md`](./todo-51-provider-access-consumer-and-offpeak-auth-closeout.md) 收口 Todo 47/49/50 后的消费层漂移：彻底拆清 `enabled`、`entitled` 与 `executable`，将 Off-Peak 账号材料与逐请求鉴权归并为唯一 Host 私有来源，并删除旧 Family mode、错误接口命名和文档残余；其中 Welcome 保存固定 Family API Provider Overlay 的阶段性结论由 Todo 55 改为创建 Provider Template 实例。
- [`todo-52-provider-e2e-regression-closeout.md`](./todo-52-provider-e2e-regression-closeout.md) 记录已完成的 Provider E2E 回归收口：统一正式输入 Fixture、Bot Selection、Subagent structured selection 和 Personal Config 轮询屏障；删除失去产品对象的 Family Case，并恢复仍有效的 Account、Runtime、恢复和 Upgrade 行为证明。
- [`todo-55-provider-template-inheritance-cutover.md`](./todo-55-provider-template-inheritance-cutover.md) 以复用现有 Provider Config 值结构的 Provider Template 取代全部非 Account Built-in Concrete Provider；Z.ai API / BigModel API 与其他模板一样支持多实例，Family 删除按量 API 槽位并收窄为 Account-only；同时增加 `template-model`、原子 Built-in Release，并退役 Provider placement enabled 与 addable Built-in 生命周期。
- [`todo-56-remote-provider-provisioning-environment-sync.md`](./todo-56-remote-provider-provisioning-environment-sync.md) 先吸收远端 Provisioning Source/Target/事务基线，再删除手动与 only-if-missing 语义；由 Desktop Main 按 Remote Environment 做 application 级 single-flight 调度，并在配置、默认模型、账号、凭据和上线事件后完整覆盖远端执行镜像。
- [`todo-57-provider-e2e-runtime-verification-closeout.md`](./todo-57-provider-e2e-runtime-verification-closeout.md) 在 Todo 56 稳定后真正启动 Electron/WDIO，逐组复现并修复 Todo 52 的 Provider 回归与新增 Remote Provisioning Case，严格区分静态前置检查和实际 E2E 通过证据。
- [`todo-60-required-reasoning-option-and-mapping-editor.md`](./todo-60-required-reasoning-option-and-mapping-editor.md) 将 Reasoning Option 收口为每个 Effective Model Config 的必填事实，退役固定 thinking budget，并开放有序档位与 Mapping placeholder 编辑。
- [`todo-65-provider-settings-dogfood-and-template-ux-closeout.md`](./todo-65-provider-settings-dogfood-and-template-ux-closeout.md) 收口 MacBook Air 实机发现的 Account 连接测试 Reasoning 缺失、Provider Template 视觉退化、空分组横杠和错误反馈失控，并以 Air 当前 HEAD 实机验收作为完成条件。
- [`todo-66-option-map-variable-naming-and-display-formatting.md`](./todo-66-option-map-variable-naming-and-display-formatting.md) 将 Option Map 的通用 `value` 变量改为所属 Option 名称，并以设置页可读性为目标整理 Built-in Map 的换行和缩进。
- [`todo-67-complete-model-selection-before-formal-model-creation.md`](./todo-67-complete-model-selection-before-formal-model-creation.md) 修复连接测试在最低推理档位绑定前进入严格 ModelFactory 的时序错误，并审计所有正式模型创建入口是否传递完整 Selection。
- [`todo-68-active-model-context-single-source.md`](./todo-68-active-model-context-single-source.md) 修复切换模型后 Context 滞后一拍，并让普通 Turn、Guide、Off-Peak 与 Subagent 的 Context、工具和请求统一读取同一 Active Model。
- [`todo-69-provider-refactor-practical-rollback-compatibility.md`](./todo-69-provider-refactor-practical-rollback-compatibility.md) 以冻结 staging Reader 的实际失败范围裁定实用回滚：Provider、Session、闲时、自动化、Settings、Subagent 与 Wiki 不持续双写；仅对 strict 同文件冲突的 Bot Config/State 做 v3 文件隔离，旧文件保持升级前原样。
- [`todo-70-session-model-selection-migration-and-unbound-recovery.md`](./todo-70-session-model-selection-migration-and-unbound-recovery.md) 将真正旧 Session 的转换限制在唯一存储 Decoder，并让 Reasoning、Provider 或 Model 缺失/失效时以未绑定 Selection 打开历史，由用户重新选择后继续执行。
- [`todo-71-persistent-composer-draft-and-submission-state.md`](./todo-71-persistent-composer-draft-and-submission-state.md) 将 Composer 的 mode 与 ModelSelection 并入现有持久 Draft，删除 Renderer 对 Agent Session Snapshot 的持续回读，并收口 Submission 冻结、成功清理、Registry 失效和 Queue 边界。
- [`todo-72-legacy-builtin-provider-and-model-selection-migration.md`](./todo-72-legacy-builtin-provider-and-model-selection-migration.md) 识别误标为 custom 的旧内置 Provider，仅迁 Built-in API Key；将旧 Coding Plan 选择按迁移时当前个人/Team 连接转换，并逐项核对持久化入口，不恢复持续双写。
- [`todo-76-builtin-provider-config-layering-and-site-rules.md`](./todo-76-builtin-provider-config-layering-and-site-rules.md) 已完成：在不改变顺序 overlay 的前提下，整理 Model、API Schema、Provider Site/Base URL、Template 和 Provider Instance 的 Built-in Config 职责。
- [`todo-74-model-capability-layer-and-media-output-contract.md`](./todo-74-model-capability-layer-and-media-output-contract.md) 已完成（流式 JSON Schema 仍由 Todo 80 单独处理）：收口 GLM-5.3-Flash 的 Anthropic-only PDF、内置工具调用能力和 JSON Schema 字段语义。
- [`todo-79-openrouter-opencode-provider-integration-boundary.md`](./todo-79-openrouter-opencode-provider-integration-boundary.md) 已完成首轮 Built-in 模板接入：承接 Todo 22 的 OpenRouter/OpenCode Zen 接入边界、Model ID 语义与现有 attribution/运行时基础。
- [`todo-80-streaming-json-schema-output.md`](./todo-80-streaming-json-schema-output.md) 草案：单独研究流式请求传递 JSON Schema 的 Runtime/Adapter 契约，不改变当前非流式行为。
- [`todo-81-selection-migration-notice-scope-cleanup.md`](./todo-81-selection-migration-notice-scope-cleanup.md) 已完成：普通会话 Composer 失效选择不弹提示；已结束闲时任务不显示修复错误；仍可能执行的闲时任务和定时任务继续保留提示与保护。
- [`todo-82-model-config-follow-recommended-draft.md`](./todo-82-model-config-follow-recommended-draft.md) 已完成：删除模型编辑弹窗重复的启用入口，以 Draft-only 的“跟随推荐配置”开关取代“全部恢复默认”，并在保存时原子物化或清空 Personal Model Config Overlay。
- [`todo-83-account-provider-availability-and-claim-flow.md`](./todo-83-account-provider-availability-and-claim-flow.md) 已实施（首轮收口）：统一 Account Provider 权益状态、Start Plan 领取后的生效/跳转和模型可执行性，保持现有 Family 选择与 Provider 配置边界。

Todo 68–72 联合执行：68 收尾 → 72 身份转换基础 → 69 Bot 文件隔离及正确首次导入 →
70 Session → 71 Composer → 72 其余持久化入口与联合验证。详细分工见 Todo 72。
统一裁决：已有模型/Reasoning 缺失或失效时留空，不自动切默认模型，不弹留空提示；
真正首次新任务仍按既定规则初始化。已错误迁移的 Provider 配置只做人工修复，不增加自动纠错代码。

- [`bugfix-01-builtin-provider-overlay-recreation.md`](./bugfix-01-builtin-provider-overlay-recreation.md) 修复普通 Built-in Provider 删除 Personal Overlay 后，被旧进程内退休门禁永久阻止重新添加的问题。
- [`bugfix-02-provider-reorder-drop-flicker.md`](./bugfix-02-provider-reorder-drop-flicker.md) 修复 Provider 拖拽松手后，拖拽临时位移先清除、正式 Settings View 后到而导致的回弹与二次跳转；Model 保留既有表单乐观排序。
- [`bugfix-03-provider-review-boundary-closeout.md`](./bugfix-03-provider-review-boundary-closeout.md) 收口 Provider Review 发现的设置保存、模型配置槽位与边界问题。
- [`bugfix-04-model-json-editor-fixed-height.md`](./bugfix-04-model-json-editor-fixed-height.md) 将 Model JSON 输入保持为固定高度文本框，长 value 或 Effective placeholder 只在控件内部滚动。
- [`bugfix-05-personal-config-worker-refresh.md`](./bugfix-05-personal-config-worker-refresh.md) 删除 Personal Config 的 `fs.watch` 唯一通知链，改为异步 content-revision 轮询，并让连接测试在查找模型前主动刷新 Worker Registry。

## 文档关系

- [`todo-98-builtin-option-map-formatting-regression.md`](./todo-98-builtin-option-map-formatting-regression.md) 待实施：恢复 Built-in Map 对象结构换行与缩进，简单三目同行；只修排版，保留当前逻辑，独立于 Todo95C 的档位改名。
- [`todo-99-worker-account-selection-repair.md`](./todo-99-worker-account-selection-repair.md) 本轮裁决范围完成：完整 states、接收确认/失败重刷、显式 Subagent、附件、Bot Session 权威、两项局部竞态及逐入口审查闭环；Pro 请求、冷恢复、同步滞后失败/恢复通过，并修复取模失败只记日志无终态。W99-E05 手机/SSH 联合实机经用户明确延期，未冒充全端通过。无生命周期重构、新发送屏障、迁移或 Todo101 改动；详见复审账本和测试记录。
- [`todo-100-account-provider-selection-architecture-investigation.md`](./todo-100-account-provider-selection-architecture-investigation.md) 纯调查完成：记录 states 丢失、虚假 applied ACK、显式 Subagent、Bot 后续轮与附件派发缺口。后续实施计划已收口到 Todo99；调查完成不表示产品已修复。
- [`todo-101-concurrent-account-providers-draft.md`](./todo-101-concurrent-account-providers-draft.md) Draft / 延后实施：个人与多个 Team 具体 Provider 并存、设置页纯导航、撤销跨 Provider 自动对应；实例身份、迁移、抽屉待裁决。仍只登录一个账号，由登录账号决定闲时域，Ticket 不重绑。本次先按现有架构上线，不提前改代码或持久化格式。

- [`todo-87-selection-view-unified-resolution.md`](./todo-87-selection-view-unified-resolution.md) 已实现：账号及 Personal/Built-in 更新后，统一解析原意图，覆盖 Composer、定时后台、Bot、Wiki；闲时只读保护，不跨账号换票。显式 Subagent 本轮按裁决保留原校验。承接 Todo85 D02；无发送前同步或存储迁移，与 Todo86 上游刷新职责分开。

```text
design-v2/
└─ 最终系统如何工作，以及历史材料如何裁定
        |
        v
steps/
└─ 如何从当前代码迁移到该设计
        |
        v
research/
└─ 支撑设计和实施判断的现状证据
```

Research 不是目标设计。实施中发现新事实时，先记录证据，再判断是否影响 design-v2 或当前 step。

## 维护规则

更新待办：[Todo113：近期新模型目录与智能配置更新](./todo-113-new-model-catalog-refresh.md)。首批已完成；2026-09-11 第二轮目录补漏、智能配置深查、聚合支持核实及下线清理为待执行，当前范围以该文档第 0 节为准，不改用户历史选择或账号架构。

新增待办：[Todo112：官方 GLM 真实 Model ID 大小写统一](./todo-112-official-glm-model-id-normalization.md)。官方模板名单／精确规则及 Start 动态模型名单统一命名；已有选择迁移补充官方 GLM 大小写归一，与 Todo111 协调，不涉及第三方、额度卡或历史统计，不额外扩展个人覆盖迁移。全部待确认项已收口，官方端点接受目标大小写由用户确认，待实施。

- [Todo114](./todo-114-account-status-sync-and-key-retry.md)：上游原 Todo105，合并时为避免与本分支模型名单精简重号而改号。已实现个人套餐原因协议补齐、两家缺 Key 分类统一与重试交互；上游 280 条定向测试、四组组件浏览器通过，完整 App / 手机链路剩余验证归 Todo102。

阶段文档至少要让读者能够确认四件事：阶段目标、当前状态、实际交付和剩余问题。具体结构由阶段内容决定，不要求统一套用模板。

阶段开始前明确目标和兼容边界。实施过程中超出计划、但为了继续推进而自主作出的决策进入 implementation log；会改变目标抽象、产品语义或公共契约的问题进入 Human in the Loop，由人裁决后同步回写 design。正常的提交清单和命令输出不需要逐项记录。合入后发现的系统性问题进入 review。

一个切片可以独立合并，但阶段完成时不能保留两套长期业务语义。迁移期兼容逻辑必须有明确位置和退出条件。
