import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import type {
  PluginSandboxRecord,
  PluginSandboxRegisterInput,
  PluginSandboxRegistryPort,
} from "./contract.js";
import {
  PluginSandboxQuotaError,
  buildPluginSandboxPartition,
  buildPluginSandboxShellUrl,
} from "./contract.js";
import { buildPluginSandboxCsp } from "./csp.js";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;
/** 与 HTML transient activation 一致：一次输入事件给 5 秒窗口，一次性消费。 */
export const PLUGIN_SANDBOX_USER_GESTURE_TTL_MS = 5_000;

export interface CreatePluginSandboxRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  createId?: () => string;
  /** dispose 时通知宿主收尾（关 ports；partition 持久且按可信 App 身份隔离，不撤 protocol、不清存储）。 */
  onDispose?: (record: PluginSandboxRecord) => void;
}

interface RegistryEntry {
  record: PluginSandboxRecord;
  expiresAt: number;
  lastUsedAt: number;
  gestureAt: number | null;
  /** 活 guest 数；> 0 时不参与 TTL 过期。 */
  pinned: number;
}

/**
 * 沙箱注册表：main 进程内插件 UI 沙箱内容与生命周期的唯一 owner。
 * 先例：`createLocalMediaPreviewPathRegistry`——同样是 host 校验后登记、按 TTL / maxEntries 清理。
 */
