# Git Worktree 任务（第一版）

更新日期：2026-11-04
状态：已按"worktree 只是会话 cwd"在 `feat/managed-worktree` 实现；旧模型（每个 worktree 一个 workspace）的实现已按 §14 推翻。2026-11-04 评审后补充：目录概念与命名（§2.1）、fork 带入未提交改动（§3.6）、删除租约（§8.3）。桌面 E2E 处于 manual-review 待评审（§12）。

## 1. 文档定位

本文定义第一版 worktree 功能的产品行为、职责划分、数据源、时序和验收场景。实现以本文为准；实现完成后把本文更新为当前事实，不另写总结文档。

第一版只做三件事：

1. 新建任务时，选择在一个新的 worktree 中运行。
2. fork 任务时，选择把子任务放到一个新的 worktree 中。
3. 管理 ZCode 创建的 worktree：查看、打开、删除。

### 1.1 核心模型

**worktree 不是一个新的 workspace，它只是会话的 cwd。** workspace key、CLI 进程、标签页、草稿和 sessions-index 都属于原项目。

```text
项目 workspace（workspace key = 项目主目录）
 └─ 1 个项目 CLI 进程
     ├─ 会话 A  cwd = 项目主目录
     ├─ 会话 B  cwd = <受管根>/1298/z-code   ← worktree 任务
     └─ 会话 C  cwd = <受管根>/3f2a/z-code   ← fork 到 worktree 的子任务
侧栏、标签页、草稿、sessions-index：都在项目下
```

### 1.2 不做

| 不做                                                          | 说明                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 任务在本地与 worktree 之间迁移                                | 任务 cwd 创建后固定                                                     |
| 在已有 worktree 中新建任务                                    | 只有 fork 选择"在当前 worktree 中分叉"时，子任务会共用父任务的 worktree |
| 新建任务时带入未提交改动                                      | 新建任务从所选分支检出干净的 worktree；fork 会带入（§3.6）              |
| setup / cleanup 脚本；依赖目录（如 `node_modules`）的特殊处理 | 依赖需要用户在 worktree 中自行安装；被忽略文件只按 §3.4 的清单拷贝      |
| 自动清理、删除前快照、恢复                                    | 只支持手动删除                                                          |
| worktree 设置页、自定义根目录                                 | 根目录固定，见 §6.3                                                     |
| 创建中的记录写盘、重启后恢复                                  | 创建中的记录只在 Host 内存中，见 §3.9                                   |
| 模型可调用的 worktree 工具、workflow 隔离                     | 职责已按 §5 预留端口；workflow 的 `isolation: "worktree"` 继续报未实现  |
| 远程项目（SSH / WSL / Docker）中创建                          | 远程和手机隐藏创建入口；已有的 worktree 任务照常查看和使用              |

## 2. 术语

| 术语          | 含义                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| worktree      | ZCode 在受管根目录下创建的 Git linked worktree                            |
| 源仓库        | 创建 worktree 时所在的主 checkout，即项目 root 对应的 Git 仓库            |
| bucket        | 受管根目录下的一级随机目录，一个 bucket 只放一个 worktree                 |
| worktree 任务 | `root_path`（cwd）位于某个 worktree 内的任务；它的 workspace key 是项目的 |
| 创建记录      | Host 内存中的一条记录，描述一次正在进行的 worktree 创建（§6.2）           |

### 2.1 目录概念与命名

普通任务的归属 workspace 与 cwd 是同一个目录，所以过去两者混用不出错。worktree 任务让它们分开。以项目 roots = `/repo`（主目录）+ `/docs`、任务运行在 worktree 中为例：

| 概念           | 例子中的值                  | 唯一数据源                                    | 只给谁用                                                      |
| -------------- | --------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| 归属 workspace | `/repo`                     | `tasks.workspace_key` / `workspace_path`      | 选 CLI 进程；标签页、草稿、store、远控、sessions-index 的 key |
| cwd            | `<受管根>/3f2a/repo`        | `tasks.root_path`（创建后不变）               | 文件树、Git 面板、终端、编辑器、Agent 工作目录                |
| 附加目录       | `[/docs]`                   | `tasks.execution_directories`                 | Agent 额外可访问的目录                                        |
| 配置来源目录   | `/repo`（cwd 映射回源仓库） | 不存储，每次由 cwd 经 resolver 映射（§6.6.3） | Hook Trust、权限、记忆、CLI project id                        |

规则：

- 名字带 `workspace` 的字段只表示归属，只用来选进程和建 key，不当目录使用。
- 真实目录只有 `cwd`（一个）和附加目录（0..n）。Host 与 renderer 中表示执行目录的字段统一叫 `cwd`。
- 两者的对应只能经 tasks-index 的同一行得到，不能从一方推算另一方。
- 按会话发给 CLI 的操作（发命令、关闭会话、彻底删除会话数据）按归属 workspace 选进程，不能按 cwd 选。
- 例外：CLI 内部的 `ZCodeWorkspaceRef` 沿用既有语义：`workspaceKey` 是身份，`workspacePath` 是该会话的执行目录（远程会话本来就是 key ≠ path）。CLI 中 100 多处把它当工作目录读取，不改名；跨进程时身份一律取 `workspaceKey`，不能用 `workspaceIdentity || workspacePath` 重新计算（§9.3）。

多目录：项目的其他 root 位于源仓库内时（例如 `/repo/packages/ui`），worktree 任务的附加目录映射为 worktree 中对应的路径（`<wt>/packages/ui`）；起点中没有该目录时不加入。位于其他仓库或非仓库目录的 root 原样保留，写入这些目录不隔离（§4）。

代码中现有的 `gitWorktreeChangeSummary`、`gitWorktreeReviewSourceId` 等名称指的是工作区改动（working tree），和本文的 worktree 无关。新增代码统一使用 `managedWorktree` 命名。

## 3. 产品行为

### 3.1 可用条件

只有同时满足以下条件，才显示 worktree 复选框和"在新 worktree 中分叉"：

- 本地桌面窗口。手机远控和 Web 远控不显示。
- 当前项目的主目录是 Git 仓库。非 Git 项目不显示。
- 项目不是远程项目，草稿已归属某个项目。

仓库包含 submodule 时照常可用；新 worktree 中的子模块不会初始化（§4）。

### 3.2 新建任务：项目、分支、worktree

新建任务的 composer 头部（`draftComposerHeader`）按"项目 → 分支 → 是否隔离"排列，复选框固定贴在最右端：

```text
[📁 z-code ▾]  [⎇ staging ▾]                              [☐ worktree]
[📁 z-code ▾]  [⎇ staging ▾]                              [☑ worktree]
```

| 控件     | ☐ worktree（关）                                  | ☑ worktree（开）                                                                  |
| -------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| 分支胶囊 | 现有的分支切换器：选择即对主目录执行 `git switch` | 只记录新 worktree 从哪个分支检出，不切换主目录；默认是当前 HEAD；分本地、远端两组 |
| 发送     | 和现在一样                                        | 先创建 worktree，再创建会话（§3.3）                                               |

规则：

- 胶囊文字在两种模式下相同，只显示分支名。worktree 开启时，分支下拉底部加一行提示："新 worktree 将从所选分支创建，不切换本地分支"。
- 复选框靠右（`ml-auto`），不跟项目、分支胶囊挤在一起；项目和分支胶囊保持左对齐。
- 三个 hover 胶囊共用同一高度契约：项目胶囊和分支胶囊是 `Button size="default"`（`h-7`），复选框标签也必须是 `h-7`，否则视觉上比另外两个高 4px。
- 复选框每个新任务默认关，不记住上次的选择。
- 复选框状态和所选分支存在 session store 的草稿状态（`draftWorktree`，与 `draftProjectId` 同处，唯一数据源），只属于这个草稿；正文草稿不保存它们，避免输入时被覆盖。
- 首条消息的正文、附件、模型、模式和 plan 随 `createSession.firstInput` 交给 Host。首条消息是 slash 命令时拒绝发送并提示（第一版不支持）。
- 不执行 `git fetch`。远端分支使用本地已有的 remote-tracking ref。
- worktree 模式的草稿不预热会话：会话要等 worktree 建好后才创建，cwd 一次确定。发送前显示的 slash 命令、skills 等是项目主目录的配置。

### 3.3 发送后的创建过程

```text
用户消息气泡                                   ← 立即显示，取自创建记录
┌ 正在创建 worktree ─────────────────── ▾ ┐    ← 进度卡片，可展开 git 输出
│ Preparing worktree (detached HEAD 9e6d2f7) │
│ Updating files: 100% (19783/19783), done.  │
└────────────────────────────────────────────┘
正在思考                                        ← 会话已创建，模型开始运行
```

- 发送后，界面先显示用户消息和进度卡片。这两项都来自 Host 的创建记录，此时会话还不存在。
- 创建成功后，Host 在项目 CLI 中创建会话（cwd = worktree），并发送首条消息。界面从创建记录切换到真实会话。
- **"已创建 worktree"容器保留在会话历史里。** 它作为第一轮的第一项，由 CLI 写入会话历史，可以展开查看 git 输出。桌面、手机远控和重启后看到的都是同一项。
- 侧栏在项目下、真实任务之前显示"创建中"的任务行（来自创建记录），直到会话创建完成；点击后主区展示这条记录。
- 创建期间主区显示创建视图，不显示 composer。会话启动后主区切到真实会话；Host 先发结束事件、再推送记录列表，避免闪出空草稿。
- 切换时真实会话先在创建视图下方挂载；创建视图保留到该会话收到首个快照、时间线出现第一轮后才移除，中间不出现空白。以快照到达为准，不使用超时。
- composer 头部切换复选框时，分支胶囊在两种模式下的外边距相同，头部高度和其他控件位置不变。

