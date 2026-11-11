# Subagent 模型与 Reasoning Effort 覆盖

> 当前裁决（2026-09-08，Todo88/96/97）：主动选模型时填该模型最高档；历史缺档位不补默认。候选及能力仅取目标 Environment 的 Selection View，不用 App metadata/catalog 双源回填。下文早期“默认档位”“catalog 对账”相关历史验收以本说明及现行覆盖矩阵为准，不能据其恢复旧抽象。

## 目标

### Todo103 G04-A：staging 可用性行为迁接

- 保留 `5161e0914f` 的用户行为：明确 ready 的候选中已不存在原模型时，custom 编辑触发器显示“选择模型”；
  列表徽标仍可显示原型号，原草稿/Markdown不清空，不把历史模型补回候选，保存禁用、reasoning隐藏。
- loading/error/unavailable 不等于模型失效；不借此改写原意图或宣称新名单已就绪。
- 候选更新沿用 `useModelSelectionServiceView` 的首读和通知；不重新引入 `useModelProviders`、
  Family selected-key、App metadata/catalog 双源或进入页面额外下发 Registry。
- Start 和 Individual 即使共用 endpoint、拥有同名型号，也按 Provider ID 隔离；Start 动态名单不能流入
  Individual/API Key，Individual 的同名模型也不能吞掉 Start 模型。由现有 Account Overlay / Resolver 保证并回归验证。
- 验收：SU 缺失模型触发器及原选择保留、公共 hook 更新与重入、Resolver 同地址成员隔离；
  SE-03 在真实窗口删除成员后核对触发器、下拉、禁用保存及文件字节不变。
- 下文旧“Custom编辑仍显示原模型名”由本节替代；历史 metadata/catalog 对账说明不作为本轮接线依据。

Settings 允许用户为内置 `general-purpose`、`Explore`、custom subagent 以及插件自带 subagent 配置持久模型与 reasoning effort。本地集成 session 在新父上下文开始时读取 Host 配置并固定本轮定义，`Agent` 和 terminal `SendMessage` 使用该定义。独立 CLI 与远程 workspace 保持启动配置来源。详见 [配置刷新合同](./subagent-runtime-refresh.md)。

## 非目标

### Todo103 G04-B：插件覆盖的当前架构接入合同

来源 `dbb3ec0ce8` 的行为保留，分三部分验收：B1覆盖存储/加载，B2官方插件发现，B3共用UI及商店刷新。

```text
插件 Markdown 默认 Selection（只读）
                        |
用户 agents-state.json 插件覆盖 --按稳定 agentId 覆盖整个 Selection
                        |
             规范名称 profile + 裸名别名
                        |
           Todo99 显式有效选择解析
                        |
               固定本次 child Model
```

- 新写入字段 `pluginAgentModelSelectionOverrides`：稳定agentId → 完整ModelSelection。
  agentId仍为 `plugin:<name>@<marketplace>:<agent裸名小写>`，不含版本。
- Service/RPC用 `{agentId, modelSelection?}` 一次保存；共享同一state写队列和原子写入口，
  不拆 model/thoughtLevel 两次保存，不依赖当前连接或候选名单决定持久化内容。
- 清除覆盖删除整条Selection；指定新模型但没指定档位不能继承插件原模型的档位。
  没覆盖时返回插件原Selection；不更改运行中已固定的模型；本地新父上下文重新应用最新覆盖。
- 来源staging的插件双map仅由既有 `migrateSubagentStateFile` 存储导入边界一次转换，
  使用已存在的离线Provider映射；正式reader只读结构化map。新map存在（包括空/损坏）不回读旧map。
  这不是兼容本分支未发布的错误Markdown中间格式，也不增加另一套迁移或账号查询流程。
- Bootstrap复用已等待完成的用户state加载结果注入plugin loader，不新增同步磁盘读取。
  规范名和别名在同一次展开前应用覆盖；不存在/改名插件的残留覆盖不影响其他agent。
- 内置与插件共用行内模型控件，主动选模型仍取最高档；保存失败回滚草稿，保存成功后刷新失败不回滚。
  插件不开放prompt/tools编辑、删除、单个启停，不写项目/插件Markdown。沿用桌面/窄屏同一响应式控件。
- 官方缓存补发现遵守安装记录优先、显式禁用/抑制优先、有效manifest版本选择，不能因补发现复活已卸载插件。
- 商店自动刷新按该来源的节流/并发去重行为另验；不把安装、来源、state与展示缓存混为一份状态。
- B1验收：共享迁移新旧权威、Host完整组合保存/清除/并发、Agent规范名与别名相同覆盖、
  model-only不沿用旧档位、不同插件隔离、插件文件不变；最终B3再用真实Settings与冷启动执行闭环。
