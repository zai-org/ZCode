// PV4-06 × C07 pending：provider 在首 token 前失败后，必须从持久 transcript
// cold hydration 出可寻址的 latest user row；编辑提交要命中同一 transcript messageId。
import { TID_V4_EDIT, TID_V4_ROW } from "@zcode/shared/test-ids";
import { clearAppData, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import { openV4UserQueryEditInComposer } from "#e2e/helpers/v4-composer-edit";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const FAIL_MARKER = "E2E_V4_COLD_FAILED_EDIT_SOURCE";
const RERUN_MARKER = "E2E_V4_COLD_FAILED_EDIT_RERUN";
const RERUN_REPLY = "E2E_V4_COLD_FAILED_EDIT_OK";

describe("PV4-06 cold hydration：首 token 前失败后编辑 latest user", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("provider 首 token 前失败 → CLI 重启 cold resume → edit 发送成功", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const failingPrompt = `${FAIL_MARKER}_${runId}: fail before the first assistant token.`;
    await sendV4Prompt(failingPrompt);
    await waitForV4TimelineContaining(failingPrompt, 30000);

    const failureRequest = await waitForUpstreamNetworkCapture(FAIL_MARKER);
    expect(failureRequest.statusCode).toBe(400);
    const settled = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(FAIL_MARKER),
      "首 token 前 provider failure 没有保留 user row 并收口",
      60000,
    );
    const sessionId = settled.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`failure 后没有真实 sessionId: ${JSON.stringify(settled)}`);
    }

    // browser.reloadSession 会重启 Electron、host 与 CLI。事件内存随 CLI 消失，
    // 恢复只能依赖持久 message/part → transcript hydration，不能被 live snapshot 兜住。
    await reloadAppAndRestoreV4Session(sessionId);
    await waitForV4TimelineContaining(FAIL_MARKER, 30000);

    // 入口来自 cold projection 的 row.actions.canEdit；提交成功同时证明 command target
    // 能从该 row 原子解析回持久 transcript messageId。
    const rowId = await waitForEditableV4Row(FAIL_MARKER);
    await openV4UserQueryEditInComposer(rowId);
    const rerunPrompt = `${RERUN_MARKER}_${runId}: reply with ${RERUN_REPLY}.`;
    await setV4ComposerText(rerunPrompt);
    await clickV4Send();

    const rerunRequest = await waitForUpstreamNetworkCapture(RERUN_MARKER);
    expect(rerunRequest.statusCode).toBe(200);
    await waitForV4TimelineContaining(RERUN_REPLY, 60000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop &&
        snapshot.timelineText.includes(rerunPrompt) &&
        snapshot.timelineText.includes(RERUN_REPLY) &&
        !snapshot.timelineText.includes(failingPrompt),
      "cold hydrated user edit 已发请求但没有完成重跑",
      60000,
    );
    expect(completed.sessionId).toBe(sessionId);
    // 若 edit 错路由成普通 sendText，旧 query 会保留；这里必须
    // 证明 cold row 解析到原 transcript messageId 并执行 rewind/rerun。
    expect(completed.timelineText).toContain(rerunPrompt);
    expect(completed.timelineText).not.toContain(failingPrompt);
  });
});

async function waitForEditableV4Row(marker: string) {
  let rowId: string | null = null;
  await browser.waitUntil(
    async () => {
      rowId = await browser.execute(
        (expectedMarker, rowPrefix, editPrefix) => {
          const rows = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
          );
          const row = rows.find((candidate) => candidate.innerText.includes(expectedMarker));
          const edit = row?.querySelector<HTMLElement>(`[data-testid^="${editPrefix}-"]`);
          const editTestId = edit?.dataset.testid ?? "";
          return editTestId.startsWith(`${editPrefix}-`)
            ? editTestId.slice(editPrefix.length + 1)
            : null;
        },
        marker,
        TID_V4_ROW,
        TID_V4_EDIT,
      );
      return Boolean(rowId);
    },
    {
      timeout: 30000,
      timeoutMsg: `cold hydrated latest user row 没有权威 canEdit action: ${marker}`,
    },
  );
  if (!rowId) throw new Error(`无法解析 editable v4 rowId: ${marker}`);
  return rowId;
}

async function reloadAppAndRestoreV4Session(sessionId: string) {
  await browser.reloadSession();
  await waitForRendererAfterReloadSession();
  await waitForDefaultWorkspaceReady(60000);
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `CLI cold restart 后没有恢复 session ${sessionId}`,
    60000,
  );
}

async function waitForRendererAfterReloadSession() {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const rendererTarget = puppeteer
          .targets()
          .filter((target) => isRendererUrl(target.url()))
          .at(-1);
        const targetId = rendererTarget
          ? ((rendererTarget as unknown as { _targetId?: string })._targetId ?? null)
          : null;
        if (!targetId) return false;
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        // reloadSession 后旧 CDP websocket 会短暂断开，等待新 renderer target 即可。
        return false;
      }
    },
    {
      timeout: 30000,
      interval: 250,
      timeoutMsg: "CLI cold restart 后没有找到 renderer target",
    },
  );
}

function isRendererUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}
