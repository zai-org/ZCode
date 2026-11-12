# Desktop Auth/Config E2E Cases

MR 凭据修复回归：`auth-config/credentials/manual-review/pending/system-credential-owner.test.ts` 增加 800,000
字符经真实 Main/Host 往返，以及超出 UTF-8 明文边界后的正常读写断言。CLI 凭据回归
覆盖非法回复终态、迁移文件锁释放、历史空白密钥和无系统库的受管文件密钥。
候选状态保持 pending；Main/Host 大凭据回归通过
`desktop-e2e-20261029094653472-p31715-1d752244e7d33e0f`（1/1），OAuth 回归通过
`desktop-e2e-20261029094746951-p32839-f9a1b825dbb061ef`（7/7）。

## AUTH-07 补充：关联凭据日志隔离

分区登录接入前，复用 `oauth-completion-race.test.ts` 的取消中完成兑换场景：
HTTP fixture 返回合成的 ZCode、Z.ai、BigModel token 及未知扩展字段；真实 Host
解析回包并结束取消流程后检查 Host 汇入的桌面运行日志。日志必须保留 token 响应结果摘要，
但不能包含 BigModel token 或未知扩展中的合成 Secret。这验证日志输出边界，
不代表中国区完整登录、真实套餐访问或存量账号兼容已验证。

状态：2026-10-28 已通过，沿用已有 AUTH-07 的完成竞态断言。运行产物：
`packages/desktop/.e2e-artifacts/desktop-e2e-20261028112642952-p8066-e8fc4f692946a5ae`。
修改前的新日志断言已复现失败，修改后连同原取消、双路径完成及迟到归因断言一起通过。

fixture 同时覆盖换证 URL 和 `ZAI_BUSINESS_BASE_URL`，确保登录完成后自动发起的
套餐请求也进入本地 HTTP fixture，不把合成凭据发往真实业务服务。

原子会话接入增加以下验收（2026-10-28 macOS Electron 已通过）：

- 浏览器兑换慢成功、后到轮询快失败：失败候选必须等待同一 flow 中仍在途的兑换，不能提前清除登录；最终使用兑换结果完成一次登录。此条经真实 Renderer→Host RPC 固定时序，前两条登录场景经正常 UI。
- 监视真实凭据文件替换，新登录 token、用户资料、共享 JWT 与 active provider 同时存在。
- Renderer 经真实 RPC 调用 Host 私有 `loadMany` 必须被拒绝。
- 用户取消后才返回的兑换 500 不展示旧失败，不改写保留的登录。
- CLI 定向测试检查整组 CAS 冲突、同值重登 revision、闲置坏凭据隔离及跨渠道清理。

运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261028115607624-p64138-6966f329ab2a859e`。
三份规格共五个场景通过，另含损坏凭据恢复、共享 JWT 401 退出。CLI adapters 25 项、bootstrap 9 项通过；类型、Lint、架构检查通过。未据此声称 Windows/Linux、手机或中国区真实套餐已验证。

## 分区登录入口与存储验证

扩展既有 OAuth race HTTP fixture，不连接真实业务域：

- 正常登录界面切换国内/全球，捕获 init 请求分别为 `zai_cn`/`zai`；中国区保留授权站、state、client ID，只将回调改为当前环境的官网中转页并带 `provider=zai_cn`，复制链接与浏览器打开地址一致；两次取消均不写登录态。
- 真实 Host polling 接收中国区 ready，原子保存中国区 OAuth 和 ZCode JWT、不同 ID 的关联 BigModel；全程不调用全球区业务换证接口。
- 关联 Secret 不出现在日志，旧全球区会话字段被清理；保留旧登录协议的既有场景。
- 中国区上游短期 token 已过期，但 ZCode JWT 仍有效时正常恢复；profile 401 或返回另一用户 ID 时保留原会话；关联密文损坏只清理关联。Renderer 不能直接读取关联私有键。

`v3.18.0` hotfix 回归补充：在上述中国区场景中先投递官网 deep link，确认带归因和不带归因的授权码都不触发客户端兑换；随后释放 polling，验证主会话和关联材料落盘。polling 完成后再投递回调只更新归因，取消后的迟到回调必须拒绝。

2026-11-11 macOS Electron：`auth-config/login/oauth-completion-race.test.ts` 12/12 通过，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261110-162553-457`（目录时间为 UTC）。修复前同一中转断言已在 `desktop-e2e-20261110-162344-980` 失败：实际回调仍指向 fixture 的服务端地址。该回归使用真实 Main/Host/RPC 和合成 OAuth 服务，不代表真实上游授权、Windows/Linux 或手机 Web 已完成验收。

2026-10-28 macOS Electron：三份规格共七个场景通过；最新构建来源的 WelcomeScreen sourcemap 与当前源文件一致。产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261028120903566-p6156-0de5353fd4d28b7b`。
CLI adapters 27 项、bootstrap 9 项通过。该证据不包含真实套餐调用、MCP、手机和混版本远端；完整接入仍在实施。

## Todo103 G09：固定 staging 登录行为整合验收

本节是整合验收范围，不覆盖或改写下文历史运行记录。

| Case    | 来源与操作                                                                           | 验收与限制                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-05 | d17cb6a800；正式 oauth-login-failure-cancel.test.ts，通过 preload 回调投递无效 state | 真实 Host 拒绝回调后 UI 仅展示失败块；取消后回到渠道列表，登录入口不关闭。保留上游正式用例身份，不是本轮擅自晋级                                                        |
| AUTH-06 | a172e9c398 / 71a195b6be / f26d4e75fb；pending access-token-401-auto-logout.test.ts   | case-local HTTP 暂停真实 Host userinfo，再返回 401；清理当前 OAuth、保留 Bot 凭据、只展示一次过期提示；确认发出既有 RelaunchApp。IPC 截断实际重启，不冒充真实重启已验证 |

两条用例都不产生模型请求，manifest 明确 providerRequestPolicy=none。AUTH-06 的
业务 token/JWT 是值不同的合成凭据，其它控制面 HTTP 200，避免原 JWT 失效路径掩盖
新增 access token 分类。mock 仅统计是否命中合成 token，不在产物输出凭据。
服务层受控时序测试负责迟到 401、刷新写回、重复候选和 accountIdentity 保护；
Electron 用例不声称覆盖这些微观竞态。AUTH-06 保持 pending，Pro 本地验证不等于
手机 shared-host / Windows 全端验证；没有新增 Host 或修改 continuous/replayable 链路。

上游 AUTH-06 运行记录将作为固定 staging 历史证据保留，不计作本分支运行通过；
本轮实际结果记录在 Todo103 账本 G09。

本文记录桌面端 auth/config 相关正式 E2E case。范围只包含 desktop local 冷启动、OAuth 登录态恢复和本地配置清理；不覆盖手机 `/remote`、remote workspace、replayable 恢复或真实 OAuth 浏览器回调。

每条 case 必须满足：

- 有独立 setup、action、assert，不能只因为启动路径经过登录页就算覆盖。
- 如果不触发模型请求，manifest 必须显式声明 `providerRequestPolicy: "none"`。
- 如果通过 WDIO seed 写入本地配置，文档必须写明 seed 文件和需要验证的清理边界。

## 默认启动凭据合同

普通、本地 Personal Provider、远程回放以及未知 spec 默认向隔离 HOME 的
`~/.zcode/v2/credentials.json` 写入空对象。未提供 spec、空列表或套件 glob 也不能
隐式恢复假 OAuth / JWT；新增普通用例不需要再登记“无账号例外”。

```text
worker 的具体 spec -> 现有账号 mock 选择 -> 冷启动 seed -> Electron / Host
                           |
                           +-- 未选择账号 mock：空凭据
                           +-- Coding Plan 专项：仅对应账号族的合成 OAuth
                           +-- JWT 专项：保留该专项声明的合成 JWT
```

账号 mock 是否启用由现有 WDIO fixture 选择结果传入凭据生成器，不再维护一份
普通用例排除名单。BigModel 专项只播种 BigModel OAuth，不夹带 Z.AI 假身份。
JWT 仍按现有明确专项保留，不因为存在账号 mock 就默认注入。远程回放始终无账号启动，
真实账号导入、损坏密文和过期 JWT 专项继续使用各自的显式 setup。

回归要求：单测覆盖默认空凭据、Windows / POSIX 路径、显式账号 fixture、JWT 专项、
远程优先级及输入不变性；Browser E2E 检查普通启动没有账号键，Coding Plan E2E 检查
只有对应账号族，再执行原有真实 UI 操作。不得用屏蔽登录失效弹窗或放宽断言替代隔离。

## AUTH-01: 损坏 OAuth 凭据冷启动恢复

确认恢复容器专项使用隔离 HOME 与合成数据：取消后原始字节不变；备份失败保留原件并显示失败；成功后备份与原件逐字一致、库可读写并可重新登录；正常库/缺失文件/单条坏密文/权限错误不得当作容器损坏清空；旧确认和恢复期间的迟到读写不得覆盖新库，重复点击只执行一次。桌面双主题、中英文及手机尺寸的同一组件须可操作，并明确手机配对前无法修复桌面库。真实用户凭据不参与测试。

本轮评审回归要求：正常凭据读取不取得写锁，保留读取前后代次校验；确认恢复仍在写锁内，先核验完整备份，再推进代次并原子替换。恢复推进代次后、替换前的损坏原件仍必须解析失败，不能读为有效登录。确定性备份名已有不同字节时，保留旧备份并另建独立、核验通过的完整备份。恢复入口只允许 Desktop；手机 UI 不检查或展示本机恢复入口，手机 RPC 拒绝 inspectStore/recoverStore，普通 load/save/delete 保持原有语义。390px 桌面窗口仍可确认恢复。

新增恢复代次回归：Z.ai/BigModel 的 API Key 登录分别在凭据锁和配置锁等待期间恢复，旧调用返回 `ZCODE_CREDENTIAL_STORE_CHANGED`，默认配置与新空库不变，新登录仍成功；条件保存/条件删除在实际文件锁等待期间恢复，旧调用失败且不发变更通知，新调用保持“无则保存/相等才删除”语义。CLI 使用独立 auth-login 回归；条件写入使用恢复 E2E 中的独立实际文件 IO 夹具，未运行前不计覆盖。

本机恢复权限回归：`server-websocket.ts` 对 Web Server（有/无连接令牌）及 Source Server Core 分别建立真实 `/ws`，再由同一普通身份领取 capability 建立 `/ws/host`；伪造模式、领票、票据重放均不得取得整库检查/恢复能力。兼容远端 stdio、手机和远端/source-settings attachment 同样拒绝，原始字节、备份集合与恢复代次不变，普通 CRUD 保留。只有本机桌面 local MessagePort attachment 允许恢复，完整 App 的原生确认路径另行验证。覆盖源码与完整 Server release 的实际 Core 进程；未运行前不计覆盖。上一轮 3.17.118 的“受信 Desktop”正向结论已被新授权链检查推翻，不能用作网络恢复权限成立的证据。

2026-11-02 Core 权限增量验收：旧实现真实 Core WebSocket 回归失败（检查/恢复均意外成功）；共用权限函数后两种发布入口均拒绝普通客户端，普通读写、受信 Desktop 检查/完整备份/恢复通过。源码桌面单次 9/9（artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20261102054127242-p21052-0bbe7b26de4013af`）。完整 macOS arm64 Server release 的包内 Node 与实际 Core entry 同项通过；测试仅在临时 HOME 初始化安装身份，没有安装系统服务。完整签名 App 3.17.118 实际 Desktop + 包内 CLI 两渠道 × init/poll/material/config-lock 共 8/8，恢复后旧登录均失败且空库/默认配置保留，新登录成功。两个完整压缩包均与运行文件逐字核对；未公证，Windows/Linux、实体手机、生产账号和真实 SSH 部署仍未验收。

2026-11-02 恢复代次增量验收：CLI 29/29（包含两种账号 × 凭据锁/配置锁的 4 个新增 API Key 用例）；当前恢复专项源码 Electron 9/9，产物 `packages/desktop/.e2e-artifacts/desktop-e2e-20261102045424245-p5221-364c55bcf4c46e49`。完整 Developer ID 签名包 3.17.117 的包内 bootstrap/真实 Host RPC 增量场景 6/6、既有 OAuth 暂停/恢复场景 8/8；ZIP 与运行的 App/Agent 字节一致。增量凭据锁场景在隔离文件锁内推进恢复代次并替换空库，配置锁场景通过真实桌面确认恢复；未使用真实账号、未公证，不代表 Windows/Linux/实体手机验收。语言视觉夹具使用实际 Intl 切换入口更新本地偏好与持久化设置，不能只手改 setting.json 后假设浏览器偏好也改变。

