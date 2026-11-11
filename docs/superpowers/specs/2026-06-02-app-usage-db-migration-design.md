# 应用用量改造：数据源迁移到 zcode agent 数据库

日期：2026-06-02
分支：feat/new-agent

> 2026-11-06 更新：本文记录迁移时的历史设计。原 30 天自动清理策略已取消，三张用量表永久保留；
> 7 天 / 30 天只作为查询范围。当前数据保留与展示约定以
> [应用用量规格](../../usage-stats-app-coding-plan-split.md) 和
> [CLI 用量契约](../../../apps/zcode-cli/docs/design/v2/usage-observability.md) 为准。

## 背景与目标

「应用用量」（App Usage）面板当前的数据全部来自**本地 session JSON 文件**
（`~/.zcode/sessions/*.json`），经宿主进程的 `usageStatsAggregator.ts` 用
「字符数 / 3」**估算** token 后聚合成三个区块：概要、热力图、趋势，支持
全部 / 7d / 30d 时间筛选。

zcode agent 新增了可观测性数据库（迁移 `0010_usage_observability`），三张表记录
**真实**用量数据：

- `model_usage` — 真实 token（input / output / reasoning / cache 读写）、provider/model、
  query_source、状态、延迟（duration、TTFT）、重试、错误
- `turn_usage` — 按用户轮次聚合，含工具调用数/错误数、token、延迟
- `tool_usage` — 每次工具调用：工具名、审批状态、只读/破坏性、耗时、输出字节、错误
- 保留期 30 天（`USAGE_RETENTION_DAYS = 30`，超期自动删）

**目标**：把应用用量面板的数据源**全部替换**为 agent 数据库统计，去掉字符估算管线，
并利用新数据补充真实 token 拆分、工具使用统计、可靠性指标。

## 关键决策（已与用户确认）

1. **保留期冲突 → 界面适配 30 天**：时间筛选从 `全部 / 7d / 30d` 改为 `7d / 30d`
   （去掉「全部」）；热力图从 52 周收缩为 30 天。不改数据库保留期。
2. **新增指标范围**：真实 Token 拆分 + 工具使用统计 + 质量/可靠性指标。
   **不做**按 query_source 拆分（主对话/压缩/子 agent/workflow）。
3. **热力图形态 → 30 天日历格**（约 5 列，GitHub 式），每格 = 当天真实 token 总量。
4. **取数路径 → ZCode Protocol**：新增协议方法，由 agent 侧 SQL 聚合后回传。

## 架构与数据流

宿主进程**不直接持有** agent 的 SQLite；agent 是独立子进程，宿主只能通过
ZCode Protocol（stdio JSON-RPC）请求数据（现有 `session/list`、`session/messages` 即此模式）。
聚合放在 **agent 侧（SQL）**，而非把原始行拉回宿主再算 —— 省 stdio 传输、天然带 30 天窗口。

```
旧:  useAppUsageStats → usageStatsService.getAppUsageSnapshot()
        → readPersistedSessionFiles(~/.zcode/sessions/*.json)      [删]
        → buildUsageStatsSnapshot()  字符数/3 估算                 [删]

新:  useAppUsageStats → usageStatsService.getAppUsageSnapshot()
        → zcodeProtocolClient.request("usage/stats", {range,timeZone})   [新协议方法]
        → [agent 子进程] handler → SessionStore 新增 read 方法
        → SQL GROUP BY 聚合 model_usage / turn_usage / tool_usage        [真实数据]
        → 回传 AppUsageSnapshot
```

**备选方案（不采用）**：宿主进程直接只读打开同一个 `default.db` 文件。否决原因：
与 agent 并发访问同一 DB、schema 双份耦合、违反「新代码走 ZCode Protocol」约定。

## 指标变更

### 概要（Summary）

固定 8 张卡。映射如下：

