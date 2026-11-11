import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BindRemoteWorkspaceSessionContextResult,
  ConnectionProfile,
  IPlatformService,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import {
  isCredentialDecryptError,
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { shouldShowStandaloneRemoteErrorToast } from "@/lib/remoteConnectionPresentation.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
} from "@/store/remoteWorkspaceSessionStore.js";

type ManualReconnectRemoteWorkspaceParams = {
  sessionEntry: RemoteWorkspaceSessionEntry;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  getSettings?: IServiceAccessor["settingService"]["get"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ) => Promise<string>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<
    Pick<BindRemoteWorkspaceSessionContextResult, "workspacePath" | "workspaceIdentity">
  >;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspacePath: typeof bindRemoteWorkspacePath;
  bindRemoteWorkspaceIdentity: typeof bindRemoteWorkspaceIdentity;
  upsertWorkspaceTab: (
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
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  logger: Pick<typeof logger, "warn">;
  toast: typeof toast;
  shouldKeepReconnectedWorkspace?: (
    context: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  /** 目录当前 tab 上仍在线的 owner session；没有或已失效时返回 undefined。 */
  readLiveWorkspaceOwner?: (
    context: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
  ) => string | undefined;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
  }) => void;
  formatError?: (error: unknown) => string;
  options?: ReconnectRemoteWorkspaceOptions;
};

export interface SshReconnectCredentials {
  password: string | null;
  privateKeyPassphrase: string | null;
}

export interface ReconnectRemoteWorkspaceOptions {
  /** 用户原地重连先检查已有凭据，缺失交接向导；自动恢复保留 Host admission。 */
  requireStoredCredentials?: boolean;
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  requestId?: string;
  throwOnFailure?: boolean;
  recoveryMode?: "automatic" | "manual";
  /** 共享 Host ready 后，sibling 复用 initiator 凭据附着，禁止再次读取各自历史凭据。 */
  sshCredentialsOverride?: SshReconnectCredentials;
  /** logical connect 已返回，表示共享 SSH Host ready；workspace 初始化仍可能继续或失败。 */
  onSshHostReady?: (credentials: SshReconnectCredentials) => void;
}

/**
 * 读取 Profile secret；本机无法解密等同缺失，与 Host `SourceServerDirectory` 的规则一致。
 * Bug 原因：~/.zcode 换机/换用户后，保存的密码解不开。Renderer 直接读取凭据，解密错误一路上抛，
 * 点项目或设置页连接只显示通用的“连接失败”，到不了已有的补充凭据分支。其他读取错误照常上抛。
 */
async function loadUsableProfileCredential(
  loadCredential: IServiceAccessor["credentialService"]["load"],
  key: string,
): Promise<string | null> {
  try {
    return await loadCredential(key);
  } catch (error) {
    if (!isCredentialDecryptError(error)) throw error;
    logger.warn("[RemoteWorkspace] Profile 凭据在本机无法解密，按缺失处理");
    return null;
  }
}

export async function loadConnectionProfileCredentials(params: {
  profile: ConnectionProfile;
  loadCredential: IServiceAccessor["credentialService"]["load"];
}): Promise<SshReconnectCredentials | null> {
  if (params.profile.target.kind !== "ssh") return null;
  const target = params.profile.target;
  if (!target.passwordCredentialKey && !target.privateKeyPassphraseCredentialKey) {
    return { password: null, privateKeyPassphrase: null };
  }
  return {
    password: target.passwordCredentialKey
      ? await loadUsableProfileCredential(params.loadCredential, target.passwordCredentialKey)
      : null,
    privateKeyPassphrase: target.privateKeyPassphraseCredentialKey
      ? await loadUsableProfileCredential(
          params.loadCredential,
          target.privateKeyPassphraseCredentialKey,
        )
      : null,
  };
}

