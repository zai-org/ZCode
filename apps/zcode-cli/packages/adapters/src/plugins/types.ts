import type { PluginMaterialReader } from "./helpers.js";
import type {
  CustomCommandRoot,
  HookEventName,
  HookMatcherConfig,
  McpServerConfig,
  PluginHookDetail,
  PluginManifest,
  PluginSource,
  SkillRoot,
} from "@zcode/contracts";

export interface PluginCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface LoadedPlugin {
  materials?: PluginMaterialReader;
  id: string;
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface PluginComponents {
  commandRoots: CustomCommandRoot[];
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  hookDetails: PluginHookDetail[];
  mcpServers: Record<string, McpServerConfig>;
  skillCount: number;
  skillRoots: SkillRoot[];
}

export interface PluginAbortOptions {
  signal?: AbortSignal;
}
