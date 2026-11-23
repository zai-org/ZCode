import { createHash } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import {
  WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
  WORKSPACE_HOOK_EVENT_NAMES,
  identifyWorkspaceHookScriptPath,
  resolveWorkspaceHookConfiguredGates,
  resolveWorkspaceHookTimeoutMs,
  workspaceHookReviewItemId,
  type WorkspaceHookConfigFileKind,
  type WorkspaceHookDefinition,
  type WorkspaceHookEventName,
  type WorkspaceHookRuntimeRoot,
  type WorkspaceHookScriptEntry,
  type WorkspaceHookScriptState,
  type WorkspaceHookSourceInput,
} from "./workspace-hook-config.js";

export interface CanonicalWorkspaceHookEntryData {
  reviewItemId: string;
  event: WorkspaceHookEventName;
  matcherIndex: number;
  hookIndex: number;
  sourceFileIndex: number;
  sourceRelativePath: string;
  matcher: string | null;
  type: "command" | "process";
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  statusMessage?: string;
  /** 只在声明写成 `deny` 时在场：`allow` 与缺省同义，不进条目也不进摘要。 */
  onError?: "deny";
  /** 能识别的直接入口脚本（D24）；识别不到时缺省。 */
  scriptEntry?: WorkspaceHookScriptEntry;
  sourceRootEnabled: boolean;
  declarationEnabled: boolean;
  runtimeHooksEnabled: boolean;
  configuredEnabled: boolean;
  editable: boolean;
  declarationDigestAlgorithm: "sha256";
  hookDeclarationDigest: string;
}

export interface WorkspaceHookBundleSnapshotData {
  schemaVersion: typeof WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION;
  workspaceIdentity: string;
  discoveredAt: string;
  sourceFiles: Array<{
    canonicalPath: string;
    baseDir: string;
    discoveryOrder: number;
    configFileKind: WorkspaceHookConfigFileKind;
    explicitProjectConfig: boolean;
    editable: boolean;
    hooksRoot: {
      enabled?: boolean;
      timeoutMs?: number;
      maxOutputBytes?: number;
    };
  }>;
  hooks: CanonicalWorkspaceHookEntryData[];
  digestAlgorithm: "sha256";
  bundleDigest: string;
}

export function resolveWorkspaceHookEntries(input: {
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
  /** readWorkspaceHookScriptStates 的结果；缺省时可识别入口一律记为 unverifiable（fail closed）。 */
  scriptStates?: ReadonlyMap<string, WorkspaceHookScriptState>;
}): CanonicalWorkspaceHookEntryData[] {
  const entries: CanonicalWorkspaceHookEntryData[] = [];

  for (const [sourceFileIndex, source] of input.sources.entries()) {
    const sourceRelativePath = normalizeRelativeSourcePath(
      input.workspacePath,
      source.canonicalPath,
    );
    for (const event of WORKSPACE_HOOK_EVENT_NAMES) {
      for (const [matcherIndex, matcher] of (source.hooks.events?.[event] ?? []).entries()) {
        for (const [hookIndex, hook] of matcher.hooks.entries()) {
          const gates = resolveWorkspaceHookConfiguredGates({
            sourceEnabled: source.hooks.enabled,
            declarationEnabled: hook.enabled,
            runtimeHooksEnabled: input.runtimeRoot.enabled,
          });
          const resolvedTimeoutMs = resolveWorkspaceHookTimeoutMs(
            hook,
            input.runtimeRoot.timeoutMs,
          );
          const reviewItemId = workspaceHookReviewItemId(
            sourceFileIndex,
            event,
            matcherIndex,
            hookIndex,
          );
          const scriptPath = identifyWorkspaceHookScriptPath(hook);
          // 同步构建（如 createConfig）不读文件：记为 unverifiable，宁可阻断也不退回不含脚本的旧 digest。
          const scriptEntry =
            scriptPath === undefined
              ? undefined
              : {
                  path: scriptPath,
                  state: input.scriptStates?.get(reviewItemId) ?? { kind: "unverifiable" as const },
                };
          const common = {
            reviewItemId,
            event,
            matcherIndex,
            hookIndex,
            sourceFileIndex,
            sourceRelativePath,
            matcher: matcher.matcher ?? null,
            command: hook.command,
            resolvedTimeoutMs,
            resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
            ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
            ...(hook.onError === "deny" ? { onError: "deny" as const } : {}),
            ...(scriptEntry ? { scriptEntry } : {}),
            ...gates,
            editable: source.editable,
            declarationDigestAlgorithm: "sha256" as const,
            hookDeclarationDigest: createWorkspaceHookDeclarationDigest({
              sourceRelativePath,
              sourceDiscoveryOrder: source.discoveryOrder,
              event,
              matcher: matcher.matcher ?? null,
              matcherIndex,
              hookIndex,
              hook,
              defaultTimeoutMs: input.runtimeRoot.timeoutMs,
              resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
              ...(scriptEntry ? { scriptEntry } : {}),
            }),
          };

          entries.push(
            hook.type === "process"
              ? {
                  ...common,
                  type: "process",
                  ...(hook.args && hook.args.length > 0 ? { args: [...hook.args] } : {}),
                }
              : {
                  ...common,
                  type: "command",
                  ...(hook.async === true ? { async: true } : {}),
                  ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
                },
          );
        }
      }
    }
  }
  return entries;
}

