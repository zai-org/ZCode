import { z } from "zod";
import {
  EXTENSION_API_VERSION,
  extensionGlobalId,
  extensionIconNameSchema,
  extensionLocalIdSchema,
  extensionViewScopeSchema,
  localizedTextSchema,
  resolveActivationEvents,
  validateExtensionManifest,
  type ExtensionManifest,
} from "#src/extension-host/manifest.js";
import {
  manifestIssueSchema,
  parseManifestSlots,
  type ManifestIssue,
  type ParsedSlotItem,
} from "#src/extension-host/manifestSlots.js";
import { SLOT_TARGET_KINDS, extensionSlotIdSchema } from "#src/extension-host/slots.js";
import {
  extensionActivationHoldSchema,
  extensionGrantSchema,
  extensionProtocolsSchema,
  normalizeGrants,
} from "#src/extension-host/grants.js";

// 静态表（docs/plugins/extension-host.md §16.1）：清单里的静态声明，唯一 owner 是 Window Host 的
// extensions-service。Window Host 读每个插件的 plugin.json，用这里的纯函数校验并生成：
// - 静态表：整份推给 Renderer（带 rev）。所有插件都在表里，也包括没有 extension 键的插件。
// - 扩展声明：只含合法、兼容的 extension，推给扩展进程。扩展进程不再读 plugin.json。
// 运行状态（activating / active / failed）与插槽动态值仍归扩展进程（contributions.ts）。

/** plugin.json 的位置，与 CLI 发现插件时同一优先级（adapters/plugins/index.ts 的 manifest 目录约定）。 */
export const PLUGIN_MANIFEST_CANDIDATES = [
  [".zcode-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  [".codex-plugin", "plugin.json"],
] as const;

const pluginIdSchema = z.string().min(1);

/** 扩展命令（全局 id `<pluginId>/<commandId>`）。 */
export const staticCommandSchema = z.strictObject({
  id: z.string().min(1),
  pluginId: pluginIdSchema,
  title: localizedTextSchema,
});
export type StaticCommand = z.infer<typeof staticCommandSchema>;

/** 扩展视图（全局 id `<pluginId>/<viewId>`）。 */
export const staticViewSchema = z.strictObject({
  id: z.string().min(1),
  pluginId: pluginIdSchema,
  title: localizedTextSchema,
  icon: extensionIconNameSchema.optional(),
  /** "app"：实例不随侧栏目标的会话或工作区重建（§18.1 H5）；没有时跟随侧栏目标。 */
  scope: extensionViewScopeSchema.optional(),
});
export type StaticView = z.infer<typeof staticViewSchema>;

/** extension 键的清单状态。invalid 带字段路径；incompatible 带要求的 API 版本。 */
export const staticExtensionSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ok"),
    main: z.string().optional(),
    /** 显式声明 ∪ 由命令、视图自动推导的激活事件。 */
    activationEvents: z.array(z.string()),
    commands: z.array(staticCommandSchema),
    views: z.array(staticViewSchema),
    /** 清单声明的档位，去掉被覆盖的（write 覆盖 read，§17.7）。能力网关与授权界面都读它。 */
    grants: z.array(extensionGrantSchema),
    /** 清单声明的协议版本；没有声明时为空对象（§17.6）。 */
    protocols: extensionProtocolsSchema,
  }),
  z.strictObject({ state: z.literal("invalid"), path: z.string(), reason: z.string() }),
  z.strictObject({ state: z.literal("incompatible"), required: z.string(), reason: z.string() }),
]);
export type StaticExtension = z.infer<typeof staticExtensionSchema>;

/**
 * 条目的打开目标。id：view、command 是全局 id（`<pluginId>/<localId>`）；
 * surface 是 `ui.surfaces[].id`；tool 是插件 MCP server 的工具名。
 */
export const staticSlotTargetSchema = z.strictObject({
  kind: z.enum(SLOT_TARGET_KINDS),
  id: z.string().min(1),
});
export type StaticSlotTarget = z.infer<typeof staticSlotTargetSchema>;

/** 可用的插槽条目（不可用的条目只出现在插件的 problems 里）。 */
export const staticSlotItemSchema = z.strictObject({
  /** 条目全局 id：`<pluginId>/<itemId>`。 */
  id: z.string().min(1),
  pluginId: pluginIdSchema,
  slot: extensionSlotIdSchema,
  order: z.number().int(),
  icon: extensionIconNameSchema.optional(),
  title: localizedTextSchema.optional(),
  target: staticSlotTargetSchema,
  /** 只有 file.viewer 的条目有：小写、去重后的扩展名（§16.5）。 */
  fileExtensions: z.array(z.string().min(2)).optional(),
});
export type StaticSlotItem = z.infer<typeof staticSlotItemSchema>;

