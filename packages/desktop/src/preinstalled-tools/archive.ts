import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { list, extract } from "tar";
import type { PreinstalledToolManifest } from "@zcode/shared/preinstalled-tools";

function inside(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return (
    remainder !== ".." &&
    !remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(remainder)
  );
}

/** 解压前先流式检查所有条目；默认安全解包器另外拒绝经过符号链接写入。 */
export async function extractPreinstalledArchive(
  archive: string,
  destination: string,
  manifest: PreinstalledToolManifest,
  signal: AbortSignal,
): Promise<void> {
  let invalid: Error | undefined;
  let expandedBytes = 0;
  await pipeline(
    createReadStream(archive),
    list({
      strict: true,
      onReadEntry(entry) {
        const name = entry.path.replace(/\/$/, "");
        const safePath =
          name !== "" &&
          !/[\\:]/.test(name) &&
          !name.includes("\0") &&
          !name.startsWith("/") &&
          name.split("/").every((part) => part !== ".." && part !== "." && part !== "");
        const allowed = ["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(
          entry.type,
        );
        const linkpath = entry.linkpath ?? "";
        const link =
          entry.type === "SymbolicLink"
            ? posix.join(posix.dirname(name), linkpath)
            : posix.normalize(linkpath);
        const safeLink =
          !["SymbolicLink", "Link"].includes(entry.type) ||
          (linkpath !== "" &&
            !/[\\:]/.test(linkpath) &&
            !linkpath.includes("\0") &&
            !linkpath.startsWith("/") &&
            link !== ".." &&
            !link.startsWith("../"));
        expandedBytes += entry.size;
        if (!safePath || !allowed || !safeLink || expandedBytes > manifest.installedSizeBytes)
          invalid ??= new Error("归档条目越界、类型不支持或展开大小超限");
      },
    }),
    { signal },
  );
  if (invalid) throw invalid;
  await pipeline(
    createReadStream(archive),
    extract({
      cwd: destination,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      chmod: true,
    }),
    { signal },
  );
}

export async function validatePreinstalledFiles(
  directory: string,
  manifest: Pick<PreinstalledToolManifest, "requiredFiles">,
): Promise<void> {
  const root = await realpath(directory);
  for (const file of manifest.requiredFiles) {
    const target = await realpath(join(root, file));
    if (!inside(root, target) || !(await stat(target)).isFile())
      throw new Error(`必需文件不可用: ${file}`);
  }
}
