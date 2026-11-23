import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { rewritePreinstalledToolBytes } from "@zcode/shared/preinstalled-tools/node";
import type { PreinstalledToolManifest } from "@zcode/shared/preinstalled-tools";
import type { createServiceLogger } from "@zcode/services/node";
import { validatePreinstalledFiles } from "@desktop/preinstalled-tools/archive.js";
import { PreinstalledToolFailure } from "@desktop/preinstalled-tools/download.js";

const exec = promisify(execFile);
const MACH_O_MAGIC = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

/** 只改本次 staging；发布记录之前失败或取消，旧版本及公开入口保持不变。 */
export async function rewritePreinstalledFiles({
  directory,
  installationDir,
  manifest,
  signal,
  log,
}: {
  directory: string;
  installationDir: string;
  manifest: Pick<PreinstalledToolManifest, "rewrite">;
  signal: AbortSignal;
  log: ReturnType<typeof createServiceLogger>;
}): Promise<void> {
  const replacement = Buffer.from(installationDir, "utf8");
  for (const rule of manifest.rewrite ?? []) {
    signal.throwIfAborted();
    const placeholder = Buffer.from(rule.placeholder, "utf8");
    if (rule.mode !== "text" && replacement.length > placeholder.length) {
      log.warn(undefined, "安装路径超过重定位占位符的字节长度", {
        path: rule.path,
        installationBytes: replacement.length,
        placeholderBytes: placeholder.length,
      });
      throw new PreinstalledToolFailure("unsupported", "安装路径超过重定位占位符的字节长度");
    }
    await validatePreinstalledFiles(directory, { requiredFiles: [rule.path] });
    signal.throwIfAborted();
    const file = join(directory, rule.path);
    const original = await readFile(file, { signal });
    const rewritten = rewritePreinstalledToolBytes(original, rule, installationDir);
    signal.throwIfAborted();
    if (rewritten === original || rewritten.equals(original)) continue;
    await writeFile(file, rewritten, { signal });
    signal.throwIfAborted();
    if (
      process.platform === "darwin" &&
      original.length >= 4 &&
      MACH_O_MAGIC.has(original.readUInt32BE(0))
    ) {
      await exec("/usr/bin/codesign", ["--force", "--sign", "-", file], {
        signal,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      signal.throwIfAborted();
    }
  }
}
