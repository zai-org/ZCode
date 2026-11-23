import { z } from "zod";

export const WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_HOOK_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

export const WORKSPACE_HOOK_SCHEMA_FIELDS = {
  root: ["enabled", "timeoutMs", "maxOutputBytes", "events"],
  matcher: ["matcher", "hooks"],
  events: [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ],
  // onError 进声明摘要（shared/workspace-hook-digest.ts），改了要重新信任。
  process: ["type", "command", "enabled", "args", "timeoutMs", "statusMessage", "onError"],
  command: [
    "type",
    "command",
    "enabled",
    "async",
    "shell",
    "timeout",
    "timeoutMs",
    "statusMessage",
    "onError",
  ],
} as const;

export const WorkspaceHookTrustState = {
  NotApplicable: "not_applicable",
  PendingTrust: "pending_trust",
  TrustedPersistent: "trusted_persistent",
  BlockedUntrusted: "blocked_untrusted",
  BlockedPolicy: "blocked_policy",
  Revoked: "revoked",
  StaleDigest: "stale_digest",
} as const;
export type WorkspaceHookTrustState =
  (typeof WorkspaceHookTrustState)[keyof typeof WorkspaceHookTrustState];

export const workspaceHookTrustStateSchema = z.enum([
  "not_applicable",
  "pending_trust",
  "trusted_persistent",
  "blocked_untrusted",
  "blocked_policy",
  "revoked",
  "stale_digest",
]);

export const workspaceHookAdmissionClassSchema = z.enum([
  "not_applicable",
  "admitted",
  "pending",
  "blocked",
]);
export type WorkspaceHookAdmissionClass = z.infer<typeof workspaceHookAdmissionClassSchema>;

export const workspaceHookReasonCodeSchema = z.enum([
  "workspace_hooks_no_enabled_hooks",
  "workspace_hooks_not_applicable",
  "workspace_hooks_pending_trust",
  "workspace_hooks_trusted_persistent",
  "workspace_hooks_blocked_untrusted",
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hook_declaration_changed",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_require_trust_capable_host",
  "workspace_hooks_interaction_timeout",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_review_superseded",
  "workspace_hooks_config_write_failed",
  // 读取失败与写入失败必须可区分：config_write_failed 曾被 mutation 在
  // readFile/JSON.parse 失败时抛出，误导用户重试「写入」。
  "workspace_hooks_config_unreadable",
  "workspace_hooks_config_rebuild_failed",
  "workspace_hooks_revoked",
  "workspace_hooks_unknown_execution_field",
  "workspace_hooks_feature_disabled",
  // 入口脚本不存在或无法读取（D24）：没有可审核的内容，拒绝授权与派发。
  "workspace_hook_script_unavailable",
]);
export type WorkspaceHookReasonCode = z.infer<typeof workspaceHookReasonCodeSchema>;

export const WORKSPACE_HOOK_STATE_ADMISSION_MAP = {
  not_applicable: {
    admissionClass: "not_applicable",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_not_applicable",
  },
  pending_trust: {
    admissionClass: "pending",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_pending_trust",
  },
  trusted_persistent: {
    admissionClass: "admitted",
    effectiveRunnable: "configured",
    reasonCode: "workspace_hooks_trusted_persistent",
  },
  blocked_untrusted: {
    admissionClass: "blocked",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_blocked_untrusted",
  },
  blocked_policy: {
    admissionClass: "blocked",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_blocked_by_policy",
  },
  revoked: {
    admissionClass: "pending",
    effectiveRunnable: false,
    reasonCode: "workspace_hooks_revoked",
  },
  stale_digest: {
    admissionClass: "pending",
    effectiveRunnable: false,
    reasonCode: "workspace_hook_declaration_changed",
  },
} as const satisfies Record<
  WorkspaceHookTrustState,
  {
    admissionClass: WorkspaceHookAdmissionClass;
    effectiveRunnable: false | "configured";
    reasonCode: WorkspaceHookReasonCode;
  }
