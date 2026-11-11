# 01 — Web 远控接入 Relay V2：手机登录后连接桌面

**What to build:** 把 Web 远控的 relay 层从 V1（匿名注册 + 二维码携带 `pass_hash` 的 nonce/HMAC 挑战应答）切换到 zcode-server 的 Relay V2（JWT 注册设备 + 一次性连接 token）。桌面端与手机端都只实现 V2；手机端必须用与桌面相同的账号登录，才能扫码或从设备列表选择桌面并进入现有的 workspace bridge / `rpc-frame` 链路。手机页面继续部署在 `/remote/v4`，靠 OSS 版本目录与旧版本 App 隔离。

**Blocked by:** 开发不受阻。生产发布受「补充说明 → 外部依赖」中的四项阻塞。

**Status:** ready-for-agent

**Parent:** [Web 远程控制概览与外部 Relay 架构](../../web-remote-control/web-remote-control-architecture.md)

## 问题陈述

- 服务端 Relay V2 已合入 zcode-server `staging` 并在测试环境生效，V1 入口成为受 `relay.disable_v1` 控制的遗留路径。客户端至今只有 V1 实现，V1 一旦关闭，所有版本的 Web 远控全部失效。
- V1 的安全模型是"拿到二维码 URL 的人就能控制电脑"：`pass_hash` 明文出现在 URL 中，与用户身份无关。手机端没有登录，也无法知道"我的设备有哪些"。
- 4 月为"手机登录后选设备"预留的 `/web-remote` 入口从未真正上线，生产与测试环境都被边缘网关重定向到官网 404，OAuth 回调地址也随之失效。

## 解决方案

- 桌面端启动远控前必须已登录（ZAI 或 BigModel 任一能签发 zcode JWT 的 provider）。首次启动时用 JWT 向服务端注册设备并持久化 `device_sid`；每次建连前申请一次性 `role=device` token，连接 `/api/v1/remote/ws2`。
- 二维码只携带 `app_version`、`sid`、`mid`、`name`，不再携带任何鉴权材料。
- 手机打开 `/remote/v4` 后先经过登录门禁；登录成功后，有 `sid` 直接连接该设备，无 `sid` 则连接上次设备或展示当前账号的在线设备列表。每次建连前申请 `role=terminal` token。
- OAuth 回调直接回到 `/remote/v4`（页面识别 `code`+`state`），登录态写入同源 localStorage，随后回跳到携带完整参数的原 URL。
- relay 之上的 App payload、workspace bridge、`rpc-frame` 分片/ACK、replayable 恢复、版本同步守卫全部保持不变。

## 用户故事

