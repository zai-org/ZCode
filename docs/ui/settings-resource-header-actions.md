# Settings resource header actions

Memory、Subagents、Plugins、MCPs、Skills、Commands 与 Hooks 的列表分组右上角统一展示以下操作：

```text
[ … ]     [↻]      [New]
 outline   outline   default
  ├─ Import
  └─ Export
```

- Refresh 固定为带 Tooltip 和可访问名称的 `size="icon-md"` 图标按钮。
- Import、Export 收进 `size="icon-md"` 的更多操作菜单。
- 没有实现（未传回调）的操作不渲染；Import、Export 都未实现时不渲染更多操作按钮。
- 已实现但受当前 Scope 或环境限制的操作通过 `*Disabled` 属性显示 disabled。
- New 固定使用 `size="default"`、`rounded-lg`，顺序不可调整。
- 已有能力继续调用各资源自己的 service/store，不共享数据提交逻辑。
- 尚未实现的能力必须隐藏；禁止绑定空 `onClick`。
- 后续实现只需向共享按钮组传入对应回调即可启用。
- 空状态中的大尺寸引导按钮不属于本规范，可继续按资源语义展示。
- Desktop、Web 与手机宽度使用同一按钮顺序；容器允许换行。
- Subagents 列表的只读刷新（手动 Refresh、保存后的列表投影刷新、插件资源初始化完成后的后台刷新）只让 Refresh 按钮显示刷新中，不禁用各行控件；行控件只在该行自身的保存、启停或删除进行中禁用。这样后台刷新不会关闭用户正在打开的模型或档位菜单。

## 当前能力矩阵

| 资源      | Refresh          | Import | Export | New    |
| --------- | ---------------- | ------ | ------ | ------ |
| Memory    | 已实现           | 占位   | 占位   | 占位   |
| Subagents | 已有刷新数据入口 | 占位   | 占位   | 已实现 |
| Plugins   | 已有重新加载入口 | 占位   | 占位   | 已实现 |
| MCPs      | 已实现           | 已实现 | 占位   | 已实现 |
| Skills    | 已有刷新数据入口 | 已实现 | 占位   | 已实现 |
| Commands  | 已有刷新数据入口 | 已实现 | 占位   | 已实现 |
| Hooks     | 已有重新加载入口 | 占位   | 占位   | 已实现 |
