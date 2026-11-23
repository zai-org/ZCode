# Command Center

## CLI Process Identity

CLI 命令名继续保持 `zcode`，用于兼容现有 npm `bin`、脚本、help 和文档示例。普通 CLI 与 Agent 的进程名保持 `zcode-cli`；通过 `__zcode-plugin-host` 启动的 MCP 插件进程使用 `zcode-mcp-<plugin-name>`，避免在进程查看工具中把插件宿主误认为 Agent。

入口层先按启动子命令选择角色，再在加载 bootstrap、TUI、provider、storage 或插件模块之前设置 `process.title`。插件名取自已有 `ZCODE_PLUGIN_ID` 的 `@` 前部分，去除首尾空白并转为小写；名称须符合 `[a-z0-9][a-z0-9._-]{0,127}`。缺失或无效时使用 `zcode-mcp`，不从文件路径猜测名称。该值仅用于显示，不参与权限或插件身份判断。普通命令即使带有插件 ID 环境变量，也保持 `zcode-cli`。

该行为不新增环境变量，不依赖平台 shell 或二进制文件名；普通 Node bundle、`tsx` 开发入口和 SEA binary 共用入口命名逻辑。存储迁移与 `--prepare-storage` 保持不改名，避免影响承载它们的 Host Worker。操作系统工具对名称的显示和截断仍受平台限制。

`zcode doctor --json` 必须同时报告 `cli.processName` 和 `runtime.processTitle`，普通 `zcode doctor` 输出也应展示当前进程名，便于脚本和人工诊断验证实际运行进程已经应用该契约。

ZCode 的 slash command 入口放在 CLI/bootstrap 侧，而不是 TUI 侧。TUI 只把用户输入交给一个 `submitPrompt` 函数，并根据 runtime events 渲染进度。

TUI 的 slash command 候选列表见 [`tui-slash-command-suggestions.md`](./tui-slash-command-suggestions.md)。候选列表只消费 command center 暴露的只读命令面，不拥有命令执行逻辑。

当前注册的内置命令：

