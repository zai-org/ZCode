# V4 冷恢复：Runtime 激活与 Legacy Snapshot 解耦

> 状态：2026-07-24 accepted；2026-08-13 增补单次物化；2026-10-09 增补历史就绪与 runtime 就绪。
> 范围：V4 conversation 首次冷订阅；不删除 legacy `session/resume` 协议，也不迁移 Bot 实时订阅。

## 1. 问题

改动前，CLI 冷启动后首次打开持久会话，V4 订阅间接复用 legacy `resumeSession`：

```text
v4/conversation/subscribe
  -> legacy cold-resume adapter
  -> legacy resumeSession
       ├─ 创建 record / runtime
       ├─ 恢复 workspace、模型、thought、mode、restoreWarning
       ├─ app.resume() 与事件接线
       └─ 构建完整 ZCodeSessionStateSnapshot  ──> 返回值被 V4 丢弃
  -> V4 durable transcript hydration
  -> getSessionUsageSeed
       └─ legacy readSession/full snapshot   ──> 只读取 runtime.contextUsage
  -> V4 initial snapshot
```

这里混合了两种职责：

1. **runtime 激活**：V4 后续命令和 config seed 必须依赖；
2. **legacy 表示层物化**：只为旧 `session/resume` 响应服务。

V4 已由 durable transcript、session entry、memory event 和 `ProductProjection` 生成自己的权威
snapshot。继续构建 legacy snapshot 不增加恢复能力，只会让耗时随历史 messages/parts 规模重复增长。

## 2. 目标边界

```text
                         ┌─ legacy session/resume
persisted session        │    -> activateSessionForResume
        │                │    -> build legacy snapshot -> legacy caller
        v                │
activateSessionForResume ┤
  ├─ persisted metadata  │
  ├─ workspace identity  └─ V4 cold subscribe
  ├─ record + event sink      -> activateSessionForResume
  ├─ model/thought/mode       -> V4 durable hydration
  ├─ restoreWarning           -> narrow context-usage seed
  └─ app.resume()             -> V4 initial snapshot
```

`activateSessionForResume` 是 profile 无关的 lifecycle primitive：

- record 已存在时不重复 `app.resume()` 或事件接线；显式 `runtimeModel` 仍按旧语义刷新；
- record 不存在时完整保留原 `resumeSession` 在 `snapshot(...)` 之前的全部行为；
- store 无 session、模型不可用、runtime resume 失败等错误与旧路径一致；
- 不根据 `desktop-continuous` / `web-remote-replayable` 分支。两者只在激活完成后的 V4
  publisher delivery profile 分流；historyFirst 增量在 §4.1 定义。

legacy `resumeSession` 继续作为兼容包装层：

```text
resumeSession = activateSessionForResume + snapshot
```

因此旧协议调用者、Bot 尚未迁移的 legacy 状态读取和测试语义不变；本次只让 V4 冷订阅调用
activation-only primitive。

## 3. 不得损失的功能

| 不变量                        | 约束                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| historyReadyBeforeRuntime     | 支持 historyFirst 的连接先发布持久历史；runtime 完成后才开放执行与读取 runtime config/usage seed           |
| historicalConfigPreserved     | 历史 model、thought、mode 继续按 session-local durable selection 优先恢复                                  |
| restoreWarningPreserved       | 历史模型不可用时仍允许读历史，但后续 `sendText` 被同一 restore warning 闸门拒绝                            |
| workspaceIdentityPreserved    | 远端恢复继续使用持久化 `workspaceID`；identity key 不退化为 `workspacePath`                                |
| eventWiringPreserved          | `createRecord` 建立的 event sink、persistence、MCP/runtime 接线不改变                                      |
| timestampsAndParentPreserved  | `createdAt`、`updatedAt`、`parentSessionId` 继续从持久会话回填                                             |
| v4HistoryAuthorityUnchanged   | rows、reasoning、tool、plan、goal、queue 和 interaction 仍由 V4 durable materialization + memory tail 恢复 |
| deliveryBoundaryUnchanged     | desktop 保持 continuous；mobile/Web remote 保持 replayable gap/snapshot 恢复                               |
| restartDiscardUnchanged       | 上一 runtime 未终态 input 仍按 delivery ledger discarded；不得因去掉 legacy snapshot 自动重放              |
| legacyResumeResponseUnchanged | `session/resume` 仍返回完整、schema 等价的 legacy snapshot                                                 |
| v4ColdReadySingleOwner        | V4 gateway 拥有历史就绪与 runtime 就绪；同一会话同一次初始化单飞                                           |
| hydrationBoundaryUnchanged     | `hydratePublisher` 仍只负责 projection hydration，不接管各入口既有的 runtime activation 前置条件          |
| registryIsNotV4Readiness       | `context.sessions` 只登记 record；V4 cold operation 完成前不能据此放行 query/command                      |

