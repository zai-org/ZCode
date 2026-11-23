import { readFile, readdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const windows = process.platform === "win32";
const directory = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
const original = process.env.PATH.split(delimiter);
const baseEnv = Object.fromEntries(
  // Windows 环境变量不区分大小写；留着原来的 Path 会与下面的 PATH 冲突。
  Object.entries(process.env).filter(([name]) => !windows || name.toUpperCase() !== "PATH"),
);
const env = {
  ...baseEnv,
  PATH: [original[0], join(directory, "system-bin"), ...original.slice(1)].join(delimiter),
};
// Agent 的 Bash 在 Windows 上是 Git Bash；command -v 给出 POSIX 路径，转回 Windows 形式再比较。
const resolved = (
  await exec(
    windows ? "sh.exe" : "/bin/sh",
    [
      "-c",
      windows
        ? 'cygpath -w "$(command -v qpdf)"; p="$(command -v zcode-soffice)" && cygpath -w "$p" || true'
        : "command -v qpdf; command -v zcode-soffice || true",
    ],
    { env },
  )
).stdout
  .trim()
  .split(/\r?\n/);
const qpdf = windows
  ? await exec(process.env.ComSpec, ["/d", "/c", "qpdf"], { env })
  : await exec("qpdf", [], { env });
const cache = join(config.storageRoot, "cli/plugins/cache/zcode-plugins-official/documents");
const versions = await readdir(cache);
if (versions.length !== 1) throw new Error("Expected one distributed documents plugin");
const helper = join(cache, versions[0], "scripts/zcode_libreoffice.py");
const office = await exec(config.python, [helper, "check"], { env, timeout: 30000 });
console.log(
  JSON.stringify({
    pathFirst: original[0],
    qpdfPath: resolved[0],
    officePath: resolved[1] ?? null,
    qpdf: qpdf.stdout + qpdf.stderr,
    office: JSON.parse(office.stdout),
    officeNotice: office.stderr,
  }),
);
