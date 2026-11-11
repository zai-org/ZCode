# Session Persistence

## Provider 格式升级与回滚可读性（Todo109）

以 `staging_backup@790884b1ce` 为旧格式对照。Agent 打开库时通过
`0020_provider_model_selection` 一次转换；事务及回滚边界见
[SQLite migrations](./local-setting-migrations.md)。旧 JSON 成员保留为回滚快照，
不再由当前 Reader 解析为运行选择。配置新成员缺失不妨碍会话正文和任务内容读取，
也不触发默认模型执行；配置恢复留给用户重选。历史来源保留当时 Provider 身份，
只有当前 Session 选择使用既定迁移表。保存已有消息、Part 与 fork/复制都必须保留
旧快照，但不把它恢复成当前配置。

回滚或回滚后再升级，允许模型选择失效、需要重选；不能因为选择字段缺失或
格式不合法而打不开会话/任务、丢失正文，或在浏览/读取时产生异常报告。
存储 Reader 对 User、Timeline、Subtask 的新选择做结构校验，非法值按缺失投影，
不报错、不删除整条内容、不回读旧字段，也不校验当前 Provider 可用性。
Timeline 的展示 label 单独保留，不混入严格的 Selection 契约。
已提交 migration 不修改、不重跑；这项读取保护同样覆盖回滚期间产生的缺字段记录。
显式旧会话导入脚本也属于写入入口：User 必须补旧 Reader 所需的最小 `model` 对象；
它不是第二份当前选择，当前 Reader 仍忽略它。Assistant 等无需兼容写入的字段不扩大双写。

## 旧版本读取新数据（降级规则）

用户可能回退版本，或在同一个 `~/.zcode` 上运行旧版 App。旧版本读新版本写的会话时，不能打不开会话、
丢失正文或报错；显示内容、上下文顺序可以退化，退化要写进对应 spec。按旧版本怎样解析来分三类：

| 旧版本的解析方式                     | 规则                                   | 例子                                                                                                                   |
| ------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 解析失败就拒收整个会话或整条协议消息 | 不加字段，不加枚举值                   | user 消息顶层 `info.source`（App 在 strict 的 user info schema 里按封闭列表校验）；`compactBoundary` payload           |
| 忽略未知成员                         | 新数据放这里                           | `info.metadata`、`part.metadata`（例：隐藏提醒的类型写在 `metadata.runtimeMessage.source`）；`CompactionPart.metadata` |
| `safeParse`，失败时按原样显示        | 可以加字段；在 spec 里写明旧版本的退化 | `BashOutputSchema` 是 strict：新增 `timedOutAfterMs` 后，旧版本解析失败，工具卡退回 JSON 文本显示                      |

新 Reader 也要接受缺失或非法的新数据、悬空 id，不抛错（旧版本 fork 会原样复制 metadata）。

## 结论

这一版保持精简，不做额外的 operation journal、checkpoint 表、tool call 表、event store 表。

核心持久化只有三层：

- `session`: 会话元信息和少量会话级状态。
- `message`: 一条用户或 assistant 消息，主体信息放 `data` JSON。
- `part`: message 的内容块，文本、reasoning、file、tool、patch、compact 都是 part。

辅助表：

- `todo`: session 内 todo 列表。
- `session_entry`: v2 UI / event projection，用于更轻的 timeline 展示，不作为第一版恢复上下文的唯一来源。
- `permission`: project 级权限规则。
- `input_history`: project 级用户输入历史，用于交互客户端召回最近发送过的输入。

运行中状态不落库。`SessionRunState` 是进程内 map，负责 busy、cancel、shell runner；重启后通过已经写入的 `message` / `part` 判断上一次是否半截结束。

## 存储方式

第一版使用 SQLite。TypeScript 层用运行时 schema 校验 `data` JSON，数据库只展开必要索引字段。

默认物理路径由 `storage.sessionDbPath` 控制，默认值为 `~/.zcode/cli/db/db.sqlite`。用户配置和 `ZCODE_SESSION_DB_PATH` 可以覆盖该路径；为兼容早期开发入口，`ZCODE_SESSION_DB` 也作为同义环境变量解析。bootstrap 负责解析 `~` 和相对路径，业务层不得依赖 SQLite 文件名或目录结构。

不要把所有字段都拆成列。关键点是：

- 可索引、可列表、可关联的字段做列。
- 业务 shape 放 JSON。
- message 和 part 分开，避免每次更新一个 tool/text part 时重写整条消息。

## 通用字段

所有带 `Timestamps` 的表都有：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `time_created` | integer | 创建时间，毫秒时间戳。 |
| `time_updated` | integer | 更新时间，毫秒时间戳。 |

## 表：`session`

