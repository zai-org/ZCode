# 10 — qpdf 与 Pandoc 资源

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

产出可安装的 qpdf 与 Pandoc 资源。装好后，Agent 在 Bash 中直接调用 `qpdf` 和 `pandoc`，用的就是预装版本，插件不用修改。

本票还要建立一个从 conda-forge 取包的公共工具，Poppler 资源会复用它。规则见 [qpdf 规格](../../preinstalled-tools/qpdf.md) 和 [Pandoc 规格](../../preinstalled-tools/pandoc.md)。

- **conda-forge 公共工具**（放在打包公共层）：
  - 按 recipe 固定的文件名和 SHA-256 下载包，并解开 conda 包。
  - 按 Mach-O、ELF、PE 的依赖表求出依赖闭包。闭包在打包时求解一次，结果写进 recipe。
  - 读取 `info/has_prefix` 或 `info/paths.json` 的等价前缀元数据，核对两种格式一致，只给保留文件生成 `rewrite`。
  - 把各包的 `info/licenses/` 汇总到 `LICENSES/`；按包内的 recipe 生成 `SOURCES.json`。
  - 许可在 `share/licenses/` 等载荷路径时由 recipe 显式声明；缺失完整文本时使用固定官方 URL、大小与 SHA-256 的额外许可输入，不把构建脚本许可冒充库许可，不放宽许可缺失门禁。
- **qpdf 转换器**：六个平台使用同一版本，只保留 `qpdf` 和它依赖的库。
- **Pandoc 转换器**：
  - 使用官方二进制，各平台的版本按规格。
  - Windows arm64 使用 x64 资源：`platforms` 包含 win32-arm64，`binaryArch` 为 x64。
  - 许可文本从同版本的源码包中取出。源码包列入 CDN 存档清单。
- **产出**：在本机产出两个工具的 macOS arm64 资源。其余目标尽量产出，并做结构检查。

## Acceptance criteria

- [x] conda 工具的工程测试覆盖三种情况：
  - 摘要不符时拒绝；
  - 依赖闭包有遗漏时，打包检查失败；
  - `has_prefix` 声明的文件全部进入 `rewrite`。
- [x] macOS arm64 的 qpdf 经 loopback 安装后，Agent 执行拆分、合并、加密解密和修复命令，结果可以用 pypdf 核对（QP-01）。
- [x] macOS arm64 的 Pandoc 经 loopback 安装后，同一批 docx 样例的 `-t plain` 和 `-t markdown` 输出内容完整。输出作为基线保存在本票中，各平台之间的差异在 13 中对比（PD-01）。
- [x] 两个资源都通过全部打包检查，包括“Mach-O 最低系统版本不高于 13.0”。

## Blocked by

- [06 — 安装时改写路径与重签](06-install-rewrite-and-resign.md)
- [07 — 打包工具通用层与 LibreOffice 资源重新产出](07-packaging-common-and-libreoffice.md)

## 验证

- 运行受影响的工程测试，以及根目录的 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 开关场景 QP-02、PD-02 由 [12](12-macos-arm64-full-chain.md) 验证。

## PD-01 正文输出基线

平台：macOS arm64；Pandoc：3.1.12.2。样例由 `scripts/preinstalled-tools/pandoc/fixtures/create_samples.py` 生成。同一安装资源、同一会话经 Agent 执行 `pandoc <样例> -t plain` 与 `-t markdown`，三份样例共六项退出码均为 0，预期正文片段全部保留。

| 样例         | DOCX SHA-256                                                       |
| ------------ | ------------------------------------------------------------------ |
| chinese.docx | `b4618da516d489521ac26d0f3d864e5a186cb38350fc393fe425699ceef4b06f` |
| table.docx   | `0372886599d1532fc028cb6be40e363c98baabef36f4aec1d752638d3e387743` |
| list.docx    | `1ab70869c15d3c065d3584a9d86b964aa258856edb8dc71b39c7d4a51a12497c` |

以下为 plain 的完整输出；markdown 仅在每个首行标题前增加 `# `，其余字节相同，各文件以换行结束。

```text
中文完整性样例

这是中文段落：合同金额为 123.45 元，交付日期为 2026 年 10 月 29 日。
```

```text
表格样例

  -----------------------------------------------------------------------
  项目                    数量                    备注
  ----------------------- ----------------------- -----------------------
  苹果                    2                       第一行数据

  纸张                    17                      第二行数据
  -----------------------------------------------------------------------
```

```text
列表样例

-   待办事项甲

-   待办事项乙

1.  步骤一：读取文档

2.  步骤二：检查内容
```

边界：首轮样例误用 Word 的 Title 样式；Pandoc 将其放入 `meta.title`，默认非 standalone 的 plain/markdown 不输出它，因此六项标题断言失败。原 DOCX、失败基线和 AST 证据均保留。经确认，把预定正文标题改为 Heading1 后另存上述基线，未改插件参数或增加 `-s`。这只证明上述正文样例完整，不表示所有 Word 样式的内容都能按默认参数完整读取。其他平台的内容差异仍待 13 对比。

