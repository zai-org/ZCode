# Conversation Session E2E Development Workflow

用例目录与场景选择遵循 [E2E 业务场景目录规格](e2e-business-scenarios.md)。

本文定义 conversation session 从“覆盖面枚举”到“正式 E2E”的开发流水线。目标是让新增 case 能按固定步骤推进，避免在转正时临时修改共享 replay fixture、反复等待长 E2E 才发现数据不匹配。

列表 SQLite 夹具应在 Host 启动前写入。若用例需先初始化 schema，再在隔离目录播种，播种后应完整重启 Electron/Host；只刷新 renderer 不会让已有 Controller 的 source snapshot 失效。不得用延时、重复打开面板或直接修改 Controller 投影代替冷启动读盘。

`controlled-stream` 可用 `response.releaseAfterChunks` 指定一个 chunk 边界，或递增的边界数组。每个边界由测试完成对应 UI 操作后单独释放；一次释放不能越过后续观察点。工具参数流需要先输出真实正文，越过 Provider 的 retry-safe prelude，才能验证桌面流式预览。此机制不适用于 recorded/fault stream，也不改变业务时钟或重试策略。

## 会话控制工具的动态目标引用（SCT，2026-10-23）

SCT case-local synthetic provider fixture 可使用 `{{appControlTargetRef}}`。回放器只从当前模型
请求中的真实 tool_result 结构读取完整 App session ref；提示中的 `E2E_SCT03_TARGET_SESSION_ID`
或 `E2E_SCT07_TARGET_SESSION_ID` 只选择目标 ID，不生成 source、workspaceIdentity 或项目授权字段。
SCT07 的显式项目过滤使用 `{{appControlTargetProjectRef}}`，只能取真实 session ref 自带的 project。
没有真实 ref 或项目时回放明确失败。
生命周期用例的 `{{appControlResult:<tool_call_id>.<field>}}` 只解析真实、成功的 SCT tool_result，
字段限于 session、operation、项目引用、消息 ID、分页游标和 summary.executionId；缺失时回放失败。
`messages.firstAssistant.id` 按真实返回的 role 定位第一条助手消息，不假设内部提示的条数或消息位置。
创建、分叉、等待和中断必须使用上一步真实回执，不从用户 marker 构造身份。
该变量只替换模型返回的工具参数；工具 schema、权限、Host 绑定、会话命令和 UI 导航仍走产品路径。
不得注入导航事件、直接写 store 或构造一个 fake opened 结果来满足 SCT03。

独立 CLI 的进程 E2E 由 bootstrap 现有 Vitest 入口收集，定向执行：

```bash
pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/session-control/standalone-process.e2e.test.ts
```

该用例启动生产 `packages/cli/src/main.ts` 子进程，本地受控 Provider 编排 ToolSearch 与实际工具调用；
进程正常退出后重开 SQLite 核对全部 8 个工具和目标历史。失败时保留 stdout、stderr、Provider capture，
不使用个人配置、真实模型凭据或 App Host。依赖包 dist 使用本轮构建产物。

SCT08 的独立 TUI 审批用例同样由 bootstrap Vitest 收集：

```bash
pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run tests/session-control/standalone-tui-approval.e2e.test.ts
```

它在伪终端中启动生产 `zcode tui`，用终端模拟器还原画面后再断言，按键经伪终端写入。
TUI 走 `@zcode/tui` 的 dist，改动 TUI 或 i18n 后先重建这两个包。失败时保留 screen.txt、pty.txt 和 Provider capture。

## 两条流水线

### 覆盖面生成

覆盖面生成回答“需要测什么”：

1. 从功能 spec、现有 case catalog 和 coverage matrix 中抽出状态维度。
2. 使用 `feature-boundary-planner` skill 和 formal-proof 口径辅助枚举排列组合。
3. 与产品或开发者对话剪枝，确认哪些组合是 accepted、undefined 或 pruned。
4. 产出或更新 `docs/conversation-session-case-catalog.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md` 和相关 decision 文档。

这一层只产出文档和待覆盖 case，不直接生成正式 E2E。

### E2E 落地

E2E 落地回答“怎么稳定测”：

1. 为 accepted case 编写或生成 `manual-review/pending` spec。
2. 运行 manual/capture，自动执行用户路径并留下 UI、network、log、session artifact。
3. 人工 review 产品表现，确认 case 语义。
4. 整理 provider replay fixture 和文件 fixture，形成正式测试合同。
5. 从场景目录移除 `manual-review/pending`，保留 `packages/desktop/test/e2e/conversation-session/<scenario>/`。
6. 跑本地 default replay。
7. 需要进入 Docker suite 时，先单 spec 跑 `replay-isolated`，通过后再登记进 Docker preset。
8. 常规 Docker 回归按 suite 批量运行，复用同一个镜像、容器和 WDIO 构建入口。
9. MR 与 GitLab Web pipeline 通过手动 optional job 跑正式目录下的 default replay。入口复用 `ZCODE_E2E_SPEC=./test/e2e/conversation-session/**/*.test.ts` 等递归 glob，配合 `ZCODE_E2E_EXCLUDE_SPEC=./test/e2e/**/manual-review/**/*.test.ts` 排除候选。分片与 MR 增量选择在展开后同样排除候选，场景目录不改变准入状态。
10. Docker CI 只收已经自动化稳定的 suite。

默认 Desktop 全量入口按任意层级的 `manual-review` 目录统一排除候选，不能只枚举已知领域，
否则新增 bots/settings/feedback 目录会被单进程全量误收。显式 spec 或 manual-review 模式仍可
运行候选；默认单进程与分片的正式集合必须一致，不把缺少 capture 环境的候选记为正式回归失败。

## 共享初始化合同

