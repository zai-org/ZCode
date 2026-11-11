# E2E 业务场景目录规格

## 目标与边界

按“业务域 → 场景 → 用例”查找 E2E。目录整理不改变产品行为、断言、case ID 或准入规则；候选转正须单独记录人工 review 与回放证据。

桌面 WDIO 用例位于 `packages/desktop/test/e2e/`；浏览器验收脚本仍由各自 runner 执行。CLI/CUA 的独立测试入口不合并到桌面套件。

## 目录契约

```text
packages/desktop/test/e2e/
  <业务域>/<场景>/<case>.test.ts
  <业务域>/<场景>/manual-review/pending/<case>.test.ts
  conversation-session/remote/<场景>/...
  helpers/、pages/、reporting/、fixtures/   # 共享测试设施
packages/web/test/e2e/
  remote-control/<场景>/manual-review/pending/<case>.mjs
  sharing/<场景>/manual-review/pending/<case>.mjs
```

- 按主要断言和用户目标分类，不按作者、版本号、修复批次或运行平台分类。跨场景用例只保留一份，放在主要验收目标下；文件名保持稳定。
- `conversation-session` 检查真实会话中的完整业务链路。独立的设置、插件商店、浏览器和定时任务管理放在对应业务域；不因用例途中打开设置就将会话链路归入设置。
- 正式与候选状态由 `manual-review/pending` 路径表达。转正只去掉该两级目录，保留业务域和场景。目录整理不等于人工 review、转正或 Docker 准入。
- 默认运行与正式覆盖审计递归发现场景目录，排除任意深度的 `manual-review`；显式指定候选仍可运行。SSH 环境门禁、远程队列和已准入 Docker 集合保持原有成员。
- fixture 继续使用稳定的 `<fixture-domain>/<caseName>.json` 索引，场景目录不复制 fixture。manifest/provider fixture 的 `spec` 指向保留场景的正式目标；候选不写当前 pending 路径。文件 fixture、marker、请求分类与 timing policy 不变。
- 移动文件时同步更新 import、基于 `import.meta` 的资源路径、fixture 元数据、覆盖矩阵、运行命令、CI 清单和耗时权重。历史运行产物与覆盖结论不重新生成。
- 新增用例先选择已有场景，确有独立业务目标才新增场景目录。共享 helper 不随用例复制。

### 2026-11-10 人工复核与转正回放

本轮复核 30 个候选文件，用户已确认人工 review。下列 25 个文件完成转正 dry run、正式路径的
独立夹具回放与默认回放：两轮各合计 50/50 通过、0 跳过。默认回放由本机批次的 24 个文件、
49 条测试（`packages/desktop/.e2e-artifacts/promotion-1110-default`）与 SSH 的 1 个文件、
1 条测试（`packages/desktop/.e2e-artifacts/local-docker-20261110103028-ab4b1b`）组成。
表中的独立回放产物均位于 `packages/desktop/.e2e-artifacts/`，每个文件只加载 `common.json` 与自身 fixture。
SSH 独立轮使用 runner 的 `E2E_PROVIDER_REPLAY_FIXTURE_MODE=strict-case-local`，默认轮使用 `compatible`；
两轮均通过 `harness/remote/run-local-docker.mjs` 启动正式路径。

保留原断言、性能阈值与业务场景目录。两个浏览器文件使用正式 V4 helper；历史搜索复用
`isIsolatedE2EHomeDir`，修正旧 basename 守卫误拒默认 `.e2e-home` 的问题。两轮都验证了
默认 HOME 下的历史搜索；仍拒绝普通 HOME，不改变产品搜索逻辑。
16 个无需模型的文件声明 `providerRequestPolicy: "none"`，独立回放抓包均为零模型请求。
插件响应合同及合成数据边界见[插件覆盖矩阵](plugin-management-lifecycle-e2e-coverage-matrix.md)。

