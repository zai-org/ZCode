import { readFile } from "node:fs/promises";
import { Emitter, type Event } from "@zcode/rpc";
import { atomicWritePrivateTextFile, backupCorruptFile } from "@zcode/shared/node";
import {
  extensionActivationHoldSchema,
  extensionGrantSchema,
  grantsCover,
  grantsCoverAll,
  EXTENSION_SESSION_CONSENT_REVISION,
  isSessionGrant,
  needsSessionReconsent,
  normalizeGrants,
  type ExtensionActivationHold,
  type ExtensionGrant,
  type ExtensionGrantState,
  type ExtensionGrantsSnapshot,
  type ExtensionStaticTable,
  type StaticPlugin,
} from "@zcode/shared/extension-host";
import { z } from "zod";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

// 授权记录（docs/plugins/extension-host.md §17.7）：唯一 owner 是本服务，文件
// `~/.zcode/v2/extensions/grants.json`。没有记录就拒绝。卸载删除记录，禁用不删。
//
//   grants.json（记录）⊕ 静态表（清单声明的档位与版本）──► 生效档位 + 整份授权状态（带 rev）
//
// 插件更新（静态表重读）时按清单重算：声明没有超出记录 → 不再询问，静默记下新版本；声明变多 → 回到待授权
// （会话能力报 not-granted），记录保留，等用户确认；声明变少 → 记录自动收窄。
// 记录的 consentRevision 低于当前值、声明覆盖 sessions.write → 同样回到待授权（§17.12，会话档位含义变宽）。
// 生效档位只按「记录 ⊕ 最近一份静态表」现算，不维护第二份。

const GRANTS_FILE_VERSION = 1;

const grantRecordSchema = z.object({
  grants: z.array(extensionGrantSchema),
  consentedVersion: z.string().optional(),
  consentedAt: z.number().int().nonnegative(),
  /** 同意时会话档位含义的版本（§17.12）；旧文件没有这个字段，按 1 处理。 */
  consentRevision: z.number().int().positive().optional(),
  /** 详情页「系统通知」开关关了（§18.1 H8）；没有这个字段按开处理，旧文件照常读。 */
  notificationsOff: z.literal(true).optional(),
});
type GrantRecord = z.infer<typeof grantRecordSchema>;

/** 从插件商店安装后、激活前的确认（§17.7，P3b）：pending 等用户确认，declined 用户选择不激活。 */
const activationRecordSchema = z.object({
  state: extensionActivationHoldSchema,
  version: z.string().optional(),
  at: z.number().int().nonnegative(),
});
type ActivationRecord = z.infer<typeof activationRecordSchema>;

const grantsFileSchema = z.object({
  version: z.literal(GRANTS_FILE_VERSION),
  plugins: z.record(z.string(), grantRecordSchema),
  // 可选键（P3b）：旧文件没有它照常读。
  activations: z.record(z.string(), activationRecordSchema).optional(),
});

export interface GrantsStoreDeps {
  filePath: string;
  logger: Pick<ServiceLogger, "info" | "warn">;
  now?: () => number;
}

