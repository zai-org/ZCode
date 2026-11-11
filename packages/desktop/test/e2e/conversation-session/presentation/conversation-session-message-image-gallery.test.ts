import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronMock } from "@wdio/electron-types";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  getV4ComposerText,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";

const CASE_NAME = "conversation-session-message-image-gallery";
const MARKER = "E2E_MESSAGE_IMAGE_GALLERY";
const IMAGE_DIR = join(DEFAULT_WORKSPACE, ".zcode-e2e", "message-image-gallery");
const IMAGE_NAMES = ["one.svg", "two.svg", "three.svg", "standalone.svg"] as const;
const SAVED_IMAGE_PATH = join(tmpdir(), `zcode-e2e-message-image-gallery-${Date.now()}.svg`);

let replayServer: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>> | null =
  null;
let showSaveDialogMock: ElectronMock | null = null;

describe("会话区消息图片画廊与共享预览 E2E", () => {
  before(async function () {
    this.timeout(240000);
    await writeImageFixtures();
    replayServer = await startConversationModelProviderReplayServer(CASE_NAME);
    await prepareReplayConversation();
    await sendV4Prompt(`${MARKER}: 返回约定的 Markdown 图片布局。`);
    await browser.waitUntil(async () => (await getV4ComposerText()) === "", {
      timeout: 15000,
      timeoutMsg: "图片 gallery prompt 发送后输入框没有清空",
    });
    await waitForV4TimelineContaining(MARKER);
    await waitForV4AssistantMessageContaining(MARKER);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.sessionId !== "draft",
      "图片 gallery 消息完成后没有回到 idle",
      90000,
    );
    await waitForV4QueueCount(0, 90000);
    await waitForImagesLoaded();
  });

  afterEach(async () => {
    // 断言失败会跳过用例末尾的关闭，残留独立图片会污染后续组内导航和下载。
    if ((await readPreview()).exists) await closePreview();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(SAVED_IMAGE_PATH, { force: true });
    await replayServer?.stop();
    replayServer = null;
  });

  it("MIG01/MIG02: 单图与连续多图遵守共享桌面布局", async () => {
    const snapshot = await readGalleryLayout();
    expect(snapshot.galleryCount).toBe(1);
    expect(snapshot.groupedCount).toBe(3);
    expect(snapshot.standaloneCount).toBe(1);
    expect(snapshot.galleryHorizontalOverflow).toBe(false);
    expect(snapshot.documentHorizontalOverflow).toBe(false);
    expect(snapshot.groupedHeights.every((height) => height === 176)).toBe(true);
    expect(snapshot.radii.every((radius) => radius === "12px")).toBe(true);
    expect(snapshot.standaloneAtMostHalfWidth).toBe(true);

    await clickStandaloneThumbnail();
    expect((await readPreview()).alt).toBe("MIG standalone");
    expect((await readPreview()).zoom).toBe("100%");
    expect(await countPreviewNavigationButtons()).toBe(0);
    await closePreview();
  });

  it("MIG03: small 与 390px viewport 换成两列和单列且不横向滚动", async () => {
    try {
      // 原因：macOS 会按屏幕工作区截断原生窗口高度；响应式断言直接控制 renderer viewport。
      await setRendererViewport(700, 900);
      const small = await waitForResponsiveColumns(2);
      expect(small.galleryHorizontalOverflow).toBe(false);
      expect(small.documentHorizontalOverflow).toBe(false);

      await setRendererViewport(390, 844);
      const mobile = await waitForResponsiveColumns(1);
      expect(mobile.galleryHorizontalOverflow).toBe(false);
      expect(mobile.documentHorizontalOverflow).toBe(false);
    } finally {
      await clearRendererViewport();
    }
  });

  it("MIG04: 从第二张打开并使用按钮和键盘在组内循环导航", async () => {
    await clickGroupedThumbnail(1);
    expect((await readPreview()).alt).toBe("MIG two");
    expect((await readPreview()).zoom).toBe("100%");

    await clickButtonByLabels(["放大", "Zoom in"]);
    expect((await readPreview()).zoom).toBe("150%");
    await clickButtonByLabels(["下一张图片", "Next image"]);
    expect((await readPreview()).alt).toBe("MIG three");
    expect((await readPreview()).zoom).toBe("100%");
    await browser.keys("ArrowRight");
    expect((await readPreview()).alt).toBe("MIG one");
    await browser.keys("ArrowLeft");
    expect((await readPreview()).alt).toBe("MIG three");
    expect((await readPreview()).zoom).toBe("100%");
    await closePreview();
  });

  it("MIG05/MIG07: 本地图片可缩放拖拽，关闭后恢复原缩略图焦点", async () => {
    const source = await readFile(join(IMAGE_DIR, "one.svg"), "utf8");
    const renderedSource = await readGroupedThumbnailSource(0);
    expect(renderedSource).toBe(
      `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`,
    );

    await clickGroupedThumbnail(0);
    await clickButtonByLabels(["放大", "Zoom in"]);
    await clickButtonByLabels(["放大", "Zoom in"]);
    const zoomed = await readPreview();
    expect(zoomed.zoom).toBe("200%");

    await dragPreview(120, 80);
    const dragged = await readPreview();
    expect(dragged.transform).not.toBe(zoomed.transform);

    await browser.keys("Escape");
    await waitForPreviewClosed();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const focused = document.activeElement;
          return (
            Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                "[data-markdown-image-gallery] [data-markdown-image-trigger]",
              ),
            ).indexOf(focused as HTMLButtonElement) === 0
          );
        }),
      {
        timeout: 10000,
        timeoutMsg: "关闭预览后焦点没有回到原 Markdown 缩略图",
      },
    );
  });

  it("MIG08: 下载当前本地预览图片通过 native Save As 原样落盘", async () => {
    showSaveDialogMock = await browser.electron.mock("dialog", "showSaveDialog");
    await showSaveDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePath: SAVED_IMAGE_PATH,
    });

    await clickGroupedThumbnail(0);
    await clickButtonByLabels(["下载图片", "Download image"]);
    await browser.waitUntil(
      async () => {
        try {
          return (await readFile(SAVED_IMAGE_PATH, "utf8")).includes("one.svg");
        } catch {
          return false;
        }
      },
      { timeout: 15000, timeoutMsg: "native Save As 没有写出当前预览 SVG" },
    );
    expect(await readFile(SAVED_IMAGE_PATH, "utf8")).toBe(
      await readFile(join(IMAGE_DIR, "one.svg"), "utf8"),
    );
    await closePreview();

    await rm(SAVED_IMAGE_PATH, { force: true });
    await showSaveDialogMock.mockResolvedValueOnce({
      canceled: true,
      filePath: "",
    });
    await clickGroupedThumbnail(0);
    await clickButtonByLabels(["下载图片", "Download image"]);
    await browser.pause(500);
    await expectFileMissing(SAVED_IMAGE_PATH);
    await closePreview();
  });
});

