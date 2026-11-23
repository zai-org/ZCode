# 预装工具：Python

通用合同见 [预装工具](README.md)。本文只写 Python 自己的来源、内容、入口和调用方式。

## 作用

- 给文档插件运行 Python 脚本，并提供插件需要的包。
- 不接管用户的 `python3` 和 `pip`。用户在自己的项目里运行 `python3`，仍然用自己的 Python。
- 插件需要 Python 3.11 或更高版本，例如 docx 插件 `scripts/document.py:34` 使用 `datetime.UTC`。预装 3.12 满足这个要求。

## 来源

- 解释器：python-build-standalone 的 CPython 3.12.x `install_only_stripped` 构建。六个目标都有原生构建，包括 Windows arm64。Linux 构建只要求 glibc 2.17。
- 调研时的候选是 release `20261026`、CPython 3.12.16。最终版本以 recipe 为准。
- 许可：CPython 为 PSF-2.0。`install_only` 包只带 CPython 的 `LICENSE.txt`。OpenSSL、SQLite、libffi、Tcl/Tk 等第三方库的许可证文本，从同一 release 完整包的 `python/licenses/` 目录取出，放进资源的 `LICENSES/`。
- 包：PyPI 官方发布的 wheel，按文件 SHA-256 锁定。不使用源码包，不自己编译。
- macOS x64 的 `python-3.12.16-20261026-darwin-x64-r2` 已于 2026-11-05 产出。使用 arm64 主机上的 x64 Node 与 Rosetta 完成制作，保留原有平台／架构检查；147 个 Mach-O 的最高最低系统要求为 13.0。四个不匹配的 pip 启动器模板逐文件声明来源和摘要。结构与 Rosetta 运行证据见 [13](../issues/preinstalled-tools/13-other-platform-verification.md#macos-x64-资源补齐2026-11-05)，不表示 Intel Mac 原生验收完成。

## 预装包

| PyPI 名                       | import 名    | 用到的插件                          |
| ----------------------------- | ------------ | ----------------------------------- |
| openpyxl                      | `openpyxl`   | xlsx                                |
| XlsxWriter                    | `xlsxwriter` | xlsx（env_check 会检查它）          |
| defusedxml                    | `defusedxml` | docx、pptx                          |
| python-docx                   | `docx`       | docx、pdf                           |
| lxml                          | `lxml`       | docx、pdf                           |
| reportlab                     | `reportlab`  | pdf                                 |
| pypdf                         | `pypdf`      | pdf                                 |
| pikepdf                       | `pikepdf`    | pdf                                 |
| pdfplumber（含 pdfminer.six） | `pdfplumber` | pdf、xlsx                           |
| pypdfium2                     | `pypdfium2`  | pdf                                 |
| pdf2image                     | `pdf2image`  | pdf（它调用 Poppler 的 `pdftoppm`） |
| Pillow                        | `PIL`        | pdf、docx、xlsx                     |
| python-pptx                   | `pptx`       | pptx                                |
| matplotlib                    | `matplotlib` | docx、xlsx、pdf                     |
| pandas                        | `pandas`     | xlsx、docx、pdf                     |
| numpy                         | `numpy`      | xlsx、docx、pdf                     |

这些包的依赖由锁文件一并固定。

不预装的包：

| 包          | 原因                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| PyMuPDF     | 法务不通过                                                                 |
| markitdown  | 插件主流程没有调用；它经 magika 带进 onnxruntime，约 164 MB                |
| adjustText  | 只在 `pdf/typesetting/charts.md` 的注释示例中出现；它带进 scipy，约 112 MB |
| pytesseract | 需要 tesseract 程序本体                                                    |

插件需要这些包时，按原流程用预装 Python 安装，包会装进附加区（见下文）。

## 版本锁定

- 每个平台生成一份锁文件，写进 recipe：`uv pip compile --python-platform <平台> --only-binary :all:`，带文件哈希。
  - macOS 设 `MACOSX_DEPLOYMENT_TARGET=13.0`，与桌面最低支持的 macOS 版本一致。
  - Linux 以 manylinux_2_28 为目标，与桌面的 GLIBC 下限一致。
- 每个平台取“满足上述约束、且该平台有 wheel”的最新版本。各平台之间的版本差异记录在 recipe 中。每个平台都跑同一套插件验收。
- 2026-10-29 按 PyPI 官方 wheel 与 macOS 13.0 / manylinux_2_28 约束解析的差异：
  - pikepdf：macOS arm64 为 8.13.0，macOS x64 为 9.11.0，其余目标为 10.17.0。9.11.0 的 arm64 wheel 标记最低 macOS 14.0，x64 wheel 标记 13.0；因此不能把两个架构合并成“macOS 都用 9.x”。实际 Mach-O 检查发现 8.14.0、8.15.0、8.15.1 的 arm64 wheel 虽标记 macOS 11，内置库仍要求 14.0；8.13.0 的全部 Mach-O 最高要求 12.0，采用该版本。
  - cryptography：macOS x64 为 48.0.1，Windows arm64 为 46.0.3，其余目标为 50.0.2。
  - 完整固定版本、每个 wheel 的 URL/摘要与各平台差异保存在 recipe 和锁文件中。解析成功不表示真实二进制或对应平台运行验证已通过。

## 资源内容

```text
versions/<resourceId>/
├─ python/                       预装区：官方解释器和预装包
│   └─ lib/python3.12/EXTERNALLY-MANAGED   （Windows 为 python\Lib\EXTERNALLY-MANAGED）
├─ overlay/                      附加区：打包时建好的虚拟环境，Agent 额外安装的包写在这里
│   └─ pyvenv.cfg                home 指向 python/ 的解释器目录
├─ zcode/constraints.txt         全部预装包的“名称==版本”
├─ LICENSES/
└─ SOURCES.json
```

转换器在官方构建的基础上做以下调整：

- 删除 pip 生成的命令脚本，例如 `python/bin/pip3`、`python/bin/pdfplumber`，Windows 上的 `python\Scripts\*.exe`。这些脚本写死了构建机的绝对路径，换了安装目录就失效。同时从对应 `RECORD` 去掉这些已删除文件的条目，避免残留随机 staging shebang 的摘要影响重复制作；保留其他文件的记录与摘要。保留解释器本身。插件统一用 `-m 模块` 或脚本路径调用。
- 在标准库目录放 `EXTERNALLY-MANAGED` 标记。pip 和 uv 会拒绝直接向预装解释器安装包。这只是防护：用户加 `--break-system-packages` 可以绕过；虚拟环境不受它影响。
- 删除预装区 site-packages 中名为 `tests` 的目录，任意深度，例如 `pandas/tests`、`numpy/_core/tests`、`matplotlib/tests`。这些是上游包自带的测试，插件和运行检查都不导入它们。
  - 只按目录名 `tests` 精确匹配。不删 `test`、`testing`、`_testing` 等目录：`numpy.testing`、`matplotlib.testing`、`pandas._testing` 是公开模块。不删标准库和附加区中的目录。
  - 在编译字节码之前删除，所以这些文件不会生成 pyc。同时从对应 `RECORD` 去掉已删除文件的条目，做法与删除命令脚本相同。
  - 制作记录（资源描述的 `provenance.removedTests`）逐项列出删除的目录（相对资源根目录的路径）、文件数和字节数，按路径排序。同一输入重复制作时记录不变。
  - 影响：`numpy.test()`、`pandas.test()` 等运行上游测试的函数不能使用。这不属于支持的用法。
  - 原因：Windows Defender 实时防护扫描每个新写入的文件，文件数直接决定首次安装的解包时间（见 [13 的解包耗时记录](../issues/preinstalled-tools/13-other-platform-verification.md)）。2026-11-04 核对 `python-3.12.16-20261026-win32-x64-r1`：测试目录外只有两处引用 `tests`，都不影响运行。`openpyxl/reader/excel.py` 在 `try` 中导入，`ImportError` 已处理；`reportlab/platypus/tables.py` 只在 `__main__` 下导入。
- 装完 wheel、删除测试目录、建好附加区后，对 `python/` 整体预编译字节码，使用 `compileall --invalidation-mode unchecked-hash`，固定编译时 `PYTHONHASHSEED=0`，并用 `-s <staging 根目录>` 去掉打包路径前缀。解释器与优化级别等编译参数固定；已有 timestamp 缓存也必须转为该模式，不能因缓存已存在而跳过。
  - 只生成优化级别 0 的缓存（默认运行使用的 `.cpython-312.pyc`），不生成 `-O`、`-OO` 使用的 `.opt-1.pyc`、`.opt-2.pyc`。插件、入口和运行检查都不用 `-O` 或 `-OO` 运行，也不设置 `PYTHONOPTIMIZE`。
  - 有人用 `-O` 或 `-OO` 运行预装解释器时，Python 在导入时编译，并把缓存写进预装区的 `__pycache__`。这不属于支持的用法；PY-03 只覆盖插件主流程和 `-m pip install`。
  - 原因：以前生成 0、1、2 三个级别，pyc 数量是 `.py` 的 3 倍。`win32-x64-r1` 中 `.opt-1`、`.opt-2` 缓存共 9,538 个文件、174 MB，占全部文件的 41%。
- hash 模式不依赖文件时间，与固定时间的归档兼容。预装区按合同只读，所以导入时不再核对源码；手动修改预装区源码可能不会生效，这不属于支持的用法。
- 打包检查：`python/` 下每个能编译的 `.py` 都有对应的 `unchecked-hash` 模式 pyc。编译失败的文件逐项记录路径和错误原因，不因这类文件阻止打包；不能把未执行编译或未完成检查当成编译失败例外。记录中的 staging 根目录一律写成 `<staging>`，包括编译器按 repr 转义后的写法；记录不含本次打包路径，同一输入重复制作时记录不变。
- 生成 pyc 若仍含原始源码中的上游路径常量，按通用规格的 `.pyc` 格式规则核对：原始源码来源与摘要不变，前缀同时存在于源码且已声明，使用资源解释器与固定参数独立重编译后逐字节一致。只有这种 pyc 才需要派生证明，不为其他生成文件放宽路径门禁。
- 运行时不设置 `PYTHONPYCACHEPREFIX` 或 `PYTHONDONTWRITEBYTECODE`。附加区新装包的缓存照常生成在附加区，插件脚本的缓存照常写在插件目录，不增加新的缓存目录或运行时环境合同。
- 不修改目录权限。

2026-10-29 已核对 macOS arm64 的固定输入：原始 pip 26.2.2 在 `python/lib/python3.12/site-packages/pip/_vendor/distlib/` 内带有 `t32.exe`、`w32.exe`、`t64.exe`、`w64.exe`、`t64-arm.exe`、`w64-arm.exe`。其代码只在生成 Windows 命令脚本时读取模板字节，不直接执行这些原模板。recipe 为四个非 arm64 模板记录精确路径、SHA-256、已核对输入来源和用途；两个架构已匹配的模板不列为例外。其他平台必须核对自己的输入后再声明，不能照抄此清单。

## 附加区

Agent 额外安装的包放在附加区，不写进预装区。这样新装的包不能改动预装包的版本。附加区在版本目录里面，升级和删除时随版本一起处理，不需要额外的目录或安装步骤。

打包时建好附加区：

1. 用预装解释器创建虚拟环境 `overlay/`，参数为 `--system-site-packages --without-pip`。附加区借用预装区的 pip。
2. POSIX 上，把 `overlay/bin/python` 等链接改成指向 `../../python/bin/python3.12` 的相对链接。删除 `activate` 等用不到的脚本。
3. 把 `pyvenv.cfg` 中的构建机绝对路径换成占位符，并在清单的 `rewrite` 中以 `text` 模式声明。安装时，通用的改写步骤把占位符换成真实的版本目录。

固定预装包的版本：入口设置 `PIP_CONSTRAINT=${INSTALL_DIR_URL}/zcode/constraints.txt`。用 file URL 而不用 pip 配置文件里的路径，是因为 pip 会按空白拆分约束路径，含空格的用户目录（Windows 上常见）会出错；file URL 中的空格已编码。

效果：

```text
zcode-python 的模块查找顺序
1. 插件自己的目录（sys.path.insert、PYTHONPATH）
2. 预装解释器的标准库
3. 附加区的 site-packages   ← Agent 额外安装的包
4. 预装区的 site-packages   ← 预装包

zcode-python -m pip install X
  → pip 来自预装区，包写进附加区
  → 约束文件固定预装包的版本：X 需要不同版本时，安装报错，不覆盖预装包
```

- Python 资源升级后，新版本带一个新的空附加区；旧附加区随旧版本一起删除。额外安装的包要按插件流程重新安装。
- 删除 Python 时附加区一起删除。确认框追加 Python 自己的文案“Agent 额外安装的 Python 包也会删除。”关闭开关不删除附加区。
- 卡片上的占用大小取自清单，不包含附加区中后装的包。

## 入口

- 入口名 `zcode-python`，专用入口。
- 目标：`overlay/bin/python`，Windows 为 `overlay/Scripts/python.exe`。
- 环境：
  - 设置 `PYTHONNOUSERSITE=1`。不设时，用户装在 `~/.local` 的包排在预装包前面，会盖过预装版本。
  - 设置 `PIP_CONSTRAINT`，见“附加区”。
  - 清除 `PYTHONHOME`。用户环境中有这个变量时，预装解释器无法启动。
  - `PYTHONPATH` 保持不变，因为插件会按命令设置它。

## 运行检查

- `zcode-python -c "import openpyxl, xlsxwriter, defusedxml, docx, lxml, reportlab, pypdf, pikepdf, pdfplumber, pypdfium2, pdf2image, PIL, pptx, matplotlib, pandas, numpy; print('zcode-python-ok')"`，输出必须包含 `zcode-python-ok`。超时 180 秒：首次导入要加载大量新写入的扩展库，macOS 首次检查实测约 45～63 秒（见通用规格的运行检查一步），原来的 60 秒没有余量。
- `zcode-python -m pip --version`，输出必须包含 `pip`。超时 30 秒。

## 插件调用规则

- 运行脚本：`"$(command -v zcode-python || command -v python3)" "$XLSX_SKILL_DIR/xlsx.py" ...`
- 安装包：`"$(command -v zcode-python || command -v python3)" -m pip install ...`
- Bash 的 setup 与 env_check 脚本在开头解析一次 `PY="$(command -v zcode-python || command -v python3)"`，之后的 Python 检查、包检查和 `pip install` 都用 `$PY`。
- PowerShell 脚本先用 `Get-Command zcode-python -ErrorAction SilentlyContinue` 查找，找不到再用原有的 `py`、`python3`、`python` 选择逻辑。
  - 文档中明确标注为 PowerShell 的原生示例使用相同的 `Get-Command` 选择规则和调用运算符 `&`；Bash 示例使用上面的 `command -v` 表达式。两者都只在入口不存在时选择系统解释器，不按运行结果自动回退。
- 插件 Python 代码中用 `sys.executable -m pip install` 的地方不改，例如 `pdf.py` 的 env.fix 和 pypdf 自动安装。在 `zcode-python` 下运行时，`sys.executable` 就是附加区的解释器，包会装进附加区。
- 工程门禁检查四个文档插件的 skills 和 scripts：除上述表达式外，不得出现裸 `python` 或 `python3` 调用。
  - 检查 Markdown 命令示例、脚本命令及脚本输出的调用提示：解释器后接选项、脚本路径或参数，或出现在 shell 命令位置时，视为调用；裸 `pip install` 同样改为所选解释器的 `-m pip install`。在命令位置直接执行带参数的 `.py` 脚本路径（例如 `"$XLSX_SKILL_DIR/xlsx.py" pivot`）也视为调用，因为它经 shebang 落到系统 `python3`。
  - 普通说明中的语言名、`python-docx` 等包名、代码围栏的语言标记、Python shebang、Python 字典键不算调用。shebang 仅声明脚本格式，插件仍通过上面的表达式启动脚本。
  - PowerShell 的系统解释器候选列表保留，但只在找不到 `zcode-python` 时使用；Python 内部的 `sys.executable` 调用保留。
- 远端、独立 CLI 和开关关闭时，表达式自然落到 `python3`，行为与现在相同。系统 Python 低于 3.11 或缺包时，按 setup.md 处理。

## 出问题时

“出问题”包括：

- 用 `zcode-python` 安装包失败：当前平台没有这个包、与预装包的版本冲突、网络失败。
- `zcode-python` 本身无法运行。

脚本自身的错误不算，例如文档内容有问题。

```text
出问题 → Agent 停下这一步 → 说明失败原因 → 让用户选择：
  a) 只有这一步用用户自己的 python3；缺包时装进用户自己的 Python
  b) 在“帮助 → 预装工具”中关闭 Python 的开关，之后都用用户自己的 Python
```

Agent 不自动回退。回退可能要往用户自己的 Python 里安装包，这会改变用户电脑上的环境。各插件的 setup.md 写明这条规则。

## 体积（macOS arm64 实测）

- 资源：`python-3.12.16-20261026-darwin-arm64-r2`。
- 下载归档：**115169488 bytes**；清单安装字节数：**311814470 bytes**。
- 安装字节数是归档展开内容的口径，不是文件系统分配空间。Python 附加区后来安装的包不计入该值。其他平台的实际体积以各自资源清单为准。
- 与裁剪前的 `-r1` 相比：下载归档从 173350995 bytes 降到 115169488 bytes，安装字节数从 544706594 bytes 降到 311814470 bytes，归档条目从 23,325 个降到 10,339 个（见 [15 的 macOS arm64 记录](../issues/preinstalled-tools/15-python-resource-trim.md#macos-arm64-记录)）。
- Windows x64 实测 `python-3.12.16-20261026-win32-x64-r2`：下载归档 **104928844 bytes**，清单安装字节数 **285738435 bytes**。与 `-r1` 相比，普通文件从 23,286 个降到 10,513 个，下载归档从 163392376 bytes 降到 104928844 bytes，安装字节数从 519876327 bytes 降到 285738435 bytes（见 [15 的 Windows x64 记录](../issues/preinstalled-tools/15-python-resource-trim.md#windows-x64-记录)）。

## macOS 签名

- python-build-standalone 的二进制只有 ad-hoc 签名。Apple Silicon 只要求签名有效，ad-hoc 签名就够。
- 预装进程用 Node 写文件，文件不带 quarantine 属性，所以不触发 Gatekeeper（推断）。
- 保留上游签名，不在打包流水线中重签。必须在 macOS 13 和 15 真机上确认没有弹窗。企业 MDM 或安全软件是否会拦截 ad-hoc 签名的程序，没有找到证据，也要在验收中覆盖。

## Windows 签名

- `windowsSigning` 为 `zcode`，规则见通用规格的 [Windows 签名](README.md#windows-签名)。
- 2026-11-04 核对 `python-3.12.16-20261026-win32-x64-r2`：PE 文件 163 个。已有有效签名的 10 个（Python Software Foundation 5 个，微软 5 个），保留不变。没有签名的 153 个：`.pyd` 131 个，`.dll` 10 个，`.exe` 12 个。
- 排除 pip 的 6 个启动器模板：`python/Lib/site-packages/pip/_vendor/distlib/` 下的 `t32.exe`、`t64.exe`、`t64-arm.exe`、`w32.exe`、`w64.exe`、`w64-arm.exe`。pip 生成命令启动器时，复制模板并在文件末尾追加脚本，签名会失效。
- 签名的文件有 147 个，包括 `python.exe`、`pythonw.exe`、`python312.dll`、`DLLs/` 下的扩展、site-packages 中的 `.pyd` 和随包 DLL，以及 `overlay/Scripts/` 和 `Lib/venv/scripts/nt/` 下的 `python.exe`、`pythonw.exe`。venv 原样复制这两个文件，签名仍然有效。
- 附加区中 Agent 后来安装的包没有签名，见通用规格。

## 验收

| ID    | 前置条件与操作                                                        | 必须观察到的结果                                                                                                                |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| PY-01 | Python 已就绪，四个插件各跑一个依赖 Python 的主流程                   | 都用 `zcode-python` 运行；预装包可导入；docx 目录脚本、pdf 的 reportlab 流程、xlsx 重算后的扫描、pptx 的 python-pptx 检查都成功 |
| PY-02 | 关闭 Python 开关，再打开                                              | 关闭后表达式落到用户的 `python3`；打开后恢复                                                                                    |
| PY-03 | 运行插件主流程，并用 `zcode-python -m pip install` 安装一个未预装的包 | 包在附加区中；预装区不新增文件，原有文件摘要也不变；下一次调用可以导入，预编译遗漏不能被忽略                                    |
| PY-04 | 安装一个要求不同版本预装包的包                                        | pip 因约束失败；预装包不变；Agent 按“出问题时”处理                                                                              |
| PY-05 | 直接用预装解释器 `python/bin/python3 -m pip install`                  | 被 `EXTERNALLY-MANAGED` 拒绝                                                                                                    |
| PY-06 | 用户 `~/.local` 中装有另一版本的 numpy                                | `zcode-python` 导入的是预装的 numpy                                                                                             |
| PY-07 | Python 升级到新的 `resourceId`                                        | 新版本的附加区为空；旧版本（含旧附加区）在下次启动时删除                                                                        |
| PY-08 | 删除 Python                                                           | 确认框有附加区提示；附加区随版本目录删除                                                                                        |
| PY-09 | 安装目录路径含空格和中文                                              | 改写后 `zcode-python` 可以运行；`-m pip install` 写进附加区，约束生效                                                           |
| PY-10 | macOS 13 和 15 真机首次运行（人工）                                   | 没有 Gatekeeper 或安全软件弹窗                                                                                                  |
| PY-11 | Windows 真机（人工）                                                  | 改写 `pyvenv.cfg` 后附加区可用；约束生效；入口 shim 正确传参                                                                    |
| PY-12 | 检查新制作的资源                                                      | 预装区 site-packages 中没有 `tests` 目录；没有 `.opt-1.pyc`、`.opt-2.pyc`；运行检查与 PY-01 通过                                |

需要实测才能确认的点：

- 改写 `pyvenv.cfg` 后的虚拟环境在三个系统上能否正常运行；POSIX 的相对链接是否被正确解析。
- 用 `--without-pip` 创建的虚拟环境借用预装区的 pip，能否把包装进附加区。
- `PIP_CONSTRAINT` 使用 file URL 时，对所有安装命令是否都生效。
- `PIP_CONSTRAINT` 会被 `zcode-python` 启动的子进程继承。如果插件脚本在其中调用另一个 Python 的 pip，约束也会作用于它。现有插件的安装代码都用 `sys.executable`，不受影响。
