# Team Plan E2E Cases

本文记录 Team Plan 接入后，桌面端设置页和用量入口需要覆盖的 E2E case。范围限定在 desktop local workspace，接口使用 WDIO case-local mock server，不访问真实 BigModel / Z.ai 套餐接口。

## 覆盖原则

- 每条 case 都必须有独立 setup、action、assert，不把“路径经过”视为覆盖。
- Team Plan 的额度和统计必须使用团队项目上下文：`organizationId`、`projectId`、团队 header、`type=2`。
- 个人 Coding Plan 与 Team Plan 同时存在时，各自作为独立 Provider 展示和承载产品数据。
- E2E mock server 记录业务请求，用于断言是否请求了企业套餐列表、个人 quota、团队 quota、模型用量和工具用量。

## Accepted Cases

| Case   | 场景                                                       | Setup                                                                           | Action                                                                   | Assertions                                                                                                                                                     |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTP-01 | 登录后获取套餐列表；不进入设置页也会触发 Team Plan pricing | 已登录 BigModel，当前 provider 为 BigModel Coding Plan，mock 返回已购 Team Plan | 启动默认工作区，不打开设置页                                             | mock server 收到 `/subscription/enterprise/v2/pricing`；页面仍停留工作区                                                                                       |
| CTP-02 | 设置页连接方式展示按量 API、个人 Coding Plan 与 Team Plan  | 已登录 BigModel，mock 同时返回个人与 Team Plan                                  | 打开模型设置并展开连接方式；选择 Team Plan                               | 菜单包含三类正式连接；设置保存结构化 `providerFamilyConnectionSelections.bigmodel`，不写旧 `mode/selectedKey`                                                  |
| CTP-03 | 用户头像菜单进入 Team Plan 使用统计                        | mock 返回 Team A quota，当前连接方式为 Team A                                   | 点击用户头像菜单里的使用统计入口                                         | Usage 页切到 Team Plan 编程套餐，显示 Team A 名称和剩余额度百分比；mock 收到 `quota/limit?type=2`                                                              |
| CTP-04 | 设置 → 使用统计 → 编程套餐显示 Team Plan 用量              | mock 返回 Team A quota、model usage、tool usage                                 | 打开设置页 → 使用统计 → 编程套餐                                         | 页面显示 Team A 额度、模型用量、工具用量；mock 收到 `quota/limit?type=2`、`model-usage?type=2`、`tool-usage?type=2`                                            |
| CTP-05 | 切换 Family 连接后分别查看个人/团队用量来源                | mock 同时返回个人与 Team Plan                                                   | 在设置页切换个人 Coding Plan 与 Team Plan                                | 产品卡与模型成员跟随当前结构化 connection selection；使用统计按账号展示全部来源 tab，仅选中来源的 quota 生效，不将未选中的 Team tab 当作数据泄漏               |
| CTP-06 | OAuth 启动恢复保留已选择 Team Plan                         | 冷启动前保存结构化 Team Plan selection，账号凭据可恢复                          | 启动 App 并打开模型设置                                                  | Team Plan 仍为当前连接，organization/project identity 完整；OAuth 恢复不覆盖为个人 Coding Plan                                                                 |
| CTP-11 | quota 致命失败后保留来源并可恢复                           | 已登录 BigModel，当前连接为个人 Coding Plan，mock 首次返回 quota fatal          | 打开使用统计 → Coding Plan；确认错误后切到 App Usage，再切回 Coding Plan | 错误态使用当前“无法读取用量统计”语义；subscription snapshot 存在时 Coding Plan 来源 tab 不消失；mock 恢复后重新进入来源并显示 quota、model usage 和 tool usage |

## Fixture Contract

### CTP-12：供应商长团队名称与独立 Start Plan 导航（formal）

