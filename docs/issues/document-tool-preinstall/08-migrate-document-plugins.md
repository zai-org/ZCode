# 08 — 四个文档插件迁移到统一调用脚本并导入本仓库

Status: done

## Parent

[01 — 桌面文档工具预装：LibreOffice](01-libreoffice-preinstall.md)

## What to build

让 Word、PPT、PDF、Excel 四个官方文档插件都使用 07 的统一调用脚本，并把新版本导入本仓库。
完成后，受管故障不阻塞任何系统版本；没有可用程序时，桌面用户先选择等待或由 Agent 按既有指南安装，远端和独立 CLI 保持原安装引导。

- 在上游插件仓库改四个插件的说明和脚本：
  - 不再直接调用 `soffice` 或 `libreoffice` 命令名，统一改为调用统一脚本；
  - 受管不可用时说明原因并回退系统版本；两者不可用时说明未就绪，由用户选择等待或安装；
  - 非受管模式保留现有安装引导；
  - 覆盖 Office 转 PDF，以及 Word `.doc` 转 `.docx`。
- 按现有同步流程导入本仓库并升版。所有版本来源（package、manifest、Bootstrap、SEA）与缓存路径保持一致。
- 更新文档类官方插件 spec 中已过期的版本号等事实。“依赖边界”一节在 11 中更新。

## Acceptance criteria

- [x] 四个插件的说明和脚本里不再直接调用 LibreOffice 命令名；安装引导不再由变量是否存在决定，桌面先让用户选择。
- [x] LOP-16（CLI 层面）：会话已启动、Bash 快照已建立后才写入测试安装记录，用户说“继续”，原会话使用记录中的绝对路径，不需要重启。
- [x] LOP-29：PDF 插件的 Office 转 PDF、Word `.doc` 转 `.docx` 都通过统一脚本完成。
- [x] LOP-30：远端或独立 CLI 中执行文档任务，插件保持现有安装引导，不提示打开本机预装工具。
- [x] 现有的版本一致性检查和种子完整性检查通过。

## Blocked by

- [07 — 统一调用脚本与配置模板](07-unified-invocation-script.md)

## 验证

全部在本机 macOS arm64 上完成。

- 上游插件仓库：按其测试方式验证四个插件。
- 本仓库：CLI 的 typecheck、lint 和受影响测试，包括 Bash 快照与既有会话的用例；运行现有的 SEA 版本一致性测试和种子完整性测试。
- 用真实样例文档在本机跑通四个插件，环境为系统 LibreOffice 加测试安装记录，记录产物。
- 远端行为（LOP-30）用现有远端 E2E 环境或独立 CLI 验证；远端环境不可用时，只验证独立 CLI，并把远端列为未验证项。

## Comments

### 2026-10-28 — 本地迁移与验收阻塞

- Status 保持 in-progress，四插件功能未提交。独立前置 commit `24ed016af5c` 仅补齐既有 visualize manifest/SEA 的 0.1.1；原提交 `f37223b3a1a` 已更新 package/Bootstrap，未同步其它 visualize 内容。
- 上游基线为 `6fc732bae4f8fd498834aff9ce9b54e399188d32`，来源为未提交源码 TREE，当前 OID 和归档摘要见 [08-source-import.json](08-source-import.json)。TREE 不是 commit 或发布，63 个导入文件均记录了 blob、mode 和来源方式。
- 先更新 spec 01，再导入 LibreOffice 限定增量。四份 helper/profile 字节相同；保留现有 office-runtime 构建、viewer Skill、workspace 隔离、许可和无关公式指导。目标版本 documents/presentations/spreadsheets 0.2.2、pdf 0.2.3；所有实际版本权威和必需资产已对齐，image-search 未变。
- 候选最低版本只约束受管系统回退；非受管旧版、开发版与原安装示例保留。公共 CLI 回归先证实 7.6 被误拒绝，再修复分支。
- PDF 转换只接纳本轮生成的文件，再替换交付副本；回归证实旧实现会接受同名旧 PDF 并允许覆盖输入，两者已修复。PDF/XLSX CLI 共用 SIGTERM 收尾，受控真实进程证明旧入口会遗留子进程、标记与配置；创建进程与交付句柄之间的取消窗口也已红→绿，句柄取得并收尾前保留归属。
- 通过：根 typecheck、lint（172 项既有 warning，0 error）、architecture（0 violation）；CLI typecheck 33/33、lint（71 项既有 warning，0 error）；上游运行回归 24/24、打包 3/3、36 插件 validate；Bootstrap 58/58、SEA 45/45、Bash/执行器 17/17、工程 52/52。四个 viewer 沿用 office-runtime 构建；远端资产合同确认 28 个 helper/profile 路径及 scripts 白名单。
- Bash 回归在同一执行器建立快照后写入记录，四插件使用新记录的绝对路径；移除环境变量后走非受管模式。此项验证 CLI 机制，不代替真实稳定版转换。缺宏配置的 seed 被拒绝；容器 staging 保留模板并排除 Python 缓存。
- 文件 hash/mode、四份内容一致性、保留边界、Python/Bash 语法、文档相对链接、格式和 diff 检查通过。源码 TREE、归档、累计补丁及红绿日志保存在本地协调目录。未运行桌面 E2E，未推送、创建 MR 或安装软件。
- 未验证：官方稳定版的真实四格式/旧 .doc 转换、公式缓存及错误、中文效果、GUI 并发和最低版本依据，仍需安装许可。Windows/PowerShell、真实远端部署、CDN 未运行。07/08 因必要验收阻塞保持未提交，不把现有开发版的失败证据计为通过。

