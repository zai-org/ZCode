// zcode-site deploy 的本地打包与 check 的本地启动检查，不调用云端。
// deploy 的输入是 stage 目录：Agent 不经手 tar 包，打包和契约检查都在这里，检查不过不建部署、不上传。
// 原来是 pack.sh，依赖 bash、find、stat、file、tar；Windows 上的 Git Bash 常常没有 file，
// 没装 Git Bash 时 Agent 的 shell 是 CMD，脚本整个跑不了。这里只用 Node 标准库，三个平台行为一致。

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

// 与服务端产物包契约一致（zcode-site-plugin-server internal/site/model.go）。
export const LIMITS = {
  packageBytes: 200 * 1024 * 1024,
  unpackedBytes: 400 * 1024 * 1024,
  fileCount: 20_000,
  fileBytes: 25 * 1024 * 1024,
  pathDepth: 32,
};

// 打包时总是跳过的文件；其余 stage 里的内容原样进包。
const SKIPPED_NAMES = new Set([".git", ".DS_Store", "__pycache__", ".zcode-site.json"]);
const MAX_LISTED = 10;
// 与云端健康检查一致：启动后 90 秒内 GET / 回 500 以下。
const CHECK_TIMEOUT_MS = 90_000;
const CHECK_POLL_MS = 500;
const CHECK_LOG_LINES = 60;
const MIB = 1024 * 1024;

// ---------- 二进制识别 ----------

// 只看文件头的魔数：ELF 64 位小端且 e_machine 为 x86-64 才能在云端运行；Mach-O、PE 和其他 ELF 都不能。
// 识别不了的（文本、图片、字节码）返回 undefined。
export function classifyBinary(head) {
  if (
    head.length >= 20 &&
    head[0] === 0x7f &&
    head[1] === 0x45 &&
    head[2] === 0x4c &&
    head[3] === 0x46
  ) {
    const is64 = head[4] === 2;
    const machine = head[5] === 1 ? head.readUInt16LE(18) : head.readUInt16BE(18);
    if (is64 && head[5] === 1 && machine === 0x3e) return { linux: true };
    return {
      linux: false,
      kind: `ELF ${is64 ? "64" : "32"}-bit, machine 0x${machine.toString(16)}`,
    };
  }
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
      return { linux: false, kind: "Mach-O (macOS)" };
    // 0xcafebabe 也是 Java class 的魔数；fat Mach-O 后面跟的是架构数（很小），class 文件跟的是版本号（≥ 45）。
    if (magic === 0xcafebabe && head.length >= 8 && head.readUInt32BE(4) < 30)
      return { linux: false, kind: "Mach-O universal (macOS)" };
  }
  if (head.length >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 4 <= head.length && head.readUInt32BE(peOffset) === 0x50450000)
      return { linux: false, kind: "PE (Windows)" };
  }
  return undefined;
}

async function readHead(file, bytes) {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// ---------- 遍历 stage ----------

// 跟随符号链接（pnpm 的 node_modules 是链接），按真实文件进包；记录已访问的真实目录，防止链接成环。
async function listStage(stage) {
  const files = [];
  const broken = [];
  const visited = new Set();
  async function walk(dir, rel) {
    const real = await realpath(dir);
    if (visited.has(real)) return;
    visited.add(real);
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      let info;
      try {
        info = await stat(abs);
      } catch {
        if ((await lstat(abs)).isSymbolicLink()) broken.push(name);
        continue;
      }
      if (info.isDirectory()) await walk(abs, name);
      else if (info.isFile())
        files.push({ abs, name, size: info.size, mode: info.mode, mtime: info.mtime });
    }
  }
  await walk(stage, "");
  return { files, broken };
}

function listed(items, format = (x) => x) {
  const lines = items.slice(0, MAX_LISTED).map((x) => `    ${format(x)}`);
  if (items.length > MAX_LISTED) lines.push(`    … and ${items.length - MAX_LISTED} more`);
  return lines.join("\n");
}

const ENV_FILE = /(^|\/)\.env($|\.)/;
const ENV_EXAMPLE = /\.(example|sample|template)$/;

