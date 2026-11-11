import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startToolSearchTerminal } from "#e2e/helpers/toolsearch-terminal";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { toolSearchBlocks, type ToolSearchRequest } from "#e2e/helpers/toolsearch-provider";

describe("Local ToolSearch CLI 请求与恢复", () => {
  it("TS10-TUI: Local 真实终端搜索和包装调用", async function () {
    this.timeout(120_000);
    const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-local");
    let terminal: ReturnType<typeof startToolSearchTerminal> | undefined;
    try {
      await mkdir(join(fixture.root, ".zcode", "v2"), { recursive: true });
      await writeFile(
        join(fixture.root, ".zcode", "v2", "credentials.json"),
        JSON.stringify({
          "account-provider:account:zai-individual-coding-plan:identity": "toolsearch-e2e",
          "account-provider:coding-plan:account:zai-individual-coding-plan:account:toolsearch-e2e:api-key":
            "test-only",
        }),
      );
      fixture.setResponse((body, response) => {
        const stage = hasResult(body, "local_good")
          ? "done"
          : hasResult(body, "local_bad")
            ? "good"
            : hasResult(body, "local_search")
              ? "bad"
              : "search";
        fixture.reply(body, response, `anthropic-${stage}-${body.stream ? "stream" : "json"}`);
      });
      terminal = startToolSearchTerminal(fixture, ["--toolsearch-mode", "local"]);
      await browser.waitUntil(async () => terminal!.ready(), { timeout: 30_000 });
      const submit = async (value: string, expected: string) => {
        const before = terminal!.frameCount();
        terminal!.write(value);
        await browser.waitUntil(async () => terminal!.frameCount() > before, { timeout: 10_000 });
        terminal!.write("\r");
        await browser.waitUntil(async () => terminal!.output().includes(expected), {
          timeout: 30_000,
        });
      };
      await submit(
        "/model toolsearch-process/test-toolsearch",
        "Model switched to toolsearch-process/test-toolsearch",
      );
      await submit("/effort disabled", "Reasoning effort switched to disabled");
      await submit("E2E_TOOLSEARCH_LOCAL 验证清单。", "E2E_TOOLSEARCH_LOCAL_DONE");
      const requests = fixture.requests.filter(({ body }) => body.tools?.length);
      expect(requests).toHaveLength(4);
      expectSuccessfulTodoResult(requests[3]!.body);
      expect(toolNames(requests[0]!.body)).toContain("DeferredToolCall");
      expectLocalSearchDescription(requests[0]!.body);
      for (const request of requests) expect(request.body.tools).toEqual(requests[0]!.body.tools);
      expect(JSON.stringify(requests[1]!.body.messages)).toContain("<functions>");
      expect(hasResult(requests[3]!.body, "local_good")).toBe(true);
      const beforeExit = terminal.frameCount();
      terminal.write("\x03");
      await browser.waitUntil(async () => terminal!.frameCount() > beforeExit, { timeout: 10_000 });
      terminal.write("\x03");
      expect(await terminal.done).toBe(0);
    } finally {
      await terminal?.close();
      await fixture.close();
    }
  });
  for (const api of ["anthropic-messages", "openai-chat-completions"] as const) {
    for (const mode of ["local", "auto"] as const) {
      it(`TS10-LOCAL: ${api}/${mode} 搜索、包装纠错、冷恢复与模式切换`, async function () {
        this.timeout(180_000);
        const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-local");
        try {
          await fixture.select(api);
          fixture.setResponse((body, response) => {
            const text = JSON.stringify(body.messages);
            const stage = text.includes("E2E_TOOLSEARCH_LOCAL_COLD")
              ? "done"
              : hasResult(body, "local_good")
                ? "done"
                : hasResult(body, "local_bad")
                  ? "good"
                  : hasResult(body, "local_search")
                    ? "bad"
                    : "search";
            fixture.reply(
              body,
              response,
              `${api === "anthropic-messages" ? "anthropic" : "openai"}-${stage}-${body.stream ? "stream" : "json"}`,
            );
          });
          const result = await fixture.start([
            "--toolsearch-mode",
            mode,
            "-p",
            "E2E_TOOLSEARCH_LOCAL 搜索 TodoRead 和 TaskOutput 后记录验证完成。",
          ]).done;
          expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({
            code: 0,
            stderr: "",
          });
          expect(fixture.requests).toHaveLength(4);
          const first = fixture.requests[0]!.body;
          expectLocalSearchDescription(first);
          const searched = fixture.requests[1]!.body;
          const text = JSON.stringify(searched.messages);
          expect(text.match(/<functions>/g)).toHaveLength(1);
          expect(text.match(/<function>/g)).toHaveLength(2);
          expect(text).toContain("parameters");
          expect(text).not.toContain("Tool loaded.");
          const searchResult = toolSearchBlocks(searched).find(
            (block) => block.type === "tool_result" && block.tool_use_id === "local_search",
          );
          if (api === "anthropic-messages")
            expect(JSON.stringify(searchResult?.content)).not.toContain("Tool loaded.");
          expect(JSON.stringify(fixture.requests[2]!.body.messages)).toContain(
            "InputValidationError",
          );
          expect(hasResult(fixture.requests[3]!.body, "local_good")).toBe(true);
          expectSuccessfulTodoResult(fixture.requests[3]!.body);
          for (const request of fixture.requests) {
            expect(request.body.tools).toEqual(first.tools);
            expect(JSON.stringify(request.body)).not.toContain('"type":"tool_reference"');
            expect(JSON.stringify(request.body.tools)).not.toContain("defer_loading");
            expect(String(request.headers["anthropic-beta"] ?? "")).not.toContain(
              "advanced-tool-use",
            );
          }
          expect(toolNames(first)).toContain("DeferredToolCall");
          expect(toolNames(first)).not.toContain("TodoRead");
          const sessionId = (JSON.parse(result.stdout) as { sessionId: string }).sessionId;
          const db = new DatabaseSync(join(fixture.root, "session.sqlite"), { readOnly: true });
          try {
            const parts = db
              .prepare(
                "select data from part where json_extract(data, '$.callID') in ('local_bad', 'local_good')",
              )
              .all() as { data: string }[];
            expect(parts).toHaveLength(2);
            for (const row of parts) {
              const part = JSON.parse(row.data);
              expect(part.tool).toBe("TodoRead");
              expect(part.metadata.modelCallWrapper).toBe("DeferredToolCall");
              expect(part.metadata).not.toHaveProperty("modelToolCall");
              // TodoRead 的合法输入恒为 {}，用 local_bad 的非法输入证明包装调用的 input
              // 原样透传到目标工具，且包装字段 name 不混入。
              expect(part.state.input).toEqual(
                part.callID === "local_good" ? {} : { todos: "invalid" },
              );
              expect(part.state.status).toBe(part.callID === "local_good" ? "completed" : "error");
            }
          } finally {
            db.close();
          }
          for (const coldMode of [
            "off",
            ...(api === "anthropic-messages" ? ["native"] : []),
            "local",
          ] as const) {
            const before = fixture.requests.length;
            const cold = await fixture.start([
              "--toolsearch-mode",
              coldMode,
              "--resume",
              sessionId,
              "-p",
              "E2E_TOOLSEARCH_LOCAL_COLD 检查历史并结束。",
            ]).done;
            expect({ code: cold.code, stderr: cold.code === 0 ? "" : cold.stderr }).toEqual({
              code: 0,
              stderr: "",
            });
            const request = fixture.requests[before]!.body;
            if (coldMode === "local") expectLocalSearchDescription(request);
            expect(toolNames(request).includes("LocalToolSearch")).toBe(coldMode === "local");
            expect(toolNames(request).includes("ToolSearch")).toBe(coldMode === "native");
            if (api === "anthropic-messages" && coldMode !== "off")
              expect(
                toolSearchBlocks(request).find(
                  (block) => block.type === "tool_use" && block.id === "local_search",
                )?.name,
              ).toBe(coldMode === "local" ? "LocalToolSearch" : "ToolSearch");
            expect(JSON.stringify(request.messages).match(/Tool loaded\./g) ?? []).toHaveLength(
              coldMode === "native" ? 1 : 0,
            );
            expect(hasResult(request, "local_good")).toBe(true);
            expect(JSON.stringify(request.messages)).toContain("DeferredToolCall");
            expect(JSON.stringify(request.messages)).not.toContain("modelCallWrapper");
            expect(toolNames(request).includes("DeferredToolCall")).toBe(coldMode === "local");
            expect(JSON.stringify(request.messages).includes("<functions>")).toBe(
              coldMode === "local",
            );
          }
        } finally {
          await fixture.close();
        }
      });
    }
  }
});

