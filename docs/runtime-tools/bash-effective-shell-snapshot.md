# Bash Effective Shell Snapshot

## 背景

Bash tool 的 shell 选择会同时影响三类行为：

- Bash 命令实际由哪个 shell 执行。
- provider-visible 的 `# Environment` 里展示哪个 Shell。
- Explore 子任务继承到的执行环境和 prompt 环境。

过去这些信息分别从环境变量、执行 adapter、settings/runtime config 中读取，容易出现“模型看到的 shell”和“Bash 实际执行的 shell”不一致。这个文档定义统一后的运行时契约。

## 核心契约

运行时维护一个 runtime 级别的 `ExecutionShellSelection`（`config.bashShellSelection`），它是 Bash tool 的有效 shell。selection 不落库：新 session 和 cold resume 都读取用户当前的 shell 设置，和其他环境字段一样，变化通过 environment 公告告诉模型。

- 普通 session 创建和 deferred draft 预热都不解析用户配置的 shell selection。
- `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts` 是 session shell environment 的唯一 owner，负责初始化、读取和首发前的 EnvInfo patch。
- 新 session 第一次接受输入前，统一用户执行边界通过 `session/requestRuntimePreferences` 的 `user-execution` scope 向所属 Host 读取一次当前 shell 候选值，再由 `initializeSessionShellEnvironmentIfNeeded()` 初始化。该请求最多等待 15 秒；超时按协议错误阻断首次用户执行，不重试或静默回退到其他 shell。
- cold resume 与新 session 相同：resume 入口在恢复历史前用同一个读取初始化 selection，不使用 session 创建时的 shell。
- Bash tool 执行、`# Environment` 公告的 `Shell` 字段（`display.name`）、Explore 子任务的 prompt 环境和 child runtime 都使用同一个 selection。
- runtime 存活期间不热更新：用户在同一 runtime 内切换 shell 设置，当前 session 继续用已初始化的 selection；新 session 立即使用新值，已有 session 在下一次 cold resume 时使用新值。
- deferred draft session 只是新会话的隐藏预热态，不是用户已经开始的稳定会话。预热创建时不读取用户配置的 shell selection。
- legacy `session/send`、V4 `sendText`、create/resume/subscribe 都不携带 shell 候选值；Host 读取只发生在 Agent 的统一用户执行边界和 resume 入口，不能让 desktop/mobile 或各 command 入口分别维护分支。
- app 层的普通 prompt、goal external activity、expert workflow 和 script workflow 共用同一个用户执行边界。任何会启动模型 turn 或 workflow child agent 的入口，都必须先调用这个边界初始化 shell，再启动 turn 或创建子 runtime。
- Protocol 的 `session/create` / `session/resume` 不接受 shell 候选值，避免调用方误以为可以在创建或恢复阶段覆盖 session shell。
- 旧版本写入的 `runtime/bash_shell_selection` session entry 不再读取，也不迁移。

## Bash Runtime `.sh` Snapshots

Bash tool 运行时有三种名字相近但职责不同的 snapshot：

1. session shell selection
   - 由 `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts` 管理。
   - 决定当前 runtime 的有效 shell、provider-visible `# Environment` Shell 字段、Explore 继承的 shell display。
   - runtime 存活期间不会因为 settings 切换而热更新；它不是 `.sh` 文件，也不落库。