pending permission/elicitation 和当前 runtime queue 不是旧进程可无条件复活的 durable 事实。本次不增加、
删除或改写它们；新 runtime 的 V4 memory event tail 仍是在线权威。

## 4. Usage 窄投影

V4 冷恢复不能为了 `runtime.contextUsage` 再调用 `readSession`。窄投影必须复用 legacy snapshot
当前的同一计算口径：

```text
runtime projection contextUsed/contextWindow
  + active-branch persisted context usage/cache
  + latest matching main-turn ModelComplete breakdown
  -> ZCodeSessionContextUsage
  -> SessionUsageSeed
```

必须保留以下细节：

- runtime `contextUsed` 非零时优先；否则回落 active branch 最近的 assistant tokens 或
  compact boundary，具体口径见 `docs/context-window-usage-state.md`；
- cache 汇总只统计 active branch 的非 summary assistant messages；compact boundary seed
  不复活压缩前 cache；
- breakdown 只接受 main-turn、且 `used/contextWindow` 与 meter 对齐的最新 `ModelComplete`；
- 非正数 used/window 返回 `null`，保持“尚无一次模型往返”语义；
- 不读取/映射 legacy messages、settings、todos、goal、slash commands 或 model availability。

### 4.1 历史先显示（2026-10-09）

```text
subscribe → durable messages M0 → 同一个 V4 publisher → 首帧进入 transport outbox
                                                          ├─ UI 历史可读、文字草稿可编辑
                                                          └─ runtime activation(M0)
                                                               ├─ ready → 对齐投影、开放执行
                                                               └─ failed → 保留历史、手动重试
```

- 能力名 `historyFirst`，沿 hello/clientHello 和可信 attachment 传递；未声明能力的订阅仍等待完整恢复。
- 历史阶段 ACK 记录 `historyReadyMs`，旧路径保留 `cliSessionRestoreMs`；完整激活耗时沿现有 resume 生命周期日志记录，不混为首屏时间。
- snapshot/state patch 新增可选 `runtimeInitialization`：`initializing | ready | failed`，携带 `attemptId`；failed 附结构化 `reasonCode/message`。缺席表示旧协议的完整就绪语义，不增加 run phase。
- subscribe 可携带 `retryInitialization`（观察到的失败 attemptId）；仅匹配当前 failed 尝试才能启动下一次，重复请求合并。普通重连不重跑失败尝试，不新增 RPC。
- 首次历史只依赖持久化 materialization，复用 active branch、goal/plan 与既有 reducer，不调用 runtime、不伪造模型可执行状态。详情、附件、工作流目录与 App 交互待 ready。
- 单次正常恢复完整读取 parent messages 一次，M0 仅在本次恢复调用栈中共享；runtime 修复 interrupted compact 后才允许读取 M1。重试重新读取持久事实。无新数据库 schema、全局缓存或 TTL。
- 首帧进入现有 post-response outbox 后再调度 activation，不能用固定 sleep 或仅 Promise.all 掩盖同步插件扫描。历史加载失败仍是订阅失败，不能显示虚假空历史。
- 旧标题/删除意图迁移先到达时，也由同一个两阶段 opening 读历史、启动 runtime；命令仍等待完整 ready 后才写持久事实。后来到达的 historyFirst 订阅复用历史首帧，不等待迁移命令的激活屏障；旧能力订阅仍等待 ready。并发订阅、迁移命令只读取一次 M0、执行一次 resume，不另建 publisher 或 runtime。
- gateway 是两阶段唯一 owner；context.sessions 入册不是 ready。初始化期间新执行命令明确拒绝，不进入 accepted input queue；既有 command query/dedupe 保留语义。
- 初始化事件和最终 hydration 使用同一个 publisher；对齐 memory tail、source seq、compact 修复及最新配置之后才 ready。UI 不保留第二份 transcript。
- failure 清理仅本次半初始化 record、event sink 和 app，保留历史 publisher。显式重试重新执行完整 resume（含 SessionStart hook），不承诺回滚 hook 外部副作用。
- 初始化开始后切走不强制取消既有生命周期；关闭/换代后的迟到结果不能更新新 publisher。初始化中的 record 不得被驻留回收。
- warm/live/detached child 复用原流程，不创建第二个 runtime，不修改任务时间、taskType 或全局模型默认值。
- desktop continuous 和 mobile replayable 共享同一恢复 owner，保持各自 gap/snapshot、workspaceIdentity/remoteSessionId 与订阅水位边界。

