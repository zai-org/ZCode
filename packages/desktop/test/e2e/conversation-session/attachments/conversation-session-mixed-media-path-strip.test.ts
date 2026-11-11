import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TID_V4_ROW_ATTACHMENTS } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  selectUpstreamProviderModelById,
  UPSTREAM_MODEL,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import { restartWithSeededOpenAIProviders } from "#e2e/helpers/custom-openai-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  clickV4Send,
  getV4ComposerAttachments,
  pickV4ComposerFiles,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4RowAttachments,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-mixed-media-path-strip";
const MEDIA_MODEL = "e2e-mixed-media-model";
const MEDIA_PROVIDER_NAME = "Mixed Media E2E";
const TEXT_ONLY_MODEL = UPSTREAM_MODEL;
const TEXT_ONLY_PROVIDER_NAME = "Mixed Media Text Only E2E";
const MEDIA_REPLY = "E2E_MIXED_MEDIA_PATH_SUPPORTED_OK";
const TEXT_ONLY_REPLY = "E2E_MIXED_MEDIA_PATH_TEXT_ONLY_OK";
const IMAGE_OMITTED_TEXT =
  "Media omitted from provider request because the selected model does not support image input.";
const VIDEO_OMITTED_TEXT =
  "Media omitted from provider request because the selected model does not support video input.";
const IMAGE_SOURCE_PREFIX = "[Image: source: ";
const VIDEO_SOURCE_PREFIX = "[Video: source: ";
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";
const CASE_ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", CASE_NAME);

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("mixed-media path 与 strip 共享投影 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(CASE_NAME);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(CASE_ROOT, { force: true, recursive: true });
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("VI05: image/video 首轮保留 block+path，切到 text-only 后双 strip 且 path 不变", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    const runId = Date.now();
    const imageFilename = `mixed-media-${runId}.png`;
    const videoFilename = `mixed-media-${runId}.mp4`;
    const imagePath = join(CASE_ROOT, imageFilename);
    const videoPath = join(CASE_ROOT, videoFilename);
    await mkdir(CASE_ROOT, { recursive: true });
    await Promise.all([
      writeFile(imagePath, Buffer.from(VALID_PNG_BASE64, "base64")),
      writeFile(videoPath, Buffer.from("e2e-mixed-media-video")),
    ]);

    const [mediaProvider, textOnlyProvider] = await restartWithSeededOpenAIProviders([
      {
        inputModalities: ["text", "image", "video"],
        modelId: MEDIA_MODEL,
        providerId: `e2e-mixed-media-${runId}`,
        providerName: `${MEDIA_PROVIDER_NAME} ${runId}`,
      },
      {
        inputModalities: ["text"],
        modelId: TEXT_ONLY_MODEL,
        providerId: `e2e-mixed-media-text-only-${runId}`,
        providerName: `${TEXT_ONLY_PROVIDER_NAME} ${runId}`,
      },
    ]);
    if (!mediaProvider || !textOnlyProvider) {
      throw new Error("VI05 没有完成隔离 provider seed");
    }
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectProviderModel(mediaProvider.id, mediaProvider.name, MEDIA_MODEL);

    await pickV4ComposerFiles([imagePath, videoPath]);
    await waitForReadyAttachments();
    await browser.waitUntil(
      () =>
        browser.execute((filename) => {
          const image = Array.from(
            document.querySelectorAll<HTMLImageElement>(
              '[data-composer-attachment-kind="image"] img[alt]',
            ),
          ).find((candidate) => candidate.alt === filename);
          return Boolean(image?.src.startsWith("blob:"));
        }, imageFilename),
      { timeout: 15_000, timeoutMsg: "VI05 文件输入图片没有显示 Composer 缩略图" },
    );

    const mediaMarker = `E2E_MIXED_MEDIA_PATH_SUPPORTED_${runId}`;
    const mediaPrompt = `${mediaMarker}: inspect the image and video.`;
    await setV4ComposerText(mediaPrompt);
    await clickV4Send();

    const mediaRecord = await waitForUpstreamNetworkCapture(mediaMarker);
    assertUpstreamRequestCapture(mediaRecord, {
      expectedText: mediaPrompt,
      model: MEDIA_MODEL,
    });
    assertMediaCapableProjection(mediaRecord.requestJson, mediaMarker, imagePath, videoPath);
    await waitForV4AssistantMessageContaining(MEDIA_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(MEDIA_REPLY),
      "VI05 mixed-media 首轮没有完成",
      60_000,
    );
    const attachmentText = await waitForV4RowAttachments(60000, [imageFilename]);
    expect(attachmentText).toContain(imageFilename);
    // 视频缩略图是 aria-hidden 的 video，无文件名文本；准确文件名/路径已由实际请求对账。
    // UI 继续验证两张媒体卡及图像、视频各一张，不能只看到第一张图就通过。
    await browser.waitUntil(
      async () =>
        browser.execute((prefix) => {
          const root = document.querySelector(`[data-testid^="${prefix}-"]`);
          const cards = root?.querySelectorAll('[data-v4-user-input-media-attachment="true"]');
          return (
            cards?.length === 2 &&
            root?.querySelectorAll("img").length === 1 &&
            root?.querySelectorAll("video").length === 1
          );
        }, TID_V4_ROW_ATTACHMENTS),
      { timeout: 15000, timeoutMsg: "VI05 消息未展示图片和视频两张缩略卡" },
    );

    await selectProviderModel(textOnlyProvider.id, textOnlyProvider.name, TEXT_ONLY_MODEL);
    const textOnlyMarker = `E2E_MIXED_MEDIA_PATH_TEXT_ONLY_${runId}`;
    const textOnlyPrompt = `${textOnlyMarker}: verify the stripped media history.`;
    await sendV4Prompt(textOnlyPrompt);

    const textOnlyRecord = await waitForUpstreamNetworkCapture(textOnlyMarker);
    assertUpstreamRequestCapture(textOnlyRecord, {
      expectedText: textOnlyPrompt,
      model: TEXT_ONLY_MODEL,
    });
    assertTextOnlyProjection(textOnlyRecord.requestJson, mediaMarker, imagePath, videoPath);
    await waitForV4AssistantMessageContaining(TEXT_ONLY_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(TEXT_ONLY_REPLY),
      "VI05 mixed-media text-only follow-up 没有完成",
      60_000,
    );
  }).timeout(260_000);
});

