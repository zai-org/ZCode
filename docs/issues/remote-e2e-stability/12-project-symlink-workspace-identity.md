# 远程项目从符号链接创建任务后未收敛到 realpath identity

Status: ready-for-human

## 2026-11-11：业务影响的证据边界

当前已确认的结果是同一物理目录形成两个 workspace identity / logical session。
尚未通过实际业务操作证明任务丢失、配置错误、文件覆盖或错误写入，不能把这些后果当成已确认缺陷。
任务和工作区状态按身份隔离，因此跨真实路径与链接入口查看既有任务、读取配置及恢复执行
仍需专项验证。现行 R3 的新目录 realpath 合同继续保留，历史任务身份也不得因此被改写。
本轮不修改产品，也不把本例转正；其业务后果标记为待验证。

## 2026-11-10 转正复验

`local-docker-20261110104324-f9ea62` 再次在相同的 identity 就绪断言失败。
`source-lines.json` 确认符号链接夹具有效，`cd -P` 得到真实目录；
新建项目后的活动 identity/path 仍为链接目录。WebDriver 后续快照中，真实目录的原 tab
和链接目录的活动 tab 同时存在，identity 未收敛。第二条 alias 线路及其同步断言未执行。

当前 R3 身份规格 §3.2 仍将新目录选择的 realpath 列为已知缺口，因此不是应删除的旧断言。
用户本次要求暂不修改产品，继续保留 pending，未改预期路径或弱化就绪条件。

## 复现与运行证据

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，test 构建。
批次 `r3-server-20261011105317614-4a6780`，`sourcelines`。

1. 同一 SSH Source 上创建真实目录 A 和指向 A 的符号链接。
2. 为 A 创建远程项目，并从项目创建草稿，得到 canonical workspace attachment。
3. 为符号链接创建另一个项目，再从该项目创建草稿。
4. 等待当前执行 identity 收敛到 A，60 秒后仍失败。

运行日志在 19:00:51 记录 Host `bound remote workspace context` 的路径为
`/home/dev/r3-workspace-link`，sessionId 为 `5fd8a173-9662-4a51-8970-602e7b97a241`。
Main/Renderer 随后使用 `remote:server:<同一 Source ID>:/home/dev/r3-workspace-link`。
失败快照中 active identity/path 仍为链接路径；原 A 的 tab 保持
`remote:server:<同一 Source ID>:/home/dev/r3-workspace-a`，sessionId 为
`569d26f6-a878-4c6e-998e-733fa916ce0e`。

```text
项目 A root = realpath → workspace A / attachment 1
项目 B root = symlink → workspace link / attachment 2
预期：项目可以不同，执行 workspace 经远端 realpath 收敛为同一个 A
```

## 合同与影响

[R3 身份合同](../../architecture/r3-source-server-remote-architecture.md) §3.2 要求打开 workspace 前
在远端执行 realpath，避免 symlink 别名产生两个身份。
[当前项目合同](../../superpowers/specs/2026-10-10-session-manage-upstream-integration.md) 允许多个项目共享目录，
因此旧 case 的“不能出现第二个项目”断言已迁移；允许多个项目不等于允许同一真实目录产生多个执行 identity。

现象确认于 Host 绑定日志与 Renderer 快照，不能仅解释为旧项目数量断言或侧栏 selector 失效。
影响同一目录的 attachment 复用与任务运行上下文归属。具体漏掉 realpath 的调用点仍需业务修复时定位；
本轮不修改产品代码，也不把预期路径改成 symlink 来消除失败。

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011105317614-4a6780-sourcelines/`；
对应 run log 保留在同批 `r3-server/run-logs/`。测试 helper 已补项目 identity 的严格就绪检查，
该补丁尚待同基线复验，不将静态检查算作 E2E 通过。

## 2026-10-20 最新 staging 复验

基线 `52cd1bc1d3`，批次 `r3-server-pending-52cd-b-pending-sourcelines` 仍失败。
这次先验证链接夹具：`ln -sfn` 返回 0，`test -L` 成功，远端 `cd -P` / `pwd -P`
返回 `/home/dev/r3-workspace-a`。随后真实项目创建入口得到的活动 cwd 与 identity
仍包含 `/home/dev/r3-workspace-link`，并创建独立 logical session。
证据为该批次的 `source-lines.json`、Host 绑定日志和 WebDriver 失败快照。
第二条 alias 线路和 Provider 同步断言尚未到达，不据此推断它们失败。

需保留[项目设计](../../superpowers/specs/2026-09-09-virtual-project-design.md)的身份所有权边界：
已有项目或历史任务的 cwd / identity 由所属 Host 提供，Renderer 不能再次 realpath 后改写；
普通文件夹选择仍应解析 canonical path。本次是从目录浏览器新建项目，不是重开历史任务。
当前 `DirectoryBrowser.navigateTo` 仅验证 `readdir`，保留输入路径；
`projectService.readDirectory` 仅执行 `normalize`，也不解析符号链接。
因此问题应继续定位在新目录选择到项目 root 保存的路径链路，不能用 Host 绑定时擅自改写
既有身份来修复。具体业务修复方案仍待单独处理，本轮仅补测试夹具验证和运行证据。
