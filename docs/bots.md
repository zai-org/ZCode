# Bots

Bots lets a private third-party chat drive the same ZCode task flow as the UI input box. The v2 model removes the old nested allowed-users shape: each `bot` is a complete access instance with provider, credentials, one bound actor, workspace scope, command policy, current options, and reply mode.

## Files

- `bot-config.v3.json`: persistent bot configuration. The top-level shape is `{ "version": 3, "bots": [] }`.
- `bot-state.v3.json`: current runtime state keyed by bot id. It stores active workspace, draft/task mode, active task, pending permissions, Telegram offset, and update time.
- `bot-config.json` / `bot-state.v2.json` / `bot-state.json`: one-time upgrade inputs, retained unchanged for rollback.
- Old `bots-model-cache*.json` files are no longer read or written. Model choices come from the owning Environment's Model Selection Service.

Secrets still live in `CredentialService`; config files only store refs such as `credentialRef` and `webhookSecretRef`.

Workspace isolation uses:

```ts
workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

Path execution and display continue to use `workspacePath`.

Remote workspace execution is guarded by an injectable runtime connector. A disconnected remote workspace never reconnects as a side effect of a plain message, task command, config command, or permission response. Those commands return a stable "remote disconnected" reply and do not execute. Only `/reconnect` / `/重连` asks the runtime connector to reconnect the selected remote workspace. This prevents a remote bot message from silently falling back to a local workspace with the same path or unexpectedly opening a remote runtime.

## Bot Config

Each bot contains:

- `id`, `name`, `provider`, `enabled`
- Provider credentials and provider-specific fields such as `credentialRef`, `webhookUrl`, `feishuAppId`
- A single bound actor: `providerUserId` and `displayName`
- `allowedWorkspaces`, where `["*"]` allows every known workspace
- `allowedCommands`: `status`, `new`, `workspace`, `model`, `mode`, `thoughtLevel`, `sandboxMode`, `approvalPolicy`, `reply`
- `currentOptions`: `modelSelection`, `mode`, `sandboxMode`, `approvalPolicy`; reasoning is stored in `modelSelection.options.reasoningLevel`.
- `replyMode`: `assistant_changes`, `assistant_toolcalls_changes`, `summary_changes`, or `streaming_card`. Feishu / Lark only support `streaming_card`; old Feishu / Lark configs with another value are normalized back to `streaming_card`. Every other provider only supports the three non-card granularities; `streaming_card` is excluded from Settings and `/reply`, and copied or legacy values are normalized to `assistant_changes`.

## Feishu / Lark SDK loading

The shared Feishu/Lark provider loads `@larksuiteoapi/node-sdk` only when starting a
WebSocket connection with a valid App ID and available credentials. Importing the
provider, constructing adapters, rendering cards, and using the existing HTTP
request paths must not load the SDK. Node's module cache owns the loaded module;
the provider does not maintain a second SDK cache or promise lifecycle.

```text
channel runtime starts connection
  → validate App ID and load credentials
  → check cancellation → import SDK → check cancellation
  → construct SDK client → existing ready/reconnect/close lifecycle