### 3.4 创建时拷贝被忽略的文件

`git worktree add` 只检出已跟踪的文件。`.env` 这类被 git 忽略的文件不会出现在新 worktree 中，很多项目因此跑不起来。第一版支持按仓库声明的清单拷贝：

- **触发条件：** 源仓库根目录存在 `.worktreeinclude` 文件（gitignore 语法，一行一个模式）。没有这个文件时不拷贝任何东西。ZCode 没有类似"本地覆盖说明"的约定文件，所以没有默认拷贝清单。
- **拷贝范围：** 同时满足两个条件的文件：被 git 忽略（`git ls-files --others --ignored --exclude-standard`），并且匹配 `.worktreeinclude`（`git ls-files --others --ignored --exclude-from=.worktreeinclude`）。已跟踪的文件由检出提供，不在拷贝范围内。
- **来源：** 始终是源仓库的主 checkout，不是父任务所在的 worktree（fork 时也一样）。
- **拷贝规则：**
  - 保持相对路径，按需创建目录。
  - 只拷贝普通文件；符号链接跳过。
  - 目标路径的任一父目录是符号链接时，判定为失败，防止写到 worktree 之外。
  - 不覆盖已存在的文件。
  - 优先使用写时复制（`COPYFILE_FICLONE`：macOS APFS、Linux btrfs / xfs 等），不支持时退回普通拷贝。
  - 限制并发数（例如 16）。
- **时机：** `git worktree add` 成功之后、创建会话之前，阶段仍为 `creating`。进度卡片和"已创建 worktree"的日志中显示 `Copied N files from .worktreeinclude`。
- **失败：** 任一文件拷贝失败（权限不足、磁盘已满、经过符号链接）时，整个创建失败，错误中写明文件路径；用户修复后可以"重试"。

### 3.5 创建失败

卡片标题变为"worktree 创建失败"，显示原因（按结构化错误码本地化）和 git 输出。提供三个操作：

| 操作            | 行为                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| 重试            | 删除本次残留的 worktree，重新创建                                           |
| 不使用 worktree | 在项目主目录创建会话并发送首条消息，等同于复选框关闭时发送                  |
| 放弃            | 删除残留的 worktree，丢弃创建记录；正文、附件和设置回到项目 composer 草稿中 |

"不使用 worktree"和"放弃"之前，Host 先向项目 CLI 查询最后一次发出的会话命令的结果（`commands/query`，按 commandId）。"会话启动失败"包含两种情况：CLI 明确拒绝，以及结果未知（请求异常、连接中断）。只有 CLI 确认命令没有执行，才继续：

- 命令已执行（会话已存在）：不删除任何东西，按"会话已启动"结束创建记录并打开该任务。
- 命令未执行：先撤销本次预留的任务行，再删除残留的 worktree。撤销有三种结果：已撤销（预留行被删除）；行不存在（从未预留或已撤销过）；行已有 CLI 事实。只有最后一种说明会话已存在，按"会话已启动"处理，不删除 worktree。撤销时一并删除该会话的创建回执，避免回执指向不存在的行。
- 选择"不使用 worktree"后，记录切换为"项目主目录"模式：会话 ID 换成新的，之后的"重试"和"不使用 worktree"都在项目主目录发送；"放弃"撤销的是这个会话 ID 的预留。
- 任何重发（两种模式的"重试"、"不使用 worktree"）之前，同样先向 CLI 查询上一次命令：已执行 → 按"会话已启动"结束；无法确认 → 失败，不删除、不重发；确认没有成功（CLI 没有记录，或记录为 rejected / failed 等终态）→ 撤销旧会话 ID 的预留，换新的会话 ID 与命令 ID 再发送。
  - 换命令 ID：CLI 对已记录为 failed 的同一 commandId 只回放失败，复用旧 ID 会让记录永远无法恢复。
  - 换会话 ID：CLI 的 `createSession` 先建会话记录、再发首条消息；首条消息失败时记录不会被清理（Guarded 除外），failed 不等于"没有创建"。沿用旧会话 ID 重发会报会话已存在。
  - 撤销旧预留时行已有 CLI 事实 → 说明会话已存在，按"会话已启动"结束。
  - worktree 模式下，换 ID 之前先请 CLI 卸载这个 worktree 内的驻留会话（失败留下的草稿），避免它在后续删除时被当作"有任务正在使用"；忙 → 操作失败并提示。卸载请求失败 → 操作失败，提示"无法卸载使用这个 worktree 的任务"，记录保持原来的失败状态。
- 删除残留 worktree 之前（"放弃"、"不使用 worktree"），先请项目 CLI 卸载 cwd 位于该 worktree 内的驻留会话（`session/releaseUnderDirectory`，与 §8.3 相同）。失败留下的草稿会话因此不会驻留在已删除的目录上；任一会话忙 → 不删除，操作失败并提示 worktree 正在使用。卸载请求失败 → 不删除，操作失败并提示"无法卸载使用这个 worktree 的任务"，记录保持原来的失败状态。失败留下的会话没有消息，CLI 不会清理它，这是已知的残留（§4）。
- 无法确认：查询请求失败，或 CLI 返回 `failed` + `fault.command.queryUnavailable`（读取命令记录失败，不表示命令未执行）。操作失败并提示，不删除任何东西，创建记录保持失败状态，可以再试。

### 3.6 fork：选择子任务位置

满足 §3.1 时，assistant 消息动作栏的"分叉"弹出两项菜单。第一项的文字按父任务的 cwd 区分：

| 父任务 cwd    | 第一项                                      | 第二项                                   |
| ------------- | ------------------------------------------- | ---------------------------------------- |
| 项目主目录    | 在当前目录分叉                              | 在新 worktree 中分叉（带上未提交的改动） |
| 某个 worktree | 在当前 worktree 中分叉（共用这个 worktree） | 在新 worktree 中分叉（带上未提交的改动） |

规则：

- 不满足 §3.1 时，保持一键直接分叉。
- 子任务和父任务属于同一个项目 workspace，只是 cwd 可能不同。界面不需要跨 workspace 导航。
- **在当前目录 / 当前 worktree 中分叉：** 子任务的 cwd 与父任务相同。子任务行无论由哪条路径首次写入（CLI 首次上报，或 App Control `forkSession` 的归属预留），都在写入的同一事务中从父行继承 `root_path`、`worktree_root` 与附加目录，两条路径共用同一个继承函数；父行是唯一数据源。
- **在新 worktree 中分叉：** 新 worktree = 父任务 cwd 当前状态的一份独立副本：
  - 起点是父任务 cwd 的 HEAD（先解析成 SHA）。
  - 带入父任务 cwd 中已暂存、未暂存的改动（保留暂存区划分），以及未被忽略的未跟踪文件。父目录本身不做任何修改。
  - 被忽略的文件仍按 §3.4 从主 checkout 拷贝。
  - 这是开始创建时的快照；父任务之后的改动不会带过去。从较早的 assistant 消息分叉时，文件也是当前状态，与"在当前目录分叉"看到的一致。
  - 进度输出与"已创建 worktree"记录带入的文件数：`Carried N changed file(s) from <父任务 cwd>`。
  - 带入失败（补丁无法应用、文件无法读取）时整个创建失败（`carry-failed`），回滚 worktree，可以"重试"或"放弃"。
- 创建过程与 §3.3 相同：先显示进度卡片，成功后打开子任务；子任务历史在复制的对话之后，追加"已创建 worktree"一项。失败时提供"重试"和"放弃"。
- 子任务只复制对话历史，不回退、不恢复任何目录的 checkpoint。父任务和父目录都不受影响。
- CLI 不支持 worktree cwd 时（§9.3 能力探测），"在新 worktree 中分叉"显示为禁用，并注明"当前 Agent 版本不支持"。

### 3.7 worktree 任务的标识与按 cwd 工作的界面

| 位置                                     | 显示                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| 侧栏任务行（分组视图、项目视图、时间线） | 右侧元信息区加 `GitBranch` 图标（`size-3.5`，带 `aria-label`），不加文字              |
| 任务行悬浮卡片 / 时间线目录名            | 标题换成 `<仓库名> · <bucket>`，例如 `z-code · 3f2a`；卡片同时显示 worktree 路径、最近活动与分支，见 [会话行悬浮卡片](../ui/task-row-hover-details.md) |
| 会话头部项目胶囊                         | 图标换成 `FolderGit2`，名称为 `<仓库名> · <bucket>`；弹出面板显示 worktree 路径与分支 |

标识都从任务的 cwd（`root_path`）按受管布局推导，不在任务行或 UI store 中保存副本。

**按 cwd 工作的界面必须使用任务的 cwd，不能使用 workspace 路径。** worktree 任务的 workspace 路径是项目主目录，用错就会对主目录操作。实现时逐项核对：

| 改用任务 cwd                                                                          | 继续使用 workspace                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 分支切换器、Git 菜单、diff 与改动统计、文件树、终端初始目录、在编辑器中打开、文件监听 | CLI 进程、标签页、草稿、sessions-index、项目归属 |

### 3.8 在 worktree 中创建分支

