import type {
  RemoteConnectionFeedbackOptions,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { requestRemoteProjectConnection } from "@/remote-connection-flow/contract.js";
import { requestRetainedRemoteProjectConnection } from "@/project-sidebar/remote-project-connection.js";
import {
  formatRemoteConnectionDescription,
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
/* eslint-disable max-lines -- Bugfix: 远端 workspace 历史目前需要在一个 hook 内同时收口恢复、重连、持久化和清理流程，先保留同文件协作边界，避免为过 lint 临时拆分后引入状态回归。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BindRemoteWorkspaceSessionContextResult,
  IPlatformService,
  RemoteTarget,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
  SourceServerConnectionState,
  SourceServerManagementSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import {
  buildSshRemoteHostKey,
  createUuid,
  parseRemoteWorkspaceIdentity,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  clearRemoteWorkspaceConnectionState,
  getRemoteWorkspaceSession,
  setRemoteWorkspaceConnectionState,
  type RemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
  getRemoteWorkspaceSessionEntries,
  projectRemoteWorkspaceSessionIdentityAliases,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import type { RemoteWorkspaceRecoveryStatus } from "@/app-shell/types.js";
import {
  isWorkspaceTab,
  type TabStoreState,
  type WindowTabState,
  type WorkspaceTabState,
} from "@/store/tabStore.js";
import {
  buildRemoteWorkspacePersistPatch,
  projectRemoteConversationWorkspacePurpose,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
import {
  reconnectRemoteWorkspaceHistoryEntry,
  type ReconnectRemoteWorkspaceOptions,
  type SshReconnectCredentials,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { createRemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";
import type { RemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";
import { buildRemoteTargetFromProfile } from "@/lib/remoteConnectionWizard.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { loadConnectionProfileCredentials } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";

export { reconnectRemoteWorkspaceHistoryEntry };

export function updateRemoteWorkspaceRecoveringKeys(
  currentKeys: string[],
  tabs: WorkspaceTabState[],
  recovering: boolean,
): string[] {
  const workspaceKeys = new Set(tabs.map((tab) => buildWorkspaceSessionKey(tab)));
  if (recovering) return [...new Set([...currentKeys, ...workspaceKeys])];
  return currentKeys.filter((key) => !workspaceKeys.has(key));
}

export function shouldAttemptStartupReconnectForSourceState(
  state: SourceServerConnectionState,
): boolean {
  return state === "online";
}

export function shouldAttemptStartupReconnectForTabChange(
  tabs: readonly WindowTabState[],
  previousTabs: readonly WindowTabState[],
): boolean {
  const previousWorkspaceKeys = new Set(
    previousTabs.filter(isWorkspaceTab).map((tab) => buildWorkspaceSessionKey(tab)),
  );
  return tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      !tab.remoteSessionId &&
      parseRemoteWorkspaceIdentity(tab.workspaceIdentity ?? "")?.kind === "server" &&
      !previousWorkspaceKeys.has(buildWorkspaceSessionKey(tab)),
  );
}

/** 无错误的 Source 主动关闭是中性离线，不能制造未知连接失败并阻断原地重连。 */
export function isRemoteWorkspaceCloseFailure(
  event: Pick<
    RemoteSessionClosedEvent,
    "error" | "reasonCode" | "exitCode" | "signal" | "recoveryBudgetExhausted"
  >,
): boolean {
  return Boolean(
    event.error ||
    event.reasonCode ||
    event.recoveryBudgetExhausted ||
    (event.exitCode != null && event.exitCode !== 0) ||
    event.signal,
  );
}

export function resolveRemoteWorkspaceClosedFallback(params: {
  event: Pick<
    RemoteSessionClosedEvent,
    "error" | "recoveryAttempt" | "recoveryBudgetExhausted" | "recoveryLimit"
  >;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  defaultFallback?: string;
}): string {
  if (params.event.recoveryBudgetExhausted) {
    return params.formatMessage(
      { id: "remote.error.recoveryBudgetExhausted" },
      {
        attempt: params.event.recoveryAttempt ?? "?",
        limit: params.event.recoveryLimit ?? "?",
      },
    );
  }
  return (
    params.event.error?.trim() ||
    params.defaultFallback ||
    params.formatMessage({ id: "remote.error.connectionClosed" })
  );
}

export async function bindRemoteWorkspaceContextAndGetSession(params: {
  platform: Pick<IPlatformService, "bindRemoteWorkspaceSessionContext">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: "project" | "conversation";
}): Promise<RemoteWorkspaceSession> {
  if (!getRemoteWorkspaceSession(params.sessionId)) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  const binding = await params.platform.bindRemoteWorkspaceSessionContext?.({
    remoteSessionId: params.sessionId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    workspacePurpose: params.workspacePurpose,
  });
  // bind 会让同一 remoteSessionId 的 attachment/services 从 A 换代到 B。
  // bind 前捕获的对象仍指向 A，因此必须在 ready ACK 后按 sessionId 重新读取当前 services。
  const currentSession = getRemoteWorkspaceSession(params.sessionId);
  if (!currentSession) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  const workspaceIdentity =
    binding?.workspaceIdentity?.trim() ||
    currentSession.workspaceIdentity?.trim() ||
    params.workspaceIdentity?.trim();
  if (!workspaceIdentity) {
    throw new Error(`远程 workspace bind 未返回权威 identity: ${params.sessionId}`);
  }
  return {
    ...currentSession,
    ...(binding?.sourceServerId ? { sourceServerId: binding.sourceServerId } : {}),
    workspacePath: binding?.workspacePath ?? currentSession.workspacePath ?? params.workspacePath,
    workspaceIdentity,
    ...(binding?.workspacePurpose
      ? { workspacePurpose: binding.workspacePurpose }
      : params.workspacePurpose
        ? { workspacePurpose: params.workspacePurpose }
        : {}),
    ...(binding?.previousWorkspaceIdentity
      ? { previousWorkspaceIdentity: binding.previousWorkspaceIdentity }
      : {}),
  };
}

type BoundRemoteWorkspaceScope = Pick<
  BindRemoteWorkspaceSessionContextResult,
  "workspacePath" | "workspaceIdentity" | "previousWorkspaceIdentity" | "workspacePurpose"
>;

export function shouldPersistRemoteWorkspaceFailure(params: {
  pendingReconnectRequestIds: ReadonlyMap<string, string>;
  sessionEntry: RemoteWorkspaceSessionEntry;
  workspaceKey: string;
}): boolean {
  if (params.sessionEntry.target.kind !== "wsl") {
    return true;
  }

  // WSL 偶发断连时，旧 session 的关闭事件可能会晚于手动重连流程。
  // 只要当前 workspace 已经有 pending reconnect，就先别把 failed 写死到 setting，
  // 让最终结果由这次重连成功/失败决定。
  return !params.pendingReconnectRequestIds.has(params.workspaceKey);
}
interface RemoteWorkspaceTabStoreReader {
  getState(): {
    tabs: WindowTabState[];
  };
}

interface OpenRemoteWorkspaceFromHistoryParams {
  workspaceKey: string;
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  inflightReconnectWorkspaceKeys: Set<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
  ) => Promise<string>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<BoundRemoteWorkspaceScope>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
  }) => void;
  createReconnectRequestId?: () => string;
  pendingReconnectRequestIds?: Map<string, string>;
  reconnectImpl?: typeof reconnectRemoteWorkspaceHistoryEntry;
}

interface ReconnectRemoteWorkspaceByKeyParams {
  workspaceKey: string;
  canUseRemoteWorkspace: boolean;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  options?: ReconnectRemoteWorkspaceOptions;
}

export async function reconnectRemoteWorkspaceByKey({
  workspaceKey,
  canUseRemoteWorkspace,
  getRemoteSessions,
  runReconnectRemoteWorkspace,
  options,
}: ReconnectRemoteWorkspaceByKeyParams): Promise<boolean> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    throw new Error(`远程 workspace 不在当前窗口中，无法重连: ${workspaceKey}`);
  }

  await runReconnectRemoteWorkspace(sessionEntry, options);
  return true;
}

