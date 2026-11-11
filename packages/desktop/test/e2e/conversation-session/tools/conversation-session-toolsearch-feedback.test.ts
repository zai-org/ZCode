import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { toolSearchBlocks } from "#e2e/helpers/toolsearch-provider";
import {
  contentText,
  definitionsFor,
  feedbackCase,
  loadedCount,
  replyStage,
  resultFor,
  runFeedback,
  saveSearchEvidence,
} from "#e2e/helpers/toolsearch-feedback";

describe("ToolSearch 结果、纠错、提醒和 MCP 短名（真实 CLI / HTTP）", () => {
  for (const mode of ["native", "local"] as const) {
    it(`TS12-RESULT: 并行结果、失败与失效引用 ${mode}`, async function () {
      this.timeout(120_000);
      const fixture = await createToolSearchCliFixture(feedbackCase, { modelIo: true });
      try {
        fixture.setResponse((body, response) =>
          replyStage(
            fixture,
            body,
            response,
            toolSearchBlocks(body).some((block) => block.tool_use_id === "batch_one")
              ? "done"
              : "batch",
          ),
        );
        const sessionId = await runFeedback(fixture, mode, "E2E_TOOLSEARCH_FEEDBACK_BATCH");
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests.every(({ body }) => body.stream === true)).toBe(true);
        const body = fixture.requests[1]!.body;
        expect(definitionsFor(body, "batch_one")).toEqual(["TaskOutput", "TodoRead"]);
        expect(definitionsFor(body, "batch_two")).toEqual(["TodoRead"]);
        expect(contentText(resultFor(body, "batch_empty").content)).toContain("No matching");
        expect(resultFor(body, "batch_bad").is_error).toBe(true);
        expect(loadedCount(body)).toBe(mode === "native" ? 2 : 0);
        const blocks = toolSearchBlocks(body);
        const resultIndices = blocks.flatMap((block, i) =>
          block.type === "tool_result" ? [i] : [],
        );
        expect(resultIndices).toHaveLength(4);
        expect(resultIndices).toEqual(Array.from({ length: 4 }, (_, i) => resultIndices[0]! + i));
        const hintIndex = blocks.findIndex(
          (block) => block.type === "text" && block.text?.includes("Tool loaded."),
        );
        if (mode === "native") expect(hintIndex).toBeGreaterThan(resultIndices.at(-1)!);
        else expect(hintIndex).toBe(-1);
        for (const id of ["batch_one", "batch_two", "batch_empty", "batch_bad"])
          expect(JSON.stringify(resultFor(body, id).content)).not.toContain("Tool loaded.");

        fixture.setResponse((request, response) => replyStage(fixture, request, response, "done"));
        const before = fixture.requests.length;
        await runFeedback(fixture, mode, "E2E_TOOLSEARCH_FEEDBACK_UNAVAILABLE", [
          "--resume",
          sessionId,
          "--disallowedTools=TaskOutput,TodoRead",
        ]);
        const cold = fixture.requests[before]!.body;
        expect(loadedCount(cold)).toBe(0);
        expect(
          cold.tools?.some(
            (tool) => tool.name === (mode === "local" ? "LocalToolSearch" : "ToolSearch"),
          ),
        ).toBe(true);
        for (const id of ["batch_one", "batch_two"]) {
          expect(contentText(resultFor(cold, id).content)).toContain("tools no longer available");
          expect(definitionsFor(cold, id)).toEqual([]);
        }
        const db = new DatabaseSync(join(fixture.root, "session.sqlite"), { readOnly: true });
        try {
          const rows = db
            .prepare(
              "select data from part where json_extract(data, '$.callID') in ('batch_one', 'batch_two')",
            )
            .all();
          expect(rows).toHaveLength(2);
          expect(JSON.stringify(rows)).toContain("tool_reference");
          expect(JSON.stringify(rows)).not.toContain("Tool loaded.");
        } finally {
          db.close();
        }
      } finally {
        try {
          await saveSearchEvidence(`result-${mode}`, fixture);
        } finally {
          await fixture.close();
        }
      }
    });

    it(`TS12-VALIDATION: 未发现工具的完整纠错和执行 ${mode}`, async function () {
      this.timeout(120_000);
      const fixture = await createToolSearchCliFixture(feedbackCase, { modelIo: true });
      try {
        fixture.setResponse((body, response) => replyStage(fixture, body, response, "done"));
        const seed = await fixture.start(["-p", "E2E_TOOLSEARCH_FEEDBACK_SCHEMA"]).done;
        expect(seed.code).toBe(0);
        const schema = fixture.requests[0]!.body.tools!.find(
          (tool) => tool.name === "TodoRead",
        )!.input_schema;
        const before = fixture.requests.length;
        fixture.setResponse((body, response) => {
          const ids = new Set(
            toolSearchBlocks(body)
              .filter((block) => block.type === "tool_result")
              .map((block) => block.tool_use_id),
          );
          const stage = ids.has("good")
            ? "done"
            : ids.has("loaded")
              ? `${mode}-good`
              : ids.has("discover")
                ? `${mode}-loaded`
                : ids.has("unloaded")
                  ? "discover"
                  : `${mode}-unloaded`;
          replyStage(fixture, body, response, stage);
        });
        await runFeedback(fixture, mode, "E2E_TOOLSEARCH_FEEDBACK_VALIDATE");
        const requests = fixture.requests.slice(before);
        expect(requests).toHaveLength(5);
        expect(requests.every(({ body }) => body.stream === true)).toBe(true);
        expect(requests[0]!.body.tools?.some((tool) => tool.name === "TodoRead")).toBe(false);
        const unloaded = resultFor(requests[1]!.body, "unloaded");
        expect(unloaded.is_error).toBe(true);
        const error = contentText(unloaded.content);
        expect(error).toContain(
          `Load the tool first: call ${mode === "local" ? "LocalToolSearch" : "ToolSearch"} with query "select:TodoRead"`,
        );
        expect(
          JSON.parse(
            error.split("For reference, this tool's input schema is: ")[1]!.split("\n")[0]!,
          ),
        ).toEqual(schema);
        if (mode === "local")
          expect(error).toContain('Call DeferredToolCall with {name: "TodoRead", input: {...}}.');
        else expect(error).not.toContain("DeferredToolCall");
        expect(loadedCount(requests[1]!.body)).toBe(0);
        const known = contentText(resultFor(requests[3]!.body, "loaded").content);
        expect(known).toContain("InputValidationError");
        expect(known).not.toContain("select:TodoRead");
        expect(known).not.toContain("For reference, this tool's input schema is:");
        expect(resultFor(requests[4]!.body, "good").is_error).not.toBe(true);
        const db = new DatabaseSync(join(fixture.root, "session.sqlite"), { readOnly: true });
        try {
          const rows = db
            .prepare("select data from part where json_extract(data, '$.callID') = 'good'")
            .all() as { data: string }[];
          expect(rows).toHaveLength(1);
          const part = JSON.parse(rows[0]!.data);
          expect(part).toMatchObject({
            tool: "TodoRead",
            state: { status: "completed", output: '{"todos":[]}' },
          });
          // toMatchObject 里的 {} 能匹配任何对象；严格比较才能发现 Local 包装字段混入 input。
          expect(part.state.input).toEqual({});
        } finally {
          db.close();
        }
      } finally {
        try {
          await saveSearchEvidence(`validation-${mode}`, fixture);
        } finally {
          await fixture.close();
        }
      }
    });

    for (const mcs of [false, true]) {
      it(`TS12-REMINDER: 公告 wire 和旧历史冷恢复 ${mode}/MCS=${mcs}`, async function () {
        this.timeout(120_000);
        const fixture = await createToolSearchCliFixture(feedbackCase, { modelIo: true });
        try {
          await fixture.select("anthropic-messages", { supportsMidConversationSystem: mcs });
          fixture.setResponse((body, response) => replyStage(fixture, body, response, "done"));
          const sessionId = await runFeedback(
            fixture,
            mode,
            "E2E_TOOLSEARCH_FEEDBACK_ANNOUNCEMENT",
          );
          // 完成首轮后重启 CLI，验证旧公告恢复时仍沿用对应的 MCS 投影。
          const db = new DatabaseSync(join(fixture.root, "session.sqlite"));
          let announcement = "";
          try {
            const rows = db
              .prepare(
                "select id, data from part where json_extract(data, '$.metadata.runtimeMessage.toolSearchAnnouncement') is not null",
              )
              .all() as { id: string; data: string }[];
            expect(rows).toHaveLength(1);
            const part = JSON.parse(rows[0]!.data);
            announcement = part.text;
            expect(part.metadata.runtimeMessage.source).toBe("tool_search_announcement");
            // 旧记录 fixture 只改变存储表示，不改生产恢复入口。
            part.text = `<system-reminder>\n${part.text}\n</system-reminder>`;
            part.metadata.runtimeMessage.source = "legacy_synthetic";
            db.prepare("update part set data = ? where id = ?").run(
              JSON.stringify(part),
              rows[0]!.id,
            );
          } finally {
            db.close();
          }
          await runFeedback(fixture, mode, "E2E_TOOLSEARCH_FEEDBACK_COLD", ["--resume", sessionId]);
          const before = fixture.requests[0]!.body;
          const after = fixture.requests[1]!.body;
          for (const body of [before, after]) {
            const serialized = JSON.stringify(body);
            expect(serialized).not.toContain("toolSearchAnnouncement");
            expect(serialized).not.toContain("tool_search_announcement");
            const messages = body.messages.filter((message) =>
              contentText(message.content).includes(announcement),
            );
            expect(messages).toHaveLength(1);
            expect(messages[0]!.role).toBe(mcs ? "system" : "user");
            const announcementBlocks = messages
              .flatMap(({ content }) =>
                typeof content === "string"
                  ? [content]
                  : content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text ?? ""),
              )
              .filter((text) => text.includes(announcement));
            expect(announcementBlocks).toHaveLength(1);
            if (mcs) {
              // MCS 下同一段 user run 的 system 文本合成一条、以空行分隔（环境、模型、日期公告可能并入）；
              // 公告必须是其中完整的一段。
              expect(`\n\n${announcementBlocks[0]}\n\n`).toContain(`\n\n${announcement}\n\n`);
            } else {
              expect(announcementBlocks[0]).toBe(
                `<system-reminder>\n${announcement}\n</system-reminder>`,
              );
            }
          }
          const readDb = new DatabaseSync(join(fixture.root, "session.sqlite"), { readOnly: true });
          try {
            expect(
              readDb
                .prepare(
                  "select count(*) as count from part where json_extract(data, '$.metadata.runtimeMessage.toolSearchAnnouncement') is not null",
                )
                .get(),
            ).toMatchObject({ count: 1 });
          } finally {
            readDb.close();
          }
        } finally {
          try {
            await saveSearchEvidence(`reminder-${mode}-${mcs}`, fixture);
          } finally {
            await fixture.close();
          }
        }
      });
    }

    it(`TS12-MCP: 原始短名、规范化、冲突和作用域 ${mode}`, async function () {
      this.timeout(120_000);
      const fixture = await createToolSearchCliFixture(feedbackCase, { modelIo: true });
      try {
        const callLog = join(fixture.root, "mcp-calls.ndjson");
        const server = {
          type: "stdio",
          command: process.execPath,
          args: [resolve("test/e2e/fixtures/mcp/toolsearch-server.mjs")],
          env: { E2E_TOOLSEARCH_SHORT_NAMES: "1", E2E_TOOLSEARCH_MCP_LOG: callLog },
        };
        await fixture.configure({
          features: { memory: false, skill: false, subagent: false, mcp: true },
          mcp: { servers: { one: server, two: server } },
        });
        fixture.setResponse((body, response) =>
          replyStage(
            fixture,
            body,
            response,
            toolSearchBlocks(body).some((block) => block.tool_use_id === "raw") ? "done" : "mcp",
          ),
        );
        await runFeedback(fixture, mode, "E2E_TOOLSEARCH_FEEDBACK_MCP", [
          "--disallowedTools=mcp__two__blocked",
        ]);
        expect(fixture.requests).toHaveLength(2);
        const body = fixture.requests[1]!.body;
        for (const id of ["raw", "normalized"])
          expect(definitionsFor(body, id)).toEqual(["mcp__one__look_up", "mcp__two__look_up"]);
        expect(definitionsFor(body, "canonical")).toEqual(["TodoRead"]);
        expect(definitionsFor(body, "alias")).toEqual(["TaskStop"]);
        expect(definitionsFor(body, "scoped")).toEqual(["mcp__one__blocked"]);
        expect(loadedCount(body)).toBe(mode === "native" ? 5 : 0);
        await expect(readFile(callLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        try {
          await saveSearchEvidence(`mcp-${mode}`, fixture);
        } finally {
          await fixture.close();
        }
      }
    });
  }
});
