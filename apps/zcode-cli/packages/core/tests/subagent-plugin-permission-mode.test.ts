import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  type CollaborationMode,
  type PermissionBrokerRequest,
} from "@zcode/contracts";
import { createManualPermissionBroker } from "../src/permission/broker.js";
import type { AgentProfile } from "../src/subagent/profile.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

// 插件 profile 曾按用户级处理：父会话 build 时，声明 bypassPermissions 的插件 agent
// 会让子会话以 yolo 运行，模型生成的 Bash 直接执行。插件声明现在只能收紧父会话模式。
function runPluginChild(
  parentMode: CollaborationMode,
  permissionMode: AgentProfile["permissionMode"],
) {
  const requests: PermissionBrokerRequest[] = [];
  const execute = vi.fn(async () => {
    throw new Error("Must not execute");
  });
  const childModelRequests: string[] = [];
  let mainCalls = 0;
  let childCalls = 0;
  const broker = createManualPermissionBroker({
    onRequest: (request) => {
      requests.push(request);
    },
  });
  const sessionId = createSessionId(`plugin-permission-${parentMode}`);
  const runtime = createTestAgentRuntime(
    sessionId,
    {
      mode: parentMode,
      workingDirectory: "/workspace/plugin-permission-fixture",
      bashShellSelection: {
        dialect: "posix",
        source: "auto-detected",
        display: { name: "bash" },
      },
      subagents: {
        profiles: [
          {
            name: "fixture:plugin-agent",
            description: "plugin agent",
            source: "user",
            tools: ["Bash"],
            systemPrompt: "test",
            permissionMode,
            permissionModeRestrictOnly: true,
          },
        ],
      },
    },
    {
      eventStore: createTestSessionEventStore(),
      executionPort: { run: execute },
      permissionBroker: {
        requestPermission: (request, options) =>
          broker.requestPermission(request, { ...options, timeoutMs: 3000 }),
      },
      modelFactory: createTestModelFactory({
        async generateText(request, observation) {
          const child =
            (observation.invocationContext?.metadata as { querySource?: string })?.querySource ===
            "subagent";
          const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
          if (child) childModelRequests.push(JSON.stringify(request));
          if (child && ++childCalls === 1)
            return {
              finishReason: "tool-calls",
              text: "",
              usage,
              toolCalls: [
                { id: "plugin-child-rm", name: "Bash", input: { command: "rm -rf fixture" } },
              ],
            };
          if (!child && ++mainCalls === 1)
            return {
              finishReason: "tool-calls",
              text: "",
              usage,
              toolCalls: [
                {
                  id: "plugin-agent",
                  name: "Agent",
                  input: {
                    description: "test",
                    prompt: "test",
                    subagent_type: "fixture:plugin-agent",
                  },
                },
              ],
            };
          return { finishReason: "stop", text: "done", usage };
        },
      }),
    },
  );
  return {
    broker,
    childModelRequests,
    execute,
    requests,
    sessionId,
    turn: runtime.executeTurn("Run the plugin child"),
  };
}

describe("plugin subagent permissionMode only restricts the parent mode", () => {
  it("build parent keeps approval for a plugin child declaring bypassPermissions", async () => {
    const { broker, execute, requests, sessionId, turn } = runPluginChild(
      "build",
      "bypassPermissions",
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ mode: "build", sessionId, origin: { kind: "subagent" } });
    expect(execute).not.toHaveBeenCalled();
    expect(broker.resolvePermission(requests[0]!.requestId, { decision: "deny" })).toBe(true);
    await turn;
    expect(execute).not.toHaveBeenCalled();
  });

  it("yolo parent still applies a stricter plugin plan mode", async () => {
    const { childModelRequests, execute, requests, turn } = runPluginChild("yolo", "plan");
    await turn;
    await vi.waitFor(() =>
      expect(
        childModelRequests.some((request) =>
          request.includes("Plan mode only allows read-only, non-destructive tools"),
        ),
      ).toBe(true),
    );
    expect(requests).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