| 旧卡片 | 处理 | 新卡片 | 数据来源 |
|---|---|---|---|
| Token 用量（字符/3 估算） | 换真实 | **真实 Token**（总量，副标拆 输入/输出/缓存） | `model_usage.computed_total_tokens` 等 |
| 消息数 | 删，替换 | **对话轮次** | `turn_usage` 行数 |
| 会话数 | 保留 | 会话数 | distinct `session_id` |
| 活跃天数 | 保留 | 活跃天数 | distinct day(`started_at`) |
| 当前/最长连续 | 合并 | **连续活跃天数**（30 天内） | day(`started_at`) |
| 峰值时段 | 删（移到热力图） | **缓存命中率** | `cache_read / (input + cache_creation + cache_read)` |
| 最常用模型 | 保留 | 最常用模型（按真实 token） | `model_usage` GROUP BY model |
| — | 新增 | **工具调用**（总数 + 错误率） | `tool_usage` |
| — | 新增 | **可靠性**（模型错误率 / 平均 TTFT） | `model_usage.status`、`time_to_first_token_ms` |

> 候选 9 项取 8。默认取舍：保留「连续活跃天数」与「可靠性」，因「工具调用」已在第 4 区块
> 充分展开，概要中可省其一以控制在 8 张；实现时可微调，不影响架构。

### 热力图（Heatmap）

- **删**：52 周日历、基于字符数的 `activityScore`。
- **换**：30 天日历格（约 5 列），每格颜色深浅 = 当天 `computed_total_tokens`；
  tooltip 显示 token / 轮次 / 工具调用数。

### 趋势（Trend）

- **保留**结构（按模型堆叠的每日柱状图），数据换为真实 token（`computed_total_tokens`）。
- 时间筛选去掉「全部」，改 `7d / 30d`；分桶简化（7d 按天，30d 按天）。

### 新增第 4 区块：工具使用（Tool Usage）

- 来自 `tool_usage`，Top 工具排行：调用次数、错误率、平均耗时。
- 横向条形 + 小表格。

## 涉及文件

### Agent 侧（取数 + 聚合）

- `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`
  — `UsageStorePort` 增加只读聚合方法（当前仅有写方法）及结果类型。
- `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`
  — 新增 SQL 聚合查询（GROUP BY day / model / tool，带 30 天 + range 过滤）。
- `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`
  — 代理新读方法。
- `packages/shared/src/zcode-protocol/index.ts`
  — 新协议方法 `usage/stats` + zod 入参/结果 schema，登记到 `zcodeProtocolMethods`。
- agent server 侧 handler（与 `session/list` 同位置）— 处理 `usage/stats`。

### 宿主服务侧（换数据源）

- `packages/services/src/usage-stats/usageStatsService.ts`
  — `getAppUsageSnapshot()` 改走 `zcodeProtocolClient` / `zcodeAgentService`。
- **删除**：`usageStatsAggregator.ts`、`repo/sessionUsageRepo.ts`、`usageStatsSeries.ts`、
  字符估算常量（`ESTIMATED_TOKEN_CHAR_DIVISOR`、`estimateTokensFromCharacterCount` 等）。
- `packages/shared/src/usage-stats.ts`
  — 更新类型：移除字符/估算字段，新增 token 拆分 / 缓存命中 / 工具 / 可靠性字段。

### UI 侧

- `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`
  — 新概要卡集合；range tabs 去掉「全部」（`UsageStatsRange` 改为 `"7d" | "30d"`）。
- `packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx`
  — 热力图改 30 天；新增工具使用区块组件。
- `packages/ui/src/settings/usage-stats/AppUsageDailyModelBarChart.tsx`
  — 真实 token。
- i18n keys 增删（`settings.usage.range.all` 移除等）。

### 不动

- 编程套餐（Coding Plan）整个 tab、BigModel monitor API 那条线保持原样。

## 测试

- **Agent SQL 聚合**：内存 SQLite 灌入已知 `model_usage` / `turn_usage` / `tool_usage` 行，
  断言聚合结果（仿 `repositories/usage.ts` 现有测试）。
- **协议层**：`usage/stats` schema 入参/结果往返校验。
- **宿主服务**：mock 协议客户端，断言 `getAppUsageSnapshot` 字段映射正确。
- **UI**：snapshot 渲染（概要卡 / 30 天热力图 / 趋势 / 工具表）。

## 风险与注意

- 30 天保留期意味着面板永远看不到更早数据；UI 文案应明示「近 30 天」。
- 真实 token 与旧的字符估算不可比，迁移后历史数字会出现「断层」，属预期。
- `turn_usage` 的「轮次」语义与旧「消息数」不同，文案需相应调整。
- agent 未运行 / DB 为空时，面板需有空态与错误态（复用 `UsageStatsErrorNotice`）。