- Setup：真实 Electron 应用、隔离测试配置，业务 mock 提供长组织名称、个人/团队套餐与一份有效 Start Plan 权益。
- Action：从设置进入模型供应商，选择团队；在宽、窄窗口检查名称与箭头，再打开独立 Start Plan 导航；离开并重新进入设置，返回品牌入口。
- Assertions：宽屏可显示全称且标题与操作区同行；窄屏不足时名称省略、控件不越界；Start 详情不显示付费连接下拉；浏览 Start 不改变已保存的团队连接，重新进入品牌页仍显示原团队。
- 当前导航合同以 [Start 独立规格](../zai-start-plan-provider.md) 为准。已删除的体验套餐快捷按钮和 tooltip 不再作为操作前置条件，不恢复旧 `kind: start-plan` 写入。
- 仅覆盖桌面真实应用路径；20 组组件浏览器测试继续承担尺寸/语言/主题组合，不声称覆盖手机 `/remote` 链路。
- 自动化：`packages/desktop/test/e2e/settings/providers/provider-family-responsive.test.ts`。2026-09-04 本地真实 Electron 运行通过，用户确认通过即转正；正式入口不带 manual-review 开关已再次通过（1 passed）。
- 本用例通过 scenario 控制端启用专属长名称和 billing/balance fixture；普通 Team mock 场景恢复默认数据，不发送模型请求。

正式运行命令（本用例不调用模型，账户接口使用本地业务 mock）：

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/settings/providers/provider-family-responsive.test.ts'
```

通过证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20260904060418619-p33484-6650d642259f46f0/summary.json`（1 passed）。本次修正 runner 的专属 JWT 初始化、等待真实刷新结束，以及 Radix 可见 tooltip 的 WebDriver 选择器；未改产品实现。

