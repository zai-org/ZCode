import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  clickFirstV4Fork,
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "#e2e/helpers/conversation-session-tool-cross-product";

const CASE_MARKER = "E2E_FORK_MERGED_ASSISTANT";
const SOURCE_MARKER_PREFIX = `${CASE_MARKER}_SOURCE`;
const FILE_MARKER = `${CASE_MARKER}_FILE_CONTENT`;
const FINAL_MARKER = `${CASE_MARKER}_FINAL`;
const HANDOFF_RELATIVE_PATH = "tmp/handoff/e2e-fork-merged-assistant.md";
const HANDOFF_FILE_PATH = join(DEFAULT_WORKSPACE, HANDOFF_RELATIVE_PATH);

describe("会话区 Fork 合并 assistant 回归 E2E", () => {
  before(async function () {
    this.timeout(120000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
  });

  afterEach(async () => {
    await stopIfBusy();
    await cleanupHandoffFile();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("fork 工具调用后的最终可见 assistant 时不应丢最后回复和 handoff 文件", async function () {
    this.timeout(180000);

    await cleanupHandoffFile();
    const sourceMarker = `${SOURCE_MARKER_PREFIX}_${Date.now()}`;
    const prompt = [
      `${sourceMarker}: Trigger the Write tool exactly once to create ${HANDOFF_RELATIVE_PATH}.`,
      `The file content must be exactly "${FILE_MARKER}".`,
      `After the tool succeeds, reply with exactly "${FINAL_MARKER}" and no other text.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(sourceMarker, 60000);
    await waitForStableCompleted("fork merged assistant: source 工具轮没有完成");
    expect(await getFirstV4ForkRowText()).toContain(FINAL_MARKER);
    expect(await readHandoffFileForAssertion()).toContain(FILE_MARKER);

    const sourceSnapshot = await getV4PaneSnapshot();
    const sourceSessionId = sourceSnapshot.sessionId;
    expect(sourceSessionId).toBeTruthy();
    expect(sourceSessionId).not.toBe("draft");

    // 修复原因：这个正式 case 专门复现一条可见 assistant 由多条 raw
    // assistant 合并时，fork after turn 仍必须落在逻辑 turn 的最终回复之后。
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);
    const forkedSnapshot = await waitForV4Pane(
      (snapshot) =>
        Boolean(snapshot.sessionId) &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== sourceSessionId,
      "fork merged assistant: 点击 fork 后没有切换到派生 session",
      30000,
    );
    const forkedSessionId = forkedSnapshot.sessionId;
    expect(forkedSessionId).toBeTruthy();

    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === forkedSessionId && !snapshot.canStop,
      "fork merged assistant: 派生 session 没有恢复完成",
      60000,
    );
    await waitForV4TimelineContaining(sourceMarker, 30000);
    await waitForV4TimelineContaining(FINAL_MARKER, 30000);

    const assistantText = (await getV4PaneSnapshot()).timelineText;
    const forkedHandoffContent = await readHandoffFileForAssertion();

    expect({
      assistantText,
      forkedHandoffContent,
    }).toEqual(
      expect.objectContaining({
        assistantText: expect.stringContaining(FINAL_MARKER),
        forkedHandoffContent: expect.stringContaining(FILE_MARKER),
      }),
    );
  });
});

async function waitForStableCompleted(timeoutMsg: string) {
  let latest = "not-started";
  await browser.waitUntil(
    async () => {
      await respondToToolCrossProductBlockers();
      const snapshot = await getV4PaneSnapshot();
      const forkRowText = await getFirstV4ForkRowText();
      latest = JSON.stringify({ snapshot, forkRowText });
      return !snapshot.canStop && forkRowText.includes(FINAL_MARKER);
    },
    {
      timeout: 120000,
      timeoutMsg: `${timeoutMsg}; latest=${latest}`,
    },
  );
}

async function getFirstV4ForkRowText() {
  return browser.execute(() => {
    const hasFork = Boolean(document.querySelector('[data-testid^="v4-fork-"]'));
    if (!hasFork) return "";
    // TurnGroup 会把 fork 动作延后到文件 summary 之后，按钮不一定是 assistant
    // RowShell 的子节点；按最终 marker 且排除包含 SOURCE 的 user row 找逻辑轮尾。
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="v4-row-"]')).find(
      (candidate) => {
        const text = candidate.innerText ?? "";
        return (
          text.includes("E2E_FORK_MERGED_ASSISTANT_FINAL") &&
          !text.includes("E2E_FORK_MERGED_ASSISTANT_SOURCE")
        );
      },
    );
    return (row?.innerText ?? "").replace(/\u00a0/g, " ");
  });
}

async function readHandoffFileForAssertion() {
  try {
    return await readFile(HANDOFF_FILE_PATH, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `__E2E_HANDOFF_READ_ERROR__ ${message}`;
  }
}

async function cleanupHandoffFile() {
  await rm(HANDOFF_FILE_PATH, { force: true });
}

async function stopIfBusy() {
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.canStop) return;

  await clickV4Stop();
  await waitForV4Pane(
    (nextSnapshot) => !nextSnapshot.canStop,
    "fork merged assistant: 收尾 stop 后没有退出 streaming",
    30000,
  );
}
