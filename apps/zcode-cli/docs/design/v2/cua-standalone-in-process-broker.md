# 独立 CLI 的 Computer Use：进程内 broker

状态：第一阶段（macOS、Windows；darwin / win SEA 单文件发布物可直接用；源码运行需显式指定 addon）。

## 背景

桌面端启动 CLI（`app-server --stdio`）时注入一组 CUA 凭据：broker socket 与 plugin authority。
CLI 把它们捕获进进程内快照，再定向注入官方 `node_repl`；`node_repl` 连已签名的
`ZCode Computer Use` Helper。用户在终端直接运行 `zcode` 时没有这组凭据，`node_repl`
不创建 CUA runtime，Computer Use 不可用。

外部 Helper 不能给独立 CLI 用（2026-11-13 实测）：

- SDK 懒启动用 `open` 拉起已装 Helper，Helper 启动门要求 launcher 是签名的 ZCode，直接拒绝启动；
- 即使 Helper 已在运行，peer 门要求连接进程及其责任进程都由允许的 Team 签名，无签名 node 被拒。

放宽这两道门会让同用户的任意进程借用 ZCode 已有的 TCC 授权，影响所有装了 ZCode 的用户，因此不放宽。
进程内方案也有同类风险，但范围不同，见「安全边界与已接受风险」。

## 方案

独立 CLI 在 `node_repl` 进程内运行 broker（与 Helper 同一份 `runHelper` 实现），自己连自己：

```
zcode（顶层 CLI，darwin 或 win32，未收到宿主凭据）
  │ 自签凭据组 { socket: "in-process", pluginAuthority: <随机> }
  ▼
bootstrap ── 与桌面一致：把凭据注入官方 node_repl 的 env
  ▼
zcode __zcode-plugin-host → node_repl-host
  │ socket == "in-process"
  ├─ 首次 CUA 调用：startInProcessComputerUseBroker（本进程，随机 socket）
  └─ createComputerUseRuntime ── unix socket / named pipe ──▶ 同进程 broker
macOS 的 TCC 主体：启动 zcode 的终端 App；Windows 没有 TCC
```

### 形态判定（唯一入口：CLI `main.ts`）

同时满足以下条件时，CLI 自签凭据组：

1. 顶层 CLI 进程：不是 protocol server（`app-server` / `agent-server` / 存储迁移），不是 `__zcode-plugin-host`；
2. `process.platform` 是 `darwin` 或 `win32`；
3. 入口清洗后没有捕获到宿主凭据。

protocol server 一律不自签：桌面、SSH/WSL/Docker 远程都走 protocol server，远程机器上的 CLI
不得因为缺少凭据就去控制远程桌面。凭据只存在进程内快照里，不写回任何子进程 env；
`node_repl` 拿到的方式与桌面形态相同（bootstrap 定向注入 → plugin-host 校验后恢复）。

### 不新增环境变量

socket 字段使用哨兵值 `in-process`（CLI 侧常量 `ZCODE_CUA_IN_PROCESS_BROKER_SOCKET` 在 `@zcode/shared/runtime-env`；node_repl 侧常量 `IN_PROCESS_BROKER_SOCKET` 在 `@zcode/zcode-cua/broker/socketPath`，因 node_repl bundle 不得引入 shared 的 runtime-env，两处由测试钉成相等），复用已有的
`ZCODE_CUA_PERMISSION_BROKER_SOCKET`。下游的 authority 校验、官方 CUA server 判定、plugin-host
恢复逻辑都不需要改。

### 进程内 broker（`@zcode/zcode-cua/broker/server` 的 `startInProcessComputerUseBroker`）

- 首次 CUA 调用时才加载 native addon 并监听；之后复用。启动失败不缓存，下次调用重试。
- socket：`mintBrokerSocketPath()`。macOS 是用户私有 0700 目录内的随机名 unix socket；Windows 是随机名 named
  pipe（`\\.\pipe\zcode-cua-helper-<hex>`）。每个 `node_repl` 进程一份，互不冲突。
- 不安装 peer 校验，也没有 token 握手。这是已接受的风险，不是"没有风险"，见「安全边界与已接受风险」。
- 不加 socket 单例锁、不做空闲自退；生命周期跟随 `node_repl` 进程，`dispose` 时 stop。
- 不注册 `process.exit` / 信号处理：宿主进程的生命周期归 `node_repl` 管。
- 不开虚拟光标、PiP（第一阶段）。
- 使用用户级 controller lease（`createCuaControllerLease`）。第一次动作时获取，`node_repl` 进程退出时才释放。
  它挡住了哪些并发、没挡住哪些，见「并发控制」。

