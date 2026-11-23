# Chat Model Select Menu

> **当前状态**：聊天侧已经迁移到 V4 composer。

## 目标

聊天输入框复用 `ModelConfigSelect`。Composer 合并面板使用 Popover 承载 Provider、普通搜索栏、listbox 模型列表和原生滑杆；其他调用点继续使用 DropdownMenu。

## 当前实现

- `packages/ui/src/ModelConfigSelect.tsx`
  - 非 Composer 调用点使用现有 `DropdownMenu` 组件渲染模型菜单，保持 `bg-menu`、紧凑行高和键盘菜单语义。
  - 多个 provider 时，一级菜单展示 provider；悬停或键盘展开二级菜单后展示该 provider 下的 model。
  - Z.ai / BigModel family 在分组标题展示当前连接方式短徽标，例如 `Start`、`Individual`、`Team`、
    `API`；连接方式徽标使用无边框的弱表面圆形 pill，模型项本身不重复徽标。连接方式只在设置页切换，输入框菜单只消费当前 selection。
  - 只有一个 provider 时，一级菜单直接展示 model 列表，不额外包一层 provider。
  - Composer model 使用 `role="option"` 与 `aria-selected` 表达单选状态；其他调用点使用 `DropdownMenuRadioItem`；受当前运行任务限制的 model 使用禁用语义和锁定提示，不触发切换。
  - 模型配置的输入类型包含任意非 Text 值时，模型名后紧跟本地化的“视觉 / Vision”紧凑徽标。徽标使用轻量圆形 pill：细边框、弱表面背景、`text-ui-xs` 中等字重；徽标属于左侧模型内容，行尾选中对号的位置不变。它只描述 provider registry 中已经声明的输入类型，不承诺当前 adapter 一定能发送相应附件。
  - `Ctrl+M` 只唤起模型菜单，不按顺序循环切换模型；模型切换必须由用户在菜单中明确选择。
  - trigger 文案切换时复用 toolbar rolling label 动效，和 mode / thought level 控件保持一致；系统开启 reduced motion 时直接静态替换。
  - 自定义 provider 的显示身份按 `providerName.trim() || providerId` 解析，与菜单保持一致；名称缺失、空串或纯空白时，trigger 仍生成 `providerId/` 前缀及完整 title。前缀可见性继续由七档压缩决定。内置账号套餐维持只显示模型名的规则。
  - composer trigger 按实际剩余空间执行七档累积压缩：Computer Use 正方形 → mode 正方形 → Plan 正方形 → think 图标＋小绿条 → 隐藏 provider-text → think 正方形（小绿条隐藏）→ model 正方形。每档够用即停，放宽时逆序恢复。模型名称显示时保持完整单行与下拉箭头，最后一档直接改为 28px 的 Lucide `Package` 图标按钮并隐藏箭头，不再额外按宽度阈值省略模型文字。具体规则见 [CUA composer 布局契约](../superpowers/specs/2026-08-18-cua-composer-entry-design.md)。provider 前缀与模型名必须保持结构化节点，不从最终文案按 `/` 切割；按钮 title 与 rolling 动画 key 继续使用完整身份文案。普通与 reduced motion 共用相同的单行容器结构，避免供应商与模型被截断样式分成两行。桌面分屏、普通 Web 和手机 Web 共用此规则。
  - 模型项同样把模型 ID 当作不透明字符串；`openrouter/ox-alpha` 或更多层级的 `/` 不参与能力判定或名称拆分，选择值继续使用完整 ID。
  - 模型切换 pending 时，loading spinner 放在文案后面，避免模型名左侧宽度变化造成视觉跳动。
  - “管理模型”入口继续由调用方控制，只改变承载组件，不改变 settings 导航链路。
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
  - 只负责把聊天 toolbar 的模型分组、锁定状态和切换回调传入 `ModelConfigSelect`。
- `packages/ui/src/v4/ConversationComposer.tsx`
  - 模式、模型、思考深度三个配置 picker 共享 composer-local 的打开状态；任一时刻最多一个
    picker 展开。点击另一个 trigger 时，旧 picker 必须先退出可见状态，后点击的 picker
    保持打开。
  - 关闭旧 picker 的迟到回调只能清理它自己，不能把已经接管的兄弟 picker 一并关闭。
  - picker owner 只在当前 `workspaceKey + sessionId/draft scope` 内有效；scope 切换时必须
    同步清空。`ConversationComposer` React 实例可以跨 task/draft 复用，但打开状态不得跨 scope
    保留或自动弹出。

## 兼容边界

- 桌面端和 Web 端共用同一个 React 组件，菜单交互不引入平台专属逻辑。
- picker 互斥只属于单个 composer 实例，不进入全局 store，也不跨 pane、window 或
  desktop continuous / web-remote replayable 边界同步。
- 手机 Web 端继续避免关闭菜单后强制恢复输入框焦点，防止触控设备拉起系统键盘遮挡菜单；模型 trigger 不保留手机专用的固定宽度、文字截断或 provider 裁剪逻辑，统一依赖 composer 的可用空间裁决。
- ZCode Agent 的 provider 模型菜单按 runtime endpoint format 过滤，当前目录可以包含
  Anthropic-compatible、OpenAI-compatible Chat Completions 和 OpenAI Responses 模型；Bot `/model`
  入口复用同一 provider 能力边界。
- 已有 session 的选择通过 V4 `switchModelConfig` 写 CLI；草稿选择由 `useDraftConfigControl` 写
  `draftConfigRef`、workspace default 和预热 session。远程恢复必须保持 workspaceIdentity /
  remoteSessionId，不经过 legacy task model write。
