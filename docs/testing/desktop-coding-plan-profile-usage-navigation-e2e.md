# Desktop Profile Usage Navigation E2E

## Scope

头像菜单里的 `使用统计` 入口是设置页导航入口，必须覆盖两个页面上下文：

- 工作区 sidebar footer 头像菜单。
- 设置页 sidebar footer 头像菜单。

这组 case 只验证导航语义，不验证 Coding Plan 权益、额度或 Team Plan 数据。用量数据类断言继续留在 Team Plan / Coding Plan 专用 E2E 中。

## Cases

| Case | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| ECR-usage-01 | 桌面默认 workspace 已打开 | 点击 workspace 头像菜单里的 `使用统计` | 打开设置页，并选中 `usage` 分区 |
| ECR-usage-02 | 桌面默认 workspace 已打开；当前已在设置页 `general` 分区 | 点击 settings 头像菜单里的 `使用统计` | 仍停留设置页，并切换到 `usage` 分区，不返回 workspace |

## Test Placement

这两条 case 放在 `packages/desktop/test/e2e/infrastructure/smoke/e2ecase-regression.test.ts`，使用默认 workspace 前置。测试通过共享 test id 点击当前可见头像菜单和 `使用统计` 菜单项，避免 settings 页面保留的隐藏 workspace DOM 影响断言。
