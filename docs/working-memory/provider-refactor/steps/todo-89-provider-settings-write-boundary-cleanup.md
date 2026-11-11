# Todo 89：Provider 设置写入规则与编辑草稿整理

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：开发及本轮验证完成，2026-09-08。手机远控/SSH 实测及新增 pending 用例人工晋级不计为已通过，见末尾记录。
>
> 日期：2026-09-08。审查基线：`483e51c8459646f07236cbb7181c8d0d151c5430`，`provider-refactor-e2e-recovery`。
>
> 用户要求：不仅修复 Account Provider 添加模型失败，还要全面整理这一块混乱的代码与保存规则。

## 1. 目标与范围

让添加、编辑、启停、重命名、删除和排序遵守一致的成员归属与写入规则。操作结果不能取决于用户是否先拖过一次模型。

本项承接 Todo 88 R08/R10 的遗漏，不重做迁移、账号权益、Selection 解析或请求执行架构。保持现有 `provider_config.json` 结构，不增加数据迁移，不要求用户删除配置文件。

涉及层次：设置页展示、草稿、校验、提交和 Personal 持久化。不是只改一个报错分支，也不是重写整个 Provider 模块。

依据：

- [Provider 设置页](../design/registry/settings.md)。
- [模型成员与启停](../design/registry/model-membership-and-enablement.md)。
- [Todo 88](todo-88-provider-audit-regression-repair.md)。

## 2. 已确认问题与证据

| 编号 | 问题                                                                                     | 当前证据                                                                                      | 优先级           |
| ---- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| W01  | 没有 Personal Provider 记录时，Account Provider 首次添加模型失败；拖拽创建记录后才能添加 | `config-service.ts` 内存复现；编辑、启停可单独写模型配置，却不会解除添加失败                  | 高               |
| W02  | 添加模型重新按成员名单生成顺序，丢掉已有排序                                             | Account 和自定义 Provider 均复现 `[B,A]` 添加 C 后变成 `[A,B,C]`                              | 高               |
| W03  | 后台 View 更新产生新的 model 对象，覆盖打开中的模型编辑草稿                              | DOM 复现：输入 123456，等价对象刷新后回到 200000                                              | 高               |
| W04  | 模型部分属性缺失时，整行编辑、启停、删除入口消失                                         | DOM 复现：缺 contextWindow 后只剩模型名称和错误信息                                           | 高               |
| W05  | 自定义 Provider 表单重建 api 时丢掉静态 headers；未编辑也可能被判定需要保存              | 表单转换及配置服务内存复现；当前内置配置和已检查的 Air 配置未发现使用者，不声称已影响真实账号 | 次要，但本项修复 |

此前相关 5 个单测文件共 110 项通过，但未覆盖这些前置条件。另用临时诊断测试验证 W03/W04 后已移除；正式实施必须补入长期维护的回归测试。没有把这些诊断结果当成 Electron E2E 通过证据。

## 3. 保留的分层及唯一事实来源

```text
Built-in / Template / Account 事实 + Personal 配置
                      |
                      v
             Host 的一致配置快照
                      |
          +-----------+--------------+
          |                          |
          v                          v
     Settings View            成员及来源上下文
     展示、编辑草稿             校验本次写入
          |                          |
          +---- 用户提交操作 ---------+
                                     v
                          Provider Config Service
                          Personal 原子更新
                                     |
                                     v
                         刷新快照 -> 返回保存结果
```

- Provider 存在，不等于 Personal 文件中必须已有它的记录。没有用户覆盖时，不存在 Personal 记录是合法且正常的状态。
- `providers[providerId]` 保存 Provider 级个人配置，包括个人新增成员 `modelIds` 和排序 `modelOrder`。
- `modelConfigRules` 保存某个模型的个人配置。编辑模型不应顺便创建一条没有用途的 Provider 记录。
- 成员存在与来源取自配置解析快照，不能只查可执行 Registry，也不能在写入时退回静态名单。Account 动态成员为空同样是明确事实，不擅自补回静态成员。
- Config Service 只接收 Facade 提供的可信只读成员事实；不查询账号网络，不依赖 Runtime 具体实现。Renderer 不提交可自行伪造的成员归属声明。
- 复用已有 `ProviderModelMembership`、每 Provider 写入队列与仓库原子更新，不增加第二个成员解析器或另一套保存队列。