function resolveSshReconnectSnapshot(params: {
  sessionEntry: RemoteWorkspaceSessionEntry;
  settings?: Pick<AppSettings, "connectionProfiles" | "sourceServerWorkspaceHistory">;
}): RemoteTargetSnapshot {
  const previous = params.sessionEntry.target;
  if (previous.kind !== "ssh") return previous;
  const history = params.settings?.sourceServerWorkspaceHistory?.find(
    (entry) =>
      entry.workspacePath === params.sessionEntry.workspacePath &&
      entry.workspaceIdentity === params.sessionEntry.workspaceIdentity,
  );
  if (!history) return previous;
  const profile = params.settings?.connectionProfiles?.find(
    (candidate) => candidate.profileId === history.profileId && candidate.target.kind === "ssh",
  );
  if (!profile || profile.target.kind !== "ssh") return previous;
  const target = profile.target;
  // 旧历史可能只有 session 凭据引用；仅相同认证配置且 Profile 没有新引用时兼容。
  // 更换私钥后不能把旧密码/口令带给新密钥，也不能把旧口令引用误判成仍需凭据。
  if (
    !target.passwordCredentialKey &&
    !target.privateKeyPassphraseCredentialKey &&
    target.privateKeyPath === previous.privateKeyPath
  ) {
    return {
      ...target,
      passwordCredentialKey: previous.passwordCredentialKey,
      privateKeyPassphraseCredentialKey: previous.privateKeyPassphraseCredentialKey,
    };
  }
  return target;
}

