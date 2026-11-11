# 左侧任务行存在权威收敛设计

## Feature/change summary

| Field                 | Value                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change                | 左侧所有持久任务列表改由 `tasks-index.sqlite` 决定行集合，`sessions-index` 只补 session 实时字段                                                       |
| User-visible surfaces | Project/workspace、Timeline、Pinned、Archived、Grouped、搜索结果                                                                                       |
| Existing docs         | `docs/v4-refactor/14-sessions-index.md`、`docs/superpowers/specs/2026-07-13-v4-sidebar-task-state-authority-design.md`、`docs/ui/task-grouped-view.md` |
| Existing code owners  | `taskListMembershipSets.ts`、`buildTaskListResultFromSessions.ts`、`useGlobalTaskList.ts`、`useWorkspaceTaskLists.ts`、`useGroupedTaskView.ts`         |
| Out of scope          | transcript/rows 权威、conversation command、CLI session store schema、relay/main 业务状态、跨端 delivery 协议                                          |

本次是 3.4.0 列表数据源迁移的行为修正。运行时日志显示升级到 3.4.0 后、自动归档执行前，
Grouped 已出现历史任务缺失；回退 3.3.6 后恢复。SQLite 升级前备份中相关任务和 group membership
仍完整，说明持久 task 行不能因为 `sessions-index` 当前 snapshot 未包含对应 summary 而消失。

## Clarification log

| Round | Question                           | User answer                                                              | Boundary fixed                                    | Follow-up needed |
| ----- | ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- | ---------------- |
| 1     | 问题是否只是 Grouped 最多显示 5 条 | 不是；最新版缺失，3.3.6 显示完整                                         | 不是 UI cap，属于版本数据源回归                   | no               |
| 2     | 是否仅修 Grouped                   | 所有左侧列表都应使用同一逻辑，包括项目                                   | Project/Timeline/Pinned/Archived/Grouped 全部纳入 | no               |
| 3     | 行存在和实时字段分别由谁负责       | 明确要求以 task index 为准，session index 提供更多详细数据               | tasks-index 决定持久行；sessions-index 只 enrich  | no               |
| 4     | 新建但尚未落 task index 的短窗口   | 沿用现有 optimistic/live overlay，不把 session-only 冷摘要当持久任务全集 | 临时行与持久行分层                                | no               |
| 5     | 新建任务落库后为何未进入 Project   | 用户确认当前 workspace 新建对话必须显示在“项目”列表                      | `task_created` 必须换代 tasks-index 行快照        | no               |
| 6     | SSH/WSL 任务行存在但运行 spinner 缺失 | 修复 task-index 读取归一化，不按远端路径放宽 join，也不读取历史 running 兜底 | SQLite 行实体定位字段权威；保留 workspace identity 隔离 | no               |

Case ID 从 `TSL23` 开始；`TSL22` 已被并行的 Grouped remote-data single-flight 工作预留。

## Boundary decisions

| Boundary      | Decision                               | Includes                                                         | Excludes / prunes                          | Source                                        |
| ------------- | -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| 持久行存在    | `tasks-index` list 结果是正向权威      | active、pinned、archived、group member、排序                     | 不由 sessions snapshot 缺失推断删除        | user + runtime evidence                       |
| 负向可见性    | `deleted` tombstone 最高优先级         | 所有列表 kind、live/restart/replay                               | 不物理删除 CLI transcript                  | TSL20                                         |
| 实时 activity | `sessions-index` 字段级覆盖            | phase、lastActivityAt、background、pending interaction、实时标题 | 不覆盖 membership/sort/unread              | existing V4 spec                              |
| 临时新任务    | renderer-owned optimistic/live overlay | create/send accepted 到 task row 落库之间                        | session-only 历史冷摘要不得绕过 task index | existing grouped/workspace promotion contract |
| 新建收敛边界  | `task_created` 换代 task-row snapshot  | 当前窗口、其它窗口和手机 shared-host 创建的 active task          | 不等待 sessions-index 内容帧隐式带入行     | user + task row authority invariant           |
| 搜索          | tasks-index 查询决定结果集合           | searchable_text/snippets；命中行可叠加已知 activity              | 不把 sessions title-only filter 当全文搜索 | existing search path                          |
| 多端          | 相同行存在语义                         | local、SSH/WSL/Docker、desktop continuous、web remote replayable | 不改变各自 snapshot/gap delivery           | architecture invariant                        |
| 索引读取归一化 | SQLite 行的 `task_id`、`workspace_path` 与主键 `workspace_key` 决定实体定位；合法 remote key 高于 identity 投影列 | 兼容 identity 列或 `meta_json` 缺失/残留旧 identity 的远端历史行 | 不允许投影字段改写隔离键；不按 path 跨远端 join | TSL25 + workspace identity invariant |

