# M5 Composer Parity — 输入框全量对齐老版 · 能力审计对账

分界原则：**壳老芯新**——旧 `ChatViewComposer` / `ChatPromptEditor` / `ChatInputToolbar` 的
JSX/样式原样复用（z-code-2 参考），wiring 全部新写：数据读 v4 投影（`snapshot.inputRouting /
control / config / usage`）+ sessions-index + 存活配置面服务；操作发 v4 命令（`sendText /
createSession / editUserQuery / stop / switchModelConfig / switchCollaborationMode /
attachment.put`）；不复活旧 hooks 编排 / 旧 store 会话态。

参考基线：老版 `ChatViewComposer.tsx`（删除前 `b44d4a87a^`）。
现状载体：`packages/ui/src/v4/ConversationComposer.tsx`、`packages/ui/src/v4/composer/*`、
`packages/ui/src/v4/SessionPane.tsx`。

## 一、已对齐能力（能力 × 老版 × v4 现状 × 处置）

| 能力                                                | 老版来源                                                                   | v4 现状                                                                                                                                                                                            | 处置                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lexical 编辑器 + 动作菜单 + sticky 底座             | ChatPromptEditor                                                           | `ChatPromptEditor`（同组件）                                                                                                                                                                       | 完成                                                                                                        |
| 动态 placeholder（phase/history 变文案）            | `resolveChatPlaceholderKey`                                                | 同函数：`hasHistoryMessages=rows.totalCount>0`、`isTaskProcessing=control.canStop`                                                                                                                 | 完成（parity）                                                                                              |
| Enter 提交策略                                      | `resolveChatEnterSubmits(preferEnterNewline=isWebRemoteControl)`           | 同函数；桌面端 Enter 发送，手机 Web 远控 Enter 换行                                                                                                                                                | 完成（多端语义一致，见 §三）                                                                                |
| 草稿 per-session 持久化                             | 旧 `zcodeSessionStore.composerDraftByScopeId` + `chatComposerDraftStorage` | `composer/composerDraftStore.ts`（独立 v4 键空间，text+editorStateJson，scope=sessionId/`__draft__`）                                                                                              | 完成（新做，不与旧键互写）                                                                                  |
| prompt history ↑/↓                                  | `promptHistoryStorage`                                                     | `readPromptHistoryEntries` / `appendPromptHistoryEntry` / `persistPromptHistoryEntries`                                                                                                            | 完成；写入仅过滤 trim 后与上一条相同的连续重复，旧历史读取不清理（见 `docs/ui/composer-prompt-history.md`） |
| 附件：文件选择（native picker / hidden input 回退） | useChatComposer                                                            | `useComposerAttachments.openAttachmentPicker`                                                                                                                                                      | 完成                                                                                                        |
| 附件：粘贴图片 / 文件                               | useChatComposer                                                            | `handlePaste`                                                                                                                                                                                      | 完成                                                                                                        |
| 附件：长文本粘贴 ≥15Ki 字符→宿主临时文件            | useChatComposer                                                            | `platform.createTempTextAttachment` 路径                                                                                                                                                           | 完成                                                                                                        |
| 附件：外部 OS 拖拽 + 心跳自动复位                   | useChatComposer                                                            | `handleDragOver/Leave/Drop` + `scheduleComposerDragFeedbackReset`                                                                                                                                  | 完成                                                                                                        |
| 附件：画板 add-to-chat（PNG）                       | useChatComposer                                                            | `handleWhiteboardMentionSelected` + `WHITEBOARD_ADD_TO_CHAT_EVENT`                                                                                                                                 | 完成                                                                                                        |
| 附件：8 上限 / 大小 / oversized 内联图拒发          | useChatComposer                                                            | `MAX_CHAT_ATTACHMENTS` + `serializeForSend`（`OversizedInlineImageAttachmentError`→拒发保留草稿）                                                                                                  | 完成                                                                                                        |
| 附件：objectUrl 生命周期回收                        | useChatComposer                                                            | 卸载/清空 `revokeChatComposerAttachment`                                                                                                                                                           | 完成                                                                                                        |
| 附件预览网格 + 图片大图预览                         | ChatViewComposer topContent                                                | `topContentNode`（旧 345-501 区段原样恢复）                                                                                                                                                        | 完成                                                                                                        |
| codeComment 附件 chip                               | `CodeCommentAttachmentChip` + `codeCommentContext` prompt block            | `useCodeCommentContexts`（composer 内存态）+ `buildPromptWithCodeComments`；仅 primary pane 接收全局事件，发送成功后同步移除代码预览                                                               | **完成（2026-07-21 bugfix）**：补回 V4 迁移漏接的 add/remove 事件、chip 和发送序列化                        |
| webElementContext 附件 chip                         | `WebElementContextAttachmentChip` + `webElementContext` prompt block       | `useWebElementContexts`（composer 内存态）+ `buildPromptWithWebElementContexts`；发送后 user row 用 `parsePromptWebElementContexts` 还原只读 chip，copy/edit 保留原始 `row.text`                   | **完成（2026-07-09）**：不走协议附件、不进草稿持久化                                                        |
| 会话错误横幅（输入框上方显示失败原因）              | `ChatBottomDock` → `ChatViewErrorBanner` → `ChatErrorBanner`               | `SessionPane` 读取 `snapshot.control.lastError`，映射为 `ChatErrorBanner` 展示在 `ConversationComposer` 编辑器上方；dismiss 只隐藏当前错误指纹，下一条错误继续显示                                 | **接（2026-07-07）**                                                                                        |
| 发送附件寄存 → 引用模型                             | 旧协议 promptAttachment                                                    | `attachment.put`→`AttachmentRef`（`composer/attachmentUpload.ts`，10 §6.5）；localPath 零上传/内联图经 put                                                                                         | 完成（新协议）                                                                                              |
| mention `@` 文件 / 文件夹                           | ChatPromptEditor mention                                                   | `enableMentionPanel` + `fileService.listWorkspaceFiles`                                                                                                                                            | 完成                                                                                                        |
| mention `@` 画板                                    | whiteboard mention                                                         | `onWhiteboardMentionSelected`                                                                                                                                                                      | 完成                                                                                                        |
| mention `$` 技能                                    | skills mention                                                             | `skillsService`                                                                                                                                                                                    | 完成                                                                                                        |
| mention `#` 会话                                    | 旧 zcodeSessionStore/taskQueryCache                                        | `sessionsMentionProvider` 切源 v4 sessions-index（`useWorkspaceSessionsIndexItems`）                                                                                                               | 完成（切源）                                                                                                |
| slash `/` 目录全集                                  | `SlashCommandPlugin`（workspace slashCommands+技能+子智能体广播）          | command 仅展示 CLI workspace slash catalog；技能与子智能体继续使用各自目录；UI 不追加 command 或维护内建白名单                                                                                     | 完成                                                                                                        |
| 未识别 `/` 命令 → 直发 CLI                          | customCommandPromptResolver                                                | 携附件或 web element context 不消费；`text.startsWith("/")` 且无上下文附件走 `handleSlashCommand`，未识别随 sendText 直发                                                                          | 完成                                                                                                        |
| workspace file tree「加入对话」                     | 全局事件                                                                   | `WORKSPACE_FILE_ADD_TO_CHAT_EVENT` → `appendWorkspaceFileMentionToComposer`（仅 primary pane）                                                                                                     | 完成                                                                                                        |
| 发送/停止/入队 状态机                               | ChatViewComposer submitControl                                             | `canSend` / `showStopControl` / `mode==="choice"` 两钮，读 `inputRouting.mode` + `control.canStop`                                                                                                 | 完成                                                                                                        |
| streaming 队列发送按钮                              | `shouldShowStreamingQueueSendButton`                                       | v4 `choice` 模式两钮（清空 queue / 保留 queue 立即发送）                                                                                                                                           | 完成（v4 队列语义）                                                                                         |
| Esc → 停止生成（弹窗内不误停）                      | `useChatViewEffects.shouldIgnoreEscapeForStopGeneration`                   | `composer/escapeStop.ts` + `SessionPane` window keydown（仅 primary pane，`control.canStop` 门控）→ `stop` 命令                                                                                    | 完成                                                                                                        |
| 工具条：模型 / 思考深度 / 模式 / context usage      | ChatInputToolbar                                                           | `V4ComposerToolbar`（展示件复用旧 chat-input-toolbar，值读 config、写发 v4 命令）                                                                                                                  | 完成                                                                                                        |
| 工具条键盘热键 Ctrl+M / Ctrl+Shift+M / Ctrl+T       | `useToolbarShortcutBindings`                                               | `composer/toolbarShortcuts.ts`（恢复为纯逻辑）；Ctrl+M→openRequestKey 开菜单、Ctrl+T→`getNextThoughtLevelValue`→switchModelConfig、Ctrl+Shift+M→`getNextConfigSelectValue`→switchCollaborationMode | 完成（本次补完）                                                                                            |
| queue 行为开关 autoDrain / followupMode             | —（v4 特有）                                                               | `V4ComposerQueueToggles`（复用 M4 input-control testid）                                                                                                                                           | 完成（v4 新增）                                                                                             |