- B2接线：默认启用ID移到共享市场契约，三种资源入口复用；包括当前已明确默认启用的
  computer-use（上游四项列表漏此项），并与CLI definition机械比较。目录扫描放Node-only共享入口，
  不新增Subagents/Skills/Commands对Plugins域具体实现的导入；不重构其余资源发现机制。
- B2验收：无安装记录的默认内置可见；非默认/显式禁用/抑制不可见；新旧有效版本择新、
  name不匹配manifest回退、临时/备份目录不参与；安装记录优先且disabled记录不被缓存兜底复活。
- Settings 的 `settingsUserOnly` 仍只列用户/内置可管理项，不读项目文件；但 `pluginAgents`
  必须返回本地插件的只读资源投影，否则共用覆盖控件在用户页永远不可达。
  这不把插件别名加入用户编辑列表，也不扩展自动迁移目录。
- 冷启动插件 seed 可能晚于首次文件列表读取。复用设置页已有的插件 inventory 初始化，
  用户页选可用本地 workspace 作为调用上下文且明确 user scope；初始化完成后刷新资源列表。
  首次用户/内置列表不等待插件初始化，失败不清列表；切页/卸载丢弃迟到回调，不靠延迟或轮询解决。

- 不允许编辑内置 agent 的名称、描述、system prompt、tools、权限、删除状态。
- 不允许禁用内置 agent。
- 不新增 workspace 级内置覆盖。
- 不改变 workspace subagent 的编辑范围；plugin subagent 只开放模型与 reasoning effort 覆盖，不开放名称、描述、prompt、tools、删除与单个启停。
- 不增加 `Agent` tool 调用级的 model 或 reasoning effort 覆盖。
- 运行中的父上下文及 child 保持原配置，保存后在下一父上下文生效。
- 不改变 desktop continuous 与 mobile `/remote` replayable 的消息流边界。

## 默认行为

- `general-purpose` 没有覆盖时继承父会话 main model。
- `Explore` 没有覆盖时与 `general-purpose` 一样继承父会话 main model。
- 清空覆盖后恢复上述默认行为。
- 显式模型未配置 `thoughtLevel` 时，使用目标模型在当前 catalog 中的默认 reasoning 档位。
- 未显式配置模型时不单独应用 `thoughtLevel`，继续继承父 runtime 的 provider options。

## 存储格式

Custom subagent 在 Markdown frontmatter 中保存可选的 `thoughtLevel`：

```yaml
model: custom:custom-openai:gpt-5.4
thoughtLevel: high
```

Builtin subagent 在现有 state 文件中保存完整的结构化 Model Selection：

```json
{
  "disabledAgentIds": [],
  "builtInModelSelectionOverrides": {
    "general-purpose": {
      "providerId": "custom-openai",
      "modelId": "gpt-5.4",
      "options": { "reasoningLevel": "high" }
    },
    "Explore": {
      "providerId": "custom-openai",
      "modelId": "glm-5.2",
      "options": { "reasoningLevel": "max" }
    }
  }
}
```

键不存在表示没有对应覆盖。Builtin 的 model 与 reasoning level 必须通过一次 service 调用组合写入；清除 model 时删除整条 Selection。已发布旧双 map 只在共享 Node 迁移入口导入并落盘，正式 reader 只读新 map；新 map 为空或损坏不得回读旧 map。

state 文件按设备存放：远端设备读取远端存储根下的 `v2/agents-state.json`，与本机互不影响。本机的 Builtin 覆盖可以用数据同步推送到远端（只推送有覆盖的项，不清除远端覆盖），规则见 [数据同步](remote/data-sync.md)「子智能体」。插件 subagent 的覆盖不同步。

### Todo97：用户 Markdown 原地迁移

```text
用户目录旧 model 值 -> 离线替换 Provider -> 原文件落盘
                                               |
项目/插件原文件（不迁移） -----------------------+-> 正式 codec -> 内部 ModelSelection
```