## Domain scope and high-risk cross-products

| Domain                     | Include?       | Why it can change behavior                                   | Primary sources                   |
| -------------------------- | -------------- | ------------------------------------------------------------ | --------------------------------- |
| Persistence/index/snapshot | yes            | 两个索引短暂或长期不一致时决定任务是否消失                   | task sqlite、sessions-index spec  |
| UI rendering/state         | yes            | 五类列表共享 query cache、分页、optimistic overlay           | UI hooks/store                    |
| Workspace identity/remote  | yes            | join 必须使用 `workspaceIdentity?.trim() \|\| workspacePath` | architecture + identity invariant |
| Mobile remote/replayable   | representative | row semantics 相同，交付恢复边界不变                         | V4 recovery docs                  |

高风险组合：

```text
task row present/absent
  × session summary present/absent/stale
  × active/pinned/archived/deleted/grouped
  × local/remote workspace identity
  -> row existence + field owner + sort/order
```

不与 provider、Goal、queue、compact、theme 或 locale 做全排列；这些维度不改变 task membership。

## Concept map and state owners

```text
CLI session store/runtime
  -> sessions-index summary ----------------------┐
       phase / activity / attention / live title  │
                                                  v
Host tasks-index.sqlite --------------------> TaskListRowState -> Sidebar
  task rows / pin / archive / delete / group      ^
  unread / cron / manual title / explicit order   │
                                                  │
Renderer optimistic task overlay -----------------┘
  only uncommitted create/send placement

create/send accepted -> optimistic row -> tasks-index commit -> task_created
                                                       |
                                                       v
                                      invalidate task-row snapshot -> Project row
```

| State/fact                           | Authority                                          | Mirrors/caches              | Evidence                             |
| ------------------------------------ | -------------------------------------------------- | --------------------------- | ------------------------------------ |
| 持久 task 行及 workspace 隔离        | tasks-index                                        | task query cache            | SQLite/list RPC/UI count             |
| pinned/archived/deleted/group/unread | tasks-index                                        | membership snapshot/overlay | SQLite + workspace event             |
| phase/lastActivity/attention         | sessions-index                                     | query entity sidecar        | V4 snapshot/delta + UI icon/order    |
| transcript/session config            | CLI conversation projection/store                  | active pane projection      | conversation snapshot                |
| 未落库的新任务                       | renderer optimistic overlay，随后 tasks-index 接管 | local store                 | create/send ACK + task-created event |

## Dimensions and candidate combinations

| Candidate ID | tasks-index row       | sessions summary                | membership      | Expected effect                                            | Status          |
| ------------ | --------------------- | ------------------------------- | --------------- | ---------------------------------------------------------- | --------------- |
| TSL23-A      | present               | absent                          | active/grouped  | 保留静态行；无 spinner/attention；显式 group order 不变    | accepted        |
| TSL23-B      | present               | present                         | 任意非 deleted  | 行来自 task index，activity/title 等按字段 owner enrich    | accepted        |
| TSL23-C      | present               | stale                           | deleted         | tombstone 排除，不因 summary 复活                          | pruned by TSL20 |
| TSL24-A      | absent                | stored completed                | none            | 不把冷 summary 直接变成持久列表行；由 syncer 先补 task row | accepted        |
| TSL24-B      | absent                | newly live                      | pending create  | 只允许既有 optimistic/live overlay 临时显示，落库后对账    | accepted        |
| TSL25-A      | present in identity A | summary in same path identity B | grouped/project | 不 join、不串 workspace；A 保留静态行                      | accepted        |
| TSL25-B      | present               | present                         | pinned/archived | membership 决定分区，sessions 字段不能改变分区             | accepted        |
| TSL25-C      | SQLite 行属于 remote identity A，但 `meta_json` 缺失/残留旧 identity | summary in identity A | grouped/project | 读取时以 SQLite 实体列归一化后 join；不得退化为 path 匹配 | accepted |
| TSL26-A      | just committed        | present or pending              | active/project  | `task_created` 换代 task-row 快照；新行进入当前 workspace  | accepted        |
| TSL26-B      | absent                | draft only                      | none            | 未发送草稿不伪造持久 task 行                               | pruned          |

