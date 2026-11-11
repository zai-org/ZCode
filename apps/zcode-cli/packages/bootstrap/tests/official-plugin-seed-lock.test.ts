import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withOfficialPluginSeedLock } from "../src/app/official-plugin-seed-lock.js";

describe("official plugin seed lock", () => {
  it("keeps the lock until asynchronous work settles without blocking the event loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-seed-async-"));
    const target = join(root, "plugin");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const work = withOfficialPluginSeedLock(target, async () => {
      entered.resolve();
      await release.promise;
      return "complete";
    });
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(existsSync(`${target}.seed-lock`)).toBe(true);
    } finally {
      release.resolve();
      expect(await work).toBe("complete");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for another process to release the same version lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-seed-lock-wait-"));
    const targetRoot = join(root, "zcode-cua", "0.5.2");
    const lockRoot = `${targetRoot}.seed-lock`;

    try {
      await mkdir(lockRoot, { recursive: true });
      const releaser = spawn(
        process.execPath,
        [
          "-e",
          'setTimeout(()=>require("node:fs").rmSync(process.argv[1],{recursive:true,force:true}),200)',
          lockRoot,
        ],
        { stdio: "pipe" },
      );
      const released = new Promise<void>((resolve, reject) => {
        releaser.once("error", reject);
        releaser.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`lock releaser exited with ${code}`)),
        );
      });

      const startedAt = Date.now();
      const result = await withOfficialPluginSeedLock(
        targetRoot,
        () => {
          expect(existsSync(lockRoot)).toBe(true);
          return "seeded";
        },
        { retryDelayMs: 25, staleLockAgeMs: 60_000, timeoutMs: 5_000 },
      );

      await released;
      expect(result).toBe("seeded");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
      expect(existsSync(lockRoot)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("takes over a stale lock left by a crashed process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-seed-lock-stale-"));
    const targetRoot = join(root, "zcode-cua", "0.5.2");
    const lockRoot = `${targetRoot}.seed-lock`;
    const staleTime = new Date(Date.now() - 60_000);

    try {
      await mkdir(lockRoot, { recursive: true });
      await utimes(lockRoot, staleTime, staleTime);

      expect(
        await withOfficialPluginSeedLock(targetRoot, () => "recovered", {
          retryDelayMs: 0,
          staleLockAgeMs: 1_000,
          timeoutMs: 1_000,
        }),
      ).toBe("recovered");
      expect(existsSync(lockRoot)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not take over an old lock while its owner process is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-seed-lock-live-owner-"));
    const targetRoot = join(root, "zcode-cua", "0.5.2");
    const lockRoot = `${targetRoot}.seed-lock`;
    const staleTime = new Date(Date.now() - 60_000);
    let actionCalled = false;

    try {
      await mkdir(lockRoot, { recursive: true });
      await writeFile(join(lockRoot, "owner.json"), JSON.stringify({ pid: process.pid }));
      await utimes(lockRoot, staleTime, staleTime);

      await expect(
        (async () =>
          await withOfficialPluginSeedLock(
            targetRoot,
            () => {
              actionCalled = true;
            },
            { retryDelayMs: 1, staleLockAgeMs: 1, timeoutMs: 20 },
          ))(),
      ).rejects.toThrow(/timed out waiting/u);
      expect(actionCalled).toBe(false);
      expect(existsSync(lockRoot)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
