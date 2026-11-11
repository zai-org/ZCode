# 03 — 桌面端以 V2 注册设备、申请 token 并配对

**What to build:** 已登录的桌面用户打开远控弹窗后，桌面 main 用 zcode JWT 懒注册设备并持久化身份，每次建连前申请一次性 `role=device` token，连接 `/api/v1/remote/ws2` 完成 `auth_init`/`auth_ack`，弹窗展示新的二维码 `/remote/v4?app_version&sid&mid&name`。5 秒心跳、15 秒 ACK watchdog、`KICKED` 有界重试、token 失败退避全部生效；"刷新二维码"入口移除。桌面端此后只有 V2 实现。在测试环境可演示：桌面拿到二维码并进入等待手机状态；配对成功可用假 relay 验证。

**Blocked by:** 02

**Status:** in-progress

**Parent:** [Web 远控接入 Relay V2：手机登录后连接桌面](./01-relay-v2-login-pairing.md)

## 验收标准

- [x] 文档先行：`relay-v2-pairing.md` 补桌面 device 的注册/token/握手时序图与 transport 状态机；架构文档 Transport 与 Desktop Main 两节改为 V2 描述并链接新文档。
- [x] 新的桌面 device transport（独立类；心跳调度、pair_status 状态迁移、有界重试抽成可与手机端共用的 helper）：建连前通过注入的 token 获取函数申请 token；地址 `wss://<endpoint origin>/api/v1/remote/ws2?token=…&mid=<deviceMid>`；不再发送 `X-Device-ID`；`auth_init` 只带 `device_sid`、`meta`、`client_ts`（秒）；`pair_status_query` 不带 `device_sid`；心跳 5 秒 ±1 秒，15 秒无 ACK 重连；任何一次重连都重新申请 token，不复用 URL。
- [x] `KICKED`：首次延迟 2~5 秒随机后换 token 重连一次；60 秒内再次收到则停止自动重连，transport 置 `kicked`，对外 failure 为 `session-conflict`。
- [x] manager 懒注册：首次启动且已登录时调用设备注册接口（`device_mid` 沿用桌面 deviceMid，`meta.name` 为主机名），持久化 `{deviceSid, userId, endpointOrigin}` 到 AppSettings，不写 credential。当前用户 id 或 endpoint 与持久化不一致、或 `auth_init` 返回 `AUTH_FAILED` 时重新注册，并尽力调用删除接口清理旧记录，失败不阻塞。
- [x] 首次进入 V2 时删除 V1 遗留的 `deviceSid` 设置与 `passHash` credential；桌面 V1 transport、HMAC proof 计算与 passHash 存储 provider 一并删除，对应旧测试删除或改写。
- [x] 本票内无 JWT 时 `startAuthorized` 返回明确失败、不注册不连接（弹窗的"需要登录"状态与登录联动在 03 完成后由 04 承接）。
- [x] token 接口 401 → 新 failure reason `auth-required`，runtime 进入 `error`、停止自动重连、不触发全局登出、不清除已启用记录。5xx 与网络错误按 1 秒起、上限 30 秒、带 jitter 的指数退避，`auth_ack` 后清零；其他 4xx → `relay-unavailable`。
- [x] 桌面 main 直接用 Node fetch 携带 `Authorization: Bearer <jwt>` 调用设备与 token 接口，不经 services 进程。relay 地址推导改为 `/api/v1/remote/ws2`，test endpoint 映射保留，`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 覆盖语义改为 V2 地址。
- [x] 二维码与"复制链接"URL 为 `/remote/v4?app_version=<ver>&sid=<device_sid>&mid=<mid>&name=<hostname>`，不含 `hash`/`t`。弹窗删除"刷新二维码"按钮、确认弹窗与 `resetPairingAuthorized` IPC；renderer 可达的 manager 依赖面只剩 `authorizeStart`、`startAuthorized`、`stop`、`getStatus`。一次性内部启动票据边界不变。
- [x] 视觉核对：实现后提供弹窗截图（深浅主题 × zh-CN/en-US），确认"刷新二维码"入口已移除、二维码与复制链接区域布局无回归。
- [x] 测试（接缝：manager 公开接口 + 真实 transport + 假 relay）：懒注册与持久化、用户/endpoint 变化重注册并尽力删除、`AUTH_FAILED` 重注册、token 401 → `auth-required` 且已启用记录保留、二维码 URL 形态、`KICKED` 有界重试的对外 status。
- [x] 测试（接缝：transport 对假 relay，fake timers）：`auth_init`/`pair_status_query` 字段、`client_ts` 秒、心跳与 jitter、15 秒 watchdog、退避序列、每次重连重新申请 token、`KICKED` 计数窗口。
- [ ] 手工验证：桌面 dev 走 test endpoint，已登录时弹窗出现二维码，日志显示注册、token、`auth_ack` waiting。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测通过。

## 验证记录（2026-09-19）

实现与双轴评审已完成；保留 `in-progress`，等待已登录 test endpoint 的真实联调与验证门禁收口。

- TDD 接缝：manager 公开 API + 真实 transport + loopback 假 relay；transport 假时钟覆盖握手、秒级时间戳、4~6秒心跳、15秒 watchdog、退避、401/4xx、KICKED窗口、双端配对与断开。额外回归覆盖 AUTH_FAILED 后注册5xx重试、首次30秒等待超时后后台恢复仍保存启用意图。
- 最终定向验证：8个相关测试文件共132项用例通过（最后的manager边界修复复跑2文件65项）；根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`git diff --check` 通过，lint有60项存量warning、0 error。补充main独立tsconfig检查暴露既有rootDir/浏览器类型等错误；本次新增main文件无类型报错，未扩大范围修复存量main配置。
- 最后补充回归：workspace关闭通知不能将token401终止的 `error/auth-required` 改写为running，已通过回归与Spec复核。
- 双轴评审：Standards 无发现；Spec 发现后台恢复持久化与连接成功遥测两项问题，均修复并复核通过。
- 全量 `pnpm test:unit`：1916文件通过、1失败、2跳过；17937用例通过、1失败、12跳过。失败为未改动的 `packages/desktop/test/e2e/feedback/upload/feedback-upload-privacy.test.ts:105` 使用 `/private/tmp`，触发 `e2eRuntimePaths.test.ts`；单独重跑同样失败，与本票代码无关。
- 桌面标准 `pnpm dev:desktop:test`：首次缺失 CUA 原生 addon，已在安装依赖内补建；随后 CLI `node-repl-host` 编译因缺少 `@zcode/core/browser-client`、`@zcode/contracts/tools/node-repl` 等声明而失败，未修改 CLI。
- `ZCODE_ENV=test pnpm --filter @zcode/desktop dev:runtime` 可构建并启动当前 main/renderer，但现有存储准备报 `transport_closed`；直接经真实 preload/main 启动远控返回 `auth-required`，当前无可用 JWT，因此没有注册/token/auth_ack waiting 的线上联调证据。
- 视觉：实际 Electron renderer + 生产弹窗组件，注入明确标记的 waiting 测试状态，桌面1440×1040与窄屏390×844、zh-CN/en-US、Zai Light/Zai Dark共8张。二维码可见、无刷新按钮、复制链接行无横向溢出；窄屏沿用弹窗内部滚动。这些截图不替代已登录真实 relay 联调，也不声称手机V2业务链路已实现。
- 截图及机器检查结果：本机会话产物 `~/.codex/visualizations/2026/09/19/01a0b79b-ac3d-76d3-99d7-6cc72352d1e6/relay03/`，包含 `desktop-<locale>-<theme>.png`、`mobile-<locale>-<theme>.png` 和 `evidence.json`。临时renderer夹具已移出源码目录，测试启动的dev进程已停止。
- 原有02票工作区改动保留；本票不将它们混入提交。全量检查仍有失败且真实联调未完成，按根规则暂不自动commit。