1. 作为桌面用户，我希望在已登录的情况下打开远控弹窗就能直接得到二维码，以便像以前一样扫码开始远控。
2. 作为桌面用户，我希望在未登录时打开远控弹窗看到"需要先登录"的提示和登录入口，以便知道为什么拿不到二维码。
3. 作为桌面用户，我希望二维码里不再包含任何秘密，以便截图或转发链接时不会泄露对电脑的控制权。
4. 作为桌面用户，我希望应用重启后"上次已开启远控"的意图仍被恢复，以便不必每次手动重开。
5. 作为桌面用户，我希望登录态失效时远控停在明确的"需要重新登录"状态而不是把整个应用登出，以便在重新登录后自动恢复远控。
6. 作为桌面用户，我希望在应用内登出时远控立即停止，以便别人不能用旧连接继续控制我的电脑。
7. 作为桌面用户，我希望切换到另一个账号后远控自动以新账号重新注册设备，以便新账号的手机能连上、旧账号的手机连不上。
8. 作为桌面用户，我希望切换 endpoint（生产/测试）后设备身份自动重建，以便不会把测试环境的 sid 带到生产。
9. 作为桌面用户，我希望远控弹窗不再出现"刷新二维码"，以便不会误以为需要刷新才能让手机连接。
10. 作为桌面用户，我希望仍能"复制链接"发到手机，以便没有扫码条件时也能进入。
11. 作为手机用户，我希望扫码后如果未登录就看到登录页，登录完成后自动回到扫码的目标设备，以便一次扫码完成全部流程。
12. 作为手机用户，我希望使用 ZAI 或 BigModel 登录，与桌面端可用的登录方式一致，以便账号能对得上。
13. 作为手机用户，我希望已登录时扫码后直接连接目标设备，不再经过任何中间页，以便速度与今天一样快。
14. 作为手机用户，我希望不扫码直接打开远控页也能登录并从列表选择我的电脑，以便电脑不在身边或二维码不方便时也能用。
15. 作为手机用户，我希望设备列表把在线设备置顶、按名字排序，离线设备灰显不可点，以便一眼找到能连的电脑。
16. 作为手机用户，我希望设备列表能手动刷新，回到前台时也自动刷新，以便电脑刚开机就能看到它上线。
17. 作为手机用户，我希望无参数打开页面时优先自动连接上次用过的电脑（若在线），以便刷新或重新打开不用重选。
18. 作为手机用户，我希望从列表选中设备后地址栏 URL 带上该设备参数，以便刷新页面或从历史记录进入都能直接恢复。
19. 作为手机用户，我希望用错误账号登录时看到"该设备不属于当前账号"并能一键切换账号，以便知道该怎么做。
20. 作为手机用户，我希望目标设备已被移除时也能被告知并可去选择其他设备，以便不卡在错误页。
21. 作为手机用户，我希望电脑端短暂断线、relay 滚动发布时页面能自动恢复，以便不必手动刷新。
22. 作为手机用户，我希望登录态过期时被带回登录页并在登录后回到原来的位置，以便中断最小。
23. 作为手机用户，我希望另一台手机接管连接时本机停止重连并明确提示，以便两台手机不会互相踢来踢去。
24. 作为手机用户，我希望进入聊天后的任务列表、消息流、权限请求、断线重连、快照对齐都与现在完全一样，以便升级对我不可见。
25. 作为手机用户，我希望桌面升级到新版本后页面提示我重新加载到匹配版本，以便不会停在过期页面。
26. 作为安全评审者，我希望手机能否控制电脑完全由"是否为同一账号"决定，以便 URL 泄露不再等于失控。
27. 作为安全评审者，我希望一次性 token 只在建连前申请、不落盘、不进日志，以便凭据暴露面最小。
28. 作为安全评审者，我希望 JWT 只保存在既有的凭据存储（桌面 credential service、手机同源 localStorage）中，不进入二维码、relay 消息或设置文件。
29. 作为运维人员，我希望新版本桌面只走 V2、旧版本继续走 V1，以便可以按现有 `relay.disable_v1` 节奏关闭 V1。
30. 作为运维人员，我希望新手机页面只以新版本目录发布，不覆盖旧 App 使用的页面，以便发布不会打挂在网旧版本。
31. 作为运维人员，我希望旧的 Docker 构建链从仓库移除，以便不会有人误把 V2 页面发到旧的单一部署上。
32. 作为运维人员，我希望配对成功/失败等既有遥测保持不变，以便升级前后的指标可比。
33. 作为开发者，我希望能用测试环境（已部署 V2）与真实手机完成联调，且不占用新的正式版本号。
34. 作为开发者，我希望两端 transport、manager、手机端前置编排都有针对假 relay 的自动化测试，以便不依赖线上环境验证握手、心跳与错误处理。
35. 作为开发者，我希望 spec 与架构文档更新到 V2 的最终行为，以便后续维护不再对照 V1 描述。

## 实现决策

### A. 范围与兼容