```

If cancellation arrives while the module is loading, startup rejects without
constructing a client. Feishu and Lark retain their respective domains and share
the same loading path. Closing a connection releases its existing resources but
does not promise to unload the SDK module. This changes loading cost only; Bot,
desktop continuous, and mobile replayable routing remain unchanged.

Acceptance: provider-only and HTTP/card operations do not evaluate the SDK;
the first valid connection loads it; invalid credentials and pre-cancelled
startup do not load it; cancellation during loading never starts a late client;
both domains and the existing ready/reconnect/timeout/close paths still work.

## Binding

`/bind <code>` binds a private actor to a specific bot id. Rebinding overwrites that bot's `providerUserId` and `displayName`; it does not append another user. Unbound bots only accept `/bind`; ordinary messages and other commands are ignored or rejected.

At runtime, authorization resolves exactly one enabled bot by:

```ts
provider + providerUserId;
```

Feishu/Lark ordinary groups and dedicated topic groups support explicitly enabled collaborative sessions. Topics bind independent tasks; only @ mentions trigger work, and `/history on` opts a group into incremental topic background. Other providers retain their existing behavior. See
[Feishu group collaboration](bots-feishu-group-collaboration.md) for the normative
group authorization, input, queue, delivery and lifecycle contract.

## Settings UI

The Bots dialog right pane follows the same row structure as Settings General: each setting is a full-width row with the label and description on the left, and the input, select, or button group on the right. Provider setup, allowed workspaces, identity, and reply mode all reuse the shared settings row components so control height and spacing stay consistent. Reply mode shows a dynamic subtitle that explains the currently selected granularity: standard replies focus on assistant text and file changes, full replies include tool-call progress, summary replies only send the final result plus change summary, and streaming card replies update one Feishu / Lark card in place. A Feishu / Lark task using streaming-card replies keeps ordinary Agent output independent from blocking interactions. AskUserQuestion, permission, and Plan approval use one current interaction message. Before an interaction is shown, the current streaming card is sealed: its accumulated content remains visible, its running status is removed, and later Agent output must create a new streaming card. Question progress only replaces the current interaction message and never copies the question, answers, or plan back into either streaming card. A pending AskUserQuestion card lists only previously submitted questions and their answers, followed by a divider and the current unanswered question; draft selections for the current question stay in its controls instead of appearing as answered history. The completed card lists every submitted question and answer. For a Feishu/Lark WebSocket card action, BotService first advances the authoritative interaction state and returns the complete outbound message to the transport. The action handler synchronously renders that exact message as `card.raw`, including accumulated answers, the current question, controls, and the new question token. That synchronous response is the only card write for the click: it does not also call `card_update_token`, PATCH the message, synthesize a card from `zcodeCardText`, send a replacement message, or recall the original. Resolving or cancelling the interaction returns the same card as a button-free, read-only result and retains it in chat. Task termination also retains the last interaction card as a read-only terminal result. Feishu and Lark only show streaming card in this selector because their high-quality bot reply path depends on Card JSON 2.0 updates. Telegram, Weixin, webhook, and all other providers only show standard, full, and summary replies; they never expose streaming card. Feishu and Lark channel names in the Bots dialog and Mobile Remote Control bot-channel cards show the same compact region tags as Welcome Screen: Feishu uses BigModel's `中国` / `CN` tag, and Lark uses Z.AI's `全球` / `Global` tag. These tags are display-only and do not affect provider routing.

Provider setup intentionally hides stored secret values. Telegram shows a fixed BotFather QR code alongside the token input before a secret is saved; after saving it automatically advances to the private-chat bind code until the bot is connected. Feishu / Lark start with QR authorization for app credentials, then automatically show the private-chat bind code. Weixin starts with QR login; successful QR login saves the bot token and clears the QR detail panel. Because Weixin QR login returns bot credentials rather than the scanning user's deliverable chat id, the user must send any first message in Weixin to activate the chat. That first activation message receives a welcome/help reply and is not sent to ZCode task flow as a prompt.

Webhook setup is available from the new bot provider list and provider settings surface. Feishu and Lark are both first-class new bot entries. They share the same provider implementation and registration flow, but the selected provider id must be preserved because it chooses the OpenAPI domain (`open.feishu.cn` for Feishu, `open.larksuite.com` for Lark). DingTalk is shown there only as a coming-soon channel.

## Commands

- `/status`: reports current workspace, model, task, and runtime state. Custom model providers are shown with their display name, for example `My Provider/my-model`, instead of the internal provider id.
- `/new` / `/clear`: clears the active task in `bot-state.v3.json` and returns to draft.
- `/project` / `/workspace` / `/项目`: lists allowed workspaces. Selecting one updates the resolved workspace fields in `bot-state.v3.json`.
- `/reconnect` / `/重连`: reconnects the currently selected remote workspace. This is the only command with remote connection side effects.
- `/model`: lists and updates `currentOptions.model`. The provider/model choices are built from
  target Environment's `ModelSelectionService.getView()` on every menu open. Local workspaces read
  the Local Environment View; remote workspaces read the Remote Environment View. `/model` keeps a
  two-level provider -> model flow; it must not synthesize a provider from the active CLI name,
  deserialize a Provider Registry snapshot, or render directly from persisted Bot caches. Provider
  and model callbacks carry the real Registry identity. A callback from an expired card is rejected
  and asks the user to reopen `/model`. `bots-model-cache.v2.json` stores workspace config options
  only; Provider/Model configuration and credentials are not persisted by the Bot service.
  A successful empty Selection View clears the in-memory Bot provider menu. Only an actual read
  failure may reuse the last in-memory View; an empty View must not keep deleted or disabled models
  selectable.
- `/mode` / `/模式`: lists and updates `currentOptions.mode`. This is the same ZCode task mode surface used by the UI composer; provider internals own any sandbox or approval mapping.
- `/think` / `/thoughtLevel` / `/思考`: lists and updates `currentOptions.thoughtLevel`.
- `/cli`: lists and updates `currentOptions.cli`.
- `/reply` / `/回复`: lists and updates `replyMode`.
- `/stop` / `/停止`: stops the active task generation.

Configuration commands write to `bot-config.v3.json`, so the next third-party message immediately uses the updated options. Runtime flow such as active task, pending permissions, and Telegram offset writes only to `bot-state.v3.json`.

Plain messages behave like the UI input:

- In draft mode, or when no active task exists, the message creates a new ZCode task and becomes the first prompt.
- Draft model selection invalidates the previously inherited thought level. When the first message creates a task, mode and thought-level validation uses that task's model-specific config options rather than the workspace's previous-model snapshot. Unsupported inherited values are skipped. If initial configuration still fails, the provisional task is deleted before Bot state leaves draft mode, so switching model providers cannot strand an empty active task.
- In task mode, the message is sent to the active task.
- Before an ordinary message reuses an active task, query the selected workspace's deleted-task tombstones through its task service (including `workspaceIdentity`). A confirmed deleted task returns the Bot to draft, clears pending permissions/questions/selections, and creates a fresh task for this same message. A task missing from a filtered list, or only archived/pinned, is not evidence of deletion; read failures must not trigger creation.
- Once the replacement is created and bound, send one localized notice: “原任务已删除，已为你新建任务。本条消息将在新任务中处理，不会继承原任务的对话上下文。” Then process the original message exactly once. Notice delivery is best effort: log failures without releasing the inbound deduplication claim or rerunning the model. Record the old/new task IDs in the host log, and use the existing created/prompt broadcasts for Desktop visibility. New-task configuration failure keeps draft state and must not claim a replacement succeeded.
- This recovery applies to ordinary messages only. Old permission/card callbacks retain their expired-session behavior. It does not reconnect remote workspaces or alter Desktop continuous / mobile replayable delivery boundaries.
- Todo103 integration: replacement creation must reuse the current draft initialization and public Model Selection View, then freeze that effective selection across V4 create/configure/first send. Do not restore the staging model/thoughtLevel fields or a second Bot-owned bound selection. A non-deleted bound Session continues to follow Todo99's Session-persisted selection for its next idle input.

```text
ordinary message -> authorized workspace task service -> deleted-task tombstone?
  no  -> existing task flow
  yes -> draft (clear old interaction state) -> create/configure/bind replacement
      -> created broadcast -> one best-effort notice -> original prompt once