export const staticPluginSchema = z.strictObject({
  pluginId: pluginIdSchema,
  name: z.string().min(1),
  version: z.string().optional(),
  /** 清单的 extension 键；没有这个键时为 null。 */
  extension: staticExtensionSchema.nullable(),
  /**
   * 从插件商店安装后等待确认（§17.7，P3b）：pending 等用户确认，declined 用户选择不激活。
   * 两种都不进扩展声明，Renderer 不显示它的 view / command 条目。缺席即正常激活。
   */
  activation: extensionActivationHoldSchema.optional(),
  slotItems: z.array(staticSlotItemSchema),
  /** 不可用的条目与读不出的清单，各带字段路径。只影响对应条目，插件的其他部分照常。 */
  problems: z.array(manifestIssueSchema),
  /** 被忽略的部分（未知插槽 id，向前兼容），只作诊断。 */
  ignored: z.array(manifestIssueSchema),
});
export type StaticPlugin = z.infer<typeof staticPluginSchema>;

/** 整份静态表：rev 在一个 Window Host 内单调递增，接收方整份替换。 */
export const extensionStaticTableSchema = z.strictObject({
  rev: z.number().int().nonnegative(),
  plugins: z.array(staticPluginSchema),
});
export type ExtensionStaticTable = z.infer<typeof extensionStaticTableSchema>;

/** Window Host 交给扩展进程的单个扩展：只有合法、兼容的 extension 才有（§16.1）。 */
export const extensionDeclarationSchema = z.strictObject({
  pluginId: pluginIdSchema,
  version: z.string().optional(),
  rootPath: z.string().min(1),
  /** 插件的持久数据目录（§18.1 H6），来自 CLI 的 plugins/list；旧 CLI 不报告时缺省，扩展激活失败。 */
  dataPath: z.string().min(1).optional(),
  main: z.string().optional(),
  activationEvents: z.array(z.string()),
  /** 声明的命令、视图本地 id：ctx.commands.register / ctx.views.register 只认这些。 */
  commands: z.array(extensionLocalIdSchema),
  views: z.array(extensionLocalIdSchema),
  /** 本插件可用的插槽条目本地 id：ctx.slots.update 只认这些。 */
  slotItems: z.array(extensionLocalIdSchema),
});
export type ExtensionDeclaration = z.infer<typeof extensionDeclarationSchema>;

export const extensionDeclarationsSchema = z.strictObject({
  plugins: z.array(extensionDeclarationSchema),
});
export type ExtensionDeclarations = z.infer<typeof extensionDeclarationsSchema>;

/** Window Host 读 plugin.json 的结果。missing：几个候选位置都没有清单（插件可以没有 plugin.json）。 */
export type PluginManifestRead =
  | { status: "missing" }
  | { status: "unreadable"; path: string; reason: string }
  | { status: "ok"; manifest: unknown };

export interface PluginManifestSource {
  pluginId: string;
  name: string;
  version?: string;
  rootPath: string;
  dataPath?: string;
}