- 新版本桌面与手机页面只实现 V2。删除两端 V1 transport、HMAC proof 计算、`pass_hash` 存储，以及 shared 中的 V1 relay 消息类型和 proof 测试向量；新增 V2 relay 消息类型和设备/token HTTP 契约类型，两端共用。
- 手机入口保持 `/remote/v4`。版本隔离依赖 OSS 多版本发布：桌面二维码携带自身 `app_version`，网关按版本目录取页面；3.13.0 及更早的 App 继续使用各自 tag 构建的 V1 页面。不做双模式，不新增 `/remote/v5`。
- 删除 `/remote`、`/remote/v3`、`/remote/v4` 三条 Docker 构建链（Dockerfile、nginx 配置、构建/推送/验证脚本、package.json 命令及文档中对 旧基础设施仓库及其路径变量 的引用）；保留 `/remote/__test__` 测试链和 OSS 流水线。文档标注旧部署冻结在最后一次 V1 镜像。
- 删除 `/web-remote` 路由判断、已登录等待页、`remoteControlToken`/`relayOrigin` 旧 bootstrap 及其 `/api/remote-control/*` 请求；复用登录页、回调页、Web 认证服务、浏览器 OAuth 凭据仓库和 OAuth state 编解码。4 月的 Web 远控登录设计文档顶部标注被本 spec 取代。
- 纯客户端适配，不向 zcode-server 提任何改动，全部按 staging 现有契约实现。

### B. 桌面端：登录门禁与设备身份

- 已登录的判定：凭据存储中存在 `zcodejwttoken`。ZAI 与 BigModel 两个 provider 都满足。
- 未登录时远控弹窗展示"需要先登录"状态并提供登录入口；此时不注册设备、不连接 relay、不签发内部启动票据。
- 懒注册：首次启动远控且已登录时调用设备注册接口，`device_mid` 沿用现有桌面 deviceMid（uuid，仅展示与网关哈希用途），`meta.name` 为主机名。持久化 `{deviceSid, userId, endpointOrigin}` 到 AppSettings，不再写入 credential。
- 身份重绑：启动远控时若当前登录用户 id 或 endpoint origin 与持久化记录不一致，或服务端在 `auth_init` 返回 `AUTH_FAILED`，则重新注册并尽力调用删除接口清理旧记录（失败忽略，不阻塞）。
- 首次进入 V2 时直接删除 V1 遗留的 `deviceSid` 设置与 `passHash` credential，不迁移。
- 新增 renderer→main 单向登录状态通知：登录成功后 main 重试恢复"上次已启用"目标（仍要求窗口 workspace 已同步）；登出后 main 停止当前 runtime、状态置 `auth-required`，但不清除已启用记录。应用启动时若无 JWT，恢复流程停在 `auth-required` 等待该通知。
- 弹窗删除"刷新二维码"按钮、确认弹窗及 `resetPairingAuthorized` IPC；保留"复制链接"。IPC 依赖面收敛为 `authorizeStart`、`startAuthorized`、`stop`、`getStatus`。

### C. 桌面端：连接与 token

- 每次建连前用 JWT 调用 token 接口申请 `role=device` 的一次性 token；WebSocket 地址为 `wss://<endpoint origin>/api/v1/remote/ws2?token=<token>&mid=<deviceMid>`。任何一次 WebSocket 失败都重新申请 token，不复用 URL。删除 `X-Device-ID` 请求头。`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 调试覆盖保留，语义改为 V2 地址；test endpoint 继续映射到测试域名。
- `auth_init` 只带 `device_sid`、`meta`、`client_ts`，不带 `role`；`pair_status_query` 不带 `device_sid`；`client_ts` 使用 Unix 秒。
- 心跳基准 5 秒、jitter ±1 秒、ACK watchdog 15 秒；沿用递归 `setTimeout`、不补发历史心跳、watchdog 触发重连附加小幅随机延迟的既有约束。
- `KICKED` 有界重试：延迟 2~5 秒随机后换新 token 重连一次；60 秒内再次收到 `KICKED` 则停止自动重连，状态置 `kicked`，对外 failure 为 `session-conflict`。
- token 接口 401 → 新 failure reason `auth-required`，runtime 进入 `error` 并停止自动重连，不触发全局登出，不清除已启用记录。5xx 与网络错误按 1 秒起、上限 30 秒、带 jitter 的指数退避重试，`auth_ack` 后清零；其他 4xx → `relay-unavailable` 终态。
- 桌面 main 直接用 Node 全局 fetch 携带 `Authorization: Bearer <jwt>` 调用设备与 token 接口，不经过 services 进程，不复用 services 侧的 401 全局登出观察器。

```text
桌面 device 状态机（V2）
idle ─start─▶ auth-check ─无JWT─▶ auth-required（等待登录通知）
   │                └有JWT─▶ registering（无 sid / 身份不一致时）─ack─▶ token-acquiring
   │                                                            └────────▶ token-acquiring
