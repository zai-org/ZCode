import { access } from "node:fs/promises";
import { createInterface } from "node:readline";

const [mode, recoveryMarker] = process.argv.slice(2);
const recovered =
  recoveryMarker &&
  (await access(recoveryMarker).then(
    () => true,
    () => false,
  ));
if (!recovered) {
  // 真实 stderr/退出路径；只模拟外部进程的失败内容，不写 App 状态。
  const causes = {
    python: "ModuleNotFoundError: No module named 'mcp'",
    node: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'example-mcp'",
  };
  process.stderr.write(
    `\u001b[31m${causes[mode]}\u001b[0m\nAPI_TOKEN=fixture-sensitive\nAUTH_TOKEN="fixture quoted secret"\n{"access_token":"fixture escaped\\" secret"}\nAuthorization: Bearer fixture-bearer\nhttps://user:fixture-pass@example.com/?api_key=fixture-key\n`,
    () => process.exit(1),
  );
} else {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "recovered-mcp", version: "1.0.0" },
          }
        : request.method === "tools/list"
          ? { tools: [] }
          : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
}
