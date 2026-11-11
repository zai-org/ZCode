# Markdown 预览选区引用

## 产品行为

Markdown Preview（文件 `.md` / `.markdown` 或直接传入的 Markdown 文本）的预览正文支持鼠标、键盘和触控选区。非空合法选区展示「添加到当前任务」，点击后把选中文字加入当前主任务的待发送引用，保留草稿、不自动发送。同时提供「在辅助对话中提问」，源码视图继续使用现有代码交互。

当前主任务尚未创建 session 时，引用进入该工作区 draft scope。引用复用对话引用 chip、删除、原子限额与发送序列化：单条最多 8,000 字符、最多 8 条、总计 16,000 字符；重复来源和文字不重复添加。Markdown 来源明确记录文件路径或文本预览身份，不伪造消息 row/session；发送复用 userselect 块：文件选段包含 path/text，无路径文本与对话选段仅含 text。

选区两个端点必须都在同一预览正文内，拒绝空白、按钮/输入控件及跨预览选区。正文跨段落、表格有效。滚动、Escape、折叠选区、切换文件、正文更新、任务/工作区切换或隐藏预览后关闭浮层。浮层不得溢出窄屏，沿用主题 token 和中英文文案。

## 数据流与边界

```text
AnimatedSidePanePanel (activeTaskId + workspaceKey)
  -> PreviewPane -> MarkdownPreviewContent
                     -> Selection action
                        -> reference scope[workspaceKey, taskId | draft]
                           -> Composer draft + reference chips
                              -> user sends -> existing userselect serialization
```

workspaceKey 严格使用 workspaceIdentity?.trim() || workspacePath；预览来源与目标工作区不匹配时不提供入口。「添加到当前任务」的目标是当前主任务，不按最近聚焦的辅助输入框猜测。全部变更位于 UI 待发送引用层；桌面 desktop-continuous 与手机 web-remote-replayable 继续使用各自原有传输与恢复边界，不新增 runtime/host 状态或队列。

## 验证合同

- MPS01：文件/文本预览选中正文后添加，保留草稿、正确 chip、可删除、不自动发送。
- MPS02：来源区分、同源同文去重、限额原子拒绝、文件发送 path/text，无路径文本只含 text。
- MPS03：跨区域/控件/空白拒绝，滚动、Escape、源或目标变化清除浮层。
- MPS04：手机触控 selectionchange、窄屏布局、明暗主题及国际化。
- MPS05：同路径不同远程 identity 隔离；草稿/任务之间隔离。

以上语义 accepted；新增桌面 E2E 保留 manual-review/pending，正式转正独立遵循人工审核流程。

## 验证记录（2026-09-04）

- 相关 UI 单测 80 条通过：包含来源/序列化/限额、触控 selectionchange、窄屏定位、草稿与远程 identity 隔离、源/目标变化及关闭行为，以及既有预览与对话选区回归。
- macOS Desktop E2E 通过：从项目文件树打开真实 Markdown 文件，选中文字、添加引用、保留草稿、去重、移除；全程保持 draft，不自动发送。
- E2E artifact：`desktop-e2e-20260904025826214-p12794-fec18ab46a7b3c1d`；已核对 `markdown-selection-tooltip.png` 和 `markdown-selection-composer.png`（暗色主题）。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e` 通过；`pnpm lint` 无错误，仓库既有 40 条 warning。
- 待补环境验证：手机真机原生长按、真实远程 attachment 链路、Windows/Linux 和浅色主题目视。手机事件/窄屏与身份隔离有单测；两种主题使用现有语义 token，中英文复用现有文案。无 host/runtime/协议改动。
- 新增 E2E 仍为 pending 候选，未进行正式用例转正或 Docker suite 准入。

## 辅助对话入口

MPS06（accepted）：Markdown 选区通过 workspaceKey + 当前主任务 sessionId 路由到已注册主 SessionPane，传入 Markdown 引用。沿用消息选区的 active child 复用、无 active child 新建、失效 child 替换和 pending 创建去重规则；保留主/辅助草稿，不自动发送。Markdown tab 激活时通常没有 active child，不猜测最近使用的辅助 tab。

MPS07（accepted）：尚无主 session、只读/手机 viewport 或主控制器未就绪时禁用辅助动作并显示本地化说明；主任务或目标辅助对话存在阻塞交互时禁用引用动作。原「添加到当前任务」保持可用。既有无引用 launcher 仍强制新建，不受引用动作的阻塞状态影响。

2026-09-07 合并复审：`0ed79bae571` 人工适配 SessionPane 时漏接了注册回调的引用参数及阻塞标记。恢复上述 MPS06/MPS07，不恢复旧 Provider Store、发送前 Registry 同步或账号批量切模。必须验证真实 SessionPane 注册的回调，而不只测试 Runtime helper；沿用正式 Markdown E2E 验证辅助输入框实际得到引用。Workspace Hook 的软审核不计入阻塞交互。

```text
Markdown reference -> scoped registered main opener
  -> reference present: existing selection creation/reuse route
  -> no reference (existing launcher): force new child
  -> child composer references; never auto-send