ChromeDriver 必须自己以 `--port=0` 绑定端口，启动器从该子进程的就绪消息取得实际端口后再连接。
不要先探测并释放空闲端口，再交给另一个进程绑定；2026-10-19 连续回放已出现驱动绑定失败、
随后 WDIO 仍报启动成功的现场。每个 worker 持有自己的驱动，冷重启 Electron 时复用，
worker 结束或启动失败时回收。启动上限只用于报告挂起，不增加重试或固定等待。

数据目录冷重启用例的临时目录放在隔离 HOME 内。spec 的 `after` 只保存证据并交还清理所有权；
不能删除仍被新 Main/Host 使用的数据目录。runner 在进程退出后统一删除 HOME，失败时保留现场。
R3A-DEV-06-desktop-authority 已复现断言全部通过、随后 `rm` 与运行中写入竞争导致 `ENOTEMPTY`；
修复删除这次提前清理，不增加删除重试或等待。

Lexical 输入 helper 必须遵守真实 DOM 的可编辑状态。冷恢复时 pane 已绑定任务、E2E bridge 已挂载，不代表 Composer 已开放输入；先等 `contenteditable=true`，再写入。不能通过 bridge 越过禁用态，也不能在草稿恢复覆盖输入后再次写入补偿。该顺序由 helper 回归测试和原生 Fork 冷恢复诊断共同验证。

手机 shared-host 的测试 Web 服务器在首轮依赖预构建中显式包含 `@pierre/diffs/worker/worker.js`。
冷缓存现场曾在长按期间才发现该 Worker，Vite 发送 full-reload 并打断操作。
该配置仅属于 E2E 启动入口；回归同时记录导航来源，并拒绝用例期间的 Vite full-reload，
不能靠预热旧缓存、延时或重复长按让用例通过。

使用 loopback 账号/relay fixture 的手机用例，新建 BrowserContext 时必须通过
`seedMobileFixtureLogin` 同步播种与 Desktop 相同的合成账号。只写 Desktop credentials 文件
会让手机停在登录页，无法验证后续恢复；无 loopback fixture 时不播种，不绕过真实登录门禁。

响应式截图用例恢复视口后，必须等实际视口尺寸与被测弹窗的 CSS 动画均收口，再进行原生点击。
Start Plan 诊断已证明 `max-width` 仍在过渡时按钮会移动，点击返回成功却未命中；
测试等待浏览器动画状态，不增加固定暂停、不重复点击，也不关闭产品动画。

### 正式回放契约维护（2026-10-15）

正式回放修复遵循当前可观察合同：模型 Recent 夹具按当前项目的 Composer scope 读写
`zcode-composer-recent:v2`，重启同时保留 scope 映射，不再播种旧 workspace 键。
项目新建草稿的持久化检查使用 `zcode-v4-composer-project-drafts:v1`，核对 client/host/project
及 `__draft__` 正文；不能继续只查正式 session 使用的 workspace 草稿 key。
需要验证新草稿继承模型时，首轮和后续草稿必须显式从同一个项目创建；模型断言读取当前
Composer，不读取 legacy 初始化诊断。非流式标题请求必须有对应 JSON fixture，不能以
主流程断言通过代替完整的请求回放检查。
后台 Bash 从详情文件入口读取实际输出路径；前台尚未返回结果时，只接受当前 session/tool
对应的唯一实际输出文件，不把旧数据目录当成固定输出根。内置插件卸载完成以
`restorableBuiltins` 出现目标为准，不能以本来就不包含内置插件的 `installedPlugins` 判定。

```text
当前项目 scope → Recent 夹具 → 退出屏障 → 重启恢复 → Composer / 请求断言
真实卸载操作 → 服务更新 restorableBuiltins → 测试继续检查清理与重启
```

界面回放使用可见徽标文本、当前帮助菜单顺序和直接编辑器入口；任务建立后重新打开文件标签。
项目删除的冷启动验证等待项目列表加载，不要求启动时激活某个项目。文件树回放验证右侧文件
标签、关闭卸载、刷新和 watcher，不再要求已经移除的左侧文件面板动画。

插件设置入口先完成首次职业引导退出，再等待全局设置按钮；不要求返回固定项目。状态面板的自动布局可能以胶囊显示，即使 `data-state` 为 expanded，目录项仍可能隐藏；应通过可见的“展开状态”入口打开目录。C02 自动消费以受控流固定入队边界：观察到首轮正文后入队，验证 queue=1 后放行首轮，再验证第二轮请求、可见消息与队列清空。

插件夹具显式创建所需 CLI 用户配置，不能依赖 Provider Registry 初始化写入该文件。市场搜索限定当前来源分段，个人 fixture 必须先选择个人来源；配置修改通过管理页详情进行，市场浏览详情只展示信息。行内推理档位编辑通过全选输入完成，避免 WebDriver clear 引发失焦提交并卸载编辑框。

插件夹具从 `import.meta.url` 解析本地路径时使用 `fileURLToPath`，避免带空格的 checkout 被当成含 `%20` 的目录。管理列表通过 `plugin-store-card` 打开详情；不要选择行内第一个 `button`，它可能是卸载菜单或开关。

验证插件 MCP 调用时，先检查真实请求中的工具声明，再使用 `waitForToolCallBlockByToolName` 观察界面。快速回放完成后工作记录会自动折叠；只反复查询未展开的 DOM 会把已经执行成功的工具误判为缺失。共享等待器会展开记录，并保留捕获到的工具卡片快照。

TUI 的输入与 Enter 分开执行：使用终端粘贴协议并等待本次输入内容绘制，不能把动画产生的新帧当成输入已完成。命令完成等待其明确回执；终端增量绘制可能只输出占位文字的变化后缀，不要求完整占位文字重复出现。

Provider 允许合并相邻 system 消息；incoming reminder 在 wire 中校验全文、角色和唯一性，不要求独占 system text block。user 的 system-reminder 包装仍要求完整独立 block 和成对标签。

