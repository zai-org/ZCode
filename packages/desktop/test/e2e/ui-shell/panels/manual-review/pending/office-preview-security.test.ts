import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_SIDE_PANE_FULL_VIEW_TOGGLE,
  TID_SIDE_PANE_FULL_VIEW_MINIMIZE,
  TID_V4_COMPOSER_INPUT,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";

const ROOT = join(DEFAULT_WORKSPACE, "E2E_OFFICE_SECURITY");
const FIXTURES = fileURLToPath(
  new URL("../../../../fixtures/fs/office-preview-security/", import.meta.url),
);

// 只打开合成文档；标记脚本不读取文件、执行命令或向外传输数据。
describe("内置 Office 预览安全边界", () => {
  before(async () => {
    await mkdir(ROOT, { recursive: true });
    for (const name of ["tooltip.pptx", "links.xlsx"]) {
      await copyFile(join(FIXTURES, name), join(ROOT, name));
    }
    await waitForDefaultWorkspaceReady();
    await openProjectFileTree(DEFAULT_WORKSPACE);
    await clickFile(ROOT);
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_TOGGLE}"]`).click();
    // 完整视图的操作栏只在输入框聚焦时出现，收起浮窗后再操作文档工具栏。
    await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).click();
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_MINIMIZE}"]`).waitForClickable();
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_MINIMIZE}"]`).click();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(ROOT, { recursive: true, force: true });
  });

  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    await browser.saveScreenshot(
      join(
        process.env.ZCODE_E2E_ARTIFACT_DIR ?? ROOT,
        `${this.currentTest.title.slice(0, 5)}-failure.png`,
      ),
    );
    console.info(
      "[office-preview DOM]",
      await browser.execute(() => ({
        text: document.body.innerText,
        tabs: [...document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")].map((el) => ({
          id: el.dataset.sidePaneTabId,
          state: el.dataset.state,
        })),
      })),
    );
  });

  it("OPS01：PPTX 气泡 tooltip 把 HTML 系列名显示为文本", async () => {
    await clickFile(join(ROOT, "tooltip.pptx"));
    const chart = $(
      '[data-zcode-pptx-render-surface="true"].pointer-events-auto [_echarts_instance_]',
    );
    await chart.waitForDisplayed({ timeout: 30000 });
    // 夹具只有一个蓝色气泡；从真实 Canvas 像素定位，避免 fit 缩放后固定坐标漏掉气泡。
    let bubble: { x: number; y: number } | null = null;
    await browser.waitUntil(
      async () => {
        bubble = await browser.execute(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-zcode-pptx-render-surface="true"].pointer-events-auto [_echarts_instance_] canvas',
          );
          if (!canvas) return null;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let x = 0,
            y = 0,
            count = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              pixels[i + 3]! > 100 &&
              pixels[i + 2]! > pixels[i]! + 40 &&
              pixels[i + 2]! > pixels[i + 1]! + 20
            ) {
              x += (i / 4) % canvas.width;
              y += Math.floor(i / 4 / canvas.width);
              count++;
            }
          }
          if (count < 100) return null;
          const rect = canvas.getBoundingClientRect();
          return {
            x: rect.left + (x / count / canvas.width) * rect.width,
            y: rect.top + (y / count / canvas.height) * rect.height,
          };
        });
        return bubble !== null;
      },
      { timeout: 10000, timeoutMsg: "气泡未完成绘制" },
    );
    const point = bubble! as { x: number; y: number };
    await browser.performActions([
      {
        type: "pointer",
        id: "office-pointer",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: Math.round(point.x), y: Math.round(point.y), duration: 0 },
        ],
      },
    ]);
    await browser.waitUntil(
      () =>
        browser.execute(() => document.body.innerText.includes('<img src="office-preview-probe"')),
      { timeout: 5000, timeoutMsg: "未出现字面文本 tooltip，不能把未触发当作通过" },
    );
    expect(
      await browser.execute(() => ({
        injected: Boolean(document.querySelector('img[src="office-preview-probe"]')),
        executed: (window as Window & { __officePreviewXss?: number }).__officePreviewXss ?? 0,
      })),
    ).toEqual({ injected: false, executed: 0 });
    // 仅替代系统路径选择；真实执行打印和文件写入，覆盖同一渲染器的导出入口。
    const exportedPath = join(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ROOT,
      "office-preview-export.pdf",
    );
    const saveDialog = await browser.electron.mock("dialog", "showSaveDialog");
    await saveDialog.mockResolvedValueOnce({ canceled: false, filePath: exportedPath });
    try {
      await $('button[aria-label="Export as PDF"], button[aria-label="导出为 PDF"]').click();
      await browser.waitUntil(
        async () => {
          try {
            const pdf = await readFile(exportedPath);
            return pdf.length > 1000 && pdf.subarray(0, 5).toString() === "%PDF-";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        },
        { timeout: 20000, timeoutMsg: "PPTX 未导出有效 PDF" },
      );
    } finally {
      await saveDialog.mockRestore();
    }
    expect(
      await browser.execute(
        () => (window as Window & { __officePreviewXss?: number }).__officePreviewXss ?? 0,
      ),
    ).toBe(0);
  }).timeout(60000);

  it("OPS02：XLSX Canvas、形状、图片外链经过统一校验", async () => {
    await clickFile(join(ROOT, "links.xlsx"));
    await $('[data-office-preview-kind="excel"] canvas').waitForDisplayed({ timeout: 30000 });
    const fileTab = await $('[data-side-pane-tab-id][data-state="active"]').getAttribute(
      "data-side-pane-tab-id",
    );
    await browser.execute(() => {
      const state = window as Window & {
        __officeNativeOpens?: string[];
        __officeOriginalOpen?: typeof window.open;
      };
      state.__officeNativeOpens = [];
      state.__officeOriginalOpen = window.open;
      // 仅记录是否绕过宿主回调；危险请求不真的打开窗口。
      window.open = (url) => {
        state.__officeNativeOpens!.push(String(url));
        return null;
      };
    });
    try {
      for (let row = 0; row < 5; row++) await clickCell(row);
      await $('[title="OPS_UNSAFE_SHAPE"]').click();
      const image = $('[data-office-preview-kind="excel"] img');
      await image.waitForExist();
      const location = await image.getLocation();
      const size = await image.getSize();
      await clickPoint(location.x + size.width / 2, location.y + size.height / 2);
      expect(
        await browser.execute(
          () => (window as Window & { __officeNativeOpens?: string[] }).__officeNativeOpens,
        ),
      ).toEqual([]);
      expect(await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`).isExisting()).toBe(false);
      await clickCell(6);
      await waitForBrowserUrl("127.0.0.1:9/office-preview");
      expect(
        await browser.execute(
          () => (window as Window & { __officeNativeOpens?: string[] }).__officeNativeOpens,
        ),
      ).toEqual([]);
      await $(`[data-side-pane-tab-id="${fileTab}"]`).click();
      await $('[title="OPS_UNSAFE_SHAPE"]').waitForDisplayed();
      await clickCell(7);
      await browser.waitUntil(
        async () =>
          (await $(
            '[data-office-preview-kind="excel"] [role="tab"][aria-selected="true"]',
          ).getText()) === "Details",
      );
    } finally {
      await browser.execute(() => {
        const state = window as Window & { __officeOriginalOpen?: typeof window.open };
        if (state.__officeOriginalOpen) window.open = state.__officeOriginalOpen;
      });
    }
  }).timeout(60000);

  it("OPS03：主窗口拒绝危险 popup，合法外链不创建原生窗口", async () => {
    const initialUrl = await browser.getUrl();
    const initialWindows = await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows().map((win) => win.id),
    );
    for (const url of [
      "javascript:window.__officePreviewXss=1",
      "data:text/html,blocked",
      "file:///office-preview-blocked",
      "zcode://office-preview-blocked",
    ]) {
      await browser.execute((target) => {
        window.open(target, "_blank");
      }, url);
    }
    await browser.execute(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await browser.getUrl()).toBe(initialUrl);
    expect(
      await browser.electron.execute((electron) =>
        electron.BrowserWindow.getAllWindows().map((win) => win.id),
      ),
    ).toEqual(initialWindows);
    await browser.execute(() => {
      window.open("http://127.0.0.1:9/office-popup", "_blank");
    });
    await waitForBrowserUrl("127.0.0.1:9/office-popup");
    expect(
      await browser.electron.execute((electron) =>
        electron.BrowserWindow.getAllWindows().map((win) => win.id),
      ),
    ).toEqual(initialWindows);
    expect(
      await browser.execute(
        () => (window as Window & { __officePreviewXss?: number }).__officePreviewXss ?? 0,
      ),
    ).toBe(0);
  }).timeout(30000);
});

async function waitForBrowserUrl(url: string) {
  await browser.waitUntil(
    async () => {
      for (const input of await $$(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`)) {
        if ((await input.isDisplayed()) && (await input.getValue()).includes(url)) return true;
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `未显示受控浏览器地址 ${url}` },
  );
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
    { timeout: 15000, timeoutMsg: `文件树中找不到 ${path}` },
  );
}

async function clickCell(row: number) {
  const point = await browser.execute((index) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-office-preview-kind="excel"] canvas',
    )!;
    // Canvas 有向视口外扩展的预绘制区域，点击坐标必须相对实际滚动视口。
    let viewport = canvas.parentElement;
    while (viewport && !["auto", "scroll"].includes(getComputedStyle(viewport).overflowY)) {
      viewport = viewport.parentElement;
    }
    const rect = viewport!.getBoundingClientRect();
    // 夹具固定行高 30pt（40px）加 1px 网格线，列头为 24px。
    return { x: rect.left + 85, y: rect.top + 24 + index * 41 + 20 };
  }, row);
  await clickPoint(point.x, point.y);
}

async function clickPoint(x: number, y: number) {
  await browser.performActions([
    {
      type: "pointer",
      id: "office-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: Math.round(x), y: Math.round(y), duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}
