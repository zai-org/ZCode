# 09 — Python 资源

Status: done

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

产出可以安装的 Python 资源。装好后，`zcode-python` 能运行文档插件需要的全部预装包。Agent 另外安装的包写进附加区，不改动预装包。规则见 [Python 规格](../../preinstalled-tools/python.md)。

- **转换器**：
  - 解释器用 python-build-standalone 的 3.12 `install_only_stripped`。第三方许可证从同一 release 的完整包中取出。
  - 预装包只用 wheel。按平台生成带哈希的锁文件，写进 recipe。macOS 以 13.0 为目标，Linux 以 manylinux_2_28 为目标。
  - 包清单按规格，不包含 PyMuPDF、markitdown、adjustText 和 pytesseract。
  - 删除 pip 生成的命令脚本，放入 `EXTERNALLY-MANAGED` 标记，生成 `zcode/constraints.txt`。
  - 打包时建好附加区：
    - 用 `--system-site-packages --without-pip` 创建虚拟环境。
    - POSIX 上把链接改为相对链接。
    - 把 `pyvenv.cfg` 中的构建机路径换成占位符，并以 `text` 模式声明 `rewrite`。
  - 入口 `zcode-python` 的目标与环境：`PYTHONNOUSERSITE=1`；`PIP_CONSTRAINT` 设为约束文件的 file URL；清除 `PYTHONHOME`。另加两项运行检查。
  - wheel 与附加区就绪后，对完整 `python/` 预编译 `unchecked-hash` 模式字节码，去掉 staging 路径前缀，并把已有 timestamp 缓存转换为该模式。检查每个能编译的 `.py` 都有对应缓存；编译失败逐文件记录原因，不阻止打包。运行时不新增 `PYTHONPYCACHEPREFIX` 或 `PYTHONDONTWRITEBYTECODE`，附加区及插件自身的缓存方式不变。
  - 固定编译时 `PYTHONHASHSEED=0`、资源解释器和优化级别等参数。含已声明上游路径的生成 pyc 按公共层 `.pyc` 格式检查独立重编译，并核对原始源码来源、摘要、前缀和完整产物字节；不增加通用派生框架，不改其他路径门禁。
  - 生成 `LICENSES/` 与 `SOURCES.json`。
- **产出**：
  - 本机产出 macOS arm64 资源。
  - 为其余五个目标生成锁文件，能产出的就产出，并做结构检查。
- **对话框**：Python 的删除确认框加一句“Agent 额外安装的 Python 包也会删除。”，提供中英文。

## Acceptance criteria

- [x] macOS arm64 资源经 loopback 安装后，两项运行检查都通过。
- [x] 运行插件主流程并用 `zcode-python -m pip install` 安装一个未预装的包：包写进附加区，预装区不新增文件且原有文件摘要不变，下一次调用能导入这个包（PY-03）。
- [x] 每个能编译的预装 `.py` 都有 `unchecked-hash` 缓存；编译失败的文件和原因有日志；缓存不含打包机路径，固定归档时间后仍有效，重复制作结果一致。
- [x] `.pyc` 格式例外的每种拒绝情况先有失败用例：源码没有该前缀、源码已改动、不同编译参数导致重编译字节不同、pyc 含本次打包路径、其他生成文件含上游路径。只审计需要该豁免的生成 pyc；不一致时列出文件并失败，不能退回直接允许。
- [x] 安装一个与预装包版本冲突的包：pip 因约束失败，预装包不变（PY-04）。
- [x] 直接用预装解释器安装包，被 `EXTERNALLY-MANAGED` 拒绝（PY-05）。
- [x] 用户 `~/.local` 中有另一个版本的 numpy 时，导入的仍是预装版本（PY-06）。
- [x] 删除 Python 时，确认框显示附加区提示，附加区随版本目录一起删除（PY-08）。
- [x] 安装目录含空格和中文时，运行和安装都正常，约束生效（PY-09）。
- [x] 打包检查全部通过；各平台锁文件之间的版本差异记录在 recipe 中。

## Blocked by

- [06 — 安装时改写路径与重签](06-install-rewrite-and-resign.md)
- [07 — 打包工具通用层与 LibreOffice 资源重新产出](07-packaging-common-and-libreoffice.md)

## 验证

- 受影响的工程测试；根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- loopback 安装用桌面 E2E 候选或可以重复运行的本地脚本完成。升级场景 PY-07 和插件主流程场景 PY-01、PY-02 由 [12](12-macos-arm64-full-chain.md) 验证。

## Comments

