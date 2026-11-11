# Task List Context Menu

任务列表项新增右键菜单，统一承接 task 级快捷操作，避免把所有动作都堆到 hover 按钮或 Header more。

## 当前菜单项

- Pin task
- Rename task
- Archive task
- Mark as unread
- Open in Finder / File Explorer / File Manager
- Copy path
- Copy log path
- Go to config

## 交互说明

- `Pin task` 会持久化到 task 元数据，刷新或恢复后仍保持置顶；已置顶项菜单会显示 `Unpin task`
- 已置顶任务会常驻在列表顶部的独立 `Pinned` 分组里，不再和普通任务混排；折叠态下也始终可见
- `Rename task` 使用弹窗完成，支持 `Enter` 提交、取消关闭
- 重命名有两个等价入口：任务行右键菜单，或在任务行上双击（桌面鼠标）。两者打开同一个重命名弹窗，并预填当前标题；双击不新增另一套标题状态
- 双击的第一次点击仍按原行为立即打开任务；第二次点击不再重复打开，避免重复导航或重复建立远端连接。行内按钮、交互胶囊、工作流运行行和归档二次确认态不触发双击重命名
- 「按未读」视图不启用双击重命名：第一次点击会清除未读并移除该行，第二次点击没有可命中的目标；该视图继续使用右键菜单
- 触摸设备（`hover: none`）不启用双击重命名，保留一次点击打开和长按菜单
- 只读工作区（目录不存在或不可访问）不打开重命名弹窗，判据与右键菜单的禁用一致
- `Archive task` 会把任务标记为 archived，并从默认任务列表中隐藏
- 归档只在左侧侧栏提供（行内归档按钮、grouped 行的关闭按钮、两套右键菜单）；Header 更多菜单不展示归档。任务运行中（侧栏转圈的同一判据：sessions-index phase 为 `prewarming` / `running`）时这些入口禁用，提示「任务运行中，请先停止后再归档」。原因：归档只写 task index、不停止 agent turn，运行中归档后 agent 仍会以该任务 sessionId 新建 Browser tab，而任务已离开列表，没有 scope 能显示或关闭这个 tab。Header 的 task meta 来自 tasks-index，没有实时 phase，残留的 `status=running` 会误禁用，所以不在 Header 提供归档。
- 任务行 hover 时展示行内归档入口；首次点击进入二次确认态。确认态是显式等待用户决策的状态，鼠标移出任务行后仍保持确认按钮可见；点击任务行外空白处或按 `Esc` 取消确认态。
- `Mark as unread` 会持久化到 task 元数据；重新启动 app 后仍保留蓝点，打开该任务时再自动清除
- 重命名会持久化到 `tasks-index.sqlite` 并同步更新运行中 task 的内存 meta；恢复和快照回写必须遵守 [Task Title Authority](./task-title-authority.md)，避免 raw session snapshot 把手动标题还原成自动标题
- pin / unread / archive 也会同步更新运行中 task 的内存 meta，避免后续 session 持久化把旧状态写回来
- `Copy path` 指向 task 的持久化快照文件路径
- `Copy log path` 指向 task 对应的原生日志路径；ZCode Agent 使用按日期滚动的结构化 JSONL 日志
- `Go to config` 会复用当前持久化的编辑器偏好；如果无法直接用编辑器打开，则回退到文件管理器