转正证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20260904060754282-p39563-0c1b2374a55285ca/summary.json`（1 passed，默认正式入口）。重新进入设置只读取恢复状态，不再次点击供应商导航覆盖选中项。通用转正脚本仅支持 conversation 目录，本用例按设置领域路径迁移并同步引用；没有加入 Docker suite。

窗口取 1800/480px（Electron 最小宽度 480px），独立 Start 导航在 1200px 检查。每次运行保存宽屏、窄屏、Start 详情和重新进入后的团队选中截图，以及几何数值和业务请求断言。上方 2026-09-04 记录为旧交互的历史通过证据。

当前导航回归：2026-10-14 macOS Electron，`desktop-e2e-tests-only-20261014b` 中 CTP-12 通过；截图保存在同名本地 artifact 目录。该 run 的两个 webview case 当时失败，不将此记录视为整批通过。

### 通用约束

- 本组 case 不生成 DeepSeek provider replay fixture，因为测试不发送模型请求。
- 每次 mock scenario 重启前显式把 `lastWorkspaceSession` 固定到隔离 HOME 的 `ZCodeProject`；不能继承上一条 case 留下的 conversation workspace，否则 workspace 就绪断言和 model-resolution seed 会落到不同 bucket。
- WDIO mock server 负责业务接口：
  - `/api/biz/subscription/enterprise/v2/pricing`
  - `/api/biz/customer/getCustomerInfo`
  - `/api/monitor/usage/quota/limit`
  - `/api/monitor/usage/model-usage`
  - `/api/monitor/usage/tool-usage`
- `type=2` 表示 Team Plan；无 `type=2` 表示个人 Coding Plan。
- mock server 提供 `/__e2e/coding-plan/scenario` 和 `/__e2e/coding-plan/requests` 供 spec 切换场景与断言请求。

## Runner Preflight Contract

- 直接执行 `wdio run wdio.conf.ts` 时也必须校验 Electron package 的 `path.txt` 以及它指向的真实可执行文件，不能只因 `node_modules/.bin/electron` 包装脚本存在就认为 Electron 已安装。
- WDIO config 必须先按优先级加载 desktop/repo 的 `.env.e2e.local`，再读取 Electron 安装配置并执行二进制预检，保证 `ELECTRON_MIRROR`、代理、证书和缓存目录等本地配置同时传给安装子进程与后续 E2E 进程。
- Electron package 存在但二进制缺失时，WDIO config 在创建 ChromeDriver session 前运行该 package 的 `install.js`，随后重新校验真实可执行文件。安装必须有界等待：`ZCODE_E2E_ELECTRON_INSTALL_TIMEOUT_MS` 可覆盖默认 5 分钟超时，超时后必须终止子进程。
- 安装失败、超时或安装脚本执行后仍无二进制时必须直接报告 Electron 安装根因，诊断包含生效超时、脱敏后的镜像地址并通过 `cause` 保留原始异常，不能继续运行并退化成笼统的 `Chrome instance exited`。
- 该预检只修复本机 E2E 依赖，不改变桌面端 `desktop-continuous` session、手机端 `web-remote-replayable` 恢复链路或产品运行时状态。

### CTP-11 权益与额度分离回归（2026-09-17）

同一用例在 1200px 与 390px 分别使用 personalOnly 和 teamOnly：订阅接口有效，quota 先业务失败再传输失败，套餐用量入口仍可进入；恢复 quota 后各自额度重新显示。团队 mock 使用 querySubscribeDetail 返回成员授权；不再用 quota 或个人 subscription/list 合成团队权益。手机 UI 由共用组件回归覆盖逻辑，真实 /remote 验证单列，不由桌面通过推断。

### CTP-13 Start balance 限流恢复（2026-09-17）

Start Plan 的 balance 返回 429 时保留 Start 标题、单一失败提示和重试动作，不提示重新登录。
切换 mock 为有效 balance 后点击重试，套餐展示恢复。断言使用共享 balance 返回的当前模型
`GLM-5.3`（`GLM-5-Turbo` 已退役）。共享请求的一秒边界、账号隔离和失效竞态由
`zaiStartPlanBalanceSharing.test.ts` 覆盖。

### CTP-14–19：权益展示补全（formal，2026-09-18）

沿用已确认产品语义，不扩展套餐业务。专属本地 HTTP 夹具由 WDIO server 持有；case 在旧 Electron 完整退出后写入隔离凭据与连接选择，再启动应用读取接口。无需模型 replay fixture（不发送模型请求）。

| Case   | Setup / Action                                                                         | 必须断言                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTP-14 | BigModel 未连接，打开编程套餐                                                          | 连接动作、个人和团队购买 banner；无体验购买 banner、无模型列表/添加模型                                                                                           |
| CTP-15 | 个人无权益，团队商品仍 subscribed 但团队已过期                                         | 个人和团队购买 banner 同时出现；无模型列表；个人订阅请求使用短期项目 Token（project_access），不再携带长期 Key                                                    |
| CTP-16 | 选择团队，分别已过期、未分配、接口失败                                                 | 对应状态文案；确认过期/未分配时无模型列表（查询失败不等于无权益）；登录态不退化为连接按钮；失败点击重试后有效权益恢复模型列表；团队请求使用业务 token 和组织/项目 |
| CTP-17 | Start 返回 status=active、旧 server_time、已过期 ends_at 和旧余额                      | 以 HTTP Date 判过期；显示过期状态，无今日余额/旧模型列表                                                                                                          |
| CTP-18 | Start 同时返回已过期和有效计划                                                         | 仅有效计划与余额显示，模型列表可用                                                                                                                                |
| CTP-19 | 有效 Start + 已选择并确认可用的个人或团队连接，打开独立 Start 导航（保留付费连接身份） | 有效 Start 无升级/150% 操作；再以过期 Start 验证无个人/团队购买 banner；无付费权益作为正对照时升级可见                                                            |

组合按差异裁剪：CTP-16 覆盖三个独立团队状态；CTP-19 覆盖个人、团队及无权益。中英文品牌命名沿用 PN-01/02，额度失败保留入口沿用 CTP-11 的个人/团队和宽/窄屏组合；一秒共享请求与异步失效由服务单测验证。桌面窄窗口不等同真实手机 `/remote`，后者不在本次桌面回放证据内。这 9 个 case 已经用户确认，于 2026-09-18 迁移到 settings 正式目录；Docker/CI 准入单独验证。

回放发现并修复：Start 页曾直接使用团队导航的 `status=purchased` 判断已有付费权益，而该值可以来自历史 `pricing.subscribed`。现在购买/升级入口只读取 `ProviderSettingsView` 中同平台付费 Provider 的 Account `availability=available` 且 `entitled=true`。目录仅负责发现商品和团队身份。对应组件单测交叉覆盖导航状态与 Account 权益，旧实现出现 2 个失败，修复后通过。

```text
订阅接口 → Account owner 确认权益 → ProviderSettingsView → Start 购买/升级入口
商品目录 → 团队导航身份（不作为权益证据）
```

自动化入口：[coding-plan-entitlement-presentation.test.ts](../../packages/desktop/test/e2e/settings/providers/coding-plan-entitlement-presentation.test.ts)。业务数据由 [entitlement-presentation.ts](../../packages/desktop/test/e2e/fixtures/entitlement-presentation.ts) 提供，含有效静态个人/团队目录、`subscribed=true` 的实时团队商品、体验套餐预览及 150% 活动，避免对缺失配置做空的“不显示”断言。

现有用例维护：CTP-10 / QR 共用的 Account 模型选择更新到本轮 Builtin catalog 的 GLM-5.3；隔离账号首次启动使用共享 `skipOccupationOnboardingIfPresent` 完成引导。原来的 Escape 只临时关闭引导，QR-09/10 重载后会重新遮挡 Composer；失败时的 DOM 证据明确为 `onboarding-page`，不是权益或额度接口失败。

### 本轮验证证据（2026-09-17）

按 `file + title` 取最后一次结果，34 个独立 E2E 全部通过：新增 9 个展示场景，现有 CTP 19 个与 QR 6 个。中间失败及修复回放保留原始报告，不把失败批次写成全绿。

| Run（`packages/desktop/.e2e-artifacts/`） | 结果与覆盖                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `desktop-e2e-20260917-153050-019`         | 28 项中 26 通过。现有 CTP-10 暴露旧模型 ID；新增团队正向夹具需保留付费连接身份。两项已在后续回放修复。 |
| `desktop-e2e-20260917-154234-621`         | 新增 spec 9/9 通过；CTP-10 和 QR-01/02/03/04 通过。QR-09/10 暴露重载后引导遮挡，留待下一批修复验证。   |
| `desktop-e2e-20260917-155127-532`         | 8/8 通过：CTP-02、CTP-10、CTP-11 个人/团队 × 1200/390px，以及 QR-09/10。                               |

12 个相关服务/UI 单测文件共 349 项通过；`pnpm typecheck`、desktop `typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed`、改动文件格式与 diff 检查通过。lint 保留基线 55 warnings / 0 errors。应用经过重新构建后回放。

验证环境是 macOS Electron + 本地业务 HTTP mock。未验证生产服务、Windows/Linux、真实手机 `/remote`；上述回放时尚未转正，也未做 Docker/CI 准入。

#### 正式转正验证（2026-09-18）

用户确认转正后，将 9 个展示用例迁移到 `settings/providers/coding-plan-entitlement-presentation.test.ts` 并修正 helper/fixture 引用。通用转正脚本 dry run 只接受 conversation-session 路径，因此沿用 CTP-12 的设置领域迁移方式；业务 HTTP mock 注册按 spec 文件名匹配，无需变更。没有模型请求，无需 DeepSeek replay fixture。

关闭 manual-review 开关，通过正式 WDIO 入口回放，9/9 全部通过，证据为 `packages/desktop/.e2e-artifacts/desktop-e2e-20260917-161817-410/summary.json`。根 typecheck、desktop typecheck:e2e、lint（基线 55 warnings / 0 errors）、架构检查均通过。此次仅转正这 9 个用例，不包含导航语言用例，也未做 Docker/CI 准入。

CTP-16 启动夹具保存旧商品 ID，订阅和 pricing 返回当前商品 ID；组织与项目保持一致。各状态及重试恢复后断言不显示“连接不可用”，覆盖团队商品变更的导航恢复回归。平台/组织/项目隔离由导航单测覆盖。

2026-09-18 商品 ID 变化回归：原生 macOS Electron 回放 CTP-16 三种状态全部通过（3/3），包含失败后重试恢复。证据目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20260918-042734-046/`。导航及可见性相关单测 243/243 通过；未回放真实手机 `/remote`，未使用 Docker。