token-acquiring ─token─▶ connecting ─open─▶ authenticating(auth_init) ─auth_ack─▶ waiting_terminal | paired
   │ 401 → auth-required（终态，等待登录通知）
   │ 5xx/网络 → backoff → token-acquiring
paired/waiting_terminal ─KICKED(首次)─▶ delay 2~5s → token-acquiring
                        ─KICKED(60s 内第二次)─▶ kicked（终态，session-conflict）
                        ─ACK watchdog 15s / socket close─▶ token-acquiring
```

### D. 手机端：登录、选设备与连接

- `/remote/v4` 的解析：URL 含 `code`+`state` 时进入 OAuth 回调模式；否则读取 `app_version`、`sid`、`mid`、`name`，三者均可选。删除 `hash`、`t`。
- OAuth `redirect_uri` 为 `<origin>/remote/v4`。`app_return_to` 白名单从只允许 `/web-remote` 改为允许 `/remote/v4`（含尾斜杠）与既有分享路径；query 放行 `app_version`、`sid`、`mid`、`name`。回调完成后 `location.replace` 到 `app_return_to`，由网关按 `app_version` 选版本。开发态 `return_to` 转发机制保留。
- 登录门禁：未登录先渲染现有登录页（provider 跟随构建环境）；已登录进入连接前置编排。
- 落点规则：有 `sid` → 直接连接；无 `sid` → 读 localStorage 最近设备，调用设备列表接口确认在线则直接连接，否则渲染设备列表页。连接失败页提供"选择其他设备"进入列表。
- 设备列表：进入时拉取、手动刷新、`visibilitychange` 回前台再拉，不轮询。在线设备置顶并按 `meta.name` 排序；离线设备灰显、不可点，显示 `device_mid` 前 8 位。列表页与登录页都是连接前的独立全屏页，窄屏宽屏同一布局，不进入 `Root`/侧栏 shell，沿用登录页样式与 `zai-dark` 默认主题，文案进 `zh-CN`/`en-US`。
- 选中设备后用 `history.replaceState` 把 `app_version`（保留原值）、`sid`、`mid`、`name` 写回 URL，并把最近 sid 写入 localStorage；按 sid 键控的既有本地状态继续可用。
- 每次建连前用 localStorage 中的 JWT 申请 `role=terminal` token，连接 `wss://<origin>/api/v1/remote/ws2?token=…&mid=…`（`mid` 取 URL 参数或设备列表的 `device_mid`）。401 → 清除本地会话、回登录页，`app_return_to` 保留当前完整 URL。5xx/网络错误沿用现有 500ms×2ⁿ、上限 10 秒退避。
- 错误映射：`auth_init` 后 `AUTH_FAILED` → 新 failure reason `device-not-owned`，失败页提供"切换账号"（登出后回登录页并保留返回地址）与"选择其他设备"两个动作；`WRONG_PARAM` → `invalid-mobile-connection`；`DEVICE_OFFLINE` 沿用现有宽限恢复；`KICKED` 与桌面同一有界重试策略，二次 `KICKED` → `session-conflict`；`INTERNAL` 沿用现有可恢复处理。
- 心跳、watchdog、`client_ts`、`auth_init`/`pair_status_query` 字段与桌面一致。
- bootstrap-request/response、workspace-list、workspace-bridge-open/ready、rpc-frame/ack、`mobile-view-state-update`、版本同步守卫、replayable 恢复顺序全部不变。

