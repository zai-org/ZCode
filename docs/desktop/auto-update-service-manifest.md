# 桌面端服务端 Manifest 自动更新

## 背景

旧版桌面端直接让 `electron-updater` 读取 CDN 上的 `latest*.yml`。这种方式适合静态全量发布，但不适合按设备灰度、区分 stable / preview 或在服务端把 preview 提升为 stable。新版客户端改为先请求 ZCode 服务端 manifest 接口，再把服务端返回的 `latest.yml` 同格式内容交给 `electron-updater` 执行下载、校验和安装。

CDN 仍保存安装包、blockmap 和更新清单文件，但这些文件只进入版本化目录，不再由 CI 覆盖全局 stable feed。服务端 manifest 根据 release API 中的 stable / preview 状态选择版本，并下发指向版本化平台目录的绝对 CDN URL。

## 更新网络出口

CA PEM 文件可以包含完整服务链或“根 CA + 服务端叶证书”。常规建链仅把具备 CA 签发资格的配置证书作为锚，附带的非 CA 服务证书不能抢先成为锚而破坏合法链；完整配置集仍用于显式自签名服务证书的逐字匹配。非 CA、非自签名叶证书不能单独作为 pin 绕过链校验。

用户显式配置的自签名服务证书可直接作为信任锚，不要求其具备 CA 签发用途。仅当收到的是单张证书、与配置的证书逐字匹配且自签名有效时采用此路径；仍须通过有效期、域名/IP、服务端用途、关键扩展和密钥/签名强度检查。不能用 PKIjs 的某个失败码作为此兼容路径的唯一条件，也不能据此接受未配置的证书或放宽多级 CA 链。

自定义 CA 的验证路径上，每张证书的 keyUsage 都必须是结构合法、仅使用已定义位的 BIT STRING；叶证书如声明用途须允许签名，CA 如声明用途须允许证书签发。不能只检查叶证书，也不能将解析成功视为用途合法。

名称约束按每一级 CA 分别施加：同一级 permittedSubtrees 内是候选集合，不同 CA 之间必须全部满足；任一级 excludedSubtrees 命中即拒绝。检查每张后代证书的所有 DNS/IP SAN，不能只检查用于本次连接的名字。自颁发中间证书沿用路径验证的例外，但最终叶证书不能跳过。此补充验证支持 ASCII DNS 名和 IPv4/IPv6 地址及掩码；带约束的通配符 SAN、其他名称类型的约束、非零 minimum 或显式 maximum 等未可靠支持的形式拒绝放行，不静默忽略。普通无名称约束的链保持原行为。

回归入口 `node packages/desktop/scripts/auto-update-ca-constraints-smoke.mjs` 同时检查策略回调与实际 updater HTTPS。`--app <完整包可执行文件>` 在隔离数据目录中运行真实完整包，使用同组证书验证，不替换包内策略实现。
该入口同时接入 `test:auto-update-source-security` 的 MR 自动 job，网络策略或回归脚本改动会触发；完整签名包验收仍单独记录，源码夹具不冒充完整包。

2026-11-02 验证：旧完整包 3.17.112 可实际放行畸形 CA keyUsage、扩大后的名称约束及越界的第二个 SAN。修复后启用自动更新的 production 完整签名包 3.17.113，通过新增 18 个约束场景与原 34 个 TLS 场景；真实下载完整 ZIP 时，原生关闭和“后台下载”均不取消任务，重开读到当前进度，完成后可再次打开，实际只下载一次且不执行安装。源码窗口生命周期 E2E 另行通过。此为隔离合成证书和本地更新源，不代表生产网络、Apple 公证或其他操作系统验收。

更新检查、安装包和 blockmap 请求使用 `electron-updater` 自己的 Chromium Session。
启动时，该 Session 必须与主界面一样读取设置页的 `httpProxy`、`httpProxyNoProxy`
和 `httpProxyCaCertPath`；代理留空时直连，不继承 shell 或系统代理。
内置浏览器仍保留代理留空时跟随系统的既有规则，忽略证书校验开关只作用于内置浏览器。
网络设置按既有启动配置生效，不另建更新器网络设置或自动重试状态。
应用策略的启动日志分别标明 `default-session`、`auto-updater`、`embedded-browser`，
用于区分出口；只记录模式和策略开关，不记录代理地址、账号或密码。

