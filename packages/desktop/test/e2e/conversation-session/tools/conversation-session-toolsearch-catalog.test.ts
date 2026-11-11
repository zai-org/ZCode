import type { ServerResponse } from "node:http";
import { createToolSearchCliFixture } from "#e2e/helpers/toolsearch-cli-process";
import { startToolSearchRuntimeDriver } from "#e2e/helpers/toolsearch-runtime-driver";
import {
  isToolSearchCompact,
  TOOLSEARCH_NOTICE,
  type ToolSearchRequest,
} from "#e2e/helpers/toolsearch-provider";

type Delta = { addedNames: string[]; removedNames: string[]; readdedNames: string[] };
type Entry = { metadata?: { toolSearchAnnouncement?: Delta }; message?: unknown };
const text = (body: ToolSearchRequest) =>
  body.messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])),
    )
    .join("\n");
const deltas = (history: unknown) =>
  (history as Entry[]).flatMap((entry) =>
    entry.metadata?.toolSearchAnnouncement ? [entry.metadata.toolSearchAnnouncement] : [],
  );

function reply(
  fixture: Awaited<ReturnType<typeof createToolSearchCliFixture>>,
  response: ServerResponse,
  body: ToolSearchRequest,
  stage = "catalog-done",
) {
  fixture.reply(body, response, `${stage}-${body.stream ? "stream" : "json"}`);
}