## 4. 写入规则收口

### 4.1 统一处理可写 Provider，而不是到处补空对象

在 Config Service 内收口 Provider 存在性、Personal 记录取得、允许创建稀疏覆盖的判断，供需要写 Provider 字段的操作复用。

当内置/账号 Provider 合法存在，但缺少 Personal 记录时，添加或排序可以按需创建稀疏覆盖；不得复制整份 Effective Config，更不能把 Account 动态成员、凭据和连接信息变成个人配置。

自定义/模板实例的 Personal Provider 如果已经被删除，迟到操作必须失败，不能用这一规则把它复活。成员快照及 Personal revision 的检查保留在实际提交边界，不能只在点击按钮时检查一次。

### 4.2 各操作只修改自己的内容

| 操作               | 原子修改内容                                                     | 不得发生                                    |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| 添加个人模型       | 个人 modelIds、当前顺序追加新成员、该模型初始配置及 enabled=true | 要求先排序；重置旧顺序；复制账号成员        |
| 编辑已有模型       | 该模型的个人配置与跟随模式                                       | 重写成员名单或其他模型配置                  |
| 模型启停           | 该模型 enabled 叶子                                              | 回传整份旧配置覆盖其他编辑；改变跟随模式    |
| 拖拽排序           | modelOrder                                                       | 把继承成员写成个人成员；改变启停            |
| 重命名个人模型     | 个人成员 ID、排序引用、同一模型配置的身份                        | 改名继承成员；丢失模式或其他配置            |
| 删除个人模型       | 个人成员、排序引用和对应配置                                     | 删除继承成员；删除其他模型配置              |
| 编辑 Provider 字段 | 本次明确修改的字段                                               | 清除表单未管理的 headers 等内容；物化继承值 |

优先复用现有领域操作，只提取真实共用规则；不新增通用 CRUD 框架或任意 JSON Patch 接口。启停建议使用窄语义操作，在事务内基于最新配置更新 enabled，避免借用完整模型弹窗保存。实施时同步检查所有调用方，不能新旧两种方式并存而行为不同。

排序复用 `owned-order.ts` 的语义：未排序的新继承成员在前，保留用户已有有效顺序，未排序的个人成员在后。添加前后原成员的相对顺序不变，新个人成员追加。去重、继承成员保护与重命名规则不各写一套。

Provider 表单以 Personal Draft 为提交基础，保留未触碰字段；api 子对象不能仅凭 UI 中的 type/baseURL 重建而丢失 headers。不得用整份 Effective Config 做保存兜底。无实际编辑时不产生保存。

## 5. 草稿与错误恢复

```text
打开模型弹窗 -> 捕获该模型草稿 + 基线 revision
                    |
       +------------+------------------+
       |                               |
外部 View 刷新                     用户编辑
更新列表事实                       只改变草稿
不覆盖打开中的草稿                      |
                                  点击保存
                                       |
                     +-----------------+----------------+
                     |                                  |
                  提交成功                         校验/版本冲突
                  结束本次编辑                     保留草稿并解释原因
```

- 弹窗按打开/关闭和模型身份管理编辑生命周期，不以 model 对象引用变化作为重置条件。
- 保存沿用已有 revision 校验。过期草稿不得静默覆盖最新配置，也不在后台自动重置或合并用户输入。需要重新加载时由用户明确操作；本轮不引入复杂的逐字段自动冲突合并。
- Provider 行内自动保存与模型弹窗显式保存保持不同边界；跟随推荐开关仍只改变弹窗草稿，点击保存才持久化。
- 配置不完整不等于不能编辑。设置页保留模型行及合适的修复控件；缺失输入安全显示为空，修复后正常保存。
- 继承模型仍不能改 ID 或删除；个人模型即使不完整也可删除。启用不完整模型不使其绕过 Registry 校验进入可执行集合。
- 失败保留用户输入；原子操作失败不留下半份成员、顺序或模型配置。乐观列表最终与 Host 结果一致。

