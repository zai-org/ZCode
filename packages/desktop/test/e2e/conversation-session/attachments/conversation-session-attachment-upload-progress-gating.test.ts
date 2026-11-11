// AP02/AP06：浏览器 File eager upload 的圆环进度与发送/队列门禁。
// 证据层 L3：真实 paste File → renderer begin/chunk/commit → ready AttachmentRef → sendText。
// 观察窗口内若附件仍为 queued/uploading/committing，发送按钮必须 disabled；正式提升前还需
// 录制手机 Web attached-host 与真实 SSH 的网络/日志证据，确认没有提前 sendText/task command。
import {
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("AP02/AP06：附件上传进度与发送门禁", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("大图片上传期间显示百分比且发送 disabled，ready 后才允许提交", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();

    const observed = (await browser.executeAsync(
      (inputTestId, attachmentPrefix, progressPrefix, sendTestId, done) => {
        const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
        const editable =
          input?.querySelector<HTMLElement>('[contenteditable="true"]') ??
          (input?.getAttribute("contenteditable") === "true" ? input : null);
        if (!editable) {
          done({ ok: false, reason: "composer-input-missing" });
          return;
        }

        let settled = false;
        const finish = (value: {
          ariaLabel?: string | null;
          ok: boolean;
          reason?: string;
          sendDisabled?: boolean;
          status?: string;
          text?: string;
        }) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          window.clearTimeout(timeout);
          done(value);
        };
        const capture = () => {
          const attachment = document.querySelector<HTMLElement>(
            `[data-testid^="${attachmentPrefix}-"]`,
          );
          const progress = document.querySelector<HTMLElement>(
            `[data-testid^="${progressPrefix}-"]`,
          );
          const send = document.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
          if (!attachment || !progress || !send) return;
          finish({
            ariaLabel: progress.getAttribute("aria-label"),
            ok: true,
            sendDisabled: send.disabled,
            status: attachment.dataset.uploadStatus,
            text: progress.innerText,
          });
        };
        const observer = new MutationObserver(capture);
        observer.observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        const timeout = window.setTimeout(
          () => finish({ ok: false, reason: "progress-not-observed" }),
          15000,
        );

        // 接近协议上限的大 File 拉长分块窗口；内容无需是可解码 PNG，附件链路只按 bytes 上传。
        const file = new File([new Uint8Array(16 * 1024 * 1024)], "ap02-large.png", {
          type: "image/png",
        });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        editable.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dataTransfer,
          }),
        );
        capture();
      },
      TID_V4_COMPOSER_INPUT,
      TID_V4_ATTACHMENT,
      TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
      TID_V4_COMPOSER_SEND,
    )) as {
      ariaLabel?: string | null;
      ok: boolean;
      reason?: string;
      sendDisabled?: boolean;
      status?: string;
      text?: string;
    };

    expect(observed).toMatchObject({ ok: true, sendDisabled: true });
    expect(["waitingSession", "queued", "uploading", "committing"]).toContain(observed.status);
    expect(`${observed.ariaLabel ?? ""}${observed.text ?? ""}`).toMatch(/%|上传|upload/iu);

    await browser.waitUntil(
      async () =>
        browser.execute(
          (attachmentPrefix, progressPrefix, sendTestId) => {
            const attachment = document.querySelector<HTMLElement>(
              `[data-testid^="${attachmentPrefix}-"]`,
            );
            const progress = document.querySelector<HTMLElement>(
              `[data-testid^="${progressPrefix}-"]`,
            );
            const send = document.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
            return (
              attachment?.dataset.uploadStatus === "ready" && !progress && send?.disabled === false
            );
          },
          TID_V4_ATTACHMENT,
          TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
          TID_V4_COMPOSER_SEND,
        ),
      { timeout: 60000, timeoutMsg: "附件未完成 eager upload 或发送按钮未解除门禁" },
    );

    await sendV4Prompt("E2E_AP02_ATTACHMENT_GATE ready 后发送");
    await waitForV4TimelineContaining("AP02_ATTACHMENT_GATE_OK", 45000);
  });
});
