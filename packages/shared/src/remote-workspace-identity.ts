// 远程 workspace identity 的统一解析工具（Workspace Identity 约束：构造与解析
// 必须复用统一工具，禁止业务代码手写拼接/拆解规则）。
// 构造侧（对偶）：packages/ui/src/lib/remoteWorkspaceHistory.ts 的
// buildRemoteWorkspaceIdentity —— 格式契约：
//   remote:ssh:<host>:<port>:<username>:<posixPath>
//   remote:wsl:<distro>[:<user>]:<posixPath>
//   remote:docker:<container>:<posixPath>
// path 段经 normalizeWorkspacePathForIdentity 归一（分隔符 → "/"，去收尾斜杠，
// 空 → "/"），因此恒以 "/" 开头；authority 各段不含 "/"（host 小写、port 数字、
// docker 容器名/wsl 发行版名的合法字符集均不含 ":" 与 "/"）。
// 消费方：CLI v4 createSession 的 workspaceId（远程 pane 里 workspaceKey =
// identity）需要还原出真实 workspacePath 作为会话 workingDirectory。
import type { RemoteTarget } from "./remoteTarget.js";

export type RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker" | "server";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  /** kind=server 时的稳定 Source Server id。 */
  sourceServerId?: string;
  /** 远端真实路径（posix 归一形态）。 */
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

/** authority 必选段数（不含 kind）：ssh = host/port/username，其余远端类型 = 单段。 */
const AUTHORITY_SEGMENTS: Record<RemoteWorkspaceIdentityKind, number> = {
  ssh: 3,
  wsl: 1,
  docker: 1,
  server: 1,
};

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh" || value === "wsl" || value === "docker" || value === "server";
}

function normalizeWorkspacePathForIdentity(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

function resolveServerIdentityId(target: Extract<RemoteTarget, { kind: "server" }>): string {
  const explicit = target.serverId?.trim() || target.name?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    return new URL(target.url.trim()).host;
  } catch {
    return target.url.trim();
  }
}

function normalizeServerIdForIdentity(serverId: string): string {
  const normalized = serverId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error("serverId must contain at least one identity-safe character");
  }
  return normalized;
}

export interface BuildServerRemoteWorkspaceIdentityOptions {
  serverId: string;
  workspacePath: string;
}

export function buildServerRemoteWorkspaceIdentity(
  options: BuildServerRemoteWorkspaceIdentityOptions,
): string {
  const serverId = normalizeServerIdForIdentity(options.serverId);
  const workspacePath = normalizeWorkspacePathForIdentity(options.workspacePath);
  return `${REMOTE_IDENTITY_PREFIX}server:${serverId}:${workspacePath}`;
}

/**
 * 统一构造远程 workspace identity。Host、Main 和 UI 禁止自行拼接 authority；
 * `workspacePath` 只在这里归一后进入身份键，实际 IO 仍使用调用方原路径。
 */
export function buildRemoteWorkspaceIdentity(workspacePath: string, target: RemoteTarget): string {
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  switch (target.kind) {
    case "ssh":
      return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
    case "wsl": {
      const distro = target.distro?.trim() || "default";
      const user = target.user?.trim();
      return user
        ? `remote:wsl:${distro}:${user}:${normalizedPath}`
        : `remote:wsl:${distro}:${normalizedPath}`;
    }
    case "docker":
      return `remote:docker:${target.container}:${normalizedPath}`;
    case "server":
      return buildServerRemoteWorkspaceIdentity({
        serverId: resolveServerIdentityId(target),
        workspacePath: normalizedPath,
      });
  }
}

/**
 * 解析远程 workspace identity；非法/非远程 identity 返回 null（调用方回落
 * 「按本地 workspacePath 处理」）。只提取 workspacePath——authority 细节
 * （host/port 等）对消费方（CLI 运行在远端机器上）无意义，不透出。
 */
