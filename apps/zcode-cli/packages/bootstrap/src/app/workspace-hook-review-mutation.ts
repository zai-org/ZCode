import { basename, resolve } from "node:path";
import {
  createWorkspaceHookBundleSnapshot,
  type WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import { digestSummary, workspaceIdentitySummary } from "@zcode/core";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  readWorkspaceHookScriptStates,
  type WorkspaceHookRuntimeRoot,
} from "@zcode/shared/workspace-hook-discovery";
import {
  WorkspaceHookMutationError,
  writeWorkspaceHookConfiguredToggle,
} from "@zcode/shared/workspace-hook-mutation";
import type { WorkspaceHookReviewMutationPort } from "./workspace-hook-review-controller.js";

export interface WorkspaceHookReviewMutationPortOptions {
  workingDirectory: string;
  workspaceIdentity: string;
  projectConfigPath?: string;
  runtimeRoot: WorkspaceHookRuntimeRoot;
}

const workspaceMutationTails = new Map<string, Promise<void>>();

export function createWorkspaceHookReviewMutationPort(
  options: WorkspaceHookReviewMutationPortOptions,
): WorkspaceHookReviewMutationPort {
  const workingDirectory = resolve(options.workingDirectory);
  const editableConfigPath = resolve(workingDirectory, ".zcode", "config.json");
  const lockKey = editableConfigPath;

  return {
    toggle(input, onWriteCommitted) {
      return withWorkspaceMutationLock(lockKey, async () => {
        const current = await rebuildSnapshot(options);
        // 这三种失败必须区分：共用 workspace_hooks_snapshot_mismatch
        // 会让用户无法区分「换了 workspace」「配置真的变了」「配置读不出来」。
        if (current.workspaceIdentity !== input.snapshot.workspaceIdentity) {
          throw new WorkspaceHookMutationError(
            "workspace_hooks_snapshot_mismatch",
            // 消息会经 controller 进入 telemetry.errorMessage，故此处即脱敏：
            // identity 本身是绝对路径，禁止上报完整 workspace path。
            `Workspace Hook identity changed after review (expected ${workspaceIdentitySummary(
              input.snapshot.workspaceIdentity,
            )}, got ${workspaceIdentitySummary(current.workspaceIdentity)})`,
          );
        }
        if (current.bundleDigest !== input.snapshot.bundleDigest) {
          throw new WorkspaceHookMutationError(
            "workspace_hooks_bundle_changed",
            `Workspace Hook bundle changed after review (expected ${digestSummary(
              input.snapshot.bundleDigest,
            )}, got ${digestSummary(current.bundleDigest)})`,
          );
        }

        await writeWorkspaceHookConfiguredToggle({
          configPath: editableConfigPath,
          snapshot: current,
          reviewItemId: input.reviewItemId,
          enabled: input.enabled,
        });
        await onWriteCommitted();
        return rebuildSnapshot(options);
      });
    },
  };
}

async function rebuildSnapshot(
  options: WorkspaceHookReviewMutationPortOptions,
): Promise<WorkspaceHookBundleSnapshot> {
  const discovery = await readWorkspaceHookProjectSources({
    workingDirectory: options.workingDirectory,
    ...(options.projectConfigPath ? { explicitProjectConfigPath: options.projectConfigPath } : {}),
  });
  if (discovery.errors.length > 0) {
    // 只报文件名，不报绝对路径（「不记录 source path」）；
    // 完整路径与原始错误保留在 cause 里，走 logger 的 debug 通道而不进 telemetry。
    const failed = discovery.errors[0]?.path;
    throw new WorkspaceHookMutationError(
      "workspace_hooks_config_unreadable",
      `Workspace Hook config could not be read: ${failed ? basename(failed) : "unknown"}`,
      { cause: discovery.errors[0]?.error },
    );
  }
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: options.workspaceIdentity,
    workspacePath: options.workingDirectory,
    sources: discovery.sources,
    runtimeRoot: options.runtimeRoot,
    // 重建后的 snapshot 会替换 Runtime 当前 snapshot，必须与 Runtime 入口同样绑定脚本内容（D24）。
    scriptStates: await readWorkspaceHookScriptStates({
      workspacePath: options.workingDirectory,
      sources: discovery.sources,
    }),
  });
  if (!snapshot) {
    throw new WorkspaceHookMutationError(
      "workspace_hooks_snapshot_mismatch",
      "Workspace Hook bundle no longer exists",
    );
  }
  return createWorkspaceHookBundleSnapshot(snapshot);
}

async function withWorkspaceMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  workspaceMutationTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceMutationTails.get(key) === tail) workspaceMutationTails.delete(key);
  }
}
