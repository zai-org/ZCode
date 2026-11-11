# Agent 进程崩溃 ARMS 上报

## 目标

桌面端 Host 拉起的 ZCode Agent 是普通 Node 子进程，不属于 Electron
`child-process-gone` 自动采集范围。Agent 非预期退出时需要由现有
`RuntimeProcessLifecycleReporter` 主动把崩溃事实送到 desktop main，再由 main
调用 ARMS `sendCustom`。

本功能同时满足：

- `perf_agent_start.value=1`，作为 Agent runtime 级崩溃率的分母。
- `perf_agent_ready.value=1`，表示同一 runtime 已通过 provider/model 门禁并可执行模型。
- `perf_agent_crash.value=1`，用于统计 Agent 崩溃次数。
- 原始事件保留脱敏、限长的错误信息，支持按错误码和稳定指纹聚合。
- 主动关闭、workspace 重启、应用退出不计为崩溃。
- 手机远控继续复用桌面 shared host，不在 relay 或 Web 端重复上报。

## 状态与时序

```text
Agent stderr
   │
   ├─ Node spawn 成功
   │    └─ host IPC → desktop main → perf_agent_start
   │
   ├─ Agent service 通过 provider/model 门禁
   │    └─ ProcessManager.markReady（每个 runtime 幂等一次）
   │         └─ host IPC → desktop main → perf_agent_ready
   │
   ├─ Host services：脱敏并保留最后 20 行
   │
   └─ Agent exit
        │
        ├─ terminationIntent=expected
        │    └─ 只做进程登记清理，不发 perf_agent_crash
        │
        ├─ terminationIntent=watchdog_recycle
        │    └─ request timeout 回收，不混入 crash
        │
        ├─ desktop lifecycle=app_quit/update_install
        │    └─ main 已进入不可逆退出流程，不发 perf_agent_crash
        │
        └─ 无 terminationIntent
             └─ host IPC → desktop main
                  ├─ terminationReason=protocol-close
                  │    └─ 即使最终为 SIGTERM / 0x40010004，仍发 perf_agent_crash
                  │
                  ├─ 无结构化根因，且 exitCode=0x40010004 / signal=SIGTERM
                  │    └─ 受控终止噪音，不发 perf_agent_crash
                  │
                  └─ 其他 unexpected exit
                       └─ ARMS perf_agent_crash(value=1)
```

`protocol-close` 是 Agent 崩溃后常见的结果，不是主动退出意图，禁止据此把退出
标为 expected。

Desktop main 是应用退出生命周期的唯一事实源。`perf_app_exit` 发出后必须持续保持
`app_quit` / `update_install`，直到进程退出；Host IPC 晚到的 Agent exit 即使缺少
termination intent，也不能重新混入 runtime crash。此外，本地 desktop RUM 边界将
Windows `0x40010004` 和 POSIX `SIGTERM` 在缺少结构化根因时视为受控终止特征：即使
Host 未提供 termination intent，也不上报 crash。`protocol-close` 本身不能建立主动退出
意图；Host 必须将首次 cleanup 原因作为 `terminationReason` 传到 desktop main。即使其后
的进程树回收产生上述系统退出特征，desktop RUM 仍按协议故障上报 crash。该兼容分类只
影响 desktop RUM，不改写 Host 进程生命周期事件。

ready 状态由 Agent service 持有，因为“进程已 spawn”和“可执行模型”是两个不同阶段。
ProcessManager 只负责把首次 ready 与当前 `runtime_instance_id` 绑定，并在 exit 事件中携带
`runtimeReady`。desktop main 不用 IPC 到达时序反推阶段：新 Host 明确映射为
`startup` / `runtime`，兼容旧 Host 缺字段时映射为 `unknown`。

## 事件契约

### `perf_agent_start`

- `group`: `stability`
- `value`: `1`
- 触发：Node `ChildProcess` 发出 `spawn`，确认 runtime 已真实启动。
- 属性：`process_role=agent`、`runtime_instance_id`、`runtime_generation`、`provider`。