- CTP-20：Composer 供应商子菜单直接展示 BigModel Individual 与 BigModel 实际团队标签，无额外连接方式行；个人→团队→个人切换验证完整持久化身份、主行标签、模型与勾选。API 供应商保持原有入口。选择非默认思考档位后双向切换须保持该档位，并采样整个切换的 DOM，禁止档位中间清空或 Effort 消失。

- CTP-20 同时注入可用团队与明确无有效授权的团队，验证后者不出现在供应商列表；DOM 时序须捕捉主行 loading/aria-busy 的出现与结束，且原思考档位和控件始终保持。

### Composer 连接回归补充（2026-10-08）

| Case   | 场景与断言                                                                                                         | 验证范围                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| CTP-21 | 调思考后挂起 Host 选择解析，再主动选模型；新模型档位非空，同连接操作不触发连接 loading。                           | macOS Electron、隔离 mock，已通过                             |
| CTP-22 | 个人→普通 API→团队、团队→普通 API→个人；两段各显示 loading，目标思考完整；loading 期间模型列表与思考展示保持稳定。 | 双向 macOS Electron 已通过，共 41 次加载 DOM 采样，无不稳定帧 |
| CTP-23 | 团队激活时补充的个人入口跟随语言：zh-CN 显示“个人”、en-US 显示 Individual；团队实际名称不变。                      | 中英文 macOS Electron 已通过                                  |
| CTP-32 | 个人→API→个人、团队→API→同一团队；切回不改写设置版本与连接映射，思考完整，无错误。                                 | 双向 macOS Electron 已通过                                    |
| CTP-33 | 另一窗口把团队 A 改成 B，本窗口点 B 行；根 Host 身份与标签变为 B，设置版本不变，无错误。                           | macOS Electron 已通过                                         |

