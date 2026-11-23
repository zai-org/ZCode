import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

type Options = {
  binary: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  profileDirectory: string;
  logDirectory: string;
  startupTimeoutMs?: number;
};
type RunningApp = {
  child: ChildProcess;
  exited: Promise<void>;
  exit?: string;
  logs: Promise<unknown>[];
};
type ReadyApp = { pid: number; debuggerAddress: string };
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** runner 是唯一 App 进程 owner；ChromeDriver 只连接，不负责创建应用。 */
export class PrelaunchedElectronOwner {
  private current?: RunningApp;
  private starting?: Promise<ReadyApp>;
  private ready?: ReadyApp;
  private attached?: { sessionId: string; pid: number };
  private port?: number;
  private browserIdentity?: string;
  private generation = 0;
  constructor(private readonly options: Options) {}

  start(): Promise<ReadyApp> {
    if (this.starting) return this.starting;
    if (this.current && this.current.exit === undefined && this.ready)
      return Promise.resolve(this.ready);
    const task = this.launch().finally(() => {
      if (this.starting === task) this.starting = undefined;
    });
    this.starting = task;
    return task;
  }
  attach(sessionId: string, pid: number): void {
    if (!this.ready || !this.current || this.current.exit !== undefined)
      throw new Error("Cannot attach a session without a running App");
    if (pid !== this.ready.pid) throw new Error("Connected process does not belong to this runner");
    if (this.attached && this.attached.sessionId !== sessionId)
      throw new Error("App already belongs to another driver session");
    this.attached = { sessionId, pid };
  }
  async closeSession(sessionId: string, requestQuit: () => Promise<unknown>): Promise<void> {
    if (this.attached?.sessionId !== sessionId || this.current?.child.pid !== this.attached.pid)
      return;
    // reloadSession 会再次删除旧协议会话；先撤销绑定，旧删除不得结束刚启动的新 App。
    this.attached = undefined;
    const current = this.current;
    if (current.exit !== undefined) return;
    try {
      await requestQuit();
    } catch (error) {
      if (current.exit === undefined) throw error;
    }
    if (!(await waitForOwnedExit(current, 10000)))
      throw new Error("App did not exit after quit request");
    await Promise.allSettled(current.logs);
  }
  async dispose(): Promise<void> {
    const current = this.current;
    this.attached = undefined;
    if (!current) return;
    if (current.exit === undefined) {
      current.child.kill("SIGTERM");
      await waitForOwnedExit(current, 3000);
      if (current.exit === undefined) {
        current.child.kill("SIGKILL");
        await current.exited;
      }
    }
    await Promise.allSettled(current.logs);
  }
  private async launch(): Promise<ReadyApp> {
    if (this.current) await Promise.allSettled(this.current.logs);
    const { profileDirectory, logDirectory, startupTimeoutMs = 20000 } = this.options;
    await mkdir(profileDirectory, { recursive: true });
    await mkdir(logDirectory, { recursive: true });
    const activePortPath = join(profileDirectory, "DevToolsActivePort");
    await rm(activePortPath, { force: true });
    const environment = { ...this.options.environment };
    // ChromeDriver 原本会清掉 NODE_OPTIONS；独立启动也不能继承 WDIO 的 tsx loader。
    delete environment.NODE_OPTIONS;
    delete environment.ELECTRON_RUN_AS_NODE;
    const args = this.options.args.filter(
      (arg) => !arg.startsWith("--remote-debugging-port=") && !arg.startsWith("--user-data-dir="),
    );
    args.push(`--remote-debugging-port=${this.port ?? 0}`, `--user-data-dir=${profileDirectory}`);
    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const generation = ++this.generation;
    const current: RunningApp = { child, exited: Promise.resolve(), logs: [] };
    current.exited = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        current.exit = String(error);
        resolve();
      });
      child.once("exit", (code, signal) => {
        current.exit = `code=${code} signal=${signal}`;
        const receipt = writeFile(
          join(logDirectory, `app-${generation}.exit.json`),
          JSON.stringify({ pid: child.pid, code, signal }),
        );
        current.logs.push(receipt);
        void receipt.finally(resolve).catch(() => undefined);
      });
    });
    current.logs = [
      pipeline(
        child.stdout!,
        createWriteStream(join(logDirectory, `app-${generation}.stdout.log`)),
      ).catch(() => undefined),
      pipeline(
        child.stderr!,
        createWriteStream(join(logDirectory, `app-${generation}.stderr.log`)),
      ).catch(() => undefined),
    ];
    this.current = current;
    this.ready = undefined;
    const deadline = Date.now() + startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        if (current.exit !== undefined)
          throw new Error(`App exited before debugging ready: ${current.exit}`);
        if (!this.port) {
          try {
            const port = Number((await readFile(activePortPath, "utf8")).split("\n")[0]);
            if (Number.isInteger(port) && port > 0 && port <= 65535) this.port = port;
          } catch (error) {
            // 根因：Windows 上 Chromium 写 DevToolsActivePort 期间独占该文件，此时读取报 EBUSY；
            // 原来只把 ENOENT 当未就绪，EBUSY 直接让 App 启动失败。两者都说明端口尚未可读，继续轮询。
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "EBUSY") throw error;
          }
        }
        if (this.port) {
          try {
            const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
              signal: AbortSignal.timeout(500),
            });
            const value = (await response.json()) as { webSocketDebuggerUrl?: string };
            if (
              response.ok &&
              value.webSocketDebuggerUrl &&
              value.webSocketDebuggerUrl !== this.browserIdentity
            ) {
              this.browserIdentity = value.webSocketDebuggerUrl;
              this.ready = { pid: child.pid!, debuggerAddress: `127.0.0.1:${this.port}` };
              await writeFile(
                join(logDirectory, `app-${generation}.launch.json`),
                JSON.stringify({
                  ...this.ready,
                  binary: this.options.binary,
                  args,
                  cwd: this.options.cwd,
                }),
              );
              return this.ready;
            }
          } catch {
            /* 调试端口尚未监听；以真实端口响应与进程退出作为边界。 */
          }
        }
        await delay(50);
      }
      throw new Error("App debugging endpoint did not become ready");
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
}

