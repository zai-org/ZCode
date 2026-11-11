import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import {
  TID_BROWSER_RESPONSIVE_BUTTON,
  TID_SIDE_PANE_TOGGLE,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
  TID_BROWSER_RESPONSIVE_ZOOM_OPTION,
  TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByWebDriver,
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

interface RoundResult {
  png: string;
  tabId: string;
  page: {
    width: number;
    height: number;
    dpr: number;
    events: Array<{ x: number; y: number; target: string; trusted: boolean }>;
  };
}

interface NaturalViewportFacts {
  width: number;
  height: number;
  dpr: number;
  target: { x: number; y: number };
}
interface NaturalResult {
  png: string;
  tabId: string;
  before: NaturalViewportFacts;
  after: NaturalViewportFacts;
  events: Array<
    NaturalViewportFacts & {
      type: string;
      targetId?: string;
      trusted?: boolean;
      x?: number;
      y?: number;
    }
  >;
}
let naturalResult: NaturalResult | undefined;
let recoveryPrepared: Pick<NaturalResult, "png" | "tabId" | "before"> | undefined;
let recoveryResult: Pick<NaturalResult, "tabId" | "after" | "events"> | undefined;
let releaseRecoveryPrepare: (() => void) | undefined;
let originalContentSize:
  | Awaited<ReturnType<typeof setCurrentElectronRendererContentSize>>
  | undefined;

let server: Server;
let fixtureUrl: string;
const results = new Map<number, RoundResult>();
const points = [
  [300, 200],
  [600, 400],
  [1000, 600],
] as const;

// BU-E2E-020：只回放模型选择，实际输入和截图必须走产品的 Node REPL -> guest 链路。
describe("ZCT-2096856609784438784：缩放后的截图坐标与真实点击一致", () => {
  before(async () => {
    server = createServer((request, response) => {
      if (request.url === "/recovery-prepare" || request.url === "/recovery-result") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (request.url === "/recovery-prepare") {
            // 在真实后台截图之后暂停工具，待 Chromium guest 重建并恢复前台后再派发点击。
            releaseRecoveryPrepare = () => {
              releaseRecoveryPrepare = undefined;
              response.end("ok");
            };
            recoveryPrepared = result;
          } else {
            recoveryResult = result;
            response.end("ok");
          }
        });
        return;
      }
      if (request.url === "/natural-result") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          naturalResult = JSON.parse(Buffer.concat(chunks).toString()) as NaturalResult;
          response.end("ok");
        });
        return;
      }
      if (request.url === "/natural") {
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><style>
          body{margin:0;background:white}#target{position:absolute;left:80px;top:180px;width:40px;height:40px;border:0;padding:0;background:rgb(20,180,80)}
          </style><button id="target"></button><script>
          window.facts=()=>{const r=document.querySelector('#target').getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,target:{x:r.x+r.width/2,y:r.y+r.height/2}}};
          window.events=[];
          window.arm=()=>{const style=document.createElement('style');style.textContent='@media(min-width:'+Math.ceil(innerWidth*1.1)+'px){#target{left:180px}}';document.head.append(style);window.events=[];return facts()};
          addEventListener('resize',()=>events.push({type:'resize',...facts()}));
          addEventListener('click',e=>events.push({type:'click',...facts(),targetId:e.target.id,trusted:e.isTrusted,x:e.clientX,y:e.clientY}));
          </script>`);
        return;
      }
      if (request.url?.startsWith("/result/")) {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          results.set(
            Number(request.url!.split("/").at(-1)),
            JSON.parse(Buffer.concat(chunks).toString()) as RoundResult,
          );
          response.end("ok");
        });
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><body style="margin:0;background:white">
        ${points.map(([x, y], i) => `<button id="p${i}" style="border:0;padding:0;position:absolute;left:${x - 20}px;top:${y - 20}px;width:40px;height:40px;background:rgb(20,180,80)"></button>`).join("")}
        <script>window.zoomEvents=[];document.addEventListener('click',e=>zoomEvents.push({x:e.clientX,y:e.clientY,target:e.target.id,trusted:e.isTrusted}));</script>
      </body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  after(async () => {
    releaseRecoveryPrepare?.();
    if (originalContentSize) await restoreElectronRendererContentSize(originalContentSize);
    await browser.electron
      .execute((electron, channel) => {
        const state = globalThis as unknown as { zoomReadyListener?: (...args: unknown[]) => void };
        if (state.zoomReadyListener)
          electron.ipcMain.removeListener(channel, state.zoomReadyListener);
        delete state.zoomReadyListener;
      }, PlatformChannels.BrowserViewScreenshotSurfaceReady)
      .catch(() => undefined);
    await desktopCommand("resetZoom").catch(() => undefined);
    await clearAppData();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("同一 guest 在 100% / 110% / reset / 缩小 / 放大以及 Fit / 100% / 200% / 50% 下均命中", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();
    // 修复原因：Windows CI runner 显示器只有 1024×768，默认窗口被夹到工作区宽度；+1/+2 应用放大
    // 触发 resize 后对话列不足 480 CSS px，产品按设计自动收起右侧面板，后续轮次找不到
    // 浏览器响应式工具栏；崩溃重建 case 的换代前 dpr 也随之退化为 1。固定足够宽的内容区，
    // 使各轮放大后面板仍保持展开（Windows 允许内容区大于显示器）。
    originalContentSize = await setCurrentElectronRendererContentSize(1600, 900);
    // 只观察产品回执取得真实 tab scope，供后续普通模式 native surface 回归使用。
    await browser.electron.execute((electron, channel) => {
      const state = globalThis as unknown as {
        zoomReadyListener?: (...args: unknown[]) => void;
        zoomReadyPayload?: unknown;
      };
      state.zoomReadyListener = (_event, payload) => {
        state.zoomReadyPayload = payload;
      };
      electron.ipcMain.on(channel, state.zoomReadyListener);
    }, PlatformChannels.BrowserViewScreenshotSurfaceReady);
    let guestId: number | undefined;
    let tabId: string | undefined;
    for (const [round, zoomLevel] of [0, 1, 0, -2, 2].entries()) {
      await desktopCommand("resetZoom");
      const previewZoom = ["fit", "fit", "100", "200", "50"][round]!;
      // 统一在基准 UI 缩放下设置预览，再施加本轮待测缩放，隔离场景设置与 guest 坐标断言。
      if (round >= 2) {
        await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
        await clickTestIdByWebDriver(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-${previewZoom}`);
      }
      for (let step = 0; step < Math.abs(zoomLevel); step++) {
        await desktopCommand(zoomLevel > 0 ? "zoomIn" : "zoomOut");
      }
      const appliedZoom = await browser.execute(async () => {
        return (
          window as unknown as { zcode: { getDesktopZoomLevel(): Promise<{ zoomLevel: number }> } }
        ).zcode.getDesktopZoomLevel();
      });
      expect(appliedZoom.zoomLevel).toBe(zoomLevel);
      if (round > 0) {
        // 以 detached 为前置条件，避免只覆盖 metrics 仍驻留的热路径。
        await browser.waitUntil(
          () =>
            browser.electron.execute((electron, url) => {
              const guest = electron.webContents
                .getAllWebContents()
                .find((wc: Electron.WebContents) => wc.getURL() === url);
              return guest && !guest.debugger.isAttached();
            }, fixtureUrl) as unknown as Promise<boolean>,
          { timeout: 15_000, timeoutMsg: "guest CDP 未进入 idle detach" },
        );
        // detach 会清掉 per-session metrics；放大档曾因只靠 metrics scale 补偿，空闲时退回
        // 1280 × zoom，Browser Use 每次操作页面都会变大又变回。空闲态必须已等于目标 viewport。
        const idleViewport = (await browser.electron.execute(async (electron, url) => {
          const guest = electron.webContents
            .getAllWebContents()
            .find((wc: Electron.WebContents) => wc.getURL() === url)!;
          return guest.executeJavaScript("({ width: innerWidth, height: innerHeight })");
        }, fixtureUrl)) as unknown as { width: number; height: number };
        expect({ round, zoomLevel, ...idleViewport }).toEqual({
          round,
          zoomLevel,
          width: 1280,
          height: 720,
        });
      }
      await sendV4Prompt(
        `E2E_BROWSER_ZOOM_COORDINATES E2E_ZOOM_ROUND_${round} E2E_BROWSER_FIXTURE_URL:${fixtureUrl} 截图并按固定坐标点击。`,
      );
      await browser.waitUntil(
        async () => {
          // 仅批准当前 case 的唯一 Node REPL 权限提示。
          await browser.execute(() => {
            const options = document.querySelectorAll<HTMLButtonElement>(
              'button[role="option"][data-permission-option-kind="allowOnce"]',
            );
            if (options.length === 1) options[0]?.click();
          });
          return results.has(round);
        },
        { timeout: 90_000, timeoutMsg: `第 ${round} 轮未收到真实工具结果` },
      );
      const result = results.get(round)!;
      const artifactDir = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "zoom-coordinates");
      await mkdir(artifactDir, { recursive: true });
      // Windows 曾出现尺寸和点击均正确但图片内容偏移；断言前保存失败轮证据。
      await writeFile(join(artifactDir, `round-${round}.png`), Buffer.from(result.png, "base64"));
      await writeFile(
        join(artifactDir, `round-${round}.json`),
        JSON.stringify(
          { round, zoomLevel, previewZoom, tabId: result.tabId, page: result.page },
          null,
          2,
        ),
      );
      const png = Buffer.from(result.png, "base64");
      // 检查 PNG 里的按钮像素位置，防止“DOM 坐标命中但截图内容已偏移”的假通过。
      const facts = (await browser.electron.execute(
        (electron, base64, url) => {
          const image = electron.nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
          const bitmap = image.toBitmap();
          const { width, height } = image.getSize();
          const isGreen = (x: number, y: number) => {
            const offset = (y * width + x) * 4;
            return (
              bitmap[offset + 1]! - bitmap[offset]! > 60 &&
              bitmap[offset + 1]! - bitmap[offset + 2]! > 60
            );
          };
          // 只采按钮中心会漏掉小于按钮半宽的拉伸；同时量出色块中心，约束图片坐标误差。
          const pixelCenters = [
            [300, 200],
            [600, 400],
            [1000, 600],
          ].map(([x, y]) => {
            const xs = Array.from({ length: width }, (_, value) => value).filter((value) =>
              isGreen(value, y!),
            );
            const ys = Array.from({ length: height }, (_, value) => value).filter((value) =>
              isGreen(x!, value),
            );
            return [
              xs.length ? (xs[0]! + xs.at(-1)! + 1) / 2 : null,
              ys.length ? (ys[0]! + ys.at(-1)! + 1) / 2 : null,
            ];
          });
          const colors = [
            [300, 200],
            [600, 400],
            [1000, 600],
          ].map(([x, y]) =>
            Array.from(bitmap.subarray((y! * width + x!) * 4, (y! * width + x!) * 4 + 3)),
          );
          const guest = electron.webContents.getAllWebContents().find((wc) => wc.getURL() === url)!;
          return {
            colors,
            pixelCenters,
            guestId: guest.id,
            zoom: guest.getZoomFactor(),
            platform: process.platform,
            arch: process.arch,
            versions: process.versions,
            displays: electron.screen
              .getAllDisplays()
              .map(({ bounds, scaleFactor }) => ({ bounds, scaleFactor })),
          };
        },
        result.png,
        fixtureUrl,
      )) as unknown as {
        colors: number[][];
        pixelCenters: Array<Array<number | null>>;
        guestId: number;
        zoom: number;
      };
      await writeFile(
        join(artifactDir, `round-${round}-native.json`),
        JSON.stringify(facts, null, 2),
      );
      tabId ??= result.tabId;
      expect(result.tabId).toBe(tabId);
      expect(result.page.width).toBe(1280);
      expect(result.page.height).toBe(720);
      expect(result.page.dpr).toBeCloseTo(1, 4);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 720]);
      expect(result.page.events).toHaveLength((round + 1) * 3);
      for (const [i, [x, y]] of points.entries()) {
        const event = result.page.events[round * 3 + i]!;
        expect(event.target).toBe(`p${i}`);
        expect(event.trusted).toBe(true);
        expect(Math.abs(event.x - x)).toBeLessThanOrEqual(1);
        expect(Math.abs(event.y - y)).toBeLessThanOrEqual(1);
      }
      guestId ??= facts.guestId;
      expect(facts.guestId).toBe(guestId);
      expect(facts.zoom).toBe(1);
      // Electron 的色彩管理会转换 RGB；绿色按钮必须仍覆盖原截图坐标，白底不能通过。
      for (const [blue, green, red] of facts.colors) {
        expect(green).toBeGreaterThan(150);
        expect(green! - red!).toBeGreaterThan(60);
        expect(green! - blue!).toBeGreaterThan(60);
      }
      for (const [i, [x, y]] of points.entries()) {
        const [pixelX, pixelY] = facts.pixelCenters[i]!;
        expect(pixelX).not.toBeNull();
        expect(pixelY).not.toBeNull();
        expect(Math.abs(pixelX! - x)).toBeLessThanOrEqual(1);
        expect(Math.abs(pixelY! - y)).toBeLessThanOrEqual(1);
      }
      console.info(
        "[zoom-coordinate]",
        JSON.stringify({
          round,
          zoomLevel,
          guestId,
          size: [png.readUInt32BE(16), png.readUInt32BE(20)],
          events: result.page.events.slice(-3),
        }),
      );
      await waitForV4AssistantMessageContaining(`E2E_ZOOM_DONE_${round}`);
      await waitForV4Pane((pane) => !pane.canStop, "缩放测试轮次未结束", 30_000);
      if (round >= 2) {
        const preview = await browser.$(`[data-testid="${TID_BROWSER_RESPONSIVE_ZOOM_SELECT}"]`);
        expect(await preview.getText()).toContain(`${previewZoom}%`);
        // 下拉框在截图期间也保留偏好；必须验证真实 release 已解除临时 Fit surface。
        await browser.waitUntil(
          () =>
            browser.execute(
              (viewportTestId, expectedScale) => {
                const viewport = document.querySelector<HTMLElement>(
                  `[data-testid="${viewportTestId}"]`,
                );
                return (
                  !document.querySelector('[data-browser-screenshot-surface-state="preparing"]') &&
                  Number(viewport?.dataset.responsiveScale) === expectedScale
                );
              },
              TID_BROWSER_RESPONSIVE_VIEWPORT,
              Number(previewZoom) / 100,
            ),
          { timeout: 10_000, timeoutMsg: "截图 release 后未恢复用户实际预览比例" },
        );
      }
    }
  });
  it("普通模式后台 tab 在小窗口中按 fallback viewport 完成原生截图并恢复模式", async function () {
    this.timeout(60_000);
    await desktopCommand("resetZoom");
    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_BUTTON);
    expect(
      await browser
        .$(`[data-testid="${TID_BROWSER_RESPONSIVE_BUTTON}"]`)
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await desktopCommand("zoomIn");
    await clickTestIdByWebDriver(TID_SIDE_PANE_TOGGLE);
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const guest = document.querySelector("webview");
          return guest?.getBoundingClientRect().width === 0;
        }),
      { timeout: 10_000, timeoutMsg: "普通 tab 尚未进入后台隐藏布局" },
    );

    // 直接驱动生产 prepare/ready/release IPC，注入缓存 fallback 请求；不模拟 DOM 尺寸或 ready。
    const result = (await browser.electron.execute(
      async (electron, channels, url) => {
        const state = globalThis as unknown as {
          zoomReadyPayload?: {
            requestId: string;
            webContentsId: number;
            viewport: { width: number; height: number };
            workspaceKey: string;
            sessionId: string;
            tabId: string;
            browserId: string;
            browserGeneration: number;
          };
        };
        const previous = state.zoomReadyPayload;
        if (!previous) throw new Error("缺少产品真实截图 scope");
        const guest = electron.webContents.fromId(previous.webContentsId)!;
        const owner = electron.BrowserWindow.getAllWindows()[0]!;
        const bounds = owner.getBounds();
        const minimumSize = owner.getMinimumSize();
        const request = {
          ...previous,
          requestId: "e2e-normal-background-fallback",
          viewport: { width: 1280, height: 720 },
        };
        let listener:
          | ((
              _event: Electron.IpcMainEvent,
              payload: typeof request & { surfaceScale: number },
            ) => void)
          | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wasAttached = guest.debugger.isAttached();
        try {
          owner.setMinimumSize(0, 0);
          owner.setContentSize(960, 600);
          if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
          await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
            dontSetVisibleSize: true,
          });
          // 对齐 main 安装 fallback metrics 后的 guest zoom；后续 release 不应把它改成应用缩放。
          guest.setZoomFactor(1);
          const ready = await new Promise<typeof request & { surfaceScale: number }>(
            (resolve, reject) => {
              listener = (event, payload) => {
                if (
                  event.sender.id === owner.webContents.id &&
                  payload.requestId === request.requestId
                )
                  resolve(payload);
              };
              electron.ipcMain.on(channels.ready, listener);
              timer = setTimeout(
                () => reject(new Error("普通模式 native prepare 在 3000ms 内未 ready")),
                3000,
              );
              owner.webContents.send(channels.prepare, request);
            },
          );
          const layout = await owner.webContents.executeJavaScript(`(() => {
          const frame=document.querySelector('[data-responsive-scale]');
          const webview=document.querySelector('webview');
          return {innerWidth,innerHeight,width:webview.offsetWidth,height:webview.offsetHeight,scale:Number(frame?.dataset.responsiveScale)};
        })()`);
          const image = (await guest.capturePage()).resize({
            width: 1280,
            height: 720,
            quality: "best",
          });
          const bitmap = image.toBitmap();
          const colors = [
            [300, 200],
            [600, 400],
            [1000, 600],
          ].map(([x, y]) =>
            Array.from(bitmap.subarray((y! * 1280 + x!) * 4, (y! * 1280 + x!) * 4 + 3)),
          );
          owner.webContents.send(channels.release, request);
          await owner.webContents.executeJavaScript(`new Promise((resolve,reject) => {
            const started=Date.now();
            const poll=() => {
              if (!document.querySelector('[data-responsive-scale]')) return resolve(true);
              if (Date.now()-started>2000) return reject(new Error('临时 Fit 未释放'));
              setTimeout(poll, 25);
            };
            poll();
          })`);
          // 保持同一次 CDP attach，不重新安装 metrics，检查 release 后紧接着的真实输入。
          await guest.executeJavaScript("window.zoomEvents=[]");
          for (const [x, y] of [
            [300, 200],
            [600, 400],
            [1000, 600],
          ]) {
            await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: x!,
              y: y!,
              button: "left",
              clickCount: 1,
            });
            await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: x!,
              y: y!,
              button: "left",
              clickCount: 1,
            });
          }
          const released = await guest.executeJavaScript(
            "({width:innerWidth,height:innerHeight,events:window.zoomEvents})",
          );
          return {
            ready,
            layout,
            released: {
              ...released,
              guestZoom: guest.getZoomFactor(),
              desktopZoom: owner.webContents.getZoomFactor(),
            },
            png: image.toPNG().toString("base64"),
            colors,
            guestId: guest.id,
            url: guest.getURL(),
            expectedUrl: url,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            layout: await owner.webContents.executeJavaScript(`(() => {
              const webview=document.querySelector('webview');
              return {innerWidth,innerHeight,width:webview?.offsetWidth,height:webview?.offsetHeight,
                mode:document.querySelector('[data-responsive-browser-mode]')?.dataset.responsiveBrowserMode};
            })()`),
          };
        } finally {
          if (timer) clearTimeout(timer);
          if (listener) electron.ipcMain.removeListener(channels.ready, listener);
          owner.webContents.send(channels.release, request);
          if (!wasAttached && guest.debugger.isAttached()) guest.debugger.detach();
          owner.setBounds(bounds);
          owner.setMinimumSize(minimumSize[0]!, minimumSize[1]!);
        }
      },
      {
        prepare: PlatformChannels.BrowserViewScreenshotSurfacePrepare,
        ready: PlatformChannels.BrowserViewScreenshotSurfaceReady,
        release: PlatformChannels.BrowserViewScreenshotSurfaceRelease,
      },
      fixtureUrl,
    )) as unknown as {
      error?: string;
      ready: {
        viewport: { width: number; height: number };
        surfaceScale: number;
        webContentsId: number;
      };
      layout: {
        innerWidth: number;
        innerHeight: number;
        width: number;
        height: number;
        scale: number;
      };
      png: string;
      released: {
        width: number;
        height: number;
        guestZoom: number;
        desktopZoom: number;
        events: RoundResult["page"]["events"];
      };
      colors: number[][];
      guestId: number;
      url: string;
      expectedUrl: string;
    };
    const artifactDir = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "zoom-coordinates");
    const { png: _png, ...facts } = result;
    await writeFile(join(artifactDir, "normal-background.json"), JSON.stringify(facts, null, 2));
    expect(result.error).toBeUndefined();
    expect(result.png).toBeDefined();
    await writeFile(join(artifactDir, "normal-background.png"), Buffer.from(result.png, "base64"));
    // 放大档也按 1 / zoom 布局 webview；offset 是整数，还原后允许 1px 取整误差。
    expect(Math.abs(result.ready.viewport.width - 1280)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.ready.viewport.height - 720)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.layout.width - 1280 / result.released.desktopZoom)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(result.layout.height - 720 / result.released.desktopZoom)).toBeLessThanOrEqual(
      1,
    );
    expect(result.layout.innerWidth).toBeLessThan(1280);
    expect(result.layout.innerHeight).toBeLessThan(720);
    expect(result.ready.surfaceScale).toBeLessThan(1);
    expect(result.layout.scale).toBe(result.ready.surfaceScale);
    expect(result.guestId).toBe(result.ready.webContentsId);
    expect(result.url).toBe(fixtureUrl);
    expect(result.released.desktopZoom).toBeCloseTo(1.1);
    expect(result.released.guestZoom).toBe(1);
    expect(result.released.width).toBe(1280);
    expect(result.released.height).toBe(720);
    expect(result.released.events).toHaveLength(3);
    for (const [index, event] of result.released.events.entries()) {
      expect(event.trusted).toBe(true);
      expect(event.target).toBe(`p${index}`);
      expect(Math.abs(event.x - points[index]![0])).toBeLessThanOrEqual(1);
      expect(Math.abs(event.y - points[index]![1])).toBeLessThanOrEqual(1);
    }
    for (const [blue, green, red] of result.colors) {
      expect(green! - red!).toBeGreaterThan(60);
      expect(green! - blue!).toBeGreaterThan(60);
    }
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !document.querySelector('[data-browser-screenshot-surface-state="preparing"]') &&
            !document.querySelector("[data-responsive-scale]"),
        ),
      { timeout: 10_000, timeoutMsg: "普通模式截图 release 后仍残留临时 responsive 布局" },
    );
    await desktopCommand("resetZoom");
    await clickTestIdByWebDriver(TID_SIDE_PANE_TOGGLE);
    expect(
      await browser
        .$(`[data-testid="${TID_BROWSER_RESPONSIVE_BUTTON}"]`)
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
  it("普通前台缩小后，真实截图和 release 不改变自然 viewport 或 media query 目标", async function () {
    this.timeout(120_000);
    await desktopCommand("resetZoom");
    // 清除上一条原生 fallback 探针留下的 metrics，通过产品模式切换恢复自然 viewport。
    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_BUTTON);
    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_BUTTON);
    expect(
      await browser
        .$(`[data-testid="${TID_BROWSER_RESPONSIVE_BUTTON}"]`)
        .getAttribute("aria-pressed"),
    ).toBe("false");
    await desktopCommand("zoomOut");
    await desktopCommand("zoomOut");
    const guestBefore = await browser.execute(() =>
      (
        document.querySelector("webview") as unknown as { getWebContentsId(): number }
      ).getWebContentsId(),
    );
    await sendV4Prompt(
      `E2E_BROWSER_ZOOM_COORDINATES E2E_ZOOM_NATURAL E2E_BROWSER_FIXTURE_URL:${fixtureUrl} 普通模式截图并点击 media query 按钮。`,
    );
    await browser.waitUntil(
      async () => {
        await browser.execute(() => {
          const options = document.querySelectorAll<HTMLButtonElement>(
            'button[role="option"][data-permission-option-kind="allowOnce"]',
          );
          if (options.length === 1) options[0]?.click();
        });
        return Boolean(naturalResult);
      },
      { timeout: 90_000, timeoutMsg: "未收到自然 viewport 的真实工具结果" },
    );
    const result = naturalResult!;
    const artifactDir = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "zoom-coordinates");
    await writeFile(join(artifactDir, "natural.png"), Buffer.from(result.png, "base64"));
    const { png: _png, ...facts } = result;
    await writeFile(join(artifactDir, "natural.json"), JSON.stringify(facts, null, 2));
    const pixels = (await browser.electron.execute((electron, base64) => {
      const image = electron.nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      let minX = width,
        minY = height,
        maxX = -1,
        maxY = -1;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          if (
            bitmap[offset + 1]! - bitmap[offset]! > 60 &&
            bitmap[offset + 1]! - bitmap[offset + 2]! > 60
          ) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      return {
        width,
        height,
        center: [(minX + maxX + 1) / 2, (minY + maxY + 1) / 2],
        found: maxX >= 0,
      };
    }, result.png)) as unknown as {
      width: number;
      height: number;
      center: number[];
      found: boolean;
    };
    await writeFile(join(artifactDir, "natural-pixels.json"), JSON.stringify(pixels, null, 2));
    expect(pixels.found).toBe(true);
    expect(result.after).toEqual(result.before);
    for (const event of result.events) {
      expect(Math.abs(event.width - result.before.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(event.height - result.before.height)).toBeLessThanOrEqual(1);
      expect(event.target).toEqual(result.before.target);
      expect(event.dpr).toBe(result.before.dpr);
    }
    // 自然模式 PNG 保留原 DPR；将真实色块中心换回 CSS 单位后，必须仍与截图前目标一致。
    expect(
      Math.abs((pixels.center[0]! * result.before.width) / pixels.width - result.before.target.x),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((pixels.center[1]! * result.before.height) / pixels.height - result.before.target.y),
    ).toBeLessThanOrEqual(1);
    const clicks = result.events.filter(({ type }) => type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ trusted: true, targetId: "target" });
    await waitForV4AssistantMessageContaining("E2E_ZOOM_NATURAL_DONE");
    await waitForV4Pane((pane) => !pane.canStop, "自然 viewport 回归未结束", 30_000);
    expect(
      await browser.execute(() =>
        (
          document.querySelector("webview") as unknown as { getWebContentsId(): number }
        ).getWebContentsId(),
      ),
    ).toBe(guestBefore);
    expect(
      await browser
        .$(`[data-testid="${TID_BROWSER_RESPONSIVE_BUTTON}"]`)
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      await browser.execute(() =>
        Boolean(document.querySelector('[data-browser-screenshot-surface-state="preparing"]')),
      ),
    ).toBe(false);
  });
  it("110% 普通模式 guest 崩溃重建后，自然 viewport 的真实点击坐标一致", async function () {
    this.timeout(120_000);
    await desktopCommand("resetZoom");
    await desktopCommand("zoomIn");
    await clickTestIdByWebDriver(TID_SIDE_PANE_TOGGLE);
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelector("webview")?.getBoundingClientRect().width === 0,
        ),
      { timeout: 10_000, timeoutMsg: "换代回归未进入后台隐藏布局" },
    );
    const oldGuestId = await browser.execute(() =>
      (
        document.querySelector("webview") as unknown as { getWebContentsId(): number }
      ).getWebContentsId(),
    );
    await sendV4Prompt(
      `E2E_BROWSER_ZOOM_COORDINATES E2E_ZOOM_RECOVERY E2E_BROWSER_FIXTURE_URL:${fixtureUrl} 后台截图后重建浏览器并点击。`,
    );
    try {
      await browser.waitUntil(
        async () => {
          await browser.execute(() => {
            const options = document.querySelectorAll<HTMLButtonElement>(
              'button[role="option"][data-permission-option-kind="allowOnce"]',
            );
            if (options.length === 1) options[0]?.click();
          });
          return Boolean(recoveryPrepared);
        },
        { timeout: 90_000, timeoutMsg: "未收到换代前真实后台截图" },
      );
      const prepared = recoveryPrepared!;
      const artifactDir = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "zoom-coordinates");
      await writeFile(join(artifactDir, "guest-recovery.png"), Buffer.from(prepared.png, "base64"));
      expect(prepared.before.dpr).toBeGreaterThan(1);
      expect(prepared.tabId).toBe(naturalResult!.tabId);
      // 原生 E2E 验证重建后的真实点击；fallback 倍率残留由 manager 红绿单测定向覆盖。
      // 只注入 renderer 崩溃，销毁、重建和 URL 恢复由生产链路完成。
      await crashGuestAndWaitForReplacement();
      await clickTestIdByWebDriver(TID_SIDE_PANE_TOGGLE);
      await browser.waitUntil(
        () =>
          browser.execute(async () => {
            const guest = document.querySelector("webview") as unknown as {
              executeJavaScript(code: string): Promise<boolean>;
            };
            return guest.executeJavaScript(
              "Boolean(window.facts && innerWidth > 0 && innerHeight > 200)",
            );
          }),
        { timeout: 10_000, timeoutMsg: "新 guest 未恢复自然 viewport" },
      );
      const newGuestId = await browser.execute(() =>
        (
          document.querySelector("webview") as unknown as { getWebContentsId(): number }
        ).getWebContentsId(),
      );
      releaseRecoveryPrepare!();
      await browser.waitUntil(() => Boolean(recoveryResult), {
        timeout: 30_000,
        timeoutMsg: "未收到重建后的真实点击结果",
      });
      const result = recoveryResult!;
      await writeFile(
        join(artifactDir, "guest-recovery.json"),
        JSON.stringify(
          {
            oldGuestId,
            newGuestId,
            before: prepared.before,
            ...result,
          },
          null,
          2,
        ),
      );
      expect(newGuestId).not.toBe(oldGuestId);
      expect(result.tabId).toBe(prepared.tabId);
      expect(result.after.dpr).toBeGreaterThan(1);
      const clicks = result.events.filter(({ type }) => type === "click");
      expect(clicks).toHaveLength(1);
      expect(clicks[0]).toMatchObject({ trusted: true, targetId: "target" });
      expect(Math.abs(clicks[0]!.x! - 100)).toBeLessThanOrEqual(1);
      expect(Math.abs(clicks[0]!.y! - 200)).toBeLessThanOrEqual(1);
      await waitForV4AssistantMessageContaining("E2E_ZOOM_RECOVERY_DONE");
      await waitForV4Pane((pane) => !pane.canStop, "guest 换代回归未结束", 30_000);
    } finally {
      releaseRecoveryPrepare?.();
    }
  });
});

async function desktopCommand(command: string): Promise<void> {
  await browser.execute(async (value) => {
    await (
      window as unknown as { zcode: { executeDesktopCommand(command: string): Promise<void> } }
    ).zcode.executeDesktopCommand(value);
  }, command);
}

async function crashGuestAndWaitForReplacement(): Promise<void> {
  const oldGuestId = await browser.execute(() =>
    (
      document.querySelector("webview") as unknown as { getWebContentsId(): number }
    ).getWebContentsId(),
  );
  await browser.electron.execute((electron, id) => {
    electron.webContents.fromId(id)!.forcefullyCrashRenderer();
  }, oldGuestId);
  await browser.waitUntil(
    () =>
      browser.execute((previousId) => {
        try {
          const guest = document.querySelector("webview") as unknown as {
            getWebContentsId(): number;
            getURL(): string;
          };
          return guest.getWebContentsId() !== previousId && guest.getURL().endsWith("/natural");
        } catch {
          return false;
        }
      }, oldGuestId),
    { timeout: 15_000, timeoutMsg: "崩溃后未重建 guest 并恢复 URL" },
  );
}
