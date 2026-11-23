import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
} from "@zcode/shared";

/**
 * 远程资源就绪判断的范围。
 * - `all`：默认（服务器队列、本机），descriptor 须登记四个平台且对应 archive 都存在，缺失时调用全平台入口。
 * - `linux`：CI 与本机 Docker runner 声明「本次只需要 Linux 目标」，descriptor 须登记两个 Linux 目标
 *   且对应 archive 存在，缺失时调用 `ZCODE_ENV=test pnpm prepare:remote-assets:linux`，永不调用全平台入口。
 */
export type SshRemoteReleaseScope = "all" | "linux";

/** 本机 Docker runner 向 wdio 声明范围的环境变量。 */
export const SSH_REMOTE_RELEASE_SCOPE_ENV = "ZCODE_E2E_REMOTE_RELEASE_SCOPE";

export interface SshRemoteReleasePrepareRequest {
  /** 根 package.json 的脚本名。 */
  script: "prepare:remote-assets" | "prepare:remote-assets:linux";
  /** 叠加到子进程环境的变量。 */
  env: Record<string, string>;
  /** 追加给脚本的参数；只有本轮已真实构建 agent 时才含 `--skip-agent-build`。 */
  args: string[];
}

export interface EnsureSshRemoteReleaseAssetsOptions {
  /**
   * SSH remote runtime 使用的 release 目录（packages/desktop/mock-cdn/releases/<version>）。
   */
  releaseDir: string;
  /** 就绪判断范围，默认 `all`。 */
  scope?: SshRemoteReleaseScope;
  /** CI 安装包必须来自当前提交；本机 runner 由源码指纹管理时不传。 */
  buildRevision?: string;
  /**
   * 本轮 onPrepare 是否真实构建了 agent bundle。只有为 true 时打包器才跳过首个 target 的 agent 构建；
   * 只检查过入口存在（ZCODE_E2E_SKIP_AGENT_BUILD=1）不算，那时工作区里的 bundle 可能来自旧构建。
   */
  agentBundleBuiltThisRun?: boolean;
  /**
   * 执行根 package.json 的 prepare 脚本（→ @zcode/server-cli stage:remote-assets）的回调，
   * 由 wdio.conf.ts 注入以复用 runPnpmWorkspaceCommand（处理 CI HOME / NODE_OPTION /
   * Windows shell）。脚本名与环境由本 helper 按范围决定。
   */
  prepareReleaseAssets: (request: SshRemoteReleasePrepareRequest) => void | Promise<void>;
  /** 文件存在性检查，默认 fs/promises access；测试注入 fake 实现。 */
  exists?: (path: string) => boolean | Promise<boolean>;
  /** 读取 descriptor 文本，默认 fs/promises readFile；测试注入 fake 实现。 */
  readText?: (path: string) => Promise<string>;
  /** 构建回执写入，仅在产物全部就绪后记录提交。 */
  writeText?: (path: string, text: string) => Promise<void>;
  /** 日志输出，默认 console.log；测试注入 spy。 */
  onInfo?: (message: string) => void;
}

const LINUX_RELEASE_TARGETS = SOURCE_SERVER_RELEASE_TARGETS.filter((target) =>
  target.startsWith("linux-"),
);

const PREPARE_REQUESTS: Record<
  SshRemoteReleaseScope,
  Omit<SshRemoteReleasePrepareRequest, "args">
> = {
  all: { script: "prepare:remote-assets", env: {} },
  // E2E 桌面端固定 ZCODE_ENV=test；远端 server 在构建时编译 ZCODE_ENV，两端必须一致。
  linux: { script: "prepare:remote-assets:linux", env: { ZCODE_ENV: "test" } },
};

export function resolveSshRemoteReleaseScope(env: NodeJS.ProcessEnv): SshRemoteReleaseScope {
  const value = env[SSH_REMOTE_RELEASE_SCOPE_ENV]?.trim();
  if (!value) return "all";
  if (value === "linux") return "linux";
  throw new Error(`[e2e] ${SSH_REMOTE_RELEASE_SCOPE_ENV} 只允许 linux 或留空，收到 ${value}`);
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const RELEASE_TARGETS_BY_SCOPE: Record<SshRemoteReleaseScope, readonly string[]> = {
  all: SOURCE_SERVER_RELEASE_TARGETS,
  linux: LINUX_RELEASE_TARGETS,
};

// Bug 根因：release 产物已切换为 descriptor + archive 布局（stage:remote-assets →
// remoteAssetRelease.ts collectSourceServerRemoteReleaseArchives），旧的 manifest-<platform>.json
// 不再产出；继续用它做哨兵会让新布局永远判“不完整”。这里直接复用 @zcode/shared 的 target 与
// descriptor 文件名常量，避免再次漂移。
// Bug 根因（!3777 评审 CR-02）：全平台判断原来只看文件存在。Linux 范围重建只替换两个 Linux
// 目标、descriptor 只登记它们，旧 darwin archive 仍留在目录里；切回 all 时会被当成完整而复用，
// 远端 darwin 安装按 descriptor 查不到目标，在连接阶段失败。两种范围统一按 descriptor 判断：
// 范围内每个 target 都要在 descriptor 中登记，且对应 archive 存在。
async function listMissingReleaseAssets(
  releaseDir: string,
  targets: readonly string[],
  exists: (path: string) => boolean | Promise<boolean>,
  readText: (path: string) => Promise<string>,
): Promise<string[]> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  let listed: Set<string>;
  try {
    const parsed = sourceServerReleaseDescriptorSchema.parse(
      JSON.parse(await readText(descriptorPath)),
    );
    listed = new Set(parsed.archives.map((archive) => archive.target));
  } catch {
    return [SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME];
  }
  const missing: string[] = [];
  for (const target of targets) {
    const fileName = `zcode-server-${target}.tar.gz`;
    if (!listed.has(target)) missing.push(`${target}（descriptor 未列出）`);
    else if (!(await exists(join(releaseDir, fileName)))) missing.push(fileName);
  }
  return missing;
}

