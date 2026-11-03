# 单任务重启实施计划

## 基线与已确认语义

起点：5b0dbc3ee3。合入 staging：e2f0897d565907c0c2fd3d43f3681ede11bdb5c4。
实现规范：[单任务重启](../session-task-restart.md)；CLI 接口规范：[生命周期](../../apps/zcode-cli/docs/design/v2/session-runtime-lifecycle.md)。

本轮沿用现有恢复时 discarded 队列、不自动重放的合同；active goal 暂停；faulted 不自动重启 workspace。
全部工作与产物在专用开发环境完成，不改其他工作副本。

## 上游变化核对

- App 业务单测已退役；CLI 单测继续，App 使用真实 E2E/浏览器验收，不恢复已删除协议客户端单测。
- 架构新增 workspace-mcp-trust，与 session-lifecycle 注册并存。
- 远控 RPC 服务路由和移动提交恢复已有修复，新接口必须进入同一代理路由。
- MCP 信任与配置热更新、会话历史恢复已有改动，保留其行为。
- 合并冲突：architecture-policy 保留两侧模块；协议客户端测试遵循上游删除。

## 执行步骤

- [x] 拉取最新 staging，分析并解决合并冲突。
- [x] 确定最终语义并落盘 spec/计划。
- [x] 按场景先编写 CLI 回归和 pending E2E、更新 case/coverage。
- [x] 实现生命周期协调与安全收尾；重建 publisher，复用历史优先恢复。
- [x] 补齐共享协议、Host 单任务通知与订阅身份隔离。
- [x] 增加任务菜单和 /reload，统一服务入口与执行门禁。
- [x] 执行类型、lint、架构、CLI 受影响测试、E2E 与实际运行检查。
- [x] 自检 diff，更新最终规范和证据，完成本地提交。

## 重点回归

初始化与重启循环等待；旧 publisher 在运行实例不存在时的残留；in-flight 命令与持久终态；重复请求；
关闭/启动迟到结果；跨 workspace、session、desktop/mobile 隔离；历史首帧；草稿；
模型与附加目录恢复；权限等待；后台工作；faulted；不把快照失败当实例失败。

## 执行证据

验证日期：2026-10-27。新交互 E2E 保持 pending，未经人工 review 不宣称已转正或准入 CI。

- 根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；架构新增违规 0。Lint 保留上游告警。
- CLI `pnpm --dir apps/zcode-cli typecheck` 与 `lint` 通过。最新 staging 的 model/index.ts 已有 908 有效行但漏列存量清单；本轮只在现有 max-lines 告警组补登记该精确路径，其他规则不变。
- CLI bootstrap 定向 Vitest：controller、session-execution contract、resident-pool、command-inbox、v4-history-first、v4-cold-resume、session-selection-cold-resume，共 7 文件 210 条通过。覆盖初始化中重启、订阅者存在、关闭失败隔离、历史读取收尾、旧命令结算、恢复配置。
- 根工程受影响测试以起点 `5b0dbc3ee3` 选择，由于大范围 staging 合并选中 215/215，官方 runner 按仓库规则跳过全量；这不记为测试通过。
- E2E fixture 校验通过。QUEUED 标记故意没有模型响应 fixture，若旧队列被重放则必须失败；标题旁路使用固定响应。
- 格式、diff 空白检查和本次改动的开源用词检查通过。

实际运行中修正了两类验证环境问题：容器补齐 Electron 图形库与对应浏览器驱动；测试 fixture 识别中断后合并在同一 user message 内的后续请求。主题截图使用真实指针关闭模态菜单，不改变产品代码来适配测试。

未验证范围：Windows/macOS 实机、SSH Source Server、真实跨机网络、故障注入后的 UI workspace 恢复确认、另一任务并行执行及分屏、断网重连。正常与故障的生命周期所有权由 CLI 定向测试验证；不将这些单测等同于对应 UI 已验收。

最终桌面/手机联合 E2E 通过：`desktop-e2e-20261027083213059-p46165-f51b74dc89ecadc4`，1 个组合用例，覆盖 3 次重启（桌面菜单、/reload、手机菜单），同一 session 从 generation 1 到 4。真实运行流被取消、待处理队列清空；后续请求不含 /reload 与被丢弃输入。桌面草稿和历史保留，两个客户端均恢复并可继续发送。深浅主题菜单与手机截图已人工视觉核对。

