import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { ConversationTelemetryInput } from "@zcode/shared/zcode-protocol-v4";
import { resolveWorkspaceTelemetryDetail, type IPlatformService } from "@zcode/shared";
import { createConversationTelemetryService, type IServiceAccessor } from "@zcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

interface ConversationTelemetryAttachmentScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface ConversationTelemetryAttachmentValue {
  scope: ConversationTelemetryAttachmentScope;
  supervisor: ConversationTelemetrySupervisor;
  foregroundEnabled: boolean;
}

interface SupervisorRegistryEntry {
  key: string;
  logicalScopeKey: string;
  supervisor: ConversationTelemetrySupervisor;
  refCount: number;
  subscription: { dispose(): void } | null;
  stale: boolean;
  workspaceDetached: boolean;
}

interface SupervisorLease {
  entry: SupervisorRegistryEntry;
  release(): void;
}

const serviceGenerationIds = new WeakMap<object, number>();
let nextServiceGenerationId = 1;
const supervisorRegistry = new Map<string, SupervisorRegistryEntry>();

function serviceGenerationId(service: object): number {
  const existing = serviceGenerationIds.get(service);
  if (existing !== undefined) return existing;
  const created = nextServiceGenerationId;
  nextServiceGenerationId += 1;
  serviceGenerationIds.set(service, created);
  return created;
}

function attachmentScopeKey(scope: ConversationTelemetryAttachmentScope, service: object): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return [scope.remoteSessionId ?? "__base__", workspaceKey, serviceGenerationId(service)].join(
    "\u0000",
  );
}

function logicalAttachmentScopeKey(scope: ConversationTelemetryAttachmentScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return [scope.remoteSessionId ?? "__base__", workspaceKey].join("\u0000");
}

function sameScope(
  left: ConversationTelemetryAttachmentScope,
  right: ConversationTelemetryAttachmentScope,
): boolean {
  return (
    (left.remoteSessionId ?? "__base__") === (right.remoteSessionId ?? "__base__") &&
    (left.workspaceIdentity?.trim() || left.workspacePath) ===
      (right.workspaceIdentity?.trim() || right.workspacePath)
  );
}

function acquireSupervisor(
  scope: ConversationTelemetryAttachmentScope,
  services: IServiceAccessor,
  platform: Pick<IPlatformService, "reportArmsCustomEvent" | "reportTelemetryEvent">,
): SupervisorLease {
  const logicalScopeKey = logicalAttachmentScopeKey(scope);
  const key = attachmentScopeKey(scope, services.zcodeAgentService);
  // service generation 换代时，零引用旧 supervisor 立即销毁；仍被 pane 使用的旧代标 stale，
  // 等末位 lease 释放再清理。不能让旧/新 generation 同时长期订阅同一 workspace。
  for (const [candidateKey, candidate] of supervisorRegistry) {
    if (candidate.logicalScopeKey !== logicalScopeKey || candidateKey === key) {
      continue;
    }
    supervisorRegistry.delete(candidateKey);
    candidate.stale = true;
    if (candidate.refCount === 0) disposeSupervisorEntry(candidate);
  }
  let entry = supervisorRegistry.get(key);
  if (entry) {
    entry.refCount += 1;
  } else {
    entry = {
      key,
      logicalScopeKey,
      supervisor: new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: key,
        workspaceTelemetryDetail: resolveWorkspaceTelemetryDetail(scope),
      }),
      refCount: 1,
      subscription: null,
      stale: false,
      workspaceDetached: false,
    };
    supervisorRegistry.set(key, entry);
  }
  let released = false;
  return {
    entry,
    release: () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      if (entry.refCount > 0) return;
      if (entry.stale || entry.workspaceDetached) {
        disposeSupervisorEntry(entry);
      }
      // ref=0 的当前 generation 仍保留 live subscription。关闭 pane 不能等价于
      // workspace detach，否则超过 SessionDataLayer 30s keep-warm 的后台 terminal 会丢。
    },
  };
}

function disposeSupervisorEntry(entry: SupervisorRegistryEntry): void {
  if (supervisorRegistry.get(entry.key) === entry) {
    supervisorRegistry.delete(entry.key);
  }
  entry.subscription?.dispose();
  entry.subscription = null;
  entry.supervisor.dispose();
}

/** 窗口/测试销毁边界；生产 page 生命周期结束时不保留 orphan subscription。 */
export function disposeConversationTelemetrySupervisors(): void {
  for (const entry of supervisorRegistry.values()) {
    disposeSupervisorEntry(entry);
  }
  supervisorRegistry.clear();
}