恢复专项保留为 [auth-config/credentials/manual-review/pending/credential-store-recovery.test.ts](../../packages/desktop/test/e2e/auth-config/credentials/manual-review/pending/credential-store-recovery.test.ts)，当前包含 **10 个 case**：7 个桌面恢复与交互场景、1 个条件写入/删除代次场景、1 个网络入口与本机权限边界场景、1 个旧纯归因回调代次场景（两个账号族的实际服务与文件 IO）。2026-11-02 完整单次 **10/10** 已通过（artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20261102071941569-p25646-202a4d1453c803dd`）；下述单次 9/9 为新增前的历史运行。2026-11-02 完整单次运行 **9/9** 通过，证据为 `packages/desktop/.e2e-artifacts/desktop-e2e-20261102060826266-p40462-134332e03a98a116`；其中网络 case 覆盖 9 组入口与 attachment 配置，不是 9 个独立 case。

与单入口登录、系统安全存储集成后（2026-11-05）：重新登录与旧 OAuth 响应两例在登录前显式选全球区，使夹具的 hold-poll / enable-poll 作用于 zai 流程（国内 zai_cn 只受 cn-ready 控制）；重新登录以主 JWT 写入为准。双 Host 重复确认例按解密值断言，合成明文会被迁移为密文。replay 模式单次 **10/10** 通过（artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20261105121500371-p26803-4a3b2bc9274a2b3d`），运行日志确认旧 zai 轮询结果在另一 Host 恢复后以 `ZCODE_CREDENTIAL_STORE_CHANGED` 被拒绝。仍为 pending，未人工转正。

以下为 2026-10-29 的历史分组证据，只覆盖当时的 8 个 case，不代表当前专项总数，也不覆盖后来新增的条件写入/删除代次及完整网络提权边界：

- 既有源码 Electron 场景 **7/7** 通过，证据为 `packages/desktop/.e2e-artifacts/desktop-e2e-20261029-082358-487`，包含已有不完整备份保留与独立完整备份恢复。
- 新增 Web Server 场景 **1/1** 通过，证据为 `packages/desktop/.e2e-artifacts/desktop-e2e-20261029-085713-935`。实际 HTTP/WS 普通客户端调用 inspectStore/recoverStore 均返回 `feature_disabled`，损坏原件不变，普通 load/save/delete 仍成功；断言结果保存在该目录的 `server-credential-rpc-denied.json`。此次仅筛选运行新增项，未重新整组运行，不记为单次 8/8。

独立手机路径：390×844 浏览器通过实际手机 attachment 拒绝 inspectStore/recoverStore，并验证桌面恢复后重新连接，证据为 `packages/desktop/.e2e-artifacts/desktop-e2e-20261029-082549-046`（非物理手机）。独立完整签名包 3.16.100 已验证取消、不完整备份恢复、空库和登录入口；后续 3.16.103 对齐严格 UTF-8 的 CLI 后重新验证相同原生恢复流程。源码测试桥未包含在正式包内；Server 场景使用独立 HTTP/WS 进程，不宣称包含于桌面正式包。专项尚未转正或完成跨平台 CI 准入。

补充回归：凭据库整体为非法 JSON 或值类型不符时，真实 Host 的账号状态读取失败，登录页仍显示 Z.ai 和 BigModel 渠道。原始文件必须逐字保留；不能假装已登录，也不因渠道读取失败自动恢复或重建整库。显式恢复仍走上面的用户确认流程，与单条密文损坏的清理合同分开验收。

2026-11-02 staging 组合验收：保留凭据恢复夹具的 hold/enable 控制和时钟回拨、前拨、过期 init 三类行为，真实 HTTP 检查 7/7；CLI 定向回归 25/25。合入后的完整签名 macOS 包 3.17.114 使用真实 Desktop 与包内 CLI，通过两渠道 × init/poll/material/config-lock 共 8 个场景：恢复后旧登录均失败且不改写空库及默认配置，新登录均可完成。使用合成账号；不替代 Windows/Linux、实体手机或生产 OAuth 验收。

### Case 定义

| 字段             | 内容                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/auth-config/credentials/oauth-credential-recovery.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/oauth-credential-recovery.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                                   |
| 当前状态         | 已转正，正式路径 cold-start case                                                      |

### 测试场景

用户本地 `credentials.json` 中残留 OAuth 登录态，但其中 `oauth:active_provider` 是当前机器无法解密的密文。桌面端冷启动时，OAuth session restore 不能让登录入口进入“加载失败 / 没有登录渠道”的死态；系统应清理损坏登录态，并重新展示可登录渠道。

这条 case 只验证“损坏 OAuth 凭据 -> 冷启动恢复 -> 登录渠道可见 -> 损坏登录态清理”。它不覆盖真实网页登录、OAuth callback、token refresh、购买链路、remote workspace 或模型发送。

业务 token 损坏回归（2026-10-12）：通过 `ZCODE_E2E_CORRUPT_OAUTH_TOKEN_PROVIDER=bigmodel` 或 `zai` 运行同一 AUTH-01，seed 保持 active provider、用户资料和共享 JWT 正常，仅业务 access token 为无法解密的密文。验证登录渠道可见、全部 OAuth 凭据清理、独立 Bot 凭据保留。默认运行仍覆盖 active provider 损坏；恢复与新登录交错、普通 IO 异常及请求取消由服务层受控测试覆盖。

限制：AUTH-01 当前只覆盖 desktop local host；remote workspace 与手机 `/remote` 的 OAuth 损坏恢复已由 service 级回归测试保护，正式 remote E2E case 待后续补充。

### 操作步骤

1. WDIO `beforeSession` 清理隔离 HOME。
2. `wdio.conf.ts` 识别 `oauth-credential-recovery.test.ts` 后，在 `~/.zcode/v2/credentials.json` 写入损坏 OAuth seed。
3. 启动桌面端本地默认窗口。
4. 等待登录入口渲染。
5. 检查 Z.ai 与 BigModel 登录渠道均可见。
6. 检查没有展示 OAuth 错误提示。
7. 读取隔离 HOME 下 `credentials.json`，确认损坏 OAuth 登录态已清理。

### 验证条目

| 编号      | 验证项                    | 有效性说明                                                      | 当前断言位置                                                |
| --------- | ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| AUTH-01-A | Z.ai 登录入口可见         | 证明 `oauthService.getProviders()` 没有因损坏凭据导致入口不可用 | `waitForTestIdByDom(testId(TID_OAUTH_LOGIN_BUTTON, "zai"))` |
| AUTH-01-B | BigModel 登录入口可见     | 证明多 provider 登录渠道仍能完整展示                            | `waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON)`                |
| AUTH-01-C | 登录页没有 OAuth 错误提示 | 证明损坏凭据被当作可恢复登录态处理，不向用户暴露底层解密错误    | `expectNoOAuthErrorAlert()`                                 |
| AUTH-01-D | OAuth 相关损坏凭据被清理  | 证明下次启动不会继续卡在同一份无效登录态                        | `waitForCorruptOAuthCredentialsCleanup()`                   |

### Fixture 合同

- 本 case 不触发 provider 请求，manifest 使用 `providerRequestPolicy: "none"` 和空 `requests`。
- 本 case 的输入 fixture 是 WDIO 冷启动 seed：`~/.zcode/v2/credentials.json`。
- 需要清理的 key 包含 `oauth:active_provider`、Z.ai/BigModel access token、refresh token、user info，以及旧 `zcodejwttoken`。

### 转正说明

该 spec 已位于正式路径 `packages/desktop/test/e2e/auth-config/credentials/oauth-credential-recovery.test.ts`，会被默认 `./test/e2e/**/*.test.ts` 收集，不在 `manual-review/pending` 下。因此不执行 `promote-conversation-e2e.mjs` 的移动流程；本次转正补齐正式 manifest 与 auth/config 覆盖文档。

### 实际验证结论

2026-07-09 已执行：

- `pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/auth-config/credentials/oauth-credential-recovery.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260709-042306-597/summary.md`。
  - 结论：冷启动遇到无法解密的 OAuth 凭据时，Z.ai 与 BigModel 登录渠道均可见，页面没有 OAuth 错误提示，损坏登录态被清理。

Docker 准入暂不执行：该 case 不依赖 provider replay，也不属于 conversation Docker preset。

### 业务 token 损坏修复验证（2026-10-12）

- BigModel/ZAI 单个业务 token 损坏和默认 active provider 损坏均通过隔离 macOS Electron AUTH-01，OAuth 清理后登录渠道可用，独立 Bot 凭据保留。ZAI 初次运行停在启动页；运行时 RPC 日志与刷新链路定位到后台仓储清理回调等待 Account Source 自己的下一轮刷新，修正该循环等待后重新构建通过。
- 260 项 services 定向单测、18 项登录恢复/onboarding 单测通过；覆盖两平台业务/共享 token 损坏、普通 IO 错误、旧恢复与新登录交错、核验 fetch/正文取消、原请求超时、观察预算和共享订阅取消。
- AUTH-06 使用同一最终构建验证失效清理、单次提示、确认后进入登录入口且无重启命令，通过。类型检查、E2E 类型检查、lint 和 architecture 检查通过；lint 保留基线 warnings。
- 没有运行手机 shared-host、远程 workspace、Windows/Linux 或真实后端撤销回归；认证 owner 与 desktop-continuous / web-remote-replayable 协议未改变。

## AUTH-02: Provider readiness 门禁与恢复

### Case 定义

| 字段             | 内容                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/workspace/runtime/provider-readiness-agent-startup.test.ts`       |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/provider-readiness-agent-startup.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                                          |
| 当前状态         | 已转正，正式路径 cold-start case                                                             |

### 测试场景

desktop local 使用隔离 HOME 冷启动；CLI session DB 与 App tasks-index 预置同一条 interactive 历史，但用户没有 OAuth 登录态、API Key 或其它结构可用 provider。登录入口完成渲染后，用户暂时跳过并进入默认 workspace；侧栏必须展示 tasks-index 中的历史；只读订阅按需启动唯一会话 Agent，点击后能读取 CLI 中已持久化正文，同时首页继续展示 `modelConfigMissing` banner。用户通过同一项目入口返回草稿并输入文本；缺模型时发送按钮禁用，原文保留且 pending command 为空。随后从缺模型横幅进入设置，通过 BigModel Template 创建具有独立 ID 的 Personal Provider，并在 API Key 输入框失焦后确认保存；同一 workspace 必须复用该 Agent、保持数量为 1，完成草稿模型水合、清除 banner，并在保留原文的同时恢复发送按钮可用。测试不点击已恢复的发送按钮。

本 case 只验证本地结构 readiness、进程启动边界和草稿水合，不发送 prompt、不联网验证 provider 连通性，也不覆盖插件/MCP management Agent。remote workspace 使用 service/integration case 验证 desktop registry 下发前后边界。

### 验证条目

| 编号      | 验证项                                          | 有效性说明                                                                                                                                                        |
| --------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-02-A | 未配置时登录/provider 入口可用                  | `waitForTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON)`                                                                                                                |
| AUTH-02-B | 跳过后草稿首页展示缺模型 banner                 | `TID_CHAT_ERROR_BANNER` 回显“当前没有可用模型”                                                                                                                    |
| AUTH-02-C | 未配置时发送按钮被 UI admission 禁用            | 输入文本后按钮仍禁用，composer 原文保留，pending command ledger 为空                                                                                              |
| AUTH-02-D | 未配置时历史可见且可读                          | 预置 interactive CLI session 的侧栏 row、用户正文与助手正文均可见，证明真实 sessions-index/conversation topic 已工作                                              |
| AUTH-02-E | 未配置时没有 deferred draft/retry               | service/UI focused tests 断言 `provider_not_ready` 保持 idle 且投影 banner                                                                                        |
| AUTH-02-F | 未配置时目标 workspace 只读 Agent 数为 1        | 资源管理器快照按 `ZCodeProject` workspace tag 断言为 1；系统 conversation sibling 不计入，只允许 sessions-index/history 读取，不产生 session create/model command |
| AUTH-02-G | 保存 provider 后仍复用目标 workspace 唯一 Agent | 资源管理器对同一 workspace 的 Agent 行数保持 1，稳定窗口后二次断言仍为 1，read→write 不重复启动                                                                   |
| AUTH-02-H | 配置后模型水合、草稿保留且恢复可发送            | 模型 trigger 指向新 Personal Provider 实例及非空模型；banner 消失，原文保留，发送按钮启用                                                                         |

### Fixture 合同

- manifest 使用 `providerRequestPolicy: "none"` 和空 `requests`；整个 case 不产生模型请求。
- 输入 fixture 同时预置 Agent CLI SQLite 的 interactive session/message/part 与 App `tasks-index` membership；侧栏 row 由 tasks-index 提供，正文必须通过真实只读 conversation 订阅读取。其余输入是隔离 HOME 的空 auth/provider 状态，以及测试过程中通过 Template 创建并保存的本地 Personal Provider 配置。
- 进程断言读取资源管理器与主进程 lifecycle registry 同源的进程快照，不使用只适配单一操作系统的 `pgrep`/`ps` 断言。

### 实际验证结论

2026-10-16 修复后复跑：1 个 spec / 1 个 case passed。Artifact：
`packages/desktop/.e2e-artifacts/desktop-e2e-20261016040830885-p3810818-9b9ec2468aec7c23/summary.md`。
新增断言确认首个 Provider 就绪后保留原文、发送按钮启用、pending command 仍为空，
同一 workspace Agent 保持 1 个；模型控件通过共享解码函数校验 Personal 实例身份。
共享 Hook 单测覆盖本地/远端 identity；未执行真实手机配对 E2E。

2026-07-20 已执行：

- `pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/workspace/runtime/provider-readiness-agent-startup.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260720121301941-p51454-824198917812e029/summary.md`。
  - Provider capture：`upstream-provider.json` 的 `records` 为空，符合 `providerRequestPolicy: "none"`。
  - 结论：空 provider 冷启动时真实历史可见、可点开读取，新草稿首发仍被门禁拒绝；保存 provider 后复用同一目标 workspace Agent 并完成模型水合。

Docker 准入不执行：该 auth/config case 不依赖 provider replay，也不属于 conversation Docker preset。

## AUTH-03: ZCode JWT 过期后重新认证

2026-10-12 隔离 Electron 自动复测：1 case passed；artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20261012-113824-131/summary.md`。确认本轮运行时恢复入口变更没有破坏冷启动过期清理和登录入口；仍保留 pending。