// 目录由隔离 driver 注入；HTTP adapter、Runtime、SQLite 和 compact 均是真实实现。
// 与 CLI/TUI 产品 E2E 分开计数，不把此文件声称为 MCP 热更新用户路径。
describe("ToolSearch 动态目录（Runtime / HTTP 集成）", () => {
  for (const streaming of ["on", "off"] as const) {
    for (const boundary of ["input", "tool batch"] as const) {
      it(`TS09: Continue 中目录变化等到 ${boundary} 才公告，streaming=${streaming}`, async function () {
        this.timeout(120_000);
        const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-catalog");
        const driver = await startToolSearchRuntimeDriver(fixture, streaming);
        try {
          await driver.catalog("TodoRead", "absent");
          let mainCalls = 0;
          fixture.setResponse((body, response) => {
            void (async () => {
              mainCalls++;
              if (mainCalls === 1) {
                await driver.catalog("TodoRead", "deferred");
                reply(fixture, response, body, "catalog-partial");
              } else if (mainCalls === 2 && boundary === "tool batch") {
                reply(fixture, response, body, "catalog-search");
              } else reply(fixture, response, body);
            })().catch((error) => response.destroy(error as Error));
          });
          await driver.turn("E2E_TOOLSEARCH_CATALOG_CONTINUE");
          if (boundary === "input") await driver.turn("E2E_TOOLSEARCH_CATALOG_NEXT");
          expect(fixture.requests).toHaveLength(3);
          const second = fixture.requests[1]!.body;
          expect(text(second)).not.toContain("TodoRead");
          expect(text(second).split(TOOLSEARCH_NOTICE)).toHaveLength(2);
          const third = fixture.requests[2]!.body;
          expect(
            text(third)
              .split("\n")
              .filter((line) => line === "TodoRead"),
          ).toHaveLength(1);
          expect(deltas(await driver.history())).toEqual([
            { addedNames: ["TaskOutput"], removedNames: [], readdedNames: [] },
            { addedNames: ["TodoRead"], removedNames: [], readdedNames: [] },
          ]);
          await driver.turn("E2E_TOOLSEARCH_CATALOG_STABLE");
          expect(deltas(await driver.history())).toHaveLength(2);
          if (boundary === "tool batch")
            expect(third.tools?.find((tool) => tool.name === "TodoRead")?.defer_loading).toBe(true);
        } finally {
          await driver.close();
          await fixture.close();
        }
      });
    }

    it(`TS04: 增量尾部连续 reactive compact 补全名称且不重复，streaming=${streaming}`, async function () {
      this.timeout(120_000);
      const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-catalog");
      const driver = await startToolSearchRuntimeDriver(fixture, streaming);
      try {
        await driver.catalog("TodoRead", "absent");
        let mainCalls = 0;
        let summaries = 0;
        fixture.setResponse((body, response) => {
          if (isToolSearchCompact(body)) {
            summaries++;
            reply(fixture, response, body, "catalog-summary");
          } else if ([3, 5].includes(++mainCalls)) {
            fixture.reply(body, response, "context-error");
          } else reply(fixture, response, body);
        });
        await driver.turn("E2E_TOOLSEARCH_CATALOG_SEED_ONE");
        await driver.turn("E2E_TOOLSEARCH_CATALOG_SEED_TWO");
        await driver.catalog("TodoRead", "deferred");
        await driver.turn("E2E_TOOLSEARCH_CATALOG_EXPAND");
        expect(summaries).toBe(1);
        expect(deltas(await driver.history())).toEqual([
          { addedNames: ["TodoRead"], removedNames: [], readdedNames: [] },
          { addedNames: ["TaskOutput"], removedNames: [], readdedNames: [] },
        ]);
        for (let pass = 0; pass < 2; pass++) {
          const last = fixture.requests.at(-1)!.body;
          expect(text(last)).toContain("E2E_TOOLSEARCH_CATALOG_SUMMARY");
          for (const name of ["TaskOutput", "TodoRead"]) {
            expect(
              text(last)
                .split("\n")
                .filter((line) => line === name),
            ).toHaveLength(1);
            expect(last.tools?.some((tool) => tool.name === name)).toBe(false);
          }
          if (pass === 0) await driver.turn("E2E_TOOLSEARCH_CATALOG_COMPACT_AGAIN");
        }
        expect(summaries).toBe(2);
        const before = deltas(await driver.history());
        await driver.turn("E2E_TOOLSEARCH_CATALOG_STABLE");
        expect(deltas(await driver.history())).toEqual(before);
      } finally {
        await driver.close();
        await fixture.close();
      }
    });

    it(`TS06: resident 转换不误删，实际移除后恢复只公告一次，streaming=${streaming}`, async function () {
      this.timeout(120_000);
      const fixture = await createToolSearchCliFixture("conversation-session-toolsearch-catalog");
      const driver = await startToolSearchRuntimeDriver(fixture, streaming);
      try {
        fixture.setResponse((body, response) => reply(fixture, response, body));
        await driver.turn("E2E_TOOLSEARCH_CATALOG_INITIAL");
        await driver.catalog("TaskOutput", "resident");
        await driver.turn("E2E_TOOLSEARCH_CATALOG_RESIDENT");
        expect(
          fixture.requests.at(-1)!.body.tools?.find((tool) => tool.name === "TaskOutput"),
        ).toBeDefined();
        expect(
          fixture.requests.at(-1)!.body.tools?.find((tool) => tool.name === "TaskOutput")
            ?.defer_loading,
        ).toBeUndefined();
        expect(deltas(await driver.history())).toHaveLength(1);
        await driver.catalog("TaskOutput", "deferred");
        await driver.turn("E2E_TOOLSEARCH_CATALOG_DEFERRED");
        expect(
          fixture.requests.at(-1)!.body.tools?.some((tool) => tool.name === "TaskOutput"),
        ).toBe(false);
        expect(text(fixture.requests.at(-1)!.body)).not.toContain("no longer available");
        await driver.catalog("TaskOutput", "absent");
        await driver.turn("E2E_TOOLSEARCH_CATALOG_REMOVED");
        expect(deltas(await driver.history()).at(-1)?.removedNames).toEqual(["TaskOutput"]);
        expect(text(fixture.requests.at(-1)!.body)).toContain("no longer available");
        await driver.catalog("TaskOutput", "deferred");
        await driver.turn("E2E_TOOLSEARCH_CATALOG_RESTORED");
        expect(deltas(await driver.history()).at(-1)).toEqual({
          addedNames: ["TaskOutput"],
          removedNames: [],
          readdedNames: ["TaskOutput"],
        });
        expect(text(fixture.requests.at(-1)!.body)).toContain("available again");
        await driver.turn("E2E_TOOLSEARCH_CATALOG_STABLE");
        expect(deltas(await driver.history())).toHaveLength(3);
        expect(text(fixture.requests.at(-1)!.body).split("available again")).toHaveLength(2);
      } finally {
        await driver.close();
        await fixture.close();
      }
    });
  }
});
