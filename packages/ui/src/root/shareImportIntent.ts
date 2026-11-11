export type ShareImportIntentStatus =
  | "received"
  | "waiting_for_auth"
  | "importing"
  | "complete"
  | "failed"
  | "cancelled";

export interface ShareImportIntent {
  shareCode: string;
  clientRequestId: string;
  status: ShareImportIntentStatus;
  targetWorkspacePath?: string;
  targetWorkspaceIdentity?: string;
  targetWorkspaceKind?: "local" | "remote";
}

export function createShareImportIntent(
  shareCode: string,
  requestIdFactory: () => string = () =>
    `share-import-request-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
  target?: Pick<
    ShareImportIntent,
    "targetWorkspacePath" | "targetWorkspaceIdentity" | "targetWorkspaceKind"
  >,
): ShareImportIntent {
  return {
    shareCode,
    clientRequestId: requestIdFactory(),
    status: "received",
    ...(target?.targetWorkspacePath ? { targetWorkspacePath: target.targetWorkspacePath } : {}),
    ...(target?.targetWorkspaceIdentity
      ? { targetWorkspaceIdentity: target.targetWorkspaceIdentity }
      : {}),
    ...(target?.targetWorkspaceKind ? { targetWorkspaceKind: target.targetWorkspaceKind } : {}),
  };
}

export function isShareImportIntentSame(
  intent: ShareImportIntent,
  payload: { shareCode: string },
): boolean {
  return intent.shareCode === payload.shareCode;
}

const IMPORT_FAILURE_PRESENTATIONS: Readonly<
  Record<string, { messageId: string; retryable: boolean }>
> = {
  authentication_required: {
    messageId: "conversationShare.import.loginRequired",
    retryable: false,
  },
  not_found: { messageId: "conversationShare.import.notFound", retryable: false },
  expired: { messageId: "conversationShare.import.expired", retryable: false },
  revoked: { messageId: "conversationShare.import.revoked", retryable: false },
  import_not_allowed: { messageId: "conversationShare.import.notAllowed", retryable: false },
  unsupported_schema_version: {
    messageId: "conversationShare.import.unsupportedVersion",
    retryable: false,
  },
  feature_disabled: { messageId: "conversationShare.error.featureDisabled", retryable: false },
  invalid_contract: { messageId: "conversationShare.import.integrityFailed", retryable: false },
  service_unavailable: { messageId: "conversationShare.error.serviceUnavailable", retryable: true },
  rate_limited: { messageId: "conversationShare.error.rateLimited", retryable: true },
  network: { messageId: "conversationShare.error.network", retryable: true },
};

export function resolveShareImportFailurePresentation(kind: string): {
  messageId: string;
  retryable: boolean;
} {
  return (
    IMPORT_FAILURE_PRESENTATIONS[kind] ?? {
      messageId: "conversationShare.import.failed",
      retryable: true,
    }
  );
}
