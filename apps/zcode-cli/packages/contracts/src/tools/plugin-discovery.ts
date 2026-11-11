import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SEARCH_PLUGINS_TOOL_NAME = "SearchPlugins";
export const SUGGEST_PLUGIN_INSTALL_TOOL_NAME = "SuggestPluginInstall";
export const PLUGIN_DISCOVERY_PAGE_SIZE = 10;
const text = z.string().trim().min(1).max(2_000);
const localeText = z.record(z.string(), z.string());
export const PluginDiscoveryCandidateSchema = z
  .object({
    pluginId: text,
    name: text,
    displayName: z.string().optional(),
    displayNameI18n: localeText.optional(),
    description: z.string().optional(),
    descriptionI18n: localeText.optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    installed: z.boolean(),
    enabled: z.boolean(),
    action: z.enum(["install", "enable", "none"]),
    scope: z.enum(["user", "workspace"]),
  })
  .strict();
export type PluginDiscoveryCandidate = z.infer<typeof PluginDiscoveryCandidateSchema>;
export const SearchPluginsInputSchema = z
  .object({
    query: text.describe(
      "Search keywords for the capability needed. Include service names or alternative Chinese/English keywords when useful.",
    ),
    cursor: z.string().max(2_000).optional(),
  })
  .strict();
export const SearchPluginsOutputSchema = z
  .object({
    plugins: z.array(PluginDiscoveryCandidateSchema).max(PLUGIN_DISCOVERY_PAGE_SIZE),
    cursor: z.string().optional(),
    stale: z.boolean(),
  })
  .strict();
export const SuggestPluginInstallInputSchema = z
  .object({
    pluginId: text.describe(
      "Exact stable ID returned by SearchPlugins, ending in @zcode-plugins-official.",
    ),
    reason: text.describe(
      "One short sentence explaining how this plugin helps the current user task.",
    ),
    reconsider: z
      .boolean()
      .optional()
      .describe(
        "Only true after a NEW user message explicitly asks to reconsider a previously skipped plugin. Never set proactively.",
      ),
  })
  .strict();
export const PluginActivationStatusSchema = z.enum([
  "ready",
  "disabled",
  "needsConfiguration",
  "refreshRequired",
  "failed",
]);
export type PluginActivationStatus = z.infer<typeof PluginActivationStatusSchema>;
export const SuggestPluginInstallOutputSchema = z
  .object({
    pluginId: text,
    status: z.enum([
      "installed",
      "enabled",
      "alreadyAvailable",
      "skipped",
      "unavailable",
      "failed",
    ]),
    activation: PluginActivationStatusSchema.optional(),
    message: z.string(),
  })
  .strict();
export type SearchPluginsInput = z.infer<typeof SearchPluginsInputSchema>;
export type SearchPluginsOutput = z.infer<typeof SearchPluginsOutputSchema>;
export type SuggestPluginInstallInput = z.infer<typeof SuggestPluginInstallInputSchema>;
export type SuggestPluginInstallOutput = z.infer<typeof SuggestPluginInstallOutputSchema>;
export const SearchPluginsInputJsonSchema = toToolJsonSchema(SearchPluginsInputSchema);
export const SearchPluginsOutputJsonSchema = toToolJsonSchema(SearchPluginsOutputSchema);
export const SuggestPluginInstallInputJsonSchema = toToolJsonSchema(
  SuggestPluginInstallInputSchema,
);
export const SuggestPluginInstallOutputJsonSchema = toToolJsonSchema(
  SuggestPluginInstallOutputSchema,
);
