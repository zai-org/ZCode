# OpenAI Responses Tool Continuation Boundary

## Goal

OpenAI Responses sessions must carry each step's reasoning into the next request, so the model keeps its reasoning across tool-call steps. Replay must not depend on server-side storage: ZCode never sends `previous_response_id` or a conversation id, and partially compatible `/responses` providers may not resolve stored item ids.

## Problem

ZCode keeps provider-visible history in a protocol-neutral message list and replays the full history on every request (stateless replay).

The earlier boundary sent no `store` and no `include`. The upstream then used `store=true` and returned reasoning items without `encrypted_content`. Such an item can only be replayed as an `item_reference` by id. Some compatible providers cannot resolve that reference and return HTTP 502 on the tool-result follow-up, so ZCode dropped every reasoning item with an id. The next request then had no reasoning for any model, and model quality fell.

The AI SDK adds `include: ["reasoning.encrypted_content"]` only when `store === false` and the model id is in its built-in reasoning list (o1, o3, o4-mini, gpt-5\* except gpt-5-chat). Newer models such as gpt-6 are not in that list, so ZCode must send `include` itself.

## Required Boundary

```text
model resolution (api type openai-responses, reasoning option map + this request's level)
  providerOptions.openai = { store: false, include?: ["reasoning.encrypted_content"] }
        |  one object, written once per request; include only when the map writes `reasoning`
        +--> history projection (transform.ts): which reasoning to replay
        +--> AI SDK request body: store / include / inline encrypted reasoning

response N   reasoning { id: rs_1, encrypted_content: <opaque> }
               -> reasoning block keeps openai.itemId + openai.reasoningEncryptedContent
request N+1  input: reasoning { id: rs_1, encrypted_content: <opaque>, summary }, function_call, ...
```

- Every `openai-responses` request, for a built-in or custom provider, sends `store: false`. One function in model resolution writes `providerOptions.openai` (`store` and `include`); the history projection and the SDK read that same object.
- `include: ["reasoning.encrypted_content"]` is sent when the model's reasoning option map, evaluated with this request's reasoning level, writes a `reasoning` object into the request. The option map is the fact that already decides whether the request asks for reasoning. A reasoning level that maps to `effort: "none"` still writes `reasoning`, so `include` is still sent for reasoning models. OpenAI rejects `include` for non-reasoning models with HTTP 400 ("Encrypted content is not supported with this model").
- The built-in API rule for `openai-responses` writes `reasoning` for every model, so by default every model on this transport sends `include`. A non-reasoning model must have an option map that does not write `reasoning`; on OpenAI that is already required, because OpenAI also rejects `reasoning` for such a model.
- Residual risk, not verified: an upstream or gateway that ignores `reasoning` but rejects `include` fails every request after this change, and the encrypted reasoning repair below does not cover that 400. The built-in non-OpenAI endpoints on this transport and custom gateways have not been tested against a real upstream.
- The AI SDK also adds the same `include` by itself when `store` is `false` and the model ID is in its built-in reasoning list. A non-reasoning model whose ID matches that list must also write `"include": null` in its option map; the option map merge patch then removes the key.
- Encrypted reasoning is bound to the model and service that produced it. For every `openai-responses` request, when the source message's provider or model differs from the target, encrypted OpenAI reasoning is dropped before serialization. The identity rule is the one used for Anthropic signed reasoning ([Anthropic Reasoning History Replay](../apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md)); a message without source identity is kept. The repair marker projection in the next section also applies to every `openai-responses` request.
- The serialization rules below apply only to stateless replay on this transport: `providerKind === "openai"`, `apiFormat === "openai-responses"`, no `openai.previousResponseId`, and no `openai.conversation`. With either stateful boundary the SDK handling is unchanged. ZCode never sends either boundary, so in practice they always apply. The projection applies the rules below in one pass over each assistant message's request parts, after the block order is resolved.
- With `store: false`, a reasoning item is replayed inline only when the same assistant message holds encrypted content for its `itemId`. One item can span several summary blocks and only the last block may carry the encrypted content, so the check is per `itemId`, not per block.
- A reasoning block with an `itemId` but no non-empty encrypted content for that item is dropped. This covers history written before this boundary, cancelled streams, and providers that do not return encrypted content. With `store: false` the AI SDK also drops reasoning whose encrypted content is `null`, but it logs one warn-level SDK warning per request for it, and it sends an empty-string encrypted content as is. Dropping at the projection boundary avoids both.
- When `store` is not `false`, every reasoning block with an `itemId` is dropped, so the SDK never emits a reasoning `item_reference`. Model resolution always sends `store: false`; the check keeps the projection consistent with the SDK, which reads the same `store`.
- In each assistant message, reasoning that no text or tool call follows (in request order) is dropped. Such a reply comes from output-token continuation that keeps a reasoning-only partial, or from a turn that stops after the reasoning item completes. The Responses API can reject a reasoning item "without its required following item" with HTTP 400, and the encrypted reasoning repair below does not cover that error. The rule is deterministic, so the request prefix stays stable; the dropped reasoning had no output that depends on it.
- Tool calls, tool results, Anthropic reasoning, OpenAI-compatible Chat Completions, and DeepSeek/MiMo `reasoning_content` replay are unchanged. The only exception is the shared repair marker in the next section, which can also drop Anthropic signed or redacted reasoning.

