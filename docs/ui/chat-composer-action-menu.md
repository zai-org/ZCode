# Chat Composer Action Menu

产品需求：[PRD] 输入框添加按钮增加插件与上下文入口： https://internal-docs.example.invalid/redacted

## 产品合同

输入框左侧 `+` 打开与输入框等宽的 Popover，复用 MentionPanel 和候选行组件。

| 顺序 | 分类 | 内容与选择行为                                                                           |
| ---- | ---- | ---------------------------------------------------------------------------------------- |
| 1    | 添加 | 附件调用既有 attachmentAction；目标仅在新会话空输入时出现，插入与 `/goal` 相同的命令标签；工作流紧随目标之后，任意会话空输入且 CLI slash catalog 含 `workflow` 时出现，插入与 `/workflow` 相同的命令标签 |
| 2    | 插件 | 与空 `@` 使用同一 catalog、排序和 enabled 过滤；冲突项仍禁选                             |
| 3    | 文件 | 当前 workspace，文件优先、同类按相对路径排序，空查询最多 10 项                           |
| 4    | 会话 | 当前 workspace，updatedAt 降序、createdAt 降序、标题排序；不扩展到 `#` 的跨项目范围      |

文件、会话无候选且没有加载/错误状态时隐藏分类。插件保留空态。画板不加入本菜单。
新草稿读 workspace 当前插件 catalog，已有 session 读 session-owned catalog，沿用 `@` 的生命周期。

## 交互和布局

- `/goal` 目前只在消息开头按命令解析；既有会话或非空草稿隐藏目标，避免中间插入无效命令。
- `/workflow` 是 zcode-guide 内置插件的自定义命令，同样只在消息开头展开（`custom-command-prompt.ts` 的 `^\/` 模式）；非空草稿隐藏工作流。它不绑定会话级状态，所以新草稿与既有会话都提供；catalog 缺少 `workflow`（插件被禁用）时隐藏，避免把 CLI 不会展开的裸文本发给模型。
- 点击候选关闭菜单，在打开前的光标处插入标签；保留光标两侧草稿，选中文本时替换选区。随后回到编辑器。
- 附件使用既有平台选择链路；手机远控未提供 attachmentAction 时隐藏附件项。
- 上下键循环并跳过禁选项，Enter/Tab/Space 选择，Escape/点击外部关闭。
- 底部横排 `@ 添加上下文`、`/ 选择能力`、`$ 选择技能`、`输入内容以搜索插件、文件和对话`；窄屏换行，中英文国际化。
- 提示属于说明文字，不是菜单候选。`+` 不新增搜索框，搜索仍通过编辑器触发符使用。
- 候选滚动区最大 24rem，并按 Popover 可用高度收缩；原 `@`、`/`、`$` 面板高度保持原值。
- 使用主题 token；输入框常驻操作仍为 `+`、权限/模式选择、其余插槽。

## 数据与边界

```text
+ 打开 -> 保存 Lexical 选区 -> 既有 provider 读取候选
          选择候选 -> 恢复选区 -> 插入 canonical mention -> 编辑器聚焦
          选择附件 -> 原平台附件选择流程
```

共享编辑器覆盖桌面、Web、手机。workspaceIdentity 透传，文件执行路径仍为 workspacePath。
本次只改候选入口和草稿编辑，不新增协议、Host/runtime、持久化或发送逻辑；desktop-continuous 与 web-remote-replayable 的边界保持原状。

## 验收覆盖

- PLUS01：添加/插件/文件/会话分组、候选顺序，禁用菜单和平台附件边界。
- PLUS02：目标仅新会话空输入可见；插件/文件/会话选择保留光标两侧文字，canonical markdown 与原入口一致。
- PLUS03：键盘跳过禁选项、Escape 关闭、附件回调只执行一次。
- PLUS04：桌面横排 footer、增加列表高度、窄屏不横向溢出。
- PLUS05：工作流位于目标之后；空草稿可见、非空草稿隐藏；选择后插入 `/workflow` 并保持在消息开头。

组件测试：`packages/ui/test/chatPromptActionMenuInteraction.test.ts`。
Electron 候选用例：`packages/desktop/test/e2e/conversation-session/composer/conversation-session-plus-menu.test.ts`。
新用例未经过人工验收与正式 promotion，不宣称已进入 Docker/CI suite。

## 提交前验证（2026-09-08）

