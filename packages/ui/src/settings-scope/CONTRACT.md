# settings-scope

设置页 Scope 菜单按设备分组（`docs/remote/data-sync.md`「Scope 菜单按设备分组」）。插件、MCP、技能、命令、子智能体、钩子页共用；记忆开关复用其中的设备「用户」项，文件查看仍使用独立的本机项目菜单（`docs/remote/memory-settings.md`）。

- `domain/scope.ts`：纯函数。`buildSettingsScopeGroups`（本机在前，在线设备各一组；离线设备不列出）、`resolveDefaultSettingsScopeKey`（当前 workspace 所在设备的「用户」）、`resolveSettingsScope`（ready / offline / missing）。
- `app/useSettingsScope.ts`：Scope 状态唯一 owner。项目来自配置目录目录表，设备名与在线状态来自管理快照，远端「用户」经该设备的 source-settings attachment（`ensureSourceSettingsServices`）+ `systemService.info().homedir`。
- `app/useSettingsScopeForm.ts`：设置页表单的设备 owner（子智能体、钩子页共用）。`useSettingsScopeForm<T>(scope)` 返回 `{ form, openForm, closeForm }`：`openForm` 以当前设备为 owner 打开表单，`form` 只给出当前设备拥有的表单值。
- `ui/`：表单内菜单的设备上下文 `SettingsScopeDeviceProvider`；离线 / 连接中提示 `SettingsScopeBlockedNotice`。

不变量：

- Scope key：`"user"` = 本机「用户」，`source-user:<sourceServerId>` = 远端设备「用户」，其余为项目 key（`getWorkspaceKey`）。分区与表单内部只用设备内 key（「用户」统一为 `"user"`），由 `toLocalScopeKey` / `toPageScopeKey` 转换。
- 选中设备离线（以管理快照为准）时 fail-closed：不提供任何服务，不回退本机，不显示旧快照；attachment 仍在注册表中也不使用。
- 显式项目目标尚未解析或等待回退时显示加载状态，不临时展示用户配置的可写列表。
- 迟到结果只属于原目标：home 目录结果绑定发起请求的那组服务，切换设备或 attachment 换代后丢弃。
- 选中的目标是一组绑定 {authority（远端「用户」为 `cacheAuthorityKey`）、路径、identity、服务}。页面把整组交给单例 store（MCP、命令）；store 的读取、在途请求键、迟到判定、写入只用这一组，不从当前 tab 推断，也不读全局服务。本机「用户」没有 authority，与本机项目一样走本机平台路径。
- 只有平台提供 `requestSourceSettingsAttachment`（桌面端）时才有远端「用户」；Web / 手机不能借此申请 attachment，远程 tab 默认选中当前远程项目。
- 用户选中的项目关闭后回退到同一设备的「用户」；当前 Host 目录尚未读取完成时保留显式导航目标，不把加载中的空列表当作项目关闭。默认 key 指向的项目尚未出现在目录表时只按回退目标解析，不改写选择。
- 表单归属打开它的设备（owner 取设备级：本机为 `"local"`，远端为 `device.id`；`missing` 帧按 `fallbackKey` 所在设备判断）。同一设备内切换「用户」/ 项目、设备离线后恢复都保留表单；owner 不是当前设备时在渲染期清掉（不用 effect），不带到新设备。
