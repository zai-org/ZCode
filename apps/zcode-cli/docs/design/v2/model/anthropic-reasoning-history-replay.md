# Anthropic Reasoning History Replay

Status: L1 Implemented

## Goal

Anthropic thinking signatures are valid only for the model response that produced them. Request
history must therefore remove incompatible reasoning at the request projection boundary without
modifying the canonical session history or treating every block without a signature as invalid.

## Request projection

Two layers project a request-local copy of the history. Neither rewrites canonical history.

### Core: which assistant messages exist

The core provider request projection is the only place that removes an assistant message. It does
this only when the model request capability `dropReasoningOnlyOrBlankAssistants` is true; the
adapter sets it for the Anthropic Messages API. Other protocols keep these messages.

The projection removes an assistant message that has no tool calls and whose content is a
non-empty block array where every block is reasoning or text that is blank or `(no content)` after
trimming, so the reply has no visible content. A reply cut off while thinking (send now, stop), a
stream that failed after reasoning, or a reply of only reasoning and blank text leaves such a
message. String content and an empty array are not removed. An empty reply that carries usage is
stored with empty string content and kept as an estimation anchor (see
[Assistant Block Order](./assistant-block-order.md) "没有可见内容的回复"); an empty array is excluded
too, because every block of an empty array matches. The decision uses only the stored content,
not the target model.
Cross-model signature stripping stays in the adapter.

The removal is the first projection step. Attachment bubbling, mid-conversation system (MCS)
placement, the notification text choice, tool-result folding and the newline before a user input
or a Continue prompt all run as if the message never existed. MCS placement needs this order: it
puts a system message only before an assistant message or at the end. If the assistant message is
removed after that, the system message is directly before a user message, and the provider rejects
the request with HTTP 400.

```text
history   A1 ─ U2 ─ A2[reasoning only] ─ U3 ─ reminder
MCS on    A1 ─ U2\n ─ U3 ─ system(reminders)
MCS off   A1 ─ reminders ─ U2\n ─ U3
```

Accepted effects:

- The previous request ended at U2. U2 gets `\n`, and with MCS off the reminders move before U2,
  so the prompt cache misses from that point once.
- A stored session that already has such a reply sends a different request from that reply on,
  on its first request after the upgrade. The prompt cache misses once. Signed reasoning after that
  reply was produced with the old prefix, so a provider that checks the prefix can reject the
  request once. The signature repair ("Signature rejection") then removes all signed and redacted
  reasoning before the repaired step, and the marker keeps that removal for later requests. This
  one-time cost is accepted.
- A reminder that becomes adjacent to a tool result folds into it.
- A task notification directly after a removed reply is in the same turn as the user prompt before
  it, so it uses the same-turn notification text.
- After a model switch, a reply of only signed reasoning, with or without blank text, is removed;
  it is not kept as `(no content)`.
- Caller-built messages (MCP Apps sampling) do not pass through this projection, so nothing removes
  their assistant messages. A final assistant message with only blank text becomes an empty text
  block after the Anthropic serializer trims it. The provider rejects that request, and the error
  goes back to the App as a failed sampling call.

### Adapter: blocks inside each assistant message

The adapter uses the assistant message's original `providerId + modelId` as provenance and applies
these rules, in order:

1. When the source and target model IDs differ, or their providers are not replay-compatible,
   remove reasoning with a non-empty Anthropic `signature` and reasoning carrying Anthropic
   `redactedData`. Provider compatibility follows the bounded identity rules below.
2. If the final message is an assistant message, remove its consecutive trailing reasoning blocks.
3. Replace a non-final assistant message that has no tool calls and whose content is an empty or
   only-blank-text block array with `(no content)`. Core-projected requests normally do not reach
   this rule: the core removes replies without visible content, and the empty reply kept as an
   estimation anchor has empty string content, which this rule does not change. Caller-built
   messages (MCP Apps sampling) can have such content.

The adapter never removes or merges messages, so the positions that the core projection chose,
including MCS placement, stay valid.

Assistant entries whose blocks and tool calls all carry `blockIndex` are ordered entries; see
[Assistant Block Order](./assistant-block-order.md). After step 1, each ordered entry is folded
block by block in `blockIndex` order. Each new block is added to the previous result, and then two
rules run on that result: whitespace-only text blocks are dropped unless they sit between two
reasoning blocks (the filter is skipped when only reasoning would remain), and tool calls move
after the content unless a reasoning → tool call → reasoning pattern exists. A block that an
earlier step removed or moved is not restored. Step 2 removes the trailing reasoning of an ordered
final entry in request order and does not run the entry rules again. These entry rules only remove
or move blocks; they never merge blocks or messages. Legacy entries keep the rules above unchanged.

