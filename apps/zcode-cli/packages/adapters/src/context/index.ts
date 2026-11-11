// ============================================================
// Node Context Source Adapter
// ============================================================

import { readFile, stat } from "node:fs/promises";
import { arch, homedir, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED, formatLocalIsoDate } from "@zcode/contracts";
import type {
  ContextSourceDiagnostic,
  ContextSourcePort,
  ContextSourceRequest,
  ContextSourceResolveOptions,
  ContextSourceSnapshot,
  EnvInfo,
  GitContext,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";
import { findGitRoot, resolveGitSnapshot, resolveIsGitRepository } from "./git-snapshot.js";

const DEFAULT_PRIORITY_FILES = ["AGENTS.md"];
const DEFAULT_MAX_BYTES = 100 * 1024;

export interface NodeContextSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
}

export class NodeContextSourceAdapter implements ContextSourcePort {
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: NodeContextSourceAdapterOptions = {}) {
    this.env = options.env ?? process.env;
  }

  async resolveContextSources(request: ContextSourceRequest): Promise<ContextSourceSnapshot> {
    const workingDirectory = resolve(request.workingDirectory);
    const diagnostics: ContextSourceDiagnostic[] = [];
    const projectRoot = await findProjectRoot(workingDirectory);

    const envInfo =
      request.envInfo ??
      (await this.detectEnvInfo(
        workingDirectory,
        request.effectiveShellDisplayName,
        await resolveIsGitRepository(workingDirectory, projectRoot),
      ));
    const userInstructions = request.userInstructions
      ? await resolveUserInstructions(
          {
            ...request.userInstructions,
            workingDirectory: request.userInstructions.workingDirectory ?? workingDirectory,
            projectRoot: request.userInstructions.projectRoot ?? projectRoot ?? undefined,
          },
          diagnostics,
          this.env,
        )
      : undefined;
    const projectContext =
      request.projectContext ?? (projectRoot ? await detectProjectContext(projectRoot) : undefined);

    return {
      workingDirectory,
      envInfo,
      currentDate: request.currentDate ?? formatLocalIsoDate(new Date()),
      userInstructions,
      projectContext,
      diagnostics,
    };
  }

  async resolveEnvironment(
    request: Pick<ContextSourceRequest, "workingDirectory" | "effectiveShellDisplayName">,
  ): Promise<EnvInfo> {
    const workingDirectory = resolve(request.workingDirectory);
    return {
      ...this.hostEnvironment(workingDirectory, request.effectiveShellDisplayName),
      isGitRepository: await resolveIsGitRepository(workingDirectory),
    };
  }

  async resolveGitContext(
    request: Pick<ContextSourceRequest, "workingDirectory">,
    options?: ContextSourceResolveOptions,
  ): Promise<GitContext> {
    return resolveGitSnapshot(resolve(request.workingDirectory), options?.signal);
  }

  private hostEnvironment(workingDirectory: string, effectiveShellDisplayName?: string): EnvInfo {
    const shellPath = this.env.SHELL ?? this.env.ComSpec ?? this.env.COMSPEC ?? "";
    const shell = effectiveShellDisplayName ?? (shellPath ? basename(shellPath) : "unknown");
    return {
      cwd: workingDirectory,
      platform: process.platform,
      shell,
      osVersion: `${process.platform} ${release()} ${arch()}`,
      nodeVersion: process.version,
    };
  }

  private async detectEnvInfo(
    workingDirectory: string,
    effectiveShellDisplayName: string | undefined,
    isGitRepository: boolean,
  ): Promise<EnvInfo> {
    // 修复原因：findProjectRoot 已经从同一个目录向上查找过 `.git`，快照里再查一遍，
    // 每次 context 初始化都多做一轮 stat。是否在仓库由调用方先判断好传入。
    const git = await resolveGitSnapshot(workingDirectory, undefined, isGitRepository);
    return { ...this.hostEnvironment(workingDirectory, effectiveShellDisplayName), ...git };
  }
}

export function createNodeContextSourceAdapter(
  options: NodeContextSourceAdapterOptions = {},
): NodeContextSourceAdapter {
  return new NodeContextSourceAdapter(options);
}

