import { assertSubagentListingTrajectory } from "#e2e/helpers/subagent-listing-assertions";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { resolveE2EHomeDir } from "#e2e/helpers/e2e-runtime-paths";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import { UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";
import { prepareIncomingMessageCapability } from "#e2e/helpers/incoming-message-capability";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  assertVisibleV4UserMessagesNotContaining,
  sendV4Prompt,
  prepareV4ConversationE2E,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const BUILTIN_PARENT_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_BUILTIN_PARENT";
const BUILTIN_CHILD_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_BUILTIN_CHILD";
const BUILTIN_CHILD_REPLY_TOKEN = "E2E_SUBAGENT_PROMPT_ASSEMBLY_BUILTIN_CHILD_OK";
const BUILTIN_FINAL_TOKEN = "subagent-prompt-assembly-builtin-done";
const EXPLORE_PARENT_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_EXPLORE_PARENT";
const EXPLORE_CHILD_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_EXPLORE_CHILD";
const EXPLORE_CHILD_REPLY_TOKEN = "E2E_SUBAGENT_PROMPT_ASSEMBLY_EXPLORE_CHILD_OK";
const EXPLORE_FINAL_TOKEN = "subagent-prompt-assembly-explore-done";
const CUSTOM_AGENT_NAME = "e2e-prompt-assembly-reviewer";
const CUSTOM_AGENT_PROMPT_MARKER = "E2E_CUSTOM_PROMPT_ASSEMBLY_AGENT_BODY";
const CUSTOM_PARENT_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_CUSTOM_PARENT";
const CUSTOM_CHILD_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_CUSTOM_CHILD";
const CUSTOM_CHILD_REPLY_TOKEN = "E2E_SUBAGENT_PROMPT_ASSEMBLY_CUSTOM_CHILD_OK";
const CUSTOM_FINAL_TOKEN = "subagent-prompt-assembly-custom-done";
const ISOLATED_CUSTOM_AGENT_NAME = "e2e-prompt-assembly-isolated";
const ISOLATED_CUSTOM_AGENT_PROMPT_MARKER = "E2E_ISOLATED_CUSTOM_PROMPT_ASSEMBLY_AGENT_BODY";
const ISOLATED_CUSTOM_PARENT_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_ISOLATED_PARENT";
const ISOLATED_CUSTOM_CHILD_MARKER = "E2E_SUBAGENT_PROMPT_ASSEMBLY_ISOLATED_CHILD";
const ISOLATED_CUSTOM_CHILD_REPLY_TOKEN = "E2E_SUBAGENT_PROMPT_ASSEMBLY_ISOLATED_CHILD_OK";
const ISOLATED_CUSTOM_FINAL_TOKEN = "subagent-prompt-assembly-isolated-done";
const USER_AGENTS_MARKER = "E2E_SUBAGENT_USER_AGENTS_INSTRUCTION";
const LAUNCHER_MESSAGES_NOTE = "Messages from the agent that launched you";
const ENVIRONMENT_ANNOUNCEMENT =
  "# Environment\nYou have been invoked in the following environment";
const MODEL_ANNOUNCEMENT = "You are powered by the model named";
const DATE_ANNOUNCEMENT = "Today's date is ";
const INSTRUCTIONS_PREAMBLE = "Codebase and user instructions are shown below.";
const WORKSPACE_AGENTS_MARKER = "E2E_SUBAGENT_WORKSPACE_AGENTS_INSTRUCTION";
const TEST_HOME_DIR = resolveE2EHomeDir();
const USER_AGENTS_PATH = join(TEST_HOME_DIR, ".zcode", "AGENTS.md");
const WORKSPACE_AGENTS_PATH = join(DEFAULT_WORKSPACE, "AGENTS.md");
const CUSTOM_AGENT_PROFILE = `---
name: ${CUSTOM_AGENT_NAME}
description: E2E custom reviewer for subagent prompt assembly.
tools: Read
maxTurns: 1
---
You are the E2E custom prompt assembly reviewer.
${CUSTOM_AGENT_PROMPT_MARKER}
Reply only with the requested marker.
`;
const ISOLATED_CUSTOM_AGENT_PROFILE = `---
name: ${ISOLATED_CUSTOM_AGENT_NAME}
description: E2E custom reviewer that omits injected AGENTS.md.
tools: Read
maxTurns: 1
injectAgentsMd: false
---
You are the isolated E2E custom prompt assembly reviewer.
${ISOLATED_CUSTOM_AGENT_PROMPT_MARKER}
Reply only with the requested marker.
`;
const CUSTOM_AGENT_PATHS = [
  join(TEST_HOME_DIR, ".zcode", "agents", `${CUSTOM_AGENT_NAME}.md`),
  join(TEST_HOME_DIR, ".zcode", "cli", "agents", `${CUSTOM_AGENT_NAME}.md`),
];
const ISOLATED_CUSTOM_AGENT_PATHS = [
  join(TEST_HOME_DIR, ".zcode", "agents", `${ISOLATED_CUSTOM_AGENT_NAME}.md`),
  join(TEST_HOME_DIR, ".zcode", "cli", "agents", `${ISOLATED_CUSTOM_AGENT_NAME}.md`),
];

describe("会话区 subagent prompt assembly E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await removeSubagentInstructionFixtures();
  });

  it("I21: child trajectory 应按 profile 注入或省略父级 AGENTS.md", async function () {
    this.timeout(240000);

    await seedSubagentInstructionFixtures();
    await prepareIncomingMessageCapability(false);

    await runSubagentPromptAssemblyScenario({
      agentPromptIncludes: [
        "You are an agent for ZCode CLI",
        "the caller will relay this to the user",
      ],
      agentPromptExcludes: [CUSTOM_AGENT_PROMPT_MARKER],
      childMarker: BUILTIN_CHILD_MARKER,
      childReplyToken: BUILTIN_CHILD_REPLY_TOKEN,
      finalToken: BUILTIN_FINAL_TOKEN,
      parentMarker: BUILTIN_PARENT_MARKER,
      shouldInjectAgentsMd: true,
      subagentType: "general-purpose",
    });

    // Bug 根因：四类请求复用同一历史会话会在第二轮前触发 compact，令本 case
    // 混入无关的压缩 fixture；保持同一窗口，用项目内新任务隔离每类 child trajectory。
    // 全局新建会改变 cwd，导致 custom child 缺少本项目的 AGENTS.md 指令。
    await prepareV4ConversationE2E({ skipProvider: true });
    await runSubagentPromptAssemblyScenario({
      agentPromptIncludes: ["You are ZCode Explore", "READ-ONLY MODE"],
      agentPromptExcludes: [CUSTOM_AGENT_PROMPT_MARKER],
      childMarker: EXPLORE_CHILD_MARKER,
      childReplyToken: EXPLORE_CHILD_REPLY_TOKEN,
      finalToken: EXPLORE_FINAL_TOKEN,
      parentMarker: EXPLORE_PARENT_MARKER,
      shouldInjectAgentsMd: false,
      subagentType: "Explore",
    });

    await prepareV4ConversationE2E({ skipProvider: true });
    await runSubagentPromptAssemblyScenario({
      agentPromptIncludes: [
        "You are the E2E custom prompt assembly reviewer.",
        CUSTOM_AGENT_PROMPT_MARKER,
        "Reply only with the requested marker.",
      ],
      agentPromptExcludes: ["You are an agent for ZCode CLI"],
      childMarker: CUSTOM_CHILD_MARKER,
      childReplyToken: CUSTOM_CHILD_REPLY_TOKEN,
      finalToken: CUSTOM_FINAL_TOKEN,
      parentMarker: CUSTOM_PARENT_MARKER,
      shouldInjectAgentsMd: true,
      subagentType: CUSTOM_AGENT_NAME,
    });

    await prepareV4ConversationE2E({ skipProvider: true });
    await runSubagentPromptAssemblyScenario({
      agentPromptIncludes: [
        "You are the isolated E2E custom prompt assembly reviewer.",
        ISOLATED_CUSTOM_AGENT_PROMPT_MARKER,
        "Reply only with the requested marker.",
      ],
      agentPromptExcludes: ["You are an agent for ZCode CLI"],
      childMarker: ISOLATED_CUSTOM_CHILD_MARKER,
      childReplyToken: ISOLATED_CUSTOM_CHILD_REPLY_TOKEN,
      finalToken: ISOLATED_CUSTOM_FINAL_TOKEN,
      parentMarker: ISOLATED_CUSTOM_PARENT_MARKER,
      shouldInjectAgentsMd: false,
      subagentType: ISOLATED_CUSTOM_AGENT_NAME,
    });

    await assertCompleteSubagentInstructionTrajectory();
  });
  it("I21: MCS 首发 listing 与工具后去重应走通用 attachment", async function () {
    this.timeout(120000);
    await seedSubagentInstructionFixtures();
    await prepareIncomingMessageCapability(true);
    const modelId = "claude-opus-4-8";
    await runSubagentPromptAssemblyScenario({
      mcs: true,
      modelId,
      agentPromptIncludes: [
        "You are an agent for ZCode CLI",
        "the caller will relay this to the user",
      ],
      agentPromptExcludes: [CUSTOM_AGENT_PROMPT_MARKER],
      childMarker: BUILTIN_CHILD_MARKER,
      childReplyToken: BUILTIN_CHILD_REPLY_TOKEN,
      finalToken: BUILTIN_FINAL_TOKEN,
      parentMarker: BUILTIN_PARENT_MARKER,
      shouldInjectAgentsMd: true,
      subagentType: "general-purpose",
    });
    const artifact = await readCaptureArtifact();
    expect(artifact).not.toBeNull();
    assertSubagentListingTrajectory(
      {
        ...artifact!,
        records: artifact!.records.filter(
          (record) => readModelFromCapture(record.requestJson) === modelId,
        ),
      },
      { parentMarker: BUILTIN_PARENT_MARKER, childMarker: BUILTIN_CHILD_MARKER },
      [CUSTOM_AGENT_NAME, ISOLATED_CUSTOM_AGENT_NAME],
      true,
    );
  });
});

