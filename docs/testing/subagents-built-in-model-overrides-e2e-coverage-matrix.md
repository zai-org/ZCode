# Subagent 模型与 Reasoning Effort E2E 覆盖矩阵

> `retired:` 逐处标记已退役 App 单测，仅供追溯；原通过记录不代表现行覆盖。独立断言缺口需由后续验收补齐。

> 2026-10-26：App 业务单测已按[测试规格](unit-test-quality.md)退役。本文中的相关单测路径和历史通过记录不再代表现行覆盖；CLI/CUA、工程测试、E2E 与浏览器验收证据仍按各自状态解释。未补验收的场景不得自动视为已覆盖。

本文记录内置 `general-purpose` / `Explore` 模型覆盖的自动化验收范围。该功能的产品语义见 [内置 Subagent 模型覆盖](../subagents-built-in-model-overrides.md)。

## 缩写

| 缩写 | Spec                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SB` | `packages/desktop/test/e2e/conversation-session/subagents/conversation-session-built-in-subagent-model-overrides.test.ts`                        |
| `SX` | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-subagent-runtime-catalog-reasoning.test.ts` |
| `SL` | `packages/desktop/test/e2e/coding-plan/account/subagent-coding-plan-login-catalog-stale.test.ts`                                                           |
| `SM` | `packages/desktop/test/e2e/start-plan-manual-claim-experience.test.ts`                                                                 |
| `SE` | `packages/desktop/test/e2e/settings/agent/settings-subagent-create-edit-persistence.test.ts`                                                 |
| `SS` | `retired:packages/services/test/subagentsService.test.ts`                                                                              |
| `SU` | `retired:packages/ui/test/subagentsSection.test.ts`                                                                                    |
| `TC` | `retired:packages/ui/test/thoughtLevelCycleControlSelectionValue.test.ts`                                                              |
| `SC` | `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`、`apps/zcode-cli/packages/core/tests/subagent-profile.test.ts`           |
| `BT` | `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts`、`apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts`          |
| `RM` | `apps/zcode-cli/packages/bootstrap/tests/runtime-model-metadata.test.ts`                                                               |

## 覆盖清单

### Todo103 G04-A 接续验收

- BSM-18/SE-03：保留不可用选择但编辑触发器显示“选择模型”；不恢复旧候选、不写原文件。Pro `desktop-e2e-20260909-143258-266` SE-03通过。
- 候选新鲜度：公共 `useModelSelectionServiceView` 首读/通知/重挂载；不恢复旧 Family/store 强刷。
- 同 endpoint 的 Start/Individual/API Key 成员隔离：`retired:packages/provider/test/resolver.test.ts`；（retired: 为退役历史证据，不计现行覆盖。）
  该测试替代已删除的旧 modelProviderServiceStorage 归并测试，不恢复其旧数据源。

### Todo103 G04-B 插件覆盖接续验收

- SE-04（来源 staging `dbb3ec0ce8` 已有正式用例，迁接而非新晋级）：官方 cache 中 judge 可见；
  行内主动选模写完整 `pluginAgentModelSelectionOverrides` 并取最高档，再改 high 验证不是只重复默认值；
  插件行仍不可进入编辑表单，插件 Markdown 字节不变。Pro `desktop-e2e-20260909-150213-807`
  SE-02/04 2/2通过；同时覆盖全新缓存的首次进入，不要求用户手动刷新。
- SU 已退役：内置/插件共用控件及稳定 agentId 保存的独立单测证据不再计入覆盖。
- SS 已退役，保留 BT 的 CLI 证据；以下原联合范围中的 App 独立断言待补：无安装记录的官方默认发现、安装/禁用/抑制优先、稳定 ID、规范名/别名同覆盖、
  model-only 不继承原 effort、清除回到插件默认、冷加载导入均由实际临时文件测试验收。
- 不扩大运行中热更新或 remote/replayable 语义；既有 profile 的 Todo99 有效选择入口保持不变。
- PLM-LC-020：在 SE-04 的 UI 保存证据之外补官方 judge 冷启动请求闭环；父 primary/max、child alternate/high，避免错误继承或默认档位回退蒙混通过。新 pending case 的本地 fixture 与请求证据独立留存，不声称手机或热更新覆盖。

### Todo97 新裁决验收（2026-09-08）

