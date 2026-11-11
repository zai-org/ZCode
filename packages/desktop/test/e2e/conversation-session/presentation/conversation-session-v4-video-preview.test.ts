// VI06 + VI07 门禁：媒体卡片、共享 gallery、本地路径/分片预览、失败重开与 edit 原始索引。
// 证据层 L3：
// 1) Composer 与 sent 消息都按原顺序渲染 image/video grid card，video 共享播放角标；
// 2) 图片与视频进入同一个 gallery，并通过按钮/方向键首尾循环，图片工具与视频 controls 隔离；
// 3) Desktop sent video 优先播放 artifact/local_ref 路径，非 fast-start MP4 也支持 seek，无可用路径时走 artifact 分片；
// 4) 不可解码视频保留 gallery 导航/重开，edit 与完整进程重启后仍按持久化原始序号预览。
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TID_V4_ATTACHMENT, TID_V4_ROW_ATTACHMENTS } from "@zcode/shared/test-ids";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import { removeV4ComposerAttachmentAt } from "#e2e/helpers/v4-composer-edit";
import {
  beginFirstV4UserQueryEdit,
  clickV4Send,
  pasteV4ComposerFileAttachment,
  pasteV4ComposerImageAttachment,
  pickV4ComposerFiles,
  prepareV4ConversationE2E,
  selectV4TaskById,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", "conversation-session-v4-video-preview");
const PLAYABLE_VIDEO_FILENAME = "e2e-composer-preview.mp4";
const GALLERY_IMAGE_FILENAME = "e2e-gallery-image.png";
const UNSUPPORTED_VIDEO_FILENAME = "e2e-unsupported.mov";
const LARGE_VIDEO_FILENAME = "e2e-sent-large.mp4";
const CHUNK_FALLBACK_VIDEO_FILENAME = "e2e-chunk-fallback.ogg";
const VIDEO_SOURCE_PATH = fileURLToPath(
  new URL("../../fixtures/media/sample-video.mp4", import.meta.url),
);
const MEDIA_KINDS = ["video", "image", "video", "video", "video"] as const;

type MediaKind = "image" | "video";

type MediaCardState = {
  height: number;
  kind: MediaKind;
  role: string | null;
  src: string;
  uploadStatus: string | null;
  width: number;
};

type GalleryState = {
  alertText: string;
  alt: string;
  autoplay: boolean;
  controls: boolean;
  error: boolean;
  hasImageTools: boolean;
  hasNavigation: boolean;
  kind: "image" | "none" | "video";
  playsInline: boolean;
  readyState: number;
  src: string;
  title: string;
};

describe("v4 VI06/VI07：image/video 媒体 gallery 与 edit", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  it("混合媒体首发 → sent gallery/reopen → edit 索引/删除", async () => {
    await prepareV4ConversationE2E();
    // Bug 根因：旧 E2E 只使用 moov 在 mdat 前的 fast-start MP4，无法触发自定义
    // scheme 对文件尾元数据的读取；改用同一可播 fixture 的尾部 moov 形态覆盖真实回归。
    const sourceVideo = moveMoovBoxBehindMediaData(await readFile(VIDEO_SOURCE_PATH));
    const playableVideoPath = join(CASE_ROOT, PLAYABLE_VIDEO_FILENAME);
    const largeVideoPath = join(CASE_ROOT, LARGE_VIDEO_FILENAME);
    await mkdir(CASE_ROOT, { recursive: true });
    await createSparseLargePlayableMp4(largeVideoPath, sourceVideo);
    await writeFile(playableVideoPath, sourceVideo);

    // 合成的 new File 没有磁盘路径，无法命中共享入口错误剥离本地媒体预览的分支。
    await browser.execute(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "e2e-local-video-drop";
      // 修复原因：body 与 #root 都是 overflow: hidden，追加在 #root 之后的 input 正好落在
      // 视口下沿，chromedriver 判定不可交互，setValue 的 clear 步骤报 element not interactable。
      // 与 pickV4ComposerFiles 一致，固定到视口左上角并保持不可见。
      input.style.position = "fixed";
      input.style.left = "0";
      input.style.top = "0";
      input.style.width = "1px";
      input.style.height = "1px";
      input.style.opacity = "0";
      document.body.append(input);
    });
    try {
      await $("#e2e-local-video-drop").setValue(playableVideoPath);
      const paths = await browser.execute(() => {
        const input = document.querySelector<HTMLInputElement>("#e2e-local-video-drop");
        const file = input?.files?.[0];
        const target = document.querySelector<HTMLElement>(
          '[data-v4-conversation-drop-target="true"]',
        );
        if (!file || !target) throw new Error("缺少本地视频 File 或会话 drop surface");
        const bridge = (
          window as Window & { zcode?: { getPathForFile(file: File): string | null } }
        ).zcode;
        const data = new DataTransfer();
        data.items.add(file);
        const result = [bridge?.getPathForFile(file), bridge?.getPathForFile(data.files[0]!)];
        target.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
        );
        return result;
      });
      expect(paths).toEqual([playableVideoPath, playableVideoPath]);
    } finally {
      await browser.execute(() => document.querySelector("#e2e-local-video-drop")?.remove());
    }
    await pasteV4ComposerImageAttachment(GALLERY_IMAGE_FILENAME);
    await pasteV4ComposerFileAttachment(UNSUPPORTED_VIDEO_FILENAME, {
      base64: Buffer.from("not playable", "utf8").toString("base64"),
      mimeType: "video/quicktime",
    });
    // `video/ogg` 可以进入 video 语义，但现有 artifact 派生缓存没有对应扩展名；
    // 它固定覆盖 local source 不可用时仍走既有分片/Blob 预览，而不是新增测试开关。
    await pasteV4ComposerFileAttachment(CHUNK_FALLBACK_VIDEO_FILENAME, {
      base64: Buffer.from("not playable", "utf8").toString("base64"),
      mimeType: "video/ogg",
    });
    await pickV4ComposerFiles([largeVideoPath]);

    const composerCards = await waitForComposerMediaCards(MEDIA_KINDS);
    expect(composerCards.map(({ width }) => width)).toEqual([48, 48, 48, 48, 48]);
    expect(composerCards.map(({ height }) => height)).toEqual([48, 48, 48, 48, 48]);
    expect(composerCards.map(({ role }) => role)).toEqual([
      "button",
      "button",
      "button",
      "button",
      null,
    ]);
    expect(composerCards.slice(0, 4).every(({ src }) => src.startsWith("blob:"))).toBe(true);
    // Bug 根因：视频 input File 仍采用本机路径预览；本用例不把路径视频改成 Blob 卡片。
    expect(composerCards[4]?.src.startsWith("blob:")).toBe(false);

    await openComposerMedia(0);
    await waitForPlayableVideo(PLAYABLE_VIDEO_FILENAME);
    await browser.keys(["ArrowRight"]);
    await waitForGalleryImage(GALLERY_IMAGE_FILENAME);
    await clickGalleryNavigation("next");
    await waitForUnsupportedVideo(UNSUPPORTED_VIDEO_FILENAME);
    await clickGalleryNavigation("previous");
    await waitForGalleryImage(GALLERY_IMAGE_FILENAME);
    await browser.keys(["ArrowLeft"]);
    await waitForPlayableVideo(PLAYABLE_VIDEO_FILENAME);
    await browser.keys(["ArrowLeft"]);
    await waitForUnsupportedVideo(CHUNK_FALLBACK_VIDEO_FILENAME);
    await closeMediaPreview();

    // 点击中间图片必须从其原始 gallery 位置打开，而不是每次都回到第一项。
    await openComposerMedia(1);
    await waitForGalleryImage(GALLERY_IMAGE_FILENAME);
    await closeMediaPreview();

    await installVideoBlobProbe();
    await clickV4Send();
    await waitForV4TimelineContaining("V4_VIDEO_PREVIEW_SEND_OK", 45_000);
    const sentSession = await waitForV4Pane(
      (state) => !state.canStop && state.sessionId !== "draft" && state.sessionId !== null,
      "混合媒体首发后没有回到空闲态且绑定 session",
      45_000,
    );
    const sessionId = sentSession.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`混合媒体首发后缺少真实 sessionId: ${sessionId ?? "null"}`);
    }

    const sentCards = await waitForSentMediaCards(MEDIA_KINDS);
    expect(sentCards.map(({ width }) => width)).toEqual([80, 80, 80, 80, 80]);
    expect(sentCards.map(({ height }) => height)).toEqual([80, 80, 80, 80, 80]);
    expect(sentCards.every(({ role }) => role === "button")).toBe(true);
    expect(sentCards[0]?.src.startsWith("zcode-media:")).toBe(true);
    expect(sentCards[1]?.src.startsWith("blob:")).toBe(true);
    expect(sentCards[2]?.src.startsWith("zcode-media:")).toBe(true);
    expect(sentCards[3]?.src.startsWith("blob:")).toBe(true);
    expect(sentCards[4]?.src.startsWith("zcode-media:")).toBe(true);
    expect(localMediaPath(sentCards[0]?.src).split(/[\\/]/)).toContain("video-cache");
    expect(localMediaPath(sentCards[4]?.src)).toBe(largeVideoPath);
    await expectUnauthorizedLocalMediaPathRejected(VIDEO_SOURCE_PATH);
    await waitForVideoBlob("video/ogg");
    expect(
      (await readVideoBlobCalls()).every(
        ({ size, type }) => !type.startsWith("video/") || size <= sourceVideo.byteLength,
      ),
    ).toBe(true);
    await restoreVideoBlobProbe();

    const largeVideoThumbnailSrc = sentCards[4]?.src;
    expect(largeVideoThumbnailSrc).toBeTruthy();

    await openSentMedia(4);
    await waitForPlayableVideo(LARGE_VIDEO_FILENAME, largeVideoThumbnailSrc);
    await seekPreviewVideo(LARGE_VIDEO_FILENAME);
    await browser.keys(["ArrowRight"]);
    await waitForPlayableVideo(PLAYABLE_VIDEO_FILENAME, sentCards[0]?.src);
    await browser.keys(["ArrowRight"]);
    await waitForGalleryImage(GALLERY_IMAGE_FILENAME);
    await clickGalleryNavigation("next");
    await waitForUnsupportedVideo(UNSUPPORTED_VIDEO_FILENAME);
    await closeMediaPreview();

    // 分片 fallback 项关闭后仍能从原位置重开，并能继续导航到本地路径项。
    await openSentMedia(3);
    await waitForUnsupportedVideo(CHUNK_FALLBACK_VIDEO_FILENAME);
    await clickGalleryNavigation("next");
    await waitForPlayableVideo(LARGE_VIDEO_FILENAME, largeVideoThumbnailSrc);
    await closeMediaPreview();

    // composer 编辑态载入原有序 refs，复用 composer 48px 媒体卡（AL13）。
    await beginFirstV4UserQueryEdit("");
    await waitForEditedComposerMediaCards(MEDIA_KINDS);
    await removeV4ComposerAttachmentAt(0);
    await waitForEditedComposerMediaCards(["image", "video", "video", "video"]);

    // 删除原索引 0 后，大视频展示索引前移，但 preview query 仍必须携带持久化原索引 4。
    await openComposerMedia(3);
    await waitForPlayableVideo(LARGE_VIDEO_FILENAME, largeVideoThumbnailSrc);
    await browser.keys(["ArrowRight"]);
    await waitForGalleryImage(GALLERY_IMAGE_FILENAME);
    await closeMediaPreview();

    await clickV4Send();
    await waitForV4TimelineContaining("V4_VIDEO_PREVIEW_EDIT_OK", 45_000);
    const editedSentCards = await waitForSentMediaCards(["image", "video", "video", "video"]);
    expect(editedSentCards[3]?.src.startsWith("zcode-media:")).toBe(true);
    await openSentMedia(3);
    await waitForPlayableVideo(LARGE_VIDEO_FILENAME, editedSentCards[3]?.src);
    await closeMediaPreview();

    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(sessionId, 60_000);
    await waitForV4Pane(
      (state) =>
        state.sessionId === sessionId && state.timelineText.includes("V4_VIDEO_PREVIEW_EDIT_OK"),
      `完整进程重启后没有冷恢复视频会话 ${sessionId}`,
      90_000,
    );

    const coldCards = await waitForSentMediaCards(["image", "video", "video", "video"]);
    expect(localMediaPath(coldCards[1]?.src).split(/[\\/]/)).toContain("video-cache");
    expect(coldCards[2]?.src.startsWith("blob:")).toBe(true);
    expect(localMediaPath(coldCards[3]?.src)).toBe(largeVideoPath);
    await openSentMedia(3);
    await waitForPlayableVideo(LARGE_VIDEO_FILENAME, coldCards[3]?.src);
    await seekPreviewVideo(LARGE_VIDEO_FILENAME);
    await closeMediaPreview();
    await openSentMedia(2);
    await waitForUnsupportedVideo(CHUNK_FALLBACK_VIDEO_FILENAME);
    await closeMediaPreview();
  }).timeout(360_000);
});