async function seedSubagentInstructionFixtures() {
  const files = [
    ...CUSTOM_AGENT_PATHS.map((path) => ({ content: CUSTOM_AGENT_PROFILE, path })),
    ...ISOLATED_CUSTOM_AGENT_PATHS.map((path) => ({
      content: ISOLATED_CUSTOM_AGENT_PROFILE,
      path,
    })),
    { content: `${USER_AGENTS_MARKER}\n`, path: USER_AGENTS_PATH },
    { content: `${WORKSPACE_AGENTS_MARKER}\n`, path: WORKSPACE_AGENTS_PATH },
  ];
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf-8");
  }
}

async function removeSubagentInstructionFixtures() {
  await Promise.all(
    [
      ...CUSTOM_AGENT_PATHS,
      ...ISOLATED_CUSTOM_AGENT_PATHS,
      USER_AGENTS_PATH,
      WORKSPACE_AGENTS_PATH,
    ].map((path) => rm(path, { force: true })),
  );
}

async function runSubagentPromptAssemblyScenario(input: {
  mcs?: boolean;
  modelId?: string;
  agentPromptExcludes: string[];
  agentPromptIncludes: string[];
  childMarker: string;
  childReplyToken: string;
  finalToken: string;
  parentMarker: string;
  shouldInjectAgentsMd: boolean;
  subagentType: string;
}) {
  const marker = `${input.parentMarker}_${Date.now()}`;
  const prompt =
    `${marker}: Use the Agent tool with subagent_type "${input.subagentType}". ` +
    `Ask it to reply with exactly "${input.childReplyToken}". ` +
    `After the subagent returns, reply with exactly "${input.finalToken}" and no other text.`;

  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${input.subagentType} 首发后输入框没有清空`);
  await waitForV4UserMessageContaining(marker);

  const childRecord = await waitForChildSubagentRequestCapture({
    childMarker: input.childMarker,
    parentMarker: input.parentMarker,
    modelId: input.modelId ?? UPSTREAM_MODEL,
  });
  expect(readModelFromCapture(childRecord.requestJson)).toBe(input.modelId ?? UPSTREAM_MODEL);
  assertChildSystemPromptShape(childRecord.requestJson, {
    agentPromptExcludes: input.agentPromptExcludes,
    agentPromptIncludes: input.agentPromptIncludes,
  });
  assertChildUserInstructions(childRecord.requestJson, {
    childMarker: input.childMarker,
    mcs: input.mcs ?? false,
    shouldInject: input.shouldInjectAgentsMd,
  });

  await waitForV4AssistantMessageContaining(input.finalToken);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${input.subagentType} prompt assembly case 完成后没有回到 idle`,
    90000,
  );

  const agentBlock = await waitForToolCallBlockByToolName("Agent");
  expect(agentBlock.status).toBe("completed");
  await assertVisibleV4UserMessagesNotContaining("Available agent types for the Agent tool:");
}