- SA97-04：SE 用户/项目创建、编辑只写 `model` / `thoughtLevel`，内部 JSON 覆盖继续结构化；Pro `desktop-e2e-20260908172422561-p96860-3f1d8f499a4468d5` 的 SE 三项与正式 SB/I20 共4项通过。SB 已在正式目录，下面历史表的 pending 状态不再适用 SB；不据此晋级其他候选 spec。
- SA97-01/03/07/09：共享文件测试与 Host/Agent 初始化集成覆盖用户目录原地迁移、原字节保留、并发和写失败；项目/插件不改写，不再全 profile 内存转 ID。
- SA97-05/06/08：删除 Markdown `modelSelection` 中间态分支，内置 JSON 旧双 map 先落盘迁移再正式读取；新 JSON 字段空值不回读旧值。
- 下面历史 I20 中“自定义 Markdown 保留相冲突的旧 thoughtLevel”被 Todo97 替代：`thoughtLevel` 已是正式字段，不再制造未发布中间态兼容样本。新的验收只用真正发布过的旧 Provider 身份。

| ID     | 状态         | 自动化         | 断言                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BSM-01 | unit-retired | —              | SS,SU 已退役；原先依赖其独立断言的部分待补验收。Settings/service 能保存 `general-purpose` / `Explore` 的 built-in model override，并清空恢复默认值                                                                                                                                                                                                                                                                   |
| BSM-02 | unit-retired | —              | SU 已退役；原先依赖其独立断言的部分待补验收。内置 subagent 只显示模型控件，不开放 edit、delete、enabled switch、prompt/tools 编辑                                                                                                                                                                                                                                                                                    |
| BSM-03 | covered      | BT、SC         | bootstrap 读取现有 subagent state，并把 built-in overrides 注入 runtime config 与 built-in profile                                                                                                                                                                                                                                                                                                                   |
| BSM-04 | partial      | SC、SB         | core 已证明 `general-purpose` child 使用覆盖模型；桌面 SB 仍在 manual-review/pending，未计入默认 E2E 门禁                                                                                                                                                                                                                                                                                                            |
| BSM-05 | partial      | SC、SB         | core 已证明 `Explore` child 使用覆盖模型；桌面 SB 仍在 manual-review/pending，未计入默认 E2E 门禁                                                                                                                                                                                                                                                                                                                    |
| BSM-06 | covered      | SC             | `Explore` allowed tools 使用最终 effective child model 计算；native WebSearch 能力分支由 core fake connection 覆盖                                                                                                                                                                                                                                                                                                   |
| BSM-07 | partial      | SB             | 候选 spec 覆盖冷启动回显、父 continuation 主模型和 Explore tools 分支；需从 manual-review/pending 晋级后才算默认 E2E 覆盖                                                                                                                                                                                                                                                                                            |
| BSM-08 | partial      | SC、SB         | provider-visible `Agent` schema 不声明 `model`；历史版本额外传入 `model` 时 runtime 丢弃该字段，child 仍使用当前 profile 模型；桌面 SB 仍在 manual-review/pending                                                                                                                                                                                                                                                    |
| BSM-09 | partial      | SB             | SS,SU 已退役；原先依赖其独立断言的部分待补验收。Custom Markdown 与 builtin state 能保存、回显并删除 `thoughtLevel`；builtin model / effort 通过一次 service 写入完整组合                                                                                                                                                                                                                                             |
| BSM-10 | partial      | SB、SX         | SU 已退役；原先依赖其独立断言的部分待补验收。不同模型展示各自 reasoning 档位；模型切换清空 explicit effort，catalog 刷新不清空；SU 使用具体无 reasoning 配置模型覆盖 builtin/custom 隐藏选择器，SX 覆盖 App metadata 缺失但 runtime catalog 可解析的 Claude                                                                                                                                                          |
| BSM-11 | partial      | SC、RM、SB     | SU 已退役；原先依赖其独立断言的部分待补验收。非法历史 effort 显示错误并阻止保存；runtime 严格拒绝非法档位，不自动映射                                                                                                                                                                                                                                                                                                |
| BSM-12 | covered      | SC、BT、RM、SB | 具体 profile 模型使用目标模型默认或显式 reasoning provider options；inherit 继续继承父 options                                                                                                                                                                                                                                                                                                                       |
| BSM-13 | partial      | SB             | 候选 spec 已在真实窗口编辑 builtin/custom effort、核对 JSON/Markdown，并通过 provider-visible child request 验证实际生效；仍需从 manual-review/pending 晋级并进入默认 E2E 门禁                                                                                                                                                                                                                                       |
| BSM-14 | partial      | SX             | SU 已退役；原先依赖其独立断言的部分待补验收。runtime catalog 对目标模型明确给出非空/空档位时分别保持支持/不支持；目标模型或能力字段缺失时立即回退 App metadata，不等待 workspace status，metadata 首次未就绪才 loading，非法历史值显示原值。SX 覆盖 App metadata 缺失但 runtime 可解析的 Claude，仍需从 manual-review/pending 晋级                                                                                   |
| BSM-15 | partial      | SE             | SU,SS,TC 已退役；原先依赖其独立断言的部分待补验收。Builtin/custom 尚无 explicit effort 时，Select 仍以 effective 默认档位保持真实选中态；鼠标或键盘再次确认该档位会物化并持久化                                                                                                                                                                                                                                      |
| BSM-16 | covered      | SE             | Settings 覆盖两个 builtin 编辑入口，以及 custom user/workspace 创建与编辑；每次保存均校验最终 scope 路径、完整 frontmatter/正文，重命名后旧文件不存在                                                                                                                                                                                                                                                                |
| BSM-17 | covered      | SE             | 只选择 reasoning 模型但不操作 effort 控件时，控件展示 catalog 默认档位，但 builtin state 不新增 thought-level key、custom Markdown 不新增 `thoughtLevel`                                                                                                                                                                                                                                                             |
| BSM-18 | covered      | SE             | Custom 保存模型 A 与 effort 后从模型供应商设置删除 A；重新打开编辑页模型触发器显示“选择模型”，下拉菜单不含 A；effort 隐藏、保存禁用，且原 Markdown 保持不变                                                                                                                                                                                                                                                          |
| BSM-19 | partial      | SL             | SU 已退役；原先依赖其独立断言的部分待补验收。BigModel 登录成功后立即进入 Subagent 设置：Coding Plan effort 先由 App metadata 解除 UI 门禁；App/runtime 模型成员分叉同时触发目标 workspace 按需对账，保持 `includeWorkspaceState=false`，再由 `workspace/readState` 最终回填包含 `high` / `max` 的 runtime 目录。SU 与正式 SL 自动通过                                                                                |
| BSM-20 | partial      | SL、SM         | SU 已退役；原先依赖其独立断言的部分待补验收。Start、Individual、Team 同属 OAuth mode 时，Subagents 按最新 `modelProviderFamilySelectedKeys` 选择连接。SM 真实领取 Start 后，Builtin 绑定 Start 模型再切回 Individual 时，模型触发器显示“选择模型”且菜单只展示新连接候选；SL 覆盖 Individual 切 Team 且已有模型与 reasoning 继续可用；SU 覆盖 Start → Individual → Team 的分组重建。整个链路不依赖远端 catalog 强刷。 |

