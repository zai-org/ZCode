import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_ERROR_BANNER,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
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
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  clickV4Send,
  pasteV4ComposerImageAttachment,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-pasted-image-path-edge-cases";
const UNKNOWN_MODEL = "e2e-image-unknown-capability-model";
const VISION_MODEL = "e2e-image-edge-vision-model";
const TEXT_ONLY_MODEL = UPSTREAM_MODEL;
const FAILURE_SEED_REPLY = "E2E_PASTED_IMAGE_EDGE_FAILURE_SEED_OK";
const BMP_IMAGE_REPLY = "E2E_PASTED_IMAGE_EDGE_BMP_IMAGE_OK";
const BMP_TEXT_REPLY = "E2E_PASTED_IMAGE_EDGE_BMP_TEXT_OK";
const IMAGE_OMITTED_TEXT =
  "Media omitted from provider request because the selected model does not support image input.";
const IMAGE_SOURCE_PREFIX = "[Image: source: ";
const MATERIALIZATION_ERROR = "Unable to materialize image attachment path";
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";
// 1x1 24-bit BMP。Jimp/provider 链路可解码，但派生缓存故意不支持 image/bmp。
const VALID_BMP_BASE64 =
  "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAAAAD/AA==";
const artifactRoot = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "artifacts");
const imageCacheRoot = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "image-cache");

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("粘贴图片 path 投影边界 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(CASE_NAME);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("T15: 缺失输入能力的模型不可进入 App 可执行模型菜单", async () => {
    const runId = Date.now();
    await prepareV4ConversationE2E({ skipProvider: true });
    const [unknown, vision] = await restartWithSeededOpenAIProviders([
      {
        inputModalities: null,
        modelId: UNKNOWN_MODEL,
        providerId: `e2e-image-edge-unknown-${runId}`,
        providerName: `Image Edge Unknown E2E ${runId}`,
      },
      {
        inputModalities: ["text", "image"],
        modelId: VISION_MODEL,
        providerId: `e2e-image-edge-known-${runId}`,
        providerName: `Image Edge Known E2E ${runId}`,
      },
    ]);
    if (!unknown || !vision) throw new Error("T15 provider fixture 缺失");
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectProviderModel(vision.id, vision.name, VISION_MODEL);
    await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).click();
    // Registry 要求完整能力；先确认同批有效配置已水合，再断言缺失配置没有可执行入口。
    const knownItem = testId(
      TID_CHAT_MODEL_SELECT_ITEM,
      encodeCustomModelValue(vision.id, VISION_MODEL),
    );
    await $(`[data-testid="${knownItem}"]`).waitForExist({ timeout: 15000 });
    const unknownItem = testId(
      TID_CHAT_MODEL_SELECT_ITEM,
      encodeCustomModelValue(unknown.id, UNKNOWN_MODEL),
    );
    expect(await $(`[data-testid="${unknownItem}"]`).isExisting()).toBe(false);
    await browser.keys("Escape");
  }).timeout(180_000);

  it("T16: 派生文件与 durable artifact 都丢失时应在 provider 前明确失败", async () => {
    const runId = Date.now();
    await seedProvider({
      inputModalities: ["text", "image"],
      modelId: VISION_MODEL,
      providerId: `e2e-image-edge-failure-${runId}`,
      providerName: `Image Edge Failure E2E ${runId}`,
    });

    const seedMarker = `E2E_PASTED_IMAGE_EDGE_FAILURE_SEED_${runId}`;
    const seedPrompt = `${seedMarker}: persist this image before the failure check.`;
    await setV4ComposerText(seedPrompt);
    await pasteV4ComposerImageAttachment(`materialization-failure-${runId}.png`, {
      base64: VALID_PNG_BASE64,
      mimeType: "image/png",
    });
    await clickV4Send();

    const seedRecord = await waitForUpstreamNetworkCapture(seedMarker);
    assertUpstreamRequestCapture(seedRecord, {
      expectedText: seedPrompt,
      model: VISION_MODEL,
    });
    const derivedPath = assertImageAndOptionalPathProjection(seedRecord.requestJson, seedMarker, {
      expectedImageDataPrefix: "data:image/png;base64,",
      expectPath: true,
    });
    if (!derivedPath) throw new Error("T16 seed 请求缺少派生图片 path");
    await waitForV4AssistantMessageContaining(FAILURE_SEED_REPLY, 60_000);
    const completed = await waitForIdleWithText(
      FAILURE_SEED_REPLY,
      "T16 failure seed 首轮没有完成",
    );
    const sessionId = completed.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`T16 failure seed 缺少真实 sessionId: ${sessionId ?? "null"}`);
    }

    const durablePath = await findDurableImageArtifact(derivedPath, "data:image/png;base64,");
    await Promise.all([unlink(derivedPath), unlink(durablePath)]);
    await expectPathMissing(derivedPath);
    await expectPathMissing(durablePath);

    const failureMarker = `E2E_PASTED_IMAGE_EDGE_FAILURE_FOLLOWUP_${runId}`;
    const failurePrompt = `${failureMarker}: this request must fail before provider dispatch.`;
    const requestsBefore = await countUpstreamRequestsContaining(failureMarker);
    await sendV4Prompt(failurePrompt);
    const errorText = await waitForChatErrorContaining(MATERIALIZATION_ERROR);
    expect(errorText).toContain(MATERIALIZATION_ERROR);
    const failed = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === sessionId &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(failureMarker),
      "T16 materialization failure 没有保留 user row 并回到非运行态",
      60_000,
    );
    expect(failed.sessionId).toBe(sessionId);
    await browser.pause(1_000);
    expect(await countUpstreamRequestsContaining(failureMarker)).toBe(requestsBefore);
  }).timeout(210_000);

  it("T17: unsupported BMP cache 在 image-capable/text-only 下都应 best effort 继续", async () => {
    const runId = Date.now();
    await prepareV4ConversationE2E({ skipProvider: true });
    const [visionProvider, textProvider] = await restartWithSeededOpenAIProviders([
      {
        inputModalities: ["text", "image"],
        modelId: VISION_MODEL,
        providerId: `e2e-image-edge-bmp-vision-${runId}`,
        providerName: `Image Edge BMP Vision E2E ${runId}`,
      },
      {
        inputModalities: ["text"],
        modelId: TEXT_ONLY_MODEL,
        providerId: `e2e-image-edge-bmp-text-${runId}`,
        providerName: `Image Edge BMP Text E2E ${runId}`,
      },
    ]);
    if (!visionProvider || !textProvider) {
      throw new Error("T17 没有完成隔离 provider seed");
    }
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectProviderModel(visionProvider.id, visionProvider.name, VISION_MODEL);

    const derivedBefore = new Set(await listDerivedImagePaths());
    const imageMarker = `E2E_PASTED_IMAGE_EDGE_BMP_IMAGE_${runId}`;
    const imagePrompt = `${imageMarker}: keep the BMP image without a derived path.`;
    await setV4ComposerText(imagePrompt);
    await pasteV4ComposerImageAttachment(`unsupported-cache-${runId}.bmp`, {
      base64: VALID_BMP_BASE64,
      mimeType: "image/bmp",
    });
    await clickV4Send();

    const imageRecord = await waitForUpstreamNetworkCapture(imageMarker);
    assertUpstreamRequestCapture(imageRecord, {
      expectedText: imagePrompt,
      model: VISION_MODEL,
    });
    assertImageAndOptionalPathProjection(imageRecord.requestJson, imageMarker, {
      expectedImageDataPrefix: "data:image/bmp;base64,",
      expectPath: false,
    });
    expect(new Set(await listDerivedImagePaths())).toEqual(derivedBefore);
    await waitForV4AssistantMessageContaining(BMP_IMAGE_REPLY, 60_000);
    await waitForIdleWithText(BMP_IMAGE_REPLY, "T17 BMP image-capable 首轮没有完成");

    await selectProviderModel(textProvider.id, textProvider.name, TEXT_ONLY_MODEL);
    const textMarker = `E2E_PASTED_IMAGE_EDGE_BMP_TEXT_${runId}`;
    const textPrompt = `${textMarker}: preserve only the omitted notice.`;
    await sendV4Prompt(textPrompt);
    const textRecord = await waitForUpstreamNetworkCapture(textMarker);
    assertUpstreamRequestCapture(textRecord, {
      expectedText: textPrompt,
      model: TEXT_ONLY_MODEL,
    });
    assertUnsupportedTextOnlyProjection(textRecord.requestJson, imageMarker);
    expect(new Set(await listDerivedImagePaths())).toEqual(derivedBefore);
    await waitForV4AssistantMessageContaining(BMP_TEXT_REPLY, 60_000);
    await waitForIdleWithText(BMP_TEXT_REPLY, "T17 BMP text-only follow-up 没有完成");
  }).timeout(240_000);
});

