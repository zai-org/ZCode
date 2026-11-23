import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 故障只发生在 HTTP 边界；逐块放行模拟慢网，不用延时猜测产品阶段。 */
export async function startPreinstalledToolsFaultServer(options: {
  resources: Record<string, Buffer>;
  directory: string;
  /** App 的每个下载基址对应一个候选序号；同一资源在不同候选上返回预设的故障方式。 */
  candidates?: Record<string, readonly string[]>;
}) {
  const requests: Array<{ id: number; resource: string; mode: string; range: string | null }> = [];
  const pending = new Map<number, { response: ServerResponse; bytes: Buffer; offset: number }>();
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? "/", "http://fixture.example.test").pathname.split("/");
    if (route[1] === "resources" || route[1] === "candidates") {
      const [resource, mode] =
        route[1] === "resources"
          ? [route[2] ?? "", route[3] ?? ""]
          : [route[3] ?? "", options.candidates?.[route[3] ?? ""]?.[Number(route[2])] ?? ""];
      const bytes = options.resources[resource];
      if (!bytes || !mode) {
        response.writeHead(404).end();
        return;
      }
      const id = requests.length + 1;
      requests.push({ id, resource, mode, range: request.headers.range ?? null });
      if (mode === "http-error") {
        response.writeHead(503).end("unavailable");
        return;
      }
      const body =
        mode === "truncated"
          ? bytes.subarray(0, Math.floor(bytes.length / 2))
          : mode === "oversize"
            ? Buffer.concat([bytes, Buffer.from("x")])
            : bytes;
      response.writeHead(200, {
        "content-length": body.length,
        "content-type": "application/gzip",
        "x-fixture-request": id,
      });
      if (mode === "interrupt" || mode === "slow") {
        const offset = Math.max(1, Math.floor(body.length / (mode === "slow" ? 4 : 2)));
        response.write(body.subarray(0, offset));
        pending.set(id, { response, bytes: body, offset });
        response.once("close", () => pending.delete(id));
      } else response.end(body);
    } else if (route[1] === "release" || route[1] === "step" || route[1] === "break") {
      const transfer = pending.get(Number(route[2]));
      if (!transfer) {
        response.writeHead(404).end();
        return;
      }
      if (route[1] === "break") transfer.response.destroy();
      else {
        const end =
          route[1] === "release"
            ? transfer.bytes.length
            : Math.min(
                transfer.bytes.length,
                transfer.offset + Math.max(1, Math.floor(transfer.bytes.length / 4)),
              );
        transfer.response.write(transfer.bytes.subarray(transfer.offset, end));
        transfer.offset = end;
        if (end === transfer.bytes.length) transfer.response.end();
      }
      response.end("controlled");
    } else if (route[1] === "status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ requests, pending: [...pending.keys()] }));
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("故障服务没有监听地址");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await writeFile(
        join(options.directory, "fault-http-events.json"),
        JSON.stringify({ requests }, null, 2),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
