# Provider 设置页

> 状态：当前有效设计
>
> 最近更新：2026-09-08

Provider 设置页编辑 Personal Config，并通过 Host 中的 Provider Settings Service 与目标 Environment 的 Config、Registry 交互。页面采用自动保存：输入过程保留本地草稿，一次编辑动作结束后提交本次编辑后的 Personal Provider Draft；Host 完成持久化并刷新 Registry 后，页面才确认保存成功。

```text
Renderer Draft
      |
      | 编辑动作完成
      v
Provider Settings Service
      |
      | 原子更新 Personal Config
      v
Provider Config Service
      |
      | invalidation + refresh
      v
Provider Registry
      |
      | 返回最新 Settings View
      v
Renderer 显示保存成功
```

设置页不读取物理配置文件，也不在 Renderer 中执行 Overlay、完整性校验或 Registry 成员判断。远端设置页调用目标 Environment 的同一 Service；Desktop 不把本机 Provider 配置当作远端事实。

## 自动保存

### 账号套餐失效后的连接切换（Todo93）

2026-09-08 裁决：同账号、同完整连接从 available/pending 变为明确 unavailable 时提示一次，并提供“切换至具体套餐”按钮；只有用户点击、重新校验并条件写入成功后才改变实际连接。持续不可用不重复提示，unknown 不当失效，恢复后再次失效是新事件。首次启动/切换身份只建立基线，不比较不同套餐的状态；手动选未开通个人套餐不自动弹回。保留首次无选择的初始化及旧连接迁移保护。

观察记录只在根层内存维护，不新增持久化字段/迁移。AccountProviderState.connectionKey 是同轮账号与完整连接身份的摘要，只供观察隔离，不进入 Config Overlay。设置页手动选择仍沿用原保存入口，Start 连接入口过滤及 Provider visibility 不变，不绕过模型执行门禁。详细状态、旧建议失效和测试边界见 [Todo93](../../steps/todo-93-account-plan-loss-manual-switch.md)。它替代 Todo88 R06 的自动切换裁决；当前实现只在点击并重新验证后条件写入。

### 模型弹窗最终裁决（Todo90 / Todo92）

2026-09-08 已按本节实现并通过 Pro 联合验收；证据由 Todo90/92 记录，与下文历史“恢复默认”及焦点边框描述冲突时以本节为准。

- 保留保存/取消同行的开关，显示名称改为“智能配置”。说明：“根据模型 ID 自动匹配推荐配置，允许单独修改。”
- 开启：按模型 ID 匹配并继承推荐配置，允许个人覆盖；关闭：把当前有效草稿完整填入，所有配置必填，不再按 ID 匹配或借推荐补齐，不显示个人覆盖样式。
- 重新开启清除模型配置覆盖，按当前 ID 恢复推荐；之后的新编辑仍保留。所有切换只改草稿，保存生效、取消放弃，不改变 ID/启停/成员归属。现有模式字段保留，不新增迁移。
- 边框只表达无覆盖/有覆盖，采用中性/淡强调色细边框；保存重开保留来源标记。数值、模态、能力、MFJS 各项独立；修改档位名称、数量、顺序时所有档位框一起高亮，Mapping 单独高亮。外层容器不高亮。
- Hover 与聚焦共用轻微背景变化，不修改边框、不加额外焦点轮廓；选项开启/关闭底色和键盘焦点仍需可辨认。只调整模型编辑器，不全局改共享基础组件。
- MFJS 使用与能力选项相同的按钮样式，无图标、无前置复选框；彻底删除“没有 icon 就渲染复选框”的视觉分支，保留可访问性语义。
- 保留推理外层容器及档位/Mapping 内部编辑区，去掉重复的“推理设置”标题；高级设置保留标题和容器。没有“自定义”文字、没有组级或全局恢复默认按钮。

实现与验收分别见 [Todo90](../../steps/todo-90-model-add-edit-shared-recommended-draft.md) 和 [Todo92](../../steps/todo-92-model-smart-config-and-override-feedback.md)。

