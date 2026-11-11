# Windows E2E Runtime Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Windows `pnpm test:e2e` 从当前超过 60 分钟且容易被外层超时截断，降低到串行 40 分钟以内、双 shard 25 分钟以内，同时保留跨 spec 状态隔离和关键时间边界覆盖。

**Architecture:** 先让 reporter 直接记录 WDIO 生命周期阶段，随后用 A/B 证明并修复稳定的 session 退出长尾；再压缩非必要 replay 延迟，并在清理逻辑具备 run 隔离后引入两个独立 HOME 的 Windows shard。CI 增加轻量健康门和基础设施熔断，避免同一种启动错误重复消耗所有 spec 的 timeout。

**Tech Stack:** WebdriverIO 9、Mocha、Electron、`wdio-electron-service`、TypeScript、Node.js、PowerShell、GitLab CI。

## Global Constraints

- 不直接把 `ZCODE_E2E_MAX_INSTANCES` 从 `1` 调大；当前 worker 共用 `.e2e-home`，并会在 `beforeSession` 递归删除。
- 不牺牲 Windows/macOS/Linux 兼容；Windows 优化必须保留 POSIX 平台现有清理路径。
- 不降低 conversation case 的产品断言；有意覆盖 45 秒边界的 case 进入显式 slow lane，而不是静默缩短。
- 每项优化都先运行定向 spec，最终只运行一次完整 `pnpm test:e2e`，不做无证据的全量循环。
- 完成前执行 `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck` 和 `pnpm lint`。
- 当前工作区已有未提交的 DeepSeek V4 与 edit E2E 修改；实施时只提交本计划对应文件，不覆盖或夹带这些改动。

---

## 耗时分析报告

### 1. 数据范围

主样本：

- artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260710-035131-341`
- 环境：Windows `10.0.26100`、Node `v24.18.0`、x64、32 GB 内存、Intel Xeon Platinum 8269CY
- 配置：`maxInstances=1`，默认全量 glob
- worker：67 个 spec，其中 conversation 62 个、general 5 个
- 已记录结果：111 个 case，其中 conversation 102 个、general 8 个、container 1 个

对照样本：

- 最近定向成功：`desktop-e2e-20260710-053440-746`
- 历史 Windows CI：`C:/gitlab-runner/builds/yH1yP9nW3/1/codegeex/z-code/packages/desktop/.e2e-artifacts/ci-conversation-windows-232902-632167/ci-desktop-e2e.log`

### 2. 口径与限制

`test-results.ndjson` 的 `durationMs` 只覆盖 Mocha test body，不覆盖构建、`beforeSession`、Electron 启动、WDIO hook 和 session 删除。因此本报告用相邻 `workers.ndjson` 时间戳还原 spec 墙钟时间，再用首个 test 的推算开始时间和最后一个 test 的结束时间拆分生命周期。

最新全量没有 `summary.json`：

- run 开始：`03:51:31.341Z`
- 首个 worker：`03:53:13.810Z`
- 第 67 个 worker：`04:51:18.376Z`
- 第 67 个 worker 的唯一进程采样：`04:51:23.224Z`
- 第 67 个 worker 没有 test result

最后一次采样恰好位于 run 开始后的第 59 分 52 秒，且 summary 缺失。高置信度推断是外层 60 分钟执行上限截断了最后一个 spec。因此当前完整耗时只能报告为“超过 60 分钟”，不能把 59 分钟误写成正常完成时间。

### 3. 当前基线

| 指标 | 结果 |
| --- | ---: |
| 完整耗时 | `> 60 min`，第 67 个 spec 被截断 |
| 首个 worker 前准备 | `102.5 s` |
| 可完整计算的 spec | 66 |
| 66 个 spec 墙钟时间 | `3484.4 s` / `58.07 min` |
| test body 合计 | `1320.1 s` / `22.00 min` |
| worker 启动合计 | `470.0 s` / `7.83 min` |
| test 间隙合计 | `5.5 s` |
| worker 退出/换 session 合计 | `1689.1 s` / `28.15 min` |
| raw failure | 4 |

66 个完整 spec 的时间构成：

| 阶段 | 时间 | 占比 |
| --- | ---: | ---: |
| test body | 22.00 min | 37.9% |
| worker 启动 | 7.83 min | 13.5% |
| test 间隙 | 0.09 min | 0.2% |
| worker 退出/换 session | 28.15 min | 48.5% |

关键结论：退出/换 session 比全部测试断言本身还多 6.15 分钟，是第一主因；测试之间几乎没有空转。

### 4. 分位数

| 维度 | P50 | P90 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| case test body | 10.2 s | 19.6 s | 36.1 s | 94.7 s |
| spec 墙钟 | 44.0 s | 72.4 s | 95.3 s | 247.0 s |

多数 spec 在 test body 之外稳定多出约 30 到 32 秒。进一步拆分后，普通 spec 的启动通常为 4 到 7 秒，退出通常为 25.8 到 26.6 秒。

### 5. 最慢 spec

| spec | case 数 | 墙钟 | test body | 非 test 时间 |
| --- | ---: | ---: | ---: | ---: |
| `conversation-session-background.test.ts` | 18 | 247.0 s | 211.2 s | 35.8 s |
| `conversation-session-model-switch-queue.test.ts` | 2 | 147.0 s | 103.6 s | 43.4 s |
| `coding-plan-team-usage.test.ts` | 5 | 95.7 s | 65.6 s | 30.1 s |
| `conversation-session-read-session-context-timeout.test.ts` | 1 | 95.3 s | 63.9 s | 31.4 s |
| `conversation-session-edit.test.ts` | 2 | 87.4 s | 55.9 s | 31.5 s |
| `conversation-session-model-switch-restore-repro.test.ts` | 2 | 77.0 s | 48.5 s | 28.5 s |
| `conversation-session-compact-actions.test.ts` | 1 | 72.4 s | 41.0 s | 31.4 s |
| `conversation-session-config-and-multisession.test.ts` | 1 | 67.5 s | 36.4 s | 31.1 s |
| `conversation-session-new-session-inherits-model.test.ts` | 1 | 64.2 s | 14.1 s | 50.1 s |
| `conversation-session-fork.test.ts` | 3 | 64.1 s | 33.7 s | 30.4 s |

`background.test.ts` 虽然总耗时最高，但 18 个 case 共用一次 session，固定成本只有约 36 秒，摊销效率很好。它不是优先拆分对象。

### 6. 最慢 case 与时间语义

| case | test body | 分类 |
| --- | ---: | --- |
| queued text 消费前切模型并 auto drain | 94.7 s | 非必要的 fixture 长延迟 |
| ReadSessionContext lite 抽取超过 45 秒 | 63.9 s | 有意覆盖时间边界 |
| edit + held queue | 45.2 s | 失败后吃满等待窗口 |
| compacting actions | 41.0 s | 失败/竞态放大 |
| 多 session 并发切换 | 36.4 s | 真实交互成本 |
| background queue drain | 36.1 s | 受控后台流程 |

`conversation-session-model-switch-queue.json` 的两个 controlled stream 都把尾部事件放在 `90000/90100/90200 ms`。第二个 case 必须等首轮结束后验证 auto drain，因此 94.7 秒几乎全部由 90.2 秒 fixture 时钟决定。这里不需要 90 秒才能证明“切换发生在 running 窗口”。

`conversation-session-read-session-context-timeout.test.ts` 则明确设置：

- lite fixture `delayMs = 55000`
- 第 46 秒断言仍在 streaming
- 目标是覆盖历史 45 秒 timeout

这个 63.9 秒不能通过普通“加快 fixture”处理；应保留语义并明确放入 slow-time-boundary 类别。

### 7. 固定构建成本

最近定向成功 artifact 的总耗时为 `97.7 s`，WDIO spec 输出为 `29.3 s`，test body 仅 `1 ms`。约 `68.4 s` 消耗在 worker 前的 build/prepare。最新全量冷启动到首个 worker 为 `102.5 s`。

当前 `onPrepare` 每次运行都会执行：

1. 遗留 Electron 清理
2. desktop `build:no-runtime-assets`
3. agent server build

这对一次完整全量只占约 1.7 分钟，但对定向调试非常显著。默认入口继续保证 fresh build；另提供显式 reuse-build 入口更合适。

### 8. session 退出主因

`packages/desktop/wdio.conf.ts` 在 WDIO 自己删除 WebDriver session 之前执行：

1. `quitCurrentElectronApp("after")`
2. `electron.app.quit()`
3. 最多等待主进程 1 秒
4. WDIO 随后执行 session 删除
5. `afterSession` 再扫描并强杀遗留进程

该逻辑由 `f93a38d3c fix(desktop-e2e): clean up leftover electron processes` 引入，用于保证 Electron `before-quit` 能回收 host/agent。代码注释同时承认：Chromedriver 持有 session 时，Electron 可能要等 `deleteSession` 才真正退出。

已确认事实：

- 66 个 spec 的退出阶段合计 28.15 分钟
- 普通 spec 稳定约 26 秒
- `wdio-electron-service@9.2.1` 自身 `after()` 只清 Puppeteer session cache，没有 25 秒显式 sleep

待 A/B 证明的单一假设：在 `deleteSession` 之前调用 `app.quit()`，使 ChromeDriver 进入慢关闭路径。不能直接删除这段清理，因为它原本解决 orphan host/agent；必须同时验证退出耗时和遗留进程为零。

### 9. 串行 session 数放大固定成本

111 个 case 分布在 67 个 spec：

| 每 spec case 数 | spec 数 |
| ---: | ---: |
| 1 | 51 |
| 2 | 8 |
| 3 | 3 |
| 5 | 1 |
| 6 | 2 |
| 18 | 1 |

51 个单 case spec 意味着绝大多数 case 都单独支付一次 Electron 启动与退出成本。WDIO 本地文档支持把嵌套 spec 数组顺序放进同一 worker，但本项目 `beforeSession` 会按 spec 注入 HOME、启动配置和 replay fixture，分组必须先验证 fixture 冲突与状态清理，不能全量粗暴合并。

### 10. 并行化边界

虽然配置暴露 `ZCODE_E2E_MAX_INSTANCES`，但当前：

- `E2E_HOME_DIR` 在 config 加载时只计算一次
- 每个 `beforeSession` 都删除同一个 HOME
- cleanup marker 还包含共享 `APP_ENTRY_POINT` 和 `out/main`

因此直接 `maxInstances=2` 会出现 worker 互删 HOME，且一个 worker 的 cleanup 可能强杀另一个 worker。安全并行必须先做到 shard 独立 HOME、artifact、run id，并把进程清理收窄到 shard 自己的 HOME/run token。

### 11. 历史 CI 放大效应

用户提供的历史 Windows CI 日志：

- 62 个 spec，0 passed，62 failed
- 总耗时 `01:27:15`
- worker P50 `125.9 s`、P90 `126.9 s`、P95 `127.4 s`
- 40 个 worker 耗时至少 120 秒
- 后 22 个 worker 少于 15 秒即启动崩溃

日志前段同一基础设施错误反复吃满 120 秒 case timeout；随后积累的 Electron 进程导致 `DevToolsActivePort file doesn't exist`，剩余 worker 快速崩溃。当前 Windows 稳定性提交已经修复其中一部分，但 CI 仍需要“健康门失败即停止派发”的机制，避免下一种基础设施错误再次放大到 2 小时 job timeout。

