# Bash Background Parity

后台输出查看新增独立的按需查询与右侧详情，不恢复前台 progress 推送；完整合同和
BGV01–BGV06 验收见 [后台 Bash 输出详情](background-bash-output-details.md)。

本文记录 `local_bash` background 行为与输出传输的当前实现边界，包括文件打开方式、
输出上限与根进程结算；未列为本次变更的工具 schema、timeout 与 owner scope 策略保留既有合同。

## 行为

- foreground Bash 默认等待预算为 `120000ms`，默认最大值为 `600000ms`。bootstrap 支持
  `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`，并把同一 timeout policy 注入 prompt、
  schema、handler 和 tool executor cleanup watchdog。两个 env 均按十进制
  `parseInt` 语义解析；合法 max 取 `max(configuredMax, default)`，仅缺失或非法 max 才回退
  `max(600000, default)`。
- 当 foreground Bash 到达 timeout 且命令可 background 时，运行中的子进程不会被 kill，而是被移交为 background task。
- 首个原始 token 为 `sleep` 的命令不进入 timeout auto-background，仍按普通 foreground timeout 路径处理；因此 `sleep 1` / `sleep 1; echo` 不 eligible，而 `echo x; sleep 1` / `FOO=1 sleep 1` eligible。
- timeout auto-background 是 Bash 自有执行路径；它复用已有 background task events、task notification enqueue、runtime wake 和 runtime command queue，不在 `ExecutionPort` 上暴露通用 foreground promotion 方法，也不改变通用 `ExecutionPort.start()`。
- timeout auto-background 的 Bash tool result 返回：
  - `status: "backgrounded"`
  - `backgroundTaskId`
  - output file path
- timeout auto-background 不设置 `assistantAutoBackgrounded`，模型看到的是普通 background task 文案，不是 assistant blocking-budget 文案。
- 普通 Bash 在 spawn 前异步打开 canonical output 一次，stdout/stderr 继承同一个 fd；
  spawn 后关闭父 fd，子进程直接写文件。前台、显式后台、超时转后台及 subagent Bash
  共用此路径；不创建 Node collector、WriteStream、逐 chunk decoder 或输出 data listener。
  通用 argv/Hook 保留双 pipe、分流结果与原有 collector 合同；collector 仅使用通用 inline 预算。
  Bash 请求不下发 collector 专用的 `killProcessOnPersistedLimit`，文件 watchdog 在前后台始终生效。
- 文件 flags 按宿主平台选择：macOS/Linux 使用
  `O_WRONLY | O_CREAT | O_APPEND | (O_NOFOLLOW ?? 0)`，不包含 `O_TRUNC`，不提前清空或删除
  已有普通文件；Windows 使用 `"w"`，包括 Git Bash 与 CMD，不添加 append/no-follow。
  POSIX 新文件继续以 `0600` 创建。前后台切换只移交所有权，不重开文件、不迁移输出。
- 文件从启动即存在，Bash 的 `persistOutput` 表示结算后的保留策略。打开失败按
  `spawn_error` 结算，不发布后台任务；准备期间取消会关闭 fd，仅删除本次创建的文件。
  文件读取失败返回明确诊断，不伪装成正常空输出；清理失败不阻塞结算。
- 前台等待约 2 秒后每 1 秒读取最多末尾 4096 bytes，复用 progress 事件；后台提交停止
  前台轮询，Read/TaskOutput 按需读取文件。最终 stdout 默认读取头部 30000 bytes，
  沿用 `BASH_MAX_OUTPUT_LENGTH`，最大 150000 bytes；文件保存原始字节，读取时有界解码。
- root shell `exit` 即触发有界读取与单次结算，不等待 pipe EOF、文件大小稳定或后代结束，
  正常结算不主动杀后代。后代仍可继续写文件，但不会重新激活任务、补发完成通知或继续
  运行大小 watchdog。调用方需要输出完整结束时，应让 root shell 等待自己的 worker。
- 前后台都每 5000ms stat canonical output，严格 `size > 5368709120` 时请求终止进程树。
  这是 5 GiB 软阈值，没有写盘硬截断；接受检查间隔内超量和首次检查前自然结束的命令，
  不增加终态补判。后台提交重启 watchdog，终态清理 watchdog；检查失败不伪判超限。
  超限结果为 cancelled/interrupted、exit 137、`error.type=output_limit`，提示
  `Command killed: output file exceeded 5GB`。取消、硬超时和超限仍复用平台进程树终止，
  异步杀树收尾由 adapter 跟踪；终态后不再推送迟到进度或发起重复终止。
