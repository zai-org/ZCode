import type { PluginLoadOutcome } from "@zcode/contracts";

/** 进程拥有的插件等待预算；超时降级只能由新进程解除。 */
export interface PluginStartupBudget {
  readonly degraded: boolean;
  resolvePlugins(resolve: () => Promise<PluginLoadOutcome>): Promise<PluginLoadOutcome>;
  dispose(reason: unknown): void;
}

export interface PluginStartupBudgetOptions {
  timeoutMs: number;
  onTimeout(reason: Error): void;
}