### codeComment 加入对话链路

代码预览与 composer 继续通过 renderer 内的 cancelable event 解耦，不新增协议字段。只有
`listenAddToChatEvents=true` 的 primary pane 可以 claim 事件，避免分屏时一次点击写入多个输入区；
评论来源仍保留自己的 `workspaceIdentity`，删除按“来源 workspace key + comment id”精确匹配。

```text
代码预览提交评论
  -> CODE_COMMENT_ADD_TO_CHAT_EVENT
  -> primary V4 composer claim
  -> codeComment chip + 可发送状态
  -> buildPromptWithCodeComments
  -> sendText（仍是普通文本）
  -> accepted 后清 chip，并同步移除来源代码预览
```

发送被 `blocked`、要求队列二次确认或抛错时，不清 chip 和代码预览，用户可以直接重试。
这条链路只改变 renderer 草稿内容，不改变桌面 `desktop-continuous` 和手机
`web-remote-replayable` 的消息投递、snapshot、queue 或 owner 边界。

## 二、老版有、v4 未接（处置与理由）

| 能力                                     | 老版来源                                                                          | v4 现状                   | 处置 / 理由                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| 模型切换前上下文压缩守卫                 | `onRequestContextCompressionForModelSwitch`（`modelSwitchContextWindowGuard.ts`） | ✗（模块已随波次删除）     | 死期已到：v4 未复活；context usage 面的 `/compact` 入口仍在（`onSendCompressionCommand`）         |
| provider 恢复                            | `onRecoverWorkspaceProvider`（recovery 配置面）                                   | ✗                         | 配置/恢复面 v4 化前不接；不属会话输入核心                                                         |
| contextHeaderContent（头部 banner 插槽） | ChatViewComposer prop                                                             | ✗                         | 无对应 v4 头内容源；纯展示插槽，按需再接                                                          |
| onFocus（`handleInputFocus`）            | ChatPromptEditor onFocus                                                          | ✗                         | 旧用于清 blocking/聚焦副作用；v4 permission 面经 `inputRouting.mode` 门控，不经 composer focus    |
| blockingRequestId 隐藏 composer          | ChatViewComposer 整体 `display:none`                                              | 以 `mode` 门控替代        | v4 用 `inputRouting.mode`（reject→editing disabled、guide/choice→不可直发）替代整体隐藏，语义等价 |
| triggerPanelContainer 外置 portal        | `setTriggerPanelContainer`                                                        | ChatPromptEditor 内置回退 | 完成（等价）：`internalTriggerPanelContainer` 自解析，v4 无需外置容器                             |