```

仅扩展已有 renderer 控制器入口的可选引用参数；不新增协议、Host/CLI 状态，也不扩张手机辅助对话边界。

### 辅助入口验证（2026-09-04）

- 相关单测 86 条通过，新增覆盖引用透传、workspace/parent 精确路由、未就绪禁用、阻塞只拒绝引用动作及无引用 launcher 兼容。
- macOS Desktop E2E（case-local replay）通过；artifact `desktop-e2e-20260904031854602-p40021-80167b00527a3467`，已检查 `markdown-side-conversation.png`：主草稿保留，辅助会话输入框带一条 Markdown 引用且正文为空，不自动发送。
- typecheck、E2E typecheck、lint 和 fixture check 通过；lint 仍为既有 40 条 warning。fixture 的未匹配 marker 对应未发送草稿/预览正文/回复断言。
- 手机辅助对话沿用现有不可用边界；手机真机、真实远程 attachment、Windows/Linux、浅色主题目视仍未验证。无新增协议或运行时队列。

### 选区菜单视觉一致性（MPS08，accepted）

Markdown 与对话流复用同一个选区菜单：横向排列、自适应内容宽度、竖分隔线，统一字体、间距、主题、圆角和 hover/disabled 样式。根据菜单实际尺寸约束视口边界，窄屏保持横排且允许按钮文字换行。只共享菜单展示与定位，引用来源、路由和辅助动作禁用条件不变。

验证：扩展同一 pending E2E，检查两按钮横排、菜单自适应及视口边界；现有添加/辅助引用路径继续回归。

- 相关单测 27 条、typecheck、E2E typecheck 和 macOS Desktop E2E 通过；lint 无错误，仍为既有 40 条 warning。
- E2E artifact：`desktop-e2e-20260904033127818-p66016-259b1e7c9730d08e`；已目视核对 `markdown-selection-tooltip.png`，菜单横排且位于选区上方。draft 的辅助动作仍按原规则禁用。
- 手机真机、Windows/Linux 和浅色主题目视未补测；沿用上述待补环境验证范围。E2E 保持 pending。

### 英文按钮文案

对话流与 Markdown 预览共用英文文案：`Add to chat`、`Add in side chat`。沿用同一国际化 key，仅调整英文展示，中文与动作行为不变。

### 文件来源保留（MPS09，accepted）

文件 Markdown 引用显式携带可选 path（真实路径，不使用 workspaceIdentity 或 sourceKey 代替）。单条显示「文件名 · 引用」，多条包含文件时显示通用引用计数；详情展示每条路径与选段。无路径文本预览保持 text-only。发送仍复用 userselect 文本块，文件项为 {path,text}，对话项为 {text}；历史解析保留合法非空字符串 path，旧 text-only 与 legacy 格式兼容，非法结构不吞正文。

```text
preview source.path -> reference.path -> userselect JSON -> history parser -> shared chip
```

无 Host/协议/队列变化，桌面 continuous 与手机 replayable 链路保持原样；路径只作来源，workspace scope 仍使用 identity 隔离。中英文、窄屏截断、Windows 路径分隔符均需兼容。MPS09 覆盖单测往返与无路径/非法数据，以及既有 pending E2E 的主/辅助文件名展示。

验证（2026-09-04）：35 条相关单测、typecheck、E2E typecheck、lint（既有 40 条 warning）及 macOS Desktop E2E 通过。artifact `desktop-e2e-20260904034329498-p80782-46211801b16015b3`，已目视文件名标签，并检查 provider capture 的 userselect 确实包含真实 path 与选段 text；E2E 同时断言主/辅助输入框与发送后历史文件名。无路径与非法路径由单测覆盖。手机真机、真实远程 attachment、Windows/Linux 和浅色主题目视未补测；E2E 仍保持 pending。

MPS09 发送证据加强：E2E 从真实 provider 请求的 user 文本提取 userselect JSON，精确断言唯一引用等于 `{path: filePath, text: marker}`，拒绝缺失、错误路径、选段变化和额外内部字段；不以整份证据中出现文件名作为通过依据。

精确断言验证（2026-09-04）：macOS Desktop E2E 通过，artifact `desktop-e2e-20260904040834255-p21311-c0e910d3b5a7b258`。首次运行在文件树入口失败，日志显示焦点触发按钮尚未挂载；测试改为等待 React 挂载后点击，重跑通过。typecheck、E2E typecheck、fixture check 与 lint 通过（既有 40 条 warning）。未变更产品代码、fixture 响应或正式用例准入状态。

### 正式用例转正（2026-09-04）

用户确认转正后，已通过 promote dry run/apply 与覆盖率准入审计，正式路径为 `packages/desktop/test/e2e/conversation-session/presentation/conversation-session-markdown-preview-selection.test.ts`。独立 common + case-local 回放通过（`desktop-e2e-20260904042625480-p37746-25eba58058f16338`），默认回放通过（`desktop-e2e-20260904042658298-p39023-d345d8e8f357eb39`）。fixture check、E2E typecheck、typecheck、lint 通过，lint 为既有 40 条 warning。

准入审计发现既有 assistant-preview-cards 与 hooks-lifecycle 的 manifest 顺序/说明和 provider fixture 不一致，已按 provider fixture 机械同步，未改响应或测试行为。按用户要求不加入 Docker 验证集，未执行 Docker 准入；此前 pending 记录为历史状态，以本节为准。
