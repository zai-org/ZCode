# 13 — 其他平台人工验证

Status: ready-for-human

## Parent

[预装工具](../../preinstalled-tools/README.md)

## What to build

在真机上验证本机 macOS arm64 以外的平台，并补齐还没产出的资源。验证结论决定各平台的资源能否进入正式 catalog。

本票接手两张旧票的剩余工作：

- [文档工具预装 12](../document-tool-preinstall/12-other-platform-verification.md)：其他平台的验证。
- [文档工具预装 10](../document-tool-preinstall/10-other-platform-packages.md)：其他平台的资源产出。

### 检查清单

- **Windows x64 与 arm64**：
  - 入口 shim 能正确传递含空格、中文、`%`、`^`、`&` 的参数；撤下运行中的入口不影响正在运行的调用（PT-26，见 [Windows 入口 shim](../../preinstalled-tools/windows-entry-shim.md#验收)）。
  - Git Bash、PowerShell、cmd 和 MCP stdio 都能找到入口；在 Git Bash 中，`<bin>` 在 PATH 里的位置正确。
  - Pandoc 与 Poppler 能在 x64 仿真下运行（PD-04、PP-06）；qpdf 原生运行（QP-03）。
  - 预装 Python 的附加区、约束和入口都能工作（PY-11）。
  - LibreOffice 不需要管理员权限就能运行，随包的 VC++ 运行库生效。
- **macOS 13 与 15**：
  - 首次运行 Python、Pandoc（darwin-arm64 与 darwin-x64 两个包）和改写重签后的 Poppler 时，没有系统弹窗，也没有安全软件弹窗（PY-10、PD-03、PP-07）。
  - macOS x64 上全部工具都能运行。
- **Linux x64 与 arm64**：
  - 全部工具实际运行一次，确认缺哪些共享库。
  - Poppler 26.10 的 `binary-dir-prefix` 改写后，在含空格和中文的安装目录验证 PP-01 与 PP-04，确认数据子目录可以读取；11 的本机结果不能替代 Linux 验收。
  - LibreOffice linux-arm64 仍受 GLIBC 2.34 阻塞，记录结论。
- **资源产出**：补齐 07、09、10、11 中没有产出的目标资源。
- **主要场景**：每个平台按 12 的流程跑一遍主要场景。

## Acceptance criteria

- [ ] 每个平台的每个工具都有通过或失败的记录，证据写明系统版本和架构。
- [ ] 每个失败项都有处理结论：开修复票、改用其他来源，或者该平台不进入 catalog。
- [x] Windows `.cmd` 入口验证失败（不经 shell 的调用方找不到入口；运行中删除入口时退出码错误）。方案已交用户确认，改用 shim 可执行文件。

## Blocked by

- [12 — 本机 macOS arm64 真实资源全链路验收](12-macos-arm64-full-chain.md)

## Windows 自动化方案

在 Windows 的登录桌面会话中运行桌面 E2E（不经 SSH；SSH 会话不是桌面会话，Electron 窗口与截图不可靠）。按层执行，前一层失败先定位再继续：

1. 预装打包工程测试：`pnpm test:engineering scripts/preinstalled-tools`。
2. CLI 测试：adapters 的 `preinstalled-tools`、`document-python-entry`、`libreoffice-entry`、`mcp-network`，bootstrap 的 `preinstalled-tool-environment`。先构建 `@zcode/bootstrap...`。
3. 小包桌面 E2E 候选，`ZCODE_E2E_MANUAL_REVIEW=1`，一次一个。
4. 真实 win32 资源的 real-loopback 候选。
5. PT-26 入口矩阵：cmd、PowerShell、Git Bash、Python 列表参数、Node `execFile`、MCP stdio；参数含空格、中文、`%`、`^`、`&`；撤下运行中的入口；Git Bash 中 `<bin>` 在 PATH 中的位置。

### 小包夹具

- macOS 与 Linux 的夹具内容、入口目标和断言保持不变。
- Windows 不用 `/bin/sh`、符号链接和 `/usr/bin/curl`。每个工具的资源为 `bin/office.mjs`（Node 脚本，承担原 sh 脚本的参数/环境断言、`--fixture-location` 和运行检查请求）与入口目标 `bin/<命令>.cmd`。`.cmd` 只有一行，用 `%~dp0` 定位同目录脚本，用 `%~f0` 报告自身路径，因此文件内容只含 ASCII，与安装目录无关。
- 入口目标随平台变化，用例从安装记录的 `entries[].target` 推导期望路径，不写死 `bin/soffice`。
- 只在 POSIX 成立的断言（符号链接、可执行位、`chmod` 制造的权限故障、`ps`、`lsof` 语义）只在 POSIX 执行；Windows 需要同类故障时用 `icacls` 拒绝写入/删除，失败后恢复。不能制造同等故障的子场景如实记为未覆盖。
- 入口改用 shim 后，测试和探针直接运行 `<bin><name>.exe`，或按名字从 PATH 查找。夹具的入口目标仍是 `.cmd`，由 shim 启动。
- 真实资源候选的平台与 `resourceId` 从 `.artifact.json` 读取；macOS 专属检查（签名、xattr、系统 LibreOffice 路径等）只在 macOS 执行。
- 候选保持 `manual-review/pending`，不转正。

### 已知环境限制

- 普通用户未开启开发者模式时不能创建符号链接（`EPERM`）。第 1～3 层按普通用户环境测试；之后为让 pre-push 的受影响工程测试能在 Windows 上执行，经用户同意开启开发者模式。开启时间之后的批次不再是“未开启开发者模式”环境，记录中单独注明。
- 夹具的 `.cmd` 目标经 Git Bash 运行时，路径含空格会失败（MSYS 启动批处理时的引号问题）。这只影响以 `.cmd` 为目标的小包夹具；真实资源的目标是 `.exe`，由第 5 层单独验证。E2E 数据根需为不含空格的路径。
- 本机开启了智能应用控制（强制模式）。2026-11-03 起它拦截未签名的 chromedriver，桌面 E2E 在启动驱动时报 `spawn UNKNOWN`，用例不进入实际步骤。之前同一个 chromedriver 可以运行；拦截开始的原因未确认。同一时段本机构建的未签名 shim 仍可运行。同日用户关闭智能应用控制，之后的批次不再受此限制。

## Windows 验证记录

机器：Windows 11 家庭版 build 26200，x64（Intel），系统 ANSI 代码页 936，普通用户，第 1～3 层期间未开启开发者模式。Node 24.19.0（`mise.toml` 固定 24.14.0，`package.json` 要求 ≥24），pnpm 10.33.2，Git for Windows 2.56.0，Python 3.12.10。本机为 x64，不能覆盖 Windows arm64 的 x64 仿真（PD-04、PP-06）。

### 第 1 层：打包工程测试（2026-11-02，首次）

19 个文件：14 通过、3 失败、2 跳过；149 个用例：123 通过、5 失败、21 跳过（按平台跳过）。

| 失败用例                                                                      | 原因                                    | 分类                              |
| ----------------------------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| `common/conda.test.ts` 闭包锁、链接越界；`common/package.test.ts` PE 别名模板 | 创建符号链接 `EPERM`                    | 环境：未开启开发者模式            |
| `common/conda.test.ts` 解开 conda 元数据与可执行载荷                          | 断言 `mode & 0o111` 为 73，Windows 为 0 | 用例只按 POSIX 断言可执行位       |
| `python/bytecode.test.ts`                                                     | 找不到 `python`                         | 环境：未装 Python；安装后重跑通过 |

开启开发者模式后重跑（2026-11-02）：19 个文件 17 通过、2 跳过；150 个用例 129 通过、21 跳过（含之后新增的系统 DLL 回归用例）。可执行位用例已改为只在 POSIX 断言。

### win32-x64 资源产出（2026-11-02）

在本机用仓库转换器产出，输入与输出放在仓库外。四个 Windows recipe 此前没有在 Windows 上产出过，打包门禁逐项拒绝未审阅内容；处理方式见提交 `739cf6d6f6`（工具修正）与 `4cdf41dcef`（recipe 审阅）。

| 资源        | resourceId                                                  | 归档字节数 | 处理过的门禁                                                                     |
| ----------- | ----------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| Pandoc      | `pandoc-3.13-win32-x64-r1`                                  | 42392809   | 无                                                                               |
| qpdf        | `qpdf-12.4.2-win32-x64-r1`（升级用 `-r2` 仅改 resourceId）  | 4216982    | 上游构建路径（OpenSSL 构建根、MSVC PDB）                                         |
| Poppler     | `poppler-26.10.0-win32-x64-r1`                              | 29851302   | 系统 DLL 名单；HTTPS 源码与 freetype 许可补充；7 个上游构建根                    |
| Python      | `python-3.12.16-20261026-win32-x64-r1`                      | 163392376  | 锁文件 CRLF；wheel 与解释器的上游构建路径；pip 自带非 x64 启动器模板的架构例外   |
| LibreOffice | `libreoffice-26.8.1-win32-x64-r3`（第 4 层前 6 次用 `-r2`） | 554245658  | Windows 缺 msitools，由 Mac 产出（2026-11-03）；`-r3` 补齐 MSI 空目录，见第 4 层 |

真实运行验收见第 4 层。OpenSSL 与 gettext 编入 DLL 的安装目录 Windows conda 不改写；资源不加载 OpenSSL engines、modules 或翻译文件，这一判断来自审阅，未实测。

**确定性比对**（2026-11-03）：用同一份输入和仓库配方，在基线 `babf1736ce` 上重新制作一次，再与上表的产物比对。首次制作的配方与本次相同。

- 四个归档的字节数与 SHA-256 都一致：
  - Pandoc `8619fded90b54c16d75415b3c8e4f983519b64001cbcb41df3fca1096bcbda9b`
  - qpdf `4b712e2e361daa54d4fb05f32c3f5319e9de1e2ae78835dc22ade1d8cf69c414`
  - Poppler `1bba2df7eeb466957b3bc3ca5fe3095d6ddcfe361ceaff8d3f925468c00c2862`
  - Python `f9c2703514085c9cf66538a4a8385ecaae767196b4b43c2839f861b680159433`
- Pandoc 与 qpdf 的制作描述完全一致。
- Poppler 与 Python 的 `runtimeChecks[].timeoutMs` 不同。原因是首次制作之后，origin 放宽了这两个工具的运行检查超时。这是代码变化，不是制作不确定。
- **缺陷（已修复）**：Python 的 `provenance.bytecode.failed[].compilerOutput` 每次制作都不同，`.bytecode.json` 的同一字段也是这样。该字段含制作时的临时目录名和本机用户目录。`precompile.py` 原本要把临时根目录替换为 `<staging>`，但 `compileall` 用 repr 打印路径，Windows 上反斜杠成对出现，替换没有匹配。本资源只有一个文件编译失败（tix 的 `WmDefault.py`，`TabError`），所以只有这一项受影响。按代码推断，macOS 与 Linux 的路径没有反斜杠，不受影响。
  - 修复：转义后的路径和原样路径都替换为 `<staging>`，`auditError` 也按同样规则处理。字节码工程测试增加断言：记录含 `<staging>`，不含临时目录名。修复前这条断言在本机失败，修复后通过。
  - 回归：修复后用同一输入连续制作两次，归档、制作描述和 `.bytecode.json` 都逐字节一致。记录中不再有临时目录名和本机用户目录。归档与上表首次制作的产物一致。

### 第 2 层：CLI 测试（2026-11-02，首次）

- 首次运行因 `@zcode/contracts` 未构建而无法加载；构建 `@zcode/bootstrap...` 后重跑。
- adapters：43 个用例，4 通过、1 失败、38 跳过；bootstrap：1 个用例跳过。跳过的都是 `skipIf(win32)`，因此 Windows 的预装 PATH 注入、入口查找与 Bash 快照没有 CLI 自动化覆盖，由桌面 E2E 与 PT-26 补充。
- 失败：`mcp-network.test.ts`“preserves an existing PATH…”用 `#!/bin/sh` 脚本冒充 node，Windows 上不可执行，代码按设计把运行中 Node 的目录加到 PATH 前。该用例与实现在本分支没有改动，属于既有失败，与预装无关。

> 以下关于 `.cmd` 的小节是改用 shim 之前的记录，保留原始结论。入口现状见“Windows 入口改用 shim”。

### PT-26 预先发现：`.cmd` 入口在非 ASCII 路径下失效（已修复，待 E2E 回归）

- 现象：入口所在路径或目标路径含中文时，`.cmd` 入口找不到目标。
- 对照：同一行内容以 UTF-8 写入时，在 cp936 与 cp65001 下都失败；以系统 ANSI（GBK）写入时都通过。Git Bash 的 sh 入口在同一路径下正常。
- 根因：`packages/desktop/src/preinstalled-tools/entries.ts` 以 UTF-8 写 `.cmd`，cmd.exe 按系统 ANSI 代码页解码批处理内容，`chcp` 不改变这一点。
- 影响：Windows 用户名或自定义数据目录含中文时，所有工具的运行检查报 `runtime`；PowerShell、cmd 与 MCP 经 `.cmd` 的调用失败。
- 处理：经用户确认，`.cmd` 改用 `%~dp0` 相对定位，文件内容只含 ASCII。实测纯 ASCII、含中文和空格、含 `%` 的目录下，目标、参数、环境和 file URL 都正确。

### 产品缺陷：`.cmd` 入口丢失目标的退出码（已修复，待 E2E 回归）

更正：本节之前把“cmd 返回退出码 0”记在中文路径问题下，实际与路径无关。

- 现象：目标为 `.exe` 且退出码为 7 时，从运行检查同款的 `cmd /d /s /c`、PowerShell、Git Bash 调用入口，得到的都是 0。只有 `call` 调用得到 7。纯 ASCII 路径同样如此。
- 对照：修改前的绝对路径写法和 `%~dp0` 写法结果相同，去掉 `setlocal` 也相同，所以不是 `%~dp0` 修改引入的。
- 影响：真实资源的目标是 `.exe`。规格要求运行检查对非零退出报 `runtime`，但修复前只能靠输出匹配发现失败；Agent 和插件也会把工具失败看成成功。
- 处理：经用户确认，结尾改为 `& call exit /b %%errorlevel%%`。实测 cmd、PowerShell 得到 7，成功时得到 0。
- 夹具盲区：小包夹具的目标是 `.cmd`，能正确返回退出码，所以小包候选发现不了此问题，必须用真实资源或 `.exe` 目标验证。

### PT-26 部分结果：运行中删除 `.cmd`（失败；用户确认保留 `.cmd`，记为已知限制）

- 现象：目标运行期间删除 `.cmd`，目标正常跑完（输出 `SLEEP_DONE`），但 cmd 随后报“找不到批处理文件”，调用方得到退出码 1，而不是目标的 5。
- 对照：修改前的 `& exit /b` 同样得到 1，另外 4 种单行结尾也都是 1，且其中多种丢失正常的退出码。只有 `& call exit /b %%errorlevel%%` 能保留退出码，所以当前保留这一写法。
- 规格原有“单行写法不会因 cmd 回读文件而出错”的前提不成立，已更正。
- 用户确认不改用 shim 可执行文件，保留 `.cmd`，规格“已知风险”记为已知限制。

### 产品缺陷：运行检查把 `cmd /c` 命令行中的 `%` 写成 `%%`（已修复，待 E2E 回归）

`installation.ts` 的运行检查用 `quotePreinstalledCmdValue` 拼 `cmd /c` 命令行。命令行不是批处理，`%%` 不折叠。目录名含 `%` 时实测找不到入口（exit 1），不转义则正常。已去掉转义。遗留：命令行中形如 `%NAME%` 且变量存在的片段仍会被 cmd 展开。

### 第 3 层：tracer 候选（2026-11-02，首次，失败）

- 证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20261102071028512-p2080-1a3f46fe0020b9df`，1 failing，1 分 13.5 秒。
- 失败前已走到：两个工具按队列准备就绪，截图 `lop-tracer-preparing`、`lop-tracer-checking`、`lop-tracer-ready` 已生成。
- 失败点：UI 删除 qpdf 后状态未到 `not-installed`。预装进程日志为 `工具删除未完成 {"toolId":"qpdf","error":"Error: 进程占用检查未完成"}`。日志没有记录 `cause`，所以这次运行中的直接原因由下面的独立复现推断。

### 第 3 层：tracer 候选第二批（2026-11-02，产品修复后，失败）

- 证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20261102073815138-p21932-e880376966aa6681`，1 failing，40.9 秒。
- 失败点：比首批更早，停在第一次重启 App。`e2e-electron-reload.ts` 报 `Electron reload 旧进程树未包含 main pid: pid=13096`，还没到删除步骤。日志显示 pid 13096 当时存活，首批同一步通过。
- 原因未确认。曾怀疑测试进程祖先链上的旧父 pid 被复用，导致 main 被排除，但现存祖先链中没有 13096，已退出的中间进程无法核对。

### 第 3 层：tracer 候选第三批（2026-11-02，通过，非首次）

- 证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20261102074427870-p11380-2194965204b69fa3`，1 passing，1 分 32.9 秒。同一份代码、未改测试，第二批的重启报错未复现。
- 覆盖：删除、重启复用、记录被移除后重新下载、杀预装进程后恢复、活动项取消后队列继续、经 `.cmd` 入口调用。本候选的入口目标是 `.cmd`，不能证明 `.exe` 目标的退出码。

### 产品缺陷：Windows 占用探针在本机恒判“无法确认”（已修复，E2E 删除链路通过）

修复（用户确认方案 B）：去掉逐进程查所有者；读不到路径的进程比对进程名，与版本目录内文件同名才算占用。实测单次约 0.7 秒；空闲目录通过，含 `CTFMON.EXE` 文件的目录、有运行中程序的目录都拒绝，程序退出后通过。下面是修复前的记录。

`packages/desktop/src/preinstalled-tools/removal.ts` 的 `windowsProcesses()` 原样单独运行 4 次，结果如下。两个原因相互独立，只解决一个仍会失败：

1. 超时：每次 15～18 秒，超过 `PROCESS_PROBE_TIMEOUT_MS` 的 10 秒。`Get-CimInstance` 只用约 260 毫秒，约 16 秒花在对 175 个无路径进程逐个调用 `GetOwnerSid`。
2. 无路径的本用户进程：有 6 个（例如 `ctfmon`、`TabTip`、`ChsIME`、`taskhostw`、`DefenderSessionHelper`），未提权时读不到路径，全部 `unknown=true`，代码因此抛“无法确认本用户进程的程序路径”。

影响：本机上每次占用检查都失败，因此工具无法删除（卡片提示正在被 Agent 使用），启动清理也回收不了旧版本。其他 Windows 机器未测；上述进程中有系统自带组件，预计普遍存在。

### 产品缺陷：Git Bash 中 `<bin>` 不在 PATH 最前，`pdftotext` 被抢先（已修复，agent-switch、startup、env 通过）

- E2E 证据：`agent-switch` 第一批（`desktop-e2e-20261102085442336-p13948-952f921508db7c47`）在 `pathFirst` 断言失败。期望 `<bin>`，实际是 `<数据根>\bin`。
- 根因：`shell-init-snapshot.ts` 在 Git Bash 下用 `bash -lc` 的输出作为快照 PATH。Git Bash 登录 profile 把 `~/bin`、`/ucrt64/bin`、`/usr/bin` 等放到前面，实测 `<bin>` 排第 9 项。这证实了规格“已知风险”中的推断。
- 影响：按同样方式解析，`pdftotext` 落到 Git 自带的 `/ucrt64/bin/pdftotext`（Xpdf 4.06，不是 Poppler）。`qpdf`、`pandoc`、`pdftoppm`、`pdfimages`、`pdfinfo` 和两个专用入口仍落到 `<bin>`，但用户 `~/bin` 中的同名程序同样会抢先。
- 这项解析是脚本复现，还没有用真实 Poppler 资源跑。

### 产品缺陷：运行检查取消或超时后，目标进程残留并占用版本目录（已修复，controls 通过）

修复（用户确认）：Windows 上取消和超时都用 `taskkill /T /F` 结束进程树，等 stdio 关闭后返回。实测进程树结束后句柄释放有不到 100 毫秒延迟，立即删除报 `EPERM`，所以目录清理用 `rm` 自带的重试。脚本验证：取消和超时后目标已退出、目录可删，正常输出和退出码 7 保留。遗留：输出超过 1 MB 时仍只结束 `cmd.exe`。下面是修复前的记录。

- E2E 证据：`controls` 第一批（`desktop-e2e-20261102091527629-p1936-267b98ebd2220a9d`）。运行检查中点取消后，`rm` 版本目录报 `EBUSY`，状态为 `failed`，到不了 `not-installed`。
- 对照实验（与 `installation.ts` 相同的 `cmd /d /s /c` 调用，目标为真实 `.exe`，确认目标启动后再触发）：取消和超时后调用都按时返回，但目标进程仍存活，删除版本目录都报 `EBUSY`。
- 根因：Windows 上 `execFile` 的 `signal` 和 `timeout` 只结束 `cmd.exe`，不结束它启动的目标。
- 影响：取消卡片显示失败，版本目录残留；卡死的工具超时后继续占用资源。

### 第 3 层：其余小包候选（2026-11-02）

证据都在 `packages/desktop/.e2e-artifacts/` 下。一次跑一个，通过批次之前的失败都保留。

| 候选           | 结果                                                                  | 通过批次证据                                                           | 此前失败                                                                          |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| upgrade        | 第 3 批通过                                                           | `desktop-e2e-20261102084815547-p25176-c0def20ca74089a3`                | 125% 缩放下内容区差 2 像素（辅助函数容差）；占用夹具缺 `.exe`（适配脚本编码错误） |
| agent-switch   | 第 2 批通过                                                           | `desktop-e2e-20261102090559572-p3920-9253fa7f3080ff76`                 | Git Bash PATH 缺陷                                                                |
| startup        | 第 2 批通过                                                           | `desktop-e2e-20261102091044625-p20644-a48e1480b3f6972a`                | Git Bash PATH 缺陷                                                                |
| controls       | 第 2 批通过                                                           | `desktop-e2e-20261102093117147-p22684-bc95ba05c74c1b54`                | 运行检查取消后目标残留                                                            |
| faults         | 第 1 批通过（运行期间改过产品代码）；最终代码回归见下文               | `desktop-e2e-20261102092242040-p20904-4adf1af46f4bff88`                | 无                                                                                |
| delete         | 第 2 批通过                                                           | `desktop-e2e-20261102094012179-p16528-ddc716fcdab0f3ce`                | 用例目录名含 `:`；`chmod 000` 段只在 POSIX 执行                                   |
| env            | 第 1 批通过                                                           | `desktop-e2e-20261102094513785-p13164-5a84e990eff547ef`                | 无                                                                                |
| clear-data     | 第 1 批通过                                                           | `desktop-e2e-20261102094935794-p9044-d08aa5cba3c6a45d`                 | 无                                                                                |
| empty-catalog  | 第 2 次运行通过（第 1 次被系统因内存紧张停止，无结论）                | `desktop-e2e-20261102095612242-p19828-270dd1749278bbeb`                | 无                                                                                |
| remote-context | 环境阻塞：缺少 `ZCODE_E2E_SSH_HOST`，用例未进入实际步骤。未验证 PT-19 | 无（运行记录 `desktop-e2e-20261102100718027-p16264-55f4f83f649267a4`） | 无                                                                                |

tracer 的结果见上文。小包候选的入口目标是 `.cmd`，不能证明 `.exe` 目标的行为。

最终代码回归（Git Bash PATH、进程树、目录删除重试修复之后）：

- tracer：通过，`desktop-e2e-20261102101102321-p5868-b67ef1cded722829`。
- upgrade：通过，`desktop-e2e-20261102101519393-p23876-6922a17cec2106e1`。
- faults：用例通过（`test-results.ndjson` 为 passed，4 分 21 秒），但运行器退出码 1。原因是用例结束后报告汇总在 `e2e-reporting-summary.ts:571` 汇总性能采样时抛出 `Cannot read properties of undefined (reading 'reduce')`，与预装无关，未修。证据 `desktop-e2e-20261102104051246-p1864-60cd1736d1ff6754`。
- 一次回归批次因系统内存紧张被执行环境停止，无结论，之后重跑。

### Windows 入口改用 shim（2026-11-02～03）

经用户确认，Windows 入口从“sh 脚本 + `.cmd`”改为 shim 可执行文件 `<name>.exe` 加配置 `<name>.shim`。原因与设计见 [Windows 入口 shim](../../preinstalled-tools/windows-entry-shim.md)。上文关于 `.cmd` 的结论只对旧入口成立。

工具链：Visual Studio 2022 Build Tools，MSVC 19.44，Windows SDK 10.0.26100，CMake 随 VS 安装。本机只构建 x64，arm64 未构建、未验证。

**工程测试**（`packages/desktop/test/preinstalledEntryShim.test.ts`，15 项，首次全部通过）：参数含空格、中文、`%`、`^`、`&`、`"`、空字符串和结尾反斜杠时原样到达目标；配置中的固定参数与环境（set、default、unset）；退出码 0、5 与 `0xC0000005`；配置缺失、格式错误、未知字段、版本不支持、目标不存在时退出码 127 并写明原因；结束 shim 时目标及其后代一起结束，版本目录可以删除；目标正常结束时保留其后台后代；运行中撤下入口时新调用找不到入口，运行中的调用返回目标退出码；运行中替换配置和 shim；目标为 `.cmd`；重复构建字节一致。

**PT-26 调用矩阵**（证据 `.scratch/win-verify/pt26-shim-matrix-run{1,2}.json`，未入库）：

| 调用方                              | 结果                                          |
| ----------------------------------- | --------------------------------------------- |
| Node `execFile` 按名字调用          | 8 个参数一致                                  |
| Python `subprocess.run` 列表参数    | 8 个参数一致                                  |
| Python `shutil.which`               | 找到 `zcode-probe.EXE`                        |
| cross-spawn（MCP stdio 的启动方式） | 8 个参数一致                                  |
| Git Bash                            | 8 个参数一致；`command -v` 找到入口；退出码 7 |
| cmd                                 | 8 个参数一致；退出码 7                        |
| PowerShell                          | 8 个参数一致；退出码 7                        |

入口目录路径含中文、空格和 `%`。第一批有两项不符，都是探针自身问题：Python 按 GBK 打印结果、探针按 UTF-8 解码（加 `-X utf8` 后一致）；cmd 的 `%errorlevel%` 在命令执行前展开（改用延迟展开后为 7）。pdf2image 经预装 Poppler 渲染要用真实资源，留给第 4 层。

**第 3 层回归**（worktree 分支 `feat/preinstalled-tools-windows-shim`）：

| 候选                                                                       | 结果                      | 证据                                                    |
| -------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| tracer                                                                     | 第 3 批通过               | `desktop-e2e-20261102161335058-p15512-726dfd98d6f49157` |
| upgrade、startup、controls、faults、delete、env、clear-data、empty-catalog | 各自第 1 批通过           | 见 `.scratch/win-verify/shim-layer3-summary.txt`        |
| agent-switch                                                               | 第 2 批通过               | `desktop-e2e-20261102170807937-p21980-909369d2570a3da8` |
| release-isolation                                                          | 跳过：用例只在 macOS 运行 | `desktop-e2e-20261102170328448-p15388-3a844cbbe10b75a1` |

此前失败：

- tracer 第 1 批（`desktop-e2e-20261102155314571-p10412-da020f5e7bd6d043`）：预装进程报“缺少 Windows 入口 shim”。根因是 Main 只按 `import.meta.dirname` 推算 shim 路径，桌面 E2E 从 `.e2e-cache/<run>/app` 运行 Main 时找不到。已按 Agent 二进制的做法增加 `process.cwd()` 候选。缺 shim 时拒绝写入口、不退回 `.cmd`，符合规格。
- tracer 第 2 批（`desktop-e2e-20261102160537496-p21132-d4d0388d42694a37`）：qpdf 通过；libreoffice 运行检查报 `spawn …\check-XXXXXX\zcode-soffice.exe ENOENT`。该路径正好 260 个字符，超过 `MAX_PATH`；qpdf 同类路径 244 个字符。原因是 worktree 路径加上带 runId 的 E2E 数据目录。把 `ZCODE_E2E_HOME_DIR` 指向用户目录下的短路径后通过。属于环境问题，产品未改。
- agent-switch 第 1 批（`desktop-e2e-20261102162635798-p24068-0d8a561fc6220916`）：夹具断言期望 `bin\qpdf`，实际 `bin\qpdf.exe`。已改为按入口路径辅助函数比较。

**rebase 后回归**（2026-11-03）：origin 新增 4 个提交后，把本地 2 个提交 rebase 到 `ba579a05ee` 上。只有 README“运行检查”一条有文本冲突，保留 shim 的主句，再加上 origin 新增的两个子项。之后：

- 根目录类型检查通过；shim 与 fault-server 工程测试 23 项通过，2 项按平台跳过；格式、lint、插件一致性通过。
- tracer：origin 改了 catalog 下载地址的拼法，因此重跑。rebase 后第 1 批（总第 4 批）通过，`desktop-e2e-20261103013921724-p20744-a437919f2d69339e`。
- proxy：origin 新增的候选，Windows 上首次运行即通过，`desktop-e2e-20261103014344842-p18852-f391901e908bd4bd`。
- 其余候选没有在新基线上重跑。上表中它们的结果来自 rebase 前的基线。

已知风险（用户确认保留，本期不处理；规格见 [Windows 入口 shim](../../preinstalled-tools/windows-entry-shim.md#运行检查)）：运行检查入口位于 `<数据根>\.zcode\preinstalled-tools\<发布身份>\tools\<工具>\staging\<uuid>\check-XXXXXX\<入口>.exe`，默认数据根下约 130 个字符。自定义数据目录很深时会超过 `MAX_PATH`，运行检查报 `runtime`。旧 `.cmd` 入口是否同样受限没有实测。

未验证：arm64 shim；Ctrl+C 转发（需要交互式控制台）；App 签名后的 shim（本机无签名环境）；真实资源经 shim 运行（第 4 层）。

**评审修正：目标在创建时入作业**（2026-11-03）：原先目标挂起创建，再放进作业，再恢复运行。shim 在创建与入作业之间被结束时，目标停在挂起状态、不在作业内，会一直占用版本目录。改为用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时直接入作业，并新增工程测试“shim 刚启动目标就被结束时，目标不残留，版本目录可以删除”。只在 macOS 上用 zig 交叉编译了 x64 和 arm64（`-Wall -Wextra -Werror`），没有在 Windows 上运行。上面的 shim 工程测试与第 3 层结果来自修改前的 shim，需要在 Windows x64 上重跑。

**作业修正后的 Windows x64 回归**（2026-11-03，基线 `babf1736ce`）：

- 在 Windows 上用 MSVC 重新构建 x64 shim。导入表中不再有 `AssignProcessToJobObject` 和 `ResumeThread`，有 `InitializeProcThreadAttributeList` 和 `UpdateProcThreadAttribute`。
- shim 工程测试 16 项全部通过，包括新增的“shim 刚启动目标就被结束时，目标不残留，版本目录可以删除”。
- 第 3 层，一次一个：

| 候选          | 结果                                                   | 证据                                                    |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| tracer        | 第 1 批通过                                            | `desktop-e2e-20261103063516360-p23720-2e9ddd9003829140` |
| proxy         | 第 1 批通过                                            | `desktop-e2e-20261103064220345-p22260-03d88d75261d8487` |
| upgrade       | 第 1 批通过                                            | `desktop-e2e-20261103064653420-p24100-b18495ce1dfa9930` |
| agent-switch  | 第 1 批通过                                            | `desktop-e2e-20261103065329233-p18908-c8cd8aa0e03e32cd` |
| startup       | 第 2 次运行通过（第 1 次因系统内存紧张被停止，无结论） | `desktop-e2e-20261103071046833-p11076-39db565e57f74173` |
| controls      | 关闭智能应用控制后第 1 次通过                          | `desktop-e2e-20261103085427194-p6452-e7b20f651bd54328`  |
| faults        | 关闭智能应用控制后第 1 次通过                          | `desktop-e2e-20261103090148919-p12712-97cd4af2b261afe3` |
| delete        | 关闭智能应用控制后第 1 次通过                          | `desktop-e2e-20261103091012372-p22268-843bf20d19f75df6` |
| env           | 关闭智能应用控制后第 1 次通过                          | `desktop-e2e-20261103091530348-p20792-1eb002235fdf93b1` |
| clear-data    | 关闭智能应用控制后第 1 次通过                          | `desktop-e2e-20261103092000744-p25252-2e31ebaf3645f3fd` |
| empty-catalog | 关闭智能应用控制后第 1 次通过                          | `desktop-e2e-20261103092359696-p13056-c103ade9e27f4dd8` |

- rewrite 只在 macOS 运行；python-resource 使用真实资源，归第 4 层。两者不在本层范围。
- 第 3 层 11 个候选在新 shim 上全部通过，均为首次运行即通过，没有靠重试。

### 第 4 层：real-loopback（2026-11-03，第 10 次通过）

Mac 交付的 `libreoffice-26.8.1-win32-x64-r2` 先在本机核对：归档字节数与 SHA-256 与描述一致；描述通过 schema 校验，与配方逐项一致；归档只含普通文件和目录；27 个必需文件、10 个 VC++ DLL 都在；主程序与主要 DLL 带 The Document Foundation 的有效签名。

候选夹具从 `.cmd` 入口改为 shim 入口。真实资源运行中逐次发现并修正的夹具问题：

- 两条断言在 Windows 上恒为真：比较的是不带扩展名的入口路径，Windows 上没有这个文件。改为比较 `<name>.exe`。
- 探针用 Git 的包装器 `bin\bash.exe` 解析命令名；它把 `/ucrt64/bin` 放回 PATH 最前，Git 自带的 `pdftotext` 被优先找到。改用不改写 PATH 的 `usr\bin\bash.exe`。
- 预装 Python 未设 `PYTHONUTF8`，夹具读写交换文件时用代码页 936，数据根含中文时报 `UnicodeDecodeError`。改为显式 UTF-8。
- 夹具的子进程审计在 Windows 上恒找不到 pdftoppm：Windows 的 `subprocess` 在审计前已把 argv 拼成命令行字符串，且 `executable` 为 `None`；原写法把字符串拆成单个字符。改为取命令行首个参数作为程序名。

| 次  | 失败点                                        | 原因                            | 证据                                                    |
| --- | --------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| 1   | Pandoc 运行检查超时（10.04 秒）               | 未确认，见下文                  | `desktop-e2e-20261103092915565-p24280-63409162783ad282` |
| 2   | `pdftotext` 未解析到预装入口                  | 夹具：包装器 bash               | `desktop-e2e-20261103094404924-p24312-4feb0a0f8f7be72f` |
| 3   | Word 转 PDF 返回 0、无输出、无 PDF            | soffice.bin 崩溃，见下文        | `desktop-e2e-20261103100520071-p11424-7d7db6aed860fbaa` |
| 4   | pdftoppm 断言找不到记录                       | 夹具：子进程审计                | `desktop-e2e-20261103104216324-p15372-fb65cb7f3074bd91` |
| 5   | PPT 转 PDF 返回 0、无输出、无 PDF             | soffice.bin 崩溃，与第 3 次相同 | `desktop-e2e-20261103105817471-p14044-2d7589e0dd4bd3de` |
| 6   | 同第 5 次；本次开启本机崩溃转储，留下完整转储 | soffice.bin 崩溃，与第 3 次相同 | `desktop-e2e-20261103113747208-p6148-b1e8f40331689a8b`  |
| 7   | Python 解包超过 180 秒，未到达 ready          | Defender 扫描，见下文           | `desktop-e2e-20261103152744985-p16068-eff11cf62566bcf3` |
| 8   | Pandoc 运行检查超时（10.04 秒）               | Defender 扫描，见下文           | `desktop-e2e-20261103154028706-p10176-7574467ef8afcb47` |
| 9   | App 启动时读 `DevToolsActivePort` 报 `EBUSY`  | E2E 框架，见下文                | `desktop-e2e-20261103160437337-p24248-4984ca7c9f3570fa` |
| 10  | 通过（用例 14 分 11 秒）                      | —                               | `desktop-e2e-20261103161119504-p1836-27d72667f75bb932`  |

第 10 次使用 LibreOffice `-r3` 与 Pandoc 60 秒上限的描述：5 个工具装好并发布；Pandoc 运行检查约 10.7 秒，按原 10 秒上限会失败；Word 与 PPT 并行转换都产出 PDF，系统应用日志中没有 `soffice.bin` 崩溃，崩溃转储目录没有新转储。

第 7 次起使用 Mac 交付的 `-r3`。本机核对：归档字节数与 SHA-256 与描述一致；描述通过 schema 校验，与配方逐项一致；与 `-r2` 的描述只差 resourceId、归档字节数和 SHA-256；归档条目与 `-r2` 相比只多 11 个空目录，正是 MSI CreateFolder 的 11 项，其余条目的类型、大小和路径都相同；归档内的身份与来源文件与描述一致。第 7、8 次都在 LibreOffice 安装前失败，失败原因与 `-r3` 无关。

第 6 次之前的步骤都通过：5 个工具装好并发布，16 个入口解析到预装入口，Office 转 PDF、旧 DOC 转换、工作簿重算正常。

**资源缺陷：MSI 空目录缺失，LibreOffice 并发首次启动崩溃**（配方已修复为 `-r3`）

- 现象：探针并行转换 Word 和 PPT。偶发其中一个返回 0，stdout 与 stderr 为空，不生成 PDF。同一时刻系统应用日志记录 `soffice.bin` 崩溃：`KERNELBASE.dll`，异常代码 `0x00000000`，偏移 `0xc408a`。
- 转储（LibreOffice 官方符号服务器的私有符号）：`Desktop::Main` → `SynchronizeExtensionRepositories` → `ExtensionManager::reinstallDeployedExtensions` 抛出未接住的 `WrappedTargetRuntimeException`：`[context="shared"] caught unexpected com.sun.star.ucb.NameClashException: folder exists and overwrite forbidden`，冲突名为 `uno_packages`；随后 `SalAbort`。`soffice.com` 仍返回 0。
- 根因：shared 扩展仓库缓存 `share/uno_packages/cache` 在安装目录内（`louno.ini` 的 `UNO_SHARED_PACKAGES_CACHE`），不在每次调用的私有配置目录内。官方 MSI 用 CreateFolder 表建出 `share/uno_packages/cache/uno_packages`；制作时的 `msiextract` 只提取文件，这些空目录丢失。新配置目录首次完整启动时，`cleanExtensionCache` 清空扩展缓存并重装扩展；两个进程同时创建缺失的目录，后创建的一方崩溃。这也是每次转换都先启动、退出再重启一次 `soffice.bin` 的原因。
- 复现（本机，同一份 r2 资源经 shim 与 helper 并行转换 Word 和 PPT）：

| 条件                              | 并行转换 | 崩溃 |
| --------------------------------- | -------- | ---- |
| E2E，全新安装                     | 8        | 3    |
| 目录已由 LibreOffice 先前运行建好 | 18       | 0    |
| 每轮删除 `share/uno_packages`     | 12       | 2    |
| 每轮恢复为 MSI 的空目录结构       | 16       | 0    |

本地两次崩溃的转储与 E2E 的调用栈、异常完全一致。恢复为 MSI 结构后，跑完目录仍为空，LibreOffice 不写安装目录。

- 修复：制作时按 MSI 的 CreateFolder、Directory、Component、File 表补齐应用目录内的空目录，见 [LibreOffice 资源规格](../../preinstalled-tools/libreoffice.md)。用 Windows Installer 只读导出的 x64 与 arm64 官方 MSI 表核对，两者都得到同样的 11 个目录（`share/autotext/` 下 8 个语言目录与 `share/uno_packages` 三层）。`win32-x64`、`win32-arm64` 配方升为 `-r3`。
- 未处理：helper 只按返回码判断成功，`soffice.bin` 因其他原因崩溃时同样会静默不产出。是否让 helper 核对转换输出，待产品决定。

**资源缺陷：Windows Defender 首次扫描超过 Pandoc 运行检查上限**（已修复，上限改为 60 秒）

- 现象：Pandoc 运行检查耗时只有两种，约 0.24 秒或 9.2～10.04 秒。8 次中 4 次慢，其中第 1、8 次超过 10 秒上限，报 `runtime`。此前在 E2E 之外按 6 种条件（直接调用、经 shim、Electron utilityProcess、E2E 的用户目录变量、大量写盘之后、产品解包方式）复现，都在 0.05～0.5 秒，没有复现。
- 证据（Defender 日志 `MPLog`，需管理员权限读取）：Defender 实时防护对 staging 中新解包的 `pandoc.exe`（约 240 MB）记录了 expensive scan。第 1 次 11328 毫秒，第 2 次 8593 毫秒，第 6 次 8609 毫秒。第 6 次检查 11:46:16 开始，扫描 11:46:25.42 结束，检查在同一秒结束（9.27 秒）。第 8 次的日志在取出时还没写入文件。
- 根因：首次执行新写入的大程序前，Defender 扫描完整个文件，进程才启动。10 秒上限没有为此留余量。用户机器默认开启 Defender，所以全新安装也会偶发失败，不只影响 E2E。
- 修复：Pandoc 运行检查上限改为 60 秒，与 Poppler 相同，见 [Pandoc 资源规格](../../preinstalled-tools/pandoc.md)。只改 `runtimeChecks`，重新转换 win32-x64 的归档与原归档逐字节相同，不换 resourceId。
- 未确认：第 3～5 次为何没有扫描；扫描结果在目录改名后是否仍然有效，即入口首次调用是否还要再等。

**其他记录**

- 解包耗时：同一份 Defender 日志中，每次 E2E 的 Electron 进程写出约 43400 个文件，Defender 累计扫描 460～500 秒，估计影响 100%。耗时最长的单个文件是 LibreOffice 的 `mergedlo.dll` 和 Python 的 numpy/openblas DLL。Python 资源因此在 Windows 上解包约 2.4～2.7 分钟；第 7 次超过 E2E 每个工具 180 秒的等待上限。E2E 上限已放宽到 300 秒。用户首次安装同样要等这么久。2026-11-04 由 [15](15-python-resource-trim.md) 优化：删除测试目录、只编译 0 级字节码后，`-r2` 在本机解包约 1 分钟。
- 第 9 次：E2E 框架轮询 `DevToolsActivePort` 时只把 `ENOENT` 当作未就绪，Chromium 写文件期间读取得到 `EBUSY`，App 启动失败。已修复：`EBUSY` 也按未就绪继续轮询，启动器工程测试覆盖。
- 第 10 次用例耗时 14 分 11 秒，用例上限 15 分钟，余量不足 1 分钟。已把 real-loopback 的 WDIO 外层与用例内预算放宽到 25 分钟，其余预装候选仍为 15 分钟。放宽后第 11 次通过（用例 13 分 36 秒，`desktop-e2e-20261103234317299-p11948-ac49efac5c1caca7`）；该次未遇到 `EBUSY`，修复路径由工程测试覆盖。
- 每次转换的 stderr 都有 `Could not find platform independent libraries <prefix>`。它只出现在 soffice 转换调用的 stderr 中，来自 LibreOffice 自带的 Python，helper 原样转发；不是预装 Python 资源的问题。
- 签名：LibreOffice 与 Pandoc 的程序有签名；qpdf、Poppler、Python 资源中的程序没有签名。本机关闭智能应用控制之前，未签名的预装 `python.exe` 运行未被拦截；qpdf 与 Poppler 未在该状态下运行。用户开启智能应用控制时这些程序是否被拦截，未验证。

### win32 r3 资源产出（2026-11-03，macOS）

在 macOS arm64 上制作，msitools 0.106_1，gcab 1.6。x64 用提交 `a6341e4ed06` 制作；arm64 用提交 `87b73711a3e` 的配方制作，即 `a6341e4ed06` 加上下文所述的 arm64 配方审核。

| 资源                                | 字节数    | SHA-256                                                            | 补齐目录 |
| ----------------------------------- | --------- | ------------------------------------------------------------------ | -------- |
| `libreoffice-26.8.1-win32-x64-r3`   | 554245658 | `aae7e65d6dde1f614b1ee19a74c151fccd935a01cd53e6e3db58e88853c87247` | 11       |
| `libreoffice-26.8.1-win32-arm64-r3` | 542378208 | `f4e94d8e2c4c7ae297ef2380a6ddce5c0b52243a72ef765b40b3ae8e00ae375c` | 11       |

- x64 在新目录中再制作一次，`.tar.gz` 与 `.artifact.json` 逐字节相同。arm64 未做重复制作。
- 两份的 `validation.runtime` 都是 `not-run`。x64 交 Windows 侧重跑第 4 层；arm64 本机不能运行，只做结构核对。

**arm64 配方首次按当前门禁审核**

- arm64 此前没有产出过：07 号票记录为“未开始下载或制作”，规格中“r2 已产出”的写法有误，已更正。配方只声明了帮助页示例路径，首次制作在 `Argon2OptDll.dll` 的 PDB 路径 `E:\build\workdir\…` 处被拒绝。
- 审核方法：用 `stageWindowsApplication` 真实暂存一次，按构建路径门禁与 PE 架构门禁的同一规则扫描全部文件，一次列出所有违规项。用同一扫描核对 x64：结果与 x64 配方的已有声明完全一致，扫描与门禁判断一致。
- 结果：268 个 PE 中，248 个文件含 3 个上游前缀 `E:/lo/libo-core`、`E:/build`、`D:/a/_work/1/s`（后者是内嵌 CAB 中 9 个 arm64 CRT 的 PDB 路径），全部与已验签 MSI 逐字节相同。架构不匹配的 PE 有 10 个，都是 pip/distlib 与 setuptools 的 x86/x64 启动器模板，入口不可达。
- 与 x64 的差异：arm64 MSI 不含 CLI-UNO .NET 程序集、`spsupp_x86.dll`、`twain32shim.exe`，因此没有小写 `e:/build` 前缀，也没有这些架构例外。arm64 原生模板（`t64-arm.exe`、`w64-arm.exe`、`cli-arm64.exe`、`gui-arm64.exe`）架构匹配，不声明。
- 配方补上述 3 条前缀与 10 条精确例外后，制作通过全部门禁。
- 下载：转换器单个文件下载上限为 10 分钟，arm64 MSI（约 344 MiB）在本机网速下超时。改用 `curl` 下载，按配方核对 SHA-256 后放入输入目录；转换器使用前再次核对大小、摘要与 GPG 签名。上限是否需要调整，未决定。

**Windows 侧核对 arm64 `-r3`**（2026-11-04，Windows x64，只做结构核对，不运行）

- 归档字节数 542378208 与 SHA-256 `f4e94d8e…ae375c` 与描述一致；描述通过 schema 校验；MSI、签名与指纹、字体、源码包、10 条架构例外与仓库 arm64 配方逐项一致；文件没有 Mark of the Web。
- 归档 20931 个条目，只含普通文件和目录，没有绝对路径或 `..`；11 个 CreateFolder 目录都在且为空；26 个必需文件和 10 条架构例外的文件都在；文件总字节与 `installedSizeBytes` 相同；内嵌的身份与来源文件与描述一致。
- 解出 `soffice.com`、`soffice.bin`、`soffice.exe`、`sal3.dll`、`mergedlo.dll`、`vcruntime140.dll`、`python.exe`：PE 架构都是 ARM64；签名都有效，前 6 个为 The Document Foundation，`vcruntime140.dll` 为 Microsoft。
- 未验证：arm64 真机运行。

### 推送前检查：Python 字节码工程测试依赖本机 Python 环境（2026-11-03）

首次推送 shim 分支时，pre-push 按 `merge-base(origin/staging, HEAD)` 选测，选中了 `scripts/preinstalled-tools/python/bytecode.test.ts`。本分支没有改这个测试及其依赖的代码。它在本机失败两次，原因都在环境：

- PATH 上的 `python` 是应用商店的占位程序，测试报“Python was not found”。把真实 Python 3.12 放到 PATH 最前面后，这一步通过。
- 用例要求 Python 的 traceback 含带中文的安装路径（`新的 安装路径`），实际 stderr 中这段路径是乱码。Python 向管道写 stderr 时使用系统代码页 936，测试按 UTF-8 读取。设 `PYTHONUTF8=1` 后通过。

结论：在中文 Windows 上运行这个测试，需要真实 Python 在 PATH 上，并设 `PYTHONUTF8=1`。是否让测试自己固定编码，尚未决定。

## Comments

### macOS x64 资源补齐（2026-11-05）

- 本轮目标：按当前通用资源合同补齐 Python、qpdf、Pandoc、Poppler、LibreOffice 的 macOS x64 归档与描述，供测试服务器后续发布使用。
- 沿用现有版本选择、最低 macOS 13.0 门禁、来源与签名核验、架构例外及路径改写规则。先制作和核对资源，不修改 App 内置 catalog。
- 起点：Pandoc 3.8.1 r1 已有归档，但描述仍为旧运行检查时限；Python 只有配方与 wheel 锁；qpdf、Poppler 只有输入锁；LibreOffice 现存 x64 r1 使用旧合同，需要以当前 r2 配方重新制作。
- 每个产物必须核对实际大小、SHA-256、当前 schema、目标架构和配方身份。新增完整 recipe 必须来自实际依赖闭包及来源审阅；不能只按文件扩展名或目录批量放行。
- 构建与验证记录分别标明宿主硬件、进程架构和是否使用 Rosetta。保持 Python 现有平台／架构匹配检查；当前机器上的构建或仿真运行证据不代替 Intel Mac 的原生安装与文档流程验收。
- 当前阶段：五个资源均已制作，保持未发布；Intel Mac 原生验收未完成。

| 工具        | macOS x64 资源                          | 归档字节数 | 本轮结果                                                                                                                                    |
| ----------- | --------------------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Python      | `python-3.12.16-20261026-darwin-x64-r2` |  120880454 | 当前 schema、结构、运行检查、16 个主要依赖导入通过；基础目录 9092 个文件与链接在运行后无增删改                                              |
| qpdf        | `qpdf-12.4.2-darwin-x64-r1`             |    4018112 | 重定位、版本检查、PDF 检查、AES-256 加密及解密通过                                                                                          |
| Pandoc      | `pandoc-3.8.1-darwin-x64-r1`            |   23349609 | 现行描述重新制作；中文 Markdown／Word 正文转换和读取通过                                                                                    |
| Poppler     | `poppler-26.10.0-darwin-x64-r1`         |   33280521 | 运行检查、中文 CMap 文字提取及渲染通过；改回普通 `binary` 后文字为空的负对照成立                                                            |
| LibreOffice | `libreoffice-26.8.1-darwin-x64-r2`      |  340209618 | 官方 GPG 与应用签名、218 个 Mach-O、10 个非运行模板通过；统一插件入口的并行 Word／PPT 转 PDF、公式重算通过，来源均为 managed，公式缓存为 18 |

- 本轮运行证据均来自 arm64 主机上的 Rosetta x64 进程，不是 Intel Mac 原生验收。Python 制作使用同版本 x64 Node，通过原有匹配检查；未更改转换器的平台门禁。
- qpdf、Poppler 的完整 recipe 来自实际 x64 依赖闭包。上游构建前缀均与固定来源原文件逐字节核对；Poppler 补齐同版本、经原始包元数据校验的 HTTPS 源码和许可证输入。没有放宽通用路径、许可或架构门禁。
- Python 的首次制作被 Pillow 上游构建路径拦截；按实际 wheel 字节补齐源码／对象文件、文档示例和两处库默认目录的声明，并核对四个 pip 模板。加密、ARC4、本地 DTD 与 XSLT 在上游默认目录不存在时通过。LibreOffice 的首次制作被 pip 的非运行 PE 模板拦截；按已验签 DMG 逐文件补齐十个例外，原 `.app` 未修改。
- 五个资源均完成两次独立制作，实际归档 SHA-256、字节数及描述逐字节一致。上传目录按 `<toolId>/<resourceId>/` 整理归档、描述及通过当前 schema 的 catalog 条目，并附总清单和 SHA256SUMS。
- 2026-11-05，五个 macOS x64 归档及其描述已按现有目录结构上传到测试服务器。先在临时目录核对，再移入下载目录；移入后远端复算十个文件的 SHA-256，全部与本地一致。五个归档和五个描述的 HTTP 检查均为 200，描述字节及归档大小一致。已有 macOS arm64、Windows x64 资源保留，App 内置 catalog 未修改。
- 保留运行边界：LibreOffice 首次版本检查在 30 秒内未完成；重跑 7.58 秒通过，采样位于 dyld 加载依赖阶段，未据此放宽时限。直接使用空配置的转换失败；原应用对照成功，实际插件统一入口提供预置配置后转换与重算通过。不能用跳过统一入口的直接调用代表文档插件验收。
- 原始调用对照还改写了测试副本内 25 个 Python 缓存文件，导致其签名失效；该副本已隔离保存，归档没有改变。正式统一入口使用从归档重新解出的干净副本复验，转换和重算前后的应用签名均有效，不把对照副作用归因于资源制作。
- 检查：根 typecheck、lint（665 条既有 warning、0 error）、architecture（0 violation）和受影响工程测试 4 个文件／19 项通过。首次 typecheck 因工作区缺少 session-control 依赖链接失败，冻结锁文件的离线安装补齐链接后通过；未改锁文件。格式、当前改动的术语扫描与 diff 检查通过；开源提醒只有既有 coverage 文档和 package 脚本两项。
- 仍缺 Intel Mac，尤其 macOS 13 上的首次启动、安全提示、真实 App 安装和五工具插件全流程验收。其他平台、正式 catalog、CDN 发布与法务结论不在本轮完成范围。完整归档、描述、来源审阅、正反例和检查日志保存在本轮 `preinstalled-tools-macos-x64-20261105` 产物目录。

### 早期待确认项

- 2026-10-29，待确认：桌面端是否支持 Windows 10 arm64。若支持，需核对其 x64 仿真限制，并另行决定是否在资源清单中增加“最低系统版本”字段，以便在下载前拦截无法执行的资源。本期不增加该字段；运行检查失败统一按 `runtime` 报告，日志记录 `binaryArch` 与 `hostArch`。本项仅记录后续确认事项，尚未开展本票的真机验证。
