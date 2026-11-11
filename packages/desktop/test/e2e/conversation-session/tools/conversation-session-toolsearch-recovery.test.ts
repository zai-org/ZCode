import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { TOOLSEARCH_CALL_ID } from "#e2e/helpers/toolsearch-provider";

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

  it("TS04: MCP 移除后过滤旧引用，重新启用后恢复发现", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-recovery");
    const name = "mcp__catalog__lookup";
    const server = {
      type: "stdio",
      command: process.execPath,
      args: [resolve("test/e2e/fixtures/mcp/toolsearch-server.mjs")],
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
      for (const enabled of [false, true]) {
        await fixture.configure({
          mcp: {
            servers: {
              catalog: { ...server, enabled, env: { E2E_TOOLSEARCH_SCHEMA_REVISION: "2" } },
            },
          },
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
        const first = fixture.requests.slice(start).find(({ body }) => body.tools?.length)!.body;
        expect(first.tools?.some((tool) => tool.name === name)).toBe(enabled);
        expect(JSON.stringify(first.messages).includes(`"tool_name":"${name}"`)).toBe(enabled);
        if (enabled) {
          expect(first.tools?.find((tool) => tool.name === name)?.input_schema).toMatchObject({
            required: ["value", "revision"],
          });
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
