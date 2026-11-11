# Context Usage Breakdown Bar

## 背景

Context usage 弹窗目前只展示总 used / size 和缓存命中率。Agent 已经能在 `context_usage_snapshot` 调试日志里按来源统计上下文字符量，但 UI 链路没有收到这些来源数据，用户无法在每轮请求后直观看到上下文主要由哪些内容组成。

## 目标

- 在 context usage 弹窗中复用 header 里的 context used 进度条，把已用部分按来源切分。
- 比例使用各来源 `chars` 计算，只展示百分比，不展示具体字符数或 token 数。
- 来源至少覆盖：Messages、System prompt、Other、Skills、Tool prompt、System tools、MCP tools；其中 Other 对应 agent 内部 `meta_user_context`，避免在 UI 暴露难理解的“meta user”概念。
- 字段必须是 optional。旧 agent、旧快照或没有 breakdown 的请求继续只展示现有总量和缓存命中率。
- 桌面端 `desktop-continuous` 与手机端 `web-remote-replayable` 只透传同一个 usage payload，不改变 snapshot、stream、queue、owner 或恢复语义。

## 数据流

1. Agent runtime 在主模型请求前基于实际请求 options 生成 context usage snapshot。
2. 从 snapshot 的 `categories` 中取 `{ source, chars }`，过滤非法或 0 值后作为 `contextUsageBreakdown` 放入 `ModelComplete` payload。
3. App/service 兼容层把 `contextUsageBreakdown` 映射到旧 task stream 的 `usage_update.breakdown`。
4. UI store、runtime snapshot 和 replay projection 保留该 optional 字段。
5. `ChatContextUsage` 用 `breakdown[].chars / sum(chars)` 计算分段宽度和 legend 百分比，并按占比降序分配颜色：占比越高颜色越深。
6. 终态或恢复 snapshot 如果只带 `used/size/cache` 而缺少 breakdown，且 `used/size` 与当前 live usage 一致，UI 必须保留 live `usage_update.breakdown`，避免 task_complete 后的 snapshot 对齐把比例条抹掉。

## UI 规则

- Header 里的 used progress 已用部分直接切分为来源分段，不在 body 里额外绘制第二条比例条。
- 分段使用 context breakdown 专用蓝色阶 token，接近参考 UI 的低饱和蓝色分段，不复用全局 usage chart 的彩虹色板；颜色按当前排序分配，最大占比使用最深色。
- legend 使用紧凑行布局，支持中英文和移动 Web 窄宽度，不展示 char/token 原始数量。
- 没有 breakdown 或总字符数为 0 时，header 进度条回退为普通单色 used fill，不影响压缩按钮和缓存命中率。
- cache hit rate 保持现有展示逻辑。

## 非目标

- 不修改 context window used / size 的 token 来源和计算方式。
- 不把调试日志里的工具/技能明细全部暴露给 UI。
- 不为桌面 busy queue 或手机 replayable queue 新增排序语义。

## 与 Context 组成的关系

分段条的 `{source, chars}` 是 [Context 组成](../../../apps/zcode-cli/docs/design/v2/model/context-composition.md) 细类别的粗投影，两者来自同一份分解。

- 线格式的 7 个 `source` 值保持不变。细类别（提醒、页面工具、延迟加载工具、压缩摘要）只出现在 Context 组成的查询结果里，按该文 §3.1 的表投影回这 7 个值。
- 修掉漏算后，提醒（环境、模式、子代理列表等）计入「其他」（`meta_user_context`），延迟加载工具只按名字与描述计。分段比例会更准，图例与颜色规则不变。
