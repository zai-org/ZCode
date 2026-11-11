# Read File State Resume

## 背景

用户反馈 `ZCT-202606-B2299F52` 中，Win11 上编辑既有 HTML 文件时多次被
`File has not been read yet. Read it first before writing to it.` 阻断。日志显示同一
session 里模型多次 `Read limit` 后继续 `Write` 仍失败，直到完整 `Read` 后才成功。

根因是两层语义有缺陷：

- ZCode 的 `readFileState` 只存在于当前 `ToolExecutor` runtime 内，`resume` 只恢复
  provider-visible message history，没有从历史 tool transcript 重建 read-state。
- ZCode 把 `offset` / `limit` read 当作 `isPartialView`，并且 `Write` 只接受 strict
  full read；正确的 same-runtime guard 是拒绝没读过或 `isPartialView`，`offset`
  / `limit` 本身不是 `isPartialView`。

2026-10 修订：resume 不再跳过 range `Read`。冷恢复与 same-runtime 使用同一规则：每个文件只保留
最近一次读取或写入的记录。对 `Read`、`Write`、`Edit` 和工作流草稿留下的记录，重启前后同一段历史的
Read 去重与写前检查结果相同；Bash 回填和 Recall 注入的记录不落盘，resume 后没有。例外：

- 完整视图恢复时不保留 `offset`（`0` 和 `1` 都记为未指定），所以显式 `offset: 0` 的完整 Read 在重启后不命中去重。
- compaction 补回文件时写入的记录只在 live 表里，不落盘；重启或 rewind 之后没有（见下文“Compaction 之后”）。

## Resume 契约

普通 `resume` 不新增独立持久化表，也不把 read-state 写入 provider-visible history。
它从当前 active transcript 重建 runtime-local `readFileState`。Read state 至少包含
模型看到的 `content`、`offset`、`limit`、`isPartialView` 和用于 stale guard 的时间戳；
恢复来源只允许使用 completed tool part metadata 里持久化的结构化 read-state，其中时间戳
使用 `mtimeMs`，并同时保留文件系统 adapter 暴露的 `revisionId`：

- 只扫描 compact / rewind 后仍 active 的 message。
- 成功的 `Read` 都会恢复，包括显式带 `offset` / `limit` 的 range `Read`；每个文件只留最近一次。
  "最近"按 live 写入读取状态的顺序：不同 assistant 消息之间按历史顺序；同一条 assistant 消息里的
  工具（可能并行）按快照的 `snapshotIndex` 重放。part 在工具开始前就按声明顺序落盘，完成时原地更新、
  位置不变，所以 part 顺序不是写入顺序；工具结果返回的先后也不是（handler 写入之后还有序列化、
  PostToolUse hook、结果事件等异步步骤）。执行器在工具记录快照时取号，这一步与写 live 状态在同一个
  同步步骤里，所以序号就是 live 的写入顺序。返回 `file_unchanged` 的 Read 不写 live 状态，也不记录快照；
  冷恢复跳过这类结果（包括旧数据里已经存了快照的），由之前那次真实读取恢复同一个视图和时间。之前那次
  读取不在 active history 里时（例如已被 compact 摘要），这个文件不恢复。模型可见历史按 `blockIndex`
  （旧数据按 `declarationIndex`），不受影响（见
  [工具历史顺序修复](../../../../../../docs/design/v2/tool/tool-history-order-repair-proposal.md)、
  [Assistant 内容块顺序](../model/assistant-block-order.md)）。
  同一条消息里的快照都带 `snapshotIndex` 时按它排序，否则（旧数据）保持 part 原顺序。被 token cap
  截断的 `Read` 恢复为 `isPartialView: true`。
- 成功的 `Write` / `Edit` 用 completed tool part metadata 里持久化的完整快照恢复为当前文件
  状态。resume 时不读当前磁盘来补全：外部的手动保存不能被当成模型已读。
- 恢复过程只影响本 runtime 的文件 mutation guard，不产生新的模型消息、stream 事件或
  app protocol 字段。
- 冷恢复写入的记录带进程内标记 `restoredFromSession`（不进 tool part metadata），compaction
  选择补回文件时用它区分排序依据（见下文）。rewind 在同一进程里重建的记录不带这个标记，和 live
  记录一样按 `mtimeMs` 排序。

same-runtime 读取语义：

- `readFileState` 按文件路径一条（路径按现有规范化比较，Windows 盘符大小写不区分）。每次
  `Read`、`Write`、`Edit` 和工作流草稿都覆盖同一文件的记录；Bash 回填和 Recall 注入只在这个文件
  还没有记录时补一条。查找只取这一条。
- `isPartialView` 表示模型看到的内容不完整或被工具截断，例如 token cap 截断。
- 显式 `offset` / `limit` 是 range view，不自动等价于 `isPartialView`。
- `Write` / `Edit` 修改既有文件前必须找到同文件最新 read-state，并拒绝
  `isPartialView`。
- stale fallback 只有 strict full read 可以在 mtime 前进但内容相同的情况下放行；range
  read 遇到 mtime 前进必须要求重新读取。

## Compaction 之后

compaction 补回文件（`rewind-compact.md` 的“文件恢复”）重读磁盘上的当前内容，再按结果整理读取状态：

- 持久化成功后，原地清空 live 表，再从旧到新写入补回的记录，最新的文件排在最后（和其他写入方一致）。
  表是执行器共享的同一个 Map，不换新对象。
- 补回成功的文件：完整视图记录（`sourceTool: "Read"`，不带 `offset` / `limit`），之后同视图的 Read
  返回 `file_unchanged`，Edit / Write 可以直接改。
