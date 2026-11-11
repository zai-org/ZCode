import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";

const ORDER_KEY = "zcode-project-sidebar-preferences";
const PROJECTS = '[data-testid="project-section"] [data-project-id]';

function readProjectOrder() {
  return browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
        (node) => node.dataset.projectId!,
      ),
    PROJECTS,
  );
}

async function createProject(name: string): Promise<string> {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').setValue(name);
  await $('[data-testid="virtual-project-save"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed({ reverse: true });
  const row = $(`[data-project-name="${name}"]`);
  await row.waitForDisplayed();
  const id = await row.getAttribute("data-project-id");
  if (!id) throw new Error(`PRO02: project id missing for ${name}`);
  return id;
}

/** 已有手动顺序的真实两端接收新项目；不能用空 localStorage 掩盖后追加问题。 */
export async function verifyNewProjectOrderOnMobile(): Promise<void> {
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
  const a = await createProject("E2E_PRO02_A");
  const b = await createProject("E2E_PRO02_B");
  // 创建顺序为 B/A，使用真实键盘拖拽改为 A/B，证明历史手动顺序未被 Host position 覆盖。
  await browser.execute((id) => {
    document
      .querySelector<HTMLElement>(
        `[data-project-id="${id}"] [data-testid="virtual-project-toggle"]`,
      )!
      .focus();
  }, a);
  await browser.keys("Space");
  await browser.keys("ArrowUp");
  await $(`[data-project-id="${b}"] [data-testid="project-drop-indicator"]`).waitForDisplayed();
  await browser.keys("Space");
  await browser.waitUntil(
    async () => {
      const order = await readProjectOrder();
      return order[0] === a && order[1] === b;
    },
    { timeoutMsg: "PRO02: desktop manual project order was not saved" },
  );
  const previousOrder = await readProjectOrder();

  let receivePair!: (value: string) => void;
  const pairing = new Promise<string>((resolve) => {
    receivePair = resolve;
  });
  const receiver = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method !== "OPTIONS") {
      let value = "";
      for await (const chunk of request) value += String(chunk);
      receivePair(value);
    }
    response.end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("PRO02: pairing receiver missing");
  let mobile: Browser | undefined;
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;
  try {
    await installHandoffRpcProbe();
    await browser.execute((port) => {
      const clipboard = navigator.clipboard;
      const original = clipboard.writeText.bind(clipboard);
      Object.assign(window, {
        __restoreProjectOrderClipboard: () => {
          clipboard.writeText = original;
        },
      });
      clipboard.writeText = async (value) => {
        await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: value });
      };
    }, address.port);
    await $(
      'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
    ).click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const button = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[data-testid="web-remote-control-dialog-scroll"] button',
            ),
          ).find((node) => /^(复制链接|Copy link)$/.test(node.innerText.trim()) && !node.disabled);
          button?.click();
          return Boolean(button);
        }),
      { timeout: 60_000 },
    );
    const pairUrl = await pairing;
    if (new URL(pairUrl).hostname !== "127.0.0.1")
      throw new Error("PRO02: local Web fixture required");
    mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
      args: process.env.ZCODE_E2E_BROWSER_NO_PROXY === "1" ? ["--no-proxy-server"] : [],
    });
    const context = await mobile.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(context);
    // 偏好保存完整 Host/project 身份，不能用 DOM 的裸项目 ID 播种，否则会被当成全新项目。
    await context.addInitScript(
      ({ key, order }) => {
        if (!localStorage.getItem(key))
          localStorage.setItem(key, JSON.stringify({ view: "projects", order }));
      },
      { key: ORDER_KEY, order: previousOrder.map((id) => JSON.stringify(["local", id])) },
    );
    const page = await context.newPage();
    await openMobilePairingPage(page, pairUrl, {
      artifactDir,
      caseMarker: "PRO02",
      phase: "new-project-order",
      readySelector: '[data-project-name="E2E_PRO02_A"]',
    });
    const mobileOrder = () =>
      page
        .locator(PROJECTS)
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.projectId!));
    expect(await mobileOrder()).toEqual(previousOrder);
    await browser.keys("Escape");
    const c = await createProject("E2E_PRO02_C");
    await page.locator('[data-project-name="E2E_PRO02_C"]').waitFor();
    const first = [c, ...previousOrder];
    const observed = {
      expected: first,
      desktop: await readProjectOrder(),
      mobile: await mobileOrder(),
    };
    await writeFile(
      join(artifactDir, "PRO02-new-project-order.json"),
      JSON.stringify(observed, null, 2),
    );
    expect(observed.desktop).toEqual(first);
    expect(observed.mobile).toEqual(first);

    // 直接从 Host 创建，两个页面都只接收目录更新；验证不依赖创建页面的 prepend 回调。
    const d = await callHandoffHost<{ id: string }>(ServiceChannels.Project, "saveProject", [
      { name: "E2E_PRO02_D", roots: [] },
    ]);
    await page.locator('[data-project-name="E2E_PRO02_D"]').waitFor();
    await $('[data-project-name="E2E_PRO02_D"]').waitForDisplayed();
    const expected = [d.id, ...first];
    expect(await readProjectOrder()).toEqual(expected);
    expect(await mobileOrder()).toEqual(expected);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-project-name="E2E_PRO02_D"]').waitFor();
    expect(await mobileOrder()).toEqual(expected);
    await browser.refresh();
    await $('[data-project-name="E2E_PRO02_D"]').waitForDisplayed({ timeout: 45_000 });
    expect(await readProjectOrder()).toEqual(expected);
    await page.screenshot({ path: join(artifactDir, "PRO02-mobile.png"), fullPage: true });
    await browser.saveScreenshot(join(artifactDir, "PRO02-desktop.png"));
  } finally {
    await browser.execute(() => {
      const restore = Reflect.get(window, "__restoreProjectOrderClipboard");
      if (typeof restore === "function") restore();
      Reflect.deleteProperty(window, "__restoreProjectOrderClipboard");
    });
    await mobile?.close();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}
