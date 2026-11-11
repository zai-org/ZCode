# Desktop E2E Reporting

桌面端 E2E 默认会把测试报告写到 `packages/desktop/.e2e-artifacts/<run-id>/`。这个目录只用于测试产物，已加入 `.gitignore`。

## 运行

本机运行：

```bash
ZCODE_E2E_SPEC=./test/e2e/infrastructure/smoke/e2ecase-regression.test.ts pnpm --filter @zcode/desktop test:e2e
```

容器运行：

```bash
pnpm run test:e2e:container
```

可用环境变量：

- `ZCODE_E2E_RUN_ID`：固定本次报告目录名
- `ZCODE_E2E_ARTIFACT_DIR`：指定报告输出目录
- `ZCODE_E2E_REPORT_VIEWER_BASE_URL`：生成 `files.viewerUrl` 时使用的 Vite viewer 地址，默认 `http://127.0.0.1:4173/`
- `ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS`：Electron 进程采样间隔，默认 3000ms
- `PERF_SAMPLE_INTERVAL_SECONDS`：容器 `docker stats` 采样间隔，默认 3s
- `ZCODE_E2E_COVERAGE=1`：启用 renderer / main / host / CLI 四运行域源码覆盖率

Electron 进程采样通过 WDIO 的 Electron session 调用 `app.getAppMetrics()`，因此采样窗口从 session ready 后开始；容器采样由外层 Docker 脚本启动，能覆盖镜像运行和测试启动阶段。需要让两条曲线使用同一采样节奏时，可同时设置 `ZCODE_E2E_PERF_SAMPLE_INTERVAL_MS=1000` 和 `PERF_SAMPLE_INTERVAL_SECONDS=1`。极短 case 可能只产生开始/结束点，长时间 regression 才会形成连续趋势。

## 产物

- `manifest.json`：运行环境、spec、采样间隔
- `test-results.ndjson`：逐 case 的标题、状态、耗时和错误摘要
- `summary.json`：机器可读报告摘要
- `summary.md`：人工可读报告摘要
- `workers.ndjson`：完成 worker 级环境登记的 cid/spec；若数量少于 `before-session`，说明前置事务在登记前失败
- `lifecycle-events.ndjson`：prepare/worker/session/hook/complete 的耗时；失败事件必须同时记录 `status=failed` 与错误摘要
- `perf/process-samples-*.ndjson`：通过 Electron `app.getAppMetrics()` 采集 main / renderer / GPU / utility 进程 CPU 和内存
- `perf/container-samples.ndjson`：容器模式下通过 `docker stats` 采集 CPU、内存、网络 IO、块 IO 和 PID 数
- `coverage/ui-renderer-istanbul-raw.json`：`ZCODE_E2E_COVERAGE=1` 时从 renderer `globalThis.__coverage__` 采集的 Istanbul 原始覆盖率数据
- `coverage/ui-renderer-summary.json` / `coverage/ui-renderer-summary.md`：renderer UI 源码级覆盖率摘要
- `coverage/ui-renderer-html/index.html`：Istanbul HTML 覆盖率报告，可查看总覆盖率、逐文件覆盖率和逐行命中状态
- `coverage/lcov.info`：LCOV 覆盖率报告，供 CI 或其它 coverage 工具消费
- `coverage/coverage-final.json` / `coverage/coverage-summary.json`：Istanbul JSON 覆盖率数据
- `coverage/summary.json`：四运行域 totals、raw 数量、源码文件数和完整性
- `coverage/{main,host,cli}/`：各 Node/Electron 运行域的 JSON、LCOV 与 HTML 报告
- `coverage/heatmap/index.html`：renderer / main / host / CLI 四层函数执行热度图
- `coverage/heatmap/data.json`：热度图使用的逐文件函数命中数据，供后续趋势或 case 维度分析复用

## HTML 报告

HTML 报告的边界是“读 `summary.json` 渲染视图”，不直接读取 WDIO runtime 或业务代码。报告 viewer 是 `packages/e2e-report` 里的 Vite 应用，图表使用 Chart.js；桌面 E2E runner 只负责传入汇总后的 summary payload。

启动 viewer：

```bash
pnpm dev:e2e-report
```

E2E 结束后，`summary.md` 和 `summary.json` 的 `files.viewerUrl` 会给出带 `summary` 参数的访问地址，例如：

```text
http://127.0.0.1:4173/?summary=%2F%40fs%2FUsers%2Fdev%2Fworkspace%2Fz-code%2Fpackages%2Fdesktop%2F.e2e-artifacts%2F...%2Fsummary.json
```

页面包含：

- run 状态、耗时、测试通过率和关键资源指标
- CPU 趋势图：容器 CPU 和 Electron 各 process type CPU 维度叠加展示
- Memory 趋势图：容器内存和 Electron 各 process type memory 维度叠加展示
- case 明细、spec、环境和 artifact 路径
- `ZCODE_E2E_COVERAGE=1` 时展示 renderer UI coverage 的总览、逐文件摘要和 Istanbul HTML / LCOV / JSON 入口