实现归属：添加/编辑共用编辑草稿 hook；个人字段的来源标记属于编辑意图，不通过整份表单校验结果倒推。Host 返回推荐基线，UI 只把未覆盖的控件投影到基线，不自行做规则匹配。固定模式停止推荐请求；Host 写入检查完整性，运行解析只采用其完整个人配置（enabled 仍按独立启停规则处理），不能借 Built-in 补缺。

### 写入与编辑事务补充（Todo 89）

内置/账号 Provider 可以尚无 Personal Provider 记录。修改成员或顺序时由 Config Service
按需建立稀疏覆盖；编辑模型配置不要求也不额外创建 Provider 记录。成员来源统一来自 Facade
同一快照，不能改用可执行 Registry 或静态名单。新增模型保留已有成员的相对顺序并追加新成员。
删除后的 Personal-only Provider 不得被迟到保存重新创建。

模型启停使用独立叶子更新，在原子事务中读取最新个人配置，只改变 enabled，保留配置模式和其余字段。
Provider 表单只提交被编辑的配置项，未触碰的 headers 等字段保留；没有编辑不触发保存。

模型弹窗打开时固定本次编辑的原模型、草稿和 revision。外部 View 更新不覆盖这份草稿，保存仍检查版本；
冲突或失败保留输入，取消并重新打开才加载最新值。配置不完整的模型仍提供编辑修复和启停入口；
个人成员可删除，继承成员不可删除或重命名。可编辑不代表可执行，Registry 完整性校验保持不变。

模型成员和配置直接显示 Host 返回的 View，不再维护一份添加/删除失败时整表回滚的副本；
仅拖拽保留已有乐观顺序。添加弹窗等待实际保存完成才关闭，失败在原草稿中重试；
显式弹窗不提供脱离草稿的通知重试操作。账号与普通供应商详情共用同一组模型写入回调。
Start Plan 已由 Account 快照确认可用时，额度/套餐卡重新查询的临时空状态不能卸载模型编辑区；
并不因此允许未领取的 Start Plan 展示模型，也不修改权益查询缓存、切换套餐或执行门禁。

文本输入在编辑过程中只修改组件内 Draft。连续 1200ms 没有新输入时自动提交；输入框失去焦点、
用户按 Enter，或者切换到其他 Provider 时立即提交一次 Personal Provider Draft 更新。选择框、开关和拖动在操作完成后立即提交。

```text
输入字符
├─ 更新本地 Draft
└─ 1200ms 无新输入 -> 自动保存

失去焦点 / Enter / 切换 Provider
├─ Provider 字段：保存 Personal Provider Draft
└─ Model 字段：保存该模型的 Personal Exact Draft

选择 API Format / 切换 Enabled / 拖动结束
└─ 立即保存操作后的 Personal Draft
```

文本 idle-trigger 只调度当前 Provider Draft 的一次保存；每次新输入取消上一计时器，连续输入只保存最终值。
失焦、Enter 和切换 Provider 会取消计时器并立即 flush。自动保存不得建立第二份 accepted queue；
过期响应继续由 Provider Draft revision 隔离。

新增和编辑模型 ID 时使用同一 1200ms idle-trigger 调度 `resolveModelConfig()`。该方法只按当前
Provider 与未保存的稀疏 Model Draft 解析 `inheritedConfig/effectiveConfig/issues`，不持久化、不改变
Registry revision。失焦、Enter 或显式保存立即 flush；保存按钮等待当前 Resolution 完成后在同一次操作中继续提交。

推荐配置匹配提示使用“已为模型匹配到推荐配置”（英文：Recommended settings matched for this model），
不再称为“已加载模型默认配置”。此处只调整提示文案，不改变解析、提示时机或保存行为。

一次保存只提交本次操作所属的 Personal Draft，而不是把页面当前集合当 Repository 快照：Provider 字段只
写 Provider Config；Model 字段只写该模型的 `type="provider-model"` 专属 Rule。新增 Personal Model 原子写入
`modelIds` 成员、完整 `modelOrder` 与初始 `enabled=true` 专属 Rule；删除、重命名和调序也使用各自的领域原子操作。
任何普通保存都不遍历或替换同 Provider 的其他
Model Rules，也不把 Effective Config 反向复制进 Personal。
完整暴露的一个配置项在被用户修改后提交完整替代值；未修改的继承值不因表单加载或无关字段保存而物化。
Provider Settings Facade 以同一 revision 的 Effective Built-in 与 Personal 为输入生成 Settings View，并由
Personal Repository 原子更新配置。保存方法等待相应 Registry 刷新完成后返回，因此成功响应同时表示：