## 6. 影响面与实施落点

| 入口/关系                | 共享实现和所有者                                                | 本项检查重点                                    |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------------------- |
| Provider 字段表单        | `ProviderDraftSave.ts`、`providerPersonalSave.ts`；卡片持有草稿 | 部分字段保存，不丢未编辑配置                    |
| 模型添加/编辑/启停       | `InlineEditableProviderCard.tsx`、`ProviderFormControls.tsx`    | 窄操作、编辑生命周期、失败保留                  |
| 模型行和拖拽             | `ProviderCardSections.tsx`、现有乐观排序 hook                   | 不完整模型可修复；顺序不因添加重置              |
| 全部设置操作，必须检查   | `packages/provider/src/facades.ts`、`config-service.ts`         | 可信成员事实、串行边界、原子提交                |
| 继承配置与执行，必须守住 | 配置解析、Account 快照、Registry                                | 设置可编辑与执行可用性分开；不复制继承层        |
| 下游模型选择，应检查     | 现有 Selection View 更新链路                                    | 保存后正常刷新，不改其选择恢复或默认档位规则    |
| 多端与远程，条件检查     | 同一设置 Service 的目标 Host、公共 UI                           | 不写错环境；手机布局和操作可用                  |
| 会话流，仅不变量检查     | desktop continuous / web replayable                             | 本项不改 Session 协议、队列、重连或远端发送同步 |

本次无法使用 codegraph，使用精确搜索和调用链阅读，追到 Facade、Config Service、Personal 写入及 View 返回。关系图中的旧 `modelProviderServiceStorage.ts` seed 已更新到当前 `NodePersonalProviderConfigRepository`，并补齐 Facade/Config Service；不据旧图谱恢复旧 Service。

## 7. 回归计划与裁剪

沿用既有产品语义的下列用例纳入本项；实际证据及未验证边界见第 8 节，不把计划的全部组合冒充已执行。

| 用例   | 前置与操作                                                             | 必须观察的结果                                               | 证据层                         |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| W89-01 | Account Provider 无 Personal 记录，直接添加模型；另测先编辑/启停再添加 | 两种顺序均成功；只创建必要覆盖，不复制账号模型               | 配置服务 + Electron            |
| W89-02 | 排成 B,A 后添加 C；覆盖 Account、模板实例、自定义                      | B,A,C；保存、重新打开与重启一致                              | 配置服务 + Electron            |
| W89-03 | Account 返回静态名单外的成员，编辑和排序                               | 正常保存；继承成员仍不可删除/改 ID；重复添加被拒绝           | Facade + UI                    |
| W89-04 | 打开弹窗编辑，推送等价 View 和真正外部变更                             | 草稿不丢；过期保存不覆盖外部变更，错误后草稿仍在             | DOM + Electron 代表            |
| W89-05 | 属性缺失的个人/继承模型                                                | 能打开修复；个人可删除，继承不可删除；未修复不成为可执行模型 | DOM + Registry + Electron 代表 |
| W89-06 | 自定义 Provider 有 headers，分别无编辑、改名、改 Base URL              | 无编辑不保存；其他编辑保留 headers；继承字段不被物化         | 表单 + 配置服务                |
| W89-07 | 并发启停和配置编辑；模型处于固定/跟随模式                              | 仅修改各自字段，enabled 与模式互不污染                       | Facade/配置服务                |
| W89-08 | 成员快照过期、模型/Provider 已删除、重复添加、仓库写入失败             | 清晰失败且不复活、不部分写入；页面无虚假成功                 | 服务故障测试 + DOM             |
| W89-09 | 用目标环境的设置 Service 保存，检查另一环境                            | 只修改目标；共享 UI 在窄屏可操作                             | 服务隔离测试 + 多端冒烟        |

