# Chat View Composition

> **历史状态**：本文记录 V4 迁移前对 `ChatView` 的拆分方案，相关组件和 hooks 已删除。
> 当前页面编排入口是 `packages/ui/src/v4/SessionPane.tsx`、`V4ChatPane.tsx`、
> `ConversationTimeline.tsx` 与 `ConversationComposer.tsx`；下文不作为当前实现规范。

## 目标

`ChatView` 和 `ChatViewConversation` 按领域边界拆分，降低单文件 wiring 复杂度，并让底部输入区、消息滚动区、历史补拉和滚动状态机可以独立演进。

## 分层职责

- `ChatView` 是页面编排层：收集 hooks/state，决定 summary、empty、conversation 和 composer 的显示分支，并拥有消息区 `scrollRef` 与 `contentRef` 的 DOM 结构。
- `useChatViewGoalVerificationSummaries` 承接 goal 校验摘要缓存和 runtime/message 摘要合并，避免 `ChatView` 直接维护摘要去重细节。
- `useChatViewSummaryPanelRoom` 承接 summary panel inline 布局的 ResizeObserver 和可用宽度判断，`ChatView` 只消费 `hasInlineRoom`。
- 官方版本安全校验的自动恢复和重试流程由独立 hook 承接，保留 provider/workspace 依赖注入，避免把恢复副作用混在页面渲染分支里。
- `useChatViewStartPlanQuotaBanner` 承接 Start Plan 额度/并发横幅的错误接管、dismiss key、提交阻塞和自动刷新。
- `useChatViewRestoredHistoryPreviewCutoff` 承接历史恢复期间 preview card 禁用时间，避免恢复消息异步补高度干扰首屏。
- `ChatBottomDock` 是聊天底部停靠区：负责 `chat-composer-region`、sticky bottom 布局、错误/额度/队列提示、权限和问答弹窗，以及 `ChatViewComposer` 的组装。
- `ChatViewConversation` 是消息内容区：负责历史 loader、消息 turn group、查找高亮和 fork 锚点，不渲染 `overflow-y-auto` 容器，也不持有 bottom dock slot。
- V4 Conversation 主滚动容器只承载纵向滚动，必须同时使用 `overflow-x-hidden overflow-y-auto`；表格、代码块等宽内容由各自内部 scroll container 提供横向滚动，不得把横向滚动条泄漏到整条会话。
- `ChatConversationContent` 后续承接 turn group 渲染、历史 loader 和远控生成占位，不持有滚动状态。
- `useChatConversationScroll` 后续承接 bottom-lock、scroll memory、scroll-to-bottom button、ResizeObserver 和定位型滚动边界。
- `useChatConversationHistory` 后续承接 top sentinel、历史补拉和补拉后的 scrollTop 回补。

## 边界规则

- `ChatView` 渲染 `scrollRef -> contentRef -> ChatViewConversation + ChatBottomDock`，滚动容器和内容容器的 DOM ownership 不下沉到 conversation。
- `contentRef` 使用 `flex min-h-full flex-col`，conversation 外层使用 `flex-1`；没有滚动条时由 flex 剩余空间把 `ChatBottomDock` 推到底部，有滚动条时由内容自然撑高并继续使用 sticky。
- `chat-composer-region` 保持在 `contentRef` 内部，并使用 `sticky bottom-0` 在滚动容器底部吸附。
- `SessionPane` 中 status panel 与 `ConversationTimeline` 的共同内容根提供具名 `conversation` container；自动 status panel 在 `1280px` 以下显示 mini，达到阈值后展开。自动和始终展开模式仅在 `@min-[1280px]/conversation` 命中时让消息列、历史补拉入口和 composer dock 左移 `168px`（`-translate-x-42`）；窄容器与始终收起模式不偏移。已绑定会话在 `conversation < 864px` 时使用 `w-full`，达到 `864px` 后使用 `calc(100% - 96px)`、`max-w-4xl`，达到 `1280px` 后统一切换为 `calc(100% - 384px)`、`max-w-6xl`。真正新草稿仍使用 `max-w-2xl`。
- Conversation 主列宽度、草稿宽度、status panel 的 `1280px` container 边界、`168px` 偏移和 `auto / panel / mini` 布局映射统一定义在 `conversationLayout.ts`，调用方不得拆成互不知情的宽度与偏移模块。
- 上述三个 V4 内容容器的宽度过渡按 container 断点分级：默认（`< 1280px`）使用 `transition-[width,max-width,transform] duration-150 ease-out`，让 `w-full ↔ max-w-4xl` 的中等宽度切换平滑；达到 `1280px` 后用 `@min-[1280px]/conversation:transition-[transform]` 降级为只过渡 transform，面板让位触发的 `max-w-6xl` 与 `168px` 左移不再同时做宽度动画，避免大范围跳变叠加位移产生明显抖动。
- 普通会话的 composer dock 保持 `px-2`；底部 `16px` 留白由 timeline 根容器的 `pb-4` 提供，位于滚动视口之外。dock 本身不再保留底部 padding，输入框仍在同一个滚动视口内 `sticky bottom-0`，滚动条延伸到输入框底边。草稿居中布局及浮窗的输入区高度避让保持不变。
- 每轮消息默认使用 `px-4`；具名 `conversation` container 达到 `md` 后通过 `@md/conversation:px-6` 增加水平内边距，不再使用反向的 `@max-md` 或 viewport `max-md`。
- 消息层不使用 mask 或渐隐，不增加底部背景遮蔽层；滚动视口用原生 overflow 裁剪，底部留白不属于可滚动区域。消息可以从输入框两侧及圆角外侧经过，但不能出现在输入框底边与面板底边之间。移除遮罩的逐次 scroll 样式写入、专用 ResizeObserver 和相关测高暂停/恢复逻辑；虚拟列表、吸底、历史定位和滚动记忆沿用既有 owner。
- “滚动到底部”按钮作为 `ChatBottomDock` 的内部 slot 渲染，点击行为由 `ChatView` 持有的滚动状态机提供。
- 远控链路只影响渲染和历史补拉策略，不把 replayable 恢复语义扩散进桌面 continuous 滚动主链路。

## 迁移顺序

1. 抽离 `ChatBottomDock`，先减少 `ChatView` 的底部停靠区 JSX。
2. 抽离 composer banner/dialog 子组件，进一步压缩 region props。
3. 抽离 `ChatConversationContent`，把 turn group 渲染从滚动状态机中分离。
4. 抽离 `useChatConversationHistory`，单独维护历史补拉和补拉后的滚动回补。
5. 抽离 `useChatConversationScroll`，最后迁移 bottom-lock 和 scroll memory。
6. 抽离 `ChatView` 的摘要派生、summary panel inline 宽度监听、安全校验自动恢复副作用、Start Plan quota 横幅状态和历史恢复 preview cutoff，让主组件只保留页面 wiring。
