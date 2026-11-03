import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";

const SOURCEMAP_REFERENCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".css"]);
// 只清理位于行首的 sourceMappingURL 注释。压缩后的 bundle 可能在模板字符串里内嵌
// 这段文本（例如内嵌 TypeScript 编译器的 emitter 源码），行中匹配会把该行剩余内容整段
// 吞掉，直接产出语法损坏的产物；真实的 sourcemap 注释总是由构建工具单独成行输出。
const SOURCE_MAPPING_URL_LINE_RE = /(?:^|\r?\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*/g;
const SOURCE_MAPPING_URL_BLOCK_RE =
  /(?:^|\r?\n)[ \t]*\/\*[#@][ \t]*sourceMappingURL=[\s\S]*?\*\/[ \t]*/g;

export function stripSourceMappingUrlComments(source) {
  return source.replace(SOURCE_MAPPING_URL_LINE_RE, "").replace(SOURCE_MAPPING_URL_BLOCK_RE, "");
}

function walkFiles(rootDir, visitor) {
  if (!existsSync(rootDir)) {
    return;
  }

  for (const entry of readdirSync(rootDir)) {
    const entryPath = resolve(rootDir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      walkFiles(entryPath, visitor);
      continue;
    }
    if (stat.isFile()) {
      visitor(entryPath);
    }
  }
}

export function stripSourceMappingUrlCommentsInDirectory(rootDir) {
  const summary = { filesChanged: 0, referencesRemoved: 0 };
  walkFiles(rootDir, (filePath) => {
    if (!SOURCEMAP_REFERENCE_EXTENSIONS.has(extname(filePath))) {
      return;
    }
    const source = readFileSync(filePath, "utf8");
    const lineReferenceCount = source.match(SOURCE_MAPPING_URL_LINE_RE)?.length ?? 0;
    const blockReferenceCount = source.match(SOURCE_MAPPING_URL_BLOCK_RE)?.length ?? 0;
    const referencesRemoved = lineReferenceCount + blockReferenceCount;
    if (referencesRemoved === 0) {
      return;
    }

    writeFileSync(filePath, stripSourceMappingUrlComments(source));
    summary.filesChanged += 1;
    summary.referencesRemoved += referencesRemoved;
  });
  return summary;
}

export function removeSourceMapFilesInDirectory(rootDir) {
  const summary = { filesRemoved: 0 };
  walkFiles(rootDir, (filePath) => {
    if (extname(filePath) !== ".map") {
      return;
    }

    unlinkSync(filePath);
    summary.filesRemoved += 1;
  });
  return summary;
}

export async function cleanupPackagedSourcemaps({
  appAsarPath,
  resourcesDir,
  runAsarCommand,
  runTimedSync,
  runTimedAsync,
  replaceAppAsarFromStaging,
  pruneStagingDirectory = null,
  logger = console,
}) {
  if (existsSync(appAsarPath)) {
    mkdirSync(tmpdir(), { recursive: true });
    const stagingDir = mkdtempSync(resolve(tmpdir(), "zcode-app-asar-sourcemap-"));
    try {
      runTimedSync("afterPack:sourcemap-cleanup:asar-extract", () =>
        runAsarCommand(["extract", appAsarPath, stagingDir]),
      );
      const stripSummary = stripSourceMappingUrlCommentsInDirectory(stagingDir);
      const mapSummary = removeSourceMapFilesInDirectory(stagingDir);
      const pruneSummary = pruneStagingDirectory ? await pruneStagingDirectory(stagingDir) : null;
      if (
        stripSummary.referencesRemoved > 0 ||
        mapSummary.filesRemoved > 0 ||
        (pruneSummary?.packagesRemoved ?? 0) > 0
      ) {
        if (pruneSummary?.packagesRemoved > 0) {
          logger.log(
            `[afterPack] removed incompatible platform packages count=${pruneSummary.packagesRemoved}: ${pruneSummary.removedNames.join(", ")}`,
          );
        }
        logger.log(
          `[afterPack] stripped sourceMappingURL references=${stripSummary.referencesRemoved} files=${stripSummary.filesChanged} maps=${mapSummary.filesRemoved}`,
        );
        await runTimedAsync("afterPack:sourcemap-cleanup:asar-pack", () =>
          replaceAppAsarFromStaging({ sourceDir: stagingDir, appAsarPath }),
        );
      } else {
        logger.log("[afterPack] app.asar sourcemap cleanup found no references");
      }
    } finally {
      rmSync(stagingDir, { force: true, recursive: true });
    }
  }

  const stripSummary = stripSourceMappingUrlCommentsInDirectory(resourcesDir);
  const mapSummary = removeSourceMapFilesInDirectory(resourcesDir);
  logger.log(
    `[afterPack] resources sourcemap cleanup references=${stripSummary.referencesRemoved} files=${stripSummary.filesChanged} maps=${mapSummary.filesRemoved}`,
  );
}
