# Desktop Local Model Provider P0 E2E Cases

## Todo159：连接测试统一 512 Token

- 当前契约：所有 Provider 的连接测试统一以 512 Token 为目标、受模型输出上限约束，固定 Prompt、最低公开推理档位与错误边界保持不变。
- C91-04 正式用例 `settings/providers/provider-connectivity-prompt.test.ts`：模型输出上限设为 256，真实点击后断言请求到达服务且 Chat wire 的 `max_completion_tokens=256`；无正文 length 结束仍成功，400 仍失败，保存的配置及选择不变。fixture 用量仍为 1，表示实际消耗，不是请求预算。
- Todo95 正式用例 `settings/providers/provider-reasoning-fallback.test.ts`：稀疏档位配置仍产生 512 的连接测试预算，不固化推荐容量。
- Core 测试验证预算唯一入口及辅助调用隔离；六类 API/账号 Adapter wire 场景验证 Anthropic、Chat、Responses 的实际序列化预算均为 512。桌面点击使用 Chat 代表，手机、远端及真实上游验收不由此推定。

2026-11-02 Linux 评审修正验证：上述两条正式 E2E 2/2 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261102-080152-340`，分别覆盖受上限约束的 256 与普通模型的 512。

## Todo144 历史验证：连接测试 1 Token、无正文也成功

以下保留当时的预算与 pending 状态；当前用例已转正，预算由 Todo159 取代。

2026-09-15 Pro 验证：C91-04 与 Todo95 两个 pending spec 联合 2/2 通过，run `desktop-e2e-20260915073727784-p67110-e4267aabc5aa16a0`。无正文成功 fixture 明确返回 completion_tokens=1，避免混同“无内容且无用量”的既有 Adapter 重试场景；不改正式重试策略。

- 扩展 C91-04 pending `settings/manual-review/pending/provider-connectivity-prompt.test.ts`：真实模型行点击；case-local loopback 返回无正文且 finish_reason=length 的 SSE，断言成功反馈、Chat wire max_completion_tokens=1、原有固定 Prompt 不变；第二次返回 400，断言失败且配置/选择不变。
- 接受组合：最低档位及预算/错误边界由 Core 单测覆盖，三类协议预算字段由 Adapter 单测覆盖。E2E 用 Chat 代表；不扩大到所有品牌、主题、远端/手机实机，不冒称上游全部兼容。仍为 synthetic/fast-text、本地隔离、pending 不转正。

## Todo95：未知型号仅配置推理档位

- Todo147 扩展：同一 pending 用例在添加未知型号时检查推荐窗口 `1000000`、输出上限 `128000`；保存后确认这两项未写入 Personal。继续使用原连接测试预算，不因推荐上限提高而扩大实际探测请求。三协议、已知型号覆盖和别名顺序由配置层测试覆盖；不新增 UI 状态或主题布局。
- Pending：`settings/manual-review/pending/provider-reasoning-fallback.test.ts`。仅本地 `desktop-continuous`；不代表手机或远端实机证明。
- Setup：独立 loopback Chat Completions synthetic SSE 服务，空模型自定义 Provider；不写个人推理 Map，不用账号或真实额度。
- Action：真实设置页添加未知 `E2E_T95_UNKNOWN`，仅把默认 disabled 档位改成 high，保留智能配置；保存后点击行内连接测试。
- Assert：Personal 只保存 values、不固化推荐 Map；最终线上格式请求带 high 的四组兼容字段、原模型 ID、既定 probe Prompt；不带手动思考预算。随后既有 SC90-01 验证固定配置/编辑回读，C91-04 验证默认 disabled 与失败不改选择。
- 剪枝：三类 Schema / 全部专用 Map 合法档位和覆盖顺序由配置与请求层单测枚举；本交互选 Chat 高档作为代表，不重复三份 UI。改名工作线 C 仍待安全边界裁决，不能以本用例宣称兼容改名完成。
- fixture 分类：synthetic / fast-text；固定白名单 Prompt 不能插入 marker，以独立模型 ID `E2E_T95_UNKNOWN` 识别；独立本地服务只返回固定 ok，不接触外部模型。

本文记录桌面端本地 workspace 下，聊天框模型供应商相关 P0 E2E 的逐条设计、验证项和实际运行结论。范围只包含 desktop local，不包含 remote workspace、手机 `/remote`、replayable 恢复或远端 runtime header fallback。

每条 case 必须满足：

- 只覆盖一个明确的正向产品语义，不把相邻 queue、stop、remote 或 fault 语义混进同一条。
- 有独立 setup、action、assert；不能因为某条测试路径经过相关状态就算覆盖。
- 核心验证必须至少包含 UI 可见状态、真实 provider 请求或抓包、session/store 终态之一。
- 正式化前必须有 case-local fixture 和 manifest；已经在正式路径的 case 需要重新跑 fixture check 与 replay 证明合同仍有效。

## P0-01: 本地默认工作区 DeepSeek 首发冒烟

### Case 定义

| 字段             | 内容                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I07`                                                                                                                 |
| Spec             | `packages/desktop/test/e2e/conversation-session/runtime/conversation-session-upstream-workspace-smoke.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-upstream-workspace-smoke.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-upstream-workspace-smoke.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                          |

### 测试场景

用户启动桌面端并打开默认本地工作区，DeepSeek 自定义 provider 已由 E2E helper 写入隔离 app data。用户在聊天框工具栏打开模型列表，确认 DeepSeek provider 下存在目标模型，选择该模型后发送第一条普通文本消息。

这条 case 只验证“本地默认工作区 + 已配置 DeepSeek + 空草稿首发”的最小正向链路。它不覆盖 queue、stop、模型切换、edit/fork、远程 workspace 或 provider 故障。

### 操作步骤

1. 清理并准备 E2E app data，启动桌面端本地默认工作区。
2. 等待默认 workspace 已打开，并确认主聊天视图可交互。
3. 打开聊天框模型列表。
4. 在 DeepSeek provider 分组下查找目标模型。
5. 选择目标 DeepSeek 模型。
6. 发送带 `E2E_UPSTREAM_WORKSPACE_SMOKE` marker 的普通文本。
7. 等待用户消息、DeepSeek 请求抓包、assistant 回复和最终 idle 状态。

### 验证条目

| 编号    | 验证项                                                         | 有效性说明                                                  | 当前断言位置                                                                               |
| ------- | -------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| P0-01-A | 默认本地工作区已打开，且聊天主视图存在                         | 证明 case 从用户真实可交互入口开始，而不是直接调用服务层    | `assertDefaultWorkspaceOpened()` 检查 workspace item、chat view、active workspace path     |
| P0-01-B | 模型列表按钮可点击                                             | 证明聊天框模型选择入口可用                                  | `assertUpstreamModelListShowsTargetModel()` 等待 `TID_CHAT_MODEL_SELECT_TRIGGER` clickable |
| P0-01-C | DeepSeek provider 分组存在或可展开                             | 证明目标模型来自正确 provider 分组，不是裸模型名误匹配      | `provider:${UPSTREAM_PROVIDER_ID}` group test id                                           |
| P0-01-D | 目标模型在模型列表中可见                                       | 证明当前 Environment 的 Model Selection View 已投影到聊天框 | `TID_CHAT_MODEL_SELECT_ITEM` 精确 test id，支持 custom encoded value                       |
| P0-01-E | 选择后工具栏当前模型是目标模型                                 | 证明用户选择动作写入当前聊天配置                            | `assertSelectedUpstreamModel()` 检查 currentValue/text/title                               |
| P0-01-F | 发送后输入框清空，用户消息可见                                 | 证明普通首发走真实 composer 交互，用户输入没有丢失          | `waitForComposerText("")`、`waitForUserMessageContaining(marker)`                          |
| P0-01-G | 捕获到包含本次 marker 的 DeepSeek 主请求                       | 证明 assistant 回复不是本地伪造，真实 provider 请求已发出   | `waitForUpstreamNetworkCapture(marker)`                                                    |
| P0-01-H | 请求 body 中的 prompt 与用户输入一致                           | 证明首发上下文包含正确用户消息                              | `assertUpstreamRequestCapture({ expectedText: prompt })`                                   |
| P0-01-I | 请求 body 使用目标 DeepSeek 模型                               | 证明 UI 选中的模型真实影响 provider 请求                    | `assertUpstreamRequestCapture({ model: UPSTREAM_MODEL })`                                  |
| P0-01-J | 如果 provider 声明 thought level，则请求包含当前 thought level | 证明思考深度配置同步到 provider request                     | `assertUpstreamThoughtLevelCapture(captureRecord, UPSTREAM_THOUGHT_LEVEL)`                 |
| P0-01-K | assistant 回复包含约定 token                                   | 证明 replay 响应被 UI 正确消费并渲染                        | `waitForAssistantMessageContaining(E2E_REPLY_TOKEN)`                                       |
| P0-01-L | 首轮完成后 session 回到 idle 且 queue=0                        | 证明首发链路完整收口，没有残留 busy 或误入队                | `waitForChatState(snapshot.state === "idle" && snapshot.queueCount === 0)`                 |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- 首发主请求是 `main` synthetic fixture，matcher 必须包含 `E2E_UPSTREAM_WORKSPACE_SMOKE`，并排除标题生成和 compact summary prompt。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

2026-07-02 已重新执行：

- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/runtime/conversation-session-upstream-workspace-smoke.test.ts`
  - 结果：通过。
  - 备注：`upstream-workspace-smoke-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-upstream-workspace-smoke.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/runtime/conversation-session-upstream-workspace-smoke.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-104055-569/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-01-A 到 P0-01-L 均由正式 spec 断言覆盖；运行日志中可见 `model_name=e2e-upstream/deepseek-v4-flash`、`model_provider=e2e-upstream`，最终 `state=idle`、`queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/runtime/conversation-session-upstream-workspace-smoke.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-104133-542/summary.md`。
  - 结论：默认 replay 路径下同一组 UI、request、reply、session 终态验证仍有效。

P0-01 已满足当前目标中的“详细描述、实际验证、转正后重新确认”要求。该 case 已在正式路径，未重复执行 promotion。

## P0-02: 设置页新增 custom provider 后聊天框可选并首发

### Case 定义

| 字段             | 内容                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I08`                                                                                                                |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-model-provider-add-send.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-provider-add-send.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-add-send.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                         |

### 测试场景

用户在桌面端本地默认 workspace 中打开设置页，新增一个本 case 唯一命名的 custom provider，填写 DeepSeek replay endpoint、API Key 和目标模型。添加模型弹窗全部字段平铺：上下文窗口默认 1,000,000，最大输出默认 128,000；输入类型默认且锁定 Text，可选择 Image/Video，Audio/PDF 暂不展示；输出类型当前固定 Text。输入目标模型后显示 catalog 查询状态并自动回填最大输出，用户选择 Image、覆盖回填值后保存；provider 创建完成后再进入编辑模型弹窗取消 Image 并修改最大输出。保存后回到聊天框选择新增模型并首发。

这条 case 验证“设置页新增 provider 与模型元数据配置 -> 本地配置持久化 -> 聊天框 provider/model registry 同步 -> 真实 provider 请求”的最短正向链路。catalog 未匹配、未声明、查询失败和迟到结果由交互单测覆盖；E2E 不把启动时已预置的 DeepSeek provider 视为新增，也不覆盖 remote、queue、stop、fork、provider 故障或多 session 隔离。

### 操作步骤

1. 清理并准备 E2E app data，启动桌面端本地默认工作区。
2. 进入设置页的模型供应商分区。
3. 点击“添加自定义供应商”导航项。
4. 填写唯一 provider 名称、DeepSeek replay Base URL、API Key。
5. 确认新增模型 metadata 弹窗字段全部平铺，Context=1M、Max Output=128K；输入 Text 和输出 Text 均锁定。
6. 输入目标模型 ID，确认查询期间 loading、最大输出仍可编辑且保存禁用；等待真实 catalog 回填最大输出 Token，并确认 Context 仍为 1M。
7. 选择 Image、覆盖最大输出并提交模型 draft；点击“添加供应商”，等待模态与数值写入本地配置。
8. 重新进入模型编辑弹窗，确认 Image 与最大输出正确回显；取消 Image、修改最大输出并提交，再等待配置持久化。
9. 返回聊天框，打开模型列表，选择新增 provider 下的目标模型。
10. 发送带 `E2E_MODEL_PROVIDER_ADD_SEND` marker 的普通文本。
11. 等待用户消息、DeepSeek 请求抓包、assistant 回复和最终 idle 状态。

### 验证条目

