# macOS DMG Signing And Notarization

## 背景

macOS release DMG 是用户从浏览器下载后直接交给 Gatekeeper 评估的最终分发物。3.1.2 曾出现 DMG 已经通过 `notarytool` 并执行 `stapler staple`，但 DMG 本体没有 Developer ID 签名的情况；带 Chrome quarantine 的下载文件会被 `spctl -t open/install` 判定为 `source=no usable signature`，导致部分用户安装失败。

## 目标

- `ZCode.app` 继续由 electron-builder 使用 Developer ID Application 签名。
- 最终 DMG 在提交 Apple notarization 前必须单独执行 Developer ID `codesign`。
- DMG 公证完成并去掉 `.unnotarized` 后，必须通过 `codesign`、`stapler validate` 和 `spctl -t open` 验收。
- 最终 `ZCode.app` 及其包内 Helper、安装后的用户级 Helper 必须分别通过 `codesign --verify --deep --strict` 和 `spctl -a -vv -t exec` 验收；两个 Helper 还必须通过本地 `xcrun stapler validate`，确认签名未被重新覆盖后 staple 仍对应最终 bundle。
- 正式 tag 发布禁止上传 `.unnotarized.dmg`；测试、sandbox 和 MR 链路可以保留未公证产物用于排查，但不得进入正式 release。

## CI 流程

1. `build:macos:*` 导入 Developer ID Application p12 到临时 keychain。
2. `electron-builder` 打包并签 `ZCode.app`，产出 `ZCode-<version>-mac-<arch>.dmg`。
3. `ci-collect-artifacts` 将 DMG 收集为 `*.unnotarized.dmg`。
4. `scripts/notarize-macos.sh` 对 `*.unnotarized.dmg` 执行 DMG 签名、公证、staple、重命名和验收。
5. `scripts/notarize-macos.sh` 在严格 release 中还会通过 `ZCODE_MACOS_RELEASE_APP_PATH` 或 `ZCODE_DESKTOP_DIST_DIR` 定位打包出的 `ZCode.app`，复用 `scripts/doctor-macos-release-app.sh` 验收主 app；找不到 app 路径时 fail-closed。CUA/Helper release gate 额外设置 `ZCODE_CUA_REQUIRE_HELPER=1`，并显式验收最终 app 内 `Contents/Resources/cua-helper/ZCode Computer Use.app`；缺失时 fail-closed。
6. `scripts/upload-oss.sh` 正式发布时只接受已完成上述流程的 `*.dmg`。

### DMG 公证上传端点

`scripts/notarize-macos.sh` 提交 arm64 和 x64 DMG 时，必须显式传入
`--no-s3-acceleration`，使用普通 S3 上传端点。S3 加速端点可能在分片上传时出现
`HTTPClientError.connectTimeout` 或 `deadlineExceeded`；获得 Submission ID 不代表文件已上传完成。

端点选择不改变 Apple 凭据、`--wait`、有限重试和失败退出规则。只有公证成功后，才继续执行
staple、重命名和发布验收。工程回归通过执行实际 Bash 脚本，检查两种架构及每次重试的提交参数。

### 临时 keychain 搜索列表约束

同一 macOS 用户下的 shell runner 共享用户级搜索列表。每个 job 的 keychain 文件独立，
但列表的读取、净化和增删必须在现有共享锁内完成，不使用 job 启动时的快照覆盖列表。

- `security list-keychains -d user` 输出带缩进和外层双引号；先去掉行首、行尾空白，再剥一层外部引号，
  保留路径内部的空格。只保留存在的绝对文件路径，按完整路径去重并保持原顺序。
- 若用户的 `login.keychain-db` 文件存在但列表中缺失，将其补到列表末尾，恢复被旧脚本污染的默认项。
  这不代替证书链和私钥访问权限检查。
- 添加必须幂等；清理只移除当前 job 的路径，保留其他 job 的有效条目；无剩余条目时明确写入空列表。读取列表失败时禁止回写，
  释放锁并报告失败，不能将读取失败当成空列表。
- 回归测试使用 Bash 执行实际 CI 函数，以模拟命令提供带缩进的列表及读写失败，禁止访问真实钥匙串。
  覆盖污染恢复、空格路径、去重、交错增删和锁释放；真实 runner 还需验证 arm64/x64 并发签名。

```text
获取共享锁 → 读取当前列表 → 解析并净化 → 增删自身条目 → 回写 → 释放锁
                         └ 读取失败 → 不回写 → 释放锁并失败
```

此约束只保护遵守同一锁协议的脚本。旧分支脚本仍可能覆盖列表，需更新脚本或隔离 runner 用户。
不按目录年龄自动删除临时 keychain，避免误删仍在构建的 job 资源。

## Computer Use Helper 的独立签名与架构约束

`ZCode Computer Use.app` 虽随主 app 打包并在运行时复制到用户目录，仍是独立的 TCC 责任主体（bundle id
`dev.zcode.cua-helper`），必须与主 app **分开**签名，才能在系统里拿到属于自己的 Accessibility /
Screen Recording 授权条目。相关约束：

- **Helper 随 ZCode.app 交付，但作为独立 bundle 运行。** 发布包中的来源固定为
  `ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`；产品安装器校验后把它复制到
  `${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app`。不接受网络下载、`/Applications`、
  `~/Applications` 或 `ZCode.app/Contents/Library/Helpers` 作为产品兜底；来源缺失必须 fail-closed。