async function createSparseLargePlayableMp4(path: string, source: Buffer): Promise<void> {
  const targetBytes = PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes + 1024 * 1024;
  const moovBox = findTopLevelMp4Box(source, "moov");
  if (moovBox.offset + moovBox.size !== source.byteLength) {
    throw new Error("非 fast-start E2E 视频的 moov box 必须位于文件末尾");
  }
  const prefix = source.subarray(0, moovBox.offset);
  const moov = source.subarray(moovBox.offset);
  const freeBoxBytes = targetBytes - prefix.byteLength - moov.byteLength;
  if (freeBoxBytes < 8) throw new Error("大视频 E2E fixture 没有足够空间写入 free box");
  const freeBoxHeader = Buffer.alloc(8);
  freeBoxHeader.writeUInt32BE(freeBoxBytes, 0);
  freeBoxHeader.write("free", 4, "ascii");
  const file = await open(path, "w");
  try {
    await file.write(prefix, 0, prefix.byteLength, 0);
    await file.write(freeBoxHeader, 0, freeBoxHeader.byteLength, prefix.byteLength);
    await file.write(moov, 0, moov.byteLength, targetBytes - moov.byteLength);
  } finally {
    await file.close();
  }
}

type Mp4Box = { offset: number; size: number; type: string };

