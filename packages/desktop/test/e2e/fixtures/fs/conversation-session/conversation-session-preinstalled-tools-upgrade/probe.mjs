import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Windows 入口是 shim（zcode-soffice.exe），不经 shell 也能按 PATH 找到。
const { stdout } = await promisify(execFile)("zcode-soffice", ["--fixture-location"]);
console.log(
  JSON.stringify({
    executable: stdout.trim(),
    available: process.env.ZCODE_PREINSTALLED_TOOLS_AVAILABLE,
  }),
);
