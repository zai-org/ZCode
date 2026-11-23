import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  directorySignature,
  ensureSharedSnapshot,
  fileSignature,
  stageE2EAppOutputWithSharedRenderer,
} from "./e2e/helpers/e2e-shared-stage-cache.js";

const testDirs: string[] = [];

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function root() {
  const dir = await mkdtemp(resolve("packages/desktop", ".e2e-shared-stage-test-"));
  testDirs.push(dir);
  return dir;
}

async function fakeOut(dir: string) {
  await mkdir(join(dir, "main"), { recursive: true });
  await mkdir(join(dir, "renderer", "assets"), { recursive: true });
  await writeFile(join(dir, "main", "index.js"), "main");
  await writeFile(join(dir, "renderer", "index.html"), "<html></html>");
  await writeFile(join(dir, "renderer", "assets", "app.js"), "renderer");
  await writeFile(join(dir, "metadata.json"), "{}");
}

describe("复用构建时的共享只读快照", () => {
  it("目录签名随文件内容（大小、修改时间）和增删变化，内容不变时稳定", async () => {
    const dir = join(await root(), "out");
    await fakeOut(dir);
    const first = directorySignature(dir);
    expect(directorySignature(dir)).toBe(first);
    await writeFile(join(dir, "renderer", "assets", "app.js"), "renderer-v2");
    const second = directorySignature(dir);
    expect(second).not.toBe(first);
    await writeFile(join(dir, "renderer", "assets", "extra.js"), "x");
    expect(directorySignature(dir)).not.toBe(second);
  });

  it("文件签名随修改时间变化；文件不存在时返回 null", async () => {
    const dir = await root();
    const file = join(dir, "zcode.cjs");
    expect(fileSignature(file)).toBeNull();
    await writeFile(file, "cli");
    const first = fileSignature(file);
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(fileSignature(file)).not.toBe(first);
  });

  it("快照只建一次，之后直接复用；并发同时建也只留一份", async () => {
    const cacheRoot = join(await root(), "shared");
    let builds = 0;
    const build = async (dir: string) => {
      builds += 1;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "a.txt"), "x");
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => ensureSharedSnapshot({ cacheRoot, key: "k1", build })),
    );
    expect(new Set(results).size).toBe(1);
    expect(await readFile(join(results[0]!, "a.txt"), "utf8")).toBe("x");
    const before = builds;
    await ensureSharedSnapshot({ cacheRoot, key: "k1", build });
    expect(builds).toBe(before);
    expect((await readdir(cacheRoot)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("建到一半被打断（没有完成标记）的残留不会被当成可用快照", async () => {
    const cacheRoot = join(await root(), "shared");
    await mkdir(join(cacheRoot, "k1"), { recursive: true });
    await writeFile(join(cacheRoot, "k1", "half.txt"), "broken");
    const dir = await ensureSharedSnapshot({
      cacheRoot,
      key: "k1",
      build: async (d) => {
        await mkdir(d, { recursive: true });
        await writeFile(join(d, "a.txt"), "ok");
      },
    });
    expect(existsSync(join(dir, "half.txt"))).toBe(false);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("ok");
  });

  it("只保留最近几份快照", async () => {
    const cacheRoot = join(await root(), "shared");
    const build = async (d: string) => mkdir(d, { recursive: true }).then(() => undefined);
    for (const key of ["k1", "k2", "k3", "k4"]) {
      await ensureSharedSnapshot({ cacheRoot, key, build, keep: 2 });
      await new Promise((r) => setTimeout(r, 15));
    }
    expect((await readdir(cacheRoot)).sort()).toEqual(["k3", "k4"]);
  });

  it("renderer 链到共享快照：内容可读、往 main 写文件不碰共享快照、删除运行目录不删共享快照", async () => {
    const base = await root();
    const out = join(base, "out");
    await fakeOut(out);
    const cacheRoot = join(base, "shared", "renderer");
    const run1 = join(base, "run1", "app");
    const run2 = join(base, "run2", "app");
    const first = await stageE2EAppOutputWithSharedRenderer({
      sourceDir: out,
      destinationDir: run1,
      cacheRoot,
      linkType: "dir",
    });
    const second = await stageE2EAppOutputWithSharedRenderer({
      sourceDir: out,
      destinationDir: run2,
      cacheRoot,
      linkType: "dir",
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.renderer).toBe(first.renderer);
    expect(await readFile(join(run2, "renderer", "assets", "app.js"), "utf8")).toBe("renderer");
    expect(await readFile(join(run2, "metadata.json"), "utf8")).toBe("{}");

    // 用例往 main 里写启动文件（如 subagent-e2e.mjs）：每个运行目录各自一份
    await writeFile(join(run1, "main", "subagent-e2e.mjs"), "run1-only");
    expect(existsSync(join(run2, "main", "subagent-e2e.mjs"))).toBe(false);
    expect(existsSync(join(out, "main", "subagent-e2e.mjs"))).toBe(false);

    await rm(join(base, "run1"), { force: true, recursive: true });
    expect(await readFile(join(first.renderer, "assets", "app.js"), "utf8")).toBe("renderer");
    expect(await readFile(join(run2, "renderer", "index.html"), "utf8")).toBe("<html></html>");

    // 产物变了：另建一份快照，旧运行不受影响
    await writeFile(join(out, "renderer", "assets", "app.js"), "renderer-v2");
    const third = await stageE2EAppOutputWithSharedRenderer({
      sourceDir: out,
      destinationDir: join(base, "run3", "app"),
      cacheRoot,
      linkType: "dir",
    });
    expect(third.renderer).not.toBe(first.renderer);
    expect(await readFile(join(run2, "renderer", "assets", "app.js"), "utf8")).toBe("renderer");
  });
});