### Case 定义

| 字段             | 内容                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/auth-config/session/jwt-expiry-reauthentication.test.ts`     |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/jwt-expiry-reauthentication.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                                     |
| 当前状态         | 候选 case，等待人工确认过期提示与重新登录入口后转正                                     |

### 测试场景

desktop local 使用隔离 HOME 冷启动；`credentials.json` 预置一份完整 Z.ai OAuth 缓存会话，以及一枚 `exp` 明确早于当前时间的 `zcodejwttoken`。Local Host 恢复缓存会话时必须先清理失效认证事实，再通知 renderer 显示“登录已过期”提示；用户点击“重新登录”后直接进入现有 Welcome 登录页，不经过主动退出确认或 App relaunch。

本 case 只验证 desktop local 的冷启动恢复和 UI 交互，不触发真实 OAuth callback、token refresh、provider/model 请求，也不修改 remote workspace、手机 `/remote` 或 task/session realtime 状态。

### 状态与操作时序

```text
WDIO 冷启动 seed
  完整 OAuth 缓存 + 已过期 JWT
             |
             v
Local Host restoreCachedSessionState
             |
             +--> 先清理 active provider / token / user_info / JWT
             |
             v
renderer 显示“登录已过期” AlertDialog
             |
             +--> 弹窗仍打开时读取 credentials.json，确认清理完成
             |
             v
用户点击“重新登录”
             |
             v
Welcome 展示 Z.ai + BigModel 登录入口
```

### 验证条目

| 编号      | 验证项                        | 有效性说明                                                               |
| --------- | ----------------------------- | ------------------------------------------------------------------------ |
| AUTH-03-A | 过期提示标题和说明可见        | 证明结构化 `reauthentication-required` 已传到 renderer，而非恢复伪登录态 |
| AUTH-03-B | 提示确认前认证凭据已清理      | 证明 AlertDialog 不是清理认证事实的阻塞点                                |
| AUTH-03-C | 点击“重新登录”进入 Welcome    | 证明用户能从过期态回到现有登录流程，不会停留在无法退出/无法重登的死态    |
| AUTH-03-D | Z.ai 与 BigModel 登录入口可见 | 证明重新认证页具备完整 provider 选择能力                                 |
| AUTH-03-E | 不展示主动退出确认            | 证明过期恢复没有误走“确认断开连接”或运行中会话二次确认流程               |

### Fixture 合同

- manifest 使用 `providerRequestPolicy: "none"`、`noProviderRequests: true` 和空 `requests`。
- 输入 fixture 是 WDIO 在 App 启动前写入隔离 HOME 的 `~/.zcode/v2/credentials.json`。
- JWT 只包含测试用 header/payload/signature；payload 的 `exp` 固定在过去，不依赖签名有效性。
- 需要清理的 key 包含 `oauth:active_provider`、Z.ai access token、refresh token、user info 和 `zcodejwttoken`。
- 当前位于 `manual-review/pending`；人工确认可视交互后才能移动到正式路径并更新本节状态。

### 自动运行结论

2026-08-06 已执行：

- `ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/auth-config/session/jwt-expiry-reauthentication.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260806040559238-p94707-95e800e8762670fe/summary.md`。
  - 运行时发现并修复：provider 启动门禁的 `open=false` 曾无条件清空 `session-expired`，导致用户确认后重新登录页被工作区覆盖；现在门禁只关闭自己拥有的 `startup-provider-required`。
  - Provider capture 没有模型请求，符合 `providerRequestPolicy: "none"`。

当前只完成自动运行，尚未记录人工视觉验收，因此继续保留在 `manual-review/pending`，不执行转正或 Docker 准入。

<!-- 固定 staging 的 JWT 场景原编号 AUTH-05，与上方登录取消编号冲突；此处命名为 AUTH-JWT-401，历史证据不算本轮通过。 -->

## AUTH-JWT-401: 运行中 ZCode JWT 401 退出并重启

### 2026-10-12 当前行为

共享 JWT 与业务 access_token 使用同一个过期提示入口，确认后直接进入 Welcome 登录页。用例已改为本地 HTTP fixture 暂停真实 Host 余额请求，返回 HTTP 401；不再用 main net.fetch mock 代替 Host transport。确认前清理 OAuth/JWT、保留独立 Bot 凭据，确认后断言登录入口可见、app.relaunch/quit 均未调用。

隔离 Electron 自动复测：1 case passed；artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20261012-113752-866/summary.md`。用例保留 pending；以下重启断言及运行记录是历史背景。

### Case 定义

| 字段             | 内容                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/auth-config/session/jwt-401-auto-logout.test.ts`     |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/jwt-401-auto-logout.json` |
| Provider fixture | 无，`providerRequestPolicy: "none"`                                             |
| 当前状态         | 候选 case，等待人工确认 401 触发提示、凭据清理和重启动作后转正                  |

### 测试场景

desktop local 使用隔离 HOME 冷启动并恢复一份有效 OAuth 会话。进入工作区后，测试通过 Electron 网络 mock
让后续 ZCode 控制面请求返回普通 HTTP 401；请求携带的 Authorization 与本地 `zcodejwttoken` 相同，
因此必须触发 Host 的统一 logout，而不是展示普通网络错误。测试断言凭据在提示确认前已清理，用户确认后
调用现有 `RelaunchApp`，避免真实退出测试进程。

本 case 只验证运行中 desktop local 的 401 失效观察、凭据清理、提示和重启命令；不覆盖真实 revoke、
Agent 模型 transport、Official MCP、remote workspace 或手机 `/remote`。

### 状态与操作时序

```text
有效 OAuth 会话 + zcodejwttoken
             |
             v
打开模型供应商设置，触发 ZCode 请求
             |
             v
Electron net.fetch mock 返回 401
             |
             v
Host 比对当前 JWT -> logout 清理凭据 -> 广播失效事件
             |
             v
Renderer 显示“登录已过期”
             |
             +--> 确认前：credentials.json 已无 OAuth/JWT key
             |
             v
用户确认 -> DesktopCommandIds.RelaunchApp
```

### 验证条目

| 编号           | 验证项                         | 有效性说明                                            |
| -------------- | ------------------------------ | ----------------------------------------------------- |
| AUTH-JWT-401-A | 运行中 401 能显示登录过期提示  | 证明请求出口观察和 Host 广播链路实际工作              |
| AUTH-JWT-401-B | 确认前 OAuth/JWT 凭据已清理    | 证明提示框不会阻塞认证事实清理                        |
| AUTH-JWT-401-C | 确认后调用 `RelaunchApp`       | 证明提示动作复用现有重启流程                          |
| AUTH-JWT-401-D | 普通 401 mock 不依赖专用响应头 | 证明兼容当前没有 `X-ZCode-JWT-Invalid` 响应头的服务端 |

### Fixture 合同

- manifest 使用 `providerRequestPolicy: "none"`、`noProviderRequests: true` 和空 `requests`。
- 输入 fixture 是默认 E2E 启动凭据 seed；运行中 401 由 Electron `net.fetch` mock 注入，不访问真实服务。
- mock 只返回状态和成功标志，不记录或暴露 Authorization/JWT 值。
- 当前位于 `manual-review/pending`；人工确认后再转正，不执行 Docker 准入。

## AUTH-04: 登录后 Subagent Coding Plan Model Selection 就绪

### Case 定义

| 字段             | 内容                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Spec             | `packages/desktop/test/e2e/coding-plan/account/subagent-coding-plan-login-catalog-stale.test.ts`         |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/subagent-coding-plan-login-catalog-stale.json`     |
| Provider fixture | 无模型请求；OAuth、`release/latest`、`client/configs`、套餐与 API key 接口均由 case-local HTTP mock 固定 |
| 当前状态         | 已转正，正式路径登录后 UI 可用性与当前 Environment Model Selection 就绪 case                             |

### 测试场景

desktop local 使用隔离 HOME 冷启动，OAuth 凭据为空。若职业引导覆盖应用，先通过真实 Escape 关闭，再观察 Welcome 或未登录工作区。当前 Local Host 预置带 reasoning 档位的自定义 DeepSeek 模型。用户完成 BigModel OAuth 后，不重启、不手动保存 Provider，直接打开 Subagent 设置，在同一个 `general-purpose` 行依次选择自定义模型和 Coding Plan GLM-5.3。

Settings 的模型成员和能力唯一来源是 Local Host 的 Model Selection View。E2E 只读 Subagent 行实际消费的 View props，验证登录前后模型目录和 reasoning 控件；不再读取已退出模型目录职责的 workspace `configOptions`，也不人为写入 ready。该 case 只覆盖 desktop local，手机 `/remote` 单独验证。

### 状态与操作时序

```text
隔离 HOME → 关闭职业引导 → 未登录工作区
                                  ↓
                   Subagent Local Host View 含自定义模型
                                  ↓
                       BigModel OAuth callback
                                  ↓
                 Account Overlay / Local Host View 刷新
                                  ↓
                    Subagent 选择自定义模型：effort 可用
                                  ↓
                    选择 Coding Plan GLM-5.3：effort 可用
                                  ↓
                 页面消费的 View 包含 GLM-5.3 high / max
```

### 验证条目

- 登录前自定义模型存在，Coding Plan 模型不存在。
- 真实 OAuth URL、state 与 deep link 完成登录。
- 登录后已有自定义模型保持可用，reasoning 包含 high / max。
- Coding Plan 模型和 reasoning 无需重启即可选择；页面的 Model Selection View 最终 ready 并包含同一能力。

### Fixture 合同与边界

- manifest 为 `providerRequestPolicy: "none"`，不发送模型请求；OAuth、release/latest、client/configs、套餐与凭据接口由 case-local HTTP mock 固定。
- 每次 beforeSession 按当前 worker spec 重置 mock 模式，其它 Coding Plan 用例不继承登录目录状态。
- OAuth polling 保持 pending，由 deep link 完成登录，避免混入 polling 完成语义。
- release/latest 登录前后使用不同 config_version；client/configs 按版本提供不可变目录。
- 登录后的当前内置 GLM-5.3 必须提供 high、max 档位；release payload 不再作为模型成员来源。真实 UI 与只读 View 共同证明刷新，不注入 renderer catalog。

### 自动运行记录

- `ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e:serial -- --spec ./test/e2e/manual-review/pending/subagent-coding-plan-login-catalog-stale.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed。
  - Runtime 证据：`workspace/readState` 返回 `modelCount=5`，renderer workspace catalog 包含 `builtin:bigmodel-coding-plan/GLM-5.2` 及其 reasoning 档位，Subagent effort 控件为 supported。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-070650-011/summary.md`。
  - Provider capture 没有模型请求，符合 `providerRequestPolicy: "none"`。
- 隔离回归：同一 WDIO run 中先执行 AUTH-04，再执行 `coding-plan-team-usage.test.ts`。
  - 结果：通过，2 个 spec / 19 个 case passed；后续 18 个普通 Coding Plan case 全部恢复默认 Team Plan mock 状态。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-102158-548/summary.md`。
