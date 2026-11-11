# V4 Chat Layout Parity

## 背景

v4 会话区已经恢复旧版 composer 外观，但消息列表与 composer 的父级布局仍和 z-code-2 不一致。z-code-2 的对话区把消息内容和底部输入区放在同一个滚动容器里：滚动条可以滚到包含输入框的最底部，消息主列与 composer 都使用同一套最大宽度。

当前 v4 的 `ConversationTimeline` 自己持有滚动容器，`ConversationComposer` 是 `SessionPane` 的兄弟节点。结果是滚动条只覆盖 timeline，composer 不属于同一个滚动上下文；同时 row 渲染没有统一的主内容最大宽度，宽屏下文本和工具输出会比旧版发散。

## 目标

- 会话态下，v4 消息区和 composer 使用同一个 vertical scroll viewport。
- composer 保持在该 viewport 内 `sticky bottom-0`，滚动到最底部时输入框底部也属于可达范围。
- composer 的底部 `16px` 留白由 timeline 根容器的 `padding-bottom` 承担，位于滚动视口之外；dock 内层不留底部 padding。消息不再渐隐，不能滚入底部留白。会话态沿用现有输入框背景；草稿态带 context header 的卡片仍使用 `bg-surface`。
- 消息内容、空消息提示、回到底部按钮和 composer 复用 `conversationLayout` 的统一主列布局；已绑定会话在 `conversation < 864px` 时使用 `w-full`，`864px <= conversation < 1280px` 时使用 `calc(100% - 96px)`、`max-w-4xl`，达到 `1280px` 后使用 `calc(100% - 384px)`、`max-w-6xl`；草稿使用 `max-w-2xl`。消息轮次使用 `px-4 @md/conversation:px-6` 响应 conversation 容器，composer dock 的水平留白为 `px-2`，底部留白由外层 timeline 提供。
- 保留 v4 虚拟滚动、row 测高缓存、底部跟随和 `loadOlder` 语义。
- 不改变草稿态居中布局，也不改变远控 replayable / desktop continuous 的数据链路。

## 布局链路

```text
SessionPane
  ConversationHeader
  body region
    ConversationStatusPanel
    shared scroll viewport
      virtual timeline content
        centered row column: conversationLayout
        unmasked virtual history + running live tail
      sticky bottom composer dock
        centered composer column: conversationLayout
    fixed bottom padding: 16px outside scroll viewport
  QueuePanel
  runtime/dialog controllers
```

## 实现约束

- `ConversationTimeline` 继续拥有虚拟列表与滚动锚定逻辑，但新增 `bottomDock` 插槽，把 composer 渲染进 timeline scroll viewport 的尾部。
- 普通会话把现有底部留白从 dock 内层移到 timeline 根容器；不增加背景子节点，不测量输入框高度来定位留白。Markdown 表格浮动滚动条仍按输入区实际几何避让。
- virtual history、running live tail 与 header slot 均不使用 mask；快速滚动时上下边界由固定的 overflow 视口裁剪，不通过 scroll 回调补偿边界位置。底部外层 padding 不应用于居中草稿、浮窗或无 bottomDock 的只读时间线。
- `SessionPane` 会话态不再在 timeline 之外渲染 composer；草稿态仍由居中容器渲染 composer。
- `ConversationTimeline` 的滚动 ref 仍是唯一 scroll element，`useVirtualizer.getScrollElement` 不变，避免多 pane 的滚动状态串扰。
- row 的外层绝对定位仍保持 `w-full`，其内部新增居中内容列，避免改变 virtualizer 的测高方式。
- `ConversationComposer` 会话态去掉自身横向 padding，宽度由外层 dock 控制；草稿态和 context header 卡片语义不变。

## 验收

- SSR 结构测试能看到会话态 composer 被渲染在 timeline scroll viewport 内，并带有共享 dock 标识。
- SSR 结构测试能看到 timeline row 内容列和 bottom dock 都使用同一组 `conversationLayout` 布局类。
- `pnpm vitest run packages/ui/test/v4SessionPaneLayoutParity.test.ts` 通过。
- `pnpm typecheck` 和 `pnpm lint` 通过，若环境中存在无关失败，提交说明必须列出。
