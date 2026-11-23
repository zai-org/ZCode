# 预装工具：LibreOffice

通用合同见 [预装工具](README.md)。本文写 LibreOffice 的来源、资源制作、入口和插件统一入口。首期的实施和验收记录见 [01](../issues/document-tool-preinstall/01-libreoffice-preinstall.md) 与 02～12 号票。

## 作用

文档插件用 LibreOffice 做文档转 PDF、PPT 转换、旧版 `.doc` 转 `.docx` 和表格公式重算。

- LibreOffice 在预装链路中是普通工具：`toolId` 为 `libreoffice`，专用入口 `zcode-soffice`，不占用 `soffice` 这个名字。
- 预装链路不再有 LibreOffice 专用的代码、环境变量或安装记录格式。
- 正确调用 LibreOffice 的逻辑（独立配置、重算宏、字体替换、失败重跑）属于插件统一入口。用户自己的 LibreOffice 也需要这些逻辑。

## 平台与版本

| 平台         | 版本   | 来源     | 现状                                                                     |
| ------------ | ------ | -------- | ------------------------------------------------------------------------ |
| darwin-arm64 | 26.8.1 | 官方 dmg | r2 已产出，本机真实运行验收通过；已部署 CDN                              |
| darwin-x64   | 26.8.1 | 官方 dmg | r2 已产出，结构检查与 Rosetta 统一入口验证通过；Intel Mac 原生验收待完成 |
| win32-x64    | 26.8.1 | 官方 msi | r3 已产出；Windows 真实运行验收（real-loopback）通过                     |
| win32-arm64  | 26.8.1 | 官方 msi | r3 已产出，结构检查通过，未运行；此前没有产出过                          |
| linux-x64    | 25.8.7 | 官方 deb | 已产出，所有 ELF 需要的 GLIBC 不高于 2.28，未运行                        |
| linux-arm64  | —      | —        | 阻塞：26.8.1、26.2.6 和 25.8.7 都需要 GLIBC 2.34                         |

- 现有首期产物使用 r1。本期配方使用 r2，并通过通用打包检查（含 Mach-O 最低系统版本不高于 13.0）、`LICENSES/` 与 `SOURCES.json`、新的清单字段重新制作。Windows 配方随后升为 r3，补齐 MSI 空目录（见下文“来源与转换”）。实际产出与验证记录见 [07](../issues/preinstalled-tools/07-packaging-common-and-libreoffice.md)，配方存在不代表已产出。
- 2026-11-06 已部署到 `cdn-zcode.z.ai` 并接入内置清单的资源为 darwin-arm64 r2、darwin-x64 r2、win32-x64 r3；目录与摘要以通用规格的内置资源清单为准。其他平台的生产下载目标不由配方是否存在推导。
- 制作入口为 `scripts/preinstalled-tools/libreoffice/convert.mjs`；公共门禁与分组地址发布入口见 [资源制作工具](../../scripts/preinstalled-tools/README.md)。
- 系统已装的 LibreOffice 不设版本门槛，旧版和开发版都可以使用。受管版本由实际验收选定，不作为系统版本的门槛。

## 来源与转换

