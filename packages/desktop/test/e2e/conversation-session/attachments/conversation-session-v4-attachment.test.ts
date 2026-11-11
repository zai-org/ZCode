// T06 + T07 + D12 门禁：仅附件首发；已发送图片预览；latest query 删除附件后 branch cut。
// 证据层 L3：
// 1) 两个 PNG 经真实 paste + eager begin/chunk/commit，正文保持空字符串；
// 2) 首发允许仅 AttachmentRef[]，user row 保留两个有序 ref；
// 3) composer 编辑态删除第一个并提交，UI active branch 与 provider-visible request 都仅含第二个 ref。
import { TID_V4_ROW_ATTACHMENTS } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { removeV4ComposerAttachmentAt } from "#e2e/helpers/v4-composer-edit";
import {
  beginFirstV4UserQueryEdit,
  clickV4Send,
  pasteV4ComposerImageAttachment,
  prepareV4ConversationE2E,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 T06 + D12：仅附件发送与 edit 删除附件", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("仅附件首发 → edit 删除一个 → active branch 与 provider 仅保留剩余 ref", async () => {
    await prepareV4ConversationE2E();

    // 1) 两个附件都走真实 chunk transaction；composer 正文始终为空。
    const removedFilename = await pasteV4ComposerImageAttachment("e2e-remove-me.png");
    const keptFilename = await pasteV4ComposerImageAttachment("e2e-keep-me.png");

    // 2) eager upload ready 后发送按钮因 attachments 可用；点击时不再启动上传。
    await clickV4Send();

    await waitForV4TimelineContaining("V4_ATTACHMENT_ONLY_SEND_OK", 45000);
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "仅附件首发后没有回到空闲态且绑定 session",
      45000,
    );

    await waitForV4ImageAttachments([removedFilename, keptFilename], 30000);

    // T07：已发送图片不再只是一个带假手型的静态 chip；点击后必须通过
    // v4/attachment/read 拉取 artifact，并真正渲染 Blob 图片预览。
    const clickedPreview = await browser.execute(
      (attachmentsPrefix, filename) => {
        const cards = Array.from(
          document.querySelectorAll<HTMLElement>(
            `[data-testid^="${attachmentsPrefix}-"] [data-v4-user-input-media-attachment="true"]`,
          ),
        );
        const target = cards.find(
          (candidate) => candidate.querySelector<HTMLImageElement>("img")?.alt === filename,
        );
        target?.click();
        return Boolean(target);
      },
      TID_V4_ROW_ATTACHMENTS,
      keptFilename,
    );
    expect(clickedPreview).toBe(true);
    await browser.waitUntil(
      async () =>
        browser.execute((filename) => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
          const image = dialog?.querySelector<HTMLImageElement>(`img[alt="${filename}"]`);
          return Boolean(image?.src.startsWith("blob:"));
        }, keptFilename),
      { timeout: 15000, timeoutMsg: "已发送图片点击后没有打开 Blob 图片预览" },
    );
    await browser.keys(["Escape"]);

    // 3) composer 编辑态载入原有序 refs；删除索引 0（第一个附件）后用原发送按钮提交。
    await beginFirstV4UserQueryEdit("");
    await removeV4ComposerAttachmentAt(0);
    await clickV4Send();

    // fixture 以 provider placeholder 同时证明：新请求含 kept、不含 removed。
    await waitForV4TimelineContaining("V4_ATTACHMENT_EDIT_ONE_OK", 45000);
    await waitForV4ImageAttachments([keptFilename], 30000);
  });
});

async function waitForV4ImageAttachments(expectedFilenames: string[], timeout: number) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (attachmentsPrefix, expected) => {
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>(
              `[data-testid^="${attachmentsPrefix}-"] [data-v4-user-input-media-attachment="true"]`,
            ),
          );
          return (
            cards.length === expected.length &&
            cards.every((card, index) => {
              const image = card.querySelector<HTMLImageElement>("img");
              return (
                card.getAttribute("role") === "button" &&
                image?.alt === expected[index] &&
                image?.src.startsWith("blob:") === true
              );
            })
          );
        },
        TID_V4_ROW_ATTACHMENTS,
        expectedFilenames,
      ),
    { timeout, timeoutMsg: `user 行图片附件没有按原顺序收敛: ${expectedFilenames.join(", ")}` },
  );
}
