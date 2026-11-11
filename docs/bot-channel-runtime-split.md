# Bot Channel Runtime Split

Bot channel code is split into two layers:

- `BotsService` owns product semantics: config, binding, authorization, workspace scope, command routing, task creation/resume, permission responses, elicitation responses, reply formatting, broadcasts, and persisted bot state.
- Channel runtime modules own provider event consumption only: Telegram long polling, Weixin long polling, and Feishu/Lark WebSocket lifecycle.

The split keeps provider-specific event loops out of `botsService.ts` while preserving the same `BotInboundMessage` callback pipeline.

## Runtime Modules

- `telegramChannelRuntime.ts`
  - Syncs Telegram commands.
  - Owns Telegram `getUpdates` long polling.
  - Persists each Telegram offset only after the corresponding update returns a successful shared business callback result. A rejected callback or `{ ok: false }` result leaves the update retryable.
  - Uses a runtime lock keyed by bot token so only one host process consumes updates.

- `weixinChannelRuntime.ts`
  - Owns Weixin `getupdates` long polling.
  - Uses a runtime lock keyed by bot token so only one host process consumes and commits each batch.
  - Preserves attachment payloads when forwarding parsed messages back into the common provider callback pipeline.
  - Persists `get_updates_buf` only after every message in the batch returns a successful business callback result. A rejected callback or `{ ok: false }` result leaves the batch retryable.

- `feishuChannelRuntime.ts`
  - Owns Feishu/Lark WebSocket lifecycle.
  - Uses the selected provider id to keep Feishu and Lark domain behavior separate.
  - Uses a runtime lock keyed by provider domain and external App ID so local bot ids or credential references pointing to the same App cannot consume WebSocket events concurrently. The bot id is retained only as owner diagnostics.

## Invariants

- All inbound provider events still enter `processProviderCallback(provider, payload)` before business handling.
- Bot task stream subscriptions continue to use `bot-channel-continuous`; this split must not opt bot channels into mobile replayable recovery semantics.
- Remote workspace execution semantics are unchanged: normal messages do not reconnect remote workspaces, and remote runtime service resolution must not fall back to a local workspace service.
- Runtime status remains written through the shared status sink so `BotsDialog` can show the same provider status messages as before.
- Channel runtime disposal must abort all active polling/WebSocket controllers and await every runtime task before it resolves. The shutdown terminal state includes Provider request/WebSocket completion and cross-process lock release; no callback or cursor write may occur after shutdown resolves.
- A runtime instance is bound to the provider connection identity, not only the bot id. A change to the provider, app id, credential reference, or referenced credential value must abort and await the old instance before the replacement starts, so stale and current connections never consume concurrently.
- Persistent provider locks use a nonce-specific heartbeat lease in addition to PID checks. A reused PID cannot keep an abandoned lock alive; an owner that no longer renews the lease is eligible for bounded takeover. The published lock and its `.pending` staging entry are directories; when Windows reports `EPERM` (and POSIX reports `EISDIR`) for the staging-directory rename because the published directory already exists, acquisition must enter the same owner/lease conflict path as `EEXIST`/`ENOTEMPTY` rather than surface a permanent lock error. Stale directory cleanup and owner release use bounded retries for transient Windows `EPERM`/`EBUSY`/`ENOTEMPTY` errors.
- Configuration reconciliation is serialized per channel and latest-wins. When multiple saves overlap, an older refresh generation must not start a runtime after a newer generation has been scheduled.
- Feishu/Lark card actions may finish their WebSocket handler only after the shared business callback succeeds. The runtime returns the callback's complete outbound message to the handler, which synchronously renders the single authoritative replacement `card.raw`; the callback pipeline must not also write the same card through REST or message PATCH. A rejected callback or `{ ok: false }` result must reject the handler so the provider can expose a retryable failure.
- A Bot's new task follows the native v4 draft lifecycle: `createSession` first, then capability-checked model/mode/thought configuration, then `sendText`. The v4 create command must carry the same resolved `mcpServers` used by the legacy session create path so desktop-continuous, Bot, and remote entry points start equivalent runtimes. It must not create the empty session through the legacy session operation, because the following v4 input ledger requires the v4 draft persistence state. Attachment delivery keeps the existing attachment-capable send fallback after the same v4 draft creation.
- Runtime lock I/O failures are observable retryable errors; they must not terminate a provider loop or escape as unhandled promise rejections.
- A private-chat input has a fixed v4 `sendText` command ID. The ID comes from the provider message identity: Bot ID, provider, chat or user ID, and provider message ID. This is the same key as the inbound delivery dedupe. The in-memory dedupe lasts only two minutes, so it only stops short repeats. The CLI command ledger is the durable idempotency point. When the provider delivers the same message again, the CLI answers from that ledger and does not create a second queued input: `duplicate` for an input that is queued or executed, and `failed` for an input that was discarded or cancelled. This applies when the dedupe window is over, when a cursor or offset was not committed, and after a host restart. A message without a provider message ID keeps a random command ID. A message with attachments also keeps a random command ID: it still uses the legacy `session/send` path, which does not deduplicate by input ID, so a fixed ID there gives no protection and would let two turns share one input ID.
- Before a private input is sent, the Bot marks the task as running, starts the typing indicator, and broadcasts `resumed` and `prompt_sent`. These states normally end with the turn's terminal event. A `duplicate` ACK starts no turn, so no terminal event follows. `sendPrompt` therefore returns the v4 ACK. On `duplicate`, the Bot reads the authoritative CLI task snapshot with the same idle rule as the task-switch check. When the task is idle (`completed` or `error`), the Bot clears the running mark and the IM trace, stops typing (including the Feishu typing reaction), and broadcasts `completed`. When the task is still running or has queued work, the Bot keeps these states, because the running turn's terminal event clears them. This uses no timeout and does not wait for the next message. A legacy or remote runtime that returns no ACK keeps the previous behavior.
- A Weixin or Telegram poll can fail: the callback fails, the cursor or offset write fails, or the request throws. For each failure, the runtime writes a `warn` log. The log has the Bot ID, the count of consecutive failures, the next retry delay, and the error message. The retry delay starts at 5 seconds and doubles after each consecutive failure, up to 5 minutes. A fully committed batch resets the count. The runtime never skips the failed batch and never stops the Bot because of this backoff. HTTP status failures and invalid-response failures from Telegram `getUpdates` keep their existing fixed delays.