- `/btw <question>`: 旁路回答一个简短 side question；不创建普通 turn，不把问题或答案写入主会话上下文，不中断正在运行的主 turn。详见 [`btw-side-question.md`](./btw-side-question.md)。
- `/compact [instructions]`: 走现有 core manual compact 路径，允许附加总结指令。
- `/expert [status|resume|stop|<task>]`: 启动或管理 expert workflow；带任务时默认把当前 session 切到 `yolo`，并通过 workflow runtime 调度多个 agent activity。
- `/effort [list|<level>]`: 查询或切换当前 session 的 reasoning/thinking 深度；可选 level 来自当前模型 catalog/config 的 reasoning metadata。交互式 TUI 在 composer 内用类似 `/model` 的候选 popup 选择，提交显式 `/effort <level>`。`/variant` 是输入兼容别名。
- `/fork [latest|checkpointId]`: 从 workspace checkpoint 分叉新 session；无参数或 `latest` 使用最新 checkpoint，有参数时按 checkpoint id 分叉。
- `/help [command]`: 本地只读展示 slash command 帮助；不创建 session、不发模型请求、不访问外部 I/O。有参数时只展示目标命令的用法，参数可带或不带开头的 `/`。
- `/login`: 使用 ZCode/Z.AI CLI OAuth device flow 登录；命令层调用 bootstrap 登录服务，不创建普通模型 session。Init 返回授权 URL 后必须立刻通过 assistant transcript message 展示链接，避免 SSH/远程终端场景只在宿主机打开浏览器而用户看不到可复制链接。
- `/locale [auto|en-US|zh-CN]`: 查询或切换当前 UI 语言，并把请求值持久化到配置文件；`/language` 是输入兼容别名。
- `/logout`: 清理共享 credential store 中的 ZAI 登录态；不创建普通模型 session。
- `/mcp [list|status|connect <server>|disconnect <server>]`: 查询或管理当前 session 可见的 MCP server 连接状态；命令层只调用 app/server 暴露的 MCP 管理接口。
- `/mode [plan|build|edit|yolo]`: 查询或切换当前 TUI session 的 permission mode；交互式 composer 输入 `/mode` 时打开与 `/model` 同形态的本地 popup，选择项提交显式 `/mode <mode>`；`edit` 自动接受 `Write`、`Edit`、`ApplyPatch` 等文件编辑工具，其他高风险或非编辑操作仍按 build 策略确认；`auto` 可显示但暂不允许从 TUI 切入。
- `/model [list|main|lite|provider/model]`: 查询或切换当前 session 的主模型；可选模型来自 `model.main`、`model.lite` 和所有已配置 `provider.*.models`，状态归 app/server 保存，TUI 不持有模型状态。
- `/new`: 启动一个新的 root session，并把当前 TUI 后续 prompt 切到该 session。该命令不发送模型请求、不恢复最近会话、不复制旧 session 的 transcript 或 checkpoint；permission mode/model 等 session runtime 配置按当前 CLI/TUI 配置重新初始化。创建失败时错误向上冒泡，由 TUI 按普通命令失败显示。`/clear` 是它的别名，行为必须完全一致。
- `/resume [sessionId]`: 有参数时恢复指定 session；无参数时恢复当前目录最近活动的 root session。这里的 `sessionId` 是 ZCode session id，通常形如 `sess_...`，对应 CLI JSON 输出里的 `sessionId` 字段，不是 `traceId`、`turnId`、`messageId` 或 `toolCallId`。`/continue` 是 `/resume` 的别名。
- `/rewind [latest|checkpointId]`: 走 core checkpoint/rewind 路径，查看最新 checkpoint 或按目标 checkpoint 恢复 workspace 文件。
- `/skill`: 只读列举当前工作目录可发现的 skills，不创建 session、不发模型请求、不调用 `Skill` tool。
- `/skill <name> [task]`: 强制下一次 prompt 先加载指定 skill，再继续执行任务。
- `/workflow [what the workflow should accomplish]`: 内置 prompt 型命令，与 `/init` 同路：TUI/headless 只识别名字并把原文交给 `submitPrompt`，bootstrap 的 builtin prompt resolver 展开成「先用 `Skill` 工具加载内置 `dynamic-workflows` 技能，再写脚本调 `CreateWorkflow`」的提示词（`$ARGUMENTS` 替换）。命令正文与技能都随 CLI 内置，不依赖任何插件；App 协议侧受动态工作流灰度门约束（`docs/dynamic-workflow/launch.md`「Gray release」）；TUI/headless 受进程参数 `--workflow-mode` 约束，缺省 `disabled` 时 `/` 面板与 `/help` 不列出该命令，TUI 手打给本地提示、不发模型，headless 报错退出 1。`workflow` 是保留名，同名自定义命令不广播、不展开。
- `/dwf [list|cancel [runId]|resume <runId>]`: 列出、取消或恢复本会话的动态工作流 run（`docs/dynamic-workflow/launch.md`「`/dwf`」）。`--workflow-mode disabled` 下 `list`/`cancel` 照常，`resume` 在请求服务端之前以同一句 disabled 提示拒绝。
- `/goal [pause|resume|clear|replace <objective>|<objective>]`: 查询或管理当前 session goal；设置或恢复 active goal 后，runtime 在空闲且不处于 plan mode 时继续推进目标。`/target` 是兼容 alias，只用于接收旧客户端和旧脚本输入；help、suggestion 和新文档必须展示 `/goal`。

所有 `/goal` 写操作都必须先走 bootstrap/app 暴露的 goal/target 兼容接口，再由 runtime 写出兼容 `target_changed` session event。TUI、ZCode app-server 和未来 replay/debug 投影消费事件，不解析命令返回文案来判断 goal 状态。

进程级 CLI 命令：

