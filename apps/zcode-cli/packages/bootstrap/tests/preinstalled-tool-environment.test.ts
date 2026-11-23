import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { NodeExecutionAdapter } from "@zcode/adapters/exec";
import { createConfiguredHookRunner } from "@zcode/core";
import { HookEventName, createSessionId, createTraceId, createTurnId } from "@zcode/contracts";

const TIMEOUT_MS = 10000;

describe("preinstalled entries in long-lived Agent child environments", () => {
  it.skipIf(process.platform === "win32")(
    "MCP stdio and hooks see entry publication, removal and restoration without reconnecting",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-preinstalled-children-"));
      const home = join(root, "中文 空格");
      const bin = join(home, "bin");
      const system = join(home, "system-bin");
      await mkdir(bin, { recursive: true });
      await mkdir(system);
      await writeFile(join(system, "qpdf"), "#!/bin/sh\nprintf 'system\\n'\n", { mode: 0o755 });
      const env = {
        ...process.env,
        HOME: home,
        PATH: [bin, system, process.env.PATH].join(delimiter),
        ZCODE_PREINSTALLED_TOOLS_AVAILABLE: "1",
      };
      const mcp = createMcpAdapter({ env });
      const execution = new NodeExecutionAdapter({
        processEnv: env,
        outputRootDir: join(root, "exec"),
      });
      const server = join(root, "server.mjs");
      const hook = join(root, "hook.mjs");
      await writeFile(
        server,
        [
          `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};`,
          `import { serveStdio } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};`,
          "import { execFile } from 'node:child_process'; import { promisify } from 'node:util';",
          "serveStdio(() => { const server = new McpServer({name:'preinstalled-child-test',version:'1.0.0'});",
          "server.registerTool('resolve',{description:'resolve current entry',inputSchema:{}},async()=>{ const result=await promisify(execFile)('qpdf',[]); return {content:[{type:'text',text:JSON.stringify({pid:process.pid,value:result.stdout.trim()})}]}; }); return server; });",
        ].join("\n"),
      );
      await writeFile(
        hook,
        [
          "import { execFile } from 'node:child_process'; import { promisify } from 'node:util';",
          "const result=await promisify(execFile)('qpdf',[]);",
          "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:result.stdout.trim()}}));",
        ].join("\n"),
      );
      const runner = createConfiguredHookRunner({
        config: {
          enabled: true,
          timeoutMs: TIMEOUT_MS,
          maxOutputBytes: 4096,
          events: {
            UserPromptSubmit: [
              { hooks: [{ type: "process", command: process.execPath, args: [hook] }] },
            ],
          },
        },
        executionPort: execution,
        getWorkingDirectory: () => home,
      });
      try {
        await mcp.connectServer("inherited", {
          type: "stdio",
          command: process.execPath,
          args: [server],
          timeoutMs: TIMEOUT_MS,
        });
        let pid: number | undefined;
        const observe = async (expected: string) => {
          const output = await mcp.callTool({ serverName: "inherited", toolName: "resolve" });
          const text = output.content.find((item) => item.type === "text");
          if (!text || text.type !== "text") throw new Error("Missing MCP text result");
          const observed = JSON.parse(text.text);
          expect(observed.value).toBe(expected);
          if (pid) expect(observed.pid).toBe(pid);
          pid = observed.pid;
          const hookResult = await runner!.run({
            cwd: home,
            hookEventName: HookEventName.UserPromptSubmit,
            mode: "build",
            prompt: "read entry",
            sessionId: createSessionId("preinstalled-children"),
            timestamp: new Date().toISOString(),
            traceId: createTraceId(),
            turnId: createTurnId(`turn-${expected}`),
          });
          expect(hookResult.additionalContexts).toContain(expected);
        };
        await observe("system");
        const entry = join(bin, "qpdf");
        await writeFile(entry, "#!/bin/sh\nprintf 'managed\\n'\n", { mode: 0o755 });
        await observe("managed");
        await rm(entry);
        await observe("system");
        await writeFile(entry, "#!/bin/sh\nprintf 'managed\\n'\n", { mode: 0o755 });
        await observe("managed");
        await mcp.connectServer("explicit-path", {
          type: "stdio",
          command: process.execPath,
          args: [server],
          env: { PATH: [system, process.env.PATH].join(delimiter) },
          timeoutMs: TIMEOUT_MS,
        });
        const overridden = await mcp.callTool({ serverName: "explicit-path", toolName: "resolve" });
        expect(JSON.stringify(overridden.content)).toContain("system");
      } finally {
        await mcp.close();
        await execution.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60000,
  );
});
