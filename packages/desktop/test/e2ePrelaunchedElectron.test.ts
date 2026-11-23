import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PrelaunchedElectronOwner,
  bindPrelaunchedElectronSession,
} from "#e2e/helpers/e2e-prelaunched-electron";

// Windows 上 Chromium 写 DevToolsActivePort 期间读取会得到 EBUSY；Node 自身打开文件不加独占锁，
// 无法用真实进程稳定复现，所以按次数让 owner 读到 EBUSY，其余读取走真实实现。
const busyReads = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (String(path).endsWith("DevToolsActivePort") && busyReads.remaining > 0) {
        busyReads.remaining -= 1;
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  busyReads.remaining = 0;
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(source?: string) {
  const directory = await mkdtemp(join(tmpdir(), "e2e-app-owner-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "app.mjs");
  await writeFile(
    file,
    source ??
      `
    import {createServer} from 'node:http';
    import {writeFile,mkdir} from 'node:fs/promises';
    import {join} from 'node:path';
    const args=process.argv.slice(2);
    const profile=args.find(arg=>arg.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
    const port=Number(args.find(arg=>arg.startsWith('--remote-debugging-port=')).split('=')[1]);
    const server=createServer((request,response)=>{
      if(request.url==='/quit'){response.setHeader('connection','close');response.end('bye');server.close();return;}
      response.setHeader('content-type','application/json');response.end(JSON.stringify({webSocketDebuggerUrl:'ws://127.0.0.1:'+server.address().port+'/devtools/browser/'+process.pid}));
    });
    server.listen(port,'127.0.0.1',async()=>{
      await mkdir(profile,{recursive:true});
      await writeFile(join(profile,'DevToolsActivePort'),String(server.address().port)+'\\n/browser/'+process.pid);
    });
  `,
  );
  const owner = new PrelaunchedElectronOwner({
    binary: process.execPath,
    args: [file],
    cwd: directory,
    environment: { ...process.env, NODE_OPTIONS: "--invalid-if-inherited" },
    profileDirectory: join(directory, "profile"),
    logDirectory: join(directory, "logs"),
    startupTimeoutMs: 3000,
  });
  cleanup.push(() => owner.dispose());
  return { owner, directory };
}

describe("E2E 独立 App owner", () => {
  it("不同加载实例通过browser上显式绑定的owner重启，不重新查模块全局状态", async () => {
    const { owner } = await fixture();
    const first = await owner.start();
    const browser = {
      sessionId: "bound-session",
      electron: { execute: vi.fn(async () => first.pid) },
      overwriteCommand: vi.fn(),
    } as unknown as WebdriverIO.Browser;
    await bindPrelaunchedElectronSession(browser, owner);
    await owner.dispose();
    vi.resetModules();
    const reloaded = await import("#e2e/helpers/e2e-prelaunched-electron");
    await reloaded.restartPrelaunchedElectronAfterExit(browser);
    const actual = await (await fetch(`http://${first.debuggerAddress}/json/version`)).json();
    expect(actual.webSocketDebuggerUrl).not.toContain(`/browser/${first.pid}`);
  });
  it("合并并发启动，退出后复用连接地址，旧会话删除不关闭新进程", async () => {
    const { owner } = await fixture();
    const [first, duplicate] = await Promise.all([owner.start(), owner.start()]);
    expect(duplicate.pid).toBe(first.pid);
    expect(() => owner.attach("wrong-process", first.pid + 1)).toThrow("does not belong");
    owner.attach("session-1", first.pid);
    await owner.closeSession("session-1", () => fetch(`http://${first.debuggerAddress}/quit`));
    const second = await owner.start();
    expect(second.pid).not.toBe(first.pid);
    expect(second.debuggerAddress).toBe(first.debuggerAddress);
    owner.attach("session-2", second.pid);
    await owner.closeSession("session-1", async () => {
      throw new Error("stale session must not quit");
    });
    expect(
      (await (await fetch(`http://${second.debuggerAddress}/json/version`)).json())
        .webSocketDebuggerUrl,
    ).toContain(String(second.pid));
    await owner.closeSession("session-2", () => fetch(`http://${second.debuggerAddress}/quit`));
    expect(() => process.kill(second.pid, 0)).toThrow();
  });
  it("读取端口文件遇到 EBUSY 时按未就绪继续轮询", async () => {
    const { owner } = await fixture();
    busyReads.remaining = 2;
    const ready = await owner.start();
    expect(busyReads.remaining).toBe(0);
    const actual = await (await fetch(`http://${ready.debuggerAddress}/json/version`)).json();
    expect(actual.webSocketDebuggerUrl).toContain(`/browser/${ready.pid}`);
  });
  it("启动提前退出时拒绝连接，不把旧端口文件当成就绪", async () => {
    const { owner, directory } = await fixture("setTimeout(() => process.exit(23), 100);");
    const stale = createServer((_request, response) =>
      response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://stale/browser" })),
    );
    await new Promise<void>((resolve) => stale.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => stale.close(() => resolve())));
    const address = stale.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    await mkdir(join(directory, "profile"));
    await writeFile(join(directory, "profile/DevToolsActivePort"), `${address.port}\n/stale`);
    await expect(owner.start()).rejects.toThrow("23");
  });
});
