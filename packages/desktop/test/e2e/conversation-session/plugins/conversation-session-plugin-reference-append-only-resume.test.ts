// PLG13 / PLG14 provider-wire 候选：
// 1) 多轮会话内每次真实 provider `messages` 只能在尾部追加；
// 2) 同进程切走再打开（热恢复）不得改写已经发送的历史；
// 3) 保留 profile 完整重启 Desktop/Host/CLI（冷恢复）后仍不得重算历史 reminder。
//
// Bug 根因防线：只检查当前请求“还含有 plugin_reference”无法发现旧 reminder 被删除、
// 重排或重建。这里逐项比较相邻请求的完整 messages 前缀，直接锁住 Prefix Cache 合同。
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  restartIntoWorkspacePreservingProfile,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Model,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "e2e-plugin-reference-append-only";
const PROVIDER_NAME = "Plugin Reference Append Only E2E";
const MODEL_ID = "plugin-reference-append-only-model";
const PLUGIN_STABLE_ID = "skill-creator@zcode-plugins-official";
const U1_MARKER = "E2E_PLUGIN_APPEND_ONLY_U1";
const U2_MARKER = "E2E_PLUGIN_APPEND_ONLY_U2";
const U3_MARKER = "E2E_PLUGIN_APPEND_ONLY_U3_HOT";
const U4_MARKER = "E2E_PLUGIN_APPEND_ONLY_U4_COLD";
const PARKING_MARKER = "E2E_PLUGIN_APPEND_ONLY_PARKING";
const A1_MARKER = "PLUGIN_APPEND_ONLY_A1";
const A2_MARKER = "PLUGIN_APPEND_ONLY_A2";
const A3_MARKER = "PLUGIN_APPEND_ONLY_A3_HOT";
const A4_MARKER = "PLUGIN_APPEND_ONLY_A4_COLD";
const PARKING_REPLY = "PLUGIN_APPEND_ONLY_PARKING_OK";
const PLUGIN_REFERENCE_TAG = "<plugin_reference>";

type ProviderMessage = unknown;

