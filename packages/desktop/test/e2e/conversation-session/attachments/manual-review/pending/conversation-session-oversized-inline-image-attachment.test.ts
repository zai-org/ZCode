import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import { UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  clickV4Send,
  getV4Messages,
  setV4ComposerText,
  getV4ComposerAttachments,
  pickV4ComposerFiles,
  prepareV4ConversationE2E,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import { writeOversizedComposerPrefillPngFixture } from "#e2e/helpers/conversation-session-composer-prefill";

const OVERSIZED_INLINE_IMAGE_TIMEOUT_MS = 180000;
const OVERSIZED_IMAGE_BYTES = 21 * 1024 * 1024;

describe("会话区超大图片附件边界 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("T04: 无 localPath 的超大图片在发送前拦截，保留草稿且不发 provider 请求", async function () {
    this.timeout(OVERSIZED_INLINE_IMAGE_TIMEOUT_MS);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const marker = `E2E_OVERSIZED_INLINE_IMAGE_${runId}`;
    const filename = `oversized-inline-${runId}.png`;
    const prompt = `${marker}: this prompt must stay in composer because the inline image is too large.`;
    await setV4ComposerText(prompt);
    // 附件现由上传 owner 管理，旧 Session Store prefill 已移除。
    // 真实粘贴一个无本机路径的 File，进入生产序列化和大小校验，不能伪造 ready 引用。
    await browser.execute(
      (testId, name, bytes) => {
        const input = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
        input.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      TID_V4_COMPOSER_INPUT,
      filename,
      OVERSIZED_IMAGE_BYTES,
    );
    const requestCountBefore = await countUpstreamRequestsContaining(marker);
    await waitForOversizedImageError(filename);
    await waitForAttachment(filename, "failed");
    expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
    await waitForV4ComposerText(prompt, "无路径超大图片发送前拦截后没有保留正文");
    await waitForAttachment(filename, "failed");

    const requestCountAfter = await countUpstreamRequestsContaining(marker);
    expect(requestCountAfter).toBe(requestCountBefore);
    const userMessages = await getV4Messages("user");
    expect(userMessages.some((message) => message.text.includes(marker))).toBe(false);
  });

  it("T05: 有 localPath 的超大图片应以路径引用发送且不携带 dataBase64", async function () {
    this.timeout(OVERSIZED_INLINE_IMAGE_TIMEOUT_MS);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const marker = `E2E_OVERSIZED_LOCAL_PATH_IMAGE_${runId}`;
    const filename = `oversized-local-path-${runId}.png`;
    const localPath = join(DEFAULT_WORKSPACE, filename);
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await writeOversizedComposerPrefillPngFixture(localPath, OVERSIZED_IMAGE_BYTES);
    // 修复验证原因：agent 会按磁盘 stat.size 判断本地图片是否内联。
    // 因此 T05 必须使用真实超过 20MiB 的文件，才能证明 provider 请求不会携带 data URL。
    await setV4ComposerText(prompt);
    await pickV4ComposerFiles([localPath]);
    await waitForAttachment(filename, "ready");

    await clickV4Send();
    await waitForV4ComposerText("", "有路径超大图片发送后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    const record = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(record, {
      expectedText: prompt,
      model: UPSTREAM_MODEL,
    });
    assertLocalPathImageAttachmentRequest(record.requestJson, { filename, localPath });

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "有路径超大图片发送完成后没有回到 idle",
      90000,
    );
  });
});

async function waitForAttachment(filename: string, status: string) {
  // 本机路径附件不生成 objectURL，卡片只有类型图标；精确文件名/路径在实际请求中对账。
  await browser.waitUntil(
    async () => {
      const attachments = await getV4ComposerAttachments();
      return (
        attachments.length === 1 &&
        attachments[0]?.kind === "image" &&
        attachments[0]?.uploadStatus === status
      );
    },
    { timeout: 15000, timeoutMsg: `${filename} 没有进入 ${status}` },
  );
}

function assertLocalPathImageAttachmentRequest(
  requestJson: unknown,
  expected: { filename: string; localPath: string },
) {
  expect(containsText(requestJson, expected.filename)).toBe(true);
  expect(containsText(requestJson, expected.localPath)).toBe(true);
  expect(containsObjectKey(requestJson, "dataBase64")).toBe(false);
  expect(containsText(requestJson, "data:image")).toBe(false);
}

function containsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => containsText(child, expected));
}

function containsObjectKey(value: unknown, expectedKey: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsObjectKey(item, expectedKey));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, expectedKey) ||
    Object.values(record).some((child) => containsObjectKey(child, expectedKey))
  );
}

async function waitForOversizedImageError(filename: string) {
  let latestText = "";
  try {
    await browser.waitUntil(
      async () => {
        latestText = await getAttachmentErrorText();
        return latestText.includes(filename) && latestText.includes("20 MB");
      },
      {
        timeout: 10000,
        timeoutMsg: "没有显示超大图片附件错误",
      },
    );
  } catch (error) {
    console.log(
      "E2E_OVERSIZED_ATTACHMENT_STATE",
      await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-composer-attachment-kind]")).map(
          (element) => ({
            status: element.dataset.uploadStatus,
            html: element.outerHTML.slice(0, 7000),
          }),
        ),
      ),
    );
    throw new Error(`没有显示超大图片附件错误; latest=${latestText}`, { cause: error });
  }
}

function getAttachmentErrorText() {
  return browser.execute(() => {
    // 上传错误显示在附件的可访问状态和重试按钮上，已不再是 Composer 下方的段落。
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-upload-status="failed"] [role="alert"], [data-upload-status="failed"] [title]',
      ),
    );
    return (
      candidates
        .map((element) =>
          (element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText)
            .replace(/\u00a0/g, " ")
            .trim(),
        )
        .find((text) => text.includes("20 MB")) ?? ""
    );
  });
}
