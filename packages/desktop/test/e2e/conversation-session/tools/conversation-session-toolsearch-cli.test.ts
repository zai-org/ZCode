import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { TOOLSEARCH_CALL_ID, TOOLSEARCH_NOTICE } from "#e2e/helpers/toolsearch-provider";

describe("ToolSearch CLI 真实进程入口", () => {
  it("TS02: 普通 Anthropic 默认关闭，flag 强开；resume 不带 flag 降级后还能恢复", async function () {
    this.timeout(180_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-cli");
    try {
      const plain = await fixture.start(["-p", "E2E_TOOLSEARCH_SEED 默认关闭。"]).done;
      expect(plain.code).toBe(0);
      const initial = fixture.requests.find(({ body }) => body.tools?.length)!.body;
      expect(initial.tools?.some((tool) => tool.name === "ToolSearch")).toBe(false);
      expect(
        initial.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading,
      ).toBeUndefined();
      const before = fixture.requests.length;
      const forced = await fixture.start([
        "--toolsearch-mode",
        "native",
        "-p",
        "E2E_TOOLSEARCH_INITIAL 搜索 TodoRead 并执行。",
      ]).done;
      expect(forced.code).toBe(0);
      const summary = JSON.parse(forced.stdout) as { sessionId: string };
      const forcedRequests = fixture.requests
        .slice(before)
        .filter(({ body }) => body.tools?.length);
      expect(forcedRequests[0]!.body.tools?.some((tool) => tool.name === "TodoRead")).toBe(false);
      expect(
        forcedRequests.at(-1)!.body.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading,
      ).toBe(true);
      expect(JSON.stringify(forcedRequests.at(-1)!.body.messages)).toContain(
        '"type":"tool_reference","tool_name":"TodoRead"',
      );
      expect(
        JSON.stringify(forcedRequests.at(-1)!.body.messages).match(/Tool loaded\./g),
      ).toHaveLength(1);
      for (const force of [false, true]) {
        const start = fixture.requests.length;
        const result = await fixture.start([
          ...(force ? ["--toolsearch-mode", "native"] : []),
          ...(force ? ["--continue"] : ["--resume", summary.sessionId]),
          "-p",
          "E2E_TOOLSEARCH_COLD 检查重启后的第一条请求。",
        ]).done;
        expect(result.code).toBe(0);
        expect((JSON.parse(result.stdout) as { sessionId: string }).sessionId).toBe(
          summary.sessionId,
        );
        const cold = fixture.requests.slice(start).filter(({ body }) => body.tools?.length);
        expect(cold).toHaveLength(1);
        expect(JSON.stringify(cold[0]!.body.messages).match(/Tool loaded\./g) ?? []).toHaveLength(
          force ? 1 : 0,
        );
        expect(cold[0]!.body.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading).toBe(
          force ? true : undefined,
        );
        expect(cold[0]!.body.tools?.some((tool) => tool.name === "ToolSearch")).toBe(force);
        expect(JSON.stringify(cold[0]!.body.messages)).toContain(TOOLSEARCH_CALL_ID);
        expect(JSON.stringify(cold[0]!.body.messages).includes(TOOLSEARCH_NOTICE)).toBe(force);
        expect(JSON.stringify(cold[0]!.body.messages).includes('"type":"tool_reference"')).toBe(
          force,
        );
      }
      for (const denied of [true, false]) {
        const start = fixture.requests.length;
        const scoped = await fixture.start([
          "--toolsearch-mode",
          "native",
          ...(denied ? ["--disallowedTools=TodoRead"] : []),
          "--resume",
          summary.sessionId,
          "-p",
          "E2E_TOOLSEARCH_COLD 检查本次工具作用域。",
        ]).done;
        expect(scoped.code).toBe(0);
        const first = fixture.requests.slice(start).find(({ body }) => body.tools?.length)!.body;
        expect(first.tools?.some((tool) => tool.name === "TodoRead")).toBe(!denied);
        expect(JSON.stringify(first.messages).includes('"tool_name":"TodoRead"')).toBe(!denied);
      }
    } finally {
      await fixture.close();
    }
  });

  it("TS02: ToolSearch 不可用或没有 deferred 工具时，force 不增加协议字段", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-cli");
    try {
      const seed = await fixture.start(["-p", "E2E_TOOLSEARCH_SEED 读取完整目录。"]).done;
      expect(seed.code).toBe(0);
      const catalog = fixture.requests.find(({ body }) => body.tools?.length)!.body.tools!;
      for (const excluded of [
        ["ToolSearch"],
        catalog
          .filter((tool) => !["Read", "ToolSearch"].includes(tool.name))
          .map((tool) => tool.name),
      ]) {
        const start = fixture.requests.length;
        const result = await fixture.start([
          "--toolsearch-mode",
          "native",
          `--disallowedTools=${excluded.join(",")}`,
          "-p",
          "E2E_TOOLSEARCH_SEED 受限目录。",
        ]).done;
        expect(result.code).toBe(0);
        const first = fixture.requests.slice(start).find(({ body }) => body.tools?.length)!;
        expect(first.body.tools?.some((tool) => tool.name === "ToolSearch")).toBe(false);
        expect(first.body.tools?.some((tool) => tool.defer_loading)).toBe(false);
        expect(String(first.headers["anthropic-beta"] ?? "")).not.toContain("advanced-tool-use");
        expect(JSON.stringify(first.body.messages)).not.toContain(TOOLSEARCH_NOTICE);
      }
    } finally {
      await fixture.close();
    }
  });

  it("TS02: force + OpenAI 在首个 HTTP 请求前报错", async function () {
    this.timeout(90_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-cli");
    try {
      await fixture.select("openai-chat-completions");
      const result = await fixture.start([
        "--toolsearch-mode",
        "native",
        "-p",
        "E2E_TOOLSEARCH_SEED 不支持的协议。",
      ]).done;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        "--toolsearch-mode native requires an Anthropic Messages provider",
      );
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("TS02: target 入口继承 force，完成校验请求降级为无工具作用域", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-cli");
    const verifierPrompt = "Verify whether the active session goal";
    try {
      fixture.setResponse((body, response) => {
        fixture.reply(
          body,
          response,
          JSON.stringify(body).includes(verifierPrompt)
            ? `verifier-${body.stream ? "stream" : "json"}`
            : undefined,
        );
      });
      const result = await fixture.start([
        "--toolsearch-mode",
        "native",
        "--target",
        "E2E_TOOLSEARCH_INITIAL 搜索 TodoRead 后记录已完成任务。",
        "--mode",
        "yolo",
      ]).done;
      expect(result.code).toBe(0);
      const main = fixture.requests.filter(({ body }) => body.tools?.length);
      expect(main[0]!.body.tools?.some((tool) => tool.name === "ToolSearch")).toBe(true);
      expect(main[0]!.body.tools?.some((tool) => tool.name === "TodoRead")).toBe(false);
      expect(main.at(-1)!.body.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading).toBe(
        true,
      );
      const verification = fixture.requests.filter(({ body }) =>
        JSON.stringify(body).includes(verifierPrompt),
      );
      expect(verification).toHaveLength(1);
      expect(verification[0]!.body.tools ?? []).toHaveLength(0);
      expect(JSON.stringify(verification[0]!.body.messages)).not.toContain(
        '"type":"tool_reference"',
      );
      expect(String(verification[0]!.headers["anthropic-beta"] ?? "")).not.toContain(
        "advanced-tool-use",
      );
    } finally {
      await fixture.close();
    }
  });
});
