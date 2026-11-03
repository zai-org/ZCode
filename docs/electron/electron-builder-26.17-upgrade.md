# Electron Builder 26.17 升级规格

## 目标

基于 Electron 44.7.0 已验证分支，精确升级桌面打包与更新工具链：

- `electron-builder 26.17.0`
- `electron-updater 6.8.10`

`packages/desktop/package.json` 是直接依赖版本的唯一来源，lockfile 固定传递依赖。Electron 继续使用 44.7.0，pnpm 继续使用 10.33.2。

## 边界

本次只迁移打包工具链，不改变产品更新行为：

- 不启用 electron-builder 27、`store-asar`、多 Range 下载或新的 NSIS toolset。
- 不改变更新通道、服务 manifest、自定义 Provider、下载与安装状态机。
- 不改变签名、公证、发布目录和差分更新策略。
- 不删除现有 `app.asar` 依赖补齐、NSIS 模板 patch、DMG 容量和签名 workaround。
- 不改写 Electron 44 升级规格的历史验收边界。

## 构建与更新合同

```text
package.json 精确版本
  -> pnpm lockfile
  -> electron-builder 生成安装包、blockmap 和更新清单
  -> 既有签名、公证、收集和发布链
  -> ManifestUpdateProvider
  -> electron-updater 下载、校验和安装
```

pnpm 使用 hoisted 布局。上游 26.17.0 虽然包含依赖收集修复，但该版本仍有漏收集传递依赖的公开记录。因此构建必须保留三层保护：

1. electron-builder 对缺失生产依赖 fail-closed。
2. `afterPack` 以 `electron-updater` 等运行时入口递归补齐缺失闭包。
3. bundle 完成后机械检查最终 `app.asar` 的运行时闭包。

HTTP builder-binaries 镜像只允许在 electron-builder 子进程中显式放行。HTTPS 镜像必须清除该放行变量，不能继承父进程的宽松配置。

Builder 26.17 的 macOS 工具镜像合同由 `scripts/electron-builder-binaries-macos.json` 固定：`7zip@1.0.0` 和 `dmg-builder@1.2.5` 各有 arm64/x86_64 的原始归档、字节数及 SHA-256。工具由构建机执行，按宿主 Node `process.arch` 选择，不按目标应用 `--arch` 选择。清单绑定已安装的 electron-builder、app-builder-lib 和 dmg-builder 版本，版本变化必须先审查并更新清单。

macOS CI 在 Builder 启动前运行只读预检。它直接从当前 Builder 工具镜像 GET 对应宿主架构的两个文件，逐字节校验大小和 SHA-256，不接受暖缓存或 HEAD 代替；单资产请求有 60 秒总时限（覆盖连接、响应头与响应体全程），镜像失联或响应停滞时预检必须在可预测时间内失败并释放连接；缺失时在打包前明确报错。预检不发布镜像、不猜测 Caddy 物理目录；镜像目录的受信任同步和原子发布由运维维护。普通打包中默认内部镜像遇到可识别的工具 404 时，保留一次公共镜像回退作为本地容灾，不能作为 CI 镜像完整性验收；显式镜像或非工具错误不可自动替换。

Windows 安装器继续使用仓库的 `installer.nsh` 和阶段 patch。26.17.0 的内部 NSIS resolver 已变化，真实编译测试必须通过新版 toolset 入口取得 compiler、include 和 plugin 路径。模板锚点、快捷方式、用户文件保留和卸载行为不变。

26.17.0 会在触发 `afterExtract` 前，将 macOS 的 Electron `LICENSE` 重命名为 `LICENSE.electron.txt`，并连同 `LICENSES.chromium.html` 移入 `.app/Contents/Resources`；Windows/Linux 仍保留在 `appOutDir` 根目录。许可暂存必须按平台使用该唯一源目录，不能在 macOS 继续读取已被移动的根目录文件。

dmg-builder@1.2.5 的 dmgbuild 会把 `dmg.contents` 中每个 `type:"file"` 条目当作真实源文件执行 `ditto <path>`，相对路径按 dmgbuild 进程 cwd 解析。`.background.tiff`、`.VolumeIcon.icns` 等隐藏文件由 dmgbuild 在镜像内自行生成，不是源文件；把它们列入 contents 在旧 dmgbuild 上被容忍，在 1.2.5 上会在 DMG 阶段以 `Cannot get the real path` 硬失败。contents 只允许引用真实存在的源文件（通常仅省略 path 的应用条目与 `/Applications` 链接）。