- 关闭保障：Stop 的结果仍可先结算；adapter `close()` 必须为已登记的杀树操作保活，直到
  POSIX 的 1500ms SIGKILL 升级及该轮 PPID 快照/信号发送完成，或 Windows taskkill 收尾。
  不能只等待 Promise：直写后没有 pipe 保活，unref 定时器可能随父 Node 提前退出。
  仅 shutdown 引用现有清理句柄，不新增常驻轮询；不恢复正常根退出后的 drain/杀后代。
  回归用独立 Node（无 IPC/额外保活）覆盖取消后关闭、直接关闭、后台 Stop、硬超时和超限。
- 前台小输出读回后尽力删除冗余文件；普通大输出保留完整 canonical output，返回有界头部
  摘要和完整文件路径，不再执行 64 MiB artifact 截断。Bash 忽略 `maxArtifactBytes`；
  通用 argv/Hook 原有预算不变。记录读取时的原始大小。前台超限终止后读回摘要并尽力删除
  超限文件，后台文件保留。
  `persistOutput="always"` 的正常空输出仍保留零字节 artifact。
- 终态 stdout 为空、非零退出且不是 exit 137 时，继续对 output file 所在目录执行
  `statfs`；可用空间低于 10 MiB 或 inode 少于 1000 时返回现有输出丢失诊断。
- 显式 `run_in_background: true` 在进程启动成功后立即完成 background commit，并复用同一套 completion / notification 链路。调用里即使带有短 `timeout`，该值也只表示提交前的 foreground deadline；commit 会清除 deadline 并解绑 parent turn abort，后台进程不会在原 timeout 到达时被杀。
- explicit 与 timeout-promoted Bash 共用一个 adapter lifecycle 状态机和单任务 `5GiB`
  canonical output 软阈值；completion、deadline、abort 与 output-limit 竞争只能产生一个
  foreground result 或一个 background task。
- main/session scope 的 background task 只有 `cancelBackgroundTask`、adapter/session
  `close()`，定时 output-limit watchdog 才可以终止进程树。root shell 已退出后任务终态不再持有后代。
- `subagent_child` scope 沿用上述 background 行为，另外保留两条 owner 生命周期约束：background
  Bash 默认最长运行 `3600000ms`（可由内部 subagent runtime 配置覆盖）；owner subagent
  被取消时会清理其仍在运行的 background Bash。owner 正常完成不会仅因完成而终止已提交任务。
  因此这里的 detached 只表示脱离 foreground deadline 和 parent turn abort，不表示脱离
  adapter/session 或 owner subagent 的进程所有权。
- background Bash 完成后由 execution adapter 的 completion promise 直接 settle，tool executor 通过既有 background notification enqueue 进入 runtime command queue 唤醒 main agent。
- 普通后台 tool result 只包含 canonical output path，不附加 `Stdout:` / `Stderr:` 路径。
- `local_bash` task notification 使用 provider-visible XML，不带 system notification 前缀、
  `<task-type>`、split path、result 或 error 字段，只包含 `task-id`、可选 `tool-use-id`、
  `output-file`、`status` 和 `summary`。

## 暂不支持

- 手动把正在 foreground 执行的 Bash 转为 background。
- provider-visible `background_tasks` control request。
- `backgroundedByUser` 的真实可达路径。
- 2 秒后提示用户可手动 background 的 UI/UX。
- 跨 Bash/Agent/schema 的全局后台任务开关。

## 多端边界

2026-09-07 补齐进度合同：每次从同一份 4 KiB 尾窗提取最近 5 行短预览、最近 100 行长预览，
全文件进入尾窗时直接计数，否则按总字节/读取字节比例估算总行数并保持估算值不回退。

```text
direct file -> bounded tail -> ExecutionEvent.outputPreview -> ToolCallProgress
  -> V4 ToolCallRow.outputPreview -> Execute renderer
       +-> collapsed: command summary and status only
       +-> expanded: last 100 lines
  -> result/error/background/turn end: clear preview
```

