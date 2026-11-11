# 选区注释

一条注释 = 一段被选原文 + 可选评论。本模块提供注释输入/编辑浮层、正文编号标记与共用的编号气泡；
调用方（`v4/ConversationSelectionTooltip.tsx`）冻结被选原文、文字锚点与浮层位置，评论随同一条对话引用的
`comment` 发给模型。

不变量：

- 浮层不跟随 `useTextSelection` 的选区状态：聚焦输入会折叠正文选区并触发 keyup/selectionchange，跟随会在键入第一个字时关闭。
- 评论可选：新增时空评论 = 只加原文；编辑时清空评论 = 回到只保留原文，不删除注释。删除只由编辑态“删除注释”或列表垃圾桶触发，并给 6 秒撤销。
- 保存值已 trim；输入法组字中的 Enter 不保存，Shift+Enter 换行，Esc/取消/点击浮层外由调用方关闭。
- `onSave` 返回 false（注释条数或总长已满）时浮层不关闭、输入保留，调用方通过 `error` 显示本地化原因。
- 正文标记只读文字锚点还原出的 Range 画在消息层覆盖层上，不改行组件；还原失败（行未挂载、文字已变）就不画。编号 = composer 列表位置。
- 入口能力由 `useSelectionCommentSupport` 决定：只有当前 workspace 的 CLI 在 `runtime/capabilities` 声明 `conversationQuoteComment` 才显示“注释”与编辑入口；查询失败、旧 Host 或远端未实现一律隐藏。
- 不持有引用作用域或草稿；去重、条数上限、rewind 剪枝、撤销恢复与已发送记录归 `lib/conversationSelectionReference.ts`。

依赖 `ui` 的按钮、toast、i18n 与选区浮层定位 hook。行为依据：[选区注释](../../../../docs/ui/conversation-selection-side-chat.md)。
