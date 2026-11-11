import { resolve } from "node:path";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { startToolSearchRuntimeDriver } from "#e2e/helpers/toolsearch-runtime-driver";
import { isToolSearchCompact, type ToolSearchRequest } from "#e2e/helpers/toolsearch-provider";
import {
  contentText,
  loadedCount,
  recordingCase,
  replyStage,
  saveSearchEvidence,
} from "#e2e/helpers/toolsearch-feedback";

type Block = {
  type: string;
  text?: string;
  toolName?: string;
  tool_name?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
};
type Message = {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
};
type RecordRequest = { querySource?: string; messages: Message[] };
const continuePrefix = "Output token limit hit. Resume directly";

function normalizedContent(content: unknown): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return content;
  return content.map((block: Block) =>
    block.type === "tool_reference"
      ? { type: "tool_reference", tool_name: block.toolName ?? block.tool_name }
      : { type: block.type, text: block.text },
  );
}

// 比较 ToolSearch 相关有序片段，不把 adapter 的相邻 user 合并或 cache_control 当作差异。
function searchTrace(messages: readonly Message[]): unknown[] {
  const trace: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      trace.push({ result: message.toolCallId, content: normalizedContent(message.content) });
      continue;
    }
    const blocks: Block[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content as Block[]);
    for (const block of blocks) {
      if (block.type === "tool_result")
        trace.push({ result: block.tool_use_id, content: normalizedContent(block.content) });
      if (block.type === "tool_use")
        trace.push({ call: block.id, name: block.name, input: block.input });
      if (block.type === "text" && block.text === "Tool loaded.")
        trace.push({ loaded: message.role });
      if (block.type === "text" && block.text?.startsWith(continuePrefix))
        trace.push({ continuation: true });
    }
    for (const call of message.toolCalls ?? [])
      trace.push({ call: call.id, name: call.name, input: call.input });
  }
  return trace;
}

describe("ToolSearch Continue 与 compact 请求记录（Runtime / HTTP 集成）", () => {
  for (const mode of ["native", "local"] as const) {
    for (const streaming of ["on", "off"] as const) {
      for (const trigger of ["none", "auto", "reactive"] as const) {
        it(`TS12-RECORD: ${mode}/${streaming}/${trigger}`, async function () {
          this.timeout(120_000);
          const fixture = await createToolSearchCliFixture(recordingCase, { modelIo: true });
          await fixture.configure({
            features: { memory: false, skill: false, subagent: false, mcp: true },
            mcp: {
              servers: {
                catalog: {
                  type: "stdio",
                  command: process.execPath,
                  args: [resolve("test/e2e/fixtures/mcp/toolsearch-server.mjs")],
                },
              },
            },
          });
          const driver = await startToolSearchRuntimeDriver(fixture, streaming, {
            mode,
            recording: true,
            autoCompact: trigger === "auto",
          });
          let records: unknown;
          let history: unknown;
          try {
            let calls = 0;
            fixture.setResponse((body, response) => {
              let stage = "done";
              if (isToolSearchCompact(body)) stage = "summary";
              else {
                calls++;
                if (calls === 1) stage = "search";
                else if (trigger === "none" && calls <= 4) stage = "partial";
                else if (trigger !== "none" && calls === 4) stage = "partial";
                else if (trigger !== "none" && calls === 5)
                  stage = trigger === "auto" ? "pressure" : "partial";
                else if (trigger === "reactive" && calls === 6) {
                  fixture.reply(body, response, "context-error");
                  return;
                }
              }
              replyStage(fixture, body, response, stage);
            });
            await driver.turn("E2E_TOOLSEARCH_RECORD_SEARCH");
            if (trigger !== "none") await driver.turn("E2E_TOOLSEARCH_RECORD_WARMUP");
            await driver.turn("E2E_TOOLSEARCH_RECORD_CONTINUE");
            records = await driver.records();
            history = await driver.history();
            const actual = fixture.requests.map(({ body }) => body);
            const stored = records as RecordRequest[];
            expect(
              actual
                .filter((request) => !isToolSearchCompact(request))
                .every((request) => (request.stream === true) === (streaming === "on")),
            ).toBe(true);
            expect(stored).toHaveLength(actual.length);
            for (const [index, request] of actual.entries()) {
              const expected = searchTrace(request.messages).filter(
                (item) => !(item as { continuation?: boolean }).continuation,
              );
              expect(searchTrace(stored[index]!.messages)).toEqual(expected);
            }
            if (trigger === "none") {
              expect(actual.map(loadedCount)).toEqual(
                mode === "native" ? [0, 1, 1, 1, 1, 1] : [0, 0, 0, 0, 0, 0],
              );
              expect(actual.map(continueCount)).toEqual([0, 0, 1, 2, 3, 0]);
            } else {
              const compact = actual.filter(isToolSearchCompact);
              expect(compact).toHaveLength(1);
              expect(continueCount(compact[0]!)).toBeGreaterThan(0);
              expect(loadedCount(compact[0]!)).toBe(mode === "native" ? 1 : 0);
              const record = stored.filter((item) => item.querySource === "compact");
              expect(record).toHaveLength(1);
              expect(
                searchTrace(record[0]!.messages).filter(
                  (item) => item !== null && typeof item === "object" && "loaded" in item,
                ),
              ).toEqual(mode === "native" ? [{ loaded: "user" }] : []);
            }
            expect(JSON.stringify(history)).not.toContain("Tool loaded.");
            expect(JSON.stringify(history)).not.toContain(continuePrefix);
            expect(JSON.stringify(records)).not.toContain(continuePrefix);
            expect(JSON.stringify(records)).not.toContain("loadedToolCallIds");
          } finally {
            try {
              await saveSearchEvidence(`record-${mode}-${streaming}-${trigger}`, fixture, {
                records,
                history,
              });
            } finally {
              await driver.close();
              await fixture.close();
            }
          }
        });
      }
    }
  }
});

function continueCount(body: ToolSearchRequest): number {
  return body.messages.reduce(
    (total, message) => total + contentText(message.content).split(continuePrefix).length - 1,
    0,
  );
}
