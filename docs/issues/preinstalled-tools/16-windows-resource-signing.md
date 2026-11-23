# 16 — Windows 资源签名：Python、qpdf、Poppler

Status: needs-info

## Parent

[预装工具](../../preinstalled-tools/README.md)。规则见通用规格的 [Windows 签名](../../preinstalled-tools/README.md#windows-签名)，以及 [Python](../../preinstalled-tools/python.md#windows-签名)、[qpdf](../../preinstalled-tools/qpdf.md)、[Poppler](../../preinstalled-tools/poppler.md)、[Pandoc](../../preinstalled-tools/pandoc.md)、[LibreOffice](../../preinstalled-tools/libreoffice.md#平台风险) 各自的 Windows 签名说明。

## 背景

Windows 11 的智能应用控制（SAC）在强制模式下，会拦截没有可信签名、也没有云端信誉的 exe、dll 和 pyd。全新安装的 Windows 11 可能处在 SAC 评估模式或强制模式。预装资源中大部分 PE 文件来自 python-build-standalone、PyPI 和 conda-forge，都没有签名。

2026-11-04 核对当前 Windows x64 资源：

| 资源                                   | PE 文件 | 已有有效签名 | 没有签名 | 本票签名 |
| -------------------------------------- | ------- | ------------ | -------- | -------- |
| `python-3.12.16-20261026-win32-x64-r2` | 163     | 10           | 153      | 147      |
| `poppler-26.10.0-win32-x64-r1`         | 39      | 6            | 33       | 33       |
| `qpdf-12.4.2-win32-x64-r1`             | 12      | 6            | 6        | 6        |
| `pandoc-3.13-win32-x64-r1`             | 1       | 1            | 0        | 0        |
| LibreOffice win32-x64                  | 231     | 216          | 15       | 0        |

- Python 少签的 6 个是 pip 的启动器模板，见 Python 规格。
- LibreOffice 没有签名的文件，文档转换不会加载。用户决定 LibreOffice 不签。

App 的 Windows 签名已在 CI 中运行，本票复用它：

- `scripts/sign-windows.ps1`：调用 vsigntool 和 SafeNet token，每次签一个文件。包括同一规则内重试、单次超时、时间戳服务回退，以及卡住时结束进程树。
- `packages/desktop/scripts/sign-windows-hook.cjs`：只把 `MZ` 开头的文件送进签名工具。
- `packages/desktop/electron-builder.config.js` 中的 `assertSignedWindowsResourceExecutable`：用 `Get-AuthenticodeSignature` 校验状态为 `Valid`，签名证书指纹与 App 主程序一致。
- Windows 打包 job 运行在带 `windows` tag 的 runner 上，设置 `ZCODE_ENABLE_WINDOWS_SIGN=1`，以及 `VSIGNTOOL_RETRY_COUNT`、`VSIGNTOOL_RETRY_DELAY_SECONDS`、`VSIGNTOOL_ATTEMPT_TIMEOUT_SECONDS`。签名证书只在这台 runner 上。

## What to build

- **recipe 字段** `windowsSigning`：
  - 值为 `zcode` 或 `none`。`none` 必须写 `reason`。
  - `zcode` 可以带 `exclude`，每项写精确路径和原因。
  - Windows recipe 缺少这个字段时，制作失败。
- **recipe 改动**：
  - Python win32-x64 和 win32-arm64 用 `zcode`，`exclude` 列出 pip 的 6 个启动器模板。
  - qpdf win32-x64、win32-arm64，以及 Poppler win32-x64，用 `zcode`。
  - Pandoc win32-x64 和 LibreOffice 的两个 Windows recipe 用 `none`。
- **转换器检查**：Windows 资源的 `rewrite` 指向 PE 文件时，制作失败。转换器的其他行为不变，产出的是未签名的中间归档。
- **签名命令**：放在 `scripts/preinstalled-tools/common/`，只在 Windows 上运行。
  - 输入：中间归档和中间资源描述。
  - 步骤：解开归档；按规格选出要签的文件，逐个调用 `scripts/sign-windows.ps1`；完成规格中的全部校验；用公共层的归档函数重新打包；写出最终资源描述和 `provenance.windowsSigning`。
  - 选文件、校验和"去掉签名后比较"放在可测试的函数中。签名程序可以替换，供工程测试使用。
- **发布命令**：`windowsSigning` 为 `zcode` 的资源，没有 `provenance.windowsSigning` 时拒绝。
- **CI job**：新增手动触发的 job，比如 `sign:preinstalled-tools:windows`。
  - 运行在 Windows 签名 runner 上，签名环境变量与 Windows 打包 job 相同。
  - 输入一份或多份中间归档，产出最终归档和资源描述，作为 job artifact。
  - 不能和 Windows 打包 job 同时使用 SafeNet token，用 `resource_group` 排队。
  - 新增的 CI 脚本加入 `opensource/export.config.json` 的 exclude。
- **resourceId**：
  - 首次发布的签名版沿用现有编号：Python win32-x64 `-r2`，qpdf win32-x64 `-r1`，Poppler win32-x64 `-r1`。未签名版从未上传，规格的“上传后不再修改”不受影响（2026-11-04 用户决定）。
  - 以后签名版一旦上传，任何内容变化都按规格换新的 `resourceId`。
  - macOS 和 Linux 资源不变。

## Acceptance criteria

- [ ] 用户审阅通过规格和本票。
- [ ] 工程测试先补、先失败，改实现后通过：
  - 缺少 `windowsSigning`；`exclude` 指向不存在的文件、非 PE 文件或已签名文件；`rewrite` 指向 PE 文件。
  - 选文件只看 `MZ` 和签名状态；已签名的文件和非 PE 文件不送进签名程序。
  - 签名程序失败；签名后状态不是 `Valid` 或没有时间戳；同一资源出现两个证书指纹；签过的文件去掉签名后与原文件不同；其他文件被改动。
  - 发布命令拒绝没有签名记录的 `zcode` 资源。
  - 测试用本机自签名证书或替身签名程序，不需要真实证书。
- [ ] CI 签名 job 对 Python、qpdf、Poppler 的 win32-x64 中间归档各运行一次，全部校验通过。记录每个资源的签名文件数、总用时和单个文件的平均用时。
- [x] 签过的文件的证书指纹与当前 App 安装包中主程序的指纹一致。（2026-11-04 手动签名版，见 Comments）
- [ ] 中间归档按原方法制作两次，逐字节相同。
- [x] 用签名后的三个资源，加上 Pandoc 和 LibreOffice 现有资源，按 [13](13-other-platform-verification.md) 的第 4 层重跑 real-loopback，结果通过。（2026-11-04 手动签名版，见 Comments）
- [ ] 在开启 SAC 强制模式的干净 Windows 11 x64 虚拟机上：
  - 五个工具都能下载、安装，运行检查通过；
  - 四个文档插件的主流程各跑一次，都成功；
  - CodeIntegrity 事件日志中，预装目录下没有拦截记录。LibreOffice 也包括在内，用来证明它没有签名的文件确实不会被加载。
- [ ] 在 [01](01-license-review.md) 的 Comments 中记录：我们用自己的证书给第三方程序（包括 GPL 的 Poppler）签名，签名不改变程序内容。
- [ ] 同步更新各工具规格中的 resourceId 和体积数字。

## 待确认

1. **中间归档放在哪里**：签名 runner 要从哪里取中间归档？例如 Windows runner 的共享目录、内网文件服务器，或者由上一个 job 的 artifact 传入。
2. ~~**qpdf 的编号**~~：已决定，首次发布沿用现有编号，见 What to build。
3. **签名规则和证书**：
   - 时间戳回退规则 `zcode` 和主规则 `zcodedigicert` 用的是不是同一张证书？如果不是，按规格，同一资源出现两个指纹时会失败。
   - `sign-windows.ps1` 默认的 `-m 3` 是什么签名模式？是否是 SHA-1 加 SHA-256 双签？
4. **SAC 虚拟机**：在哪里准备开启 SAC 强制模式的干净 Windows 11？SAC 只能在全新安装的系统上开启。

## Blocked by

- 无代码依赖。CI job 的上线依赖"待确认"的第 1 项和第 3 项；SAC 验收依赖第 4 项。

## Comments

- 2026-11-04：用户决定 LibreOffice 不签。规格和本票先交给用户审阅，再开始实现。
- 2026-11-04：开发阶段先不做 CI job，用户决定直接在 Windows 签名 runner 上手动签名测试：
  - 签名方式与 App 安装包相同：逐个文件调用 `scripts/sign-windows.ps1`。范围按本票：Python 147 个、qpdf 6 个、Poppler 33 个，共 186 个；pip 的 6 个启动器模板不签。
  - 186 个文件全部签名成功，用时 15.8 分钟，单个文件中位数 3.7 秒。全部状态为 `Valid`、带时间戳，只有一个证书指纹，与 App 主程序一致；时间戳回退规则没有触发。
  - 去掉签名后，186 个文件与原文件逐字节相同。用公共层的归档函数重新打包，条目名和权限不变，只有签过的文件变化。
  - 签名版第 4 层 real-loopback 通过（第 14 次）。
- 2026-11-04：在一台开启 SAC（状态 1）的 Windows 11 上测试：签名版全部正常运行。但未签名原版和新编译的未签名对照程序也都没有被拦截，所以无法证明签名是否必要。用户决定不再追查，按签名版发布。
- 2026-11-05：Windows x64 的五个资源（签名版 Python、qpdf、Poppler，以及 Pandoc、LibreOffice）已上传到内网测试服务器，并用测试分支打包的安装包在两台电脑上测试。另一台电脑上 Poppler 的安装问题与签名无关，见规格“安装事务”第 7 步。
