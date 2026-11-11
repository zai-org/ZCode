# MR !1466 闲时任务（Off-Peak Task）完整改动梳理

> 本文按 **MR 的真实 Git 边界**、**最终代码行为**、**测试覆盖**和**已知缺口**梳理，不把早期方案、提交中间态或文档愿景误写成已经落地的能力。
>
> 盘点时间：2026-07-21；MR：`!1466`；目标分支：`main`；源分支：`feat/off-peak-task`。
>
> **2026-07-23 后续收口**：D44 已删除 Off-Peak 专用 `awaiting_approval` 类型/Repo/UI/通知壳。
> 下文提到这些内容时是在复盘 MR Head 的历史边界；当前行为以 `spec.md` 与代码为准：
> permission/elicitation 只走普通 session，Off-Peak 聚合保持 `running`，当前 turn 不切 provider。

## 1. 审计范围与结论

### 1.1 精确 Git 边界

| 项目 | 值 |
|---|---|
| MR | `!1466` — `Draft: feat(off-peak): 闲时任务 Off-Peak Task` |
| Base SHA | `14a62011d582ccbd20ef4c274892ae0dea076bd9` |
| MR Head SHA | `cc3980d2a1f1523f362cb1a6e80d5ba2482cc5b7` |
| 对比范围 | `14a62011d582ccbd20ef4c274892ae0dea076bd9..cc3980d2a1f1523f362cb1a6e80d5ba2482cc5b7` |
| 提交数 | 60 个（55 个 non-merge + 5 个分支同步 merge commit） |
| 文件数 | 115 |
| 行数 | `+14,429 / -1,707` |
| MR 状态 | Draft、Open、无冲突；最新 pipeline 处于 manual/blocked |

本地分支当前还额外包含 `5c6d0e9d7f chore: release v3.5.3-alpha.0`。它不在上述 MR Head 内，因此不计入本文的 MR 改动。本文自身也是对该远端 Head 的审计产物，不计入 115 个原始 changed paths；若后续把本文推入源分支，MR 文件数会相应增加。

### 1.2 一句话结果

这个 MR 新增了一套桌面本地的“一次性闲时任务”产品：用户先向服务端取号，客户端持久化任务并轮询票据，服务端放行后由独立 scheduler 派发到承载目标 workspaceKey 的窗口 Local Host，Host 创建或复用一个普通 ZCode session，并仅对自动执行的那一轮临时注入内置 `builtin:offpeak-idle-plan` provider；遇到容量型 `429/3105` 时遵从 `Retry-After` 无限等待而不消耗普通重试预算，票据 `3102` 失效时换票并在同一 session 续跑，任务结束后异步核销票据。

### 1.3 本 MR 的实际范围

核心范围包括：

- Off-Peak 领域类型、SQLite 表、Repo 状态机、服务端 ticket 客户端、同步与核销服务。
- desktop scheduler → main → window Local Host → workspaceKey Agent 的派发闭环。
- agent/CLI 的单轮 provider overlay、模型恢复、`429/3105` 等待和 `3102` 续跑标记。
- Automations 中的创建、编辑、列表、History、侧栏分组、通知、灰度与额度门控。
- 全局“运行时保持唤醒”设置。
- mock 网关、单测、服务集成测试和两条 WDIO E2E。
- 文档、决策记录、conversation case catalog、覆盖矩阵。

同时夹带两个非核心但确实属于 MR 的改动：

- GitLab CI 允许 API source 触发部分手动测试/构建链路。
- `mise run dev` 使用独立 `~/.zcode-dev-home`，隔离生产数据目录。

## 2. 最终产品语义

### 2.1 用户看到的对象

- 一个闲时任务是一条一次性任务，不是 cron，也不是可重复 automation。
- 创建任务时填写标题、Instructions、项目、权限模式、闲时模型和推理档位。
- 创建成功即完成服务端取号；并不会立即创建对话。
- 服务端票据进入 `ready` 后才可派发；首次派发时创建普通 session。
- 3 小时执行段到期后可换新 ticket，并继续复用原 session。
- 本地始终只有一条逻辑任务记录；新 ticket 会覆盖当前 `server_ticket_id`，不会新增一条任务。
- History 对一条任务最多显示 1 行，不会按每个 3 小时分段或每张 ticket 展开。

### 2.2 用户可见 provider 与实际请求 provider

这是本 MR 最容易混淆的边界：

| 场景 | 模型选择栏/Session 常驻模型 | 当前请求真正使用的 provider |
|---|---|---|
| 首次闲时派发创建 session | 用户 workspace 的默认模型；完整保留 `providerId/modelId` | 该自动执行 turn 临时使用内置 `builtin:offpeak-idle-plan` |
| 后续 ticket 分段续跑 | 仍是同一 session 的用户常驻模型 | 续跑 turn 再临时使用 `builtin:offpeak-idle-plan` |
| 自动 turn 结束后 | 恢复用户常驻模型 | 后续普通消息使用用户 provider |
| 自动 turn 尚未结束时触发 permission approval | 模型栏仍显示用户常驻模型 | **当前实现仍处于同一个 idle-plan turn，批准不会切换 provider** |
| 自动 turn 忙碌时用户补发 prompt | 模型栏仍显示用户常驻模型 | 消息先排队；自动 turn 清理 overlay 并恢复模型后才 drain，因此使用用户 provider |

多 provider 用户的 session 常驻模型不是“任取第一个 provider”。host 首次派发前调用 `workspace/readState(preferWorkspaceDefaults=true)`，按以下顺序选择仍在 available 集合中的完整模型引用：

1. `modelCatalog.defaultModel`
2. `modelCatalog.lastUsed`
3. `settings.model.current`

候选为 `builtin:offpeak-idle-plan` 时跳过；没有候选则以永久派发错误失败。创建表单里的模型只决定 idle-plan 自动 turn 的模型，不覆盖 session 常驻模型。

### 2.3 Ask approval 的真实落地状态

方案文档写的是：敏感操作进入 `awaiting_approval`，批准时提示“继续将使用你自己的套餐配额”，然后切到用户 provider。

**MR Head 的生产代码没有完成这条链路：**

- Repo 已有 `setAwaitingApproval()`，共享状态、UI badge、卡片动作和系统通知也预留了 `awaiting_approval`。
- 但生产运行链路没有调用 `setAwaitingApproval()`。
- 没有 Off-Peak 专用 approval handler，也没有批准后切换 provider 的实现。
- 没有“继续将使用你自己的套餐配额”的运行时提示。
- permission 请求仍属于当前自动 turn，而该 turn 的 `turnRuntimeModel` 要到 turn 完成边界才清理，所以批准后继续执行的仍是 idle-plan provider。

因此 `awaiting_approval` 当前更像“已建模、已渲染、尚未接通运行时事件”的预留态，不能按已完成能力验收。

### 2.4 “队列”到底是什么

这里有三层不同队列，不能混成一个全局 FIFO：

| 层 | 保存位置 | 排的是什么 | 权威性 |
|---|---|---|---|
| 服务端 ticket 队列 | Off-Peak 服务端 | 用户取到的 ticket，返回 `position` 并在低峰时转 `ready` | 闲时准入顺序的权威 |
| scheduler 可派发队列 | 本地 `off_peak_tasks` + claim 字段 | 已同步为 `schedulable=true` 的本地任务，按 `queued_at` 认领 | 本机 host 派发顺序 |
| 对话消息队列 | session/agent 现有运行时 | agent busy 时用户补发的普通 prompt | 仅该 session 内的消息顺序 |

`next_poll_at` 虽被写入任务表，但当前 service 使用一个共享 timer 驱动整批非终态 ticket 的轮询，并不是为每条 task 建独立定时器。

## 3. 全链路架构

```text
Renderer / packages/ui
  │
  │ IOffPeakTaskService RPC
  ▼
Window Local Host Process
  ├─ OffPeakTaskService ──────► OffPeak Server
  │    ├─ availability             GET  /ticket/availability
  │    ├─ take number              POST /ticket
  │    ├─ batch sync               POST /ticket/status
  │    └─ settle outbox            POST /ticket/:id/settle
  │
  ├─ OffPeakTaskRepo ─────────► tasks-index.sqlite / off_peak_tasks
  │
  └─ ZCodeTaskService / Agent session
         ▲
         │ OffPeakRun routed to the window Local Host owning the workspaceKey scope
         │
Desktop Main Process ◄──────── Scheduler Utility Process
  │                              ├─ 20s tick
  │                              ├─ recover interrupted claims
  │                              ├─ claim schedulable queued rows
  │                              └─ transient dispatch backoff
  │
  └─ powerSaveBlocker (global setting)

Agent / zcode-cli
  ├─ persistent session model = user's workspace model
  ├─ per-turn catalog/model overlay = builtin:offpeak-idle-plan
  ├─ POST /api/v1/off-peak/anthropic/v1/messages
  ├─ 429/3105 + Retry-After => wait and retry without budget consumption
  └─ 400/3102 => stable expired marker => host requeues same task/session
```

边界说明：

- scheduler 和 host 都会打开同一 tasks-index SQLite，但通过事务 claim 和状态守卫协作。
- main 只转发调度消息并管理系统能力，不承载 ticket/session 业务状态。
- relay、mobile remote、desktop main 都没有新增 replayable task 状态源。
- desktop 仍走 `desktop-continuous`；本 MR 没有把手机 replayable 恢复语义扩散到桌面链路。

## 4. 两轴状态机