async function seedProvider(input: {
  inputModalities?: readonly ("text" | "image")[];
  modelId: string;
  providerId: string;
  providerName: string;
}) {
  await prepareV4ConversationE2E({ skipProvider: true });
  const [provider] = await restartWithSeededOpenAIProviders([input]);
  if (!provider) {
    throw new Error(`没有完成隔离 provider seed: ${input.providerName}`);
  }
  await prepareV4ConversationE2E({ skipProvider: true });
  await selectProviderModel(provider.id, input.providerName, input.modelId);
}

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

function assertImageAndOptionalPathProjection(
  requestJson: unknown,
  marker: string,
  options: { expectedImageDataPrefix: string; expectPath: boolean },
): string | undefined {
  const blocks = findUserContentBlocks(requestJson, marker);
  expect(blocks.map(classifyContentBlock)).toEqual(
    options.expectPath ? ["query", "image", "path"] : ["query", "image"],
  );
  expect(containsText(blocks, options.expectedImageDataPrefix)).toBe(true);
  const paths = blocks.flatMap((block) => readImageSourcePath(block) ?? []);
  expect(paths).toHaveLength(options.expectPath ? 1 : 0);
  if (paths[0]) assertOrdinaryUserPathText(requestJson, paths[0]);
  if (!options.expectPath) expect(containsText(requestJson, IMAGE_SOURCE_PREFIX)).toBe(false);
  return paths[0];
}