复跑命令为 `pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-runtime-restart.test.ts'`，配置容器模式、manual-review 与 case-local provider fixture；最后一次仅修正截图步骤，复用前一次完整构建，未更换产品逻辑。结果与截图保留在该次 `.e2e-artifacts`，不入 Git。CLI 格式化仅改变排版。

交付采用独立的 staging 合并提交与功能提交；不推送、不创建 MR。最终规范以 `docs/session-task-restart.md` 为准。

## 发布前 staging 复核

发布前远端已前进至 `63b665f46e`，再次合并该版本。配置网络恢复与本功能分别新增 service / SessionPane 导入，合并后同时保留；两份场景文档保留 CFG 与 SLR；模型契约 max-lines 登记沿用上游新增版本。未改变本功能产品合同。

合并后根类型、lint、架构和 CLI 类型/lint 通过。检查曾因并行内存占用退出 137，串行执行完成；没有放宽检查。新基线工程 affected 选中 216/216，仍由官方 runner 跳过全量。
完整重新构建后，桌面/手机联合 E2E `desktop-e2e-20261027084424404-p51676-86bb0d680a4b5c5a` 通过，覆盖原三次重启及队列/续发断言。上游 CFG 文档内容触发开源提醒，保留其内容，本功能未引入对应词项。

## Review 修订：启动所有权与 AppSlashCommand

本轮从 `aa6fa0729d` 开始，合入 staging `5ae55cc654`；两份场景文档保留双方新增章节。最终合同已先更新到功能 spec 和 CLI spec，再增加回归并修改实现。

- [x] 复现冷打开启动信息读取期间的 restart / ensureReady 卡住，以及旧启动完成时 stop 抢占排队重启。
- [x] Gateway 直接使用既有生命周期实现；初始化在启动信息读取前登记，共享同一完成结果。不新增管理层。
- [x] 生命周期直接激活实例，Gateway 仅提供可复用历史及独立投影收尾，移除回调接续等待。重启等待旧初始化时即保留操作资格。
- [x] 区分标题菜单、AppSlashCommand 选择、纯文本命令提交。面板选择保留正文和附件；不新增搜索 token 失效时禁止执行的规则。
- [x] CLI 定向验证及根/CLI/E2E 类型、Lint、架构检查。
- [x] 完整重建并验证桌面鼠标/键盘、手机触屏、正文和附件保留及 Plan 回归。
- [x] 更新最终证据并完成提交前自检；发布沿现有 MR 分支。

三个新增竞态回归在修复前失败，修复后通过；CLI 10 文件 230 项通过，包含冷恢复、历史首帧、生命周期、日志、常驻池、执行结算、命令 inbox 与退出。失败重试后快照回到 ready 也有定向断言。工程增量以本轮起点选择全部 217 个规格，按规则跳过，未执行全量。根 Lint 为 174 warnings / 0 errors，CLI 为 72 warnings / 0 errors；没有放宽门禁。

完整重建后的 E2E `desktop-e2e-20261027103341109-p60256-ceec2ba78163072c`：2 文件 4 项全部通过，无重试。重启组合用例连续六次重启，从 generation 1 到 7；桌面标题菜单、面板鼠标/键盘、纯文本 /reload、手机面板触屏与手机运行中菜单均通过。面板保留正文，桌面附件保留；用户消息与模型请求数不增加；运行中取消、队列丢弃和之后续发均通过。Plan 的 Tab/Enter/点击、正文附件保留、窄屏及普通文本提交三个既有用例同时通过。已核对桌面深浅主题和手机截图。

## 所属工作整体关闭实施（2026-10-28）

调查起点：5ab611c07b；发布前接到 staging bdcc1a838e。范围与合同见上述两份既有 spec；当前调查发现后台 subagent 与旧 Workflow 缺整体关闭，
动态 workflow 的 run settlement 未等待 actor 清理。此前 E2E 不覆盖这些行为，不能沿用其通过结论。