worktree 创建时处于 detached HEAD。要提交或推送时，用户在会话里用现有的分支切换器（头部 Git 菜单或对话状态面板）执行"新建并切换分支"。按 §3.7，它作用在任务的 cwd 上，即这个 worktree，主 checkout 不变。现有的"分支已被其他 worktree 占用"错误（`branch-in-other-worktree`）继续生效。

### 3.9 创建中关闭窗口或退出应用

创建记录只在 Host 内存中。Host 进程跟随窗口：关闭窗口会结束该窗口的 Host。

- **只在有正在创建的 worktree 时才提示。** Host 把"阻止退出的事项"上报给 main（§6.4）。退出应用时，或关闭一个其 Host 有正在创建的 worktree 的窗口时，确认框增加一行："正在新 worktree 中启动的任务：N 个，关闭后会丢失。"没有这类事项时，行为不变。失败状态的创建记录不计入。
- 用户仍然确认关闭时，创建记录丢失，首条消息不会发送。磁盘上的结果取决于进行到哪一步：

| 中断时机                  | 磁盘上剩下什么                | 处理                                   |
| ------------------------- | ----------------------------- | -------------------------------------- |
| `git worktree add` 开始前 | 什么都没有                    | 无                                     |
| 检出进行中                | 已登记但文件不完整的 worktree | 管理弹窗中显示为"无任务"，可以强制删除 |
| 检出完成，会话还没创建    | 完整但没有任务的 worktree     | 管理弹窗中显示为"无任务"，可以删除     |

- 渲染进程刷新（不是关闭窗口）没有影响：Host 仍在运行，renderer 重新订阅创建记录即可继续显示。

### 3.10 管理 worktree

入口：项目菜单 → "Worktrees"，打开一个弹窗。弹窗按项目中每个 Git root 分组，列出这个 root 下由 ZCode 管理的 worktree。

| 列                           | 来源                                                |
| ---------------------------- | --------------------------------------------------- |
| 名称、路径                   | 目录                                                |
| 分支或 detached、HEAD 短 SHA | `git worktree list --porcelain`                     |
| 是否有改动                   | 对该 worktree 执行 `git status --porcelain`         |
| 使用它的任务                 | tasks-index 中 `root_path` 位于该 worktree 内的任务 |

| 操作                                         | 规则                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 打开任务                                     | 一个任务时直接打开；多个任务时弹出子菜单                                                     |
| 在编辑器中打开、在文件管理器中显示、复制路径 | 复用平台服务现有能力                                                                         |
| 删除                                         | 见 §3.11                                                                                     |
| 移除记录                                     | 目录已被用户手动删除（`git worktree list` 中标为 prunable）时显示，执行 `git worktree prune` |

空状态文案："还没有 worktree"。读取失败时显示错误信息和"重试"按钮。入口只在桌面的本地项目上显示。

### 3.11 删除 worktree

确认弹窗写明：删除 worktree 目录；被忽略的文件（依赖、构建产物）会一并删除；使用它的任务会保留，但变为只读。

| 情况                                                      | 结果                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 有任务使用它，且有未提交改动或未跟踪的文件                | 拒绝，提示"worktree 有未提交的改动"，并提供"在编辑器中打开"                      |
| **没有任何任务使用它**，且有改动                          | 允许强制删除：确认框写明"将丢弃未提交的改动"，执行 `git worktree remove --force` |
| 使用它的任务有正在运行的 turn、排队中的输入或待处理的交互 | 拒绝，提示"有任务正在运行"；由项目 CLI 判断（§8.3），不看 Host 镜像              |
| 有初始 cwd 在该 worktree 内的终端                         | 拒绝，提示"请先关闭在该目录中运行的终端"                                         |
| 正在创建中（有创建记录）                                  | 不在列表中显示删除按钮；由创建记录的"放弃"处理                                   |
| 以上都没有                                                | 执行删除，见 §8.3                                                                |

"无任务时允许强制删除"用于清理 §3.9 中断后留下的残留。Host 在删除时会重新检查所有条件。

### 3.12 删除后的任务

worktree 删除后，使用它的任务保留在侧栏和原项目下，按现有"工作区目录失效"规则变为只读，复用现有提示文案（`docs/project-primary-root-availability.md` 的"只读会话的输入区提示"）。判断依据是任务的 cwd 不存在，不是 workspace 路径。

- 已打开的任务在删除成功后立即变为只读：可用性在项目变更事件（删除后发布）到达时重新查询，不轮询。
- 这些任务仍可删除、重命名：CLI 判定会话归属时以创建时持久化的 `projectID` 为准，不依赖 worktree 目录仍然存在（Hook Trust 的严格校验只用于授权）。

移除项目、彻底删除项目数据时，不连带删除 worktree。彻底删除项目数据时，worktree 任务的会话按归属 workspace 交给项目 CLI 进程删除（§2.1），由它判断会话是否在运行；它的记忆与项目共用，随项目 root 一起删除。

## 4. 已知限制

| 限制                                                                                                                                                        | 原因                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 新 worktree 中没有依赖目录（如 `node_modules`），项目可能需要重新安装依赖才能运行                                                                           | 第一版不做 setup 脚本；被忽略文件只按 `.worktreeinclude` 拷贝                 |
| `.worktreeinclude` 列入大目录（如 `node_modules`）时，逐个文件拷贝，可能很慢、占用磁盘                                                                      | 只在支持写时复制的文件系统上节省空间；Windows 上是完整拷贝                    |
| 发送前显示的 slash 命令、skills 是项目主目录的配置，可能和所选分支中的配置不同                                                                              | worktree 在发送后才存在；会话创建后按 worktree 读取                           |
| worktree 模式首次发送比普通发送慢                                                                                                                           | 需要先检出，且不预热会话                                                      |
| 创建中关闭窗口或退出应用，首条消息丢失                                                                                                                      | 创建记录只在 Host 内存中（§3.9）                                              |
| 子模块不会初始化                                                                                                                                            | 第一版不执行 `git submodule update`                                           |
| 在源仓库中授予或撤销 Hook Trust 后，已在运行的 worktree 会话要到下次新建或冷恢复会话时才生效                                                                | CLI 只在会话创建时读取 Trust store；已接受此限制                              |
| 源仓库路径经过软链时，worktree 不继承 Trust                                                                                                                 | resolver 按 realpath 校验；退回不继承，属安全方向                             |
| shell 内 `cd` 进入 worktree 的终端不会阻止删除                                                                                                              | 终端服务只记录启动时的 cwd                                                    |
| worktree 任务的附加目录中，源仓库之外的 root 不隔离，写入的是那些目录本身                                                                                   | 只有源仓库会被检出为 worktree（§2.1）                                         |
| 会话启动失败后，CLI 中可能留下一个没有消息的会话。首条消息开始时会话已从草稿切换为立即持久化，所以它是否被 CLI 保存、是否出现在列表中，取决于失败发生的位置 | CLI `createSession` 首条消息失败时不清理会话记录；由 CLI 统一修复（后续任务） |

## 5. 职责划分

### 5.1 结论：Host 是唯一的 worktree 管理者

worktree 是应用级资源：它比会话活得久，有管理界面，并和项目、任务归属绑定。Host 拥有它的整个生命周期；CLI 不自己执行 git 来管理 worktree。

依据：

| 参照                         | 做法                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| ZCode 定时任务、闲时任务     | Host 拥有。UI 直接调用 Host 服务；agent 工具经 CLI 端口（`automation-port`、`offpeak-port`）反向请求 Host |
| ZCode 会话、消息、checkpoint | CLI 拥有。它们是会话内部的事实                                                                            |
| 业界同类桌面应用             | 由应用进程（不经过 agent）预留 bucket、执行 `git worktree add`；agent 侧的 worktree 工具由客户端提供      |

| 职责                                                       | 归属                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| 目录布局、bucket 预留、`git worktree add / remove / prune` | Host worktree 服务（唯一执行者）                                 |
| 创建记录（阶段、git 输出、待发送的首条消息）               | Host 内存（创建阶段的唯一数据源），renderer 订阅                 |
| worktree 建好后创建会话并发送首条消息                      | Host 编排：项目 CLI `createSession(cwd = wt)` + 首条消息         |
| 会话历史（含"已创建 worktree"一项）、消息                  | CLI                                                              |
| 任务归属（`workspace_key` = 项目，`root_path` = wt）       | Host tasks-index                                                 |
| 列出、删除、清理                                           | Host + 管理弹窗                                                  |
| 阻止退出的事项                                             | Host 上报，main 汇总并弹确认                                     |
| Trust identity（worktree → 源仓库）                        | 共享 resolver `@zcode/shared/managed-worktree`，Host 和 CLI 共用 |

### 5.2 入口与扩展

```text
用户新建任务（☑ worktree）     ─┐
用户"在新 worktree 中分叉"     ─┼─▶ renderer ─▶ Host worktree 服务（唯一执行者）
                                │
模型工具（后续版本）            ─┤
workflow isolation（后续版本）  ─┴─▶ CLI 端口 ─▶ 反向请求 ─▶ Host worktree 服务
```

后续版本中，agent 创建的 worktree 有两种语义，都由 Host 执行：

- 模型工具创建：worktree 作为当前任务的附加目录，不改变任务的 cwd。需要一张 Host 侧的"任务附加 worktree"记录，因为 `root_path` 反查找不到它。
- workflow `isolation: "worktree"`：子 agent 的子会话 cwd = 新 worktree；没有改动时自动删除。