```

- If the active task is running, the message is rejected until the task is ready or `/new` is used.
- If the selected workspace is remote and disconnected, the message is rejected and tells the user to send `/reconnect` first. The original message is not replayed after reconnect.

## Scheduled-task result delivery

When a Feishu, Lark, or Weixin Bot turn creates an automation through `CronCreate`, the Host records a private delivery target together with the automation definition. The delivery target contains only the provider, Bot id, stable chat target, and private/group chat kind. It never contains the inbound message id or temporary provider context token, because those values belong to the creation message and are not valid routing identifiers for a future run.

The delivery target is trusted turn metadata injected by `BotsService`; it is not part of the model-visible `CronCreate` arguments and the model cannot choose another Bot or chat. A normal desktop/mobile UI turn does not inject this metadata and therefore does not acquire Bot delivery as a side effect.

```text
Feishu / Weixin inbound message
  -> BotsService injects trusted delivery target into this prompt turn
  -> CronCreate reads the active turn target
  -> automation/create persists definition + delivery target

Scheduler claims a run
  -> Host restores/creates the target task
  -> BotsService subscribes with bot-channel-continuous
  -> Host sends the automation prompt
  -> task_complete / task_error
  -> final result or failure is sent to the original Bot chat
```

Delivery semantics:

- Scheduled and manual runs of a Bot-origin automation both deliver their terminal result to the original chat.
- The scheduler registers the Bot subscription before sending the prompt, so a fast terminal event cannot beat the listener.
- The Agent `turn.started` event must preserve the Host-admitted `automationId` across the strict App protocol boundary. The services projection must emit `task_run_started` before that run's chunks or terminal event; a reused private subscription uses this start event to replace the previous input id and clear per-run buffers.
- Automation delivery uses `summary_changes`: intermediate assistant chunks and tool traces do not create extra chat messages; completion sends the final assistant result plus change summary, and failure sends one localized failure message.
- The persisted target survives application restart. Workspace isolation still uses `workspaceIdentity?.trim() || workspacePath`; filesystem execution continues to use `workspacePath`.
- If the Bot was deleted, disabled, changed provider, lost credentials, or the provider send fails, the service records a throttled warning and leaves automation dispatch/outcome settlement untouched. Bot delivery is best-effort and is not a scheduler retry authority.
- This path keeps the existing `bot-channel-continuous` stream. It does not create a second Agent runtime and does not reuse or weaken mobile `web-remote-replayable` snapshot/gap recovery.

## AskUserQuestion / Elicitation

ZCode Agent AskUserQuestion is bridged through ZCode Protocol elicitation request/response events. Bot runtime stores the pending request in `bot-state.v3.json` with task id, request id, run id, normalized questions, current question index, and collected answers. The response payload matches the UI shape:

```json
{
  "answers": { "Pick a path?": "Fast" },
  "answer_0": "Fast",
  "answer": "Fast"
}
```

`ExitPlanMode` uses the same response mechanism with a dedicated presentation on every channel. Feishu / Lark render the complete plan in a card, followed by a native divider, the localized review prompt (`请审阅此实施计划。` / `Review this implementation plan.`), and the localized approval and custom-answer buttons. Telegram renders the same content as message text with native inline buttons. Weixin renders it as numbered plain text, and webhook includes both the complete text and structured elicitation schema. Plan approval does not render the generic `提问` / `Plan` headings or a separate approval-description line. Only the `plan` field is projected into the Bot elicitation schema; arbitrary permission input is not exposed, and the desktop approval dialog keeps its independent presentation boundary.

The live protocol request carries metadata in `schema` and the plan body separately in `input`. The service projection must merge only `input.plan` into a `schema.interaction === "plan_approval"` elicitation. A generic `schema ?? input` choice drops the plan whenever metadata is present and causes Feishu / Lark to fall back to the incorrect `Question / Plan` card.

Plan approval rendering metadata is part of the persisted pending elicitation state. Every in-place card update, including custom-answer expansion, form validation, restart recovery, approval, and cancellation, reconstructs the same restricted `{ interaction: "plan_approval", plan }` schema from that state. Raw permission input is never persisted as Bot render metadata.

Provider interaction:

- Telegram uses inline buttons. Single-select answers submit immediately; multi-select answers toggle options and use `Done` to submit. Callback data only carries short numeric indexes. When interactive text exceeds Telegram's single-message limit, the inline keyboard is attached to the final chunk containing the decision prompt, never an earlier context chunk.
- Feishu / Lark use one Card JSON 2.0 interactive card for the whole AskUserQuestion lifecycle. The current question is rendered as flat choices instead of dropdowns. Single-select questions use radio-style rows: clicking a preset answer submits it immediately, while clicking `自定义回答` only updates the original card and expands the bottom custom input with submit/cancel controls. Multi-select questions use checkbox-style rows: clicking a preset answer toggles the draft and refreshes the original card, while clicking `自定义回答` toggles the custom input; users submit all checked answers with the form submit button. Submitting the form sends `/elicitation <token> __form__:<payload>` back through the normal callback path, so stale cards are rejected by the same token check as choice callbacks. For multi-select questions, non-empty custom input is appended to the selected checkbox choices. The top `<answers>` section renders completed answers as h4 markdown titles, such as `#### 1/2 Question`, followed by answer text. Answer blocks are separated only by spacing. If a pending card already has answers, a native Card JSON 2.0 `hr` divider separates `<answers>` from the current `#### 提问` area. When all questions are answered, the same card is updated to a final state with the complete answers only: no form, no buttons, and no extra completion copy.
- Weixin uses numbered plain text. Users reply with a number for single-select, comma-separated numbers or text for multi-select/custom answers, and `0` cancels.
- Webhook sends structured outbound messages with `type: "zcode.bot.elicitation_request"` and an `elicitation` object containing `requestId`, `taskId`, `runId`, `currentQuestionIndex`, `questions`, and optional `schema`.
- Webhook can respond with:

```json
{
  "type": "zcode.bot.elicitation_response",
  "botId": "webhook-1",
  "userId": "user-1",
  "requestId": "elicit-1",
  "action": "accept",
  "content": {
    "answer": "Fast"
  }
}
```

Discord and WeCom remain reserved providers. Future Discord support should use select menus and modals; future WeCom support should prefer card buttons and fall back to the Weixin numbered-text flow.

## Attachments

Bots accept inbound attachments from every implemented provider. Provider adapters parse native media payloads into a common bot attachment shape; the service downloads or decodes the bytes, stores them under the ZCode app data directory in `bot-attachments/`, and never writes them into the user workspace.

Feishu/Lark rich-text (`post`) messages include files from the top-level `files` array as well as inline images. Text and files in the same message must reach the same task input; each file keeps its provider file key and filename and uses the message resource download path, just like a standalone `file` message.

Attachment handling follows the ZCode prompt capability model:

- Images become `ZCodePromptAttachment` entries with `kind: "image"` and are sent as ZCode image content when the active Agent supports image prompts.
- Audio becomes `ZCodePromptAttachment` entries with `kind: "audio"` and is sent as ZCode audio content when the active Agent supports audio prompts.
- Video and generic files are cached locally and appended to the prompt as file context with filename, MIME type, size, and local cache path.
- A message can include up to 4 attachments. The common Bot service does not impose a per-attachment byte limit; successfully downloaded attachments proceed through the existing cache and task submission path. Provider download failures and downstream attachment capability checks still apply.
- If the user sends attachments without text, the bot uses the default prompt: `请查看附件并根据内容协助我。`