项目新建 helper 仅等待主 pane 的唯一空草稿；辅助对话的输入框可以共存，不计入主 pane 的切换判定。

营销触达属于全局应用界面，隔离 fixture 预置已完成职业引导的账号，防止启动弹窗抢占引导焦点；冷启动后等待应用设置入口就绪，不要求激活固定项目。窗口恢复到未选项目草稿时，固定 cwd 的等待会错误终止 beforeEach，令整份营销用例无法继续。

- Coding Plan 数据面代理按当前 worker 的 spec 启动，位于上游回放网络配置之后、HOME 播种之前。混合批次包含 ToolSearch 时，只让 ToolSearch worker 使用自己的 capture proxy，不能关闭其他 worker 的账号模型回放。
- 需要受控流的账号用例保留真实 HTTPS Endpoint 与鉴权路径，由测试代理按精确 host/path 转发到本例 replay server。代理保留原请求地址证据，响应逐块转发；不以固定快速回复或固定延时模拟 running。

- 团队 Provider 共用 Provider ID，模型菜单项按完整团队连接身份分组；专项 helper 由夹具传入连接 key，不能仍用 `registry-provider:<id>` 定位团队行。空白 Composer 不保存未提交改选；跨任务或重启验证未提交选择时，保留非空文字草稿。
- 合并模型菜单的 Provider 列表是二级菜单。列表断言先打开 `composer-provider-trigger`，选择态读取 radio 的 `aria-checked`；选中 Provider 后回到模型列表再断言模型。不能把尚未展开的 Provider 列表当成候选缺失，也不能依赖旧分组的 `data-model-provider-selected`。

- Plugin mention 图标改由 CSS 装饰变量渲染后，读取 `--mention-image` 的实际 URL；不再查找已移除的子 `img`。商店试用会创建独立草稿，后续固定 cwd 用例须重新准备夹具项目。

- 测试应用产物必须独立于共享 `out`：使用写时复制（文件系统不支持时正常复制），不能硬链接。源构建被 `tsc -b` 原地覆盖或单个隔离副本被测试写入时，其他回放副本必须保持不变。类型检查后须重新执行 E2E 构建，不能复用被 TypeScript emit 覆盖的 Host 入口。

I68 专项必须显式提供四档 reasoning Option Spec 及请求协议映射；不再依赖退役的 Agent catalog 补全。模型编辑器的继承测试需移除通用 replay 的 `disabled` 精确覆盖，保留当前推荐配置，并在每次重新打开时显式展开高级区。

推理 Option Spec 的 `values` 按低到高排列，末项是主动切换模型时的默认最高档；I20 夹具显式提供其断言的 `off/low/high/max`，不能沿用旧的默认值置首规则。官方插件只读 profile 的覆盖测试使用当前 `documents:visual-judge`，不再查找已退役的 `document-skills:judge`。

Subagent 保存后先关闭表单，再异步刷新列表。再次编辑须等行恢复 `role="button"`，不能只等行存在就点击仍在刷新、未绑定编辑事件的行。

正式设置用例以稳定身份匹配入口：I23/I24 从 BigModel Template 新建 Personal Provider，并按新实例 ID 核对 API Key 与模型水合，不查询已退役的 Family API Key 连接项。Subagent 作用域按 `data-plugin-scope-key` 选择 `user` 或目标 workspace key；显示名包含设备信息，不能用裸项目名判断身份。MCP 正式用例复用 V4 初始化，保留真实 Agent 协商和 wire 断言。

后台任务的 telemetry 采集按 case 重置 HTTP mock 与 ARMS 缓冲；不能复用跨 case 游标，否则未做 telemetry 断言的中间用例也会计入下一条的精确数量断言。

后台任务行的可见性使用浏览器原生 `checkVisibility`。V4 的 `display: contents` 祖先没有自己的布局盒，但不会隐藏子节点；不能逐层要求祖先拥有非零矩形，否则会把可见的 running/stop 控件误判为消失。

正式用例的准备数据必须满足当前产品契约，不能用降低断言、跳过用例或修改业务逻辑消除失败：

- 固定目录的文件、Hook 和冷恢复场景，通过项目的新建任务入口保持 cwd；全局新建任务仍验证独立目录，不把两种入口混用。
- 模型偏好必须声明在 fixture 的 `reasoningLevel.values` 中；验证请求思考参数的专项同时提供非空 Option Map，普通回放保持空映射。
- `/plan` 是 `app-slash:plan` 本地动作；正式 session 身份只要求非空且非 draft，不依赖 `sess_` 前缀。
- Markdown 选区通过结构化引用进入请求，验证 `<conversation_quote>` 中的来源路径和正文以及历史引用，不再要求旧 `# userselect` 包装。
- Bot 集成夹具使用项目仓库的 session 创建预留合同；ToolSearch 在真实请求事件到达时采集完整正文，并继续归档 Adapter 的原始 Model IO，不能把事后精简的内存事件统计当成消息正文。
- 设置页配置 Provider 时先让输入框失焦并核对连接字段落盘，再操作 API 格式菜单。格式是否已选中以菜单的 `data-state=checked` 为准；Personal overlay 缺省可能继承 Template 的协议格式，不能用旧 snapshot 默认值跳过切换。
- Fork 后 session 身份先切换，模型能力投影随后到达；先等目标能力集合就绪，再断言档位和真实请求，不能把切换瞬间的空集合当作最终能力。
- 批次失败、单场景通过时，先检查准备、清理和导航 owner 的稳定边界，不增加固定等待时间。权限等真实产品异常保留原断言并列为阻塞。

```text
case 的目录与模型要求 → 项目入口 / Provider fixture → 当前草稿就绪
                                                   ↓
                               真实用户操作 → wire / 持久化 / UI 断言
```