裁剪依据：个人/Team/Start 复用同一 Account 成员算法，不按品牌做全组合；至少保留普通 Account 和 Start 动态成员两个代表。Off-Peak hidden 不增加普通设置入口，只检查隐藏规则不变。深浅主题、中英文与窄屏选代表，不和每种 Provider 做全笛卡尔积。真实账号权益、迁移、发送同步、Session 恢复不是本项新增 E2E 的测试目标。

E2E 先更新对应 catalog/matrix，按 `e2e-case-lifecycle` 维护 pending、独立 fixture 与真实操作断言；不使用真实用户数据或凭据。已有旧测试文档中的 catalog 回填、默认档位等历史表述不能直接当作本项契约。MacBook Pro 跑实际 Electron；不能用 DOM 测试代替桌面通过结论，也不为这些回归大量断言 CSS 实现细节。

## 8. 执行阶段与审阅记录

| 阶段 | 交付 | 状态/证据 |
| --- | --- | --- |
| 1 | spec 与 W01–W05 红/绿回归 | 完成；后续补充 W06–W09 的实际失败证据 |
| 2 | Config Service 写入规则、成员操作、排序和 Facade | 完成；稀疏覆盖按需创建；启停只更新 enabled；事务内校验快照/revision |
| 3 | Provider 字段、模型编辑事务、修复控件 | 完成；固定打开时的草稿；失败保留；列表只读 Host View，保留既有拖拽 pending 顺序 |
| 4 | Electron、多端/环境检查、失败路径 | 完成；最终无诊断代码的 Pro 3 文件、12 项通过、1 SSH 跳过；此前 Start 单独复跑 4 项通过 |
| 5 | 文档、覆盖矩阵、图谱、复审及提交 | 完成；逐文件差异和写入/草稿生命周期复审，本记录与实现同一提交 |

### 8.1 实施中发现并修复的关联问题

| 编号 | 根因及修复 | 证据 |
| --- | --- | --- |
| W06 | Account/预置详情漏装配删除回调，删除只改 UI；统一详情操作装配 | Pro 首次添加后删除读盘断言失败；补回调后验证真实删除 |
| W07 | 本地成员副本被迟到保存/失败回滚覆盖；新增弹窗未等写入就关闭 | DOM 延迟失败期间外部新增、添加失败保留输入；移除重复成员状态 |
| W08 | Start 额度刷新暂时变成 checking，卸载已确认 available 账号的编辑区 | Pro 文件刷新实际复现；以 Account 已确认状态保持编辑区，额度卡继续独立刷新；200 项套餐展示测试通过 |
| W09 | 不同 Provider 的同名模型复用打开中的草稿 | DOM 红/绿；编辑子树按 Provider 身份隔离 |
| W10 | 保存尚未结束时 Esc 关闭并重开，旧保存回包关闭新草稿 | DOM 先失败后通过；添加、编辑均在保存期间阻止关闭，用同步 ref 防止重复提交 |

### 8.2 自动验证与逐项验收

2026-09-08 本地：

- 27 个单测文件、541 项通过：`packages/provider/test`、`packages/provider-node/test`、`providerRuntime`、`providerFacadeServices`、`modelProviderDraftSave`、`modelProviderModelRowEditor`、`providerSettingsFormBoundary`、`modelProviderCodingPlan`。
- `pnpm typecheck`、`pnpm exec tsc --noEmit -p packages/desktop/tsconfig.e2e.json` 均通过。
- `pnpm lint`：0 errors，40 条既有 warnings。
- 图谱：336 个唯一节点、672 条边；4 条既有悬空边与基线相同。本项更新设置保存/持久化 seed，不扩展无关图谱内容。

