import { z } from "zod";
import { zcodePluginMentionItemsSchema } from "#src/zcode-protocol/plugin-host-queries/contract.js";

// 插槽目录与动态值（docs/plugins/extension-host.md §6、§16.2、§16.3）。
// EXTENSION_SLOTS 是插槽 id 的唯一定义：清单校验、渲染、文档都读它，不在别处写死插槽 id。

/**
 * 条目点击后打开什么（清单 `slots[...][].target` 只能有其中一个键）：
 * view 扩展视图、command 扩展命令、surface 插件的 MCP App 页面（`ui.surfaces[].id`）、
 * tool 插件 MCP server 的工具。前两种的目标在扩展进程里。
 */
export const SLOT_TARGET_KINDS = ["view", "command", "surface", "tool"] as const;
export type SlotTargetKind = (typeof SLOT_TARGET_KINDS)[number];

/** 目标在扩展进程里的 target：扩展进程停止时这类条目不可用（§16.1）。 */
export function isExtensionTargetKind(kind: SlotTargetKind): kind is "view" | "command" {
  return kind === "view" || kind === "command";
}

/** file.viewer 条目的扩展名：`.` 开头，后接字母、数字、`.`、`_`、`-`（如 `.csv`、`.tar.gz`）；大小写不敏感。 */
export const fileExtensionSchema = z
  .string()
  .regex(/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, "a file extension starts with a dot, e.g. .csv");
export const fileExtensionsSchema = z.array(fileExtensionSchema).min(1).max(20);

export interface ExtensionSlotDef {
  /** 该插槽接受的 target 种类；其余种类的条目判为不可用。 */
  targets: readonly SlotTargetKind[];
  /** 动态值的典型作用域，只用于文档与默认渲染，不限制 slots.update 的作用域。 */
  scope: "app" | "workspace" | "session";
  maxItemsPerPlugin: number;
  /**
   * 该插槽条目在通用字段之外的字段（§16.5 的 fileExtensions）。条目仍按严格对象校验：
   * 别的插槽的条目写了这些字段，按未知字段判不可用。
   */
  itemFields?: z.ZodRawShape;
  /**
   * command target 的返回值 schema（§16.3「命令可以返回 JSON 值」）：Window Host 按它校验命令返回值。
   * 没有时命令的返回值被忽略（例如 composer.status 的点击）。
   */
  commandResult?: z.ZodType;
}

export const EXTENSION_SLOTS = {
  // 输入框工具栏，上下文用量圆环左边；只在设置了 text 时显示。点击执行扩展命令。
  "composer.status": { targets: ["command"], scope: "session", maxItemsPerPlugin: 1 },
  // 右侧面板「新标签页」启动页的「扩展」分区。点击打开扩展视图。
  "sidePane.launcher": { targets: ["view"], scope: "workspace", maxItemsPerPlugin: 5 },
  // 左侧导航「插件市场」之后，一个插件一项（§16.4）。点击在右侧面板打开扩展视图或 MCP App 页面。
  "nav.primary": { targets: ["view", "surface"], scope: "app", maxItemsPerPlugin: 1 },
  // 打开文件时按扩展名选查看器（§16.5）：扩展视图标签，或 MCP App 页面加 open_document。
  "file.viewer": {
    targets: ["view", "surface"],
    scope: "workspace",
    maxItemsPerPlugin: 5,
    itemFields: { fileExtensions: fileExtensionsSchema },
  },
  // 输入框 `@` 面板，每个条目一个分组（§16.6）。command 是扩展命令（参数 { query }，返回候选项数组），
  // tool 是插件 MCP server 的工具（CLI plugins/mentionItems）。候选项 schema 与 CLI 的工具结果同一份。
  "composer.mention": {
    targets: ["command", "tool"],
    scope: "session",
    maxItemsPerPlugin: 3,
    commandResult: zcodePluginMentionItemsSchema,
  },
} as const satisfies Record<string, ExtensionSlotDef>;

export type ExtensionSlotId = keyof typeof EXTENSION_SLOTS;
export const EXTENSION_SLOT_IDS = Object.keys(EXTENSION_SLOTS) as ExtensionSlotId[];
export const extensionSlotIdSchema = z.enum(
  EXTENSION_SLOT_IDS as [ExtensionSlotId, ...ExtensionSlotId[]],
);

export function isExtensionSlotId(value: string): value is ExtensionSlotId {
  return Object.hasOwn(EXTENSION_SLOTS, value);
}

/** 动态值长度上限：插槽是窄位置，长文案应放进扩展视图。 */
export const SLOT_TEXT_MAX_LENGTH = 40;
export const SLOT_TOOLTIP_MAX_LENGTH = 200;