## Encrypted Reasoning Rejection

The upstream can reject replayed encrypted reasoning that the cross-model rule does not catch: the same provider ID with an API key of another organization, a gateway that routes to another upstream account, or encrypted content that expired while the session was idle. Without a repair, every later request replays the same encrypted content and fails, including compact.

```text
request (projected history with encrypted reasoning)
  -> HTTP 400 encrypted content rejection, no provider-visible output committed
  -> request-local copy: drop every reasoning block with OpenAI encrypted content
  -> one repair retry (outside the ordinary retry budget, new requestId)
  -> success: result carries signedReasoningReset -> core marks the produced assistant
next request: before the last marked assistant, encrypted OpenAI reasoning is dropped again
```

- The repair reuses the signature repair of [Anthropic Reasoning History Replay](../apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md#signature-rejection): the same one-shot credit, retry status reason (`reasoning_signature_repair`), log event, `signedReasoningReset` marker, and marker projection. Only the error check and the removed blocks are specific to OpenAI Responses.
- The error check requires HTTP 400 and one of: the structured provider error code `invalid_encrypted_content`; or, for providers that send no code, a message that names encrypted content and says it "could not be verified" or "has expired". The text forms are the confirmed wordings of compatible gateways; other 400 responses are not repaired.
- The repair removes only reasoning blocks that carry non-empty OpenAI encrypted content. The remaining blocks of the same `itemId` are dropped by the projection rule above. Text, tool calls, and tool results are unchanged, and no placeholder is added: the Responses API accepts an assistant turn without output items.
- The repair and the marker never rewrite MessageHistory or persisted parts.
- The marker is shared with the Anthropic repair and does not record the provider kind. After a switch between provider kinds, a marker written by one kind also drops the other kind's model-bound reasoning before it (Anthropic signed or redacted reasoning, OpenAI encrypted reasoning). Requests stay valid and deterministic; only older reasoning is lost.
- Known cost, not verified against a real gateway: the marker keeps the encrypted reasoning of the marked reply itself. When a gateway routes the requests of one session to different upstream accounts, the next request can be rejected again, so each step can need one repair retry and one warn-level log line.

## Verification

Tests live in `apps/zcode-cli/packages/adapters/tests/`. Each rule above was mutation-checked: removing or loosening the rule makes a test fail.

- `openai-responses-encrypted-reasoning-wire.test.ts`: request options, replay (with and without reasoning summaries), model and provider switch, repair retry, and marker, through the real AI SDK and a local fetch fixture.
- `openai-responses-reasoning-projection.test.ts`: the projection rules on ordered messages, and the boundaries that keep trailing reasoning.
- `openai-encrypted-reasoning-rejection.test.ts`: the errors that start the repair, and the provider kind that runs it.
- `provider-config-model-creation.test.ts`: the `openai` request options for a Responses model. The existing `runner.test.ts` case for Chat Completions proves that other API types get no `openai` request options.
- `model-transform.test.ts`: the earlier cases for stored references with and without `previous_response_id`.
- Local fixtures prove client serialization only. They do not prove that a real upstream or gateway accepts `store: false`, `include`, replayed encrypted content, or a reasoning item without its following item.
