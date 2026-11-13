import { mobilePluginDiscoveryTelemetrySchema, telemetryUiModeSchema } from "./telemetry.js";
import { remoteConversationTelemetryEventSchema } from "./conversation-telemetry/remoteTelemetryEvent.js";
import { databaseStartupControlSchema, databaseStartupStateSchema } from "./database-startup.js";
import { mcpAppInstanceSchema } from "./mcp-apps/instance.js";
import {
  automationSessionCreateTelemetrySchema,
  sessionCreateTelemetrySchema,
} from "./sessionCreateTelemetry.js";
/* eslint-disable max-lines -- 运行时 schema 当前集中在共享包入口，外部 relay payload 校验加入后先保持单一导出面。 */
import { z } from "zod";

export const CREDENTIAL_PLAINTEXT_MAX_BYTES = 1_048_576;
// UTF-8 明文经过 Base64 后会膨胀；保留 IV、tag、版本和指纹的固定开销。
export const CREDENTIAL_CIPHERTEXT_MAX_CHARS =
  Math.ceil(CREDENTIAL_PLAINTEXT_MAX_BYTES / 3) * 4 + 128;
export const credentialPlaintextSchema = z
  .string()
  .max(CREDENTIAL_PLAINTEXT_MAX_BYTES)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= CREDENTIAL_PLAINTEXT_MAX_BYTES,
    "Credential plaintext exceeds the UTF-8 byte limit",
  );
export const credentialCiphertextSchema = z.string().max(CREDENTIAL_CIPHERTEXT_MAX_CHARS);
export const credentialCipherRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    operation: z.enum(["encrypt", "decrypt"]),
    value: credentialCiphertextSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.operation === "encrypt" &&
      !credentialPlaintextSchema.safeParse(request.value).success
    )
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Credential plaintext exceeds the UTF-8 byte limit",
      });
  });
export const credentialCipherResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: credentialCiphertextSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);
export const credentialCipherReplySchema = z
  .object({ requestId: z.string().uuid(), result: credentialCipherResultSchema })
  .strict();
export type CredentialCipherRequest = z.infer<typeof credentialCipherRequestSchema>;
export type CredentialCipherReply = z.infer<typeof credentialCipherReplySchema>;

import { networkCaptureControlSchema, networkCaptureBatchSchema } from "./networkCapture.js";
import { browserCommandSchema } from "./browser-use/commands.js";
import { browserCommandResultSchema } from "./browser-use/result.js";
import { modelSelectionSchema } from "./model-selection.js";
import { localeSchema } from "./validationAppSettings.js";
import { zcodeProcessDiagnosticSchema } from "./process-diagnostic.js";
import { PROCESS_RESOURCE_CLI_LANES } from "./processResourceTelemetry.js";
import {
  providerProvisioningErrorCodeSchema,
  providerProvisioningLaneStatusSchema,
  providerProvisioningTriggerSchema,
} from "./provider-provisioning.js";
import { zcodeProviderSchema } from "./providers.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import type { WebRemoteControlAppPayload } from "./web-remote-control.js";
import { webRemoteControlMobileLogAppPayloadSchemas } from "#src/web-remote-relay/index.js";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import { sourceServerArtifactPolicySchema } from "./source-server/release.js";
import { sessionWorkflowActivitySchema } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import {
  webRemoteControlRpcTransportAckSchema,
  webRemoteControlRpcTransportFrameSchema,
} from "./web-remote-control-rpc-transport.js";
import {
  taskOwnerCommandDeliverySchema,
  taskOwnerCommandRequestSchema,
  taskOwnerCommandResultSchema,
  taskRealtimeDeliveredEventSchema,
  taskRealtimeEventSchema,
  taskRealtimeHostDeliveryKindSchema,
  taskRunLeaseAcquireRequestSchema,
  taskRunLeaseResultSchema,
  taskRunLeaseTargetSchema,
  taskStreamMirrorPublishOpSchema,
  taskStreamMirrorTargetSchema,
} from "./task-realtime-core.js";
import { wslUserSchema } from "./wslUserValidation.js";
import { legacyZCodeProviderSchema } from "./zcode-agent-policy.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";
import {
  zcodeMcpResourceSamplesSchema,
  zcodeMcpTelemetryEventSchema,
  zcodeProcessResourceSampleSchema,
  zcodeToolExecResourceSchema,
} from "./zcode-protocol/index.js";
import { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";

export {
  appSettingsOccupationEnum,
  appSettingsPatchSchema,
  appSettingsSchema,
  localeSchema,
  postUpdateReleaseNotesPayloadSchema,
} from "./validationAppSettings.js";
export { isValidWslUser, WSL_USER_MAX_LENGTH, wslUserSchema } from "./wslUserValidation.js";
export { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export const nonEmptyStringSchema = z.string().trim().min(1);
export const stringArraySchema = z.array(z.string());
// Task04B：topic physical-frame 计量器按 bridge/recovery id 的协议最大长度计算
// mobile relay 外壳；不在不可信 payload 入口机械限长，1MiB 上限就只是估算。
const webRemoteControlTransportIdSchema = nonEmptyStringSchema
  .max(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars)
  .regex(/^[A-Za-z0-9._~-]+$/u);

export const webRemoteControlWorkspaceTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  label: nonEmptyStringSchema,
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  kind: z.enum(["local", "remote"]),
  connectionState: z.enum(["connected", "disconnected", "reconnecting"]).optional(),
  lastConnectionError: z.string().optional(),
});

export const webRemoteControlWorkspaceTargetsSchema = z.array(
  webRemoteControlWorkspaceTargetSchema,
);

export const webRemoteControlReconnectWorkspaceRequestSchema = z.object({
  requestId: nonEmptyStringSchema,
  workspaceKey: nonEmptyStringSchema,
});

export const webRemoteControlReconnectWorkspaceResultSchema = z.union([
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
]);

export const webRemoteControlFailureReasonSchema = z.enum([
  "session-not-found",
  "session-expired",
  "session-conflict",
  "workspace-closed",
  "desktop-disconnected",
  "invalid-mobile-connection",
  "desktop-bootstrap-timeout",
  "connection-recovery-timeout",
  "relay-unavailable",
  "unsupported-action",
  "unexpected-error",
]);

export const webRemoteControlExternalWorkspaceBridgeSchema = z.discriminatedUnion("kind", [
  z.object({
    terminalOwnerId: webRemoteControlTransportIdSchema.optional(),
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("local"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    terminalOwnerId: webRemoteControlTransportIdSchema.optional(),
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("remote"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    remoteSessionId: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
    capabilities: z.object({ windowProjectDirectory: z.literal(true).optional() }).optional(),
  }),
]);

export const webRemoteControlMobileViewStateSchema = z.object({
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
  updatedAt: z.number().finite(),
});

export const webRemoteControlMobileTaskViewSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    taskId: nonEmptyStringSchema,
  })
  .strict();

export const webRemoteControlMobileDeviceInfoSchema = z.object({
  platform: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  userAgent: z.string().optional(),
  language: z.string().optional(),
  languages: z.array(z.string()).optional(),
  browserPlatform: z.string().optional(),
  viewport: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
      devicePixelRatio: z.number().finite(),
    })
    .optional(),
  screen: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
    })
    .optional(),
  timezone: z.string().optional(),
  online: z.boolean().optional(),
  updatedAt: z.number().finite(),
});

export const webRemoteControlWindowBootstrapResultSchema = z.object({
  windowControlSessionId: nonEmptyStringSchema,
  desktopAppVersion: nonEmptyStringSchema.optional(),
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  initialViewState: webRemoteControlMobileViewStateSchema.optional(),
  mobileViewState: webRemoteControlMobileViewStateSchema.optional(),
  mobileTaskViewEpoch: webRemoteControlTransportIdSchema.optional(),
});

export const webRemoteControlWorkspaceListResultSchema = z.object({
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
});

export const webRemoteControlPlatformMethodSchema = z.enum([
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
]);

