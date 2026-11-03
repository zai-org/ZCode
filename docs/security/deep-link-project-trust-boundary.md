# Deep Link 与项目配置信任边界

> 状态：Implemented（2026-08-06）
>
> 关联规格：`docs/specs/workspace-hook-trust.md`

## 背景

ZCode Desktop 支持 `zcode://workspace/open?path=...` 打开本地工作区，也会在项目发现范围内读取
`zcode.json`、`.zcode/config.json` 的 Hook 声明，以及 `.zcode/agents/*.md` 的 subagent profile。
外部 deep link、repository 文件和远端 workspace 都不属于用户级可信配置：确认“打开目录”不等于确认
“执行目录中的代码”。

## 安全边界

- Windows `zcode://` 协议命令必须将外部 URL 放在 `--` 之后：生产态为
  `"<ZCode.exe>" "--" "%1"`，开发态为 `"<electron.exe>" "<entry>" "--" "%1"`。
  `registerDeepLinkProtocol` 是注册 owner；每次正常启动都覆盖旧注册，避免保留不安全模板。
- Windows 打包产物在签名前关闭 `enableNodeCliInspectArguments`，使旧注册尚未更新时的
  `--inspect` / `--inspect-brk` 也不能启动主进程调试器。该设置不修改未打包的开发 Electron，
  也不关闭 Agent 启动所需的 `runAsNode`。
- 参数隔离必须发生在 Electron 原生启动解析之前。应用 JavaScript 中的 URL 校验和单实例锁
  不能替代这一边界；OAuth、支付、workspace、share 回调仍保留原有路由与校验。
- `zcode://workspace/open` 是外部输入，不能等价于用户在应用内选择目录。
- deep link 传入的 workspace path 必须在任何 filesystem probe 前拒绝 UNC / 网络路径。
- deep link 打开本地目录前必须有用户确认；用户取消时不得缓存或投递 workspace path。
- deep-link 确认只授权打开路径，不建立 Workspace Hook Trust。
- 项目配置只接受扩展声明与启停：`mcp`、`hooks`、`plugins.enabledPlugins`、`plugins.options`、
  `skill`、`command`，以及兼容设置页的 `skills[绝对路径]` 开关。自动发现的 `zcode.json`、
  `.zcode/config.json` 和显式 `projectConfigPath` 使用同一白名单。
- 项目配置中的 `network`（含代理、CA、No Proxy、超时）、`storage`（含根目录和 session DB）、
  `permission`、`features`、`memory`、`modelStream`、`logging`、`ui`、`toolConcurrency`、
  `modelAnomalyGuard`、`skills` 的运行参数，以及插件全局开关、目录、市场和卸载记录均不生效。
  这些字段在 schema 校验前排除，非法值也不能使同文件的合法扩展声明失效。新增字段默认不向项目开放。
- 用户配置、设置页注入的环境变量和可信启动参数继续控制运行参数；自定义证书仍允许用户指定任意路径。
  用户存储和插件 inventory 根目录不得由项目文件重定向，包括独立的 workspace storage 查询入口。
- 项目级 `zcode.json` 与 `.zcode/config.json` Hook 声明视为未信任代码，默认不能进入可执行路径。
- discovery 只生成 immutable `WorkspaceHookBundleSnapshot`；Runtime admission 必须在 Hook lifecycle 和进程启动前完成。
- 持久 Trust 只按 `workspaceIdentity + hookDeclarationDigest` 命中；bundle digest 用于保证审核和执行快照一致。
- Trust 只能由受信任 Host 的 `设置 → 钩子 → 工作区` 审核，或显式 `zcode hooks trust` 命令建立；repository、环境变量和普通 permission answer 都不能授权。
- managed `deny` 高于 persistent Trust，并在下一次 dispatch gate 生效。
- 用户级 Hook 与已启用插件 Hook 继续按各自既有可信来源规则运行。已启用插件（含第三方市场）的 Hook 当前照常执行，
  插件本身没有隔离；下面的 `permissionMode` 规则不能防御恶意插件。