1. Personal Config 已经持久化；
2. 当前进程 Registry 已经观察到这一版本；
3. 返回的 Settings View 对应这次提交后的事实。

设置页是否展示、锁定或隐藏一个字段，只是 UI 产品决策，不是 Config Schema 的权限边界。正式 UI 可以
不开放 Account Access、Built-in Model ID、PDF/Audio 等字段，但 Schema 不因此增加“用户不得书写”的
来源校验。用户手工编辑 Personal Config 时仍使用相同 Overlay、结构与完整性规则；业务上无效但结构完整
的账号连接由 Request Auth 或服务端请求失败承接。

模型格式 Draft 直接维护 `properties.input_format` / `properties.output_format`。输入页只展示锁定的
Text 与可编辑的 Image、Video、PDF；Audio 隐藏但必须原样保留。输出页只展示锁定的 Text。
Facade 不从 Built-in 基线反向生成 Personal Rule。它以 Effective Built-in 与已有 Personal Overlay 计算
权威 Effective Config；Renderer 只提交用户实际修改后物化的叶子，隐藏字段未被触碰时不会产生新覆盖。详见
[`../model/input-output-format.md`](../model/input-output-format.md)。

正常编辑的 View 按来源提供只读 `templateConfig?`、`effectiveBuiltinConfig?`、稀疏 `personalConfig` 和权威
`effectiveConfig`；Template 创建的 Personal Provider 不伪造 `effectiveBuiltinConfig`。Renderer 只把
`personalConfig` 复制为 Personal Draft。继承值可以作为控件展示值，但只有用户
触碰某个配置项时才把该项物化进 Draft。普通字段可以通过恢复默认删除对应 Personal 字段；模型列表中的
`enabled` 开关不提供“恢复默认”操作，用户每次切换都保存明确的 Personal 布尔值。Renderer 不调用 Effective →
Personal diff，也不自行组合成员或计算冲突。

页面为每个 Provider Draft 维护递增 revision。只有响应 revision 与当前 Draft revision 一致时，才可以把当前输入显示为已保存；较早请求的迟到响应不能覆盖新输入，也不能错误显示成功。同一 Provider 的
Provider/Model/成员写入按发生顺序执行；rename 等待旧 ID 操作并切换后续身份，delete 是终止操作，连接测试
等待相关保存。外部 View 更新只刷新未编辑字段，dirty 字段保留本地输入；保存失败保留输入与重试入口。

## 保存反馈

Renderer 内部继续使用 Draft revision 区分本地编辑、在途保存和过期响应，但不向用户展示 `dirty` 文案，也不在
Provider 内容区保留另一套保存状态。一次保存操作只投影为窗口底部的一条通知，并按同一稳定 key 原位替换：

```text
saving（不自动消失）
  |
  +-- success -> 同 key 替换，短暂停留后淡出
  |
  `-- failure -> 同 key 替换，延长停留并提供重试/关闭