### 12. 优化方案比较

| 方案 | 预计收益 | 风险 | 建议 |
| --- | --- | --- | --- |
| 修复 26 秒 session 退出 | 串行节省约 18 到 22 分钟 | 可能重新引入 orphan host/agent | 第一优先，必须 A/B |
| 把 90.2 秒 replay 缩到 15.2 秒 | 单次节省约 75 秒 | running 窗口过短会竞态 | 快速收益，定向验证 |
| 兼容 spec 分组复用 session | 视分组数节省 10 到 20 分钟 | HOME/fixture/启动态串扰 | canary 后逐步扩大 |
| 两个独立 HOME 的 shard | 墙钟接近减半 | 资源翻倍、cleanup 互杀 | cleanup 隔离后启用 |
| 直接提高 `maxInstances` | 表面接近减半 | 当前必然互删 HOME | 禁止 |
| 将 55 秒边界 case 移出默认 MR lane | 默认 lane 节省约 64 秒 | 降低每次 MR 的边界覆盖 | 保留 nightly/slow lane |
| 基础设施健康门/熔断 | 正常运行增加约 30 秒 | 多一个入口和 artifact | CI 必做 |

### 13. 目标预算

第一阶段完成标准：

- `worker teardown P50 <= 8 s`
- 串行完整 Windows E2E `<= 42 min`
- `model-switch-queue` 第二个 case `<= 30 s`
- 运行结束无残留 `ZCode E2E`、host、agent 和 Chromedriver 进程

第二阶段完成标准：

- 两 shard Windows E2E `<= 25 min`
- 每个 shard 都产生独立 summary，合并后 case 总数与未分片一致
- 同一基础设施错误最多消耗一个健康门，不再派发 62 个 spec

## 实施计划

### Task 1: 记录 WDIO 生命周期耗时

**Files:**
- Modify: `packages/e2e-report/src/shared/types.ts`
- Modify: `packages/e2e-report/src/node/index.ts`
- Modify: `packages/desktop/wdio.conf.ts`
- Create: `packages/e2e-report/test/node-index.test.ts`

**Interfaces:**
- Consumes: WDIO 的 `onPrepare`、`beforeSession`、`before`、`after`、`afterSession`、`onComplete` hooks。
- Produces: `lifecycle-events.ndjson` 和 summary 中的 `lifecycle` 聚合，后续退出 A/B、预算门和 shard 合并都依赖这些字段。

- [ ] **Step 1: 为 lifecycle event 写失败测试**

测试固定事件模型：

```ts
export type E2ELifecyclePhase =
  | "prepare"
  | "before-session"
  | "before"
  | "after"
  | "after-session"
  | "complete";

export interface E2ELifecycleEvent {
  cid?: string;
  completedAt: string;
  durationMs: number;
  phase: E2ELifecyclePhase;
  specs: string[];
  startedAt: string;
}
```

测试应断言 NDJSON 可追加、同一 `cid + phase` 可聚合、缺少正常 `onComplete` 时已写事件仍保留。

- [ ] **Step 2: 运行 reporter 单测并确认失败**

Run: `pnpm exec vitest run packages/e2e-report/test/node-index.test.ts`

Expected: FAIL，提示 lifecycle writer/summary 字段尚不存在。

- [ ] **Step 3: 实现 lifecycle writer 与聚合**

在 node reporter 返回对象上增加：

```ts
recordLifecycleEvent(event: E2ELifecycleEvent): void;
```

summary 至少输出：

```ts
lifecycle: {
  byPhase: Record<E2ELifecyclePhase, {
    count: number;
    p50Ms: number;
    p95Ms: number;
    totalMs: number;
  }>;
}
```

- [ ] **Step 4: 在 WDIO hooks 中统一计时**

`onPrepare` 先调用 `e2eReporter.prepare(configuredSpecs)` 创建 artifact，再进入计时；增加一个 helper，保证成功和异常都落事件：

```ts
async function measureE2ELifecyclePhase<T>(
  phase: E2ELifecyclePhase,
  context: { cid?: string; specs?: string[] },
  run: () => Promise<T> | T,
): Promise<T> {
  const startedAt = new Date();
  try {
    return await run();
  } finally {
    const completedAt = new Date();
    e2eReporter.recordLifecycleEvent({
      cid: context.cid,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      phase,
      specs: context.specs ?? [],
      startedAt: startedAt.toISOString(),
    });
  }
}
```

- [ ] **Step 5: 运行单测和 E2E typecheck**

Run: `pnpm exec vitest run packages/e2e-report/test/node-index.test.ts`

Expected: PASS。

