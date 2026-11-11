# ZCode Memory 设计 v4

## 1. 文档定位

本文定义 ZCode CLI Memory 的目标行为，验收对象是 Anthropic Messages 请求（含
`mid-conversation-system-2026-04-07` 分支）最终 provider request 中的 Memory 内容。

Project Memory retrieval 有 `default-index` 与 `semantic-recall` 两种互斥行为，分支边界共三处：
Main pointer、AutoMem index 过滤、Selector 启动。ZCode 保留两种互斥行为，并以 Core 内部唯一常量
`PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED=false` 选择当前默认分支；不暴露用户配置、runtime
preference、协议字段或测试 setter。

验收面是 adapter 发出的最终 provider request body，不是 Context builder、Runtime
message history 或其他中间对象。

行为与验收事实的优先级固定为：本 spec → 语义 fixture → 生产 generator/adapter/E2E 证据。
历史 plan、旧 capture、测试实现和中间 Context 对象都不能反向覆盖前两项；发现冲突时必须先修正低优先级证据，不能同时保留两套 active contract。

本次是对现有 MVP active path 的整体替换。以下旧机制退出 active path：

- `memory_summary.md`
- `topics/`
- 关键词相关性打分
- “记住 / 忘记”正则
- Runtime 直接生成 ad hoc note、rollout summary 和 topic
- `memory.autoConsolidate`、`memory.summaryMaxBytes`、可覆盖的 `memory.rootDir`

旧文件不迁移、不删除、不双读。

## 2. 目标与边界

Memory 包含五个能力：

1. Main Agent 的持久 Memory 文件协议与 provider-visible system section。
2. 由内部全局常量互斥选择的 default index 或 Semantic Recall；当前选择 default index。
3. 成功 Main turn 后的后台 Extraction。
4. Dream consolidation handler 与 `memory_update`；当前产品链路不自动触发。
5. custom agent 的 `user | project | local` 持久 Memory。

Project Memory 文件和后台运行态的权威仍属于 CLI storage / Runtime。Desktop Main、Host Process、
Renderer、mobile remote relay 不复制或持久化 Memory 文件、Recall 状态、Extraction cursor 或
Dream lock。Desktop/Host 持有 app-global 开关，并通过现有
`session/requestRuntimePreferences` 在根 Runtime 创建边界下发一个布尔值；不在 Agent 协议中
传递 Memory 正文或后台状态。

Desktop Settings 通过本地 Host 的现有 Memory service 按需读取当前本地 profile 下的 Project
Memory 目录，向 Renderer 返回只读 catalog 或单文件快照。Web Remote / Mobile 不调用该
catalog。Host 和 Renderer 只在一次查看期间临时持有这些数据，不成为新的事实来源，也不启动
Agent Runtime、修改 Memory 文件或发起模型请求。

Memory 与 compact 分工固定：compact 维持当前 session 连续性；Memory 保存跨 session
可复用事实。Semantic Recall 分支启用时，compact 与 resume 只重置其 session-local 状态，
不直接写入 Memory。

## 3. 配置、scope 与目录

### 3.1 用户配置

公开配置只保留：

```json
{
  "features": {
    "memory": true
  },
  "memory": {
    "use": true
  }
}
```

- `features.memory=false`：完全关闭 Memory。
- `memory.use=false`：不创建或读取 project Memory，不注入 Memory prompt，不运行 Recall、
  Extraction 或 Dream。

`features.memory`、`use` 默认均为 `true`。Memory 只有启用和未启用，不提供
read-only/writable capability，不提供旧配置 alias，也不提供自定义保存路径。

`-p` / `--prompt` 与 `--target` 共用的 non-interactive `runPrompt` 在创建 Runtime 时固定注入内部
`memory.extractionEnabled=false`。该字段不是用户配置、CLI flag、环境变量、runtime preference 或
协议字段；缺省时按启用处理，因此 TUI、app-server、Desktop/Host 行为不变。`false` 只关闭成功
Main turn 后的自动 Background Extraction；Main Memory prompt、`MEMORY.md`、Selector/Recall、Dream
handler、custom-agent Memory 与 session persistence 均保持原行为，也不提供远端 rollout gate。

Desktop/Web Settings 另提供设备级 `memoryEnabled` 开关，默认为 `false`。它是
现有 CLI Memory 配置外层的 kill switch：

```text
Settings 写入 memoryEnabled
          |
          +-- 已存在 Runtime ----------------------------> 保持创建时的值
          |
          +-- 新建根 Session / 真正 cold resume
                         |
                         v
          session/requestRuntimePreferences
                         |
                         v
              在 Runtime materialization 时冻结
                         |
          +--------------+----------------+
          |                               |
       false                           true
          |                               |
  强制 Memory disabled       继续服从 features.memory/use
```

- 会话记录的 `memoryEnabled` 通过 V4 command ACK 与 live telemetry fact 的可选 boolean 字段透传。
  App 用它填充 `send_btn`、`message_completion`、`agent_step` 的 `memory_enabled`（`"1"`/`"0"`）；
  旧发送端缺字段时留空，不推断开关关闭。该值不代表实际记忆读写，后台 child 继承来源会话，
  不改变开关优先级或 continuous/replayable 采集边界。
- 开关只在根 Runtime materialization 时读取一次；Session 创建后切换不热更新、
  不重建 Runtime。
- 新安装或现有 `setting.json` 缺少 `memoryEnabled` 时默认关闭；已经持久化的显式
  `true` / `false` 继续保留，不做一次性迁移。
- 新建根 Session 和应用重启后的真正 cold resume 读取最新值。fork、
  selection side chat 与 subagent 继承父 Runtime 已冻结的值，不再读 Settings。
- 本地 workspace 与 R3 远端 workspace 分别由所在 Host 读取自己的 SettingService；
  Desktop 记忆页可选择设备，经 source-settings 修改远端开关，不同步本机值。
  relay/main 不保存副本。见 `docs/remote/memory-settings.md`。
- `memoryEnabled=false` 时，该 Runtime 不创建 project/custom Memory root，不注入
  Main/custom Memory prompt，不运行 Recall、Extraction 或 Dream，也不产生任何
  Memory 专用模型请求。
- `memoryEnabled=true` 不覆盖 `features.memory=false` 或 `memory.use=false`。三者任一
  关闭都使 Memory 失效。
- 协议 result 字段为 `memoryEnabled: boolean`。旧 responder 未返回该新字段时
  按当前产品默认值 `false` 解析；显式非布尔值仍视为无效响应。
- Settings 提供独立的 Memory 模块。开关说明下常驻显示普通辅助文本语义的用量提示，不根据
  开关状态隐藏。中文文案为：“用量提示：开启 Memory 后，系统可能会发起额外的模型请求来
  提取和召回长期记忆，从而增加 Token 用量和使用成本。”视觉与其他设置说明一致，使用现有
  `text-foreground-subtle` 语义色，不新增颜色 token 或提示组件。
- 开关关闭时不读取 Project Memory catalog，只展示启用提示；开关打开后可立即查看已有本地
  Memory，但这不改变当前 Session 已冻结的 Runtime 开关值。

### 3.2 Project Memory root

```text
<cli-storage-root>/memories/projects/<workspace-key>/memory/
  MEMORY.md
  <fact-name>.md
```

隔离键固定为：

