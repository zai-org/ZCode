# 桌面预装工具入口

关联规格：[预装工具](../../../../../docs/preinstalled-tools/README.md)。

2026-10-29：本文取代旧的 `ZCODE_PREINSTALLED_TOOLS_RECORD` 合同。该变量删除，Agent 不再读取安装记录。

## PATH 与环境变量

桌面 Local Host 启动本机 Agent 时做两件事：

1. 把固定入口目录 `<数据根>/.zcode/preinstalled-tools/<发布身份>/bin`（下称 `<bin>`）放在 Agent PATH 的最前面。Agent 靠 PATH 找到预装工具。
2. 注入 `ZCODE_PREINSTALLED_TOOLS_AVAILABLE=1`。

`ZCODE_PREINSTALLED_TOOLS_AVAILABLE` 的规则：

- **用途**：表示“这台电脑可以在 帮助 → 预装工具 中管理预装工具”。插件只用它判断工具都不可用时给哪种提示：有这个变量，提示查看“帮助 → 预装工具”；没有，保持原有的安装引导。查找程序不使用这个变量。
- **值**：固定为 `1`。插件只判断它是否非空。
- **何时注入**：本机桌面总是注入，与安装状态和当前平台是否有资源无关。`<bin>` 可以暂时不存在或为空。
- **优先级**：执行端 Host 给出的值优先。Agent 进程管理在 spawn 边界只采用 Host 的值，不继承用户 shell 或部署命令中的同名值；Host 不注入时，即使继承到同名值也清除。
- **不注入的环境**：远端 Host（SSH、WSL、Docker）、Web 服务端和独立 CLI 不注入这个变量，也不在 PATH 前加 `<bin>`。
- **错误行为**：变量不存在或为空时，插件按非受管环境处理，保持原有的安装引导。CLI 不解释这个变量，不调度安装；唯一例外是 Windows Git Bash 下恢复 `<bin>` 的最前位置，见“与 Bash 快照的关系”。

```text
桌面 Local Host ── spawn Agent ──► env.PATH = <bin> + 原 PATH，env.ZCODE_PREINSTALLED_TOOLS_AVAILABLE = 1
                                     │
Bash 快照：最后一行写 export PATH='<Agent 进程的 PATH>'，rc 文件对 PATH 的修改被覆盖
                                     │
每条 Bash 命令：新 shell → source 快照 → 按 PATH 查找程序 → 先找到 <bin> 中的入口
预装进程 ── 增删 <bin> 中的入口 ──► 下一条命令生效，不需要重启 Agent
```

## 与 Bash 快照的关系

- 除 Windows Git Bash 外，快照写入的 PATH 就是 Agent 进程收到的 PATH（`adapters/src/exec/shell-init-snapshot.ts`）。所以 `<bin>` 在每条 Bash 命令中都排在最前。
- 快照固定的是目录列表，不是目录中的文件。入口后来写入或删除，同一会话的下一条命令就能看到变化。
- Windows Git Bash 的快照 PATH 取自登录 shell 的输出。登录 profile 会把 `~/bin`、`/ucrt64/bin`、`/usr/bin` 等放到前面（实测 `<bin>` 排第 9 项），而 Git 自带 `/ucrt64/bin/pdftotext`，会抢先于预装入口。所以变量存在时，把 Agent PATH 的第一项（即 `<bin>`）移到快照 PATH 最前，其余顺序不变。不能直接用 Agent 进程的 PATH，否则 `C:\Windows\System32` 的 `find`、`sort` 会排到 `/usr/bin` 前面。
- 快照创建失败时，命令退回 `-c -l` 执行。这时 Git Bash 下在命令前加一行，同样把 `<bin>` 放到最前。其他 shell 的退回路径中，rc 文件仍可能改变顺序。

## 覆盖范围

| 执行路径 | 是否看到 `<bin>` 和变量 |
| --- | --- |
| Bash、后台 Bash | 是 |
| hooks | 是 |
| Agent 启动的 MCP stdio 服务 | 是，继承 Agent 环境；MCP 配置自行设置 PATH 时除外 |
| 上述进程启动的子进程 | 是 |
| App 终端面板、远端工作区、独立 CLI | 否 |

不改 App ↔ Agent 协议，不改系统提示词，不新增 Agent 工具。Bash 执行仍经过 ExecutionPort 和现有的权限链路。

## 验证

- CLI ExecutionPort：先建立 Bash 快照，再在 `<bin>` 中创建入口，下一条命令用 `command -v` 能找到它；删除入口后，下一条命令找到系统程序或找不到。快照建立后，`<bin>` 仍在 PATH 最前。
- CLI ExecutionPort：`ZCODE_PREINSTALLED_TOOLS_AVAILABLE` 在快照建立后的新命令中仍可读到。
- MCP：stdio 服务的环境包含 `<bin>`；配置自行设置 PATH 时按配置为准。
- 桌面 provider replay 候选：从本机会话读取 Host 注入的变量和 PATH 顺序；远端 Agent 进程中没有这个变量。远端不注入需要独立的远端 E2E 证据。
