# Windows 入口 shim

Status: accepted（用户已确认改用 shim；本文取代通用规格中 Windows `.cmd` 入口的写法）

## 为什么改

Windows 入口原来是一份 sh 脚本加一份 `.cmd`。13 号票在 Windows 11 x64 真机上发现 `.cmd` 有两类问题，修补 `.cmd` 写法解决不了：

| 问题                          | 实测                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不经 shell 的调用方找不到入口 | Python `subprocess.run(["pdftoppm", ...])`、pdf2image（会拼成 `pdftoppm.exe`）、Node `execFile` 都找不到只有 `.cmd` 的入口。PDF 插件经 pdf2image 渲染时用不到预装 Poppler（PP-03） |
| 运行中删除入口会误报失败      | 目标正常跑完后，cmd 回读已删除的批处理文件，报“找不到批处理文件”，调用方得到退出码 1                                                                                               |

此外，`.cmd` 还需要专门处理代码页（入口内容只能是 ASCII）、`%` 转义和退出码（`call exit /b %%errorlevel%%`），运行检查取消时还要另外结束进程树。改用 shim 之后，这些处理都不再需要。

## 方案

每个入口是一个 shim 可执行文件 `<name>.exe`，加一个同名配置 `<name>.shim`。shim 只做一件事：读取配置，按配置启动目标，等目标结束，返回目标的退出码。

```text
调用方（任意方式：Git Bash、cmd、PowerShell、Python 列表参数、Node execFile、cross-spawn）
  │  按 PATH 找到 <bin>\qpdf.exe（普通可执行文件，所有调用方都认得）
  ▼
shim 进程 qpdf.exe
  │  读 <bin>\qpdf.shim（UTF-8 JSON）→ 设置环境 → 拼命令行
  │  CreateProcessW(目标)，创建时直接加入 shim 创建的作业对象
  ▼
目标进程 versions\<resourceId>\…\qpdf.exe ── 退出码 ──► shim 以同一退出码退出
```

- 所有工具共用同一个 shim 程序，入口之间只有配置不同。
- 不保留 sh 入口和 `.cmd`。Git Bash 直接运行 `<name>.exe`。
- shim 是 App 自己的代码，随 App 发布，不是预装资源。通用规格中“本期不自己编译任何程序”指资源，不包括 shim。

## 配置文件 `<name>.shim`

UTF-8 编码的 JSON，由预装进程按安装记录中的入口定义生成：

```json
{
  "schemaVersion": 1,
  "target": "C:\\Users\\用户\\.zcode\\preinstalled-tools\\production\\tools\\qpdf\\versions\\r1\\Library\\bin\\qpdf.exe",
  "args": ["--install=C:\\…\\versions\\r1"],
  "env": [
    { "name": "FIXTURE_DEFAULT", "action": "default", "value": "x" },
    { "name": "FIXTURE_UNUSED", "action": "unset" }
  ]
}
```

- `target`、`args`、`env` 中的占位符在写入时展开为绝对路径。路径可以含中文、空格和 `%`。shim 全程使用宽字符 API，不受系统代码页影响。
- 配置与入口定义一一对应。不增加入口定义里没有的字段。

## shim 的行为

1. **定位配置**：用 `GetModuleFileNameW` 取自身完整路径，把扩展名换成 `.shim`。不按 PATH 查找，也不读当前目录。
2. **环境**：继承调用方的环境，再按 `env` 依次处理：`set` 覆盖，`default` 只在变量不存在时设置，`unset` 删除。
3. **命令行**：目标路径和 `args` 按 Windows 命令行规则（与 `CommandLineToArgvW` 互逆）加引号。调用方的参数取 `GetCommandLineW` 中第一个参数之后的原文，**原样追加**，不重新解析、不重新加引号。这样调用方怎么传，目标就怎么收到。
4. **启动**：`CreateProcessW`，用 `STARTF_USESTDHANDLES` 传入 shim 自己的标准输入、输出和错误句柄，当前目录不变，`bInheritHandles` 为真。目标用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时直接加入作业对象，目标和它启动的子进程从一开始就在作业内。
   - 不用“挂起创建 → `AssignProcessToJobObject` → 恢复运行”：shim 在创建与加入作业之间被结束时，目标停在挂起状态、不在作业内，没有进程会结束或恢复它，它会一直占用版本目录。
   - 这个属性要求 Windows 10 及以上；App 支持的 Windows 版本都满足。
5. **作业对象**：shim 先创建作业对象并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，再创建目标。调用方结束 shim（例如运行检查超时、取消，或任务管理器结束进程）时，无论 shim 运行到哪一步，作业关闭，目标及其后代一起结束。
   - 目标正常退出后，shim 先取消这项限制再退出，不结束目标有意留在后台的后代进程。
