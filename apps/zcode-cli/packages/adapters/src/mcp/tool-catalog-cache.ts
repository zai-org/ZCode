import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { mcpConfigKey, resolveMcpToolVisibility } from "@zcode/contracts";
import type {
  McpServerToolSnapshot,
  McpCatalogToolDescriptor,
  McpStdioServerConfig,
  McpToolCatalogLookupResult,
  McpToolCatalogPort,
  McpToolCatalogPublication,
  McpToolCatalogScope,
  McpToolDescriptor,
} from "@zcode/contracts";

const DEFAULT_CAPACITY = 32;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

interface CatalogEntry {
  bytes: number;
  publishedAt: number;
  tools: McpCatalogToolDescriptor[];
}

export interface InMemoryMcpToolCatalogOptions {
  capacity?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
  platform?: NodeJS.Platform | string;
  ttlMs?: number;
  env?: Record<string, string | undefined>;
}

export function createInMemoryMcpToolCatalog(
  options: InMemoryMcpToolCatalogOptions = {},
): McpToolCatalogPort {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const entries = new Map<string, CatalogEntry>();
  let totalBytes = 0;

  const remove = (key: string): void => {
    const existing = entries.get(key);
    if (!existing) return;
    totalBytes -= existing.bytes;
    entries.delete(key);
  };

  const lookup = (servers: readonly PreparedServer[]): McpToolCatalogLookupResult => {
    const byServer: Record<string, McpCatalogToolDescriptor[]> = {};
    let complete = true;
    for (const server of servers) {
      const key = server.cacheKey;
      const entry = key ? entries.get(key) : undefined;
      if (!key || !entry) {
        complete = false;
        continue;
      }
      if (now() - entry.publishedAt > ttlMs) {
        remove(key);
        complete = false;
        continue;
      }
      // Map 的 insertion order 就是 LRU 顺序；读取只更新 recency，不延长 publishedAt TTL。
      entries.delete(key);
      entries.set(key, entry);
      byServer[server.name] = cloneTools(entry.tools);
    }
    return { byServer, status: complete ? "complete" : "incomplete" };
  };

  const publish = (
    servers: readonly PreparedServer[],
    invalidated: ReadonlySet<string>,
    snapshot: Readonly<Record<string, McpServerToolSnapshot>>,
    published: Map<string, string>,
  ): void => {
    for (const server of servers) {
      const key = server.cacheKey;
      if (!key || invalidated.has(key)) continue;
      const row = snapshot[server.name];
      if (!row) continue;
      const status = row.status;
      if (
        status.status === "connecting" ||
        (status.status === "connected" && row.toolsVersion === undefined)
      )
        continue;
      const version = JSON.stringify([status.status, row.toolsVersion]);
      if (published.get(server.name) === version) continue;
      published.set(server.name, version);
      if (status && ["failed", "disabled", "disconnected", "untrusted"].includes(status.status)) {
        remove(key);
        continue;
      }
      if (status?.status !== "connected") continue;

      const tools = sanitizeTools(row.tools ?? []);
      const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
      if (bytes > maxEntryBytes || bytes > maxTotalBytes) {
        remove(key);
        continue;
      }

      remove(key);
      entries.set(key, { bytes, publishedAt: now(), tools });
      totalBytes += bytes;
      while (entries.size > capacity || totalBytes > maxTotalBytes) {
        const oldest = entries.keys().next().value;
        if (typeof oldest !== "string") break;
        remove(oldest);
      }
    }
  };

  return {
    prepare(scope: McpToolCatalogScope): McpToolCatalogPublication {
      const servers = prepareServers(scope, platform, options.env ?? process.env);
      const result = lookup(servers);
      // 读取者不参与生产者任期；只有所有者撤销该 publication 才拒绝后续写入。
      const invalidated = new Set<string>();
      const published = new Map<string, string>();
      return {
        lookup: result,
        publish: (snapshot) => {
          for (const [name, { status }] of Object.entries(snapshot)) {
            if (["failed", "disabled", "disconnected", "untrusted"].includes(status.status))
              delete result.byServer[name];
          }
          publish(servers, invalidated, snapshot, published);
        },
        invalidate: (names) => {
          for (const server of servers) {
            const key = server.cacheKey;
            if (!key || (names && !names.includes(server.name))) continue;
            remove(key);
            invalidated.add(key);
            delete result.byServer[server.name];
          }
        },
      };
    },
  };
}