## Providers

Bot user-facing text follows the current app locale from settings. Service-layer replies are formatted through the shared bot message catalog before they reach providers. Provider adapters must not introduce new hard-coded user-facing labels when rendering native UI such as buttons, card placeholders, Card JSON 2.0 status text, or text-only selection hints; those labels must either be preformatted by the service or receive the outbound message locale. Feishu / Lark Card JSON 2.0 replies therefore carry the locale alongside the outbound message or streaming-card state so provider-owned controls, AskUserQuestion forms, and streaming status lines stay in the same language as the rest of the bot reply. Protocol command names such as `/status`, `/workspace`, callback payloads, and provider API error diagnostics remain stable English identifiers.

The existing provider adapters are reused:

- Telegram: host-side long polling; offset is persisted in `bot-state.v3.json` under the bot id. Photo, document, video, audio, and voice messages are parsed as attachments and downloaded with `getFile`.
- Weixin / 微信: built-in iLink client based on the Tencent openclaw-weixin protocol reference. ZCode starts QR login through `/ilink/bot/get_bot_qrcode`, saves the returned `bot_token` as the bot credential, long-polls `/ilink/bot/getupdates`, sends text with `/ilink/bot/sendmessage` using the `msg.item_list` payload, normalizes outbound multiline replies to hard text line breaks, fetches `typing_ticket` with `/ilink/bot/getconfig` before `/ilink/bot/sendtyping`, and persists `get_updates_buf` plus first-message activation state in `bot-state.v3.json`. Text and recognizable media items in `item_list` are split into message text and attachments. It does not require running an external openclaw-weixin gateway.
- Webhook: inbound HTTP callback and optional outbound webhook reply.
- Feishu and Lark are separate bot providers that share the same adapter. The provider id selects the OpenAPI domain (`open.feishu.cn` or `open.larksuite.com`), so bot config does not carry a separate `feishuDomain` field. Both use persistent WebSocket events, Card JSON 2.0 interactive card replies, `Typing` message reactions as the transient typing indicator fallback, and OpenAPI resource downloads for image/file/media attachments. The message API still sends `msg_type: "interactive"` with `content` as a JSON string, while the card payload declares `schema: "2.0"` and stores reply markdown/buttons under `body.elements`.

