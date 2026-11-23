import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("CR 桌面崩溃重启", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  it("CR01/02/05：真实 renderer 崩溃可取消，错误页可直接重启", async () => {
    const url = await browser.getUrl();
    await browser.electron.execute((electron, url) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (item) => item.webContents.getURL() === url,
      )!;
      const state = {
        dialogs: [] as Electron.MessageBoxOptions[],
        order: [] as string[],
        originalDialog: electron.dialog.showMessageBox,
        originalRelaunch: electron.app.relaunch,
        originalExit: electron.app.exit,
        originalQuit: electron.app.quit,
      };
      Object.assign(globalThis, { __crashRestartTest: state });
      electron.app.relaunch = () => {
        state.order.push("relaunch");
      };
      electron.app.exit = () => {
        state.order.push("exit");
      };
      electron.app.quit = () => {
        state.order.push("quit");
      };
      electron.dialog.showMessageBox = (async (...args: unknown[]) => {
        state.dialogs.push(args.at(-1) as Electron.MessageBoxOptions);
        // 同一事故的重复事件不能叠加恢复弹窗。
        win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
        // 原生对话框边界选择“稍后”；页面确已崩溃，随后只为恢复 WebDriver 通道而重新加载。
        setTimeout(() => win.webContents.reload(), 200);
        return { response: 1, checkboxChecked: false };
      }) as typeof electron.dialog.showMessageBox;
      win.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
      win.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 0 });
    }, url);
    try {
      expect(await readEvidence()).toEqual({ dialogs: [], order: [] });
      await browser.electron.execute(async (electron) => {
        const auxiliary = new electron.BrowserWindow({ show: false });
        await auxiliary.loadURL("data:text/html,<h1>E2E_AUXILIARY_CRASH</h1>");
        await new Promise<void>((resolve) => {
          auxiliary.webContents.once("render-process-gone", () => resolve());
          auxiliary.webContents.forcefullyCrashRenderer();
        });
        auxiliary.destroy();
      });
      expect(await readEvidence()).toEqual({ dialogs: [], order: [] });
      await browser.electron.execute(async (electron, url) => {
        const win = electron.BrowserWindow.getAllWindows().find(
          (item) => item.webContents.getURL() === url,
        )!;
        // Main 调试通道不依赖 renderer；等待测试对话框完成取消后的真实 reload，
        // 否则仅观察到弹窗就执行 DOM 命令，会在页面仍崩溃时被 WebDriver 拒绝。
        await new Promise<void>((resolve) => {
          win.webContents.once("did-finish-load", () => resolve());
          win.webContents.forcefullyCrashRenderer();
        });
      }, url);
      await browser.waitUntil(
        async () => {
          try {
            return (await readEvidence()).dialogs.length === 1;
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      );
      const cancelled = await readEvidence();
      expect(cancelled.dialogs[0]!.buttons).toHaveLength(2);
      expect(cancelled.order).toEqual([]);

      await browser.waitUntil(() =>
        inRenderer(
          url,
          () =>
            document.body.classList.contains("zcode-startup-ready") &&
            !document.getElementById("loading"),
        ),
      );

      // 在真实入口的根边界设置故障状态；独立浏览器验收另覆盖真实子组件抛错。
      await inRenderer(url, () => {
        localStorage.setItem("zcode-locale-preference", "en-US");
        const root = document.getElementById("root")!;
        const key = Object.keys(root).find((name) => name.startsWith("__reactContainer$"))!;
        type Fiber = {
          stateNode?: {
            current?: Fiber;
            props?: { onRestart?: unknown };
            setState?: (value: unknown) => void;
          };
          child?: Fiber;
          sibling?: Fiber;
        };
        const container = (root as unknown as Record<string, Fiber>)[key]!;
        const queue = [container.stateNode?.current ?? container];
        while (queue.length) {
          const node = queue.pop()!;
          if (node.stateNode?.props?.onRestart && node.stateNode.setState) {
            node.stateNode.setState({ error: new Error("E2E_CRASH_RESTART"), componentStack: "" });
            return;
          }
          if (node.child) queue.push(node.child);
          if (node.sibling) queue.push(node.sibling);
        }
        throw new Error("Desktop 根边界未注入重启能力");
      });
      await browser.waitUntil(() =>
        inRenderer(url, () => {
          const button = document.querySelector<HTMLElement>('[data-testid="app-error-restart"]');
          if (!button) return false;
          const rect = button.getBoundingClientRect();
          const target = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return rect.width > 0 && (target === button || button.contains(target));
        }),
      );
      const clickRestart = () =>
        inRenderer(url, () => {
          document.querySelector<HTMLElement>('[data-testid="app-error-restart"]')!.click();
        });
      await clickRestart();
      await browser.waitUntil(async () => (await readEvidence()).order.length === 2);
      expect((await readEvidence()).order).toEqual(["relaunch", "exit"]);
      await clickRestart();
      expect((await readEvidence()).order).toEqual(["relaunch", "exit"]);
      const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
      await mkdir(artifacts, { recursive: true });
      await inRenderer(
        url,
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const screenshot = await browser.electron.execute(async (electron, url) => {
        const win = electron.BrowserWindow.getAllWindows().find(
          (item) => item.webContents.getURL() === url,
        )!;
        return (await win.webContents.capturePage()).toPNG().toString("base64");
      }, url);
      await writeFile(join(artifacts, "crash-error-page.png"), Buffer.from(screenshot, "base64"));
      await writeFile(
        join(artifacts, "crash-restart.json"),
        JSON.stringify(await readEvidence(), null, 2),
      );
    } finally {
      await browser.electron.execute((electron) => {
        const state = (
          globalThis as typeof globalThis & {
            __crashRestartTest: {
              originalDialog: typeof electron.dialog.showMessageBox;
              originalRelaunch: typeof electron.app.relaunch;
              originalExit: typeof electron.app.exit;
              originalQuit: typeof electron.app.quit;
            };
          }
        ).__crashRestartTest;
        electron.dialog.showMessageBox = state.originalDialog;
        electron.app.relaunch = state.originalRelaunch;
        electron.app.exit = state.originalExit;
        electron.app.quit = state.originalQuit;
      });
    }
  });
});

async function readEvidence() {
  return browser.electron.execute(() => {
    const state = (
      globalThis as typeof globalThis & {
        __crashRestartTest: {
          dialogs: Electron.MessageBoxOptions[];
          order: string[];
        };
      }
    ).__crashRestartTest;
    return { dialogs: state.dialogs, order: state.order };
  });
}

// ChromeDriver 会记住已崩溃 target，即使 renderer 已 reload 仍拒绝 DOM 命令。
// 后续操作经 Main 调试通道进入真实 renderer，继续验证 React 按钮、preload 和 IPC。
async function inRenderer<T>(url: string, run: () => T): Promise<T> {
  return browser.electron.execute(
    (electron, url, script) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (item) => item.webContents.getURL() === url,
      )!;
      return win.webContents.executeJavaScript(`(${script})()`);
    },
    url,
    run.toString(),
  ) as Promise<T>;
}
