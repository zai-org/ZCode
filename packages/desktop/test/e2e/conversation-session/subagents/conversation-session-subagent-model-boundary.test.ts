import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestToolNames,
} from "#e2e/helpers/conversation-session-network";
import { readFile } from "node:fs/promises";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  restartIntoWorkspacePreservingProfile,
  seedReplayProvider,
} from "#e2e/helpers/model-provider-restart";
import { sel } from "#e2e/helpers/selectors";
import { openComposerProviderList } from "#e2e/helpers/upstream-provider";

const START_PROVIDER_ID = "e2e-start-subagent-boundary";
const START_MODEL_ID = "start-subagent-boundary-model";
const CODING_PROVIDER_ID = "e2e-coding-subagent-boundary";
const CODING_MODEL_ID = "coding-subagent-boundary-model";

const BOUNDARY_PARENT = "E2E_SUBAGENT_MODEL_BOUNDARY_PARENT";
const BOUNDARY_CHILD = "E2E_SUBAGENT_MODEL_BOUNDARY_CHILD";
const BOUNDARY_PARENT_DONE = "E2E_SUBAGENT_MODEL_BOUNDARY_PARENT_DONE";
const BOUNDARY_NEXT_INPUT = "E2E_SUBAGENT_MODEL_BOUNDARY_NEXT_INPUT";
const NESTED_PARENT = "E2E_SUBAGENT_NESTED_PARENT";
const NESTED_CHILD = "E2E_SUBAGENT_NESTED_CHILD";
const NESTED_GRANDCHILD = "E2E_SUBAGENT_NESTED_GRANDCHILD";
const NESTED_CHILD_DONE = "E2E_SUBAGENT_NESTED_CHILD_DONE";
const NESTED_PARENT_DONE = "E2E_SUBAGENT_NESTED_PARENT_DONE";

interface CaptureRecord {
  requestJson?: unknown;
  status?: string;
}

