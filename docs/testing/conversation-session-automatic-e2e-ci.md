# Desktop Formal Manual E2E CI

## 背景

需要一个 CI 入口试跑已经完成 V4 formal admission 的桌面端 E2E，用于定位 MR/web pipeline 上的桌面端回归问题。该入口按 [业务场景目录](e2e-business-scenarios.md) 递归收集正式 case，并显式列入已人工验证的跨域正式 spec。共享候选排除规则保证任意深度的 `manual-review/pending` 不进入正式集合。

当前状态：全量手动可选，增量随 MR 自动运行。所有入口都是 `allow_failure=true`，不阻塞 `build-app` / `build` 后续流程。job 名称保留历史 conversation-session 命名，但覆盖范围已经包含已准入的桌面正式子集。

## 四类入口

desktop formal E2E 只有四类 GitLab 入口。每类的一次运行只产生一份结果：多维表格 1 行、报告平台 1 份报告。结果用 `run_type` 区分类型（见 [运行类型](e2e-failure-artifact-report-upload.md#运行类型)）。

| `run_type`            | job                                          | 触发                       | 执行                         | 谁上报               |
| --------------------- | -------------------------------------------- | -------------------------- | ---------------------------- | -------------------- |
| `full-windows`        | `test:e2e:conversation-session:auto:windows` | 手动（trigger job）        | 子 pipeline 10 个分片        | 子 pipeline 汇总 job |
| `full-macos`          | `test:e2e:conversation-session:auto:mac`     | 手动                       | 单 job，`mac-e2e` runner     | job 自己             |
| `incremental-windows` | `test:e2e:mr-changed:windows`                | MR 改动 formal spec 时自动 | 单 job，`windows-e2e` runner | job 自己             |
| `incremental-macos`   | `test:e2e:mr-changed:mac`                    | MR 改动 formal spec 时自动 | 单 job，`mac-e2e` runner     | job 自己             |

```text
MR pipeline ──rules:changes 命中 formal spec──┬─▶ mr-changed:windows ─▶ 上报 1 份 ─▶ 明确失败时 Draft + 评论
                                              └─▶ mr-changed:mac     ─▶ 上报 1 份 ─▶ 明确失败时 Draft + 评论
MR / Web / API pipeline ──手动──┬─▶ auto:windows ─▶ 子 pipeline 10 分片 ──needs──▶ summary ─▶ 上报 1 份
                                └─▶ auto:mac ─────────────────────────────────────────────▶ 上报 1 份
```

- 类型来源：job 用 `ZCODE_E2E_RUN_SCOPE`（`full` / `incremental`）声明范围，平台来自运行机器。共享模板不声明，由继承方各自声明，避免继承到错误的值。
- macOS 的 Bash 合同放在隐藏模板 `.test:e2e:mac:runner`（`.gitlab/ci/20-test.yml`）。全量与增量都继承它，只使用 `mac-e2e` tag；不再有带通用 `macos` tag 的 E2E job，避免和构建、发布 job 抢占。
- Windows 常驻脚本 `scripts/ci/run-e2e-bitable-loop.ps1` 不是 GitLab 入口，跑完整集合，按 `full-windows` 上报。
- runner 不足时 job 在 GitLab 中排队（pending），不改变结果。同一 MR 推送新提交后，旧 pipeline 中 `interruptible` 的 job 会被取消。

## 手动正式集合

`ZCODE_E2E_SPEC` 当前使用正式目录 glob：

```bash
./test/e2e/conversation-session/**/*.test.ts,
./test/e2e/plugins/**/*.test.ts,
./test/e2e/workspace/files/workspace-file-tree-refresh.test.ts,
./test/e2e/feedback/logs/export-logs-jsonl-redaction.test.ts,
./test/e2e/settings/general/settings-ui-polish.test.ts
```

设置 UI 正式入口按精确路径收录 9 条本地用例；UP-00 只在 Windows 执行。设置分区不显示「正在编辑」的本地用例随 conversation-session glob 收录。两份本地 spec 在没有 SSH harness 时仍准入。远端模型配置入口和 RDUX-05 真实 SSH 操作由独立文件进入远端队列，仍要求隔离目标。

macOS 入口仍把 glob 交给 WDIO。每个 worker 在 Mocha 初始化前按实际文件补齐外层预算：
本地 terminal/unread 为 15 分钟，普通用例仍为 120 秒；显式更大配置与人工审核附加时间保留。
该预算只约束完整用例，不扩大内部单步等待。

conversation-session glob 动态机械收集 scenario formal spec，不用固定数量作为门禁。每个 spec 都必须先通过 formal admission audit：禁止旧 aggregate helper，必须具备 case manifest、case-local provider fixture，以及与 manifest 一致的请求 ledger。plugins glob 收集已转正插件域用例；`workspace-file-tree-refresh.test.ts` 是文件树域已转正的跨域正式用例：不触发 provider 请求，使用真实 workspace 文件 fixture 验证刷新按钮和 watcher 实时刷新链路。`feedback/logs/export-logs-jsonl-redaction.test.ts`（ELR-01）是导出日志脱敏的正式用例：不触发 provider 请求，在隔离 HOME 放入样本后经帮助菜单真实导出，逐条检查归档；只按文件路径单独收录，`feedback/` 目录下其它用例不随之进入 CI。

CI 的 `ZCODE_E2E_EXCLUDE_SPEC=./test/e2e/**/manual-review/**/*.test.ts` 只表达候选目录规则，不维护逐文件 quarantine。formal 是否可收集由目录位置和 admission audit 共同决定；尚未满足合同的 case 留在场景内的 `manual-review/pending`。MR 增量选择和分片在生成显式文件列表前同样排除候选。

## 触发规则

- GitLab merge request pipeline 创建后显示 macOS / Windows 两个全量 manual e2e job；需要定位时再手动点击。Windows 入口是 trigger job，点击一次后在子 pipeline 中运行全部分片（见下节）。MR 改动 formal spec 时，两个增量 job 自动运行（见「MR 变更 spec 自动入口」）。
- GitLab Web UI 手动创建的 pipeline 中同样显示 manual e2e job，不会自动消耗 runner。
- 后续 `test` / `build-app` / `build` 等阶段不再依赖 desktop formal e2e；未点击、跳过或失败都不阻塞后续流程。
- `build:desktop:app` 只等待 `approve:merge-request` 人工确认；macOS / Windows / Linux 平台打包 job 只依赖 `build:desktop:app` 的 artifact。
- 目标分支范围沿用 workflow 规则：只为目标分支 `main` 或 `staging` 的 MR 创建 pipeline。

## Windows 全量入口：子 pipeline 与结果汇总

Windows 全量 formal 集合分成 10 个分片。过去每个分片各自写一行多维表格、各自上传一份报告平台报告、失败时各自发一张飞书卡片，一次全量运行产生 10 份结果。现在由汇总 job 合并 10 个分片的结果，每类只发送一次。

为什么用子 pipeline：父 pipeline 中的分片是可选手动 job（`allow_failure: true`）。GitLab 把没有启动的可选手动 job 当作成功，所以 `needs` 这些分片的 job 会在分片执行前就运行。分片放进子 pipeline 后是普通自动 job，汇总 job 的 `needs` 会真正等待 10 个分片全部结束。也不使用“最后一个结束的分片负责汇总”：分片的 `after_script` 运行时自身仍是 running，两个分片同时结束会都不汇总，或各汇总一次。

```text
父 pipeline
  test:e2e:conversation-session:auto:windows（approve-mr，手动可选 trigger，strategy: depend）
    │ 只转发 ZCODE_E2E_WINDOWS_PIPELINE=1 与 Web/API pipeline 变量
    ▼
子 pipeline（.gitlab/ci/20-test-windows-e2e-child.yml）
  test:e2e:conversation-session:auto:windows:shard 1/10 … 10/10（自动，windows-e2e + e2e）
    │ 各自 WDIO → summary.json → ci-report-<jobId>.json（artifact）；不推送、不发卡片
    │ needs 全部 10 个（成功、失败、取消都算结束）
    ▼
  test:e2e:conversation-session:auto:windows:summary（when: always，linux，allow_failure）
    1. GitLab API 列出子 pipeline 的 job；同名分片取 id 最大的一次（重试后的最新尝试）；
       任一最新尝试不在终态（success/failed/canceled/skipped）时报错退出，不发布任何结果
    2. 只下载小文件：ci-report-<jobId>.json → 读出 runId → <runId>/summary.json、manifest.json
       以及失败 case 的 case.json 与 video.webm；不下载整份 artifact（每个分片 180–385MB）
    3. 写合并目录：summary.json、summary.md、manifest.json、shards.json、failures/shard-<i>/…
    4. 多维表格写 1 行 → 报告平台上传 1 份（含全部失败视频）→ 有失败分片时发 1 张飞书卡片
```

- 共享模板：分片与 `test:e2e:mr-changed:windows` 都继承 `.gitlab/ci/20-test-windows-e2e.yml` 中的 `.test:e2e:windows:runner`。分片设置 `ZCODE_E2E_RESULTS_PUBLISHED_BY_SUMMARY=1`，跳过 job 内的多维表格与报告平台上传，也没有 job 级飞书卡片；`mr-changed` 仍是单 job，保持原有的 job 内上传与 `after_script` 卡片。

- 手机浏览器准备：macOS 与 Windows 均按仓库的 `playwright-core` 版本安装 Chromium 与 ffmpeg。Windows 使用 runner 账号本地应用数据中的固定缓存；macOS 默认使用原始 HOME 下的 `Library/Caches/zcode-e2e-playwright`，允许传入其他绝对缓存目录，拒绝相对路径。WDIO 更换测试 HOME 后仍通过 `PLAYWRIGHT_BROWSERS_PATH` 使用同一缓存。启动实际 Chromium、读取页面标题并写出非空录像后，才把验证过的 executable path 交给 WDIO。准备失败保留安装或预检日志，不启动用例，也不把依赖错误记作产品断言失败。
- macOS 空缓存验证：2026-11-11 在新建的空目录执行同一 CI 安装及预检代码，Playwright 1.59.1 下载 Chromium 147.0.7727.15 与 ffmpeg-1011，预检录像为 1,631 字节。随后以 CI 原样 glob、仅用 exclude 选中 terminal，在隔离 HOME 中两条用例均首次通过、0 跳过，产生两份非空录像；run `macos-recorder-cold-20261111101034484`。该证据是本机 macOS 回放，不代表全量 GitLab CI 已运行。
- 子 pipeline 的 workflow：复用 `00-workflow.yml`，只有 `CI_PIPELINE_SOURCE=parent_pipeline` 且 `ZCODE_E2E_WINDOWS_PIPELINE=1` 时创建，`ZCODE_ENV=test`。trigger job 关闭默认变量继承（与 `build:preview` 同一原因：父 pipeline 顶层的 `$CI_PROJECT_DIR` 路径变量不能被固化后转发）。MR 的 `CI_MERGE_REQUEST_*` 变量由 GitLab 传给子 pipeline，`CI_PIPELINE_ID` 是子 pipeline 的 id。
- 分片状态（唯一数据源是 GitLab job 状态与分片的 ci-report）：分片能进入合并，当且仅当 ci-report 带有效的 `runId`（只含字母、数字、`_`、`.`、`-`），且对应的 `summary.json` 可以读取。job 状态不是 `success`、没有 ci-report、ci-report 退出码非 0、或没有进入合并，该分片记为失败。没有进入合并的分片（安装、构建失败、被取消、报告缺 `runId` 或 summary 缺失）不贡献 case，也不计入卡片的 case 计数；它在 `shards.json`、`summary.md` 与卡片中单列，原因写明是缺报告、缺 `runId` 还是缺 summary。
- 合并 summary：`tests.results` 按分片序号拼接，保持每个分片的原始条目；`tests` 计数、`stability`、`timing`（P50/P95、最慢 case）与 `failureBreakdown` 用合并后的 case 重新计算，不对分片比率求平均。`startedAt` 取最早、`completedAt` 取最晚，`durationMs` 是两者之差（墙钟）；`queueTimeMs` 取分片最大值；`exitCode` 只由分片记录决定（job 状态与 ci-report，与卡片同源），不取 summary 中的 WDIO 退出码：有失败分片时取第一个失败分片报告的退出码，报告退出码为 0 或缺失时为 1（例如 WDIO 为 0 但覆盖门禁失败、job 在写出 summary 后失败、或分片没有进入合并）；没有失败分片时为 0。`shardCoverage`（`total` / `merged` / `missing`）记录合并了几个分片。`missing` 大于 0 时，计数与比率只覆盖已合并的分片，不是全量结果。`runId` 为 `ci-conversation-windows-<子 pipeline id>`。
- 多维表格：对合并目录执行原有 `push-e2e-metrics-to-bitable.mjs`，字段约定见 [E2E Metrics Bitable Dashboard](../monitoring/e2e-metrics-bitable-dashboard.md)；`job_id` 指向汇总 job，`run_type` 来自分片 manifest 的 `runScope`（合并 manifest 沿用第一个分片）。汇总 job 重跑会再写一行。`windows_version` 的产品名来自各分片 manifest 的 `os.description`（分片在 Windows 上写入）；合并 manifest 按分片分别解析后去重排序，用“空格 / 空格”连接写入 `os.windowsVersion`，上传脚本直接采用。汇总 job 在 Linux 上运行，读不到运行机器的产品名，所以不能在上传时读取。
- 报告平台：对合并目录执行原有 `push-e2e-report-to-feedback.mjs`，先于多维表格执行（多维表格的 `report_url` 读取它写出的 `report-upload.json`）。下载的 `case.json` 中 `artifacts.video` 改写为合并目录内的 POSIX 相对路径（分片在 Windows 上写的是反斜杠路径）。报告幂等键含 `runId`，汇总 job 重跑会替换同一份报告。
- 飞书卡片：只在有失败分片时发送，保持原来“只发失败诊断”的语义。标题沿用 `测试失败 · <环境> · win32-x64 · <分支>`；“过程”段写分片数、case 计数、失败分片及原因、前 10 个失败条目（来自各分片 ci-report，含 hook 失败；只写 spec 与用例标题，不含错误原文，见下文「E2E 单 job 失败卡片」的凭据约束）；按钮为子 pipeline 与汇总 job。
- 未结束的分片：只重试分片、在它结束前重跑汇总 job 时，汇总 job 报错退出并列出未结束的分片，不写多维表格、报告和汇总卡片；等分片结束后再重跑汇总 job。判断只用 GitLab job 状态，不等待、不轮询。
- 下载：artifact 单文件下载对网络错误、超时与 5xx 最多尝试 3 次（250ms 起指数退避），4xx 不重试；404 视为文件不存在。
- 汇总 job 本身失败（例如 GitLab API 不可用）时，`after_script` 的通用 job 卡片会发送一张“测试失败”卡片。上传或发送失败只打印 warning，不改变汇总 job 结果。
- 凭据：列出 job 与下载 artifact 使用 `GITLAB_ACCESS_TOKEN`（兼容 `GITLAB_PRIVATE_TOKEN`），与飞书通知脚本相同；多维表格、报告平台、飞书服务凭据不变。
- 重试：只重试某个分片后，汇总 job 不会自动重跑，需要手动重试汇总 job；它会重新取每个分片的最新尝试。

## MR 变更 spec 自动入口（Windows / macOS）

全量 formal 集合约 400 个 spec，全量耗时过长，MR 上不会主动点击。`test:e2e:mr-changed:windows` 与 `test:e2e:mr-changed:mac` 只运行本次 MR 新增或修改的 formal spec，自动执行、不阻塞。两个 job 的触发、选例与 Draft 规则相同，下面的规则同时适用于两者。

- 触发：仅 `merge_request_event`，且 MR 相对目标分支改动了 formal 集合内的 spec 文件（GitLab `rules:changes`）；没有这类改动时不创建 job，不占用 runner。macOS job 用 `!reference` 复用 Windows job 的 rules，两者的路径列表只有一份。
- 结果：`allow_failure: true`，失败不阻塞 `build-app` / `build`；不依赖 `approve:merge-request`，pipeline 创建后即排队。
- runner：Windows job 与全量分片共用 `.test:e2e:windows:runner` 模板的 tags、安装、构建、WDIO、summary 校验与报告上传。job 不设 `parallel`，所以 GitLab 不在 job 名后加 `1/1`。模板在 `CI_NODE_INDEX` / `CI_NODE_TOTAL` 为空时按 1/1 处理，单个 job 运行全部选中 spec。macOS job 与 macOS 全量共用 `.test:e2e:mac:runner` 模板，只用 `mac-e2e` tag。两者都保留 job 结束飞书通知，失败卡片带 E2E 结果（见下文「E2E 单 job 失败卡片」）。
- 选例范围：变更文件与 formal glob（与全量入口同一份 `ZCODE_E2E_SPEC`）的交集，只取新增、修改、重命名后的文件；删除的 spec 不运行。`manual-review/`、`pending/` 以及 formal glob 之外的 spec 即使改动也不运行，只在 job 日志里列出。
- diff 基线：`CI_MERGE_REQUEST_DIFF_BASE_SHA`（pipeline 创建时 MR 的 merge base）到 `CI_COMMIT_SHA`。job 先按 SHA 浅取基线提交，再比较两棵树；取不到基线时 job 失败，不回退到全量。
- 选中 0 个 spec（例如只删除了 spec）时 job 直接成功退出，不安装依赖、不启动 Electron。
- 选中清单按路径排序后，按拼接长度截断：逗号拼接后不超过 8000 字符，超出部分在 job 日志列出、不运行。原因：清单经 `ZCODE_E2E_SPEC` 传给 WDIO，`pnpm exec` 在 Windows 上通过 `cmd.exe` 启动 `wdio.cmd`，而 `cmd.exe` 会丢弃继承来的、超过 8191 字符的环境变量；变量丢失后 `wdio.conf.ts` 会退回 `./test/e2e/**/*.test.ts` 全量。按现有路径长度，约 90 个 spec 会达到上限；按约 70 秒/spec 估算，单个 job 仍在超时内。

```text
MR pipeline
  └─ rules:changes 命中 formal spec?
       ├─ 否 → 不创建 job
       └─ 是 → test:e2e:mr-changed:windows / test:e2e:mr-changed:mac（各自自动, allow_failure）
                ├─ git fetch --depth=1 <diff base sha>
                ├─ git diff --diff-filter=AMR base..head ∩ formal glob → 显式 ZCODE_E2E_SPEC
                ├─ 空 → exit 0
                └─ 非空 → Windows：复用 Windows formal 流程（无 parallel，weighted shard 按 1/1 = 全部选中 spec）
                          macOS：复用 macOS formal 流程（直接用选中 spec）
                          → WDIO → summary 校验 → 报告平台 → 多维表格
```

### 明确失败后标记 Draft 并评论

job 本身仍是 `allow_failure`。GitLab 把 allow_failure 的失败视为通过，所以 `when: on_failure` 的后续 job 不会触发。因此处理逻辑放在每个增量 job 的 `after_script` 中，在同一台 runner 上执行，不下载 artifact。两个平台各自判定、各自评论；评论标题写明平台。

明确失败有两类：conversation 准入审计未通过，或 case 执行失败。两类都说明 MR 的 E2E 内容有问题，作者需要处理。审计失败时 job 在 WDIO 前退出，不会生成 E2E 报告，所以审计结果需要单独的数据源。

- 数据源：
  - 审计：`pnpm audit:conversation-session-coverage --json-out <path>` 写出审计 summary JSON（内容与 `--json` 相同），路径由 job 变量 `ZCODE_E2E_CI_AUDIT_JSON` 指定。通过或失败都写出，失败条目在 `errors` 中。
  - case：结果报告脚本 `report-e2e-ci-result.mjs` 用 `--json-out` 写出报告 JSON，路径由 job 变量 `ZCODE_E2E_CI_REPORT_JSON` 指定。每个失败条目带 `kind`：`case` 来自 summary 中实际执行失败的 case；`log` 来自 WDIO 日志（hook 失败、spec 没有 case 结果）。
  - 两个文件名都带 `CI_JOB_ID`，不会读到旧 job 的文件。
- 判定：审计 `errors` 非空时按审计失败处理；否则只有 `kind=case` 的失败才处理。审计失败时 WDIO 不会运行，两类失败不会同时出现。hook 失败、spec 没有 case 结果、覆盖校验失败、安装或构建失败、审计脚本异常退出（没有审计 JSON）、没有报告 JSON，都不标记 Draft，也不评论。
- 防止竞态：先读取 MR，MR 的 head sha（唯一数据源）与本次 pipeline 的源提交（`CI_MERGE_REQUEST_SOURCE_BRANCH_SHA`，没有时用 `CI_COMMIT_SHA`）不同时，说明 MR 已有新提交，不处理。
- Draft：MR 不是 Draft 时，标题前加 `Draft: `；已经是 Draft 时保持不变。问题修复后不自动取消 Draft。两个平台同时失败时，两个 job 都从 GET 到的同一原标题计算新标题，写入结果相同，不会出现两个 `Draft: ` 前缀。
- 评论：每次判定为明确失败都新发一条评论，附 pipeline、job 链接和提交短 sha。
  - 审计失败：说明 desktop E2E 没有运行，逐条列出审计错误（最多 30 条，其余只计数），并给出本地复现命令。
  - case 失败：列出 spec、case 标题和错误首行，最多 30 行，其余只计数。链接行附本次运行的报告平台页面。地址来自报告上传器写出的 `<artifact>/<runId>/report-upload.json`，`runId` 来自报告 JSON，报告 JSON 与 artifact 目录同在 `.e2e-artifacts/` 下。报告上传失败或没有该文件时不附链接。审计失败时 WDIO 没有运行、没有报告，也不附链接。
- 凭据：使用 CI 变量 `GITLAB_ACCESS_TOKEN`（兼容 `GITLAB_PRIVATE_TOKEN`），需要 Developer 及以上角色和 `api` scope，并且 MR pipeline 中可读取。缺少凭据或 API 失败时只打印 warning，不改变 job 结果。

```text
test:e2e:mr-changed:windows / test:e2e:mr-changed:mac
  script ── admission audit --json-out $ZCODE_E2E_CI_AUDIT_JSON ──失败──▶ exit（不运行 WDIO）
         └─ 通过 → WDIO → report-e2e-ci-result.mjs --json-out $ZCODE_E2E_CI_REPORT_JSON
  after_script
    ├─ 飞书 job 失败卡片（带 E2E 结果，见「E2E 单 job 失败卡片」）
    └─ mark-mr-draft-on-e2e-failure.mjs --report $ZCODE_E2E_CI_REPORT_JSON --audit $ZCODE_E2E_CI_AUDIT_JSON
         ├─ 审计 errors 非空                  → 审计失败
         ├─ 否则报告中有 kind=case 的失败     → case 失败
         ├─ 都没有                            → 不处理
         ├─ GET MR：sha ≠ 本次源提交           → 不处理（已有新提交）
         ├─ MR 不是 Draft → PUT title = "Draft: " + title
         └─ POST note：审计错误列表或失败 case 表格 + pipeline/job 链接（case 失败另附报告链接）
```

## E2E 单 job 失败卡片

范围：`test:e2e:mr-changed:windows`、`test:e2e:mr-changed:mac`、`test:e2e:conversation-session:auto:mac`。这三个 job 自己跑完 WDIO 并上报，失败时在 `after_script` 发一张飞书卡片。Windows 全量分片不发 job 卡片，由汇总 job 发汇总卡片（见上文）。

- 触发：与通用 job 卡片相同，只在 `CI_JOB_STATUS=failed` 时发送。`allow_failure` 不影响发送。
- 数据源：只读本 job 的报告 JSON（`$ZCODE_E2E_CI_REPORT_JSON`，即 `report-e2e-ci-result.mjs --json-out` 的输出）与报告上传器写出的 `report-upload.json`。不重新读取 summary，也不再判定成功或失败。
- 标题、相关人员、提交人、提交信息与通用 job 卡片相同。
- “过程”段：
  - job 名。
  - 有报告 JSON 时：Spec 计数与 Case 计数（共 / 通过 / 失败 / 跳过）；报告带整数退出码时写一行 `退出码：<n>`；失败条目最多 10 个，格式为 `· <spec>｜<case 或 hook 标题>`，其余只计数。格式与 Windows 汇总卡片相同。
  - 不发送错误原文：报告里的错误首行（`failures[].message`）和 `reasons` 都不进卡片。原因：断言比较值可能就是凭据（例如 `not.toContain(config.password)` 失败时，密码会出现在错误消息里），卡片会把它发到通知服务和群聊。卡片只发 spec 路径、源码中编写的用例标题、计数和退出码；错误详情在受访问控制的报告平台与 job 日志中查看。
  - 报告结构校验：覆盖格式化读取的每个展示字段，不只校验容器类型。顶层必须是对象；`counts` 缺省或为对象，其中 `specs` / `cases` 缺省或为对象，`total` / `passed` / `failed` / `skipped` 缺省或为非负整数；`failedSpecs` 为对象数组，每项 `spec` 为字符串，`failures` 缺省或为数组，且每个 failure 都是带字符串 `title` 的对象。JSON 语法损坏或任一字段不符时按“没有报告 JSON”处理，仍发送一张基础卡片（job 名 + Job / MR 按钮），不能因格式化抛错而丢掉整张卡片。
  - 没有报告 JSON 时（安装、构建、准入审计失败，WDIO 没有运行），只写 job 名。
- 按钮（地址缺失时不显示该按钮）：
  - 查看 Job：`CI_JOB_URL`。
  - 查看 MR：`CI_MERGE_REQUEST_PROJECT_URL/-/merge_requests/CI_MERGE_REQUEST_IID`，只有 MR pipeline 才有。
  - 查看报告：报告平台页面，来自 `<artifact>/<runId>/report-upload.json`，取法与 MR 评论的报告链接相同。报告上传失败或没有运行 WDIO 时没有该文件。

```text
after_script（新 shell）
  └─ notify-feishu-ci.mjs --job-result --e2e-report $ZCODE_E2E_CI_REPORT_JSON
       ├─ CI_JOB_STATUS ≠ failed → 不发
       ├─ 读报告 JSON（缺失、语法损坏或结构不符 → 只写 job 名）
       ├─ 读 <artifact>/<runId>/report-upload.json → 报告链接（缺失 → 无按钮）
       └─ notifyCiResult：过程 = job 名 + 计数 + 退出码 + 失败条目标题；按钮 = Job / MR / 报告
```

## 运行命令

CI job 使用 macOS shell runner 在宿主机上执行桌面端 WDIO Electron E2E：

```bash
E2E_PROVIDER_HTTP_MODE=replay \
ZCODE_E2E_SPEC='./test/e2e/conversation-session/**/*.test.ts,./test/e2e/workspace/files/workspace-file-tree-refresh.test.ts' \
pnpm --filter @zcode/e2e-report build:node

E2E_PROVIDER_HTTP_MODE=replay \
ZCODE_E2E_SPEC='./test/e2e/conversation-session/**/*.test.ts,./test/e2e/workspace/files/workspace-file-tree-refresh.test.ts' \
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

`ZCODE_E2E_SPEC` 只作为环境变量交给 `wdio.conf.ts` 解析。CI 不再把同一个 glob追加到 WDIO CLI `--spec`，避免出现两套 spec 过滤入口，让 job 只跑到 `onPrepare` / 构建阶段却没有稳定调度 worker。

普通 replay 会启动本地 provider fixture replay server，不访问真实模型上游，也不依赖 CI 里的 API key。该入口不启动 Docker。

## Windows 并行工具链隔离

Windows 分片 job 使用 GitLab `parallel` 生成十个独立 job。十个 job 不再使用 WDIO native
连续切片；启动 WDIO 前先展开同一份 formal glob，读取
`packages/desktop/test/e2e/conversation-ci-spec-duration-weights.json`，按历史 worker 耗时使用确定性 LPT
分配到十个桶，再由 `CI_NODE_INDEX` 选择当前桶并写回显式 `ZCODE_E2E_SPEC`。这样同时
平衡长 spec、单 spec 多 case 和新 spec fallback，不会因为文件名顺序让第一个 shard
长期承载 background/goal 等重型集合。每个 job 的 summary 只校验自己选中的显式子集；
分配器测试负责证明各桶并集等于全量 formal 集合、没有重复且估算耗时受控。
当前 profile 来自一次 78-spec、200-case 全量成功运行的 worker 生命周期耗时，新 spec
使用 20 秒 fallback。不同平台的绝对耗时可以整体缩放，LPT 只消费 spec 间相对权重；
后续拿到新的 Windows 全量成功产物后，可用同一 `worker` 时长口径刷新 profile。

同一份运行时样本按旧 native 连续切片和新 LPT 重新计算后的分布如下。耗时列是 profile
估算值，不冒充 Windows CI 的新实跑墙钟；它用于证明分配算法不再把重型 spec 固定压在首桶。

| 分配方式          | Shard case 数       | Shard 估算耗时              | 最大/最小耗时比 |
| ----------------- | ------------------- | --------------------------- | --------------: |
| WDIO native slice | `88 / 45 / 39 / 28` | `633s / 316s / 270s / 293s` |            2.35 |
| historical LPT    | `52 / 55 / 41 / 52` | `375s / 381s / 375s / 380s` |            1.02 |

```text
formal glob -> expand -> historical duration profile -> LPT bucket 1..10
                                                     -> CI_NODE_INDEX
                                                     -> explicit ZCODE_E2E_SPEC
                                                     -> WDIO -> subset summary gate
```

多个 job 仍可能落在同一台 shell runner 主机。NVM 安装目录是机器级共享状态，job setup 禁止在其中重复创建或覆盖
Corepack 的 `pnpm.ps1`。每个 job 必须以 `CI_JOB_ID` 在项目临时目录下创建独立的 Corepack
shim 目录，把该目录放到当前进程 `PATH` 首位，并在运行 pnpm 前机械校验实际命令来自该目录。

```text
Windows runner
  ├─ job A -> .tmp/corepack-<job-A>/bin/pnpm.ps1 -> weighted bucket 1
  └─ job B -> .tmp/corepack-<job-B>/bin/pnpm.ps1 -> weighted bucket 2

禁止：job A/B -> NVM_HOME/<node-version>/pnpm.ps1（共享覆写）
```

若当前进程的 Node 版本已经满足 `NODE_VERSION`，setup 不再调用会切换机器级 symlink 的
`nvm use`；只有版本不匹配时才走既有 use/install/use 恢复链。Corepack shim 隔离只改变
CI 工具启动路径，不改变 pnpm store、workspace、E2E HOME、artifact 或 native shard 范围。

## SSH remote 用例准入

默认正式集合按 `packages/desktop/scripts/e2e-formal-spec-selection.mjs` 的唯一规则准入：

| 用例                                                    | 准入条件                             |
| ------------------------------------------------------- | ------------------------------------ |
| `harness/remote/run-all-remote.sh` 队列中的远程目标用例 | SSH 凭据 + `ZCODE_E2E_SSH_CONTAINER` |
| 尚未入队的 `conversation-session-ssh-remote*.test.ts`   | SSH 凭据                             |
| 其余用例                                                | 无要求                               |

队列用例由 remote harness 按 case 准备干净目标，`ZCODE_E2E_SSH_CONTAINER` 是 harness
标记。2026-10-28 Windows conversation job 只配置共享 SSH 凭据，这些用例出现"更新中"、
`source-server-upgrade-required`、认证失败和缺少容器（多分片共用一台主机是推测，未用日志
证实）。这类 runner 不满足用例前提，因此缺 harness 时整体排除。当前所有正式 `ssh-remote*`
用例都已入队，Windows 共享凭据 runner 不再运行 SSH 用例。显式指定单个文件仍不受门禁影响，
缺配置照常失败。

## 官方插件缓存预热

每个 spec 的 `beforeSession` 都会重置 HOME。CLI 首次解析插件时会同步 seed 全部官方插件缓存，
Windows 上会阻塞 CLI 8–15 秒，首发用例的“输入框清空”等待因此超时（根因见
[官方插件首次 seed 同步阻塞](../issues/official-plugin-seed/01-sync-seed-blocks-cli-event-loop.md)）。

- `onPrepare` 构建完成后，用 E2E 实际启动的 `apps/zcode-cli/packages/cli/dist/zcode.cjs` 在
  `.e2e-cache/<runId>/official-plugin-cache-home` 执行一次 `plugin list`，生成模板缓存。
- `resetE2EHome` 在写入各 spec fixture 之前，把模板的 `.zcode/cli/plugins/cache/zcode-plugins-official`
  拷入新 HOME。CLI 的 seed marker 校验命中后不再重写，只刷新 runtime manifest 与 marketplace。
- 正式包（`E2E_PACKAGED_APP_BINARY_PATH`）使用随包 CLI，不预热；模板缺失时 HOME 照常冷 seed。

## 复用构建时的共享快照

复用构建（`ZCODE_E2E_SKIP_BUILD=1` 且 `ZCODE_E2E_SKIP_AGENT_BUILD=1`，即测试池和 CI 子 shard）时，桌面产物和 CLI 在整轮里不变，但每个 WDIO 进程原来都按 runId 再准备一遍：复制整份 `out`、重新 seed 官方插件缓存模板。macOS 的写时复制几乎不花时间；Windows 没有写时复制，复制 `out`（约 6700 个文件、157MB，其中 renderer 占 6650 个）要约 11 秒，seed 模板要 8–16 秒，每一批都要再付一遍。

- 官方插件缓存模板放在 `.e2e-cache/shared/official-plugin-cache/<CLI 入口签名>`（签名 = 文件大小 + 修改时间），同一个 CLI 只 seed 一次；launcher 和 worker 用同一组环境变量算出同一个路径。各 HOME 照旧从模板拷入。
- Windows 上 renderer 放在 `.e2e-cache/shared/renderer/<目录签名>`（签名 = 相对路径 + 大小 + 修改时间），每个运行目录的 `renderer` 是指向它的 junction；`main` 等小目录照常复制，用例往 `main` 写的启动文件（如 `subagent-e2e.mjs`）仍然各自一份。递归删除运行目录只删 junction，不删共享快照。macOS 维持写时复制。
- 快照先建在临时目录，写入完成标记后原子改名；多个进程同时建时只留一份，没有完成标记的残留不会被使用。每类只保留最近 3 份，正被使用、删不掉的跳过。
- 现场构建、源码证据（`ZCODE_E2E_SOURCE_EVIDENCE=1`，它要逐文件校验运行目录）、正式包、或设置 `ZCODE_E2E_SHARED_STAGE=0` 时，维持按 runId 各备一份。
- 实现：`packages/desktop/test/e2e/helpers/e2e-shared-stage-cache.ts`；测试：`packages/desktop/test/e2eSharedStageCache.test.ts`。

## Windows runtime host 自动准备

Windows 上 Agent CLI 只能经过原生 `zcode-runtime-host.exe` 启动（Job Object 归组，见
[Agent 关闭时延](../desktop/agent-shutdown-latency.md)），没有回退路径。该 exe 不进 git；
E2E 构建走 `build:no-runtime-assets`，不会产出它。缺失时每个 case 都会失败：直接报
`Windows runtime host is missing`，或在准备阶段表现为 `workspace presentation 没有就绪（slash 目录为空）`。

当前行为：WDIO `onPrepare` 的 `prepareDesktopAppBuild` 在 build 锁内执行
`node scripts/build-windows-runtime-host.mjs --if-windows --ensure`：

- 非 Windows：直接跳过。
- Windows：`bundled-tools/win32-<arch>/runtime-host/` 下 exe 与 `build.json` 的源码摘要一致就复用，否则用 CMake + VS 2022 重新构建；构建失败则 onPrepare fail-closed。
- `ZCODE_E2E_SKIP_BUILD=1`（分片子 runner）同样执行该检查，命中时只做摘要校验。
- 正式包（`E2E_PACKAGED_APP_BINARY_PATH`）使用随包 exe，不执行。

Windows E2E runner 因此必须安装 CMake 与 Visual Studio 2022 C++ Build Tools。

## SSH remote assets 自动准备

SSH 用例安装远端 Source Server 时，桌面端读取 runId 隔离目录里的
`mock-cdn/releases/<repo version>`。WDIO `onPrepare` 负责准备并 stage 这个目录。

### 是否准备：按本轮 spec 判断

- 唯一判据是本轮调度的 spec 文件（`configuredE2ESpecs` 按 `ZCODE_E2E_EXCLUDE_SPEC` 展开后的文件）的 import 关系。spec 直接或间接 import 下列模块时，本轮需要 remote release：
  - `test/e2e/helpers/ssh-remote-p0.ts`：SSH 目标配置的唯一入口（`readSSHRuntimeConfig` / `readSingleSSHWorkspaceRuntimeConfig` / `readDualSSHRuntimeConfig`）。
  - `remote-restart-stale-daemon.ts`、`source-server-update-fixture.ts`、`ssh-version-policy-fixture.ts`：直接读取本轮 staged release。
- 扫描只跟随 `test/e2e/` 内的相对路径与 `#e2e/*` 别名，`import type` 也计入（多准备不会出错，少准备会）。
- 没有 spec 需要时跳过准备，即使 runner 配置了 SSH 环境变量。原因：CI runner 的 SSH 凭据是项目级变量，只改普通 spec 的 MR 过去也会触发全平台构建。
- 需要但 runner 没有 SSH 环境变量时不准备，与原行为相同；用例在读取 SSH 配置时按缺变量失败。
- 兜底：上面三个 SSH 配置入口读取配置后，检查本轮 staged release 的 descriptor 是否存在；不存在时直接失败，错误说明“该 spec 需要 remote release，但 onPrepare 没有准备”。这样 import 判定漏掉用例时会立即暴露，不会用旧产物运行。使用已打包应用（`ZCODE_E2E_PACKAGED_APP_PATH`）时不检查，打包应用不读 mock-cdn。

### 准备范围与复用

- 范围由 `ZCODE_E2E_REMOTE_RELEASE_SCOPE` 决定：`linux` 只检查、只构建 Linux x64/arm64（`ZCODE_ENV=test pnpm prepare:remote-assets:linux`）；留空为全平台。CI 的 SSH 目标都是 Linux，Windows 与 macOS 两个 E2E runner 模板都设为 `linux`，不再打包 darwin 两个平台。
- 复用：两种范围用同一套 descriptor 校验，范围内每个 target 都要在 descriptor 中登记，且对应 archive 存在；只看文件存在不够。原因：Linux 范围重建只替换两个 Linux 目标、descriptor 只登记它们，旧 darwin archive 仍留在目录里，切回全平台时不能被当成完整（远端 darwin 安装按 descriptor 查找目标）。在此基础上，CI 下构建回执 `.e2e-build-revision` 等于 `CI_COMMIT_SHA` 时复用；否则先作废回执，再重新生成，全部就绪后写入本次提交。prepare 完成后仍不完整则 fail-closed。本机 Docker runner 不传提交，由源码指纹管理缓存。
- Agent bundle 尽量只构建一次：`onPrepare` 先构建本轮 agent（`prepareZCodeAgentServer`），再以 `--skip-agent-build` 调用 prepare，所有 target 复用同一个 bundle。原因：两处使用同一脚本与同一环境（WDIO 固定 `ZCODE_ENV=test`），过去各构建一轮。
- 只有本轮 `onPrepare` 真实构建过 agent 才传 `--skip-agent-build`。`ZCODE_E2E_SKIP_AGENT_BUILD=1`（Windows 分片 child、服务器 harness）或使用已打包应用时，`onPrepare` 只检查入口存在，bundle 可能来自旧构建；这时不传该参数，打包器照常在首个 target 重建 agent。原因：archive 会写入当前提交回执，若打进旧 bundle，之后同提交的运行都会复用这个错版本的包。代价：这类运行在需要重建 remote release 时仍构建两轮 agent（与本优化之前相同）。若要让分片 child 也复用父进程产物，需要父进程传递带构建身份、可校验的 bundle，而不是只传跳过标志。

### 准备阶段计时

`onPrepare` 的子步骤分别记录为 lifecycle 阶段，写入 `lifecycle-events.ndjson` 与 `summary.md` 的 lifecycle 表：

| 阶段                     | 内容                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `prepare`                | 整个 onPrepare                                             |
| `prepare:desktop-build`  | 桌面构建与 app 产物 stage（不含 remote release）           |
| `prepare:agent-build`    | 本轮 agent bundle 构建                                     |
| `prepare:remote-release` | remote release 检查、按需 prepare 与 stage；不需要时不记录 |
| `prepare:plugin-cache`   | 官方插件缓存模板预热                                       |

```text
wdio onPrepare
  ├─ prepare:desktop-build   桌面构建 + stage app
  ├─ prepare:agent-build     构建本轮 agent（SKIP_AGENT_BUILD 时只检查入口）
  ├─ 本轮 spec import 了 remote helper？
  │    ├─ 否 → 跳过
  │    └─ 是 → SSH 环境就绪？
  │           ├─ 否 → 跳过（用例按缺 SSH 变量失败）
  │           └─ 是 → prepare:remote-release
  │                  ├─ 范围内产物齐全且回执 = CI_COMMIT_SHA → 复用
  │                  └─ 否 → 作废回执 → pnpm prepare:remote-assets[:linux]（本轮构建过 agent 时加 --skip-agent-build）
  │                          ├─ 齐全 → 写回执 → stage 到 runId 目录
  │                          └─ 仍缺失 → fail-closed
  └─ prepare:plugin-cache
worker：read*SSHRuntimeConfig → staged descriptor 不存在 → 失败（判定漏掉的兜底）
```

## Artifact

每次手动运行固定写入 `packages/desktop/.e2e-artifacts/<run-id>/`，并作为 GitLab job artifact 保留。核心文件包括：

- `summary.md`
- `summary.json`
- `test-results.ndjson`
- `ci-pnpm-install.log`
- `ci-electron-install.log`
- `ci-desktop-e2e.log`
- `perf/container-samples.ndjson`
- `network-capture/`

## CI stdout

该 job 默认设置 `ZCODE_E2E_CI_STDOUT_MODE=summary`。job 日志分成两段：前面是过程日志，最后是结果报告。

```text
GitLab job 日志
  ├─ 过程日志
  │    ├─ pnpm install（Windows 原样输出折叠在 GitLab section 里；macOS 只写 artifact）
  │    ├─ 每个步骤一行开始（含完整日志路径）+ 一行结束
  │    ├─ desktop e2e replay：完整 WDIO 输出只写 ci-desktop-e2e.log，失败时不打印尾部
  │    └─ Bitable 推送、报告平台上传
  └─ 结果报告（scripts/ci/report-e2e-ci-result.mjs，job 最后一步）
       ├─ 结论与失败原因（WDIO 退出码、summary 缺失、spec 覆盖不一致）
       ├─ 运行信息与统计：spec 通过/失败/无 case 结果，case 通过/失败/跳过
       ├─ 失败 spec 列表（每个 spec 的失败 case 数与 hook 失败数）
       ├─ 相同错误汇总（同一首行错误出现 ≥2 次时合并计数，用来看共同根因）
       ├─ 失败详情：按 spec 分组的 case 标题与错误首行
       └─ 排查材料：summary.md、完整 WDIO 日志、artifact 目录
```

- 报告脚本同时是 summary 门禁：读 `summary.json`，按 `ZCODE_E2E_SPEC` / `ZCODE_E2E_EXCLUDE_SPEC` 展开期望 spec，复用 `validate-e2e-summary-spec-coverage.mjs` 校验覆盖。退出码：WDIO 非 0 时沿用 WDIO 退出码；WDIO 为 0 但 summary 缺失或覆盖校验失败时为 1。
  - 期望集合与 WDIO 实际调度一致：`ZCODE_E2E_SPEC` 含 glob 时，按 job 环境套用上文的环境准入（`isFormalSpecAdmittedByEnvironment`，与 `wdio.conf.ts` 的 exclude 同源）；逐文件指定时不套。2026-11-16 mac job 没有 SSH 凭据，WDIO 排除了 141 个 SSH / 远程队列 / 专项 spec，报告却按缺失计入失败。
  - 全部 case 为 pending 的 spec（`describe.skip`、按环境选择的 `describe.skip`）不触发 `afterTest`，summary 里没有记录。报告从 WDIO spec reporter 输出确认该 spec 只有 pending 行后，按跳过计入，不算缺失；Spec 行把它单独计为「跳过」，不计入「通过」，以免掩盖实际运行的范围。
- hook 失败在 summary 里没有记录：`wdio.conf.ts` 只在 `afterTest` 写入 case 结果。报告总是从 `ci-desktop-e2e.log` 的 WDIO spec reporter 输出按 worker 提取失败标题和错误首行，再按 spec 合并：
  - 没有 case 结果的 spec（`before all` hook 失败、worker 未完成）：取该 spec 的全部失败条目；日志里也没有时，提示查看完整日志。
  - 已有 case 结果的 spec：只追加标题匹配 Mocha hook（`"before|after all|each" hook`）的条目，并把该 spec 计为失败（例如 case 全部通过、随后 `after all` hook 失败）。case 失败已在 summary 中，不从日志重复计入。
  - 归因前提：一个 worker（cid）只跑一个 spec。当前配置的 spec 都是字符串，WDIO 为每个 spec 单独起 runner（cid 形如 `0-<递增序号>`）。spec reporter 在 worker 末尾统一输出 `N failing` 列表，失败条目不带文件；同一 cid 出现多个 `» spec`（WDIO 分组 spec）时报告不归因，按“日志里没有定位到”处理。
- 以下情况报告打印 WDIO 日志尾部（`ZCODE_E2E_CI_LOG_TAIL_LINES`，默认 160 行）：
  - 未能生成 `summary.json`。
  - WDIO 退出码非 0，但 summary 里没有任何失败条目（例如 `after all` hook、`onComplete` 失败）；否则报告只剩一行退出码。
- 失败详情最多展示 60 个失败条目，其余条目只计数，完整列表见 `summary.md`。
- GitLab CI 中报告带 ANSI 颜色；设置 `NO_COLOR` 时关闭。

这样可以避免 WDIO / Electron / app-server 的高频日志把 GitLab job stdout 打爆，失败时在日志末尾直接看到哪些 spec、多少 case 失败以及原因，同时仍保留完整排查材料。

需要临时看实时输出时，可以在 Web pipeline 里把 `ZCODE_E2E_CI_STDOUT_MODE` 覆盖为 `verbose`。

## 边界

- 当前手动入口动态覆盖桌面端 `desktop-continuous` conversation scenario admitted formal spec、插件域正式 spec，以及文件树刷新这类不依赖 provider 的已转正桌面 UI case。
- `manual-review/pending` 不进入该入口；formal admission audit 失败会在机械门禁中阻止错误转正。
- 历史 `conversation-session-admission`、`conversation-session-needs-docker-fix` 和 `conversation-session-tool-cross-product` Docker preset 已退出当前配置，不能作为 V4 formal 准入事实。
- Docker `replay-isolated` 仍保留给正式 Docker 准入和容器环境定位；本入口只跑普通 replay。
- 手机 `/remote` 的 `web-remote-replayable` 恢复语义继续走远控专项回归，不由本 job 证明。
