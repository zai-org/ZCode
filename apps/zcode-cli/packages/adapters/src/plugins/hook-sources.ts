import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { HookEventName, HookPluginContext, PluginDiagnostic } from "@zcode/contracts";
import { HookEventName as HookEventNameValue } from "@zcode/contracts";
import {
  fileExistsAsync,
  isRecord,
  resolveInside,
  rethrowPluginMaterialInterrupt,
} from "./helpers.js";
import type { LoadedPlugin } from "./types.js";

export const STANDARD_HOOKS_PATH = join("hooks", "hooks.json");

const SUPPORTED_HOOK_EVENTS = new Set<string>(Object.values(HookEventNameValue));

export interface PluginHookSource {
  rawHooks: unknown;
  sourcePath: string;
  wrapper: boolean;
}

/**
 * 统一发现插件 hook 来源文件，避免详情枚举和真实 loader 对 `hooks/hooks.json`
 * 与 `manifest.hooks` 的读取口径漂移。
 */
export async function listPluginHookSources(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): Promise<PluginHookSource[]> {
  const sources: PluginHookSource[] = [];
  const loadedHookPaths = new Set<string>();
  const standardHooksPath = join(input.loaded.rootPath, STANDARD_HOOKS_PATH);

  if (
    await (input.loaded.materials?.fileExists(standardHooksPath) ??
      fileExistsAsync(standardHooksPath))
  ) {
    const source = await loadPluginHookSource({
      diagnostics: input.diagnostics,
      loaded: input.loaded,
      path: standardHooksPath,
    });
    if (source) {
      sources.push(source);
      loadedHookPaths.add(await realpathOrSelf(standardHooksPath));
    }
  }

  const manifestHooks = input.loaded.manifest.hooks;
  if (manifestHooks === undefined) return sources;
  const hookSpecs = Array.isArray(manifestHooks) ? manifestHooks : [manifestHooks];

  for (const hookSpec of hookSpecs) {
    if (typeof hookSpec === "string") {
      const hookFilePath = resolveInside(input.loaded.rootPath, hookSpec);
      if (!hookFilePath) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin hooks path escapes plugin root: ${hookSpec}`,
          path: input.loaded.manifestPath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      if (
        !(await (input.loaded.materials?.fileExists(hookFilePath) ?? fileExistsAsync(hookFilePath)))
      ) {
        input.diagnostics.push({
          code: "plugin_hook_read_failed",
          message: `Plugin hooks file not found: ${hookSpec}`,
          path: hookFilePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }

      const realPath = await realpathOrSelf(hookFilePath);
      if (loadedHookPaths.has(realPath)) {
        input.diagnostics.push({
          code: "plugin_hook_invalid",
          message: `Duplicate plugin hooks file ignored: ${hookSpec}`,
          path: hookFilePath,
          pluginId: input.loaded.id,
          severity: "warning",
        });
        continue;
      }

      const source = await loadPluginHookSource({
        diagnostics: input.diagnostics,
        loaded: input.loaded,
        path: hookFilePath,
      });
      if (source) {
        sources.push(source);
        loadedHookPaths.add(realPath);
      }
      continue;
    }

    sources.push({
      rawHooks: hookSpec,
      sourcePath: input.loaded.manifestPath,
      wrapper: false,
    });
  }

  return sources;
}

/** 只抽取 hook 事件名，供 `plugins/describe` 展示；不会构造可执行 hook。 */
export async function listPluginHookEventNames(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): Promise<HookEventName[]> {
  const eventNames: HookEventName[] = [];
  const seen = new Set<string>();
  for (const source of await listPluginHookSources(input)) {
    const hooksRoot = source.wrapper
      ? isRecord(source.rawHooks)
        ? source.rawHooks.hooks
        : undefined
      : source.rawHooks;
    if (!isRecord(hooksRoot)) {
      input.diagnostics.push({
        code: "plugin_hook_invalid",
        message: source.wrapper
          ? "Plugin hooks file must contain a hooks object"
          : "Plugin manifest hooks entry must be an object, a path, or an array",
        path: source.sourcePath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    for (const eventName of Object.keys(hooksRoot)) {
      if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
        input.diagnostics.push({
          code: "plugin_hook_unsupported_event",
          message: `Plugin hook event is not supported by this ZCode runtime: ${eventName}`,
          path: source.sourcePath,
          pluginId: input.loaded.id,
          severity: "warning",
        });
        continue;
      }
      if (seen.has(eventName)) continue;
      seen.add(eventName);
      eventNames.push(eventName as HookEventName);
    }
  }
  return eventNames;
}

async function loadPluginHookSource(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  path: string;
}): Promise<PluginHookSource | null> {
  try {
    return {
      rawHooks: input.loaded.materials
        ? await input.loaded.materials.json(input.path)
        : (JSON.parse(await readFile(input.path, "utf8")) as unknown),
      sourcePath: input.path,
      wrapper: true,
    };
  } catch (error) {
    rethrowPluginMaterialInterrupt(error);
    input.diagnostics.push({
      code: "plugin_hook_read_failed",
      message:
        error instanceof Error ? error.message : `Failed to read plugin hooks: ${input.path}`,
      path: input.path,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return null;
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export function createHookPluginContext(
  loaded: LoadedPlugin,
  dataPath: string,
  sourcePath?: string,
): HookPluginContext {
  return {
    dataPath,
    id: loaded.id,
    name: loaded.manifest.name,
    rootPath: loaded.rootPath,
    ...(sourcePath ? { sourcePath } : {}),
  };
}