## 6. 架构

### 6.1 分层

`managedWorktreeService` 是桌面 base attachment 的可选能力。只有本机入口显式启用该能力后，客户端才创建代理；远程 workspace、Source settings、手机和普通 Web 连接不创建代理。创建记录和结束事件的 UI 订阅固定从 base services 读取，与侧栏管理弹窗同源，不随当前远程项目切换到 Source。未提供该能力时保持空记录和无订阅，不向不存在的 `managed-worktrees` 频道发请求。

```text
┌─ Renderer（packages/ui）──────────────────────────────────────────────────┐
│ composer：worktree 复选框、分支胶囊（存入草稿）                                  │
│ 创建视图：用户气泡 + 进度卡片（订阅创建记录）；失败操作                           │
│ 会话：按任务 cwd 工作的 Git / 文件 / 终端界面（§3.7）                            │
│ project-sidebar：创建中任务行、Worktrees 管理弹窗、任务行图标                     │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ MessagePort RPC（通道 managed-worktrees 只在本地桌面 Host 注册）
┌─ Local Host（每个窗口一个）─────────────────────────────────────────────────┐
│ IManagedWorktreeService：创建记录、创建、重试、放弃、不使用 worktree、          │
│   列出、删除、prune、fork 到 worktree                                         │
│ IGitService（managed-worktree-repo adapter）                  ──spawn git──▶ 源仓库、受管根目录
│ ZCodeAgentService：sendCommand 到项目 CLI；删除期间拒绝 cwd 位于 wt 内的命令    │
│ tasks-index：reserveCreatedTask(workspace_key = 项目, root_path = wt)    ──▶ tasks-index.sqlite
│ 阻止退出事项上报 ──▶ main                                                     │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ stdio，@zcode/protocol v4
┌─ 项目 CLI（每个项目 workspace 一个进程）────────────────────────────────────┐
│ createSession(workspaceId = 项目, cwd = wt, worktreeCreation)              │
│ 会话历史第一项写入"已创建 worktree"                                          │──▶ ~/.zcode/cli/db/db.sqlite
│ 按会话 cwd 读取目录树配置；按 workspace key 共享工作区级状态（§7.2）          │
└──────────────────────────────────────────────────────────────────────────┘
```

受管模块：`managed-worktree-shared`（布局与 Trust identity resolver）、`managed-worktree-repo`（Git adapter）、`managed-worktree-tasks`（编排服务）、`managed-worktree-ui`（renderer）。

### 6.2 唯一数据源

| 事实                                 | 唯一数据源                                                     |
| ------------------------------------ | -------------------------------------------------------------- |
| worktree 是否存在、是否由 ZCode 管理 | `git worktree list --porcelain` 加目录布局校验（§6.3）         |
| worktree 的分支、HEAD、改动          | 该 worktree 的 git 状态                                        |
| 正在进行的创建                       | Host 内存中的创建记录                                          |
| worktree 是否正在删除                | Host 内存中的删除租约（与创建记录同属 worktree 服务）          |
| 会话是否忙（在途 turn、排队、交互）  | 项目 CLI 的会话驻留事实；Host 的 sessions-index 镜像只用于展示 |
| 任务的 cwd                           | tasks-index `tasks.root_path`（创建后固定）                    |
| 任务的 workspace                     | tasks-index `tasks.workspace_key`（项目主目录）                |
| 任务是否运行在某个 worktree 中       | tasks-index `tasks.worktree_root`（§6.6）                      |
| 哪些任务在用某个 worktree            | 按 `worktree_root` 精确匹配                                    |
| 草稿的 worktree 开关与所选分支       | session store 草稿状态 `draftWorktree`                         |
| 主区展示哪条创建记录                 | session store `draftWorktreeCreationId`（只是视图指针）        |
| "已创建 worktree"的记录              | CLI 会话历史中的 timeline part（§6.6）                         |

创建记录的结构：

```ts
interface ManagedWorktreeCreation {
  id: string;
  projectId: string;
  kind: "new-task" | "fork";
  phase: "creating" | "starting-session" | "failed";
  ref: string | null; // null = 当前 HEAD
  worktreePath: string | null; // bucket 预留后写入
  output: string; // git 输出，最多保留末尾 32KB
  error: { code: ManagedWorktreeErrorCode; detail?: string } | null;
  firstInput: unknown; // 首条消息的命令（新建）或 forkAssistant 命令（fork）
}
```

记录在会话创建成功、放弃或"不使用 worktree"完成后删除。

### 6.3 目录布局与受管判定

```text
<受管根目录>/                    = <数据根目录>/.zcode/worktrees
  .metadata_never_index         仅 macOS：阻止 Spotlight 索引
  <bucket>/                     4 位小写十六进制，用非递归 mkdir 原子占用；冲突时重新随机
    <仓库名>/                    linked worktree，`.git` 是一个文件
```

- 数据根目录与 Host、CLI 一致：`ZCODE_DATA_BASE_DIR` 优先，否则 homedir。bucket 只有 4 位，用来控制 Windows 路径长度。
- 受管判定：路径符合两级布局；出现在源仓库的 `git worktree list --porcelain` 中；`.git` 是文件且 `git rev-parse --git-common-dir` 指向源仓库。不满足的条目不显示，也不允许删除。
- 项目主目录可能是仓库的子目录（monorepo）。worktree 总是检出整个仓库，任务 cwd 取 `<worktree 根>/<主目录相对仓库 toplevel 的路径>`。起点中没有这个子目录时，创建失败（`start-ref-missing-subdir`）。

### 6.4 阻止退出的事项

Host 现有的运行计数上报扩展为事项列表，第一版只有一种：

```ts
interface HostQuitBlocker {
  kind: "worktree-creating"; // 后续可加入其他会被关闭中断的 Host 事项
  count: number;
}
```

- Host 在创建记录进入或离开 `creating` / `starting-session` 时上报，事件驱动，不轮询。
- main 按 Host 进程分别保存。退出应用时汇总全部 Host；关闭窗口时只看该窗口的 Host。
- 计数为 0 时不改变现有行为。

### 6.5 git 命令约束

- 所有 git 调用都通过现有的 `gitCommandProvider`，使用参数数组。
- 创建：`git worktree add --detach <path> <commit>`。`<commit>` 先解析成 SHA。git 的 stdout/stderr 实时追加到创建记录。
- 删除：`git worktree remove <path>`；只有 §3.11 的"无任务强制删除"加 `--force`。
- fork 带入改动（§3.6），在父任务 cwd 执行，均为只读命令：`git rev-parse HEAD`、`git diff --cached --binary <sha>`、`git diff --binary`、`git ls-files --others --exclude-standard -z`；在新 worktree 中执行 `git apply --index`（已暂存）、`git apply`（未暂存），未跟踪文件按 §3.4 的拷贝规则复制。基于同一个 SHA，补丁不会冲突。
- 拷贝清单：`git ls-files --others --ignored --exclude-standard -z` 与 `git ls-files --others --ignored --exclude-from=.worktreeinclude -z` 取交集，在源仓库根目录执行（§3.4）。
- `git worktree add` 使用 10 分钟超时，`remove` 使用 5 分钟超时。
- 仓库自带的 hooks（例如 `post-checkout`）按 git 默认行为执行。

### 6.6 数据设计

上线后数据库结构和派生规则都无法再改，所以按以下原则设计：只加不改（session-management I10）；每个字段只有一个写者；能从其他数据源得到的不存。

```text
┌─ Host tasks-index.sqlite（组织状态，Host 写）──────────────────────────────────────┐
│ tasks: workspace_key  workspace_path  root_path  worktree_root  project_id  execution_directories │
│        项目主目录      项目主目录       cwd        worktree 根     项目        显式附加目录          │
└──────────────────────────────────────────────────────────────────────────┘
┌─ CLI db.sqlite（会话事实，CLI 写）──────────────────────────────────────────────┐
│ session: directory = cwd   workspace_id = NULL（含义不变）   project_id = 按 §6.6.3 派生 │
│ part: 第一轮消息中的 timeline part，timelineType = "worktree_creation"                   │
└──────────────────────────────────────────────────────────────────────────┘
不落盘：创建记录（Host 内存）、worktree 列表（git）、起点分支名（只在历史项中记录 SHA 与 ref）
```

#### 6.6.1 Host：新增 `tasks.worktree_root`

| 项   | 设计                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 列   | `worktree_root TEXT NULL`：任务运行所在的受管 worktree 根目录。cwd 可能是其中的子目录（monorepo），所以它和 `root_path` 不一定相同。NULL 表示不是 worktree 任务          |
| 写者 | 只有 Host，和 `root_path` 一起写入一次，之后不变：`reserveCreatedTask` 时写入；同目录 fork 的子任务行（CLI 首次上报或 App Control 分叉预留）在写入的同一事务中从父行继承 |
| 索引 | `idx_tasks_host_worktree(host_id, worktree_root) WHERE worktree_root IS NOT NULL`，供"哪些任务在用这个 worktree"精确匹配                                                 |
| 读者 | 任务行标识、删除检查、按 cwd 工作的界面（§3.7）直接读这一列，不从路径布局推导；目录布局规则以后调整，也不影响已有任务                                                    |
| 迁移 | 新增 migration，只加列与索引，声明 `touchedTables`，更新 `schema.baseline.sql`，补逐表哈希验证。旧行全部为 NULL；旧模型的实现从未发布，没有数据需要转换                  |

