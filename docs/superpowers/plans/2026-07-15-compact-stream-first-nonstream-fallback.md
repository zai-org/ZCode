# Compact Stream-first → Non-stream Fallback 实施计划

## 目标与冻结边界

目标：仅把 compact summary 的 transport 调整为：

```text
一个逻辑 compact attempt
├─ streamText(compactRequest)
│  ├─ finish → 隐藏聚合 summary
│  ├─ request setup 404，或 response body commit 前 eligible failure
│  │  └─ generateText(同一语义 compactRequest)
│  └─ 其他 request setup / post-commit failure → 原样抛出
└─ 进入既有 summary 校验、timeline 与 persistence
```

冻结不动：

- compact prompt、tools、thinking、selection、preserved tail 与 boundary；
- manual / auto / reactive 生命周期和 auto 最多 3 次逻辑 attempt；
- adapter SSE/HTTP retry 次数、backoff 与 idle timeout；
- 普通 main turn 的 streaming、eager tool-call 与恢复策略；
- protocol、UI、desktop continuous、web-remote replayable；
- cache-sharing fork、独立 summarizer 与固定 compact model。

当前设计合同：

- `docs/superpowers/specs/2026-07-15-compact-stream-first-nonstream-fallback-design.md`

历史 Responses JSON spec/plan 只保留顶部 superseded note，正文保持 2026-07-11 当时事实，不与当前合同混写。

## Phase 0：冻结基线

### Checklist

- [x] 确认目标路径为 streaming-first，pre-commit terminal failure 后可转 non-stream。
- [x] 确认 ZCode 变更前 compact 入口直接调用 `generateText()`。
- [x] 区分逻辑 compact attempt 与 provider 物理 SSE/HTTP request。
- [x] 明确 cache-sharing fork 与 transport fallback 是两个独立概念，本次不实现前者。

### 验收

```bash
git status --short --branch
```

## Phase 1：Spec-first 与会话 E2E 合同

### 文件

- 新建当前 spec 与本 plan；
- 更新：
  - `docs/conversation-session-case-catalog.md`
  - `docs/conversation-session-ui-testid-contract.md`
  - `docs/superpowers/plans/2026-07-11-openai-responses-nonstream-json-compat.md`
  - `docs/superpowers/specs/2026-07-11-openai-responses-nonstream-json-compat-design.md`
  - `docs/testing/conversation-session-e2e-coverage-matrix.md`
  - `docs/testing/conversation-session-decision-e2e-roadmap.md`
  - `docs/testing/conversation-session-decision-workflow-board.md`
  - `docs/testing/conversation-session-compact-decision-worksheet.md`
  - `docs/testing/conversation-session-e2e-plan.md`
  - `docs/testing/conversation-session-environment-fault-catalog.md`
  - `docs/testing/conversation-session-fault-e2e-coverage-matrix.md`

### Checklist

- [x] 将 compact 请求计数表述拆成“逻辑 attempt / 物理 transport legs”。
- [x] F08 登记 stream success 与 stream failure → HTTP success 两条代表路径。
- [x] F09/C01 只更新 transport 前提，不改产品失败终态。
- [x] 记录剪枝：不做 provider × trigger × error 的笛卡尔展开。
- [x] 保留 P32 cache-sharing/direct-summarizer 为 postponed。
- [x] 历史 Responses 文档只加 superseded note，不重写历史正文。

### 验收

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --json
```

若被仓库既有 catalog/generated-doc backlog 阻塞，记录原始错误，并确认本次新增 case 无新审计错误。

## Phase 2：Core compact transport helper

### 文件

- `apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- `apps/zcode-cli/packages/core/tests/compact-summary-model-request.test.ts`
- `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`
- `apps/zcode-cli/packages/core/tests/media-budget.test.ts`

### Checklist