- Host 与独立 Agent 初始化复用 `migrateUserSubagentMarkdown`，仅检查各自数据目录下 `agents/` 根目录直接的 `.md` / `.markdown` 文件，与自定义 Agent 的加载范围一致；不遍历子目录，包括历史 CLI 安装目录。项目和插件不自动写入，符号链接和只读文件不改写。
- 只换 frontmatter 的旧 Provider 值，保留型号、档位、注释、正文、未知字段、换行和文件权限；不调用整份 serializer 做自动迁移。
- 正式 Markdown 只读写字符串 `model` 与 `thoughtLevel`，不兼容未发布的 `modelSelection` 中间字段。包含分隔符的 ID 沿用已有 custom 编码保证往返。
- 普通 reader 不再将范围外旧 Provider 临时映射到新账号；保留显式身份，沿用执行校验。没有新增账号自动切换协议或父模型兜底。
- 回归验收：CLI 首次加载与再次加载均只迁移用户根目录文件；用户子目录中的旧格式文件不读取、不改写、不加载，项目和插件文件保持原样。
- 详见 [全域 Selection 审计](working-memory/provider-refactor/research/todo97-selection-storage-audit.md)，Wiki 的读时写入冲突仍待裁决，不将其算作已完成。

## Runtime 语义

```ts
type BuiltInSubagentName = "general-purpose" | "Explore";
type BuiltInSubagentModelSelectionOverrides = Partial<Record<BuiltInSubagentName, ModelSelection>>;
```

bootstrap 启动时读取 state；本地集成入口在新父上下文使用 Host 内存 state 更新 built-in profile 的 model / thought level overrides。启动配置显式传入的覆盖优先于磁盘配置；若启动配置替换了某个 agent 的 model 但没有提供 thought level，该 agent 不继承磁盘中旧模型的 thought level。

`Agent` tool 的 provider-visible input 不提供 `model` 或 `thoughtLevel` 参数，也不存在 invocation 级覆盖。普通会话的 child runtime 读取最终解析出的 `AgentProfile`：

- profile 未配置模型时继承父会话 main model 及 provider options。
- profile 配置具体模型、未配置 thought level 时，按该目标模型的 catalog 默认档位生成 provider options。
- profile 同时配置 thought level 时，必须先确认该档位属于目标模型，再复用 main runtime 的 reasoning resolver 生成 provider options；非法值直接拒绝，不能回落到默认或邻近档位。

闲时任务为本轮前台 child 提供 `turnExecutionModel` 时，该快照覆盖 profile 的 model、thought level、provider options 与模型限制；此时不校验或应用 profile thought level。快照只在当前 turn 生效且不持久化，后续普通调用恢复上述 profile 语义；后台 child 继续由闲时任务边界拒绝。

历史消息中已经持久化的旧 `Agent.model` 字段不做数据迁移，后续执行时按未知字段丢弃，不能覆盖当前 profile。

custom / workspace profile 的既有加载、命名优先级和模型字段保持不变。plugin profile 的命名优先级不变；bootstrap 加载插件 agent 时读取同一 state 文件，按 id 把 model / thought level 覆盖注入规范名 profile 与裸名别名 profile，未命中时保留 md 声明的 model。

## 插件 subagent 的发现范围

Settings 与 runtime 必须看到同一批插件 subagent。runtime 通过 plugin resolve 同时加载 marketplace 安装插件与内置官方插件；services 的 `discoverPluginAgents` 过去只读 `installed_plugins.json`，导致内置官方插件（如 `document-skills` 的 `judge`）在 Settings 不可见。修复后 services 额外扫描 `<cli storage>/plugins/cache/zcode-plugins-official/<name>/<version>/`：

```text
installed_plugins.json 记录 ──────────────┐
                                          ├─> 按 pluginId 去重（安装记录优先）
cache/zcode-plugins-official/<name>/<ver> ┘        │
   版本目录按数字感知降序取第一个可用目录            ▼
   跳过 .backup / .seed-lock / .tmp- 目录     启用判定：
                                              enabledPlugins[pluginId]
                                              ?? 默认启用集合（与 skills/commands 共用）
                                              且不在 suppressedBuiltins
```

官方插件的 `pluginId` 为 `<manifest.name>@zcode-plugins-official`，与 CLI `PluginMetadata.id` 一致，因此覆盖键在两侧对得上。

## Explore 工具面

`Explore` 的 allowed tools 必须使用最终 effective child model 判断 embedded-search 分支。没有覆盖时不能继续按旧 `lite` 默认值计算工具面。

## UI 语义

Settings 的 Subagents 列表中：

```text
Subagent Settings
                                      |
                                      v
目标 Environment ModelSelectionService.getView()
                                      |
       +--> provider/model candidates
       `--> reasoning option specs
