import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, readdir, lstat, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const directory = dirname(fileURLToPath(import.meta.url));
export const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
export const isWindows = process.platform === "win32";
// Windows 上 Agent 的 Bash 是 Git Bash；裸 bash 可能解析到 WSL，必须用测试传入的绝对路径。
export const bash = config.bash ?? "/bin/bash";
export const agentCommand = /(?:zcode-cli|agent-cli|zcode-agent|[\\/]cli[\\/]dist[\\/])/;
export const docs = join(directory, "中文 空格");
export const tools = ["python", "qpdf", "pandoc", "poppler", "libreoffice"];
export const entries = {
  python: ["zcode-python"],
  qpdf: ["qpdf"],
  pandoc: ["pandoc"],
  poppler: ["pdftoppm", "pdftotext", "pdfimages", "pdfinfo"],
  libreoffice: ["zcode-soffice"],
};
export const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
export const record = async (id) =>
  JSON.parse(await readFile(join(config.root, "tools", id, "installation.json"), "utf8"));
export const put = (name, value) =>
  writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2));
export const get = async (name) =>
  JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"));
const run = promisify(execFile);
const commands = [];
let logWrite = Promise.resolve();
/** 公开入口的可执行文件：Windows 上是 shim 副本 <name>.exe，其他平台是 sh 脚本。与 E2E 辅助函数同规则。 */
export const entryPath = (name) => join(config.root, "bin", isWindows ? `${name}.exe` : name);
/** 入口指向的目标、参数和环境值；Windows 上解码 shim 配置，避免 JSON 转义的反斜杠让断言落空。 */
export async function entryDefinition(name) {
  if (!isWindows) return readFile(join(config.root, "bin", name), "utf8");
  const shim = JSON.parse(await readFile(join(config.root, "bin", `${name}.shim`), "utf8"));
  return [shim.target, ...shim.args, ...shim.env.map((item) => item.value ?? "")].join("\n");
}
// Windows 入口是 shim 可执行文件，Node 不经 shell 即可按名字从 PATH 找到 <name>.exe。
export async function execute(file, args, expectedCode = 0, options = {}) {
  let result;
  try {
    result = {
      ...(await run(file, args, {
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...options,
      })),
      code: 0,
    };
  } catch (error) {
    result = {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: error.code,
      signal: error.signal,
    };
  }
  commands.push({ file, args, ...result });
  const receipt = [...commands];
  logWrite = logWrite.then(() => put(`commands-${process.argv[2]}`, receipt));
  await logWrite;
  if (expectedCode !== null)
    assert.equal(result.code, expectedCode, JSON.stringify(commands.at(-1)));
  return result;
}
export async function selected(name) {
  const found = (
    await execute(bash, ["-c", 'command -v "$1" || true', "probe", name])
  ).stdout.trim();
  // Git Bash 给出 /c/... 形式；转回 Windows 路径后再与入口目录比较。
  if (!isWindows || !found) return found;
  return (await execute(bash, ["-c", 'cygpath -w "$1"', "probe", found])).stdout.trim();
}
export async function plugin(name) {
  const cache = join(config.storageRoot, "cli/plugins/cache/zcode-plugins-official", name);
  const versions = await readdir(cache);
  assert.equal(versions.length, 1);
  const root = join(cache, versions[0]);
  const metadata = JSON.parse(await readFile(join(root, ".zcode-plugin/plugin.json"), "utf8"));
  assert.equal(metadata.version, versions[0]);
  assert.equal(await hash(join(root, "scripts/zcode_libreoffice.py")), config.helperSha256);
  return root;
}
export async function tree(root) {
  const result = {};
  async function walk(relative) {
    let items;
    try {
      items = await readdir(join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && !relative) return;
      throw error;
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, item.name);
      const path = join(root, name);
      if (item.isSymbolicLink()) result[name] = `link:${await readlink(path)}`;
      else if (item.isDirectory()) {
        result[name] = "directory";
        await walk(name);
      } else {
        assert.ok((await lstat(path)).isFile());
        result[name] = await hash(path);
      }
    }
  }
  await walk("");
  return result;
}
export async function snapshots() {
  const root = join(config.storageRoot, "cli/exec/shell-snapshots");
  return Promise.all(
    (await readdir(root))
      .sort()
      .map(async (name) => ({ name, sha256: await hash(join(root, name)) })),
  );
}
async function processTable() {
  if (!isWindows) {
    const result = await run("/bin/ps", ["-axo", "pid=,ppid=,command="]);
    return result.stdout
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }));
  }
  const script =
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return JSON.parse(result.stdout).map((row) => ({
    pid: row.ProcessId,
    parent: row.ParentProcessId,
    command: row.CommandLine ?? "",
  }));
}
export async function ancestors() {
  const rows = new Map((await processTable()).map((row) => [row.pid, row]));
  const chain = [];
  let pid = process.ppid;
  while (rows.has(pid) && pid > 1 && !chain.some((row) => row.pid === pid)) {
    const row = rows.get(pid);
    chain.push(row);
    pid = row.parent;
  }
  return chain;
}
export async function assertSameAgent() {
  const before = await get("before");
  assert.deepEqual(await snapshots(), before.snapshots);
  const current = await ancestors();
  const original = before.ancestors.find((item) => agentCommand.test(item.command));
  assert.ok(original, JSON.stringify(before.ancestors));
  assert.ok(
    current.some((item) => item.pid === original.pid && item.command === original.command),
    "original Agent process exited",
  );
  return { agentPid: original.pid, ancestors: current };
}