`outputPreview` 是可选的有界最新输出状态，含 `text`、`fullText`、`totalLines`、`totalBytes`、
`linesEstimated`；沿 ExecutionPort、session event、legacy tool.updated schema 和 V4 row 传递。
V4 只更新已有 running Bash 行；迟到进度不创建行、不复活终态。父会话不物化镜像 subagent 工具，
child conversation 正常更新。旧 snapshot 缺字段仍可读。
2026-09-09 用户修正展示合同：共享 Execute renderer 收起时只显示命令摘要和状态；
实时预览和最终输出只在展开详情内渲染；2026-09-10 调整为仅展示正文，不再附加截断提示和完整文件入口。预览正文保留最近 100 行，视口最多显示 5 行，
终态清除进度；CLI 的 5/100 行预览及行数/字节数事件保持不变。TUI 不在本轮范围内。
不复用 replayable-only `progress` 恢复字段；通过现有 row delta/snapshot 交付，桌面 continuous
不增加恢复队列，手机 replayable 不绕过 gap/snapshot。

验收补充：真实大于 64 MiB 输出验证完整保留、头部摘要、尾部 sentinel；预览覆盖空输出、无换行、
CRLF、超 100 行、部分尾窗、估算单调和终态迟到。V4 覆盖两种 profile、终态清理及 subagent 隔离；
Desktop BG14 以分段输出与放行 barrier 验证收起无输出、展开实时预览、不显示计数和终态清理。

执行能力位于 zcode-cli runtime/tool/execution adapter；共享协议增加可选有界 outputPreview 与 bash_output 结果 display；Desktop 复用共享 Execute renderer，使用语义颜色与窄屏换行，不新增端专属传输逻辑。desktop continuous 与 mobile replayable 的 task command / snapshot 边界不变；background completion 仍通过 runtime command queue 消费，不新增并发 `executeTurn` 入口。

## 前台输出视口与跟随（2026-09-10）

- 展开后的输出按实际内容占高，最多显示 5 行（包含自动换行），超出后滚动；运行与终态共用同一容器及行高，不固定短输出的高度。
- 前后台输出滚动区域复用共享 `ScrollFadeViewport`（由现有反馈滚动组件提取）的 24px 上下渐隐。
  CSS mask 固定在滚动视口边缘，文字滚动经过边缘时逐渐透明；不随正文一起滚动。
  仅仍有内容隐藏的一端淡出：短输出无 mask，到顶只淡出底部，到底只淡出顶部，中间两端淡出。
  mask 只作用于正文，不遮挡命令或后台顶部状态/悬浮操作，不增加轮询或改变原有跟随状态。
- 首次预览沿用约 2 秒订阅延迟及共享 1 秒 tick；每次收到新的有界预览即更新 UI，
  不增加前端定时器、输出累积缓存或模型请求。没有新字节时不承诺内容发生变化。
- 默认吸底；内容替换、尾窗淘汰、换行数量变化及程序滚动不能取消跟随。用户向上滚动离开底部后，
  冻结当前有界文本与阅读位置；滚回底部应用最新文本并恢复吸底，不展示“回到最新”按钮。
- 结束时仍最多显示 5 行；跟随状态显示最终摘要，暂停状态保留正在阅读的文本，滚回底部后显示最终摘要。
  收起/再次展开沿用详情卸载语义，重新展开从最新内容开始。前台不增加“Full output”路径、截断提示等附加区域。
- UI 的局部跟随状态由单个输出组件拥有；CLI 文件、共享轮询、V4 row 更新、background 查询、
  Stop/通知以及 desktop continuous / mobile replayable 交付边界不变。共享 UI 使用原有主题 token、
  国际化与窄屏换行，不增加端专属链路。
- 2026-09-11 恢复组件内的简单滚动判断：输出更新时仅在跟随中吸底并记录实际位置；
  `scroll` 中向上离开底部则暂停，到底（8px 容差）则恢复。不引入输入意图有效期、布局保护定时器或共享滚动 Hook。
  已知边界：窗口尺寸变化使浏览器自动钳制到底时仍可能误恢复；本次回退不修复该问题，也不把相关场景计作已覆盖。

```text
file -> shared 1s poll -> V4 row -> latest text
                                   | following -> display latest -> scroll bottom
user scroll up --------------------+ paused -> frozen text
user scroll to bottom -------------+ following
terminal --------------------------+ same 5-line limit; preserve paused text
viewport scroll/resize ------------> shared fade mask (no change to following state)
```

验收沿用 BDO07：真实分段文件输出记录写入/DOM 更新时间，覆盖短输出自适应、多行输出最多 5 行、逐段更新吸底、
用户滚动后冻结、滚回底部恢复且无恢复按钮、收起不渲染及 running/terminal 使用相同行数上限。组件单测覆盖尾窗变短引发的
程序 scroll 不能误暂停、终态暂停与不同工具实例隔离；BGV 后台详情作为不变合同回归。

