# Desktop help menu（右上角问号菜单）

## 背景

Windows/Linux 桌面端曾在右上角自绘标题栏放一个箭头合并菜单，承担窗口级和帮助类入口，与工作区 header 的问号菜单并存时右上角入口重复。2026-09 起（`ab48cad0bd` 等）Windows/Linux 的设置页、任务页与草稿态统一改回共享的问号帮助菜单 `WorkspaceHelpMenuButton`，箭头菜单 `WindowsCaptionMenuButton` 不再挂载。

这带来一个缺口：原箭头菜单里的「资源管理器」只剩 macOS 原生 Help 菜单一条路径，Windows/Linux 没有原生菜单栏，因此完全没有入口。

## 产品语义

- 桌面端三个平台与 Web 端右上角都只显示问号帮助菜单，问号按钮的挂载位置由 `WorkspaceHeaderActionSection` / `SettingsPage` 控制。
- 第一组：产品文档、用户社群、问题上报、给产品提需求。
- 一条分隔线后为桌面专属组：导出日志、资源管理器、检查更新、关于 ZCode。检查更新仅 production 显示，Preview 隐藏；关于为最后一项。沿用原有命令；下载完成时显示「重启更新」/「Restart to update」和独立版本 pill。
- 导出日志复用系统菜单的主进程导出实现，UI 通过共享帮助动作显示导出中及失败提示；问题上报仍保持 `includeLogs=true`。Web 无桌面组和分隔线。

## 实现约束

- 问题反馈、产品文档、导出日志复用 `createHelpMenuActionHandlers`，不新增 desktop command。
- 平台判定不在 `WorkspaceHelpMenuButton` 内嗅探 `window` 或 UA，而由挂载处注入 `isDesktop`（`WorkspaceHeaderActionSection` 与 `SettingsPage` 已持有该值），保证 Web 端不被误伤。Web 的 `IPlatformService` 桩虽然也实现了 `executeDesktopCommand`（no-op），所以不能拿它当桌面判定。
- test id：触发按钮 `TID_WORKSPACE_HELP_MENU_TRIGGER`，资源管理器项 `TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER`。

## 测试

- 单测：`packages/ui/test/workspaceHelpMenuButton.test.ts`——`isDesktop` 为真时渲染资源管理器项并调用 `OpenResourceManager`，为假时不渲染。
- E2E：`packages/desktop/test/e2e/resource-manager/processes/resource-manager.test.ts`——从问号菜单打开资源管理器窗口。

- 关于入口正式 E2E：`packages/desktop/test/e2e/feedback/help/help-menu-about.test.ts`——真实点击问号菜单，验证关于窗口可见且包含应用名称和版本；检查更新项按产品身份显示，production 下验证点击转发既有 IPC 命令，不下载或安装。无需模型请求；已由用户确认转正，加入默认 desktop E2E 收集。

### 未推送改动的 E2E 补充

| 场景 | 验收 |
| --- | --- |
| 英文草稿态、中文设置页 | 关于菜单文案及顺序正确，真实点击打开带版本的关于窗口 |
| 英文草稿态、中文设置页导出日志 | 桌面组首项为导出日志，真实点击后生成 ZIP、请求系统定位并结束导出提示；复用原有导出实现 |
| production 初始状态 | 显示检查更新，真实点击经现有命令收到开发包 `dev-skipped` 回执 |
| production 状态事件 | checking 禁用；可用版本、下载进度显示对应文案；下载完成分别断言动作文案和版本 pill（不依赖括号及子节点空白拼接）；关闭重开后版本 pill 保持最新状态 |
| Preview | 草稿态和设置页都无更新项，注入更新事件也不出现 |

状态事件使用 case 内合成 `UpdateStatePayload`，只验证 main→preload→菜单展示，不修改真实 updater，也不下载或安装。测试不再依赖 Node 侧 `ZCODE_PRODUCT_FLAVOR`（未编译 define 时固定回退为 preview）；默认期望 Preview；production 必须显式传入期望身份，并对真实菜单断言。

```bash
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=0 ZCODE_E2E_HELP_MENU_FLAVOR=production pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/feedback/help/help-menu-about.test.ts
ZCODE_ENV=test ZCODE_PREVIEW_IDENTITY=1 ZCODE_E2E_HELP_MENU_FLAVOR=preview pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/feedback/help/help-menu-about.test.ts
```

两次身份切换必须重新构建；不设置 skip build。手机 Web 的入口隐藏仍由现有组件单测覆盖，本轮不声称新增手机浏览器 E2E。

2026-09-16 macOS arm64 验证：production / Preview 各 4/4 通过。production 完整构建后因宿主中断及测试定位修正，最终使用同一产物重跑；Preview 切换身份后重新构建 App，复用未改动的 Agent 产物。

- production：`packages/desktop/.e2e-artifacts/desktop-e2e-20260916015817140-p11108-40c450981f4adf75/summary.json`
- Preview：`packages/desktop/.e2e-artifacts/desktop-e2e-20260916015910292-p13512-0267b1fc0528ad0b/summary.json`
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 保留 43 条既有警告、0 错误。
- 未验证 Windows/Linux 实机、手机浏览器及正式安装包下载/安装；用例已转正；Docker suite 准入不在本次范围。

转正验证（2026-09-16）：正式路径不设置 manual-review 或期望身份参数，默认 Preview 4/4 通过；复用上轮已验证的 Preview App/Agent 构建。制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20260916020532683-p21897-d5394bfcb8f7a780/summary.json`。production 的显式分支未改变，沿用上述 4/4 证据。
