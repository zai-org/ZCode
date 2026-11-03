# Plugin Management Lifecycle E2E Coverage Matrix

> `retired:` 逐处标记已退役 App 单测，仅供追溯；原通过记录不代表现行覆盖。独立断言缺口需由后续验收补齐。

> 2026-10-26：App 业务单测已按[测试规格](unit-test-quality.md)退役。本文中的相关单测路径和历史通过记录不再代表现行覆盖；CLI/CUA、工程测试、E2E 与浏览器验收证据仍按各自状态解释。未补验收的场景不得自动视为已覆盖。

## 2026-10-19 人工复核与正式回放

用户已审阅候选通过项，12 个插件 spec 已完成正式路径的独立 fixture 和默认回放；其余 3 个因标题响应补齐后尚待复验，先保留 pending。
本轮逐文件入口、候选证据及正式回放结果以[批量清单](./conversation-session-e2e-coverage-matrix.md#2026-10-19-人审通过项迁移清单)为准。
`plugin-management-recoverable-failures` 因已记录的来源错误丢失缺陷继续 pending；
`plugin-cdn-zip-official-cdn-smoke` 是用户确认的唯一人工例外。
其他历史段落中的 pending/never 仅描述当时状态；`plugin-no-git-github-archive` 已获准进入正式入口。
本地回放不代表 Linux Docker 或三平台 CI 已验证，当前没有新增 Docker admission。

本矩阵追踪 [Plugin Management Lifecycle Case Catalog](../plugin-management-lifecycle-case-catalog.md)
中的候选 case 从 manual review 到三平台正式门禁的状态。`manual-review` 不等于默认质量门禁覆盖。

## Coverage status

### 非官方市场风险确认（2026-10-29）

- 浏览器候选：`packages/ui/test/browser/manual-review/pending/plugin-marketplace-risk.test.mjs`，8/8 通过。覆盖未勾选/撤销勾选、按钮/Enter、关闭重开、失败重试、提交中防重、中英文及深浅主题。日志与截图：`packages/desktop/.e2e-artifacts/marketplace-risk-20261029/browser/`。受控提交回调验证共享弹框，不代表真实手机 Host。
- 桌面独立风险用例：`plugins/plugin-localization-creator.test.ts` 的“非官方市场必须确认风险才能添加，关闭后重新确认”，1/1 通过；共享添加 helper 显式勾选。运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261029122013512-p41331-196fa3432633342b/`。通过 `ZCODE_E2E_MOCHA_GREP='非官方市场必须确认风险'` 选择此场景。
- 同文件原有完整本地化用例仍在最后的窄屏商店布局断言失败：`clientWidth=269, scrollWidth=306, viewportWidth=390`。恢复基线 `024fde56b5` 的原始弹框、用例和 helper 后结果相同，基线产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261029121823423-p33643-11909677e38e9a71/`。该失败不计为通过，未修改商店布局或放宽断言。
- 本次不新增人工晋级或 Docker/CI 准入；实际手机远控及 Windows/Linux 待验。

### 全部更新回归（2026-10-27）

- `packages/ui/test/browser/manual-review/pending/plugin-update-all.test.mjs`：8/8 通过。
  1200px/en-US/浅色与 390px/zh-CN/深色，分别验证服务实例替换、Scope 切换后切回、
  管理视图卸载时旧批次停止，以及不切换时两项正常完成。使用真实 `PluginList` 和 scoped store，
  服务响应由 fixture 控制；这不是实际 SSH/手机 Host 连接验证。
- `plugins/plugin-management-personal-lifecycle.test.ts`：macOS replay 1/1 通过（34.6s），
  保留行内更新、全部更新成功、v2 runtime 与卸载验证。
- `plugins/manual-review/pending/plugin-update-all-failure.test.ts`：macOS replay 1/1 通过（10.6s）。
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

Todo103 新增/迁接候选：PLM-LC-018/019 对应 `plugins/manual-review/pending/plugin-store-auto-refresh-{throttled,on-enter}.test.ts`；Pro `desktop-e2e-20260909-152018-653` 两例通过。PLM-LC-020 对应 `plugins/plugin-subagent-override-cold.test.ts`，Pro `desktop-e2e-20260909-152419-828` 冷启动 child/父 continuation 请求验证通过，case-local fixture check 通过。三项均未人工晋级；019 保持公网 smoke、不进入正式 CI。

| Abbreviation | Pending spec                                                                        |
| ------------ | ----------------------------------------------------------------------------------- |
| `PD` / `PP`  | `plugins/plugin-management-discovery-presentation.test.ts`                          |
| `PM`         | `plugins/plugin-management-personal-lifecycle.test.ts`                              |
| `PV` / `PO`  | `plugins/plugin-management-persistence-source.test.ts`                              |
| `PB` / `PI`  | `plugins/plugin-management-builtin-inline.test.ts`                                  |
| `PC`         | `plugins/plugin-cdn-zip-marketplace-install.test.ts`                                |
| `PCS`        | `plugins/manual-review/pending/plugin-cdn-zip-official-cdn-smoke.test.ts`           |
| `PF`         | `plugins/manual-review/pending/plugin-management-recoverable-failures.test.ts`      |
| `PEA`        | `plugins/plugin-runtime-env-agent-projection.test.ts`                               |
| `PGA`        | `plugins/plugin-no-git-github-archive.test.ts`                                      |
| `PRA`        | `plugins/manual-review/pending/plugin-refresh-atomic-cache.test.ts`                 |
| `PBD`        | `plugins/manual-review/pending/plugin-management-builtin-detail-parity.test.ts`     |
| `PBO`        | `plugins/manual-review/pending/plugin-management-bundled-install-ownership.test.ts` |
| `PBS`        | `plugins/manual-review/pending/plugin-management-seed-runtime-separation.test.ts`   |
| `PML`        | `plugins/plugin-management-installed-menu-layout.test.ts`                           |

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

PLM-LC-018/019/020：`plugins/plugin-localization-creator.test.ts`，pending、未执行、未人工审核。单测补充异步目标失效、完整 ID 隔离、缺失/禁用 creator；不作为真实手机或 SSH 端到端证据。

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
| PLM-TEL-001 | 插件安装最终结果与隐私 | `plugins/plugin-lifecycle-telemetry.test.ts` | macOS Electron 回放通过 | pending，未加入 CI |

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

`PLM-UI-CONNECTION-READY`：`--managed-only` 控制真实 MCP initialize 完成顺序，验证生产
React 面板等待连接后自动运行、无错误闪现和重复实例。2026-10-16 macOS Electron 专项通过；未晋升 CI。
独立 worktree 使用标准命令整组回归，`managed` 27 项、`managed-empty` 1 项、`interaction` 1 项全部通过，
证据批次 `zcode-mcp-host-e2e-f1vN0y`。此前整组运行出现过 guest 崩溃重建超时和锚点切换后
点击断言失败，独立复跑均通过；保留原失败证据，不据此认定稳定性问题已解决。

## PLM-CONCURRENT-INSTALL：并发安装忙碌态

- 浏览器候选：`packages/ui/test/browser/manual-review/pending/plugin-concurrent-install.test.mjs`。真实 store 和安装按钮，390/1200px × 中英文 × 深浅主题共 8 组通过；旧实现 8 组均在第二次安装清掉第一次忙碌态处失败。日志和截图写入系统临时目录的 `zcode-plugin-concurrent-install/`。
- 桌面正式用例：`plugins/plugin-concurrent-install.test.ts`。macOS Electron + 真实 CLI，个人来源本地 HTTP 下载响应门验证两项同时安装中、第一项失败不清理第二项、两项失败后均可重试；运行 `desktop-e2e-20261015143344848-p62610-27dafbf8f737df99` 通过。截图位于 `.e2e-artifacts/plugin-management/plm-concurrent-install/both-pending.png`。
- 离线执行：`ZCODE_E2E_MANUAL_REVIEW=1 E2E_PROVIDER_HTTP_MODE=replay E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/plugins/plugin-concurrent-install.test.ts'`。
- PLM-DETAIL-DURING-INSTALL：同一桌面用例中，A 下载被响应门挂起、B 排在 A 后面时打开本地插件详情，组件区 30 秒内渲染技能，返回后两项仍为安装中。修复后运行 `desktop-e2e-20261019044431890-p93406-b0458048236a975f` 通过，截图 `.e2e-artifacts/plugin-management/plm-detail-during-install/detail-loaded.png`；还原 CLI 修复后运行 `desktop-e2e-20261019044633752-p3203-b44c097feed8ea0d` 在组件区等待处失败。
- 新建右侧标签页骨架屏（list/overview 排队）：同一桌面用例在 A 下载挂起、B 排队时经桌面服务链路请求 `listPlugins` 与 `getPluginsOverview`，要求 10 秒内返回。修复后运行 `desktop-e2e-20261019062945458-p57938-d3a0c643c27817e2` 通过；只还原 transport 的 list/overview 立即派发后，运行 `desktop-e2e-20261019063058281-p64564-98a2c55f0e022488` 在该步失败（`plugins/list and plugins/overview waited for the install`）。现场证据：dev 日志 `listPlugins`/`getPluginsOverview` 耗时 14569 ms，在第二次安装结束 1.4 秒后才返回。
- store 回归覆盖成功乱序、失败、同名操作及上下文切换隔离、来源校验与安装交叠。浏览器成功路径使用受控服务，不等于真实下载成功验证。手机真机/远控、Windows/Linux 未执行。浏览器用例 pending；桌面用例已转正，PLM-DETAIL-DURING-INSTALL 与 list/overview 两步经作者确认随之转正。

WPL-009 与 PGA 的 Agent bridge setup 先通过侧栏进入指定项目草稿，使 workspace App 注册真实服务入口。全局未归类草稿没有这组 action，不能用轮询时长替代前置导航。

## PLM-BUILTIN-UI-UNINSTALL：内置 UI 插件卸载后的分组

- 桌面候选：`plugins/manual-review/pending/plugin-builtin-ui-uninstall.test.ts`。macOS Electron + 真实 CLI，卸载 `documents@zcode-plugins-official` 后卡片仍在 UI 插件专区。修复后运行 `desktop-e2e-20261019071852360-p65132-d5426628aee5a21e` 通过，截图 `.e2e-artifacts/plugin-management/plm-builtin-ui-uninstall/restorable-in-ui-section.png`；还原 CLI 修复后运行 `desktop-e2e-20261019072006864-p72979-1022c7e87a447a4e` 在 restorable 阶段失败（卡片不在 UI 插件专区）。
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

现行入口为已转正的 `plugins/plugin-management-ui-market.test.ts`，保留首轮前打开、审批、跨工作区返回、首发同 guest 和过期打开请求取消。2026-10-19 及更早的 App 单测记录为退役前历史证据；session 清理沿用统一生命周期 owner，仍由 CLI 回归验证。

本轮 macOS Electron 44.7.0 run `desktop-e2e-20261028080939958-p772-17d40b5d35bfdf55` 完整通过（1/1，0 skipped），包括项目子菜单选择和原草稿全部断言，录屏及关键帧已留存。CLI 138 项与共享审批浏览器 8 项通过；浏览器覆盖 390/1200px、深浅主题，不代表手机实机。

### 2026-10-30 v3.17.2 移植验收

`PLM-UI-001` 在 hotfix 基线移植后首次运行通过（1/1、0 skipped），macOS arm64 / Electron 44.7.0。证据目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20261030044614273-p5180-8d87823b0b07505c`，包含录屏、草稿授权后与首发后关键帧。原草稿入口、审批、零正式任务、跨工作区返回、首发同 guest、完整视图及旧打开请求取消断言全部执行。CLI 138 项、浏览器 8 项及类型/lint/架构/fixture 检查通过；不将历史 App 单测或工程 affected 未选中结果算作本轮通过测试。桌面为中文深色，审批浏览器覆盖 390/1200px、深浅主题；真实手机、Windows/Linux 和长时回收未验证。