2026-11-09 回归将普通历史（HF01/HF02）与旧标题交接（HF04）拆成独立 HOME；标题交接用例先等待迁移启动的 hook，再订阅历史，并核对最终标题、交接位、单次 resume 与续发。夹具屏障先订阅目录事件再检查 release 文件，保证后续重启不会等待已经发生的释放。运行证据见 [覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)。

### 4.2 命令目录与历史首屏的调度边界

冷打开时，输入框的 `workspace/readPresentation` 会发现插件并生成斜杠命令目录。
它曾占用 NDJSON 普通请求串行队列，使后续 `provider/refreshRegistry` 排队；Host 又在
conversation subscribe 前等待该刷新，历史首屏因此间接等待命令目录。

```text
前序普通请求（含配置更新）完成
  ├─ workspace/readPresentation → 插件发现与命令目录 → 独立响应
  └─ Provider 更新 → Registry 刷新 ACK → conversation subscribe → 历史首帧
```

- 仅 `workspace/readPresentation` 使用此读取分支：捕获收到请求时的前序普通请求屏障，
  等其完成后进入 handler；不把目录加载的完成 Promise 追加到普通请求串行队列。
- Provider 更新和刷新仍按原普通请求顺序执行；Host 的按 client Account 交付队列、revision
  核验及订阅前刷新屏障保持不变。不能用缓存、跳过刷新或固定延时替代一致性约束。
- 目录读取使用 handler 开始时的配置语义；插件材料验证、变更失效和 seed 写锁仍归原 owner，
  不增加另一份目录缓存。后续配置操作可以与目录发现并行，已有查询失效规则继续生效。
- NDJSON connection 持有在途目录读取，仅用于关闭排空。EOF 等待普通请求和已接收的目录
  请求，仍受原有 EOF 排空上限约束；终止后排队读取不得开始，迟到结果不得写响应或提交 outbox。
- desktop continuous 与 mobile replayable 共用该调度，workspace/remote identity、请求 ID、
  session lifecycle、ACK/initial 顺序及订阅所有权不变。
- 回归用可控 Promise 分别阻塞前序配置、Provider 更新和目录读取，验证前序顺序、后续
  Provider FIFO、刷新完成前零历史订阅、目录仍挂起时历史可返回，以及 EOF/异常/终止边界。
  冷打开性能以确认目标 CLI 未运行后的点击到历史 DOM 为口径，单列排队与 handler 执行耗时。

2026-11-04 在 macOS arm64 开发态对两个 workspace 做前后交替测量，共 16 次有效冷打开。
修改后的 8 次均在目录读取完成前返回历史；所有样本中，前序 Account 更新均在 Registry
刷新开始前完成。测量时两个版本都包含独立的 Bash 注册表与 TS 编译器按需加载实验；
该实验未保留在最终改动中，因此只保留上述调度顺序证据，不把此前整段耗时作为最终版本的
性能结论。机器并发负载未隔离，启动阶段波动明显；未覆盖其他平台实机。

### 4.3 UI 与影响面

- SessionPane/ConversationComposer：历史 snapshot 控制正文，runtimeInitialization 控制执行；初始化中不显示提示条，仅失败时在输入框上方显示错误和重试。重试后隐藏错误提示，保留草稿与滚动。
- workflow journal、模型操作、附件与 App 入口：ready 后查询/交互，不能抢在首订阅前启动 runtime。
- Gateway/bridge/resume：必须修改，负责持久历史、单飞、失败清理与最终状态对齐。Host/transport 只透传新增能力和订阅意图。
- sessions-index、驻留策略、legacy/Bot、全局插件/Skills 缓存：仅回归验证，不扩大行为。
- 图谱补充 history-readable 与 runtime-ready 的依赖区别；原图缺少 workflow 查询早于订阅的时序边，应随实现更新。

## 5. 剪枝后的验证矩阵

不枚举所有客户端 × 所有会话状态。activation 发生在 delivery profile 分流前，按不变量选择代表样本：