- 全局 `--cwd <path>`: 指定本次 CLI command 的有效工作目录。该目录会作为 session `workingDirectory`、dotenv 查找起点、skill discovery 目录、`--continue`/`/resume` 最近 session 查询目录以及 `doctor` 的报告目录。相对路径必须按 CLI 启动时的当前目录解析为绝对路径；空路径、不存在路径、不可访问路径或非目录路径必须在 CLI 入口边界返回明确错误，并且不得创建 app/session、不得发送模型请求。实现不得调用 `process.chdir()`，避免污染 TUI、ZCode app-server、多 session 和后台任务所在的 Node.js 进程。`--cwd` 是 CLI 参数覆盖，不新增 `ZCODE_*` 环境变量；若后续要增加环境变量形式，必须先补充用途、优先级、错误行为和测试覆盖。
- 全局 `--prompt <text>`: 作为脚本友好的单轮 headless 入口。未显式传入 `--mode` 时，CLI 必须以 `yolo` permission mode 创建 runtime，避免无交互 broker 的 headless prompt 在常见写文件、执行命令路径上停在审批流；显式 `--mode build|edit|plan|yolo` 仍然优先于该默认值。该默认只属于 `--prompt` 入口，不改变无参数 TUI、`zcode tui`、ZCode app-server session 或单独 `--target` 的初始化 mode。
- 全局 `--browser-use=headless`: 为 `--prompt`、`--target` 和 TUI 显式启用 CLI managed CDP Browser Use。CLI 在首次 backend discovery 时启动 native headless Chromium，只有完成 CDP handshake 后才返回 `type: "cdp"` descriptor。该参数不使用 `agent-browser`，不改变 browser-use plugin/node_repl 模型入口；plugin 禁用时不得启动 Chromium。`zcode app-server` 使用该参数必须 fail closed，避免 Desktop/Web Remote shared-host 链路获得第二个 browser runtime。
- 全局 `--browser-executable <absolute-path>`: 指定 `--browser-use=headless` 使用的 Chrome/Chromium 可执行文件；不能单独使用。省略时只查找本机已安装 browser 和 Playwright cache，P0 不联网下载。路径或可执行性错误必须发生在 app/session 创建前；实现使用跨平台 path/fs API 和参数数组 spawn，不经 shell，不默认添加 `--no-sandbox`。
- 全局 `--browser-state <path>` / `--no-browser-state`: 为 `--browser-use=headless` 注入只读的 Playwright storage state 登录态。不传参数时自动加载 `~/.zcode/cli/browser-state.json`（存在时）；`--no-browser-state` 关闭默认加载；两者互斥，且都不能脱离 `--browser-use=headless` 使用。文件缺失或校验失败必须发生在 app/session 创建前。每个 session 创建 BrowserContext 时重新读取文件，会话中的登录变化不写回。完整合同见 `docs/browser-use/2026-11-17-cli-browser-state-spec.md`。
- 全局 `--workflow-mode <disabled|onDemand|alwaysOn>`: 决定本进程 TUI 与 headless（`--prompt`、`--target`）会话的动态工作流面，语义同服务端 `dynamicWorkflow.mode`（`docs/dynamic-workflow/launch.md`「The standalone CLI: `--workflow-mode`」）。**缺省为 `disabled`**。取值用 shared 的 `normalizeDynamicWorkflowMode`（精确拼写、忽略首尾空白），非法值在 CLI 入口报错并列出三个取值，退出码 1，不创建 app/session。`app-server`/`agent-server` 由 Host 决定 mode，带该参数即报作用域错误；`login`、`plugins`、`skills`、`doctor` 等不建会话的子命令同样报错。入口把 mode 一次性折成两个显式 runtime 字段 `dynamicWorkflowEnabled = mode !== "disabled"`、`dynamicWorkflowToolsOnDemand = mode === "onDemand"`，写进本进程创建的每个 app（含 `/new`、`/resume`、fork）；mode 不落盘，resume 到不同 mode 静默切换。不新增环境变量或配置键。
- 全局 `--target <objective>`: 用于兼容 headless goal 场景，等价于在 headless session 里执行 `/goal <objective>`；CLI 必须复用 command center 的 goal 语义，而不是重新发明一套 target-only 控制流。`--resume` / `--continue` 时作用于恢复出来的 session；未指定时作用于新建 session。`--target` 不与 `--prompt` 组合；需要显式 slash command 形态时使用 `--prompt "/goal ..."`。实现不得把 `--target` 改造成环境变量。
- 全局 `--target-replace`: `--target` 的显式覆盖确认开关。若当前 session 已有 goal，而未显式提供 `--target-replace`，CLI 必须在本地返回明确错误，不得静默覆盖 goal，也不得发送模型请求。`--target-replace` 单独出现时必须报错。
- `zcode skills list`: 只读列举当前工作目录可发现的 skills。它复用 bootstrap 的 skill discovery 接口，不启动 TUI、不创建 session、不发模型请求；`zcode skills` 等价于 `zcode skills list`。普通输出展示 name、scope/source、description 和 path；`--json` 输出结构化 skills 与 diagnostics；`--verbose` 在普通输出后追加 diagnostics。
- `zcode commands list`: 只读列举当前工作目录可发现的自定义 prompt commands。它复用 bootstrap 的 custom command discovery 接口，不启动 TUI、不创建 session、不发模型请求；`zcode commands` 等价于 `zcode commands list`。普通输出展示 `/name`、argument hint、scope/source、description 和 path；`--json` 输出结构化 commands 与 diagnostics；`--verbose` 追加 diagnostics。
- `zcode login`: 使用 ZCode/Z.AI CLI OAuth device flow 登录，浏览器授权后把敏感 token 写入与桌面 Z Code 共享的 `~/.zcode/v2/credentials.json`，并只在 `~/.zcode/cli/config.json` patch 非敏感 provider/model 默认配置。`--no-browser` 只打印授权 URL，不自动打开浏览器，仍继续轮询。
- `zcode logout`: 清理共享 credential store 中的 ZAI 登录态；如果 `oauth:active_provider` 当前是 `zai`，同步清空 active provider。
- `zcode doctor`: 输出运行时和打包假设检查，是 CLI 健康检查和 smoke-test 的唯一进程级入口。

