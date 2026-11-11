# Conversation Session Manual Review Pending Run - 2026-06-23

本记录用于承接 `packages/desktop/test/e2e/conversation-session/manual-review/pending/`
逐条 review 迁移：先跑 pending spec，整文件通过且断言语义适合默认验收的 spec 才移回
`packages/desktop/test/e2e/conversation-session/`。

本文是 2026-06-23 至 2026-06-24 的历史运行记录，不表示这些 spec 当前仍处于 formal admitted 状态。后续 V4 迁移已把包括 `conversation-session-turn-steer-probe.test.ts` 在内的历史 conversation spec 重新降级到 `manual-review/pending`；当前物理路径和 formal gate 状态以 [conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md) 为准。下文“转为默认 conversation E2E”只描述当时的晋升与复跑结果。

## 运行命令与产物

单跑：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-compact-auto.test.ts'
```

- Summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260623-153459-510/summary.md`

批量顺序跑：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_SPEC='<remaining pending specs>' pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

- Summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260623-154027-061/summary.md`
- Wrapper log: `tmp/manual-review-run-20260623154025/wdio.log`

补跑后发现的 pending spec：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_SPEC='./test/e2e/conversation-session/manual-review/pending/conversation-session-running-send-now.test.ts' pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

- Summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260623-160950-505/summary.md`

人工干扰后复跑确认的 pending spec：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/context/conversation-session-compact-interrupted.test.ts'
```

- Summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260623-163701-534/summary.md`

剥离 auto compact retry 后复跑确认的 pending spec：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-compact-auto.test.ts'
```

- Summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260624-042921-602/summary.md`

补充 compact running toast 断言并转正的 edit spec：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/editing/manual-review/pending/conversation-session-edit.test.ts'
```

- Manual summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260624-064810-462/summary.md`
- Manual result: 2 passed。已确认 `held queue + compacting 中重复 /compact`
  场景通过：重复 `/compact` 会弹运行中不能压缩 toast，不入队、不新增 compact 请求、
  不作为普通 user message 展示。
- 默认路径复跑：

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/editing/manual-review/pending/conversation-session-edit.test.ts'
```

- Default summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260624-070956-672/summary.md`
- Default result: 2 passed。已移出 `manual-review/pending`，转为默认 conversation E2E。
- Capture note: D10 的 stop 中断窗口依赖慢流 replay fixture；真实 DeepSeek capture
  在首个可见 delta 出现时可能已经 completed，不能作为稳定 stop gate。转正时补了
  edit rerun 专用默认 fixture，并用不同回复 `upstream-e2e-edit-rerun-ok` 证明 edit 后
  确实触发新 query。

Turn steer 探针转正后默认路径复跑：

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/execution/conversation-session-turn-steer-probe.test.ts'
```

- Summary: `packages/desktop/.e2e-artifacts/desktop-e2e-20260624-070258-617/summary.md`
- Result: 3 passed。已移出 `manual-review/pending`，转为默认 conversation E2E。该 spec
  明确切回 `queue` 交互行为覆盖 M01-M05；`guide` 模式继续由
  `conversation-session-running-guide-steer.test.ts` 覆盖。

配套 runtime retry 单测：

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-compact.test.ts -t "retries auto compact up to three attempts before continuing the turn"
```

- Result: 1 passed

## 已迁移

以下 spec 整文件通过，且迁移到默认路径后复跑仍通过，已移到
`packages/desktop/test/e2e/conversation-session/` 并回写覆盖矩阵路径。

| Spec                                                   | 结果                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `conversation-session-compact-manual-queue.test.ts`    | pass                                                               |
| `conversation-session-compact.test.ts`                 | pass                                                               |
| `conversation-session-config-and-multisession.test.ts` | pass；2026-06-24 修正已完成 session 误判为失败后，默认路径复跑通过 |
| `conversation-session-first-send.test.ts`              | pass                                                               |
| `conversation-session-goal-queue.test.ts`              | pass                                                               |
| `conversation-session-queue-operations.test.ts`        | pass                                                               |
| `conversation-session-running-guide-steer.test.ts`     | pass                                                               |
| `conversation-session-stop-empty.test.ts`              | pass                                                               |
| `conversation-session-stop-held-queue.test.ts`         | pass                                                               |
| `conversation-session-turn-steer-probe.test.ts`        | pass；2026-06-24 补齐 queue 前置和慢速 tool final fixture 后，默认路径复跑通过 |
| `conversation-session-edit.test.ts`                    | pass；2026-06-24 补齐 D10 慢流 stop gate 与 edit rerun fixture 后，默认路径复跑通过 |