| 正式入口（相对 `packages/desktop/test/e2e/`） | 测试数 | 独立回放产物 |
| --- | ---: | --- |
| `bots/delivery/bot-large-attachment.test.ts` | 12 | `promotion-1110-explicit-01` |
| `browser/files/browser-download-navigation-address.test.ts` | 1 | `promotion-1110-explicit-02` |
| `browser/files/browser-local-html-preview.test.ts` | 1 | `promotion-1110-explicit-03` |
| `plugins/extensions/plugin-extension-entries.test.ts` | 2 | `promotion-1110-explicit-04` |
| `plugins/extensions/plugin-extension-host-runtime.test.ts` | 1 | `promotion-1110-explicit-05` |
| `plugins/extensions/plugin-extension-jarvis-host.test.ts` | 2 | `promotion-1110-explicit-06` |
| `plugins/extensions/plugin-extension-logs.test.ts` | 1 | `promotion-1110-explicit-07` |
| `plugins/extensions/plugin-extension-mention.test.ts` | 2 | `promotion-1110-explicit-08` |
| `plugins/extensions/plugin-extension-network.test.ts` | 1 | `promotion-1110-explicit-09` |
| `plugins/extensions/plugin-extension-plugin-project.test.ts` | 1 | `promotion-1110-explicit-10` |
| `plugins/extensions/plugin-extension-session-approvals.test.ts` | 1 | `promotion-1110-explicit-11-final` |
| `plugins/extensions/plugin-extension-sessions-read.test.ts` | 2 | `promotion-1110-explicit-12` |
| `plugins/extensions/plugin-extension-sessions-write.test.ts` | 2 | `promotion-1110-explicit-13` |
| `plugins/extensions/plugin-extension-settings.test.ts` | 1 | `promotion-1110-explicit-14` |
| `plugins/extensions/plugin-extension-start-draft.test.ts` | 1 | `promotion-1110-explicit-15` |
| `plugins/extensions/plugin-extension-views.test.ts` | 1 | `promotion-1110-explicit-16` |
| `plugins/extensions/plugin-store-extension-compat.test.ts` | 1 | `promotion-1110-explicit-17` |
| `settings/agent/settings-agent-behavior.test.ts` | 3 | `promotion-1110-explicit-18` |
| `settings/general/settings-navigation-search.test.ts` | 4 | `promotion-1110-explicit-19` |
| `ui-shell/composer/draft-greeting-layout.test.ts` | 1 | `promotion-1110-explicit-20` |
| `ui-shell/navigation/sidebar-rich-content-performance.test.ts` | 2 | `promotion-1110-explicit-21` |
| `ui-shell/navigation/sidebar-toggle-performance.test.ts` | 2 | `promotion-1110-explicit-22` |
| `workspace/projects/project-native-directory-picker.test.ts` | 1 | `promotion-1110-explicit-23` |
| `ui-shell/navigation/command-center-history-search.test.ts` | 3 | `promotion-1110-explicit-24` |
| `conversation-session/remote/connection/conversation-session-remote-draft-prewarm.test.ts` | 1 | `local-docker-20261110102824-d5e7e3` |

其余 5 个文件保留 pending，失败与未验证分开记录：

| 候选文件 | 本轮结果与未覆盖项 |
| --- | --- |
| `plugin-extension-sessions.test.ts` | 失败：设置返回后的侧栏启动页不可见；撤销后的启动页授权行及审计字段未完成。证据：`desktop-e2e-20261110-091822-523`。 |
| `office-preview-security.test.ts` | OPS01/03 通过；OPS02 等待 XLSX Canvas 超时，后续外链与工作表跳转未执行。证据同上。 |
| `conversation-session-streaming-history-performance.test.ts` | 失败：compact 请求缺少 fixture，回放服务返回 500，未进入流式性能及后续导航断言。证据：`promotion-1110-pending-extra`。 |
| `windows-tray-export-logs.test.ts` | 未执行：当前为 macOS，需 Windows 实机；不能将平台 skip 计为通过。 |
| `conversation-session-snapshot-retention.test.ts` | 未执行：独立 `node:test + CDP` 生产 renderer 用例；正式 runner 准入尚未完成，不能直接移动进 WDIO。 |