/**
 * Bug 根因：CI 只有 build:remote:assets job 会产出 mock-cdn/releases/<version>，且跑在
 * 通用 macos runner 的工作槽位；conversation e2e 跑在专用 e2e runner，mock-cdn 工作区
 * 持久化目录互不相通，且目录按版本号命名——每次版本 bump 后专用 runner 必然缺新版本
 * release，onPrepare 直接 fatal（2026-09-11 MR 2606 的 3.12.0 缺目录即此问题）。
 *
 * 改为：SSH 环境就绪但产物不完整时先自动执行 prepare；CI 还须检查当前提交回执，
 * 同版本不同源码不能复用。prepare 后仍不完整才 fail-closed 抛错。
 *
 * 幂等判据用 descriptor + target archive 而不是目录存在性：
 * beginSourceServerRemoteReleaseGeneration 在 generation 开始时先删除 descriptor、archive
 * 全部收齐后才原子写回，因此 descriptor 存在即代表本代际完整；prepare 中途取消/超时留下的
 * 半成品目录会跨 job 持久化（目录按版本命名），旧“目录存在即跳过”判据会让后续同版本运行
 * 永远跳过自愈，e2e 以远端缺 server bundle 等远离根因的症状失败，需人工删目录才能恢复。
 *
 * @returns 是否执行了自动 prepare（false 表示 release 已完整、直接复用）。
 */
export async function ensureSshRemoteReleaseAssets(
  options: EnsureSshRemoteReleaseAssetsOptions,
): Promise<boolean> {
  const { prepareReleaseAssets, releaseDir } = options;
  const scope = options.scope ?? "all";
  const exists = options.exists ?? defaultExists;
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const writeText =
    options.writeText ?? ((path: string, text: string) => writeFile(path, text, "utf8"));
  const buildRevision = options.buildRevision?.trim();
  const receiptPath = join(releaseDir, ".e2e-build-revision");
  const onInfo = options.onInfo ?? ((message: string) => console.log(message));
  const listMissing = () =>
    listMissingReleaseAssets(releaseDir, RELEASE_TARGETS_BY_SCOPE[scope], exists, readText);
  // Bug 根因（!3777 评审 CR-01 第二轮）：打包器过去在 E2E 中总是跳过 agent 构建。跳过 agent 构建的
  // 运行（Windows 分片 child 等）只检查了入口存在，旧 bundle 会被打进 archive 并写上当前提交回执，
  // 之后同提交运行一直复用错版本的包。只有本轮真实构建过 agent 才复用；否则首个 target 照常重建。
  const request: SshRemoteReleasePrepareRequest = {
    ...PREPARE_REQUESTS[scope],
    args: options.agentBundleBuiltThisRun === true ? ["--skip-agent-build"] : [],
  };

  const missing = await listMissing();
  // CI 跨 job 保留同版本安装包；只看文件齐全会继续上传修复前缺执行位的旧包。
  const revisionMatches =
    !buildRevision || (await readText(receiptPath).catch(() => "")).trim() === buildRevision;
  if (missing.length === 0 && revisionMatches) {
    return false;
  }

  onInfo(
    `[e2e] SSH remote assets missing, incomplete or stale (scope=${scope}): ${releaseDir} ` +
      `(missing: ${missing.join(", ")}; expected revision: ${buildRevision ?? "local"}); auto-running pnpm ${request.script}`,
  );
  // 先作废旧回执，避免 prepare 中途失败却留下齐全的旧文件，被下次运行误认为本次构建。
  if (buildRevision && (await exists(receiptPath))) await writeText(receiptPath, "");
  await prepareReleaseAssets(request);

  const stillMissing = await listMissing();
  if (stillMissing.length > 0) {
    throw new Error(
      `[e2e] ${request.script} completed but release still incomplete: ${releaseDir} ` +
        `(missing: ${stillMissing.join(", ")})`,
    );
  }

  if (buildRevision) await writeText(receiptPath, buildRevision);

  return true;
}
