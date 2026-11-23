# 03 — Bot 群聊：下一轮回复带上了上一轮的流式文本

Status: done

## 现象

`session-control/conversation-session-bot-continuous-worker.test.ts` 的「promotes a group queue item…」：第二条 delivery（回复 `om_queued`）文本是 `E2E_GROUP_RUNNING E2E_GROUP_FINISHEDE2E_GROUP_QUEUED_DONE`，包含第一轮的文本，两段之间没有分隔符。

## 静态分析（未经运行时日志确认）

`packages/services/src/bots/botsService.ts`：

- 群聊路径在 `task_run_started`（`:5571-5584`）只重置 `assistantParts` 和 `assistantReplyBuffer`，不重置 `streamingCardBlocks`、`streamingCardHandle`、`streamingCardStatus`。
- 持久私聊路径（`:5449-5456`）会重置这些字段。
- `task_complete` 对卡片路径只设 `status="completed"` 后 return（`:5877-5879`），也不清 blocks。

## 处理方向（未定）

先带日志复现，确认第二轮复用了上一轮的卡片状态；再让群聊路径与私聊路径的重置规则一致。

同一 spec 的「delivers an IM turn and a later desktop turn…」超时原因未定位，需要失败时 dump `platform.requests` 与 Bot stream 事件。

## 来源

mac conversation job `ci-conversation-341152-1138993`（ff3ecc47）的失败分诊。

## Comments

### 运行时证据（mac 重跑 rerun1，worker 0-41）

- 失败信息（`mac 测试机 `triage-rerun1` artifact 的 failures/0-41/e2a18e15cd27f676/attempt-0/case.json`）里 Bot 群状态的 deliveries 有两条 `sent`：
  - `om_running` 那条 `text = "E2E_GROUP_RUNNING E2E_GROUP_FINISHED"`；
  - `om_queued` 那条 `text = "E2E_GROUP_RUNNING E2E_GROUP_FINISHEDE2E_GROUP_QUEUED_DONE"`，包含第一轮全文，两段之间无分隔符。
    这与「群聊 `task_run_started` 没有重置 `streamingCardBlocks`」的静态分析一致：`appendStreamingCardMessageChunk` 会把相邻 message 块直接拼接（`botsService.ts` 5175-5195），无分隔符正是拼接的结果。
- 重新核对代码：群聊 `task_run_started` 分支（约 5560-5575）只重置 `assistantParts`、`assistantReplyBuffer` 等；`streamingCardBlocks.length = 0` 只出现在 `sealStreamingCardReply`（5381）和持久私聊的 `task_run_started`（5451），群聊路径不经过这两处。
- 注意：两条 delivery 的 `providerMessageId` 都是 `om_e2e_card`，这是夹具 `createRecordingFeishuFetch` 对所有 `/im/v1/messages` 固定返回的 id，不能作为「复用了同一张卡」的证据。
- 本次日志没有直接打印 Bot 内部变量；结论来自「状态里的文本」加「代码路径」，尚未用日志证明第二轮复用了第一轮的 `streamingCardHandle`。分类：产品问题（疑似），修复方向仍按「群聊路径与私聊路径的重置规则一致」，需产品确认。

### 同 spec 第二个用例（持久私聊）的运行时事实

- Agent 日志（`failures/0-41/957c57148bca5284/attempt-0/logs/agent/zcode-2026-11-17.jsonl`，UTC）：第一轮 `Turn started 04:12:27.144` / `Turn completed 04:12:27.889`；第二轮 `Turn started 04:12:27.913` / `Turn completed 04:12:28.050`。
- 网络捕获（`network-capture/conversation-session-bot-continuous-worker.json`）：第二轮主请求 `x-zcode-query-source=main_turn` 命中夹具 `private-next` 并返回 200，文本 `E2E_PRIVATE_NEXT_DONE`；其余 500（`Missing Upstream e2e fixture`）全是 `session_title` 标题请求，与投递无关。
- 因此模型和 Agent 侧已完成第二轮；失败在 Bot 平台侧：没有「恰好 1 条」含 `E2E_PRIVATE_NEXT_DONE` 的平台 POST。当前日志里没有 `platform.requests`（测试进程内的假平台），无法区分「Bot 没投递」与「两条 POST 落在同一个 500ms 轮询间隔、计数从 0 直接跳到 2」。
- 该问题的根因见下一节，spec 不需要改。