worktree 任务的其他列：`workspace_key` 与 `workspace_path` 都是项目主目录；`root_path` 是 cwd（virtual-project spec 定义它为"绑定目录 = CLI directory，永不变"）。**本地任务第一次出现 `root_path ≠ workspace_path`。** 现在的 `reserveCreatedTask` 把两列写成同一个值，所有默认它们相等的读取方都要按 §3.7 核对。

冷恢复与已就绪实例的激活预检同样遵守这个分离：保留 workspace key / 显式 identity 校验，通过既有受管 worktree 解析器验证 cwd 确实映射到请求的源项目。不得仅因 cwd 不同拒绝合法 worktree，也不得将任意不同目录当成同项目；错误目录的请求不能启动或替换原实例。Host 的 fork ACK 与首次事实摄入共用父行目录继承，保留 `worktree_root`，让占用与删除检查能看到全部子任务。

#### 6.6.2 CLI：session 表不加列

worktree 会话的 `directory` = cwd，`workspace_id` 保持 NULL（这一列只存远程 identity，含义不变）。

"会话属于哪个 workspace"是组织状态，归 Host：

- 会话运行时，Host 在 create / resume / subscribe 时把 workspace 传给 CLI（现有做法）。
- 冷列表时，任务行集合由 Host 决定（I5）；Host 用现有的 task id 白名单（`legacyTaskIds`）让 CLI 补 worktree 会话的摘要，CLI 不按目录扫描它们。

代价：CLI 单独运行（TUI）时，在项目主目录中看不到 worktree 会话，要在 worktree 目录中才能看到。

#### 6.6.3 CLI：权限与记忆按源仓库路径派生

CLI 的 `project_id` 由目录路径生成（slug），`permission` 表按它存储；记忆目录按工作目录派生。worktree 会话改为用源仓库中对应的路径来派生这两者：

- 映射使用 Hook Trust 的同一个 resolver（§7.3）：wt 经严格校验映射回源仓库路径。
- 结果：worktree 任务直接共用项目已记住的权限和记忆；不产生按 worktree 存的数据，worktree 删除后也没有孤儿数据。
- 映射校验失败（例如反向链接被破坏）时，退回按 worktree 路径派生。这是安全方向的退路。

#### 6.6.4 "已创建 worktree"：timeline part

它和 `session_fork`（"分叉自…"）、`model_change`、`context_compaction` 属于同一类：显示在对话时间线中的标记，不是会话级状态。所以存为第一轮消息中的 timeline part，不使用 `session_entry`。

```text
CLI 存储：{ type: "timeline", timelineType: "worktree_creation", display: "worklog",
            worktreeCreation: { path, sha, ref, output } }   // output 只保留末尾，最多 32KB
V4 投影：timelineMarker { type: "worktreeCreated", path, sha, ref, output }
不进入模型上下文（和其他 timeline 标记一样）
```

各层的校验：

| 层                         | 是否严格 | 依据与影响                                                                                                                               |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 存储读取               | 不严格   | `decodePartRow` 只做 `JSON.parse` 加类型断言                                                                                             |
| CLI 恢复历史并投影成 V4 行 | 不严格   | `transcript-hydration.ts` 按 `timelineType` 逐个匹配，不认识的类型跳过；降级时旧 CLI 不产生这一行                                        |
| 协议 schema                | 严格     | 旧版协议 `zcodeTimelinePartSchema` 的 `timelineType` 是固定枚举；V4 `timelineMarkerPayloadSchema` 是固定联合类型。新增类型时两侧同时修改 |

待验证：旧版协议 schema 是否仍在某条现役路径上校验 CLI 发出的历史 part。用降级 E2E 验证（§12 WT-24）。

#### 6.6.5 现在不建的表

以下表在后续版本需要时再加，现在不预留列：

- `task_worktree_attachments`（Host）：模型工具创建、附加到某个任务的 worktree。`worktree_root` 只描述任务自己的 cwd，表达不了附加关系。
- `worktree_creations`（Host）：如果以后要支持重启后恢复创建记录。

#### 6.6.6 降级

| 数据                                  | 旧版本的表现                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tasks.worktree_root` 与新索引        | 旧版本忽略                                                                                                            |
| `root_path ≠ workspace_path` 的任务行 | 任务显示在项目下；打开时 cwd 取 `root_path`，会话可用；旧界面的 Git / 文件面板按 workspace 路径工作，会显示项目主目录 |
| CLI 历史中的 `worktree_creation` part | 旧 CLI 恢复历史时跳过，不显示这一项                                                                                   |
| 按源仓库派生的权限与记忆              | 旧版本按 worktree 路径派生，看不到共享的权限与记忆                                                                    |

## 7. 与现有不变量的关系

### 7.1 会话管理

| 不变量                 | 本功能的做法                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 身份与路径分离      | worktree 任务的 workspace key 是项目主目录；执行路径是 `root_path` = wt。workspace key 不再等于本地任务的 cwd                                                          |
| I2 cwd 固定            | 会话在 worktree 建好后才创建，cwd 一次确定，之后不变                                                                                                                   |
| I3 / I16 附加目录      | 预留任务时显式写入 `execution_directories`：源仓库内的 root 映射为 worktree 中对应的路径（不存在则不加），其他 root 原样保留；不把源仓库主 checkout 交给 Agent（§2.1） |
| I4 CLI 不感知项目      | CLI 只收到 workspace key、cwd 和目录列表                                                                                                                               |
| I5 行集合由 app 库决定 | 任务行由 Host 在创建会话前预留                                                                                                                                         |
| I17 首次归属           | 预留时写入 `project_id`                                                                                                                                                |

worktree 任务使用项目 CLI 进程，不再有"每个 worktree 一个进程"。worktree 任务不允许移动到其他项目（`project.worktree-task-immovable`）。

### 7.2 CLI 中哪些状态跟随 cwd，哪些跟随 workspace key

CLI 现在用 workspace key 分组了 MCP 配置池、workspace 配置与展示、模型运行时、运行时偏好等状态。worktree 任务的 key 是项目，cwd 是 worktree，需要明确划分：

| 状态                                                                     | 跟随                       | 说明                                                  |
| ------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------- |
| 工作目录、AGENTS.md、`.zcode` 下的 settings、hook 声明、skills、commands | 会话 cwd（worktree）       | 这些文件随所选分支的版本变化                          |
| Hook Trust 记录、权限记录、记忆                                          | 源仓库（经 resolver 映射） | 不必在每个 worktree 中重新授权或重建，见 §6.6.3、§7.3 |
| MCP 连接池（含 `isolation: "workspace"` 的共享连接）                     | 会话 cwd（worktree）       | stdio MCP 进程的工作目录就是会话 cwd，见下文          |
| 模型选择、运行时偏好、sessions-index、Settings 的 workspace 行           | workspace key（项目）      | 工作区级状态                                          |
| CLI 发往 Host 的反向请求（含官方 MCP 授权头）                            | workspace key（项目）      | Host 按 key 路由，见 §9.3                             |

这样 worktree 任务读取的项目文件来自它自己的分支，而授权、记忆和工作区级设置都和项目共用。CLI 实现时要逐项核对这张表（§14）。

MCP 连接池不跟随项目：stdio MCP 进程以会话 cwd 为工作目录，worktree 中的 MCP 配置也可能和主目录不同。按项目共用连接，worktree 任务会复用在主目录启动的进程，操作错误的文件。所以同一个 worktree 内的会话共用连接，不同 worktree 和主目录各自启动。

### 7.3 Hook Trust

规则见 `docs/specs/workspace-hook-trust.md` D23，保持不变：Trust identity 由共享 resolver 计算，worktree 经过严格校验后归一为源仓库中对应的路径；校验失败就不继承。对外字段（admission、审核 request、V4 投影、Settings 行）使用会话的 workspace key，即项目。

效果：hook 声明从 worktree 的文件读取，信任记录和源仓库共用。内容与源仓库已信任版本相同的 hook 直接运行；只有在所选分支中内容被修改的 hook 会 pending 一次。在 worktree 中授予或撤销信任，对源仓库和它的所有 worktree 同时生效。

## 8. 时序

### 8.1 新建 worktree 任务

```text
renderer 点发送（☑ worktree，分支 = staging）
 1 managedWorktreeService.startNewTask({ projectId, ref, firstInput }) → Host
     Host：创建记录 phase = creating；上报阻止退出事项
     renderer：显示创建视图（用户气泡 + 进度卡片），订阅记录；侧栏显示"创建中"
 2 Host：预留 bucket → git worktree add --detach wt <sha>（输出实时写入记录）
     失败 → phase = failed（§3.5）；删除本次 bucket
 3 Host：phase = starting-session
     reserveCreatedTask(workspace_key = 项目, root_path = wt, worktree_root = wt 根, project_id, 显式附加目录)
     → 项目 CLI：createSession(workspaceId = 项目, cwd = wt, worktreeCreation = { path, sha, ref, 输出末尾 })
     → 首条消息
 4 CLI：会话历史第一项为"已创建 worktree"；模型开始运行
 5 Host：删除创建记录；上报阻止退出事项
   renderer：创建视图切换为真实会话（同一 workspace，无需跨 workspace 导航）