- 超过单文件 token 上限、只放引用提示的文件：`isPartialView: true` 的记录，之后 Read 返回正文，
  Edit / Write 要求先完整读取。
- 超过 Read 的文件大小上限、只放引用提示的文件：没读到内容，不写记录。
- 因总量上限被丢掉、读取失败或被跳过的文件：不写记录。
- 这些记录不落盘：补回附件没有快照，hydrator 只扫描工具结果。重启或 rewind 之后没有这些记录，Read
  返回正文，Edit / Write 要求先读。
- `MEMORY.md`：compaction 收尾时重读索引，live 表装好补回记录之后，再写入一条按重读内容生成的
  `seededFromContext` 记录（规则与会话开始时相同）。索引不存在或不可读时不写。

## ZCode 实现边界

`AgentRuntime` 持有一个 session 生命周期内共享的 `ReadFileStateMap`，构造
`ToolExecutor` 时传入同一个 map。`resumeFromStore` 在恢复 provider-visible history 的
同阶段清空并重建该 map，保证恢复边界和 message history hydration 一致。

会话开始时，`MEMORY.md` 索引由 context 加载，同时写入一条带 `seededFromContext` 的记录
（进程内字段，不进 tool part metadata）。rewind 重建时保留这条记录，只按 active history
重建其余记录；resume 全部清空，由 context 初始化重新写入。如果被回退的部分读过或写过
`MEMORY.md`，这条记录已被覆盖成工具记录，随回退一起清掉。

read-state hydrator 必须独立于 UI、desktop service 和远控 replayable stream。它只读取
`SessionStorePort.messages()` 返回的 tool parts 和当前 `FileSystemPort`，不新增
`@zcode/protocol` 字段，不改变 desktop continuous 或 web remote replayable 的消息流。

成功 full `Read` 的 completed tool part metadata 需要额外保存一个 versioned
`readFileState` snapshot：

- `tool: "Read"`，避免其他 tool metadata 被误用。
- `schemaVersion`，用于后续兼容演进。
- `path`、`content`、`offset`、`limit`、`isPartialView`、`mtimeMs`、`sizeBytes`、
  `revisionId`，对应 runtime `ReadFileStateEntry` 的可恢复字段；`mtimeMs`、
  `sizeBytes` 和 `revisionId` 必须完整存在，否则该 metadata 不参与恢复。
- `readAtMs`，使用 tool completed time 作为恢复后的水位时间；只作时间，不参与恢复排序。
- `snapshotIndex`（可选），执行器在工具记录快照时取的序号，一个 runtime 一个计数器、只增不减；
  只在同一 assistant 内比较先后，绝对值没有含义。旧版本按字段名读取 metadata，忽略这个字段。

resume 恢复优先级：

1. `metadata.readFileState` 存在、schema 匹配且 freshness metadata 完整时，直接恢复
   结构化 snapshot。
2. `metadata.readFileState` 缺失或缺少 `mtimeMs` / `revisionId` / `sizeBytes` 时跳过
   该历史 `Read`，不从 `state.output` 字符串解析 cat-n 文本。
3. 成功的 `Write` / `Edit` 用 completed tool part metadata 里持久化的完整快照恢复，
   schema 与 freshness 要求同第 1 条；正文不取 tool input，也不读 resume 当下的磁盘（外部的
   手动保存不能被当成模型已读）。没有该 metadata 的历史 `Write` / `Edit` 不恢复。

恢复出的记录另带工具输入里 `file_path` 的原始写法（读取状态的 `requestedPath`，和 `path` 不同时才有），
取自同一个 tool part 的 `input`，与 live 时工具记下的值相同。读权限规则按原始字符串匹配，compaction 补回用它和
`path` 各判定一次 deny（[rewind-compact.md](../rewind-compact.md) 的文件恢复）。原始写法不写进 metadata 快照。
修复原因（2026-10-27）：原始写法原来随快照持久化，这个字段出现之前写下的记录（含已发布版本）没有它，升级后冷恢复，
补回只按规范化路径判定，相对写法的 deny 规则拦不住；tool part 的输入一直都存着，新旧记录都能取到。

代码注释需要说明这个容易误判的点：

- `isPartialView` 是“模型视图不完整”的语义，不是 `offset` / `limit` 的别名。

## 验证要求

- full `Read` 后 resume，下一次 `Write` 既有文件不再报未读。
- 只有 range `Read` 的历史 resume 后，文件未变化时 `Write` 通过未读 guard，与
  same-runtime 相同。
- full `Read` 后又 range `Read` 的历史 resume 后，恢复出的是 range `Read`；再 full `Read`
  返回正文，与 same-runtime 相同。
- full `Read` 后又 token-truncated full `Read` 的历史 resume 后，后者恢复为
  `isPartialView` 并覆盖旧 full `Read`。
- same-runtime range `Read` 后，文件未变化时 `Write` 可通过未读 guard。
- `isPartialView` read-state 仍被 `Write` 和 `Edit` 拒绝。
- compact / rewind 后，只有 active message 里的 tool 结果会恢复 read-state。
- 返回 `file_unchanged` 的 Read 不记录快照；旧数据里这类 Read 的快照在冷恢复时被跳过，恢复出之前那次
  读取的视图和时间。
- compact 后，补回成功的文件在 live 表里：Read 返回 `file_unchanged`，Edit 不报未读；超过单文件上限的
  文件为部分视图；被丢掉或读取失败的文件没有记录。重启或 rewind 后这些记录都没有。
- rewind 后 `MEMORY.md` 的 context 记录仍在，`Write` `MEMORY.md` 不报未读；resume 后由
  context 初始化重新写入。
- 同一文件多次读取只留一条记录，查找不遍历整张表。
- Windows drive-letter path normalization 保持现有行为。
