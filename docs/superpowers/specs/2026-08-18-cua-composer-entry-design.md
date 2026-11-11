# CUA 输入框常驻入口按钮（首期：按钮 + 状态机）

- 日期：2026-08-18
- 状态：设计已确认，待实现
- 上游 PRD：《ZCode CUA 输入框常驻按钮&免费体验 PRD v0.2》（内部产品文档）
- 分支：`feat/cua-composer-entry`
- 后续变更：见文末「2026-09-11 变更：电脑控制默认关闭」——该变更删掉了本文多处描述的
  「未启用」（`plugin-disabled`）UI 态，读下文的状态表与 ASCII 图时请一并参照。

## 背景

CUA 目前只有一个用户主动入口：`设置 → 电脑控制 (Computer Use)` 的 `zcode-cua` 插件总开关
（`packages/ui/src/settings/ComputerUseSection.tsx`）。用户感知弱、发现成本高，这是 PRD §2.1
认定的核心问题。

PRD 的完整方案含免费体验引导层与免费额度体系。**本期只实现其中的入口与状态呈现部分**，原因是
额度链路（`cua-trial` entitlement、token reserve/settle、官方试用 Provider + 多模态试用模型、
体验任务冻结、促升级弹窗）在当前仓库零基础，且依赖 z.ai billing 服务端下发；PRD 自身也标注
「草案，待计费终审」。在服务端口径未定之前实现客户端额度 UI 只会产生返工。

## 范围

### 本期实现

1. `V4ComposerToolbar` 权限模式选择器右侧的常驻「电脑操作」按钮
2. 5 个对外 UI 态 + 低强度状态点（未启用灰 / 启用中灰转 / 已启用绿 / 权限缺失黄 / 错误红）
   （2026-09-11：「未启用」态已删除，现为 4 态；未启用改为不渲染）
3. 6 条 tooltip 文案（5 态 + 会话运行中禁用态），中英双语
   （2026-09-11：`…tooltip.disabled` 随「未启用」态一并删除，现为 5 条）
4. `session-busy` 可交互性覆盖：workspace 内任一 turn 运行中 → 整体禁用
5. 平台门：remote / linux / 普通 Web / 手机远控不渲染
6. 点击行为：全部可见态 → 跳设置页 `computerUse` 区；仅 session-busy 覆盖时不响应
   （2026-08-20 变更，原为「未启用、权限缺失可点，其余态仅 hover tooltip」，见下文「点击行为」节）
7. 设置页「在输入框显示电脑操作按钮」开关（默认显示，关闭后持久隐藏）
   （2026-08-21 改为默认隐藏；2026-09-11 起电脑控制关闭时该开关置灰并改提示文案）

### 本期明确不做

| PRD 章节                   | 不做项                                   | 原因                                                                                       |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| §4.2 / §6.2                | 免费体验引导弹层                         | 产品决策：本期不引入弹层，按钮直接跳设置页                                                 |
| §7 / §7.1 / §7.2           | 免费额度、试用模型、体验任务、促升级弹窗 | 依赖 z.ai billing 服务端，口径未终审                                                       |
| §4.2 步骤 2 / §4.3 第 4 项 | `capability-changed` 协议事件            | 需扩展 `@zcode/protocol` + `apps/zcode-cli`，本期用插件 toggling 完成 + Helper health 近似 |
| §4.5                       | 多任务浮窗                               | 与额度/并发规则耦合                                                                        |
| §4.6                       | 埋点漏斗                                 | 漏斗主体是引导层转化率，引导层不做则漏斗无意义                                             |

**就绪判定的降级口径**：PRD §4.3 要求 5 项全过。本期实际判定 3 项——插件 enabled 写入成功、
Helper 权限通过（mac，`isCuaPermissionTccGranted`：TCC 双项 granted）、Helper 状态可用。

**为什么不用功能探针**（2026-08-19 修正）：本条最初写的是 `isCuaPermissionStatusFullyReady`
（TCC 双项 + 两个功能探针 ok），落地后发现那是个恒假条件。上游 `shouldRunCuaScreenCaptureProbe`
要求显式 `includeFunctionalProbes`（主动抓屏必须是用户意图），常驻入口只走只读刷新，
`screenCaptureProbeOk` 因而恒为 `false`，已完成授权的用户会永远停在「缺少 macOS 权限」黄点。
现改用与设置页权限行同源的 TCC 口径；工具调用失败以普通 MCP error 到达模型，模型可按需
调用只读 `request_access`。Renderer 不根据错误文本自动推断权限，也不自动打开授权引导。

