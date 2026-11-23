# Workspace Hook Trust 用户指南

Workspace/project Hook 来自仓库配置并可执行本地命令，因此默认未信任。打开 workspace、
启用普通 Hooks 总开关或确认 deep link 都不会自动授权。

## 在设置中信任

当自然事件命中未信任 Hook 时，对话照常继续，Hook 保持 fail closed。composer 权限选择器右侧会出现 Hook 图标，右上角圆点表示未读。点击图标查看待审核说明，
圆点随即消失；点击“去审核”进入 `设置 → 钩子 → 工作区`，点击“忽略”隐藏本次提醒。
关闭浮层后仍可点击图标重开；Hook 配置版本变化或新会话会重新提醒。

未信任行只在最右侧配置开关左边显示“信任”：

```text
Hook 名称与命令                                      [信任] [开关]
```

- 点击“信任”建立当前 `workspaceIdentity + hookDeclarationDigest` 的持久 Trust；成功后按钮消失。
- 配置开关只控制 Hook 是否启用，不会建立或撤销 Trust。
- 页面不提供本次授权、批量信任或行内撤销。
- 关闭设置、超时、断连都等于“没有决定”，不会改变 Trust。

信任只影响之后自然发生的事件。已经因未信任而跳过的 SessionStart 不会在当前 task 的下一条
消息补跑；它最早在下一次真实的新 task/session SessionStart 运行。

声明的命令、matcher 等语义发生变化时 digest 会变化，新声明恢复未信任并重新显示按钮；
未变化声明继续命中原 Trust。`onError: "deny"`（Hook 失败时拦截工具调用）也算执行语义：
加上或去掉它都会改变 digest；不写或写成 `allow` 不改变 digest。

声明直接调用的工作区脚本也算在内，例如 `./scripts/check.sh`、`bash .zcode/hook.sh`，
或 process 类型的 `{ "command": "node", "args": [".zcode/audit.mjs"] }`。脚本内容变化后该条恢复未信任，
重新信任后恢复。会话进行中脚本被改，这条 Hook 在本会话中每次运行前都会被拦下，直到脚本恢复为已信任的内容；
在设置页重新信任后，新开任务才按新内容运行。若它是配置了 `onError: "deny"` 的 PreToolUse 守卫，本会话中的工具调用会持续被拒绝。
新开任务时入口脚本已不存在，这条 Hook 不能信任、会被跳过，守卫不再拦截工具调用；请恢复脚本后重新信任。升级后，这类 Hook 需要重新信任一次。

入口脚本不存在或无法读取时，没有可审核的内容：这条 Hook 不能信任，也不会运行，设置页会说明原因。
脚本创建或恢复可读后，按实际内容重新显示“信任”按钮。已信任的脚本被删除或无法读取时，这条 Hook 同样停止运行。

只有入口脚本参与检查。参数里的日志、状态等文件不参与，Hook 改写它们不会使信任失效。
以下写法无法识别入口，保持原有的声明级信任，脚本内容变化不会触发重新信任：管道、`&&`、`cd` 前缀、
引号、解释器启动选项、`npx`/`npm run` 等包装命令、自定义 shell。需要内容绑定时，把这些逻辑移进脚本，
再用上面的直接写法调用。Windows 上 `command` 类型不做脚本内容绑定，需要绑定时改用 process 写法。完整规则见 [Hook 信任规格](specs/workspace-hook-trust.md#129-直接入口脚本绑定d24)。

普通工具执行权限中的 `Allow once` 是另一套权限系统，不属于 Workspace Hook Trust。

## worktree 任务

worktree 任务与源仓库共用信任记录：源仓库已信任、且在 worktree 中内容相同的 Hook 直接运行。
worktree 中的声明或入口脚本与源仓库不同时（例如源仓库有未提交的修改），这一条在 worktree 任务中待审核。
在 worktree 任务中点击“去审核”，设置页按该 worktree 的文件列出 Hook，列表上方提示
“信任将同时作用于源仓库 <路径> 及其 worktree”。点击“信任”后，任务的待审核提示消失。
在范围菜单中手动切换后，设置页回到按项目主目录列出 Hook。

## 安全与恢复

- managed `deny` 始终高于用户 Trust。
- rollout gate 关闭时所有 project Hook hard block，已有记录保留但不读取。
- stale task/run/remoteSession/generation/snapshot 响应在写 Trust store 前被拒绝。
- Desktop continuous 与 mobile replayable 使用同一 Runtime 权威审核绑定；重连不能扩大授权。

需要撤销已有记录时，使用受信任的管理/CLI 入口按 exact digest 撤销；配置开关不承担撤销语义。

### Trust store 损坏（`workspace_hooks_trust_store_corrupt`）

持久 Trust store（`~/.zcode/security/workspace-hook-trust-v1.json`，可被 user config 的
`storage.dir` 重定向）按完整 strict schema 解析：JSON 语法错误、缺少 `schemaVersion`、
record 缺少必需字段（`decision` / `grantedAt` / `digestAlgorithm` 等）、非法时间戳、未知
字段等一律判 corrupt 并 fail-closed——所有消费者（Settings UI、Runtime admission、CLI）
对同一文件得出同一结论，corrupt 下不展示任何 `trusted_persistent`，Hook 全部按未信任
软门禁跳过。

`zcode hooks trust status` 对损坏 store 显式返回
`reasonCode: workspace_hooks_trust_store_corrupt`（而非 `pending_trust`），且 `grant` /
`revoke` 会被拒绝直到修复。首次读取时损坏文件会被改名为
`workspace-hook-trust-v1.json.corrupt-<timestamp>`；恢复方式：从备份还原该文件，或确认
无需保留后删除 `*.corrupt-*` 残留文件以重建空 store，再重新执行 grant。

## 人工验收

仓库提供无害 fixture：

```bash
node scripts/create-workspace-hook-trust-uat-fixture.mjs
```

完整操作和预期结果见
[`workspace-hook-trust-manual-acceptance.md`](./testing/workspace-hook-trust-manual-acceptance.md)。