验证（macOS / Node 24.14.0）：修复前 `desktop-e2e-20260910-115819-131` 测得运行视口
256px、第二段距底部 1844px，而写入到 DOM 更新仅 910ms。当前 BDO07
`desktop-e2e-20260910-124047-804` 首段 1 行（20px），后续 5 行（100px），各段底部间距均为 0；
首段刷新 3014ms，后续无主动暂停的两段为 1012ms、408ms；收起/暂停阶段包含人为等待。
同次 BDO02/03/07、BG14 和 4 条 BGV 通过；子会话 BGV04 因 `mode.build.highRisk` 审批阻塞，
producer 未启动，清理 hook 随之失败，BGV05/06 未执行。三条在独立回放
`desktop-e2e-20260910-124514-441` 通过，合计 11 条相关 E2E 验证通过，不计作一次全绿运行。
19 项 UI 单测、根与 E2E typecheck、architecture、fixture check 通过；
lint 为 43 条既有 warnings、0 errors。本轮未执行 Windows/Linux Desktop 或真实手机远控 UI；
无可用 codegraph，影响面通过直接调用链及登记的源码 seed 核对。

上下渐隐验证：`desktop-e2e-20260910-142038-231` 的 BDO07、BGV03 共 2/2 通过。
真实窗口验证 CSS mask 有效、无溢出/滚动两端/中间方向正确，输出更新及暂停/恢复不变；
首段仍为 1 行，后续最多 5 行。共享 viewport、前后台跟随及反馈表单共 23 项单测通过，
typecheck、E2E typecheck、lint（43 条既有 warnings，0 errors）、architecture 通过。

## 共享前台进度轮询（2026-09-08）

- 同一 Node 进程中，相同 `progressIntervalMs` 的 Bash 共用一个进度 interval；产品默认
  全部为 1000ms，因此主会话及同进程 subagent 的前台 Bash 只有一个轮询器。不同进程各自管理。
  内部测试/adapter 自定义不同周期时按周期分组，不用最短周期轮询所有任务。
- 每个 Bash 保留约 2 秒的订阅延迟；注册后在共享轮询的下一次 tick 读取。首个任务仍约 3 秒
  得到首次预览；后来注册的任务加入既有 tick，不重启其他任务的定时器。
- 每个订阅独立维护读取中的状态及行数估计，同次 tick 分别异步读取至多 4 KiB。
  慢读取不阻塞其他订阅，也不叠加本任务的读取；读取或回调失败不终止共享轮询。
- 终态、Stop/取消、转后台移除订阅并取消尚未生效的延迟；重复停止幂等，迟到的读取结果不再
  发布进度，旧订阅的清理不能影响重新注册的订阅。最后一个订阅移除即清理 interval 和注册表。
- 共享轮询器只保留订阅状态，不缓存输出正文；计时器 unref。大小 watchdog 仍按原有每任务
  5 秒周期检查，不与进度调度合并。文件 flags、原始字节直写、头部摘要、保留策略、协议和 UI 不变。

```text
foreground delay -> subscribe -> shared interval (same process/cadence)
                                  +-> file A tail -> preview A
                                  +-> file B tail -> preview B
exit / background / cancel -> unsubscribe
last unsubscribe -> clear interval and registry entry
```

验收：fake timer 验证多订阅仅一个 interval、后来加入不重置 tick、单任务退出不影响其他任务、
全部退出释放定时器、重复取消与重订阅、慢读取/失败隔离、迟到结果丢弃、不同内部周期隔离；
真实文件测试验证并发 BashFileOutput 注册与读取、后台移交与 watchdog 独立。复跑 direct execution、
Desktop BG14（运行态预览及终态提示）和类型/lint 检查；continuous/replayable 的既有传输边界不变。

共享轮询验收结果：5 个 adapter 测试文件 149 passed / 3 平台分支 skipped；随后补充真实文件
重订阅后的迟到读取用例，focused 18 passed。Desktop BG14
`desktop-e2e-20260908-061858-748` 通过（8.5 秒），进度与终态提示均正常。
根 typecheck、adapter typecheck、根 lint 和本轮 adapter 文件显式 lint 通过；根 lint 保留 43 个既有警告。
本轮仅改变进程内进度调度，没有重跑 Windows/Linux 实机测试或性能对照；之前跨平台直写验证仍是
文件 flags/输出实现的证据，不作为本轮共享调度器的实机复验。TUI 和 Desktop 渲染代码未新增改动。

## Desktop Bash 摘要正文（2026-09-10）