本轮验证 macOS Electron、SSH Linux arm64 服务端及各用例已有的浏览器/真实 shared-host 路径，
不等同于手机实机或 Windows/Linux 桌面验证。未新增 Docker preset 或三平台 CI 准入。

代码检查：桌面 E2E 与根类型检查、Lint、架构检查、conversation 覆盖审计通过；
Lint 的 671 条既有警告均不在本次改动文件。测试及 JSON 格式、路径与 fixture 合同检查通过。

## 业务域导航

| 目录                                                                          | 业务范围                 | 文件数 |
| ----------------------------------------------------------------------------- | ------------------------ | -----: |
| [auth-config](../../packages/desktop/test/e2e/auth-config/)                   | 登录与凭据               |     12 |
| [automations](../../packages/desktop/test/e2e/automations/)                   | 定时与闲时任务管理       |      7 |
| [bots](../../packages/desktop/test/e2e/bots/)                                 | Bot 消息接入与投递       |     18 |
| [browser](../../packages/desktop/test/e2e/browser/)                           | 内置浏览器               |     17 |
| [coding-plan](../../packages/desktop/test/e2e/coding-plan/)                   | 套餐、升级与权益         |      8 |
| [conversation-session](../../packages/desktop/test/e2e/conversation-session/) | 会话内业务链路           |    581 |
| [feedback](../../packages/desktop/test/e2e/feedback/)                         | 帮助、反馈与日志         |      6 |
| [git](../../packages/desktop/test/e2e/git/)                                   | Git 提交与工作树         |      2 |
| [infrastructure](../../packages/desktop/test/e2e/infrastructure/)             | 启动与测试运行设施       |      5 |
| [plugins](../../packages/desktop/test/e2e/plugins/)                           | 插件管理与扩展           |     38 |
| [remote-control](../../packages/desktop/test/e2e/remote-control/)             | 桌面远控入口             |      5 |
| [resource-manager](../../packages/desktop/test/e2e/resource-manager/)         | 资源管理与遥测           |      5 |
| [settings](../../packages/desktop/test/e2e/settings/)                         | 设置、模型供应商与快捷键 |     26 |
| [ui-shell](../../packages/desktop/test/e2e/ui-shell/)                         | 主界面、侧栏与面板       |     27 |
| [usage-stats](../../packages/desktop/test/e2e/usage-stats/)                   | 使用统计                 |      1 |
| [workspace](../../packages/desktop/test/e2e/workspace/)                       | 项目工作区与文件         |     14 |

会话远程场景位于 `conversation-session/remote/`，继续保留会话 fixture 合同；`remote-control` 检查桌面端远控开关与登录入口。

## 桌面分类索引

数字是 2026-11-09 目录整理时的快照，未计入本轮转正；不是 `it` 数或通过数。759 个 WDIO 文件（533 个正式、226 个候选）和 13 个浏览器验收脚本；候选中未执行或已有失败的用例仍保持原状态。

