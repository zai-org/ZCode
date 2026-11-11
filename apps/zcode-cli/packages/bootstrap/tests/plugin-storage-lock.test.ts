import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPluginStorageLock } from "../src/lib/plugin-storage-lock.js";

describe("withPluginStorageLock", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-storage-lock-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes same-root writes and checks cancellation after admission", async () => {
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const cancelledWrite = vi.fn(async () => {});
    const order: string[] = [];
    const first = withPluginStorageLock(root, async () => {
      order.push("first");
      await release.promise;
      order.push("commit");
    });
    const cancelled = withPluginStorageLock(root, cancelledWrite, undefined, controller.signal);
    const second = withPluginStorageLock(root, async () => {
      order.push("second");
    });
    controller.abort(new Error("cancelled"));
    release.resolve();
    await expect(cancelled).rejects.toThrow("cancelled");
    await Promise.all([first, second]);
    expect(cancelledWrite).not.toHaveBeenCalled();
    expect(order).toEqual(["first", "commit", "second"]);
  });

  it("runs different roots independently, releases failed writes and rejects expired owners", async () => {
    await withPluginStorageLock(root, async (owner) => {
      await expect(withPluginStorageLock(root, async () => "joined", owner)).resolves.toBe(
        "joined",
      );
      await expect(
        withPluginStorageLock(join(root, "other"), async () => true, owner),
      ).rejects.toThrow();
      await expect(
        withPluginStorageLock(join(root, "other"), async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      return owner;
    }).then(async (expired) => {
      await expect(withPluginStorageLock(root, async () => true, expired)).rejects.toThrow();
    });
    await expect(withPluginStorageLock(root, async () => "ok")).resolves.toBe("ok");
  });

  it("reclaims the lock when a child process dies in a transaction", async () => {
    const worker = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const { withPluginStorageLock } = await import(process.argv[1]);
      await withPluginStorageLock(process.argv[2], async () => {
        process.stdout.write("locked\\n");
        await new Promise(() => setInterval(() => {}, 1000));
      });`,
        new URL("../src/lib/plugin-storage-lock.ts", import.meta.url).href,
        root,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exit = once(worker, "exit");
    try {
      await Promise.race([
        once(worker.stdout, "data"),
        exit.then(([code]) => {
          throw new Error(`lock child exited ${code}`);
        }),
      ]);
    } finally {
      worker.kill("SIGKILL");
      await exit;
    }
    await expect(withPluginStorageLock(root, async () => "recovered")).resolves.toBe("recovered");
  }, 15_000);
});