async function selectProviderModel(providerId: string, providerName: string, modelId: string) {
  await selectUpstreamProviderModelById(modelId, {
    includePlainModelFallback: false,
    providerId,
    providerName,
  });
  await waitForUpstreamModelSelected(modelId, {
    includePlainModelFallback: false,
    providerId,
  });
}

async function waitForReadyAttachments() {
  await browser.waitUntil(
    async () => {
      const attachments = await getV4ComposerAttachments();
      return (
        // image input File 生成媒体预览；video 仍按本机路径显示图标，由 Provider 请求核对路径。
        attachments.length === 2 &&
        attachments[0]?.kind === "image" &&
        attachments[1]?.kind === "video" &&
        attachments.every((attachment) => attachment.uploadStatus === "ready")
      );
    },
    { timeout: 30_000, timeoutMsg: "VI05 图片和视频未按添加顺序全部 ready" },
  );
}

function assertMediaCapableProjection(
  requestJson: unknown,
  marker: string,
  imagePath: string,
  videoPath: string,
) {
  const blocks = findUserContentBlocks(requestJson, marker);
  expect(blocks.map(classifyContentBlock)).toEqual([
    "query",
    "image",
    "video",
    "image-path",
    "video-path",
  ]);
  expect(containsText(blocks, "data:image/png;base64,")).toBe(true);
  expect(containsText(blocks, "data:video/mp4;base64,")).toBe(true);
  assertOrdinaryPathText(requestJson, "image", imagePath);
  assertOrdinaryPathText(requestJson, "video", videoPath);
}