### `perf_agent_ready`

- `group`: `stability`
- `value`: `1`
- 触发：同一 runtime 首次通过 provider/model 门禁，且仍是当前存活进程。
- 属性：`process_role=agent`、`runtime_instance_id`、`runtime_generation`、`provider`、
  `startup_duration_ms`。
- 同一 `runtime_instance_id` 最多上报一次；只读启动但 provider/model 尚未就绪时只产生
  `perf_agent_start`，不产生 ready。

### `perf_agent_crash`

- `group`: `stability`
- `value`: `1`
- 触发：已经创建 Agent runtime，但没有主动退出意图时发生进程退出。缺少结构化根因的
  `0x40010004` / `SIGTERM` 仍按受控终止特征抑制；`terminationReason=protocol-close`
  时不受最终退出签名影响。即使 `exitCode=0`，长期运行的 Agent 自行结束也属于非预期退出。

属性：

| 字段                  | 说明                                                |
| --------------------- | --------------------------------------------------- |
| `process_role`        | 固定为 `agent`                                      |
| `incident_kind`       | 固定为 `unexpected_exit`                            |
| `exit_code`           | 无退出码时为空字符串                                |
| `signal`              | 无 signal 时为空字符串                              |
| `termination_reason`  | Host 保留的结构化退出根因，例如 `protocol-close`    |
| `error_name`          | 从 stderr 末尾提取，无法识别时为 `AgentProcessExit` |
| `error_code`          | 从 Node 错误输出提取，例如 `EPIPE`                  |
| `error_message`       | 脱敏后的错误摘要                                    |
| `error_stack`         | 脱敏且最多 4000 字符的 stderr 尾部                  |
| `error_fingerprint`   | 规范化错误名、错误码和首条错误的稳定哈希            |
| `stderr_line_count`   | Agent 整个生命周期输出到 stderr 的行数              |
| `runtime_instance_id` | 每次 spawn 生成的随机不透明 ID，不含 workspace/PID  |
| `runtime_generation`  | 当前 workspace Agent runtime 代次                   |
| `uptime_ms`           | Agent 从 spawn 到 exit 的存活时间                   |
| `crash_phase`         | `startup` / `runtime` / `unknown`                   |
| `termination_class`   | `exit_zero` / `exit_nonzero` / `signal` / `unknown` |
| `diagnostic_class`    | `oom` / `sqlite` / `errno` / `generic` / `none`     |

诊断摘要按确定性优先级提取：退出码 → OOM → SQLite → errno → 通用异常 → 无诊断。`[Object]`、
对象尾括号、GC 标题、native stack 地址、Node 内部位置、SQLite ExperimentalWarning，以及
util.inspect 打印的对象属性行（例如 HTTP 响应头 `server: 'ESA',`）仅保留在脱敏后的
`error_stack` 中，不得成为 `error_message` 或 `error_code` 的来源。OOM 使用
`AgentOutOfMemory / ERR_OUT_OF_MEMORY`；errno 必须把 `EPERM`、`EPIPE` 等写入
`error_code`；SQLite 即使没有 SQLite code，也通过 `diagnostic_class=sqlite` 聚合。

- 退出码优先：Windows 退出码 `0xE0000008`（十进制 3758096392）是 Chromium/PartitionAlloc 在
  系统可提交内存耗尽时终止进程的异常码，不写 stderr。它直接归为
  `AgentOutOfMemory / ERR_OUT_OF_MEMORY`、`diagnostic_class=oom`，`error_message` 固定为
  `Native memory allocation failed (exit code 0xE0000008)`，指纹不读 stderr。按 `exit_code`
  统计线上 native 内存不足崩溃的占比即可区分 JS 堆 OOM。
- 其他平台没有同等确定的退出签名：Linux/macOS 上 Chromium 分配失败表现为 SIGTRAP/SIGILL，
  与任意断言失败相同；内核 OOM killer 与 macOS jetsam 发 SIGKILL，与手动 `kill -9` 相同。
  因此不按信号推断内存不足，V8 堆 OOM 仍从 stderr 的 heap out of memory 识别。