```

模型弹窗的保存按钮仍在请求期间显示 Spinner 并禁止重复提交；这是操作控件状态，不是第二套保存反馈。只有 Host
确认相应 revision 后才能用 success 替换 saving。较早请求的迟到响应不得覆盖当前操作，失败信息不能仅用颜色表达。

## Provider 身份与名称

`providerId` 是创建后不可修改的执行身份；`label` 是可以编辑的展示名称。两者不再通过 rename 相互转换。
Personal-only Provider 创建时取得当前未占用的缺省 ID：

```text
new-provider
new-provider-2
new-provider-3
```

设置页修改名称只写 Personal `label` Overlay。空白 label 表示恢复继承；所有 Effective Provider label
忽略大小写后必须唯一，避免设置页和模型选择器出现无法区分的同名入口。`providerId` 继续保持非空、去除
首尾空格且全局唯一。内部状态和跨进程协议使用结构化 `ModelSelection`；Prompt CLI 的
`provider/model` 只是在 Entry 边界的人类输入简写。

ZCode Built-in 与 Account Built-in Provider 的 ID 由 ZCode Built-in Provider Config 管理，设置页不可重命名。
它们仍可由 Built-in Config 提供只读 `label` 和品牌信息；`providerId` 始终是执行身份与无 label 时的
展示回退。

`visibility` 是 Provider Config 的产品可见性事实，不是设置页控件。Provider Settings Facade 只返回
`visibility = "visible"` 的 Provider；hidden Provider 不出现在设置页，页面也不提供切换这一字段的操作。
隐藏只影响产品入口，不影响 Registry 成员、完整性校验或内部执行。

Model Config 不再具有独立 `visibility`。模型是否出现在普通选择器由 Provider visibility、Model enabled 与完整性
共同决定；Settings 仍展示 disabled 模型，供用户编辑或重新启用。

## Provider 分组、新增与删除

设置页只展示真实 Provider；Template 只出现在右侧 Template 选择页：

```text
zai-family / bigmodel-family
└─ 固定 Account Family 区域
   ├─ Start Plan
   ├─ Individual Coding Plan
   └─ Team Coding Plan

Provider Templates
└─ 顶部“添加供应商”打开的创建基线
   ├─ Z.AI API / BigModel API
   ├─ DeepSeek / Moonshot / MiniMax
   └─ 其他官方模板

standard-personal
└─ 已创建的普通 Personal Provider
```

Provider 不保存额外的 `builtin` 标志或顶层 `enabled`，也不靠 Provider ID 白名单推断分组。Template 不是
Provider，没有运行时 `providerId`、可执行状态或 Settings 详情页。

顶部操作复用 Subagents 设置页的头部动作层级：刷新在前，使用 `outline + icon-md`；“添加供应商”在后，使用带 Plus 图标的 `default + default` 主操作按钮；两者右对齐并保持 `gap-2`。点击添加后左侧 Provider 导航保持不变，右侧详情切换为
`ProviderTemplatePicker`。选择页直接消费目标 Host 的 `ProviderSettingsView.providerTemplates`，按发布顺序显示
固定高度、最多两行名称的 Template 卡片，不另建 Catalog、搜索、ID 排序表或 Renderer 品牌名单。页面提供返回，
创建成功后进入新 Provider 详情。长名称超过两行时截断并通过 Tooltip 展示全名。

Provider 详情中的“添加模型”是从属于当前 Provider 的次要创建操作，使用带 Plus 图标的 `secondary + default` 按钮；按钮
保留在“模型列表”标题行右侧，标题行父容器使用 `mb-1`，与列表主体保持 `4px` 间距，不能悬贴或覆盖列表边框。

选择页有两个立即生效的创建入口：

```text
添加供应商
└─ 选择 Provider Template
   └─ 每次创建一个新的 Personal Provider 实例
      ├─ 记录 templateId
      ├─ UI 按当前 Locale 从 Template nameMap 解析 label 种子
      ├─ Host 在创建原子更新内生成唯一 providerId / label
      └─ 原子写入 Personal Config 与 providerOrder

创建自定义供应商
└─ 立即创建不引用 Template 的 Personal Provider
   ├─ 写 group=standard-personal、access.type=api-key
   │  └─ API Key 允许暂时缺省；Access 判别字段不能缺失
   ├─ 不猜 API type、Endpoint 或模型
   └─ 进入完整自定义详情