>;

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveIntegerSchema = z.number().int().positive();
const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const workspaceHookEffectiveStateSchema = z
  .object({
    reviewItemId: nonEmptyStringSchema,
    sourceRootEnabled: z.boolean(),
    declarationEnabled: z.boolean(),
    runtimeHooksEnabled: z.boolean(),
    configuredEnabled: z.boolean(),
    editable: z.boolean(),
    trustState: workspaceHookTrustStateSchema,
    admissionClass: workspaceHookAdmissionClassSchema,
    effectiveRunnable: z.boolean(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    bundleDigest: sha256DigestSchema.optional(),
    hookDeclarationDigest: sha256DigestSchema.optional(),
    sourcePaths: z.array(nonEmptyStringSchema),
    reasonCode: workspaceHookReasonCodeSchema.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const expected = WORKSPACE_HOOK_STATE_ADMISSION_MAP[state.trustState];
    if (state.admissionClass !== expected.admissionClass) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["admissionClass"],
        message: `admissionClass must be ${expected.admissionClass} for ${state.trustState}`,
      });
    }
    if (
      state.reasonCode !== undefined &&
      state.reasonCode !== expected.reasonCode &&
      !isScriptUnavailableBlock(state)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: `reasonCode must be ${expected.reasonCode} for ${state.trustState}`,
      });
    }
    if (expected.effectiveRunnable === false && state.effectiveRunnable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveRunnable"],
        message: `${state.trustState} cannot be runnable`,
      });
    }
    if (!state.configuredEnabled && state.effectiveRunnable) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveRunnable"],
        message: "a configured-disabled hook cannot be runnable",
      });
    }
  });
export type WorkspaceHookEffectiveState = z.infer<typeof workspaceHookEffectiveStateSchema>;

/**
 * 入口脚本不可用（D24）复用 blocked_untrusted：不可信任、不可运行、不计入 pending，
 * 与 UI 的可信任状态集合天然一致，不需要新增 trust state 与协议枚举；只把 reason 区分出来。
 */
function isScriptUnavailableBlock(state: {
  trustState: WorkspaceHookTrustState;
  reasonCode?: WorkspaceHookReasonCode;
}): boolean {
  return (
    state.trustState === "blocked_untrusted" &&
    state.reasonCode === "workspace_hook_script_unavailable"
  );
}

export const workspaceHookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);

export const workspaceHookScriptEntrySchema = z
  .object({
    path: nonEmptyStringSchema,
    state: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("file"), sha256: sha256DigestSchema }).strict(),
      z.object({ kind: z.literal("missing") }).strict(),
      z.object({ kind: z.literal("unverifiable") }).strict(),
    ]),
  })
  .strict();
export type WorkspaceHookScriptEntry = z.infer<typeof workspaceHookScriptEntrySchema>;

/** 有入口但不是完整读取的普通文件：没有可审核的内容，不能授权也不能派发（D24）。 */
export function isWorkspaceHookScriptUnavailable(entry: {
  scriptEntry?: { state: { kind: string } };
}): boolean {
  return entry.scriptEntry !== undefined && entry.scriptEntry.state.kind !== "file";
}

const canonicalEntryBaseShape = {
  reviewItemId: nonEmptyStringSchema,
  event: workspaceHookEventNameSchema,
  matcherIndex: nonnegativeIntegerSchema,
  hookIndex: nonnegativeIntegerSchema,
  sourceFileIndex: nonnegativeIntegerSchema,
  sourceRelativePath: nonEmptyStringSchema,
  matcher: z.string().nullable(),
  command: nonEmptyStringSchema,
  resolvedTimeoutMs: positiveIntegerSchema,
  resolvedMaxOutputBytes: positiveIntegerSchema,
  statusMessage: nonEmptyStringSchema.optional(),
  // 只在声明写成 deny 时在场（与声明摘要同一条规则，见 shared/workspace-hook-digest.ts）。
  onError: z.literal("deny").optional(),
  // 能识别的直接入口脚本（D24，shared/workspace-hook-config.ts），进声明摘要。
  scriptEntry: workspaceHookScriptEntrySchema.optional(),
  sourceRootEnabled: z.boolean(),
  declarationEnabled: z.boolean(),
  runtimeHooksEnabled: z.boolean(),
  configuredEnabled: z.boolean(),
  editable: z.boolean(),
  declarationDigestAlgorithm: z.literal("sha256"),
  hookDeclarationDigest: sha256DigestSchema,
} as const;

export const canonicalWorkspaceHookEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      ...canonicalEntryBaseShape,
      type: z.literal("command"),
      async: z.boolean().optional(),
      shell: z.union([z.literal(true), nonEmptyStringSchema]).optional(),
    })
    .strict(),
  z
    .object({
      ...canonicalEntryBaseShape,
      type: z.literal("process"),
      args: z.array(z.string()).optional(),
    })
    .strict(),
]);
export type CanonicalWorkspaceHookEntry = z.infer<typeof canonicalWorkspaceHookEntrySchema>;

export const workspaceHookBundleSnapshotSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION),
    workspaceIdentity: nonEmptyStringSchema,
    discoveredAt: z.string().datetime(),
    sourceFiles: z.array(
      z
        .object({
          canonicalPath: nonEmptyStringSchema,
          baseDir: nonEmptyStringSchema,
          discoveryOrder: nonnegativeIntegerSchema,
          configFileKind: z.enum(["zcode.json", ".zcode/config.json", "explicit"]),
          explicitProjectConfig: z.boolean(),
          editable: z.boolean(),
          hooksRoot: z
            .object({
              enabled: z.boolean().optional(),
              timeoutMs: z.number().finite().positive().optional(),
              maxOutputBytes: z.number().finite().positive().optional(),
            })
            .strict(),
        })
        .strict(),
    ),
    hooks: z.array(canonicalWorkspaceHookEntrySchema),
    digestAlgorithm: z.literal("sha256"),
    bundleDigest: sha256DigestSchema,
  })
  .strict();
export type WorkspaceHookBundleSnapshot = Readonly<
  z.infer<typeof workspaceHookBundleSnapshotSchema>
>;

export function createWorkspaceHookBundleSnapshot(value: unknown): WorkspaceHookBundleSnapshot {
  return deepFreeze(workspaceHookBundleSnapshotSchema.parse(value)) as WorkspaceHookBundleSnapshot;
}

export const workspaceHookReviewFlowStateSchema = z
  .object({
    reviewFlowId: nonEmptyStringSchema,
    generation: positiveIntegerSchema,
    interactionId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    bundleDigest: sha256DigestSchema,
    state: z.enum(["pending", "resolved", "superseded", "cancelled", "timed_out"]),
    supersededByInteractionId: nonEmptyStringSchema.optional(),
    createdAt: nonnegativeIntegerSchema,
    deadlineAt: nonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((flow, context) => {
    if (flow.deadlineAt < flow.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadlineAt"],
        message: "deadlineAt must not precede createdAt",
      });
    }
    if (flow.state === "superseded" && !flow.supersededByInteractionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersededByInteractionId"],
        message: "superseded flow requires its replacement interaction id",
      });
    }
    if (flow.state !== "superseded" && flow.supersededByInteractionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersededByInteractionId"],
        message: "only a superseded flow may reference a replacement interaction",
      });
    }
  });
export type WorkspaceHookReviewFlowState = z.infer<typeof workspaceHookReviewFlowStateSchema>;

export const workspaceHookSecurityRevisionSchema = z
  .object({ coordinatorEpoch: nonEmptyStringSchema, counter: nonnegativeIntegerSchema })
  .strict();
export type WorkspaceHookSecurityRevision = z.infer<typeof workspaceHookSecurityRevisionSchema>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
