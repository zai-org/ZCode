import {
  TID_V4_ATTACHMENT,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_INPUT,
  TID_V4_ROW_ATTACHMENTS,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  beginFirstV4UserQueryEdit,
  clickV4Send,
  pasteV4ComposerFileAttachment,
  prepareV4ConversationE2E,
  setV4ComposerText,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_ATTACHMENT_LAYOUT_VISIBLE";
const LONG_FILE = "e2e-attachment-layout-a-very-long-filename-for-truncation.txt";
const SECOND_FILE = "e2e-attachment-layout-second.txt";
const IMAGE_FILE = "e2e-attachment-layout-image.png";
const FAILED_IMAGE_FILE = "e2e-attachment-layout-failed.png";
const FAILED_IMAGE_MARKER = "E2E_ATTACHMENT_FAILED_IMAGE";
const FAILED_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAATUlEQVR4AeXBMQEAIAzAsK43KlCBf2NMSJM5933CJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJE7iJG4B7pwBpTup40wAAAAASUVORK5CYII=";
const FAILED_IMAGE_BLOB_SIZE = 134;

describe("AL01-AL20：附件界面改版", () => {
  after(async () => {
    await restoreObjectUrlFactory().catch(() => {});
    await clearRendererEmulation();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Composer → sent → edit 覆盖附件结构、context、响应式、主题与序列化", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await setV4ComposerText(
      `${MARKER}\n\n# userselect:\n\`\`\`userselect\n[{"text":"E2E selection"}]\n\`\`\``,
    );

    // 故意先加文件再加媒体，产品展示仍必须按“媒体 → 文件”分层；同类文件保持添加顺序。
    await pasteV4ComposerFileAttachment(LONG_FILE, {
      base64: "Zmlyc3Q=",
      mimeType: "application/octet-stream",
    });
    await pasteV4ComposerFileAttachment(IMAGE_FILE);
    await pasteV4ComposerFileAttachment(SECOND_FILE, {
      base64: "c2Vjb25k",
      mimeType: "application/octet-stream",
    });
    await dispatchComposerContexts();

    const composer = await waitForComposerLayout();
    expect(composer.kinds).toEqual(["image", "file", "file"]);
    expect(composer.filenames).toEqual([IMAGE_FILE, LONG_FILE, SECOND_FILE]);
    expect(composer.mediaSize).toEqual({ height: 48, width: 48 });
    expect(composer.fileHeights.every((height) => height === 48)).toBe(true);
    expect(composer.longFileTitle).toBe(LONG_FILE);
    expect(composer.longFileTruncated).toBe(true);
    expect(composer.contextLabels).toHaveLength(3);
    expect(composer.hasSeparateContextRow).toBe(true);

    await assertComposerRemoveVisibility();
    await assertContextHoverAlignment("composer");
    await assertThemeSurfaces();
    await assertNarrowComposerWrap();

    await clickV4Send();
    await waitForV4TimelineContaining("V4_ATTACHMENT_LAYOUT_SEND_OK", 45_000);
    await waitForV4Pane(
      (state) => !state.canStop && state.sessionId !== null && state.sessionId !== "draft",
      "附件布局首发后没有回到 idle",
      45_000,
    );

    const sent = await waitForSentLayout();
    expect(sent.areaBeforeBubble).toBe(true);
    expect(sent.areaInsideBubble).toBe(false);
    expect(sent.mediaBeforePills).toBe(true);
    expect(sent.mediaKinds).toEqual(["image"]);
    expect(sent.fileNames).toEqual([LONG_FILE, SECOND_FILE]);
    expect(sent.filePillsAreRoundAndBorderless).toBe(true);
    expect(sent.pillOrder).toEqual(["file", "file", "comment", "web", "pptx", "selection"]);
    expect(sent.rightEdgesAligned).toBe(true);
    expect(sent.bubbleWidth).toBeLessThan(sent.rowWidth - 8);
    expect(sent.emptyUserRows).toBe(0);
    await assertContextHoverAlignment("sent");
    await assertNarrowSentWrap();
    await assertDesktopAndTouchActions();

    // composer 编辑态载入原附件与上下文 chip，复用 composer 的 48px 卡片（AL13）。
    await beginFirstV4UserQueryEdit(MARKER);
    const edit = await waitForEditLayout();
    expect(edit.attachmentKinds).toEqual(["image", "file", "file"]);
    expect(edit.attachmentHeights.every((height) => height === 48)).toBe(true);
    expect(edit.contextCount).toBe(4);
    expect(edit.visibleText).toBe(MARKER);
    expect(edit.containsProtocolText).toBe(false);

    await removeEditWebContext();
    await clickV4Send();
    await waitForV4TimelineContaining("V4_ATTACHMENT_LAYOUT_EDIT_OK", 45_000);
    const edited = await waitForSentLayout();
    expect(edited.pillOrder).toEqual(["file", "file", "comment", "pptx", "selection"]);

    // 仅 context 的消息不渲染空气泡；同时证明协议正文不会泄漏到可见消息。
    await setV4ComposerText(
      '# userselect:\n```userselect\n[{"text":"E2E_ATTACHMENT_CONTEXT_ONLY"}]\n```',
    );
    await clickV4Send();
    await waitForV4TimelineContaining("V4_ATTACHMENT_CONTEXT_ONLY_OK", 45_000);
    const contextOnly = await readLastUserRowStructure();
    expect(contextOnly.hasAttachmentArea).toBe(true);
    expect(contextOnly.hasBubble).toBe(false);
    expect(contextOnly.text).not.toContain("# userselect:");

    // 缩略图读取成功、但 renderer 无法建立 Blob URL 时必须降级为静态占位，
    // 并从当前消息的 gallery 中排除，避免展示无效点击入口。
    await setV4ComposerText(FAILED_IMAGE_MARKER);
    await pasteV4ComposerFileAttachment(FAILED_IMAGE_FILE, {
      pngBase64: FAILED_IMAGE_PNG_BASE64,
    });
    await waitForComposerMediaReady(FAILED_IMAGE_FILE);
    await installImageObjectUrlFailureForBlobSize(FAILED_IMAGE_BLOB_SIZE);
    await clickV4Send();
    await waitForV4TimelineContaining("V4_ATTACHMENT_FAILED_IMAGE_OK", 45_000);
    await waitForV4Pane((state) => !state.canStop, "失败图片 case 发送后没有回到 idle", 45_000);
    const failedImage = await waitForFailedSentImage();
    expect(failedImage.role).toBeNull();
    expect(failedImage.title).not.toBe("");
    expect(failedImage.hasImage).toBe(false);
    await restoreObjectUrlFactory();

    // 第一条消息只有一个可预览媒体；后续消息即使也含媒体，gallery 也不得跨消息拼接。
    await openFirstSentImage();
    const gallery = await readOpenGalleryState();
    expect(gallery.title).toBe(IMAGE_FILE);
    expect(gallery.hasPrevious).toBe(false);
    expect(gallery.hasNext).toBe(false);
    await browser.keys("Escape");
  });
});