- 实施提交：`1ee83ae6810c3e86212dcf029a2ac9f9cd76cb1b`（Python 转换器、六平台锁与配方、完整字节码预编译、公共 pyc 审计、删除说明和待审核桌面候选）。本票拆出的公共修正为 `eaaafdcfb1bdd654e270be21675b22b218b1d30d`（同前缀的来源是备选）与 `bdc934420fbc3f733dc22886391bfbc039a64dc1`（PBS 的 + 与 conda 的 \_ 安全文件名）；均已交集成分支复用。起始 HEAD 为 `55717ec63b31987065ab57467b051847566a6d5e`，已执行新鲜度检查；实施提交前与集成 tip `bdc934420fbc3f733dc22886391bfbc039a64dc1` 一致。
- 已执行：`pnpm test:engineering scripts/preinstalled-tools`，16 文件、127 项通过；根 `pnpm typecheck`、`pnpm lint`（172 项既有 warnings、0 errors）、`pnpm architecture:check --changed`（0 violations）通过；桌面 `typecheck:e2e`、本候选的 `e2e:fixture:check`、格式、diff 和本票文档链接检查通过。工程回归先红后绿，覆盖完整包集合、wheel/hash/平台约束、相对附加区、五种 pyc 拒绝情况、固定时间后的缓存、路径边界和失效 RECORD 条目。
- PBS 3.12.16 / 20261026 的 runtime 与完整包已核对固定 SHA-256，并通过公开 bundle 的 `gh attestation verify` 核对官方 release workflow 身份；wheel 按配方固定摘要核对，不把摘要称为签名。许可证来自完整包元数据与原始 wheel，资源生成 `LICENSES/` 和 `SOURCES.json`。macOS arm64 的 4 个不匹配 distlib PE 模板按精确路径、摘要、来源和用途声明；其他平台没有照抄此例外。
- 本机资源 `python-3.12.16-20261026-darwin-arm64-r1` 两次完整制作一致：归档 **173350995 bytes**，SHA-256 **`40af8ac9b17f3e5662532e06b92b865846846d9292e0d9437a9941c640db9750`**，安装内容 544706594 bytes。全部制作门禁通过；147 个 Mach-O 的最高最低系统要求为 13.0。pikepdf 8.14.0、8.15.0、8.15.1 的实际库要求 14.0，均未采用；8.13.0 全部 Mach-O 最高要求 12.0。
- 4,730 个预装源码全部编译为 0/1/2 优化级别的 14,190 个 unchecked-hash 缓存，编译失败为 0。生成 pyc 不冒充原始上游文件；需要上游前缀例外时，用资源解释器独立重编译并核对完整字节。实际运行不继承 `-B` 或缓存变量；入口的 `dont_write_bytecode=false`、`pycache_prefix=null` 已核对。归档固定时间后，默认及 `-O` / `-OO` 导入成功，异常回溯指向实际安装源码。
- 真实 Electron utilityProcess 从 loopback 安装到含中文与空格的目录，一次 HTTP 请求后 ready，两个运行检查通过。通过实际入口执行文档读写、加密和渲染；另执行仓库未修改的 docx 目录脚本（插入 2 条）、xlsx 重算及扫描（managed LibreOffice 26.8.1.1、缓存值 9、0 异常）、PDF palette/ReportLab 路线及 python-pptx 检查。插件流程后再安装新的本地 wheel，下一次调用从 overlay 导入成功。归档原树、安装运行检查后、文档流程及安装附加包后，预装区 **21,787 个文件与链接的完整集合和摘要一致，新增/修改/删除均为 0**；未排除任何 pyc。
- 已执行 PY-04～06、09：有实际可用候选 wheel 的版本冲突因约束产生 ResolutionImpossible；直接向基础解释器安装得到明确的 externally-managed-environment；用户 site 中的模拟 numpy 有基础解释器正对照，而入口仍导入预装 2.5.4；中文空格路径中的附加区安装和约束均正常。
- PY-08 桌面候选最终 1/1 通过：中英文 × 深浅主题、760 像素窄窗口提示均可读；可导入的附加包、版本目录和入口均随删除完成而消失。候选保留在 manual-review/pending，未转正。首轮在 not-installed 状态出现时过早断言目录已删除；按 owner 的删除顺序改为等待已有命令回执后检查，未改变产品时序，也未用 sleep 掩盖失败。
- 保留了初期 209 个新增缓存、上游默认/诊断路径、文档 URL 扫描误报、pikepdf 最低系统版本、随机 shebang 留在 RECORD 摘要导致重复归档不同等证据。另保留 E2E 首轮失败，以及验证夹具漏拷 PDF 共享启动器的失败；对应修正后重验通过。未覆盖原始失败日志。
- 六个平台均已生成 wheel-only 带哈希的锁文件与配方，并核对锁摘要、包名/版本和所选 wheel 摘要；版本差异记录在 recipe。**其余五个平台未制作实际资源，未做对应二进制结构或运行验证**，本机转换器要求匹配的原生构建主机；不把锁解析或配方存在视为平台通过。macOS 13/15 真机首启、Gatekeeper/MDM、安全软件、Windows 入口和用户目录实际场景未验证，交 13。Agent 选择表达式、开关回退、升级及完整五工具链交 12；本票未改 CLI 产品代码，未运行 CLI 独立 typecheck/lint/测试。未做法务结论、CDN 上传或正式 catalog 发布，01/14 未实施。
- 仓库外本次 `09/` 产物目录保留 `delivery.json`、`reproducibility-final.json`、`resources/mac-first-final/`、`resources/mac-repeat-final/`、`loopback-final/result.json`、`installed-verification-final/result.json`、`plugin-main-final/result.json`、`e2e-delete-receipt/`、`pikepdf-candidates/` 和 `logs/`。制作描述的 `validation.runtime: not-run` 保持“制作器只记录结构验证”的含义，真实运行证据单独保存。
- 2026-11-04：字节码优化级别与测试目录的规则已由 [15](15-python-resource-trim.md) 修订：只编译 0 级字节码，删除 site-packages 中的 `tests` 目录。上文的 0/1/2 级记录和 `-O` / `-OO` 导入验证是 `-r1` 的历史结果。