- 没有显式 `code:` 时，`error_code` 只接受 Node/libuv errno 名（含 `os.constants.errno`）、
  Node dns 错误码（如 `getaddrinfo ENOTFOUND`）、`ERR_*` 与 `SQLITE_*`；名单不收 `EOF`、`UNKNOWN`。
  回归测试按运行时 Node 自己的 errno / dns 错误码逐个核对，新版本 Node 新增的名字漏收会直接失败；
  `ESA`、`END`、`ENV` 这类大写词不是错误码。长期运行的 Agent，stderr 尾部常是几小时前的
  无关日志；只剩噪音时 `error_message` 退回
  `Agent process exited unexpectedly (code=…, signal=…)`，指纹因此随退出码区分。
- 实现：`packages/shared/src/agent-crash-diagnostic/agentCrashDiagnostic.ts`。回归样本（含 0xE0000008 + 429 响应头
  转储）见 `packages/desktop/test/agent-crash-diagnostic.node.test.ts`，
  `pnpm --filter @zcode/desktop test:agent-crash-diagnostic` 运行；MR 改到诊断规则、services 的 stderr 收集、
  `desktopStabilityTelemetry.ts` 或测试本身时，CI job `test:agent-crash-diagnostic` 自动执行，失败即 job 失败。

### `perf_agent_spawn_error`

- `group`: `stability`
- `value`: `1`
- 触发：Agent 命令或 cwd 无法 spawn。
- 属性复用 `error_name`、`error_code`、`error_message`、`error_stack`、
  `error_fingerprint`、`diagnostic_class`，并携带本次尝试的 `runtime_instance_id`。

## 退出分类

| 原因                                   | 分类                             | 上报 crash |
| -------------------------------------- | -------------------------------- | ---------- |
| `workspace-dispose`                    | `expected`                       | 否         |
| `manager-dispose` / retry              | `expected`                       | 否         |
| `request-timeout`                      | `watchdog_recycle`               | 否         |
| desktop `app_quit` / `update_install`  | 应用退出保护                     | 否         |
| 无结构化根因的 Windows `0x40010004`    | desktop RUM 受控终止兼容分类     | 否         |
| 无结构化根因的 POSIX `SIGTERM`         | desktop RUM 受控终止兼容分类     | 否         |
| `protocol-close` 后任意 code/signal    | 不设置 intent，保持 `unexpected` | 是         |
| 其他无 cleanup 请求的 code/signal exit | `unexpected`                     | 是         |

首次设置的 termination intent 是根因事实，后续幂等 cleanup 不覆盖它。

## 隐私和容量

- 禁止上传 `workspacePath`、`workspaceIdentity`、command、args、环境变量、
  session/task id 或模型输入输出。
- 凭据遮盖规则只有一份：`redactAgentDiagnosticSecrets`（`@zcode/shared/agent-crash-diagnostic`）。
  services 逐行收集 stderr 时（`zcodeAgentProcessManager.ts` 的 `redactAgentDiagnostic`）和
  desktop main 上报前（`sanitizeAgentCrashDetail`）都调用它，不各自维护正则。曾经两层各一套、
  services 先做赋值替换，把 `Authorization: Bearer <token>` 的 `Bearer` 换掉后，main 认不出 token，
  token 随 `error_stack` 上报。规则对已处理过的文本幂等，两层串联与只跑一层结果相同。
- 遮盖顺序：`Bearer` / `Basic` 凭据 → cookie / set-cookie → token、authorization、password、
  secret 等赋值 → 没有赋值前缀的 `sk-...` API key（错误文本不得因缺少 `token=` /
  `Authorization` 前缀而绕过脱敏）。cookie 的值带引号时只替换到闭合引号，同一行后面的
  `"code":"ECONNRESET"` 仍能取到错误码；不带引号时替换到行尾，多段 cookie 不残留后几段。
  带引号的值替换后保留引号，否则再跑一遍时会被当成不带引号的值。
