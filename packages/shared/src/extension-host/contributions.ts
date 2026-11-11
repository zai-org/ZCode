import { z } from "zod";
import { slotValueSchema } from "#src/extension-host/slots.js";

// 贡献表（docs/plugins/extension-host.md §3.4、§6、§16.1）。唯一 owner 是扩展进程；
// Window Host 与 Renderer 只持最近一份快照，用增量更新它，不维护第二份。
// P2a 起贡献表只有运行状态与插槽动态值；命令、视图、插槽条目这些静态声明在 Window Host 的静态表
// （staticTable.ts），Renderer 合并两者。

/** 单个扩展的运行状态（§12.2）。清单状态（invalid、incompatible）在静态表里。 */
export const EXTENSION_RUN_STATES = ["resolved", "activating", "active", "failed"] as const;
export const extensionRunStateSchema = z.enum(EXTENSION_RUN_STATES);
export type ExtensionRunState = z.infer<typeof extensionRunStateSchema>;

export const extensionRunStatusSchema = z.strictObject({
  pluginId: z.string().min(1),
  state: extensionRunStateSchema,
  /** failed 的原因；启动页悬停显示。 */
  reason: z.string().optional(),
});
export type ExtensionRunStatus = z.infer<typeof extensionRunStatusSchema>;

const genSchema = z.number().int().nonnegative();
const revSchema = z.number().int().nonnegative();

/** 整份快照：Window Host 交给扩展进程的每个扩展的运行状态，以及当前全部动态值。 */
export const contributionSnapshotSchema = z.strictObject({
  kind: z.literal("snapshot"),
  gen: genSchema,
  rev: revSchema,
  extensions: z.array(extensionRunStatusSchema),
  /** 条目全局 id → 作用域键 → 动态值。 */
  values: z.record(z.string(), z.record(z.string(), slotValueSchema)),
});
export type ContributionSnapshot = z.infer<typeof contributionSnapshotSchema>;

/** 动态值增量：按「条目 + 作用域」推送，与快照共用 rev。value 为 null 表示删除。 */
export const contributionDeltaSchema = z.strictObject({
  kind: z.literal("delta"),
  gen: genSchema,
  rev: revSchema,
  itemId: z.string().min(1),
  scopeKey: z.string().min(1),
  value: slotValueSchema.nullable(),
});
export type ContributionDelta = z.infer<typeof contributionDeltaSchema>;

export const contributionMessageSchema = z.discriminatedUnion("kind", [
  contributionSnapshotSchema,
  contributionDeltaSchema,
]);
export type ContributionMessage = z.infer<typeof contributionMessageSchema>;

/**
 * 接收方的唯一合入规则（Window Host 与 Renderer 共用）：
 * - 快照：gen 更新的整份替换；同 gen 只接受 rev 更大的。
 * - 增量：必须与已有快照同 gen 且 rev 更大，否则丢弃（没有底稿的增量也丢弃）。
 * 返回 null 表示丢弃，调用方保持原状态。
 */
export function applyContributionMessage(
  current: ContributionSnapshot | null,
  message: ContributionMessage,
): ContributionSnapshot | null {
  if (message.kind === "snapshot") {
    if (!current || message.gen > current.gen) return message;
    if (message.gen === current.gen && message.rev > current.rev) return message;
    return null;
  }
  if (!current || message.gen !== current.gen || message.rev <= current.rev) return null;
  const itemValues = { ...current.values[message.itemId] };
  if (message.value) itemValues[message.scopeKey] = message.value;
  else delete itemValues[message.scopeKey];
  const values = { ...current.values };
  if (Object.keys(itemValues).length > 0) values[message.itemId] = itemValues;
  else delete values[message.itemId];
  return { ...current, rev: message.rev, values };
}