function moveMoovBoxBehindMediaData(source: Buffer): Buffer {
  const moovBox = findTopLevelMp4Box(source, "moov");
  const mdatBox = findTopLevelMp4Box(source, "mdat");
  if (moovBox.offset > mdatBox.offset) return source;

  // 保留原 moov 占用的字节，避免移动 mdat 后让 chunk offset 失效。
  const placeholder = Buffer.alloc(moovBox.size);
  placeholder.writeUInt32BE(moovBox.size, 0);
  placeholder.write("free", 4, "ascii");
  const result = Buffer.concat([
    source.subarray(0, moovBox.offset),
    placeholder,
    source.subarray(moovBox.offset + moovBox.size),
    source.subarray(moovBox.offset, moovBox.offset + moovBox.size),
  ]);
  if (findTopLevelMp4Box(result, "moov").offset <= findTopLevelMp4Box(result, "mdat").offset) {
    throw new Error("没有生成 moov 位于 mdat 之后的 E2E 视频");
  }
  return result;
}

function findTopLevelMp4Box(source: Buffer, expectedType: string): Mp4Box {
  let offset = 0;
  while (offset + 8 <= source.byteLength) {
    const size = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > source.byteLength) {
      throw new Error(`无效的 MP4 top-level box: type=${type}, offset=${offset}, size=${size}`);
    }
    if (type === expectedType) return { offset, size, type };
    offset += size;
  }
  throw new Error(`MP4 E2E fixture 缺少 ${expectedType} box`);
}