- desktop main 再把 workspace 绝对路径替换成 `<workspace>`，错误详情截断到
  4000 字符。
- desktop main 同时替换 Windows/macOS/Linux 常见用户主目录；指纹生成前进一步移除
  任意绝对路径、UUID、PID 和行列号，避免路径泄露和高基数。
- ARMS 上报属于旁路观测；任何 schema、IPC 或 `sendCustom` 失败都不能影响
  Agent 启动、退出和自动恢复。

## Agent 进程级异常边界

协议模式（`app-server` / `agent-server`）在 CLI 入口安装进程级异常边界，覆盖：

- `uncaughtException`
- `unhandledRejection`
- `uncaughtExceptionMonitor`

该边界把诊断信息写入 `stderr`，不向 stdout 写普通文本，避免破坏 ZCode Protocol
NDJSON 通道。到达这里的未知异常意味着业务层未能恢复：首次异常报告后交给 CLI
生命周期 owner 有界退出，不再接受新的业务。普通请求/模型/工具错误仍在原业务边界处理。

```text
uncaughtException / unhandledRejection
             │
             ▼
CLI process-level boundary
             │
             ├─ stderr：记录类型、错误名、消息和栈
             ├─ stdout：不写任何诊断文本
             └─ CLI owner 停止接单、取消和清理、非零退出
```

早期实现通过 listener 保活，依赖 Host timeout 回收；父端已消失时该假设不成立，且
stderr 的异步 EPIPE 会再次触发边界并循环写坏管道。现在 stderr 写入边界独立吸收该流的
同步/异步失败并停用出口；不得全局忽略其他流的 EPIPE。`uncaughtExceptionMonitor`
只记录 origin，strict rejection 仍由 rejection listener 统一报告。清理期间的后续异常
不重复诊断、不延长首次退出时限。完整时序见 CLI 协议进程生命周期 spec。

该边界只在协议模式安装，不改变普通 headless CLI、TUI、doctor、login 等命令原有的
失败退出语义。`perf_agent_crash` 仍表示实际退出；异常发生后是否退出不影响 JS 错误上报。

### CLI 的 JS 异常上报（2026-09-14 引入）

根因：异常边界保留了进程，但 stderr 只进 debug / exit tail，Electron SDK 无法自动
捕获 Node 子进程异常。必须在异常发生时显式发送 `exception`，不能依赖退出日志的
`console.error` 自动采集。

```text
CLI 异常边界（errorId 唯一事实源）
  → stderr 单行 [zcode-process-exception] JSON v1
  → ProcessManager 校验 / 脱敏 / 绑定当前 runtime_instance_id
  → RuntimeProcessLifecycleReporter.onException
  → Host IPC agent-process-exception（运行时 schema 校验）
  → desktop main sendEvent(exception, type=error)
  → RUM JS 错误
```

- 共享公开契约为 `@zcode/shared/process-diagnostic`，并从 ZCode Protocol 入口导出。
  CLI / SEA 构建 alias 必须精确声明该子路径，避免被通用 shared alias 拼到 index.ts 后。
  字段为 `version/errorId/kind/origin/name/message/stack/occurredAt`；kind/origin 只接受
  uncaughtException / unhandledRejection。名称最多 128 字符，消息 4000，栈 16000，
  JSON 行最多 128 Ki 字符（覆盖 JSON 转义膨胀）；未知版本、额外字段、损坏帧不转发。
- 同一次 monitor + uncaughtException 只由后者输出一次。
  使用 Node strict rejection 模式时，Node 先触发 origin=unhandledRejection 的 uncaughtException，
  被处理后再触发 unhandledRejection；该情形统一由后者报告一次，避免同一 rejection 双计数。
  原有可读 stderr 保留供旧 Host 和 crash tail 使用；新 Host 不把结构化行重复加入 tail。CLI 早期启动即能输出，不依赖
  stdout 协议就绪；诊断本身不新增计时器、重试队列或业务状态，退出时限由 CLI lifecycle
  统一持有。任何序列化/写入失败不能再次抛出。