| 编号    | 验证项                                                                                                  | 有效性说明                                                     | 当前断言位置                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P0-02-A | 默认本地工作区已打开，主聊天视图可交互                                                                  | 证明从桌面本地真实入口开始                                     | `waitForWorkspaceApp(DEFAULT_WORKSPACE)`                                                                    |
| P0-02-B | 设置页模型供应商分区可进入                                                                              | 证明用户通过真实 UI 配置 provider                              | `openModelProviderSettings()`                                                                               |
| P0-02-C | 新增 custom provider 表单可填写名称、Base URL、API Key                                                  | 证明设置页新增入口可用，不依赖预置配置                         | `setInputValueByIdDom(...)`                                                                                 |
| P0-02-D | 新增模型弹窗无“高级”折叠，字段全部平铺；Context=1M、Max Output=128K                                     | 证明新默认值和扁平信息架构走真实 UI                            | `assertFlatMetadataDefaults()`                                                                              |
| P0-02-E | 输入 Text 默认选中且不可取消，Image/Video 可切换且 Audio/PDF 不展示，输出只展示锁定 Text                | 证明类型选择和当前输出边界                                     | `assertFlatMetadataDefaults()`、`setInputModalitySelected(...)`                                             |
| P0-02-F | 输入目标 ID 后 pending/loading、最大输出仍可编辑但保存禁用；真实 catalog 回填最大输出且 Context 仍为 1M | 证明 catalog 时序、用户输入优先和提交保护                      | `setModelIdAndAssertCatalogPending(...)`、`waitForCatalogMaxOutputTokens(...)`                              |
| P0-02-G | 用户选择 Image、覆盖回填值后可提交模型                                                                  | 证明模型元数据原子提交                                         | `addModelThroughMetadataDialog(...)`、`clickModelMetadataSave()`                                            |
| P0-02-H | 新 provider 持久化 apiKey、endpoint、最大输出、`input=[text,image]`、`output=[text]` 和显式来源标记     | 证明模态及来源持久化真实收口                                   | `waitForCreatedProvider(...)`                                                                               |
| P0-02-I | 编辑弹窗平铺回显 Image 和最大输出；取消 Image、修改最大输出后保存                                       | 证明 Edit 模式读取并更新已有模型元数据                         | `editModelMetadata(...)`、`clickModelMetadataSave()`                                                        |
| P0-02-J | 编辑后的最大输出 Token 再次持久化                                                                       | 证明修改值沿用现有 provider 保存链路                           | `waitForCreatedProvider(...)`                                                                               |
| P0-02-K | 聊天框模型列表能展示并选择新增 provider 下模型                                                          | 证明当前 Environment Registry 刷新后 Model Selection View 生效 | `selectUpstreamProviderModelById(...providerId...)`                                                         |
| P0-02-L | 工具栏 currentValue 保留新增 provider id                                                                | 证明同名模型不会退化成裸 model 名匹配                          | `assertSelectedAddedProviderModel(...)`                                                                     |
| P0-02-M | 发送后输入框清空，用户消息可见                                                                          | 证明普通首发走真实 composer 交互                               | `waitForComposerText("")`、`waitForUserMessageContaining(marker)`                                           |
| P0-02-N | 捕获到包含本次 marker 的 DeepSeek 主请求                                                                | 证明 assistant 回复来自真实 provider 请求                      | `waitForUpstreamNetworkCapture(marker)`                                                                     |
| P0-02-O | 请求 body 使用目标模型、当前思考深度和编辑后的最大输出 Token                                            | 证明模型高级配置最终进入真实 runtime 请求                      | `assertUpstreamRequestCapture`、`assertUpstreamThoughtLevelCapture`、`readRequestNumber(..., "max_tokens")` |
| P0-02-P | assistant 回复包含约定 token                                                                            | 证明 replay 响应被 UI 正确消费                                 | `waitForAssistantMessageContaining(E2E_REPLY_TOKEN)`                                                        |
| P0-02-Q | 首轮完成后 session 回到 idle 且 queue=0                                                                 | 证明新增 provider 首发链路完整收口                             | `waitForChatState(snapshot.state === "idle" && snapshot.queueCount === 0)`                                  |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- 首发主请求是 `main` synthetic fixture，matcher 必须包含 `E2E_MODEL_PROVIDER_ADD_SEND`，并排除标题生成和 compact summary prompt。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

2026-07-02 已完成新增、promotion 和 replay 验证：

- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-model-provider-add-send.test.ts --reviewed`
  - 结果：dry run 通过。
  - 结论：promotion 只移动本 case spec，生成本 case provider fixture 与 manifest，并识别到 `E2E_MODEL_PROVIDER_ADD_SEND` marker。
- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-model-provider-add-send.test.ts --reviewed --apply`
  - 结果：通过。
  - 结论：spec 已从 pending 转入正式 `conversation-session/` 路径。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-model-provider-add-send.test.ts`
  - 结果：通过。
  - 备注：`model-provider-add-send-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-add-send.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-model-provider-add-send.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-105033-078/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-02-A 到 P0-02-L 均由正式 spec 断言覆盖；运行日志中可见 `modelCurrent=<新增 provider id>/deepseek-v4-flash`，最终 `state=idle`、`queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-model-provider-add-send.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-105059-157/summary.md`。
  - 结论：默认 replay 路径下同一组设置页新增 provider、模型 currentValue provider 身份、request、reply、session 终态验证仍有效；日志中可见 `model_provider=<新增 provider id>`，证明请求没有退回预置 `e2e-upstream`。

P0-02 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

2026-07-25 扩展模型高级配置能力并重新转正后验证：

- promotion dry run 与 `--apply` 均通过，spec 已移入正式 `conversation-session/` 路径，现有 case-local fixture 与 manifest 保持不变。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-add-send.test.ts`
  - 结果：通过；common 与 I08 case-local fixture 合同完整。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-add-send.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-provider-add-send.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260724-180207-567/summary.md`。
  - 结论：P0-02-A 到 P0-02-Q 均由正式 spec 的显式 replay 断言覆盖；真实 provider 请求中的 `max_tokens=64000`，与编辑后的模型值一致。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-provider-add-send.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260724-180255-549/summary.md`。
  - 结论：默认正式 fixture 合成路径下，同一组高级字段交互、持久化和请求合同仍有效。
- 本轮完成正式路径转正；Docker 准入未执行。

2026-08-21 扩展平铺模态设置后验证：

- `pnpm --filter @zcode/desktop typecheck:e2e`：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-add-send.test.ts`：通过。
- 显式加载 common + I08 case-local fixture 运行正式 spec：1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260821-034404-305/summary.md`。
  - 结论：真实 UI 已覆盖字段平铺、1M/128K 默认值、Text 锁定、Image 选择和取消、模态来源持久化、active registry 更新及首发请求。
- 隐藏 Audio/PDF 并将标题调整为“输入类型/输出类型”后，默认正式 replay 再次通过：1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260821-051251-156/summary.md`。
  - 结论：真实设置弹窗只展示 Text/Image/Video 输入类型和固定 Text 输出类型，原有保存、registry 同步与首发请求链路保持有效。
- 删除已经与 Video 附件能力事实冲突的泛化提示后，显式加载 common + I08 case-local fixture 再次通过：1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260821-094323-479/summary.md`。
  - 视觉证据：`packages/desktop/.e2e-artifacts/model-settings-modality-help-removed-zh-dark.png`、`packages/desktop/.e2e-artifacts/model-settings-modality-help-removed-en-light.png`。
  - 结论：真实弹窗不再渲染提示行；中文深色和英文浅色下，输入/输出类型分组间距、按钮换行和对话框高度均保持正常。

## P0-03: 聊天模型列表只展示可用 provider/model

### Case 定义

| 字段             | 内容                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I09`                                                                                                                      |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-model-provider-list-filtering.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-provider-list-filtering.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-list-filtering.json` |
| 当前状态         | pending；2026-08-25 已按 Provider 重构语义扩充，等待真实 replay、人工 review 与 promotion                                  |

### 测试场景

桌面端本地默认 workspace 启动时，E2E 种子同时提供可用 provider、隐藏 provider、含隐藏 model 的可见 provider、disabled/incomplete provider，以及真实 `builtin:zai/glm-5.3` 与同身份 Personal Overlay。用户打开聊天框模型列表时，隐藏或不可执行成员不应出现；Built-in 与 Personal 重名时，Built-in 模型仍应保持可选择、可执行，并使用 Overlay 后的 Effective Endpoint 完成真实发送。

这条 case 只覆盖“模型列表可见性过滤 + 可见模型可发送”。它不覆盖设置页新增 provider、provider 保存、remote、queue、stop、edit/fork 或多 session 恢复。

当前 Registry 中 Provider 隐藏用 `visibility=hidden`，模型禁用用 `ModelConfig.enabled=false`。I09 的模型种子必须写入后者；旧 model.visibility 不是正式模型配置字段，不能当作已经设置了不可选条件。

### 操作步骤

1. 清理并准备 E2E app data，启动桌面端本地默认工作区。
2. WDIO seed 为本 spec 注入可用 DeepSeek provider、可用 alt provider、隐藏 provider、含隐藏 model 的可见 provider、disabled/incomplete provider，以及 `builtin:zai/glm-5.3` 的 Personal Overlay。
3. 打开聊天框模型列表。
4. 检查可用 provider 分组和目标模型项存在。
5. 检查隐藏 provider、disabled、缺 API Key、缺 endpoint provider 分组和模型项均不存在。
6. 展开可见 provider，检查可见 companion model 存在、隐藏 model 不存在。
7. 展开 `builtin:zai`，检查 `glm-5.3` 没有被同身份 Personal Overlay 隔离。
8. 精确选择 `builtin:zai/glm-5.3`，确认工具栏保留复合 Provider/Model 身份。
9. 发送带 `E2E_MODEL_PROVIDER_LIST_FILTER` marker 的普通文本。
10. 等待请求抓包、assistant 回复和最终 idle 状态，并确认请求使用 `glm-5.3` 与 Overlay 后的 case-local Endpoint。

### 验证条目

| 编号    | 验证项                                                        | 有效性说明                                             | 当前断言位置                                                         |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| P0-03-A | 默认本地工作区已打开，主聊天视图可交互                        | 证明从桌面本地真实入口开始                             | `prepareConversationE2E()`、`waitForWorkspaceApp(DEFAULT_WORKSPACE)` |
| P0-03-B | 可用 DeepSeek provider 分组存在                               | 证明正常 provider 没有被过滤误伤                       | `assertModelListFiltering()`                                         |
| P0-03-C | 可见 provider 中的 companion model 存在、hidden model 不存在  | 证明 model visibility 独立参与菜单投影                 | `assertModelListFiltering()`                                         |
| P0-03-D | 可用 alt provider 分组存在                                    | 证明同名模型的另一个可用 provider 仍保留 provider 身份 | `assertModelListFiltering()`                                         |
| P0-03-E | hidden provider 不展示                                        | 证明 provider visibility 独立参与菜单投影              | `assertModelListFiltering()`                                         |
| P0-03-F | disabled provider 不展示                                      | 证明 `enabled=false` 被菜单过滤                        | `assertModelListFiltering()`                                         |
| P0-03-G | 缺 API Key provider 不展示                                    | 证明需要凭据的 provider 未配置时不进入聊天选择         | `assertModelListFiltering()`                                         |
| P0-03-H | 缺 endpoint provider 不展示                                   | 证明没有可发送 endpoint 的 provider 不进入聊天选择     | `assertModelListFiltering()`                                         |
| P0-03-I | Built-in/Personal 同身份时 `builtin:zai/glm-5.3` 仍展示       | 证明 Personal Overlay 不会把 Built-in 成员误隔离       | `assertModelListFiltering()`                                         |
| P0-03-J | 选择后工具栏 currentValue 保留 `builtin:zai/glm-5.3` 复合身份 | 证明选择动作不退化为裸 modelId                         | `assertSelectedProviderModel()`                                      |
| P0-03-K | 请求使用 `glm-5.3` 且命中 `/builtin-personal-conflict`        | 证明 Built-in 模型沿 Effective Provider Config 执行    | `assertUpstreamRequestCapture()`、请求 URL 断言                      |
| P0-03-L | assistant 回复包含约定 token，首轮完成后 idle 且 queue=0      | 证明过滤后的可见模型发送链路完整收口                   | `waitForAssistantMessageContaining()`、`waitForChatState()`          |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- 首发主请求是 `main` synthetic fixture，matcher 必须包含 `E2E_MODEL_PROVIDER_LIST_FILTER` 与 `/builtin-personal-conflict`，并排除标题生成和 compact summary prompt。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

2026-08-25 已按 Provider 重构后的 visibility 与 Overlay 语义扩充本 case。fixture contract check 和 E2E typecheck 已通过；当前环境没有可用的 Xvfb/Docker，因此扩充后的真实 replay、人工 review、promotion 与 Docker admission 尚未完成，case 必须继续保持 pending。

2026-07-02 已完成新增、promotion 和 replay 验证：

- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-list-filtering.test.ts --reviewed`
  - 结果：dry run 通过。
  - 结论：promotion 只移动本 case spec，生成本 case provider fixture 与 manifest，并识别到 `E2E_MODEL_PROVIDER_LIST_FILTER` marker。
- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-list-filtering.test.ts --reviewed --apply`
  - 结果：通过。
  - 结论：spec 已从 pending 转入正式 `conversation-session/` 路径。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-list-filtering.test.ts`
  - 结果：通过。
  - 备注：`model-provider-list-filtering-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-list-filtering.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-provider-list-filtering.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-105836-007/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-03-A 到 P0-03-J 均由正式 spec 断言覆盖；不可用 provider 负样本没有泄漏到菜单，最终 `state=idle`、`queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-provider-list-filtering.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-110012-665/summary.md`。
  - 结论：默认 replay 路径下同一组模型列表过滤、provider 身份、request、reply、session 终态验证仍有效；运行日志中可见 `model_provider=e2e-upstream`，证明可见模型发送链路没有被过滤逻辑破坏。

上述 2026-07-02 结果仅证明旧版 case，不作为 2026-08-25 扩充后断言的绿色证据。

## P0-04: 空草稿切换模型后首发使用新模型

### Case 定义

| 字段             | 内容                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I10`                                                                                                                      |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-draft-model-switch-first-send.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-draft-model-switch-first-send.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-draft-model-switch-first-send.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                               |

### 测试场景

桌面端本地默认 workspace 已打开，聊天框处于空草稿状态，DeepSeek provider 中同时存在 primary 模型和 secondary 模型。用户在发送任何消息前，从聊天框模型列表把当前模型切换到 secondary 模型，并选择 secondary 对应的思考深度。随后用户发送第一条普通文本消息。

这条 case 验证“草稿态模型选择是未来 session 配置”的最小链路。它不覆盖 completed 历史后的模型切换、running 中 queue 消费、stop 后 held queue、edit/fork 或 remote。

### 操作步骤

1. 清理并准备 E2E app data，启动桌面端本地默认工作区。
2. 确保 DeepSeek provider 已包含 secondary 模型。
3. 新建空草稿，确认当前没有 session/task 绑定。
4. 在聊天框模型列表选择 secondary 模型。
5. 在聊天框思考深度列表选择 secondary 思考深度。
6. 断言工具栏 currentValue / 展示文案已经落到 secondary 配置。
7. 发送带 `E2E_DRAFT_MODEL_SWITCH_FIRST_SEND` marker 的普通文本。
8. 等待用户消息、DeepSeek 请求抓包、assistant 回复和最终 idle 状态。

### 验证条目

| 编号    | 验证项                                                              | 有效性说明                                       | 当前断言位置                                                               |
| ------- | ------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| P0-04-A | 默认本地工作区已打开，主聊天视图可交互                              | 证明从桌面本地真实入口开始                       | `prepareConversationE2E()`、`waitForWorkspaceApp(DEFAULT_WORKSPACE)`       |
| P0-04-B | DeepSeek secondary 模型已存在于 provider 配置                       | 证明测试不是选择一个未配置模型                   | `ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL)`                      |
| P0-04-C | 新建后处于空草稿态，没有 session/task 绑定                          | 证明动作发生在发送前草稿态                       | `waitForChatState(taskId/sessionId === null)`                              |
| P0-04-D | 选择 secondary 模型后工具栏 currentValue 保留 provider + model 身份 | 证明模型选择写入当前草稿未来配置，不是仅文本显示 | `assertSelectedSecondaryConfig()`                                          |
| P0-04-E | 选择 secondary 思考深度后工具栏显示对应配置                         | 证明请求的 depth 选择也随草稿配置更新            | `assertSelectedSecondaryConfig()`                                          |
| P0-04-F | 发送后输入框清空，用户消息可见                                      | 证明首发走真实 composer 交互                     | `waitForComposerText("")`、`waitForUserMessageContaining(marker)`          |
| P0-04-G | 捕获到包含本次 marker 的 DeepSeek 主请求                            | 证明 assistant 回复来自真实 provider 请求        | `waitForUpstreamNetworkCapture(marker)`                                    |
| P0-04-H | 请求 body 使用 secondary 模型和 secondary 思考深度                  | 证明草稿态切换真实影响首发 runtime 请求          | `assertUpstreamRequestCapture`、`assertUpstreamThoughtLevelCapture`        |
| P0-04-I | assistant 回复包含约定 token                                        | 证明 replay 响应被 UI 正确消费                   | `waitForAssistantMessageContaining(E2E_REPLY_TOKEN)`                       |
| P0-04-J | 首轮完成后 session 回到 idle 且 queue=0                             | 证明草稿切模型首发链路完整收口                   | `waitForChatState(snapshot.state === "idle" && snapshot.queueCount === 0)` |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- 首发主请求是 `main` synthetic fixture，matcher 必须包含 `E2E_DRAFT_MODEL_SWITCH_FIRST_SEND`，并排除标题生成和 compact summary prompt。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

2026-07-02 已完成新增、promotion 和 replay 验证：

- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-draft-model-switch-first-send.test.ts --reviewed`
  - 结果：dry run 通过。
  - 结论：promotion 只移动本 case spec，生成本 case provider fixture 与 manifest，并识别到 `E2E_DRAFT_MODEL_SWITCH_FIRST_SEND` marker。
- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-draft-model-switch-first-send.test.ts --reviewed --apply`
  - 结果：通过。
  - 结论：spec 已从 pending 转入正式 `conversation-session/` 路径。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-draft-model-switch-first-send.test.ts`
  - 结果：通过。
  - 备注：`draft-model-switch-first-send-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-draft-model-switch-first-send.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-draft-model-switch-first-send.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-110339-709/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-04-A 到 P0-04-J 均由正式 spec 断言覆盖；运行日志中可见 `model_name=e2e-upstream/deepseek-v4-pro`、`model_provider=e2e-upstream`，最终 `state=idle`、`queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-draft-model-switch-first-send.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-110404-195/summary.md`。
  - 结论：默认 replay 路径下同一组空草稿态、secondary 模型 currentValue、secondary 思考深度、request、reply、session 终态验证仍有效；请求没有退回 primary `deepseek-v4-flash`。

P0-04 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

## P0-05: 新建会话继承上一次模型选择

### Case 定义

| 字段             | 内容                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I11`                                                                                                                   |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-new-session-inherits-model.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-new-session-inherits-model.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-new-session-inherits-model.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                            |

### 测试场景

用户在桌面端本地默认 workspace 中把聊天框模型切到 DeepSeek secondary，并完成一条普通会话。随后点击新建任务进入空草稿，不再手动切模型，直接发送下一条普通文本。

这条 case 验证“新建会话继承最近一次聊天框 provider/model/thought 选择”。它不覆盖多 session 配置隔离、queue、stop、edit/fork 或 remote。

### 操作步骤

1. 启动桌面端本地默认工作区，并确保 DeepSeek secondary 模型存在。
2. 在空草稿切到 secondary 模型和 secondary 思考深度。
3. 发送带 `E2E_NEW_SESSION_INHERITS_MODEL_A` marker 的普通文本并等待完成。
4. 点击新建任务进入空草稿。
5. 不再手动选择模型，断言工具栏仍为 secondary 配置。
6. 发送带 `E2E_NEW_SESSION_INHERITS_MODEL_B` marker 的普通文本并等待完成。
7. 分别断言 A/B 两次 provider 请求都使用 secondary 模型和 secondary 思考深度，且最终 idle、queue=0。

### 验证条目

| 编号    | 验证项                                            | 有效性说明                        | 当前断言位置                                             |
| ------- | ------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| P0-05-A | secondary 模型存在并可被首次草稿选择              | 证明继承源配置真实存在            | `ensureUpstreamModelForE2E`、`selectUpstreamModelById`   |
| P0-05-B | 第一次发送请求使用 secondary 配置                 | 证明继承源不是 toolbar 假象       | `assertSecondaryUpstreamConfig(recordA, promptA)`        |
| P0-05-C | 新建任务后处于空草稿态且工具栏仍为 secondary 配置 | 证明新草稿继承最近选择            | `waitForEmptyDraft()`、`assertSelectedSecondaryConfig()` |
| P0-05-D | 第二次直接首发请求使用 secondary 配置             | 证明继承配置真实影响 runtime 请求 | `assertSecondaryUpstreamConfig(recordB, promptB)`        |
| P0-05-E | 两次发送后均回到 idle 且 queue=0                  | 证明继承链路完整收口              | `waitForIdleQueueEmpty()`                                |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- 两次普通发送共用一个 `main` synthetic fixture，matcher 必须包含 `E2E_NEW_SESSION_INHERITS_MODEL`，`maxMatches=2`。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

2026-07-02 已完成新增、promotion 和 replay 验证：

- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-new-session-inherits-model.test.ts --reviewed`
  - 结果：dry run 通过。
  - 结论：promotion 生成本 case provider fixture 与 manifest，并识别到 `E2E_NEW_SESSION_INHERITS_MODEL_A/B` marker。
- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-new-session-inherits-model.test.ts --reviewed --apply`
  - 结果：通过。
  - 结论：spec 已从 pending 转入正式 `conversation-session/` 路径。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-new-session-inherits-model.test.ts`
  - 结果：通过。
  - 备注：`new-session-inherits-model-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-new-session-inherits-model.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-new-session-inherits-model.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-110744-702/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-05-A 到 P0-05-E 均由正式 spec 断言覆盖；A/B 两次请求均使用 `model_name=e2e-upstream/deepseek-v4-pro`，最终 `state=idle`、`queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-new-session-inherits-model.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-110810-218/summary.md`。
  - 结论：默认 replay 路径下新建空草稿继承 secondary provider/model/thought 的 UI 与 request 断言仍有效。

P0-05 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

## P0-06: 多 session provider/model 配置隔离

### Case 定义

| 字段             | 内容                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I12`                                                                                                                         |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-model-provider-session-isolation.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-provider-session-isolation.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-session-isolation.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                                  |

### 测试场景

用户在桌面端本地默认 workspace 内创建两个普通 session：Session A 使用 DeepSeek primary 模型和 primary 思考深度完成一轮；Session B 使用 DeepSeek secondary 模型和 secondary 思考深度完成一轮。随后用户分别切回 A/B 并继续发送普通文本。

这条 case 验证“同一个本地窗口内不同 session 的 provider/model/thought 配置互相隔离”。它不覆盖 running 并发、queue、stop、remote 或新建草稿继承。

### 操作步骤

1. 启动桌面端本地默认工作区，并确保 DeepSeek secondary 模型存在。
2. 在 Session A 空草稿选择 primary 模型和思考深度，发送 A 首轮并等待完成。
3. 新建 Session B，选择 secondary 模型和思考深度，发送 B 首轮并等待完成。
4. 切回 Session A，断言工具栏恢复 primary 配置，发送 A follow-up。
5. 切回 Session B，断言工具栏恢复 secondary 配置，发送 B follow-up。
6. 分别断言四次 provider 请求使用对应 session 的模型和思考深度，且最终 idle、queue=0。

### 验证条目

| 编号    | 验证项                                  | 有效性说明                                       | 当前断言位置                                     |
| ------- | --------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| P0-06-A | A 首轮请求使用 primary 配置             | 证明 A 的初始 session 配置真实写入 runtime       | `assertUpstreamConfig(recordA, primary)`         |
| P0-06-B | B 首轮请求使用 secondary 配置           | 证明 B 的配置与 A 不同且真实写入 runtime         | `assertUpstreamConfig(recordB, secondary)`       |
| P0-06-C | 切回 A 后工具栏恢复 primary 配置        | 证明 UI 恢复按 session 维度，而不是全局最近选择  | `assertSelectedUpstreamConfig(primary)`          |
| P0-06-D | A follow-up 请求继续使用 primary 配置   | 证明 B 的 secondary 选择没有污染 A               | `assertUpstreamConfig(recordAFollow, primary)`   |
| P0-06-E | 切回 B 后工具栏恢复 secondary 配置      | 证明 B 的 session 配置仍保留 provider/model 身份 | `assertSelectedUpstreamConfig(secondary)`        |
| P0-06-F | B follow-up 请求继续使用 secondary 配置 | 证明 A 的恢复和后续发送没有污染 B                | `assertUpstreamConfig(recordBFollow, secondary)` |
| P0-06-G | 每轮完成后 idle 且 queue=0              | 证明隔离链路没有残留 busy 或误入队               | `waitForIdleQueueEmpty()`                        |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- A/B/A-follow/B-follow 四次普通发送各有一条 `main` synthetic fixture，matcher 精确包含对应 `E2E_MODEL_PROVIDER_SESSION_ISOLATION_*` marker。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

2026-07-02 已完成新增、promotion 和 replay 验证：

- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-session-isolation.test.ts --reviewed`
  - 结果：dry run 通过。
  - 结论：promotion 生成本 case provider fixture 与 manifest，并识别到 A/B/A-follow/B-follow 四个 marker。
- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-session-isolation.test.ts --reviewed --apply`
  - 结果：通过。
  - 结论：spec 已从 pending 转入正式 `conversation-session/` 路径。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-provider-session-isolation.test.ts`
  - 结果：通过。
  - 备注：`model-provider-session-isolation-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-session-isolation.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-provider-session-isolation.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-111128-713/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-06-A 到 P0-06-G 均由正式 spec 断言覆盖；A/A-follow 使用 primary，B/B-follow 使用 secondary，最终 `state=idle`、`queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-provider-session-isolation.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-111200-772/summary.md`。
  - 结论：默认 replay 路径下同一组 A/B session provider/model/thought 隔离断言仍有效。退出阶段出现一次 `electron-service:bridge` context id timeout 日志，但 spec 结果为 passed，未影响产品断言。

P0-06 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

## P0-07: 跨 provider 切换后请求使用 alternate provider 模型

### Case 定义

| 字段             | 内容                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I13`                                                                                                                     |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-same-model-provider-identity.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-same-model-provider-identity.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-same-model-provider-identity.json` |
| 当前状态         | 已 promotion 到正式路径，并完成 strict/default replay                                                                     |

### 测试场景

桌面端本地 E2E 种子同时提供 primary DeepSeek provider 和 alternate DeepSeek provider。primary provider 暴露 `deepseek-v4-flash`，alternate provider 暴露 `deepseek-v4-pro`。用户在聊天框选择 alternate provider 下的 `deepseek-v4-pro`，并发送第一条普通文本。

这条 case 验证“跨 provider 选择会真实改变 provider 请求模型”。聊天框 `data-model-current-value` 精确断言 alternate provider 身份，请求抓包断言 body 中的 `model` 必须是 `deepseek-v4-pro`，从而避免只通过相同 URL 和相同模型名得到弱证明。

### 操作步骤

1. 启动桌面端本地默认工作区。
2. 打开聊天框模型列表，选择 alternate provider 下的 `deepseek-v4-pro`，并显式选择本 case 要验证的思考档位。
3. 断言工具栏 currentValue 为 alternate provider + `deepseek-v4-pro` 的 provider-backed value。
4. 发送带 `E2E_SAME_MODEL_PROVIDER_IDENTITY` marker 的普通文本。
5. 再次断言工具栏仍保留 alternate provider 身份。
6. 断言 provider 请求 body 使用 `deepseek-v4-pro` 而不是 primary provider 的 `deepseek-v4-flash`，assistant 回复正常，最终 idle、queue=0。

### 验证条目

| 编号    | 验证项                                                               | 有效性说明                                                                               | 当前断言位置                                            |
| ------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| P0-07-A | alternate provider 下 `deepseek-v4-pro` 可被选择                     | 证明菜单展示的是 alternate provider 的模型，不是 primary provider 的 `deepseek-v4-flash` | `selectUpstreamProviderModelById(...)`                  |
| P0-07-B | 发送前 currentValue 保留 alternate provider id + `deepseek-v4-pro`   | 证明 provider 身份和模型都没有退化                                                       | `assertSelectedAlternateProviderModel()`                |
| P0-07-C | 发送后 currentValue 仍保留 alternate provider id + `deepseek-v4-pro` | 证明创建 session 后配置没有被 primary 覆盖                                               | `assertSelectedAlternateProviderModel()`                |
| P0-07-D | 首发请求使用 `deepseek-v4-pro` 并包含用户输入                        | 证明跨 provider 选择真实影响 runtime 请求模型                                            | `assertUpstreamRequestCapture`                          |
| P0-07-E | assistant 回复并回到 idle、queue=0                                   | 证明链路完整收口                                                                         | `waitForAssistantMessageContaining`、`waitForChatState` |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- 首发主请求是 `main` synthetic fixture，matcher 必须包含 `E2E_SAME_MODEL_PROVIDER_IDENTITY`；请求断言负责校验 `model=deepseek-v4-pro`。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-same-model-provider-identity.test.ts --reviewed`
  - 结果：dry-run 通过，pending spec 可 promotion。
- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/conversation-session-same-model-provider-identity.test.ts --reviewed --apply`
  - 结果：通过，spec、fixture manifest、provider fixture 已转正式路径。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-same-model-provider-identity.test.ts`
  - 结果：通过。
  - 备注：`same-model-provider-identity-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-same-model-provider-identity.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-same-model-provider-identity.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-125933-021/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，alternate provider currentValue 精确保持 `e2e-upstream-alt/deepseek-v4-pro`；运行日志显示 `model_name=e2e-upstream-alt/deepseek-v4-pro`、`model_provider=e2e-upstream-alt`，请求 body 由 spec 断言 `model=deepseek-v4-pro`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-same-model-provider-identity.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-130000-917/summary.md`。
  - 结论：默认 replay 路径下 provider 身份、`deepseek-v4-pro` 请求、assistant 回复和 idle 收口断言仍有效；运行日志同样显示 `model_name=e2e-upstream-alt/deepseek-v4-pro`、`model_provider=e2e-upstream-alt`。

P0-07 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

## P0-08: running queue 消费前切模型，auto drain 使用最新 provider 配置

### Case 定义

| 字段             | 内容                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Catalog          | `N02`、`I03`                                                                                                    |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-queue.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json` |
| 当前状态         | 已是正式路径，并按本轮 top10 完成 fixture check 与 strict/default replay                                        |

### 测试场景

桌面端本地会话首轮请求保持 streaming，用户在 running 状态继续输入第二条文本形成 queue。queue item 被消费前，用户在聊天框切到 secondary model 和 secondary thought level。首轮 in-flight 请求不应被改写；queue item auto drain 发起的新请求必须使用该 session 最新模型配置。

### 操作步骤

1. 启动桌面端本地默认工作区。
2. 选择 primary model 和 primary thought level。
3. 发送带 `E2E_MODEL_SWITCH_QUEUE_RUNNING` 的慢流请求，稳定进入 streaming。
4. 输入带 `E2E_MODEL_SWITCH_QUEUE_AUTO_DRAIN` 的第二条普通文本，确认进入 queue。
5. 在 queue 消费前切到 secondary model 和 secondary thought level。
6. 等待 queue 自动 drain。
7. 断言 queued request 使用 secondary model 和 secondary thought level，最终 idle、queue=0。

### 验证条目

| 编号    | 验证项                                       | 有效性说明                             | 当前断言位置                                             |
| ------- | -------------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| P0-08-A | running 首轮保持 streaming                   | 稳定制造 queue 消费前切模型窗口        | `waitForChatState(state === "streaming")`                |
| P0-08-B | 第二条文本进入 queue                         | 证明后续请求不是直接发送               | `waitForQueueContaining`、`waitForQueueCount(1)`         |
| P0-08-C | 切到 secondary model/thought 后 queue 被消费 | 证明切模型不会卡住本地 queue           | `waitForChatState(queueCount === 0)`                     |
| P0-08-D | queued request 使用 secondary model          | 证明 queued turn 读取最新 session 配置 | `assertUpstreamRequestCapture`                           |
| P0-08-E | queued request 使用 secondary thought level  | 证明 provider 参数不只更新模型名       | `assertUpstreamThoughtLevelCapture`                      |
| P0-08-F | 最终 idle、queue=0                           | 证明链路完整收口                       | `waitForChatState(state === "idle" && queueCount === 0)` |

### Fixture 合同

- `upstream-model-switch-queue-running-slow` 是 controlled-stream synthetic fixture，用于稳定 running 窗口。
- `upstream-model-switch-queue-auto-drain-secondary` 是 queued turn 的固定回复，业务断言在 request capture 的 model/thought。
- `upstream-model-switch-slow-marker-contract` 只用于 fixture checker 覆盖通用慢流 marker。

### 实际验证结论

- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts`
  - 结果：通过。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts'`
  - 结果：通过，1 个 spec / 2 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-111816-458/summary.md`。
  - 结论：strict replay 下，`running 中 queued text 消费前切模型，auto drain 应使用 secondary 配置` passed；queued turn 使用 secondary model/thought，最终 idle、queue=0。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts'`
  - 结果：通过，1 个 spec / 2 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-112016-248/summary.md`。
  - 结论：默认 replay 路径下 auto-drain 切模型断言仍有效。

P0-08 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

## P0-09: stop 后 held queue 切模型再立即发送使用最新 provider 配置

### Case 定义

| 字段             | 内容                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Catalog          | `M07h`、`N02`、`I03`                                                                                            |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-queue.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json` |
| 当前状态         | 已是正式路径，并按本轮 top10 完成 fixture check 与 strict/default replay                                        |

### 测试场景

桌面端本地会话首轮请求保持 streaming，用户输入第二条文本形成 queue 后点击 stop。stop 后 queue item 仍被 hold 在队列中，不应偷偷发起请求。用户切到 secondary model 和 secondary thought level，再点击队首“立即发送”。被点 queue item 必须用最新 secondary 配置发出。

### 操作步骤

1. 启动桌面端本地默认工作区。
2. 选择 primary model 和 primary thought level。
3. 发送带 `E2E_MODEL_SWITCH_HELD_RUNNING` 的慢流请求，稳定进入 streaming。
4. 输入带 `E2E_MODEL_SWITCH_HELD_SEND_NOW` 的第二条普通文本，确认进入 queue。
5. 点击 stop，确认退出 streaming 且 queue 仍保留。
6. 短窗口内确认 held marker 没有被提前发送。
7. 切到 secondary model 和 secondary thought level。
8. 点击队首立即发送。
9. 断言 send-now request 使用 secondary model 和 secondary thought level。

### 验证条目

| 编号    | 验证项                                        | 有效性说明                        | 当前断言位置                                                  |
| ------- | --------------------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| P0-09-A | running 首轮保持 streaming                    | 稳定制造 stop + held queue 窗口   | `waitForChatState(state === "streaming")`                     |
| P0-09-B | 第二条文本进入 queue                          | 证明 held item 存在               | `waitForQueueContaining`、`waitForQueueCount(1)`              |
| P0-09-C | stop 后退出 streaming 且 queue 保留           | 证明 stop 没误删 queue            | `waitForChatState(state !== "streaming" && queueCount === 1)` |
| P0-09-D | held marker stop 后未提前发请求               | 证明必须由“立即发送”触发消费      | `expectNoUpstreamRequestForTextWithin`                        |
| P0-09-E | 队首立即发送消费正确 item                     | 证明不是消费错队列项              | `clickFirstQueueSendNow()` 返回内容断言                       |
| P0-09-F | send-now request 使用 secondary model/thought | 证明即时发送读取最新 session 配置 | `assertSecondaryUpstreamConfig`                               |

### Fixture 合同

- `upstream-model-switch-held-running-slow` 是 controlled-stream synthetic fixture，用于稳定 stop 前 queue。
- `upstream-model-switch-held-send-now-secondary` 是 send-now turn 的固定回复，业务断言在 request capture 的 model/thought。
- 同一 spec 同时覆盖 P0-08 和 P0-09，strict replay 必须只依赖 common + `conversation-session-model-switch-queue.json`。

### 实际验证结论

- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts`
  - 结果：通过。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts'`
  - 结果：通过，1 个 spec / 2 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-111816-458/summary.md`。
  - 结论：strict replay 下，`stop 后 held queue 切模型再立即发送，应使用 secondary 配置` passed；held marker stop 后未提前请求，点击“立即发送”后使用 secondary model/thought。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts'`
  - 结果：通过，1 个 spec / 2 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-112016-248/summary.md`。
  - 结论：默认 replay 路径下 held queue send-now 切模型断言仍有效。

P0-09 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

## P0-10: completed 后切模型，edit/fork 后续请求使用最新 provider 配置

### Case 定义

| 字段             | 内容                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `N03`、`N04`                                                                                                               |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-edit-fork.json`           |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-edit-fork.json`        |
| 当前状态         | 已 promotion 到正式路径，并完成 strict/default replay                                                                      |

### 测试场景

桌面端本地会话已经 completed，用户在同一 session 内切到 secondary model 和 secondary thought level。之后执行两个高频历史操作：

1. edit 旧 user query 并提交重跑。
2. fork 已完成 assistant message，在派生 session 发送 follow-up。

这条 case 验证 completed 历史操作使用“动作发生时的当前 session provider 配置”，而不是复用原始消息创建时的 primary 配置。

### 操作步骤

1. 启动桌面端本地默认工作区。
2. 选择 primary model 和 primary thought level，发送 `E2E_MODEL_SWITCH_EDIT_SOURCE`，等待 completed。
3. 切到 secondary model 和 secondary thought level。
4. edit 旧 user query 为 `E2E_MODEL_SWITCH_EDIT_RERUN`，提交后断言重跑请求使用 secondary 配置。
5. 新建 task，选择 primary 配置，发送 `E2E_MODEL_SWITCH_FORK_SOURCE`，等待 completed。
6. 切到 secondary 配置，点击 assistant message 的 fork。
7. 等待派生 session idle 且 queue=0，发送 `E2E_MODEL_SWITCH_FORK_FOLLOWUP`。
8. 断言 fork 后 follow-up 请求使用 secondary 配置。

### 验证条目

| 编号    | 验证项                                              | 有效性说明                                  | 当前断言位置                                                        |
| ------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| P0-10-A | edit source 以 primary 配置完成                     | 建立已完成历史基线                          | source capture + completed state                                    |
| P0-10-B | completed 后 toolbar 可切到 secondary model/thought | 证明动作前 session 配置已更新               | `expectToolbarConfig`                                               |
| P0-10-C | edit rerun 请求使用 secondary model                 | 证明 edit 不复用旧 turn 模型快照            | `assertUpstreamRequestCapture`                                      |
| P0-10-D | edit rerun 请求使用 secondary thought level         | 证明 provider 参数随配置更新                | `assertUpstreamThoughtLevelCapture`                                 |
| P0-10-E | fork 后派生 session idle 且 queue=0                 | 证明 fork 不复制父 queue，也不是继续原 task | `waitForChatState`                                                  |
| P0-10-F | fork 派生 session toolbar 继承 secondary 配置       | 证明 fork 继承的是当前 session 配置         | `expectToolbarConfig`                                               |
| P0-10-G | fork follow-up 请求使用 secondary model/thought     | 证明派生 session 后续请求使用继承配置       | `assertUpstreamRequestCapture`、`assertUpstreamThoughtLevelCapture` |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- edit 分支包含 `edit-source` 和 `edit-rerun-secondary` 两个 main fixture。
- fork 分支包含 `fork-source` 和 `fork-followup-secondary` 两个 main fixture。
- fixture matcher 必须用不同 marker 区分 source/rerun/follow-up，避免 source fixture 抢占 rerun 或 follow-up。

### 实际验证结论

- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts --reviewed`
  - 结果：dry-run 通过，pending spec 可 promotion。
- `pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts --reviewed --apply`
  - 结果：通过，spec、fixture manifest、provider fixture 已转正式路径。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts`
  - 结果：通过。
  - 备注：`model-switch-edit-fork-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-edit-fork.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-112609-771/summary.md`。
  - 结论：strict replay 下，edit rerun 和 fork follow-up 均使用 secondary model/thought；fork 派生 session idle 且 queue=0。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/manual-review/pending/conversation-session-model-switch-edit-fork.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-112643-403/summary.md`。
  - 结论：默认 replay 路径下 completed 后切模型 edit/fork 断言仍有效。

P0-10 已满足当前目标中的“详细描述、实际验证、promotion 转正、转正后重新确认”要求。Docker 准入按本轮约定暂不执行。

## P0-11: GLM-5.2 OpenAI-compatible 思考档位请求字段

### Case 定义

| 字段             | 内容                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I14`                                                                                                                      |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-glm52-reasoning-request-shape.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-glm52-reasoning-request-shape.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                               |

### 测试场景

用户在桌面端本地默认 workspace 中添加一个 custom OpenAI-compatible provider，模型 ID 为 `GLM-5.2`，Base URL 指向本地 replay server，API Key 使用 E2E dummy key。用户回到聊天框，从模型列表选择该 provider 下的 `GLM-5.2`，先选择 `max` 思考档位并发送普通文本；首轮完成后，用户将思考档位切到 `nothink`，再发送第二条普通文本。

这条 case 验证 GLM-5.2 的思考强度直接映射为顶层 `reasoning_effort`，其中 UI 档位 `nothink` 映射为 provider 值 `none`。它只覆盖“UI 选择 -> session 配置 -> agent providerOptions -> OpenAI-compatible request body”的正向合同，不验证真实 BigModel/Z.AI 线上服务可用性，不与 queue、stop、edit/fork、remote 或 compact 叉乘。

### 操作步骤

1. 清理并准备 E2E app data，启动桌面端本地默认 workspace。
2. 通过设置页添加 custom provider，API 格式选择 `openai-chat-completions`，模型为 `GLM-5.2`。
3. 返回聊天框，打开模型列表，选择新增 provider 下的 `GLM-5.2`。
4. 选择 `max` 思考档位。
5. 发送带 `E2E_GLM52_REASONING_MAX` marker 的普通文本，等待回复完成。
6. 选择 `nothink` 思考档位。
7. 发送带 `E2E_GLM52_REASONING_NOTHINK` marker 的普通文本，等待回复完成。

### 验证条目

| 编号    | 验证项                                                                                  | 有效性说明                                                                | 当前断言位置                                                                        |
| ------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0-11-A | 新增 provider 被保存为 OpenAI-compatible / Chat Completions 格式，且包含 `GLM-5.2` 模型 | 证明 case 的前置供应商事实正确，不是误用默认 DeepSeek/Anthropic provider  | `createCustomGlm52Provider()` 读取 provider store 校验 `apiFormat`、endpoint、model |
| P0-11-B | 聊天框模型列表能按新增 provider 身份选择 `GLM-5.2`                                      | 证明模型选择来自目标 provider，不是裸模型名或其他 provider 命中           | `selectUpstreamProviderModelById(...providerId...)` + `assertSelectedGlm52Model()`  |
| P0-11-C | 选择 `max` 后工具栏/store 当前思考档位为 `max`                                          | 证明发送前 session 配置已经更新到目标档位                                 | `assertSelectedThoughtLevel("max")`                                                 |
| P0-11-D | `max` 首发请求 path 使用 `/chat/completions`，body 中 `model=GLM-5.2` 且包含用户 marker | 证明请求走 OpenAI-compatible Chat Completions transport，并且 prompt 没丢 | `assertUpstreamRequestCapture`、`assertGlm52MaxRequest`                             |
| P0-11-E | `max` 首发请求写入顶层 `reasoning_effort=max`                                           | 证明 GLM-5.2 深度档位映射到正确 provider-visible 字段                     | `assertGlm52MaxRequest`                                                             |
| P0-11-F | `max` 首轮 assistant 回复可见，完成后 `idle && queue=0`                                 | 证明 replay 响应被 UI 正确消费，链路完整收口                              | `waitForAssistantMessageContaining`、`waitForChatState`                             |
| P0-11-G | 切到 `nothink` 后工具栏/store 当前思考档位为 `nothink`                                  | 证明关闭思考不是仅菜单项可见，而是真实写入配置                            | `assertSelectedThoughtLevel("nothink")`                                             |
| P0-11-H | `nothink` 后续请求仍使用同一 provider/model，且 body 包含第二个用户 marker              | 证明同一 session completed 后切思考档位只影响后续请求，不丢 provider 身份 | `assertUpstreamRequestCapture`、`assertGlm52NoThinkRequest`                         |
| P0-11-I | `nothink` 请求写入顶层 `reasoning_effort=none`，且不残留 `max/high`                     | 证明 UI 关闭档位映射到 provider 的 canonical `none`                       | `assertGlm52NoThinkRequest`                                                         |
| P0-11-J | 第二轮 assistant 回复可见，完成后 `idle && queue=0`                                     | 证明关闭思考请求也能完整完成，未残留 busy 或 queue                        | `waitForAssistantMessageContaining`、`waitForChatState`                             |

### Fixture 合同

- 标题生成请求使用 `common` synthetic 响应，同时由 matcher 验证 GLM-5.2 title sidecar
  写入顶层 `reasoning_effort=none`，且不包含 `extra_body`、`chat_template_kwargs` 或 `thinking`。
- `max` 与 `nothink` 两个主请求各有一条 `main` synthetic fixture，matcher 分别包含 `E2E_GLM52_REASONING_MAX` 和 `E2E_GLM52_REASONING_NOTHINK`。
- 主响应使用 OpenAI Chat Completions SSE 形状，避免用 Anthropic Messages SSE 快捷响应污染 transport 语义。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

#### 历史验证记录（2026-07-02，旧 wrapper 合同）

以下记录对应 canonical direct-field 切换之前的实现，仅保留为历史证据：

- `pnpm --filter @zcode/adapters test -- tests/runner-options.test.ts`
  - 结果：通过，40 个 test file passed，540 个 tests passed，2 个 skipped。
  - 结论：补充的 adapter 单测先复现了 `openaiCompatible.extra_body` 没有进入 OpenAI-compatible SDK provider namespace 的问题；修复后证明 GLM-5.2 的请求级 providerOptions 会同时保留 `openaiCompatible` 并复制到 SDK 实际读取的 provider namespace。
- `pnpm --filter @zcode/adapters build && pnpm --filter @zcode/cli build`
  - 结果：通过。
  - 结论：桌面 E2E 使用 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，必须重建 agent bundle 后 formal replay 才能验证最新 adapter 行为。
- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts`
  - 结果：通过。
  - 备注：`glm52-reasoning-request-shape-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-glm52-reasoning-request-shape.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-142931-535/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-11-A 到 P0-11-J 均由正式 spec 断言覆盖；`max` 请求体实际包含 `extra_body.chat_template_kwargs.reasoning_effort=max`，`nothink` 请求体实际包含 `extra_body.chat_template_kwargs.enable_thinking=false` 且未残留 `reasoning_effort=max/high`，两轮最终均回到 `idle` 且 `queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-142959-372/summary.md`。
  - 结论：默认 replay 路径下同一组新增 OpenAI-compatible provider、GLM-5.2 provider 身份、`max`/`nothink` 请求字段、assistant 回复和 session 终态验证仍有效。
- `E2E_SPEC=./test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts pnpm run test:e2e:container`
  - 结果：未完成，Docker build 在拉取 `docker.io/docker/dockerfile:1.7` 时 TLS handshake timeout。
  - 结论：这是 Docker Hub 网络问题，按本轮约定忽略；未作为 case 行为失败处理。

#### 当前 direct-field 回归（2026-07-22）

- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts`
  - 结果：通过。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-glm52-reasoning-request-shape.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-glm52-reasoning-request-shape.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260722-124706-346/summary.md`。
  - 结论：P0-11-A 到 P0-11-J 均由当前 spec 断言覆盖；主请求的 `max` / `nothink`
    分别生成顶层 `reasoning_effort=max` / `reasoning_effort=none`，title sidecar 生成
    `reasoning_effort=none`；三者均不包含 `extra_body` 或 `chat_template_kwargs`，两轮主请求
    最终均回到 `idle && queueCount=0`。

P0-11 已满足当前目标中的“详细描述、实际验证、转正后重新确认”要求。该 case 已在正式路径；Docker 准入受网络问题影响暂不执行。

## P0-12: DeepSeek V4 OpenAI-compatible 思考档位请求字段

### Case 定义

| 字段             | 内容                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I15`                                                                                                                            |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-deepseek-v4-reasoning-request-shape.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-deepseek-v4-reasoning-request-shape.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                                     |

### 测试场景

用户在桌面端本地默认 workspace 中添加一个 case-local custom DeepSeek OpenAI-compatible provider，目标模型为 `deepseek-v4-flash`，Base URL 指向本地 replay server，API Key 使用 E2E dummy key。表单保存的模型记录不携带 reasoning metadata；用户从聊天框模型列表选择该 provider 下的模型，以 Agent resolver 的默认 `max` 首发。首轮完成并建立会话投影后，用户将思考档位切到 `high`，再发送第二条普通文本。

这条 case 验证 DeepSeek V4 的思考强度是 OpenAI-compatible Chat Completions 请求上的 provider 参数：深度值写入顶层 `reasoning_effort`，同时通过顶层 `thinking.type=enabled` 保持思考开启。它不覆盖 GLM-5.2 的 `reasoning_effort=none`，不覆盖 Anthropic-compatible 的 `thinking.budget_tokens`，不验证真实 DeepSeek 线上服务可用性，也不与 queue、stop、edit/fork、remote 或 compact 叉乘。

### 操作步骤

1. 清理并准备 E2E app data，启动桌面端本地默认 workspace。
2. 通过设置页添加 custom provider，API 格式选择 `openai-chat-completions`，模型为 `deepseek-v4-flash`。
3. 返回聊天框，打开模型列表，选择新增 provider 下的 `deepseek-v4-flash`。
4. 直接发送带 `E2E_UPSTREAM_V4_REASONING_MAX` marker 的普通文本，验证 Agent resolver 默认 `max`。
5. 等待首轮完成和会话权威投影建立。
6. 选择 `high` 思考档位。
7. 发送带 `E2E_UPSTREAM_V4_REASONING_HIGH` marker 的普通文本，等待回复完成。

### 验证条目