默认 `env` 回放 Provider 的准备步骤选择 `high`，其 Personal Config 必须同时声明
`high` / `max` 思考档位；Composer 工具栏专项在其他预设下也必须声明这两个档位。
不能只播种 `disabled` 后让工具栏选择不存在的选项；普通回放仍使用空参数映射，
不向请求额外注入真实模型的思考参数。

Coding Plan mock 必须在 launcher 的 `onPrepare` 阶段启动，再通过 `runnerEnv` 向 worker
传递地址。除具体 spec 名称外，选择器也识别两个已支持的批次入口：
`test/e2e/**/*.test.ts` 和 `test/e2e/conversation-session/**/*.test.ts`；比较前统一路径
分隔符和可选的 `./` 前缀。正式 CI 的目录通配符尚未展开，不能仅依赖其中出现工具名。
worker 仍按具体 spec 使用或清理 mock 环境，无关 spec 不因本次修复启用 mock。

账号模型的数据面 mock 必须按请求的 `stream` 字段返回对应协议：普通流式正文返回 SSE，
未指定 stream 或明确为 false 的标题旁路返回该协议的 JSON message，text 中包含标题 JSON。
默认账号响应与按轮次回放使用同一协议选择，不能只为专项 fixture 修正标题响应。
验收同时检查实际抓包的 Content-Type 与响应体，不能仅凭主用例断言通过判定可转正。

```text
launcher 收到批次 glob → onPrepare 启动 mock → runnerEnv 传递地址
                                                ↓
worker 收到具体 spec → 按需使用 / 清理 mock 环境 → 执行用例
```

入口回归必须使用正式目录 glob，并通过 exclude 缩小用例范围；仅跑功能名称 glob
不能证明 CI 的初始化路径。此合同只涉及 E2E 启动层，不修改生产实现。

`automations-create-manage` 的项目操作使用当前 `automation-project-select` 和
`role=option`。按 [虚拟项目规格 B18](../superpowers/specs/2026-09-09-virtual-project-design.md)，
候选来自本地虚拟项目，不再使用会话草稿菜单；隔离 fixture 只应列出 `ZCodeProject`。
保留创建、编辑、暂停、恢复与删除断言，不把旧「不在项目中工作」入口作为当前表单前置条件。

正式目录下的 spec 使用 `prepareV4ConversationE2E` 把测试带到“可发送的空草稿”；`manual-review/pending` 迁移期候选仍可使用 `prepareConversationE2E`。已转正 spec 不得导入 legacy `helpers/conversation-session.js`：V4 pane/composer/timeline 操作来自 `v4-conversation.ts`，tool block 断言来自 `conversation-session-tool.ts`，provider request 断言来自 `conversation-session-network.ts`。这条边界只收敛 formal 证据实现，不改变 catalog 的产品状态组合。

formal promotion 合并前还必须同时满足两条机械合同：spec 的 composer、message、queue、运行态与 task
切换操作只能读取 V4 helper / 已拆分的专项 helper；case manifest 的 `requests` 必须按 case-local
provider fixture 的数组顺序逐项镜像 `id` 与完整 `metadata`。fixture 调整了 matcher 顺序、
`kind`、`timingPolicy` 或 `syntheticReason` 时，manifest 必须在同一提交同步，不能让两份 replay
合同分别漂移。`pnpm audit:conversation-session-coverage` 是最终准入门禁，不能通过放宽 formal
admission 规则让 legacy helper 或 ledger mismatch 进入 formal scenario suite。

`prepareV4ConversationE2E` 只负责把测试带到“可发送的空草稿”，必须保持幂等，不能把初始化本身
当作一次“新建任务”产品操作。workspace 冷启动或重新激活后如果已经满足
`activeTaskId=null`、V4 pane `data-session-id="draft"`、idle 且
composer 可见，provider 配置完成后直接复用该草稿；只有当前仍绑定已有 session、处于非 draft
页面或 composer 不存在时，才点击新建任务。

固定文件夹具的准备还必须确认导航 owner 的 cwd 为 `ZCodeProject` 主要目录，并先于 Provider
初始化完成。该目录上的初始空草稿即使没有项目标签也可复用；不能为补标签重复新建，触发预热
owner 换代。全局新建按虚拟项目规格 D3 创建独立目录，不能用它初始化固定目录夹具；已有会话、
其他 cwd 或非空草稿应通过现有项目行的新建入口返回夹具目录。`skipShellReady` 保留调用方
自备工作区的语义，不强制选择本地夹具。显式 `startNewV4Draft` 仍点击全局新建入口。

“可发送”还包括 workspace presentation 已就绪：`prepareV4ConversationE2E`（非 `skipShellReady`）返回前，
用 `waitForV4WorkspacePresentationReady` 等 renderer session store 中该 workspace 的 slash 目录非空。
全新 HOME 下 agent 首次 `readPresentation` 会同步 seed 官方插件缓存，阻塞 agent 10–17 秒，
期间首条 `session/create` 只能排队；presentation 是这次 seed 完成的唯一事实，不能用固定等待代替。
产品侧耗时见 [官方插件首次 seed 同步阻塞](../issues/official-plugin-seed/01-sync-seed-blocks-cli-event-loop.md)。
`startNewV4Draft` 不做这个等待：新草稿的 workspace 由 UI 按 group、focused pane 与远端身份解析，
不一定是夹具默认目录；seed 开销已由「官方插件缓存预热」移出用例。

工具用例的完全访问准备复用 `switchV4Mode("yolo")`，从当前 V4 composer 的 `data-mode`
确认命令回流；不得查询旧 Select option 或聚合其他 workspace 的配置来判断当前权限。
必须先创建实际发送的草稿，再设置并断言其权限模式。新建草稿有自己的初始模式，不能沿用
前一个草稿的完全访问状态；否则工具执行会停在权限确认，误报为 Provider 没有返回。

