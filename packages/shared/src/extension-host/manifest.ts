import { z } from "zod";
import { extensionGrantSchema, extensionProtocolsSchema } from "#src/extension-host/grants.js";

// 插件清单 `extension` 键（docs/plugins/extension-host.md §5）。插槽条目在清单顶层 `slots`（§16.2），
// 见 manifestSlots.ts；两者都由 Window Host 读清单时校验（§16.1）。

/**
 * 扩展 API 的版本，不是 App 版本。清单 engines.zcode 按它判断兼容。
 * 1.1.0（P3a）：清单 `grants` / `protocols`、能力 `sessions.*` 的四个读、带入参的订阅、新错误码。
 * 1.2.0（P3b + P4）：会话读连接（列表、会话状态、行、readRows）；订阅可带 onError，准入与后端错误送达扩展；
 *   dot 与 GitLab 要的宿主能力（§18.1：app 作用域视图、dataPath、models.list、导航标记、grants.request、系统通知）。
 * 1.3.0（P3c）：会话 facade 的八个写动作（带请求身份的动作 requestId 可选，扩展进程补）；sendToSession 可带 model。
 * 1.4.0（P3e）：插件项目里的会话可以由插件回答审批与提问、切换权限模式（onDidChangeInteractions、
 *   resolveInteraction、setPermissionMode）；createSession 可带 mode；档位 sessions.fullAccess（完全访问）。
 */
export const EXTENSION_API_VERSION = "1.4.0";

/** 清单里各种 id：小写字母、数字、`.`、`_`、`-`。全局 id 是 `<pluginId>/<id>`。 */
export const extensionLocalIdSchema = z
  .string()
  .regex(/^[a-z0-9._-]{1,64}$/, "id must use lowercase letters, digits, '.', '_' or '-'");

export const localizedTextSchema = z.union([
  z.string().min(1).max(80),
  z
    .record(z.string().min(2).max(16), z.string().min(1).max(80))
    .refine((value) => Object.keys(value).length > 0, "title map must not be empty"),
]);
export type LocalizedText = z.infer<typeof localizedTextSchema>;

/** Lucide 图标名（kebab-case）。壳层只渲染白名单里的图标，其余显示通用插件图标。 */
export const extensionIconNameSchema = z.string().regex(/^[a-z0-9-]{1,48}$/, "invalid icon name");

const relativeMainSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/^([a-zA-Z]:|[\\/])/.test(value) && !value.split(/[\\/]+/).some((part) => part === ".."),
    "main must be a path inside the plugin root",
  );

const activationEventSchema = z
  .string()
  .regex(
    /^(onAvailable|onCommand:[a-z0-9._-]{1,64}|onView:[a-z0-9._-]{1,64})$/,
    "unknown activation event",
  );

const commandSchema = z.strictObject({ id: extensionLocalIdSchema, title: localizedTextSchema });
/** 视图的作用域声明（§18.1 H5）：只有 "app"；不写时跟随侧栏目标（会话或工作区）。 */
export const extensionViewScopeSchema = z.literal("app");
export type ExtensionViewScope = z.infer<typeof extensionViewScopeSchema>;

const viewSchema = z.strictObject({
  id: extensionLocalIdSchema,
  title: localizedTextSchema,
  icon: extensionIconNameSchema.optional(),
  scope: extensionViewScopeSchema.optional(),
});

const ENGINE_RANGE_PATTERN = /^(\^)?(\d+)\.(\d+)\.(\d+)$/;

const extensionEnginesSchema = z.strictObject({
  zcode: z.string().regex(ENGINE_RANGE_PATTERN, "engines.zcode must be ^x.y.z or x.y.z"),
});

/** 第一步：只读 engines.zcode，其余字段原样放过。 */
const extensionEnginesProbeSchema = z.object({
  engines: z.object({
    zcode: z.string().regex(ENGINE_RANGE_PATTERN, "engines.zcode must be ^x.y.z or x.y.z"),
  }),
});

/** 第二步：版本兼容后按严格对象校验整个 extension。 */
export const extensionManifestSchema = z
  .strictObject({
    engines: extensionEnginesSchema,
    main: relativeMainSchema.optional(),
    activationEvents: z.array(activationEventSchema).optional(),
    /** 需要用户授权的档位（§17.7）。没有声明的档位，对应能力报 not-declared。 */
    grants: z.array(extensionGrantSchema).optional(),
    /** 插件读会话投影所按的协议版本（§17.6）。 */
    protocols: extensionProtocolsSchema.optional(),
    contributes: z
      .strictObject({
        commands: z.array(commandSchema).optional(),
        views: z.array(viewSchema).optional(),
      })
      .optional(),
  })
  .superRefine((manifest, ctx) => {
    const commands = new Set<string>();
    manifest.contributes?.commands?.forEach((command, index) => {
      if (commands.has(command.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["contributes", "commands", index, "id"],
          message: `duplicate command id: ${command.id}`,
        });
      }
      commands.add(command.id);
    });
    const views = new Set<string>();
    manifest.contributes?.views?.forEach((view, index) => {
      if (views.has(view.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["contributes", "views", index, "id"],
          message: `duplicate view id: ${view.id}`,
        });
      }
      views.add(view.id);
    });
    manifest.activationEvents?.forEach((event, index) => {
      const [kind, id] = event.split(":");
      const declared = kind === "onCommand" ? commands : kind === "onView" ? views : null;
      if (declared && id && !declared.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["activationEvents", index],
          message: `activation event refers to an undeclared id: ${event}`,
        });
      }
    });
  });
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

