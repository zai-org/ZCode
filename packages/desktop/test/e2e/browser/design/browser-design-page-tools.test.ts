import type { Server } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_DESIGN_SLIDE_COUNTER,
  TID_BROWSER_DESIGN_TOOLBAR,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_EXPORT_PDF_ITEM,
  TID_BROWSER_EXPORT_PNG_ITEM,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
  TID_BROWSER_RESPONSIVE_BUTTON,
  TID_BROWSER_RESPONSIVE_PRESET_OPTION,
  TID_BROWSER_RESPONSIVE_PRESET_SELECT,
  TID_BROWSER_RESPONSIVE_TOOLBAR,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
  TID_BROWSER_SITE_SETTINGS_ITEM,
  TID_SIDE_PANE_FULL_VIEW_TOGGLE,
  TID_SIDE_PANE_TOGGLE,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, clickTestIdByWebDriver } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import {
  enableDesignPlugin,
  closeFixtureServer,
  guestEval,
  navigateBrowser,
  startFixtureServer,
  waitForTestIdText,
} from "#e2e/helpers/browser-design-mode";
import { prepareV4ConversationE2E, setV4ElectronWindowSize } from "#e2e/helpers/v4-conversation";

// BU-E2E-023：内置浏览器给设计稿用的页面工具（不经模型）。
// - 设备预设（docs/browser-use/2026-10-16-browser-device-presets-and-export-spec.md）：选「手机 / 平板」后
//   自由尺寸视口与 guest 的 innerWidth/innerHeight 变成预设尺寸。
// - 导出 PNG / PDF：另存框由 main 侧 dialog mock 返回路径，断言文件落盘且魔数正确（不碰原生另存框）。
// - file:// 自动刷新（docs/browser-use/2026-11-03-browser-element-screenshot-and-live-reload-spec.md）：
//   改页面加载的 CSS → 页面刷新且新样式生效；改同目录里页面没加载的文件 → 不刷新。
// - guest preload 设计桥（embeddedBrowserDesignBridge.ts）：页面主世界 postMessage 构造消息，
//   合法消息改变翻页计数；超过 256 KB UTF-8 字节（字符数未超）的、来自子 iframe 的消息被丢弃。

type ElectronMock = Awaited<ReturnType<typeof browser.electron.mock>>;

const PAGE_TITLE = "E2E design page tools";
const SLIDE_COUNT = 3;

const SITE_TITLE = "E2E site settings";

let tempDir = "";
let site: { server: Server; origin: string };
let pagePrefix = "";

function pageHtml(): string {
  const slides = Array.from(
    { length: SLIDE_COUNT },
    (_, index) => `<section class="slide" id="s${index + 1}"><h2>Slide ${index + 1}</h2></section>`,
  ).join("");
  return `<!doctype html><html data-zcode-design><head><title>${PAGE_TITLE}</title>
<link rel="stylesheet" href="style.css"></head><body><h1 id="title">E2E_PAGE_TOOLS</h1>${slides}</body></html>`;
}

function styleCss(color: string): string {
  return `body { margin: 0; font-family: sans-serif; }
section.slide { height: 100vh; box-sizing: border-box; padding: 40px; }
#title { color: ${color}; }`;
}

