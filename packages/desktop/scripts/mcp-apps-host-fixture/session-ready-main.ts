import { app, protocol } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
import { checkSessionReady } from "./managed-late-checks.js";

const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    // 单例回归只使用显式注入的 MCP；默认内置插件会引入认证和网络等待，污染恢复时序。
    const configDir = join(root, "agent-data/.zcode/cli");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ plugins: { enabled: false } }),
    );
    const env = await managedEnvironment(root, node, cli);
    const checks: { name: string; ms: number }[] = [];
    try {
      await checkSessionReady(env, root, async (name, run) => {
        const start = performance.now();
        await run();
        checks.push({ name, ms: performance.now() - start });
      });
      await writeFile(
        join(root, "session-ready-results.json"),
        JSON.stringify(
          {
            caseId: "PLM-UI-SESSION-READY",
            checks,
          },
          null,
          2,
        ),
      );
    } finally {
      await writeFile(
        join(root, "session-ready-events.json"),
        JSON.stringify(
          {
            phases: env.events.history.filter((e) => e.type === "phase"),
            lifecycle: env.agent.notifications.history.filter(
              (e) => e.method === "session/lifecycle/changed",
            ),
            mcp: env.agent.events.history,
          },
          null,
          2,
        ),
      );
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
