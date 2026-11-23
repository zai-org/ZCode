// 同步子代理里的后台 Bash 文案（04-bash.md「模型 result 映射规则」）：父会话用前台 Agent 启动的子代理，
// 后台命令的结果说明“最终回复之后不会再有通知”；“同步”在子代理启动时固定，中途转后台不改。
// 后台启动和 SendMessage 恢复的子代理用普通文案。断言读子代理 Bash 之后那个请求里的 tool result。
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createSessionId,
  modelMessageContentToText,
  type ExecutionRequest,
} from "@zcode/contracts";
import type { BashBackgroundLifecycleExecutionPort } from "../src/tool/handlers/bash-background-lifecycle.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const SYNC_SENTENCE =
  "If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that \u2014 so do not end your turn to wait for it; if you need its result, wait for it before giving your final response.";
const NOTIFY_SENTENCE = "You will be notified when it completes.";
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type Launch =
  | "foreground"
  | "background"
  | "foreground-then-background"
  | "foreground-then-SendMessage";

describe("background Bash text in subagents", () => {
  it.each([
    ["foreground", SYNC_SENTENCE],
    ["background", NOTIFY_SENTENCE],
    // 立即发送或前台超时让子代理转后台以后，它仍按启动时的同步语义说明。
    ["foreground-then-background", SYNC_SENTENCE],
    // 前台子代理结束后用 SendMessage 恢复：恢复在后台运行，这次运行的后台 Bash 用普通文案。
    ["foreground-then-SendMessage", NOTIFY_SENTENCE],
  ] as const)("a %s subagent gets the matching background Bash text", async (launch, expected) => {
    const { childBashResult } = await runChildBackgroundBash(launch);
    expect(childBashResult).toContain(expected);
    const other = expected === SYNC_SENTENCE ? NOTIFY_SENTENCE : SYNC_SENTENCE;
    expect(childBashResult).not.toContain(other);
  });

  it("keeps the normal text in the main session", async () => {
    const { mainBashResult } = await runMainBackgroundBash();
    expect(mainBashResult).toContain(NOTIFY_SENTENCE);
    expect(mainBashResult).not.toContain(SYNC_SENTENCE);
  });
});

function backgroundExecutionPort(): BashBackgroundLifecycleExecutionPort {
  let taskIndex = 0;
  return {
    async run() {
      throw new Error("only background Bash runs in this test");
    },
    async runBashWithBackgroundLifecycle(_request: ExecutionRequest) {
      taskIndex += 1;
      return {
        kind: "backgrounded",
        task: {
          taskId: `exec_bg_${taskIndex}`,
          status: "running",
          startedAt: new Date(),
          outputPath: `/tmp/exec_bg_${taskIndex}.output`,
        },
      };
    },
  };
}

async function runChildBackgroundBash(launch: Launch): Promise<{ childBashResult: string }> {
  const childRequests: any[] = [];
  let parentCalls = 0;
  let childCalls = 0;
  // 转后台的场景：子代理的首个请求等到父会话拿到转后台结果后才返回 Bash 调用。
  let movedToBackground: (() => void) | undefined;
  const moved = new Promise<void>((resolve) => {
    movedToBackground = resolve;
  });
  const runtime = createTestAgentRuntime(
    createSessionId(`subagent-bg-bash-${launch}`),
    {
      mode: "yolo",
      workingDirectory: "/workspace/project",
      subagents: {
        // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
        alwaysBackground: false,
        ...(launch === "foreground-then-background" ? { autoBackgroundMs: 1 } : {}),
        profiles: [
          {
            name: "bash-child",
            description: "Runs one background command.",
            source: "project",
            systemPrompt: "Run the requested command.",
            tools: ["Bash"],
          },
        ],
      },
    },
    {
      eventStore: createTestSessionEventStore(),
      executionPort: backgroundExecutionPort(),
      // SendMessage 恢复要读子会话已存的历史。
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (toolNames.includes("Agent")) {
            parentCalls += 1;
            if (parentCalls === 1) {
              return {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [
                  {
                    id: "call_bash_child",
                    name: "Agent",
                    input: {
                      description: "Run a background command",
                      prompt: "Start the command in the background.",
                      subagent_type: "bash-child",
                      run_in_background: launch === "background",
                    },
                  },
                ],
                usage: USAGE,
              };
            }
            const history = JSON.stringify(request.messages);
            if (history.includes("Async agent launched")) {
              movedToBackground?.();
            }
            const agentId = /agentId: (\S+) \(use SendMessage/.exec(history)?.[1];
            if (launch === "foreground-then-SendMessage" && parentCalls === 2 && agentId) {
              return {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [
                  {
                    id: "call_resume_child",
                    name: "SendMessage",
                    input: { to: agentId, message: "Start it again." },
                  },
                ],
                usage: USAGE,
              };
            }
            return { finishReason: "stop", text: "parent done", usage: USAGE };
          }

          childRequests.push(request);
          childCalls += 1;
          // 每次运行的第一个请求发起后台 Bash；恢复后的运行用另一个调用 id。
          if (childCalls === 1 || childCalls === 3) {
            if (launch === "foreground-then-background") await moved;
            return {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [
                {
                  id: childCalls === 1 ? "call_child_bg" : "call_child_bg_resumed",
                  name: "Bash",
                  input: { command: "sleep 1", run_in_background: true },
                },
              ],
              usage: USAGE,
            };
          }
          return { finishReason: "stop", text: "child done", usage: USAGE };
        },
      } as never),
    },
  );
  onTestFinished(async () => {
    await runtime.closeBrowserSession();
  });

  await runtime.executeTurn("run the child");
  if (launch === "foreground-then-SendMessage") {
    await waitFor(() => childRequests.length >= 4);
    return { childBashResult: toolResultText(childRequests[3], "call_child_bg_resumed") };
  }
  await waitFor(() => childRequests.length >= 2);
  return { childBashResult: toolResultText(childRequests[1], "call_child_bg") };
}

async function runMainBackgroundBash(): Promise<{ mainBashResult: string }> {
  const requests: any[] = [];
  const runtime = createTestAgentRuntime(
    createSessionId("main-bg-bash"),
    { mode: "yolo", workingDirectory: "/workspace/project" },
    {
      eventStore: createTestSessionEventStore(),
      executionPort: backgroundExecutionPort(),
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          requests.push(request);
          if (requests.length === 1) {
            return {
              finishReason: "tool-calls",
              text: "",
              toolCalls: [
                {
                  id: "call_main_bg",
                  name: "Bash",
                  input: { command: "sleep 1", run_in_background: true },
                },
              ],
              usage: USAGE,
            };
          }
          return { finishReason: "stop", text: "done", usage: USAGE };
        },
      } as never),
    },
  );
  onTestFinished(async () => {
    await runtime.closeBrowserSession();
  });
  await runtime.executeTurn("run the command");
  return { mainBashResult: toolResultText(requests[1], "call_main_bg") };
}

function toolResultText(request: any, toolCallId: string): string {
  const message = request.messages.find(
    (item: any) => item.role === "tool" && item.toolCallId === toolCallId,
  );
  if (!message) throw new Error(`${toolCallId} has no tool result`);
  return modelMessageContentToText(message.content);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