async function resolveUserInstructions(
  options: UserInstructionsOptions,
  diagnostics: ContextSourceDiagnostic[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedUserInstructions | undefined> {
  const priorityFiles = options.priorityFiles ?? DEFAULT_PRIORITY_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const projectRoot = options.projectRoot ?? (await findProjectRoot(options.workingDirectory));

  const defaultUserInstructionFile = await findDefaultUserInstructionFile(priorityFiles, env);
  const workspaceInstructionFile = await findInstructionFile(
    options.workingDirectory,
    projectRoot,
    priorityFiles,
  );
  const candidates = dedupeInstructionFileCandidates([
    defaultUserInstructionFile
      ? { ...defaultUserInstructionFile, scope: "user" as const }
      : undefined,
    workspaceInstructionFile
      ? { ...workspaceInstructionFile, scope: "workspace" as const }
      : undefined,
  ]);
  const sources: ResolvedUserInstructionSource[] = [];

  for (const candidate of candidates) {
    const source = await readInstructionSource(candidate, maxBytes, diagnostics);
    if (source) {
      sources.push(source);
    }
  }

  if (sources.length === 0) return undefined;

  return mergeInstructionSources(sources);
}

async function readFirstTextBytes(path: string, maxBytes: number): Promise<string> {
  const content = await readFile(path);
  return content.subarray(0, maxBytes).toString("utf8");
}

type InstructionFileCandidate = {
  filePath: string;
  fileName: string;
  scope: ResolvedUserInstructionSource["scope"];
};

function dedupeInstructionFileCandidates(
  candidates: Array<InstructionFileCandidate | undefined>,
): InstructionFileCandidate[] {
  const seen = new Set<string>();
  const deduped: InstructionFileCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = resolve(candidate.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

async function readInstructionSource(
  candidate: InstructionFileCandidate,
  maxBytes: number,
  diagnostics: ContextSourceDiagnostic[],
): Promise<ResolvedUserInstructionSource | undefined> {
  try {
    const info = await stat(candidate.filePath);
    const bytesToRead = Math.min(info.size, maxBytes);
    const content = await readFirstTextBytes(candidate.filePath, bytesToRead);
    return {
      scope: candidate.scope,
      filePath: candidate.filePath,
      fileName: candidate.fileName,
      content,
      bytesRead: Buffer.byteLength(content),
      sizeBytes: info.size,
      truncated: info.size > maxBytes,
    };
  } catch (error) {
    // 修复原因：读取出错原来一律当成文件不存在，调用方把权限、占用等错误宣告成文件已删除。
    // 只有确实不存在才算没有这个文件；其他错误报诊断，调用方沿用已宣告的内容。
    if (isMissingFileError(error)) return undefined;
    diagnostics.push({
      code: CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED,
      message: error instanceof Error ? error.message : "Failed to read user instructions",
      path: candidate.filePath,
    });
    return undefined;
  }
}

function mergeInstructionSources(
  sources: ResolvedUserInstructionSource[],
): ResolvedUserInstructions {
  const primary = sources.find((source) => source.scope === "workspace") ?? sources[0];
  const content = sources.map((source) => source.content).join("\n\n");

  return {
    filePath: primary.filePath,
    fileName: primary.fileName,
    content,
    bytesRead: sources.reduce((sum, source) => sum + source.bytesRead, 0),
    sizeBytes: sources.reduce((sum, source) => sum + source.sizeBytes, 0),
    truncated: sources.some((source) => source.truncated),
    sources,
  };
}

async function findInstructionFile(
  startDir: string,
  projectRoot: string | null,
  priorityFiles: string[],
): Promise<{ filePath: string; fileName: string } | undefined> {
  let current = resolve(startDir);

  while (true) {
    for (const fileName of priorityFiles) {
      const filePath = join(current, fileName);
      if (await isInstructionFileCandidate(filePath)) {
        return { filePath, fileName };
      }
    }

    if (current === projectRoot || current === dirname(current)) {
      break;
    }

    current = dirname(current);
  }

  return undefined;
}

async function findDefaultUserInstructionFile(
  priorityFiles: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ filePath: string; fileName: string } | undefined> {
  if (!priorityFiles.includes("AGENTS.md")) {
    return undefined;
  }

  const filePath = join(resolveUserHomeDir(env), ".zcode", "AGENTS.md");
  if (await isInstructionFileCandidate(filePath)) {
    return { filePath, fileName: "AGENTS.md" };
  }

  return undefined;
}

function resolveUserHomeDir(env: NodeJS.ProcessEnv): string {
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

async function detectProjectContext(projectRoot: string): Promise<ProjectContext> {
  let type: ProjectType = "unknown";
  let packageManager: PackageManager | undefined;
  let scripts: Record<string, string> | undefined;
  const buildFiles: string[] = [];

  const packageJsonPath = join(projectRoot, "package.json");
  if (await isFile(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        scripts?: unknown;
      };
      type = "node";
      if (pkg.scripts && typeof pkg.scripts === "object") {
        scripts = pkg.scripts as Record<string, string>;
      }
    } catch {
      type = "node";
    }
  }

  if (type === "unknown") {
    const pythonIndicators = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"];
    for (const file of pythonIndicators) {
      if (await isFile(join(projectRoot, file))) {
        type = "python";
        break;
      }
    }
  }

  if (type === "unknown" && (await isFile(join(projectRoot, "Cargo.toml")))) {
    type = "rust";
  }
  if (type === "unknown" && (await isFile(join(projectRoot, "go.mod")))) {
    type = "go";
  }
  if (type === "unknown") {
    for (const file of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
      if (await isFile(join(projectRoot, file))) {
        type = "java";
        break;
      }
    }
  }

  if (await isFile(join(projectRoot, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (await isFile(join(projectRoot, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (await isFile(join(projectRoot, "bun.lockb"))) {
    packageManager = "bun";
  } else if (await isFile(join(projectRoot, "package-lock.json"))) {
    packageManager = "npm";
  }

  for (const file of ["Makefile", "docker-compose.yml", "docker-compose.yaml", "Dockerfile"]) {
    if (await isFile(join(projectRoot, file))) {
      buildFiles.push(file);
    }
  }

  return {
    type,
    packageManager,
    scripts,
    buildFiles: buildFiles.length > 0 ? buildFiles : undefined,
  };
}

// 项目根：从打开时的路径向上最近的含 .git 的目录（AGENTS.md 查找、Project Context），
// 指令文件路径保持用户打开的写法。是否在仓库按真实路径判断，见 resolveIsGitRepository。
async function findProjectRoot(startDir: string): Promise<string | null> {
  return (await findGitRoot(resolve(startDir))) ?? null;
}

// 路径上没有这个文件的错误码：不存在、是目录、路径中间有一段不是目录。
const MISSING_FILE_ERROR_CODES = new Set(["ENOENT", "EISDIR", "ENOTDIR"]);

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && MISSING_FILE_ERROR_CODES.has(code);
}

/**
 * 指令文件候选：是普通文件，或检查时出现"不存在"以外的错误。
 * 修复原因：检查出错（如目录没有访问权限）原来当成不存在，查找继续向上，可能换成父目录的文件；
 * 现在停在这个候选，由读取步骤报诊断。
 */
async function isInstructionFileCandidate(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    return !isMissingFileError(error);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
