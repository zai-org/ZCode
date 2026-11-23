import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { TOOLSEARCH_CALL_ID, toolSearchBlocks } from "#e2e/helpers/toolsearch-provider";
import { contentText, resultFor } from "#e2e/helpers/toolsearch-feedback";

interface StoredPart {
  id: string;
  session_id: string;
  data: string;
}

describe("ToolSearch 冷恢复异常与当前权限（真实 CLI / SQLite）", () => {
  for (const metadata of ["legacy", "corrupt"] as const) {
    it(`TS05: ${metadata} metadata 沿旧文本路径恢复，不伪造发现`, async function () {
      this.timeout(90_000);
      const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-recovery");
      try {
        const run = await fixture.start([
          "--toolsearch-mode",
          "native",
          "-p",
          "E2E_TOOLSEARCH_INITIAL 搜索。",
        ]).done;
        expect(run.code).toBe(0);
        const { sessionId } = JSON.parse(run.stdout) as { sessionId: string };
        const db = new DatabaseSync(join(fixture.root, "session.sqlite"));
        try {
          const row = db
            .prepare("select id, data from part where json_extract(data, '$.callID') = ?")
            .get(TOOLSEARCH_CALL_ID) as unknown as StoredPart;
          expect(row).toBeDefined();
          const part = JSON.parse(row.data);
          expect(part.state.metadata.modelContent).toEqual([
            { type: "tool_reference", toolName: "TodoRead" },
          ]);
          if (metadata === "legacy") delete part.state.metadata.modelContent;
          else part.state.metadata.modelContent = [{ type: "tool_reference", toolName: 7 }];
          db.prepare("update part set data = ? where id = ?").run(JSON.stringify(part), row.id);
        } finally {
          db.close();
        }
        const start = fixture.requests.length;
        const cold = await fixture.start([
          "--toolsearch-mode",
          "native",
          "--resume",
          sessionId,
          "-p",
          "E2E_TOOLSEARCH_COLD 检查恢复。",
        ]).done;
        expect(cold.code).toBe(0);
        const first = fixture.requests.slice(start).find(({ body }) => body.tools?.length)!.body;
        expect(first.tools?.some((tool) => tool.name === "TodoRead")).toBe(false);
        expect(JSON.stringify(first.messages)).not.toContain('"type":"tool_reference"');
        expect(JSON.stringify(first.messages)).toContain(TOOLSEARCH_CALL_ID);
      } finally {
        await fixture.close();
      }
    });
  }

  it("TS04: MCP 禁用保留历史定义但拒绝执行，恢复后按 live schema 校验", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-recovery");
    const name = "mcp__catalog__lookup";
    const callLog = join(fixture.root, "mcp-calls.ndjson");
    const server = {
      type: "stdio",
      command: process.execPath,
      args: [resolve("test/e2e/fixtures/mcp/toolsearch-server.mjs")],
      env: { E2E_TOOLSEARCH_MCP_LOG: callLog },
    };
    try {
      await fixture.configure({
        features: { memory: false, skill: false, subagent: false, mcp: true },
        mcp: { servers: { catalog: server } },
      });
      fixture.setResponse((body, response) => {
        const text = JSON.stringify(body.messages);
        fixture.reply(
          body,
          response,
          body.tools?.length &&
            !text.includes(TOOLSEARCH_CALL_ID) &&
            !text.includes("E2E_TOOLSEARCH_COLD")
            ? "mcp-search"
            : "done",
        );
      });
      const initial = await fixture.start([
        "--toolsearch-mode",
        "native",
        "-p",
        "E2E_TOOLSEARCH_INITIAL 搜索 MCP。",
      ]).done;
      expect(initial.code).toBe(0);
      const { sessionId } = JSON.parse(initial.stdout) as { sessionId: string };
      expect(JSON.stringify(fixture.requests.at(-1)!.body.messages)).toContain(
        `"tool_name":"${name}"`,
      );
      const deliveredSchema = fixture.requests
        .at(-1)!
        .body.tools!.find((tool) => tool.name === name)!.input_schema;
      for (const enabled of [false, true]) {
        await fixture.configure({
          mcp: {
            servers: {
              catalog: {
                ...server,
                enabled,
                env: { ...server.env, E2E_TOOLSEARCH_SCHEMA_REVISION: "2" },
              },
            },
          },
        });
        fixture.setResponse((body, response) => {
          const results = toolSearchBlocks(body).filter((block) => block.type === "tool_result");
          const stage = !enabled
            ? results.some((block) => block.tool_use_id === "toolu_mcp_disabled")
              ? "done"
              : "mcp-disabled"
            : results.some((block) => block.tool_use_id === "toolu_mcp_corrected")
              ? "done"
              : results.some((block) => block.tool_use_id === "toolu_mcp_stale")
                ? "mcp-corrected"
                : "mcp-stale";
          fixture.reply(body, response, body.tools?.length ? stage : "auxiliary");
        });
        const start = fixture.requests.length;
        const result = await fixture.start([
          "--toolsearch-mode",
          "native",
          "--resume",
          sessionId,
          "-p",
          "E2E_TOOLSEARCH_COLD 检查当前工具池。",
        ]).done;
        expect(result.code).toBe(0);
        const requests = fixture.requests.slice(start).filter(({ body }) => body.tools?.length);
        expect(requests).toHaveLength(enabled ? 3 : 2);
        const first = requests[0]!.body;
        // Native 冻结已交付定义；恢复后的执行仍按当前 server 的 schema 校验。
        expect(first.tools?.find((tool) => tool.name === name)?.input_schema).toEqual(
          deliveredSchema,
        );
        expect(JSON.stringify(first.messages)).toContain(`"tool_name":"${name}"`);
        if (enabled) {
          const stale = resultFor(requests[1]!.body, "toolu_mcp_stale");
          expect(stale.is_error).toBe(true);
          expect(contentText(stale.content)).toContain("revision");
          const corrected = resultFor(requests[2]!.body, "toolu_mcp_corrected");
          expect(corrected.is_error ?? false).toBe(false);
          expect(contentText(corrected.content)).toContain("E2E_TOOLSEARCH_MCP_RESULT:recovered");
          expect(
            (await readFile(callLog, "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ).toEqual([{ name: "lookup", value: "recovered" }]);
        } else {
          const rejected = resultFor(requests[1]!.body, "toolu_mcp_disabled");
          expect(rejected.is_error).toBe(true);
          expect(contentText(rejected.content)).toContain(`No such tool available: ${name}`);
          expect(JSON.stringify(first.messages)).toContain("disabled");
          await expect(readFile(callLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    } finally {
      await fixture.close();
    }
  });

  it("TS07: 搜索参数仍在流入时中断，冷恢复不产生发现", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-recovery");
    const interruptedCall = "toolu_search_interrupted";
    try {
      const seed = await fixture.start([
        "--toolsearch-mode",
        "native",
        "-p",
        "E2E_TOOLSEARCH_SEED 稳定历史。",
      ]).done;
      expect(seed.code).toBe(0);
      const { sessionId } = JSON.parse(seed.stdout) as { sessionId: string };
      fixture.setResponse((body, response) => {
        // 参数流 fixture 故意不结束；取消屏障仍是 CLI 实际发出的输入流事件。
        fixture.reply(
          body,
          response,
          body.tools?.length ? "search-partial" : "auxiliary",
          !body.tools?.length,
        );
      });
      const active = fixture.start(
        [
          "--toolsearch-mode",
          "native",
          "--resume",
          sessionId,
          "-p",
          "E2E_TOOLSEARCH_CANCEL 中断搜索。",
        ],
        "stream-json",
      );
      await browser.waitUntil(async () => active.output().includes(interruptedCall), {
        timeout: 30_000,
        timeoutMsg: "CLI 尚未发出 ToolSearch 输入流事件",
      });
      active.child.kill("SIGINT");
      await active.done;
      fixture.setResponse((body, response) => fixture.reply(body, response));
      const start = fixture.requests.length;
      const cold = await fixture.start([
        "--toolsearch-mode",
        "native",
        "--resume",
        sessionId,
        "-p",
        "E2E_TOOLSEARCH_COLD_CANCEL 恢复。",
      ]).done;
      expect(cold.code).toBe(0);
      const first = fixture.requests.slice(start).find(({ body }) => body.tools?.length)!.body;
      expect(first.tools?.some((tool) => tool.name === "TodoRead")).toBe(false);
      expect(JSON.stringify(first.messages)).not.toContain('"type":"tool_reference"');
    } finally {
      await fixture.close();
    }
  });
});