```text
手机端首次进入（V2）
打开 /remote/v4?app_version&sid&mid&name
  ├─ 含 code+state ─▶ 回调页换 token → localStorage → replace(app_return_to)
  ├─ 无 JWT ─▶ 登录页 ─▶ OAuth（redirect_uri=/remote/v4，state.app_return_to=当前 URL）
  └─ 有 JWT
       ├─ 有 sid ─▶ 申请 terminal token ─▶ ws2 ─▶ auth_init(sid) ─▶ auth_ack
       │                                          └─ AUTH_FAILED → device-not-owned 失败页
       └─ 无 sid ─▶ 最近设备在线? ─是─▶ 同上
                                  └否─▶ 设备列表页 ─选中─▶ replaceState(URL) ─▶ 同上
auth_ack(matched) ─▶ bootstrap-request ─▶ 版本守卫 ─▶ workspace-bridge-open ─▶ 现有链路
```

### E. 部署与联调

- 手机页面通过既有 OSS 多版本流水线发布到 `/remote/v4/<version>/`，页面路由仍是 `/remote/v4`。桌面二维码路径选择逻辑（≥3.4.0 用 v4）不变。
- 联调阶段分支保持根 `package.json` 版本 `3.13.0`，用 OSS 测试流水线覆盖测试环境 `3.13.0/` 目录；桌面 dev 走 test endpoint。本地快速迭代用开发态 `return_to` 转发在测试域名完成一次登录后读同源 localStorage。测试环境仍使用 3.13.0 V1 桌面版的同事在此期间无法配对，需知会。

### F. 文档

- 新建 `docs/web-remote-control/relay-v2-pairing.md`：注册/token/握手时序图、两端 transport 状态机、KICKED 有界重试、`auth-required`/`device-not-owned` 语义、验收场景与已知限制。
- 架构文档的 Transport、Desktop Main、Web 三节改为 V2 描述并链接新文档，删除 V1 与 Docker 部署段落；`remote-v4-static-deployment.md` 删除 Docker 链路描述、保留 OSS 与版本同步；`web-remote-login.md` 改写为 `/remote/v4` 的 V2 登录门禁。

## 测试决策

