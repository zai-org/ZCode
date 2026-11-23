import { accessSync, constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createManagedCdpBrowserRuntime,
  isAllowedManagedBrowserUrl,
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
} from "../src/browser/index.js";

describe("managed CDP browser adapter", () => {
  it("advertises a real cdp descriptor only after launch", async () => {
    let launched = 0;
    let closed = 0;
    const listeners = new Map<string, () => void>();
    const fakeBrowser = {
      close: async () => {
        closed += 1;
        listeners.get("disconnected")?.();
      },
      isConnected: () => true,
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: async () =>
        ({
          chromium: {
            executablePath: () => process.execPath,
            launch: async (options: { args?: string[]; headless?: boolean }) => {
              launched += 1;
              expect(options.headless).toBe(true);
              expect(options.args).not.toContain("--no-sandbox");
              return fakeBrowser;
            },
          },
        }) as never,
    });

    const descriptors = await runtime.browserControlPort.list({ sessionId: "session-test" });

    expect(launched).toBe(1);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      type: "cdp",
      name: "ZCode Headless Chromium",
      metadata: { headless: "true", launchMode: "managed", provider: "zcode-cli" },
    });
    expect(descriptors[0]?.id).toMatch(/^cdp:/u);
    expect(descriptors[0]?.apiSupportOverrides?.["BrowserUser.openTabs"]).toBe(false);

    await runtime.close();
    expect(closed).toBe(1);
  });

  it("requires an absolute executable path and validates executability", () => {
    expect(() => validateExplicitBrowserExecutable("relative/chromium")).toThrow(
      /must be absolute/u,
    );
    expect(() => validateExplicitBrowserExecutable("/definitely/missing/zcode-chromium")).toThrow(
      /missing or not executable/u,
    );
    expect(validateExplicitBrowserExecutable(process.execPath)).toBe(process.execPath);
    expect(() => accessSync(process.execPath, constants.X_OK)).not.toThrow();
  });

  it("uses an installed Playwright Chromium before system candidates", () => {
    const path = resolveInstalledBrowserExecutable(
      { chromium: { executablePath: () => process.execPath } as never },
      { platform: process.platform },
    );
    expect(path).toBe(process.execPath);
  });

  it("allows only http, https, and exact about:blank navigation", () => {
    expect(isAllowedManagedBrowserUrl("http://127.0.0.1:4173")).toBe(true);
    expect(isAllowedManagedBrowserUrl("https://example.com/path")).toBe(true);
    expect(isAllowedManagedBrowserUrl("about:blank")).toBe(true);
    expect(isAllowedManagedBrowserUrl("file:///tmp/secret")).toBe(false);
    expect(isAllowedManagedBrowserUrl("data:text/html,hello")).toBe(false);
    expect(isAllowedManagedBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedManagedBrowserUrl("about:config")).toBe(false);
  });

  it("isolates BrowserContexts by session and closes Chromium after the last session", async () => {
    const fake = createFakePlaywright();
    const runtime = createManagedCdpBrowserRuntime({ loadPlaywright: fake.loadPlaywright });
    const [descriptor] = await runtime.browserControlPort.list({ sessionId: "session-a" });
    expect(descriptor).toBeDefined();

    const first = await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "newTab" },
      sessionId: "session-a",
    });
    const second = await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "newTab" },
      sessionId: "session-b",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.tab?.tabId).not.toBe(second.tab?.tabId);
    expect(fake.contexts).toHaveLength(2);

    await runtime.browserControlPort.closeSession?.({ sessionId: "session-a" });
    expect(fake.contexts[0]?.closed).toBe(true);
    expect(fake.browserCloseCount()).toBe(0);
    await runtime.browserControlPort.closeSession?.({ sessionId: "session-b" });
    expect(fake.contexts[1]?.closed).toBe(true);
    expect(fake.browserCloseCount()).toBe(1);
  });

  it("single-flights concurrent first commands for the same session context", async () => {
    const fake = createFakePlaywright();
    const runtime = createManagedCdpBrowserRuntime({ loadPlaywright: fake.loadPlaywright });
    const [descriptor] = await runtime.browserControlPort.list({ sessionId: "session-a" });

    const results = await Promise.all([
      runtime.browserControlPort.execute({
        browserGeneration: descriptor!.generation,
        browserId: descriptor!.id,
        command: { method: "newTab" },
        sessionId: "session-a",
      }),
      runtime.browserControlPort.execute({
        browserGeneration: descriptor!.generation,
        browserId: descriptor!.id,
        command: { method: "newTab" },
        sessionId: "session-a",
      }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fake.contexts).toHaveLength(1);
    await runtime.close();
  });

  it("increments generation after a browser disconnect and rejects stale bindings", async () => {
    const fake = createFakePlaywright();
    const runtime = createManagedCdpBrowserRuntime({ loadPlaywright: fake.loadPlaywright });
    const [first] = await runtime.browserControlPort.list({ sessionId: "session-a" });
    fake.disconnect();

    const stale = await runtime.browserControlPort.execute({
      browserGeneration: first!.generation,
      browserId: first!.id,
      command: { method: "getState" },
      sessionId: "session-a",
    });
    const [second] = await runtime.browserControlPort.list({ sessionId: "session-a" });

    expect(stale).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    expect(second?.id).toBe(first?.id);
    expect(second?.generation).toBe((first?.generation ?? 0) + 1);
    expect(fake.launchCount()).toBe(2);
    await runtime.close();
  });

  it("cancels an in-flight turn and marks a dispatched navigation as uncertain", async () => {
    let navigationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      navigationStarted = resolve;
    });
    const fake = createFakePlaywright({
      goto: async () => {
        navigationStarted?.();
        await new Promise<void>(() => undefined);
      },
    });
    const runtime = createManagedCdpBrowserRuntime({ loadPlaywright: fake.loadPlaywright });
    const [descriptor] = await runtime.browserControlPort.list({ sessionId: "session-a" });
    await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "newTab" },
      sessionId: "session-a",
    });

    const resultPromise = runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "navigate", url: "https://example.test" },
      sessionId: "session-a",
      turnId: "turn-a",
    });
    await started;
    await runtime.browserControlPort.turnEnded?.({ sessionId: "session-a", turnId: "turn-a" });

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled", sideEffect: "uncertain" },
    });
    await runtime.close();
  });

  it("does not dispatch a command cancelled before it reaches the browser", async () => {
    let gotoCalls = 0;
    const fake = createFakePlaywright({
      goto: async () => {
        gotoCalls += 1;
      },
    });
    const runtime = createManagedCdpBrowserRuntime({ loadPlaywright: fake.loadPlaywright });
    const [descriptor] = await runtime.browserControlPort.list({ sessionId: "session-a" });
    await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "newTab" },
      sessionId: "session-a",
    });
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "navigate", url: "https://example.test" },
      sessionId: "session-a",
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(result.error?.sideEffect).toBeUndefined();
    expect(gotoCalls).toBe(0);
    await runtime.close();
  });

  it("classifies Playwright timeouts without marking an uncertain cancellation", async () => {
    const fake = createFakePlaywright({
      goto: async () => {
        throw Object.assign(new Error("navigation timed out"), { name: "TimeoutError" });
      },
    });
    const runtime = createManagedCdpBrowserRuntime({ loadPlaywright: fake.loadPlaywright });
    const [descriptor] = await runtime.browserControlPort.list({ sessionId: "session-a" });
    await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "newTab" },
      sessionId: "session-a",
    });

    const result = await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "navigate", url: "https://example.test" },
      sessionId: "session-a",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(result.error?.sideEffect).toBeUndefined();
    await runtime.close();
  });

  it("waits for and closes a browser process whose launch finishes during runtime shutdown", async () => {
    let finishLaunch: ((browser: object) => void) | undefined;
    const launch = new Promise<object>((resolve) => {
      finishLaunch = resolve;
    });
    let connected = true;
    let closeCount = 0;
    const browser = {
      close: async () => {
        connected = false;
        closeCount += 1;
      },
      isConnected: () => connected,
      on: () => undefined,
    };
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: async () =>
        ({
          chromium: {
            executablePath: () => process.execPath,
            launch: async () => await launch,
          },
        }) as never,
    });
    const listPromise = runtime.browserControlPort.list({ sessionId: "session-a" });
    const closePromise = runtime.close();
    finishLaunch?.(browser);

    await expect(listPromise).rejects.toThrow(/runtime is closed/u);
    await closePromise;
    expect(closeCount).toBe(1);
  });

  it("continues browser shutdown when a context close never settles", async () => {
    const fake = createFakePlaywright({
      contextClose: async () => await new Promise<void>(() => undefined),
    });
    const runtime = createManagedCdpBrowserRuntime({
      closeTimeoutMs: 20,
      loadPlaywright: fake.loadPlaywright,
    });
    const [descriptor] = await runtime.browserControlPort.list({ sessionId: "session-a" });
    await runtime.browserControlPort.execute({
      browserGeneration: descriptor!.generation,
      browserId: descriptor!.id,
      command: { method: "newTab" },
      sessionId: "session-a",
    });

    const startedAt = Date.now();
    await runtime.close();

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(fake.browserCloseCount()).toBe(1);
  });

  it("returns from shutdown when browser close never settles", async () => {
    const fake = createFakePlaywright({
      browserClose: async () => await new Promise<void>(() => undefined),
    });
    const runtime = createManagedCdpBrowserRuntime({
      closeTimeoutMs: 20,
      loadPlaywright: fake.loadPlaywright,
    });
    await runtime.browserControlPort.list({ sessionId: "session-a" });

    const startedAt = Date.now();
    await runtime.close();

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(fake.browserCloseCount()).toBe(1);
  });

  it("does not expose Playwright profile or CDP endpoint details from launch failures", async () => {
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: async () =>
        ({
          chromium: {
            executablePath: () => process.execPath,
            launch: async () => {
              throw new Error("failed with ws://127.0.0.1:49152 at /tmp/playwright-profile-secret");
            },
          },
        }) as never,
    });

    const error = await runtime.browserControlPort
      .list({ sessionId: "session-a" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Managed headless Chromium is unavailable/u);
    expect((error as Error).message).not.toMatch(/49152|profile-secret/u);
    await runtime.close();
  });
});

