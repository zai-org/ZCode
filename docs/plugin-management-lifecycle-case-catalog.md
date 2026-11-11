# Plugin Management Lifecycle Case Catalog

本文定义 Desktop 本地插件管理的用户级生命周期合同。只有包含独立 setup、action、assertion
和 evidence 的 case 才算覆盖；仅从某条长路径中经过某状态不算覆盖。

## Scope and state ownership

- Included：Desktop local workspace、user-scope plugin storage、Public/Personal、Builtin、CDN、
  Personal Source、inline 展示、重启恢复、代表性运行时注入、关键可恢复失败。
- Excluded：Standalone Web、手机 `/remote`、remote workspace plugin sync、workspace-scope 安装、
  公网依赖的正式 CI、完整 locale/theme/viewport 笛卡尔积。
- 安装、配置、enabled、来源和抑制状态由 `<E2E_HOME>/.zcode/cli/plugins` 与 CLI config 持久化；
  UI store 是投影，不是权威来源。
- Desktop local workspace A/B 共用同一 E2E HOME，验证当前 user-scope 语义。

```text
UI entry
  | Settings > Plugins
  v
pluginManagementStore
  | typed plugin service
  v
ZCode Agent plugin handlers
  |                     |
  v                     v
user plugin storage     future session runtime discovery
(source/install/config) (Skill + MCP evidence)
```

## 非官方市场风险确认

