# 通用/编程模式：影响面与验证

## 界面模式切换埋点验收（2026-10-28）

契约见[业务埋点](../monitoring/business-monitoring.md#界面模式切换-ui_mode_switch2026-10-28)。
沿用正式用例 `packages/desktop/test/e2e/ui-shell/navigation/general-coding-mode.test.ts` 的 MODE-01，
通过真实 UI 操作并在最终 `/event/report` 传输边界核对字段；MODE-02/03 继续验证面板及 PTY 保留。

| 场景 | 预期与证据 | 当前状态 |
| --- | --- | --- |
| 设置、头像菜单、Onboarding 实际应用 | 三个既有 region、ck、previous_ui_mode / ui_mode 正确 | MODE-01 通过 |
| 同值选择、刷新、引导草稿及关闭 | 不增加事件 | MODE-01 通过 |
| 引导外/内快捷键，以及其后同值提交 | 模式确实改变但不报，提交同值也不补报；后续菜单事件使用实时旧值 | MODE-01 通过 |
| 跨窗口广播、异步偏好保存失败重试 | 广播不报、重试同值不重复报 | 本轮未做对应故障/多窗口 E2E，仅核对调用链 |
| 手机 Web 与生产入库 | 保留手机白名单，不新增出口；服务端正确接收 | 手机实机、生产入库未验证 |

不恢复已退役的 App 业务单测。E2E 读取函数只采集事件，等待条件只检查数量，结束后统一断言
事件类型、来源和前后模式，避免字段错误在轮询中被包装成等待失败。

本轮 macOS 桌面、中文、深色主题 E2E 通过 2/2，运行标识为
`desktop-e2e-20261028091729374-p35453-b6ac858286a53e69`，证据位于
`packages/desktop/.e2e-artifacts/<运行标识>/summary.md`。Windows、Linux、浅色主题未运行。
根类型检查、E2E 类型检查、lint 和架构检查通过；受影响工程测试选择结果为 0 项。

## Feature Summary

| Field                         | Value                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Developer intent / capability | M1 通用与编程模式的展示差异与面板保留                                                                   |
| Change layer                  | presentation、option-source、draft-default、validation、persistence                                     |
| Operating mode                | implementation-handoff；按已确认的产品语义补齐收尾验证                                                  |
| Primary seeds                 | `createZCodeStore`、`useIsGeneralMode`、`useAppPanels`、`ToolCallBlockComponent`、`ConversationRowView` |
| Out of scope                  | 模型提示词、产物管理、统一文件预览、设置按钮位移、修改 continuous/replayable 协议                       |

## UI Surface Matrix

| 用户场景 / UI 入口      | 共享实现                                                 | 展示/权威 owner、默认与落点           | 校验 / 提交动作                     | 模式边界 / 隔离不变量                      |
| ----------------------- | -------------------------------------------------------- | ------------------------------------- | ----------------------------------- | ------------------------------------------ |
| 设置外观 / 头像菜单切换 | `settingsCodePreview` / `WorkspaceSidebarFooter`         | ZCodeStore；默认 coding；localStorage | setInterfaceMode / 现有广播         | Desktop/Web 共用；不改任务模式、模型或权限 |
| 查看命令与文件修改      | `ToolCallBlocks` 四个 renderer                           | 原始 tool 节点，只派生展示            | canToggle/forceOpen、标题与详情过滤 | 不删除原始结果；文件点击仍沿用既有预览     |
| 思考 / 正式回答         | `ConversationRowView` / `MessageResponse`                | 原始 row；代码预览偏好                | 思考原文展示、forceCodeWrap         | 流式/完成均应用；不写回原文                |
| 状态 Git 区 / 轮次汇总  | `conversationStatusPanelModel` / `ConversationTurnGroup` | 原始 Git 与任务投影                   | 隐藏 Git model / 汇总               | 不停止 Git 查询或改写仓库                  |
| 新建审查/终端           | `AnimatedSidePanePanel` / quickPick / Terminal           | useAppPanels；现有标签与终端状态      | 过滤选项、阻止新建                  | 已打开项保留；既有关闭仍工作               |
| 外部打开                | `WorkspaceEditorButtonGroup` / openWithEditors           | 已安装程序 / 既有选中偏好             | 过滤为文件管理器                    | 不覆盖已保存编辑器偏好                     |
| Dev 设置隔离            | SettingService                                           | 显式 home 覆盖 / 原环境回退           | 既有 get/update                     | 未配置覆盖时兼容原路径                     |

## Shared And Divergent Behavior

共享组件读取同一个模式偏好。候选项过滤与展示规则按入口分别执行；已打开标签和终端保持独立的 owner。无新增远端配置、runtime 提交动作或恢复语义。Web 的无原生编辑器/浏览器限制保留；手机不重复验证 Desktop 的原生启动能力。

## Feature Relationships

| Rank           | From -> Semantic edge -> To                                   | 原因与证据                                             |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| must-inspect   | 偏好 -> projects-to -> 对话/设置/面板入口                     | 所有 useIsGeneralMode 调用方与 createQuickPickCommands |
| must-inspect   | 模式切换 -> must-not-mutate -> 已打开面板状态                 | useAppPanels 返回原始 sidePaneState / isTerminalOpen   |
| should-inspect | 模式 -> projects-to -> 代码换行、Git 区                       | MessageResponse、conversationStatusPanelModel          |
| conditional    | Dev 环境 -> persists-to -> 独立设置目录                       | SettingService.resolveUserHomeDir                      |
| invariant-only | UI 偏好 -> must-remain-isolated-from -> Agent / remote stream | shared 协议、runtime、relay 无改动                     |
| evidence-only  | 单测 / pending UI E2E -> covered-by -> 下表 cases             | 单测不是远控端到端证明                                 |

## State Owners And Commit Sinks

详见 [功能 spec](../ui/general-coding-mode.md) 的状态图。ZCodeStore 拥有模式；useAppPanels/taskSidePaneMemory 拥有面板；TerminalSession 拥有 PTY；CLI/runtime 拥有原始任务数据。设置服务环境修复只改变显式 Dev home 下的配置位置。

## Must-Preserve Invariants

模式切换不关闭 PTY、不丢失标签和选中项、不改原文、不改保存的换行偏好、不触发模型请求，不把手机 replayable 恢复语义扩散到桌面 continuous。

## Codegraph Evidence

当前工具环境无 codegraph 服务或 CLI；未执行 codegraph 深度 2 扫描。使用精确 rg 和当前 diff 追踪共享符号、直接调用方及测试，不能声称完成代码图扫描。

## Graph Drift Candidates / Graph Delta

既有语义图未包含界面模式；按已确认范围登记 capability、偏好 owner 和入口关系。图谱不记录“文件名统一打开文件内容”的未实施提议。代码 seed 的机械可解析性单独核验，codegraph 验证仍不可用。

## Boundary Decisions / Clarification Log

- accepted：用户要求名称为通用/编程模式；通用隐藏技术入口，保留已经打开的面板。
- accepted：用户确认当前可用，进入提交前补测试、文档阶段；不主动提交或推送。
- ignored：统一文件名预览，当前仍沿用 patch/file 规则；不把讨论误当成本次新增实现。
- pruned：不同模型/provider 的完整排列，模式不参与请求；以 UI 偏好与工具记录不变代表。
- pruned：主题×语言×workspace 的全排列；本轮桌面覆盖中文默认主题，远程 identity 的 hook 用例覆盖共享状态保留，原生多平台和手机远控留待实际环境验证。

## Accepted Cases / Coverage Matrix

| ID      | Setup                                     | Action                      | Assertions / 非 UI 证据                                 | 验证入口与状态                           |
| ------- | ----------------------------------------- | --------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| MODE-01 | 无值/旧值/非法值                          | 初始化与切换                | 默认/兼容归一正确，保存偏好，广播无回声                 | unit passed                              |
| MODE-02 | coding，底部终端与 git/terminal tabs 已开 | coding -> general -> coding | 同一 tab id、活动项、折叠状态保留；关闭仍可用；新建受控 | hook passed；pending Electron 2/2 passed |
| MODE-03 | general，空侧边面板                       | 查看启动页/新增/命令菜单    | 无 review/terminal，新建按钮隐藏，浏览器入口保留        | unit passed；pending Electron 2/2 passed |
| MODE-04 | 执行/修改工具，运行中/完成/失败           | 切换模式                    | 详情可见性变化、失败状态保留、原始节点未修改            | unit passed                              |
| MODE-05 | 思考原文接线，回复含代码                  | 投影并切回                  | 思考恢复原始接线；回复换行不覆盖保存偏好                | unit passed                              |
| MODE-06 | Git 状态与已安装编辑器                    | 切换模式                    | Git 区隐藏，文件管理器保留                              | unit passed                              |
| MODE-07 | 显式 Dev home / 普通 home                 | 更新设置                    | 只写目标设置路径，不污染真实 home                       | service unit passed                      |

## Planning Handoff / E2E Handoff Notes

- UI E2E：`ui-shell/manual-review/pending/general-coding-mode.test.ts`；无模型请求，无需 provider 响应。
- 既有对话数据渲染由组件单测覆盖；本次不伪造模型输出以冒充真实网络验证。
- E2E 使用独立测试 home 和框架的 run-scoped 进程；不操作用户开发实例。
- 新 E2E 保留 pending；是否转正与加入 Docker suite 单独依生命周期处理。
- 无需重复询问已确认语义。待补范围：原生 Windows/Linux、实际手机远控及代码图扫描。

## Verification Results

2026-09-11，macOS arm64，Node 24.14.0 / pnpm 10.33.2；基线 `042a36cad2`。

- 移除思考过滤前的关联单测：对实际工作树变更文件运行 `vitest related --run`，410 个文件通过，4119 passed / 3 skipped。不是仅比较已提交 HEAD 的空范围结果。
- 移除思考过滤前的定向单测：8 个文件、121 条全部通过（与关联单测有重叠，不叠加计数）。涵盖偏好归一、持久化、广播无回声、面板 owner、运行/完成/失败工具展示、思考围栏、回复代码容器/复制/换行入口、Git 投影、编辑器过滤及 Dev home 隔离。
- 独立 Electron：本页 pending spec 2/2 通过。实际创建审查、侧边终端及底部终端，切换模式后验证 tab id/选中项不变、已有 PTY 输出独立标记、关闭有效；同时验证设置页/头像菜单/刷新偏好。
- `pnpm lint`：0 errors，41 warnings；未在本次新增文件发现 lint warning。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm architecture:check --changed`：通过，架构新增违规 0。
- `pnpm verify:pre-push`：通过；由于还未创建 commit，其 affected 阶段比较 `origin/staging..HEAD` 为空并跳过。上面的工作树关联单测负责验证当前未提交代码，真正 push 时仍须再次经过 hook。
- 改动文件格式检查：44 个文件通过；三个既有大型 catalog/matrix 在 HEAD 上也存在格式问题，仅追加本次覆盖索引，未重排其全部历史表格。`git diff --check` 通过。
- 基线检查：开工时已快进至本轮获取的 staging；最终 `--no-fetch` 检查同步。最终在线 fetch 因 `git.example.invalid:443` 连接超时失败，提交/推送前应再刷新远端。
- 图谱 YAML、节点关系和 code seed 文件/符号存在性校验通过；未执行 codegraph 扫描。

### 移除思考代码过滤后的验证

按最新产品决定，删除思考代码过滤函数及其 7 条过滤单测，`ReasoningRowView` 恢复与 staging 相同的原文接线；不改变原有 Markdown 渲染和折叠行为。

- 定向运行 `interfaceMode.test.ts`、`v4ConversationRowViewUserEdit.test.ts`、`messageResponseStreamdownMode.test.ts`：3 个文件、83 条通过。
- `pnpm lint`：0 errors、41 warnings；`pnpm typecheck`、`pnpm architecture:check --changed`（0 violations）及 `git diff --check` 通过。
- 本轮未重跑 Electron E2E，前述 E2E 结果来自移除过滤之前。

### 文件右键菜单范围调整

按最新产品决定，撤回回答文件链接右键菜单的模式过滤及临时测试 mock；回答文件链接、左侧栏文件树均保留原有完整外部应用候选项和远程可用性限制。顶部“打开”按钮的模式过滤保留。

撤回后定向单测 3 个文件、48 条通过；lint（0 errors、41 warnings）、typecheck、架构检查和 `git diff --check` 通过。

### 同步 staging 后的验证（2026-09-11）

- 从 `042a36cad2` 快进至本轮在线获取的 `origin/staging`：`87d6a7b2fc`，纳入 81 个提交。
- 原有未提交改动与 8 个未跟踪功能文件全部恢复；两份对话测试目录文档的冲突保留上游内容并追加模式章节。演示目录 `mode-output-demo1/` 保留。
- `pnpm install --frozen-lockfile --prefer-offline`、`pnpm typecheck`、`pnpm lint`（0 errors、41 warnings）、架构检查（0 violations）、基线新鲜度检查和 `git diff --check` 通过。
- 工作树相关单测：413 个文件，410 passed / 3 failed；4157 passed / 4 timeout / 3 skipped。超时涉及自动更新、设置写入及 SSH 配置读取。
- 首轮结束后，以 `--maxWorkers=1` 单独复跑上述 3 个测试文件：93/93 全部通过，未放宽超时限制，也未修改对应业务逻辑。两轮存在重叠，不相加计数。
- 本轮未重跑完整 Electron E2E；前述 E2E 证据属于旧基线。未创建 commit 或推送。

### 运行方式与证据

首次从干净构建运行（需仓库依赖已安装）：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 \
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$PWD/config/provider/zcode-builtin.json" \
  mise exec -- pnpm --filter @zcode/desktop test:e2e -- \
  --spec './test/e2e/ui-shell/manual-review/pending/general-coding-mode.test.ts'
```

本轮先完成完整 E2E 构建，后续只修改测试时使用框架的 `ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1` 复用构建。显式 provider config 防止测试启动回到无法完成的远端配置初始化；不改变模型响应，也不发送对话请求。

Electron 通过报告：`packages/desktop/.e2e-artifacts/desktop-e2e-20260910161155755-p86485-1e1dbe00b0b94651/summary.md`。

本地结果位于 `.cache/concise-professional/`：`prep-related.log`、`mode-unit-final.log`、`mode-e2e.log`、`prep-lint.log`、`prep-typecheck.log`、`prep-e2e-typecheck.log`、`prep-prepush.log`。日志为本地验证产物，不纳入提交。

失败诊断：最初运行卡在启动配置初始化；一次 WebDriver session 创建超时。模式测试初稿还使用 DOM click 打开 Radix trigger，随后连续切换未等待旧菜单退出。最终改为真实点击并等待旧菜单卸载；不增加固定 sleep，也未为这些测试问题修改产品逻辑。

### 尚未声明的覆盖

Windows/Linux 原生运行、实际手机远控、其他语言/主题、Docker replay/CI admission 尚未验证。新 E2E 继续保留 pending，不能写成正式 CI 覆盖；文件链接统一文件预览仍不在本次实现范围。`mode-output-demo1/` 是手动测试产物，保留在本地并排除提交。

### MR 准备复验（2026-09-14）

- 基线：`c71d91499b`，目标 `origin/staging` 为 `2408407197`；在线基线检查通过。
- `pnpm typecheck`、`pnpm lint`（42 warnings、0 errors）、架构检查（0 violations）和 `git diff --check` 通过。
- 首轮关联单测：418 个文件通过、4163 条通过、3 条跳过；两个远控测试文件因本机 Electron 可执行文件缺失而加载失败。E2E 启动流程完成 Electron 安装后，两个文件定向复跑 74/74 通过。
- 当前 Electron 模式用例 2/2 通过。复验修复了测试自身的两处交互假设：xterm 隐藏 textarea 不可直接点击；Radix 菜单退出动画结束前点击会误触浏览器入口。改为等待菜单卸载、点击可见终端并校验焦点，不修改产品实现或增加固定 sleep。
- 通过报告：`packages/desktop/.e2e-artifacts/desktop-e2e-20260914125059185-p5323-92d9bc8a33e5b101/summary.md`；截图：`packages/desktop/.e2e-artifacts/general-coding-mode/general-mode-pty.png`。均为本地验证产物，截图随 MR 附件交付。
- 覆盖 macOS、中文、默认深色主题；手机远控、Windows/Linux、其他语言/主题的端到端组合仍未验证。推送时继续执行完整 pre-push hook，不跳过门禁。

### UI Shell 用例转正

用户已确认验收，将同一文件内 MODE-01 与 MODE-02/03 两个测试转正到 `packages/desktop/test/e2e/ui-shell/navigation/general-coding-mode.test.ts`，修正 helper 相对路径并同步目录与矩阵引用。上文 pending 路径和状态保留为历史验证记录。

现有 `e2e:promote` 脚本仅支持 conversation-session，dry run 拒绝 ui-shell 路径；本次按原领域直接迁移，不改脚本或挪入错误领域。用例只操作 UI 与本地 PTY，不发送模型请求，因此没有 case-local 模型响应 fixture。正式路径的运行不使用 `ZCODE_E2E_MANUAL_REVIEW`。Docker preset admission 尚未执行，不声明 Docker CI 覆盖。

转正验证：macOS 正式路径 2/2 通过（未开启 manual-review），报告 `packages/desktop/.e2e-artifacts/desktop-e2e-20260914135304096-p28302-df659cf52d0d2fbd/summary.md`。typecheck、desktop typecheck:e2e、lint、架构检查通过。额外执行 conversation coverage audit 失败；将全部本轮修改临时恢复到 HEAD 后复跑，审计输出完全相同，确认为既有统计/生成文档漂移，本次未新增审计失败。