回归：通过隔离 HTTP 代理，用真实 `electron-updater` 请求无法直连的测试域名并下载文件，
确认代理收到请求、字节数与校验一致；检查 no-proxy 可以直连本地服务器，
断流后由用户重试可下载完成。该场景不承诺断点续传，也不代表原反馈已确认同一根因。
在仓库根目录执行 `pnpm install --frozen-lockfile` 后，运行
`node packages/desktop/scripts/auto-update-network-smoke.mjs`，证据保存在 `.e2e-artifacts`。
该入口直接使用的 `esbuild` 由 desktop 包声明为开发依赖，不能依赖其他包提升到根目录的副本。
该回归入口按正式主进程的 ESM 格式构建，并保持 `electron-updater` 为外部依赖，
同时覆盖 CommonJS 依赖的加载边界；不得用 CJS 打包将不兼容的命名导入转换掉。

## Manifest 接口

客户端检查更新时请求：

```text
GET /api/v1/releases/electron/manifest
```

客户端同时通过 query 和 header 传递更新选择参数：

| query        | header              | 取值                                                                             |
| ------------ | ------------------- | -------------------------------------------------------------------------------- |
| `platform`   | `X-Platform`        | `darwin-aarch64` 等发布服务平台名；服务端也兼容 `win32-x64` 这类 Node 风格平台名 |
| `channel`    | `X-Release-Channel` | 标准通道 `1`；抢先体验/preview 通道 `3`                                          |
| `device_mid` | `X-Device-Mid`      | 桌面端 telemetry 复用的 uuidv4 风格设备 ID                                       |

已登录时，manifest 请求携带 `Authorization: Bearer <zcodejwttoken>`。每次请求前通过
注入的凭据读取函数获取当前 ZCode JWT，不缓存启动时的登录状态；未登录或 Token 为空时
省略该 header。退出或切换账号后的下一次检查使用新的凭据状态。
更新检查与 telemetry 共用 `@zcode/shared` 的 `toBearerAuthorization`：先 trim，再检查
Token 是否全部为可见 ASCII 字符（`0x21–0x7e`），合法时生成 Bearer 头，否则返回空值。
这是请求头字符校验，不校验 JWT 签名、有效期或登录身份。
Token 只用于 manifest 请求，不写入 URL、日志或 updater 全局请求头，安装包与 blockmap
下载不携带该 Token。凭据读取失败时，只记录固定、不含异常正文的 warn，继续发送不带
Authorization 的 manifest 请求；不清理登录态。Token 内容不合法时也省略该头。

回归入口 `node packages/desktop/scripts/auto-update-source-security-smoke.mjs` 使用隔离
Electron 和本地 HTTP 服务，检查未登录、登录、切账号、退出、非法字符、读取抛错及恢复后的
请求头，并确认下载请求不携带登录 Token、降级日志不含异常正文；同一场景也随
`--appimage`、`--nsis` 运行。

响应体保持 electron-builder 生成的 `latest*.yml` 格式，例如：

```yaml
version: 3.4.0
files:
  - url: https://cdn.example.com/zcode/electron/releases/3.4.0/macos-arm64/ZCode-3.4.0-mac-arm64.zip
    sha512: ...
    size: 123456
path: https://cdn.example.com/zcode/electron/releases/3.4.0/macos-arm64/ZCode-3.4.0-mac-arm64.zip
sha512: ...
releaseDate: "2026-07-09T00:00:00.000Z"
```

下载文件 URL 推荐服务端下发绝对 CDN URL。若服务端下发相对路径，客户端使用 endpoint origin 作为兜底 base URL；因此生产响应不要依赖旧 CDN feed 目录作为隐式 base。