- 原因：终态 V4 行复用模型摘要正文，BashOutput 的 stdoutTruncated/stderrTruncated 和
  canonical 文件路径没有专门的展示投影；模型 envelope 或协议 head/tail 的截断不能替代 Bash 事实。
- 通过现有 `ToolResult.display -> ToolOutput.display` 增加严格校验的 `bash_output` 分支：
  `output` 为有界头部正文（默认 30,000 bytes；合并展示最多 150,000 bytes）、`truncated` 为真实
  截断标志、`outputPath` 为可选的完整输出文件路径。仅部分输出或保留文件的普通终态 Bash 产生该分支；
  后台启动和图片结果沿用既有展示；不解析 provider envelope，不根据文本长度猜测截断。
- 前台展开只显示输出正文，不附加“Full output”文件入口、截断提示或计数。旧行缺少 display 时保留原有正文。
  `truncated` 和 `outputPath` 继续保留在既有协议中；CLI 的摘要/完整文件策略及后台详情文件入口不变。
- 运行态保留最多 100 行有界正文，视口最多显示 5 行；收起后不显示正文，后台、终态清除运行态预览。
- 不改变 provider-visible 内容、执行/保留策略和 TUI；可选 display 沿既有 continuous/replayable
  row delta 与 snapshot 传递，不新增恢复队列或绕过恢复边界。

```text
BashOutput (bounded head + truncation + file path)
  -> ToolResult.display.bash_output -> V4 output.display -> Desktop
       +-> head text
       +-> no additional notice or file link in foreground details
```

验收：单位测试覆盖有/无文件及截断元数据均不产生附加 UI、终态与历史正文兼容；协议及双 profile 投影不变。
BG14 用 barrier 验证进度无计数，释放后输出超过 30,000 bytes，验证仅显示头部正文，provider 仍包含完整文件路径且文件尾部完整。

2026-09-08 验证：UI 25 项、shared wire 73 项、Core display/V4 progress projection 40 项通过；
Desktop BG14 最终 replay `desktop-e2e-20260907-171113-863` 通过。前两次验收分别因未展开完成历史、
读取展开动画中的空正文而失败；测试补齐真实展开动作并等待提示文案/路径就绪，未改变产品生命周期。
模型仍收到原有 persisted-output 小摘要，Desktop 使用独立的默认 30,000 bytes 头部；
本次没有重跑 Windows/Linux 执行测试，执行器、flags、watchdog 和文件保留代码未新增改动。

## 2026-09-08 CLI 补齐验收

- 本轮取消普通前台 64 MiB artifact 截断，补齐 5/100 行与估算总行数的 CLI 事件/投影；
  Desktop 渲染与 BG14 验证一并保留，TUI 不改，原有 TaskOutput 读向及进程生命周期不变。
- 真实 65 MiB + 8 bytes 输出验证完整长度、30,000 bytes 头部摘要与尾部 sentinel；
  macOS/Linux Node 24 各 10 项、Windows Git Bash/CMD Node 24 与 Node 25 各 20 项通过。
- Desktop 渲染恢复后 UI focused 3 passed，BG14 真实 Bash E2E 通过；展开断言等待目标正文就绪，避免读取动画中间态。
- Agent 10 文件 461 passed / 3 平台分支 skipped；shared wire/coalescing 36 passed。
  typecheck 通过；根 lint 无错误、43 既有警告。显式取消 Agent ignore 的检查仅有
  bash.ts/product-projection.ts 两项基线已有 max-lines，均已对 HEAD 复核且本轮行数减少。
- 本轮未重复实写 5 GiB、未重测性能；5 秒软阈值及边界由回归测试锁定。
  下方性能表是取消 64 MiB 截断之前的历史结果，不作为本轮新测数据。

## 本次验收与性能

- flags 测试覆盖 darwin/linux/win32；预置文件证明 POSIX 追加、Windows 截断，POSIX symlink
  不被跟随；前后台提交只打开一次。Windows 旧 append 失败保留为负对照，
  可用 `apps/zcode-cli/packages/adapters/tests/fixtures/bash-windows-flags-probe.cjs` 独立复现。
- 分段 barrier 证明退出前可读；覆盖无换行、中文空格路径、stdout/stderr、二进制、并发后代。
  生命周期覆盖 foreground/explicit/timeout promotion/subagent、parent abort/Stop、单次通知；
  root 先退出案例由测试清理后代，不能再断言终态文件稳定。