以上用例不发送模型请求；手机 Web、Windows/Linux 真机尚未验证。与现有 CTP-20 的直接个人/团队切换、不可用团队隐藏形成互补。

CTP-32 验证记录（2026-11-05，ZCT-2118278184274395136）：

- 修复前红测：两个方向都失败。连接映射前后相同，但 `providerFamilyDomainUpdatedAt` 被改写（例如 `1793875567452 → 1793875569205`），证明切回时有一次多余的设置写入。证据目录：`packages/desktop/.e2e-artifacts/ctp32-red/`、`packages/desktop/.e2e-artifacts/ctp32-red2/`。
- 修复后：CTP-32 双向、CTP-21、CTP-22 双向、CTP-24、CTP-28/29/31 共 9 条通过，证据目录 `packages/desktop/.e2e-artifacts/ctp32-green/`。`conversation-session-model-provider-plan-surface`（3 条）和 `conversation-session-v4-composer-toolbar`（16 条，含手机远控 CPG01）通过，证据目录 `packages/desktop/.e2e-artifacts/composer-regression/`。
- 测试夹具修正：团队行的分组 key 是完整连接身份，`selectRegistryProviderModelById` 的默认 `registry-provider:<id>` 找不到它。CTP-22 团队→个人在修复前就在准备阶段失败，现在传入 `TEAM_PLAN_GROUP_KEY`，与 CTP-32 共用。
- 既有失败（修复前后失败特征相同，与本次修改无关，未处理）：
  - CTP-20：个人→团队时有一帧（约 10ms）档位列表为空，第 800 行的全程采样断言失败。
  - CTP-30：本机中文界面个人行显示“个人”，用例写死 `aria-label="BigModel Individual"`。
  - 基线证据目录：`packages/desktop/.e2e-artifacts/ctp20-30-base/`。
- SSH 远程工作区：由 RPR-01 覆盖（[case 目录](../conversation-session-case-catalog.md)「远端 Composer 切回已生效套餐连接」）。本机 Docker 远端 runner 里，套餐 mock 只监听宿主 `127.0.0.1`，转发给远端的地址在容器内指向容器自身；用例用 SSH 反向隧道在容器内监听同一端口，并在容器 `/etc/environment` 补 `BIGMODEL_API_BASE_URL`，远端才能拿到套餐权益。修复前失败，修复后连续 2 次通过，快速路径和“远端未同步时回退原流程”都已实际运行。

CTP-33 验证记录（2026-11-05，评审 CR-01）：

- 用例用写共享设置文件来模拟另一个窗口的 Window Host。本窗口 Host 收不到设置更新事件，根 Host 账号快照仍是团队 A。这是用例的前置断言。
- 修复前红测：点团队 B 行后 99ms 内完成，无错误，设置版本不变，但根 Host 的 `connectionKey` 仍是团队 A，连接标签仍是 Team Org。手动 refresh 后才变为团队 B。证据目录：`packages/desktop/.e2e-artifacts/cr01-probe/`、`packages/desktop/.e2e-artifacts/ctp33-red/`。
- 修复后：CTP-33、CTP-32 双向、CTP-22 双向、CTP-24、CTP-28/29/31 共 9 条通过，证据目录 `packages/desktop/.e2e-artifacts/ctp33-green/`。
- 既有失败：CTP-21 依赖前一条用例留下的草稿。单跑或接在 CTP-32 后时，起点是普通 API（`e2e-upstream`），选第二个模型不是 GLM-5.3-Flash。基线 hook 下失败特征相同（`ctp21-after32-base/`），与本次修改无关，未处理。