```

"不使用 worktree"：Host 删除残留 worktree，在项目主目录执行第 3 步（不带 cwd 与 `worktreeCreation`）。"放弃"：Host 删除残留 worktree 和记录，renderer 用记录中的首条消息恢复项目草稿。

### 8.2 fork 到新 worktree

```text
renderer 分叉菜单 → managedWorktreeService.forkToWorktree({ workspace, forkAssistant 命令 }) → Host
 1 能力探测：CLI 不支持 worktree cwd → unsupported-agent
 2 父任务的 cwd 与项目取 tasks-index（不信任 UI 传入）
 3 创建记录 kind = fork；在父任务 cwd 解析 HEAD 为 SHA，读取已暂存 / 未暂存补丁与未跟踪文件清单
   以该 SHA 创建 worktree（同 §8.1 第 2 步）→ 应用补丁、复制未跟踪文件 → §3.4 拷贝被忽略文件
   任一步失败 → 回滚 worktree，phase = failed（carry-failed / git-failed / copy-failed）
 4 预分配 childSessionId；reserveCreatedTask(child, workspace_key = 项目, root_path = wt, worktree_root = wt 根)
 5 项目 CLI：forkAssistant{ target, targetCwd: { cwd: wt, childSessionId, worktreeCreation } }
     CLI：复制对话；子会话 cwd = wt，workspace key 不变；在复制的历史后先写一条子会话的环境更新
          （新的工作目录与按 wt 计算的 Gen UI 目录，见 docs/specs/gen-ui-output-directory.md），
          再追加 fork 分隔标记与"已创建 worktree"
 6 失败 → phase = failed（重试 / 放弃）
renderer ◀─ { child: { sessionId } } ─ 在同一 workspace 中打开子任务
```

### 8.3 删除 worktree

删除涉及三个状态，各有唯一的所有者：

| 状态                                 | 所有者                     |
| ------------------------------------ | -------------------------- |
| worktree 生命周期（创建中 / 删除中） | Host worktree 服务（内存） |
| 会话是否忙                           | 项目 CLI（会话驻留事实）   |
| 终端                                 | Host 终端服务              |

```text
renderer 管理弹窗 → managedWorktreeService.removeWorktree({ projectId, path, force? }) → Host
 1 受管判定，且源仓库属于该项目的某个 root
 2 同步取得删除租约（1 与 2 之间没有 await）：该 worktree 已有创建记录或租约 → worktree-in-use
   持有租约期间，以下入口先检查"目标 cwd 是否位于删除中的 worktree"，是则拒绝（worktree.removing）：
   发往会话的命令（含同目录 fork）、订阅时冷恢复、新建终端
 3 等待租约之前已通过闸门的全部会话操作结束（命令拿到 ACK、冷订阅完成）
 4 listTasksByWorktree(worktree 根)（在第 3 步之后读取）；有任务且 force → worktree-in-use / tasks
 5 有初始 cwd 位于 worktree 内的终端 → worktree-in-use / terminal
 6 有任务且有改动 → worktree-dirty；无任务且有改动且 force ≠ true → worktree-dirty
 7 请求项目 CLI 卸载 cwd 位于 worktree 内的全部驻留会话：session/releaseUnderDirectory { directory }
   只使用已存在的项目 CLI 进程，不为删除启动进程；没有进程时没有驻留会话
   CLI 按自己的驻留表选会话（包括 tasks-index 还没有镜像的同目录 fork 子会话），判断忙闲并在同一步卸载：
   任一会话忙 → 全部不卸载，返回 busy → worktree-in-use / running
   请求失败 → session-close-failed；不吞掉错误，不继续删除
   force 时 CLI 报告了任何会话（released 或 busy）→ worktree-in-use / tasks：强制删除只用于没有任务使用的残留，
   CLI 的驻留表是"谁在用"的权威事实，tasks-index 镜像可能还没有同步刚分叉的子会话
 8 git worktree remove [--force] → 删除空 bucket → 发布项目变更
 9 释放租约（成功和失败都释放）
```

- 租约按 worktree 根目录记录，不按会话列表记录：检查之后才出现的同目录 fork 子任务同样被拦截。
- 闸门只从 tasks-index 的任务行读取 cwd。删除期间，没有任务行的会话（例如尚未镜像的同目录 fork 子会话）cwd 未知，一律拒绝，不回退为 workspace 目录。这只影响删除进行中的几秒。
- 卸载哪些会话、它们是否忙，都只由 CLI 判断。Host 不用 sessions-index 镜像选会话或判断忙闲：镜像可能滞后（同目录 fork 的子会话在 CLI 事实同步前不在镜像中），且普通 `session/close` 会直接关闭运行中的会话。
- 第 7 步已卸载、但后续步骤失败时，这些会话保持未加载，下次打开时冷恢复，没有副作用。
- 项目 CLI 中的其他会话不受影响。
- 租约与闸门只在本 Host 内生效。这依赖"一台机器只有一个本地 Host"：应用持有单实例锁（`requestSingleInstanceLock`），主窗口只经 `primaryWindowCoordinator` 创建并复用已有窗口；renderer 刷新复用原 Host，退回重建时先结束旧 Host；手机远控挂在同一个 Host 上。以后如果支持多个主窗口，删除需要由 main 跨 Host 协调。用户在 ZCode 之外运行的进程（独立 CLI、编辑器、shell）不在检查范围内。

## 9. 契约变更

### 9.1 共享类型

`ManagedWorktreeInfo { path, bucket, sourceRoot, head, branchName, state: "ok" | "missing", dirty, creating: boolean }`；`ManagedWorktreeErrorCode`：`not-repository`、`invalid-start-ref`、`start-ref-missing-subdir`、`bucket-exhausted`、`worktree-dirty`、`worktree-in-use`、`not-managed`、`local-only`、`git-failed`、`copy-failed`、`unsupported-agent`、`session-failed`，新增 `carry-failed`（fork 带入改动失败）与 `session-close-failed`（删除时卸载会话失败）；新增 `ManagedWorktreeCreation`（§6.2）。错误只按结构化 code 判断。

### 9.2 服务接口

| 接口                                         | 内容                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IManagedWorktreeService`                    | `startNewTask`、`forkToWorktree`、`retryCreation`、`continueWithoutWorktree`、`dismissCreation`、`listCreations`、`onDidChangeCreations`、`onDidSettleCreation`、`listWorktrees`、`removeWorktree`、`pruneWorktrees`、`listStartRefs`、`isWorktreeAvailable`、`supportsWorktreeCwd`。Git 操作不再经 `IGitService` 暴露给 renderer，服务直接使用 `managed-worktree-repo` adapter |
| `GitWorktreeRepo`（`managed-worktree-repo`） | `list`、`create`（`onOutput` / `onPathAllocated` 回调，检出后按 `.worktreeinclude` 拷贝）、`remove`（`force`）、`prune`、`listStartRefs`、`resolveManagedWorktree`；只由 Host 的 worktree 服务调用                                                                                                                                                                              |
| `ProjectRepositoryContract`                  | `listTasksByWorktree({ worktreeRoot })`；`reserveCreatedTask` 支持 `workspace_key` 与 `root_path` 不同，并写入 `worktree_root`                                                                                                                                                                                                                                                  |
| Host → main                                  | 阻止退出事项（§6.4）                                                                                                                                                                                                                                                                                                                                                            |
| `ITerminalService`                           | `listTerminalIdsUnderPath({ path })`（已有）                                                                                                                                                                                                                                                                                                                                    |

### 9.3 协议（`@zcode/protocol` v4）

```ts
createSession: {
  workspaceId: string;           // 项目 workspace key
  cwd?: string;                  // 缺省 = workspaceId 对应路径；worktree 任务 = wt
  worktreeCreation?: WorktreeCreationRecord; // { path, sha, ref, output }
}
forkAssistant: {
  target: ConversationRowTarget;
  targetCwd?: { cwd: string; childSessionId: string; worktreeCreation: WorktreeCreationRecord };
}
```

