# 快捷键设置（Shortcut Settings）Spec

快捷键设置提供用户级的应用命令绑定。首期覆盖新建任务、打开工作区、关闭当前上下文、侧栏/面板/终端切换、任务查找、会话前后导航、历史前进后退、命令中心和页面缩放。Enter、Escape、Tab、Space 保持组件固定交互。配置按命令 ID 保存，缺失或非法值回退默认值；同一组合键只能绑定一个命令。

本 spec 是该功能的唯一实现依据；架构原则是**全仓库只有快捷键模块认识键位，其余代码只认命令 ID**。

## 1. 目标与非目标

目标：

- 用户可在设置页录制并保存任意合法组合键，保存后立即生效（本窗口即时、其他窗口经同步、桌面菜单重建）。
- 命令表、默认绑定、匹配/录制/冲突逻辑收敛到独立模块，新增一个可配置快捷键只改 shared 命令表一处 + 消费方注册 handler。
- 组合键识别覆盖：多修饰键（CmdOrCtrl/Ctrl/Alt/Shift 任意组合）、Shift+字母、macOS Option 布局改写（event.code 兜底）、中文输入法组合中（isComposing/Process/Dead/229 不触发）、长按 repeat 不重复触发。
- 三操作系统（macOS/Windows/Linux）键位语义一致，双主题、i18n、桌面/Web/手机三端兼容。

非目标：

- 系统级全局快捷键（应用未聚焦时响应，Electron `globalShortcut`）：保持现状不引入，留作后续扩展。
- 会话内输入框的组件级交互键（Enter 发送、Escape 取消、Tab 缩进、TaskSearchDialog 的 G/数字导航、GitActionMenu 的 ⏎）不做配置。
- 快捷键按 workspace 隔离：用户级全局配置，不分 workspace。

## 2. 架构与依赖方向

```
┌────────────────────────────────────────────────────────────┐
│ packages/shared（唯一数据源，纯数据 + 纯函数，无 DOM/Electron）  │
│  shortcutCommands.ts:                                       │
│   · ShortcutCommandId / ShortcutChannel 类型                 │
│   · SHORTCUT_COMMANDS 命令表（id/通道/默认绑定/是否可配置）      │
│   · 序列化格式 parse/serialize/isValid（Electron 兼容语法）     │
│  protocol.ts + validationAppSettings.ts:                     │
│   · AppSettings.shortcutBindings 字段（三处同步：interface +    │
│     object schema + patch schema）                           │
└──────────────────────┬─────────────────────────────────────┘
                       │ 所有代码只 import 这里，不另立键位知识
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
┌──────────────┐ ┌─────────────┐ ┌────────────────────┐
│ ui/src/      │ │ ui/src/     │ │ desktop main 进程   │
│ shortcuts/   │ │ settings/   │ │ desktopApplication │
│ （执行内核）    │ │ Shortcut    │ │ Menu.ts:           │
│ · 通用匹配器   │ │ Settings    │ │ accelerator 从生效  │
│ · 录制器      │ │ Section.tsx │ │ 表读取，rebuild 时  │
│ · 生效表 resolve│ │（编辑器 UI，  │ │ 重建               │
│ · 冲突检测    │ │  只读写数据）  │ │（复用既有           │
│ · label hook │ └──────┬──────┘ │  SyncAppSettings →  │
└──────┬───────┘        │        │  syncImmediate      │
       │                │        │  AppSettings 链路）  │
       ▼                ▼        └────────────────────┘
  useAppKeyboard   useSettings（useSettingService.ts）
  （薄壳：事件→    已内置：update() = settingService.update
  命令→handler）      + platform.syncAppSettings + refresh()
```

依赖方向的硬规则：

- `ui/src/shortcuts/` 是快捷键知识的唯一所有者；`useAppKeyboard`、`ShortcutSettingsSection`、各 label 消费方只调用它的 API，不解析键位字符串。
- 设置服务对快捷键只是透传数据（`Record<命令ID, string[]>`），不校验语义；语义校验（格式/冲突/保留键）全部在快捷键模块内。
- 不新增 IPC、不动 Zustand 主 store、不扩 BROADCAST_FIELDS。跨窗口同步与菜单重建复用设置链路（见 §6）。

## 3. 序列化格式（组合键识别的核心约定）

采用 Electron accelerator 兼容语法的子集，同一个字符串同时用于：setting.json 持久化、renderer 匹配、菜单 accelerator 透传、跨进程传输。

```
binding   := modifier+ key
modifier  := "CmdOrCtrl" | "Ctrl" | "Alt" | "Shift" | "AltGr"
key       := [a-z] | [0-9] | "[" | "]" | "=" | "-" | "," | "." | "/" | "\\"
            | ";" | "'" | "`" | [A-Z]（录制时统一小写化，大写不合法）
            | "Plus" | "Minus" | "Equal"（菜单兼容别名，内核归一化）
            | "F1".."F12" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
            | "Home" | "End" | "PageUp" | "PageDown" | "Delete" | "Insert"
