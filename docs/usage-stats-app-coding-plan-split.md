# 使用统计 App Usage / Coding Plan 拆分

## 数据保留

应用用量的 `model_usage`、`turn_usage`、`tool_usage` 永久保留，不再按 30 天自动清理。
写入、更新、启动和查询都不按记录年龄删除数据。全量概览读取全部留存数据；7 天 / 30 天
仅限制查询范围。既有主动删除会话或清空数据行为不变。无需数据库迁移，已被旧版本清理的数据无法恢复。
CLI 契约与验收见 [Usage Observability](../apps/zcode-cli/docs/design/v2/usage-observability.md)。

## 目标

设置页「使用统计」分为两条独立链路：

- App Usage：只读取本地 session 历史，展示产品内使用活跃度。
- Coding Plan：只读取当前选中的 Coding Plan provider，展示套餐额度与 monitor 用量。

Coding Plan 不回退到 App Usage、本地 session、普通 Z.AI/BigModel API Key 或环境变量 key。

## 顶部布局

```text
使用统计    [ App Usage | Coding Plan | Project A | Project B ]
App Usage:  [ all-time summary ] [ 30d / 7d ]
Coding Plan:                         [ today / 7d / 30d ]
```

- 主 tab 展开账号级统计来源：`App Usage`、个人 Coding Plan、以及每个已订阅 Team Plan 项目。
- Coding Plan tab 不再跟随当前 workspace 连接方式；API Key、Start Plan 或 Team Plan 的当前选择不会隐藏账号已拥有的个人 / 团队用量来源。
- App Usage 的全量概览固定展示在时间范围控件上方。
- Coding Plan 的时间范围保持 `today` / `7d` / `30d`，不使用 App Usage 的全量概览口径。

## App Usage

```text
[ 累计 Token 数 ] [ 峰值 Token 数 ] [ 最长聊天时长 ] [ 当前连续天数 ] [ 最长连续天数 ]

中文摘要指标中的紧凑 Token 数值需在数字与单位之间保留一个空格（例如 `3.7 亿`），与时长、天数指标的单位间距保持一致；其他强调紧凑展示的 Token 场景不受此规则影响。
  // 固定读取当前 usage DB 保留范围内的全量数据，不受下方时间范围切换影响。

[ Token Activity / Calendar Grid ]                  [ Daily / Weekly / Cumulative ]
  // independent range control, reads range=all, first row is Sunday, bottom row shows month labels.
  // Daily: one cell is one day. Weekly: one column is that week's total. Cumulative: one column is total through that week.

[ Time range: 7d / 30d ]

[ Daily Token Trend Chart ]

[ Model Usage Pie Chart ]
  donut chart                                model name + tokens + percent
```

- 趋势图的绘图区左右各保留 24px 安全区，确保首尾日期刻度在桌面端和手机 Web 端都完整显示，不被 SVG 边界裁切；下方时间范围 tabs 使用 pill 样式，尺寸对齐 task tabs。
- 全量概览行位于时间范围控件上方，使用 `range=all` 的 App Usage snapshot；它只展示聚合指标，不改变下方 7d/30d 的图表窗口。
- 全量概览行不使用外框，容器使用 `rounded-xl`；桌面横排时用独立 `w-px h-7` 竖线分隔指标，不使用 border 类分割。
- Token 活动位于全量概览下方，使用独立的 `每日 / 每周 / 累计` 范围切换；它读取 `range=all` 的 heatmap 数据，不受下方 `最近 7 天 / 最近 30 天` 图表范围影响。
- Token 活动网格固定展示最近 52 个自然周，统一按自然周对齐，第一行是周日；52 列等分容器且不横向滚动，底部显示月份。`每周` 模式按周总量从下往上填充整列，`累计` 模式按截至当周的累计 Token 从下往上填充整列；这两个模式 hover 任意格时高亮整列，tooltip 锚定整列容器。tooltip 使用两行结构，第一行展示日期/周范围，第二行展示 Token 数和消息轮数。
- `最长聊天时长` 按同一 session 内已完成 turn 的 `duration_ms` 求和后取最大值，避免把单轮耗时误当成整段聊天时长。

数据来源：本地 session repo 聚合。

## Coding Plan

```text
[ Z.AI | BigModel ]   // 仅两个 Coding Plan 账号都可用时显示

[ 5 小时剩余额度 ]      [ 每周剩余额度 ]        [ 工具调用 ]
  remaining percent      remaining percent     remaining percent
  remaining progress     remaining progress    remaining progress
  重置时间（仅 Usage stats 设置页统一展示月日+时间，例如“9月16日 23:00”；缺 nextResetTime 时不展示）

设置页 Model Providers 里的 Coding Plan 状态卡也展示同一组 quota 剩余额度。三条进度条必须按顺序复用 usage chart 色板：

- 5 小时额度：`--color-usage-chart-1`
- 每周额度：`--color-usage-chart-2`
- 工具调用（月度）：`--color-usage-chart-3`
- ZCode MCP 每日额度：`--color-usage-chart-5`（图表色板暖黄色）

Start Plan 余额卡保持成功态绿色，不跟随 Coding Plan 多色 quota 色板。

模型用量
[ Token 消耗总量 ] [ Top Model 1 ] [ Top Model 2 ] [ Top Model 3 ... ]
[ Multi-line Model Usage Chart ]

工具用量
[ 联网搜索 MCP ] [ 网页读取 MCP ] [ 开源仓库 MCP ... ]
[ Multi-line Tool Usage Chart ]
```

数据来源：

- quota：套餐额度卡。`percentage` 是服务端返回的已用比例，前端必须反转为剩余额度百分比展示。
- `/api/monitor/usage/model-usage`：模型用量趋势与汇总。
- `/api/monitor/usage/tool-usage`：工具用量趋势与汇总。

只使用 monitor 新字段：`x_time`、`granularity`、`modelDataList`、`modelSummaryList`、`toolDataList`、`toolSummaryList`。

## Provider / Source 规则

可用 Coding Plan provider 必须满足：

- provider id 为 `zaiCodingPlan` 或 `bigmodelCodingPlan`。
- provider enabled。
- provider apiKey 非空。

- 个人 Coding Plan 来源来自 active entitlement，tab 标签默认为 `Coding Plan`；如果同时存在多个个人来源，可按 provider 名称区分。
- Team Plan 来源来自已订阅企业套餐项目，tab 标签只使用组织名称；缺少组织名称时不使用项目名、组织 / 项目 ID、商品名或 `Team Plan` 兜底。
- Team Plan 请求必须带 `organizationId` / `projectId`，个人 Coding Plan 请求不带团队上下文。