| 业务域 / 场景                                                                                                           | 正式 WDIO | 候选 WDIO | 浏览器脚本 |
| ----------------------------------------------------------------------------------------------------------------------- | --------: | --------: | ---------: |
| [auth-config/credentials](../../packages/desktop/test/e2e/auth-config/credentials/)                                     |         1 |         4 |          0 |
| [auth-config/login](../../packages/desktop/test/e2e/auth-config/login/)                                                 |         3 |         1 |          0 |
| [auth-config/session](../../packages/desktop/test/e2e/auth-config/session/)                                             |         3 |         0 |          0 |
| [automations/off-peak](../../packages/desktop/test/e2e/automations/off-peak/)                                           |         3 |         0 |          0 |
| [automations/schedule](../../packages/desktop/test/e2e/automations/schedule/)                                           |         3 |         0 |          0 |
| [automations/workflows](../../packages/desktop/test/e2e/automations/workflows/)                                         |         1 |         0 |          0 |
| [bots/channels](../../packages/desktop/test/e2e/bots/channels/)                                                         |         6 |         1 |          0 |
| [bots/delivery](../../packages/desktop/test/e2e/bots/delivery/)                                                         |         4 |         1 |          0 |
| [bots/runtime](../../packages/desktop/test/e2e/bots/runtime/)                                                           |         6 |         0 |          0 |
| [browser/design](../../packages/desktop/test/e2e/browser/design/)                                                       |         5 |         0 |          0 |
| [browser/files](../../packages/desktop/test/e2e/browser/files/)                                                         |         1 |         2 |          0 |
| [browser/permissions](../../packages/desktop/test/e2e/browser/permissions/)                                             |         2 |         0 |          0 |
| [browser/settings](../../packages/desktop/test/e2e/browser/settings/)                                                   |         1 |         0 |          0 |
| [browser/tabs](../../packages/desktop/test/e2e/browser/tabs/)                                                           |         4 |         2 |          0 |
| [coding-plan/account](../../packages/desktop/test/e2e/coding-plan/account/)                                             |         3 |         0 |          0 |
| [coding-plan/highspeed](../../packages/desktop/test/e2e/coding-plan/highspeed/)                                         |         0 |         2 |          0 |
| [coding-plan/upgrade](../../packages/desktop/test/e2e/coding-plan/upgrade/)                                             |         3 |         0 |          0 |
| [conversation-session/attachments](../../packages/desktop/test/e2e/conversation-session/attachments/)                   |        11 |         1 |          0 |
| [conversation-session/automations](../../packages/desktop/test/e2e/conversation-session/automations/)                   |         9 |         2 |          0 |
| [conversation-session/background](../../packages/desktop/test/e2e/conversation-session/background/)                     |         8 |         2 |          0 |
| [conversation-session/branching](../../packages/desktop/test/e2e/conversation-session/branching/)                       |        10 |         3 |          0 |
| [conversation-session/browser-use](../../packages/desktop/test/e2e/conversation-session/browser-use/)                   |         5 |         2 |          0 |
| [conversation-session/composer](../../packages/desktop/test/e2e/conversation-session/composer/)                         |        12 |         3 |          0 |
| [conversation-session/context](../../packages/desktop/test/e2e/conversation-session/context/)                           |        10 |         2 |          0 |
| [conversation-session/editing](../../packages/desktop/test/e2e/conversation-session/editing/)                           |         5 |         2 |          0 |
| [conversation-session/entitlements](../../packages/desktop/test/e2e/conversation-session/entitlements/)                 |         7 |         0 |          0 |
| [conversation-session/execution](../../packages/desktop/test/e2e/conversation-session/execution/)                       |        10 |         2 |          0 |
| [conversation-session/goals](../../packages/desktop/test/e2e/conversation-session/goals/)                               |         9 |         1 |          0 |
| [conversation-session/history](../../packages/desktop/test/e2e/conversation-session/history/)                           |         5 |         1 |          0 |
| [conversation-session/hooks](../../packages/desktop/test/e2e/conversation-session/hooks/)                               |         2 |         1 |          0 |
| [conversation-session/models](../../packages/desktop/test/e2e/conversation-session/models/)                             |        40 |         5 |          0 |
| [conversation-session/permissions](../../packages/desktop/test/e2e/conversation-session/permissions/)                   |        16 |         0 |          0 |
| [conversation-session/planning](../../packages/desktop/test/e2e/conversation-session/planning/)                         |         9 |         0 |          0 |
| [conversation-session/plugins](../../packages/desktop/test/e2e/conversation-session/plugins/)                           |        18 |         3 |          0 |
| [conversation-session/presentation](../../packages/desktop/test/e2e/conversation-session/presentation/)                 |        16 |         9 |          0 |
| [conversation-session/projects](../../packages/desktop/test/e2e/conversation-session/projects/)                         |        14 |        10 |          0 |
| [conversation-session/queue](../../packages/desktop/test/e2e/conversation-session/queue/)                               |        13 |         2 |          0 |
| [conversation-session/remote/configuration](../../packages/desktop/test/e2e/conversation-session/remote/configuration/) |         7 |        12 |          0 |
| [conversation-session/remote/connection](../../packages/desktop/test/e2e/conversation-session/remote/connection/)       |        15 |        21 |          0 |
| [conversation-session/remote/data-sync](../../packages/desktop/test/e2e/conversation-session/remote/data-sync/)         |         0 |        15 |          0 |
| [conversation-session/remote/execution](../../packages/desktop/test/e2e/conversation-session/remote/execution/)         |         8 |         7 |          0 |
| [conversation-session/remote/installation](../../packages/desktop/test/e2e/conversation-session/remote/installation/)   |         7 |        21 |          0 |
| [conversation-session/remote/mobile](../../packages/desktop/test/e2e/conversation-session/remote/mobile/)               |         0 |         8 |          0 |
| [conversation-session/remote/navigation](../../packages/desktop/test/e2e/conversation-session/remote/navigation/)       |        17 |        13 |          0 |
| [conversation-session/runtime](../../packages/desktop/test/e2e/conversation-session/runtime/)                           |        11 |        10 |          0 |
| [conversation-session/session-control](../../packages/desktop/test/e2e/conversation-session/session-control/)           |         3 |         4 |          0 |
| [conversation-session/sharing](../../packages/desktop/test/e2e/conversation-session/sharing/)                           |         3 |         2 |          0 |
| [conversation-session/smoke](../../packages/desktop/test/e2e/conversation-session/smoke/)                               |         2 |         0 |          0 |
| [conversation-session/subagents](../../packages/desktop/test/e2e/conversation-session/subagents/)                       |        19 |         2 |          0 |
| [conversation-session/task-management](../../packages/desktop/test/e2e/conversation-session/task-management/)           |        20 |         4 |          0 |
| [conversation-session/telemetry](../../packages/desktop/test/e2e/conversation-session/telemetry/)                       |         4 |         2 |          0 |
| [conversation-session/tools](../../packages/desktop/test/e2e/conversation-session/tools/)                               |        29 |         1 |          0 |
| [conversation-session/workflows](../../packages/desktop/test/e2e/conversation-session/workflows/)                       |        25 |         0 |          9 |
| [feedback/help](../../packages/desktop/test/e2e/feedback/help/)                                                         |         3 |         0 |          0 |
| [feedback/logs](../../packages/desktop/test/e2e/feedback/logs/)                                                         |         1 |         1 |          0 |
| [feedback/upload](../../packages/desktop/test/e2e/feedback/upload/)                                                     |         1 |         0 |          0 |
| [git/commit](../../packages/desktop/test/e2e/git/commit/)                                                               |         1 |         0 |          0 |
| [git/worktrees](../../packages/desktop/test/e2e/git/worktrees/)                                                         |         0 |         1 |          0 |
| [infrastructure/lifecycle](../../packages/desktop/test/e2e/infrastructure/lifecycle/)                                   |         1 |         0 |          0 |
| [infrastructure/smoke](../../packages/desktop/test/e2e/infrastructure/smoke/)                                           |         4 |         0 |          0 |
| [plugins/extensions](../../packages/desktop/test/e2e/plugins/extensions/)                                               |         0 |        15 |          0 |
| [plugins/installation](../../packages/desktop/test/e2e/plugins/installation/)                                           |         6 |         4 |          0 |
| [plugins/marketplace](../../packages/desktop/test/e2e/plugins/marketplace/)                                             |         6 |         2 |          0 |
| [plugins/runtime](../../packages/desktop/test/e2e/plugins/runtime/)                                                     |         3 |         1 |          0 |
| [plugins/telemetry](../../packages/desktop/test/e2e/plugins/telemetry/)                                                 |         1 |         0 |          0 |
| [remote-control/authentication](../../packages/desktop/test/e2e/remote-control/authentication/)                         |         1 |         2 |          0 |
| [remote-control/connection](../../packages/desktop/test/e2e/remote-control/connection/)                                 |         0 |         1 |          1 |
| [resource-manager/network](../../packages/desktop/test/e2e/resource-manager/network/)                                   |         1 |         0 |          0 |
| [resource-manager/processes](../../packages/desktop/test/e2e/resource-manager/processes/)                               |         1 |         0 |          0 |
| [resource-manager/storage](../../packages/desktop/test/e2e/resource-manager/storage/)                                   |         1 |         0 |          0 |
| [resource-manager/telemetry](../../packages/desktop/test/e2e/resource-manager/telemetry/)                               |         2 |         0 |          0 |
| [settings/agent](../../packages/desktop/test/e2e/settings/agent/)                                                       |         2 |         1 |          1 |
| [settings/general](../../packages/desktop/test/e2e/settings/general/)                                                   |         4 |         1 |          0 |
| [settings/mcp](../../packages/desktop/test/e2e/settings/mcp/)                                                           |         1 |         2 |          0 |
| [settings/providers](../../packages/desktop/test/e2e/settings/providers/)                                               |        11 |         0 |          0 |
| [settings/shortcuts](../../packages/desktop/test/e2e/settings/shortcuts/)                                               |         3 |         0 |          0 |
| [ui-shell/composer](../../packages/desktop/test/e2e/ui-shell/composer/)                                                 |         2 |         1 |          0 |
| [ui-shell/marketing](../../packages/desktop/test/e2e/ui-shell/marketing/)                                               |         6 |         0 |          0 |
| [ui-shell/navigation](../../packages/desktop/test/e2e/ui-shell/navigation/)                                             |         5 |         4 |          0 |
| [ui-shell/panels](../../packages/desktop/test/e2e/ui-shell/panels/)                                                     |         5 |         1 |          0 |
| [ui-shell/performance](../../packages/desktop/test/e2e/ui-shell/performance/)                                           |         0 |         0 |          1 |
| [ui-shell/permissions](../../packages/desktop/test/e2e/ui-shell/permissions/)                                           |         1 |         0 |          0 |
| [ui-shell/updates](../../packages/desktop/test/e2e/ui-shell/updates/)                                                   |         0 |         0 |          1 |
| [usage-stats/application](../../packages/desktop/test/e2e/usage-stats/application/)                                     |         1 |         0 |          0 |
| [workspace/files](../../packages/desktop/test/e2e/workspace/files/)                                                     |         3 |         1 |          0 |
| [workspace/projects](../../packages/desktop/test/e2e/workspace/projects/)                                               |         0 |         1 |          0 |
| [workspace/recovery](../../packages/desktop/test/e2e/workspace/recovery/)                                               |         1 |         0 |          0 |
| [workspace/runtime](../../packages/desktop/test/e2e/workspace/runtime/)                                                 |         7 |         1 |          0 |