Subagent 设置中的模型推荐和思考档位用例，先复用 `subagentSettingsReadyCursor` 等同一 Host
的初始插件 overview 与随后列表回流，再操作行内控件。首次列表可早于插件初始化出现；
保存模型覆盖的磁盘记录也不能代替该屏障。初始化期间的刷新会禁用控件并关闭档位菜单。

原生划词前须等主 pane 及其祖先的布局过渡结束，再滚动并读取文本坐标。关闭辅助面板后，
主时间线和 Composer 仍可能因容器断点继续执行宽度过渡；仅检查辅助面板零宽不能证明
文字坐标稳定。保留一次真实拖选及精确选中文本断言，不用补拖、固定延时或直接设置选区。

模型编辑器的高级区先确认 `aria-expanded=true` 且区域内实际动画结束，再点击能力开关。
展开期间 `grid-template-rows` 会改变裁切与命中区域；保留每个开关的 UI 状态和落盘值断言，
不能只用原生 click 返回成功判断切换已生效。

新项目指定主要目录并激活后，刷新应等待该主要目录的导航 owner，不再等待最初的夹具目录。
项目顺序、目录顺序和主要目录标记继续独立校验；启动回到登录页属于另一个待定位问题。
信任弹窗的宽窄屏截图及还原窗口后点击，均等待实际视口和弹窗布局过渡完成；
原生窗口 resize 返回不代表 renderer 中 max-width/max-height 过渡结束。保留一次原生点击。

远程连接 helper 默认从项目表单打开向导；测试独立设置等待者时必须显式传入
`openSSHRemoteDialog(marker, { entry: "settings" })`，并确认设置页仍在，再操作连接。
取消后返回来源页，不能把项目表单误当成设置页并查找不存在的返回按钮。
远程 symlink 身份用例先核对创建命令退出码、实际符号链接和 realpath，再判断执行身份是否收敛，
失败时分别记录活动 tab 与预期 canonical tab，避免把夹具失败或读取旧 tab 混为业务根因。
远程项目设备名按当前 RDUX-12 契约验证可见文本和真实悬停身份详情中的完整设备名、路径，
不再读取已移除的原生 `title`。操作项目菜单前移出详情并等待其关闭；焦点、布局、离线与重连断言保留。
首次连接走查将“安装结束、介绍页出现”作为进度采集的终点，截图并真实点击“知道了”后，
再等待向导关闭。不能在介绍页尚待用户确认时只等整个向导消失，也不能预写已读设置跳过该步骤。
后台连接按当前 #22 契约在设置设备卡或未完成连接项中验收进度与错误，不再把旧侧栏 slot
作为目标。走查限定设置页内的进度卡，并直接断言失败后向导保持关闭，不能吞掉该断言的超时。
验证远程选择流程中的禁发门禁时，先在可编辑的原草稿输入正文，再打开连接/目录选择流程。
弹层已打开且 Composer 只读后只读取原正文、检查提交门禁与任务数量，不能通过 Lexical bridge
强写正文制造用户无法产生的输入。取消后继续核对原草稿保留及真实远端提交归属。

横幅错误归类用例需要稳定注入读侧 `ECONNRESET`：代理接受新连接后，先收到客户端 SSH
标识数据，再发送 RST。刚接受连接就重置可能与客户端首写竞争，实际变成 `write EPIPE`，
不能把它当成已注入目标错误。顺序为 `接受连接 → 收到客户端数据 → RST → 恢复预算耗尽
→ 核对横幅原因`；保留精确文案和禁止误报安装预检的断言，不使用延时或重试控制故障形状。

身份换代确认成功后，从项目表单选择新身份的已保存设备并浏览目录，复用
`openSSHSourceDirectory`。旧 `openRemoteProjectSelection` 会进入“添加远程设备”的空连接表单，
其中不再提供已保存设备卡。继续校验旧线路已归档、新 session 与新身份一致、旧历史未混入；
不能删除旧设备或重新填写连接来替代选择已保存的新设备。
缺失密码的恢复用例同样从项目表单选已保存设备并点击“连接并浏览”，由原连接流程提示补充密码；
保留密码框自动聚焦、实际连接成功及在线复用断言，不在空的新建连接表单查找旧设备卡。

窗口尺寸准备复用 `setCurrentElectronRendererContentSize`，按当前 WebDriver URL 选择窗口，
设置内容区尺寸并按实际 zoom factor 校验 renderer viewport。不得用外框尺寸减固定误差估算内容区。
后台输出与后台任务响应式用例采用 800px 内容高度，保持原有宽窄断点及滚动断言；
不依赖宿主显示器能容纳 900/1000px 高窗口。

```text
workspace shell ready -> inspect fixture project draft
                              | empty and idle -> reuse
                              | otherwise -> project New Task
                              v
                         provider setup
                              v
                         recheck draft -> select model and thought level
```

`startNewTask` 仍表示测试步骤中的显式用户动作，必须真实点击新建入口并等待同一组 draft 条件，不能
被幂等初始化替代。共享 helper 对 composer、发送/停止控件、消息和运行态采用 V4 test id / pane /
renderer store 优先，legacy ChatView 仅作为兼容回退。初始化或显式新建失败时，helper 应在报错中
携带 pane/store 状态、composer 是否存在以及当前可见 test id，避免 before hook 只留下“元素未显示”
的无上下文超时。V4 pane 为 draft 时，helper 必须从当前窗口导航 TabStore 取得
`workspaceKey = activeWorkspaceIdentity?.trim() || activeWorkspacePath` 并精确读取该 bucket，禁止用
`activeTaskId=null` 在多个 draft workspace 之间猜测；pane 已绑定 task 时，Goal metadata 与
`stopRequested` 必须复用 task store snapshot 的 optimistic/cache 读取语义，不能伪造为空值。
该合同不新增 case 状态组合，沿用 catalog 的 TSL08 workspace draft、H Goal 状态和 I11 new-task
action 三个已确认边界。

