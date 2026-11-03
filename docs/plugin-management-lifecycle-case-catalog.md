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

### PLM-UI-001 UI 市场与项目配置

- 隔离 HOME，真实目录/安装/配置服务与提供 `ui://` 资源的 MCP fixture。先安装，在模型配置就绪的草稿中打开 UI，再验证首发提升后的正式会话。
- 验证公共/社区/个人互斥、UI 专区、详情图片放大和关闭、市场内管理/返回保留查询与范围。UI 专区默认全部展示，支持原位 8→6→8 张卡片切换；其他分类始终可见，搜索清空和分段往返保留各分段的手动选择。主区域与 Side Pane 复用相同交互。
- 项目 A 暂停不影响项目 B 与全局；恢复继承后使用全局状态。已安装 UI 打开；暂停后先启用，失败不打开；多个 surface 要选择；关闭面板不卸载。
- 已安装 UI 卡片的独立“详情”入口可查看信息与配置，不启用或打开插件；主市场的主导航返回已有聊天。全局设置与市场同步、远程同步通知、后台错误保留及慢视图不阻塞提交由真实 store/hook 回归补充；移除源包验证安装失败，再恢复并重试。
- 浏览器层补充中英文、Zai Light/Dark、桌面与窄面板、键盘；手机/Web/远程打开提示不支持，安装管理仍可用。浏览器窄视口不等于真实手机远控验证。
- 新测试保持 `manual-review/pending`，不自动提升 CI admission。

## PLM-TEL-001 最终结果业务埋点

待人工审核：`plugins/plugin-lifecycle-telemetry.test.ts`。
通过真实个人来源添加、插件详情安装入口，验证安装前零结果、安装完成后一条成功结果、event_id/耗时/插件归属/入口齐备，并且没有 operation_id 或本机路径。上报仅在传输出口 mock，插件安装执行真实 CLI。尚未晋升正式 CI。

## PLM-UI-BACKGROUND 后台执行与保留

`PLM-UI-DISPLAY-MODES`：按 [展示模式 spec](plugin-ui-display-modes-spec.md) 验证页面注册模式的硬约束。真实时间线覆盖 fullscreen-only 打开卡片、关闭不回 inline、页面请求与重挂不绕过约束；未声明和双模式页面指定 fullscreen 时同样不回 inline。inline-only 拒绝 fullscreen。握手前 guest 隐藏。关闭、重开、会话重挂保持同一 guest ID、一次启动/读取/登记、内部 React 状态与后台帧执行；后续成功调用改回 inline 可复用原 guest。入口 `mcp-apps-host-e2e.mjs --rows-only`，候选回归，不自动晋升 CI。

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

浏览器候选用例：`packages/ui/test/browser/manual-review/pending/plugin-concurrent-install.test.mjs`，真实 store 与共享安装按钮，受控服务完成，390/1200px × 中英文 × 深浅主题。浏览器用例保持 pending，不自动晋升。桌面正式用例：`packages/desktop/test/e2e/plugins/plugin-concurrent-install.test.ts`，真实个人来源与 CLI 安装，通过本地 HTTP 响应门控制失败顺序。

## PLM-DETAIL-DURING-INSTALL

插件 A 的安装下载未完成时，打开其他未安装插件的详情，组件区按 `plugins/describe` 正常加载；插件列表与总览（新建右侧标签页首次加载使用）也立即返回，不等待 A 的安装结束；A 仍保持安装中。卡片“更新”和详情“恢复用户默认”只在自身插件操作中禁用。

桌面用例：作为 PLM-CONCURRENT-INSTALL 桌面正式用例中的一步，真实个人来源与 CLI，HTTP 响应门挂起 A 的下载、B 排在 A 后面时打开本地插件详情，返回后两项仍为安装中；同一时刻经桌面服务链路请求 list/overview，10 秒内返回。单测覆盖 transport 立即派发 describe/list/overview、manifest 已缓存时不等存储锁、manifest 缺失时仍进锁，以及两处按钮的按插件禁用。随 PLM-CONCURRENT-INSTALL 桌面用例一起转正。

## PLM-BUILTIN-UI-UNINSTALL

卸载内置 UI 插件（如 Word 文档）后，可恢复卡片仍在「UI 插件」专区，不掉进「生产力」等分类分组。已安装时同样在专区。

桌面候选用例：`packages/desktop/test/e2e/plugins/manual-review/pending/plugin-builtin-ui-uninstall.test.ts`，真实 CLI，经卡片菜单卸载 `documents@zcode-plugins-official`，等待总览进入 `restorableBuiltins` 后断言卡片在 `plugin-store-ui-section` 内。bootstrap 单测校验内置定义的 `ui` 组件类型与插件包 `ui.surfaces` 一致，且卸载后官方目录与可恢复列表都带 `ui`。保持 pending，不自动晋升。

## 插件市场与管理列表统一（2026-10-22）

市场未安装卡片显示安装，已安装卡片常驻启停开关；更多菜单仅含卸载，详情页仍通过菜单启停与卸载。管理页复用单列卡片，保留已安装/内置分组，不显示逐行配置来源标签；配置作用域与继承行为不变。管理页通过标题左侧返回按钮回市场。

WPL-015 在市场安装前断言无开关，安装后通过卡片开关停用再启用，并读取 Agent 投影；随后验证 User/Workspace 配置、暂停与恢复继承。PD/PP、PF、PLM-UI-001 使用新的管理返回入口；PLG12 的详情启停使用菜单。启停中保留可见的加载提示和无障碍标签。

`PLM-UI-RETENTION`：见 [后台执行 spec](plugin-ui-background-execution.md)。资源声明才后台保留；默认五分钟回收并重建 widgetState；每窗口超过四个后台声明页时按三十分钟未活跃且不忙淘汰。轮询不续期、可见/忙碌保护、删除/重建竞态；入口 `--managed-only`，候选回归不晋升 CI。

### 草稿 MCP UI 回归

`PLM-UI-001` 增补：模型配置就绪但未发送消息时，从主导航打开 UI 并进入根草稿；离开市场再返回保留 guest 内存；首发提升复用同一 guest。右侧市场和启动页使用所属 pane 的有效 session；异步切换和换代由定向单测覆盖。当前使用上游已转正的 `plugins/plugin-management-ui-market.test.ts`；原 App 单测已退役，不能将历史覆盖视为现行证据。

P2 回归补充：PLM-UI-001 暂停真实 createSession RPC，从主导航发起打开后切到正式会话或另一工作区，再回同项目草稿；断言待处理请求已撤销且新草稿不打开旧插件。单个连接失效保留多插件上下文、删除等待多 server 退订由定向单测覆盖。

合并回归补充：草稿插件打开后进入、退出侧栏完整视图，确认 guest 内存标记和未发送输入保留、聊天行数仍为零。

完全访问回归：冷草稿调用工具，在审批卡选择完全访问并勾选风险确认后提交；确认前权限不变且确认按钮禁用，提交后断言工具返回、Composer 权限同步、零聊天行和零正式任务。再次调用无需审批；切换工作区返回及首发后权限保持、同一 session/guest 被复用。失败重试、持久化交错、旧绑定失效由定向测试覆盖。已有审批积压作为真实 PDF 复测观察项，不新增批量放行规则。