### 4.1 客户端任务状态

```text
                         ┌──────────── Pause ────────────┐
                         │                               ▼
create + take ticket ─► queued ── server ready ──► claimed ── dispatch ─► running
                         ▲             │                │                  │
                         │             └─ claim fail ───┘                  ├─ success ─► completed
                         │                                                ├─ failure ─► failed
                         │                                                ├─ cancel ──► cancelled
                         │                                                └─ 3102 ────► queued
                         │
                         └──────── Continue / retake ◄──── paused

预留但未接通：running ── permission request ──► awaiting_approval
终态：completed / failed / cancelled，均不可逆出。
```

客户端七态：

- `queued`：已取号，等待服务端 ready，或重启/续跑后重新排队。
- `paused`：用户停止本地派发；服务端 ticket 自身仍会继续老化。
- `running`：host 已接受 `sendPrompt` 派发并回 ACK。
- `awaiting_approval`：领域和 UI 已预留，生产运行链路暂不可达。
- `completed`、`failed`、`cancelled`：终态。

### 4.2 服务端 ticket 状态

```text
POST /ticket
    │
    ▼
  queued ──低峰且轮到──► ready ──首个 messages 准入──► active
                           │                              │
                           ├─ ready TTL 到期 ───────────► expired
                           └─────────────────────────────► settled ◄── client settle
                                                          ▲
                       active 3h 到期 ─► expired ──────────┘（换票续跑）

查询还可能得到 not_found。
```

### 4.3 两轴映射与重要偏差

| 服务端状态 | 本地同步动作 | 客户端常见状态 |
|---|---|---|
| `queued` | `schedulable=false`，写 position | `queued` 或 `paused` |
| `ready` | `schedulable=true`，唤醒 scheduler | `queued`，随后可派发 |
| `active` | 保持已激活快照 | 通常 `running` |
| `expired` | queued 任务自动 retake；running 由 messages `3102` 闭环 retake | 回到 `queued` |
| `settled` | 清除可调度快照 | 一般已终态；意外初态可能滞留 |
| `not_found` | 当前 sync 忽略，不自动 retake | 可能滞留；用户 Continue 可触发重取 |

重要偏差：本地 `running` 在 `sendPrompt` 返回 ACK 后就写入，而 gateway 是否真正通过 messages 细阀发生在之后。因此遇到 `429/3105` 等待时，UI 会显示 running，而不是独立的“服务端容量排队中”。

## 5. 数据模型与持久化

### 5.1 领域主键和身份

- `offPeakTaskId`：本地主键，同时作为服务端稳定 `task_id`；跨多张 ticket 不变。
- `serverTicketId`：当前服务端票据；每次重取号覆盖。
- `conversationId`：宿主 ZCode task id；首次派发后回填。
- `sessionId`：Agent session id；首次执行后回填，续跑复用。
- `workspaceKey = workspaceIdentity?.trim() || workspacePath`：身份隔离 key。
- `workspacePath`：文件、cwd、展示等真实路径语义。
- `workspaceIdentity`：远端身份字段被类型和协议保留，但产品 UI 禁止在 remote workspace 创建闲时任务。

### 5.2 `off_peak_tasks` 表

存储位于现有 tasks-index SQLite。连接启用 WAL、`synchronous=NORMAL`、`busy_timeout=5000`。

| 列 | 含义 |
|---|---|
| `off_peak_task_id` | 稳定任务主键/服务端 task_id |
| `server_ticket_id` | 当前 ticket id |
| `title` | 用户标题 |
| `conversation_id` | ZCode task id |
| `session_id` | 可复用 Agent session id |
| `prompt` | Instructions |
| `permission_mode` | build/edit/plan/yolo 等现有 task mode |
| `model` | idle plan 自动 turn 模型 |
| `thought_level` | 推理档位；增量 migration 补列 |
| `workspace_key` | workspace 身份隔离 key |
| `workspace_path` | 实际路径 |
| `workspace_identity` | 可选远端 identity |
| `status` | 客户端七态 |
| `queued_at` | 本地 FIFO 排序时间 |
| `started_at` / `ended_at` | 生命周期时间 |
| `failure_reason` | 失败原因 |
| `files_changed` | best-effort 变更文件数 |
| `settled_at` | 服务端核销 ACK 时间 |
| `history_deleted_at` | History 逻辑删除时间；增量 migration 补列 |
| `registered_at` | 取号成功时间 |
| `schedulable` | 服务端 ready 的本地快照 |
| `queue_position` | 服务端队列位置 |
| `next_poll_at` | 服务端建议的下次轮询时间快照 |
| `claim_running` / `claimed_at` | scheduler 认领锁与时间 |
| `attempt_count` / `last_error` | 派发记录/诊断字段 |
| `created_at` / `updated_at` | 本地审计时间 |

索引：

- `(status, queued_at)`：状态过滤和 FIFO 认领。
- `(workspace_key, status)`：workspace 隔离查询。

### 5.3 Repo 的机械守卫

`OffPeakTaskRepo` 实现了：

- 初始化建表、增量 `ensureColumn`、row → domain 映射。
- create/list/get/physical delete/History tombstone。
- 非终态数和 active 数统计。
- 仅 `queued/paused` 可编辑。
- 更新服务端 scheduling snapshot。
- `BEGIN IMMEDIATE` 事务内 FIFO claim；10 分钟 claim 视为 stale，可重新认领。
- `markRunning` 只接受 queued，首次时间/session 字段使用 `COALESCE` 保留。
- `markTerminal` 禁止终态被迟到结果反向覆盖。
- awaiting、pause、release claim 的条件转换。
- 启动恢复：把中断的 claimed/running 任务放回 queued，同时保留 session。
- `requeueForContinuation`：换票续跑仍保留 task/session。
- 未核销终态 outbox 查询与 `markSettled`。

## 6. 关键时序

### 6.1 创建与取号

```text
UI                    Host Service             Off-Peak Server          SQLite
│ createTask(params)       │                          │                    │
├─────────────────────────►│                          │                    │
│                          │ generate stable task_id  │                    │
│                          ├─ POST /ticket ──────────►│                    │
│                          │◄─ ticket/state/position ─┤                    │
│                          │                          │                    │
│                          ├─ INSERT task ────────────────────────────────►│
│                          ├─ start sync / wake if ready                  │
│◄─────────────────────────┤                          │                    │
```

- 顺序是“服务端取号成功后才落本地库”。
- 好处：取号失败不会留下假任务。
- 风险：取号成功后 SQLite insert 失败，会留下服务端孤儿 ticket；当前没有主动 settle 补偿。
- 服务端返回 `ready` 时会立即唤醒 scheduler，不必等下一次 20 秒 tick。

### 6.2 首次派发与 session 创建

```text
Sync Service       SQLite/Scheduler       Main       Window Local Host       workspaceKey Agent
│ ticket=ready          │                  │              │                    │
├─ schedulable=true ───►│                  │              │                    │
├─ wake scheduler ─────►│                  │              │                    │
│                       ├─ transactional claim             │                    │
│                       ├─ OffPeakRun ─────►│─────────────►│                    │
│                       │                  │              ├─ read workspace model
│                       │                  │              ├─ createTask(model=user default)
│                       │                  │              ├─ build idle-plan turnRuntimeModel
│                       │                  │              ├─ sendPrompt ───────►│
│                       │                  │              │◄─ dispatch ACK ─────┤
│                       │◄─ success ───────│◄─────────────┤                    │
│                       ├─ markRunning(session/task ids)                        │
│                       │                                  Agent turn continues │
```

`running` 表示派发 ACK，而不是模型已经产出 token，也不是服务端 messages 已通过容量细阀。

### 6.3 单轮模型覆盖与恢复

```text
workspace catalog/model                  turn overlay
        │                                      │
        ├─ snapshot previous selected model    │
        ├─ setTurnOverlay(offpeak provider) ──►│
        ├─ setModel(offpeak model, transient)  │
        ├─ run automatic prompt                │
        │                                      │
        ├─ turn terminal boundary              │
        ├─ restore previous model              │
        ├─ clearTurnOverlay / clear secrets    │
        ├─ emit ready                          │
        └─ drain queued user messages using restored user provider
```

- workspace overlay 与 turn overlay 分层保存；workspace 热刷新不会覆盖仍在运行的 turn overlay。
- 该 provider 配置只在内存中注入，不写 workspace catalog、session 持久化或磁盘。
- 注入和恢复都不发普通 model-change UI 事件，避免模型栏闪成 Idle plan。
- 若原模型在自动 turn 期间被移除，先清理含密钥的临时 overlay，再从最新 catalog 回退。
- agent busy 时，带另一个 `turnRuntimeModel` 的 sendText 会被拒绝，scheduler 将其视为 transient 派发失败。

### 6.4 `429/3105 + Retry-After` 如何实现

```text
Agent adapter              Off-Peak messages endpoint
     │ request attempt                  │
     ├─────────────────────────────────►│
     │◄─ HTTP 429, code=3105,           │
     │   Retry-After: N seconds         │
     │                                 │
     ├─ classify only when providerId == builtin:offpeak-idle-plan
     ├─ delay = min(parsed Retry-After or 60s, 5min)
     ├─ abort-aware wait
     ├─ do not consume ordinary retry budget
     └─ retry same provider request ───►│
```

实现点：

