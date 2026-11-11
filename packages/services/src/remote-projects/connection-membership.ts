import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type ConnectionProfile,
  type RemoteTarget,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";

function hostIdForTarget(target: RemoteTarget, sourceServerId?: string): string | null {
  return remoteHostIdFromWorkspaceIdentity(
    sourceServerId
      ? buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" })
      : buildRemoteWorkspaceIdentity("/", target),
  );
}

export function remoteProjectHostIdForTarget(
  target: RemoteTarget,
  sourceServerId?: string,
): string {
  const hostId = hostIdForTarget(target, sourceServerId);
  if (!hostId) throw new Error("remote-project.invalid-host-identity");
  return hostId;
}

export function remoteProjectHostIdForProfile(profile: ConnectionProfile): string {
  return remoteProjectHostIdForTarget(profile.target, profile.sourceServerId);
}

/**
 * 枚举线路找成员行时使用。地址不能构成成员身份（如 IPv6 主机含 `:`）时返回 null：
 * admission 在写入前已拒绝这类线路，它不拥有任何成员行。
 */
export function findRemoteProjectHostIdForProfile(profile: ConnectionProfile): string | null {
  return hostIdForTarget(profile.target, profile.sourceServerId);
}

/** URL transport 沿用 CredentialService；成员服务只收到不含 secret 的连接快照。 */
export async function prepareRemoteServerConnection(input: {
  service: IRemoteProjectService;
  credentials: {
    load(key: string): Promise<string | null>;
    save(key: string, value: string): Promise<void>;
  };
  target: Extract<RemoteTarget, { kind: "server" }>;
  intent: "add" | "retain";
}) {
  const directory = await input.service.readDirectory();
  const requestedId = remoteProjectHostIdForTarget(input.target);
  const existing =
    directory.hosts.find((host) => host.id === requestedId) ??
    (!input.target.serverId
      ? directory.hosts.find(
          (host) => host.target?.kind === "server" && host.target.url === input.target.url,
        )
      : undefined);
  if (input.intent === "retain" && !existing) throw new Error("remote-project.host-removed");
  const saved = existing?.target?.kind === "server" ? existing.target : undefined;
  const id = existing?.id ?? requestedId;
  const tokenCredentialKey =
    saved?.tokenCredentialKey ?? (input.target.token ? `remote-server:${id}:token` : undefined);
  if (input.intent === "add" && input.target.token && tokenCredentialKey)
    await input.credentials.save(tokenCredentialKey, input.target.token);
  const target =
    input.intent === "retain" && saved
      ? saved
      : {
          ...stripRemoteTargetSecrets(input.target),
          ...(saved?.serverId ? { serverId: saved.serverId } : {}),
          ...(tokenCredentialKey ? { tokenCredentialKey } : {}),
        };
  const host = input.intent === "add" ? await input.service.saveHost({ id, target }) : existing!;
  if (host.target?.kind !== "server") throw new Error("remote-project.invalid-server");
  const { tokenCredentialKey: key, ...connectionTarget } = host.target;
  const token = key ? await input.credentials.load(key) : undefined;
  if (key && !token) throw new Error("remote-project.credential-unavailable");
  return {
    target: { ...connectionTarget, ...(token ? { token } : {}) },
    async commit(sourceServerId: string) {
      const bound = await input.service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId: remoteProjectHostIdForTarget(connectionTarget, sourceServerId),
      });
      if (!bound) throw new Error("remote-project.host-removed");
    },
  };
}

/** admission 的对称释放：未识别线路删除或改址后，归还它按地址预留的本机成员行。 */
export async function releaseRemoteProjectProfileHost(
  service: IRemoteProjectService,
  profile: ConnectionProfile,
  profiles: readonly ConnectionProfile[],
): Promise<void> {
  // 已识别线路属于设备行，只能经 removeSourceServer 移除。
  if (profile.sourceServerId) return;
  // Bug 原因：IPv6 等地址不能构成成员身份，这里曾按线路逐条计算 ID 并抛错，列表中只要有一条
  // 这样的线路，删除或改址任何未完成线路都失败。它从未写入预留，既无需释放，也不参与比较。
  const id = findRemoteProjectHostIdForProfile(profile);
  if (!id) return;
  if (
    profiles.some(
      (item) => item.lifecycleState !== "retired" && findRemoteProjectHostIdForProfile(item) === id,
    )
  )
    return;
  // 旧版迁移的地址行可能带侧栏可见的项目入口；它们只由用户显式移除连接。
  if ((await service.readDirectory()).entries.some((entry) => entry.hostId === id)) return;
  await service.removeHost(id);
}

/** 注入既有连接管理器；成员关系不承担网络状态、重试或凭据解析。 */
export function createRemoteProjectConnectionAdmission(service: IRemoteProjectService) {
  return async (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }): Promise<(sourceServerId: string) => Promise<void>> => {
    const id = remoteProjectHostIdForProfile(input.profile);
    const host =
      input.intent === "add"
        ? await service.saveHost({ id, target: input.profile.target })
        : (await service.readDirectory()).hosts.find((item) => item.id === id);
    if (!host) throw new Error("remote-project.host-removed");
    return async (sourceServerId) => {
      const resolvedId = remoteProjectHostIdForProfile({ ...input.profile, sourceServerId });
      const bound = await service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId,
        createDistinctHost: input.confirmIdentityChange,
      });
      if (!bound) throw new Error("remote-project.host-removed");
    };
  };
}