// 检查 stage 是否满足产物包契约，以及那些只有到了 Linux 才会出错的问题。返回问题列表和二进制统计。
async function inspectStage(stage, files, broken, { allowForeignBinaries }) {
  const problems = [];
  const warnings = [];
  const names = new Set(files.map((f) => f.name));

  const startSh = files.find((f) => f.name === "start.sh");
  if (!startSh)
    problems.push("start.sh is missing at the stage root (the runtime runs `bash /app/start.sh`)");
  else if ((await readFile(startSh.abs)).includes(0x0d))
    problems.push(
      "start.sh has CRLF line endings; convert it to LF (bash fails with $'\\r': command not found)",
    );
  if (files.some((f) => f.name === ".__zcode" || f.name.startsWith(".__zcode/")))
    problems.push(".__zcode/ at the root is reserved by the gateway; rename it");
  if (broken.length) problems.push(`broken symlinks (fix or remove them):\n${listed(broken)}`);

  if (files.length > LIMITS.fileCount)
    problems.push(
      `${files.length} files, limit is ${LIMITS.fileCount} (prune node_modules / vendor, see references/packaging.md)`,
    );

  if (names.has("package.json") && ![...names].some((n) => n.startsWith("node_modules/"))) {
    try {
      const pkg = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
      if (Object.keys(pkg.dependencies ?? {}).length > 0)
        problems.push(
          "package.json declares dependencies but node_modules/ is missing (install them for linux x64, see references/native-deps.md)",
        );
    } catch {
      problems.push("package.json is not valid JSON");
    }
  }
  if (names.has("requirements.txt") && ![...names].some((n) => n.startsWith("vendor/"))) {
    const reqs = await readFile(join(stage, "requirements.txt"), "utf8");
    if (/^\s*[A-Za-z0-9]/m.test(reqs))
      problems.push(
        "requirements.txt is in the stage but vendor/ is missing (see references/python-deps.md)",
      );
  }

  const envs = files
    .filter((f) => ENV_FILE.test(f.name) && !ENV_EXAMPLE.test(f.name))
    .map((f) => f.name);
  if (envs.length)
    problems.push(`.env files must not be packaged (they hold secrets):\n${listed(envs)}`);

  const deep = files.filter((f) => f.name.split("/").length > LIMITS.pathDepth).map((f) => f.name);
  if (deep.length)
    problems.push(`paths deeper than ${LIMITS.pathDepth} segments:\n${listed(deep)}`);

  const unpackedBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (unpackedBytes > LIMITS.unpackedBytes)
    problems.push(
      `unpacked size ${Math.round(unpackedBytes / MIB)} MB, limit is ${LIMITS.unpackedBytes / MIB} MB`,
    );
  const big = files.filter((f) => f.size > LIMITS.fileBytes);
  if (big.length)
    problems.push(
      `files larger than ${LIMITS.fileBytes / MIB} MB:\n${listed(big, (f) => `${f.name} (${Math.round(f.size / MIB)} MB)`)}`,
    );

  // 每个文件都看文件头：不靠扩展名或可执行位（Windows 上没有可执行位，esbuild 这类 CLI 二进制也没有扩展名）。
  const foreign = [];
  let linuxBinaries = 0;
  for (const f of files) {
    if (f.size < 4) continue;
    const kind = classifyBinary(await readHead(f.abs, 512));
    if (!kind) continue;
    f.binary = true;
    if (kind.linux) linuxBinaries += 1;
    else foreign.push(`${f.name}: ${kind.kind}`);
  }
  if (foreign.length) {
    const message = `binaries that cannot run on linux x86-64 (reinstall for linux x64 or replace; see references/native-deps.md, references/python-deps.md):\n${listed(foreign)}`;
    if (allowForeignBinaries)
      warnings.push(message.replace("binaries that", "packing binaries that"));
    else problems.push(message);
  }
  return { problems, warnings, unpackedBytes, linuxBinaries };
}

// ---------- tar ----------

// ustar 头；路径超过 100 字节或含非 ASCII 字符时先写一个 PAX 扩展头（path=…），GNU tar 和服务端都认。
function tarHeader(name, size, mode, mtime, type = "0") {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => header.write(value, offset, length, "utf8");
  const octal = (value, length) => value.toString(8).padStart(length - 1, "0");
  write(name, 0, 100);
  write(octal(mode & 0o7777, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12);
  write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  header.fill(0x20, 148, 156);
  write(type, 156, 1);
  write("ustar\u000000", 257, 8);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(`${octal(sum, 7)}\u0000 `, 148, 8);
  return header;
}

function padding(size) {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  // 记录长度包含长度数字本身，数字位数变化时要再算一次。
  while (Buffer.byteLength(`${length}${body}`) !== length)
    length = Buffer.byteLength(`${length}${body}`);
  return `${length}${body}`;
}

async function* tarEntries(files) {
  for (const f of files) {
    // 运行时不认可执行位，但应用可能 spawn 包里的二进制；Windows 上读不到可执行位，所以二进制一律 0755。
    const mode = f.binary ? 0o755 : f.mode & 0o111 ? 0o755 : 0o644;
    if (Buffer.byteLength(f.name) > 100 || /[^\x20-\x7e]/.test(f.name)) {
      const pax = Buffer.from(paxRecord("path", f.name), "utf8");
      yield tarHeader("././@PaxHeader", pax.length, 0o644, f.mtime, "x");
      yield pax;
      yield padding(pax.length);
    }
    const body = await readFile(f.abs);
    // 遍历之后文件可能被改动；以实际读到的内容为准，否则头里的大小对不上会写坏整个包。
    yield tarHeader(f.name.slice(0, 100), body.length, mode, f.mtime);
    yield body;
    yield padding(body.length);
  }
  yield Buffer.alloc(1024);
}

// ---------- pack ----------

// 产物包直接打在内存里：压缩后不超过 200 MB，上传也是整块发送，省掉临时文件的清理。
export async function packStage(
  stageArg,
  { cwd = process.cwd(), allowForeignBinaries = false } = {},
) {
  const stage = resolve(cwd, stageArg);
  const info = await stat(stage).catch(() => undefined);
  if (!info?.isDirectory())
    return { error: "STAGE_NOT_FOUND", message: `Stage directory not found: ${stageArg}` };

  const { files, broken } = await listStage(stage);
  if (files.length === 0) return { error: "STAGE_EMPTY", message: "The stage directory is empty" };
  const report = await inspectStage(stage, files, broken, { allowForeignBinaries });
  if (report.problems.length) return { problems: report.problems };

  const chunks = [];
  await pipeline(Readable.from(tarEntries(files)), createGzip(), async (gzipped) => {
    for await (const chunk of gzipped) chunks.push(chunk);
  });
  const body = Buffer.concat(chunks);
  const packageBytes = body.length;
  if (packageBytes > LIMITS.packageBytes) {
    return {
      problems: [
        `package is ${Math.round(packageBytes / MIB)} MB compressed, limit is ${LIMITS.packageBytes / MIB} MB (see references/packaging.md)`,
      ],
    };
  }
  return {
    body,
    result: {
      packageBytes,
      unpackedBytes: report.unpackedBytes,
      files: files.length,
      linuxBinaries: report.linuxBinaries,
    },
    warnings: report.warnings,
  };
}

// ---------- check ----------

// Windows 上优先用 Git for Windows 的 bash；System32 下的 bash.exe 是 WSL，路径语义不同，不能用。
function findBash(platform, env) {
  if (platform !== "win32") return "bash";
  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (!dir || /\\system32\\?$/i.test(dir)) continue;
    candidates.push(join(dir, "bash.exe"));
  }
  return candidates.find((p) => existsSync(p));
}

