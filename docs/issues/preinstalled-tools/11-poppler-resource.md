# 11 — Poppler 资源

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

产出可安装的 Poppler 资源。装好后，Agent 调用的 `pdftoppm`、`pdftotext`、`pdfimages`、`pdfinfo` 都是预装版本，pdf2image 调用的也是。这些命令要能正确处理字体未嵌入的中文 PDF。规则见 [Poppler 规格](../../preinstalled-tools/poppler.md)。

- 用 10 的 conda 工具获取 poppler、poppler-data 及其依赖闭包。资源只保留四个命令、依赖库、`share/poppler` 和 fontconfig 配置。
- 把 `has_prefix` 或 `paths.json` 中实际保留文件的前缀按声明模式写入 `rewrite`，包括 libpoppler 的数据目录和 libfontconfig 的配置目录。
- 保留 Poppler 26.10。需要固定长度目录字符串的文件，在 recipe 中逐个显式声明 `binary-dir-prefix`；转换器不能根据 conda 元数据自动选择。模式合同见通用规格，原 `binary` 的 NUL 行为不变。
- 打包时生成 `fonts.conf`：只引用系统字体目录和用户字体目录，缓存放在用户缓存目录。四个入口都设置 `FONTCONFIG_FILE`。
- 运行检查执行 `pdftoppm -v` 和 `pdftotext -v`。版本信息输出在 stderr。
- Windows arm64 使用 x64 资源。
- 生成 `LICENSES/` 与 `SOURCES.json`。GPL 组件的源码包列入 CDN 存档清单。
- 本机产出 macOS arm64 资源。其余目标尽量产出，并做结构检查。

## Acceptance criteria

- [x] 一份字体未嵌入、编码为 `UniGB-UCS2-H` 的中文 PDF：经入口执行 `pdftoppm`，渲染出完整的中文；执行 `pdftotext`，取出完整的文字（PP-01）。这份样例可以用 reportlab 的 CID 字体生成。
- [x] 对照组：LibreOffice 导出的中文 PDF 同样通过（PP-02）。
- [x] 不做改写时 PP-01 失败。把这个对照结果记录在本票中，证明改写确实生效。
- [x] 同一份 26.10 资源的数据目录用 `binary` 时 PP-01 失败，改为 `binary-dir-prefix` 后 PP-01 通过；完整新资源重新制作、安装和验收，不能以隔离诊断副本代替。
- [x] 工程测试拒绝占位符位于名字中间、Windows 资源声明新模式，以及未在 recipe 逐文件声明就使用新模式。
- [x] 工程测试覆盖同文件多处占位符、UTF-8 路径超长时报告 `unsupported`，以及原 `binary` 仍按 NUL 模式处理。
- [x] 安装目录含空格和中文时，四个命令正常运行，poppler-data 可以读取（PP-04）。
- [x] 改写和重签后的程序通过 `codesign --verify`，打包检查全部通过。

## Blocked by

- [10 — qpdf 与 Pandoc 资源](10-qpdf-pandoc-resources.md)

## 验证

- 运行受影响的工程测试，以及根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- pdf2image 场景（PP-03）和开关场景（PP-05）由 [12](12-macos-arm64-full-chain.md) 验证。

## Comments

