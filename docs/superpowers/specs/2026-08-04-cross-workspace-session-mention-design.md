# `#` 跨 Workspace 对话 Mention

## Feature Summary

| Field                 | Value                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Change                | Composer 的 `#` 面板聚合当前会话存储 authority 下全部已打开或已恢复 workspace，并把每个 workspace 的可见候选限制为 20 条 |
| Change layer          | `option-source + presentation`                                                                                           |
| User-visible surfaces | `MentionPlugin` 的 `#` sessions 面板                                                                                     |
| Existing docs         | `docs/ui/mention-panel-layout.md`、`docs/session-context-tool.md`                                                        |
| Existing code owners  | `sessionsMentionProvider`、`useWorkspaceSessionsIndexItems`、Tab Store、remote workspace service resolver                |
| Out of scope          | `@` 对话候选范围、改写 canonical mention、跨 Host 搬运会话、Agent/协议变更、stream/queue/snapshot/replayable 语义        |

## 产品边界

用户要求 `#` 能选择所有 workspace 里的对话。本功能把“所有 workspace”定义为当前窗口任务区中
已打开或启动恢复、并且与当前 composer 共享同一会话存储 authority 的 workspace：

- `@` 虽然在当前代码中也复用 session provider，但不是本次产品入口；它继续只查询当前 workspace。
- `#` 每个 workspace 最多展示 20 条候选。空 query 时取该 workspace 最近更新的 20 条；有 query
  时先在全部历史会话中完成匹配，再按 `workspaceKey` 对匹配结果各取前 20 条，因此较老会话仍可搜索。
- 该上限只约束 renderer 候选结果，不改变 sessions-index 的订阅、snapshot 或持久化协议。

- 本地 composer 可以选择当前 window-scoped Local Host 下全部本地 workspace 的会话。多个本地
  Agent 进程共享同一个 SQLite session DB，选中后 Agent 能用 `ReadSession` 按 `sessionId` 读取。
- 远程 composer 可以选择同一个 `remoteSessionId` / Agent service authority 下多个 workspace 的会话。
- 本地与远程 Host 之间、两个不同远程 Host 之间不共享 session DB。本轮不展示另一 authority 的
  会话，避免生成能选择但读取不到的失效引用。
- 已断开的远程 workspace 不回退到本地 service；恢复对应 remote attachment 后才重新进入候选。
- 关闭、未在当前窗口恢复的 workspace 不在候选范围；本轮不新增全局持久 workspace catalog。

```text
Composer trigger
        |
        +-- @ ----------------------------> 当前 workspace sessions-index（保持原行为）
        |
        +-- #
             |
             v
当前 composer workspace
        |
        v
解析 conversation storage authority
        |
        +-- Local Host / base service
        |      └-- 当前窗口全部 local workspace sessions-index
        |
        +-- Remote Host / remoteSessionId
               └-- 同一 remote authority 下全部 workspace sessions-index

其他 Host / 未连接 remote
        └-- 剪枝：不展示，不回退到 base service

聚合结果
  -> workspaceKey = workspaceIdentity?.trim() || workspacePath 去重 scope
  -> session id 去重
  -> 当前 workspace 优先
  -> 其余按最近更新时间
  -> 全量 query 匹配
  -> 每个 workspaceKey 最多保留 20 条
  -> 仍插入 [#Title](#sess_id)
```

## UI Surface Matrix

| 用户场景              | 入口组件                        | 候选来源                                                                    | 本地状态                             | 校验/门禁                                                    | 提交结果                        | Authority / 持久化                | 多端边界                                                  |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ | ------------------------------- | --------------------------------- | --------------------------------------------------------- |
| 在 `@` 中选择相关对话 | `MentionPlugin` sessions 分组   | 当前 workspace 的 sessions-index（保持原行为）                              | Lexical trigger/query/selected index | 沿用现有门禁                                                 | 插入原 session mention Markdown | 当前 Host 的 SQLite session store | 本轮不改变                                                |
| 在 `#` 中选择相关对话 | `MentionPlugin` sessions 单分组 | 同 authority workspace tabs 的 sessions-index                               | 同上                                 | remote workspace 必须已解析 `remoteSessionId` 与对应 service | 同上                            | 同上                              | Desktop/Web/Mobile 共用 provider；不改变 delivery profile |
| 搜索跨 workspace 对话 | `MentionPanel`                  | 标题、session id、workspacePath、workspaceIdentity、model/provider keywords | query                                | 先匹配全部历史，再按 `workspaceKey` 各保留最多 20 条         | 同上                            | 无新增持久化                      | workspace label 兼容 Windows/macOS/Linux 路径             |