export function createPluginSandboxRegistry(
  options: CreatePluginSandboxRegistryOptions = {},
): PluginSandboxRegistryPort & {
  /** 幂等 key → sandboxId，供测试与诊断。 */
  size(): number;
  clear(): void;
} {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // sandboxId 进入资源路径；origin 由可信 appIdentity 派生。历史 ID 仍保持合法 host 字符集。
  // CSP host-source 只允许 ALPHA / DIGIT / "-"：带下划线的 source 会被 Chromium 整条忽略，
  // frame-ancestors 退化为 'none'，插件 iframe 直接被 ERR_BLOCKED_BY_RESPONSE 拦成空白页。
  const createId = options.createId ?? (() => `sb-${randomUUID().replaceAll("-", "")}`);
  const entries = new Map<string, RegistryEntry>();
  const idByIdempotencyKey = new Map<string, string>();

  // 修复：不同插件可声明同名 surface，缺少 plugin/workspace 会复用并覆盖另一插件的 HTML。
  const idempotencyKey = (input: {
    ownerWebContentsId: number;
    workspacePath?: string;
    workspaceIdentity?: string;
    sessionId?: string;
    contentKind?: PluginSandboxRecord["contentKind"];
    pluginId?: string;
    scopeId: string;
    serverName?: string;
    instance: PluginSandboxRecord["instance"];
  }) =>
    JSON.stringify([
      input.ownerWebContentsId,
      input.workspaceIdentity?.trim() || input.workspacePath || "",
      input.sessionId ?? "",
      input.contentKind ?? "mcp-app",
      input.pluginId,
      input.scopeId,
      input.serverName,
      input.instance.token,
    ]);

  const remove = (sandboxId: string, notify: boolean) => {
    const entry = entries.get(sandboxId);
    if (!entry) return;
    entries.delete(sandboxId);
    idByIdempotencyKey.delete(idempotencyKey(entry.record));
    if (notify) options.onDispose?.(entry.record);
  };

  const pruneExpired = (observedAt: number) => {
    for (const [sandboxId, entry] of entries) {
      if (entry.pinned === 0 && entry.expiresAt <= observedAt) remove(sandboxId, true);
    }
  };

  // 句柄只带登记输入里声明过的呈现字段（host 桥已按"资源级优先、工具级兜底"合并）；prefersBorder 在
  // record 上缺省为 false，所以按输入而不是 record 判断"是否声明"。
  const resourceMetaOf = (
    input: Pick<
      PluginSandboxRegisterInput,
      | "prefersBorder"
      | "heightHint"
      | "minFrameHeight"
      | "showInline"
      | "permissions"
      | "backgroundRetention"
    >,
  ): PluginSandboxHandle["resourceMeta"] => {
    const meta = {
      ...(input.permissions?.length ? { permissions: [...input.permissions] } : {}),
      ...(input.prefersBorder !== undefined ? { prefersBorder: input.prefersBorder } : {}),
      ...(input.heightHint !== undefined ? { heightHint: input.heightHint } : {}),
      ...(input.minFrameHeight !== undefined ? { minFrameHeight: input.minFrameHeight } : {}),
      ...(input.showInline !== undefined ? { showInline: input.showInline } : {}),
      ...(input.backgroundRetention !== undefined
        ? { backgroundRetention: input.backgroundRetention }
        : {}),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
  };

  const toHandle = (record: PluginSandboxRecord): PluginSandboxHandle => ({
    instance: record.instance,
    sandboxId: record.sandboxId,
    initId: record.initId,
    shellUrl: record.shellUrl,
    partition: record.partition,
    ...(record.resourceMeta ? { resourceMeta: record.resourceMeta } : {}),
  });

  return {
    register(input: PluginSandboxRegisterInput): PluginSandboxHandle {
      if (input.contentKind === "extension") {
        // 扩展视图（docs/plugins/extension-host.md §8）不属于会话：按插件归属，不带原生权限。
        if (!input.pluginId || input.sessionId || input.serverName || input.permissions?.length)
          throw new Error("Invalid extension view provenance");
      } else {
        if (!input.sessionId) throw new Error("Missing sandbox session");
        if (input.contentKind !== "gen-ui" && (!input.pluginId || !input.serverName))
          throw new Error("Missing MCP App provenance");
        if (
          input.contentKind === "gen-ui" &&
          (input.pluginId || input.serverName || input.permissions?.length)
        )
          throw new Error("Invalid Gen UI capabilities");
      }
      const observedAt = now();
      pruneExpired(observedAt);
      const key = idempotencyKey(input);
      const existingId = idByIdempotencyKey.get(key);
      const existing = existingId ? entries.get(existingId) : undefined;
      if (existing) return toHandle(existing.record);
      // 未挂载的 prepare 也可能仍在传输；回收由页面 owner 完成，Main 不抢占其他窗口的登记。
      if (entries.size >= maxEntries) throw new PluginSandboxQuotaError(maxEntries);
      const sandboxId = createId();
      const record: PluginSandboxRecord = {
        instance: input.instance,
        sandboxId,
        initId: 1,
        shellUrl: buildPluginSandboxShellUrl(sandboxId, input.instance.appIdentity),
        partition:
          input.contentKind === "gen-ui"
            ? `gen-ui-${input.instance.appIdentity}`
            : buildPluginSandboxPartition({
                appIdentity: input.instance.appIdentity,
              }),
        ownerWebContentsId: input.ownerWebContentsId,
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        contentKind: input.contentKind,
        pluginId: input.pluginId,
        serverName: input.serverName,
        scopeId: input.scopeId,
        html: input.html,
        cspHeader: buildPluginSandboxCsp({
          csp: input.csp,
          cspRelaxations: input.cspRelaxations,
          sandboxId,
          appIdentity: input.instance.appIdentity,
        }),
        ...(input.cspRelaxations ? { cspRelaxations: input.cspRelaxations } : {}),
        ...(input.permissions?.length ? { permissions: [...input.permissions] } : {}),
        prefersBorder: input.prefersBorder ?? false,
        ...(resourceMetaOf(input) ? { resourceMeta: resourceMetaOf(input) } : {}),
      };
      entries.set(sandboxId, {
        record,
        expiresAt: observedAt + ttlMs,
        lastUsedAt: observedAt,
        gestureAt: null,
        pinned: 0,
      });
      idByIdempotencyKey.set(key, sandboxId);
      return toHandle(record);
    },
    get(sandboxId) {
      const observedAt = now();
      pruneExpired(observedAt);
      const entry = entries.get(sandboxId);
      if (!entry) return null;
      entry.lastUsedAt = observedAt;
      return entry.record;
    },
    dispose(sandboxId, initId) {
      if (initId !== undefined && entries.get(sandboxId)?.record.initId !== initId) return;
      remove(sandboxId, true);
    },
    disposeOwner(ownerWebContentsId) {
      for (const [sandboxId, entry] of entries) {
        if (entry.record.ownerWebContentsId === ownerWebContentsId) remove(sandboxId, true);
      }
    },
    pin(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry) entry.pinned += 1;
    },
    unpin(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry && entry.pinned > 0) entry.pinned -= 1;
    },
    markUserGesture(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry) entry.gestureAt = now();
    },
    consumeUserGesture(sandboxId) {
      const entry = entries.get(sandboxId);
      if (!entry || entry.gestureAt === null) return false;
      const fresh = now() - entry.gestureAt <= PLUGIN_SANDBOX_USER_GESTURE_TTL_MS;
      entry.gestureAt = null;
      return fresh;
    },
    size: () => entries.size,
    clear() {
      // Map.forEach 中删除当前项是安全的，不需要先拷贝 key 列表。
      entries.forEach((_entry, sandboxId) => remove(sandboxId, true));
    },
  };
}
