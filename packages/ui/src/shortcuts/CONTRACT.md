# shortcuts

快捷键内核（`docs/desktop/shortcut-settings-spec.md`）：命令 ID → 生效绑定 → 键盘事件匹配。全仓库只有本模块和 `@zcode/shared` 的 `shortcutCommands.ts` 认识键位，其他代码只认命令 ID。

- `bindings.ts`：匹配、录制、生效表 `resolveEffectiveShortcutBindings`、物理等价口径 `canonicalShortcutBindingKey`。
- `conflicts.ts`：保留键、占用检测、抢绑与拆行构建器。
- `label.ts`：绑定串的平台展示。`useShortcutBindings.ts`：React 桥接，数据来自 `useSettings`。
- `composerShortcuts.ts`：composer 作用域按键解析。

不变量：

- 生效表只由命令表默认值和 `shortcutBindings` 覆盖推导，不写盘。显式空数组 = 未分配，不回退默认；全部非法才回退默认。
- 默认键让位显式覆盖：没有覆盖的 window 通道命令，去掉与同作用域其他命令显式覆盖物理等价的默认键。menu 通道不让位，与 main 侧 `resolveMenuAccelerator` 一致。
- 物理等价只有 `canonicalShortcutBindingKey` 一份口径，冲突检测、让位、按键搜索共用。
- 匹配侧过滤 IME 组合与长按 repeat；录制态由 `setShortcutRecordingActive` 通知各分发方短路。