When `replyMode` is `streaming_card`, only Feishu and Lark use the mode-specific rendering. The task stream creates a Card JSON 2.0 message and updates that card as assistant text arrives and tool calls start or finish. A blocking interaction seals the current card and starts a new card segment for any later Agent output; the interaction itself is never part of a streaming-card timeline. The card body is a timeline of ordered blocks rather than one global text area plus one global tool area: assistant chunks append to the current `message` block; the first tool event after text opens a `tools` block; consecutive tool calls stay in the same `tools` block; the next assistant chunk opens a new `message` block. Tool calls are never expanded into raw inputs, outputs, stdout, stderr, JSON, or trace fields; they are summarized with the same compact summary formatter used by bot tool-call replies. Each contiguous tool run is rendered inside one tool-summary collapsible container so the card reads as `message`, `tool summaries`, `message`, `tool summaries`, `message` without becoming separate chat messages. The container uses the Card JSON 2.0 `collapsible_panel` as the `<tools>` shell: header shows `🛠️ Tool summaries (n)` with a right-side expand arrow, content holds the compact bullet list, and the panel carries a neutral background plus grey border for light and dark client themes. The latest tool block is expanded while its card segment is running; old tool blocks, sealed segments, and terminal cards are collapsed. Other providers keep their existing reply-mode behavior if they receive this value from old or copied config.

```text
Agent output A -> streaming card A (running)
                         |
                         +-- AskUserQuestion / permission / Plan
                               |
                               +-> card A (sealed, retained)
                               +-> interaction card (active)
                                      |
                                      +-> question progress: update the same message_id only
                                      +-> resolved/cancelled/terminated: read-only, retained
                               |
                               +-> later Agent output -> streaming card B (running)
```

Streaming-card provider failures follow the turn-local backoff and circuit-breaker
contract in [Feishu Streaming Card Reliability](./bots-feishu-streaming-card-reliability.md).
Forced tool or terminal updates cannot bypass this recovery boundary, and production
logs identify the task event that triggered each failed write or opened the
circuit.

Feishu / Lark does not expose a native bot typing-state API. The provider reads the inbound `message_id`, adds a `Typing` reaction while the ZCode task is running, and removes the reaction when the task completes, errors, stops, or waits on a permission request. If the callback payload lacks `message_id`, typing is skipped instead of sending a misleading chat-level signal.

Webhook inbound requests continue through:

```text
POST /api/bots/webhook
```

The service, RPC service, HTTP route, persisted data, and UI all use the Bots naming.

### Feishu reply delivery diagnostics (ZCT-2096089929570893824)

- Only private inbound messages may create or advance tasks; group messages retain the existing private-chat-only response. Private delivery uses `open_id`; no speculative `chat_id` fallback or new retries.
- Message create/update failures retain HTTP status, business `code`, `msg`, and `log_id` (response body first, response header fallback). Creation diagnostics include receive ID type, never credentials or message content.
- `BotRuntimeInfo.deliveryError` tracks the latest failed Feishu/Lark message write independently of connection status. A successful message write clears it; a WebSocket reconnect does not. This state is volatile and shown in Bot settings with a localized delivery-failed label and diagnostic detail. While the dialog is open, status refreshes serially every two seconds after the preceding read completes; closing it cancels further polling and ignores late results.
- Existing bounded streaming retry/circuit and task completion behavior remain unchanged. This change improves diagnosis; it does not claim to resolve the upstream rejection.
- Bot streams remain `bot-channel-continuous`; desktop `desktop-continuous` and mobile `web-remote-replayable` boundaries and workspace routing do not change.

```text
message write -> failure -> deliveryError -> Bot settings
              -> success -> clear deliveryError
WebSocket status ------------------------> connection status (independent)
```

