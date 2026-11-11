import {
  INCOMING_MESSAGE_MODES,
  prepareIncomingMessageCapability,
} from "#e2e/helpers/incoming-message-capability";
import {
  readBackgroundContextUsage,
  assertBackgroundUsageInV4,
} from "#e2e/helpers/background-notification-usage";
import { assertIncomingMessage } from "#e2e/helpers/incoming-message-evidence";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_CHAT_BACKGROUND_RESULT_TITLE, TID_V4_TIMELINE } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  countUpstreamRequests,
  findFirstUpstreamRequestIndex,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import { respondToToolCrossProductBlockers } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4QueueCount,
} from "#e2e/helpers/v4-conversation";

const BACKGROUND_NOTIFICATION_BATCH_TIMEOUT_MS = 180000;
const CASE_MARKER = "E2E_BACKGROUND_NOTIFICATION_BATCH";
const CHILD_ONE_RESULT = "E2E_BG_BATCH_CHILD_ONE_DONE";
const CHILD_TWO_RESULT = "E2E_BG_BATCH_CHILD_TWO_DONE";
const CHILD_THREE_RESULT = "E2E_BG_BATCH_CHILD_THREE_DONE";
const BACKGROUND_AGENT_LAUNCHES = [
  {
    promptMarker: "E2E_BG_BATCH_CHILD_ONE",
    toolCallId: "toolu_e2e_bg_batch_agent_one",
  },
  {
    promptMarker: "E2E_BG_BATCH_CHILD_TWO",
    toolCallId: "toolu_e2e_bg_batch_agent_two",
  },
  {
    promptMarker: "E2E_BG_BATCH_CHILD_THREE",
    toolCallId: "toolu_e2e_bg_batch_agent_three",
  },
] as const;