6. **Ctrl+C**：shim 注册控制台处理函数，对 Ctrl+C 和 Ctrl+Break 返回“已处理”，事件由同一控制台送到目标；shim 继续等待目标退出。不用 `SetConsoleCtrlHandler(NULL, TRUE)`，因为这个设置会被目标继承，目标就收不到中断。
7. **退出码**：用目标的退出码退出。配置缺失、格式不对或目标不存在时，向标准错误写一行原因，以固定退出码 `127` 退出。
8. **不做的事**：不经 shell，不解析或改写调用方参数，不写日志文件，不联网，不修改 PATH。
9. **目标类型**：真实资源的目标都是 `.exe`。目标是 `.cmd` 时，Windows 会经 cmd 启动它，参数按 cmd 规则解释；这只用于小包 E2E 夹具，不用于真实资源。

## bin 目录与入口维护

```text
<发布根>\bin\
├─ qpdf.exe            shim 程序副本（所有入口内容相同）
├─ qpdf.shim           该入口的配置
├─ zcode-python.exe / zcode-python.shim …
└─ .retired\           被撤下、暂时删不掉的 shim 副本
```

实测（Windows 11 x64）：运行中的 `.exe` 不能删除，也不能被 rename 覆盖；但可以改名移走，原名随即可以放入新文件。配置文件不被占用，运行中可以直接替换。据此规定：