describe("BU-E2E-023：内置浏览器设备预设、导出、file:// 自动刷新与设计桥校验", () => {
  let saveDialog: ElectronMock;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-e2e-design-page-"));
    await writeFile(join(tempDir, "index.html"), pageHtml(), "utf8");
    await writeFile(join(tempDir, "style.css"), styleCss("rgb(255, 0, 0)"), "utf8");
    await writeFile(join(tempDir, "unrelated.txt"), "v1", "utf8");
    // 本机 HTML 经 zcode-html:// 预览协议加载，guest 的地址不是 file://
    pagePrefix = "zcode-html://";
    site = await startFixtureServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>${SITE_TITLE}</title><p>site</p>`);
    });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await closeFixtureServer(site?.server ?? null);
    await rm(tempDir, { recursive: true, force: true });
    await clearAppData();
  });

  it("预设改视口、导出落盘、只为已加载资源自动刷新、设计桥拒收超限与非本页消息", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    // 按 Windows 预览机 1280×800 屏 150% 缩放（约 853 DIP 宽）跑整条用例：右侧面板约 260px 宽。
    // macOS 窗口最小高度 640，高度取 640。
    await setV4ElectronWindowSize(853, 640);
    await openFirstBrowserTab();
    const pageUrl = pathToFileURL(join(tempDir, "index.html")).href;
    await navigateBrowser(pageUrl, PAGE_TITLE, pagePrefix);
    await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "file:// 设计稿页面没有出现设计工具行",
    });

    // 窄面板里地址栏不能盖住右侧按钮：按钮中心点命中的是按钮自己（地址栏失焦后 px-14 曾溢出盖住三个按钮）。
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await expectToolbarButtonsOnTop();

    // 设备预设：手机 390×844，再换平板 834×1112。
    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_BUTTON);
    await selectPreset("phone", 390, 844);
    await selectPreset("tablet", 834, 1112);

    // 导出 PNG / PDF：dialog mock 给路径，main 写盘。
    saveDialog = await browser.electron.mock("dialog", "showSaveDialog");
    const pngPath = join(tempDir, "export.png");
    const pdfPath = join(tempDir, "export.pdf");
    await saveDialog.mockResolvedValueOnce({ canceled: false, filePath: pngPath });
    await openMoreMenu();
    await clickTestIdByWebDriver(TID_BROWSER_EXPORT_PNG_ITEM);
    await waitForFileHead(pngPath, [0x89, 0x50, 0x4e, 0x47], "导出 PNG 没有写出 PNG 文件");
    await saveDialog.mockResolvedValueOnce({ canceled: false, filePath: pdfPath });
    await openMoreMenu();
    await clickTestIdByWebDriver(TID_BROWSER_EXPORT_PDF_ITEM);
    await waitForFileHead(pdfPath, [0x25, 0x50, 0x44, 0x46], "导出 PDF 没有写出 PDF 文件");
    // 另存框的默认名用页面标题
    const calls = (saveDialog.mock.calls as unknown[][]).map((args) =>
      JSON.stringify(args[args.length - 1]),
    );
    if (!calls.some((call) => call.includes(`${PAGE_TITLE}.png`))) {
      throw new Error(`导出 PNG 的建议文件名不是页面标题：${calls.join(" | ")}`);
    }

    // 写盘完成早于成功 toast 出现；在窄窗口它会挡住预设，等最后一条提示出现并退场再测连续操作。
    await browser.waitUntil(
      () => browser.execute((path) => document.body.innerText.includes(path), pdfPath),
      { timeout: 10_000, timeoutMsg: "PDF 导出后未出现成功提示" },
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (paths) => paths.every((path) => !document.body.innerText.includes(path)),
          [pngPath, pdfPath],
        ),
      { timeout: 10_000, timeoutMsg: "导出成功提示未退场" },
    );
    // 选完菜单项马上再点「更多」/ 预设下拉，必须能打开（不等上一次关闭动画结束）。
    // 修复前：关闭动画期间旧菜单的「点外部即关闭」还在监听，点触发器打开的新菜单被它当场关掉。
    await saveDialog.mockResolvedValueOnce({ canceled: true, filePath: "" });
    await openMoreMenu();
    await clickTestIdByWebDriver(TID_BROWSER_EXPORT_PNG_ITEM);
    await openMoreMenu();
    await closeMoreMenu();
    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_PRESET_SELECT);
    await clickTestIdByWebDriver(`${TID_BROWSER_RESPONSIVE_PRESET_OPTION}-phone`);
    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_PRESET_SELECT);
    await $(`[data-testid="${TID_BROWSER_RESPONSIVE_PRESET_OPTION}-tablet"]`).waitForDisplayed({
      timeout: 5_000,
      timeoutMsg: "选完预设马上再点预设下拉，下拉没有打开",
    });
    await clickTestIdByWebDriver(`${TID_BROWSER_RESPONSIVE_PRESET_OPTION}-tablet`);

    // file:// 自动刷新：同目录里页面没加载的文件变了，不刷新。
    await setReloadMarker();
    await writeFile(join(tempDir, "unrelated.txt"), "v2", "utf8");
    await browser.pause(3_000);
    if ((await guestEval(pagePrefix, "window.__e2eReloadMarker === 1")) !== true) {
      throw new Error("改了页面没加载的文件，页面却刷新了");
    }
    // 改页面加载的 CSS：刷新，新样式生效。
    await writeFile(join(tempDir, "style.css"), styleCss("rgb(0, 128, 0)"), "utf8");
    await browser.waitUntil(
      async () =>
        (await guestEval(
          pagePrefix,
          "window.__e2eReloadMarker === undefined && getComputedStyle(document.getElementById('title')).color",
        )) === "rgb(0, 128, 0)",
      { timeout: 20_000, timeoutMsg: "改了页面加载的 CSS，页面没有自动刷新" },
    );

    // 设计桥：合法消息改翻页计数（正对照）。
    await waitForTestIdText(TID_BROWSER_DESIGN_SLIDE_COUNTER, `1 / ${SLIDE_COUNT}`);
    await postSlideChanged(2);
    await waitForTestIdText(TID_BROWSER_DESIGN_SLIDE_COUNTER, `3 / ${SLIDE_COUNT}`);
    // 字符数 9 万（小于 256K）但 UTF-8 约 27 万字节：按字节计超限，丢弃。
    await postSlideChanged(0, "中".repeat(90_000));
    // 子 iframe 发给父页面：source 不是本页窗口，丢弃。
    await guestEval(
      pagePrefix,
      `(() => { const frame = document.createElement("iframe");
        frame.srcdoc = ${JSON.stringify(
          `<script>parent.postMessage({ __zcodeDesign: 1, events: [{ type: "slide-changed", index: 1, count: ${SLIDE_COUNT} }] }, "*");</script>`,
        )};
        document.body.appendChild(frame); return true; })()`,
    );
    await browser.pause(2_000);
    await waitForTestIdText(TID_BROWSER_DESIGN_SLIDE_COUNTER, `3 / ${SLIDE_COUNT}`);
    // 通道仍然可用：再发一条合法消息。
    await postSlideChanged(0);
    await waitForTestIdText(TID_BROWSER_DESIGN_SLIDE_COUNTER, `1 / ${SLIDE_COUNT}`);

    // 站点设置入口（窄面板）：地址栏里的入口被隐藏，改由「更多」菜单提供，点开是同一个站点权限设置页。
    // 地址栏窄到不好输入，由页面自己跳转到 http 页面（file:// 没有站点权限）。
    await guestEval(pagePrefix, `location.href = ${JSON.stringify(`${site.origin}/`)}; true`);
    await browser.waitUntil(
      async () => (await guestEval(site.origin, "document.title")) === SITE_TITLE,
      {
        timeout: 15_000,
        timeoutMsg: "内置浏览器没有跳到 http 测试页",
      },
    );
    await expectSiteSettingsInMoreMenu(true);
    await closeMoreMenu();
    // 宽面板（右侧面板全屏查看）：地址栏里有入口，「更多」菜单不重复。
    await clickTestIdByDom(TID_SIDE_PANE_FULL_VIEW_TOGGLE);
    await $(`[data-testid="browser-permission-trigger"]`).waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "全屏查看后地址栏里没有出现站点设置入口",
    });
    await expectSiteSettingsInMoreMenu(false);
    await closeMoreMenu();
    await clickTestIdByDom(TID_SIDE_PANE_FULL_VIEW_TOGGLE);
    await expectSiteSettingsInMoreMenu(true);
    await clickTestIdByWebDriver(TID_BROWSER_SITE_SETTINGS_ITEM);
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector('[data-testid="browser-site-permissions"] h1')?.textContent ??
            null,
        )) === site.origin,
      { timeout: 10_000, timeoutMsg: "点「更多」里的站点权限后没有打开该站点的权限设置页" },
    );
    // 回到 Browser tab 继续后面的窄窗口检查。
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-side-pane-tab-id^="browser:"]')?.click();
    });
    await $(`[data-testid="${TID_BROWSER_RESPONSIVE_TOOLBAR}"]`).waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "从站点权限页回到 Browser tab 后尺寸工具行没有显示",
    });

    // 设计稿页面上尺寸控件并进设计工具栏同一行；窄窗口（如 1366 宽屏 150% 缩放）放不下时折行，
    // 最左的预设下拉必须整个落在工具栏里，不能被裁掉，也不能靠横向滚动才够得着。
    // 设计工具栏只在设计稿页面上出现：先回到设计稿页面再查。
    await navigateBrowser(pageUrl, PAGE_TITLE, pagePrefix);
    await setV4ElectronWindowSize(760, 720);
    // resize 后对话过窄会异步收起侧栏；等待该状态再手动展开，避免测量到隐藏的零尺寸控件。
    const sidePaneToggle = $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
    await browser.waitUntil(
      async () =>
        ["Expand side pane", "展开侧边面板"].includes(
          (await sidePaneToggle.getAttribute("aria-label")) ?? "",
        ),
      { timeout: 10_000, timeoutMsg: "缩窄窗口后侧栏未完成自动收起" },
    );
    await sidePaneToggle.click();
    await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed();
    let presetReach = "unknown";
    try {
      await browser.waitUntil(
        async () => {
          presetReach = (await browser.execute(
            (toolbarId, controlsId, presetId) => {
              const toolbar = document.querySelector<HTMLElement>(`[data-testid="${toolbarId}"]`);
              const preset = document.querySelector<HTMLElement>(`[data-testid="${presetId}"]`);
              if (!toolbar || !preset) return "missing";
              if (!toolbar.contains(document.querySelector(`[data-testid="${controlsId}"]`)))
                return "not-merged";
              if (toolbar.scrollWidth > toolbar.clientWidth)
                return `overflowing ${toolbar.scrollWidth}/${toolbar.clientWidth}`;
              const bar = toolbar.getBoundingClientRect();
              const rect = preset.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return "hidden";
              return rect.left >= bar.left && rect.right <= bar.right ? "reachable" : "clipped";
            },
            TID_BROWSER_DESIGN_TOOLBAR,
            TID_BROWSER_RESPONSIVE_TOOLBAR,
            TID_BROWSER_RESPONSIVE_PRESET_SELECT,
          )) as string;
          return presetReach === "reachable";
        },
        { timeout: 10_000 },
      );
    } catch {
      throw new Error(`窄窗口下设计工具栏里的预设下拉不可见或被裁掉：${presetReach}`);
    }
    await selectPreset("phone", 390, 844);
  });
});

/** 点「更多」并等菜单项出现（不重试：菜单在上一次关闭的动画里也必须能马上再打开） */
async function openMoreMenu(): Promise<void> {
  await clickTestIdByWebDriver(TID_BROWSER_MORE_BUTTON);
  await $(`[data-testid="${TID_BROWSER_OPEN_EXTERNAL_ITEM}"]`).waitForDisplayed({
    timeout: 10_000,
    timeoutMsg: "点「更多」后菜单没有打开",
  });
}

/** 打开「更多」菜单，断言站点权限项在 / 不在；菜单保持打开 */
async function expectSiteSettingsInMoreMenu(present: boolean): Promise<void> {
  await openMoreMenu();
  // 菜单项随地址栏宽度（ResizeObserver）出现，给布局一点时间稳定
  await browser.pause(500);
  const exists = await $(`[data-testid="${TID_BROWSER_SITE_SETTINGS_ITEM}"]`).isExisting();
  if (exists !== present) {
    throw new Error(
      present ? "窄面板「更多」菜单里没有站点权限项" : "宽面板「更多」菜单里不应重复站点权限项",
    );
  }
}

async function closeMoreMenu(): Promise<void> {
  await browser.keys("Escape");
  await $(`[data-testid="${TID_BROWSER_OPEN_EXTERNAL_ITEM}"]`).waitForExist({
    reverse: true,
    timeout: 10_000,
  });
}

async function selectPreset(
  id: string,
  width: number,
  height: number,
  urlPrefix: string = pagePrefix,
): Promise<void> {
  await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_PRESET_SELECT);
  await clickTestIdByWebDriver(`${TID_BROWSER_RESPONSIVE_PRESET_OPTION}-${id}`);
  await browser.waitUntil(
    async () =>
      (await browser.execute((viewportTestId) => {
        const viewport = document.querySelector<HTMLElement>(`[data-testid="${viewportTestId}"]`);
        return `${viewport?.dataset.responsiveWidth}x${viewport?.dataset.responsiveHeight}`;
      }, TID_BROWSER_RESPONSIVE_VIEWPORT)) === `${width}x${height}`,
    { timeout: 10_000, timeoutMsg: `选预设 ${id} 后视口没有变成 ${width}×${height}` },
  );
  await browser.waitUntil(
    async () =>
      (await guestEval(urlPrefix, "`${window.innerWidth}x${window.innerHeight}`")) ===
      `${width}x${height}`,
    {
      timeout: 10_000,
      timeoutMsg: `选预设 ${id} 后页面 innerWidth/innerHeight 不是 ${width}×${height}`,
    },
  );
}

async function expectToolbarButtonsOnTop(): Promise<void> {
  const ids = [
    TID_BROWSER_RESPONSIVE_BUTTON,
    TID_BROWSER_ELEMENT_PICKER_BUTTON,
    TID_BROWSER_MORE_BUTTON,
  ];
  let covered: string[] = [];
  try {
    await browser.waitUntil(
      async () => {
        covered = (await browser.execute((testIds: string[]) => {
          return testIds.filter((id) => {
            const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
            if (!element) return true;
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            return !element.contains(hit);
          });
        }, ids)) as string[];
        return covered.length === 0;
      },
      { timeout: 10_000 },
    );
  } catch {
    throw new Error(`窄面板里浏览器工具栏按钮被盖住：${covered.join(", ")}`);
  }
}

async function setReloadMarker(): Promise<void> {
  await guestEval(pagePrefix, "window.__e2eReloadMarker = 1");
}

async function postSlideChanged(index: number, padding?: string): Promise<void> {
  const event = {
    type: "slide-changed",
    index,
    count: SLIDE_COUNT,
    ...(padding ? { padding } : {}),
  };
  await guestEval(
    pagePrefix,
    `window.postMessage({ __zcodeDesign: 1, events: [${JSON.stringify(event)}] }, "*"); true`,
  );
  if (padding) {
    await browser.pause(2_000);
  }
}

async function waitForFileHead(path: string, head: number[], timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        if ((await stat(path)).size < head.length) return false;
        const bytes = await readFile(path);
        return head.every((value, index) => bytes[index] === value);
      } catch {
        return false;
      }
    },
    { timeout: 20_000, timeoutMsg },
  );
}