export async function reconnectRemoteWorkspaceHistoryEntry({
  sessionEntry,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  getSettings,
  connectRemoteWorkspaceTarget,
  bindRemoteWorkspaceScope,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  upsertWorkspaceTab,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  logger,
  toast,
  shouldKeepReconnectedWorkspace,
  readLiveWorkspaceOwner,
  onWorkspaceActivated,
  formatError,
  options,
}: ManualReconnectRemoteWorkspaceParams): Promise<void> {
  const activateWorkspaceAfterReconnect = options?.activateWorkspaceAfterReconnect ?? true;
  const showErrorToast = options?.showErrorToast ?? true;
  const fallbackWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(sessionEntry);
  const reconnectWorkspaceKey = fallbackWorkspaceIdentity?.trim() || sessionEntry.workspacePath;

  setReconnectingRemoteWorkspaceKeys((currentKeys) =>
    currentKeys.includes(reconnectWorkspaceKey)
      ? currentKeys
      : [...currentKeys, reconnectWorkspaceKey],
  );

  let reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, {
    password: null,
    privateKeyPassphrase: null,
    token: null,
  });
  let resolvedWorkspacePath = sessionEntry.workspacePath;
  let resolvedWorkspaceIdentity = fallbackWorkspaceIdentity;
  try {
    const settings = getSettings ? await getSettings() : undefined;
    // 根因：原项目重连只取 Profile 的新凭据，却继续用 session 的旧地址，
    // 编辑线路后会连回旧端口并被 Host 注册成第二条 Profile。目标与凭据须来自同一份配置。
    const targetSnapshot = resolveSshReconnectSnapshot({ sessionEntry, settings });
    const sshCredentials = options?.sshCredentialsOverride ?? {
      password:
        targetSnapshot.kind === "ssh" && targetSnapshot.passwordCredentialKey
          ? await loadUsableProfileCredential(loadCredential, targetSnapshot.passwordCredentialKey)
          : null,
      privateKeyPassphrase:
        targetSnapshot.kind === "ssh" && targetSnapshot.privateKeyPassphraseCredentialKey
          ? await loadUsableProfileCredential(
              loadCredential,
              targetSnapshot.privateKeyPassphraseCredentialKey,
            )
          : null,
    };
    const token =
      sessionEntry.target.kind === "server" && sessionEntry.target.tokenCredentialKey
        ? await loadCredential(sessionEntry.target.tokenCredentialKey)
        : null;
    reconnectTarget = createRemoteTargetFromSnapshot(targetSnapshot, {
      ...sshCredentials,
      token,
    });
    if (options?.requireStoredCredentials && reconnectTarget.kind === "ssh") {
      const expectsPassphrase =
        targetSnapshot.kind === "ssh" && targetSnapshot.privateKeyPassphraseCredentialKey;
      if (
        !sshCredentials.password &&
        (!reconnectTarget.privateKeyPath ||
          (expectsPassphrase && !sshCredentials.privateKeyPassphrase))
      ) {
        throw Object.assign(new Error("credentials-required"), { code: "credentials-required" });
      }
    }
    let sessionId: string;
    try {
      sessionId = await connectRemoteWorkspaceTarget(reconnectTarget, options?.requestId, {
        workspacePath: sessionEntry.workspacePath,
        workspaceIdentity: fallbackWorkspaceIdentity,
        connectTrigger: "reconnect",
      });
    } catch (error) {
      // 这两个结构化错误只由 Host 在 Source 已上线后的目录 admission 发出。发起项目被删
      // 不代表 SSH 凭据失败；先放行复用同一凭据的 siblings，再按原路径记录该项目失败。
      // Bug 原因：读目录 30 秒无响应（unresponsive）过去没有放行，SSH 组重连因此判定 Host
      // 未就绪，同设备其他项目一个都不重连。
      if (
        reconnectTarget.kind === "ssh" &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE ||
          error.code === REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE)
      ) {
        options?.onSshHostReady?.(sshCredentials);
      }
      throw error;
    }
    if (reconnectTarget.kind === "ssh") {
      // Host ready 与 provider/task 等 workspace 初始化必须分阶段通知。
      // sibling 从此刻即可复用 initiator credential 创建 attachment，无需等待或重复读取凭据。
      options?.onSshHostReady?.(sshCredentials);
    }
    // Bug 原因（3.17.1 用户反馈“设备已连接、会话打不开”）：这里过去先对持久化路径做 realpath。
    // 项目根目录是 symlink 时（例如 /home/dev/projects/app → /data/projects/app），bind 到目标路径会得到
    // 另一个 identity，下方保留校验找不到对应 tab，把刚连上的 session 当作“已被移除”静默回收，
    // 设备上线后的自动挂回与手动重连都会如此。已绑定的 workspace 以首次 bind 的路径为身份，
    // 重连沿用持久化路径，与项目入口一致；已绑定的路径不再做 realpath。
    // Bug 原因：Renderer 过去用 transport target 本地推导 identity，与 Host 绑定的 remote:server:*
    // 权威 identity 分裂。这里和首次连接保持一致：先完成 Host bind，再只消费返回的权威 scope。
    // 这次 bind 也是手机远控桥接能通过的前提：bridge 按 tab 的 path/identity 三元比对 main descriptor，
    // 缺少 bind 或 bind 落后于 tab 回填会被 REMOTE_WORKSPACE_IDENTITY_MISMATCH 拒绝（3.12.0 曾因此连不上远程项目）。
    // bind 必须位于下方保留校验之前：校验与 upsertWorkspaceTab 之间不能再有 await，否则用户在等待
    // ready ACK 期间移除 tab 后，过期的校验结果会把 workspace 重新加回。
    const boundScope = await bindRemoteWorkspaceScope(
      sessionId,
      resolvedWorkspacePath,
      undefined,
      sessionEntry.workspacePurpose ?? "project",
    );
    resolvedWorkspacePath = boundScope.workspacePath;
    resolvedWorkspaceIdentity = boundScope.workspaceIdentity;
    // Bugfix: 手动重连过程中，用户可能先点重连再立即把该远端 tab 移除。
    // 如果这里不在成功落库前再做一次保留校验，会把用户刚移除的 workspace 又重新加回来。
    if (
      shouldKeepReconnectedWorkspace &&
      !shouldKeepReconnectedWorkspace({
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      })
    ) {
      logger.warn("[Root] 远程 workspace 在重连过程中已被移除，跳过恢复并回收 session", {
        workspacePath: resolvedWorkspacePath,
      });
      await disposeRemoteWorkspaceSession(sessionId);
      return;
    }
    // Bug 原因：入口只在发起前检查 tab 是否已有 owner；连接与 Provisioning 等待期间，侧栏导航可能已为
    // 同一目录写入另一条 session，这里直接覆盖 tab，被替换的 session 无人回收。写入前按同一规则复核：
    // 已有在线 owner 时让出并回收本次连接，与项目打开路径的复用规则一致。
    const liveOwner = readLiveWorkspaceOwner?.({
      workspacePath: resolvedWorkspacePath,
      workspaceIdentity: resolvedWorkspaceIdentity,
    });
    if (liveOwner && liveOwner !== sessionId) {
      logger.warn("[Root] 远程 workspace 在重连过程中已有在线 owner，让出并回收 session", {
        workspacePath: resolvedWorkspacePath,
        sessionId,
        liveOwner,
      });
      await disposeRemoteWorkspaceSession(sessionId);
      return;
    }
    bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
    bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
    upsertWorkspaceTab(resolvedWorkspacePath, {
      remoteSessionId: sessionId,
      remoteTarget: stripRemoteTargetSecrets(reconnectTarget),
      workspaceIdentity: resolvedWorkspaceIdentity,
      ...(fallbackWorkspaceIdentity !== resolvedWorkspaceIdentity
        ? { previousWorkspaceIdentity: fallbackWorkspaceIdentity }
        : {}),
      localWorkspacePath: sessionEntry.localWorkspacePath,
      workspacePurpose: sessionEntry.workspacePurpose,
    });
    if (activateWorkspaceAfterReconnect) {
      // 侧栏重连过去会先激活只有 identity、尚无 remoteSessionId 的断连 tab，
      // conversation provider 因 remote-waiting 返回 null，导致连接期间右侧整块黑屏。
      // 必须先绑定 services 并静默回填 tab 的 session 元数据，再一次性激活 tab 与草稿。
      const activated = activateTabByPath(resolvedWorkspacePath, {
        workspaceIdentity: resolvedWorkspaceIdentity,
      });
      if (activated) {
        onWorkspaceActivated?.({
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
          restoreSelection: true,
        });
      }
    }
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        localWorkspacePath: sessionEntry.localWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        workspacePurpose: sessionEntry.workspacePurpose,
        lastConnectionStatus: "connected",
        touchOpenedAt: true,
      }),
    );
  } catch (error) {
    const message =
      formatError?.(error) ?? (error instanceof Error ? error.message : String(error));
    logger.warn("[Root] 手动重连远程 workspace 失败", {
      workspacePath: resolvedWorkspacePath,
      error: message,
    });
    const reasonCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.trim()
        ? error.code
        : "remote-connection-unknown";
    // Bug 原因：失败记录过去只存本地化文案。等待点（需要安装等）也写成失败，原项目交接分不清两类，
    // 线路未识别的旧 tab 只能一律重连，普通失败后每次点击都静默重拨、打不开向导。错误码随文案一起落盘。
    // CR-01：新异常也可能没有有效码；写入通用失败码，避免再次被当成无码旧记录而反复拨号。
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "failed",
        lastConnectionError: message,
        lastConnectionErrorCode: reasonCode,
        touchOpenedAt: false,
      }),
    );
    // 失败事实只在此写回；手动入口收到结构化异常后决定是否交接唯一向导。
    if (showErrorToast && shouldShowStandaloneRemoteErrorToast(reasonCode)) {
      toast(message);
    }
    if (options?.throwOnFailure) {
      // 桌面端重连按钮需要吞掉异常并通过 toast/状态落库反馈，
      // 但手机端 Web 远控是 RPC 语义，必须把失败明确回传给手机端。
      throw error;
    }
  } finally {
    setReconnectingRemoteWorkspaceKeys((currentKeys) =>
      currentKeys.filter((key) => key !== reconnectWorkspaceKey),
    );
  }
}