```

规则：

- **修饰键顺序固定**：`CmdOrCtrl → Ctrl → Alt → Shift → AltGr → key`。parse 后重新 serialize 做规范化（canonical form），非法字符串 parse 返回 null。
- **CmdOrCtrl 是语义修饰键**：macOS 匹配 `metaKey && !ctrlKey`，Windows/Linux 匹配 `ctrlKey && !metaKey`（沿用 keyboardShortcuts.ts:165-173 的平台隔离逻辑）；菜单场景直接透传给 Electron。
- **Ctrl 是显式 Ctrl**：macOS 上录制 Ctrl+X 产出 `Ctrl+X`（mac 的 Ctrl 留给系统 Emacs 风格编辑，用户显式选择才绑定）；Windows/Linux 上主修饰键录制一律产出 `CmdOrCtrl+X`，`Ctrl+X` 在这些平台匹配时视同 `CmdOrCtrl`。
- **Shift+键统一小写基键**：录制 `Shift+P` 产出 `CmdOrCtrl+Shift+p`（不是 `P`），`Shift+7` 产出 `CmdOrCtrl+Shift+7`（不是 `&`）。实现方式：录制时优先用 `event.code` 反查物理基键（`KeyP`→`p`、`Digit7`→`7`、`Equal`→`=`），`event.key` 仅做 fallback——这是键盘布局差异（AZERTY、macOS Option 改写）下唯一可靠的来源。
- **匹配是修饰键精确匹配**：事件四个修饰键状态与 binding 逐一比对，多余修饰键不算命中（防止 Cmd+Ctrl+K 误触发 CmdOrCtrl+K）。
- **key 匹配**：`event.key` 小写比较命中，或 `event.code` 经映射表兜底（现有 getExpectedShortcutCode 的扩展版，补 Equal/Minus/逗号句号斜杠分号引号反引号反斜杠）。
- **IME 与噪声过滤**：`event.isComposing === true`、`key === "Process"`、`key === "Dead"`、`keyCode === 229`、`event.repeat === true` 一律不匹配、不录制。中文输入法组合期间的 keydown 不得触发任何全局命令。
- 单键（无修饰键）binding 格式上合法、匹配上支持（要求四修饰键全 false），但首期命令表不含单键命令；录制 UI 要求至少一个修饰键（F1-F12 与方向键除外）。

## 4. 命令表（唯一事实来源）

| 命令 ID              | 通道   | 默认绑定                                                       |
| -------------------- | ------ | -------------------------------------------------------------- |
| openCommandCenter    | window | `CmdOrCtrl+K`、`CmdOrCtrl+Shift+P`（双默认，整组覆盖）         |
| openSettings         | window | `CmdOrCtrl+,`（mac ⌘, / win·linux Ctrl+,，系统惯例）           |
| findInTask           | window | `CmdOrCtrl+F`                                                  |
| toggleSidebar        | window | `CmdOrCtrl+B`                                                  |
| toggleTerminal       | window | `CmdOrCtrl+J`                                                  |
| toggleSidePane       | window | `CmdOrCtrl+Alt+B`                                              |
| previousConversation | window | `CmdOrCtrl+Shift+[`                                            |
| nextConversation     | window | `CmdOrCtrl+Shift+]`                                            |
| navigateBack         | window | `CmdOrCtrl+[`                                                  |
| navigateForward      | window | `CmdOrCtrl+]`                                                  |
| newTask              | menu   | `CmdOrCtrl+N`                                                  |
| openWorkspace        | menu   | `CmdOrCtrl+O`                                                  |
| closeActiveContext   | menu   | `CmdOrCtrl+W`                                                  |
| zoomIn               | menu   | `CmdOrCtrl+=`（菜单保留 Plus 可见项 + `=` 隐藏项的双条目模式） |
| zoomOut              | menu   | `CmdOrCtrl+-`                                                  |
| resetZoom            | menu   | `CmdOrCtrl+0`                                                  |

- `window` 通道：renderer 内 `useAppKeyboard` 分发，三端一致生效。
- `menu` 通道：桌面应用菜单 accelerator（main 进程）；menu 通道命令在 Web/手机端设置页置灰并标注「仅桌面端生效」，window 通道命令三端全部可配置。
- 命令表条目字段：`id`、`channel`、`defaultBindings: string[]`、`configurable`（首期全部 true，保留字段）。命令显示名走 i18n key `settings.shortcuts.command.<id>`。
- 历史注记：分支上的静态原型列了 12 条且漏了 findInTask/previousConversation/nextConversation，navigateBack/Forward 曾被误标为「上一个/下一个任务」——以本表为准修正。

## 5. 设置模型与持久化

- `AppSettings.shortcutBindings?: Record<string, string[]>`——**只存用户覆盖**；未覆盖的命令不落盘，读取时与命令表默认合并。覆盖语义：整组替换（openCommandCenter 被覆盖时两条默认绑定同时失效，换成用户录的那组）。
- schema 三处同步：`protocol.ts` 的 `AppSettings` interface、`validationAppSettings.ts` 的 `appSettingsObjectSchema`（`z.record(z.string(), z.array(z.string())).optional()`）与 `appSettingsPatchSchema`（同形 optional）。zod 默认剥除未知字段，漏改 patch schema 会导致更新静默丢失。
- schema 只校验形状；语义校验（命令 ID 是否存在、binding 是否合法）在生效表 resolve 阶段做容错：未知命令 ID 或非法 binding 条目忽略并打 warn 日志，其余条目正常生效——保证手改 setting.json 写入非法条目不会让快捷键整体失效。
- **发版状态与新增命令默认键的兼容约束**：快捷键自定义功能尚未发版，当前无存量用户配置，新增命令直接给默认键即可（如 openSettings 的 `CmdOrCtrl+,`）。**首发之后**再新增命令时，若默认键可能与用户已保存的显式绑定（同作用域、物理等价，如 win 的 `Ctrl+,` ≡ `CmdOrCtrl+,`）冲突，必须做「新默认键让位显式覆盖」的升级兼容，保证用户已有绑定不被静默抢占且设置页展示与实际执行一致。

## 6. 生效链路（时序）

```
用户在设置页点击绑定 → 录制 keydown
  │ Escape 取消 / 无效组合提示
  ▼