Electron 发布产物在 OSS 上的版本化目录固定按平台和架构分层：

```text
<path-prefix>/<version>/macos-arm64/
<path-prefix>/<version>/macos-x64/
<path-prefix>/<version>/windows-x64/
<path-prefix>/<version>/windows-arm64/
<path-prefix>/<version>/linux-x64/
<path-prefix>/<version>/linux-arm64/
```

版本化平台目录内统一使用包含 `releaseNotesByLocale` 的 `latest.yml`，安装包和 `.blockmap` 都随对应平台/架构一起上传。remote `manifest-*.json` 仍保留在 `<path-prefix>/<version>/` 根目录，`components/...` 仍保留在跨版本目录，避免 remote runtime 资产 URL 发生不必要变化。当前 CI 不再生成 locale 或旧客户端 generic feed 的更新清单副本。

## 发布通道

- stable：面向正式用户。CI 全量阶段把 release API 状态置为 `status=1` 后，服务端 manifest 对 stable 返回该版本。
- preview：面向主动开启预览更新的用户。CI 灰度阶段把 release API 状态置为 `status=3` 后，服务端按 `device_mid` 灰度策略决定 preview manifest 是否返回该版本。
- preview 可被服务端标记/提升为 stable。提升后无需重新上传安装包，stable manifest 返回同一批 CDN 产物即可。

客户端只负责传递 channel 和 device_mid，不在本地实现灰度比例或通道提升判断。

## CI 两阶段

发布流水线拆成两个明确阶段：

1. 灰度阶段：沿用现有安装包上传、CDN 预热和 release metadata 产物，调用 release API 时发送 `status=3`。此阶段不覆盖 stable CDN feed 的 `latest*.yml`。
2. 全量阶段：人工或规则触发后，复用同一批 release metadata，调用 release API 时发送 `status=1`。全量阶段不再上传 stable CDN feed，服务端 manifest 直接返回同一批版本化平台目录中的文件。

安装包、blockmap、`latest*.yml` 上传和 CDN 预热都只针对版本化平台目录执行。stable / preview 的可见性由 release API 状态和服务端 manifest 控制，CI 不再通过覆盖 CDN feed 表达发布状态。

## 客户端状态机

新版交互把“发现更新”和“下载更新”拆开：

```text
idle -> checking -> update-available -> download-progress -> update-downloaded
```