一行表示一个 session。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | text primary key | Session ID。 |
| `project_id` | text not null | 所属 project；删除 project 时级联删除 session。 |
| `workspace_id` | text nullable | 所属 workspace；没有 workspace 时为空。 |
| `parent_id` | text nullable | fork / 子 session 的父 session。 |
| `slug` | text not null | URL、文件名或 UI 中使用的短标识。 |
| `directory` | text not null | session 创建时的工作目录。 |
| `path` | text nullable | project 相对路径或 UI 展示路径。 |
| `title` | text not null | session 标题。 |
| `title_source` | text not null default `first_input` | 标题来源：`default`、`first_input`、`generated`、`custom`。AI generated 标题只能 CAS 覆盖非 custom 来源。 |
| `title_message_id` | text null | 生成或设置标题所依据的 user message。 |
| `time_title_updated` | integer null | 标题最近更新时间。 |
| `version` | text not null | 创建 session 时的 ZCode CLI 版本；来源与根 `package.json` 注入的 `__CLI_VERSION__` 保持一致。 |
| `share_url` | text nullable | 分享后的 URL。 |
| `summary_additions` | integer nullable | 当前 revert / diff summary 的新增行数。 |
| `summary_deletions` | integer nullable | 当前 revert / diff summary 的删除行数。 |
| `summary_files` | integer nullable | 当前 revert / diff summary 的文件数。 |
| `summary_diffs` | json nullable | 文件 diff 摘要，shape 对齐 snapshot file diff。 |
| `revert` | json nullable | 当前 rewind / revert 状态。 |
| `permission` | json nullable | session 级权限规则覆盖。 |
| `time_created` | integer | 创建时间。 |
| `time_updated` | integer | 更新时间。 |
| `time_compacting` | integer nullable | 正在 compact 的时间；用于避免重复 compact。 |
| `time_archived` | integer nullable | 归档时间；为空表示未归档。 |

`message` 或 `part` 写入会刷新所属 session 的 `time_updated`。`--continue` 和 TUI `/resume` 默认选择同目录下最近活动的 root session，而不是只按创建时间排序。

索引：

- `session_project_idx(project_id)`
- `session_workspace_idx(workspace_id)`
- `session_parent_idx(parent_id)`

`revert` 的 JSON shape：

```ts
type SessionRevert = {
  messageID: MessageID;
  partID?: PartID;
  snapshot?: string;
  diff?: string;
};
```

字段含义：

- `messageID`: rewind 后保留到哪条 message。
- `partID`: 如果只回退 assistant 中间某个 part，从这个 part 开始删除。
- `snapshot`: rewind 前的文件系统快照 ID，用于 unrevert。
- `diff`: 从 snapshot 到当前工作区的 diff 文本。

## 表：`message`

一行表示一条 user 或 assistant message。message 不直接存文本内容，文本和工具调用都在 `part` 表。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | text primary key | Message ID。 |
| `session_id` | text not null | 所属 session。 |
| `time_created` | integer | 创建时间。 |
| `time_updated` | integer | 更新时间。 |
| `data` | json not null | `MessageInfo` 去掉 `id` 和 `sessionID` 后的业务字段。 |

索引：

- `message_session_time_created_id_idx(session_id, time_created, id)`

这个索引用于稳定恢复：

```sql
select * from message
where session_id = ?
order by time_created, id;
```

### `MessageInfo.User`

`id` 和 `sessionID` 在列上，不重复放进 `data`。

| 字段 | 用途 |
| --- | --- |
| `role: "user"` | 消息角色。 |
| `time.created` | 用户消息创建时间。 |
| `format?` | 输出格式要求，例如 text 或 json schema。 |
| `summary?` | 这条 user message 是否是 summary prompt；可带 title、body、diffs。 |
| `agent` | 使用的 agent 名称。 |
| `model.providerID` | provider ID。 |
| `model.modelID` | model ID。 |
| `model.variant?` | model 变体。 |
| `system?` | 当次请求额外 system 文本。隐藏提醒不写，理由同 `tools?`。 |
| `tools?` | 当次可用工具开关，`toolName -> enabled`。只写在用户输入记录上（真实输入、guide、排队输入、workflow 启动）；隐藏提醒、合成通知和 compact 摘要不写，避免每条记录重复保存整份工具名单。 |

### `MessageInfo.Assistant`

`id` 和 `sessionID` 在列上，不重复放进 `data`。

| 字段 | 用途 |
| --- | --- |
| `role: "assistant"` | 消息角色。 |
| `time.created` | assistant message 创建时间。 |
| `time.completed?` | assistant 完成时间；生成中或中断时可以为空。 |
| `error?` | assistant 失败原因，例如 abort、context overflow、provider error。 |
| `parentID` | 这次 assistant 回复对应的 user message。 |
| `modelID` | 实际使用的 model ID。 |
| `providerID` | 实际使用的 provider ID。 |
| `mode` | 兼容字段，已 deprecated。 |
| `agent` | 实际使用的 agent。 |
| `path.cwd` | 运行时 cwd。 |
| `path.root` | project root。 |
| `summary?` | 是否是 compact 生成的 summary assistant。 |
| `cost` | 本次调用成本。 |
| `tokens.total?` | 总 token，可选。 |
| `tokens.input` | 输入 token。 |
| `tokens.output` | 输出 token。 |
| `tokens.reasoning` | reasoning token。 |
| `tokens.cache.read` | cache read token。 |
| `tokens.cache.write` | cache write token。 |
| `structured?` | 结构化输出结果。 |
| `variant?` | model 变体。 |
| `finish?` | provider finish reason。 |

## 表：`part`