2. shell init snapshot
   - 由 `apps/zcode-cli/packages/adapters/src/exec/shell-init-snapshot.ts` 管理。
   - POSIX/Git Bash 下，adapter 首次用 login shell 执行 snapshot creation script，source 用户 rc 文件，并把 functions、aliases、shell options、PATH 写入 ZCode storage 下的 `shell-snapshots/snapshot-${shell}-${timestamp}-${random}.sh`。
   - functions/options/aliases 的导出策略：只在用户 rc 存在时导出，过滤单下划线补全函数，options/aliases 输出最多 1000 行，并在 Git Bash/MSYS/Cygwin 下过滤 `winpty` aliases。
   - snapshot creation script 使用 adapter 侧 host path 写文件；Git Bash path 转换只发生在后续真实命令 source snapshot 时。
   - 创建成功后，后续 Bash tool command 会先 source 这个 snapshot，再用非 login shell 执行真实命令，即 spawn args 从 `-c -l <command>` 变为 `-c <command>`。
   - 创建失败时降级为原行为，继续使用 `-c -l <command>`。
   - hot resume 如果仍复用同一个 adapter/manager，可以继续复用当前进程内 ready snapshot。
   - cold resume 不恢复 snapshot 文件 path；初始化当前 shell selection 后，第一次 Bash toolcall 重新创建 shell init snapshot。
   - cold resume 或新 adapter 不会扫描/复活旧 snapshot，也不会按 session/hash 复用同名文件；新进程会创建新的随机 snapshot 文件，旧残留只由 retention cleanup 处理。
   - 每次真实 Bash command 执行前都会重新检查 cached snapshot 文件是否仍可访问；如果文件已丢失，本次回退为 login shell，不跳过 `-l`。
   - 如果用户在 snapshot 创建期间取消命令或关闭 adapter，真实模型命令不会继续 spawn。
   - 当前进程创建成功的 snapshot 会在 `NodeExecutionAdapter.close()` 时尝试 unlink；异常残留会由 retention cleanup 清理。
   - retention cleanup 默认删除 `shell-snapshots/` 顶层 mtime 超过 30 天的 `.sh` 文件。
   - CMD 和 legacy shell 不创建也不 source shell init snapshot。

3. ZCode startup script snapshot
   - 由 `apps/zcode-cli/packages/adapters/src/exec/bash-startup-script.ts` 根据 execution request 的 `bashPrelude` 生成并物化；不再有 core 侧 `bash-startup.ts` descriptor。
   - 这个脚本是 ZCode 内部执行基础设施，不是 provider-visible prompt content，也不改变 tool schema。
   - `rg` fallback 始终保留；`find` / `grep` 是否映射到 `bfs` / `ugrep`，由根 Session runtime 物化时固定的增强搜索启动偏好决定，默认启用。

执行顺序是：先 source shell init snapshot，再 source ZCode startup script，最后执行模型命令和 cwd capture trailer。snapshot 文件 path 不作为 session state 持久化；cold resume 后由 adapter 基于当前 shell selection lazy 创建新的随机 snapshot。旧文件不能直接作为 ready snapshot 被恢复。

## Selection 结构

`ExecutionShellSelection` 是跨 contracts、adapters、core、bootstrap 的唯一 shell selection 数据结构。

- `dialect`：执行包装语义，当前为 `posix`、`git-bash`、`cmd` 或 `legacy-shell`。`legacy-shell` 只在 POSIX 找不到 bash/zsh 时产出（`/bin/sh`）。
- `source`：selection 来源，当前为 `auto-detected`、`user-config` 或 `legacy-fallback`。
- `path`：已解析出的可执行路径。legacy fallback 可以没有路径。
- `display.name`：provider-visible 的稳定名称，例如 `zsh`、`bash`、`Git Bash`、`cmd.exe`、`system shell`。这里禁止展示绝对路径。`dialect=cmd` 一律写 `cmd.exe`（`WINDOWS_CMD_SHELL_DISPLAY_NAME`），手选 CMD 与 Windows 回落同一写法。
- `id` / `label`：设置项或诊断展示用元数据，不作为 provider-visible contract。

Runtime config 只以 `bashShellSelection` 作为 source of truth。底层 execution adapter 的 command 仍使用既有 `shellOverride` 字段承载这个 selection，但 runtime / tool context 不再维护第二份 `bashShellOverride` 状态。

## 解析规则

macOS / Linux:

- 优先解析可用的 `zsh` / `bash`。
- 如果 `$SHELL` 本身是可执行的 `zsh` 或 `bash`，可以直接使用。
- 如果用户使用 `fish` 等非 Bash-compatible shell，不把 `fish` 作为 Bash tool shell；继续从 `PATH` 和固定路径中找 `zsh` / `bash`。
- 找不到 `zsh` / `bash` 时，返回 `legacy-fallback`，保留旧的 generic shell fallback 行为。

