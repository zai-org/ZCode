import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  createConfig,
  ZCodeConfigFileSchema,
  type ConfigFactoryOptions,
} from "@zcode/adapters/config";
import { resolveWorkspaceHookTrustStorePath } from "@zcode/adapters/storage";
import type {
  McpPort,
  McpServerConfig,
  McpServerStatus,
  WorkspaceMcpAdmissionUpdatedPayload,
} from "@zcode/contracts";
import { sanitizeHookDisplayText } from "@zcode/core";
import { normalizeMcpStdioCommand } from "@zcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { WorkspaceMcpTrustContract, WorkspaceMcpTrustReview } from "./contract.js";

export type { WorkspaceMcpTrustContract, WorkspaceMcpTrustReview } from "./contract.js";
const STORE_NAME = "workspace-mcp-trust-v1.json";
const recordSchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    serverName: z.string().min(1),
    declarationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    grantedAt: z.string().datetime(),
  })
  .strict();
const storeSchema = z
  .object({ schemaVersion: z.literal(1), records: z.array(recordSchema) })
  .strict();
type TrustRecord = z.infer<typeof recordSchema>;
type Declaration = { config: McpServerConfig; sourcePaths: string[]; declarationDigest: string };

/** 同一 Host 的用户存储是唯一授权 owner；项目 storage.dir 不能选择信任文件。 */
export function createWorkspaceMcpTrust(
  options: ConfigFactoryOptions & {
    workingDirectory: string;
    workspaceIdentity?: string;
    onAdmissionChanged?: (state: WorkspaceMcpAdmissionUpdatedPayload) => Promise<void>;
  },
): WorkspaceMcpTrustContract {
  const workingDirectory = resolve(options.workingDirectory);
  const workspaceIdentity = options.workspaceIdentity?.trim() || workingDirectory;
  const requiredNames = new Set<string>();
  const storePath = async () =>
    join(
      dirname(
        await resolveWorkspaceHookTrustStorePath({
          userConfigPath: options.userConfigPath,
        }),
      ),
      STORE_NAME,
    );
  const digest = (name: string, config: McpServerConfig, sourcePaths: string[]) =>
    hash({
      version: 1,
      workspaceIdentity,
      workingDirectory,
      serverName: name,
      sourcePaths,
      config: executionConfig(config, workingDirectory),
    });
  async function discover(): Promise<Record<string, Declaration>> {
    const result = createConfig({ ...options, workingDirectory });
    if (result.sources.project.diagnostics.some((item) => item.severity === "error")) {
      throw new Error("workspace_mcp_config_unreadable");
    }
    const declarations: Record<string, Declaration> = {};
    for (const [name, config] of Object.entries(result.config.mcp.servers)) {
      if (result.sources.mcp.serverSources[name] !== "project") continue;
      const sourcePaths = result.sources.project.paths;
      declarations[name] = {
        config,
        sourcePaths,
        declarationDigest: digest(name, config, sourcePaths),
      };
    }
    // 设置目录按条目数选择来源；空 map 也要回退，但不能用 fallback 替换校验失败的项目条目。
    if (
      result.sources.project.mcpServerNames.length === 0 &&
      !result.sources.project.diagnostics.some((item) => item.code === "config_mcp_server_invalid")
    ) {
      const path = join(workingDirectory, ".agents", "mcp.json");
      const raw = await readJson(path);
      if (raw !== undefined) {
        const object = z
          .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
          .parse(raw);
        for (const [name, value] of Object.entries(object.mcpServers ?? {})) {
          const source = result.sources.mcp.serverSources[name];
          if (source && source !== "project") continue;
          // 坏邻项不得拖垮列表；仍记住工作区来源，不能把校验失败误当成用户可信配置。
          requiredNames.add(name);
          const parsed = ZCodeConfigFileSchema.safeParse({ mcp: { servers: { [name]: value } } });
          if (!parsed.success) continue;
          const config = parsed.data.mcp!.servers![name]!;
          const sourcePaths = [path];
          declarations[name] = {
            config,
            sourcePaths,
            declarationDigest: digest(name, config, sourcePaths),
          };
        }
      }
    }
    for (const name of Object.keys(declarations)) requiredNames.add(name);
    return declarations;
  }
  async function records(path?: string): Promise<TrustRecord[]> {
    const raw = await readJson(path ?? (await storePath()));
    return raw === undefined ? [] : storeSchema.parse(raw).records;
  }
  const matches = (record: TrustRecord, name: string, value: string) =>
    record.workspaceIdentity === workspaceIdentity &&
    record.serverName === name &&
    record.declarationDigest === value;
  async function inspect(): Promise<Record<string, WorkspaceMcpTrustReview>> {
    let declarations: Record<string, Declaration>;
    try {
      declarations = await discover();
    } catch {
      // 读取失败没有可批准的声明；执行 gate 仍拒绝，不能连带中断用户/插件 MCP 列表。
      return {};
    }
    if (Object.keys(declarations).length === 0) return {};
    let trusted: TrustRecord[] = [];
    try {
      trusted = await records();
    } catch {
      /* 损坏存储不能把已有声明显示成可信。 */
    }
    return Object.fromEntries(
      Object.entries(declarations).map(([name, entry]) => [
        name,
        {
          declarationDigest: entry.declarationDigest,
          configuredEnabled: entry.config.enabled !== false,
          transport: entry.config.type,
          sourcePaths: entry.sourcePaths,
          display: displayConfig(entry.config, workingDirectory),
          trusted: trusted.some((record) => matches(record, name, entry.declarationDigest)),
        },
      ]),
    );
  }
  async function allows(name: string, config: McpServerConfig): Promise<boolean> {
    // 只处理直接工作区配置。插件及 Host 内建 MCP 不继承同名项目声明。
    if (
      config.source?.kind === "plugin" ||
      config.source?.kind === "builtin" ||
      config.source?.kind === "user"
    )
      return true;
    try {
      const entry = (await discover())[name];
      if (!entry) return config.source?.kind !== "workspace" && !requiredNames.has(name);
      if (
        entry.config.enabled === false ||
        digest(name, config, entry.sourcePaths) !== entry.declarationDigest
      )
        return false;
      return (await records()).some((record) => matches(record, name, entry.declarationDigest));
    } catch {
      return false;
    }
  }
  const authority: WorkspaceMcpTrustContract = {
    inspect,
    allows,
    async decide(name, declarationDigest, trusted) {
      const path = await storePath();
      await withFileLock(path, async () => {
        const entry = (await discover())[name];
        if (!entry || entry.declarationDigest !== declarationDigest)
          throw new Error("workspace_mcp_declaration_changed");
        const current = await records(path);
        const next = current.filter((record) => !matches(record, name, declarationDigest));
        if (trusted)
          next.push({
            workspaceIdentity,
            serverName: name,
            declarationDigest,
            grantedAt: new Date().toISOString(),
          });
        await atomicWritePrivateTextFile(path, JSON.stringify({ schemaVersion: 1, records: next }));
      });
    },
    guard: (port, signal) =>
      guardPort(
        port,
        authority,
        { workingDirectory, workspaceIdentity },
        signal,
        options.onAdmissionChanged,
      ),
  };
  return authority;
}