- **Helper 是独立 bundle，但复用 ZCode 的发布身份。** 独立 Helper 发布链路必须用
  `build/entitlements.helper.plist` + hardened runtime 签成 `dev.zcode.cua-helper`；签名身份仍使用与
  `ZCode.app` 相同的 Developer ID Application team/identity，不需要额外证书或额外 Apple 账号成本。同一
  release payload 内的 `ZCode.app` 与 `ZCode Computer Use.app` 必须走同一次 notarization/staple 验收链路；
  验收通过后，Helper 可以作为独立 `.app` 被安装器/脚本拷贝到
  `${ZCODE_HOME:-$HOME/.zcode}/computer-use/`。ZCode.app 只负责发现、LaunchServices 启动、health check，
  以及给 MCP 子进程注入随机 socket/token。
- **helper 主可执行必须是 SEA Mach-O。** `scripts/build-cua-helper-app.mjs` 用 Node SEA 把 helper 入口
  注入到一份拷贝的 Node 可执行里（替换旧的 shell wrapper），签名/公证前必须已是 Mach-O。
- **plain-node ABI 的 `ax_native.node` 必须先编好。** SEA helper 运行时用内嵌 Node（非 Electron）加载
  pinned `@zcode/zcode-cua/build/Release/ax_native.node`，因此需要 **plain-node ABI**（node-gyp rebuild，
  而非 `@electron/rebuild` 的 Electron ABI）。`@zcode/zcode-cua` 已加入 `pnpm-workspace.yaml` 的
  `allowBuilds`；独立 Helper 构建/验收必须显式检查该统一 addon 存在并可加载。
- **跨架构（x64 在 Apple Silicon runner 上打包）。** 打包进程的 `process.execPath` 在 Apple Silicon runner
  上是 arm64 Node，若 x64 job 不另行指定 Node，SEA helper 会被打成 arm64。`build-cua-helper-app.mjs` 的
  `assertHelperSeaBaseNodeArch` 会在 SEA 组装前 fail-closed，并提示：为 x64 job 设置
  `ZCODE_CUA_HELPER_NODE_PATH` 指向一份为目标架构编译的 SEA-capable Node，并为目标架构编译
  pinned producer 的 `build/Release/ax_native.node`（目标 `--arch=x64`）。原生 arm64 job 无需额外设置。

## 本地无 Developer ID 的 Helper 调试

开发机没有 Developer ID / notarization credentials 时，仍然可以用真实 ZCode App 跑
Helper-owned CUA 链路，但必须显式标记为本地 dev，不得当作 release 证据：

1. 本地构建 `ZCode Computer Use Dev.app`，并安装到
   `${ZCODE_HOME:-$HOME/.zcode}/computer-use/dev/ZCode Computer Use Dev.app`。
2. 从终端启动 ZCode App，并只在该进程环境里设置：
   `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`。产品 Helper resolver 正式版与本地/dist 构建默认启用；
   仅显式设置 `ZCODE_CUA_PRODUCT_HELPER=0|false|off` 才关闭。
   desktop 会把该确定性的本地路径作为 bundled source 注入 utility host；缺失时直接失败，
   不会回退网络下载。
3. ZCode.app 仍然通过 LaunchServices `open -n -g <Helper.app> --args --socket <path> --token-file <path> --launcher-pid <pid>`
   拉起外置 Helper，所以 macOS TCC 授权主体仍是 Helper 本身。产品路径**只接受 launcher 现签的一次性
   `--token-file`**（`helperMain` 会拒绝无 token-file 的产品 broker），并要求 `--launcher-pid` 做对端进程树
   校验；`--token` 仅用于显式本地 dev fallback，不应作为产品验收路径。

该模式只放宽 Developer ID TeamIdentifier 和 Gatekeeper/notarization 检查；bundle id、
版本、架构和 Mach-O 结构仍然必须匹配。缺失或结构不匹配时不会下载或替换正式 Helper，
而是 fail-closed。ad-hoc/unsigned Helper 的 TCC 身份不稳定，重建后可能需要重新授权；
正式验收仍必须使用签名、公证、staple 后的 Helper。

## 验收命令

```bash
codesign --verify ZCode-<version>-mac-<arch>.dmg
xcrun stapler validate ZCode-<version>-mac-<arch>.dmg
spctl -a -t open --context context:primary-signature ZCode-<version>-mac-<arch>.dmg
```

安装后最终验收主 app 与外置 Computer Use Helper：

```bash
pnpm run doctor:macos-release -- "/Applications/ZCode.app"
ZCODE_CUA_REQUIRE_HELPER=1 pnpm run doctor:macos-release -- "/Applications/ZCode.app"
```

该命令会依次执行：

```bash
codesign --verify --deep --strict "/Applications/ZCode.app"
spctl -a -vv -t exec "/Applications/ZCode.app"
codesign --verify --deep --strict "$HOME/.zcode/computer-use/ZCode Computer Use.app"
spctl -a -vv -t exec "$HOME/.zcode/computer-use/ZCode Computer Use.app"
xcrun stapler validate "/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app"
xcrun stapler validate "$HOME/.zcode/computer-use/ZCode Computer Use.app"
```

0.5.5 legacy：升级后旧 `ZCode CUA Helper.app` 目录可能仍然存在，但它不是当前安装的验收目标；
不要对旧路径运行 `codesign` / `spctl` 并把结果当作本版本 Helper 的发布证据。

脚本在成功路径捕获上述命令输出，只在失败时打印原始诊断，避免 `codesign` / `spctl`
的 verbose 内部属性明细污染正式打包日志。
