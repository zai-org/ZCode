# 本地 TTFT 查询与验收

Status: in-progress

[父合同](ttft-stage-telemetry.md) · [Grafana 看板模板](dashboards/local-ttft.json) · [怎么读一条 Trace](local-ttft-trace-reading.md) · [上线清单](local-ttft-rollout-checklist.md)

本地 OTLP 数据验证与 ARMS 平台验收分别记录。北京 ARMS 项目可查询既有 zcode-cli-agent / zcode-desktop-renderer Trace 和自定义 Metric。2026-09-15 已完成新 service `zcode-local-ttft` 的平台验收：Trace 与 Metric 入库、分位数查询、瀑布关联与诊断口径均核对通过，见[平台验收证据](local-ttft-platform-evidence.json)。仍未完成：控制台界面瀑布目视确认、打包版编译注入写入路径、7 天 Trace / 30 天 Metric 保留及实际费用。

## 接入

沿用 `OTEL_EXPORTER_OTLP_ENDPOINT` 及各 signal 的 endpoint/headers；不要将写入密钥放进看板。灰度由既有 client configs 的 `rendererActionTrace.localTtftEnabled` 布尔值控制，缺省 false，旧 Trace 的 enabled/sampleRatio 不决定新 TTFT 采样。应用本地诊断可设置 `ZCODE_LOCAL_TTFT_ENABLED=1`；不改变旧 Renderer/Agent Trace 抽样。

专用 Metric：`zcode.local_ttft.duration`、`zcode.local_ttft.stage.duration`、`zcode.local_ttft.first_text.duration`，均为毫秒 Histogram，OTLP 使用 DELTA temporality。主样本标签为 provider、model、quality、app_version、os；stage Histogram 再增加固定 stage。provider/model 组合每个 exporter 最多保留 16 种，其余归入 other；每个 instrument 的聚合 cardinality 上限 256。高基数关联只进 Trace。默认体验看板选择 quality=complete，missing/clock_invalid 可单独查询，不能混入完整阶段分布。quality 语义：clock_invalid 只表示检测到时钟异常（负区间、休眠暂停、墙钟漂移超界）；校准缺失或过期只导致跨进程阶段缺失，记为 missing，同进程阶段与总 TTFT 仍可靠。