async function dispatchComposerContexts(): Promise<void> {
  const dispatched = await browser.execute(() => {
    const tabState = (
      window as typeof window & {
        __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath?: string } };
      }
    ).__zcodeTabStoreE2E?.getState();
    const workspacePath = tabState?.activeWorkspacePath;
    if (!workspacePath) return false;
    window.dispatchEvent(
      new CustomEvent("zcode:code-comment-add-to-chat", {
        cancelable: true,
        detail: {
          id: "e2e-comment",
          workspacePath,
          sourcePath: `${workspacePath}/src/app.ts`,
          sourceTitle: "app.ts",
          selectedText: "const answer = 42",
          comment: "E2E comment",
          startLine: 1,
          endLine: 1,
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("zcode:web-element-context-add-to-chat", {
        detail: {
          id: "e2e-web",
          workspacePath,
          pageUrl: "https://e2e.example.test/page",
          pageTitle: "E2E Docs",
          tagName: "button",
          text: "Submit",
          capturedAt: Date.now(),
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("zcode:pptx-element-reference-add-to-chat", {
        detail: {
          id: "e2e-pptx",
          workspacePath,
          sourcePath: `${workspacePath}/deck.pptx`,
          sourceTitle: "deck.pptx",
          sourceFingerprint: `sha256:${"a".repeat(64)}`,
          slideIndex: 0,
          slidePart: "ppt/slides/slide1.xml",
          nodeId: "7",
          nodeName: "Title",
          nodeType: "shape",
          bounds: { x: 0, y: 0, width: 100, height: 30 },
          zIndex: 1,
          capturedAt: Date.now(),
        },
      }),
    );
    return true;
  });
  expect(dispatched).toBe(true);
}

async function waitForComposerMediaReady(filename: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((targetFilename) => {
        const image = Array.from(
          document.querySelectorAll<HTMLImageElement>(
            '[data-composer-attachment-kind="image"][data-upload-status="ready"] img[alt]',
          ),
        ).find((candidate) => candidate.alt === targetFilename);
        return Boolean(image?.src.startsWith("blob:"));
      }, filename),
    {
      timeout: 15000,
      // Bug 原因：paste 事件只保证进入异步上传流程；若过早安装 createObjectURL mock，
      // composer 自己会先消费故障，sent row 的缩略图重建反而不会失败。
      timeoutMsg: `目标图片在 composer 中没有完成 Blob 缩略图与上传：${filename}`,
    },
  );
}

async function waitForComposerLayout() {
  let snapshot = await readComposerLayout();
  await browser.waitUntil(
    async () => {
      snapshot = await readComposerLayout();
      return snapshot.kinds.length === 3 && snapshot.contextLabels.length === 3;
    },
    { timeout: 30_000, timeoutMsg: "Composer 附件与 context 没有收敛" },
  );
  return snapshot;
}

function readComposerLayout() {
  return browser.execute(
    (imageFile, longFile, secondFile) => {
      const row = document.querySelector<HTMLElement>("[data-composer-file-attachments-row]");
      const contextRow = document.querySelector<HTMLElement>(
        "[data-composer-context-attachments-row]",
      );
      const cards = Array.from(row?.children ?? []) as HTMLElement[];
      const media = cards.find((card) => card.dataset.composerAttachmentKind === "image");
      const files = cards.filter((card) => card.dataset.composerAttachmentKind === "file");
      const longName = files.find((file) => file.textContent?.includes("a-very-long-filename"));
      const longLabel = longName?.querySelector<HTMLElement>("[title]");
      return {
        contextLabels: Array.from(contextRow?.children ?? []).map(
          (item) => item.getAttribute("aria-label") ?? "",
        ),
        fileHeights: files.map((file) => Math.round(file.getBoundingClientRect().height)),
        filenames: cards.map(
          (card) =>
            [imageFile, longFile, secondFile].find(
              (filename) =>
                card.querySelector<HTMLImageElement>("img[alt]")?.alt === filename ||
                card.textContent?.includes(filename),
            ) ?? "",
        ),
        hasSeparateContextRow: Boolean(
          row && contextRow && row.parentElement === contextRow.parentElement,
        ),
        kinds: cards.map((card) => card.dataset.composerAttachmentKind ?? ""),
        longFileTitle: longLabel?.getAttribute("title") ?? "",
        longFileTruncated: Boolean(longLabel && longLabel.scrollWidth > longLabel.clientWidth),
        mediaSize: media
          ? {
              height: Math.round(media.getBoundingClientRect().height),
              width: Math.round(media.getBoundingClientRect().width),
            }
          : null,
      };
    },
    IMAGE_FILE,
    LONG_FILE,
    SECOND_FILE,
  );
}

async function assertComposerRemoveVisibility() {
  const first = await $("[data-composer-attachment-kind] [data-composer-attachment-remove]");
  await first.waitForExist({ timeout: 15_000 });
  expect(Number(await first.getCSSProperty("opacity").then((value) => value.value))).toBe(0);
  await first.moveTo();
  const card = await first.parentElement();
  await card.moveTo();
  await browser.waitUntil(
    async () => Number(await first.getCSSProperty("opacity").then((value) => value.value)) === 1,
    { timeout: 5_000, timeoutMsg: "桌面 hover 后删除按钮没有显示" },
  );
  await browser.execute((element) => (element as HTMLElement).focus(), first);
  expect(Number(await first.getCSSProperty("opacity").then((value) => value.value))).toBe(1);
  await sendRendererEmulationCommand("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  await browser.waitUntil(
    async () => browser.execute(() => window.matchMedia("(hover: none)").matches),
    { timeout: 5_000, timeoutMsg: "renderer 没有进入 touch/hover:none 模式" },
  );
  expect(Number(await first.getCSSProperty("opacity").then((value) => value.value))).toBe(1);
  await sendRendererEmulationCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
}

async function assertThemeSurfaces() {
  for (const theme of ["zai-light", "zai-dark"] as const) {
    const changed = await browser.execute((nextTheme) => {
      const setTheme = (window as typeof window & { __testActions?: Record<string, unknown> })
        .__testActions?.setTheme;
      if (typeof setTheme !== "function") return false;
      (setTheme as (value: string) => void)(nextTheme);
      return true;
    }, theme);
    expect(changed).toBe(true);
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const card = document.querySelector<HTMLElement>("[data-composer-attachment-kind]");
          const pill = document.querySelector<HTMLElement>(
            "[data-composer-context-attachments-row] > [role='button']",
          );
          return [card, pill].every((element) => {
            if (!element) return false;
            const color = getComputedStyle(element).backgroundColor;
            return color !== "rgba(0, 0, 0, 0)" && color !== "transparent";
          });
        }),
      { timeout: 5_000, timeoutMsg: `${theme} 附件 surface 不可见` },
    );
  }
}