- `update-available`：只展示更新入口，不自动下载。菜单和标题栏按钮都显示有新版本。左上角标题栏入口文字使用 `font-medium text-ui-xs` 的 badge 层级，按钮使用最小高度而非固定高度，展开态宽度由本地化短文案自然撑开；调整 UI 字号后不得裁切文字，默认字号下仍保持紧凑胶囊，下载态图标入口继续保持可见。
- 用户点击更新入口后打开独立更新窗口。独立窗口只承载更新 UI，不启动 Local/Remote Host 或 workspaceKey Agent runtime；窗口内继续复用原更新弹窗内容和状态控制器，保证下载前、下载中、下载后所有按钮、文案、进度和 release notes 缓存逻辑与原 Dialog 严格一致。主界面入口只负责显示当前更新状态和打开独立窗口；若运行环境没有桌面窗口 IPC，才回退到内嵌 Dialog。
- 更新窗口内容采用标题区、下载进度、操作区三段结构，并使用偏窄的紧凑宽度和 `16px` 横向内边距；标题区使用 `logo | 标题 + 发布时间` 的横向 flex 布局，左侧复用与 macOS Dock 完全同源的 `public/icon_512@2x.png` 产品图标，固定为 `56px`（`size-14`），右侧标题和发布时间作为纵向信息组并相对 logo 垂直居中；产品图标保留原图的圆角、透明留白和比例，不再额外裁切、缩放、添加边框或阴影，同时作为不参与读屏的装饰图像；窗口不展示 stable / preview 通道 badge，避免用户在更新弹窗里感知当前更新通道，发布时间放在标题行下方并只显示格式化日期；更新日志 Markdown 数据仍可用于入口 hover 等其他展示，但窗口内不再展开显示 release notes 正文、标题、折叠控制或背景卡片。窗口视觉只使用中性 surface / border / foreground token，不额外引入成功色、品牌色或 accent 背景，窗口内按钮使用纯文字，关闭入口保留底部“稍后”；主界面左上角更新入口保持原来的 success 色块，和窗口的中性视觉分开处理。
- 更新窗口按显式阶段渲染，不通过多个布尔值组合推导：
  - 下载前（`update-available`）：展示发布时间，不展示更新通道 badge；底部展示“跳过此版本”“稍后”“下载更新”。
  - 下载中（`download-progress`）：隐藏“跳过此版本”，展示下载进度、“后台下载”和“取消下载”；进度区域在弹窗主内边距内再增加 `8px` 左侧外边距；进度条右侧优先展示已下载/总大小，格式为 `1.0MB / 10.0MB`，保留 1 位小数，字节数据缺失时不显示右侧文本，避免残留 `0%` 这类百分比口径；主界面更新入口显示 loading spinner，不显示文字。`download-progress.version` 是协议可选字段，renderer 必须按 `kind` 识别下载态，即使某一帧缺少版本号也要保持更新入口和已打开弹窗，不得卸载组件或关闭弹窗。用户点击“下载更新”后，renderer 必须先本地进入“下载已请求”的 downloading 展示；`downloadUpdate()` 的 IPC 返回只代表命令已被 main 侧接收，不代表已经进入下载态。若随后短暂收到 `checking` / `idle` 等无版本过渡状态，renderer 必须复用上一帧可见更新模型保持弹窗，直到 `download-progress` / `update-downloaded` 收口。若 main 侧下载启动失败，失败收敛必须回到 `update-available` 让用户可见并可重试，不得直接广播 `idle` 让主入口和弹窗一起消失。
  - 下载后（`update-downloaded` / legacy `UpdateReady` ready）：展示发布时间，不展示更新通道 badge；底部展示“稍后”“重启以更新”，不展示“跳过此版本”。
- 普通更新窗口在下载前、下载中、下载完成后均可用系统关闭按钮关闭；下载中另有“后台下载”按钮。关闭只销毁展示窗口并释放该窗口的状态监听，不取消下载、不安装、不创建新下载任务；真正退出应用仍沿用现有退出规则。强制更新窗口不受此规则影响。
- 下载状态和取消令牌由 main 的 `autoUpdater` 单独持有。窗口关闭后进度、成功或失败事件继续更新同一个状态，但不得自行创建、显示窗口。用户从现有主界面更新入口重开时，读取当前快照；下载中展示同一进度，完成后展示“重启以更新”，失败后回到既有可重试状态。重复打开只激活现有单例，关闭/重开与迟到快照交错时不得重复监听或启动下载。
- 原生 close 事件早于 BrowserWindow 销毁。已收到 close 的窗口立即失去展示资格，重开不能复用它，也不能把它选作新窗口的 parent；旧窗口的 closed 清理只能清理自身，不能清空后来新建的窗口引用。
- Web 平台没有桌面更新窗口；共用的页内更新 Dialog 若被宿主使用，“后台下载”同样只关闭展示层，不发取消或安装命令。手机远控不新增更新入口。

```text
用户开始下载 → main autoUpdater 持有唯一任务/取消令牌 → 进度/完成/失败状态
                            │
关闭小窗 → 释放窗口监听      ├─ 状态继续更新，不自动建窗
现有入口重开 → 新窗口读取当前快照 ┘
```