### Windows 签名只接受 PE

26.8.1 旧收集器只打包 desktop 实际链接的 node_modules，Windows 构建只包含 win32 变体；26.17.0 的 pnpm 收集器按 lockfile 全平台图收包，会把 `sharp` 的 optionalDependencies（`@img/sharp-darwin-*`、`@img/sharp-linux*` 等 Mach-O/ELF 变体）一并打进 `app.asar`，smartUnpack 再把它们落到 `app.asar.unpacked`。`WinPackager.signApp` 在 afterPack 之后遍历 unpacked 目录签名（第二簇），非 PE 文件会被送进 vsigntool；DigiCert token 处理非 PE 输入后进入坏状态，同一 job 内后续所有签名（含 bundle.mjs 整命令重试轮里本来健康的 win32 文件）连锁报 `0x8010006a`。2026-10-26 CI 实况：同一轮第一簇（copy 阶段 extraResources，纯 win32 PE）全绿，第二簇起全部拒绝。

因此 Windows 签名钩子按 MZ 魔数过滤：仅在成功读取魔数并确认非 MZ 时跳过签名并打印 `[sign-windows-hook] skip non-PE file`；打开或读取失败必须向上抛错使构建失败，禁止把"无法判定"当作"无需签名"（评审 CR-01，否则真实 PE 会带着签名成功的假象漏签）。Windows Authenticode 只对 PE 有意义，确认非 PE 后跳过不损失签名覆盖。签名输入的合法性由钩子唯一判定，不依赖收集器或 smartUnpack 的文件集合行为。

同一收集器行为还带来包体死重：全平台 `@img/sharp-*` 变体约 110MB（未压缩）进入 app.asar。`desktop-native-package-policy` 按目标平台保留唯一变体集合（win32 只留 `sharp-win32-<arch>`，darwin 留 `sharp-darwin-<arch>` 与 `sharp-libvips-darwin-<arch>`，linux 留 `sharp-linux-<arch>`），其余在 files 规则裁剪；若裁剪漏网，afterPack 的违规检查以"sharp 包含非目标平台变体"fail-closed。现有手写变体清单只覆盖已知包名，不能作为新增平台变体的长期防线。

Windows x64 CI 在 Windows ARM64 虚拟机上构建，且 Windows x64/arm64 job 可能并行使用同一 checkout。不能通过改变全局 `supportedArchitectures` 或删改共享 `node_modules` 来选择打包目标：这会改变另一 job 的安装树。Windows x64 job 单独启用产物裁剪：在 `afterPack` 的现有 `app.asar` 解包暂存目录里，依据每个包 `package.json` 的 `os`/`cpu` 平台约束删除与 `win32/x64` 不兼容的包，重打包后继续执行 native 资源和运行时闭包的严格校验。无约束包原样保留；不维护新的包名排除清单。此开关不由 Windows arm64、macOS 或 Linux job 启用，不修改它们的依赖安装或打包行为。

## 验收

### 本地 Windows x64

- 精确版本、安装树和 lockfile 一致。
- Builder、Updater、Provider、依赖闭包和 NSIS 定向测试通过。
- 真实 NSIS installer/uninstaller 隔离 smoke 通过。
- 未签名 Windows x64 bundle 通过原生资源、运行时闭包和体积门禁。
- 安装器、blockmap、`latest.yml` 的 URL、size 和 SHA-512 一致。
- 隔离数据目录启动 unpacked 应用，无 `MODULE_NOT_FOUND`，运行时仍为 Electron 44.7.0。

### 发布前仍需验证

以下结果不能由本机 Windows x64 未签名包替代：

- Windows 正式 Authenticode 签名与可信时间戳。
- 真实旧版本通过生产形态 feed 更新到新版本。
- Windows arm64 真机安装、更新和原生模块运行。
- macOS x64/arm64 签名、公证、Gatekeeper 和 ShipIt。
- Linux AppImage、deb、rpm、pacman 构建、安装和运行。

## 停止条件

出现以下任一情况时，不继续宣称可发布：