async function assertNarrowComposerWrap() {
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 800,
    mobile: false,
    width: 520,
  });
  await browser.waitUntil(() => browser.execute(() => window.innerWidth === 520), {
    timeout: 5_000,
    timeoutMsg: "窄 viewport 未生效",
  });
  const state = await browser.execute(() => {
    const rows = [
      document.querySelector<HTMLElement>("[data-composer-file-attachments-row]"),
      document.querySelector<HTMLElement>("[data-composer-context-attachments-row]"),
    ];
    return {
      noDocumentOverflow:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      rowsContainedByComposer: rows.every((row) => {
        const composer = row?.closest("form")?.getBoundingClientRect();
        const rect = row?.getBoundingClientRect();
        return Boolean(
          composer && rect && rect.left >= composer.left - 1 && rect.right <= composer.right + 1,
        );
      }),
    };
  });
  expect(state).toEqual({ noDocumentOverflow: true, rowsContainedByComposer: true });
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function waitForSentLayout() {
  let snapshot = await readSentLayout();
  await browser.waitUntil(
    async () => {
      snapshot = await readSentLayout();
      return snapshot.pillOrder.includes("selection") && snapshot.mediaKinds.length > 0;
    },
    { timeout: 30_000, timeoutMsg: "sent 附件布局没有收敛" },
  );
  return snapshot;
}

