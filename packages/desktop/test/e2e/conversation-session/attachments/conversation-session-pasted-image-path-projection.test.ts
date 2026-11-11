import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { readdir, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { clearAppData, getE2EAppDataPaths, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
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
import {
  readLastSelectedAgentConfig,
  restartIntoWorkspacePreservingProfile,
} from "#e2e/helpers/model-provider-restart";
import { getTaskStoreSnapshot } from "#e2e/helpers/conversation-session-store";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  clickV4Send,
  pasteV4ComposerImageAttachment,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  setV4ComposerText,
  getV4ModelConfig,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
  waitForV4RowAttachments,
} from "#e2e/helpers/v4-conversation";
import { ensureProjectExpanded } from "#e2e/helpers/project-sidebar";

const CASE_NAME = "conversation-session-pasted-image-path-projection";
const VISION_MODEL = "e2e-pasted-image-vision-model";
const VISION_PROVIDER_ID = "e2e-pasted-image-vision";
const VISION_PROVIDER_NAME = "Pasted Image Vision E2E";
const TEXT_ONLY_MODEL = UPSTREAM_MODEL;
const TEXT_ONLY_PROVIDER_ID = "e2e-pasted-image-text-only";
const TEXT_ONLY_PROVIDER_NAME = "Pasted Image Text Only E2E";
const LIVE_REPLY = "E2E_PASTED_IMAGE_PATH_LIVE_OK";
const PARKING_REPLY = "E2E_PASTED_IMAGE_PATH_PARKING_OK";
const COLD_REPLY = "E2E_PASTED_IMAGE_PATH_COLD_OK";
const TEXT_ONLY_REPLY = "E2E_PASTED_IMAGE_PATH_TEXT_ONLY_OK";
const IMAGE_OMITTED_TEXT =
  "Media omitted from provider request because the selected model does not support image input.";
const IMAGE_SOURCE_PREFIX = "[Image: source: ";
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";
const paths = getE2EAppDataPaths();
const imageCacheRoot = join(paths.homeDir, ".zcode", "cli", "image-cache");

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("粘贴图片 provider path 投影 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(CASE_NAME);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  // 修复原因：WDIO wrapper 会在进入 test body 前读取 Mocha Runnable timeout；
  // body 内调用 this.timeout() 已经太晚，必须在返回的 Test 上设置。
  it("T12-T14: image + path live，多图有序，冷恢复重建，text-only 保留 path", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    const [visionProvider, textOnlyProvider] = await restartWithSeededOpenAIProviders([
      {
        inputModalities: ["text", "image"],
        modelId: VISION_MODEL,
        providerId: VISION_PROVIDER_ID,
        providerName: VISION_PROVIDER_NAME,
      },
      {
        // 自定义 provider 的默认 text modality 按 unknown 处理；使用已有明确 text-only
        // default policy，确保这里真正覆盖 inputFormat.supportsImage=false。
        inputModalities: ["text"],
        modelId: TEXT_ONLY_MODEL,
        providerId: TEXT_ONLY_PROVIDER_ID,
        providerName: TEXT_ONLY_PROVIDER_NAME,
      },
    ]);
    if (!visionProvider || !textOnlyProvider) {
      throw new Error("T12-T14 没有完成隔离 provider seed");
    }
    await prepareV4ConversationE2E({ skipProvider: true });
    // Recent 按项目隔离；首轮与 parking 必须从同一个项目创建，不能混用未选项目的启动草稿。
    await openWorkspaceDraftFromSidebar(paths.workspace);
    await selectProviderModel(visionProvider.id, VISION_PROVIDER_NAME, VISION_MODEL);

    const runId = Date.now();
    const firstFilename = `e2e-pasted-path-first-${runId}.png`;
    const secondFilename = `e2e-pasted-path-second-${runId}.png`;
    const liveMarker = `E2E_PASTED_IMAGE_PATH_LIVE_${runId}`;
    const livePrompt = `${liveMarker}: inspect both pasted images.`;
    const derivedBeforePaste = new Set(await listDerivedImagePaths());

    await setV4ComposerText(livePrompt);
    await pasteV4ComposerImageAttachment(firstFilename, { pngBase64: VALID_PNG_BASE64 });
    await pasteV4ComposerImageAttachment(secondFilename, { pngBase64: VALID_PNG_BASE64 });

    // 回归原因：paste commit 后会 fire-and-forget prime；这里在发送前直接观察磁盘，
    // 证明 eager 行为本身成立，而不是把 send-time ensure 误当成 eager 成功。
    const eagerPaths = await waitForNewDerivedImagePaths(derivedBeforePaste, 2);
    await clickV4Send();

    const liveRecord = await waitForUpstreamNetworkCapture(liveMarker);
    assertUpstreamRequestCapture(liveRecord, {
      expectedText: livePrompt,
      model: VISION_MODEL,
    });
    const liveProjection = assertImageCapableProjection(liveRecord.requestJson, liveMarker, 2);
    expect(new Set(liveProjection.paths)).toEqual(new Set(eagerPaths));
    await assertMaterializedImagePaths(liveProjection.paths);

    await waitForV4AssistantMessageContaining(LIVE_REPLY, 60_000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(LIVE_REPLY),
      "粘贴图片首轮没有完成并绑定 session",
      60_000,
    );
    const sessionId = completed.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`粘贴图片 path case 缺少真实 sessionId: ${sessionId ?? "null"}`);
    }
    const liveAttachmentText = await waitForV4RowAttachments();
    expect(liveAttachmentText).toContain(firstFilename);
    expect(liveAttachmentText).toContain(secondFilename);

    const persistedVisionConfig = await readLastSelectedAgentConfig();
    expect(persistedVisionConfig?.model).toContain(visionProvider.id);
    const liveStoreSnapshot = await getTaskStoreSnapshot(sessionId);
    expect(liveStoreSnapshot.activeTaskId).toBe(sessionId);
    // 模型选择由 Composer Draft 持有；CLI configOptions 只保留模式，不再承载模型。
    expect((await getV4ModelConfig()).provider).toBe(visionProvider.id);
    expect((await getV4ModelConfig()).model).toBe(VISION_MODEL);

    // 冷恢复必须从另一个已持久会话进入；仅切到 deferred draft 后立即重启会中断
    // task-index 回源，无法证明目标 session 的真实 cold resume。
    await openWorkspaceDraftFromSidebar(paths.workspace);
    await waitForV4ComposerSelectionReady();
    // initialDraft* 是 legacy 初始化诊断；发送选择的权威是当前 Composer。
    const inheritedDraftConfig = await getV4ModelConfig();
    expect(inheritedDraftConfig.provider).toBe(visionProvider.id);
    expect(inheritedDraftConfig.model).toBe(VISION_MODEL);
    const parkingMarker = `E2E_PASTED_IMAGE_PATH_PARKING_${runId}`;
    await sendV4Prompt(`${parkingMarker}: park before cold resume.`);
    await waitForV4AssistantMessageContaining(PARKING_REPLY, 60_000);
    const parking = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== sessionId &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(PARKING_REPLY),
      "图片 path cold resume 的 parking session 没有完成",
      60_000,
    );
    expect(parking.sessionId).not.toBe(sessionId);

    await Promise.all(liveProjection.paths.map((path) => unlink(path)));
    await restartIntoWorkspacePreservingProfile();
    await waitForWorkspaceApp(paths.workspace, 60_000);
    await ensureProjectExpanded(paths.workspace);
    await selectV4TaskById(sessionId, 60_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && snapshot.timelineText.includes(LIVE_REPLY),
      `冷启动后没有恢复粘贴图片 session ${sessionId}`,
      60_000,
    );
    const coldAttachmentText = await waitForV4RowAttachments();
    expect(coldAttachmentText).toContain(firstFilename);
    expect(coldAttachmentText).toContain(secondFilename);
    await waitForUpstreamModelSelected(VISION_MODEL, {
      includePlainModelFallback: false,
      providerId: visionProvider.id,
    });

    const coldMarker = `E2E_PASTED_IMAGE_PATH_COLD_${runId}`;
    const coldPrompt = `${coldMarker}: verify the restored image history.`;
    await sendV4Prompt(coldPrompt);
    const coldRecord = await waitForUpstreamNetworkCapture(coldMarker);
    assertUpstreamRequestCapture(coldRecord, {
      expectedText: coldPrompt,
      model: VISION_MODEL,
    });
    const coldProjection = assertImageCapableProjection(coldRecord.requestJson, liveMarker, 2);
    expect(coldProjection.blocks).toEqual(liveProjection.blocks);
    expect(coldProjection.paths).toEqual(liveProjection.paths);
    await assertMaterializedImagePaths(coldProjection.paths);
    await waitForV4AssistantMessageContaining(COLD_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(COLD_REPLY),
      "粘贴图片 cold follow-up 没有完成",
      60_000,
    );

    await selectProviderModel(textOnlyProvider.id, TEXT_ONLY_PROVIDER_NAME, TEXT_ONLY_MODEL);
    const textOnlyMarker = `E2E_PASTED_IMAGE_PATH_TEXT_ONLY_${runId}`;
    const textOnlyPrompt = `${textOnlyMarker}: verify text-only history projection.`;
    await sendV4Prompt(textOnlyPrompt);
    const textOnlyRecord = await waitForUpstreamNetworkCapture(textOnlyMarker);
    assertUpstreamRequestCapture(textOnlyRecord, {
      expectedText: textOnlyPrompt,
      model: TEXT_ONLY_MODEL,
    });
    assertTextOnlyProjection(textOnlyRecord.requestJson, liveMarker, liveProjection.paths);
    await waitForV4AssistantMessageContaining(TEXT_ONLY_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(TEXT_ONLY_REPLY),
      "粘贴图片 text-only follow-up 没有完成",
      60_000,
    );
  }).timeout(360_000);
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