Run: `pnpm --filter @zcode/desktop typecheck:e2e`

Expected: PASS。

- [ ] **Step 6: 用两个定向 spec 验证 artifact**

PowerShell:

```powershell
$env:ZCODE_E2E_SPEC='./test/e2e/infrastructure/smoke/container-boot.test.ts,./test/e2e/conversation-session/composer/conversation-session-first-send.test.ts'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

Expected: summary 包含 prepare、before-session、before、after、after-session、complete；case 数与原 spec 一致。

- [ ] **Step 7: 提交可观测性改动**

```bash
git add packages/e2e-report/src/shared/types.ts packages/e2e-report/src/node/index.ts packages/e2e-report/test/node-index.test.ts packages/desktop/wdio.conf.ts
git commit -m "test(desktop): record e2e lifecycle timings"
```

### Task 2: A/B 验证并修复 26 秒 session 退出

**Files:**
- Create: `packages/desktop/test/e2e/helpers/e2e-process-cleanup.ts`
- Modify: `packages/desktop/wdio.conf.ts`
- Create: `packages/desktop/test/e2e-process-cleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `after`、`after-session` lifecycle 指标。
- Produces: 一个经证据验证的退出策略，要求 teardown P50 不超过 8 秒且无 orphan process。

- [ ] **Step 1: 为进程筛选边界写失败测试**

测试至少包含两个并发 HOME：

```ts
const ownHome = "C:/repo/packages/desktop/.e2e-home-shard-1";
const otherHome = "C:/repo/packages/desktop/.e2e-home-shard-2";
```

断言 cleanup 只返回命令行含 `ownHome` 的 Electron 根进程及其子进程，不因共享 `out/main` 或 app entry point 选中 `otherHome`。

- [ ] **Step 2: 运行测试并确认当前实现失败**

Run: `pnpm exec vitest run packages/desktop/test/e2e-process-cleanup.test.ts`

Expected: FAIL，因为当前 marker 包含共享 `APP_ENTRY_POINT` 和 `out/main`。

- [ ] **Step 3: 抽出纯进程筛选函数并收窄 marker**

筛选规则固定为：

```ts
isOwnE2EProcess = commandIncludesExactHome(item.command, e2eHomeDir);
```

然后从选中的根进程沿 PPID 收集子树。`onPrepare`、`afterSession`、`onComplete` 都复用同一规则。

- [ ] **Step 4: 增加退出策略 A/B 开关**

```ts
type E2EQuitStrategy = "app-quit-before-delete" | "webdriver-owned";

const e2eQuitStrategy: E2EQuitStrategy =
  process.env.ZCODE_E2E_QUIT_STRATEGY === "webdriver-owned"
    ? "webdriver-owned"
    : "app-quit-before-delete";
```

`webdriver-owned` 只跳过 `after` 中的 `electron.app.quit()`；`afterSession` 仍执行精确 HOME 清理。

- [ ] **Step 5: 对同一组 spec 各运行一次 A/B**

```powershell
$env:ZCODE_E2E_SPEC='./test/e2e/infrastructure/smoke/container-boot.test.ts,./test/e2e/conversation-session/composer/conversation-session-first-send.test.ts,./test/e2e/conversation-session/execution/conversation-session-running-actions.test.ts'
$env:ZCODE_E2E_QUIT_STRATEGY='app-quit-before-delete'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts

$env:ZCODE_E2E_QUIT_STRATEGY='webdriver-owned'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

比较两个 summary 的 `after`、`after-session` P50/P95，并检查进程列表。

- [ ] **Step 6: 按证据选择最终实现**

决策规则：

- 若 `webdriver-owned` 的 teardown P50 `<= 8 s`，全部 spec 通过，main 日志能证明 host/agent 正常关闭，且 `afterSession` 后无 own HOME 进程，则移除永久 A/B 开关并采用 `webdriver-owned`。
- 若 orphan 或 host/agent 未走清理，则保留当前 `app.quit` 策略，不做猜测式删除；转而优先执行 Task 4 的 session 分组与 Task 5 的 shard，并把 ChromeDriver 慢关闭记录为待上游处理。

- [ ] **Step 7: 运行测试**

Run: `pnpm exec vitest run packages/desktop/test/e2e-process-cleanup.test.ts`

Expected: PASS。

Run: `pnpm --filter @zcode/desktop typecheck:e2e`

Expected: PASS。

- [ ] **Step 8: 提交退出优化**

```bash
git add packages/desktop/test/e2e/helpers/e2e-process-cleanup.ts packages/desktop/wdio.conf.ts packages/desktop/test/e2e-process-cleanup.test.ts
git commit -m "test(desktop): reduce windows e2e session teardown"
```

### Task 3: 压缩非必要的 90.2 秒 controlled stream

**Files:**
- Modify: `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-queue.json`

**Interfaces:**
- Consumes: `conversation-session-model-switch-queue.test.ts` 现有 running、queue、model capture 断言。
- Produces: 仍可稳定完成切模型动作，但尾部事件在 15.2 秒结束的 controlled stream。

- [ ] **Step 1: 保留失败前基线**

从 artifact 记录当前第二个 case `durationMs = 94706`，作为优化前基线；不再额外运行旧 90 秒 case。

- [ ] **Step 2: 缩短两个 case-local stream 的 event offsets**

把两组：

```json
[0, 250, 8000, 16000, 24000, 90000, 90100, 90200]
```

改为：

```json
[0, 250, 1500, 3000, 5000, 15000, 15100, 15200]
```

15 秒仍明显大于启动 request、发送 queue 和切 model 的正常交互窗口，同时节省约 75 秒。

- [ ] **Step 3: 更新 fixture metadata**

在 case manifest 的 `syntheticReason` 中写明：该时序只需要覆盖“动作发生时仍为 running”，不覆盖 90 秒 timeout；真实超时边界由专用 slow-time-boundary case 负责。

- [ ] **Step 4: 校验 fixture**

Run: `pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行一次定向 E2E**