`zcode hello` 不再是受支持命令。CLI 不保留无业务语义的 greeting/smoke-test 命令；脚本、文档和测试需要使用 `zcode doctor` 或 `zcode --version` 表达健康检查意图。

ZCode protocol client 通过协议原生能力承载 session/config 操作，因此只广播只读帮助和 prompt 型命令：

- `help`: 对应 `/help [command]`，由 bootstrap 直接返回当前 ZCode app-server command surface，不创建模型 turn。
- `compact`: 对应 `/compact [instructions]`。
- `workflow`: 对应 `/workflow [what the workflow should accomplish]`，`source: "builtin"`，紧随 `goal` 之后广播；灰度门关闭时整行不广播，手打 `/workflow` 也不展开。
- `goal`: 对应 `/goal [pause|resume|clear|replace <objective>|<objective>]`，由 bootstrap 本地读写 session goal；已有目标时 `/goal <objective>` 与 `/goal replace <objective>` 都按替换处理，并继续通过兼容 `target_changed` / `_meta.zcode.target` 投影状态；`/target` 只作为输入兼容别名，不广播给新客户端。
- `skill`: 对应 `/skill <name> [task]`，由 bootstrap 改写成显式 `Skill` tool 调用要求；ZCode app-server 侧 skill discovery 仍由协议原生 skill UI 承载，不把 `/skill` 裸命令解释成列表。

App 的「计划模式」是 Composer 本地列表操作，选中复用标准 Plan 开关；协议目录不再广播
`/plan [task]`，CLI 不提供对应的 prompt 展开。`plan` 保持保留名，避免自定义命令接管该入口。
App 的具体交互见 [计划模式快捷入口](../../../../../docs/plan-slash-command.md)。

ZCode app-server `/help` 只展示 ZCode app-server 已广播的命令，不能把 local-only 的 `/mode`、`/model`、`/resume`、`/mcp` 等命令混入，避免 client 看到不可执行的本地 TUI 操作。

`/btw` 暂不进入 ZCode app-server `available_commands_update`。ZCode app-server 客户端需要 side-result UI 后，应通过 `zcode.dev/session/sideQuestion` 扩展方法请求旁路回答，而不是把 `/btw` 作为普通 prompt command 广播或注入主会话。

ZCode app-server 的 command 广播使用 `available_commands_update` session update；不要把这些命令塞进 `initialize` 或 `session/new` 响应体，也不要让 transport 层理解 ZCode command 语义。

命令识别、参数解析和会话切换在 command 层，UI 只负责触发和显示结果。后续如果要加 command palette、自定义命令或 MCP prompt command，继续扩展 command center，不把具体命令分支塞进 TUI。

成功处理的 slash command 应通过 input-history 端口 best-effort 记录原始命令文本，供 TUI `Up` 历史召回使用；例如 `/help` 召回应恢复 `/help`，而不是丢失本地命令或恢复展开后的 prompt。历史写入失败不得影响命令响应。包含 API key 等敏感参数的 `/login` 形态不得写入历史。

自定义 prompt command 的设计见 [`custom-commands.md`](./custom-commands.md)。该能力规划为 command center 的动态命令来源：markdown 文件只定义可复用 prompt 模板，发现和读取通过 adapter，TUI/ZCode app-server 只消费只读命令面，最终执行仍进入普通 runtime turn。P0 目标兼容常见的 `.claude/commands/*.md` 文件形态，同时优先支持 ZCode 原生 `.zcode/commands` 与 `.agents/commands`，并把 `allowed-tools`、`model`、动态 shell/file 展开等高风险能力纳入权限和 I/O 边界。