- 不带新字段时行为不变。
- CLI 持久化会话时，`directory` = cwd，`workspace_id` 仍为 NULL，不新增列（§6.6.2）。worktree 会话的 workspace 归属由 Host 在 create / resume / subscribe 和冷列表白名单中提供。
- `worktreeCreation` 由 CLI 写成 timeline part，V4 投影为 `timelineMarker { type: "worktreeCreated" }`（§6.6.4）。旧版协议的 `zcodeTimelinePartSchema` 枚举与 V4 `timelineMarkerPayloadSchema` 同时增加新类型。
- **能力探测**：`runtime/capabilities` 返回 `worktreeCwd: true`。旧 CLI 不支持时，Host 拒绝 worktree 创建，UI 禁用入口。
- **新增 `session/releaseUnderDirectory { directory }` → `{ released: string[], busy: string[] }`**：CLI 选出 cwd 位于该目录内的全部驻留会话；任一会话忙（在途 turn、排队命令、待处理交互）时全部不卸载，返回 busy；否则全部做驻留去激活（不删除持久会话），返回 released。判断与开始卸载之间没有 await。随 `worktreeCwd` 能力一同提供，Host 只对声明了该能力的 CLI 使用。
- **身份字段**：worktree 会话的 workspace ref 中 `workspacePath` 是 cwd，`workspaceKey` 是项目（与远程会话 key ≠ path 的既有语义相同，§2.1）。Host 路由 CLI 的反向请求、Host 读取任务元数据时，一律以 `workspaceKey` / `workspace_key` 为身份，不能用 `workspaceIdentity || workspacePath` 重新计算。冷恢复与订阅时 Host 传入项目的 workspace ref，CLI 保留存储中的 cwd。
- **会触发冷恢复的入口都带 workspace**：除 `conversation/subscribe` 外，`rowsRange`、`plans`、`fileChanges`、`fileRewindPreview`、`attachmentRead`、`conversationAttachmentRead`、`conversationAttachmentStat`、`attachmentPreviewSource`、`attachmentBegin` 的参数，以及命令信封，都有可选的 `workspace`，由 Host 按当前 attachment 可信注入，renderer 不传。CLI 冷恢复只用它确定身份；不带时按存储的 cwd 重建，worktree 会话的 key 会变成 worktree 路径，反向请求被 Host 拒绝。Host 只对本地 workspace 注入：远程 Source Server 可能是不认识新字段的旧版本，worktree 也只支持本地。
- **归属判定**（冷恢复 / 激活 / 本地冷列表共用一个函数）：会话 cwd 与 workspace 是同一个真实目录；或 cwd 是受管 worktree，经 resolver 映射回该真实目录；或 cwd 位于受管 worktree 布局内但目录已删除（文件系统无法证明），此时才用持久化的 projectID（§6.6.3）兜底。目录比较按 realpath，不按字符串：Host 的 key 保留用户添加项目时的大小写，resolver 返回磁盘真实大小写。projectID 是有损 slug（转小写、替换字符、截断到 80 字符），`my project` 与 `my-project` 相同，所以不能作为一般的归属证明。请求中的执行路径同样要属于该 workspace。
- 协议文档同步更新 `docs/conversation-product-protocol.md`；CLI 设计同步更新 `apps/zcode-cli/docs/design/v2/session-persistence.md`。

## 10. 失败与并发

| 场景                                       | 处理                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 两个任务同时创建 worktree                  | 非递归 mkdir 原子占用 bucket，冲突时重新随机                                                                                                |
| `git worktree add` 失败                    | 删除本次 bucket；创建记录 phase = failed，保留 git 输出                                                                                     |
| 创建成功但创建会话或首条消息失败           | phase = failed；"重试"只重做会话创建，不重建 worktree                                                                                       |
| 重复点击发送 / 重复提交                    | 创建记录按首条消息的 `commandId` 幂等；同一 commandId 的并发调用在第一次异步检查之前就登记，后到的调用复用同一结果，不会创建第二个 worktree |
| 删除与新输入同时发生                       | 删除租约先于检查取得，新输入被拒绝；已被 CLI 接受的输入使 CLI 判定为忙（§8.3）                                                              |
| 删除时卸载会话失败                         | 中止删除，返回 `session-close-failed`，worktree 与任务保持原样                                                                              |
| 会话启动请求异常或超时，CLI 实际已创建会话 | "放弃"/"不使用 worktree"前查询 CLI 命令结果，按"会话已启动"打开任务，不删除 worktree（§3.5）                                                |
| fork 带入改动时父任务仍在运行              | 以开始创建时的快照为准，之后的改动不带入                                                                                                    |
| 创建中关闭窗口                             | 见 §3.9                                                                                                                                     |
| Windows 上文件被占用，导致删除失败         | 返回 git 的结构化原因；worktree 保留，可以重试                                                                                              |
| 用户在 ZCode 之外手动删除了目录            | 列表显示 `missing`，可以"移除记录"；使用它的任务按 §3.12 变为只读                                                                           |

日志：创建、删除、回滚等生命周期事件用 `info`；git 输出逐行用 `debug`。

## 11. 平台、主题与国际化

- 支持 macOS、Windows、Linux。路径使用 `path` 标准库处理；比较路径时先规范化，Windows 下不区分大小写。
- UI 遵守 `DESIGN.md`：复选框和胶囊复用现有组件；进度卡片的 git 输出使用等宽字体；只使用语义色 token，深色和浅色主题都要验证。
- 所有文案同时进入 `zh-CN` 和 `en-US`。

## 12. 验收场景

桌面 E2E：`packages/desktop/test/e2e/git/worktrees/manual-review/pending/git-managed-worktree.test.ts` 覆盖 WT-01、WT-05、WT-08、WT-09、WT-29、WT-30、WT-34、WT-35，状态为 manual-review 待人工评审，评审后按 `e2e-case-lifecycle` 转正。回放命令：`ZCODE_E2E_MANUAL_REVIEW=1 E2E_PROVIDER_HTTP_MODE=replay E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/git/managed-worktree.json pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/git/worktrees/manual-review/pending/git-managed-worktree.test.ts'`；fixture 是合成的固定回复，用例不依赖模型内容。2026-11-04 macOS 回放 4/4 通过。其余场景尚无桌面 E2E；WT-31 / WT-32 的竞态只有 CLI 侧 `session/releaseUnderDirectory` 的独立测试，Host 租约未做并发 E2E。CLI 侧另有独立测试（会话 cwd、历史标记、fork 到 cwd、冷恢复、sessions-index、权限与记忆派生）。WT-36 / WT-37 / WT-38 由 CLI 集成测试 `apps/zcode-cli/packages/bootstrap/tests/v4-worktree-cwd.test.ts` 覆盖（WT-36 只在大小写不敏感的文件系统上执行）；WT-39 由 CLI 的 `official-mcp-auth-port`、`mcp-connection-pool`、`mcp-tool-bridge` 测试覆盖会话 key 的传递，Host 注入 workspace 的一侧没有自动化测试；这四项都没有桌面 E2E。未实跑 Windows / Linux，未做深浅主题视觉验收。

| ID    | 场景                                                                | 预期                                                                                                              |
| ----- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| WT-01 | 勾选 worktree 后发送                                                | 发送前不创建任何 worktree；发送后先显示用户消息和进度卡片；任务 cwd 为新 worktree（detached），workspace 仍是项目 |
| WT-02 | 非 Git 项目、远程项目、手机远控                                     | 不显示 worktree 复选框                                                                                            |
| WT-03 | worktree 模式下选择其他分支                                         | 本地 checkout 的分支不变；新 worktree 从该分支检出                                                                |
| WT-04 | worktree 任务的附加目录                                             | 不包含源仓库 root；包含项目的其他 roots                                                                           |
| WT-05 | 从 assistant 消息"在新 worktree 中分叉"                             | 子任务在同一项目 workspace 中打开，cwd 为新 worktree；对话已复制；父任务不变                                      |
| WT-06 | CLI 不支持 worktree cwd                                             | worktree 复选框和"在新 worktree 中分叉"禁用                                                                       |
| WT-07 | 在 worktree 任务中用分支切换器新建分支                              | 分支创建在 worktree 中；本地 checkout 不变                                                                        |
| WT-08 | 删除一个干净、空闲的 worktree                                       | 目录和 bucket 被删除；相关任务变为只读                                                                            |
| WT-09 | 删除有任务使用、且有未提交改动的 worktree                           | 被拒绝；目录保留                                                                                                  |
| WT-10 | 任务运行中或有终端时删除                                            | 被拒绝；运行不受影响                                                                                              |
| WT-11 | 重启 ZCode 后打开 worktree 任务                                     | 冷恢复；第一轮仍显示"已创建 worktree"，可展开                                                                     |
| WT-12 | 手机远控查看 worktree 任务                                          | 可以查看和对话，能看到"已创建 worktree"；不显示创建入口                                                           |
| WT-13 | 并发创建两个 worktree                                               | 得到两个不同的 bucket，互不影响                                                                                   |
| WT-14 | 起点无效或 `git worktree add` 失败                                  | 卡片显示失败与 git 输出；"放弃"后不留 worktree 和任务行，草稿恢复                                                 |
| WT-15 | 用户手动删除 worktree 目录                                          | 管理弹窗显示"目录缺失"，"移除记录"后条目消失                                                                      |
| WT-16 | Windows 上路径包含空格                                              | 创建、打开、删除都正常                                                                                            |
| WT-17 | 源仓库已信任某条已提交的 Hook，在 worktree 任务中发送               | 这条 Hook 直接运行，不出现 pending                                                                                |
| WT-18 | worktree 中的 Hook 声明与源仓库不同，或反向链接被破坏               | 只有变化的那一条 pending；反向链接被破坏时整体不继承                                                              |
| WT-19 | 项目主目录是仓库的子目录                                            | 任务 cwd 为 worktree 中对应的子目录                                                                               |
| WT-20 | 创建失败后点"不使用 worktree"                                       | 在项目主目录创建会话并发送首条消息；残留 worktree 被删除                                                          |
| WT-21 | 创建中关闭窗口 / 退出应用                                           | 只有此时确认框出现"正在新 worktree 中启动的任务"一行；没有创建中的记录时行为不变                                  |
| WT-22 | 无任务使用、但有改动的残留 worktree                                 | 管理弹窗允许强制删除，确认框写明会丢弃改动                                                                        |
| WT-23 | worktree 任务中打开 Git 菜单、diff、文件树、终端、编辑器            | 都作用在 worktree 上，不作用在项目主目录                                                                          |
| WT-24 | 新版本创建 worktree 任务后，退回旧版本，再升级                      | 旧版本能打开任务、不报错；"已创建 worktree"在旧版本中不显示；再升级后一切恢复（session-management 降级检查）      |
| WT-25 | 源仓库已记住某项权限，在 worktree 任务中执行同一操作                | 不再询问；在 worktree 中记住的权限，源仓库也生效                                                                  |
| WT-26 | 源仓库根目录的 `.worktreeinclude` 列出 `.env`，`.env` 被 git 忽略   | 新 worktree 中出现同样的 `.env`；日志显示 `Copied 1 file from .worktreeinclude`                                   |
| WT-27 | 源仓库没有 `.worktreeinclude`                                       | 不拷贝任何被忽略的文件                                                                                            |
| WT-28 | 匹配的条目中有符号链接，或某个文件无法读取                          | 符号链接被跳过；无法读取的文件使创建失败，错误中写明路径，可以重试                                                |
| WT-29 | 父任务 cwd 有已暂存、未暂存改动和未跟踪文件时"在新 worktree 中分叉" | 新 worktree 中三类改动都在，暂存区划分不变；父目录的 git 状态不变                                                 |
| WT-30 | 在 worktree 任务中"在当前 worktree 中分叉"                          | 菜单文字为"在当前 worktree 中分叉"；子任务 cwd 是同一个 worktree，任务行有 worktree 图标，头部显示同一 bucket     |
| WT-31 | 删除 worktree 时其中任务正在运行，或 CLI 卸载会话失败               | 删除被拒绝，目录保留，任务继续运行                                                                                |
| WT-32 | 删除检查进行中向该 worktree 的任务发送消息                          | 消息被拒绝（worktree.removing），或删除因任务忙被拒绝；不会出现任务在已删除目录中运行                             |
| WT-33 | 项目另有一个 root 位于源仓库内                                      | worktree 任务的附加目录是 worktree 中对应的路径，不是源仓库中的路径                                               |
| WT-34 | 勾选 / 取消 worktree 复选框（含主目录处于游离 HEAD）                | composer 头部高度和输入框位置不变；两个分支胶囊的文字一致                                                         |
| WT-35 | worktree 创建成功切换到会话                                         | 创建视图保留到会话时间线出现第一轮，中间没有空白帧                                                                |
| WT-36 | 项目路径的大小写与磁盘不同（macOS），CLI 重启后打开 worktree 任务   | 正常冷恢复，可以继续发送                                                                                          |
| WT-37 | worktree 任务 runtime 卸载后，先打开计划目录、附件或改名            | 冷恢复使用项目 workspace；之后订阅和发送正常                                                                      |
| WT-38 | worktree 已删除，CLI 重启后查看其任务                               | 可以查看历史（只读）                                                                                              |
| WT-39 | worktree 任务中使用官方 MCP                                         | 授权头请求通过 Host 路由，工具可用                                                                                |
| WT-40 | 桌面连接远程项目并在两个目录的任务间切换                             | 本地 worktree 能力保留；创建记录与结束事件仍读取 base Host，远端不收到 `managed-worktrees` 请求；手机/Web 不暴露创建能力 |