async function waitForChildSubagentRequestCapture(input: {
  modelId: string;
  childMarker: string;
  parentMarker: string;
}) {
  let latestArtifact: E2ENetworkCaptureArtifact | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestArtifact = await readCaptureArtifact();
        return Boolean(findChildSubagentRequest(latestArtifact, input));
      },
      {
        timeout: 30000,
        timeoutMsg: `没有捕获到 subagent prompt assembly child 请求: ${input.childMarker}`,
      },
    );
  } catch (error) {
    throw new Error(
      `没有捕获到 subagent prompt assembly child 请求\n${JSON.stringify(
        summarizeRequestsContaining(latestArtifact, input.childMarker),
        null,
        2,
      )}`,
      { cause: error },
    );
  }

  const record = findChildSubagentRequest(latestArtifact, input);
  if (!record) {
    throw new Error("subagent prompt assembly child 请求在等待完成后仍不存在");
  }
  return record;
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureArtifact | null> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    return null;
  }
  try {
    return JSON.parse(await readFile(capturePath, "utf-8")) as E2ENetworkCaptureArtifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function findChildSubagentRequest(
  artifact: E2ENetworkCaptureArtifact | null,
  input: { childMarker: string; parentMarker: string; modelId: string },
) {
  return (
    artifact?.records.find(
      (record) =>
        isUpstreamMessageRequest(record) &&
        record.status === "complete" &&
        captureContainsText(record.requestJson, input.childMarker) &&
        !captureContainsText(record.requestJson, input.parentMarker) &&
        readModelFromCapture(record.requestJson) === input.modelId,
    ) ?? null
  );
}

function assertChildSystemPromptShape(
  requestJson: unknown,
  input: { agentPromptExcludes: string[]; agentPromptIncludes: string[] },
) {
  const systems = readSystemMessagesFromCapture(requestJson);
  expect(systems).toHaveLength(2);
  expect(readSystemCacheControlsFromCapture(requestJson)).toEqual([
    { type: "ephemeral" },
    { type: "ephemeral" },
  ]);
  expect(systems[0]).toBe("You are ZCode, an interactive agent");
  for (const expected of input.agentPromptIncludes) {
    expect(systems[1]).toContain(expected);
  }
  for (const forbidden of input.agentPromptExcludes) {
    expect(systems[1]).not.toContain(forbidden);
  }
  expect(systems[1]).toContain(LAUNCHER_MESSAGES_NOTE);
  expect(systems[1]).toContain("\n\nNotes:");
  expect(systems[1]!.indexOf(LAUNCHER_MESSAGES_NOTE)).toBeLessThan(
    systems[1]!.indexOf("\n\nNotes:"),
  );
  expect(systems[1]).toContain("the parent agent reads your text output");
  // 环境和执行模型走 child 自己的公告历史，不放进初始 system（见 07-subagent.md）。
  expect(systems[1]).not.toContain("# Environment");
  expect(systems[1]).not.toContain("Here is useful information about the environment");
  expect(systems[1]).not.toContain(MODEL_ANNOUNCEMENT);
}

function assertChildUserInstructions(
  requestJson: unknown,
  input: { childMarker: string; mcs: boolean; shouldInject: boolean },
) {
  const systems = readSystemMessagesFromCapture(requestJson).join("\n");
  // Bug 根因：provider projection 会把 context_prefix 与真实任务编码为同一条 user
  // message 的相邻 text blocks；按 message 聚合文本会把两者误判为同一位置。
  const messageBlocks = readMessageTextBlocksFromCapture(requestJson);
  const findBlock = (text: string) => messageBlocks.findIndex((block) => block.text.includes(text));
  const taskIndex = messageBlocks.findIndex(
    (block) => block.role === "user" && block.text.includes(input.childMarker),
  );
  const environmentIndex = findBlock(ENVIRONMENT_ANNOUNCEMENT);
  const modelIndex = findBlock(MODEL_ANNOUNCEMENT);
  const dateIndex = findBlock(DATE_ANNOUNCEMENT);
  const contextIndex = findBlock(INSTRUCTIONS_PREAMBLE);
  expect(taskIndex).toBeGreaterThanOrEqual(0);
  expect(environmentIndex).toBeGreaterThanOrEqual(0);
  expect(modelIndex).toBeGreaterThanOrEqual(0);
  expect(dateIndex).toBeGreaterThanOrEqual(0);
  if (input.mcs) {
    // MCS 开：环境、模型、技能和日期合成一条 system 消息，排在 child 任务之后。
    expect(messageBlocks[environmentIndex]?.role).toBe("system");
    expect(environmentIndex).toBeGreaterThan(taskIndex);
    expect(modelIndex).toBe(environmentIndex);
    expect(dateIndex).toBe(environmentIndex);
  } else {
    // MCS 关：每条公告是 child 任务之前的一个 user reminder 块，日期紧挨任务。
    for (const index of [environmentIndex, modelIndex, dateIndex]) {
      expect(messageBlocks[index]?.role).toBe("user");
      expect(messageBlocks[index]?.text).toContain("<system-reminder>");
    }
    expect(environmentIndex).toBeLessThan(modelIndex);
    expect(modelIndex).toBeLessThan(dateIndex);
    expect(dateIndex).toBe(taskIndex - 1);
  }
  // child 任务的位置等同 Main 的真实用户 prompt：前面紧挨的 user 文本以换行结尾。
  if (taskIndex > 0) {
    expect(messageBlocks[taskIndex - 1]?.role).toBe("user");
    expect(messageBlocks[taskIndex - 1]?.text.endsWith("\n")).toBe(true);
  }
  expect(systems).not.toContain(INSTRUCTIONS_PREAMBLE);
  expect(systems).not.toContain(USER_AGENTS_MARKER);
  expect(systems).not.toContain(WORKSPACE_AGENTS_MARKER);
  expect(countCaptureOccurrences(requestJson, "# agentsMd")).toBe(0);
  expect(countCaptureOccurrences(requestJson, "# claudeMd")).toBe(0);

  if (!input.shouldInject) {
    expect(contextIndex).toBe(-1);
    expect(countCaptureOccurrences(requestJson, USER_AGENTS_MARKER)).toBe(0);
    expect(countCaptureOccurrences(requestJson, WORKSPACE_AGENTS_MARKER)).toBe(0);
    return;
  }

  // 指令段复用 Main 的 formatter：一个 user reminder 块，在日期和任务之前。
  const contextText = messageBlocks[contextIndex]?.text ?? "";
  expect(messageBlocks[contextIndex]?.role).toBe("user");
  expect(contextText).toContain("<system-reminder>");
  expect(contextIndex).toBeLessThan(taskIndex);
  if (!input.mcs) {
    expect(modelIndex).toBeLessThan(contextIndex);
    expect(contextIndex).toBeLessThan(dateIndex);
  }
  expect(countCaptureOccurrences(requestJson, USER_AGENTS_MARKER)).toBe(1);
  expect(countCaptureOccurrences(requestJson, WORKSPACE_AGENTS_MARKER)).toBe(1);
  expect(contextText.indexOf(INSTRUCTIONS_PREAMBLE)).toBeLessThan(
    contextText.indexOf(USER_AGENTS_MARKER),
  );
  expect(contextText.indexOf(USER_AGENTS_MARKER)).toBeLessThan(
    contextText.indexOf(WORKSPACE_AGENTS_MARKER),
  );
  expect(contextText).not.toContain(DATE_ANNOUNCEMENT);
}

async function assertCompleteSubagentInstructionTrajectory() {
  const captured = await readCaptureArtifact();
  const artifact = captured && {
    ...captured,
    records: captured.records.filter(
      (record) => readModelFromCapture(record.requestJson) === UPSTREAM_MODEL,
    ),
  };
  expect(artifact).not.toBeNull();
  const scenarios = [
    { childMarker: BUILTIN_CHILD_MARKER, parentMarker: BUILTIN_PARENT_MARKER },
    { childMarker: EXPLORE_CHILD_MARKER, parentMarker: EXPLORE_PARENT_MARKER },
    { childMarker: CUSTOM_CHILD_MARKER, parentMarker: CUSTOM_PARENT_MARKER },
    {
      childMarker: ISOLATED_CUSTOM_CHILD_MARKER,
      parentMarker: ISOLATED_CUSTOM_PARENT_MARKER,
    },
  ];

  for (const scenario of scenarios) {
    assertSubagentListingTrajectory(
      artifact!,
      scenario,
      [CUSTOM_AGENT_NAME, ISOLATED_CUSTOM_AGENT_NAME],
      false,
    );
    const matches =
      artifact?.records.filter(
        (record) =>
          isUpstreamMessageRequest(record) &&
          record.status === "complete" &&
          captureContainsText(record.requestJson, scenario.childMarker) &&
          !captureContainsText(record.requestJson, scenario.parentMarker),
      ) ?? [];
    expect(matches).toHaveLength(1);
  }
}

function readMessageTextBlocksFromCapture(value: unknown): Array<{ role: string; text: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return [];
    }
    const role = (message as { role?: unknown }).role;
    if (typeof role !== "string") {
      return [];
    }
    return readSystemContent((message as { content?: unknown }).content).map((text) => ({
      role,
      text,
    }));
  });
}