- 使用 LibreOffice 官方发布的二进制，并核对官方 GPG 签名。不自己编译，不修改官方二进制。
- 官方镜像只保留最近几个版本，所以资源放在 ZCode CDN，运行时不从公共镜像下载。
- 源下载按 recipe 中的字节数设上限，超出时立即中止并清理。完整的源缓存用不覆盖的原子发布写入；并发制作遇到同名输入时，重新核对大小与摘要。
- macOS：从 dmg 取出 `.app`，保持官方签名封存不变。复制前后都严格检查签名，用 `lipo` 检查架构。随包字体放在安装目录内一个独立的资源视图 `resource-base/` 中。
- macOS 官方应用的 `LibreOffice.app/Contents/Frameworks/LibreOfficePython.framework/Versions/3.13/lib/python3.13/site-packages/pip/_vendor/distlib/` 中包含 `t32.exe`、`w32.exe`、`t64.exe`、`w64.exe`、`t64-arm.exe`、`w64-arm.exe`。它们是 pip 生成 Windows 命令脚本时读取和复制的启动器模板，不是本资源的运行入口或加载库；删除它们会破坏应用签名封存。recipe 按通用规则为架构不匹配的模板逐文件声明精确路径、SHA-256、来源和用途；架构本来匹配的模板不能声明为例外。模板升级后的路径或摘要变化必须重新审阅，不按目录或扩展名批量放行。
- 同一 Python 的 `site-packages/setuptools/` 还包含 `cli.exe`、`cli-32.exe`、`cli-64.exe`、`cli-arm64.exe`、`gui.exe`、`gui-32.exe`、`gui-64.exe`、`gui-arm64.exe`。`command/easy_install.py` 的 Windows 启动器生成逻辑把这些文件作为字节串读取和复制，同样按上述精确声明规则审阅；arm64 资源只声明六个不匹配项。
- Linux x64 25.8.7 的 `LibreOffice/program/python-core-3.11.15/lib/` 同样包含上述 pip/distlib 与 setuptools 模板及其读取逻辑。该 recipe 按已验签输入逐项核对精确路径、摘要和用途，仅声明十个不匹配 x64 的模板。
- Windows：用 `msiextract` 解出应用目录。VC++ 运行库按 MSI File／Media 表的唯一文件 ID，从已验签的内嵌 CAB 中提取，再按实际 PE 架构选择，不依赖通用解包后的 System64 目录。入口与随包 DLL 必须与目标 PE 架构一致；除基础 DLL 外，还检查程序导入表引用的 VC++ DLL 是否齐全。缺少有许可来源的必需 DLL 时停止制作。不把 redistributable 安装程序当作 app-local 运行库。选中的运行库与应用目录文件一样，按已验签 MSI 的来源和摘要接受构建路径门禁核对。
- Windows：`msiextract` 只提取文件，不重建 MSI 用 CreateFolder 表创建的空目录。制作时按 MSI 的 CreateFolder、Directory、Component、File 表补齐应用目录内的这些空目录，结果与官方安装一致。应用目录由 File 表中 `soffice.com` 所在的 `program` 目录的父目录确定，不依赖 `msiextract` 的输出目录名；应用目录以外的条目不进入资源。组件带安装条件、目录链断开或目录名不安全时停止制作。
  - 原因：`share/uno_packages/cache/uno_packages` 是 shared 扩展仓库的缓存位置，在安装目录内，不在每次调用的私有配置目录内。目录缺失时，多个 LibreOffice 进程首次完整启动会同时创建它；后创建的进程在同步扩展仓库时得到 `NameClashException`，随后 `SalAbort` 结束，而 `soffice.com` 仍返回 0，转换静默不产出。目录存在时，LibreOffice 不写安装目录。
- Linux：只读取官方 deb 的 data 归档并合并应用目录，不运行 maintainer scripts。检查 ELF64 架构；从 GNU version-needs 表读取实际需要的 GLIBC，高于 2.28、未知 ABI 或无法读取时停止。这项检查不表示系统共享库齐全。

## 随包中文字体