```

`standard-personal` 当前只支持 `api-key` Access。Renderer 只根据 Effective `access.type` 选择对应设置表单，
不得根据 Provider group 另建一套 UI 推断。Template 创建和空白创建统一调用
`createPersonalProvider({ templateId?, label?, initialConfig? })`；`initialConfig` 不允许携带 `label`，避免绕过去重。
Template 名称只作为创建种子；创建后的 Personal `label` 稳定、可编辑，不随界面语言或 Template 更新自动变化。
Welcome 的 API Key 入口也调用同一原子创建操作，不能维护
固定 `zai-api` / `bigmodel-api` 运行时 Provider 或专用保存接口。

不完整的新 Provider 可以出现在 Settings View 并展示完整性问题，但不会进入 Registry。
Personal-only Provider 的结构化草稿允许保存：空 Base URL、空 API Key 或空模型成员不应阻断持久化；空值不写成
非法的伪 URL，而是保持对应字段缺省。Host 仍按正式完整性规则把该 Provider 标为不可执行。非空但格式错误的
URL 继续作为字段错误拒绝，避免把输入错误误当成“尚未配置”。

Provider 设置页不提供通用启停控件。Account 套餐资格展示读取 `access.entitled`；普通 Personal Provider 是否
存在由其 Personal 根定义表达。两者都不能再用 Provider 顶层 `enabled` 推断。

Provider Template 的发布顺序决定“添加供应商”菜单的默认顺序。智谱、Moonshot、MiniMax、DeepSeek、
Alibaba Model Studio、Xiaomi 等国内模型服务排在 OpenAI、Anthropic、xAI 等海外服务之前；Renderer 不再另存一份
菜单专用排序表。

Provider 导航、详情标题、Template 选择页和 Account 详情统一读取 Provider Config 的结构化 `logo` 引用，由
UI 资源解析器将 `logo.key + 当前实际主题` 映射到打包素材。缺失、未知 key 或资源加载失败均回退通用 Package
图标；Renderer 不按 Provider ID 推断品牌。纯自定义 Provider 暂不支持上传 Logo。

删除普通 Provider 时删除该 Personal Provider 根定义及其 Personal `provider-model` Rules；Template 不受影响，
以后仍可再次创建新的实例。Account Family Provider 不提供删除入口，账号状态由 Account Overlay 更新。通用
Personal `match` Rules 不随 Provider 删除。

## 模型列表与编辑

模型列表承担浏览、启停、测试、编辑、Personal 模型删除和全成员排序。列表必须直接
展示 `enabled` 状态和操作按钮；模型 ID、Properties 与 Option Specs 等内容在独立
模型编辑页中修改，列表行不提供内联名称编辑。

```text
模型列表行
├─ Model ID
├─ context window 摘要（紧跟 Model ID 左对齐）
├─ 状态：正常 / 已关闭 / 配置不完整
├─ Properties 摘要
├─ 测试
├─ 删除（仅 Personal）
├─ 编辑图标 -> Model 编辑弹窗
├─ enabled 开关（固定在最右侧，不提供“恢复默认”）
└─ Model ID 与非交互空白均可启动整行拖动（Built-in 与 Personal）
```

Model ID 是 `providerId/modelId` 身份的一部分。Built-in Model ID 只读；编辑页修改 Personal Model ID
时执行一次明确的原子重命名操作，而不是把它当作普通展示文本。

`enabled` 开关显示 Effective Model Config，切换后写入 Personal `type="provider-model"` 专属 Rule，并保持明确
布尔值；模型列表不提供删除该叶子的“恢复默认”入口。disabled 模型继续显示在 Provider 页面，但从普通模型选择器隐藏。开关不等于
`selectable`：Provider 配置不完整、Account 未获得权益或 Provider hidden 都可能让一个 enabled 模型仍不可选择。

普通 Personal Provider 导航行不显示独立拖动块；Provider 名称、图标或非交互空白都是同一个整行拖动区域。
点击仍选择 Provider，拖动超过激活距离后才进入排序，避免把普通点击误判为拖拽。行内真实按钮继续排除在拖动
激活区域之外；可拖文字禁止浏览器文本选择，不能出现“选中文字但没有排序”的假拖动态。

`executable` 和 `selectable` 是 Host 派生结果，不是保存字段：前者由 Account entitlement（账号类型）、Provider
完整性、Model enabled 和成员身份决定；后者再要求 Provider visibility 为 visible。hidden 不等于 disabled。

`builtinModelIds` 与 `modelIds` 重名时采用 Built-in-wins：只产生一条可正常运行的 Built-in 模型。正常 UI
禁止创建重复成员；手工配置中的重复在下一次相关保存时规范化。系统不建立冲突 DTO、暂停身份或第二个同名
模型。Host 仍显式返回 `builtin`，仅用于 Model ID 只读和删除权限，Renderer 不从 ID 或目录猜来源。

Model 编辑使用本地 Draft 和手动保存。弹窗允许编辑产品开放的 Model Config 字段：enabled、context、输入输出格式、
能力布尔值、MFJS、Reasoning 档位、Reasoning Mapping 与最大输出 Token。Reasoning Mapping 使用固定高度
技术文本框：Personal Map 是 value，Inherited Map 是 placeholder，清空表示恢复继承。最大输出 Token 使用
独立数字输入，直接展示且不放进“高级”折叠；Max Output Map 暂不开放第二编辑入口，保存其他字段时必须
原样保留。
启用开关与 Model ID 共用首行，不单独占据一个状态卡片。主要字段顺序固定为
`Model ID/启用 -> context -> 最大输出 Token -> 输入类型 -> 输出类型 -> 模型能力`，复杂 JSON 与 MFJS
位于这些常用字段之后。
context、最大输出 Token 和两个复杂 JSON 槽位都只把 Personal 覆盖作为输入值；当前继承/生效值显示为同一输入框的
placeholder，不再另设只读预览，也不能把继承值预填成用户输入。空白表示继承，明确填写的 Map 表达式表示
Personal 叶子覆盖。JSON/Map 编辑区只保留文本框自身的边框、固定高度和内部滚动，不再套第二层有边界容器；MFJS 开关前使用
“其他设置”分组标题，避免复杂 JSON 与后续布尔设置在视觉上粘连。最大输出数字 `N` 直接表达
`optionSpecs.maxOutputTokens.max=N`，不再保存 Option Default。弹窗底部始终提供“全部恢复默认”，无 Personal Overlay 时禁用；一次清除该模型除身份/成员之外的
全部 Personal Model Config 覆盖；保存仍只
写相对 Effective Built-in 真正变化的稀疏 Personal Rule。取消、X 和 Esc 不产生 Mutation。PDF/Audio 字段不在 UI
展示，但任何其他编辑都必须保留已有值。弹窗打开期间，弹窗内容与遮罩都必须排除在模型整行拖动激活区之外；
Portal 的 React 事件冒泡不能穿透弹窗启动背景模型排序。
桌面弹窗保持居中的中等最大高度，长表单只在内容区滚动，不贴近窗口上下边缘形成近乎全屏的“顶天立地”布局；
窄屏仍按可用视口高度安全收缩。

输入/输出格式、能力布尔值与 MFJS 使用同一个 Boolean Model Option。checked 只表达 Effective 值；稀疏
Personal 叶子的存在通过更高饱和度的外框与 Checkbox 边框表达，不显示“默认/已修改”文字，也不以值是否等于
Built-in 推断来源。锁定 Text 只表达不可编辑。

新增 Personal Model 时，Host 的 Model Config Resolution 是该 `providerId/modelId/api.type` 的继承基线。Renderer
将数字和 JSON 作为 placeholder，将格式和能力布尔值缓存为表单展示状态；展示缓存不属于 Personal Config，
迟到的 Resolution 也不得覆盖用户已经触碰的字段。保存时仍按继承基线生成稀疏 Personal Overlay，禁止把
ZCode Built-in Model Config Rules 的默认事实反向物化。

Provider/Model 保存与模型连接反馈使用应用既有窗口级 Toast，固定在 viewport 底部；不同对象向上堆叠，同一对象
的 saving、success、failure 按 key 替换。保存或连接失败比成功停留更久，并提供必要的重试或关闭入口。模型级消息
必须包含 Model ID，必要时同时包含 Provider 身份。Toast 的静态位置只能由 `top`/`bottom` inset 决定；Y 轴
transform 只用于消息自身的入场动画，底部容器不得被平移出 viewport。

完整 UI、状态归属和接受用例见
[`model-membership-and-enablement.md`](./model-membership-and-enablement.md)。

Provider 设置的左右分栏容器使用稳定高度，不由 Provider 数量、Model 数量或右侧表单长度撑高。外层卡片裁切溢出，
左侧 Provider 导航与右侧 Provider 详情各自拥有独立的纵向滚动区；滚动长模型列表时不能带动 Provider 导航，反之
亦然。两侧滚动区都必须具有 `min-height: 0`，保证 Grid/Flex 子项真正收缩并产生内部滚动，而不是继续撑高页面。
模型设置页使用比普通 Settings 表单更宽的内容列，为固定 Provider 导航和完整详情表单保留足够横向空间；左右滚动区
都不得产生横向滚动条。窄屏仍可收起导航文字并让详情字段换行或截断，不能依赖横向拖动才能访问字段。

Template 创建的 Personal Provider 与完全自定义 Personal Provider 使用同一套详情信息层级。继承自 Template 的
Base URL 与 API Schema 必须可见，但使用只读控件或等价的冻结展示；用户仍可编辑 API Key、模型配置和允许覆盖的
Personal 字段。Provider ID 与 Built-in Model ID 保持只读。不能因为 Endpoint 只读而隐藏整个连接事实区，也不能
另建一份 Template 专用详情 DTO。

Personal Model Config Rule 不决定字段是否可编辑，它只是用户明确修改后形成的稀疏持久化结果。设置页是否允许编辑由
字段所有权和产品交互决定；一旦允许编辑，Built-in/Personal Model 都通过同一 Personal Rule 保存覆盖。模型成员是否
允许改名或删除则由成员来源独立决定，Builtin Model ID 只读且不能删除。

账号 Individual / Team Coding Plan 是上述通用展示规则的产品例外：设置页完全隐藏 Endpoint 与 API Schema，只展示
套餐状态和 Effective 模型配置。隐藏不代表 Config 缺少字段；Endpoint/API Schema 仍保留在 Effective Provider
Config，并由 Registry、ModelFactory 与 Runtime 正常消费。Renderer 不为此裁剪或重建 Account Provider Config，
也不能让套餐、额度、凭据或请求错误决定模型配置区域是否存在。

## Provider 与模型调序

Provider 和 Model 都使用显式 Personal 顺序字段，不依赖 Map 插入顺序。Family Provider 固定在最前且不参与
普通排序；两个固定创建操作紧随 Family；所有 `standard-personal` Provider 位于操作之后并可统一拖动。Provider
顺序由 `providerOrder` 的有效成员加未排序 Personal 尾段确定。

```text
Personal:       [A, B, C, X, Y]
providerOrder:  [C, X, A, Y, B]