- CTP-24：当前选中团队订阅明确 EXPIRED 时，先调用真实 Provider 服务刷新并断言 unavailable，再验证 Composer Provider 子菜单不展示该团队，但同 Provider 下第二个有效团队仍可见，点击后完整身份更新并完成切换；未知状态由投影单测覆盖并保留。设置页不隐藏详情。macOS Electron 隔离 mock、1100px/390px、Zai Light/Zai Dark 已通过；手机真实远控和 Windows/Linux 真机未验证。

- CTP-25：无 OAuth 登录、已有 API Provider 时，能选择 API 模型，不显示团队登录错误；覆盖宽/窄屏与深/浅主题。
- CTP-26：无 OAuth 登录、无配置 Provider 时，点击模型按钮直接进入 Provider 设置，不展开空菜单；覆盖宽/窄屏与深/浅主题。

### 连接边界回归（2026-10-12）

- CTP-30：供应商列表宽/窄屏 × Zai Light/Zai Dark，个人→团队→个人期间连续采样，列表 `scrollWidth <= clientWidth`；列表溢出高度时仍可纵向滚动。测试以一行的实测高度约束列表，先确认至少两条候选，避免固定 96px 在精简目录下不产生溢出。macOS Electron 1100px/390px × 两主题通过，94 次列表尺寸采样最大横向溢出为 0；原代码红测复现 clientWidth=186px、scrollWidth=190px。证据目录 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-085803-464/`。窄屏属于 Electron 响应式验证，真实手机远控及 Windows/Linux 未验证。

- CTP-27：已登录并显示团队目录，先缓存团队用量；同一已挂载 Composer 中设置 user=null，并暂停 Provider 刷新与旧凭据恢复回执；立即隐藏旧组织与额度，解除屏障后完成真实 Host 登出，仍不恢复旧身份；宽/窄屏、深/浅主题均不显示旧组织行，API 模型仍可用。
- CTP-28：连接读取后、CAS 提交前执行另一真实设置写入；显示失败并解除锁，保留另一 family，重新选择成功。
- CTP-31：注入测试服务端口并完成草稿重渲染后，通过真实菜单重新选择起点团队，确认 Provider 和档位均已就绪，再开启故障；同一团队 Provider 和模型的连接切换，旧 ready 已显示；目标事件触发的带输入读取失败，但独立同步读取成功，且失败后不再发事件；错误可见，操作解除锁，恢复服务只关闭故障开关，保持同一 service/input/Composer，不补发事件、不编辑草稿；重新选择当前连接成功。
- CTP-29：连接同步后展示 owner 返回同 revision 的 ready，但指向另一有效 Provider/模型；显示失败并解除锁，恢复解析后重新选择成功。

CTP-27：macOS Electron 隔离回放，1100px/390px × Zai Light/Zai Dark 全部通过；证据目录 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012072737490-p73602-81686d33d6b37893/`。实际执行登出并观察同一已挂载 Composer，不用重启替代鉴权边界验证。

CTP-28/29、CTP-20 与 CTP-22 双向切换共 5 条全部通过；证据目录 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012075432860-p70907-5e99b6277afac91e/`。运行时记录确认 CAS 携带操作版本，冲突保留另一 family；ready 不匹配与同步目标处于同一 revision，失败后允许重选当前连接。真实手机远控、Windows/Linux 真机和生产账号未验证。

CTP-25/26：macOS Electron 隔离回放，1100px/390px × Zai Light/Zai Dark 全部通过；证据目录 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-053547-130/`。CTP-24 已同步回归通过。窄屏验证属于 Electron 响应式布局，真实手机远控及 Windows/Linux 未验证。

MR 评审修复验证：增加设置 owner 强制版本 CAS、OAuth/设置页/Host provisioning 写入与回滚、同身份新版本回滚保护、团队用量鉴权隔离和迟到响应单测。受影响范围 1,017 个 Vitest 文件、10,238 条通过、1 条跳过；独立执行器 1 条及 Node 测试 34 条通过。额外筛选的 CTP-02B 中英文侧栏标签用例在原提交与修复版本均失败，未扩入侧栏需求；不将其报告为通过。

