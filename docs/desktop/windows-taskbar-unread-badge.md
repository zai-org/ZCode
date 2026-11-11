# Windows 任务栏未读角标（taskbar overlay badge）

## 背景

任务完成时桌面端有声音提醒，但用户在听歌或专注别的事情时容易错过。需要在任务栏的应用图标上显示数字角标（类似 macOS Dock 角标），让"有几个已完成的会话没看"一眼可见。

应用级未读角标链路早已存在（renderer 统计 → IPC → 主进程聚合 → `app.setBadgeCount`），macOS / Linux 已生效；Windows 因 Electron `app.setBadgeCount` 在该平台是 no-op，一期刻意保持 no-op（见 `unreadBadge.ts` 原注释与用例）。本文是二期的 Windows 补齐 spec。

## 角标语义

- 角标数字 = **本次 app 运行期间新完成、且用户尚未打开查看的任务数**。启动时已存在的未读不点亮——与 2026-10-30 托盘红点移除同理：角标只报「新事」，用户每次开机不应看到清不掉的旧角标（2026-11-05 产品决策）。
- 数据与侧栏蓝点**同源**（host `projectService.readTree()` 的权威树，且只统计侧栏实际渲染的项目，排除孤儿与软删——它们没有蓝点落点，计入只会产生「有角标没蓝点」的幽灵提醒），但计数语义与蓝点**分叉**：蓝点 = 全部未读，角标 = 本次运行新增的未读。启动时有历史未读属正常形态（蓝点亮、角标 0），不是 bug。
- **分界机制**（`mergeBaselineForHosts` / `countUnreadTasksSinceBaseline`，project-sidebar/view.ts）：基线是 **per-host** 的 Map——host 第一次出现在读取层返回的成功集合（`onlineHostIds`，由 `readProjectSidebarTree` → `mergeProjectTrees` 显式透传，含返回空树的 host）时，快照该 host 的「未读任务 key → unreadAt」进进程内存（模块级，锚定 renderer 进程生命周期，不落盘、不回写，app 重启即清零；Provider 重挂不重置）。此后计数 = 权威树未读中「key 不在该 host 基线里」或「unreadAt 与基线值不同」的任务数——同一任务再次完成会刷新 unreadAt，重新点亮。分界用任务身份（去重 key），不用时间比较：远端 workspace 的 `unreadAt` 由远端时钟写入，与本地「启动时刻」比较会被时钟偏差打穿；身份比较全程同源（同一棵树的两次读取），无外部变量。
- **成功信号必须由读取层显式传递，不能从树推断**：`mergeProjectTrees` 在远端读取失败时仍会用缓存行合成项目（供侧栏展示），「项目在树里」证明不了读取成功；反向地，靠「有任务进树」推断成功也不完整——空树 host（读取成功但暂无任务）没有任务，它运行期间的第一个新未读进树时会因「host 无基线」先被计数跳过、再被首次基线吸收，新事被吞、角标恒 0。所以 `onlineHostIds` 在读取边界显式产出：local 恒成功，远端以 `readTree` fulfilled 为准（空树也算），再按入口成员资格收敛。基线快照遍历全部任务而非展示选择器——后者排除已归档任务，而恢复归档只改 `archived` 不动 `unreadAt`，归档未读若不进基线，恢复那一刻会被误判为新完成点亮角标。
- **为什么按 host 而不是全局一次快照**：目录树按 host 逐步补齐——远端 Source Server 的连接晚于首读完成（离线时它的缓存项目行进树但读取不成功）、首读整体失败（树还是 EMPTY）、远端失败只兜底本地树。全局一次快照在这些场景下不完整，迟到 host 的历史未读会被误判为「本次运行新增」而点亮，恰好复现本语义要消除的「开机看到清不掉的旧角标」。per-host 基线下，迟到的 host 读取成功那一帧其历史未读整体不计（host 无基线），基线建立时被吸收；host 已在线时离线再上线同理不误报，期间远端真正新完成的任务（unreadAt 变化/新 key）照常点亮。
- 用户打开任务后数字减一，归零后角标消失。不是历史完成总量。
- 历史教训：一期计数读 renderer session store 的 `workspace.taskListCache`，但该缓存只装载活跃 workspace 的列表——背景工作区蓝点亮着、角标却是 0。已废弃该路径（`lib/unreadTaskCount.ts` 删除），同步点移到 `ProjectSidebar`（权威树在 `ProjectDirectoryProvider` context 里，Root 拿不到）。

## 全平台统一链路

```
[Host] projectService.readTree() → ProjectTree.tasks[].unreadAt（tasks-index SQLite 权威）
    │  ProjectDirectoryProvider（常驻 owner，权威树在此 context）
    │  host 首次进树：mergeBaselineForHostsInTree(tree)  ← per-host 基线（进程内存）
    │  countUnreadTasksSinceBaseline(tree, baseline)        project-sidebar/view.ts
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
- **清零**：`count = 0` 时任务栏传 `null` image 移除角标。基线随进程销毁：app 重启后旧未读不再点亮（见「角标语义」）。
- **性能**：角标只在"任务完成 / 用户查看任务"时变化，更新频率为事件级；徽章图按 label 缓存在内存，单次更新是一次查表 + 一次 Shell 调用。
- **无障碍**：overlay `description` 传静态英文描述（主进程无 i18n 管线，v1 不做本地化）。

## 平台矩阵

| 平台                  | 机制                                       | 状态                                     |
| --------------------- | ------------------------------------------ | ---------------------------------------- |
| macOS                 | `app.setBadgeCount`（Dock 红色数字）       | 已上线；计数同新语义（本次运行新增未读） |
| Linux（Unity/KDE 等） | `app.setBadgeCount`（LauncherEntry D-Bus） | 已上线；计数同新语义（本次运行新增未读） |
| Linux（原生 GNOME）   | 系统无 badge API                           | 无角标                                   |
| Windows               | `BrowserWindow.setOverlayIcon`             | 本文新增；计数同新语义                   |

## 测试与验证

- 单测：App 业务单测已退役（见 docs/testing/unit-test-quality.md），本链路无工程单测；主进程纯函数（label 解析、win32 分支清零传 null）的历史用例已随之移除，行为以手工验收覆盖。
- 手工验收（Windows）：完成任务 → 任务栏图标右下角出现角标并计数，托盘图标始终不挂红点；打开任务 → 递减；全部读完 → 消失；多窗口显示同一总数。基线语义：带着历史未读启动 → 角标为 0（蓝点可亮）；本次运行新任务完成 → 点亮；基线内任务再次完成（unreadAt 刷新）→ 重新点亮；重启 app → 角标归零。host 补齐场景：有历史未读的远端工作区在启动后延迟上线 → 角标仍为 0（蓝点可亮）；模拟首读失败后恢复 → 角标仍为 0；本次运行中远端任务完成 → 角标 +1。
- E2E：任务栏 overlay 为 OS Shell 渲染，WebDriverIO 无法断言，以单测 + 手工验收覆盖（验收记录见 MR 描述）。

## 边界与已知限制

- 窗口最小化到任务栏时 overlay 仍可见（本需求场景）；若未来支持"关闭到托盘"，隐藏后 overlay 不可见，需另行在托盘图标上提示。
- 移动 Web 远控端无任务栏概念，不适用；桌面端角标统计包含远控 workspace 的未读任务（同一 renderer store）。
