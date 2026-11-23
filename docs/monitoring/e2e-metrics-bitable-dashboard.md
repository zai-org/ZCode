# E2E Metrics Bitable Dashboard

## 背景

`scripts/ci/push-e2e-metrics-to-bitable.mjs` 将 E2E `summary.json` 写入飞书多维表格 `E2E Test Metrics` 的 `e2e_runs` 表。每次运行写 1 行。一共有四类入口（见 [四类入口](../testing/conversation-session-automatic-e2e-ci.md#四类入口)），用 `run_type` 区分。

## 字段约定

上传脚本写入的字段：

| 字段                                                                                            | 类型   | 来源 / 说明                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_id`                                                                                        | 文本   | `summary.runId`                                                                                                                                                           |
| `run_type`                                                                                      | 单选   | `full-windows` / `full-macos` / `incremental-windows` / `incremental-macos`；规则见 [运行类型](../testing/e2e-failure-artifact-report-upload.md#运行类型)。不能确定时写空 |
| `started_at` / `completed_at`                                                                   | 日期   | summary 起止时间                                                                                                                                                          |
| `duration_s`                                                                                    | 数字   | 墙钟耗时                                                                                                                                                                  |
| `platform`                                                                                      | 文本   | `summary.environment.platform`                                                                                                                                            |
| `windows_version`                                                                               | 文本   | 见下文                                                                                                                                                                    |
| `exit_code`                                                                                     | 数字   | `summary.exitCode`                                                                                                                                                        |
| `total` / `passed` / `failed`                                                                   | 数字   | 按 results 重算，跳过的 case 不计入失败                                                                                                                                   |
| `pass_rate` / `first_time_pass_rate` / `flaky_count`                                            | 数字   | `summary.stability`                                                                                                                                                       |
| `duration_p50_s` / `duration_p95_s` / `queue_time_s`                                            | 数字   | `summary.timing`                                                                                                                                                          |
| `failure_assertion` / `failure_timeout` / `failure_crash` / `failure_infra` / `failure_unknown` | 数字   | 上传前重新分类的失败数                                                                                                                                                    |
| `pipeline_id` / `job_id` / `branch` / `commit_sha`                                              | 文本   | manifest 的 `ci`                                                                                                                                                          |
| `mr_url`                                                                                        | 超链接 | `<CI_PROJECT_URL>/-/merge_requests/<iid>`，显示文字 `!<iid>`；不是 MR pipeline 时写空                                                                                     |
| `report_url`                                                                                    | 超链接 | 报告平台页面，来自 `report-upload.json`（见 [报告地址回写](../testing/e2e-failure-artifact-report-upload.md#报告地址回写)），显示文字 `E2E 报告`；没有时写空              |
| `slowest_cases`                                                                                 | 文本   | 最慢的 5 个 case                                                                                                                                                          |
| `failed_cases`                                                                                  | 文本   | 全部失败 case，每行一条，错误截到 200 字符                                                                                                                                |

`failed_cases` 不限制条数，只限制总长度。飞书单元格超过约 100,000 字符时整条记录会被拒绝（`1254130 TooLargeCell`；2026-11-17 实测 99,609 字符可以写入，100,000 字符被拒，中文与 ASCII 按字符计数相同）。上传脚本把总长度限制在 90,000 字符内，只在条目边界截断，最后一行写“还有 N 条失败 case 未列出，见报告平台”。

超链接字段（`text` 字段的 `url` 样式）通过 bitable v1 接口写入 `{ "link": "<url>", "text": "<显示文字>" }`；写空时不传该字段。

2026-11 删除的字段：`arch`、`node_version`、`electron_version`、`flaky_rate`、`infra_failure_rate`、`infra_failure_count`（与 `failure_infra` 是同一个值）、`mr_iid`（由 `mr_url` 替代）、`started_day_time`（由 `started_at` 替代）。作者统计脚本误建在本表的 11 个空列也已删除，作者统计只写 `E2E 作者统计` 表。

看板依赖一个 Base 公式字段，字段值由历史记录即时计算，不需要推送脚本额外写入：

- `started_day`: `TEXT([started_at], "YYYY-MM-DD")`

原因：看板组件的 `group_by` 没有按天分组的选项，用 `started_at` 分组时每次运行是一个点。总览的“日均 / 日汇总”趋势只能按这个公式字段分组。

Windows 全量 E2E 的十个分片合并成一行记录，由子流水线的汇总 job 写入（见 [Windows 全量入口](../testing/conversation-session-automatic-e2e-ci.md#windows-全量入口子-pipeline-与结果汇总)）；`job_id` 指向汇总 job，计数与比率按合并后的 case 重新计算。

Windows 运行记录额外写入 `windows_version`。产品名由运行机器上的 E2E reporter 用 Node `os.version()` 写入 `manifest.json` 的 `os.description`（如 `Windows 11 Pro`、`Windows Server 2022 Datacenter`），保留真实的 Server / Home / Pro / Enterprise / Education 等产品信息；不随系统 locale 变化（中文系统的 Caption 是 `Windows 11 专业版`）。上传脚本优先读这个值，因此在 Linux 汇总 job 上传也能得到产品名；旧 manifest 没有该字段时，才在同平台本机读取 `Win32_OperatingSystem.Caption`。客户端代际按内核 build 修正（≥ 22000 为 Windows 11），不得仅凭内核 build 推导 Edition；产品描述不可用时只记录原始 Windows build，不补造 `Pro` 等 Edition。

2026-11 起产品名来源从 Caption 改为 `os.version()`：中文系统上的历史行是 `Windows 11 专业版` 这类本地化值，新行是 `Windows 11 Pro`，按该字段分组时两者分开。Windows 全量合并行由各分片分别解析后去重排序，用“空格 / 空格”连接（例如 `Windows 10 Pro / Windows 11 Pro`），表示这次运行用了多台机器。

## 历史数据回填

2026-11 新增字段时回填了已有记录：

- `mr_url`：由 `mr_iid` 与项目地址拼出。
- `run_type`：按 `job_id` 从 GitLab 读取 job 名称推断，并核对 job 所属 pipeline 与记录的 `pipeline_id` 一致。`test:e2e:conversation-session:auto*`（含已删除的带 `macos` tag 的 job、旧的 Windows 分片 job 与汇总 job）为 `full-*`，`test:e2e:mr-changed:*` 为 `incremental-*`，平台取 `platform`。不属于这些入口的 job 保持空：2026-08-28 MR !2416 分支上的临时 job `cua_macos_p0_electron` 写入了 10 行，未合入主线。
- 2026-11-18 删除旧列前，又按同一规则补填了未 rebase 分支用旧代码写入的 12 条记录。删列后，没有 rebase 到新 staging 的 MR 分支仍用旧上报脚本，写入已删除的列会被整条拒绝（不影响 job 结果，记录丢失）；rebase 后恢复。

## 看板分层

当前 Base 内维护三个看板，统一按 `run_type` 过滤，不再按 `platform` 过滤：

- `E2E 测试质量看板`：总览看板，过滤 `run_type` 为 `full-windows` 或 `full-macos`。趋势组件按 `started_day` 聚合；通过率、耗时类指标取 `AVERAGE`，失败数类指标取 `SUM`。
- `E2E 测试质量看板 - macOS`：macOS 专项看板，过滤 `run_type = full-macos`。
- `E2E 测试质量看板 - Windows`：Windows 专项看板，过滤 `run_type = full-windows`。

看板只统计全量运行。增量运行只跑 MR 改动的 spec，通过率与耗时和全量不可比，不进入任何看板，也不单独建看板。

总览看板不保留 macOS / Windows 单独数据或平台对比图；平台数据只放在独立平台看板中。

每个独立平台看板包含：

- 概览指标卡：运行次数、平均通过率、失败数、Assertion 失败、Timeout 失败、Crash 失败、Infra 失败。
- 趋势图：通过率趋势、Case 耗时 P50/P95、Suite 总耗时、失败数趋势。

独立平台看板按 `started_at` 展示每次运行的时间点。

## 维护注意

- 新增平台或运行类型时，优先复制现有独立平台看板的组件结构，只替换 `run_type` 过滤值。
- 如果重建 Base 或表，需要先恢复上述公式字段，再创建看板组件。
- 飞书 dashboard block 更新接口有频控，批量修改组件时应串行执行并在请求间留出短暂间隔。
- Bitable token 和记录写入请求各自有 30 秒超时；请求失败或超时必须返回非零退出码，交由调用方决定是否阻断当前 CI。
- 上传脚本写入的字段名必须在表中存在，否则整条记录被拒绝。新增字段时先建列再合并代码；删除字段时先合并不再写入它的代码再删列。
