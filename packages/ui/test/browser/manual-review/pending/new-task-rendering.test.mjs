import { registerSessionSelectionCases } from "./session-selection-cases.mjs";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium, _electron } from "playwright-core";

function trackProjectRenders() {
  const seen = new WeakMap();
  window.__projectRendersById = {};
  window.__taskRowRenders = {};
  window.__expansionChromeRenders = {};
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberUnmount() {},
    onCommitFiberRoot(_id, root) {
      const walk = (fiber) => {
        if (!fiber) return;
        const type = fiber.elementType || fiber.type;
        const name = typeof type === "function" ? type.name : type?.type?.name;
        const previous = seen.get(fiber) ?? seen.get(fiber.alternate);
        if (
          [
            "ProjectSidebarNavigation",
            "ProjectSidebarListHeader",
            "WorkspaceHeaderTitleSection",
          ].includes(name) &&
          fiber.flags & 1 &&
          previous !== fiber.actualStartTime
        )
          window.__expansionChromeRenders[name] = (window.__expansionChromeRenders[name] ?? 0) + 1;
        if (name === "ProjectNodeContent" || (name === "Row" && fiber.memoizedProps.task)) {
          if (fiber.flags & 1 && previous !== fiber.actualStartTime) {
            const props = fiber.memoizedProps;
            const counts = name === "Row" ? window.__taskRowRenders : window.__projectRendersById;
            const id =
              name === "Row"
                ? `${props.task.workspaceIdentity || props.task.workspacePath}:${props.task.taskId}`
                : props.project.id;
            counts[id] = (counts[id] ?? 0) + 1;
          }
        }
        seen.set(fiber, fiber.actualStartTime);
        if (fiber.alternate) seen.set(fiber.alternate, fiber.actualStartTime);
        walk(fiber.child);
        walk(fiber.sibling);
      };
      walk(root.current);
    },
  };
}

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/new-task-rendering.fixture.tsx";
const artifacts =
  process.env.ZCODE_E2E_ARTIFACT_DIR ||
  join(root, "packages/desktop/.e2e-artifacts/new-task-rendering");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    // 各回放使用独立依赖缓存，避免并行 Vite server 的不同边界 mock 相互覆盖。
    cacheDir: join(artifacts, "vite-cache"),
    plugins: [
      {
        name: "new-task-fixture-boundaries",
        enforce: "pre",
        load(id) {
          if (id.endsWith("/hooks/useWorkspaceServices.tsx"))
            return "export const useBaseWorkspaceServices=()=>window.__renderFixture.services; export const useWorkspaceServicesResolution=()=>({}); export const useOptionalBaseWorkspaceServices=useBaseWorkspaceServices; export const useWorkspaceServices=useBaseWorkspaceServices;";
          if (id.endsWith("/store/TabStoreProvider.tsx"))
            return "export const useTabStoreApi=()=>window.__renderFixture.tabStore; export const useTabStore=s=>s(window.__renderFixture.tabStore.getState()); export const useOptionalTabStore=useTabStore;";
          if (id.endsWith("/store/StoreProvider.tsx"))
            return "import {createContext} from 'react'; export const StoreContext=createContext(null); const state={setTheme:()=>{},interfaceMode:'coding'}; export const useZCodeStore=s=>s(state); export const useZCodeStoreWithDefault=(_s,value)=>value;";
          if (id.endsWith("/hooks/usePlatform.tsx"))
            return "export const useOptionalPlatform=()=>null; export const usePlatform=()=>({}); export const useSelectDirectory=()=>async()=>null;";
          if (id.endsWith("/hooks/useConfirmDialog.ts"))
            return "const confirm=async()=>true; export const useConfirmDialog=()=>confirm;";
          if (id.endsWith("/hooks/useWebRemoteControlStatus.ts"))
            return "export const useWebRemoteControlStatus=()=>({mobileConnected:false});";
          if (id.endsWith("/v4/useWorkspaceSessionsIndexItems.ts"))
            return "import {useSyncExternalStore} from 'react'; export const useWorkspaceSessionsIndexItems=()=>useSyncExternalStore(window.__renderFixture.activityStore.subscribe,window.__renderFixture.activityStore.getSnapshot);";
          if (id.endsWith("/settings/CodingPlanUpgradeDialogProvider.tsx"))
            return "export const useCodingPlanUpgradeDialog=()=>({openCodingPlanUpgrade:()=>{}}); export const useOptionalCodingPlanUpgradeDialog=()=>null;";
          if (id.endsWith("/WorkspaceSidebarFooter.tsx"))
            return "export const WorkspaceSidebarFooter=()=>null;";
          if (id.endsWith("/shortcuts/useShortcutBindings.ts"))
            return "export const useShortcutCommandLabel=()=>'';";
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  if (process.env.ZCODE_RENDER_ELECTRON_PATH) {
    const main = join(artifacts, "renderer.cjs");
    await writeFile(
      main,
      'const {app,BrowserWindow}=require("electron");app.setPath("userData",require("node:path").join(__dirname,"electron-profile"));app.on("window-all-closed",()=>{});app.whenReady().then(()=>new BrowserWindow({show:true}).loadURL("about:blank"));',
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = await _electron.launch({
      executablePath: process.env.ZCODE_RENDER_ELECTRON_PATH,
      args: [main],
      env,
    });
    await (await electron.firstWindow()).close();
    let windowIndex = 0;
    browser = {
      async newPage({ viewport }) {
        const opened = electron.waitForEvent("window");
        await electron.evaluate(
          ({ BrowserWindow }, { size, partition }) => {
            new BrowserWindow({
              ...size,
              useContentSize: true,
              show: true,
              webPreferences: {
                partition,
                nodeIntegration: false,
                contextIsolation: true,
                backgroundThrottling: false,
              },
            }).loadURL("about:blank");
          },
          { size: viewport, partition: `project-render-fixture-${++windowIndex}` },
        );
        return opened;
      },
      close: async () => {
        // 独立夹具没有业务状态；结束自身，避免 macOS 最后一窗关闭后继续等待。
        await electron.evaluate(({ app }) => app.exit(0)).catch(() => {});
        await electron.close();
      },
    };
  } else {
    browser = await chromium.launch({ channel: "chrome" });
  }
});
after(async () => {
  await browser?.close();
  await server?.close();
});

registerSessionSelectionCases({
  getBrowser: () => browser,
  getOrigin: () => origin,
  artifacts,
  trackProjectRenders,
});

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    test(`shared Spinner ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        await page.goto(`${origin}fixture?spinner=1&theme=${theme}&locale=zh-CN`);
        const spinner = page.getByRole("status");
        await spinner.waitFor();
        assert.equal(await spinner.getAttribute("aria-label"), "加载中...");
        assert.equal(await page.locator(".lucide-loader-circle").count(), 1);
        const style = await spinner.evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            width: computed.width,
            height: computed.height,
            animation: computed.animationName,
          };
        });
        assert.deepEqual(style, { width: "20px", height: "20px", animation: "spin" });
        await page.screenshot({ path: join(artifacts, `spinner-${width}-${theme}.png`) });
      } finally {
        await page.close();
      }
    });

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    test(
      `SPT07 project expansion ${mobile ? "mobile" : "desktop"}/${theme}`,
      { timeout: 60000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1200, height: 800 },
        });
        page.setDefaultTimeout(10000);
        // 独立 Electron 首次加载会编译真实 UI；导航预算与交互断言分开。
        page.setDefaultNavigationTimeout(45000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        const evidence = { mobile, theme, motions: [] };
        const project = (id) => page.locator(`[data-project-id="${id}"]`);
        const toggle = (id) => project(id).getByTestId("virtual-project-toggle");
        const preferenceKey = "zcode-project-sidebar-preferences";
        const key = (id) => JSON.stringify(["local", id]);
        const preferences = () =>
          page.evaluate((name) => JSON.parse(localStorage.getItem(name)), preferenceKey);
        const settle = () =>
          page.waitForFunction(() =>
            [...document.querySelectorAll('[data-testid="virtual-project-tasks"]')].every((node) =>
              node
                .getAnimations({ subtree: true })
                .every((animation) => animation.playState !== "running"),
            ),
          );
        await page.addInitScript(trackProjectRenders);
        await page.addInitScript((name) => {
          if (!localStorage.getItem(name))
            localStorage.setItem(
              name,
              JSON.stringify({
                order: [],
                view: "projects",
                expanded: Object.fromEntries(
                  Array.from({ length: 44 }, (_, i) => [
                    JSON.stringify(["local", `p${i}`]),
                    i === 0,
                  ]),
                ),
              }),
            );
        }, preferenceKey);
        try {
          await page.goto(`${origin}fixture?theme=${theme}&mobile=${mobile ? 1 : 0}&expansion=1`);
          await project("p43").waitFor({ state: "attached" });
          await settle();
          assert.deepEqual(
            Object.keys(await page.evaluate(() => window.__expansionChromeRenders)).sort(),
            ["ProjectSidebarListHeader", "ProjectSidebarNavigation", "WorkspaceHeaderTitleSection"],
            "Probe must observe the real navigation and session header mounts",
          );
          assert.equal(
            Object.keys(await page.evaluate(() => window.__projectRendersById)).length,
            44,
          );
          for (const action of ["close", "open"]) {
            await page.evaluate(() => {
              window.__projectRendersById = {};
              window.__expansionChromeRenders = {};
              const node = document.querySelector(
                '[data-project-id="p0"] [data-testid="virtual-project-tasks"]',
              );
              const samples = [],
                events = [];
              const started = performance.now();
              let frame;
              const sample = () => {
                samples.push({
                  ms: performance.now() - started,
                  height: node.getBoundingClientRect().height,
                  opacity: node.firstElementChild
                    ? Number(getComputedStyle(node.firstElementChild).opacity)
                    : 0,
                });
                frame = requestAnimationFrame(sample);
              };
              const onAnimation = (event) => {
                if (event.target !== node) return;
                events.push({
                  type: event.type,
                  name: event.animationName,
                  seconds: event.elapsedTime,
                });
                if (event.type === "animationend") {
                  cancelAnimationFrame(frame);
                  node.removeEventListener("animationstart", onAnimation);
                  node.removeEventListener("animationend", onAnimation);
                  window.__expansionMotion = { samples, events };
                }
              };
              window.__expansionMotion = null;
              node.addEventListener("animationstart", onAnimation);
              node.addEventListener("animationend", onAnimation);
              frame = requestAnimationFrame(sample);
            });
            await toggle("p0").click();
            await page.waitForFunction(() => window.__expansionMotion !== null);
            await settle();
            const motion = await page.evaluate(() => ({
              ...window.__expansionMotion,
              renders: window.__projectRendersById,
              chromeRenders: window.__expansionChromeRenders,
            }));
            evidence.motions.push({ action, ...motion });
          }
          // 连续操作在上次 React 提交后反向，验证最新偏好而不是同一事件中的旧受控值。
          await page.evaluate(async () => {
            for (const id of ["p0", "p1", "p0", "p0", "p0"]) {
              document
                .querySelector(`[data-project-id="${id}"] [data-testid="virtual-project-toggle"]`)
                .click();
              await new Promise(requestAnimationFrame);
            }
          });
          await settle();
          const sequential = await preferences();
          assert.equal(sequential.expanded[key("p0")], true);
          assert.equal(sequential.expanded[key("p1")], true);
          const external = {
            ...sequential,
            order: [...sequential.order].reverse(),
            expanded: { ...sequential.expanded, [key("p2")]: true },
          };
          await page.evaluate(
            ({ name, value }) => {
              const oldValue = localStorage.getItem(name),
                newValue = JSON.stringify(value);
              localStorage.setItem(name, newValue);
              window.dispatchEvent(
                new StorageEvent("storage", {
                  key: name,
                  oldValue,
                  newValue,
                  storageArea: localStorage,
                }),
              );
            },
            { name: preferenceKey, value: external },
          );
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-project-id="p2"] [data-testid="virtual-project-toggle"]')
                .getAttribute("aria-expanded") === "true",
          );
          await settle();
          await toggle("p0").click();
          await settle();
          const saved = await preferences();
          assert.deepEqual(saved, {
            ...external,
            expanded: { ...external.expanded, [key("p0")]: false },
          });
          await page.reload();
          await project("p43").waitFor({ state: "attached" });
          await settle();
          assert.equal(await toggle("p0").getAttribute("aria-expanded"), "false");
          assert.equal(await toggle("p1").getAttribute("aria-expanded"), "true");
          assert.equal(await toggle("p2").getAttribute("aria-expanded"), "true");
          assert.equal(await page.getByTestId("current-task").textContent(), "old-session");
          assert.equal(await page.evaluate(() => window.__selectedTask), undefined);
          await page.getByTestId("rename-header").click();
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="workspace-title"]')?.textContent ===
              "Renamed session",
          );
          if (mobile) {
            await page.getByTestId("change-header-device").click();
            await page.waitForFunction(() =>
              document
                .querySelector("[data-workspace-device-name]")
                ?.textContent.includes("updated.example.com"),
            );
            assert.equal(await page.getByTestId("plugin-store-sidebar-open").count(), 0);
          } else {
            await page.getByTestId("plugin-store-sidebar-open").click();
            assert.equal(
              await page.getByTestId("plugin-store-sidebar-open").getAttribute("aria-pressed"),
              "true",
            );
          }
          await page.screenshot({ path: join(artifacts, `expansion-${mobile}-${theme}.png`) });
          assert.deepEqual(errors, []);
          for (const motion of evidence.motions) {
            assert.deepEqual(
              motion.chromeRenders,
              {},
              "Project expansion must not render navigation, list header or session title",
            );
            assert.deepEqual(
              Object.keys(motion.renders),
              ["p0"],
              "Only the toggled project may render",
            );
            const end = motion.events.find((event) => event.type === "animationend");
            assert.equal(
              end?.name,
              motion.action === "open" ? "collapsible-down" : "collapsible-up",
            );
            assert.equal(end?.seconds, 0.3);
            const maxHeight = Math.max(...motion.samples.map((sample) => sample.height));
            assert.ok(
              motion.samples.some((sample) => sample.height > 1 && sample.height < maxHeight - 1),
              "Height must have intermediate frames",
            );
            assert.ok(
              motion.samples.some((sample) => sample.opacity > 0.05 && sample.opacity < 0.95),
              "Opacity must have intermediate frames",
            );
          }
        } finally {
          await writeFile(
            join(artifacts, `expansion-${mobile}-${theme}.json`),
            JSON.stringify(evidence, null, 2),
          );
          await page.close();
        }
      },
    );

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    test(
      `SPT03 new task ${mobile ? "mobile" : "desktop"}/${theme}`,
      { timeout: 60000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1200, height: 800 },
        });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.addInitScript(() => {
          window.__projectRenders = 0;
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject: () => 1,
            onCommitFiberUnmount: () => {},
            onPostCommitFiberRoot: () => {},
            onCommitFiberRoot(_id, root) {
              const walk = (f) => {
                if (!f) return;
                const type = f.elementType || f.type;
                const name = typeof type === "function" ? type.name : type?.type?.name;
                if (f.flags & 1 && name === "ProjectNodeContent") window.__projectRenders++;
                walk(f.child);
                walk(f.sibling);
              };
              walk(root.current);
            },
          };
        });
        const settle = () =>
          page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        try {
          await page.goto(`${origin}fixture?theme=${theme}&mobile=${mobile ? 1 : 0}`);
          await page.locator('[data-project-id="p43"]').waitFor({ state: "attached" });
          await settle();
          const initial = await page.evaluate(() => window.__projectRenders);
          assert.ok(initial >= 44, "React probe must observe initial project renders");
          await page.evaluate(() => {
            window.__projectRenders = 0;
          });
          await page.getByTestId("shell-update").click();
          await settle();
          const shellRenders = await page.evaluate(() => window.__projectRenders);
          await page.evaluate(() => {
            window.__projectRenders = 0;
          });
          await page.getByTestId("task-new-button").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="current-task"]').textContent === "draft",
          );
          await settle();
          const newTaskRenders = await page.evaluate(() => window.__projectRenders);
          await page.evaluate(() => {
            window.__projectRenders = 0;
          });
          await page.getByTestId("refresh-directory").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="refresh-count"]').textContent === "1",
          );
          await settle();
          const refreshRenders = await page.evaluate(() => window.__projectRenders);
          await page.getByTestId("rename-project").click();
          await page.getByText("Renamed project", { exact: true }).waitFor();
          const evidence = { mobile, theme, initial, shellRenders, newTaskRenders, refreshRenders };
          await writeFile(
            join(artifacts, `${mobile}-${theme}.json`),
            JSON.stringify(evidence, null, 2),
          );
          console.log(evidence);
          await page.screenshot({ path: join(artifacts, `${mobile}-${theme}.png`) });
          assert.deepEqual(errors, []);
          assert.equal(shellRenders, 0, "Unrelated Root render must not redraw projects");
          assert.equal(newTaskRenders, 0, "Local task selection must not redraw project content");
          assert.equal(refreshRenders, 0, "Equivalent directory refresh must not redraw projects");
        } finally {
          await page.close();
        }
      },
    );

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    test(
      `SPT06 running activity ${mobile ? "mobile" : "desktop"}/${theme}`,
      { timeout: 60000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1200, height: 800 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.addInitScript(trackProjectRenders);
        try {
          await page.goto(`${origin}fixture?theme=${theme}&mobile=${mobile ? 1 : 0}&activity=1`);
          await page.locator('[data-project-id="p43"]').waitFor({ state: "attached" });
          const project = page.locator('[data-project-id="p0"]');
          await project.locator(".lucide-loader-circle").waitFor();
          await page.getByTestId("fixture-chat-loading").waitFor();
          const animationState = () =>
            page.evaluate(() =>
              document
                .getAnimations()
                .filter((animation) => animation.animationName === "spin")
                .map((animation) => ({
                  name: animation.animationName,
                  time: animation.currentTime,
                  target: animation.effect.target.tagName.toLowerCase(),
                  transform: getComputedStyle(animation.effect.target).transform,
                })),
            );
          // 真实 Chromium 合成层回归：旋转必须保持加速；样式重算次数仅留作证据，避免时间阈值受机器影响。
          const cdp = await page.context().newCDPSession(page);
          let layers = [];
          cdp.on("LayerTree.layerTreeDidChange", (event) => {
            layers = event.layers ?? [];
          });
          await cdp.send("LayerTree.enable");
          await cdp.send("Performance.enable");
          await page.waitForTimeout(300);
          const metricsBefore = Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
              metric.name,
              metric.value,
            ]),
          );
          await page.waitForTimeout(750);
          const metricsAfter = Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
              metric.name,
              metric.value,
            ]),
          );
          const animationBefore = await animationState();
          const orbs = page.getByTestId("fixture-chat-loading").locator("svg g");
          const orbsBefore = await orbs.innerHTML();
          await page.waitForTimeout(150);
          const animationAfter = await animationState();
          // 消息区已改为 RAF 驱动的球体，旧像素 CSS 动画断言不再适用；侧栏仍验证合成旋转。
          assert.notEqual(await orbs.innerHTML(), orbsBefore);
          assert.equal(animationBefore.length, 1);
          assert.equal(animationAfter.length, 1);
          for (let index = 0; index < animationBefore.length; index++) {
            assert.ok(animationAfter[index].time > animationBefore[index].time);
            assert.notEqual(animationAfter[index].transform, animationBefore[index].transform);
          }
          const styleRecalculations =
            metricsAfter.RecalcStyleCount - metricsBefore.RecalcStyleCount;
          console.log({ mobile, theme, animationAfter, styleRecalculations });
          const { root: documentNode } = await cdp.send("DOM.getDocument");
          const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
            nodeId: documentNode.nodeId,
            selector: '[data-project-id="p0"] .animate-spin',
          });
          assert.equal(nodeIds.length, 1);
          const compositorReasons = [];
          for (const nodeId of nodeIds) {
            const { node } = await cdp.send("DOM.describeNode", { nodeId });
            const layer = layers.find(
              (candidate) => candidate.backendNodeId === node.backendNodeId,
            );
            assert.ok(layer, "Each spinner must have a composited layer");
            const { compositingReasonIds } = await cdp.send("LayerTree.compositingReasons", {
              layerId: layer.layerId,
            });
            assert.ok(
              compositingReasonIds.includes("ActiveTransformAnimation"),
              "Spinner rotation must run as an accelerated transform animation",
            );
            compositorReasons.push(compositingReasonIds);
          }
          await writeFile(
            join(artifacts, `animation-${mobile}-${theme}.json`),
            JSON.stringify({ animationAfter, styleRecalculations, compositorReasons }, null, 2),
          );
          await cdp.detach();
          await page.screenshot({ path: join(artifacts, `loading-${mobile}-${theme}.png`) });
          await page.waitForFunction(
            () => document.querySelector('[data-testid="activity-version"]').textContent === "1",
          );
          await page.evaluate(() => {
            window.__projectRendersById = {};
          });
          for (let index = 2; index <= 7; index++) {
            await page.getByTestId("activity-tick").click();
            await page.waitForFunction(
              (value) =>
                document.querySelector('[data-testid="activity-version"]').textContent ===
                String(value),
              index,
            );
          }
          const renders = await page.evaluate(() => window.__projectRendersById);
          await writeFile(
            join(artifacts, `activity-${mobile}-${theme}.json`),
            JSON.stringify({ mobile, theme, renders }, null, 2),
          );
          console.log({ mobile, theme, activityRenders: renders });
          assert.ok(renders.p0 >= 6, "Each real activity update reaches the affected project");
          assert.deepEqual(
            Object.keys(renders),
            ["p0"],
            "Activity must not render unrelated project content",
          );
          await page.getByTestId("activity-complete").click();
          await project.locator(".lucide-loader-circle").waitFor({ state: "detached" });
          await page.getByTestId("fixture-chat-loading").waitFor({ state: "detached" });
          await page.getByTestId("change-task").click();
          await project.getByText("Renamed task", { exact: true }).waitFor();
          await project.getByTestId("virtual-project-toggle").click();
          await project.getByTestId("virtual-project-unread").waitFor();
          await project.getByTestId("virtual-project-toggle").click();
          await page.getByTestId("rename-project").click();
          await project.getByText("Renamed project", { exact: true }).waitFor();
          await project.getByTestId("virtual-project-menu").click();
          await page.getByTestId("virtual-project-pin").click();
          await project
            .locator('[data-testid="virtual-project-toggle"] .lucide-pin')
            .waitFor({ state: "attached" });
          await project.getByTestId("virtual-project-menu").click();
          await page.getByTestId("virtual-project-pin").click();
          await project
            .locator('[data-testid="virtual-project-toggle"] .lucide-pin')
            .waitFor({ state: "detached" });
          await page.screenshot({ path: join(artifacts, `activity-${mobile}-${theme}.png`) });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    test(
      `RRI06 directory and grouped task isolation ${mobile}/${theme}`,
      { timeout: 60000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1200, height: 800 },
        });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.addInitScript(() => {
          window.__boundaryRenders = {};
          const seen = new WeakMap();
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject: () => 1,
            onCommitFiberUnmount() {},
            onPostCommitFiberRoot() {},
            onCommitFiberRoot(_id, root) {
              const walk = (f) => {
                if (!f) return;
                const previous = seen.get(f) ?? seen.get(f.alternate);
                const name = typeof f.type === "function" ? f.type.name : null;
                if (
                  f.flags & 1 &&
                  previous !== f.actualStartTime &&
                  [
                    "ProjectNode",
                    "ProjectComposerMenu",
                    "DirectoryCommandConsumer",
                    "GroupedTaskRowComponent",
                    "GroupedTaskItemComponent",
                  ].includes(name)
                ) {
                  const key =
                    name +
                    ":" +
                    (f.memoizedProps.project?.id ?? f.memoizedProps.task?.taskId ?? "");
                  window.__boundaryRenders[key] = (window.__boundaryRenders[key] ?? 0) + 1;
                }
                seen.set(f, f.actualStartTime);
                if (f.alternate) seen.set(f.alternate, f.actualStartTime);
                walk(f.child);
                walk(f.sibling);
              };
              walk(root.current);
            },
          };
        });
        const settle = () =>
          page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          );
        try {
          await page.goto(
            `${origin}fixture?theme=${theme}&mobile=${mobile ? 1 : 0}&activity=1&boundaries=1`,
          );
          await page.locator('[data-project-id="p43"]').waitFor({ state: "attached" });
          await settle();
          const mounted = await page.evaluate(() => window.__boundaryRenders);
          assert.ok(
            mounted["ProjectComposerMenu:"] > 0 && mounted["DirectoryCommandConsumer:"] > 0,
          );
          await page.getByTestId("activity-tick").hover();
          await settle();
          await page.evaluate(() => (window.__boundaryRenders = {}));
          for (let n = 0; n < 6; n++) {
            await page.getByTestId("activity-tick").click();
            await settle();
          }
          const projects = await page.evaluate(() => window.__boundaryRenders);
          await page.getByTestId("sidebar-view-menu").click();
          await page.getByTestId("sidebar-view-grouped").click();
          await page.getByText("Unrelated 7", { exact: true }).waitFor();
          await settle();
          assert.ok(
            (await page.evaluate(() => window.__boundaryRenders))[
              "GroupedTaskRowComponent:unrelated-7"
            ] > 0,
          );
          await page.getByTestId("activity-tick").hover();
          await settle();
          await page.evaluate(() => (window.__boundaryRenders = {}));
          for (let n = 0; n < 6; n++) {
            await page.getByTestId("activity-tick").click();
            await settle();
          }
          const grouped = await page.evaluate(() => window.__boundaryRenders);
          await page.getByTestId("activate-task").hover();
          await settle();
          await page.evaluate(() => (window.__boundaryRenders = {}));
          await page.getByTestId("activate-task").click();
          await settle();
          const selection = await page.evaluate(() => window.__boundaryRenders);
          assert.ok(selection["GroupedTaskRowComponent:running-task"] > 0);
          assert.ok(
            await page
              .getByText("Running task", { exact: true })
              .evaluate((el) => el.closest('[role="button"]')?.classList.contains("bg-selected")),
          );
          for (let n = 0; n < 8; n++) {
            assert.equal(
              selection[`GroupedTaskRowComponent:unrelated-${n}`] ?? 0,
              0,
              "Selection must not redraw unrelated task rows",
            );
            assert.equal(
              selection[`GroupedTaskItemComponent:unrelated-${n}`] ?? 0,
              0,
              "Selection must not redraw unrelated task wrappers",
            );
          }
          await page.getByTestId("change-task").click();
          await page.getByText("Renamed task", { exact: true }).waitFor();
          await page.getByText("Renamed task", { exact: true }).click();
          assert.equal(
            (await page.evaluate(() => window.__selectedTask))[4],
            100,
            "Stable event reads latest unreadAt",
          );
          await page.getByTestId("activity-complete").click();
          await settle();
          await page.getByTestId("rename-project").click();
          await settle();
          const after = await page.evaluate(() => window.__boundaryRenders);
          assert.ok(after["ProjectComposerMenu:"] > 0, "Project changes still reach selector");
          await writeFile(
            join(artifacts, `boundaries-${mobile}-${theme}.json`),
            JSON.stringify({ mounted, projects, grouped, selection, after }, null, 2),
          );
          assert.equal(projects["ProjectComposerMenu:"] ?? 0, 0);
          assert.equal(projects["DirectoryCommandConsumer:"] ?? 0, 0);
          assert.ok(
            !Object.keys(projects).some(
              (key) => key.startsWith("ProjectNode:") && key !== "ProjectNode:p0",
            ),
          );
          assert.ok(
            grouped["GroupedTaskRowComponent:running-task"] >= 6,
            "Relevant activity updates are visible",
          );
          for (let n = 0; n < 8; n++)
            assert.equal(grouped[`GroupedTaskRowComponent:unrelated-${n}`] ?? 0, 0);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