export function collectSshReconnectGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  sessions: RemoteWorkspaceSessionEntry[];
  tabs: WindowTabState[];
}): RemoteWorkspaceSessionEntry[] {
  if (params.selected.target.kind !== "ssh") {
    return [params.selected];
  }
  const remoteHostKey = buildSshRemoteHostKey(params.selected.target);
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      if (!isWorkspaceTab(tab) || tab.remoteSessionId) {
        return [];
      }
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const reconnectGroup = params.sessions.filter(
    (entry) =>
      entry.target.kind === "ssh" &&
      buildSshRemoteHostKey(entry.target) === remoteHostKey &&
      disconnectedWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  if (!reconnectGroup.some((entry) => buildWorkspaceSessionKey(entry) === selectedWorkspaceKey)) {
    return [params.selected];
  }

  // 历史记录顺序不代表本次重连发起者。initiator 必须固定在首位，
  // 否则并发加载凭据时 sibling 可能先创建共享 Host，导致整组误用旧凭据。
  return [
    params.selected,
    ...reconnectGroup.filter((entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey),
  ];
}

interface RemoteWorkspaceReconnectRendererState {
  attemptedWorkspaceKeys: Set<string>;
  currentRendererDisconnectedSourceServerIds: Set<string>;
  pendingTerminallyDisconnectedSourceServerIds: Set<string>;
  observedOnlineSourceServerIds: Set<string>;
}

export function collectStartupRemoteWorkspaceReconnectGroups(params: {
  sessions: RemoteWorkspaceSessionEntry[];
  manuallyOpeningWorkspaceTabId?: string;
  tabs: WindowTabState[];
  attemptedWorkspaceKeys: ReadonlySet<string>;
  onlineSourceServerIds: ReadonlySet<string>;
  currentRendererDisconnectedSourceServerIds?: ReadonlySet<string>;
  pendingTerminallyDisconnectedSourceServerIds?: ReadonlySet<string>;
}): Array<{ sourceServerId: string; entries: RemoteWorkspaceSessionEntry[] }> {
  // Bug 原因：设备级 7 天门禁已由 Host 启动重连按 lastOnlineAt 执行；这里再按工作区
  // lastOpenedAt 过滤，只会让同一设备下部分 tab 上线、部分停留在未连接。Renderer 挂回
  // 只看 open membership、稳定 identity 与设备 online，不再按工作区年龄过滤。
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      // 手动向导持有该 tab 的绑定意图，Source online 不能同时重复创建 attachment。
      if (tab.id === params.manuallyOpeningWorkspaceTabId) return [];
      if (!isWorkspaceTab(tab) || tab.remoteSessionId || tab.workspacePurpose === "conversation")
        return [];
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const resolveEligibleSourceServerId = (session: RemoteWorkspaceSessionEntry): string | null => {
    if (session.workspacePurpose === "conversation") return null;
    const workspaceKey = buildWorkspaceSessionKey(session);
    const parsed = session.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(session.workspaceIdentity)
      : null;
    const sourceServerId = parsed?.kind === "server" ? parsed.sourceServerId : undefined;
    const disconnectedInCurrentRenderer = Boolean(
      sourceServerId && params.currentRendererDisconnectedSourceServerIds?.has(sourceServerId),
    );
    if (
      (sourceServerId &&
        params.pendingTerminallyDisconnectedSourceServerIds?.has(sourceServerId)) ||
      !disconnectedWorkspaceKeys.has(workspaceKey) ||
      (params.attemptedWorkspaceKeys.has(workspaceKey) && !disconnectedInCurrentRenderer)
    ) {
      return null;
    }
    return sourceServerId && params.onlineSourceServerIds.has(sourceServerId)
      ? sourceServerId
      : null;
  };
  const groups = new Map<string, RemoteWorkspaceSessionEntry[]>();
  for (const session of params.sessions) {
    const sourceServerId = resolveEligibleSourceServerId(session);
    if (!sourceServerId) {
      continue;
    }
    // Bug 根因：断开会把保留工作区全部写成 failed，冷启动再以 connected 历史准入会
    // 永久跳过已 online 的设备。Host online 是连接权威，历史结果不再否决 open attachment 恢复。
    const entries = groups.get(sourceServerId) ?? [];
    entries.push(session);
    groups.set(sourceServerId, entries);
  }
  return [...groups].map(([sourceServerId, entries]) => ({
    sourceServerId,
    entries,
  }));
}

export function updateStartupRemoteWorkspaceReconnectAttemptsForSourceState(params: {
  state: {
    state: SourceServerConnectionState;
    sourceServerId?: string;
  };
  onlineSourceServerIds: ReadonlySet<string>;
  sessions: readonly RemoteWorkspaceSessionEntry[];
  attemptedWorkspaceKeys: Set<string>;
}): void {
  const sourceServerId = params.state.sourceServerId;
  if (
    !sourceServerId ||
    params.state.state === "online" ||
    params.onlineSourceServerIds.has(sourceServerId)
  ) {
    return;
  }
  // Bug 原因：启动恢复的去重标记过去覆盖整个 Renderer 生命周期，设备断开后仍未失效。
  // 下一次 Source 虽然恢复为 online，已有 workspace 会继续被当成“尝试过”而跳过重挂。
  // 设备真正离开 online 时只清理该 Source 的标记，保留同一连接周期内的一次性防重语义。
  for (const session of params.sessions) {
    const parsed = session.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(session.workspaceIdentity)
      : null;
    if (parsed?.kind === "server" && parsed.sourceServerId === sourceServerId) {
      params.attemptedWorkspaceKeys.delete(buildWorkspaceSessionKey(session));
    }
  }
}

export async function reconnectRemoteWorkspaceGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  reconnectGroup: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  const siblings = params.reconnectGroup.filter(
    (entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey,
  );

  if (params.selected.target.kind !== "ssh") {
    try {
      await params.reconnectEntry(params.selected, {
        ...params.options,
        throwOnFailure: true,
      });
    } catch (error) {
      if (params.options?.throwOnFailure) {
        throw error;
      }
    }
    return;
  }

  type InitiatorHostGate =
    | { status: "ready"; credentials: SshReconnectCredentials }
    | { status: "skipped" }
    | { status: "failed"; error: unknown };
  let hostReadyCredentials: SshReconnectCredentials | undefined;
  let resolveHostReady!: (result: InitiatorHostGate) => void;
  const hostReadyPromise = new Promise<InitiatorHostGate>((resolve) => {
    resolveHostReady = resolve;
  });

  // 组内并发连接会让最先完成 credential load 的 sibling 抢建共享 Host。
  // initiator 先负责把 Host 建到 ready；后续 provider/task 初始化不再阻塞 sibling attachment。
  const initiatorPromise = params.reconnectEntry(params.selected, {
    ...params.options,
    throwOnFailure: true,
    onSshHostReady: (credentials) => {
      if (hostReadyCredentials) {
        return;
      }
      hostReadyCredentials = credentials;
      resolveHostReady({ status: "ready", credentials });
    },
  });
  const initiatorFinishedBeforeReady = initiatorPromise.then<InitiatorHostGate, InitiatorHostGate>(
    (didReconnect) => {
      if (hostReadyCredentials) {
        return { status: "ready", credentials: hostReadyCredentials };
      }
      return didReconnect
        ? {
            status: "failed",
            error: new Error("SSH initiator completed without reporting Host ready"),
          }
        : { status: "skipped" };
    },
    (error: unknown) =>
      hostReadyCredentials
        ? { status: "ready", credentials: hostReadyCredentials }
        : { status: "failed", error },
  );
  const hostGate = await Promise.race([hostReadyPromise, initiatorFinishedBeforeReady]);
  if (hostGate.status !== "ready") {
    if (hostGate.status === "failed" && params.options?.throwOnFailure) {
      throw hostGate.error;
    }
    return;
  }

  // sibling 只复用 initiator credential 命中 ready Host，不再读取各自历史 credential；
  // path/provider/task 初始化与 initiator 并行并保持独立失败语义。
  const siblingPromise = Promise.allSettled(
    siblings.map((entry) =>
      params.reconnectEntry(entry, {
        ...params.options,
        activateWorkspaceAfterReconnect: false,
        sshCredentialsOverride: hostGate.credentials,
      }),
    ),
  );
  const [initiatorResult] = await Promise.all([
    initiatorPromise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    siblingPromise,
  ]);
  if (initiatorResult.status === "rejected" && params.options?.throwOnFailure) {
    throw initiatorResult.error;
  }
}

export async function restoreSourceRemoteWorkspaceGroup(params: {
  entries: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  // Source 已由 Management 确认为 online；此处只恢复 logical attachments，不再用某个
  // workspace 充当 physical Host gate。成员 live/inflight 返回 false 只结算自己，不能终止 siblings。
  for (const entry of params.entries) {
    try {
      await params.reconnectEntry(entry, params.options);
    } catch (error) {
      if (params.options?.throwOnFailure) throw error;
    }
  }
}

/** tab 是目录 owner 的唯一事实；只认仍注册在 store 中的 session，断连残留的 id 不算 owner。 */
function readLiveRemoteWorkspaceOwner(
  tabStoreApi: RemoteWorkspaceTabStoreReader,
  target: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
): string | undefined {
  const key = buildWorkspaceSessionKey(target);
  const sessionId = tabStoreApi
    .getState()
    .tabs.filter(isWorkspaceTab)
    .find((tab) => buildWorkspaceSessionKey(tab) === key)?.remoteSessionId;
  return sessionId && getRemoteWorkspaceSession(sessionId) ? sessionId : undefined;
}

function shouldKeepRemoteWorkspaceInTabs(params: {
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const reconnectWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return params.tabStoreApi
    .getState()
    .tabs.some(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        ((tab.workspaceIdentity?.trim() || tab.workspacePath) === reconnectWorkspaceKey ||
          tab.workspacePath === params.workspacePath),
    );
}

export async function cancelPendingRemoteReconnectsForWorkspaceKeys(params: {
  workspaceKeys: string[];
  pendingRequestIds: Map<string, string>;
  cancelPendingRemoteConnection?: (requestId?: string) => Promise<void>;
  logger: Pick<typeof logger, "warn">;
}): Promise<void> {
  const requestIds = params.workspaceKeys.flatMap((workspaceKey) => {
    const requestId = params.pendingRequestIds.get(workspaceKey);
    if (!requestId) {
      return [];
    }

    params.pendingRequestIds.delete(workspaceKey);
    return [requestId];
  });

  if (!params.cancelPendingRemoteConnection || requestIds.length === 0) {
    return;
  }

  await Promise.all(
    requestIds.map(async (requestId) => {
      try {
        await params.cancelPendingRemoteConnection?.(requestId);
      } catch (error) {
        params.logger.warn("[Root] 取消远程 workspace 重连失败", {
          requestId,
          error,
        });
      }
    }),
  );
}

export async function openRemoteWorkspaceFromHistoryEntry({
  workspaceKey,
  tabStoreApi,
  getRemoteSessions,
  inflightReconnectWorkspaceKeys,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  bindRemoteWorkspaceScope,
  disposeRemoteWorkspaceSession,
  addTab,
  commitRemoteWorkspaceSessionMutation,
  resetLogsForWorkspaceKey,
  createReconnectRequestId,
  pendingReconnectRequestIds,
  reconnectImpl = reconnectRemoteWorkspaceHistoryEntry,
  onWorkspaceActivated,
}: OpenRemoteWorkspaceFromHistoryParams): Promise<void> {
  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    return;
  }

  if (inflightReconnectWorkspaceKeys.has(workspaceKey)) {
    return;
  }

  const existingWorkspaceTab = tabStoreApi
    .getState()
    .tabs.find(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
    );
  if (existingWorkspaceTab?.remoteSessionId) {
    activateTabByPath(existingWorkspaceTab.workspacePath, {
      workspaceIdentity: existingWorkspaceTab.workspaceIdentity,
    });
    return;
  }

  // 选择页远程历史与侧栏重连都属于“恢复已有 remote workspace”语义。
  // 如果这里缺少“仍需保留该 workspace”的二次校验，用户在重连中移除后仍会被成功回调重新加回 tab。
  // 这里复用同一套 shouldKeep 判定，保证两条入口的竞态行为一致。
  resetLogsForWorkspaceKey(workspaceKey);
  inflightReconnectWorkspaceKeys.add(workspaceKey);
  const requestId = createReconnectRequestId?.();
  if (requestId) {
    pendingReconnectRequestIds?.set(workspaceKey, requestId);
  }
  try {
    await reconnectImpl({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath,
      bindRemoteWorkspaceIdentity,
      upsertWorkspaceTab: addTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions,
      logger,
      toast,
      shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
        shouldKeepRemoteWorkspaceInTabs({
          tabStoreApi,
          workspacePath,
          workspaceIdentity,
        }),
      readLiveWorkspaceOwner: (target) => readLiveRemoteWorkspaceOwner(tabStoreApi, target),
      onWorkspaceActivated: (target) => {
        logger.debug("[Root] 远程历史 workspace ready，提交 tab 与 draft 激活", target);
        onWorkspaceActivated?.(target);
      },
      options: {
        // 历史入口过去只回填 connected tab，却没有提交 tab activation 和 draft owner，
        // 所以连接成功后右侧仍停留在旧 workspace。共享 helper 只会在 services ready 后执行此提交，
        // 不会提前暴露缺少 remoteSessionId 的 remote-waiting tab。
        activateWorkspaceAfterReconnect: true,
        showErrorToast: true,
        requestId,
      },
    });
  } finally {
    inflightReconnectWorkspaceKeys.delete(workspaceKey);
    if (requestId && pendingReconnectRequestIds?.get(workspaceKey) === requestId) {
      pendingReconnectRequestIds.delete(workspaceKey);
    }
  }
}

export async function selectRemoteWorkspaceProjectFromDialog({
  canUseRemoteWorkspace,
  sessionId,
  path,
  preparedWorkspaceIdentity,
  draftProjectId,
  localWorkspacePath,
  loadingMessage,
  getRemoteWorkspaceSession,
  connectionTarget,
  getWorkspaceTabs,
  restoringWorkspaceTabId,
  resolveRemoteWorkspaceCanonicalPath,
  activateTabByPath,
  handleCancelRemoteProject,
  bindRemoteWorkspaceScope,
  workspacePurpose,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  addTab,
  onWorkspaceActivated,
  isCurrent,
}: {
  canUseRemoteWorkspace: boolean;
  isCurrent?: () => boolean | Promise<boolean>;
  sessionId: string;
  path: string;
  preparedWorkspaceIdentity?: string;
  draftProjectId?: string | null;
  workspacePurpose?: "project" | "conversation";
  localWorkspacePath?: string;
  loadingMessage: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  connectionTarget?: Parameters<IPlatformService["connectRemote"]>[0];
  getWorkspaceTabs: () => WindowTabState[];
  /** 手动向导正在重连的 tab；目标与它同 workspace 时挂回原会话，不新建任务。 */
  restoringWorkspaceTabId?: string;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<BoundRemoteWorkspaceScope>;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  bindRemoteWorkspacePath: (workspacePath: string, sessionId: string) => void;
  bindRemoteWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
    projectId?: string | null;
  }) => void;
}): Promise<void> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const assertCurrent = async () => {
    // 原项目成员由 Host 持有；异步校验必须等到结果，不能把 Promise 当作有效意图。
    if ((await isCurrent?.()) === false)
      throw Object.assign(new Error("project.navigation-cancelled"), {
        code: "remote-connection-canceled",
      });
  };
  await assertCurrent();
  const remoteSession = getRemoteWorkspaceSession(sessionId);
  if (!remoteSession) {
    throw new Error(loadingMessage);
  }
  const remoteTarget = connectionTarget ?? remoteSession.target;
  if (!remoteTarget) {
    // 手机 web relay 复用 remote session store 只做服务路由，没有本地可重连 target。
    // 远程历史的选目录/持久化流程必须有 target，缺失时直接阻断，避免把无 target 的桥接 session 写进历史。
    throw new Error(`远程 workspace session 缺少连接目标: ${sessionId}`);
  }

  // Bug 原因：项目已经给出 Host 的 cwd/identity，再 realpath 会将路径别名拆成两个 scope。
  // 只有普通目录选择解析用户路径；已准备的目录仍由 Host bind 校验，不能放宽 owner 判断。
  const canonicalPath = preparedWorkspaceIdentity
    ? path
    : await resolveRemoteWorkspaceCanonicalPath(sessionId, path);
  // Bug 原因：Renderer 过去用 transport target 生成 route-derived identity，与 Host 已绑定的
  // remote:server:* stable identity 分裂。先完成 Host bind，再只消费权威 scope。
  // 这次 bind 同时决定手机远控能否桥接：新建连接不带 context 时 main descriptor 停在连接根目录 "/"，
  // bridge 按 tab 的 path/identity 三元比对 descriptor，缺少 bind 会被 REMOTE_WORKSPACE_IDENTITY_MISMATCH
  // 拒绝（3.12.0 曾因此连不上远程项目）。bind 失败由 hook 侧回收 session 并抛回弹窗，不落库、不建 tab。
  await assertCurrent();
  const boundScope = await bindRemoteWorkspaceScope(
    sessionId,
    canonicalPath,
    preparedWorkspaceIdentity,
    workspacePurpose ?? "project",
  );
  await assertCurrent();
  const workspacePath = boundScope.workspacePath;
  const workspaceIdentity = boundScope.workspaceIdentity;
  const existingWorkspaceTab = getWorkspaceTabs().find(
    (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.workspacePath === workspacePath &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceIdentity,
  );
  // Bug 根因：会话横幅“重新连接”→ 向导“重试”成功后走的是普通“打开项目”路径，激活回调
  // 没带 restoreSelection，Root 据此把原会话覆盖成空白草稿（RDUX-09 要求挂回保持原选择）。
  // bcc1ae5fc8 曾在调用点补过这层判断，合并时丢失；现在由本函数按向导持有的 tab 意图统一决定。
  const restoringTab = restoringWorkspaceTabId
    ? getWorkspaceTabs().find((tab) => tab.id === restoringWorkspaceTabId)
    : undefined;
  const activation = {
    workspacePath,
    workspaceIdentity,
    ...(draftProjectId !== undefined ? { projectId: draftProjectId } : {}),
    // 显式项目草稿与恢复旧会话互斥；后台重连中的同一 tab 不能覆盖新建意图。
    ...(draftProjectId === undefined &&
    restoringTab &&
    isWorkspaceTab(restoringTab) &&
    buildWorkspaceSessionKey(restoringTab) ===
      buildWorkspaceSessionKey({ workspacePath, workspaceIdentity })
      ? { restoreSelection: true }
      : {}),
  };

  if (
    existingWorkspaceTab?.remoteSessionId &&
    activateTabByPath(workspacePath, { workspaceIdentity })
  ) {
    if (
      workspacePurpose === "conversation" &&
      existingWorkspaceTab.workspacePurpose !== "conversation"
    ) {
      addTab(workspacePath, {
        remoteSessionId: existingWorkspaceTab.remoteSessionId,
        remoteTarget: stripRemoteTargetSecrets(remoteTarget),
        workspaceIdentity,
        workspacePurpose: "conversation",
      });
    }
    clearRemoteWorkspaceConnectionState(workspaceIdentity);
    if (boundScope.previousWorkspaceIdentity) {
      clearRemoteWorkspaceConnectionState(boundScope.previousWorkspaceIdentity);
    }
    onWorkspaceActivated?.(activation);
    // Bug 原因：项目历史会复用当前 owner；旧分支将它误当临时连接取消，导致任务重开后断线。
    if (existingWorkspaceTab.remoteSessionId !== sessionId)
      await handleCancelRemoteProject(sessionId);
    return;
  }

  // 断连 tab 以前会在 provider/session 绑定完成前先被 activateTabByPath 激活，
  // V4PaneConversationProvider 此时只能得到 remote-waiting，因 rpcReady=false 返回 null，
  // 右侧便会先空白，等后续 addTab 写回 remoteSessionId 后才出现新建对话。
  // 断连 tab 与首次连接统一等到服务绑定完成后再由 addTab 原子激活，避免暴露半连接 workspace。

  // Bug 原因：远程首次选目录时如果先写 lastWorkspaceSession，再执行 Host bind，
  // bind 失败会留下“记录显示已连接但实际 session 已回收”的脏状态。
  // 这里先完成 Host bind 成功，再提交 connected 状态，保证持久化状态与真实连接一致。
  await commitRemoteWorkspaceSessionMutation(
    buildRemoteWorkspaceSessionMutation({
      remoteSessions: getRemoteSessions(),
      workspacePath,
      localWorkspacePath,
      workspaceIdentity,
      target: remoteTarget,
      workspacePurpose: workspacePurpose ?? "project",
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    }),
  );

  await assertCurrent();
  bindRemoteWorkspacePath(workspacePath, sessionId);
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
  // Bug 原因：旧版 route tab 与新版 stable identity 不相等时，直接 addTab 会制造第二个
  // workspace。Host 返回的 previousWorkspaceIdentity 只用于 TabStore 原地 rekey，保留原 tab。
  addTab(workspacePath, {
    remoteSessionId: sessionId,
    remoteTarget: stripRemoteTargetSecrets(remoteTarget),
    workspaceIdentity,
    ...(boundScope.previousWorkspaceIdentity
      ? { previousWorkspaceIdentity: boundScope.previousWorkspaceIdentity }
      : {}),
    localWorkspacePath,
    workspacePurpose: workspacePurpose ?? "project",
  });
  // Bug 根因：设备重连弹窗直接走 workspace select，不经过侧栏 reconnect wrapper；只写回
  // remoteSessionId 而不清 overlay 会让已恢复的 task 继续显示“远程连接暂不可用”。attachment
  // 已绑定成功后立即按 stable identity 收敛连接事实，legacy rekey 残留也一并清理。
  clearRemoteWorkspaceConnectionState(workspaceIdentity);
  if (boundScope.previousWorkspaceIdentity) {
    clearRemoteWorkspaceConnectionState(boundScope.previousWorkspaceIdentity);
  }
  // 修复原因：旧链路等待无人消费的列表缓存，导致 tab 与草稿 owner 交接分叉。
  // attachment 和 tab 已就绪后立即提交同一 workspaceKey 的草稿，项目树自行读取权威行。
  onWorkspaceActivated?.(activation);
}

export async function openRemoteConversationWorkspace(params: {
  sessionId: string;
  sourceServerId?: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  getSettings: () => Promise<
    Pick<AppSettings, "sourceServerWorkspaceHistory" | "connectionProfiles">
  >;
  loadCredential: (key: string) => Promise<string | null>;
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
  ) => Promise<string>;
  waitForRemoteWorkspaceSessionReady: (sessionId: string) => Promise<void>;
  ensureConversationWorkspace: (sourceServerId: string) => Promise<{ path: string }>;
  selectRemoteWorkspace: (
    sessionId: string,
    workspacePath: string,
    workspacePurpose: "conversation",
  ) => Promise<void>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
}): Promise<void> {
  const initialSession = params.getRemoteWorkspaceSession(params.sessionId);
  let conversationSessionId = params.sessionId;
  let remoteSession = initialSession;
  let resolvedSourceServerId = params.sourceServerId ?? remoteSession?.sourceServerId;
  let ownedConversationSessionId: string | undefined;

  try {
    // 每次新建使用独立 cwd；已绑定的 project / conversation 都必须保留原 logical scope。
    // 本函数创建的新 session
    // 在成功交给 tab 前由本函数独占，任何 ensure/bind/provider 失败都必须在这里回收。
    // Bug 根因：刚连接但尚未 bind 的 session 也携带 bootstrap 根路径；仅凭 workspacePath
    // 会把它误判成 project 并查询不存在的 project history。purpose 才是 logical scope 的权威。
    if (remoteSession?.workspacePath && remoteSession.workspacePurpose) {
      const settings = await params.getSettings();
      const history = (settings.sourceServerWorkspaceHistory ?? []).find(
        (entry) =>
          entry.workspacePath === remoteSession?.workspacePath &&
          entry.workspaceIdentity === remoteSession?.workspaceIdentity,
      );
      const profile = history?.profileId
        ? settings.connectionProfiles?.find(
            (candidate) => candidate.profileId === history.profileId,
          )
        : undefined;
      if (!profile) {
        throw new Error("Remote project connection profile is unavailable");
      }
      const target = buildRemoteTargetFromProfile(profile);
      const credentials = await loadConnectionProfileCredentials({
        profile,
        loadCredential: params.loadCredential,
      });
      const targetWithCredentials =
        target.kind === "ssh" && credentials
          ? {
              ...target,
              ...(credentials.password ? { password: credentials.password } : {}),
              ...(credentials.privateKeyPassphrase
                ? { privateKeyPassphrase: credentials.privateKeyPassphrase }
                : {}),
            }
          : target;
      conversationSessionId = await params.connectRemoteWorkspaceTarget(targetWithCredentials);
      ownedConversationSessionId = conversationSessionId;
      await params.waitForRemoteWorkspaceSessionReady(conversationSessionId);
      remoteSession = params.getRemoteWorkspaceSession(conversationSessionId);
      resolvedSourceServerId = resolvedSourceServerId ?? profile.sourceServerId;
    }
    if (!resolvedSourceServerId) {
      throw new Error("Remote conversation requires an identified Source Server");
    }
    const conversation = await params.ensureConversationWorkspace(resolvedSourceServerId);
    await params.selectRemoteWorkspace(conversationSessionId, conversation.path, "conversation");
    ownedConversationSessionId = undefined;
  } catch (error) {
    if (ownedConversationSessionId) {
      await params
        .disposeRemoteWorkspaceSession(ownedConversationSessionId)
        .catch((disposeError) => {
          logger.warn("[Root] 回收失败的远程 conversation session 失败", {
            sessionId: ownedConversationSessionId,
            error: disposeError,
          });
        });
    }
    throw error;
  }
}