**已知风险**：存活 session 的工具集可能尚未刷新，用户看到绿点但 Agent
手上还没有 CUA 工具。这是 `capability-changed` 缺失的直接后果，须在下一期补齐。

## 可见性与状态推导

```
                    ┌──────────────────────────────────────────────┐
  可见性门（2026-09-11 起四层，任一不过 → 不渲染 DOM，不是渲染成 disabled）│
  ├ 平台门 : macOS desktop || Windows desktop 且本地 workspace       │
  │          remote / linux / web / 手机远控 → unsupported          │
  ├ 设置门 : AppSettings.computerUseComposerEntryHidden === true     │
  │          → hidden                                              │
  ├ 服务门 : mac 下 services.cuaPermissionService 缺失 → 不渲染      │
  └ 插件门 : cuaPlugin.enabled !== true 且不在 toggling 中 → 不渲染   │
             （2026-09-11 新增，见文末变更节）                        │
                    └──────────────────────────────────────────────┘
                                    ↓ 全部通过
  ┌──────────────── 底层状态（三路数据源汇聚） ────────────────┐
  │ ① pluginManagementStore : cuaPlugin.enabled / togglingPluginId
  │ ② useCuaPermissionStatus: accessibility / screenRecording + probes
  │                           （仅 mac 且 ①enabled 为真时才查询）
  │ ③ session 运行事实      : 当前 pane snapshot.control.canStop
  │                           || workspace runtime running/activeInputId
  │                           || visible task index status=running
  └──────────────────────────────────────────────────────────┘
                                    ↓
   内部态                →  UI 态       状态点     点击行为
   ────────────────────────────────────────────────────────────────
   plugin-disabled       →  （2026-09-11 删除：改为不渲染，见插件门）
   starting (toggling)   →  启用中      subtle spin  跳设置页 computerUse
   permission-required   →  权限缺失    amber      跳设置页 computerUse
   ready                 →  已启用      green      跳设置页 computerUse
   error                 →  错误        red        跳设置页 computerUse
   ────────────────────────────────────────────────────────────────
   session-busy ── 可交互性覆盖，不改底层态 ──→ 置灰 + 禁用 tooltip + 不响应点击
```

### 点击行为（2026-08-20 变更）

原设计只让 `plugin-disabled` 与 `permission-required` 可点，`starting` / `ready` / `error`
三态是纯状态灯（PRD §3 编号 6）。落地后的实际体感是坏的：用户按引导走完 TCC 授权、按钮转绿之后
再点，界面毫无反应——一个长得像按钮、hover 有 tooltip、却对点击零响应的控件，用户只会理解成故障，
而不是「本状态设计上无动作」。

现改为**可见即可点，一律跳设置页 `computerUse` 区**，唯一例外是 session-busy 覆盖
（那时按钮已置灰并换成「会话进行中」tooltip，再允许跳转会与视觉表现自相矛盾）。

这样做的依据是目的地本身：设置页 `computerUse` 区在任何一个状态下都有用户可做的事——插件总开关、
mac 权限行与授权按钮、错误详情、以及「在输入框显示电脑操作按钮」开关。就绪态点进去能关；
错误态点进去能看到原因；启用中点进去能看到插件行同步在转。不存在「跳过去无事可做」的状态，
因此白名单没有保留价值。实现上直接删掉 `CLICKABLE_STATES`，`clickAction` 由
`interactionDisabled` 单独决定。

### 各内部态的判定来源（实现契约）

