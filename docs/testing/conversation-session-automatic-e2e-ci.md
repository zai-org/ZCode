# Desktop Formal Manual E2E CI

## 背景

需要一个 CI 入口试跑已经完成 V4 formal admission 的桌面端 E2E，用于定位 MR/web pipeline 上的桌面端回归问题。该入口按 [业务场景目录](e2e-business-scenarios.md) 递归收集正式 case，并显式列入已人工验证的跨域正式 spec。共享候选排除规则保证任意深度的 `manual-review/pending` 不进入正式集合。

当前状态：手动可选。`test:e2e:conversation-session:auto` 和 `test:e2e:conversation-session:auto:windows` 在 `approve-mr` 阶段显示为 manual job；未点击不会阻塞 `build-app` / `build` 后续流程，点击后失败也按 `allow_failure=true` 处理。job 名称保留历史 conversation-session 命名，但覆盖范围已经包含已准入的桌面正式子集。

## 手动正式集合

`ZCODE_E2E_SPEC` 当前使用正式目录 glob：

```bash
./test/e2e/conversation-session/**/*.test.ts,
./test/e2e/plugins/**/*.test.ts,
./test/e2e/workspace/files/workspace-file-tree-refresh.test.ts,
./test/e2e/feedback/logs/export-logs-jsonl-redaction.test.ts
```

conversation-session glob 动态机械收集 scenario formal spec，不用固定数量作为门禁。每个 spec 都必须先通过 formal admission audit：禁止旧 aggregate helper，必须具备 case manifest、case-local provider fixture，以及与 manifest 一致的请求 ledger。plugins glob 收集已转正插件域用例；`workspace-file-tree-refresh.test.ts` 是文件树域已转正的跨域正式用例：不触发 provider 请求，使用真实 workspace 文件 fixture 验证刷新按钮和 watcher 实时刷新链路。`feedback/logs/export-logs-jsonl-redaction.test.ts`（ELR-01）是导出日志脱敏的正式用例：不触发 provider 请求，在隔离 HOME 放入样本后经帮助菜单真实导出，逐条检查归档；只按文件路径单独收录，`feedback/` 目录下其它用例不随之进入 CI。

CI 的 `ZCODE_E2E_EXCLUDE_SPEC=./test/e2e/**/manual-review/**/*.test.ts` 只表达候选目录规则，不维护逐文件 quarantine。formal 是否可收集由目录位置和 admission audit 共同决定；尚未满足合同的 case 留在场景内的 `manual-review/pending`。MR 增量选择和分片在生成显式文件列表前同样排除候选。

## 触发规则

- GitLab merge request pipeline 创建后显示 macOS / Windows 两个 manual e2e job；需要定位时再手动点击。
- GitLab Web UI 手动创建的 pipeline 中同样显示 manual e2e job，不会自动消耗 runner。
- 后续 `test` / `build-app` / `build` 等阶段不再依赖 desktop formal e2e；未点击、跳过或失败都不阻塞后续流程。
- `build:desktop:app` 只等待 `approve:merge-request` 人工确认；macOS / Windows / Linux 平台打包 job 只依赖 `build:desktop:app` 的 artifact。
- 目标分支范围沿用 workflow 规则：只为目标分支 `main` 或 `staging` 的 MR 创建 pipeline。

## MR 变更 spec 自动入口（Windows）

全量 formal 集合约 400 个 spec，Windows 全量耗时过长，MR 上不会主动点击。`test:e2e:mr-changed:windows` 只运行本次 MR 新增或修改的 formal spec，自动执行、不阻塞。