- Renderer 侧更新入口和独立窗口必须先通过纯状态模型把 `UpdateStatePayload` 转成 view model，再渲染 UI。状态模型负责统一产出 `phase`、`displayVersion`、`progressValue`、`progressLabel`、`skippableVersion`、`updateChannel` 和 action 完成判定；组件只处理用户操作、设置写入和渲染。用户习惯边界必须集中在状态模型里：下载态按 `kind` 而不是 `version` 判断，下载中不自动关闭窗口；普通 idle/checking/error 状态才允许卸载更新入口；下载操作进入下一状态后释放按钮锁，取消/跳过离开下载态后释放锁。
- Renderer 启动期同时存在一次性 `getUpdateState()` 快照和持续 `onUpdateStateChanged` 事件。快照结果可能晚于事件返回，必须用 revision 防止旧快照覆盖新事件；尤其不能让旧 `idle` 覆盖已经收到的 `update-available` / `download-progress`，否则主页更新按钮会消失。
- 下载前用户可点击“跳过此版本”。跳过版本按 channel 持久化；同一 channel 的更高版本仍会再次提示。下载开始后弹窗隐藏“跳过此版本”，用户若不想继续下载应使用“取消下载”；取消下载不等同于跳过版本。
- 用户点击“下载更新”后才调用 `downloadUpdate()`，进入 `download-progress` 并显示进度条；主界面左上角更新入口恢复 loading 样式，持续提示下载正在进行，且下载态 spinner 在窄按钮和展开文字状态下都必须可见。
- 下载中用户可点击“取消下载”。客户端通过 `electron-updater` 的 cancellation token 中断当前传输，清理下载中状态并退回 `update-available`，保留相同 version / channel / release notes，用户可稍后重试或关闭弹窗；取消下载不等同于跳过版本。
- 下载完成后进入 `update-downloaded`。如果没有检查在飞，立即再查一次 manifest；已有检查在飞则交给 2 分钟短轮询。下载失败后退回 `update-available` 并再查一次；失败发生在当前检查收口前时，等收口后再查。强制更新失败只反馈错误，不复查。用户点击“重启以更新”时，仅当 ready 包版本仍等于当前目标才调用 `quitAndInstall()`；目标已经更高则不安装旧包。
- 启动检查之后，无可见更新时每 15 分钟复查；`update-available` 或 `update-downloaded` 仍在展示时每 2 分钟复查。复查到更高版本就替换当前目标，已展示的入口不切成 `checking`。菜单“检查更新”在发现态同样重新请求，不回放旧目标。
- 若用户下载完成但尚未安装就重启应用，main 进程会在启动 hydrate 时用持久化的 pending release notes 恢复 `update-downloaded`；仅当 pending 版本高于当前 `app.getVersion()` 时恢复，避免已缓存包再次提示“下载更新”。pending 版本真正等于当前应用版本后，才作为安装后的 release notes 同步给 renderer。
- 强制更新 gate 仍然可以复用同一更新器，但在 `update-available` 时会立即启动下载，保持阻断升级语义。

旧的 `UpdateReady` 事件保留，用于兼容已下载状态同步；新的 UI 主要订阅持续的 `UpdateStateChanged` 状态。

## 设置项

`AppSettings` 新增：

```ts
receivePreviewUpdates?: boolean;
skippedElectronUpdateVersions?: Partial<Record<"stable" | "preview", string>>;
```

- `receivePreviewUpdates` 默认 `false`，仅影响桌面端自动更新检查；Web 和手机远控不读取该设置。
- 设置页切换 `receivePreviewUpdates` 后，renderer 通过 `syncAppSettings` 即时通知 main 进程。main 若当前处于 `update-available` / `idle` / `checking` 的可切换状态，会清理旧通道的可用版本并重新请求服务端 manifest；例如 preview `3.3.3` 已提示时关闭开关，应重新拉取 `channel=stable` 并展示 stable `3.3.2`。下载中或已下载待安装时不打断当前安装流程。
- `skippedElectronUpdateVersions` 由 main 进程维护，renderer 只通过 IPC 请求跳过当前版本，避免 UI 直接拼写 channel 语义。

## 兼容与迁移