`/help` 测试覆盖：

- slash command parser 将 `/help` 与 `/help model` 识别为已知命令。
- command center 执行 `/help` 时不创建 app、不发送模型 prompt，并返回当前 command surface。
- command center 在 history source 可用时把 `/help` 记录为 `slash_command`，但不记录 API-key login 命令。
- 非交互 `zcode --prompt /help` 直接输出同一份 command surface，不创建 runtime。

CLI process identity 测试覆盖：

- 入口层设置的进程名常量为 `zcode-cli`，且普通命令名仍为 `zcode`。
- `zcode doctor --json` 输出 `cli.processName = "zcode-cli"` 和 `runtime.processTitle = "zcode-cli"`。
- 普通 `zcode doctor` 输出包含当前进程名，方便手动诊断。
- 真实插件子进程在模块导入时已显示 `zcode-mcp-<plugin-name>`；Node 与 desktop bundle 均验证该行为，同时保留插件入口不求值 Agent 模块的约束。
- 插件 ID 缺失或无效时显示 `zcode-mcp`；普通命令不受插件 ID 环境变量影响。

Headless `--prompt` 测试覆盖：

- `--prompt` 未传 `--mode` 时传给 runtime 的 permission mode 是 `yolo`。
- `--prompt --mode build|edit|plan|yolo` 保留显式覆盖，不被 headless 默认值改写。

CLI Browser Use 测试覆盖：

- `--browser-use` 只接受 `headless`；`--browser-executable` 单独使用或路径无效时在 app 创建前失败。
- prompt/TUI 把同一个 managed CDP runtime 注入当前 app；session replacement 关闭旧 context，不泄漏 tab。
- browser-use plugin disabled 时通用 node_repl 仍可用，但不启动 Chromium、不注入 browser broker。
- app-server 拒绝 headless 参数，不改变 Desktop/Web Remote shared-host ownership。
- `--browser-state` / `--no-browser-state` 的来源解析、互斥、默认文件发现、启动前失败与每 session 注入，验收用例见 `docs/browser-use/2026-11-17-cli-browser-state-spec.md` §9。
- Linux 无 `DISPLAY` 的真实 Chromium E2E 必须经过 MCP node_repl、plugin browser-client、broker 和 port，
  不能用直接调用 adapter 的 mock 冒充 Browser Use 全链路。

`--workflow-mode` 测试覆盖（launch.md DWG-14 ～ DWG-17）：

- TUI 与 `--prompt` 缺省写 `dynamicWorkflowEnabled: false`；`onDemand` / `alwaysOn` 写对应两个布尔；TUI 的 `/new`、`/resume` 沿用同一对；非法值退出 1 且不建 app。
- `app-server`、`agent-server`、`login`、`skills` 带该参数退出 1；`--prompt`、`--target`、`tui` 接受。
- `disabled` 下 TUI 的 `/` 建议与 `/help` 不含 `workflow`；`/workflow` 给本地提示且不调 `submitPrompt`；`/dwf list`/`cancel` 照常，`/dwf resume` 不调 `resumeWorkflowRun`。
- `disabled` 下 headless `-p "/workflow ..."` 报错退出 1、不建 app；`--workflow-mode alwaysOn` 时照旧走普通 prompt 路径。

Headless `--target` 测试覆盖：

- `--target` 单独使用时走 headless `/goal ...` 语义；与 `--prompt` 同时出现时在 CLI 入口边界报错。
- `--target-replace` 允许覆盖现有 goal；`--target-replace` 单独出现时报错。
- `--prompt "/goal ..."` 与单独 `--target ...` 都会经过同一条 command center goal 语义；`--prompt "/target ..."` 暂时保留兼容；headless 无法交互确认替换时必须返回明确错误，不得静默丢弃 selection。

## TUI `/model` 持久化

`/model <target>` 成功切换主模型时，app/server 必须同步更新当前 runtime 的 model ref 和配置文件里的 `model` 主模型选择，避免 TUI 里看到的模型只停留在内存态。TUI 仍只调用 command center，不直接读写配置文件。

