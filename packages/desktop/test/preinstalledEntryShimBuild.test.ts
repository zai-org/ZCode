import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
const shimName = "zcode-preinstalled-entry-shim.exe";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  await mkdir(join(repoRoot, "packages/desktop/.e2e-artifacts"), { recursive: true });
  const root = await mkdtemp(join(repoRoot, "packages/desktop/.e2e-artifacts/shim-build-"));
  directories.push(root);
  const source = join(root, "packages/desktop/native/windows-preinstalled-entry-shim");
  const script = join(root, "packages/desktop/scripts/build-windows-preinstalled-entry-shim.mjs");
  for (const path of [
    "packages/desktop/scripts/build-windows-preinstalled-entry-shim.mjs",
    "packages/desktop/scripts/ensure-e2e-desktop-build.mjs",
    "packages/desktop/scripts/e2e-step-process.mjs",
    "scripts/spawn-command.mjs",
  ]) {
    const target = join(root, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(join(repoRoot, path), target);
  }
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "shim.c"), "fixture-v1");
  await writeFile(join(source, "CMakeLists.txt"), "fixture-cmake");
  const preload = join(root, "platform.cjs");
  // 只替换平台检测；构建脚本、跨进程锁、文件发布和编译子进程都走真实实现。
  await writeFile(
    preload,
    `require("node:os").platform = () => "win32"; require("node:module").syncBuiltinESMExports();`,
  );
  const compiler = join(root, "fake-cmake.mjs");
  await writeFile(
    compiler,
    `#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const building = args.includes("--build");
await appendFile(process.env.SHIM_BUILD_EVENTS, building ? "build\\n" : "configure\\n");
if (!building) {
  await mkdir(value("-B"), { recursive: true });
  await writeFile(join(value("-B"), "fixture.json"), JSON.stringify({
    source: value("-S"), arch: value("-A"),
    output: args.find((arg) => arg.startsWith("-DZCODE_SHIM_OUTPUT_DIR=")).split("=").slice(1).join("=")
  }));
} else {
  if (process.env.SHIM_BUILD_HANG === "1") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    await writeFile(process.env.SHIM_BUILD_CHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (process.env.SHIM_BUILD_FAIL === "1") process.exit(7);
  const config = JSON.parse(await readFile(join(value("--build"), "fixture.json"), "utf8"));
  const bytes = Buffer.alloc(4096);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.write("PE\\0\\0", 64);
  bytes.writeUInt16LE(config.arch === "ARM64" ? 0xaa64 : 0x8664, 68);
  createHash("sha256").update(await readFile(join(config.source, "shim.c"))).digest().copy(bytes, 128);
  await mkdir(config.output, { recursive: true });
  await writeFile(join(config.output, "${shimName}"), bytes);
}
`,
  );
  await chmod(compiler, 0o755);
  let command = compiler;
  if (process.platform === "win32") {
    command = join(root, "fake-cmake.cmd");
    await writeFile(command, `@"${process.execPath}" "${compiler}" %*\r\n`);
  }
  const events = join(root, "events.log");
  const childPid = join(root, "child.pid");
  const output = join(root, "packages/desktop/bundled-tools/win32-x64/preinstalled-entry-shim");
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    exec(process.execPath, ["--require", preload, script, ...args], {
      timeout: 10000,
      env: {
        ...process.env,
        CMAKE: command,
        ZCODE_TARGET_ARCH: "x64",
        SHIM_BUILD_EVENTS: events,
        SHIM_BUILD_CHILD_PID: childPid,
        ...env,
      },
    });
  const counts = async () =>
    (await readFile(events, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { root, source, output, run, counts, childPid };
}

describe("preinstalled entry shim build lifecycle", () => {
  it("reuses matching source, architecture and binary without invoking CMake", async () => {
    const f = await fixture();
    await f.run(["--ensure"]);
    const before = await readFile(join(f.output, shimName));
    await f.run(["--ensure"]);
    expect(await f.counts()).toEqual(["configure", "build"]);
    expect(await readFile(join(f.output, shimName))).toEqual(before);
    await writeFile(join(f.output, shimName), "broken");
    await expect(f.run(["--check"])).rejects.toThrow();
    await f.run(["--ensure"]);
    expect(await f.counts()).toHaveLength(4);
  });

  it("serializes concurrent prepares and leaves each staged copy unchanged after a rebuild", async () => {
    const f = await fixture();
    const first = join(f.root, "run-a");
    const second = join(f.root, "run-b");
    await Promise.all([
      f.run(["--ensure", "--stage-dir", first]),
      f.run(["--ensure", "--stage-dir", second]),
    ]);
    expect(await f.counts()).toEqual(["configure", "build"]);
    const original = await readFile(join(first, shimName));
    expect(await readFile(join(second, shimName))).toEqual(original);
    await writeFile(join(f.source, "shim.c"), "fixture-v2");
    await expect(f.run(["--check"])).rejects.toThrow();
    await f.run(["--ensure"]);
    expect(await readFile(join(f.output, shimName))).not.toEqual(original);
    expect(await readFile(join(first, shimName))).toEqual(original);
    expect(await readFile(join(second, shimName))).toEqual(original);
  });

  it("check-only refuses a missing cache instead of compiling", async () => {
    const f = await fixture();
    await expect(f.run(["--check"])).rejects.toThrow();
    expect(await f.counts()).toEqual([]);
  });

  it("prepares once in the parent and lets concurrent check-only children stage private files", async () => {
    const f = await fixture();
    const parent = await f.run(["--ensure"]);
    expect(parent.stdout).toContain("[preinstalled-entry-shim] built");
    const children = await Promise.all(
      ["shard-a", "shard-b"].map((name) => f.run(["--check", "--stage-dir", join(f.root, name)])),
    );
    expect(
      children.every((child) => !child.stdout.includes("[preinstalled-entry-shim] built")),
    ).toBe(true);
    expect(await f.counts()).toEqual(["configure", "build"]);
    expect(await readFile(join(f.root, "shard-a", shimName))).toEqual(
      await readFile(join(f.root, "shard-b", shimName)),
    );
    await writeFile(join(f.source, "shim.c"), "source-changed-after-parent");
    await expect(f.run(["--check"])).rejects.toThrow();
    expect(await f.counts()).toEqual(["configure", "build"]);
  });

  it("rejects a manifest for another architecture without changing the cache", async () => {
    const f = await fixture();
    await f.run(["--ensure"]);
    const path = join(f.output, "build.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...manifest, arch: "arm64" }));
    await expect(f.run(["--check"])).rejects.toThrow();
    expect(await f.counts()).toEqual(["configure", "build"]);
    await f.run(["--ensure"]);
    expect(JSON.parse(await readFile(path, "utf8")).arch).toBe("x64");
  });

  it("kills a timed-out compiler tree, keeps the previous cache and releases the lock", async () => {
    const f = await fixture();
    await f.run(["--ensure"]);
    const previous = await readFile(join(f.output, shimName));
    const manifest = await readFile(join(f.output, "build.json"));
    await expect(f.run(["--timeout-ms", "800"], { SHIM_BUILD_HANG: "1" })).rejects.toThrow(
      /timed out/,
    );
    const pid = Number(await readFile(f.childPid, "utf8"));
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(await readFile(join(f.output, shimName))).toEqual(previous);
    expect(await readFile(join(f.output, "build.json"))).toEqual(manifest);
    await f.run(["--check"]);
  }, 15000);

  it("does not publish or change the previous manifest after a compiler failure", async () => {
    const f = await fixture();
    await f.run(["--ensure"]);
    const previous = await readFile(join(f.output, shimName));
    const manifest = await readFile(join(f.output, "build.json"));
    await expect(f.run([], { SHIM_BUILD_FAIL: "1" })).rejects.toThrow();
    expect(await readFile(join(f.output, shimName))).toEqual(previous);
    expect(await readFile(join(f.output, "build.json"))).toEqual(manifest);
  });
});
