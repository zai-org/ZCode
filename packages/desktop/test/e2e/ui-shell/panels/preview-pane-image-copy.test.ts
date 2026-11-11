import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TID_WORKSPACE_FILE_TREE_ROW, testId } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";

// PIC-01/02/05：只验证文件预览和原生剪贴板，不调用模型或修改会话状态。
const IMAGE_DIR = join(DEFAULT_WORKSPACE, "E2E_IMAGE_COPY");
const SCREENSHOTS = process.env.E2E_IMAGE_COPY_SCREENSHOTS ?? join(tmpdir(), "zcode-image-copy");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440" viewBox="0 0 720 440">
<rect width="720" height="440" fill="white"/>
<g stroke="#334155" stroke-width="3" fill="none"><circle cx="135" cy="210" r="74"/>
<path d="M135 150v60l48 28"/><circle cx="135" cy="210" r="4" fill="#334155"/>
<path d="M360 128l72 41v82l-72 41-72-41v-82z" fill="#d1fae5" stroke="#059669"/>
<g stroke="#6366f1"><circle cx="585" cy="210" r="76"/><circle cx="585" cy="210" r="48"/><circle cx="585" cy="210" r="20"/></g></g>
<g font-family="sans-serif" font-size="18" fill="#334155" text-anchor="middle">
<text x="135" y="325">Clock</text><text x="360" y="325">Hexagon</text><text x="585" y="325">Circles</text></g></svg>`;

describe("右侧图片预览复制 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(IMAGE_DIR, { recursive: true, force: true });
  });

  it("PIC-01/02/05：SVG 与 PNG 均通过右键写入原生图片剪贴板", async function () {
    this.timeout(150000);
    await mkdir(IMAGE_DIR, { recursive: true });
    await mkdir(SCREENSHOTS, { recursive: true });
    await writeFile(join(IMAGE_DIR, "drawing.svg"), SVG);
    await waitForDefaultWorkspaceReady();
    // 原生生成 PNG，避免测试依赖外网或与平台无关的图片解码库。
    const png = await browser.electron.execute((electron) =>
      electron.nativeImage
        .createFromBuffer(Buffer.alloc(64 * 48 * 4, 180), { width: 64, height: 48 })
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(IMAGE_DIR, "sample.png"), Buffer.from(png, "base64"));
    await openProjectFileTree(DEFAULT_WORKSPACE);
    await clickFile(IMAGE_DIR);

    for (const [name, width, height] of [
      ["drawing.svg", 720, 440],
      ["sample.png", 64, 48],
    ] as const) {
      await clickFile(join(IMAGE_DIR, name));
      const image = $("[data-image-preview] img");
      await image.waitForDisplayed();
      await browser.waitUntil(() =>
        browser.execute(() => {
          const image = document.querySelector<HTMLImageElement>("[data-image-preview] img");
          return Boolean(image?.complete && image.naturalWidth);
        }),
      );
      await browser.electron.execute((electron) => electron.clipboard.clear());
      await image.click({ button: "right" });
      const copy = $('[role="menuitem"][data-image-preview-copy]');
      await copy.waitForDisplayed();
      await browser.waitUntil(() =>
        browser.execute(() =>
          document
            .querySelector('[role="menu"]')
            ?.getAnimations()
            .every((animation) => animation.playState === "finished"),
        ),
      );
      await browser.saveScreenshot(join(SCREENSHOTS, `${name}-context-menu.png`));
      await copy.click();
      await browser.waitUntil(
        async () => {
          const result = await browser.electron.execute(async (electron) => {
            // Electron 44 移除了 readImage；读取 PNG 后仍验证原始图片的非空状态和尺寸。
            const item = (await electron.clipboard.read()).find((entry) =>
              entry.types.includes("image/png"),
            );
            if (!item) return { empty: true, width: 0, height: 0 };
            const png = await item.getType("image/png");
            const image = electron.nativeImage.createFromBuffer(
              Buffer.from(await png.arrayBuffer()),
            );
            return { empty: image.isEmpty(), ...image.getSize() };
          });
          return !result.empty && result.width === width && result.height === height;
        },
        { timeout: 10000, timeoutMsg: `${name} 没有写入原始尺寸的剪贴板图片` },
      );
      await browser.saveScreenshot(join(SCREENSHOTS, `${name}-copied.png`));
    }

    await browser.execute(() =>
      document.querySelector<HTMLElement>("[data-image-preview]")?.focus(),
    );
    await browser.keys(["Shift", "F10"]);
    await $('[role="menuitem"][data-image-preview-copy]').waitForDisplayed();
    await browser.keys("Escape");
  });
});

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
    {
      timeout: 15000,
      timeoutMsg: `找不到文件树条目 ${path}`,
    },
  );
}
