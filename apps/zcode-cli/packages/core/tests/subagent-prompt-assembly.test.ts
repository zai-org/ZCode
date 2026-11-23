import { describe, expect, it, vi } from "vitest";
import { createTestModelSelection } from "./test-model-selection.js";
import {
  createModelId,
  createModelProviderId,
  createSessionId,
  modelMessageContentToText,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { buildPersistentAgentMemoryPrompt } from "../src/subagent/persistent-memory-prompt.js";
import { resolvePersistentAgentMemoryRoot } from "../src/subagent/persistent-memory.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function createMainModelSelection() {
  return {
    providerId: createModelProviderId("anthropic"),
    modelId: createModelId("claude-haiku-4-5-20251001-cc"),
  };
}

const USER_AGENTS_INSTRUCTION = "User AGENTS instruction sentinel.";
const WORKSPACE_AGENTS_INSTRUCTION = "Workspace AGENTS instruction sentinel.";
const PROJECT_CONTEXT_SENTINEL = "subagent-project-context-leak-sentinel";

function createParentContextSourcePort() {
  const hostEnvInfo = (cwd: string) => ({
    cwd,
    platform: "darwin",
    shell: "zsh",
    osVersion: "Darwin 24.3.0",
    nodeVersion: "24.14.0",
  });
  return {
    async resolveEnvironment(request: { workingDirectory: string }) {
      return hostEnvInfo(request.workingDirectory);
    },
    async resolveGitContext() {
      return { isGitRepository: false };
    },
    async resolveContextSources(request: {
      currentDate?: string;
      envInfo?: {
        cwd: string;
        platform: string;
        shell: string;
        osVersion: string;
        nodeVersion: string;
        isGitRepository?: boolean;
      };
      workingDirectory: string;
    }) {
      return {
        workingDirectory: request.workingDirectory,
        currentDate: request.currentDate,
        diagnostics: [],
        envInfo: request.envInfo ?? hostEnvInfo(request.workingDirectory),
        userInstructions: {
          filePath: "/repo/AGENTS.md",
          fileName: "AGENTS.md",
          content: WORKSPACE_AGENTS_INSTRUCTION,
          bytesRead: WORKSPACE_AGENTS_INSTRUCTION.length,
          sizeBytes: WORKSPACE_AGENTS_INSTRUCTION.length,
          truncated: false,
          sources: [
            {
              scope: "user" as const,
              filePath: "/Users/test/.zcode/AGENTS.md",
              fileName: "AGENTS.md",
              content: USER_AGENTS_INSTRUCTION,
              bytesRead: USER_AGENTS_INSTRUCTION.length,
              sizeBytes: USER_AGENTS_INSTRUCTION.length,
              truncated: false,
            },
            {
              scope: "workspace" as const,
              filePath: "/repo/AGENTS.md",
              fileName: "AGENTS.md",
              content: WORKSPACE_AGENTS_INSTRUCTION,
              bytesRead: WORKSPACE_AGENTS_INSTRUCTION.length,
              sizeBytes: WORKSPACE_AGENTS_INSTRUCTION.length,
              truncated: false,
            },
          ],
        },
        projectContext: {
          type: "node" as const,
          scripts: { [PROJECT_CONTEXT_SENTINEL]: "must-not-appear" },
        },
      };
    },
  };
}

function systemContents(request: any): string[] {
  return systemMessages(request).map((message: any) => message.content);
}

function systemMessages(request: any): any[] {
  return request.messages.filter((message: any) => message.role === "system");
}

function expectSystemMessagesCached(request: any): void {
  for (const message of systemMessages(request)) {
    expect(message.cacheControl).toEqual({ type: "ephemeral" });
  }
}