交互式 TUI 中，composer 输入 `/model` 或 `/model ` 时在输入框上方打开 command-shaped model popup；弹窗按模型 id、alias、名称和生成的 `/model <provider/model>` 命令文本过滤。行布局左侧优先显示模型名称，右侧右对齐显示弱化的 provider 名称。Up/Down 移动高亮，Enter 通过显式 `/model <provider/model>` 提交切换，Tab 只把高亮模型补全进输入框。提交空 `/model` 和 `/model list` 保留纯文本列表，用于复制、排查和非 popup 客户端。

持久化目标按已加载配置源选择：优先更新包含 model 配置的 project config，其次更新包含 model 配置的 user config。环境变量、CLI override 和 session 注入只作为运行时覆盖，不作为 `/model` 的落盘目标。没有可写配置源或写入失败时，`/model` 返回失败并保持当前 runtime model 不变。

配置写入只 patch 主模型选择：字符串形态的 `model: "provider/model"` 继续保持字符串形态；对象形态的 `model.main` 被替换，`model.lite`、`provider`、`mcp`、`skills`、`permission` 等其它字段必须保留。写入由 config adapter 负责 atomic write 和跨平台路径处理，日志不得输出 API key、headers 等敏感字段。

测试覆盖：

- config adapter 能在字符串和对象两种 model shape 下 patch 主模型并保留其它字段。
- bootstrap `setModel()` 在写入配置成功后才更新 runtime model。
- TUI `/model` wiring 继续只经过 app/server `setModel()`，不在 TUI 层新增业务状态。

## TUI `/effort` 思考深度

`/effort` 是本地 command-center 命令，不发送模型请求。它只作用于当前 session 的主模型 reasoning/thinking provider options，并把成功选择的 level 写入 `local_setting(model.reasoningLevel)` 作为全局偏好，供后续新 session 在当前模型支持该 level 时复用。`/variant` 是完全等价的输入别名；help 和新文档展示 `/effort` 为主命令。

可选 level 必须来自当前模型的 catalog/config reasoning metadata。没有 reasoning metadata、reasoning disabled 或 level 为空时，命令返回“当前模型不支持 effort selection”的本地提示，不创建普通 turn。用户输入不支持的 level 时返回当前可用列表，并保持 runtime provider options 不变。

交互式 TUI 中，输入 `/effort`、`/effort `、`/variant` 或 `/variant ` 时，composer 使用与 `/model` 相同形态的本地候选 popup 展示并过滤可选 level；Tab 将当前候选补全成显式 `/effort <level>`，Enter 提交时也解析为显式 `/effort <level>`。TUI 只消费 app/server 暴露的可选 level 列表，不直接解析 reasoning metadata、不保存业务状态。提交空 `/effort`、`/variant`、`/effort list` 或 `/variant list` 时，command center 返回纯文本列表，用于复制、排查和非 popup 客户端。

切换成功时 app/server 必须同步更新 runtime `modelProviderOptions`，返回新的 `thoughtLevel` 投影给 TUI/ZCode app-server。写入全局偏好失败时记录结构化 warning，但当前 session 已切换的 runtime 状态保持成功，避免本地偏好存储故障阻塞用户继续工作。

测试覆盖：

- slash command parser 将 `/effort` 和 `/variant` 识别为同一命令，并保留 `rawName`。
- TUI composer 输入 `/effort` 或 `/variant` 时打开本地候选 popup，Tab/Enter 选择候选后提交显式 `/effort <level>`。
- command center 执行空 `/effort` 或 `/effort list` 时返回纯文本列表；执行 `/effort <level>` 时只调用 app/server `setThoughtLevel()`，不发送模型 prompt。
- bootstrap `setThoughtLevel()` 更新 runtime provider options、返回 `thoughtLevel`，并尽力写入全局 reasoning level 偏好。
- 后续新 session 在没有显式 runtime provider options 时读取全局 reasoning level；若当前模型不支持该 level，则回退到模型默认 reasoning level。

## TUI `/locale` 持久化

`/locale` 是本地 command-center 命令，不发送模型请求。无参数时展示当前 effective locale 和可配置值；带 `auto`、`en-US` 或 `zh-CN` 时调用 app/server 暴露的 `setLocale()`，成功后返回新的 effective locale 给 TUI。TUI 只消费返回结果里的 `locale` 投影并重新选择 copy catalog，不直接读写配置文件，也不保存业务状态。