export type ExtensionManifestValidation =
  | { status: "ok"; manifest: ExtensionManifest }
  | { status: "invalid"; path: string; reason: string }
  | { status: "incompatible"; required: string; reason: string };

/**
 * 把 zod 路径格式化为清单字段路径，如 `extension.contributes.commands[0].titel`、
 * `slots["composer.status"][0].target.view`。root 是清单顶层键。
 */
export function formatManifestPath(root: string, path: readonly PropertyKey[]): string {
  let out = root;
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else if (typeof part === "string" && /^[A-Za-z_$][\w$]*$/.test(part)) out += `.${part}`;
    else out += `[${JSON.stringify(String(part))}]`;
  }
  return out;
}

export function formatExtensionManifestPath(path: readonly PropertyKey[]): string {
  return formatManifestPath("extension", path);
}

/** 取第一条校验问题，格式化为 `{ path, reason }`。root 是清单顶层键。 */
export function firstManifestIssue(
  error: z.ZodError,
  root: string,
): { path: string; reason: string } {
  // 未知字段优先报告：拼错的字段（如 titel）同时会让必填字段缺失，先指出拼错的那个更易定位。
  const issue = error.issues.find((item) => item.code === "unrecognized_keys") ?? error.issues[0];
  if (!issue) return { path: root, reason: "invalid manifest" };
  // 未知字段要给到字段本身的路径，便于作者直接定位。
  if (issue.code === "unrecognized_keys" && issue.keys[0]) {
    return {
      path: formatManifestPath(root, [...issue.path, issue.keys[0]]),
      reason: `unknown field: ${issue.keys[0]}`,
    };
  }
  return { path: formatManifestPath(root, issue.path), reason: issue.message };
}

function parseVersion(value: string): [number, number, number] | null {
  const match = ENGINE_RANGE_PATTERN.exec(value);
  if (!match) return null;
  return [Number(match[2]), Number(match[3]), Number(match[4])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** 只支持 `^x.y.z` 与精确版本；主版本必须与宿主一致。 */
export function isExtensionEngineCompatible(
  range: string,
  hostVersion: string = EXTENSION_API_VERSION,
): boolean {
  const required = parseVersion(range);
  const host = parseVersion(hostVersion);
  if (!required || !host) return false;
  if (!range.startsWith("^")) return compareVersions(required, host) === 0;
  if (required[0] !== host[0]) return false;
  // ^0.y.z 按 semver 只匹配同一 0.y。
  if (required[0] === 0 && required[1] !== host[1]) return false;
  return compareVersions(host, required) >= 0;
}

/**
 * 两步校验：
 * 1. 只读 engines.zcode。缺失或格式错误判 invalid；版本不兼容判 incompatible，不再看其余字段。
 * 2. 版本兼容后按严格对象校验整个 extension。未知字段判 invalid，并给出字段路径。
 */
export function validateExtensionManifest(
  raw: unknown,
  hostVersion: string = EXTENSION_API_VERSION,
): ExtensionManifestValidation {
  const engines = extensionEnginesProbeSchema.safeParse(raw);
  if (!engines.success) {
    return { status: "invalid", ...firstManifestIssue(engines.error, "extension") };
  }
  const required = engines.data.engines.zcode;
  if (!isExtensionEngineCompatible(required, hostVersion)) {
    return {
      status: "incompatible",
      required,
      reason: `requires extension API ${required}, host provides ${hostVersion}`,
    };
  }
  const manifest = extensionManifestSchema.safeParse(raw);
  if (!manifest.success) {
    return { status: "invalid", ...firstManifestIssue(manifest.error, "extension") };
  }
  return { status: "ok", manifest: manifest.data };
}

/** 激活事件：显式声明 ∪ 每个命令的 onCommand ∪ 每个视图的 onView（后两种由清单自动推导）。 */
export function resolveActivationEvents(manifest: ExtensionManifest): Set<string> {
  const events = new Set(manifest.activationEvents ?? []);
  for (const command of manifest.contributes?.commands ?? []) events.add(`onCommand:${command.id}`);
  for (const view of manifest.contributes?.views ?? []) events.add(`onView:${view.id}`);
  return events;
}

export function extensionGlobalId(pluginId: string, localId: string): string {
  return `${pluginId}/${localId}`;
}
