# 07 — 打包工具通用层与 LibreOffice 资源重新产出

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

打包工具拆成两部分：公共层，以及每个工具自己的转换器。LibreOffice 转换器迁移到新结构，输出新 schema 的资源描述，并在本机重新产出可以安装的 macOS arm64 资源。完成后，每增加一个工具，只需要写它自己的转换器和 recipe。规则见规格的 [资源制作与发布](../../preinstalled-tools/README.md#资源制作与发布)。

- **公共层**包括：
  - 归档、摘要、资源描述与发布命令；
  - 二进制结构检查（Mach-O、ELF、PE）；
  - 许可与来源汇总；
  - 构建前缀扫描；
  - 归档身份文件。
- **打包检查**（每一项都先写失败用例，再实现）：
  - 身份文件与 recipe 一致。这项检查原来在运行时，现在移到打包。
  - Mach-O 的最低系统版本不高于 13.0。
  - ELF 需要的 GLIBC 不高于 2.28。这项检查已有，迁入公共层。
  - PE 的架构与 `binaryArch` 一致。不会被加载执行的上游数据文件或启动器模板，可按通用规格逐项声明架构例外：精确相对路径、SHA-256、来源和用途，不允许通配符；必须与已核对来源（官方签名或 recipe 固定的摘要）中的文件逐字节相同，且仅豁免架构一致性。
  - 入口目标、运行检查目标、`rewrite` 目标和入口按导入表可达的依赖库不能豁免；声明路径不存在、摘要变化或文件不需要例外时，制作失败。动态加载用途无法由导入表完全证明，仍须核对声明和审阅。
  - 资源中不出现本次打包环境的路径，包括 staging、临时目录、缓存目录、用户主目录和用户名。
  - 已知的重定位占位符只能出现在已声明 `rewrite` 的文件中。
  - 上游诊断构建路径只按 recipe 显式声明的前缀与来源豁免，且文件必须与已核对来源（官方签名或 recipe 固定摘要）中的上游文件逐字节相同。打包时生成或添加的文件不适用豁免；本次打包环境路径和未声明的重定位占位符始终拒绝。这是通用规则，不按工具名分支。
  - 静态扫描不证明运行时不依赖构建路径；运行检查与含空格、中文的安装路径验收负责证明可重定位运行。
  - 资源根目录有 `LICENSES/` 和 `SOURCES.json`。
  - 必需文件齐全；重复制作，结果一致。
- **发布命令**：只接受 `downloadUrlsByRegion`，输出 catalog 条目。
- **LibreOffice 转换器**：
  - 输出 `entries`（`zcode-soffice`，含 macOS 的参数与环境）、`runtimeChecks`、`platforms` 和 `binaryArch`，并汇总 `LICENSES/` 和 `SOURCES.json`。
  - 迁移现有 recipe，`resourceId` 的修订号加一。
- **产出**：
  - 在本机重新产出 macOS arm64 资源。
  - 其余四个已有目标，按新规则重新产出并做结构检查。如果本机网络或时间不够，在 Comments 中记录没有产出的目标，交给 [13](13-other-platform-verification.md)。

## Acceptance criteria

- [x] 每一项打包检查都有工程测试，先失败、后通过。旧的 LibreOffice 打包测试迁移后全部通过。
- [x] 架构例外的每种拒绝情况都有失败用例：把入口目标、运行检查目标、`rewrite` 目标或导入表可达依赖声明为例外，摘要不符，路径不存在，文件不需要例外，以及使用通配符。来源未核对或与来源文件字节不同也不能放行；许可、来源、路径与重定位门禁仍执行。
- [x] recipe 的上游路径豁免只有在前缀、已核对来源和原始文件逐字节一致性均满足时才生效；把上游路径写进打包生成的文件时，门禁拒绝。
- [x] 把本次打包环境路径写进任意文件时，门禁拒绝，不因上游路径豁免而放行；未声明 `rewrite` 的文件中出现已知重定位占位符时，同样拒绝。
- [x] 新的 macOS arm64 资源制作两次，归档摘要一致；经本地 loopback 由预装进程安装后，`zcode-soffice` 的运行检查通过，应用签名有效。
- [x] 资源根目录有 `LICENSES/` 与 `SOURCES.json`，覆盖 LibreOffice 和随包字体；Windows 资源还要覆盖 VC++ 运行库。
- [x] 发布命令拒绝显式下载列表、空分组和非法 URL。
- [x] 其余目标的产出情况记录在本票 Comments 中；没有运行过的目标标为 not-run。

## Blocked by

- [03 — 多工具契约、串行准备与按工具删除](03-multi-tool-contract-and-queue.md)

## 验证

- 受影响的工程测试，并更新工程测试文件清单。
- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 新的打包脚本如果属于内部发布流程，要加入开源导出的排除清单。

## Comments

### 2026-10-29 — 实施与验证

- 实现 commit：`3736ad2c379185bf962303d70356a4c40000ddf9`（`feat(build): share preinstalled resource packaging`）。Linux x64 的已核对上游声明及模板清单补充 commit：`b540ff7d7a5783084c0b4345fe732c77fad4cdf5`。从集成分支开工，起始 HEAD 为 `b7df781073217440c6e5105a0c10d236219d463d`，已执行基线新鲜度检查；提交前同步到 `5220b8a4c30bb941e61358506c19ec2aa16c664b`。
- 公共层位于 `scripts/preinstalled-tools/common/`；LibreOffice 转换器和 r2 recipes 位于 `scripts/preinstalled-tools/libreoffice/`。删除临时 `legacy-contract.mjs`，直接复用公共 schema；更新工程测试清单及内部脚本的开源导出排除项。
- 工程检查先补失败回归再实现。已运行 `pnpm test:engineering scripts/preinstalled-tools`：6 个文件、86 个测试通过。覆盖各打包门禁、架构例外各拒绝类型、三种二进制导入表及符号别名的传递依赖保护、原始来源/摘要、生成文件和本次打包路径、重定位占位符、Java class 与 Mach-O fat 共用魔数的格式区分，以及旧转换器回归。
- 已运行根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，均退出 0；lint 有 172 个已有 warning、0 error，本票新增 warning 已消除；架构检查 0 violation。修改文件格式检查、开源术语检查及 `git diff --check` 通过。未改 CLI，不以根检查替代 CLI 验证。
- 真实 macOS arm64 资源制作两次，均为 `libreoffice-26.8.1-darwin-arm64-r2.tar.gz`，大小 **331093482 bytes**，SHA-256 **`43fd76bcd0eb55446ce7da77aaa821ff6ed7f205a7c0f0e8ff0c27d3248815d2`**；实际重新读取两份归档计算摘要并比较。官方 GPG 验签、复制前后应用签名和全部公共门禁通过；218 个 Mach-O 的最高最低系统要求为 11.0.0，14 个 PE 中仅 10 个有逐文件声明的非运行模板使用架构例外。
- 通过本地 loopback 服务，由真实 Electron `utilityProcess` 运行预装 worker，使用公共初始化协议安装到含中文和空格的 `用户 验收` 路径。一次资源请求后状态为 `ready`，资源定义的运行检查成功；生成的 `zcode-soffice` 独立版本检查也成功，运行前后 `codesign --verify --deep --strict` 均通过。`SOURCES.json` 覆盖官方安装包、完整签名指纹、对应源码归档及字体，`LICENSES/` 内容齐全。
- 证据存于仓库外的本次 artifacts `07/`：`reproducibility.json`、`installed-validation.json`、`loopback-first/result.json`、`resources/mac-first/`、`resources/mac-repeat/` 及 `logs/`。最初失败的回归、真实制作和下载日志均保留；生产描述中的 `validation.runtime: not-run` 表示制作阶段不运行安装检查，实际安装结果由上述独立证据记录。

### 其他目标与未验证项

| 目标                 | 本次实际结果                                                                                                                         | 尚未完成                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| macOS x64 26.8.1     | 固定输入下载期间发生 `UND_ERR_SOCKET`，未得到通过摘要核对的完整输入；没有确定网络根因                                                | 未产出 r2，结构与运行均 not-run                                      |
| Linux x64 25.8.7     | 已按固定输入与官方 GPG 核对后产出 r2；263 个 ELF 的最高 GLIBC 要求为 2.28，14 个 PE 中仅 10 个经声明的模板使用架构例外，公共门禁通过 | 系统共享库、安装后运行、中文空格路径和此目标的实际重复制作均 not-run |
| Windows x64 26.8.1   | 部分输入下载后主动终止，以交还资源操作执行权并推进依赖票；未产出                                                                     | 完整输入核对、结构及运行均 not-run                                   |
| Windows arm64 26.8.1 | 未开始下载或制作                                                                                                                     | 产出、结构与运行均 not-run                                           |
| Linux arm64 26.8.1   | 本次未重新下载或制作；未修改原有 GLIBC 门槛                                                                                          | 产出、结构与运行均 not-run；原规格阻塞不视为本次已复验               |

以上其余目标交 [13](13-other-platform-verification.md) 补齐。没有降低任何门禁，没有据配方存在推断已产出。各平台 DLL/系统共享库的实际加载、Windows 入口与 Git Bash、macOS x64 仿真、完整文档转换和宏链路未在本票运行；完整本机文档链路由 12 验证。法务确认、源码归档/CDN 发布和正式 catalog 注入不在本票内，均未执行。

### Linux x64 追加证据

- 初次门禁的精确匹配来自已验签输入中的诊断字符串：`libEngine12.so` 的 `/home/buildslave/build/workdir/UnpackedTarball/firebird/src/jrd/evl.cpp` 与 `idx.cpp: 1477` 等源码/断言行号；`liblibreofficekitgtk.so` 的 `/home/buildslave/source/libo-core/libreofficekit/source/gtk/lokdocview.cxx`；`liborcus-parser-0.20.so.0` 的 `/builddir/build/BUILD/gcc-12.2.1-20221121/.../libstdc++-v3/include/` 头文件路径。
- 已按批准规则分别声明三个精确前缀及官方安装包来源，仍逐文件核对原始字节摘要。此证据支持诊断路径声明；没有据静态扫描声称 Linux 运行时不依赖构建路径。另核对 pyuno 中 pip/distlib 和 setuptools 的模板读取代码，按实际 x64 不匹配项声明精确路径、SHA-256、来源与用途，未按目录或扩展名放行。
- 最终归档 `libreoffice-25.8.7-linux-x64-r2.tar.gz`：**362136001 bytes**，SHA-256 **`4650f1cb3b8f3cdaf7cfa66bce12773eb3a28f9fcdfbbd1ff2ea6be1b96ef5fc`**。已重新读取归档核对大小/摘要；仅结构制作通过，目标运行未执行。
- 仓库外 `07/` 证据：`linux-x64-validation.json`、`linux-x64-upstream-paths.txt`、`linux-x64-libreofficekit-paths.txt`、`linux-x64-orcus-paths.txt`、`linux-x64-template-evidence.json`、`linux-x64-template-usage.txt`、`resources/linux-x64/`。所有先前失败的制作日志保留，最终成功为 `logs/linux-x64-templates-retry.log`。
- 最终 recipe 更新后，重新运行受影响工程测试（86/86）及根 typecheck、lint、architecture 检查，均通过；格式和 diff 检查通过。没有启动新的其他目标下载或运行验收。