| 编号    | 验证项                                                                                                                            | 有效性说明                                                                                  | 当前断言位置                                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P0-12-A | 默认本地 workspace 已打开，聊天主视图可交互                                                                                       | 证明从桌面真实入口开始，不直接调用服务层                                                    | `waitForWorkspaceApp(DEFAULT_WORKSPACE)`                                                 |
| P0-12-B | 新增 provider 被保存为 OpenAI-compatible / Chat Completions 格式，且包含 `deepseek-v4-flash` 模型                                 | 证明 case 的前置供应商事实正确，不是误用默认 Anthropic-compatible DeepSeek provider         | `createCustomUpstreamV4Provider()` 读取 provider store 校验 `apiFormat`、endpoint、model |
| P0-12-C | 聊天框模型列表能按新增 provider 身份选择 `deepseek-v4-flash`                                                                      | 证明模型来自目标 provider，不是裸模型名或其他 provider 命中                                 | `selectUpstreamProviderModelById(...providerId...)` + `assertSelectedUpstreamV4Model()`  |
| P0-12-D | 未在表单注入 reasoning metadata 时，首发请求 path 使用 `/chat/completions`，body 中 `model=deepseek-v4-flash` 且包含 `MAX` marker | 证明请求走目标 custom provider 的 OpenAI-compatible transport，并消费 Agent resolver 默认值 | `assertUpstreamRequestCapture`、`assertUpstreamV4Request(..., "max")`                    |
| P0-12-E | 默认首发请求写入顶层 `reasoning_effort=max` 且 `thinking.type=enabled`                                                            | 证明 DeepSeek V4 默认档位映射到正确 provider-visible 字段                                   | `assertUpstreamV4Request(..., "max")`                                                    |
| P0-12-F | 默认首发请求没有 `extra_body` 或 `chat_template_kwargs`                                                                           | 证明该 case 覆盖 canonical direct-field 合同                                                | `assertUpstreamV4Request(..., "max")`                                                    |
| P0-12-G | `max` 首轮 assistant 回复可见，完成后 `idle && queue=0`                                                                           | 证明 replay 响应被 UI 正确消费，链路完整收口                                                | `waitForAssistantMessageContaining`、`waitForChatState`                                  |
| P0-12-H | 会话投影建立后切到 `high`，工具栏/store 当前思考档位为 `high`                                                                     | 证明显式选择写入当前 session 配置                                                           | `selectUpstreamThoughtLevelValue("high")` + `assertSelectedThoughtLevel("high")`         |
| P0-12-I | `high` 后续请求仍使用同一 provider/model，且 body 包含 `HIGH` marker                                                              | 证明同一 session completed 后切思考档位只影响后续请求，不丢 provider 身份                   | `assertUpstreamRequestCapture`、`assertUpstreamV4Request(..., "high")`                   |
| P0-12-J | `high` 请求写入顶层 `reasoning_effort=high` 且 `thinking.type=enabled`                                                            | 证明显式 high 深度真实覆盖默认 max                                                          | `assertUpstreamV4Request(..., "high")`                                                   |
| P0-12-K | `high` 请求没有残留 `reasoning_effort=max`，也没有 `extra_body` 或 `chat_template_kwargs`                                         | 证明深度切换不串档、不回退 wrapper                                                          | `assertUpstreamV4Request(..., "high")`                                                   |
| P0-12-L | 第二轮 assistant 回复可见，完成后 `idle && queue=0`                                                                               | 证明 high 请求也能完整完成，未残留 busy 或 queue                                            | `waitForAssistantMessageContaining`、`waitForChatState`                                  |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- `high` 与 `max` 两个主请求各有一条 `main` synthetic fixture，matcher 分别包含 `E2E_UPSTREAM_V4_REASONING_HIGH` 和 `E2E_UPSTREAM_V4_REASONING_MAX`。
- 主响应使用 OpenAI Chat Completions SSE 形状，避免用 Anthropic Messages SSE 快捷响应污染 transport 语义。
- 正式 replay 必须只依赖 `common.json` 和本 case fixture，不能依赖 legacy `provider-basic.json` 的专用兜底。

### 实际验证结论

#### 历史验证记录（2026-07-02，旧 wrapper 合同）

以下记录对应 canonical direct-field 切换之前的实现，仅保留为历史证据：

- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts`
  - 结果：通过。
  - 备注：`upstream-v4-reasoning-request-shape-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-deepseek-v4-reasoning-request-shape.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-143724-458/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-12-A 到 P0-12-M 均由正式 spec 断言覆盖；`high` 请求体实际包含 `reasoning_effort=high` 与 `extra_body.thinking.type=enabled`，`max` 请求体实际包含 `reasoning_effort=max` 与 `extra_body.thinking.type=enabled`，两轮均未误写 GLM-5.2 专属 `extra_body.chat_template_kwargs`，最终均回到 `idle` 且 `queueCount=0`。
- `pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-143753-439/summary.md`。
  - 结论：默认 replay 路径下同一组新增 OpenAI-compatible DeepSeek V4 provider、provider 身份、`high`/`max` 请求字段、assistant 回复和 session 终态验证仍有效。
- `E2E_SPEC=./test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts pnpm run test:e2e:container`
  - 结果：未完成，Docker build 在拉取 `docker.io/docker/dockerfile:1.7` 时 TLS handshake timeout。
  - 结论：这是 Docker Hub 网络问题，按本轮约定忽略；未作为 case 行为失败处理。

#### 当前 direct-field 回归（2026-07-22）

- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts`
  - 结果：通过。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-deepseek-v4-reasoning-request-shape.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/models/conversation-session-deepseek-v4-reasoning-request-shape.test.ts'`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260722-124800-459/summary.md`。
  - 结论：P0-12-A 到 P0-12-L 均由当前 spec 断言覆盖；无 reasoning metadata 的 custom
    provider 首发使用默认 `max`，后续切换为 `high`，两轮分别生成顶层
    `reasoning_effort=max/high` 与 `thinking.type=enabled`，且均不包含 `extra_body` 或
    `chat_template_kwargs`，最终回到 `idle && queueCount=0`。

P0-12 已满足当前目标中的“详细描述、实际验证、转正后重新确认”要求。该 case 已在正式路径；Docker 准入受网络问题影响暂不执行。

## P0-13: Claude Anthropic Messages fixed budget 思考档位请求字段

### Case 定义

| 字段             | 内容                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Catalog          | `I16`                                                                                                                          |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-claude-anthropic-reasoning-budget.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-claude-anthropic-reasoning-budget.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-claude-anthropic-reasoning-budget.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                                   |

### 测试场景

用户在桌面端本地默认 workspace 中添加一个 case-local custom Anthropic Messages provider，目标模型为 `claude-sonnet-4`，Base URL 指向本 case 自己启动的本地 replay server，API Key 使用 E2E dummy key。用户从聊天框模型列表选择该 provider 下的模型，先选择 `low` 思考档位并发送普通文本；首轮完成后，用户将思考档位切到 `xhigh`，再发送第二条普通文本。

这条 case 验证 Claude 系模型的 fixed budget 思考强度是 Anthropic Messages 请求上的 provider 参数：`thinking.type=enabled`、`thinking.budget_tokens` 和 `output_config.effort` 必须按档位变化。它不覆盖 OpenAI-compatible 的 `reasoning_effort`，不覆盖 GLM-5.2 的 `chat_template_kwargs`，不验证真实 Anthropic 线上服务可用性，也不与 queue、stop、edit/fork、remote 或 compact 叉乘。

### 操作步骤

1. 启动本 case 的本地 replay server，并把 dummy key、Base URL、capture artifact 写入 E2E 环境。
2. 清理并准备 E2E app data，启动桌面端本地默认 workspace。
3. 通过设置页添加 custom provider，API 格式选择 `anthropic-messages`，模型为 `claude-sonnet-4`。
4. 返回聊天框，打开模型列表，选择新增 provider 下的 `claude-sonnet-4`。
5. 选择 `low` 思考档位。
6. 发送带 `E2E_CLAUDE_ANTHROPIC_REASONING_LOW` marker 的普通文本，等待回复完成。
7. 选择 `xhigh` 思考档位。
8. 发送带 `E2E_CLAUDE_ANTHROPIC_REASONING_XHIGH` marker 的普通文本，等待回复完成。

### 验证条目

| 编号    | 验证项                                                                                            | 有效性说明                                                                | 当前断言位置                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| P0-13-A | 新增 provider 被保存为 Anthropic Messages 格式，且包含 `claude-sonnet-4` 模型                     | 证明 case 的前置供应商事实正确，不是误用 OpenAI-compatible provider       | `createCustomClaudeAnthropicProvider()`                                                      |
| P0-13-B | 聊天框模型列表能按新增 provider 身份选择 `claude-sonnet-4`                                        | 证明模型来自目标 provider，不是裸模型名或其他 provider 命中               | `selectUpstreamProviderModelById(...providerId...)` + `assertSelectedClaudeAnthropicModel()` |
| P0-13-C | `low` 请求使用 `/messages`，body 中 `model=claude-sonnet-4` 且包含用户 marker                     | 证明请求走 Anthropic Messages transport，并且 prompt 没丢                 | `assertUpstreamRequestCapture`、`assertClaudeAnthropicRequest`                               |
| P0-13-D | `low` 请求写入 `thinking.type=enabled`、`thinking.budget_tokens=4000`、`output_config.effort=low` | 证明 low 档位映射到正确 provider-visible 字段                             | `assertClaudeAnthropicRequest("low")`                                                        |
| P0-13-E | `low` 请求没有误写 `reasoning_effort`、`extra_body` 或 `chat_template_kwargs`                     | 证明 Anthropic 合同不被 OpenAI-compatible 字段污染                        | `assertClaudeAnthropicRequest("low")`                                                        |
| P0-13-F | `xhigh` 请求仍使用同一 provider/model，且 body 包含第二个用户 marker                              | 证明同一 session completed 后切思考档位只影响后续请求，不丢 provider 身份 | `assertUpstreamRequestCapture`、`assertClaudeAnthropicRequest`                               |
| P0-13-G | `xhigh` 请求写入 `thinking.budget_tokens=32000`、`output_config.effort=xhigh`                     | 证明 xhigh 深度真实覆盖上一轮 low                                         | `assertClaudeAnthropicRequest("xhigh")`                                                      |
| P0-13-H | 两轮 assistant 回复可见，完成后 `idle && queue=0`                                                 | 证明 replay 响应被 UI 正确消费，未残留 busy 或 queue                      | `waitForAssistantMessageContaining`、`waitForChatState`                                      |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- `low` 与 `xhigh` 两个主请求各有一条 `main` synthetic fixture，matcher 分别包含 `E2E_CLAUDE_ANTHROPIC_REASONING_LOW` 和 `E2E_CLAUDE_ANTHROPIC_REASONING_XHIGH`。
- 主响应使用 Anthropic Messages SSE 形状，避免用 OpenAI Chat Completions SSE 快捷响应污染 transport 语义。
- 正式 replay 由 spec 自己启动 case-local replay server，并只加载 `common.json` 和本 case fixture。

### 实际验证结论

2026-07-02 已完成新增和正式 replay 验证：

- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-claude-anthropic-reasoning-budget.test.ts`
  - 结果：通过。
  - 备注：`claude-anthropic-reasoning-budget-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=./test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-claude-anthropic-reasoning-budget.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/conversation-session/models/conversation-session-claude-anthropic-reasoning-budget.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-150003-655/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-13-A 到 P0-13-H 均由正式 spec 断言覆盖；`low` 请求体实际包含 `thinking.type=enabled`、`thinking.budget_tokens=4000`、`output_config.effort=low`，`xhigh` 请求体实际包含 `thinking.budget_tokens=32000`、`output_config.effort=xhigh`，两轮均未误写 OpenAI-compatible 或 GLM 专属字段，最终均回到 `idle` 且 `queueCount=0`。

P0-13 已满足当前目标中的“详细描述、实际验证、转正后重新确认”要求。该 case 已在正式路径；Docker 准入受网络问题影响暂不执行。

## P0-14: GPT OpenAI-compatible reasoning_effort 请求字段

### Case 定义

| 字段             | 内容                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I17`                                                                                                                               |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-gpt-openai-compatible-reasoning-effort.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-gpt-openai-compatible-reasoning-effort.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-gpt-openai-compatible-reasoning-effort.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                                        |

### 测试场景

用户在桌面端本地默认 workspace 中添加一个 case-local custom OpenAI-compatible provider，目标模型为 `gpt-5`，Base URL 指向本 case 自己启动的本地 replay server，API Key 使用 E2E dummy key。用户从聊天框模型列表选择该 provider 下的模型，先选择 `low` 思考档位并发送普通文本；首轮完成后，用户将思考档位切到 `xhigh`，再发送第二条普通文本。

