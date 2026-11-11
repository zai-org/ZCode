import { z } from "zod";

// 权限档位与协议版本（docs/plugins/extension-host.md §7.3、§17.3、§17.6、§17.7）。
// 档位是插件在清单里声明、用户授予的权限；能力表的每一行写它需要的档位（none 表示不需要授权）。
// 按插件的授权用于归因与防误用，不是安全边界：所有扩展在同一个进程里（§7.3）。

/**
 * 需要用户授权的档位。会话档位是一条链：fullAccess 包含 write，write 包含 read；
 * notifications（§18.1 H8）与会话档位互不覆盖。
 * sessions.fullAccess（§17.12，P3e）：插件申请把它项目里的会话切到完全访问（yolo），授权对话框单独写一行。
 */
export const EXTENSION_GRANTS = [
  "sessions.read",
  "sessions.write",
  "sessions.fullAccess",
  "notifications",
] as const;
export const extensionGrantSchema = z.enum(EXTENSION_GRANTS);
export type ExtensionGrant = z.infer<typeof extensionGrantSchema>;

/** 会话档位链，低到高（§17.12）：高档包含低档。 */
const SESSION_GRANT_CHAIN: readonly ExtensionGrant[] = [
  "sessions.read",
  "sessions.write",
  "sessions.fullAccess",
];

/** 会话档位：启用确认只看它们（§17.7）。 */
export function isSessionGrant(grant: ExtensionGrant): boolean {
  return SESSION_GRANT_CHAIN.includes(grant);
}

/**
 * 会话档位含义的版本（§17.12「已有授权要重新确认」）。grants.json 记录的 consentRevision 低于它时，
 * 声明的档位覆盖 sessions.write 的插件回到待授权。1 = P3e 以前（没有这个字段的旧记录）；2 = sessions.write
 * 还能回答审批与提问、切换权限模式（用户决策 2026-11-06：要重新确认）。以后会话档位的含义再变宽时加一。
 */
export const EXTENSION_SESSION_CONSENT_REVISION = 2;

/**
 * 记录是不是在会话档位变宽以前同意的，要重新确认。只看覆盖 sessions.write 的声明：
 * sessions.read 与 notifications 的含义没变，不打扰用户。consentRevision 缺省按 1。
 */
export function needsSessionReconsent(
  declared: readonly ExtensionGrant[],
  consentRevision: number | undefined,
): boolean {
  return (
    grantsCover(declared, "sessions.write") &&
    (consentRevision ?? 1) < EXTENSION_SESSION_CONSENT_REVISION
  );
}

/** 能力表一行需要的档位。 */
export type CapabilityGrant = "none" | ExtensionGrant;

/** held 是否覆盖 needed：相同，或会话档位链上 held 不低于 needed（fullAccess ⊇ write ⊇ read）。 */
export function grantCovers(held: ExtensionGrant, needed: ExtensionGrant): boolean {
  if (held === needed) return true;
  const heldRank = SESSION_GRANT_CHAIN.indexOf(held);
  const neededRank = SESSION_GRANT_CHAIN.indexOf(needed);
  return heldRank >= 0 && neededRank >= 0 && heldRank > neededRank;
}

/** 一组档位是否覆盖 needed；none 恒为覆盖。 */
export function grantsCover(held: readonly ExtensionGrant[], needed: CapabilityGrant): boolean {
  return needed === "none" || held.some((grant) => grantCovers(grant, needed));
}

/** 每个档位是否都被 held 覆盖（用于判断插件更新后声明的权限是否变多）。 */
export function grantsCoverAll(
  held: readonly ExtensionGrant[],
  needed: readonly ExtensionGrant[],
): boolean {
  return needed.every((grant) => grantsCover(held, grant));
}

/** 去重并去掉被覆盖的档位，按 EXTENSION_GRANTS 的顺序返回最小集合：["sessions.read","sessions.write"] → ["sessions.write"]。 */
export function normalizeGrants(grants: readonly ExtensionGrant[]): ExtensionGrant[] {
  const unique = [...new Set(grants)];
  return EXTENSION_GRANTS.filter(
    (grant) =>
      unique.includes(grant) &&
      !unique.some((other) => other !== grant && grantCovers(other, grant)),
  );
}