- `offpeak-retry.ts` 只对 `providerId=builtin:offpeak-idle-plan` 生效，普通 provider 不受影响。
- 裸 HTTP 429 和业务码 3105 都被分类为 `queued`。
- 没有可解析的 `Retry-After` 时默认 60 秒；单次等待最多 5 分钟。
- generate runner 通过回退 attempt/保持队列决策，使容量等待不消耗普通 retry budget，可持续探测。
- stream runner 仅在尚未跨越可见输出边界时安全重试，避免把已输出内容重复给用户。
- wait 使用 abort signal，可被取消，不是不可打断 sleep。
- projection 将其映射成可恢复的 rate-limit fault，原因枚举为 `ModelRetryReason.OffpeakQueued`。

### 6.5 `3102` 票据到期续跑

```text
messages 400/code=3102
      │
      ▼
adapter: non-retry + append stable marker "off-peak-ticket-expired"
      │
      ▼
host terminal observer detects marker
      │
      ├─ requeue same offPeakTaskId, preserve conversationId/sessionId
      ├─ POST /ticket for a new ticket
      ├─ overwrite serverTicketId/scheduling snapshot
      └─ scheduler later resumes same session with continuation prompt
```

- 新契约码为 3102；adapter 仍兼容旧网关的 3001，便于滚动发布。
- 续跑使用固定英文 continuation prompt，并重新应用原 permission mode/thought level。
- task 是同一条、session 是同一个；本地不保存 ticket 历史。

### 6.6 Pause、Continue、Cancel、Delete

```text
Pause:
  queued ─► paused，阻止本地 scheduler 派发；服务端 ticket 不暂停，仍可能 ready/expired。

Continue:
  paused ─► 查询当前 ticket
             ├─ queued/ready/active 或查询失败：复用当前票
             └─ expired/not_found/缺票：重新 POST /ticket
           ─► queued

Cancel:
  local terminal cancelled first
  ├─ best-effort stop active agent task
  └─ best-effort settle；失败留给 outbox 重试

Delete:
  cancel + best-effort settle
  └─ physical DELETE local row

Delete history:
  只写 history_deleted_at；任务、session、执行字段均保留。
```

Delete 存在一个明确风险：如果 settle 在网络错误/5xx 下失败，随后物理删除 row，也会删掉本地 outbox 依据，之后无法自动补报。

### 6.7 重启恢复

```text
desktop/scheduler restart
  └─ recoverInterrupted(now)
       ├─ stale claim/running → queued
       ├─ release claim fields
       ├─ preserve session/task identity
       └─ wait for valid/retaken ticket and resume
```

## 7. 服务端接口、鉴权与错误语义

### 7.1 五个概念端点

| 用途 | 方法与路径 | 调用方 |
|---|---|---|
| 创建资格快照 | `GET /api/v1/off-peak/ticket/availability` | host service |
| 取号 | `POST /api/v1/off-peak/ticket` | host service |
| 批量查票 | `POST /api/v1/off-peak/ticket/status` | host service |
| 核销 | `POST /api/v1/off-peak/ticket/:id/settle` | host service |
| 模型消息 | `POST /api/v1/off-peak/anthropic/v1/messages` | agent 内临时 provider |

早期文档中的“四接口”只数 ticket 管理接口；加入 availability 后，按产品链路应理解为四个 ticket JSON 接口加一个 model endpoint。

### 7.2 鉴权

- ticket JSON 接口统一带 `Authorization: Bearer <ZCode JWT>` 和 `x-coding-plan-api-key`。
- messages 端点还带 `X-Off-Peak-Ticket-ID`。
- JWT 从 credential key `zcodejwttoken` 读取。
- Coding Plan key 按当前 provider family 与 selected connection 解析：ZAI/BigModel 个人套餐读取所选
  provider 的原始 `apiKey`，BigModel Team 复用既有 runtime-key helper 生成 `${apiKey}.${secretKey}`。
- Start Plan、API Key mode、未选择、active OAuth provider 与所选 family 不一致、disabled/stale
  connection 均拒绝；UI、ticket client 与 per-turn runtime 共用同一份 host credential snapshot，
  禁止扫描或回退到任意缓存 provider。
- 缺 JWT、Coding Plan key、闲时模型或用户 workspace 模型均产生类型化 permanent dispatch error，避免无意义反复认领。

### 7.3 解析与超时

- 单请求 10 秒超时。
- Zod 使用 loose/passthrough，允许服务端增加字段。
- `position: null` 会规范化成字段缺省。
- `next_poll_after` 按秒读取并转换成毫秒。
- 同时兼容裸 JSON 和 `{ code: 0, data }` 信封。
- batch status 最多发送 100 张 ticket；超出会截断并记 warn，不拆包。
- availability 返回 `can_take_number=false` 却缺少 `next_take_at` 时按脏响应抛错；UI 按 D43
  fail-closed，等待下一次成功刷新。

### 7.4 主要业务码

| HTTP/业务码 | 处理 |
|---|---|
| `3101` | 无资格，创建失败，由 UI 展示对应错误 |
| `3103` | 当前不可取号/额度限制，刷新 availability；不落永久本地 bool |
| `429` / `3105` | messages 容量队列，按 Retry-After 等待且不消耗普通 retry budget |
| `400` / `3102` | ticket 不可用，产生稳定 marker，换票续跑 |
| legacy `3001` | 仅作为旧 gateway 兼容，同 3102 |

## 8. OffPeakTaskService：取号、同步和核销

### 8.1 对外服务面

`IOffPeakTaskService` 暴露：

- `getTakeNumberAvailability`
- `createTask`
- `cancelTask`
- `pauseTask`
- `continueTask`
- `deleteTask`
- `deleteHistory`
- `updateTask`
- `list`
- `get`

renderer 不直接操作 server ticket；取号、轮询、续票和核销都留在服务层。

### 8.2 同步循环

- 只有存在相关非终态任务或未核销终态时才维持 timer。
- 正常轮询间隔夹在 5 秒到 5 分钟之间，优先采用服务端 `next_poll_after`。
- 同步失败从 10 秒开始指数退避。
- 一次批量同步所有非终态 task 的当前 ticket。
- queued ticket 变 ready 时更新 `schedulable=true` 并请求唤醒 scheduler。
- queued ticket 变 expired 时自动 retake；paused ticket 不自动 retake，等待用户 Continue。
- `not_found` 当前被忽略；不会在 background sync 中自动重取。

### 8.3 终态 settle outbox

- 终态写入和服务端 settle 分离，避免网络错误阻塞本地完成态。
- 未 `settled_at` 的终态任务会被重复补报。
- settle 的 4xx 被视为已经无法/无需重试并本地 ack；网络错误和 5xx 保留 outbox。
- settle API 设计为幂等。

### 8.4 多窗口 Host 情况

每个窗口 Local Host 都可能启动自己的同步 loop，并访问同一 SQLite。一个 Local Host 可以同时承载多个
workspaceKey；workspace service scope 不对应独立 Host 进程。Repo 状态写和 server API 都尽量幂等，因此不会直接破坏状态，但会产生重复 status/settle 请求；当前没有选主或全局唯一 sync owner。

## 9. Scheduler、Main、Host 和 Session

### 9.1 Scheduler

- 复用现有 utility process，但 Off-Peak 有独立消息类型、Repo 表和状态机。
- 每 20 秒 tick；不按 cron misfire 规则跳过。
- 启动先 `recoverInterrupted`。
- `claimDue` 只认领 `queued + schedulable`，按 `queued_at` FIFO。
- in-flight set 用于退出时释放认领；迟到结果仅按 task id 结算，不依赖内存上下文。
- host 不存在、忙碌、通道暂不可用等为 transient：30 秒起指数退避，上限 15 分钟。
- permanent config error 直接落 failed。
- 终态守卫会丢弃迟到派发结果，避免覆盖 cancelled/completed/failed。

### 9.2 Main 路由

- 把 scheduler 的 `OffPeakRun` 路由给与 workspace 对应的 host。
- 把 host 的 `OffPeakRunResult` 返回 scheduler。
- 接收 host 的 scheduler wake 请求。
- 不把 session、ticket、queue 或 snapshot 状态下沉到 main。

### 9.3 Host 派发

- Off-Peak runtime 懒初始化，复用 host 已装配的 credential、provider、coding-plan、task 服务。
- 首次派发：读取 workspace 默认模型，显式创建带用户模型的 deferred session，再发送原 prompt。
- 续跑：resume 原 session，发送固定 continuation prompt。
- 每一段都构造新的 `turnRuntimeModel`，ticket id 写入 header。
- 按 input/trace id 订阅 terminal outcome，完成后 best-effort 统计 files changed。
- outcome `success` → completed；`stopped` → cancelled；其他 → failed；若失败含 ticket-expired marker 则不终态，改走重取号续跑。

### 9.4 多轮对话逻辑

```text
Task row T (stable)
  ├─ Ticket A ── automatic turn 1 ──┐
  ├─ Ticket B ── resume turn 2 ─────┼──► one conversationId / one sessionId
  ├─ User queued prompt ─────────────┤    persistent user model
  └─ Ticket C ── resume turn 3 ──────┘    idle provider only per automatic turn
```

- ticket 可以多张，task/session 仍各一条。
- 自动 turn 之间以及自动 turn 完成后的普通对话都复用该 session。
- session 常驻 provider 是用户 workspace 模型；idle-plan 只是 turn overlay。
- 用户在 agent busy 时补发的消息沿用现有 session queue，不创建另一条 Off-Peak 任务队列。

## 10. 灰度、套餐和额度门控

### 10.1 客户端配置灰度

