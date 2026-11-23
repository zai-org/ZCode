# 预装工具：Pandoc

通用合同见 [预装工具](README.md)。

## 作用

docx 插件在 Bash 中调用 `pandoc` 读取 Word 文档的内容：`routes/read.md` 中的 `-t plain` 与 `-t markdown`，以及 `routes/edit.md`、`routes/format.md` 中修改后的内容检查。插件不用 Pandoc 生成交付文件。

`pandoc` 是抢先入口。插件调用的命令名不变。命令找不到时，插件按 [工具不可用时的引导](README.md#插件调用规则) 处理：桌面端先提示查看“帮助 → 预装工具”，再由用户选择等待或按原有方式继续。

## 来源与版本

- 使用 Pandoc 官方发布的二进制（GitHub releases）。recipe 固定文件 URL 和 SHA-256。
- 每个平台取“能在桌面最低支持的系统上运行”的最新版本。官方 macOS 二进制从较新的版本起要求更高的 macOS，所以 macOS 用较旧的版本：

| 平台                   | 版本        | 说明                                                                                         |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| darwin-arm64           | 3.1.12.2    | 最低系统 12.0。3.1.12.3 起要求 14 以上                                                       |
| darwin-x64             | 3.8.1       | 最低系统 13.0。3.8.2 起要求 15.0                                                             |
| linux-x64、linux-arm64 | 3.13        | 静态链接，没有 GLIBC 要求                                                                    |
| win32-x64              | 3.13        | 官方 zip                                                                                     |
| win32-arm64            | 3.13（x64） | 官方没有 arm64 版本。使用 win32-x64 资源，靠 Windows 11 的 x64 仿真运行；`binaryArch` 为 x64 |

- 以上版本数据来自官方二进制的 Mach-O 头部，最终以 recipe 和打包检查为准。
- 2026-11-05 已重新制作 `pandoc-3.8.1-darwin-x64-r1`，描述采用现行 60 秒运行检查时限；归档与原产物字节一致。中文 Word 内容读取通过 Rosetta 验证；这不改变 arm64 用户使用原生资源的规则，也不表示 Intel Mac 原生验收完成。证据见 [13](../issues/preinstalled-tools/13-other-platform-verification.md#macos-x64-资源补齐2026-11-05)。
- conda-forge 的新版本只是重新打包官方二进制，最低系统版本没有更低，所以不用它。
- 不在 arm64 上经 Rosetta 运行 x64 的 3.8.1：用户机器不一定装了 Rosetta，安装时会出现系统提示。
- 不自己编译：维护 Haskell 工具链的成本高。插件只用 Pandoc 读取内容，旧版本的风险较小。验收时用同一批样例对比各平台的输出；出现影响阅读的差异时，再评估自己编译。

## 资源清单

| 字段                 | macOS、Linux | Windows      |
| -------------------- | ------------ | ------------ |
| 入口 `pandoc` 的目标 | `bin/pandoc` | `pandoc.exe` |
| `rewrite`            | 无           | 无           |

- 运行检查：`pandoc --version`，输出必须包含 `pandoc <版本>`。超时 60 秒：Windows 上 Defender 首次执行前扫描约 240 MB 的 `pandoc.exe`，实测 8.6～11.3 秒（见通用规格的运行检查一步），原来的 10 秒会让全新安装偶发失败。
- macOS 官方二进制带 Developer ID 签名和 hardened runtime，保留不变。
- Windows 签名：`windowsSigning` 为 `none`。官方 `pandoc.exe` 已有有效签名（SignPath Foundation），保留不变。见通用规格的 [Windows 签名](README.md#windows-签名)。

## 许可

- GPL-2.0-or-later，`COPYRIGHT` 文件列出了例外条款和静态链接库的许可。官方压缩包不带许可文本，打包时从对应版本的源码压缩包取出，放进 `LICENSES/`。
- `SOURCES.json` 记录源码地址与摘要。源码压缩包上传到 CDN 存档。
- 是否满足分发义务，见 [法务确认](../issues/preinstalled-tools/01-license-review.md)。

## 体积（macOS arm64 实测）

- 资源：`pandoc-3.1.12.2-darwin-arm64-r1`。
- 下载归档：**35113160 bytes**；清单安装字节数：**181323120 bytes**。
- 安装字节数是归档展开内容的口径，不是文件系统分配空间。其他平台的实际体积以各自资源清单为准。

## 验收

| ID    | 前置条件与操作                                                                        | 必须观察到的结果                                  |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| PD-01 | 同一批 docx 样例（含中文、表格、列表）在各平台执行 `pandoc -t plain` 和 `-t markdown` | 内容完整；各平台输出的差异要记录                  |
| PD-02 | 关闭 Pandoc 的“Agent 使用预装版本”                                                    | `command -v pandoc` 指向系统版本或找不到          |
| PD-03 | macOS 13 真机运行 darwin-x64 与 darwin-arm64 资源（人工）                             | 都能运行，没有系统弹窗                            |
| PD-04 | Windows arm64 真机（人工）                                                            | x64 仿真下可运行；运行检查失败时按 `runtime` 报告 |
