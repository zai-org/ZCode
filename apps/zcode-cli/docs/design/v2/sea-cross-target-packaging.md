# SEA Cross-Target Packaging

## 背景

ZCode 的默认发布形态仍然是标准 Node.js CLI 包：`dist/zcode.cjs` 加 `bin.zcode`。SEA 只是可选的单文件分发路径，用于给没有预装 Node.js 的环境提供独立二进制。

当前 SEA 脚本只复制 `process.execPath`，因此在 macOS arm64 上只能生成 `zcode-darwin-arm64`。这不符合项目面向 Windows、macOS、Linux 的发布目标。

## 目标

- 支持从一个 host 机器生成多个 SEA target 产物。
- 默认 target 保持当前 host，避免破坏已有 `npm run sea` 行为。
- 通过 CLI 参数显式选择 target，不新增环境变量。
- 从官方 Node.js release 下载目标平台 Node 二进制，版本必须等于当前运行脚本的 Node.js 版本。
- 复用同一个 bundled CommonJS entry，避免每个平台重复业务构建。
- 发布签名、notarization 和证书管理暂不进入本轮 scope。macOS 开发期 ad-hoc 签名属于 Mach-O 注入后的可执行性修复，不视为发布签名。

## 非目标

- 不实现完整 release pipeline、上传、压缩归档或包管理器发布。
- 不实现 Windows Authenticode、macOS Developer ID、公证或 Linux 包格式。
- 不支持 Alpine/musl 作为首批 SEA target。
- 不把 target 配置做成 `ZCODE_` 环境变量。

## Target 契约

首批 target：

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64`
- `linux-x64`
- `win-arm64`
- `win-x64`

产物命名：

- Unix-like: `dist/zcode-<platform>-<arch>`
- Windows: `dist/zcode-windows-<arch>.exe`

用户接口：

- `pnpm run build:sea`：先在仓库根执行 `build:sea:prepare`，再构建首批全部 target。
  准备入口先强制编译根 `shared`，再用根 pnpm workspace 按依赖顺序构建 CLI 包及其
  传递依赖（含根 `model-option-map`、`session-control`），最后单独重建 CLI bundle。
  CLI 子 workspace 的 Turbo 图看不到根目录的包，不能只用它构建。准备阶段不使用
  Turbo 缓存，也不缓存已有 SEA 产物。
- 根目录 `pnpm build:sea:all`：安装依赖后转发到同一个 all-target `build:sea` 入口。
- `pnpm run sea -- <target 参数>`：只封装当前已有的 `dist/zcode.cjs` 和 runtime
  assets，不负责重新编译 workspace。
- `node scripts/build-sea.mjs`：构建当前 host target。
- `node scripts/build-sea.mjs --target linux-x64 --target win-x64`：构建指定 target。
- `node scripts/build-sea.mjs --targets linux-x64,win-x64`：构建逗号分隔 target。
- `node scripts/build-sea.mjs --all`：构建首批全部 target。
- `node scripts/build-sea.mjs --node-binary linux-x64=/abs/path/node`：使用用户提供的目标 Node 二进制，跳过该 target 的下载解析。

target 参数使用 release 命名里的平台名；Windows 输入使用 `win-x64` / `win-arm64`。Windows 产物发布文件名使用 `windows`，对齐旧 GLM agent 下载契约；内部平台 key 和 host 判断仍使用 Node.js `process.platform` 风格的 `win32`。

## Target Runtime Assets

SEA 可以在一个 host 上下载并注入其它 target 的官方 Node.js binary。`bfs`、`ugrep` 必须先由对应目标平台的 producer 构建、验证并发布到统一依赖源；macOS x64/arm64、Linux x64/arm64 与 Windows x64/arm64 的 `rg` 全部使用固定 SHA-256 的 Microsoft `ripgrep-prebuilt v14.1.1-1` 原始归档，并从同一内网依赖源的 `native-search-tools/ripgrep-v14.1.1-1` 镜像目录下载。所选 macOS 归档的 deployment target 不得高于既有 macOS 12.0 下限；Linux `rg` 必须使用不引入 glibc 依赖的 musl 归档，`bfs` / `ugrep` producer 固定 Node 24、glibc 2.28、GCC 12 与 G++ 12，并通过最终 ELF 的 GLIBC 2.28 ceiling、版本、feature、架构和动态依赖校验；Windows 两个架构必须拒绝动态 CRT、PCRE2 与构建契约要求静态链接的压缩库依赖。SEA 构建按 target 复用同一份 native-search release plan 和下载器，将两类预编译产物校验并准备到 `packages/desktop/bundled-tools/<platform>-<arch>/`。SEA 不在 foreign target 构建期间交叉编译、切换来源或降级省略工具。

公开 `build:sea` 的既有契约始终是 all-target，不能因为某个平台的 native search 尚未接入而降级成 host-only。构建会为每个 target 自动准备并收集对应的 runtime assets；预编译归档缺失、下载失败或目标格式与架构校验失败时，必须在生成该 target SEA 前终止，不能产出 provider-visible embedded search 已启用、执行层却缺少包内工具的正式二进制。

当前 macOS、Linux、Windows 的 x64/arm64 native-search release plan 均已启用。macOS/Linux target 准备 `bfs`、`ugrep`、`rg`，Windows target 准备 `ugrep.exe`、`rg.exe`，Windows `find` 继续回退 Git Bash/system。工具最终布局与 SEA manifest 不暴露 producer/Microsoft 来源差异；SEA asset collector 只按统一 release plan 取目标工具。host-only 开发和 E2E 使用 `sea` 或显式 `--target`。

## Node 二进制来源

默认从 `https://nodejs.org/dist/v<process.versions.node>/` 获取：