本轮 MR 修复版本 Electron：CTP-02/27/28/29 共 4 条通过，证据目录 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012110143641-p43000-56076160c711037a/`。CTP-27 覆盖 1100px/390px × 两主题，在 Provider 刷新屏障内验证 user=null、团队用量来源为空；CTP-29 使用另一有效选择保证 mismatch，重开菜单可见失败并允许重试。窄屏不代表手机远控实机；Windows/Linux 与生产账号未验证。

展示失败回执修复验证：真实 React hook 组合先红后绿；4 个相关文件 69 条通过，受影响 419 个 Vitest 文件 4,724 条通过，独立执行器 1 条及 Node 测试 34 条通过。CTP-27/28/29 回放通过（产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012112541998-p18419-47fd77bb465fa512/`）；CTP-31 先在未修复构建记录目标事件 → 展示失败 → 独立同步成功且无错误提示，修复后 1 条通过（产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012113004465-p28653-e3243aa5c1a3a4e4/`），正常菜单重试成功。两团队使用相同 Provider/模型；失败后不补发目录事件。case 目录整文件存在基线格式问题，只追加相关记录，不重排其它用例。

无事件重试修复验证：真实 hook 与 Electron 均先复现同连接重试仍失败，再验证显式展示重读。最终受影响 410 个 Vitest 文件、4,664 条通过，独立执行器 1 条与 Node 34 条通过。CTP-27/28/29/31 共 4 条通过（产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012115220815-p78332-f37cd2f0c72393f8/`）；`connection-retry-no-event.json` 记录恢复后没有 target-event，presentation-recovered 的 revision 仍为 2。恢复期间保持同一 service/input/Composer，不编辑草稿；正常菜单重试当前连接成功。类型、架构、lint、修改文件格式与 diff 检查通过。

CTP-31 的 revision 断言对齐本次 target-synchronized 的实际值，不固定为历史回放中的 2；冷启动目录刷新次数可以变化。

CTP-31 补充旧展示 Promise 消费者回归：恢复后显式读取 A 挂起，同一 owner 的目录事件触发 B 成功，再拒绝 A；连接保持成功，无错误且解除 pending。当前读取失败分支仍按原步骤验证。OAuth 轮询/深链使用真实 SettingService CAS 联合回归验证成功收尾；Electron 继续验证真实认证失败提示。

本轮 review 修复证据：联合 hook 回归先红后绿；真实 SettingService CAS 轮询/深链 4 条通过；受影响 414 个 Vitest 文件 4,698 条、独立执行器 1 条及 Node 测试 35 条通过。CTP-31 Electron 回放通过，记录 target-synchronized → presentation-failed → fault-recovered → obsolete-started → presentation-recovered(revision=2) → obsolete-failed，最后无错误且 pending 解除。产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012133022821-p39573-b5f6819a454bc7fb/`。真实生产账号、手机远控和 Windows/Linux 未在本轮验证。

OAuth 失败反例的 Electron 前置：隔离 profile 若进入职业引导，先按产品 Escape 退出再寻找登录入口；仅调整测试初始化，不修改登录产品行为。

AUTH-05 的启动记录确认假 JWT 触发过期确认层，阻挡登录入口；该匿名回调失败用例使用空账号凭据夹具，避免向真实控制面发送测试 JWT。

AUTH-05 匿名夹具修复后 Electron 通过（产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012134331515-p59485-f6e61f7e604f8568/`）：真实 Host 拒绝无效回调，UI 展示错误，取消后恢复渠道列表。

OAuth 初始化冲突回归加强：polling/deep-link 的真实 SettingService 测试不再故意失败 Provider 刷新；提供可用个人套餐及正常权益/团队目录响应，断言仅一次初始化提交尝试、团队身份与并发写入版本不变、设置快照/Provider 刷新与成功标记完成。AUTH-05 在失败取消反例后追加成功 session 的 CAS 冲突回放，认证结果为合成夹具，设置提交仍经真实 Electron RPC/SettingService 锁内 CAS。

AUTH-05 加强回归 Electron 通过（产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261012144218138-p47669-8fbdc8dc0a4bea3e/`）：`oauth-cas-success.json` 记录一次初始化写入尝试、并发团队选择及版本保持、只读 Provider 刷新和登录成功。定向单测 18 条通过；旧实现对应 3 条失败，确认覆盖正常查询下的二次自动覆盖路径。

2026-10-15 夹具维护：CTP-26 临时禁用普通 Provider 时保留并原样恢复 `personalConfig`。保存接口替换完整 Overlay，不能以 `{}` 切换 enabled，否则会清空 API 配置并污染后续 CTP-27/CTP-22。