```text
workspaceKeySource = workspaceIdentity?.trim() || normalizedWorkspacePath
```

- 显式 `workspaceIdentity` 是不透明 identity，只 trim 后参与稳定散列，不能按本地路径解析。
- 没有 identity 时，先将 `workspacePath` 解析为平台规范化绝对路径；Windows 参与散列前
  转为小写。
- project key 复用现有“basename slug + SHA-256 前 16 位”格式；slug 来自规范化本地
  basename。显式 identity 没有可信 basename 时使用语义中性的 `project` slug。
- 新的末级 `memory/` 用于隔离旧 MVP 文件；Recall 不读取父目录中的旧数据。
- 会话初始化后以稳定的 `workspaceRoot` 计算 project root；Bash `cd` 只改变执行 cwd，不能
  使 prompt、权限、Extraction 或 Dream 切换到另一个 Memory root。
- resume 必须先恢复 persisted `taskType` 和 `workspaceIdentity`，再计算 Memory root；当前
  request 的 `workspacePath` 仍用于文件执行，不能被 identity 替代。
- Main、foreground permission、Extraction 和 Dream 只通过同一个 enabled-root helper
  取得 root；该 helper 不负责权限、目录创建或文件格式。
- root 的首次目录创建是 best-effort：mkdir 失败只记 debug 日志，Main/custom prompt 仍按
  canonical root 注入，真正的 Write/Edit 继续返回原始文件错误。不得增加 retry、备用目录、
  health state 或恢复任务。

Main-equivalent task type 仅为：

- `interactive`
- `fork`
- `selection_side_chat`
- `workflow_parent`

调用方未提供 `taskType` 时按 `interactive` 处理；这是现有默认 Main session 的兼容语义，
不扩展新的 task type。

`workflow_child`、`subagent_child`、`nested_workflow_child` 不获得 project Memory prompt、
Recall、Extraction、Dream 或 project Memory 权限。声明 custom-agent Memory 的
`subagent_child` 只访问自己的 custom root。

### 3.3 Settings Project Memory viewer

Settings 中的 Memory 开关在 Desktop 与 Web Remote / Mobile 都展示；Project Memory viewer
只在 Desktop 本地 Host 展示。Web Remote / Mobile 不读取 catalog，在 viewer 位置提示用户前往
本地桌面端查看：

```text
Desktop 本地 Host  -> Memory 开关 + 本地 Project Memory viewer
Web Remote / Mobile -> Memory 开关 + 本地桌面端查看提示
                                      `- 不调用 catalog service
```

本地 viewer 的数据范围固定为当前本地 app profile：

```text
<data-root>/cli/memories/projects/<project-key>/memory/
  MEMORY.md
  <fact-name>.md
```

- 不聚合 SSH、WSL、Docker 等远端 Host，不读取 custom-agent Memory，也不发现项目级外部
  `storage.dir`。
- Desktop Settings 中整个 Memory viewer 固定使用本地 Base Host services；即使当前激活的是
  SSH、WSL 或 Docker workspace，Markdown 中的本地图片也只通过本地 FileService 读取，不会
  路由到远端 Host。HTTP(S) 图片继续沿用现有 Markdown renderer 的浏览器加载行为。
- workspace catalog 只扫描一级 project 目录及其 `memory/` 下的一级普通文件；不跟随目录或
  文件 symlink。只接受精确 `MEMORY.md` 和严格小写 `.md` 事实文件，空 workspace 不展示。
- project 目录 basename 是 opaque workspace id；展示名称只从已有 slug 派生并附 hash 后缀，
  不新增 workspace inventory、映射数据库或 metadata 文件。
- catalog 只返回文件名、类型、大小和修改时间；正文仅在用户选中文件后按需读取，并保持原始
  Markdown 和 frontmatter 不变。单文件预览上限为 5 MiB（5 × 1024 × 1024 bytes）；超过上限
  时拒绝读取并在正文区域展示本地化的预览上限提示，不截断、不返回部分内容。
- 正文读取必须通过单次调用内的只读稳定句柄完成，并在打开后复检路径 containment 与文件身份；
  不获取文件所有权、不加锁，也不阻塞 Main、Extraction 或 Dream 的原子更新。并发更新优先成功，
  当前预览只允许返回更新前的完整快照或“文件已变化”错误，句柄始终在调用结束时关闭。文件已变化
  使用稳定错误码，Renderer 展示本地化提示并允许用户重新打开或刷新文件列表。
- Renderer 先展示项目列表，再由用户明确进入一个项目查看该项目 catalog 中的全部 Memory，
  最后按需打开单条 Markdown 正文。项目列表项使用 Folder 图标，第一行展示项目名称，第二行展示
  本地化的“记忆数量 · 更新时间”；数量包含 `MEMORY.md` 与全部事实文件。`MEMORY.md` 与事实文件
  在项目内都是平级可选项；二级项目标题下只展示记忆数量，不展示保存目录。缺少
  `MEMORY.md` 时直接展示其余事实文件，不生成虚拟父节点。
- Settings 模块标题按 locale 展示为 `Memory` / `记忆`；模块内开关命名为
  `Workspace Memory` / `工作区记忆`，描述只说明按 workspace 保存、复用和生效边界。
- viewer 使用“项目列表 → 项目全部 Memory → 单条正文”的三级导航。打开 viewer 不隐式进入
  最近项目；点击项目只切换到文件列表，不读取正文。项目和文件行使用原生 button，长名称在行内
  截断并通过应用内 Tooltip 展示完整内容；正文继续复用现有 Markdown renderer。
- 项目 Memory 列表提供返回项目列表操作，正文提供返回项目 Memory 列表操作；返回时不保留正文
  选择。Desktop 与手机宽度保持相同信息层级，只调整布局密度，不切换为另一套组件语义。
- Desktop 中 Memory 已开启且 viewer 实际展示时，viewer 占满 Settings 页面剩余空间并隐藏外层
  溢出；文件树和正文预览分别独立滚动，避免整个 Settings 页面随长文件或大量事实文件滚动。
  Memory 关闭态及 Web Remote / Mobile 的本地查看提示态继续使用 Settings 的普通页面滚动。
- 项目记忆总数按当前语言展示；英文使用 `1 memory` / `N memories`，中文保持 `N 条记忆`。
- viewer 只读，不提供编辑、删除、项目/文件/正文搜索或导出。Desktop 且存在可返回的 Workspace
  Shell 时，项目列表行提供“打开 Memory”和“打开文件树”两个入口：“打开 Memory”进入现有项目
  Memory 列表；“打开文件树”只在用户点击后，由本地 Base Host 按已校验的 opaque workspace id
  解析 `<data-root>/cli/memories/projects/<project-key>/memory/`，再复用 Markdown 本地目录链接的
  `stat -> temporary external WorkspaceFileTree` 链路打开该 Memory 目录。Renderer 不自行拼接 data
  root，目录解析不创建目录、不读取正文、不启动 Runtime；Web Remote / Mobile 和无 Workspace Shell
  的独立 Settings 不展示该入口。
- viewer 只支持显式刷新，不增加
  watcher、polling、cache service、retry 或 fallback。刷新时仅在当前项目和文件仍存在时保留层级；
  文件仍存在则重新读取正文，项目或文件消失时回退到最近的有效父层级，不自动选择替代项。
- Web Remote / Mobile 只保留既有 Memory 开关及 session-scoped 生效语义；不展示 workspace
  catalog、文件树或正文，不调用 catalog service，也不代理或聚合远端 Host 的 Memory。
- `workspaceId` 和 `fileName` 作为 basename 校验，拒绝绝对路径、路径分隔符和 traversal；根目录
  不存在等价于空 catalog。catalog 扫描期间 workspace Memory 目录或单个文件并发消失时，视为
  不属于本次只读快照并跳过；其他 I/O 错误直接投影给 UI。
- 用户选中文件后文件并发消失时，正文区域展示本地化的“文件已被删除”状态；不自动刷新 catalog、
  不重试读取，也不把其他读取错误改写成删除状态。

## 4. Project Memory 文件协议

Main Agent 的 Memory system section 在 Memory 启用且 `use=true` 时始终存在，即使目录为空。
其中的目录、保存规则、读取规则、类型说明和 hygiene 文案必须与冻结的 provider-visible
fixture 一致；只有 root 允许动态变化。description 示例用逗号连接用途说明；
四种类型用冒号定义。保存前检查已有事实、更新事实，以及使用召回内容前核实引用，
各用独立句子表达。Main system prompt 不混入后台 Extraction 或 Custom Agent 的独立
Memory 指令；index/recall 的分支规则见下文。

每个事实写入 project Memory root 顶层的独立小写 `.md` 文件。文件名用 3–4 个描述性词，
不带 type 前缀。一个文件只保存一个事实；已有文件覆盖同一事实时直接更新该文件，错误或失效
的事实可以删除，不为历史版本另建文件。

事实文件格式：

```yaml
---
name: concise-memory-name
description: one-line recall description
metadata:
  node_type: memory
  type: user
  originSessionId: sess_0123456789abcdef
