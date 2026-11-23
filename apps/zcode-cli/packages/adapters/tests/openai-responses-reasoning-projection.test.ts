import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import { toAiSdkMessages } from "../src/model/index.js";

type TransformOptions = NonNullable<Parameters<typeof toAiSdkMessages>[1]>;

const STATELESS_RESPONSES: TransformOptions = {
  providerKind: "openai",
  providerOptions: { apiFormat: "openai-responses", openai: { store: false } },
};

describe("OpenAI Responses reasoning 回放投影", () => {
  it("按 itemId 保留带密文的 item，删掉 null 和空串密文", () => {
    // 被删的块都排在输出项之前，结果不依赖孤立 reasoning 的裁剪。
    const parts = assistantParts(
      [
        // 流式只有最后一段摘要带密文：同一 itemId 的前一段也要保留。
        reasoning(0, "rs_1", "r1 part 1"),
        reasoning(1, "rs_1", "r1 part 2", "enc_1"),
        // 旧历史和取消的流没有密文；空串密文 SDK 不会删，会原样发出。
        reasoning(3, "rs_0", "legacy", null),
        reasoning(4, "rs_e", "empty", ""),
        { type: "text", text: "answer", blockIndex: 5 },
        reasoning(6, "rs_2", "r2", "enc_2"),
      ],
      [toolCall("c1", 2), toolCall("c2", 7)],
      STATELESS_RESPONSES,
    );

    expect(parts).toEqual([
      reasoningPart("rs_1", "r1 part 1"),
      reasoningPart("rs_1", "r1 part 2", "enc_1"),
      toolCallPart("c1"),
      { type: "text", text: "answer" },
      reasoningPart("rs_2", "r2", "enc_2"),
      toolCallPart("c2"),
    ]);
  });

  it("store 不是 false 时带密文的 reasoning 也删掉", () => {
    const parts = assistantParts(
      [reasoning(0, "rs_1", "thought", "enc_1"), { type: "text", text: "answer", blockIndex: 1 }],
      [],
      { providerKind: "openai", providerOptions: { apiFormat: "openai-responses" } },
    );

    expect(parts).toEqual([{ type: "text", text: "answer" }]);
  });

  it("有序条目里删掉末尾没有输出项的 reasoning", () => {
    const parts = assistantParts(
      [reasoning(0, "rs_a", "before call", "enc_a"), reasoning(2, "rs_b", "after call", "enc_b")],
      [toolCall("c1", 1)],
      STATELESS_RESPONSES,
    );

    expect(parts).toEqual([reasoningPart("rs_a", "before call", "enc_a"), toolCallPart("c1")]);
  });

  it("有序条目里只有 reasoning 的回复整条删空", () => {
    const parts = assistantParts(
      [reasoning(0, "rs_c", "part 1"), reasoning(1, "rs_c", "part 2", "enc_c")],
      [],
      STATELESS_RESPONSES,
    );

    expect(parts).toEqual([]);
  });

  it.each<[string, TransformOptions]>([
    ["Anthropic", { providerKind: "anthropic" }],
    [
      "OpenAI-compatible",
      {
        providerKind: "openai-compatible",
        providerOptions: { apiFormat: "openai-chat-completions" },
      },
    ],
    [
      "previousResponseId",
      {
        providerKind: "openai",
        providerOptions: {
          apiFormat: "openai-responses",
          openai: { previousResponseId: "resp_1" },
        },
      },
    ],
  ])("%s 边界不裁剪末尾 reasoning", (_name, options) => {
    const parts = assistantParts(
      [reasoning(0, "rs_a", "before call", "enc_a"), reasoning(2, "rs_b", "after call", "enc_b")],
      [toolCall("c1", 1)],
      options,
    );

    expect(parts.map((part) => part.type)).toEqual(["reasoning", "tool-call", "reasoning"]);
  });
});

function assistantParts(
  content: Extract<ModelInputMessage["content"], unknown[]>,
  toolCalls: NonNullable<ModelInputMessage["toolCalls"]>,
  options: TransformOptions,
): Array<{ type: string }> {
  const [assistant] = toAiSdkMessages([{ role: "assistant", content, toolCalls }], options);
  return assistant?.content as Array<{ type: string }>;
}

function reasoning(blockIndex: number, itemId: string, text: string, encrypted?: string | null) {
  return {
    type: "reasoning" as const,
    text,
    blockIndex,
    providerOptions: {
      openai: {
        itemId,
        ...(encrypted === undefined ? {} : { reasoningEncryptedContent: encrypted }),
      },
    },
  };
}

function reasoningPart(itemId: string, text: string, encrypted?: string) {
  return {
    type: "reasoning",
    text,
    providerOptions: {
      openai: {
        itemId,
        ...(encrypted === undefined ? {} : { reasoningEncryptedContent: encrypted }),
      },
    },
  };
}

function toolCall(id: string, blockIndex: number) {
  return { id, name: "Read", input: {}, blockIndex };
}

function toolCallPart(id: string) {
  return { type: "tool-call", toolCallId: id, toolName: "Read", input: {} };
}