/**
 * 未读标记（§18.1 H11）：正整数是未读数，"dot" 只表示有新内容。目前只有 nav.primary 渲染它。
 * 上限只防误用，显示时超过 99 为 99+。
 */
export const SLOT_BADGE_MAX_COUNT = 9999;
export const slotBadgeSchema = z.union([
  z.number().int().min(1).max(SLOT_BADGE_MAX_COUNT),
  z.literal("dot"),
]);
export type SlotBadge = z.infer<typeof slotBadgeSchema>;

export const slotValueSchema = z.strictObject({
  text: z.string().max(SLOT_TEXT_MAX_LENGTH).optional(),
  tooltip: z.string().max(SLOT_TOOLTIP_MAX_LENGTH).optional(),
  visible: z.boolean().optional(),
  badge: slotBadgeSchema.optional(),
});
export type SlotValue = z.infer<typeof slotValueSchema>;

/** slots.update 的补丁：字段为 null 表示清除该字段。 */
export const slotItemPatchSchema = z.strictObject({
  text: z.string().max(SLOT_TEXT_MAX_LENGTH).nullable().optional(),
  tooltip: z.string().max(SLOT_TOOLTIP_MAX_LENGTH).nullable().optional(),
  visible: z.boolean().nullable().optional(),
  badge: slotBadgeSchema.nullable().optional(),
});
export type SlotItemPatch = z.infer<typeof slotItemPatchSchema>;

const SLOT_VALUE_FIELDS = ["text", "tooltip", "visible", "badge"] as const;

/** 把补丁合入某个作用域的当前值；结果为空时返回 null（删除该作用域的值）。 */
export function applySlotPatch(
  current: SlotValue | undefined,
  patch: SlotItemPatch,
): SlotValue | null {
  const next: Record<string, unknown> = { ...current };
  for (const field of SLOT_VALUE_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null || value === undefined) delete next[field];
    else next[field] = value;
  }
  return Object.keys(next).length > 0 ? (next as SlotValue) : null;
}

// —— 作用域 ——

export const workspaceRefSchema = z.strictObject({
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().min(1).optional(),
});
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;

const sessionIdSchema = z.string().min(1).max(200);

/** 扩展传入的作用域。传 sessionId 即可，宿主补全工作区。省略时为 "app"。 */
export const scopeInputSchema = z.union([
  z.literal("app"),
  z.strictObject({ workspace: workspaceRefSchema }),
  z.strictObject({ sessionId: sessionIdSchema }),
]);
export type ScopeInput = z.infer<typeof scopeInputSchema>;

/** 宿主传给扩展的作用域（命令调用、视图实例、事件）一律是补全后的形式。 */
export const resolvedScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("app") }),
  z.strictObject({ kind: z.literal("workspace"), workspace: workspaceRefSchema }),
  z.strictObject({
    kind: z.literal("session"),
    workspace: workspaceRefSchema,
    sessionId: sessionIdSchema,
  }),
]);
export type ResolvedScope = z.infer<typeof resolvedScopeSchema>;

/** 动态值的存放键：`app`、`ws:<workspaceKey>`、`session:<sessionId>`。 */
export type SlotScopeKey = "app" | `ws:${string}` | `session:${string}`;

export function workspaceScopeKey(workspace: WorkspaceRef): `ws:${string}` {
  // 与 resolveWorkspaceKey 同一规则：identity 优先，缺省回落 path。
  return `ws:${workspace.workspaceIdentity?.trim() || workspace.workspacePath}`;
}

export function slotScopeKey(scope: ScopeInput | ResolvedScope | undefined): SlotScopeKey {
  if (scope === undefined || scope === "app") return "app";
  if ("kind" in scope) {
    if (scope.kind === "app") return "app";
    if (scope.kind === "workspace") return workspaceScopeKey(scope.workspace);
    return `session:${scope.sessionId}`;
  }
  if ("sessionId" in scope) return `session:${scope.sessionId}`;
  return workspaceScopeKey(scope.workspace);
}

/**
 * 渲染时逐字段合并：优先级会话 > 工作区 > App。
 * keys 从低到高给出；缺失的作用域直接跳过。
 */
export function mergeSlotValues(
  values: Readonly<Record<string, SlotValue>> | undefined,
  keys: readonly SlotScopeKey[],
): SlotValue {
  const merged: SlotValue = {};
  if (!values) return merged;
  for (const key of keys) {
    const value = values[key];
    if (!value) continue;
    for (const field of SLOT_VALUE_FIELDS) {
      if (value[field] !== undefined) (merged as Record<string, unknown>)[field] = value[field];
    }
  }
  return merged;
}