## Pruning decisions

| Decision ID | Pruned combinations                     | Guard/invariant                                       | Representative coverage                                 |
| ----------- | --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| P1          | desktop/mobile × 每种 membership 全排列 | delivery profile 不改变终态 row membership            | desktop unit + replayable scope/recovery existing tests |
| P2          | local/SSH/WSL/Docker 全排列             | 统一 `workspaceKey`，endpoint 使用自己的 task service | identity focused tests                                  |
| P3          | session phase × provider/Goal/queue     | phase 只影响 activity 字段，不影响持久行存在          | running/completed 两个代表值                            |
| P4          | deleted × 所有 task type/list kind      | TSL20 tombstone 负向不变量已覆盖                      | TSL20 existing tests                                    |

## Accepted cases

| Case ID | Setup                                                                          | Action                                    | Assertions                                                            | Evidence layers                         | E2E status                          |
| ------- | ------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| TSL23   | tasks-index 有 25 个 active/grouped task，sessions-index 只有其中 5 个 summary | 构建 Project/Timeline/Grouped             | 仍显示 25 行；5 行有 activity，其余使用持久 meta；组序不变            | pure projection test + hook integration | focused covered; desktop planned    |
| TSL24   | task row 与 session summary 同时存在，随后 phase/title/activity 更新           | 应用 sessions delta 和 membership refresh | 行身份/分区不变；实时字段更新；pin/unread mutation 不改 activity 排序 | projection/store test                   | focused covered                     |
| TSL25   | 同 path 不同 identity、索引 JSON identity 过期，或 session summary 缺失/迟到 | cold load、remote restore、summary 到达 | SQLite 实体列先归一化 identity；不串行；缺 summary 时不消失；正确 summary 到达后原行原地 enrich | repo + identity + hook integration | focused covered; remote GUI planned |
| TSL26   | 当前 workspace 已有旧 task-row snapshot，新对话首次发送后 task row 落库        | 收到 `task_created`                       | 换代 membership/task-row 读取；Project 立即显示新行且后续刷新不消失   | event policy + hook integration         | focused covered; desktop planned    |

## Matrix backfill and E2E handoff

| File                                                       | Change                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `docs/conversation-session-case-catalog.md`                | 新增 TSL23-TSL26                                               |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | 标记 focused tests + desktop regression representative planned |

- Provider fixture：无模型请求；使用预置 task SQLite 与可控 sessions-index snapshot。
- File-system fixture：至少包含“25 task rows / 5 summaries”的本地代表，remote identity 走 focused mock。
- Timing strategy：snapshot 前后分别断言，禁止用 sleep；使用 store frame/hydration gate。
- Review risk：不能把 task-index 历史 `status=running` 当实时 spinner；不能让 session-only 冷摘要绕过 deleted 或持久 membership。

## 2026-07-23 SSH/WSL running indicator regression

### Impact brief

| Field            | Value                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Developer intent | 修复 SSH/WSL task 行存在但 running spinner 缺失                                                                 |
| Capability       | Task persistence / workspace identity / task-list row projection                                                |
| Change layer     | persistence                                                                                                     |
| Operating mode   | planning                                                                                                        |
| Primary seeds    | `TaskIndexRepo.rowToMeta`、`buildTaskEntityKey`、`mergeTaskIndexRowsWithSessions`、`deriveTaskLeadingIndicator` |
| Out of scope     | 放宽 UI join、从持久 `status=running` 伪造 activity、协议与 delivery 语义、SQLite 全量重写                      |