| 代表样本                                | 验证重点                                                                              | 证据层                    |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| completed 本地历史 + desktop continuous | 历史 rows/tool/reasoning、续发、幂等、无 legacy snapshot 物化                         | bootstrap 集成            |
| completed 远端历史                      | workspace identity、provider registry、续发                                           | 既有 V4 cold-resume 集成  |
| 历史模型/thought/mode                   | session-local 配置与 thought hint 优先级                                              | 既有 I63 / bootstrap 集成 |
| 模型不可用                              | restoreWarning 读写边界                                                               | 既有 bootstrap 集成       |
| completed child                         | child cold hydration、只读导航                                                        | SAT09 既有证据            |
| mobile replayable                       | 与 desktop 首个完整终态等价；gap/resync 语义不变                                      | PV4-06/25 既有协议证据    |
| legacy `session/resume`                 | 完整 snapshot 和 context usage 保持                                                   | legacy protocol 单测      |
| 大会话 PERF03                           | activation 不构建 legacy snapshot；正常冷订阅只完整读取一次 parent messages；记录趋势 | 性能 fixture              |
| 并发 V4 subscribe/query/command         | 历史首帧早于初始化完成；初始化期间零执行 admission，分页可读                          | bootstrap 单元/集成       |
| READY 失败                              | 保留历史及结构化错误；清理半初始化 record；显式重试单飞                               | gateway 单元              |

## 6. 非目标与后续

本次不处理以下相邻 over-fetch，避免扩大回归面：

- V4 `createSession` / fork registration 为取得少量字段构建 legacy snapshot；
- Bot 的 legacy continuous subscribe、附件发送与状态查询；
- 删除 legacy `session/resume`、`readSession` 或 snapshot schema；
- 优化插件/Skills/MCP 扫描，替换 batch reducer、wire fragment 或 rows window 协议。

这些路径应单独按调用者迁移并留下自己的功能矩阵，不能借本次 cold-resume 优化一并删除。

## 7. 2026-07-24 实测

环境：Apple Silicon、本地 production `app-server`、每个样本启动全新 CLI 进程；同一 workspace、
同一 session、同一 `desktop-continuous` subscribe。对照组从改动前 HEAD
`e3efe9006ad7489b83d1efca917b3c0df32add69` 的 detached worktree 独立构建，避免用旧安装包或
不同源码比较。文件缓存预热后各跑三次。

fixture `sess_perf_large_20260724034221_af2e36b8`：

- 2,000 messages / 6,671 parts（约 1,000 turns）
- 2,000 tool parts、334 reasoning、200 patch、60 todos
- 两组 initial V4 physical frame 均为 143,690 bytes

| 实现                                                               | 三次 cold process → initial frame |    中位数 |
| ------------------------------------------------------------------ | --------------------------------- | --------: |
| 改动前：V4 activation 构建 legacy snapshot，usage 再 `readSession` | 3352.1 / 3169.5 / 3070.2 ms       | 3169.5 ms |
| 改动后：activation-only + usage 窄投影                             | 2704.8 / 2701.5 / 2607.6 ms       | 2701.5 ms |

同机中位数减少 **468.0 ms（14.8%）**。此前该 fixture 的单次 legacy `readSession` 日志为
281–288 ms；两次 full snapshot 被移除后的端到端差值与该量级一致。这个数字仅作为本机回归证据，
不构成跨机器 SLA。

最终 production bundle 重建后，又以 Agent ready 作为起点跑了三次：

| 边界                               | 三次耗时                    |    中位数 |
| ---------------------------------- | --------------------------- | --------: |
| ready 后 subscribe → initial frame | 2040.1 / 1998.0 / 1936.5 ms | 1998.0 ms |

完整 `v4/conversation/frame` NDJSON notification（含换行）均为 143,691 bytes，stderr 为空。此前
process → initial frame 的约 2.7 秒还包含约 0.69 秒的进程启动/ready 阶段，因此两种口径一致，
不能把全部等待时间都算给 runtime activation 或 legacy snapshot。

同一 fixture 的单次阶段探针显示：持久 messages 读取/解码约 56.8 ms，transcript synth 约
49.9 ms，`ProductProjection` hydrate 约 679.9 ms，当前 usage 窄读取再次读取 active-branch
messages 约 60.0 ms。探针来自诊断 run，不与上表逐项强行求和；它只代表该 2,000-message
fixture，不能外推到 10,000-message 以上的工单形状。