- [x] 先补 CLI barrier 回归：subagent 前台/后台/转后台/SendMessage、关闭与启动竞态、独立 owner 隔离。
- [x] 实现 subagent 准入关闭、取消和真实执行/终态写入 drain；统一 child runtime 清理。
- [x] 补旧 Workflow 的 run/resume/工具入口整体关闭与 child activity drain。
- [x] 补动态 workflow actor drain，覆盖 run 已 terminal 而清理仍在飞；传播清理失败。
- [x] App.close 并行通知全部 owner，等待辅助工作与工具执行收尾，再释放资源；验证无迟到写入/唤醒。
- [x] 更新 SLR case/coverage 与 pending E2E，覆盖桌面/手机重启后台子代理及保留历史；独立任务另由 owner 测试与共享 CLI E2E 验证。
- [x] 定向 CLI 测试、根/CLI/E2E 类型、lint、架构、格式、fixture 与实际 E2E 验证。
- [x] 更新最终证据、diff 自检、commit、推送后续分支并创建关联 MR（原 !3241 已于 2026-10-27 合并）。

失败注入覆盖关闭失败仍尝试其他 owner、无法完成则 faulted 不启动新实例。权限等待、Bash、MCP 引用、
浏览器/Node REPL、自动通知与 goal 的边界按现有测试扩展；不通过固定 sleep 或假终态掩盖竞态。

发布前确认原 !3241 已合并，因此本轮以专用后续分支创建关联 MR。
接入 staging 时保留共享 CLI、远控预加载、输入预测与 session feature 的上游变化；三个冲突均为文档追加，双方内容保留。
单任务关闭仍局限于实际 owner，不重建共享 CLI。共享 CLI E2E 另外复验跨任务隔离。

本轮定向 CLI 回归在新基线上 25 文件 / 847 项通过，1 个 live provider 文件 / 8 项按既有条件跳过。
覆盖普通子代理五种形态、另一 owner 正在运行、关闭期间创建 actor、旧 Workflow 的真实脚本与 child、
terminal run 的 actor 清理、amend/close 竞争、后台取消部分失败、Memory 和流式工具、生命周期和冷恢复。
根类型检查、CLI 类型检查（33 项）、根/CLI lint 与架构检查通过；根 173 warnings / 0 errors，CLI 75 warnings / 0 errors。
根工程增量以发布基线选择 0/217，未执行工程用例，不记为工程测试通过；推送门禁另外检查架构工具与 schema。
fixture 校验通过：QUEUED 无响应为禁止重放的故意配置，title fixture 为固定旁路响应。

运行证据中保留两类验证环境失败：并行检查触发容器 OOM，CLI 类型/单测被终止；根 tsc 输出覆盖 Host bundle，
随后复用构建导致 Host 在数据库启动前退出。已改为串行检查后完整构建 E2E，不修改产品或延长测试超时。
真实脚本回归还捕获过取消后迟到写旧管道的 EPIPE；处理留在所属 run，并等待宿主请求收尾。

完整重新构建后，run `desktop-e2e-20261028034030622-p96108-e06044f1941b97a8` 的两个组合 E2E 全部通过。
SLR 连续八次重启（generation 1→9），含桌面/手机后台子代理取消；STCLI 复验同进程其他任务、移动与进程退出恢复。
已查看桌面深浅主题菜单与手机恢复截图。最后把新续发断言补强为“出现新的 assistant 回复且正文匹配，再等 idle”，
避免把发送准入前的旧 idle 误作新轮完成；该测试单独复跑，产品二进制未变化。

补齐功能图的 session-owned-shutdown 检索节点、六个代码种子和三条关系。结构检查与基线比较新增断边 0；
全图有 4 条既有断边，本轮未扩修；环境没有 codegraph，新增种子的文件与符号按本地源码核对。
未验证 Windows/macOS 实机、实体手机、跨机断线、分屏和 workflow GUI；pending E2E 未转正或准入 CI。

补强续发断言后的最终 SLR 复跑通过：`desktop-e2e-20261028034551147-p100750-24abd4a9969d2d48`，1/1，复用此前完整构建，确认桌面和手机重启后都收到新的回复。

## Review 关闭机制重构

起点：976ab7cb1b。先修订既有 spec，再添加失败回归，实现后验证并追加现有 MR。