### 权限

macOS：缺辅助功能 / 屏幕录制权限时，授权对象是**终端 App**（Terminal、iTerm、Orca 等），不是 ZCode。
Windows：没有 TCC，不需要授权；但 zcode 以普通权限运行时，UIPI 不允许它向以管理员身份运行的程序发送输入或读取
其 UI 树。
`get_app_state` 默认 `include_screenshot=false`，没有图不代表缺屏幕录制权限。

## 安全边界与已接受风险

broker 监听一个本机 socket，连接后不校验对端身份，收到请求就以本进程的身份执行 AX 读取、截图和输入。

| 平台 | 能挡住谁 | 挡不住谁 | 后果 |
|---|---|---|---|
| macOS | 其他用户（runtime 目录 0700） | 同 uid 的任意进程。随机文件名挡不住它，`readdir` 就能列出 | 没有 TCC 授权的同 uid 进程（LaunchAgent、其他 App 的子进程、被植入的依赖）可以借用**终端 App** 的辅助功能和屏幕录制授权：截屏、读 UI 树、发送键鼠 |
| Windows | 依赖 named pipe 的默认 ACL（未单独核实对其他用户的效果） | 同用户的任意进程 | 同用户、同完整性级别的进程本来就能直接调用 UIA 和发送输入，不构成额外提权 |

暴露窗口：从第一次 CUA 调用到 `node_repl` 退出。没有用过 CUA 的会话不会监听。

为什么接受（第一阶段）：

- 需求是"同事拿到一个二进制就能用"，并明确接受 CLI 形态暂不做外部鉴权。
- 影响面只限于主动运行独立 CLI、并在 macOS 上给终端授过权的用户；不影响只用 ZCode 客户端的用户。桌面 Helper
  的签名门（背景一节）维持原样。

风险接受记录在本功能的 MR 描述中。以下任一条件成立时必须先补对端校验，再扩大使用范围：

- 独立 CLI 默认开启 computer-use，或面向外部用户发布；
- broker 的暴露窗口变长（例如常驻后台进程）。

可选的补法（未实现）：

1. 校验对端 pid 等于本进程 pid。调用方是同进程的 Worker bridge，native 已有 `getPeerCredentials`。
2. 要求连接先出示 `pluginAuthority` 等本进程私有的 token，否则拒绝分发。

## 并发控制

controller lease 是用户级文件锁。谁参与了它，谁才互斥：

| 组合 | 是否互斥 | 说明 |
|---|---|---|
| macOS：独立 CLI ↔ 桌面 Helper | 是 | 后来者收到 `CUA_CONTROLLER_BUSY` |
| macOS：两个独立 CLI | 是 | 同上 |
| Windows：独立 CLI ↔ 桌面 Helper | **否** | 桌面 Windows Helper（`runWindowsDevHelper`）不接 controller lease，两边可以同时发送键鼠，互相打断 |
| Windows：两个独立 CLI | 是 | 但见下面的接管问题 |

已知限制（第一阶段不修）：

- **持有时间长**：lease 到 `node_repl` 退出才释放。macOS 上，终端里的 zcode 用过一次 CUA 且没退出时，桌面端的
  CUA 会一直返回 `CUA_CONTROLLER_BUSY`。桌面端也接管不了：接管前要确认持有者是真的 Helper App
  （`helperPidEvidence`），进程内 broker 不满足，接管失败。用户需要退出终端里的 zcode。
- **Windows 上接管不校验身份**：`helperPidEvidence` 在非 darwin 平台直接认定持有者是 Helper，接管时会对持有者
  pid 发 `SIGTERM`；Windows 上又无法发现 pid 被复用。持有者已退出且 pid 被别的进程复用时，接管可能终止无关进程。
- 修复方向：动作结束或空闲一段时间后释放 lease；给 Windows 的身份校验加 fail-closed 分支；让桌面 Windows Helper
  接入 lease。

## 平台

- macOS、Windows：本阶段支持。Windows 桌面 Helper 本身就是 node 进程跑 `runHelper`，进程内 broker 与它是同一份实现，
  只是不经 fork、不经 Windows Helper 组合根（`runWindowsDevHelper`）。
- Linux：不自签，行为不变（CUA 不可用）。

## 发布物（SEA）