export interface GrantsStore {
  /** 读完 grants.json 后 resolve（读不出时按没有记录处理，不 reject）。 */
  readonly ready: Promise<void>;
  /** 整份授权状态的变化（rev 递增）。 */
  readonly onDidChange: Event<ExtensionGrantsSnapshot>;
  snapshot(): ExtensionGrantsSnapshot;
  /** 当前是否授予了覆盖该档位的权限（记录 ⊕ 最近一份静态表）。 */
  covers(pluginId: string, grant: ExtensionGrant): boolean;
  /**
   * 静态表重读后调用：按清单收窄记录、静默记下新版本。返回生效档位变少的插件（调用方中止它们在途的调用）。
   */
  reconcile(table: ExtensionStaticTable): string[];
  /**
   * 用户确认授权：grants 必须等于清单当前声明的档位。写文件后调 afterCommit（写审计），再发布新状态。
   * 返回授予的档位。
   */
  grant(
    pluginId: string,
    grants: readonly ExtensionGrant[],
    afterCommit?: (tiers: ExtensionGrant[]) => Promise<void>,
  ): Promise<ExtensionGrant[]>;
  /** 撤销并删除记录（卸载也走这里），顺序同 grant。返回被撤销的档位；没有记录时为空。 */
  revoke(
    pluginId: string,
    afterCommit?: (tiers: ExtensionGrant[]) => Promise<void>,
  ): Promise<ExtensionGrant[]>;
  /**
   * 详情页「系统通知」开关（§18.1 H8）：只在通知档位生效时可改。顺序同 grant（写文件 → afterCommit → 发布）。
   * 返回是否改了（值没变时 false，不写文件）。
   */
  setNotificationsEnabled(
    pluginId: string,
    enabled: boolean,
    afterCommit?: () => Promise<void>,
  ): Promise<boolean>;
  /** 持有生效会话权限的插件（启用确认用，只看会话档位），不含 exclude。 */
  holders(exclude?: string): Array<{ pluginId: string; name: string; granted: ExtensionGrant[] }>;
  /** 该插件是否在等待激活确认（pending）或用户选择了不激活（declined）。 */
  activationHold(pluginId: string): ExtensionActivationHold | undefined;
  /** 商店安装后先不激活（§17.7）：记为 pending 并写文件。 */
  holdActivation(pluginId: string, version: string | undefined): Promise<void>;
  /** 用户的决定：allow 删除记录（激活），否则记为 declined。没有 pending 记录时返回 false。 */
  decideActivation(pluginId: string, allow: boolean): Promise<boolean>;
  /** 删除记录（设置页重新启用、卸载）。没有记录时返回 false。 */
  clearActivation(pluginId: string): Promise<boolean>;
  dispose(): void;
}

function okExtension(plugin: StaticPlugin | undefined) {
  return plugin?.extension?.state === "ok" ? plugin.extension : null;
}

