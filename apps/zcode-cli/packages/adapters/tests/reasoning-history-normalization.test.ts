import { describe, expect, it } from "vitest";
import type { ModelInputMessage, ModelMessageContentBlock } from "@zcode/contracts";
import {
  isThinkingSignatureRejection,
  normalizeReasoningHistory,
  removeRejectedReasoning,
  thinkingSignatureRejectionEvidence,
} from "../src/model/reasoning-history-normalization.js";

describe("reasoning history normalization", () => {
  it("preserves signed and redacted reasoning for the same model identity", () => {
    const messages: ModelInputMessage[] = [
      assistantWithReasoning(
        [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("redacted", { redactedData: "redacted_1" }),
          { type: "text", text: "answer" },
        ],
        modelIdentity("provider-a/model-a"),
      ),
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-a/model-a"))).toBe(messages);
  });

  it("removes signed and redacted reasoning across model identities but preserves unsigned blocks", () => {
    const messages: ModelInputMessage[] = [
      assistantWithReasoning(
        [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("unsigned"),
          reasoning("empty signature", { signature: "" }),
          reasoning("redacted", { redactedData: "redacted_1" }),
          { type: "text", text: "answer" },
        ],
        modelIdentity("provider-a/shared-model"),
      ),
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/shared-model"))).toEqual([
      {
        role: "assistant",
        ...modelIdentity("provider-a/shared-model"),
        content: [
          reasoning("unsigned"),
          reasoning("empty signature", { signature: "" }),
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("preserves a non-final assistant envelope when cross-model stripping makes it empty", () => {
    const messages: ModelInputMessage[] = [
      assistantWithReasoning(
        [reasoning("signed", { signature: "sig_1" })],
        modelIdentity("provider-a/model-a"),
      ),
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/model-b"))).toEqual([
      {
        role: "assistant",
        ...modelIdentity("provider-a/model-a"),
        content: [{ type: "text", text: "(no content)" }],
      },
      { role: "user", content: "next" },
    ]);
  });

  // 删除回复只在 core 投影的第一步做；adapter 删掉会让 core 放好的 system 直接接 user。
  it("fills a whitespace-only assistant exposed by stripping with (no content)", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "first" },
      assistantWithReasoning(
        [reasoning("signed", { signature: "sig_1" }), { type: "text", text: "  \n" }],
        modelIdentity("provider-a/model-a"),
      ),
      { role: "user", content: "second" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/model-b"))).toEqual([
      { role: "user", content: "first" },
      {
        role: "assistant",
        ...modelIdentity("provider-a/model-a"),
        content: [{ type: "text", text: "(no content)" }],
      },
      { role: "user", content: "second" },
    ]);
  });

  it.each([
    ["reasoning-only", [reasoning("orphan")]],
    ["(no content)", [{ type: "text", text: "(no content)" }]],
  ] satisfies [string, ModelMessageContentBlock[]][])(
    "keeps a %s reply and its neighbouring users",
    (_kind, content) => {
      const messages: ModelInputMessage[] = [
        { role: "user", content: "first" },
        { role: "system", content: "announcement" },
        { role: "assistant", content },
        { role: "user", content: "second" },
      ];

      expect(normalizeReasoningHistory(messages)).toBe(messages);
    },
  );

  it("does not infer a model mismatch when assistant provenance is missing", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [reasoning("signed", { signature: "sig_1" }), { type: "text", text: "answer" }],
      },
      { role: "user", content: "next" },
    ];

    expect(normalizeReasoningHistory(messages, modelIdentity("provider-b/model-b"))).toBe(messages);
  });

  it("removes only the final assistant's consecutive trailing reasoning", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          reasoning("kept"),
          { type: "text", text: "answer" },
          reasoning("trailing one"),
          reasoning("trailing two"),
        ],
      },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [reasoning("kept"), { type: "text", text: "answer" }],
      },
    ]);
  });

  it("keeps tool calls when trailing reasoning leaves assistant content empty", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [reasoning("trailing")],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
    ];

    expect(normalizeReasoningHistory(messages)).toEqual([
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
    ]);
  });

  it("does not mutate canonical history and preserves the original reference when unchanged", () => {
    const messages: ModelInputMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ];
    const snapshot = structuredClone(messages);

    expect(normalizeReasoningHistory(messages)).toBe(messages);
    expect(messages).toEqual(snapshot);
  });

  it("removes only signed and redacted reasoning after a signature rejection", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("unsigned"),
          reasoning("redacted", { redactedData: "redacted_1" }),
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "next" },
    ];
    const snapshot = structuredClone(messages);

    expect(removeRejectedReasoning(messages)).toEqual([
      {
        role: "assistant",
        content: [reasoning("unsigned"), { type: "text", text: "answer" }],
      },
      { role: "user", content: "next" },
    ]);
    expect(messages).toEqual(snapshot);
    expect(
      removeRejectedReasoning([
        { role: "assistant", content: [reasoning("unsigned"), { type: "text", text: "answer" }] },
        { role: "user", content: "next" },
      ]),
    ).toEqual([
      { role: "assistant", content: [reasoning("unsigned"), { type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ]);
  });

  it("adds the [Thinking removed] placeholder when only unsigned reasoning remains", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("unsigned"),
          { type: "text", text: "  " },
        ],
      },
      { role: "user", content: "next" },
    ];

    expect(removeRejectedReasoning(messages)).toEqual([
      {
        role: "assistant",
        content: [reasoning("unsigned"), { type: "text", text: "[Thinking removed]" }],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("does not add a rejection placeholder when a tool call remains", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [reasoning("signed", { signature: "sig_1" }), { type: "text", text: " " }],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
      { role: "user", content: "next" },
    ];

    expect(removeRejectedReasoning(messages)).toEqual([
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("keeps reasoning removed by a successful repair out of later requests", () => {
    const target = modelIdentity("provider-a/model-a");
    const beforeRepair: ModelInputMessage[] = [
      { role: "user", content: "first" },
      assistantWithReasoning(
        [
          reasoning("signed", { signature: "sig_1" }),
          reasoning("unsigned"),
          { type: "text", text: " " },
        ],
        target,
      ),
      { role: "user", content: "second" },
      {
        role: "assistant",
        content: [reasoning("redacted", { redactedData: "redacted_1" })],
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
        ...target,
      },
      { role: "user", content: "read", toolCallId: "call_1", toolName: "Read" },
    ];
    const repairedRetry = removeRejectedReasoning(normalizeReasoningHistory(beforeRepair, target));
    const marked: ModelInputMessage = {
      ...assistantWithReasoning(
        [reasoning("after repair", { signature: "sig_2" }), { type: "text", text: "done" }],
        target,
      ),
      signedReasoningReset: true,
    };
    const later: ModelInputMessage[] = [
      ...beforeRepair,
      marked,
      { role: "user", content: "third" },
      assistantWithReasoning(
        [reasoning("later", { signature: "sig_3" }), { type: "text", text: "ok" }],
        target,
      ),
      { role: "user", content: "fourth" },
    ];
    const snapshot = structuredClone(later);

    const projected = normalizeReasoningHistory(later, target);

    // 标记之前的前缀必须和修复那次重发的前缀逐字节相同，后续请求才不会再被拒，缓存也能接上。
    expect(JSON.stringify(projected.slice(0, beforeRepair.length))).toBe(
      JSON.stringify(repairedRetry),
    );
    expect(projected[1]!.content).toEqual([
      reasoning("unsigned"),
      { type: "text", text: "[Thinking removed]" },
    ]);
    expect(projected.slice(beforeRepair.length)).toEqual(later.slice(beforeRepair.length));
    expect(later).toEqual(snapshot);
  });

  it("uses the last repair marker and leaves history without a marker unchanged", () => {
    const target = modelIdentity("provider-a/model-a");
    const signedAnswer = (text: string, signature: string) =>
      assistantWithReasoning(
        [reasoning(text, { signature }), { type: "text", text: `${text} answer` }],
        target,
      );
    const unmarked: ModelInputMessage[] = [
      { role: "user", content: "first" },
      signedAnswer("one", "sig_1"),
      { role: "user", content: "second" },
    ];
    expect(normalizeReasoningHistory(unmarked, target)).toBe(unmarked);

    const messages: ModelInputMessage[] = [
      ...unmarked,
      { ...signedAnswer("two", "sig_2"), signedReasoningReset: true },
      { role: "user", content: "third" },
      { ...signedAnswer("three", "sig_3"), signedReasoningReset: true },
      { role: "user", content: "fourth" },
    ];

    const projected = normalizeReasoningHistory(messages, target);

    expect(projected[1]!.content).toEqual([{ type: "text", text: "one answer" }]);
    expect(projected[3]!.content).toEqual([{ type: "text", text: "two answer" }]);
    expect(projected[5]).toBe(messages[5]);
  });
});

describe("ordered assistant entries", () => {
  const signed = (text: string, blockIndex: number) => ({
    ...reasoning(text, { signature: `sig_${text}` }),
    blockIndex,
  });
  const text = (value: string, blockIndex: number) => ({
    type: "text" as const,
    text: value,
    blockIndex,
  });
  const call = (id: string, blockIndex: number) => ({ id, name: "Read", input: {}, blockIndex });

  function ordered(
    content: ModelMessageContentBlock[],
    toolCalls?: ReturnType<typeof call>[],
  ): ModelInputMessage {
    return { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) };
  }

  // 按 transform 的排列展开成请求顺序，便于断言块序列。
  function requestOrder(message: ModelInputMessage | undefined): string[] {
    const content = Array.isArray(message?.content) ? message.content : [];
    return [
      ...content.map((block) => ({
        blockIndex: "blockIndex" in block ? block.blockIndex! : -1,
        label: block.type === "text" || block.type === "reasoning" ? block.text : block.type,
      })),
      ...(message?.toolCalls ?? []).map((toolCall) => ({
        blockIndex: toolCall.blockIndex!,
        label: toolCall.id,
      })),
    ]
      .sort((left, right) => left.blockIndex - right.blockIndex)
      .map((entry) => entry.label);
  }

  function normalizeFirst(message: ModelInputMessage): ModelInputMessage | undefined {
    return normalizeReasoningHistory([message, { role: "user", content: "next" }])[0];
  }

  it.each([
    [
      "text after a tool",
      [signed("A", 0), text("P", 1), text("Q", 3)],
      [call("t1", 2)],
      ["A", "P", "Q", "t1"],
    ],
    [
      "reasoning after text and a tool",
      [signed("A", 0), text("P", 1), signed("B", 3)],
      [call("t1", 2), call("t2", 4)],
      ["A", "P", "B", "t1", "t2"],
    ],
  ])("moves tool_use to the end for %s", (_name, content, toolCalls, expected) => {
    expect(requestOrder(normalizeFirst(ordered(content, toolCalls)))).toEqual(expected);
  });

  it("keeps the original order for reasoning -> tool_use -> reasoning", () => {
    const message = ordered([signed("A", 0), signed("B", 2)], [call("t1", 1), call("t2", 3)]);
    const messages = [message, { role: "user" as const, content: "next" }];
    expect(normalizeReasoningHistory(messages)).toBe(messages);
  });

  it("does not change entries whose tools are already last", () => {
    const message = ordered([signed("A", 0), text("P", 1)], [call("t1", 2), call("t2", 3)]);
    const messages = [message, { role: "user" as const, content: "next" }];
    expect(normalizeReasoningHistory(messages)).toBe(messages);
  });

  it("removes whitespace text unless it sits between two reasoning blocks", () => {
    expect(
      requestOrder(
        normalizeFirst(
          ordered([signed("A", 0), text(" ", 1), signed("B", 2), text("\n", 3), text("P", 4)]),
        ),
      ),
    ).toEqual(["A", " ", "B", "P"]);
  });

  it("keeps whitespace text when filtering would leave only reasoning", () => {
    const message = ordered([signed("A", 0), text(" ", 1)]);
    const messages = [message, { role: "user" as const, content: "next" }];
    expect(normalizeReasoningHistory(messages)).toBe(messages);
  });

  it("does not merge text blocks", () => {
    const result = normalizeFirst(ordered([signed("A", 0), text("P", 1), text("Q", 2)]));
    expect(result?.content).toEqual([signed("A", 0), text("P", 1), text("Q", 2)]);
  });

  // 形态的缩写与 E2E I76 相同：A/B 思考，P/Q/R 文字，W 纯空白文字，1/2 工具。
  it.each([
    ["A P B Q 1", "A P B Q 1"],
    ["A P 1 Q", "A P Q 1"],
    ["A 1 B 2", "A 1 B 2"],
    ["A P 1 B 2", "A P B 1 2"],
    ["P 1 A 2 B", "P A 1 2 B"],
    ["A W B P 1", "A W B P 1"],
    ["P A W B 1", "P A B 1"],
    ["A P W 1", "A P 1"],
    ["W A P 1", "A P 1"],
    ["A P B Q", "A P B Q"],
    ["P A", "P A"],
    ["1 A", "A 1"],
    ["1 P 2", "P 1 2"],
    ["P 1 Q 2 R", "P Q R 1 2"],
    ["A 1 B P 2", "A 1 B P 2"],
    ["A 1 P B 2", "A P B 1 2"],
  ])("folds %s block by block into %s", (shape, expected) => {
    const content: ModelMessageContentBlock[] = [];
    const toolCalls: ReturnType<typeof call>[] = [];
    shape.split(" ").forEach((code, index) => {
      if (code === "A" || code === "B") content.push(signed(code, index));
      else if (code === "W") content.push(text("\n\n", index));
      else if (/\d/.test(code)) toolCalls.push(call(code, index));
      else content.push(text(code, index));
    });
    const message = ordered(content, toolCalls.length > 0 ? toolCalls : undefined);
    const order = requestOrder(normalizeFirst(message)).map((label) =>
      label === "\n\n" ? "W" : label,
    );
    expect(order.join(" ")).toBe(expected);
  });

  it("removes trailing reasoning by request order without re-running the rules", () => {
    const messages = normalizeReasoningHistory([
      { role: "user", content: "start" },
      ordered([text("P", 0), text(" ", 1), signed("A", 2)]),
    ]);
    expect(requestOrder(messages.at(-1))).toEqual(["P"]);
  });

  it("removes every trailing reasoning block left by the fold", () => {
    // 加入空白时它是最后一块，被删除；之后 A、B 都在末尾，一起删除。
    const messages = normalizeReasoningHistory([
      { role: "user", content: "start" },
      ordered([text("P", 0), signed("A", 1), text("\n\n", 2), signed("B", 3)]),
    ]);
    expect(requestOrder(messages.at(-1))).toEqual(["P"]);
  });

  // 有序条目和旧条目用同一条「没有可见内容」规则；删除只在 core 投影里做，
  // adapter 收到只有思考和空白的回复时原样保留（规格「没有可见内容的回复」）。
  it.each([
    ["leading reasoning and whitespace", [signed("A", 0), text("\n\n", 1)]],
    ["leading reasoning and the empty placeholder", [signed("A", 0), text("(no content)", 1)]],
    ["reasoning after the text", [text("\n\n", 0), signed("A", 1)]],
    ["visible text", [signed("A", 0), text("P", 1)]],
  ])("keeps an ordered reply with %s", (_name, content) => {
    const messages = [
      { role: "user" as const, content: "first" },
      ordered(content),
      { role: "user" as const, content: "second" },
    ];
    expect(normalizeReasoningHistory(messages)).toBe(messages);
  });

  it("keeps legacy reasoning and whitespace replies", () => {
    const message: ModelInputMessage = {
      role: "assistant",
      content: [reasoning("A", { signature: "sig_A" }), { type: "text", text: "\n\n" }],
    };
    const messages = [
      { role: "user" as const, content: "first" },
      message,
      { role: "user" as const, content: "second" },
    ];
    expect(normalizeReasoningHistory(messages)).toBe(messages);
  });

  it("keeps reasoning that is followed by a tool_use in request order", () => {
    const message = ordered([text("P", 0), signed("A", 1)], [call("t1", 2)]);
    const messages: ModelInputMessage[] = [{ role: "user", content: "start" }, message];
    expect(requestOrder(normalizeReasoningHistory(messages).at(-1))).toEqual(["P", "A", "t1"]);
  });

  it("leaves legacy entries on the legacy rules", () => {
    const message: ModelInputMessage = {
      role: "assistant",
      content: [reasoning("A", { signature: "sig_A" }), { type: "text", text: " " }],
      toolCalls: [{ id: "t1", name: "Read", input: {} }],
    };
    const messages = [message, { role: "user" as const, content: "next" }];
    expect(normalizeReasoningHistory(messages)).toBe(messages);
  });

  it("does not mutate canonical history when rewriting block indexes", () => {
    const message = ordered([signed("A", 0), text("P", 1), text("Q", 3)], [call("t1", 2)]);
    const snapshot = structuredClone(message);
    normalizeFirst(message);
    expect(message).toEqual(snapshot);
  });

  it("gives the [Thinking removed] placeholder the next blockIndex", () => {
    const [repaired] = removeRejectedReasoning([ordered([signed("A", 4)])]);
    expect(repaired?.content).toEqual([text("[Thinking removed]", 5)]);
  });

  it("re-applies the rules after signature repair", () => {
    const [repaired] = removeRejectedReasoning([
      ordered([signed("A", 0), text("P", 1), text("Q", 3)], [call("t1", 2)]),
    ]);
    expect(requestOrder(repaired)).toEqual(["P", "Q", "t1"]);
  });

  it("keeps the legacy placeholder without a blockIndex", () => {
    const [repaired] = removeRejectedReasoning([
      { role: "assistant", content: [reasoning("A", { signature: "sig_A" })] },
    ]);
    expect(repaired?.content).toEqual([{ type: "text", text: "[Thinking removed]" }]);
  });

  // 签名修复标记之前的有序条目：之后的请求删掉签名思考时，必须和修复那次重发的前缀逐字节相同，
  // 否则又会被拒或缓存断开。两处都调用 removeRejectedReasoning，有序条目都重新执行逐块规则。
  it("keeps ordered entries before a repair marker equal to the repaired retry", () => {
    const beforeRepair: ModelInputMessage[] = [
      { role: "user", content: "first" },
      ordered([signed("A", 0), text("P", 1), signed("B", 2), text("Q", 3)]),
      { role: "user", content: "second" },
      ordered([signed("C", 0), text("R", 1), text("S", 3)], [call("t1", 2)]),
      { role: "user", content: "read", toolCallId: "t1", toolName: "Read" },
    ];
    const repairedRetry = removeRejectedReasoning(normalizeReasoningHistory(beforeRepair));
    const later: ModelInputMessage[] = [
      ...beforeRepair,
      { ...ordered([signed("D", 0), text("done", 1)]), signedReasoningReset: true },
      { role: "user", content: "third" },
    ];
    const snapshot = structuredClone(later);

    const projected = normalizeReasoningHistory(later);

    expect(JSON.stringify(projected.slice(0, beforeRepair.length))).toBe(
      JSON.stringify(repairedRetry),
    );
    expect(requestOrder(projected[1])).toEqual(["P", "Q"]);
    expect(requestOrder(projected[3])).toEqual(["R", "S", "t1"]);
    expect(projected.slice(beforeRepair.length)).toEqual(later.slice(beforeRepair.length));
    expect(later).toEqual(snapshot);
  });
});

describe("thinking signature rejection", () => {
  it.each([
    "signature in thinking block is invalid",
    "thinking block cannot be modified",
    "`thinking` has an invalid signature",
    "redacted_thinking cannot be modified",
    // 经网关转发的真实报错：反引号把 "invalid signature" 隔开，原来的子串匹配认不出。
    'InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: 3cbb4231, ValidationException: messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".',
    "messages.3.content.0: The thinking block is bound to a different conversation.",
    "messages.3.content.0: This thinking block was not created in this conversation.",
  ])("accepts the supported HTTP 400 message: %s", (message) => {
    expect(isThinkingSignatureRejection(apiError(message, 400))).toBe(true);
  });

  it.each([
    apiError("signature in thinking block is invalid", 500),
    apiError("Invalid `signature` in `thinking` block.", 500),
    apiError("unrelated invalid request", 400),
    apiError("thinking budget is invalid", 400),
    apiError("`tool_use` ids must be unique", 400),
  ])("rejects unrelated errors", (error) => {
    expect(isThinkingSignatureRejection(error)).toBe(false);
  });

  it("keeps the first 2000 characters of the provider message and the prefix mismatch header", () => {
    const message = `Invalid \`signature\` in \`thinking\` block. ${"x".repeat(3000)}`;
    expect(
      thinkingSignatureRejectionEvidence(apiError(message, 400), {
        "Anthropic-Thinking-Prefix-Mismatch": "block=messages.1.content.0",
      }),
    ).toEqual({
      providerMessage: message.slice(0, 2000),
      thinkingPrefixMismatch: "block=messages.1.content.0",
    });
    // 没有该响应头时不写字段。
    expect(thinkingSignatureRejectionEvidence(apiError("short", 400), {})).toEqual({
      providerMessage: "short",
    });
  });
});

function assistantWithReasoning(
  content: Extract<ModelInputMessage["content"], unknown[]>,
  model: Pick<ModelInputMessage, "providerId" | "modelId">,
): ModelInputMessage {
  return { role: "assistant", content, ...model };
}

function modelIdentity(input: string): Pick<ModelInputMessage, "providerId" | "modelId"> {
  const separator = input.indexOf("/");
  return {
    providerId: input.slice(0, separator) as never,
    modelId: input.slice(separator + 1) as never,
  };
}

function reasoning(
  text: string,
  anthropic?: Record<string, unknown>,
): Extract<ModelInputMessage["content"], unknown[]>[number] {
  return {
    type: "reasoning",
    text,
    ...(anthropic ? { providerOptions: { anthropic } } : {}),
  };
}

function apiError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
