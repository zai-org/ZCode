// 前台长 sleep 拦截（04-bash.md「前台 sleep 拦截」）：只看第一个顶层元素，`sleep N`（N ≥ 25）在 validateInput
// 拒绝；后台、后台不可用、CMD shell 放行；主会话和子代理都拦截，被拒时不跑 hook、不请求权限、不启动进程。
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  HookEventName,
  createSessionId,
  createToolCallId,
  createTurnId,
  modelMessageContentToText,
  type ExecutionPort,
  type ExecutionShellSelection,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import type { BashBackgroundLifecycleExecutionPort } from "../src/tool/handlers/bash-background-lifecycle.js";
import { describeBlockedForegroundSleep } from "../src/tool/handlers/bash-semantics.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const ADVICE =
  "To wait for a condition, run an until-loop with run_in_background: true (e.g. `until <check>; do sleep 2; done`); you are notified when it exits. To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.";
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

describe("foreground sleep detection", () => {
  it.each([
    ["sleep 25", "standalone sleep 25"],
    ["sleep 25.", "standalone sleep 25"],
    ["sleep 0025", "standalone sleep 25"],
    ["sleep 25.0", "standalone sleep 25"],
    ["sleep 25.50", "standalone sleep 25.5"],
    ["  sleep  30 ", "standalone sleep 30"],
    ["sleep 30 > /dev/null 2>&1", "standalone sleep 30"],
    ["sleep 30 &", "standalone sleep 30"],
    ["# wait for the server\nsleep 30", "standalone sleep 30"],
    ["sleep 30 && make", "sleep 30 followed by: make"],
    ["sleep 30; make", "sleep 30 followed by: make"],
    ["sleep 30\nmake", "sleep 30 followed by: make"],
    ["sleep 30 | cat", "sleep 30 followed by: cat"],
    ["sleep 30 |& cat", "sleep 30 followed by: cat"],
    ["sleep 30 & wait", "sleep 30 followed by: wait"],
    ["sleep 30 && npm test > log.txt || echo failed", "sleep 30 followed by: npm test echo failed"],
    ["sleep 30 | cat && (make)", "sleep 30 followed by: cat (make)"],
    // 超过解析上限时按整条命令判断。
    [`sleep 30${" ".repeat(10_001)}`, "standalone sleep 30"],
  ])("blocks %j as %j", (command, reason) => {
    expect(describeBlockedForegroundSleep(command)).toBe(reason);
  });

  it.each([
    "sleep 24",
    "sleep 24.9",
    "sleep 0",
    "sleep 25s",
    "sleep 1m",
    "sleep .5",
    "sleep 1e2",
    'sleep "30"',
    "FOO=1 sleep 30",
    "/bin/sleep 30",
    "timeout 40 sleep 30",
    "time sleep 30",
    "! sleep 30",
    "(sleep 30)",
    "{ sleep 30; }",
    "sh -c 'sleep 60'",
    "echo a; sleep 30",
    "until curl -s localhost:3000; do sleep 30; done",
    // 解析有错误时按整条命令判断，整条命令不匹配。
    "sleep 30 && (",
    `sleep 30;${" echo x".repeat(2_000)}`,
    "",
  ])("allows %j", (command) => {
    expect(describeBlockedForegroundSleep(command)).toBeUndefined();
  });
});

describe("Bash validateInput for foreground sleep", () => {
  const lifecyclePort = {
    run: vi.fn(),
    runBashWithBackgroundLifecycle: vi.fn(),
  } as unknown as ExecutionPort;
  const posix: ExecutionShellSelection = {
    dialect: "posix",
    source: "auto-detected",
    display: { name: "bash" },
  };

  it("rejects with error code 10 and the fixed advice", () => {
    expect(
      bashToolEntry.validateInput?.(
        { command: "sleep 30 && make" },
        { executionPort: lifecyclePort, bashShellSelection: posix },
      ),
    ).toEqual({
      result: false,
      errorCode: 10,
      message: `Blocked: sleep 30 followed by: make. ${ADVICE}`,
    });
    // shell 选择还没初始化时按 posix 处理。
    expect(
      bashToolEntry.validateInput?.({ command: "sleep 30" }, { executionPort: lifecyclePort }),
    ).toMatchObject({ result: false, errorCode: 10 });
  });

  it.each([
    ["run_in_background: true", { command: "sleep 30", run_in_background: true }, {}],
    [
      "an execution port without the Bash background lifecycle",
      { command: "sleep 30" },
      { executionPort: { run: vi.fn() } as unknown as ExecutionPort },
    ],
    ["no execution port", { command: "sleep 30" }, { executionPort: undefined }],
    [
      "the cmd shell",
      { command: "sleep 30" },
      { bashShellSelection: { ...posix, dialect: "cmd" as const } },
    ],
    [
      "the legacy shell",
      { command: "sleep 30" },
      { bashShellSelection: { ...posix, dialect: "legacy-shell" as const } },
    ],
    ["a short sleep", { command: "sleep 24" }, {}],
  ])("allows %s", (_name, input, context) => {
    expect(
      bashToolEntry.validateInput?.(input, {
        executionPort: lifecyclePort,
        bashShellSelection: posix,
        ...context,
      }),
    ).toEqual({ result: true });
  });
});