| 内部态                | 判定条件                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting`            | `togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID`（优先级最高，压过下面所有态）                                                                                                                                                                                                                                                                           |
| `error`               | ①`pluginManagementStore.error` 非空且本次操作目标是 zcode-cua（归属由 store 的 `lastFailedPluginId` 记录：带 pluginId 的操作失败写该 id，marketplace/validate/load 等无插件目标的失败写 null——CR-01，防止共享 error 把无关失败误映射为按钮错误态）；或 ②mac 下插件已启用但 Helper 状态 `!isCuaPermissionStatusAvailable(status)`（Helper 启动失败／不健康） |
| ~~`plugin-disabled`~~ | ~~`cuaPlugin?.enabled !== true`~~ ——2026-09-11 删除：未启用不再是 UI 态，而是被插件门挡在渲染之外                                                                                                                                                                                                                                                           |
| `permission-required` | mac + 插件已启用 + Helper 状态可用 + `!isCuaPermissionTccGranted(status)`                                                                                                                                                                                                                                                                                   |
| `ready`               | 插件已启用，且（Windows）或（mac 且 `isCuaPermissionTccGranted(status)`）                                                                                                                                                                                                                                                                                   |

优先级自上而下短路。权限状态尚未首次返回（`status === null`，冷启动窗口）时按 `starting`
处理而非 `error`——避免刚打开窗口就闪一下红点。

### 平台差异

- **macOS**：需权限实测。②整路参与判定。
- **Windows**：无 TCC，②整路跳过；`plugin.enabled === true` 即 `ready`。
- 与 `ComputerUseSection` 的既有平台判定完全同源，复用
  `supportsLocalMacCuaPermissionOnboarding` / `IS_MACOS_DESKTOP`（`lib/cuaPlatform.ts`）与
  `isRemoteWorkspaceIdentity`，不新写平台判据。

### session-busy 的语义边界

它是「可交互性覆盖」，不是第 6 个 UI 态，也不改底层状态：全部 turn 结束后自动恢复原状态与原
状态点颜色。当前 pane 用 `snapshot.control.canStop` 作为最低延迟权威；workspace 级回退同时检查
runtime running、`activeInputId` 和 visible task index 的 `running` 状态，避免任一投影短暂回到
ready 时错误解锁。判定粒度是 **workspace**（不是单 task）——切换插件启用态会让该 workspace
全部会话的工具集变化、prompt 缓存失效，影响面与禁用面必须一致。

输入框停止按钮不受此禁用影响（走既有停止控制链路），否则运行中任务将无法中止。

### 权限查询的开销约束

> 2026-08-19 重写：本节原先描述的是「1s 起、每实例独立 timer 的指数退避轮询，全 granted 后
> 降到 10s」，并要求 composer 传更长的起始间隔。轮询已整体删除，下文是现行架构。

`useCuaPermissionStatus` 不再有任何常态计时器。状态存放在 `lib/cuaPermissionStatusStore`
的进程内共享缓存（按 workspace 分槽），设置页与输入框入口读同一份，因此不会各查一次，
也不会显示成不同结果。刷新是**事件驱动的三个时机**：

1. 挂载（进入设置页 / 输入框入口首次渲染）；先后挂载时后者用 `ensure` 搭上前者在飞的查询；
2. 窗口重获焦点（用户刚从 macOS 系统设置授权完切回来）；
3. 调用方显式 `refresh`（插件开关、Helper 重启、授权返回恢复链）。

删轮询的动因不只是 RPC 开销：每轮查询开始都要把 `fresh` 置回 false，设置页授权按钮的文案
就会在「打开系统设置」与「验证中…」之间反复横跳、宽度随之跳变。展示因此改跟 `settled`
（有可展示内容即成立、只升不降），`fresh` 只用于决策类判断。

**唯一的计时器**是瞬态收敛：Helper 冷启动 / 插件刚启用后的 recreate 期间，main 侧
`getStatus` 会如实返回 unavailable。若把这种样本当终态，入口会红点且 error 不可点击，
用户停在应用内无自愈路径。故对「结果 unavailable 或查询 reject」按
`TRANSIENT_RETRY_DELAYS_MS`（1s/2s/4s）有界退避重试，重试期间不发布该样本、保留上一状态；
额度用尽后 unavailable 如实发布错误态，reject 则保留 lastKnown 等下一次真实事件。
稳态下零计时器。

仍然保留的门控：**仅在 `cuaPlugin.enabled === true` 且 mac 平台时才查询**。理由是未启用态的
UI 呈现与权限无关（原为一律「未启用」灰点；2026-09-11 起干脆不渲染），拉权限没有信息增益。
这条约束有对应单测（见「测试」），防止后续重构无意中把查询提到门控之外。

## 组件与文件划分

| 文件                                                       | 职责                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/lib/cuaComposerEntryState.ts`（新）       | 纯函数 `resolveCuaComposerEntryView(inputs)` → `{ visible: false }` 或 `{ visible: true, uiState, tone, spinning, tooltipMessageId, clickAction, interactionDisabled }`。零 React / 零 store 依赖 |
| `packages/ui/src/hooks/useCuaComposerEntry.ts`（新）       | 编排 hook：汇聚三路数据源、按 enabled 门控权限查询、调用上述纯函数                                                                                                                                |
| `packages/ui/src/v4/composer/V4ComposerCuaEntry.tsx`（新） | 两层组件：外层平台门 + 内层展示（见下）                                                                                                                                                           |
| `packages/ui/src/lib/cuaPlatform.ts`（改）                 | 平台判定由模块级常量改惰性函数，并新增 Windows 门                                                                                                                                                 |
| `packages/ui/src/v4/ConversationComposer.tsx`（改）        | `leadingActionsNode` 内 `V4ComposerModeSwitch` 之后插入                                                                                                                                           |
| `packages/ui/src/settings/ComputerUseSection.tsx`（改）    | 总开关卡片内加「在输入框显示电脑操作按钮」行                                                                                                                                                      |
| `packages/shared/src/protocol.ts`（改）                    | `AppSettings` 加 `computerUseComposerEntryHidden?: boolean`                                                                                                                                       |
| `packages/shared/src/validationAppSettings.ts`（改）       | 同步校验                                                                                                                                                                                          |
| `packages/shared/src/test-ids.ts`（改）                    | 加 `TID_V4_COMPOSER_CUA_ENTRY`                                                                                                                                                                    |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`（改）      | 新增文案                                                                                                                                                                                          |

把状态推导抽成零依赖纯函数是本设计的核心：状态组合空间大（平台 × 隐藏开关 × 插件态 × 权限态 ×
busy），只有纯函数才能把这个矩阵完整测出来，而不必为每个组合搭一套 store mock。

### 组件为什么拆两层

`V4ComposerCuaEntry` 外层只调 `useOptionalPlatform` / `useOptionalServices` 判平台门，不过就直接
返回 null；内层 `V4ComposerCuaEntryMounted` 才调用 `useCuaComposerEntry`。两个理由：

1. **语义**：平台门不过时不建立 settings 订阅、不读插件 store、不发起权限查询，比在内层判完再
   返回 null 更彻底地兑现「不可见就不该有任何后台开销」。
2. **健壮性**（实现时实测撞到）：composer 会在没有 `PlatformProvider` / `ServiceProvider` 的宿主
   里渲染——既有的 3 个 composer 组件测试就是这样。内层用的 `usePlatform` / `useServices` 在缺
   provider 时会抛异常，把整个 composer 拖崩（首次接线时打挂了 22 个既有测试）。外层用 optional
   变体判定，缺失即静默降级为不渲染。

同理 hook 内的 tab store 用 `useOptionalTabStore`：缺 provider 时 `openSettingsTab` 退化为 noop，
按钮仍可渲染与 hover，只是点击不跳转，而不是整棵树崩掉。

### 平台判定改为惰性函数

`cuaPlatform.ts` 原来的 `IS_MACOS_DESKTOP` 是模块级常量，在 import 时求值。这让按 UA 分平台的
单测无法在同一进程内覆盖多平台（改 `navigator.userAgent` 对已求值的常量无效）。改成
`isMacOsDesktopUserAgent()` / `isWindowsDesktopUserAgent()` 惰性函数，运行时行为等价——真实环境
里 UA 不会中途变化。Windows 门的 capability 判据用 `executeDesktopCommand`（desktop-only 注入），
不用 `openCuaPermissionOnboarding`——Windows 无 TCC，本就没有那个方法。

### 视觉规范

遵循 `DESIGN.md`：

- trigger 在 Draft 与已有会话、桌面与手机 Web 中使用同一套判定：由工具栏唯一布局 owner 按真实可用宽度，累积执行以下七档压缩，每档空间够用即停止，不存在的控件跳过：
  1. Computer Use 收成 28px 正方形图标按钮。
  2. mode 收成 28px 正方形，Plan、think 与供应商保留文字。
  3. Plan 收成 28px 正方形，think 与供应商继续保留文字。
  4. think 收起文字与下拉箭头，保留图标＋小绿条；供应商和模型名称继续完整显示。
  5. 隐藏 provider-text，think 保留小绿条，模型名称继续完整显示。
  6. think 去掉小绿条，收成 28px 正方形，模型名称仍完整显示。
  7. model 收成 28px 正方形图标按钮。不存在先省略模型文字或低于 80px 再切图标的额外档位。
- 不再使用容器宽度断点提前隐藏上述文案；空间足够时完整展示模型及供应商名称，不预先以 256px 截断。两组之间固定保留 12px 间距，发送按钮保持可用，禁止换行。图标按钮保留原操作、Tooltip 和无障碍名称。
- think 的档位逻辑保持：进度按配置顺序计算，关闭项／无效值为零；文字收起时 Tooltip 显示当前档位（禁用原因优先），单档只读、多档选择的语义不变。仅 composer 改为以上三种展示形态，其他调用方保留原有响应式逻辑。
- 空间恢复时从完整布局重新裁决，逆序恢复：先恢复模型名称，再恢复 think 小绿条，再恢复供应商，再恢复 think 文字，再恢复 Plan 文字，再恢复 mode 文字，最后恢复 Computer Use 文字。Computer 晚出现、模型／语言变更和窗口缩放均重新测量；开启或关闭系统减少动画时，供应商与模型保持同一文字行，不允许因 DOM 层级变化分行或上下裁切。
- 验收：逐步缩窄／放宽工具栏，检查七档顺序，每档独立收起／恢复，尤其验证 think 小绿条与供应商、think 正方形与模型正方形不被合并为同一档、缺少 Plan／Computer／think 时跳过、多档／单档 think、长供应商和长模型、中英文、桌面／手机、深浅主题、普通／减少动画。检查小绿条真实可见、档位高度正确，所有控件保留原操作能力。

  ```text
  尺寸或内容变化 → 工具栏唯一布局 owner → 测量完整按钮
    → Computer Use 正方形
    → mode 正方形（Plan、think 与供应商文字保留）
    → Plan 正方形（think 与供应商文字保留）
    → think 小绿条（供应商保留）
    → 隐藏 provider-text（think 小绿条保留）
    → think 正方形（小绿条隐藏，模型名称保留）
    → model 正方形
    （每档测量，够用即停；放宽时从完整布局重算，逆序恢复）
  ```

- 状态指示使用紧凑圆点，作为正常 flex 子项放在按钮内容右侧，不使用绝对定位；文字收起时圆点
  仍紧跟图标显示。
  状态颜色仍完整表达未启用/启用中、权限缺失、就绪和错误；启用中以轻量脉冲表示瞬态。
- 字号只用 `text-ui-*`（DESIGN.md 最高优先级约束）
- 状态圆点沿用状态机的 `subtle/green/amber/red` tone，并映射为语义背景色；未启用/启用中使用
  次要前景色，权限缺失、就绪、错误分别使用 warning、success、destructive，`spinning` 在圆点上
  映射为脉冲动效。设置页既有 `StatusDot` 不受影响。
- **不强亮**：默认态与 toolbar 其它控件同视觉权重，避免在不可用场景误导用户

## 设置页开关

- 字段 `AppSettings.computerUseComposerEntryHidden?: boolean`
- 取 `hidden` 语义而非 `visible`：`undefined` 即默认显示，老用户无需数据迁移
- 读走 `useSettings()`（共享 snapshot + 跨窗口广播），写走 `services.settingService.update()`
- 该标记是持久化的，重启与版本更新都不会自愈，仅能在设置页重新开启（PRD §4.1）
- 隐藏入口不影响进行中的任务

## 文案（PRD §6.1 / §6.4 原文）

| message id                                       | 中文                                                                 | English                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `chat.toolbar.computerUse.label`                 | 电脑操作                                                             | Computer Use                                                                                             |
| ~~`…tooltip.disabled`~~                          | ~~体验电脑操作 · 让 ZCode 直接操作你的电脑~~（2026-09-11 删除）      | ~~Try Computer Use — let ZCode operate your computer~~                                                   |
| `…tooltip.starting`                              | 正在启用电脑操作插件…                                                | Enabling Computer Use plugin…                                                                            |
| `…tooltip.ready`                                 | 电脑操作已就绪 · 直接描述你想让 ZCode 做的事                         | Computer Use ready — just describe what you want ZCode to do                                             |
| `…tooltip.permissionRequired`                    | 缺少 macOS 权限，点击完成授权                                        | Missing macOS permissions — click to grant                                                               |
| `…tooltip.error`                                 | 电脑操作启用失败 · 重启 ZCode 应用后重试，或让 ZCode 排查日志        | Computer Use enablement failed. Please restart ZCode app and retry, or ask ZCode to investigate the logs |
| `…tooltip.sessionBusy`                           | 会话进行中，暂不能切换电脑操作；任务结束后可再试                     | A conversation is running. Computer Use can't be toggled right now — try again after it finishes.        |
| `settings.computerUse.composerEntry.label`       | 在输入框显示电脑操作按钮                                             | Show Computer Use button in the composer                                                                 |
| `settings.computerUse.composerEntry.description` | 关闭后输入框不再显示电脑操作按钮，也不会自动恢复；可随时在此重新开启 | When off, the composer button is hidden and stays hidden until you turn this back on.                    |

PRD §6.1 对「启用中」打了删除线，但 §3 编号 2 的状态清单仍保留该态。本设计保留这条文案：
删除线理解为「不作为独立的引导落点」，而非「不给用户任何提示」——toggling 是真实中间态，
期间无提示会让用户以为点击没生效。（该态原先亦不可点击，2026-08-20 起与其余可见态一致跳设置页。）

## 测试

按 AGENTS.md「先写测试再写代码」：

1. **`cuaComposerEntryState.test.ts`（主力，23 例）**：状态推导矩阵。平台（mac/win/其它）×
   隐藏开关 × 插件态（disabled/toggling/enabled/error）× 权限态（granted/denied/stale/探针未过/
   unavailable/未返回）× busy，逐组合断言 `{visible, uiState, tone, spinning, tooltipMessageId,
clickAction, interactionDisabled}`；其中一例遍历全 5 态锁住「除 session-busy 外都可点击」，
   防止可点态白名单被重新引入
2. **`useCuaComposerEntry.test.ts`**：接线事实。核心是「插件未启用 / 列表未加载 / 被设置页
   隐藏时都不发起权限查询」这条开销约束，外加远程 workspace 与远程 session 不渲染、点击跳转，
   并分别锁定 canStop、runtime active input、task index running 的加锁及 terminal task index 的解锁
3. **`v4ComposerCuaEntry.test.ts`（7 例）**：展示层对 view 的忠实映射——不可见不渲染、data 属性、
   tooltip 跟随、`clickAction` 决定是否触发 onActivate、禁用态不响应点击但保留可 hover 的 DOM，
   以及 Computer Use 的
   `@2xl/composer` 响应式边界
4. **`computerUseComposerEntrySetting.test.ts`（5 例）**：设置页开关的默认显示、写 true/false、
   写失败回滚

**不加 E2E**：按钮真值依赖 macOS TCC 与 Helper 进程状态，CI 容器内跑不出有意义的断言，只能验证
「不渲染」这一种平凡情况。等 `capability-changed` 与额度链路落地、行为可在容器内构造后再评估。

## 多端影响面

- **桌面 mac/win 本地 workspace**：新增按钮，主链路
- **桌面远程 workspace（SSH/WSL/Docker）**：`isRemoteWorkspaceIdentity` 命中 → 不渲染
- **手机 `/remote`**：远控保护约束 → 不渲染
- **普通 Web**：平台门不过 → 不渲染
- **linux 本地**：产品 Host 未接通 → 不渲染

不触碰 session / task realtime 消息流，不涉及 `clientMode` / `deliveryKind` 边界，不改
owner / lease / snapshot 链路。②数据源是既有的 host RPC 只读查询，③是 renderer 本地 store 读。

## 2026-09-11 变更：电脑控制默认关闭

产品决策把电脑控制（CUA）从「首启默认开启」回退为「默认关闭，用户在设置页显式开启」。
本设计里受影响的三处：

1. **插件默认态**：`official-plugin-definitions.ts` 不再给 computer-use 声明 `defaultEnabled`，
   `packages/shared/src/plugin-marketplaces.ts` 的默认启用名单同步移除该条目（bootstrap 单测
   机械对照两份名单）。判定式是 `enabledPlugins[id] ?? defaultEnabled`，因此曾在设置页手动开过
   的用户已落盘显式 `true`，不受影响；从未切换过的用户变为关闭。

2. **可见性门加插件门**：未启用即不渲染按钮，不再渲染成灰点拉新入口。默认关闭的语义下，那个
   灰点等于给每个新用户摆一个常驻推广位；而且用户在设置页关掉电脑控制后按钮仍在，读起来像没关
   干净。例外是 `pluginToggling`：切换中 `pluginEnabled` 仍是切换前的旧值，一并挡掉会让「启用中」
   的 spinner 变成空档。

3. **`plugin-disabled` / 「未启用」UI 态删除**：加门后该态不可达（唯一能过门的未启用组合是
   toggling，而 toggling 优先返回 `starting`），连同 `chat.toolbar.computerUse.tooltip.disabled`
   文案一并移除，避免留下不可达分支与孤立文案。对外 UI 态从 5 个降为 4 个。

附带的设置页调整：电脑控制关闭时，「在输入框显示电脑操作按钮」开关置灰，描述换为
`settings.computerUse.composerEntry.requiresEnabled`（「需先开启电脑控制…」）。否则它是一个
可点、可写、但按钮永远不出现的开关，用户只会认为开关坏了。