## 三、Enter 提交策略说明

老版 `preferEnterNewline` 唯一来源是 `isWebRemoteControl`（`ChatViewComposer.tsx:177
preferEnterNewline: isWebRemoteControl`），并非用户设置项：

- 桌面端：`preferEnterNewline=false`，Enter 发送、Shift+Enter 换行。
- 手机 Web 远控：`preferEnterNewline=true`，Enter 换行，使用发送按钮提交。

v4 composer 继续通过 `resolveChatEnterSubmits` 统一计算，并将 `isWebRemoteControl` 作为
`preferEnterNewline` 传入；移动视口门禁仍由该函数负责，不能把手机语义扩散到桌面端。

## 四、结论

输入框核心能力（编辑器 / 草稿 / prompt history / 附件全链 / mention / slash / 发送-停止状态机 /
Esc-停止 / 工具条 + 键盘热键 / 动态 placeholder / Enter 策略）已全量对齐老版。未接项均为
**超 v4 vertical slice 范围**（代码评审/provider 恢复）或**已判死期**（模型切换压缩守卫），
非遗漏。

**勘误（2026-07-07）**：上述审计只覆盖了「已有会话」的 composer；**草稿态（sessionId=null）整块漏审**，
属真遗漏，不在「非遗漏」结论范围内。补审见 §五。

## 五、草稿态（draft / 空态）对账 —— 2026-07-07 补审

参考基线：z-code-2 线上 `ChatView.tsx` 草稿路径（`shouldShowChatViewEmptyState` /
`shouldUseCenteredDraftChatLayout` 分支）+ `ChatInputToolbar.tsx`（`taskId=null` 分支）。
v4 现状载体：`SessionPane`（`sessionId===null` → `draftMode`）、`ConversationComposer`、
`V4ComposerToolbar`。

现状根因一句话：v4 工具条三件套（模型/思考深度/模式）全部门控在 `config !== null` 上，
而 `config` 只来自会话投影 `snapshot.config`——草稿态无投影 → 控件整体不渲染；写路径
`dispatchConfigCas` 也在 `!sessionId` 时 skip。空态壳（workspace 菜单/问候语/居中布局）则完全没接。

### 5.1 工具条配置面（草稿态）

统一方案（与 10-protocol-spec §4.2.3 R-19 配套）：**草稿态读写 workspace 缺省配置，首发时随
`createSession.config` 携带**。

- 读面：`useToolbarConfigOptions(workspacePath, null, workspaceIdentity)` 的 `currentValue`
  （= workspace 缺省，配置面存活服务；后续切 v4 `workspace-config` topic 时消费面不变）。
- 目录水合（2026-07-07 二测补裁决）：旧 `useWorkspacePrepare` hook 随 M5② 删除后
  草稿态目录无人初始化（恒空 → 控件隐藏、agent 未拉起 → 首次 default 写失败）。
  水合责任归 `useDraftConfigControl` 挂载 effect：目录缺失时 `readWorkspaceState`
  拉取并写 store（per-workspace 单飞；顺带拉起 workspace agent）；水合期间模型菜单
  以占位 trigger 保持可见（app provider snapshot 分组已就绪即可点开）。
- 目录就绪边界（2026-07-21 bugfix）：`configOptions` 与 `slashCommands` 是两份独立目录，
  不得再用「已有模型目录」同时代表两者已经水合。task → draft 会继承模型目录，但会清空
  上一条会话的 slash 命令；此时空 slash 目录必须重新触发同一条 `readWorkspaceState`
  单飞，并按 `workspaceIdentity?.trim() || workspacePath` 写回当前 workspace 身份桶。

      task → draft
          ├─ configOptions: 保留 ───────┐
          └─ slashCommands: 清空 ──────┼─ 任一目录未就绪 → readWorkspaceState
                                       └─ 两份目录均就绪 → 跳过 RPC

  该修复只补 renderer 草稿目录水合，不改变 desktop continuous 或 web remote replayable
  的消息投递、snapshot、queue 与 owner 边界。

- 已知 session 导航边界（2026-07-22 bugfix）：`slashCommands` 是 workspace identity 级目录，
  选择同一 workspace 的已有 task 时不得先清空再等待 conversation projection 回填；projection
  只恢复 session 状态，不负责写 composer 消费的 workspace 目录。冷恢复或旧状态下目录确实为空时，
  `useDraftConfigControl` 也会在已有 session 下独立读取 workspace state，但不会覆盖 task config，
  也不会把草稿全局 model seed 应用到该 session。

      draft / task A：workspace slash catalog ready
                      │ select known task B（同 workspace identity）
                      ├─ catalog 非空 ──> 原样保留，composer 立即可用
                      └─ catalog 为空 ──> readWorkspaceState ──> 补齐 workspace catalog

  该修复不改变 desktop continuous 主链路，也不把目录水合扩散为 mobile replayable 的
  snapshot、gap、queue 或 owner 语义。

