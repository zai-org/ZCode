# Write Tool

## 定位

`Write` 创建文件或完整覆盖本地文件。

## 输入契约

`Write` 输入是严格对象：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file_path` | `string` | 是 | 要写入的路径；相对路径按 session cwd 解析，绝对路径会规范化后直接交给文件系统 adapter |
| `content` | `string` | 是 | 完整文件内容 |

设计要求：

- `Write` 是完整内容写入，不是 patch。
- 运行时会把 `file_path` 统一规范化为绝对路径；相对路径基于 session cwd，不能隐式使用 adapter 的宿主进程 cwd。
- 修改已有文件前必须先 `Read`。
- 修改已有文件时优先建议使用 `Edit`，因为 `Edit` 只传 diff 语义。
- 覆盖已有文本文件时，`Write` 必须复用 `FileSystemPort.readTextFile` 返回的原始 `encoding` 和 `lineEndings` metadata，优先保留 GB2312 / GBK / GB18030 等 legacy 编码；新建文件默认 UTF-8。
- 如果完整写入内容包含原编码无法表示的字符，filesystem adapter 必须失败并保留原文件，不允许静默替换为 `?` 或写坏 bytes。
- 不应让模型默认新建文档或 README，除非用户明确要求。

## 输出契约

输出：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `create | update` | 新建还是覆盖已有文件 |
| `filePath` | `string` | 写入路径 |
| `content` | `string` | 已写入内容 |
| `structuredPatch` | `Hunk[]` | 展示用 diff hunk |
| `originalFile` | `string | null` | 原始内容，新文件为 `null` |
| `gitDiff` | optional object | 远程场景可附带 git diff |

模型可见结果是短文本：

- 新建：文件已创建。
- 更新：文件已更新。

完整内容和 diff 留给 UI、审计和 artifact，不直接塞进模型响应。

当前最小实现要求：

- `structuredPatch` 必须在写入成功后生成，供 TUI 和调试事件展示。
- TUI 只展示有限行数的 red/green diff preview：按 hunk 行渲染行号 gutter、`+`/`-` 标记和整行红绿背景；不把这个 UI projection 当作模型可见契约。
- 首版 TUI preview 不做语法高亮、word diff、权限弹窗内编辑或完整 review UI；这些能力需要独立 spec 和测试。
- 模型可见结果仍走 result budget 序列化；UI diff display 是额外 projection，不应被业务逻辑反向解析。

## 行为语义

核心流程：

1. 按 session cwd 展开相对路径并规范化为绝对路径。
2. 当前版本不硬拒绝 workspace 外路径，只保留绝对路径规范化；后续由 filesystem permission adapter 接管工作区外写入的 ask/deny 策略。
3. 定位父目录。
4. 对内容做 secret 检查，特别是 team memory 文件。
5. 检查 edit deny 规则。
6. 如果文件已存在，要求此前完整读取过该文件。
7. 通过 mtime 和读缓存防止 stale write。
8. 创建父目录。
9. 可选记录 file history，用于撤销或审计。
10. 再次同步读取当前文件并确认没有被并发修改。
11. 以原编码写入完整内容；ZCode 当前会把已有文件的 `lineEndings` metadata 传回 adapter 以保留既有换行风格。无法编码到原编码时失败，不降级成有损替换。
12. 通知 LSP 和 IDE 文件已更新。
13. 更新 `readFileState` 为新内容和新 mtime。
14. 返回 create/update 结果和展示用 diff。

## 权限模型

`Write` 是写入工具，默认不是只读，也不并发安全。

权限判断来自统一 filesystem write permission：

- edit deny 规则优先。
- plan、scratchpad 等内部可编辑路径可直接 allow。
- `.claude/**` 等敏感目录只允许 session scoped 特例规则绕过安全检查。
- 危险文件、危险目录、Claude settings、可疑 Windows path 进入 ask。
- `acceptEdits` 模式下，工作区内写入可 allow。
- explicit edit allow 可 allow。
- 默认 ask，并提供 `acceptEdits` 或新增工作目录建议。

ZCode 应把 create/update 都归入 `workspace` side effect，并显式声明可能覆盖已有文件。

## 校验与错误

失败路径包括：

- team memory secret 检查失败。
- 路径被 edit deny rule 命中。
- 现有文件未读过。
- 现有文件只读了 partial view。
- 文件自上次读取后被用户、formatter 或 linter 修改。
- UNC path 不做提前 I/O，交给权限处理。
- 写入过程中的文件系统错误向上冒泡。

这些错误应保留原始 cause。handler 能预期的失败用数字 `errorCode` 区分（见下一节）；权限拒绝走权限链路，
文件系统 I/O 错误照原样抛出，都不在下表里。

### 模型看到的文字（2026-11-14）

下面的失败由 handler 返回 `{ result: false, errorCode, message }`，executor 包成 `<tool_use_error>…</tool_use_error>`；
App 显示不带标签的原文。检查都在 handler 里、权限之后，时机不变。`<file_path>` 是模型传入的原值。

| 条件 | errorCode | 文字 |
| --- | --- | --- |
| 已有文件没读过；或最近一次视图是部分视图（Read 只返回了一页、压缩补回时只给了引用、截断后注入上下文的 MEMORY.md） | 2 | `File has not been read yet. Read it first before writing to it.` |
| 读后被改过 | 3 | `File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.` |
| 目标是目录 | 17 | `<file_path> is a directory, not a file. To create a file inside it, include the file name in file_path.` |
| 目标存在但不是普通文件 | 18 | `<file_path> exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.` |

截断注入的 MEMORY.md 不单独写“只看到开头，改用 Edit”：ZCode 的 Edit 同样要求先完整读过（03-edit.md），照那句去做
会再失败一次；“先 Read”在 Write 与 Edit 上都成立。
目录与非普通文件原来返回文件系统层的 `Cannot read directory as text file: <path>` / `Cannot read non-file path as text: <path>`，
模型看不出是 `file_path` 写错了。已有文件的编码读不出来时仍抛文件系统错误，文字不变。

修复原因：这些失败原来都是抛出的异常，不带 `<tool_use_error>`；Edit 的同类失败一直带标签，两个工具不一致。

## ZCode 设计结论

## 实现状态（2026-05-08）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 基本创建/覆盖 | implemented | 当前 `Write` 已通过 `FileSystemPort` 读取原内容、写入完整内容并生成 `structuredPatch`。 |
| 相对路径按 session cwd 解析 | implemented | 当前路径解析不依赖宿主进程 cwd。 |
| workspace 外路径硬拦截 | disabled | 当前版本只规范化路径，不在 core path-policy 拒绝工作区外写入；原因是 subagent 需要按用户指令操作外部仓库或文件，细粒度 ask/deny 后续收敛到 filesystem permission adapter。 |
| 模型可见使用指导 | in progress | 本轮补充 guidance：修改已有文件前先 `Read`，优先用 `Edit` 修改既有文件，不主动创建文档。 |
| 模型可见短结果 | in progress | 本轮将 `Write` 成功结果序列化为短确认文本，完整内容和 diff 仅留给结构化 output / UI projection。 |
| existing file read-before-write | missing | 当前 runtime 尚未要求已有文件先被完整 `Read`。 |
| stale write 防护 | partial | 当前依赖 `FileSystemPort.writeTextFile(expectedRevision)` 的单次读写保护，但缺少基于 read cache 的未读、partial read 和 mtime/content 对比。 |
| file history / LSP / IDE 通知 | missing | 尚未接入文件历史记录和编辑器通知链路。 |
| secret/settings/dangerous path 校验 | missing | 当前主要依赖通用路径策略和权限声明，尚未覆盖特殊文件安全校验。 |

本轮只落地模型指导和短结果序列化；read cache、stale guard 和安全校验在后续阶段补齐。

`Write` 不能是一个直接 `fs.writeFile` 的薄壳。它需要成为受控 file mutation pipeline：

- 业务层只提交 `WriteFileIntent`。
- `FileMutationService` 负责读缓存校验、mtime/content 比对、diff 生成、history 和 LSP 通知。
- `FileSystemPort` 负责 mkdir、stat、read、atomic write。
- `FileSystemPort` 是写入能力边界；Node 本地写入和 ZCode app-server `fs/write_text_file` 都必须实现同一契约。
- `PermissionPort` 负责 workspace、dangerous path、mode 和 rule 判断。
- 写入成功后必须更新 read cache，否则下一次 `Edit` 会误判 stale。
- 测试必须覆盖未读写入、partial read、mtime 假阳性、文件不存在创建、路径权限和换行保持。