function readSentLayout() {
  return browser.execute(
    (prefix, longFile, secondFile) => {
      const areas = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`),
      );
      const area = areas.find((item) =>
        item.querySelector("[data-v4-user-input-media-attachments]"),
      );
      const row = area?.parentElement;
      const bubble = row?.querySelector<HTMLElement>("[data-v4-user-input-bubble]");
      const media = area?.querySelector<HTMLElement>("[data-v4-user-input-media-attachments]");
      const pills = area?.querySelector<HTMLElement>("[data-v4-user-input-attachment-pills]");
      const pillChildren = Array.from(pills?.children ?? []) as HTMLElement[];
      const classify = (item: HTMLElement) => {
        if (item.dataset.v4UserInputAttachmentPill === "true") return "file";
        const label = item.getAttribute("aria-label") ?? "";
        if (/comment|评论/iu.test(label)) return "comment";
        if (/web|网页/iu.test(label)) return "web";
        if (/slide|幻灯片/iu.test(label)) return "pptx";
        if (/conversation|对话/iu.test(label)) return "selection";
        return "unknown";
      };
      const filePills = pillChildren.filter((item) => classify(item) === "file");
      const areaRect = area?.getBoundingClientRect();
      const bubbleRect = bubble?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      return {
        areaBeforeBubble: Boolean(
          area && bubble && area.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        areaInsideBubble: Boolean(area && bubble?.contains(area)),
        emptyUserRows: Array.from(document.querySelectorAll<HTMLElement>("[data-v4-row-id]"))
          .filter((candidate) => candidate.classList.contains("group/user-row"))
          .filter(
            (candidate) =>
              !candidate.querySelector(
                "[data-v4-user-input-attachments], [data-v4-user-input-bubble]",
              ),
          ).length,
        fileNames: filePills
          .map((pill) => pill.textContent ?? "")
          .flatMap((text) => [longFile, secondFile].filter((name) => text.includes(name))),
        filePillsAreRoundAndBorderless: filePills.every((pill) => {
          const style = getComputedStyle(pill);
          return (
            parseFloat(style.borderRadius) >= 999 ||
            (style.borderStyle === "none" && parseFloat(style.borderRadius) >= 16)
          );
        }),
        mediaBeforePills: Boolean(
          media && pills && media.compareDocumentPosition(pills) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        mediaKinds: Array.from(media?.children ?? []).map((item) =>
          item.querySelector("video") ? "video" : "image",
        ),
        bubbleWidth: bubbleRect?.width ?? 0,
        pillOrder: pillChildren.map(classify).filter((kind) => kind !== "unknown"),
        rightEdgesAligned: Boolean(
          areaRect && bubbleRect && Math.abs(areaRect.right - bubbleRect.right) <= 2,
        ),
        rowWidth: rowRect?.width ?? 0,
      };
    },
    TID_V4_ROW_ATTACHMENTS,
    LONG_FILE,
    SECOND_FILE,
  );
}

async function assertContextHoverAlignment(surface: "composer" | "sent") {
  const selector =
    surface === "composer"
      ? "[data-composer-context-attachments-row] > [role='button']"
      : "[data-v4-user-input-attachment-pills] > [role='button']";
  const trigger = await $(selector);
  await trigger.waitForExist({ timeout: 15_000 });
  await trigger.moveTo();
  const content = await $("[data-slot='hover-card-content']");
  await content.waitForDisplayed({ timeout: 5_000 });
  const [triggerRect, contentRect] = await Promise.all([
    trigger
      .getElement()
      .then((element) => browser.execute((item) => item.getBoundingClientRect().toJSON(), element)),
    content
      .getElement()
      .then((element) => browser.execute((item) => item.getBoundingClientRect().toJSON(), element)),
  ]);
  if (surface === "composer")
    expect(Math.abs(triggerRect.left - contentRect.left)).toBeLessThanOrEqual(3);
  else expect(Math.abs(triggerRect.right - contentRect.right)).toBeLessThanOrEqual(3);
  await browser.keys("Escape");
}

async function assertNarrowSentWrap() {
  await sendRendererEmulationCommand("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 800,
    mobile: false,
    width: 520,
  });
  const state = await browser.execute(() => {
    const row = document.querySelector<HTMLElement>("[data-v4-user-input-attachment-pills]");
    const userRow = row?.closest<HTMLElement>("[data-row-id]");
    const bubble = userRow?.querySelector<HTMLElement>("[data-v4-user-input-bubble]");
    const children = Array.from(row?.children ?? []) as HTMLElement[];
    const tops = new Set(children.map((item) => Math.round(item.getBoundingClientRect().top)));
    const right = row?.getBoundingClientRect().right ?? 0;
    const bubbleWidth = bubble?.getBoundingClientRect().width ?? 0;
    const userRowWidth = userRow?.getBoundingClientRect().width ?? 0;
    return {
      bubbleWithinContainer: bubbleWidth > 0 && bubbleWidth <= userRowWidth + 2,
      noDocumentOverflow:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      rightAligned: children.every((item) => item.getBoundingClientRect().right <= right + 1),
      wrapped: tops.size > 1,
    };
  });
  expect(state).toEqual({
    bubbleWithinContainer: true,
    noDocumentOverflow: true,
    rightAligned: true,
    wrapped: true,
  });
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride");
}

async function assertDesktopAndTouchActions() {
  const copy = await $("[data-testid^='v4-copy-']");
  await copy.waitForExist({ timeout: 15_000 });
  const actions = await copy.parentElement();
  await browser.action("pointer").move({ x: 4, y: 4 }).perform();
  await browser.waitUntil(
    async () => Number(await actions.getCSSProperty("opacity").then((value) => value.value)) === 0,
    { timeout: 5_000, timeoutMsg: "desktop 非 hover 状态下消息操作栏没有隐藏" },
  );
  const row = await actions.parentElement();
  await row.moveTo();
  await browser.waitUntil(
    async () => Number(await actions.getCSSProperty("opacity").then((value) => value.value)) === 1,
    { timeout: 5_000, timeoutMsg: "desktop hover 后消息操作栏没有显示" },
  );
}

async function waitForEditLayout() {
  let snapshot = await readEditLayout();
  await browser.waitUntil(
    async () => {
      snapshot = await readEditLayout();
      return snapshot.contextCount === 4 && snapshot.attachmentKinds.length === 3;
    },
    { timeout: 15_000, timeoutMsg: "composer 编辑态附件/context 布局没有收敛" },
  );
  return snapshot;
}

function readEditLayout() {
  return browser.execute(
    (composerTestId, attachmentPrefix, inputTestId) => {
      const composer = document.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`);
      const cards = Array.from(
        composer?.querySelectorAll<HTMLElement>(
          `[data-testid^="${attachmentPrefix}-"][data-upload-status]`,
        ) ?? [],
      );
      const contextRow = composer?.querySelector<HTMLElement>(
        "[data-composer-context-attachments-row]",
      );
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const visibleText = input?.innerText?.trim() ?? input?.textContent?.trim() ?? "";
      return {
        attachmentHeights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),
        attachmentKinds: cards.map(
          (card) => card.getAttribute("data-composer-attachment-kind") ?? "",
        ),
        containsProtocolText:
          /# userselect:|# Code comments:|# Web page elements:|# Presentation/iu.test(visibleText),
        contextCount: contextRow?.children.length ?? 0,
        visibleText,
      };
    },
    TID_V4_COMPOSER,
    TID_V4_ATTACHMENT,
    TID_V4_COMPOSER_INPUT,
  );
}