- macOS: `node-v<version>-darwin-<arch>.tar.gz`
- Linux: `node-v<version>-linux-<arch>.tar.xz`
- Windows: `win-<arch>/node.exe`

下载的文件必须用同版本 `SHASUMS256.txt` 校验 sha256。校验失败时中止构建，不继续注入。

缓存位置是 `packages/cli/dist/sea-node-cache/v<version>/...`。缓存是构建产物，不参与源码提交。

## Node 24 SEA 基线

ZCode 以 Node.js `24.14.0` 作为本仓库开发、构建和发布基线。Node 26 的原生 `node --build-sea` 路径在生产老设备上兼容性不足，本轮回退到 Node 24 LTS 兼容路径；仓库 `engines.node` 要求 `>=24.14.0 <25`，SEA 发布产物必须嵌入同版本 Node 24 运行时。

SEA 构建路径是 `node --experimental-sea-config <config>` 生成 preparation blob，然后把该 blob 用 `postject` 注入目标平台官方 Node.js 二进制。脚本必须继续从官方 Node release 下载同版本目标二进制，或接受用户用 `--node-binary <target>=<path>` 显式提供的二进制。

SEA config 必须显式写入：

- `main`: bundled CLI entry，当前为 `dist/zcode.cjs`，相对 `packages/cli` 执行目录解析。
- `output`: preparation blob，当前为 `dist/zcode.sea.blob`。
- `disableExperimentalSEAWarning`: `true`。
- `assets`: OpenTUI runtime assets, bundled official plugin assets and the
  bundled skill pack. Official plugins are stored as raw files in the SEA blob,
  then extracted on startup into
  `~/.zcode/cli/plugins/cache/zcode-plugins-official/<plugin>/<version>/`.
  They must not be imported into the ZCode main bundle. Seeded official plugin
  manifests are rewritten to use the hidden `__zcode-plugin-host` entrypoint so
  the cached MCP server runs on the SEA-embedded Node.js runtime. Third-party
  plugins are not automatically rewritten and keep their own declared command.
  The bundled skill pack (`packages/bundled-skills/skills/**`, collected by
  `scripts/sea-bundled-skill-assets.mjs` under the `zcode-bundled-skills/`
  prefix) is not a plugin: its manifest hash names the extraction directory
  `~/.zcode/cli/bundled-skills/<hash>/`, every required file must be present or
  the build aborts, and a runtime hash mismatch refuses the pack.