- 转正后正式路径：`pnpm --filter @zcode/desktop test:e2e:serial -- --spec ./test/e2e/coding-plan/account/subagent-coding-plan-login-catalog-stale.test.ts`
  - 结果：通过，1 个 spec / 1 个 case passed；首次通过率 100%，无 flaky 或 infra failure。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-103737-817/summary.md`。
- Review 优化后重跑正式路径：登录前后使用不同 `config_version`，带版本目录保持不可变。
  - 结果：通过，1 个 spec / 1 个 case passed；首次通过率 100%，无 flaky 或 infra failure。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260819-114837-011/summary.md`。
- 2026-08-27 合并 `origin/staging` 并适配 Desktop OAuth polling mock 后重跑正式路径：catalog 保持 `loading` 且缺 GLM-5.2 时先验证控件 supported，再切到 `ready` 等待 runtime catalog 出现 Coding Plan `high` / `max`。
  - 结果：通过，1 个 spec / 1 个 case passed；无 provider request。
  - Artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260827-103453-349/summary.md`。

### 转正说明

该 case 已从 `manual-review/pending` 移入正式路径。它不发送模型请求，不依赖 provider replay，也不属于 conversation Docker preset；正式准入以 case manifest 的 `providerRequestPolicy: "none"`、本地正式路径运行和默认 desktop E2E 收集为边界。

<!-- 以下 AUTH-06 场景与运行记录来自固定 staging，运行编号不是 Todo103 本轮结果。 -->

## AUTH-06: 用户资料 access token HTTP/业务 401 复用退出提示

### 2026-10-12 当前行为

- 两平台通过 `ZCODE_E2E_AUTH_EXPIRY_PROVIDER=bigmodel|zai` 选择合成登录身份；HTTP `401` 或 `200` 数值业务 `401` 均复用条件退出。
- BigModel 另覆盖 `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200 ZCODE_E2E_AUTH_EXPIRY_RESPONSE_KIND=empty`：真实 Host 收到 customerInfo 零字节200后识别远端注销。
- 确认前清理当前 OAuth/JWT/profile、保留独立 Bot 凭据；过期提示只出现一次；确认按钮为“重新登录”，直接出现 Welcome 登录入口，不执行 RelaunchApp。保留原 IPC 记录以断言没有重启命令。
- 业务空响应经身份核验、正常身份不登出、ZAI 空身份响应证据不足、并发去重和旧核验不清新会话由服务层受控测试覆盖；Electron 不声称覆盖精确网络竞态。
- 以下较早记录的确认重启行为属于历史验收，不是本次行为。

CR-01 裸 token 核验回归：`ZCODE_E2E_AUTH_VALIDATION_HEADER=1` 使用有效合成 ZAI 身份，PAT 资料读取取得组织/项目，后续业务接口按 `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200|403` 返回空200或普通403。全部 customerInfo 请求（包括 PAT 资料读取及异常后的身份核验）只接受裸 token，Bearer 返回401。要求真实 Host 已发出异常业务请求及正确身份核验，启动进入工作区后 OAuth/JWT 与 Bot 凭据仍存在，UI 不显示过期提示；该场景不调用网站接口，也不产生模型请求。既有真正失效后的登录入口用例继续回归，均保持 pending。

CR-01 本地隔离 Electron 回归（2026-10-12），以下三组各 1 case passed。前两组收尾记录均为业务异常请求 5 次、异常后裸 token 身份读取 8 次、认证头拒绝 0 次；真实后端是否拒绝 Bearer 不属于此夹具验证结论。

| 场景                      | 运行产物                                                                     |
| ------------------------- | ---------------------------------------------------------------------------- |
| ZAI 有效身份、业务普通403 | `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-130134-910/summary.md` |
| ZAI 有效身份、业务空200   | `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-130212-817/summary.md` |
| ZAI 真正401后进入重新登录 | `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-130238-083/summary.md` |

本轮隔离 Electron 自动复测（2026-10-12），三组各 1 case passed：

| 场景                             | 运行产物                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------- |
| BigModel 身份接口空正文 HTTP 200 | `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-113906-886/summary.md` |
| ZAI HTTP 200 + 数值业务 401      | `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-112942-876/summary.md` |
| BigModel HTTP 401                | `packages/desktop/.e2e-artifacts/desktop-e2e-20261012-113245-109/summary.md` |

采用本地 HTTP fixture 和合成凭据；用例继续保留 pending。未验证真实后端、手机或 Windows/Linux 设备，不声称正式 CI 准入。

- 候选 spec：`packages/desktop/test/e2e/auth-config/session/access-token-401-auto-logout.test.ts`。
- manifest：`packages/desktop/test/e2e/fixtures/cases/auth-config/access-token-401-auto-logout.json`。
- 输入：隔离 HOME 的 BigModel 旧版用户资料缓存、不同值的业务 access token 与未被判定过期的 ZCode JWT，以及一个独立 Bot 凭据。
- 动作：启动资料迁移真实发出 userinfo 请求；本地 HTTP fixture 暂停响应，待 UI 可用后返回 HTTP 401，或通过 `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200` 返回 HTTP 200 + `{"code":401,"msg":"登录状态已过期","success":false}`。用例确认 fixture 实际启用的状态码；其它控制面请求返回正常 200，避免 JWT 401 掩盖新增判断。
- 断言：fixture 确认请求用的是业务 token；原过期弹窗出现；确认前 active/token/profile/JWT 已清除且 Bot 凭据保留；确认后经 preload 发出原 RelaunchApp 命令。测试在主进程 IPC 边界截断命令，不实际执行退出/重启，避免 Host 关闭屏障干扰 WebDriver 收尾。
- HTTP fixture 不记录凭据原文；不访问真实平台，不需要模型请求。支付、API key、旧请求与多平台判定由服务层单测覆盖。
- desktop local 的 HTTP/Host/Renderer 链路必须自动运行通过；人工验收、手机 shared-host 与跨平台 UI 回归未完成前保持 pending，不宣称完整多端验证。

```text
隔离旧缓存 -> 后台 userinfo 请求 -> fixture 暂停
                                      |
                             测试放行 HTTP 401
                                      |
                     当前 access token 匹配 -> 原 logout
                                      |
                        清凭据 -> 弹窗 -> 确认重启
```

### AUTH-06 自动验证记录（2026-09-08）

- 服务层先在原 JWT 判断上复现 4 项失败；增加匹配后，凭据分类及既有 API client 回归共 41 项通过，另有 4 项原 OAuth logout/资料迁移清理回归通过。
- Electron E2E 最终 1/1 通过，运行 ID：`desktop-e2e-20260908035743975-p37710-5701199aa046d5f2`。最后一次仅调整测试的 IPC 截断点，复用此前同一业务源码构建的产物（`ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1`）。
- 首轮并行类型检查覆盖 Host 构建输出导致启动失败；分开执行后定位到测试 mock 重启仍执行 Host 关闭屏障，引发 WebDriver 收尾超时；改在 IPC 边界记录命令后完整通过。业务实现未因这些测试环境问题扩展范围。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint` 均通过；Lint 有 43 条既有警告，新增文件专项检查为 0 警告/0 错误。
- 当前 fixture checker 不支持 auth/config pending spec，命令返回不支持该目录；不将此结果计为 fixture 校验通过。
- macOS arm64，测试 runner Node 24.12.0，Electron 41.0.3 内置 Node 24.14.0。未验证真实平台失效响应、Windows/Linux、手机 shared-host UI 或人工视觉验收。

## 帮助配置迁移 HC-01～HC-05

正式用例：`help-client-config.test.ts`（8 个 case），来源 staging 已经用户授权转正，保留默认 desktop E2E 收集。
覆盖真实帮助菜单、中英文链接、成功缓存、同语言默认值、内置反馈弹窗、跨 endpoint
反馈地址、HTTP/业务/JSON 失败恢复，以及窄屏 Chromium Web 重载后的 HTTP cache 行为。
使用 case-local HTTP fixture；无模型请求。历史验证不计成本轮通过。
详细覆盖矩阵、剪枝、fixture 合同见 [帮助配置验证](help-client-config-e2e.md)。
Todo103 本轮运行证据记录在 staging-integration ledger。

### AUTH-06 SG-01 回归补充（2026-09-09）

- 服务层：受控凭据读取与刷新写回，覆盖“初步分类读到旧 token 后同平台 token 已更新”、队列中的条件退出、过期刷新不得复活退出会话。
- Electron：重跑既有隔离 AUTH-06，验证当前 token 的真实 Host userinfo 401 仍完成原凭据清理、Bot 独立、唯一提示和确认重启命令。精确的读取/入队竞态由上述服务层测试覆盖，未将其记作 Electron 并发场景覆盖。
- 沿用现有 pending case 与合成凭据，不使用真实平台或用户文件。
- 最终验证：`pnpm exec vitest run packages/services/test/oauthUnauthorizedLogout.test.ts packages/services/test/oauthUnauthorizedRequest.test.ts packages/services/test/nodeApiClient.test.ts packages/services/test/nodeApiClientEndpoint.test.ts packages/services/test/oauthService.test.ts`：148/148 通过，含 9 项新竞态/通知回归。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 为 46 条既有警告、0 错误。
- `ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/auth-config/session/access-token-401-auto-logout.test.ts`：最终代码重新构建 App/Agent 后 1/1 通过，未设置 skip build。制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20260909071607852-p66392-b7f49a248cd9bd36/summary.json`。
- macOS arm64；保留现有 IPC 拦截以验证 RelaunchApp 命令，不执行真实进程重启。手机 shared-host、Windows/Linux 和真实平台响应未补跑。

- 跟进审查基线检查后，已 rebase 到 `a1fcf91ec11ab34d263b6347bc704b5dd09ac016`；WDIO 冲突保留新增的安全校验 fixture 与认证 fixture 两个按 case 启用的入口。rebase 后再次通过上述 148 项单测、typecheck、E2E typecheck、lint 和 architecture 检查，App/Agent 重新构建后 AUTH-06 为 1/1 通过。最新制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20260909072706868-p75427-b55cce637bf05b15/summary.json`。

### AUTH-06 CR-01 URL 配置回归（2026-09-09）

- 新增 25 项 URL 边界测试：BigModel/ZAI 非法、相对、非 HTTP(S) 与空白配置；坏候选不影响有效候选；无效请求与全部候选非法；无关配置不参与 userinfo 分类；原 JWT 分支保持兼容。实现前 13 项失败，修复后分类器测试 51/51、上述五个服务测试文件合计 173/173 通过。
- 运行真实 NodeApiClient/helper 的合成凭据探针：无效业务 base + 有效 userinfo、无效 userinfo + 有效 customerInfo 均保留 HTTP 401，并各触发一次失效回调。未请求真实平台或读取用户凭据。
- `pnpm typecheck`（含 Desktop E2E）、`pnpm lint`（46 条既有警告、0 错误）、`pnpm architecture:check -- --changed`（0 violations）通过。
- 重新构建 App/Agent 后运行上述 AUTH-06 命令，1/1 通过；制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20260909081228959-p89316-72990aef331d8ad0/summary.json`。异常配置分支由服务测试覆盖，Electron 验证正常 401 交互链路；保留前述 pending、macOS 与重启 IPC 拦截边界，手机 shared-host/Windows/Linux 未补跑。

### AUTH-06：HTTP 200 业务 401 回归（2026-10-08）

- 原因：业务登录过期返回 HTTP 200 + JSON 数值 code=401，旧请求观察器没有进入退出与重启提示链路。身份、企业定价、团队订阅详情复用同一当前凭据白名单及会话队列复核。
- 服务层 8 个相关测试文件 260/260 通过；覆盖 BigModel/ZAI 三接口、并发仅一次清理/通知、重新登录/刷新后旧响应不清理新会话、原响应正文可读、空/损坏正文及 SSE 不误判。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm lint`（68 条其它文件既有警告、0 错误）、`pnpm architecture:check --changed`（0 violations）、变更代码格式检查通过。
- pending replay 需显式传入 `E2E_PROVIDER_HTTP_MODE=replay` 和 `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json`，再以 `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200` 或 `401` 运行本用例；没有模型请求。fixture checker 当前只支持 conversation-session/plugin，不支持此 auth-config 路径；AUTH-06 manifest 保持无模型请求声明。
- HTTP 200 + 业务 401：重新构建 App/Agent 后 1/1 通过；制品 `packages/desktop/.e2e-artifacts/desktop-e2e-20261008081902034-p54677-f19c52bf23b72057/summary.json`。
- HTTP 401：复用上一次相同源码的 App 产物（`ZCODE_E2E_SKIP_BUILD=1`）、重新构建 Agent 后 1/1 通过；制品 `packages/desktop/.e2e-artifacts/desktop-e2e-20261008082005216-p55748-74de9060da312d0b/summary.json`。
- 两次均验证确认前凭据清理、Bot 凭据保留、唯一原过期弹窗及确认后 RelaunchApp 命令。沿用 IPC 拦截，不声称实际进程重启；macOS arm64 验证，手机 shared-host、Windows/Linux 未实机回归。复用原 UI、广播及重启动作，不改 continuous/replayable 边界；用例保持 pending。