## 数据合同

capture artifact 是证据，不是最终测试合同。正式 E2E 使用 case-local fixture 表达稳定合同。

推荐目录：

```text
packages/desktop/test/e2e/fixtures/upstream/common.json
packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case-name>.json
packages/desktop/test/e2e/fixtures/fs/conversation-session/<case-name>/
packages/desktop/test/e2e/fixtures/cases/conversation-session/<case-name>.json
```

- `upstream/common.json`：真正跨 case 复用的辅助响应，例如标题生成。
- `upstream/conversation-session/<case-name>.json`：某个 spec 自己的 provider replay 数据。
- `fixtures/fs/...`：该 case 需要的真实文件系统输入。
- `fixtures/cases/...`：case manifest，记录 spec、provider fixture、文件 fixture、请求来源和时序策略。

### 跨平台运行时路径合同

`.e2e-home` 是 Desktop E2E 的隔离用户目录，不应把 case 文件散落到系统 `/tmp`。spec 在运行时创建、读取、修改或等待的文件统一放到 Agent 实际执行 workspace `ZCodeProject` 下的 `.zcode-e2e/<case>`：

```text
.e2e-home/ZCodeProject/               Agent workspace cwd
└── .zcode-e2e/<case>/                case-owned runtime files
```

- Node 文件操作使用共享 helper 生成的原生绝对路径。
- provider fixture 的 Read/Write/Edit/Glob/Grep 等绝对路径使用 `{{e2eRuntimeRoot}}/<case>/...`；replay server 在请求匹配前展开变量。
- Bash command 使用 `.zcode-e2e/<case>/...` workspace-relative POSIX 路径，禁止依赖 `/tmp`、Windows drive 到 Git Bash mount 的隐式转换或用户 TEMP 目录。
- case manifest 的 `fileFixtures[].path` 使用 workspace-relative 路径。

```text
spec native path ─────────────┐
fixture absolute tool path ───┼─> ZCodeProject/.zcode-e2e/<case>/file
Bash relative path ───────────┘
```

该合同保证 macOS、Linux 和 Windows Git Bash 下的 Node/spec、工具执行与 shell barrier 指向同一文件。新增或修改 conversation E2E 时，fixture contract check 之外还必须通过裸 `/tmp` 审计。

**已知问题（2026-11-05）：隔离 HOME 挡不住仓库根目录的项目配置。** `.e2e-home-<runId>` 在 `packages/desktop/` 下，CLI 读项目配置时从 workspace 一直向上读到仓库根目录，所以开发者本地未提交的 `<repo>/.zcode/config.json` 会进入 E2E。

```text
packages/desktop/.e2e-home-<runId>/ZCodeProject   E2E workspace
        ↑ 项目配置向上发现
<repo>/.zcode/config.json                         开发者本地修改也会生效
```

- 实例：本地把官方插件设为禁用后，`conversation-session-composer-prefix-routing` 第 109 行的 `@` 插件分组不出现，看起来像代码回归。证据是 Agent 日志的 `"configPath":"<repo>/.zcode/config.json","configScope":"project"`，以及插件目录的 `enabled` 数量（干净配置 12/16，本地配置 6/16）。
- 判断失败前，先确认运行目录里的 `.zcode/config.json` 与 git 版本一致；不一致时，在干净的临时 worktree 里重跑。
- 本次不改隔离方式（用户决策）。根治的两个方向：把隔离 HOME 移到仓库外，或让 E2E workspace 的项目配置发现停在 workspace 边界。

case manifest 与 case-local provider fixture 中的 `spec` 统一表示 **canonical formal target**，始终写成
`./test/e2e/conversation-session/<scenario>/<case>.test.ts`。它不是 pending 阶段当前文件的物理路径；当前路径由
coverage matrix 和传给命令的 `--spec` 表达。这样 fixture 合同从 pending 到 formal 保持稳定，promotion
只移动 spec，不需要重写或覆盖已经人工整理好的 fixture 内容。

```text
manual-review/pending/<case>.test.ts   当前待审文件
                 │ fixture check 读取当前文件与 canonical fixture 合同
                 ▼
fixture JSON: spec=conversation-session/<case>.test.ts
                 │ human review + promotion
                 ▼
conversation-session/<case>.test.ts   canonical formal target 成为当前文件
```

只验证输入框、菜单、键盘选择等 renderer 交互且不会发送 prompt 的纯 UI case，可以在 manifest 中显式写入 `noProviderRequests: true` 并保持 `requests: []`；此时 case-local provider fixture 允许为空，用来表达“没有 provider 合同”，而不是漏填 fixture。

迁移期仍允许加载 legacy `provider-basic.json` / `provider-conversation-tool-cross-product.json`，但新增 case 不应继续往 legacy 共享池追加专用响应。

纯 composer、native picker 或其他不触发 provider 请求的正式 case，可以保留空的 case-local provider fixture，但必须在 manifest 中显式声明 `"providerRequestPolicy": "none"`，并保持 `"requests": []`。这类 case 仍需要跑 `e2e:fixture:check` 和本地 replay；声明只表示该 spec 的稳定合同是“不产生模型请求”，不是跳过正式验证。

## 请求分类

录制时可以全量 capture；转成 fixture 时只把必要请求纳入合同。

| 分类        | 含义                                                                     | 处理                                              |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| `main`      | case 核心断言依赖的请求，例如 edit rerun、compact summary、goal verifier | 放入 case-local fixture                           |
| `common`    | 多个 case 稳定需要的辅助请求，例如标题生成                               | 放入 common fixture                               |
| `ignore`    | capture 中出现但不属于测试合同的请求                                     | 不进入 case-local fixture，必要时在 manifest 说明 |
| `synthetic` | 真实 capture 不稳定或不能构造的时序/故障，例如慢流、断流、429            | 放入 case-local fixture，并写 `syntheticReason`   |