- 命令目录权威（2026-07-22）：CLI protocol workspace slash catalog 是 command 的唯一来源。
  UI 删除 M5 迁移期的 `extraSlashCommands`、内建白名单和 GLM `/goal` fallback；`/goal`、
  `/compact`、`/init` 与 custom command 均以 CLI 返回为准。UI 私有 `/resume-goal` alias 删除，
  恢复 goal 使用 CLI 已声明的 `/goal resume`。提交边界保留 command 路由，但不再参与目录声明。
- 写面：复用存活的 `lib/zcodeWorkspaceDefaultConfigControl.ts`（写 workspace default，
  保证「下一个新会话继承上次选择」语义——线上修过只写 draft 不写 default 的 bug，注释保真）。
- 首发：`createSession` 携带 `config`（partial，协议 `command.ts` 已支持），CLI 按 R-19 以
  runtime 真值 + 请求 config 归并出会话初值；UI 不再依赖「先建会话再切配置」。

| 能力                                                          | 老版来源                                                   | v4 现状                                                                                      | 处置                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 草稿态模型选择（显示 workspace 缺省 + 可切）                  | ChatInputToolbar `taskId=null` + `useToolbarConfigOptions` | `resolveDraftEffectiveConfig`（composer/draftWorkspaceDefaults）合成 display-only config     | **完成（2026-07-07）**                          |
| 草稿态模式选择                                                | 同上                                                       | `resolveDraftModeCurrentValue` + `V4ComposerModeSwitch` draftMode 分支                       | **完成（2026-07-07）**                          |
| 草稿态思考深度                                                | 同上                                                       | thought 目录 currentValue 回落（同 effectiveConfig）                                         | **完成（2026-07-07）**                          |
| 草稿选择写 workspace default（双语义：当前首发 + 新会话继承） | `setWorkspacePreferredModelWithSessionControl`             | `useDraftConfigControl`（写 default + 权威目录直写 store 回显）+ `createSession.config` 携带 | **完成（2026-07-07）**                          |
| 工具条热键 Ctrl+M / Ctrl+T / Ctrl+Shift+M 草稿态生效          | `useToolbarShortcutBindings`                               | 随 effectiveConfig 非空自然恢复                                                              | **完成（2026-07-07）**；e2e 断言待补（见 §5.6） |
| 会话建立后工具条初值非空                                      | 旧协议 settings 恒有值                                     | CLI R-19 种子已落地（c7ee7b914）                                                             | **完成（CLI 侧）**                              |

### 5.2 空态壳（empty state）

| 能力                                                                        | 老版来源                                              | v4 现状                                                                                                                                       | 处置                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| workspace 切换菜单（搜索/最多5项/打开文件夹/SSH 远程入口/断连 remote 过滤） | `ChatEmptyWorkspacePreviewMenu`（ChatEmptyState.tsx） | 组件原样复用；壳层（WorkspaceShellLayout）构造 `draftComposerHeader` 经 V4WorkspaceChatArea/V4ChatPane → SessionPane → composer contextHeader | **完成（2026-07-07）**       |
| Git 分支切换器（空态，锁定向上弹出）                                        | ChatView `contextHeaderContent`                       | 同上（`avoidPopoverCollisions=false` 旧 bugfix 保真）                                                                                         | **完成（2026-07-07）**       |
| 时间问候语 + ZCode Logo                                                     | `ChatView/ChatViewEmptyState.tsx`                     | 恢复为 `v4/ConversationDraftEmptyState.tsx`（compactForRemoteControl prop 收敛为 max-md 响应式）                                              | **完成（2026-07-07）**       |
| 居中草稿布局（composer 垂直居中）                                           | `shouldUseCenteredDraftChatLayout`                    | SessionPane draft 分支：问候语 + composer（`centered`，max-w-2xl 去 sticky）垂直居中                                                          | **完成（2026-07-07）**       |
| `TID_CHAT_EMPTY` e2e 锚点                                                   | ChatView 空态区                                       | draft 居中容器携带                                                                                                                            | **完成（2026-07-07）**       |
| scratch workspace（临时工作区）入口                                         | `ChatEmptyScratchWorkspaceDialog`（经空态菜单）       | ✗（组件存活未接；旧入口不在菜单组件内部）                                                                                                     | 待接（需先确认旧触发点归属） |

