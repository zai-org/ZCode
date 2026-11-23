import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay, waitForControlledReplay } from "#e2e/helpers/controlled-replay";
import { dismissOccupationOnboarding } from "#e2e/helpers/occupation-onboarding";
import {
  clickV4Stop,
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const observations: Array<{ stage: string; runningAgentSessionCount: number }> = [];

async function readActivity() {
  return browser.execute(async () => {
    const bridge = (
      window as unknown as {
        zcode: { getDesktopSessionActivity(): Promise<{ runningAgentSessionCount: number }> };
      }
    ).zcode;
    return bridge.getDesktopSessionActivity();
  });
}

async function expectActivity(stage: string, expected: number) {
  await browser.waitUntil(
    async () => (await readActivity()).runningAgentSessionCount === expected,
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${stage}: expected ${expected} active sessions`,
    },
  );
  const activity = await readActivity();
  expect(activity).toEqual({ runningAgentSessionCount: expected });
  observations.push({ stage, ...activity });
}

async function prepareShellAndDismissOnboarding() {
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="onboarding-page"]').isExisting()) ||
      (await $('[data-testid="task-settings-button"]').isExisting()),
    { timeout: 30_000, timeoutMsg: "Desktop shell/onboarding did not become ready" },
  );
  // onboarding 的 dismissed 状态会跨用例持久化，连续验收时不能假设页面再次出现。
  if (await $('[data-testid="onboarding-page"]').isExisting()) {
    await dismissOccupationOnboarding();
    await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true, timeout: 15_000 });
  }
}

async function startHeldTurn(marker: string, fixture: string) {
  await sendV4Prompt(`${marker}: Keep responding until the test releases the stream.`);
  await waitForControlledReplay(fixture);
  await waitForV4AssistantMessageContaining(`${marker}_STREAMING`);
  await waitForV4ConversationState(
    (state) => state.state === "streaming",
    "Real CLI response did not enter streaming",
    30_000,
  );
  await expectActivity(marker, 1);
}

describe("Session activity close confirmation (pending SAC)", () => {
  afterEach(async () => {
    if (!(await browser.$('[data-testid="v4-session-pane-workspace-main"]').isExisting())) return;
    if ((await getV4ConversationState()).state === "streaming") {
      await clickV4Stop();
      await waitForV4ConversationState(
        (state) => state.state === "idle",
        "Cleanup stop failed",
        30_000,
      );
    }
    await browser.electron.restoreAllMocks();
  });

  after(async () => {
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, "SAC-activity.json"),
        JSON.stringify(observations, null, 2),
      );
    }
    await clearAppData();
  });

  it("SAC01: real Host/CLI foreground activity returns one, then zero after stop and finish", async function () {
    this.timeout(120_000);
    await prepareShellAndDismissOnboarding();
    await prepareV4ConversationE2E();
    await expectActivity("initial-idle", 0);
    await startHeldTurn("E2E_SAC_STOP", "sac-stop");
    await clickV4Stop();
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "Stop did not settle",
      30_000,
    );
    await expectActivity("stopped", 0);

    await startHeldTurn("E2E_SAC_FINISH", "sac-finish");
    await releaseControlledReplay("sac-finish");
    await waitForV4AssistantMessageContaining("SAC_FINISH_DONE");
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "Finish did not settle",
      30_000,
    );
    await expectActivity("finished", 0);
  });

  it("SAC01: production Main cancels real app.quit without stopping the active session", async function () {
    this.timeout(120_000);
    // 普通 WDIO 构建固定 test 后端，不能命中 production 退出门控；此段仅接收显式打包验收。
    // 打包产物也必须由当前源码以 production 后端构建；仅设置运行时 ZCODE_ENV 不生效。
    if (!(await browser.electron.execute((electron) => electron.app.isPackaged))) this.skip();
    await prepareShellAndDismissOnboarding();
    await prepareV4ConversationE2E({ skipProvider: true });
    await expectActivity("quit-initial-idle", 0);
    const dialog = await browser.electron.mock("dialog", "showMessageBoxSync");
    await dialog.mockReturnValue(1);
    await startHeldTurn("E2E_SAC_QUIT", "sac-quit");
    const sessionId = (await getV4ConversationState()).taskId;

    // 不 mock app.quit：让真实 before-quit 读取 Host 上报计数，再由同步原生对话框取消。
    await browser.electron.execute((electron) => electron.app.quit());
    await expect(dialog).toHaveBeenCalledTimes(1);
    await expect(dialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "question",
        defaultId: 1,
        cancelId: 1,
        buttons: expect.arrayContaining([expect.stringMatching(/Cancel|取消/u)]),
        detail: expect.stringMatching(/In-progress sessions: 1|正在进行的会话：1/u),
      }),
    );
    const state = await getV4ConversationState();
    expect(state.taskId).toBe(sessionId);
    expect(state.state).toBe("streaming");
    await waitForControlledReplay("sac-quit");
    await expectActivity("quit-cancelled-still-running", 1);
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "SAC01-cancelled.png"));
    await releaseControlledReplay("sac-quit");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "Cancelled quit lost execution",
      30_000,
    );
    await expectActivity("quit-cancelled-then-finished", 0);
  });
});