async function removeEditWebContext() {
  const removed = await browser.execute(() => {
    const row = document.querySelector<HTMLElement>("[data-composer-context-attachments-row]");
    const pill = Array.from(row?.children ?? []).find((item) =>
      /web|网页/iu.test(item.getAttribute("aria-label") ?? ""),
    );
    const button = pill?.querySelector<HTMLButtonElement>("button");
    button?.click();
    return Boolean(button);
  });
  expect(removed).toBe(true);
}

function readLastUserRowStructure() {
  return browser.execute(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).filter(
      (candidate) => candidate.classList.contains("group/user-row"),
    );
    const row = rows.at(-1);
    return {
      hasAttachmentArea: Boolean(row?.querySelector("[data-v4-user-input-attachments]")),
      hasBubble: Boolean(row?.querySelector("[data-v4-user-input-bubble]")),
      text: row?.innerText ?? "",
    };
  });
}

async function installImageObjectUrlFailureForBlobSize(expectedBlobSize: number) {
  const installed = await browser.electron.execute(async (electron, targetBlobSize) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
    );
    if (!target) return false;
    // Bug 原因：WebDriver executeScript 位于隔离 world，覆盖的 URL.createObjectURL
    // 不会影响 React 所在的 renderer main world。通过 webContents 注入真实页面 world。
    return target.webContents.executeJavaScript(
      `(() => {
      const host = window;
      if (host.__e2eOriginalCreateObjectURL) return false;
      const original = URL.createObjectURL.bind(URL);
      host.__e2eOriginalCreateObjectURL = original;
      host.__e2eObjectUrlBlobObservations = [];
      URL.createObjectURL = (object) => {
        if (
          object instanceof Blob &&
          object.type.startsWith("image/") &&
          object.size === ${targetBlobSize}
        ) {
          throw new Error("E2E forced image object URL failure");
        }
        if (object instanceof Blob && object.type.startsWith("image/")) {
          host.__e2eObjectUrlBlobObservations.push({ size: object.size, type: object.type });
        }
        return original(object);
      };
      return true;
    })()`,
      true,
    );
  }, expectedBlobSize);
  expect(installed).toBe(true);
}