## 共享实现与差异行为

- `@` 与 `#` 继续共用一个 `useSessionsMentionProvider`，由触发器显式传入 workspace scope 策略；`@`
  使用 `current-workspace`，`#` 使用 `same-authority-workspaces`，不能在 provider 内无条件扩容。
- `useWorkspaceSessionsIndexItems` 继续按 `endpointKey + workspaceKey` 引用计数复用订阅；面板关闭后释放
  本消费者引用，不影响侧栏已有订阅。
- 候选行继续用 `description` 展示 workspace 末级名称；无需新增布局、颜色或字号。
- 当前 workspace 候选排在其他 workspace 前；每个分组内部继续按最近活动排序。
- `#` 的 20 条上限在 query 匹配之后按 `workspaceKey` 独立计数，不能对合并结果做全局 `slice(0, 20)`；
  否则当前 workspace 会挤掉其他 workspace。`@` 不应用该限制，保持既有当前 workspace 行为。
- canonical mention、历史解析和 `ReadSession` 的 `sessionId` 输入只保留 session id，不增加 workspace 字段。

## 影响关系

| Rank           | Relation                                                    | Reason                                                                     |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| must-inspect   | `sessionsMentionProvider -> useWorkspaceSessionsIndexItems` | 唯一候选 scope 构造点与实时聚合 owner                                      |
| must-inspect   | Tab Store + workspace service resolver                      | 提供全部已知 workspace，并阻止 remote 错路由到 base service                |
| should-inspect | `collectSessionMentionItems`                                | 已支持跨 workspace 排序、workspace label、搜索关键词和 session 去重        |
| invariant-only | `mentionMarkdown -> ReadSession`                            | canonical 与运行时读取契约不得变化                                         |
| invariant-only | desktop continuous / web remote replayable                  | 只扩大低频 sessions-index 订阅集合，不拼接 conversation stream 或 snapshot |
| evidence-only  | mention focused tests / sessions-index hook tests           | 证明 scope、排序、隔离和不预订阅行为                                       |

## State Owners

| State / fact                | Authority                                          | Mirrors / caches        | Evidence                            |
| --------------------------- | -------------------------------------------------- | ----------------------- | ----------------------------------- |
| 当前窗口 workspace 集合     | window-scoped Tab Store                            | tab persistence restore | hook test 的 workspace tabs         |
| remote workspace -> service | `remoteSessionId` + remote workspace session store | identity/path lookup    | 不同 endpoint mock service 调用次数 |
| 会话候选事实                | 各 Host 的 sessions-index                          | shared registry store   | snapshot/delta 聚合结果             |
| session context 内容        | 当前 Agent Host 的 SQLite session store            | 无跨 Host mirror        | `ReadSession` 文档与 store 实现     |
| workspace 隔离 key          | `workspaceIdentity?.trim() \|\| workspacePath`     | scope/registry key      | 同路径不同 identity focused case    |

## Boundary Decisions

| Boundary       | Decision                               | Includes                              | Excludes / prunes                  | Source                              |
| -------------- | -------------------------------------- | ------------------------------------- | ---------------------------------- | ----------------------------------- |
| workspace 集合 | 当前窗口已打开或恢复的 workspace tabs  | 本地 tabs、已连接 remote tabs         | 已关闭且未恢复的历史 workspace     | 用户请求 + 当前 Tab Store authority |
| Host authority | 只聚合同一 Agent service/session store | local-local、同 remote endpoint       | local-remote、不同 remote endpoint | `ReadSession` + SQLite store 架构   |
| 排序           | 当前 workspace 优先，其余最近更新      | 同标题、同路径不同 identity           | 全局相关度重排                     | 现有 `collectSessionMentionItems`   |
| 展示预算       | `#` 每个 workspace 最多 20 条          | 空 query 最近 20；query 后匹配前 20   | 全局 20 条；先截断再搜索           | 2026-08-05 用户确认                 |
| canonical      | 保持 `[#Title](#sess_id)`              | `#`（`@` 原行为也不变）               | workspace/endpoint 写入 mention    | 现有 runtime contract               |
| delivery       | 不改变                                 | desktop continuous、mobile replayable | stream/snapshot/queue 修改         | 远控事实文档                        |