describe("会话区 Background Notification Batch E2E", () => {
  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const { label, mcs } of INCOMING_MESSAGE_MODES) {
    it(`BG36 ${label}: 第一条 notification request 处理中完成的其余 Agent 应在下一次 available drain 合为一轮`, async function () {
      this.timeout(BACKGROUND_NOTIFICATION_BATCH_TIMEOUT_MS);

      await prepareIncomingMessageCapability(mcs);
      const runMarker = `${CASE_MARKER}_${Date.now()}`;
      const firstExistingRecordIndex = (await getUpstreamRequestRecordCount()) - 1;

      await sendV4Prompt(
        `${runMarker}: Launch exactly three background Agents and process every completion notification.`,
      );
      await waitForVisibleV4MessageContaining("user", runMarker);
      for (const { toolCallId } of BACKGROUND_AGENT_LAUNCHES) {
        await waitForToolCallBlockByToolCallId(toolCallId, 60000);
      }
      await respondToToolCrossProductBlockers();
      await waitForVisibleV4MessageContaining(
        "assistant",
        "background-notification-batch-agents-launched-ok",
      );

      const firstNotificationQuery = {
        includes: [CASE_MARKER, "<task-notification>", CHILD_ONE_RESULT],
        lastUserMessageExcludes: [CHILD_TWO_RESULT, CHILD_THREE_RESULT],
        lastUserMessageIncludes: ["<task-notification>", CHILD_ONE_RESULT],
      };
      const launchAckRequestIndex = await waitForRequestIndex(
        {
          includes: [
            CASE_MARKER,
            "Async agent launched successfully",
            ...BACKGROUND_AGENT_LAUNCHES.map(({ toolCallId }) => toolCallId),
          ],
          lastUserMessageExcludes: ["<task-notification>"],
        },
        firstExistingRecordIndex,
        "BG36 没有捕获到三个 background Agent 的 launch ack request",
      );
      await assertBackgroundAgentLaunches(launchAckRequestIndex);
      await waitForChildAgentRequests(firstExistingRecordIndex);
      await waitForBackgroundOnlyMainIdle();
      const launchUsage = await readBackgroundContextUsage();
      expect(
        await findFirstUpstreamRequestIndex(firstNotificationQuery, {
          afterIndex: firstExistingRecordIndex,
        }),
      ).toBeNull();

      const firstNotificationIndex = await waitForRequestIndex(
        firstNotificationQuery,
        firstExistingRecordIndex,
        "BG36 第一条 Agent completion notification 没有独立启动 provider request",
      );
      const batchNotificationIndex = await waitForRequestIndex(
        {
          includes: [CASE_MARKER, "<task-notification>", CHILD_TWO_RESULT, CHILD_THREE_RESULT],
          lastUserMessageIncludes: ["<task-notification>", CHILD_TWO_RESULT, CHILD_THREE_RESULT],
        },
        firstNotificationIndex,
        "BG36 第二、三条 completion notification 没有在同一 provider request 中消费",
      );

      await assertIncomingMessage(await readRequestJsonAt(firstNotificationIndex), {
        presentation: "task_notification",
        evidenceLabel: label,
        marker: CHILD_ONE_RESULT,
        role: "user",
      });
      await assertIncomingMessage(await readRequestJsonAt(batchNotificationIndex), {
        presentation: "task_notification",
        evidenceLabel: label,
        marker: CHILD_TWO_RESULT,
        role: "user",
      });
      const batchInput = await readLatestUserMessageAt(batchNotificationIndex);
      // 每条通知各自一个标题：两条通知共三段。
      expect(batchInput.split("[SYSTEM NOTIFICATION - NOT USER INPUT]")).toHaveLength(3);
      // 两条通知是同一条 user 消息的两个 text block。
      const batchBlocks = await readLatestUserTextBlocksAt(batchNotificationIndex);
      expect(batchBlocks).toHaveLength(2);
      expect(batchInput.indexOf(CHILD_TWO_RESULT)).toBeGreaterThanOrEqual(0);
      expect(batchInput.indexOf(CHILD_THREE_RESULT)).toBeGreaterThan(
        batchInput.indexOf(CHILD_TWO_RESULT),
      );

      await waitForVisibleV4MessageContaining(
        "assistant",
        "background-notification-batch-consumed-ok",
      );
      await waitForBackgroundResultTitle(
        "BG36 second background Agent · BG36 third background Agent",
      );
      await waitForV4Pane(
        (snapshot) =>
          snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
        "BG36 notification batch 完成后 V4 main 没有回到 idle",
        90000,
      );
      await waitForV4QueueCount(0, 30000);
      const batchUsage = await readBackgroundContextUsage();
      const firstNotificationInput = await readLatestUserMessageAt(firstNotificationIndex);
      // 根因：通知加 wrapper 后曾被 Messages 当成已计入 sections 的上下文跳过。
      // 两次请求之间只新增两个 assistant 和两条通知，直接对账 CLI 实际统计的字符增量。
      // 修复原因：assistant 回复改为按块保存后，content 是带块序号的文本块数组；Messages
      // 按历史里保存的形态估算，块序号不发给 provider，但计入估算，旧的字符串期望因此少算。
      const assistantBlocks = (text: string) => [{ type: "text", text, blockIndex: 0 }];
      const addedMessages = [
        {
          role: "assistant",
          content: assistantBlocks("background-notification-batch-agents-launched-ok"),
        },
        { role: "user", content: firstNotificationInput },
        {
          role: "assistant",
          content: assistantBlocks("background-notification-batch-first-consumed-ok"),
        },
        // 通知按历史形态估算：单条是字符串，整批是 text block 数组。
        { role: "user", content: batchBlocks },
      ];
      const expectedIncrease = addedMessages.reduce(
        (sum, message) => sum + JSON.stringify(message).length,
        0,
      );
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, `task-notification-usage-${label}.json`),
          JSON.stringify({ launchUsage, batchUsage, expectedIncrease }, null, 2),
          "utf8",
        );
      }
      expect(
        batchUsage.find((item) => item.source === "messages")!.chars -
          launchUsage.find((item) => item.source === "messages")!.chars,
      ).toBe(expectedIncrease);
      expect(batchUsage.filter((item) => item.source !== "messages")).toEqual(
        launchUsage.filter((item) => item.source !== "messages"),
      );
      await assertBackgroundUsageInV4(batchUsage);
      await browser.pause(1000);

      expect(
        await countUpstreamRequests(
          {
            excludes: ["CRITICAL: Respond with TEXT ONLY"],
            lastUserMessageIncludes: ["<task-notification>"],
          },
          { afterIndex: firstExistingRecordIndex },
        ),
      ).toBe(2);
      expect(
        await countUpstreamRequests(
          {
            lastUserMessageExcludes: [CHILD_THREE_RESULT],
            lastUserMessageIncludes: [CHILD_TWO_RESULT],
          },
          { afterIndex: firstNotificationIndex },
        ),
      ).toBe(0);
      expect(
        await countUpstreamRequests(
          {
            lastUserMessageExcludes: [CHILD_TWO_RESULT],
            lastUserMessageIncludes: [CHILD_THREE_RESULT],
          },
          { afterIndex: firstNotificationIndex },
        ),
      ).toBe(0);
      await assertVisibleV4UserRowsNotContaining("<task-notification>");
      await assertVisibleV4UserRowsNotContaining("<system-reminder>");
      await assertVisibleV4UserRowsNotContaining("[SYSTEM NOTIFICATION - NOT USER INPUT]");
      await assertVisibleV4UserRowsNotContaining(CHILD_ONE_RESULT);
      await assertVisibleV4UserRowsNotContaining(CHILD_TWO_RESULT);
      await assertVisibleV4UserRowsNotContaining(CHILD_THREE_RESULT);
    });
  }
});