Run: `pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/conversation-session/models/conversation-session-model-switch-queue.test.ts`

Expected: 2 passing；第二个 case不超过 30 秒；request capture 仍为 secondary model/thought。

- [ ] **Step 6: 提交 fixture 优化**

```bash
git add packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-model-switch-queue.json packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-model-switch-queue.json
git commit -m "test(desktop): shorten model switch queue replay"
```

### Task 4: 用兼容 spec 分组摊薄 session 固定成本

**Files:**
- Create: `packages/desktop/test/e2e/spec-groups.ts`
- Create: `packages/desktop/test/spec-groups.test.ts`
- Modify: `packages/desktop/wdio.conf.ts`

**Interfaces:**
- Consumes: WDIO 嵌套 `specs` 数组能力和现有 `beforeSession(specs)` fixture 合并逻辑。
- Produces: 显式、可审计的兼容组；默认定向 `--spec` 行为不变。

- [ ] **Step 1: 写分组选择失败测试**

第一批 canary 固定为纯 UI/展示类：

```ts
export const WINDOWS_E2E_COMPATIBLE_SPEC_GROUPS = [
  [
    "./test/e2e/conversation-session/presentation/conversation-session-markdown-table-enhanced-scroll.test.ts",
    "./test/e2e/conversation-session/presentation/conversation-session-markdown-table-layout.test.ts",
    "./test/e2e/conversation-session/presentation/conversation-session-status-panel-inline-layout.test.ts",
  ],
] as const;
```

测试断言：targeted specs 默认不分组；显式开关为 `1` 且 requested specs 完整命中 canary 时允许分组；只命中 canary 子集时保持独立；未分组 spec 顺序与数量不变。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run packages/desktop/test/spec-groups.test.ts`

Expected: FAIL，分组函数尚不存在。

- [ ] **Step 3: 实现 opt-in 分组**

```ts
const groupCompatibleSpecs =
  process.env.ZCODE_E2E_GROUP_COMPATIBLE_SPECS === "1";
```

分组函数只在某个 group 的全部成员都包含于 configured specs 时生成嵌套数组；只命中部分成员时保持独立。reporter 的 configured spec 计数使用 flatten 后的文件列表；WDIO `config.specs` 保留嵌套数组。

- [ ] **Step 4: 运行单测与 typecheck**

Run: `pnpm exec vitest run packages/desktop/test/spec-groups.test.ts`

Expected: PASS。

Run: `pnpm --filter @zcode/desktop typecheck:e2e`

Expected: PASS。

- [ ] **Step 5: 运行一次 canary 分组 E2E**

```powershell
$env:ZCODE_E2E_GROUP_COMPATIBLE_SPECS='1'
$env:ZCODE_E2E_SPEC='./test/e2e/conversation-session/presentation/conversation-session-markdown-table-enhanced-scroll.test.ts,./test/e2e/conversation-session/presentation/conversation-session-markdown-table-layout.test.ts,./test/e2e/conversation-session/presentation/conversation-session-status-panel-inline-layout.test.ts'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

Expected: 三个文件在一个 worker 内顺序执行，case 总数一致，只有一次 before-session/after-session，无 fixture mismatch 或状态串扰。

- [ ] **Step 6: 扩大分组的准入规则**

只有同时满足以下条件的 spec 才能加入后续 group：

- `after` 会 `clearAppData()` 或等价恢复
- 不依赖互斥的 seed startup state
- case-local fixture 合并后无同优先级通用 matcher 冲突
- 单独运行与分组运行的 request capture 数一致

每新增一个 group 单独提交，不一次性合并 51 个单 case spec。

- [ ] **Step 7: 提交 canary**

```bash
git add packages/desktop/test/e2e/spec-groups.ts packages/desktop/test/spec-groups.test.ts packages/desktop/wdio.conf.ts
git commit -m "test(desktop): group compatible windows e2e specs"
```

### Task 5: 增加安全的双 shard Windows 入口

**Files:**
- Create: `packages/desktop/scripts/run-windows-e2e-shards.mjs`
- Create: `packages/desktop/test/windows-e2e-shards.test.ts`
- Modify: `packages/desktop/package.json`
- Modify: `package.json`
- Modify: `.gitlab/ci/20-test.yml`

**Interfaces:**
- Consumes: Task 2 的 HOME 精确进程清理、WDIO `--shard=x/y`、动态 mock/replay 端口。
- Produces: 两个独立 HOME、run id、artifact 的并行 shard；任一失败时总入口返回非零。

- [ ] **Step 1: 写 shard 环境生成失败测试**

每个 shard 必须生成：

```ts
{
  ZCODE_E2E_HOME_DIR: `.e2e-home-${runId}-shard-${index}`,
  ZCODE_E2E_RUN_ID: `${runId}-shard-${index}-of-${total}`,
  ZCODE_E2E_SKIP_BUILD: "1",
}
```