## Candidate Combinations 与剪枝

| Candidate ID | State                                                | Event                 | Expected effect                                           | Status   |
| ------------ | ---------------------------------------------------- | --------------------- | --------------------------------------------------------- | -------- |
| CWM01        | local draft，窗口有 workspace A/B                    | 在 A 输入 `#`         | A/B 会话均出现，A 优先                                    | accepted |
| CWM02        | remote draft，同一 remote authority 有 workspace A/B | 在 A 输入 `#`         | A/B 会话均从 remote service 出现                          | accepted |
| CWM03        | local 与 remote workspace 同时存在                   | 在 local 输入 `#`     | 只出现 local authority 会话，remote 不错误走 base service | accepted |
| CWM04        | 两个 remote authority 同时存在                       | 在 remote A 输入 `#`  | 只出现 A authority 会话，B 不进入失效候选                 | accepted |
| CWM05        | remote tab 尚未恢复 service                          | 打开 `#`              | 不订阅本地 host；连接恢复后重新聚合                       | accepted |
| CWM06        | panel 未启用                                         | 普通 composer render  | 不预订阅额外 sessions-index                               | accepted |
| CWM07        | local draft，窗口有 workspace A/B                    | 在 A 输入 `@`         | 只订阅 A，B 不进入 `@` 对话分组                           | accepted |
| CWM08        | 同 authority 的 workspace A/B 各有超过 20 条会话     | 在 A 输入空 query `#` | A/B 各自只保留最近 20 条，不能由 A 挤掉 B                 | accepted |
| CWM09        | workspace B 的命中会话不在最近 20 条内               | 在 A 输入 `#` 并搜索  | 先匹配 B 的全部历史，再在 B 的匹配结果中最多展示 20 条    | accepted |

剪枝：主题、locale、task phase、model/provider、连续流与 replayable 恢复不与候选 scope 做笛卡尔积；
它们不改变 workspace authority。Desktop local + remote endpoint focused tests 作为代表，现有共享组件
继续承担响应式、主题和键盘交互覆盖。

## 验收

- 本地 workspace A 打开 `#` 时，可以搜索并选择本地 workspace B 的会话；打开 `@` 时仍只显示 A。
- 当前 workspace 会话仍排在其他 workspace 前，候选行展示来源 workspace 名称。
- `#` 空 query 时每个 workspace 最多展示最近 20 条；搜索时仍能找到不在最近 20 条内的历史会话，
  且每个 workspace 的匹配结果仍不超过 20 条。不得把限制误写成全局 20 条。
- 同一路径不同 `workspaceIdentity` 不串 scope；Windows 与 Unix 路径都能展示末级 workspace 名称。
- remote 候选只通过对应 remote service 订阅；未连接或其他 endpoint 不回退到 base host。
- 选择后仍插入原 session mention Markdown；不修改 protocol、Agent runtime、queue、stream 或 snapshot。
- 面板未启用时不新增 sessions-index 订阅。

## 测试交接

- focused hook test：仅 `#` 的本地 A/B 聚合、`@` current-only、remote 同 authority 聚合、跨 authority
  剪枝、disabled 不订阅。
- pure function test：当前 workspace 优先、其他 workspace 最近更新、workspace label/keywords。
- pure/provider test：空 query 按 `workspaceKey` 各取最近 20 条；query 先匹配全量历史再各取 20 条；
  `@` 不应用跨 workspace 上限。
- 本轮不新增 provider replay E2E：候选 scope 是 renderer 低频 index 组合，canonical 与正式 E2E 已覆盖；
  case catalog / coverage matrix 登记 focused 覆盖，不冒充跨 Host context transfer。