async function waitForComposerMediaCards(expectedKinds: readonly MediaKind[]) {
  let cards: MediaCardState[] = [];
  await browser.waitUntil(
    async () => {
      cards = await browser.execute(readComposerMediaCardsFromDom, TID_V4_ATTACHMENT as string);
      return mediaCardsMatch(cards, expectedKinds, 48, false);
    },
    { timeout: 45_000, timeoutMsg: "Composer 媒体卡片没有按原顺序进入 ready" },
  );
  return cards;
}

async function waitForSentMediaCards(expectedKinds: readonly MediaKind[]) {
  let cards: MediaCardState[] = [];
  await browser.waitUntil(
    async () => {
      cards = await browser.execute(readSentMediaCardsFromDom, TID_V4_ROW_ATTACHMENTS as string);
      return mediaCardsMatch(cards, expectedKinds, 80, true);
    },
    { timeout: 45_000, timeoutMsg: "sent 媒体卡片/首帧没有按原顺序收敛" },
  );
  return cards;
}

function mediaCardsMatch(
  cards: MediaCardState[],
  expectedKinds: readonly MediaKind[],
  expectedSize: number,
  requireEveryPreview: boolean,
): boolean {
  return (
    cards.length === expectedKinds.length &&
    cards.every(
      (card, index) =>
        card.kind === expectedKinds[index] &&
        card.width === expectedSize &&
        card.height === expectedSize &&
        (card.uploadStatus === null || card.uploadStatus === "ready") &&
        (!requireEveryPreview || card.src.length > 0) &&
        (card.kind !== "image" || card.src.startsWith("blob:")) &&
        (card.kind !== "video" ||
          requireEveryPreview ||
          index === expectedKinds.length - 1 ||
          card.src.startsWith("blob:")),
    )
  );
}