工具可以基于 marker、path、prompt 内容和请求顺序自动建议分类，但产品语义由开发者 review。

## SSE Timing

不同 case 使用不同回放策略，避免所有测试都被慢流拖慢，也避免性能 case 被一次性 body 回放冲掉价值。

| 策略                | 适用场景                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `fast-text`         | 普通功能断言，快速返回即可                                                                      |
| `controlled-stream` | stop、queue、interrupted 等需要稳定 streaming 窗口的 case                                       |
| `recorded-stream`   | 性能、Markdown 渲染、流式节奏相关 case，需要保留真实 `responseEvents` / `responseChunkTimeline` |
| `fault-stream`      | 断流、半包、socket destroy 等故障注入                                                           |

synthetic 的 controlled/fault stream 必须说明原因。典型例子：真实模型太快，无法稳定覆盖 stop window。

Replay capture artifact 属于请求生命周期：请求开始的 `pending`、正常响应终态以及
fixture variable 缺失等 fail-closed 终态都必须等待对应 artifact 写入后，handler 才能返回。
原子替换重试最终失败时，拒绝必须进入 replay server 的统一 handler catch；即使 500 响应已经
结束，也不能把诊断落盘 Promise 留成 fire-and-forget 的未处理拒绝。该错误路径使用可注入的
artifact writer 做 focused test，避免依赖 Windows 文件锁竞争时序。
例外是文件占用冲突（`EBUSY` / `EACCES` / `EPERM`）：capture 是全量快照、后写覆盖前写，
请求途中某次快照因测试端正在读取而替换失败时，只告警，请求照常回放，下一次快照补齐全部记录。
否则大 capture（数十 MB）在 Windows 上会把模型请求打成 500，台账留下 `fixtureId=null` 的
记录，CLI 重试后轨迹断言失败。`stop` 时的收尾写入不属于例外，失败照常抛出。
Replay server 的启动也遵守同一生命周期：`listen` 成功后的首次 artifact 写入若失败，
启动流程必须先等待 HTTP listener 关闭和当前 artifact 写队列收口，再重新抛出原始写入错误；
不得让失败的 fixture 初始化遗留端口或后台 server。

## 转正准入

一个 case 从 `manual-review/pending` 进入正式路径前，至少满足：

1. 对应 catalog/matrix 已经是 accepted 语义。
2. manual/capture artifact 已被 review，或 synthetic 原因已在 manifest 说明。
3. case-local provider fixture 和文件 fixture 已准备好。
4. `e2e:fixture:check` 通过。
5. 本地 default replay 通过。
6. 文档路径从 pending 更新到正式 spec。

pending case 已有 case-local fixture 时，可以在转正前直接检查合同；检查器读取 pending spec 中的 marker，
同时要求两个 fixture JSON 的 `spec` 指向 canonical formal target：

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- \
  --spec ./test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts
```

pending manual-review 会按 case 是否已有 case-local fixture 自动隔离模式：已有 fixture 时使用 replay，
缺 fixture 时使用 live/capture。需要临时覆盖 fixture 集合时仍可显式传入 fixture 路径；该变量同时把
provider transport 切到 replay，但仍保留 `ZCODE_E2E_MANUAL_REVIEW=1` 的 pending spec 运行边界，
避免把回放证据误当成真实 provider capture：

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case>.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec \
  './test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts'
```

如果 case 的产品语义就是不触发 provider 请求，manifest 必须使用
`providerRequestPolicy: "none"` 明确这一点；否则空的 case-local fixture 不能转正。

进入 Docker preset 前还需要：

1. Docker `replay-isolated` 通过。
2. artifact 路径写入运行记录或 PR 描述。
3. `manual-review/pending` 下的 spec 不直接加入 Docker preset。
4. 使用 `e2e:docker:admit` 同步 Docker preset 和准入文档。

## Skill 入口

这份文档是 conversation session 领域的落地实例；通用流程由两个 skill 承接：

- `.agents/skills/feature-boundary-planner`：从功能变动、matrix、formal-proof 和剪枝对话产出需要覆盖的 case 文档。
- `.agents/skills/e2e-case-lifecycle`：从 manual-review spec、capture/replay fixture、promotion、Docker admission 到 CI 的稳定化流程。

## 工具化流程

review 已确认的 pending case 使用 promotion 工具做机械转正：

```bash
pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts --reviewed --apply
```

promotion 工具只做确定性脚手架：

1. 将 spec 从 `manual-review/pending` 移到正式 `conversation-session/` 目录。
2. 修正常见 helper 相对 import。
3. 不存在时生成 case-local provider fixture 空壳和 case manifest 空壳；已有 fixture 保持内容不变，其
   `spec` 必须已经是 canonical formal target。
4. 将 coverage matrix 中该 spec 的 pending 路径更新为正式路径。
5. 在同一文件事务内运行 `pnpm audit:conversation-session-coverage`；只有 audit 通过才保留转正结果。
6. audit 失败或执行异常时恢复 spec、fixture、manifest 与 coverage matrix 的转正前快照，退出码为 1，
   禁止留下 formal admission 半状态。
7. 输出后续运行 fixture check、case-local replay、default replay 与 Docker admission 的命令。

promotion 工具不自动决定产品语义，也不把 capture artifact 直接当合同。由于 `--apply` 会在转正事务内执行
formal audit，开发者必须在 pending 阶段根据人工 review 和请求分类先填好 `fixtures` / `requests`，并让
manifest 与 provider fixture 的 `spec` 都指向 canonical formal target；audit 未通过时不会完成转正。转正后再运行：

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/<scenario>/<case>.test.ts

E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case>.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<scenario>/<case>.test.ts'

pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<scenario>/<case>.test.ts'
```

第一条 replay 命令显式只加载 common + case-local fixture，用来证明正式 case 不依赖 legacy `provider-basic.json` 的专用兜底。

进入 Docker suite 前，先跑单 spec 的断网容器证明：

```bash
E2E_SPEC=./test/e2e/conversation-session/<scenario>/<case>.test.ts \
  pnpm run test:e2e:container
```

通过后再登记进 `conversation-session-verified`：

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- \
  --spec ./test/e2e/conversation-session/<scenario>/<case>.test.ts \
  --verified \
  --artifact packages/desktop/.e2e-artifacts/<run-id> \
  --apply

pnpm run test:e2e:container:conversation
```

`e2e:docker:admit` 只做机械登记：更新 `scripts/test-desktop-e2e-container.sh` 里的
`conversation-session-verified` preset，并同步
`docs/testing/conversation-session-docker-automation-plan.md`。它不会替代单 spec 的
Docker 证明，也不会允许 `manual-review/pending` spec 直接进 suite。

进入 suite 后，常规回归不再按 case 单独 build/run Docker。`conversation-session-verified`
会把多条 spec 传入同一次 WDIO 运行，复用 Docker 镜像、容器启动、desktop app 构建和
agent server 构建成本。单 spec Docker 运行保留给准入证明和失败定位；真实 capture、
fault-stream、性能/时序敏感、会污染全局配置或依赖特殊网络/文件系统状态的 case，再拆到
独立 preset 或独立容器运行。

## 当前 MVP

第一阶段只做 E2E 落地流水线的基础设施：

1. WDIO 支持自动加载 case-local provider fixture。
2. `conversation-session-edit` 作为样板迁出 legacy 专用 fixture。
3. `conversation-session-running-actions` 作为第二个样板，覆盖通用只读 tool call、case-local final response 和 controlled slow stream 的组合。
4. 提供 `e2e:fixture:check` 秒级检查命令，检查 JSON shape、manifest、fixture id 和 spec marker 覆盖。
5. 提供 `e2e:promote` 转正脚手架，减少移动 spec、修 import、建 manifest 的重复操作。
6. 提供 `e2e:docker:admit` Docker 准入脚手架，减少维护 preset 和准入文档的重复操作。

后续再补 capture-to-fixture，把 capture artifact 自动转换成待 review 的 main/common/ignore/synthetic 草稿。

### 正式用例当前界面与构建约束

- I68 主输入框使用合并模型菜单及思考滑杆；Subagent 设置继续使用独立档位控件。两处均校验实际档位集合与请求参数。
- CTP-02B 在头像菜单内验证 Team 标签；设置页批次在每条准备前关闭上一条遗留的设置层。
- MP-UI-06 遵循 Todo141：默认显示 ID、上下文和最大输出，高级配置默认折叠，经点击展开后验证能力勾选框、推理编辑和保存。
- I24 的模型控件使用共享 custom: 编解码；不把协议 provider/model 值当成界面值，也不通过手动选模绕过自动水合断言。
- CLH-02 对目标 Host 的 setting.json 写入全程注入失败，避免默认单次故障被初始化写入消耗。
- 分片共享父构建不包含子进程动态网页 mock origin。配置网页 mock 的 child 必须在分配端口后重建；从构建到复制隔离产物全程持有共享构建锁。普通无 mock 的 child 可复用父构建。

```text
child 分配 mock 端口 → 获得构建锁 → 编译对应 origin → 复制隔离产物 → 释放锁 → 回放
```

## 2026-10-19 已审阅候选的正式回放

用户已完成人工复核的通过项按原领域迁入正式目录；业务失败和环境阻塞继续保留 pending。
正式回放先使用 common + 本例 fixture，再验证默认 fixture 解析。插件和 UI shell 的已有
case-local fixture 也按 spec 文件名加载，根目录 UI 用例使用 ui-shell fixture；不能因移走
pending 或取消显式 fixture 环境变量而丢失本例响应。没有模型请求的领域继续使用其现有
平台/文件/HTTP fixture。生产 renderer 堆保留检查使用独立 node:test 入口，不能混入 WDIO。
人工复核、正式本地回放和 Linux Docker admission 分别记录；本地通过不自动代表 Docker 准入。

旧版升级/回退用例需要 `R3_STAGING_SERVER_BASE` 指向已验真的
`7a6e2eb3f1946aba9155155178e86cd947cee655` Desktop、Server、Agent 构建，
并核对 `.deployed-commit`。当前源码构建不能代替旧版资产。2026-10-20 的四个历史迁移变体
均在该前置检查退出，按环境阻塞记录，不能归为迁移业务失败或转正证据。

正式目录 glob 属于批量回归，缺 SSH 环境时按远程队列目标类型排除需真实目标的文件；无目标的离线/合成用例仍纳入。明确指定单个文件时不排除，缺变量直接失败，避免定向运行静默漏测。

远程候选转正必须同步 `run-all-remote.sh` 的 `$PENDING` / `$FORMAL` 引用及 `DEDICATED_FIXTURE_SPECS` 中的
相对路径。只替换完整 `test/e2e/...` 路径会遗漏这两种写法，使独立正式回放通过但全量队列找不到文件。

多文件 case 转正时，同时迁移同名 `.cases.ts` / `.dom.ts`，并保留它们的相互导入；promotion 工具只移动主 spec，最终 E2E 类型检查须覆盖这些辅助模块。

迁移同时核对 `new URL(..., import.meta.url)` 和 `resolve(import.meta.dirname, ...)` 的数据文件引用；类型检查不会发现 fixture、打包入口或根 `package.json` 的相对路径仍按旧目录计算。

隔离回放同时检查网络记录中的 Missing Fixture。标题旁路虽然不阻塞主用例，缺失响应仍会触发无意义的网络重试；
不验证标题的用例应在自己的 fixture/manifest 中登记 common 标题响应，不能把旧共享池的隐式响应当作隔离证据。
