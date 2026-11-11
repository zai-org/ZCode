# Issue tracker: Local Markdown

项目 Issue 使用本地 Markdown 文件。用户已明确要求不在远端仓库创建 Issue；只有后续明确要求线上发布时才改变该次操作的目标。Git remote 仅表示代码仓库位置，不能用它推断 Issue 发布位置。

## 文件与状态

- 已存在于 `docs/` 的完整 spec 可以直接作为本地 Issue，保留原路径，不复制第二份正文。
- 新的独立 Issue 放在 `docs/issues/<feature-slug>/<NN>-<slug>.md`，每个任务一个文件；同一功能从 `01` 顺序编号。已有 spec 的实现子任务链接到该 spec。
- 文件标题下使用 `Status:` 行记录状态。可直接实施的 spec 使用 `Status: ready-for-agent`，其余分诊状态沿用 `needs-triage`、`needs-info`、`ready-for-human`、`wontfix`；任务开始和完成时分别更新为 `in-progress`、`done`。
- 关联和依赖使用本地 Markdown 链接；讨论记录按需追加到文件末尾的 `## Comments`，无需将当前会话全文复制入库。

## 技能操作映射

- “publish to the issue tracker”：写入或更新本地 Issue 文件，应用对应 `Status:`，返回文件链接。
- “fetch the relevant ticket”：读取用户给出的文件或本地 Issue 编号对应的 Markdown。
- “apply ready-for-agent label”：写入 `Status: ready-for-agent`，不创建远端标签。
- Issue 工作流不调用 GitHub/GitLab 的创建或更新接口。MR 工作流继续遵守项目已有 MR 规则，两者相互独立。

## 当前 Issue

- [桌面本地消息 TTFT 分阶段遥测](../monitoring/ttft-stage-telemetry.md)
- [Web 远控接入 Relay V2：手机登录后连接桌面](../issues/web-remote-control-relay-v2/01-relay-v2-login-pairing.md)
- [数据同步：把本机配置推送到远端设备](../remote/data-sync.md)
  - 实施票 [01](../issues/data-sync/01-harden-user-config-writers.md)～[16](../issues/data-sync/16-migration-entry.md)，编号按依赖先后排列；01、02、03 可立即开始，04 是首条 Tracer（依赖 01、03），其余每张票写明其阻塞项
  - 后续修订 [19](../issues/data-sync/19-scope-menu-project-submenu.md)：Scope 菜单的项目收进各设备的子菜单
  - 后续修订 [20](../issues/data-sync/20-builtin-subagent-model-overrides.md)：子智能体分类推送内置智能体的模型覆盖
- [远程连接（SSH / WSL / Docker）交互与视觉体验优化](../issues/remote-connection-ux/01-remote-connection-ux-optimization.md)
  - 实施票 [02](../issues/remote-connection-ux/02-connection-log-and-error-contract.md)～[14](../issues/remote-connection-ux/14-visual-polish-and-accessibility.md)，编号按依赖先后排列，每张票写明其阻塞项
- [3.16.2 远程（SSH）会话卡顿：根因与优化方案](../issues/remote-performance-3-16/01-remote-session-lag-analysis.md)
- [3.16.2 Source Server 启动阶段失败：工单分诊与修复记录](../issues/remote-startup-failures-3-16/01-source-server-startup-failure-triage.md)
  - 已修复 [02](../issues/remote-startup-failures-3-16/02-service-registration-failure-fallback.md)、[03](../issues/remote-startup-failures-3-16/03-corrupted-release-recovery.md)（损坏 release 可由「重新安装远端服务」修复，损坏来源仍未知）；未决项 [04](../issues/remote-startup-failures-3-16/04-shared-home-across-hosts.md)～[06](../issues/remote-startup-failures-3-16/06-legacy-lock-pid-reuse-after-upgrade.md)：需要产品决定或用户补充材料
- [3.16.2 远程连接工单分诊（2026-10-22 批次）](../issues/remote-tickets-3-16-2-1022/01-ticket-triage.md)
  - 已修复 [02](../issues/remote-tickets-3-16-2-1022/02-startup-reconnect-cancel-hangs-ssh-flight.md)、[03](../issues/remote-tickets-3-16-2-1022/03-install-confirm-drops-ssh-password.md)；未决项 [04](../issues/remote-tickets-3-16-2-1022/04-wsl-stale-failure-handoff-and-profile-split.md)～[09](../issues/remote-tickets-3-16-2-1022/09-remote-devices-settings-typography.md)：需要产品/设计决定或用户补充材料
- [在设备卡上停止和重启远端服务](../issues/remote-daemon-lifecycle/01-stop-restart-remote-service.md)：CLI `stop --wait` / 整棵进程树 `restart`、Host 生命周期操作 flight 与设备卡「更多」菜单入口
  - 实施票 [02](../issues/remote-daemon-lifecycle/02-prefactor-stop-wait-and-lifecycle-flight.md)～[05](../issues/remote-daemon-lifecycle/05-confirm-running-tasks-and-impact.md)：02 预备重构可立即开始；03 停止依赖 02；04 重启依赖 02、03；05 确认弹窗依赖 03、04
  - 后续 [06](../issues/remote-daemon-lifecycle/06-online-error-shown-as-failed.md)：生命周期操作失败但连接仍在时显示“连接失败”（needs-triage）
- [官方插件首次 seed 同步阻塞 CLI 事件循环](../issues/official-plugin-seed/01-sync-seed-blocks-cli-event-loop.md)：Windows 冷 HOME 首条消息等待 8–15 s（needs-triage）
- [归档页「删除全部」每条都冷恢复 session](../issues/agent-cold-start-performance/02-archived-bulk-delete-cold-resume.md)：删除 25 条约 50–75 s（needs-triage）
- [签名修复只改本次请求副本，之后的请求可能每次先失败一次](../issues/reasoning-signature-repair/01-request-local-repair-repeats.md)：修复成功后在 assistant 上记标记，之后的请求不再发送已去掉的块（done）
- [断流恢复后冷恢复比 live 多回放一轮服务端工具](../issues/stream-recovery-provider-round/01-cold-resume-replays-dropped-provider-round.md)：已有本地工具提交时的恢复路径，live 与冷恢复请求不同（needs-triage）
