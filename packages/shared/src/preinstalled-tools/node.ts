import { isAbsolute, join } from "node:path";
import {
  preinstalledToolsReleaseSchema,
  preinstalledToolIdSchema,
  type PreinstalledToolsRelease,
} from "@zcode/shared/preinstalled-tools";

/** 发布根与 catalog 无关，Host 在资源准备前即可注入固定目录。 */
export function resolvePreinstalledToolsPaths(input: {
  dataRoot: string;
  release: PreinstalledToolsRelease;
}) {
  if (!isAbsolute(input.dataRoot)) throw new Error("预装工具数据根目录必须是绝对路径");
  const rootDir = join(
    input.dataRoot,
    "preinstalled-tools",
    preinstalledToolsReleaseSchema.parse(input.release),
  );
  return { rootDir, binDir: join(rootDir, "bin"), toolsDir: join(rootDir, "tools") };
}
export function resolvePreinstalledToolsBinDir(input: {
  dataRoot: string;
  release: PreinstalledToolsRelease;
}): string {
  return resolvePreinstalledToolsPaths(input).binDir;
}
/** 每个工具只写自己的发布点、版本和临时目录；入口目录由协调器统一重建。 */
export function resolvePreinstalledToolPaths(input: {
  dataRoot: string;
  release: PreinstalledToolsRelease;
  toolId: string;
}) {
  const paths = resolvePreinstalledToolsPaths(input);
  const rootDir = join(paths.toolsDir, preinstalledToolIdSchema.parse(input.toolId));
  return {
    rootDir,
    binDir: paths.binDir,
    recordPath: join(rootDir, "installation.json"),
    versionsDir: join(rootDir, "versions"),
    stagingDir: join(rootDir, "staging"),
  };
}

export {
  PreinstalledToolRewriteError,
  rewritePreinstalledToolBytes,
} from "#src/preinstalled-tools/rewrite-bytes.js";