新建对话从首个可见帧直接使用草稿居中布局。切入空草稿时，composer dock 不执行
`width/max-width/transform` 过渡：内部 composer 已立即收窄，外层再缓慢收窄会把它从左侧
带到中间。布局直接由已有 `centeredEmptyLayout` 决定，不等待模型目录或增加计时状态。
普通会话的消息列和输入区也直接采用最终宽度及偏移，见 [对话主列的布局稳定性](../ui/chat-summary-panel.md#对话主列的布局稳定性)；桌面与手机 Web 共用此规则（SP01 / SP07）。

#### 5.2.1 低高度窗口标题位置（2026-07-30）

- 默认高度继续使用现有“问候语 + composer dock”整体居中布局，不改变 Logo、标题、
  composer、横幅或模板之间的既有间距。
- 草稿内容组采用连续的安全居中约束：上下空间充足时保持整体居中；空间不足时停止继续
  上移。桌面窗口继续使用跨页面共用的 `480 × 640px` 原生基础下限，renderer 禁止根据
  草稿 DOM 高度动态调用 `setMinimumSize` 或 `setBounds`，否则宽度变化引发的本地化换行会
  形成 `ResizeObserver → IPC → 原生窗口反向扩高` 的拖动反馈环。标题顶部保留 `52px`，
  最后一张卡片下方保留 `16px`；当前显示器或窗口无法容纳全部内容时，由草稿 timeline
  自身滚动保证内容可达。禁止按 `zh-CN`、`en-US` 或任何当前文案样本写死窗口总高度。
  禁止通过固定高度断点在两套布局间硬切换，避免窗口跨过临界高度时标题、Logo 与 composer
  整组跳动。默认宽屏下，问候标题、Logo 与 composer dock 必须共享
  同一条水平中心轴；空态布局容器不得让问候容器回退到起始边对齐。顶部与底部使用连续
  伸缩 spacer：空间充足时等分留白以保持原有整体居中，受限时分别停在 `52px` 与 `16px`
  下限，不能使用两条不同下限的 `1fr` Grid 轨道把底部错误抬高到 `52px`。
- 问候标题默认保持 `30px`，字号不得绑定窗口宽度、chat 宽度或固定 viewport 断点。
  只有标题文字按 `30px` 排版后确实超过标题自身的水平可用宽度时，才根据实际缺口按
  `1px` 档位逐级缩小，最低为 `20px`；标题两侧仍有空间时，即使窗口已经达到最小尺寸，
  也必须保持 `30px`。测量必须基于本地化后的真实文案，避免中文未受挤压却缩小，或英文
  长文案已经受挤压却仍沿用大字号。
- 上述标题测量和 `52px / 16px` 安全间距仅用于桌面草稿首页。手机 `/remote` 继续使用原有
  `20px` 紧凑标题与 `justify-center + 16px gap` 居中布局，避免把桌面空态的装饰性空间和
  测量逻辑扩散到移动端 replayable 界面。
- 低高度约束只改变草稿内容组的纵向起点；标题到 composer dock 的原有间距保持不变，
  超出部分仍由现有 timeline 滚动容器承接。草稿布局容器必须保留内容固有高度，不能使用
  `h-full min-h-0 overflow-hidden` 把溢出截断。桌面草稿空态 timeline 固定从顶部开始展示，
  避免既有吸底语义把安全顶部留白滚出视口；离开草稿空态后仍恢复原会话吸底语义。

### 5.3 草稿行为逻辑

| 能力                                                                   | 老版来源                            | v4 现状                                                                                       | 处置                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| draft session 预热（`draftSessionId`：预建真实会话，首发复用）         | `useWorkspacePrepare` 等            | v4 原生预热（§5.4，`useDraftSessionPrewarm`）                                                 | **接（2026-07-07 四测撤销「不复活」裁决）**：原裁决把旧预热链的补丁包袱和预热本身一起扔了，后果是草稿配置被迫走 workspace-default 旧 RPC（回包 `buildWorkspaceState` 无 session 在册时临建完整 app，140-798ms/次）。v4 形态见 §5.4——旧链三个补丁在 v4 形态下无对象仍判死期 |
| 切 workspace 草稿 provider 继承（目标 workspace 记住的 provider 优先） | `workspaceDraftProvider.ts`（存活） | `App.handleStartDraftInWorkspace` 已在调用该函数；空态菜单 onSelectWorkspace 接的正是这条链路 | **已存活（复核 2026-07-07，无需新代码）**                                                                                                                                                                                                                                  |
| provider 恢复 `onRecoverWorkspaceProvider`                             | §二已登记                           | ✗                                                                                             | 维持 §二裁决：配置/恢复面 v4 化前不接                                                                                                                                                                                                                                      |

### 5.4 草稿态 = v4 draft session 预热（2026-07-07 用户裁决「关键功能」）

目标形态：**进草稿态即建 v4 draft session（`createSession` 无 firstInput → phase=draft，
纯内存不落盘），它就是预热载体**——与 10 §4.2.1「pane 绑 draft session 则服务端已有
会话实体」的设计意图对齐。收益：首发零等待；配置写走 v4 原生 CAS 命令（不再进
workspace-default 旧 RPC 的 buildWorkspaceState 热路径）；工具条读会话投影（R-19
种子给 runtime 真值）。

实现口径（`useDraftSessionPrewarm` + SessionPane 接线）：

- **注册表生命周期**：只在已提交且启用预热的 effect 中登记 coordinator，并在同一 effect
  acquire/release；普通历史会话、未启用草稿及被中止的 render 不登记。无订阅、无页面保活、
  无在途创建后，必须移出 transport/owner Map，释放 dispatch 闭包对已关闭 store 与历史投影的引用。
  StrictMode 同步重挂继续复用原 owner；不增加缓存、回收超时或第二份生命周期状态机。
  验收以跨工作区历史切换 → 返回空草稿 → keep-warm 到期 → GC 后的堆快照为准：
  每轮空闲 coordinator 为零，多轮切换结束及停止切换后的历史 snapshot、closed store 均须释放；
  中间检查点仍保存完整计数与快照，以区分当前编辑器闭包保留和注册表累积。RSS 下降不能代替释放断言。
- **创建**：pane 未绑定会话（sessionId=null）时后台 `createSession`；显式分屏的 draft pane
  仍按独立 pane 预热并保持绑定语义隔离。同一逻辑草稿的 owner 固定为
  `{ workspaceKey, paneId, transportGeneration }`：同一事件循环内的组件重挂、StrictMode effect 重放
  必须复用同一个 pending/ready 预热，不得再次排入 `createSession`。真实卸载后的重新挂载若旧创建
  尚在飞，则必须等待旧 owner 退休完成。
  模型 readiness 归属本次草稿检查生命周期：从正式会话进入草稿的首帧即为 checking，
  不得先复用旧 ready 启动预热，再由 effect 回收。同路径再次进入草稿或切换模型目录服务时，
  旧检查和旧首发复查的迟到结果不得覆盖当前检查。
  `draftRuntimeInvalidationVersion` 连续变化时只保留最新目标代；旧创建尚在飞时必须等其 ACK 后先发
  清理，再创建最新代，任意时刻同 owner 最多一个 `createSession` 在途。
- **绑定语义不变**：pane 对外仍是 draft（shell 的 activeTaskId 仍 null，WorkspaceHeader
  等壳级 draft 判定不受影响）；预热会话是 pane 内部 effectiveSessionId，lease/投影
  照常订阅。草稿 UX（问候语/居中/workspace 菜单）仍键在 pane sessionId===null。
- **草稿配置单一意图源**：模型、思考深度和模式先写 renderer 的 reactive draft intent，
  工具条在下一帧直接回显；模型与 thought 作为同一个配置元组，跨模型时不得继承源模型
  thought。预热就绪后只用 v4 CAS 命令直写这个明确 sessionId 的既有 App。草稿点击禁止再发
  `workspace/setDefaultModel|ThoughtLevel|Mode`，也不能等待 workspace state 广播后才更新 UI。
- **thought 能力归属目标模型**：草稿 intent 尚未绑定权威 session 时优先读 provider metadata；
  已绑定/历史/fork session 必须读 `SessionConfigState.thoughtLevels`，由 Agent runtime 的
  `listThoughtLevels()` 与 `provider/model/thought` 同一 snapshot/event 原子投影。GLM-5.2 这类由
  CLI 默认策略动态补齐的模型不能依赖 legacy task config cache，也不能借用源模型目录或退回
  客户端写死的通用五档。
- **投影确认与持久化**：预热 projection 只负责确认 runtime 实际配置；只有 projection 与最新
  intent 的 provider/model（以及显式 thought）匹配后，才整体持久化 model + thought 元组。
  迟到 projection 不得覆盖更新的草稿 intent。预热未就绪时 intent 随 `createSession.config`
  创建，ready 后只补投仍不一致的字段。
- **顺序与合并**：配置命令和首发共用同一顺序屏障；发送必须等最新 intent 收敛。快速连续
  选择允许合并尚未开始的中间值，只同步最后一个 intent，不能让旧值在队列中逐条回放。
- **首发**：`sendText` 直发预热会话（附件经 `attachment/begin -> chunk -> commit` 上传到它，不再需要
  「先建空会话再传附件」的两段式）→ 成功后 pane 经 onSessionCreated 正式绑定。
  renderer 在发出首条 admission 命令前必须先把原 binding 同步标成 `promotion-pending`；
  ACK accepted 后再转成 `promoted`，明确拒绝或失效则转成 `discarded`。MCP 初始化、hooks 或 transport
  回压都可能让 Agent 已开始运行而 renderer 仍在等待 ACK，owner cleanup 在这个窗口内不得把该
  session 当成未使用 draft 删除。
  **2026-09-15 单一创建归属修正**：首发必须向同一个预热 owner 等待当前创建任务，
  不得把 `binding === null` 当成“没有创建”而另发 `createSession`。普通文本、附件、
  shared context 和 `/goal` 共用此入口；配置仍在创建时初始化，首发携带点击时冻结的 Submission。
  创建失败时本次提交失败并保留草稿；后台有界重试与用户显式重试仍由原 owner 管理，
  不再另设发送侧创建入口。等待期间 workspace、
  transport、invalidation 变化或真实卸载后，旧提交不得发送到新会话。首发 admission 结果未知时
  保留原 binding 的 pending 生命周期，禁止换会话自动重发。
  新草稿订阅已经建立、但旧创建仍在 retiring 时，本次首发先等待旧创建收口，再等待
  当前订阅的创建；不能把 retiring 本身当成用户切换。等待资格按草稿订阅生命周期身份
  校验，不能仅比较 invalidationVersion：即使版本相同，离开后再次进入也不能接续旧提交。
  任一等待期间发生真实离开、workspace/transport 或版本变化，原提交都必须失效。

  ```mermaid
  sequenceDiagram
    participant D as 草稿预热 owner
    participant S as 点击发送
    participant C as CLI
    D->>C: createSession（唯一创建）
    S->>D: 等待当前创建任务
    C-->>D: session A
    D-->>S: 同一代 binding A
    S->>C: sendText / goal（A，冻结的 Submission）
    C-->>S: accepted
    S->>D: promote A，绑定详情页
  ```

  回归覆盖：延迟创建 ACK 时先点击发送，释放 ACK 前只有一条 createSession；释放后首条
  admission 指向同一 session，覆盖普通文本、附件/context、goal、失败、换代和同步重挂。
  桌面 continuous 与手机 shared-host replayable 均复用 UI owner；不改变 Host/runtime、
  accepted input queue 或 stream 恢复边界。

- **清理**：未首发就切走（选中其他任务/切 workspace/关分屏/卸载）→ `deleteSession`
  预热会话；effect cleanup 先给同 owner 的同步重挂一次接管机会，确认为真实离开后再清理。
  只有仍处于 `draft` 的预热会话允许自动删除；`promotion-pending`、`promoted`、`discarded` 都禁止
  cleanup 发 `deleteSession`，避免关闭已经 admission 或结果未知的运行态。
  已经发出的 `createSession` 不可取消时，owner 保留 retiring 状态直到 ACK 到达并排入删除，禁止新
  owner 绕过它并发创建。renderer 刷新来不及清理的孤儿随 CLI 退出消失（内存态），可接受。
- **workspace / transport 所有权**：预热资源不是可跨 workspace 复用的裸 `sessionId`，而是
  `{ workspaceKey, paneId, transportGeneration, sessionId, controller, dispatchCommand }` 同属一个
  owner 的 binding。`workspaceKey` 继续统一取 `workspaceIdentity?.trim() || workspacePath`；
  transport 换代由 workspace connection registry 持有的 `SessionDataLayer` identity 区分；provider
  wrapper 重建产生的新 `sendCommand` 函数不得误判为换代。同 workspace
  内仅 lease 变化时更新该 binding 的 lease，不重建预热；workspace 或 transport 换代时，
  新 render 立即停止暴露旧 binding，旧 binding 的 cleanup 仍只能通过创建它的 dispatcher
  删除旧 session。首发 ACK、订阅失败等异步收口必须捕获并操作原 binding，禁止通过
  `controllerRef.current` 或全局 mutable dispatcher 误操作后来创建的 binding。该约束同时
  适用于本地、SSH/WSL/Docker 和 Web shared-host attachment，不增加 remote 特判或独立 runtime。
- **列表隔离**：CLI gateway 的 `isDraftSession`（persistence=deferred）已在
  fanOutToIndex 与冷启动种子两处把 draft 排除在 sessions-index 外，预热会话不会
  以「新任务」漏进侧栏。
- **降级链**：预热失败/未就绪期间，工具条回落 workspace 目录 currentValue（§5.1
  只提供模型目录/能力；当前选择仍以 renderer draft intent 为准），交互不阻塞。

草稿配置的状态与同步顺序固定为：

```text
toolbar click
  -> renderer draft intent（立即回显）
  -> explicit prewarm sessionId
  -> v4 switchModelConfig | switchCollaborationMode
  -> CLI existing App
  -> projection confirms actual config
  -> persist confirmed model + thought tuple

first send
  -> seal/flush config intent
  -> sendText
```

`workspace/setDefault*` 是 workspace catalog 的兼容接口，不属于 v4 草稿交互链。其实现即使仍被
其它旧入口调用，也不得通过“创建完整临时 App、加载 plugin/MCP、映射状态后立即关闭”来服务一次
配置点击。

#### 5.4.1 首发 promotion 的 composer 连续性（2026-07-10）

草稿首发从 `sessionId=null` promotion 到正式 session 时，`ConversationComposer` 必须保持
同一个 React 实例和编辑器 DOM，不得因为草稿居中容器与会话 timeline bottom dock 使用
不同父节点而卸载重建。草稿态和会话态共用一个持续挂载的 conversation viewport：草稿时
只通过布局把问候语与 composer 居中，正式绑定后只通过布局把同一 composer 切到底部 dock。
本次不增加位移动画。

```text
draft centered viewport
  -> send accepted / sessionId bound
  -> snapshot pending: blank timeline + same visible disabled composer
  -> first userInput projection: normal timeline + same composer dock
```

- 绑定后首个 snapshot / `userInput` row 尚未到达时，timeline 内容区保持空白；不显示
  “发送第一条消息开始对话”，也不由 UI 乐观伪造 user row。
- 真正存在但 rows 为空的正式 session 同样使用空白 timeline + bottom composer。
- composer 发送成功仍在 command ACK accepted 后清空；promotion 必须捕获并清理发送开始时的
  draft scope，禁止 scope 从 `__draft__` 切到 sessionId 后残留首条输入、下次新建任务又恢复。
- subscribe error 仍使用独立错误布局；本节只约束正常 draft → session promotion。
- desktop 与手机 Web 共用相同组件身份和响应式布局；不改变 `desktop-continuous` /
  `web-remote-replayable` 的投影交付边界。

### 5.5 模型切换的记录语义（2026-07-07 五测裁决）

用户裁决：**切换动作是意向，不是 timeline 事实**。草稿态还没发过消息（截图
sess_54392f61：首条消息上方挂 [modelChange]），编辑期切换也只是准备动作——
两者都不进 timeline；发送后模型相对上一轮真的变了，才落记录。

- **marker 时机**（CLI 投影，spec 10 §config「R-17 时机细则」）：`modelChange`
  marker 由 onTurnStarted 按「本轮 provider/model 身份 ≠ 上一个实际启动的 turn
  的 provider/model 身份」裁决；思考深度只更新 `config.thought` 与请求参数，不产
  `modelChange`，
  落在新 turn 的 turnHeader row 之前；首轮（无上一轮基准）永不产 marker；
  A→B→A 净变化为零不产 marker。onModelSelected 只更新 config，不再落 marker
  （旧实现在选型事件即落 marker，正是草稿态 bug 的根因）。
- **marker 文案身份**（2026-07-29）：CLI marker 已携带起止 provider/model ID；
  renderer 必须订阅 provider snapshot 并映射供应商名称。Z.ai / BigModel 内置供应商只显示
  modelId；其他供应商显示 `provider.name/modelId`，配置缺失时回落 provider ID。该规则与模型
  触发器和 toast 一致，不改 marker schema、落位、desktop continuous 或 mobile replayable
  语义；目录稍后水合或供应商改名时，已渲染 marker 必须原地刷新名称。
- **toast = 性能下降警告，不是切换确认**（2026-07-29 更新，取代 2026-07-07
  六测纠偏，2026-07-30 收紧草稿边界）：只有已绑定会话中的显式 `provider + model` 身份切换
  才立即显示 changed + warning 文案；草稿态的普通选择、configOptions error custom provider
  恢复和 prewarm fallback 都不显示 toast。提示不等待切换 ACK，也不代表命令已经成功。
  Agent registry 自动 fallback 在已绑定会话的当前聚焦 pane 首次通过实时 `online` 帧观察到带来源的
  权威 A→B 跃迁时复用同一文案；草稿 prewarm、initial/recovery、历史 snapshot、建立首个
  applied base 的完整 online snapshot、duplicate delta 和后台 pane 不提示。自动
  fallback 的 last-selected CAS 只与这条实时回调共同发生，普通 snapshot 差异不得写。两种状态
  仍都不由 UI 写 timeline 行；marker
  时机继续遵循上一条。当前完整判定链路见
  `docs/chat/manual-model-switch-resolution-chain.md`。
- **重放确定性**：marker 由事件序列（ModelSelected + TurnStarted）确定性推导，
  冷恢复/fork 重放同一口径；transcript hydration 不合成 modelChange marker，
  无历史迁移问题。

### 5.6 验收口径

- e2e：草稿态可见模型/模式/思考深度控件且值 = workspace 缺省；草稿态切模型 → 新建会话
  首个投影 `config` 等于所选值（经 `createSession.config` + R-19 种子归并）；空态可见
  workspace 菜单 / 问候语 / 居中布局锚点。
- 覆盖矩阵：按仓库规则先补 `docs/conversation-session-case-catalog.md` 与
  `docs/testing/conversation-session-e2e-coverage-matrix.md` 再写 case。

## 六、context usage 面板对账 —— 2026-07-07 七审

2026-07-09 更新：重构中曾给 `ChatContextUsage` 增加 `contextCapacityTokens`
派生分支，导致只有模型窗口、真实占用为 0 时也渲染 `0/max` 圈；这与老版不一致。
当前口径恢复为：context window 只有 `used > 0 && size > 0` 才展示；Coding Plan /
Start Plan 余额独立于 context usage，但必须由“当前模型连接方式”确认为 OAuth
Coding Plan、Team Plan 或 Start Plan 后才展示。

| 能力                                                                                                            | 老版                                                                                                                                                                       | v4 现状                                                                                                                                      | 处置                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 总量行（used/size + 百分比，compact token 格式）                                                                | ✅ 仅真实正数占用展示                                                                                                                                                      | ✅ 已接（`snapshot.usage.contextWindow`）；0 占用不再从模型容量派生展示                                                                      | 无                                                                                                                                                       |
| **分段进度条 + breakdown 分项占比**                                                                             | ✅ 7 类 source（messages/system_prompt/meta_user_context/skills/tool_prompt/system_tool_schemas/mcp_tool_schemas），按占比降序、只显示百分比不显示分项 token（防口径混读） | ❌ v4 `SessionUsageState` 无 `breakdown` 字段，组件收不到数据整段不渲染                                                                      | **接**：CLI `ModelComplete` payload 已带 `contextUsageBreakdown`（core `turn-model-step.ts` 仅 main_turn 附带）→ v4 schema additive + 投影 + UI 透传即可 |
| **缓存命中率**                                                                                                  | ✅ 累计口径 `cacheHit.hitRate`（主轮聚合，`recordMainTurnCacheHitUsage`），**≥78% 才露出**（低命中率会把注意力从容量本身带偏）                                             | ❌ 同上，`SessionUsageState` 无 `cache` 字段                                                                                                 | **接**：payload `cacheHit.hitRate` 已有，同 breakdown 三层接线                                                                                           |
| **Coding Plan 用量面板**（`ChatCodingPlanUsageRemainingPanel`：多供应商切换、剩余量、点击跳设置用量页并收面板） | ✅ 只跟随当前 paid Coding / Team 连接                                                                                                                                      | ✅ v4 toolbar 已接 `codingPlanUsageRemaining`，并按当前 provider + family selected key 门控；Team Plan 支持 entitlement snapshot 兜底 source | 无                                                                                                                                                       |
| **Start Plan 余额面板**（zai/bigmodel：余额、loading、升级入口点击先收面板再跳设置）                            | ✅ 只跟随当前 Start Plan 连接，且同品牌 paid Coding active 时隐藏                                                                                                          | ✅ v4 toolbar 已接 `startPlanBalance`，沿用 Start fallback 与当前连接门控                                                                    | 无                                                                                                                                                       |
| 无 usage 仅有 plan 数据时 trigger 仍显示（草稿态/新会话也能看 plan 用量）                                       | ✅（`!renderableTaskUsage && hasCodingPlan/hasStartPlan` 仍渲染）                                                                                                          | ✅ 仅在当前连接为 Coding/Team/Start 且有可展示余额或 loading 时显示                                                                          | 无                                                                                                                                                       |
| `/compact` 压缩入口（`onSendCompressionCommand`）                                                               | 传了但组件**未消费**（死参数，`getContextCompressionCommand` 无 JSX 引用）                                                                                                 | 同样传了                                                                                                                                     | 无缺口；后续可清理死参数                                                                                                                                 |

实现批次（批准后执行）：

1. **一期（usage 数据面，纯三层透传）**：
   - `packages/shared/src/zcode-protocol-v4/snapshot.ts`：`sessionUsageStateSchema` additive
     增加 `cache: { hitRate: number|null } | null` 与 `breakdown: ContextUsageBreakdownItem[] | null`
     （P-05 conflation 不变；G-02 usage 语义扩展需同步 10-protocol-spec §4.2.4）。
   - CLI `product-projection.ts` `onModelComplete`：main_turn 时从 `payload.cacheHit.hitRate` /
     `payload.contextUsageBreakdown` 并入 usage patch（沿用旧 reducer「仅主轮可覆盖」裁决）。
   - UI `V4ComposerToolbar`：`taskUsage` 透传 `cache`/`breakdown`（`ChatContextUsage` 现成消费）。
2. **二期（plan 面板）**：已接。后续若继续抽 hook，必须保留当前连接门控、Team source
   兜底和 Start fallback，不得回退到“账号有套餐就显示余额”。