async function waitForOwnedExit(current: RunningApp, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      current.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type OwnedAppCallbacks = {
  owner: PrelaunchedElectronOwner;
  restartAfterExit(): Promise<ReadyApp>;
  bind(browser: WebdriverIO.Browser): Promise<void>;
};
type BrowserWithOwnedApp = WebdriverIO.Browser & { __zcodeE2EOwnedApp?: OwnedAppCallbacks };

export async function restartPrelaunchedElectronAfterExit(
  browser: WebdriverIO.Browser,
): Promise<void> {
  await (browser as BrowserWithOwnedApp).__zcodeE2EOwnedApp?.restartAfterExit();
}
export async function bindPrelaunchedElectronSession(
  browser: WebdriverIO.Browser,
  owner?: PrelaunchedElectronOwner,
): Promise<void> {
  const bound = browser as BrowserWithOwnedApp;
  if (owner && !bound.__zcodeE2EOwnedApp) {
    // config与spec可被loader实例化多次；操作闭包显式绑定到同一个browser，不查模块全局状态。
    Object.defineProperty(bound, "__zcodeE2EOwnedApp", {
      configurable: true,
      value: {
        owner,
        restartAfterExit: () => owner.start(),
        bind: async (current: WebdriverIO.Browser) =>
          owner.attach(current.sessionId, await current.electron.execute(() => process.pid)),
      } satisfies OwnedAppCallbacks,
    });
    browser.overwriteCommand(
      "deleteSession" as never,
      async function (
        this: WebdriverIO.Browser,
        original: (...args: unknown[]) => Promise<unknown>,
        ...args: unknown[]
      ) {
        const sessionId = this.sessionId;
        const result = await original(...args);
        // attach会话删除只分离driver；通过既有main bridge请求正常退出，再交给真实退出屏障。
        await owner.closeSession(sessionId, () =>
          this.electron.execute((electron) => electron.app.quit()),
        );
        return result;
      } as never,
    );
  }
  if (owner && bound.__zcodeE2EOwnedApp?.owner !== owner)
    throw new Error("Browser already has another App owner");
  await bound.__zcodeE2EOwnedApp?.bind(browser);
}
