# 设置页「个性化」（用户自定义指令）

## 背景

用户自定义指令（Personalization）能力：用户写一段全局指令，Agent 在所有会话中都遵守。落点在设置页「Agent 能力」分组的第一项「个性化」。

交互只有一层：点击侧栏「个性化」直接进入编辑器，不经过列表入口 → 二级编辑页的跳转。

## 单一事实源：`~/.zcode/AGENTS.md`

编辑器读写的文件就是 CLI 已有的用户级默认指令文件 `{home}/.zcode/AGENTS.md`，不新增存储：

- CLI 侧 `apps/zcode-cli/packages/adapters/src/context/index.ts` 的 `resolveUserInstructions` 会把它作为 `scope: "user"` 的指令源，与 workspace `AGENTS.md` 一起注入每个会话的 Request User Context（读取上限 100KB，超出截断）。
- 因此「保存即生效于后续所有会话」，无需协议或 CLI 改动；文件缺失或内容为空等价于未配置。
- home 解析必须与 CLI adapter 完全一致：`env.HOME || env.USERPROFILE || os.homedir()`。不使用 `ZCODE_DATA_BASE_DIR`（CLI 读该文件时忽略它），也不使用 `ZCODE_DESKTOP_HOME_DIR`（agent 子进程不认）。e2e 会把 `HOME`/`USERPROFILE` 指到隔离目录，链路天然一致。
- onboarding 的 CLAUDE.md 迁移（settings-sync，见 `packages/services/src/settings-sync/settingsSyncService.ts`）写同一个文件，两者共存：都只是对该文件的普通读写。

## 服务边界

- 能力挂在 `ISettingService`：`getUserInstructions()` 返回 `{ content, filePath }`（文件缺失时 `content` 为空串）；`saveUserInstructions(content)` 原子写回并按需创建 `~/.zcode` 目录。
- **写入顺序由服务端保证（CR-01）**：`saveUserInstructions` 进程内 FIFO 排队并持有该文件的原子锁——`atomicWriteText` 只保证单次替换完整，慢 IO 下旧写的 rename 晚到会用旧内容覆盖新内容；排队后队尾写入即最新草稿。`getUserInstructions` 先排空写队列再读，保存后立即重开不会读到旧内容。多 Host 跨实例并发写本文件尚无版本仲裁（当前桌面为单 Host，不构成现实路径）。
- **建目录在取锁之前（CR-01 回归修复）**：`acquireFileLock` 以不带 recursive 的 `mkdir` 创建锁文件，`~/.zcode` 不存在时取锁直接 ENOENT 失败；因此「按需创建目录」必须发生在取锁前。桌面 Host 启动即写 `~/.zcode/v2`，实际很难遇到目录缺失，但该顺序保证任何环境（如 CLI 从未运行过的 home）首次保存仍能成功。UI 级 E2E 无法构造「应用已启动但 `~/.zcode` 缺失」（启动本身会创建目录），该分支由顺序结构保证。
- **文件权限固定私有（CR-01 权限）**：写入用 `atomicWritePrivateTextFile`（临时文件 `0600` 后 rename）。不能用不带 mode 的 `atomicWriteText`：rename 换 inode 后既有 `0600` 文件会放宽为 umask 默认（常见 `0644`），同机其他账号可读用户指令。固定 `0600` 只会收紧、不会放宽既有权限。
- **字节上限与 Agent 读取一致（SG-01）**：共享常量 `USER_INSTRUCTIONS_MAX_BYTES`（`packages/shared/src/userInstructions.ts`，100KB，与 CLI adapter 的 DEFAULT_MAX_BYTES 对齐、两侧改动须同步）。服务端 `saveUserInstructions` 超限抛 `user_instructions_too_large`（最终防线，防其他 RPC 调用方绕过 UI）；UI 显示 UTF-8 字节计数（`x KB / 100 KB`），超限阻断保存并提示，防止「保存成功但 Agent 静默截断」的误判。
- UI **仅桌面本地入口**渲染编辑器（`isDesktop`）：手机远控的 base services 可能归属远程 Source——`remoteWorkspaceServiceCollection` 把远程 Source 的 `settingService` 注册进该 workspace 的服务集合，文件路径不是跨机器身份，编辑会写错机器。Web 端只显示「前往本地桌面端设置」的指引（同 Memory 分区 localOnly 先例），不发起任何读写。桌面端激活远程 workspace 时编辑的仍是本机文件（远程 agent 的指令文件属于远端机器，本功能不覆盖）。界面文案明确「应用到你本机 Agent 的后续会话；远程设备需单独配置」。
- Web/手机远控始终只显示前往本地桌面端的指引，不调用个性化读写服务；未连 bridge 前的本地 stub 抛 unsupported 错误仅作防御。

