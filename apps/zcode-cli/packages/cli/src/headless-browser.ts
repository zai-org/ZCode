import {
  createManagedCdpBrowserRuntime,
  type ManagedCdpBrowserRuntime,
} from "@zcode/adapters/browser";
import type { GlobalOptions } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";
import { loadCliPlaywrightChromium } from "./sea-playwright-runtime.js";

export function createCliHeadlessBrowserRuntime(
  options: Pick<GlobalOptions, "browserExecutable" | "browserState" | "browserUse">,
  deps: RunDependencies,
): ManagedCdpBrowserRuntime | undefined {
  if (options.browserUse !== "headless") return undefined;
  const factory = deps.createManagedCdpBrowserRuntime ?? createManagedCdpBrowserRuntime;
  return factory({
    env: deps.env,
    executablePath: options.browserExecutable,
    storageStatePath: options.browserState?.path,
    loadPlaywright: loadCliPlaywrightChromium,
  });
}