---
One durable fact.
```

`metadata.type` 只接受：

| type        | 内容                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `user`      | 用户角色、知识背景、职责、目标或稳定偏好。                                       |
| `feedback`  | 用户确认或纠正的可复用协作方式。正文包含 `Why:` 与 `How to apply:`。             |
| `project`   | 无法仅从当前代码推导的项目原因、约束或决策。正文包含 `Why:` 与 `How to apply:`。 |
| `reference` | 未来应去哪里查询的外部资源指针。                                                 |

`metadata.node_type` 固定为 `memory`。`metadata.originSessionId` 记录该事实首次写入时的 runtime
session ID，它不由模型生成：Foreground、Extraction、Dream 和 Custom Agent 共用的 Write/Edit
写入边界只在 `originSessionId` 缺失时触发一次 frontmatter 序列化，同时补入
`node_type: memory` 和当前 session ID。已有非空 `originSessionId` 时直接保留文件原文，不单独
规范化 `node_type` 或 YAML 排版。旧文件不批量迁移；后续 Write/Edit 只有在 origin 缺失时才补齐
这两个字段。Recall 不读取或索引这些 metadata 字段，`MEMORY.md` 没有 frontmatter，因此不会被
补入。

`name` 使用短 kebab-case slug；正文可用 `[[other-memory-name]]` 关联其他事实。关联目标暂时
不存在也不是错误，不为此增加引用校验器。

`MEMORY.md` 是短索引，不带事实 frontmatter。Main Agent 每次写入事实文件后按默认分支文案
同步一行 `- [Title](file.md) — hook` pointer；Dream 负责后续整理和裁剪该索引。Recall 始终
排除 basename 精确等于 `MEMORY.md` 的文件。

`default-index` 分支在 Main session 初始化时读取一次 `<project-memory-root>/MEMORY.md`，并与
AGENTS instructions 共用现有 request user context 注入链路。非空索引在最终 Messages
request 开头的公告组（`context_prefix`）中使用以下 provider-visible 结构；`<MEMORY_ROOT>` 是唯一
允许归一化的动态值。只要存在任意非空 instruction source，`context_prefix` 就渲染一次
指令 preamble；不增加字段标题。因此非空 `MEMORY.md` 本身也会产生该 preamble，
不要求同时存在 AGENTS.md：

```text
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