测试断言两个 shard 的 HOME、artifact 和 run id 均不同，命令分别包含 `--shard=1/2` 与 `--shard=2/2`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run packages/desktop/test/windows-e2e-shards.test.ts`

Expected: FAIL，runner 尚不存在。

- [ ] **Step 3: 实现 build-once + two-shard runner**

runner 顺序固定为：

1. 执行 `pnpm --filter @zcode/e2e-report build:node`
2. 执行 `pnpm --filter @zcode/desktop build:no-runtime-assets`
3. 执行 `node scripts/build-desktop-agent-cli.mjs`
4. 并行启动两个 `wdio run wdio.conf.ts --shard=x/2`
5. 等待两个子进程
6. 任一非零则总入口非零
7. 输出两个 artifact 路径，不覆盖各自 summary

- [ ] **Step 4: 增加脚本入口**

`packages/desktop/package.json`：

```json
"test:e2e:windows:sharded": "node scripts/run-windows-e2e-shards.mjs"
```

根 `package.json`：

```json
"test:e2e:windows:sharded": "pnpm --filter @zcode/desktop test:e2e:windows:sharded"
```

- [ ] **Step 5: 运行 runner 单测**

Run: `pnpm exec vitest run packages/desktop/test/windows-e2e-shards.test.ts`

Expected: PASS。

- [ ] **Step 6: GitLab Windows job 使用两个 shard**

job 增加：

```yaml
parallel: 2
```

run id 必须包含 `$env:CI_NODE_INDEX`，WDIO 命令增加：

```powershell
--shard=$env:CI_NODE_INDEX/$env:CI_NODE_TOTAL
```

每个 GitLab job checkout 天然隔离 HOME；artifact 目录仍包含 shard index，避免上传覆盖。

- [ ] **Step 7: 提交 shard 入口**

```bash
git add packages/desktop/scripts/run-windows-e2e-shards.mjs packages/desktop/test/windows-e2e-shards.test.ts packages/desktop/package.json package.json .gitlab/ci/20-test.yml
git commit -m "ci(desktop): shard windows conversation e2e"
```

### Task 6: 增加 CI 健康门、slow lane 与耗时预算

**Files:**
- Create: `packages/desktop/scripts/check-e2e-duration-budget.mjs`
- Create: `packages/desktop/test/e2e-duration-budget.test.ts`
- Modify: `.gitlab/ci/20-test.yml`
- Modify: `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-read-session-context-timeout.json`

**Interfaces:**
- Consumes: Task 1 lifecycle summary、Task 5 shard summaries。
- Produces: 基础设施失败快速停止、慢 case 显式分类、性能回归预算。

- [ ] **Step 1: 写预算检查失败测试**

预算固定为：

```ts
const WINDOWS_E2E_BUDGET = {
  caseP95Ms: 30_000,
  prepareMs: 120_000,
  teardownP50Ms: 8_000,
};
```

允许 `timingPolicy: "slow-time-boundary"` 的 case 超过 case P95 普通预算，但它们必须单独计数并输出原因。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run packages/desktop/test/e2e-duration-budget.test.ts`

Expected: FAIL，预算脚本尚不存在。

- [ ] **Step 3: 标记 ReadSessionContext slow-time-boundary**

manifest 原因写明：`55s` replay 用于证明超过历史 `45s` timeout 后仍继续同一 turn，不能由普通 fast lane 替代。

- [ ] **Step 4: 在 Windows CI 主 suite 前运行健康门**

健康门只运行：

```text
./test/e2e/infrastructure/smoke/container-boot.test.ts
```

健康门负责完成 fresh build；主 suite 设置 `ZCODE_E2E_SKIP_BUILD=1`。健康门失败时直接退出，不派发后续 conversation spec。

PowerShell 中保存主 artifact，再给健康门使用独立目录：

```powershell
$mainArtifactDir = $env:ZCODE_E2E_ARTIFACT_DIR
$mainRunId = $env:ZCODE_E2E_RUN_ID
$mainSpecs = $env:ZCODE_E2E_SPEC

$env:ZCODE_E2E_ARTIFACT_DIR = "$mainArtifactDir-preflight"
$env:ZCODE_E2E_RUN_ID = "$mainRunId-preflight"
$env:ZCODE_E2E_SPEC = './test/e2e/infrastructure/smoke/container-boot.test.ts'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:ZCODE_E2E_ARTIFACT_DIR = $mainArtifactDir
$env:ZCODE_E2E_RUN_ID = $mainRunId
$env:ZCODE_E2E_SPEC = $mainSpecs
$env:ZCODE_E2E_SKIP_BUILD = '1'
```

- [ ] **Step 5: 主 shard 完成后执行预算脚本**

PowerShell:

```powershell
node packages/desktop/scripts/check-e2e-duration-budget.mjs "$env:ZCODE_E2E_ARTIFACT_DIR\summary.json"
```

Expected: summary 完整、普通 case P95 和 teardown P50 在预算内；slow-time-boundary 单独报告。

- [ ] **Step 6: 运行单测**