- subagent profile 的 frontmatter `permissionMode` 按来源处理。父会话为 guarded 时，任何来源的
  `bypassPermissions`、`dontAsk` 都先收紧为 guarded。
  - 用户级（用户存储根下的 `agents/`，默认 `~/.zcode/agents`）：按声明生效。
  - 项目级 `.zcode/agents/*.md`（含附加目录）：忽略，子会话继承父会话模式。
  - 插件 agent（默认 `agents/` 目录与 manifest `agents` 声明的目录；官方与第三方同一规则）：
    只在比父会话模式更严格时生效，否则继承父会话模式。
    严格程度从严到宽为 plan、build、edit、guarded、yolo；`bypassPermissions`、`dontAsk` 对应 yolo，
    因此不会生效；`auto` 尚未实现，不参与比较，按继承处理。
    这个顺序按各模式的默认策略排列。例外：guarded 对危险命令的审批先于 allow 规则，用户配置了
    allow 规则时，build 与 edit 可能放行 guarded 仍会询问的命令。
  - 插件规则防的是：模型把任务委派给插件 agent 后，插件声明的宽松模式让子会话里模型生成的命令免去审批。

## Rollout 与回滚

```text
项目 JSON → 扩展字段白名单 → MCP trust / Hook admission / 已安装插件选项与启停
用户配置 + 可信启动输入 → 网络、CA、存储与其他运行参数 → Agent adapter
```

```text
外部 URL → Windows 协议注册 owner 写入的 exe [entry] -- URL
         → Electron 将 -- 后的内容作为数据 → 既有 Deep Link 路由与确认
旧注册 → 新 Windows 产物的 Inspector fuse 拒绝调试参数 → 正常启动后重写安全注册
```

```text
trusted embedder / Host
  ├─ workspaceHookTrustEnabled = false
  │    -> project Hook hard block
  │    -> 不读取 Trust store
  │    -> 不创建 review request
  │    -> 保留磁盘上的 Trust records
  └─ workspaceHookTrustEnabled = true
       -> discovery snapshot
       -> managed policy
       -> persistent Trust evaluation
       -> pending review or admitted dispatch
```

`ZCodeAppOptions.workspaceHookTrustEnabled` 是 trusted bootstrap 输入，不从 workspace/project 配置或环境变量解析。
通用 App 工厂默认关闭；ZCode Protocol 的 Desktop/Web/Mobile workspace Host 在受信边界显式开启。出现安全问题时，
Host 可关闭该字段恢复 hard block，不删除用户记录。该 flag 只决定是否进入 Trust admission，绝不代表自动信任。

## 观测与隐私

Workspace Hook Trust 通过现有 Logger Port 记录低频结构化事件，包括 review created、trust selected、
timeout、superseded、snapshot mismatch、policy block、Trust store failure 和 toggle/rebuild failure。
日志只包含稳定 reason code、generation、workspace identity 的 SHA-256 摘要，以及 bundle/declaration digest 的短摘要；
不得记录命令原文、脚本内容、source path、Trust payload 或 interaction response body。

## 验证要点

- 两种自动发现文件、子目录覆盖和显式项目配置均不能覆盖用户网络、证书、存储、权限或其它运行参数。
- 无用户网络配置时，项目代理不能收到请求，项目 CA 不被读取；同一 CA 通过用户配置显式设置后仍可使用。
- 含非法运行参数的项目文件仍能提供合法 MCP、Hook 候选、插件选项和技能/命令开关。
- 项目 MCP 仍需通过既有连接信任，Hook 声明仍先进入不可执行快照；项目插件目录和伪造安装根目录不能进入发现。

- Windows 生产态和开发态注册均将 `--` 放在 URL 前，重复注册仍保持安全模板；macOS/Linux
  注册行为保持不变，注册失败仍记录原有警告。
- 加入 `--` 后，OAuth、支付、workspace、share URL 在冷启动参数解析及单实例投递中保持不变。
- 真实 Electron 启动时，`--` 后的 `--inspect`、`--inspect-brk`、`--remote-debugging-port`
  不得开启调试器；Windows 发布包还须核验 Inspector fuse 已关闭，覆盖旧注册升级场景。
- Windows 发布验收覆盖新安装、旧注册升级、冷启动和已有实例，以及浏览器实际打开协议的路径。
- UNC deep link 不调用 filesystem stat，也不投递 `OpenWorkspacePath`。
- 用户取消 deep link 确认时，不打开目录。
- 用户确认本地目录后，未 Trust 的 project Hook 仍不能执行。
- flag 关闭时，即使 Trust store 已存在 exact record，也返回 `workspace_hooks_feature_disabled`，不读取记录、不发 review。
- flag 开启时，只有 exact declaration digest 命中才执行；配置变化后受影响声明重新审核。
- managed deny 能覆盖已有 record，并阻止后续 dispatch。
- stale task/run/remoteSession/generation/snapshot response 在 store mutation 前拒绝。
- 用户级 Hook、插件 Hook 和项目 subagent 权限边界不受此 rollout gate 扩权。