配置来源：`configs.offPeak`。

- `enable_offpeak_task === true`
- `allowed_models` 非空

两者同时满足才暴露新建能力。进入相关界面会强制刷新 client config。配置只控制产品暴露和 idle 模型白名单，不再承载静态免费额度。

### 10.2 Coding Plan 判断

- host 按当前 provider family / OAuth mode / selected connection key 精确解析脱敏 support；renderer 不再
  broad-scan provider registry。
- ZAI 个人、BigModel 个人与 BigModel Team 支持；Start Plan、API Key mode、未选择、登录 provider
  身份不一致、disabled/stale connection 被排除。
- 没有合适计划时按钮锁定，点击显示持续约 8 秒、右上角、可执行 Upgrade action 的 info toast。
- Automations 表单与 New Task 模板入口都复用相同 support，并验证 support 仍对应当前 selection。

### 10.3 服务端实时额度 D39

- `GET /ticket/availability` 是即时快照。
- 只有请求成功且 `canTakeNumber=true` 才放开创建；false、加载中、未知或失败都置灰。
- UI 在 `nextTakeAt + 100ms` 安排刷新。
- availability 查询失败、加载中或未知时 fail-closed；下一次成功刷新返回 true 后恢复入口。
- 真正创建仍以 POST `/ticket` 为最终权威。
- 遇到 3103 会刷新 snapshot，但不会把“额度耗尽”永久写入本地配置。

### 10.4 被替代的 D36 方案

MR 中间曾实现 `limit.max_tasks/sliding_window` 静态配置和按本地 `createdAt` 的预判门控，也写过相应 E2E。D39 后最终代码改成 server availability；阅读提交历史时不能把 D36 当现状。

## 11. Mock Gateway 与开发验证

### 11.1 行为

- 默认固定端口 `45197`，可用 env 覆盖。
- 多 host 抢占端口时，后启动者遇到 `EADDRINUSE` 会复用已存在网关。
- 状态按访问时钟惰性推进：queued → ready → active → expired/settled。
- retake 同一 task 时旧 ticket 过期。
- 支持 availability、take、batch status、settle 和 messages。
- 可注入前 N 次 429/3105、前 N 次 take 3103、availability 阻塞。
- 首个成功 messages 请求把 ready ticket 激活。
- 可用固定响应做完全离线测试，也可代理到真实个人 Coding Plan 上游。
- 代理模式会真实消耗用户 Coding Plan key，仅应开发/演示使用。
- 代理时剥离 hop-by-hop headers；上游失败返回 502。

### 11.2 环境变量

| 变量 | 作用 |
|---|---|
| `ZCODE_OFFPEAK_MOCK` | 开启 mock |
| `ZCODE_OFFPEAK_MOCK_PORT` | 覆盖固定端口 |
| `ZCODE_OFFPEAK_MOCK_READY_DELAY_MS` | queued 到 ready 延迟，默认 15 秒 |
| `ZCODE_OFFPEAK_MOCK_READY_TTL_MS` | ready 未使用有效期，默认 5 分钟 |
| `ZCODE_OFFPEAK_MOCK_ACTIVE_MS` | active 时长，默认 3 小时 |
| `ZCODE_OFFPEAK_MOCK_QUEUE_429_COUNT` | messages 前 N 次回 429/3105 |
| `ZCODE_OFFPEAK_MOCK_QUOTA_COUNT` | take 前 N 次回 3103 |
| `ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS` | availability 暂时不可取号 |
| `ZCODE_OFFPEAK_MOCK_RETRY_AFTER_S` | Retry-After，默认 5 秒 |
| `ZCODE_OFFPEAK_MOCK_NEXT_POLL_S` | next_poll_after，默认 5 秒 |

WDIO 管理流把 ready delay 设为 60 秒，避免任务在 UI 操作过程中抢先执行；额度 pre-gate spec 将 availability block 设为 1 小时。

## 12. UI 改动

### 12.1 Automations 主视图

- 有闲时能力/数据时增加 `All / Scheduled / Idle-time task` 三个 tab。
- 闲时任务以两列卡片网格展示。
- 卡片排序优先级：running → awaiting approval → queued → paused → failed → completed → cancelled；同态按新旧排序。
- 各状态提供不同 menu：Pause、Continue、Cancel、Delete、Go to session 等。
- queued 显示服务端 `#N in queue`；paused 显示 `#N Paused`。
- 现有 scheduled automation 仍保留；`AutomationEditView.tsx` 的超大 diff 很多来自格式重排和共享 project option 接入，不是整页业务重写。

### 12.2 创建/编辑表单

- 项目只能选当前桌面已打开且可用的本地 workspace；不再混入 recent、remote 或不可用项目。
- 标题和 Instructions 必填。
- permission 复用四档：build/edit/plan/yolo；UI 实际默认常量为 `build`。
- shared 类型注释仍写默认 `"default"`，与 UI 真实默认不一致，属于文档注释债务。
- 模型只能选 `allowed_models` 中的 idle-plan 模型。
- GLM-5.2 展示 `max/high/nothink`，默认 `max`。
- 创建页和 Automations 页都镜像全局 keep-awake switch。
- 离开脏草稿有 discard 确认。
- 首次以非 yolo 模式提交时显示 full-access 提示，但提示不阻断提交。
- queued/paused 可编辑；running/终态锁定；已有任务的 project 不可改。

### 12.3 History

- 一条 task 只有 0 或 1 条 History 聚合行。
- 无 `startedAt` 或已有 `historyDeletedAt` 时不显示。
- completed → Succeeded；failed → Failure；cancelled → Skipped；其余已启动态 → In progress。
- duration 最少显示 1 分钟。
- 行动作：Go to session、Delete history。
- Delete history 无确认/Undo，只写 tombstone。

### 12.4 侧栏和 New task 入口

- 桌面 grouped sidebar 增加可折叠 `Idle-time task` 系统组，跨项目汇总任务并显示数量。
- 点击有 session 的任务进入 session；无 session 时回到 Automations 对应项。
- New task 空状态新增闲时横幅和模板卡，可带 pending draft 跳到创建页。
- 横幅关闭只保存在当前 renderer session，不做跨启动持久化。

### 12.5 通知、对话框和 Toast

- 仅桌面本地监听 completed、failed、awaiting_approval 的边沿变化并发系统通知。
- 首次 load 只建立 baseline，不补发历史通知。
- 系统通知按 task/status 去重；cancelled 不通知。
- awaiting 通知代码存在，但由于运行态不可达，当前不会从真实 permission 流触发。
- ConfirmDialog 增加 compact、destructive、close 控制和禁用快捷键等能力。
- Toast 增加 top-right、info/warning、action、dismiss 等变体，用于套餐提示和风险提示。

### 12.6 国际化和测试标识

- 英文、简体中文补齐闲时任务、状态、错误、表单、History、额度、保持唤醒文案。
- `IntlProvider` 与 locale shape 同步。
- shared test ids 增加 Off-Peak 页面/E2E 定位标识。

## 13. Keep Awake 最终语义

早期实现曾按“active task count > 0 且开关开启”启停 blocker；MR 最终提交改为全局开关：

```text
AppSettings.keepAwakeWhileRunning
          │
          ├─ false ─► stop powerSaveBlocker
          └─ true  ─► start("prevent-app-suspension") immediately
                       （与当前是否有运行中闲时任务无关）
```

- 默认 false。
- General Settings、Automations banner、创建/编辑页看到的是同一个 setting。
- desktop 启动和 setting 更新时立即同步 `powerSaveBlocker`。
- scheduler 仍会上报 active count，但 main 的 count callback 已不再决定 blocker。
- 只能阻止应用/系统因空闲自动休眠，不能阻止合盖或用户主动睡眠。

## 14. Desktop / Web / Mobile Remote 边界

- `IOffPeakTaskService` 被加入 common accessor 和 remote service client，是为了统一服务契约，不代表 mobile remote 开放该产品。
- 手机 `/remote` 隐藏 Automations；命中陈旧 route 会退回 chat。
- desktop remote workspace 隐藏 idle task 和侧栏组。
- 创建 project selector 只给本地已打开 workspace。
- 没有新增独立 remote Agent runtime、local host、SSH/WSL/Docker session。
- 没有修改 relay 的业务职责，也没有把 task/queue/snapshot 状态放进 relay/main。
- 桌面派发明确使用 `desktop-continuous`；没有绕过手机 `web-remote-replayable` 的恢复边界。

## 15. 测试覆盖与当前验证状态

### 15.1 新增/扩展自动化测试

| 层 | 覆盖 |
|---|---|
| adapter retry | 9 类 429/3105/3102、Retry-After、generate/stream 边界与普通 provider 隔离 |
| Repo | 16 类建表、状态守卫、claim、恢复、续跑、History、settle outbox |
| Service | 10 类创建、暂停/继续、同步、续票、取消/核销与错误分流 |
| Server client/mock | 7 类接口解析、信封、null position、availability、状态推进、错误码 |
| Runtime model | 5 类双凭证、provider 构造、用户模型选择、多 provider 回退 |
| Client config/gray | 5 类配置开关、allowed models、availability fail-closed/refresh |
| 端到端服务集成 | 3 类 mock take → ready → dispatch/续跑闭环 |
| Scheduler settlement | 3 类 success/permanent/transient 与退避 |
| UI | project options、store 并发、History 映射、toast、remote mobile 隐藏 |
| WDIO | 创建/管理流、额度 availability pre-gate 两条 spec |