| 用例 | 验收证据 | 边界 |
| --- | --- | --- |
| W89-01/02 | ConfigService 无根记录添加、先启停再添加、Account/模板/自定义排序；Electron 动态 Account 首次添加、排序后添加 | 文件及重开列表验证；未为每种 Provider 再重启一次进程 |
| W89-03 | Facade 动态成员集成；Electron 编辑、排序、删除个人成员并读盘 | 继承模型不获得改 ID 或删除权限 |
| W89-04 | DOM 等价 View/真正变更、版本冲突、取消重开；Electron 外部文件刷新 | 加测 Start 额度临时刷新与跨 Provider 同名模型 |
| W89-05 | DOM 缺失属性/空值、修复控件；Electron 修复个人模型后编辑、启停、删除 | Registry 可执行完整性校验不变 |
| W89-06 | 表单无编辑、改名、改地址、隐式显示默认值；服务保存回归 | 未使用真实依赖静态 headers 的账号；不额外发模型请求 |
| W89-07/08 | Facade 并发/revision/成员失效；DOM 延迟失败、添加保留草稿；Electron 重复添加拒绝后文件无重复 | 显式弹窗保存失败只在原草稿重试，不由外部通知开启独立保存 |
| W89-09 | 设置 Service 等待目标 ready 后只调目标 Facade；UI polish 的中英文、深浅主题、390×844 视口 | 手机远控和 SSH Host 未实测；SSH 用例无目标配置跳过。未修改 continuous/replayable 链路 |

并发测试明确覆盖：完整草稿先保存再启停时双方修改保留；启停先提交后旧 revision 草稿拒绝覆盖；排队期间成员变更拒绝提交；已删除 Provider 不复活。

新增 `provider-settings-write-recovery.test.ts` 保持 manual-review/pending，跑通不等于人工审核或晋级正式门禁。扩展的 Start 用例沿用已有动态模型管理场景，不增加真实模型请求。

最终 Electron 证据（MacBook Pro，隔离工作区 `/Users/dev/zcode-todo88-pro-e2e`）：

- 全组命令：`ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_SKIP_AGENT_BUILD=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/start-plan-manual-claim-experience.test.ts --spec ./test/e2e/settings/manual-review/pending/provider-settings-write-recovery.test.ts --spec ./test/e2e/settings/general/settings-ui-polish.test.ts`。
- 最终报告：`packages/desktop/.e2e-artifacts/desktop-e2e-20260908-062431-556/summary.md`；12 passed、1 skipped，3 spec 文件通过。跳过项为无 SSH 目标的既有用例。
- Start 刷新修复单独复跑：`/tmp/todo89-start-repeat.log`，4 passed；随后增加 W10 保护后再次运行上述全组通过。
- 每次重建实际 desktop main/host/renderer。Agent 无代码改动，使用已有构建；配置和计费接口用隔离测试 fixture，不使用真实用户数据或凭据。
- Linux 最终日志：`/tmp/todo89-submit-unit.log`、`/tmp/todo89-submit-typecheck.log`、`/tmp/todo89-submit-lint.log`；独立 E2E 类型检查 `/tmp/todo89-ready-e2e-types.log`。这些临时路径仅作本次机器执行记录，长期用例及断言随代码保存。

### 8.3 复审与执行异常

- 无新持久化格式、迁移或旧字段兼容，无需删除用户配置。没有复制 Account 凭据、动态成员或整份 Effective Config 到 Personal。
- Config Service 不查询账号接口、不依赖 Runtime 实现；Facade 仍提供可信成员上下文。没有新保存队列、App–Agent 协议或发送同步屏障。
- W08 曾出现加诊断日志后通过、移除后再失败，因此没有用那次通过宣称修复。补充 Account 可用状态下保持编辑区的规则与测试后，再无诊断代码复跑。
- 一次格式化命令因空文件列表误扫仓库。逐文件验证 `format(HEAD) == 当前内容` 后撤回 3,719 个纯格式变化；17 个原有命名修改文件通过格式化前后比较保留原修改；原有计划追加不动。恢复前内容暂存在 `/tmp/todo89-format-recovery-W789JG`。无关文件不纳入提交；后续只格式化非空显式文件列表。
- 当前没有新增待裁决产品行为。账号权限、选择恢复、迁移与请求语义均不扩展；实际未验证的多端范围按上表保留，不冒充通过。