- 2026-10-29，已确认新增通用 `binary-dir-prefix` 模式，先修改规格再实施。26.10 的 `scanEncodingDirs` 编译结果把 `<prefix>/share/poppler` 的长度固定为 269 字节，再追加子目录；NUL 改写保留尾部填充后，`opendir` 实际只收到基础目录，PP-01 文字为空。隔离副本只对已确认的路径槽用 `/` 补齐并重签后，完整中文、渲染和四个数据子目录访问通过，52 个 Mach-O 签名通过。这是可行性证据，其他库仍来自原安装，不代表正式资源完整验收通过。
- 已检查的 24.12 候选虽然主要流程可用，但其固定官方源码和包内 recipe 未发现 JBIG2 修复回移：macOS recipe 为 `patches: null`，父 recipe 的四个补丁只针对 Windows。公开 [CVE-2024-56378](https://security-tracker.debian.org/tracker/CVE-2024-56378) 与修复 [ade9b5eb](https://gitlab.freedesktop.org/poppler/poppler/-/commit/ade9b5ebed44b0c15522c27669ef6cdf93eff84e) 因此构成不选该候选的依据；未执行漏洞利用，也不把未发现回移证据写成所有发行包都未修复。

- 2026-10-30，实现 commit：`fafaa25c44c2199e1fea74d8f994981070352c2f`（基于集成 `607fa5ad0d63cd2c9bb14c14ec2ed21471cee01c`）。新模式由公共纯字节算法提供，App 保留原有取消、超长日志与重签事务；recipe 使用精确的 `binaryDirPrefixFiles` 选择文件，生产链路没有按工具身份写分支。未新增 App 业务单测。
- 本机正式开发资源为 `poppler-26.10.0-darwin-arm64-r2`，归档 **32,603,714 字节**，SHA-256 **`9e30c3c878a1ad3343be4a1136c7b6c3c90a6d9d2d4a77a43aaffa5213a350b3`**，展开 **82,004,944 字节**。独立两次制作大小与摘要一致；52 个 Mach-O 的最低系统字段最高为 11.0，全部制作门禁通过。资源未发布到 CDN 或 catalog。
- 从这份完整新归档经真实 utilityProcess、loopback 下载全新安装到含中文与空格的目录，只有一次资源请求，四个命令均可运行。全树与原归档核对：360 个未改写文件逐字节相同，只有声明的 8 个库被改写，没有诊断旧安装前缀；运行后 52 个 Mach-O 的严格签名检查通过。
- PP-01 样例的结构经实际解析核对：STSong-Light、UniGB-UCS2-H、Adobe-GB1，无嵌入字体、无 ToUnicode，内容流含完整预期文字。样例 SHA-256 为 `21c525659904645dc614d7a1674813f05e16c74664b43b4ee904785412f02481`。两行全文按换行和页尾规范化后完全相同，PNG 已逐字查看，中文、数字、标点完整。PP-02 使用本轮 07 的 r2 资源及正式统一 helper、完整 profile 模板重新导出；返回来源为 managed，转换前后 LibreOffice 签名通过，Poppler 全文与视觉检查通过。
- 同一份 r2 原始归档另做两次独立安装对照：只把 libpoppler 的目录模式改回 `binary`，或完全不做 rewrite，版本检查均能通过，但 PP-01 输出只有页尾字符、渲染空白，并报告缺少 Adobe-GB1 映射。正例使用正式安装器的新模式，不能用早期隔离副本替代此证据。
- 已执行：`pnpm typecheck`；`pnpm lint`（172 条既有警告、0 错误）；`pnpm architecture:check --changed`（0 违规）；全部预装工程测试 145 项通过。最后补齐 qpdf 对新增来源核验记录的消费者传递，先记录失败再修复，受影响 conda/qpdf 工程测试 17 项通过（含 1 个新增场景），随后根静态检查再次通过。CLI 独立 typecheck 强制执行 33/33、0 缓存；CLI lint 0 错误、71 条警告及 9 项原样上游行数诊断；受影响 adapters 3 项、bootstrap 1 项测试通过。
- 桌面 `PT-REWRITE` 的 fixture check 通过。合入 05 后，独立 E2E typecheck 首次执行先于共享工程声明刷新，曾出现 entryOutOfSync/agentEnabled 的 TS2339；该失败日志保留，没有标为通过。随后成功的根 `pnpm typecheck` 实际构建引用项目并检查 `packages/desktop/tsconfig.e2e.json`，最终 E2E 类型验证由这条根命令完成；候选在合入 05 后回放 `desktop-e2e-20261029161225458-p81817-da47835ee1866481` 为 1/1，覆盖固定长度 C++ 实际读文件、多处目录槽、后续非法出现、新模式超长、原 binary 失败对照及既有 NUL、取消、重签失败、旧入口保留。首轮 `desktop-e2e-20261029160459097-p53259-3965e464fad88d69` 也为 1/1；保持 pending，没有转正。
- 制作中发现并保留原始失败：NSS 把普通许可放入载荷分卷；rattler 拆分包使用 finalized cache source；三个源码地址只有 HTTP；FreeType/SQLite 分包缺少许可文本。分别用受限分卷兼容、最终来源读取、同 host/path/query 且同摘要的显式 HTTPS 资产、固定官方许可与版权通知解决。来源与包装回归均先红后绿。补齐 qpdf/Pandoc/Poppler 的内部制作目录导出排除；依据原删除提交 `ff2006e3459` 移除已不存在的远程清单测试旧断言，相关导出测试 7/7。没有修改无关导出期望或放宽许可、路径门禁。
- 未验证：其他平台的完整资源闭包/归档及本机运行、macOS 13/15 真机、Windows arm64 仿真。已准备五类平台的固定输入锁，Windows 上游主包的 15 个 PE 核对为 x64，并核对包内数据路径补丁；这不等于完整 Windows 资源通过。PP-03/pdf2image、PP-05/开关和五工具四插件最终集成由 12 验证；其他系统交 13，法务与 CDN 发布分别仍属 01/14。
- 外部证据位于本轮持久证据的 `11/`：最终 descriptor 为 `resources/mac-r2-first/poppler-26.10.0-darwin-arm64-r2.artifact.json`（2026-11-04 起不再用于发布，见 Comments），摘要对照为 `r2-reproducibility.json`，全新安装审计为 `r2-fresh-install-proof.json`，运行与签名为 `loopback-r2-first/`、`documents-r2-first/`、`r2-signatures.json`，两种正式负对照为 `documents-r2-control-binary/`、`documents-r2-control-none/`。早期 NUL 失败、LLDB 路径证据、24.12 候选与隔离实验、原始空 profile 导出失败均保留；后者改用正式 helper 后的新转换已通过，未据此改变产品。完整交付索引为 `delivery.json`。
- 2026-11-04：发布和验收使用的 darwin-arm64 Poppler 描述改为 `timeouts-20261030/poppler/poppler-26.10.0-darwin-arm64-r2.artifact.json`。它与上文的 `mac-r2-first` 描述对应同一个归档（SHA-256 `9e30c3c8…`），只有运行检查时限不同：`mac-r2-first` 制作于 `6efaff26adc` 之前，`pdftoppm -v`、`pdftotext -v` 的 `timeoutMs` 还是 10000；新描述按现行规则为 60000。运行检查时限写在描述里，catalog 条目由描述生成，所以发布时必须用新描述。原因：macOS 上从 Finder 或 Dock 打开 App 时，一般走首次检查的慢路径，同一归档首次 `pdftoppm -v` 实测 18～22 秒，10 秒时限会让全新安装稳定失败。测量与分析见 [15 的 macOS arm64 记录](15-python-resource-trim.md#macos-arm64-记录)。
