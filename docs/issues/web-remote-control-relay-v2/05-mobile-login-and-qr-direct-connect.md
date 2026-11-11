# 05 — 手机端登录后凭二维码直连桌面

**What to build:** 手机打开 `/remote/v4?app_version&sid&mid&name`：未登录先进入登录页，OAuth 回调直接回到 `/remote/v4`（页面识别 `code`+`state`），登录态写入同源 localStorage 后回跳原 URL；已登录时申请 `role=terminal` token、连接 `/api/v1/remote/ws2`、`auth_init(sid)`，配对后进入现有 bootstrap → workspace bridge → `rpc-frame` 链路，聊天体验与升级前一致。账号不匹配显示"该设备不属于当前账号"并可切换账号；登录态失效回登录页并在登录后回到原位置；`KICKED` 有界重试。手机端此后只有 V2 实现，`/web-remote` 旧入口移除。

**Blocked by:** 02（真机联调另需 03 已可用）

**Status:** in-progress

**Parent:** [Web 远控接入 Relay V2：手机登录后连接桌面](./01-relay-v2-login-pairing.md)

## 验收标准

- [x] 文档先行：`relay-v2-pairing.md` 补手机首次进入时序图（回调模式 / 登录门禁 / 有 sid 直连）；`web-remote-login.md` 改写为 `/remote/v4` 的 V2 登录门禁；架构文档 Web 节改为 V2；列出登录门禁、无 `sid` 占位页、`device-not-owned` 与 `invalid-mobile-connection` 失败页的 zh-CN/en-US 文案表供确认。
- [x] 入口：`/remote/v4` 含 `code`+`state` 时进入 OAuth 回调模式（复用回调页与 Web 认证服务）；OAuth `redirect_uri` 改为 `<origin>/remote/v4`，shared 的回调地址推导同步修改；`app_return_to` 白名单允许 `/remote/v4`（含尾斜杠）与既有分享路径，query 放行 `app_version`、`sid`、`mid`、`name`；开发态 `return_to` 转发机制保留。
- [x] 登录门禁：无 JWT 渲染现有登录页（provider 跟随构建环境），`appReturnTo` 为当前完整 URL；登录成功回跳后自动继续连接。
- [x] 新增连接前置编排模块（可注入登录态、设备接口、location/history/localStorage、transport 工厂）：有 `sid` → 直接连接；无 `sid` → 本票先渲染"请扫描桌面二维码"占位（设备列表由 06 提供）。
- [x] 新的 terminal transport V2（与桌面共用心跳/pair_status/有界重试 helper）：建连前用 localStorage 中的 JWT 申请 `role=terminal` token；地址 `wss://<origin>/api/v1/remote/ws2?token=…&mid=…`（`mid` 取 URL 参数）；`auth_init` 字段、`client_ts` 秒、5 秒心跳、15 秒 watchdog、每次重连重新申请 token、`KICKED` 有界重试与桌面一致。
- [x] 错误映射：token 401 → 清除本地会话、回登录页并保留当前完整 URL 为返回地址；5xx/网络错误沿用现有 500ms×2ⁿ、上限 10 秒退避；`auth_init` 后 `AUTH_FAILED` → 新 failure reason `device-not-owned`，失败页含"切换账号"（登出后回登录页并保留返回地址）与"选择其他设备"（06 前隐藏或禁用），失败页为此新增次级动作位（主按钮下方、ghost 样式，遵循 DESIGN.md）；`WRONG_PARAM` → `invalid-mobile-connection`；`DEVICE_OFFLINE`、`INTERNAL` 沿用现有可恢复处理；二次 `KICKED` → `session-conflict`。
- [x] 视觉核对：实现后提供手机端截图矩阵（登录门禁页、无 `sid` 占位页、`device-not-owned` 失败页；窄屏/宽屏 × 深浅主题 × zh-CN/en-US），参考 `packages/web/test/e2e/remote-control/transport/manual-review/pending/remote-version.mjs` 新增 pending 截图用例，不自动转正。
- [x] 手机 V1 terminal transport、浏览器端 HMAC proof 计算、`/web-remote` 路由判断、已登录等待页、`remoteControlToken`/`relayOrigin` 旧 bootstrap 及其 `/api/remote-control/*` 请求代码删除；对应旧测试删除或改写。
- [x] bootstrap-request/response、workspace-list、workspace-bridge-open/ready、`rpc-frame`/ack、`mobile-view-state-update`、版本同步守卫、replayable 恢复顺序不变，既有回归测试全部通过。
- [x] 测试（接缝：前置编排模块 + 假 relay + 假 fetch/location/storage）：回调模式识别与回跳、登录门禁、有 sid 直连、401 回登录并保留返回地址、`device-not-owned` 动作；transport 对假 relay 的线级测试同桌面；shared/web 的 URL 解析、白名单与 query 放行测试。
- [ ] 测试环境验收：分支保持根 `package.json` 版本 `3.13.0`，用 OSS 测试流水线覆盖 `3.13.0/` 目录（先知会仍用 3.13.0 V1 桌面版的同事）；真机完成"扫码首次登录 → 回跳 → 连接"与"已登录直连"两条路径，记录到 `relay-v2-pairing.md` 验收节。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测通过。

## 验证记录（2026-09-19）

- 本地实现与评审完成；保留 in-progress，等待 OSS/真实手机验收。
- Web 测试集31文件296项通过；桌面/手机 transport 定向回归48项通过；开发启动脚本回归通过。新增挂起迟到 open/ACK、KICKED 跨代 waiting timer 回归均先复现再修复。
- `pnpm typecheck`、`pnpm lint`（60条既有 warning，0 error）、`pnpm architecture:check --changed` 通过。
- ML01–ML06 浏览器27项检查通过，24张窄/宽屏×主题×语言截图位于 `.tmp/remote-login-v2-e2e/`；圆角、浅色徽标对比度调整后对应截图已更新，保持 pending。RV01–RV03 浏览器6组配置通过，原有 home-only 动态订阅告警如实保留。
- 全量 `pnpm test:unit`：17,988通过、12跳过、1失败；失败来自本票未改动的 `packages/desktop/test/e2e/feedback/upload/feedback-upload-privacy.test.ts:105` 使用 `/private/tmp`，触发 e2eRuntimePaths 检查。另发现旧 home-only fixture 缺少 location.href 的未处理错误，已补齐并由上述 Web 全集复跑确认消除；未再次全跑无关用例。
- 按根 AGENTS.md 必要验证失败不自动提交的规则保留工作区；用户原有02–04改动不纳入本票提交。
- 未触发 OSS 覆盖流水线，未通知同事，未执行真实手机 OAuth 两条路径；需先完成3.13.0 V1使用者协调及测试部署，人工结果写入 relay-v2-pairing.md。