## HM-01～HM-04：帮助菜单应用入口

用户于 2026-09-16 确认转正。正式用例 `packages/desktop/test/e2e/feedback/help/help-menu-about.test.ts`，默认 desktop E2E 收集 Preview 分支，production 使用 `ZCODE_E2E_HELP_MENU_FLAVOR=production` 与 production 构建单独运行。HM-02 对下载完成状态分别验证动作文案和版本 pill，关闭重开后再次验证版本。共 4 个 case，覆盖草稿页/设置页、中英文关于窗口、更新状态及禁用/重开、真实开发包检查更新回执和 Preview 隐藏。无模型请求，无 provider replay fixture 依赖；合成更新事件仅用于菜单状态展示。完整矩阵和运行命令见 [桌面帮助菜单](../windows-caption-help-menu.md)。

## AUTH-07: OAuth 回调与轮询完成竞态（pending）

轮询时钟回归：通过隔离 Host 的 `Date.now` 注入，不修改系统时钟、单调时钟或真实定时器。
首个 `pending` 后回拨两天，下一次到期查询仍应返回 `ready` 并保存登录；向前跳两天则仍按绝对期限拒绝，不能发出第二次查询或写新凭据。已过期的初始化响应必须在发出首次查询前失败。既有双路径竞争、归因与取消场景继续运行。

每次场景为新 Host 注入独立 case ID，回拨和前跳必须先读到同一 ID 的 `clock-shift` 事件，并核对偏移量；无事件时直接失败，不能把未注入的正常轮询计为通过。已过期 init 不应产生偏移事件。将调度临时改回 `Date.now` 后，回拨场景必须失败；恢复单调时钟后才可通过。

本地期限先到（3.18.0 发布验收 Case 11）：fixture 的 init 下发 4 秒期限，并把首个查询挂起到期限后 1.5 秒才返回 `pending`，保证 Host 定时器先清除 flow，不依赖时钟注入。断言登录页在 15 秒内进入失败态、服务端只收到 1 次查询、登录凭据不变；点击「重新登录」后新 flow 连续查询仍在等待，没有失败态。前跳用例覆盖另一顺序（轮询先看到过期）。修复前红灯 `desktop-e2e-20261109-091543-392`：15 秒内没有失败态，Host 日志每秒一次 `pollPendingOAuth OK`（空结果）。修复后整组 11/11 通过 `desktop-e2e-20261109-091800-798`，Host 日志记录本例 `OAuth flow 已过期`。仅覆盖 macOS 桌面 local。

过期代次隔离：上一例重新登录后，新 flow 每次查询都有 pending，测不到代次比较。另一例通过真实 Renderer→Host RPC 固定顺序：先用同样的挂起查询让旧 flow 由 Host 定时器过期，下一次查询必须报 `OAuth flow 已过期`；再发起新 flow，由浏览器回调兑换完成。兑换提交会清除 pending，但不推进代次，此时查询必须返回空结果，不能按旧期限报过期。把代次比较临时改为只判断标记存在时，本例必须失败；还原后才可通过。变异红灯 `desktop-e2e-20261109093859713-p17663-61707cd6d5e2996f`：仅本例失败，回调完成后的查询报 `OAuth flow 已过期`，其余 11 例通过。还原后整组 12/12 通过 `desktop-e2e-20261109094139950-p28932-79b16123f81c249e`。仅覆盖 macOS 桌面 local。

时钟场景必须独立安装并恢复 openExternal mock，单独筛选执行时也不得打开系统浏览器。改写凭据、开窗和等待就绪均属于受保护区；开窗失败或取证失败后，仍须关闭本例新增窗口、恢复原凭据和窗口焦点、复位 HTTP 时钟状态。取证失败不能中断清理，也不能掩盖原始失败。

清理专项复验：单独筛选回拨用例通过，最终整组 4/4 通过（`packages/desktop/.e2e-artifacts/desktop-e2e-20261029-092609-842`）。开窗后故障、取证故障及两者同时故障三组注入均保留预期失败，同时确认原凭据、初始窗口集合和服务端时钟状态恢复。macOS close 只隐藏窗口，夹具清理必须销毁本例窗口并触发 Host 回收。临时故障注入均已还原；产品代码未变。

2026-10-29 补强复验：最终 Electron E2E 4/4 通过，artifact `packages/desktop/.e2e-artifacts/desktop-e2e-20261029-090946-529`。关闭注入时因缺少本次 `clock-shift` 失败（仍有两次网络查询）；恢复旧绝对时间调度时，已记录回拨但只发生一次查询，登录未完成。两个临时变更均逐字还原后再运行最终验证；没有新增业务单测或修改产品行为。

- Spec：`packages/desktop/test/e2e/auth-config/login/oauth-completion-race.test.ts`。
- Fixture：`helpers/oauth-completion-race-fixture.ts` 启动本地 HTTP，init 后真实 Host 轮询；
  preload 回调启动 token 兑换并挂起，poll ready 返回后才释放 token HTTP 500。
- 先挂起一次兑换并通过 UI 取消，释放兑换成功响应；等待 Host 回调完成后确认未登录、无错误，再重新发起登录。
- 断言：客户端继续用 polling 凭据登录、登录面板退出、无失败提示、归因参数保留；
  再投递同 state 迟到回调，更新归因且 token 请求次数仍为 1。
- 无模型请求，无真实第三方登录。浏览器打开用 Electron mock 拦截，Host OAuth 服务保持真实。
- 两种先到顺序、双失败、取消和旧响应由服务层受控 Promise 测试覆盖；此 E2E 仅覆盖桌面
  local 的用户可见回退，不宣称覆盖手机 shared-host 或 Windows。保持 pending，等待人工 review。

### AUTH-07 本次验证（2026-09-17，macOS）

- Electron E2E：通过；产物 run id `desktop-e2e-20260917065456399-p21750-95ee455f2fa5007d`。
  使用本分支已构建产物，最后一次重跑仅修改 fixture，跳过重复 App/CLI 构建。
- Host 日志证实 `/oauth/token` 500 后 `oauth.pollPendingOAuth` 和 `oauth.handleCallback` 正常返回；
  断言加密落盘的业务 token、归因字段、登录面板退出及迟到回调不再兑换均通过。
- OAuth 服务测试 109 项、UI/桥接边界测试 38 项通过。服务层及 E2E 类型检查、lint、架构门禁通过。
- 全仓 `pnpm typecheck` 被基线 `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts` 重复键
  TS1117 阻塞；两文件本分支未改动。fixture checker 当前不支持 auth-config pending 目录，
  无模型请求 manifest 已保留，未进行 promotion/CI admission。手机、Windows/Linux 未实测。

### !2703 Suggestions 回归（2026-09-17，macOS）

- SG-01：manifest 指向实际 pending spec 路径。
- SG-02：服务声明 nullable 回调，Root 忽略失效结果；单测复现原 TypeError 后验证修复。
  E2E 先取消挂起兑换，再放行成功响应，确认凭据未替换、无登录错误；随后重新登录完成原回退场景。
- SG-03：双路径均失败时分别保留原错误，两种到达顺序均验证。
- SG-04：可控时钟验证 pending 和成功后窗口内接收的回调即使排队超过 30 秒仍保存归因，
  窗口外的新回调拒绝；未增加处理时刻的过期判断。
- 相关单测 151 项通过；服务/E2E 类型检查、lint、架构门禁通过。全仓类型检查仍仅有上述基线 TS1117。
- Electron E2E 通过（1 case），run id `desktop-e2e-20260917074228667-p30511-55b50bde685ed92b`。
  首轮重新构建 App，修正测试日志路径和预置账号断言后复用同一构建重跑。

### 最新 staging 基线复验

- 已 rebase 到 `origin/staging` 的 `c7a795d2df`，旧基线的翻译重复键已不存在。
- 全仓 `pnpm typecheck`、lint（0 errors / 54 warnings）、架构门禁及 151 项相关单测通过。
- 重新构建 App 后 AUTH-07 通过，run id `desktop-e2e-20260917075008349-p32477-57ae7b5093a2bbd0`。

## AUTH-08: 桌面远控登录门禁（pending）

- 设备身份保存失败回归（CR-02）：`web-remote-control-session-events.test.ts` 在已有首次注册完成后，通过真实弹窗停止远控，在 loopback relay 删除旧 SID，再将隔离 HOME 的 setting.json 与父目录设为只读，保留文件读取与 endpoint，仅阻止原子写入。重新打开弹窗触发 `AUTH_FAILED` 恢复注册，断言启动立即进入 `error`、没有二维码，新设备已被补偿删除，超过首个退避窗口后设备数不再增长；恢复原权限后，用户再次打开弹窗可正常启动。复用 loopback V2 relay，不产生模型请求；不冒充真实磁盘满、线上 relay 或 Windows/Linux 验证。用例保留 pending，待人工审阅。

- 凭据完成事件回归：`web-remote-control-session-events.test.ts` 使用单窗口、真实 Host OAuth 与 loopback V2 relay。已配对后持有隔离 HOME 的 setting.json 写锁，保留有效设置读取与独立凭据写入，再从真实用户菜单登出；断言凭据清空、Main 为 `auth-required`、旧 terminal WS 关闭且未靠重启关闭。额外断言凭据清除之后出现 `setting.update FAIL`，清理阶段释放写锁。该候选不覆盖多窗口，也不代表真实 OAuth 或线上 relay 验收。

- Spec：`packages/desktop/test/e2e/remote-control/authentication/manual-review/pending/web-remote-control-auth-gate.test.ts`。
- 前置：隔离 HOME 的 OAuth/JWT 凭据为空；保留上次启用目标；case-local HTTP/WS 计数服务在 Electron 启动前接入 main 的 endpoint 和 relay URL。
- 操作：打开移动端远控弹窗，依次检查 Zai Light/Dark × zh-CN/en-US，点击登录入口。
- 断言：main 保持 `auth-required`；标题、说明、登录按钮可见；没有二维码、复制链接或生成中占位；真实登录渠道可达；远控 HTTP 和 WS Upgrade 次数均为零。
- 重新认证回归：恢复缓存用户与合成 JWT，使远控 HTTP 返回401；全局用户仍保留，点击远控登录按钮应按当前OAuth渠道创建新登录尝试，发起一次授权并停留等待页，不能因缓存用户立即完成。渠道加载时按钮禁用；已有用户但渠道读取失败时保留弹窗、提示失败并重新读取，读取恢复后可重试。
- 证据：E2E 产物内四张弹窗截图及网络计数 JSON。`providerRequestPolicy: none`，不产生模型请求；不替代真实 OAuth、手机登录或 Windows/Linux 验证。
- 状态：accepted 语义，pending 实现验证及人工截图审阅；人工确认后转正。此 auth-config 路径不属于 conversation/provider replay 和 Docker conversation 准入。

### AUTH-08 本次验证（2026-09-19，macOS arm64）

- 完整构建 App/Agent 后，pending Electron E2E 1/1 通过；最终 run id：`desktop-e2e-20260919054022407-p76850-149c65ccfe5737d4`。
- `auth-required-network.json` 为 `{remoteHttp: 0, wsUpgrades: 0}`；四张截图为产物目录下 `auth-required-{zh-CN,en-US}-{zai-light,zai-dark}.png`，拼图为 `auth-required-review.png`。
- manager、workspace 完整快照、IPC、UI hook/渲染相关回归通过；Standards/Spec 评审发现的混合 workspace 覆盖问题已修复并复核。
- fixture checker 仅支持 conversation-session/plugins，拒绝 auth-config 路径；本 case manifest 已声明无模型请求及 canonical formal path，按 auth-config 契约直接核验。
- 保持 pending，等待人工确认截图后转正；未执行手机、Windows/Linux 或 Docker 准入。

### AUTH-08 远控401重新登录回归（2026-09-19，macOS arm64）

- 最终源码完整构建 App/Agent 后，Electron E2E 两项通过；run id：`desktop-e2e-20260919094618238-p38547-51d7c0efafe28411`。构建前后源码指纹一致，原四种主题语言门禁验证保持通过。
- `remote-401-relogin.json` 记录一次远控HTTP、零WS Upgrade及一次`zai` OAuth初始化；点击前缓存用户仍可见，点击后进入真实统一登录等待页。截图为 `remote-401-relogin.png`，授权链接由 Electron shell mock 截获，没有访问真实 OAuth 提供方。
- UI与登录定向回归四文件27项通过，覆盖 ZAI/BigModel、渠道加载、读取失败后重试和未登录入口；`typecheck:e2e` 通过。用例继续保留 pending，不替代真实 OAuth授权完成或手机验收。

### AUTH-08 凭据事件与设置失败回归（2026-09-22，macOS arm64）