用户把 X 拖到 Y 前面

保存完整 providerOrder，去重复、删 stale、补遗漏
```

所有 Effective Built-in/Personal Model 成员都可以拖动；Builtin 只是不允许删除。拖动保存完整
`modelOrder`，但不修改 `builtinModelIds` / `modelIds` 的成员所有权，也不修改 ModelConfigRules 优先级。
模型整行是拖动激活区域，行内 Switch、测试、编辑和删除必须排除；可拖文字禁止浏览器文本选择。指针使用移动
阈值，触屏保留纵向滚动，键盘提供等价排序能力。

拖动采用乐观展示：操作结束后立即保存；保存失败时恢复原顺序，并在对应列表显示错误。

## 连通性测试

连通性测试是 Host 对 Renderer 提供的 Provider Settings 能力。自动保存使测试不需要维护“临时 Registry”或一份不可发布的执行快照：

```text
点击模型“测试”
        |
        v
提交当前尚未保存的 Provider 与目标 Model Draft
        |
        v
等待 Personal Config 写入与 Registry 刷新
        |
        v
Registry 根据 providerId/modelId 创建正式 Model
        |
        v
Model.streamText() 发出最小真实请求
        |
        v
正式 Adapter / Request Auth / Provider API
```

测试按钮可以使用模型项的 `executable` 提供正常 UI 状态，但 Host 不复制 Registry 准入算法。disabled、配置
不完整或单集合重复的模型不能测试；跨集合重名时测试正常可执行的 Built-in X。

Renderer 不准备安全校验 Header，不拼 Endpoint、Reasoning 参数或协议请求体。Registry 使用保存后的正式 ProviderConfig、ModelConfig 和 Model Options 创建 Model；请求 attempt 通过正式 Request Auth Service 取得 API Key、JWT、Runtime Key、一次性安全校验 Header 等动态鉴权材料。

账号 Provider 的设置、权益和 Usage 入口同样只能从 Settings View 读取 Registry 的静态
`access: { type: "zhipu-account", family, mode }`。Renderer 不用动态 Account Access Schema 解析该字段，
也不把当前套餐或 Team scope 伪装成 Effective Provider Config：

```text
Provider Settings View.access { family, mode }
                    |
                    v
