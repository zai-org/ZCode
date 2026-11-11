import type { PluginLoadOutcome } from "@zcode/contracts";
import { createPluginStartupBudget } from "./module.js";

export async function resolveWithinStartupBudget(
  resolve: (signal: AbortSignal) => Promise<PluginLoadOutcome>,
) {
  const controller = new AbortController();
  const budget = createPluginStartupBudget({
    timeoutMs: 3_000,
    onTimeout: (reason) => controller.abort(reason),
  });
  try {
    return await budget.resolvePlugins(() => resolve(controller.signal));
  } finally {
    budget.dispose(new Error("Process closed"));
  }
}