### 15.2 Conversation catalog

- `docs/conversation-session-case-catalog.md` 增加 OP01–OP09。
- 覆盖矩阵登记 off-peak 场景和边界。
- GUI 的 OPF/OPA/OPR/OPB 仍标为 planned。
- OPP 已写用例，但矩阵仍记录为待目标环境执行。
- service mechanism 对 OP02/OP04/OP07 有覆盖。

### 15.3 不能误读的测试结论

- E2E 能验证 UI 管理和服务门控，不等于真实线上低峰调度、真实套餐计费、3 小时自然过期都已验证。
- mock 上游代理模式使用用户自己的 Coding Plan key，不能据此证明线上 idle-plan 计费链路。
- awaiting approval 没有生产事件接线，相应 UI/通知存在也不等于端到端可用。
- coverage matrix 中的 pending/planned 项仍是待补验证，不应在 MR 描述中写成全覆盖。

## 16. CI、开发环境和文档改动

### 16.1 GitLab CI

- workflow 接受 API pipeline source，避免 API 触发直接被顶层规则过滤。
- manual conversation E2E、legacy manifest、sandbox upload/preload 等 job 的 source 条件同步允许 API。
- 这部分是测试/发布触发能力调整，与 Off-Peak 领域逻辑没有直接耦合。

### 16.2 mise 开发目录隔离

- `mise run dev` 增加 `ZCODE_DATA_BASE_DIR={{env.HOME}}/.zcode-dev-home`。
- 开发态桌面数据与默认 `~/.zcode` 生产数据隔离。
- 文档和 root build script test 同步。
- `pnpm dev:desktop:test` 的既有语义未被改成相同入口。
- OAuth 自定义 scheme `zcode://` 仍可能与已安装正式版竞争，这是隔离 data dir 无法解决的系统注册边界。

### 16.3 文档

- `spec.md`：产品语义、状态机、provider、UI 和 History。
- `decisions.md`：D22–D39 等设计取舍与演进。
- `tech-design.md`：数据、进程、接口和时序设计。
- `implementation-notes.md`：最终关键文件图、模型恢复和联调说明。
- `glossary.md`：术语与状态映射。
- `table-design.html`：表格化的实现审计、风险与生命周期报告。
- conversation catalog/coverage matrix：测试登记。
- scheduled-tasks 主视图文档：澄清两类 Automations 的边界。

原 MR Head 的 `tech-design.md`、`glossary.md` 与 ADR 早期段落曾混用“规划/尚未实现”、
register/per-task GET、3001、D36 静态 limit 和批准切 provider 等历史语义。2026-07-22 的
follow-up 文档修复已把 tech design/glossary/spec 对齐当前代码，并在 `decisions.md` 顶部明确
ADR supersession 规则；批准切 provider 仍被标为未实现能力，而不是改写成已完成。

## 17. MR 内被替代或反复修正的方案

| 主题 | 中间态 | MR Head 最终态 |
|---|---|---|
| 额度预判 | D36 `limit.max_tasks/sliding_window` + 本地 createdAt | D39 server availability snapshot + POST 最终权威 |
| Keep Awake | 开关且 active count > 0 才 blocker | 全局开关打开即 blocker |
| Session 模型 | 首次创建可能落到 provider 排序第一项 | workspace default → lastUsed → current，保留完整 provider/model |
| 临时 provider 生命周期 | turn 后恢复时机有排队消息串 provider 风险 | ready/queue drain 前恢复并清理 turn overlay |
| ticket expired code | 早期 3001 | 3102 为正式码，保留 3001 兼容 |
| UI | 多轮 Figma 对齐 | 创建 composer、两列卡片、History、边缘态与锁定态收敛 |
| 接口数量表述 | 四个接口 | 四个 ticket JSON 接口 + 一个 messages endpoint |
| 立即执行 | 早期方案保留 | v1 删除立即执行入口 |

## 18. 已知缺口、风险与技术债务

### 18.1 功能缺口

1. `awaiting_approval` 没有从 agent permission 事件接入生产链路。
2. 批准后切用户 provider 和“继续将使用你自己的套餐配额”提示未实现。
3. ~~UI 与 runtime 的 Coding Plan 支持矩阵不一致。~~ 已在 D40 统一为 selected credential snapshot，
   覆盖 ZAI 个人、BigModel 个人与 BigModel Team。
4. History 不提供 ticket/分段级审计。

### 18.2 一致性与恢复风险

1. POST ticket 成功、SQLite insert 失败会产生服务端孤票。
2. Delete 在 settle 网络/5xx 失败后物理删 row，会丢失 outbox 重试依据。
3. sync 的 `not_found` 不自动 retake；Continue 才会重取。
4. take ticket 若意外直接返回 active/expired/settled/not_found，当前仍可能创建 queued 但不可调度的 task；其中只有部分 expired 路径能自动收敛。
5. 多 host 各自启动 sync loop，会重复 status/settle 请求。
6. `next_poll_at` 不是逐任务调度器，只是快照；共享 timer 可能比字段语义更粗。
7. UI `running` 早于 messages 真正 admission，429 等待期间状态表达不精确。
8. task row 只保存当前 ticket，换票覆盖后无法在本地审计历史 ticket。

### 18.3 剩余语义漂移与已修正文档债务

1. 源码部分注释仍写“status polling 触发 server promote”；当前服务端事实是自行 timer promote，客户端 polling 只是观察。
2. shared 类型注释写 permission 默认 `default`，UI 实际默认 `build`（代码注释债务仍在）。
3. ~~tech design/glossary 的实现状态头过期~~：已于 2026-07-22 改为已实现代码事实快照。
4. 3001 仅保留为 adapter 兼容和历史 ADR；当前文档统一声明 3102 为正式码。
5. D36 静态额度只保留在历史 ADR，并已明确被 D39 supersede；当前 spec/tech/glossary 只把 availability + POST 3103 作为现状。

## 19. 建议的合并验收清单

- [ ] 产品确认：`awaiting_approval` 是本 MR 必须完成，还是明确降级为后续能力。
- [ ] 若必须完成，补 permission event → awaiting → approve/reject → provider switch 的端到端状态机和配额提示。
- [x] Team Plan 纳入支持矩阵，并复用现有 runtime-key helper；ZAI/BigModel 个人、Team 与拒绝态已有矩阵测试。
- [ ] 在目标环境用真实 ZAI 与 Team 凭据各跑一次 availability → take → messages → settle 联调。
- [ ] 评估孤 ticket 和 Delete 丢 outbox 的补偿策略。
- [ ] 为 `not_found` 和意外 take 初态定义统一 retake/fail 规则。
- [ ] 决定是否接受多 host 重复 sync，或增加单 owner。
- [x] 更新陈旧文档头、接口/额度/3001-3102/approval provider 表述；permission 默认的 shared 代码注释另列代码债务。
- [ ] 在目标环境执行 pending WDIO/真实服务联调，验证 availability、ready、429、3102、settle。
- [ ] 确认 CI API source 放宽和 mise data-dir 隔离确实应与该 MR 一起合入。


## 20. 提交演进全表

该表用于解释 MR 内方案为何出现旧文案或被后续提交替代；最终行为仍以 MR Head 代码为准。