- `web-remote-control-session-events.test.ts` 1/1 通过，run id：`desktop-e2e-20260922033841444-p82542-b070f1a88919befa`。复用此前同一产品源码的完整 App/Agent 构建，仅修正测试入口和事件等待。
- `remote-logout-settings-failure.json` 记录凭据已清空、Main 为 `auth-required`、已配对 terminal WS 已关闭、重启调用为零。真实 setting.json 目录故障使 UI 设置写入失败且用户投影仍保留，证明关闭不依赖 UI 更新或重启。
- OAuth owner、RPC、Root hook、Main/loopback relay 及相邻登录/退出回归共 9 文件158项通过。用例保留 pending；不代表多窗口、真实手机、线上 OAuth/relay 或 Windows/Linux 验收。
- 原有登录门禁及401重新登录两项通过，run id：`desktop-e2e-20260922034047265-p83703-d5d6a95570facec2`。用例等待 workspace 恢复后的远控按钮可见，并独立初始化重新登录场景的语言，避免启动中间态或前一个用例失败导致误报。

### AUTH-08 CR-02 本次验证（2026-10-09，macOS arm64）

- `web-remote-control-session-events.test.ts` 两项通过，run id：`desktop-e2e-20261008210518141-p70374-763dbf6ff9c57299`。先完整构建当前 App/Agent，后续只修改测试与 fixture 并复用产物；pending replay 显式使用 `fixtures/upstream/common.json`，fixture 的账号业务 API 与 relay 均走 loopback。
- `remote-device-save-failure.json` 记录 Main 为 `error`、`relay-unavailable`、无二维码链接，补偿前后的设备列表均为空；真实日志确认新身份保存因设置锁目录 `mkdir` 返回 `EACCES` 而失败。恢复权限后手动启动成功，原有凭据完成事件/登出回归继续通过。截图：`remote-device-save-failure.png`。
- manager、transport、HTTP 与构建入口四文件共77项聚焦单测通过；全仓 typecheck、lint（0 errors / 68 warnings）、E2E typecheck 与架构门禁通过。用例仍为 pending，未进行人工转正；未验证真实磁盘满、线上 relay、手机真机或 Windows/Linux。

### AUTH-08 模块迁移复验（2026-10-11，macOS arm64）

- 登录门禁与 401 重新认证两项通过，run id `desktop-e2e-20261011124104790-p96630-dfdfff8d46f12a96`。
  夹具增加独立业务 API 的 loopback 配置，避免合成凭据访问外部业务接口导致提前登出。
- 注册补偿与凭据事件两项通过，run id `desktop-e2e-20261011124451683-p19041-9baf640b4fc4d95e`。
  复用前一次产品源码构建，测试保留有效 setting.json 并独占其写锁；真实日志确认凭据清除后
  `setting.update FAIL`，Main 为 `auth-required`、terminal 已关闭、未调用重启。
- pending 状态不变；不替代真实 OAuth/relay、手机或 Windows/Linux 验收。

## AUTH-09: 桌面重启后自动恢复远控（pending）