export interface ResolvedPluginManifest {
  entry: StaticPlugin;
  /** 合法、兼容的扩展声明；没有 extension 键、清单非法或不兼容时为 null。 */
  declaration: ExtensionDeclaration | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** view、command 条目引用的视图或命令必须在合法、兼容的 extension 里声明；否则只有该条目不可用。 */
function checkExtensionTarget(
  parsed: ParsedSlotItem,
  extension: StaticExtension | null,
  manifest: ExtensionManifest | null,
): ManifestIssue | null {
  const { kind, id } = parsed.target;
  if (kind !== "view" && kind !== "command") return null;
  const path = `${parsed.path}.target.${kind}`;
  if (!extension) return { path, reason: `the plugin has no extension for this ${kind}` };
  if (extension.state !== "ok") return { path, reason: `the extension is ${extension.state}` };
  const declared =
    kind === "view"
      ? (manifest?.contributes?.views ?? []).some((view) => view.id === id)
      : (manifest?.contributes?.commands ?? []).some((command) => command.id === id);
  return declared ? null : { path, reason: `${kind} is not declared: ${id}` };
}

/** 校验一个插件的清单，生成它在静态表里的一项与（可选的）扩展声明。纯函数，不做 IO。 */
export function resolvePluginManifest(
  source: PluginManifestSource,
  read: PluginManifestRead,
  hostVersion: string = EXTENSION_API_VERSION,
): ResolvedPluginManifest {
  const { pluginId } = source;
  const entry: StaticPlugin = {
    pluginId,
    name: source.name,
    ...(source.version ? { version: source.version } : {}),
    extension: null,
    slotItems: [],
    problems: [],
    ignored: [],
  };
  if (read.status === "missing") return { entry, declaration: null };
  if (read.status === "unreadable") {
    entry.problems.push({ path: read.path, reason: read.reason });
    return { entry, declaration: null };
  }
  const raw = read.manifest;
  if (!isPlainObject(raw)) {
    entry.problems.push({ path: "plugin.json", reason: "plugin.json must be a JSON object" });
    return { entry, declaration: null };
  }

  let manifest: ExtensionManifest | null = null;
  if ("extension" in raw) {
    const validation = validateExtensionManifest(raw.extension, hostVersion);
    if (validation.status === "ok") {
      manifest = validation.manifest;
      entry.extension = {
        state: "ok",
        ...(manifest.main ? { main: manifest.main } : {}),
        activationEvents: [...resolveActivationEvents(manifest)],
        commands: (manifest.contributes?.commands ?? []).map((command) => ({
          id: extensionGlobalId(pluginId, command.id),
          pluginId,
          title: command.title,
        })),
        views: (manifest.contributes?.views ?? []).map((view) => ({
          id: extensionGlobalId(pluginId, view.id),
          pluginId,
          title: view.title,
          ...(view.icon ? { icon: view.icon } : {}),
          ...(view.scope ? { scope: view.scope } : {}),
        })),
        grants: normalizeGrants(manifest.grants ?? []),
        protocols: manifest.protocols ?? {},
      };
    } else if (validation.status === "invalid") {
      entry.extension = { state: "invalid", path: validation.path, reason: validation.reason };
    } else {
      entry.extension = {
        state: "incompatible",
        required: validation.required,
        reason: validation.reason,
      };
    }
  }

  const slots = parseManifestSlots(raw.slots);
  entry.problems.push(...slots.problems);
  entry.ignored.push(...slots.ignored);
  const usableItemIds: string[] = [];
  for (const parsed of slots.items) {
    const problem = checkExtensionTarget(parsed, entry.extension, manifest);
    if (problem) {
      entry.problems.push(problem);
      continue;
    }
    const { item, target } = parsed;
    usableItemIds.push(item.id);
    entry.slotItems.push({
      id: extensionGlobalId(pluginId, item.id),
      pluginId,
      slot: parsed.slot,
      order: item.order ?? 0,
      ...(item.icon ? { icon: item.icon } : {}),
      ...(item.title ? { title: item.title } : {}),
      // 扩展名大小写不敏感：静态表里统一小写，Renderer 只做一次小写查找。
      ...(item.fileExtensions
        ? {
            fileExtensions: [
              ...new Set(item.fileExtensions.map((extension) => extension.toLowerCase())),
            ],
          }
        : {}),
      target: {
        kind: target.kind,
        id:
          target.kind === "view" || target.kind === "command"
            ? extensionGlobalId(pluginId, target.id)
            : target.id,
      },
    });
  }

  if (!manifest || entry.extension?.state !== "ok") return { entry, declaration: null };
  return {
    entry,
    declaration: {
      pluginId,
      ...(source.version ? { version: source.version } : {}),
      rootPath: source.rootPath,
      ...(source.dataPath ? { dataPath: source.dataPath } : {}),
      ...(manifest.main ? { main: manifest.main } : {}),
      activationEvents: entry.extension.activationEvents,
      commands: (manifest.contributes?.commands ?? []).map((command) => command.id),
      views: (manifest.contributes?.views ?? []).map((view) => view.id),
      slotItems: usableItemIds,
    },
  };
}

/** 按全局 id 找扩展视图（只在合法、兼容的 extension 里）。 */
export function findStaticView(
  table: ExtensionStaticTable | null,
  viewId: string,
): StaticView | undefined {
  for (const plugin of table?.plugins ?? []) {
    if (plugin.extension?.state !== "ok") continue;
    const view = plugin.extension.views.find((candidate) => candidate.id === viewId);
    if (view) return view;
  }
  return undefined;
}