Contents of <MEMORY_ROOT>/MEMORY.md (user's auto-memory, persists across conversations):

<index content>
```

- 文件不存在、不可读、为空或 trim 后为空时，不增加该 instruction source；Main `# Memory`
  system section 仍正常注入。
- 内容先移除文件开头的 YAML frontmatter，再移除 Markdown lexer 识别到的顶层 HTML comment
  token；代码块、段落内的 inline comment 等非 HTML token 内容保持原样。随后 trim，并限制为前
  200 行或 25,000 个 JavaScript 字符。超限时复用 Custom Agent `MEMORY.md` 的同一截断
  helper 和精确 warning，不增加第二套格式或 fallback。
- 初始化读取成功后同步写入现有 `readFileState`：保存磁盘原文、完整读取范围和文件 revision；
  provider-visible 处理结果与磁盘原文不同时标记为 partial。这样未经过处理的完整索引可直接
  Write/Edit；被去 frontmatter/comment、trim 或截断的索引继续遵循现有 read-before-write，需先
  Read 后再修改。这里不增加新的文件状态、权限或自动修复机制。
- cold resume 先从 active branch 的持久化 tool metadata 重建 `readFileState`，再初始化 session
  context 并读取 `MEMORY.md`。因此当前磁盘索引只读取和写入状态一次，并覆盖同路径的历史工具
  状态；后续历史 hydration 不得清除刚加载的 AutoMem read-state。
- 读取只发生在 session context 初始化边界；同一 session 后续 continuation、模型切换或
  Settings 热切换不重新读取。新建 session 和真正 cold resume 重新读取当前索引。
- 读取失败不重试、不切换备用目录，也不影响后续真实 Write/Edit 返回原始文件错误。
- `semantic-recall` 分支在任何 `MEMORY.md` 文件 I/O 前跳过该 AutoMem source，也不为该文件
  seed `readFileState`。它只通过第 5 节的 Selector/Recall 消费事实文件。

除缺失 `metadata.originSessionId` 时同次补齐 `metadata.node_type` 的写入边界外，保存规则只通过
prompt 约束；Runtime 不增加
写后 schema validator、自动修复、secret/PII 扫描或 prompt-injection 分类器。

### 索引截断提示

索引清洗和 200 行 / 25,000 字符上限保持不变。超过上限时，警告说明被省略的
行数、起始行号和该行最多 80 字符的预览；首行内截断则说明首行保留的字符数。
预览超过 80 字符时取前 79 个 UTF-16 码元（不切断代理对），在最后一个空白处断开并去掉
断点前的尾随空白；断点前的内容不超过 40 字符或没有空白时，改用前 79 个码元去掉尾随空白；
最后加 `…`。
Memory 规则仍在 system，索引正文和指令文件保留在 `context_prefix`，其中不再
混入日期、通用 context intro 或自动附加说明尾句。`context_prefix` 是动态公告，发出后不再改写：
运行时启动时和每次 compaction 收尾时读取文件；内容变化时在末尾追加一条增量公告
（见 `loop/meta-user-context.md`）。

### 4.1 Foreground 工具权限

Memory 特殊权限在已有全局 tool、路径与显式 deny/ask 判断之后生效：

- 仅 Main-equivalent runtime 或声明 custom Memory scope 的 child 可获得对应 root 权限。
- 只自动允许 root 内、不包含既有敏感 path segment 的小写 `.md` Write/Edit。
- 权限顺序：显式 tool/path deny/ask 优先；合格 Memory 写入先于 generic
  plan-mode non-read-only block，因此 Plan mode 仍可写 project Memory。
- root 外路径、非小写 `.md`、敏感路径和其他工具继续走原权限策略。
- Bash 保持 foreground 原有全局权限语义；Memory 不增加 shell parser、虚拟只读挂载或回滚。
- 不为 Memory 新增 Read 工具或 Read 特殊授权。现有 runtime 若本来注册 Read，仍按原权限执行。
- `PermissionRequest` hook 返回 `updatedInput` 时，先完成既有输入规范化和 schema 校验，再对
  修改后的输入重新执行最终权限检查；不得沿用修改前的 Memory 判定，也不得重新运行
  `PreToolUse` 或 `PermissionRequest` hook。修改后仍命中受保护 ask（当前为 project ask 或
  Memory target ask）的输入进入既有 permission broker。

## 5. Project Memory Retrieval 双分支

`PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED` 是唯一原始 boolean，当前恒定为 `false`。它只在
`project-memory-retrieval-branch.ts` 中映射为一个语义分支；Prompt、index loader 和 Selector
lifecycle 只能消费映射后的 branch，不能再次各自解释 boolean。

| branch                  | Main pointer | 加载 `MEMORY.md` | Selector | `relevant_memory` |
| ----------------------- | ------------ | ---------------- | -------- | ----------------- |
| `default-index`（当前） | 是           | 是               | 否       | 否                |
| `semantic-recall`       | 否           | 否               | 是       | 是                |

两个分支严格互斥：不得出现 pointer/index 与 Selector/Recall 同时进入同一 Main session 的混合状态。
切换只改变 Core 内部常量，不新增 Settings、配置 schema、runtime preference、协议字段、环境变量或
测试 setter。Extraction、Dream handler、foreground 写入、Custom Agent Memory 与 app-global
Memory 总开关在两个 retrieval 分支中保持不变。

以下 5.1-5.4 描述 `semantic-recall` 分支的冻结行为；实现保留并持续接受 focused tests，当前
`default-index` active path 不执行这些 provider 请求。

### 5.1 Manifest

每个 session 的 Recall state 只保存在内存中。首次合格 query：

1. 从 project Memory root 递归扫描严格小写 `.md`。
2. 排除 basename 精确为 `MEMORY.md`。
3. 不跟随目录 symlink；普通文件 symlink 沿用 Node 文件读取行为。
4. 每个候选只读前 30 行。
5. 无 frontmatter 的普通 Markdown 和 YAML frontmatter 解析失败的 Markdown 都作为无
   metadata 候选进入 manifest；不增加额外修复或兜底解析。
6. 按 mtime 降序排序，最多保留 200 个文件。

非空 manifest 和 selector conversation 对当前 session sticky；扫描结果为空时不缓存，下一次
合格 query 重新扫描。不得增加 manifest service、持久 cache 或 filesystem observer。

### 5.2 Selector request

query 使用最新一条非 meta user message。显式标记为 `real_user` 的消息以 metadata 为准，即使
正文以字面量 `<system-reminder>` 开头也不是 meta；只有缺少 metadata 的旧历史才沿用现有文本
标记识别。先选定最新非 meta user message，再检查其 query 是否合格，不因它为空或只有一个词
而回退到更早消息。trim 后为空或不包含任何空白字符时不启动 Recall。

Selector 使用 Lite model role、`max_tokens=256`、冻结的 system prompt、manifest conversation、
cache-control 和以下 structured output：

```json
{
  "type": "object",
  "properties": {
    "selected_memories": {
      "type": "array",
      "items": { "type": "string" }
    },
    "selected_knowledge_ids": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": ["selected_memories"],
  "additionalProperties": false
}
```

ZCode 本轮没有 knowledge-index producer；可选字段仅保持 provider contract，返回值不产生额外
能力。每次真实 provider attempt 前刷新 runtime headers。error、abort、非 text、无效 JSON 或
schema 不匹配均产生空选择；不重试，不加 Memory-local timeout，不做关键词 fallback。

### 5.3 读取与注入

Selector 结果处理顺序固定：

1. 保留模型返回顺序和重复项。
2. 过滤 manifest 不存在的文件。
3. 使用消费开始前的 read-state 快照过滤已由工具读取或已 Recall 的路径。
4. 截取前 5 项。

因此同一结果批次中的重复选择可以保留，后续 Recall 才会把这些路径视为已读取。
读取失败发生在 5 项截断之后，不用第 6 项回填。若 sticky manifest 中的路径已全部 Recall，
则不再发送 selector 请求；仅被 Read、尚未 Recall 的路径不触发这个请求前短路。

读取正文时：

- 保留 frontmatter 和正文原文。
- 去除文件开头 BOM，将 CRLF 规范化为 LF。
- 最多保留前 200 个完整逻辑行或前 4096 个规范化 UTF-8 bytes。
- 两个限制同时触发时 byte 原因优先；只保留完整行并追加冻结的 exact truncation suffix。
- stale 天数按 `floor((now - mtime) / 24h)` 计算；仅在天数大于 1 时追加冻结的 warning，
  因而首次提示发生在满 48 小时并显示 `2 days`。

在最终 surviving memories 被注入 `relevant_memory` 前，同一消费边界将其写入现有
`readFileState`：`content` 使用实际注入内容（包含截断 suffix），`timestamp/mtimeMs` 使用
manifest mtime，`offset` 为 `undefined`，仅截断内容设置 `limit=实际保留行数`，并保持
`isPartialView=false`。ZCode 同时携带现有 Write/Edit freshness 所需的 `sizeBytes` 与可用的
`revisionId`；不伪造 Read tool event、`sourceTool` 或额外 attachment。prefetch 阶段和被最终
过滤掉的候选不得写入 read-state。

选中的内容聚合为一个现有 `relevant_memory` attachment，最终通过一个 mid-conversation
system block 注入。固定 prefix 只出现一次；累计 recalled content 按 JavaScript string length
计数，包含正文截断 suffix，但不包含 header、stale warning 或 attachment wrapper。达到或超过
61,440 字符后不再启动新的 Recall；当前批次可以整体越过上限，不按剩余字符二次截断。

### 5.4 异步时序

```text
user turn
  |
  +---- first Main request ------------------------------+
  |                                                      |
  `---- Recall selector prefetch（同一 abort，不能阻塞） |
                                                         v
                                              assistant tool_use
                                                         |
                                            完整真实 tool-result batch
                                                         |
                                      queued input/runtime command 先 drain
                                                         |
                            selector settled ? consume once : 本批不等待
                                                         |
                                           relevant_memory MCS
                                                         |
                                                下一次模型请求
```

- 没有后续完整真实 tool-result batch 时，不消费 prefetch。
- selector 尚未完成时不等待；完成结果只在未来符合条件的边界消费。
- 同一次模型 retry 不重复消费。
- compact 和 resume 清空 manifest conversation、prefetch、recalled path 与字符计数。

## 6. Background Extraction

Extraction 只在 `memory.extractionEnabled !== false`、成功、无 child `agentId` 的
Main-equivalent turn 后 fire-and-forget。默认前台答复不等待它。

SSH/WSL/Docker 等 remote workspace 同样提取。remote CLI 运行在远端机器上，是执行 agent loop
的一侧，不是只做展示和转发的瘦客户端；Extraction 与 Main turn 共用该 Runtime 的 model、
fileSystemPort 与 sessionStore，结果写入远端的 Project Memory root。是否运行只由该设备的
`memoryEnabled` 与上面的条件决定，见 `docs/remote/memory-settings.md`。

默认 headless gate 必须早于 enabled-root 解析与 snapshot acquisition：

```text
-p / --prompt ─┐
--target ─────┴─> runPrompt
                    |
                    `-- memory.extractionEnabled=false
                                  |
                    successful Main turn
                                  |
                    scheduleProjectMemoryExtraction
                                  `-- return before root/snapshot/provider/file work

TUI / app-server ─────> 未设置 extractionEnabled（按启用处理）
```

因此未指定 `--memory-bench` 的 headless Main provider request 仍保留当前 active retrieval branch 的 Memory 内容，但 turn 完成后
不得读取 Extraction snapshot、创建 scheduler、发起 Extraction provider request、推进 Extraction
cursor 或修改 Project Memory 文件。headless 退出继续复用正常 `app.close()` 取消语义，不增加进程退出前
等待后台 Extraction 的专用 drain；正确路径下本来就不存在待关闭的 Extraction work。

headless E2E 按请求类别冻结该边界：恰好一个 Main、零个 Extraction。`semantic-recall` 的 Selector
prefetch 仍允许启动，但直接回答完成时尚未消费的 prefetch 会被 turn lifecycle 取消，因此该场景不以
Selector 是否到达 provider 反推 Extraction gate；Selector 的精确 provider 合同由 MEM07 的确定性
tool-continuation 场景负责。

**CLI Memory benchmark 等待边界**

`zcode -p "记住这项约定" --memory-bench` 显式为本次 Runtime 开启自动 Extraction，并在正常退出前
等待已调度的 running/latest-pending 工作全部结束。首版仅接受 `-p/--prompt`，不接受单独使用、
`--target`、TUI 或 app-server/agent-server。flag 不持久化，不覆盖 `memory.enabled/use`；
Memory 未启用时在提交主请求前报错，避免无提取的运行被误认为 benchmark 已完成。

```text
-p --memory-bench → extractionEnabled=true → 检查有效 Project Memory 配置
  → submitPrompt → successful Main turn → 原 scheduler 调度
  → drainMemoryExtractions(null) → 输出最终 text/JSON/result → app.close() → 退出
等待期间 SIGINT/SIGTERM → 原 shutdown handler → abort Extraction → 有界清理 → 信号退出码
```

CLI 持有本次调用的等待策略，Core scheduler 仍是 running/pending/cursor 的唯一 owner。
`isProjectMemoryEnabled()` 只读复用 Runtime 的有效 root 判定，CLI 不复制配置解析或另读设置。
Runtime 的 `drainMemoryExtractions(timeoutMs)` 保持默认 60 秒有界行为；显式 `null` 表示不设置
drain deadline，等待 scheduler 自然清空。bench 等待在 `app.close()` 及其 6 秒清理 deadline 之外，
不得提前 `beginShutdown()` 或解除信号处理器；取消仍可中断等待中的模型或工具并触发清理。

等待表示工作已结束，不保证发生写入或提取成功。原 eligibility、direct-write skip、5-turn 上限、
error/abort cursor 规则保持；provider/工具失败仍按现有后台 Extraction 日志记录，不新增结果字段或
改变主请求的成功退出码。`stream-json` 的主轮事件实时输出，最终 `result` 在 drain 后输出。
主请求失败直接进入原清理路径。resume/continue 只复用已有会话历史，不保存 bench flag。

普通 `-p`、`--target`、TUI、Desktop/app-server 和手机远控均保持原行为；不修改共享 session close
的先取消后 drain 顺序、workspace identity、desktop-continuous 或 web-remote-replayable 边界。

验证：CLI 参数/配置/输出/信号单测；Core 无 deadline drain、pending 和取消测试；真实 CLI 子进程
配合受控 provider，证明主请求已完成且 Extraction 响应被阻塞时进程仍存活，释放响应并落盘后才退出。
同时覆盖默认 headless 无 Extraction、Memory 关闭的前置失败与 session close 取消回归。

```text
successful Main turn
  |
  v
running 为空 ------------------------> 立即执行
running 非空 ------------------------> 覆盖 latest pending
                                          |
                          current 完成 ----+
                                          v
                                   只运行最新 pending
```

只有一个 running slot 和一个 latest-pending slot；不建立 FIFO、job table 或持久任务恢复。
successful Main turn 的调度边界立即冻结同一逻辑快照：provider entries 用于后台模型请求，
durable messages 用于 eligibility、message count 和 cursor。message count 只数对话消息：隐藏提醒记录（`isHiddenReminderMessage`，见 meta-user-context.md）不计入，中断标记计入。由于 ZCode provider entries 不携带
durable UUID，调度时立即发起 messages 与当时 branch metadata 的读取，并用现有 active-branch
selector 形成 durable 表示；再按 successful-turn boundary 截断。scheduler 只接收该已启动的
snapshot promise，不保存未来才读取 SessionStore 的 factory。

pending/running 真正消费时不得重新查询 SessionStore 或当前 revert。调度后发生 Rewind 不取消、
不改写已经冻结的 Extraction；Rewind 后的新 successful turn 冻结自己的新 active snapshot。
boundary 缺失属于 snapshot acquisition error：不请求模型、不推进 cursor、不重试。不得增加
branch generation、Rewind cancellation 或持久 snapshot。

Extraction cursor 是内存中的 durable history message UUID：

- 本段 history 出现 project Memory Write/Edit 时跳过模型并推进 cursor；不依赖 tool result
  是否成功，也不要求目标文件以 `.md` 结尾。
- 没有任一独立的、非 meta、至少 3 words 的 user text block 时跳过并推进 cursor；数组中的
  text block 分别判断，不能先拼接。
- cursor 丢失时 prose 检查回扫完整 history；direct-write 检查不把 cursor 前的历史重新算入。
- success、no-op 和上述 skip 推进 cursor；error 或 abort 不推进。

Extraction request 继承完整 Main context 和当前真实 tool catalog，并追加冻结的 extraction
prompt。独立 executor clone Main 当时的 read-file state，但不共享可变 Map。provider-visible
tools 不因受限执行策略被裁剪。工具在执行前按以下窄策略判断：

- 先在当前 provider tool catalog 中查找工具；未注册工具（包括空名称）使用原 call id 返回
  `<tool_use_error>Error: No such tool available: <RAW_TOOL_NAME></tool_use_error>`，不进入
  Memory 权限策略，也不执行工具。
- 仅允许当前实际注册的 `Read`、`Grep`、`Glob`；不为 Memory 补注册缺失工具。
- 允许 read-only Bash。
- 允许 project Memory root 内、不包含既有敏感 path segment 的 `.md` Write/Edit。
- 允许 project Memory root 内、非递归、无 glob/redirect/env 的 `rm` `.md`。
- 拒绝 MCP、Agent、网络访问和 workspace mutation。

拒绝结果会作为 tool result 进入下一轮 Memory Agent provider request，因此文本也是冻结合同：

- Bash 拒绝：`Only read-only shell commands and rm with all paths inside <MEMORY_ROOT> are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`。
- 其他已注册工具拒绝：`only Read, Grep, Glob, read-only Bash, and Edit/Write within <MEMORY_ROOT> are allowed`。

此策略不补注册 Read 或其他缺失工具。Extraction 最多执行 5 个 model turns；第 5 次响应中的
tool calls 仍执行，但不再发起第 6 次模型请求。每次 provider attempt 前刷新 runtime headers。
失败不重试。

Memory Agent（Extraction 与 Dream）不另写一份"工具结果 → 下一次请求"的语义，与 Main 共用单步内核：

```text
entries ── 渲染（Main 同一个渲染器）──> 请求 ──> 模型 ──> 调度执行（Main 同一套调度）──> 结算（Main 同一个函数）──┐
   ^                                                                                                          │
   └──────────────────────────────── 追加 assistant、tool result、批次附件 ─────────────────────────────────────┘
```

- 循环维护 entries：初始是 Main 的 provider entries 加 prompt，之后追加 assistant entry 和这批工具的
  entries。每轮都用 Main 的渲染器从 entries 生成请求（MCS、并入 tool_result、ToolSearch 暴露、
  cache control），所以 Memory 请求的形态与 Main 相同；第一轮请求与原来逐字节相同。
- 允许的 tool call 按 Main 的调度执行：`concurrentSafe` 的并行，Write/Edit 等按顺序执行。
  被策略拒绝的 call 不进入调度，直接写拒绝结果。
- 一批工具结果由 Main 的同一个函数生成 entries：每个结果一条 tool result，之后是工具 Hook 上下文和
  工具声明的批次提示（例如 Read 部分视图的 `read_truncation_notice`）。Memory 的 executor 不配置
  hooks，所以实际只有批次提示。
- Memory 不持久化、不发事件，也不运行 Main 的编排（公告、compaction、steer、Stop hook）。

prompt 的 no-op 响应逐字为 `Nothing to save.`。scheduler 不解析该文本来推导额外状态。

ZCode 关闭单个 session 后 app-server 仍继续承载其他 session，session close 不等于进程退出，
不能只在进程即将退出时 drain Extraction。因此 session close 必须先终止该 runtime 的 Extraction 生命周期，再释放 session 资源：

```text
session close
  |
  v
beginShutdown
  |- 拒绝后续 schedule
  |- 丢弃 latest pending
  `- abort 当前 running Extraction
            |
            v
bounded drain 等待取消收口
            |
            v
关闭 browser / execution / MCP / session store
```

- 同一 abort signal 贯穿 snapshot acquisition、manifest 扫描、Memory Agent loop、模型请求和
  tool executor；不得在 close 后启动下一轮模型请求或执行新的 Memory tool。
- abort 不推进 Extraction cursor；正常运行时的 one-running + latest-pending、成功/no-op/skip
  cursor 语义不变。
- drain 的 60 秒只保留为非协作 I/O 的关闭上界，不是 close 前允许后台模型继续运行的宽限期；
  已在飞的 provider 请求可能已经产生用量，但其迟到结果必须丢弃，不能继续 tool 或后续模型轮次。
- 不增加通用后台任务取消框架、持久恢复、retry 或新的协议/UI 状态。

## 7. Dream 与 `memory_update`

### 7.1 触发

- 当前产品链路不自动触发 Dream，成功 Main turn 只调度 Extraction。builtin command registry
  没有 `/dream`，ZCode CLI、Desktop、mobile 和 shared protocol 也不新增命令入口。
- Dream handler、lock、prompt、受限执行和 `memory_update` 保留，等待产品侧确定 project
  transcript 隔离形态后再接入触发点；本轮不增加临时入口或替代命令。
- handler 内保留 gate 语义：每 10 分钟最多扫描一次；距上次成功 Dream 至少
  24 小时；当前 project 至少有 5 个排除当前 session、实际 transcript 文件 mtime 晚于上次
  consolidation 的 Main-equivalent sessions。
- gate 和 prompt 使用同一组实际 transcript session id，不使用 SessionStore `updated` 时间替代
  transcript mtime。
- handler 在 remote workspace 直接返回。remote 判定由 bootstrap 通过语义化 runtime dependency
  注入，并在调用时读取当前 `workspaceIdentity`；core 不复制 remote identity 解析规则，resume 后
  也不沿用启动时快照。

project session 归属由 SessionStore 的 workspace identity 判断。model-io writer 与 Dream 使用
同一个从 `storage.dir` 派生的 `modelIoDir`（development 为 `debug`，其他环境为 `rollout`）；
Dream 只引用已选 durable sessions 对应的现有 transcript/model-io，不建设第二套 transcript DB，
也不 fallback 扫描固定的 `~/.zcode/cli/debug|rollout`。当前 `modelIoDir` 仍是 ZCode 产品级目录，
因此在 project transcript 隔离方案确定前不得把 handler 接回自动 turn 链路。

### 7.2 Lock 与运行

```text
Dream handler gate
  |
  v
read <memoryRoot>/.consolidate-lock
  +-- mtime < 1h 且 PID 存活 --------------------------> skip
  `-- 可接管
        |
        | write current PID + read-back ownership
        v
full Main context + real tools + exact Dream prompt
        |
        | restricted execution policy，最多 50 turns
        v
success ------------------------------------> 保留新 lock mtime
error/abort ---------------------------> 首次 lock 删除；旧 lock 恢复空内容和原 mtime
```

Dream 复用 Extraction 的执行策略，最大 50 个 model turns；第 50 次响应中的 tool calls 仍执行。
prompt 固定执行 orient、signal、consolidate、prune/index 四个阶段，并要求最终 `MEMORY.md`
低于 200 行、约 25KB。Runtime 不根据 prompt 再实现 duplicate detector、自动 rebuild、snapshot
或文件 rollback。

Dream 唯一允许的 mutation observer 只记录本次 Dream tool-use 中的 Memory Write/Edit 和窄
`rm` 目标路径。记录发生在 tool-use 进入执行边界时，因此不以执行结果成功为条件；它不扩展到
foreground、Extraction 或通用 shell 分析。

### 7.3 `memory_update`

Dream 的 `filesTouched` 非空时追加一条 pending update：

```text
Dream filesTouched
  |
  v
pending memory_update
  |
  v
next Main attachment collection
  +-- consume and clear once
  +-- invalidate matching Recall/read-state path
  `-- emit exact provider-visible memory_update MCS
```

只有 Dream 产生 `memory_update`。foreground 写入和 Extraction 不产生该 attachment。即使承载
update 的下一次 provider 请求失败，也不重新注入。

## 8. Custom Agent Persistent Memory

`AgentProfile.memory` 是严格枚举：

```ts
type AgentMemoryScope = "user" | "project" | "local";
```

YAML 解析后的值必须精确匹配，不 trim、不 coerce。非法值记录 profile diagnostic，并忽略
Memory 字段；profile 的其他字段继续有效。

agent key 只用不带 Unicode flag 的 `/[^a-zA-Z0-9_-]/g` 将每个不匹配的 UTF-16 code unit
替换为 `-`，不做额外 slug 规则；空结果为 `unknown`。scope 路径：

| scope     | ZCode root                                           |
| --------- | ---------------------------------------------------- |
| `user`    | `<storage.dir>/agent-memory/<agent-key>/`            |
| `project` | `<workspace>/.zcode/agent-memory/<agent-key>/`       |
| `local`   | `<workspace>/.zcode/agent-memory-local/<agent-key>/` |

project/local root 在 child 实际启动时按该次 workspace 解析，不能固定为 app 启动 cwd。
Main Agent Memory、Recall、Extraction 和 Dream 不共享这些目录。

Memory 生效时，child system block 注入冻结的 `# Persistent Agent Memory` prompt 和对应 scope
suffix。读取该 root 的 `MEMORY.md`：

- 文件不存在或为空时使用冻结的 exact empty text。
- 非空时最多前 200 行或 25,000 个 JavaScript 字符，使用冻结的 truncation warning。

profile 显式声明 `tools` 时，在保持原顺序的基础上依次补入缺失的 Write、Edit，再应用
profile 自身的 `disallowedTools`。不得补 Read，不应用 global disallowedTools。`tools` 未定义时
不改写默认工具集合。

`features.memory=false` 或 `use=false` 时不创建 custom root、不注入 prompt、不补工具。
不支持 private/team scope。

## 9. Provider-visible 合同

以下内容必须以语义命名 fixture 冻结，并在 Anthropic Messages 最终请求上逐字验收：

- `main-memory-default-index.md`
- `main-memory-semantic-recall.md`
- `main-memory-index.md`
- `selector-request.json`
- `recalled-memory.md`
- `extraction-prompt.md`
- `dream-prompt.md`
- `memory-update.md`
- `custom-agent-memory.md` 与 `custom-agent-scope-guidance.json`

fixture metadata 至少记录 provider route、模型、beta 和采样时间。
测试只允许归一化 root、cwd、session id、PID、mtime 和当前时间等运行值；Memory 文案、role、
message/block 顺序、cache-control、schema、max tokens 与 tool projection 不得模糊比较。

语义 fixture 是 provider-visible 文本的唯一 golden。原始 trajectory 只作为来源证明，不在测试中
再定义第二份预期文本；Core、adapter、CLI E2E 和 WDIO 必须消费同一 fixture，并且只分别证明
generator、最终 wire、Runtime 组合和跨进程链路。

验收证据分两层组合，不新增生产 capture 逻辑：Core runtime 测试冻结实现实际生成的
`ModelTextRequest`；adapter 测试使用真实 `AiSdkModelAdapter` 与本地 Anthropic Messages
endpoint 捕获最终 HTTP body。Main/selector 另保留一次真实网络 trace。任何一层的文本、role、
顺序、cache-control、MCS beta、schema 或工具投影漂移都会使测试失败。

Memory 域内部源码、类型、fixture helper 和测试名使用 ZCode 语义命名，不能以外部产品名或
具体模型名命名。provider adapter 测试和 provider-visible 契约 fixture 可以使用真实的 provider
与 model 值，但不得据此命名 Memory 内部类型、变量、函数或 helper。模型 port 的最小扩展为：

```ts
interface ModelTextRequest {
  responseJsonSchema?: JsonSchema;
}

interface AgentProfile {
  memory?: "user" | "project" | "local";
}

interface CreateModelAdapterOptions {
  modelIoDir?: string;
}
```

`responseJsonSchema` 仅作用于非流式 `generateText`；adapter 将 provider object output 还原为既有
text result。Anthropic transport 收到显式 schema 时使用 native `output_config.format`，避免 Lite
模型 ID 未命中 SDK 静态能力表后退化为 JSON tool；selector 在现有 compatibility fetch 边界恢复
SDK 合并掉的 manifest/query 两条 user message。前者只命中非流式显式 schema，后者只命中
selector 的精确 schema 和文本边界；普通 generate 与 stream request 不变。不得修改
`@zcode/protocol`。

以下已知 dynamic system prompt 差异只登记，不在本功能中修改：

- 缺少 `Additional working directories: <WORKSPACE>`。
- OS 行为 `darwin 24.3.0 arm64`，基线为 `Darwin 24.3.0`。
- 当前模型描述行与基线模型描述行不同。
- 缺少 `Assistant knowledge cutoff is January 2026.`。

ZCode 当前没有的工具也属于明确的 tool-inventory 差异；不得为了让 golden 相同而新增 Read 或
其他工具。除这些明确差异和动态值之外，Memory provider-visible 内容必须一致。

## 10. 验收

必须覆盖：

| 范围                   | 场景                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Config/root            | Settings 默认/持久化；新建/cold resume 重读；active/child 继承；enabled/use；local/remote identity；resume 重算；旧 root 不读取；mkdir failure                                                                                                                                                                         |
| Retrieval branch       | `false -> default-index`、`true -> semantic-recall`；pointer/index 与 Selector/Recall 两组互斥；原始 boolean 只定义一次                                                                                                                                                                                                |
| Main prompt/index      | 两种 Main prompt exact fixture；default 分支非空 `MEMORY.md` 的 exact request user-context source；任意非空 instruction source（包括 `MEMORY.md`）使 `context_prefix` 渲染一次指令 preamble；leading frontmatter/顶层 HTML comment 清理；缺失/空/不可读不注入；semantic 分支在读取前跳过；200 行/25,000 字符截断；磁盘原文 read-state 与 partial 标记；运行中不刷新、冷恢复与 compaction 后变化时追加增量（已发公告不改写）、新 session 重读；四种 Main task；三种 child 排除 |
| Permission/file write  | root containment；小写 `.md`；敏感 segment；Write/Edit allow/deny；缺失 originSessionId 时同时补入 `node_type: memory`，已有非空 origin 的文件原样保留；Bash 不变                                                                                                                                                      |
| Recall default branch  | 保留 pointer/index；Main turn 不扫描、不发 Selector、不注入 `relevant_memory`                                                                                                                                                                                                                                          |
| Recall semantic branch | 无 pointer/index；branch-aware lifecycle 覆盖 prefetch、完整 tool batch 后 consume、recursive scan、selector schema、order/duplicate、正文限制、stale 与 61,440 gate；不增加 Runtime override                                                                                                                          |
| Extraction             | success/error/abort；direct write；独立 3-word block；cursor；同边界 snapshot；Rewind 后不取消；running+latest；第 5 turn；header refresh；session close 拒绝新调度、丢弃 pending、abort running 并有界 drain；remote workspace 照常调度                                                                                                       |
| Headless Extraction    | `-p/--prompt` 与 `--target` 注入内部 `extractionEnabled=false`；Main prompt/index/Recall 保持；不读取 Extraction snapshot、不创建 scheduler、不发 Extraction 请求、不推进 cursor、不写 Memory 文件；TUI/app-server 默认行为不变                                                                                      |
| Dream                  | 无 active trigger；handler 的 24h/5 transcript mtimes/10m gate；lock；第 50 turn；filesTouched；one-shot memory_update；`/dream` 为 Unknown command                                                                                                                                                                    |
| Custom agent           | exact enum；三 scope；agent key；empty/truncated index；Write/Edit augmentation；Read intentional diff；disallowedTools                                                                                                                                                                                                |
| Settings viewer        | 默认关闭不发 catalog 请求；Desktop 本地 profile catalog；空目录过滤；稳定排序；symlink/traversal 拒绝；workspace 切换；虚拟 `MEMORY.md` 父节点；缺失 index；原始正文；5 MiB 单文件预览上限；英文事实数量单复数；显式刷新；查看不发模型请求、不写文件；Web Remote / Mobile 只展示本地查看提示且 catalog 零调用                                                                  |
| 上下游                 | generateText structured output；stream 不变；Settings 只经 runtime-preference 布尔值进入 Agent；viewer 仅经 Desktop 本地 Host Memory service 读取本地磁盘；desktop continuous/mobile replayable 不传 Memory 正文；remote 照常调度 Extraction，Dream handler 跳过                                                                              |

每个实现 Phase 必须先更新本文或对应 fixture，再补失败测试、实现最小行为、运行聚焦测试并做
scope review。最终必须执行 CLI workspace typecheck/lint、仓库级 `pnpm typecheck`、`pnpm lint`
和 `git diff --check`。

### 10.1 E2E 与 trajectory 验收边界

Memory 的端到端验收使用隔离的临时 workspace、临时 storage 和本地 scripted provider，必须从
真实 `createZCodeApp` 入口运行并保存 provider request trajectory。E2E 不替代本节上表中的
focused tests；它证明这些规则已经在真实 Runtime 链路中正确组合。

正式 E2E 必须覆盖：

1. Main Memory prompt 出现在每个 Memory-enabled Main provider request，并保留默认分支的
   `MEMORY.md` pointer 文案；session 初始化时非空 `MEMORY.md` 还会以 exact request
   user-context source 进入开头的 `context_prefix` 公告，之后不改写（冷恢复与 compaction 后内容变化时追加增量公告）。该非空
   source 自身即使没有 AGENTS.md，也会使 `context_prefix` 渲染一次指令 preamble。
2. Memory-enabled Main turn 不发 Selector provider request，也不注入 `relevant_memory`；索引消费
   不依赖 Selector。
3. 后续无 direct Memory write 的成功 Main turn 会 fire-and-forget Extraction；正常完成证据在测试中
   显式 drain 后观察 trajectory 和实际 Memory 文件，不能再借 session close 等待它完成。
4. Extraction 新写入的事实包含固定 `metadata.node_type: memory` 并保留原
   `metadata.originSessionId`，同时按 Main prompt 更新
   `MEMORY.md` pointer；后续新 session 直接从默认分支的 request user-context source 消费该 pointer，
   且不为它发起 Selector 请求。同一个已初始化 session 不热重载索引。
5. 声明 persistent Memory 的 custom agent 获得对应 prompt、Write/Edit 投影和独立 root；
   child 写入同样补齐 `node_type: memory` 与 `originSessionId`。
6. 在 Settings 关闭 Memory 后，当前 Session 保持原值；新建 Session 的 provider
   request 不含 Main/custom Memory prompt，不发 selector/Extraction 请求，也不创建
   project/custom Memory root。重新开启后再新建 Session 恢复 Memory，无需热更新已有
   Runtime。
7. 当 Extraction provider request 已开始但尚未返回时关闭 session：close 在短预算内完成，
   running request 收到 abort，latest pending 被丢弃，迟到的 tool-use 响应不能写文件或触发
   下一轮模型请求；close 后完成的 Main turn也不能再调度 Extraction。
8. Settings 的 Memory 模块在 Desktop 开关关闭时不读取 catalog；开启后从隔离 profile 展示两个
   本地 workspace、虚拟 `MEMORY.md` 父节点与原始 Markdown，手动刷新后反映新增文件，关闭后
   文件仍保留。Web Remote / Mobile 只展示开关和本地桌面端查看提示，不调用 catalog。仅执行
   查看动作时 provider request 数量必须保持不变。
9. headless Runtime 在 Memory enabled 且已有非空 `MEMORY.md` 时，Main request 仍满足当前 active
   retrieval branch 的 provider-visible 合同；显式 drain 后 trajectory 中没有 Extraction request，
   Project Memory 文件保持不变。CLI unit test 分别证明 `-p/--prompt` 与 `--target` 都注入 gate，TUI
   不注入；断言按 `main` / `extraction` 类别表达，不把允许异步启动或取消的 Selector 计入固定场景
   总数。该 case 不复制 Desktop/手机窗口测试。

每次运行输出原始 provider capture、按 `main | extraction | custom_agent` 分类的
trajectory、文件结果和断言摘要。断言使用稳定文本 marker 和真实请求字段，不以 sleep、请求
序号或模型自然语言判断链路。

以下组合不扩展为新的黑盒 E2E：

- Dream 当前没有产品触发入口；继续由 handler/runtime integration test 覆盖 gate、lock、50-turn、
  filesTouched 和 one-shot `memory_update`，由 adapter test 覆盖最终 provider body。不得为测试
  新增 `/dream`、auto Dream 或内部协议入口。
- 三种 custom-agent scope、task type、root/symlink/截断/并发/错误的完整等价类继续由 focused
  tests 覆盖；E2E 只选择一条代表路径证明真实组合。
- Anthropic Messages 的逐字段 wire contract 继续由本地 Messages endpoint adapter test 覆盖；
  deterministic Runtime E2E 使用本地 provider，不依赖真实网络或线上模型可用性。
- Desktop Settings 新增本地只读 Memory viewer，但不新增 Agent 协议字段；Web Remote / Mobile
  只保留开关与本地查看提示，不扩展文件 viewer 或远端 Host 聚合。Desktop 仍保留一条 Electron WDIO 组合测试，从真实
  composer 发消息，并用 provider capture、CLI Memory 文件和 timeline 终态联合证明既有跨进程
  链路没有截断 Memory；viewer 另用无 provider request 的 Settings case 证明只读投影：

```text
Electron composer
      |
      v
Renderer -> Host -> stdio -> CLI Runtime -> Main provider request
                              |
                              +----------> Extraction -> Memory file
```

这条 WDIO 只验证跨进程组合，不把 Memory 正文或后台状态下沉到 Renderer/Host，也不重复
focused tests 的全部边界排列。session close 取消属于 CLI Runtime 生命周期，并且没有可观察的
Memory UI 状态；使用真实 `createZCodeApp`、阻塞的本地 provider 和实际 `app.close()` 的 headless
E2E 覆盖，不再复制一条只能间接推断取消结果的 WDIO case。

## 11. 明确非目标

本轮不实现：

- 自定义 `memory.rootDir`，以及旧 MVP 数据迁移、删除或双读。
- `memory.write`、read-only Memory 或 capability status。
- Read 工具补齐或 Read 特殊授权。
- CLI/Desktop/mobile `/dream`、`/memory` 命令或 Agent Memory 正文/后台状态协议。
- 公开 `--no-memory` flag、完整关闭 Main Memory/Recall/custom-agent Memory，或远端重新开启
  headless Extraction 的 rollout gate。
- Settings viewer 中的编辑、删除、搜索、导出、打开目录、远端 Host 聚合、custom-agent Memory
  或外部 `storage.dir` 发现。
- 自动 Dream trigger、`memory.autoDream` 配置或临时替代入口。
- `/memory list/show/status/doctor/open` 等替代命令。
- 关键词 Recall fallback、selector timeout 或通用 retry。
- foreground mutation observer、secret/PII scanner、prompt-injection classifier。
- Repository、manifest cache service、jobs.sqlite 或持久 cursor。
- transaction、snapshot、rollback、CAS、lease 或通用 budget framework。
- private/team scope、同步、冲突合并、provenance 或 distillation。
- 新 telemetry、SLO 或灰度体系。
- 四项非 Memory dynamic system prompt 差异。
