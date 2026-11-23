# 预装工具：qpdf

通用合同见 [预装工具](README.md)。

## 作用

pdf 插件在 Bash 中调用 `qpdf` 做页面拆分与合并、体积优化、加密解密和修复，见 `pdf/briefs/process-advanced.md` 的 §qpdf 一节。

`qpdf` 是抢先入口。插件调用的命令名不变。命令找不到时，插件按 [工具不可用时的引导](README.md#插件调用规则) 处理：桌面端先提示查看“帮助 → 预装工具”，再由用户选择等待或按原有方式继续。

## 来源与版本

- 六个平台统一使用 conda-forge 的 `qpdf` 包及其依赖闭包，使用同一个版本。recipe 固定每个包的文件名和 SHA-256。
- 不用官方二进制：官方 Linux 包要求 GLIBC 2.34，高于桌面下限 2.28；官方 macOS 包要求 macOS 15.0，高于桌面最低支持的 13.0。
- conda-forge 的 Linux 包使用 glibc 2.17 基线，macOS 包要求 11.0，Windows arm64 有原生包。
- 当前六平台固定输入版本为 12.4.2。完整闭包与已制作状态以 recipe 和制作证据为准；`.inputs.json` 只代表固定来源，不代表已产出或已运行。
- macOS x64 的 `qpdf-12.4.2-darwin-x64-r1` 已于 2026-11-05 产出，完整 recipe 固定 10 个载荷文件，含 6 个 Mach-O，最高最低系统要求为 11.0。中文空格路径下的重定位、PDF 检查及 AES-256 加密解密已通过 Rosetta 验证；Intel Mac 原生验收仍见 [13](../issues/preinstalled-tools/13-other-platform-verification.md#macos-x64-资源补齐2026-11-05)。

## 裁剪与改写

- 只保留 `qpdf` 命令和它的动态库依赖闭包。删除头文件、pkgconfig、静态库和文档。
- 打包时读取 `info/has_prefix`，或新包 `info/paths.json` 中等价的 `prefix_placeholder` / `file_mode`。两者同时存在时核对一致；所有保留文件的改写声明进入 `rewrite`，已裁剪的文件不生成悬空声明。打包检查会拒绝未声明的构建前缀。

## 资源清单

| 字段               | macOS、Linux | Windows                |
| ------------------ | ------------ | ---------------------- |
| 入口 `qpdf` 的目标 | `bin/qpdf`   | `Library/bin/qpdf.exe` |

运行检查：`qpdf --version`，输出必须包含 `qpdf version <版本>`。

Windows 签名：`windowsSigning` 为 `zcode`，见通用规格的 [Windows 签名](README.md#windows-签名)。2026-11-04 核对 `qpdf-12.4.2-win32-x64-r1`：PE 文件 12 个，微软签名的 VC++ 运行库 6 个保留不变，没有签名的 6 个（`qpdf.exe` 和 5 个 DLL）要签名。

## 许可

- Apache-2.0（也可选 Artistic-2.0）。`NOTICE` 中有 sphlib 的 MIT 声明。依赖包的许可以各包 `info/licenses/` 为准。
- `LICENSES/` 汇总 LICENSE、NOTICE 和依赖包的许可文本。`SOURCES.json` 记录源码地址与摘要。
- Linux 的 libgcc、libstdcxx 包将 GCC runtime exception 放在 `share/licenses/`。recipe 显式保留该许可文件，并用固定官方来源的 GCC `COPYING3` 补齐 GPL-3.0 文本；不使用 conda 构建脚本的 BSD LICENSE 代替运行库许可。额外许可输入同样校验大小与 SHA-256，来源随 recipe 保留；分发结论仍由法务确认。

## 体积（macOS arm64 实测）

- 资源：`qpdf-12.4.2-darwin-arm64-r1`。
- 下载归档：**4221220 bytes**；清单安装字节数：**11065398 bytes**。
- 安装字节数是归档展开内容的口径，不是文件系统分配空间。其他平台的实际体积以各自资源清单为准。

## 验收

| ID    | 前置条件与操作                           | 必须观察到的结果                        |
| ----- | ---------------------------------------- | --------------------------------------- |
| QP-01 | pdf 插件的拆分、合并、加密解密和修复命令 | 结果可用 pypdf 读取并核对页数与加密状态 |
| QP-02 | 关闭 qpdf 的“Agent 使用预装版本”         | `command -v qpdf` 指向系统版本或找不到  |
| QP-03 | Windows arm64 真机（人工）               | 原生包可运行                            |