- manifest、lockfile 和实际安装版本不一致。
- NSIS 真实模板 patch、编译或隔离 smoke 失败。
- bundle 跳过必需运行时依赖，或最终 `app.asar` 缺少闭包成员。
- Electron、原生资源或 CUA Helper 与目标架构不一致。
- 安装器、blockmap 或更新清单的摘要和大小不一致。
- 缺少对应平台、证书或旧包环境却试图外推发布结论。

## 实施状态

2026-10-20 基于 `origin/chore/electron-44-upgrade` 的 `05c26e3555` 完成独立升级。

### 已验证

- manifest、lockfile 与实装树一致：Electron 44.7.0、electron-builder 26.17.0、electron-updater 6.8.10、app-builder-lib 26.17.0、builder-util-runtime 9.7.0。
- 14 个定向测试文件共 227 项通过，覆盖版本锁定、镜像门禁、Builder HTTP 授权隔离、macOS/Windows Electron 许可布局、运行时闭包、NSIS 模板与真实编译、安装器隔离 smoke、用户文件保留、Provider、Updater 状态机、Linux 选包、产物收集和发布校验。
- 根 typecheck、lint 和 `architecture:check --changed` 通过。依赖变化使 affected 选择覆盖根套件 2500/2500，按仓库合同跳过全量单测，不将其记为执行通过。
- Windows x64 runtime 资产准备通过：Electron 44.7.0，CUA Helper 为 x64 PE `0x8664`，runtime manifest 指向 Electron 44.7.0。
- 未签名 Windows x64 Preview 安装器由 electron-builder 26.17.0 成功生成。Builder 的 HTTP mirror 授权只进入 electron-builder 子进程，资产准备和常规编译显式清空该授权；`afterPack` 判断运行时闭包完整，不需要重写 `app.asar`；原生资源、PTY、Sharp、Koffi、CUA Helper 和 500 MiB 体积门禁通过。
- 最终环境隔离产物为 273,884,905 字节（261.2 MiB）。`latest.yml` 的 URL、size 和 SHA-512 与最终 EXE 一致；blockmap v2 包含 13,089 个块并完整覆盖安装器字节。
- 包内 Electron Node 报告 Electron 44.7.0 / Node 24.21.0，成功加载 electron-updater 6.8.10 和 Builder 26.17.0 构建元数据；随包 Agent `--version` 输出 0.17.0。
- 使用隔离数据目录冷启动 `win-unpacked`，Chromium 152.0.7977.130 的 CDP 端点可用，日志中没有 `MODULE_NOT_FOUND`。测试结束后进程树已停止，`zcode://` 和 Explorer 菜单注册已恢复到原正式应用路径。
- 第三方通知按根 lockfile 的完整生产图重建并通过基础许可分类与输入哈希校验，包含 1203 个精确包版本。生成器先把两侧换行统一为 LF 再严格比对根 lockfile 与 pnpm 安装快照（autocrlf 工作区的 CRLF 不算漂移），再按根 workspace 逐项读取 lockfile-only 图，避免递归扫描的 Windows `EMFILE` 和跨 workspace dedupe 漏项。electron-updater 6.8.10 和 builder-util-runtime 9.7.0 已进入声明；`@electron-internal/extract-zip@1.0.5` 的发布包和精确源码树没有完整 LICENSE，按发布方 BSD-2-Clause 标识登记并保留 `reviewRequired`。OFL-1.1 按标准开放字体许可分类，仍要求对应字体包携带完整原文。

### 未通过或未验证

- 严格第三方材料门禁仍有 25 项 `reviewRequired`，本次不把基础分类通过表述为发布合规完成。
- 冷启动日志中的旧 Windows bundled binary 诊断仍报告 `glm` 缺失；当前正式路径已经改为 Electron Node 执行 `resources/glm/zcode.cjs`，且该入口实跑成功，因此不把这条旧诊断误报归因于 Builder 升级。
- 未验证 Windows 正式签名、真实旧版本通过 feed 更新、Windows arm64 真机、macOS 签名/公证/ShipIt 和 Linux 四种安装格式。
- pacman 配置仍沿用升级前行为：文件名使用 `.pkg.tar.zst`，未显式覆盖 Builder 的压缩默认值。26.17.0 的 FPM 默认仍为 xz，Linux 发布前必须用真实产物确认内容和扩展名合同；本次 Windows 验收不外推该结果。