```text
tasks row(workspace_key = remote identity)
        |
        | rowToMeta 以 SQLite 实体列归一化
        v
task meta(identity A) + sessions summary(identity A, phase=running)
        |
        | exact workspaceKey + taskId join
        v
activity sidecar -> loading spinner
```

SQLite 的 `(workspace_key, task_id)` 已经决定查询和隔离范围；`workspace_identity` 与 `meta_json`
都是实体字段投影，不能反向改写主键隔离。统一解析器确认合法的远端 `workspace_key` 后直接将其
恢复为 identity；非远端行再读取 identity 列，本地行仍回退 `workspacePath`。这既修复 SSH/WSL enrichment，
也保留“同 path 不同远端绝不 join”的 TSL25 不变量。

### Focused coverage

| Case     | Setup                                                            | Assertion                                             |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| TSL25-C1 | SSH 行的列 identity 正确，`meta_json` 缺 identity                | `listTaskMetas` 返回列 identity                       |
| TSL25-C2 | WSL 行的 identity 列为空，但 `workspace_key` 是合法远端 identity | 读取时从 `workspace_key` 恢复 identity                |
| TSL25-C3 | 同 path、同 taskId、不同 SSH identity                            | 只匹配完全一致 identity；错误 summary 不附加 activity |

本轮不新增 E2E case：TSL25 已定义 remote GUI 代表，当前缺口是 repo 读取层的 focused coverage。

## 2026-07-22 E2E implementation handoff

用户要求继续按优先级批量补齐本轮 bugfix E2E，不在每两条后单独暂停。已有 TSL23-TSL26
产品语义与剪枝保持不变，本轮只把两个缺失的 desktop continuous GUI 代表落到
`manual-review/pending`，不扩大到 remote/mobile 或其它列表 kind 全排列。

### Impact Brief

| Field            | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 为“task-index 持久行权威”和“首发 task_created 换代”补真实 Desktop GUI 回归证据                                       |
| Capability       | Task persistence / Project task list                                                                                 |
| Change layer     | persistence + recovery                                                                                               |
| Operating mode   | implementation-handoff                                                                                               |
| Primary seeds    | `useWorkspaceTaskLists`、`buildTaskListResult`、`bumpTaskListMembershipVersionForWorkspaceEvent`、`WorkspaceSidebar` |
| Out of scope     | 产品实现、remote GUI、mobile replayable、Pinned/Archived/Grouped 入口全排列                                          |

| User scenario      | UI entry                    | Shared implementation                        | Display/draft owner                         | Commit action                | Authority/persistence                              | Mode boundary           | Must remain isolated from                           |
| ------------------ | --------------------------- | -------------------------------------------- | ------------------------------------------- | ---------------------------- | -------------------------------------------------- | ----------------------- | --------------------------------------------------- |
| 冷启动查看历史任务 | Project workspace task rows | `useWorkspaceTaskLists` + task query cache   | renderer task-list projection               | 只读 hydration               | `tasks-index.sqlite` 决定行；sessions-index enrich | desktop continuous 代表 | session 内容、runtime config、同 path 其它 identity |
| 草稿首次发送       | V4 composer + Project row   | optimistic overlay + workspace event refresh | draft projection；随后 task-list projection | `createSession` / first send | task row commit 后 `task_created` 换代读取         | desktop continuous 代表 | 未发送 draft、mobile replayable 恢复语义            |