这条 case 验证 GPT 系模型在 OpenAI-compatible Chat Completions transport 下只使用顶层 `reasoning_effort` 表达思考强度。它不覆盖 DeepSeek V4 的顶层 `thinking.type`、GLM-5.2 的 `reasoning_effort=none` 或 Claude 的 `thinking/output_config`，不验证真实 OpenAI 或兼容供应商线上服务可用性。

### 验证条目

| 编号    | 验证项                                                                                                              | 有效性说明                                               | 当前断言位置                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| P0-14-A | 新增 provider 被保存为 OpenAI-compatible / Chat Completions 格式，且包含 `gpt-5` 模型                               | 证明 case 前置供应商事实正确                             | `createCustomGptOpenAiProvider()`                                   |
| P0-14-B | 聊天框模型列表能按新增 provider 身份选择 `gpt-5`                                                                    | 证明模型选择没有退化成裸模型名                           | `selectUpstreamProviderModelById`、`assertSelectedGptOpenAiModel()` |
| P0-14-C | `low` 请求 path 使用 `/chat/completions`，body 中 `model=gpt-5` 且包含用户 marker                                   | 证明请求走 OpenAI-compatible transport，并且 prompt 没丢 | `assertUpstreamRequestCapture`、`assertGptOpenAiRequest("low")`     |
| P0-14-D | `low` 请求只写入 `reasoning_effort=low`，不写入 `thinking`、`output_config`、`extra_body` 或 `chat_template_kwargs` | 证明 GPT 合同不被相邻 provider 字段污染                  | `assertGptOpenAiRequest("low")`                                     |
| P0-14-E | 切到 `xhigh` 后第二轮请求写入 `reasoning_effort=xhigh`，且仍不写入相邻 provider 字段                                | 证明思考档位切换真实覆盖上一轮 low 且不串 provider 语义  | `assertGptOpenAiRequest("xhigh")`                                   |
| P0-14-F | 两轮 assistant 回复可见，完成后 `idle && queue=0`                                                                   | 证明 replay 响应被 UI 正确消费，未残留 busy 或 queue     | `waitForAssistantMessageContaining`、`waitForChatState`             |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- `low` 与 `xhigh` 两个主请求各有一条 `main` synthetic fixture，matcher 分别包含 `E2E_GPT_OPENAI_REASONING_LOW` 和 `E2E_GPT_OPENAI_REASONING_XHIGH`。
- 主响应使用 OpenAI Chat Completions SSE 形状，避免用 Anthropic Messages SSE 快捷响应污染 transport 语义。
- 正式 replay 由 spec 自己启动 case-local replay server，并只加载 `common.json` 和本 case fixture。

### 实际验证结论

2026-07-02 已完成新增和正式 replay 验证：

- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-gpt-openai-compatible-reasoning-effort.test.ts`
  - 结果：通过。
  - 备注：`gpt-openai-compatible-reasoning-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=./test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-gpt-openai-compatible-reasoning-effort.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/conversation-session/models/conversation-session-gpt-openai-compatible-reasoning-effort.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-150414-009/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-14-A 到 P0-14-F 均由正式 spec 断言覆盖；`low` 请求体实际包含 `reasoning_effort=low`，`xhigh` 请求体实际包含 `reasoning_effort=xhigh`，两轮均未误写 DeepSeek、GLM 或 Claude 专属字段，最终均回到 `idle` 且 `queueCount=0`。

P0-14 已满足当前目标中的“详细描述、实际验证、转正后重新确认”要求。该 case 已在正式路径；Docker 准入受网络问题影响暂不执行。

## P0-15: Opus 4.7 Anthropic Messages adaptive thinking 请求字段

### Case 定义

| 字段             | 内容                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I18`                                                                                                                            |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-opus47-anthropic-adaptive-reasoning.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-opus47-anthropic-adaptive-reasoning.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-opus47-anthropic-adaptive-reasoning.json` |
| 当前状态         | 已转正，正式路径 replay case                                                                                                     |

### 测试场景

用户在桌面端本地默认 workspace 中添加一个 case-local custom Anthropic Messages provider，目标模型为 `claude-opus-4-7`，Base URL 指向本 case 自己启动的本地 replay server，API Key 使用 E2E dummy key。用户从聊天框模型列表选择该 provider 下的模型，先选择 `medium` 思考档位并发送普通文本；首轮完成后，用户将思考档位切到 `max`，再发送第二条普通文本。

这条 case 验证 Opus 4.7 这类 adaptive thinking 模型不会沿用 Sonnet fixed budget 合同。Anthropic Messages 请求只应包含 `thinking.type=adaptive` 和 `output_config.effort`，不应生成 `thinking.budget_tokens`。它不覆盖 OpenAI-compatible 的 `reasoning_effort`、DeepSeek V4 的顶层 `thinking.type` 或 GLM-5.2 的 `reasoning_effort=none`，不验证真实 Anthropic 线上服务可用性。

### 验证条目

| 编号    | 验证项                                                                                                                | 有效性说明                                                          | 当前断言位置                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P0-15-A | 新增 provider 被保存为 Anthropic Messages 格式，且包含 `claude-opus-4-7` 模型                                         | 证明 case 前置供应商事实正确                                        | `createCustomOpus47AnthropicProvider()`                                   |
| P0-15-B | 聊天框模型列表能按新增 provider 身份选择 `claude-opus-4-7`                                                            | 证明模型选择没有退化成裸模型名                                      | `selectUpstreamProviderModelById`、`assertSelectedOpus47AnthropicModel()` |
| P0-15-C | `medium` 请求 path 使用 `/messages`，body 中 `model=claude-opus-4-7` 且包含用户 marker                                | 证明请求走 Anthropic Messages transport，并且 prompt 没丢           | `assertUpstreamRequestCapture`、`assertOpus47AnthropicRequest("medium")`  |
| P0-15-D | `medium` 请求写入 `thinking.type=adaptive`、`output_config.effort=medium`，且不写入 `thinking.budget_tokens`          | 证明 medium 档位使用 adaptive thinking 合同                         | `assertOpus47AnthropicRequest("medium")`                                  |
| P0-15-E | 切到 `max` 后第二轮请求写入 `thinking.type=adaptive`、`output_config.effort=max`，且仍不写入 `thinking.budget_tokens` | 证明思考档位切换真实覆盖上一轮 medium，且不会串到 fixed budget 合同 | `assertOpus47AnthropicRequest("max")`                                     |
| P0-15-F | 两轮请求均不写入 `reasoning_effort`、`extra_body` 或 `chat_template_kwargs`                                           | 证明 Anthropic adaptive 合同不被相邻 provider 字段污染              | `assertOpus47AnthropicRequest(...)`                                       |
| P0-15-G | 两轮 assistant 回复可见，完成后 `idle && queue=0`                                                                     | 证明 replay 响应被 UI 正确消费，未残留 busy 或 queue                | `waitForAssistantMessageContaining`、`waitForChatState`                   |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定标题，不属于本 case 产品语义。
- `medium` 与 `max` 两个主请求各有一条 `main` synthetic fixture，matcher 分别包含 `E2E_OPUS47_ANTHROPIC_REASONING_MEDIUM` 和 `E2E_OPUS47_ANTHROPIC_REASONING_MAX`。
- 主响应使用 Anthropic Messages SSE 形状，避免用 OpenAI Chat Completions SSE 快捷响应污染 transport 语义。
- 正式 replay 由 spec 自己启动 case-local replay server，并只加载 `common.json` 和本 case fixture。

### 实际验证结论

2026-07-02 已完成新增和正式 replay 验证：

- `pnpm --filter @zcode/desktop typecheck:e2e`
  - 结果：通过。
- `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-opus47-anthropic-adaptive-reasoning.test.ts`
  - 结果：通过。
  - 备注：`opus47-anthropic-adaptive-reasoning-title` 没有 E2E marker，符合标题生成 common fixture 的非业务语义。
- `E2E_PROVIDER_REPLAY_FIXTURE_PATH=./test/e2e/fixtures/upstream/common.json,./test/e2e/fixtures/upstream/conversation-session/conversation-session-opus47-anthropic-adaptive-reasoning.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/conversation-session/models/conversation-session-opus47-anthropic-adaptive-reasoning.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260702-150714-538/summary.md`。
  - 结论：严格只加载 common + case-local fixture 时，P0-15-A 到 P0-15-G 均由正式 spec 断言覆盖；`medium` 请求体实际包含 `thinking.type=adaptive`、`output_config.effort=medium`，`max` 请求体实际包含 `thinking.type=adaptive`、`output_config.effort=max`，两轮均未写入 `thinking.budget_tokens`，也未误写 OpenAI-compatible、DeepSeek 或 GLM 专属字段，最终均回到 `idle` 且 `queueCount=0`。

P0-15 已满足当前目标中的“详细描述、实际验证、转正后重新确认”要求。该 case 已在正式路径；Docker 准入受网络问题影响暂不执行。

## P0-16: 同名模型草稿默认模型跨 provider 身份不回弹

### Case 定义

| 字段             | 内容                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I22`                                                                                                                           |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-same-model-draft-provider-identity.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-same-model-draft-provider-identity.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-same-model-draft-provider-identity.json` |
| 当前状态         | manual-review pending 候选 case                                                                                                 |

### 测试场景

用户在桌面端本地默认 workspace 中分别对 `glm-5.2` 与 `deepseek-v4-flash` 构造 primary/alternate 两个 custom provider，同一模型的两个 provider 使用不同 Base URL。每个模型族先用 primary provider 完成一个会话；随后点击新建任务进入空草稿，在聊天框模型列表选择 alternate provider 下同名模型，并发送一条普通文本。

这条 case 钉住 workspace default 回包边界和真实请求路由：草稿默认模型写入后，toolbar `currentValue`、再次打开的模型菜单选中态和 workspace draft config 必须保留 alternate provider id + 当前模型；发送后的 provider 请求 URL 也必须命中 alternate provider Base URL，不能因为同 workspace 仍有 active session 就回弹到上一个 provider。它不覆盖 queue、stop、edit/fork、remote workspace 或真实 BigModel/Z.AI/DeepSeek 服务可用性。

### 验证条目

| 编号    | 验证项                                                                                                                        | 有效性说明                                                                                                            | 当前断言位置                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| P0-16-A | `glm-5.2` 与 `deepseek-v4-flash` 各自都有 primary/alternate 两个 case-local provider，且同模型两个 provider 使用不同 Base URL | 复现同 modelId 跨 provider 的触发条件，并让请求 URL 能区分供应商                                                      | `createScenarioProviders()`              |
| P0-16-B | 每个模型族先用 primary provider 完成首轮并留下 active session                                                                 | 复现 workspace state builder 会看到 active session 的状态                                                             | `runSameModelProviderIdentityScenario()` |
| P0-16-C | 新建空草稿后选择 alternate provider 下同名模型                                                                                | 覆盖真实聊天框模型菜单选择路径                                                                                        | `selectUpstreamProviderModelById()`      |
| P0-16-D | toolbar `data-model-current-value` 保留 alternate provider/model 编码                                                         | 证明 UI 不按裸 modelId 回显到旧 provider                                                                              | `assertSelectedProviderModel()`          |
| P0-16-E | 再次打开聊天框模型菜单时 alternate provider 分组和同名模型 item 仍是选中态                                                    | 直接覆盖用户截图中的“模型列表显示上一个模型供应商”问题                                                                | `assertModelMenuSelectedProvider()`      |
| P0-16-F | 同一项目空草稿的 V4 selection 与模型控件均保留 alternate provider/model 身份                                                  | V4 不再写旧 workspace configOptions；Recent 只由 accepted Submission 更新，发送前检查当前草稿，发送后另验真实请求 URL | `assertDraftConfigModelValue()`          |
| P0-16-G | alternate provider 选择后发送普通文本，真实请求 URL 命中 alternate provider Base URL                                          | 证明不只是 UI 显示正确，runtime 请求也切到了目标供应商                                                                | `assertProviderRequestUrl()`             |

### Fixture 合同

- 标题生成请求是 `common` synthetic fixture，只用于稳定会话标题，不属于本 case 产品语义。
- `glm-5.2` 与 `deepseek-v4-flash` 各有 primary seed 和 alternate send 两类 `main` synthetic fixture，matcher 分别包含稳定 `E2E_*_PRIMARY` / `E2E_*_ALTERNATE` marker。
- alternate 草稿切换本身不应产生 provider 请求；切换后的发送请求是真实路由断言入口，必须校验 `record.url` 命中 alternate provider Base URL。
- 当前 spec 放在 `manual-review/pending`，待人工 review 后再用 promotion 流程转正。

## 2026-07-22 I62 / I64 规划确认

用户确认按审计优先级依次补齐 bugfix E2E，并沿用 catalog 已接受的产品语义与剪枝。本批只处理
I62 与 I64，两个 case 共享 custom OpenAI-compatible/replay helper，但不合并成一个场景：前者是
modelId 编码不变量，后者是 provider registry 冷启动时序不变量。

