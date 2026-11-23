import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME } from "@zcode/shared";

/**
 * 本轮是否需要 SSH remote release（mock-cdn/releases/<version>）的唯一判据：调度的 spec
 * 直接或间接 import 了下列模块（相对 packages/desktop）。规格见
 * docs/testing/conversation-session-automatic-e2e-ci.md「SSH remote assets 自动准备」。
 *
 * 原因：过去只看 runner 是否配置了 SSH 环境变量。CI 的 SSH 凭据是项目级变量，只改普通 spec
 * 的 MR 也会触发远端 release 全平台重建；按文件名或名单判断又会漏掉经 helper 间接连 SSH 的用例。
 */
export const REMOTE_RELEASE_CONSUMER_MODULES = [
  // SSH 目标配置的唯一入口，连接 SSH 的用例都经过它。
  "test/e2e/helpers/ssh-remote-p0.ts",
  // 以下 helper 直接读取本轮 staged release。
  "test/e2e/helpers/remote-restart-stale-daemon.ts",
  "test/e2e/helpers/source-server-update-fixture.ts",
  "test/e2e/helpers/ssh-version-policy-fixture.ts",
] as const;

/** onPrepare stage remote release 后经 runnerEnv 下发的目录；worker 兜底只认它。 */
export const REMOTE_RELEASE_DIR_ENV = "ZCODE_E2E_REMOTE_RELEASE_DIR";

// 覆盖 `import x from`、`import type x from`、`export x from`、`import "x"` 与 `import("x")`。
// 不区分类型 import：多准备不会出错，少准备会让用例在兜底处失败。
const IMPORT_SPECIFIER_PATTERN =
  /(?:\b(?:import|export)\b[^"'`;]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;

export async function listSpecsRequiringRemoteRelease({
  desktopDir,
  specFiles,
  readText = (path: string) => readFile(path, "utf8"),
}: {
  desktopDir: string;
  /** 相对 desktopDir 的 spec 路径，即 resolveE2EScheduledSpecFiles 的输出。 */
  specFiles: string[];
  readText?: (path: string) => Promise<string>;
}): Promise<string[]> {
  const e2eRoot = resolve(desktopDir, "test/e2e");
  const consumers = new Set(
    REMOTE_RELEASE_CONSUMER_MODULES.map((path) => resolve(desktopDir, path)),
  );
  // 先建完整 import 图，再从 consumer 反向搜索。按模块递归 await 时，循环 import 会等待自己
  // 尚未完成的 Promise 而挂死；多个 spec 并行遍历时把“进行中”记为 false 又会误判。
  const importsByFile = new Map<string, string[]>();
  let frontier = specFiles.map((spec) => resolve(desktopDir, spec));
  while (frontier.length > 0) {
    const pending = [...new Set(frontier)].filter((file) => !importsByFile.has(file));
    for (const file of pending) importsByFile.set(file, []);
    const parsed = await Promise.all(
      pending.map(async (file) => {
        // consumer 本身就是终点，不需要读取。
        if (consumers.has(file)) return [];
        try {
          return [...(await readText(file)).matchAll(IMPORT_SPECIFIER_PATTERN)]
            .map((match) => resolveE2EModule(match[1]!, file, desktopDir, e2eRoot))
            .filter((target): target is string => target !== null);
        } catch {
          // 解析不到的路径不影响判定；真正漏判由 worker 兜底失败。
          return [];
        }
      }),
    );
    pending.forEach((file, index) => importsByFile.set(file, parsed[index]!));
    frontier = parsed.flat();
  }

  const importers = new Map<string, string[]>();
  for (const [file, targets] of importsByFile) {
    for (const target of targets) importers.set(target, [...(importers.get(target) ?? []), file]);
  }
  const reaching = new Set<string>();
  const queue = [...consumers];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reaching.has(file)) continue;
    reaching.add(file);
    queue.push(...(importers.get(file) ?? []));
  }
  return specFiles.filter((spec) => reaching.has(resolve(desktopDir, spec)));
}

/** 只跟随 test/e2e 内的相对路径与 #e2e/* 别名（package.json imports）；包与 #src 不影响判定。 */
function resolveE2EModule(
  specifier: string,
  fromFile: string,
  desktopDir: string,
  e2eRoot: string,
): string | null {
  let base: string;
  if (specifier.startsWith("#e2e/")) base = resolve(desktopDir, "test/e2e", specifier.slice(5));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  if (relative(e2eRoot, base).startsWith("..")) return null;
  // 源码里写 .js 后缀或不写后缀，实际文件都是 .ts。
  return base.endsWith(".ts") ? base : `${base.replace(/\.js$/u, "")}.ts`;
}

/**
 * 兜底：SSH 配置入口读取配置后调用。import 判定漏掉用例时，onPrepare 没有准备 release，
 * 这里直接失败，避免用例用旧产物或缺失产物运行到远离根因的位置。
 * 使用 existsSync：调用方 read*SSHRuntimeConfig 是同步 API，被 160 多个用例直接调用。
 */
export function assertRemoteReleaseStaged(
  caseMarker: string,
  env: Record<string, string | undefined> = process.env,
): void {
  // 已打包应用使用随包配置的发布源，不读 mock-cdn，onPrepare 也不 stage。
  if (env.ZCODE_E2E_PACKAGED_APP_PATH?.trim()) return;
  const releaseDir = env[REMOTE_RELEASE_DIR_ENV]?.trim();
  if (releaseDir && existsSync(join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)))
    return;
  throw new Error(
    `${caseMarker}: 该 spec 需要 remote release，但 onPrepare 没有准备（${REMOTE_RELEASE_DIR_ENV}=${releaseDir ?? ""}）。` +
      `检查它是否 import 了 ${REMOTE_RELEASE_CONSUMER_MODULES.join("、")} 之一（见 e2e-remote-release-requirement.ts）`,
  );
}