Windows:

- 用户显式选择 Git Bash 时，优先使用该 selection。
- 用户显式选择 CMD 时，优先使用 CMD。
- 自动模式下优先解析 Git Bash。
- Git Bash 发现由 `@zcode/shared/node` 的 Node-only 发现器提供；设置候选枚举与 CLI 复用同一规则，不修改设置字段、selection 传递、缓存或执行策略。
- 保留原固定目录优先，其次按 PATH 顺序检查所有 Git 候选。PATH 条目去掉首尾引号并跳过空项；一个 Git 没有配套 Bash 时继续下一个，不把首个 Git 的代理目录当成唯一安装目录。
- 原规则未找到时，依次补充系统 Program Files 目录、`GIT_INSTALL_ROOT`、Git for Windows 注册表 `InstallPath`（HKCU/HKLM，32/64 位视图）、Scoop 用户/全局根与配置、PATH `shims` 根线索，以及 Chocolatey PortableGit 工具根。新增安装根须有配套 `bin\\bash.exe`、`cmd\\git.exe`、`git-bash.exe`；只读取固定候选，不执行程序探测。
- 文件和安装记录读取为异步 IO。缺失、无效或不可读的安装线索继续其他来源；注册表仅查询明确安装键，有限执行时限、不重试。候选去重并保持确定顺序；非 Windows 不执行这些读取。执行准备在发现 await 后检查原有取消信号与关闭标记，停止后不继续启动 shell-init snapshot 辅助进程，仍由既有执行收口返回 cancelled。
- Scoop 根覆盖 `SCOOP`、`SCOOP_GLOBAL`、`ROOT_PATH`/`GLOBAL_PATH` 配置、当前用户的默认目录及 PATH 中的 `shims` 父目录。Chocolatey 工具根仅来自 `ChocolateyToolsLocation` 或旧版工具根变量。读取已有安装变量，不新增 ZCode 路径变量。
- 安全边界（CR-01）：不凭 `ProgramData` 或 `SystemDrive` 推导全局 Scoop / `tools\\git` 执行候选。这两类共享目录只有来自安装根变量、用户配置、PATH 或安装记录的明确线索时才参与发现；空值、失效或读取失败不恢复默认共享目录兜底。三个配套文件只是布局校验，不是属主、ACL 或签名信任校验；`source=system` 是现有来源标签，不表示可信程序。仅删除无线索共享目录探测，不新增 ACL 框架、手动路径入口或设置字段。
- 普通 PortableGit 可通过 PATH 中真实 Git 或 Git Bash 启动器所在的安装布局发现；没有 PATH、配置、变量或安装记录的任意解压目录不保证发现。不扫描磁盘，不增加手动路径入口，不将 WSL/Cygwin/MSYS2 的任意 `bash.exe` 当作 Git Bash。`git-bash.exe` 仅用于布局校验/路径线索，实际返回 `bin\\bash.exe`。
- 回归覆盖各安装来源、引号与大小写环境键、前一个 Git 无 Bash而后一个可用、失效根与记录读取失败；保留原有显式选择、CMD 回退及已初始化 selection 的短路行为。App 候选列表使用隔离布局的可重复运行时场景验收；CLI 在既有执行回归入口先测后实现。
- 找不到 Git Bash 时返回 CMD selection：`dialect=cmd`、`source=auto-detected`、`id=auto:cmd`、`path=ComSpec ?? "cmd.exe"`、`display.name=cmd.exe`，并带 cmd provider。启动形态与原 ComSpec 回落相同（`shell: <path>`，命令原样交给 cmd.exe）。
  - 原来这里返回 `legacy-shell` / `system shell`：选择层不知道执行器，执行层另读 ComSpec。模型看到 `Shell: system shell`，加上工具名 Bash，按 bash 写命令，cmd.exe 不认 ls、cat、head 等（线上冻结重放 36–42% 的下一步出现这类命令）。现在执行器只在选择层决定一次，模型、权限、Guarded 读同一份 selection。
  - 因为 dialect 变成 `cmd`，Guarded 开始按 CMD 语法匹配这些机器上的危险命令（原来 `legacy-shell` 一律 `unsupported`）；只读判定、前缀规则、startup source、embedded search 与原来相同。

