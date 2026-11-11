// PV4-18/PV4-19：compact-covered 附件 intent 重放，以及多 compact boundary 跨界 edit + cold restore。
import { TID_V4_COMPOSER_INPUT, TID_V4_ROW } from "@zcode/shared/test-ids";
import {
  clearAppData,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  clickV4Send,
  editFirstV4UserQuery,
  getV4PaneSnapshot,
  pasteV4ComposerImageAttachment,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Edit,
  waitForV4Pane,
  waitForV4RowAttachments,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("PV4-18/PV4-19 compact-covered extended rewind", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PV4-18 附件 edit 保留 canonical ref，新 provider request 只收到编辑分支", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();
    const filename = await pasteV4ComposerImageAttachment("pv4-18-rewind.png");

    await sendV4Prompt("E2E_PV4_18_ATTACHMENT_ORIGINAL 带图片的原问题");
    await waitForV4TimelineContaining("PV4_18_ATTACHMENT_ORIGINAL_REPLY", 60000);
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    await compactAndWait();

    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_PV4_18_ATTACHMENT_EDITED 编辑后仍带原图片");
    await waitForV4TimelineContaining("PV4_18_ATTACHMENT_EDITED_REPLY", 60000);

    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.sessionId).toBe(sessionId);
    expect(finalSnapshot.timelineText).not.toContain("PV4_18_ATTACHMENT_ORIGINAL_REPLY");
    expect(await waitForV4RowAttachments()).toContain(filename);
    const capture = await waitForUpstreamNetworkCapture("E2E_PV4_18_ATTACHMENT_EDITED");
    const requestText = JSON.stringify(capture.requestJson);
    expect(requestText).toMatch(/image|base64|data:image/i);
    expect(requestText).not.toContain("PV4_18_ATTACHMENT_ORIGINAL_REPLY");
  });

  it("PV4-19 两次 compact 后跨最新 boundary edit，cold restore 保留更早 summary", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_PV4_19_FIRST 第一轮");
    await waitForV4TimelineContaining("PV4_19_FIRST_REPLY", 60000);
    await compactAndWait();

    await sendV4Prompt("E2E_PV4_19_SECOND_ORIGINAL 第二轮原文");
    await waitForV4TimelineContaining("PV4_19_SECOND_ORIGINAL_REPLY", 60000);
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    expect(sessionId).toBeTruthy();
    await compactAndWait();

    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_PV4_19_SECOND_EDITED 第二轮编辑后");
    await waitForV4TimelineContaining("PV4_19_SECOND_EDITED_REPLY", 60000);

    await browser.execute(() => window.location.reload());
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(sessionId!);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === sessionId &&
        snapshot.timelineText.includes("PV4_19_SECOND_EDITED_REPLY"),
      "PV4-19 cold restore 没有恢复编辑后 active branch",
      90000,
    );

    await sendV4Prompt("E2E_PV4_19_FOLLOWUP 冷恢复后追问");
    await waitForV4TimelineContaining("PV4_19_FOLLOWUP_REPLY", 60000);
    const capture = await waitForUpstreamNetworkCapture("E2E_PV4_19_FOLLOWUP");
    const requestText = JSON.stringify(capture.requestJson);
    expect(requestText).toContain("PV4_19_FIRST_SUMMARY");
    expect(requestText).toContain("E2E_PV4_19_SECOND_EDITED");
    expect(requestText).not.toContain("PV4_19_SECOND_SUMMARY");
    expect(requestText).not.toContain("E2E_PV4_19_SECOND_ORIGINAL");
  });
});

async function compactAndWait() {
  const before = await compactSuccessMarkerCount();
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
    timeout: 15000,
    timeoutMsg: "PV4 compact composer 没有出现",
  });
  await clickV4Send();
  await browser.waitUntil(async () => (await compactSuccessMarkerCount()) === before + 1, {
    timeout: 90000,
    timeoutMsg: "PV4 compact success marker 数量没有增加",
  });
}

function compactSuccessMarkerCount(): Promise<number> {
  return browser.execute(
    (rowPrefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`)).filter(
        (row) =>
          row.dataset.rowKind === "timelineMarker" &&
          row.dataset.markerType === "compact" &&
          row.dataset.status === "success" &&
          row.dataset.origin === "manual",
      ).length,
    TID_V4_ROW,
  );
}
