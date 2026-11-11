# 远程主链阅读入口

当前规格覆盖 SSH / WSL / Docker Source Server。按改动选择事实文档，不把历史计划当作当前合同。
运行时 owner、workspace identity、单 Window Host 与 continuous/replayable 边界见
[runtime 边界](../agents/runtime-boundaries.md)。

```text
R3 主规格（身份 / 连接 / 迁移）
  ├─ 连接 UX（向导 / 五态 / 设备管理）
  ├─ 项目导航（目录意图 / 断线体验 / 导航恢复）
  └─ 专项合同（Provisioning / Renderer 挂回 / 持久化兼容）
场景目录 → 覆盖矩阵 → 按基线保存的运行证据
未决问题 → 问题台账；旧过程正文 → 历史快照入口
```

## 支持范围

远端只支持 Linux 与 macOS 的 x64、arm64；Linux 需要 glibc 2.28 及以上（CentOS 7、Ubuntu 18.04、Alpine 等 musl 系统暂不支持），Windows 请通过 WSL 连接。连接前的 probe 对 Windows 原生主机和不支持的架构给出专用提示；glibc 过低或 musl 只在连接日志警告并继续安装或连接，规则见 [R3 主规格 §5.1](../architecture/r3-source-server-remote-architecture.md)。

## 当前合同

下表的主规格均指 [R3 Source Server 架构](../architecture/r3-source-server-remote-architecture.md)。

| 改动                                                     | 事实源                                                                                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source/Profile/三层 workspace identity、任务地址         | 主规格 §3                                                                                                                                                                                                       |
| 进程、Transport、安装与升级、远端 daemon/archive         | 主规格 §4–5；[Server CLI/daemon](../architecture/r2-server-cli-and-daemon.md)                                                                                                                                   |
| 握手、鉴权、兼容门与更新                                 | 主规格 §6                                                                                                                                                                                                       |
| 物理连接、启动静默连接、重试与恢复换代                   | 主规格 §7                                                                                                                                                                                                       |
| RPC 服务归属、设备管理与迁移                             | 主规格 §8–9                                                                                                                                                                                                     |
| Renderer reload、Source 上线后的项目挂回                 | [Renderer 重挂](desktop-remote-session-renderer-reattach.md)                                                                                                                                                    |
| Projection、open set、strict schema、R4 待迁移事项       | [投影与持久化兼容](../architecture/remote-domain-simplification-and-conversation-workspace-spec.md)                                                                                                             |
| 三屏向导、统一五态、错误日志、设备卡、安装预览与任务清单 | [连接 UX](../architecture/remote-device-connection-ux-spec.md)                                                                                                                                                  |
| 平铺项目、原地重连、目录权限、恢复原项目与会话           | [项目导航](project-first-remote-navigation-spec.md)；远程无项目聊天 UI 已停用，数据保留                                                                                                                         |
| Provider 自动下发与本地模型设置                          | [Provisioning](provider-provisioning.md)；[应用配置归属](../ssh-remote-app-global-state-authority.md)                                                                                                           |
| 手机已有 Host attachment 与 replayable 恢复              | [远控架构](../web-remote-control/web-remote-control-architecture.md)、[任务实时同步](../web-remote-control/task-realtime-sync.md)、[手机工作区重连](../web-remote-control/mobile-remote-workspace-reconnect.md) |
| WSL                                                      | [实时边界](wsl-remote-realtime-boundary.md)、[Provider headers](wsl-provider-runtime-headers.md)、[WSL 设计](../wsl-remote-workspace-design.md)                                                                 |
| Windows 资产缓存                                         | [缓存 rename](windows-remote-asset-cache-rename-hardening.md)                                                                                                                                                   |
| Desktop descriptor/archive 网络策略                      | [远端资产网络策略](zcode-agent-remote-deployment.md)                                                                                                                                                            |
| dev-only Server 直连                                     | [Server workspace](server-remote-workspace-connection.md)；旧进程描述以主规格为准                                                                                                                               |
| 发布产物与 CI                                            | [CI/CD](../desktop-ci-cd.md)、[产物布局](../desktop-ci-artifact-layout.md)                                                                                                                                      |

## 问题与验证

- [按设备设置工作区记忆](memory-settings.md)：记忆页复用设备 Scope，分别读写本机及远端开关；文件查看仍限本机。

- [数据同步：把本机配置推送到远端设备](data-sync.md)：`Status: ready-for-agent`。设置页新增按设备推送 User 级技能、MCP、插件、子智能体、命令、钩子；模型提供商只读并支持失败重试；旧同步入口统一到新弹窗；Scope 菜单按设备分组。拉取、会话、记忆不在本期范围。

- [项目创建与远程连接管理分离](../issues/remote-connection-ux/15-project-device-selection-and-connection-management.md)：包含三入口、设备选择、分类添加、返回草稿与验收场景；实施与验证范围见子票 #16–#22 的完成记录，父票状态及未验证平台以各票记录为准。

- [聊天连接后必选远程文件夹并进入项目](../issues/remote-connection-ux/21-chat-settings-round-trip.md)：2026-10-14 已按 #23–#26 实施；每次显式选目录，按唯一／多个／零匹配进入项目，取消恢复原目标，项目准备完成前禁止发送。当前验证证据与未实跑平台见规格，候选仍保留人工审核边界。

- [在设备卡上停止和重启远端服务](../issues/remote-daemon-lifecycle/01-stop-restart-remote-service.md)：`Status: ready-for-agent`。设备卡「更多」新增重启、停止远端服务；CLI `stop --wait` 与整棵进程树 `restart` 负责时序，Host 停止前先断开、重启期间断线视为预期。仅桌面端。

- [R3 问题台账](../architecture/r3-source-server-remote-open-issues.md)：保留未修复、待验证与产品待决项，关闭项不再排入修复顺序。
- [3.16.2 远程会话卡顿](../issues/remote-performance-3-16/01-remote-session-lag-analysis.md)：发送前的远端查询、侧栏频繁全量读取远端的根因证据与优化方案；三项产品决定待确认。
- [UX 子任务索引](../issues/remote-connection-ux/01-remote-connection-ux-optimization.md)：已完成实施与未决 ssh-agent 评估。
- [测试方案](../testing/r3-remote-automation-plan.md)、[R3A 矩阵](../testing/r3-remote-automation-case-matrix.md)：完整验收目标及覆盖差距。
- [case 目录](../conversation-session-case-catalog.md)、[覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)：稳定 ID、测试文件、pending/formal 状态和证据。
- [SSH P0](../testing/ssh-remote-p0-e2e-plan.md)：专项断言与项目入口；[harness](../../harness/remote/README.md)：执行命令及环境隔离。
- [2026-10 桌面 SSH 指南回归](../testing/desktop-ssh-guide-regression.md)：100 个调度场景原批次及后续定向修复，不能据此声称手机/WSL/Docker 全绿。
- [2026-09-10 历史重跑](../testing/r3-remote-full-rerun-2026-09-10.md)：原基线结果；[历史归档索引](../archive/remote-r3/README.md)可定位更早证据。

记录中的 PASS 只适用于所列源码、构建、场景与环境。文档压缩不补跑测试、不改变状态，也不删除原始 artifact。