describe("Subagent 模型快照边界 E2E", () => {
  afterEach(async () => {
    try {
      const pane = await getV4PaneSnapshot();
      if (pane.canStop) {
        await clickTestIdByDom(TID_V4_STOP, { timeout: 3000 }).catch(() => undefined);
      }
    } catch {
      // 清理失败不覆盖原始断言。
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("F-SUBAGENT-013: child 在途期间保持创建时快照，父会话新输入采用新模型", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      // 本 case 的回放响应是 Messages 协议；默认 Chat Completions 种子会请求错误路由并返回夹具 500。
      apiFormat: "anthropic-messages",
      id: START_PROVIDER_ID,
      models: [START_MODEL_ID],
      name: "E2E Start Plan Subagent Boundary",
    });
    await seedReplayProvider({
      apiFormat: "anthropic-messages",
      id: CODING_PROVIDER_ID,
      models: [CODING_MODEL_ID],
      name: "E2E Coding Plan Subagent Boundary",
    });
    // 完整重启必须保留浏览器 profile；只恢复模型偏好会丢失 API Key 登录模式。
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectV4ModelOnly(START_PROVIDER_ID, START_MODEL_ID);

    const runId = Date.now();
    const parentMarker = `${BOUNDARY_PARENT}_${runId}`;
    await sendV4PromptAndWaitAccepted(
      `${parentMarker}: launch one general-purpose Agent for ${BOUNDARY_CHILD}; after it returns reply exactly ${BOUNDARY_PARENT_DONE}.`,
      parentMarker,
      "父会话没有接受 subagent boundary prompt",
    );
    await waitForV4TimelineContaining(parentMarker, 30000);
    await waitForToolCallBlockByToolName("Agent", 30000);

    // Agent tool 已出现在父 timeline 后，child runtime 已被创建；此时切换父 draft
    // 到 Coding Plan，不能改写 child 已捕获的 Start Plan execution snapshot。
    await selectV4ModelOnly(CODING_PROVIDER_ID, CODING_MODEL_ID);
    // 子响应由门闩维持在途状态；选择完成后释放，避免依赖固定 30 秒延时。
    await releaseControlledReplay("subagent-boundary-child-delayed");
    await waitForV4AssistantMessageContaining(BOUNDARY_PARENT_DONE, 120000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "subagent boundary case 完成后没有回到 idle",
      120000,
    );

    const child = await waitForCaptureRequest(BOUNDARY_CHILD, BOUNDARY_PARENT);
    expect(readModel(child.requestJson)).toBe(START_MODEL_ID);
    // 父 continuation 属于原输入；新选择只应以切换后明确提交的新输入验证。
    await sendV4PromptAndWaitAccepted(
      `${BOUNDARY_NEXT_INPUT}_${runId}: reply exactly E2E_SUBAGENT_NEXT_DONE`,
      BOUNDARY_NEXT_INPUT,
      "父会话没有接受切换后的新输入",
    );
    await waitForV4AssistantMessageContaining("E2E_SUBAGENT_NEXT_DONE", 30000);
    const nextInput = await waitForCaptureRequest(BOUNDARY_NEXT_INPUT);
    expect(readModel(nextInput.requestJson)).toBe(CODING_MODEL_ID);
  });

  it("F-SUBAGENT-018: 子 Agent 不暴露递归工具，拒绝递归调用且保留父子模型身份", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      apiFormat: "anthropic-messages",
      id: START_PROVIDER_ID,
      models: [START_MODEL_ID],
      name: "E2E Start Plan Nested Subagent",
    });
    // 完整重启必须保留浏览器 profile；只恢复模型偏好会丢失 API Key 登录模式。
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectV4ModelOnly(START_PROVIDER_ID, START_MODEL_ID);

    const runId = Date.now();
    const parentMarker = `${NESTED_PARENT}_${runId}`;
    await sendV4PromptAndWaitAccepted(
      `${parentMarker}: launch a child Agent for ${NESTED_CHILD}; after it returns reply exactly ${NESTED_PARENT_DONE}.`,
      parentMarker,
      "nested subagent 父会话没有接受 prompt",
    );
    await waitForV4AssistantMessageContaining(NESTED_PARENT_DONE, 120000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "nested subagent 完成后没有回到 idle",
      120000,
    );

    // 子请求中也会包含父提示里的 grandchild 标记，必须按父/子身份隔离后断言。
    const children = (await readCaptureRecords(NESTED_CHILD)).filter(
      (record) => !JSON.stringify(record.requestJson).includes(NESTED_PARENT),
    );
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const record of [...children, ...(await readCaptureRecords(parentMarker))]) {
      expect(readModel(record.requestJson)).toBe(START_MODEL_ID);
    }
    const tools = await getUpstreamRequestToolNames({
      includes: [NESTED_CHILD],
      excludes: [NESTED_PARENT],
    });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).not.toContain("Agent");
    expect(tools).not.toContain("Task");
    const rejection = await getLatestUpstreamToolResultByToolCallId(
      "toolu_e2e_subagent_nested_grandchild",
    );
    // 未注册的工具名给模型 `<tool_use_error>Error: No such tool available: …</tool_use_error>`。
    expect(rejection?.content).toContain("No such tool available: Agent");
    expect(rejection?.isError).toBe(true);
    const grandchildren = (await readCaptureRecords(NESTED_GRANDCHILD)).filter((record) => {
      const request = JSON.stringify(record.requestJson);
      return !request.includes(NESTED_PARENT) && !request.includes(NESTED_CHILD);
    });
    expect(grandchildren).toHaveLength(0);
    expect((await readCaptureRecords(NESTED_CHILD_DONE)).length).toBeGreaterThan(0);
  });
});

async function selectV4ModelOnly(provider: string, model: string): Promise<void> {
  const value = encodeCustomModelValue(provider, model);
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const item = $(sel(testId(TID_CHAT_MODEL_SELECT_ITEM, value)));
  const group = $(sel(testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${provider}`)));
  if (!(await item.isExisting())) {
    await openComposerProviderList();
    await group.waitForDisplayed({ timeout: 30000 });
    await group.click();
  }
  await item.waitForDisplayed({ timeout: 30000 });
  await item.click();
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value")) ===
      value,
    { timeout: 30000, timeoutMsg: `没有切换到 ${provider}/${model}` },
  );
}

async function waitForCaptureRequest(marker: string, excludes?: string): Promise<CaptureRecord> {
  let records: CaptureRecord[] = [];
  await browser.waitUntil(
    async () => {
      records = (await readCaptureRecords(marker)).filter(
        (record) => !excludes || !JSON.stringify(record.requestJson).includes(excludes),
      );
      return records.length > 0;
    },
    { timeout: 120000, interval: 500, timeoutMsg: `没有捕获到 subagent 请求 ${marker}` },
  );
  const record = records.at(-1);
  if (!record) throw new Error(`capture 中缺少 ${marker}`);
  return record;
}

async function readCaptureRecords(marker: string): Promise<CaptureRecord[]> {
  const path = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!path) return [];
  try {
    const artifact = JSON.parse(await readFile(path, "utf8")) as { records?: CaptureRecord[] };
    return (artifact.records ?? []).filter(
      (record) =>
        JSON.stringify(record.requestJson).includes(marker) &&
        !JSON.stringify(record.requestJson).includes("Generate a concise title"),
    );
  } catch {
    return [];
  }
}

function readModel(requestJson: unknown): string | null {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) return null;
  const model = (requestJson as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}