function requestStatus(port) {
  return new Promise((resolveStatus) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      resolveStatus(res.statusCode);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolveStatus(undefined));
  });
}

function stopTree(child, platform) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

// 在本机按云端的方式启动 stage：bash start.sh，PORT 和 DATA_DIR 由这里给，等 GET / 回 500 以下。
// 能证明启动命令、端口、/ 路由和文件齐全；证明不了 Linux 兼容性，这由 pack 的二进制扫描负责。
export async function checkStage(
  stageArg,
  {
    cwd = process.cwd(),
    port = 13000,
    timeoutMs = CHECK_TIMEOUT_MS,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
  } = {},
) {
  const stage = resolve(cwd, stageArg);
  if (!existsSync(join(stage, "start.sh")))
    return { error: "STAGE_NOT_FOUND", message: `No start.sh in ${stageArg}` };

  // stage 里有 Linux 原生二进制时，非 Linux x64 的机器加载不了，本地跑一定失败，不能当成包的问题。
  if (platform !== "linux" || arch !== "x64") {
    const { files } = await listStage(stage);
    for (const f of files) {
      if (f.size >= 20 && classifyBinary(await readHead(f.abs, 512))?.linux)
        return {
          result: {
            status: "skipped",
            reason: `the stage contains Linux x86-64 binaries (${f.name}) that cannot load on ${platform}-${arch}; run the app from its normal local environment with the same start command instead`,
          },
        };
    }
  }
  const bash = findBash(platform, env);
  if (!bash)
    return {
      result: {
        status: "skipped",
        reason:
          "bash is not available on this machine (on Windows, install Git for Windows); run the app from its normal local environment with the same start command instead",
      },
    };

  const dataDir = await mkdtemp(join(tmpdir(), "zcode-site-check-"));
  const lines = [];
  const collect = (chunk) => {
    lines.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
    if (lines.length > CHECK_LOG_LINES) lines.splice(0, lines.length - CHECK_LOG_LINES);
  };
  const child = spawn(bash, ["start.sh"], {
    cwd: stage,
    env: { ...env, PORT: String(port), DATA_DIR: dataDir },
    detached: platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let spawnError;
  const exited = new Promise((resolveExit) => {
    child.on("error", (err) => {
      spawnError = err;
      resolveExit(null);
    });
    child.on("exit", (code) => resolveExit(code));
  });
  let exitCode;
  exited.then((code) => {
    exitCode = code ?? -1;
  });

  try {
    const deadline = Date.now() + timeoutMs;
    let serverErrors = 0;
    while (Date.now() < deadline) {
      const status = await requestStatus(port);
      if (status !== undefined && status < 500)
        return { result: { status: "live", httpStatus: status, log: lines } };
      // 刚起来时偶尔回一次 5xx，连续两次才算失败。
      serverErrors = status === undefined ? 0 : serverErrors + 1;
      if (serverErrors >= 2)
        return { failed: { reason: `GET / returned ${status}`, httpStatus: status, log: lines } };
      if (exitCode !== undefined) {
        const reason = spawnError
          ? `could not run bash: ${spawnError.message}`
          : `start.sh exited with code ${exitCode} before answering GET /`;
        return { failed: { reason, log: lines } };
      }
      await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
    }
    return {
      failed: {
        reason: `nothing answered GET / on port ${port} within ${Math.round(timeoutMs / 1000)} s (wrong port, bound to 127.0.0.1, or startup too slow)`,
        log: lines,
      },
    };
  } finally {
    stopTree(child, platform);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
