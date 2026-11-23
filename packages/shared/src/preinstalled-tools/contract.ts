import { z } from "zod";
import {
  validatePreinstalledEntries,
  validatePreinstalledCatalog,
} from "#src/preinstalled-tools/validation.js";

export const ZCODE_PREINSTALLED_TOOLS_AVAILABLE_ENV = "ZCODE_PREINSTALLED_TOOLS_AVAILABLE";
export const preinstalledToolsReleaseSchema = z.enum(["production", "preview", "development"]);
export const preinstalledToolPlatformSchema = z.enum(["darwin", "win32", "linux"]);
export const preinstalledToolArchSchema = z.enum(["x64", "arm64"]);
export const preinstalledToolIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(80);
const resourceIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .max(160);
const versionSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const valueSchema = z.string().refine((value) => !value.includes("\0"));
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\\:]/.test(value) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "必须是归档内的安全相对路径",
  );
const absolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\0") &&
      (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)),
    "必须是绝对路径",
  );
const entryNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .max(160);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const preinstalledToolEntrySchema = z.strictObject({
  name: entryNameSchema,
  target: relativePathSchema,
  args: z.array(valueSchema),
  env: z.array(
    z.discriminatedUnion("action", [
      z.strictObject({ name: environmentNameSchema, action: z.literal("set"), value: valueSchema }),
      z.strictObject({
        name: environmentNameSchema,
        action: z.literal("default"),
        value: valueSchema,
      }),
      z.strictObject({ name: environmentNameSchema, action: z.literal("unset") }),
    ]),
  ),
});
const downloadUrlsSchema = z.array(z.url({ protocol: /^https?$/ })).min(1);
const archiveShape = {
  format: z.literal("tar.gz"),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};
const identityShape = {
  toolId: preinstalledToolIdSchema,
  resourceId: resourceIdSchema,
  version: versionSchema,
};
const resourceShape = {
  ...identityShape,
  platforms: z
    .array(
      z.strictObject({
        platform: preinstalledToolPlatformSchema,
        arch: preinstalledToolArchSchema,
      }),
    )
    .min(1),
  binaryArch: preinstalledToolArchSchema,
  installedSizeBytes: z.number().int().positive(),
  requiredFiles: z.array(relativePathSchema).min(1),
  rewrite: z
    .array(
      z.strictObject({
        path: relativePathSchema,
        placeholder: valueSchema.min(1),
        mode: z.enum(["text", "binary", "binary-dir-prefix"]),
      }),
    )
    .optional(),
  entries: z.array(preinstalledToolEntrySchema).min(1),
  runtimeChecks: z
    .array(
      z.strictObject({
        entry: entryNameSchema,
        args: z.array(valueSchema),
        expectedOutput: z.string().min(1),
        timeoutMs: z.number().int().positive(),
      }),
    )
    .min(1),
};
/** 未发布产物没有下载路径；运行时只接收带 archive.path 的资源。 */
export const preinstalledToolArtifactSchema = z
  .strictObject({ ...resourceShape, archive: z.strictObject(archiveShape) })
  .superRefine(validatePreinstalledEntries);
export const preinstalledToolResourceSchema = z
  .strictObject({
    ...resourceShape,
    archive: z.strictObject({
      ...archiveShape,
      // 只存相对路径；基址由 Main 决定，同一 catalog 可以切换官方 CDN 或内网服务器。
      path: relativePathSchema,
    }),
  })
  .superRefine(validatePreinstalledEntries);
export const preinstalledToolCatalogEntrySchema = z.strictObject({
  toolId: preinstalledToolIdSchema,
  displayName: z.string().min(1),
  resources: z.array(preinstalledToolResourceSchema),
});
export const preinstalledToolsCatalogSchema = z
  .array(preinstalledToolCatalogEntrySchema)
  .superRefine(validatePreinstalledCatalog);