## Prompt 与缓存

模型只通过 environment 公告知道当前 shell，没有单独的 shell 提醒。公告规则见 `apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`；与 shell 相关的部分：

- 每次请求比较当前 selection 的 `display.name` 与历史里最近一次环境公告的 Shell。
- 首个公告是完整 `# Environment`，Shell 是当前 selection。
- 之后 shell 不同时（通常是 cold resume 读到了新设置），追加 `# Environment update` 的 ` - Shell: <new> (was <old>)` 一行；最近一次公告的 Shell 为空（旧 Windows 会话）时不写 `(was …)`。
- Shell 是 `cmd.exe` 时，CMD 规则一律放进 Shell 行括号：完整块写 `Shell: cmd.exe (<规则>)`，update 换成 `cmd.exe` 时写 `Shell: cmd.exe (was <old>; <规则>)`。其他切换（含离开 `cmd.exe`）只写 `(was <old>)`；离开 `cmd.exe` 时若重发完整块，Shell 行也带 `(was cmd.exe)`。文本与原因见 `apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`。
- 公告随请求写库，cold resume 由 hydration 原位还原，所以只和最近一次公告比较：设置不变时不重复追加；A → B → A 每次变化都会宣告。已发送的历史前缀在多次 cold resume 之间保持不变。
- system 与工具定义不含 shell，切换 shell 不改写已发送前缀。
- 环境公告属于输入附件，遵守同一跳过规则：冷恢复后第一轮若是新轮通知（`task_notification` / `subagent_reply`），首个请求不收集输入附件，shell 变化要到工具结果之后的下一个请求才宣告。这一个请求内模型可能仍按旧 shell 写命令，Bash 已用新 shell 执行。cwd 等环境字段同样如此，不为 shell 单独开例外。

`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` 在统一用户执行边界和 resume 入口 lazy 请求一次 Host 候选值，并在 app 生命周期内复用该结果。Host 候选无效或未显式选择时，再由 CLI 运行环境的 `resolveEffectiveBashShellSelection()` 自动解析。runtime 已有 selection 时忽略候选值。

deferred draft 预热不冻结 shell；首次真实用户执行前才读取。desktop continuous、web-remote replayable、legacy/V4 prompt、goal external activity、expert workflow 和 script workflow 都必须经过同一 app/runtime admission。desktop-attached remote 通过 workspace-scoped Agent service 请求回到 desktop shared Host 的本地 `SettingService`；手机 `/remote` 复用该 Host。relay/main 不保存 shell 设置，远端 `~/.zcode/v2` 也不作为 desktop-attached workspace 的权威源。

旧 Host 返回 `-32601` 或 Agent 尚未连接 Host 返回 `-32020` 时，保持 CLI 自动解析；其他协议、resolver 或传输错误原样失败。cold resume 也走这条规则：这两种情况下用户选择的 shell（如 CMD）不会生效，改用自动解析结果，变化同样经环境公告告诉模型。这里不新增 per-send pull、设置广播、缓存同步或 Session 级 setting snapshot。

## Explore 继承

Explore 子任务继承父 runtime 的有效 shell selection：

- child prompt 的 `EnvInfo.shell` 使用父 selection 的 `display.name`。
- child runtime 的 Bash tool 执行也使用同一个 selection。

这样 Explore 里模型看到的 Shell 和真实 Bash 执行路径保持一致。

## 非目标

- 不在 provider-visible 文本里暴露绝对 shell 路径。
- 不把 app-global shell 设置复制为 remote-scoped setting；远端只通过所属 shared Host 按需读取一次。
- 不因为自动解析失败而让 Bash tool 直接 spawn error；解析失败继续走原来的 generic shell fallback。
