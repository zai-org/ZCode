# 设置页“在侧边栏中显示”未定位项目焦点

Status: done

## 当前合同（2026-11-11）

本项改按已确认的返回行为验收：退出设置并激活该设备已打开的任务工作区，
不要求侧栏展开、项目行滚动或自动聚焦。产品规格见[设备设置合同](../../architecture/remote-device-connection-ux-spec.md#菜单和收起)。
旧 DOM 定位查询已删除，保留现有退出设置和工作区激活流程。
以下记录是旧定位要求下的历史证据，不再作为当前用例的准入条件；
最新验收见[转正记录](../e2e-promotion/25-show-remote-project-in-sidebar-focus.md)。

## 历史复现

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 07。
批次 `r3-server-20261011125749338-152f05` 的 `settings-safeguards` 在 153.1 秒后失败。

真实 SSH 项目已连接。设置页设备卡“更多 → 在侧边栏中显示”返回主界面后，
持续 10 秒没有把焦点交给对应项目。测试已经使用当前的 `data-project-workspace-identity`
读取焦点所属项目；不是继续查找旧测试 selector 导致的失败。

`SettingsPage.tsx` 的 `onShowInSidebar` 仍查询 `[data-remote-project-identity]` 与
`dataset.remoteProjectIdentity`，然后对其中 `[role="button"]` 调用 focus。
当前 `ProjectNode.tsx` 输出的是 `data-project-workspace-identity`，项目标题是
`data-testid="virtual-project-toggle"` 的原生 button。原查询无法取得新项目行，后续滚动和聚焦不执行。

当时的设备设置合同要求此操作定位已有项目，不依赖设备在线状态。
该批次没有修改业务实现，保留了定位与焦点断言；后续移除确认步骤在此失败之后，尚未覆盖。

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011125749338-152f05-settings-safeguards/`。

## Comments

2026-10-17 转正回放 `r3-server-promotion-20261016-shape-current-remote-settings-safeguards` 再次复现。先修正前项窄屏截图留下的侧栏折叠态，真实 SSH、设备更名、连接配置和各设置分区作用域均通过；点击定位后返回主界面，10 秒内目标项目仍未获得焦点。失败录像确认侧栏已展开。当时的源码仍有上述旧 DOM 查询失配，业务实现未改；该批次保留了旧定位合同下的失败断言。

2026-10-20，staging `52cd1bc1d3` 的 `r3-server-pending-52cd-a-pending-settings-safeguards`
再次在定位焦点断言超时。第一条设置分区用例通过，第二条已完成真实 SSH、更名和作用域检查，
失败位于 `conversation-session-remote-settings-safeguards.test.ts` 的 `onShowInSidebar` 验收。
当时的 `SettingsPage.tsx` 仍查询旧的 `data-remote-project-identity`。该批次归类为既有业务缺陷，
没有修改该实现；移除设备确认等后续步骤当时未覆盖。