function assertTextOnlyProjection(
  requestJson: unknown,
  marker: string,
  imagePath: string,
  videoPath: string,
) {
  const blocks = findUserContentBlocks(requestJson, marker);
  expect(blocks.map(classifyContentBlock)).toEqual([
    "query",
    "image-omitted",
    "video-omitted",
    "image-path",
    "video-path",
  ]);
  expect(containsText(blocks, IMAGE_OMITTED_TEXT)).toBe(true);
  expect(containsText(blocks, VIDEO_OMITTED_TEXT)).toBe(true);
  expect(containsText(requestJson, "data:image")).toBe(false);
  expect(containsText(requestJson, "data:video")).toBe(false);
  expect(hasProviderVisibleImageBlock(requestJson)).toBe(false);
  expect(hasProviderVisibleVideoBlock(requestJson)).toBe(false);
  assertOrdinaryPathText(requestJson, "image", imagePath);
  assertOrdinaryPathText(requestJson, "video", videoPath);
}

function classifyContentBlock(block: Record<string, unknown>): string {
  const text = readBlockText(block);
  if (readSourcePath(block, IMAGE_SOURCE_PREFIX)) return "image-path";
  if (readSourcePath(block, VIDEO_SOURCE_PREFIX)) return "video-path";
  if (text?.includes(IMAGE_OMITTED_TEXT)) return "image-omitted";
  if (text?.includes(VIDEO_OMITTED_TEXT)) return "video-omitted";
  if (hasProviderVisibleImageBlock(block)) return "image";
  if (hasProviderVisibleVideoBlock(block)) return "video";
  return "query";
}

function assertOrdinaryPathText(requestJson: unknown, type: "image" | "video", path: string) {
  const prefix = type === "image" ? IMAGE_SOURCE_PREFIX : VIDEO_SOURCE_PREFIX;
  const expectedText = `${prefix}${path}]`;
  const allStrings = collectStrings(requestJson);
  expect(isAbsolute(path)).toBe(true);
  expect(allStrings.filter((text) => text === expectedText)).toHaveLength(1);
  expect(
    allStrings.some((text) => text.includes("<system-reminder>") && text.includes(expectedText)),
  ).toBe(false);
}

function readSourcePath(block: Record<string, unknown>, prefix: string): string | undefined {
  const text = readBlockText(block);
  if (!text?.startsWith(prefix) || !text.endsWith("]")) return undefined;
  return text.slice(prefix.length, -1);
}

function findUserContentBlocks(requestJson: unknown, marker: string): Record<string, unknown>[] {
  const request = readRecord(requestJson);
  const messages = readRecordArray(request.messages);
  const message = messages.find(
    (candidate) =>
      candidate.role === "user" &&
      Array.isArray(candidate.content) &&
      containsText(candidate.content, marker),
  );
  if (!message) throw new Error(`没有找到包含 ${marker} 的 provider-visible user message`);
  return readRecordArray(message.content);
}

function hasProviderVisibleImageBlock(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProviderVisibleImageBlock);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "image_url") return true;
  return Object.values(record).some(hasProviderVisibleImageBlock);
}

function hasProviderVisibleVideoBlock(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProviderVisibleVideoBlock);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "video" || record.type === "video_url") return true;
  return Object.values(record).some(hasProviderVisibleVideoBlock);
}

function readBlockText(block: Record<string, unknown>): string | undefined {
  return typeof block.text === "string" ? block.text : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`期望 object，实际为 ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`期望 array，实际为 ${JSON.stringify(value)}`);
  return value.map(readRecord);
}

function containsText(value: unknown, expected: string): boolean {
  return collectStrings(value).some((text) => text.includes(expected));
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStrings);
}