- [x] compact request 只构造一次，stream 与 fallback 复用相同语义输入。
- [x] 隐藏聚合只提交经过 text end 的 text block、tool calls、usage、finish reason 与顶层 provider metadata；reasoning 只保留 delta/commit 状态。
- [x] 不创建或持久化 compact `ModelStreaming`。
- [x] partial delta 可丢弃；有 raw message-block provenance 时先校验同 index block start 与 delta 类型矩阵，再由 provider `content_block_stop` 固化 commit；无该 provenance 时才使用 normalized block end 推断。
- [x] abort、context exceeded、media too large 交回既有专用恢复路径。
- [x] 已有 committed block 或最终 truthy provider stop reason 的正常 finish 交回既有 compact 校验；空 SSE、缺失 response start、无 block 且无 stop reason 必须 fallback。
- [x] fallback 只记录一次低频 warn。
- [x] request setup 可先沿用既有 adapter/API retry，耗尽后只有真实 HTTP 404 进入 fallback；同步
      setup、确定性配置/模型/请求错误与其他 HTTP 4xx/5xx 原样抛出，SSE body logical status 不冒充
      setup status，真实 404 也不被 logical status 覆盖。
- [x] 收敛 collector 状态：用单个可选 finish 结果替代 `finishSeen + 默认 finishReason + 默认 usage`。
- [x] 从必带的 compact request 读取 trace，删除重复参数、冗余 `streamText` 运行时检查与类型 cast。
- [x] 删除 core 层与 adapter malformed-input case 重复的测试。

### 验收

```bash
pnpm --filter @zcode/core exec vitest run \
  tests/compact-summary-model-request.test.ts \
  tests/runtime-compact.test.ts \
  tests/media-budget.test.ts \
  tests/compact-policy.test.ts
```

## Phase 3：Adapter 的 provider-event 与 content-block 双边界

### 文件

- `apps/zcode-cli/packages/contracts/src/model/index.ts`
- `apps/zcode-cli/packages/adapters/src/model/streaming-tool-call-assembler.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`
- `apps/zcode-cli/packages/adapters/tests/runner.test.ts`

### Checklist

- [x] compact 等 input end 才发布 tool call；message-block provider 的 commit 只认 raw `content_block_stop`，普通 main request 保持 eager。
- [x] AI SDK synthetic `start` 前保留既有 SSE retry；compact 内部观察 raw provider event（排除 `ping`），覆盖被 SDK 吞掉的 `message_start`，首个真实 event 后停止 SSE retry 并交给 Core 判断 HTTP fallback。
- [x] 用 iterator 建立状态、真实 response status、fullStream error chunk、event-stream content type 与
      provider boundary 区分 request setup / response body；真实 transport status 优先于 header 与 logical
      status。setup 保留既有 API retry；HTTP 200 SSE protocol/business error 不再做 inner SSE retry，
      只有首 event 前 stale/watchdog 保留，caller cancellation 优先。
- [x] 无 raw provenance 时，compact 的空 text/reasoning block end 也按已完成 block 处理：结束 SSE retry
      且禁止 HTTP fallback；Anthropic Messages raw 路径仍只认对应 `content_block_stop`，普通 main request 行为不变。
- [x] 完整 JSON delta 在真实 end 前断流/EOF 时不合成假 commit。
- [x] adapter 将 raw response start、带 index/type 的 content block start/delta/stop、每次 stop reason 覆盖投影为 compact-only 语义边界；orphan/mismatch 不提交也不回滚既有 commit，后续 `null` 清除先前 truthy 状态，AI SDK 合成 end/finish 不冒充 provider commit。
- [x] invalid raw start/delta/stop 在 Core 观察点立即抛出；统一 iterator cleanup 后不再保留“继续排空”的补丁状态。
- [x] direct provider tool-call 的 name/input 校验失败先固化可证明的 commit 并停止 SSE retry，再传播错误。
- [x] compact opt-in 的手工 iterator 在所有非自然 EOF 路径统一 abort 本次物理 attempt、best-effort
      `return()` 并在 consumer 提前关闭时补齐 cancelled 终态，不为 direct tool/retry/error 分别堆清理
      分支；普通 main consumer close 保持既有生命周期。