| 操作                                  | 顺序                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 写入口                                | 先用“临时文件 + rename”写 `<name>.shim`，再放入 `<name>.exe`。`.exe` 出现时入口才可见，可见时配置一定已就绪                             |
| 只改配置（发布新版本、开关打开）      | `.exe` 已是当前 shim 时只替换 `.shim`，不动正在运行的 `.exe`                                                                            |
| 撤入口（开关关闭、删除工具）          | 先把 `<name>.exe` 改名到 `.retired\<name>-<随机>.exe`（立即不可见），再删除 `.shim`，最后尝试删除改名后的文件；删不掉就留给下次入口维护 |
| 替换 shim 程序（App 升级带来新 shim） | 与撤入口相同：旧 `.exe` 先改名移走，再放入新 `.exe`                                                                                     |
| 每次入口维护                          | 尝试清理 `.retired\` 中的文件；失败不标记 `entryOutOfSync`                                                                              |

- 撤入口的第一步是改名，改名后新的调用就找不到入口，与原规格“删除先撤入口”一致。正在运行的调用不受影响，目标照常跑完，退出码照常返回。
- “安装记录 + 开关”推导入口的规则、`entryOutOfSync` 的含义、写入失败不回滚记录等规则都不变。
- 初始化全量重建时，删除旧版留下的 `.cmd` 和无扩展名 sh 入口。预装功能还没有正式发布，这一条只影响开发和测试环境。
- 初始化清理无主文件时，无主的 `.exe` 也按“撤入口”处理：先改名到 `.retired\`，再尝试删除。`.retired\` 目录不算无主文件，只做尽力清理。仍在运行的旧入口不会让初始化失败。
- 没有 shim 程序（例如开发环境没有构建）时，Windows 上写入口失败，按入口写入失败处理（`entryOutOfSync`，日志写明缺少 shim）；运行检查同样失败。不退回 `.cmd`。

## 运行检查

- Windows 上直接启动检查目录中的 `<entry>.exe`，与 macOS 和 Linux 用同一套超时、取消和输出处理。不再经过 `cmd /d /s /c`，也不再需要 `windowsVerbatimArguments` 和 `taskkill`。
- 超时或取消时结束 shim，作业对象负责结束目标及其后代。macOS 和 Linux 没有 shim，改为结束检查所在的进程组。
- 检查目录中的入口同样按上面的布局写入。
- 已知限制（本期不处理）：检查入口的完整路径是 `<数据根>\.zcode\preinstalled-tools\<发布身份>\tools\<工具>\staging\<uuid>\check-XXXXXX\<entry>.exe`，在默认数据根下约 130 个字符。数据根很深时，这个路径会超过 `MAX_PATH`（含结尾空字符共 260 个字符），入口启动失败（实测报 `ENOENT`），运行检查报 `runtime`。

## shim 的来源、构建与签名

| 项目     | 规定                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码     | `packages/desktop/native/windows-preinstalled-entry-shim/`：一份 C 源文件和 `CMakeLists.txt`。只依赖 Windows API，静态链接 C 运行库                                                                |
| 构建     | `pnpm --filter @zcode/desktop prepare:preinstalled-entry-shim`。MSVC/CMake（Visual Studio 17 2022 生成器），与 native-search 编译 `ugrep.exe` 的方式相同。按 `ZCODE_TARGET_ARCH` 产出 x64 或 arm64 |
| 开发产物 | `packages/desktop/bundled-tools/win32-<arch>/preinstalled-entry-shim/zcode-preinstalled-entry-shim.exe`（已被 gitignore）。Windows 本地准备运行资源时自动构建                                      |
| 打包位置 | `resources/preinstalled-entry-shim/zcode-preinstalled-entry-shim.exe`。每个安装包只带自己架构的 shim                                                                                               |
| 签名     | 与浏览器导入辅助程序相同：electron-builder 钩子显式签名，并校验签名者与 App 主程序一致                                                                                                             |
| 传递     | Main 解析 shim 的绝对路径，经预装进程的 `initialize` 消息传入（字段 `windowsEntryShim`，只在 Windows 上有）。预装进程不自己推算路径                                                                |
| 替换判断 | 以 shim 文件的 SHA-256 判断 bin 中的 `.exe` 是否需要替换，不另设版本号                                                                                                                             |

## 受影响的其他部分

- 四个文档插件的统一入口 `zcode_libreoffice.py`：Windows 上不再查找 `zcode-soffice.cmd`，改为按 `PATHEXT` 查找 `zcode-soffice`；四份副本保持逐字节一致。
- 通用规格中的“入口文件”“已知风险”和 PT-26，以及 Agent 侧入口规格中关于 `.cmd` 的描述，按本文更新。
- 小包 E2E 夹具：入口目标仍可以是 `.cmd`，由 shim 启动；断言改为检查 `.exe` 与 `.shim`。

## 验收

### Windows E2E 准备

未打包的 Windows E2E 在进入 case 前必须准备预装入口 shim。父 runner 在启动任何 child
之前执行 `--ensure`；多个父 runner 共用按输出目录隔离的构建锁。源码、构建脚本、目标架构和
产物摘要均匹配时复用缓存；缺失、损坏或源码变化才重新构建。二进制和 `build.json` 分别通过
同目录临时文件加 rename 发布，manifest 最后发布；校验及复制也在同一把锁内完成。

分片 child（`ZCODE_E2E_SKIP_BUILD=1`）只执行 `--check`，不允许回退编译。每个 child 把已校验
的 shim 复制到自己的 `.e2e-cache/<runId>/bundled-tools/win32-<arch>/preinstalled-entry-shim/`。
Main 优先使用该运行目录中的副本，然后才回退到开发工作区路径。运行中的副本不被后续缓存
构建修改。直接启动且未指定复用的 WDIO，由其准备阶段持锁 ensure 并生成同样的独立副本；
显式复用构建的调用方也只校验，缓存未就绪时应先运行父 runner 或 `--ensure` 准备入口。

构建锁等待、vswhere、CMake configure 和 build 共用 5 分钟准备预算。超时终止编译进程树，
保留旧完整产物，不发布新 manifest，并释放锁。父 runner 和 WDIO 调用另设 6 分钟上限作为
清理余量。准备或校验失败立即终止，不让各 case 以 `failed/runtime` 或超时报告环境错误。
已打包 App 仍使用包内资源。

2026-11-17 回归：6 个工程测试文件共 77 项通过。构建测试在隔离目录使用平台检测和 CMake
夹具，实际执行子进程、文件发布、跨进程锁及超时清理；不等同于原生 MSVC 编译。
macOS Electron tracer 在 `packages/desktop/.e2e-artifacts/cr01-shim-tracer-20261117-b` 通过 1/1。
Windows 原生编译、`taskkill` 进程树清理与两个以上 shard 的实机验收尚未执行。

在 Windows x64 真机上（arm64 另找机器）：

| 场景                                                                                          | 必须观察到的结果                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 从 Git Bash、cmd、PowerShell、Python 列表参数、pdf2image、Node `execFile`、MCP stdio 调用入口 | 都能找到并运行预装版本                                   |
| 参数含空格、中文、`%`、`^`、`&`、`"`、空字符串                                                | 目标收到的参数与调用方传入的一致                         |
| 数据根含中文、空格、`%`                                                                       | 入口正常                                                 |
| 目标以非零码退出                                                                              | 调用方得到同一退出码                                     |
| 运行中关闭开关或删除工具                                                                      | 新调用找不到入口；运行中的调用正常跑完并返回目标的退出码 |
| 结束 shim（运行检查超时或取消）                                                               | 目标及其后代一起结束，版本目录可以删除                   |
| shim 刚启动目标就被结束                                                                       | 目标不残留，版本目录可以删除                             |
| 目标正常结束                                                                                  | 目标有意留在后台的后代进程不被结束                       |
| Ctrl+C                                                                                        | 目标收到中断，shim 等目标退出后再退出                    |
| App 升级带来新 shim                                                                           | 正在运行的旧 shim 不受影响；新调用使用新 shim            |

## 已确认的决定

1. 构建工具链用 MSVC/CMake，与 native-search 一致。
2. 本机开发安装 Visual Studio Build Tools（含 x64、ARM64 编译器和 CMake）构建 shim。
3. 目标正常结束时，保留它有意留在后台的后代进程。
4. Git Bash 不保留 sh 入口，统一走 `.exe`。
5. 运行检查入口超过 `MAX_PATH` 的问题记为已知限制，本期不处理，见“运行检查”。
