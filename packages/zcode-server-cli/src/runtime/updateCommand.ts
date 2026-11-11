import { updatePreparationResultSchema } from "../contracts.js";
import { isControlEndpointUnavailable, requestControl } from "../ipc/controlClient.js";
import { createServiceLogger } from "@zcode/services/node";
import { isAbsolute } from "node:path";
import { currentServerTarget } from "./manifest.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { ReleaseManager } from "./releaseManager.js";
import { prepareOnlineUpdate } from "./updatePreparation.js";
import {
  compareCompatibilityVersions,
  SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  type SourceServerInstallProgress,
} from "@zcode/shared";
import { ControlRequestError } from "../ipc/controlError.js";
import type { ReleaseManifest } from "../contracts.js";

interface UpdateCliIO {
  stdout?: { write(value: string): void };
}

export interface UpdateDaemonHandoff {
  converge(input: {
    layout: ServerLayout;
    previous: ReleaseManifest | null;
    target: ReleaseManifest;
  }): Promise<void>;
}

function readSingleOption(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function stdout(io: UpdateCliIO, value: unknown): void {
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function isRunningTaskUpdateGuard(error: unknown): boolean {
  return (
    (error instanceof ControlRequestError &&
      error.code === SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) ||
    (error instanceof Error && error.message.includes("Running tasks require --force for update"))
  );
}

function createRunningTaskUpdateGuard(): ControlRequestError {
  return new ControlRequestError(
    SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
    "Running tasks require --force for update",
    false,
  );
}

/** 返回被替换的版本；无法证明方向（首装或非 semver 历史版本）时不视为降级。 */
function readDowngradedFromVersion(
  previous: ReleaseManifest | null,
  target: ReleaseManifest,
): string | undefined {
  if (!previous) return undefined;
  try {
    return compareCompatibilityVersions(target.version, previous.version) < 0
      ? previous.version
      : undefined;
  } catch {
    return undefined;
  }
}

const log = createServiceLogger("server-update-command");

async function pruneReleasesBestEffort(
  layout: ServerLayout,
  previous: ReleaseManifest | null,
): Promise<void> {
  try {
    await new ReleaseManager(layout).pruneReleases(previous);
  } catch (error: unknown) {
    // 回收是更新成功后的收尾；读取指针或解析目录失败只记录，不改变已成功的更新结果。
    log.warn("failed to prune inactive releases after update", error);
  }
}

export async function runLocalArchiveUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<unknown>,
  updateDaemonHandoff?: UpdateDaemonHandoff,
): Promise<number> {
  const archivePath = readSingleOption(argv, "--from-archive");
  if (!archivePath) throw new Error("--from-archive requires a path");
  if (!isAbsolute(archivePath)) throw new Error("--from-archive must be an absolute path");
  const force = argv.includes("--force");
  const onProgress = (phase: SourceServerInstallProgress["phase"]): void => {
    if (json && argv.includes("--progress")) {
      stdout(io, {
        type: "source-server-install-progress",
        phase,
      } satisfies SourceServerInstallProgress);
    }
  };
  let daemonOnline = false;
  if (!force) {
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      daemonOnline = true;
      if (result.status === "blocked") throw createRunningTaskUpdateGuard();
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  } else {
    try {
      await requestControl(layout.controlEndpoint, { command: "status" });
      daemonOnline = true;
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  }
  const releaseManager = new ReleaseManager(layout);
  const previous = await releaseManager.readCurrent();
  const prepared = await new ReleaseInstaller(layout).installArchive({
    archivePath,
    target: currentServerTarget(),
    onProgress,
  });
  // 降级只能由用户显式确认。方向在持有 update lock 后按真实 current 判定：Desktop 的
  // probe 结果可能已过时（其他设备刚升级远端），不能让普通更新把更新的远端静默降级。
  const downgradedFrom = readDowngradedFromVersion(previous, prepared);
  if (downgradedFrom && !argv.includes("--allow-downgrade")) {
    await releaseManager.removePending();
    throw new ControlRequestError(
      SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE,
      `Downgrading ZCode Server from ${downgradedFrom} to ${prepared.version} requires --allow-downgrade`,
      false,
    );
  }
  if (downgradedFrom) await releaseManager.markDowngrade(prepared, downgradedFrom);
  if (daemonOnline) {
    if (!force) {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") throw createRunningTaskUpdateGuard();
    }
    onProgress("restart");
    await applyUpdate();
    await updateDaemonHandoff?.converge({ layout, previous, target: prepared });
    await pruneReleasesBestEffort(layout, previous);
    const result = { applied: true, installed: false, version: prepared.version };
    if (json) stdout(io, result);
    else stdout(io, `ZCode Server ${prepared.version} updated`);
    return 0;
  }
  await releaseManager.applyPendingWithTransaction(previous);
  await releaseManager.completeUpdate();
  await pruneReleasesBestEffort(layout, previous);
  const result = { applied: true, installed: previous === null, version: prepared.version };
  if (json) stdout(io, result);
  else stdout(io, `ZCode Server ${prepared.version} ${previous ? "updated" : "installed"}`);
  return 0;
}

async function discardPreparedUpdateBestEffort(
  discard: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!discard) return;
  try {
    await discard();
  } catch (error: unknown) {
    // 准备产物清理属于非关键收尾；直接 await discard 会让清理失败覆盖
    // running-task guard 或 control socket 的原始错误，导致用户看到错误的排障方向。
    log.warn("failed to discard prepared update after command failure", error);
  }
}

export async function runUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<unknown>,
  updateDaemonHandoff?: UpdateDaemonHandoff,
): Promise<number> {
  const previous = await new ReleaseManager(layout).readCurrent();
  const force = argv.includes("--force");
  let discardPreparedUpdate: (() => Promise<void>) | undefined;
  if (!force) {
    // prepareOnlineUpdate 会下载、解压并写入 pending release；旧流程在准备完成后
    // 才由 apply-update 检查运行任务，导致 guard 拒绝时仍留下网络和磁盘副作用。先检查已知的
    // 运行任务，并在准备完成后再次检查；最终 apply-update guard 仍覆盖最后一小段竞态。
    const result = updatePreparationResultSchema.parse(
      await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
    );
    if (result.status === "blocked") throw createRunningTaskUpdateGuard();
  }
  const preparation = await prepareOnlineUpdate(layout);
  discardPreparedUpdate = "discard" in preparation ? preparation.discard : undefined;
  if (preparation.status === "up-to-date") {
    if (json) stdout(io, preparation);
    else stdout(io, `ZCode Server ${preparation.version} is already up to date`);
    return 0;
  }
  if (!force && discardPreparedUpdate) {
    const discard = discardPreparedUpdate;
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") {
        await discardPreparedUpdateBestEffort(discard);
        discardPreparedUpdate = undefined;
        throw createRunningTaskUpdateGuard();
      }
    } catch (error: unknown) {
      if (isRunningTaskUpdateGuard(error)) throw error;
      await discardPreparedUpdateBestEffort(discard);
      discardPreparedUpdate = undefined;
      throw error;
    }
  }
  try {
    await applyUpdate();
    discardPreparedUpdate = undefined;
    const target = await new ReleaseManager(layout).readCurrent();
    if (!target) throw new Error("Applied release is missing from current.json");
    await updateDaemonHandoff?.converge({ layout, previous, target });
    await pruneReleasesBestEffort(layout, previous);
    const result = { applied: true, version: target.version };
    if (json) stdout(io, result);
    else stdout(io, `ZCode Server ${target.version} updated`);
    return 0;
  } catch (error: unknown) {
    if (isRunningTaskUpdateGuard(error)) {
      await discardPreparedUpdateBestEffort(discardPreparedUpdate);
      discardPreparedUpdate = undefined;
    }
    throw error;
  }
}
