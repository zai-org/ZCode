import { Event as RpcEvent } from "@zcode/rpc";
import type { IConversationShareService } from "#src/conversation-share/conversationShare.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import {
  readTrustedZCodeAgentV4Connection,
  withTrustedZCodeAgentV4Connection,
  type ZCodeAgentV4ConnectionContext,
} from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import { conversationShareConnectionScopeFactory } from "#src/conversation-share/conversationShareService.js";

type ConversationShareAgentService = Pick<
  IZCodeAgentService,
  | "conversationRowsRangeV4"
  | "conversationFileChangesV4"
  | "conversationAttachmentReadV4"
  | "conversationAttachmentStatV4"
>;

type ConnectionScopableConversationShareService = IConversationShareService & {
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService;
};

function isConnectionScopableConversationShareService(
  service: IConversationShareService,
): service is ConnectionScopableConversationShareService {
  return (
    conversationShareConnectionScopeFactory in service &&
    typeof service[conversationShareConnectionScopeFactory] === "function"
  );
}

type ConversationShareManagedMethods = Pick<
  IConversationShareService,
  "listManagedShares" | "revokeManagedShare" | "restoreManagedShare" | "deleteManagedShare"
>;

// 管理 API 只读写当前 Host 账号自己的分享，不依赖会话 rows，所以桌面各分支都原样透传。
function managedShareMethods(service: IConversationShareService): ConversationShareManagedMethods {
  return {
    listManagedShares: (input) => service.listManagedShares(input),
    revokeManagedShare: (shareId) => service.revokeManagedShare(shareId),
    restoreManagedShare: (shareId) => service.restoreManagedShare(shareId),
    deleteManagedShare: (shareId) => service.deleteManagedShare(shareId),
  };
}

export function scopeConversationShareServiceForAttachment(
  service: IConversationShareService,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  agentService?: ConversationShareAgentService,
  connection?: ZCodeAgentV4ConnectionContext,
): IConversationShareService {
  if (clientMode === "desktop-continuous") {
    // R3 Share 运行在 Source：沿同一受信 transport 传递 Desktop attachment 身份，
    // 不读取控制端 JWT，也不为 Share 另建 hello/connection/subscription。
    if (connection?.role === "trusted-host-relay") {
      const forInput = (input: unknown) => {
        const downstream = readTrustedZCodeAgentV4Connection(input);
        if (
          !downstream ||
          downstream.clientMode !== "desktop-continuous" ||
          !agentService ||
          !isConnectionScopableConversationShareService(service)
        ) {
          throw Object.assign(new Error("Conversation sharing connection is not trusted"), {
            kind: "connection_unavailable" as const,
          });
        }
        const scopedAgent: ConversationShareAgentService = {
          conversationRowsRangeV4: (params) =>
            agentService.conversationRowsRangeV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
          conversationFileChangesV4: (params) =>
            agentService.conversationFileChangesV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
          conversationAttachmentReadV4: (params) =>
            agentService.conversationAttachmentReadV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
          conversationAttachmentStatV4: (params) =>
            agentService.conversationAttachmentStatV4(
              withTrustedZCodeAgentV4Connection(params, downstream),
            ),
        };
        return service[conversationShareConnectionScopeFactory](scopedAgent);
      };
      return {
        getCapabilities: () => service.getCapabilities(),
        preflight: async (input) => forInput(input).preflight(input),
        publish: async (input, operationId) => forInput(input).publish(input, operationId),
        onDynamicPublishProgress: (id) => service.onDynamicPublishProgress(id),
        importShare: async (input, id) => forInput(input).importShare(input, id),
        onDynamicImportProgress: (id) => service.onDynamicImportProgress(id),
        getImportedConversation: (input) => service.getImportedConversation(input),
        getPreview: (code) => service.getPreview(code),
        getContinuation: async (input) => forInput(input).getContinuation(input),
        ...managedShareMethods(service),
      };
    }
    if (!isConnectionScopableConversationShareService(service)) {
      if (!connection) return service;
      return {
        getCapabilities: () => service.getCapabilities(),
        preflight: (input) =>
          service.preflight(withTrustedZCodeAgentV4Connection(input, connection)),
        publish: (input, id) =>
          service.publish(withTrustedZCodeAgentV4Connection(input, connection), id),
        onDynamicPublishProgress: (id) => service.onDynamicPublishProgress(id),
        importShare: (input, id) =>
          service.importShare(withTrustedZCodeAgentV4Connection(input, connection), id),
        onDynamicImportProgress: (id) => service.onDynamicImportProgress(id),
        getImportedConversation: (input) => service.getImportedConversation(input),
        getPreview: (code) => service.getPreview(code),
        getContinuation: (input) =>
          service.getContinuation(withTrustedZCodeAgentV4Connection(input, connection)),
        ...managedShareMethods(service),
      };
    }
    if (agentService) return service[conversationShareConnectionScopeFactory](agentService);
    const rejectUnavailable = async (): Promise<never> => {
      throw Object.assign(new Error("Conversation sharing connection is not ready"), {
        kind: "connection_unavailable" as const,
      });
    };
    return {
      getCapabilities: () => service.getCapabilities(),
      preflight: (input) => service.preflight(input),
      publish: rejectUnavailable,
      onDynamicPublishProgress: (operationId) => service.onDynamicPublishProgress(operationId),
      importShare: (input, operationId) => service.importShare(input, operationId),
      onDynamicImportProgress: (operationId) => service.onDynamicImportProgress(operationId),
      getImportedConversation: (input) => service.getImportedConversation(input),
      getPreview: (shareCode) => service.getPreview(shareCode),
      getContinuation: (input) => service.getContinuation(input),
      ...managedShareMethods(service),
    };
  }
  const rejectMobileShare = async (): Promise<never> => {
    throw Object.assign(new Error("Conversation sharing is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  return {
    getCapabilities: () => service.getCapabilities(),
    preflight: rejectMobileShare,
    publish: rejectMobileShare,
    onDynamicPublishProgress: () => RpcEvent.None,
    importShare: rejectMobileShare,
    onDynamicImportProgress: () => RpcEvent.None,
    // 手机远控没有本地 workspace 副本，直接返回 null 即可（不渲染只读块）。
    getImportedConversation: async () => null,
    getPreview: (shareCode: string) => service.getPreview(shareCode),
    getContinuation: rejectMobileShare,
    // 分享管理只在桌面设置页提供；手机远控继续使用 Web /share/manage。
    listManagedShares: rejectMobileShare,
    revokeManagedShare: rejectMobileShare,
    restoreManagedShare: rejectMobileShare,
    deleteManagedShare: rejectMobileShare,
  };
}