一行表示 message 的一个内容块。文本流、reasoning、tool 状态更新、文件、patch、compact 都写成 part。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | text primary key | Part ID。 |
| `message_id` | text not null | 所属 message。 |
| `session_id` | text not null | 所属 session，冗余存一份方便按 session 查 part。 |
| `time_created` | integer | 创建时间。 |
| `time_updated` | integer | 更新时间。 |
| `data` | json not null | `Part` 去掉 `id`、`sessionID`、`messageID` 后的业务字段。 |

索引：

- `part_message_id_id_idx(message_id, id)`
- `part_session_idx(session_id)`

恢复一条 message：

```sql
select * from part
where message_id = ?
order by sequence is null, sequence, time_created, id;
```

`sequence` 是第一次写入的顺序，不是模型输出顺序。assistant 消息的 reasoning / text / tool part 都带
`blockIndex` 时，repository 解码后再按 `blockIndex` 稳定排序这些 part，其他 part 位置不变；否则保持
`sequence` 顺序。见 [Assistant 内容块顺序](./model/assistant-block-order.md)。

### Part 类型

| `type` | 关键字段 | 用途 |
| --- | --- | --- |
| `text` | `text`, `synthetic?`, `ignored?`, `time?`, `metadata?`, `blockIndex?` | 用户文本或 assistant 文本。assistant 每个文字块一个 part。 |
| `reasoning` | `text`, `metadata?`, `time`, `blockIndex?` | reasoning 流。 |
| `file` | `mime`, `filename?`, `url`, `source?` | 用户上传文件、图片、工具附件引用。 |
| `agent` | `name`, `source?` | 用户 prompt 中选择的 agent。 |
| `tool` | `callID`, `tool`, `state`, `metadata?`, `blockIndex?`, `declarationIndex?` | 工具调用及状态。`declarationIndex` 只在旧数据里出现。 |
| `step-start` | `snapshot?` | assistant step 开始，可记录快照。 |
| `step-finish` | `reason`, `snapshot?`, `cost`, `tokens` | assistant step 结束。 |
| `snapshot` | `snapshot` | 文件系统快照 ID。 |
| `patch` | `hash`, `files` | 工作区 patch 信息，用于 revert。 |
| `compaction` | `auto`, `overflow?`, `tail_start_id?` | compact 标记。 |
| `retry` | `attempt`, `error`, `time.created` | provider retry 记录。 |
| `subtask` | `prompt`, `description`, `agent`, `model?`, `command?` | subagent / 子任务描述。 |

### Tool state

`tool` part 的 `state` 是 discriminated union。

| `state.status` | 字段 | 用途 |
| --- | --- | --- |
| `pending` | `input`, `raw` | 模型刚吐出工具调用，还没解析或执行。 |
| `running` | `input`, `title?`, `metadata?`, `time.start` | 工具已开始执行。 |
| `completed` | `input`, `output`, `title`, `metadata`, `time.start`, `time.end`, `time.compacted?`, `attachments?` | 工具执行成功。 |
| `error` | `input`, `error`, `metadata?`, `time.start`, `time.end` | 工具执行失败或被取消。 |

注意：shell/tool 输出不是运行时持续追加一行一行落库，而是在 part 状态变化时更新。对 bash 超长输出，第一版存为 `completed.output` 字符串；compact 时可以截断进入上下文，并用 `time.compacted` 标记已经被压缩过。

#### Completed tool metadata

`completed.output` 是模型可见结果，可能只是短确认文本；UI/ZCode app-server/debug 不能从它反向解析
结构化信息。成功 tool part 的 `state.metadata` 使用版本化 JSON：

```ts
type CompletedToolPartMetadata = {
  schemaVersion: 1;
  display?: ToolResultDisplayPayload;
  modelContentLayout?: Array<
    | { type: "text"; text: string }
    | { type: "attachment"; attachmentIndex: number }
  >;
  serialization?: {
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
    budgetStrategy: "inline" | "truncate" | "artifact";
    artifactPath?: string;
  };
};
```

第一版 `display` 只定义 `file_diff`，对齐 live `tool_call_result.payload.result.display`：

```ts
type ToolResultDisplayPayload = {
  kind: "file_diff";
  filePath: string;
  additions: number;
  deletions: number;
  structuredPatch: DiffHunk[];
  truncated?: boolean;
};
```

`display` 是 bounded UI 投影，不是完整 tool output。`Edit` / `Write` 的完整文件内容、
原始输出或超长结果继续由 tool output schema、result budget 和 artifact/storage 管理；
SQLite 里只保存可恢复的展示投影和 artifact 引用。

兼容策略：

- 不需要 SQL migration：`part.data` 本来是 JSON，新增字段只改变业务 contract。
- 旧 session 的 completed tool part 如果没有 `metadata.schemaVersion` 或 `metadata.display`，
  resume / app-server load / TUI initial transcript 必须继续展示 legacy `output`，不得报错。
- provider history 冷恢复只有在 `metadata.modelContentLayout` 完整有效时才使用 `attachments`
  重建结构化 tool result；旧 part 缺少 layout、layout 非法或引用越界时必须继续回放 legacy
  `output`。`attachments` 单独存在不代表它属于新的 provider-visible media layout。
