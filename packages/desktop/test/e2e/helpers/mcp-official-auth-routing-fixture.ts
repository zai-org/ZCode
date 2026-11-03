import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { prepareWebRemoteControlSessionEventsFixture } from "#e2e/helpers/web-remote-control-session-events-fixture";

export const OFFICIAL_AUTH_ROUTING_PLUGIN = "e2e-official-auth";
export const OFFICIAL_AUTH_ROUTING_SERVER = `plugin:${OFFICIAL_AUTH_ROUTING_PLUGIN}:identity`;

/** 外部账号、relay 与 MCP 使用隔离夹具，Host/CLI/反向授权仍走真实产品链路。 */
export async function prepareOfficialMcpAuthRoutingFixture(options: {
  specs: string[];
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
}): Promise<(() => Promise<void>) | null> {
  if (!options.specs.some((spec) => spec.endsWith("mcp-official-auth-routing.test.ts")))
    return null;
  const stopRemote = await prepareWebRemoteControlSessionEventsFixture({
    ...options,
    webUrl: "http://127.0.0.1:0/remote/v4",
  });
  const requests: Array<{ method: string; authenticated: boolean }> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/__e2e/status") {
      response.end(JSON.stringify({ requests }));
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: string | number;
      method: string;
      params?: { protocolVersion?: string };
    };
    const authenticated = request.headers.authorization === "Bearer mock-token";
    requests.push({ method: message.method, authenticated });
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = !authenticated
      ? { error: { code: 1006, message: "not authenticated" } }
      : {
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "official-auth-routing-fixture", version: "1.0.0" },
                }
              : message.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "identity",
                        description: "E2E authenticated control-plane fixture",
                        inputSchema: { type: "object", properties: {} },
                      },
                    ],
                  }
                : {},
        };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...result }));
  });
  let previous: Record<string, string | undefined> = {};
  const cleanup = async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await stopRemote();
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing MCP fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const envPatch = {
      ZCODE_E2E_OFFICIAL_AUTH_ROUTING_URL: baseUrl,
      ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS: baseUrl,
    };
    previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
    Object.assign(process.env, envPatch);
    const storageRoot = dirname(dirname(options.credentialsFile));
    const pluginId = `${OFFICIAL_AUTH_ROUTING_PLUGIN}@e2e-fixture`;
    const pluginRoot = join(storageRoot, "cli", "e2e-fixtures", OFFICIAL_AUTH_ROUTING_PLUGIN);
    await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: OFFICIAL_AUTH_ROUTING_PLUGIN,
        version: "0.0.0",
        mcpServers: {
          identity: {
            type: "http",
            url: `${baseUrl}/mcp`,
            protocolVersion: "legacy",
            auth: { type: "zcode_official", provider: "jwt_token" },
          },
        },
      }),
    );
    const installedPath = join(storageRoot, "cli", "plugins", "installed_plugins.json");
    await mkdir(dirname(installedPath), { recursive: true });
    await writeFile(
      installedPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: pluginId,
            name: OFFICIAL_AUTH_ROUTING_PLUGIN,
            installPath: pluginRoot,
            marketplace: "e2e-fixture",
            scope: "user",
            version: "0.0.0",
            installedAt: "2026-10-30T00:00:00.000Z",
            updatedAt: "2026-10-30T00:00:00.000Z",
          },
        ],
      }),
    );
    const configPath = join(storageRoot, "cli", "config.json");
    const config = JSON.parse(
      await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "{}";
      }),
    );
    config.plugins = {
      ...config.plugins,
      enabledPlugins: { ...config.plugins?.enabledPlugins, [pluginId]: true },
    };
    await writeFile(configPath, JSON.stringify(config));
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
