import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { startToolSearchRuntimeDriver } from "#e2e/helpers/toolsearch-runtime-driver";
import {
  isToolSearchCompact,
  toolSearchBlocks,
  type ToolSearchRequest,
} from "#e2e/helpers/toolsearch-provider";
import {
  contentText,
  definitionsFor,
  loadedCount,
  replyStage,
  resultFor,
  runFeedback,
  saveSearchEvidence,
} from "#e2e/helpers/toolsearch-feedback";

const caseName = "conversation-session-toolsearch-local-feedback";
const target = "mcp__catalog__lookup";
async function setup() {
  const fixture = await createToolSearchCliFixture(caseName, { modelIo: true });
  await fixture.configure({
    features: { memory: false, skill: false, subagent: false, mcp: true },
    mcp: {
      servers: {
        catalog: {
          type: "stdio",
          command: process.execPath,
          args: [resolve("test/e2e/fixtures/mcp/toolsearch-server.mjs")],
          env: { E2E_TOOLSEARCH_MCP_LOG: join(fixture.root, "executions.jsonl") },
        },
      },
    },
  });
  return fixture;
}
function withoutCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCache);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, entry]) => [key, withoutCache(entry)]),
    );
  return value;
}
function assertLoadedReminder(body: ToolSearchRequest, id: string, names: string[]) {
  const text = contentText(resultFor(body, id).content);
  expect(text.match(/<system-reminder>\nLoaded: /g) ?? []).toHaveLength(names.length ? 1 : 0);
  if (!names.length) return;
  const action = names.length === 1 ? "Call it now" : "Call them now";
  const reminder = `<system-reminder>\nLoaded: ${names.join(", ")}. ${action} with DeferredToolCall {"name":"<tool name>","input":{...}}, using the exact tool name and filling input according to its schema above. No additional LocalToolSearch is needed before calling these tools.\n</system-reminder>`;
  expect(text).toContain(reminder);
  expect(text.indexOf(reminder)).toBeGreaterThan(text.lastIndexOf("</functions>"));
}
function assertFeedback(bodies: ToolSearchRequest[]) {
  expect(bodies.map(loadedCount)).toEqual([0, 0, 0, 0, 0, 0]);
  const body = bodies.at(-1)!;
  expect(definitionsFor(body, "first")).toEqual([target]);
  expect(definitionsFor(body, "mixed")).toEqual(["TodoRead"]);
  expect(contentText(resultFor(body, "mixed").content)).toContain("already available");
  expect(definitionsFor(body, "repeat")).toEqual([]);
  expect(contentText(resultFor(body, "repeat").content)).toContain("DeferredToolCall");
  for (const id of ["mixed", "repeat"]) {
    const text = contentText(resultFor(body, id).content);
    expect(text).toContain("<system-reminder>\nTool definitions already available");
    expect(text).toMatch(/Searching again does not execute them\.\n<\/system-reminder>$/);
    expect(text.match(/<system-reminder>/g)).toHaveLength(id === "mixed" ? 2 : 1);
  }
  expect(definitionsFor(body, "resident")).toEqual(["Read"]);
  expect(definitionsFor(body, "parallel_one")).toEqual(["TaskOutput"]);
  expect(definitionsFor(body, "parallel_two")).toEqual(["TaskOutput"]);
  assertLoadedReminder(body, "first", [target]);
  assertLoadedReminder(body, "mixed", ["TodoRead"]);
  assertLoadedReminder(body, "repeat", []);
  assertLoadedReminder(body, "resident", []);
  assertLoadedReminder(body, "parallel_one", ["TaskOutput"]);
  assertLoadedReminder(body, "parallel_two", ["TaskOutput"]);
  for (const request of bodies) {
    expect(request.tools).toEqual(bodies[0]!.tools);
    expect(JSON.stringify(request)).not.toContain('"defer_loading"');
    const blocks = toolSearchBlocks(request);
    for (const block of blocks.filter((b) => b.type === "tool_result")) {
      expect(
        blocks.filter((b) => b.type === "tool_use" && b.id === block.tool_use_id),
      ).toHaveLength(1);
      expect(contentText(block.content)).not.toContain("Tool loaded.");
    }
  }
  for (let i = 1; i < bodies.length; i++) {
    const before = bodies[i - 1]!.messages;
    expect(withoutCache(bodies[i]!.messages.slice(0, before.length))).toEqual(withoutCache(before));
  }
}