## 边界

当前已落地的是报告骨架、case 结果、容器级资源采样、Electron 进程级 CPU / 内存采样，以及可选的四运行域 coverage 采样。它们都只挂在 E2E harness 和 coverage 专用构建里，不改变正常桌面版本的业务启动链路。

`summary.json` 和全局进程/HOME 清理仍由 WDIO `onComplete` 权威收口。最后一个 worker
结束时 runner 必须持有一个有引用的短期 finalization guard，直到 `onComplete` 开始；这样
Node 不能在 promise continuation 执行前静默退出 0。正常 `onComplete` 会解除 guard 并写入
summary；guard 超时只作为基础设施失败兜底，必须先从现有 NDJSON 写出失败 summary，再以
非零退出，不能把缺 summary 的空跑当作成功。

renderer UI coverage 默认关闭，只在显式设置 `ZCODE_E2E_COVERAGE=1` 时启用：

```bash
ZCODE_E2E_COVERAGE=1 pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/conversation-session/execution/conversation-session-running-actions.test.ts
```

需要把正式、`manual-review` 一次跑完并生成四域报告时，使用仓库入口：

```bash
pnpm test:e2e:all:coverage
```

入口会同时设置 `ZCODE_E2E_COVERAGE=1` 和 `ZCODE_E2E_MANUAL_REVIEW=1`。每个 worker
再按自身 spec 隔离 provider：正式 case 与已有 case-local fixture 的 pending case 使用 replay；
缺 fixture 的 pending case 和 `upstream-provider.test.ts` 使用 capture。单 worker 不允许混用两种模式。
独立真实 provider smoke 仅在同时配置了 `E2E_PROVIDER_BASE_URL` 与真实 `E2E_PROVIDER_API_KEY`（非 replay 占位值）时纳入；
否则入口会精确排除该外部 smoke 并打印原因，避免把缺 key 的 401 误报成产品回归。SSH 环境齐全时包含 SSH case；环境不齐时仅排除 SSH case，并在其余范围内继续全量执行。

renderer coverage 在 `ZCODE_E2E_COVERAGE=1` 时由 Vite 在构建阶段插入 Istanbul instrumentation。E2E 结束时，reporter 通过 WebdriverIO `browser.getPuppeteer()` 连接真实 renderer target，从页面里的 `globalThis.__coverage__` 读取 counter，再生成 Istanbul 标准报告。

coverage 插桩必须发生在源码级 `pre` transform 阶段，直接对原始 `.ts` / `.tsx` AST 生成 Istanbul counter。不要改回 post-transform 的通用 Vite Istanbul 插件；那类插件依赖 Vite/React/esbuild 合并 sourcemap 反推源码位置，已验证会把生成后的 JS 覆盖点映射到 `import`、`interface` 等非运行时代码行，导致逐行 HTML 和总覆盖率口径都被污染。

当前纳入 UI coverage 的源码范围是：

- `packages/ui/src`
- `packages/desktop/src/renderer`

E2E summary 和 e2e-report viewer 只展示覆盖率总览、逐文件摘要和 artifact 入口；逐行命中/未命中的专业视图以 `coverage/ui-renderer-html/index.html` 为准。这个分层可以避免 E2E 运行报告重复实现完整 coverage UI，也让 CI 后续可以直接上传 LCOV 或 Istanbul HTML。

## 跨进程源码覆盖率合同

`ZCODE_E2E_COVERAGE=1` 必须采集同一次 Desktop E2E run 中的四个运行域，且分别出具报告：

- `renderer`：`packages/ui/src` 与 `packages/desktop/src/renderer` 的 Istanbul 源码覆盖率。
- `main`：Electron main 及其打包进 main graph 的一方源码覆盖率。
- `host`：Electron utility host 及其打包进 host graph 的一方源码覆盖率。
- `cli`：桌面启动的 zcode-cli `app-server` 及其打包进 CLI graph 的一方源码覆盖率。

覆盖率数据链路如下：

```text
WDIO worker/session
  |-- renderer globalThis.__coverage__ ----------> raw/renderer/<worker>.json
  |-- Electron main NODE_V8_COVERAGE + flush ----> raw/main/<pid>.json
  |-- utility host NODE_V8_COVERAGE + flush ----> raw/host/<pid>.json
  `-- CLI app-server NODE_V8_COVERAGE ------------> raw/cli/<pid>.json
                                                      |
                                                      v
                                    source map remap + repo-relative normalize
                                                      |
                       renderer / main / host / cli 独立 Istanbul 标准报告