- 好的测试只观察外部行为：relay 线上收到了什么消息、HTTP 接口被以什么参数调用、runtime status/failure 对外呈现什么、页面在什么状态渲染什么、URL/localStorage 变成什么。不断言私有状态或定时器句柄。
- 唯一新增的测试夹具是**假 relay V2**：进程内同时提供设备注册/列表/删除、token 签发的 HTTP 处理器和 `/ws2` WebSocket 服务器，可编排 `auth_ack` 的 `pair_status`、`KICKED`、`AUTH_FAILED`、`DEVICE_OFFLINE`、`INTERNAL`、断连以及 HTTP 401/5xx。桌面与手机两端测试共用。先例：两端现有 transport 测试用本地 WebSocketServer 扮演 relay。
- 桌面端主接缝是 manager 公开接口：注入真实 V2 transport、假 relay、假凭据读取与假登录状态通知，覆盖未登录拒绝启动、懒注册与持久化、用户/endpoint 变化重注册并尽力删除、`AUTH_FAILED` 重注册、token 401 → `auth-required` 且不清已启用记录、登出停止、登录后恢复、二维码 URL 形态、`KICKED` 有界重试的对外 status。先例：manager 外部 relay 测试。心跳 5 秒/jitter/watchdog 15 秒、`client_ts` 秒、`auth_init` 字段、`pair_status_query` 字段、退避序列等线级细节在 transport 对假 relay 的测试中用 fake timers 覆盖。先例：两端 transport 测试、shared 心跳测试。
- 手机端主接缝是抽出的连接前置编排模块：注入登录态、设备接口、location/history/localStorage 与 transport 工厂，覆盖回调模式识别、登录门禁、有/无 sid 落点、最近设备在线/离线分流、列表排序与刷新触发、选中后 URL 回写、401 回登录并保留返回地址、`device-not-owned` 动作。先例：web 路由、失败原因、bootstrap shell 与 lifecycle 测试。terminal transport 对假 relay 的测试同桌面。
- shared：二维码 URL 构建/解析（无 `hash`/`t`，`sid` 可选）、V2 消息类型的运行时校验、OAuth state 白名单与 query 放行。先例：shared web remote control 测试、web 认证相关测试。
- UI 验收：06 的设备列表页是唯一全新页面，实现前在 `relay-v2-pairing.md` 附文本线框与文案表（页头与切换账号入口、列表项排布、在线标识、离线灰显、空态、刷新按钮落点），经用户确认后再实现；03/04/05 只在既有弹窗、登录页、失败页上增减状态，新增文案在各票文档先行时列出供确认。所有触及 UI 的票实现后提供截图矩阵：桌面为深浅主题 × zh-CN/en-US（04 的 E2E 顺带产出），手机为窄屏/宽屏 × 深浅主题 × zh-CN/en-US（参考 `packages/web/test/e2e/remote-control/transport/manual-review/pending/remote-version.mjs` 新增 pending 截图用例，不自动转正）。
- 桌面 E2E 只新增一条："未登录时打开远控弹窗展示需要登录，且 main 未发起任何注册或 relay 连接"，按 E2E 工作流 skill 新增与转正。
- 真机验收在测试环境手工执行并写入新文档：扫码首次登录、已登录直连、无码选设备、账号不匹配、另一台手机接管、桌面登出/登录、relay 滚动导致的 `KICKED` 恢复。
- 必要验证按 AGENTS：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测与新增 E2E。

## 范围外

- 多窗口各自启动远控共用同一设备身份导致互踢；保持现状，仅在文档记录风险。
- 手机端删除设备、重命名设备、设备管理页；桌面端"重新注册此设备"排障入口。
- 任何 zcode-server 改动（区分 `KICKED` 与 owner 丢失、持久化离线设备 `meta`、`client_ts` 单位说明）。
- V1 关闭时机与 `relay.disable_v1` 切换；旧版本 App 的兼容维护。
- 未登录用户的远控能力；除 ZAI、BigModel 外的登录方式。
- 网关、ESA、OSS、OAuth 白名单等基础设施变更本身（只在本 spec 列出需求与验收方法）。
- 遥测新增协议版本维度；`WebRemoteControlStatus` 中与本次无关的历史字段清理；`/remote/__test__` 链路与分享页。

## 补充说明

### 外部依赖（阻塞生产发布，不阻塞开发）

| 项                                                                                           | 归属                              | 现状                                                                                                      | 验收方法                                                   |
| -------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 生产 zcode-server 部署 V2                                                                    | 服务端                            | `zcode.z.ai/api/v1/remote/token` 返回 404                                                                 | 该接口无 JWT 返回 401                                      |
| 生产网关将 `/api/v1/remote/ws2` 精确转发到 V2 relay，device 与 terminal 按 `mid` 落同一实例  | ESA/阿里云网关维护方              | 当前按 `/api/v1/remote/ws` 前缀落到 V1 处理器（返回 400）                                                 | 无 token 返回 401；同 `mid` 两端配对稳定                   |
| 生产网关按 `app_version` 取 OSS `<version>/index.html`，`/remote/v4/<dir>/<path>` 取对应目录 | ESA/阿里云网关维护方              | 测试环境已生效；生产对所有版本返回同一份 index，`/remote/v4/3.13.0/release-manifest.json` 返回 index.html | 该 manifest 返回 JSON；不同 `app_version` 返回各自版本资源 |
| OAuth 白名单登记 `https://zcode.z.ai/remote/v4` 与 `https://zcode.z.ai/remote/v4`    | 与 ZAI、BigModel OAuth 提供方沟通 | 未开始                                                                                                    | 测试环境完成一次真实登录回跳                               |

