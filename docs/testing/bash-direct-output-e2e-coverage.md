# Bash 直接文件输出 E2E 回归与改动覆盖率

## 范围与测量合同

目标提交：`9c99f9623c`，比较父提交与该提交中的 production TypeScript 改动。
沿用 `docs/bash-background-parity.md` 已确认的行为，不通过测试改变产品语义。
2026-09-08 的覆盖率测量仅补测试和测试数据；2026-09-09 另按用户要求修正
收起态展示，当前合同及增量验证单列。Desktop 使用 `desktop-continuous`，不把手机
`web-remote-replayable` 的恢复语义混入桌面。

```text
用户 prompt / Stop / 输出路径点击
  -> Desktop V4 -> Host -> CLI handler -> execution adapter
                                      |-> 同一 fd 写 stdout/stderr
                                      |-> 尾读进度 / 头读摘要
                                      `-> 5 秒大小检查 / 主动停止杀树
  <- Desktop V4 <- projection <- tool result / background notification
```

影响面按调用关系限于两层：Bash handler、执行 adapter、tool result/progress 投影、
Execute renderer、TaskOutput/TaskStop；相邻 Hook 用例验证共享 pipe collector 没有回归。
代码图工具在本会话不可用，调用链由源码和实际执行日志核验。此次不新增产品状态或功能图节点。

| 入口                      | 权威状态                | 必须验证的结果                                 |
| ------------------------- | ----------------------- | ---------------------------------------------- |
| 前台 Bash / 子代理内 Bash | CLI execution           | 原始文件、摘要、运行态进度、停止后结果         |
| 显式/超时后台 Bash        | CLI background registry | 文件持续增长、TaskOutput、单次通知             |
| 输出文件链接              | Desktop code viewer     | 打开真实输出路径，不执行额外 Bash              |
| Hook                      | 通用 execution pipe     | stdin 与 stdout/stderr 仍经 collector 正常交付 |

测量使用 `ZCODE_E2E_COVERAGE=1` 的四域报告。每个报告必须 `complete=true`。
四域分别统计，不合并百分比；用例通过率与代码命中率分别列出。
改动行口径为 **Istanbul 源码语句起始行 ∩ 新增/修改 diff 行**，不把类型、import/export、
注释、空行或删除行放入分母。同一域多个 run 按源码位置取命中并集，不混用 statement ID。
CLI 的 dist JS 先与同一 tsconfig 重新编译的产物逐字比较（只剔除 sourceMappingURL），
一致后使用该 source map 回溯到原始 TypeScript；不以编译产物行号冒充 TS 行号。
没有位于源码采集范围内的代码单独列出，不按零命中或已覆盖猜测。

## 已接受的补充场景

以下均来自既有 Bash spec 和本会话确认的行为。每个场景同时检查真实文件/进程事实与
provider-visible 结果，涉及 UI 的场景再检查 DOM。使用 case-local replay fixture 和
文件 barrier。新增 spec 先在 `manual-review/pending` 验证；2026-09-08 用户 review 后授权
将本次 Bash 输出及 Terminal 两个 spec 转正，转正不等同于加入 Docker preset。

| ID    | Setup / Action                                                                                                       | Assertions                                                                                                                                           | 状态     |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| BDO01 | 中文空格路径脚本，stdout/stderr 无换行，小输出与空输出/非零退出                                                      | 两流合并、编码完整、exit code 不丢失、小输出文件清理                                                                                                 | accepted |
| BDO02 | 正常前台输出超过 64 MiB                                                                                              | 完整文件保留、30000-byte 头部摘要、尾部完整；前台只显示正文，不附加提示或文件入口                                                                    | accepted |
| BDO03 | 两个独立会话的前台 Bash 同时产生超过 4 KiB 的多行输出；先结束一个再推进另一个                                        | 展开预览有界、另一任务仍更新、收起不显示输出、终态不残留预览                                                                                         | accepted |
| BDO04 | 后台 Bash 分段输出；运行时两次 TaskOutput，再自然退出查询                                                            | 运行时头读且可重复相同前缀，终态尾读；文件不截断                                                                                                     | accepted |
| BDO05 | 前台/后台分别真实写入恰好 5 GiB，跨检查周期后再写 1 byte                                                             | 等于阈值仍 running；严格大于阈值后 watchdog 终止；真实 producer 退出，结果保留 output-limit 诊断；后台只通知一次；137 的结构化赋值另由执行层测试验证 | accepted |
| BDO06 | 普通 Bash 运行中删除其拥有的输出文件后退出；准备时输出路径为目录                                                     | 读取失败有明确诊断；打开失败可见；下一次 Bash 可正常执行                                                                                             | accepted |
| BDO07 | 同一前台 Bash 经文件 barrier 分三次向 stdout/stderr 写出无换行文本；展开态连续更新前两段，收起期间产生第三段后再展开 | 每段文件及展开预览均先更新，producer 仍活着、工具仍 in_progress、无最终 tool_result；最后放行才退出，结果包含三段且进度消失                          | accepted |

### BDO07 实时刷新时序

这里的实时性指命令运行期间的秒级更新。子进程直接写输出 fd；CLI 约等待 2 秒后订阅
共享的 1 秒轮询器，每次有界尾读 4 KiB，经既有 progress/projection 推送到 Desktop。
不承诺逐字节推送，也不绕过子程序自身的用户态缓冲。用例 producer 直接写 fd，不依赖换行触发 flush。

```text
producer 写第 1 段 -> ready -> 文件 + 展开预览已更新且仍 running -> release 1
producer 写第 2 段 -> ready -> 展开态自动刷新且仍 running       -> 收起 -> release 2
producer 写第 3 段 -> ready -> 文件更新、收起态无正文           -> 再展开看到新内容 -> release 3
producer 退出     -> 最终 tool_result 包含三段 -> 终态进度清除
```

每个 release 只在相应断言成功后写出；无法刷新时进程不会主动退出，测试不得依赖最终结果回填。
首段明确展开卡片，第二段保持展开且不点击以验证自动刷新；随后收起，第三段仍写入文件，
收起的卡片不得显示输出，再展开必须看到新内容。前台实时刷新在展开状态下验收。
首次预览的 E2E 等待预算为 8 秒，后续两次为 5 秒（允许 CI 调度裕量，不是新的产品 SLA）。
记录从写入到文件首次观察、可见预览首次观察的延迟到 run artifact 的
`bash-realtime-refresh.json`。UI 通过可见文本断言，状态与最终结果分别使用工具块和
provider-visible tool_result 核对，不注入进度事件、不使用 TaskOutput 触发刷新。
第三段的预览观察延迟包含人为保持收起及再次展开的耗时，不能当作纯轮询延迟。

大文件用例按顺序运行，测试负责删除本次拥有的输出文件；不填满系统磁盘。磁盘剩余空间不足
时明确记录环境阻塞，不能将未执行的 5 GiB 场景记为通过。
BDO 使用普通 128000-token E2E 上下文窗口；不得套用 pending 默认的 240/80 compact
故障注入，否则会在 Bash/TaskOutput 之间插入本组已剪枝的自动压缩。

打开失败检查模型可见的系统错误诊断，不假定启动失败具有进程退出码或非零退出的
`is_error` 映射。Terminal Stop 的前置条件及终态检查真实 Bash 卡片：当前 UI 不为单个
Bash 创建父分组；两个连续命令的父分组统计由同 spec 第一条用例验证。
BDO02 展开长摘要后等待正文可见，确认无截断提示和文件入口；完整文件保留通过 provider 结果与文件读取验证；
BDO03 明确展开卡片并等待预览文案；切回会话后同样先明确展开。
并发进度用例不隐含验证跨会话的卡片展开状态恢复。
元素已挂载/可见不代表展开动画和滚动布局已稳定，
不能把这一窗口中的 WebDriver 空文本当作产品缺失内容。

## 回归清单与边界

2026-09-08 用户收窄范围：仅回归与 `9c99f9623c` 直接相关的 Bash 行为。初次按 Bash
关键词选取的 26-spec 扩展批次范围过大，已中止，不作为本次验收集或修复范围。
验收集为 background spec 中的 Bash 前后台/子代理/停止场景、V4 background-work 中的
Bash cancel、Terminal 输出与终态代表，以及 BDO01–BDO06 新增用例。不运行通用
Memory、Native Search、权限注册、fork、compact、CUA 或 subagent 配置套件。
通用 pipe collector 的未覆盖行只由一个既有 Hook lifecycle 代表验证共享执行入口，
不扩展到整个 Hook 功能套件；无法从 Bash 产品入口触发的分支单列。

Windows 专属 taskkill/flags、无法通过正常产品入口触发的重复 unsubscribe、延迟回调竞态、
系统 ENOSPC/inode 耗尽等分支不能用 macOS Desktop E2E 的数字宣称覆盖。保留相应跨平台实跑/
底层确定性测试证据，并在最终报告列出剩余未覆盖行与原因。旧协议兼容校验不强行从 V4 UI 触发。

## 2026-09-08 验证历史

以下 run 记录保留当时的展示合同；2026-09-09 起按用户要求改为仅展开时显示输出，
历史“收起态预览”结果不作为新展示合同的验收证据。

## 基线

`bash-coverage-baseline-20260908`：现有 background spec 25/25 通过，四域采集完整。
改动语句起始行：CLI 204/268（76.12%），Renderer 13/14（92.86%）；
Host/Main 各 3/7（42.86%），其中未命中的四行属于旧协议结果校验。
以下最终统计加入补充用例和两个相关 UI spec。

## 最终结果（2026-09-08）

本机 macOS / Node 24.14.0 / Electron 实跑：

| 验收集                                         | 用例 | 结果    | artifact run ID                   |
| ---------------------------------------------- | ---- | ------- | --------------------------------- |
| 既有 `conversation-session-background.test.ts` | 25   | 25 通过 | `bash-coverage-baseline-20260908` |
| 新增 BDO01–BDO06（前后台上限分别一条）         | 7    | 7 通过  | `bash-output-final-20260908`      |
| Terminal 展开结果、单条 Bash Stop              | 2    | 2 通过  | 同上                              |
| V4 Bash 后台面板取消                           | 1    | 1 通过  | 同上                              |

两次验收 run 均正常退出，四域 `coverage/summary.json` 均为 `complete=true`。
共 35 个用例通过；其中 7 个新增，另外修正了既有 Terminal Stop 用例仍等待单工具父分组的过期断言。
未修改生产源码。新增 BDO spec 与本轮已验证的 Terminal spec 按用户授权迁至正式目录，
沿用 case-local fixture；正式路径的 default replay 和 fixture 隔离验证均通过。
Terminal fixture 同步补齐本 case 的自动标题响应，避免隔离回放依赖 legacy 标题 fixture。

### 转正复验

正式路径隔离回放 `bash-formal-isolated-r4-20260908`：9/9 通过，退出码 0，
无缺失 provider fixture。仅加载 common 和本次两个 case 的 fixture。
默认回放 `bash-formal-default-20260908`：9/9 通过，退出码 0，无缺失 provider fixture。
两次均覆盖前台/后台各一次真实 5 GiB 输出边界；没有启用用例重试。
转正过程中的前三轮失败保留为诊断记录，不计入通过证据：
`bash-formal-isolated-20260908` 与 `bash-formal-isolated-r2-20260908` 发现展开后立即读取
可见文本的竞态；`bash-formal-isolated-r3-20260908` 的运行态日志已有完整长预览，
测试却只查询收起态短预览。当前测试显式建立展开/收起前置状态，并等待实际文案，
没有改动生产渲染或降低行数、字节数和输出内容断言。

### Production 改动行覆盖率

| 本次提交的改动语句起始行            | 基线            | 最终                |
| ----------------------------------- | --------------- | ------------------- |
| CLI（包括共享执行分支及旧协议校验） | 204/268，76.12% | **212/268，79.10%** |
| Renderer                            | 13/14，92.86%   | **14/14，100%**     |
| Host                                | 3/7，42.86%     | 3/7，42.86%         |
| Main                                | 3/7，42.86%     | 3/7，42.86%         |

核心文件 `bash-file-output.ts` 为 80/83；`bash-output-preview.ts` 为 14/14；
`bash-progress-poller.ts` 为 23/23。三者共 **117/120，97.50%**。
这些是明确限定口径的改动行命中率，**不是全仓覆盖率、分支覆盖率或跨平台覆盖率**。
类型字段、对象属性、JSX 属性的修改可能没有新的语句起始行，相关语义仍由产品断言验证。

机读统计和可重算脚本位于最终 artifact：

- `packages/desktop/.e2e-artifacts/bash-output-final-20260908/coverage/bash-change-coverage.json`
- `packages/desktop/.e2e-artifacts/bash-output-final-20260908/coverage/analyze-bash-change-coverage.mjs`

### 尚未由通过的 Bash E2E 命中的改动行

以下 adapter 文件均在 `apps/zcode-cli/packages/adapters/src/exec/`；行号对应目标提交。

| 文件                                          | 未命中行                                                   | 原因 / 证据边界                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `bash-file-output.ts`                         | 60、194、197                                               | 准备后取消/spawn 失败的 owned-file 删除；磁盘容量/inode 耗尽诊断。没有耗尽宿主机文件系统来刷覆盖率 |
| `node-execution-adapter-lifecycle.ts`         | 40、62                                                     | 独立 `start()` API；普通 Bash 产品入口使用前台执行及 commit 后台路径                               |
| `node-execution-adapter-process.ts`           | 127–130、132、134、136–137                                 | Windows taskkill；macOS E2E 无法声明覆盖                                                           |
| 同上                                          | 184、188–193、209–210、213–215、217、229、231–233、235–236 | 保留的通用 pipe、stdin、drain 路径，普通 Bash 已绕过                                               |
| `node-execution-adapter-run.ts`               | 192、314                                                   | open 完成后的取消窗口、spawn error；由执行层确定性测试补充                                         |
| 同上                                          | 278–280、284–287、298、300、306、312                       | 通用 pipe progress / drain / collector close                                                       |
| `output-collector.ts`                         | 81–83、88、133、141、171                                   | 通用 collector 保留分支，普通 Bash 不再创建 collector                                              |
| `packages/shared/src/zcode-protocol/index.ts` | 141、144–146                                               | 旧协议结果校验；V4 Desktop 入口不触发。CLI/Host/Main 中均未命中                                    |

仅为共享 pipe 选取的既有 `HK-LC-01` 在 `bash-output-compat-r5-20260908` 中完成了
stdin/输出及 provider-visible Hook context 断言，随后因 UI 在英文环境显示 `Hooks`、
旧测试硬编码期望 `钩子` 而失败。该用例没有记为通过，也**未合入以上验收覆盖率**。
若只计算该运行轨迹带来的额外命中，CLI 为 231/268（86.19%），这个数字仅用于定位剩余分支，
不能替代通过的 E2E 证据。本轮不修改无关的 Hook 国际化断言。

### 校验与复跑

`pnpm typecheck`、`pnpm lint`、Desktop `typecheck:e2e`、fixture check、conversation coverage
audit 均通过。lint 有 43 个既有 warning，无 error；新增文件无 lint warning。
replay helper 单测为 14 通过、1 个平台跳过；6 个 Bash adapter 契约测试文件为 35 通过，
补充验证 flags、取消竞态、137/output_limit、进度调度和进程清理，不计入 E2E 覆盖率。
fixture check 唯一提示为 response-only 的 `E2E_BDO_QUERY_NOTIFIED` 未作为输入 matcher，
实际 notification matcher 和完成断言已通过。

从仓库根目录运行两个正式 spec（加入 BDO07 后为 10 条用例，不使用全局 preset）：

```bash
ZCODE_E2E_COVERAGE=1 \
pnpm --filter @zcode/desktop test:e2e -- \
  --spec ./test/e2e/conversation-session/tools/conversation-session-bash-direct-output.test.ts \
  --spec ./test/e2e/conversation-session/tools/conversation-session-tool-groups-history-restore.test.ts
