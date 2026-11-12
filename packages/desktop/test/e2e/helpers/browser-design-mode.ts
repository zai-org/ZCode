import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_DESIGN_INSPECTOR,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  clickPluginControl,
  getPluginList,
  openPluginSettings,
  setPluginEnabledThroughUi,
  waitForPluginCard,
} from "#e2e/helpers/plugin-management-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

/** Design 默认关闭；设计交互用例必须像用户一样显式启用。 */
export async function enableDesignPlugin(): Promise<void> {
  const pluginId = "design@zcode-plugins-official";
  if ((await getPluginList()).plugins.some((plugin) => plugin.id === pluginId && plugin.enabled))
    return;
  await openPluginSettings();
  await waitForPluginCard(pluginId, 60_000);
  await clickPluginControl("plugin-store-card", { pluginId });
  await setPluginEnabledThroughUi(pluginId, true);
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await prepareV4ConversationE2E({ skipProvider: true });
}

/**
 * 内置浏览器设计工具 E2E（BU-E2E-021..023）共用的页面操作：
 * 地址栏导航、在 guest 里求值、对 guest 元素发真实鼠标点击（可带 Shift）、点选元素、读输入框里的元素引用与截图附件。
 * guest 按 URL 前缀定位（main 侧 webContents），点击走 sendInputEvent，与用户在 guest 里点击同一条路径。
 */

export async function startFixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("设计模式 fixture server 没有绑定端口");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export async function closeFixtureServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** 地址栏输入 URL 回车，等 guest 标题变成 title（guest 按 urlPrefix 定位） */
export async function navigateBrowser(
  url: string,
  title: string,
  urlPrefix: string = url,
): Promise<void> {
  const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
  await addressInput.setValue(url);
  await addressInput.click();
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await guestEval(urlPrefix, "document.title")) === title, {
    timeout: 30_000,
    timeoutMsg: `内置浏览器没有打开 ${url}`,
  });
}

/** 在 URL 以 urlPrefix 开头的 guest 里求值（main 侧 webContents.executeJavaScript）；没找到返回 null */
export function guestEval(urlPrefix: string, expression: string): Promise<unknown> {
  return browser.electron.execute(
    async (electron, code, prefix) => {
      const guest = electron.webContents
        .getAllWebContents()
        .find(
          (contents) =>
            !contents.isDestroyed() &&
            contents.getType() === "webview" &&
            contents.getURL().startsWith(prefix),
        );
      return guest ? guest.executeJavaScript(code) : null;
    },
    expression,
    urlPrefix,
  ) as Promise<unknown>;
}

/**
 * 对 guest 发真实的 Cmd/Ctrl + Z（redo 时加 Shift）：main 侧 sendInputEvent，与用户在页面里按键同一条路径，
 * 页面收到的是 isTrusted 的按键。focusSelector 给出时先让页面里该元素获得焦点，否则先让焦点回到 body。
 */
export async function pressGuestUndo(
  urlPrefix: string,
  options: { redo?: boolean; focusSelector?: string } = {},
): Promise<void> {
  const pressed = await browser.electron.execute(
    async (electron, prefix, redo, focusSelector) => {
      const guest = electron.webContents
        .getAllWebContents()
        .find(
          (contents) =>
            !contents.isDestroyed() &&
            contents.getType() === "webview" &&
            contents.getURL().startsWith(prefix),
        );
      if (!guest) return false;
      guest.focus();
      const focused = (await guest.executeJavaScript(
        focusSelector
          ? `(() => { const el = document.querySelector(${JSON.stringify(focusSelector)}); el?.focus(); return document.activeElement === el; })()`
          : `(() => { document.activeElement?.blur?.(); return true; })()`,
      )) as boolean;
      if (!focused) return false;
      const modifiers: Array<"meta" | "control" | "shift"> = [
        process.platform === "darwin" ? "meta" : "control",
        ...(redo ? (["shift"] as const) : []),
      ];
      guest.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers });
      return true;
    },
    urlPrefix,
    options.redo === true,
    options.focusSelector ?? "",
  );
  if (!pressed) throw new Error(`没能在 ${urlPrefix} 页面里按下撤销键`);
}

