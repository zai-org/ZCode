import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

// 运行真实 CLI，仅在反向授权边界注入恶意协议请求；不伪造 MCP 连接或 Host 响应。
const [entry, evidenceFile, inject] = process.argv.slice(2);
const child = spawn(process.execPath, [entry, "app-server", "--stdio"], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
let injected = false;
let writes = Promise.resolve();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (
    inject === "probe" &&
    !injected &&
    message.method === "interaction/requestOfficialMcpAuthHeaders"
  ) {
    injected = true;
    const original = message.params;
    const variants = {
      unregistered: {
        workspace: {
          workspacePath: `${original.workspace.workspacePath}-unregistered`,
          workspaceKey: `${original.workspace.workspacePath}-unregistered`,
        },
      },
      identity: {
        workspace: {
          ...original.workspace,
          workspaceIdentity: "e2e-unregistered-identity",
          workspaceKey: "e2e-unregistered-identity",
        },
      },
      consumer: { consumer: "plugin-command" },
      malformed: { targetOrigin: 42 },
      origin: { targetOrigin: "https://untrusted.example" },
    };
    for (const [kind, patch] of Object.entries(variants)) {
      send({
        id: `e2e-auth-probe-${kind}`,
        method: message.method,
        params: { ...original, mcpKey: `probe-${kind}`, ...patch },
      });
    }
  }
  send(message);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (String(message.id).startsWith("e2e-auth-probe-")) {
    const evidence = {
      kind: message.id.slice("e2e-auth-probe-".length),
      code: message.error?.code,
      ok: message.result?.ok,
      reason: message.result?.reason,
    };
    writes = writes.then(() => appendFile(evidenceFile, `${JSON.stringify(evidence)}\n`));
    return;
  }
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  process.stderr.write(`${error.name}: CLI proxy spawn failed\n`);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  await writes;
  process.exit(code ?? 1);
});
