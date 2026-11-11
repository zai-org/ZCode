import {
  getV4ComposerAttachments,
  getV4ComposerText,
  getV4Messages,
  pasteV4ComposerFileAttachment,
  prepareV4ConversationE2E,
  setV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import { countUpstreamRequests } from "#e2e/helpers/conversation-session-network";

describe("IPE04 图片编辑保存到当前输入框", () => {
  before(async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
  });
  it("追加 PNG，保留原附件和文字且不发送", async () => {
    await setV4ComposerText("E2E_IMAGE_PREVIEW_EDIT existing draft");
    const png = await browser.execute(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#dddddd";
      context.fillRect(0, 0, 320, 240);
      return canvas.toDataURL("image/png").split(",")[1]!;
    });
    await pasteV4ComposerFileAttachment("original.png", { mimeType: "image/png", base64: png });
    await browser.waitUntil(async () => (await getV4ComposerAttachments()).length === 1);
    const original = await getV4ComposerAttachments();
    const messages = await getV4Messages();
    const requests = await countUpstreamRequests({});
    await $('[data-testid^="v4-attachment-"][data-upload-status][role="button"]').click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const image = document.querySelector<HTMLImageElement>(
            "[data-image-preview-surface] img",
          );
          return image?.naturalWidth === 320 && image.getBoundingClientRect().width > 0;
        }),
      { timeout: 10000, timeoutMsg: "原图未解码，不能开始标注" },
    );
    await browser.executeAsync((done) => {
      const dialog = document.querySelector('[role="dialog"]');
      Promise.all(dialog?.getAnimations().map((animation) => animation.finished) ?? []).then(() =>
        done(),
      );
    });
    await $("[data-image-preview-annotate]").click();
    // 新版标注栏按需展开；保存按钮只在有标注后出现在图形下方，因此这里只保留 11-02 工具栏修订的“无橡皮擦”断言。
    const eraserCount = await browser.execute(
      () => document.querySelectorAll('[data-image-preview-tool="eraser"]').length,
    );
    expect(eraserCount).toBe(0);
    await $('[data-image-preview-tool="pen"]').click();
    const surface = await $("[data-image-preview-surface]");
    const location = await surface.getLocation();
    await browser.performActions([
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            origin: "viewport",
            x: Math.round(location.x + 40),
            y: Math.round(location.y + 40),
          },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 200, origin: "pointer", x: 100, y: 60 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await $("[data-image-preview-save]").click();
    await browser.waitUntil(async () => (await getV4ComposerAttachments()).length === 2, {
      timeout: 15000,
      timeoutMsg: "保存没有追加新图片",
    });
    expect(await getV4ComposerText()).toBe("E2E_IMAGE_PREVIEW_EDIT existing draft");
    const attachments = await getV4ComposerAttachments();
    expect(attachments[0]?.text).toBe(original[0]?.text);
    expect(attachments[1]?.text).toBe("original-edited.png");
    const savedSize = await browser.execute(async () => {
      const image = document.querySelector<HTMLImageElement>('img[alt="original-edited.png"]')!;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    expect(savedSize).toEqual([320, 240]);
    expect(await getV4Messages()).toEqual(messages);
    expect(await countUpstreamRequests({})).toBe(requests);
    await $('[role="dialog"]').waitForExist({ reverse: true });
  });
});