- ProcessManager 只使用创建该 child 时的 runtime 身份，不按路径查询“当前进程”，避免
  旧进程晚到的异常被归入新 runtime。IPC 异常是观测旁路，不参与 ready / exit / task 状态。
- Main 是 RUM SDK 和去重状态的唯一 owner：按 runtimeInstanceId + errorId 保留最近
  1024 条已提交事件；SDK 同步失败不记成功。相同栈的不同 errorId 必须分别计数。
  不保证强杀前尚未写入管道的异常送达，不通过异常推断进程已经恢复或崩溃。
- RUM 事件保留原始错误名、脱敏消息和栈，附带 process_role=agent、process_error_kind、
  process_error_origin、error_id、runtime_instance_id、runtime_generation、lane（如有）、
  app_version、arms_env、device_mid 和稳定指纹。沿用 main 的脱敏及 4000 字符上限；
  不上传 workspace、命令或 task/session 标识。
- 已走生命周期 reporter 的退出 / spawn 失败日志带明确诊断标记，仅过滤这类
  console.error 包装事件；本地 error 日志保留，其他 console.error 继续采集。
  “perf_agent_crash / perf_agent_spawn_error reported” 改为 info，避免上报成功再产生 JS 错误。
- 新旧 CLI/Host 混用时保留原有 crash 上报；新异常契约不改 stdout wire version。
  本次覆盖桌面 Host 直接启动的 CLI；独立终端 CLI、SSH/WSL/Docker 远端 Agent 的独立
  采集入口不在本次新增范围。手机 shared-host 复用此旁路，不在 relay/Web 重复采集，
  desktop continuous 和 web replayable 的任务事件、owner/lease/队列语义均不改变。

验收：真实 CLI 分别注入 throw / rejection，退出前即出现一次 JS exception；随后有界
exit 1 产生一次实际退出事件，无包装日志 JS 错误。Host 在 stderr drain 后生成 exit tail，
不能在 child exit 事件或发 EOF 前关掉诊断 reader。
覆盖 IPC 非法输入、非 Error rejection、生产 debug 关闭、跨平台路径脱敏、重复事件、
上报失败隔离。线上验证同时记录 SDK 请求/HTTP 响应，并在 RUM 按唯一标记核对索引结果。

## 验证

- 自然 `exit 1`、自然 `exit 0`、`SIGKILL` 均产生一次 crash。
- 缺少 `terminationReason` 时，Windows `0x40010004` 和 POSIX `SIGTERM` 即使暂被标记为
  `unexpected`，也不产生 crash。
- 成功 spawn 产生一次 start，且 start/crash 的 `runtime_instance_id` 相同。
- 主动 workspace/app cleanup 不产生 crash。
- `perf_app_exit` 后异步到达的 Agent exit 不产生 crash，且 lifecycle 不恢复为 runtime。
- `protocol-close → SIGTERM / 0x40010004 / 其他 exit` 均产生 crash，并携带
  `termination_reason=protocol-close`。
- 同一 runtime 的 start / ready / crash 共用 `runtime_instance_id`，ready 最多一次。
- ready 前退出为 `crash_phase=startup`，ready 后退出为 `runtime`，旧 Host 缺字段为 `unknown`。
- OOM、SQLite、errno 摘要分别得到稳定的 `diagnostic_class`，结构噪音不进入摘要。
- spawn `ENOENT` 产生一次 `perf_agent_spawn_error`。
- stderr 中的 credential 和 workspace 路径不会进入最终 payload。
- 超长 stderr 截断到 4000 字符。
- 两个 runtime 在短时间内崩溃会产生两条事件，并通过不同
  `runtime_instance_id` 区分。
- 协议模式中未捕获同步异常和未处理 Promise rejection 会写入 stderr，但不会立即让
  CLI 进程退出；普通 CLI/TUI 仍保持原有未捕获异常行为。
- 进程级异常边界不会向 stdout 写入非协议文本，也不会覆盖既有 `process.exitCode`。
