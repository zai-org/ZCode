# 附加目录的 Subagent 没有进入模型请求

Status: needs-triage

2026-10-17 批量 E2E 转正期间记录。本轮未修改业务逻辑，也未把同名测试数据改成不同名称来规避范围问题。

- 规格：[虚拟项目 4.3](../../superpowers/specs/2026-09-09-virtual-project-design.md#43-与-cli-的接口b14-增量) 明确要求附加目录的 Skills、Subagents 被加载；同名 Subagent 通过 qualifiedName 并存。
- 回归：[VP16](../../../packages/desktop/test/e2e/conversation-session/projects/manual-review/pending/conversation-session-virtual-project-cold-roots.test.ts)。项目包含主目录 A 与附加目录 B，各自有同名 review agent 和不同说明标记。
- 运行证据：`packages/desktop/.e2e-artifacts/pending-promotion-repair-closeout-final-1-6-20261016-02001f1247/network-capture/upstream-provider.json`。首个真实模型请求正确包含附加目录 B、Skill A/B，以及主目录 AGENTS 标记；Subagent 仅有 A，缺少 B。
- 静态线索：[Host Subagent 缓存](../../../packages/services/src/subagents/subagentRuntimeConfig.ts) 按 workspace cwd 准备项目 scope；`readRuntimeConfig` 的工作区参数未包含附加目录。需要核对 Host 配置快照与 CLI 附加目录发现的组合边界。
- 本次停在创建阶段，运行实例保持 B、冷重建改用 C 的后续步骤尚未验证，不能算作通过。

验收：真实请求同时包含 A/B 的可区分 Subagent；修改项目目录后运行实例不变，重建后使用 A/C，工作目录和配置链仍只取 A。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-916-pending-20261019/VP16-network.json` 的首个模型请求再次包含 Skill A/B 和 Subagent A，缺少 `E2E_VP16_SUBAGENT_B`。创建阶段失败，后续运行实例保持及冷重建切换目录尚未执行。