describe("Local ToolSearch 逐项反馈与提升（真实进程 / HTTP）", () => {
  for (const streaming of ["on", "off"] as const) {
    it(`TS13-REPEAT: 新增、重复、常驻和并行结果 ${streaming}`, async function () {
      this.timeout(120_000);
      const fixture = await setup();
      const driver =
        streaming === "off"
          ? await startToolSearchRuntimeDriver(fixture, streaming, {
              mode: "local",
              recording: true,
            })
          : undefined;
      try {
        const stages = ["first", "mixed", "repeat", "resident", "parallel", "done"];
        let calls = 0;
        fixture.setResponse((body, response) =>
          replyStage(fixture, body, response, stages[calls++] ?? "done"),
        );
        const sessionId = driver
          ? await driver.turn("E2E_TOOLSEARCH_LOCAL_FEEDBACK_MATRIX")
          : await runFeedback(fixture, "local", "E2E_TOOLSEARCH_LOCAL_FEEDBACK_MATRIX");
        expect(fixture.requests).toHaveLength(6);
        const bodies = fixture.requests.map((r) => r.body);
        expect(bodies.every((b) => Boolean(b.stream) === (streaming === "on"))).toBe(true);
        assertFeedback(bodies);
        if (typeof sessionId === "string") {
          // 新 CLI 进程恢复真实 SQLite，再搜索不丢失此前可见定义或追加成功提示。
          let coldCalls = 0;
          fixture.setResponse((body, response) =>
            replyStage(fixture, body, response, coldCalls++ === 0 ? "cold-repeat" : "done"),
          );
          await runFeedback(fixture, "local", "E2E_TOOLSEARCH_LOCAL_FEEDBACK_RESUME", [
            "--resume",
            sessionId,
          ]);
          const cold = fixture.requests.at(-1)!.body;
          expect(loadedCount(cold)).toBe(0);
          expect(definitionsFor(cold, "cold_repeat")).toEqual([]);
          expect(contentText(resultFor(cold, "cold_repeat").content)).toContain(
            "<system-reminder>\nTool definitions already available",
          );
          expect(cold.tools).toEqual(bodies[0]!.tools);
          assertLoadedReminder(cold, "cold_repeat", []);
          assertLoadedReminder(cold, "first", [target]);
          expect(resultFor(cold, "first").content).toEqual(
            resultFor(bodies.at(-1)!, "first").content,
          );
        }
      } finally {
        await driver?.close();
        try {
          await saveSearchEvidence(`local-feedback-${streaming}`, fixture);
        } finally {
          await fixture.close();
        }
      }
    });

    it(`TS13-PROMOTE: compact 后普通调用与包装拒绝 ${streaming}`, async function () {
      this.timeout(120_000);
      const fixture = await setup();
      const driver = await startToolSearchRuntimeDriver(fixture, streaming, {
        mode: "local",
        recording: true,
      });
      try {
        let stages = ["first", "done", "done"];
        let calls = 0;
        fixture.setResponse((body, response) =>
          replyStage(
            fixture,
            body,
            response,
            isToolSearchCompact(body) ? "summary" : (stages[calls++] ?? "done"),
          ),
        );
        await driver.turn("E2E_TOOLSEARCH_LOCAL_FEEDBACK_LOAD");
        await driver.turn("E2E_TOOLSEARCH_LOCAL_FEEDBACK_WARMUP");
        await driver.turn("/compact");
        const start = fixture.requests.length;
        calls = 0;
        stages = [
          "promoted-wrapper",
          "promoted-direct",
          "promoted-select",
          "new-search",
          "new-wrapper",
          "done",
        ];
        await driver.turn("E2E_TOOLSEARCH_LOCAL_FEEDBACK_PROMOTED");
        const after = fixture.requests.slice(start).map((r) => r.body);
        expect(after).toHaveLength(6);
        for (const body of after) {
          expect(body.tools?.find((t) => t.name === target)).toBeDefined();
          expect(body.tools?.find((t) => t.name === target)?.defer_loading).toBeUndefined();
          expect(body.tools?.some((t) => t.name === "TodoRead")).toBe(false);
          expect(body.tools?.some((t) => t.name === "DeferredToolCall")).toBe(true);
        }
        expect(resultFor(after[1]!, "promoted_wrapper").is_error).toBe(true);
        expect(contentText(resultFor(after[1]!, "promoted_wrapper").content)).toContain("directly");
        expect(contentText(resultFor(after[2]!, "promoted_direct").content)).toContain(
          "E2E_TOOLSEARCH_MCP_RESULT:ordinary",
        );
        expect(definitionsFor(after[3]!, "promoted_select")).toEqual([target]);
        expect(definitionsFor(after[4]!, "new_search")).toEqual(["TodoRead"]);
        assertLoadedReminder(after[3]!, "promoted_select", []);
        assertLoadedReminder(after[4]!, "new_search", ["TodoRead"]);
        expect(resultFor(after[5]!, "new_wrapper").is_error).not.toBe(true);
        expect(after.map(loadedCount)).toEqual([0, 0, 0, 0, 0, 0]);
        const executions = (await readFile(join(fixture.root, "executions.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(executions).toEqual([{ name: "lookup", value: "ordinary" }]);
        await driver.turn("/compact");
        await driver.turn("E2E_TOOLSEARCH_LOCAL_FEEDBACK_SECOND_COMPACT");
        expect(fixture.requests.at(-1)!.body.tools?.map((t) => t.name)).toEqual(
          expect.arrayContaining([target, "TodoRead", "LocalToolSearch", "DeferredToolCall"]),
        );
      } finally {
        await driver.close();
        try {
          await saveSearchEvidence(`local-promote-${streaming}`, fixture);
        } finally {
          await fixture.close();
        }
      }
    });
  }
});