持久化目标按 UI 语言的配置归属选择：如果当前 project config 明确包含 `ui.locale`，更新该 project config；否则更新 user config，缺失时创建 `~/.zcode/cli/config.json`。CLI `--locale` 是当前进程覆盖，但 TUI 内 `/locale` 成功后可以覆盖当前进程里后续 `/new`、`/resume` 创建 app 时使用的 locale。

写入只 patch `ui.locale`，必须保留 `model`、`provider`、`mcp`、`skills`、`permission` 等其它字段。`auto` 按请求值落盘，当前进程 effective locale 继续按 adapter 检测结果解析；检测不到支持语言时为 `en-US`。写入失败时返回明确错误，并保持当前 effective locale 不变。

测试覆盖：

- slash command parser 将 `/locale` 和 `/language` 识别为同一命令。
- command center 执行 `/locale` 查询时不创建模型 turn。
- command center 执行 `/locale zh-CN` 时调用 app/server `setLocale()`，返回 `locale` 投影供 TUI 切换 copy catalog。
- config adapter 能 patch 或创建 `ui.locale`，并保留其它配置字段。
- bootstrap `setLocale()` 在配置写入成功后才更新 effective locale。
- CLI TUI wiring 在 `/locale` 后让后续 `/new` app 使用新的 locale override。

## TUI `/new` 行为

`/new` 是 TUI 内的会话切换命令，`/clear` 是完全等价的别名。Command center 通过 bootstrap/CLI 提供的 `newApp` 工厂创建一个不带 `sessionId`、不带 `resume` 标记的新 app/runtime，并把它设为当前 active app。新 app 会立即获得新的 session id；当前持久化实现仍按 runtime 规则在该 session 的首个 turn 写入 session store。TUI 继续只调用 `submitPrompt`，不直接访问 session store，也不保存业务 session 状态。

返回给 TUI 的响应必须包含新 session id，便于用户在首个 turn 持久化后复制到 `--resume` 或 `/resume <sessionId>`。响应还应要求 TUI 重置当前 session 投影，避免新 session 面板继续显示旧 todo、token 或 background terminal 状态。TUI 收到不携带 `restoredMessages` 的 session reset 结果时，必须清空当前 transcript 后再追加本地命令确认；`/resume` 这类携带 `restoredMessages` 的 reset 结果则用恢复出来的 transcript 替换当前显示。如果当前 client 没有提供 `newApp`，返回明确的不可用提示；如果创建 app 失败，保留原始错误链，让 TUI 的现有错误显示处理。

测试覆盖：

- slash command parser 将 `/new` 识别为已知命令。
- slash command parser 将 `/clear` 识别为 `/new` 的别名，并保留原始 `rawName` 便于帮助和审计显示。
- command center 执行 `/new` 时不调用模型 prompt、不调用 `/resume` 的最近会话解析，并返回新 session id。
- command center 执行 `/clear` 时复用 `/new` 的同一路径，返回同样的 session reset/session id 结果。
- CLI TUI wiring 在 `/new` 后把后续 prompt 发送到新创建的 active app。
- TUI transcript 合并在 session reset 且没有 `restoredMessages` 时清空旧消息，避免新 session 继续占用旧会话显示空间。

## Auth Login Setup

`/login`、`/logout` 与进程级 `zcode login` / `zcode logout` 共用 [`auth-login.md`](./auth-login.md) 的 bootstrap service。OAuth、打开浏览器、credential 读写、配置 patch 都放在 adapter/bootstrap 层；core 不读取环境变量、不直接网络请求、不直接写配置文件。

保存 token 时复用桌面 Z Code 的 `~/.zcode/v2/credentials.json` 加密 key-value store。`~/.zcode/cli/config.json` 只 patch provider/model 相关非敏感字段，保留已有 `mcp`、`skills`、`permission` 等配置；新配置使用 provider-first shape，不恢复 bak 的 flat `provider/model/baseURL/apiKey` 配置。

测试覆盖：

- slash command parser 将 `/login`、`/logout` 识别为已知命令。
- command center 执行 `/login`、`/logout` 时不创建 app、不发送模型 prompt。
- 进程级 `zcode login` 能通过注入的 bootstrap login service 输出授权 URL 与登录成功用户。
- 进程级 `zcode logout` 能通过注入的 bootstrap logout service 输出清理结果。
