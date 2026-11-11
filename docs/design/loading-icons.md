# 加载图标

界面中的 Lucide 加载图标统一从 `lucide-react` 导入 `LoaderCircle`，直接渲染和状态图标映射均使用这个名称，不再使用 `LoaderIcon`、`Loader2`、`Loader2Icon` 或 `LoaderCircleIcon`。

公共 `Spinner` 保留原有接口、`role="status"`、国际化加载文案和 className 合并方式，内部改用 `LoaderCircle`。调用方不需要更换组件。

本次只统一图形和导入名称。保留各处尺寸、描边、语义颜色、透明度、旋转动画、减少动态效果设置及显示条件。已有不旋转的状态图标保持原样。自定义工作中动画不属于 Lucide 加载图标，不在本次替换范围内。

桌面和手机 Web 使用同一图形；Zai Light / Zai Dark 沿用现有主题颜色。不得引入平台判断或新的加载状态。

## 验收

- 源码中不再引用上述旧名称；`Loader2` 原本就是圆环图标的别名，其替换不改变外观。
- 公共 `Spinner` 渲染 `.lucide-loader-circle`，保持可访问名称、尺寸和旋转。
- 复用 `packages/ui/test/browser/manual-review/pending/new-task-rendering.test.mjs` 的 SPT06，检查桌面/手机宽度和深浅主题中的侧栏 loading：运行时显示圆环并旋转，完成后消失。
- 相关测试使用 `.lucide-loader-circle` 选择器。浏览器夹具验证不等于真实手机传输或多操作系统整机验收。
