import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Key } from "webdriverio";
import {
  TID_BROWSER_DESIGN_INSPECTOR,
  TID_BROWSER_DESIGN_PANEL_BUTTON,
  TID_BROWSER_DESIGN_SLIDE_COUNTER,
  TID_BROWSER_DESIGN_SLIDE_NEXT,
  TID_BROWSER_DESIGN_SOURCE_STATUS,
  TID_BROWSER_DESIGN_TOOLBAR,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_REFRESH_BUTTON,
  TID_SIDE_PANE_FULL_VIEW_HOST,
  TID_SIDE_PANE_FULL_VIEW_TOGGLE,
  TID_WEB_ELEMENT_CONTEXT_CHIP,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  clickCloseButton,
  openFirstBrowserTab,
  readBrowserTabIds,
  waitForTabCount,
} from "#e2e/helpers/browser-side-pane";
import {
  enableDesignPlugin,
  clickGuestElement,
  ELEMENT_TOKEN_SELECTOR,
  closeFixtureServer,
  countElementTokens,
  deleteLastElementToken,
  guestEval,
  hasReadyAttachment,
  holdGuestCapture,
  navigateBrowser,
  pressGuestUndo,
  readHeldCaptureCalls,
  releaseHeldCapture,
  selectGuestElement,
  startFixtureServer,
  typeAfterLastElementToken,
  readDataCount,
  waitForElementTokens,
  waitForReadyAttachment,
  waitForTestIdText,
} from "#e2e/helpers/browser-design-mode";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { clickV4Send, prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 内置浏览器设计工具（docs/browser-use/2026-11-03-browser-design-mode-spec.md）：
// 普通页面不出设计工具行；设计稿页面自动出现。点选 = 选中元素作为网页元素引用进输入框（Shift 多选、普通点击替换），
// 属性面板改数值直接写回本机 HTML 源文件、页面不刷新，Cmd/Ctrl + Z 撤销、加 Shift 重做。
// 页面里的点击用 main 侧 sendInputEvent 发真实鼠标事件，与用户在 guest 里点击同一条路径。

const MOD = process.platform === "darwin" ? Key.Command : Key.Control;
/** 本机 HTML 经 zcode-html:// 预览协议加载 */
const LOCAL_GUEST_PREFIX = "zcode-html://";

const PLAIN_HTML = `<!doctype html><html><head><title>E2E plain page</title></head>
<body><p id="plain">E2E_PLAIN</p></body></html>`;

const FIXTURE_HTML = `<!doctype html>
<html data-zcode-design><head><title>E2E design mode</title>
<style>
  :root { --brand: #ff6b35; --title-size: 40px; --veil: rgba(34, 85, 238, 0.5); }
  body { margin: 0; font-family: sans-serif; }
  section.slide { height: 100vh; padding: 40px; box-sizing: border-box; }
  h1 { font-size: var(--title-size); }
  .cta { padding: 12px 20px; background: var(--brand); border-radius: 12px; color: #fff; border: 0; }
  #imp { font-size: 30px !important; }
</style></head>
<body>
  <section class="slide" id="s1"><h1 id="title">E2E_DESIGN_TITLE</h1><button class="cta" id="cta">E2E_DESIGN_CTA</button><p id="note" style="color: /* brand */ #111; /* note; a: b */ padding: 8px">E2E_NOTE</p><p id="todo" style="color: #222; /* todo">E2E_TODO</p><p id="imp" style="font-size: 18px !important">E2E_IMP</p><button id="bgimp" style="background: red !important">E2E_BGIMP</button></section>
  <section class="slide" id="s2"><h2>Second</h2></section>
  <section class="slide" id="s3"><h2>Third</h2></section>
</body></html>`;

let fixtureServer: Server | null = null;
let fixtureOrigin = "";
let fixtureUrl = "";
let localDir = "";
let localFile = "";

/** 属性面板里的选中数；没有选中时面板收起、读不到，按 0 算 */
async function readInspectorSelectedCount(): Promise<string> {
  return (await browser.execute(
    (id) =>
      document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-selected-count") ?? "0",
    TID_BROWSER_DESIGN_INSPECTOR,
  )) as string;
}

/** 同一个 app 里连跑多条用例：关掉当前界面上的浏览器 tab，下一条从一个 tab 起步，也不留隐藏的旧地址栏、旧页面。 */
async function closeBrowserTabs(): Promise<void> {
  for (const tabId of await readBrowserTabIds()) await clickCloseButton(tabId);
  await waitForTabCount(0);
}

async function openFreshBrowserTab(): Promise<void> {
  await closeBrowserTabs();
  await clearElementTokens();
  await openFirstBrowserTab();
}

/** 草稿输入框跨用例保留：像用户一样全选删掉上一条留下的元素引用（程序改写不撤元素上下文，新选中时旧引用会被补回来） */
async function clearElementTokens(): Promise<void> {
  for (let attempt = 0; attempt < 5 && (await countElementTokens()) > 0; attempt += 1) {
    await browser.execute((selector) => {
      document.querySelector(selector)?.closest<HTMLElement>("[contenteditable=true]")?.focus();
    }, ELEMENT_TOKEN_SELECTOR);
    await browser.keys([MOD, "a"]);
    await browser.keys("Backspace");
    await browser.pause(300);
  }
  await waitForElementTokens(0, "清空输入框后不应还留着元素引用");
}

describe("BU-E2E-021：内置浏览器设计工具", () => {
  before(async () => {
    ({ server: fixtureServer, origin: fixtureOrigin } = await startFixtureServer(
      (request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(request.url?.startsWith("/plain") ? PLAIN_HTML : FIXTURE_HTML);
      },
    ));
    fixtureUrl = `${fixtureOrigin}/design`;
    localDir = await mkdtemp(join(tmpdir(), "zcode-e2e-design-"));
    localFile = join(localDir, "design.html");
  });

  // 首发后界面在新任务里，它的浏览器会常驻（隐藏）：在这里关掉，后面用例的 $() 才不会拿到它的元素
  afterEach(async () => {
    // 先在还开着的（完整视图的浮动）输入框里删掉引用，再关 tab：关掉后那份引用就看不到、删不着了
    await clearElementTokens().catch(() => undefined);
    await closeBrowserTabs().catch(() => undefined);
  });

  after(async () => {
    await closeFixtureServer(fixtureServer);
    fixtureServer = null;
    if (localDir) await rm(localDir, { recursive: true, force: true });
    await clearAppData();
  });

  it("设计工具随页面出现；点选元素进输入框成引用（Shift 多选、普通点击替换），翻页，首发带引用与截图", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    await openFreshBrowserTab();

    // 普通页面：没有设计稿信号，不出设计工具行。
    await navigate(`${fixtureOrigin}/plain`, "E2E plain page");
    await browser.pause(1_500);
    if (await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).isExisting()) {
      throw new Error("普通页面不应出现设计工具行");
    }

    // 本机 HTML 没有 data-zcode-design、只有 :root 变量：经 zcode-html:// 预览打开也算本机页面，自动出现设计工具（!3450 CR-01）
    const variablesFile = join(localDir, "variables.html");
    await writeFile(
      variablesFile,
      `<!doctype html><html><head><title>E2E local variables</title><style>:root { --brand: #ff6b35; }</style></head><body><p>E2E_VARIABLES</p></body></html>`,
      "utf-8",
    );
    await navigateBrowser(
      pathToFileURL(variablesFile).href,
      "E2E local variables",
      LOCAL_GUEST_PREFIX,
    );
    await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "本机带 :root 变量的页面应自动出现设计工具行",
    });

    // 设计稿页面：自动出现设计工具行与翻页。
    await navigate(fixtureUrl, "E2E design mode");
    await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: "设计稿页面没有自动出现设计工具行",
    });
    await waitForTestIdText(TID_BROWSER_DESIGN_SLIDE_COUNTER, "1 / 3");

    // 点 #cta：属性面板打开，输入框出现 1 个元素引用 + element-1.png
    await selectGuestElement(fixtureOrigin, "#cta");
    await waitForElementTokens(1, "点选后输入框没有出现元素引用");
    // 设计面板只在完整视图里出：半屏选中元素自动进完整视图；退出后面板收起；再选元素又进入（!3450 SG-01）
    await waitForFullView(true, "半屏选中元素后应自动进完整视图");
    await clickTestIdByDom(TID_SIDE_PANE_FULL_VIEW_TOGGLE);
    await waitForFullView(false, "点完整视图开关应退出完整视图");
    await $(`[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`).waitForDisplayed({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "退出完整视图后设计面板应收起",
    });
    await selectGuestElement(fixtureOrigin, "#cta");
    await waitForFullView(true, "退出后再选元素应再次进完整视图");
    await waitForReadyAttachment("element-1.png");
    // http 页面不是本机文件：面板写明不能直接写回
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_BROWSER_DESIGN_SOURCE_STATUS}"]`).getAttribute(
          "data-writable",
        )) === "false",
      { timeout: 10_000, timeoutMsg: "http 页面不应能写回源文件" },
    );

    // Shift + 点 #title：两个元素都在
    await selectGuestElement(fixtureOrigin, "#title", { shift: true, selectedCount: "2" });
    await waitForElementTokens(2, "Shift 点选后输入框不是 2 个元素");
    await waitForReadyAttachment("element-2.png");

    // 普通点 #cta：替换选中，#title 的引用和截图撤回
    await selectGuestElement(fixtureOrigin, "#cta");
    await waitForElementTokens(1, "普通点击后应只剩 1 个元素引用");
    await browser.waitUntil(
      async () =>
        !(await hasReadyAttachment("element-2.png")) && (await hasReadyAttachment("element-1.png")),
      { timeout: 10_000, timeoutMsg: "替换选中后截图没有对应：应只剩 element-1.png" },
    );

    // 翻页：下一页 → 计数 2 / 3，页面滚到第二个 slide。
    await clickTestIdByDom(TID_BROWSER_DESIGN_SLIDE_NEXT);
    await waitForTestIdText(TID_BROWSER_DESIGN_SLIDE_COUNTER, "2 / 3");
    await browser.waitUntil(
      async () =>
        Number(
          await guestEval(
            fixtureOrigin,
            "Math.round(document.getElementById('s2').getBoundingClientRect().top)",
          ),
        ) === 0,
      { timeout: 10_000, timeoutMsg: "翻页后页面没有滚到第二个 slide" },
    );

    // 草稿首发：上游请求带元素引用块与截图附件占位（E2E 模型不支持图片时 CLI 只留占位）
    await typeAfterLastElementToken(" E2E_DESIGN_SEND make it bigger");
    await clickV4Send();
    await waitForUpstreamRequest(
      {
        includes: [
          "E2E_DESIGN_SEND",
          "# Web page elements:",
          "E2E_DESIGN_CTA",
          "](zcode-element://",
          "[Attached image/png: element-1.png]",
        ],
      },
      "草稿首发的上游请求里没有元素引用或 element-1.png 截图附件",
      45_000,
    );
  });

  it("截图在途时换了选中：不加已取消选中的元素，只引用最后选中的", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    await openFreshBrowserTab();
    await navigate(fixtureUrl, "E2E design mode");
    await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed({ timeout: 15_000 });
    await holdGuestCapture(fixtureOrigin);
    try {
      await selectGuestElement(fixtureOrigin, "#cta");
      await browser.waitUntil(async () => (await readHeldCaptureCalls()) >= 1, {
        timeout: 10_000,
        timeoutMsg: "点选后没有开始截图",
      });
      await selectGuestElement(fixtureOrigin, "#title");
    } finally {
      await releaseHeldCapture();
    }
    await waitForElementTokens(1, "截图回来后应只引用 #title");
    await browser.pause(1_500);
    const tokens = await countElementTokens();
    if (tokens !== 1) throw new Error(`截图在途时取消选中的元素不应进输入框，实际 ${tokens} 个`);
  });

  it("属性面板改数值直接写回本机 HTML，页面不刷新；Cmd/Ctrl + Z 撤销、Shift 重做；页面变量写 :root；脚本生成的元素只读", async function () {
    this.timeout(240_000);
    await writeFile(localFile, FIXTURE_HTML, "utf-8");
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    await openFreshBrowserTab();
    await navigateBrowser(pathToFileURL(localFile).href, "E2E design mode", LOCAL_GUEST_PREFIX);
    await guestEval(LOCAL_GUEST_PREFIX, "window.__e2eMark = 1");

    await selectGuestElement(LOCAL_GUEST_PREFIX, "#title");
    await waitForWritable("true", "本机 HTML 里的标题应能写回");
    await fillField("[data-design-field=fontSize]", "46");
    await waitForSource(
      (source) =>
        source ===
        FIXTURE_HTML.replace('<h1 id="title">', '<h1 id="title" style="font-size: 46px">'),
      "改字号后源文件应只多了标题的 style",
    );
    await waitForGuest("getComputedStyle(document.getElementById('title')).fontSize", "46px");

    // 焦点还在字段上（没有未提交的输入）：Cmd/Ctrl + Z 撤销的是写回
    await browser.keys([MOD, "z"]);
    await waitForSource((source) => source === FIXTURE_HTML, "撤销后源文件应回到原样");
    await waitForGuest("getComputedStyle(document.getElementById('title')).fontSize", "40px");
    await waitForFieldValue("[data-design-field=fontSize]", "40");
    await browser.keys([MOD, Key.Shift, "z"]);
    await waitForSource(
      (source) => source.includes('<h1 id="title" style="font-size: 46px">'),
      "重做后源文件应再次是 46px",
    );

    // 页面上的真实 Cmd/Ctrl + Z（guest preload 收 isTrusted 按键，!3450 CR-01）：焦点在页面空白处时撤销 / 重做写回
    const WRITTEN = FIXTURE_HTML.replace(
      '<h1 id="title">',
      '<h1 id="title" style="font-size: 46px">',
    );
    await pressGuestUndo(LOCAL_GUEST_PREFIX);
    await waitForSource((source) => source === FIXTURE_HTML, "页面上按撤销应还原源文件");
    await pressGuestUndo(LOCAL_GUEST_PREFIX, { redo: true });
    await waitForSource((source) => source === WRITTEN, "页面上按重做应再次写回");
    // 页面脚本伪造的按键（isTrusted 为 false）不触发写回
    await guestEval(
      LOCAL_GUEST_PREFIX,
      `(() => { for (const target of [window, document, document.body]) target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true })); return true; })()`,
    );
    await browser.pause(1_500);
    if ((await readFile(localFile, "utf-8")) !== WRITTEN) {
      throw new Error("页面伪造的撤销按键不应改动源文件");
    }
    // 焦点在页面自己的输入框里（含 open Shadow DOM 里的）：Cmd/Ctrl + Z 归页面撤销输入，不撤写回
    await guestEval(
      LOCAL_GUEST_PREFIX,
      `(() => { const input = document.createElement("input"); input.id = "e2e-page-input"; document.body.prepend(input); const host = document.createElement("div"); host.id = "e2e-shadow-host"; document.body.prepend(host); host.attachShadow({ mode: "open", delegatesFocus: true }).append(document.createElement("input")); return true; })()`,
    );
    await pressGuestUndo(LOCAL_GUEST_PREFIX, { focusSelector: "#e2e-page-input" });
    await pressGuestUndo(LOCAL_GUEST_PREFIX, { focusSelector: "#e2e-shadow-host" });
    await browser.pause(1_500);
    if ((await readFile(localFile, "utf-8")) !== WRITTEN) {
      throw new Error("焦点在页面输入框里时按撤销不应改动源文件");
    }
    // 插进去的两个节点要删掉：写回按 <html> 往下每级的兄弟数对源码，多出节点后整页元素都会判成写不回
    await guestEval(
      LOCAL_GUEST_PREFIX,
      `(() => { document.getElementById("e2e-page-input")?.remove(); document.getElementById("e2e-shadow-host")?.remove(); return true; })()`,
    );

    // 多选后改圆角：两个元素都写回
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#cta", { shift: true, selectedCount: "2" });
    await waitForWritable("true", "两个元素都应能写回");
    await fillField("[data-design-field=borderRadius]", "4");
    await waitForSource(
      (source) =>
        source.includes('<h1 id="title" style="font-size: 46px; border-radius: 4px">') &&
        source.includes('<button class="cta" id="cta" style="border-radius: 4px">'),
      "多选改圆角应写到两个元素上",
    );

    // 填充的不透明度：写成 rgba()
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#cta");
    await fillField("[data-design-alpha=background]", "50");
    await waitForSource(
      (source) => source.includes("background-color: rgba(255, 107, 53, 0.5)"),
      "改填充不透明度应写成 rgba()",
    );

    // 页面变量：:root 里那条声明的值改掉
    await fillField('[data-design-variable="--title-size"]', "52");
    await waitForSource(
      (source) => source.includes("--title-size: 52px;"),
      "改页面变量应改 :root 里的声明",
    );

    // 字段里输入新值按 Esc：放弃输入，源文件不变、字段显示原值（!3450 CR-03）
    const beforeEscape = await readFile(localFile, "utf-8");
    // 完整视图里浮动输入框可能盖住面板下沿，按 DOM 聚焦，不靠坐标点击
    await browser.execute(() => {
      const field = document.querySelector<HTMLInputElement>(
        '[data-design-variable="--title-size"]',
      );
      field?.focus();
      field?.select();
    });
    await browser.keys("61".split(""));
    await browser.keys("Escape");
    await waitForFieldValue('[data-design-variable="--title-size"]', "52");
    await browser.pause(1_000);
    if ((await readFile(localFile, "utf-8")) !== beforeEscape) {
      throw new Error("按 Esc 放弃的输入不应写进源文件");
    }

    // 变量用自定义取色器改色：预览会先改掉字段值，关弹层时仍要写回（!3450 CR-02）
    const brandSwatch = await $('[data-design-variable="--brand"]').parentElement().$("button");
    await brandSwatch.click();
    await browser.execute(() => {
      const picker = document.querySelector<HTMLInputElement>('input[type="color"]');
      if (!picker) throw new Error("自定义取色器没有出现");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        picker,
        "#2255ee",
      );
      picker.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.keys("Escape");
    await waitForSource(
      (source) => source.includes("--brand: #2255EE;"),
      "自定义取色后关弹层应把颜色写进 :root",
    );

    // 透明的原色：取色器里换一个颜色再选回原色（取色器给大写 hex）后关弹层，不写回、预览还原成透明（!3450 SG-01）
    await fillField('[data-design-alpha="--brand"]', "0");
    await waitForSource(
      (source) => source.includes("--brand: rgba(34, 85, 238, 0);"),
      "把不透明度改成 0 应写成透明的 rgba()",
    );
    const beforeRepick = await readFile(localFile, "utf-8");
    await brandSwatch.click();
    await browser.execute(() => {
      const picker = document.querySelector<HTMLInputElement>('input[type="color"]');
      if (!picker) throw new Error("自定义取色器没有出现");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      for (const color of ["#ff0000", "#2255ee"]) {
        setValue?.call(picker, color);
        picker.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await browser.keys("Escape");
    await waitForGuest(
      "getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()",
      "rgba(34, 85, 238, 0)",
    );
    await browser.pause(1_000);
    if ((await readFile(localFile, "utf-8")) !== beforeRepick) {
      throw new Error("选回原色关弹层不应写回源文件");
    }

    // 取色器先取到色板上某个颜色（含吸管取到同色），再点这个色块：仍要写回（!3450 SG-01）
    await brandSwatch.click();
    const paletteHex = (await browser.execute(() => {
      const swatch = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(
        (button) =>
          /#[0-9A-F]{6}$/iu.test(button.getAttribute("aria-label") ?? "") &&
          !/2255ee/iu.test(button.getAttribute("aria-label") ?? ""),
      );
      const picker = document.querySelector<HTMLInputElement>('input[type="color"]');
      if (!swatch || !picker) throw new Error("色板或自定义取色器没有出现");
      const hex = (swatch.getAttribute("aria-label") ?? "").slice(-7);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        picker,
        hex.toLowerCase(),
      );
      picker.dispatchEvent(new Event("input", { bubbles: true }));
      swatch.setAttribute("data-e2e-palette", "1");
      return hex;
    })) as string;
    await $('[data-e2e-palette="1"]').click();
    await waitForSource(
      (source) => source.toLowerCase().includes(`--brand: ${paletteHex.toLowerCase()};`),
      "取色器取到色板同色后点色块应写回",
    );

    // 取色器预览成别的颜色后，再点当前原色的色块：不写回，页面预览还原成原值（!3450 CR-01）
    const brandBefore = (await guestEval(
      LOCAL_GUEST_PREFIX,
      "getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()",
    )) as string;
    const beforeSwatchBack = await readFile(localFile, "utf-8");
    // 上一步点色块后弹层可能还开着：先关掉，再从关闭状态打开
    await browser.keys("Escape");
    await brandSwatch.click();
    await browser.execute((original) => {
      const picker = document.querySelector<HTMLInputElement>('input[type="color"]');
      const swatch = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(
        (button) =>
          (button.getAttribute("aria-label") ?? "").toLowerCase().endsWith(original.toLowerCase()),
      );
      if (!picker || !swatch) throw new Error("色板或自定义取色器没有出现");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        picker,
        "#ff0000",
      );
      picker.dispatchEvent(new Event("input", { bubbles: true }));
      swatch.setAttribute("data-e2e-palette-back", "1");
    }, paletteHex);
    await $('[data-e2e-palette-back="1"]').click();
    await waitForGuest(
      "getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()",
      brandBefore,
    );
    await browser.pause(1_000);
    if ((await readFile(localFile, "utf-8")) !== beforeSwatchBack) {
      throw new Error("预览后点回原色色块不应写回源文件");
    }
    await browser.keys("Escape");

    // 同一个弹层里先点色块写回，再用取色器回到点之前的颜色、关弹层：写回取色器的颜色，页面与源码一致（!3450 CR-01）
    await brandSwatch.click();
    const otherHex = (await browser.execute((original) => {
      const other = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(
        (button) => {
          const label = (button.getAttribute("aria-label") ?? "").toLowerCase();
          return /#[0-9a-f]{6}$/u.test(label) && !label.endsWith(original.toLowerCase());
        },
      );
      if (!other) throw new Error("色板里没有别的颜色");
      other.click();
      return (other.getAttribute("aria-label") ?? "").slice(-7);
    }, paletteHex)) as string;
    await browser.waitUntil(
      async () =>
        (await $('[data-design-variable="--brand"]').getValue()).toLowerCase() ===
        otherHex.slice(1).toLowerCase(),
      { timeout: 10_000, timeoutMsg: "点色块写回后字段应显示色块的颜色" },
    );
    await browser.execute((original) => {
      const picker = document.querySelector<HTMLInputElement>('input[type="color"]');
      if (!picker) throw new Error("自定义取色器没有出现");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        picker,
        original.toLowerCase(),
      );
      picker.dispatchEvent(new Event("input", { bubbles: true }));
    }, paletteHex);
    await browser.keys("Escape");
    await waitForSource(
      (source) => source.toLowerCase().includes(`--brand: ${paletteHex.toLowerCase()};`),
      "色块写回后再用取色器回到原色，关弹层应写回取色器的颜色",
    );
    await waitForGuest(
      "getComputedStyle(document.documentElement).getPropertyValue('--brand').trim().toLowerCase()",
      paletteHex.toLowerCase(),
    );

    // 半透明的页面变量：面板显示原来的不透明度，只改颜色写回仍是半透明（!3450 CR-02）
    // 上一个弹层关闭有动画，等它卸掉再开下一个，免得拿到它的取色器
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('input[type="color"]').length)) ===
        0,
      { timeout: 5_000, timeoutMsg: "上一个颜色弹层没有关掉" },
    );
    await waitForFieldValue('[data-design-alpha="--veil"]', "50");
    // 这一格在面板下沿，完整视图里会被浮动输入框盖住：滚到中间再按 DOM 点开
    await browser.execute(() => {
      const trigger = document
        .querySelector('[data-design-variable="--veil"]')
        ?.parentElement?.querySelector<HTMLButtonElement>("button");
      trigger?.scrollIntoView({ block: "center" });
      trigger?.click();
    });
    await browser.execute(() => {
      const picker = document.querySelector<HTMLInputElement>(
        '[data-state="open"] input[type="color"]',
      );
      if (!picker) throw new Error("自定义取色器没有出现");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        picker,
        "#ff0000",
      );
      picker.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.keys("Escape");
    await waitForSource(
      (source) => source.includes("--veil: rgba(255, 0, 0, 0.5);"),
      "半透明变量只改颜色，写回应保留 0.5 的不透明度",
    );

    // 内联 style 里有 CSS 注释（声明之间的带分号、冒号，值里也有一段）：改别的属性，注释和其余声明原样保留（!3450 CR-03）
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#note");
    await waitForWritable("true", "带注释 style 的元素应能写回");
    await fillField("[data-design-field=fontSize]", "20");
    await waitForSource(
      (source) =>
        source.includes(
          '<p id="note" style="color: /* brand */ #111; /* note; a: b */ padding: 8px; font-size: 20px">',
        ),
      "带注释的内联 style 写回后注释与其余声明应原样保留",
    );
    await waitForGuest("getComputedStyle(document.getElementById('note')).paddingTop", "8px");
    await waitForGuest(
      "getComputedStyle(document.getElementById('note')).color",
      "rgb(17, 17, 17)",
    );

    // 尾部注释没闭合：补上 */ 再追加，追加的声明不能被吞进注释（源码里也要生效，!3450 SG-01）
    // 原来带 !important 的内联声明：改值保留 !important，页面上仍压过样式表里的 !important（!3450 CR-01）
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#imp");
    await waitForWritable("true", "带 !important 的元素应能写回");
    await fillField("[data-design-field=fontSize]", "22");
    await waitForSource(
      (source) => source.includes('<p id="imp" style="font-size: 22px !important">'),
      "改带 !important 的声明，写回应保留 !important",
    );
    await waitForGuest("getComputedStyle(document.getElementById('imp')).fontSize", "22px");

    // 简写带 !important（background: red !important）时改填充：新值也带 !important 并写在后面，源码渲染与预览一致（!3450 SG-01）
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#bgimp");
    await waitForWritable("true", "简写带 !important 的元素应能写回");
    await fillField("[data-design-field=background]", "0000FF");
    await waitForSource(
      (source) =>
        source.includes(
          '<button id="bgimp" style="background: red !important; background-color: #0000FF !important">',
        ),
      "改填充时简写带 !important，新值应带 !important 写在后面",
    );
    await waitForGuest(
      "getComputedStyle(document.getElementById('bgimp')).backgroundColor",
      "rgb(0, 0, 255)",
    );

    const beforeTodo = await readFile(localFile, "utf-8");
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#todo");
    await waitForWritable("true", "带未闭合注释 style 的元素应能写回");
    await fillField("[data-design-field=fontSize]", "21");
    await waitForSource(
      (source) => source.includes('<p id="todo" style="color: #222; /* todo */ font-size: 21px">'),
      "未闭合注释应补上结尾，追加的字号写在注释外面",
    );
    await waitForGuest("getComputedStyle(document.getElementById('todo')).fontSize", "21px");
    await waitForGuest(
      "getComputedStyle(document.getElementById('todo')).color",
      "rgb(34, 34, 34)",
    );

    // 自己写的改动不触发自动刷新
    await browser.pause(1_500);
    if ((await guestEval(LOCAL_GUEST_PREFIX, "window.__e2eMark")) !== 1) {
      throw new Error("写回源文件后页面不应自动刷新");
    }
    // 外部把文件改回更早的一次自写版本：已不是本 tab 待确认的写入，照常刷新，页面跟源码走（!3450 CR-01）
    await writeFile(localFile, beforeTodo, "utf-8");
    await browser.waitUntil(
      async () => (await guestEval(LOCAL_GUEST_PREFIX, "window.__e2eMark")) !== 1,
      { timeout: 15_000, timeoutMsg: "外部改回更早的自写版本后页面应自动刷新" },
    );
    await waitForGuest("getComputedStyle(document.getElementById('todo')).fontSize", "16px");

    // 外部写入同尺寸的内容、mtime 又被改回原值：只看 mtime + size 会当成没变；主 HTML 带内容哈希，照常刷新（!3450 CR-02）
    // 先把 mtime 定到整秒（这次 touch 本身会刷新一次），等页面重新加载完再做同尺寸改动并把 mtime 改回同一个整秒
    const fixedSeconds = Math.floor(Date.now() / 1000) - 60;
    await utimes(localFile, fixedSeconds, fixedSeconds);
    await browser.pause(2_000);
    await waitForGuest("document.getElementById('todo').textContent", "E2E_TODO");
    await guestEval(LOCAL_GUEST_PREFIX, "window.__e2eMark = 2");
    const beforeSameSize = await readFile(localFile, "utf-8");
    await writeFile(localFile, beforeSameSize.replace("E2E_TODO", "E2E_TODX"), "utf-8");
    await utimes(localFile, fixedSeconds, fixedSeconds);
    if ((await stat(localFile)).mtimeMs !== fixedSeconds * 1000) {
      throw new Error("没能把 mtime 改回原值，这一步验不了同尺寸改动");
    }
    await browser.waitUntil(
      async () => (await guestEval(LOCAL_GUEST_PREFIX, "window.__e2eMark")) !== 2,
      { timeout: 15_000, timeoutMsg: "同尺寸、mtime 不变的外部改动后页面应自动刷新" },
    );
    await waitForGuest("document.getElementById('todo').textContent", "E2E_TODX");

    // 脚本插入的元素：源码里对不上，面板只读；插入后它后面的兄弟也对不上（不能按序号写到别的元素上）
    await guestEval(
      LOCAL_GUEST_PREFIX,
      "(() => { const d = document.createElement('div'); d.id = 'generated'; d.textContent = 'E2E_GENERATED'; document.getElementById('s1').prepend(d); return true; })()",
    );
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#generated");
    await waitForWritable("false", "脚本生成的元素不应能写回");
    if (!(await $("[data-design-field=fontSize]").getAttribute("disabled"))) {
      throw new Error("写不回的元素，数值框应只读");
    }
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#title");
    await waitForWritable("false", "兄弟节点被脚本改过后不应按序号写回");
  });

  it("写回的边界：非 UTF-8 文件只读且字节不变；带内联子元素的文字不能双击改；写回失败时页面撤回到源码的样子", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    await openFreshBrowserTab();

    // GBK 文件（!3450 CR-01）：严格按 UTF-8 解码失败，面板只读，文件一个字节都不动
    const gbkFile = join(localDir, "gbk.html");
    const gbkBytes = Buffer.concat([
      Buffer.from(
        '<!doctype html><html data-zcode-design><head><meta charset="gbk"><title>E2E gbk</title></head><body><h1 id="gbk">',
      ),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), // 「中文」的 GBK 编码
      Buffer.from("</h1></body></html>"),
    ]);
    await writeFile(gbkFile, gbkBytes);
    await navigateBrowser(pathToFileURL(gbkFile).href, "E2E gbk", LOCAL_GUEST_PREFIX);
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#gbk");
    await waitForWritable("false", "非 UTF-8 文件不应能写回");
    if (!(await $("[data-design-field=fontSize]").getAttribute("disabled"))) {
      throw new Error("非 UTF-8 文件的数值框应只读");
    }
    if (!(await readFile(gbkFile)).equals(gbkBytes)) throw new Error("非 UTF-8 文件不应被改动");

    // 带 <strong> 的段落（!3450 SG-01）：样式能写回，但面板不出文字框；只含文字的段落在面板里改字并写回
    const richFile = join(localDir, "rich.html");
    await writeFile(
      richFile,
      '<!doctype html><html data-zcode-design><head><title>E2E rich</title></head><body><p id="rich">E2E <strong>RICH</strong></p><p id="plaintext">E2E_PLAIN_TEXT</p></body></html>',
      "utf-8",
    );
    await navigateBrowser(pathToFileURL(richFile).href, "E2E rich", LOCAL_GUEST_PREFIX);
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#rich");
    await waitForWritable("true", "带内联子元素的段落样式仍能写回");
    await browser.pause(500);
    if (await $("[data-design-field=text]").isExisting()) {
      throw new Error("源码里不是只含文字的元素，面板不应出文字框");
    }
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#plaintext");
    await waitForWritable("true", "只含文字的段落应能写回");
    await fillField("[data-design-field=text]", "E2E_PANEL_TEXT");
    await browser.waitUntil(
      async () =>
        (await readFile(richFile, "utf-8")).includes('<p id="plaintext">E2E_PANEL_TEXT</p>'),
      { timeout: 10_000, timeoutMsg: "面板改字应写回源码" },
    );

    // 页面伪造设计运行时消息（!3450 CR-01）：页面这边没有能引起写回的事件，文件不变
    const beforeForge = await readFile(richFile, "utf-8");
    await guestEval(
      LOCAL_GUEST_PREFIX,
      `(() => { for (const events of [[{ type: "edit-commit", property: "text", value: "E2E_FORGED" }], [{ type: "history", redo: false }]]) window.postMessage({ __zcodeDesign: 1, events }, "*"); return true; })()`,
    );
    await browser.pause(2_000);
    if ((await readFile(richFile, "utf-8")) !== beforeForge) {
      throw new Error("页面伪造的消息不应改动源文件");
    }

    // 写回失败（文件只读，写入报错，!3450 SG-02）：页面上的预览撤回到源码的样子，文件不变
    await writeFile(localFile, FIXTURE_HTML, "utf-8");
    await navigateBrowser(pathToFileURL(localFile).href, "E2E design mode", LOCAL_GUEST_PREFIX);
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#title");
    await waitForWritable("true", "标题应能写回");
    await chmod(localFile, 0o444);
    try {
      await fillField("[data-design-field=fontSize]", "30");
      await waitForGuest("document.getElementById('title').getAttribute('style') ?? ''", "");
      await waitForGuest("getComputedStyle(document.getElementById('title')).fontSize", "40px");
      if ((await readFile(localFile, "utf-8")) !== FIXTURE_HTML) {
        throw new Error("写入失败时源文件不应变化");
      }
    } finally {
      await chmod(localFile, 0o644);
    }
  });

  it("自写之后一起改了 CSS 照常刷新；带 text-transform 的元素改字按源码大小写写回", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    await openFreshBrowserTab();

    // !3450 CR-01：先用面板写回一次主 HTML，再在同一刻改页面引用的 CSS 和同目录另一个文件（合并成一次变化事件）
    const styledFile = join(localDir, "styled.html");
    const cssFile = join(localDir, "styled.css");
    await writeFile(cssFile, "#box { color: rgb(0, 0, 255); }", "utf-8");
    await writeFile(
      styledFile,
      '<!doctype html><html data-zcode-design><head><title>E2E styled</title><link rel="stylesheet" href="styled.css"></head><body><h1 id="box">E2E_BOX</h1><button id="cta" style="text-transform: uppercase">Submit order</button></body></html>',
      "utf-8",
    );
    await navigateBrowser(pathToFileURL(styledFile).href, "E2E styled", LOCAL_GUEST_PREFIX);
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#box");
    await waitForWritable("true", "标题应能写回");
    await fillField("[data-design-field=fontSize]", "30");
    await waitForGuest("getComputedStyle(document.getElementById('box')).fontSize", "30px");
    await browser.pause(1_000);
    await guestEval(LOCAL_GUEST_PREFIX, "window.__e2eStyledMark = 1");
    await Promise.all([
      writeFile(cssFile, "#box { color: rgb(255, 0, 0); }", "utf-8"),
      writeFile(join(localDir, "styled-other.txt"), "E2E_OTHER", "utf-8"),
    ]);
    await waitForGuest("getComputedStyle(document.getElementById('box')).color", "rgb(255, 0, 0)");
    if ((await guestEval(LOCAL_GUEST_PREFIX, "window.__e2eStyledMark")) === 1) {
      throw new Error("自写之后外部改了 CSS，页面应自动刷新");
    }

    // !3450 SG-01：按钮带 text-transform: uppercase，在面板里改字，源码按原来的大小写写回
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#cta");
    await waitForWritable("true", "按钮应能写回");
    await fillField("[data-design-field=text]", "Submit orders");
    await browser.waitUntil(
      async () => (await readFile(styledFile, "utf-8")).includes(">Submit orders</button>"),
      { timeout: 10_000, timeoutMsg: "面板改字应按输入的大小写写回（不是 SUBMIT ORDERS）" },
    );
  });

  it("输入框不收元素引用时，每轮点选只提示一次：写回重读选中不再弹，退出点选后再选会再提示", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    await openFreshBrowserTab();
    const noticeFile = join(localDir, "notice.html");
    await writeFile(
      noticeFile,
      '<!doctype html><html data-zcode-design><head><title>E2E notice</title></head><body><h1 id="a" style="font-size: 30px">E2E_A</h1><h2 id="b">E2E_B</h2></body></html>',
      "utf-8",
    );
    await navigateBrowser(pathToFileURL(noticeFile).href, "E2E notice", LOCAL_GUEST_PREFIX);
    // !3548 第五轮 CR-01：「加引用」一律按输入框不收处理；同时数提示弹了几次
    await browser.execute(() => {
      const w = window as unknown as {
        __e2eNotices: number;
        __e2eDispatch: typeof window.dispatchEvent;
      };
      w.__e2eNotices = 0;
      w.__e2eDispatch = window.dispatchEvent.bind(window);
      // 「加引用」事件不派发、按没人收下返回（dispatchEvent 未被 preventDefault 时返回 true）
      window.dispatchEvent = (event: Event) =>
        event.type === "zcode:web-element-context-add-to-chat" ? true : w.__e2eDispatch(event);
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            const text = node.textContent ?? "";
            if (/当前没有可接收的输入框|No composer can receive/.test(text)) w.__e2eNotices += 1;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const readNotices = async () =>
      (await browser.execute(
        () => (window as unknown as { __e2eNotices: number }).__e2eNotices,
      )) as number;

    await selectGuestElement(LOCAL_GUEST_PREFIX, "#a");
    await browser.waitUntil(async () => (await readNotices()) >= 1, {
      timeout: 10_000,
      timeoutMsg: "输入框不收引用时应提示一次",
    });
    await waitForWritable("true", "标题应能写回");
    await fillField("[data-design-field=fontSize]", "31");
    await waitForGuest("getComputedStyle(document.getElementById('a')).fontSize", "31px");
    await fillField("[data-design-field=fontSize]", "32");
    await waitForGuest("getComputedStyle(document.getElementById('a')).fontSize", "32px");
    await browser.pause(1_500);
    if ((await readNotices()) !== 1) {
      throw new Error(`同一轮点选里写回后不应再提示，实际弹了 ${await readNotices()} 次`);
    }

    // 退出点选再进来选：新一轮，再提示一次
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#b");
    await browser.waitUntil(async () => (await readNotices()) === 2, {
      timeout: 10_000,
      timeoutMsg: "退出点选后重新选中应再提示一次",
    });

    // 只拒一部分（#b）：#a 进了输入框、#b 被拒时提示一次，之后写回重读选中仍不再弹（一次性提示的 guard）。
    // 注：从界面点选每次对账只新增一个元素，同一次对账「有收有拒」走不到，accepted && !rejected 那条分支这里测不到。
    await browser.execute(() => {
      const w = window as unknown as { __e2eDispatch: typeof window.dispatchEvent };
      window.dispatchEvent = (event: Event) =>
        event.type === "zcode:web-element-context-add-to-chat" &&
        JSON.stringify((event as CustomEvent).detail ?? {}).includes("E2E_B")
          ? true
          : w.__e2eDispatch(event);
    });
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#a");
    await selectGuestElement(LOCAL_GUEST_PREFIX, "#b", { shift: true, selectedCount: "2" });
    await browser.waitUntil(async () => (await readNotices()) === 3, {
      timeout: 10_000,
      timeoutMsg: "部分不收时应提示一次",
    });
    await fillField("[data-design-field=fontSize]", "33");
    await waitForGuest("getComputedStyle(document.getElementById('b')).fontSize", "33px");
    await fillField("[data-design-field=fontSize]", "34");
    await waitForGuest("getComputedStyle(document.getElementById('b')).fontSize", "34px");
    await browser.pause(1_500);
    if ((await readNotices()) !== 3) {
      throw new Error(`部分收下时写回后不应再提示，实际累计 ${await readNotices()} 次`);
    }
    await browser.execute(() => {
      const w = window as unknown as { __e2eDispatch: typeof window.dispatchEvent };
      window.dispatchEvent = w.__e2eDispatch;
    });
  });

  it("再点一次「选择元素」退出点选：页面点击不再被拦截、引用留在输入框；普通网页也是同一套点选，调整面板只读", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();
    await openFreshBrowserTab();
    await navigate(fixtureUrl, "E2E design mode");
    await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed({ timeout: 15_000 });
    // 在输入框正文里删掉元素 token：页面上同步取消选中
    await selectGuestElement(fixtureOrigin, "#title");
    await waitForElementTokens(1, "点选后没有元素引用");
    await deleteLastElementToken();
    await browser.waitUntil(async () => (await readInspectorSelectedCount()) === "0", {
      timeout: 5_000,
      timeoutMsg: "在输入框删掉引用后页面上应取消选中",
    });
    await selectGuestElement(fixtureOrigin, "#cta");
    await waitForElementTokens(1, "点选后没有元素引用");
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    await browser.waitUntil(
      async () => (await guestEval(fixtureOrigin, "document.documentElement.style.cursor")) === "",
      { timeout: 5_000, timeoutMsg: "再点「选择元素」后页面仍停在选择状态" },
    );
    await browser.waitUntil(async () => (await readInspectorSelectedCount()) === "0", {
      timeout: 5_000,
      timeoutMsg: "退出点选后应取消选中",
    });
    await waitForElementTokens(1, "退出点选后输入框里的引用应留着");
    await guestEval(
      fixtureOrigin,
      "window.__e2eClicks = 0; document.getElementById('cta').addEventListener('click', (e) => { if (!e.defaultPrevented) window.__e2eClicks += 1; }); true",
    );
    await clickGuestElement(fixtureOrigin, "#cta");
    await browser.waitUntil(
      async () => (await guestEval(fixtureOrigin, "window.__e2eClicks")) === 1,
      {
        timeout: 5_000,
        timeoutMsg: "退出点选后页面按钮的点击被拦截了",
      },
    );

    // 普通网页：不出设计工具行；「选择元素」和设计稿是同一套点选（11-06 统一）：
    // 元素进输入框正文成 token、不出原来的元素标签，调整面板只读并说明交给 Agent
    await navigate(`${fixtureOrigin}/plain`, "E2E plain page");
    await browser.pause(1_000);
    const tokensBefore = await countElementTokens();
    await selectGuestElement(fixtureOrigin, "#plain");
    await waitForElementTokens(tokensBefore + 1, "普通网页点选后元素应进输入框成 token");
    if ((await readDataCount(TID_WEB_ELEMENT_CONTEXT_CHIP)) !== null) {
      throw new Error("普通网页点选后不应再出原来的元素标签");
    }
    if (await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).isExisting()) {
      throw new Error("普通网页不应出现设计工具行");
    }
    await waitForWritable("false", "普通网页的调整面板应只读");
    if (await $("[data-design-field=fontSize]").isEnabled()) {
      throw new Error("普通网页的调整面板字段应不可编辑");
    }
    await waitForFullView(true, "普通网页点选后同样进完整视图");

    // 点选开着换页：退出点选、面板收起，新页面不再拦截点击（!3548 CR-01）
    await navigate(fixtureUrl, "E2E design mode");
    await $(`[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`).waitForExist({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "换页后调整面板应收起",
    });
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_BUTTON}"]`).getAttribute(
          "aria-pressed",
        )) === "false",
      { timeout: 5_000, timeoutMsg: "换页后应退出点选" },
    );

    // 设计稿 A 选中后换到同样结构的设计稿 B 再刷新：不能把 A 的选中按选择器推回 B（!3548 第二轮 CR-01）
    await selectGuestElement(fixtureOrigin, "#cta");
    await navigate(`${fixtureOrigin}/design-b`, "E2E design mode");
    await $(`[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`).waitForExist({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "换到设计稿 B 后调整面板应收起",
    });
    await clickTestIdByDom(TID_BROWSER_REFRESH_BUTTON);
    await browser.pause(2_000);
    // 重新进点选、手动打开调整面板看宿主记着的选中：只能是 0 个
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
    await clickTestIdByDom(TID_BROWSER_DESIGN_PANEL_BUTTON);
    await $(`[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`).waitForExist({
      timeout: 10_000,
      timeoutMsg: "点工具行的「调整面板」后面板没有打开",
    });
    if ((await readInspectorSelectedCount()) !== "0") {
      throw new Error("刷新设计稿 B 后宿主还留着设计稿 A 的选中");
    }

    // 单页应用换路由（pushState）不重新注入：同样要退出点选、收起面板（!3548 第三轮）
    await selectGuestElement(fixtureOrigin, "#cta");
    await guestEval(fixtureOrigin, "history.pushState({}, '', '/design-c'); true");
    await $(`[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`).waitForExist({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "单页换路由后调整面板应收起",
    });
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_BUTTON}"]`).getAttribute(
          "aria-pressed",
        )) === "false",
      { timeout: 5_000, timeoutMsg: "单页换路由后应退出点选" },
    );

    // 前进 / 后退（popstate）同样退出：后退回 /design-b
    await selectGuestElement(fixtureOrigin, "#cta");
    await guestEval(fixtureOrigin, "history.back(); true");
    await $(`[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`).waitForExist({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "后退后调整面板应收起",
    });
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_BUTTON}"]`).getAttribute(
          "aria-pressed",
        )) === "false",
      { timeout: 5_000, timeoutMsg: "后退后应退出点选" },
    );
  });
});

