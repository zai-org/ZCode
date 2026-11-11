# 飞书群组草稿无法设置权限模式

Status: needs-triage

2026-10-17 转正回放确认。按用户要求只记录业务缺陷，不修改业务实现。

- 用例：`packages/desktop/test/e2e/bots/channels/manual-review/pending/feishu-group-runtime.test.ts`。
- 复现：已授权的群成员发送 `/new`，再发送 `/mode yolo`，随后发送普通任务。
- 实际：命令回复“未找到模式。”；保存的 `draftOptions` 没有 `mode`，新任务的权限模式为 `build`，预期为 `yolo`。
- 根因：`packages/services/src/bots/botsService.ts` 的 `listDraftConfigOptions` 只返回 `thought_level`；群组草稿的 `mode.set` 仍从这个列表解析模式，因此找不到任何合法模式。私聊的固定模式规则不适用于这个群组入口。
- 运行证据：`pending-promotion-repair-boundary-final-1-2-20261016-02001f1247` 中 `E2E_GROUP_MODE_RESULT` 日志，以及随后真实任务的权限断言。
- 规格：[飞书群组协作](../../bots-feishu-group-collaboration.md)。保留真实命令与真实任务断言，不通过直接写入草稿模式绕过错误。

```mermaid
flowchart LR
  A[群组 /new] --> B[群组 /mode yolo]
  B --> C[草稿配置列表只有思考档位]
  C --> D[回复未找到模式]
  D --> E[新任务沿用默认 build]
```

验收：群组草稿的合法模式命令保存所选模式，并用于下一条任务；非法模式仍拒绝，私聊固定模式边界不变。

## 2026-10-20 续跑证据（staging 52cd1bc1d3）

`pending-resume-52cd-extra-a-900-pending-20261019` 的 `E2E_GROUP_MODE_RESULT` 再次记录 `/mode yolo` 回复“未找到模式。”，草稿没有 mode；下一真实任务为 build，原断言期望 yolo。保留失败，不直接改写草稿。