// 编辑态载入的是 session-owned ref，图片不一定有本地 blob URL（见 chat-message-queue spec），
// 因此不复用 waitForComposerMediaCards 的 blob/src 断言，只校验顺序、种类、ready 与 48px 尺寸。
async function waitForEditedComposerMediaCards(expectedKinds: readonly MediaKind[]) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (attachmentPrefix, kinds) => {
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>(
              `[data-testid^="${attachmentPrefix}-"][data-upload-status]`,
            ),
          );
          return (
            cards.length === kinds.length &&
            cards.every((card, index) => {
              const rect = card.getBoundingClientRect();
              return (
                card.getAttribute("data-composer-attachment-kind") === kinds[index] &&
                card.getAttribute("data-upload-status") === "ready" &&
                Math.round(rect.width) === 48 &&
                Math.round(rect.height) === 48
              );
            })
          );
        },
        TID_V4_ATTACHMENT,
        [...expectedKinds],
      ),
    { timeout: 15_000, timeoutMsg: "v4 composer 编辑态媒体卡片状态没有收敛" },
  );
}

async function openComposerMedia(index: number) {
  const cards = await $$(`[data-testid^="${TID_V4_ATTACHMENT}-"][data-upload-status]`);
  const target = cards[index];
  if (!target) throw new Error(`Composer media card 不存在: index=${index}`);
  expect(await target.getAttribute("role")).toBe("button");
  await target.waitForClickable({
    timeout: 15_000,
    timeoutMsg: `Composer media card 不可点击: index=${index}`,
  });
  await target.click();
}

async function openSentMedia(index: number) {
  const groups = await $$(
    `[data-testid^="${TID_V4_ROW_ATTACHMENTS}-"] [data-v4-user-input-media-attachments="true"]`,
  );
  const group = groups[0];
  if (!group) throw new Error("sent media attachment group 不存在");
  const cards = await group.$$('[data-v4-user-input-media-attachment="true"]');
  const target = cards[index];
  if (!target) throw new Error(`sent media card 不存在: index=${index}`);
  expect(await target.getAttribute("role")).toBe("button");
  await target.waitForClickable({
    timeout: 15_000,
    timeoutMsg: `sent media card 不可点击: index=${index}`,
  });
  await target.click();
}

async function waitForPlayableVideo(filename: string, expectedSrc?: string) {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(readGalleryStateFromDom);
      return (
        state.title === filename &&
        state.kind === "video" &&
        (expectedSrc ? state.src === expectedSrc : state.src.startsWith("blob:")) &&
        state.readyState >= 1 &&
        !state.error &&
        state.controls &&
        state.playsInline &&
        !state.autoplay &&
        state.hasNavigation &&
        !state.hasImageTools
      );
    },
    { timeout: 30_000, timeoutMsg: `${filename} 没有进入共享 gallery 的可播放 video` },
  );
}

async function waitForGalleryImage(filename: string) {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(readGalleryStateFromDom);
      return (
        state.title === filename &&
        state.kind === "image" &&
        state.alt === filename &&
        state.src.startsWith("blob:") &&
        state.hasNavigation &&
        state.hasImageTools
      );
    },
    { timeout: 15_000, timeoutMsg: `${filename} 没有进入共享 gallery 的图片项` },
  );
}

async function waitForUnsupportedVideo(filename: string) {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(readGalleryStateFromDom);
      return (
        state.title === filename &&
        (state.alertText.includes("can still be sent") ||
          state.alertText.includes("可以正常发送")) &&
        state.hasNavigation &&
        !state.hasImageTools
      );
    },
    { timeout: 15_000, timeoutMsg: `${filename} 没有展示可导航的非阻断预览错误` },
  );
}

