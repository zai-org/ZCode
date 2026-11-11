# Plugin Management Lifecycle E2E Coverage Matrix

## 2026-11-10 扩展候选转正

本轮复核 `plugins/extensions/manual-review/pending/` 的 15 个宿主能力候选。产品场景沿用
[case catalog](../plugin-management-lifecycle-case-catalog.md)，不改变产品语义或放宽断言。

- `host-runtime`、`logs`、`network`、`settings`、`start-draft`、`store-extension-compat`
  不发送模型请求，case manifest 显式声明 `providerRequestPolicy: "none"`。
- `entries`、`jarvis-host`、`mention`、`sessions-read` 从已有录制响应整理
  case-local fixture；matcher 限定各自的 prompt marker，不再依赖 `provider-basic.json`。
- `views` 保留既有合成慢流的分块、usage 与 90 秒结束时序，迁入独立 fixture，避免改变生成速率断言。
  固定标题和慢流均声明 `source: "synthetic"` 及原因；普通正文保留真实录制响应，不能把固定样本当作线上模型测速。
- `plugin-project`、`session-approvals`、`sessions-write` 沿用已有独立 fixture，重新检查合同与回放；
  `session-approvals` 移除 manifest 中多余的 `provider-basic.json`，标题与工具回复均由自身夹具提供。

