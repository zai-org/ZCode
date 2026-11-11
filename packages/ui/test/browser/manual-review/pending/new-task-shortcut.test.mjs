import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { chromium } from "playwright-core";

// SPT04/SPT08：连接已有多项目 Dev App，不发送 prompt，不替换菜单、Root、App 或 tab store。
// macOS 的 CDP keydown 不经过系统菜单 accelerator，必须发送原生 Cmd+N 并确认菜单事件。
test(
  "SPT04/SPT08: new-task click and native shortcut preserve sidebar rendering through prewarm",
  { timeout: 180_000 },
  async () => {
    const connection = await chromium.connectOverCDP(
      process.env.ZCODE_E2E_CDP_URL ?? "http://localhost:9229",
    );
    const page = connection
      .contexts()[0]
      .pages()
      .find((candidate) => /localhost:517/.test(candidate.url()));
    assert.ok(page, "需要运行中的 ZCode Dev App");
    const artifacts =
      process.env.ZCODE_E2E_ARTIFACT_DIR ??
      fileURLToPath(
        new URL("../../../../../desktop/.e2e-artifacts/new-task-shortcut/", import.meta.url),
      );
    await mkdir(artifacts, { recursive: true });
    const originalClass = await page.locator("html").getAttribute("class");
    const row = process.env.ZCODE_E2E_TASK_ID
      ? page.getByTestId(`task-item-${process.env.ZCODE_E2E_TASK_ID}`).first()
      : page.locator("[data-project-id] [data-task-item-key]").first();
    const target = await row.evaluate((element) => ({
      key: element.getAttribute("data-task-item-key"),
      name: element.closest("[data-project-id]").getAttribute("data-project-name"),
    }));
    const sessionId = target.key.slice(target.key.lastIndexOf(":") + 1);
    const browserCdp = await connection.newBrowserCDPSession();
    const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
    const pid = processInfo.find((process) => process.type === "browser")?.id;
    const cdp = await page.context().newCDPSession(page);
    const evidence = [];
    let tracing = false;
    try {
      assert.ok(
        (await page.locator("[data-project-id]").count()) >= 40,
        "需要至少 40 个项目的现场",
      );
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => {
          element.className = `${value} theme-zai-${value}`;
        }, theme);
        for (let index = 0; index < 2; index++) {
          const entry = index === 0 ? "click" : "shortcut";
          const task = page.locator("[data-task-item-key]").filter({ visible: true });
          await task.evaluateAll(
            (elements, key) =>
              elements
                .find((element) => element.getAttribute("data-task-item-key") === key)
                ?.click(),
            target.key,
          );
          await page.locator(`[data-session-id="${sessionId}"]`).waitFor({ state: "visible" });
          // 采样前让历史恢复、hover 与目录刷新收口；窗口长度只用于测量，不参与产品状态同步。
          await page.waitForTimeout(1000);
          await page.bringToFront();
          await page.evaluate(() => {
            const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) throw new Error("需要 React Dev 运行时");
            const original = hook.onCommitFiberRoot;
            const nameOf = (fiber) => {
              const type = fiber.elementType || fiber.type;
              return typeof type === "function" ? type.name : type?.type?.name;
            };
            // 只读 App 已有的预览 scope ref，记录旧 session → null → 预热 session 的提交。
            const pluginSessions = [];
            const recordScope = (fiber) => {
              if (nameOf(fiber) !== "App") return;
              for (let state = fiber.memoizedState; state; state = state.next) {
                const scope = state.memoizedState?.current;
                if (scope && typeof scope === "object" && "pluginUiSessionId" in scope) {
                  const id = scope.pluginUiSessionId;
                  if (!pluginSessions.length || pluginSessions.at(-1) !== id)
                    pluginSessions.push(id);
                }
              }
            };
            const projectNode = document.querySelector("[data-project-id]");
            const fiberKey = Object.keys(projectNode).find((key) =>
              key.startsWith("__reactFiber$"),
            );
            let root = projectNode[fiberKey];
            while (root?.return) root = root.return;
            let trackedProjectInstances = 0;
            const countInstances = (fiber) => {
              if (!fiber) return;
              recordScope(fiber);
              if (nameOf(fiber) === "ProjectNodeContent") trackedProjectInstances++;
              countInstances(fiber.child);
              countInstances(fiber.sibling);
            };
            countInstances(root);
            const sample = {
              trackedProjectInstances,
              pluginSessions,
              menuEvents: 0,
              projectRenders: 0,
              projectRendersById: {},
              sidebarProps: [],
              firstFrameMs: null,
              longTasks: [],
            };
            const nodes = [...document.querySelectorAll("[data-project-id], [data-task-item-key]")];
            let start = null;
            window.__newTaskShortcutBegin = () => {
              start = performance.now();
            };
            const dispose = window.zcode.onNewTask(() => {
              sample.menuEvents++;
              start = performance.now();
            });
            const observer = new PerformanceObserver((list) => {
              if (start !== null)
                sample.longTasks.push(
                  ...list
                    .getEntries()
                    .filter((entry) => entry.startTime >= start)
                    .map((entry) => entry.duration),
                );
            });
            observer.observe({ type: "longtask" });
            hook.onCommitFiberRoot = function (...args) {
              if (start !== null) {
                const walk = (fiber) => {
                  if (!fiber) return;
                  const name = nameOf(fiber);
                  recordScope(fiber);
                  if (fiber.flags & 1) {
                    if (name === "ProjectNodeContent") {
                      sample.projectRenders++;
                      const id = fiber.memoizedProps.project.id;
                      sample.projectRendersById[id] = (sample.projectRendersById[id] ?? 0) + 1;
                    }
                    if (name === "ProjectSidebar")
                      sample.sidebarProps.push(
                        Object.keys(fiber.memoizedProps || {}).filter(
                          (key) =>
                            !Object.is(
                              fiber.memoizedProps[key],
                              fiber.alternate?.memoizedProps?.[key],
                            ),
                        ),
                      );
                  }
                  // bailout 复用子树时其旧 flags 仍在；只沿本次提交的新子树计数。
                  if (!fiber.alternate || fiber.child !== fiber.alternate.child) walk(fiber.child);
                  walk(fiber.sibling);
                };
                walk(args[1].current);
                if (
                  sample.firstFrameMs === null &&
                  document.querySelector('[data-session-id="draft"]')
                ) {
                  sample.firstFrameMs = -1;
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                      sample.firstFrameMs = performance.now() - start;
                    }),
                  );
                }
              }
              return original?.apply(this, args);
            };
            window.__newTaskShortcutSample = () => {
              dispose();
              observer.disconnect();
              hook.onCommitFiberRoot = original;
              delete window.__newTaskShortcutSample;
              delete window.__newTaskShortcutBegin;
              return {
                ...sample,
                retainedNodes: nodes.filter((node) => node.isConnected).length,
                originalNodes: nodes.length,
              };
            };
          });
          if (process.env.ZCODE_E2E_TRACE === "1" && index === 0) {
            await cdp.send("Tracing.start", {
              categories:
                "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.screenshot",
              transferMode: "ReturnAsStream",
            });
            tracing = true;
          }
          // 等待真实 createSession ACK 的已有日志，不能只等空草稿首帧就漏掉第二次提交。
          const prewarmReady = page
            .waitForEvent("console", {
              predicate: (message) =>
                message.text().includes("[v4-draft-prewarm] draft session 预热就绪"),
              timeout: 30_000,
            })
            .catch(() => null);
          if (entry === "click") {
            await page.evaluate(() => window.__newTaskShortcutBegin());
            await page.getByTestId("task-new-button").click();
          } else if (process.platform === "darwin") {
            assert.ok(Number.isInteger(pid), "需要 Electron browser PID");
            await promisify(execFile)("osascript", [
              "-e",
              `tell application "System Events" to tell first application process whose unix id is ${pid}\nset frontmost to true\nkey code 45 using command down\nend tell`,
            ]);
          } else {
            await page.keyboard.press("Control+n");
          }
          await page
            .locator('[data-session-id="draft"]')
            .waitFor({ state: "visible", timeout: 15_000 });
          await page
            .getByTestId("composer-workspace-trigger")
            .filter({ hasText: target.name })
            .waitFor({ state: "visible" });
          const prewarm = await prewarmReady;
          await page.waitForTimeout(1000);
          const sample = await page.evaluate(() => window.__newTaskShortcutSample());
          evidence.push({ theme, entry, prewarmReady: Boolean(prewarm), ...sample });
          if (tracing) {
            const completed = new Promise((resolve) =>
              cdp.once("Tracing.tracingComplete", resolve),
            );
            await cdp.send("Tracing.end");
            const { stream } = await completed;
            let trace = "";
            for (;;) {
              const chunk = await cdp.send("IO.read", { handle: stream });
              trace += chunk.base64Encoded
                ? Buffer.from(chunk.data, "base64").toString()
                : chunk.data;
              if (chunk.eof) break;
            }
            await cdp.send("IO.close", { handle: stream });
            await writeFile(`${artifacts}/${theme}-trace.json`, trace);
            tracing = false;
          }
          await page.screenshot({ path: `${artifacts}/${theme}-${index}.png` });
        }
      }
      console.log(JSON.stringify(evidence));
      assert.ok(
        evidence.every((sample) => sample.menuEvents === (sample.entry === "shortcut" ? 1 : 0)),
        "快捷键必须经过一次真实菜单事件；点击使用实际按钮",
      );
      assert.ok(
        evidence.every((sample) => sample.trackedProjectInstances >= 40),
        "计数器必须识别现场的项目组件，不能把未识别误报为零更新",
      );
      assert.ok(
        evidence.every(
          (sample) =>
            sample.pluginSessions.includes(null) &&
            typeof sample.pluginSessions.at(-1) === "string" &&
            sample.pluginSessions.at(-1) !== sessionId,
        ),
        "必须覆盖活动 session 清空及预热 session 提交，不能只采草稿首帧",
      );
      assert.ok(
        evidence.every((sample) => sample.prewarmReady),
        "必须观察到真实草稿预热完成",
      );
      assert.ok(
        evidence.every((sample) => sample.retainedNodes === sample.originalNodes),
        "列表节点不能重挂载",
      );
      assert.ok(
        evidence.every((sample) => sample.firstFrameMs > 0),
        "必须观察到草稿首帧",
      );
      assert.equal(
        evidence.reduce((sum, sample) => sum + sample.projectRenders, 0),
        0,
        "新建点击及 Cmd/Ctrl+N 在预热前后均不应重渲染无关项目内容",
      );
    } finally {
      await writeFile(`${artifacts}/samples.json`, JSON.stringify(evidence, null, 2));
      if (tracing) await cdp.send("Tracing.end");
      await page.evaluate(() => window.__newTaskShortcutSample?.());
      await page.locator("html").evaluate((element, value) => {
        element.className = value ?? "";
      }, originalClass);
      await cdp.detach();
      await browserCdp.detach();
      await connection.close();
    }
  },
);