/**
 * 插件可依赖的稳定协议版本（§17.6）。sessions 是会话投影（列表行与 readSession 的正文），rows 是
 * 完整行（跟 v4 协议走）。只加字段不升版；删字段或改含义才升版。清单声明的版本对不上时，
 * 对应能力报 incompatible；没有声明时按当前版本。
 */
export const EXTENSION_PROTOCOL_VERSIONS = { sessions: 1, rows: 4 } as const;
export type ExtensionProtocolName = keyof typeof EXTENSION_PROTOCOL_VERSIONS;
export const SESSIONS_PROJECTION_VERSION = EXTENSION_PROTOCOL_VERSIONS.sessions;

/** 清单 `extension.protocols`：插件按哪个版本读这些投影。 */
export const extensionProtocolsSchema = z.strictObject({
  sessions: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
export type ExtensionProtocols = z.infer<typeof extensionProtocolsSchema>;

/** 声明的协议版本是否与宿主一致；没有声明视为一致。 */
export function isProtocolCompatible(
  declared: ExtensionProtocols,
  name: ExtensionProtocolName,
): boolean {
  const version = declared[name];
  return version === undefined || version === EXTENSION_PROTOCOL_VERSIONS[name];
}

// —— 授权状态、审计条目与授权门面的入参（§17.7、§17.8）——

/**
 * 一个插件的授权状态（owner：Window Host 的 extensions-service，记录在 grants.json）。
 * - granted：清单声明的档位都已授予，调用可用 `granted` 里的档位。
 * - needs-consent：清单声明了档位，但还没有授予，或插件更新后声明变多；会话能力报 not-granted。
 * - inactive：有授权记录，但插件不在当前静态表里（已禁用）。禁用不删记录。
 */
export const extensionGrantStatusSchema = z.enum(["granted", "needs-consent", "inactive"]);
export type ExtensionGrantStatus = z.infer<typeof extensionGrantStatusSchema>;

export const extensionGrantStateSchema = z.strictObject({
  pluginId: z.string().min(1),
  /** 插件显示名（静态表或记录里的最近一次）。 */
  name: z.string().min(1),
  /** 清单声明的档位（去掉被覆盖的）；inactive 时为空。 */
  declared: z.array(extensionGrantSchema),
  /** 当前生效的档位；needs-consent 与 inactive 时为空。 */
  granted: z.array(extensionGrantSchema),
  /** 记录里已授予的档位（inactive 时给授权界面显示与撤销用）。 */
  recorded: z.array(extensionGrantSchema),
  status: extensionGrantStatusSchema,
  consentedVersion: z.string().optional(),
  /** 用户确认授权的时间（毫秒）。 */
  consentedAt: z.number().int().nonnegative().optional(),
  /** 详情页「系统通知」开关（§18.1 H8，默认开）；只在通知档位生效时出现。 */
  notificationsEnabled: z.boolean().optional(),
});
export type ExtensionGrantState = z.infer<typeof extensionGrantStateSchema>;

/** 整份授权状态：rev 在一个 Window Host 内单调递增，接收方整份替换。 */
export const extensionGrantsSnapshotSchema = z.strictObject({
  rev: z.number().int().nonnegative(),
  plugins: z.array(extensionGrantStateSchema),
});
export type ExtensionGrantsSnapshot = z.infer<typeof extensionGrantsSnapshotSchema>;

export const grantExtensionInputSchema = z.strictObject({
  pluginId: z.string().min(1),
  /** 授权对话框显示的档位。必须等于清单当前声明的档位，否则请求已过期（清单在对话框打开期间变了）。 */
  grants: z.array(extensionGrantSchema).min(1),
});
export type GrantExtensionInput = z.infer<typeof grantExtensionInputSchema>;

export const revokeExtensionInputSchema = z.strictObject({ pluginId: z.string().min(1) });
export type RevokeExtensionInput = z.infer<typeof revokeExtensionInputSchema>;

/**
 * 从插件商店安装后、激活前的确认（§17.7，P3b）：已有别的扩展持有会话权限时，新装的带代码扩展先不激活。
 * pending：等用户确认；declined：用户选择不激活。owner 是 grants.json。
 */
export const extensionActivationHoldSchema = z.enum(["pending", "declined"]);
export type ExtensionActivationHold = z.infer<typeof extensionActivationHoldSchema>;

/** 用户对「需要确认」的决定：allow 为 true 时激活，false 时记为 declined。 */
export const decideExtensionActivationInputSchema = z.strictObject({
  pluginId: z.string().min(1),
  allow: z.boolean(),
});
export type DecideExtensionActivationInput = z.infer<typeof decideExtensionActivationInputSchema>;

/** 详情页「系统通知」开关（§18.1 H8）。 */
export const setExtensionNotificationsInputSchema = z.strictObject({
  pluginId: z.string().min(1),
  enabled: z.boolean(),
});
export type SetExtensionNotificationsInput = z.infer<typeof setExtensionNotificationsInputSchema>;

export const describeExtensionEnableInputSchema = z.strictObject({ pluginId: z.string().min(1) });
export type DescribeExtensionEnableInput = z.infer<typeof describeExtensionEnableInputSchema>;

/**
 * 启用一个插件之前的确认依据（§17.7「启用确认」）：已有别的扩展持有会话权限，而这个插件带扩展代码
 * （合法、兼容、有 main）时 confirm 为 true，holders 列出持有权限的插件。
 */
export const extensionEnableImpactSchema = z.strictObject({
  confirm: z.boolean(),
  holders: z.array(
    z.strictObject({
      pluginId: z.string().min(1),
      name: z.string().min(1),
      granted: z.array(extensionGrantSchema),
    }),
  ),
});
export type ExtensionEnableImpact = z.infer<typeof extensionEnableImpactSchema>;

/**
 * 审计日志的一行（`~/.zcode/v2/extensions/audit/<日期>.jsonl`，§17.8）。写操作每次一行；授权与撤销也各记
 * 一行（capability 为 `grants.grant` / `grants.revoke`）。不写提示词、标题、正文、路径、设置值、错误原文。
 * pluginId 在能力调用里是扩展进程自报的，只用于归因（§7.3）。
 */
export const extensionAuditEntrySchema = z.strictObject({
  v: z.literal(1),
  /** 毫秒时间戳。 */
  ts: z.number().int().nonnegative(),
  /** 扩展进程代际；没有已连接的扩展进程时为 null（例如在授权界面操作时扩展进程已停止）。 */
  gen: z.number().int().nonnegative().nullable(),
  pluginId: z.string().min(1),
  capability: z.string().min(1),
  grant: z.union([extensionGrantSchema, z.literal("none")]).optional(),
  requestId: z.string().optional(),
  commandId: z.string().optional(),
  target: z
    .strictObject({
      sourceServerId: z.string().optional(),
      sessionId: z.string().optional(),
      projectId: z.string().optional(),
    })
    .optional(),
  outcome: z.enum(["ok", "error"]),
  errorCode: z.string().optional(),
  promptChars: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** 回答的交互种类（§17.12）。 */
  interactionKind: z.enum(["permission", "userInput"]).optional(),
  /** 回答的选择：permission 记选项 kind（或 fullAccess），userInput 记 answer / decline / cancel。不记内容。 */
  choice: z.string().max(40).optional(),
  /** 切换或新建时的权限模式。 */
  mode: z.string().max(40).optional(),
});
export type ExtensionAuditEntry = z.infer<typeof extensionAuditEntrySchema>;

/** 审计文件保留天数。 */
export const EXTENSION_AUDIT_RETENTION_DAYS = 30;

export const getExtensionRecentActionsInputSchema = z.strictObject({
  pluginId: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});
export type GetExtensionRecentActionsInput = z.infer<typeof getExtensionRecentActionsInputSchema>;
