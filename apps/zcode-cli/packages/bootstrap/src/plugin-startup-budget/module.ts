import type { PluginLoadOutcome } from "@zcode/contracts";
import type { PluginStartupBudget, PluginStartupBudgetOptions } from "./contract.js";

function fallback(): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [
      {
        code: "plugin_startup_timeout",
        severity: "warning",
        message: "Plugin startup timed out. Plugins are unavailable until the Agent restarts.",
      },
    ],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  };
}

export function createPluginStartupBudget(
  options: PluginStartupBudgetOptions,
): PluginStartupBudget {
  let degraded = false;
  let disposed = false;
  let closeReason: unknown;
  let budget:
    | {
        deadlineAt: number;
        expired: ReturnType<typeof Promise.withResolvers<void>>;
        timer: ReturnType<typeof setTimeout>;
        pending: number;
      }
    | undefined;
  function expire() {
    if (degraded || disposed) return;
    degraded = true;
    budget?.expired.resolve();
    options.onTimeout(
      Object.assign(new Error("Plugin startup timed out"), {
        code: "ZCODE_PLUGIN_STARTUP_TIMEOUT",
      }),
    );
  }
  return {
    get degraded() {
      return degraded;
    },
    async resolvePlugins(resolve) {
      if (disposed) throw closeReason;
      if (degraded) return fallback();
      if (!budget) {
        budget = {
          deadlineAt: performance.now() + options.timeoutMs,
          expired: Promise.withResolvers<void>(),
          timer: setTimeout(expire, options.timeoutMs),
          pending: 0,
        };
      }
      const active = budget;
      active.pending += 1;
      try {
        const result = await Promise.race([resolve(), active.expired.promise.then(fallback)]);
        // 同步摘要计算可能推迟定时器；完成时仍检查预算，不能接受超期结果。
        if (performance.now() >= active.deadlineAt) expire();
        return degraded ? fallback() : result;
      } catch (error) {
        if (performance.now() >= active.deadlineAt) expire();
        if (degraded && !disposed) return fallback();
        throw error;
      } finally {
        active.pending -= 1;
        if (active.pending === 0) {
          clearTimeout(active.timer);
          if (budget === active) budget = undefined;
        }
      }
    },
    dispose(reason) {
      disposed = true;
      closeReason = reason;
      if (budget) {
        clearTimeout(budget.timer);
        budget.expired.reject(reason);
      }
    },
  };
}