- 字体：未修改的 Noto Sans CJK SC Regular 与 Noto Serif CJK SC Regular，SIL Open Font License 1.1。
- 来源固定为 [Noto CJK](https://github.com/notofonts/noto-cjk) 的 `f8d157532fbfaeda587e826d4cd5b21a49186f7c` 提交。字体和许可文件的 SHA-256 写在 recipe 中。
- 字体只对这份 LibreOffice 生效，不装进系统字体目录。文档指定的字体在系统中存在时，用系统字体；不存在时，用随包字体替代。

## 许可与源码

- LibreOffice 原始许可文件保留在应用目录中。资源根目录的 `LICENSES/` 汇总 LibreOffice、随包字体和 Windows VC++ 运行库的许可文本。
- `SOURCES.json` 记录官方安装包的 URL、实际摘要、验签公钥的完整指纹，以及对应版本的源码位置，例如 [26.8.1 源码](https://download.documentfoundation.org/libreoffice/src/26.8.1/)。

## 资源清单

| 字段                        | macOS                                                  | Windows                           | Linux                         |
| --------------------------- | ------------------------------------------------------ | --------------------------------- | ----------------------------- |
| 入口 `zcode-soffice` 的目标 | `LibreOffice.app/Contents/MacOS/soffice`               | `LibreOffice/program/soffice.com` | `LibreOffice/program/soffice` |
| 入口参数                    | `-env:BRAND_BASE_DIR=${INSTALL_DIR_URL}/resource-base` | 无                                | 无                            |
| 入口环境                    | `SAL_USE_VCLPLUGIN` 默认为 `osx`                       | 无                                | 无                            |
| `rewrite`                   | 无                                                     | 无                                | 无                            |

- macOS 入口参数让官方签名的 `.app` 读取资源视图中的随包字体，不修改应用本身。
- macOS 入口环境：无头调用默认的 `svp` 后端在真实官方 26.8.1 中识别不到系统 PingFang，所以默认用 `osx` 后端。调用方显式设置了后端时，保留调用方的设置。
- Windows 使用控制台入口 `soffice.com`。
- 运行检查：`zcode-soffice -env:UserInstallation=${CHECK_TEMP_URL} --version`，输出必须包含 `LibreOffice <版本>`，超时 30 秒。独立配置目录保证检查不读写用户默认配置。
- 下载不续传。网速慢且经常退出 App 的用户，可能要多次重新下载；本期实测体积见下文。

## 插件统一入口

四个文档插件各带一份相同的 `scripts/zcode_libreoffice.py` 和 `scripts/libreoffice-profile/`。插件运行时不跨插件目录查找。工程门禁检查四份内容逐字节一致。

命令：`check`、`run -- <LibreOffice 参数>`、`recalc <文件>`。统一入口只用 Python 标准库，任何 3.9 以上的 Python 都能运行。它自己的启动方式见 [Python 规格](python.md#插件调用规则)。

### 查找程序

```text
每次调用重新查找，不缓存
1. PATH 上的 zcode-soffice（Windows 上按 PATHEXT 查找，即 zcode-soffice.exe）→ 预装版本
2. 系统已装的 LibreOffice（不限版本，含开发版）→ 系统版本
3. 都没有 → 引导
     有 ZCODE_PREINSTALLED_TOOLS_AVAILABLE：说明预装版本未就绪或已关闭，提示“帮助 → 预装工具”，
                                      由用户选择等待、打开开关，或让 Agent 按 setup.md 安装
     没有这个变量：按 setup.md 安装
   安装后仍通过统一入口调用，不直接调用 soffice
```

- 使用系统版本时，输出它的版本，以及未使用预装版本的原因：“未就绪或已关闭”，或“运行失败：<原因>”。
- 系统程序存在但版本探测失败（无法启动、非零退出或超时）时，不按“没有”处理：报告“系统 LibreOffice 无法运行：<程序与原因>”。有 `ZCODE_PREINSTALLED_TOOLS_AVAILABLE` 时仍附上预装状态的说明，但不给“未找到”的安装引导。
- 系统程序的符号链接入口保留原调用路径；解析出的目标只用来检查文件是否有效。
- 预装版本启动失败、非零退出、超时或缺少重算回执时：先终止本次进程，清理配置和回执，再用系统版本重跑一次。系统版本失败时直接报告，不再重试。用户取消或用户参数错误不触发重跑。重算文件不存在属于参数错误，在查找程序前直接报告。
- 入口在调用途中被删除时，本次调用按“启动失败”处理，同样用系统版本重跑一次。

### 每次调用的隔离

- 每次调用，包括版本探测，都把配置模板复制到一个独立临时目录，用 `-env:UserInstallation=<file URL>` 传入，子进程退出后删除。路径按 file URL 编码，支持空格和中文。不读写用户默认配置目录。
- 用户参数不能覆盖 `-env:UserInstallation`。预装版本的 `-env:BRAND_BASE_DIR` 由入口传入，统一入口不再传这个参数。
- 配置模板标记初始化已完成，避免 LibreOffice 首次启动时用预设 Standard 宏库覆盖本次的宏。不降低宏安全等级。
- 缺失中文字体使用 `org.openoffice.VCL/FontSubstitutions` 候选表：SimSun 优先 Noto Serif CJK SC，SimHei 优先 Noto Sans CJK SC，再保留官方原有候选。已安装的字体仍然优先命中。不用会强制替换已有字体的 Always 配置。
- 系统版本在 macOS 上：程序旁有原生插件时默认用 `osx` 后端；只支持无头的程序或 wrapper 保留原有后端。只设置本次子进程的环境。
- 禁止本次 LibreOffice 子进程写 Python 字节码。官方 DMG 自带的部分缓存与源码时间不一致，重新生成会改动签名封存的文件。

### 重算

- 宏从本次配置显式打开目标工作簿，禁止执行工作簿内的宏，禁止自动更新外部链接，然后 calculateAll、保存、关闭。
- 宏写出本次调用的成功回执。没有回执、非零退出或超时都算失败，不进入后续的结果扫描。

### 取消与收尾

- 格式 CLI 与直接调用入口共用 SIGTERM 处理：先取消主协程，等待 LibreOffice 子进程结束，清理配置和转换临时目录，再退出。异步嵌入 API 的取消由调用方负责。
- 子进程创建也受保护：系统已经启动程序、但创建结果还没返回时，也先取得并终止本次进程组，再释放配置。
- PDF 转换通过 `temporary_outputs` 声明自己拥有的临时输出路径。每次尝试前清理这些路径，防止预装版本失败留下的文件冒充系统版本的成功结果。

### 相对首期删除的内容

- 读取 `ZCODE_PREINSTALLED_TOOLS_RECORD` 和安装记录，核对记录地址身份与安装目录。
- `usage/` 调用标记、`deletion-gate` 检查和 `installationId` 复读。删除保护改为通用规格中的“先撤入口，再查进程”。
- 按程序目录判断预装版本是否有原生插件。预装版本的后端由入口环境提供。

### 已知限制

- Windows 上启动器先退出时，子孙进程的归属仍未完全解决：`taskkill /T` 依赖存活的根进程，没有使用 Win32 Job Object。

## 平台风险

- Windows：确认从 MSI 解出的程序在无管理员权限下可以运行，随包 VC++ 运行库生效；确认 shim 入口正确传递含空格、中文和 `%` 的 file URL 参数。
- Windows 签名：`windowsSigning` 为 `none`，见通用规格的 [Windows 签名](README.md#windows-签名)。2026-11-04 核对 win32-x64：PE 文件 231 个，没有签名的 15 个只有 Firebird 数据库驱动 `fbintl.dll`，以及内置 Python 中 pip、setuptools 的启动器模板，文档转换不会加载它们。这个结论在开启 SAC 强制模式的机器上验证。
- macOS：保留 `.app` 内的符号链接、可执行权限和签名；首次运行不出现 Gatekeeper 弹窗。
- Linux：确认系统共享库依赖；GLIBC 要求不高于 2.28。

## 体积（macOS arm64 实测）

- 资源：`libreoffice-26.8.1-darwin-arm64-r2`。
- 下载归档：**331093482 bytes**；清单安装字节数：**843505534 bytes**。
- 安装字节数是归档展开内容的口径，不是文件系统分配空间。其他平台的实际体积以各自资源清单为准。

## 验收

| ID    | 前置条件与操作                                                         | 必须观察到的结果                                                                                       |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| LO-01 | 各目标平台、普通用户、含空格和中文的路径（开发阶段只验证 macOS arm64） | 资源正确匹配；在用户目录启动并完成转换；不需要管理员权限                                               |
| LO-02 | 真实 Word、PPT 和中文排版样例；文档指定的中文字体分别存在和不存在      | 转换产物可打开，内容和分页可检查；字体存在时用系统字体，不存在时用随包字体，没有缺字方框；保留截图证据 |
| LO-03 | 含公式和错误样例的真实工作簿                                           | 重算宏实际执行，缓存结果正确，能识别公式错误；宏来自本次调用的独立配置                                 |
| LO-04 | 用户正在使用自己的 LibreOffice，同时转换或重算两个真实文档             | 输出和临时配置互不污染；用户的 LibreOffice 不被接管，配置不变                                          |
| LO-05 | PDF 插件的 Office 转 PDF，Word `.doc` 转 `.docx`                       | 都通过统一入口完成，结果可检查                                                                         |
| LO-06 | 关闭 LibreOffice 的“Agent 使用预装版本”                                | 统一入口使用系统版本，并输出“未就绪或已关闭”                                                           |
| LO-07 | 预装版本运行失败（例如超时），系统版本可用                             | 清理后用系统版本重跑一次；取消不重跑                                                                   |
| LO-08 | 预装与系统版本都不可用，桌面端                                         | 输出预装未就绪的引导，由用户选择；不自动安装                                                           |
| LO-09 | 调用前后检查 macOS 应用签名                                            | 签名始终有效                                                                                           |

程序退出码正常不能代替结果正确。宏不可见、字体缺失和转换效果问题要保留可诊断的证据，不通过跳过检查或调用其他办公软件来隐藏问题。