function assertImageCapableProjection(
  requestJson: unknown,
  marker: string,
  expectedImageCount: number,
) {
  const blocks = findUserContentBlocks(requestJson, marker);
  const kinds = blocks.map(classifyContentBlock);
  const expectedKinds = [
    "query",
    ...Array.from({ length: expectedImageCount }, () => "image"),
    ...Array.from({ length: expectedImageCount }, () => "path"),
  ];
  expect(kinds).toEqual(expectedKinds);
  const paths = blocks.flatMap((block) => {
    const path = readImageSourcePath(block);
    return path ? [path] : [];
  });
  expect(paths).toHaveLength(expectedImageCount);
  expect(containsText(blocks, "data:image")).toBe(true);
  assertOrdinaryUserPathTexts(requestJson, paths);
  return { blocks, paths };
}

function assertTextOnlyProjection(requestJson: unknown, marker: string, expectedPaths: string[]) {
  const blocks = findUserContentBlocks(requestJson, marker);
  expect(blocks.map(classifyContentBlock)).toEqual([
    "query",
    ...Array.from({ length: expectedPaths.length }, () => "omitted"),
    ...Array.from({ length: expectedPaths.length }, () => "path"),
  ]);
  expect(blocks.filter((block) => readBlockText(block)?.includes(IMAGE_OMITTED_TEXT))).toHaveLength(
    expectedPaths.length,
  );
  expect(blocks.flatMap((block) => readImageSourcePath(block) ?? [])).toEqual(expectedPaths);
  expect(containsText(requestJson, "data:image")).toBe(false);
  expect(hasProviderVisibleImageBlock(requestJson)).toBe(false);
  assertOrdinaryUserPathTexts(requestJson, expectedPaths);
}

