import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

interface ResolveE2EScheduledSpecFilesOptions {
  baseDir: string;
  exclude: string[];
  specs: string[];
}

interface AssertNonEmptyE2EScheduledSpecFilesOptions
  extends ResolveE2EScheduledSpecFilesOptions {
  argv: string[];
  envSpec?: string;
  requestedSpecs: string[];
}

export function resolveE2EScheduledSpecFiles({
  baseDir,
  exclude,
  specs,
}: ResolveE2EScheduledSpecFilesOptions): string[] {
  const includeMatchers = specs.map((spec) => createSpecMatcher(baseDir, spec));
  const excludeMatchers = exclude.map((spec) => createSpecMatcher(baseDir, spec));
  const candidateFiles = collectCandidateSpecFiles(baseDir, specs);

  return candidateFiles
    .filter((file) => includeMatchers.some((matcher) => matcher(file)))
    .filter((file) => !excludeMatchers.some((matcher) => matcher(file)))
    .map((file) => toSlash(relative(baseDir, file)))
    .sort();
}

export function assertNonEmptyE2EScheduledSpecFiles(
  options: AssertNonEmptyE2EScheduledSpecFilesOptions,
): string[] {
  const scheduled = resolveE2EScheduledSpecFiles(options);
  if (scheduled.length > 0) {
    return scheduled;
  }

  // 修复原因：WDIO 在部分 runner 上可在没有调度 worker 时只跑 onPrepare/build 并返回 0；
  // 这里在任何构建副作用前解析有效 spec，空集合直接失败，避免 CI 之后只看到缺 summary.json。
  throw new Error(
    [
      "Desktop E2E has no scheduled spec files after applying excludes.",
      `baseDir=${options.baseDir}`,
      `specs=${JSON.stringify(options.specs)}`,
      `exclude=${JSON.stringify(options.exclude)}`,
      `requestedSpecs=${JSON.stringify(options.requestedSpecs)}`,
      `ZCODE_E2E_SPEC=${options.envSpec ?? ""}`,
      `argv=${JSON.stringify(options.argv)}`,
    ].join("\n"),
  );
}

function collectCandidateSpecFiles(baseDir: string, specs: string[]): string[] {
  const files = new Set<string>();
  for (const spec of specs) {
    const root = resolveSpecSearchRoot(baseDir, spec);
    if (!existsSync(root)) {
      continue;
    }
    const stat = statSync(root);
    if (stat.isFile()) {
      if (isSpecFile(root)) {
        files.add(normalizeAbsolutePath(root));
      }
      continue;
    }
    for (const file of walkSpecFiles(root)) {
      files.add(file);
    }
  }
  return [...files].sort();
}

function resolveSpecSearchRoot(baseDir: string, pattern: string): string {
  const normalized = normalizePattern(baseDir, pattern);
  const firstGlobIndex = normalized.search(/[*?[{]/u);
  if (firstGlobIndex < 0) {
    return normalizeAbsolutePath(normalized);
  }
  const slashBeforeGlob = normalized.lastIndexOf("/", firstGlobIndex);
  return normalizeAbsolutePath(slashBeforeGlob < 0 ? baseDir : normalized.slice(0, slashBeforeGlob));
}

function* walkSpecFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".e2e-artifacts") {
      continue;
    }
    const path = normalizeAbsolutePath(resolve(root, entry.name));
    if (entry.isDirectory()) {
      yield* walkSpecFiles(path);
      continue;
    }
    if (entry.isFile() && isSpecFile(path)) {
      yield path;
    }
  }
}

function createSpecMatcher(baseDir: string, pattern: string): (file: string) => boolean {
  const normalizedPattern = normalizePattern(baseDir, pattern);
  if (!hasGlob(normalizedPattern)) {
    const absolute = normalizeAbsolutePath(normalizedPattern);
    return (file) => normalizeAbsolutePath(file) === absolute;
  }

  const regex = globPatternToRegExp(normalizedPattern);
  return (file) => regex.test(normalizeAbsolutePath(file));
}

function normalizePattern(baseDir: string, pattern: string): string {
  const trimmed = pattern.trim();
  return normalizeAbsolutePath(isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed));
}

function normalizeAbsolutePath(path: string): string {
  return toSlash(resolve(path));
}

function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

function isSpecFile(path: string): boolean {
  return path.endsWith(".test.ts");
}

function hasGlob(pattern: string): boolean {
  return /[*?[{]/u.test(pattern);
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegExp(char: string): string {
  return /[\\^$+?.()|[\]{}]/u.test(char) ? `\\${char}` : char;
}

/**
 * 桌面 E2E 只支持串行 worker。
 * Bugfix（评审 CR-01，2026-11-18）：worker 共用 .e2e-home（beforeSession 递归删除）与 launcher 持有的
 * 账号 mock 状态（case-mode、Team 闲时灰度等）。并行时后写入的 worker 会改掉先启动 worker 随后读到的
 * 配置，所以在调度前拒绝其他取值，不能运行中才出现交错。要支持并行，须先为每个 worker 隔离 home 与 mock。
 */
export function resolveE2EMaxInstances(env: Record<string, string | undefined>): number {
  const raw = env.ZCODE_E2E_MAX_INSTANCES?.trim();
  if (!raw || raw === "1") return 1;
  throw new Error(
    `ZCODE_E2E_MAX_INSTANCES=${raw} is not supported: desktop E2E workers share .e2e-home and the launcher-owned account mock, so they must run serially (use 1 or leave it unset).`,
  );
}