function readSystemMessagesFromCapture(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  // Anthropic Messages API 的 provider-visible system 在顶层 system 字段。
  const topLevelSystem = readSystemContent((value as { system?: unknown }).system);
  if (topLevelSystem.length > 0) {
    return topLevelSystem;
  }

  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return [];
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "system") {
      return [];
    }
    const content = (message as { content?: unknown }).content;
    return readSystemContent(content);
  });
}

function readSystemContent(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (typeof part === "string") {
      return [part];
    }
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return [];
    }
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
}

function readSystemCacheControlsFromCapture(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const topLevelSystem = readSystemCacheControls((value as { system?: unknown }).system);
  if (topLevelSystem.length > 0) {
    return topLevelSystem;
  }

  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return [];
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "system") {
      return [];
    }
    const messageRecord = message as Record<string, unknown>;
    const contentControls = readSystemCacheControls(messageRecord.content);
    if (contentControls.length > 0) {
      return contentControls;
    }
    return [readCacheControl(messageRecord)];
  });
}

function readSystemCacheControls(content: unknown): unknown[] {
  if (typeof content === "string") {
    return [undefined];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (typeof part === "string") {
      return [undefined];
    }
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return [];
    }
    const partRecord = part as Record<string, unknown>;
    const text = partRecord.text;
    return typeof text === "string" ? [readCacheControl(partRecord)] : [];
  });
}

function readCacheControl(record: Record<string, unknown>): unknown {
  return record.cache_control ?? record.cacheControl;
}

function summarizeRequestsContaining(
  artifact: E2ENetworkCaptureArtifact | null,
  expectedText: string,
) {
  return {
    records:
      artifact?.records
        .filter((record) => captureContainsText(record.requestJson, expectedText))
        .map((record) => ({
          model: readModelFromCapture(record.requestJson),
          path: record.path,
          status: record.status,
          statusCode: record.statusCode,
          systems: readSystemMessagesFromCapture(record.requestJson).length,
        })) ?? [],
  };
}

function isUpstreamMessageRequest(record: E2ENetworkCaptureRecord) {
  return (
    record.method === "POST" &&
    (record.path.includes("/messages") || record.path.includes("/chat/completions"))
  );
}

function readModelFromCapture(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => captureContainsText(child, expected));
}

function countCaptureOccurrences(value: unknown, marker: string): number {
  if (typeof value === "string") {
    return value.split(marker).length - 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countCaptureOccurrences(item, marker), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  return Object.values(value).reduce(
    (total, item) => total + countCaptureOccurrences(item, marker),
    0,
  );
}
