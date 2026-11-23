import { expect, it } from "vitest";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { wrapSystemReminderForSource } from "../src/system-reminder/source.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { deriveTrajectoriesFromModelIoEntries } from "../../../tools/prompt-trajectory/src/model-io.js";

it.each(["native", "local"] as const)(
  "ignores current %s catalog announcements without changing the exported history",
  (mode) => {
    const registry = createToolRegistry();
    registry.register(toolSearchToolEntry);
    registry.register(deferredToolCallEntry);
    const names = Array.from({ length: 32 }, (_, i) => `mcp__demo__tool_${i}`);
    for (const name of names) {
      registry.register({
        ...toolSearchToolEntry,
        aliases: undefined,
        metadata: { ...toolSearchToolEntry.metadata, name, shouldDefer: true },
      });
    }
    const model = {
      ...createTestRuntimeModel({
        generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
      }),
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    };
    const tools = registry.toContracts();
    const createAnnouncement = (entries: RuntimeMessageEntry[], unavailable: string[] = []) => {
      const entry = buildToolSearchAnnouncement({
        mode,
        model,
        registry: { get: (name) => (unavailable.includes(name) ? undefined : registry.get(name)) },
        entries,
        tools: tools.filter((tool) => !unavailable.includes(tool.name)),
      });
      if (!entry || entry.kind !== "attachment") throw new Error("Expected catalog attachment");
      return entry;
    };
    const added = createAnnouncement([]);
    const removed = createAnnouncement([added], names.slice(0, 1));
    const bulkRemoved = createAnnouncement([added], names.slice(0, 31));
    const restored = createAnnouncement([added, removed]);
    const bulkRestored = createAnnouncement([added, bulkRemoved]);
    // 直接消费当前生成器，避免比较器与手写旧公告一起通过却漏掉运行时的新文案。
    for (const entry of [added, removed, bulkRemoved, restored, bulkRestored]) {
      const notice = {
        type: "text",
        text: wrapSystemReminderForSource("tool_search_announcement", entry.content),
      };
      const question = { type: "text", text: "Continue the task." };
      const next = { type: "text", text: "Next question." };
      const record = (content: unknown[]) => ({
        querySource: "main_turn",
        request: { body: { model: "test", messages: [{ role: "user", content }] } },
      });
      const records = [
        record([notice, question]),
        record([question]),
        record([notice, question, next]),
      ];
      const original = structuredClone(records);
      expect(deriveTrajectoriesFromModelIoEntries(records).trajectories).toHaveLength(3);
      const merged = deriveTrajectoriesFromModelIoEntries(records, {
        ignoreToolSearchChanges: true,
      });
      expect(merged.trajectories, entry.content).toHaveLength(1);
      expect(merged.trajectories[0]?.requestCount).toBe(3);
      expect(merged.trajectories[0]?.requestBody.messages).toEqual(
        records[2]!.request.body.messages,
      );
      expect(records).toEqual(original);
    }
  },
);