- 基线已同步 `origin/staging`：`054cf7c06c`，新鲜度检查通过。
- focused UI：10 文件、109 项通过；工作区改动关联测试：312 文件、3000 项通过。
- Electron pending E2E：3 项通过；目标仅新会话空输入可见、插件引用/Escape、宽窄布局均通过，每项结束断言 provider capture 为空。
- E2E artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260908135636857-p81797-6b6d86ab55faaebc/summary.md`（本地忽略产物，不入库）。
- `pnpm typecheck`、`typecheck:e2e`、lint、fixture check、conversation coverage audit、改动 TS/JSON 格式检查通过；lint 为已有 43 warnings / 0 errors。
- `verify:pre-push` 通过，但其 affected runner 只比较提交范围，未提交时会跳过；以上 3000 项另用同一 lint-staged related runner 显式传工作区改动执行。
- 全仓 `pnpm fmt:check` 未通过：仓库既有大量格式差异，且 `docs/electron/docs/fiddles/` 下示例 HTML 存在解析错误；未批量修改无关文件。
- 未验证真实手机远控、Windows/Linux；未执行人工 promotion 或 Docker suite。本用例保持 pending，供后续人工验收。

## 会话列表读取范围

前端不额外截断 sessions-index 候选，但并非读取全部历史正文。CLI 冷启动按当前 workspace 读取最多 200 条未归档轻量摘要，再合并已加载 runtime 会话；这不是永久总量上限。侧栏和 mention 按 endpoint/workspace 复用订阅；菜单用虚拟列表限制 DOM。前端显示前 5 条只能减少候选处理/浏览量，不能替代后端分页或搜索。

Goal 入口限制回归：先确认新增测试在旧实现失败，再验证 10 项菜单组件测试通过；相关 focused tests 共 31 项通过，最新 Electron E2E 3 项通过。类型检查与 lint 再次通过。

最终锚点回归（2026-09-08）：修复自定义锚点被默认按钮锚点覆盖、旧按钮卸载后菜单零宽的问题。Electron 增加连续打开四次并断言与输入框等宽，最终 4 项通过；菜单组件 10 项通过。最新 artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260908141040179-p91755-f8ea6aba86ad30d3/summary.md`。当前 dev 热更新后连续开关及新建任务入口手工检查通过。

评审边界补充：目标遵守 excludedSlashCommandNames（含 selection side chat 的 Goal 禁用），仅严格空字符串草稿提供，纯空白不提供；添加项为空时隐藏分区。浮层打开期间草稿被替换，已失效的选区节点不恢复，改在当前草稿末尾插入。正式 v4-mention E2E 同步验证底部提示和手动触发路径。coverage audit 只检查目录/矩阵合同，不执行 E2E。

2026-09-09 评审修复验证：新增 3 项菜单边界用例先失败后通过；focused 3 文件 18 项通过（含真实 Lexical 过期节点选区恢复）。正式 `conversation-session-v4-mention.test.ts` 1 项通过，证据 `desktop-e2e-20260908162645238-p47690-05cbd56f84b41d2e` 中 formal worker；同批 pending 的草稿替换用例发现菜单会随回填关闭，已按实际行为修正，独立重跑 pending 5 项全部通过，证据 `desktop-e2e-20260908162845106-p50242-675fde70d62d44fa`。类型检查、lint（已有 41 warnings）、coverage audit、正式 fixture check 通过。SG-03 经 dep:refs 确认旧导出仅被自身测试引用后移除，附件文案由调用方提供并在菜单消费。

## 工作流入口（2026-09-11）

interview 决策记录：

| Question                      | Decision                                                                                                               | Boundary fixed                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工作流项的存在来源            | **以 CLI slash catalog 为准**：workspace 的 `slashCommands` 含 `workflow` 才出现                                       | 沿用「命令目录以 CLI catalog 为权威」的既有裁定；UI 不硬编码第二个命令来源。目标仍按原样硬编码（它有 session 级语义门禁，与 catalog 无关）       |
| 何时提供                      | **空草稿、任意会话**（新草稿与既有会话都可）                                                                           | `/workflow` 只在消息开头展开，故要求严格空字符串草稿（与目标同一判据）；不像目标那样限制新会话，因为在既有对话中途启动工作流是合法用法           |
| `/` 面板顺序                  | **CLI catalog 装配侧**：`workflow` 是内置命令，`APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES` 把它排在 `goal` 之后 | 单一数据源：桌面、Web、手机远控看到同一顺序；UI 不新增排序白名单（此前 bugfix 已删除 UI 侧命令白名单）。只调顺序，不改来源、去重与 reserved 规则 |
| 编辑器内 `/workflow` 标签图标 | **lucide `Workflow`**（`WORKFLOW_COMMAND_MENTION_ICON_NODE`）                                                          | 与 `+` 菜单项、dwf 其余 UI 同一图标；`/goal`、`/compact` 的专属图标机制照抄                                                                      |

数据流：

```text
CLI listProtocolSlashCommands
  builtins[goal, workflow, compact, init, plan] + custom[...]
  → 固定顺序 [goal, workflow, compact, init, plan, ...custom]        （唯一排序点；灰度关闭时 builtins 里没有 workflow）
  → available_commands_update → store.slashCommands
        ├─ `/` 面板：按 catalog 顺序展示（不变）
        └─ `+` 菜单「添加」：附件 → 目标(新会话空草稿) → 工作流(空草稿 ∧ catalog 含 workflow)
选择工作流 → 插入 `/workflow` 命令标签（与 `/` 面板 canonical 相同）→ 编辑器聚焦
```

`+` 菜单在打开瞬间快照草稿是否为空（与目标同一快照），目标/工作流两项按快照决定，
避免菜单打开期间候选平移打乱键盘选择。

测试：`chatPromptActionMenuInteraction.test.ts`（顺序、任意会话可见、catalog 缺失/非空草稿/排除名隐藏、
插入 `/workflow`）；`promptMentionNode.test.ts`（图标节点）；
`apps/zcode-cli/packages/bootstrap/tests/protocol-slash-commands.test.ts`（catalog 顺序）；
Electron pending 用例 PLUS05。