- 旧安装包若仍按包内 `app-update.yml` 从 CDN stable feed 检查更新，不再由当前 CI 全量阶段自动刷新对应 feed。需要兼容旧包时，应由服务端 manifest 迁移策略、单独的应急发布动作或旧 feed 运维流程承接，避免把新 release 状态再次绑定到 CI 的静态 feed 覆盖。
- 新安装包默认使用服务端 manifest provider。打包态更新入口只允许既有官方生产或测试 HTTPS 域名，其他通用后端覆盖不会授权更新源，回到官方生产入口。打包后的应用忽略 `ZCODE_UPDATE_FEED_URL`、`--zcode-update-feed-url` 以及内部传入的自定义 manifest URL；深链或启动参数不得改变更新源。未打包的开发态可指定完整 manifest 接口 URL，仍由客户端覆盖 `platform` / `device_mid` / `channel` 查询参数和对应 header。`--` 后的参数不再作为更新器开关解析。
- Windows 签名构建仍读取应用的有效 Authenticode 签名，并写入 `app-update.yml` 的 `publisherName`，以激活 electron-updater 6.8.10 的自定义签名检查入口。该字段只保留签名身份作为诊断信息，不是未来更新的 DN 白名单；不能直接删除字段，否则当前依赖会跳过验证。签名或配置读取失败时构建失败。
- Windows 更新使用显式 Authenticode 校验：下载后及交给安装器之前均要求 Windows 返回有效签名和非空签名者；无签名、损坏、不可信证书、PowerShell 错误均拒绝。子进程仅静默模块初始化进度，避免进度 CLIXML 被误判为 stderr 错误；实际 stderr 和失败退出仍拒绝。不比较旧 DN，所以更新证书或发布者 DN 不需要用户预装过渡版。安装前使用既有 `preparing` 状态锁定目标，在退出 Host/Agent 前完成检查。
- Windows 签名查询在普通用户权限下执行；其专用命令避免受限语言模式禁止的 .NET 方法调用，使允许 `Get-AuthenticodeSignature` 的 ConstrainedLanguage 环境也可完成查询。路径字面量必须双写 ASCII 及 PowerShell 识别的四种排版单引号（U+2018、U+2019、U+201A、U+201B），拒绝 NUL、CR、LF，避免用户名或临时目录中的撇号中断字符串或被解释为代码。PowerShell 模块或签名查询若仍被设备策略禁止、结果文件缺失或无法解析，继续拒绝下载完成或安装，不提权、不修改设备策略、不退回免检。独立子进程切换语言模式的测试只验证脚本兼容，不代表所有 WDAC/AppLocker 策略已验收。
- post-update release notes、已下载待安装状态和 Windows 安装前资源释放逻辑继续沿用现有实现。
- Windows 从 `quitAndInstall()` 到 NSIS 的进程退出、快捷方式和完成页启动边界见
  `docs/desktop/windows-update-install-handoff.md`。

### Windows 更新信任边界与换证

正式包从既有官方 HTTPS 更新入口取得清单，下载文件仍须通过清单哈希校验，再通过有效 Authenticode 签名校验。发布授权依赖官方更新服务，不增加独立发布密钥或签名清单；若官方清单服务被攻破，有效 Windows 签名不能单独证明文件属于本产品。这是本方案明确接受的安全边界。

```text
官方 HTTPS 清单 → 文件哈希匹配 → Windows 签名有效 → 安装
```

`publisherName` 的旧 DN 不参与批准或拒绝，`ZCODE_WINDOWS_UPDATE_TRUSTED_PUBLISHER_DNS` 过渡配置不再使用。新旧证书可以具有不同 DN，但新安装包必须具有 Windows 认可的有效 Authenticode 签名。带有效时间戳的旧签名可在证书到期后继续验证；证书吊销、不可信证书链或操作系统信任策略仍可能导致拒绝。

验收需覆盖真实旧正式包到修复包的升级、不同 DN 的有效签名通过、无签名及损坏签名拒绝、PowerShell 故障拒绝，以及缓存安装前检查。不同 DN 验证必须区分真实证书运行结果和受控替身；测试不能宣称所有 Windows 环境均已覆盖。未修改 macOS/Linux 的签名和安装链路。

