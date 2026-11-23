import { describe, expect, it, vi } from "vitest";

import {
  reloadElectronSessionSafely,
  waitForElectronProcessExit,
} from "./e2e/helpers/e2e-electron-reload.js";

describe("desktop e2e Electron reload", () => {
  it("runs isolated profile mutations after the old process tree exits and before reload", async () => {
    const events: string[] = [];
    let deleteSession = vi.fn(async () => {
      events.push("delete");
    });
    const browser = {
      get deleteSession() {
        return deleteSession;
      },
      overwriteCommand: vi.fn(
        (
          _name: string,
          overwrite: (
            this: typeof browser,
            original: typeof deleteSession,
            ...args: unknown[]
          ) => Promise<unknown>,
        ) => {
          const original = deleteSession;
          deleteSession = vi.fn((...args: unknown[]) => overwrite.call(browser, original, ...args));
        },
      ),
      electron: {
        execute: vi.fn(async () => 4242),
      },
      reloadSession: vi.fn(async function (this: { deleteSession: () => Promise<void> }) {
        events.push("reload-start");
        await this.deleteSession();
        events.push("reload-new-session");
        return "new-session";
      }),
    };

    await reloadElectronSessionSafely(
      browser as never,
      {
        afterElectronProcessExit: async () => {
          events.push("isolated-mutation");
        },
        collectProcessTreePids: () => [4242],
        isProcessAlive: () => false,
        reloadElectronServiceBridge: async () => {
          events.push("service-reload-probe");
        },
      } as never,
    );

    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("isolated-mutation"));
    expect(events.indexOf("isolated-mutation")).toBeLessThan(events.indexOf("reload-start"));
    expect(events.indexOf("reload-new-session")).toBeLessThan(
      events.indexOf("service-reload-probe"),
    );
  });

  it("waits for the old Electron process tree after main exits before starting a new session", async () => {
    const events: string[] = [];
    let deleteSession = vi.fn(async () => {
      events.push("delete");
    });
    const browser = {
      get deleteSession() {
        return deleteSession;
      },
      overwriteCommand: vi.fn(
        (
          _name: string,
          overwrite: (
            this: typeof browser,
            original: typeof deleteSession,
            ...args: unknown[]
          ) => Promise<unknown>,
        ) => {
          events.push("overwrite-delete");
          const original = deleteSession;
          deleteSession = vi.fn((...args: unknown[]) => overwrite.call(browser, original, ...args));
        },
      ),
      electron: {
        execute: vi.fn(async () => {
          events.push("arm-quit");
          return 4242;
        }),
      },
      reloadSession: vi.fn(async function (this: { deleteSession: () => Promise<void> }) {
        events.push("reload-start");
        await this.deleteSession();
        events.push("reload-new-session");
        return "new-session";
      }),
    };
    let childAliveChecks = 0;

    const newSessionId = await reloadElectronSessionSafely(
      browser as never,
      {
        collectProcessTreePids: () => {
          events.push("scan-tree");
          return [4243, 4242];
        },
        delay: async () => {
          events.push("delay");
        },
        isProcessAlive: (pid) => {
          if (pid === 4242) {
            events.push("main-exited");
            return false;
          }
          const alive = childAliveChecks === 0;
          childAliveChecks += 1;
          events.push(alive ? "child-alive" : "child-exited");
          return alive;
        },
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
        pollIntervalMs: 1,
        reloadElectronServiceBridge: async () => {
          events.push("service-reload-probe");
        },
        timeoutMs: 20,
      } as never,
    );
    events.push(`helper-return:${newSessionId}`);

    expect(events.indexOf("scan-tree")).toBeLessThan(events.indexOf("delete"));
    expect(events).toContain("main-exited");
    expect(events).toContain("child-alive");
    expect(events.indexOf("child-exited")).toBeLessThan(events.indexOf("reload-new-session"));
    expect(events).toContain("service-reload-probe");
    expect(events.indexOf("reload-new-session")).toBeLessThan(
      events.indexOf("service-reload-probe"),
    );
    expect(events.indexOf("service-reload-probe")).toBeLessThan(
      events.indexOf("helper-return:new-session"),
    );
  });

  it("cleans up timed-out descendants before the reload creates a new session", async () => {
    const events: string[] = [];
    let childAlive = true;
    let now = 0;
    let deleteSession = vi.fn(async () => {
      events.push("delete");
    });
    const browser = {
      get deleteSession() {
        return deleteSession;
      },
      overwriteCommand: vi.fn(
        (
          _name: string,
          overwrite: (
            this: typeof browser,
            original: typeof deleteSession,
            ...args: unknown[]
          ) => Promise<unknown>,
        ) => {
          const original = deleteSession;
          deleteSession = vi.fn((...args: unknown[]) => overwrite.call(browser, original, ...args));
        },
      ),
      electron: {
        execute: vi.fn(async () => 4242),
      },
      reloadSession: vi.fn(async function (this: { deleteSession: () => Promise<void> }) {
        await this.deleteSession();
        events.push("reload-new-session");
        return "new-session";
      }),
    };
    const cleanupTimedOutProcessTreePids = vi.fn(async (pids: number[]) => {
      events.push(`cleanup:${pids.join(",")}`);
      childAlive = false;
    });

    await reloadElectronSessionSafely(
      browser as never,
      {
        cleanupTimedOutProcessTreePids,
        collectProcessTreePids: () => [4243, 4242],
        delay: async (ms: number) => {
          now += ms;
        },
        isProcessAlive: (pid: number) => pid === 4243 && childAlive,
        now: () => now,
        pollIntervalMs: 5,
        reloadElectronServiceBridge: async () => {
          events.push("service-reload-probe");
        },
        timeoutMs: 10,
      } as never,
    );

    expect(cleanupTimedOutProcessTreePids).toHaveBeenCalledWith([4243]);
    expect(events).toEqual([
      "delete",
      "cleanup:4243",
      "delete",
      "reload-new-session",
      "service-reload-probe",
    ]);
  });

  it("reports every remaining old Electron process when cleanup cannot finish", async () => {
    let now = 0;

    await expect(
      waitForElectronProcessExit(
        [4243, 4242] as never,
        {
          cleanupTimedOutProcessTreePids: async () => undefined,
          collectProcessTreePids: () => [4243, 4242],
          delay: async (ms) => {
            now += ms;
          },
          isProcessAlive: () => true,
          now: () => now,
          forceKillGraceMs: 0,
          pollIntervalMs: 5,
          timeoutMs: 10,
        } as never,
      ),
    ).rejects.toThrow("pids=4243,4242");
  });

  it("does not create a new session when the old process tree remains alive", async () => {
    let now = 0;
    const originalError = new Error("Electron reload 旧进程树退出超时: pids=4243,4242");
    let deleteSession = vi.fn(async () => undefined);
    const createNewSession = vi.fn(async () => "new-session");
    const browser = {
      get deleteSession() {
        return deleteSession;
      },
      overwriteCommand: vi.fn(
        (
          _name: string,
          overwrite: (
            this: typeof browser,
            original: typeof deleteSession,
            ...args: unknown[]
          ) => Promise<unknown>,
        ) => {
          const original = deleteSession;
          deleteSession = vi.fn((...args: unknown[]) => overwrite.call(browser, original, ...args));
        },
      ),
      electron: {
        execute: vi.fn(async () => 4242),
      },
      // WebdriverIO 会吞掉内部 deleteSession 异常；这里保留真实行为，确保测试锁定的
      // 是 protocol reload 没有被触发，而不只是 helper 最终向外抛错。
      reloadSession: vi.fn(async function (this: { deleteSession: () => Promise<void> }) {
        await this.deleteSession().catch(() => undefined);
        return createNewSession();
      }),
    };

    const failure = await reloadElectronSessionSafely(
      browser as never,
      {
        cleanupTimedOutProcessTreePids: async () => {
          throw originalError;
        },
        collectProcessTreePids: () => [4243, 4242],
        delay: async (ms: number) => {
          now += ms;
        },
        forceKillGraceMs: 0,
        isProcessAlive: () => true,
        now: () => now,
        pollIntervalMs: 5,
        timeoutMs: 10,
      } as never,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "旧进程退出屏障失败: Electron reload 旧进程树退出超时: pids=4243,4242",
    );
    expect((failure as Error).cause).toBe(originalError);
    expect(createNewSession).not.toHaveBeenCalled();
  });
});
