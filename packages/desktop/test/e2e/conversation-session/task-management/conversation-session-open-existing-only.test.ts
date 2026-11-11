import type { ArmsCustomEventPayload } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_SESSION_OPEN_EXISTING_ONLY";
const REPLY_MARKER = "session-open-existing-only-ok";
const SESSION_OPEN_EVENT_NAMES = [
  "perf_ui_session_open_start",
  "perf_ui_session_open_result",
] as const;

describe("conversation session open existing only", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("草稿提升零上报，离开后重开已有 Session 只上报一组", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    await waitForV4ComposerSelectionReady();
    await clearSessionOpenArmsEvents();

    await sendV4Prompt(`${PROMPT_MARKER}: create a new task without session-open telemetry.`);
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 60_000);
    const createdPane = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "TEL10 草稿提升后没有形成已完成 Session",
      60_000,
    );
    const createdSessionId = createdPane.sessionId;
    if (!createdSessionId || createdSessionId === "draft") {
      throw new Error("TEL10 无法取得新建 Session ID");
    }

    await browser.pause(500);
    expect(await readSessionOpenArmsEvents(createdSessionId)).toEqual([]);

    await startNewV4Draft();
    await waitForV4ComposerSelectionReady();
    await clearSessionOpenArmsEvents();
    await selectV4TaskById(createdSessionId);

    const reopenedEvents = await waitForSessionOpenArmsPair(createdSessionId);
    expect(reopenedEvents.map((event) => event.name)).toEqual(SESSION_OPEN_EVENT_NAMES);
    expect(reopenedEvents[0]?.properties?.session_open_id).toBe(
      reopenedEvents[1]?.properties?.session_open_id,
    );
    expect(reopenedEvents[0]?.properties).toMatchObject({
      session_id: createdSessionId,
      open_trigger: "sidebar",
    });
    expect(reopenedEvents[1]?.properties).toMatchObject({
      session_id: createdSessionId,
      status: "success",
    });
  });
});

async function clearSessionOpenArmsEvents(): Promise<void> {
  await browser.execute(() => {
    (
      window as Window & {
        __zcodeArmsCustomEventsE2E?: Array<ArmsCustomEventPayload & { recordedAt?: number }>;
      }
    ).__zcodeArmsCustomEventsE2E = [];
  });
}

async function readSessionOpenArmsEvents(sessionId: string): Promise<ArmsCustomEventPayload[]> {
  return browser.execute(
    (targetSessionId, targetEventNames) => {
      const events =
        (
          window as Window & {
            __zcodeArmsCustomEventsE2E?: Array<ArmsCustomEventPayload & { recordedAt?: number }>;
          }
        ).__zcodeArmsCustomEventsE2E ?? [];
      return events
        .filter(
          (event) =>
            (targetEventNames as readonly string[]).includes(event.name) &&
            event.properties?.session_id === targetSessionId,
        )
        .map(({ recordedAt: _recordedAt, ...payload }) => payload);
    },
    sessionId,
    [...SESSION_OPEN_EVENT_NAMES],
  );
}

async function waitForSessionOpenArmsPair(sessionId: string): Promise<ArmsCustomEventPayload[]> {
  let latest: ArmsCustomEventPayload[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readSessionOpenArmsEvents(sessionId);
      return latest.length === SESSION_OPEN_EVENT_NAMES.length;
    },
    {
      timeout: 30_000,
      timeoutMsg: `TEL10 重开已有 Session 没有得到一组 session-open 事件: ${sessionId}`,
    },
  );
  return latest;
}