```

Subagent 设置页只读取目标 Environment 的 Model Selection View。远端 Workspace 直接读取远端 View，
本地 Workspace 读取本地 View；页面不比较 App snapshot 与 workspace catalog，也不触发 Registry 下发。

- 内置 agent 与插件 agent 显示模型控件；两者共用同一控件与即改即存语义。插件 agent 的默认项文案同样表达“继承默认”，含义是回落到插件 md 声明的模型，md 未声明时继承父会话主模型。
- 内置和 custom agent 的显式模型支持 reasoning 时，在模型控件右侧复用主输入框的 `ThoughtLevelCycleControl`。
- effort 的加载门禁与 Draft 对齐：Selection View 中目标模型的 Option Spec 是唯一能力来源；页面不读取 Session `configOptionsStatus`，也不从另一个 Environment 的 metadata 补齐。
- Provider/Model 身份使用 `providerId + modelId`；展示态 variant 不创建第二份模型身份。
- 目标 Environment 尚未 ready 时显示 loading；读取失败显示错误并允许显式重试，不使用旧 Registry Snapshot 或本地 View 为远端兜底。
- effort 控件只在目录仍会到达时显示 loading（首读中、等待远端连接）。读取失败或目标没有模型目录（远端设备「用户」）时，目录不会自行变成 ready：显示「推理档位暂不可用」，不转圈；已存的 model / `thoughtLevel` 保持原值，不判为非法，也不阻止保存。
- reasoning Option Spec 缺失或空档位表示当前模型没有可选 reasoning 档位；非空档位是该模型的合法集合。
- 用户选择不同模型时同步清空内存中的 explicit `thoughtLevel`；重复选择同一模型是 no-op。
- 具体模型尚未配置 explicit `thoughtLevel` 时，控件可以展示 catalog 默认档位，但展示值不等于已经持久化的覆盖。Select 的真实选中值始终是当前 effective 档位，保证键盘焦点与可访问选中态一致；explicit 状态独立维护。用户未操作 effort 控件就保存时继续保留 `thoughtLevel: undefined`；用户再次确认当前 effective 档位或选择其他合法档位时，都必须把选择写入草稿并持久化。
- `inherit` 或不支持 reasoning 的模型不显示 effort 控件。
- Selection View 明确给出非空档位时渲染可写控件；空数组或缺少 Option Spec 时隐藏控件，不从旧 catalog 或 App-local metadata 回填。
- 历史 effort 不属于当前模型时显示原始值和错误并阻止 custom 保存，不自动映射到第一档；builtin 可通过选择合法档位或切换模型修正。
- 已保存的具体模型从当前候选中删除后，打开菜单只展示当前候选，不把历史模型补回菜单；由于目标模型能力已不可用，effort 控件隐藏。Builtin 触发器显示“选择模型”提示；Custom 列表徽标保留原模型名，编辑表单触发器显示“选择模型”提示。Custom 表单继续保留原始 model / `thoughtLevel` 作为未提交状态并阻止保存，直到用户重新选择可用模型；仅打开编辑页不能改写原 Markdown。该规则只改变模型触发器的展示，不改变候选来源、校验、保存或 runtime 语义。
- 内置 agent 与插件 agent 不显示 edit、delete、enabled switch、prompt editor 或 tools editor；插件行不可点击进入表单。
- `general-purpose` 的默认项文案表达“继承默认”。
- `Explore` 的默认项文案表达“继承默认”。
- Builtin / plugin model / effort 通过一次调用原子保存，写入期间禁用两个控件；写入失败恢复上一组合并弹 toast。写入成功是提交点，后续列表刷新失败不能回滚已持久化组合。
- Custom 保存直接用当前 `{ model, thoughtLevel }` 覆写 Markdown；`thoughtLevel` 为 `undefined` 时删除旧字段。

## E2E 口径

测试不得以 `workspace/updateProviderRegistry` 作为 Subagent 配置对账步骤。

桌面 E2E 验证真实窗口编辑与冷启动生效：

1. Settings 修改 builtin model / effort，核对 `agents-state.json` 的完整组合。
2. Settings 修改 custom model / effort 并保存，核对 Markdown frontmatter；切换模型后确认旧 effort 被删除。
3. 注入非法历史 effort，确认显示错误、阻止保存，并可选择合法档位修正。
4. 冷启动后通过 `Agent` tool 触发 child request，确认 provider-visible model 与 reasoning 参数来自 profile 配置，父请求不受影响。
5. `Explore` child request 不暴露写工具。
6. 即使 provider 返回历史版本的 `Agent.model` 参数，也不能覆盖当前 profile 模型。
7. 对 App metadata 未声明 reasoning 的 `claude-opus-4-8`，主输入框与 builtin/custom Subagent 都必须展示 runtime catalog 的 `low/medium/high/xhigh`，并通过 raw provider request 与 model-io 验证父子 effort 隔离。
8. Settings 只选择 reasoning 模型但不操作 effort 控件时，核对 builtin state 不新增 thought-level key，custom Markdown frontmatter 不新增 `thoughtLevel`；同时确认控件仍展示目标模型的 catalog 默认档位。
9. Custom 保存模型 A 与 effort 后，从模型供应商设置删除 A，再重新打开该 Subagent 编辑页；核对模型控件显示“选择模型”提示、下拉菜单不含 A、effort 控件隐藏、保存不可用，并确认原 Markdown 未被自动改写。
10. BigModel 登录后 workspace catalog 尚缺 Coding Plan 时，先确认 effort 能由 App metadata 立即展示，再独立等待后台对账把目标模型及 `high` / `max` 写入 runtime catalog。
11. 用户领取 Start Plan 并进入 Subagents 后，模型分组先显示 Start；用户到模型供应商设置切回 Individual，再次进入 Subagents 后，模型分组必须显示 Individual 候选。UI 单测补充验证同一连接键链路切到 Team。

Settings CRUD 使用独立的无 provider-request E2E 验证保存产物，不与上述 child runtime 场景串成同一个用例：

| Scope / 类型              | 创建             | 编辑             | 保存后验收产物                                                                        |
| ------------------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------- |
| Builtin `general-purpose` | 产品不支持，剪枝 | 覆盖             | `agents-state.json` 中 model / effort 原子组合                                        |
| Builtin `Explore`         | 产品不支持，剪枝 | 覆盖             | `agents-state.json` 中 model / effort 原子组合                                        |
| Custom user               | 覆盖             | 覆盖（含重命名） | `<user-data>/agents/<name>.md` 的完整 frontmatter、正文与旧路径删除                   |
| Custom workspace          | 覆盖             | 覆盖（含重命名） | `<workspace>/.zcode/agents/<name>.md` 的完整 frontmatter、正文与旧路径删除            |
| Plugin                    | 产品不支持，剪枝 | 覆盖             | `agents-state.json` 中 `pluginAgent*Overrides` 按 agent id 的 model / effort 原子组合 |

该 E2E 只消费现有 model/capability 投影来驱动控件，不发送 prompt、不重启验证 child、不修改 CLI 或 model resolver。Custom user 与 workspace 共用表单和 service serializer，但分别验证两个实际落盘目录。

“仅展示默认档位但未操作 effort”使用独立 case 验证，避免被同一流程后续的显式 effort 选择掩盖；该 case 同时核对 builtin `agents-state.json` 与 custom Markdown 的最终文件产物。

Settings 保存与清空覆盖由 UI/service 单测覆盖。SHR01-SHR03 的真实 Desktop E2E 验证已有 session 的下一轮 spawn、失败 child 恢复及同轮保持旧配置，见 [配置刷新验收](./subagent-runtime-refresh.md)。

## 验收

- Settings 中内置 agent 有模型控件。
- Settings 中内置 agent 仍无编辑、删除、禁用入口。
- Settings 中内置官方插件（如 `document-skills:judge`）与 marketplace 插件的 subagent 都可见，并有模型控件；插件 agent 仍无编辑、删除、禁用入口。
- 保存插件 agent 覆盖后，list/state 按 agent id 回显覆盖模型；冷启动后 child request 使用覆盖模型。
- 保存 `general-purpose` 覆盖后，list/state 回显覆盖模型。
- 保存 `Explore` 覆盖后，list/state 回显覆盖模型。
- Builtin/custom 能保存、回显并清除 reasoning effort。
- Builtin/custom 在没有 explicit effort 时显式选择当前展示的 catalog 默认档位，也能分别写入 state / Markdown；仅展示默认值但未操作控件时仍不新增覆盖。
- 模型切换立即清空表单中的 explicit effort；provider catalog 刷新不会清空。
- 不同模型只显示自身支持的档位；不支持 reasoning 时隐藏控件。
- catalog 未知与明确无档位不能混为一谈；loading/旧 payload 不清除或误判历史 effort。
- 非法历史档位不会静默回落或被保存。
- 清空覆盖恢复默认模型。
- runtime child request 使用覆盖模型及该模型对应的 provider options。
- provider-visible `Agent` input 不包含 `model`，历史版本额外传入该字段时不会改变 child 模型。
- `Explore` child tools 与覆盖模型能力一致。