// 手机动作请求：workspaceIdentity 与 KMP 一致为可选；远程任务缺 identity 时由 controller 按路径解析。
const webRemoteControlTaskActionTargetShape = {
  requestId: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
};

export const webRemoteControlRendererActionRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task-pin"),
    ...webRemoteControlTaskActionTargetShape,
    pinned: z.boolean(),
  }),
  z.object({
    kind: z.literal("task-archive"),
    ...webRemoteControlTaskActionTargetShape,
    archived: z.boolean(),
  }),
  z.object({
    kind: z.literal("workspace-create"),
    requestId: nonEmptyStringSchema,
    name: z.string(),
  }),
]);

export const webRemoteControlRendererActionResultSchema = z.union([
  z.object({
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    workspacePath: nonEmptyStringSchema.optional(),
    projectId: nonEmptyStringSchema.optional(),
    hostId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    requestId: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
]);

const webRemoteControlActionPayloadSchemas = [
  z.object({
    zcode_type: z.literal("workspace-create-request"),
    requestId: nonEmptyStringSchema,
    name: z.string(),
  }),
  z.object({
    zcode_type: z.literal("workspace-create-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    workspacePath: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema.optional(),
    hostId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    zcode_type: z.literal("workspace-create-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("task-pin-request"),
    ...webRemoteControlTaskActionTargetShape,
    pinned: z.boolean(),
  }),
  z.object({
    zcode_type: z.literal("task-pin-response"),
    requestId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    success: z.literal(true),
    pinned: z.boolean(),
  }),
  z.object({
    zcode_type: z.literal("task-pin-response"),
    requestId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("task-archive-request"),
    ...webRemoteControlTaskActionTargetShape,
    archived: z.boolean().optional(),
  }),
  z.object({
    zcode_type: z.literal("task-archive-response"),
    requestId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    success: z.literal(true),
    archived: z.boolean(),
  }),
  z.object({
    zcode_type: z.literal("task-archive-response"),
    requestId: nonEmptyStringSchema,
    taskId: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
] as const;

const webRemoteControlAppPayloadSchemas = [
  z
    .object({
      zcode_type: z.literal("telemetry-report"),
      event: z.union([sessionCreateTelemetrySchema, mobilePluginDiscoveryTelemetrySchema]),
    })
    .strict(),
  z.object({
    zcode_type: z.literal("bootstrap-request"),
    terminalClientSessionId: webRemoteControlTransportIdSchema.optional(),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("bootstrap-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWindowBootstrapResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-request"),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-updated"),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  z
    .object({
      zcode_type: z.literal("workspace-bridge-open"),
      terminalClientSessionId: webRemoteControlTransportIdSchema.optional(),
      requestId: nonEmptyStringSchema,
      bridgeSessionId: webRemoteControlTransportIdSchema,
      bridgeGeneration: z.number().int().nonnegative().optional(),
      recoveryId: webRemoteControlTransportIdSchema.optional(),
      workspaceKey: nonEmptyStringSchema,
      taskId: nonEmptyStringSchema.optional(),
      taskHostId: nonEmptyStringSchema.optional(),
      fileTreeTaskId: nonEmptyStringSchema.optional(),
      project: z
        .object({
          projectId: nonEmptyStringSchema.nullable(),
          hostId: nonEmptyStringSchema.optional(),
          draftId: z.string().uuid().optional(),
          reuseDraft: z.boolean().optional(),
        })
        .strict()
        .refine(
          (intent) =>
            (!intent.draftId || intent.projectId === null) &&
            (!intent.reuseDraft || Boolean(intent.draftId)),
          "Only an unclassified draft can reuse its directory",
        )
        .optional(),
    })
    .refine(
      (request) =>
        (!request.project || (!request.taskId && !request.fileTreeTaskId)) &&
        !(request.taskId && request.fileTreeTaskId) &&
        (!request.fileTreeTaskId || Boolean(request.taskHostId)) &&
        (!request.taskHostId || Boolean(request.taskId || request.fileTreeTaskId)),
      "Project draft cannot target an existing task",
    ),
  z.object({
    zcode_type: z.literal("workspace-bridge-ready"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    bridge: webRemoteControlExternalWorkspaceBridgeSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-bridge-error"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-request"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-view-state-update"),
    viewState: webRemoteControlMobileViewStateSchema,
    deviceInfo: webRemoteControlMobileDeviceInfoSchema.optional(),
  }),
  z
    .object({
      zcode_type: z.literal("mobile-task-view-update"),
      epoch: webRemoteControlTransportIdSchema,
      seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      bridgeSessionId: webRemoteControlTransportIdSchema,
      bridgeGeneration: z.number().int().nonnegative().optional(),
      view: webRemoteControlMobileTaskViewSchema.nullable(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("mobile-task-view-request"),
      epoch: webRemoteControlTransportIdSchema,
    })
    .strict(),
  z.object({
    zcode_type: z.literal("platform-request"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    args: z.unknown().optional(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  // Bugfix：04D-3 必须让 fragment/ACK 与 acknowledged adapter 原子切换。
  // 继续接受 legacy 单片会让 raw bytes 绕过 ACK/replay owner 和 1MiB 外壳硬边界。
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportAckSchema,
  z.object({
    zcode_type: z.literal("bridge-degraded"),
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: z.enum([
      "rpc-transport-fault",
      "rpc-frame-gap",
      "buffer-overflow",
      "buffer-timeout",
      "source-session-replaced",
      "terminal-owner-ended",
    ]),
    seq: z.number().int().nonnegative().optional(),
    expectedSeq: z.number().int().nonnegative().optional(),
    droppedCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    zcode_type: z.literal("app-error"),
    requestId: nonEmptyStringSchema.optional(),
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-diagnostic"),
    event: z.enum([
      "state-transition",
      "socket-close",
      "socket-error",
      "recover-start",
      "recover-scheduled",
      "pair-status",
      "failure",
    ]),
    timestamp: z.number().int().nonnegative(),
    state: z.string().optional(),
    previousState: z.string().optional(),
    pairStatus: z.enum(["waiting", "matched"]).optional(),
    closeCode: z.number().int().optional(),
    closeReason: z.string().optional(),
    wasClean: z.boolean().optional(),
    wasPaired: z.boolean().optional(),
    failureReason: webRemoteControlFailureReasonSchema.optional(),
    failureMessage: z.string().optional(),
    visibilityState: z.string().optional(),
    online: z.boolean().optional(),
    hiddenDurationMs: z.number().int().nonnegative().optional(),
  }),
  ...webRemoteControlActionPayloadSchemas,
  // 手机日志通道（推送 + 拉取），线格式见 docs/web-remote-control/mobile-log-channel.md。
  ...webRemoteControlMobileLogAppPayloadSchemas,
] as const;

// Bugfix: app payload 里多个消息共享 zcode_type（例如 platform-response），
// 不能直接用 z.discriminatedUnion("zcode_type")，否则 schema 初始化会因重复值失败。
// 这里保留同一批运行时约束，改用普通 union，让外部 relay 的不可信 payload
// 在进入 desktop/web 路由前仍然先被机械校验。
export const webRemoteControlAppPayloadSchema = z.union(webRemoteControlAppPayloadSchemas);

export function parseWebRemoteControlAppPayload(
  payload: unknown,
): WebRemoteControlAppPayload | null {
  const result = webRemoteControlAppPayloadSchema.safeParse(payload);
  return result.success ? (result.data as WebRemoteControlAppPayload) : null;
}

export const credentialRecordSchema = z.record(z.string(), z.string());
export const credentialKeySchema = nonEmptyStringSchema;
export const credentialValueSchema = z.string();

export const sshConnectOptionsSchema = z.object({
  kind: z.literal("ssh"),
  host: nonEmptyStringSchema,
  port: z.number().int().positive().max(65535).optional(),
  username: nonEmptyStringSchema,
  sshConfigAlias: nonEmptyStringSchema.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
  resourcePackages: z
    .object({
      selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
    })
    .optional(),
});

export const wslConnectOptionsSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().optional(),
  user: wslUserSchema.optional(),
});

export const dockerConnectOptionsSchema = z.object({
  kind: z.literal("docker"),
  container: nonEmptyStringSchema,
});

export const serverConnectOptionsSchema = z.object({
  kind: z.literal("server"),
  url: z.string().url(),
  name: nonEmptyStringSchema.optional(),
  token: z.string().optional(),
  workspacePath: z.string().optional(),
  serverId: nonEmptyStringSchema.optional(),
});

export const remoteTargetSchema = z.discriminatedUnion("kind", [
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
  serverConnectOptionsSchema,
]);

export const helloMessageSchema = z.object({
  type: z.literal("zcode-hello"),
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  pid: z.number().int(),
});

export const helloAckMessageSchema = z.object({
  type: z.literal("zcode-hello-ack"),
  version: z.string(),
  clientId: nonEmptyStringSchema,
});

export const rendererLogPayloadSchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  args: z.array(z.unknown()),
});

export const taskNotificationPayloadSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: z.enum([
    "completed",
    "failed",
    "permission_request",
    "elicitation_request",
    "feedback_update",
  ]),
  requestId: nonEmptyStringSchema.optional(),
  title: z.string(),
  body: z.string(),
});

export const telemetryRendererContextSchema = z.object({
  uiMode: telemetryUiModeSchema.optional(),
  clientTimezone: nonEmptyStringSchema,
  clientLanguage: nonEmptyStringSchema,
  screenResolution: nonEmptyStringSchema,
});

export const rendererTelemetryEventPayloadSchema = z.object({
  context: telemetryRendererContextSchema,
  elementName: nonEmptyStringSchema,
  eventRegion: nonEmptyStringSchema,
  eventType: nonEmptyStringSchema,
  eventText: z.string().optional(),
  eventExtraDetail: z.record(z.string(), z.string()),
  userId: z.string().optional(),
  talkId: z.string().optional(),
  messageId: z.string().optional(),
});

export const armsCustomEventPayloadSchema = z.object({
  name: nonEmptyStringSchema,
  group: nonEmptyStringSchema,
  value: z.number().finite().optional(),
  properties: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.undefined()]))
    .optional(),
});

export const broadcastMessageSchema = z.object({
  channel: nonEmptyStringSchema,
  payload: z.unknown(),
  sourceWindowId: z.number().int().optional(),
});

export const remoteAssetDirsSchema = z.object({
  mockCdnDir: z.string().optional(),
  remoteCdnBaseUrl: z.string().optional(),
  remoteCdnBaseUrls: z.array(z.string()).optional(),
  remoteCacheDir: z.string().optional(),
  sourceServerArtifactPolicy: sourceServerArtifactPolicySchema.optional(),
});

const hostAgentWarmupTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
});

export const hostInitLocalMessageSchema = z.object({
  browserBackendIdentity: z
    .object({ id: nonEmptyStringSchema, generation: z.number().int().nonnegative() })
    .optional(),
  type: z.literal("init-local"),
  databaseStartupId: z.string().min(1).max(128).optional(),
  hostId: nonEmptyStringSchema.optional(),
  deliveryKind: taskRealtimeHostDeliveryKindSchema.optional(),
  deviceMid: z.string().optional(),
  feedbackApiBase: z.string().url().optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  // 启动只预热 active workspace（desktop STARTUP_AGENT_WARMUP_LIMIT = 1），协议层同步收紧上限。
  agentWarmupTargets: z.array(hostAgentWarmupTargetSchema).max(1).optional(),
  agentSpawnFallbackCwd: nonEmptyStringSchema.optional(),
  remoteAssets: remoteAssetDirsSchema.optional(),
  /** spawn 时刻 Main 的实时界面语言；后续变化由 application-locale-changed 推送。 */
  locale: localeSchema.optional(),
  zcodeBuiltinProviderConfigFilePath: nonEmptyStringSchema,
  runtimeProcessEnvPatch: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
    .optional(),
});

export const windowHostRemoteWorkspaceDescriptorSchema = z
  .object({
    /** 本次请求直接复用的在线连接；只包含脱敏目标，不是 session 持久状态。 */
    reusedConnectionTarget: remoteTargetSchema.optional(),
    sourceServerId: nonEmptyStringSchema.optional(),
    remoteSessionId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    generation: z.number().int().positive(),
  })
  .strict();
export type WindowHostRemoteWorkspaceDescriptor = z.infer<
  typeof windowHostRemoteWorkspaceDescriptorSchema
>;

/** Desktop Main → Preload → Renderer 的 remote workspace MessagePort 元数据合同。 */
export const scopedServicePortPayloadSchema = windowHostRemoteWorkspaceDescriptorSchema
  .pick({
    sourceServerId: true,
    target: true,
    workspacePurpose: true,
  })
  .extend({
    attachmentId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
  })
  .strict();
export type ScopedServicePortPayload = z.infer<typeof scopedServicePortPayloadSchema>;

export const windowHostAttachmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("source-settings"),
      sourceServerId: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote"),
      sourceServerId: nonEmptyStringSchema.optional(),
      remoteSessionId: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WindowHostAttachmentScope = z.infer<typeof windowHostAttachmentScopeSchema>;

export const hostConnectRemoteWorkspaceMessageSchema = z
  .object({
    type: z.literal("connect-remote-workspace"),
    requestId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    remoteAssets: remoteAssetDirsSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    confirmSourceServerInstall: z.boolean().optional(),
  })
  .strict();

export const hostCancelRemoteWorkspaceConnectMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-connect"),
    requestId: nonEmptyStringSchema,
  })
  .strict();

export const hostBindRemoteWorkspaceContextMessageSchema = z
  .object({
    type: z.literal("bind-remote-workspace-context"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    legacyRouteHint: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hostCancelRemoteWorkspaceBindMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-bind"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

export const hostDisposeRemoteWorkspaceSessionMessageSchema = z
  .object({
    type: z.literal("dispose-remote-workspace-session"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

export const hostAttachServicePortMessageSchema = z
  .object({
    type: z.literal("attach-service-port"),
    terminalOwnerId: nonEmptyStringSchema.optional(),
    // main 只能声明 attachment 来源；connectionId 仍由 host process 分配。
    // desktop reload/remote reattach 必须显式 continuous，手机 shared-host 必须 replayable。
    requestId: nonEmptyStringSchema,
    attachmentId: nonEmptyStringSchema,
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    scope: windowHostAttachmentScopeSchema,
  })
  .strict();

export const hostDetachServicePortMessageSchema = z.object({
  type: z.literal("detach-service-port"),
  attachmentId: nonEmptyStringSchema,
});

export const hostDisposeMessageSchema = z.object({
  type: z.literal("dispose"),
});

export const hostBroadcastEnvelopeSchema = z.object({
  type: z.literal("broadcast"),
  message: broadcastMessageSchema,
});

export const hostBroadcastClaimResultMessageSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("acquired"),
    claimToken: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("busy"),
    retryAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("committed"),
  }),
]);

export const hostTaskRealtimeDeliverMessageSchema = z.object({
  type: z.literal("task-realtime-deliver"),
  event: taskRealtimeDeliveredEventSchema,
});

export const hostTaskRunLeaseResultMessageSchema = z.object({
  type: z.literal("task-run-lease-result"),
  result: taskRunLeaseResultSchema,
});

export const hostTaskOwnerCommandDeliverMessageSchema = z.object({
  type: z.literal("task-owner-command-deliver"),
  command: taskOwnerCommandDeliverySchema,
});

export const hostTaskOwnerCommandResultMessageSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

export const sessionMessageRequestSchema = z.object({
  content: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  fromSessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  toSessionId: nonEmptyStringSchema,
});

export const sessionMessageDeliveryResultSchema = z.object({
  error: z.string().optional(),
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  status: z.enum(["success", "failed"]),
});

export const sessionRouteSchema = z.object({
  sessionId: nonEmptyStringSchema,
});

export const hostSessionMessageDeliverMessageSchema = z.object({
  type: z.literal("session-message-deliver"),
  request: sessionMessageRequestSchema,
});

export const hostSessionMessageDeliveryResultMessageSchema = z.object({
  type: z.literal("session-message-delivery-result"),
  result: sessionMessageDeliveryResultSchema,
});

export const hostFeedbackLogArchiveResultMessageSchema = z.object({
  type: z.literal("feedback-log-archive-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  path: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

// main → host：定时任务到点派发。会话内 cron 带 targetTaskId 时直接 sendPrompt 到当前会话；
// 历史未绑定任务才 fallback createTask + sendPrompt 建 session。
export const hostCronRunMessageSchema = z.object({
  type: z.literal("cron-run"),
  automationId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  projectId: nonEmptyStringSchema.nullable().optional(),
  hostId: nonEmptyStringSchema.optional(),
  additionalDirectories: z.array(nonEmptyStringSchema).max(256).optional(),
  prompt: nonEmptyStringSchema,
  targetTaskId: nonEmptyStringSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  mode: z.string().optional(),
});

// main → host：闲时任务派发（仿 cron-run，字段独立不复用）。首跑不带 conversationId/sessionId，
// host createTask 新建 session；3h 续跑 / 中断恢复带上两者 resume 同一会话。
// serverTicketId 供 idle plan 适配层注入 X-Off-Peak-Ticket-ID 请求头（run 作用域）。
export const hostOffPeakRunMessageSchema = z.object({
  type: z.literal("off-peak-run"),
  offPeakTaskId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  projectId: nonEmptyStringSchema.nullable().optional(),
  hostId: nonEmptyStringSchema.optional(),
  additionalDirectories: z.array(nonEmptyStringSchema).max(256).optional(),
  prompt: nonEmptyStringSchema,
  // 权限四档映射现有 ZCodeTaskMode；与 cron-run 的 mode 同样按宽松 string 传输
  permissionMode: nonEmptyStringSchema,
  modelSelection: modelSelectionSchema,
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  serverTicketId: z.string().optional(),
});

// main → host：browser-use 命令执行结果（按 requestId 关联到 host 的 pending）。
export const hostBrowserExecuteResultMessageSchema = z.object({
  type: z.literal("browser-execute-result"),
  requestId: nonEmptyStringSchema,
  result: browserCommandResultSchema,
});

export const hostCredentialCipherResultMessageSchema = credentialCipherReplySchema
  .extend({
    type: z.literal("credential-cipher-result"),
  })
  .strict();

export const hostCredentialCipherRequestResponseSchema = credentialCipherRequestSchema
  .safeExtend({
    type: z.literal("credential-cipher-request"),
  })
  .strict();

/** 目标数据根路径上限：覆盖 Windows 长路径，同时限制私有通道载荷。 */
const CREDENTIAL_KEY_SHARE_TARGET_MAX_CHARS = 32_767;
export const CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE = "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE";

// Host → Main：数据存储路径切换后请求登记系统密钥。路径保持原值，不做 trim 等改写。
export const hostCredentialKeyShareRequestResponseSchema = z
  .object({
    type: z.literal("credential-key-share-request"),
    requestId: z.string().uuid(),
    targetBaseDir: z.string().min(1).max(CREDENTIAL_KEY_SHARE_TARGET_MAX_CHARS),
  })
  .strict();

// Main → Host：登记结果。失败只返回受控错误码，原生异常不穿过通道。
export const hostCredentialKeyShareResultMessageSchema = z
  .object({
    type: z.literal("credential-key-share-result"),
    requestId: z.string().uuid(),
    ok: z.boolean(),
    errorCode: z.literal(CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE).optional(),
  })
  .strict();

export const hostLocalMediaPreviewPathAuthorizeResultMessageSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    path: nonEmptyStringSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

/** main → host：插件 UI 沙箱登记结果（PluginSandboxRegisterResultPayload）。 */
export const hostPluginSandboxRegisterResultMessageSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    instance: mcpAppInstanceSchema.optional(),
    sandboxId: nonEmptyStringSchema.optional(),
    initId: z.number().int().nonnegative().optional(),
    shellUrl: nonEmptyStringSchema.optional(),
    partition: nonEmptyStringSchema.optional(),
    // 登记时生效的呈现字段（资源级优先合并后的值），回 renderer 定初始高度 / 边框。
    // Bugfix：这条 schema 是 strict 的——句柄多带一个未声明字段，整条回包会被 host 拒收，桥永远等不到句柄，
    // 卡片卡在 preparing（2026-09-12 inline e2e 复现）。改 PluginSandboxHandle 必须同步这里。
    resourceMeta: z
      .object({
        prefersBorder: z.boolean().optional(),
        heightHint: z.number().int().positive().optional(),
        minFrameHeight: z.number().int().positive().optional(),
        showInline: z.boolean().optional(),
        backgroundRetention: z.boolean().optional(),
        // 资源声明的浏览器权限随句柄回 renderer（进 hostContext.permissions）；与登记请求的 permissions 同一枚举。
        permissions: z
          .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
          .optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();

export const hostCuaPipFocusChangedMessageSchema = z
  .object({
    type: z.literal("cua-pip-focus-changed"),
    event: z
      .object({
        kind: z.literal("focus-changed"),
        revision: z.number().int().nonnegative().safe(),
        sourceWindowId: nonEmptyStringSchema.max(255),
        sessionId: nonEmptyStringSchema.max(255).nullable(),
      })
      .strict(),
  })
  .strict();

export const hostApplicationLocaleChangedMessageSchema = z
  .object({
    type: z.literal("application-locale-changed"),
    locale: localeSchema,
  })
  .strict();

export const hostProviderProvisioningExecuteMessageSchema = z
  .object({
    type: z.literal("provider-provisioning-execute"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    trigger: providerProvisioningTriggerSchema,
  })
  .strict();

/** main → host：数据同步页读取 / 重试 Provisioning lane 的结果（按 requestId 关联）。 */
export const hostProviderProvisioningLaneResultMessageSchema = z
  .object({
    type: z.literal("provider-provisioning-lane-result"),
    requestId: nonEmptyStringSchema,
    status: providerProvisioningLaneStatusSchema,
  })
  .strict();

/** 手机只提交项目意图；实际目录和远端 scope 必须由窗口 Host 准备。 */
export const hostPrepareProjectWorkspaceMessageSchema = z
  .object({
    type: z.literal("prepare-project-workspace"),
    requestId: nonEmptyStringSchema,
    clientMode: z.literal("web-remote-replayable"),
    projectId: nonEmptyStringSchema.nullable().optional(),
    hostId: nonEmptyStringSchema.optional(),
    draftId: z.string().uuid().optional(),
    reuseDraft: z.boolean().optional(),
    task: z
      .object({ taskId: nonEmptyStringSchema, workspaceKey: nonEmptyStringSchema })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (request) => (request.task ? request.projectId === undefined : request.projectId !== undefined),
    "Exactly one task or draft intent is required",
  )
  .refine(
    (request) =>
      (!request.draftId || request.projectId === null) &&
      (!request.reuseDraft || Boolean(request.draftId)),
    "Only an unclassified draft can reuse its directory",
  );
export type HostProjectWorkspaceNavigationInput = Pick<
  z.infer<typeof hostPrepareProjectWorkspaceMessageSchema>,
  "projectId" | "hostId" | "task" | "draftId" | "reuseDraft"
>;
export const hostProjectWorkspacePreparedValueSchema = z
  .object({
    hostId: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema.nullable(),
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    additionalDirectories: z.array(nonEmptyStringSchema),
    remote: windowHostRemoteWorkspaceDescriptorSchema.optional(),
  })
  .strict();
export type HostPreparedProjectWorkspace = z.infer<typeof hostProjectWorkspacePreparedValueSchema>;
export const hostProjectWorkspacePreparedResponseSchema = z
  .object({
    type: z.literal("project-workspace-prepared"),
    requestId: nonEmptyStringSchema,
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: hostProjectWorkspacePreparedValueSchema }).strict(),
      z.object({ ok: z.literal(false), error: nonEmptyStringSchema }).strict(),
    ]),
  })
  .strict();

export const hostResourceUsageSnapshotRequestMessageSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-request"),
    requestId: nonEmptyStringSchema,
  })
  .strict();
export type HostResourceUsageSnapshotRequestMessage = z.infer<
  typeof hostResourceUsageSnapshotRequestMessageSchema
>;

export const hostIncomingMessageSchema = z.discriminatedUnion("type", [
  hostPrepareProjectWorkspaceMessageSchema,
  z.object({ type: z.literal("network-capture"), control: networkCaptureControlSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-control"), control: databaseStartupControlSchema })
    .strict(),
  hostResourceUsageSnapshotRequestMessageSchema,
  z
    .object({ type: z.literal("resource-usage-snapshot-cancel"), requestId: nonEmptyStringSchema })
    .strict(),
  hostInitLocalMessageSchema,
  hostConnectRemoteWorkspaceMessageSchema,
  hostCancelRemoteWorkspaceConnectMessageSchema,
  hostBindRemoteWorkspaceContextMessageSchema,
  hostCancelRemoteWorkspaceBindMessageSchema,
  hostDisposeRemoteWorkspaceSessionMessageSchema,
  z
    .object({ type: z.literal("set-terminal-owner"), ownerId: nonEmptyStringSchema.nullable() })
    .strict(),
  hostAttachServicePortMessageSchema,
  hostDetachServicePortMessageSchema,
  hostDisposeMessageSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimResultMessageSchema,
  hostTaskRealtimeDeliverMessageSchema,
  hostTaskRunLeaseResultMessageSchema,
  hostTaskOwnerCommandDeliverMessageSchema,
  hostTaskOwnerCommandResultMessageSchema,
  hostSessionMessageDeliverMessageSchema,
  hostSessionMessageDeliveryResultMessageSchema,
  hostFeedbackLogArchiveResultMessageSchema,
  hostCronRunMessageSchema,
  hostOffPeakRunMessageSchema,
  hostBrowserExecuteResultMessageSchema,
  hostLocalMediaPreviewPathAuthorizeResultMessageSchema,
  hostCredentialCipherResultMessageSchema,
  hostCredentialKeyShareResultMessageSchema,
  hostPluginSandboxRegisterResultMessageSchema,
  hostCuaPipFocusChangedMessageSchema,
  hostApplicationLocaleChangedMessageSchema,
  hostProviderProvisioningExecuteMessageSchema,
  hostProviderProvisioningLaneResultMessageSchema,
]);

export const hostRemoteWorkspaceConnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connected"),
    requestId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export const hostRemoteWorkspaceContextBoundResponseSchema = z
  .object({
    type: z.literal("remote-workspace-context-bound"),
    requestId: nonEmptyStringSchema,
    // Desktop tab rekey only；手机 replayable attachment 不消费该提示。
    previousWorkspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hostRemoteWorkspaceContextBindFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-context-bind-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const hostRemoteWorkspaceReconnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-reconnected"),
    previousRemoteSessionId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectionLogResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connection-log"),
    requestId: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: nonEmptyStringSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connect-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
    profileId: z.string().uuid().optional(),
    resolvedWslTarget: z
      .object({
        kind: z.literal("wsl"),
        distro: nonEmptyStringSchema,
        user: wslUserSchema.refine((value) => value.length > 0),
      })
      .strict()
      .optional(),
  })
  .strict();

export const hostRemoteWorkspaceClosedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-closed"),
    remoteSessionId: nonEmptyStringSchema,
    reason: z.enum(["connection-closed", "disposed", "connect-cancelled"]),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    error: z.string().optional(),
    recoverable: z.boolean().optional(),
    recoveryAttempt: z.number().int().positive().optional(),
    recoveryLimit: z.number().int().positive().optional(),
    recoveryBudgetExhausted: z.boolean().optional(),
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const hostLogResponseSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
});

export { zcodeProviderSchema };

export const zcodeTaskMigrationSourceSchema = z.enum(["claudeCode"]);

export const hostAgentProcessSpawnedResponseSchema = z.object({
  type: z.literal("agent-process-spawned"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  startedAt: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive().optional(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
});
export type HostAgentProcessSpawnedResponse = z.infer<typeof hostAgentProcessSpawnedResponseSchema>;

export const hostAgentProcessReadyResponseSchema = z.object({
  type: z.literal("agent-process-ready"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  readyAt: z.number().int().nonnegative(),
  startupDurationMs: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema,
});
export type HostAgentProcessReadyResponse = z.infer<typeof hostAgentProcessReadyResponseSchema>;

export const hostAgentProcessExitedResponseSchema = z.object({
  type: z.literal("agent-process-exited"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  endedAt: z.number().int().nonnegative(),
  terminationKind: z.enum(["expected", "unexpected", "watchdog_recycle"]),
  terminationReason: z.string().optional(),
  /** rolling-upgrade 兼容：旧 Host 缺字段时 desktop 映射 crash_phase=unknown。 */
  runtimeReady: z.boolean().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  uptimeMs: z.number().int().nonnegative(),
  stderrLineCount: z.number().int().nonnegative(),
  stderrTail: z.array(z.string().max(1_100)).max(20).optional(),
});

export type HostAgentProcessExitedResponse = z.infer<typeof hostAgentProcessExitedResponseSchema>;

export const hostAgentProcessErrorResponseSchema = z.object({
  type: z.literal("agent-process-error"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive().nullable(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  errorName: nonEmptyStringSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string(),
  errorStack: z.string().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  occurredAt: z.number().int().nonnegative(),
});

export type HostAgentProcessErrorResponse = z.infer<typeof hostAgentProcessErrorResponseSchema>;

export const hostAgentProcessExceptionResponseSchema = z
  .object({
    type: z.literal("agent-process-exception"),
    lane: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive(),
    provider: zcodeProviderSchema,
    workspacePath: nonEmptyStringSchema,
    runtimeGeneration: z.number().int().positive(),
    runtimeInstanceId: nonEmptyStringSchema,
    diagnostic: zcodeProcessDiagnosticSchema,
  })
  .strict();
export type HostAgentProcessExceptionResponse = z.infer<
  typeof hostAgentProcessExceptionResponseSchema
>;

/**
 * services 打标后的 CLI 资源样本。
 *
 * `lane` 不是 CLI 协议字段：CLI 进程不知道自己被哪个进程管理器拉起，由 services 层在解析
 * 协议样本时按所属进程管理器补上。样本自身仍按 CLI 协议 schema 严格校验，因此 CLI 自报 lane
 * 会被协议层直接拒绝。`lane` 可选是为了兼容版本落后、还没打标的远端 server。
 */
export const processResourceCliLaneSchema = z.enum(PROCESS_RESOURCE_CLI_LANES);
export const agentLaneResourceSampleSchema = zcodeProcessResourceSampleSchema
  .extend({ lane: processResourceCliLaneSchema.optional() })
  .strict();
export type AgentLaneResourceSample = z.infer<typeof agentLaneResourceSampleSchema>;

/** Host 仅传运行环境的 SHA-256 哈希，避免原始主机、用户或 URL 进入消息与日志。 */
const resourceTelemetryEnvironmentKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

export const hostAgentResourceSampleResponseSchema = z
  .object({
    type: z.literal("agent-resource-sample"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    sample: agentLaneResourceSampleSchema,
  })
  .strict();
export type HostAgentResourceSampleResponse = z.infer<typeof hostAgentResourceSampleResponseSchema>;

/**
 * Node 进程（host / scheduler）每 60 秒自采的瞬时事实
 *
 * 只带这三项：CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，heap 只有进程自己读得到。
 */
export const nodeSelfResourceSampleSchema = z
  .object({
    /**
     * 整机归一化 CPU 百分比，100 表示所有逻辑核占满。
     * 上限刻意放宽（与 CLI 的 `zcodeProcessResourceSampleSchema` 同口径）：读数异常时宁可让
     * 样本带着离谱数值上去、由平台侧数值异常规则暴露，也不在客户端静默丢样本。
     */
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type NodeSelfResourceSample = z.infer<typeof nodeSelfResourceSampleSchema>;

/**
 * 主窗口 renderer 每 60 秒经 preload 桥送 main 的 heap 读数
 *
 * 只带 heap：renderer 的 CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，
 * renderer 自己也读不到。`strict` 保证 UI 侧不会顺手夹带路径、session 等隐私字段。
 */
export const rendererHeapSampleSchema = z
  .object({
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type RendererHeapSample = z.infer<typeof rendererHeapSampleSchema>;

export const hostResourceSampleResponseSchema = z
  .object({
    type: z.literal("host-resource-sample"),
    sample: nodeSelfResourceSampleSchema,
  })
  .strict();
export type HostResourceSampleResponse = z.infer<typeof hostResourceSampleResponseSchema>;

export const hostMcpResourceSamplesResponseSchema = z
  .object({
    type: z.literal("mcp-resource-samples"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    samples: zcodeMcpResourceSamplesSchema,
  })
  .strict();
export type HostMcpResourceSamplesResponse = z.infer<typeof hostMcpResourceSamplesResponseSchema>;

export const hostToolExecResourceResponseSchema = z
  .object({
    type: z.literal("tool-exec-resource"),
    runtimeSurface: z.enum(["local", "remote"]),
    sample: zcodeToolExecResourceSchema,
  })
  .strict();
export type HostToolExecResourceResponse = z.infer<typeof hostToolExecResourceResponseSchema>;

export const hostMcpTelemetryResponseSchema = z
  .object({
    type: z.literal("mcp-telemetry"),
    runtimeSurface: z.enum(["local", "remote"]),
    event: zcodeMcpTelemetryEventSchema,
  })
  .strict();
export type HostMcpTelemetryResponse = z.infer<typeof hostMcpTelemetryResponseSchema>;

export const hostPluginTelemetryResponseSchema = z
  .object({
    type: z.literal("plugin-telemetry"),
    event: rendererTelemetryEventPayloadSchema.refine((event) =>
      ["plugin_lifecycle", "plugin_usage", "plugin_runtime_error"].includes(event.elementName),
    ),
  })
  .strict();
export type HostPluginTelemetryResponse = z.infer<typeof hostPluginTelemetryResponseSchema>;

export const hostRemoteConversationTelemetryResponseSchema = z
  .object({
    type: z.literal("remote-conversation-telemetry"),
    event: remoteConversationTelemetryEventSchema,
  })
  .strict();
export type HostRemoteConversationTelemetryResponse = z.infer<
  typeof hostRemoteConversationTelemetryResponseSchema
>;

export const hostSessionCreateTelemetryResponseSchema = z
  .object({
    type: z.literal("session-create-telemetry"),
    event: automationSessionCreateTelemetrySchema,
  })
  .strict();
export type HostSessionCreateTelemetryResponse = z.infer<
  typeof hostSessionCreateTelemetryResponseSchema
>;

export const hostAgentRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("agent-running-task-count-changed"),
  runningTaskCount: z.number().int().nonnegative(),
});

/**
 * 关闭窗口或退出应用会中断、且无法恢复的 Host 事项（docs/git/worktree.md §6.4）。
 * 第一版只有"正在新 worktree 中启动的任务"；以后可加入其他会被关闭中断的 Host 任务。
 */
export const hostQuitBlockerSchema = z.object({
  kind: z.enum(["worktree-creating"]),
  count: z.number().int().positive(),
});
export type HostQuitBlocker = z.infer<typeof hostQuitBlockerSchema>;

export const hostQuitBlockersChangedResponseSchema = z.object({
  type: z.literal("quit-blockers-changed"),
  /** 当前完整集合；空数组表示没有阻止退出的事项。 */
  blockers: z.array(hostQuitBlockerSchema),
});

export const hostWorkspaceRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("workspace-running-task-count-changed"),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostCuaOperationStateResponseSchema = z
  .object({
    type: z.literal("cua-operation-state"),
    active: z.boolean(),
    sessionId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export type HostCuaOperationStateResponse = z.infer<typeof hostCuaOperationStateResponseSchema>;

export const hostBroadcastClaimRequestResponseSchema = z.object({
  type: z.literal("broadcast-claim-request"),
  requestId: nonEmptyStringSchema,
  key: nonEmptyStringSchema.max(1_024),
});

export const hostBroadcastClaimCommitResponseSchema = z.object({
  type: z.literal("broadcast-claim-commit"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostBroadcastClaimReleaseResponseSchema = z.object({
  type: z.literal("broadcast-claim-release"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostTaskRealtimePublishResponseSchema = z.object({
  type: z.literal("task-realtime-publish"),
  event: taskRealtimeEventSchema,
});

export const hostTaskStreamOpPublishResponseSchema = z.object({
  type: z.literal("task-stream-op-publish"),
  target: taskStreamMirrorTargetSchema,
  op: taskStreamMirrorPublishOpSchema,
});

export const hostTaskRunLeaseAcquireResponseSchema = z.object({
  type: z.literal("task-run-lease-acquire"),
  request: taskRunLeaseAcquireRequestSchema,
});

export const hostTaskRunLeaseReleaseResponseSchema = z.object({
  type: z.literal("task-run-lease-release"),
  target: taskRunLeaseTargetSchema,
});

export const hostTaskOwnerCommandRequestResponseSchema = z.object({
  type: z.literal("task-owner-command-request"),
  command: taskOwnerCommandRequestSchema,
});

export const hostTaskOwnerCommandResultResponseSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

export const hostSessionMessageSendRequestedResponseSchema = z.object({
  type: z.literal("session-message-send-requested"),
  request: sessionMessageRequestSchema,
});

export const hostSessionRouteAnnounceResponseSchema = z.object({
  type: z.literal("session-route-announce"),
  route: sessionRouteSchema,
});

export const hostSessionMessageDeliverResultResponseSchema = z.object({
  type: z.literal("session-message-deliver-result"),
  result: sessionMessageDeliveryResultSchema,
});

export const hostFeedbackLogArchiveRequestResponseSchema = z.object({
  type: z.literal("feedback-log-archive-request"),
  requestId: nonEmptyStringSchema,
  sourceDir: nonEmptyStringSchema,
});

// host → main：定时任务派发结果。ok=已成功创建 session 且 prompt 已发出。
export const hostCronRunResultResponseSchema = z.object({
  type: z.literal("cron-run-result"),
  runId: nonEmptyStringSchema,
  ok: z.boolean(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：闲时任务派发结果。ok=session 已确保存在且 prompt 已发出；迟到结果用 offPeakTaskId 兜底结算。
export const hostOffPeakRunResultResponseSchema = z.object({
  type: z.literal("off-peak-run-result"),
  offPeakTaskId: nonEmptyStringSchema,
  ok: z.boolean(),
  /** Host 已在开放 CLI 生命周期事件前完成接纳落库；调度器只清理退避。 */
  lifecycleManaged: z.literal(true).optional(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：manual run 落库后的 scheduler 唤醒请求；业务数据仍由 scheduler 从 sqlite 读取。
export const hostCronSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("cron-scheduler-wake-request"),
  automationId: nonEmptyStringSchema,
});

// host → main：闲时任务 schedulable 翻转后的 scheduler 唤醒；业务数据仍由 scheduler 从 sqlite 读取。
export const hostOffPeakSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("off-peak-scheduler-wake-request"),
  offPeakTaskId: z.string().optional(),
});

// host → main：执行一条 browser-use 命令（main 用 WebContentsView+CDP 执行）。
export const hostBrowserExecuteRequestResponseSchema = z.object({
  controlScopeId: nonEmptyStringSchema.optional(),
  type: z.literal("browser-execute-request"),
  requestId: nonEmptyStringSchema,
  // 迁移兼容：旧 host bundle 没有 browserId/context；新 browser-client 链路始终携带。
  browserId: nonEmptyStringSchema.optional(),
  browserGeneration: z.number().int().nonnegative().optional(),
  sessionId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema.optional(),
  workspaceKey: nonEmptyStringSchema.optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  sessionContext: z.enum(["live", "cached"]).optional(),
  command: browserCommandSchema,
});

export const hostLocalMediaPreviewPathAuthorizeRequestResponseSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-request"),
    requestId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  })
  .strict();

/** host → main：登记已校验的插件 UI HTML。 */
export const hostPluginSandboxRegisterRequestResponseSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-request"),
    instance: mcpAppInstanceSchema,
    requestId: nonEmptyStringSchema,
    workspacePath: z.string().optional(),
    workspaceIdentity: z.string().optional(),
    ownerWebContentsId: z.number().int().nonnegative(),
    // 只有扩展视图不属于会话（docs/plugins/extension-host.md §8），见下方 refine。
    sessionId: nonEmptyStringSchema.optional(),
    contentKind: z.enum(["gen-ui", "extension"]).optional(),
    pluginId: nonEmptyStringSchema.optional(),
    // 资源所属 MCP server 运行时名：沙箱 partition 按它派生。
    serverName: nonEmptyStringSchema.optional(),
    // 沙箱作用域 id（`tool:<toolCallId>` / `surface:<surfaceId>`），main 只当不透明字符串。
    scopeId: nonEmptyStringSchema,
    html: z.string(),
    // MCP Apps 资源级 CSP 的四类域；与 mcp-apps 的 mcpToolUiCspSchema 同步。
    csp: z
      .object({
        connectDomains: z.array(z.string()).optional(),
        resourceDomains: z.array(z.string()).optional(),
        frameDomains: z.array(z.string()).optional(),
        baseUriDomains: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    // 资源级 `_meta["zcode/csp"]` 放宽项；与 mcp-apps 的 mcpAppCspRelaxationsSchema 同步。
    cspRelaxations: z
      .object({ unsafeEval: z.boolean().optional(), wasmUnsafeEval: z.boolean().optional() })
      .strict()
      .optional(),
    // 资源级 `_meta.ui.permissions`（规范四键）；与 mcp-apps 的 MCP_APPS_RESOURCE_PERMISSIONS 同步。
    permissions: z
      .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
      .optional(),
    prefersBorder: z.boolean().optional(),
    // 资源级尺寸提示，main 原样放进句柄的 resourceMeta。strict schema：改 PluginSandboxRegisterRequestPayload 必须同步这里。
    heightHint: z.number().int().positive().optional(),
    minFrameHeight: z.number().int().positive().optional(),
    showInline: z.boolean().optional(),
    backgroundRetention: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.contentKind === "extension"
        ? // 扩展视图：按插件归属，没有会话与 MCP server 名，也不能带原生权限。
          Boolean(value.pluginId) &&
          !value.sessionId &&
          !value.serverName &&
          !value.permissions?.length
        : Boolean(value.sessionId) &&
          (value.contentKind === "gen-ui"
            ? !value.pluginId && !value.serverName && !value.permissions?.length
            : Boolean(value.pluginId && value.serverName)),
    "Invalid sandbox provenance",
  );

export const networkObservationSchema = z.object({
  transport: z.enum(["http", "websocket", "rpc"]),
  interface: z.string(),
  durationMs: z.number(),
  ok: z.boolean(),
  statusCode: z.number().optional(),
  errorKind: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  dnsMs: z.number().optional(),
  tcpMs: z.number().optional(),
  tlsMs: z.number().optional(),
  ttfbMs: z.number().optional(),
  downloadMs: z.number().optional(),
});

export const hostNetworkTelemetryBatchResponseSchema = z.object({
  type: z.literal("network-telemetry-batch"),
  observations: z.array(networkObservationSchema).max(500),
});

export const hostProviderProvisioningSourceChangedResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-source-changed"),
    trigger: providerProvisioningTriggerSchema.exclude(["environment-online", "user-retry"]),
  })
  .strict();

/**
 * host → main：数据同步页按设备读取（read）、等当前执行结束后读取（wait）或重试（retry）
 * Provisioning lane。Main 总是回 provider-provisioning-lane-result。
 */
export const hostProviderProvisioningLaneRequestResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-lane-request"),
    requestId: nonEmptyStringSchema,
    sourceServerId: nonEmptyStringSchema,
    action: z.enum(["read", "wait", "retry"]),
  })
  .strict();

export const hostProviderProvisioningExecutionResultResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-execution-result"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    error: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
  })
  .strict();

export const hostResourceUsageProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: nonEmptyStringSchema,
    category: z.enum(["base", "task", "builtin-plugin", "community-plugin"]),
    groupKey: nonEmptyStringSchema,
    groupLabel: nonEmptyStringSchema,
    cpuPercent: z.number().finite().nonnegative(),
    memoryBytes: z.number().finite().nonnegative(),
  })
  .strict();

export const hostResourceUsageSnapshotResultResponseSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-result"),
    requestId: nonEmptyStringSchema,
    sampledAt: z.number().int().nonnegative(),
    processes: z.array(hostResourceUsageProcessSchema).max(10_000),
  })
  .strict();
export type HostResourceUsageSnapshotResultResponse = z.infer<
  typeof hostResourceUsageSnapshotResultResponseSchema
>;

export const hostResponseMessageSchema = z.discriminatedUnion("type", [
  hostProjectWorkspacePreparedResponseSchema,
  z.object({ type: z.literal("network-capture-batch"), batch: networkCaptureBatchSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-state"), state: databaseStartupStateSchema })
    .strict(),
  hostResourceUsageSnapshotResultResponseSchema,
  hostRemoteWorkspaceConnectionLogResponseSchema,
  hostRemoteWorkspaceConnectedResponseSchema,
  hostRemoteWorkspaceContextBoundResponseSchema,
  hostRemoteWorkspaceContextBindFailedResponseSchema,
  hostRemoteWorkspaceReconnectedResponseSchema,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  hostRemoteWorkspaceClosedResponseSchema,
  hostLogResponseSchema,
  hostAgentProcessSpawnedResponseSchema,
  hostAgentProcessReadyResponseSchema,
  hostAgentProcessExitedResponseSchema,
  hostAgentProcessErrorResponseSchema,
  hostAgentProcessExceptionResponseSchema,
  hostAgentResourceSampleResponseSchema,
  hostResourceSampleResponseSchema,
  hostMcpTelemetryResponseSchema,
  hostMcpResourceSamplesResponseSchema,
  hostToolExecResourceResponseSchema,
  hostSessionCreateTelemetryResponseSchema,
  hostRemoteConversationTelemetryResponseSchema,
  hostPluginTelemetryResponseSchema,
  hostAgentRunningTaskCountChangedResponseSchema,
  hostQuitBlockersChangedResponseSchema,
  hostWorkspaceRunningTaskCountChangedResponseSchema,
  hostCuaOperationStateResponseSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimRequestResponseSchema,
  hostBroadcastClaimCommitResponseSchema,
  hostBroadcastClaimReleaseResponseSchema,
  hostTaskRealtimePublishResponseSchema,
  hostTaskStreamOpPublishResponseSchema,
  hostTaskRunLeaseAcquireResponseSchema,
  hostTaskRunLeaseReleaseResponseSchema,
  hostTaskOwnerCommandRequestResponseSchema,
  hostTaskOwnerCommandResultResponseSchema,
  hostSessionMessageSendRequestedResponseSchema,
  hostSessionRouteAnnounceResponseSchema,
  hostSessionMessageDeliverResultResponseSchema,
  hostFeedbackLogArchiveRequestResponseSchema,
  hostBrowserExecuteRequestResponseSchema,
  hostLocalMediaPreviewPathAuthorizeRequestResponseSchema,
  hostCredentialCipherRequestResponseSchema,
  hostCredentialKeyShareRequestResponseSchema,
  hostPluginSandboxRegisterRequestResponseSchema,
  hostNetworkTelemetryBatchResponseSchema,
  hostProviderProvisioningSourceChangedResponseSchema,
  hostProviderProvisioningExecutionResultResponseSchema,
  hostProviderProvisioningLaneRequestResponseSchema,
  hostCronRunResultResponseSchema,
  hostOffPeakRunResultResponseSchema,
  hostCronSchedulerWakeRequestResponseSchema,
  hostOffPeakSchedulerWakeRequestResponseSchema,
]);

export const zcodeTaskPersistStatusSchema = z.enum(["running", "completed", "error"]);

export const zcodePromptImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

// 附件 TypeScript 联合类型新增 video 后，手写的持久化运行时 schema 未同步，
// session 恢复解析会拒绝含视频的用户消息。字段与 image 的 inline/local 引用语义保持一致。
export const zcodePromptVideoAttachmentSchema = z.object({
  kind: z.literal("video"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptPdfAttachmentSchema = z.object({
  kind: z.literal("pdf"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptFileAttachmentSchema = z.object({
  kind: z.literal("file"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  dataBase64: z.string().optional(),
  textContent: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  zcodePromptImageAttachmentSchema,
  zcodePromptVideoAttachmentSchema,
  zcodePromptPdfAttachmentSchema,
  zcodePromptFileAttachmentSchema,
]);

export const zcodePersistedToolCallSchema = z.object({
  toolName: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(["completed", "failed", "denied", "stopped"]).optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  raw: z.unknown().optional(),
  snapshotRefs: z
    .array(
      z.object({
        field: z.enum(["input", "output", "raw"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const zcodePersistedMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: z.string() }),
  z.object({ type: z.literal("thought"), content: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolIndex: z.number().int().nonnegative(),
  }),
]);

export const zcodePersistedMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  model: z.string().optional(),
  characterCount: z.number().int().nonnegative().optional(),
  // assistant 历史耗时已经在服务层落盘为 durationMs，
  // 但校验 schema 没同步，saveTask/getTaskSnapshot 解析时会把它静默剥掉，
  // 导致新消息结束后 UI 仍然只能看到“Worked”。这里补上字段以保留持久化值。
  durationMs: z.number().int().nonnegative().optional(),
  interrupted: z.boolean().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
  attachments: z.array(zcodePromptAttachmentSchema).optional(),
  tools: z.array(zcodePersistedToolCallSchema).optional(),
  thought: z.string().optional(),
  parts: z.array(zcodePersistedMessagePartSchema).optional(),
  checkpointState: z.enum(["partial"]).optional(),
  checkpointReason: z.enum(["tool_completed", "part_boundary", "periodic"]).optional(),
  checkpointUpdatedAt: z.number().int().nonnegative().optional(),
  turnIndex: z.number().int().nonnegative().optional(),
  // snapshot 按需加载依赖 bodyRefs（content/thought -> refId）定位完整内容；
  // 若 schema 缺字段，Zod 会在解析 session 文件时静默剥离，导致“加载完整内容”功能失效。
  bodyRefs: z
    .array(
      z.object({
        field: z.enum(["content", "thought"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  toolSlice: z
    .object({
      persistedMessageIndex: z.number().int().nonnegative(),
      totalTools: z.number().int().nonnegative(),
      startToolIndex: z.number().int().nonnegative(),
      endToolIndexExclusive: z.number().int().nonnegative(),
    })
    .optional(),
});

export const zcodeTaskGoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

export const zcodeTaskTargetChangedActionSchema = z.enum([
  "set",
  "status_updated",
  "cleared",
  "usage_accounted",
  "run_started",
  "run_finished",
  "summary_updated",
]);

export const zcodeTaskTargetChangedSourceSchema = z.enum(["command", "tool", "runtime"]);

export const zcodeTaskGoalSchema = z.object({
  sessionID: nonEmptyStringSchema,
  targetID: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  // 2.15.0 之前的 /goal 历史任务没有写 summaryTitle。
  // 读取 task index 老数据时要补成 null，否则整个任务列表会被运行时 schema 拒绝。
  summaryTitle: z.string().min(1).nullable().default(null),
  status: zcodeTaskGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  activeInputId: nonEmptyStringSchema.nullable().optional(),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().optional(),
  activeRunLastSeenAtMs: z.number().int().nonnegative().nullable().optional(),
  time: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  }),
});

export const zcodeTaskGoalChangedPatchSchema = z.object({
  action: zcodeTaskTargetChangedActionSchema,
  source: zcodeTaskTargetChangedSourceSchema,
  target: zcodeTaskGoalSchema.nullable(),
  previousTarget: zcodeTaskGoalSchema.nullable().optional(),
});

export const zcodeTaskTargetStatusSchema = zcodeTaskGoalStatusSchema;
export const zcodeTaskTargetSchema = zcodeTaskGoalSchema;
export const zcodeTaskTargetChangedPatchSchema = zcodeTaskGoalChangedPatchSchema;

export const zcodeTaskMetaSchema = z.object({
  taskId: nonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  mode: zcodeTaskModeSchema,
  model: z.string().optional(),
  thoughtLevel: nonEmptyStringSchema.optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  // meta 直接解析自 tasks-index/旧 session 文件；历史 provider 值在此归一为 glm。
  provider: legacyZCodeProviderSchema.optional(),
  migrationSource: zcodeTaskMigrationSourceSchema.optional(),
  forkedFromTaskId: nonEmptyStringSchema.optional(),
  // cron automation 身份：随 meta_json 一起持久化（单一来源），同时在写入时投影到 tasks 表
  // cron_automation_id 索引列，供按 automation 反查 session。runId 属于 automation_runs /
  // 投递 metadata，不属于 task 表。
  cronAutomationId: nonEmptyStringSchema.optional(),
  // off-peak 身份：与 cron 同款持久化策略——meta_json 单一来源 + tasks 表
  // off_peak_task_id 索引投影列（兜底/反查）。
  offPeakTaskId: nonEmptyStringSchema.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: zcodeTaskPersistStatusSchema.optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      detail: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyStringSchema.optional(),
      taskId: nonEmptyStringSchema.optional(),
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  repairState: z
    .object({
      claudeNativeSnapshotAssistantContentVersion: z.number().int().nonnegative().optional(),
      codexNativeSnapshotSubagentToolsVersion: z.number().int().nonnegative().optional(),
    })
    .optional(),
  changeSummary: z
    .object({
      fileCount: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      files: z.array(
        z.object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
  target: zcodeTaskGoalSchema.nullable().optional(),
});

export const zcodeTaskSessionBindingStateSchema = z.enum([
  "idle",
  "syncing",
  "ready",
  "stale",
  "failed",
]);

export const zcodeTaskSessionBindingSchema = z.object({
  // 绑定状态由 services 从持久化数据投影；旧绑定残留的历史 provider 值在此归一为 glm。
  provider: legacyZCodeProviderSchema,
  sessionId: nonEmptyStringSchema,
  // 绑定锚点需要支持空 task 的 -1，所以这里不能套 nonnegative。
  lastSyncedTurnIndex: z.number().int(),
  state: zcodeTaskSessionBindingStateSchema,
});

export const zcodeTaskIndexEntrySchema = z.object({
  workspaceHash: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
});

export const zcodePinnedTasksFileSchema = z.object({
  version: z.literal("1"),
  tasks: z.array(zcodeTaskIndexEntrySchema),
});

const zcodePersistedFileSnapshotSchema = z.object({
  path: z.string(),
  beforeContent: z.string().nullable(),
  afterContent: z.string(),
  writeCount: z.number().int().positive(),
  contentRefs: z
    .array(
      z.object({
        field: z.enum(["beforeContent", "afterContent"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const zcodePersistedFileChangeSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  snapshots: z.array(zcodePersistedFileSnapshotSchema),
  fileState: z.enum(["applied", "reverted"]).optional(),
});

const zcodePersistedTurnCheckpointSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  baseFileCheckpointId: nonEmptyStringSchema,
  resultFileCheckpointId: nonEmptyStringSchema.optional(),
});

export const zcodeSessionFileSchema = z.object({
  meta: zcodeTaskMetaSchema,
  messages: z.array(zcodePersistedMessageSchema),
  fileChanges: z.array(zcodePersistedFileChangeSchema).optional(),
  turnCheckpoints: z.array(zcodePersistedTurnCheckpointSchema).optional(),
});