| Rank           | From               | Semantic edge | To                         | Why inspect it                            | Evidence                                  |
| -------------- | ------------------ | ------------- | -------------------------- | ----------------------------------------- | ----------------------------------------- | -------------- | ------------------------------ |
| must-inspect   | Project task list  | projects-from | tasks-index row/membership | summary 缺失不能删持久行                  | `useWorkspaceTaskLists`、TSL23            |
| must-inspect   | `task_created`     | invalidates   | task-row/membership cache  | 带/不带 meta 都必须看到新行               | `taskListRefreshPolicy.test.ts`、TSL26    |
| should-inspect | sessions-index     | enriches      | task-list row              | 只更新 activity/detail，不拥有 membership | `buildTaskListResultFromSessions.test.ts` |
| invariant-only | workspace key      | isolates      | row join/cache             | 必须使用 `workspaceIdentity?.trim()       |                                           | workspacePath` | TSL25、workspace identity 规范 |
| invariant-only | desktop continuous | isolated-from | mobile replayable          | 本轮 GUI 不改变 snapshot/gap 恢复链路     | TSL07 剪枝                                |

```text
cold start: tasks-index 25 rows ─┐
                                 ├─ join ─> Project first 5 ─> Show more ─> all 25
            sessions-index 1 row ┘

first send: draft(no row) -> optimistic row -> tasks-index commit -> task_created
                                                            |
                                                            v
                                              invalidate + persisted one row
```

| State/fact         | Authoritative owner          | Mirror/cache                | Proof                                       |
| ------------------ | ---------------------------- | --------------------------- | ------------------------------------------- |
| 持久行集合与 total | tasks-index                  | task query cache            | 真 SQLite + Project 分页展示 25 行          |
| 实时摘要           | sessions-index               | row enrichment              | 1 个有 summary、24 个无 summary，全部仍可见 |
| 未落库新任务       | renderer optimistic overlay  | local task-list overlay     | 首发前零行；首发后同 taskId 恰好一行        |
| 已落库新任务       | tasks-index + `task_created` | membership/query generation | renderer reload 后仍存在且不重复            |

Codegraph 从 `useWorkspaceTaskLists` 展开到 `buildWorkspaceGroupsFromSessions`、
`fetchTaskListMembershipSetsForEndpointsCached` 和 `WorkspaceSidebar` 六个调用点；实现事实与既有 spec
一致。现有功能语义图只声明 task persistence 与 SQLite，还缺 Project surface、task-list projection
和 service 关系，本轮将这些已确认关系补回图谱。

### Accepted desktop representatives

| Case  | Setup                                              | Action                             | Assertions                                                                           | Why this representative                                                         |
| ----- | -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| TSL23 | 真 tasks-index 25 行；sessions-index 只含 1 个摘要 | 冷启动 Project，连续点击 Show more | 共显示 25 个唯一 taskId；无摘要的末行存在；持久 `running` 不伪造 spinner             | focused test 已精确覆盖 25/5；GUI 用 1/24 分割覆盖相同“摘要存在/缺失”两个等价类 |
| TSL26 | 当前 Project 已 hydration，V4 pane 为未发送 draft  | 首次发送并等待 task commit         | 发送前无该 task；发送后按 taskId 仅一行；assistant 完成及 renderer reload 后仍只一行 | 覆盖 optimistic→persisted 与 `task_created` 换代，不重复 remote/mobile 交付组合 |

两条 case 都先进入 `manual-review/pending`；完成 fixture check 和本地 strict replay 后仍等待批量人工
review，再统一 promote。

### Local replay results

| Case  | Fixture check | Strict replay | Artifact                                                                     |
| ----- | ------------- | ------------- | ---------------------------------------------------------------------------- |
| TSL23 | passed        | 1/1 passed    | `packages/desktop/.e2e-artifacts/desktop-e2e-20260722-135334-434/summary.md` |
| TSL26 | passed        | 1/1 passed    | `packages/desktop/.e2e-artifacts/desktop-e2e-20260722-135432-692/summary.md` |

## 2026-07-22 TSL19/TSL20 restart regression handoff

上一批两个 Project 代表回放通过后，继续补两个与冷启动 membership 直接相关的 P0 bugfix。
TSL19/TSL20 的产品语义与剪枝已在主 catalog 确认，本轮不引入新的状态组合：只选择本地
`desktop-continuous` 的真实 UI 入口，remote/mobile 继续复用同一 task-type/membership 不变量。TSL20 的永久删除断言已按 2026-11-04 归档管理裁决更新，以下旧回放记录仅作历史证据。