内核 conflicts 校验（见 §7）
  │ 拒绝 → UI 标红 + 提示占用者，不落盘，链路终止
  ▼ 通过
useSettings.update({ shortcutBindings: {...} })
  ├─ settingService.update(patch)     → zod 校验 + 与最新 settings 合并 + 原子写 setting.json
  ├─ platform.syncAppSettings(patch)  → IPC → main syncImmediateAppSettings：
  │      ├─ patch.shortcutBindings 存在 → rebuildMenu()（accelerator 从
  │      │    mainSettingService 读生效表重建应用菜单）
  │      └─ 向所有窗口 webContents.send(SettingsChanged)
  │           → 其他窗口 useSettings 的 onSettingsChanged → refresh()
  │             → sharedSnapshot 更新 → 生效表重算 → useAppKeyboard 下次事件即新键位
  └─ refresh() → 本窗口 sharedSnapshot 更新（即时生效）
```

- 桌面端多窗口：窗口 A 改键 → 窗口 B 经 SettingsChanged 刷新（先例：main/index.ts setAutoUpdatePreferences 的全窗口广播）。
- Web/手机端：`platform.syncAppSettings` 为 no-op fallback，单窗口无跨窗口问题；菜单通道命令不适用。
- 启动时：各窗口 useSettings 首次拉取即得生效表；main 进程 rebuildMenu 时从 `mainSettingService.get()` 读 shortcutBindings。

## 7. 冲突策略（系统保留键拒绝；app 内占用二次确认抢绑）

录制组合 B 准备绑定命令 C 时，按序校验：

1. B 命中保留键黑名单（RESERVED_BINDINGS，见下）→ **直接拒绝**，标红提示「系统保留键位」，无确认入口。系统/浏览器快捷键抢绑会破坏输入与浏览器原生行为，不做二次确认。
2. B 已被生效表中另一命令占用（含其任一默认绑定）→ **标红提示占用者 + 「仍要绑定」二次确认按钮**。确认后抢绑：C 的覆盖写为 [B]，被抢命令的覆盖写为其生效绑定减去 B（可能为显式空数组 = 未设置，不回退默认）；不确认则可继续录制其他组合或 Escape 退出。
3. B 与 C 当前绑定相同 → 无操作（幂等）。

**录制态抑制（防录制按键触发原命令）**：录制监听与 useAppKeyboard 同为 window capture 监听且注册更晚（同阶段先注册先执行），因此录制态期间——renderer 通道由内核 `setShortcutRecordingActive(true)` 短路 useAppKeyboard 分发；menu 通道由 `platform.setShortcutRecordingActive(true)`（IPC `SetShortcutRecordingActive`）通知 main 重建菜单时摘除全部可配置 accelerator（macOS 系统菜单先于 renderer 吃键，preventDefault 拦不住）；**Web 根级回退监听**（useRootPlatformEffects 固定响应 Cmd/Ctrl+N、O）与**工具条固定热键**（Ctrl+M / Ctrl+Shift+M / Ctrl+T）同样在录制态短路——它们注册早于录制监听，不短路会先于录制器吃键。退出录制态恢复。

**录制态跨进程收口（防窗口销毁泄漏）**：IPC 附带发起方 webContents id；录制中窗口关闭/渲染进程崩溃时 renderer 不会发复位 IPC，main 在既有窗口销毁清理里按发起 webContents 复位录制态并 rebuildMenu，防止菜单 accelerator 被永久摘除（所有后续 rebuildMenu 都建出无 accelerator 菜单且波及全部窗口）。

**录制态键盘语义（录制 = 显式意图，录制器独占键盘）**：

- **录制开始即抢占焦点**：录制行的预览 kbd 元素 `focus()`，把焦点从可编辑元素（如搜索框）里拉出。否则中文 IME 会把 Shift+字母 吞成组合输入，录制器只能收到 isComposing/229 噪声事件——这正是「识别不了纯 Shift 组合」的根因形态。
- **IME 噪声事件在录制态仍按 `event.code` 反查物理键录制**（isComposing / Process / Dead / keyCode 229 的事件 key 不可信但 code 是物理键）。匹配侧照旧全量过滤（isShortcutEventNoise 不变），录制宽松、匹配严格。
- **平台归一会丢主修饰键的组合拒绝录制**：mac 的 Cmd+Ctrl+组合、win/linux 的纯 Meta（Win 键）组合经归一后 cmdOrCtrl/ctrl 双双为 false，若照常序列化会产出裸单键（如 "k"）——不在黑名单、不触发冲突检测，落盘后全应用裸按该键即命中命令并吞掉输入。序列化前校验 `(metaKey || ctrlKey) && !cmdOrCtrl && !ctrl` 即拒绝。
- **冲突/无效提示不退出录制态**：直接重按新组合即可覆盖（监听一直挂着）；修饰键单独按下（pending）即刻清空残留的预览/错误/抢绑提示，保证录制器「还活着」的视觉反馈。

**可编辑目标豁免（纯 Shift+可打印键与打大写字母是同一物理事件）**：useAppKeyboard 分发时若事件目标是 input/textarea/contenteditable，跳过「无主修饰键 + Shift + 可打印单字符」类绑定（`isShiftOnlyPrintableBinding`）——不匹配、不 preventDefault，保证用户在聊天输入框/搜索框/终端打得出大写字母；焦点在非可编辑区域时这类绑定照常生效。命名键（Shift+F1、Shift+方向键）不受豁免影响。

覆盖数据语义配套：`shortcutBindings` 中某命令的**显式空数组 = 「未设置」**（生效表为空、不回退默认）——设置页「清除」按钮与抢绑后的被抢命令都会产出该状态；只有全部条目非法才回退默认（防手改 setting.json）。**该语义贯穿到 main 侧菜单解析**（`resolveMenuAccelerator`）：显式空数组 → 菜单项无 accelerator（抢绑后被抢命令的默认键必须真的摘除，不得回退硬编码默认值——否则同键双动作）；全非法条目才回退默认，与 renderer 生效表一致。

保留键黑名单（不可被任何可配置命令绑定）：

- 组件固定交互单键：`Enter`、`Escape`、`Tab`、`Space`、`Backspace`、`ArrowUp/Down/Left/Right`。
- 组件固定交互组合键（工具条固定消费）：`CmdOrCtrl+M`（模型菜单）、`CmdOrCtrl+Shift+M`（会话模式）、`CmdOrCtrl+T`（思考深度）——它们不读生效表，可被绑定会造成同键双动作。
- 浏览器/编辑原生行为（主修饰键组合）：`CmdOrCtrl+C/V/X/Z/A/Y/S/P/L`、`CmdOrCtrl+Shift+Z`。
- 刷新与开发工具：`F5`、`CmdOrCtrl+R`、`CmdOrCtrl+Shift+R`、`F12`、`CmdOrCtrl+Shift+I/J/C`。
- 功能键区：`F1`-`F12` 整段保留（浏览器帮助/开发者工具等语义）。
- **Web 端动态保留**：Web/手机端 menu 通道命令不可配置，但其默认键（Cmd/Ctrl+N、O、W 等）仍被根级回退监听固定消费——冲突检测按保留键拒绝（无抢绑入口），不随桌面端开放抢绑。

黑名单在内核模块以 binding 规范化形式声明，比较在规范化之后进行。命令表默认绑定不得与黑名单相交（单测断言，仅限 global 作用域命令，见 §12）。允许用户把命令改到黑名单之外的任何组合，包括原来属于其他命令的键（由规则 2 提示并经二次确认抢绑，而非黑名单拦截）。

## 8. 设置页 UI 规格

- 沿用已注册的 shortcuts 分区（settingsPageConfig / settingsNavigation / SettingsPage 挂载已完成），重写 `ShortcutSettingsSection`：
  - **单行多绑定**：一个命令一行——左列命令名跨全部绑定垂直居中，键位列纵向列出每条绑定，操作列为「清空全部」垃圾桶。命令无绑定时显示「未分配」键帽（点击即录第一条）。
  - **逐键键帽**：绑定串经 `formatShortcutBindingLabelParts` 拆成逐键 token（macOS `["⇧","⌘","P"]`、Win/Linux `["Ctrl","Shift","P"]`，与展示 label 同一 token 序列），每个 token 独立渲染 `Kbd` 组件（`components/ui/kbd.tsx`：复用 `ControlShortcutBadge` 的 `h-4`、`rounded-md`、`bg-tooltip-tag` / `text-tooltip-tag-foreground` 与平台字体，增加 `min-w-4` 并居中，符号键与字母键尺寸一致），一次组合用 `KbdGroup`（gap-1）横排。自定义覆盖的命令键帽用品牌色。
  - 行内操作（当前阶段仅替换，暂不支持新增/删除绑定）：点击某条键帽或铅笔 = **替换该条**（录制态内嵌在该条目位置，成功后按生效列表下标整组写回 `buildShortcutOverridesWithBindingAt`；未分配命令录第一条走 `buildShortcutOverridesAfterAppend`）；垃圾桶 = **清空全部绑定**（覆盖写显式 `[]` = 未分配，不回退默认）。录制态 `Escape` 取消；`Backspace` 恢复默认（删除 overrides 条目，SG-03 默认键冲突预检保留）。`buildShortcutOverridesWithoutBindingAt`（删除单条）内核已就绪并具单测，UI 入口待后续开放。
  - **同命令重复拒绝**：录制的组合与本命令其他生效条目物理等价（`isSamePhysicalBinding`）时标红拒绝（add 比全部条目，replace 跳过正在替换的目标条）——一个命令挂同一组键没有意义。跨命令冲突/保留键策略不变（§7）。
  - 冲突标红：`text-destructive` + 占用者文案（语义色按 DESIGN.md 只用于真实校验问题）；hint 文案明示「冲突后直接重按新组合」。
  - 搜索框过滤（按命令名/ID 匹配命中命令的全部绑定行）、全部恢复默认（清空 shortcutBindings）保留。
  - **按组合键搜索（VSCode 键盘快捷键同款）**：搜索框右端键盘图标按钮，点击进入武装态（placeholder 变为「按下要搜索的组合键…」，输入框 readOnly）。武装态复用行内录制的键盘独占抑制（`setShortcutRecordingActive`，renderer/menu 双通道），window keydown capture：`Escape` 退出；`Backspace` 清除已捕获组合；其余事件经录制器捕获（`recordShortcutBinding`，含平台归一；裸字母等命令表不可能出现的键静默忽略）。捕获成功即退出武装态，组合作为独立过滤条件（与文本搜索 AND）：命中生效表里与之**物理等价**（`isSamePhysicalBinding`，与冲突检测同一 canonical 口径，win 的 Ctrl+m ≡ CmdOrCtrl+m）的命令。已捕获组合以输入框文本形式从左侧展示（VSCode 同款，品牌色 + 等宽字体，readOnly；此时文本过滤条件仍在内部生效），右端 × 清除后回到纯文本搜索。与行内录制互斥：武装时点击录制按钮先解除武装态，反之亦然。过滤无命中时表格尾部展示空态文案（按键搜索带组合 label，纯文本搜索不带）。
  - Web/手机端 menu 通道命令置灰（弱化文字色，不隐藏），行尾标注 i18n 文案「仅桌面端生效」。
  - 界面模式切换快捷键继续注册和响应，但不在快捷键列表中展示；亮暗切换快捷键保留在列表中。侧边栏主题与界面模式子菜单只展示选项，不在底部重复展示快捷键提示。
  - 文案全部走 i18n（zh-CN/en-US 同步补 key），替换原型中的硬编码中文。
- 展示 label：`useShortcutCommandLabel(commandId)` 从生效表取首个绑定格式化为平台 label（macOS `⌘K` 风格、Win/Linux `Ctrl+K` 风格，沿用 keyboardShortcuts.ts 现有格式化习惯）；命令未分配（生效绑定为空）时返回空串，tooltip 不展示键位段、**不回退默认展示**——提示必须与实际生效一致。替换以下调用点：App.tsx:143-149（7 处）、NewTaskButtonGroup.tsx:16、WindowsCaptionMenuButton.tsx:238/243/260、WorkspaceSidebar.tsx:414、WorkspaceSidebarFooter.tsx:294/302。GitActionMenu 的 ⏎ 与 TaskSearchDialog 的 G/数字为对话框内部键，不在命令表，保持现状。
- 双键展示：openCommandCenter 取生效表第一个绑定展示。

### 设置页控件、窄屏与保存反馈

- 搜索框复用 `SettingsSearchInput`；普通文本使用界面字体，捕获组合键保留等宽字体。按键按钮与清除按钮复用共享 Button。
- 工具栏沿用设置页的换行布局；搜索在窄屏独占一行，恢复默认使用紧凑 outline 按钮。
- 宽屏保留命令、键位、作用域、操作四列；窄屏改为命令/作用域在上、键位/操作在下。长命令、组合键与冲突提示允许换行，不裁切。
- 保存状态由 ShortcutSettingsSection 持有；绑定事实继续来自 useSettings。提交开始即禁用全部修改入口，设置更新和快照刷新完成后恢复。搜索不受影响。
- 保存失败展示可访问的错误提示，保留当前设置并恢复编辑；用户可重新操作，不自动重试。重置确认返回时仍须通过同一保存入口。
- 保持原搜索语义：文本与按键条件 AND，捕获后 readOnly，清除按键后恢复原文本条件。
- SC-13：深浅主题、宽屏/窄屏下检查搜索控件、键帽的非透明底色及共享高度/圆角、长键位、操作按钮与布局；SC-14：受控保存期间不可编辑，失败提示后可重新保存（组件测试控制 Promise，E2E 验证真实保存）。

## 9. useAppKeyboard 参数化

- 改造为：接收 `handlers: Partial<Record<ShortcutCommandId, (() => void) | null>>` + 内部读生效表；`useEffect` 内 keydown → 过滤（repeat/IME）→ 按生效表逐命令逐绑定通用匹配 → 命中即 `preventDefault()` + 调 handler。
- handler 为 null/缺失时**不 preventDefault**（沿用现有 previousConversation/navBack 的语义：功能不可用时放行浏览器默认行为）。
- App.tsx 挂载点的 handlers 映射到命令 ID，行为与现状一一对应，不改业务逻辑。
- 现有 matchesPrimaryShortcut 系列函数保留给未入表的固定交互（matchesShiftTab 等），不在本次删除。

## 10. 测试计划

单测（先写测试再写实现）：

- shared 序列化：parse/serialize 往返、规范化（顺序/大小写/别名）、非法串拒绝、Electron 兼容性（CmdOrCtrl 透传合法）。
- 内核匹配器：平台隔离（mac meta vs win/linux ctrl）、修饰键精确匹配（多余修饰不命中）、Shift+字母（key 大写/code 兜底）、macOS Option 改写（key 为布局字符、code 命中）、IME（isComposing/Process/Dead/229 不命中）、repeat 不命中、单键 binding。
- 录制器：Cmd/Ctrl→CmdOrCtrl 平台归一、mac Ctrl→Ctrl、Shift+7→7（code 反查）、修饰键单独按下不产出、Escape/Backspace 语义、**纯 Shift 组合（Shift+F）录制**、**IME 噪声事件按 code 反查录制（无可反查 code 保持 pending、repeat 不录制、匹配侧照旧过滤）**。
- 生效表 resolve：默认合并、整组覆盖、非法条目忽略、未知命令忽略。
- 冲突检测：黑名单、跨命令占用、幂等；命令表默认绑定不与黑名单相交的断言。
- 按键搜索等价比较（`isSamePhysicalBinding`）：win/linux 的 CmdOrCtrl ≡ Ctrl、AltGr 叠加；mac 主修饰与 Ctrl 独立（同一对串等价关系随平台翻转）；裸命名键；解析失败串恒不等。
- 拆行多绑定构建器：`buildShortcutOverridesAfterAppend`（默认键+覆盖全保留、未分配追加=第一条）、`buildShortcutOverridesWithoutBindingAt`（删指定条、删空落显式 `[]`、不影响其他命令）、`buildShortcutOverridesWithBindingAt`（指定位置替换、其余默认键保留）。
- schema：shortcutBindings patch 更新往返、未知字段剥除行为。

e2e（packages/desktop/test/e2e/，涉及 App 交互按仓库要求必须有 e2e）：

- 设置页录制新键位 → 重启后仍生效（setting.json 持久化）。
- 新键位在主界面实际触发命令（如 toggleSidebar 换绑后按新键侧栏开合）。
- 冲突场景：录制已被其他命令占用的组合 → 标红提示占用者 + 「仍要绑定」确认后抢绑落盘、被抢命令变「未设置」；录制系统保留键（如 Ctrl+C）→ 直接拒绝且无确认按钮；录制期间按键不触发原命令（抑制生效）。
- 中文输入法组合中按键不触发命令（可模拟 isComposing 事件）。
- 真实按键管线（`browser.keys()`，区别于合成 KeyboardEvent）：纯 Shift 组合录制→落盘→主界面生效（SC-04）；冲突后不按 Escape 直接重按第二组组合（SC-05）；录制态收到 IME 噪声事件按 code 录制（SC-06，合成 isComposing 事件）；纯 Shift+可打印键在可编辑目标内不触发命令且不吞字符（SC-07）；抢绑 menu 通道默认键后原 accelerator 摘除、按键只触发新 owner（SC-08，含 main 侧空数组语义）。
- 「清除为未分配」（SC-10）：点击垃圾桶 → kbd 显示「未分配」且清除按钮禁用 → 主界面按原默认键不再触发该命令 → 重进设置页仍为未分配（覆盖 `[]` 持久化、不回退默认）；录制态 `Backspace` 恢复默认路径不受影响。
- 按组合键搜索（SC-11/SC-12，`settings/shortcuts/shortcut-settings-key-search.test.ts`）：武装后按平台主修饰+K 过滤出默认绑定该组合的命令（openCommandCenter）且其它命令行消失 → 清除后恢复全量；无命中组合（CmdOrCtrl+Shift+9）展示空态 → 清除后重新武装、Escape 退出（aria-pressed 复位、列表不动）。

## 11. 实现步骤

1. shared：`shortcutCommands.ts`（格式 + 命令表）+ protocol.ts/schema 三处字段 + 单测。
2. `ui/src/shortcuts/`：matcher/recorder/resolve/conflicts/label + 单测。
3. `useAppKeyboard` 参数化 + App.tsx handlers 映射 + 11 处 label 替换。
4. `ShortcutSettingsSection` 重写 + i18n key（zh-CN/en-US）。
5. desktop main：菜单 accelerator 参数化 + `syncImmediateAppSettings` 快捷键分支（rebuildMenu + SettingsChanged 广播）。
6. e2e 用例。
7. `pnpm typecheck`、`pnpm lint`、相关单测、e2e 全绿后提交。

## 12. 作用域与来源（scoped shortcuts）

参考 VSCode Keyboard Shortcuts 的 When / Source 两列：键位可以绑定在特定**作用域**内生效，
设置页标明键位**来源**。引入作用域后，Enter 族这类"对话框确认键"可以安全入表——杀伤半径
被限制在上下文内。

### 12.1 作用域定义

命令表 `ShortcutCommandEntry` 新增 `scope?: "global" | "composer"`（缺省 `global`）：

- `global`：现有全部命令。分发方为 useAppKeyboard（window 通道）/ 菜单 accelerator（menu 通道）。
- `composer`：聊天输入框聚焦时才有意义的行为。分发方为 composer 的 Lexical 键盘行为插件
  （`LexicalChatInput` KeyboardPlugin），**唯一消费方**；useAppKeyboard、菜单、Web 回退监听
  对 composer 命令零感知（`useAppKeyboard` 显式跳过 `scope !== "global"`）。

作用域的实现不依赖全局焦点登记表：composer 插件的 keydown 只会在自己的编辑器聚焦时到达，
事件目标即作用域，天然无共享状态、无时序问题（唯一数据源 = DOM 事件路径）。

首批 composer 作用域命令（组件内部固定键位审计结果，见下表）：

| 命令                    | 默认绑定      | 说明     |
| ----------------------- | ------------- | -------- |
| `composerSend`          | `Enter`       | 发送消息 |
| `composerInsertNewline` | `Shift+Enter` | 插入换行 |

审计中**不**入表的作用域候选（登记备忘）：TaskFindDialog 的 G/数字/⏎ 与 GitActionMenu 的 ⏎
（对话框内部导航键，未来可扩 `taskFindDialog` 作用域）；工具条 Ctrl+M / Ctrl+Shift+M / Ctrl+T
（跨作用域消费，维持 global + 黑名单，见 §7）。

### 12.2 内核配套改动

- 键名白名单：`NAMED_KEYS` 增加 `Enter`（`Shift+Enter`、`CmdOrCtrl+Enter` 从此可表示）；
  录制侧 `CODE_TO_KEY` 同步增加（主键盘 `Enter` code；`NumpadEnter` 不映射）。
- 保留键黑名单相应收紧：`Enter` 加入 `RESERVED_BINDINGS`——**仅对 global 作用域生效**；
  "命令表默认绑定不得与黑名单相交"的断言同步收窄为仅查 global 命令。
- 冲突检测按作用域隔离：重绑某命令时只与**同作用域**命令比对占用（`CmdOrCtrl+Enter` 作为
  composer 发送键与全局命令并存，不算冲突）；黑名单只拦截 global 作用域的重绑。

### 12.3 composer 插件分发顺序（改绑层与运行时功能的优先级）

```
keydown（composer Lexical KEY_ENTER_COMMAND，COMMAND_PRIORITY_HIGH）
  ① disabled / isComposing ──▶ 现状（整体拦截 / 放行 IME 候选确认）
  ② 改绑层 resolveComposerKeyAction（shortcuts/composerShortcuts.ts，读生效表 composer 命令）
       ├─ 命中 composerInsertNewline ──▶ 放行 Lexical 插段落（换行）
       └─ 命中 composerSend ──▶ 发送分支（复用现有语义函数）：
             无修饰键组合 ──▶ 受 submitDisabled / enterSubmits（手机视口）门禁，与现状裸 Enter 等价
             带 Ctrl/Meta 修饰且反转投递开启（onModifiedSubmit 已注入）──▶ 让位：放行主链，
             Ctrl+Enter 仍表达"反向 delivery"运行时功能（交付语义比键位更具体）
  ③ 未命中（含全部默认状态下的修饰组合）──▶ 现有主链原样执行