function assertOrdinaryUserPathTexts(requestJson: unknown, imagePaths: string[]) {
  const allStrings = collectStrings(requestJson);
  for (const imagePath of imagePaths) {
    const expectedText = `${IMAGE_SOURCE_PREFIX}${imagePath}]`;
    expect(isAbsolute(imagePath)).toBe(true);
    expect(allStrings.filter((text) => text === expectedText)).toHaveLength(1);
    expect(
      allStrings.some((text) => text.includes("<system-reminder>") && text.includes(expectedText)),
    ).toBe(false);
  }
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
  if (!message) {
    throw new Error(`没有找到包含 ${marker} 的 provider-visible user message`);
  }
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
  if (!Array.isArray(value)) {
    throw new Error(`期望 array，实际为 ${JSON.stringify(value)}`);
  }
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

async function waitForNewDerivedImagePaths(
  previousPaths: ReadonlySet<string>,
  expectedCount: number,
) {
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      latest = (await listDerivedImagePaths()).filter((path) => !previousPaths.has(path));
      return latest.length === expectedCount;
    },
    {
      timeout: 30_000,
      timeoutMsg: `paste eager 没有物化 ${expectedCount} 个派生图片文件，latest=${latest.join(",")}`,
    },
  );
  return latest.sort();
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

async function assertMaterializedImagePaths(imagePaths: string[]) {
  for (const imagePath of imagePaths) {
    const relativePath = relative(imageCacheRoot, imagePath);
    expect(relativePath.startsWith(`..${sep}`) || relativePath === "..").toBe(false);
    expect(basename(imagePath)).toMatch(/^image-[a-f0-9]{32}\.(?:gif|jpe?g|png|webp)$/u);
    expect((await stat(imagePath)).isFile()).toBe(true);
  }
}
