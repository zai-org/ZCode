import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSessionId, type Model, type ModelRequest } from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { toAiSdkMessages } from "../../adapters/src/model/transform.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

it("keeps a SQLite goal active when the no-tool verifier rejects completion after a real ToolSearch result", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-toolsearch-goal-"));
  const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
  const sessionId = createSessionId("toolsearch-goal-verification");
  const requests: ModelRequest[] = [];
  const baseFactory = createTestModelFactory({
    async generateText(request) {
      requests.push(request);
      // 使用真实 Adapter 投影；协议不配套时会抛错并触发 verifier 的既有 fail-open。
      toAiSdkMessages(request.messages, {
        providerKind: "anthropic",
        toolSearchEnabled: request.toolSearchEnabled,
      });
      if (requests.length === 1)
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [
            { id: "search-real", name: "ToolSearch", input: { query: "select:TaskOutput" } },
          ],
        };
      return {
        text:
          request.tools?.length === 0
            ? JSON.stringify({
                passed: false,
                reason: "Only the tool definition was loaded.",
                nextAction: "Read the requested documentation.",
              })
            : "Work remains.",
        finishReason: "stop",
        usage: {},
      };
    },
  });
  const withSearch = (model: Model): Model => ({
    ...model,
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    bind: (options) => withSearch(model.bind(options)),
  });
  const runtime = createTestAgentRuntime(
    sessionId,
    {
      toolSearch: { mode: "native" },
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      workspacePath: root,
    },
    {
      sessionStore: store,
      eventStore: createTestSessionEventStore(),
      modelFactory: (input) => withSearch(baseFactory(input)),
    },
  );
  try {
    await runtime.ensureSessionPersistedForExternalActivity(
      "/goal Read the requested documentation",
    );
    await store.setTarget({ sessionID: sessionId, objective: "Read the requested documentation" });
    await runtime.executeTurn("Load the tool definition first.");
    await runtime.continueActiveTargetIfIdle({ verifyBeforeContinue: true });

    expect((await store.readTarget({ sessionID: sessionId }))?.status).toBe("active");
    const verification = requests.find((request) => request.tools?.length === 0);
    expect(verification?.toolSearchEnabled).toBe(false);
    expect(JSON.stringify(verification?.messages)).not.toContain('"tool_reference"');
    expect(JSON.stringify(verification?.messages)).toContain(
      "Tool references removed - tool search not enabled",
    );
    expect(verification?.messages.find((message) => message.role === "tool")).toMatchObject({
      toolCallId: "search-real",
    });
    expect(
      collectDiscoveredTools(
        (runtime as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
      ),
    ).toContain("TaskOutput");
    const parts = (await store.messages({ sessionID: sessionId })).flatMap((row) => row.parts);
    expect(
      parts.find((part) => part.type === "tool" && part.callID === "search-real"),
    ).toMatchObject({
      state: {
        status: "completed",
        metadata: { modelContent: [{ type: "tool_reference", toolName: "TaskOutput" }] },
      },
    });
  } finally {
    await runtime.closeBrowserSession();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