```text
fork: parent completed -> Fork -> child(task_type=fork,parent_id=parent)
                                  -> switch to draft -> App restart
                                  -> cold sessions-index -> Project child row -> click/hydrate

delete: task -> archive(confirm) -> Archived -> delete(confirm)
                 -> Host row + CLI session/message/part removed
                 -> App restart -> Project/Archived/mention all omit deleted task
                                -> ordinary control task remains visible
```

| Case  | Setup                                                                                  | Action                                                                                | Assertions                                                              | Pruned combinations                                                                                    |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| TSL19 | 创建 parent 并从完成态 assistant 分叉；CLI 行为 `task_type=fork` 且 `parent_id=parent` | 切到未发送 draft 后重启 App，在 resume child 前打开 `#` 会话目录                      | 精确 `session:<childId>` 可见，证明冷启动 sessions-index 已恢复 child   | Project row 现由 tasks-index 持有，fork 未落 task row 是独立缺口；workflow/辅助 child 由 focused tests |
| TSL20 | 普通 task 从 Project 归档，再从 Archived 永久删除 | 按归档管理 2026-11-04 裁决检查持久数据后重启，普通任务作为列表已加载对照 | Host 索引与 CLI session/message/part 均移除，Project、Archived、mention 均不复活 | fork/附件引用等清理边界由 APD 系列覆盖 |

两条 case 先进入 `manual-review/pending`，使用 case-local provider fixture；fixture check 与 strict replay
通过后仍留待本批统一人工 review。

### Local replay results

| Case  | Fixture check | Strict replay | Artifact                                                                     |
| ----- | ------------- | ------------- | ---------------------------------------------------------------------------- |
| TSL19 | passed        | 1/1 passed    | `packages/desktop/.e2e-artifacts/desktop-e2e-20260722-141321-231/summary.md` |
| TSL20 | passed        | 1/1 passed    | `packages/desktop/.e2e-artifacts/desktop-e2e-20260722-141719-802/summary.md` |

TSL19 的严格回放同时暴露出一个不属于原提交 `3270dcc2c2` 的现行缺口：cold sessions-index
已经恢复 fork，但 tasks-index 没有对应 fork row，因此 Project 仍不展示 child。本批不把该缺口
伪装成原 bugfix 已覆盖；pending case 改用精确 `session:<childId>` mention 证明原提交声明的
sessions-index membership，并在矩阵中继续把 Project row 标为 partial。

## 2026-07-24 live fork task-row commit

用户确认的产品终态：显式 fork 是持久主任务，命令成功后必须立即在 Project 显示 child，
不能依赖 App/CLI 重启、再次打开 child 或下一条 runtime event 自愈。

故障不是侧栏 join，而是 hydration 边界漏发当前摘要：

```text
fork commit -> child record/resume -> 暂态 draft publisher
                                      |
                                      v
                         synthesized conversation hydration
                                      |
                         [旧] 只 flush conversation subscriber
                                      X
                            sessions-index 无 visible upsert
                                      X
                         task-index syncer 无法创建 child row

                         [新] hydration commit
                                      |
                                      v
                         publish current non-draft summary
                                      |
                                      v
                     task-index row + task_created -> Project
```

修复点必须放在 gateway hydration commit，而不是 UI 增加 session-only overlay：

- hydration 是暂态 publisher 变成完整权威 projection 的原子边界，不能等待一个不保证存在的后续事件。
- sessions-index 继续只承载轻量 summary；tasks-index 仍唯一拥有持久行与 membership。
- `isDraftSession` 过滤继续生效，未发送草稿不会被误写为 task。
- 同一个 summary 重发由 sessions-index diff 和 task-index upsert 保持幂等。
- desktop `desktop-continuous` 立即收到在线 delta；mobile `web-remote-replayable` 仍通过自己的
  connection-owned subscription、snapshot/gap 恢复同一终态，不能借此改变 recovery 协议。

代表组合按 TSL28 固定为本地 desktop、completed parent、无 hydration 后续事件。running parent 只改变
fork 前置且父 active work 必须继续；SSH/WSL/Docker 只改变 workspaceKey；mobile 只改变 delivery，
均不与 task-row 持久终态做全排列。