describe("PLG13/PLG14 Plugin 引用多轮热/冷恢复 append-only", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("真实 provider messages 在多轮、热恢复与冷恢复后保持严格前缀", async function () {
    this.timeout(360_000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: PROVIDER_ID,
      models: [MODEL_ID],
      name: PROVIDER_NAME,
    });
    await seedPersistedModelSelection({
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      reasoningLevel: "disabled",
    });
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    // 最近选择不决定已创建草稿的当前模型；前置通过真实选择器采用本例 Provider。
    await switchV4Model(PROVIDER_ID, MODEL_ID, "disabled");
    await waitForSelectedModel(PROVIDER_ID, MODEL_ID);

    const u1Prompt =
      `${U1_MARKER}: Use [@skill-creator](plugin://${PLUGIN_STABLE_ID}), ` +
      `then reply with exactly "${A1_MARKER}".`;
    const request1 = await sendAndCapture(u1Prompt, U1_MARKER, A1_MARKER);
    const messages1 = readProviderMessages(request1.requestJson, "Req1");
    const reminder1 = readSinglePluginReminder(messages1, "Req1");
    const targetSessionId = await readIdleBoundSession("U1 没有创建目标 session");

    const u2Prompt = `${U2_MARKER}: Reply with exactly "${A2_MARKER}".`;
    const request2 = await sendAndCapture(u2Prompt, U2_MARKER, A2_MARKER);
    const messages2 = readProviderMessages(request2.requestJson, "Req2");
    assertStrictMessagePrefix(messages1, messages2, "U1 → U2");
    expect(readSinglePluginReminder(messages2, "Req2")).toEqual(reminder1);

    // PLG13 热恢复：同一 Desktop/Host/CLI 进程内，先完成并停留在另一条 task，
    // 再重新打开目标 task。只切换 renderer 选中态，不创建新的 runtime 进程。
    // 全局新建会生成另一个 cwd，冷重启 helper 随后会切回原项目并自动打开目标任务。
    // parking 必须在同一项目中，才能覆盖同 Host/CLI 热切换和冷启动后的显式恢复。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(PROVIDER_ID, MODEL_ID, "disabled");
    await sendV4Prompt(`${PARKING_MARKER}: Reply with exactly "${PARKING_REPLY}".`);
    await waitForV4AssistantMessageContaining(PARKING_REPLY, 60_000);
    const parkingSessionId = await readIdleBoundSession("parking session 没有完成");
    expect(parkingSessionId).not.toBe(targetSessionId);

    await selectV4TaskById(targetSessionId);
    await waitForV4TimelineContaining(U2_MARKER, 60_000);
    const u3Prompt = `${U3_MARKER}: Reply with exactly "${A3_MARKER}".`;
    const request3 = await sendAndCapture(u3Prompt, U3_MARKER, A3_MARKER);
    const messages3 = readProviderMessages(request3.requestJson, "Req3-hot");
    assertStrictMessagePrefix(messages2, messages3, "U2 → hot U3");
    expect(readSinglePluginReminder(messages3, "Req3-hot")).toEqual(reminder1);

    // PLG14 冷恢复：先切回 parking，避免目标 task 在记录前被自动打开；随后保留
    // profile 完整重启 Electron、Host 和 CLI，再由侧栏重新打开目标 task。
    await selectV4TaskById(parkingSessionId);
    await restartIntoWorkspacePreservingProfile();
    await waitForSelectedModel(PROVIDER_ID, MODEL_ID);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== targetSessionId,
      "冷启动后目标 session 在显式选择前已被自动打开",
      60_000,
    );
    await selectV4TaskById(targetSessionId, 30_000);
    await waitForV4TimelineContaining(U3_MARKER, 60_000);

    const u4Prompt = `${U4_MARKER}: Reply with exactly "${A4_MARKER}".`;
    const request4 = await sendAndCapture(u4Prompt, U4_MARKER, A4_MARKER);
    const messages4 = readProviderMessages(request4.requestJson, "Req4-cold");
    assertStrictMessagePrefix(messages3, messages4, "hot U3 → cold U4");
    expect(readSinglePluginReminder(messages4, "Req4-cold")).toEqual(reminder1);

    // 历史 reminder 只允许在模型输入中存在；热/冷恢复都不能把它投影成用户气泡。
    const timelineHasReminder = await browser.execute(
      (tag) => (document.body.textContent ?? "").includes(tag),
      PLUGIN_REFERENCE_TAG,
    );
    expect(timelineHasReminder).toBe(false);
  });
});

async function sendAndCapture(prompt: string, marker: string, reply: string) {
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(reply, 60_000);
  await waitForV4Pane(
    (snapshot) =>
      Boolean(snapshot.sessionId && snapshot.sessionId !== "draft") && !snapshot.canStop,
    `${marker} 没有完成并回到 idle`,
    90_000,
  );
  const request = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(request, { expectedText: prompt, model: MODEL_ID });
  return request;
}

async function readIdleBoundSession(timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft") && !current.canStop,
    timeoutMsg,
    90_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`${timeoutMsg}; sessionId=${snapshot.sessionId}`);
  }
  return snapshot.sessionId;
}

function readProviderMessages(requestJson: unknown, label: string): ProviderMessage[] {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) {
    throw new Error(`${label} provider request 不是 JSON object`);
  }
  const messages = (requestJson as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    throw new Error(`${label} provider request 缺少 messages 数组`);
  }
  return messages;
}

function assertStrictMessagePrefix(
  previous: readonly ProviderMessage[],
  next: readonly ProviderMessage[],
  label: string,
) {
  expect(next.length).toBeGreaterThan(previous.length);
  expect(next.slice(0, previous.length)).toEqual(previous);
  if (next.length <= previous.length) {
    throw new Error(
      `${label} 没有在历史尾部追加消息：previous=${previous.length}, next=${next.length}`,
    );
  }
}

function readSinglePluginReminder(
  messages: readonly ProviderMessage[],
  label: string,
): ProviderMessage {
  const reminders = messages.filter((message) =>
    JSON.stringify(message).includes(PLUGIN_REFERENCE_TAG),
  );
  expect(reminders).toHaveLength(1);
  if (reminders.length !== 1) {
    throw new Error(`${label} plugin_reference 数量不是 1：${reminders.length}`);
  }
  expect(JSON.stringify(reminders[0])).toContain(PLUGIN_STABLE_ID);
  return reminders[0];
}