function executionConfig(config: McpServerConfig, workingDirectory: string): unknown {
  const { enabled: _enabled, source: _source, ...execution } = config;
  return config.type === "stdio"
    ? {
        ...execution,
        ...normalizeMcpStdioCommand(config.command, config.args),
        env: config.env ?? {},
        cwd: config.cwd
          ? isAbsolute(config.cwd)
            ? config.cwd
            : resolve(workingDirectory, config.cwd)
          : workingDirectory,
      }
    : { ...execution, headers: config.headers ?? {} };
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          );
        }
        return item;
      }),
    )
    .digest("hex");
}
function displayConfig(config: McpServerConfig, workingDirectory: string): string {
  if (config.type === "stdio")
    return sanitizeHookDisplayText(
      JSON.stringify(
        {
          command: sanitizeHookDisplayText([config.command, ...(config.args ?? [])].join(" ")),
          cwd: config.cwd ?? workingDirectory,
          env: Object.keys(config.env ?? {}),
        },
        null,
        2,
      ),
    );
  const url = new URL(config.url);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return JSON.stringify(
    {
      type: config.type,
      url: url.toString(),
      headers: Object.keys(config.headers ?? {}),
      oauth: config.oauth?.type,
    },
    null,
    2,
  );
}
async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

/** 准入包住 lease 而非 UI；subagent、旧连接和资源读取也必须经过同一权限边界。 */
function guardPort(
  port: McpPort,
  authority: WorkspaceMcpTrustContract,
  target: {
    workingDirectory: string;
    workspaceIdentity: string;
  },
  signal?: AbortSignal,
  onAdmissionChanged?: (state: WorkspaceMcpAdmissionUpdatedPayload) => Promise<void>,
): McpPort {
  const configurations = new Map<string, McpServerConfig>();
  const blocked = new Map<string, McpServerStatus>();
  let mutationTail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const isClosed = () => closed || signal?.aborted === true;
  let admissionTail = Promise.resolve();
  let publishedAdmission: string | undefined;
  const refreshWorkspaceTrustAdmission = (reannounce = false): Promise<void> => {
    if (!onAdmissionChanged || isClosed()) return Promise.resolve();
    // 重读与发布共用一个顺序，避免设置授权后的清零被较早的 pending 读取覆盖。
    const next = admissionTail.then(async () => {
      if (isClosed()) return;
      const pending = Object.entries(await authority.inspect())
        .filter(([, review]) => review.configuredEnabled && !review.trusted)
        .map(([name, review]) => [name, review.declarationDigest] as const)
        .sort(([left], [right]) => left.localeCompare(right));
      if (!reannounce && publishedAdmission === undefined && pending.length === 0) return;
      const state = {
        pendingCount: pending.length,
        bundleDigest: hash(pending),
        workspaceIdentity: target.workspaceIdentity,
      };
      const serialized = JSON.stringify(state);
      if (isClosed() || (!reannounce && publishedAdmission === serialized)) return;
      await onAdmissionChanged(state);
      publishedAdmission = serialized;
    });
    admissionTail = next.catch(() => undefined);
    return next;
  };
  // 进行中变更的准入判定段（读信任记录、写 configurations/blocked）；请求只等这一段。
  let deciding: Promise<void> = Promise.resolve();
  // 连接替换只有一个 owner；配置 A 的迟到握手不能覆盖配置 B 的执行映射。
  // 每个变更先同步登记自己的判定段，判定完成即调用 decided，再等连接握手。
  const mutate = <T>(operation: (decided: () => void) => Promise<T>): Promise<T> => {
    const result = mutationTail.then(async () => {
      if (isClosed()) throw new Error("MCP port is closed");
      const decision = Promise.withResolvers<void>();
      deciding = decision.promise;
      try {
        return await operation(decision.resolve);
      } finally {
        decision.resolve();
      }
    });
    mutationTail = result.catch(() => undefined);
    return result;
  };
  // reconcile 先释放工作区 server、等其他 server 握手后再重新连接；这段时间内对它的请求等它重连。
  const reconnecting = new Map<string, Promise<void>>();
  // 修复原因：请求过去等整条变更队列（含其他 server 的连接握手），后台启动和配置热更新期间，
  // 调用已连上的 A 要等最慢的 B，等待中排进新变更还会以 pending_trust 失败。现在只等进行中的
  // 判定段结束；判定段内 configurations/blocked 会被清空重建，不能读到中间状态。目标 server 正在
  // reconcile 里重连时还要等它连上，否则请求落到已释放的连接上失败。
  const settledAdmission = async (name: string): Promise<void> => {
    for (let current = deciding; ; current = deciding) {
      await current;
      const pending = reconnecting.get(name);
      if (pending) await pending;
      else if (current === deciding) return;
    }
  };
  const blockedStatus = (config: McpServerConfig): McpServerStatus => ({
    status: config.enabled === false ? "disabled" : "untrusted",
    transport: config.type,
    toolCount: 0,
    updatedAt: new Date().toISOString(),
  });
  // 授权变化允许延迟到下次连接准入；连接内只查已有结果，避免逐次同步读配置。
  const isAdmitted = (name: string) =>
    !isClosed() && configurations.has(name) && !blocked.has(name);
  async function admitted(name: string): Promise<boolean> {
    const config = configurations.get(name);
    if (!config) return false;
    const allowed = config.enabled !== false && (await authority.allows(name, config));
    if (isClosed() || configurations.get(name) !== config) return false;
    if (allowed) {
      blocked.delete(name);
      return true;
    }
    blocked.set(name, blockedStatus(config));
    return false;
  }
  const requestMethods = new Set([
    "callTool",
    "readResource",
    "listResources",
    "listResourceTemplates",
    "subscribeResource",
    "unsubscribeResource",
  ]);
  return new Proxy(port, {
    get(raw, key) {
      if (key === "refreshWorkspaceTrustAdmission") return refreshWorkspaceTrustAdmission;
      if (key === "close")
        return async () => {
          closed = true;
          configurations.clear();
          blocked.clear();
          await raw.close();
        };
      if (key === "disconnectServer")
        return (name: string) =>
          mutate(async (decided) => {
            configurations.delete(name);
            blocked.delete(name);
            decided();
            return raw.disconnectServer(name);
          });
      if (key === "connectServer")
        return async (name: string, config: McpServerConfig, options = {}) => {
          // 审核、摘要与传输使用同一不可变副本，调用方修改原对象不能批准 A 后执行 B。
          const frozen = JSON.parse(JSON.stringify(config)) as McpServerConfig;
          return mutate(async (decided) => {
            configurations.set(name, frozen);
            // 工作区声明检查完成前默认拒绝；明确的用户/插件来源保持原准入语义。
            if (frozen.enabled === false || !frozen.source || frozen.source.kind === "workspace")
              blocked.set(name, blockedStatus(frozen));
            else blocked.delete(name);
            const allowed = await admitted(name);
            decided();
            if (!allowed || isClosed()) {
              if (isClosed()) throw new Error("MCP port is closed");
              await raw.disconnectServer(name);
              return blocked.get(name)!;
            }
            return raw.connectServer(name, frozen, { ...options, ...target });
          });
        };
      if (key === "connectConfiguredServers")
        return async (servers: Record<string, McpServerConfig>, options = {}) => {
          const frozen = JSON.parse(JSON.stringify(servers)) as Record<string, McpServerConfig>;
          return mutate(async (decided) => {
            configurations.clear();
            blocked.clear();
            for (const [name, config] of Object.entries(frozen)) {
              configurations.set(name, config);
              if (config.enabled === false || !config.source || config.source.kind === "workspace")
                blocked.set(name, blockedStatus(config));
            }
            const accepted: Record<string, McpServerConfig> = {};
            const workspaceServers: Record<string, McpServerConfig> = {};
            for (const [name, config] of Object.entries(frozen)) {
              if (!(await admitted(name))) continue;
              if (
                config.source?.kind === "workspace" ||
                (!config.source && (await authority.inspect())[name])
              )
                workspaceServers[name] = config;
              else accepted[name] = config;
            }
            const reconnected = Promise.withResolvers<void>();
            for (const name of Object.keys(workspaceServers))
              reconnecting.set(name, reconnected.promise);
            decided();
            try {
              if (isClosed()) throw new Error("MCP port is closed");
              await raw.connectConfiguredServers(accepted, { ...options, ...target });
              // 普通 MCP 的慢握手不能让工作区授权检查提前；每个实际连接前再验一次。
              await Promise.all(
                Object.entries(workspaceServers).map(async ([name, config]) => {
                  if ((await admitted(name)) && !isClosed())
                    await raw.connectServer(name, config, { ...options, ...target });
                }),
              );
              const statuses = { ...(await raw.status()), ...Object.fromEntries(blocked) };
              const tools = (await raw.listTools()).filter(
                (tool) => !blocked.has(tool.serverName) && configurations.has(tool.serverName),
              );
              return { statuses, tools };
            } finally {
              for (const name of Object.keys(workspaceServers))
                if (reconnecting.get(name) === reconnected.promise) reconnecting.delete(name);
              reconnected.resolve();
            }
          });
        };
      if (key === "status")
        return async () => {
          return { ...(await raw.status()), ...Object.fromEntries(blocked) };
        };
      if (key === "listTools")
        return async () => {
          const allowed = new Set<string>();
          for (const name of configurations.keys()) if (isAdmitted(name)) allowed.add(name);
          return (await raw.listTools()).filter((tool) => allowed.has(tool.serverName));
        };
      const method = Reflect.get(raw, key, raw);
      if (typeof method !== "function") return method;
      if (requestMethods.has(String(key)))
        return async (request: { serverName: string }, ...args: unknown[]) => {
          await settledAdmission(request.serverName);
          if (!isAdmitted(request.serverName)) throw new Error("workspace_mcp_pending_trust");
          return method.call(raw, request, ...args);
        };
      if (key === "pingServer")
        return async (name: string, ...args: unknown[]) => {
          await settledAdmission(name);
          return isAdmitted(name) ? method.call(raw, name, ...args) : false;
        };
      if (key === "appConnectionSnapshot")
        return (name: string) => (blocked.has(name) ? null : method.call(raw, name));
      if (key === "waitForAppConnection")
        return async (name: string) => (isAdmitted(name) ? method.call(raw, name) : null);
      // 按 subscriber 释放只清理已有订阅；执行授权失败不能阻止 MCP App 生命周期收尾。
      return method.bind(raw);
    },
  });
}
