import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZCodeProtocolClient } from "../../../services/src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "../../../services/src/zcode-agent/zcodeStdioTransport.js";

export class Events<T> {
  readonly history: T[] = [];
  private waiters = new Set<{ match: (event: T) => boolean; resolve: (event: T) => void }>();
  emit(event: T) {
    this.history.push(event);
    for (const waiter of this.waiters)
      if (waiter.match(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
  }
  wait(match: (event: T) => boolean, after = 0): Promise<T> {
    const existing = this.history.slice(after).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.add({ match, resolve }));
  }
}
export async function startAgent(
  root: string,
  node: string,
  cli: string,
  providerEnv: Record<string, string> = {},
) {
  const events = new Events<any>();
  const approvals = new Events<any>();
  const notifications = new Events<any>();
  const runtimePreferences = new Events<any>();
  const runtimePreferenceGates = new Map<string, Promise<void>>();
  const sockets = new Map<string, Socket>();
  const socketSources = new Map<Socket, string>();
  const control = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      const event = JSON.parse(line);
      socketSources.set(socket, event.source);
      sockets.set(event.source, socket);
      events.emit(event);
    });
    socket.on("close", () => {
      const source = socketSources.get(socket);
      socketSources.delete(socket);
      if (source && sockets.get(source) === socket) {
        const previous = [...socketSources]
          .reverse()
          .find(([candidate, key]) => key === source && !candidate.destroyed);
        if (previous) sockets.set(source, previous[0]);
        else sockets.delete(source);
      }
    });
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const port = (control.address() as { port: number }).port;
  const data = join(root, "agent-data");
  await mkdir(data, { recursive: true });
  // 不继承 API key、真实用户认证及 Electron Node 标志，模型测试也只通过显式传入的隔离配置访问本地 fixture。
  const child = spawn(node, [cli, "app-server"], {
    cwd: data,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      // 正式回归隔离用户配置，不能读取本机 MCP、认证或把日志写入真实用户目录。
      HOME: data,
      USERPROFILE: data,
      ZCODE_LOG_DIR: join(data, "logs"),
      ZCODE_DATA_BASE_DIR: data,
      ZCODE_SESSION_DB: join(data, "session.sqlite"),
      ZCODE_STORAGE_DIR: data,
      LANG: "en_US.UTF-8",
      ...providerEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const transport = new ZCodeStdioTransport(child, {
    onStderrLine: (line) => process.stderr.write(line + "\n"),
  });
  const client = new ZCodeProtocolClient(transport, {
    requireStorageStartup: true,
    requestTimeoutMs: 15_000,
  });
  client.onNotification((event) => notifications.emit(event));
  client.onRequest((request) => {
    if (request.method === "session/requestRuntimePreferences") {
      runtimePreferences.emit(request);
      void (async () => {
        await runtimePreferenceGates.get((request.params as { sessionId: string }).sessionId);
        await client.respond(request.id, {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
        });
      })();
    } else if (request.method === "interaction/requestPermission") approvals.emit(request);
    else
      void client.respondError(request.id, -32601, `Unexpected fixture request: ${request.method}`);
  });
  // 真实编辑器的长轮询为 20 秒，不能套夹具普通 RPC 的 15 秒期限。
  const call = (method: string, params: unknown) =>
    client.request<any>(
      method as never,
      params,
      undefined,
      method === "mcp/uiCallTool" ? { timeoutMs: 180_000 } : undefined,
    );
  const mcpServers = (source: string, serverName = "fixture", demo?: { serverScript: string }) => [
    {
      name: serverName,
      command: node,
      args: demo
        ? [demo.serverScript]
        : [join(root, "mcp-server.mjs"), String(port), join(root, "widget.html"), source],
      env: [],
      protocolVersion: "legacy",
      isolation: "session",
    },
  ];
  return {
    mcpServers,
    call,
    client,
    events,
    approvals,
    notifications,
    runtimePreferences,
    runtimePreferenceGates,
    respond: (request: any, decision: "allow" | "deny") => client.respond(request.id, { decision }),
    release: (source: string, key: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "release", key }) + "\n"),
    disconnect: (source: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "disconnect" }) + "\n"),
    notify: (source: string, uri: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "notify", uri }) + "\n"),
    async session(
      workspacePath: string,
      source: string,
      serverName = "fixture",
      workspaceIdentity?: string,
      demo?: { serverScript: string; resourceUri: string },
    ) {
      await mkdir(workspacePath, { recursive: true });
      const workspace = {
        workspacePath,
        workspaceKey: workspaceIdentity ?? workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      };
      const response = await call("session/create", {
        workspace,
        mode: "build",
        persistence: "deferred",
        titleGenerationEnabled: false,
        mcpServers: mcpServers(source, serverName, demo),
      });
      return {
        workspace,
        sessionId: response.session.sessionId,
        pluginId: "fixture",
        serverName,
        ...(demo ? { resourceUri: demo.resourceUri } : {}),
      };
    },
    async uiSession(
      workspacePath: string,
      source: string,
      demo?: { serverScript: string; resourceUri: string; surface: string },
    ) {
      const pluginRoot = join(workspacePath, "editor-plugin");
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "background-editor",
          mcpServers: {
            editor: {
              command: node,
              args: demo
                ? [demo.serverScript]
                : [join(root, "mcp-server.mjs"), String(port), join(root, "widget.html"), source],
            },
          },
        }),
      );
      await writeFile(
        join(workspacePath, "zcode.json"),
        JSON.stringify({ plugins: { dirs: [pluginRoot] } }),
      );
      const workspace = { workspacePath, workspaceKey: workspacePath };
      const response = await call("session/create", {
        workspace,
        mode: "yolo",
        persistence: "deferred",
        titleGenerationEnabled: false,
      });
      return {
        workspace,
        sessionId: response.session.sessionId,
        pluginId: "background-editor@inline",
        serverName: "plugin:background-editor:editor",
        ...(demo ? { resourceUri: demo.resourceUri, surface: demo.surface } : {}),
      };
    },
    async close() {
      await transport.disposeAndWait();
      client.dispose();
      for (const socket of sockets.values()) socket.destroy();
      await new Promise<void>((resolve) => control.close(() => resolve()));
    },
  };
}