export function createGrantsStore(deps: GrantsStoreDeps): GrantsStore {
  const now = deps.now ?? Date.now;
  const records = new Map<string, GrantRecord>();
  const activations = new Map<string, ActivationRecord>();
  const plugins = new Map<string, StaticPlugin>();
  const changes = new Emitter<ExtensionGrantsSnapshot>();
  let current: ExtensionGrantsSnapshot = { rev: 0, plugins: [] };
  let currentKey = "[]";
  let writeChain: Promise<void> = Promise.resolve();
  let disposed = false;

  /** 一个插件的状态；既没有声明档位也没有记录的插件不出现在授权状态里。 */
  const stateOf = (pluginId: string): ExtensionGrantState | null => {
    const plugin = plugins.get(pluginId);
    const record = records.get(pluginId);
    const extension = okExtension(plugin);
    const declared = extension?.grants ?? [];
    if (!extension || declared.length === 0) {
      // 插件已禁用（不在静态表里）或扩展不能运行：记录保留，只给界面显示与撤销。
      if (!record) return null;
      return {
        pluginId,
        name: plugin?.name ?? pluginId,
        declared: [],
        granted: [],
        recorded: normalizeGrants(record.grants),
        status: "inactive",
        ...(record.consentedVersion ? { consentedVersion: record.consentedVersion } : {}),
        consentedAt: record.consentedAt,
      };
    }
    const granted = Boolean(
      record &&
      grantsCoverAll(record.grants, declared) &&
      !needsSessionReconsent(declared, record.consentRevision),
    );
    return {
      pluginId,
      name: plugin!.name,
      declared: [...declared],
      granted: granted ? [...declared] : [],
      recorded: record ? normalizeGrants(record.grants) : [],
      status: granted ? "granted" : "needs-consent",
      ...(record?.consentedVersion ? { consentedVersion: record.consentedVersion } : {}),
      ...(record ? { consentedAt: record.consentedAt } : {}),
      ...(granted && declared.includes("notifications")
        ? { notificationsEnabled: !record?.notificationsOff }
        : {}),
    };
  };

  const effective = (pluginId: string): ExtensionGrant[] => stateOf(pluginId)?.granted ?? [];

  /** 重算整份授权状态；内容变了才递增 rev 并通知。 */
  const publish = () => {
    const ids = [...new Set([...plugins.keys(), ...records.keys()])].sort();
    const next = ids.flatMap((id) => {
      const state = stateOf(id);
      return state ? [state] : [];
    });
    const key = JSON.stringify(next);
    if (key === currentKey) return;
    currentKey = key;
    current = { rev: current.rev + 1, plugins: next };
    changes.fire(current);
  };

  /** 串行写：后一次写排在前一次之后，文件总是最新的记录。失败只告警，内存里的记录仍是唯一事实源。 */
  const persist = () => {
    const content = JSON.stringify(
      {
        version: GRANTS_FILE_VERSION,
        plugins: Object.fromEntries(records),
        ...(activations.size > 0 ? { activations: Object.fromEntries(activations) } : {}),
      },
      null,
      2,
    );
    const run = writeChain.then(() => atomicWritePrivateTextFile(deps.filePath, `${content}\n`));
    writeChain = run.catch((error: unknown) => {
      deps.logger.warn(undefined, "write extension grants failed", {
        code: (error as { code?: unknown } | null)?.code,
      });
    });
    return run;
  };

  /**
   * 用户授权或撤销的提交顺序：写文件 → afterCommit（审计行）→ 发布新状态。
   * Bug 根因（PLM-EXT-P3A 运行时日志）：原先先发布再写审计，Renderer 收到新 rev 立刻重读「最近操作」，
   * 读在审计行写入之前，撤销那一行看不到。改成审计写完再发布，rev 变化时读到的审计一定包含这次操作。
   * 写文件失败时恢复内存里的记录并抛错，不发布：授权状态与文件保持一致。
   */
  const commit = async (
    pluginId: string,
    previous: GrantRecord | undefined,
    tiers: ExtensionGrant[],
    afterCommit: ((tiers: ExtensionGrant[]) => Promise<void>) | undefined,
  ) => {
    try {
      await persist();
    } catch (error) {
      if (previous) records.set(pluginId, previous);
      else records.delete(pluginId);
      throw error;
    }
    await afterCommit?.(tiers);
    publish();
  };

  const ready = (async () => {
    let text: string;
    try {
      text = await readFile(deps.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "ENOENT") {
        deps.logger.warn(undefined, "read extension grants failed", {
          code: (error as { code?: unknown } | null)?.code,
        });
      }
      return;
    }
    let parsed: z.infer<typeof grantsFileSchema> | null = null;
    try {
      const result = grantsFileSchema.safeParse(JSON.parse(text));
      parsed = result.success ? result.data : null;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      // 读不懂就当没有授权（拒绝），留一份备份作证据；下一次写会覆盖原文件。
      await backupCorruptFile(deps.filePath).catch(() => undefined);
      deps.logger.warn(undefined, "extension grants file is invalid; treating it as empty");
      return;
    }
    if (disposed) return;
    for (const [pluginId, record] of Object.entries(parsed.plugins)) records.set(pluginId, record);
    for (const [pluginId, record] of Object.entries(parsed.activations ?? {}))
      activations.set(pluginId, record);
    // 不在这里发布：静态表重读会先等 ready，再由 reconcile 按清单算出状态后发布，避免先发一份全是 inactive 的状态。
    deps.logger.info(undefined, `extension grants loaded plugins=${records.size}`);
  })();

  return {
    ready,
    onDidChange: changes.event,
    snapshot: () => current,
    covers: (pluginId, grant) => grantsCover(effective(pluginId), grant),
    reconcile(table) {
      const before = new Map(
        [...plugins.keys(), ...records.keys()].map((id) => [id, effective(id)]),
      );
      plugins.clear();
      for (const plugin of table.plugins) plugins.set(plugin.pluginId, plugin);
      let changed = false;
      for (const [pluginId, record] of records) {
        const plugin = plugins.get(pluginId);
        const extension = okExtension(plugin);
        if (!extension) continue; // 禁用或扩展不能运行：记录不动。
        const declared = extension.grants;
        if (declared.length === 0) {
          // 新版本不再需要任何档位：自动收窄到空，即删除记录。
          records.delete(pluginId);
          changed = true;
          deps.logger.info(
            undefined,
            `extension grants dropped plugin=${pluginId} (no longer declared)`,
          );
          continue;
        }
        if (!grantsCoverAll(record.grants, declared)) {
          // 声明变多：回到待授权，记录保留，等用户在授权对话框确认。
          deps.logger.info(
            undefined,
            `extension grants need consent plugin=${pluginId} (declared grew)`,
          );
          continue;
        }
        if (needsSessionReconsent(declared, record.consentRevision)) {
          // 会话档位含义变宽以前的同意：回到待授权；下面的收窄与记下新版本照旧，不升 consentRevision。
          deps.logger.info(
            undefined,
            `extension grants need consent plugin=${pluginId} (consent revision ${record.consentRevision ?? 1} < ${EXTENSION_SESSION_CONSENT_REVISION})`,
          );
        }
        const narrowed = normalizeGrants(record.grants).join(",") !== declared.join(",");
        const version = plugin?.version;
        const versionChanged = version !== undefined && version !== record.consentedVersion;
        if (!narrowed && !versionChanged) continue;
        records.set(pluginId, {
          ...record,
          grants: [...declared],
          ...(version !== undefined ? { consentedVersion: version } : {}),
        });
        changed = true;
        deps.logger.info(
          undefined,
          `extension grants ${narrowed ? "narrowed" : "kept"} plugin=${pluginId} tiers=${declared.join(",")}${versionChanged ? " (new version recorded)" : ""}`,
        );
      }
      if (changed) void persist().catch(() => undefined);
      publish();
      // 生效档位变少的插件：在途调用要中止（结束时报 not-granted）。
      return [...before].flatMap(([pluginId, held]) => {
        const next = effective(pluginId);
        return held.some((grant) => !grantsCover(next, grant)) ? [pluginId] : [];
      });
    },
    async grant(pluginId, grants, afterCommit) {
      await ready;
      const plugin = plugins.get(pluginId);
      const declared = okExtension(plugin)?.grants ?? [];
      const requested = normalizeGrants(grants);
      // 对话框显示的档位必须等于清单当前声明的档位：清单在对话框打开期间变了，就要重新确认。
      if (declared.length === 0 || requested.join(",") !== declared.join(",")) {
        throw new Error("the grant request does not match the plugin manifest");
      }
      const previous = records.get(pluginId);
      records.set(pluginId, {
        grants: [...declared],
        ...(plugin?.version !== undefined ? { consentedVersion: plugin.version } : {}),
        consentedAt: now(),
        consentRevision: EXTENSION_SESSION_CONSENT_REVISION,
        // 重新授权（例如声明变多）保留用户在详情页关掉的通知开关。
        ...(previous?.notificationsOff ? { notificationsOff: true as const } : {}),
      });
      await commit(pluginId, previous, [...declared], afterCommit);
      return [...declared];
    },
    async revoke(pluginId, afterCommit) {
      await ready;
      const record = records.get(pluginId);
      if (!record) return [];
      records.delete(pluginId);
      const revoked = normalizeGrants(record.grants);
      await commit(pluginId, record, revoked, afterCommit);
      return revoked;
    },
    async setNotificationsEnabled(pluginId, enabled, afterCommit) {
      await ready;
      const record = records.get(pluginId);
      if (!record || !grantsCover(effective(pluginId), "notifications")) {
        throw new Error("notifications are not granted to this plugin");
      }
      if (!record.notificationsOff === enabled) return false;
      const next: GrantRecord = { ...record };
      if (enabled) delete next.notificationsOff;
      else next.notificationsOff = true;
      records.set(pluginId, next);
      try {
        await persist();
      } catch (error) {
        records.set(pluginId, record);
        throw error;
      }
      await afterCommit?.();
      publish();
      return true;
    },
    holders(exclude) {
      // 只看会话档位：只持有通知档位的插件不算「持有会话权限」（§17.7、§18.1 H8）。
      return current.plugins.flatMap((state) => {
        const granted = state.granted.filter(isSessionGrant);
        return state.pluginId !== exclude && granted.length > 0
          ? [{ pluginId: state.pluginId, name: state.name, granted }]
          : [];
      });
    },
    activationHold: (pluginId) => activations.get(pluginId)?.state,
    async holdActivation(pluginId, version) {
      await ready;
      const previous = activations.get(pluginId);
      activations.set(pluginId, {
        state: "pending",
        ...(version !== undefined ? { version } : {}),
        at: now(),
      });
      try {
        await persist();
      } catch (error) {
        if (previous) activations.set(pluginId, previous);
        else activations.delete(pluginId);
        throw error;
      }
    },
    async decideActivation(pluginId, allow) {
      await ready;
      const previous = activations.get(pluginId);
      if (previous?.state !== "pending") return false;
      if (allow) activations.delete(pluginId);
      else activations.set(pluginId, { ...previous, state: "declined", at: now() });
      try {
        await persist();
      } catch (error) {
        activations.set(pluginId, previous);
        throw error;
      }
      return true;
    },
    async clearActivation(pluginId) {
      await ready;
      const previous = activations.get(pluginId);
      if (!previous) return false;
      activations.delete(pluginId);
      try {
        await persist();
      } catch (error) {
        activations.set(pluginId, previous);
        throw error;
      }
      return true;
    },
    dispose() {
      disposed = true;
      changes.dispose();
    },
  };
}