## 剪枝

### Todo 88 已接受的旧数据补充

- 主动选择新模型使用该模型最高档位；历史缺失/非法档位不自动补齐。旧 BSM-10/15/17 中“切换清空”“仅显示默认、不保存”的表述由此取代；I20 验证主动切换后的真实持久化最高档，再验证手动 high 的请求结果。

- I20 的设置页保存之后、冷启动之前，将隔离 fixture 的内置覆盖改为已发布旧 `builtInModelOverrides` / `builtInThoughtLevelOverrides`。冷启动必须由 Host 导入，随后不再次修改设置，三个 child 的实际请求仍分别使用指定模型和 high 档位；父请求保持 max。
- 自定义 Markdown 只写正式 `model` / `thoughtLevel: high`，不注入未发布中间态；冷启动前后文件保持一致，实际 child 请求继续 high。

- 不覆盖 Settings 热保存后已启动 agent 立即生效；当前 desktop agent 在窗口启动早期初始化，热保存行为由 service/UI 单测覆盖，runtime 生效由冷启动链路覆盖。
- 不覆盖 multi-session 隔离、remote `/remote`、mobile replayable、queue、stop、edit/fork、compact 或后台并发组合。
- 不新增 workspace 级覆盖；`Explore` 无覆盖默认继承主模型，不再默认使用 lite。
- 不增加 `Agent` tool 调用级 model / effort 参数，不覆盖热更新、multi-session 或 remote/mobile 状态组合。
- 不迁移或改写历史 transcript 中已有的 `Agent.model`；只保证它不再参与新一次 child runtime 的模型选择。
- Claude 模型的 runtime catalog 验证采用完整矩阵，不以现有 DeepSeek `I20` 代表覆盖；catalog 首次 loading 使用受控 UI 测试，不为 E2E 添加生产测试开关。
- Settings CRUD E2E 不发送 prompt，不验证冷启动 child、provider request 或 model-io；这些行为继续由 SB/SX 负责，避免 UI 保存回归扩大到 CLI/runtime。
- SL 是登录后 App provider 快照与 desktop continuous workspace runtime catalog 的双阶段回归门禁：App metadata 保证控件立即可用，后台对账保证 runtime catalog 最终一致；runtime 已有明确能力声明时仍优先。remote workspace、手机 `/remote` replayable、task queue 与 provider request 均剪枝。