- `useCodeCache`: `false`。
- `useSnapshot`: `false`。

SEA blob 由当前运行脚本的 Node.js 生成，target Node 版本必须与当前 Node 版本一致。跨平台构建时必须关闭：

- `useCodeCache`
- `useSnapshot`

原因是 V8 code cache 和 snapshot 只能在同平台加载；跨平台注入后可能启动崩溃。

图片处理 adapter 必须避免默认依赖平台原生 `.node` addon。SEA 默认运行时使用 Jimp 纯 JS adapter 做 PNG/JPEG/GIF 等格式的 resize-to-fit；WebP 暂时原样透传，不在 SEA 包里引入 sharp、NAPI addon 或外置 `.wasm` 资源。后续如改用 WASM/native 图片处理器，必须先补充 asset 注入、运行时定位、临时文件策略和跨平台 smoke test。

## Zod 运行时版本与去重

CLI、桌面内置 Agent 和 SEA 共用的 JS 构建必须统一使用 Zod v4 `4.6.5`，
以避免旧版在启动时为每个 schema 提前创建全部方法闭包。`packages/shared/package.json` 的精确版本是构建门禁的事实源，
其余直接依赖声明与根 lockfile 必须与它一致；不使用会改写双 major peer 范围的全局 override。Zod v3 工具契约
及 `zod-to-json-schema` 保持原有 major，不做跨 major 替换。

去重由 CLI 的 esbuild 构建入口负责：先按消费者原有解析规则选择 package
版本和导出，再把同版本的不同安装目录归并到一份实现。保留子入口及
ESM/CommonJS 的实际目标文件，不能用全局 `zod` alias 把 v3 重定向到 v4。
构建结束检查 metafile：同版本出现多个实际 package 根，或 v4 不符合统一
版本时，构建失败并列出来源路径。普通 CLI、desktop-agent 和 SEA 使用同一门禁。

验收包括：嵌套重复安装去重、v3/v4 共存、import/require 导出条件不变、
子入口正确解析，以及 shared/provider/CLI/MCP 的既有解析回归。内存验证在
相同运行时与相同模块/启动场景下 GC 后比较；模块实验不能替代完整 CLI
快照，也不把 bundle 文件大小直接当作堆内存或 RSS。

## CLI 版本来源

普通 Node CLI bundle 和 SEA binary 必须使用仓库根目录 `package.json` 的 `version` 注入 `__CLI_VERSION__`。`packages/cli/package.json` 只是 workspace 子包元数据，不能作为 `zcode --version`、`zcode version`、`zcode doctor --json`、ZCode app-server 初始化版本字段、MCP client initialize `version`，或 `session.version` 的来源。

构建脚本读取根 `package.json` 失败，或 `version` 不是非空字符串时，应中止构建并报告根版本元数据异常。源码测试环境未经过 bundle 注入时，运行时仍保留 `0.0.0` fallback，便于直接测试 `packages/cli/src/run.ts`。

## 注入与签名契约

注入工具使用 repo 已安装的 `postject`。脚本必须根据目标二进制格式添加参数：

- Mach-O: 加 `--macho-segment-name NODE_SEA`
- ELF: 不加额外 section 参数
- PE: 不加额外 section 参数

macOS 官方 Node 二进制通常带签名；脚本在 macOS host 上构建 macOS target 时必须先移除签名，以便注入。`postject` 修改 Mach-O 之后必须立即执行 `codesign --force --sign - <binary>` 做 ad-hoc 签名，否则其它开发机可能在加载可执行页时因为签名状态不一致直接终止进程。该签名不绑定 Developer ID、不公证，也不代表正式发布签名。