2026-08-12 使用 PERF03-E 的 10,622 messages / 35,811 parts fixture 重新计数后，production
正常冷订阅会完整物化父 messages 5 次；单读中位数为 385.1ms，4 次重复读取的直接成本上界约
1540.6ms。落实本节 4.1 的 operation-scoped 复用后，fresh-process subscribe → initial frame
中位数从 3991.9ms 降到 2681.6ms，减少 1310.3ms（32.8%）。两组保持 158038-byte frame、
29950 rows、60-row window、`toSeq=74164` 与 0 running subagents。完整测量与环境见
[`v4-conversation-cold-hydration.md`](../performance/v4-conversation-cold-hydration.md#perf03-h-单次冷恢复物化2026-08-12)。

## 8. 历史先显示验收（2026-10-09）

实现使用 gateway 本次恢复 promise 共享 M0，旧 activation coordinator 保持 runtime 单飞。
持久 metadata/target/entries 和 memory tail 仍读取最新值，usage seed 在补完 live buffer 后对齐；
parent materialization 不扩散到 child。普通 core 与 legacy resume 不注入 M0，维持原入口语义。
正常初始化/失败重试通过 state patch 对齐，只有真实历史结构改变（如 compact 修复）才使用 snapshot 边界，
避免尾窗快照丢弃 UI 已分页读取的行。

### 8.1 运行与回归证据

- 删除初始化提示条后，Composer 回归 **17/17**，pending HF01/HF02 **2/2** 通过；
  run：`desktop-e2e-20261009124509259-p39833-e0ca33f5fc0a7314`。屏障期间确认无初始化提示条、
  草稿可编辑且发送禁用；失败仍显示错误和重试，重试中的提示条隐藏，待发送按钮可用才判定就绪。
- macOS Electron：本分支重新构建 CLI 与 Desktop 后，pending HF01/HF02 **2/2 通过**。
  最终 run：`desktop-e2e-20261009122057441-p88058-2c6e51fda3f594c9`，产物保留初始化与失败重试截图。
  HF01 使用真实 SessionStart 文件事件屏障，验证正文可读、草稿可编辑、发送禁用及解除后续发；
  HF02 在 M0 已展示时损坏隔离 fixture 的分支字段，经真实最终物化失败路径，验证错误条、
  历史/草稿/滚动保留、修复持久数据后双击重试只再次执行一次 resume hook。
- Gateway/publisher/cold-resume/cold-event-merge：120 项中 **117 通过**，3 项旧模型/thought 恢复断言失败；
  从改动前 `23819deddc` 独立提取源码复现相同失败。另一个既有 gateway stale-vs-executionFailed
  断言也在基线复现，未在本轮扩大修复。
- UI/Host 能力协商及连接隔离定向回归 **77/77**，状态条定向回归 **17/17**；
  根目录 related 扫描 14,036 通过、1 项源码断言失败，该断言随 ready 门禁更新后定向重跑通过。
  `test:unit:affected` 在未提交阶段只比较提交范围而跳过，因此以上 related 运行用于验证工作区改动。
- 根目录 typecheck/lint、CLI 30 个包 typecheck、architecture check、fixture check 与变更文件开源词检查通过。
  CLI lint 未全绿：Bootstrap 的 20 个 max-lines 错误在基线同样存在，其他未改包亦有既有超长文件。
- 新增 E2E 仍处于 pending，未人工晋升或加入 Docker gate。未实跑物理手机/SSH/Windows/Linux；
  continuous/replayable、workspace identity、compact/rewind、warm/child 的证据来自协议/集成回归，
  不把它们表述成完整远控网络验收。超大历史的实际 UI 性能本轮未复测。

### 8.2 同条件首帧对照

Apple Silicon / Node 24；同一隔离 SQLite fixture（2 messages），每轮全新 CLI 进程和 HOME，
交替运行三次；配置有效的 Personal Provider，并断言 ready 帧保留 fixture 的模型选择。基线从 `23819deddc` 的 Bootstrap 与 shared 源码独立构建，其他依赖相同；
两份 CLI 使用同一资源目录，日志确认每轮均发现 15 个插件、启用 11 个。
从 `runtime/capabilities` 响应后发出 subscribe 开始计时，真实 SessionStart hook 固定占用 2 秒。
这是验证等待链路的受控样本，不是自然冷启动百分比，也不是用户会话的 UI 首屏测量。

| 边界 | 修改前（ms） | 修改后（ms） | 中位数前 → 后 |
| --- | --- | --- | --- |
| subscribe → CLI 历史首帧 | 3349 / 3094 / 2834 | 12 / 37 / 17 | 3094 → 17 |
| subscribe → runtime ready 帧 | 3349 / 3094 / 2834 | 3541 / 3305 / 3583 | 3094 → 3541 |

首帧已不再等待 runtime；完整初始化本轮没有改善。日志中插件发现阶段为修改前 607–992 ms、
修改后 1020–1236 ms，这一 fresh-HOME 样本的主要波动落在原插件流程；本轮没有优化该阶段，
也不把单机少量样本解释成跨机器 SLA。早期对照因临时基线未发现
内置插件而不具可比性，已废弃。Desktop 的 hook 使用事件屏障（不是上述 2 秒定时器），
其耗时包含测试检查和手动释放屏障，不与 CLI 样本混算。
