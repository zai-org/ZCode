import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_WORKSPACE_FILE_TREE_ROW, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";
import {
  getV4ComposerAttachments,
  getV4ComposerText,
  getV4Messages,
  pasteV4ComposerFileAttachment,
  prepareV4ConversationE2E,
  setV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import { countUpstreamRequests } from "#e2e/helpers/conversation-session-network";

const ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", "image-actions");
const SHOTS =
  process.env.E2E_IMAGE_ACTION_SCREENSHOTS ??
  join(process.cwd(), ".e2e-artifacts", "image-actions");
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="white"/><circle cx="140" cy="150" r="70" fill="#d1fae5" stroke="#059669" stroke-width="3"/><path d="M300 80l70 40v80l-70 40-70-40v-80z" fill="#e0e7ff" stroke="#6366f1" stroke-width="3"/></svg>';
// 单像素 APNG/BMP/ICO 使用真实格式字节，防止只改文件名的假夹具掩盖格式问题。
const EXTRA_IMAGES = {
  "sample.apng":
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAABAAAAALQt6aAAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAASUVORK5CYII=",
  "sample.bmp": "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==",
  "sample.ico":
    "AAABAAEAAQEAAAEAIACAAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAABAAAAAQgGAAAAHxXEiQAAAAhhY1RMAAAAAQAAAAC0LemgAAAAGmZjVEwAAAAAAAAAAQAAAAEAAAAAAAAAAAABAAoAAFp/MNAAAAANSURBVHicY/jPwPAfAAUAAf+JmT0dAAAAAElFTkSuQmCC",
};

describe("图片下载与添加文件引用", () => {
  before(async function () {
    this.timeout(150000);
    await mkdir(ROOT, { recursive: true });
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(ROOT, "drawing.svg"), SVG);
    await writeFile(
      join(ROOT, "latin1.svg"),
      Buffer.from(
        '<?xml version="1.0" encoding="ISO-8859-1"?>' +
          SVG.replace("</svg>", '<text x="10" y="25">caf\u00e9</text></svg>'),
        "latin1",
      ),
    );
    for (const [name, base64] of Object.entries(EXTRA_IMAGES)) {
      await writeFile(join(ROOT, name), Buffer.from(base64, "base64"));
    }
    await prepareV4ConversationE2E();
    const png = await browser.electron.execute((electron) =>
      electron.nativeImage
        .createFromBuffer(Buffer.alloc(64 * 48 * 4, 180), { width: 64, height: 48 })
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(ROOT, "sample.png"), Buffer.from(png, "base64"));
    await openProjectFileTree(DEFAULT_WORKSPACE);
    const rows = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
        .filter((node) => node.dataset.testid?.startsWith("workspace-file-tree-row-"))
        .map((node) => ({ id: node.dataset.testid, text: node.textContent })),
    );
    await writeFile(join(SHOTS, "file-tree.json"), JSON.stringify(rows, null, 2));
    // 只有本 case 时单子目录会压成 .zcode-e2e/image-actions；有共享夹具时才逐级展开。
    if (
      rows.some(
        (row) =>
          row.id === testId(TID_WORKSPACE_FILE_TREE_ROW, join(DEFAULT_WORKSPACE, ".zcode-e2e")),
      )
    ) {
      await clickFile(join(DEFAULT_WORKSPACE, ".zcode-e2e"));
    }
    await clickFile(ROOT);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(ROOT, { recursive: true, force: true });
  });

  it("PIA01: 各格式与非 UTF-8 SVG 另存为保留原始字节，取消保存不报错", async () => {
    const save = await browser.electron.mock("dialog", "showSaveDialog");
    try {
      for (const name of [
        "sample.png",
        ...Object.keys(EXTRA_IMAGES),
        "drawing.svg",
        "latin1.svg",
      ]) {
        const path = join(ROOT, name);
        const target = join(ROOT, `saved-${name}`);
        await save.mockResolvedValue({ canceled: false, filePath: target });
        await clickFile(path);
        await openImageMenu();
        await browser.saveScreenshot(join(SHOTS, `${name}-actions.png`));
        await $('[role="menuitem"][data-image-preview-download]').click();
        await browser.waitUntil(
          async () => {
            try {
              return (await readFile(target)).equals(await readFile(path));
            } catch {
              return false;
            }
          },
          { timeout: 10000, timeoutMsg: `${name} 下载字节不一致` },
        );
        const suggestedName = await browser.electron.execute((electron) => {
          const calls = (
            electron.dialog.showSaveDialog as unknown as {
              mock: { calls: Array<Array<{ defaultPath?: string }>> };
            }
          ).mock.calls;
          return calls.at(-1)?.at(-1)?.defaultPath;
        });
        expect(suggestedName).toBe(name);
      }
      await save.mockResolvedValue({ canceled: true });
      await openImageMenu();
      await $('[role="menuitem"][data-image-preview-download]').click();
      await browser.waitUntil(
        async () => {
          try {
            await expect(save).toHaveBeenCalledTimes(7);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10000, timeoutMsg: "取消保存没有进入原生另存为入口" },
      );
      await browser.waitUntil(() =>
        browser.execute(
          () => !document.querySelector("[data-image-preview]")?.hasAttribute("aria-busy"),
        ),
      );
      expect(await browser.execute(() => document.body.textContent?.includes("下载图片失败"))).toBe(
        false,
      );
    } finally {
      await browser.electron.restoreAllMocks();
    }
  });

  it("PIA02: 只追加文件引用，保留空/非空草稿和附件，不发送", async () => {
    await clickFile(join(ROOT, "sample.png"));
    await setV4ComposerText("");
    await openImageMenu();
    await $('[role="menuitem"][data-image-preview-add]').click();
    await browser.waitUntil(
      async () => (await getV4ComposerText())?.includes("sample.png") === true,
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const input = document.querySelector('[data-testid="v4-composer-input"]');
          return Boolean(input?.contains(document.activeElement));
        }),
      { timeout: 5000, timeoutMsg: "添加引用后焦点没有回到输入框" },
    );
    expect(await getV4Messages("user")).toHaveLength(0);
    await setV4ComposerText("E2E_PIA_KEEP_DRAFT");
    await pasteV4ComposerFileAttachment("existing.png");
    await browser.waitUntil(async () => (await getV4ComposerAttachments()).length === 1);
    const before = await getV4ComposerAttachments();
    await openImageMenu();
    await $('[role="menuitem"][data-image-preview-add]').click();
    await browser.waitUntil(async () => {
      const text = await getV4ComposerText();
      return Boolean(text?.startsWith("E2E_PIA_KEEP_DRAFT") && text.includes("sample.png"));
    });
    expect(await getV4ComposerAttachments()).toEqual(before);
    expect(await getV4Messages("user")).toHaveLength(0);
    expect(await countUpstreamRequests({})).toBe(0);
    await browser.waitUntil(() =>
      browser.execute(() => document.querySelector('[role="menu"]') === null),
    );
    await browser.saveScreenshot(join(SHOTS, "added-to-chat.png"));
  });
});