async function prepareReplayConversation() {
  await prepareV4ConversationE2E();
}

async function setRendererViewport(width: number, height: number) {
  // 桌面 BrowserWindow 的产品最小宽度是 480px；390px case 验证的是共享
  // renderer 响应式 CSS，因此用 CDP 模拟 viewport，不篡改桌面窗口产品约束。
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width,
  });
  await browser.waitUntil(
    async () => browser.execute((expectedWidth) => window.innerWidth === expectedWidth, width),
    { timeout: 10000, timeoutMsg: `renderer viewport 没有收敛到 ${width}px` },
  );
}

async function clearRendererViewport() {
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function sendRendererEmulationCommand(method: string, params: Record<string, unknown> = {}) {
  const sent = await browser.electron.execute(
    async (electron, command, commandParams) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const devtools = window.webContents.debugger;
      if (!devtools.isAttached()) devtools.attach("1.3");
      await devtools.sendCommand(command, commandParams);
      return true;
    },
    method,
    params,
  );
  if (!sent) throw new Error(`没有找到可执行 ${method} 的 Electron 窗口`);
}

async function writeImageFixtures() {
  await mkdir(IMAGE_DIR, { recursive: true });
  const colors = ["#ef4444", "#22c55e", "#3b82f6", "#a855f7"];
  await Promise.all(
    IMAGE_NAMES.map((name, index) =>
      writeFile(
        join(IMAGE_DIR, name),
        `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="${colors[index]}"/><text x="80" y="420" font-size="96" fill="white">${name}</text></svg>`,
        "utf8",
      ),
    ),
  );
}

async function waitForImagesLoaded() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const images = Array.from(
          document.querySelectorAll<HTMLImageElement>("img[data-markdown-image]"),
        ).filter((image) => image.alt.startsWith("MIG "));
        return (
          images.length === 4 &&
          images.every((image) => image.complete && image.naturalWidth === 1200)
        );
      }),
    { timeout: 30000, timeoutMsg: "Markdown 本地图片没有全部加载完成" },
  );
}

async function readGroupedThumbnailSource(index: number) {
  return browser.execute((targetIndex) => {
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>(
        "[data-markdown-image-gallery] img[data-markdown-image]",
      ),
    );
    return images[targetIndex]?.src ?? "";
  }, index);
}

