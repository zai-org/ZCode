// T11：Excel 多表示剪贴板中的 TSV 文本优先于同 payload 的合成 PNG。
// 证据层 L3：真实 ClipboardEvent → Lexical 默认 paste → composer → provider request。
import { TID_V4_COMPOSER_INPUT, TID_V4_ROW_ATTACHMENTS } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4Send,
  getV4ComposerAttachments,
  getV4ComposerText,
  prepareV4ConversationE2E,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 120_000;
const SYNTHETIC_IMAGE = "e2e-spreadsheet-synthetic.png";
const TSV_TEXT = "E2E_SPREADSHEET_PASTE\tScore\nAlice\t42";
const EXCEL_HTML = [
  '<html xmlns:x="urn:schemas-microsoft-com:office:excel">',
  "<body><table><tr><td>E2E_SPREADSHEET_PASTE</td><td>Score</td></tr>",
  "<tr><td>Alice</td><td>42</td></tr></table></body></html>",
].join("");
const REPLY_MARKER = "SPREADSHEET_PASTE_OK";

describe("T11：spreadsheet clipboard 优先粘贴文本", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Excel HTML + TSV + synthetic PNG 只插入文本且不创建附件", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    expect(await dispatchSpreadsheetPaste()).toBe(true);

    await browser.waitUntil(async () => (await getV4ComposerText()) === TSV_TEXT, {
      timeout: 15_000,
      timeoutMsg: "T11 spreadsheet paste 后 Lexical 没有保留 TSV 文本",
    });
    expect(await getV4ComposerAttachments()).toEqual([]);

    await clickV4Send();
    await waitForV4TimelineContaining(REPLY_MARKER, 60_000);
    const terminal = await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(TSV_TEXT),
      "T11 provider 回复后 user row 没有保留 TSV 文本",
      60_000,
    );
    expect(terminal.timelineText).not.toContain(SYNTHETIC_IMAGE);
    expect(await hasUserRowAttachments()).toBe(false);
  });
});

async function dispatchSpreadsheetPaste(): Promise<boolean> {
  return browser.execute(
    (inputTestId, text, html, filename) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const editable =
        input?.querySelector<HTMLElement>('[contenteditable="true"]') ??
        (input?.getAttribute("contenteditable") === "true" ? input : null);
      if (!editable) return false;

      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", text);
      clipboard.setData("text/html", html);
      clipboard.items.add(new File([bytes], filename, { type: "image/png" }));

      // Bug 根因：Excel 会为同一次复制附带合成 PNG；旧逻辑见到 files 就先上传图片，
      // 导致表格粘贴变成附件。这里派发完整多表示 payload，验证文本优先级。
      editable.focus();
      editable.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    },
    TID_V4_COMPOSER_INPUT,
    TSV_TEXT,
    EXCEL_HTML,
    SYNTHETIC_IMAGE,
  );
}

function hasUserRowAttachments(): Promise<boolean> {
  return browser.execute(
    (attachmentsPrefix) =>
      Boolean(document.querySelector(`[data-testid^="${attachmentsPrefix}-"]`)),
    TID_V4_ROW_ATTACHMENTS,
  );
}