```

隔离 replay 在同一命令前设置 `E2E_PROVIDER_REPLAY_FIXTURE_PATH` 为
`packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-bash-direct-output.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-tool-groups-history-restore.json`。
V4 background-work 的本次证据仅取 Bash cancel 单条；不把整个文件中的其它场景算入验收集。

最终 run 复用了同一工作区、同一 coverage 配置下已完成的 Desktop/CLI 构建，以
`ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1` 直接执行 `wdio run wdio.conf.ts`。
首次回归和修正测试配置后的回归均走过完整构建；没有使用其它 checkout 的产物。
本轮没有跑 Windows/Linux Desktop E2E，也没有跑手机 replayable 或 TUI。

### BDO07 增量验证（2026-09-08）

`bash-realtime-targeted-r2-20260908`：仅 BDO07 的真实 Electron 隔离 replay，1/1 通过。
三段原始文件首次观察延迟分别为 36/80/84 ms，预览首次可见分别为 2994/898/708 ms。
这是本机一次运行的观察值（含 E2E 轮询开销），不代表 fsync 持久化延迟或跨平台性能保证。
每段观察时 producer 仍存活、工具仍 running、没有 tool_result；最终放行后结果完整，
进度清除，主模型请求总计两次（工具调用与结果续答），没有 TaskOutput 或额外 prompt。
最初 `bash-realtime-targeted-20260908` 因首次进度时卡片处于展开态而等待短预览失败；
现场日志已含原始输出和长预览。用例改为首段预览到达后明确收起，再无交互地观察后续增量。
整组首轮 `bash-realtime-regression-20260908` 中 BDO07 再次通过，但 BDO03 切回会话后
只查询短预览而现场卡片已展开，整组为 7/8；此轮不算整组通过。补齐切回后的收起前置操作，
不将卡片展开状态恢复纳入并发进度合同。
最终 default replay `bash-realtime-regression-r2-20260908`：同一 Bash 输出 spec **8/8 通过**，
无缺失 fixture；BDO07 三段文件观察延迟为 85/92/107 ms，可见预览为 3098/866/478 ms。
定向隔离及整组最终 run 均退出码 0、四域 coverage 完整。证据在各 run 的
`test-results.ndjson`、`bash-realtime-refresh.json`；不重算或替换前述 production 改动行覆盖率。
本次仍仅为 macOS Desktop 验证，未新增 Windows/Linux 或手机端验收声明。

仅复跑新用例（保留同一 wrapper 的 HOME/artifact 隔离；不增加额外 `--` 以免 grep 被忽略）：

```bash
pnpm --filter @zcode/desktop test:e2e \
  --spec ./test/e2e/conversation-session/tools/conversation-session-bash-direct-output.test.ts \
  --mochaOpts.grep BDO07