## 自定义 CA 的 TLS 验证边界

更新器和默认 Session 的自定义 CA 只增加显式信任根，不跳过证书验证。必须验证服务器域名/IP、完整链签名、有效期、CA/pathLen/名称约束及服务端用途；错误域名、过期、尚未生效、非 CA 签发或错误用途仍拒绝。内置浏览器的宽松证书开关不影响更新器。自定义根验证失败回到 Chromium 默认结果，不因链中指纹相同而放行。

使用实际 Electron updater HTTP executor 的本地 TLS 回归，覆盖有效自定义根与中间链、错误域名、过期/未来证书、错误签名、非 CA 签发、客户端专用用途。正式完整包复验相同网络策略，保留代理、绕过和下载中断重试回归。

2026-10-29 本地完整签名 macOS 包（3.16.101）使用原 Main 启动读取的代理 CA 设置和包内 electron-updater HTTP executor 复验：有效根/中间链通过；错误域名、过期、尚未生效、错误签名、客户端专用用途、非 CA 中间证书和超出 pathLen 均拒绝。运行使用隔离 HOME、临时 CA 与 loopback TLS 服务，不包含真实账号或部署。工程脚本继续覆盖代理、绕过、自签名和中断重试。Windows/Linux 未运行这一轮完整包 TLS 验收。

建链必须沿收到的有限有序链向信任锚前进，不能在交叉签发的循环链中递归重访。畸形循环链应在一次请求内明确拒绝，不能依赖请求超时替代验证收敛。

补充完整签名包 3.16.102 通过 10/10：除前述 9 类场景外，循环签发证书在单次实际 updater 请求内拒绝，未触发测试取消期限。直接策略探针中，修复前回调等待超过 2 秒，修复后约 11ms 返回拒绝；该时间是本机观测，不是产品性能承诺。

自定义 CA 的信任补充不能放行 SHA-1/MD5 签名或低于 2048 位的 RSA 公钥。PKIjs 必须作为运行时依赖闭包根同时进入 afterPack 补齐与最终 bundle 校验，防止 pnpm 去重布局漏包。

补充建链约束：AKI 的 keyIdentifier 与 issuer/serial 两种编码都应支持；后者匹配的是签发者证书的 issuer 名称和 serialNumber，不是 leaf 的 subject。名称、序列号或签名不匹配仍须拒绝。RSA-PSS 必须解析参数中的摘要与 MGF1 摘要，省略参数时按 SHA-1 默认值拒绝，SHA-256 参数正常通过。

本轮完整签名 macOS 包 3.16.105 的实际 updater 通过 21/21：新增 keyid、issuer/serial、异名中间 CA 的合法链，以及错误 issuer/serial/签名反例；RSA-PSS/SHA-256 通过，SHA-1 及 MGF1/SHA-1 拒绝。源码 Electron 回归另外直接注入 -202，证明 PSS 拒绝来自策略本身；修改前该策略会接受 SHA-1。隔离 HOME、合成证书，无真实账号或部署；Windows/Linux 未重验。

### 自定义 CA 的叶证书约束

自定义 CA 只增加信任锚。验证路径内的 critical 扩展必须能够解析，且属于当前链验证器、域名校验或显式用途校验支持的扩展；未知或未支持的 critical 扩展一律拒绝，未知非 critical 扩展不改变信任。叶证书未声明 keyUsage 时保持无此限制；声明后必须允许 digitalSignature，以支持当前 Chromium 的 TLS 握手中的服务端数字签名。仅 cRLSign、keyEncipherment 或 keyAgreement 不能作为服务端签名许可。保留 EKU、链签名、有效期、域名、密钥强度及 pathLen 检查。

回归入口：`node packages/desktop/scripts/auto-update-network-smoke.mjs`，同时检查验证回调及真实 updater Session 的 HTTPS 请求，覆盖未知 critical／非 critical 扩展、未支持的 critical 扩展、有无 keyUsage 与有效／无效用途；最终在隔离签名完整包复验同一边界。