async function readGalleryLayout() {
  return browser.execute(() => {
    const gallery = document.querySelector<HTMLElement>("[data-markdown-image-gallery]");
    const grouped = Array.from(
      gallery?.querySelectorAll<HTMLButtonElement>("[data-markdown-image-trigger]") ?? [],
    );
    const all = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-markdown-image-trigger]"),
    ).filter((button) => button.querySelector("img")?.getAttribute("alt")?.startsWith("MIG "));
    const standalone = all.filter((button) => !button.closest("[data-markdown-image-gallery]"));
    const galleryRect = gallery?.getBoundingClientRect();
    return {
      galleryCount: document.querySelectorAll("[data-markdown-image-gallery]").length,
      groupedCount: grouped.length,
      standaloneCount: standalone.length,
      groupedHeights: grouped.map((button) => Math.round(button.getBoundingClientRect().height)),
      radii: all.map(
        (button) => getComputedStyle(button.querySelector("img") as HTMLImageElement).borderRadius,
      ),
      standaloneAtMostHalfWidth: standalone.every(
        (button) => button.getBoundingClientRect().width <= (galleryRect?.width ?? 0) / 2 + 1,
      ),
      galleryHorizontalOverflow: Boolean(gallery && gallery.scrollWidth > gallery.clientWidth + 1),
      documentHorizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

async function waitForResponsiveColumns(expectedColumns: number) {
  let latest = {
    columns: 0,
    galleryHorizontalOverflow: true,
    documentHorizontalOverflow: true,
  };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(() => {
        const gallery = document.querySelector<HTMLElement>("[data-markdown-image-gallery]");
        const triggers = Array.from(
          gallery?.querySelectorAll<HTMLElement>("[data-markdown-image-trigger]") ?? [],
        );
        const columns = new Set(triggers.map((item) => Math.round(item.getBoundingClientRect().x)))
          .size;
        return {
          columns,
          galleryHorizontalOverflow: Boolean(
            gallery && gallery.scrollWidth > gallery.clientWidth + 1,
          ),
          documentHorizontalOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });
      return latest.columns === expectedColumns;
    },
    {
      timeout: 15000,
      timeoutMsg: `图片 gallery 没有收敛到 ${expectedColumns} 列: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function clickGroupedThumbnail(index: number) {
  const clicked = await browser.execute((targetIndex) => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-markdown-image-gallery] [data-markdown-image-trigger]",
      ),
    );
    buttons[targetIndex]?.click();
    return Boolean(buttons[targetIndex]);
  }, index);
  expect(clicked).toBe(true);
  await browser.waitUntil(async () => (await readPreview()).exists, {
    timeout: 10000,
    timeoutMsg: "共享图片预览没有打开",
  });
}

async function clickStandaloneThumbnail() {
  const clicked = await browser.execute(() => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-markdown-image-trigger]"),
    ).find(
      (candidate) =>
        !candidate.closest("[data-markdown-image-gallery]") &&
        candidate.querySelector("img")?.getAttribute("alt") === "MIG standalone",
    );
    button?.click();
    return Boolean(button);
  });
  expect(clicked).toBe(true);
  await browser.waitUntil(async () => (await readPreview()).exists, {
    timeout: 10000,
    timeoutMsg: "独立图片预览没有打开",
  });
}

async function countPreviewNavigationButtons() {
  return browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    return Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).filter(
      (button) =>
        /^(Previous image|Next image|上一张图片|下一张图片)$/u.test(
          button.getAttribute("aria-label") ?? "",
        ),
    ).length;
  });
}

async function readPreview() {
  return browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const image = dialog?.querySelector<HTMLImageElement>("img");
    // 百分比已改为可重置缩放的按钮；旧 span 选择器会把正常缩放误报为空。
    const zoom =
      dialog
        ?.querySelector<HTMLButtonElement>('button[title="重置缩放"], button[title="Reset zoom"]')
        ?.textContent?.trim() ?? "";
    return {
      alt: image?.alt ?? "",
      exists: Boolean(dialog && image),
      transform:
        dialog?.querySelector<HTMLElement>("[data-image-preview-surface]")?.style.transform ?? "",
      zoom,
    };
  });
}

async function clickButtonByLabels(labels: string[]) {
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = await browser.execute((expectedLabels) => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const buttons = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const labels = buttons.map((button) => button.getAttribute("aria-label") ?? "");
        const target = buttons.find((button) =>
          expectedLabels.includes(button.getAttribute("aria-label") ?? ""),
        );
        target?.click();
        return { clicked: Boolean(target), labels };
      }, labels);
      latest = result.labels;
      return result.clicked;
    },
    {
      timeout: 10000,
      timeoutMsg: `共享预览没有找到按钮 ${labels.join("/")}: ${latest.join(", ")}`,
    },
  );
}

async function dragPreview(deltaX: number, deltaY: number) {
  const image = await $('[role="dialog"] img');
  const location = await image.getLocation();
  const size = await image.getSize();
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
          x: Math.round(location.x + size.width / 2),
          y: Math.round(location.y + size.height / 2),
        },
        { type: "pointerDown", button: 0 },
        {
          type: "pointerMove",
          duration: 300,
          origin: "pointer",
          x: deltaX,
          y: deltaY,
        },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

async function closePreview() {
  await browser.keys("Escape");
  await waitForPreviewClosed();
}

async function waitForPreviewClosed() {
  await browser.waitUntil(async () => !(await readPreview()).exists, {
    timeout: 10000,
    timeoutMsg: "共享图片预览没有关闭",
  });
}

async function expectFileMissing(path: string) {
  let exists = true;
  try {
    await readFile(path);
  } catch {
    exists = false;
  }
  expect(exists).toBe(false);
}