async function installVideoBlobProbe() {
  await browser.execute(() => {
    const probeWindow = window as Window & {
      __zcodeVideoBlobProbe?: {
        calls: Array<{ size: number; type: string }>;
        original: typeof URL.createObjectURL;
      };
    };
    const original = URL.createObjectURL.bind(URL);
    const calls: Array<{ size: number; type: string }> = [];
    probeWindow.__zcodeVideoBlobProbe = { calls, original };
    URL.createObjectURL = (object: Blob | MediaSource) => {
      if (object instanceof Blob) calls.push({ size: object.size, type: object.type });
      return original(object);
    };
  });
}

async function waitForVideoBlob(mediaType: string) {
  await browser.waitUntil(
    () =>
      browser.execute((expectedMediaType) => {
        const probeWindow = window as Window & {
          __zcodeVideoBlobProbe?: { calls: Array<{ size: number; type: string }> };
        };
        return (
          probeWindow.__zcodeVideoBlobProbe?.calls.some(
            (call) => call.type === expectedMediaType && call.size > 0,
          ) === true
        );
      }, mediaType),
    { timeout: 30_000, timeoutMsg: `${mediaType} 没有通过分片字节创建 Blob URL` },
  );
}

async function readVideoBlobCalls(): Promise<Array<{ size: number; type: string }>> {
  return browser.execute(() => {
    const probeWindow = window as Window & {
      __zcodeVideoBlobProbe?: { calls: Array<{ size: number; type: string }> };
    };
    return probeWindow.__zcodeVideoBlobProbe?.calls ?? [];
  });
}

async function restoreVideoBlobProbe() {
  await browser.execute(() => {
    const probeWindow = window as Window & {
      __zcodeVideoBlobProbe?: { original: typeof URL.createObjectURL };
    };
    const probe = probeWindow.__zcodeVideoBlobProbe;
    if (probe) URL.createObjectURL = probe.original;
    delete probeWindow.__zcodeVideoBlobProbe;
  });
}

async function clickGalleryNavigation(direction: "next" | "previous") {
  const labels =
    direction === "next" ? ["Next image", "下一张图片"] : ["Previous image", "上一张图片"];
  for (const label of labels) {
    const button = await $(`[role="dialog"] button[aria-label="${label}"]`);
    if (!(await button.isExisting())) continue;
    await button.waitForClickable({
      timeout: 15_000,
      timeoutMsg: `media gallery ${direction} 按钮不可点击`,
    });
    await button.click();
    return;
  }
  throw new Error(`media gallery ${direction} 按钮不存在`);
}

async function closeMediaPreview() {
  await browser.keys(["Escape"]);
  await browser.waitUntil(() => browser.execute(() => !document.querySelector('[role="dialog"]')), {
    timeout: 10_000,
    timeoutMsg: "media gallery Dialog 没有关闭",
  });
}

function localMediaPath(src: string | undefined): string {
  if (!src) throw new Error("本地媒体 URL 不存在");
  const url = new URL(src);
  expect(url.protocol).toBe("zcode-media:");
  const path = url.searchParams.get("path");
  if (!path) throw new Error(`本地媒体 URL 缺少 path: ${src}`);
  return path;
}

async function expectUnauthorizedLocalMediaPathRejected(path: string) {
  const result = await browser.executeAsync((candidatePath, done) => {
    const url = new URL("zcode-media://local/preview");
    url.searchParams.set("path", candidatePath);
    // 旧协议会被这个 renderer 自报 MIME 绕过；新协议只认 Main 的精确路径授权集合。
    url.searchParams.set("mediaType", "video/mp4");
    const video = document.createElement("video");
    const timer = window.setTimeout(() => done("timeout"), 10_000);
    video.addEventListener(
      "loadedmetadata",
      () => {
        window.clearTimeout(timer);
        done("loaded");
      },
      { once: true },
    );
    video.addEventListener(
      "error",
      () => {
        window.clearTimeout(timer);
        done("error");
      },
      { once: true },
    );
    video.src = url.toString();
    video.load();
  }, path);
  expect(result).toBe("error");
}