### 根因更新（运行时证据 + 离线复现）：`turn.started` 被 App 的 strict schema 丢弃

上面两条（群聊文本串轮、私聊第二轮不投递）有同一个上游原因，不是群聊/私聊路径各自的重置规则问题：

- CLI 在 `turn_started` 事件里新增了 `isFirstMessage`（提交 `8172e49580`，`apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:536`，`contracts/.../session.events.ts:518`）。映射层 `mapSessionEventPayload` 对 `turn_started` 原样透传。
- App 侧 `zcodeTurnStartedEventPayloadSchema`（`packages/shared/src/zcode-protocol/index.ts:1615-1646`）是 `.strict()` 且没有声明 `isFirstMessage`。
- 运行时证据：`failures/0-41/957c57148bca5284/attempt-0/logs/agent/zcode-2026-11-17.jsonl` 里 `session_event.sent`（`turn_started`，04:12:27.146 与 04:12:27.915 两轮）的 `payloadKeys` 都含 `isFirstMessage`。
- 离线复现：用仓库里的 `zcodeSessionEventSchema.safeParse` 解析同形事件，不带该键通过；带 `isFirstMessage: true/false` 均失败，`unrecognized_keys: ["isFirstMessage"]`（在 `packages/shared` 下用 tsx 导入 `zcodeSessionEventSchema`，构造 `type: "turn.started"` 的最小事件即可复现）。
- 后果链：`session/event` 校验失败 → `zcodeAgentService.ts:2760-2777` 丢弃整条事件 → `zcodeTaskServiceAdapter.ts:4056` 的 `task_run_started` 不再产生 → Bot 不执行 `task_run_started` 分支里的状态重置。
  - 群聊：第二轮不重置 `assistantParts`/`streamingCardBlocks` 等，delivery 文本串上第一轮（本 issue 的现象）。
  - 持久私聊（按代码路径推断，日志里没有 Bot 内部变量）：第二轮 `resultSourceCommandId` 仍是第一轮的 inputId，后续 chunk/complete 在 `botsService.ts` 的 `resultSourceCommandId !== event.inputId` 判断处被丢弃，所以没有 `E2E_PRIVATE_NEXT_DONE` 的 POST。第一轮能通过是因为此时 `resultRunId` 为空，走 `if (!resultRunId && runId)` 兜底。
- 同一原因还让 App 的 `readAppLiveSummary` 读事件时抛 ZodError（见 plugin-extension-sessions-\* 三个用例），所以三类失败同源。

建议（需产品确认后再改）：在 `zcodeTurnStartedEventPayloadSchema` 增加 `isFirstMessage: z.boolean().optional()`（与历史上同类修复一致），并补一个 CLI 事件与 App strict schema 的契约回归。群聊路径是否仍应补齐重置规则，等上游修复后用原用例重跑再判断。分类：产品问题（协议 schema 漂移），不是测试问题。

### 处理结果（2026-11-17）

- 上游原因有两侧修复，作用不同：
  - 发送侧（当前 CLI）：staging 的 148827e6dc 让旧协议 mapper 移除 `isFirstMessage`，当前 CLI 不再发送它（`docs/zcode-protocol.md`「兼容回合开始事件」，回归 `session-mapper-legacy-strip.test.ts`）。
  - 接收侧（兼容旧发送方）：本 MR 在 `zcodeTurnStartedEventPayloadSchema` 声明可选的 `isFirstMessage`，让 8172e49580~148827e6dc 之间的旧 CLI（例如远端设备上的旧版本）发来的 `turn.started` 不被整条丢弃；回归在 `session-mapper-turn-payload.test.ts` 中绕过 mapper 直接解析线协议事件。
- `Required<TurnStartedPayloadBase>` 用例另行守护：CLI 新增其他字段时先编译失败，提醒同步 App schema。
- mac 测试机 `triage-verify2`：`conversation-session-bot-continuous-worker.test.ts` 两个用例都通过，群聊不再串轮。`task_run_started` 恢复后，群聊路径的现有重置已足够，不需要再改 `botsService.ts`。
