# Gen UI 固定输出目录

## 目录契约

生成文件使用执行端 Host 提供的固定输出根目录，默认位于应用数据目录的
`visualizations/` 下；Agent 不回退到当前工作目录。workspace identity（缺省时使用
workspace path）与 session ID 共同决定根目录下的会话子目录。

“固定目录”是输出位置约定，不是工作区包含关系限制。用户打开 Home、文件系统根目录，
或其他包含应用数据目录的工作区时，Host 提供的输出根目录仍然有效。代码不应因为
输出根目录等于或位于工作区之内而拒绝初始化或读取。Skill 中的生成指导不作修改。

会话子目录仅组织生成文件，不是读取授权边界。读取固定 Host 输出根目录中的文件时，
不要求路径属于当前 workspace/session；fork 继承父会话的 HTML 路径后可直接加载，
不需要复制文件或改写历史消息。widget state 继续按当前 workspace/session 保存。

继续拒绝 Host 输出根目录之外的路径、根目录下的子目录或文件符号链接、非普通文件、
非法 HTML 片段及超过大小限制的文件。Host 输出根目录本身可经符号链接解析，解析后
仍须执行相同的根目录检查。

## 调用链与影响面

```text
Host 提供固定根目录 → 按 workspace/session 派生输出目录 → Agent 初始化 / 生成
                                                           ↓
界面读取请求（可引用父会话路径）→ 执行端 Host 校验根目录与文件 → 原有桌面沙箱
```

原校验把“不在当前目录生成”误解为“必须位于工作区之外”，导致 Home 工作区的
Gen UI 初始化抛错，并连带阻断依赖同一上下文初始化的技能目录和消息执行。

另一处误解是把生成目录分组当作读取隔离，导致 fork 的消息保留父会话路径后无法展示。

移除工作区包含关系限制及跨 session/workspace 文件读取限制，不修改 skill、
固定根目录选择或 fork 复制规则。

SSH / WSL / Docker / Server 的 HTML 读取必须经过远端 `gen-ui` RPC 通道。
Desktop Host 的转发注册与 RPC 合同必须包含该通道；legacy mixed services 合并时也必须
显式选用远端 `genUiService`，不能因展开本机 services 而拿本机输出根目录校验远端路径。
读取失败原样返回，不回落到本机读取，也不删除输出根目录校验。

```text
Gen UI 卡片 → workspace services → Desktop Host 转发 → Source gen-ui.readDocument
                                                         ↓
                                              执行端输出根目录校验 / 读取
Gen UI 卡片 → desktop base services → widget state / prepareSandbox → 桌面沙箱
```

workspace identity、session ID 和文件路径沿用原请求；不增加缓存、重试或文件复制。
桌面 continuous 与手机 replayable 链路保持原有边界。手机没有 Gen UI sandbox 时继续显示
既有桌面专用提示；不扩展手机 RPC allowlist。HTML 仍由执行端 Host 读取，widget state
仍属于桌面宿主。

## 提示词中的位置

会话输出目录随 session ID 变化，所以不写进 system，只写进环境公告
（` - Visualization directory for this session: <path>`，见
`apps/zcode-cli/docs/design/v2/loop/meta-user-context.md`）。App 装配直接复用官方 visualize 插件的
有效启用态；禁用或卸载时不向 runtime 提供输出根目录。因此新会话既不注入目录，也不注入
Desktop 段的整个 `Interactive views`（含控件状态说明），不另发“不可用”的替代提示。
启用且有目录时保留现有说明；其余 Desktop 上下文保持不变。
升级时按 [Visualize 加载边界](visualize-cli-loading.md) 将旧开关关闭一次，之后允许重新开启。
启停沿用 runtime 装配时机，历史提示不删除，恢复旧会话时仍允许既有环境差量撤销旧目录。
本变更只控制上下文注入，不改变 skill、文件读取、渲染或状态回传。

```text
父会话  system（快照，不含目录） + # Environment … Visualization directory: <父目录>
  │ fork：复制历史与 prompt 快照，并在复制的历史后写入一条环境更新
  ▼
子会话  system 字节与父会话相同
        # Environment update
         - Visualization directory for this session: <子目录> (was <父目录>)
```

原因：system 由 prompt 快照冻结，fork 时快照复制给子会话。目录留在 system 的 Desktop 段里时，
子会话会继续发送父会话的目录，生成文件写进父会话目录。改到环境公告后，system 可以整体冻结，
目录变化按环境更新宣告。环境更新在 fork 时写入子会话，不等子会话下一次收集输入附件：
子会话的第一个请求可能是新轮通知，新轮通知不收集附件，模型会按父会话目录写文件。
基线取子会话的模型视图（最后一次压缩之后）里最近的环境公告；视图里没有环境公告时不写，
子会话下一次公告发完整块；有公告但没有目录、且 fork 不带目标工作目录时也不写。

fork 到另一个工作目录（受管 worktree，见 `docs/git/worktree.md`）时，子会话目录按子会话的工作目录计算：
目录由 workspace 身份（没有身份时用 workspace 路径）与 session id 决定。本地 worktree 子会话没有
workspace 身份，它的 workspace 路径就是工作目录，与子会话自己的公告用同一个键。同一条环境更新
还写出新的 `Primary working directory`；父会话公告没有目录时，fork 带目标工作目录也写这条更新。
更新的写法与普通环境公告相同：基线没有完整块时写完整块，Desktop 段写法变化时同时带上新写法。

## 回归验证

- CLI 装配测试捕获实际模型请求：插件默认关闭，显式启用时保留目录与说明；无显式配置、禁用、卸载及全局关闭插件时均不注入，其他 Desktop 说明保留。
- CLI 单测覆盖：system 不含 Desktop 段与目录；环境完整块含目录与 Desktop 段；fork 后子会话的 system 字节不变，
  子会话历史在复制的消息后、fork 提示前带一条目录的环境更新，环境公告只在压缩之前时不写；旧环境元数据没有目录时补一行目录；
  fork 到另一个工作目录时，更新里的目录与子会话 runtime 自己算出的目录相同，并写出新的工作目录。
- 路径单测覆盖输出根目录位于工作区内、等于工作区、工作区为文件系统根目录，以及
  本地 / SSH workspace identity；相对路径仍拒绝。
- 文件读取测试覆盖工作区包含输出目录、跨 session/workspace 读取、根目录别名
  解析，以及既有根目录越界、符号链接、文件类型和体积限制。
- 现有 Electron Gen UI E2E 将工作区设为输出根目录的祖先，验证真实文件读取、
  渲染和页面交互；切换会话时引用同一个父会话文件，验证 fork 历史的加载语义。
  这是远程身份的本地夹具，不代表真实 SSH 传输或完整 fork 命令验证。
- 远程服务回归通过 Source → Desktop Host → Renderer 两段真实 RPC，覆盖 SSH / WSL /
  Docker / Server、legacy 合并、原始身份透传和读取错误透传；手机通道仍拒绝 Gen UI。
- Electron 夹具使用不同的本机与执行端输出根目录，并使用生产 Renderer 服务合并函数。
  验证远端 HTML 渲染、跨会话重挂载、widget state 保存在桌面，以及无 sandbox 的手机提示。
  该夹具验证服务路由和真实 Electron 沙箱，不代替真实 SSH 网络或跨操作系统实机验证。
