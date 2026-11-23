# E2E 失败用例产物与报告平台上传

## 目标

桌面 E2E 运行结束后，将整次运行的 `summary.json` 与 `summary.md` 上传到 ZCode E2E 报告平台；失败 case 的窗口视频在报告创建成功后按用例标题逐个补传。GitLab CI 继续保存二进制 artifact，报告平台保存结构化汇总和可按需下载的视频。

此功能通过 `ZCODE_E2E_FAILURE_ARTIFACTS=1` 显式开启失败 case 日志和视频采集；默认 `pnpm test:e2e` 不产生逐 case 视频或日志，避免日常回归增加磁盘与 CPU 开销。仓库内负责上传报告的 GitLab macOS、Windows job 必须在 job `variables` 中显式将该值设为 `"1"`，不能依赖项目级外部变量。

## 产物契约

每次失败尝试写入：

```text
packages/desktop/.e2e-artifacts/<run-id>/
  summary.json
  summary.md
  runtime-logs/<worker-id>/{desktop,agent}/...
  failures/<worker-id>/<case-id>/attempt-<retry-index>/
    case.json
    logs/index.json
    logs/<runtime-log-relative-path>
    video.webm
```

- `worker-id` 是 WebdriverIO `cid`；`case-id` 是 `fullTitle` 的稳定 hash；`retry-index` 保留每次重试，避免本地产物覆盖。
- `case.json` 记录失败 case 的完整标题和视频相对路径。上传器只读取 `version: 1` 且 `result.passed: false` 的清单。
- 日志在 `beforeTest` 记录每个 runtime log 文件的 byte offset，在失败的 `afterTest` 只拷贝新增字节。每个 worker 的 desktop/agent 日志目录隔离，因此不会把其他 worker 的日志混入当前 case。
- 视频使用 Electron `webContents.capturePage()`，只在失败时调用 ffmpeg 编码。失败产物采集默认在 case 测试体开始前先采集 2 秒，并在失败后再采集 2 秒；按真实墙钟时间补齐整个时间轴。默认 4 FPS，可通过 `ZCODE_E2E_FAILURE_VIDEO_FRAME_INTERVAL_MS`、`ZCODE_E2E_FAILURE_VIDEO_PRE_ROLL_MS` 与 `ZCODE_E2E_FAILURE_VIDEO_TAIL_MS` 调整。
- 诊断链路必须有界：单帧采集默认最多等待 5 秒，ffmpeg 默认最多等待 30 秒，录屏 `stop()` 默认总预算 45 秒，整个 `afterTest` 失败产物采集默认总预算 60 秒。可分别通过 `ZCODE_E2E_FAILURE_VIDEO_CAPTURE_TIMEOUT_MS`、`ZCODE_E2E_FAILURE_VIDEO_ENCODE_TIMEOUT_MS`、`ZCODE_E2E_FAILURE_VIDEO_STOP_TIMEOUT_MS` 与 `ZCODE_E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS` 调整。超时只写入测试结果或 `case.json` 的 `collectionErrors`，不得覆盖原始测试结果或阻塞后续 `after`、`afterSession` 与 summary 生成。

由于 app 崩溃或 WDIO worker 被强杀时 hook 可能无法执行，视频和 case 日志是 best-effort；`summary.json` 与 `summary.md` 仍是整次运行的主报告。

## 报告平台上传

`scripts/ci/push-e2e-report-to-feedback.mjs` 严格按报告 API 分两步上传：

1. `POST /v1/agent/e2e-reports`，以 `multipart/form-data` 上传 `summary.json` 与 `summary.md`，并读取返回的 `report_id`。
2. 逐个读取 `failures/**/case.json`。若清单指向可读的 `video.webm`，调用 `POST /v1/agent/e2e-reports/{report_id}/video`，表单 `title` 使用失败 case 的完整标题，`video` 使用对应文件。不同标题追加；同标题重传由服务端原子替换。

第 1 步的表单字段：`client`、`platform`、`uploaded_by`、`summary_json`、`summary_markdown` 必填；`version`、`branch`、`commit_sha`、`run_type` 可选，没有值时不传。`run_type` 的取值见下节。

报告上传的幂等键由 `summary.json` 中的 `runId`、`client=desktop` 和 `platform` 组成。遇到网络错误或服务端 `5xx` 可安全重试；客户端错误、鉴权错误和文件大小错误不会盲目重试。

CI 需设置 masked variable：

```text
ZCODE_FEEDBACK_NOTIFICATION_TOKEN
```

可选变量：

```text
ZCODE_FEEDBACK_BASE_URL=http://intranet.example.invalid:8080
```

## 运行类型

`run_type` 区分一次运行属于哪类入口，多维表格与报告平台使用同一个值。

| 值                    | 入口                                                   |
| --------------------- | ------------------------------------------------------ |
| `full-windows`        | Windows 全量（子 pipeline 汇总 job）；Windows 常驻脚本 |
| `full-macos`          | macOS 全量                                             |
| `incremental-windows` | Windows MR 增量                                        |
| `incremental-macos`   | macOS MR 增量                                          |