- 旧 Edit/Write 数据不能可靠还原当时完整 diff，尤其涉及 `replace_all`、权限面板用户修改、
  stale file 或上下文行时；第一版不从 `old_string/new_string` 伪造历史 diff。

## 表：`todo`

session 内 todo 列表。

第一版通过 `SessionStorePort.readTodos()` / `SessionStorePort.updateTodos()` 暴露给 `TodoRead` 和 `TodoWrite`。tool handler 只依赖 port，不直接访问 SQLite；SQLite adapter 用事务先删除当前 session 的旧 todo，再按 `position` 写入完整新列表，保证“完整计划替换”语义和稳定读取顺序。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `session_id` | text not null | 所属 session。 |
| `content` | text not null | todo 内容。 |
| `status` | text not null | 状态。 |
| `priority` | text not null | 优先级。 |
| `position` | integer not null | 排序位置。 |
| `time_created` | integer | 创建时间。 |
| `time_updated` | integer | 更新时间。 |

主键：

- `(session_id, position)`

索引：

- `todo_session_idx(session_id)`

## 表：`session_entry`

这个表用于把 session event 投影成更轻的 timeline entry。

第一版可以建表但不要把恢复上下文绑死在它上面。恢复上下文仍以 `message + part` 为准。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | text primary key | Entry ID。 |
| `session_id` | text not null | 所属 session。 |
| `type` | text not null | `user`、`synthetic`、`assistant`、`compaction`。 |
| `time_created` | integer | 创建时间。 |
| `time_updated` | integer | 更新时间。 |
| `data` | json not null | `SessionEntry.Entry` 去掉 `id` 和 `type` 后的字段。 |

索引：

- `session_entry_session_idx(session_id)`
- `session_entry_session_type_idx(session_id, type)`
- `session_entry_time_created_idx(time_created)`

Entry shape：

| `type` | 用途 |
| --- | --- |
| `user` | 用户输入，包含 text、files、agents。 |
| `synthetic` | 系统合成输入。 |
| `assistant` | assistant timeline，包含 text、reasoning、tool、retry、cost、tokens、error。 |
| `compaction` | compact 事件展示。 |

## 表：`input_history`

一行表示一次 server 已接受的用户输入。它不是 provider-visible message 历史，不参与模型上下文恢复；TUI、ZCode app-server 或未来 GUI 只能通过 server 能力召回它，不能直接读取数据库。

总表最多保留最近 100 条，按 `time_created desc, id desc` 计算，不按 project 单独保留 100 条。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | text primary key | Input history entry ID。 |
| `project_id` | text not null | 所属 project，召回默认按它过滤。 |
| `session_id` | text nullable | 产生该输入的 session，仅用于调试/审计。 |
| `text` | text not null | 用户原始输入，trim 后为空的不写入。 |
| `kind` | text not null | `prompt`、`steered_input` 或 `slash_command`。 |
| `time_created` | integer | 创建时间。 |

索引：

- `input_history_project_time_idx(project_id, time_created desc, id desc)`
- `input_history_time_idx(time_created desc, id desc)`

写入语义：

- 连续重复输入按 project 去重；如果该 project 最新一条 `text` 相同，不新增记录。
- 写入后在同一事务内删除全局第 101 条之后的旧记录。
- 写入失败不能阻断 prompt 提交；调用方记录结构化日志并继续。

## 表：`permission`

project 级权限规则。第一版只做 project scope，不做 session/global 持久化。审批 UI 的 `Allow once` 不写入本表；`Always allow in this project` 写入本表。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `project_id` | text primary key | Project ID。 |
| `time_created` | integer | 创建时间。 |
| `time_updated` | integer | 更新时间。 |
| `data` | json not null | Permission ruleset，形如 `{ "version": 1, "allow": [{ "toolName": "Bash", "ruleContent": "npm run:*" }], "deny": [], "ask": [] }`。 |

## 写入策略

行为边界：

1. 创建 session 时写 `session`。
2. 用户提交 prompt 时写一条 `message(role=user)` 和若干 `part(text/file/agent)`。
3. assistant 开始时写一条 `message(role=assistant)`，再写 `step-start` part。
4. assistant 回复的每个 reasoning 块、每个文字块各写一个 `part`，带 `blockIndex`（模型输出顺序）；
   不要每 token 新建一行。普通回复在流结束后写入；服务端工具轮次在流中写入。见
   [Assistant 内容块顺序](./model/assistant-block-order.md)。
5. tool call 只更新同一个 `tool` part 的 state：`pending -> running -> completed/error`，每次写入都带同一个 `blockIndex`。
6. assistant 完成时更新 assistant message 的 `time.completed`、cost、tokens、finish，并写 `step-finish` part。
7. compact、retry、patch、snapshot 都是 part，不新增专门表。

性能约束：

- 流式文本更新要 debounce，例如 250-500ms 或达到固定字符阈值再写。
- tool 输出运行中不持续写完整 stdout；完成时一次写 `completed.output`。
- message 与 part 的同一阶段写入放进事务。
- 事务体（`begin immediate` 到 `commit` / `rollback`）只调用同步写入，不得 `await`：一个进程的所有 session 共用一个连接，`await` 让出执行权后，其他写入会混入本事务（随回滚静默丢失）或撞上嵌套事务报错。仓库层为此提供 `*Sync` 版本，原有 async 函数不变。
- 停止、崩溃、进程退出前强制 flush 当前 message / part。