let menuProbe = 0;
async function openImageMenu() {
  await browser.waitUntil(
    () => browser.execute(() => !document.querySelector("#zcode-toast-host")?.textContent?.trim()),
    { timeout: 8000, timeoutMsg: "上一条操作提示没有退场" },
  );
  await browser.waitUntil(() =>
    browser.execute(() => {
      const image = document.querySelector<HTMLImageElement>("[data-image-preview] img");
      return Boolean(image?.complete && image.naturalWidth > 0);
    }),
  );
  await $("[data-image-preview] img").click({ button: "right" });
  await $('[role="menuitem"][data-image-preview-download]').waitForDisplayed();
  await browser.waitUntil(() =>
    browser.execute(() =>
      document
        .querySelector('[role="menu"]')
        ?.getAnimations()
        .every((animation) => animation.playState === "finished"),
    ),
  );
  const probe = ++menuProbe;
  await browser.saveScreenshot(join(SHOTS, `menu-probe-${probe}.png`));
  await writeFile(
    join(SHOTS, `menu-probe-${probe}.json`),
    JSON.stringify(
      await browser.execute(() => ({
        preview: document.querySelector("[data-image-preview]")?.outerHTML,
        menus: Array.from(document.querySelectorAll('[role="menu"]')).map((node) => node.outerHTML),
        bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
      })),
      null,
      2,
    ),
  );
  await $('[role="menuitem"][data-image-preview-download]').waitForDisplayed();
}

async function clickFile(path: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => {
          const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) => element.dataset.testid === id,
          );
          row?.click();
          return Boolean(row);
        },
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    { timeout: 15000, timeoutMsg: `找不到 ${path}` },
  );
}
