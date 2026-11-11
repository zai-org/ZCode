import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as asyncFs from "node:fs/promises";
import * as pluginFiles from "../src/plugins/helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeBundledOfficialMarketplacePartition,
  writeCdnOfficialMarketplacePartition,
  updateMarketplace,
} from "../src/plugins/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
  };
});
vi.mock("../src/plugins/helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/helpers.js")>();
  return { ...actual, writePluginTextIfChanged: vi.fn(actual.writePluginTextIfChanged) };
});

describe("ZCode official marketplace partitions", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("serializes bundled and CDN publication across asynchronous writes", async () => {
    const storageRoot = await makeStorageRoot();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const actualFiles = await vi.importActual<typeof import("../src/plugins/helpers.js")>(
      "../src/plugins/helpers.js",
    );
    // 根已存在；让 admission 前的元数据步骤立即完成，以受控 Promise 决定 writer 顺序。
    vi.spyOn(asyncFs, "mkdir").mockImplementation(async (...args) =>
      args[0] === storageRoot ? undefined : actualFs.mkdir(...args),
    );
    vi.spyOn(asyncFs, "realpath").mockImplementation(async (...args) =>
      args[0] === storageRoot ? storageRoot : actualFs.realpath(...args),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cdnStarted = false;
    vi.spyOn(pluginFiles, "writePluginTextIfChanged").mockImplementation(async (path, contents) => {
      if (path.endsWith("bundled-marketplace.json")) {
        entered.resolve();
        await release.promise;
      }
      if (path.endsWith("cdn-marketplace.json")) cdnStarted = true;
      await actualFiles.writePluginTextIfChanged(path, contents);
    });
    const bundled = writeBundledOfficialMarketplacePartition({
      storageRoot,
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "bundled", version: "1" }],
      },
    });
    await entered.promise;
    const cdn = writeCdnOfficialMarketplacePartition({
      storageRoot,
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "cdn", version: "2" }],
      },
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cdnStarted).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([bundled, cdn]);
    }
    const manifest = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    );
    expect(manifest.plugins.map((plugin: { name: string }) => plugin.name)).toEqual([
      "cdn",
      "bundled",
    ]);
  });

  it("retries transient rename contention and preserves the previous file on persistent failure", async () => {
    const root = await makeStorageRoot();
    const path = join(root, "manifest.json");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await writeFile(path, "old");
    const rename = vi
      .spyOn(asyncFs, "rename")
      .mockClear()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }));
    rename.mockImplementationOnce(actual.rename);
    await pluginFiles.writePluginTextIfChanged(path, "new");
    expect(rename).toHaveBeenCalledTimes(2);
    expect(await readFile(path, "utf8")).toBe("new");
    rename.mockRejectedValue(Object.assign(new Error("busy"), { code: "EACCES" }));
    await expect(pluginFiles.writePluginTextIfChanged(path, "incomplete")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(await readFile(path, "utf8")).toBe("new");
    expect(await actual.readdir(root)).toEqual(["manifest.json"]);
  });

  async function makeStorageRoot(): Promise<string> {
    const storageRoot = await mkdtemp(join(tmpdir(), "zcode-official-marketplace-"));
    cleanups.push(storageRoot);
    return storageRoot;
  }

  it("merges bundled and CDN entries under one marketplace with CDN entries taking precedence", async () => {
    const storageRoot = await makeStorageRoot();

    await writeBundledOfficialMarketplacePartition({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [
          { name: "shared", source: "filesystem", version: "1.0.0" },
          { name: "bundled-only", source: "filesystem", version: "1.0.0" },
        ],
        version: 1,
      },
      storageRoot,
    });
    await writeCdnOfficialMarketplacePartition({
      manifest: {
        name: "zcode-plugins-official",
        featured: ["remote"],
        plugins: [
          { name: "shared", source: { source: "url", type: "zip" }, version: "9.0.0" },
          { name: "remote", source: { source: "url", type: "zip" }, version: "2.0.0" },
        ],
      },
      storageRoot,
    });

    const merged = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { featured?: string[]; name: string; plugins: Array<Record<string, unknown>> };
    expect(merged.name).toBe("zcode-plugins-official");
    expect(merged.featured).toEqual(["remote"]);
    expect(merged.plugins.map((plugin) => plugin.name)).toEqual([
      "shared",
      "remote",
      "bundled-only",
    ]);
    expect(merged.plugins[0]).toMatchObject({
      source: { source: "url", type: "zip" },
      version: "9.0.0",
    });
  });

  it("preserves the CDN partition when the application reseeds bundled plugins", async () => {
    const storageRoot = await makeStorageRoot();

    await writeCdnOfficialMarketplacePartition({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "remote", source: { source: "url", type: "zip" } }],
      },
      storageRoot,
    });
    await writeBundledOfficialMarketplacePartition({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "bundled-v2", source: "sea", version: "2.0.0" }],
        version: 1,
      },
      storageRoot,
    });

    const merged = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
        "utf8",
      ),
    ) as { plugins: Array<{ name: string }> };
    expect(merged.plugins.map((plugin) => plugin.name)).toEqual(["remote", "bundled-v2"]);
  });

  it("does not rewrite unchanged official marketplace files", async () => {
    const storageRoot = await makeStorageRoot();
    const bundledManifest = {
      name: "zcode-plugins-official",
      plugins: [{ name: "bundled", source: "filesystem", version: "1.0.0" }],
    };
    const cdnManifest = {
      name: "zcode-plugins-official",
      plugins: [{ name: "remote", source: { source: "url", type: "zip" } }],
    };
    const marketplaceRoot = join(storageRoot, "marketplaces", "zcode-plugins-official");

    await writeBundledOfficialMarketplacePartition({
      manifest: bundledManifest,
      storageRoot,
    });
    await writeCdnOfficialMarketplacePartition({
      manifest: cdnManifest,
      storageRoot,
    });
    const paths = [
      join(marketplaceRoot, "bundled-marketplace.json"),
      join(marketplaceRoot, "cdn-marketplace.json"),
      join(marketplaceRoot, "marketplace.json"),
    ];
    const firstMtimes = await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs));
    await delay(30);

    await writeBundledOfficialMarketplacePartition({
      manifest: bundledManifest,
      storageRoot,
    });
    await writeCdnOfficialMarketplacePartition({
      manifest: cdnManifest,
      storageRoot,
    });

    expect(await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs))).toEqual(
      firstMtimes,
    );
  });

  it("rejects the retired CDN marketplace id instead of creating a compatibility alias", async () => {
    const storageRoot = await makeStorageRoot();

    await expect(
      (async () =>
        await writeCdnOfficialMarketplacePartition({
          manifest: { name: "zcode-plugins", plugins: [] },
          storageRoot,
        }))(),
    ).rejects.toThrow("Official marketplace manifest must be named zcode-plugins-official");
  });

  it("refreshes the registered official source and returns the merged plugin count", async () => {
    const storageRoot = await makeStorageRoot();
    await writeBundledOfficialMarketplacePartition({
      manifest: {
        name: "zcode-plugins-official",
        plugins: [{ name: "bundled", source: "filesystem" }],
      },
      storageRoot,
    });

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "zcode-plugins-official",
          plugins: [{ name: "remote", source: { source: "url", type: "zip" } }],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address missing");
      await writeFile(
        join(storageRoot, "known_marketplaces.json"),
        JSON.stringify({
          version: 1,
          marketplaces: [
            {
              id: "zcode-plugins-official",
              source: { source: "url", url: `http://127.0.0.1:${address.port}/marketplace.json` },
              name: "zcode-plugins-official",
              addedAt: "2026-01-01T00:00:00.000Z",
              pluginCount: 1,
            },
          ],
        }),
      );

      const [updated] = await updateMarketplace({
        marketplace: "zcode-plugins-official",
        storageRoot,
      });
      expect(updated).toMatchObject({
        id: "zcode-plugins-official",
        pluginCount: 2,
      });

      const merged = JSON.parse(
        await readFile(
          join(storageRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"),
          "utf8",
        ),
      ) as { plugins: Array<{ name: string }> };
      expect(merged.plugins.map((plugin) => plugin.name)).toEqual(["remote", "bundled"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
