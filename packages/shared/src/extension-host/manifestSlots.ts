import { z } from "zod";
import {
  extensionIconNameSchema,
  extensionLocalIdSchema,
  firstManifestIssue,
  formatManifestPath,
  localizedTextSchema,
} from "#src/extension-host/manifest.js";
import {
  EXTENSION_SLOTS,
  isExtensionSlotId,
  type ExtensionSlotDef,
  type ExtensionSlotId,
  type SlotTargetKind,
} from "#src/extension-host/slots.js";

// 清单顶层 `slots`（docs/plugins/extension-host.md §16.2）：按插槽 id 分组的入口条目，
// 带扩展的插件与只有 MCP App 的插件写法相同。容错规则：
// - 未知插槽 id：忽略并记一条诊断（向前兼容），不影响插件的其他部分。
// - 条目内的未知字段、超出每插件上限、target 不被插槽接受：只有该条目不可用，带字段路径。
// target 引用的视图、命令是否可用要看 extension 键，由 staticTable.ts 检查。

/** MCP App 页面 id（`ui.surfaces[].id`）与 MCP 工具名：只限长度，格式由各自的来源定义。 */
const externalTargetIdSchema = z.string().min(1).max(128);

/** target 只能有一个键（§16.2）。 */
export const manifestSlotTargetSchema = z
  .strictObject({
    view: extensionLocalIdSchema.optional(),
    command: extensionLocalIdSchema.optional(),
    surface: externalTargetIdSchema.optional(),
    tool: externalTargetIdSchema.optional(),
  })
  .refine(
    (target) => Object.keys(target).length === 1,
    "target must have exactly one of view, command, surface, tool",
  );

export type ManifestSlotTarget = z.infer<typeof manifestSlotTargetSchema>;

export const manifestSlotItemSchema = z.strictObject({
  id: extensionLocalIdSchema,
  target: manifestSlotTargetSchema,
  title: localizedTextSchema.optional(),
  icon: extensionIconNameSchema.optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
});
/** 通用字段加插槽自己的字段（`itemFields`，如 file.viewer 的 fileExtensions）。 */
export type ManifestSlotItem = z.infer<typeof manifestSlotItemSchema> & {
  fileExtensions?: string[];
};

/**
 * 清单顶层 `slots` 的写法（类型包 §17.9）：插槽 id → 条目数组。解析时未知插槽 id 只记诊断，
 * 这里只列已知插槽，给插件作者写清单时用。
 */
export type ManifestSlots = { readonly [K in ExtensionSlotId]?: readonly ManifestSlotItem[] };

/** 清单问题：字段路径 + 原因。 */
export const manifestIssueSchema = z.strictObject({ path: z.string(), reason: z.string() });
export type ManifestIssue = z.infer<typeof manifestIssueSchema>;

export interface ParsedSlotItem {
  slot: ExtensionSlotId;
  /** 条目的字段路径，如 `slots["composer.status"][0]`。 */
  path: string;
  item: ManifestSlotItem;
  /** id 是清单里写的原值（view、command 是本地 id）。 */
  target: { kind: SlotTargetKind; id: string };
}

export interface ParsedSlots {
  items: ParsedSlotItem[];
  /** 不可用的条目，各带字段路径。 */
  problems: ManifestIssue[];
  /** 被忽略的部分（未知插槽 id），只作诊断。 */
  ignored: ManifestIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function targetOf(item: ManifestSlotItem): { kind: SlotTargetKind; id: string } {
  const [kind, id] = Object.entries(item.target)[0] as [SlotTargetKind, string];
  return { kind, id };
}

/** 解析清单顶层 `slots`。raw 是 plugin.json 的 `slots` 原值（没有时为 undefined）。 */
export function parseManifestSlots(raw: unknown): ParsedSlots {
  const parsed: ParsedSlots = { items: [], problems: [], ignored: [] };
  if (raw === undefined) return parsed;
  if (!isPlainObject(raw)) {
    parsed.problems.push({ path: "slots", reason: "slots must be an object keyed by slot id" });
    return parsed;
  }
  // 条目全局 id 是 `<pluginId>/<itemId>`，跨插槽也必须唯一。
  const ids = new Set<string>();
  for (const [slot, entries] of Object.entries(raw)) {
    const slotPath = formatManifestPath("slots", [slot]);
    if (!isExtensionSlotId(slot)) {
      parsed.ignored.push({ path: slotPath, reason: `unknown slot: ${slot}` });
      continue;
    }
    if (!Array.isArray(entries)) {
      parsed.problems.push({ path: slotPath, reason: "slot items must be an array" });
      continue;
    }
    const def: ExtensionSlotDef = EXTENSION_SLOTS[slot];
    entries.forEach((entry, index) => {
      const path = formatManifestPath("slots", [slot, index]);
      if (index >= def.maxItemsPerPlugin) {
        parsed.problems.push({
          path,
          reason: `${slot} accepts at most ${def.maxItemsPerPlugin} item(s) per plugin`,
        });
        return;
      }
      const schema = def.itemFields
        ? manifestSlotItemSchema.extend(def.itemFields)
        : manifestSlotItemSchema;
      const result = schema.safeParse(entry);
      if (!result.success) {
        parsed.problems.push(firstManifestIssue(result.error, path));
        return;
      }
      const item = result.data as ManifestSlotItem;
      if (ids.has(item.id)) {
        parsed.problems.push({ path: `${path}.id`, reason: `duplicate slot item id: ${item.id}` });
        return;
      }
      ids.add(item.id);
      const target = targetOf(item);
      if (!def.targets.includes(target.kind)) {
        parsed.problems.push({
          path: `${path}.target.${target.kind}`,
          reason: `${slot} does not accept a ${target.kind} target`,
        });
        return;
      }
      parsed.items.push({ slot, path, item, target });
    });
  }
  return parsed;
}