export function buildWorkspaceHookBundleSnapshot(input: {
  workspaceIdentity: string;
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
  scriptStates?: ReadonlyMap<string, WorkspaceHookScriptState>;
  discoveredAt?: string;
}): WorkspaceHookBundleSnapshotData | undefined {
  const hooks = resolveWorkspaceHookEntries(input);
  if (hooks.length === 0) return undefined;

  const sourceFiles = input.sources.map((source) => ({
    canonicalPath: source.canonicalPath,
    baseDir: source.baseDir,
    discoveryOrder: source.discoveryOrder,
    configFileKind: source.configFileKind,
    explicitProjectConfig: source.explicitProjectConfig,
    editable: source.editable,
    hooksRoot: {
      ...(source.hooks.enabled !== undefined ? { enabled: source.hooks.enabled } : {}),
      ...(source.hooks.timeoutMs !== undefined ? { timeoutMs: source.hooks.timeoutMs } : {}),
      ...(source.hooks.maxOutputBytes !== undefined
        ? { maxOutputBytes: source.hooks.maxOutputBytes }
        : {}),
    },
  }));
  const bundlePayload = [
    "workspace-hook-bundle",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sources.map((source) => [
      normalizeRelativeSourcePath(input.workspacePath, source.canonicalPath),
      source.discoveryOrder,
      source.configFileKind,
      source.explicitProjectConfig,
      canonicalOptional(source.hooks.enabled),
      canonicalOptional(source.hooks.timeoutMs),
      canonicalOptional(source.hooks.maxOutputBytes),
    ]),
    hooks.map((hook) => [
      hook.hookDeclarationDigest,
      hook.sourceRootEnabled,
      hook.declarationEnabled,
      hook.runtimeHooksEnabled,
      hook.configuredEnabled,
    ]),
  ];

  return deepFreeze({
    schemaVersion: WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    workspaceIdentity: input.workspaceIdentity,
    discoveredAt: input.discoveredAt ?? new Date().toISOString(),
    sourceFiles,
    hooks,
    digestAlgorithm: "sha256",
    bundleDigest: sha256(bundlePayload),
  });
}

export function createWorkspaceHookDeclarationDigest(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  defaultTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  scriptEntry?: WorkspaceHookScriptEntry;
}): string {
  return sha256(
    canonicalDeclarationPayload({
      ...input,
      resolvedTimeoutMs: resolveWorkspaceHookTimeoutMs(input.hook, input.defaultTimeoutMs),
    }),
  );
}

function canonicalDeclarationPayload(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  scriptEntry?: WorkspaceHookScriptEntry;
}): unknown[] {
  const execution =
    input.hook.type === "process"
      ? ["process", input.hook.command, [...(input.hook.args ?? [])]]
      : [
          "command",
          input.hook.command,
          input.hook.async === true,
          input.hook.shell === undefined
            ? ["unset"]
            : input.hook.shell === true
              ? ["true"]
              : ["string", input.hook.shell],
        ];
  return [
    "workspace-hook-declaration",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sourceRelativePath,
    input.sourceDiscoveryOrder,
    input.event,
    input.matcher,
    input.matcherIndex,
    input.hookIndex,
    execution,
    input.resolvedTimeoutMs,
    input.resolvedMaxOutputBytes,
    // onError: deny 把「出错放行」改成「出错拦截」，是安全语义，改了就要重新信任，所以进摘要。
    // 只在 deny 时追加：没写或写 allow 的声明，摘要与引入该字段之前逐字节相同，已有信任不失效。
    ...(input.hook.onError === "deny" ? [["onError", "deny"]] : []),
    // 直接入口脚本内容进摘要（D24）：脚本变化即要求重新信任。识别不到入口时不追加，摘要与修订前逐字节相同。
    // missing / unverifiable 也进摘要，保证它们不会与任何可授权的 file 状态得到同一 digest。
    ...(input.scriptEntry
      ? [["scriptEntry", input.scriptEntry.path, canonicalScriptState(input.scriptEntry.state)]]
      : []),
  ];
}

function normalizeRelativeSourcePath(workspacePath: string, sourcePath: string): string {
  const value = relative(resolve(workspacePath), resolve(sourcePath)).replaceAll("\\", "/");
  return value || basename(sourcePath);
}

function canonicalScriptState(state: WorkspaceHookScriptState): unknown[] {
  return state.kind === "file" ? ["file", state.sha256] : [state.kind];
}

function canonicalOptional(value: boolean | number | undefined): unknown[] {
  return value === undefined ? ["unset"] : ["set", value];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
