# 预装工具：Poppler

通用合同见 [预装工具](README.md)。本文写 Poppler 的来源、裁剪、路径改写、字体配置和验收。

## 作用

文档插件在 Bash 中直接调用这些命令，Python 库 pdf2image 也会调用 `pdftoppm`：

| 命令        | 用途                                 | 插件            |
| ----------- | ------------------------------------ | --------------- |
| `pdftoppm`  | PDF 转图片，用于视觉检查和幻灯片预览 | docx、pdf、pptx |
| `pdftotext` | 提取 PDF 文字                        | pdf             |
| `pdfimages` | 提取 PDF 中的图片                    | pdf             |
| `pdfinfo`   | 读取 PDF 信息                        | pdf             |

四个命令都是抢先入口，名字与系统命令相同。插件调用的命令名不变。命令找不到时，插件按 [工具不可用时的引导](README.md#插件调用规则) 处理：桌面端先提示查看“帮助 → 预装工具”，再由用户选择等待或按原有方式继续。

## 来源

- Poppler 官方只发布源码。资源使用 conda-forge 的预编译包：`poppler`、`poppler-data`，以及它们的依赖闭包。
- recipe 固定每个 conda 包的文件名和 SHA-256。依赖闭包在打包时求解一次，结果写进 recipe。
- 已制作的 macOS arm64 开发资源为 Poppler 26.10.0、poppler-data 0.4.12，资源 ID 为 `poppler-26.10.0-darwin-arm64-r2`。它包含四个命令、52 个 Mach-O 和 263 个 poppler-data 文件；Mach-O 的最低系统版本字段最大为 11.0。
- macOS x64 的 `poppler-26.10.0-darwin-x64-r1` 已于 2026-11-05 产出，完整 recipe 固定 332 个载荷文件，含 52 个 Mach-O，最高最低系统要求为 11.0。`libpoppler.165.0.0.dylib` 按实际字节声明 `binary-dir-prefix`；中文 CMap 的文字提取、渲染及普通 `binary` 模式失败对照通过 Rosetta 验证。Intel Mac 原生验收仍待完成。Windows x64 的实际资源记录见 [13](../issues/preinstalled-tools/13-other-platform-verification.md)，Linux 两个目标仍只有输入锁。
- 调研时的候选版本是 26.10.x。conda-forge 的 Linux 包使用 glibc 2.17 基线；实测 26.10 在 linux-64 上最高要求 GLIBC_2.14，在 aarch64 上最高要求 2.17。最终版本以 recipe 为准。
- 本期保留 26.10，不为绕开路径改写问题退回 24.12。已检查的 24.12 conda 包使用官方源码，未发现 JBIG2 修复回移证据；[CVE-2024-56378](https://security-tracker.debian.org/tracker/CVE-2024-56378) 涉及该版本的越界读，公开修复为 [ade9b5eb](https://gitlab.freedesktop.org/poppler/poppler/-/commit/ade9b5ebed44b0c15522c27669ef6cdf93eff84e)。资源要处理用户提供的 PDF，不能只凭主要流程可用选择该旧版。

| 平台                     | 来源                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| darwin-arm64、darwin-x64 | conda-forge osx-arm64、osx-64                                                                                |
| linux-x64、linux-arm64   | conda-forge linux-64、linux-aarch64                                                                          |
| win32-x64                | conda-forge win-64                                                                                           |
| win32-arm64              | 使用 win32-x64 资源，靠 Windows 11 的 x64 仿真运行；清单中 `platforms` 包含 win32-arm64，`binaryArch` 为 x64 |

## 裁剪

- 只保留四个命令、它们的动态库依赖闭包（按 Mach-O、ELF、PE 的依赖表计算），以及 `share/poppler`（poppler-data）和 fontconfig 的配置目录。
- 删除头文件、pkgconfig、静态库、文档和其他命令。
- 动态库用相对路径查找：Linux 为 `$ORIGIN/../lib`，macOS 为 `@loader_path/../lib`。入口不需要设置库路径环境变量。

## 路径改写

conda 包中有编译时写死的路径。conda 安装时会改写它们；直接解压不会改写。

- libpoppler 内嵌 poppler-data 目录 `<prefix>/share/poppler`，libfontconfig 内嵌配置目录 `<prefix>/etc/fonts`。
- 在 macOS 和 Linux 上，13 个 Poppler 命令都没有参数、环境变量或配置文件能指定 poppler-data 目录。Windows conda 版按 `Library/bin` 内 DLL 的位置查找 `..\..\share\poppler`，即资源根的 `share/poppler`。固定包内的 `windows-data.patch` 先去掉 `bin`，再去掉 `Library`；这是目录布局说明，不代表已完成 Windows 运行验收。

后果：poppler-data 找不到时不报错，但下列情况的文字会静默丢失，`pdftoppm` 不画出这些字，`pdftotext` 也取不到：

- PDF 使用 Identity-H/V 以外的预定义 CMap，例如 `UniGB-UCS2-H`。
- PDF 没有 ToUnicode，字体的 Ordering 是 Adobe-GB1、Adobe-Japan1、Adobe-CNS1 或 Adobe-Korea1。
- CJK 字体未嵌入，需要换成系统字体。
- `pdftotext -enc GBK` 或 `-enc Big5`。

用户自带的旧版中文 PDF 常有这些情况。LibreOffice 导出的 PDF 使用 Identity 编码并带 ToUnicode，按源码推断不受影响。

处理：

- 打包时使用 conda 公共工具读取 `info/has_prefix` 或 `info/paths.json` 中等价的前缀字段；两种元数据同时存在时核对一致。把实际保留文件的全部占位符写进清单的 `rewrite`，默认保留元数据的 `text` 或 `binary` 模式，不为裁剪掉的文件留下声明。
- 26.10 的 libpoppler 把数据目录字符串的长度固定在编译结果中。NUL 填充后，子目录名会追加在 NUL 之后，系统实际收到的路径缺少子目录。macOS、Linux recipe 对需要保留完整路径槽长度的文件逐个显式选择 `binary-dir-prefix`：用 `/` 补足目录前缀，不移动后缀，不插入 NUL。每处前缀后必须为 `/`、NUL 或文件末尾；公共打包检查拒绝名字中间的占位符、未显式声明和 Windows 资源声明。
- 安装时由预装进程按通用规格改写。其他 `binary` 文件继续用原 NUL 模式；macOS 上对改写过的 Mach-O 重新做 ad-hoc 签名。Linux 上新模式的实际运行效果留给 [13](../issues/preinstalled-tools/13-other-platform-verification.md) 验证。
- conda 的占位符很长，用户目录一般不会超出。超出时报告 `unsupported`。
- 打包检查会拒绝未声明的构建前缀，防止漏改。

## 字体配置

- 打包时生成 `etc/fonts/fonts.conf`：
  - 只引用系统字体目录和用户字体目录，例如 macOS 的 `/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts`；Linux 的 `/usr/share/fonts`、`/usr/local/share/fonts`、`~/.local/share/fonts`；Windows 的系统与用户字体目录。
  - 包含文件用相对于配置文件的路径。
  - 缓存目录使用用户缓存目录（`prefix="xdg"`）。
- 入口环境设置 `FONTCONFIG_FILE=${INSTALL_DIR}/etc/fonts/fonts.conf`。
- 不安装字体，不修改系统字体配置。

## 资源清单

| 字段      | macOS、Linux                                                    | Windows                                                |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| 入口目标  | `bin/pdftoppm`、`bin/pdftotext`、`bin/pdfimages`、`bin/pdfinfo` | `Library/bin/<命令>.exe`                               |
| 入口环境  | `FONTCONFIG_FILE=${INSTALL_DIR}/etc/fonts/fonts.conf`           | 同左                                                   |
| `rewrite` | 来自 has_prefix / paths.json，目录模式须逐文件声明              | 来自 has_prefix / paths.json（以实际保留文件扫描为准） |

运行检查：`pdftoppm -v` 与 `pdftotext -v`，输出（Poppler 的版本信息写到 stderr）必须包含 `pdftoppm version <版本>` 和 `pdftotext version <版本>`。每项超时 60 秒：macOS 首次加载这 49 个 ad-hoc 签名的库约需 21～24 秒（见通用规格的运行检查一步），原来的 10 秒会让全新安装稳定失败。

Windows 签名：`windowsSigning` 为 `zcode`，见通用规格的 [Windows 签名](README.md#windows-签名)。2026-11-04 核对 `poppler-26.10.0-win32-x64-r1`：PE 文件 39 个，微软签名的 VC++ 运行库 6 个保留不变，没有签名的 33 个（4 个命令和 29 个 DLL）要签名。Windows 资源没有 `rewrite`。

## 许可

- Poppler：GPL-2.0-or-later。poppler-data：BSD-3-Clause AND (GPL-2.0-only OR GPL-3.0-only)。
- 依赖：cairo 为 LGPL-2.1 或 MPL-1.1，nss 为 MPL-2.0，freetype 为 FTL 或 GPL-2.0，fontconfig 和 lcms2 为 MIT，libtiff 为 HPND，其余以各包 `info/licenses/` 为准。
- `LICENSES/` 汇总每个 conda 包的 `info/licenses/`。分包缺少许可文本时使用固定官方版本 URL、大小与 SHA-256 的显式补充输入；本机配方补齐 FreeType、SQLite 的许可与版权通知，不使用 conda 构建脚本许可代替。`SOURCES.json` 记录每个包的上游源码地址与摘要，取自包内的 recipe。GPL 组件的源码压缩包上传到 CDN 存档。
- 是否满足分发义务，见 [法务确认](../issues/preinstalled-tools/01-license-review.md)。

## 体积（macOS arm64 实测）

- 资源：`poppler-26.10.0-darwin-arm64-r2`。
- 下载归档：**32603714 bytes**；清单安装字节数：**82004944 bytes**。
- 安装字节数是归档展开内容的口径，不是文件系统分配空间。其他平台的实际体积以各自资源清单为准。

## 验收

| ID    | 前置条件与操作                                  | 必须观察到的结果                                          |
| ----- | ----------------------------------------------- | --------------------------------------------------------- |
| PP-01 | 一份中文 PDF，字体未嵌入、编码为 `UniGB-UCS2-H` | `pdftoppm` 渲染出完整的中文；`pdftotext` 取出完整的文字   |
| PP-02 | LibreOffice 导出的中文 PDF（对照组）            | 同上                                                      |
| PP-03 | pdf 插件通过 pdf2image 渲染页面                 | pdf2image 找到预装的 `pdftoppm`，渲染成功                 |
| PP-04 | 安装目录路径含空格和中文                        | 改写后命令正常运行，poppler-data 可读                     |
| PP-05 | 关闭 Poppler 的“Agent 使用预装版本”             | `command -v pdftoppm` 指向系统版本或找不到                |
| PP-06 | Windows arm64 真机（人工）                      | x64 仿真下四个命令可运行；运行检查失败时按 `runtime` 报告 |
| PP-07 | macOS 13 和 15 真机（人工）                     | 改写并重签后的程序没有系统弹窗                            |