ARMS 自带业务指标与专用 OTel Histogram 的存储/聚合口径不同，不能把自带 Gauge 的查询公式套过来。[ARMS 指标文档](https://www.alibabacloud.com/help/en/arms/application-monitoring/developer-reference/application-monitoring-metrics)

## PromQL 模板

导入看板后，先在目标 Prometheus 数据源核对实际 OTel → Prometheus 名称。北京租户的 OTel Metric 映射不增加单位后缀（例如 unit=s 的 `zcode.agent.step.duration` 映射为 `zcode_agent_step_duration`），模板据此默认使用 `zcode_local_ttft_duration`。2026-09-15 已用真实新样本核对：新指标同样不带单位后缀，默认名成立；换租户或换 Collector 时通过 `total_metric`/`stage_metric` 修改实际名称。

```promql
histogram_quantile(0.50, sum by (le) (
  sum_over_time(zcode_local_ttft_duration_bucket{quality="complete"}[5m])
))
histogram_quantile(0.95, sum by (le, stage) (
  sum_over_time(zcode_local_ttft_stage_duration_bucket{quality="complete"}[5m])
))
sum by (stage) (
  sum_over_time(zcode_local_ttft_stage_duration_count{quality="complete"}[1h])
)
```

本 exporter 输出 DELTA Histogram。当前 ARMS 自定义时序库保留每次上报的区间值，已观察到同一既有 count 序列 2 → 1 → 1；看板使用 `sum_over_time` 累加区间样本。不要将这些区间值视作累计 Counter 再做 rate/increase。若接入另一个会转为累计 Counter 的 Collector，需改用 rate/increase 并重新验收。

SLS 的 SQL 入口可执行同一 PromQL：

```sql
* | select promql_query('histogram_quantile(0.95, sum by (le,stage) (sum_over_time(zcode_local_ttft_stage_duration_bucket{quality="complete"}[5m])))') from metrics limit 20
```

已验证该 SQL+PromQL 入口能查询现有 `zcode_agent_step_duration_bucket`；不等同于新 TTFT 已入库。[SLS 时序查询语法](https://help.aliyun.com/en/sls/time-metric-data-query-and-analysis-syntax)

总 P95 将第一条查询的 0.50 改为 0.95；阶段 P50 将第二条改为 0.50。每张分位数图都配同范围 count。Histogram 分位数是桶内插值，误差与相邻桶宽有关，不能当精确原始样本分位数；不得相加 P95 或相减不同 Histogram 的 P95。[Prometheus histogram_quantile](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile)

桶边界（ms）：1、5、10、20、50、100、200、500、1000、2000、5000、10000、30000、60000、300000，以及 +Inf。无效区间省略并带质量标记，不填零。`zcode.local_ttft.records` 观察 start、first_output、first_text、no_text、excluded；`zcode.local_ttft.dropped` 区分 Renderer 容量、Main queue_full、invalid、oversized、trace_export。

## 单消息瀑布图

字段单位、span 命名与逐项读法见[怎么读一条 Trace](local-ttft-trace-reading.md)。

Trace service.name 为 `zcode-local-ttft`。以 `observation_id` 精确过滤得到一次发送；其去除连字符后的值就是 trace ID。根 `local_ttft` 的 start/end 使用同一个 Renderer 单调时钟。六个 child span 保留原始区间，ACK 延迟没有混入主阶段。`command_id`/`input_id`/`query_id`、runtime `turn_id`、`product_turn_id`、`logical_call_id` 和 `request_id` 仅用于 Trace 关联；`cli_instance_id` 区分进程。`local_ttft.start`、`local_ttft.first_text` 和 `local_ttft.no_text` 是同一 Trace 的独立检查点，不增加主 TTFT 样本。

时钟校准通过已有 command query RPC 返回 CLI 收发单调 epoch 时间，与 Renderer 往返区间给出 offset/error。最大允许误差 10 ms、有效期 60 秒；发送不等待校准，过期或缺失时明确标记。校准除随传输握手刷新外，Renderer 收到 CLI 检查点或实际内容帧且校准已过期时也会重新探测，保证排队或慢发送在首输出前拥有有效校准；同一在途探测不重复发起。跨进程有效阶段按 interval 对账，缺失阶段不伪装执行过。模型请求只保留整体边界，不猜测服务内部网络、排队、推理拆分。

## 本地复现

TTFT E2E 的 worker 在启动 Electron 前自动启动隔离 OTLP 接收器，监听 loopback 随机端口，最多保留 512 批；当前 worker 的 App/Host/CLI 继承该出口与本地诊断开关，退出时关闭接收器并恢复环境。用例读取同一地址，不依赖预先运行的固定端口服务。执行命令：

```sh
ZCODE_E2E_MANUAL_REVIEW=1 \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-ttft-stages.json \
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/telemetry/conversation-session-ttft-stages.test.ts'
```

手工诊断仍可单独运行 `node packages/desktop/scripts/ttft-otlp-receiver.mjs`，默认监听 localhost:14318，再给手动启动的应用设置 `ZCODE_LOCAL_TTFT_ENABLED=1` 与 `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318`。

该候选用例操作真实 Composer，断言最后收到的 protobuf Trace/Metric。第二场景在唯一的公开 transport seam 注入 250ms 命令延迟与 7s ACK 延迟；模型 fixture 在 250ms 首思考、8s 首正文，检查 root 在 ACK/terminal 之前到达且已知延迟归因正确。fault seam 只在 E2E build 生效，不生成伪造事实。

## 当前平台定位

- region：`cn-beijing`
- project：`arms-project-placeholder`
- Trace：`logstore-tracing`
- Metric：`metricstore-apm-metrics-custom`
- 2026-09-15 完成平台验收：新 service `zcode-local-ttft` 的 Trace 与 Metric 已入库并可查，指标名不带单位后缀（本文默认名成立），DELTA + `sum_over_time` 口径成立，`observation_id` 去连字符等于 traceID，单条发送的六阶段并集与根时长对账一致。实测见[平台验收证据](local-ttft-platform-evidence.json)、部署与剩余步骤见[上线清单](local-ttft-rollout-checklist.md)。控制台界面瀑布目视、保留期与费用仍未核验。
- [本地真实出口证据](local-ttft-evidence.json)保留 3 次发送、6 阶段、8 个 Histogram 的 count/分桶估计与实测误差。

## Ticket 02：排队、准备、重试和未收口

[实施与验收](../issues/ttft-stage-telemetry/02-queued-retry-and-failure-diagnostics.md)。沿用同一 `observation_id` 和 OTLP 出口；`command_id/input_id` 指向原 accepted input，队列编辑/send-now 不换成操作命令。确认弹窗的重试只换已被拒绝的命令绑定，保留首次提交时钟和观察 ID。立即引导归类 `guided`，不记录独立成功 TTFT。

### 统计单位

| Metric                                              | 一份样本表示什么                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `zcode.local_ttft.duration`                         | 一次成功首输出，包含排队和用户确认等待                                         |
| `zcode.local_ttft.execution.duration`               | 已开始执行到实际首输出；只在跨进程对齐可靠时产生                               |
| `zcode.local_ttft.system.duration`                  | 同条消息总 TTFT 扣除已明确的确认等待，不由分位数相减推算                       |
| `zcode.local_ttft.stage.duration`                   | 成功输入的一个主阶段；完整质量确认后各阶段只落一次                             |
| `zcode.local_ttft.preparation.duration`             | 成功输入首输出前一个准备/确认/重试等待区间；重复执行分别计数                   |
| `zcode.local_ttft.stage.observation.duration`       | 已完成的一个主阶段，无须等根收口；含最终无输出输入                             |
| `zcode.local_ttft.preparation.observation.duration` | 已完成的一个准备/确认/重试等待区间，无须等根收口                               |
| `zcode.local_ttft.attempt.duration`                 | 首输出前一个物理 attempt，到失败、完成或首输出；role 区分 response/preparation |
| `zcode.local_ttft.no_output.wait`                   | 首输出前明确 failed/cancelled/rejected/interrupted 的已等待时间                |
| `zcode.local_ttft.records`                          | 一次去重后的生命周期记录；总输入数看 kind=start，不能把所有 kind 相加当消息数  |

`send_mode=idle|queued|guided`；`visibility=foreground|background|background_returned`。默认体验必须加 `visibility="foreground",quality="complete"`，后台、返回前台、时钟不可靠和缺阶段另看诊断视图。**observation 系列的标签是该阶段观察时的状态**，不代表消息最终持续前台，不能用它代替默认体验分布。主 TTFT 在首输出时落样，不为晚到阶段重写或重复总样本；后来补齐的阶段可进入完整阶段分布，Trace 检查点显示更新后的质量。

每张分位数图都同时展示相同过滤/时间窗的 `_count`。准备区间与模型 attempt 是区间观察单位，不能把其数量当作用户输入数量，也不能把并行区间耗时相加当主阶段墙钟耗时。当前仍按 01 已核验租户的 DELTA 时序口径使用 `sum_over_time`。

```promql
# 持续前台：按空闲/排队比较总 P95 和样本数
histogram_quantile(0.95, sum by (le,send_mode) (sum_over_time(zcode_local_ttft_duration_bucket{quality="complete",visibility="foreground"}[5m])))
sum by (send_mode) (sum_over_time(zcode_local_ttft_duration_count{quality="complete",visibility="foreground"}[5m]))
# 准备子阶段 P95 与区间数量
histogram_quantile(0.95, sum by (le,stage) (sum_over_time(zcode_local_ttft_preparation_duration_bucket{quality="complete",visibility="foreground"}[5m])))
sum by (stage) (sum_over_time(zcode_local_ttft_preparation_duration_count{quality="complete",visibility="foreground"}[5m]))
# attempt 的结果与次数；仅 response，不混 compact
sum by (outcome) (sum_over_time(zcode_local_ttft_attempt_duration_count{role="response"}[1h]))
# 首输出前明确失败/取消/拒绝/中断的数量、占所有观察输入的比例
sum by (outcome) (sum_over_time(zcode_local_ttft_records{kind="excluded",outcome=~"failed|cancelled|rejected|interrupted"}[1h]))
sum by (outcome) (sum_over_time(zcode_local_ttft_records{kind="excluded",outcome=~"failed|cancelled|rejected|interrupted"}[1h])) / scalar(sum(sum_over_time(zcode_local_ttft_records{kind="start"}[1h])))
```

分母包含未收口输入，窗口截断会造成开始/结束集合不一致；同批消息的精确结果比例应按 Trace 的 observation_id 关联后计算。不能把 `start - terminal` 的窗口差额解释成超时率。

### 瀑布与未收口

- `local_ttft.start` 在提交时发出；`local_ttft.checkpoint` 在事实变化时导出，根不结束也能查询。`local_ttft.<主阶段>`、`local_ttft.prepare.<子阶段>`、`local_ttft.attempt`、`local_ttft.retry_wait`、`local_ttft.user_confirmation` 使用稳定 Span 身份，各已完成区间只导出一次。
- `.started` 是阶段开始的点记录，`detail_outcome=unclosed`，不是零耗时成功阶段。结束缺失保留开区间；只发 start/部分阶段的 Trace 可能仍运行，也可能已丢失终态。
- `unattributed_ms` 用首输出边界内所有可靠已知区间的**并集**对账；并行只计覆盖一次，缺失阶段不填零，差额不归给网络或模型。`missing_stages`、`truncated`、`clock_source`、`clock_error_ms` 帮助区分缺失、截断和对齐不可靠。
- 无明确结果时，5 分钟观察清理只留下 `unclosed`；已明确 runtime unavailable/退出记录 `interrupted`。强杀不承诺零丢失，不补造 terminal/阶段。首输出后的错误或退出不反转主 TTFT。
- 查询未收口需要在 Trace 中按 observation_id 关联 start 与 first_output/明确 excluded 结果；根缺失不能单凭查询窗口判 failed/timeout。保留期不足或查询窗口没覆盖首次提交时需单独标记窗口截断。

### 时钟、资源及兼容

Renderer 点击总时钟和 CLI 阶段均为各自单调时钟；对齐仍是 RTT/2 ≤10ms、校准有效期60秒，过期后由检查点/内容帧触发重校准。单调与墙钟累计差超过100ms、采样发现超过5秒暂停，会标记不可靠；此前已经可靠完成并导出的同进程阶段仍可独立查询。Renderer 状态由实际窗口 focus/blur/visibility 采集，最多32条变化，后台仍采集。平台不能精确区分睡眠与调试暂停时只标计时异常，不猜原因。

每条最多64个细分区间、6个主阶段；Renderer/CLI 各最多128个在途观察，CLI另保留128份完成事实供帧分发；Renderer缓冲128条，每批32条；Main队列32批、每批256KiB、网络超时3秒。出口按观察身份整组去重：最多1024个观察、每个512个事实身份，5分钟窗口外重传明确丢弃，不逐 key 淘汰后重新产生主样本。`dropped` 区分队列满、窗口/去重容量、传输超时、截断等。灰度内不依赖旧10%采样；上述资源丢弃仍可能损失数据，不能声称零丢失。

每个 exporter 最多16组受控 provider/model，其他归 other；每个 Histogram/Counter 聚合组合上限256。10个 Histogram、2个 Counter，按15个显式桶、+Inf、sum/count估算理论上限约46,592条序列/同资源组；另需检查后端资源标签映射和 overflow 系列。关联ID、requestId、工作区、路径和用户不进入指标标签，实际样本基数见运行证据。扩大灰度前仍须在 ARMS 核实容量、费用及明细7天/聚合30天保留。

只在本地 desktop-continuous attachment 暴露细分通知；remote identity、remoteSessionId 和 web-remote-replayable 无本地 TTFT。新增字段不改变无 ttft 上下文的业务命令与内容，CLI/Renderer 使用同一打包版本的严格遥测 schema；旧业务事件、RUM与 accepted input FIFO 不变。

### 复验

将上方命令中的 spec 和 case-local fixture 换为 `conversation-session-ttft-diagnostics`；仍复用同一个 `ttft-otlp-receiver.mjs`。候选包含真实 user-config Hook（300ms）、HTTP 503→成功回放、HTTP400、队列/确认/引导以及真实窗口最小化/恢复。性能文件在该 run 的 `ttft-diagnostics-performance.json`，只表示测试期间观测值，不是灰度关闭/开启的 A/B 开销结论。macOS受控进程测试使用真实 SIGSTOP/SIGCONT/SIGKILL；Windows跳过信号测试，须另补平台证据。

2026-09-15 平台验收：`conversation-session-ttft-stages`（2 次，各 3/3 通过）与 `conversation-session-ttft-diagnostics`（6/6 通过）共 12 次发送的样本写入北京 ARMS 并全部可查。`records` 按 kind 齐全，`excluded` 区分 cancelled/failed/guided，`attempt` 按 role+outcome 区分失败重试与首输出，`no_output.wait` 与 8 个 `preparation` 子阶段均有样本，默认体验过滤（`quality="complete",visibility="foreground"`）返回 idle 4 条、queued 1 条。明细与聚合在 run 结束时即可查（上界 <5s）。全部返回值见[平台验收证据](local-ttft-platform-evidence.json)。控制台界面瀑布目视、保留与费用配置仍未核验。
