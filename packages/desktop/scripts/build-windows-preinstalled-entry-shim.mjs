#!/usr/bin/env node
// Windows 入口 shim 的构建、校验和隔离副本；规格见 docs/preinstalled-tools/windows-entry-shim.md。
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { withE2EDesktopBuildLock } from "./ensure-e2e-desktop-build.mjs";
import { spawnCancellableStep } from "./e2e-step-process.mjs";

const exec = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, "..");
const sourceRoot = join(desktopRoot, "native/windows-preinstalled-entry-shim");
const outputName = "zcode-preinstalled-entry-shim.exe";
const BUILD_TIMEOUT_MS = 5 * 60_000;
export const PREINSTALLED_ENTRY_SHIM_PROCESS_TIMEOUT_MS = 6 * 60_000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function argument(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) {
    if (!args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(`Missing ${name} value`);
    return args[index + 1];
  }
  return args.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function sourceDigest() {
  const hash = createHash("sha256");
  for (const path of [
    join(sourceRoot, "CMakeLists.txt"),
    join(sourceRoot, "shim.c"),
    import.meta.filename,
  ]) {
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

function verifyPe(bytes, targetArch) {
  const header = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  if (
    bytes.toString("ascii", 0, 2) !== "MZ" ||
    header < 0 ||
    header + 6 > bytes.length ||
    bytes.toString("ascii", header, header + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(header + 4) !== (targetArch === "arm64" ? 0xaa64 : 0x8664)
  )
    throw new Error(`Invalid Windows entry shim PE for ${targetArch}`);
}

async function readyBuild(outputDir, targetArch, source) {
  try {
    const bytes = await readFile(join(outputDir, outputName));
    verifyPe(bytes, targetArch);
    const manifest = JSON.parse(await readFile(join(outputDir, "build.json"), "utf8"));
    return manifest.version === 1 &&
      manifest.arch === targetArch &&
      manifest.source === source &&
      manifest.binary === digest(bytes)
      ? { bytes, manifest }
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function remaining(deadline) {
  const duration = deadline - Date.now();
  if (duration <= 0) throw new Error("Windows entry shim preparation timed out");
  return duration;
}

/** 只装 Build Tools 时按 vswhere 查找 CMake；查询也属于同一个准备预算。 */
async function resolveCmake(deadline) {
  if (process.env.CMAKE?.trim()) return process.env.CMAKE.trim();
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
  try {
    const { stdout } = await exec(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.CMake.Project",
        "-find",
        "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe",
      ],
      { timeout: remaining(deadline), killSignal: "SIGKILL", encoding: "utf8", windowsHide: true },
    );
    return stdout.split(/\r?\n/).find(Boolean)?.trim() || "cmake";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "cmake";
  }
}

async function runCmake(command, args, deadline) {
  const { result } = spawnCancellableStep({
    command,
    args,
    env: process.env,
    timeoutMs: remaining(deadline),
    killProcessTree: true,
    killSignal: "SIGKILL",
  });
  const outcome = await result;
  if (outcome.error || outcome.exitCode !== 0)
    throw new Error(outcome.error || `Windows entry shim CMake failed: ${outcome.exitCode}`);
}

async function build(outputDir, targetArch, source, deadline) {
  const command = await resolveCmake(deadline);
  const work = await mkdtemp(join(tmpdir(), "zcode-preinstalled-entry-shim-"));
  try {
    const buildDir = join(work, "build");
    const builtDir = join(work, "out");
    await runCmake(
      command,
      [
        "-S",
        sourceRoot,
        "-B",
        buildDir,
        "-G",
        "Visual Studio 17 2022",
        "-A",
        targetArch === "arm64" ? "ARM64" : "x64",
        `-DZCODE_SHIM_OUTPUT_DIR=${builtDir.replaceAll("\\", "/")}`,
      ],
      deadline,
    );
    await runCmake(command, ["--build", buildDir, "--config", "Release"], deadline);
    const bytes = await readFile(join(builtDir, outputName));
    verifyPe(bytes, targetArch);
    if ((await sourceDigest()) !== source)
      throw new Error("Windows entry shim sources changed during build");
    const manifest = { version: 1, arch: targetArch, source, binary: digest(bytes) };
    // 同源码无需改写正在被旧调用方读取的文件；新字节先完整写入，再原子发布。
    const previous = await readFile(join(outputDir, outputName)).catch(() => undefined);
    if (!previous?.equals(bytes)) await writeAtomic(join(outputDir, outputName), bytes);
    await writeAtomic(join(outputDir, "build.json"), JSON.stringify(manifest));
    console.log(`[preinstalled-entry-shim] built ${join(outputDir, outputName)}`);
    return { bytes, manifest };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(args) {
  if (platform() !== "win32") {
    console.log("[preinstalled-entry-shim] skip: Windows shim is built only on Windows");
    return;
  }
  if (args.includes("--check") && args.includes("--ensure"))
    throw new Error("--check and --ensure are mutually exclusive");
  const targetArch = (
    argument(args, "--arch") ??
    process.env.ZCODE_TARGET_ARCH ??
    arch()
  ).toLowerCase();
  if (targetArch !== "x64" && targetArch !== "arm64")
    throw new Error(`Unsupported Windows preinstalled entry shim architecture: ${targetArch}`);
  const outputDir = resolve(
    argument(args, "--output-dir") ??
      join(desktopRoot, `bundled-tools/win32-${targetArch}/preinstalled-entry-shim`),
  );
  const stageDir = argument(args, "--stage-dir");
  const timeout = Number(argument(args, "--timeout-ms") ?? BUILD_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error("Invalid shim preparation timeout");
  const deadline = Date.now() + timeout;
  await mkdir(dirname(outputDir), { recursive: true });
  // 所有发布、校验和快照共用这把锁。锁只存在于准备进程；运行中的 shard 读取独立副本。
  await withE2EDesktopBuildLock(
    { lockPath: `${outputDir}.build.lock`, timeoutMs: timeout },
    async () => {
      const source = await sourceDigest();
      let ready = await readyBuild(outputDir, targetArch, source);
      if (args.includes("--check") && !ready)
        throw new Error(
          "Windows entry shim cache is missing, stale or damaged; prepare it in the parent runner first",
        );
      if (!args.includes("--check") && (!args.includes("--ensure") || !ready))
        ready = await build(outputDir, targetArch, source, deadline);
      else console.log(`[preinstalled-entry-shim] ready ${join(outputDir, outputName)}`);
      if (stageDir) {
        // 使用校验过的同一份字节，避免 hash 与 copy 分别读取共享源形成 TOCTOU。
        await writeAtomic(join(resolve(stageDir), outputName), ready.bytes);
        await writeAtomic(join(resolve(stageDir), "build.json"), JSON.stringify(ready.manifest));
      }
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // WDIO 的配置加载器会同步解析依赖；入口使用 Promise 收口，避免顶层 await 阻断加载。
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