function allMessageText(request: any): string {
  return request.messages
    .map((message: any) => modelMessageContentToText(message.content))
    .join("\n");
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function expectInjectedAgentsMd(request: any, childTask: string): void {
  const messages = request.messages as any[];
  const contextIndex = messages.findIndex(
    (message) =>
      message.role === "user" &&
      modelMessageContentToText(message.content).includes(USER_AGENTS_INSTRUCTION),
  );
  const taskIndex = messages.findIndex(
    (message) =>
      message.role === "user" && modelMessageContentToText(message.content) === childTask,
  );
  expect(contextIndex).toBeGreaterThanOrEqual(0);
  expect(taskIndex).toBeGreaterThan(contextIndex);

  const contextText = modelMessageContentToText(messages[contextIndex]?.content);
  expect(contextText).toContain("<system-reminder>");
  expect(contextText).toContain("Codebase and user instructions are shown below.");
  expect(contextText).toContain(USER_AGENTS_INSTRUCTION);
  expect(contextText).toContain(WORKSPACE_AGENTS_INSTRUCTION);
  expect(contextText.indexOf(USER_AGENTS_INSTRUCTION)).toBeLessThan(
    contextText.indexOf(WORKSPACE_AGENTS_INSTRUCTION),
  );
  expect(contextText.indexOf("Codebase and user instructions")).toBeLessThan(
    contextText.indexOf(USER_AGENTS_INSTRUCTION),
  );
  expect(contextText).not.toContain("Today's date");

  const text = allMessageText(request);
  expect(countOccurrences(text, "Codebase and user instructions are shown below")).toBe(1);
  expect(text).not.toContain("# claudeMd");
  expect(countOccurrences(text, USER_AGENTS_INSTRUCTION)).toBe(1);
  expect(countOccurrences(text, WORKSPACE_AGENTS_INSTRUCTION)).toBe(1);
  expect(text).not.toContain(PROJECT_CONTEXT_SENTINEL);
  expect(text).not.toContain("# Memory");
  expect(systemContents(request).join("\n")).not.toContain(USER_AGENTS_INSTRUCTION);
  expect(systemContents(request).join("\n")).not.toContain(WORKSPACE_AGENTS_INSTRUCTION);
  expect(systemContents(request).join("\n")).not.toContain("# agentsMd");
}

function expectNoInjectedAgentsMd(request: any): void {
  const text = allMessageText(request);
  expect(text).not.toContain("# agentsMd");
  expect(text).not.toContain("# claudeMd");
  expect(text).not.toContain(USER_AGENTS_INSTRUCTION);
  expect(text).not.toContain(WORKSPACE_AGENTS_INSTRUCTION);
  expect(text).not.toContain(PROJECT_CONTEXT_SENTINEL);
}

describe("subagent provider-visible prompt assembly", () => {
  it("assembles Explore child system messages with ZCode prefix, agent prompt, notes, and environment context", async () => {
    const sessionId = createSessionId("subagent-prompt-explore");
    const contextSourcePort = createParentContextSourcePort();
    const resolveContext = vi.spyOn(contextSourcePort, "resolveContextSources");
    const eventStore = createTestSessionEventStore();
    const childRequests: any[] = [];
    let parentCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: createTestModelSelection(createMainModelSelection()),
        bashShellSelection: {
          dialect: "git-bash",
          display: { name: "Git Bash" },
          path: "C:\\Program Files\\Git\\bin\\bash.exe",
          source: "user-config",
        },
        workingDirectory: "/Users/dev/Desktop/Z/z-code/apps/zcode-cli",
        currentDate: "2026-06-04",
        envInfo: {
          cwd: "/Users/dev/Desktop/Z/z-code/apps/zcode-cli",
          platform: "darwin",
          shell: "zsh",
          osVersion: "Darwin 24.3.0",
          nodeVersion: "24.14.0",
          isGitRepository: true,
        },
      },
      {
        contextSourcePort,
        eventStore,
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [
                    {
                      id: "call_explore",
                      name: "Agent",
                      input: {
                        description: "Find runtime loop",
                        prompt: "Find where the runtime injects tool results.",
                        subagent_type: "Explore",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                text: "parent used explore result",
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              };
            }
            childRequests.push(request);
            return {
              finishReason: "stop",
              text: "Explore found the runtime path.",
              usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Use an explore agent for this question");

    expect(childRequests).toHaveLength(1);
    expectSystemMessagesCached(childRequests[0]);
    const systems = systemContents(childRequests[0]);
    expect(systems.map((content) => content.endsWith("\n"))).toEqual([false, false]);
    expect(systems[0]).toBe("You are ZCode, an interactive agent");
    expect(systems[1]).toMatch(/^\nYou are ZCode Explore/u);
    expect(systems[1]).toContain("READ-ONLY MODE");
    expect(systems[1]).toContain("\n\nNotes:");
    expect(systems[1]).toContain("Agent threads always have their cwd reset between bash calls");
    expect(systems[1]).toContain("the parent agent reads your text output");
    expect(systems[1]).not.toContain("<env>");
    expect(systems[1]).not.toContain("You are powered by");
    const childMessages = childRequests[0].messages;
    const environmentMessage = childMessages.find((message: any) =>
      modelMessageContentToText(message.content).includes("# Environment\n"),
    );
    const taskIndex = childMessages.findIndex(
      (message: any) =>
        modelMessageContentToText(message.content) ===
        "Find where the runtime injects tool results.",
    );
    // 不支持 MCS 时，环境是任务前的 user reminder。
    expect(environmentMessage.role).toBe("user");
    expect(childMessages.indexOf(environmentMessage)).toBeLessThan(taskIndex);
    // 只有父级解析一次 context；child 初始化不再调用。
    expect(resolveContext).toHaveBeenCalledTimes(1);
    const childText = allMessageText(childRequests[0]);
    expect(childText).toContain(
      " - Primary working directory: /Users/dev/Desktop/Z/z-code/apps/zcode-cli",
    );
    expect(childText).toContain(" - Is a git repository: true");
    expect(childText).toContain(" - Shell: Git Bash");
    expect(
      countOccurrences(
        childText,
        "You are powered by the model named anthropic/claude-haiku-4-5-20251001-cc.",
      ),
    ).toBe(1);

    const text = allMessageText(childRequests[0]);
    expect(text).not.toContain(
      "You help the user with software engineering work in the current workspace.",
    );
    expect(text).not.toContain("# user_instructions");
    expect(text).not.toContain("Project context:");
    expectNoInjectedAgentsMd(childRequests[0]);
  });

  it("adds common notes and environment context to general-purpose child prompts", async () => {
    const sessionId = createSessionId("subagent-prompt-general-purpose");
    const eventStore = createTestSessionEventStore();
    const childRequests: any[] = [];
    let parentCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: createTestModelSelection(createMainModelSelection()),
        presentationSurface: "zcode_desktop",
        workingDirectory: "/repo/current",
        currentDate: "2026-06-04",
        envInfo: {
          cwd: "/repo/initial",
          platform: "darwin",
          shell: "zsh",
          osVersion: "Darwin 24.3.0",
          nodeVersion: "24.14.0",
          isGitRepository: true,
        },
      },
      {
        contextSourcePort: createParentContextSourcePort(),
        eventStore,
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [
                    {
                      id: "call_general",
                      name: "Agent",
                      input: {
                        description: "Research runtime",
                        prompt: "Research how child runtimes are created.",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                text: "parent used general result",
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              };
            }
            childRequests.push(request);
            return {
              finishReason: "stop",
              text: "General-purpose agent found the runtime path.",
              usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Use a general-purpose agent for this question");

    expect(childRequests).toHaveLength(1);
    expectSystemMessagesCached(childRequests[0]);
    const systems = systemContents(childRequests[0]);
    expect(systems).toHaveLength(2);
    expect(systems[0]).toBe("You are ZCode, an interactive agent");
    expect(systems[1]).toContain("You are an agent for ZCode CLI");
    expect(systems[1]).toContain("Complete the task fully—don't gold-plate");
    expect(systems[1]).toContain("the caller will relay this to the user");
    expect(systems[1]).not.toContain("fully--don't gold-plate");
    expect(systems[1]).not.toContain("key findings; the caller");
    expect(systems[1]).toContain("Agent threads always have their cwd reset between bash calls");
    expect(systems[1]).not.toContain("<env>");
    expect(allMessageText(childRequests[0])).toContain(
      " - Primary working directory: /repo/current",
    );
    expect(allMessageText(childRequests[0])).not.toContain(
      " - Primary working directory: /repo/initial",
    );
    // 父会话已离开起始目录，child 必须沿用当前环境事实，不能带回起始快照里的 true。
    expect(allMessageText(childRequests[0])).toContain(" - Is a git repository: false");
    expectInjectedAgentsMd(childRequests[0], "Research how child runtimes are created.");
  });

  it.each([
    { expectedToInject: true, injectAgentsMd: undefined, label: "missing default" },
    { expectedToInject: false, injectAgentsMd: false, label: "explicit false" },
  ])(
    "assembles custom child prompts with $label AGENTS.md injection",
    async ({ expectedToInject, injectAgentsMd, label }) => {
      const sessionId = createSessionId(`subagent-prompt-custom-${label.replace(/\s+/gu, "-")}`);
      const eventStore = createTestSessionEventStore();
      const childRequests: any[] = [];
      let parentCallCount = 0;

      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "build",
          modelSelection: createTestModelSelection(createMainModelSelection()),
          workingDirectory: "/repo",
          currentDate: "2026-06-04",
          envInfo: {
            cwd: "/repo",
            platform: "darwin",
            shell: "zsh",
            osVersion: "Darwin 24.3.0",
            nodeVersion: "24.14.0",
            isGitRepository: false,
          },
          subagents: {
            profiles: [
              {
                name: "code-researcher",
                description: "Research code paths.",
                color: "blue",
                source: "user",
                systemPrompt: "You are a focused code researcher. Return concise findings.",
                tools: ["Read", "Grep", "Glob"],
                ...(injectAgentsMd === undefined ? {} : { injectAgentsMd }),
              },
            ],
          },
        },
        {
          contextSourcePort: createParentContextSourcePort(),
          eventStore,
          modelFactory: createTestModelFactory({
            properties: { supportsNativeWebSearch: true },
            async generateText(request: any) {
              const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
              if (toolNames.includes("Agent")) {
                parentCallCount++;
                if (parentCallCount === 1) {
                  return {
                    finishReason: "tool-calls",
                    text: "",
                    toolCalls: [
                      {
                        id: "call_custom",
                        name: "Agent",
                        input: {
                          description: "Research custom",
                          prompt: "Research the custom profile path.",
                          subagent_type: "code-researcher",
                        },
                      },
                    ],
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  };
                }
                return {
                  finishReason: "stop",
                  text: "parent used custom result",
                  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
                };
              }
              childRequests.push(request);
              return {
                finishReason: "stop",
                text: "Custom agent found the runtime path.",
                usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
              };
            },
          } as never),
        },
      );

      await runtime.executeTurn("Use the custom researcher agent for this question");

      expect(childRequests).toHaveLength(1);
      expectSystemMessagesCached(childRequests[0]);
      const systems = systemContents(childRequests[0]);
      expect(systems).toHaveLength(2);
      expect(systems[0]).toBe("You are ZCode, an interactive agent");
      expect(systems[1]).toMatch(
        /^\nYou are a focused code researcher\. Return concise findings\.\n\nMessages from the agent that launched you — .+\n\nNotes:/u,
      );
      expect(allMessageText(childRequests[0])).toContain(" - Is a git repository: false");
      if (expectedToInject) {
        expectInjectedAgentsMd(childRequests[0], "Research the custom profile path.");
      } else {
        expectNoInjectedAgentsMd(childRequests[0]);
      }
    },
  );

  it("puts the launcher-messages paragraph between the trimmed agent prompt and Notes", () => {
    const result = createSubagentContextBuilder({
      agentPrompt: "\n  You are a reviewer.\n",
      envInfo: {
        cwd: "/repo",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 24.3.0",
        nodeVersion: "24.14.0",
        isGitRepository: false,
      },
    }).build();

    const systems = systemContents({ messages: result.systemMessages });
    // agent 正文两端 trim 后接启动方消息段，再接 Notes；逐字文本由 subagent-explore 锁定。
    expect(systems[1]).toMatch(
      /^\nYou are a reviewer\.\n\nMessages from the agent that launched you — .+\n\nNotes:\n/u,
    );
  });

  it("keeps Notes in the body and environment separate when a custom child prompt is empty", () => {
    const result = createSubagentContextBuilder({
      agentPrompt: "",
      envInfo: {
        cwd: "/repo",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 24.3.0",
        nodeVersion: "24.14.0",
        isGitRepository: false,
      },
    }).build();

    expectSystemMessagesCached({ messages: result.systemMessages });
    const systems = systemContents({ messages: result.systemMessages });
    expect(systems).toHaveLength(2);
    expect(systems[0]).toBe("You are ZCode, an interactive agent");
    expect(systems[1]).toMatch(/^\n\nMessages from the agent that launched you — .+\n\nNotes:/u);
    expect(systems[1]).not.toContain("<env>");
    // 主会话的 Finishing work 与 memory notes 两段不进子代理。
    expect(systems.join("")).not.toContain("# Finishing work");
    expect(systems.join("")).not.toContain("# Memory, notes and feedback");
    expect(result.metaUserAttachments).toEqual([]);
    expect(result.sections.find((section) => section.source === "env_info")?.content).toContain(
      "# Environment\n",
    );
    expect(systems.join("")).toBe(
      result.sections
        .filter((section) => section.injectionTarget === "system")
        .map((section) => section.content)
        .join(""),
    );
  });

  it.each(["user", "project", "local"] as const)(
    "projects exact %s persistent memory context and supported write tools to a custom child",
    async (scope) => {
      const sessionId = createSessionId(`subagent-prompt-persistent-memory-${scope}`);
      const eventStore = createTestSessionEventStore();
      const memoryRoot = resolvePersistentAgentMemoryRoot({
        agentName: "persistent-reviewer",
        scope,
        storageRoot: "/storage",
        workspaceRoot: "/repo",
      });
      const fileSystemPort = new MemoryFileSystem({
        [`${memoryRoot}/MEMORY.md`]: "- [Review style](review-style.md) — keep reviews concise",
      });
      const parentRequests: any[] = [];
      const childRequests: any[] = [];
      let parentCallCount = 0;

      const runtime = createTestAgentRuntime(
        sessionId,
        {
          memory: { enabled: true, storageRoot: "/storage", use: true },
          mode: "build",
          modelSelection: createTestModelSelection(createMainModelSelection()),
          workingDirectory: "/repo",
          currentDate: "2026-06-04",
          envInfo: {
            cwd: "/repo",
            platform: "darwin",
            shell: "zsh",
            osVersion: "Darwin 24.3.0",
            nodeVersion: "24.14.0",
            isGitRepository: false,
          },
          subagents: {
            // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
            alwaysBackground: false,
            profiles: [
              {
                name: "persistent-reviewer",
                description: "Review with durable context.",
                disallowedTools: ["Edit"],
                memory: scope,
                source: "user",
                systemPrompt: "",
                tools: ["Grep"],
              },
            ],
          },
        },
        {
          eventStore,
          fileSystemPort,
          modelFactory: createTestModelFactory({
            properties: { supportsNativeWebSearch: true },
            async generateText(request: any) {
              const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
              if (toolNames.includes("Agent")) {
                parentRequests.push(request);
                parentCallCount += 1;
                if (parentCallCount === 1) {
                  return {
                    finishReason: "tool-calls",
                    text: "",
                    toolCalls: [
                      {
                        id: "call_persistent",
                        name: "Agent",
                        input: {
                          description: "Review persistent",
                          prompt: "Review using the persistent context.",
                          subagent_type: "persistent-reviewer",
                        },
                      },
                    ],
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  };
                }
                return {
                  finishReason: "stop",
                  text: "parent used persistent review",
                  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
                };
              }
              childRequests.push(request);
              if (childRequests.length === 1) {
                return {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [
                    {
                      id: "write_persistent_memory",
                      name: "Write",
                      input: {
                        content: "Keep reviews concise.",
                        file_path: `${memoryRoot}/review-style.md`,
                      },
                    },
                  ],
                  usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
                };
              }
              return {
                finishReason: "stop",
                text: "Persistent reviewer completed.",
                usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
              };
            },
          } as never),
        },
      );

      await runtime.executeTurn("review");

      expect(childRequests).toHaveLength(2);
      const expectedMemoryPrompt = buildPersistentAgentMemoryPrompt({
        indexContent: "- [Review style](review-style.md) — keep reviews concise",
        rootDir: memoryRoot,
        scope,
      });
      // 记忆段之后先接启动方消息段，再接 Notes。
      expect(
        systemContents(childRequests[0])[1]?.split(
          "\n\nMessages from the agent that launched you",
        )[0],
      ).toBe(`\n${expectedMemoryPrompt}`);
      const childToolNames = childRequests[0].tools.map((tool: any) => tool.name);
      expect(childToolNames).toContain("Grep");
      expect(childToolNames).toContain("Write");
      expect(childToolNames).not.toContain("Edit");
      expect(childToolNames).not.toContain("Read");
      expect(fileSystemPort.createdDirectories).toContain(memoryRoot);
      expect(fileSystemPort.files[`${memoryRoot}/review-style.md`]).toBe("Keep reviews concise.");
      expect(
        parentRequests[0].messages
          .map((message: any) => modelMessageContentToText(message.content))
          .join("\n"),
      ).toContain("Tools: Grep, Write");
    },
  );

  it("keeps subagent context builder output after runtime context refresh", async () => {
    const sessionId = createSessionId("subagent-prompt-refresh");
    const eventStore = createTestSessionEventStore();
    const requests: any[] = [];

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        modelSelection: createTestModelSelection(createMainModelSelection()),
        workingDirectory: "/repo/current",
        currentDate: "2026-06-04",
        envInfo: {
          cwd: "/repo/current",
          platform: "darwin",
          shell: "zsh",
          osVersion: "Darwin 24.3.0",
          nodeVersion: "24.14.0",
          isGitRepository: true,
        },
        subagentContext: {
          agentPrompt: "You are a focused child agent. Keep the result concise.",
        },
        taskType: "subagent_child",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "stop",
              text: `child response ${requests.length}`,
              usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first child request");
    runtime.updateConfig({ outputStyle: undefined });
    await runtime.executeTurn("second child request after refresh");

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expectSystemMessagesCached(request);
      const systems = systemContents(request);
      expect(systems).toHaveLength(2);
      expect(systems[0]).toBe("You are ZCode, an interactive agent");
      expect(systems[1]).toMatch(
        /^\nYou are a focused child agent\. Keep the result concise\.\n\nMessages from the agent that launched you — .+\n\nNotes:/u,
      );
      expect(systems[1]).toContain("Agent threads always have their cwd reset between bash calls");
      expect(allMessageText(request)).toContain(" - Primary working directory: /repo/current");
      expect(allMessageText(request)).toContain(
        "You are powered by the model named anthropic/claude-haiku-4-5-20251001-cc.",
      );
      expect(allMessageText(request)).not.toContain(
        "You help the user with software engineering work in the current workspace.",
      );
      expect(allMessageText(request)).not.toContain("# ZCode Desktop Context");
    }
  });
});