async function waitForRequestIndex(
  query: Parameters<typeof waitForUpstreamRequest>[0],
  afterIndex: number,
  timeoutMsg: string,
) {
  await waitForUpstreamRequest(query, timeoutMsg, 60000, { afterIndex });
  const index = await findFirstUpstreamRequestIndex(query, { afterIndex });
  if (index === null) {
    throw new Error(`${timeoutMsg}; request disappeared after wait`);
  }
  return index;
}

async function readLatestUserMessageAt(recordIndex: number): Promise<string> {
  const requestJson = await readRequestJsonAt(recordIndex);
  const messages =
    requestJson && typeof requestJson === "object"
      ? (requestJson as { messages?: unknown }).messages
      : undefined;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    return contentToText((message as { content?: unknown }).content);
  }
  return "";
}

async function readLatestUserTextBlocksAt(
  recordIndex: number,
): Promise<Array<{ type: "text"; text: string }>> {
  const requestJson = await readRequestJsonAt(recordIndex);
  const messages =
    requestJson && typeof requestJson === "object"
      ? (requestJson as { messages?: unknown }).messages
      : undefined;
  if (!Array.isArray(messages)) return [];
  const message = [...messages]
    .reverse()
    .find(
      (item) => !!item && typeof item === "object" && (item as { role?: unknown }).role === "user",
    ) as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return [];
  // wire 上的 cache_control 等字段不属于 CLI 的消息内容，只保留 type 与 text。
  return message.content.flatMap((block: unknown) =>
    block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [{ type: "text" as const, text: (block as { text: string }).text }]
      : [],
  );
}

async function readRequestJsonAt(recordIndex: number): Promise<unknown> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    throw new Error("BG36 缺少 E2E_PROVIDER_CAPTURE_PATH，无法验证 batch admission 顺序");
  }
  const artifact = JSON.parse(await readFile(capturePath, "utf-8")) as {
    records?: Array<{ requestJson?: unknown }>;
  };
  return artifact.records?.[recordIndex]?.requestJson;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentToText).join("\n");
  if (!content || typeof content !== "object") return "";
  if ("text" in content && typeof content.text === "string") return content.text;
  return Object.values(content).map(contentToText).join("\n");
}