A logical model request applies this structural normalization exactly once, before its first
physical attempt. Ordinary retries reuse that projected request-local history. A signature-repair
retry derives only by removing rejected signed or redacted reasoning from the same projection; it
must not run the structural passes again.

Missing or empty signatures are unsigned reasoning. They are preserved unless the core removes the
reasoning-only message, the trailing rule removes the block, or the final serializer-input
projection identifies an exact-empty
stream stub with `text === ""` and no `providerOptions` keys. Whitespace-only reasoning is not an
empty stub, and provider options are opaque: the presence of any known or unknown key preserves the
block without inspecting `signature` or another provider-specific field. A missing source model
identity is treated as unknown rather than cross-model, so legacy and synthetic history is not
deleted by inference. Model `variant` and `role` do not participate in identity comparison.

The exact-empty stub filter is request-local and does not rewrite MessageHistory or persisted
session parts. It runs before Anthropic metadata completion. DeepSeek V4 tool-call replay therefore
reconstructs its required empty thinking block afterwards, while Anthropic signatures/redacted data
and OpenAI Responses item references or encrypted content remain untouched.

Live and resumed history must use the same provenance:

```text
completed model result -- result.model -------> MessageHistory
in-flight recovery ------ executionModelRef ---> MessageHistory
persisted assistant ----- provider/model ------> hydrate modelRef
                                                   |
                                                   v
target model + request-local history -> normalize -> AI SDK -> provider
```

The persisted assistant schema already contains provider, model, and variant fields. This behavior
does not add a storage migration or a protocol field.

### Coding Plan provider identity compatibility

Bug cause: the provider refactor migrates the selected `builtin:*` Coding Plan ID to an
`account:*` ID, while historical assistant messages correctly retain their original provider ID.
Strict provider-ID equality then strips signed/redacted reasoning even for the same logical
service and model. Individual/Team switches expose the same mismatch.

The Adapter owns one pure provider-compatibility predicate, shared by generate and stream through
the existing request projection. It uses only the source and target provider IDs:

- Identical provider IDs remain compatible.
- The exact IDs `builtin:zai-coding-plan`, `account:zai-individual-coding-plan`, and
  `account:zai-team-coding-plan` form one compatible group.
- The corresponding three BigModel IDs form a separate compatible group.
- No other distinct IDs are equivalent. Start Plan, Off-Peak, API templates, custom providers,
  unknown IDs, and strings merely containing a known name do not inherit these groups.
- Model IDs still require exact equality. Missing source identity keeps the existing unknown
  provenance behavior; it is not inferred from the current account or Registry.

```text
live / persisted assistant providerId + modelId
                         |
                         v
target identity -> Adapter compatibility predicate -> request-local projection -> SDK
```

This is a replay-only equivalence relation, not a Provider alias resolver. It does not rewrite
selection, routing, credentials, usage attribution, canonical history, or stored bytes, and adds
no field or configuration. Signature contents, block order, tool results, and cache metadata
remain unchanged for compatible histories. Existing signature-rejection repair remains bounded
to its current one-shot request-local retry.

Regression coverage must include both directions between Individual/Team, legacy selection
migration followed by real Runtime cold resume, both generate/stream HTTP serialization, and
cross-service/model/custom-provider controls. Local HTTP fixtures prove client serialization;
they do not establish real service cross-account signature acceptance or cache hit rates.

After Todo109, cold-resume fixtures must run the versioned database migration on store open,
not call the removed per-session migration API. Migration may append new identity fields while
preserving every original member and reasoning part; subsequent request projection must leave
the migrated historical rows byte-for-byte unchanged.

## Signature rejection

An Anthropic request may return HTTP 400 when a signed or redacted thinking block is rejected. The
adapter may retry once only when all of these conditions hold:

- the error text identifies a thinking signature that is invalid or cannot be modified, or a
  thinking block that is bound to another conversation;
- no provider-visible stream output has been committed;
- removing signed or redacted reasoning actually changes the request;
- the one-shot signature-repair credit has not already been used.

The error text check is case-insensitive and runs on the raw text and on the text with backticks
removed, so a provider message such as ``Invalid `signature` in `thinking` block`` matches. It
accepts these forms: `signature in thinking block`; a thinking block name (`thinking block`,
`` `thinking` ``, `redacted_thinking`) together with `invalid signature` or `cannot be modified`;
`bound to a different conversation`; `not created in this conversation`.