```

默认（无用户覆盖）状态下 ② 与 ③ 行为逐分支等价（单测锁定矩阵：桌面/手机视口 ×
Enter/Shift+Enter/Ctrl+Enter × 反转投递开关），保证零回归。整组替换语义不变：用户把
`composerSend` 改绑为 `CmdOrCtrl+Enter` 后裸 Enter 未绑定 → ③ 主链中 shift/ctrl/meta 均
false 且 `enterSubmits` 为真时会走默认发送——为使"Ctrl+Enter 党"的裸 Enter 落到换行，
主链裸 Enter 分支前置一条作用域检查：`composerSend` 的生效绑定不含裸 Enter（即用户已
移除）时，裸 Enter 放行 Lexical 换行。Shift+Enter 未被覆盖时由 `composerInsertNewline`
默认绑定照常命中换行，不受影响。

### 12.4 设置页

- composer 命令自动出现在列表（数据驱动）。
- **作用域独立成列**：列表由三列扩为四列（命令 | 键位 | 作用域 | 操作），每行显式标注
  「全局」/ `Global` 或「输入框」/ `Composer`（i18n 同步 zh/en）——徽标式小字可读性差，
  独立列让作用域一眼可辨。
- menu 通道置灰逻辑不适用（composer 命令三端一致可改）；「仅桌面端生效」徽标保留在
  命令名旁（平台可用性语义，与作用域正交）。
- 「全部恢复默认」为破坏性操作：点击后复用全局确认弹窗（`useConfirmDialogStore` +
  `ConfirmDialogHost`，Enter 确认 / Esc 取消）二次确认后才清空 `shortcutBindings`；
  无覆盖时按钮禁用。
- 「来源」列（默认/用户/插件）暂以既有视觉承载（覆盖键位 brand 高亮 + 恢复默认），
  待插件键位接入命令表后再物化独立列。

### 12.5 测试

- shared：`Enter` 族 parse/serialize 往返；`scope` 字段；composer 命令表项。
- ui 内核：`RESERVED_BINDINGS` 含 `Enter` 且仅拦 global；冲突检测作用域隔离；
  `resolveComposerKeyAction` 矩阵（默认/改绑/反转投递让位/未绑定回退）；
  默认状态 ②≡③ 等价性矩阵。
- e2e（SC-09）：设置页把 composerSend 录制为 `CmdOrCtrl+Enter` → composer 内裸 Enter
  不发送（输入保留）、`CmdOrCtrl+Enter` 发送（草稿清空或用户消息上屏）。注意落盘 ≠
  renderer 生效表即时刷新（SettingsChanged 广播有亚秒级异步窗口），用例在落盘断言后
  显式等待窗口过去再验证主界面行为。

### 12.6 composer 工具条热键转正为可配置命令

原固定热键 Ctrl+M（打开模型菜单）/ Ctrl+Shift+M（切换会话模式）/ Ctrl+T（切换思考深度）
由 `v4/composer/toolbarShortcuts.ts` 的 window capture 监听固定消费、不读生效表（CR-06 曾
以保留黑名单拦截）。现转正为命令表命令：

| 命令                | 默认绑定       | 说明         |
| ------------------- | -------------- | ------------ |
| `openModelMenu`     | `Ctrl+m`       | 打开模型菜单 |
| `cycleSessionMode`  | `Ctrl+Shift+m` | 切换会话模式 |
| `cycleThoughtLevel` | `Ctrl+t`       | 切换思考深度 |

- **显式 Ctrl 修饰**（非 CmdOrCtrl）：三端语义一致为 Ctrl 键（mac 上也是 Ctrl），
  与旧 `matchesCtrlShortcut` 系列的修饰精确匹配语义等价，默认行为零变化。
- 分发仍在工具条的 window capture 监听（动作依赖 composer 工具条状态：模型菜单
  openRequestKey、选项门控等），但匹配改读生效表——设置页改绑后即时生效；
  录制态抑制、defaultPrevented/repeat/isComposing 过滤与 option 归属门控不变。
- 保留黑名单相应撤掉这三条（§12.6 前的 CR-06 拦截方案废止）：冲突体系（占用检测 +
  二次确认抢绑）对可配置命令全面生效。

物理等价冲突检测（新 CR-01）：匹配侧把平台等价组合视为同一物理键，冲突检测若只做
字符串精确比较，录制器平台归一产物（win 上录 ⌃M 产出 "CmdOrCtrl+m"）会绕过对显式
Ctrl 默认绑定（工具条三键）的占用检测，造成无提示静默遮蔽（useAppKeyboard 先分发
preventDefault，工具条监听 defaultPrevented 守卫放弃，菜单静默死亡）。因此冲突检测
与抢绑清除都在 canonical 键上进行——非 apple 平台 CmdOrCtrl ≡ Ctrl ≡ AltGr（主修饰
位）、AltGr ≡ Alt（叠加位）折算合并；apple 平台 CmdOrCtrl(meta) 与 Ctrl 为独立物理键
分开比较。macOS 另有 minimize 防线：⌘M 是系统菜单 role:"minimize" 的固定 accelerator，
任何作用域（含 composer）绑 ⌘M 都按保留键拒绝——系统菜单先于 renderer 吃键，绑上即
死绑定。

评审口径收敛（SG-03 / SG-09）：

- **恢复默认（清除覆盖）与录制同设防**：clearBinding 前用该命令的默认首键做冲突预检
  （物理等价归一后含 Ctrl+m ≡ CmdOrCtrl+m 等变体），命中占用时 toast 提示占用者且
  **不落盘**——按产品口径只提示、不自动清除占用方（自动清需要连锁恢复逻辑，属增生
  设计）；录制态 Backspace 路径复用同一 clearBinding，天然同设防。
- **「清除」与「恢复默认」分工（评审后口径）**：垃圾桶「清除」= 覆盖写显式空数组 =
  未分配（原键彻底失效）；录制态 `Backspace` = 恢复默认 = 删除覆盖条目（单命令回默认
  的唯一入口，全局另有「全部恢复默认」）。清除只减少绑定、不产出新键，不破坏「一键一
  命令」不变量，故不走冲突预检；恢复默认会把默认键重新引入生效表，必须预检。
- **composer 作用域统一开放策略**：不限定 Enter 键族——resolveComposerKeyAction 对
  生效表全量绑定做匹配，用户可把发送/换行绑成任意键（如 F9），与其他命令的开放策略
  一致。跨作用域同键（如 composerSend 绑 CmdOrCtrl+k 与全局命令中心）按 §12.2 作用域
  隔离不报冲突，按键时两个动作都会发生，属开放策略下的用户显式选择。
  **分发层配套（新 CR-01 闭合）**：KEY_ENTER_COMMAND 只对 Enter 派发，非 Enter 改绑由
  LexicalChatInput 的 root keydown capture（handleNonEnterScopedKeydown）分发——命中
  newline 显式 insertLineBreak；命中 send 复用发送链但不受手机视口 enterSubmits 门禁
  （软键盘误发只针对 Enter 物理键），且与反转投递（仅响应 Ctrl/Meta+Enter）无交集、
  无需让位。纯函数 resolveComposerKeyAction 为两条分发路径共用。