const navigate = (url: string, title: string) => navigateBrowser(url, title, fixtureOrigin);

async function waitForWritable(expected: "true" | "false", timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${TID_BROWSER_DESIGN_SOURCE_STATUS}"]`).getAttribute(
        "data-writable",
      )) === expected,
    { timeout: 10_000, timeoutMsg },
  );
}

/** 面板字段里输入值后回车提交（焦点留在字段上） */
async function fillField(selector: string, value: string): Promise<void> {
  const field = await $(selector);
  await field.waitForEnabled({ timeout: 10_000, timeoutMsg: `${selector} 不可编辑` });
  // 刚用 Esc 关掉的取色弹层收起时会把焦点还给它的触发按钮：等弹层真正卸掉再聚焦，免得敲到一半焦点被拿走
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => document.querySelector("[data-radix-popper-content-wrapper]") === null,
      )) as boolean,
    { timeout: 5_000, timeoutMsg: "取色弹层没有收起" },
  );
  // 完整视图里浮动输入框可能盖住面板下沿，按 DOM 聚焦并全选，不靠坐标点击
  // 焦点可能刚被页面（webview）或收起的弹层拿走：聚焦后停一下，焦点还在这个字段上再敲字
  await browser.waitUntil(
    async () => {
      await browser.execute((target) => {
        const input = document.querySelector<HTMLInputElement>(target);
        input?.scrollIntoView({ block: "center" });
        input?.focus();
        input?.select();
      }, selector);
      await browser.pause(150);
      return (await browser.execute(
        (target) => document.activeElement === document.querySelector(target),
        selector,
      )) as boolean;
    },
    { timeout: 5_000, timeoutMsg: `${selector} 拿不到焦点` },
  );
  await browser.keys(value.split(""));
  await browser.keys("Enter");
}

async function waitForFullView(expected: boolean, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const mode = await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HOST}"]`).getAttribute(
        "data-side-pane-full-view-host",
      );
      return (mode !== null && mode !== "normal") === expected;
    },
    { timeout: 10_000, timeoutMsg },
  );
}

async function waitForFieldValue(selector: string, value: string): Promise<void> {
  await browser.waitUntil(async () => (await $(selector).getValue()) === value, {
    timeout: 10_000,
    timeoutMsg: `${selector} 应显示 ${value}`,
  });
}

async function waitForSource(
  predicate: (source: string) => boolean,
  timeoutMsg: string,
): Promise<void> {
  let last = "";
  try {
    await browser.waitUntil(
      async () => {
        last = await readFile(localFile, "utf-8");
        return predicate(last);
      },
      { timeout: 10_000 },
    );
  } catch {
    throw new Error(`${timeoutMsg}；当前源文件：\n${last}`);
  }
}

async function waitForGuest(expression: string, expected: string): Promise<void> {
  await browser.waitUntil(
    async () => (await guestEval(LOCAL_GUEST_PREFIX, expression)) === expected,
    { timeout: 10_000, timeoutMsg: `页面上 ${expression} 应为 ${expected}` },
  );
}