Run: `pnpm exec vitest run packages/desktop/test/e2e-duration-budget.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交 CI 防护**

```bash
git add packages/desktop/scripts/check-e2e-duration-budget.mjs packages/desktop/test/e2e-duration-budget.test.ts .gitlab/ci/20-test.yml packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-read-session-context-timeout.json
git commit -m "ci(desktop): add windows e2e runtime budgets"
```

### Task 7: 最终验证与基线更新

**Files:**
- Modify: `docs/superpowers/plans/2026-07-10-windows-e2e-runtime-optimization.md`

**Interfaces:**
- Consumes: Tasks 1-6 的 artifact 和 summary。
- Produces: 完整的新基线、实际节省和残余风险。

- [x] **Step 1: 执行机械检查**

Run: `pnpm --filter @zcode/desktop typecheck:e2e`

Expected: PASS。

Run: `pnpm typecheck`

Expected: PASS。

Run: `pnpm lint`

Expected: PASS；已有 warning 与新 failure 分开报告。

- [x] **Step 2: 运行一次完整 Windows E2E**

Run: `pnpm test:e2e`

Result: Windows 默认入口已切换为 build-once + two-shard。只运行一次，两个 shard 都生成完整 summary；结束后无 E2E orphan process。

- [x] **Step 3: 验证双 shard E2E**

Run: `pnpm test:e2e`

Result: 最新用户约束要求全量后不再循环，因此没有再运行第二次 alias。默认 Windows `pnpm test:e2e` 本身已经执行 two-shard，并产出两个独立 summary 和父 manifest。

- [x] **Step 4: 更新本报告的实测结果**

把预测值替换为串行与双 shard artifact 的 run id、总耗时、prepare、startup、test body、teardown、slow lane 和失败分类；保留旧基线用于对比。

- [x] **Step 5: 提交最终基线**

```bash
git add docs/superpowers/plans/2026-07-10-windows-e2e-runtime-optimization.md
git commit -m "docs(testing): record optimized windows e2e baseline"
```

## 2026-07-11 实施与全量实测

### 已实施内容

1. lifecycle reporter 记录 `prepare`、`before-session`、`before`、`after`、`after-session`、`worker` 和 `complete`。
2. `app.quit` 与 WebDriver-owned teardown 做了同 spec A/B：worker 分别为 `34,911 ms` 和 `34,959 ms`。跳过 `app.quit` 只会移动等待位置，没有收益，因此保留原关闭语义。
3. Windows cleanup 改为只匹配当前 run/shard HOME marker，并递归回收其子进程；不再使用共享产品名、app entry 或 `out/main` 作为根 marker。
4. Windows `pnpm test:e2e` 改为先构建 desktop/agent 一次，再并发启动两个独立 WDIO shard。每个 shard 使用独立 HOME、run id、artifact 和 network capture 目录。
5. GitLab Windows conversation job 增加 `parallel: 2`，每个 job 继续保留独立 summary 契约。

### 全量结果

Run id: `desktop-e2e-optimized-full-20260711-final`

Artifact: `packages/desktop/.e2e-artifacts/desktop-e2e-optimized-full-20260711-final`

| 指标 | 实测 |
| --- | ---: |
| 父 runner 墙钟 | `2,926,331 ms`（48 分 46 秒） |
| shard 1 | `2,608,448 ms`（43 分 28 秒），42 spec workers |
| shard 2 | `2,824,532 ms`（47 分 05 秒），41 spec workers |
| 完整范围 | 83 spec workers，184 tests |
| 通过 / 失败 | 177 / 7，pass rate `96.20%` |
| infra / flaky | 0 / 0 |
| test body 合计 | `2,581,448 ms`（43 分 01 秒） |
| 可见 worker hooks 合计 | `203,017 ms`（3 分 23 秒） |
| 未归因 session/WebDriver 成本 | `2,632,773 ms`（43 分 53 秒） |
| worker 合计 | `5,417,238 ms`（90 分 17 秒） |
| 两个 child 串行估算 | `5,432,980 ms`（90 分 33 秒） |
| build-once + parent 固定成本 | `101,799 ms`（1 分 42 秒） |
| 相对同范围串行估算 | 节省 `2,506,649 ms`（41 分 47 秒），墙钟下降约 `46.1%` |

旧基线在 60 分钟外层超时时只完成 66 个 spec，且最后一个 spec 被截断。新结果覆盖 83 个 spec workers 并完整收尾，因此不能把 `48:46` 直接当作同范围的 `60 -> 49`；按本次两个 child 的实际累计时长估算，同范围串行约 `90:33`，two-shard 已接近理论减半。

### 失败清单

本次 7 个失败都被 reporter 分类为产品/断言失败，`infraFailureCount=0`：

| Spec | 原因摘要 |
| --- | --- |
| `conversation-session-background.test.ts` | background child completion notification 未进入父模型请求 |
| `conversation-session-compact-actions.test.ts` | 未捕获到预期 DeepSeek 请求 body |
| `conversation-session-composer-prefix-routing.test.ts` | `/` skill 候选面板未打开 |
| `conversation-session-deepseek-v4-reasoning-request-shape.test.ts` | 当前思考档位仍为 `high`，未切到 `max` |
| `conversation-session-edit.test.ts` | stop 后 active turn 未释放到 completed |
| `conversation-session-markdown-table-enhanced-scroll.test.ts` | resize 前未进入左借位状态 |
| `conversation-session-model-switch-restore-repro.test.ts` | session 重建后任务列表缺少目标 task |

其中 DeepSeek V4 和 edit spec 是运行前工作树里已有的未提交修改；本优化没有修改或提交这两个 case。

### 运行时结论

- 两个 shard 全程同时运行，均完成 summary；结束后未发现 Electron、Chromedriver、host 或 agent 残留进程。
- 两个 child 只相差约 3 分 37 秒，native shard 的耗时平衡已较接近。即使完全加权，理论上也只能再减少约 1 分 49 秒，无法单独达到 25 分钟目标。
- 原计划假设 teardown P50 可从约 26 秒降到 8 秒；A/B 否定了删除 `app.quit` 这条路径。本次数据进一步显示未归因 session/WebDriver 成本约 43.9 分钟，与 test body 43.0 分钟相当，是下一阶段的主成本。
- `tool-cross-product` 单 spec worker 为 `556,880 ms`，但它包含 51 个真实 case；不能通过改变其断言或 fixture 语义来压缩。

### 2026-07-16 GitLab Windows 四分片晋级

Windows conversation-session 自动回归从两个 GitLab 原生 shard 提升为四个。正式链路只使用
GitLab `parallel: 4` 和 WDIO 原生 `--shard=$env:CI_NODE_INDEX/$env:CI_NODE_TOTAL`：

```text
GitLab parallel: 4
  ├─ CI_NODE_INDEX=1 ──> WDIO --shard=1/4 ──> 独立 run id / artifact
  ├─ CI_NODE_INDEX=2 ──> WDIO --shard=2/4 ──> 独立 run id / artifact
  ├─ CI_NODE_INDEX=3 ──> WDIO --shard=3/4 ──> 独立 run id / artifact
  └─ CI_NODE_INDEX=4 ──> WDIO --shard=4/4 ──> 独立 run id / artifact