视觉验证：深色和浅色主题、中文和英文、桌面宽屏和窄屏。

## 13. 已核实的事实

| #   | 事项                      | 结论与依据                                                                                                                                                                                |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 分支切换器在 worktree 中  | 在 detached 的 worktree 中执行"新建并切换分支"成功，主 checkout 不变（`createGitService` 运行时验证）                                                                                     |
| 2   | 首发依赖预热会话          | `SessionPane` 首发调用 `waitForDraftSession()`；预热未启用时直接报错。所以 worktree 模式的首发由 Host 编排，不走草稿预热                                                                  |
| 3   | 草稿设置随首发提交        | 模型、模式、plan 存在 composer 草稿中，随首条 `sendText` 原子提交，不依赖预热会话                                                                                                         |
| 4   | 终端初始 cwd              | 终端服务已记录初始 cwd，并提供 `listTerminalIdsUnderPath`                                                                                                                                 |
| 5   | 退出确认链路              | Host 已向 main 上报 `runningTaskCount`，main 只在 production 且计数 > 0 时弹确认。macOS 上关闭窗口不弹确认，但会结束该窗口的 Host                                                         |
| 6   | Host 进程分配             | `ZCodeAgentProcessManager.bind()` 已把 workspace key 与进程 key 分开，可以让多个 workspace 共用进程                                                                                       |
| 7   | CLI 按 workspace key 分组 | MCP 配置池（`mcp.ts`）、workspace 配置（`v4-workspace-config.ts`）、模型运行时（`workspace-model-runtime.ts`）按 workspace key 分组；本地 sessions-index 目前按 `directory` 列出          |
| 8   | 同类应用的创建记录        | 创建记录只在应用进程内存中；会话在 worktree 建好后才创建，cwd 一次确定；创建期间退出会提示可能丢失                                                                                        |
| 9   | CLI 派生 key              | `project_id` 由目录路径生成 slug（`projectIdFromDirectory`），`permission` 表按它存储；记忆目录按工作目录派生                                                                             |
| 10  | timeline part 的校验      | 存储读取只做 `JSON.parse`；历史投影按 `timelineType` 匹配并跳过未知类型；协议 schema（旧版 `zcodeTimelinePartSchema`、V4 `timelineMarkerPayloadSchema`）为固定枚举                        |
| 12  | renderer 任务列表缓存     | session store 的 `taskListCache` / 乐观层不包含新建的 worktree 会话与 fork 子任务（2026-11-04 E2E 运行时读取为空）；按 cwd 工作的界面改读 Host tasks-index 的任务元数据（与会话头部同源） |
| 11  | 本地覆盖文件约定          | ZCode CLI 中没有 `*.local.*` 或 override 一类的本地说明 / 设置文件约定，所以拷贝没有默认清单，只认 `.worktreeinclude`                                                                     |

## 14. 返工清单（相对 `feat/managed-worktree` 现有提交）

| 部分                                                 | 处理                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Git adapter、目录布局、Trust identity resolver       | 保留；`create` 增加输出回调与文件拷贝，`remove` 增加 `force`；从 `IGitService` 中移除 worktree 方法                              |
| Hook Trust（D23）                                    | 保留                                                                                                                             |
| 管理弹窗、任务行图标、终端 cwd 记录                  | 保留；标识与删除检查改为读 `tasks.worktree_root`，删除规则按 §3.11 调整                                                          |
| "选择起点即创建"的运行位置胶囊、草稿交接             | 删除，改为复选框 + 分支胶囊 + 创建视图                                                                                           |
| `prepareSession({ worktree })`                       | 删除；创建改由 `IManagedWorktreeService.startNewTask` 编排                                                                       |
| `useSharedTaskRuntime` 中的受管 worktree 特判        | 删除；worktree 任务使用项目进程                                                                                                  |
| `forkAssistant.targetWorkspace`（跨 workspace fork） | 改为 `targetCwd`（同一 workspace，只换 cwd）                                                                                     |
| `runWorkspaceRemoval`（释放整个 workspace 进程）     | 改为按 cwd 前缀标记"删除中"并卸载相关会话                                                                                        |
| CLI                                                  | 新增 `createSession.cwd`、`worktree_creation` timeline part、按源仓库派生权限与记忆（§6.6.3）、§7.2 的状态划分；session 表不加列 |
| Host 数据                                            | 新增 `tasks.worktree_root` 列与索引的 migration（§6.6.1）；`listTasksUnderPath` 改为 `listTasksByWorktree`                       |
| 被忽略文件拷贝                                       | 新增（§3.4）：读取 `.worktreeinclude`、计算清单、按规则拷贝、输出写入创建记录                                                    |
| 新增                                                 | 创建记录与订阅、失败操作、阻止退出事项、按 cwd 工作的界面改造（§3.7）                                                            |
| E2E `git-managed-worktree.test.ts`                   | 按 §12 重写                                                                                                                      |

## 15. 后续版本

在本地和 worktree 之间迁移任务；新建任务时带入未提交改动；setup 脚本与依赖目录的特殊处理；创建记录写盘与重启恢复；自动清理、快照与恢复；远程项目支持；模型可调用的 worktree 工具与 workflow `isolation: "worktree"`（按 §5.2 经端口由 Host 执行）；阻止退出事项扩展到其他 Host 任务；Settings 中"继承自源仓库"的提示；submodule 警告；侧栏禁用 worktree 任务的拖放入口。

2026-11-05 release/staging 合并回归：macOS Electron 的既有 worktree 候选 4/4 通过，工件 `packages/desktop/.e2e-artifacts/desktop-e2e-20261104213648488-p53754-680b01a8ded1a296`。覆盖新建、带改动分叉、新旧 worktree 位置、同目录分叉及删除占用。CLI 7 文件 208 项回归通过，新增断言验证普通目录不能借用项目 key 激活 worktree 会话；真实 SQLite 验证 ACK/事实两种顺序继承 cwd、worktree_root、附加目录及占用查询。两个独立 0010 迁移在空旧库、release 已升级库与 staging 已升级库上按账本补齐，重启不重跑。候选保持 manual-review，未宣称 Windows/Linux、实体手机或远端草稿验收。

2026-11-06 服务归属回归：远程连接不再创建 worktree 代理，创建记录与结束事件固定从桌面 base Host 读取。macOS → Linux arm64 Docker 的两目录收发与切换通过，`managed-worktrees` 未知频道错误为 0（`local-docker-20261106090515-21879d`）；本地创建、分叉与管理 4/4 通过（`desktop-e2e-20261106-090648-416`）。手机/Web 的默认客户端能力探针确认不暴露该服务，手机 shared-host 首页 PRO02 1/1 通过（`desktop-e2e-20261106-090742-065`）；未覆盖实体手机或其它桌面系统。