async function restoreObjectUrlFactory() {
  await browser.electron.execute(async (electron) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
    );
    if (!target) return;
    await target.webContents.executeJavaScript(
      `(() => {
      const host = window;
      if (!host.__e2eOriginalCreateObjectURL) return;
      URL.createObjectURL = host.__e2eOriginalCreateObjectURL;
      delete host.__e2eOriginalCreateObjectURL;
      delete host.__e2eObjectUrlBlobObservations;
    })()`,
      true,
    );
  });
}

async function waitForFailedSentImage() {
  let state = await readFailedSentImage();
  try {
    await browser.waitUntil(
      async () => {
        state = await readFailedSentImage();
        return state.exists && state.title !== "" && !state.hasImage;
      },
      { timeout: 15_000, timeoutMsg: "图片读取失败后没有降级为不可预览静态占位" },
    );
  } catch (error) {
    const observations = await browser.electron.execute(async (electron) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!target) return [];
      return target.webContents.executeJavaScript(
        "window.__e2eObjectUrlBlobObservations ?? []",
        true,
      );
    });
    throw new Error(`图片读取失败 mock 未命中，实际 Blob: ${JSON.stringify(observations)}`, {
      cause: error,
    });
  }
  return state;
}

function readFailedSentImage() {
  return browser.execute((marker) => {
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).find(
      (candidate) =>
        candidate.classList.contains("group/user-row") && candidate.innerText.includes(marker),
    );
    const card = row?.querySelector<HTMLElement>("[data-v4-user-input-media-attachment='true']");
    return {
      exists: Boolean(card),
      hasImage: Boolean(card?.querySelector("img")),
      role: card?.getAttribute("role") ?? null,
      title: card?.getAttribute("title") ?? "",
    };
  }, FAILED_IMAGE_MARKER);
}

