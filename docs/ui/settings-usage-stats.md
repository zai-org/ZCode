# Settings Usage Stats

设置页新增 `Usage` 分区，用来展示本地 session 快照聚合出来的粗略使用统计。

## 数据来源

- host 侧新增 `usage-stats` RPC 服务，统一扫描 `~/.zcode/v2/sessions/**` 下的 task 快照
- UI 不直接读磁盘，只通过 `useUsageStats()` 调服务
- 历史旧数据没有 usage 字段时，读取侧会回退到 `message.content + thought` 的字符数，以及 `task.meta.model`

## 估算口径

- 估算 token 统一按 `字符数 ÷ 3`，除数放在 `ESTIMATED_TOKEN_CHAR_DIVISOR`
- 新写入的消息会额外持久化：
  - `message.model`
  - `message.characterCount`
- 之所以保存原始字符数而不是直接保存 token，是为了后续调整除数时可以重算历史数据

## 当前展示

- 区域圆角：使用概览指标卡、每日 Token 趋势、模型用量分布、Coding Plan 额度卡和共享空状态统一使用 `rounded-xl`，保持主要统计模块的视觉层级一致
- Token 活动：独立提供每日、每周、累计三种范围；每日按天显示，每周按周总量显示，累计按截至当周的累计 Token 显示。范围切换使用 Hooks 范围切换同款 pill tabs，尺寸和字号对齐 task tabs（外层 `h-7`，trigger `h-6`、`text-ui-sm`）；网格固定展示最近 52 个自然周，第一行固定为周日，52 列使用 `minmax(0, 1fr)` 等分容器且不横向滚动，横纵格子间距使用 `gap-0.5`；底部月份文案锚定在每月 1 日所在的周列，最多只显示最后 12 个有效月份文案，多出的起始月份段保留网格占位但文字留空，因此当前年度周期显示为去年 9 月到今年 8 月，后续按年份自然递进；每周和累计 hover 任意格时高亮整列，tooltip 锚定整列；tooltip 使用两行结构，第一行展示日期/周范围，第二行展示 Token 数和消息轮数，容器使用 `rounded-xl`
- 每日 Token 趋势图：默认展示近 7 日，可切换近 30 日；连续补齐空白日期后展示估算 token 折线；X 轴日期刻度在所有平台和宽度下都由 recharts 按实际绘图宽度跳过会重叠的刻度，始终保留首尾日期，不按天数固定步长，也不按平台或断点切换规则；Y 轴上限按实际展示的模型折线单点峰值计算，不使用同日所有模型总量，也不计入未展示模型，避免非堆叠折线被总量范围压缩；Tooltip 顶部总量和每个 Model 的值都使用本地化紧凑 Token 单位（中文万/亿、英文 K/M/B，并带 `tokens`），避免模型明细显示无量纲的长裸数字；Tooltip 数字使用等宽字体保证对齐，`tokens` / `tokens/s` 单位使用 UI Sans 和弱化文字色，不能继承 `font-mono`；下方时间范围 tabs 使用 pill 样式，尺寸对齐 task tabs（外层 `h-7`，trigger `h-6`、`text-ui-sm`）
- Coding Plan 系统健康度：固定展示近 7 日的 Max&Pro / Lite 高峰期平均 Decode 速度，不提供时间范围筛选，也不请求或下发 30 日健康度数据；标题右侧以只读文案标明“近 7 日”。
- Coding Plan 用量趋势：近 7 日 / 近 30 日以及模型 / 工具维度统一使用并排柱状图；新旧数据都展示具体 Model / Tool 勾选列表，最多同时选择 3 项且至少保留 1 项。Models 的 Token 用量在顶部 Total、Model 勾选项、Tooltip Total 和 Tooltip 明细中都必须带 `tokens` 单位；积分模式在上述四处带本地化的“积分 / credits”单位；数字保持等宽字体，单位使用 UI Sans。Tools 调用次数不添加 Token 或积分单位。旧版仅包含 Token / 调用次数的数据同样使用柱状图，不再回退折线图；积分 / 用量指标切换仅在存在积分数据时展示。折线图仅用于下方固定近 7 日的系统健康度。
- 模型用量图：按模型聚合估算 token，以饼图展示占比；超过 6 个分区时合并为“其他模型”，配色复用趋势图的 `--color-usage-chart-*` token；手机端维持 224px 图形高度并纵向排列，桌面端图形区与明细区各占一半，图形高度提升到 256px、最大宽度 288px，并相对右侧明细整体垂直居中，使环形图更充分利用可用空间且不会随宽屏无限放大
- 摘要指标：估算 token、会话数、活跃天数、最常用模型、最长会话、连续活跃天数
