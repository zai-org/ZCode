import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import {
  isToolSearchCompact,
  TOOLSEARCH_CALL_ID,
  TOOLSEARCH_NOTICE,
} from "#e2e/helpers/toolsearch-provider";

describe("ToolSearch 自动压缩与失败恢复（真实 CLI / HTTP）", () => {
  for (const trigger of ["auto", "reactive"] as const) {
    it(`TS09: Continue 期间 ${trigger} compact 重建一份公告并保留发现`, async function () {
      this.timeout(120_000);
      const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-compact");
      try {
        const seed = await fixture.start([
          "--toolsearch-mode",
          "native",
          "-p",
          "E2E_TOOLSEARCH_INITIAL 搜索并执行。",
        ]).done;
        expect(seed.code).toBe(0);
        const { sessionId } = JSON.parse(seed.stdout) as { sessionId: string };
        let mainCalls = 0;
        let summaries = 0;
        fixture.setResponse((body, response) => {
          if (isToolSearchCompact(body)) {
            summaries++;
            fixture.reply(body, response, "summary");
            return;
          }
          if (!body.tools?.length) {
            fixture.reply(body, response, "auxiliary");
            return;
          }
          mainCalls++;
          fixture.reply(
            body,
            response,
            mainCalls === 2 && trigger === "reactive"
              ? "context-error"
              : mainCalls === 1
                ? `partial-${trigger}`
                : "compact-done",
          );
        });
        const start = fixture.requests.length;
        const run = await fixture.start([
          "--toolsearch-mode",
          "native",
          "--resume",
          sessionId,
          "-p",
          "E2E_TOOLSEARCH_CONTINUE_COMPACT 继续。",
        ]).done;
        expect(run.code).toBe(0);
        expect(summaries).toBeGreaterThan(0);
        const main = fixture.requests
          .slice(start)
          .filter(({ body }) => body.tools?.length && !isToolSearchCompact(body));
        expect(main.length).toBeGreaterThanOrEqual(2);
        for (const { body } of main) {
          expect(JSON.stringify(body.messages).split(TOOLSEARCH_NOTICE)).toHaveLength(2);
          expect(body.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading).toBe(true);
        }
        expect(JSON.stringify(main.at(-1)!.body.messages)).toContain("E2E_TOOLSEARCH_SUMMARY");
      } finally {
        await fixture.close();
      }
    });
  }

  it("TS04: compact 摘要失败不替换历史，下次冷请求仍有原始引用", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-compact");
    try {
      const seed = await fixture.start([
        "--toolsearch-mode",
        "native",
        "-p",
        "E2E_TOOLSEARCH_INITIAL 搜索。",
      ]).done;
      expect(seed.code).toBe(0);
      const { sessionId } = JSON.parse(seed.stdout) as { sessionId: string };
      let failedSummaries = 0;
      fixture.setResponse((body, response) => {
        if (isToolSearchCompact(body)) {
          failedSummaries++;
          fixture.reply(body, response, "summary-error");
        } else fixture.reply(body, response);
      });
      await fixture.start(["--toolsearch-mode", "native", "--resume", sessionId, "-p", "/compact"])
        .done;
      expect(failedSummaries).toBeGreaterThan(0);
      const start = fixture.requests.length;
      const cold = await fixture.start([
        "--toolsearch-mode",
        "native",
        "--resume",
        sessionId,
        "-p",
        "E2E_TOOLSEARCH_COLD 检查失败后历史。",
      ]).done;
      expect(cold.code).toBe(0);
      const first = fixture.requests
        .slice(start)
        .find(({ body }) => body.tools?.length && !isToolSearchCompact(body))!.body;
      expect(first.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading).toBe(true);
      expect(JSON.stringify(first.messages)).toContain(TOOLSEARCH_CALL_ID);
      expect(JSON.stringify(first.messages)).toContain(
        '"type":"tool_reference","tool_name":"TodoRead"',
      );
      expect(JSON.stringify(first.messages).split(TOOLSEARCH_NOTICE)).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it("TS04: compact 请求期间取消，不提交候选摘要或新发现基线", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-compact");
    try {
      const seed = await fixture.start([
        "--toolsearch-mode",
        "native",
        "-p",
        "E2E_TOOLSEARCH_INITIAL 搜索后准备取消压缩。",
      ]).done;
      expect(seed.code).toBe(0);
      const { sessionId } = JSON.parse(seed.stdout) as { sessionId: string };
      let summaryStarted = false;
      fixture.setResponse((body, response) => {
        if (isToolSearchCompact(body)) {
          summaryStarted = true;
          fixture.reply(body, response, "summary-partial", false);
        } else fixture.reply(body, response);
      });
      const compact = fixture.start([
        "--toolsearch-mode",
        "native",
        "--resume",
        sessionId,
        "-p",
        "/compact",
      ]);
      await browser.waitUntil(async () => summaryStarted, {
        timeout: 30_000,
        timeoutMsg: "compact 没有发起真实摘要请求",
      });
      compact.child.kill("SIGINT");
      await compact.done;
      const start = fixture.requests.length;
      const cold = await fixture.start([
        "--toolsearch-mode",
        "native",
        "--resume",
        sessionId,
        "-p",
        "E2E_TOOLSEARCH_COLD 检查取消后的原始历史。",
      ]).done;
      expect(cold.code).toBe(0);
      const first = fixture.requests
        .slice(start)
        .find(({ body }) => body.tools?.length && !isToolSearchCompact(body))!.body;
      expect(first.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading).toBe(true);
      const messages = JSON.stringify(first.messages);
      expect(messages).toContain(TOOLSEARCH_CALL_ID);
      expect(messages).toContain('"type":"tool_reference","tool_name":"TodoRead"');
      expect(messages).not.toContain("E2E_TOOLSEARCH_UNCOMMITTED_SUMMARY");
      expect(messages.split(TOOLSEARCH_NOTICE)).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
});