/** 有序下载列表仅为 Main 的派生值，不是 catalog 接受的另一种地址格式。 */
export const preinstalledToolManifestSchema = preinstalledToolResourceSchema.safeExtend({
  downloadUrls: downloadUrlsSchema,
});
export const preinstalledToolConfigurationSchema = z
  .strictObject({
    toolId: preinstalledToolIdSchema,
    displayName: z.string().min(1),
    manifest: preinstalledToolManifestSchema.nullable(),
  })
  .refine((tool) => !tool.manifest || tool.manifest.toolId === tool.toolId, "资源必须属于当前工具");
function joinDownloadUrl(baseUrl: string, path: string): string {
  // 版本号可能带 +，按段编码，避免 CDN 把它当成另一个对象 key。
  return `${baseUrl.replace(/\/+$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
/** 基址不合法时全部工具没有目标且不回退，错误交给 Main 记录；只有 catalog 不合法才抛错。
 * 修复原因：基址错误曾让整个装配抛错，Main 以空列表交给预装进程，已安装资源被当作移出 catalog 删除。 */
export function resolvePreinstalledToolsCatalog(
  input: unknown,
  platform: string,
  arch: string,
  downloadBaseUrls: readonly string[],
): { tools: PreinstalledToolConfiguration[]; downloadBaseUrlsError?: z.ZodError } {
  const catalog = preinstalledToolsCatalogSchema.parse(input);
  const { data: baseUrls, error } = downloadUrlsSchema.safeParse(downloadBaseUrls);
  const tools = catalog.map(({ toolId, displayName, resources }) => {
    const resource = resources.find((item) =>
      item.platforms.some((target) => target.platform === platform && target.arch === arch),
    );
    if (!resource || !baseUrls) return { toolId, displayName, manifest: null };
    return {
      toolId,
      displayName,
      manifest: {
        ...resource,
        downloadUrls: [
          ...new Set(baseUrls.map((baseUrl) => joinDownloadUrl(baseUrl, resource.archive.path))),
        ],
      },
    };
  });
  return error ? { tools, downloadBaseUrlsError: error } : { tools };
}
/** 安装记录是唯一发布点；入口与必需文件取自发布时的资源，而不是当前 catalog。 */
export const preinstalledToolInstallationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...identityShape,
    platform: preinstalledToolPlatformSchema,
    arch: preinstalledToolArchSchema,
    installationDir: absolutePathSchema,
    installedSizeBytes: z.number().int().positive(),
    requiredFiles: z.array(relativePathSchema).min(1),
    entries: z.array(preinstalledToolEntrySchema).min(1),
    installedAt: z.iso.datetime(),
  })
  .superRefine(validatePreinstalledEntries);
export const PREINSTALLED_TOOL_ARCHIVE_IDENTITY_FILE = "zcode-tool-resource.json";
export const preinstalledToolArchiveIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...identityShape,
  platforms: resourceShape.platforms,
  binaryArch: preinstalledToolArchSchema,
});
export type PreinstalledToolsRelease = z.infer<typeof preinstalledToolsReleaseSchema>;
export type PreinstalledToolEntry = z.infer<typeof preinstalledToolEntrySchema>;
export type PreinstalledToolArtifact = z.infer<typeof preinstalledToolArtifactSchema>;
export type PreinstalledToolResource = z.infer<typeof preinstalledToolResourceSchema>;
export type PreinstalledToolManifest = z.infer<typeof preinstalledToolManifestSchema>;
export type PreinstalledToolCatalogEntry = z.infer<typeof preinstalledToolCatalogEntrySchema>;
export type PreinstalledToolConfiguration = z.infer<typeof preinstalledToolConfigurationSchema>;
export type PreinstalledToolInstallation = z.infer<typeof preinstalledToolInstallationSchema>;
export function resolvePreinstalledToolsRelease(input: {
  runtimeEnv: string;
  productFlavor: "production" | "preview";
}): PreinstalledToolsRelease {
  return input.runtimeEnv === "development" ? "development" : input.productFlavor;
}
export const preinstalledToolErrorSchema = z.enum([
  "network",
  "interrupted",
  "disk-space",
  "checksum",
  "extract",
  "runtime",
  "unsupported",
]);
export const preinstalledToolStateSchema = z.strictObject({
  agentEnabled: z.boolean(),
  entryOutOfSync: z.boolean(),
  toolId: preinstalledToolIdSchema,
  displayName: z.string().min(1),
  status: z.enum(["not-installed", "preparing", "ready", "failed"]),
  target: z
    .strictObject({
      resourceId: resourceIdSchema,
      version: versionSchema,
      archiveSizeBytes: z.number().int().positive(),
      installedSizeBytes: z.number().int().positive(),
    })
    .nullable(),
  installed: z
    .strictObject({
      resourceId: resourceIdSchema,
      version: versionSchema,
      installedSizeBytes: z.number().int().positive(),
    })
    .nullable(),
  phase: z.enum(["queued", "downloading", "verifying", "extracting", "checking"]).optional(),
  downloadedBytes: z.number().int().nonnegative().optional(),
  error: preinstalledToolErrorSchema.optional(),
  deletionBlocked: z.boolean().optional(),
});
export const preinstalledToolsStateSchema = z.strictObject({
  autoInstallEnabled: z.boolean(),
  tools: z.array(preinstalledToolStateSchema),
});
export type PreinstalledToolState = z.infer<typeof preinstalledToolStateSchema>;
export type PreinstalledToolsState = z.infer<typeof preinstalledToolsStateSchema>;
export type PreinstalledToolError = z.infer<typeof preinstalledToolErrorSchema>;
export const preinstalledToolsCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set-auto-install"), enabled: z.boolean() }),
  z.strictObject({
    type: z.literal("set-agent-enabled"),
    toolId: preinstalledToolIdSchema,
    enabled: z.boolean(),
  }),
  z.strictObject({ type: z.literal("sync-entries"), toolId: preinstalledToolIdSchema }),
  z.strictObject({ type: z.literal("prepare"), toolId: preinstalledToolIdSchema }),
  z.strictObject({ type: z.literal("cancel"), toolId: preinstalledToolIdSchema }),
  z.strictObject({ type: z.literal("delete"), toolId: preinstalledToolIdSchema }),
]);
export type PreinstalledToolsCommand = z.infer<typeof preinstalledToolsCommandSchema>;
export const mainToPreinstalledToolsSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("initialize"),
    dataRoot: absolutePathSchema,
    release: preinstalledToolsReleaseSchema,
    autoPrepare: z.boolean(),
    /** null 表示清单不可用，与合法空列表区分；预装进程据此跳过按 catalog 归属的回收。 */
    tools: z.array(preinstalledToolConfigurationSchema).nullable(),
    /** Windows 入口 shim 的绝对路径；见 docs/preinstalled-tools/windows-entry-shim.md。 */
    windowsEntryShim: absolutePathSchema.optional(),
  }),
  z.strictObject({ type: z.literal("get-state"), requestId: z.uuid() }),
  z.strictObject({
    type: z.literal("command"),
    requestId: z.uuid(),
    command: preinstalledToolsCommandSchema,
  }),
  z.strictObject({ type: z.literal("dispose") }),
]);
export const preinstalledToolsToMainSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("command-error"), requestId: z.uuid() }),
  z.strictObject({ type: z.literal("initialized") }),
  z.strictObject({
    type: z.literal("state"),
    requestId: z.uuid().optional(),
    state: preinstalledToolsStateSchema,
  }),
  z.strictObject({
    type: z.literal("log"),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
  }),
]);
export type MainToPreinstalledToolsMessage = z.infer<typeof mainToPreinstalledToolsSchema>;
export type PreinstalledToolsToMainMessage = z.infer<typeof preinstalledToolsToMainSchema>;