## Web 浏览器验收

`remote-control` 分为 authentication、projects、transport；`sharing` 分为 authentication、content、workflows。18 个入口脚本与 4 个同场景 helper/fixture 一起移动，保留原启动方式和候选状态。

## 运行示例

```bash
# 正式场景集合；默认继续排除候选和不满足环境门禁的远程 case。
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/queue/**/*.test.ts'

# 单个正式用例。
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/composer/conversation-session-first-send.test.ts'

# 候选转正预览：保留 editing 场景，不自动批准 review。
pnpm --filter @zcode/desktop e2e:promote -- --spec './test/e2e/conversation-session/editing/manual-review/pending/conversation-session-edit.test.ts'
```

## 迁移验收

1. 对照迁移前后的文件名集合、正式/候选集合、Docker preset、远程队列和 CI 权重，确保没有新增、遗漏或重复。
2. 运行工程回归，验证嵌套发现、候选排除、环境门禁、fixture 正式目标、转正与准入路径。
3. 运行 E2E 类型检查、根类型检查、lint、架构检查、fixture 检查和会话覆盖审计；检查旧路径残留与文件资源解析。
4. 用真实桌面 runner 验证移动后的 smoke 与代表性 case-local replay；浏览器脚本检查资源与模块路径。目录迁移验证不扩大已有平台或业务覆盖声明。

相关流程：[会话开发流程](conversation-session-e2e-development-workflow.md)、[容器运行](desktop-e2e-container.md)、[正式覆盖矩阵](conversation-session-e2e-coverage-matrix.md)。