非官方市场风险确认：复用 `plugin-localization-creator.test.ts` 的添加来源路径，以及浏览器候选 `plugin-marketplace-risk.test.mjs`。独立断言未勾选时按钮/Enter 不提交、勾选后可添加、撤销勾选恢复阻止、关闭/成功后重置、失败保留确认、提交中不重复。浏览器覆盖桌面/窄屏 Web、中英文、Zai Light/Zai Dark；浏览器受控回调不代表真实手机 Host 验证。行为合同见 [plugin-creator](plugin-creator.md#非官方市场风险确认)。

## Status vocabulary

| Status          | Meaning                                            |
| --------------- | -------------------------------------------------- |
| `manual-review` | 自动操作已实现，等待人工确认截图与产品行为         |
| `formal`        | 人工确认后已提升为默认稳定 E2E                     |
| `bug-candidate` | 当前产品缺口，不写成绿色预期，也不在测试任务中修复 |
| `pruned`        | 明确不做，保留剪枝理由                             |

## Accepted cases

| Case                                           | Setup                                                                                             | Action                                                                                                                                                                    | Assertions                                                                                                                                                                                                                                                                            | Evidence                                                                        | Initial status                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `PLM-LC-001 discovery-navigation`              | 隔离 HOME，Public、Community 与 Personal 均有确定性目录                                           | 从 Settings 进入 Plugins；切换分段；当前分段搜索/清空；验证分组默认全部展开并手动收起/展开；经 Card、市场内 Manage 进入详情并返回                                         | 默认 Public；公开分类与个人市场默认全部展开、手动折叠有效；搜索限定当前来源；清空恢复；返回保留 segment/query/scroll；市场与管理往返可达                                                                                                                                              | DOM + URL-free UI state + screenshot                                            | `manual-review`                  |
| `PLM-LC-002 presentation`                      | zh-CN/Zai Light/宽屏与 en-US/Zai Dark/窄屏两组                                                    | 打开列表、详情、Manage 和来源弹窗                                                                                                                                         | 核心动作可见可操作；无横向溢出；长文案不覆盖控件                                                                                                                                                                                                                                      | DOM layout + a11y role + screenshot                                             | `manual-review`                  |
| `PLM-LC-003 personal-main-lifecycle`           | 本地目录 Personal Source，复合插件 v1                                                             | UI 添加来源、找插件、打开详情、两次点击 Example Prompt、配置、跨入口启停、检查更新（主插件与附加插件 extra-1 同时有 v2）、行内更新 extra-1、全部更新主插件、卸载取消/确认 | 五类组件可见；第一次只安装；第二次只建草稿且不发送；配置/enabled 正确；检查更新后已安装行出现「可更新」角标与行内更新入口，分组头部出现「全部更新」；行内更新使 extra-1 到 v2，全部更新使主插件到 v2 且按钮消失；取消不改变状态；确认后清理                                           | UI + overview/list + storage + provider capture                                 | `manual-review`                  |
| `PLM-LC-004 persistence-local-visibility`      | v1 已安装、配置并禁用                                                                             | 重启 app；切换本地 workspace A→B                                                                                                                                          | source/install/config/disabled 重启后保持；B 可见同一 user-scope 状态                                                                                                                                                                                                                 | UI + persisted JSON + workspace switch                                          | `manual-review`                  |
| `PLM-LC-005 source-orphan-reassociate`         | Personal 插件已安装                                                                               | 删除来源；使用/配置/启停；重新添加同一来源                                                                                                                                | 安装保留并标为来源缺失；菜单、详情、角标与行内更新入口均不可见；功能仍可用；重新添加后 listing/update 关联恢复                                                                                                                                                                        | UI + installed/config files + runtime marker                                    | `manual-review`                  |
| `PLM-LC-006 builtin-suppress-restore`          | 隔离 HOME 中 Builtin 已启用且含配置/数据                                                          | 卸载；留在详情页；重启；从 Public 恢复                                                                                                                                    | 清理配置/用户 data；Catalog 与不可变内置 cache 保留；重启后 Runtime 仍不加载；详情组件清单可读；显示 Restorable Builtin；恢复为干净默认状态                                                                                                                                           | UI + suppression/config/data/cache/manifest files                               | `manual-review`                  |
| `PLM-LC-007 public-cdn-local`                  | 本地 HTTP ZIP 作为确定性官方 CDN fixture                                                          | Public 浏览、详情、安装                                                                                                                                                   | 使用唯一官方 marketplace id；ZIP 校验安装；缓存来源和版本正确                                                                                                                                                                                                                         | UI + HTTP fixture log + cache + overview                                        | `manual-review`                  |
| `PLM-LC-007b official-cdn-smoke`               | 允许公网的人工环境                                                                                | 刷新真实官方 CDN 并安装指定 smoke plugin                                                                                                                                  | 真实 manifest/zip 路径可用                                                                                                                                                                                                                                                            | UI + network artifact                                                           | `manual-review`, never formal CI |
| `PLM-LC-008 recoverable-failures`              | fixture 可切换 invalid/404/malformed/v1/v2                                                        | 添加非法来源/官方 id 冲突；refresh/describe/install/update 失败并重试；取消卸载确认                                                                                       | 错误可见；重试入口可达；失败不破坏旧版本、update badge、配置或安装；取消零副作用                                                                                                                                                                                                      | UI error + fixture request log + storage snapshot                               | `manual-review`                  |
| `PLM-LC-009 inline-smoke`                      | 隔离 HOME 中 inline plugin                                                                        | 从 Personal、详情、Manage 查看并在新 session 使用                                                                                                                         | inline 可见、组件可用；不执行通用卸载入口                                                                                                                                                                                                                                             | UI + runtime marker                                                             | `manual-review`                  |
| `PLM-LC-010 secret-env-agent-projection`       | Personal 插件含 `${E2E_PLUGIN_RUNTIME_SECRET}` MCP env 与一个 agent                               | 安装后在新 session 调用 MCP；打开 Settings > Subagents                                                                                                                    | MCP 只返回 secret 已解析标记且不回显 secret；同一 agent 文件只有规范名称一行，裸名称仍可作为运行时别名                                                                                                                                                                                | provider capture + Subagents DOM + screenshots + Electron `capturePage()` video | `manual-review`                  |
| `PLM-LC-011 no-git-github-archive`             | 真实 Anthropic Claude Marketplace；Agent Git binary 指向不存在路径；adapter 另有 loopback fixture | 先探测非 GitHub Git fallback；经 Renderer → Host → Agent Protocol 刷新 `claude-plugins-official` 并安装真实 `aikido` 插件                                                 | fallback 返回 `plugin_git_unavailable`；真实 Marketplace/plugin HTTP Archive 安装成功；cache 无 `.git` 且可 discover                                                                                                                                                                  | diagnostics + captured HTTP records + installed/cache snapshot                  | `manual-review`, never formal CI |
| `PLM-LC-012 isolated-refresh-atomic-cache`     | 两个 Marketplace 已有 v1 snapshot；fixture A=v2、B=失败；cache copy/rename 可注入失败             | 批量刷新；重启；恢复 B；更新插件时注入激活失败并重试                                                                                                                      | A 更新；B 保留 v1 且失败状态跨重启；B 成功后清除失败；激活失败始终保留旧 cache/install record，重试后原子切到 v2                                                                                                                                                                      | diagnostics + persisted JSON + directory snapshots                              | `manual-review`                  |
| `PLM-LC-013 suggested-prompt-official-install` | New Task 推荐项引用缺失 Plugin；官方目录 fixture 可在成功/失败/超时间切换                         | 点击推荐项；刷新 `zcode-plugins-official`；在 Popover 确认 User-scope 安装；安装中切换另一推荐项                                                                          | 首次本地检查缺失后唯一 Popover 先进入 loading，可信解析与 Composer 稳定后同一实例切安装确认；prompt 一次性预填且不发送；刷新达到 10000ms 时中止并 fail closed，失败/超时拒绝旧快照；成功只安装官方候选；切换时取消旧 operation、迟到结果丢弃；同一 Popover 完成后 chip 前置且正文保留 | protocol/focused tests + UI manual review + user storage snapshot               | `manual-review`                  |
| `PLM-LC-014 builtin-uninstall-detail-parity`   | 隔离 HOME；内置插件已 seed、启用并有配置/data                                                     | 打开详情；卸载；在详情页重试；重启；点击 Install                                                                                                                          | `installed=false`；suppression 存在；Runtime 不提供 Skill/Command/MCP；Catalog/cache/完整组件详情仍可读；describe 不改变 config/data/cache；Install 恢复且不产生普通 installed record                                                                                                 | UI + protocol + config/data/cache/manifest + fresh discovery                    | `manual-review`                  |
| `PLM-LC-015 bundled-install-ownership`         | suppressed builtin 与合并 official entry；另有 CDN 同名 source fixture                            | 分别走 UI Install 与 direct protocol install                                                                                                                              | bundled `filesystem/sea` 路径等价 restore；CDN source 仍走 Marketplace install；无 stale suppression、重复 ownership 或错误 installed record                                                                                                                                          | protocol + installed record + runtime                                           | `manual-review`                  |
| `PLM-LC-016 seed-cache-runtime-separation`     | suppressed builtin 分别处于 cache 存在/缺失；filesystem 与 SEA seed fixture                       | resolve/list/describe/skills/commands；触发 cache 自愈                                                                                                                    | suppression 始终过滤 Runtime；缺失 cache 可由 seed 恢复；describe 前后都成功；Catalog 不被过滤；无 seed↔uninstall 互删震荡                                                                                                                                                            | bootstrap + adapter + services tests                                            | `manual-review`                  |
| `PLM-LC-017 installed-menu-layout`             | 内置插件在 Workspace `.zcode/config.json` 显式启用（enabledSource=workspace）                     | Settings > Plugins 切到 Workspace scope；打开已安装列表行内「…」菜单                                                                                                      | 启停开关常驻、无逐行配置来源标签；菜单仅卸载，文字单行并按内容撑开；恢复继承与更新不放入菜单                                                                                                                                                                                          | menuitem 文本 Range 行框计数 + 截图                                             | `manual-review`                  |
| `PLM-LC-018 official-auto-refresh-throttled`   | 隔离 HOME；官方目录已有条目且一分钟前刷新                                                         | 进入、退出、重新进入商店                                                                                                                                                  | 不再刷新；Claude 目录时间及失败状态不变；原候选仍可见                                                                                                                                                                                                                                 | DOM + overview + throttle 单测                                                  | `manual-review`                  |
| `PLM-LC-019 official-auto-refresh-on-enter`    | 隔离 HOME；官方目录已有条目但时间过期；允许真实 CDN                                               | 不点刷新进入商店，再退出重进                                                                                                                                              | 官方时间更新且无失败诊断；重进不再次刷新                                                                                                                                                                                                                                              | DOM + overview + runtime logs                                                   | `manual-review`, never formal CI |
| `PLM-LC-020 plugin-subagent-override-cold`     | 隔离 HOME；官方 judge 的结构化覆盖指定 alternate/high，主选择 primary/max                         | 完整重启后发送，通过 Agent 调用 documents:visual-judge                                                                                                                    | child 请求为 alternate/high，父 continuation 为 primary/max；Agent 正常完成；已保存覆盖不变                                                                                                                                                                                           | case-local replay + 实际请求 + UI + state                                       | `manual-review`                  |

Todo103 迁接说明：PLM-LC-018/019 来自固定 staging 的 `dbb3ec0ce8`，保留 pending 身份。首次/过期/失败后的节流及手动刷新时间优先级由共享判据单测覆盖；真实 CDN 环境失败必须与合并回归分开记录，不把公网用例晋级为离线 CI。

PLM-LC-020 补齐该来源插件覆盖的冷启动执行闭环；SE-04 已证明 UI 保存与插件文件不变，本例直接构造同格式的隔离持久化输入，不重复完整设置交互。child 与父请求的模型、档位均不同，错误继承不能通过。仅本地新执行，不扩为热更新或远控矩阵。

来源 PLM-LC-019 的环境限制继续保留：人工公网检查使用显式 replay fixture 与 manual-review hold，避免 capture MITM 证书使 Agent 市场 fetch 失败。该前置故障只阻塞公网用例，不视为产品回归或阻塞其他离线用例。

## Runtime closure for PLM-LC-003/005/009/010

PLM-LC-003 补充批量更新回归：两个插件同时待更新，按管理列表顺序破坏首项升级源，
点击一次“全部更新”；首项保留旧版本，后项升级成功，warning toast 包含成功数、失败数和
失败插件名。修复来源后重试剩余项，全部成功后入口消失。
浏览器候选验收另覆盖：首项请求未返回时替换服务实例（workspace/scope 字段相同）、
切换 Scope 后切回、卸载管理视图；释放首项后旧批次不得启动第二项。

PLM-LC-003/004/005 的 user-scope 启停必须在管理页明确选择“全局”后操作，
并验证用户配置和新会话能力。项目上下文中的市场菜单写入项目覆盖，不能用于验证
全局持久化。项目覆盖及恢复继承继续由 Workspace Plugin 用例验证。

- 详情 UI 必须列出 MCP、Skill、Command、Agent/Subagent、Hook 五组，但只用 Skill 与 MCP 做
  运行时闭环，以代表 discovery 注入和工具注册两条不同路径。
- 运行时断言必须创建新 session；升级前的既有 session 不要求热替换。
- Example Prompt 第一次点击（未安装）只允许安装，不得新增 session；第二次点击创建新草稿并
  预填，发送前 provider capture 必须为零。
- 环境变量闭环只断言 MCP 返回不含 secret 的“已解析”标记；截图、provider capture、日志和错误
  文本均不得记录 secret 原值。
- 插件 agent 的运行时规范名称与唯一裸名称可以同时存在，但设置页和插件详情按资源身份只展示
  规范名称一条。

## Pruned combinations

| Dimension                 | Decision                                                      | Reason                                                                    |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Client                    | 只测 Desktop local                                            | Web/remote 的 attachment、workspace identity、replayable 边界属于独立套件 |
| Source × lifecycle        | Personal Source 跑完整主链路；Builtin/CDN/inline 只跑差异路径 | 避免重复相同安装/启停/卸载合同                                            |
| Entry × operation         | Card/Detail/Manage 各选代表操作                               | 不做入口与全部操作的笛卡尔积                                              |
| Locale × theme × viewport | 两组 pairwise 组合                                            | 行为合同与展示合同分离，控制 CI 成本                                      |
| Component runtime         | Skill + MCP 闭环，另外三类只验证详情枚举                      | 已覆盖两种不同运行时集成边界                                              |
| Network                   | 正式 CI 只用 loopback fixture                                 | 公网不稳定且不可复现                                                      |
| Install scope             | 只测当前 user scope                                           | UI 没有 workspace-scope selector                                          |

## Bug candidates

| ID           | Gap                                 | Test treatment                                           |
| ------------ | ----------------------------------- | -------------------------------------------------------- |
| `PLM-BC-001` | Settings 插件商店安装中没有取消 UI  | 不宣称覆盖；推荐 Prompt 的独立取消入口由 PLM-LC-013 覆盖 |
| `PLM-BC-002` | 来源管理没有独立 Validate/Diagnose  | 覆盖添加时校验、update 和 remove                         |
| `PLM-BC-003` | inline 通用菜单暴露无后端语义的卸载 | smoke 不点击卸载，保持正式套件全绿                       |

## Promotion gate

所有新 spec 首先位于 `packages/desktop/test/e2e/plugins/manual-review/pending/`。人工审核截图、
交互和证据后，先执行 promotion dry-run，再 apply；未审核的 pending spec 不进入默认 WDIO、
Docker preset 或 macOS/Windows 正式 CI。

## PLM-STRIP-CLIP（2026-09-15）

接受：12 个已安装且可更新插件，在 390/1200px、中英文、明暗主题下检查角标完整可见；悬停与键盘聚焦首/末项，横向滚到末尾后点击角标，只触发对应更新，不打开详情。无页面横向溢出、无图标条纵向滚动。使用真实共享组件及测试动作回调，不覆盖安装后端。

## 2026-09-16 已确认用例

PLM-LC-018（管理列表本地化）、PLM-LC-019（双入口创建插件草稿）、PLM-LC-020（添加市场导航）已由产品方案确认；状态、动作、断言及边界见 [plugin-creator](plugin-creator.md)。不覆盖录制技能和市场模糊搜索。

来源错误补充回归：添加不存在的连续长路径并关闭添加弹窗后，错误正文完整保留；390/1280px、中文浅色与英文深色布局均不得横向溢出。

## PLM-MISSING-CONFIG（2026-09-17）

已确认场景：旧 document-skills 配置存在且 packageStatus=missing，三个目录/安装/恢复集合无该 ID；
同时五个新插件仍有目录。进入商店并搜索旧名称：旧卡片和安装按钮均不存在，新插件保持可见。
对照：目录仍提供 repairable 的包但本地缺包，它保留安装入口。原始 plugins 诊断集合不被更改。
证据：buildStoreItems 回归 + 浏览器 fixture（桌面/窄屏、中英、深浅）+ 当前 dev 原始用户配置实测。
不执行自动迁移或删除配置；不改变已安装孤立插件、内置恢复或 Workspace/User 配置归属。

## PLM-DOCUMENT-ORDER（2026-09-17）

默认官方文档插件按 PDF、PPT、Excel、Word 排序。浏览器用例覆盖商店分类和已安装图标条，
桌面/手机 × 中英文 × 深浅主题；预置管理分组、停用、缺项、个人同名隔离及服务端排序优先由单测覆盖。
入口：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs`。
此用例属于浏览器展示验证，不作为 Electron 安装生命周期或正式 CI 准入证据。

## Agent 主动发现与安装推荐

APD01–APD09 已按用户确认计划接受，具体 setup/action/assertions 见 [Agent 插件发现规格](./plugins/agent-plugin-discovery.md)。新增候选 `PLM-LC-021 agent-plugin-discovery`：官方目录检索后展示安装/启用卡片，用户可跳过；双端确认仅生效一次；实际安装后安全重载；由下一次用户输入验证同会话 Skill 可调用。证据需同时包括真实 UI、工具调用与插件安装状态。

### PLM-UI-001 UI 市场与项目配置

- 隔离 HOME，真实目录/安装/配置服务与提供 `ui://` 资源的 MCP fixture。先安装，在模型配置就绪的草稿中打开 UI，再验证首发提升后的正式会话。
- 验证公共/社区/个人互斥、UI 专区、详情图片放大和关闭、市场内管理/返回保留查询与范围。UI 专区默认全部展示，支持原位 8→6→8 张卡片切换；其他分类始终可见，搜索清空和分段往返保留各分段的手动选择。主区域与 Side Pane 复用相同交互。
- 项目 A 暂停不影响项目 B 与全局；恢复继承后使用全局状态。已安装 UI 打开；暂停后先启用，失败不打开；多个 surface 要选择；关闭面板不卸载。
- 已安装 UI 卡片的独立“详情”入口可查看信息与配置，不启用或打开插件；主市场的主导航返回已有聊天。全局设置与市场同步、远程同步通知、后台错误保留及慢视图不阻塞提交由真实 store/hook 回归补充；移除源包验证安装失败，再恢复并重试。
- 浏览器层补充中英文、Zai Light/Dark、桌面与窄面板、键盘；手机/Web/远程打开提示不支持，安装管理仍可用。浏览器窄视口不等于真实手机远控验证。
- 新测试保持 `manual-review/pending`，不自动提升 CI admission。

## PLM-TEL-001 最终结果业务埋点

待人工审核：`plugins/telemetry/plugin-lifecycle-telemetry.test.ts`。
通过真实个人来源添加、插件详情安装入口，验证安装前零结果、安装完成后一条成功结果、event_id/耗时/插件归属/入口齐备，并且没有 operation_id 或本机路径。上报仅在传输出口 mock，插件安装执行真实 CLI。尚未晋升正式 CI。

## PLM-UI-BACKGROUND 后台执行与保留

`PLM-UI-DISPLAY-MODES`：按 [展示模式 spec](plugin-ui-display-modes-spec.md) 验证页面注册模式的硬约束。真实时间线覆盖 fullscreen-only 打开卡片、关闭不回 inline、页面请求与重挂不绕过约束；未声明和双模式页面指定 fullscreen 时同样不回 inline。inline-only 拒绝 fullscreen。握手前 guest 隐藏。关闭、重开、会话重挂保持同一 guest ID、一次启动/读取/登记、内部 React 状态与后台帧执行；后续成功调用改回 inline 可复用原 guest。入口 `mcp-apps-host-e2e.mjs --rows-only`，候选回归，不自动晋升 CI。

`PLM-UI-SESSION-READY`：持久会话运行态释放后，历史订阅和插件面板同时重开。控制 runtime
preferences 响应让恢复保持 starting，面板不得进入 error 或提前创建 guest；放行后自动运行，
只恢复一次、读一次资源、创建一个实例。2026-10-30 人工确认转正，正式入口
`packages/desktop/test/e2e/plugins/runtime/plugin-ui-session-ready.test.ts`，复用
`mcp-apps-host-e2e.mjs --session-ready-only` 的受控 Electron 回归。隔离 HOME、模型响应
和 MCP 配置，正式插件 glob 可收集；各平台实跑与 Docker 准入证据见覆盖矩阵。

`PLM-UI-CONNECTION-READY`：会话已创建或恢复、目标 MCP initialize 尚未完成时打开页面，
保持准备中；放行连接后自动进入 running，无错误闪现、无人工重载、只创建一个实例。
连接失败及等待期间 session / lease / 连接替换拒绝旧请求，由定向单测补充。
入口 `mcp-apps-host-e2e.mjs --managed-only`；受控 Electron 回归，未晋升 CI。

`PLM-UI-VISIBILITY`：收起侧栏、切换标签、离开聊天页及切换工作区时，保活卡片不显示独立插件浮层，不拦住宿主点击；插件双帧工作和内存编辑状态继续保留，返回复用同一 guest。初始隐藏不得绑定展示锚点。入口 `--managed-only`，深浅主题；宿主页面可见性另用桌面/手机壳组件回归验证。

受控 Electron 回归入口：`node packages/desktop/scripts/mcp-apps-host-e2e.mjs --background-only`。
无卡片冷启动、隐藏但仍挂载的 tab、握手后的多帧初始化、窗口最小化执行、session 空闲时内部工作继续、
同窗空闲 guest 隔离、离屏期限保留内存、删除释放，详见 [后台执行契约](plugin-ui-background-execution.md)。
设置 `ZCODE_PHOTOCRAFT_SERVER` 指向构建后的 PhotoCraft `dist/server.mjs`，使用
`--photocraft-background-only` 使用未修改的 PhotoCraft 0.2.2 验证真实 WASM 后台启动、图片/图层操作、编辑状态保留，
恢复后截图检查画布与新增图层；从可见编辑器切到其它主页面后，断言 UI 隐藏且不可命中，再后台新增图层并返回检查同一 guest 与文档。该入口不是正式 WDIO CI 准入，不自动晋级。

`PLM-UI-BACKGROUND-ADMISSION`：会话工具卡片完全未挂载、conversation 未订阅时，真实 Agent 的成功 UI 工具结果仍启动隐藏 guest；后台操作、返回同 guest、失败结果不创建、同插件跨会话隔离。窗口级接收器与展示 hook 并发只创建一次。历史恢复不主动打开全部插件。入口沿用 `--background-only`，候选回归不自动晋升 CI。

## PLM-CONCURRENT-INSTALL

连续点击两个不同插件的安装按钮，两者都保持安装中且不能重复提交。任一完成或失败后，另一项继续安装中；两者结束后恢复各自最终状态。补充同名并发及切换上下文后同名操作的隔离回归。

浏览器候选用例：`packages/ui/test/browser/manual-review/pending/plugin-concurrent-install.test.mjs`，真实 store 与共享安装按钮，受控服务完成，390/1200px × 中英文 × 深浅主题。浏览器用例保持 pending，不自动晋升。桌面正式用例：`packages/desktop/test/e2e/plugins/installation/plugin-concurrent-install.test.ts`，真实个人来源与 CLI 安装，通过本地 HTTP 响应门控制失败顺序。

## PLM-DETAIL-DURING-INSTALL

插件 A 的安装下载未完成时，打开其他未安装插件的详情，组件区按 `plugins/describe` 正常加载；插件列表与总览（新建右侧标签页首次加载使用）也立即返回，不等待 A 的安装结束；A 仍保持安装中。卡片“更新”和详情“恢复用户默认”只在自身插件操作中禁用。

桌面用例：作为 PLM-CONCURRENT-INSTALL 桌面正式用例中的一步，真实个人来源与 CLI，HTTP 响应门挂起 A 的下载、B 排在 A 后面时打开本地插件详情，返回后两项仍为安装中；同一时刻经桌面服务链路请求 list/overview，10 秒内返回。单测覆盖 transport 立即派发 describe/list/overview、manifest 已缓存时不等存储锁、manifest 缺失时仍进锁，以及两处按钮的按插件禁用。随 PLM-CONCURRENT-INSTALL 桌面用例一起转正。

## PLM-BUILTIN-UI-UNINSTALL

卸载内置 UI 插件（如 Word 文档）后，可恢复卡片仍在「UI 插件」专区，不掉进「生产力」等分类分组。已安装时同样在专区。

桌面候选用例：`packages/desktop/test/e2e/plugins/installation/manual-review/pending/plugin-builtin-ui-uninstall.test.ts`，真实 CLI，经卡片菜单卸载 `documents@zcode-plugins-official`，等待总览进入 `restorableBuiltins` 后断言卡片在 `plugin-store-ui-section` 内。bootstrap 单测校验内置定义的 `ui` 组件类型与插件包 `ui.surfaces` 一致，且卸载后官方目录与可恢复列表都带 `ui`。保持 pending，不自动晋升。

## 插件市场与管理列表统一（2026-10-22）

市场未安装卡片显示安装，已安装卡片常驻启停开关；更多菜单仅含卸载，详情页仍通过菜单启停与卸载。管理页复用单列卡片，保留已安装/内置分组，不显示逐行配置来源标签；配置作用域与继承行为不变。管理页通过标题左侧返回按钮回市场。

WPL-015 在市场安装前断言无开关，安装后通过卡片开关停用再启用，并读取 Agent 投影；随后验证 User/Workspace 配置、暂停与恢复继承。PD/PP、PF、PLM-UI-001 使用新的管理返回入口；PLG12 的详情启停使用菜单。启停中只由「…」菜单按钮显示一个加载提示，开关保持禁用并带 `aria-busy`，不再另放独立 spinner。

`PLM-UI-RETENTION`：见 [后台执行 spec](plugin-ui-background-execution.md)。资源声明才后台保留；默认五分钟回收并重建 widgetState；每窗口超过四个后台声明页时按三十分钟未活跃且不忙淘汰。轮询不续期、可见/忙碌保护、删除/重建竞态；入口 `--managed-only`，候选回归不晋升 CI。

### 草稿 MCP UI 回归

`PLM-UI-001` 增补：模型配置就绪但未发送消息时，从主导航打开 UI 并进入根草稿；离开市场再返回保留 guest 内存；首发提升复用同一 guest。右侧市场和启动页使用所属 pane 的有效 session；异步切换和换代由定向单测覆盖。当前使用上游已转正的 `plugins/marketplace/plugin-management-ui-market.test.ts`；原 App 单测已退役，不能将历史覆盖视为现行证据。

P2 回归补充：PLM-UI-001 暂停真实 createSession RPC，从主导航发起打开后切到正式会话或另一工作区，再回同项目草稿；断言待处理请求已撤销且新草稿不打开旧插件。单个连接失效保留多插件上下文、删除等待多 server 退订由定向单测覆盖。

合并回归补充：草稿插件打开后进入、退出侧栏完整视图，确认 guest 内存标记和未发送输入保留、聊天行数仍为零。

完全访问回归：冷草稿调用工具，在审批卡选择完全访问并勾选风险确认后提交；确认前权限不变且确认按钮禁用，提交后断言工具返回、Composer 权限同步、零聊天行和零正式任务。再次调用无需审批；切换工作区返回及首发后权限保持、同一 session/guest 被复用。失败重试、持久化交错、旧绑定失效由定向测试覆盖。已有审批积压作为真实 PDF 复测观察项，不新增批量放行规则。

## PLM-MANIFEST-ISOLATION：外部清单兼容与列表隔离

候选桌面入口：`packages/desktop/test/e2e/plugins/runtime/manual-review/pending/plugin-manifest-isolation.test.ts`。
安装带未知 `userConfig.options` 的插件后，列表、其他插件安装和已安装能力仍可读取；
停用再启用及刷新仍保持正常。损坏已知字段时只隔离该插件并返回带 pluginId 的诊断。
浏览器候选入口：`packages/ui/test/browser/manual-review/pending/plugin-load-isolation.test.mjs`。
覆盖列表失败、目录失败、双失败和重试恢复；390/1200px、深浅主题、中英文与来源未知状态。
人工审核、正式晋升及 Docker 准入保持 pending；验证结果以本次实际执行记录为准。

PLM-LC-021 默认安装启用增量：预置用户级及两个工作区均禁用；跳过不修改，确认“安装并在当前工作区启用”后仅当前工作区改为启用，保留用户级和另一工作区禁用，原会话自动重载一次并可调用 Skill。2026-11-04 macOS Desktop 1/1 通过，运行 `desktop-e2e-20261104042250898-p45785-8b366e21e2bed63b`；用例保持人工评审候选。

PLM-LC-021 多语言载荷增量：5,000 个非界面语言条目与尾部的界面语言译文，验证中文窄屏/英文桌面的名称和描述仍正确渲染，并走完跳过、安装和自动重载。2026-11-04 macOS Desktop 1/1 通过，运行 `desktop-e2e-20261104035826613-p41163-a7c77319f5ea2824`；仍为人工评审候选。

PLM-LC-021 设置增量验收：默认关闭；开关保存后重开设置仍保留；关闭时模型请求不含搜索和推荐工具，明确请求也不能调用；开启后工具恢复。旧配置默认关闭。2026-11-04 macOS Desktop 1/1 通过，运行 `desktop-e2e-20261104033807665-p58349-3fcf657995c2b204`；实际手机 relay 未运行。

PLM-LC-021 新断言：安装后保留任务、自动换代、没有额外用户输入或模型请求，下一条显式输入执行 ZIP 插件 Skill。2026-11-03 macOS Desktop 1/1 通过，运行 `desktop-e2e-20261103124904313-p61172-59e756836ce2d8a0`；保留 pending，未转正。

## PLM-EXT-2A：扩展进程基础设施与插槽

设计见 [扩展进程](plugins/extension-host.md) §6、§12、§15、§16.1、§16.2。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-host-runtime.test.ts`。隔离 HOME；四个纯 JS fixture 插件（`test/e2e/fixtures/fs/plugins/plugin-extension-host-runtime/`）复制进 HOME，经 `~/.zcode/cli/config.json` 的 `plugins.dirs` 加载，重启后生效。清单用顶层 `slots`：`e2e-ext-status` 另有启动页视图条目 `open-panel`、引用未声明视图的条目 `broken` 与未知插槽 `future.slot`；`e2e-ext-invalid` 有一个指向自己（非法）扩展命令的条目。

| 子项 | 场景                                  | 断言                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 扩展激活后设置 `composer.status` 文字 | 条目在模型控件组、用量圆环位置之前；点击执行命令，文字按会话作用域变化；日志有激活与贡献表快照                                                                                                                                                                                        |
| b    | 杀掉扩展进程                          | gen + 1 重启，扩展重新激活，插槽文字回来                                                                                                                                                                                                                                              |
| c    | 命令写死循环                          | 约 15 秒判为卡死并重启；连续触发，第 3 次崩溃用 4s 退避重启，第 4 次崩溃后启动页显示「扩展已停止」；命令中心「重新加载扩展」后恢复                                                                                                                                                    |
| d    | 清单非法、版本不兼容、条目不可用      | 启动页「扩展」分区各一行，标签「清单非法」「版本不兼容」，悬停原因带字段路径；`e2e-ext-status` 一行「清单非法」带 `slots["sidePane.launcher"][1].target.view`，它的其他条目照常；Window Host 记 `static table`、`declarations pushed ... extensions=2`、未知插槽的 `manifest ignored` |
| e    | 扩展打印 `Object.keys(process.env)`   | 只有白名单键与系统注入键，没有遥测、OAuth 类变量                                                                                                                                                                                                                                      |
| f    | 退出 App                              | 扩展进程在退出收口内结束（`intent=dispose`），没有残留进程                                                                                                                                                                                                                            |
| g    | 深浅主题、中英文                      | 插槽与启动页分区截图                                                                                                                                                                                                                                                                  |
| h    | 扩展进程停止后的静态声明              | 预算耗尽后问题行都在；`open-panel` 行照常显示，带「扩展已停止」与「重新加载」；重新加载后重读静态表（`static table ... (reload)`），行回到「打开」                                                                                                                                    |

同一用例还从日志取证运行时护栏：`ctx` 冻结、`process.exit` 被拦截、未声明 id 抛 `not-declared`、未捕获错误按插件归因。Web 与手机远控不显示插槽由代码结构保证（门面只在本机 Host 注册），本用例不覆盖。

## PLM-EXT-2B：扩展视图、context 组成与生成速率

设计见 [扩展进程](plugins/extension-host.md) §7.2、§8、§9、§10、§15、§16.11。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-views.test.ts`。隔离 HOME；两个纯 JS fixture 插件（`test/e2e/fixtures/fs/plugins/plugin-extension-views/`）经 `plugins.dirs` 加载：`e2e-ext-view`（写法一视图 `context`、`composer.status` 的 tok/s、命令里调 `views.open`）与 `e2e-ext-factory`（写法二视图 `factory`，只按 `onView` 激活）。发送消息走 replay：`E2E_PROVIDER_REPLAY_FIXTURE_PATH` 指向 `common.json` 与 `plugin-extension-views.json`，提示词带 `E2E_SLOW_STREAM`，命中既有受控慢流 `plugin-extension-views-stream`（三段文字分别在 8s、16s、24s，90s 结束）。

| 子项 | 场景                               | 断言                                                                                                                                                                                                                                         |
| ---- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 草稿态从启动页「扩展」分区打开视图 | `extension-view` 标签页运行；页面显示 `draft-preview`，系统提示词与内置工具类别 token 大于 0；草稿仍是草稿（窗格无会话 id、任务列表没有该会话）                                                                                              |
| b    | 草稿里换模型                       | Window Host 补发 `context.onDidChange`；视图显示新模型，仍是 `draft-preview`                                                                                                                                                                 |
| c    | 发送一条消息                       | `composer.status` 先显示流式估算的 tok/s，再换成准确值；流式期间没有新的贡献表快照；视图刷新为 `request` 并出现消息类别；实例不重建                                                                                                          |
| d    | 命令里调 `views.open`              | 切到别的标签后点击 `composer.status`，视图标签回到前台；Window Host 记 `views.open acked ... ok=true`                                                                                                                                        |
| e    | 写法二视图                         | 首次打开时按 `onView:factory` 激活；页面经自己的 server 调工具，显示 `E2E factory pong`                                                                                                                                                      |
| f    | 杀掉扩展进程                       | 视图标签按 gen 2 重建（新实例 id），页面重新渲染                                                                                                                                                                                             |
| g    | 深浅主题、中英文                   | 视图标签与 `composer.status` 截图                                                                                                                                                                                                            |
| h    | 写法一的 `onDidOpen`               | 视图实例打开时调用一次（`E2E_VIEW_DID_OPEN instance=<实例 id> scope=session`），fixture 不再在工具调用时登记实例                                                                                                                             |
| i    | 草稿首发交接                       | 从发送到窗格变成正式会话，Renderer 的 `workbench report` 每条都是 `sessions=1`，扩展没有收到空的 `workbench.onDidChange`                                                                                                                     |
| j    | App 环境 `env`                     | 订阅后的第一个事件就是当前语言（与激活时 `env.get` 的结果相同）；切到英文再切回，`env.onDidChange` 依次是 `en-US`、`zh-CN`                                                                                                                   |
| k    | 原由 PLM-EXT-2C 断言               | 清单声明、从没设置文字的插槽条目 `silent` 不显示；草稿预演的类别带条目；final 悬停说明带换过的模型、`out=12` 与首 token 时间；`context.get` 的 `providerContextTokens` 等于输入框圆环「已用」（120 + 12）；页面经 hostContext 跟随主题与语言 |
| l    | 原由 PLM-JARVIS-2 断言             | 关掉视图标签后面板里没有这个视图，扩展收到该实例的 `onDidClose`（`E2E_VIEW_CLOSED instance=<gen 2 实例 id>`）                                                                                                                                |

同一用例从日志取证：`ctx.views.open` 未声明的视图抛 `not-declared`；数据泵启停与工作区订阅；`views.open` 的请求与回执；视图实例的准备与关闭。

## PLM-EXT-2C：示例插件 context-inspector

已删除（2026-11-07）。示例插件迁到市场仓库 `zcode-plugins` 的 `ui-plugins/context-inspector`，z-code 里不再有它的源码与用例（[插件发布](plugins/plugin-publishing.md) §6.3）。它断言的宿主行为由 fixture 用例覆盖，逐条对照见 [覆盖矩阵](testing/plugin-management-lifecycle-e2e-coverage-matrix.md) 的「示例插件迁出」。插件自己的页面只做构建、清单校验与人工验收（[插件发布](plugins/plugin-publishing.md) §6.1）。

## PLM-EXT-P2B：插件入口——主导航与文件查看器

设计见 [扩展进程](plugins/extension-host.md) §16.3–§16.5、§16.10 第 2 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-entries.test.ts`。隔离 HOME；两个纯 JS fixture 插件（`test/e2e/fixtures/fs/plugins/plugin-extension-entries/`）经 `plugins.dirs` 加载：`e2e-ext-entries`（扩展：`nav.primary` 指向视图 `nav`，`file.viewer` 为 `.E2EVIEW` 指向视图 `file`）与 `e2e-mcp-viewer`（只有 MCP App：不依赖 SDK 的 stdio server，`ui.surfaces` 一个页面 `panel` 与工具 `open_document`；`nav.primary` 与 `file.viewer`（`.e2edoc`）都指向 `panel`）。工作区里放 `e2e-entries/notes.e2eview`、`report.e2edoc`、`sheet.xlsx`。正式会话用 replay 创建（提示词带 `upstream-e2e-ok`，命中 `plugin-extension-entries.json` 的 `plugin-extension-entries-1`）。文件经项目文件树打开（文件管理标签内的导航，与 `handleOpenCodeViewer` 共用同一个文件路由）。

| 子项 | 场景                            | 断言                                                                                                                                                                           |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a    | 两个导航条目                    | 都在「插件市场」之后，按当前语言的标题排序；标题跟随语言；深浅主题 × 中英文截图                                                                                                |
| b    | 导航 → 扩展视图                 | 打开 `extension-view` 标签并运行；实例没有 `view.input`；主视图不变；条目没有选中态                                                                                            |
| c    | 导航 → MCP App 页面，根草稿路径 | 停在插件市场时点击：日志 `open surface ... "path":"draft"`，回到对话、窗格是草稿，`plugin-ui` 页面就绪                                                                         |
| d    | 导航 → MCP App 页面，正式会话   | replay 发送后点击：日志 `"path":"session"` 带正式会话 id，`plugin-ui` 标签属于该会话，页面就绪                                                                                 |
| e    | `.e2eview` → 扩展视图查看器     | 清单写大写 `.E2EVIEW`；标签 `extension-view:<视图>:file:<相对路径>`，标题是文件名；页面读到 `view.input = { kind: "file", path: <相对路径>, workspace: <工作区> }`             |
| f    | `.e2edoc` → MCP App 查看器      | 每个文件一个 `plugin-ui` 标签；页面就绪后 MCP server 收到 `open_document({ path: <相对路径> })`，页面显示 tool-result；出现权限请求时批准                                      |
| g    | `.xlsx`                         | 仍先走内置官方路由：官方 spreadsheets 插件打开它的页面标签；插件声明的查看器不接管，没有 `file viewer routed`                                                                  |
| h    | 扩展进程停止                    | 连续杀进程到预算耗尽（`status=stopped`）：view 条目带「已停止」「重新加载」（无障碍名称是「扩展已停止 · 重新加载」），MCP App 条目照常打开页面；点 view 条目重新加载后条目恢复 |
| i    | 扩展进程停止时打开文件          | 再次连杀到 `status=stopped`：`.e2eview` 的 view 查看器不参加选择，留在文件管理标签内预览，没有 `file viewer routed`；点 view 条目重新加载后恢复                                |

Web 与手机远控不显示导航条目由代码结构保证（扩展门面只在本机 Host 注册；`ProjectSidebarNavigation` 在手机远控时不挂插槽），本用例不覆盖。远程工作区跳过插件查看器、导航的「不支持」提示都没有桌面运行时用例（需要远程工作区）。

## PLM-EXT-P2E：扩展日志控制台

设计见 [扩展进程](plugins/extension-host.md) §16.8、§16.10 第 5 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-logs.test.ts`。隔离 HOME；两个纯 JS fixture 插件（`test/e2e/fixtures/fs/plugins/plugin-extension-logs/`）经 `plugins.dirs` 加载：`e2e-ext-logs`（激活时 info / warn / error 各一行、一行 6000 字符的长日志、一行 `console.log`；`composer.status` 条目执行命令 `emit`，每次再按三个级别各写一行）与 `e2e-ext-logs-peer`（激活时一行）。日志里只有固定标记，不输出环境变量。断言读日志标签每行的 `data-seq`、`data-level`、`data-gen`、`data-plugin-id`。

| 子项 | 场景                     | 断言                                                                                                                                                                                                                                                                     |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a    | 启动页「扩展日志」       | 「扩展」分区有「扩展日志」一行；点击打开 `extension-logs` 标签，快照到达                                                                                                                                                                                                 |
| b    | 激活日志、归因与截断     | 三个级别的激活行带插件 id 与 `gen=1`；第二个插件的行带它的 id；`console.log` / `console.warn` 的行带插件 id，级别 info / warn；监管器的 `status=running` 没有插件 id；seq 严格递增；长日志在标签里以 `…[truncated]` 结尾且不超过 4096 字节，日志文件里是完整的 6000 字符 |
| c    | 实时追加                 | 点击 `composer.status` 执行命令，三个级别的 `run=1` 行不重开标签即出现                                                                                                                                                                                                   |
| d    | 按插件过滤               | 选 `e2e-ext-logs@inline` 只剩它的行；选 peer 只剩 peer 的行；选「扩展进程」只剩没有插件 id 的行                                                                                                                                                                          |
| e    | 按级别过滤               | 「仅错误」只剩 error；「警告及以上」只剩 warn 与 error；插件与级别叠加                                                                                                                                                                                                   |
| f    | 深浅主题 × 中英文        | 日志标签 4 张截图；英文下过滤器显示「All sources」「All levels」                                                                                                                                                                                                         |
| g    | 清空只清视图             | 清空后没有行；再执行命令，只出现更新的行（seq 都大于清空前），日志文件照旧有清空前的行                                                                                                                                                                                   |
| h    | 复制                     | 剪贴板里是当前显示的行（`时间 级别 [来源] 消息`），不含已清空的行                                                                                                                                                                                                        |
| i    | 杀掉扩展进程             | `process.kill(pid, "SIGKILL")` 后清空后的旧行还在；监管器的 `extension host exited ... intent=crash`、`status=restarting`（gen 1）与 `status=running`（gen 2）出现；gen 2 的激活行到达                                                                                   |
| j    | 命令中心「打开扩展日志」 | 关闭标签后从命令中心打开，重新取快照；清空的位置仍然保留，gen 2 的行都在                                                                                                                                                                                                 |

Window Host 重连后的补齐（`getLogs({ sinceSeq })`）没有桌面运行时用例：现有 utilityProcess 崩溃后不自动重启（§3.1），E2E 里无法只重连 Window Host。Web 与手机远控没有扩展门面，日志标签与入口都不出现，由代码结构保证。

## PLM-EXT-P2C：输入框 `@` 面板的插件分组

设计见 [扩展进程](plugins/extension-host.md) §16.6、§16.10 第 3 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-mention.test.ts`。隔离 HOME；两个纯 JS fixture 插件（`test/e2e/fixtures/fs/plugins/plugin-extension-mention/`）经 `plugins.dirs` 加载：`e2e-ext-mention`（扩展：`composer.mention` 条目 `items` 指向命令 `search`；query 越短返回越慢，每少一个字多 1.5 秒，4 个字以上立即返回）与 `e2e-mcp-mention`（只有 MCP：不依赖 SDK 的 stdio server，app 可见的工具 `mention_search` 返回 `structuredContent.items`；条目 `docs` 指向它）。发送用 replay（提示词带 `upstream-e2e-ok`，命中 `plugin-extension-mention.json` 的 `plugin-extension-mention-1`）。query 用不会命中文件、会话、插件名的字母，面板里只剩插件分组。

先发一条 replay 消息，让草稿成为正式会话：草稿的预热会话里「始终允许本项目」不会记住（§16.6「已知限制」）。MCP 分组先跑，之后扩展分组的查询不再弹审批。`@` 查询经 Lexical E2E bridge 写入（先清空、再聚焦、再写入，光标在末尾），页面用 CDP 焦点模拟，不依赖操作系统的前台窗口（同机并行的其他 E2E 会抢前台）。

| 子项 | 场景                   | 断言                                                                                                                                                                                                                               |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b1   | MCP 工具首次调用被拒绝 | `@jzq` 在会话里弹审批（输入框被替换）；拒绝后 Window Host 记 `mention items error ... code=plugin_mention_tool_denied`；同一查询重新打开面板不再弹审批，组内一行弱提示「已拒绝调用插件工具」，扩展分组照常；中文浅色、英文深色截图 |
| b2   | 始终允许               | 新查询弹审批，选「始终允许本项目」后组显示工具的候选项；再改查询不再询问；MCP server 只收到批准后的两次调用                                                                                                                        |
| a1   | 慢查询                 | 命令收到 `{ query: "qx" }`，作用域是会话；结果回来前组里没有 `qx` 的候选项（显示上次采用的结果）                                                                                                                                   |
| a2   | 快速输入               | 改成 `@qxjv`：组显示 `qxjv` 的三项；每次输入只发一次查询（没有面板刚打开时的空串查询）                                                                                                                                             |
| a3   | 旧结果晚到             | 扩展日志里 `qx` 的 DONE 晚于 `qxjv`；之后组仍是 `qxjv` 的三项；深浅主题 × 中英文截图，组名跟随语言                                                                                                                                 |
| a4   | 选中候选项             | 输入框 canonical markdown 等于 `insertText` 加一个空格；提及块（`extensions` 类别）显示候选项标题                                                                                                                                  |
| a5   | 发送                   | provider 请求里有 `insertText` 原文与后面的提示词；消息出现在时间线                                                                                                                                                                |

旧 CLI（没有 `plugins/mentionItems`）时分组不显示、远程工作区不显示 tool 分组、扩展进程停止时 command 分组显示「扩展已停止」都没有桌面运行时用例（需要旧 CLI、远程工作区或连杀扩展进程；停止态与 PLM-EXT-P2B 子项 h 用同一个 `hostStopped`）。Web 与手机远控没有扩展门面，不显示插件分组，由代码结构保证。

## PLM-EXT-P3C：扩展经 `ctx.sessions.*` 写会话

设计见 [扩展进程](plugins/extension-host.md) §17.3（实现 P3c-1）、§17.8、§17.10 第 3 步、§18.1 H10。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-sessions-write.test.ts`。隔离 HOME；纯 JS fixture 扩展 `e2e-ext-writes`（`test/e2e/fixtures/fs/plugins/plugin-extension-writes/`，清单 `grants: ["sessions.write"]`、`protocols: { sessions: 1, rows: 4 }`，授权记录预先写进隔离 HOME 的 `grants.json`，授权流程由 PLM-EXT-P3A 覆盖）经 `plugins.dirs` 加载。它在输入框状态栏有一个命令：每次点击读一次用例写的步骤文件，按顺序执行 `ctx.sessions.*` 操作，每个操作的结果或错误码写一行 `E2E_WRITES_RESULT`。模型用 replay（`plugin-management/plugin-extension-sessions-write.json`）。手机由 wdio 的远控夹具起本地 Web 前端与假 relay。插件项目（不指定项目时的默认项目）在 P3c-2，本用例显式传项目。

| 子项 | 场景             | 断言                                                                                                                                                                                                                 |
| ---- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 新建与立即订阅   | `createSession` 在默认工作区项目里建会话：`creation: created`、`firstInput: accepted`；结果一到立即订阅行，第一个事件是 `reset`（不是 `unavailable`）；会话在 Host 项目树里属于这个项目                              |
| b    | 新建的幂等重试   | 同一个 `requestId` 再建一次，返回同一个会话                                                                                                                                                                          |
| c    | 打开与标识       | `openSession` 返回 `opened`，桌面切到这个会话；用户行显示「来自插件 e2e-ext-writes」，回复来自回放夹具                                                                                                               |
| d    | 发送的幂等重试   | 同一个 `requestId` 发两次：同一个 `commandId`，会话里只多一条用户行                                                                                                                                                  |
| e    | H10 换模型       | 带 `model: "<provider>/deepseek-v4-pro"` 发送：回放夹具只在请求体模型是 `deepseek-v4-pro` 时命中；插件没传 `requestId`，回执里是扩展进程补的 UUID                                                                    |
| f    | 中断             | 受控流停在闸门上；`readSession(summary)` 拿到 `executionId`；`interruptSession` 返回 `applied`，回合停止                                                                                                             |
| g    | 整理与打开       | 改名、置顶、归档、取消归档、打开都成功；Host 项目树里标题、置顶、归档状态持久                                                                                                                                        |
| h    | 拒绝伪造来源     | 渲染进程经 Window Host 的 RPC 端口发带 `extension` 来源的 `sendText`：`fault.command.extensionSourceUntrusted`，会话里没有多出消息                                                                                   |
| i    | 截图             | 用户行标识：中文浅色、英文深色                                                                                                                                                                                       |
| j    | 最近操作         | 插件详情页「权限」区块的最近 10 行有打开、归档、置顶、改名、中断与发送，全部成功；显示动作名（「重命名会话」/「Renamed a session」）；中文浅色、英文深色截图                                                         |
| k    | 审计             | 每个写动作一行：`grant: sessions.write`、`requestId`、`target`；`createSession` 与 `sendToSession` 带 `commandId` 与 `promptChars`；审计文件里没有提示词与新标题                                                     |
| l    | 手机             | 390px 手机页面打开这个会话：四条用户行都显示「来自插件 e2e-ext-writes」，没有横向溢出；截图                                                                                                                          |
| m    | 流式期间逐段到达 | 夹具 `p3c-stream` 把回复分四段、间隔 1.5 秒推回；扩展持续订阅行（`watchRows`），本轮 `running` 时 `rows` 增量里助手字数至少有两个递增的值；结束后 `completedSuccess`，字数等于完整回复（以前只由 PLM-JARVIS-1 断言） |
| n    | 本轮失败         | 夹具 `p3c-fail` 返回 400：扩展的行镜像里这一轮的 `turnHeader` 是 `failed`（以前只由 PLM-JARVIS-2 断言）                                                                                                              |
| o    | 宿主删除任务之后 | 经 Window Host `deleteTask` 删掉 n 的任务：`sendToSession` 报 `forbidden`；已开着的行订阅没有以错误结束（以前只由 PLM-JARVIS-2 断言）                                                                                |

`forkSession` 与失败结果（`rejected` / `unknown` 记为 `error`）、旧 CLI 没有 `extensionInputSource` 能力位时报 `unavailable`、手机发来的伪造来源（与桌面渲染进程走同一个连接作用域入口）都没有桌面运行时用例。

## PLM-JARVIS-1：示例插件 Jarvis 的核心

已删除（2026-11-07）。示例插件迁到市场仓库 `zcode-plugins` 的 `ui-plugins/jarvis`，z-code 里不再有它的源码与用例（[插件发布](plugins/plugin-publishing.md) §6.3）。它断言的宿主行为由 fixture 用例覆盖，逐条对照见 [覆盖矩阵](testing/plugin-management-lifecycle-e2e-coverage-matrix.md) 的「示例插件迁出」。插件自己的页面只做构建、清单校验与人工验收（[插件发布](plugins/plugin-publishing.md) §6.1）。

## PLM-JARVIS-2：示例插件 Jarvis 的工具、停止、重试、小结与设置

已删除（2026-11-07）。示例插件迁到市场仓库 `zcode-plugins` 的 `ui-plugins/jarvis`，z-code 里不再有它的源码与用例（[插件发布](plugins/plugin-publishing.md) §6.3）。它断言的宿主行为由 fixture 用例覆盖，逐条对照见 [覆盖矩阵](testing/plugin-management-lifecycle-e2e-coverage-matrix.md) 的「示例插件迁出」。插件自己的页面只做构建、清单校验与人工验收（[插件发布](plugins/plugin-publishing.md) §6.1）。

## PLM-EXT-P3C2：插件项目（不指定项目建会话）

设计见 [扩展进程](plugins/extension-host.md) §17.4（实现 P3c-2）、§18.1 H7、§17.10 第 3 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-plugin-project.test.ts`。隔离 HOME；纯 JS fixture 扩展 `e2e-ext-projects`（`test/e2e/fixtures/fs/plugins/plugin-extension-projects/`，清单 `grants: ["sessions.write"]`，授权记录预先写进隔离 HOME 的 `grants.json`）经 `plugins.dirs` 加载。它在输入框状态栏有一个命令：每次点击读一次用例写的步骤文件，按顺序执行操作：`writeAgents`（在 `ctx.extension.dataPath/workspace` 写 `AGENTS.md`）、`parallel`（一组 `ctx.sessions.*` 同时发出）与单个 `ctx.sessions.*`，每个操作的结果写一行 `E2E_PROJECTS_RESULT`。模型用 replay（`plugin-management/plugin-extension-plugin-project.json`）：首发夹具要求请求体里有 `AGENTS.md` 的标记。证据：Main 日志（`[extensions]` 的 plugin project 行与 fixture 的 `E2E_PROJECTS_*`）、Window Host 项目树、侧栏 DOM、截图。

| 子项 | 场景                 | 断言                                                                                                                                                                                                                     |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a    | 并发新建只建一个项目 | 同时发两个不带 `project` 的 `createSession`：两个会话的 `project.projectId` 相同；项目树里目录含插件 workspace 的未删除项目只有一个，名字是插件名，唯一目录是 workspace 且是主要目录；两个任务都属于它；侧栏显示这个项目 |
| b    | H7 cwd 与 AGENTS.md  | 会话的 `workspacePath` 是 `<dataPath>/workspace`；`openSession` 后回复是首发夹具的标记（只在请求体带 `AGENTS.md` 标记时命中）                                                                                            |
| c    | 之后再建复用         | 再发一个不带 `project` 的 `createSession`：同一个项目，项目树里仍只有一个                                                                                                                                                |
| d    | 移除后重新创建       | 用户在侧栏「更多 → 删除」移除项目（项目软删除）；下一个 `createSession` 建出新的插件项目（名字仍是插件名、目录仍是 workspace），侧栏显示新项目                                                                           |
| e    | 日志                 | 「plugin project created」两行（两次新建），不含数据目录路径                                                                                                                                                             |
| f    | 截图                 | 侧栏插件项目与插件会话：中文浅色、英文深色                                                                                                                                                                               |

旧 CLI（`plugins/list` 不报告 `dataPath`）时报 `unavailable`、用户改名后仍按目录找到、用户把 workspace 从项目目录去掉后新建、workspace 目录被删后重建，都没有桌面运行时用例。

## PLM-EXT-P3E：插件回答审批、提问与切换权限模式

设计见 [扩展进程](plugins/extension-host.md) §17.12、§17.7、§17.10 第 5 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-session-approvals.test.ts`。隔离 HOME；纯 JS fixture 扩展 `e2e-ext-approvals`（`test/e2e/fixtures/fs/plugins/plugin-extension-approvals/`，清单先是 `grants: ["sessions.write"]`，隔离 HOME 的 `grants.json` 预先写进本阶段以前的旧格式记录，没有 `consentRevision`）经 `plugins.dirs` 加载。它在输入框状态栏有一个命令：每次点击读一次用例写的步骤文件，按顺序执行 `watch` / `unwatch`（`onDidChangeInteractions`，每个事件写一行 `E2E_APPROVALS_EVENT`，含会话、模式、交互 id、种类与选项的 `kind:optionId`）与单个 `ctx.sessions.*`，结果写一行 `E2E_APPROVALS_RESULT`。会话都由插件不带项目建（进插件项目），再 `openSession` 在桌面打开。模型用 replay（`plugin-management/plugin-extension-session-approvals.json`）：Write 与 AskUserQuestion 的工具调用，拒绝与回答之后的收尾夹具要求请求体里有对应的结果或答案。证据：Main 日志（`[extensions]` 的 `sessions.resolveInteraction` / `sessions.setPermissionMode` 行与 fixture 的 `E2E_APPROVALS_*`）、宿主审批面板 DOM、写出的文件、Window Host 项目树、审计 JSONL、截图。

| 子项 | 场景             | 断言                                                                                                                                                                                                                                                                                                                                             |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | 旧授权重新确认   | 旧格式记录（没有 `consentRevision`）：`setPermissionMode` 在网关报 `not-granted`；启动页「需要授权」行打开的对话框写着「插件项目里的会话：插件还能替你批准或拒绝工具调用、回答 Agent 的提问、切换权限模式。」、没有「完全访问」行；确认后记录的 `consentRevision` 为当前值（2），「需要授权」行消失，后面各步可用                                |
| a    | 插件项目以外     | 用户在主界面建的会话：订阅以 `forbidden` 结束，回答与切换都报 `forbidden`                                                                                                                                                                                                                                                                        |
| b    | 批准一次         | 插件与宿主审批面板看到同一个 Write 审批（初始模式 `build`）；插件选 `allowOnce` → `accepted`，订阅里交互消失，宿主审批面板消失，文件写出，回复 `E2E_P3E_ALLOW_DONE`；扩展订阅这个会话的行，`Write` 工具行等审批时是 `pendingApproval`，执行完是 `success`（以前只由 PLM-JARVIS-2 断言）                                                          |
| c    | 拒绝             | 选 `deny` → `accepted`，文件没有写出，回复 `E2E_P3E_DENY_DONE`                                                                                                                                                                                                                                                                                   |
| d    | 回答提问         | AskUserQuestion 是 `userInput`，选项里是问题原文与模型给的两个选项（`choice:E2E_P3E_ANSWER_A`、`choice:E2E_P3E_ANSWER_B`，原由 PLM-JARVIS-2 断言）；用宿主相同的 `content`（`answers`、`answer_0`、`answer`）回答 → 回复 `E2E_P3E_ASK_GOT_B`（夹具要求请求体里有答案）                                                                           |
| e    | 先到先得         | 宿主先批准，交互消失；插件再用同一个交互回答 → `stale`，不发命令；回复 `E2E_P3E_HOST_DONE`                                                                                                                                                                                                                                                       |
| f    | 切换权限模式     | 首轮做完后切到 `guarded` → `accepted`，订阅收到 `guarded`；再切同一个值 → `unchanged`；切 `yolo` 与 `createSession({ mode: "yolo" })` 都报 `not-declared`                                                                                                                                                                                        |
| g    | 申请完全访问     | 清单改成 `["sessions.fullAccess"]` 并「重新加载扩展」：切 `yolo` 报 `not-granted`；启动页「需要授权」行打开的对话框有「插件项目里的会话」与「完全访问」两行；确认后切 `yolo` → `accepted`，订阅收到 `yolo`；再切回 `build` → `accepted`，订阅收到 `build`（原由 PLM-JARVIS-2 断言）；`createSession({ mode: "yolo" })` 建的会话一开始就是 `yolo` |
| h    | 允许并切完全访问 | 审批带 `fullAccess` 选项；插件选它 → 交互消失、模式变成 `yolo`，文件写出，回复 `E2E_P3E_FULL_DONE`                                                                                                                                                                                                                                               |
| i    | 范围与种类       | 插件建的会话都在插件项目里；插件收到的交互只有 `permission` 与 `userInput`                                                                                                                                                                                                                                                                       |
| j    | 审计             | 回答各一行，`choice` 有 `allowOnce`、`deny`、`answer`（`interactionKind: userInput`）、`fullAccess`，`stale` 记 `result.stale`；切换有 `guarded` 成功、`not-declared`、`yolo` 成功；审计里没有问题、答案与提示词原文                                                                                                                             |
| k    | 截图             | 重新确认对话框（中文浅色）、宿主审批面板（中文浅色）、完全访问授权对话框（中文浅色）、切到完全访问之后（英文深色）                                                                                                                                                                                                                               |

工作区 Hook 信任审查与插件安装确认两种交互只在投影里过滤，没有触发它们的桌面运行时用例。插件回答与宿主回答在 CLI 里真正同时到达（`accepted` 但没有生效）、`invalid-input`、调用期间撤销授权，也都没有桌面运行时用例。Jarvis 自己的内联审批、提问与模式切换界面随示例迁到市场仓库，人工验收。

## PLM-EXT-JARVISHOST：Jarvis 要的宿主能力

设计见 [扩展进程](plugins/extension-host.md) §18.1（H5、H6、H8、H9、H11、H12）、§18.4 Jarvis 第 1 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-jarvis-host.test.ts`。隔离 HOME；纯 JS fixture 扩展 `e2e-ext-jarvis-host`（`test/e2e/fixtures/fs/plugins/plugin-extension-jarvis-host/`）经 `plugins.dirs` 加载，有一个 `nav.primary` 条目打开 `scope: "app"` 的视图，视图工具改导航标记、请求授权、发通知。发送消息走 replay（`common.json` 与 `plugin-extension-jarvis-host.json` 的 `plugin-extension-jarvis-host-1`）。Main 的 `Notification.show` 换成记录、窗口焦点换成受控读数，测试机上不弹真实通知。证据：Main 日志（`[extension-host]` / `[extensions]` 前缀与 fixture 的 `E2E_JARVISHOST_*`）、视图标签页与页面 DOM、截图。

| 子项 | 场景                        | 断言                                                                                                                                                                                                                                          |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | H5 App 作用域视图           | 切到同一工作区的另一个会话再切回，实例 id 不变；全局「新建任务」进另一个工作区再切回，实例 id 仍不变，页面上只有一个这个视图的标签；`onDidOpen` 只调用一次                                                                                    |
| b    | H6 `ctx.extension.dataPath` | 等于 CLI 的插件数据目录（`<E2E HOME>/.zcode/cli/plugins/data/<插件 id>`），激活前已建好                                                                                                                                                       |
| c    | H9 `models.list`            | 列出 E2E provider 的模型（主模型与第二个模型都在），`id` 是 `provider/model`，标签是模型 id                                                                                                                                                   |
| d    | H11 导航未读标记            | 激活时为 3；改成 120 显示 99+；改成 `dot` 显示圆点；清除后没有标记；无障碍标签跟着变；英文界面同样                                                                                                                                            |
| e    | H12 `grants.request`        | 视图请宿主弹授权对话框，只列清单声明的档位；取消返回空档位，确认后返回声明的档位，再请求不弹                                                                                                                                                  |
| f    | H8 `notifications.show`     | 窗口有焦点 → `focused`；设置里「任务通知」关 → `disabled`；详情页开关关 → `muted`；都放开 → 弹出，标题带插件名前缀；紧接着第二条 → `rate-limited`；点击通知打开该插件的视图                                                                   |
| g    | 截图                        | App 视图、导航标记（数字与圆点）、授权对话框、通知开关：中文浅色、英文深色                                                                                                                                                                    |
| h    | 换代后的 App 作用域视图     | 杀掉扩展进程：视图按新代际重建（新实例 id，作用域仍是 `app`），页面重新就绪（以前只由 PLM-JARVIS-1 断言）                                                                                                                                     |
| i    | H6 重启后的数据             | fixture 每次激活在 `dataPath` 里把计数加一；重启 App 后读到的上一次计数等于重启前的值（以前只由 PLM-JARVIS-1 断言）                                                                                                                           |
| j    | H12 申请完全访问            | 清单改成 `["sessions.fullAccess", "notifications"]` 并「重新加载扩展」：视图经 `grants.request` 弹出的对话框标题是「读取和操作会话」，单独有「完全访问：…」一行；确认后返回 `sessions.fullAccess,notifications`（以前只由 PLM-JARVIS-1 断言） |

H5 切到远程工作区、窗口重载后恢复 App 视图标签（侧栏标签只在内存里，不恢复），H8 每天 20 条的上限与 Window Host 重启后计数清零，Windows、Linux 上的 `Notification.isSupported()` 与 `dataPath` 的创建，都没有桌面运行时用例。

## PLM-EXT-P3B：扩展的会话读连接与商店安装后的激活确认

设计见 [扩展进程](plugins/extension-host.md) §17.3、§17.5、§17.7、§17.10 第 2 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-sessions-read.test.ts`。隔离 HOME；纯 JS fixture 扩展 `e2e-ext-reads`（`test/e2e/fixtures/fs/plugins/plugin-extension-reads/`，清单 `grants: ["sessions.read"]`、`protocols: { sessions: 1, rows: 4 }`，授权记录预先写进隔离 HOME 的 `grants.json`，授权流程由 PLM-EXT-P3A 覆盖）经 `plugins.dirs` 加载：订阅会话列表；列表里有 9 个种子会话时做一次上限探测；观察最近的非种子会话的行与会话状态，镜像里出现测试标记时调一次 `readRows`；视图 `rows` 显示镜像的行。9 个种子会话用 `seedProviderReadinessHistoryFixture` 在 App 退出后写入。本地插件市场 `store-market` 有两个带扩展代码与技能的插件，经设置页的插件商店安装。正式会话用 replay 创建（提示词带标记 `E2E_EXT_READS` 与 `upstream-e2e-ok`）。证据：Main 日志（`[extensions]` 的 session read connection / session mirror / activation 行与 fixture 的 `E2E_READS_*` / `E2E_STORE_*`）、隔离 HOME 的 `grants.json`、视图页面 DOM、截图。

| 子项 | 场景                   | 断言                                                                                                                                                                                                                                                 |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 列表                   | 订阅后第一个事件是 snapshot，含 9 个种子会话；Window Host 记 `session list pump started`                                                                                                                                                             |
| b    | 上限与退订             | 9 个不同会话的行订阅：前 8 个收到 `reset`，第 9 个以 `limit-exceeded` 结束（经 `onError`）；Window Host 记 `session read connection open connectionId=extension-host:<gen>`；插件退订后记 8 次 `session mirror released`                             |
| c    | 实时行与 readRows      | 打开视图后在界面上发消息：视图出现用户行（含标记）与回复 `deepseek-e2e-ok`；插件先收到 `reset`，回复经 `rows` 增量到达；`readRows` 返回含标记的行；会话状态事件到达；日志里没有提示词原文；中文浅色、英文深色截图                                    |
| d    | 换代后 reset           | 杀掉扩展进程：新一代重新激活、重新订阅，第一个行事件是 `reset`，带用户行与回复；新连接 `extension-host:<gen+1>`，旧连接记 `session read connection closed`                                                                                           |
| e    | 商店安装后先不激活     | 已有扩展持有 `sessions.read` 时从商店安装 A：Window Host 记 `extension activation held`，`grants.json` 的 `activations` 为 `pending`；启动页「需要确认」一行；中文浅色截图                                                                           |
| f    | 不激活                 | 对话框列出持有者与「不激活时，插件的技能与 MCP 照常可用。」；点「不激活」→ `declined`，行消失；A 仍启用，技能仍在引用目录里；A 的扩展代码始终没有运行                                                                                                |
| g    | 关闭不算决定、确认激活 | 安装 B，英文深色截图行与对话框；Esc 关闭后仍是 `pending`，行还在；再打开并确认 → `E2E_STORE_ACTIVATED plugin=e2e-ext-store-b@…`，记录删除，行消失                                                                                                    |
| h    | 重新加载扩展后 reset   | 命令中心「重新加载扩展」：扩展重新激活、重新订阅，这个会话的第一个行事件是 `reset`，带用户行与回复（以前只由 PLM-JARVIS-1 断言）                                                                                                                     |
| i    | 长历史的尾部窗口与翻页 | 经 Window Host 导入 40 轮的会话（标题 `E2E_READS_HISTORY`），扩展优先观察它：`reset` 的窗口里没有第一轮；`readRows({ beforeRowId, limit: 20 })` 往前翻至少 2 页，最后一页 `hasMore=false`，翻到第一轮，总行数不少于 80（以前只由 PLM-JARVIS-1 断言） |

镜像预算（8 MiB 丢旧行）、单个事件超过 1 MiB 的 `stale`、全局 32 个镜像、断档重同步、会话重启或运行时重启后的重新订阅、`declined` 后经设置页停用再启用、授权撤销时订阅以 `not-granted` 结束都没有桌面运行时用例。

## PLM-EXT-STORE：商店按插件 API 版本挡住不兼容的扩展插件

设计见 [插件发布](plugins/plugin-publishing.md) §4.3、§4.4、§11。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-store-extension-compat.test.ts`。隔离 HOME；本地目录市场 `store-market`（`test/e2e/fixtures/fs/plugins/plugin-store-extension-compat/`，市场 id `e2e-ext-compat-market`）有四个插件：`e2e-ext-compat-ok`（`engines ^1.4.0`，申请 `sessions.fullAccess` 与 `notifications`）、`e2e-ext-compat-future`（`^99.0.0`，申请 `sessions.read`）、`e2e-ext-compat-installed`（先装兼容的 1.0.0，运行中把目录与插件包升到要求 `^99.0.0` 的 2.0.0）、`e2e-ext-compat-plain`（不带扩展，运行中升到 2.0.0）。市场经测试动作添加，installed 经测试动作安装，其余经商店界面操作。不调用模型。证据：测试动作 `getPluginsOverview` 的结果（经 services，能力位协商后带 `listing.extensionSummary`）、商店 DOM、截图。

| 子项 | 场景               | 断言                                                                                                                                                                                    |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 能力位与透传       | overview 里 ok、future 的 `listing.extensionSummary` 与目录一致，`componentTypes` 含 `extension`；plain 没有扩展摘要                                                                    |
| b    | 列表挡不兼容       | future 的安装按钮不能点，文字「需要更新 ZCode」，`data-install-blocked="requires-update"`；ok 与 plain 的按钮照常「安装」                                                               |
| c    | 不兼容的详情页     | 按钮同上；简介下一行说明要先更新 ZCode；「含常驻代码」区列出「读取会话」，没有完全访问一行                                                                                              |
| d    | 兼容的详情页       | 没有不兼容说明；「含常驻代码」区按档位名列出「读写会话（含完全访问）」「发送系统通知」，完全访问另起一行（授权对话框原文，以「完全访问：」开头）                                        |
| e    | 普通插件与安装     | plain 的详情页没有扩展说明；ok 与 plain 从商店装上，装上后 ok 的安装前说明消失                                                                                                          |
| f    | 不兼容的新版不提示 | 刷新后 CLI 对 installed 与 plain 都报 `update-available`，installed 的 `listing.extensionSummary` 是 `^99.0.0`；列表只给 plain 显示「可更新」与更新按钮；installed 的详情页没有更新入口 |
| g    | 全部更新跳过       | 管理视图「全部更新（1）」；执行后 plain 到 2.0.0，按钮消失；installed 仍是 1.0.0、启用、`update-available`                                                                              |
| h    | 语言与主题         | 列表、future 详情、ok 详情：中文浅色与英文深色各一张；英文文案「Requires newer ZCode」「Includes resident code」；全部更新前后各一张                                                    |

版本不同的 Desktop 与远端 Server、新 services 配旧 CLI（没有能力位）都没有桌面运行时用例；由 CLI 协议测试（`plugins-protocol.test.ts` 的 extension summary、`v4-extension-input-source.test.ts` 的能力位）与 §4.3 的分层分析覆盖。会话里的插件推荐卡片与 Side Pane 默认界面推荐不挡（§4.3），没有用例。

## PLM-EXT-P3A：扩展的会话读权限、授权与审计

设计见 [扩展进程](plugins/extension-host.md) §17.2、§17.3、§17.7、§17.8、§17.10 第 1 步。候选桌面入口：`packages/desktop/test/e2e/plugins/extensions/manual-review/pending/plugin-extension-sessions.test.ts`。隔离 HOME；三个纯 JS fixture 扩展（`test/e2e/fixtures/fs/plugins/plugin-extension-sessions/`）经 `plugins.dirs` 加载：`e2e-ext-sessions`（清单 `grants: ["sessions.read"]`、`protocols: { sessions: 1 }`；激活时与每次换语言时调 `ctx.sessions.listSessions({})`，再对每个会话调 `readSession({ sessionId, view: "messages" })`，日志只有数量、id、角色与是否含测试标记）、`e2e-ext-sessions-nogrant`（没有声明 grants）、`e2e-ext-sessions-late`（带代码，初始禁用）。正式会话用 replay 创建（提示词带标记 `E2E_EXT_SESSIONS` 与 `upstream-e2e-ok`，命中 `provider-basic.json` 的 `upstream-provider-basic`）。证据：Main 日志、隔离 HOME 的 `~/.zcode/v2/extensions/grants.json` 与 `audit/*.jsonl`、启动页与详情页 DOM。

| 子项 | 场景                 | 断言                                                                                                                                                                                                                                                                                   |
| ---- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 未授权               | 扩展照常激活，`listSessions` 报 `not-granted`；没有声明档位的扩展报 `not-declared`；没有 `grants.json`                                                                                                                                                                                 |
| b    | 启动页「需要授权」   | 「扩展」分区有 `extension-grant:e2e-ext-sessions@inline` 一行（「需要授权」「读取会话」）；没有声明档位的插件没有这一行；深浅主题 × 中英文截图                                                                                                                                         |
| c    | 授权对话框           | 点这一行弹授权对话框，标题「允许「e2e-ext-sessions」读取会话？」，正文是 spec 原文；Esc 取消后没有记录、这一行还在；英文深色重开（标题「Allow “e2e-ext-sessions” to read sessions?」）后确认： `grants.json` 有 `{ grants: ["sessions.read"], consentedVersion: "1.0.0" }`，这一行消失 |
| d    | 授权后读会话         | 发一条 replay 消息建正式会话；换语言触发探测：`listSessions` 成功且含该会话 id；`readSession(view: messages)` 返回 `roles=assistant,user`，含测试标记                                                                                                                                  |
| e    | 启用确认             | 已有授权时，在设置页启用 `e2e-ext-sessions-late`：先弹启用确认（列出持有者「“e2e-ext-sessions” (Read sessions)」）；Esc 取消后开关仍关、没有激活；中文再开（「「e2e-ext-sessions」（读取会话）」）确认后它激活                                                                         |
| f    | 详情页「权限」与撤销 | 详情页「权限」区块显示已授予与「最近操作」的授权一行；点「撤销」后状态回到需要授权，「最近操作」新的在前是撤销、授权；`grants.json` 里没有该插件                                                                                                                                       |
| g    | 撤销后               | 换语言再探测，`listSessions` 又报 `not-granted`；启动页又显示「需要授权」                                                                                                                                                                                                              |
| h    | 审计文件             | 该插件的审计行只有 `grants.grant`、`grants.revoke` 两行（`v: 1`、`grant: "sessions.read"`、`outcome: "ok"`）；文件里没有提示词标记、回复文本与隔离 HOME 路径                                                                                                                           |

插件更新时权限变多、变少（`reconcile`）、`incompatible`（清单声明的协议版本不对）、`limit-exceeded`（第 5 个 wait）、换代时中止在途调用、卸载删除记录都没有桌面运行时用例。从插件商店安装（安装即启用）改为安装后、激活前确认，见 PLM-EXT-P3B。

## PLM-EXT-P2D：插件设置与扩展的 `settings` 能力

设计见 [扩展进程](plugins/extension-host.md) §16.7、§16.10 第 4 步，存储见 CLI spec「Sensitive Option Storage」。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-settings.test.ts`。隔离 HOME；两个纯 JS fixture 扩展（`test/e2e/fixtures/fs/plugins/plugin-extension-settings/`）经 `plugins.dirs` 加载：`e2e-ext-settings`（`userConfig` 有敏感键 `token` 与普通键 `region`，默认值 `eu`）与 `e2e-ext-settings-other`（只有自己的 `mode`，默认值 `lite`）。两个扩展都在 `env.onDidChange`（订阅后先收当前值，之后每次换语言）时调 `ctx.settings.get()` 并记日志；第一个另订阅 `ctx.settings.onDidChange`。fixture 只记 `hasToken`、token 长度、`region`、`mode` 与键名，不记 token 本身。token 每次运行随机生成。不需要模型。P4 H1（[扩展进程](plugins/extension-host.md) §18.1、§18.4 GitLab 第 1 步）在同一用例里加子项 h–k：第一个扩展多一个视图 `account`（写法一），工具 `login({ token })` 与 `logout()` 调 `ctx.settings.update`，用例经沙箱页面的 `window.zcode.callTool` 调它们（与 GitLab 面板登录同一条路径）；第二个扩展在第一次 `env.onDidChange` 时试写不属于它的键。H4（图标）也在这里验证：账号视图用 `git-pull-request`，启动页条目用 `log-in`，另有一个 `nav.primary` 条目用 `git-merge`。

| 子项 | 场景                       | 断言                                                                                                                                                                                                                                                                 |
| ---- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 保存前                     | 第一个扩展的 `settings.get` 只有默认值（`region=eu`、`hasToken=false`）；第二个只有 `mode=lite`                                                                                                                                                                      |
| b    | 设置页保存两个键           | 插件管理详情的高级设置里填 token 与 region 并保存；`config.json` 的 `plugins.options` 只有 `region`；`plugin-secrets.json` 的 `user` 有 token；`config.json` 里没有 token 原文                                                                                       |
| c    | `settings.onDidChange`     | 保存后收到 `{ values }`：`hasToken=true`、长度等于 token 长度、`region` 是新值、键是 `region,token`                                                                                                                                                                  |
| d    | `settings.get` 与隔离      | 换语言触发两个扩展再读：第一个拿到 token（只看长度）与 region；第二个仍只有 `mode`，没有 `token`、`region`                                                                                                                                                           |
| e    | 设置页                     | 敏感输入框是 `password` 类型；保存后 token 有「清除」按钮，scope 标记从 `default` 变成 `user`；深浅主题 × 中英文截图                                                                                                                                                 |
| g    | 清除敏感值                 | 点「清除」再保存：`plugin-secrets.json` 里没有 token，`config.json` 仍只有 `region`；`onDidChange` 再触发一次，`hasToken=false`；token 的 scope 标记回到 `default`                                                                                                   |
| f    | 不泄露                     | 清除后扫描隔离 HOME 与 App 数据目录，token 原文不在任何文件里（App 日志、CLI 日志、数据库）                                                                                                                                                                          |
| h    | `settings.update` 写入     | P4 H1（§18.1）。视图 `account` 的工具 `login` 调 `settings.update({ values: { token } })`，token 是本次运行的第二个随机值。`config.json` 里没有它，`plugin-secrets.json` 的 `user` 有；`onDidChange` 触发，`hasToken=true`、长度等于新 token；工具的返回里没有 token |
| i    | 只写自己的插件             | `e2e-ext-settings-other` 写 `token`（它的 `userConfig` 没有这个键）与类型不符的 `mode`，两次都报 `invalid-input`；它自己的选项与第一个插件的 token 都不变                                                                                                            |
| j    | 写入后不泄露               | 扫描隔离 HOME 与 App 数据目录，新 token 原文只在 `plugin-secrets.json` 里                                                                                                                                                                                            |
| k    | `settings.update` 清除     | 工具 `logout` 调 `settings.update({ clear: ["token"] })`：`plugin-secrets.json` 里没有 token，`config.json` 不变；`onDidChange` 触发，`hasToken=false`；最后再扫描，两个 token 都不在任何文件里                                                                      |
| l    | H4 图标                    | 启动页条目（`log-in`）、导航条目（`git-merge`）与视图标签（`git-pull-request`）渲染白名单图标，`svg` class 是对应的 `lucide-*`，没有退回通用插件图标；账号视图中文浅色与英文深色截图                                                                                 |
| m    | `settings.update` 写普通键 | 视图工具 `setRegion` 调 `settings.update({ values: { region } })`：`config.json` 的 `plugins.options` 变成新值，`plugin-secrets.json` 里没有 `region`；`onDidChange` 触发（以前只由 PLM-JARVIS-2 断言）                                                              |

旧 CLI（没有 `plugins/readUserOptions`）时只返回非敏感值、workspace scope 保存不通知扩展、直接改文件不触发 `onDidChange` 都没有桌面运行时用例。`settings.update` 的其他入参错误（同一个键既写又清、超长、空入参）只在协议 schema 里约束，没有桌面运行时用例。

## PLM-EXT-H2：扩展开预填草稿（`workbench.startDraft`）

设计见 [扩展进程](plugins/extension-host.md) §18.1 H2、§18.4 GitLab 第 3 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-start-draft.test.ts`。隔离 HOME；纯 JS fixture 扩展 `e2e-ext-draft`（`test/e2e/fixtures/fs/plugins/plugin-extension-start-draft/`）经 `plugins.dirs` 加载。它有一个 `composer.status` 条目，点击执行命令，命令调 `ctx.workbench.startDraft`（与 GitLab 面板「用 ZCode 审查」同一条路径）。奇数次点击用当前工作区，偶数次显式传命令作用域的工作区。fixture 日志只记点击序号、长度与结果。不需要模型。

| 子项 | 场景         | 断言                                                                                                                                                            |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 当前工作区   | 点击后输入框是预填文字；没有用户消息（没有发送）；任务列表的任务数不变（没有新会话）；Window Host 记 `workbench.startDraft acked … ok=true`；日志里没有预填文字 |
| b    | 入参不合规   | 4001 字符与只有空白的文字都报 `invalid-input`，输入框不变                                                                                                       |
| c    | 显式传工作区 | 清空输入框后再点：输入框是第二段预填文字，没有发送，任务数不变                                                                                                  |
| d    | 截图         | 中文浅色、英文深色                                                                                                                                              |

当前工作区只读时回执失败（扩展收到 `internal`）、在设置页或插件市场之上调用时先回到对话主视图、没有窗口时报 `host-unavailable`，都没有桌面运行时用例。

## PLM-EXT-H3：扩展进程的网络跟随设置页

设计见 [扩展进程](plugins/extension-host.md) §12.1「网络跟随设置页」、§18.1 H3、§18.4 GitLab 第 2 步。正式桌面入口：`packages/desktop/test/e2e/plugins/extensions/plugin-extension-network.test.ts`。隔离 HOME；纯 JS fixture 扩展 `e2e-ext-network`（`test/e2e/fixtures/fs/plugins/plugin-extension-network/`）经 `plugins.dirs` 加载，每次激活记下网络相关环境变量是否存在（不记值），再用全局 `fetch` 请求 `https://gitlab.e2e.example.invalid/api/v4/version`。用例起一个 E2E 抓包代理（`helpers/network-capture-proxy.ts`，自己的 CA，对这个地址回固定响应）。设置在真实设置页（通用 → 网络卡片）保存，每次改完从命令中心「重新加载扩展」。不需要模型。

manual-review 默认是 capture 模式：WDIO 在 worker 开始时把上游抓包代理与 CA 写进 `setting.json`，也写进自己的环境（Electron 继承）。用例在重启前清掉 `setting.json` 的三项，Main 环境里的值保留，正好用来验证「设置页留空时沿用环境、有值时压过环境」。

| 子项 | 场景                    | 断言                                                                                                                                                                                                                                                                                  |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | 设置页没有代理          | 监管器记的来源跟随 Main 环境（有变量时是 `env`，没有时是 `none`）；本用例的代理收不到请求，扩展拿不到固定响应                                                                                                                                                                         |
| b    | 设置页填代理与 No Proxy | `network proxy=settings noProxy=settings`，证书来源跟随 Main 环境；扩展环境里代理与 No Proxy 的大小写形式都在；`environment proxy: enabled`；请求以证书错误失败（本用例的 CA 不受信任），代理记录里没有这个请求。环境里的代理受环境 CA 信任，所以证书错误也证明设置页的代理压过了环境 |
| c    | 再填自定义证书          | `network proxy=settings noProxy=settings ca=settings`；请求成功，拿到固定响应；代理记录里有这个 https GET，状态 200；设置页截图（中文浅色、英文深色）                                                                                                                                 |
| d    | 日志不带地址            | `network …` 与 `environment proxy: …` 行里没有代理地址与证书路径                                                                                                                                                                                                                      |

Windows 上变量名不分大小写只写一份、代理地址不合法时只记错误码、读设置失败时只用 Main 环境，都没有桌面运行时用例。

## PLM-DESIGN-001：Design 默认关闭与浏览器安装引导

默认配置下 Design 可发现但未启用，技能与 hook 不进入会话。人类 Browser 点击“选择元素”出现安装提示且按钮未选中；取消保留页面，确认打开指定 Design 详情页。用户启用后回到 Browser 可选择元素，停用后退出设计运行时。用户/项目显式启用配置继续有效。查询失败及目标切换不复用旧启用状态。Agent 普通元素引用与自由尺寸不受影响。
