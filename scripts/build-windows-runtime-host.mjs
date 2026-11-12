import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "scripts/windows-runtime-host");

export function resolveRuntimeHostBuild(
  arch,
  hostPlatform = process.platform,
  compiler = process.env.ZCODE_WINDOWS_CXX,
) {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Unsupported runtime host architecture: ${arch}`);
  return {
    configureArgs:
      hostPlatform === "win32"
        ? ["-G", "Visual Studio 17 2022", "-A", arch === "arm64" ? "ARM64" : "x64"]
        : [
            "-DCMAKE_SYSTEM_NAME=Windows",
            `-DCMAKE_CXX_COMPILER=${compiler || (arch === "arm64" ? "aarch64-w64-mingw32-clang++" : "x86_64-w64-mingw32-g++")}`,
          ],
  };
}

export function verifyRuntimeHostPe(bytes, arch) {
  const header = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  if (
    bytes.toString("ascii", 0, 2) !== "MZ" ||
    header < 0 ||
    header + 6 > bytes.length ||
    bytes.toString("ascii", header, header + 4) !== "PE\0\0"
  ) {
    throw new Error("Invalid runtime host PE binary");
  }
  if (bytes.readUInt16LE(header + 4) !== (arch === "arm64" ? 0xaa64 : 0x8664))
    throw new Error("Runtime host architecture mismatch");
}

async function sourceDigest() {
  const hash = createHash("sha256");
  for (const name of ["main.cpp", "installer-process-helper.cpp", "CMakeLists.txt"])
    hash.update(await readFile(join(source, name)));
  return hash.digest("hex");
}

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.env.CMAKE || "cmake", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Runtime host CMake failed: ${code}`)),
    );
  });
}

export async function isRuntimeHostReady(outputDir, arch) {
  try {
    const hostBytes = await readFile(join(outputDir, "zcode-runtime-host.exe"));
    const helperBytes = await readFile(join(outputDir, "zcode-installer-process-helper.exe"));
    verifyRuntimeHostPe(hostBytes, arch);
    verifyRuntimeHostPe(helperBytes, arch);
    const manifest = JSON.parse(await readFile(join(outputDir, "build.json"), "utf8"));
    return (
      manifest.source === (await sourceDigest()) &&
      manifest.binary === createHash("sha256").update(hostBytes).digest("hex") &&
      manifest.installerProcessHelper === createHash("sha256").update(helperBytes).digest("hex")
    );
  } catch {
    return false;
  }
}

export async function buildRuntimeHost({ arch, outputDir }) {
  const plan = resolveRuntimeHostBuild(arch);
  const work = await mkdtemp(join(tmpdir(), "zcode-runtime-host-"));
  try {
    await run(["-S", source, "-B", work, ...plan.configureArgs, "-DCMAKE_BUILD_TYPE=Release"]);
    await run([
      "--build",
      work,
      "--config",
      "Release",
      "--target",
      "zcode-runtime-host",
      "zcode-installer-process-helper",
    ]);
    const releaseDir = join(work, ...(process.platform === "win32" ? ["Release"] : []));
    const hostBytes = await readFile(join(releaseDir, "zcode-runtime-host.exe"));
    const helperBytes = await readFile(join(releaseDir, "zcode-installer-process-helper.exe"));
    verifyRuntimeHostPe(hostBytes, arch);
    verifyRuntimeHostPe(helperBytes, arch);
    await mkdir(outputDir, { recursive: true });
    await copyFile(
      join(releaseDir, "zcode-runtime-host.exe"),
      join(outputDir, "zcode-runtime-host.exe"),
    );
    await copyFile(
      join(releaseDir, "zcode-installer-process-helper.exe"),
      join(outputDir, "zcode-installer-process-helper.exe"),
    );
    await writeFile(
      join(outputDir, "build.json"),
      JSON.stringify({
        source: await sourceDigest(),
        binary: createHash("sha256").update(hostBytes).digest("hex"),
        installerProcessHelper: createHash("sha256").update(helperBytes).digest("hex"),
      }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const arch =
    args.find((arg) => arg.startsWith("--arch="))?.slice(7) ||
    process.env.ZCODE_TARGET_ARCH ||
    process.arch;
  const outputDir =
    args.find((arg) => arg.startsWith("--output-dir="))?.slice(13) ||
    join(root, "packages/desktop/bundled-tools", `win32-${arch}`, "runtime-host");
  if (!args.includes("--if-windows") || process.platform === "win32") {
    if (!args.includes("--ensure") || !(await isRuntimeHostReady(outputDir, arch))) {
      await buildRuntimeHost({ arch, outputDir });
    }
  }
}