export function parseRemoteWorkspaceIdentity(
  identity: string,
): ParsedRemoteWorkspaceIdentity | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    return null;
  }
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) {
    return null;
  }
  const kind = rest.slice(0, kindEnd);
  if (!isRemoteWorkspaceIdentityKind(kind)) {
    return null;
  }
  // 逐段消费 authority；path 段可能含 ":"（理论上 posix 路径允许），
  // 因此不能整体 split——按段推进后取剩余整段为 path。
  let cursor = kindEnd + 1;
  let sourceServerId: string | undefined;
  for (let i = 0; i < AUTHORITY_SEGMENTS[kind]; i++) {
    // SSH 用户名可能含冒号；按单个冒号截断会让连接准入和目录状态读取误报身份非法。
    // 第三段以绝对路径前的 ":/" 收口，保留原身份字符串及用户名，不改凭据或存量键。
    const separator = kind === "ssh" && i === 2 ? ":/" : ":";
    const next = rest.indexOf(separator, cursor);
    if (next <= cursor) {
      return null;
    }
    if (kind === "server" && i === 0) sourceServerId = rest.slice(cursor, next);
    cursor = next + 1;
  }
  // WSL identity 为区分默认用户与显式用户增加了可选 user 段，旧解析器
  // 仍只消费 distro，导致 user 被误判为路径并让 identity 整体解析失败。远端路径
  // 必须以 "/" 开头，因此可以无歧义地区分 legacy 无 user 格式与显式 user 格式。
  if (kind === "wsl" && rest[cursor] !== "/") {
    const userEnd = rest.indexOf(":", cursor);
    if (userEnd <= cursor) {
      return null;
    }
    cursor = userEnd + 1;
  }
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) {
    return null;
  }
  return { kind, workspacePath, ...(sourceServerId ? { sourceServerId } : {}) };
}

/**
 * 按 identity 授权的场景（Hook Trust）使用的远程身份：保留调用方远程 identity 的 host 命名空间，
 * 路径一律取实际执行目录 workspacePath。不带 `remote:` 前缀的 identity 返回 null，由调用方按本地规则处理。
 *
 * 修复原因（CR-01）：曾在 identity 路径与执行目录不一致时退回本地裸路径，远程请求可命中本地
 * 已有授权，不同服务器也会落到同一个键。远程 identity 永远不能进入本地命名空间；
 * 路径改用执行目录后，identity 中的 `..` 等非规范写法也不再影响结果。
 * 带 `remote:` 前缀但解析失败的 identity 原样返回（第三轮 CR-01）：它同样不能落入本地命名空间；
 * 原样字符串不可能等于合法远程键或本地路径，只会命中它自己的记录，与修复前对非空 identity 的处理一致。
 */
export function remoteWorkspaceTrustIdentity(
  identity: string,
  workspacePath: string,
): string | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) return null;
  const hostId = remoteHostIdFromWorkspaceIdentity(identity);
  return hostId === null ? identity : buildRemoteHostWorkspaceIdentity(hostId, workspacePath);
}

/** identity 是否是远程 workspace identity（可被 parseRemoteWorkspaceIdentity 解析）。 */
export function isRemoteWorkspaceIdentity(identity: string): boolean {
  return parseRemoteWorkspaceIdentity(identity) !== null;
}

/** 虚拟项目的 host 身份；只在统一 identity 模块裁剪路径，业务层不得自行拆 authority。 */
export function remoteHostIdFromWorkspaceIdentity(identity: string): string | null {
  const parsed = parseRemoteWorkspaceIdentity(identity);
  return parsed ? identity.slice(0, -(parsed.workspacePath.length + 1)) : null;
}

/** 从已登记的 Host 身份构造目录身份；不让业务模块拼接或解析 authority。 */
export function buildRemoteHostWorkspaceIdentity(hostId: string, workspacePath: string): string {
  const identity = `${hostId}:${normalizeWorkspacePathForIdentity(workspacePath)}`;
  if (remoteHostIdFromWorkspaceIdentity(identity) !== hostId)
    throw new Error("Invalid remote host identity");
  return identity;
}