- [x] clean finish 不提交未 text-end 的 pending delta；完成 block 后的未闭合尾块不会污染 summary。
- [x] committed malformed input 不让 normalization error 抢先触发 HTTP 重放。
- [x] 将 `"eager" | "input-end"` 策略枚举收窄为单向
      `preserveProviderStreamBoundaries?: boolean`，统一表达首个 provider event、content commit 与 tool input end provenance。
- [x] 将 assembler 收敛为统一 flush：main 保留 best-effort 收尾，compact 的 finish/EOF 均不补造未闭合工具块。
- [x] adapter case 按 retry boundary、provider provenance、tool-call commit 三组合同组织，只抽取重复 runtime 脚手架，不绑定易过期的用例数量。

### 验收

```bash
pnpm --filter @zcode/adapters exec vitest run \
  tests/runner.test.ts \
  tests/runner-retry.test.ts \
  tests/openai-responses-json-compat.test.ts
```

## Phase 4：测试 fake 与 Desktop fixture 收敛

### 文件

- `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-plan-file-compact-continuity.json`
- `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-v4-compact.json`
- `packages/desktop/test/e2e/fixtures/upstream/provider-basic.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-background.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-compact-interrupted.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-compact-manual-queue.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-edit.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-goal-interruptions.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-plan-file-compact-continuity.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-compact.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-edit.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-rewind-compact-extended.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-v4-rewind-queue-background.json`

### Checklist

- [x] 删除 runtime test fake 中无来源的合成 `text_end`；失败按真实 pre-commit error 透传。
- [x] 将 helper 重命名为 `withStreamTextFromGenerateText`，明确它只迁移旧成功 fake。
- [x] “同一 fallback 请求”按语义 `toEqual`，不绑定对象身份。
- [x] 19 个既有 compact success fixture 改用 replay server 的 `response.text` SSE 生成器。
- [x] success fixture 显式匹配 `"stream":true`。
- [x] 新 fallback case 的 404 与 non-stream JSON raw body 保留，不能被 shorthand 吞掉 transport 证据。
- [x] 不新增 provider/trigger 笛卡尔 E2E。

### 验收

```bash
pnpm --dir packages/desktop e2e:fixture:check -- \
  --spec ./test/e2e/conversation-session/context/conversation-session-compact-stream-fallback.test.ts

pnpm --dir packages/desktop typecheck:e2e
```

## Phase 5：Provider 与 Desktop 代表路径

### 文件

- `apps/zcode-cli/e2e/compact-microcompact/README.md`
- `apps/zcode-cli/e2e/compact-microcompact/case-openai-responses-compact.mjs`
- `packages/desktop/test/e2e/conversation-session/context/conversation-session-compact-stream-fallback.test.ts`
- `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-compact-stream-fallback.json`
- `packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-compact-stream-fallback.json`

### Scripted Responses

```text
setup main stream success
→ compact stream:true / deterministic 404
→ compact non-stream / missing-field JSON success
→ post-compact main stream success with summary
```

- [x] 两条 main request 分别按 marker 直接断言 `stream:true`。
- [x] compact 恰有 stream → non-stream 两腿，语义输入一致。
- [x] 一个 compact `ModelRequest`、一个 `ModelComplete`、零 compact `ModelStreaming`。
- [x] post-compact request 带 fallback summary marker。

### Desktop SF

- [x] case catalog 与 coverage matrix 先登记 `SF`。
- [x] case-local fixture 显式匹配 stream 首腿与 non-stream fallback 腿。
- [x] 正式 spec 断言两次 provider 请求、最后一腿 2xx non-stream、最终 marker success。
- [x] 既有 v4 compact 继续证明正常 stream success。

### 验收