The repair warning log (`model.reasoning_signature_repair.retry`) also records the provider error
text (first 2000 characters) and the `anthropic-thinking-prefix-mismatch` response header when the
response has one. These fields exist to diagnose why a signature was rejected.

The retry uses a request-local copy and has no backoff. It never rewrites the reasoning already in
MessageHistory or in persisted parts; later requests keep the removal through the marker described
in "Keeping removed reasoning out". The rejection repair removes blank text blocks from an
assistant it changed. If that
assistant would otherwise be empty or contain only unsigned reasoning and has no tool calls, it
appends `[Thinking removed]`. Unsigned reasoning itself is not removed. In an ordered entry the
placeholder takes the next `blockIndex` after the entry's largest index, and the per-entry
whitespace and tool-call rules run again on the repaired entry. They are entry rules, not the
structural passes, so the "no second structural normalization" rule still holds.

The one signature-repair retry does not consume the ordinary provider retry budget. Unrelated HTTP
400 responses, a second signature failure, or a request containing only unsigned reasoning are
returned without this repair retry.

The rejected attempt publishes `model_request_failed`, followed by one zero-delay
`model_retry_scheduled` event whose reason is `reasoning_signature_repair`. The repair credit adds
one physical attempt to the status lifecycle without changing the ordinary retry budget. Existing
usage aggregation and `control.apiRetry` projection consume that normal retry event; no separate
retry state or UI path is introduced.

Model-I/O request fields are attempt-scoped. Every emitted record uses the messages that built that
physical attempt: a rejected attempt, when the existing recorder emits one, shows the original
request-local messages, while the successful retry shows the repaired messages it actually sent.
Recording must not fall back to the canonical input request after request-local history changes.

### Keeping removed reasoning out

A rejected block does not become valid again. The provider binds a signed block to the prompt
prefix that produced it, and a removed block that is sent again also invalidates the reasoning that
was produced while it was absent. If only the repaired request omitted the blocks, every later
request would send them again and fail once before its own repair.

When a repaired retry succeeds, the adapter reports `signedReasoningReset: true` on the generate
result or on the stream `finish` event. Core stores the marker on the assistant message that this
model step produces: on the live entry message (`ModelInputMessage.signedReasoningReset`) and in
`AssistantMessageInfo.metadata.signedReasoningReset`. Cold resume restores it from that metadata.
The metadata key is optional and loose, so older readers ignore it and no migration is needed.

The projection rule has one owner. The last pass of `normalizeReasoningHistory` finds the last
assistant message with the marker and applies the rejection repair to every message before it:
signed and redacted reasoning is removed, blank text in a changed assistant is removed, and a
changed assistant left with only unsigned reasoning and no tool calls gets `[Thinking removed]`.
The marked message and the messages after it are not changed. Because this pass runs after the
structural passes, as the repair did, the projected prefix is byte-for-byte the prefix that the
repaired retry sent. Later requests do not fail again, and their prompt cache continues from the
repaired retry.

```text
request N     [A1(T1) … A5(T5)] ─400→ remove signed reasoning ─retry→ 200, signedReasoningReset
                                                                          │
              A6.info.metadata.signedReasoningReset = true ◄──────────────┘
request N+1   [A1 … A5, A6★(T6), …] → last pass removes signed reasoning before A6★
```

The marker is part of the history, so it follows the history:

- A rewind or branch cut that removes the marked message removes the marker. The reasoning produced
  while the blocks were absent is removed by the same cut.
- Compaction that summarizes the marked message removes the marker with it. A preserved segment
  that keeps the marked message keeps the marker.
- A fork copies the message metadata, so the child projects the same prefix as the parent.
- A retry that fails or is cancelled produces no marked message. The next request is rejected once
  more, and its successful repair records the marker.
- A marked reply without visible content (no tool calls, only reasoning or blank text) is removed
  by the core projection, and its marker goes with it. This is intended: the removal stays one rule
  over the stored content and does not read the marker. The next request sends the rejected blocks
  again, is rejected once more, and its repair marks the new reply. The first marked reply that has
  visible content keeps the marker, and later requests do not fail again.

The rule removes all signed and redacted reasoning before the marker, not only the block that the
provider names. Compatible gateways do not reliably report the position of the rejected block, so
this is the rule that is correct for every Anthropic-protocol provider. Unsigned reasoning is not
removed.

## Invariants

- Same-model signed and redacted reasoning remains unchanged by cross-model compatibility
  filtering. The core removal of messages without visible content and the final trailing-reasoning
  rule may still remove it.
- Structural normalization runs once per logical model request. Physical attempts, including a
  signature-repair retry, reuse or derive from that request-local projection without normalizing it
  again.
