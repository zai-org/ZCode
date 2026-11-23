# Settings Search Input

设置页的 Skills、Hooks、Commands、MCP、Subagents 与插件市场搜索框统一复用
`SettingsSearchInput`：

- `Input size="lg"`
- 高度 `h-9`
- 圆角 `rounded-xl`
- 左侧搜索图标 `size-4`
- 输入内容左侧留白 `pl-9`
- 颜色、边框、Hover 与 Focus 状态继承标准 `Input`

页面只能通过容器 class 控制宽度和布局，不得覆盖上述几何样式。

Skills 与 Subagents 搜索框右侧的状态筛选器使用同样的 `h-9 rounded-xl`，保持同行控件
轮廓一致。

## 全局设置搜索入口

侧栏的“搜索设置”是打开搜索弹窗的按钮，不是上述页面内搜索输入框。其高度和圆角与
“返回工作区”按钮一致：`Button size="lg"`、`rounded-xl`，展开时高度 32px；窄屏图标模式
统一使用 `max-lg:size-10`（40px）。展开时两者均使用 `px-1.5`（6px）水平内边距、
`size-4` 图标和 `gap-2` 图文间距，使图标与文案起始位置一致。保留原有边框、颜色和
打开搜索弹窗行为。