References: [send](https://open.feishu.cn/document/server-docs/im-v1/message/create.md), [reply](https://open.feishu.cn/document/server-docs/im-v1/message/reply.md). Official send documentation recommends open_id for user recipients; no documented resolution for this ticket's error text was found.

## Provider 重构升级与回滚

当前配置、状态内容版本均为 3。对应 v3 文件不存在时，Repository 单向导入旧
`bot-config.json`、`bot-state.v2.json`（更早状态为 `bot-state.json`），立即写入 v3。
旧文件仅为回滚保留，不修改、不删除、不持续双写。v3 存在后只读新字段，解析或 IO 错误
直接暴露，不偷偷退回旧文件。旧模型按 Todo 72 的明确身份转换；无法确定时留空并保留 Bot。
回滚后的旧 App 看到升级前 Bot 快照，不承诺看到新版新增、删除或修改的 Bot。

## R3 remote identity resolution（A3，2026-09-16）

Bot 的连接检查、显式重连、runtime attachment、工作区列表、上下文及授权匹配必须使用同一 Source stable identity。控制端 `lastWorkspaceSession` 是回退兼容快照，不是 R3 连接目录。

- Window Host 注入窄 resolver，使用 `SourceServerDirectory` 与当前 `WindowRemoteConnectionRegistry`。services 层不导入 Desktop 实现。
- stable identity 按 Source 精确匹配；legacy identity 只在已握手 Profile / workspace history 证明唯一映射时转换。禁止仅按 path、别名或相似主机名猜测。
- 在线时优先使用当前窗口已连接的 logical session target，不能因 preferred Profile 改变就误报断线。离线仅 `/reconnect` 使用当前 active Profile 的正式 credential refs；lookup 不解密凭据、不建连接。
- retired/rebound Profile 造成旧 route 对应多个 Source 时拒绝迁移；目标缺失、身份含糊或本窗口无会话时不回落到 Local Host。
- Bot workspace refs、context 与精确 allowedWorkspaces 通过同一解析器按需规范化；不改变 `*` 或本地 path 权限语义。已绑定 taskId、pending interaction 和 draft options 保留。未知 legacy identity 保留并由连接边界拒绝，不靠同路径升级。
- runtime cache 按 stable workspace + 当前 logical session/generation 隔离，旧连接不可复用；同代并发 task/model 获取共用一个 attachment。换代/关闭后的迟到结果释放，不进入新缓存。
- Main 继续执行 window + path + stable identity + target 精确匹配。旧 `lastWorkspaceSession`、凭据 mirror 和 Source canonical storage key 不改写。

```text
Bot legacy / stable ref
  -> owning Window Host resolver（Directory 的已证明映射）
  -> stable workspace ref + current route generation
  -> Main 精确路由 -> 同一 Window Host 的既有 remote scope
  -> 目标 Environment 的 task / model selection
```

修复不改变 Bot/desktop/mobile 各自既有 delivery profile、stream、snapshot、queue 或 Source 登录态，也不扩展 Source Core 自身启动 Bot 的产品范围。验证使用合成 Bot actor/消息与隔离 repo，不向真实聊天平台发送消息。

### Group reply delivery actions (2026-09-07)

Desktop and mobile no longer display the persistent group-sync/shared-workspace
banner above the composer. Group synchronization and source labels remain active.
The composer has no delivery panel. Failed or uncertain deliveries expose a small
localized icon beside the corresponding completed reply timestamp; clicking opens
retry or reconciliation actions without repeating the reply body or sender ID.
Successful and in-flight sends stay hidden. The group activation reply retains its
shared-file disclosure. See the group collaboration spec for per-turn association
and crash-safe delivery projection.

### Group task switching after stop (2026-09-07)

Group switching reads the CLI control phase, queue and pending interactions. Cached
Bot permission/question cards cannot independently block a new draft after stop.
An idle CLI clears stale interaction records before switching; running, queued,
and interaction-blocked states return distinct localized guidance. Disconnected
remote workspaces still require explicit reconnect. Desktop continuous and mobile
replayable boundaries and the single CLI queue remain unchanged.

Group member labels use the current chat member directory. Enable the application
permission `im:chat.members:read` and publish it to show names without requiring
organization-wide contacts access. Missing permission preserves message handling
and shows a short stable member identifier. See the group collaboration spec.