async function openFirstSentImage() {
  const opened = await browser.execute((filename) => {
    const card = Array.from(
      document.querySelectorAll<HTMLElement>("[data-v4-user-input-media-attachment='true']"),
    ).find((candidate) => candidate.querySelector<HTMLImageElement>(`img[alt="${filename}"]`));
    card?.click();
    return Boolean(card);
  }, IMAGE_FILE);
  expect(opened).toBe(true);
  await browser.waitUntil(
    () => browser.execute(() => Boolean(document.querySelector("[role='dialog']"))),
    { timeout: 10_000, timeoutMsg: "首条消息图片没有打开 gallery" },
  );
}

function readOpenGalleryState() {
  return browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    const labels = Array.from(dialog?.querySelectorAll("button[aria-label]") ?? []).map(
      (button) => button.getAttribute("aria-label") ?? "",
    );
    return {
      hasNext: labels.some((label) => label === "Next image" || label === "下一张图片"),
      hasPrevious: labels.some((label) => label === "Previous image" || label === "上一张图片"),
      title: dialog?.querySelector("h2")?.textContent?.trim() ?? "",
    };
  });
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
  expect(sent).toBe(true);
}

async function clearRendererEmulation() {
  await sendRendererEmulationCommand("Emulation.setTouchEmulationEnabled", {
    enabled: false,
  }).catch(() => {});
  await sendRendererEmulationCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
}