- Text, tool calls, tool results, and cache metadata remain unchanged except for the explicit blank
  assistant repair above and the ordered-entry rules in
  [Assistant Block Order](./assistant-block-order.md). Only the core projection removes assistant
  messages, as its first step. The adapter keeps the message count and order.
- Anthropic unsigned reasoning that survives normalization remains in the serializer input using
  the required empty-signature representation, except for an exact-empty block with no provider
  options. Whitespace-only reasoning and any block carrying opaque provider options remain intact.
- OpenAI Responses, OpenAI-compatible reasoning fields, DeepSeek V4 synthetic thinking, and
  desktop/mobile delivery semantics are unchanged. Signature repair is visible only through the
  existing provider-retry UI state; no UI component or interaction behavior is added.
- Signature repair reuses the existing model retry status, usage, and live-tail projection paths;
  it does not add protocol fields or another retry authority. Its only persisted state is the
  optional `signedReasoningReset` key in the metadata of the assistant message that the repaired
  request produced.

## Tests

- `packages/adapters/tests/reasoning-provider-compatibility.test.ts` covers the bounded Coding
  Plan identity groups, exact model matching, custom/unknown provider isolation, and cache metadata.
- `packages/adapters/tests/runtime-reasoning-provider-replay.test.ts` covers actual SQLite decoding
  and selection migration, Runtime cold resume and live continuation, generate/stream HTTP request
  bodies, and original stored message/part immutability with a local fake transport. It also sends
  follow-ups after a reasoning-only reply, live and after cold resume, in streaming and
  non-streaming mode with MCS on, and checks that each request has a system message and none is
  directly before a user message.
- `packages/core/tests/provider-request-messages.test.ts` covers the core removal with MCS on and
  off, reminders that bubble past the removed reply, the kept shapes, and the capability switch.
  `packages/adapters/tests/request-capabilities.test.ts` covers the capability per API type.
- Desktop E2E I71 covers the removed reasoning-only reply on the same model and, after a model
  switch, the removed `[signed reasoning]` and `[signed reasoning, blank text]` replies.
- Pure projection tests cover same-model, cross-model, unknown-model, unsigned, redacted,
  trailing, empty and blank-after-stripping assistant repair, rejection placeholders, tool-call,
  and immutability cases, and that the adapter keeps reasoning-only replies. Marker projection
  tests prove that
  the messages before the last marked assistant equal the repaired retry's projection byte for
  byte, that the marked message and later messages are unchanged, and that unsigned reasoning is
  kept.
- Core tests cover live cloning, persisted execution-model provenance, resume hydration, and
  execution-model provenance on terminal-error, partial-stream recovery, streamed-tool recovery,
  and Start Plan admission-retry paths when the selected model changes in flight. They also cover
  the `signedReasoningReset` marker on the live assistant entry, in persisted message metadata,
  after cold resume, and in a forked child.
- Adapter runner tests cover the exact HTTP 400 classifier, a single repaired retry outside the
  ordinary retry budget, no retry after committed output, no retry when the request does not
  change, canonical-history immutability, the failed/scheduled/started status sequence, and
  attempt-scoped production model-I/O. Generate and stream each cover both orderings between an
  ordinary retry and the one-shot signature-repair credit; generate also covers a second signature
  rejection terminating without another repair. A structural regression case keeps an
  empty-assistant placeholder and its surrounding user-turn boundaries unchanged across the
  repaired retry. Generate and stream report `signedReasoningReset` only when the repaired retry
  succeeds.
- Product projection tests cover the signature-repair retry reason through the existing
  `control.apiRetry` live-tail state.
- Serializer-input projection tests prove that exact-empty metadata-free stubs are omitted while
  whitespace-only reasoning, surviving unsigned reasoning, opaque Anthropic metadata, OpenAI
  Responses metadata, and DeepSeek V4 tool-call placeholders are not silently omitted.
- Desktop replay E2E covers standard native `signature_delta`, start-only signature fallback, and
  native-delta precedence across repeated live and cold-resume follow-ups. It also proves that a
  resumed unsigned-only history is sent unchanged and a signature
  400 that cannot remove any signed or redacted block terminates without retrying. After a
  successful repair, the next request and the first request after an app restart omit the removed
  blocks and keep unsigned reasoning, each in one physical attempt.
- Ordered-entry rules (whitespace text, tool-call reordering and its reasoning → tool call →
  reasoning exception, trailing reasoning in request order, signature-repair placeholder) and
  live/cold byte equality for interleaved responses are covered by the tests listed in
  [Assistant Block Order](./assistant-block-order.md).
