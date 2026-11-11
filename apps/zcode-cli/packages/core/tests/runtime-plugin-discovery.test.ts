import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  PLUGIN_DISCOVERY_INPUT,
  type ModelRequest,
  type PluginDiscoveryPort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("runtime plugin discovery wiring", () => {
  it.each(["build", "yolo"] as const)(
    "passes both tools through the runtime and waits in %s mode",
    async (mode) => {
      const requests: ModelRequest[] = [];
      let confirm!: () => void;
      const port: PluginDiscoveryPort = {
        search: vi.fn(async () => ({ plugins: [], stale: false })),
        suggest: vi.fn(async () => {
          await new Promise<void>((resolve) => {
            confirm = resolve;
          });
          return {
            pluginId: "mail@zcode-plugins-official",
            status: "skipped",
            message: "User skipped",
          };
        }),
      };
      const runtime = createTestAgentRuntime(
        createSessionId(),
        {
          mode,
          modelStreaming: "off",
          workingDirectory: process.cwd(),
          memory: { enabled: false },
          compact: { enabled: false },
        },
        {
          eventStore: createTestSessionEventStore(),
          pluginDiscoveryPort: port,
          modelFactory: createTestModelFactory({
            async generateText(request) {
              requests.push(request);
              if (requests.length < 3)
                return {
                  finishReason: "tool-calls" as const,
                  text: "",
                  usage: {},
                  toolCalls: [
                    {
                      id: `call-${requests.length}`,
                      name: requests.length === 1 ? "SearchPlugins" : "SuggestPluginInstall",
                      input:
                        requests.length === 1
                          ? { query: "mail" }
                          : { pluginId: "mail@zcode-plugins-official", reason: "Read mail" },
                    },
                  ],
                };
              return { finishReason: "stop" as const, text: "Continue without plugins", usage: {} };
            },
          }),
        },
      );
      const run = runtime.executeTurn("Summarize my inbox", undefined, {
        intent: {
          [PLUGIN_DISCOVERY_INPUT]: true,
          sourceCommandId: "cmd",
          clientId: "app",
          kind: "sendText",
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          queueItemId: "cmd",
          admissionSeq: 1,
          admittedAt: 0,
        },
      });
      await vi.waitFor(() => expect(port.suggest).toHaveBeenCalledOnce());
      expect(requests).toHaveLength(2);
      expect(port.search).toHaveBeenCalledWith(
        { query: "mail" },
        expect.objectContaining({
          sessionId: runtime.sessionId,
          signal: expect.any(AbortSignal),
          emitEvent: expect.any(Function),
        }),
      );
      confirm();
      await run;
      expect(requests).toHaveLength(3);
      await runtime.executeTurn("Ordinary input without an interactive attachment");
      const names = requests.at(-1)?.tools?.map((tool) => tool.name) ?? [];
      expect(names).not.toContain("SuggestPluginInstall");
      expect(names).not.toContain("SearchPlugins");
      expect(names).toContain("Read");
      expect(
        requests[2]?.messages.some(
          (message) => message.role === "tool" && message.toolName === "SuggestPluginInstall",
        ),
      ).toBe(true);
    },
  );
});
