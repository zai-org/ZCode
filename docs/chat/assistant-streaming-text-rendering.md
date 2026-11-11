# Assistant Streaming Text Rendering（当前事实）

Assistant 正文来自 V4 `assistantText` row。CLI reducer 产生 row delta，`ConversationProjectionStore` 应用后，`ConversationRowView` 把当前完整 `row.text` 交给 `MessageResponse`/Streamdown 渲染。

当前没有旧 `useTaskStreamEvents` 50ms batch，也没有 UI 自行维护的逐词 reveal 队列。节奏由权威 delta 到达和 React 渲染决定；结束态必须与 snapshot 中的 row 文本逐字一致。

```text
CLI text event -> ProductProjection row delta -> SessionDataLayer
  -> ConversationProjectionStore -> ConversationRowView -> MessageResponse
```

优化流式体验时不能在 UI 生成第二份正文或用 timer 改写最终文本；合批必须保持 seq、rowId 和 snapshot/delta 收敛语义。

## 长会话流式更新的计算边界

文本追加必须保持当前 reasoning / assistantText 可见更新。消息投影仍是唯一正文来源，
不增加 reveal 队列、延时合批或第二份消息状态。

- 插件展示裁决按回合首次出现的顺序计算最近回合；查重与被替代工具查找不得随历史规模形成嵌套全量查找。
- 导航预览保持既有空白归一、段落上限、字符上限与省略号语义。只扫描足够确定预览的前缀，不能每次追加都先处理所有历史正文再截断。
- 分享关闭时不构建分享回合和摘要；打开后从当前权威快照构建，随后继续响应更新。导航 query 与分享 product turn 的身份语义保持不变，分享目录按回合一次分组。
- 桌面 continuous 与手机 replayable 使用相同纯派生逻辑；主题、语言、滚动跟随与分享选择行为保持不变。

```text
row delta → 权威 projection → timeline / 当前文本
                           ├→ 有界导航预览 + 线性插件裁决
                           └→ 分享打开时构建目录
```

## 每帧派生成本的不变量

桌面 continuous profile 的 `flushWindowMs` 是 30ms（`packages/shared/src/zcode-protocol-v4/core.ts`），
相邻同 `(rowId, path)` 的 delta 在服务端已由 `coalesceConversationDeltas` 合并。
渲染端因此约 33 帧/秒收到一条追加，**渲染端不再二次节流**。

架构上已经把历史冻结住：`advanceConversationRowsPartition` 只改尾轮时复用 history 数组引用，
虚拟历史 turn 的 memo 整体 bail，正在流式的那一轮作为 live tail 留在普通文档流
（`ConversationTimeline.tsx`，不进 virtualizer 测高）。成本集中在 live turn 内部，与历史轮数无关。

因此，live turn 内每帧的派生必须守住三条：

- **纯追加时不得重算已稳定前缀。** `row.text` 是追加式增长，判定用 `next.startsWith(prev)`。
  对全文做线性扫描的派生（代码注释投影、code range 查找、图片归并、公式归一、citation 投影）
  在前缀未变时必须复用上一次结果，只处理增量尾部。非前缀变化（snapshot 回填、切 session）
  才允许整段重算，且此时不得按旧进度裁剪正文。
- **只在终态消费的派生不进流式帧。** 复制文本、代码注释卡、文件摘要这类只有回合结束
  或用户触发时才读取的结果，不得在 `isRunning` 期间逐帧计算。
- **向 live turn 子树提供的 context value 必须引用稳定。** context 变更会绕过下游所有 memo
  bailout，inline 对象字面量等于让整棵子树跟着流式帧重渲染。value 只在语义变化时换身份。

`renderStreaming` 进 `messageComponents` 的 memo 依赖是**有意为之**，不是污染：
它决定 `enableSyntaxHighlighting` 与 `renderMermaid`，流式期间关高亮、完成后开。
翻转瞬间的整条消息重解析是这项语义的已知代价；如果要消除它，只能把高亮开关
从 components 闭包移到 context，不能简单从依赖里删掉。

回归覆盖长历史下 thinking 和正文持续追加、最终文本一致、导航预览及分享开关。
性能证据必须记录加载行数、数据形状、构建、平台与消息节奏；React Scan 用于更新原因，
关闭 Scan 的同场景 profile 用于耗时比较。组件夹具不能代替完整应用链路证据。
