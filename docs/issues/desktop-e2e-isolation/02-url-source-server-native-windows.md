# 02 — VP17/VP18 在 Windows CI 上把 URL Source Server 原生跑在 Windows，远端 cwd 变成 `C:\C:\...`

Status: needs-triage

## 现象

Windows CI 的 `VP08/VP17/VP18 URL：元数据无 tab，远端任务执行、重开与 CLI 冷恢复` 稳定失败（pipeline 333740、335767 均失败），失败断言是远端请求里应包含附加 root 的 skill `E2E_VP17_REMOTE_EXTRA_SKILL`。

## 证据

本地 Windows 复现（2026-11-11，`desktop-e2e-20261111-101721-987`）：

- 远端 Source Server 收到的 `sendConversationCommandV4` 入参 `workspacePath` 是原生路径 `C:\...\url-server\work\repo`。
- 远端 CLI 的 `zcode_protocol.session_create.started` 日志中 `workspacePath` 是 `/C:/.../url-server/work/repo`，`bootstrap.app.startup.runtime_config.completed` 的 `workingDirectory` 是 `C:\C:\...\url-server\work\repo`。
- 抓到的远端模型请求中，skill 列表只有插件 skill，没有任何项目级 skill。

原因链：`normalizeWorkspacePathForIdentity` 把 `C:\x` 归一成 `/C:/x` 写进 identity；CLI 的 `resolveWorkspaceRefFromId`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace.ts`）从 identity 取回路径时没有反向转换，Windows 上 `resolve("/C:/x")` 得到 `C:\C:\x`，项目 skill 根和 cwd 都指向不存在的目录。

## 判断

[远程主链入口](../../remote/README.md) 规定远端只支持 Linux 与 macOS，Windows 主机通过 WSL 连接。用例在 Windows runner 上原生启动 URL Source Server，测的是规格外的配置，不是已支持路径的回归。

## 待决

- 方案 A：VP17/VP18 的远端执行段在 win32 上跳过并在 case catalog 注明，VP08 控制端部分继续在 Windows 运行。
- 方案 B：产品支持 Windows 原生 Source Server，在 shared 增加 identity 路径到原生路径的反向转换并更新远程 spec。

2026-11-11 决定：MR !3578 不处理，留此票跟踪。
