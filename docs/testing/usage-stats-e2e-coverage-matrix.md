# Usage Stats E2E Coverage Matrix

本矩阵追踪 [Usage Stats E2E Case Catalog](../usage-stats-e2e-case-catalog.md) 中的行为合同。
`existing-partial` 只表示现有 spec 命中部分断言，不等于 case 已覆盖。

## 现有证据

| Spec | 已证明 | 未证明 |
| --- | --- | --- |
| `packages/desktop/test/e2e/coding-plan/account/coding-plan-team-usage.test.ts` | Team pricing 冷启动、连接方式、个人/Team credit、range、错误隔离与恢复、access freshness、入口可见性、viewport/theme | App Usage；手机 `/remote` UI（按 D1 剪枝） |
| UI/services/CLI focused tests | mapper、日期、统计聚合、hooks 状态、in-flight/backoff、Coding/Start 互斥、Z.AI 来源隔离和错误分支 | 不重复证明真实 Electron 导航 |

## 候选 spec 分组

| Spec abbreviation | Candidate path | Cases | Timing | Status |
| --- | --- | --- | --- | --- |
| `UA` | `test/e2e/usage-stats/application/usage-stats-app-usage.test.ts` | US-AU-01..05 | fast-text | formal-green |
| `UP` | existing `coding-plan-team-usage.test.ts` plus focused extension | US-CP-01..07,09; US-RF-01; US-SY-01..03; US-CM-01..02 | fast-text/fault HTTP | formal-green |
| `UI-focused` | existing UI hook/component tests | US-RF-02..05, US-SY-04, US-SP-01..04, Z.AI isolation | deterministic state tests | green |
| `remote-invariant` | existing desktop shared-host/attachment tests | US-CM-03 | deterministic architecture tests | green |

## 行为覆盖状态

| Area | Cases | UI automation | Runtime/service evidence | Formal | Coverage status |
| --- | --- | --- | --- | --- | --- |
| App Usage | US-AU-01..05 | 2 tests / 5 case IDs green | focused tests + SQLite fixture | formal | covered |
| Personal credit usage | US-CP-01,03..05,09 | CTP-04B/05/07 green | services/UI focused tests | existing spec | covered |
| Team usage | US-CP-02 | CTP-01..06 green | mock request log + UI | existing spec | covered |
| Failure isolation/recovery | US-CP-06..08 | CTP-09 optional + CTP-11 fatal failure recovery | services/UI focused tests | existing spec | representative-covered |
| Access refresh/in-flight/backoff | US-RF-01..05 | CTP-09/10/11 refresh、freshness、失败恢复 | hooks focused tests cover in-flight/backoff | mixed | covered-by-pruning |
| Cross-surface synchronization | US-SY-01..04 | CTP-03 sidebar→Usage、CTP-10 Context access | hooks focused tests | existing spec | representative-covered |
| Coding/Start mutual exclusion | US-SP-01..04 | no duplicate GUI matrix per D3-style pruning | hooks focused tests | focused | covered-by-pruning |
| Compatibility/invariants | US-CM-01..03 | CTP-08 narrow viewport + dark theme green | shared-host/attachment 3 files / 20 tests green | mixed | representative-covered |

## 已验证运行证据

| Run ID | Result | Scope |
| --- | --- | --- |
| `usage-app-coverage-green-20260817` | 2/2 pass，renderer/main/host/CLI coverage 产物完整 | US-AU-01..05 |
| `usage-team-failures-rerun-20260817` | 9/9 pass | CTP-01..08，个人/Team credit、range、窄屏 |
| `usage-combined-green-20260817` | 13/13 pass，四域 `complete=true` | CTP-01..10 + US-AU-01..05 |
| `usage-team-fatal-recovery-20260817` | 12/12 pass | CTP-01..11，含 quota 致命失败恢复 |
| `usage-final-coverage-20260817` | 14/14 pass，renderer/main/host/CLI 全部 `complete=true` | 最终 App Usage + Coding Plan 合并覆盖率 |
| `remote-shared-host-invariant-20260817` | 3 files / 20 tests pass | D1：手机复用 Window Host、可信 `web-remote-replayable` attachment 与生命周期隔离 |
| `usage-app-formal-20260817` | 1 formal spec / 2 tests pass | 不带 manual-review 开关执行 US-AU-01..05，证明晋升后的默认正式入口 |

最终专项核心文件行覆盖率：`AppUsagePanel` 97.22%、`CodingPlanUsagePanel` 80.89%、
`UsageHeatmap` 96.70%、`UsageHeatmapCells` 100%、`UsageStatsErrorNotice` 80%、
`useUsageEntitlement` 91.05%、`useUsageStats` 58.53%、`CodingPlanContextUsage` 90.74%。
未把整个 UI Renderer 的 20% 左右全仓启动覆盖率误报为本分支专项覆盖率。

## Coverage 采集合同

1. 使用 `ZCODE_E2E_COVERAGE=1` 采集 renderer/main/host/CLI 四运行域，任一相关域为
   `incomplete` 时不得报告覆盖率完成。
2. 以 `origin/staging...HEAD` 的可执行变更为目标，docs、tests、类型声明和 `.gitignore` 不进入
   changed-code 分母。
3. 优先补齐用户可观察、高风险的 changed line/function/branch；不可稳定触达的纯防御分支记录原因，
   不为数字制造脆弱 GUI 操作。
4. 四域独立报告，不把 renderer 与 host/CLI 百分比相加。
5. 每轮保留 artifact run id、case pass/fail、四域完整性、相关变更文件的未命中列表。

## 用户剪枝确认

供应商设置补充：CTP-12 `packages/desktop/test/e2e/settings/providers/provider-family-responsive.test.ts` 覆盖真实应用中的长名称宽窄布局、Start tooltip、快捷切换与设置持久化。状态：formal，用户于 2026-09-04 确认转正；正式入口 1 passed，证据 `packages/desktop/.e2e-artifacts/desktop-e2e-20260904060754282-p39563-0c1b2374a55285ca/summary.json`；作为供应商设置正式覆盖，不扩展使用统计业务覆盖，也不代表手机远控验证。

| Decision | Proposed answer | Status |
| --- | --- | --- |
| D1 Desktop 是否完整覆盖，手机 `/remote` 只验证 shared-host 不变量 | yes | answered 2026-08-17 |
| D2 BigModel 个人/Team 完整，Z.AI 只做来源隔离代表样本 | yes | answered 2026-08-17 |
| D3 日期/mapper 极端组合以 focused tests 为主，不复制成 GUI E2E | yes | answered 2026-08-17 |
| D4 viewport/theme/locale 各一条代表样本，不做全组合 | yes | answered 2026-08-17 |

用户已确认 D1-D4；Coding Plan 与 App Usage 用例均已落入 formal spec。App Usage
于 2026-08-17 经用户确认人工 review 后晋升，继续使用隔离 SQLite fixture，不依赖 provider replay。