> 2026-11-10 incident: a private Weixin message was executed again every two minutes for about 23 hours. The `get_updates_buf` was not committed, so `getupdates` delivered the same message again. After the Bot's own turn had ended, the Bot no longer rejected new private messages as "task running". Each later delivery came after the two-minute in-memory dedupe had expired, and each one got a new random `sendText` command ID. Each delivery was therefore admitted as a new queued input. The failure that stopped the cursor commit was not logged.

- Streaming-card network rendering is best-effort and bounded by a request timeout. Timeout, provider failure, or service disposal must not block later task terminal events.
- Blocking interactions (permission, AskUserQuestion, and ExitPlanMode approval) use the v4 `resolveInteraction` ACK as their business commit point. Persisted Bot state must remain retryable until that ACK succeeds; a transport callback or provider-card update is not a business acknowledgement.
- Provider callback acknowledgement and outbound interaction rendering are bounded by request timeouts. If an in-place card update times out or fails after the v4 interaction succeeds, the callback pipeline must fall back to a new outbound result/next-question message instead of blocking the actor queue.
- The callback pipeline enforces its own three-second acknowledgement deadline around the entire provider adapter call, including credential lookup and card update preparation. It aborts provider I/O on expiry and sends the outbound fallback; it does not rely only on an inner HTTP helper reaching its timeout.
- A completed v4 interaction may be recorded as handled only after the v4 ACK succeeds. A rejected v4 command must leave the original pending interaction available for the same provider update or button to retry.
- A provider request deadline covers both response headers and every response body byte consumed by the caller. Clearing the deadline after headers alone is not a bounded request.
- Long-poll receive endpoints use an explicit channel-specific deadline instead of the ordinary short API deadline. Weixin `/getupdates` keeps a 90-second idle window and remains cancellable by runtime disposal/config refresh.
- Bot interaction replies must not wait indefinitely for desktop/mobile task-state broadcasts. Elicitation progress is persisted first, then its auxiliary v4/UI broadcast is allowed at most one second; a timeout is logged and the provider reply continues. The final answer still uses the v4 interaction ACK as its business commit point.