## 恢复策略

恢复 session 时：

1. 读 `session`。
2. 按 `(time_created, id)` 读取 `message`。
3. 按 `(message_id, sequence)` 读取每条 message 的 `part`；有序 assistant 消息再按 `blockIndex` 排序。
4. 拼回 `MessageWithParts`。
5. context builder 再决定哪些 part 进模型上下文，例如忽略 `ignored`、处理 compact summary、裁剪工具输出。

不要从 `session_entry` 恢复模型上下文。它可以用于 UI timeline 或轻量 API。

对交互客户端还要额外约束：

- TUI、ZCode app-server 或未来 GUI 在 `resume` 后，界面上的历史 `user / agent` transcript 也必须从同一份 `message + part` 重建，而不是只显示一条“session resumed”提示。
- UI transcript 的恢复来源仍然是 `message + part`，`session_entry` 只能作为轻量 timeline / 索引缓存，不能成为唯一真相源。

### Resume v1 契约

第一版 resume 承诺恢复模型可见上下文、继续写入同一个 session，并为交互客户端提供重建历史 transcript 所需的数据；它仍然不恢复进程内 runner、shell、pending permission 或未完成的外部 I/O。

入口形态：

- `zcode --resume <sessionId>`：恢复指定 session。`sessionId` 是 `session.id`，通常形如 `sess_...`，来自 CLI `--json` 输出或 session list 响应；不要把 `traceId`、`turnId`、`messageId`、`partId` 或 `toolCallId` 传给 `--resume`。
- `zcode --continue` / `zcode -c`：恢复当前目录最近一个未归档 root session。
- `--resume` 和 `--continue` 互斥。
- 如果指定 session 不存在、已归档或 message/part 数据损坏，CLI 返回结构化 session 错误，不静默创建新 session。

恢复流程：

1. 读取 `session` 元信息，并把 runtime 的 `workingDirectory` 切到 `session.directory`。
2. 初始化当前版本的 system/context sections。AGENTS.md、工具声明、环境信息等动态上下文不从旧 transcript 复制，而是在 resume 时重新解析。
3. 读取 `message + part`，按 compact 规则得到 active chain。
4. 将 active chain 转成 provider-visible `MessageHistory`。
5. 标记 `sessionPersisted = true`，后续 turn 继续写入原 session。
6. 追加 `session_resumed` 事件和结构化日志，记录恢复的 message 数、part 数、interrupted tool 数和恢复目录。

Provider-visible 恢复规则：

- `user` message 只拼接未 `ignored` 的 `text` part；第一版对 `file` part 只保留可读占位，后续再接入多模态恢复。
- `assistant` message：有序消息按 `blockIndex` 恢复不合并的 reasoning / text 块和 tool call；旧消息拼接
  `text` part，`tool` part 转回 assistant tool call。浏览器轮尾截图 tool part 不进入模型上下文。
- `completed` tool part 转为成功 tool result；有 `state.attachments` 时从 artifact 按顺序重建
  provider-neutral 媒体 block，没有附件时继续使用 `state.output`。
- `error` tool part 转为失败 tool result。
- `pending` / `running` tool part 一律转为失败 tool result，内容为 `[Tool execution was interrupted before resume]`。这样可以避免 provider 收到 dangling tool call。
- 没有有效文本、reasoning 或 tool part 的未完成 assistant message 不进入模型上下文。

Compact 恢复：

- 如果存在 `compaction` part，active chain 从最后一个 `compaction` message 开始。
- 如果 `compaction.tail_start_id` 存在，后续实现可以恢复 summary + tail；第一版先按最后一个 compaction boundary 截断，保证 compact 后重启不会把旧历史重新塞回上下文。
- 如果 compaction 元数据损坏，保守加载可解析消息并写结构化告警，后续 turn 可再次 compact。

`--continue` 会按当前目录过滤：

- 第一版使用 `session.directory = cwd` 的未归档 root session。
- 后续支持 worktree / project-relative `path` 时，可扩展为按 `path` 前缀匹配。

## Edge Cases

### 用户停止模型生成

running state 不存进数据库，进程内 `SessionRunState` 负责 cancel。

持久化结果：

- 已生成的 text/reasoning part 保留最后一次 flush 的内容。
- assistant message 可以没有 `time.completed`。
- 如果中断被显式处理，assistant message 写 `error`，例如 aborted。
- 正在跑的 tool part 在可取消时更新为 `error`；不可取消或进程崩溃时，恢复时看到 `running` 且没有进程 runner，就展示为 interrupted/stale。

不需要 `run` 表。

### 上下文太长需要 compact

compact 也是 message/part，不是单独表。

流程：

1. 设置 `session.time_compacting`，避免重复 compact。
2. 插入一条 user message，包含 `compaction` part。
3. 生成一条 assistant summary message，`summary: true`。
4. `compaction.tail_start_id` 指向 compact 后仍保留的 tail message。
5. 老 tool 输出如果不再需要进入上下文，在 tool state 的 `time.compacted` 上打标。
6. 清空 `session.time_compacting`。