const STORAGE_STATE = {
  cookies: [
    {
      name: "sid",
      value: "first",
      domain: ".example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [{ origin: "https://app.example.com", localStorage: [{ name: "token", value: "t" }] }],
};

describe("managed CDP browser storage state injection", () => {
  let directory: string;
  let statePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-browser-inject-"));
    statePath = join(directory, "state.json");
    await writeFile(statePath, JSON.stringify(STORAGE_STATE));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates contexts without storageState when no state path is configured", async () => {
    const fake = createFakePlaywright();
    const runtime = createManagedCdpBrowserRuntime({ loadPlaywright: fake.loadPlaywright });

    expect((await openTab(runtime, "session-a")).ok).toBe(true);

    expect(fake.contextOptions[0]).toEqual({
      acceptDownloads: false,
      viewport: { width: 1280, height: 720 },
    });
    await runtime.close();
  });

  it("injects the storage state into every session context", async () => {
    const fake = createFakePlaywright();
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: fake.loadPlaywright,
      storageStatePath: statePath,
    });

    expect((await openTab(runtime, "session-a")).ok).toBe(true);
    expect((await openTab(runtime, "session-b")).ok).toBe(true);

    expect(fake.contextOptions).toHaveLength(2);
    for (const options of fake.contextOptions) {
      expect(options?.storageState).toEqual(STORAGE_STATE);
      expect(options?.acceptDownloads).toBe(false);
    }
    await runtime.close();
  });

  it("rereads the state file for each new session context", async () => {
    const fake = createFakePlaywright();
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: fake.loadPlaywright,
      storageStatePath: statePath,
    });

    await openTab(runtime, "session-a");
    const replaced = {
      ...STORAGE_STATE,
      cookies: [{ ...STORAGE_STATE.cookies[0], value: "second" }],
    };
    await writeFile(statePath, JSON.stringify(replaced));
    await openTab(runtime, "session-b");

    expect(fake.contextOptions[0]?.storageState).toEqual(STORAGE_STATE);
    expect(fake.contextOptions[1]?.storageState).toEqual(replaced);
    await runtime.close();
  });

  it("fails a session with backend_unavailable while the state file is invalid and recovers once fixed", async () => {
    const fake = createFakePlaywright();
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: fake.loadPlaywright,
      storageStatePath: statePath,
    });
    await writeFile(statePath, "{");

    const failed = await openTab(runtime, "session-c");

    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("backend_unavailable");
    expect(failed.error?.message).not.toContain(statePath);
    expect(fake.contexts).toHaveLength(0);

    await writeFile(statePath, JSON.stringify(STORAGE_STATE));
    const recovered = await openTab(runtime, "session-c");

    expect(recovered.ok).toBe(true);
    expect(fake.contexts).toHaveLength(1);
    await runtime.close();
  });
});