```text
I62: 选择 OpenRouter modelId(:free)
       -> toolbar currentValue
       -> V4 draft intent
       -> provider request.model(:free)

I64: Personal Config(custom GLM)
       -> Host Process Registry ready
       -> Worker Process Registry ready
       -> V4 createSession(custom GLM)
       -> first prewarm projection / toolbar / request = custom GLM
                                      X no DeepSeek fallback preference write
```

剪枝保持如下：I62 只跑 desktop local 空草稿、单 custom OpenRouter provider、单次首发，不与 thought、
queue、fork、重启、remote、主题或 locale 叉乘；I64 只跑 desktop local `desktop-continuous` 冷重启草稿
预热，不重复设置页删除/禁用（I61）、已有 session 恢复（I40）或远端 shared-host 组合。I64 的协议调用
就绪门禁由 Process Registry focused 测试证明，Desktop E2E 补首个可观察投影、toolbar、localStorage
和真实 Provider 请求，不用 Renderer mock 伪造 Host/Worker 时序。

## P0-17: OpenRouter 含冒号 modelId 端到端保持完整

### Case 定义

| 字段             | 内容                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I62`                                                                                                                  |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-openrouter-model-id-colon.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-openrouter-model-id-colon.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-openrouter-model-id-colon.json` |
| 当前状态         | manual-review pending 候选 case                                                                                        |

### 测试场景

用户在桌面端本地默认 workspace 中新增一个 case-local custom OpenRouter provider，模型 ID 固定为
`nvidia/nemotron-3-ultra-550b-a55b:free`，随后从聊天工具栏按 provider 身份选择该模型并首次发送普通
文本。`:` 是模型 ID 的一部分；只有 `$` 才能表达 ZCode configOptions variant 分隔语义。

### 验证条目

| 编号    | 验证项                                                                         | 有效性说明                                                                               |
| ------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| P0-17-A | 设置页保存的 provider/model 保留完整 `:free`                                   | 证明前置目录没有先截断 modelId                                                           |
| P0-17-B | toolbar `data-model-current-value` 等于 provider + 完整 modelId 的 shared 编码 | 证明用户选择和 renderer intent 未按 `:` 拆分                                             |
| P0-17-C | V4 draft intent 的 provider/model 为目标 provider + 完整 modelId               | 证明配置命令前的 renderer intent 未丢后缀；首发 barrier 与 request 再证明 Agent 权威收敛 |
| P0-17-D | 首发 `/chat/completions` request body 的 `model` 精确等于完整 modelId          | 证明 runtime/provider transport 最终收到同一模型身份                                     |
| P0-17-E | assistant 回复可见且 pane 回到不可停止状态                                     | 证明 replay 响应被 UI 完整消费                                                           |

### Fixture 合同

- 标题请求复用 `common.json`，不属于本 case 产品语义。
- 唯一 `main` synthetic fixture 以 `E2E_OPENROUTER_MODEL_ID_COLON` marker 严格匹配，请求 body 必须包含
  完整 modelId；响应只负责稳定返回 `upstream-e2e-ok`。
- spec 保留在 `manual-review/pending`，fixture manifest 的 `spec` 仍指向 canonical formal target。

### Pending replay 验证

2026-07-22 已完成 fixture check、E2E TypeScript 检查和真实 Electron replay。最终运行结果为 1 个 spec / 1
个 case passed；artifact 位于
`packages/desktop/.e2e-artifacts/desktop-e2e-20260722-133804-806/summary.md`。实际请求与 Agent telemetry
的模型名均为 `nvidia/nemotron-3-ultra-550b-a55b:free`。当前等待人工 review，尚未 promotion。

## P0-18: 草稿预热等待 process provider registry 就绪

### Case 定义

| 字段             | 内容                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `I64`                                                                                                                  |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-provider-registry-prewarm.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-provider-registry-prewarm.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-provider-registry-prewarm.json` |
| 当前状态         | manual-review pending 候选 case                                                                                        |

### 测试场景

先让版本化 Personal Config 与 Renderer 全局 last-selected 持有 case-local custom GLM-5.2，再完整冷重启
Desktop/Host/Worker。Host 和 Worker 各自从同一 Environment Config 初始化 Process Registry；草稿自动
预热的 V4 `createSession` 必须等待 Registry 就绪，不能依赖 Host 下发旧 Provider Snapshot。

### 验证条目

| 编号    | 验证项                                                                                                | 有效性说明                                                |
| ------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| P0-18-A | 冷重启前版本化 Personal Config 包含 custom GLM                                                        | Host 与 Worker 由同一 Environment 事实独立初始化 Registry |
| P0-18-B | 冷重启后首个可观察 V4 draft config 为 `source=prewarm-projection` 且 provider/model 精确为 custom GLM | 证明预热没有先用 runtime 缺省 DeepSeek 建 session         |
| P0-18-C | toolbar currentValue 保持 custom provider + GLM-5.2                                                   | 证明 UI 权威选择没有发生 fallback 回弹                    |
| P0-18-D | renderer 原子 last-selected 元组仍为 custom GLM                                                       | 证明暂态 DeepSeek 没有覆盖用户全局偏好                    |
| P0-18-E | 首发请求命中 case-local provider，request body `model=GLM-5.2`                                        | 证明预热 session 的真实 runtime provider/model 正确       |
| P0-18-F | assistant 回复可见且 pane 回到不可停止状态                                                            | 证明冷启动后的会话链路完整收口                            |

### Fixture 合同

- 标题请求复用 `common.json`，不属于本 case 产品语义。
- 唯一 `main` synthetic fixture 以 `E2E_PROVIDER_REGISTRY_PREWARM` marker 严格匹配，并要求 request body
  包含 `GLM-5.2`；响应只负责稳定返回 `upstream-e2e-ok`。
- Process Registry focused 测试保留初始化屏障证明；本 spec 不用 UI mock 代替该层证据。
- spec 保留在 `manual-review/pending`，人工确认实际冷启动行为和 artifact 后再 promotion。

### Pending replay 验证

2026-07-22 已完成 fixture check、E2E TypeScript 检查和真实 Electron 冷重启 replay。最终运行结果为 1 个
spec / 1 个 case passed；artifact 位于
`packages/desktop/.e2e-artifacts/desktop-e2e-20260722-133902-332/summary.md`。运行日志中的实际模型身份为
`e2e-provider-registry-prewarm/GLM-5.2`，首发请求和 UI 收口断言均通过。当前等待人工 review，尚未
promotion。

## P0-19: 普通流式响应中切模型不改变当前请求的用量归属

### Case 定义

| 字段             | 内容                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Catalog          | `N16`                                                                                                                   |
| Spec             | `packages/desktop/test/e2e/conversation-session/models/conversation-session-running-model-switch-usage.test.ts`                |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-running-model-switch-usage.json`    |
| Provider fixture | `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-running-model-switch-usage.json` |
| 当前状态         | manual-review pending 回归 case                                                                                         |

### 测试场景

桌面端本地普通对话使用 primary 模型发起请求。case-local controlled stream 在 provider 已收到请求后保留
一个确定性窗口；用户在 response 尚未结束时把当前 session 切换为 secondary 模型，不发送第二条消息。
旧请求随后返回固定 usage，E2E 直接按当前 session 查询 Agent SQLite 的 `model_usage`。

状态与时序合同：

```text
primary request started ── SSE running ─────────────── primary response + usage
                              │                                      │
                              └── session default -> secondary       └── usage.model = primary
```

### 验证条目

| 编号    | 验证项                                                                                   | 有效性说明                                                          |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P0-19-A | 切模前 capture 已出现 primary 主请求，且 session 仍为 streaming                          | 证明切换命中真实 in-flight provider 窗口，不是 UI 尾部动画          |
| P0-19-B | streaming 中模型选择成功变为 secondary                                                   | 证明 session 可变默认配置确实在旧请求完成前更新                     |
| P0-19-C | 完成后的 provider capture 仍使用 primary                                                 | 证明 in-flight 请求模型身份不可变                                   |
| P0-19-D | 当前 session 的 `main_turn` usage token 等于 fixture 固定值，provider/model 均为 primary | 证明用量事实绑定实际执行模型，没有读取请求结束时的 session 默认模型 |

### 剪枝与 Fixture 合同

- 唯一 `main` synthetic fixture 使用 `controlled-stream`，原因是线上模型速度不足以稳定制造切模窗口。
- 不发送 queued prompt；后续请求读取 secondary 的语义已由 `N02/MQ` 覆盖。
- compact 与闲时任务有各自 execution model 快照，不与本普通主对话代表 case 叉乘。
- stop/cancel/error 没有正数 usage 的场景由 focused core tests 覆盖；remote/mobile 只改变 delivery/recovery，
  不改变 `usage.model === request.executionModel` 不变量。
- spec 保留在 `manual-review/pending`；fixture manifest 的 `spec` 指向 canonical formal target。

### 复现与修复验证

2026-08-05 在修复前执行严格 replay，provider capture 证明请求实际使用
`e2e-upstream/deepseek-v4-flash`，但 SQLite 中同一 session 的 `main_turn` usage 被记录成切换后的
`e2e-upstream/deepseek-v4-pro`，稳定复现了错记问题；artifact 位于
`packages/desktop/.e2e-artifacts/desktop-e2e-20260804-165513-717/summary.md`。

修复后以相同 fixture 重跑，1 个 spec / 1 个 case passed，usage 重新归属
`e2e-upstream/deepseek-v4-flash`，固定 token 总数为 `132`；artifact 位于
`packages/desktop/.e2e-artifacts/desktop-e2e-20260804-170040-645/summary.md`。当前仍保留在
manual-review pending，等待人工 review 后再 promotion。

## P0-20: 模型供应商无模型状态与新增提示

MP-UI-01 同时验证双列内容自适应布局：临时 DOM 高度探针分别模拟导航/详情较高内容，在宽窄窗口断言最小 36rem、两列等高、内部不滚动及滚轮带动外层 main。探针只验证 CSS 几何，不代表 provider API 数据验证，移除后继续原有流程。

MR !2618 CR-01：MP-UI-06 使用真实模型保存成功反馈，分别注入长导航/长详情探针，在 1280×600、600×500 窗口顶部/中部/底部断言反馈完整落在 main 可视区和详情列内。反馈状态/超时不变；成功与失败共享同一定位容器。

### Case 定义

| 字段             | 内容                                                            |
| ---------------- | --------------------------------------------------------------- |
| Catalog          | `MP-UI-01`、`MP-UI-02`                                          |
| Spec             | `packages/desktop/test/e2e/settings/general/settings-ui-polish.test.ts` |
| Provider fixture | 无；只 seed 本地设置和 provider 文件，不发送模型请求            |
| 当前状态         | 已人工评审并转正                                                |

### 测试场景

第一段从新增自定义供应商入口验证 footer：提示与 Info 图标在左，添加按钮在右，二者上方有语义分割线；
未添加模型时按钮保持禁用。第二段 seed 一个只有单模型的自定义供应商，通过真实设置页删除最后一个模型，
验证编辑器保留虚线空状态与 Add Model 操作。Coding Plan 的模型由登录态自动同步、设置页不可手工删除，
其 zero-model 连接判定由 resolver 单测覆盖，不伪造不存在的 E2E 操作。

### 验证条目

| 编号    | 验证项                                                 | 有效性说明                     |
| ------- | ------------------------------------------------------ | ------------------------------ |
| P0-20-A | Add provider footer 有 `border-t`、Info 图标和提醒文案 | 证明新增提示走真实设置页       |
| P0-20-B | 提示在按钮左侧且空模型时按钮禁用                       | 证明布局与已有校验状态一致     |
| P0-20-C | 自定义供应商可通过真实删除按钮删掉最后一个模型         | 证明空状态来自真实编辑链路     |
| P0-20-D | dashed empty hint 与 Add Model 同时可见                | 证明用户仍有恢复配置的真实入口 |

### 剪枝

- provider 请求、聊天首发与持久化由 P0-02 覆盖，本 case 不重复发请求。
- Z.ai/BigModel、Start/Coding 的等价 resolver 分支由单元测试做 pairwise 覆盖；Coding Plan 列表由服务端
  同步且只读，不把自定义供应商的删除操作错误套到套餐页。
- theme、locale 与 mobile 不改变连接判定；语义 token、双语言文案和响应式 class 由单元测试覆盖。

### 实际验证

- 转正后正式运行 ID：`desktop-e2e-20260819044246639-p7031-0eaf856fbfb1eeae`
- 正式路径结果：不设置 manual-review 开关时 3 个 case 全部通过。
- 正式 Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819044246639-p7031-0eaf856fbfb1eeae/summary.md`。
- 运行 ID：`desktop-e2e-20260819042607776-p64629-52e741b6f1da02f5`
- 结果：3 个 case 全部通过。
- Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819042607776-p64629-52e741b6f1da02f5/summary.md`。