- 用可控时钟和文件大小验证 watchdog 周期、等于/超过阈值、终态竞争和读取/清理失败。
- 实际 adapter 验证 Windows Node 24.14.0 + Git Bash/CMD，Node 25 做对照；macOS/Linux
  使用对应 append flags。更新相关产品 E2E，运行受影响单测、typecheck、lint。
- 性能基准使用同机同 Node 的旧/新 adapter：每任务 256 MiB、并发 1/4、各至少三次，
  记录父 Node 峰值 RSS、heap/external、CPU 与耗时，不将文件上限当作内存节省量。

### 2026-09-07 实测结果

- 受影响单测覆盖 adapter、Bash/TaskOutput wire、core conformance 与 background output；
  209 项通过、8 项平台跳过；完整命令保存在本工作区 `.tmp/bash-direct-file-validation/implementation-report.md`。
- 实际 adapter：macOS arm64 / Linux arm64（Docker）Node 24.14.0 各 8/8；
  Windows x64 Node 24.14.0 和 25.9.0 各 16/16，分别覆盖 Git Bash 与 CMD。
  Windows 默认 Node 未切换，24.14.0 使用独立 portable 路径；原始 append 负对照见
  `.tmp/bash-direct-file-validation/windows-node24-report.md` 与 `windows-node25-report.md`。
- Desktop formal replay：三组共 9 次通过、8 个不同场景，覆盖自动/显式后台、实时落盘、
  单次完成通知、Stop、后台解除 parent abort、前台 Bash/subagent loading、硬超时及嵌套后台 Bash 的 child cleanup。
  产物：`desktop-e2e-20260907-121229-740`、`desktop-e2e-20260907-121411-528`、
  `desktop-e2e-20260907-123006-030`。
- `pnpm typecheck`、`pnpm lint` 与 conversation coverage audit 通过。根 lint 配置排除
  `apps/zcode-cli`，因此额外用相同规则对本次 Agent 变更显式 lint（移除该忽略项）。
- 真实测试没有跑满 5 GiB 或填满磁盘：阈值和竞争用可控文件大小/时钟验证，输出丢失诊断
  用故障注入验证。未覆盖 Windows arm64、全部 Git/MSYS 版本或手机真实远控重连；本次
  未改 App–Agent schema、desktop continuous 和 mobile replayable 路由。

性能脚本：`apps/zcode-cli/packages/adapters/tests/fixtures/bash-output-benchmark.cjs`。
每个样本启动独立父 Node，先预热再 GC；每任务输出 256 MiB，并发 1/4，各三次，旧/新
交替运行。两端均为 Node 24.14.0、Git Bash/系统 Bash；旧实现取变更前 `65ed641886`。
以下为取消 64 MiB 结算截断前的历史性能对照，当时两者均验证原始字节数、30,000 bytes 返回摘要及 64 MiB artifact。下表为三次中位数；本轮完整文件保留不沿用该 artifact 验收条件，
RSS 增量表示相对预热后的父 Node 基线，CPU 仅计父 Node user + system：

| 主机 / 并发 | 峰值 RSS 增量 MiB：旧 → 新 | heapUsed 增量 MiB：旧 → 新 | external 增量 MiB：旧 → 新 | 父 CPU ms：旧 → 新 | 耗时 ms：旧 → 新 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Windows / 1 | 78.08 → 0.55 | 38.84 → 0.51 | 66.79 → 0.07 | 1063 → 31 | 1204 → 393 |
| Windows / 4 | 110.49 → 0.32 | 41.39 → 1.31 | 74.67 → 0.16 | 4703 → 172 | 3787 → 665 |
| macOS / 1 | 190.50 → 0.39 | 46.85 → 0.54 | 80.89 → 0.07 | 330 → 11 | 323 → 213 |
| macOS / 4 | 377.03 → 1.03 | 55.61 → 1.56 | 110.11 → 0.16 | 1348 → 68 | 749 → 973 |

本负载的父 Node 输出处理 RSS 增量下降约 99.3%–99.8%，CPU 明显减少；不是整个 Agent
内存下降 99%，也不包含子进程或 OS 文件缓存。5ms 采样可能漏掉短暂峰值，不同内存指标
的峰值不一定同时发生。macOS 四并发耗时中位数反而增加约 30%，其中一次新实现耗时
3964ms；因此不能据此承诺总执行耗时必然改善。原始样本保存在 `.tmp/bash-direct-file-validation/`
下的 `windows-memory-results.json` 和 `macos-memory-results.json`，包含绝对 RSS 峰值、
heap/external、CPU、耗时及每次重复编号。