- [x] Runtime 统一取消信号与真实 drain；标题/goal title 取消回归。
- [x] MCP 连接池拥有连接生命周期，session lease 独立取消、禁止迟到登记与关闭后调用。
- [x] child 统一关闭/自然释放，初始化失败进入收尾；成功结果与清理失败分离。
- [x] 普通 subagent、脚本 Workflow、动态 Workflow 保留未释放资源而非历史错误。
- [x] App 有界等待不打断实际关闭依赖链；超时后 store 保活直至 drain。
- [x] CLI 回归、类型/lint/架构/格式、桌面手机重启与共享 CLI E2E。
- [x] 完成证据、自检及 MR 描述准备；沿原分支追加，不创建并行 MR。

关闭时序已收口为：关闭准入 → 并行取消所属工作 → 等真实 drain → 释放资源/借用权 → 关闭 store。
Runtime 的 retire 允许已存在的后台工作自然完成；close 主动取消，二者共用可重试的资源释放。
后台 tracker 的终态持久化也登记到既有 residency ledger，避免任务状态先完成、写入尚未结束就释放。
Workflow 通知格式转换移到既有 workflow-artifact 模块，tracker 保持生命周期职责；通知内容不变。

本轮验证（在专用开发环境执行）：

- 先有失败回归：title 未取消、MCP waiter 相互影响、清理异常覆盖 child 结果、超时后提前关库、后台终态写入未结束便释放。
- CLI 定向 27 文件 / 663 项通过；通知逻辑提取及新增初始化失败场景后，4 文件 / 72 项复跑通过。
- CLI 类型检查 33/33、App 类型检查通过；CLI lint 0 errors / 71 warnings，App lint 0 errors / 173 warnings（存量警告）。
- 架构检查 0 违规；当前分支根增量入口为 test:engineering:affected，选中 2 文件 / 4 项通过。
- fixture 检查通过；两个既有 warning 为标题 matcher 无主请求 marker、队列 marker 不应产生模型请求。
- SLR01–03/05/06/09：desktop-e2e-20261028044310791-p116682-50c5abe8b4f1cc6f，1/1，通过当前源码完整构建。标题请求在点击前为 pending，8 次重启后两端仍能继续对话。
- shared CLI：desktop-e2e-20261028044521734-p118965-9cf426d4f75cd1bc，1/1，复用同一产品构建。首次组合命令中该 spec 路径未匹配，没有计入覆盖，随后按实际 pending 路径单独补跑。

已查看桌面深浅主题菜单与手机恢复截图。原始日志、请求捕获与截图留在测试环境，run ID 是定位信息，
不是远端归档链接；可复现入口为对应 pending E2E、fixture 和上述 CLI 测试。
未验证 Windows/macOS 实机、实体手机、跨机断线、分屏、Workflow GUI；pending 不自动转正或加入 CI。

## 浏览器释放与展示修正（2026-10-29）

目标基线为 release/v3.17.0 的 99ef6b1ec8；先更新 spec 和回归，再修改实现。

- [x] Browser broker 保存已校验路由；关闭和取消不再依赖活动 runtime。
- [x] 等待全部关闭结果，传播失败；成功项按对象身份移除，失败项和 child 绑定保留。
- [x] slash 面板显示 /reload 和英文说明；删除输入框上方 starting/stopping 提示，保留门禁及错误。
- [x] Main 统一持有 backend identity 与 control scope；明确建立拒绝撤销责任，未知结果保留到 owner 确认释放。
- [x] Main 关闭准入、等待在途命令和录制/CDP 释放；closed 屏障隔离迟到请求和后续实例。
- [x] runtime/subagent/workflow 的失败 close flight 可重试，不再永久返回第一次 rejection。
- [x] CLI/owner/SDK 定向 214 项通过；工程 affected 334 passed / 2 skipped。
- [x] App / CLI / E2E 类型、Lint、架构及 fixture 检查通过。CLI 旧 Turbo 入口不可用，使用根 workspace 递归包 typecheck。
- [x] Linux Electron + 触屏 Chromium 综合 E2E 通过；同页重新认领、深浅主题、手机菜单及子代理关闭均覆盖。证据与范围见覆盖矩阵 SLR10–11。

前期 preflight 因容器配置缺失失败；手机观察器的序列化问题已修正。最终构建一次运行在自动轮尾截图超时，资源关闭与重启正常，同一构建复跑通过；截图偶发超时根因未确认。用例保持 pending-review，不自动晋升 formal/CI。

