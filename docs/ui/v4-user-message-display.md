# V4 User Message Display

V4 conversation 的 `userInput` row 继续以权威 `text` 和 attachments 为数据源，只读气泡负责恢复旧版 `UserMessage` 的展示语义。展示状态属于 renderer 本地 UI，不写入 conversation snapshot，也不改变 desktop continuous 或 mobile replayable 链路。

## 正文与结构化引用

- mention markdown 在只读正文中还原为 skill、session、file/directory、subagent 和 command 标签；内部路径或 session target 不直接展示。
- 发送入口已确认的 goal 控制 query 在只读正文中把开头 `/goal` / `/target` 渲染为带
  Goal 图标但不带 `/` 的 `goal` / `target` 标签；退化为普通 prompt 的同名文本保持原样。
- 复制与编辑（composer 编辑态）始终使用原始 `userInput.text`，不能复制或回填已经扁平化的展示文本。
- attachments、Web element context 和 conversation selection chip 位于正文折叠区域之外，正文收起时仍保持完整可见。

## 长正文折叠

- 用户正文默认最大可见高度为 `120px`；实际内容未溢出时不显示遮罩和控制按钮。
- `scrollHeight > 121px` 时进入可展开态。收起态使用底部渐隐 mask，并在气泡底部居中显示展开按钮。
- 展开后正文高度过渡到测得的完整 `scrollHeight`，按钮切换为收起；再次点击恢复 `120px`。
- 高度过渡为 `300ms`，同时遵守 `prefers-reduced-motion`。
- 正文文本变化时重置为收起态并重新测量，避免虚拟时间线复用 row 后沿用上一条消息的展开状态。
- 使用 `ResizeObserver` 覆盖窗口宽度、字体和 mention/file icon 布局变化；测量通过 `requestAnimationFrame` 合并，卸载时必须清理 observer 和 RAF。
- 桌面端与手机 Web 远控使用同一折叠语义。触屏端按钮常规可点，不依赖 hover。