async function openTab(
  runtime: ReturnType<typeof createManagedCdpBrowserRuntime>,
  sessionId: string,
) {
  const [descriptor] = await runtime.browserControlPort.list({ sessionId });
  return await runtime.browserControlPort.execute({
    browserGeneration: descriptor!.generation,
    browserId: descriptor!.id,
    command: { method: "newTab" },
    sessionId,
  });
}

function createFakePlaywright(
  options: {
    browserClose?: () => Promise<void>;
    contextClose?: () => Promise<void>;
    goto?: () => Promise<void>;
  } = {},
) {
  let browserClosed = 0;
  let browserLaunches = 0;
  let connected = true;
  let disconnected: (() => void) | undefined;
  const contexts: Array<{ closed: boolean }> = [];
  const contextOptions: Array<Record<string, unknown> | undefined> = [];

  const createBrowser = () => {
    connected = true;
    const browser = {
      close: async () => {
        if (!connected) return;
        browserClosed += 1;
        await options.browserClose?.();
        connected = false;
        disconnected?.();
      },
      isConnected: () => connected,
      newContext: async (contextOption?: Record<string, unknown>) => {
        contextOptions.push(contextOption);
        const state = { closed: false };
        contexts.push(state);
        const pages: Array<ReturnType<typeof createPage>> = [];
        const context = {
          browser: () => browser,
          close: async () => {
            await options.contextClose?.();
            state.closed = true;
          },
          newPage: async () => {
            const page = createPage(context, options.goto);
            pages.push(page);
            return page;
          },
          on: () => undefined,
          pages: () => pages,
        };
        return context;
      },
      on: (event: string, listener: () => void) => {
        if (event === "disconnected") disconnected = listener;
      },
    };
    return browser;
  };

  return {
    browserCloseCount: () => browserClosed,
    contextOptions,
    contexts,
    disconnect: () => {
      connected = false;
      disconnected?.();
    },
    launchCount: () => browserLaunches,
    loadPlaywright: async () =>
      ({
        chromium: {
          executablePath: () => process.execPath,
          launch: async () => {
            browserLaunches += 1;
            return createBrowser();
          },
        },
      }) as never,
  };
}

function createPage(context: object, goto: (() => Promise<void>) | undefined) {
  let closed = false;
  let currentUrl = "about:blank";
  let viewport = { width: 1280, height: 720 };
  const closeListeners: Array<() => void> = [];
  return {
    bringToFront: async () => undefined,
    close: async () => {
      closed = true;
      for (const listener of closeListeners) listener();
    },
    context: () => context,
    goto: async (url: string) => {
      currentUrl = url;
      await goto?.();
    },
    isClosed: () => closed,
    on: (event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
    },
    setViewportSize: async (nextViewport: { width: number; height: number }) => {
      viewport = { ...nextViewport };
    },
    title: async () => "",
    url: () => currentUrl,
    viewportSize: () => ({ ...viewport }),
  };
}
