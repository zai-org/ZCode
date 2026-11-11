# data-sync

设置 → 数据与统计 → 数据同步页及其同步弹窗（`docs/remote/data-sync.md`）。只在桌面端显示。

- source = 本机 base services；target = 设备的 source-settings attachment（`useSourceSettingsServices`），不打开 workspace tab，不新建 Host、连接或 Agent。
- `domain/compare.ts`：比较纯函数（哈希请求、行状态、排序、三态、分批、设备结果汇总）。分批时子技能跟随最上层的已选上级（`parentKey` 链）放进同一批、上级在前。
- `app/categories.ts`：分类适配器注册表。新增分类 = 服务实现 `IDataSyncCategoryService` + 在 `DATA_SYNC_CATEGORIES` 注册 + 文案 `remoteSync.category.<id>`。
- `app/useDataSyncDialog.ts`：弹窗状态唯一 owner（选择、加载、推送、generation）。
- 模型提供商（只读，不是 `IDataSyncCategoryService`）：`domain/providers.ts`（Personal Layer 提供商行、API Key 掩码、状态展示态）+ `app/useDataSyncProviders.ts`（本机 `providerSettingsService.getView()` 与 `providerProvisioningStatusService` 的 lane 状态 / 重试）+ `ui/DataSyncProvidersPanel.tsx`。不参与勾选与「推送全部」；最近结果的唯一数据源是 Main 协调器的 lane。
- `domain/marketplacePlugins.ts` + `app/marketplacePluginSync.ts`：marketplace 插件把插件管理服务的 add / install 编排成 `IDataSyncCategoryService` 形状（export 在来源端、import 在目标端），与 inline 插件组合为「插件」分类。两端都以各自 Host 的 home（`systemService.info`）+ `configScope: "user"` 读取 User scope。

- `ui/DataSyncEntry.tsx` + `domain/entry.ts`：旧同步入口（连接向导、Header、侧栏项目菜单、技能 / MCP / 插件设置页）统一打开弹窗。`resolveDataSyncEntrySourceServerId` 从 tab 的 workspace identity 解析设备（SSH / WSL / Docker；旧格式返回 null），`useDataSyncDeviceOnline` 取管理快照的在线状态，`useDataSyncEntry().open({ sourceServerId, category, workspace? })` 打开弹窗并写入设备同步状态。只有平台提供 `requestSourceSettingsAttachment`（桌面端）时可用。
- `ui/DataSyncDialogProvider.tsx`：挂在窗口 Root 下，持有唯一弹窗请求及最小化状态。所有入口发送打开命令；已有弹窗时恢复同一实例。页面卸载不卸载推送。设备结果写入后递增结果版本（`useDataSyncResultVersion`），这是推送结束后页面刷新的唯一信号。
- `ui/DataSyncDialogContainer.tsx`：窗口级弹窗容器（申请 attachment、收集 tab）；设备结果由窗口级 Provider 记录；落盘后发布版本失效信号，数据同步页与 `useDataSyncEntry({ onPushFinished })` 的设置页按版本变化重新读取，不依赖弹窗由哪个入口打开。

不变量：

- 弹窗绑定设备的一次连接（generation = `online && targetServices`）。换代时进行中的推送标为失败并写入设备同步状态，迟到结果按 push session 身份丢弃；重新在线后重新加载。
- 推送中禁止关闭弹窗，没有全局取消。marketplace 插件行在远端 add / install 期间可按行「停止」：弹窗经 `getService(target, control)` 注入 `DataSyncPushControl`，停止发出 `cancelPluginOperation` 并让该项以「已停止」失败，不影响其他项和 push session。
- 最小化只卸载模态内容，保留 `DataSyncDialog` 及其两个状态 hook；右下角状态条可恢复，结束后不自动展开。generation、push session、分类和勾选不随展示状态变化。Web / 手机不开放入口；不新增持久化或后台服务。
- 推送按分类串行；每次推送（单个分类或推送全部）结束后调用一次 `onPushFinished`，设备行只从设备同步状态读取上次结果。
- `afterPush` 只刷新运行态，不属于 push session：分类导入结束后进入弹窗内的串行队列，按推送顺序执行，失败只记日志。推送结束、`onPushFinished` 和下一次推送都不等待它。
- 推送永不删除远端独有条目；黄色「差异」项默认不勾选，用户可手动勾选覆盖。

```text
open → list×2 → contentHashes（两端都有的项）→ compare → 勾选
     → export → checkWriteAccess(15s) → import(createOnly|overwrite, expectedTargetHash)
     → 分类结果 → 重新 list（只重算受影响项的哈希）；afterPush 刷新进入串行队列（不等待）
     → 推送结束 → onPushFinished(success|partial|failed)
offline → generation+1 → 推送中分类 failed → 禁用操作；online → 重新加载
```