Windows 官方 `node.exe` 通常带 Authenticode 签名。脚本构建 Windows target 时必须在 `postject` 注入前移除原始 Authenticode 签名，否则 PE 的 Security Directory 会指向被修改前的签名数据，后续正式签名服务可能报 `0x800700c1` 或判定产物不是有效 Win32 应用。该移除逻辑必须跨平台可执行，不能依赖 Windows-only `signtool`：解析 PE optional header 的 `IMAGE_DIRECTORY_ENTRY_SECURITY`，注意该 entry 的 `VirtualAddress` 是文件偏移而不是 RVA；将该 directory entry 清零，并在证书表位于文件末尾时 truncate 掉证书表数据。无签名的 Windows 二进制是 no-op；directory 指向文件范围外时中止构建并报告 PE 签名目录异常。正式 Authenticode 签名仍不属于本脚本 scope，必须发生在 SEA 注入完成之后。

## 验证契约

- host target 构建完成后运行 `--version` smoke test。
- foreign target 不在 host 上执行，只检查二进制已生成并完成注入流程。
- OpenTUI SEA asset manifest 必须包含 `@zcode/tui` 的完整 runtime dependency
  closure，包括 workspace package 的 `package.json` 与 `dist`；具体契约见
  `tui-opentui-sea-packaging.md`。
- macOS host 构建 macOS target 时，在 smoke test 前完成 ad-hoc 签名。
- Windows target 在注入前完成 Authenticode 签名移除；最终正式签名由 release/signing pipeline 在注入后处理。
- CI 后续可以用 matrix 在每个 OS 上对对应产物执行 smoke test。

## 错误行为

- 未找到 `dist/zcode.cjs`：提示先运行 `pnpm build`。
- 未找到 `postject`：提示先运行 `pnpm install`。
- target 不支持：列出支持 target。
- 缺少 target runtime tool：中止，并提示先由对应平台准备并聚合 runtime assets。
- 下载失败或 checksum 不匹配：中止，并指明 URL 或文件名。
- 缺少 `tar` 导致无法解包 macOS/Linux Node archive：中止，并提示使用 `--node-binary <target>=<path>`。
- 目标 Node 二进制没有 SEA fuse marker：中止，并提示使用官方带 SEA 支持的 Node。
- Windows PE 签名目录损坏或越界：中止，不继续注入或生成可签名产物。

## 测试覆盖

- target 参数解析，包括 repeated target、CSV target、`--all` 和非法 target。
- package scripts 保证 `build:sea` 始终显式传入 `--all`，根目录 `build:sea:all` 转发到该既有入口。
- target 到 release artifact、下载 URL、产物名的映射。
- postject 参数按目标平台生成。
- host target smoke 判断只匹配当前 platform 和 arch。
- macOS ad-hoc 签名只在 macOS host 构建 macOS target 时执行，并使用 `codesign --force --sign -`。
- Windows Authenticode 移除覆盖 PE32/PE32+、未签名 no-op、尾部证书表 truncate 和越界目录报错。
- OpenTUI runtime asset manifest 覆盖 `@zcode/tui`、`@zcode/i18n`、
  `@zcode/contracts` 的 workspace runtime closure，并排除 workspace 源文件。
- CLI bundle 版本注入读取仓库根 `package.json`，即使 `packages/cli/package.json` 版本不同也不改变 `zcode --version` 的构建时版本。
- `build:sea` 脚本必须先调用根 `build:sea:prepare`；回归测试需证明准备入口的根 pnpm
  依赖图包含 `@zcode/session-control`，且不包含单独构建的 `@zcode/cli`。
- SEA 检查 workspace 包时只要求 `dist` 目录存在；只有子路径导出的包（如
  `session-control`）没有 `dist/index.js`，回归测试需证明其产物被打入 SEA。