### 2026-10-28 — 评审修复再次从上游导入

- 先在上游修复四插件统一 helper，再按字节导入；更新 [来源记录](08-source-import.json) 的源码 TREE、归档摘要和逐文件 blob/hash/mode，保留原 08 快照。TREE 仍不是 commit 或发布，未改目标版本、viewer、构建或许可内容。
- DOCX/PDF/XLSX 的 Windows 检查脚本复用已检测的 `$PyCmd`，支持已有的 `py`、`python3`、`python` 选择；缺少解释器时明确跳过，不再无条件执行 `python`。本机无 PowerShell，未执行原生 Windows 验证。
- 07 的进程归属、启动失败回退和 Python 3.9 信号回归一并导入。受管标记只覆盖受管程序；系统回退不保留该标记，文档处理失败不自动重试。
- Windows 启动器先退出的子树归属仍是已知未解决项；真实稳定版及既有其它验收阻塞保留，不声明全平台清理或完整验收通过。

### 2026-10-28 — 四插件真实运行与来源更新

- canonical helper／模板已合并 03 目标地址修复，以及 07 的宏、系统字体、缺失字体和字节码写保护修复。TREE 与归档摘要见 [08-source-import.json](08-source-import.json)，63 项逐文件来源及权限已审计。保留 office-runtime、查看器、MCP 隔离和许可边界；沿用本次尚未发布的 documents／presentations／spreadsheets 0.2.2、pdf 0.2.3。
- 官方稳定版实际完成 Word／PPT PDF 导出、PDF 插件 convert.office、真实 OLE DOC 转 DOCX，以及 Excel 公式缓存与错误扫描。三种模式均有公共脚本输出；未就绪时保留各模式的提示，没有尝试安装或调用其它办公软件。
- 中文渲染、GUI 并发、默认配置对照、调用标记清理、签名前后结果均保留。官方系统测试副本恢复为新鲜签名内容，未改默认文件关联或系统字体。
- 上游 LibreOffice 回归 36/36、打包回归 3/3、36 插件 validator 通过；四插件源码归档与新增真实测试增量均已冻结。主集成最终 CLI／资产检查和 commit 由整合阶段记录。其它平台、原生 PowerShell 和真实远端部署未运行。

- 本轮另用既有 headless-only 开发版复现了盲选原生后端的兼容回归，现仅在程序旁确有原生插件时选择 osx。真实兼容回归通过；它不计为官方稳定版验收。最终上游 36 项包含 4 项官方稳定版运行和 1 项既有无头版本兼容。

### 2026-10-28 — 最终本地验收收口

- 上游来源已固定为 commit `2c549e1da220d26ce92cfdbe7648e945ee2c27df`；[导入记录](08-source-import.json) 保留原归档摘要、TREE 和 63 项 hash／blob／mode，重新按 commit 审计。主集成 CLI typecheck 33/33、lint 0 error、Bootstrap 58/58、SEA 45/45、adapters 4/4 已通过；真实 App loopback 验证既有 Bash 快照和原 session 在安装后继续使用版本化插件。Status 改为 done。真实远端部署、PowerShell 和其它平台运行仍未验证。

### 2026-10-28 — 最终提交记录

- 主集成 commit：`8d5b8529d7d9b42db91fedb561f6a330ca54810d`，与 02/03 的目标地址契约一起提交。63 项来源按真实上游 commit 再核对；最终根检查、CLI 检查与 87/87 交点工程检查通过。历史开发版失败和中断报告保留，未计为成功。

### 2026-10-28 — 后续回退修复来源

- 旧测试仓库已迁移；在插件主仓库基线 `cf8ba59d3b4e471de2cfc4c7214501ff1fbc912b` 承接既有 LibreOffice 增量，再完成本轮修复。最终源 commit 与 TREE 以 [08-source-import.json](08-source-import.json) 为准，63 项 hash／blob／mode 逐项核对；保留两份 XLSX 文档的既有独立内容。
- documents／presentations／spreadsheets 升至 0.2.3，pdf 升至 0.2.4，Bootstrap、SEA、package 和 manifest 同步；桌面、远端和容器资产清单沿用现有完整 helper/profile 合同。所有顶层 preflight、路线与 setup 指南均改为新选择逻辑，安装之后仍调用统一脚本。
- 上游四个目标各自构建与确定性打包通过，49 个插件元数据校验通过。全量市场构建及全市场打包在无关 photocraft 的 Rust 1.95.0／wasm 工具链处阻塞；未修改其源码或把全量检查记为通过。

- 最终源 commit `3ffe0f0d53e7c52e98be9bf4225ef0617ebb6c6a`。上游 40/40 包含真实稳定版及失败尝试产物隔离，四份 helper／模板与本仓库 63 项来源记录对应。未推送或创建 MR。

### 2026-10-28 — 系统符号链接入口修复

- 上游来源 `583d3759112d8350d93f58cb4848600da590d6b5`；四插件保留系统程序调用名，解析后的路径只作文件校验，避免多入口分派失效。受管目录校验不变。
- documents／presentations／spreadsheets 升至 0.2.4，pdf 升至 0.2.5；63 项导入摘要与来源同步。
- 上游运行回归 36 项通过；随后分别通过 4 项官方 macOS 程序验收与 1 项已有无头程序兼容验收，覆盖符号链接入口下的字体、重算与签名。四目标构建与两次打包一致性、49 项插件元数据校验通过。原生 Linux Snap 未运行，已用真实子进程验证相同入口分派边界。