- 触发：仅 `merge_request_event`，且 MR 相对目标分支改动了 formal 集合内的 spec 文件（GitLab `rules:changes`）；没有这类改动时不创建 job，不占用 Windows runner。
- 结果：`allow_failure: true`，失败不阻塞 `build-app` / `build`；不依赖 `approve:merge-request`，pipeline 创建后即排队。
- runner：复用 `test:e2e:conversation-session:auto:windows` 的 tags、安装、构建、WDIO、summary 校验、报告上传与 job 结束飞书通知，`parallel: 1`，单个 job 运行全部选中 spec。
- 选例范围：变更文件与 formal glob（与全量入口同一份 `ZCODE_E2E_SPEC`）的交集，只取新增、修改、重命名后的文件；删除的 spec 不运行。`manual-review/`、`pending/` 以及 formal glob 之外的 spec 即使改动也不运行，只在 job 日志里列出。
- diff 基线：`CI_MERGE_REQUEST_DIFF_BASE_SHA`（pipeline 创建时 MR 的 merge base）到 `CI_COMMIT_SHA`。job 先按 SHA 浅取基线提交，再比较两棵树；取不到基线时 job 失败，不回退到全量。
- 选中 0 个 spec（例如只删除了 spec）时 job 直接成功退出，不安装依赖、不启动 Electron。
- 选中清单按路径排序后，按拼接长度截断：逗号拼接后不超过 8000 字符，超出部分在 job 日志列出、不运行。原因：清单经 `ZCODE_E2E_SPEC` 传给 WDIO，`pnpm exec` 在 Windows 上通过 `cmd.exe` 启动 `wdio.cmd`，而 `cmd.exe` 会丢弃继承来的、超过 8191 字符的环境变量；变量丢失后 `wdio.conf.ts` 会退回 `./test/e2e/**/*.test.ts` 全量。按现有路径长度，约 90 个 spec 会达到上限；按约 70 秒/spec 估算，单个 job 仍在超时内。

```text
MR pipeline
  └─ rules:changes 命中 formal spec?
       ├─ 否 → 不创建 job
       └─ 是 → test:e2e:mr-changed:windows（自动, allow_failure）
                ├─ git fetch --depth=1 <diff base sha>
                ├─ git diff --diff-filter=AMR base..head ∩ formal glob → 显式 ZCODE_E2E_SPEC
                ├─ 空 → exit 0
                └─ 非空 → 复用 Windows formal 流程（weighted shard 1/1 = 全部选中 spec）→ WDIO → summary 校验
```

### case 失败后标记 Draft 并评论

job 本身仍是 `allow_failure`。GitLab 把 allow_failure 的失败视为通过，所以 `when: on_failure` 的后续 job 不会触发。因此处理逻辑放在该 job 的 `after_script` 中，在同一台 Windows runner 上执行，不下载 artifact。

- 数据源：结果报告脚本 `report-e2e-ci-result.mjs` 用 `--json-out` 写出报告 JSON，路径由 job 变量 `ZCODE_E2E_CI_REPORT_JSON` 指定，文件名带 `CI_JOB_ID`，不会读到旧 job 的文件。每个失败条目带 `kind`：`case` 来自 summary 中实际执行失败的 case；`log` 来自 WDIO 日志（hook 失败、spec 没有 case 结果）。
- 判定：只有 `kind=case` 的失败才处理。hook 失败、spec 没有 case 结果、覆盖校验失败、安装或构建失败、没有报告 JSON，都不标记 Draft，也不评论。
- 防止竞态：先读取 MR，MR 的 head sha（唯一数据源）与本次 pipeline 的源提交（`CI_MERGE_REQUEST_SOURCE_BRANCH_SHA`，没有时用 `CI_COMMIT_SHA`）不同时，说明 MR 已有新提交，不处理。
- Draft：MR 不是 Draft 时，标题前加 `Draft: `；已经是 Draft 时保持不变。case 通过后不自动取消 Draft。
- 评论：每次判定为 case 失败都新发一条评论，列出 spec、case 标题和错误首行，最多 30 行，其余只计数。评论附 pipeline、job 链接和提交短 sha。
- 凭据：使用 CI 变量 `GITLAB_ACCESS_TOKEN`（兼容 `GITLAB_PRIVATE_TOKEN`），需要 Developer 及以上角色和 `api` scope，并且 MR pipeline 中可读取。缺少凭据或 API 失败时只打印 warning，不改变 job 结果。

