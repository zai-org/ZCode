# 02 — 插件商店已打开时，从设置页再点「浏览插件」会回到对话

Status: needs-triage

## 现象

`plugins/marketplace/plugin-localization-creator.test.ts` 第二个 case：上一个 case 结束时主视图是插件商店。打开设置 → 插件 → 「浏览插件」（`plugin-store-browse` 点击成功）后，30 s 内 `plugin-store-root` 一直不存在。

## 静态分析（未经运行时日志确认）

- 设置页的 `onOpenPluginStore`（`packages/ui/src/SettingsPage.tsx:2100-2103`）先 `requestPluginStoreOpen` 再 `onBack()`。
- `packages/ui/src/App.tsx:992-1000` 的 `handleOpenPluginStoreForScope` 在主视图已是 `plugin-store` 时只递增 `pluginStoreOpenVersion`，不调用 `preserveNextSettingsExit()`（只有 `handleNavigateToPluginStoreMain`，`:935-939`，会调用）。
- `useWorkspaceMainViewSettingsExit` 看到退出设置时主视图等于进入设置前的主视图，于是 `onExitSettings` 回到对话，商店被关闭。

## 处理方向（未定）

在「已是 plugin-store」分支同样标记显式导航（或统一用一个「显式导航到商店」标记）。修改前先在 mac 上加 UI 日志复现，确认走的是这条路径。

## 来源

mac conversation job `ci-conversation-341152-1138993`（ff3ecc47）的失败分诊。