## 后续 review：ambient 与 admission 恢复

- [x] 将 session 只读 list 与 control scope 的操作隔离分开，列表 meta 与实际页面一致。
- [x] 建立结果未知保留 ID 与清理责任，只清除失败 flight；并发重试共享，关闭阻止再次建立。
- [x] 新回归先失败后通过；Main/broker/resident/workflow 80 项通过。App/CLI/E2E 类型、lint、架构、fixture 均通过；工程 affected 0/218，无选中项，不跑全量。
- [x] 桌面/手机综合 E2E 通过；新增桌面下一轮实际 provider ambient 断言。运行证据见覆盖矩阵 SLR10 review 补充。

## 启动归属和关闭完成实施（2026-10-30）

基于 hotfix/v3.17.2；已包含子代理 workspace 继承和父链恢复修复，本次只复用并回归。

1. 先补失败测试：工作区透传、冲突 flight/破坏前校验、词法等价旧 root、非法父链，慢关闭真实完成、goal 暂停失败仍收尾。
2. 修改既有 schema/SDK/Host/controller/Gateway 激活接线；能力协商保护旧 CLI；只读兼容，不改数据库。
3. 删除单 session 总关闭 deadline，分开必要收尾依赖；日志保留关闭阶段及原因。
4. CLI 定向测试与真实 SQLite 升降级读写；桌面 continuous / 手机 replayable 的 reload、菜单、历史恢复回归。
5. 类型、lint、架构、受影响工程检查、E2E；完成后更新证据、提交并向目标分支交付。

线上三类告警具体现场仍不完整；本次修复已复现的代码缺陷，不宣称所有 release failed 都来自六秒预算。

完成结果：

- [x] 失败回归先复现，再修复；同步重入关闭额外以测试证实只执行一次。
- [x] CLI 定向 9 文件 329 项通过；工程 affected 48 文件 334 passed / 2 skipped。
- [x] App、CLI（34 tasks）及 E2E 类型检查通过；App/CLI lint 无 error；架构 0 violations；fixture 与开源检查通过。
- [x] 最终构建真实 Electron + 触屏 Chromium E2E 3/3 通过，详情见覆盖矩阵本轮 HF01 / SLR 记录。
- [x] 真实 SQLite 与 Agent 续写往返验证旧 root、旧 child；打开/续写不回填目录，模拟旧 writer 再写后可再次恢复。

存储实现与 v3.17.1 相同；兼容验证复用相同 store，不等于旧版 GUI 二进制完整升级/降级实跑。
本次无 schema、migration 或持久字段语义变化。原生 Windows/macOS、实体手机与 SSH 未在本轮实跑。
初次 HF02 因过时 hook 重跑断言失败，运行日志证明实例 ready 后只有投影读取失败；已按现有契约修正测试。
单 session 不再因六秒等待预算永久 faulted，但资源自身 RPC 失败仍保留隔离与显式进程恢复出口。


## 启动入口 review 修复（2026-11-02，完成）

- 先补 CLI 回归，再登记 create/fork/V4 workspace；create 与 restore 的持久存在性规则明确分开。
- 旧无上下文 flight 的加入者完成后校验归属；旧 WSL 预检与原原子修复共享精确识别，不增加迁移。
- 关闭阶段 30 秒仅告警未完成资源；能力查询作为 observation，单请求超时不淘汰共享连接。
- CLI 定向 11 文件 378 项通过；根/CLI 类型检查、lint、架构和开源检查通过。工程 affected 对本次范围选中 0 项，未扩大跑全量。
- 实际 SDK 超时探针确认连接淘汰事件为 0，后续状态查询成功。原始探针留开发环境，未作为 App 业务单测恢复入库。
- E2E `desktop-e2e-20261102054133648-p182647-caa0869ba42a5410`：2 spec / 3 test 全通过（Linux Electron、触屏 Web），场景与限制见覆盖矩阵。

当前 V4 transport / connection scope 将路径与身份传给服务，remoteSessionId 只用于选连接；
UI 重启使用同一口径，本轮未放宽归属校验。未实跑 SSH 和原生 WSL/Windows/macOS。
慢关闭日志不提供新恢复按钮；永久挂起仍需显式重建进程或重开应用，faulted 原恢复按钮不变。