## 通过但未迁移

| Spec                                                       | 原因                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversation-session-compact-auto.test.ts`                | 2026-06-24 复跑通过。G01 已剥离为首次 compact 成功主路径，G08-G10 retry 覆盖改由 `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts` 承担；尚未执行默认路径迁移和默认 gate 复跑。 |
| `conversation-session-compact-timeline-projection.test.ts` | pending 路径下通过，但移到默认路径复跑时两个测试都直接失败：spec 内仍要求 `ZCODE_E2E_MANUAL_REVIEW=1`。需要先去掉 manual-only 依赖或补默认 replay 口径后再迁移。                           |
| `conversation-session-compact-interrupted.test.ts`         | 2026-06-24 复跑通过，确认前一次失败来自人工干扰；尚未执行默认路径迁移和默认 gate 复跑。                                                                                                    |
| `conversation-session-model-switch-auto-compact.test.ts`   | pending 路径下通过，但移到默认路径复跑时 N06 捕获不到 auto compact 完成后的完整请求。需要先补默认 replay/capture 口径后再迁移。                                                            |
| `conversation-session-running-send-now.test.ts`            | 4 个测试全部通过，但最后一条标题和断言明确是在复现当前 bug：连续快速点击立即引导会重复发送并消费未点 queue item。该断言不能作为默认验收语义，需要先改成理想产品语义断言后再迁移。          |

## 失败清单

| Spec                                                       | 失败点                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-session-fork.test.ts`                        | 父 session goal + held queue fork 场景没有找到预期 queue；edit 后 fork 仍复制了旧分支文本。                                      |
| `conversation-session-goal-run-cases.test.ts`              | MR-GOAL-07 queue 数量没有变为 3；MR-GOAL-11 queued goal 的立即发送按钮没有出现。                                                 |
| `conversation-session-goal-session-model.test.ts`          | queued goal 当前模型请求捕获不符合预期；session 切换后 DeepSeek 模型没有回到 `deepseek-v4-flash`。                               |
| `conversation-session-goal.test.ts`                        | completed/running/held queue 的 `/goal` 断言期望 kind 为 `goal`，实际为 `turn-steer`。                                           |
| `conversation-session-interrupted-actions.test.ts`         | interrupted 场景没有出现可点击 stop 按钮。                                                                                       |
| `conversation-session-model-config.test.ts`                | session A 首发请求捕获到 `deepseek-v4-pro/max`，不符合工具栏选择。                                                               |
| `conversation-session-model-switch-compact.test.ts`        | 切换 secondary 后模型没有切到 `deepseek-v4-pro`。                                                                                |
| `conversation-session-model-switch-queue.test.ts`          | running queue 消费前切模型场景期望 kind 为 `text`，实际为 `turn-steer`。                                                         |
| `conversation-session-model-switch-tool-edit-fork.test.ts` | 工具窗口找不到 `deepseek-v4-pro` 选项；edit/fork 后续模型切换和新建任务点击失败。                                                |
| `conversation-session-prewarming-queue.test.ts`            | prewarming 中继续输入期望 kind 为 `text`，实际为 `turn-steer`。                                                                  |
| `conversation-session-running-actions.test.ts`             | running 中禁 fork/edit 场景没有出现预期 assistant 文本。2026-06-24 后续人工 review 通过，并已迁入默认 replay 路径。              |
| `conversation-session-running-queue.test.ts`               | running 中普通输入和 `/goal` 场景期望 kind 为 `text`，实际为 `turn-steer`。                                                      |
| `conversation-session-tool-actions.test.ts`                | 没有找到匹配的 tool call block `toolu_e2e_read_action_guard`。                                                                   |