只有 darwin 与 win target（`darwin-arm64`、`darwin-x64`、`win-arm64`、`win-x64`）的 SEA 内置 `computer-use`
插件；linux target 不内置，行为不变。插件 seed 在源码插件文件之外多带两类运行时文件：

| seed 路径 | 来源 | 用途 |
|---|---|---|
| `native/ax_native.node` | darwin target 在 macOS 主机上按 target 隔离编译；其他情况取 `packages/zcode-cua/build/Release/ax_native.node` | 进程内 broker 的 AX / 截图 / 输入原语 |
| `node_modules/<sharp 运行时闭包>` | 与桌面同一份 `resolveSharpRuntimePackageNames(target)` | 截图编码 |

- macOS 主机构建 darwin target 时，`build-sea` 每次都把 `binding.gyp` 与 `src/native` 复制到该 target 的
  SEA 暂存目录，在那里运行 `node-gyp rebuild --arch=<arch>`，用产物打包。不读也不改
  `packages/zcode-cua/build`：桌面开发与 E2E 用的是那份主机架构 addon，`--all` 中途换架构会让它们失效；
  每次重编也保证打包的是当前源码，不依赖 `build/Release` 当时是哪个架构。编译失败时中止该 target。
- win target 仍取 `build/Release`（本阶段只自动编译 macOS；win addon 需要 MSVC，只能在 Windows 上编）。
  所以在 macOS 上不带平台参数的 `pnpm build:sea` 会在 win target 失败，报错提示用
  `--darwin --linux` 只打这两个平台；Windows 主机上照旧先 `node-gyp rebuild --arch=<arch>`。
- 构建期校验 addon 的架构必须与 target 一致（darwin 读 Mach-O，win 读 PE machine），不符时中止该 target，
  不产出缺 CUA 的二进制。
- `ci-cli-sea.mjs` 对 darwin / win target 先 `node-gyp rebuild --arch=<arch>` 重编 addon，再打 SEA。CI 的 macOS
  runner 是 arm64、Windows runner 是 x64，交叉架构都靠这一步（与桌面 `build:cua-helper`、`build:windows` 同一做法）。
  darwin target 在 `build-sea` 里还会隔离重编一次，CI 这一步对 darwin 是重复的，暂不改 CI。
- 开源占位 producer 没有 addon：检测到占位包时不内置 `computer-use`，也不编译。
- 运行时查找：node_repl 在首次 CUA 调用时检查 `$ZCODE_CUA_PLUGIN_ROOT/native/ax_native.node`，存在就交给
  broker。sharp 由插件根下的 `node_modules` 解析。
- 源码运行（`tsx main.ts`）时插件根没有 `native/`，addon 的默认查找从 `process.argv[1]`（CLI 入口）向上找
  `build/Release`，找不到 `packages/zcode-cua` 下的产物，首次 CUA 调用会报 `ax_native.node not found`。
  源码运行必须设置 `ZCODE_CUA_HELPER_ADDON=<repo>/packages/zcode-cua/build/Release/ax_native.node`（开发专用，
  已有变量，不是新增）。

### 同事拿到二进制后

macOS：

1. `xattr -d com.apple.quarantine ./zcode && chmod +x ./zcode`（SEA 只有 ad-hoc 签名）；
2. `./zcode login`；
3. 系统设置给运行 zcode 的终端 App 打开「辅助功能」「屏幕录制」，重启终端。

Windows：`.\zcode.exe login` 后直接使用；SmartScreen 拦截时选「仍要运行」。

## 待办

- 缺权限时的引导文案指向终端 App。
- 对端校验（「安全边界与已接受风险」）。
- lease 释放时机、Windows 接管身份校验、Windows 桌面 Helper 接入 lease（「并发控制」）。

## 验证

- `node-repl-host`：哨兵值走进程内 broker；真实 socket 走外部 Helper（原行为）。
- `shared`：自签只在无宿主凭据时生效，不覆盖宿主凭据。
- CLI：protocol server 与 plugin-host 不自签。
- SEA：darwin / win target 的 seed 含 `native/ax_native.node` 与 sharp；linux 不含 `computer-use`；addon 架构不符时构建失败。
- Windows：在真实 Windows 上用 node_repl MCP 的 `js` 工具调用 `list_apps` / `get_app_state` / 点击（预览 VM 访问不到模型接口，所以不经模型）。**尚未完成。**
- 端到端：终端运行 `zcode`（源码与 SEA 二进制各一次），让模型调 `list_apps` / `get_app_state`。