/**
 * Root tab 事实源裁决 workspace detach。切 task/切 tab 不会移除 scope；真正关闭最后一个
 * workspace tab 才标记 detached，零引用立即销毁，有存量 pane 则等其 release 后销毁。
 */
export function reconcileConversationTelemetryWorkspaceScopes(
  scopes: readonly ConversationTelemetryAttachmentScope[],
): void {
  const attachedKeys = new Set(scopes.map(logicalAttachmentScopeKey));
  for (const entry of supervisorRegistry.values()) {
    entry.workspaceDetached = !attachedKeys.has(entry.logicalScopeKey);
    if (entry.workspaceDetached && entry.refCount === 0) {
      disposeSupervisorEntry(entry);
    }
  }
}

function ensureSupervisorSubscription(
  entry: SupervisorRegistryEntry,
  scope: ConversationTelemetryAttachmentScope,
  services: IServiceAccessor,
): void {
  if (entry.subscription) return;
  const telemetryService = createConversationTelemetryService(services.zcodeAgentService);
  const factEvent = telemetryService.onFact({
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  });
  entry.subscription = factEvent((fact: ConversationTelemetryInput) =>
    entry.supervisor.handleFact(fact),
  );
}

const ConversationTelemetryAttachmentContext =
  createContext<ConversationTelemetryAttachmentValue | null>(null);

/**
 * 窗口 workspace/service attachment：生命周期高于 pane 和 SessionDataLayer keep-warm。
 * Web/mobile 不创建 supervisor，也不安装 reporter/subscription。
 */
export function ConversationTelemetryWorkspaceAttachment({
  enabled,
  foregroundEnabled = true,
  services,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  children,
}: ConversationTelemetryAttachmentScope & {
  enabled: boolean;
  foregroundEnabled?: boolean;
  services: IServiceAccessor;
  children: ReactNode;
}) {
  const platform = useOptionalPlatform();
  const scope = useMemo<ConversationTelemetryAttachmentScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );
  const lease = useMemo(() => {
    const agentService = services.zcodeAgentService as object | null | undefined;
    if (!enabled || !platform || !agentService) return null;
    // Bug 根因：Root 的隔离渲染和远端 service 准备阶段可能尚无 PlatformProvider 或 agent service。
    // telemetry 是旁路能力，不能因依赖未就绪阻断 workspace 主界面；依赖齐备后再按 generation 建 lease。
    return acquireSupervisor(scope, services, platform);
  }, [enabled, platform, scope, services]);
  const supervisor = lease?.entry.supervisor ?? null;

  useEffect(() => {
    if (!lease) return undefined;
    ensureSupervisorSubscription(lease.entry, scope, services);
    return () => {
      lease.release();
    };
  }, [lease, scope, services]);

  const value = useMemo<ConversationTelemetryAttachmentValue | null>(
    () => (supervisor ? { scope, supervisor, foregroundEnabled } : null),
    [foregroundEnabled, scope, supervisor],
  );
  return (
    <ConversationTelemetryAttachmentContext.Provider value={value}>
      {children}
    </ConversationTelemetryAttachmentContext.Provider>
  );
}

/** pane 使用自己的 ready service/scope 覆盖 context；Web 根 attachment 为 null 时保持 no-op。 */
export function ConversationTelemetryPaneAttachment({
  services,
  scope,
  children,
}: {
  services: IServiceAccessor;
  scope: ConversationTelemetryAttachmentScope;
  children: ReactNode;
}) {
  const parentAttachment = useContext(ConversationTelemetryAttachmentContext);
  return (
    <ConversationTelemetryWorkspaceAttachment
      enabled={parentAttachment !== null}
      foregroundEnabled={parentAttachment?.foregroundEnabled ?? false}
      services={services}
      workspacePath={scope.workspacePath}
      workspaceIdentity={scope.workspaceIdentity}
      remoteSessionId={scope.remoteSessionId}
    >
      {children}
    </ConversationTelemetryWorkspaceAttachment>
  );
}

export function useScopedConversationTelemetrySupervisor(
  scope: ConversationTelemetryAttachmentScope,
): ConversationTelemetrySupervisor | null {
  const attachment = useContext(ConversationTelemetryAttachmentContext);
  return attachment && sameScope(attachment.scope, scope) ? attachment.supervisor : null;
}

export function useScopedConversationTelemetryForegroundEnabled(
  scope: ConversationTelemetryAttachmentScope,
): boolean {
  const attachment = useContext(ConversationTelemetryAttachmentContext);
  return Boolean(attachment && attachment.foregroundEnabled && sameScope(attachment.scope, scope));
}