## Comments

- 实施提交：`bee7ca1e022e1c61b87093a0acb5dd87fa77435a`（上游诊断路径与架构模板共用 `checkedSourceFiles` 原始来源事实）；`f03d1b442740269738535d6b2db72024029a73de`（conda 公共工具、qpdf/Pandoc 转换器、固定输入、样例与规格）。同前缀备选来源的公共修正在 `eaaafdcfb1bdd654e270be21675b22b218b1d30d`，本票已合入复用。
- 已执行：根 `pnpm typecheck`、`pnpm lint`（0 errors，172 项既有 warnings）、`pnpm architecture:check --changed`（0 violations）；`pnpm test:engineering scripts/preinstalled-tools/common scripts/preinstalled-tools/libreoffice scripts/preinstalled-tools/qpdf scripts/preinstalled-tools/pandoc`，9 文件、99 项通过。固定锁离线安装校验、格式、diff、相对文档链接检查通过。工程红绿证据覆盖摘要拒绝、依赖遗漏、所有保留前缀、双格式冲突、解包边界、许可缺失/错误摘要与系统 DLL 边界。
- 已执行 macOS arm64 实际验收：两个资源均经真实预装 utilityProcess 从 loopback 安装到含空格与中文的目录，状态 ready；Agent 的 `NodeExecutionAdapter` 在同一会话从固定入口调用预装工具。qpdf 拆成 3 个单页再合并、AES-256 加密/解密、修复损坏 startxref，pypdf 核对页数、正文与加密状态通过。Pandoc 的三份 DOCX × plain/markdown 六项正文检查通过，精确输出见上方基线；安装后官方二进制摘要一致，Apple 锚定发布者签名仍有效。
- 两个 macOS arm64 资源均做两次确定性制作，归档大小和 SHA-256 一致，全部制作门禁通过。qpdf 的最高 Mach-O 最低系统版本为 11.0，Pandoc 为 12.0，均不高于 13.0。归档如下：

| 资源                            |     字节数 | SHA-256                                                            |
| ------------------------------- | ---------: | ------------------------------------------------------------------ |
| qpdf-12.4.2-darwin-arm64-r1     |  4,221,220 | `69e99de7fa0dabbfe93edc62555d7fda10b6d40105b1ef5a8122eea989c3d8cc` |
| pandoc-3.1.12.2-darwin-arm64-r1 | 35,113,160 | `9e95dff76042ad0612b9a573d849f5c529d655c53caa705ebce9eedb1d85efa3` |

- 额外结构制作通过：qpdf linux-x64（7 个 ELF，最高 GLIBC 要求 2.17）；Pandoc darwin-x64（最低 macOS 13.0）、linux-x64、linux-arm64、win32-x64（同时声明 win32-arm64）。这些目标均未执行目标平台运行。qpdf 其他四个目标仅固定了同版 12.4.2 的来源输入，未制作，不把 `.inputs.json` 视为可安装资源。
- 已保留首次失败及修正证据：Pandoc 的 codesign 内联要求缺少 `=`；qpdf 验证脚本最初只查 stderr，而 Agent 将修复警告合并到 stdout；Pandoc Title 样式的六项断言；Linux GCC 包缺少完整许可文本；Windows 缺少系统 dbghelp.dll 的明确识别与上游诊断路径声明。修正后分别重验通过；没有跳过门禁或覆盖原失败基线。GCC 的原有 runtime exception 与固定官方 GPL-3.0 文本均进入归档，未作法务通过结论。
- 未验证：macOS 13 真机；非当前 macOS arm64 的原生运行和文档内容对比；Windows arm64 仿真/原生 qpdf；qpdf darwin-x64、linux-arm64、win32-x64、win32-arm64 的实际资源制作；图形界面开关、系统回退和五工具同会话整体验收（由 12 接续）。本票未改 CLI 产品代码，未运行 CLI 独立 typecheck/lint/测试。未上传 CDN、未改正式 catalog，法务与发布分别留给 01、14。
- 持久证据与资源已交付集成任务的 `10/` 产物目录：`delivery.json`、`qpdf-reproducibility.json`、`validation/qpdf-results.json`、两个 `loopback-*/result.json`、`pandoc-body-baseline.json`、`pandoc-installed-signature.json`、`existing-target-rechecks.json` 与 `logs/`。制作描述中的 `validation.runtime: not-run` 保持其“只由制作器产生结构结果”的含义，真实运行证据单独保存。

- 2026-10-30 review 修正（`909c0c9947c`）：旧 conda 许可不再依赖 POSIX 字符串后缀，改为比较同一宿主路径，避免 Windows 生成 `LICENSES/<component>/../license.txt` 后被 schema 拒绝。有限 Windows 路径/FS 夹具先复现失败，再验证真实许可复制与 `SOURCES.json` 成功；相关 conda 16 项通过，缺失许可、来源和摘要拒绝规则保留。此证据是 macOS 上的 Windows 路径模拟，不是原生 Windows 制作或运行。未重制、重下载资源；根类型、Lint、架构与受影响工程检查通过。