2026-11-02 验证：旧签名完整包 3.16.105 在真实 updater HTTPS 请求中错误接受未知和未支持的 critical 扩展；修复候选签名完整包 3.17.110 的 30 个场景全部通过。完整包覆盖上述拒绝路径、keyUsage、有效 CA 链、AKI／PSS 与既有安全边界；源码 Electron 回归另覆盖代理、直连和断流后重试。此结论为隔离 macOS 完整包验证，不包含 Windows／Linux 原机或公证分发验收。

critical 扩展还必须无 PKIjs `parsingError` 标记；DER 可解码但不符合该扩展结构的真值对象仍应拒绝。keyUsage 必须是 primitive ASN.1 BIT STRING，不能将 INTEGER 等类型的原始字节解释为用途位。回归增加错误结构的 keyUsage、nameConstraints 和 certificatePolicies，均要求拒绝。

2026-11-02 补充边界：确认 PKIjs 会将错误扩展结构返回为带 `parsingError` 的对象。旧包真实 HTTPS 还错误接受了包含此类 nameConstraints 的中间 CA；签名完整包 3.17.112 的 34 个真实 HTTPS 场景全部通过，包含 4 个错误结构的叶／中间 CA 反例。对应源码策略探针也全部拒绝错误结构，未改变合法证书兼容范围。

## 本地调试启动

本地测试服务端 manifest 自动更新时，先确认发布服务的 manifest 接口可访问，例如：

```bash
curl "http://intranet.example.invalid:3011/api/v1/releases/electron/manifest?platform=darwin-aarch64&channel=stable&device_mid=00000000-0000-4000-8000-000000000000"
```

然后在仓库根目录启动桌面端。`ZCODE_UPDATE_FEED_URL` 必须传完整 manifest 接口 URL，客户端会在请求时覆盖 `platform`、`channel`、`device_mid` query 和对应 header；`ZCODE_AUTO_UPDATE_DEV=1` 用于在 dev Electron 内打开更新链路，`ZCODE_AUTO_UPDATE_DEV_VERSION` 用于把本地应用版本压低到服务端版本以下，方便触发“发现更新”：

```bash
ZCODE_UPDATE_FEED_URL="http://intranet.example.invalid:3011/api/v1/releases/electron/manifest" \
ZCODE_AUTO_UPDATE_DEV=1 \
ZCODE_AUTO_UPDATE_DEV_VERSION=3.3.3 \
pnpm dev:desktop:prod
```

如果要测试 preview 通道，在设置页打开“抢先体验/preview 更新”后重新检查更新即可；不要把 channel 固定写进 `ZCODE_UPDATE_FEED_URL`，否则容易和 renderer 设置态不一致。

## 验证要求

- 单元测试覆盖 manifest provider 请求参数、stable/preview channel 选择、跳过版本、发现不下载、点击后下载、强制更新仍自动下载。
- CI 配置测试覆盖灰度 `status=3` 与全量 `status=1` 两个 job，上传脚本测试覆盖版本化平台/架构目录以及 stable feed 不再上传。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`。
- 若无法在当前环境完成真实安装器升级验证，提交说明中列出待补的打包包体升级验证项。

## 普通更新窗口关闭回归

候选 E2E：packages/desktop/test/e2e/ui-shell/updates/manual-review/pending/update-window-background-download.test.mjs，直接用 node --test 运行。采用真实 Electron 窗口、生产更新窗口函数、生产 updater owner 和生产 UI；仅替换宿主启动、网络下载源和原生安装动作，不连接用户账号或更新服务。

验收包含：下载中系统关闭与“后台下载”、关闭后传输继续、现有入口重开同一进度、隐藏时完成/失败后重开、连续关闭重开、关闭后迟到的加载结果、监听回收、关闭不触发取消/安装、真正 app.quit 沿用退出准备，以及 Zai Light/Dark × 中/英界面。未在原生 Windows/Linux 跑过不得将其列为通过。候选测试不自动转正或加入正式套件。
