import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  E2E_DESKTOP_REQUIRED_OUTPUT_PATHS,
  E2E_DESKTOP_BUILD_ENV_NAMES,
  createE2EDesktopBuildFingerprint,
  ensureE2EDesktopBuild,
  isE2EDesktopBuildCacheHit,
  resolveE2EDesktopBuildInputPaths,
  withE2EDesktopBuildLock,
  writeE2EDesktopBuildStampAtomic,
} from "../scripts/ensure-e2e-desktop-build.mjs";

const ROOT = resolve(tmpdir(), `zcode-e2e-build-cache-${process.pid}`);

afterEach(() => {
  rmSync(ROOT, { force: true, recursive: true });
});

describe("desktop E2E build cache", () => {
  it("invalidates when source or git HEAD changes", () => {
    mkdirSync(resolve(ROOT, "src"), { recursive: true });
    writeFileSync(resolve(ROOT, "src/main.ts"), "export const value = 1;\n");
    const base = createE2EDesktopBuildFingerprint({
      env: { VITE_ZCODE_E2E_STORE_BRIDGE: "1", ZCODE_ENV: "test" },
      gitHead: "head-a",
      inputPaths: ["src"],
      repoRoot: ROOT,
    });

    writeFileSync(resolve(ROOT, "src/main.ts"), "export const value = 2;\n");
    expect(
      createE2EDesktopBuildFingerprint({
        env: { VITE_ZCODE_E2E_STORE_BRIDGE: "1", ZCODE_ENV: "test" },
        gitHead: "head-a",
        inputPaths: ["src"],
        repoRoot: ROOT,
      }),
    ).not.toBe(base);
    expect(
      createE2EDesktopBuildFingerprint({
        env: { VITE_ZCODE_E2E_STORE_BRIDGE: "1", ZCODE_ENV: "test" },
        gitHead: "head-b",
        inputPaths: ["src"],
        repoRoot: ROOT,
      }),
    ).not.toBe(base);
  });

  it("invalidates for every declared bundle environment variable", () => {
    mkdirSync(resolve(ROOT, "src"), { recursive: true });
    writeFileSync(resolve(ROOT, "src/main.ts"), "export const value = 1;\n");
    const base = createE2EDesktopBuildFingerprint({
      env: {},
      gitHead: "head-a",
      inputPaths: ["src"],
      repoRoot: ROOT,
    });

    for (const envName of E2E_DESKTOP_BUILD_ENV_NAMES) {
      expect(
        createE2EDesktopBuildFingerprint({
          env: { [envName]: envName === "ZCODE_E2E_COVERAGE" ? "1" : "changed" },
          gitHead: "head-a",
          inputPaths: ["src"],
          repoRoot: ROOT,
        }),
        `${envName} must invalidate the desktop bundle cache`,
      ).not.toBe(base);
    }
    expect(
      createE2EDesktopBuildFingerprint({
        env: { ZCODE_ENV: "" },
        gitHead: "head-a",
        inputPaths: ["src"],
        repoRoot: ROOT,
      }),
    ).not.toBe(base);
  });

  it("declares every environment variable read by the production build configs", () => {
    const configPaths = [
      "packages/desktop/scripts/build-metadata.mjs",
      "packages/desktop/scripts/run-production-build.mjs",
      "packages/desktop/tsup.config.ts",
      "packages/desktop/vite.config.ts",
    ];
    const referencedEnvNames = new Set<string>();
    for (const configPath of configPaths) {
      const source = readFileSync(resolve(process.cwd(), configPath), "utf8");
      for (const match of source.matchAll(
        /\b(?:process\.env|env|runtimeEnv)\.([A-Z][A-Z0-9_]*)/gu,
      )) {
        // Vite 配置同时包含 serve/build；Scan 仅用于 serve，不应让生产构建缓存失效。
        // 只排除此文件的开发开关，build 分支不装配 Scan 由 viteRendererConfig.test.ts 验证。
        if (configPath === "packages/desktop/vite.config.ts" && match[1] === "ZCODE_REACT_SCAN") {
          continue;
        }
        referencedEnvNames.add(match[1]);
      }
    }

    expect(E2E_DESKTOP_BUILD_ENV_NAMES).toEqual(
      expect.arrayContaining([...referencedEnvNames].sort()),
    );
  });

  it("keeps the bundle fingerprint unchanged when the development Scan switch changes", () => {
    const fingerprint = (env: Record<string, string>) =>
      createE2EDesktopBuildFingerprint({
        env,
        gitHead: "head-a",
        inputPaths: [],
        repoRoot: ROOT,
      });
    const base = fingerprint({});

    for (const value of ["", "0", "1"]) {
      expect(fingerprint({ ZCODE_REACT_SCAN: value })).toBe(base);
    }
  });

  it("invalidates when a workspace dependency or production env file changes", () => {
    mkdirSync(resolve(ROOT, "packages/desktop/src"), { recursive: true });
    mkdirSync(resolve(ROOT, "packages/server/src"), { recursive: true });
    writeFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(resolve(ROOT, "package.json"), JSON.stringify({ name: "fixture" }));
    writeFileSync(resolve(ROOT, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(
      resolve(ROOT, "packages/desktop/package.json"),
      JSON.stringify({
        dependencies: { "@zcode/server": "workspace:*" },
        name: "@zcode/desktop",
      }),
    );
    writeFileSync(
      resolve(ROOT, "packages/server/package.json"),
      JSON.stringify({ name: "@zcode/server" }),
    );
    writeFileSync(resolve(ROOT, "packages/desktop/src/main.ts"), "export const desktop = 1;\n");
    writeFileSync(resolve(ROOT, "packages/server/src/index.ts"), "export const server = 1;\n");
    writeFileSync(resolve(ROOT, ".env"), "ZCODE_BASE_URL=https://one.example\n");
    writeFileSync(resolve(ROOT, ".env.production"), "CDN_DOMAIN=one.example\n");

    const inputPaths = resolveE2EDesktopBuildInputPaths({ repoRoot: ROOT });
    expect(inputPaths).toContain("packages/server/package.json");
    expect(inputPaths).toContain("packages/server/src");
    const fingerprint = () =>
      createE2EDesktopBuildFingerprint({ env: {}, gitHead: "head-a", repoRoot: ROOT });
    const base = fingerprint();

    writeFileSync(resolve(ROOT, "packages/server/src/index.ts"), "export const server = 2;\n");
    expect(fingerprint()).not.toBe(base);

    writeFileSync(resolve(ROOT, "packages/server/src/index.ts"), "export const server = 1;\n");
    writeFileSync(resolve(ROOT, ".env"), "ZCODE_BASE_URL=https://two.example\n");
    expect(fingerprint()).not.toBe(base);

    writeFileSync(resolve(ROOT, ".env"), "ZCODE_BASE_URL=https://one.example\n");
    writeFileSync(resolve(ROOT, ".env.production"), "CDN_DOMAIN=two.example\n");
    expect(fingerprint()).not.toBe(base);
  });

  it("requires both a matching stamp and every output", () => {
    const stampPath = resolve(ROOT, "cache/stamp.json");
    const output = resolve(ROOT, "out/main.js");
    mkdirSync(resolve(ROOT, "cache"), { recursive: true });
    mkdirSync(resolve(ROOT, "out"), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({ fingerprint: "same" }));
    writeFileSync(output, "built");

    expect(isE2EDesktopBuildCacheHit({ fingerprint: "same", outputs: [output], stampPath })).toBe(
      true,
    );
    expect(isE2EDesktopBuildCacheHit({ fingerprint: "other", outputs: [output], stampPath })).toBe(
      false,
    );
    writeFileSync(output, "");
    expect(isE2EDesktopBuildCacheHit({ fingerprint: "same", outputs: [output], stampPath })).toBe(
      false,
    );
    expect(
      isE2EDesktopBuildCacheHit({
        fingerprint: "same",
        outputs: [resolve(ROOT, "out/missing.js")],
        stampPath,
      }),
    ).toBe(false);
  });

  it("requires every desktop runtime entry before committing the cache", () => {
    expect(E2E_DESKTOP_REQUIRED_OUTPUT_PATHS).toEqual([
      "out/main/index.js",
      "out/host/index.js",
      "out/scheduler/index.js",
      "out/extension-host/index.js",
      "out/preload/index.cjs",
      "out/preload/resourceManager.cjs",
      "out/renderer/index.html",
      "out/renderer/resource-manager.html",
    ]);
  });

  it("atomically replaces an existing stamp without leaving a temporary file", () => {
    const stampPath = resolve(ROOT, "cache/desktop-build-stamp.json");
    mkdirSync(resolve(ROOT, "cache"), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({ fingerprint: "old" }));

    writeE2EDesktopBuildStampAtomic({ fingerprint: "new", stampPath });

    expect(JSON.parse(readFileSync(stampPath, "utf8"))).toMatchObject({ fingerprint: "new" });
    expect(readdirSync(resolve(ROOT, "cache")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("serializes concurrent runners and rechecks the cache after locking", async () => {
    mkdirSync(resolve(ROOT, "src"), { recursive: true });
    writeFileSync(resolve(ROOT, "src/main.ts"), "export const value = 1;\n");

    const workerOutputs = await Promise.all([runBuildCacheWorker(), runBuildCacheWorker()]);
    const buildPids = readFileSync(resolve(ROOT, "builds.log"), "utf8").trim().split(/\r?\n/u);
    expect(buildPids).toHaveLength(1);
    expect(workerOutputs.join("\n")).toContain("[e2e-build-cache] miss");
    expect(workerOutputs.join("\n")).toContain("[e2e-build-cache] hit");
    for (const outputPath of E2E_DESKTOP_REQUIRED_OUTPUT_PATHS) {
      expect(existsSync(resolve(ROOT, outputPath)), outputPath).toBe(true);
    }
    expect(existsSync(resolve(ROOT, "cache/desktop-build.lock"))).toBe(false);
    expect(readdirSync(resolve(ROOT, "cache")).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(
      JSON.parse(readFileSync(resolve(ROOT, "cache/desktop-build-stamp.json"), "utf8")),
    ).toMatchObject({ fingerprint: expect.any(String) });
  });

  it("does not commit a stamp when required outputs are incomplete", () => {
    mkdirSync(resolve(ROOT, "src"), { recursive: true });
    writeFileSync(resolve(ROOT, "src/main.ts"), "export const value = 1;\n");
    const outputs = E2E_DESKTOP_REQUIRED_OUTPUT_PATHS.map((path) => resolve(ROOT, path));
    const stampPath = resolve(ROOT, "cache/desktop-build-stamp.json");
    const lockPath = resolve(ROOT, "cache/desktop-build.lock");
    mkdirSync(resolve(ROOT, "cache"), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({ fingerprint: "stale" }));

    expect(() =>
      ensureE2EDesktopBuild({
        buildDesktop() {
          mkdirSync(resolve(ROOT, "out/main"), { recursive: true });
          writeFileSync(resolve(ROOT, "out/main/index.js"), "partial\n");
        },
        env: {},
        fingerprintOptions: { gitHead: "head-a", inputPaths: ["src"], repoRoot: ROOT },
        lockPath,
        outputs,
        stampPath,
      }),
    ).toThrow("missing required outputs");
    expect(existsSync(stampPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a lock whose owner process has exited", () => {
    const lockPath = resolve(ROOT, "cache/desktop-build.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      resolve(lockPath, "owner.json"),
      JSON.stringify({ acquiredAt: new Date(0).toISOString(), pid: 2_147_483_647, token: "dead" }),
    );

    let entered = false;
    withE2EDesktopBuildLock({ lockPath, retryDelayMs: 1, timeoutMs: 1_000 }, () => {
      entered = true;
    });
    expect(entered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([false, true])(
    "holds the build lock through asynchronous staging (failure=%s)",
    async (fail) => {
      const lockPath = resolve(ROOT, "cache/desktop-build.lock");
      let finish!: () => void;
      const staged = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const result = withE2EDesktopBuildLock({ lockPath }, async () => {
        await staged;
        if (fail) throw new Error("staging failed");
        return "staged";
      });
      expect(existsSync(lockPath)).toBe(true);
      finish();
      if (fail) await expect(result).rejects.toThrow("staging failed");
      else await expect(result).resolves.toBe("staged");
      expect(existsSync(lockPath)).toBe(false);
    },
  );
});

function runBuildCacheWorker() {
  const workerPath = resolve(
    process.cwd(),
    "packages/desktop/test/fixtures/e2e-desktop-build-cache-worker.mjs",
  );
  return new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [workerPath, ROOT], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun(stdout);
        return;
      }
      rejectRun(new Error(`build cache worker failed (${signal ?? code}): ${stderr}`));
    });
  });
}
