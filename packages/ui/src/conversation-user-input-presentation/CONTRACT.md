# 用户消息正文组合

模块公开现有 `v4/ConversationUserInputBubble.tsx` 入口，把用户正文、渠道 mention、附件提示和尾注组合为同一个展示气泡。
正式消息和准备态复用同一组件；调用方持有消息、附件与行状态，组件不建立副本，也不发送或入队。

`contract.ts` 从实际组件推导输入类型，避免另一份手写 props 漂移。图片文件预览上下文只传给正文渲染，读取与失效规则由 `image-preview-editor` 拥有。
没有正文且没有尾注时不显示气泡。加载、排队等行状态由外层消息行展示。

依赖 `ui` 的既有正文组件、`shared` 的渠道消息类型和图片预览模块公开的上下文类型。
不改变桌面 continuous 或手机 replayable 链路，也不访问 runtime 或持久化。

行为依据：[共享图片预览规格](../../../../docs/ui/shared-image-preview-dialog.md)。
