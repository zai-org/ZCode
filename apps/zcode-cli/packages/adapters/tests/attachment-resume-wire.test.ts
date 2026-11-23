import { png, fixture } from "./attachment-resume-wire-fixture.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  createMessageId,
  type AttachmentStorageMetadata,
  type ModelInputMessage,
  type TurnAttachment,
} from "@zcode/contracts";
import { resolveTurnAttachments } from "../../core/src/runtime/helpers/attachments.js";
import { buildRuntimeUserEntriesFromTurn } from "../../core/src/runtime/helpers/conversation.js";
import { projectMessagesWithMediaAttachmentPaths } from "../../core/src/runtime/helpers/media-attachment-path.js";
import { buildProviderRequestMessages } from "../../core/src/runtime/helpers/provider-request-messages.js";
import { toAiSdkMessages } from "../src/model/transform.js";

const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.7\nfixture").toString("base64")}`;
const scenarios: Array<{ name: string; attachments: TurnAttachment[] }> = [
  { name: "binary path", attachments: [{ type: "file", path: "bundle.zip" }] },
  {
    name: "clipboard path",
    attachments: [{ type: "file", path: "pasted.txt", sourceKind: "clipboard-text" }],
  },
  { name: "PDF", attachments: [{ type: "pdf", filename: "report.pdf", content: pdf }] },
  {
    name: "mixed media",
    attachments: [
      { type: "image", content: png },
      { type: "pdf", filename: "report.pdf", content: pdf },
      { type: "video", content: "data:video/mp4;base64,dmlkZW8=" },
      { type: "image", content: png },
    ],
  },
  { name: "text file", attachments: [{ type: "file", path: "notes.md" }] },
  { name: "inline text", attachments: [{ type: "file", content: "inline notes" }] },
  { name: "no attachment", attachments: [] },
];

async function captureWire(messages: ModelInputMessage[], kind: "anthropic" | "openai") {
  let captured: unknown;
  const fetch = async (_input: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    return Response.json(
      kind === "anthropic"
        ? {
            id: "fixture",
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
    );
  };
  const options = { apiKey: "fixture-key", baseURL: "https://provider.example/v1", fetch };
  const model =
    kind === "anthropic"
      ? createAnthropic(options)("fixture")
      : createOpenAICompatible({ ...options, name: "fixture" })("fixture");
  await generateText({
    model,
    maxRetries: 0,
    messages: toAiSdkMessages(messages, {
      inputFormat: { supportsImage: true, supportsPdf: true, supportsVideo: true },
    }),
  });
  expect(captured).toBeDefined();
  return captured;
}

describe("attachment history across durable cold resume", () => {
  for (const scenario of scenarios) {
    it.each(scenario.attachments.length ? ["Summarize the attachment.", ""] : ["Text only."])(
      `${scenario.name}, prompt=%j: preserves final SDK request`,
      async (prompt) => {
        const f = await fixture();
        try {
          const resolved = await resolveTurnAttachments(scenario.attachments, {
            ...f.runtime,
            traceContext: { traceId: "fixture" },
          });
          f.history.addEntries(buildRuntimeUserEntriesFromTurn(prompt, resolved));
          await f.runtime.persistUserPrompt(createMessageId("first"), prompt, resolved, {
            traceId: "fixture",
          });
          const cold = await f.cold();
          for (const attachment of resolved.filter((a) => a.metadata.storageKind === "local_ref")) {
            const part = cold.messages[0]!.parts.find(
              (p) => p.type === "file" && p.url === attachment.url,
            );
            expect(part).toMatchObject({
              metadata: {
                pathReferenceText:
                  attachment.contentBlock.type === "text"
                    ? attachment.contentBlock.text
                    : undefined,
              },
            });
          }
          for (const useMidConversationSystem of [false, true]) {
            const requests = await Promise.all(
              [f.history, cold.history].map(async (history) => {
                const entries = [
                  ...history.toRuntimeEntries(),
                  { message: { role: "assistant" as const, content: "done" } },
                  {
                    message: { role: "user" as const, content: "Continue." },
                    metadata: { source: "real_user" as const },
                  },
                ];
                const { messages } = buildProviderRequestMessages({
                  entries,
                  useMidConversationSystem,
                  applyCacheControl: true,
                });
                return projectMessagesWithMediaAttachmentPaths(messages, f.artifactStore);
              }),
            );
            for (const provider of ["anthropic", "openai"] as const) {
              expect(await captureWire(requests[1]!, provider)).toEqual(
                await captureWire(requests[0]!, provider),
              );
            }
          }
          expect((await f.cold()).history.toRuntimeEntries()).toEqual(
            cold.history.toRuntimeEntries(),
          );
        } finally {
          await f.close();
        }
      },
    );
  }

  it("keeps local images in submission order even when hydration rebuilds their media source as inline", async () => {
    const f = await fixture();
    try {
      const resolved = await resolveTurnAttachments(
        [
          { type: "image", content: png },
          { type: "image", path: "local.png" },
          { type: "pdf", content: pdf, filename: "report.pdf" },
        ],
        { ...f.runtime, traceContext: { traceId: "fixture" } },
      );
      f.history.addEntries(buildRuntimeUserEntriesFromTurn("Compare.", resolved));
      await f.runtime.persistUserPrompt(createMessageId("mixed-local"), "Compare.", resolved, {
        traceId: "fixture",
      });
      const cold = await f.cold();
      // 这里只比较媒体与正文合同；local path 到 artifact 派生 path 的既有投影单独测试。
      const requests = [f.history, cold.history].map(
        (h) => buildProviderRequestMessages({ entries: h.toRuntimeEntries() }).messages,
      );
      const transformOptions = {
        inputFormat: { supportsImage: true, supportsPdf: true, supportsVideo: true },
      };
      const first = toAiSdkMessages(requests[0]!, transformOptions);
      expect(toAiSdkMessages(requests[1]!, transformOptions)).toEqual(first);
      const user = requests[0]!.find((m) => m.role === "user")!;
      expect(Array.isArray(user.content) && user.content.map((b) => b.type)).toEqual([
        "text",
        "image",
        "file",
        "image",
      ]);
    } finally {
      await f.close();
    }
  });

  it.each([undefined, 42, { text: "invalid" }])(
    "keeps the legacy placeholder when saved path text is %j",
    async (pathReferenceText) => {
      const f = await fixture();
      try {
        const resolved = await resolveTurnAttachments([{ type: "file", path: "bundle.zip" }], {
          ...f.runtime,
          traceContext: { traceId: "fixture" },
        });
        resolved[0]!.metadata = {
          ...resolved[0]!.metadata,
          pathReferenceText,
        } as AttachmentStorageMetadata;
        await f.runtime.persistUserPrompt(createMessageId("legacy"), "Prompt", resolved, {
          traceId: "fixture",
        });
        const cold = await f.cold();
        expect(
          buildProviderRequestMessages({ entries: cold.history.toRuntimeEntries() }).messages.at(-1)
            ?.content,
        ).toEqual([
          { type: "text", text: "Prompt" },
          { type: "text", text: "[Attached application/octet-stream: bundle.zip]" },
        ]);
      } finally {
        await f.close();
      }
    },
  );
});
