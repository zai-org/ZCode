# Edit Tool

## 定位

`Edit` 对文件做精确字符串替换。

## 输入契约

`Edit` 输入是严格对象：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file_path` | `string` | 是 | 要修改的绝对路径 |
| `old_string` | `string` | 是 | 要替换的原文 |
| `new_string` | `string` | 是 | 替换后的文本，必须不同于 `old_string` |
| `replace_all` | `boolean` | 否 | 是否替换所有匹配，默认 `false` |

设计要求：

- 模型必须在本轮对话中先使用 `Read` 至少一次再调用 `Edit`。当前 runtime 的 read cache guard 尚未落地，但 provider-visible prompt 必须先表达这个约束，避免模型盲写。
- `old_string` 必须来自 `Read` 输出里的真实文件内容，不能带行号前缀。
- 当前 `Read` 模型可见格式为 `<lineNumber>: <fileContentLine>`；模型从 Read 结果复制时必须丢弃行号、冒号和第一个空格，只保留其后的真实内容。真实内容如果本身以 tab 或空格开头，必须原样保留。
- `Edit` 必须兼容旧 `Read` 输出格式 `<lineNumber>\t<fileContentLine>`，用于历史对话、日志回放和模型复制旧结果时的兜底。
- 模型编辑从 Read 输出复制的文本时，必须按行号前缀之后的内容保留精确缩进、tab、空格和上下文。
- `Read` 向模型展示、`Edit` 匹配和 diff 生成统一使用 LF 逻辑内容；Windows CRLF 文件由 filesystem adapter 在读取时记录 `lineEndings=CRLF`，写回时恢复 CRLF。模型不需要、也不应该在 `old_string` 中手写 `\r\n`。
- `old_string` 和 `new_string` 都是从 `Read` 结果复制或推导出的 Unicode 逻辑文本。filesystem adapter 负责 GB2312 / GBK / GB18030 等 legacy 编码的解码与原编码写回；模型不应通过 Bash、Node、Python、iconv 或 sed 先行转码再编辑。
- `Edit` 以精确匹配为第一优先级。仅当精确匹配失败时，才允许启用保守兼容 matcher；所有 matcher 必须返回文件中的真实旧字符串，且最终候选必须唯一。
- 允许的兼容 matcher 包括：quote normalization、行号前缀剥离、逐行 trim、共同缩进差异、字面量转义 `\n` / `\t` / `\r` 归一化、首尾锚点块匹配。不得做开放式语义猜测、AST 猜测或跨文件搜索替换。
- `replace_all=true` 时只能使用精确、quote normalization、行号前缀剥离和字面量转义等不会扩大匹配范围的策略；不能用逐行 trim、缩进弹性或块锚点批量替换。
- 兼容 matcher 命中时，结构化输出必须记录 `matchStrategy`，便于日志、trace 和后续问题诊断。
- 默认要求 `old_string` 在文件中唯一；如果不唯一，`Edit` 必须失败，模型应扩大上下文让 `old_string` 唯一，或显式设置 `replace_all`。
- `replace_all` 用于跨文件内替换和重命名同一字符串，例如变量重命名。
- 多处替换必须显式设置 `replace_all`。
- 总是优先编辑代码库中的既有文件；除非用户显式要求，否则不要创建新文件。当前 ZCode `Edit` 拒绝空 `old_string`，创建新文件应使用 `Write`。
- 只有用户显式要求时才向文件加入 emoji。

## 输出契约

输出：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `filePath` | `string` | 被编辑路径 |
| `oldString` | `string` | 实际匹配到的旧字符串 |
| `newString` | `string` | 新字符串 |
| `originalFile` | `string` | 编辑前完整内容 |
| `structuredPatch` | `Hunk[]` | 展示用 diff hunk |
| `userModified` | `boolean` | 用户是否在权限 UI 中改动了提议变更 |
| `replaceAll` | `boolean` | 是否替换全部匹配 |
| `gitDiff` | optional object | 远程场景可附带 git diff |

模型可见结果只确认文件已更新；如果 `replaceAll` 为真，会说明所有匹配已替换。

当前最小实现要求：

- `structuredPatch` 必须在编辑成功后基于编辑前后内容生成，供 TUI 和调试事件展示。
- TUI 只展示有限行数的 red/green diff preview：按 hunk 行渲染行号 gutter、`+`/`-` 标记和整行红绿背景；不把这个 UI projection 当作模型流程判断依据。
- TUI 默认标题为 `Edit <path>`。`<path>` 在当前 workspace 内显示相对路径，workspace 外保留绝对路径；结果区不重复显示 `file_path`、`replace_all`、`diff: ... (+n -n)` 或 `@@ ... @@`。
- TUI diff preview 由 TUI 内部消费结构化 hunk 渲染：窄屏显示 unified 单列行号，宽屏显示 split 多列。语法高亮使用 Shiki：根据文件路径推断 Shiki language，对 changed/context 行做 tokenization，并把 token 前景色转换为 OpenTUI `StyledText` chunks；整行红绿背景、行号 gutter 和 `+`/`-` 标记继续使用 TUI theme token。Shiki 不支持的语言、加载失败或高亮超时必须降级为纯文本 diff。行号展示只服务人工审计，不进入模型可见结果。
- 首版 TUI preview 不做 word diff、权限弹窗内编辑或完整 review UI；这些能力需要独立 spec 和测试。
- diff display 是 `tool_call_result` 的 UI projection，不替代 `EditOutput` 契约，也不作为模型流程判断依据。

## 行为语义

核心流程：

1. 展开路径并规范化为绝对路径；当前版本不硬拒绝 workspace 外路径，后续由 filesystem permission adapter 接管工作区外编辑的 ask/deny 策略。
2. 拒绝向 team memory 写入 secret。
3. 拒绝 `old_string === new_string`。
4. 检查 edit deny rule。
5. 对 UNC path 跳过提前 I/O，交给权限处理。
6. stat 防止超大文件导致 OOM，上限为 1 GiB。
7. 通过 `FileSystemPort.readTextFile` 读取文件 bytes，由 adapter 按 BOM、UTF-8 校验和 legacy 中文编码检测推断文本编码，并返回 LF 规范化后的 Unicode 逻辑内容、原始 `encoding` 和 `lineEndings` metadata。
8. 当前 ZCode 拒绝空 `old_string`，避免对既有文件产生隐式插入；创建新文件或完整重写使用 `Write`。
9. 不存在文件且 `old_string` 为空时创建文件的行为，ZCode 暂不暴露；后续如需支持必须先更新 `Write/Edit` 边界和测试。
10. `.ipynb` 文件拒绝，提示用 shell 命令或脚本改 notebook JSON（ZCode 没有 notebook 编辑工具）。
11. 已存在文件必须此前完整 `Read`。
12. mtime 变更时，如果完整读缓存内容仍相同，可继续；否则拒绝 stale edit。
13. 先用 exact，再用 quote normalization 和受限兼容 matcher 查找实际字符串。
14. 匹配不到或非唯一匹配时拒绝；fallback 候选多于一个也必须拒绝，不允许工具替模型猜位置。
15. 对 settings 文件做额外校验。
16. 生成 patch，调用 `FileSystemPort.writeTextFile` 时带回 `encoding` 和 `lineEndings`，保持原编码和原换行风格写回；如果 `new_string` 无法编码到原编码，工具必须失败且不写入。
17. 通知 LSP 和 IDE。
18. 更新 `readFileState`。

## 权限模型

`Edit` 和 `Write` 共用 filesystem write permission。它是写工具，不并发安全。

额外要求：

- `preparePermissionMatcher` 按文件路径匹配 wildcard。
- `toAutoClassifierInput` 使用 `file_path` 和 `new_string`，用于自动权限分类。
- 对 `.claude`、settings、危险路径的 session scoped 例外需要在 permission layer 中处理，而不是散落在 tool 里。

## 校验与错误

错误码语义可归纳为：

| 场景 | 语义 |
| --- | --- |
| secret 检查失败 | 拒绝写入敏感内容 |
| 新旧字符串相同 | 无变更 |
| deny rule | 权限拒绝 |
| 目标不存在且旧字符串非空 | 文件不存在 |
| 目标存在且旧字符串为空 | 不能创建，文件已存在 |
| notebook | 需要专用 notebook edit |
| 未读或 partial read | 必须先完整读取 |
| mtime/content 变化 | stale edit |
| old string 找不到 | 匹配失败 |
| 多处匹配但未 replace_all | 歧义替换 |
| 文件过大 | 超出编辑大小上限 |
| 空 `file_path` | 路径不能为空 |
| 不支持编码或新内容不可编码 | 拒绝并保持原文件不变 |

ZCode 应给这些错误稳定 code，避免依赖英文文本判断流程。Edit handler 在原有检查位置发现
可预期拒绝时返回 `{ result:false, errorCode, message }`，不通过 `throw` 向 executor
传递；成功路径、读取次数和执行顺序保持不变。executor 通用组装结构化 error，并只在
provider-visible `modelContent` 外包 `<tool_use_error>`；UI、日志和结构化 error 保留裸
message。

数字错误码固定为：无变更 `1`、文件已存在且
`old_string` 为空 `3`、文件不存在 `4`、Notebook `5`、未完整读取 `6`、stale `7`、
未找到 `8`、非唯一 `9`、文件过大 `10`。I/O 故障、取消或 expected revision 冲突仍属于
执行异常，继续走通用异常路径。ZCode path policy 额外拒绝空 `file_path`，由 Edit
handler 在进入共享路径解析前返回本地稳定错误码 `13` 和既有
`Tool path must not be empty` 文案，避免共享异常绕过 Edit 的 provider error envelope。
这些数字码由 Edit tool contract 统一导出，handler 不再维护第二份私有映射，避免
provider error 与公开工具契约在后续修改中漂移。

### 模型看到的文字（2026-11-14）

| 条件 | errorCode | 文字 |
| --- | --- | --- |
| `.ipynb` | 5 | `File is a Jupyter Notebook. Edit does not change .ipynb files; change the notebook JSON with a shell command or script instead.` |
| 文件过大 | 10 | `File is too large to edit (<实际大小>). Maximum editable file size is 1GB.` |
| 文件不能按 UTF-8 或 GB 编码读出（adapter 的 `unsupported`） | 15 | 见下 |
| 未找到 old_string，且 old_string 里有 `\uXXXX` 转义 | 8 | 原句后加一行 `(note: Edit also tried swapping \uXXXX escapes and their characters; neither form matched, so the mismatch is likely elsewhere in old_string. Re-read the file and copy the exact surrounding text.)` |

编码错误的文字：

```text
File is not valid UTF-8 or a supported legacy encoding (GB2312, GBK, GB18030), or it is binary. Edit and Write never convert a file's encoding on their own, so nothing was written. If the file is text, make the change with a shell command that reads and writes it in its own encoding (iconv, or PowerShell Get-Content/Set-Content -Encoding), or ask the user whether to convert it to UTF-8 first. To replace the whole file with new UTF-8 text anyway, delete it first, then Write it.
```

- 大小用一位小数、去掉尾随 `.0` 的格式（`1536 bytes -> 1.5KB`），与 Read PDF 摘要相同；上限仍是 1GB。文件只比上限
  大一点、格式化后与 `1GB` 相同时，括号里改写字节数（`(1073741825 bytes)`），不出现“(1GB)… 上限 1GB”。
- 转义说明只在 old_string 含 `\uXXXX` 时追加：匹配器只把 old_string 里的 `\uXXXX` 换成字符再找
  （`unicode_escape_normalized`），不把字符换成转义去找，所以只有非 ASCII 字符、没有转义时不加这句。
- 原来的文字分别提到不存在的 `NotebookEdit` 工具、把大小写死成 `(1GB)`、编码错误是不带标签的
  `Unsupported or binary text encoding: <path>`。

## ZCode 设计结论

## 实现状态（2026-05-08）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 基本精确替换 | implemented | 当前 `Edit` 已通过 `FileSystemPort` 执行 `old_string` -> `new_string` 替换并生成 `structuredPatch`。 |
| 相对路径按 session cwd 解析 | implemented | 当前路径解析不依赖宿主进程 cwd。 |
| workspace 外路径硬拦截 | disabled | 当前版本只规范化路径，不在 core path-policy 拒绝工作区外编辑；原因是 subagent 需要按用户指令操作外部仓库或文件，细粒度 ask/deny 后续收敛到 filesystem permission adapter。 |
| 模型可见使用指导 | implemented | 已补充 guidance：先 `Read`、不要带行号前缀、保持缩进、默认唯一匹配、多处替换显式 `replace_all`、优先编辑既有文件、emoji 仅在用户显式要求时加入。 |
| 模型可见短结果 | in progress | 本轮将 `Edit` 成功结果序列化为短确认文本，完整原文和 diff 不直接回灌模型。 |
| read-before-edit | missing | 当前 runtime 尚未要求此前完整 `Read`，因此无法区分未读、partial read 和 stale edit。 |
| 唯一性检查 | implemented | 当前 `replace_all=false` 时会拒绝多处匹配，要求模型提供更具体的 `old_string` 或显式设置 `replace_all`。 |
| quote normalization | implemented | `Edit` 匹配失败时会尝试 curly quote normalization，并在 `new_string` 中保留文件原有 curly quote 风格。 |
| line-number prefix compatibility | implemented | `Edit` 可剥离模型误带入的 `<lineNumber>: ` 或历史 `<lineNumber>\t` 视图前缀。 |
| indentation fallback | implemented | exact miss 时可在唯一候选前提下容忍共同缩进、行首尾空白或字面量 `\n` / `\t` 抄写差异。 |
| CRLF / UTF-16LE / legacy 中文编码 / 原换行保持 | in progress | `FileSystemPort` 返回 LF 逻辑内容、原始 encoding 和 line ending metadata；`Edit` 在 LF 空间匹配并按原格式写回。 |
| empty `old_string` 创建语义 | partial | 当前显式拒绝空 `old_string`，避免 JS includes/replace 产生隐式插入；暂不支持通过 `Edit` 创建新文件，创建应使用 `Write`。 |
| notebook/settings/secret 校验 | missing | 尚未拒绝 `.ipynb` 或进行 settings/team memory 安全校验。 |
| 稳定业务错误 | implemented | handler 在既有检查位置返回固定的数字 `errorCode + message`；executor 通用组装 provider error，不改变成功路径。 |

本轮落地模型指导、短结果序列化和 `replace_all=false` 的多匹配拒绝；read cache、stale guard、编码保真和结构化错误在后续阶段补齐。

`Edit` 是 ZCode 的核心 NL-to-code mutation primitive。实现时需要优先保证可验证性：

- `old_string` 精确匹配和唯一性是核心契约；兼容 matcher 只能修正模型从 Read 视图复制文本时的格式误差，不能替模型自由猜测修改位置。
- 结构化补丁编辑由 `ApplyPatch` 承担，不能把 patch 语义塞进 `Edit.old_string`。
- 读前编辑约束必须和 `Read` 的 cache 结构共享。
- 写回必须保持原编码和原换行风格；`Edit` 不直接猜测宿主系统 EOL，而是消费 `FileSystemPort` 的 `lineEndings` metadata。
- 文件读取、stale 校验和写回必须通过 `FileSystemPort`，不得在 core handler 中直接调用 Node `fs`。
- 权限 UI 应展示 diff，并允许用户拒绝或修改提议。
- 测试必须覆盖缩进、CRLF、UTF-16LE、GB2312/GBK/GB18030、重复匹配、quote normalization、stale edit、不可编码字符失败和 settings 文件保护。
