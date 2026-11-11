import { readFile } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { assertUpstreamRequestCapture } from "#e2e/helpers/upstream-capture";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import { UPSTREAM_ALTERNATE_MODEL, UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";

const SUBAGENT_NAME = "e2e-provider-registry-reviewer";
const PARENT_MARKER = "E2E_SUBAGENT_PROVIDER_REGISTRY_PARENT";
const CHILD_MARKER = "E2E_SUBAGENT_PROVIDER_REGISTRY_CHILD";
const CHILD_REPLY_TOKEN = "E2E_SUBAGENT_PROVIDER_REGISTRY_CHILD_OK";

describe("会话区 subagent provider registry 冷启动 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I19: 冷启动时 subagent 绑定 alternate provider 也应能首轮执行", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const marker = `${PARENT_MARKER}_${Date.now()}`;
    const prompt =
      `${marker}: Use the Agent tool with subagent_type "${SUBAGENT_NAME}". ` +
      `Ask it to reply with exactly "${CHILD_REPLY_TOKEN}". ` +
      `After the subagent returns, reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "subagent provider registry 冷启动首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    const childRecord = await waitForChildSubagentRequestCapture();
    expect(readModelFromCapture(childRecord.requestJson)).toBe(UPSTREAM_ALTERNATE_MODEL);

    const parentContinuationRecord = await waitForParentContinuationRequestCapture();
    assertUpstreamRequestCapture(parentContinuationRecord, {
      expectedText: CHILD_REPLY_TOKEN,
      model: UPSTREAM_MODEL,
    });

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "subagent provider registry 冷启动完成后没有回到 idle",
      90000,
    );

    const agentBlock = await waitForToolCallBlockByToolName("Agent");
    expect(agentBlock.status).toBe("completed");
  });
});

async function waitForChildSubagentRequestCapture() {
  let latestArtifact: E2ENetworkCaptureArtifact | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestArtifact = await readCaptureArtifact();
        return Boolean(findChildSubagentRequest(latestArtifact));
      },
      {
        timeout: 30000,
        timeoutMsg: "没有捕获到 alternate provider 的 child subagent 请求",
      },
    );
  } catch (error) {
    throw new Error(
      `没有捕获到 alternate provider 的 child subagent 请求\n${JSON.stringify(
        summarizeChildRequestCandidates(latestArtifact),
        null,
        2,
      )}`,
      { cause: error },
    );
  }

  const record = findChildSubagentRequest(latestArtifact);
  if (!record) {
    throw new Error("child subagent 请求在等待完成后仍不存在");
  }
  return record;
}

async function waitForParentContinuationRequestCapture() {
  let latestArtifact: E2ENetworkCaptureArtifact | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latestArtifact = await readCaptureArtifact();
        return Boolean(findParentContinuationRequest(latestArtifact));
      },
      {
        timeout: 30000,
        timeoutMsg: "没有捕获到 primary provider 的 parent continuation 请求",
      },
    );
  } catch (error) {
    throw new Error(
      `没有捕获到 primary provider 的 parent continuation 请求\n${JSON.stringify(
        summarizeParentContinuationCandidates(latestArtifact),
        null,
        2,
      )}`,
      { cause: error },
    );
  }

  const record = findParentContinuationRequest(latestArtifact);
  if (!record) {
    throw new Error("parent continuation 请求在等待完成后仍不存在");
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

function findChildSubagentRequest(artifact: E2ENetworkCaptureArtifact | null) {
  return (
    artifact?.records.find(
      (record) =>
        record.method === "POST" &&
        (record.path.includes("/messages") || record.path.includes("/chat/completions")) &&
        record.status === "complete" &&
        captureContainsText(record.requestJson, CHILD_MARKER) &&
        readModelFromCapture(record.requestJson) === UPSTREAM_ALTERNATE_MODEL,
    ) ?? null
  );
}

function findParentContinuationRequest(artifact: E2ENetworkCaptureArtifact | null) {
  return (
    artifact?.records.findLast(
      (record) =>
        isUpstreamMessageRequest(record) &&
        record.status === "complete" &&
        captureContainsText(record.requestJson, CHILD_REPLY_TOKEN) &&
        readModelFromCapture(record.requestJson) === UPSTREAM_MODEL,
    ) ?? null
  );
}

function summarizeChildRequestCandidates(artifact: E2ENetworkCaptureArtifact | null) {
  return {
    records:
      artifact?.records
        .filter((record) => captureContainsText(record.requestJson, CHILD_MARKER))
        .map((record) => ({
          model: readModelFromCapture(record.requestJson),
          path: record.path,
          status: record.status,
          statusCode: record.statusCode,
        })) ?? [],
  };
}

function summarizeParentContinuationCandidates(artifact: E2ENetworkCaptureArtifact | null) {
  return {
    records:
      artifact?.records
        .filter((record) => captureContainsText(record.requestJson, CHILD_REPLY_TOKEN))
        .map((record) => ({
          model: readModelFromCapture(record.requestJson),
          path: record.path,
          status: record.status,
          statusCode: record.statusCode,
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