## UI 行为

- 侧栏「Agent 能力」组第一项，位于「记忆」之前；图标 `User`。
- 外部布局：标题（设置页框架渲染）→ 说明（`text-ui-base text-foreground-subtle`，不显示「了解更多」入口）→ 编辑器直接铺在页面背景上（**无卡片包裹**），编辑器下方是保存/取消操作区。编辑器用 `SettingsFormTextarea`（`border-input-border` 灰色框线，浅色主题下清晰可见；基础 `Textarea` 的 `border-input` 在浅色主题是白色，不可见）。
- **显式「保存/取消」（需求方最终决定）**：编辑器下方 `SettingsFormActions` 内保存（`size="lg"` 主按钮，仅脏态且未超限可用）+ 取消（ghost，丢弃修改恢复到已保存内容）；`Ctrl/Cmd+S` 与保存按钮等价（阻止浏览器保存对话框）；脏态有「有未保存的修改」提示。曾实现过「自动保存 + 卸载冲刷 + localStorage 失败暂存」，三轮评审暴露的时序缺陷（并发提交顺序、卸载基线竞态、跨 Host 暂存串写）全部源于该形态；显式保存把整类问题删除，不需要任何后台暂存。
- **表单状态所有权在组件外的模块级 store（第四轮 CR-01）**：草稿、基线、在途保存状态收口在 `PersonalizationSection.tsx` 的模块级 zustand store——保存中切走分区时组件卸载，state 里的草稿没有存活 owner，写入失败后既不能重试也不能复制。store 卸载不失活：重进分区时若文件内容仍等于基线（未被外部改过）则恢复草稿（含保存失败态，可重试）；文件被外部改动时文件优先。
- **双层失效边界（第五轮 CR-02）**：`generation` 绑定 `settingService` 实例身份（连接边界），实例变化整体重置、旧连接在途回调失效；`loadRequestId` 标记每次读取请求（请求边界），迟到的旧读取——新读取已开始或保存已发生后才返回——不得应用到 store，防止用旧快照覆盖已保存的新基线与草稿。两个版本是不同的时序边界，不能共用。
- **读取态（CR-02）**：读取成功前编辑器禁用；读取失败展示失败文案与「重试」按钮（`common.retry`），不得把读取失败当空文件建立草稿基线——否则用户输入无法安全保存。首次进入文件不存在不是错误，textarea 为空、直接可编辑。
- 编辑器自然语言指令不用等宽字体（等宽仅用于 JSON 等技术内容）。

## 验证

- E2E（`packages/desktop/test/e2e/settings/agent/settings-personalization.test.ts`）：
  - 「个性化」是「Agent 能力」组第一项；
  - 点击后直接出现编辑器（无二级页、无卡片）；
  - 首次进入时即使 `{HOME}/.zcode/AGENTS.md` 不存在也显示空编辑器；输入不创建文件，点击保存后才创建并落盘；
  - 离开再进入分区内容回显（文件为唯一事实源）；取消丢弃修改、文件不变；
  - 清空并保存后文件内容被清空；
  - 超过 100KB（含多字节字符）保存被阻断并提示，回到限内后保存恢复；
  - 未保存草稿跨分区切换存活（PZ-05）；
  - 保存 in-flight 时切走分区、宿主持锁写入超时失败后，重进分区草稿恢复且重试保存成功（PZ-06，用测试进程持有 `AGENTS.md.lock` 构造确定性失败时序）。
- 代码检查：typecheck、lint、architecture:check --changed。
