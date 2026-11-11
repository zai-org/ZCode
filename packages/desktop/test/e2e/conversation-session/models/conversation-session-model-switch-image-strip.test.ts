import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import { restartWithSeededOpenAIProviders } from "#e2e/helpers/custom-openai-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  pickV4ComposerFiles,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4RowAttachments,
} from "#e2e/helpers/v4-conversation";

const VISION_SEED_MODEL = "e2e-vision-seed-model";
const GLM52_MODEL = "GLM-5.2";
const VISION_SEED_PROVIDER_ID_PREFIX = "e2e-image-seed";
const GLM52_PROVIDER_NAME_PREFIX = "GLM 5.2 Image Strip E2E";
const SEED_PROVIDER_NAME_PREFIX = "Image Seed E2E";
const GLM52_PROVIDER_ID_PREFIX = "e2e-glm52-image-strip";
const E2E_REPLY_TOKEN = "upstream-e2e-ok";
const IMAGE_OMITTED_TEXT =
  "Media omitted from provider request because the selected model does not support image input.";
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("会话区模型切换图片输入 strip E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(
      "conversation-session-model-switch-image-strip",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  // 修复原因：WDIO wrapper 会在进入 test body 前读取 Mocha Runnable timeout；
  // body 内调用 this.timeout() 已经太晚，必须在返回的 Test 上设置。
  it("N08: completed 历史含图片后切到第三方 GLM，应在 provider 请求前替换图片为 placeholder", async () => {
    const runId = Date.now();
    const imageFilename = `model-switch-image-strip-${runId}.png`;
    const imageLocalPath = join(DEFAULT_WORKSPACE, imageFilename);
    const seedProviderId = `${VISION_SEED_PROVIDER_ID_PREFIX}-${runId}`;
    const seedProviderName = `${SEED_PROVIDER_NAME_PREFIX} ${runId}`;
    const providerId = `${GLM52_PROVIDER_ID_PREFIX}-${runId}`;
    const providerName = `${GLM52_PROVIDER_NAME_PREFIX} ${runId}`;
    // 修复原因：WDIO beforeSession 已经给每个 spec 准备隔离 HOME；
    // case 运行中再次 clearAppData 会 quit 当前 Electron，后续 WebDriver 只剩失效 session。
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await writeFile(imageLocalPath, Buffer.from(VALID_PNG_BASE64, "base64"));
    const [seedProvider, provider] = await restartWithSeededOpenAIProviders([
      {
        inputModalities: ["text", "image"],
        modelId: VISION_SEED_MODEL,
        providerId: seedProviderId,
        providerName: seedProviderName,
      },
      {
        inputModalities: ["text"],
        modelId: GLM52_MODEL,
        providerId,
        providerName,
      },
    ]);
    if (!seedProvider || !provider) {
      throw new Error("图片 strip case 没有完成隔离 provider seed");
    }
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await selectUpstreamProviderModelById(VISION_SEED_MODEL, {
      includePlainModelFallback: false,
      providerId: seedProvider.id,
      providerName: seedProviderName,
    });
    await waitForUpstreamModelSelected(VISION_SEED_MODEL, {
      includePlainModelFallback: false,
      providerId: seedProvider.id,
    });

    const seedMarker = `E2E_MODEL_SWITCH_IMAGE_SEED_${runId}`;
    const seedPrompt = `${seedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await pickV4ComposerFiles([imageLocalPath]);
    await setV4ComposerText(seedPrompt);
    await clickV4Send();

    const seedRecord = await waitForUpstreamNetworkCapture(seedMarker);
    assertUpstreamRequestCapture(seedRecord, {
      expectedText: seedPrompt,
      model: VISION_SEED_MODEL,
    });
    expect(hasProviderVisibleImageBlock(seedRecord.requestJson)).toBe(true);
    assertImagePathProjection(seedRecord.requestJson, seedMarker, imageLocalPath);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 60_000);
    const attachmentText = await waitForV4RowAttachments();
    expect(attachmentText).toContain(imageFilename);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(E2E_REPLY_TOKEN),
      "图片 strip case 首轮完成后没有回到 idle",
      90_000,
    );

    await selectUpstreamProviderModelById(GLM52_MODEL, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName,
    });
    await waitForUpstreamModelSelected(GLM52_MODEL, {
      includePlainModelFallback: false,
      providerId: provider.id,
    });

    const followupMarker = `E2E_MODEL_SWITCH_IMAGE_FOLLOWUP_${runId}`;
    const followupPrompt = `${followupMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(followupPrompt);

    const followupRecord = await waitForUpstreamNetworkCapture(followupMarker);
    assertUpstreamRequestCapture(followupRecord, {
      expectedText: followupPrompt,
      model: GLM52_MODEL,
    });
    assertHistoricalImageStripped(
      followupRecord.requestJson,
      seedMarker,
      imageFilename,
      imageLocalPath,
    );

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(followupMarker),
      "图片 strip case GLM follow-up 完成后没有回到 idle",
      90_000,
    );
  }).timeout(260_000);
});

function assertHistoricalImageStripped(
  requestJson: unknown,
  seedMarker: string,
  imageFilename: string,
  imageLocalPath: string,
) {
  expect(containsText(requestJson, "[Attached image/png:")).toBe(true);
  expect(containsText(requestJson, imageFilename)).toBe(true);
  expect(containsText(requestJson, IMAGE_OMITTED_TEXT)).toBe(true);
  expect(containsText(requestJson, "data:image")).toBe(false);
  expect(hasProviderVisibleImageBlock(requestJson)).toBe(false);
  assertImagePathProjection(requestJson, seedMarker, imageLocalPath);
}

function assertImagePathProjection(
  requestJson: unknown,
  userMarker: string,
  imageLocalPath: string,
) {
  const expectedPathText = `[Image: source: ${imageLocalPath}]`;
  const content = findUserContentBlocks(requestJson, userMarker);
  const pathIndexes = content.flatMap((block, index) =>
    readBlockText(block) === expectedPathText ? [index] : [],
  );

  expect(isAbsolute(imageLocalPath)).toBe(true);
  expect(pathIndexes).toEqual([content.length - 1]);
  expect(collectStrings(requestJson).filter((text) => text === expectedPathText)).toHaveLength(1);
  expect(
    collectStrings(requestJson).some(
      (text) => text.includes("<system-reminder>") && text.includes(expectedPathText),
    ),
  ).toBe(false);
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
  if (!message) {
    throw new Error(`没有找到包含 ${marker} 的 provider-visible user message`);
  }
  return readRecordArray(message.content);
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
  if (!Array.isArray(value)) {
    throw new Error(`期望 array，实际为 ${JSON.stringify(value)}`);
  }
  return value.map(readRecord);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStrings);
}

function hasProviderVisibleImageBlock(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasProviderVisibleImageBlock);
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "image_url") {
    return true;
  }
  if (typeof record.image_url === "string") {
    return true;
  }
  if (
    record.image_url &&
    typeof record.image_url === "object" &&
    containsText(record.image_url, "data:image")
  ) {
    return true;
  }
  return Object.values(record).some(hasProviderVisibleImageBlock);
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