function expectLocalSearchDescription(body: ToolSearchRequest): void {
  const definition = (body.tools ?? [])
    .map((tool) => {
      const entry = tool as { name: string; description?: string; function?: unknown };
      return (entry.function ?? entry) as { name: string; description?: string };
    })
    .find((tool) => tool.name === "LocalToolSearch");
  expect(toolNames(body)).toContain("LocalToolSearch");
  expect(toolNames(body)).not.toContain("ToolSearch");
  expect(definition?.description).toContain("called using DeferredToolCall.");
  expect(definition?.description).toContain(
    "For deferred tools, parameters describes the input object passed to DeferredToolCall.",
  );
  // 示例点名的工具须仍是 deferred：TodoWrite 转为常驻后示例改为 TaskStop，参数值为占位符。
  expect(definition?.description).toContain('DeferredToolCall({"name":"TaskStop","input":');
  expect(definition?.description?.match(/<example>/g)).toHaveLength(1);
  expect(definition?.description).not.toContain("<commentary>");
  expect(definition?.description).not.toContain("the same encoding");
  expect(definition?.description).not.toContain("does not change a tool's classification");
}

function hasResult(body: ToolSearchRequest, id: string): boolean {
  return (
    toolSearchBlocks(body).some((b) => b.type === "tool_result" && b.tool_use_id === id) ||
    body.messages.some(
      (m) => m.role === "tool" && (m as unknown as { tool_call_id?: string }).tool_call_id === id,
    )
  );
}

function expectSuccessfulTodoResult(body: ToolSearchRequest): void {
  const result =
    toolSearchBlocks(body).find(
      (block) => block.type === "tool_result" && block.tool_use_id === "local_good",
    ) ??
    body.messages.find(
      (message) =>
        message.role === "tool" &&
        (message as { tool_call_id?: string }).tool_call_id === "local_good",
    );
  expect(result).toBeDefined();
  expect(result).not.toMatchObject({ is_error: true });
  expect(JSON.stringify(result?.content)).not.toContain("InputValidationError");
  // 新会话没有待办，TodoRead 的真实执行输出是空清单。
  expect(JSON.parse(String(result?.content))).toEqual({ todos: [] });
}

function toolNames(body: ToolSearchRequest): string[] {
  return (body.tools ?? []).map(
    (tool) => tool.name ?? (tool as unknown as { function: { name: string } }).function.name,
  );
}
