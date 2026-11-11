/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
import { userInfo } from "node:os";

/** Server 展示系统用户；容器的数字 UID 无需在 passwd 中有名称条目。 */
export function resolveServerOsUser(): string {
  try {
    return userInfo().username;
  } catch (error) {
    // Docker 的数字 UID 可能没有 passwd 条目，userInfo 会抛错并阻断 Core ready。
    // 此字段只用于展示；用有效 UID 保持 userInfo 的用户语义，其他系统错误仍由调用方处理。
    if (
      error instanceof Error &&
      "info" in error &&
      typeof error.info === "object" &&
      error.info !== null &&
      "code" in error.info &&
      error.info.code === "ENOENT" &&
      "syscall" in error.info &&
      error.info.syscall === "uv_os_get_passwd" &&
      typeof process.geteuid === "function"
    ) {
      return `uid:${process.geteuid()}`;
    }
    throw error;
  }
}

export { acquireFileLock } from "./node/atomicFileLock.js";
export { createNodeNetworkCapture, withoutNetworkCapture } from "./node/networkCapture.js";
export {
  GEN_UI_OUTPUT_ROOT_ENV,
  GEN_UI_OUTPUT_DIRECTORY,
  getGenUiOutputDirectory,
} from "./node/genUiPaths.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  withCredentialFileRead,
  withCredentialFileMutation,
  captureCredentialFileGuard,
  type CredentialFileGuard,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