interface PreparedServer {
  cacheKey?: string;
  name: string;
}

function prepareServers(
  scope: McpToolCatalogScope,
  platform: NodeJS.Platform | string,
  executionEnv: Record<string, string | undefined>,
): PreparedServer[] {
  return Object.entries(scope.servers)
    .filter(([, config]) => config.enabled !== false)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => ({
      cacheKey:
        config.type === "stdio"
          ? createStdioCacheKey(name, config, scope, platform, executionEnv)
          : undefined,
      name,
    }));
}

function createStdioCacheKey(
  serverName: string,
  config: McpStdioServerConfig,
  scope: McpToolCatalogScope,
  platform: NodeJS.Platform | string,
  executionEnv: Record<string, string | undefined>,
): string {
  const workingDirectory = scope.workingDirectory?.trim() || process.cwd();
  const serverCwd = config.cwd ? resolve(workingDirectory, config.cwd) : workingDirectory;
  const workspaceKey = scope.workspaceIdentity?.trim() || workingDirectory;
  const command = normalizeCommand(config.command, serverCwd);
  const env = normalizeEnv(
    Object.fromEntries(
      Object.entries({ ...executionEnv, ...config.env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    platform,
  );
  return createHash("sha256")
    .update(
      mcpConfigKey({
        config,
        args: config.args ?? [],
        clientCapabilities: "zcode-mcp-v1",
        command,
        cwd: serverCwd,
        env,
        isolation: config.isolation ?? "session",
        protocolVersion: config.protocolVersion ?? "auto",
        serverName,
        timeoutMs: config.timeoutMs,
        workspaceKey,
      }),
    )
    .digest("hex");
}

function normalizeCommand(command: string, cwd: string): string {
  return isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? resolve(cwd, command)
    : command;
}

function normalizeEnv(
  env: McpStdioServerConfig["env"],
  platform: NodeJS.Platform | string,
): Array<[string, string]> {
  return Object.entries(env ?? {})
    .map(
      ([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value] as [string, string],
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

function sanitizeTools(descriptors: readonly McpToolDescriptor[]): McpCatalogToolDescriptor[] {
  return descriptors.map((descriptor) => ({
    serverName: descriptor.serverName,
    toolName: descriptor.toolName,
    ...(descriptor.name ? { name: descriptor.name } : {}),
    ...(descriptor.description ? { description: descriptor.description } : {}),
    inputSchema: cloneJson(descriptor.inputSchema),
    ...(descriptor.outputSchema ? { outputSchema: cloneJson(descriptor.outputSchema) } : {}),
    // 显式 false 也要保留，命中缓存时不能退回 server 级 alwaysLoad 默认值。
    ...(typeof descriptor.alwaysLoad === "boolean" ? { alwaysLoad: descriptor.alwaysLoad } : {}),
    ...(descriptor.searchHint ? { searchHint: descriptor.searchHint } : {}),
    // 缓存不保留 ui；只声明 ui.visibility 的工具要按同一规则落到 visibility，避免变成默认 model+app。
    ...(descriptor.visibility || descriptor.ui?.visibility
      ? { visibility: [...resolveMcpToolVisibility(descriptor)] }
      : {}),
  }));
}

function cloneTools(tools: readonly McpCatalogToolDescriptor[]): McpCatalogToolDescriptor[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: cloneJson(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: cloneJson(tool.outputSchema) } : {}),
    ...(tool.visibility ? { visibility: [...tool.visibility] } : {}),
  }));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
