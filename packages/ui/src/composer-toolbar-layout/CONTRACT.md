# Composer 工具栏布局

登记现有 `useComposerToolbarFit` 和 `fitComposerToolbar` 的布局职责，保留原入口和实现。

- 只读取工具栏 DOM 尺寸、更新紧凑显示属性；不持有模型选择、权限或会话状态。
- React hook 统一管理尺寸及内容观察器，并在卸载时清理；测量副本不改变实际控件交互。
- 普通入口与合并模型入口沿用各自已有的收缩顺序；桌面与窄屏共用同一布局函数。
- 收缩档位按 `data-composer-collapse-priority` 依次为 `extension`、`0`、`1`、`2`、`3`：扩展插槽 `composer.status`（`extension`）最先收起为只留图标，之后依次是 Computer、mode、Plan、think 文字（docs/plugins/extension-host.md §6）。
- `iconOnly`（单行输入框，Side Pane 完整视图浮窗）：工具栏宽度随内容变化，没有可测的可用宽度；不测量、不克隆，按同一收缩顺序直接收到最后一级。关闭后回到正常测量并按实际宽度恢复。
- 原布局与契约单测已退役。公开布局入口和各档位需由浏览器或桌面验收覆盖，不能沿用旧单测作为现行证据。