旧基础设施仓库已不再承载 zcode.z.ai 的后端与前端配置，本任务不对其做任何改动。

### 发布顺序

生产服务端 V2 → 网关两条规则 → OAuth 白名单 → 手机页面以新版本目录发布 → 携带该版本号的桌面 App 发布。手动 latest job 在网关支持版本目录之前不运行。

### 已知限制

- 手机若使用升级前保存的旧链接（旧 `app_version`）连接 V2 桌面，会进入 V1 页面并停在"等待电脑端"，无法自动纠正，需重新扫描当前二维码。
- 服务端对离线设备不返回 `meta`，列表中离线设备只能显示 `device_mid` 片段。
- 服务端对"被替换"与"owner 丢失"都发送 `KICKED`，客户端以有界重试折中；服务端若日后区分错误码，可退回"收到即停止"。

### 与上位规则的关系

- 桌面 `desktop-continuous` 与手机 `web-remote-replayable` 的恢复边界、workspaceIdentity/workspacePath 分离、relay 不解析业务 payload、main 不持有 task/stream 状态等既有约束全部保持。
- 一次性内部启动票据、IPC 依赖面收敛（去掉 `resetPairingAuthorized`）与 Office XSS 补偿边界的说明保持有效。

## 验收标准

- [ ] 未登录桌面打开远控弹窗：显示需要登录，不注册设备、不连接 relay、状态不含二维码。
- [ ] 已登录首次启动：完成注册并持久化 `{deviceSid, userId, endpointOrigin}`，二维码为 `/remote/v4?app_version&sid&mid&name`，不含 `hash`/`t`；V1 遗留 sid/passHash 已清除。
- [ ] 用户或 endpoint 变化、`auth_init` 返回 `AUTH_FAILED`：重新注册并尽力删除旧记录；删除失败不影响启动。
- [ ] 每次建连前申请新 token，`auth_init` 无 `role`，`pair_status_query` 无 `device_sid`，`client_ts` 为秒，心跳 5 秒 ±1 秒，15 秒无 ACK 重连。
- [ ] token 401：状态 `error`/`auth-required`，停止重连，不登出，已启用记录保留；登录通知后自动恢复。登出通知：runtime 停止并置 `auth-required`。
- [ ] `KICKED`：首次延迟 2~5 秒换 token 重连；60 秒内第二次停止并报 `session-conflict`。
- [ ] 手机带 `sid` 未登录：登录页 → OAuth 回到 `/remote/v4` 回调模式 → 回跳原 URL → 直接连接。已登录带 `sid`：直接连接。
- [ ] 手机无 `sid`：最近设备在线则直连，否则列表页；列表在线置顶按名排序、离线灰显不可点、支持手动与回前台刷新；选中后 URL 回写且刷新可恢复。
- [ ] 手机 `AUTH_FAILED`：`device-not-owned` 失败页含"切换账号"与"选择其他设备"；401：回登录页并在登录后回到原 URL。
- [ ] 进入聊天后 bootstrap、bridge、`rpc-frame`、replayable 恢复、版本守卫行为与升级前一致。
- [ ] 仓库不再包含 v2/v3/v4 Docker 构建链与 已迁走基础设施的引用；`/remote/__test__` 与 OSS 流水线可用；两端 V1 代码与 shared V1 类型已删除。
- [ ] 新文档与三份既有文档更新到最终行为；4 月登录设计文档标注被取代。
- [ ] typecheck、lint、架构检查、受影响单测、新增 E2E 通过；测试环境真机验收步骤已记录。