恢复上下文时，context builder 使用 summary message 加 tail messages，而不是重新读全量历史。

### 多媒体资源

多媒体不塞进 message 文本。

- 用户上传或工具产生的文件用 `file` part。
- `file.url` 指向 storage/artifact 中的资源。
- `mime` 决定模型是否按图片、文本、音频等处理。
- `source` 记录来源，例如 workspace file、symbol、MCP resource。
- tool 结果带附件时放在 `ToolStateCompleted.attachments`，类型也是 `FilePart[]`。

数据库存引用和元数据，二进制内容走 storage/artifact。

`FilePart + artifact` 是跨 provider 的事实源。base64 只属于当前 provider 请求投影，不得作为
message/tool part 的唯一持久化内容。会话内切换模型或 provider，以及退出后的冷恢复，都必须从
artifact 重新生成当前 provider 所需的 wire 形态；因此
媒体 artifact 写入失败不能静默落成不可恢复的 completed tool part。

### Bash 超长输出

tool 完成时 `completed.output` 是字符串。

第一版不要新增 `tool_output` 表。处理规则：

- 运行中只保留内存 buffer 和 UI preview，不频繁落库。
- 完成时一次写入 `tool` part。
- 进入模型上下文时可以按工具输出预算截断。
- compact 后给 `time.compacted` 打标，表示旧输出已经被 summary 吸收。

如果后续 SQLite 体积成为真实瓶颈，再把 `output` 扩展成 artifact 引用；这不是第一版。

### 用户 rewind / revert

采用 session 级 `revert` 字段，不给每个 checkpoint 建表。

revert 流程：

1. `assertNotBusy(sessionID)`，busy 时不允许 rewind。
2. 找到目标 `messageID` / `partID`。
3. 记录当前 snapshot，写入 `session.revert.snapshot`。
4. 收集目标之后的 `patch` part，回滚文件系统。
5. 计算 diff summary，写入 `summary_additions`、`summary_deletions`、`summary_files`、`summary_diffs`。
6. 如果用户确认 cleanup，删除目标之后的 message；如果有 `partID`，删除同一 message 内从该 part 开始的 parts。
7. 清空 `session.revert`。

unrevert 时：

1. 如果有 `session.revert.snapshot`，恢复 snapshot。
2. 清空 `session.revert` 和 summary。

### Fork session

fork 不需要复制复杂状态。

- 新 session 的 `parent_id` 指向原 session。
- `directory`、`path`、`permission` 可从父 session 初始化。
- message/part 是否复制取决于产品行为：如果 fork 后要独立编辑历史，就复制到新 session；如果只是引用父历史，就由 context builder 读取父链。

第一版建议复制 message/part，简单、可离线、好理解。

#### 会话 cwd 与 workspace 分离（受管 worktree）

产品规格：`docs/git/worktree.md` §1.1、§6.6、§9.3。受管 worktree 只是会话的 cwd：workspace key、CLI 进程和 sessions-index 都属于项目。

| 项 | 规则 |
| --- | --- |
| 新建 | V4 `createSession` 可带 `cwd`。会话的 workspace ref = `{ workspaceKey: 由 workspaceId 得到（项目）, workspacePath: cwd }`；远程 workspace 带 `cwd` 返回 `guard.worktreeCwdLocalOnly` |
| 持久化 | `session.directory` / `path` = cwd；`workspace_id` 仍只存远程 identity（本地为空）。session 表不加列 |
| 归属 | live record 的 `workspace.workspaceKey` 是项目 key，进入项目的 sessions-index。冷列表时目录扫描看不到这些会话，Host 订阅时用 `worktreeSessionIds` 精确提供 id，CLI 只读、并确认会话属于该 workspace 后才返回；`sessionsIndex/reconcile` 用同一判定。属于的判定（`isLocalSessionDirectoryInWorkspace`，文件系统部分在 `classifyLocalSessionDirectory`）：cwd 与 workspace 是同一个真实目录（realpath）；或 cwd 经受管 worktree resolver 映射回该真实目录；或 cwd 是已删除的受管 worktree，此时才以创建时持久化的 `projectID`（§6.6.3）为准，删除、重命名等 CLI 事实照常回写。projectID 是有损 slug，不作一般归属证明。冷恢复 / 激活校验与冷列表共用这一函数（激活时请求的执行路径也要通过） |
| 冷恢复 | Host 携带本地 workspace 时：路径与存储目录是同一目录则沿用请求路径；不同则执行路径取存储目录（cwd 创建后不变），key 仍取请求。subscribe 之外会冷恢复的 V4 查询与命令信封也带 Host 注入的 `workspace`（产品规格 §9.3），gateway 原样传给冷恢复 |
| 反向请求 | 官方 MCP 授权头等发往 Host 的请求用会话的 `workspaceKey`，不按 MCP 的工作目录重新计算；MCP 连接池（含 workspace 级共享连接）仍按 cwd 分组，因为 stdio 进程的工作目录就是 cwd |
| 项目身份 | 权限 `project_id` 与项目记忆目录按 cwd 映射回源仓库的路径派生（`AgentRuntimeConfig.projectDirectory`），与 Hook Trust 同一 resolver；映射失败按 cwd |
| 对外 key | Hook Trust admission、审核 request 等对外字段用会话所属 workspace 的 key（`ZCodeAppOptions.workspaceKey`） |
| 能力 | `runtime/capabilities` 返回 `worktreeCwd: true`；旧 CLI 静默丢弃这些字段，Host 必须先确认 |