async function stopIfBusy() {
  const snapshot = await getV4PaneSnapshot().catch(() => null);
  if (!snapshot?.canStop) return;
  await clickV4Stop().catch(() => undefined);
  await waitForV4Pane(
    (candidate) => !candidate.canStop,
    "BG36 清理阶段 V4 main 没有退出 running",
    30000,
  ).catch(() => undefined);
}

async function waitForBackgroundOnlyMainIdle(): Promise<void> {
  await waitForV4Pane(
    (snapshot) =>
      snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
    "BG36 background Agent launch 后 V4 main 没有先回到 idle",
    45000,
  );

  // Bug 原因：旧 case 只在全部 notification 消费后读取 legacy runtime store，
  // 即使 background-only 窗口的 V4 Composer 从未 idle 也会通过。这里保留一个稳定采样窗口，
  // 锁定真实产品面的 canStop=false；Agent 是否真实后台运行已由 provider-visible
  // run_in_background tool input 和三个尚未完成的 child request 直接证明，不能依赖异步目录计数。
  await browser.pause(500);
  const stablePane = await getV4PaneSnapshot();
  expect(stablePane.canStop).toBe(false);
}

async function waitForChildAgentRequests(afterIndex: number): Promise<void> {
  for (const { promptMarker } of BACKGROUND_AGENT_LAUNCHES) {
    await waitForRequestIndex(
      {
        lastUserMessageExcludes: [CASE_MARKER],
        lastUserMessageIncludes: [promptMarker],
      },
      afterIndex,
      `BG36 child provider request 没有开始：${promptMarker}`,
    );
  }
}

async function assertBackgroundAgentLaunches(recordIndex: number): Promise<void> {
  const requestJson = await readRequestJsonAt(recordIndex);
  for (const { promptMarker, toolCallId } of BACKGROUND_AGENT_LAUNCHES) {
    const toolUse = findToolUse(requestJson, toolCallId);
    expect(toolUse?.name).toBe("Agent");
    expect(toolUse?.input?.prompt).toContain(promptMarker);
    expect(toolUse?.input?.run_in_background).toBe(true);
  }
}

function findToolUse(
  value: unknown,
  toolCallId: string,
): { input?: Record<string, unknown>; name?: unknown } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const matched = findToolUse(item, toolCallId);
      if (matched) return matched;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.id === toolCallId && candidate.type === "tool_use") {
    const input =
      candidate.input && typeof candidate.input === "object"
        ? (candidate.input as Record<string, unknown>)
        : null;
    return {
      ...(input ? { input } : {}),
      name: candidate.name,
    };
  }
  for (const child of Object.values(candidate)) {
    const matched = findToolUse(child, toolCallId);
    if (matched) return matched;
  }
  return null;
}

async function waitForBackgroundResultTitle(expectedTitle: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (titleTestId, title) =>
          Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${titleTestId}-"]`),
          ).some((node) => node.textContent?.trim() === title),
        TID_CHAT_BACKGROUND_RESULT_TITLE,
        expectedTitle,
      ),
    {
      timeout: 60000,
      timeoutMsg: `BG36 没有显示合成后的后台结果标题：${expectedTitle}`,
    },
  );
}

async function waitForVisibleV4MessageContaining(
  role: "assistant" | "user",
  text: string,
): Promise<void> {
  await browser.waitUntil(
    async () => (await getVisibleV4MessageTexts(role)).some((message) => message.includes(text)),
    {
      timeout: 90000,
      timeoutMsg: `BG36 ${role} 消息中没有出现：${text}`,
    },
  );
}

async function assertVisibleV4UserRowsNotContaining(text: string): Promise<void> {
  expect((await getVisibleV4MessageTexts("user")).join("\n")).not.toContain(text);
}

function getVisibleV4MessageTexts(role: "assistant" | "user"): Promise<string[]> {
  return browser.execute(
    (timelineTestId, selectedRole) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
        .filter((element) => element.classList.contains(`group/${selectedRole}-row`))
        .map((element) => element.innerText.replace(/\u00a0/g, " ").trim());
    },
    TID_V4_TIMELINE,
    role,
  );
}