```bash
pnpm --dir apps/zcode-cli build
pnpm --filter zcode-cli exec tsx \
  ../../apps/zcode-cli/e2e/compact-microcompact/run.mjs \
  --case=openai-responses-compact --keep-tmp

pnpm --dir packages/desktop test:e2e:serial -- \
  --spec ./test/e2e/conversation-session/context/conversation-session-compact-stream-fallback.test.ts
```

## Phase 6：全量回归与机械 Gate

### Checklist

- [x] Core/Adapter 目标测试全部通过。
- [x] CLI typecheck 20/20、build 13/13。
- [x] Desktop fixture check、`typecheck:e2e` 与 compact 正式回归通过。
- [x] Root `pnpm typecheck` 通过。
- [x] Root `pnpm lint` 0 error；既有 warning 原样记录。
- [x] CLI 全量 lint 若仍被既有 `max-lines` 债务阻塞，记录边界并验证本次目标文件无新增 error。
- [x] `git diff --check` 通过。
- [x] 最终 diff 只包含 compact transport、必要 spec/E2E 与本轮收敛式重构。

### 命令

```bash
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli build
pnpm --dir apps/zcode-cli lint

pnpm --dir packages/desktop typecheck:e2e
pnpm typecheck
pnpm lint

git diff --check
git status --short
```

## Phase 7：交付

### Checklist

- [x] 汇总生产代码收敛点、保留的安全边界与删除的测试/fixture 噪声。
- [x] 报告实际测试结果，不复述过期 artifact 路径。
- [x] 不自动 stage、commit 或 push。
- [x] 只有用户后续明确要求提交时，才按最终 `git diff --name-only` 精确 stage，并使用 Conventional Commit。

### 已记录的后续测试迁移

本轮实际迁移文件：

- `packages/desktop/test/e2e/helpers/v4-conversation.ts`
- `packages/desktop/test/e2e/conversation-session/models/conversation-session-model-switch-auto-compact.test.ts`

本轮文档更新确认以下 `manual-review/pending` spec 仍固定断言 non-stream；在后续代码轮次完成
stream-first 断言迁移和复跑前，不把它们计入 transport 覆盖或转正准入：

- [ ] `conversation-session-compact.test.ts`
- [x] `conversation-session-model-switch-auto-compact.test.ts`：已迁移 V4 helper 与 streaming success
      断言；实跑 N06 健康 no-op 通过，N05 confirm/cancel 在 compact 请求前因缺少 guard 弹窗失败，作为
      产品语义 failing probe 保留。
- [ ] `conversation-session-model-switch-compact.test.ts`

这些迁移不改变当前生产实现或正式 SF/v4 compact 证据，只修复 pending case 自身的过期测试合同；
N05 的产品缺口不在本次 stream-first 改动范围内，不顺手实现或放宽预期。

## 稳定验收口径

| 层级      | 必须证明                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Core      | stream success；空 SSE/orphan/eligible body failure/HTTP 404 setup fallback；其他 setup、post-commit、abort/context/media 不 fallback；隐藏流不落 session |
| Adapter   | compact 观察 raw 非 ping event并投影 response-start/block-start-stop/stop-reason；以硬 transport status 区分 setup/body error；setup 保留既有 API retry，inner stream 仅 pre-event stale/watchdog retry 且 cancellation 优先；direct tool 校验先 commit；main eager 不变 |
| Responses | `stream:true / failure → non-stream / success`，缺字段 JSON 继续兼容                                                         |
| Desktop   | 正常 stream compact 与 fallback compact 都到 success marker，模型选择/主请求不回归                                           |
| Static    | core/adapters tests、CLI/root typecheck、root lint、fixture/typecheck:e2e、diff check                                        |

完成定义：只实现 compact stream-first → non-stream fallback；没有引入 cache-sharing fork、通用 transport
策略框架、主请求 fallback、UI/protocol 状态或额外 retry 能力。