```

采集与汇总必须满足以下规则：

1. worker、session 和 PID 只能写独立 raw 文件；禁止覆盖同一 run 中其它 worker 的数据。
2. suite 汇总只能在所有 worker 退出后执行。renderer 使用 Istanbul coverage map union；Node/Electron 域使用 V8 raw union 后再由 c8 映射回源码。每个 worker 退出后可把 Node raw 就地裁剪为目标运行域，并按 canonical bundle URL 只保留一份 source map；同一运行域存在多个 lazy chunk 时，每个不同 bundle 仍必须各保留一份 map，不能以“该域已有 map”为由删除后续 chunk 的唯一映射。
3. coverage 专用构建必须保留 external source map 且不得压缩 main、host、preload 和 CLI bundle；这些 map 只存在于 E2E build/cache/artifact，不进入发布包。
4. Electron main 的 E2E 退出路径最终会强杀进程，因此必须在强杀前显式调用 `node:v8.takeCoverage()`；host 在资源释放完成、`process.exit` 前显式 flush。CLI coverage 模式先通过 stdin EOF 请求 app-server 正常退出，并使用比发布包更长的等待窗口；超时后的 SIGTERM / `process.exit` 路径也必须主动 flush，并在显式退出前留出 V8 后台写盘窗口。CLI coverage preload 在一方 bundle 执行前写 readiness marker：有 marker 却没有 raw 才属于采集缺失；无 marker 的早退进程尚未执行一方入口代码，按 pre-entry zero 单独计数，不把它误报为 incomplete。
5. 报告只统计 source map 可归属到仓库一方代码的条目，排除 `node_modules`、测试、fixture、声明文件和第三方/生成产物。main / host 映射到 TypeScript 源码；CLI 内部 workspace package 当前未发布二级 sourcemap，因此这些 package 以 CLI bundle map 能提供的 `dist/*.js` 作为最细粒度源码，CLI 自身及 shared package 仍映射到原始源码。后续补齐内部 package sourcemap 后应直接收敛到 TypeScript，不改变 raw 采集合同。
6. 四层百分比必须独立展示，不能把不同运行域直接相加成一个总百分比。共享源码允许分别出现在多个运行域中。
7. 任一已执行运行域没有产生 raw 数据时，本次 coverage 状态必须是 `incomplete`，不得用剩余数据冒充完整覆盖率。

每个运行域输出以下标准产物：

- `coverage/<domain>/coverage-final.json`
- `coverage/<domain>/coverage-summary.json`
- `coverage/<domain>/lcov.info`
- `coverage/<domain>/index.html`

## 函数执行热度图合同

覆盖率百分比回答“有没有执行”，函数热度图回答“执行集中在哪里”。热度图只消费四层已经生成的 `coverage-final.json`，不得重新启动应用，也不得改变 E2E case 的运行语义。

```text
renderer coverage-final.json ----\
main coverage-final.json ---------+--> 逐文件函数命中聚合 --> 全量平铺 --> coverage/heatmap/
host coverage-final.json ---------+
cli coverage-final.json ----------/
```

热度图必须满足以下口径：

1. 同一运行域的全部源码文件叶子节点必须在一个画布内一次性铺开，一个 tile 只能代表一个文件。目录只作为文件路径的一部分存在，禁止聚合成 tile，也禁止要求用户逐层点击目录才能比较热点。
2. 所有文件 tile 必须等宽等高，面积不编码任何指标；只有亮度表示文件内函数命中热度，越亮代表执行越频繁。所有文件 tile 使用运行域内同一个标尺，不能按局部目录重新归一化。
3. 默认颜色指标是文件内函数总命中次数，先使用 `log1p` 对数刻度处理数量级，再对归一化结果做对比增强，避免少数百万级热点把其余文件压缩成同一种暗色，也避免所有非零文件看起来同样亮。报告同时允许切换到“每函数平均命中”，用于削弱大文件天然累加更多次数的规模效应。
4. 未命中的文件使用独立的零命中颜色，不能和低频但已命中的代码混淆。颜色之外必须显示准确次数、函数覆盖数量和覆盖率，不能只依赖视觉亮度表达结论。
5. renderer / main / host / CLI 必须独立切换、独立归一化颜色，禁止跨运行域把调用次数合并。共享源码可以分别出现在多个运行域。
6. tile 的 hover、键盘 focus 或点击只更新选中详情，不改变画布层级。详情至少包含路径、函数总命中次数、函数覆盖数以及最热函数及其源码行。
7. 热度表示本次整套 E2E 的累计运行强度，不等价于功能覆盖广度。高热度可能只来自单个 case 的循环；低热度也可能已经验证关键状态。后续按 case 拆分时，应并列展示命中该函数的 case 数和每 case 的 P50/P95/最大调用次数。
8. 报告必须是自包含静态文件，不依赖远端 CDN 或运行中的 viewer 服务，以便直接从本机或 CI artifact 打开。

suite 级 `coverage/summary.json` 记录四层 totals、raw 文件数量、源码文件数量和采集完整性。CLI 还会用 runtime log 中已退出的 Agent PID 反查 readiness/raw PID；任一已进入一方入口的 CLI 进程缺 raw 时会记录 `missingRawProcessCount` 并把该域标记为 incomplete，入口前早退则记录 `preEntryProcessCount`。首阶段只把覆盖率作为诊断与趋势指标，不设置通过率门槛；功能状态组合是否被验证仍以 case catalog、coverage matrix 以及 case 的 setup/action/assertion 为准。
