# 设置「在侧边栏中显示」未定位项目

Status: done

## 2026-11-11：验收范围调整

当前确认的要求是退出设置页并回到原任务工作区，不要求侧栏自动展开、滚动或精确聚焦。
用例改验设置页退出和原远端工作区恢复，仍保留设备编辑、Scope、移除确认与断开检查。
产品规格已同步到[设备设置合同](../../architecture/remote-device-connection-ux-spec.md#菜单和收起)。
下方旧焦点行为的运行证据保留，不再作为本用例转正的阻塞项。

## 复现与运行时证据

`conversation-session-remote-settings-safeguards.test.ts` 在真实 SSH 连接后进入设备设置，
编辑设备信息，走完中英、深浅主题与窄窗口检查，然后点击「在侧边栏中显示」。
旧预期为返回主界面并聚焦对应远端项目；实际侧栏仍折叠，焦点落在 `body`，项目没有获得焦点。

2026-11-10 连续两次复现：`local-docker-20261110103911-959e83` 与
`local-docker-20261110104055-4e31e0`。第二次的 `failed-sidebar-focus.json`
记录旧 `[data-remote-project-identity]` 节点数量为 0，当前
`[data-project-workspace-identity]` 节点存在、身份匹配但未包含焦点。
`failed-sidebar-focus.png` 同时确认侧栏仍折叠。后续移除确认和断开检查尚未执行。

## 已确认的原因与修复范围

旧 `SettingsPage` 的 `onShowInSidebar` 查找已移除的 `data-remote-project-identity`，
而 `ProjectNode` 现在提供 `data-project-workspace-identity`。回调拿不到目标节点，
因此后续滚动和聚焦均未执行。返回工作区也未将窄窗口检查留下的折叠侧栏展开。

按当前合同删除无效 DOM 查询及其 `requestAnimationFrame` 回调，保留退出设置和工作区激活。
不再添加侧栏展开、滚动或焦点流程。此项不是 SSH 依赖缺失。

```text
旧流程：退出设置 → 激活工作区 → 下一帧查询旧项目 DOM → 无节点，未执行定位
现流程：退出设置 → 激活工作区（侧栏展开状态不参与该流程）
```

验收使用正式用例 `conversation-session/remote/configuration/conversation-session-remote-settings-safeguards.test.ts`，
验证设置页退出、原远端工作区可见可交互，并继续执行设备编辑、Scope、移除确认和断开检查。

## 2026-11-11 修订验证

删除旧定位回调并按当前源码重建后，严格隔离回放 `local-docker-20261111025816-4dcd49`
和默认回放 `local-docker-20261111030225-87d4b8` 均为 2/2 通过，无跳过、无重试。
覆盖返回工作区及后续移除确认、断开操作；中英文、深浅主题和窄桌面布局检查继续通过。
运行环境为 macOS Electron 连接独立 Linux SSH 容器，未新增 Windows/Linux 桌面实跑证据。
设备管理设置只在 Desktop 显示，Web 和手机端由 `isSettingsSectionAvailable` 排除。