```text
job 变量 ZCODE_E2E_RUN_SCOPE=full|incremental
  └─▶ WDIO reporter prepare() 写 manifest.json { runScope }      ← 唯一数据源
        └─(Windows 全量) merge-e2e-shard-results 沿用第一个分片的 manifest
              └─▶ 上传时：runScope + summary.environment.platform（win32→windows, darwin→macos）
                    ├─▶ 报告平台表单 run_type
                    └─▶ 多维表格 run_type
```

- 只接受 `full` 与 `incremental`。变量缺失或取值无效时 manifest 不写 `runScope`；平台不是 win32 / darwin 时也不组合。这两种情况都不上报 `run_type`（多维表格写空，报告平台不传），例如本地手动运行。
- 上传时不读环境变量：Windows 汇总 job 运行在另一台 Linux runner 上，没有分片的 job 变量，只能从 artifact 中的 manifest 读取。
- `run_type` 表示入口类型，不表示实际 spec 数量。手动全量 job 在 Web pipeline 中覆盖 `ZCODE_E2E_SPEC` 时仍是 `full-*`；实际运行的 spec 见 manifest 的 `configuredSpecs`。

## 报告地址回写

报告创建成功后（视频上传前），上传器把报告信息写入 artifact 目录的 `report-upload.json`：

```json
{ "reportId": "<report_id>", "reportUrl": "<报告平台页面地址>" }
```

- 页面地址由报告平台的报告页基址加查询参数 `e2e_report=<report_id>` 组成。基址默认值写在上传脚本中，可用 `ZCODE_FEEDBACK_REPORT_PAGE_URL` 覆盖。
- 在视频上传前写入：视频上传失败或上传进程超时被终止时，报告已经存在，链接仍然有效。
- 读取方：多维表格的 `report_url`（见 [E2E Metrics Bitable Dashboard](../monitoring/e2e-metrics-bitable-dashboard.md)）；MR 增量 case 失败评论（见 [明确失败后标记 Draft 并评论](conversation-session-automatic-e2e-ci.md#明确失败后标记-draft-并评论)）。
- 没有这个文件（上传失败、跳过或 dry-run）时，读取方不写链接，不报错。

## 上传顺序

每个入口先上传报告，再写多维表格，因为多维表格要读取 `report-upload.json`。两步都是诊断链路，任一步失败都不阻止另一步执行。

Windows 全量分片 job 不在 job 内上传：子流水线的汇总 job 合并十个分片的 summary 与失败视频后，只上传一份报告（见 [Windows 全量入口](conversation-session-automatic-e2e-ci.md#windows-全量入口子-pipeline-与结果汇总)）。其余 GitLab job 在主 `script` 中保存 E2E 退出码，再依次执行报告平台与 Bitable 上传；`after_script` 只允许承担不影响 job 状态的清理。未设置 token、网络错误、平台 `4xx/5xx` 或上传超时时都只记录 warning，报告上传不得改变 CI job 状态。上传阶段发现 summary 缺失也不引入新的上传失败码；summary 是否有效仍由前置 summary 校验链路决定。若 E2E 本身失败，仍尝试上传报告，最终只返回 E2E 与 summary 校验链路的退出码。报告 token 绝不写入仓库、artifact 或日志。

本地执行同一脚本可以验证报告上传；本地没有 GitLab 环境时不影响报告或视频上传，只是 GitLab artifact URL 不适用。

Windows 常驻入口 `scripts/ci/run-e2e-bitable-loop.ps1` 会为每轮测试启用 `ZCODE_E2E_FAILURE_ARTIFACTS=1` 并设置 `ZCODE_E2E_RUN_SCOPE=full`，先调用报告上传器，再上传 Bitable 汇总指标。启动前必须同时配置 Bitable 凭据和 `ZCODE_FEEDBACK_NOTIFICATION_TOKEN`；Bitable 与报告平台任一上传失败都不会阻止另一上传器执行。可用 `-UploadTimeoutSeconds` 控制 Bitable 上传进程上限，用 `-FeedbackUploadTimeoutSeconds` 控制包含视频在内的报告上传进程上限。

## 并行边界

采集目录按 `worker-id + case-id + retry-index` 隔离。上传阶段只在 WDIO 全部 worker 结束、`summary.json` 已写入后运行；因此所有 worker 的失败视频会附着到同一个 `report_id`，不会并发修改同一个报告。

同一 worker 内 Mocha case 串行运行，byte offset 是确定性的。若未来一个 worker 内引入并发 case，必须引入跨 main、host、agent 的 `caseId` 结构化日志上下文，不能继续使用 offset 归属。

## 脱敏与保留

报告平台接收原始 `summary.json` 和 `summary.md`，其中的错误内容与现有 artifact 保留策略一致。新增 runtime 日志 source 必须过滤 Authorization、Cookie、API Key 和 access token。视频不进入报告 ZIP，只通过短时下载地址获取。