"已创建 worktree"：`createSession.worktreeCreation = { path, sha, ref, output }` 先记在 runtime，首轮 `ensureSessionPersisted` 之后、`TurnStarted` 之前写成 timeline part（`timelineType: "worktree_creation"`、`display: "worklog"`，`providerVisibility: hidden`，不进模型上下文），并发出 `WorktreeCreated` 事件。投影在首个 `TurnStarted` 时于轮顶（`lightBoundary`）落 `timelineMarker { type: "worktreeCreated" }`；冷恢复从 timeline part 合成同一事件。

#### fork 到受管 worktree（`forkAssistant.targetCwd`）

V4 `forkAssistant` 可带 `targetCwd: { cwd, childSessionId, worktreeCreation }`。不带时行为不变。带上时：

| 项 | 规则 |
| --- | --- |
| child ID | 使用 Host 预分配的 `childSessionId` |
| `directory` / `path` | `cwd` |
| `workspaceID` | 沿用父会话（本地为空），child 仍属于父会话的 workspace |
| `projectID` | 按 cwd 映射回源仓库的路径派生（同上） |
| `permission` | 去掉会话级 `allow` 规则（与父 cwd 绑定）；`deny`、`ask`、`mode`、`scope`、`version` 原样保留 |
| 对话 | 只复制稳定边界前的对话，不回退、不恢复任何 checkpoint；fork 分隔标记所在的宿主消息里追加 `worktree_creation` part |
| 运行归属 | 同一 workspace 与进程：child 照常在当前 CLI 进程注册，record 的执行路径取 child 持久化的 cwd |
| 远程 | 父会话在远程 workspace 时返回 `guard.worktreeCwdLocalOnly`，不写入任何数据 |
| 幂等 | 沿用 `(父 session, sourceCommandId)` 的 command fact |

### 彻底删除（项目数据删除）

普通删除只写 `time_deleted`。用户在设置 → 项目里勾选「同时删除 ZCode 数据」时，Host 经 `v4/storage/sessionData/purge` 交来会话 ID 与目录（产品规格：`docs/superpowers/specs/2026-10-24-project-management.md`「彻底删除数据」）：

- 后代只沿附属会话展开：`parent_id` 且 `task_type ∈ {selection_side_chat, workflow_child, subagent_child, nested_workflow_child}`，加 `session_task_link` 子会话。fork 的 `parent_id` 也指向源会话，但它是独立任务，不展开。
- 本进程已加载且忙（在途 turn、待交互、排队命令、residency blocking work）的会话整棵保留；空闲的按 `deleteSession` 执行面同序释放，但只释放运行态、不发布 `session.removed`：文件或行删除失败时会话仍是存活事实，Host 不能先把它当作已删除。
- 附件仍被本次不删除的未删除会话引用时整棵保留（`kept.reason = "referenced"`）。fork、回退、工作流转录按值复制 part，`zcode-artifact://<源会话>/<id>` 仍指向源会话的 `artifacts/<sid>`；引用按 part 内容中的 URI 判定（不依赖 fork 谱系，任何复制路径都覆盖），已软删除会话的引用不计。保留一棵后，被它引用的树也变成「本次不删除」的引用方，迭代到不动点。
- 先删 `cli/{artifacts,exec,agents,sessions}/<sid>` 与 `cli/{debug,rollout}/model-io-<sid>.jsonl`，成功后一个事务删行：`input_history`、`dwf_run`、`workflow_run` 没有级联外键，显式删除；其余经外键级联。文件失败则不删行。
- 目录的记忆整个删除 `memories/projects/<slug>-<hash>`（与运行时同一解析函数）。
- 文件与行都删除成功后，才从所有 sessions-index 投影移除，防止下次快照把会话带回。
- 库 `auto_vacuum = none`，删除行不收缩文件；返回的字节数只统计删除的文件。

### 崩溃恢复

恢复时不尝试恢复进程内 runner。

- assistant message 没有 `time.completed`：标记为 interrupted。
- tool part 是 `running`：标记为 stale/interrupted，必要时允许用户重试。
- session 有 `time_compacting`：清掉并重新判断是否需要 compact。
- session 有 `revert`：展示可 cleanup / unrevert 的状态。

## ZCode 第一版接口

持久化模块只暴露这些能力：

```ts
interface SessionStore {
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  getSession(sessionID: SessionID): Promise<SessionInfo>;
  listSessions(input: ListSessionsInput): Promise<SessionInfo[]>;

  saveMessage(input: MessageInfo): Promise<void>;
  removeMessage(input: { sessionID: SessionID; messageID: MessageID }): Promise<void>;

  savePart(input: MessagePart): Promise<void>;
  removePart(input: { sessionID: SessionID; messageID: MessageID; partID: PartID }): Promise<void>;

  messages(input: { sessionID: SessionID }): Promise<MessageWithParts[]>;

  setRevert(input: {
    sessionID: SessionID;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionID): Promise<void>;
}
```