it("rejects a long foreground sleep before hooks, permission and execution", async () => {
  const hookEvents: string[] = [];
  const requestPermission = vi.fn(async () => ({ decision: "allow" as const }));
  const port: BashBackgroundLifecycleExecutionPort = {
    run: vi.fn(async () => {
      throw new Error("execution reached");
    }),
    runBashWithBackgroundLifecycle: vi.fn(async () => {
      throw new Error("execution reached");
    }),
  };
  const registry = createToolRegistry();
  registry.register(bashToolEntry);
  const executor = createToolExecutor({
    emitEvent: async () => {},
    executionPort: port,
    hookRunner: createInMemoryHookRunner({
      hooks: [
        HookEventName.PreToolUse,
        HookEventName.PostToolUse,
        HookEventName.PostToolUseFailure,
      ].map((event) => ({
        event,
        matcher: "Bash",
        callback: async (input) => {
          hookEvents.push(input.hookEventName);
          return {};
        },
      })),
    }),
    mode: "build",
    permissionBroker: { requestPermission },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId: createSessionId("bash-sleep-block"),
    turnId: createTurnId("turn"),
    workingDirectory: process.cwd(),
  });

  const result = await executor.execute({
    id: createToolCallId("bash-sleep"),
    input: { command: "sleep 25" },
    name: "Bash",
  });

  expect(result.success).toBe(false);
  expect(result.modelContent).toBe(
    `<tool_use_error>Blocked: standalone sleep 25. ${ADVICE}</tool_use_error>`,
  );
  // App 工具卡显示不带标签的原文。
  expect(result.error?.message).toBe(`Blocked: standalone sleep 25. ${ADVICE}`);
  expect(hookEvents).toEqual([]);
  expect(requestPermission).not.toHaveBeenCalled();
  expect(port.run).not.toHaveBeenCalled();
  expect(port.runBashWithBackgroundLifecycle).not.toHaveBeenCalled();
});

describe("foreground sleep in a session", () => {
  it.each(["main session", "subagent"] as const)(
    "the %s gets the blocked result with is_error",
    async (actor) => {
      const { result, port } = await runSleepCall(actor);
      expect(result.isError).toBe(true);
      expect(modelMessageContentToText(result.content)).toBe(
        `<tool_use_error>Blocked: standalone sleep 30. ${ADVICE}</tool_use_error>`,
      );
      expect(port.run).not.toHaveBeenCalled();
      expect(port.runBashWithBackgroundLifecycle).not.toHaveBeenCalled();
    },
  );
});

async function runSleepCall(actor: "main session" | "subagent") {
  const requests: any[] = [];
  const port: BashBackgroundLifecycleExecutionPort = {
    run: vi.fn(async () => {
      throw new Error("execution reached");
    }),
    runBashWithBackgroundLifecycle: vi.fn(async () => {
      throw new Error("execution reached");
    }),
  };
  const sleepCall = {
    finishReason: "tool-calls",
    text: "",
    toolCalls: [{ id: "call_sleep", name: "Bash", input: { command: "sleep 30" } }],
    usage: USAGE,
  };
  let childCalls = 0;
  const runtime = createTestAgentRuntime(
    createSessionId(`bash-sleep-${actor === "subagent" ? "child" : "main"}`),
    {
      mode: "yolo",
      workingDirectory: "/workspace/project",
      subagents: {
        // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
        alwaysBackground: false,
        profiles: [
          {
            name: "sleep-child",
            description: "Waits.",
            source: "project",
            systemPrompt: "Wait as asked.",
            tools: ["Bash"],
          },
        ],
      },
    },
    {
      eventStore: createTestSessionEventStore(),
      executionPort: port,
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          const isParent = toolNames.includes("Agent");
          if (actor === "main session" || !isParent) {
            if (actor === "subagent") childCalls += 1;
            requests.push(request);
            if (requests.length === 1) return sleepCall;
            return { finishReason: "stop", text: "done", usage: USAGE };
          }
          if (childCalls === 0) {
            return {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [
                {
                  id: "call_child",
                  name: "Agent",
                  input: {
                    description: "Wait",
                    prompt: "Wait for 30 seconds.",
                    subagent_type: "sleep-child",
                    run_in_background: false,
                  },
                },
              ],
              usage: USAGE,
            };
          }
          return { finishReason: "stop", text: "parent done", usage: USAGE };
        },
      } as never),
    },
  );
  onTestFinished(async () => {
    await runtime.closeBrowserSession();
  });
  await runtime.executeTurn("wait a bit");
  const result = requests[1]?.messages.find(
    (item: any) => item.role === "tool" && item.toolCallId === "call_sleep",
  );
  if (!result) throw new Error("the sleep call has no tool result");
  return { result, port };
}