规则见[启用状态恢复](../web-remote-control/web-remote-control-architecture.md#桌面应用重启后的启用状态恢复)。

- Spec：`packages/desktop/test/e2e/remote-control/connection/manual-review/pending/web-remote-control-startup-restore.test.ts`。
  Manifest：`packages/desktop/test/e2e/fixtures/cases/auth-config/web-remote-control-startup-restore.json`。
- 前置：复用 AUTH-08 的 loopback V2 relay 与合成登录。隔离 HOME 只恢复默认 workspace
  `ZCodeProject`；上次启用目标写成未打开的 `ZCodeProject-previous`，对应“在 A 开启远控，切到 B 后
  退出，重启后窗口里只有 B”。
- 操作：冷启动；等待远控入口可见；在弹窗中停止远控；退出并重新启动 Electron。
- 断言：
  - 冷启动后 Main 进入 `running`，状态目标是 `ZCodeProject`，不带任务；relay 上有在线设备；
    setting.json 的上次启用目标改为 `ZCodeProject`。
  - 停止后 Main 为 `idle`，上次启用目标被清除，relay 上没有在线设备。
  - 重启并等待远控入口可见后，Main 保持 `idle`，relay 上没有在线设备。
- 证据：E2E 产物内 `remote-startup-restore.json`。`providerRequestPolicy: none`，不产生模型请求。
- 不覆盖：多窗口归属、Windows/Linux。远端目标见下方 AUTH-09-R。
- 状态：accepted 语义，pending 实现验证及人工审阅。

### AUTH-09 本次验证（2026-10-30，macOS arm64）

- 修复前完整构建后失败在“未自动恢复远控”，run id
  `desktop-e2e-20261030085936914-p31281-005cbc658cb74930`；日志有登录恢复和 workspace 同步，没有恢复日志。
- 修复后完整构建 1/1 通过，run id `desktop-e2e-20261030090220212-p41569-eedd7cd7cf3c9938`；日志为
  `target=window`，停止后重启的新进程没有恢复日志。
- 复用同一构建的 `web-remote-control-session-events.test.ts` 2/2 通过（`target=saved`），run id
  `desktop-e2e-20261030090426436-p50490-b21673070e353a53`。
- `conversation-session-virtual-project-mobile.test.ts` 的 VP13 在修复后与 HEAD 基线构建上失败于同一处草稿路径断言，
  与本修复无关；两次运行都已完成自动恢复和手机配对。run id：修复后
  `desktop-e2e-20261030090614497-p57942-1d6615c26666a021`，基线 `desktop-e2e-20261030090908176-p69264-0a8cbd717f7016d0`。
- 用例保持 pending；未验证多窗口、真实手机或 Windows/Linux。

### AUTH-09-R：上次远控目标是 SSH 项目，重启时远端离线（pending）

- Spec：`packages/desktop/test/e2e/conversation-session/remote/mobile/manual-review/pending/conversation-session-r3-mobile-startup-restore.test.ts`。
  由本机 Docker 远端 runner 运行：`node harness/remote/run-local-docker.mjs <spec>`。
- 前置：复用 AUTH-08 的 loopback V2 relay、合成登录与手机 Web 夹具；远端为 runner 新建的 Linux 容器。
- 操作与断言：
  1. 连接 SSH 项目，在该项目打开远控弹窗；断言远控以该项目运行，setting.json 的上次启用目标与
     激活工作区都是该项目。
  2. 停止容器使远端离线，保留 Profile 冷重启；窗口只恢复断开的 SSH 项目。
  3. 断言 Main 自动进入 `running`，状态目标是该项目且不带 `remoteSessionId`，relay 上有在线设备。
  4. 手机用恢复后的链接配对；没有可 bridge 的工作区，手机进入 home-only，列出离线行（“未连接 · 连接”）；
     桌面显示手机已连接。
  5. 启动容器，手机点离线行交给桌面重连；桌面 tab 取得新 `remoteSessionId` 后，手机再点该行进入项目，
     新建草稿出现 composer。断言整个过程使用同一个设备会话，手机保持连接。
  6. 关闭手机，等桌面显示手机断开后，在该 SSH 项目打开远控弹窗。断言弹窗沿用原远控连接：设备会话
     不变，runtime 仍保留手机上报的位置；远控状态的 `remoteSessionId` 等于 tab 的值。
- 证据：`remote-startup-restore-ssh.json`、`mobile-offline-remote-home.png`、
  `mobile-reconnected-remote-draft.png`。不产生模型请求。
- 不覆盖：真实跨机网络、Windows 开发机、VPN 与线上账号/relay；启动时远端可达、重连早于恢复的时序；
  上次启用目标带任务时手机的初始任务选择（当前桌面远控入口不传任务）。

### AUTH-09-R 本次验证（2026-10-30，macOS arm64 + 本机 Docker aarch64 容器）

- 修复前（只把 `webRemoteControlManager.ts` 换回修复前版本，其余相同）失败在第 3 步
  “远端离线时重启未自动恢复远控”，run id `local-docker-20261030095943-280b1b`；重启后的新进程没有恢复日志。
- 修复后 1/1 通过，run id `local-docker-20261030095640-7e7511`；日志为 `target=saved`、`remoteSession=none`，
  手机先落在 home-only，重连后经项目列表进入草稿，设备会话不变。
- 远程回归：`conversation-session-ssh-remote-p0.test.ts` 1/1（`local-docker-20261030100544-697f14`）、
  `conversation-session-r3-mobile.test.ts` 2/2（`local-docker-20261030101002-94d74b`）、
  `conversation-session-r3-mobile-permission.test.ts` 1/1（`local-docker-20261030101310-bbe64d`）通过。
- 用例保持 pending；不代表真实跨机网络、Windows 开发机、VPN 或线上 relay。

### AUTH-09-R 第 6 步验证（2026-10-30，macOS arm64 + 本机 Docker aarch64 容器）

- 修复前失败在第 6 步：重启后的新进程在打开弹窗时记录 `reason=restart`，弹窗重启了远控连接，
  手机上报的位置丢失；run id `local-docker-20261030124156-e3525a`。
- 修复后 1/1 通过，run id `local-docker-20261030125249-e4b18a`；新进程打开弹窗时没有 `reason=restart`，
  手机位置保留，远控状态的 `remoteSessionId` 等于 tab 的值。
- 另有一次修复后运行（`local-docker-20261030124523-c1a008`）在第 5 步失败：手机触发的 SSH 重连在
  Provider Provisioning 首次同步时报 `target-refresh-failed`，连接被释放，没有走到第 6 步。该失败发生在
  远端连接链路，未查明根因；同一构建重跑通过。
- 回归：AUTH-09 1/1（`desktop-e2e-20261030130627134-p93192-107be9298931eee8`）、
  AUTH-08 session-events 2/2（`desktop-e2e-20261030130338418-p80828-9afcebe7234d0bf9`）、
  `conversation-session-r3-mobile.test.ts` 2/2（`local-docker-20261030130753-c39a9d`）通过。

## PAT-LOCATION-RECOVERY：项目定位密文异常局部恢复（pending）

- Spec：`packages/desktop/test/e2e/workspace/recovery/project-location-decrypt-recovery.test.ts`。
- 有效 BigModel OAuth 与同账号坏位置共存；真实 Host 原子删除坏位置，自动重新查询并换证。
- 断言 OAuth 原始密文、Bot 凭据保持；头像恢复；无登录失效提示、无 OAuth polling、无重启。
- 同一用例经本地 HTTP 控制再次制造缓存故障及元数据 503，断言恢复失败仍保留当前登录；
  恢复服务端后经真实 ProviderSettingsFacade 刷新成功，不额外创建登录状态源。
- 两个独立凭据服务、已修复记录、普通 IO、锁等待期间失效、客户端 clear 与 pending 合并
  由服务层单测覆盖；确认业务登录失效仍由现有 401 核验用例覆盖。
- 本地 HTTP 为合成账号；保持 pending，不宣称真实 OAuth、Windows/Linux 或手机真机验证。
- 2026-10-15 macOS Electron：1 case passed，runId `desktop-e2e-20261015-074508-840`；
  自动恢复、503 保留登录、手动刷新换证与已连接套餐/解绑入口均已断言。HTTP：定位查询 7 次、
  签发 2 次、OAuth polling 登录 0 次。截图：同 runId 制品目录的 `project-location-recovered.png`。
- 定向 UT 135 项通过；最终 affected 1,384 个规格全部通过，15,435 项通过、6 项跳过。
  根类型、E2E 类型、Lint 与架构检查通过；Lint 有 210 项既有警告。
- 日志补充复验：runId `desktop-e2e-20261015-081458-266`，同一 Electron 用例通过；
  真实 Host 日志按序出现 `project_token_location_unreadable` 与 `project_token_location_recovery`，
  覆盖首次恢复及重建 503，两事件仅含 family、stage、固定 code。恢复内 IO 失败由客户端单测覆盖。
- fixture checker 尚不支持 auth-config pending 路径；本地 JSON/路径静态核对通过，
  用例继续 pending，不做人工转正或 CI admission。旧“立即登出后重登”证据不适用于本方案。

## PAT-KEY-UPGRADE：有效登录态与坏旧 Key 共存

候选用例：`packages/desktop/test/e2e/coding-plan/account/account-key-usage-scene.test.ts`。
复用该文件 Z.AI 恢复用例：在隔离 HOME 的 credentials.json 中保存有效合成 OAuth 与账号资料，同时将同账号 account-provider:\*:api-key 写为损坏密文；重启 Electron，要求直接恢复工作区，Host 创建 usageScene=1 的专用 Key 并签发 Token，不调用 Copy，原坏旧记录保持不变。BigModel 用例覆盖无旧 Key 的创建/换证路径。
此用例不触发模型推理；HTTP 为既有本地 Coding Plan mock，不代表真实后端联调。手机/远程链路由 Provisioning 与鉴权服务测试覆盖，本轮不宣称设备级远程 E2E。保持 pending，不自动转正。

本轮自动复测：2026-09-23，2 cases passed；artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20260923070315610-p85476-12717808333f5136/summary.md`。未进行人工确认或转正；手机、真实后端及混版本远端不在本 case 范围。

凭据恢复补充回归：CLI 必须与 Desktop 一样严格解码 UTF-8；损坏 key 与完整密文共存时，load/save 均失败并保留原始字节。手机权限回归纳入 `conversation-session-new-task-missing-root-mobile.test.ts`：在真实配对的项目草稿中直接经实际 Credential RPC 调用 inspectStore/recoverStore，两者均返回 feature_disabled，文件字节保持且不显示恢复入口；保留原目录移动/恢复回归。

## PAT-COLD-RETRY：冷缓存签发临时失败一次恢复

复用 `project-location-decrypt-recovery.test.ts` 与本地 HTTP 夹具。已有有效 OAuth 和已保存 Key ID，完整重启清空内存 PAT；第一次签发返回 503，第二次签发成功。断言两次请求使用同一 Key 路径、没有创建 Key、OAuth 与独立 Bot 凭据不变、无登录完成事件，随后正常显示套餐。只覆盖隔离 Host 的已归类临时故障恢复；两次失败、拒绝、取消和账号切换由共享客户端的 CLI 回归及真实 HTTP 探针覆盖，不宣称生产账号或实体手机已验收。

2026-10-28 macOS Electron 验证：原有位置恢复与新增冷缓存签发重试共 2 个场景通过，产物为 `packages/desktop/.e2e-artifacts/desktop-e2e-20261028-144449-869`。新增场景捕获相同 Key 路径的两次签发、零 Key 创建、零登录完成事件，并确认套餐恢复。此结果不代表真实服务或 Windows/Linux/实体手机已验收。

2026-11-02 本机恢复边界最终验收：源码9组连接/授权配置及桌面E2E单次9/9（artifact：`packages/desktop/.e2e-artifacts/desktop-e2e-20261102060826266-p40462-134332e03a98a116`）；旧8db完整Core包的自领票据反向用例失败，新production完整Core包以及兼容HTTP/stdio编译产物全部拒绝网络整库检查/恢复，原件/恢复代次/备份保留，普通CRUD通过。完整签名App3.17.119的实际本机Desktop＋包内CLI两渠道×init/poll/material/config-lock共8/8。网络中的desktop-continuous不再被视为本机恢复授权。完整归档与运行字节核对通过；未部署、未公证，Windows/Linux、实体手机和生产账号未验收。

## 关联 BigModel 套餐访问（核心链路已验证）

扩展 `account-key-usage-scene.test.ts`：主登录为中国区 Z.ai，ZCode user ID 与关联 BigModel customer ID 不同；保留 BigModel 个人套餐的已有选择。真实 Host 必须使用关联 BigModel JWT 创建套餐用途 Key 并签发短期 Token，不得发送中国区 OAuth token，也不写第二份 `oauth:bigmodel:*` 登录。

若关联记录绑定的主体与当前 ZCode user ID 不一致，不提供套餐访问材料。该场景只验证本地 HTTP 控制的请求链，不代表真实账户额度或远端/MCP 已验证。

2026-10-28 macOS 验证：关联 Key/Token 场景在实现前失败（旧 BigModel、Z.ai 两场景通过），实现后通过。订阅响应由 HTTP fixture 挂起时，仅修改同一身份的 revision，真实 ProviderSettings 刷新必须失败；关联记录绑定另一主体时发布 not-connected，且不请求该关联 JWT。

- 核心与 OAuth 回归：`desktop-e2e-20261028121931522-p27423-afc03ce50635f590`，2 份规格、8 个场景通过。
- Team 回归：`desktop-e2e-20261028122155858-p36372-1142636f00c5ce5c`，仅筛选 CTP-03/CTP-06，共 2 个场景通过。使用 `ZCODE_E2E_MOCHA_GREP='CTP-(03|06):'`，命令行 `--mochaOpts.grep` 未被当前封装应用，先前全量尝试已中止，不记为通过。
- 类型、Lint、架构检查通过；HTTP 均为本地合成材料，不声称真实账号、手机、MCP 或远端已完成。

## 存量补关联与设置投影（本地已验证）

- OAuth HTTP fixture 先返回有效的中国区主会话、无关联，再通过 profile 返回同主体 BigModel；安全投影不得含 JWT，缺失块不清已有关系，401 不退出。
- 挂起同会话的两个 profile 请求，确认只发一条 HTTP；期间退出，释放旧响应后不得恢复登录或关联。
- 旧全球 Z.ai 会话启动后补到 BigModel，原个人选择保持；若当前 family 因退出已清空，恢复可用 family。设置同时展示两个 family。仅浏览 BigModel 不改当前执行，显式连接方式选择才改为 BigModel；不再发起另一条 OAuth。
- 企业 pricing 响应挂起时切换会话 revision，释放后旧查询必须拒绝，不能将其当成当前套餐清单。
- 先补回归后验证：缺 family 的旧选择在修正前复现 expected zai / received undefined，runId `desktop-e2e-20261028123606461-p46992-a6fd6f8043538e13`。

2026-10-28 macOS 本轮验证：

- OAuth 与关联设置：`desktop-e2e-20261028123642598-p47763-d45f0e822b1d6770`，两份规格共 10 个场景通过，包含 profile 并发/退出、旧选择恢复、浏览与切换分离、企业 pricing 旧 revision 拒绝。
- 团队与布局回归：`desktop-e2e-20261028123744584-p50898-9dd3c763f12940b8`，CTP-02/06/30 共 3 个场景通过；CTP-30 覆盖 1100/390 px、浅色/深色的列表宽度与滚动。此处是 Electron 窄窗口，不代表手机浏览器真机验证。
- 根类型、Lint（217 个既有警告、0 错误）、架构、改动代码格式与开源导出提醒均通过；独立只读评审发现两项问题并复核修正。
- HTTP 使用合成账号；旧真实 JWT 兼容、购买嵌入页、MCP、远端/Web 仍按主计划跟进，未宣称已验证。

## 关联账号的官方 MCP 额度

`account-key-usage-scene.test.ts` 的中国区用例通过真实 Host 发起指定 BigModel 个人连接的 entitlement 查询，HTTP fixture 观察 `/api/v1/mcp/usage`。要求返回 MCP 额度，`Authorization` 使用主 ZCode JWT，`X-Bigmodel-Authorization` 使用同主体的关联 BigModel JWT，目标为 PERSONAL，不发送旧 `X-Coding-Plan-Api-Key`。

- 原实现回归失败：`desktop-e2e-20261028124311037-p62248-ec93294116dfbb19`，MCP 额度为 null。
- 完成关联材料接入后，显式给测试查询补充 accountAccess（裸 preferredProviderId 不代表已解析的账号连接）：`desktop-e2e-20261028124559280-p65877-e024bda91fc64558`，4 个账号场景通过。
- Team 兼容回归：`desktop-e2e-20261028124641888-p66589-d0d966a3aab9b9e3`，CTP-03/06 共 2 个场景通过。
- 类型、Lint、架构、代码格式与开源提醒通过。只验证本地合成账号的公共 MCP 身份头构造与额度请求；尚未用真实账号执行外部官方 MCP 工具。

## 关联账号的团队权益与额度重置

中国区个人场景补充真实 Host 的 reset/status 读取，要求主 JWT 加 Bearer、关联业务 JWT 按既有 reset 契约直传。新增 CTP-CN-03 以中国区主登录和不同 BigModel customer ID 请求团队权益，保留组织/项目范围。静态请求在返回前重解析原始 access 并检查 scope；明确指定的 access 保留浏览语义。

- reset 旧实现先复现 `coding_plan_reset_maas_jwt_required`；合成关联账号的修正后场景通过。
- 最终组合：`desktop-e2e-20261028125518098-p76317-bfacfb158074a1b1`，账号 4 场景通过，团队/重置 4 通过、QR-E2E-03 失败。该失败的 WebDriver 记录显示弹窗首帧目标按钮可见性为 false；用例先前只读取一次。
- 用例改为等待目标按钮实际可见，未增加固定 sleep、未修改产品弹窗。重跑 `desktop-e2e-20261028125914894-p79847-66a384b9dad941c4`，QR-E2E-03 通过。
- 根类型、Lint、架构及格式检查通过；没有执行真实额度重置操作。

### 关联账号的闲时与加速鉴权

`account-key-usage-scene.test.ts` 中国区用例通过真实 Host 验证：关联 BigModel 个人套餐可查询闲时取号资格；闲时请求使用主 ZCode JWT 和套餐 PAT，加速抽卡与推理使用同一主 JWT、关联业务 JWT。

同账号同 JWT 重新登录仅更新 session revision，旧加速卡也必须失效；抽卡响应受控挂起期间再次更新 revision，晚到响应不得保存卡或形成加速执行。本地 HTTP fixture 只验证客户端归属与协议，不代替真实服务端鉴权验收。

验证记录（2026-10-28）：旧实现 `desktop-e2e-20261028131301903-p86712-78aa61d50279042a` 在同账号重登后仍返回 accelerated，复现旧卡问题。修复后 `desktop-e2e-20261028131424091-p89645-0b3e097aeb52c186` 的 5 份规格、8 个场景全部通过：账号 Key 4 项（含关联加速及两个 revision 交错）、加速命中/超时/未命中各 1 项、Team 闲时 1 项。根类型检查、Lint（217 个既有警告，0 错误）、架构检查和修改文件格式检查通过。

### 远端关联会话整组同步

通过两个隔离的 Provider 运行时进程（真实凭据/配置 Store、Registry 和目标事务）执行 Source → Target（合成凭据，仅本地 IPC）。覆盖：v3 国内主会话与关联整体到达；旧 v2 输入清除目标新字段且生成新 revision；v3 在旧 schema 校验处拒绝；目标凭据写入后故障整组恢复；故障期间发生另一整组登录则保留新会话并返回 rollback_failed；手工 Key 不变。退出同步清空国内与关联材料，并留下新的目标 revision。实际应用与成功回滚都生成新的目标代次，同 syncId 重放零写入；回滚前开始的资料更新通过真实仓储 CAS 被拒绝。此验证不替代隔离 SSH 机器上的连接验收。

验证记录（2026-10-28）：`desktop-e2e-20261028132235025-p96057-d6a1f1d73de90927` 复现回滚 ABA，旧资料更新错误返回 true。修正后组合 `desktop-e2e-20261028132348466-p98815-6f8f82d5b5e9aa8c` 的 4 个同步场景与 4 个账号场景通过；补齐退出场景后 `desktop-e2e-20261028132447138-p99639-2c6a1f8f4abe7f2f` 全部 5 个同步场景通过。根类型、Lint（217 既有警告/0 错误）、架构、格式与开源检查通过。基线新鲜度检查仍报告原始登录提交在旧远端分支中；已确认其为本分支 rebase 前的 `abed913327`，不是未接入的新工作。未推送，未进行 SSH 实机验收。

### 嵌入官网的中国区会话交接

真实 Host 读取单一网页会话快照：CN 只含主 JWT 和身份/revision，不含上游 OAuth 或关联业务 JWT；旧渠道保留已有 token。国内关联账号打开 BigModel 购买页，目标 family 不变，网页拿到 CN 登录渠道与主 JWT；奖励 bridge 同样显示 ready。切换/退出/同账号重登、导航和关闭不得让迟到读取重新注入旧凭据。网页 profile 补关联和付款本身分开验收，不执行真实付费。

验证记录（2026-10-28）：`desktop-e2e-20261028132833328-p2612-de3af823140cd3dc` 先复现 CN 购买页缺少渠道标记；`desktop-e2e-20261028133623901-p9516-90e260368c1aae3f` 的购买 3 项、奖励 4 项全部通过，含旧登录、国内登录、主题/语言及匿名路径。最终 `desktop-e2e-20261028133828960-p10964-b1d69aea8c024886` 再通过两个 CN 场景，包含旧无 revision 快照在读取期间被更新、旧 JWT 被拒绝且展示重试。首轮奖励语言路由等待曾超时，单项及后续全组复跑通过；不将该次超时归因为已修复的产品语言缺陷。根类型、Lint（217 个既有警告、0 错误）、架构、格式和开源检查通过。官网配套提交 `856aa3c3`，41 个相关测试和构建/类型通过；未进行真实付款或部署后整站联调。

## 关联 JWT 拒绝恢复（ASSOC-401，本地已验证）

候选规格：`packages/desktop/test/e2e/coding-plan/account/account-key-usage-scene.test.ts`。真实 Host 的 NodeApiClient 使用本地 HTTP fixture，主登录为中国区，关联 customer ID 与主 user ID 不同。

- 普通403和成功响应不触发 profile；关联 JWT 的 HTTP401 / 数字 JSON code401 才后台刷新，不退出主登录、不重放原业务请求。
- 挂起业务响应，只改变 session revision、保留 token，释放旧401后等待后台完成日志，再断言没有 profile 请求。不能用固定等待或请求刚返回时的计数替代完成屏障。
- 挂起 profile 后再发401，只产生一个 profile；释放后后续请求使用新关联 JWT。
- JSON401触发的 profile 在退出后才回包，不得恢复 active provider 或关联记录。

2026-10-28 macOS：账号5例和原有直接 BigModel 登录401例，6/6通过；制品 `packages/desktop/.e2e-artifacts/desktop-e2e-20261028135859983-p17763-2b5fdf1570ed49cf/summary.json`。类型、Lint（217个既有警告）、架构通过。未升级用例准入状态；真实token过期、跨系统与手机/SSH实机不在本轮证据范围。

## 中国区远控鉴权（AUTH-CN-REMOTE，本地已验证）

复用 `web-remote-control-session-events.test.ts`，使用中国区原始 `user_id/name` 资料、不同的上游/关联token和有效主JWT。原Main只接受两个旧渠道，远控返回auth-required；修复为共享内置渠道判断，仍按主user ID读取和复核ZCodeJWT，不触碰或清理凭据。

真实 Main 注册设备、真实 WebSocket 在本地relay配对，实际profile补关联后维持原SID和socket；调用OAuth退出后连接关闭。2026-10-28，3/3通过：`packages/desktop/.e2e-artifacts/desktop-e2e-20261028140521667-p24525-f392f902ed90c4d1/summary.json`，另两例覆盖设备保存失败和退出后的设置失败。原实现复现：`desktop-e2e-20261028140225252-p20917-65ccfc186c7a40d1`。

只验证本地桌面/Host/Main/relay鉴权边界，未包含实体手机UI、公网relay或SSH实机；保持现有候选准入状态。

## 中国区桌面与手机页面（AUTH-CN-MOBILE，候选已运行）

候选：`packages/desktop/test/e2e/remote-control/authentication/manual-review/pending/web-remote-control-regional-login.test.ts`。独立本地relay把两份不同JWT映射至同一ZCode主体；桌面为CN原始资料，手机沿用独立存量zai浏览器登录。390px触屏Chromium配对后从真实Host显示工作区，profile补关联保持设备session；reload要求新socket成功bootstrap且包含预期工作区，不以页面壳或旧active状态作通过依据。桌面退出后新socket关闭，截图显示离线，手机存储没有CN上游或关联token。

通过制品：`packages/desktop/.e2e-artifacts/desktop-e2e-20261028141013492-p26279-ad749d8626346fe2/summary.json`，1/1。首次运行在beforeSuite因manual默认capture缺少上游配置退出，未执行断言；改为显式replay+common后通过。此场景没有模型请求。未人工转正/准入CI，不代表新区域浏览器OAuth、实体手机或公网relay已验收。

同一fixture默认模式回归：`desktop-e2e-20261028141130651-p28832-e457bc0237de5668`，原会话事件3/3通过；新区域选项默认关闭。根类型、Lint（217个既有警告）、架构、格式和开源检查通过。截图核对完成：连接页显示真实项目列表，退出页显示桌面端已离线。

## Highspeed 历史归属（HS-OWNER，候选）

已接受：无归属的旧卡停止新 healthy 查询，保留已存 TPS/分享；新卡稳定归属支持同主体重登。账号场景覆盖缺失/不同 owner 零 HTTP、同主体重登补查及迟到响应作废。

- `coding-plan/highspeed/manual-review/pending/highspeed-owner-compat.test.ts`：真实 Host/CLI 启动，在 stdio 测试代理隐藏新能力并严格检查三入口出站 metadata。旧能力只剥 owner、新能力保留；模型选择及执行 headers 保持。六个探针返回 noop，不声明模型执行。通过：`desktop-e2e-20261028151527929-p85719-04d46680d840d1a8`。
- `coding-plan/highspeed/manual-review/pending/highspeed-owner-ui-race.test.ts`：真实页面发送、HTTP 挂起及合成同主体 OAuth 完成，覆盖旧请求在途→新登录新占位→旧响应 null→唤醒检查不新增第三次请求→新响应写入权威 user row（TPS=50）。Promise 包装只观察原 RPC 的 null/usage/error，不写 store或改变结果，结束后恢复。

最终两候选组合 2/2 通过：`desktop-e2e-20261028153100161-p90889-216600b57ab8c35f`。临时移除占位 ID 比较后，`desktop-e2e-20261028153002598-p90175-e96f2725a3fa8f13` 在同一断言准确得到第三个请求（Expected 2 / Received 3）；源码已恢复后才运行最终组合。单场景先行绿测：`desktop-e2e-20261028152912920-p89379-e823326e0eea7e08`。

账号/原有 Highspeed UI 6/6：`desktop-e2e-20261028145729424-p70163-61adc30eedb15ed2`。CLI Highspeed 持久化/恢复定向4项通过；扩大两测试文件为123通过、3项 context_prefix 公告计数失败，并有12项MCP transport未处理异常。三个计数失败用HEAD原测试再次复现；没有把扩大检查写为全通过。根类型、E2E类型、Lint（217既有warning，0error）、架构通过；CLI类型34任务与Lint检查通过，保留原有warning。

上述用例保留 pending；不替代旧二进制执行、真实账号、手机或跨系统验收。

## 区域迁移的主身份与退出投影（AUTH-SUBJECT）

复用 `account-key-usage-scene.test.ts`，不新建 App 业务单测。

- AUTH-SUBJECT-01：ZCode主ID与BigModel customer ID刻意不同。真实Host启动后后台补齐业务名称，随后显式 `restoreSession`；两个入口都必须保留主ID。测试不能以停止资料更新来通过：须先观察到新的业务展示名。
- AUTH-CN-LOGOUT-01：真实CN凭据及关联套餐使AccountSource可用，调用 `oauthService.logout()`（不是Root额外刷新或 `logoutAll()`），等待Registry异步投影为不可用；只读观察，不由测试主动刷新退出后的账号状态。主登录清空必须另行断言。

原后台迁移在 `desktop-e2e-20261029021621256-p9558-2e787403549da761` 复现主ID被customer覆盖。扩展显式恢复和直接CN退出后，两条路径均复现失败。临时恢复CN旧early-return，`desktop-e2e-20261029022156679-p16379-a25a2609ce580b9a` 在5秒只读观察后仍未撤销投影，证明并非单个异步提交时隙；代码随后恢复。

最终7个账号场景全部通过：`desktop-e2e-20261029022237630-p17063-3fc7a7522b909f64`。包括真实Host后台资料补齐、显式恢复、CN直接退出及既有Key/关联401回归。首轮组合因新增case放在依赖初始seed的旧首例之前，导致该旧例缺少预设登录；调整新增case到末尾后完整通过，没有修改生产行为来适应夹具。

关联业务失效不等于主会话失效，投影残留不等于可越权调用。上述使用不同ID的合成账号，只证明客户端不错误覆盖主体；真实旧JWT与新CN账号的服务端映射、Global旧主体连续性仍待验证。

### AUTH-SUBJECT-02：Global展示恢复保留ZCode主ID

`oauth-completion-race.test.ts` 的“Global 主体恢复边界”使用不同的服务端 `user_id` 与上游 `sub`，真实Host冷启动恢复缓存后再显式恢复。旧实现将ID覆盖为上游sub，修复后保留主ID且显示名称确实更新。红灯run `desktop-e2e-20261029022653858-p23823-6c8fed7958c22f23`，最终通过run `desktop-e2e-20261029022737928-p24649-a3a78f200321173f`。本地合成账号不证明真实历史账号服务端合并。

### WEB-REGIONAL：浏览器原页授权

候选脚本 `packages/web/test/e2e/remote-control/authentication/manual-review/pending/regional-login.mjs`：remote/share × CN/Global ×390/1024×深浅主题16组合。独立边界覆盖取消、非canonical响应、跨标签新会话、旧callback不能覆盖新CN、无WebLocks与randomUUID仍可退出、同JWT新revision丢弃旧设备请求。采用本地合成接口与浏览器真实页面，未做人工转正或CI准入，不代表真实OAuth法律授权或已部署。

Web最终本地22/22通过，产物 `.tmp/regional-login-e2e/results.json`；Global展示合并后的BigModel定向回归通过 `desktop-e2e-20261029023003829-p33083-fa9d8cd280cccb7d`。旧CLI的独立验证口径不变，本批未修改CLI。

同源官网兼容补充：全球区ready响应的本次业务token与主JWT保存在同一记录；CN不保存上游token，关联BM不持久化。加入该字段后22项浏览器验收再次全部通过（本地结果文件同上）；实现 `436ccca76e`。

## 系统安全存储迁移（pending）

补充候选 `auth-config/credentials/manual-review/pending/system-credential-owner.test.ts`：启动真实 Main/Host，
仅拦截系统库边界使用合成密钥。Main 之外的读取直接失败；Host 连续/并发读取并迁移
后，断言全部成功、系统读取仅一次且来自 Main。此候选尚未人工转正，不等同于签名包
或系统授权弹窗实测；独立 CLI 仍按自身系统身份验收。

`auth-config/credentials/manual-review/pending/system-credential-storage.test.ts`：隔离目录中的合成旧明文由真实
Host 读取并委托 Main 迁移为 OS 密文；连续读取十次，重启后再次读取同值。
用例不设置管理密钥、不连接业务服务；结束清理此隔离目录专属的系统密钥。
macOS 测试 HOME 仅链接当前用户的 Keychains 目录供系统 API 查找，应用数据保持隔离，
不复制钥匙串文件、不更改默认钥匙串。
现有 OAuth race 继续使用显式合成管理密钥，验证账号会话原子更新与退出行为。
CLI 测试补充系统库不可用、密钥丢失、并发创建与旧密文迁移，不把替身测试视为
Windows/Linux 原生验收。macOS 运行 1/1 通过：
`desktop-e2e-20261029085116036-p3009-ac323f62eb79a35a`；真实 Main/Host 读写与重启均已断言。
用例仍为 pending，不做人工转正或 CI 准入。另有 OAuth/Provisioning 12 项、损坏凭据/
401/项目缓存恢复 4 项回归通过，详见系统安全存储规格。

Main 唯一 owner 候选通过 `desktop-e2e-20261029084759158-p91327-2f6c2ce829e8bb0d`。
`auth-config/credentials/manual-review/pending/system-credential-owner-mcp.test.ts` 复用完整的 MCP OAuth、
持久化和真实 CLI 工具回合，禁止 Host/CLI 读取系统库，仍只观察到一次 Main 读取；
通过 `desktop-e2e-20261029085309458-p10404-b802c5ceb4f40751`。两项均使用原生 API
边界替身，与上面的真实 macOS 测试互补，不代表 Windows/Linux 或签名包验收。

macOS 完整签名包的本机更新与凭据保留已另行通过脚本＋原生界面联合验收，
证据与范围见[系统安全存储规格](../plans/2026-10-29-system-credential-storage.md#macos-完整签名包验收2026-10-29)。
这不改变上述 pending 用例的人工转正或 CI 准入状态。

## LOGIN-LAYOUT：登录页响应式布局

按 `docs/ui/login-page.md` 的布局回归矩阵执行 `auth-config/login/manual-review/pending/login-page-layout.test.ts`。覆盖双主题、双语言、桌面/窄屏/短窗口，普通登录及 API Key 表单均需保持可达，协议不得覆盖卡片。自动验证：4 个场景通过，每个覆盖 3 个视口 × 2 种表单状态，共 24 组布局；证据 `desktop-e2e-20261102064239878-p81237-668713e65a2f83e6/login-layout/`。同批 OAuth 的旧夹具断言失败另行修复并复测，不能把整批称为通过。截图已核对，仍为 pending，未人工转正；不代表实体手机验收。

2026-11-02 集成回归：`desktop-e2e-20261102064547327-p86051-5e9d7540540ab92a` 共 14/14，通过 OAuth 10 项（包含时钟回拨/前跳/过期 init）、位置与冷缓存 Token 恢复 2 项、远控启动恢复 1 项、中国区桌面与独立浏览器手机配对 1 项。旧时钟夹具补齐关联账号身份并改为断言当前主会话；未改弱化过期校验。前一批 `desktop-e2e-20261102064239878-p81237-668713e65a2f83e6` 的 3 项损坏凭据恢复和 4 项布局用例通过；该批旧时钟夹具失败已由后续 14/14 覆盖。全部为隔离数据、本地服务及浏览器尺寸仿真，不等同于实体手机、生产后端或真实套餐验收。