function assertUnsupportedTextOnlyProjection(requestJson: unknown, marker: string) {
  const blocks = findUserContentBlocks(requestJson, marker);
  expect(blocks.map(classifyContentBlock)).toEqual(["query", "omitted"]);
  expect(blocks.filter((block) => readBlockText(block)?.includes(IMAGE_OMITTED_TEXT))).toHaveLength(
    1,
  );
  expect(hasProviderVisibleImageBlock(requestJson)).toBe(false);
  expect(containsText(requestJson, "data:image")).toBe(false);
  expect(containsText(requestJson, IMAGE_SOURCE_PREFIX)).toBe(false);
}

function assertOrdinaryUserPathText(requestJson: unknown, imagePath: string) {
  const expectedText = `${IMAGE_SOURCE_PREFIX}${imagePath}]`;
  const allStrings = collectStrings(requestJson);
  expect(allStrings.filter((text) => text === expectedText)).toHaveLength(1);
  expect(
    allStrings.some((text) => text.includes("<system-reminder>") && text.includes(expectedText)),
  ).toBe(false);
}

function classifyContentBlock(block: Record<string, unknown>): string {
  const text = readBlockText(block);
  if (readImageSourcePath(block)) return "path";
  if (text?.includes(IMAGE_OMITTED_TEXT)) return "omitted";
  if (hasProviderVisibleImageBlock(block)) return "image";
  return "query";
}

function readImageSourcePath(block: Record<string, unknown>): string | undefined {
  const text = readBlockText(block);
  if (!text?.startsWith(IMAGE_SOURCE_PREFIX) || !text.endsWith("]")) return undefined;
  return text.slice(IMAGE_SOURCE_PREFIX.length, -1);
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
  if (typeof record.image_url === "string") return true;
  return Object.values(record).some(hasProviderVisibleImageBlock);
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

async function findDurableImageArtifact(derivedPath: string, expectedPrefix: string) {
  const durableSessionDir = join(artifactRoot, basename(dirname(derivedPath)));
  const entries = await readdir(durableSessionDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = join(durableSessionDir, entry.name);
    const content = await readFile(candidate, "utf8").catch(() => "");
    if (content.startsWith(expectedPrefix)) return candidate;
  }
  throw new Error(`T16 没有在 ${durableSessionDir} 找到 durable image data URL artifact`);
}

async function expectPathMissing(path: string) {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function waitForChatErrorContaining(expected: string) {
  await waitForTestIdByDom(TID_CHAT_ERROR_BANNER, {
    timeout: 60_000,
    timeoutMsg: `没有显示附件物化错误: ${expected}`,
  });
  let latest = "";
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (testId) =>
          document
            .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
            ?.innerText.replace(/\u00a0/g, " ") ?? "",
        TID_CHAT_ERROR_BANNER,
      );
      return latest.includes(expected);
    },
    {
      timeout: 30_000,
      timeoutMsg: `错误横幅没有包含 ${expected}; latest=${latest}`,
    },
  );
  return latest;
}

async function waitForIdleWithText(text: string, timeoutMsg: string) {
  return waitForV4Pane(
    (snapshot) =>
      snapshot.sessionId !== null &&
      snapshot.sessionId !== "draft" &&
      !snapshot.canStop &&
      snapshot.timelineText.includes(text),
    timeoutMsg,
    60_000,
  );
}

async function listDerivedImagePaths(root = imageCacheRoot): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return listDerivedImagePaths(path);
      return entry.isFile() && /^image-[a-f0-9]{32}\.(?:gif|jpe?g|png|webp)$/u.test(entry.name)
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}