/** 对 guest 里的元素中心发真实鼠标移动 + 点击；shift 为 true 时按住 Shift 点 */
export async function clickGuestElement(
  urlPrefix: string,
  selector: string,
  shift = false,
): Promise<void> {
  const clicked = await browser.electron.execute(
    async (electron, targetSelector, prefix, withShift) => {
      const guest = electron.webContents
        .getAllWebContents()
        .find(
          (contents) =>
            !contents.isDestroyed() &&
            contents.getType() === "webview" &&
            contents.getURL().startsWith(prefix),
        );
      if (!guest) return false;
      const point = (await guest.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(targetSelector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`,
      )) as { x: number; y: number } | null;
      if (!point) return false;
      const modifiers: Array<"shift"> = withShift ? ["shift"] : [];
      guest.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y, modifiers });
      guest.sendInputEvent({
        type: "mouseDown",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        modifiers,
      });
      guest.sendInputEvent({
        type: "mouseUp",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        modifiers,
      });
      return true;
    },
    selector,
    urlPrefix,
    shift,
  );
  if (!clicked) throw new Error(`测试页里没有找到 ${selector}`);
}

/**
 * main 里把这个 guest 的 capturePage 换成「挂起直到放行」：用来确定地制造截图在途的窗口。
 * 返回后先用 readHeldCaptureCalls 等取帧真的开始，再做在途期间的操作，最后 releaseHeldCapture 放行并恢复原方法。
 */
export async function holdGuestCapture(urlPrefix: string): Promise<void> {
  const held = await browser.electron.execute((electron, prefix) => {
    const guest = electron.webContents
      .getAllWebContents()
      .find(
        (contents) =>
          !contents.isDestroyed() &&
          contents.getType() === "webview" &&
          contents.getURL().startsWith(prefix),
      );
    if (!guest) return false;
    const original = guest.capturePage.bind(guest);
    const state = { calls: 0, release: [] as Array<() => void>, guestId: guest.id };
    (globalThis as { __e2eHeldCapture?: typeof state }).__e2eHeldCapture = state;
    (guest as { capturePage: () => Promise<Electron.NativeImage> }).capturePage = () => {
      state.calls += 1;
      return new Promise((resolve, reject) => {
        state.release.push(() => {
          original().then(resolve, reject);
        });
      });
    };
    return true;
  }, urlPrefix);
  if (!held) throw new Error(`没有找到 ${urlPrefix} 的 guest，无法挂起截图`);
}

export function readHeldCaptureCalls(): Promise<number> {
  return browser.electron.execute(
    () => (globalThis as { __e2eHeldCapture?: { calls: number } }).__e2eHeldCapture?.calls ?? -1,
  ) as Promise<number>;
}

/** 放行所有挂起的取帧，并去掉替身恢复原型上的 capturePage */
export async function releaseHeldCapture(): Promise<void> {
  await browser.electron.execute((electron) => {
    const state = (
      globalThis as {
        __e2eHeldCapture?: { release: Array<() => void>; guestId: number };
      }
    ).__e2eHeldCapture;
    if (!state) return;
    for (const release of state.release.splice(0)) release();
    const guest = electron.webContents.fromId(state.guestId);
    if (guest) delete (guest as { capturePage?: unknown }).capturePage;
  });
}

/**
 * 地址栏「选择元素」= 展示设计工具并开始点选：没在点选就先点一下按钮、等页面进入选择状态，
 * 再对 guest 元素发真实点击（shift 时加进选中），等属性面板显示 selectedCount 个选中元素。
 * 普通网页点选不自动开属性面板（11-11），传 plainPage 时只点不等面板，调用方自己等输入框里的引用。
 */
export async function selectGuestElement(
  urlPrefix: string,
  selector: string,
  {
    shift = false,
    selectedCount = "1",
    plainPage = false,
  }: { shift?: boolean; selectedCount?: string; plainPage?: boolean } = {},
): Promise<void> {
  const picker = $(`[data-testid="${TID_BROWSER_ELEMENT_PICKER_BUTTON}"]`);
  if ((await picker.getAttribute("aria-pressed")) !== "true") {
    await clickTestIdByDom(TID_BROWSER_ELEMENT_PICKER_BUTTON);
  }
  await browser.waitUntil(
    async () =>
      (await guestEval(urlPrefix, "document.documentElement.style.cursor")) === "crosshair",
    { timeout: 15_000, timeoutMsg: "点「选择元素」后页面没有进入选择状态" },
  );
  await clickGuestElement(urlPrefix, selector, shift);
  if (plainPage) return;
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (id) =>
          document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-selected-count") ??
          null,
        TID_BROWSER_DESIGN_INSPECTOR,
      )) === selectedCount,
    { timeout: 10_000, timeoutMsg: `点选 ${selector} 后属性面板不是 ${selectedCount} 个选中元素` },
  );
}

/** 输入框里 data-count 的读数；元素不存在时为 null（0 条上下文时 chip 容器不渲染） */
export function readDataCount(testId: string): Promise<string | null> {
  return browser.execute(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-count") ?? null,
    testId,
  ) as Promise<string | null>;
}

export async function waitForDataCount(
  testId: string,
  count: string | null,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(async () => (await readDataCount(testId)) === count, {
    timeout: 20_000,
    timeoutMsg,
  });
}

/**
 * 输入框里名为 fileName 的元素截图附件（不分上传状态）。元素 token 的截图不进附件行，
 * 输入框根节点的 data-composer-element-screenshots 记着「文件名:上传状态」；上传失败的会回到附件行显示。
 */
function readElementScreenshots(fileName: string): Promise<{ count: number; ready: number }> {
  return browser.execute((name) => {
    const entries = [...document.querySelectorAll("[data-composer-element-screenshots]")]
      .flatMap((node) => (node.getAttribute("data-composer-element-screenshots") ?? "").split(" "))
      .filter((entry) => entry.slice(0, entry.lastIndexOf(":")) === name);
    const visible = document.querySelectorAll(
      `[data-composer-file-attachments-row] img[alt="${name}"]`,
    ).length;
    return {
      count: entries.length + visible,
      ready: entries.filter((entry) => entry.endsWith(":ready")).length,
    };
  }, fileName) as Promise<{ count: number; ready: number }>;
}

export async function countAttachments(fileName: string): Promise<number> {
  return (await readElementScreenshots(fileName)).count;
}

export async function hasReadyAttachment(fileName: string): Promise<boolean> {
  return (await readElementScreenshots(fileName)).ready > 0;
}

export async function waitForReadyAttachment(fileName: string): Promise<void> {
  await browser.waitUntil(() => hasReadyAttachment(fileName), {
    timeout: 20_000,
    timeoutMsg: `输入框没有出现 ${fileName} 截图附件`,
  });
}

export async function waitForTestIdText(testId: string, text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? "",
        testId,
      )) === text,
    { timeout: 15_000, timeoutMsg: `${testId} 没有显示 ${text}` },
  );
}

/** 设计稿页面点选的元素在输入框正文里是元素 token（mention category elements） */
export const ELEMENT_TOKEN_SELECTOR = '[data-mention-category="elements"]';

export function countElementTokens(): Promise<number> {
  return browser.execute(
    (selector) => document.querySelectorAll(selector).length,
    ELEMENT_TOKEN_SELECTOR,
  ) as Promise<number>;
}

export async function waitForElementTokens(count: number, timeoutMsg: string): Promise<void> {
  let last = -1;
  try {
    await browser.waitUntil(async () => (last = await countElementTokens()) === count, {
      timeout: 20_000,
    });
  } catch {
    const labels = await browser.execute(
      (selector) =>
        [...document.querySelectorAll(selector)].map((token) => token.textContent ?? ""),
      ELEMENT_TOKEN_SELECTOR,
    );
    throw new Error(`${timeoutMsg}（应为 ${count} 个，实际 ${last} 个：${labels.join(" / ")}）`);
  }
}

/** 把光标放到最后一个元素 token 后面，按退格删掉它（与用户在输入框里删 token 同一路径） */
export async function deleteLastElementToken(): Promise<void> {
  const placed = await browser.execute((selector) => {
    const token = [...document.querySelectorAll(selector)].at(-1);
    const editor = token?.closest<HTMLElement>("[contenteditable=true]");
    if (!token || !editor) return false;
    editor.focus();
    const range = document.createRange();
    range.setStartAfter(token);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }, ELEMENT_TOKEN_SELECTOR);
  if (!placed) throw new Error("输入框里没有元素 token");
  await browser.keys("Backspace");
}

/** 光标放到最后一个元素 token 后面再敲字：整体改写输入框会把 token 一起清掉。 */
export async function typeAfterLastElementToken(text: string): Promise<void> {
  const placed = await browser.execute((selector) => {
    const token = [...document.querySelectorAll(selector)].at(-1);
    const editor = token?.closest<HTMLElement>("[contenteditable=true]");
    if (!token || !editor) return false;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }, ELEMENT_TOKEN_SELECTOR);
  if (!placed) throw new Error("输入框里没有元素 token");
  await browser.keys(text.split(""));
}
