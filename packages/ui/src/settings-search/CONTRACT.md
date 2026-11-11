# 设置搜索

提供设置项搜索入口和设置行定位。行为规格见 [设置页侧栏布局](../../../../docs/ui/settings-sidebar-layout.md#设置项模糊搜索)。

- SettingsSearch 只持有当前对话框和查询草稿，从已有分类、翻译及平台可见性投影结果，不挂载未选中的设置页。
- SettingsPage 接收 SettingsSearchResult，沿用原导航，并持有唯一定位目标。设置行实际挂载时按稳定 id 滚动、聚焦和高亮；每次命中的高亮在约 2 秒后自动消失，不改变焦点或滚动位置。旧轮次到期不影响后续命中。
- 定位不操作控件，不保存配置，不更改 Host 或 workspace。查询与关闭对话框没有持久化副作用。
- 新固定设置行在 settingsSearchIndex 中登记翻译 id、所属分类、说明和可见条件，并把相同 id 传给 SettingsRow。动态用户资源和条件授权操作由原页面管理。
- 通过 index.ts 公开组件、定位上下文和 hook；contract.ts 公开导航结果与定位 id 类型。内部匹配与索引不作为其他模块的业务状态源。
