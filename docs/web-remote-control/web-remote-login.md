# Web Remote Login V2

`/remote/v4`（含尾斜杠）是手机远控唯一正式 OAuth/二维码入口。手机只使用 Relay V2；`/web-remote`、其回调与等待页、remoteControlToken/relayOrigin bootstrap 已移除。普通 Web + Server 的 `/ws`、`/ws/remote/:id` 保持不变。

## 入口与认证

- `code` / `authCode` + `state`（或 OAuth `error` + `state`）优先渲染现有 `WebCallbackPage`，由 `WebAuthService` 校验 nonce、交换 token、写入同源 localStorage，再 replace 安全 app_return_to。
- OAuth 回调地址以构建 endpoint origin 的 `/remote/v4` 为基址，保留登录前同源远控 URL 的 `app_version/sid/mid/name` 参数（含空值与编码后的设备名）。不复制未知参数、旧凭据、历史 code/authCode/state/error 或 fragment；分享登录保持独立回调地址。Z.AI 使用 `redirect_uri`，BigModel 使用 `redirect`，授权 origin 随构建环境变化。
- `WebAuthService` 在发起授权时通过 `BrowserOAuthCredentialRepo` 把本次登录记录（nonce、provider、完整回调地址）保存在同源 localStorage，按 nonce 区分。回调只取出 state 中 nonce 对应的那一条，取出即删除，再用该记录的 provider 与地址交换 token；找不到记录时报 CSRF 失败，不请求 token，也不改动其他记录。不得从含授权参数的回调 URL 拼出 token 请求地址。原因与边界见[回调落到同一浏览器的其他标签页](#回调落到同一浏览器的其他标签页)。
- 无 JWT 时展示与桌面一致的 Z.AI / BigModel 两个 OAuth 入口（Z.AI 在前，使用桌面同款图标、连接文案与全球/中国标签），提示使用与电脑相同的平台和账号。登录卡片页头左侧为桌面端标题栏同款应用 logo 图标（40px，装饰性图片），右侧为“ZCode”品牌文字与标题；不再使用强调色方块里的字母占位。设备列表页与扫码占位页页头使用同一 logo 的 20px 版本加“ZCode”文字，见 [设备列表规格](./relay-v2-pairing.md#列表排布与文本线框)。选择后同时禁用两个按钮，所选 provider 经入口编排传入现有 WebAuthService；回调按 pending provider 交换并保存凭据。不增加 API Key 入口，因为远控需要账号身份；二维码不携带凭据或推断登录平台。
- 无 JWT 时渲染登录页；appReturnTo 为当前完整 URL。安全回跳只保留同源 `/remote/v4`、`/remote/__test__`（均含尾斜杠）和既有分享路径，query 白名单为 app_version/sid/mid/name。
- 有 JWT、有 SID 直接申请 terminal token 并连接 V2；无 SID 时按当前账号读取设备，最近 SID 在线则直连；最近 SID 不在线但同一台电脑（最近 MID）恰好只有一个在线连接时直连该连接；否则显示设备列表（规则见[落点](./relay-v2-pairing.md#落点状态归属与刷新)）。离线设备不可点击；选中在线设备回写 sid/mid/name/app_version 后连接，支持手动和回前台刷新。设备页标题下显示当前登录账号与平台，“切换”打开下文的切换账号确认弹窗。
- token 401 清本地会话并回登录门禁，无需确认；用户手动“切换账号”需先确认，再清会话并保留当前 URL。AUTH_FAILED 不当作网络错误无限重试。

### 手动切换账号确认

设备列表页与 `device-not-owned` 失败页的“切换账号”共用居中确认弹窗。标题为“切换账号？”，说明为“将退出当前手机网页端账号，返回登录页。电脑端仍保持登录。”，操作为左侧“取消”、右侧“退出并切换”。英文分别为 “Switch account?”、“You will sign out of this mobile web session and return to the sign-in page. Your computer will stay signed in.”、“Cancel” / “Sign out & switch”。按钮使用中性主次样式，不用危险红色。

弹窗开关仅由共享确认组件的 Dialog 持有，不复制认证状态；UI 通过 `@zcode/ui/dialog` 子路径公开现有 Dialog 原语，Web 层组合本功能文案与触发按钮，确认按钮复用 `WebRemoteControlEntry.switchAccount()`。默认焦点在取消，焦点限制在弹窗内；点击取消、遮罩或按 Esc 关闭，焦点回到入口按钮。确认前不清凭据、不切换入口视图、不取消列表请求；确认后沿用原退出与 URL 保留逻辑。401、JWT 缺失等自动失效路径不经过此弹窗。桌面 continuous / 手机 replayable 恢复边界不变。

```text
手动入口 → Dialog 打开（仍登录）
             ├─ 取消 / 遮罩 / Esc → 原页面（仍登录）
             └─ 退出并切换 → Entry.switchAccount → reset → auth.logout → 登录页
认证失效 ─────────────────→ Entry.switchAccount → reset → auth.logout → 登录页
```

验收：两个手动入口均覆盖打开、取消、遮罩、Esc、确认；取消保持凭据、URL 和原页面，确认清手机网页凭据并回登录页且保留 URL；401 不显示弹窗。浏览器验证覆盖 390px / 1024px、Zai Light / Zai Dark、中英文，检查焦点恢复、Tab 限制、按钮可达及无横向溢出。回归落在 `webRemoteControlSwitchAccount.test.ts` 与 pending `remote-login-v2.mjs`（MC01）；受控浏览器证据不替代真实手机 OAuth 验收。

2026-09-22 本地验证：相关单测 4 文件 39 项通过，登录入口浏览器回归 75 项通过；确认 helper 拆分后独立复跑 16 组配置通过，并重新截取无进场动画的弹窗截图。截图与逐项结果在 `.tmp/remote-login-v2-e2e/`。typecheck、lint（60 条既有 warning / 0 error）、architecture、桌面 E2E typecheck 和修改代码格式检查通过；Web/UI 尚未纳入 managed architecture，边界由上述组件与入口回归核对。未执行真实手机、真实 OAuth 或线上部署验证。

## 存储与边界

`BrowserOAuthCredentialRepo` 是认证 storage 唯一边界，继续使用 zcodejwttoken、oauth:zai:access_token、oauth:zai:user_info、oauth:active_provider 以及已有 BigModel 独立键；进行中的登录记录使用 `oauth_pending_logins`。残缺或已过期会话清理后视为未登录；清理登录凭据或退出不删除进行中的登录记录。前置编排通过 WebAuthService 读取 JWT，不复制认证缓存；token 不持久化，不进入 QR、日志或业务 payload。

## 开发回调转发

`VITE_DEV_ORIGIN=http://192.168.x.x:5173` 将私网 `/remote/v4` 写入 OAuth state.return_to，并保留同一组远控参数。部署回调只有显式 `VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO=true` 才转发；转发保留白名单参数并追加本次 code/error/state，nonce 校验与 token 交换最终在发起登录的同源执行。已有分享 callback 路径继续支持。Vite 专用代理将 `/api/v1/oauth/token` 与 `/api/v1/remote` 转到当前构建 endpoint，位于普通 `/api` 代理之前。

完整时序、错误映射、文案表和验收矩阵见 [Relay V2 手机首次进入与恢复](./relay-v2-pairing.md#手机首次进入与恢复05)。

本地 `pnpm dev:web-remote-control` 保留 Vite root base，桌面默认二维码地址同步为 `http://localhost:5173/remote/v4`；手机调试时用 `ZCODE_WEB_REMOTE_CONTROL_URL` 指向可访问的同一路径，并配置对应 `VITE_DEV_ORIGIN`。避免使用不在 OAuth 回跳白名单中的 `/remote` 别名丢失 SID。

### 独立测试入口的登录回跳

保留的 `/remote/__test__` 测试资源链使用相同登录门禁。它是允许的登录来源和返回路径，OAuth 回调仍为 `/remote/v4`；不扩大私网 callback 白名单。发起授权时保留测试链接的 app_version/sid/mid/name，回调成功后恢复原测试路径及参数。401 清理会话后的重新登录遵循同一规则。

```text
修复前：__test__ 扫码 → 登录 → 来源被拒、回调无参数 → safeReturn=null → /remote/v4
修复后：__test__ 扫码 → 带扫码参数的 /remote/v4 回调
                     → 原凭据 owner 校验 nonce、换 token → 原 __test__ 链接 → V2 配对
```

验收复用 ML04：`/remote/v4` 与 `/remote/__test__` × Z.AI/BigModel × 390px/1024px × 首次登录/401 重登，断言实际授权回调保留参数、token 请求使用原 redirect_uri、返回原入口并完成配对。单测同时覆盖测试入口尾斜杠、外域与未知路径拒绝、敏感 query/fragment 剔除，以及回调白名单不扩大。桌面 continuous、手机 replayable 与业务 owner 不变。

测试资源部署仍要求同源 `/remote/v4` 回调页面包含该返回路径规则，并由网关加载对应版本。受控浏览器回归不替代真实 OAuth 白名单、网关及测试镜像联调。

2026-09-20 本地验证：修复前新增6项回归失败，修复后 codec、WebAuthService 和入口编排共3文件50项通过；pending 浏览器回归59项通过，含上述16组 ML04 登录路径，结果与32张入口截图在 `.tmp/remote-login-v2-e2e/`。typecheck、桌面 E2E typecheck、lint（61 warning / 0 error）、architecture 和修改代码的格式检查通过。测试使用现有依赖（Vitest 4.1.4，lock 为4.1.7）；未重新安装锁定依赖，也未执行真实 OAuth、真机或部署联调。

## 双平台登录回归

```text
修复前：登录页单按钮 → 入口未传 provider → WebAuthService 默认 zai
修复后：登录页选择 zai / bigmodel → 入口传 provider + 原扫码 URL
        → WebAuthService / BrowserOAuthCredentialRepo 保存 nonce、pending provider
        → 对应平台授权 → 原 owner 校验回调并存凭据 → 原扫码 URL → Relay 校验账号归属
```

凭据 owner、存储键和 nonce 校验保持不变；桌面 continuous / 手机 replayable 的连接、恢复和业务 owner 不变。已有 Web 登录态继续可用，切换账号和 401 返回同一双平台门禁。

验收复用 `packages/web/test/e2e/remote-control/authentication/manual-review/pending/remote-login-v2.mjs`：

- 390px / 1024px × Zai Light / Zai Dark × 中英文展示两入口，顺序、平台名称和标签与桌面一致。
- 两平台分别验证点击、授权参数、pending provider、token 请求 provider、独立凭据键、原扫码地址回跳及 terminal 配对；BigModel 使用 authCode 回调。
- 账号归属失败后切换到 BigModel，以及 401 后重新选择平台，保留原设备 URL。
- 构建配置测试覆盖 test / production 的 BigModel 授权域名；真实第三方授权与真机扫码另行联调，本地受控响应不代表已完成线上验收。

## 回调保留扫码参数

```text
修复前：版本化扫码 URL → WebAuthService → 固定回调 /remote/v4 → 网关加载 latest
修复后：版本化扫码 URL → WebAuthService → 带 app_version/sid/mid/name 的回调
                       └→ BrowserOAuthCredentialRepo 保存本次地址
       → 网关按 app_version 加载页面 → 原 owner 校验 nonce → 用保存地址换 token
       → 清理 pending 地址 → replace 安全 app_return_to → 原 V2 配对链路
```

复用 ML04 浏览器用例：两平台 × 手机/宽屏均从实际授权 URL 取回调地址，断言扫码参数完整保留，追加授权参数后导航，并核对 token 请求的 redirect_uri 与授权时一致。单测补充 Unicode/空值、未知及历史授权参数剔除、跨页恢复、nonce 失败、旧 pending 会话兼容与私网转发。此变更仅涉及 Web OAuth；桌面登录、continuous/replayable 与业务 owner 不变。发布后需真机验证两平台允许并保留带 query 的回调地址；缺少 app_version 的入口仍依赖 latest，不能据此宣称已修复线上旧资源。

## 回调落到同一浏览器的其他标签页

部分手机浏览器在 OAuth 往返后，回调页不在发起登录的标签页里，或标签页被系统回收后重建（例如切到短信 App 查看登录消息）。登录记录原先只存在发起页的 sessionStorage，回调页读不到，就在换 token 前报 “OAuth CSRF 检测失败”；点“重新登录”在同一环境中仍会失败，换浏览器才能完成。

```text
修复前：Tab A 写 sessionStorage[A].nonce=N → provider 登录 → 回调落在 Tab B / 重建后的 Tab A
        → sessionStorage 为空 → null≠N → CSRF 失败（不请求 token）
修复后：Tab A 写 localStorage.oauth_pending_logins += {N, provider, redirectUri}
        → provider 登录 → 回调落在同源任意标签页 → 取出并删除 N 对应记录 → 换 token → 安全回跳
```

- 记录按 nonce 区分，多个标签页同时发起登录互不覆盖；最多保留最近 5 条，放弃的登录不会无限累积。
- nonce 仍随机、同源可见、只能用一次。state 中的 nonce 找不到记录时拒绝，并保留其他记录。
- 回调落到另一个浏览器 App 时仍拒绝：该浏览器没有本次登录记录，这是 CSRF 校验应有的结果。
- 不再读取旧版本写在 sessionStorage 的 `oauth_pending_nonce` / `oauth_pending_provider` / `oauth_pending_redirect_uri`。网关按 `app_version` 为发起页和回调页加载同一版本目录，只有部署切换时正在进行的登录会受影响，用户重新登录即可。

验收：`browserOAuthCredentialRepo.test.ts` 覆盖跨标签页取回、只取匹配 nonce、取出即删、条数上限与损坏记录；`webAuthService.test.ts` 覆盖回调页使用空 sessionStorage 时两平台完成登录、nonce 不匹配时不请求 token 且保留记录、两个标签页并行登录各自完成。浏览器回归 `remote-login-v2.mjs` ML07 在同一浏览器 context 的新标签页完成回调，断言 token 请求参数、回跳与 terminal 配对。受控浏览器证据不替代真实手机浏览器验收。
