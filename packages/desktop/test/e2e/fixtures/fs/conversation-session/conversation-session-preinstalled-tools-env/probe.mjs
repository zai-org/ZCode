import { readFile, readdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const directory = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
const cache = join(config.storageRoot, "cli/plugins/cache/zcode-plugins-official/documents");
const versions = await readdir(cache);
if (versions.length !== 1) throw new Error("Expected one distributed documents version");
const helper = join(cache, versions[0], "scripts/zcode_libreoffice.py");
let result;
try {
  result = {
    ...(await promisify(execFile)(config.python, [helper, "check"], { timeout: 30000 })),
    exitCode: 0,
  };
} catch (error) {
  result = { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
}
console.log(
  JSON.stringify({
    available: process.env.ZCODE_PREINSTALLED_TOOLS_AVAILABLE ?? null,
    pathFirst: process.env.PATH.split(delimiter)[0],
    binDir: join(config.storageRoot, "preinstalled-tools", "development", "bin"),
    ...result,
  }),
);