Host Account Request Auth Service
                    |
                    v
当前连接 { planKind, productId?, organizationId?, projectId? }
                    |
                    v
Entitlement / Usage / Reset / Model Request
```

动态账号事实由目标 Environment 的账号服务在调用时解析。Team usage 列表可以把已订阅产品响应与静态
`team-coding-plan` mode 组合成查询 scope，但不得把该 scope 写回 Personal Config、Account Overlay 或 Registry。

测试使用与 Agent 相同的流式 Adapter 路径，固定发送两条消息：system `You are ZCode connectivity probe.`，user `hi`，并消费完整流。文本、角色、顺序是白名单相关契约，不添加历史、工具、额外 system 或国际化文本（Todo 91）；不影响其他辅助请求。连接测试独立使用 512 Token 输出预算，并受模型输出上限约束：实际预算为 `min(512, maxOutputTokens.max)`，避免在本地绑定阶段拒绝合法的小容量模型。Reasoning 显式使用有序档位的首项，不复用辅助内容生成的 5,000 Token 预算（Todo159，取代 Todo144 的 1 Token 策略）。正常 finish（含 length）即成功，不要求正文；流异常或缺少 finish 仍失败。测试路径不依赖已经退役的 Option Default，也不假设 Model 已绑定隐式默认 Options。超时、鉴权、预算参数拒绝、模型不存在、限流、服务端错误和响应解析错误由正式 Model/Adapter 错误边界归一化，再投影为设置页结果，不自动增加预算或更换模型。

测试成功表示保存后的正式 Model 能够完成一次真实请求，而不只是某个独立 HTTP Probe 收到了成功状态码。Start Plan、Coding Plan 和普通 API Provider 使用同一入口；它们的差异结束在 Provider、Request Auth 和 Adapter 内部。

一次测试只返回一个成功/失败联合结果，不保留单元素 `results[]`、Endpoint 聚合或 Host 端 API 类型推断。
最终准入由目标 Environment 当前 Registry 的 ModelFactory 完成；测试不修改任何模型选择或 Active Model。

## 实施边界

Renderer、Host、本地与远端 Environment 使用相同 Settings Service 契约。设置页不建立临时 Registry、
Connectivity Probe Adapter 或第二套 Overlay/完整性算法。

## Provider 表单保存与反馈

Provider 详情主表单采用同一套自动保存语义：文本输入变更后，用户停止输入一段短时间即提交最新
完整 Provider Draft；失焦、Enter、切换 Provider 或卸载时立即 flush。同一 Provider 的连续输入共享一个
debounce，不按字段制造多份保存。选择器、Switch 等离散操作继续即时保存。

```text
连续输入 --重置定时器--> 停顿阈值 --保存最新完整 Draft
     |
     +-- blur / Enter / 切换 --> 取消定时器 --> 立即保存
```

Model Metadata Dialog 仍是显式交易：只有点击“保存”才提交，“取消”必须可以放弃整份草稿，因此不参与
Provider 主表单的闲时自动保存。

添加和编辑提交后，在保存返回前不接受重复提交、Esc 或遮罩关闭，避免旧请求结束掉重开的新草稿。
保存成功关闭弹窗；失败保留输入，恢复编辑/取消能力，并在原草稿中重试，不从外部通知另起一次保存。

保存与模型连通性反馈归属当前 Provider 详情栏，不是全局 viewport Toast。反馈容器固定在右侧详情栏底部，
不随 Provider 或 Model 长列表滚动；不同对象向上堆叠，同一对象的 saving / success / failure 原位替换。
success 使用成功色横幅与对勾，failure 停留更久并可重试或关闭。