```

本次晋级不修改正式 spec、fixture、产品代码或 WDIO session 生命周期，也不把本地 canary 使用的
资源采样、历史权重、显式 spec 分区和评估报表带入 CI。`CI_NODE_INDEX/CI_NODE_TOTAL` 继续参与
run id，保证四个 job 的 summary、network capture 和失败证据互不覆盖。聚焦 CI 契约测试必须同时
断言 `parallel: 4`、分片参数和 shard 身份隔离；如果 runner 容量导致基础设施失败率上升，回滚点
仅为该 job 的 `parallel` 数量，不改变 conversation-session 测试合同。

分片后的 summary 覆盖门禁必须使用与 WDIO 9.27 相同的有序分配，不能让单个 summary 继续对照
完整 `ZCODE_E2E_SPEC`。预检仍展开完整 glob，运行后则按配置中的 glob 顺序、每个 glob 内排序，
再使用 `specsPerShard = max(round(totalSpecs / shardTotal), 1)` 和连续 `slice` 得到当前 shard 的
精确期望集合：

```text
完整 formal spec glob ──> WDIO 有序 spec 列表 ──> shard i/N ──> summary i
                              │                                  │
                              └── 同算法 round + slice ──────────┘
                                             精确集合比较
```

每个 shard 必须至少执行一个 test，并且 summary 既不能漏掉本 shard spec，也不能混入其他 shard。
四个 GitLab parallel job 全部通过时，四个互斥 shard 的并集即为预检得到的完整 formal 集合；因此
当前阶段不增加只负责合并 summary 的第五个 job。

### 后续优化计划

1. 基于本次 `worker` event 建立历史 spec 权重，仅用于稳定分片分配；不修改 case 内容。预计收益约 1 到 2 分钟。
2. 对 WebDriver session 创建与 `deleteSession` 增加更细粒度事件，区分 Chromedriver、CDP bridge、Electron process exit 和 host/agent exit，定位 43.9 分钟未归因成本。
3. 只对状态契约明确兼容的 spec 做 session reuse canary；每组仍必须执行原 case、原 assertion 和组间强制 HOME reset。收益需要用 case 总数和通过率机械校验后再扩大。
4. CI 增加单独的 `container-boot` 健康门，基础设施失败时不再派发完整 shard；该项降低失败放大，不改变正常 case 语义。
5. 保留 `ReadSessionContext >45s`、title sidecar `>15s` 和 90 秒 model-switch 等时间边界 case，不通过缩短 fixture 改变通过性判断。

## 预期收益

按当前 66 个完整 spec 估算：

1. teardown P50 从约 26 秒降到 8 秒：节省约 19 到 20 分钟。
2. model-switch queue 从 90.2 秒缩到 15.2 秒：节省约 75 秒。
3. canary 分组扩大后，每减少一个 session 可继续节省约 15 到 33 秒，取决于 teardown A/B 结果。
4. 两个安全 shard：在串行优化基础上把墙钟再降到约一半。

初始目标是串行 38 到 42 分钟、双 shard 20 到 25 分钟。实测 two-shard 为 48 分 46 秒，未达到 25 分钟目标；原因是当前完整范围扩大到 83 spec workers，且退出 A/B 证明 `app.quit` 不能移除。下一阶段必须优先减少 session/WebDriver 固定成本，不能只继续增加 shard 或缩短 case fixture。

## 自检

- 已覆盖正常全量、定向调试、历史 CI 基础设施失败和 slow-time-boundary case。
- 没有建议直接提高 `maxInstances`。
- 没有把 55 秒边界 case 当作普通慢 fixture 删除。
- 所有性能结论都区分“日志已证实”和“需要 A/B 证明”。
- 实施任务包含精确文件、接口、验证命令、成功标准和提交边界。
