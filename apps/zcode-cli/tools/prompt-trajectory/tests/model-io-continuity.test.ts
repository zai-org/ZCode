import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveTrajectoriesFromModelIoEntries, type ModelIoJsonlEntry } from "../src/model-io.js";
import type { OpenAiMessage } from "../src/types.js";

const user: OpenAiMessage = {
  role: "user",
  content: [{ type: "text", text: "inspect" }],
};
const toolUse = { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } };
const answer = { type: "text", text: "reading" };
const result: OpenAiMessage = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "call_1", content: "file content" }],
};

function record(messages: OpenAiMessage[], response = false): ModelIoJsonlEntry {
  return {
    querySource: "main_turn",
    request: { body: { model: "glm-test", messages } },
    ...(response
      ? {
          response: {
            reasoningText: "summary without provider signature",
            text: "reading",
            toolCalls: [{ id: "call_1", name: "Read", input: { path: "a.ts" } }],
          },
        }
      : {}),
  };
}

describe("model-io response continuity", () => {
  for (const thinking of [
    { type: "thinking", thinking: "recorded reasoning", signature: "provider-signature" },
    { type: "redacted_thinking", data: "opaque-provider-data" },
  ]) {
    it(`preserves the real ${thinking.type} block and signature without splitting`, () => {
      const assistant = { role: "assistant", content: [thinking, answer, toolUse] };
      const messages = [user, assistant, result];
      const entries = [record([user], true), record(messages)];
      const original = structuredClone(entries);
      const output = deriveTrajectoriesFromModelIoEntries(entries);

      equal(output.trajectories.length, 1);
      equal(output.trajectories[0]?.requestCount, 2);
      deepStrictEqual(output.trajectories[0]?.requestBody.messages, messages);
      deepStrictEqual(entries, original);
    });
  }

  it("restores interleaved thinking and separate text blocks from the next request", () => {
    // 请求里每个文字块单独一块（docs/design/v2/model/assistant-block-order.md）；
    // 摘要的 text 是直接拼接，比较时折叠后仍能认出同一条回复。
    const assistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first", signature: "sig-1" },
        { type: "text", text: "read" },
        { type: "thinking", thinking: "second", signature: "sig-2" },
        { type: "text", text: "ing" },
        toolUse,
      ],
    };
    const messages = [user, assistant, result];
    const output = deriveTrajectoriesFromModelIoEntries([record([user], true), record(messages)]);

    equal(output.trajectories.length, 1);
    deepStrictEqual(output.trajectories[0]?.requestBody.messages, messages);
  });

  it("uses the next selected request after expanding deltas across a sidecar", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "thought", signature: "sig" }, answer, toolUse],
    };
    const first = { ...record([user], true), querySource: "subagent" };
    const sidecar = { ...record([user]), querySource: "session_title" };
    const next: ModelIoJsonlEntry = {
      querySource: "subagent",
      request: {
        body: { model: "glm-test", messages: [assistant, result] },
        bodyMessagesKind: "delta",
        bodyMessageOffset: 1,
      },
    };
    const output = deriveTrajectoriesFromModelIoEntries([first, sidecar, next], {
      querySource: "subagent",
    });
    equal(output.trajectories.length, 1);
    deepStrictEqual(output.trajectories[0]?.requestBody.messages, [user, assistant, result]);
  });

  // 请求规则会删掉纯空白文字块，摘要的 text 仍保留这些空白（E2E I76 形态 A P W 1、W A P 1）。
  for (const text of ["read\n\ning", "\n\nreading", "reading\n\n"]) {
    it(`restores the recorded reply when only whitespace blocks were dropped: ${JSON.stringify(text)}`, () => {
      const assistant = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thought", signature: "sig" },
          ...(text === "read\n\ning"
            ? [
                { type: "text", text: "read" },
                { type: "text", text: "ing" },
              ]
            : [answer]),
          toolUse,
        ],
      };
      const first = record([user], true);
      const output = deriveTrajectoriesFromModelIoEntries([
        { ...first, response: { ...first.response, text } },
        record([user, assistant, result]),
      ]);
      equal(output.trajectories.length, 1);
      deepStrictEqual(output.trajectories[0]?.requestBody.messages, [user, assistant, result]);
    });
  }

  it("retains a split when the reply differs by more than dropped whitespace", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "thought", signature: "sig" }, answer, toolUse],
    };
    const first = record([user], true);
    const output = deriveTrajectoriesFromModelIoEntries([
      { ...first, response: { ...first.response, text: "reading!" } },
      record([user, assistant, result]),
    ]);
    equal(output.trajectories.length, 2);
  });

  for (const changed of [
    [{ type: "text", text: "different answer" }, toolUse],
    [answer, { ...toolUse, input: { path: "changed.ts" } }],
    [answer, { ...toolUse, id: "different-call" }],
  ]) {
    it(`retains a split when the recorded reply differs: ${JSON.stringify(changed)}`, () => {
      const assistant = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "thought", signature: "sig" }, ...changed],
      };
      const output = deriveTrajectoriesFromModelIoEntries([
        record([user], true),
        record([user, assistant, result]),
      ]);
      equal(output.trajectories.length, 2);
      equal(output.trajectories[1]?.reason, "non-incremental-change");
      deepStrictEqual(output.trajectories[0]?.requestBody.messages.at(-1), {
        role: "assistant",
        content: [answer, toolUse],
      });
    });
  }

  it("does not borrow reasoning from a request with rewritten history", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "unrelated", signature: "sig" }, answer, toolUse],
    };
    const output = deriveTrajectoriesFromModelIoEntries([
      record([user], true),
      record([{ role: "user", content: "new history" }, assistant, result]),
    ]);
    equal(output.trajectories.length, 2);
    deepStrictEqual(output.trajectories[0]?.requestBody.messages.at(-1), {
      role: "assistant",
      content: [answer, toolUse],
    });
  });

  it("skips records without request bodies when completing a response", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "thought", signature: "sig" }, answer, toolUse],
    };
    const output = deriveTrajectoriesFromModelIoEntries([
      record([user], true),
      { querySource: "main_turn", error: "session stopped" },
      record([user, assistant, result]),
    ]);
    equal(output.trajectories.length, 1);
    equal(output.trajectories[0]?.requestCount, 2);
    deepStrictEqual(output.trajectories[0]?.requestBody.messages, [user, assistant, result]);
  });

  for (const field of ["thinking", "signature"]) {
    it(`still splits when an existing history ${field} changes`, () => {
      const thinking = { type: "thinking", thinking: "original", signature: "original" };
      const assistant = { role: "assistant", content: [thinking, answer, toolUse] };
      const changedAssistant = {
        role: "assistant",
        content: [{ ...thinking, [field]: "changed" }, answer, toolUse],
      };
      const output = deriveTrajectoriesFromModelIoEntries([
        record([user], true),
        record([user, assistant, result]),
        record([user, changedAssistant, result]),
      ]);
      equal(output.trajectories.length, 2);
      equal(output.trajectories[0]?.requestCount, 2);
      equal(output.trajectories[1]?.reason, "non-incremental-change");
    });
  }
});