```

## 2026-09-09 展开区域回归

收起态预览由 `9c99f9623c` 新增：`ToolLayout.collapsedContent` 绕过详情区域，
最终截断提示和文件路径同样在详情外渲染。按用户要求删除这一专用入口，
预览、最终正文、截断提示和文件链接统一放入既有展开区域。收起态恢复为命令摘要与状态；
展开区域继续实时更新，不改变 CLI 写文件、轮询和协议字段。

先更新 spec 和断言；修复前 UI 测试准确复现两处问题（收起态运行预览、终态提示仍渲染），
修复后 3 个相关 UI 测试文件共 16/16 通过。
真实 Electron 隔离回放 `bash-expanded-only-20260909`：BDO02、BDO03、BDO07、BG14
共 **4/4 通过**，未重试，退出码 0，四域 coverage `complete=true`。
仅加载 common、Bash direct output 和 background case-local fixture；没有扩展到全局套件。

- BDO02：终态收起不渲染正文、提示、路径；展开后头部摘要、截断提示与真实文件链接可用。
- BDO03：展开时两个独立会话持续更新，收起后无输出；一个任务完成不影响另一任务进度。
- BDO07：展开时前两段自动刷新；收起期间跨过一次真实进度轮询仍无输出节点，
  再展开看见第三段，最终结果后再次收起仍无输出节点。
- BG14：收起不显示预览，展开后多行输出可见，foreground loading 与终态清理保持正常。

BDO07 前两段文件/预览首次观察延迟分别为 159/3374 ms、78/595 ms；
第三段为 90/1562 ms，其中预览耗时包含主动保持收起和重新展开，不能解释为纯刷新性能。
机读证据位于该 run 的 `test-results.ndjson`、`bash-realtime-refresh.json` 和 `coverage/summary.json`。
不重算或替换上文 `9c99f9623c` 的改动行覆盖率。

根 `pnpm typecheck`、`pnpm lint`、Desktop `typecheck:e2e`、两份 fixture check 及
conversation coverage audit 均通过。lint 保留 43 个既有 warning、0 error；fixture check
保留既有 response-only marker 提示。验证环境为 macOS / Node 24.14.0 / Electron。
共享 UI 组件沿用同一展开边界，未修改 Desktop continuous 或手机 replayable 消息链路；
本次未运行手机、Windows/Linux Desktop 或 TUI E2E。

## Replay 动态后台 ID

case-local fixture 可用 `{{latestBashTaskId}}` 引用当前 provider request 中最后一个
`Command running in background with ID: ...` 的真实 Bash task ID，用于 TaskOutput/TaskStop。
只消费已存在的模型可见工具结果，不伪造 runtime/task registry 状态；没有 ID 时保持 token
未替换，令缺失前置条件显式暴露。既有 `latestAgentId` 保持独立。
