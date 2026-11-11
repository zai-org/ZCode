# Populated task list 视觉还原修复记录

## 背景

- 日期：2026-07-23
- 设计状态名：`Automations - Task list all`
- 影响范围：桌面端 Automations 主视图的 populated `All` 状态

修复前已通过隔离 Electron mock 环境创建一条 Idle-time task 和一条 Scheduled task，
并在 1440×960 CSS 视口下与目标 Figma 节点逐项对照。运行态证据显示两类任务使用了
两个独立栅格，Keep-awake 位于任务之后，页头非选中 tab 和创建按钮样式也与设计稿不同。

## 根因

1. `OffPeakTaskList` 和 Scheduled task 列表分别拥有自己的两列 grid。即使父级同时展示两类
   任务，它们也会各自从新行开始，无法组成设计稿中的同一行。
2. Scheduled task 区域无条件渲染 `Task created` 标题，混合 `All` 状态因此多出一个设计稿
   不存在的分区层级。
3. Keep-awake 被放在任务列表之后；列表态没有单独表达“控制条优先、任务随后”的阅读顺序。
4. populated action row 复用了默认主按钮和 ghost tab，未选择 Figma 对应的 outline action
   与 surface pill 外观。

## 修复

- `All` 同时存在 Idle-time 与 Scheduled task 时，由父级建立统一的两列栅格：
  - 桌面两列，移动断点前单列；
  - 固定 132px 行高；
  - 横纵间距均为 16px；
  - Idle-time 卡片在前，Scheduled 卡片紧随其后。
- 混合态通过 `display: contents` 移除两类子列表多余的布局盒，保留卡片组件、菜单、键盘交互
  和各自的数据语义。
- 混合态隐藏 `Task created` 标题；单类型列表仍保留原有标题和列表结构。
- populated 状态把 Keep-awake 放到任务栅格之前，并把 action row 到横幅的间距收敛为 16px；
  空态仍保持“大空卡 → Keep-awake”的既有顺序。
- populated action row 中：
  - 未选中 tab 保留 surface pill；
  - `Create via chat` 使用 outline 外观；
  - `Idle-time task` 继续使用主按钮。

## 边界

- 手机 `/remote` 不承载 Automations，本次没有改变 remote 路由和 realtime 语义。
- Scheduled-only、Idle-only、空态和远程 workspace 的显示条件保持不变。
- 本次只修复审计中的高、中等级问题；内容列水平偏移、侧栏信息架构和 Keep-awake 品牌色等
  低等级项不在本次范围。

## 验证

- `packages/ui/test/automationsPopulatedListFidelity.test.ts`
  - populated Keep-awake 位于任务栅格之前，且间距契约正确；
  - 混合 `All` 共享 grid；
  - 混合态隐藏额外标题；
  - tab pill 与 outline action 样式。
- 隔离 Electron mock E2E（1440×960 CSS 视口）：
  - Idle-time 与 Scheduled 卡片顶部均为 `273px`，宽度均为 `393px`，列间距为 `16px`；
  - Keep-awake 位于 `213–257px`，完整处于任务栅格之前；
  - 统一栅格计算列为 `393px 393px`，且未渲染 `Task created`。
- 仓库机械门禁：
  - `pnpm typecheck`
  - `pnpm lint`