async function seekPreviewVideo(filename: string) {
  const targetTime = await browser.execute((expectedTitle) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const title = dialog?.querySelector("h2")?.textContent?.trim();
    const video = dialog?.querySelector<HTMLVideoElement>("video");
    if (
      title !== expectedTitle ||
      !video ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    ) {
      return null;
    }
    const target = Math.min(Math.max(video.duration / 2, 0.1), video.duration - 0.05);
    video.currentTime = target;
    return target;
  }, filename);
  if (targetTime === null) throw new Error(`${filename} 不具备可 seek 的媒体元数据`);
  let lastState: Record<string, unknown> | null = null;
  await browser
    .waitUntil(
      async () => {
        const state = await browser.execute(
          (expectedTitle, expectedTime) => {
            const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
            const title = dialog?.querySelector("h2")?.textContent?.trim();
            const video = dialog?.querySelector<HTMLVideoElement>("video");
            return {
              currentTime: video?.currentTime ?? null,
              duration: video?.duration ?? null,
              errorCode: video?.error?.code ?? null,
              networkState: video?.networkState ?? null,
              readyState: video?.readyState ?? null,
              seekable: video
                ? Array.from({ length: video.seekable.length }, (_, index) => [
                    video.seekable.start(index),
                    video.seekable.end(index),
                  ])
                : [],
              seeking: video?.seeking ?? null,
              success:
                title === expectedTitle &&
                Boolean(video) &&
                !video?.seeking &&
                Math.abs((video?.currentTime ?? 0) - expectedTime) < 0.25,
              title,
            };
          },
          filename,
          targetTime,
        );
        lastState = state;
        return state.success;
      },
      { timeout: 15_000, timeoutMsg: `${filename} 没有通过本地媒体协议完成 seek` },
    )
    .catch((error) => {
      throw new Error(`${filename} seek 状态异常: ${JSON.stringify(lastState)}`, {
        cause: error,
      });
    });
}

function readComposerMediaCardsFromDom(attachmentPrefix: string): MediaCardState[] {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-testid^="${attachmentPrefix}-"][data-upload-status]`,
    ),
  );
  return elements.map((element) => {
    const overlay = element.querySelector('[data-attachment-video-play-overlay="true"]');
    const media = element.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
    const rect = element.getBoundingClientRect();
    return {
      height: Math.round(rect.height),
      kind: overlay ? "video" : "image",
      role: element.getAttribute("role"),
      src: media?.src ?? "",
      uploadStatus: element.getAttribute("data-upload-status"),
      width: Math.round(rect.width),
    };
  });
}

function readSentMediaCardsFromDom(attachmentsPrefix: string): MediaCardState[] {
  const group = document.querySelector<HTMLElement>(
    `[data-testid^="${attachmentsPrefix}-"] [data-v4-user-input-media-attachments="true"]`,
  );
  const elements = Array.from(
    group?.querySelectorAll<HTMLElement>(':scope > [data-v4-user-input-media-attachment="true"]') ??
      [],
  );
  return elements.map((element) => {
    const overlay = element.querySelector('[data-attachment-video-play-overlay="true"]');
    const media = element.querySelector<HTMLImageElement | HTMLVideoElement>("img, video");
    const rect = element.getBoundingClientRect();
    return {
      height: Math.round(rect.height),
      kind: overlay ? "video" : "image",
      role: element.getAttribute("role"),
      src: media?.src ?? "",
      uploadStatus: element.getAttribute("data-upload-status"),
      width: Math.round(rect.width),
    };
  });
}

function readGalleryStateFromDom(): GalleryState {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const image = dialog?.querySelector<HTMLImageElement>("img");
  const video = dialog?.querySelector<HTMLVideoElement>("video");
  const labels = Array.from(
    dialog?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [],
  ).map((button) => button.getAttribute("aria-label"));
  const hasLabel = (...candidates: string[]) =>
    labels.some((label) => label !== null && candidates.includes(label));
  return {
    alertText: dialog?.querySelector<HTMLElement>('[role="alert"]')?.innerText ?? "",
    alt: image?.alt ?? "",
    autoplay: video?.autoplay ?? false,
    controls: video?.controls ?? false,
    error: Boolean(video?.error),
    hasImageTools:
      hasLabel("Download image", "下载图片") &&
      hasLabel("Zoom in", "放大") &&
      hasLabel("Zoom out", "缩小"),
    hasNavigation: hasLabel("Previous image", "上一张图片") && hasLabel("Next image", "下一张图片"),
    kind: video ? "video" : image ? "image" : "none",
    playsInline: video?.playsInline ?? false,
    readyState: video?.readyState ?? 0,
    src: video?.src ?? image?.src ?? "",
    title: dialog?.querySelector("h2")?.textContent?.trim() ?? "",
  };
}