业务层只依赖这个接口，不直接碰 SQLite、fs 或具体 ORM。

## Runtime 接入契约

`core` 的 prompt loop 只通过 `SessionStore` port 表达持久化意图，不依赖 SQLite、文件路径、表结构或 adapter 内部实现。

- 每个 runtime 实例首次执行 turn 时调用一次 `createSession`。session 的 `directory`/`path` 来自 runtime config 的 `workingDirectory`，未配置时才退回当前进程目录。
- 本地 TUI 显式启用后，首次真实用户 turn 完成后 runtime 可以发起 session title sidecar 请求。headless `--prompt`、`--target` 和 ZCode app-server 默认不启用，避免脚本和协议场景多出后台模型调用。标题生成使用 `ModelRole.Lite`；未配置 `model.lite` 时解析到当前默认/main 模型。写回 `session.title` 时必须带 `expectedTitleSources`，避免迟到的 generated 标题覆盖用户 custom 标题。完整契约见 [`session-title-generation.md`](./session-title-generation.md)。
- 每个用户输入先保存一条 `user` message，再保存 text part；附件保存为 file part。message 和 part 使用同一个 `traceId`，便于和 event log、日志串起来。
- 每次模型请求创建一条 `assistant` message，先保存未完成状态，再按响应保存 text/tool/step part，最后用同一个 message id 写回 `time.completed`、`finish` 和 token 统计。
- 工具调用 part 以同一个 part id 依次写入 `pending`、`running`、`completed` 或 `error` 状态。这样 adapter 可以用 upsert 语义表达最终状态，也能从日志看到中间状态。
- tool completed part 必须持久化与 live result event 同源的 bounded display metadata。
  例如 `Edit` / `Write` 的 file diff 在 live TUI 中来自 `tool_call_result.result.display`，
  在 resume 中来自 `part.state.metadata.display`；二者不能分叉生成。
- `sessionStore` 未配置时，runtime 必须继续只靠 event store 工作；`sessionStore` 已配置时，持久化错误默认向上冒泡，让 CLI 入口统一格式化失败，不在 core 层吞掉半持久化问题。
- 每次 `createSession`、`saveMessage`、`savePart` 成功后写结构化 debug 日志，至少包含 `traceId`、`sessionId`、`turnId`、message/part id 和事件名。

## 实施顺序

1. 在 `docs` v2 先固定 `SessionInfo`、`MessageInfo`、`Part`、`SessionStore` schema。
2. 实现 SQLite adapter 和 migrations。
3. 接入 prompt loop：user message、assistant message、part update。
4. 接入 resume：从 `message + part` 还原上下文。
5. 接入 stop：flush 当前 part，清理内存 runner。
6. 接入 compact：`compaction` part + summary assistant。
7. 接入 revert：`session.revert` + snapshot + patch cleanup。

这就是持久化的主线：少量表，message/part JSON 承载业务结构，运行状态留在内存，compact/revert 都通过已有 message/part/session 字段表达。

### 加速卡归属元数据

`metadata.highspeed.ownerKey` 是可选的稳定匿名账号归属，随原对象保存和冷恢复，不加入凭据。CLI声明 `highspeedCardOwner` 后Host才下发此字段；旧端仍接收原schemaVersion=1的元数据。指标更新只合并字段，不丢失ownerKey；未知归属旧记录保持未知。

## 归档会话永久删除

归档管理使用独立的 V4 `storage/sessionData/deletionPreview` 与 `deletionExecute`，不改变旧软删除与项目数据清理语义。产品范围见 [归档规格](../../../../../docs/superpowers/specs/2026-09-11-archive-management.md)。

- CLI 是正文与文件的唯一写者；Host 只校验归档状态并清除自己的索引。预检 revision 固定 owned tree、引用与文件清单，执行前复查。
- `session_runtime_presence` 登记进程持有的 runtime；其他活进程持有时拒绝删除，不用超时认定进程已退出。本进程检查请求、初始化、运行任务、排队输入和交互。
- `session_purge` 只保存目标 ID、操作 ID、目录身份、保留附件 ID 和完成状态。SQLite 事务准入与写入触发器阻止新的 runtime、正文写入、派生会话及引用。它不保存消息或标题。
- `0025_session_permanent_deletion` 保留已发布 SQL 与 checksum。已记账的数据库继续校验后跳过；未记账但已有部分或全部同版结构时，`apply` 仅补缺失的表、索引和触发器，保留现有数据与删除凭据，再由原迁移事务记账。此守卫不改写已有同名对象，也不修复不兼容的表结构。
- 顺序为准入 → 释放空闲 runtime → 删除私有文件 → 删除 owned tree 数据行 → 标记完成 → 移除 Host 索引。任一步失败保留凭据，用户重试继续清理；无法把部分删除的会话恢复为普通会话。完成后同 ID 不能重建。
- 独立 fork 保留；仍被保留会话引用的附件文件留下，原对话正文继续删除。已发布分享、工作目录、导出、备份与系统日志不联动。不承诺磁盘取证级擦除。
