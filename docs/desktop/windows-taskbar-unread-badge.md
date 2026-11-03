# Windows 任务栏未读角标（taskbar overlay badge）

## 背景

任务完成时桌面端有声音提醒，但用户在听歌或专注别的事情时容易错过。需要在任务栏的应用图标上显示数字角标（类似 macOS Dock 角标），让"有几个已完成的会话没看"一眼可见。

应用级未读角标链路早已存在（renderer 统计 → IPC → 主进程聚合 → `app.setBadgeCount`），macOS / Linux 已生效；Windows 因 Electron `app.setBadgeCount` 在该平台是 no-op，一期刻意保持 no-op（见 `unreadBadge.ts` 原注释与用例）。本文是二期的 Windows 补齐 spec。

## 角标语义

- 角标数字 = **已完成但用户尚未打开查看的任务数**（"未读任务"）。与侧栏蓝点**同一份权威数据**：host `projectService.readTree()` 返回的 ProjectTree（tasks-index SQLite 的 `unread_at`），且只统计**侧栏实际渲染的项目**：排除软删项目的任务与孤儿任务（projectId 无对应项目）——它们没有蓝点落点，计入只会产生「有角标没蓝点」的幽灵提醒。过滤与去重见 `countProjectTreeUnreadTasks`（project-sidebar/view.ts）。
- 用户打开任务后数字减一，归零后角标消失。不是历史完成总量。
- 历史教训：一期计数读 renderer session store 的 `workspace.taskListCache`，但该缓存只装载活跃 workspace 的列表——背景工作区蓝点亮着、角标却是 0。已废弃该路径（`lib/unreadTaskCount.ts` 删除），同步点移到 `ProjectSidebar`（权威树在 `ProjectDirectoryProvider` context 里，Root 拿不到）。

## 全平台统一链路

```
[Host] projectService.readTree() → ProjectTree.tasks[].unreadAt（tasks-index SQLite 权威）
    │  ProjectSidebar（权威树在 ProjectDirectoryProvider context）
    │  countProjectTreeUnreadTasks(tree)                   project-sidebar/view.ts
    ▼
usePlatform().syncWindowUnreadCount(count)                 IPC: zcode:sync-window-unread-count
    │  （web 端为 no-op；树刷新时才触发，计数不变不发包）
    ▼
[Main] desktopMainIpcPlatform.ts → handleWindowUnreadCountSync
    │  windowUnreadCountMap（每窗口计数；窗口关闭时清理）
    ▼
syncApplicationUnreadBadge(map)                     desktopWindowLifecycle.ts
    │
    ├─ darwin / linux → app.setBadgeCount(total)            （既有行为）
    └─ win32         → 对每个 BrowserWindow 调 setOverlayIcon（本文新增）
```

统计与同步链路三平台共用；只在主进程"最后一公里"按平台分叉。

## Windows 实现

Electron 在 Windows 通过 `BrowserWindow.setOverlayIcon(image, description)` 支持任务栏角标（Shell `ITaskbarList3::SetOverlayIcon`）。与 `setBadgeCount` 不同，**overlay 不负责渲染数字**，必须自绘徽章图。

- **位置**：overlay 由系统固定绘制在任务栏按钮右下角（与 Windows 更新盾牌、Outlook 同步状态同一机制），API 无位置参数，无法绘制右上角效果。
- **观感**：任务栏 overlay 按 Windows 固定显示尺寸提供原生 1x（16×16）与 2x（32×32）`NativeImage` representation，不再把普通 32px 硬边圆交给 Shell 盲缩。红点为纯红、无描边、4× 超采样抗锯齿，逻辑直径约 7px。同一个安装包运行时按系统 build 自动选画布圆心：Win10（build < 22000）在画布内右下锚定，补偿旧任务栏的 overlay 落点；Win11（build ≥ 22000）在画布内居中，避免 Shell 已放到图标角上后再次右下锚定造成二次偏移。无障碍 description 仍携带具体数量（如 "3 unread tasks"）。
- **托盘不挂角标**：Windows/Linux 托盘（`Tray`，屏幕右下角通知区域）保持原始图标，不合成未读红点。2026-10-30 起移除：托盘红点在用户眼里像"常驻不消"，与通知区域"有红点 = 有新消息"的惯例冲突；未读提醒由任务栏 overlay 与应用内任务列表蓝点承担。
- **多窗口**：所有窗口统一显示全局未读总数（与 macOS Dock 显示应用级总数一致，符合"完成了几个会话就显示几"的直觉）。无任务栏按钮的窗口（CUA 指示器、更新状态窗等 skipTaskbar 窗口）设置 overlay 无副作用，不单独排除。
- **清零**：`count = 0` 时任务栏传 `null` image 移除角标。
- **性能**：角标只在"任务完成 / 用户查看任务"时变化，更新频率为事件级；徽章图按 label 缓存在内存，单次更新是一次查表 + 一次 Shell 调用。
- **无障碍**：overlay `description` 传静态英文描述（主进程无 i18n 管线，v1 不做本地化）。

## 平台矩阵

| 平台                  | 机制                                                 | 状态                       |
| --------------------- | ---------------------------------------------------- | -------------------------- |
| macOS                 | `app.setBadgeCount`（Dock 红色数字）                 | 已上线，不变               |
| Linux（Unity/KDE 等） | `app.setBadgeCount`（LauncherEntry D-Bus）             | 已上线，不变               |
| Linux（原生 GNOME）   | 系统无 badge API                                     | 无角标                     |
| Windows               | `BrowserWindow.setOverlayIcon`                       | 本文新增                   |

## 测试与验证

- 单测：label 解析（0/1~9/10+）、像素渲染尺寸/边距与关键像素颜色（含红点模式无数字）、win32 分支对 `setOverlayIcon` 的调用（含清零传 null、多窗口、跳过已销毁窗口）、darwin/linux 分支仍走 `setBadgeCount`。
- 手工验收（Windows）：完成任务 → 任务栏图标右下角出现角标并计数，托盘图标始终不挂红点；打开任务 → 递减；全部读完 → 消失；多窗口显示同一总数。
- E2E：任务栏 overlay 为 OS Shell 渲染，WebDriverIO 无法断言，以单测 + 手工验收覆盖（验收记录见 MR 描述）。

## 边界与已知限制

- 窗口最小化到任务栏时 overlay 仍可见（本需求场景）；若未来支持"关闭到托盘"，隐藏后 overlay 不可见，需另行在托盘图标上提示。
- 移动 Web 远控端无任务栏概念，不适用；桌面端角标统计包含远控 workspace 的未读任务（同一 renderer store）。
