import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { toolSearchBlocks } from "#e2e/helpers/toolsearch-provider";

const LOOKUP = "mcp__catalog__lookup";
const BLOCKED = "mcp__catalog__blocked";
const CHILD_SEARCH = "toolu_toolsearch_child";

describe("ToolSearch MCP 与子 Agent 作用域（真实 CLI / stdio）", () => {
  it("TS06/TS07: hint、alwaysLoad、禁用工具、并发搜索及 child 独立发现", async function () {
    this.timeout(180_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-scope");
    try {
      const callLog = join(fixture.root, "mcp.ndjson");
      const server = {
        type: "stdio",
        command: process.execPath,
        args: [resolve("test/e2e/fixtures/mcp/toolsearch-server.mjs")],
        env: { E2E_TOOLSEARCH_MCP_LOG: callLog },
      };
      await fixture.configure({
        features: { memory: false, skill: false, mcp: true, subagent: true },
        permission: {
          mode: "yolo",
          allowedTools: ["Agent", "ToolSearch", LOOKUP],
          disallowedTools: [BLOCKED],
        },
        mcp: { servers: { catalog: server, resident_server: { ...server, alwaysLoad: true } } },
      });
      const agentDir = join(fixture.workspace, ".zcode", "agents");
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "toolsearch-scoped.md"),
        `---\nname: toolsearch-scoped\ndescription: ToolSearch scoped fixture\ntools: ToolSearch, ${LOOKUP}\n---\nE2E_TOOLSEARCH_CHILD_SYSTEM\nSearch only your allowed catalog.\n`,
      );
      fixture.setResponse((body, response) => {
        const child = JSON.stringify(body.system).includes("E2E_TOOLSEARCH_CHILD_SYSTEM");
        const blocks = toolSearchBlocks(body);
        const result = (id: string) =>
          blocks.some((block) => block.type === "tool_result" && block.tool_use_id === id);
        let stage = "scope-done";
        if (child && !result(CHILD_SEARCH)) stage = "child-search";
        else if (!child && body.tools?.length) {
          if (!result("toolu_search_hint")) stage = "scope-searches";
          else if (!result("toolu_lookup")) stage = "scope-lookup";
          else if (!result("toolu_blocked")) stage = "scope-blocked";
          else if (!result("toolu_agent")) stage = "scope-agent";
        }
        fixture.reply(body, response, stage);
      });
      const run = await fixture.start([
        "--toolsearch-mode",
        "native",
        `--disallowedTools=${BLOCKED}`,
        "-p",
        "E2E_TOOLSEARCH_SCOPE 验证 MCP 与子 Agent。",
      ]).done;
      expect(run.code).toBe(0);
      const main = fixture.requests.filter(
        ({ body }) =>
          body.tools?.length &&
          !JSON.stringify(body.system).includes("E2E_TOOLSEARCH_CHILD_SYSTEM"),
      );
      expect(main.length).toBeGreaterThanOrEqual(4);
      const first = main[0]!.body;
      expect(first.tools?.some((tool) => tool.name === LOOKUP)).toBe(false);
      expect(first.tools?.some((tool) => tool.name === BLOCKED)).toBe(false);
      for (const name of ["mcp__catalog__resident", "mcp__resident_server__lookup"]) {
        expect(first.tools?.find((tool) => tool.name === name)).toBeDefined();
        expect(first.tools?.find((tool) => tool.name === name)?.defer_loading).toBeUndefined();
      }
      const searched = main[1]!.body;
      for (const name of [LOOKUP, "TodoRead"])
        expect(searched.tools?.find((tool) => tool.name === name)?.defer_loading).toBe(true);
      for (const id of ["toolu_search_hint", "toolu_search_todo"]) {
        expect(
          toolSearchBlocks(searched).filter(
            (block) => block.type === "tool_result" && block.tool_use_id === id && !block.is_error,
          ),
        ).toHaveLength(1);
      }
      const mcpCalls = await readFile(callLog, "utf8");
      expect(mcpCalls).toContain('"name":"lookup","value":"verified"');
      expect(mcpCalls).not.toContain('"name":"blocked"');
      const blockedResult = toolSearchBlocks(main.at(-1)!.body).find(
        (block) => block.tool_use_id === "toolu_blocked",
      );
      expect(blockedResult?.is_error).toBe(true);
      const child = fixture.requests.filter(({ body }) =>
        JSON.stringify(body.system).includes("E2E_TOOLSEARCH_CHILD_SYSTEM"),
      );
      expect(child).toHaveLength(2);
      expect(child[0]!.body.tools?.some((tool) => tool.name === "ToolSearch")).toBe(true);
      expect(child[0]!.body.tools?.some((tool) => tool.name === LOOKUP)).toBe(false);
      expect(child[1]!.body.tools?.find((tool) => tool.name === LOOKUP)?.defer_loading).toBe(true);
      const childResult = toolSearchBlocks(child[1]!.body).find(
        (block) => block.tool_use_id === CHILD_SEARCH,
      );
      expect(childResult?.content).toEqual([{ type: "tool_reference", tool_name: LOOKUP }]);
      for (const request of child) {
        expect(request.body.tools?.some((tool) => ["TodoRead", BLOCKED].includes(tool.name))).toBe(
          false,
        );
      }
      const agentResult = toolSearchBlocks(main.at(-1)!.body).find(
        (block) => block.tool_use_id === "toolu_agent",
      );
      expect(agentResult).toBeDefined();
      expect(agentResult?.is_error).not.toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