| # | Commit | 日期 | 主题 |
|---:|---|---|---|
| 1 | `d8ed02147a` | 2026-07-15 | docs(off-peak-task): 设计收敛 D22-D31——四接口契约/长等待策略/Automations 范式定案/灰度开关 |
| 2 | `ffe085c903` | 2026-07-15 | docs(off-peak-task): 修正领域模型陈旧片段——对齐 D28-D30 定案 |
| 3 | `6070fe0ee2` | 2026-07-15 | feat(off-peak): shared 领域类型与派发协议消息对（MR1 之一） |
| 4 | `d5f9f3ce7d` | 2026-07-15 | feat(off-peak): off_peak_tasks 存储与 OffPeakTaskRepo 状态机守卫（MR1 之二） |
| 5 | `7fc49a1c17` | 2026-07-15 | chore: merge origin/main into feat/automations_v2 |
| 6 | `9f57eb9a88` | 2026-07-15 | docs(off-peak-task): §11 六项开工前 spike 结论落档（2026-07-15 全部完成） |
| 7 | `bdaa94be53` | 2026-07-15 | docs(off-peak-task): D32/D33 定案落档——砍掉立即执行 + per-turn 注入 + 单批交付 |
| 8 | `ba1d737838` | 2026-07-15 | feat(off-peak): 调度链路——scheduler tick 认领派发 + main 路由 + host OffPeakRun（工序 2） |
| 9 | `5e5cf11c60` | 2026-07-15 | docs(off-peak-task): E2E case catalog OP 组登记 + 覆盖矩阵剪枝定案 |
| 10 | `de39441e30` | 2026-07-15 | feat(off-peak): repo 续跑回队/外部主键/非终态清单 + 3001 稳定错误标记（工序 3 之一） |
| 11 | `324a1cb27f` | 2026-07-15 | feat(off-peak): 服务端四接口客户端 + 进程内 mock 网关（工序 3 之二） |
| 12 | `6d133cb8ef` | 2026-07-15 | feat(off-peak): offPeakTaskService 编排——创建取号/取消/Pause-Continue/同步轮询/核销 outbox/3001 续跑（工序 3 之三） |
| 13 | `8c64637d51` | 2026-07-15 | feat(off-peak): 适配层排队重试协议——429/3105 豁免预算无限探测 + 3001 续跑标记（工序 3 之四） |
| 14 | `42a3842a79` | 2026-07-15 | feat(off-peak): per-turn runtimeModel 注入——idle plan 单轮生效零持久化（工序 3 之五，D33 落地） |
| 15 | `8b5cc76028` | 2026-07-15 | feat(off-peak): client/configs 灰度配置接入——getOffPeakClientConfig + 有效开启判据（工序 3 之六，D31） |
| 16 | `86de3d93c9` | 2026-07-15 | feat(off-peak): host 运行时装配——mock 网关/双凭证/per-turn 派发/3001 续跑闭环（工序 3 之七，收口） |
| 17 | `b28f8bf883` | 2026-07-15 | feat(off-peak): IOffPeakTaskService 专用服务通道——renderer RPC 接入面（工序 4 之一） |
| 18 | `3c998f3d39` | 2026-07-15 | feat(off-peak): Automations 主视图 UI——三 Tab/创建表单/列表卡片/灰度门控（工序 4 之二） |
| 19 | `8d21d75de4` | 2026-07-15 | feat(off-peak): keep-awake powerSaveBlocker——执行中阻止闲置休眠（工序 4 之三，D4/D30-3） |
| 20 | `2efe656380` | 2026-07-15 | feat(off-peak): 系统通知——完成/失败/等确认三 variant（工序 5 之一，D10/D30-5） |
| 21 | `1c3316e264` | 2026-07-15 | test(off-peak): mock 网关固定响应模式 + 端到端集成测试（工序 5 之二） |
| 22 | `f896aba939` | 2026-07-15 | docs(off-peak-task): 实现说明——全链路图 + 关键文件地图 + 计费边界踩坑 + 本地演示 |
| 23 | `feabfd94fb` | 2026-07-15 | feat(off-peak): 侧栏 Group 系统分组「Idle-time task」（spec §5 侧栏，D28/D30-5） |
| 24 | `2aa9a953d1` | 2026-07-15 | test(off-peak): WDIO 创建/管理 E2E + mock 网关 E2E 接线（工序 5 之三） |
| 25 | `250f4e63f9` | 2026-07-15 | Merge remote-tracking branch 'origin/main' into feat/off-peak-task |
| 26 | `83d85fda4f` | 2026-07-15 | test(off-peak): 修复 e2eBeforeSessionSetup 单测——补 startOffPeakMockIfNeeded stub |
| 27 | `d64f9d8b77` | 2026-07-15 | fix(off-peak): 闲时任务 tab 泄漏定时任务 UI——空状态/通过对话创建/模板区 |
| 28 | `d3027d8344` | 2026-07-15 | feat(off-peak): New task 页闲时任务入口——引导横幅 + 模板卡（Figma 4798-2126，spec §5 第二入口） |
| 29 | `dc45ef2d4c` | 2026-07-16 | feat(off-peak): 创建表单对齐 Figma 4827-1398——composer 范式重写 |
| 30 | `bfdf4a07b4` | 2026-07-16 | feat(off-peak): 任务列表对齐 Figma 4866-1735——2 列卡片网格 + 保持唤醒横幅 |
| 31 | `06649d7d01` | 2026-07-16 | feat(off-peak): 列表状态态对齐 Figma 4866-2175——paused 显示 #N Paused + Pause/Continue 信息提示 |
| 32 | `918db40823` | 2026-07-16 | feat(off-peak-task): 补齐 thoughtLevel 推理档位字段——与 automation 对齐（D34） |
| 33 | `effe6f52cf` | 2026-07-16 | fix(off-peak-task): New task 入口/推理档位默认对齐 Figma——agent-browser 实测修正 |
| 34 | `cc30501301` | 2026-07-16 | fix(off-peak): repair ticket execution lifecycle |
| 35 | `b5a8101a06` | 2026-07-16 | fix(dev): isolate mise dev data from production |
| 36 | `fdb628112e` | 2026-07-16 | fix(off-peak-task): 卡片状态态/编辑页动作对齐 Figma——多状态实测修正 |
| 37 | `c72b97760c` | 2026-07-16 | feat(off-peak-task): 边缘态逐帧对齐 Figma——丢弃草稿/History 表格/权限两行下拉/完全访问提示/达上限置灰（D35） |
| 38 | `06ecb87dbb` | 2026-07-16 | feat(off-peak-task): 非 coding plan 锁定态落地——按当前时刻注册表判定（D35 拍板） |
| 39 | `c99978f9c4` | 2026-07-16 | docs(off-peak): mark reactive quota grey-out as transitional |
| 40 | `882fc6c3f2` | 2026-07-17 | docs(off-peak-task): 记录服务端契约真源 + 额度口径修正 + 达上限置灰目标形态（D36） |
| 41 | `80e8d13ee0` | 2026-07-17 | docs(off-peak-task): D36 收口——确认 limit.{max_tasks,sliding_window} 字段名 + sliding_window 单位秒 |
| 42 | `3ede57ca8e` | 2026-07-17 | feat(off-peak-task): D36 实现——配置预判置灰 + 3103 兜底 |
| 43 | `eac5bb9e24` | 2026-07-17 | test(off-peak-task): D36 达上限 pre-emptive 置灰 E2E + wdio mock 钩子 |
| 44 | `7e7a52ebf6` | 2026-07-17 | chore(off-peak-task): startOffPeakE2EMock 注入 ZCODE_OFFPEAK_MOCK_LIMIT |
| 45 | `f290620194` | 2026-07-20 | merge: origin/main into feat/off-peak-task |
| 46 | `90a0a8bcc6` | 2026-07-20 | fix(build): repair merged development blockers |
| 47 | `03e9661b15` | 2026-07-20 | docs(automations): align idle-time figma behavior |
| 48 | `0c0ad960d5` | 2026-07-20 | feat(automations): align idle-time task UX and boundaries |
| 49 | `c01f70de34` | 2026-07-20 | Merge remote-tracking branch 'origin/main' into feat/off-peak-task |
| 50 | `2a4cc85a43` | 2026-07-20 | docs(off-peak): add table design and lifecycle report |
| 51 | `fdf46ee9ed` | 2026-07-20 | docs(off-peak): expand architecture walkthrough |
| 52 | `c3a9e2ad92` | 2026-07-20 | Merge remote-tracking branch 'origin/main' into feat/off-peak-task |
| 53 | `7f15dbd8cb` | 2026-07-20 | test(automations): align mobile remote visibility |
| 54 | `9e88d54923` | 2026-07-21 | ci: allow API-triggered pipelines for manual test builds |
| 55 | `b636776a27` | 2026-07-21 | fix(off-peak): preserve CLI turn model lifecycle |
| 56 | `74ed7a5d9b` | 2026-07-21 | fix(off-peak): keep quota retries available |
| 57 | `7f00a7ece3` | 2026-07-21 | fix(off-peak): inherit workspace model for run sessions |
| 58 | `436f3d956a` | 2026-07-21 | feat(off-peak): use server quota availability |
| 59 | `e50f08b78e` | 2026-07-21 | fix(off-peak): prevent stalled task dispatches |
| 60 | `cc3980d2a1` | 2026-07-21 | feat(desktop): make keep-awake a global settings switch |

## 21. 115 个改动文件逐项清单

状态：`A`=新增，`M`=修改。行数取自 MR 精确 diff；本表每个 changed path 恰好出现一次。