用户已确认人工复核。除 `plugin-extension-sessions` 外，14 个文件均完成正式路径的独立夹具
与默认回放，19/19 测试通过、零跳过。逐文件产物见[本轮转正清单](e2e-business-scenarios.md#2026-11-10-人工复核与转正回放)；
默认产物为 `packages/desktop/.e2e-artifacts/promotion-1110-default`。审批用例移除 legacy fixture 后
以 `promotion-1110-explicit-11-final` 为独立回放证据。
本轮未新增 Docker/三平台 CI admission；下方旧阶段的 pending 与共享夹具记录仅描述当时状态。

`plugin-extension-sessions` 保留 pending：`packages/desktop/.e2e-artifacts/desktop-e2e-20261110-091822-523`
中授权、读取和撤销探针已完成，但设置返回后的侧栏启动页不可见（`side pane launcher should be visible`）。
撤销后的启动页授权行与审计字段断言未执行；测试入口与产品行为的责任边界尚未确认。

> `retired:` 逐处标记已退役 App 单测，仅供追溯；原通过记录不代表现行覆盖。独立断言缺口需由后续验收补齐。

> 2026-10-26：App 业务单测已按[测试规格](unit-test-quality.md)退役。本文中的相关单测路径和历史通过记录不再代表现行覆盖；CLI/CUA、工程测试、E2E 与浏览器验收证据仍按各自状态解释。未补验收的场景不得自动视为已覆盖。

## 2026-10-19 人工复核与正式回放

用户已审阅候选通过项，12 个插件 spec 已完成正式路径的独立 fixture 和默认回放；其余 3 个因标题响应补齐后尚待复验，先保留 pending。
本轮逐文件入口、候选证据及正式回放结果以[批量清单](./conversation-session-e2e-coverage-matrix.md#2026-10-19-人审通过项迁移清单)为准。
`plugin-management-recoverable-failures` 因已记录的来源错误丢失缺陷继续 pending；
`plugin-cdn-zip-official-cdn-smoke` 是用户确认的唯一人工例外。
其他历史段落中的 pending/never 仅描述当时状态；`plugin-no-git-github-archive` 已获准进入正式入口。
本地回放不代表 Linux Docker 或三平台 CI 已验证，该轮没有新增 Docker admission。

本矩阵追踪 [Plugin Management Lifecycle Case Catalog](../plugin-management-lifecycle-case-catalog.md)
中的候选 case 从 manual review 到三平台正式门禁的状态。`manual-review` 不等于默认质量门禁覆盖。

## Coverage status

### 非官方市场风险确认（2026-10-29）

- 浏览器候选：`packages/ui/test/browser/manual-review/pending/plugin-marketplace-risk.test.mjs`，8/8 通过。覆盖未勾选/撤销勾选、按钮/Enter、关闭重开、失败重试、提交中防重、中英文及深浅主题。日志与截图：`packages/desktop/.e2e-artifacts/marketplace-risk-20261029/browser/`。受控提交回调验证共享弹框，不代表真实手机 Host。
- 桌面独立风险用例：`plugins/marketplace/plugin-localization-creator.test.ts` 的“非官方市场必须确认风险才能添加，关闭后重新确认”，1/1 通过；共享添加 helper 显式勾选。运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261029122013512-p41331-196fa3432633342b/`。通过 `ZCODE_E2E_MOCHA_GREP='非官方市场必须确认风险'` 选择此场景。
- 同文件原有完整本地化用例仍在最后的窄屏商店布局断言失败：`clientWidth=269, scrollWidth=306, viewportWidth=390`。恢复基线 `024fde56b5` 的原始弹框、用例和 helper 后结果相同，基线产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261029121823423-p33643-11909677e38e9a71/`。该失败不计为通过，未修改商店布局或放宽断言。
- 本次不新增人工晋级或 Docker/CI 准入；实际手机远控及 Windows/Linux 待验。

### 全部更新回归（2026-10-27）

- `packages/ui/test/browser/manual-review/pending/plugin-update-all.test.mjs`：8/8 通过。
  1200px/en-US/浅色与 390px/zh-CN/深色，分别验证服务实例替换、Scope 切换后切回、
  管理视图卸载时旧批次停止，以及不切换时两项正常完成。使用真实 `PluginList` 和 scoped store，
  服务响应由 fixture 控制；这不是实际 SSH/手机 Host 连接验证。
- `plugins/installation/plugin-management-personal-lifecycle.test.ts`：macOS replay 1/1 通过（34.6s），
  保留行内更新、全部更新成功、v2 runtime 与卸载验证。
- `plugins/installation/manual-review/pending/plugin-update-all-failure.test.ts`：macOS replay 1/1 通过（10.6s）。
  真实目录源故障：列表首项保留 v1，后项到 v2，warning toast 含成功/失败数量和失败插件名；
  恢复来源后重试到 v2，入口消失。case-local fixture 声明无模型请求，fixture check 通过。
- 本轮两份桌面 spec 使用隔离 HOME 同批执行；截图保存在运行产物的
  `plugin-management/plm-lc-003/batch-first-failed-second-updated.png` 与 `batch-retry-complete.png`。
  新增候选未人工晋级，也未新增 Docker/CI admission。Windows/Linux 和真实手机远控未验证。

浏览器入口：`node --test packages/ui/test/browser/manual-review/pending/plugin-update-all.test.mjs`。
桌面候选按 E2E 工作流设置 `ZCODE_E2E_MANUAL_REVIEW=1`，显式使用
`fixtures/upstream/common.json` 与 `fixtures/upstream/plugin-management/plugin-update-all-failure.json`
作为 replay fixture，再运行该 spec。

| Case                                         | Spec abbreviation | UI automation | Runtime/storage evidence                                                                                                  | Human review | Formal spec | Linux Docker | macOS CI | Windows CI |
| -------------------------------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------- | ------------ | -------- | ---------- |
| `PLM-LC-001` discovery/navigation            | `PD`              | targeted pass | UI state + screenshot captured                                                                                            | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-002` presentation                    | `PP`              | targeted pass | DOM/a11y/overflow + screenshot captured                                                                                   | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-003` personal main lifecycle         | `PM`              | targeted pass | overview/list/storage + update badge/inline entry + v2 Skill/MCP provider evidence pass                                   | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-004` persistence/local visibility    | `PV`              | targeted pass | restart/config/enabled/workspace B evidence pass                                                                          | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-005` orphan/reassociate              | `PO`              | targeted pass | source/config/enabled + all update entries (menu/detail/badge/inline) absent + fresh-session Skill evidence pass          | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-006` builtin suppress/restore        | `PB`              | targeted pass | suppression/config/data + Catalog/cache preservation + restart evidence pending                                           | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-007` local official CDN              | `PC`              | targeted pass | loopback HTTP ZIP/cache/overview evidence pass                                                                            | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-007b` real CDN smoke                 | `PCS`             | not run       | not captured                                                                                                              | pending      | never       | never        | never    | never      |
| `PLM-LC-008` recoverable failures            | `PF`              | targeted pass | source/refresh/describe/install/update preservation evidence pass                                                         | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-009` inline smoke                    | `PI`              | targeted pass | UI/list + fresh-session Skill invocation evidence pass                                                                    | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-010` secret env/agent projection     | `PEA`             | targeted pass | MCP resolved marker + no-secret capture + one canonical agent row + Electron `capturePage()` video                        | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-011` no-Git GitHub Archive           | `PGA`             | targeted pass | real Claude Marketplace/plugin HTTP + missing-Git diagnostic; run `desktop-e2e-20260806033745155-p99439-e61ceea7b4c68fcf` | pending      | never       | never        | never    | never      |
| `PLM-LC-012` isolated refresh/atomic cache   | `PRA`             | not run       | partial refresh + persisted failure + rollback evidence pending                                                           | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-014` builtin uninstall/detail parity | `PBD`             | not run       | describe/components + suppression/runtime absence + cache/manifest unchanged pending                                      | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-015` bundled install ownership       | `PBO`             | not run       | bundled restore vs CDN Marketplace ownership evidence pending                                                             | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-016` seed/cache/runtime separation   | `PBS`             | not run       | filesystem/SEA seed, suppressed discovery, describe and self-heal evidence pending                                        | pending      | blocked     | blocked      | blocked  | blocked    |
| `PLM-LC-017` installed row menu layout       | `PML`             | targeted pass | workspace-override row menu single-line text + screenshot                                                                 | pending      | blocked     | blocked      | blocked  | blocked    |

## Candidate spec paths

Todo103 新增/迁接候选：PLM-LC-018/019 对应 `plugins/manual-review/pending/plugin-store-auto-refresh-{throttled,on-enter}.test.ts`；Pro `desktop-e2e-20260909-152018-653` 两例通过。PLM-LC-020 对应 `plugins/runtime/plugin-subagent-override-cold.test.ts`，Pro `desktop-e2e-20260909-152419-828` 冷启动 child/父 continuation 请求验证通过，case-local fixture check 通过。三项均未人工晋级；019 保持公网 smoke、不进入正式 CI。

| Abbreviation | Pending spec                                                                        |
| ------------ | ----------------------------------------------------------------------------------- |
| `PD` / `PP`  | `plugins/marketplace/plugin-management-discovery-presentation.test.ts`                          |
| `PM`         | `plugins/installation/plugin-management-personal-lifecycle.test.ts`                              |
| `PV` / `PO`  | `plugins/installation/plugin-management-persistence-source.test.ts`                              |
| `PB` / `PI`  | `plugins/installation/plugin-management-builtin-inline.test.ts`                                  |
| `PC`         | `plugins/installation/plugin-cdn-zip-marketplace-install.test.ts`                                |
| `PCS`        | `plugins/installation/manual-review/pending/plugin-cdn-zip-official-cdn-smoke.test.ts`           |
| `PF`         | `plugins/installation/manual-review/pending/plugin-management-recoverable-failures.test.ts`      |
| `PEA`        | `plugins/runtime/plugin-runtime-env-agent-projection.test.ts`                               |
| `PGA`        | `plugins/installation/plugin-no-git-github-archive.test.ts`                                      |
| `PRA`        | `plugins/manual-review/pending/plugin-refresh-atomic-cache.test.ts`                 |
| `PBD`        | `plugins/manual-review/pending/plugin-management-builtin-detail-parity.test.ts`     |
| `PBO`        | `plugins/manual-review/pending/plugin-management-bundled-install-ownership.test.ts` |
| `PBS`        | `plugins/manual-review/pending/plugin-management-seed-runtime-separation.test.ts`   |
| `PML`        | `plugins/marketplace/plugin-management-installed-menu-layout.test.ts`                           |

## Latest targeted verification

2026-07-15 已在 macOS 上逐个运行上述 `PD/PP`、`PM`、`PV/PO`、`PB/PI`、`PC`、`PF`
pending spec，均通过。这些 spec 不得并行共享 E2E HOME；允许同一兼容批次串行运行、各用例隔离 HOME 并共享构建。
截图与 provider capture 已生成，但尚未完成人工产品审核，因此本表不会把
任何 case 标成 `formal`，也不会运行 promotion apply、Docker admission 或正式 CI preset。

2026-07-20 已在 macOS 上独立运行 `PEA` pending spec 并通过（run
`desktop-e2e-20260720040616896-p59191-dfc1ae47585cbcf6`）：插件安装详情显示一个 MCP 与一个
agent，Subagents 页面只出现一个规范化插件资源，真实 MCP tool call 返回 resolved marker，provider
capture 与运行日志均不含 synthetic secret。Electron `webContents.capturePage()` 录制生成 2400×1600、
7 秒、28 帧的 VP9 WebM；关键截图与视频已生成，但仍等待人工产品审核。

2026-08-06 已在 macOS 上独立运行 `PGA` pending spec 并通过（run
`desktop-e2e-20260806033745155-p99439-e61ceea7b4c68fcf`）：Agent Git binary 指向不存在的绝对
路径，非 GitHub Git 来源返回 `plugin_git_unavailable`；随后通过 GitHub `zipball/HEAD` 下载真实
Anthropic Claude Marketplace，并按目录中的固定 SHA 安装 `aikido`。Marketplace 与安装缓存均无
`.git`，安装记录保留 URL/SHA，最终 discover 到插件 MCP 组件。该公网 smoke 仍只用于 manual review，
不会晋升为正式 CI 门禁。

2026-08-21 在 Orca 隔离 worktree 完成 Catalog/Runtime 分离的定向回归：Bootstrap 插件生命周期
测试 33/33、Adapters 插件测试 74/74、UI listing/card 测试 20/20；根目录 `pnpm typecheck`
与 `pnpm lint` 通过，lint 仅保留既有 warning。正式手工 E2E（PBD/PBO/PBS）仍待独立隔离 HOME
运行和人工审核，不在本次实现中晋升。

2026-09-02 为「已安装列表可更新角标 + 行内更新按钮」补充 `PM`/`PO` 断言（角标与行内入口出现 /
孤立插件不出现），并新增 UI 单测 `retired:packages/ui/test/pluginStoreUpdateEntries.test.ts`（5/5 通过）。（retired: 为退役历史证据，不计现行覆盖。）
两个 pending spec 未重新运行：它们仍引用已下线的 `plugin-store-manage`、`plugin-store-installed-row`、
`plugin-store-check-updates` 选择器（管理视图已并入 Settings → 插件列表 `plugin-settings-plugin-row`），
需要单独修复后才能再次做 manual review。

## Admission rules

1. Pending spec must have deterministic case-local filesystem/provider fixtures and stable selectors.
2. Manual run must produce list/detail/manage/error/presentation evidence relevant to its cases.
3. Human review changes `Human review` to `approved`; only then may promotion move the spec out of pending.
4. Promoted runtime cases must pass fixture check, common+case isolated replay, and default replay.
5. Each compatibility group must pass one isolated Docker spec before admission to the `plugins` preset.
6. The admitted preset must pass on Linux; the same formal spec set must be selected by macOS and Windows CI.

## Explicit exclusions

- `PLM-BC-001` install cancel, `PLM-BC-002` standalone source diagnose, and `PLM-BC-003` inline
  uninstall remain bug candidates rather than failing lifecycle cases.
- Standalone Web、手机 `/remote`、remote workspace plugin sync 与 workspace-scope 安装没有在本矩阵中
  被标记为 covered。

## PLM-STRIP-CLIP：已安装条角标裁切（2026-09-15）

- 用例：`packages/ui/test/browser/manual-review/pending/plugin-installed-strip.test.mjs`，真实 `PluginStoreListView` + 测试动作回调。
- Chrome/macOS 浏览器 8/8 通过：390/1200px × 中英文 × 明暗主题，验证首末项角标和焦点空间、hover 后命中区域、滚动末尾更新点击、无误开详情及页面横向溢出。原样式复现 top=false / hit=false。
- 截图：系统临时目录 `zcode-plugin-strip-clipping/`。根 typecheck、desktop typecheck:e2e、lint、architecture 检查通过，已有更新入口单测 5/5。
- Pending，未晋升；浏览器渲染与点击验证不代表完整 Electron 插件更新、手机真机或 Windows/Linux 验证。

## Plugin Creator 与本地化

PLM-LC-018/019/020：`plugins/marketplace/plugin-localization-creator.test.ts`，pending、未执行、未人工审核。单测补充异步目标失效、完整 ID 隔离、缺失/禁用 creator；不作为真实手机或 SSH 端到端证据。

2026-09-16 补充：公开分类与个人市场分组默认全部展开，保留手动收起/展开。PLM-LC-001 的断言同步；plugin-localization-creator E2E 增加 8→6→8 张卡片回归，公开/个人与中英组合由组件交互单测覆盖。

## PLM-MISSING-CONFIG

- 状态：manual-review（非正式 CI 转正）。
- 自动化：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs` 中
  `PLM-MISSING-CONFIG`；fixture 经真实 buildStoreItems → PluginStoreListView → 卡片/搜索投影。
- 覆盖：1200/390 宽度、en-US/zh-CN、light/dark；已下架配置不生商品、有目录缺包可安装、新插件不消失。
- 补充：dev Electron 原始配置 → Agent list/overview → Host → Renderer 实测；窄屏浏览器是共享 UI 验证，
  不宣称验证手机真实远控连接。正式隔离 HOME 桌面用例尚未转正。

2026-09-17 验证：`node --test --test-name-pattern=PLM-MISSING-CONFIG packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs` 8/8 通过；dev CDP 验证旧卡片 0、新插件卡片 5、原始 missing 诊断仍保留。重新进入商店后保持结果。

## PLM-DOCUMENT-ORDER（2026-09-17）

默认官方文档插件按 PDF、PPT、Excel、Word 排序。浏览器用例覆盖商店分类和已安装图标条，
桌面/手机 × 中英文 × 深浅主题；预置管理分组、停用、缺项、个人同名隔离及服务端排序优先由单测覆盖。
入口：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs`。
此用例属于浏览器展示验证，不作为 Electron 安装生命周期或正式 CI 准入证据。

## PLUGIN-CREATOR-ICON

官方创建器本地图标贯穿商店、`@` 候选、Composer 标签与 Session 消息投影。
`plugin-picker-order.test.mjs` 的 `PLUGIN-CREATOR-ICON` 用例覆盖 catalog 无远端 icon 时打开候选并插入标签，
1200/390、中英、深浅主题；Session 消息及个人市场同名隔离由 `retired:packages/ui/test/pluginCreatorMentionIcon.test.ts` 覆盖。（retired: 为退役历史证据，不计现行覆盖。）
状态为 manual-review，不自动转正；不向真实模型发送测试消息。

## Agent 插件发现新增候选

`PLM-LC-021` / APD01–APD09：`plugins/marketplace/manual-review/pending/agent-plugin-discovery.test.ts`。2026-09-16 macOS Desktop E2E 1/1 通过，run `desktop-e2e-20260916115741578-p84753-08fac10243dccf5a`；仍为 pending，尚未人工 review，不晋升 CI。

case-local replay 验证 Agent 工具执行 -> 官方目录 -> 确认卡片 -> 跳过不安装 / 确认后实际 ZIP 安装 -> `refreshRequired`。已复核 390px 中文浅色卡片与英文深色安装界面截图；这只代表共享 UI 窄屏渲染，不代表手机 relay。registry/profile/schema/连接协商回归验证两种 delivery profile 及首个应答胜出；实际手机双端操作与断线恢复 E2E 尚未运行。

真实模型选择评测缺少 E2E 模型配置，尚未运行。禁止用 synthetic provider fixture 证明模型会主动推荐。完整检查结果与剩余边界见 [功能 spec](../plugins/agent-plugin-discovery.md#2026-09-16-实施验证)。

2026-09-16 全流程补录：run `desktop-e2e-20260916132529990-p47686-fae27eb93008b51f`，1/1 通过。新增 21.8 秒连续 Electron 录屏与 11 张编号截图，从需求输入到跳过/确认安装及设置页详情；产物 `plugin-management/plm-lc-021/full-flow.mp4`，采集模式 `electron_capture_page`。未改变 pending / 未人工 review 状态。

## 插件市场交互与分类（2026-10-12）

- 2026-10-15 应用插件组内展开回归：`plugin-store-mode-order.test.mjs` 的 `PLM-UI-GROUP` 覆盖公开/社区/个人、默认展示 8 张、原位 8→6→8、其他分类保留、搜索清空和来源往返保留手动选择、键盘操作及宽窄视口的中英/深浅主题。此项为真实浏览器组件交互验证，不代表真实手机远控或 Electron 安装生命周期验证；继续保留 manual-review/pending。

- PLM-LC-001/002：`plugin-management-discovery-presentation.test.ts` 在 macOS Electron 通过，run `desktop-e2e-20261011-170738-518`。覆盖分段搜索、展开/折叠、卡片详情、市场内管理往返与宽窄视口展示。
- PLM-UI-001：`plugin-management-ui-market.test.ts` 在 macOS Electron 中通过，run `desktop-e2e-20261011-170634-701`。覆盖真实安装、已有会话打开 MCP 资源、沙箱握手、关闭不卸载、Side Pane 市场内管理、项目暂停与全局/另一项目隔离、启用后打开、恢复继承和取消/确认卸载。Fixture 静态校验通过；保留 manual-review/pending，不自动晋级。
- 默认推荐浏览器用例：两组已通过，包含未收录开发插件排除、鼠标与键盘打开、标签去重、宽窄视口和双语言主题。
- 原 PLM-STRIP-CLIP 的图标条已删除；对应浏览器测试现覆盖卡片行内更新、焦点可达、管理入口及无横向溢出，8 组通过；另有 UI 详情图片放大、Escape 关闭与焦点返回 2 组通过。原先的历史验证仅代表当时界面。
- 分类与模式排序浏览器回归 18/18 通过：当前分段搜索、默认展开、office 模式、缺包投影及官方文档顺序；保留失败刷新断言。
- 暂未完成真实手机远控、Windows/Linux Electron 验证；窄视口结果不代替这些验证。
- 静态验证：根目录与 CLI 各包 typecheck、root lint、architecture --changed 通过。Root lint 保留既有 warning，架构 0 违规。插件相关 UI 单测 224/224、额外 UI 打开和标签/启动凭据等定向集合通过；CLI bootstrap 生命周期与协议 64/64、目录解析 4/4 通过。
- 截图位于 `packages/desktop/.e2e-artifacts/plugin-management/plm-ui-001/`：`real-ui-sandbox.png`、`side-pane-market.png`、`project-override.png`。沙箱图片使用确定性测试页面，不代表默认推荐插件。
- 插件目录仓库：239 项测试中 219 通过、20 跳过；27 个插件通过校验与发布构建，目录迁移前后所有 ZIP 的路径、字节数和 sha256 相同。尚未发布远端目录。

### Review 修复回归（2026-10-12）

- 全局与 scoped 插件投影、远程同步、Source 用户配置、查询合并、错误保留和旧查询失效：`retired:packages/ui/test/pluginManagementProjectionSync.test.ts` 8/8；包含真实 `useCuaComposerEntry` hook 随市场暂停而隐藏的接线断言。相关 store、错误归属、远程同步、导航和详情组件合计 67/67，启动凭据夹具 5/5。（retired: 为退役历史证据，不计现行覆盖。）
- 浏览器卡片/详情 12/12：新增已安装 UI 的独立详情按钮，暂停态查看详情不触发打开或启用；覆盖键盘与 390 中文暗色 / 1200 英文亮色组合。
- PLM-UI-001：run `desktop-e2e-20261012-050628-695` 通过；真实安装的已启用/暂停 UI 都可独立进入详情，不写启用状态，不新增 UI tab。
- PLM-LC-001/002：run `desktop-e2e-20261012-050703-560` 通过，补充主导航返回聊天且不落入旧设置管理页。
- WPL-015：run `desktop-e2e-20261012-051242-142` 通过，市场安装后回聊天，再进入 User / Workspace 管理；保存、覆盖、清除字段、暂停及恢复继承均保留原断言。旧脚本的启动就绪、面包屑和菜单恢复入口已同步为当前交互。
- PLM-LC-018：run `desktop-e2e-20261012-051408-560` 通过；离开市场回聊天、从侧栏重进仍命中刷新节流，官方目录更新时间保持不变。
- 根 typecheck、lint、architecture 检查通过。真实手机远控、跨版本混装、Windows/Linux Electron 和公网刷新 smoke 未执行；Source/远程同步目前是 store/service mock 回归，不冒充远程端到端验证。所有用例继续 pending，未晋级。

### 第二轮 Review 故障注入

- 插件测试集 241/241 通过。新增次要投影永不返回/拒绝、远程必要能力不被投影阻塞、项目 A 不刷新项目 B 或远程 surface；安装与恢复的诊断错误不失效草稿或刷新技能，成功时仍收尾。
- PLM-UI-001 run `desktop-e2e-20261012-053949-887` 通过：同时移除原始与 managed 源包，真实安装错误可见且未生成安装记录；恢复源包后重试成功，后续完整 UI 沙箱、项目覆盖、继承和卸载回归通过。
- PLM-UI-001 run `desktop-e2e-20261012-090553-480`、`desktop-e2e-20261012-092305-636`（启动页文案对齐原型后）通过；用例全程录屏为 `plm-ui-001.webm`，并输出步骤时间点 `plm-ui-001.chapters.json`：市场头部与 Side Pane 启动页对齐原型后回归；按 PRD 章节输出 01–15 编号截图（`.e2e-artifacts/plugin-management/plm-ui-001/`），截图前等待有限时长动画结束。回放模型无 high 思考档，运行时设 `E2E_PROVIDER_THOUGHT_LEVEL=` 并显式指定 case fixture。
- root typecheck、lint（0 errors / 222 warnings）、architecture（0 违规）及 E2E typecheck 通过。平台与混装验证限制不变。

### 打开 UI 收敛到会话右侧市场（2026-10-12）

- 规则：主导航市场的卡片与管理页行整行进入详情，没有「打开」「详情」按钮，详情主按钮为「立即试用」；会话右侧市场的卡片、详情、管理页行多一个「打开」（暂停态「启用」，先启用再打开）。
- 浏览器卡片/详情 14/14：新增 `PLM-UI-MAIN-NAV`（主导航无打开、整行进详情、详情为立即试用）；`PLM-UI-DETAILS` 改为键盘回车整卡进详情。
- PLM-UI-001 run `desktop-e2e-20261012-104955-651`、`desktop-e2e-20261012-105655-477`、`desktop-e2e-20261012-105824-912` 通过；步骤截图 06–16 改为主导航无打开 → 右侧市场打开 → 右侧管理页打开 → 项目暂停后右侧「启用」并打开 → 管理页整行进详情恢复继承。用例在主导航断言前关闭右侧市场标签：会话视图后台保持挂载，两份市场并存会让按 testid 取到隐藏的那份。
- 已知偶发：`desktop-e2e-20261012-105221-558` 在主导航第二次进入管理页时等待 `plugin-store-manage` 超时，随后 3 次连跑未复现，原因未定位。

### 服务端 UI 推荐（2026-10-13）

- `side-pane-plugin-menu.test.mjs` 不再替换静态名单模块，改为请求配置响应并通过真实公开配置解析器。
- 1200px / 英文 / Zai Light 和 390px / 中文 / Zai Dark 两组通过：推荐交集、重复项去重、未收录开发插件与未知面板排除、启动页/菜单、键盘打开，以及空配置/请求失败回归。
- 可选 `ZCODE_UI_RECOMMENDATIONS_LIVE_CONFIG_URL` 接入真实测试环境配置；本次接口返回 5 条推荐并完成展示和打开参数断言。工作区面板仍由 fixture 提供，不代表真实安装或沙箱运行验收。
- 真实 Host 配置服务连接测试接口：并行读取仅发一次请求，后续读取命中缓存，5 条插件/面板身份与已校验发布包一致。
- Nacos 测试配置保留原有 16 项，只追加 `uiPluginRecommendations`；使用原 MD5 发布、精确回读，并核对公共接口返回。生产配置未修改。
- 未重跑各插件的真实安装与沙箱运行，也未做 Windows/Linux 或真实手机远控实机验证。用例保留 pending，不晋级。

### 推荐区安装与启用（2026-10-13）

- 推荐曝光改用完整目录，未安装与禁用条目仍显示；配置顺序和完整身份去重保持稳定。
- `useRecommendedUiPlugins` 回归覆盖用户级安装、项目级启用、重复点击、失败重试、服务切换与会话切走再切回后的迟到结果隔离；复用现有插件管理 store。
- `side-pane-plugin-menu.test.mjs` 增加启动页和加号菜单的“安装 → 启用 → 再次点击打开”流程，成功后断言没有自动打开；同时断言实际服务请求的 user/workspace scope。安装与启用时菜单保持打开。
- 浏览器夹具模拟安装服务与面板目录；真实 staging 只用于验证推荐配置响应。此轮不重复真实插件安装、沙箱、Windows/Linux 或手机设备验收。

### 推荐加载态（2026-10-13）

- 受控浏览器请求复现：配置尚未返回时旧实现已经显示“No recommended UI plugins yet”。
- 现在配置与完整目录任一仍在加载时显示骨架。浏览器用请求闸门分别释放配置和目录，断言中途不出现空态；另覆盖加号菜单从加载到空配置，以及失败结束加载。宽窄视口与双主题沿用同一组用例。

### 生命周期埋点（2026-10-15）

| Case        | 场景                   | 用例                                         | 验证                    | 状态               |
| ----------- | ---------------------- | -------------------------------------------- | ----------------------- | ------------------ |
| PLM-TEL-001 | 插件安装最终结果与隐私 | `plugins/telemetry/plugin-lifecycle-telemetry.test.ts` | macOS Electron 回放通过 | pending，未加入 CI |

验证批次 `desktop-e2e-20261015031949530-p54859-5f1860f2585df3f1`：真实商店详情安装成功，最终 HTTP 出口仅一条 install 结果，含 event_id 和 duration_ms，无 operation_id 和路径。手机白名单、远端同步结果与 MCP 归属由定向单测验证；Windows/Linux 和真实远端安装未运行。

### 后台初始化与执行（2026-10-15）

`PLM-UI-DISPLAY-MODES`：2026-10-19 macOS Electron 44.7.0 的 `mcp-apps-host-e2e.mjs --rows-only` 12 组场景通过，覆盖注册展示模式、握手前隐藏、打开卡片及关闭/重挂；`--managed-only` 的鼠标交互、Web/remote 回退和页面保留回归通过。`plugin-ui-launcher.test.mjs` 8/8 通过（390/1200px × 深浅主题 × 中英文），含图标解码、长标题、键盘打开与截图。人工审核与 CI 晋升仍 pending；这些证据不等同 Windows/Linux 或真实手机验证。

同日补充 fullscreen 呈现回归：现场工具行指定 fullscreen，页面允许双模式；旧实现关闭侧栏后恢复 inline。新增断言先复现失败，再验证未声明/双模式页面指定 fullscreen 后，关闭与重挂只留卡片、请求 inline 不关闭侧栏。同一 guest ID、一次启动/资源读取/登记、React 状态和隐藏期间双帧执行保持；后续成功调用指定 inline 可复用原 guest。上述 Electron 两个入口及 8 个视觉场景复跑通过，受影响单测 76 文件 / 1,176 条通过。

真实安装的 VectorCraft 现场 CDP 复核通过：关闭与重新打开侧栏时，对话 inline 数量始终为 0、打开卡片为 1；WebContents ID 与 sandbox URL 不变。插件 iframe 内的临时内存标记保留，关闭期间双帧执行完成；检查后清除标记。截图确认关闭侧栏后没有编辑器大块内联区域。此项为本机运行证据，不替代跨系统验证。

新增可见性断言暴露了 rows 夹具缺少 `contents` 样式导致侧栏高度为 0，已补齐。握手后才显示 guest 的新时序要求鼠标夹具等待绘制帧；旧断言首次点击丢失、下一次点击到达 guest 的运行轨迹已定位，调整的是测试就绪边界，产品不增加延时。

| Case                        | 场景                                                                                                                                | 入口                                                                                 | 边界                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| PLM-UI-BACKGROUND           | 无锚点/隐藏 tab 冷启动、最小化后首次创建与执行、session 空闲时仍执行且不销毁、删除释放                                              | `mcp-apps-host-e2e.mjs --background-only`                                            | 真实 Electron、生产 owner/Agent/沙箱；受控页面，未晋升 CI                                        |
| PLM-UI-BACKGROUND-ADMISSION | 无卡片挂载和 conversation 订阅的真实工具结果首次创建、后台运行、返回复用；双窗口不同会话的同插件实例保留与释放                      | `mcp-apps-host-e2e.mjs --background-only`                                            | macOS Electron 通过；同窗口并发准入和不同会话键隔离另以单测覆盖，未晋升 CI                       |
| PLM-UI-VISIBILITY           | 保活侧栏收起、切标签、离开聊天/工作区时不可见且不拦点击；后台工作、编辑状态及实例保留，恢复交互                                     | `mcp-apps-host-e2e.mjs --managed-only`                                               | macOS Electron 深浅主题通过；生产组件集成，宿主页面投影另以桌面/手机壳 UT 覆盖，未晋升 CI        |
| PLM-UI-BACKGROUND-CRAFT     | 最小化窗口且无卡片时，真实工具结果触发 WASM 首次初始化；后台图层操作、编辑状态保留与恢复展示截图；切主页面后隐藏 UI、后台编辑并返回 | `mcp-apps-host-e2e.mjs --photocraft-background-only`，设置 `ZCODE_PHOTOCRAFT_SERVER` | macOS Electron 通过；未修改的 PhotoCraft 0.2.2，恢复截图包含后台新增图层，不替代商店安装路径验证 |

Web/remote 不支持回退、runtime 失效、内联滚动与页面保留沿用 `--managed-only`。
Windows/Linux、真实手机和其它第三方插件需独立验证。

`PLM-UI-SESSION-READY`：`--managed-only` 增补持久会话冷恢复与插件面板同时打开；
runtime preferences 响应闸门控制 ready，断言等待期间无 error/guest，放行后一次恢复、
一次资源读取和一个运行实例。2026-10-30 macOS Electron 通过：managed 31 项、interaction
1 项、managed-empty 1 项。通过真实 `session/resume` 恢复，显式 MCP 配置来自受控夹具；
隔离 Agent bundle 仅移除首次打开的 `ensureReady` 等待时，同一用例失败并报
`runtimeNotReady`。CLI 定向回归 67/67 通过，覆盖并发恢复、失败与失效实例。
证据：`packages/desktop/.e2e-artifacts/plugin-session-ready-20261030/`。
共享 Web/remote 不支持回退已验证；真实手机 Host 和实际第三方插件未复验。

2026-10-30 人工确认转正，正式入口为 `plugins/runtime/plugin-ui-session-ready.test.ts`。复用
`--session-ready-only` 的受控 Electron 场景；HOME、provider 和 MCP 配置独立，
不依赖本机认证或默认内置插件。正式 fixture 合同检查通过；macOS 独立 fixture 回放
1/1 通过，证据 `packages/desktop/.e2e-artifacts/desktop-e2e-20261030-110012-856/`。
默认回放同样 1/1 通过，证据
`packages/desktop/.e2e-artifacts/desktop-e2e-20261030-110044-381/`。
Linux Docker 断网单例 1/1 通过，证据
`packages/desktop/.e2e-artifacts/plugin-session-ready-linux-admission-v3-20261030/`，
已通过准入工具加入 `plugins-verified`，`pnpm test:e2e:container:plugins` 同样 1/1 通过，
证据 `packages/desktop/.e2e-artifacts/plugin-session-ready-linux-preset-20261030/`。
共享 managed 31 项、interaction 和 managed-empty 同样通过，
证据 `packages/desktop/.e2e-artifacts/plugin-ready-promotion-managed-regression/`。
现有 macOS/Windows CI 的插件 glob 可收集，
但这些 job 仍为手动可选任务；本地通过不代表远端 CI 或原生 Windows 已运行。

`PLM-UI-CONNECTION-READY`：`--managed-only` 控制真实 MCP initialize 完成顺序，验证生产
React 面板等待连接后自动运行、无错误闪现和重复实例。2026-10-16 macOS Electron 专项通过；未晋升 CI。
独立 worktree 使用标准命令整组回归，`managed` 27 项、`managed-empty` 1 项、`interaction` 1 项全部通过，
证据批次 `zcode-mcp-host-e2e-f1vN0y`。此前整组运行出现过 guest 崩溃重建超时和锚点切换后
点击断言失败，独立复跑均通过；保留原失败证据，不据此认定稳定性问题已解决。

## PLM-CONCURRENT-INSTALL：并发安装忙碌态

- 浏览器候选：`packages/ui/test/browser/manual-review/pending/plugin-concurrent-install.test.mjs`。真实 store 和安装按钮，390/1200px × 中英文 × 深浅主题共 8 组通过；旧实现 8 组均在第二次安装清掉第一次忙碌态处失败。日志和截图写入系统临时目录的 `zcode-plugin-concurrent-install/`。
- 桌面正式用例：`plugins/installation/plugin-concurrent-install.test.ts`。macOS Electron + 真实 CLI，个人来源本地 HTTP 下载响应门验证两项同时安装中、第一项失败不清理第二项、两项失败后均可重试；运行 `desktop-e2e-20261015143344848-p62610-27dafbf8f737df99` 通过。截图位于 `.e2e-artifacts/plugin-management/plm-concurrent-install/both-pending.png`。
- 离线执行：`ZCODE_E2E_MANUAL_REVIEW=1 E2E_PROVIDER_HTTP_MODE=replay E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/plugins/installation/plugin-concurrent-install.test.ts'`。
- PLM-DETAIL-DURING-INSTALL：同一桌面用例中，A 下载被响应门挂起、B 排在 A 后面时打开本地插件详情，组件区 30 秒内渲染技能，返回后两项仍为安装中。修复后运行 `desktop-e2e-20261019044431890-p93406-b0458048236a975f` 通过，截图 `.e2e-artifacts/plugin-management/plm-detail-during-install/detail-loaded.png`；还原 CLI 修复后运行 `desktop-e2e-20261019044633752-p3203-b44c097feed8ea0d` 在组件区等待处失败。
- 新建右侧标签页骨架屏（list/overview 排队）：同一桌面用例在 A 下载挂起、B 排队时经桌面服务链路请求 `listPlugins` 与 `getPluginsOverview`，要求 10 秒内返回。修复后运行 `desktop-e2e-20261019062945458-p57938-d3a0c643c27817e2` 通过；只还原 transport 的 list/overview 立即派发后，运行 `desktop-e2e-20261019063058281-p64564-98a2c55f0e022488` 在该步失败（`plugins/list and plugins/overview waited for the install`）。现场证据：dev 日志 `listPlugins`/`getPluginsOverview` 耗时 14569 ms，在第二次安装结束 1.4 秒后才返回。
- store 回归覆盖成功乱序、失败、同名操作及上下文切换隔离、来源校验与安装交叠。浏览器成功路径使用受控服务，不等于真实下载成功验证。手机真机/远控、Windows/Linux 未执行。浏览器用例 pending；桌面用例已转正，PLM-DETAIL-DURING-INSTALL 与 list/overview 两步经作者确认随之转正。

WPL-009 与 PGA 的 Agent bridge setup 先通过侧栏进入指定项目草稿，使 workspace App 注册真实服务入口。全局未归类草稿没有这组 action，不能用轮询时长替代前置导航。

## PLM-BUILTIN-UI-UNINSTALL：内置 UI 插件卸载后的分组

- 桌面候选：`plugins/installation/manual-review/pending/plugin-builtin-ui-uninstall.test.ts`。macOS Electron + 真实 CLI，卸载 `documents@zcode-plugins-official` 后卡片仍在 UI 插件专区。修复后运行 `desktop-e2e-20261019071852360-p65132-d5426628aee5a21e` 通过，截图 `.e2e-artifacts/plugin-management/plm-builtin-ui-uninstall/restorable-in-ui-section.png`；还原 CLI 修复后运行 `desktop-e2e-20261019072006864-p72979-1022c7e87a447a4e` 在 restorable 阶段失败（卡片不在 UI 插件专区）。
- bootstrap 单测：内置定义 `ui` 组件类型与插件包 `ui.surfaces` 一致；卸载后官方目录与可恢复列表都带 `ui`。两条旧实现失败、新实现通过。Windows/Linux、手机远控未执行；用例 pending。

## 2026-10-22 市场与管理列表统一回归

- `desktop-e2e-20261022-063537-838`：WPL-015、全局市场/工作区配置隔离、PLM-UI-001 通过。覆盖真实安装、市场卡片停用/启用、User/Workspace 配置与继承、MCP 沙箱打开及卸载；模型响应使用仓库回放 fixture。
- `desktop-e2e-20261022-064056-895`：PD/PP 通过。市场与管理返回、搜索/分段保留、中英文和宽窄窗口通过；开关透明点击区收紧至卡片边距后不再产生 4px 横向溢出。
- `desktop-e2e-20261022-063909-309`：PLM-LC-017 通过。开关外显、无逐行来源标签、菜单仅卸载且文字不折行。
- WPL 的 workspace-enabled / workspace-inherited 两个额外 pending 用例在 beforeSession 缺少隔离 HOME 的 `cli/config.json` 时停止；未执行到 UI 断言，不记为通过。其来源标签断言已对齐当前列表，Agent 配置来源断言保留。
- 全部用例仍保持 manual-review/pending，不据此自动晋级三平台正式门禁。真实手机远控未验证。

- `desktop-e2e-20261022-064824-136`：PLM-LC-008 通过。无效来源/来源冲突、刷新/describe/安装/升级失败与重试通过；用例等待列表初始化，使用弹窗错误提示、现有刷新与详情更新入口。

`PLM-UI-RETENTION`：2026-10-22 macOS arm64 / Electron 44.7.0 通过。`mcp-apps-host-e2e.mjs --managed-only`
验证资源声明、默认页隐藏后五分钟销毁、widgetState 重建与五页三十分钟后回收到四页；
批次 `zcode-mcp-host-e2e-Hlpooh`，包含既有生命周期/Web/remote 回退回归。补充回收期间重新打开
用例：修改前 `zcode-mcp-host-e2e-YMaWa1` 卡在加载，改为读取展示锚点后
`zcode-mcp-host-e2e-oLrXdc` 通过。时钟单测覆盖
4/30 边界、活动、忙碌与竞态；既有后台夹具改为显式声明保留。首次未声明页运行暴露握手前
`display:none` 阻止 guest 挂载，现仅在握手前提供承载面，握手后恢复普通隐藏策略。
真实 PhotoCraft `0.2.4` 最小化初始化、文档/图层操作、同 guest 恢复和删除释放通过，
批次 `zcode-mcp-host-e2e-zv1BoS`；不替代商店安装路径。Windows/Linux 未执行，未晋升 CI。
显式保留页面的无锚点冷启动、最小化执行、普通 guest 隔离、闲置后同实例恢复和删除释放
由 `--background-only` 批次 `zcode-mcp-host-e2e-ulYszp` 验证通过。

迁移到 `hotfix/3.16.3` 后，macOS arm64 / Electron 41.0.3 重新验证：`--managed-only`
批次 `zcode-mcp-host-e2e-TXkv1P` 通过默认回收、五页预算、回收中重开及既有生命周期回归；
真实 PhotoCraft `0.2.4` 批次 `zcode-mcp-host-e2e-mVIb8h` 通过最小化首次启动、后台编辑、恢复和删除。
`--background-only` 批次 `zcode-mcp-host-e2e-MDAfE9` 通过无锚点冷启动、最小化执行、闲置恢复与删除释放。
沿用该分支的展示模式与子 frame 导航行为，启动承载面由握手 phase 收束，不依赖可选 App capabilities。

### 草稿 MCP UI 增补

2026-10-19 完全访问修复：PLM-UI-001 增加草稿审批卡完全访问、Composer 同步、后续工具调用与首发保持权限；run `desktop-e2e-20261019103901369-p31239-d00a1707b0be388d` 完整通过并录屏；包含零 session/entry 行数、首发同一 session/guest 和授权后的工具调用。用例仍为 pending。

`PLM-UI-001` pending 用例增加零首轮打开、主导航回到原草稿、首发提升复用 guest 的断言。定向单测覆盖草稿保活/释放、代际失效、pane 身份、市场迟到结果、上下文保留、V4 删除取消 UI 调用和凭证隔离。macOS Electron run `desktop-e2e-20261016160029489-p71731-393c1051e3804bad` 通过，包含工具权限允许/拒绝、侧栏关闭重开和跨工作区返回。E2E 类型检查与 fixture 检查通过；尚未人工验收，不转正。

2026-10-17 P2 回归：`PLM-UI-001` run `desktop-e2e-20261017020217277-p10138-e212efe6fd1c84c2` 通过。新增真实 createSession RPC 暂停→主导航打开→切正式会话或另一工作区→回同项目草稿的取消断言；原草稿 guest 状态、首发和市场生命周期回归全部通过。首次运行因读取旧 draftRuntime 判断预热就绪而超时，改等真实插件 session 驱动的推荐入口后通过。跨工作区分支在补修前明确失败（旧请求仍非空），应用层订阅 tab 导航同步取消后通过。V4 删除等待退订、双插件待发送上下文隔离和草稿请求四类失效由定向单测补充；用例继续 pending。

2026-10-19 合并回归：`PLM-UI-001` 增加草稿插件进入、退出侧栏完整视图的断言，检查同一 guest、未发送输入和零聊天行；Electron 44.7.0 run `desktop-e2e-20261019083107091-p99047-88013d9eda47c582` 通过。该用例覆盖允许一次与拒绝，不覆盖审批卡「完全访问」；随后真实 PDF 草稿实测发现完全访问授权缺少 session 主记录时发生外键错误，尚待修复与补充回归。

真实 PDF Dev 复测确认 check_document 完全访问成功，后续轮询使用 yolo，无授权 gateway 错误且仍无 session/entry/message 持久记录；已有待审批请求保持原逐项应答/超时规则。独立复审无阻断项，草稿 rehydrate 与 pending 持久化拒绝路径的直接故障注入仍为非阻断测试缺口。

2026-10-19 再次合并回归：PLM-UI-001 增加完全访问风险确认的勾选和确认步骤，确认前断言权限未变化；草稿页面单测同时覆盖握手前隐藏、fullscreen 能力登记、pane 卸载后的保活和最终释放。
验证结果：macOS Electron 44.7.0 run `desktop-e2e-20261019141816996-p97481-20715c08f4641950` 一次通过（1/1，0 skipped），录屏保留；用例继续 pending。

### 2026-10-28 草稿集成验收

现行入口为已转正的 `plugins/marketplace/plugin-management-ui-market.test.ts`，保留首轮前打开、审批、跨工作区返回、首发同 guest 和过期打开请求取消。2026-10-19 及更早的 App 单测记录为退役前历史证据；session 清理沿用统一生命周期 owner，仍由 CLI 回归验证。

本轮 macOS Electron 44.7.0 run `desktop-e2e-20261028080939958-p772-17d40b5d35bfdf55` 完整通过（1/1，0 skipped），包括项目子菜单选择和原草稿全部断言，录屏及关键帧已留存。CLI 138 项与共享审批浏览器 8 项通过；浏览器覆盖 390/1200px、深浅主题，不代表手机实机。

## PLM-MANIFEST-ISOLATION：外部清单兼容与列表隔离

候选桌面入口：`packages/desktop/test/e2e/plugins/runtime/manual-review/pending/plugin-manifest-isolation.test.ts`。
安装带未知 `userConfig.options` 的插件后，列表、其他插件安装和已安装能力仍可读取；
停用再启用及刷新仍保持正常。损坏已知字段时只隔离该插件并返回带 pluginId 的诊断。
浏览器候选入口：`packages/ui/test/browser/manual-review/pending/plugin-load-isolation.test.mjs`。
覆盖列表失败、目录失败、双失败和重试恢复；390/1200px、深浅主题、中英文与来源未知状态。
人工审核、正式晋升及 Docker 准入保持 pending；验证结果以本次实际执行记录为准。

验证：macOS Electron 安装、停用/启用、刷新、原始清单不变和坏字段隔离通过；
桌面深浅主题已截图并录屏。CLI adapters/bootstrap 154 项通过，浏览器 12 个场景通过。
未验证 Windows/Linux 桌面和真实手机远控连接；窄屏浏览器验收不代表真实远端验证。

PLM-LC-021 默认安装启用增量：用户级禁用、当前工作区禁用、另一工作区禁用 → 跳过无写入 / 确认安装并启用当前工作区 → 自动重载一次、同会话调用 Skill。2026-11-04 macOS Desktop 1/1 通过，证据 `packages/desktop/.e2e-artifacts/desktop-e2e-20261104042250898-p45785-8b366e21e2bed63b`；仍为 manual-review/pending，未晋升 CI。

PLM-LC-021 多语言载荷增量：超大翻译表后的中文窄屏和英文卡片、跳过/安装/重载，2026-11-04 macOS Desktop 1/1 通过，证据 `packages/desktop/.e2e-artifacts/desktop-e2e-20261104035826613-p41163-a7c77319f5ea2824`；用例保持 manual-review/pending，未晋升 CI。CLI 定向检查覆盖每项及整表字节预算、支持语言回退、非法键和序列化事件回放。

PLM-LC-021 设置增量：默认关闭、持久化、下一次输入按开关提供或隐藏插件搜索和推荐工具，2026-11-04 macOS Desktop 1/1 通过，运行 `desktop-e2e-20261104033807665-p58349-3fcf657995c2b204`；实际手机 relay 未运行。

PLM-LC-021 新断言：安装后保留任务、自动换代、没有额外用户输入或模型请求，下一条显式输入执行 ZIP 插件 Skill。2026-11-03 macOS Desktop 1/1 通过，运行 `desktop-e2e-20261103124904313-p61172-59e756836ce2d8a0`；保留 pending，未转正。

### 2026-10-30 v3.17.2 移植验收

`PLM-UI-001` 在 hotfix 基线移植后首次运行通过（1/1、0 skipped），macOS arm64 / Electron 44.7.0。证据目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20261030044614273-p5180-8d87823b0b07505c`，包含录屏、草稿授权后与首发后关键帧。原草稿入口、审批、零正式任务、跨工作区返回、首发同 guest、完整视图及旧打开请求取消断言全部执行。CLI 138 项、浏览器 8 项及类型/lint/架构/fixture 检查通过；不将历史 App 单测或工程 affected 未选中结果算作本轮通过测试。桌面为中文深色，审批浏览器覆盖 390/1200px、深浅主题；真实手机、Windows/Linux 和长时回收未验证。

2026-11-04 release/staging 合并回归：`PLM-UI-001` 在 macOS Electron 完整通过（1/1、0 skipped），工件为 `packages/desktop/.e2e-artifacts/desktop-e2e-20261104105833379-p99703-a8c78a339b020c64`。用例按现有审批交互显式选择完全访问，并只操作可见 workspace 的侧栏控件，保留原布局断言；覆盖草稿授权不落正式会话、授权后调用、首发同 guest、工作区切换、旧打开请求取消和插件生命周期。权限浏览器回归 23/23 通过，覆盖 390/1200px 与深浅主题。远端草稿 SSH E2E 本轮未执行，不将本地结果计作远端或实体手机验证。

## PLM-EXT-2A：扩展进程基础设施与插槽（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-host-runtime.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-2A。

| 子项                         | 状态    | 证据                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a composer.status 显示与点击 | covered | 条目紧挨模型控件组之前；点击日志 `E2E_EXT_COMMAND_RUN scope=session`（草稿预热会话），文字变为 `E2E #1`                                                                                                                                                                                                                                                                                    |
| b 杀进程后 gen + 1 重启      | covered | `gen=1 ... intent=crash` → `gen=2 status=running`，扩展重新激活，插槽文字回来                                                                                                                                                                                                                                                                                                              |
| c 卡死、预算耗尽、重新加载   | covered | 死循环约 20 秒（含点击后的首次探测间隔）判为 `unresponsive`；第 3 次崩溃按 4s 退避重启，第 4 次崩溃 `status=stopped`，启动页「扩展已停止」可见；命令中心「重新加载扩展」后 `gen=5 status=running`                                                                                                                                                                                          |
| d 清单非法 / 版本不兼容      | covered | 启动页问题行标签与悬停原因，invalid 带 `extension.contributes.commands[0].titel`；P2a：`e2e-ext-status` 一行「清单非法」带 `slots["sidePane.launcher"][1].target.view`，它的其他条目照常；Window Host `static table rev=1 plugins=16 extensions=2`、`declarations pushed gen=1 extensions=2`、`manifest ignored ... slots["future.slot"]`；扩展进程内 `E2E_EXT_UNUSABLE_ITEM not-declared` |
| e 环境变量白名单             | covered | 非白名单键只有 macOS 系统注入的 `MACH_PORT_RENDEZVOUS_PEER_VALDATION`、`__CF_USER_TEXT_ENCODING`                                                                                                                                                                                                                                                                                           |
| f 退出无残留                 | covered | 退出屏障后 gen=4 进程不存在；日志 `gen=4 ... intent=dispose`                                                                                                                                                                                                                                                                                                                               |
| g 主题与语言截图             | covered | `.e2e-artifacts/plugin-management/plm-ext-2a/` 下 slots（4 张）、composer-narrow、stopped（2 张）                                                                                                                                                                                                                                                                                          |
| h 停止后的静态声明（P2a）    | covered | 预算耗尽后三条问题行都在；`open-panel` 行文字 `E2E 状态面板扩展已停止e2e-ext-status重新加载`；重新加载后 `static table ... (reload)`，行回到「打开」；stopped 截图里可见                                                                                                                                                                                                                   |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261104213237242-p57866-8a071c96625f58fc`（macOS，1/1 通过，`plm-ext-2a-evidence.json` 含日志摘录）。P2a（静态表、顶层 `slots`）复跑：`desktop-e2e-20261105030806135-p6545-e3da3c1ca56b8e71`（1/1 通过）。2c 收尾复跑：`desktop-e2e-20261105021047945-p75812-c08bec8de8fdb07c`（1/1 通过）。P2b 完成后复跑（门面拆分、`nav.primary`、`file.viewer` 都在）：`desktop-e2e-20261105055411951-p6495-ec5e78e09e2dd90b`（1/1 通过）。`composer-narrow` 截图拍到的是窗口变窄、侧栏收起后工具栏重新变宽的状态（插槽文字可见），断言只读到收起的过渡态；稳定的收起态见 PLM-EXT-2C 子项 g。 P4 H1–H4 之后复跑（监管器每次启动前读设置页的网络出口，扩展进程启动时打开环境代理；白名单不变）：`desktop-e2e-20261105112857168-p10104-f0813d0b56b3ea4a`（与 P2D、P2E 同一轮，3/3 通过）。

未覆盖：Windows/Linux 桌面；Web 与手机远控不显示插槽只由代码结构保证（门面只在本机 Host 注册、手机白名单不含该频道），没有运行时验证；P2a 的两个插槽不接受 MCP App target，「扩展进程停止时 MCP App 条目照常」由 PLM-EXT-P2B 子项 h 验证。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-2B：扩展视图、context 组成与生成速率（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-views.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-2B。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-views.json`，主请求命中已录制的 `upstream-slow-stream`。

| 子项                                   | 状态    | 证据                                                                                                                                                                                                                           |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a 草稿预演                             | covered | 页面 `phase=draft-preview`，系统提示词 1627、内置工具 46049 token；窗格仍为 `draft`，任务列表没有该会话                                                                                                                        |
| b 草稿换模型                           | covered | Window Host `context changed by draft model`；视图从 `deepseek-v4-flash` 换到 `deepseek-v4-pro`，仍是预演                                                                                                                      |
| c 流式与准确 tok/s                     | covered | 流式 `0.33 tok/s`（`E2E_TPS streaming`），结束后 `0.15 tok/s`（`final`，outputTokens=12，ttft=8044ms）；流式期间贡献表快照日志 0 条，rev 3→7 只经增量；视图 `phase=request` 出现 messages，实例未重建                          |
| d 命令里调 `views.open`                | covered | 切到新标签页后点击 `composer.status`，视图标签回到前台；`views.open requested ... scope=session` → `acked ... ok=true`                                                                                                         |
| e 写法二                               | covered | `activating (onView:factory)`；页面经自己的 server 调 `ping`，显示 `E2E factory pong scope=session`                                                                                                                            |
| f 杀进程后视图重建                     | covered | `gen=2 status=running` 后视图标签按 gen 2 重建（新实例 id），页面重新渲染 `phase=request`                                                                                                                                      |
| g 主题与语言截图                       | covered | `.e2e-artifacts/plugin-management/plm-ext-2b/` 下 view（4 张）、factory、rebuilt-gen2                                                                                                                                          |
| h `onDidOpen`（P2a）                   | covered | `E2E_VIEW_DID_OPEN instance=<标签页实例 id> scope=session`；fixture 不再在工具调用时登记实例                                                                                                                                   |
| i 草稿首发交接（P2a）                  | covered | 从发送到窗格变成正式会话，Renderer 的 `workbench report` 全是 `sessions=1`（修复前有一条 `sessions=0`，约 260ms）；扩展没有收到 `E2E_VIEW_WORKBENCH []`                                                                        |
| j `env`（P2a）                         | covered | 订阅后的第一个事件与激活时 `env.get` 相同（`en-US`，用例随后切到 `zh-CN`）；切到英文再切回，`env.onDidChange` 依次 `en-US`、`zh-CN`；`env.get` 在激活时有结果                                                                  |
| k 原由 PLM-EXT-2C 断言（2026-11-07）   | covered | `silent` 条目不在 DOM 里；草稿预演 `data-items=60`；final 悬停说明 `E2E_TPS final deepseek-v4-pro out=12 ttft=8024`；`providerContextTokens` 132 = 圆环「已用」132；四种主题与语言下页面 `data-theme` / `data-locale` 跟随宿主 |
| l 原由 PLM-JARVIS-2 断言（2026-11-07） | covered | 关掉 gen 2 的视图标签后 `readViewPane` 为空；`E2E_VIEW_CLOSED instance=d5eb80c6-…`（gen=2）                                                                                                                                    |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105005949936-p69555-6b2d61f61d14ca88`（macOS，1/1 通过，`plm-ext-2b-evidence.json` 含日志摘录）。视图、插槽、日志的读法抽到共用 helper `test/e2e/helpers/extension-host-views.ts` 后复跑：`desktop-e2e-20261105020738644-p72044-a918ee78d58948ab`（1/1 通过）。P2a 复跑：`desktop-e2e-20261105032339675-p76369-0ee8abc87ea231fa`（1/1 通过）。P2b 视图门面拆分（`IExtensionViewsService`）后复跑：`desktop-e2e-20261105050222904-p10097-57916de82e753f3d`（1/1 通过）；P2b 完成后复跑：`desktop-e2e-20261105055727875-p16223-26216867cb793fbd`（1/1 通过）。修复前的交接空档取证：`desktop-e2e-20261105023450754-p85419-f37b6e75780fb657`（带临时探针日志）。示例迁出后（2026-11-07，加 k、l）：`desktop-e2e-20261107070219215-p19676-3512d4725773a2a9`（1/1 通过）。

未覆盖：Windows/Linux 桌面；分屏多窗格的 workbench 报告与焦点；远程工作区（Renderer 不报告，数据泵不接）；Web 与手机远控没有扩展视图只由代码结构保证。主请求复用 `provider-basic.json` 的录制流，晋级前要复制成 case-local fixture。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-2C：示例插件 context-inspector（2026-11-05）

> 已删除（2026-11-07）：示例迁到市场仓库 `zcode-plugins` 的 `ui-plugins/context-inspector`，用例、helper 与夹具从 z-code 删除。下面是删除前的运行证据，保留作历史。宿主断言的去向见「示例插件迁出（2026-11-07）」。

候选桌面入口：`packages/desktop/test/e2e/plugins/manual-review/pending/plugin-context-inspector.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-2C。用例先运行 `examples/plugins/context-inspector/build.mjs`，再把清单与 `dist/` 复制进隔离 HOME。replay 同 PLM-EXT-2B。

| 子项                         | 状态    | 证据                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 未生成时插槽不显示         | covered | 激活后 `composer.status` 不在 DOM 里                                                                                                                                                                                                                                                                                                                                                          |
| b 草稿预演                   | covered | 页面 `ready` / `draft-preview`，「系统提示词」1627、「系统工具」46049 token；系统工具展开后列出 `CronCreate` 等条目，技能列出技能名，指令列出 `AGENTS.md`；窗格仍为 `draft`                                                                                                                                                                                                                   |
| c 草稿换模型                 | covered | 视图从 `deepseek-v4-flash` 换到 `deepseek-v4-pro`，仍是预演                                                                                                                                                                                                                                                                                                                                   |
| d 只显示准确 tok/s、视图刷新 | covered | 2026-11-06 起流式期间不显示估算：发送后到准确值出现前采样 452 次（451 次停止按钮在，即还在生成），插槽一次都没出现、没有「≈」；结束后 `0.15 tok/s`，中文悬停「deepseek-v4-pro · 0.15 tok/s · 输出 12 tok · 首 token 用时 8.03 秒」；视图刷新为 `request`，出现「消息」，同一会话、实例未重建；交接期间 `workbench report` 全是 `sessions=1`。此前（流式估算）：`≈ 0.33 tok/s` 后 `0.15 tok/s` |
| e 点击插槽打开视图           | covered | 从启动页点击 `composer.status` 后视图标签回到前台；`views.open acked ... ok=true`                                                                                                                                                                                                                                                                                                             |
| f 主题与语言                 | covered | 4 张截图；页面 `data-locale` / `data-theme` 跟随宿主，中文「系统提示词」「最近请求」，英文「System prompt」「Last request」；P2a 起插槽悬停说明跟随 App 语言（英文「N output tok · TTFT X s」）                                                                                                                                                                                               |
| g 窄工具栏                   | covered | 侧栏开着、英文 1400px：只有 `extension` 档位收起（档位 1、3 未收起），截图前后都是收起态                                                                                                                                                                                                                                                                                                      |
| h 总量与 App 圆环对齐        | covered | 2026-11-06 对齐后：请求后 `data-headline=provider`、`total` 132 = App 圆环「已用」132（CLI 的 `providerContextTokens`，input 120 + output 12）；`estimated` 31646，底部「估算 3.2万」/「Estimated 31.6K」；类别分摊到 input，之和 120；最后一行「最近一次回复」12。预演 `data-headline=estimate`，页面标「估算」。此前（方案 A）：`total` 120、圆环 132，差这次回复的 output                  |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105020300892-p54965-fc1042b93cf42fd4`（macOS，1/1 通过，`plm-ext-2c-evidence.json`）。方案 A 之后（2026-11-06）：`desktop-e2e-20261106114939638-p77224-a1f3fe02cbc7e026`（1/1 通过，子项 h）。总量对齐圆环、只显示准确 tok/s 之后（2026-11-06）：`desktop-e2e-20261106133329305-p64514-f5e462c3ff807e66`（1/1 通过，子项 d、h）。P2a 复跑：`desktop-e2e-20261105031948744-p63868-17af0e213c1d20f3`（1/1 通过）。P2b 视图门面拆分后复跑：`desktop-e2e-20261105050651212-p24353-d2a74ccc1f59f826`（1/1 通过）；P2b 完成后复跑：`desktop-e2e-20261105060045844-p22592-b79bdba34fdb2044`（1/1 通过）。截图：`.e2e-artifacts/plugin-management/plm-ext-2c/` 下 draft-preview、view（4 张）、composer-narrow。

未覆盖：Windows/Linux 桌面；旧版 App 或 CLI 下的「当前版本不支持」状态（需要旧 CLI，只在页面层用模拟宿主看过渲染）；远程工作区的 `unavailable` 状态。主请求复用 `provider-basic.json` 的录制流，晋级前要复制成 case-local fixture。人工审核、正式晋升与 Docker 准入保持 pending。§15 第 4–10 项见 PLM-EXT-2A、PLM-EXT-2B。

## PLM-EXT-P2B：插件入口——主导航与文件查看器（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-entries.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P2B。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-entries.json`，正式会话的请求命中 `plugin-extension-entries-1`。

| 子项                              | 状态    | 证据                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a 两个导航条目                    | covered | 两项都在「插件市场」之后；顺序与渲染端同一语言的 `localeCompare` 一致（中文「E2E 导航视图」「E2E MCP 面板」，英文「E2E MCP panel」「E2E nav view」）；条目没有 `aria-pressed`；4 张截图                                                                                                                                                                      |
| b 导航 → 扩展视图                 | covered | `extension-view:e2e-ext-entries@inline/nav` 标签运行，页面 `viewId=nav`、`inputKind` 为空；日志 `E2E_ENTRY_VIEW_OPEN view=nav ... input=null`；主视图仍是对话                                                                                                                                                                                                |
| c 导航 → MCP App 页面（根草稿）   | covered | 停在插件市场时点击：`[extension-slots] open surface {... "path":"draft","sessionId":null}`；回到对话、窗格是草稿；`plugin-ui` 标签挂在预热会话上，页面 `ready=1`                                                                                                                                                                                             |
| d 导航 → MCP App 页面（正式会话） | covered | replay 发送后点击：`open surface {... "path":"session","sessionId":"sess_…"}`；当前标签是该会话的 `plugin-ui` 标签，页面就绪                                                                                                                                                                                                                                 |
| h 扩展进程停止                    | covered | 连杀 4 次后 `gen=4 status=stopped`；view 条目文字「E2E 导航视图 已停止 重新加载」，无障碍名称含「扩展已停止」；MCP App 条目 `stopped=false`，仍打开页面；点 view 条目后 `reload requested; crash budget reset`，条目恢复                                                                                                                                     |
| e `.e2eview` → 扩展视图查看器     | covered | 清单写 `.E2EVIEW`；`[extension-slots] file viewer routed {"target":"view","path":"e2e-entries/notes.e2eview"}`；标签 `extension-view:<视图>:file:e2e-entries/notes.e2eview`，标题 `notes.e2eview`；页面与 `E2E_ENTRY_VIEW_OPEN` 都读到 `view.input = { kind: "file", path, workspace }`；之后扩展进程换代时标签按新 gen 重建，`view prepared ... input=file` |
| f `.e2edoc` → MCP App 查看器      | covered | `file viewer routed {"target":"surface"}`；每文件一个 `plugin-ui` 标签；批准 1 次权限后 MCP server 收到 `open_document({ path: "e2e-entries/report.e2edoc" })`，页面 `openedPath` 是该路径                                                                                                                                                                   |
| g `.xlsx`                         | covered | 官方 spreadsheets 插件接管：激活的是它的 `plugin-ui` 页面标签，没有 `file viewer routed`（插件声明的查看器不接管）。在干净 worktree 里验证；开发机仓库根目录的本地 `.zcode/config.json` 若禁用了官方插件，会经项目配置发现进入 E2E 并让这一步失败（见 `conversation-session-e2e-development-workflow.md`「已知问题」）                                       |
| i 扩展进程停止时打开文件          | covered | 再次连杀到 `gen=8 status=stopped`；`.e2eview` 留在文件管理标签内预览，没有 `file viewer routed`；点 view 条目重新加载后恢复                                                                                                                                                                                                                                  |

运行产物：主导航部分 `packages/desktop/.e2e-artifacts/desktop-e2e-20261105054245441-p64585-a91485cc218636c4`（只有导航代码时，1/1 通过）；完整用例 `desktop-e2e-20261105055042354-p96810-201d80dc16f283f2`（macOS，2/2 通过，`plm-ext-p2b-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-ext-p2b/` 下 nav（4 张）、nav-view、nav-surface-draft、nav-stopped（2 张）、file-view、file-surface。

未覆盖：Windows/Linux 桌面；Web 与手机远控不显示导航条目只由代码结构保证（扩展门面只在本机 Host 注册，`ProjectSidebarNavigation` 在手机远控时不挂插槽）；远程工作区与没有插件沙箱时的「不支持」提示、`listSurfaces` 找不到页面时的「不可用」提示没有运行时用例；多个插件声明同一扩展名（取插件 id 字典序第一个、记一次 `file viewer conflict`）、`open_document` 报错或 30 秒未就绪的回退没有运行时用例；文件经文件管理标签的导航打开，`handleOpenCodeViewer` 的其他入口（命令中心、文件链接）走同一个路由函数，没有单独跑。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-P2E：扩展日志控制台（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-logs.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P2E。不发模型请求。

| 子项                       | 状态    | 证据                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 启动页「扩展日志」       | covered | 「扩展」分区有「扩展日志」一行（launcher 截图）；点击后当前标签是 `extension-logs`，`data-loaded="true"`；Renderer 日志 `[extension-slots] logs snapshot {"entries":23,"lastSeq":23}`                                                                                                                                   |
| b 激活日志、归因与截断     | covered | 三个级别的激活行带 `e2e-ext-logs@inline` 与 `gen=1`；peer 行带它的 id；`console.log` / `console.warn` 行带 `e2e-ext-logs@inline`，级别 info / warn（2026-11-05 修复后，此前是没有归属的 `[stdout]` 行）；`status=running` 没有插件 id；seq 严格递增；长日志 4096 字节、以 `…[truncated]` 结尾，日志文件那一行 6111 字符 |
| c 实时追加                 | covered | 点击 `composer.status` 后 `E2E_LOGS_COMMAND_{INFO,WARN,ERROR} run=1` 出现，没有重开标签                                                                                                                                                                                                                                 |
| d 按插件过滤               | covered | `e2e-ext-logs@inline` 11 行全是它；peer 只剩 peer；「扩展进程」只剩没有插件 id 的行                                                                                                                                                                                                                                     |
| e 按级别过滤               | covered | 「仅错误」「警告及以上」；插件 + 仅错误叠加后是 `E2E_LOGS_ACTIVATE_ERROR`、`E2E_LOGS_COMMAND_ERROR run=1`                                                                                                                                                                                                               |
| f 深浅主题 × 中英文        | covered | `.e2e-artifacts/plugin-management/plm-ext-p2e/` 下 logs（4 张）；英文过滤器是「All sources」「All levels」                                                                                                                                                                                                              |
| g 清空只清视图             | covered | 清空后 0 行；`run=2` 的行出现，seq 都大于清空前；日志文件仍有 `E2E_LOGS_ACTIVATE_INFO`                                                                                                                                                                                                                                  |
| h 复制                     | covered | 先清空剪贴板；复制后是 4 行 `时间 级别 [e2e-ext-logs@inline] …`，不含已清空的行；toast「已复制 4 条日志」                                                                                                                                                                                                               |
| i 杀掉扩展进程             | covered | `SIGKILL` 后 `run=2` 的 gen 1 行还在；`extension host exited code=9 intent=crash`、`status=restarting`、`restarting in 1000ms`（gen 1），`status=running`（gen 2），gen 2 的激活行到达；after-crash 截图                                                                                                                |
| j 命令中心「打开扩展日志」 | covered | 关闭标签后从命令中心打开；Renderer 重新取快照 `{"entries":57,"lastSeq":57}`；显示的行 seq 都大于清空前，gen 2 的行都在                                                                                                                                                                                                  |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105071752759-p86235-d61866a49de1da3f`（macOS，1/1 通过，`plm-ext-p2e-evidence.json`）。行改成悬挂缩进之前的一轮：`desktop-e2e-20261105070734204-p45565-ce692b7786da0d47`（1/1 通过，复制断言读到了上一轮留在剪贴板里的内容，之后先清空剪贴板再复制）。截图：`.e2e-artifacts/plugin-management/plm-ext-p2e/` 下 launcher、logs（4 张）、after-crash。PLM-EXT-2A 在 P2e 之后复跑（监管器的每行日志改经环形缓冲，日志文件格式不变）：`desktop-e2e-20261105071424225-p74187-182cf30a71d2f8a9`（1/1 通过）。 P4 H1–H4 之后复跑：`desktop-e2e-20261105112857168-p10104-f0813d0b56b3ea4a`（与 2A、P2D 同一轮，3/3 通过）。

未覆盖：Windows/Linux 桌面；Window Host 重连后的 `getLogs({ sinceSeq })` 补齐与环形缓冲挤出旧条目（2000 条）没有运行时用例；自动滚动开关只截了默认开的状态；Web 与手机远控不出现日志标签与入口只由代码结构保证。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-P3C：扩展经 `ctx.sessions.*` 写会话（2026-11-06）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-sessions-write.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P3C。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-sessions-write.json,<upstream>/plugin-management/plugin-extension-sessions-write.json`。手机：`web-remote-control-auth-gate-fixture.ts` 登记了本 spec（独立端口的本地 Web 前端）。

| 子项                             | 状态    | 证据                                                                                                                                                                                                 |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 新建与立即订阅                 | covered | `createSession` → `creation: created`、`firstInput: accepted`、`delivery: start_now`；`E2E_WRITES_ROWS … kind=reset rows=0`（新建后立即订阅不报 `unavailable`）；项目树里 `projectId` 等于传入的项目 |
| b 新建的幂等重试                 | covered | 第二次同 `requestId` 返回同一个 `sessionId`，审计两行 `commandId` 相同                                                                                                                               |
| c 打开与标识                     | covered | `openSession` → `opened`（`uiTarget: window:1`）；桌面窗格切到这个会话；`[data-v4-user-input-source-kind="extension"]` 一条，文本「来自插件 e2e-ext-writes」                                         |
| d 发送的幂等重试                 | covered | 两次 `sendToSession` 的 `operation.commandId` 相同；标识从 1 条变 2 条                                                                                                                               |
| e H10 换模型                     | covered | 回放记录 `p3c-model` 的请求模型是 `deepseek-v4-pro`（`p3c-create`、`p3c-send` 是 `deepseek-v4-flash`）；回执 `requestId` 是扩展进程补的 UUID                                                         |
| f 中断                           | covered | `readSession(summary)` 拿到 `executionId`；`interruptSession` → `applied`；时间线显示「已停止」，只有第一段流式文本                                                                                  |
| g 整理与打开                     | covered | 改名、置顶、归档、取消归档 → `applied`，打开 → `opened`；项目树 `title: E2E P3C 已改名`、`pinned: true`、`archived: false`                                                                           |
| h 拒绝伪造来源                   | covered | 渲染进程 RPC 端口上的 `sendConversationCommandV4` 报 `fault.command.extensionSourceUntrusted`；标识仍是 4 条                                                                                         |
| i 截图                           | covered | `labels-zh-CN-zai-light`、`labels-en-US-zai-dark`                                                                                                                                                    |
| j 最近操作                       | covered | 最近 10 行依次是打开、归档 ×2、置顶、改名、中断、发送 ×4，`data-outcome` 都是 `ok`；中文「重命名会话」、英文「Renamed a session」；`recent-actions-zh-CN-zai-light`、`recent-actions-en-US-zai-dark` |
| k 审计                           | covered | 13 行写动作；`createSession` 行 `requestId: e2e-p3c-create`、`promptChars: 45`、`target.projectId`；`sendToSession` 行带 `commandId`；审计文件里没有 `E2E_P3C_*` 提示词与新标题                      |
| l 手机                           | covered | 390px 手机页面四条标识都是「来自插件 e2e-ext-writes」，`overflow: false`；`plm-ext-p3c-mobile-labels-zh-CN-light.png`                                                                                |
| m 流式期间逐段到达（2026-11-07） | covered | `watchRows` 的 `rows` 事件在本轮 `running` 时助手字数 22 → 44 → 66，结束时 `completedSuccess`、85（等于完整回复）；夹具 `p3c-stream` 四段间隔 1.5 秒                                                 |
| n 本轮失败（2026-11-07）         | covered | 夹具 `p3c-fail` 返回 400 后 `E2E_WRITES_WATCH … kind=rows turns=failed`                                                                                                                              |
| o 宿主删除任务之后（2026-11-07） | covered | `deleteTask` 后 `sendToSession` → `error=forbidden`；这个会话的 `E2E_WRITES_WATCH … ended=` 没有出现                                                                                                 |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105160838272-p38447-de2d336c92c4f948`（macOS，2/2 通过，`plm-ext-p3c-evidence.json`）；提交的最终版本（只改了注释）再跑一次：`desktop-e2e-20261105161843312-p63132-99a2669f572fca4b`，2/2 通过。截图：`.e2e-artifacts/plugin-management/plm-ext-p3c/`。加 m–o（2026-11-07）：`desktop-e2e-20261107072942349-p84639-b8d85e5a67ffad1d`（2/2 通过）。

P3c-1 之后复跑（macOS，replay）：PLM-EXT-P3A `desktop-e2e-20261105161238179-p47934-e8af738f81320932`、PLM-EXT-P3B `desktop-e2e-20261105161429413-p51643-2092136fa58de8ce`，都通过。

调试中发现的问题（有运行时证据）：

- 第一次运行时 `sendToSession` 带 `model: "deepseek-v4-pro"`（只有 `modelId`）报 `invalid-input`。改用 `providerId/modelId` 后通过。这条报错是唯一匹配规则的结果，与 `createSession` 的 `model` 相同，产品行为不变。
- 观察：`model` 只作用于这一条输入。时间线先显示「模型切换 flash → pro」，下一条不带 `model` 的输入（中断用的那条）又用会话原来的模型，显示「pro → flash」，回放记录也是 `deepseek-v4-flash`。

## PLM-JARVIS-1：示例插件 Jarvis 的核心（2026-11-06）

> 已删除（2026-11-07）：示例迁到市场仓库 `zcode-plugins` 的 `ui-plugins/jarvis`，用例、helper 与夹具从 z-code 删除。下面是删除前的运行证据，保留作历史。宿主断言的去向见「示例插件迁出（2026-11-07）」。

候选桌面入口：`packages/desktop/test/e2e/plugins/manual-review/pending/plugin-jarvis-core.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-JARVIS-1。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/provider-basic.json,<upstream>/plugin-management/plugin-jarvis-core.json`。

| 子项                     | 状态    | 证据                                                                                                                                                                                                                                                                 |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 导航入口与授权         | covered | 视图 `scope: app`；页面 `needs-grant`；页面「授权」弹出宿主授权对话框（会话与系统通知两段原文），确认后欢迎页「嗨，我是 Jarvis」                                                                                                                                     |
| b 首发建大脑、流式与渲染 | covered | `streamLengths` 为 `[9, 16, 32, 56, 75]`，`firstRounds` 为 admitting → waiting → streaming → idle；回复来自 `jarvis-first`（要求人设标记）；粗体 `Jarvis`、行内代码、会话标签 `sess_0000…`，`<b>` 原样显示；`brainProject` 名字 `jarvis`、唯一 root 是插件 workspace |
| c 切换焦点会话           | covered | `afterFocus.instance` 等于 `firstPane.instance`                                                                                                                                                                                                                      |
| d 第二条消息             | covered | 回复 `E2E_JARVIS_SECOND_DONE`（`jarvis-second`）；`brain created` 只有一行                                                                                                                                                                                           |
| e 扩展进程换代           | covered | 新 pid；`gen=2 [jarvis@inline] brain rows reset rows=10`；页面恢复 4 条消息，大脑 id 不变                                                                                                                                                                            |
| f 重启 App               | covered | `Jarvis ready brain=stored`；视图显示同一个大脑与 `E2E_JARVIS_SECOND_DONE`                                                                                                                                                                                           |
| g 往上翻页               | covered | 导入 40 轮的会话：尾部窗口 40 条消息、没有第一轮；滚到顶后 `historyPages` 为 `["40", "74", "80"]`，读出第一轮，`hasMore` 为假                                                                                                                                        |
| h 截图                   | covered | `needs-grant-zh-CN-zai-light`、`welcome-zh-CN-zai-light`、`first-reply-zh-CN-zai-light`、`first-reply-en-US-zai-dark`、`history-zh-CN-zai-light`                                                                                                                     |

运行产物：改名后（2026-11-06）`packages/desktop/.e2e-artifacts/desktop-e2e-20261106115613656-p5519-2994dabc370dca6d`（macOS，1/1 通过，`plm-jarvis-1-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-jarvis-1/`。改名前用例叫 PLM-DOT-1：`desktop-e2e-20261105192801062-p27370-9d04fd4ef50c9965`（`plm-dot-1-evidence.json`）。

未覆盖：Windows/Linux 桌面；`stale` 补读、发送被拒。大脑被删、本轮失败与中断、审批卡片由 PLM-JARVIS-2 覆盖。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-JARVIS-2：示例插件 Jarvis 的工具、审批与提问、权限模式、停止、重试、小结与设置（2026-11-06）

> 已删除（2026-11-07）：示例迁到市场仓库 `zcode-plugins` 的 `ui-plugins/jarvis`，用例、helper 与夹具从 z-code 删除。下面是删除前的运行证据，保留作历史。宿主断言的去向见「示例插件迁出（2026-11-07）」。

候选桌面入口：`packages/desktop/test/e2e/plugins/manual-review/pending/plugin-jarvis-tools.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-JARVIS-2。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/provider-basic.json,<upstream>/plugin-management/plugin-jarvis-tools.json`。

| 子项         | 状态    | 证据                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 授权       | covered | 页面「授权」弹出宿主授权对话框，确认后欢迎页                                                                                                                                                                                                                                                                                                                                                   |
| b 工具与审批 | covered | `toolsAtApproval`：ListSessions「看了看会话列表」`success`，SendToSession `pendingApproval` 画成卡片；`approvalCards` 的选项 `allowOnce` / `allowAlways` / `deny` / `fullAccess`，有「去确认」；「去确认」后主窗格是大脑会话并显示审批面板；在 Jarvis 里点「允许一次」后宿主审批面板消失，两行都是 `success`、没有卡片；目标会话跑了 `E2E_JARVIS_RELAY` 一轮                                   |
| b2 提问      | covered | `questionCards` 的选项 `E2E_JARVIS_PICK_A`、`E2E_JARVIS_PICK_B`，有「去确认」；选 B 后「回答」：回复 `E2E_JARVIS_ASK_GOT_B`（`jarvis-ask-done` 要求请求体里有 `E2E_JARVIS_PICK_B`），卡片清空                                                                                                                                                                                                  |
| b3 权限模式  | covered | 页面 `mode=build`，`modeTitle` 为「权限模式 · 从下一条消息起生效」；切到 `guarded`：`setMode:ok`、页面有「从下一条消息起用「自主模式」」；`modeLines` 三行 `mode switch mode=guarded/yolo/build status=accepted`；`modeLabelFit`：默认侧栏宽度下下拉内容区 中文 57.5px、英文 127.5px，最长的「变更前确认」57.2px、「Ask before changes」127.1px，都不截断（修复前英文显示「Ask before cha…」） |
| c 停止       | covered | `stop status=applied`，本轮 `interrupted`，页面「已停止」                                                                                                                                                                                                                                                                                                                                      |
| d 失败与重试 | covered | `failedRoundError` 为 `turn-failed`；`round retry from=turn`，回复 `E2E_JARVIS_FAIL_RECOVERED`                                                                                                                                                                                                                                                                                                 |
| e 小结与通知 | covered | 小结请求带目标会话链接、不带大脑；`view closed home` 后放行：`digest badge set`、`digest notification shown=true`，Main 记录的通知「jarvis：小结」（标题前缀是清单名）；打开视图后标记清除；一条「小结 · 时间」分隔线；再点一次 `no-changes`，小结请求数仍是 1                                                                                                                                 |
| f 设置与模型 | covered | 面板字段 `chatModel`、`defaultMode`、`digestInterval`、`quietStart`、`quietEnd`，0 个开关，通知说明一行；`plugins.options` 为 `chat_model: e2e-upstream/deepseek-v4-pro`、`default_mode: guarded`、`digest_interval: 2`；下一轮命中 `jarvis-model`                                                                                                                                             |
| g 大脑被删   | covered | `send failed (forbidden)` → `brain forgotten (forbidden)`，没有 `subscription ended`；`state.json` 清空；再发一次建新大脑（id 不同），回复 `E2E_JARVIS_NEW_BRAIN`；新大脑页面 `mode=guarded`（默认权限模式经 `createSession.mode`）                                                                                                                                                            |
| h 截图       | covered | `approval`、`question`、`mode`、`error`、`digest`、`settings` 各有中文浅色、英文深色                                                                                                                                                                                                                                                                                                           |

运行产物：改名与下拉宽度修复后（2026-11-06）`packages/desktop/.e2e-artifacts/desktop-e2e-20261106115307103-p85748-3ca1860c3026e633`（macOS，1/1 通过，`plm-jarvis-2-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-jarvis-2/`。改名前用例叫 PLM-DOT-2：`desktop-e2e-20261106100816704-p72581-5787be9d3ca6b87f`（`plm-dot-2-evidence.json`）。

未覆盖：Windows/Linux 桌面；多选题、「其他回答」与「跳过」；在 Jarvis 里「拒绝」与「允许并切到完全访问」（插件一侧由 PLM-EXT-P3E 覆盖）；宿主输入框的模式在 Jarvis 切换后不跟着变（宿主的草稿模式只在首帧与授权、计划切换时跟随会话，是现有行为；已知限制见 [扩展进程](../plugins/extension-host.md) §17.12，用户决策以后单独做）；定时小结（到点、安静时段、启动时超期补发）；发送被拒的重试；`stale` 补读；通知 `disabled` 与 `rate-limited`（宿主行为由 PLM-EXT-JARVISHOST 覆盖）。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-P3C2：插件项目（2026-11-06）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-plugin-project.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P3C2。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-plugin-project.json,<upstream>/plugin-management/plugin-extension-plugin-project.json`。

| 子项                   | 状态    | 证据                                                                                                                                                                   |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 并发新建只建一个项目 | covered | 两个并发 `createSession` 的 `project.projectId` 相同；`projectsAfterConcurrentCreate` 只有一项：名字 `e2e-ext-projects`，唯一 root 是插件 workspace、`isPrimary: true` |
| b H7 cwd 与 AGENTS.md  | covered | 会话 `workspacePath` = `<dataPath>/workspace`；打开后回复 `E2E_P3C2_AGENTS_SEEN`（`p3c2-first` 夹具带 `bodyIncludes` 标记）；用户行显示「来自插件 e2e-ext-projects」   |
| c 之后再建复用         | covered | 第三个会话的 `projectId` 不变，项目树里仍只有一个插件项目                                                                                                              |
| d 移除后重新创建       | covered | 侧栏「更多 → 删除」后项目 `deleted: true`；下一个会话在新项目里，新项目名字仍是 `e2e-ext-projects`，侧栏显示它                                                         |
| e 日志                 | covered | 两行 `plugin project created plugin=e2e-ext-projects@inline project=…`，不含数据目录路径                                                                               |
| f 截图                 | covered | `plugin-project-zh-CN-zai-light`、`plugin-project-en-US-zai-dark`                                                                                                      |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105174558519-p55569-03e68c4c910cb3c1`（macOS，1/1 通过，`plm-ext-p3c2-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-ext-p3c2/`。

未覆盖：Windows/Linux 桌面；旧 CLI 不报告 `dataPath` 时的 `unavailable`；改名后按目录找到、workspace 从项目目录去掉后新建、workspace 目录被删后重建。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-P3E：插件回答审批、提问与切换权限模式（2026-11-06）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-session-approvals.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P3E。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-session-approvals.json,<upstream>/plugin-management/plugin-extension-session-approvals.json`。

| 子项               | 状态    | 证据                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 旧授权重新确认   | covered | 旧格式记录（没有 `consentRevision`）：`stale-grant` 一步的 `setPermissionMode` 报 `not-granted`；启动页「需要授权」行打开的 `reconsentDialog` 有「插件项目里的会话：插件还能替你批准或拒绝工具调用、回答 Agent 的提问、切换权限模式。」、没有「完全访问」行；确认后 `reconsentRecord` 的 `consentRevision` 为 2，后面各步照常                                                                                             |
| a 插件项目以外     | covered | `outsideWatchError` 为 `error=forbidden`；`resolveInteraction`、`setPermissionMode` 都是 `forbidden`                                                                                                                                                                                                                                                                                                                      |
| b 批准一次         | covered | `allowInteraction` 的选项是 `allowOnce` / `allowAlways` / `deny` 与 CLI 给的 `fullAccess`，事件 `mode=build`；`accepted` 后交互消失、宿主审批面板消失；2026-11-07 起行镜像的 `Write` 工具行先是 `pendingApproval`（`kind=reset`），批准后是 `success`；`allow.txt` 写出，回复 `E2E_P3E_ALLOW_DONE`                                                                                                                        |
| c 拒绝             | covered | `accepted`；`deny.txt` 不存在，回复 `E2E_P3E_DENY_DONE`                                                                                                                                                                                                                                                                                                                                                                   |
| d 回答提问         | covered | 交互是 `userInput`，选项 `question:E2E_P3E_ASK_QUESTION…`，2026-11-07 起还有 `choice:E2E_P3E_ANSWER_A`、`choice:E2E_P3E_ANSWER_B`（原由 PLM-JARVIS-2 断言）；回复 `E2E_P3E_ASK_GOT_B`（`p3e-ask-final` 夹具要求请求体里有 `E2E_P3E_ANSWER_B`）                                                                                                                                                                            |
| e 先到先得         | covered | 宿主批准后交互消失，插件再回答得到 `stale`；回复 `E2E_P3E_HOST_DONE`                                                                                                                                                                                                                                                                                                                                                      |
| f 切换权限模式     | covered | 首轮做完后 `guarded` → `accepted`，事件 `mode=guarded`；同值 `unchanged`；`yolo` 与 `createSession` 带 `yolo` 都是 `not-declared`                                                                                                                                                                                                                                                                                         |
| g 申请完全访问     | covered | 清单改成 `["sessions.fullAccess"]` 并重新加载后整个插件回到「需要授权」（授权按插件整体生效），`yolo` 在网关就报 `not-granted`，不进审计；`fullAccessDialog` 有「插件项目里的会话：…」与「完全访问：…」两行；授权后 `yolo` → `accepted`、事件 `mode=yolo`；带 `yolo` 新建的会话第一个事件就是 `mode=yolo`；2026-11-07 起再切回 `build` → `accepted`，事件 `mode=build`，审计多一行 `build` 成功（原由 PLM-JARVIS-2 断言） |
| h 允许并切完全访问 | covered | 审批带 `fullAccess:fullAccess`；选它后事件 `mode=yolo`、交互为空；`full.txt` 写出，回复 `E2E_P3E_FULL_DONE`；宿主输入框显示 Full access                                                                                                                                                                                                                                                                                   |
| i 范围与种类       | covered | 六个插件会话的 `projectId` 都在插件 workspace 的项目里；`interactionKinds` 只有 `permission`、`userInput`                                                                                                                                                                                                                                                                                                                 |
| j 审计             | covered | `auditAnswers` 的 `choice` 有 `allowOnce`、`deny`、`answer`（`interactionKind: userInput`）、`fullAccess`，一行 `result.stale`；`auditSwitches` 有 `guarded` 成功、`not-declared`、`yolo` 成功；不含问题、答案与提示词                                                                                                                                                                                                    |
| k 截图             | covered | `reconsent-dialog-zh-CN-zai-light`、`host-panel-before-zh-CN-zai-light`、`full-access-dialog-zh-CN-zai-light`、`after-full-access-en-US-zai-dark`                                                                                                                                                                                                                                                                         |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261106094009533-p60802-b489253918550274`（macOS，1/1 通过，`plm-ext-p3e-evidence.json`）。加上子项 0（重新确认）之后：`desktop-e2e-20261106114646693-p70050-5d0d5e5cb9db6754`（1/1 通过）。截图：`.e2e-artifacts/plugin-management/plm-ext-p3e/`。示例迁出后（2026-11-07，d 的选项与 g 的切回 build）：`desktop-e2e-20261107070546508-p27724-60a4cc362c5fff2e`（1/1 通过）。加 b 的工具行状态（2026-11-07）：`desktop-e2e-20261107073143230-p88575-23430e831cba3fcc`（1/1 通过）。

f 的时机：首跑（`desktop-e2e-20261106091604741-p7841-a9d94834325c4557`）在首轮开始前切换，CLI 在轮开始时按首条输入提交时的 `build` 改回（`applySubmissionExecutionState`），两次变化落在同一帧，插件只收到最终的 `build`。这是 CLI 的现有语义（§17.12），用例改成首轮做完再切换。

未覆盖：Windows/Linux 桌面；工作区 Hook 信任审查与插件安装确认（只在投影里过滤，没有触发）；CLI 里真正同时到达的两个回答；`invalid-input`；调用期间撤销授权。人工审核、正式晋升与 Docker 准入保持 pending。

### 2026-11-06 插件 E2E 整轮复跑

改动：已有 `sessions.write` 授权要重新确认（§17.12）、context-inspector 总量用服务商数字（§11 方案 A）、Jarvis 顶栏权限模式下拉不截断、dot 改名 Jarvis。分支 `feat/extension-session-approvals`，macOS，逐个用例顺序运行（`ZCODE_E2E_MANUAL_REVIEW=1`）。产物都在 `packages/desktop/.e2e-artifacts/` 下。

| 用例               | 入口                                         | 模型（replay 夹具或 dummy provider）                       | 结果     | 运行产物                                                                  |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| PLM-EXT-P3E        | `plugin-extension-session-approvals.test.ts` | common、provider-basic、plugin-extension-session-approvals | 1/1 通过 | `desktop-e2e-20261106114646693-p70050-5d0d5e5cb9db6754`                   |
| PLM-EXT-2C         | `plugin-context-inspector.test.ts`           | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261106133329305-p64514-f5e462c3ff807e66`（对齐圆环后复跑） |
| PLM-JARVIS-2       | `plugin-jarvis-tools.test.ts`                | common、provider-basic、plugin-jarvis-tools                | 1/1 通过 | `desktop-e2e-20261106115307103-p85748-3ca1860c3026e633`                   |
| PLM-JARVIS-1       | `plugin-jarvis-core.test.ts`                 | common、provider-basic、plugin-jarvis-core                 | 1/1 通过 | `desktop-e2e-20261106115613656-p5519-2994dabc370dca6d`                    |
| PLM-EXT-JARVISHOST | `plugin-extension-jarvis-host.test.ts`       | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261106115855131-p13801-870de5507ce77b66`                   |
| PLM-EXT-P3A        | `plugin-extension-sessions.test.ts`          | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261106120057333-p17818-5b71e4cf67cc6263`                   |
| PLM-EXT-P3B        | `plugin-extension-sessions-read.test.ts`     | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261106120249118-p20804-f57f477fd1bc1796`                   |
| PLM-EXT-P3C        | `plugin-extension-sessions-write.test.ts`    | common、plugin-extension-sessions-write                    | 1/1 通过 | `desktop-e2e-20261106120522965-p25874-e87badf362419309`                   |
| PLM-EXT-P3C2       | `plugin-extension-plugin-project.test.ts`    | common、provider-basic、plugin-extension-plugin-project    | 1/1 通过 | `desktop-e2e-20261106120720154-p28798-e0445a0220298397`                   |
| PLM-EXT-2A         | `plugin-extension-host-runtime.test.ts`      | dummy provider                                             | 1/1 通过 | `desktop-e2e-20261106120903550-p31480-00c54bebf49b267e`                   |
| PLM-EXT-2B         | `plugin-extension-views.test.ts`             | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261106121158671-p34481-d6145b0799c4f38e`                   |
| PLM-EXT-P2B        | `plugin-extension-entries.test.ts`           | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261106121518227-p41032-935546d608a58be9`                   |
| PLM-EXT-P2C        | `plugin-extension-mention.test.ts`           | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261106121732440-p44680-c164f8d5134b98ab`                   |
| PLM-EXT-P2D        | `plugin-extension-settings.test.ts`          | dummy provider                                             | 1/1 通过 | `desktop-e2e-20261106121932695-p49190-324ad8942f92de51`                   |
| PLM-EXT-P2E        | `plugin-extension-logs.test.ts`              | dummy provider                                             | 1/1 通过 | `desktop-e2e-20261106122127187-p53726-22a891ad0077fdee`                   |
| PLM-EXT-H2         | `plugin-extension-start-draft.test.ts`       | dummy provider                                             | 1/1 通过 | `desktop-e2e-20261106122321289-p57635-7ff69a11770063aa`                   |
| PLM-EXT-H3         | `plugin-extension-network.test.ts`           | dummy provider                                             | 1/1 通过 | `desktop-e2e-20261106122505942-p60734-393ce472220b9077`                   |

## PLM-EXT-JARVISHOST：Jarvis 要的宿主能力（2026-11-06）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-jarvis-host.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-JARVISHOST。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-jarvis-host.json`。

| 子项                                    | 状态    | 证据                                                                                                                                                                                                                                             |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a H5 App 作用域视图                     | covered | 切会话、进另一个工作区再回来，实例 id 都是同一个；回来后这个视图的标签只有 1 个；`E2E_JARVISHOST_VIEW_OPEN` 只有一行。去掉移动逻辑时用例在「切到另一个工作区」失败（反向验证）                                                                   |
| b H6 `ctx.extension.dataPath`           | covered | `<E2E HOME>/.zcode/cli/plugins/data/e2e-ext-jarvis-host@inline`，`isDirectory: true`                                                                                                                                                             |
| c H9 `models.list`                      | covered | 两项 `e2e-upstream/deepseek-v4-flash`、`e2e-upstream/deepseek-v4-pro`，`providerName: Upstream E2E`；2026-11-07 起第二个模型也断言（这次列表还有 `e2e-upstream-alt/deepseek-v4-pro`）                                                            |
| d H11 导航未读标记                      | covered | 3 → 99+ → 圆点 → 清除；标签「E2E 宿主能力 · 3 条未读」「· 有新内容」，英文「· 5 unread」                                                                                                                                                         |
| e H12 `grants.request`                  | covered | 对话框列出读取会话与系统通知；取消返回 `granted=`（空），确认后 `granted=sessions.read,notifications`                                                                                                                                            |
| f H8 `notifications.show`               | covered | 依次 `focused`、`disabled`、`muted`、弹出（标题「e2e-ext-jarvis-host：E2E title」）、`rate-limited`；点击记录的通知后打开该插件的视图（`notification click … opened: true`）                                                                     |
| g 截图                                  | covered | `app-view`、`nav-badge-count`、`nav-badge-dot`、`grants-request-dialog`、`notifications-switch`（中文浅色、英文深色）                                                                                                                            |
| h 换代后的 App 作用域视图（2026-11-07） | covered | 杀掉扩展进程：gen 1 → 2，实例 id 换新，作用域仍是 `app`，页面 `data-ready=1`；`app-view-after-kill-zh-CN-zai-light`                                                                                                                              |
| i H6 重启后的数据（2026-11-07）         | covered | 重启前 `E2E_JARVISHOST_DATA previous=1 count=2`（杀进程那次激活），重启后 `previous=2 count=3`                                                                                                                                                   |
| j H12 申请完全访问（2026-11-07）        | covered | 清单加 `sessions.fullAccess` 并重新加载后，`grants.request` 的对话框标题「允许「e2e-ext-jarvis-host」读取和操作会话？」，有「完全访问：…」一行；确认后 `granted=sessions.fullAccess,notifications`；`grants-request-full-access-zh-CN-zai-light` |

运行产物：集成分支上的 `packages/desktop/.e2e-artifacts/desktop-e2e-20261105163831764-p13048-bf839ba7f3d46c8c`（H5 跨工作区之后，1/1 通过）与 P3c-1 合入后的复跑 `desktop-e2e-20261105165939536-p31668-1783b55531e5be13`（1/1 通过，`plm-ext-dothost-evidence.json`，改名前用例叫 PLM-EXT-DOTHOST）。改名后（2026-11-06）：`desktop-e2e-20261106115855131-p13801-870de5507ce77b66`（1/1 通过，`plm-ext-jarvishost-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-ext-jarvishost/`。加 h–j 与 c 的第二个模型（2026-11-07）：`desktop-e2e-20261107073551376-p98448-c2e1709e06efa7d5`（2/2 通过）。

未覆盖：Windows/Linux 桌面；H5 切到远程工作区与窗口重载后的恢复；H8 每天 20 条的上限、Window Host 重启后计数清零；测试机上不弹真实系统通知（Main 的 `Notification.show` 换成记录）。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-P3B：扩展的会话读连接与商店安装后的激活确认（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-sessions-read.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P3B。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-sessions-read.json`，发送命中 `plugin-extension-sessions-read-1`（录制的回复是 `deepseek-e2e-ok`）。

| 子项                                   | 状态    | 证据                                                                                                                                                                                                                                |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 列表                                 | covered | `E2E_READS_LIST kind=snapshot rev=0 count=9 seeds=9`；`[extensions] session list pump started rows=9`；之后的 delta 按映射后的行比较                                                                                                |
| b 上限与退订                           | covered | `E2E_READS_LIMIT results=event:reset×8,error:limit-exceeded`；`session read connection open connectionId=extension-host:1`；8 次 `session mirror subscribed … mode=snapshot` 与 8 次 `session mirror released`                      |
| c 实时行与 readRows                    | covered | 视图 `rows=5` 起，含 `userInput`（标记）与 `assistantText deepseek-e2e-ok`；`E2E_READS_ROWS … kind=reset`、`… kind=rows … reply=true`；`E2E_READS_READROWS … rows=3 marker=true`；`E2E_READS_CONV` 从 `draft` 到 `completedSuccess` |
| d 换代后 reset                         | covered | gen=2 的 `E2E_READS_ROWS … kind=reset rows=6 … marker=true reply=true events=1`；`connectionId=extension-host:2`；`session read connection closed connectionId=extension-host:1 (extension host detached)`                          |
| e 商店安装后先不激活                   | covered | `extension activation held plugin=e2e-ext-store-a@e2e-ext-store-market holders=1`；`grants.json` 的 `activations` 为 `pending`；行文本「需要确认」「刚安装的扩展代码，还没有运行」                                                  |
| f 不激活                               | covered | 对话框正文列出「「e2e-ext-reads」（读取会话）」；点「不激活」后 `declined`、行消失；`listPlugins` 里 A `enabled: true`；引用目录里 A 的技能 `e2e-store-skill-a` 仍在；没有 `E2E_STORE_ACTIVATED plugin=e2e-ext-store-a…`            |
| g 关闭不算决定、确认激活               | covered | Esc 后 B 仍 `pending`、行还在；确认后 `extension activation allowed`、`E2E_STORE_ACTIVATED plugin=e2e-ext-store-b@e2e-ext-store-market`，记录删除                                                                                   |
| h 重新加载扩展后 reset（2026-11-07）   | covered | 「重新加载扩展」后这个会话的第一个行事件 `kind=reset rows=7 … marker=true reply=true events=1`                                                                                                                                      |
| i 长历史的尾部窗口与翻页（2026-11-07） | covered | 导入 40 轮：`E2E_READS_HISTORY window=60 windowHasFirst=false pages=3 total=120 hasFirst=true hasMore=false`                                                                                                                        |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105150202362-p55147-fd5d90347911d3cd`（macOS，2/2 通过，`plm-ext-p3b-evidence.json`；提交前的最终版本）。截图：`.e2e-artifacts/plugin-management/plm-ext-p3b/` 下 reads-view（中文浅色、英文深色）、activation-row 与 activation-dialog（中文浅色、英文深色）。加 h、i（2026-11-07）：`desktop-e2e-20261107073337292-p93433-d55781f28500ed7f`（2/2 通过）。

P3b 之后复跑（macOS）：PLM-EXT-P3A（replay）`desktop-e2e-20261105144638891-p19363-c9d5afb2484d06de`、PLM-EXT-2A（dummy provider）`desktop-e2e-20261105144815629-p26344-55ac437605981d6e`，都通过。

调试中发现并修掉的问题（有运行时证据）：

- fixture 在第一个 `reset` 时调 `readRows`，拿到 0 行：新会话刚从草稿变成会话时窗口还是空的（`E2E_READS_ROWS … kind=reset rows=0`，会话状态 `phase=draft`）。改成镜像里第一次出现测试标记时再读。这是 fixture 的时序，产品行为不变。

未覆盖：Windows/Linux 桌面；镜像预算、`stale`、全局 32 个镜像、断档重同步、会话或运行时重启后的重新订阅、`declined` 后经设置页重新启用、授权撤销时订阅以 `not-granted` 结束。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-STORE：商店按插件 API 版本挡住不兼容的扩展插件（2026-11-07）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-store-extension-compat.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-STORE。不调用模型；按插件用例的惯例带 replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-store-extension-compat.json`。

| 子项                 | 状态    | 证据                                                                                                                                                                                                                     |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a 能力位与透传       | covered | 测试动作 `getPluginsOverview`（经 services）：ok 的 `listing.extensionSummary` 为 `{ engines: { zcode: "^1.4.0" }, grants: ["sessions.fullAccess", "notifications"] }`，`componentTypes` 含 `extension`；plain 没有      |
| b 列表挡不兼容       | covered | future 按钮 `disabled`、`data-install-blocked="requires-update"`、文字「需要更新 ZCode」；ok、plain 为可点的「安装」                                                                                                     |
| c 不兼容的详情页     | covered | `plugin-store-extension-incompatible` 含「更新 ZCode」；扩展说明含「含常驻代码」，档位只有「读取会话」，没有完全访问一行                                                                                                 |
| d 兼容的详情页       | covered | 档位「读写会话（含完全访问）」「发送系统通知」；`plugin-store-extension-full-access` 以「完全访问：」开头；没有不兼容说明                                                                                                |
| e 普通插件与安装     | covered | plain 详情页没有扩展说明；ok、plain 从商店装上；ok 装上后安装前说明消失                                                                                                                                                  |
| f 不兼容的新版不提示 | covered | 刷新后 overview 里 installed 与 plain 都是 `update-available`，installed 的摘要是 `^99.0.0`；列表只有 plain 有「可更新」与「更新」；installed 的详情页没有 `plugin-store-detail-update`；刷新提示「发现 1 个插件可更新」 |
| g 全部更新跳过       | covered | 「全部更新（1）」；执行后 plain 为 2.0.0，按钮消失；installed 仍为 1.0.0、`enabled: true`、`update-available`                                                                                                            |
| h 语言与主题         | covered | 截图见下；英文「Requires newer ZCode」「Includes resident code」                                                                                                                                                         |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261107064956973-p98299-76b88c7f8460abc0`（macOS，1/1 通过）；updates 截图前改为先滚到本地市场的卡片，复跑 `desktop-e2e-20261107065302118-p4854-bb94d976f0d85a5d`（1/1 通过，`plm-ext-store-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-ext-store/` 下 store-list、future-detail、compatible-detail（中文浅色、英文深色），updates、update-all（中文浅色），after-update-all（英文深色）。迁移 commit 之后再跑（2026-11-07）：`desktop-e2e-20261107074445681-p15206-d95fd261654312f4`（1/1 通过）。

CLI 一侧（2026-11-07）：`apps/zcode-cli/packages/bootstrap/tests/plugins-protocol.test.ts` 的 `plugins/overview extension summary`（不要求时线上没有这个键；要求时结果过 strict schema；安装结果不带）、`v4-extension-input-source.test.ts` 的能力位、adapters 的 `parseEntryExtensionSummary` 与合成清单剔除，都通过。

未覆盖：Windows/Linux 桌面；手机 Web 没有插件商店；版本不同的 Desktop 与远端 Server、新 services 配旧 CLI 没有桌面运行时用例（§4.3 按分层分析与 CLI 协议测试）；远程设备 Scope 的商店。人工审核、正式晋升与 Docker 准入保持 pending。

## 示例插件迁出（2026-11-07）

示例 Jarvis 与 context-inspector 迁到市场仓库（[插件发布](../plugins/plugin-publishing.md) §6.3），删除 PLM-EXT-2C、PLM-JARVIS-1、PLM-JARVIS-2。下表逐条列出它们断言的行为与去向。「删除」是插件自己的界面或算术（用户决策 2026-11-07：插件只做构建与清单校验，人工验收）；「新加」是移进 fixture 用例的断言。每一条宿主行为都有 fixture 用例覆盖，没有一项留「未覆盖」。

| 原用例与断言                                                           | 去向                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2C a 没有生成过时 `composer.status` 不显示                             | 新加：PLM-EXT-2B k（清单声明、从没设置文字的条目 `silent` 不显示）                 |
| 2C b 草稿打开视图、作用域会话、`draft-preview`、系统提示词与工具 token | PLM-EXT-2B a                                                                       |
| 2C b 展开类别列出条目                                                  | 新加：PLM-EXT-2B k（草稿预演的类别带条目，页面 `data-items` 大于 0）               |
| 2C b 「估算」标记、中文类别名                                          | 删除（插件页面）                                                                   |
| 2C c 草稿换模型                                                        | PLM-EXT-2B b                                                                       |
| 2C d 流式期间插槽不显示                                                | 删除（插件的选择）；宿主的流式事件由 PLM-EXT-2B c 覆盖                             |
| 2C d 准确 tok/s，悬停带模型、输出 token、首 token 时间                 | PLM-EXT-2B c；新加：PLM-EXT-2B k（final 事件带换过的模型、`out=12` 与 `ttft`）     |
| 2C d 视图刷新为 `request`、实例不重建、交接期间 `sessions=1`           | PLM-EXT-2B c、i                                                                    |
| 2C h 总量等于输入框圆环「已用」                                        | 新加：PLM-EXT-2B k（`context.get` 的 `providerContextTokens` 等于圆环「已用」132） |
| 2C h 回复行、类别按 input 分摊、估算对照                               | 删除（插件算术）                                                                   |
| 2C e 点击插槽经 `views.open` 打开视图                                  | PLM-EXT-2B d                                                                       |
| 2C f 页面跟随宿主主题与语言                                            | 新加：PLM-EXT-2B k（hostContext 的主题与语言写在页面上）                           |
| 2C f 悬停说明跟随 App 语言                                             | PLM-EXT-2B j（`env.onDidChange`）；文案本身删除                                    |
| 2C g 窄工具栏插槽收起                                                  | PLM-EXT-2A（900px 收起）                                                           |
| J1 `nav.primary` 打开 App 作用域视图                                   | PLM-EXT-JARVISHOST a、PLM-EXT-P2B                                                  |
| J1 页面「需要授权」、欢迎页、Markdown 渲染、开场动画                   | 删除（插件页面）；未授权报 `not-granted` 由 PLM-EXT-P3A、P3E 0 覆盖                |
| J1 `grants.request` 弹授权对话框                                       | PLM-EXT-JARVISHOST e                                                               |
| J1 首发：大脑在插件项目里、请求带 `AGENTS.md`                          | PLM-EXT-P3C2 a、b                                                                  |
| J1 流式期间气泡至少增长 3 次                                           | 新加：PLM-EXT-P3C m（行订阅在本轮 `running` 时助手字数 22 → 44 → 66）              |
| J1 切换焦点会话实例不变                                                | PLM-EXT-JARVISHOST a                                                               |
| J1 第二条消息 `sendToSession`                                          | PLM-EXT-P3C                                                                        |
| J1 杀扩展进程后新 pid、第一个行事件是 `reset`                          | PLM-EXT-2A、PLM-EXT-P3B d                                                          |
| J1 杀进程后 App 作用域视图恢复                                         | 新加：PLM-EXT-JARVISHOST h                                                         |
| J1 App 重启后 `dataPath` 里的数据还在                                  | 新加：PLM-EXT-JARVISHOST i                                                         |
| J1 「重新加载扩展」后重新激活                                          | PLM-EXT-2A、PLM-EXT-P3E g；新加：PLM-EXT-P3B h（重新加载后第一个行事件是 `reset`） |
| J1 镜像只留尾窗（`hasMore`）、`readRows(beforeRowId)` 往前翻           | 新加：PLM-EXT-P3B i                                                                |
| J2 行镜像里工具行的状态（`success`、`pendingApproval`）                | 新加：PLM-EXT-P3E b（`Write:pendingApproval` → `Write:success`）                   |
| J2 审批选项 `allowOnce` / `deny`                                       | PLM-EXT-P3E b、c                                                                   |
| J2 「去确认」→ 宿主打开大脑会话                                        | PLM-EXT-P3C、P3E                                                                   |
| J2 插件回答后宿主审批面板消失                                          | PLM-EXT-P3E b                                                                      |
| J2 目标会话收到转发的提示词                                            | SCT03、SCT04（会话控制用例，不经插件）                                             |
| J2 提问带选项                                                          | 新加：PLM-EXT-P3E d（`choice:E2E_P3E_ANSWER_A`、`choice:E2E_P3E_ANSWER_B`）        |
| J2 答案回到模型                                                        | PLM-EXT-P3E d                                                                      |
| J2 权限模式 `build` → `guarded` → `yolo`（已授完全访问）               | PLM-EXT-P3E f、g                                                                   |
| J2 再切回 `build`                                                      | 新加：PLM-EXT-P3E g                                                                |
| J2 `readSession` 取 executionId 后 `interruptSession`                  | PLM-EXT-P3C                                                                        |
| J2 本轮失败（HTTP 400）以 `turn-failed` 到达扩展                       | 新加：PLM-EXT-P3C n（行镜像的 `turnHeader` 是 `failed`）                           |
| J2 关掉视图标签后面板里没有这个视图                                    | 新加：PLM-EXT-2B l                                                                 |
| J2 扩展收到 `view.onDidClose`                                          | 新加：PLM-EXT-2B l                                                                 |
| J2 失焦时 `notifications.show` 弹出、标题加插件名                      | PLM-EXT-JARVISHOST f                                                               |
| J2 导航未读标记与清除                                                  | PLM-EXT-JARVISHOST d                                                               |
| J2 `models.list` 列出已配置模型                                        | PLM-EXT-JARVISHOST c（新加：第二个模型也断言）                                     |
| J2 `settings.update` 的非敏感键写进 `config.json`                      | 新加：PLM-EXT-P2D m                                                                |
| J2 下一轮用保存的模型（`sendToSession` 带 model）                      | PLM-EXT-P3C                                                                        |
| J2 Host 删除任务后 `sendToSession` 报 `forbidden`                      | 新加：PLM-EXT-P3C o                                                                |
| J2 删除任务后已开着的行订阅不结束                                      | 新加：PLM-EXT-P3C o                                                                |
| J2 新会话按默认模式开始（`createSession.mode`）                        | PLM-EXT-P3E g                                                                      |
| J2 `grants.request` 申请完全访问的对话框                               | 新加：PLM-EXT-JARVISHOST j                                                         |
| J2 摘要文案、卡片、重试、小结分隔线、设置面板、模式提示与宽度          | 删除（插件页面）                                                                   |

迁移后的运行（macOS，逐个顺序，`ZCODE_E2E_MANUAL_REVIEW=1`）：

| 用例        | 入口                                         | 模型                                                       | 结果     | 运行产物                                                |
| ----------- | -------------------------------------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------- |
| PLM-EXT-2B  | `plugin-extension-views.test.ts`             | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261107070219215-p19676-3512d4725773a2a9` |
| PLM-EXT-P3E | `plugin-extension-session-approvals.test.ts` | common、provider-basic、plugin-extension-session-approvals | 1/1 通过 | `desktop-e2e-20261107070546508-p27724-60a4cc362c5fff2e` |

补覆盖之后（2026-11-07，每个改过的用例逐个顺序跑；迁移 commit 在最后）：

| 用例                    | 入口                                         | 模型                                                       | 结果     | 运行产物                                                |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------- |
| PLM-EXT-P3C             | `plugin-extension-sessions-write.test.ts`    | common、plugin-extension-sessions-write                    | 2/2 通过 | `desktop-e2e-20261107072942349-p84639-b8d85e5a67ffad1d` |
| PLM-EXT-P3E             | `plugin-extension-session-approvals.test.ts` | common、provider-basic、plugin-extension-session-approvals | 1/1 通过 | `desktop-e2e-20261107073143230-p88575-23430e831cba3fcc` |
| PLM-EXT-P3B             | `plugin-extension-sessions-read.test.ts`     | common、provider-basic                                     | 2/2 通过 | `desktop-e2e-20261107073337292-p93433-d55781f28500ed7f` |
| PLM-EXT-JARVISHOST      | `plugin-extension-jarvis-host.test.ts`       | common、provider-basic                                     | 2/2 通过 | `desktop-e2e-20261107073551376-p98448-c2e1709e06efa7d5` |
| PLM-EXT-P2D             | `plugin-extension-settings.test.ts`          | dummy provider                                             | 1/1 通过 | `desktop-e2e-20261107073752557-p3324-3d1de8056f0c4271`  |
| PLM-EXT-2B              | `plugin-extension-views.test.ts`             | common、provider-basic                                     | 1/1 通过 | `desktop-e2e-20261107074136027-p9437-c39ff8ad0eafdacc`  |
| PLM-EXT-STORE（迁移后） | `plugin-store-extension-compat.test.ts`      | common、provider-basic（不调用模型）                       | 1/1 通过 | `desktop-e2e-20261107074445681-p15206-d95fd261654312f4` |

## PLM-EXT-P3A：扩展的会话读权限、授权与审计（2026-11-05）

候选桌面入口：`packages/desktop/test/e2e/plugins/extensions/manual-review/pending/plugin-extension-sessions.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P3A。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/provider-basic.json`，发送命中 `upstream-provider-basic`（录制的回复是 `deepseek-e2e-ok`）。

| 子项                 | 状态    | 证据                                                                                                                                                                                                                 |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 未授权             | covered | `E2E_SESSIONS_LIST plugin=e2e-ext-sessions@inline reason=activate error=not-granted`；`E2E_SESSIONS_NOGRANT … error=not-declared`；开始时没有 `grants.json`                                                          |
| b 启动页「需要授权」 | covered | 行文本「需要授权」「读取会话」/「Needs permission」「Read sessions」；没有声明档位的插件没有这一行；4 张截图 `launcher-needs-consent-*`                                                                              |
| c 授权对话框         | covered | 中文标题与 spec 原文三段都在；Esc 取消后没有记录、这一行还在；英文深色重开后确认；`grants.json` 为 `{ grants: ["sessions.read"], consentedVersion: "1.0.0" }`；`[extensions] extension grants granted …`；这一行消失 |
| d 授权后读会话       | covered | `E2E_SESSIONS_LIST … reason=locale-en-US ok count=1 ids=sess_…`（与界面上的正式会话 id 相同）；`E2E_SESSIONS_READ … view=messages messages=2 roles=assistant,user marker=true`                                       |
| e 启用确认           | covered | 设置页打开 `e2e-ext-sessions-late` 的开关：弹确认，列出「“e2e-ext-sessions” (Read sessions)」；Esc 取消后开关仍关、没有激活日志；中文深色再开、确认后 `E2E_SESSIONS_LATE_ACTIVATED`                                  |
| f 详情页「权限」     | covered | 授权后状态 `granted`，「最近操作」有授权一行；点「撤销」后 `needs-consent`，「最近操作」新的在前为撤销、授权；`grants.json` 里没有该插件                                                                             |
| g 撤销后             | covered | `E2E_SESSIONS_LIST … reason=locale-zh-CN error=not-granted`；启动页又显示「需要授权」                                                                                                                                |
| h 审计文件           | covered | 两行 `{ v: 1, gen: 1, pluginId, capability: "grants.grant" / "grants.revoke", grant: "sessions.read", outcome: "ok" }`；文件里没有提示词标记、`upstream-e2e-ok`、`deepseek-e2e-ok` 与隔离 HOME 路径                  |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105103540444-p40365-3d7a0a888dc3e09a`（macOS，1/1 通过，`plm-ext-p3a-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-ext-p3a/` 下 launcher-needs-consent（4 张与撤销后 1 张）、grant-dialog（中文浅色、英文深色）、enable-confirm（英文浅色、中文深色）、permissions-granted（2 张）、permissions-revoked。

P3a 之后复跑（macOS）：PLM-EXT-2B、2C、P2B、P2C（replay）`desktop-e2e-20261105104059072-p60949-16309a48ca6687b6`，4/4 通过；PLM-EXT-2A、P2D、P2E（dummy provider）`desktop-e2e-20261105104932529-p2576-63716138ff94edfa`，3/3 通过。

调试中发现并修掉的问题（有运行时证据）：

- 撤销后「最近操作」没有撤销一行：日志里 `getRecentActions OK` 在 `extension grants revoked` 之前，Renderer 收到新 rev 时审计行还没写。改成写文件 → 写审计 → 发布状态。

未覆盖：Windows/Linux 桌面；插件更新时权限变多、变少、版本静默记录（`reconcile`）；`incompatible`、`limit-exceeded`、换代中止在途调用、卸载删除记录；从插件商店安装的确认见 PLM-EXT-P3B。手机远控没有授权门面只由代码结构保证（频道不在手机白名单）。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-P2C：输入框 `@` 面板的插件分组（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-mention.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P2C。replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH=<upstream>/common.json,<upstream>/plugin-extension-mention.json`，两次发送分别命中本用例的两个主响应。

| 子项                      | 状态    | 证据                                                                                                                                                                                                                                          |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b1 MCP 工具首次调用被拒绝 | covered | 会话里弹审批（截图 `mcp-mention-approval`）；`[extensions] mention items error entry=e2e-mcp-mention@inline/docs target=tool seq=2 code=plugin_mention_tool_denied`；同一查询重开面板没有新审批，组内「已拒绝调用插件工具」，扩展分组仍有三项 |
| b2 始终允许               | covered | 选「始终允许本项目」后组显示 `jzqk` 的两项；`jzqkw` 不再询问；MCP server 调用记录只有 `jzqk`、`jzqkw`                                                                                                                                         |
| a1 慢查询                 | covered | `E2E_MENTION_QUERY q="qx" scope=session:sess_…`；结果回来前组里是上次采用的 `jzqkw` 三项，没有 `qx`                                                                                                                                           |
| a2 快速输入               | covered | `@qxjv` 后组是 `qxjv-1..3`；扩展日志里两次输入只有 `qx`、`qxjv` 两次查询                                                                                                                                                                      |
| a3 旧结果晚到             | covered | `qx` 的 DONE 晚于 `qxjv`；1.5 秒后组仍是 `qxjv-1..3`；4 张截图组名分别是「E2E 条目」「E2E items」                                                                                                                                             |
| a4 选中候选项             | covered | 输入框 markdown 是 `E2E_MENTION_INSERT[qxjv#2] `，提及块显示「E2E qxjv #2」                                                                                                                                                                   |
| a5 发送                   | covered | provider 请求（`/anthropic/v1/messages`）含 `E2E_MENTION_INSERT[qxjv#2] Reply with exactly \"upstream-e2e-ok\"…`；时间线有这条消息                                                                                                            |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105073713167-p28185-d6774a720358e9f0`（macOS，2/2 通过，`plm-ext-p2c-evidence.json`）。截图：`.e2e-artifacts/plugin-management/plm-ext-p2c/` 下 mcp-mention-approval、mcp-mention-denied（2 张）、mcp-mention-items（2 张）、mention-pending、mention-items（4 张）、mention-chip、mention-sent。

调试中发现并修掉的问题（都有运行时证据）：

- fixture 的 MCP server 先 `await` 写文件再登记 `line` 监听，`initialize` 丢失，CLI 等 30 秒后 `connection timed out`：改为先登记监听。
- 面板刚打开时 deferred query 还是空串，同一次输入先查 `""` 再查 `qx`，tool 条目因此多弹一次审批：插件分组改用即时 query（§16.6）。
- 同机并行的其他 E2E 抢走前台，`document.hasFocus()` 为 false，`@` 面板打不开：用例改用 CDP 焦点模拟。

未覆盖：Windows/Linux 桌面；旧 CLI 时分组不显示、远程工作区不显示 tool 分组、扩展进程停止时 command 分组显示「扩展已停止」没有运行时用例；审批等待超过协议 client 默认超时（3 分钟）只让这次查询失败、不回收 CLI 由代码保证（`invalidateConnectionOnTimeout: false`），没有运行时用例。已知限制（CLI）：草稿的预热会话里「始终允许本项目」不会记住，CLI 记 `Project permission update skipped without persisted session`，同一会话下一次查询仍询问（曾在本用例的早期版本复现）。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-P2D：插件设置与扩展的 `settings` 能力（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-settings.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-P2D。不发模型请求。子项 h–k 是 P4 H1（`settings.update`，[扩展进程](../plugins/extension-host.md) §18.1、§18.4 GitLab 第 1 步），子项 l 是 P4 H4（图标）。

| 子项                                       | 状态    | 证据                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a–g、f 设置页保存与清除                    | covered | `plm-ext-p2d-evidence.json` 的 `initialProbe`、`configOptions`、`changedLog`、`probeAfterSave`、`clearedLog`；`tokenLeaks` 为空                                                                                                          |
| h `settings.update` 写入                   | covered | 工具返回 `{"ok":true}`，不含 token；`plugin-secrets.json` 有新 token，`config.json` 只有 `region`；`[extensions] settings update plugin=e2e-ext-settings@inline keys=1 cleared=0`；`E2E_SETTINGS_CHANGED … hasToken=true tokenLength=47` |
| i 只写自己的插件                           | covered | `E2E_SETTINGS_FOREIGN token code=invalid-input`、`E2E_SETTINGS_FOREIGN mode-type code=invalid-input`；第二个插件的 `config.json` 选项为空                                                                                                |
| j 写入后不泄露                             | covered | `updateTokenHits` 只有隔离 HOME 的 `.zcode/cli/plugin-secrets.json`                                                                                                                                                                      |
| k `settings.update` 清除                   | covered | `logout` 返回 `{"ok":true}`；`plugin-secrets.json` 里没有 token；`E2E_SETTINGS_CHANGED … hasToken=false`；`updateTokenLeaksAfterClear` 为空                                                                                              |
| l H4 图标                                  | covered | `icons`：启动页 `lucide lucide-log-in`、导航 `lucide lucide-git-merge`、标签 `lucide lucide-git-pull-request`；截图 settings-update-account-view 中文浅色、英文深色                                                                      |
| m `settings.update` 写普通键（2026-11-07） | covered | `setRegion` 返回 `{"ok":true}`；`config.json` 的 `plugins.options` 是 `{ region: "ap-south" }`，`plugin-secrets.json` 里没有 `region`；`E2E_SETTINGS_CHANGED … region=ap-south keys=region`                                              |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105102639765-p25236-1bb9c6300629f4f7`（macOS，1/1 通过，`plm-ext-p2d-evidence.json`，含 H1 与 H4）。截图：`.e2e-artifacts/plugin-management/plm-ext-p2d/` 下 settings-before、settings-saved（4 张）、settings-cleared、settings-update-account-view（中文浅色、英文深色）。只有 H1 的一轮：`desktop-e2e-20261105100746491-p19298-867cf4b1c629d25d`（1/1 通过）。加 H1 之前的基线：`desktop-e2e-20261105095626885-p78128-ff04b07e578a7c02`（1/1 通过）。 H2、H3 之后复跑：`desktop-e2e-20261105112857168-p10104-f0813d0b56b3ea4a`（与 2A、P2E 同一轮，3/3 通过）。加 m（2026-11-07）：`desktop-e2e-20261107073752557-p3324-3d1de8056f0c4271`（1/1 通过）。

未覆盖：Windows/Linux 桌面；`settings.update` 的入参错误（同一个键既写又清、超长、空入参）只由协议 schema 约束，没有运行时用例；旧 CLI 只返回非敏感值没有运行时用例。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-H2：扩展开预填草稿（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-start-draft.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-H2。不发模型请求。

| 子项           | 状态    | 证据                                                                                                                                                                                                                                                                     |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a 当前工作区   | covered | `E2E_START_DRAFT ok click=1 workspace=current`；`[extensions] workbench.startDraft requested … chars=92 workspace=current` → `[extension-slots] workbench.startDraft {…"ok":true}` → `acked … ok=true`；输入框是预填文字；没有用户消息；任务数 0 → 0；日志里没有预填文字 |
| b 入参不合规   | covered | `E2E_START_DRAFT_INVALID too-long code=invalid-input`、`E2E_START_DRAFT_INVALID blank code=invalid-input`；输入框不变                                                                                                                                                    |
| c 显式传工作区 | covered | `E2E_START_DRAFT ok click=2 workspace=explicit`；输入框是第二段预填文字；没有用户消息；任务数不变                                                                                                                                                                        |
| d 截图         | covered | `.e2e-artifacts/plugin-management/plm-ext-h2/` 下 draft-prefilled-zh-CN-zai-light、draft-prefilled-en-US-zai-dark                                                                                                                                                        |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105105206563-p15044-8317d5193f4d5e12`（macOS，1/1 通过，`plm-ext-h2-evidence.json`）。前一轮 `desktop-e2e-20261105104600794-p81075-6d2ee41208b9ff60` 也通过，但 fixture 的文字以 `#1` 结尾，`#` 是会话提及的触发符，截图里打开了提及面板；改成 `(click N)` 后重跑。

未覆盖：Windows/Linux 桌面；当前工作区只读时回执失败、在设置页或插件市场之上调用时回到对话主视图、没有窗口时 `host-unavailable` 都没有运行时用例。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-EXT-H3：扩展进程的网络跟随设置页（2026-11-05）

正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-network.test.ts`，场景见 [case catalog](../plugin-management-lifecycle-case-catalog.md) 的 PLM-EXT-H3。不发模型请求。这一轮 Main 环境里有 WDIO 上游抓包代理的代理、No Proxy 与 CA（`mainEnvNetwork` 三项都是 true）。

| 子项                      | 状态    | 证据                                                                                                                                                                                                                                               |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a 设置页没有代理          | covered | 只认设置页（2026-11-05 用户决策，与 CLI 一致）：即使 Main 环境里有 WDIO 的代理与 CA，扩展进程也是 `network proxy=none noProxy=none ca=none`，环境里没有任何代理与 CA 变量，`environment proxy: not configured`，请求直连失败，本用例的代理没有记录 |
| b 设置页填代理与 No Proxy | covered | `gen=2 network proxy=settings noProxy=settings ca=env`；`E2E_NETWORK_FETCH error code=CERT_SIGNATURE_FAILURE`；本用例的代理没有记录                                                                                                                |
| c 再填自定义证书          | covered | `gen=3 network proxy=settings noProxy=settings ca=settings`；`E2E_NETWORK_FETCH ok status=200 body={"version":"E2E_GITLAB_VERSION"}`；代理记录 `https GET gitlab.e2e.example.invalid/api/v4/version` complete 200；两张设置页截图                  |
| d 日志不带地址            | covered | `networkLines` 六行都只有来源，没有代理地址与证书路径                                                                                                                                                                                              |

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105112035319-p91114-7b64f257591cfa78`（macOS，1/1 通过，`plm-ext-h3-evidence.json`、`plm-ext-h3-network-capture.json`）。截图：`.e2e-artifacts/plugin-management/plm-ext-h3/` 下 network-settings-zh-CN-zai-light、network-settings-en-US-zai-dark（截图里留着前面保存时弹出的中文提示）。

调试中发现的事实（都有运行时证据）：

- 第一轮 `desktop-e2e-20261105111206867-p69939-56981a8775647455` 失败：manual-review 默认是 capture 模式，WDIO 把上游抓包代理与 CA 写进了 `setting.json`，`gen=1` 就是 `proxy=settings ca=settings`，扩展请求经它回 504。用例改为在重启前清掉这三项。
- 第二轮 `desktop-e2e-20261105111640817-p77840-c926f9c56c030295` 失败：WDIO 也把这些变量写进了自己的环境，Electron 继承，`gen=1` 是 `proxy=env noProxy=env ca=env`。这正是「设置页留空时沿用环境」，断言改为按 Main 环境判断。（这条行为已在 2026-11-05 改为只认设置页，见上面 a 行。）

未覆盖：Windows/Linux 桌面（Windows 上同一变量只写一份）；代理地址不合法、读设置失败的降级；Main 环境里没有代理时的直连（本机 capture 模式下环境总有代理）。人工审核、正式晋升与 Docker 准入保持 pending。

## PLM-DESIGN-001：默认关闭与选择元素安装引导（2026-11-09）

候选 `packages/desktop/test/e2e/plugins/marketplace/manual-review/pending/plugin-design-builtin.test.ts`：覆盖默认未启用、取消提示、页面换路由时撤销提示、跳转指定 Design 详情、启用后在原 Browser 点选并生成元素引用、停用后卸下原页面运行时。macOS 本地通过：`desktop-e2e-20261109085801906-p1216-0c9ab783151fcee9`（1/1）。截图在 `.e2e-artifacts/plugin-management/plm-design-001/`：中文浅色提示、英文深色提示、Design 详情和启用后的点选。

CLI `plugins.test.ts` 验证默认关闭、显式启用/停用及对应技能根与 SessionStart hook 是否装载；与 `bundled-plugins-resilience.test.ts` 共 95 项通过。共享提示窗通过 1280px/390px × 中英文 × 深浅主题的 8 组浏览器布局验收；手机没有 IAB 入口，此处仅验证共享弹窗窄屏布局。

未验证：Windows/Linux 桌面、真实远端断连/重连、查询在途时切换工作区、真正移除内置资源后的安装恢复。候选保持 pending，未做人工晋升或 CI 准入。