export async function resolveSourceRemoteConversationWorkspaceProjection(params: {
  sourceServerId: string;
  remoteSessions: readonly RemoteWorkspaceSessionEntry[];
  conversationWorkspaceMap: AppSettings["remoteConversationWorkspaceBySourceServerId"];
  ensureConversationWorkspace: (sourceServerId: string) => Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
}): Promise<{
  conversationWorkspaceMap: NonNullable<AppSettings["remoteConversationWorkspaceBySourceServerId"]>;
  remoteSessions: RemoteWorkspaceSessionEntry[];
  updatedEntries: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
}> {
  let conversationWorkspaceMap = params.conversationWorkspaceMap ?? {};
  if (!conversationWorkspaceMap[params.sourceServerId]) {
    const conversation = await params.ensureConversationWorkspace(params.sourceServerId);
    conversationWorkspaceMap = {
      ...conversationWorkspaceMap,
      [params.sourceServerId]: {
        workspacePath: conversation.path,
        lastResolvedAt: Date.now(),
      },
    };
  }
  return {
    conversationWorkspaceMap,
    ...projectRemoteConversationWorkspacePurpose(params.remoteSessions, conversationWorkspaceMap),
  };
}

export function useRemoteWorkspaceHistory({
  intl,
  services,
  platform,
  supportsSettings,
  isDesktop = false,
  allowRemoteWorkspace = true,
  ensureConversationWorkspaceOnRestore = false,
  deferInactiveWorkspaceRestore = false,
  unavailableWorkspacePath,
  tabStoreApi,
  activateTabByPath,
  addTab,
  persistenceGate,
  onWorkspaceActivated,
  onOpenRemoteConnection,
  manuallyOpeningWorkspaceTabId,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  services: IServiceAccessor;
  platform: IPlatformService;
  supportsSettings: boolean;
  isDesktop?: boolean;
  allowRemoteWorkspace?: boolean;
  ensureConversationWorkspaceOnRestore?: boolean;
  /** 仅 Desktop 主窗口：输入可用后再把 inactive workspace 加入 sidebar/task 数据源。 */
  deferInactiveWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  persistenceGate?: WorkspacePersistenceGate;
  /** 仅用于从已保存 Profile 发起普通连接；实际连接仍由唯一 SSHDialog 承载。 */
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
    projectId?: string | null;
  }) => void;
  manuallyOpeningWorkspaceTabId?: string;
}) {
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const allowRemoteWorkspaceRestore = canUseRemoteWorkspace;
  const [remoteWorkspaceSessions, setRemoteWorkspaceSessions] = useState<
    RemoteWorkspaceSessionEntry[]
  >([]);
  const remoteWorkspaceSessionsRef = useRef<RemoteWorkspaceSessionEntry[]>([]);
  const manuallyOpeningWorkspaceTabIdRef = useRef(manuallyOpeningWorkspaceTabId);
  manuallyOpeningWorkspaceTabIdRef.current = manuallyOpeningWorkspaceTabId;
  const pendingCredentialDeletesRef = useRef<Set<string>>(new Set());
  const flushPendingCredentialDeletes = useCallback(async () => {
    const credentialKeys = [...pendingCredentialDeletesRef.current];
    pendingCredentialDeletesRef.current.clear();
    await Promise.all(
      credentialKeys.map(async (credentialKey) => {
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 延迟删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }),
    );
  }, [services.credentialService]);
  if (persistenceGate) {
    persistenceGate.onCanPersist = flushPendingCredentialDeletes;
  }
  const [reconnectingRemoteWorkspaceKeys, setReconnectingRemoteWorkspaceKeys] = useState<string[]>(
    [],
  );
  const [remoteWorkspaceRecoveryByWorkspaceKey, setRemoteWorkspaceRecoveryByWorkspaceKey] =
    useState<Record<string, RemoteWorkspaceRecoveryStatus>>({});
  const inflightReconnectWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const pendingReconnectRequestIdsRef = useRef<Map<string, string>>(new Map());
  const pendingConnectionTargetsBySessionIdRef = useRef<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >(new Map());
  // R3 只允许每个 stable workspace 在本次 Renderer 生命周期尝试一次；同时复用旧 ref hook slot，
  // 避免 Fast Refresh 把后续 useState 落到历史 useRef 位置。不能按 Source 去重，否则 active-first
  // 首帧只恢复一个 tab 时，会永久漏掉稍后进入 TabStore 的同 Source sibling。
  const remoteStartupReconnectRefreshCompatibilityRef = useRef<
    Set<string> | RemoteWorkspaceReconnectRendererState
  >(new Set());
  const remoteWorkspaceReconnectRendererState =
    remoteStartupReconnectRefreshCompatibilityRef.current instanceof Set
      ? {
          attemptedWorkspaceKeys: remoteStartupReconnectRefreshCompatibilityRef.current,
          currentRendererDisconnectedSourceServerIds: new Set<string>(),
          pendingTerminallyDisconnectedSourceServerIds: new Set<string>(),
          observedOnlineSourceServerIds: new Set<string>(),
        }
      : remoteStartupReconnectRefreshCompatibilityRef.current;
  // 复用历史 ref hook slot，避免新增 useRef 破坏 Fast Refresh 的 Hook 顺序；扩展出的状态
  // 只属于当前 Renderer 生命周期，不会把 failed history 持久化成自动恢复资格。
  remoteStartupReconnectRefreshCompatibilityRef.current = remoteWorkspaceReconnectRendererState;
  const {
    logsByWorkspaceKey: reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  } = useReconnectingRemoteWorkspaceLogs({
    platform,
    reconnectingWorkspaceKeys: reconnectingRemoteWorkspaceKeys,
    resolveWorkspaceTargetByKey: (workspaceKey) =>
      remoteWorkspaceSessionsRef.current.find(
        (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
      )?.target ?? null,
    resolveWorkspaceRequestIdByKey: (workspaceKey) =>
      pendingReconnectRequestIdsRef.current.get(workspaceKey) ?? null,
  });

  const syncPersistedWorkspaceSession = useCallback(
    async (nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[]) => {
      setRemoteWorkspaceSessions([...nextRemoteSessions]);
      remoteWorkspaceSessionsRef.current = [...nextRemoteSessions];

      if (!supportsSettings) {
        return;
      }
      if (persistenceGate && !persistenceGate.canPersist) {
        return;
      }

      await services.settingService.update(
        buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), nextRemoteSessions),
      );
    },
    [persistenceGate, services.settingService, supportsSettings, tabStoreApi],
  );

  const commitRemoteWorkspaceSessionMutation = useCallback(
    async (mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>) => {
      for (const credentialKey of mutation.credentialKeysToDelete) {
        if (persistenceGate && !persistenceGate.canPersist) {
          pendingCredentialDeletesRef.current.add(credentialKey);
          continue;
        }
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }

      for (const credential of mutation.credentialsToSave) {
        await services.credentialService.save(credential.key, credential.value);
      }

      await syncPersistedWorkspaceSession(mutation.nextRemoteSessions);
      return mutation.entry;
    },
    [persistenceGate, services.credentialService, syncPersistedWorkspaceSession],
  );

  const waitForRemoteWorkspaceSessionReady = useCallback(async (sessionId: string) => {
    if (getRemoteWorkspaceSession(sessionId)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const pollTimer = window.setInterval(() => {
        if (getRemoteWorkspaceSession(sessionId)) {
          window.clearInterval(pollTimer);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 3000) {
          window.clearInterval(pollTimer);
          reject(new Error(`等待远程 workspace session 就绪超时: ${sessionId}`));
        }
      }, 50);
    });
  }, []);

  const connectRemoteWorkspaceTarget = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
      feedback?: RemoteConnectionFeedbackOptions,
    ) => {
      const result = await platform.connectRemote(target, requestId, context);
      if (!result.success) {
        const error = new Error(getErrorMessage(result.error || "Connection failed")) as Error & {
          code?: string;
          retryable?: boolean;
          profileId?: string;
          resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
        };
        if (result.reasonCode) error.code = result.reasonCode;
        if (result.retryable !== undefined) error.retryable = result.retryable;
        if (result.profileId) error.profileId = result.profileId;
        if (result.resolvedWslTarget) error.resolvedWslTarget = result.resolvedWslTarget;
        throw error;
      }

      if (!result.sessionId) {
        throw new Error("Remote session was not created");
      }

      // 远程连接成功只代表 main/host 已经建好 session，
      // renderer 侧的 MessagePort 仍然可能在下一拍才注册进 zustand store。
      // 如果此时立刻 addTab，会短暂走到本地 services，导致首屏读目录/预热 ZCode Agent 命中错误服务。
      // 这里等 session 真正挂进 store 再继续。
      await waitForRemoteWorkspaceSessionReady(result.sessionId);
      if (!context) {
        // 共享 Host 只向 renderer store 回传脱敏 target；完整凭据只在选目录流程完成前临时保留。
        // Host 复用时本次密码从未参与认证；选目录也只能持久化实际连接的脱敏目标。
        pendingConnectionTargetsBySessionIdRef.current.set(
          result.sessionId,
          result.reusedConnectionTarget ?? target,
        );
      }
      if (result.reusedConnectionTarget && feedback?.announceReusedConnection) {
        toast(
          intl.formatMessage(
            { id: "remote.reusedConnection" },
            { connection: formatRemoteConnectionDescription(result.reusedConnectionTarget) },
          ),
          { variant: "info", durationMs: 8000 },
        );
      }
      return result.sessionId;
    },
    [intl, platform, waitForRemoteWorkspaceSessionReady],
  );

  const resolveRemoteWorkspaceCanonicalPath = useCallback(
    async (sessionId: string, workspacePath: string): Promise<string> => {
      const remoteSession = getRemoteWorkspaceSession(sessionId);
      if (!remoteSession) {
        return workspacePath;
      }

      try {
        // 同一目录可能通过符号链接别名输入（例如 /dev 与 /home/dev），
        // 之前直接持久化用户输入会把同一 workspace 识别成两个身份。
        // 这里在远端 host 上做一次 realpath 归一化，再参与 identity 计算与持久化。
        return await remoteSession.services.fileService.resolvePath({
          path: workspacePath,
        });
      } catch {
        return workspacePath;
      }
    },
    [],
  );

  const buildPersistedTabPatch = useCallback(
    (state: TabStoreState) =>
      buildRemoteWorkspacePersistPatch(state, remoteWorkspaceSessionsRef.current),
    [],
  );

  const handleCancelRemoteProject = useCallback(
    async (sessionId: string) => {
      try {
        await platform.disposeRemoteSession(sessionId);
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
        // 远程目录选择如果在确认前就取消，session 释放失败也不能把前端状态卡在“仍有一个待选远程 session”。
        // 这里始终清掉本地映射，避免下次再次打开弹窗时复用到一条已经失效的 session 记录。
        unregisterRemoteWorkspaceSession(sessionId);
      }
    },
    [platform],
  );

  const bindRemoteWorkspaceScope = useCallback(
    async (
      sessionId: string,
      workspacePath: string,
      workspaceIdentity?: string,
      workspacePurpose?: "project" | "conversation",
    ) => {
      try {
        const remoteSession = await bindRemoteWorkspaceContextAndGetSession({
          platform,
          sessionId,
          workspacePath,
          workspaceIdentity,
          workspacePurpose,
        });
        const boundWorkspacePath = remoteSession.workspacePath ?? workspacePath;
        const boundWorkspaceIdentity = remoteSession.workspaceIdentity;
        if (!boundWorkspaceIdentity) {
          throw new Error(`远程 workspace bind 缺少 stable identity: ${sessionId}`);
        }
        return {
          workspacePath: boundWorkspacePath,
          workspaceIdentity: boundWorkspaceIdentity,
          ...(remoteSession.workspacePurpose
            ? { workspacePurpose: remoteSession.workspacePurpose }
            : workspacePurpose
              ? { workspacePurpose }
              : {}),
          ...(isDesktop && remoteSession.previousWorkspaceIdentity
            ? {
                previousWorkspaceIdentity: remoteSession.previousWorkspaceIdentity,
              }
            : {}),
        };
      } catch (error) {
        // Bug 原因：Host bind 失败意味着 attachment 没有换代、也拿不到 remote:server:* 权威 identity，
        // 继续打开 tab 会让 Renderer 用半绑定的 session 与 Host 的 workspace scope 分裂。
        // 这里失败即回收 session，确保“打开 remote tab = Host 已完成 workspace bind”。
        await handleCancelRemoteProject(sessionId);
        throw error;
      }
    },
    [handleCancelRemoteProject, isDesktop, platform],
  );

  const runReconnectRemoteWorkspaceEntry = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ): Promise<boolean> => {
      const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) {
        return false;
      }
      const workspaceTab = tabStoreApi
        .getState()
        .tabs.find(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
        );
      if (!workspaceTab || workspaceTab.remoteSessionId) {
        return false;
      }

      resetLogsForWorkspaceKey(workspaceKey);
      inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
      const requestId = createUuid();
      const recoveryMode = options?.recoveryMode ?? "manual";
      pendingReconnectRequestIdsRef.current.set(workspaceKey, requestId);
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => ({
        ...current,
        [workspaceKey]: { mode: recoveryMode },
      }));
      setRemoteWorkspaceConnectionState(workspaceKey, "reconnecting");
      let reconnected = false;
      try {
        // 重连期间只静默回填 ready 的 remoteSessionId；激活统一由 reconnect helper
        // 在回填之后执行，避免 active tab 暴露 remote-waiting 中间态。
        const upsertWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
        logger.debug("[Root] 远程 workspace 重连中，保留当前 conversation", {
          workspaceKey,
        });
        await reconnectRemoteWorkspaceHistoryEntry({
          sessionEntry,
          activateTabByPath,
          setReconnectingRemoteWorkspaceKeys,
          loadCredential: services.credentialService.load,
          getSettings: services.settingService.get,
          connectRemoteWorkspaceTarget,
          bindRemoteWorkspaceScope,
          disposeRemoteWorkspaceSession: handleCancelRemoteProject,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          upsertWorkspaceTab,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          logger,
          toast,
          shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
            shouldKeepRemoteWorkspaceInTabs({
              tabStoreApi,
              workspacePath,
              workspaceIdentity,
            }),
          readLiveWorkspaceOwner: (target) => readLiveRemoteWorkspaceOwner(tabStoreApi, target),
          onWorkspaceActivated: (target) => {
            logger.debug("[Root] 远程 workspace ready，提交 tab 与 draft 激活", target);
            onWorkspaceActivated?.(target);
          },
          formatError: (error) => {
            const normalized = error as Error & {
              code?: string;
              retryable?: boolean;
              recoveryAttempt?: number;
              recoveryLimit?: number;
            };
            return formatRemoteConnectionError({
              fallback: getErrorMessage(error),
              reasonCode: normalized.code,
              retryable: normalized.retryable,
              recoveryAttempt: normalized.recoveryAttempt,
              recoveryLimit: normalized.recoveryLimit,
              formatMessage: intl.formatMessage,
            });
          },
          options: {
            ...options,
            requestId,
          },
        });
        reconnected = true;
        clearRemoteWorkspaceConnectionState(workspaceKey);
        return true;
      } finally {
        if (!reconnected) {
          setRemoteWorkspaceConnectionState(workspaceKey, "disconnected");
        }
        inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        if (pendingReconnectRequestIdsRef.current.get(workspaceKey) === requestId) {
          pendingReconnectRequestIdsRef.current.delete(workspaceKey);
        }
        setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
          if (current[workspaceKey]?.mode !== recoveryMode) return current;
          const next = { ...current };
          delete next[workspaceKey];
          return next;
        });
      }
    },
    [
      activateTabByPath,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      onWorkspaceActivated,
      resetLogsForWorkspaceKey,
      services.credentialService,
      services.settingService,
      bindRemoteWorkspaceScope,
      tabStoreApi,
      intl,
    ],
  );

  const runReconnectRemoteWorkspace = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ) => {
      const reconnectGroup = collectSshReconnectGroup({
        selected: sessionEntry,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
      });
      await reconnectRemoteWorkspaceGroup({
        selected: sessionEntry,
        reconnectGroup,
        reconnectEntry: runReconnectRemoteWorkspaceEntry,
        options,
      });
    },
    [runReconnectRemoteWorkspaceEntry, tabStoreApi],
  );

  useEffect(() => {
    const sourceManagement = services.sourceServerManagementService;
    if (!canUseRemoteWorkspace || remoteWorkspaceSessions.length === 0 || !sourceManagement) {
      return;
    }
    let disposed = false;
    let observedManagementGeneration = 0;
    const sourceStateByProfileId = new Map<
      string,
      Awaited<ReturnType<typeof sourceManagement.getSnapshot>>["states"][number]
    >();
    const collectOnlineSourceServerIds = () =>
      new Set(
        [...sourceStateByProfileId.values()].flatMap((state) =>
          state.state === "online" && state.sourceServerId ? [state.sourceServerId] : [],
        ),
      );
    const updateObservedSourceAvailability = () => {
      const onlineSourceServerIds = collectOnlineSourceServerIds();
      const reconnectState = remoteWorkspaceReconnectRendererState;
      reconnectState.observedOnlineSourceServerIds = onlineSourceServerIds;
      for (const sourceServerId of reconnectState.pendingTerminallyDisconnectedSourceServerIds) {
        if (onlineSourceServerIds.has(sourceServerId)) continue;
        reconnectState.pendingTerminallyDisconnectedSourceServerIds.delete(sourceServerId);
        reconnectState.currentRendererDisconnectedSourceServerIds.add(sourceServerId);
      }
    };
    const applyDirectoryWorkspaceIdentityProjection = (settings: {
      sourceServerWorkspaceHistory: SourceServerManagementSnapshot["workspaceHistory"];
      connectionProfiles: SourceServerManagementSnapshot["profiles"];
      remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"];
    }) => {
      const projection = projectRemoteWorkspaceSessionIdentityAliases(
        remoteWorkspaceSessionsRef.current,
        settings,
      );
      if (projection.identityRekeys.length === 0) return;

      // Bug 根因：同一 Renderer 生命周期内完成首次识别/版本升级后，Directory 已把
      // history 改成 stable identity，但内存 session/tab 仍停在 legacy route identity。
      // online 恢复门禁因此无法归属 Source，必须在重连判定前先原地重投影控制端状态。
      remoteWorkspaceSessionsRef.current = projection.remoteSessions;
      setRemoteWorkspaceSessions(projection.remoteSessions);
      const ensureWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
      for (const rekey of projection.identityRekeys) {
        const matchingTab = tabStoreApi
          .getState()
          .tabs.find(
            (tab) =>
              isWorkspaceTab(tab) &&
              tab.workspacePath === rekey.workspacePath &&
              tab.workspaceIdentity === rekey.previousWorkspaceIdentity,
          );
        if (!matchingTab) continue;
        // Bug 原因：首次识别时 project/conversation attachment 可能已经 ready；过去只
        // rekey 断连 tab，live tab 继续持有 legacy identity，随后 canonical purpose
        // 自愈按 stable workspaceKey 精确匹配时必然漏掉它。原地 rekey 会保留 remoteSessionId。
        ensureWorkspaceTab(rekey.workspacePath, {
          previousWorkspaceIdentity: rekey.previousWorkspaceIdentity,
          workspaceIdentity: rekey.workspaceIdentity,
        });
      }
    };
    const attemptReconnect = () => {
      const attemptedWorkspaceKeys = remoteWorkspaceReconnectRendererState.attemptedWorkspaceKeys;
      const groups = collectStartupRemoteWorkspaceReconnectGroups({
        manuallyOpeningWorkspaceTabId: manuallyOpeningWorkspaceTabIdRef.current,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
        attemptedWorkspaceKeys,
        onlineSourceServerIds: collectOnlineSourceServerIds(),
        currentRendererDisconnectedSourceServerIds:
          remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds,
        pendingTerminallyDisconnectedSourceServerIds:
          remoteWorkspaceReconnectRendererState.pendingTerminallyDisconnectedSourceServerIds,
      });
      if (groups.length === 0) return;
      for (const group of groups) {
        remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds.delete(
          group.sourceServerId,
        );
        for (const entry of group.entries) {
          attemptedWorkspaceKeys.add(buildWorkspaceSessionKey(entry));
        }
      }

      // Bug 原因：R3 Host 冷启动只恢复 physical Source，Renderer 仍沿用 R1 的“全部断连占位”
      // 旧语义，导致 online Source 下 A/B 永远没有新 remoteSessionId。按 Source 并发、组内串行恢复
      // logical attachments；physical Source 已 online，不再让某个 workspace 充当 Host gate。
      void Promise.all(
        groups.map(async (group) => {
          const groupWorkspaceKeys = new Set(
            group.entries.map((entry) => buildWorkspaceSessionKey(entry)),
          );
          await restoreSourceRemoteWorkspaceGroup({
            entries: remoteWorkspaceSessionsRef.current.filter((entry) =>
              groupWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
            ),
            reconnectEntry: runReconnectRemoteWorkspaceEntry,
            options: {
              activateWorkspaceAfterReconnect: false,
              showErrorToast: false,
              recoveryMode: "automatic",
            },
          });
        }),
      );
    };

    let refreshInFlight: Promise<void> | null = null;
    let refreshQueued = false;
    let refreshQueuedReconnect = false;
    const refreshSnapshot = (shouldAttemptReconnect: boolean) => {
      if (refreshInFlight) {
        refreshQueued = true;
        refreshQueuedReconnect ||= shouldAttemptReconnect;
        return;
      }
      refreshInFlight = sourceManagement
        .getSnapshot()
        .then(async (snapshot) => {
          if (disposed || snapshot.generation < observedManagementGeneration) return;
          observedManagementGeneration = snapshot.generation;
          let settings: Pick<AppSettings, "remoteConversationWorkspaceBySourceServerId"> = {};
          try {
            settings = await services.settingService.get();
          } catch (error) {
            // alias 读取失败不能阻断 Source 状态刷新；没有 map 时继续保持原有 fail-closed 行为。
            logger.warn("[Root] 读取 conversation workspace alias 失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          // 读取设置期间向导意图可能变化；已清理的订阅不能继续提交旧投影/恢复候选。
          if (disposed) return;
          applyDirectoryWorkspaceIdentityProjection({
            sourceServerWorkspaceHistory: snapshot.workspaceHistory,
            connectionProfiles: snapshot.profiles,
            remoteConversationWorkspaceBySourceServerId:
              settings.remoteConversationWorkspaceBySourceServerId,
          });
          sourceStateByProfileId.clear();
          for (const state of snapshot.states) sourceStateByProfileId.set(state.profileId, state);
          updateObservedSourceAvailability();
          if (shouldAttemptReconnect) attemptReconnect();
        })
        .catch((error) => {
          if (!disposed) {
            logger.warn("[Root] 读取 Source 启动恢复状态失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          refreshInFlight = null;
          if (!disposed && refreshQueued) {
            const queuedReconnect = refreshQueuedReconnect;
            refreshQueued = false;
            refreshQueuedReconnect = false;
            refreshSnapshot(queuedReconnect);
          }
        });
    };

    // Bug 原因：Renderer 过去在 Host 的 10 秒 startup flight 仍进行时就主动 connectProfile，
    // 既把“Host 只试一次”扩成第二条恢复入口，也会 join 同一超时 flight 后制造迟到连接。
    // logical workspace 只消费 Host 权威 online 状态；failed/offline 保持手动入口。
    const managementSubscription = sourceManagement.onDidChangeState((delta) => {
      if (disposed || delta.generation < observedManagementGeneration) return;
      observedManagementGeneration = delta.generation;
      sourceStateByProfileId.set(delta.state.profileId, delta.state);
      updateObservedSourceAvailability();
      // Bug 根因：主动断开会先发布 retrying/offline；这些状态不是启动恢复信号，
      // 只有 Source 真正进入 online 才允许重算历史 workspace 候选。
      if (shouldAttemptStartupReconnectForSourceState(delta.state.state)) {
        attemptReconnect();
      }
      updateStartupRemoteWorkspaceReconnectAttemptsForSourceState({
        state: delta.state,
        onlineSourceServerIds: collectOnlineSourceServerIds(),
        sessions: remoteWorkspaceSessionsRef.current,
        attemptedWorkspaceKeys: remoteWorkspaceReconnectRendererState.attemptedWorkspaceKeys,
      });
    });
    const directorySubscription = sourceManagement.onDidChangeDirectory?.(() => {
      // Directory 变更只刷新权威投影，不触发自动重连；重命名/删线路/打开项目不能被误判为连接信号。
      refreshSnapshot(false);
    });
    refreshSnapshot(true);
    // Desktop active-first 会在首帧后才补齐 inactive tabs；订阅 tabs 才能在 A/B 真正进入
    // TabStore 后重新计算一次候选。attempted workspace set 阻止其它 tab 变化重复连接已处理项，
    // 同时允许迟到的同 Source sibling 补上 logical session。
    const tabSubscription = tabStoreApi.subscribe((state, previousState) => {
      // Bug 根因：主动断开先清除已有 tab 的 remoteSessionId，再异步发布 Source offline；
      // 任意 tab 变化都会在这段窗口内误触发 startup reconnect。只对 active-first 新增的
      // 断连 tab 重算候选，已有 tab 的 live -> disconnected 变化保持手动重连语义。
      if (shouldAttemptStartupReconnectForTabChange(state.tabs, previousState.tabs)) {
        attemptReconnect();
      }
    });
    return () => {
      disposed = true;
      managementSubscription.dispose();
      directorySubscription?.dispose();
      tabSubscription();
    };
  }, [
    canUseRemoteWorkspace,
    manuallyOpeningWorkspaceTabId,
    remoteWorkspaceSessions,
    runReconnectRemoteWorkspaceEntry,
    services.settingService,
    services.sourceServerManagementService,
    syncPersistedWorkspaceSession,
    tabStoreApi,
  ]);

  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      const persistedRemoteSessions = getRemoteWorkspaceSessionEntries(settings);
      setRemoteWorkspaceSessions(persistedRemoteSessions);
      remoteWorkspaceSessionsRef.current = persistedRemoteSessions;
      let conversationWorkspacePath: string | undefined;
      if (ensureConversationWorkspaceOnRestore) {
        try {
          conversationWorkspacePath = (await services.fileService.ensureConversationWorkspace())
            .path;
        } catch (error) {
          // 路径创建失败不能连带吞掉真实项目恢复；后续显式新建对话仍会走原有可重试错误入口。
          logger.warn("[Root] 恢复阶段解析 conversation workspace 失败", {
            error,
          });
        }
      }
      // R3 先把历史恢复为断连 tab；上方自动恢复 effect 只消费近 7 天、Source 已 online 的
      // remote:server stable history。legacy/过期历史仍保持手动入口，Web 普通模式则
      // 继续把 allowRemoteWorkspaceRestore 置为 false，不恢复 tab 或创建远端 runtime。
      const workspaceRestore = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore,
        unavailableWorkspacePath,
        conversationWorkspacePath,
        remoteConversationWorkspaceBySourceServerId:
          settings.remoteConversationWorkspaceBySourceServerId,
        restoreMode: deferInactiveWorkspaceRestore ? "active-first" : "all",
      });
      return {
        ...(conversationWorkspacePath
          ? { excludedRecentProjectPaths: [conversationWorkspacePath] }
          : {}),
        ...(workspaceRestore?.deferredRestore
          ? { deferredRestore: workspaceRestore.deferredRestore }
          : {}),
      };
    },
    [
      allowRemoteWorkspaceRestore,
      deferInactiveWorkspaceRestore,
      ensureConversationWorkspaceOnRestore,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  const selectRemoteProjectFromDialog = useCallback(
    async (
      sessionId: string,
      path: string,
      localWorkspacePath?: string,
      workspacePurpose: "project" | "conversation" = "project",
      draftProjectId?: string | null,
      preparedWorkspaceIdentity?: string,
      isCurrent?: () => boolean | Promise<boolean>,
    ) => {
      try {
        await selectRemoteWorkspaceProjectFromDialog({
          canUseRemoteWorkspace,
          isCurrent,
          sessionId,
          path,
          preparedWorkspaceIdentity,
          draftProjectId,
          localWorkspacePath,
          workspacePurpose,
          loadingMessage: intl.formatMessage({ id: "common.loading" }),
          getRemoteWorkspaceSession,
          connectionTarget: pendingConnectionTargetsBySessionIdRef.current.get(sessionId),
          getWorkspaceTabs: () => tabStoreApi.getState().tabs,
          restoringWorkspaceTabId: manuallyOpeningWorkspaceTabIdRef.current,
          resolveRemoteWorkspaceCanonicalPath,
          activateTabByPath,
          handleCancelRemoteProject,
          bindRemoteWorkspaceScope,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          addTab,
          // 原项目 ID 必须到达 Root 的草稿 owner，由它同步内存与持久化范围。
          onWorkspaceActivated:
            onWorkspaceActivated ??
            (draftProjectId === undefined
              ? undefined
              : ({ workspacePath, workspaceIdentity }) => {
                  useZCodeSessionStore
                    .getState()
                    .startDraft(workspacePath, undefined, workspaceIdentity, {
                      projectId: draftProjectId,
                    });
                }),
        });
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
      }
    },
    [
      activateTabByPath,
      addTab,
      tabStoreApi,
      commitRemoteWorkspaceSessionMutation,
      handleCancelRemoteProject,
      intl,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      canUseRemoteWorkspace,
    ],
  );

  const openRemoteConversation = useCallback(
    async (sessionId: string, sourceServerId?: string) =>
      await openRemoteConversationWorkspace({
        sessionId,
        sourceServerId,
        getRemoteWorkspaceSession,
        getSettings: services.settingService.get,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        waitForRemoteWorkspaceSessionReady,
        ensureConversationWorkspace: async (resolvedSourceServerId) => {
          const management = services.sourceServerManagementService;
          if (!management) {
            throw new Error("Remote conversation requires an identified Source Server");
          }
          return management.ensureConversationWorkspace(resolvedSourceServerId);
        },
        selectRemoteWorkspace: async (conversationSessionId, conversationPath, workspacePurpose) =>
          await selectRemoteProjectFromDialog(
            conversationSessionId,
            conversationPath,
            undefined,
            workspacePurpose,
          ),
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
      }),
    [
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      selectRemoteProjectFromDialog,
      // RPC getter 每次返回新函数；依赖服务身份，避免普通 Root 更新重建整条导航链。
      services.credentialService,
      services.settingService,
      services.sourceServerManagementService,
      waitForRemoteWorkspaceSessionReady,
    ],
  );
  const handleConnectRemote = useCallback(
    async (
      options: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
      feedback?: RemoteConnectionFeedbackOptions,
    ) => {
      if (!canUseRemoteWorkspace) {
        throw new Error("Remote workspace is disabled in this mode");
      }

      return connectRemoteWorkspaceTarget(options, requestId, context, feedback);
    },
    [canUseRemoteWorkspace, connectRemoteWorkspaceTarget],
  );

  const runReconnectRemoteWorkspaceByKey = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      const reconnect = async (nextOptions?: ReconnectRemoteWorkspaceOptions) => {
        await reconnectRemoteWorkspaceByKey({
          workspaceKey,
          canUseRemoteWorkspace,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          runReconnectRemoteWorkspace,
          options: { ...options, ...nextOptions },
        });
      };
      // 手机 RPC/自动恢复沿用既有返回与错误语义，不打开桌面向导。
      if (
        options?.throwOnFailure ||
        options?.recoveryMode === "automatic" ||
        !onOpenRemoteConnection
      ) {
        await reconnect(options);
        return;
      }
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) return;
      const tab = tabStoreApi
        .getState()
        .tabs.find(
          (candidate) =>
            isWorkspaceTab(candidate) && buildWorkspaceSessionKey(candidate) === workspaceKey,
        );
      const entry = remoteWorkspaceSessionsRef.current.find(
        (candidate) => buildWorkspaceSessionKey(candidate) === workspaceKey,
      );
      if (!tab || !isWorkspaceTab(tab) || !entry) {
        if (!services.remoteProjectService) throw new Error("remote-project.service-unavailable");
        inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
        try {
          await requestRetainedRemoteProjectConnection({
            workspaceKey,
            service: services.remoteProjectService,
            getSnapshot: services.sourceServerManagementService
              ? () => services.sourceServerManagementService!.getSnapshot()
              : undefined,
            openWizard: onOpenRemoteConnection,
          });
        } finally {
          inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        }
        return;
      }
      const snapshot = await services.sourceServerManagementService
        ?.getSnapshot()
        .catch(() => undefined);
      const isCurrent = () =>
        tabStoreApi.getState().tabs.some((candidate) => candidate.id === tab.id);
      if (!isCurrent()) return;
      const sourceId = getWorkspaceSourceServerId(tab, {
        workspaceHistory: snapshot?.workspaceHistory,
      });
      const device = sourceId ? getRemoteDevicePresentationInput(snapshot, sourceId) : undefined;
      const profile = snapshot?.profiles.find(
        (candidate) => candidate.profileId === device?.profileId,
      );
      // Bug 原因（ZCT-2112984371086536704）：等待点（如需要安装）也会被记成失败；3.16.2 的记录只有
      // 本地化文案。线路尚未识别时，旧逻辑用这段过期文案判成“连接失败”，不重连也不显示安装确认。
      // 第一版修复在线路未识别时忽略全部记录，普通失败后每次点击又都静默重拨，打不开向导。
      // 现在按记录的错误码区分：普通失败照常交给向导查看、不拨号；等待点或无码旧记录先重连，
      // 由 Host 给出当前带码的结果和实际操作线路。线路已识别时仍按原逻辑使用项目级失败。
      const recordFailureCode =
        entry.lastConnectionErrorCode &&
        resolveRemoteConnectionPresentation({ errorCode: entry.lastConnectionErrorCode }).status !==
          "pending"
          ? entry.lastConnectionErrorCode
          : undefined;
      const presentation = resolveRemoteConnectionPresentation({
        ...device,
        attached: false,
        projectError: device || recordFailureCode ? entry.lastConnectionError : undefined,
      });
      await requestRemoteProjectConnection({
        preference: {
          preferredWorkspaceTabId: tab.id,
          preferredDirectoryPath: entry.workspacePath,
          preferredProfileId: profile?.profileId,
          preferredTarget: profile ? buildRemoteTargetFromProfile(profile) : tab.remoteTarget,
        },
        presentation,
        failure: {
          code: device ? device.errorCode : recordFailureCode,
          message: device?.error ?? entry.lastConnectionError ?? "",
          logs: reconnectingRemoteWorkspaceLogsByWorkspaceKey[workspaceKey] ?? [],
        },
        reconnect,
        openWizard: onOpenRemoteConnection,
        isCurrent,
      });
    },
    [
      canUseRemoteWorkspace,
      runReconnectRemoteWorkspace,
      onOpenRemoteConnection,
      tabStoreApi,
      services.sourceServerManagementService,
      services.remoteProjectService,
      reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    ],
  );

  const handleOpenRemoteWorkspaceFromHistory = useCallback(
    async (workspaceKey: string) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      // 远程历史入口与侧栏重连都可能命中“重连中被用户移除”的竞态。
      // 这里抽成统一入口，确保两条路径共享相同的并发保护、保留校验与错误处理语义。
      await openRemoteWorkspaceFromHistoryEntry({
        workspaceKey,
        tabStoreApi,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        inflightReconnectWorkspaceKeys: inflightReconnectWorkspaceKeysRef.current,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        bindRemoteWorkspaceScope,
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
        addTab,
        commitRemoteWorkspaceSessionMutation,
        createReconnectRequestId: createUuid,
        pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
        resetLogsForWorkspaceKey,
        onWorkspaceActivated,
      });
    },
    [
      activateTabByPath,
      addTab,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      resetLogsForWorkspaceKey,
      onWorkspaceActivated,
      services.credentialService,
      bindRemoteWorkspaceScope,
      tabStoreApi,
      canUseRemoteWorkspace,
    ],
  );

  const handleRemoteWorkspaceSessionClosed = useCallback(
    async (event: RemoteSessionClosedEvent) => {
      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && tab.remoteSessionId === sessionId,
        );
      if (matchedTabs.length === 0) {
        unregisterRemoteWorkspaceSession(sessionId);
        return;
      }

      if (event.recoverable === true) {
        // Bug 原因：transient Source close 在 Main 转发时丢失 recoverable，Renderer 会立即
        // 清 remoteSessionId、标记运行任务失败并写 failed history；几秒后重连却无法回滚这些
        // 终态副作用。恢复预算内只释放失效 services，tab/session id 留给换代事件匹配。
        unregisterRemoteWorkspaceSession(sessionId);
        for (const tab of matchedTabs) {
          setRemoteWorkspaceConnectionState(buildWorkspaceSessionKey(tab), "reconnecting");
        }
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, true),
        );
        setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
          const next = { ...current };
          for (const tab of matchedTabs) {
            next[buildWorkspaceSessionKey(tab)] = {
              mode: "automatic",
              ...(event.recoveryAttempt ? { attempt: event.recoveryAttempt } : {}),
              ...(event.recoveryLimit ? { limit: event.recoveryLimit } : {}),
            };
          }
          return next;
        });
        logger.info("[Root] 远程 workspace session 进入可恢复断连状态", {
          sessionId,
        });
        return;
      }

      setReconnectingRemoteWorkspaceKeys((currentKeys) =>
        updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, false),
      );
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
        const next = { ...current };
        for (const tab of matchedTabs) delete next[buildWorkspaceSessionKey(tab)];
        return next;
      });

      // Bug 根因：terminal close 可能先于 Source offline 到达；旧 online 快照不能立即撤销断开。
      // 先等待权威 Source 离开 online，下一次 online 才允许重置该 Source 的尝试记录并恢复。
      for (const tab of matchedTabs) {
        const identity = tab.workspaceIdentity
          ? parseRemoteWorkspaceIdentity(tab.workspaceIdentity)
          : null;
        if (identity?.kind === "server" && identity.sourceServerId) {
          if (
            remoteWorkspaceReconnectRendererState.observedOnlineSourceServerIds.has(
              identity.sourceServerId,
            )
          ) {
            remoteWorkspaceReconnectRendererState.pendingTerminallyDisconnectedSourceServerIds.add(
              identity.sourceServerId,
            );
          } else {
            remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds.add(
              identity.sourceServerId,
            );
          }
        }
      }

      // Bugfix: 远端 host 退出后，tab 上的 remoteSessionId 之前不会被清空。
      // UI 因此持续显示“已连接”，并继续把请求路由到失效 session。
      // 这里在收到 main 进程的 session-close 事件时立即降级为断连态，后续只走用户手动重连。
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      unregisterRemoteWorkspaceSession(sessionId);

      const matchedWorkspaceKeys = [
        ...new Set(matchedTabs.map((tab) => buildWorkspaceSessionKey(tab))),
      ];
      const reason = formatRemoteConnectionError({
        fallback: resolveRemoteWorkspaceClosedFallback({
          event,
          formatMessage: intl.formatMessage,
          defaultFallback: [
            intl.formatMessage({ id: "remote.error.connectionClosed" }),
            event.exitCode != null ? `exitCode=${event.exitCode}` : null,
            event.signal ? `signal=${event.signal}` : null,
          ]
            .filter(Boolean)
            .join(" "),
        }),
        reasonCode: event.reasonCode,
        retryable: event.retryable,
        recoveryAttempt: event.recoveryAttempt,
        recoveryLimit: event.recoveryLimit,
        formatMessage: intl.formatMessage,
      });
      for (const workspaceKey of matchedWorkspaceKeys) {
        // 连接事实与远端 task terminal 状态分离：断连只更新 renderer overlay，
        // 不能把远端仍可能运行的 task 写成本地 failed。
        setRemoteWorkspaceConnectionState(workspaceKey, "disconnected");
      }

      logger.warn("[Root] 远程 workspace session 已关闭", {
        sessionId,
        reason: event.reason,
        exitCode: event.exitCode,
        signal: event.signal,
        matchedWorkspaceKeys,
      });

      for (const workspaceKey of matchedWorkspaceKeys) {
        const sessionEntry = remoteWorkspaceSessionsRef.current.find(
          (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
        );
        if (!sessionEntry) {
          continue;
        }

        const pendingReconnectRequestId = pendingReconnectRequestIdsRef.current.get(workspaceKey);
        if (
          !shouldPersistRemoteWorkspaceFailure({
            pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
            sessionEntry,
            workspaceKey,
          })
        ) {
          logger.info("[Root] WSL workspace session 关闭时跳过失败落盘，等待重连结果", {
            pendingReconnectRequestId,
            sessionId,
            workspaceIdentity: sessionEntry.workspaceIdentity ?? null,
            workspacePath: sessionEntry.workspacePath,
            workspaceKey,
          });
          continue;
        }

        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: sessionEntry.workspacePath,
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: createRemoteTargetFromSnapshot(sessionEntry.target, {
              password: null,
              privateKeyPassphrase: null,
            }),
            lastConnectionStatus: "failed",
            lastConnectionError: isRemoteWorkspaceCloseFailure(event) ? reason : "",
            touchOpenedAt: false,
          }),
        );
      }
    },
    [commitRemoteWorkspaceSessionMutation, intl, tabStoreApi],
  );

  const handleRemoteWorkspaceSessionReconnected = useCallback(
    (event: RemoteSessionReconnectedEvent) => {
      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) &&
            tab.workspacePath === event.workspacePath &&
            tab.workspaceIdentity === event.workspaceIdentity &&
            (!tab.remoteSessionId || tab.remoteSessionId === event.previousSessionId),
        );
      if (matchedTabs.length === 0) return;
      setReconnectingRemoteWorkspaceKeys((currentKeys) =>
        updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, false),
      );
      for (const tab of matchedTabs) {
        clearRemoteWorkspaceConnectionState(buildWorkspaceSessionKey(tab));
      }
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
        const next = { ...current };
        for (const tab of matchedTabs) delete next[buildWorkspaceSessionKey(tab)];
        return next;
      });
      unregisterRemoteWorkspaceSession(event.previousSessionId);
      bindRemoteWorkspacePath(event.workspacePath, event.sessionId);
      bindRemoteWorkspaceIdentity(event.workspaceIdentity, event.sessionId);
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) &&
          tab.workspacePath === event.workspacePath &&
          tab.workspaceIdentity === event.workspaceIdentity &&
          (!tab.remoteSessionId || tab.remoteSessionId === event.previousSessionId)
            ? { ...tab, remoteSessionId: event.sessionId }
            : tab,
        ),
      }));
    },
    [tabStoreApi],
  );

  useEffect(() => {
    return platform.onRemoteSessionClosed((event) => {
      void handleRemoteWorkspaceSessionClosed(event);
    });
  }, [handleRemoteWorkspaceSessionClosed, platform]);

  useEffect(() => {
    return (
      platform.onRemoteSessionReconnected?.((event) => {
        handleRemoteWorkspaceSessionReconnected(event);
      }) ?? (() => {})
    );
  }, [handleRemoteWorkspaceSessionReconnected, platform]);

  const handleRemoteWorkspaceTabsClosed = useCallback(
    (workspaceKeys: string[]) => {
      if (workspaceKeys.length === 0) {
        return;
      }

      const workspaceKeySet = new Set(workspaceKeys);
      for (const workspaceKey of workspaceKeys) {
        clearRemoteWorkspaceConnectionState(workspaceKey);
      }

      void (async () => {
        // 关闭断连态 remote tab 时，tab 上还没有 remoteSessionId，但 main 进程可能已经在上传 remote runtime。
        // 这里用重连 requestId 精准取消 pending host，避免 UI 已移除而后台 upload 继续跑。
        await cancelPendingRemoteReconnectsForWorkspaceKeys({
          workspaceKeys,
          pendingRequestIds: pendingReconnectRequestIdsRef.current,
          cancelPendingRemoteConnection: platform.cancelPendingRemoteConnection
            ? (requestId) =>
                platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve()
            : undefined,
          logger,
        });
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          currentKeys.filter((key) => !workspaceKeySet.has(key)),
        );

        const removal = removeRemoteWorkspaceSessionEntries(
          remoteWorkspaceSessionsRef.current,
          workspaceKeys,
        );
        if (
          removal.nextRemoteSessions.length === remoteWorkspaceSessionsRef.current.length &&
          removal.credentialKeysToDelete.length === 0
        ) {
          return;
        }

        // 用户在侧栏“移除”远程 workspace 后，只删 tab 不够：
        // remoteWorkspaceSessionsRef 仍被持久化补丁合并回 setting.json，
        // 所以下次启动又会恢复同一个断连项。这里把显式移除视为删除远程历史，
        // 同时清理该历史独占的 SSH 凭据，避免留下不可达的 credential key。
        await syncPersistedWorkspaceSession(removal.nextRemoteSessions);
        for (const credentialKey of removal.credentialKeysToDelete) {
          if (persistenceGate && !persistenceGate.canPersist) {
            pendingCredentialDeletesRef.current.add(credentialKey);
            continue;
          }
          try {
            await services.credentialService.delete(credentialKey);
          } catch (error) {
            logger.warn("[Root] 删除已移除远程 workspace 凭据失败", {
              credentialKey,
              error,
            });
          }
        }
      })();
    },
    [persistenceGate, platform, services.credentialService, syncPersistedWorkspaceSession],
  );

  const remoteWorkspaceController = useMemo<RemoteWorkspaceController>(
    () =>
      createRemoteWorkspaceController({
        connectDevice: async (profileId, effect) => {
          if (!onOpenRemoteConnection) {
            throw new Error("Remote connection dialog is unavailable");
          }
          // 发起入口保留完成意图；凭据、安装、升级和错误仍由唯一向导承载。
          onOpenRemoteConnection({
            preferredProfileId: profileId,
            ...(effect === "device-management" ? { completion: effect } : {}),
          });
        },
        disconnectDevice: async (sourceServerId) => {
          const management = services.sourceServerManagementService;
          if (!management) {
            throw new Error("Source Server management is unavailable");
          }
          await management.disconnectSource(sourceServerId);
        },
        openConversation: async ({ sourceServerId, remoteSessionId }) => {
          const resolvedSessionId =
            remoteSessionId ??
            Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
              (session) => session.sourceServerId === sourceServerId,
            )?.sessionId;
          if (!resolvedSessionId) {
            throw new Error("Remote conversation intent requires an attached session");
          }
          await openRemoteConversation(resolvedSessionId, sourceServerId);
        },
        openProject: async ({
          sourceServerId,
          path,
          localWorkspacePath,
          remoteSessionId,
          draftProjectId,
          preparedWorkspaceIdentity,
          isCurrent,
        }) => {
          const sessions = Object.values(
            useRemoteWorkspaceSessionStore.getState().sessionsById,
          ).filter((session) =>
            remoteSessionId
              ? session.sessionId === remoteSessionId
              : sourceServerId
                ? session.sourceServerId === sourceServerId
                : !session.sourceServerId,
          );
          if (sessions.length !== 1) {
            throw new Error(
              `Remote project requires one attached session for Source Server: ${sourceServerId}`,
            );
          }
          await selectRemoteProjectFromDialog(
            sessions[0]!.sessionId,
            path,
            localWorkspacePath,
            "project",
            draftProjectId,
            preparedWorkspaceIdentity,
            isCurrent,
          );
        },
        reconnectWorkspace: async (workspaceKey, options) => {
          await runReconnectRemoteWorkspaceByKey(workspaceKey, options);
        },
        closeWorkspace: async (workspaceKey) => {
          handleRemoteWorkspaceTabsClosed([workspaceKey]);
        },
      }),
    [
      handleRemoteWorkspaceTabsClosed,
      onOpenRemoteConnection,
      openRemoteConversation,
      runReconnectRemoteWorkspaceByKey,
      selectRemoteProjectFromDialog,
      services.sourceServerManagementService,
    ],
  );

  const handleSelectRemoteProject = useCallback(
    async (
      sessionId: string,
      path: string,
      localWorkspacePath?: string,
      preparedWorkspaceIdentity?: string,
      isCurrent?: () => boolean | Promise<boolean>,
    ) => {
      const session = getRemoteWorkspaceSession(sessionId);
      await remoteWorkspaceController.dispatch({
        type: "open-project",
        isCurrent,
        sourceServerId: session?.sourceServerId ?? "",
        path,
        localWorkspacePath,
        remoteSessionId: sessionId,
        ...(preparedWorkspaceIdentity ? { preparedWorkspaceIdentity } : {}),
      });
    },
    [remoteWorkspaceController],
  );

  const handleOpenRemoteConversation = useCallback(
    async (sessionId: string, sourceServerId?: string) => {
      await remoteWorkspaceController.dispatch({
        type: "open-conversation",
        sourceServerId:
          sourceServerId ?? getRemoteWorkspaceSession(sessionId)?.sourceServerId ?? "",
        remoteSessionId: sessionId,
      });
    },
    [remoteWorkspaceController],
  );

  const handleReconnectRemoteWorkspace = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      await remoteWorkspaceController.dispatch({
        type: "reconnect-workspace",
        workspaceKey,
        options,
      });
    },
    [remoteWorkspaceController],
  );

  const remoteWorkspaceErrorByWorkspaceKey = useMemo(
    () =>
      Object.fromEntries(
        remoteWorkspaceSessions.flatMap((entry) =>
          entry.lastConnectionError?.trim()
            ? [[buildWorkspaceSessionKey(entry), entry.lastConnectionError] as const]
            : [],
        ),
      ),
    [remoteWorkspaceSessions],
  );

  return {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleOpenRemoteConversation,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
    handleRemoteWorkspaceTabsClosed,
    remoteWorkspaceController,
  };
}