```text
test:e2e:mr-changed:windows
  script ── WDIO → report-e2e-ci-result.mjs --json-out $ZCODE_E2E_CI_REPORT_JSON
  after_script
    ├─ 飞书 job 结果通知（原有）
    └─ mark-mr-draft-on-e2e-failure.mjs --report $ZCODE_E2E_CI_REPORT_JSON
         ├─ 没有 JSON / 没有 kind=case 的失败 → 不处理
         ├─ GET MR：sha ≠ 本次源提交           → 不处理（已有新提交）
         ├─ MR 不是 Draft → PUT title = "Draft: " + title
         └─ POST note：失败 case 表格 + pipeline/job 链接
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

Windows job 使用 GitLab `parallel` 生成四个独立 job。四个 job 不再使用 WDIO native
连续切片；启动 WDIO 前先展开同一份 formal glob，读取
`packages/desktop/test/e2e/conversation-ci-spec-duration-weights.json`，按历史 worker 耗时使用确定性 LPT
分配到四个桶，再由 `CI_NODE_INDEX` 选择当前桶并写回显式 `ZCODE_E2E_SPEC`。这样同时
平衡长 spec、单 spec 多 case 和新 spec fallback，不会因为文件名顺序让第一个 shard
长期承载 background/goal 等重型集合。每个 job 的 summary 只校验自己选中的显式子集；
分配器测试负责证明四桶并集等于全量 formal 集合、没有重复且估算耗时受控。
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
formal glob -> expand -> historical duration profile -> LPT bucket 1..4
                                                     -> CI_NODE_INDEX
                                                     -> explicit ZCODE_E2E_SPEC
                                                     -> WDIO -> subset summary gate
```

四个 job 仍可能落在同一台 shell runner 主机。NVM 安装目录是机器级共享状态，job setup 禁止在其中重复创建或覆盖
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

conversation formal glob 包含 `conversation-session-ssh-remote*.test.ts`。当 runner 配置了
`ZCODE_E2E_SSH_HOST` + `ZCODE_E2E_SSH_USERNAME` + `ZCODE_E2E_SSH_PASSWORD`（或任一
`ZCODE_E2E_SSH_HOST` / `ZCODE_E2E_SSH_A_HOST` / `ZCODE_E2E_SSH_B_HOST`）时，WDIO `onPrepare`
的 `stageDesktopE2EAppOutput` 会把 `packages/desktop/mock-cdn/releases/<repo version>`
stage 到 runId 隔离目录，供 SSH remote runtime 使用。

该 release 目录由 `pnpm --filter @zcode/desktop prepare:remote-assets` 产出。历史上的坑：
CI 只有 `build:remote:assets` job 会跑该命令，且它跑在 `macos` tag runner 的工作槽位，
而 conversation e2e 跑在专用 e2e runner；`mock-cdn` 虽被 `GIT_CLEAN_FLAGS` 排除做工作区
持久化，但两个工作目录互不相通，且目录按版本号命名——每次版本 bump 后专用 runner 上
必然缺新版本目录，`onPrepare` 直接 fatal（2026-09-11 MR 2606 的
`SSH remote assets missing: .../mock-cdn/releases/3.12.0` 即此问题）。

当前行为：SSH 环境就绪但 release 目录缺失时，`onPrepare` 自动执行
`pnpm --filter @zcode/desktop prepare:remote-assets` 再 stage；目录已存在则跳过（幂等，
同版本复用持久化产物）。prepare 完成后目录仍缺失则继续 fail-closed 中止运行。这样
conversation e2e job 与本地 SSH e2e 都不再依赖其他 job / 其他 runner 槽位的工作区
隐式共享产物。

```text
wdio onPrepare (stageDesktopE2EAppOutput)
  └─ SSH env 就绪?
       ├─ 否 → 跳过 remote release stage
       └─ 是 → mock-cdn/releases/<version> 存在?
              ├─ 是 → stage 到 runId 隔离目录
              └─ 否 → 自动跑 prepare:remote-assets
                       ├─ 产出成功 → stage
                       └─ 仍缺失 → fail-closed fatal
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
