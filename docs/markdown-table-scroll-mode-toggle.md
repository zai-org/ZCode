# Markdown table scroll mode toggle

## 背景

Markdown 表格现在使用虚拟横向滚动条隐藏原生滚动条，并支持把表格滚动区域向左借位、向右延伸到 chat root 可用边界。增强滚动适合很宽的表格，但普通表格默认占用额外横向空间会改变阅读节奏。

## 目标

- 表格从最近的 `data-markdown-table-layout-root` 消息内容根节点计算可借用横向空间；旧 `chat-view` 选择器仅作为兼容路径。
- 每个 markdown 表格都有独立的横向滚动模式开关。
- 表格根容器显式设置 `my-0`，覆盖 Markdown 排版上下文可能注入的块级外边距。
- 默认关闭增强滚动，但仍保留虚拟滚动条。
- 关闭增强滚动时，滚动槽宽按 `data-markdown-table-frame` 宽度计算，不向左借位，不向右延伸。
- 开启增强滚动时，复用现有扩展逻辑：滚动槽宽为 `frameRect.width + rightDistance - rightInset`，允许向左借位，并把内容最大宽度补上左借位宽度。
- 长表格 sticky 滚动条规则保持不变：只有表格自身高度超过纵向可视区域 80% 时才吸底，并继续避让底部输入区/面板。
- V4 虚拟行通过 `transform` 定位，浏览器原生 `position: sticky` 无法相对 timeline 生效；长表格滚动条必须按 timeline 可视底边和实际 `data-v4-composer-dock` 高度计算纵向补偿，并将补偿限制在当前表格上下边界内。旧 ChatView 继续兼容 `--chat-bottom-dock-height`。
- `data-markdown-table-virtual-scroll-sticky` 是 sticky 模式的稳定语义合同；E2E 必须读取该状态并结合滚动后的几何位置验证吸底，不得用 `getComputedStyle().position` 判断，因为 V4 的实现刻意使用 `relative + translateY`。
- “短表不吸底、长表吸底”的对照必须在固定且足够高的窗口中执行，避免短表因测试窗口过矮也超过 `80%` 可视高度，使 case 实际验证了错误的前置条件；目标尺寸超过当前显示器工作区时，E2E 必须按工作区上限收敛，不能等待操作系统不会接受的窗口尺寸。
- 虚拟滚动条因横向 overflow 出现而切回可见时，必须重新绑定纵向 timeline 监听和几何观察；不能只依赖 sticky 模式状态。
- V4 composer dock 可能因输入框、附件或面板动态增高，sticky 补偿必须直接观察 dock 尺寸，并在 dock 节点条件挂载/替换时重新绑定观察。
- timeline 离底时出现的 `data-v4-back-to-bottom-anchor` 浮动按钮也属于底部避让区；sticky 补偿需额外扣除按钮高度和 `8px` 间距，按钮挂载/卸载必须触发重算。
- 同一轮几何测量中，虚拟滚动条的可见性必须只由稳定的浮点布局槽宽决定，不能改读条件挂载后的 DOM track 宽度。
- 横向 overflow 状态变化只能切换虚拟滚动条的可见性和交互状态，不得挂载/卸载节点或改变纵向占位，以免扰动 V4 timeline 的 `scrollHeight` / `scrollTop`、底部跟随状态或会话滚动记忆。
- V4 composer 渐隐遮罩必须挂在 timeline 全宽的消息遮罩层上；正文列宽、居中和横向 panel 偏移由 `data-v4-timeline-virtual-history` 与 live tail 各自承担。遮罩层不能复用正文列的 `max-width`，否则增强模式向两侧越出正文列的部分会被 CSS mask 裁剪。

## 交互

外层侧栏或窗口连续改变宽度时，表格和虚拟滚动条跟随当前布局，不对每个中间宽度叠加 200ms 追赶过渡。用户主动切换增强滚动模式时保留 200ms ease-out 尺寸过渡。两者使用同一几何与滚动位置 owner；动画不能影响复制、下载、预览、sticky 避让和横向滚动范围。

工具栏在“预览表格”按钮右侧增加模式按钮：

- 只有普通 frame 宽度下表格横向溢出，并且增强模式能提供额外可视宽度或左借位空间时显示。
- 关闭时按钮含义是展开表格滚动区域。
- 开启时按钮含义是收回到普通表格滚动区域。
- 模式只影响当前表格实例，不影响其他表格。
- 开启后按钮持续显示，方便用户收回；收回后如果当前尺寸下增强模式没有收益，按钮会隐藏。
- 虚拟横向滚动条节点始终挂载并保留固定纵向占位；没有横向 overflow 时只切换为不可见、不可交互，不能卸载节点。存在横向 overflow 时仍只在 hover 到当前 `data-markdown-table-frame` 后显示，避免常态阅读时占用视觉注意力。
- 点击展开或收回时，只有未发生向左借位的表格内容最大宽度变化会使用轻量过渡；一旦发生向左借位，内容层的位移与最大宽度都即时生效，避免表格向左滑动或补宽拉伸。虚拟滚动条槽宽度仍使用轻量过渡；系统开启 reduced motion 时取消过渡。

## 计算

V4 timeline 滚动视口必须标记 `data-markdown-table-layout-root="true"`。该标记只表达表格可扩展到的横向布局边界，不承担会话状态语义。根节点通过 `--markdown-table-layout-left-inset` / `--markdown-table-layout-right-inset` 提供响应式安全边距；存在 Conversation turn map 时左边距必须至少覆盖其 `48px` 占用宽度，右边距保持桌面 `16px`、手机 Web `8px`。表格不能把居中的消息内容列误当成扩展边界。

普通模式：

- `scrollbarWidth = frameRect.width`
- `viewportMaxWidth = frameRect.width`
- `maxViewportLeftOffset = 0`
- `viewportLeftOffset = 0`
- `virtualScrollLeft = realScrollLeft`
- `virtualScrollMax = tableWidth - scrollbarWidth`

精度不变量：

- `scrollbarWidth` 保留 `getBoundingClientRect()` 的子像素精度，并以同一数值写入 CSS 宽度和 `virtualScrollMax` 计算。
- 沿用现有 `virtualScrollMax > 1px` 的显示阈值；修复不扩大或缩小横向 overflow 的产品语义。
- DOM track 的实际宽度只参与 thumb 比例与视觉位置计算，不得反向决定 track 自身是否挂载。

增强模式：

- `scrollbarWidth = frameRect.width + rightDistance - rightInset`
- `viewportMaxWidth = scrollbarWidth`
- `maxViewportLeftOffset = max(0, frameRect.left - rootRect.left - leftInset)`
- `viewportLeftOffset = min(virtualScrollLeft, maxViewportLeftOffset)`
- `virtualScrollLeft = viewportLeftOffset + realScrollLeft`
- `virtualScrollMax = tableWidth - scrollbarWidth`