| # | 状态 | 行数 | 文件 | 具体改动 |
|---:|:---:|---:|---|---|
| 1 | M | +4/-2 | `.gitlab/ci/00-workflow.yml` | 顶层 workflow 放行 API source pipeline，避免 API 触发在创建阶段被过滤。 |
| 2 | M | +2/-2 | `.gitlab/ci/20-test.yml` | 测试 job 的规则同步接受 API source，覆盖手动 conversation E2E 等入口。 |
| 3 | M | +1/-1 | `.gitlab/ci/30-build.yml` | 构建阶段的 source 条件补充 API 触发。 |
| 4 | M | +3/-3 | `.gitlab/ci/50-release.yml` | release/sandbox 相关手动 job 放行 API source。 |
| 5 | A | +62/-0 | `apps/zcode-cli/packages/adapters/src/model/offpeak-retry.ts` | 新增闲时 provider 专用失败分类：429/3105 排队等待、3102/legacy 3001 票据失效标记、Retry-After 钳制。 |
| 6 | M | +40/-4 | `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts` | generate runner 接入 Off-Peak 决策；容量等待不消耗普通 retry budget，并支持 abort。 |
| 7 | M | +75/-5 | `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts` | stream runner 接入同类重试，但仅在尚未越过可见输出边界时重放。 |
| 8 | A | +296/-0 | `apps/zcode-cli/packages/adapters/tests/offpeak-retry.test.ts` | 覆盖 Off-Peak 专用 generate/stream 重试、Retry-After、业务码和普通 provider 隔离。 |
| 9 | M | +45/-15 | `apps/zcode-cli/packages/bootstrap/src/app/model-catalog-overlay.ts` | 把 runtime overlay 拆成 workspace 层与 turn 层，支持单轮安装、清理及 registry 刷新。 |
| 10 | M | +19/-8 | `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` | session facade 增加 turn runtime model 生命周期，并在 turn 结束恢复用户模型。 |
| 11 | M | +14/-1 | `apps/zcode-cli/packages/bootstrap/src/app/types.ts` | 扩展 model catalog overlay/session 类型，表达 turn-scoped overlay。 |
| 12 | M | +51/-12 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts` | session 创建/恢复流处理显式用户模型及 turn overlay 清理顺序。 |
| 13 | M | +18/-0 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts` | prompt turn 接收并安装 turnRuntimeModel，记录前一模型以便终态恢复。 |
| 14 | M | +10/-0 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/types.ts` | 命令上下文类型增加 turn runtime model/恢复信息。 |
| 15 | M | +3/-0 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` | 把 Off-Peak queued retry 投影为可恢复 rate-limit fault。 |
| 16 | M | +61/-0 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` | 旧桥接层透传 turnRuntimeModel，保持 v4 native/bridge 两条命令路径一致。 |
| 17 | M | +53/-3 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts` | workspace catalog 热更新时保留 turn overlay，并处理已移除原模型的安全回退。 |
| 18 | M | +69/-0 | `apps/zcode-cli/packages/bootstrap/tests/model-catalog-overlay.test.ts` | 验证 workspace/turn 双层 overlay 的合并、替换和清理。 |
| 19 | A | +131/-0 | `apps/zcode-cli/packages/bootstrap/tests/offpeak-turn-model-overlay.test.ts` | 验证闲时单轮 provider 生效、终态前恢复、排队用户消息不串用临时 provider。 |
| 20 | M | +69/-0 | `apps/zcode-cli/packages/bootstrap/tests/v4-native-commands.test.ts` | 覆盖 native v4 sendText 的 turnRuntimeModel 参数和 busy 拒绝边界。 |
| 21 | M | +53/-0 | `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts` | 覆盖 bridge 协议的临时模型透传和恢复行为。 |
| 22 | M | +2/-0 | `apps/zcode-cli/packages/contracts/src/model/index.ts` | 模型合同增加 Off-Peak queued retry reason。 |
| 23 | M | +30/-0 | `docs/conversation-session-case-catalog.md` | 登记 OP01–OP09 闲时 session 生命周期、续跑、恢复和 provider 边界案例。 |
| 24 | M | +6/-1 | `docs/development-mise-runtime.md` | 记录 mise dev 使用独立数据目录及与其他开发入口/OAuth scheme 的边界。 |
| 25 | M | +277/-4 | `docs/off-peak-task/decisions.md` | 累计 D22–D39 设计决策，包括接口、两轴状态、per-turn provider、UI、额度和 History 演进。 |
| 26 | M | +14/-2 | `docs/off-peak-task/glossary.md` | 原 MR Head 补充 ticket/task/session 与状态术语但保留讨论稿头；2026-07-22 follow-up 已重写为当前实现术语表。 |
| 27 | A | +87/-0 | `docs/off-peak-task/implementation-notes.md` | 新增最终实现文件地图、派发链路、用户模型选择、恢复时机、计费和本地演示说明。 |
| 28 | M | +92/-54 | `docs/off-peak-task/spec.md` | 更新完整产品规范：创建、状态、provider、权限、UI、History、灰度与边缘行为。 |
| 29 | A | +3083/-0 | `docs/off-peak-task/table-design.html` | 新增 3,083 行可视化生命周期/表格审计，包含当前事实、方案演进和风险清单。 |
| 30 | M | +327/-128 | `docs/off-peak-task/tech-design.md` | 原 MR Head 扩充设计但混有规划期语义；2026-07-22 follow-up 已对齐最终接口、额度、Provider 和 permission 边界。 |
| 31 | M | +23/-0 | `docs/testing/conversation-session-e2e-coverage-matrix.md` | 增加 Off-Peak case 覆盖矩阵，区分已覆盖、planned 与 pending execution。 |
| 32 | M | +9/-4 | `docs/ui/scheduled-tasks-main-view.md` | 明确 Scheduled 与 Idle-time task 在 Automations 主视图中的并存和边界。 |
| 33 | M | +2/-1 | `mise.toml` | 为 mise dev 注入 ZCODE_DATA_BASE_DIR=~/.zcode-dev-home，隔离正式数据。 |
| 34 | M | +5/-0 | `packages/client/src/remoteServiceAccess.ts` | remote service accessor 暴露 IOffPeakTaskService 合同；不等于 mobile remote 开启产品。 |
| 35 | M | +381/-0 | `packages/desktop/src/host/index.ts` | 实现 host 侧 Off-Peak runtime 装配、双凭证、用户模型解析、首次 session 创建、续跑派发、终态订阅与 3102 闭环。 |
| 36 | M | +62/-0 | `packages/desktop/src/main/desktopCronScheduler.ts` | 在 main 调度桥中转 OffPeakRun/Result、scheduler wake 和 active count 消息。 |
| 37 | M | +28/-0 | `packages/desktop/src/main/desktopHostProcess.ts` | host process 消息处理新增 Off-Peak 派发结果与唤醒回调。 |
| 38 | M | +44/-0 | `packages/desktop/src/main/index.ts` | 装配 scheduler/host Off-Peak 路由，并按全局 setting 管理 powerSaveBlocker。 |
| 39 | M | +113/-1 | `packages/desktop/src/scheduler/index.ts` | scheduler 增加 20 秒认领派发、启动恢复、in-flight 集合、transient backoff 和结果结算。 |
| 40 | A | +85/-0 | `packages/desktop/src/scheduler/offPeakDispatchSettlement.ts` | 新增派发结果分类器：成功 markRunning、永久失败落终态、暂态释放 claim 并指数退避。 |
| 41 | M | +31/-0 | `packages/desktop/src/scheduler/schedulerProtocol.ts` | 新增 scheduler 与 main 间 OffPeakRun、Result、wake/active-count 协议类型。 |
| 42 | M | +2/-0 | `packages/desktop/test/e2e/helpers/e2e-before-session.ts` | E2E 启动辅助接入 Off-Peak mock 环境准备。 |
| 43 | A | +182/-0 | `packages/desktop/test/e2e/automations/off-peak/off-peak-create-manage.test.ts` | 新增 WDIO 创建、编辑、暂停、继续、删除和列表管理流程。 |
| 44 | A | +120/-0 | `packages/desktop/test/e2e/automations/off-peak/off-peak-limit-pre-gate.test.ts` | 新增 availability/额度预门控 E2E；文件名仍沿用早期限额语义。 |
| 45 | M | +4/-0 | `packages/desktop/test/e2eBeforeSessionSetup.test.ts` | 为新增 mock 启动钩子补 stub，保持启动 helper 单测稳定。 |
| 46 | A | +99/-0 | `packages/desktop/test/offPeakDispatchSettlement.test.ts` | 覆盖 scheduler 派发结果的 success/permanent/transient 结算和退避。 |
| 47 | M | +13/-0 | `packages/desktop/test/root-build-scripts.test.ts` | 断言 mise dev 数据目录隔离配置，保护根构建脚本。 |
| 48 | M | +51/-19 | `packages/desktop/wdio.conf.ts` | 按 Off-Peak spec 自动注入 mock env、ready/TTL/poll/availability 参数并清理。 |
| 49 | M | +3/-0 | `packages/services/src/accessor.ts` | 服务访问器加入 IOffPeakTaskService。 |
| 50 | M | +52/-0 | `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | 从 client configs 解析 Off-Peak enable/allowed_models，并提供计划状态信息。 |
| 51 | M | +3/-0 | `packages/services/src/coding-plan-subscription/codingPlanSubscription.ts` | 订阅领域合同增加 Off-Peak client config 读取能力。 |
| 52 | M | +1/-0 | `packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts` | service 转发 provider 的 Off-Peak client config。 |
| 53 | M | +3/-0 | `packages/services/src/index.ts` | 公开导出 Off-Peak service/repo/runtime/server client 等模块。 |
| 54 | M | +72/-0 | `packages/services/src/node.ts` | Node 服务容器装配 Repo、server client、origin resolver、同步回调和 IOffPeakTaskService。 |
| 55 | A | +475/-0 | `packages/services/src/session/offPeakMockGateway.ts` | 新增完整进程内 ticket/messages mock 网关，支持状态推进、故障注入、离线响应和真实上游代理。 |
| 56 | A | +234/-0 | `packages/services/src/session/offPeakRuntimeModel.ts` | 新增永久错误类型、用户常驻模型解析、双凭证解析、单轮内置 provider 构造及 mock origin。 |
| 57 | A | +251/-0 | `packages/services/src/session/offPeakServerClient.ts` | 新增 availability/take/status/settle HTTP 客户端、Zod 宽容解析、双鉴权、超时和类型化业务错误。 |
| 58 | A | +44/-0 | `packages/services/src/session/offPeakTask.ts` | 定义 IOffPeakTaskService RPC 合同、编辑参数和 service descriptor。 |
| 59 | A | +727/-0 | `packages/services/src/session/offPeakTaskRepo.ts` | 新增 off_peak_tasks SQLite schema、迁移、查询、条件状态转换、事务 claim、恢复、续跑及 settle outbox。 |
| 60 | A | +453/-0 | `packages/services/src/session/offPeakTaskService.ts` | 新增取号后落库、CRUD、暂停/继续、ticket 批量同步、重取、scheduler wake 和核销编排。 |
| 61 | M | +11/-0 | `packages/services/src/session/zcodeTaskService.ts` | sendText 请求支持可选 turnRuntimeModel。 |
| 62 | M | +2/-0 | `packages/services/src/zcode-agent/zcodeAgent.ts` | Agent 发送接口类型透传临时 runtime model。 |
| 63 | M | +5/-0 | `packages/services/src/zcode-agent/zcodeAgentService.ts` | Agent service 继续透传 turnRuntimeModel 到协议层。 |
| 64 | M | +12/-2 | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | task adapter 将临时模型放入 session/sendText，并保持旧调用兼容。 |
| 65 | A | +115/-0 | `packages/services/test/offPeakClientConfig.test.ts` | 覆盖灰度 enable、allowed models、计划状态和配置缺失边界。 |
| 66 | A | +173/-0 | `packages/services/test/offPeakE2eIntegration.test.ts` | 以 mock 验证取号、ready、消息准入、终态/续跑等服务级闭环。 |
| 67 | A | +101/-0 | `packages/services/test/offPeakRuntimeModel.test.ts` | 覆盖凭证缺失、provider 配置、header 和多 provider 用户模型选择。 |
| 68 | A | +259/-0 | `packages/services/test/offPeakServerClient.test.ts` | 覆盖五类 server interaction 的解析、信封、null、超时/错误和 availability 约束。 |
| 69 | A | +487/-0 | `packages/services/test/offPeakTaskRepo.test.ts` | 系统覆盖 schema、CRUD、编辑守卫、claim、终态、恢复、History 和 outbox。 |
| 70 | A | +301/-0 | `packages/services/test/offPeakTaskService.test.ts` | 覆盖 create/cancel/pause/continue/sync/retake/settle 与服务端异常分支。 |
| 71 | M | +2/-0 | `packages/services/test/zcodeAgentService.providerRegistry.test.ts` | 调整 provider registry 测试以容纳临时 runtime model 透传。 |
| 72 | M | +20/-0 | `packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts` | 确保新增 off_peak_tasks 不破坏 legacy task index 兼容和初始化。 |
| 73 | M | +8/-0 | `packages/shared/src/channels.ts` | 新增 Off-Peak service channel 与跨进程消息名。 |
| 74 | M | +14/-0 | `packages/shared/src/coding-plan-subscription.ts` | 增加 Off-Peak client config/allowed model 共享类型。 |
| 75 | M | +1/-0 | `packages/shared/src/index.ts` | 从 shared barrel 导出 off-peak-types。 |
| 76 | A | +118/-0 | `packages/shared/src/off-peak-types.ts` | 新增客户端七态、常量、availability、任务实体和创建参数。 |
| 77 | M | +2/-0 | `packages/shared/src/protocol.ts` | 平台/服务协议注册 Off-Peak 相关类型。 |
| 78 | M | +12/-0 | `packages/shared/src/test-ids.ts` | 新增闲时创建、列表、表单和额度门控 E2E test id。 |
| 79 | M | +38/-0 | `packages/shared/src/validation.ts` | 为 OffPeakRun、Result、wake 和 sendText 临时模型增加运行时 schema。 |
| 80 | M | +2/-0 | `packages/shared/src/validationAppSettings.ts` | AppSettings schema 增加 keepAwakeWhileRunning，默认 false。 |
| 81 | M | +4/-0 | `packages/shared/src/zcode-protocol-v4/command.ts` | v4 sendText command 增加 turnRuntimeModel 字段。 |
| 82 | M | +2/-0 | `packages/shared/src/zcode-protocol/index.ts` | 协议公共入口导出新的 runtime model 结构。 |
| 83 | M | +17/-0 | `packages/shared/test/zcodeProtocol.test.ts` | 验证协议 schema 接受合法 turnRuntimeModel 并拒绝非法形态。 |
| 84 | M | +8/-0 | `packages/ui/src/App.tsx` | 应用根部挂载 Off-Peak 系统通知 hook。 |
| 85 | M | +26/-20 | `packages/ui/src/ConfirmDialog.tsx` | 扩展确认框 compact/destructive/关闭控制和快捷键行为。 |
| 86 | M | +15/-0 | `packages/ui/src/SettingsPage.tsx` | General Settings 增加全局 keep-awake switch。 |
| 87 | M | +56/-36 | `packages/ui/src/WorkspaceSidebar.tsx` | 桌面 grouped sidebar 接入 Idle-time task 系统组并处理 session/Automations 导航。 |
| 88 | M | +20/-7 | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | 根据 desktop/local/remote 布局边界决定 Off-Peak 侧栏数据与显示。 |
| 89 | M | +68/-4 | `packages/ui/src/components/ui/toast.tsx` | Toast 新增位置、info/warning、action、dismiss 和较长时长能力。 |
| 90 | A | +43/-0 | `packages/ui/src/hooks/useAutomationProjectOptions.ts` | 统一筛选当前已打开可用的本地 workspace，供 scheduled/off-peak 表单复用。 |
| 91 | A | +96/-0 | `packages/ui/src/hooks/useOffPeakTaskNotifications.ts` | 新增 completed/failed/awaiting 边沿系统通知、首次 baseline 和去重。 |
| 92 | M | +2/-2 | `packages/ui/src/i18n/IntlProvider.tsx` | 同步 locale provider 类型以接纳新增消息键。 |
| 93 | M | +116/-6 | `packages/ui/src/i18n/locales/en-US.ts` | 补齐英文闲时任务、状态、表单、额度、History、keep-awake 和通知文案。 |
| 94 | M | +107/-5 | `packages/ui/src/i18n/locales/zh-CN.ts` | 补齐对应简体中文文案。 |
| 95 | M | +1018/-1226 | `packages/ui/src/settings/AutomationEditView.tsx` | 现有 scheduled automation 表单改用共享本地项目候选；大部分行变动为格式化重排。 |
| 96 | M | +701/-115 | `packages/ui/src/settings/AutomationsSection.tsx` | 主视图接入三 tab、gray/availability、创建/编辑路由、任务列表、模板、History 和 keep-awake banner。 |
| 97 | A | +65/-0 | `packages/ui/src/settings/OffPeakEditActionsMenu.tsx` | 新增编辑页按任务状态显示 Pause/Continue/Delete 等动作菜单。 |
| 98 | A | +516/-0 | `packages/ui/src/settings/OffPeakEditView.tsx` | 新增创建/编辑 composer、权限/模型/推理选择、草稿守卫、History tab 和全局设置镜像。 |
| 99 | A | +135/-0 | `packages/ui/src/settings/OffPeakHistoryTab.tsx` | 新增一任务 0/1 行的聚合 History、状态/时长映射和行菜单。 |
| 100 | A | +125/-0 | `packages/ui/src/settings/OffPeakSidebarGroup.tsx` | 新增可折叠、跨项目汇总的 Idle-time task 侧栏组。 |
| 101 | A | +321/-0 | `packages/ui/src/settings/OffPeakTaskList.tsx` | 新增两列任务卡、状态排序、队列位次、状态动作和 session 导航。 |
| 102 | A | +75/-0 | `packages/ui/src/settings/OffPeakToolbarSelect.tsx` | 新增适配 Off-Peak composer 的工具栏下拉选择器。 |
| 103 | M | +23/-0 | `packages/ui/src/settingsPageHelpers.tsx` | 设置页辅助组件支持 keep-awake 等新配置项展示。 |
| 104 | M | +4/-0 | `packages/ui/src/store/confirmDialogStore.ts` | 确认框 store 类型增加 compact/destructive/close 等选项。 |
| 105 | A | +280/-0 | `packages/ui/src/store/offPeakTaskStore.ts` | 新增任务/灰度/availability/draft 状态、并发 operationId、CRUD action 和轮询刷新。 |
| 106 | M | +6/-2 | `packages/ui/src/v4/ConversationDraftEmptyState.tsx` | New task 空态插入闲时任务入口。 |
| 107 | A | +114/-0 | `packages/ui/src/v4/OffPeakNewTaskEntry.tsx` | 新增引导 banner、模板卡、关闭状态和 pending draft 跳转。 |
| 108 | M | +8/-0 | `packages/ui/src/v4/SessionPane.tsx` | 在 session/new-task pane 中接入 Off-Peak 空态入口与路由。 |
| 109 | A | +63/-0 | `packages/ui/test/automationProjectOptions.test.ts` | 验证仅返回已打开本地 workspace，排除 recent/remote/不可用项。 |
| 110 | A | +14/-0 | `packages/ui/test/offPeakHistoryStatus.test.ts` | 验证 History 状态映射和最短时长语义。 |
| 111 | A | +79/-0 | `packages/ui/test/offPeakTaskStore.test.ts` | 验证 store CRUD、operation 防陈旧覆盖、gray/availability 状态。 |
| 112 | M | +9/-0 | `packages/ui/test/settingsDataBaseDirControl.test.ts` | 调整设置测试以适配 dev data-base-dir 隔离。 |
| 113 | M | +25/-0 | `packages/ui/test/toast.test.ts` | 覆盖新增 toast variant、位置、action 和 dismiss。 |
| 114 | M | +12/-12 | `packages/ui/test/workspaceSidebarWebRemoteMobileLayout.test.ts` | 验证 mobile remote 隐藏 Automations/Off-Peak 并对陈旧路由回退。 |
| 115 | M | +4/-0 | `packages/web/src/main.tsx` | Web service accessor 补齐 Off-Peak service 合同/fallback 装配。 |

## 22. 本文生成时的机械校验

| 校验 | 结果 |
|---|---|
| changed path 对账 | 文中 115 条；Git 115 条；无缺失、无额外、无重复 |
| commit 对账 | 文中 60 条；Git 60 条；顺序完全一致 |
| `git diff --check` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过，0 error；当前分支输出 54 个 warning，本文未修改对应代码 |
