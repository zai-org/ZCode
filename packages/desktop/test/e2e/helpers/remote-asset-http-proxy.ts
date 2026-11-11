import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RemoteAssetTransfer {
  path: string;
  totalBytes: number;
  sentBytes: number;
  /** 响应完整写完。 */
  completed: boolean;
  /** 客户端在写完前断开（例如 Host 取消了下载）。 */
  aborted: boolean;
}

export interface RemoteAssetHttpProxy {
  proxyUrl: string;
  requestPaths: string[];
  /** 非 JSON 资源（archive）的逐次传输记录。 */
  transfers: RemoteAssetTransfer[];
  /** 限制之后开始的 archive 传输速度；null 为不限速。 */
  setArchiveBytesPerSecond(bytesPerSecond: number | null): void;
  close(): Promise<void>;
}

const THROTTLE_CHUNK_BYTES = 64 * 1024;

export async function startRemoteAssetHttpProxy(options: {
  expectedHost: string;
  mockCdnRoot: string;
}): Promise<RemoteAssetHttpProxy> {
  const requestPaths: string[] = [];
  const transfers: RemoteAssetTransfer[] = [];
  let archiveBytesPerSecond: number | null = null;
  const sockets = new Set<Socket>();
  const mockCdnRoot = resolve(options.mockCdnRoot);
  const server = createServer(async (request, response) => {
    try {
      const target = new URL(request.url ?? "", `http://${request.headers.host ?? "invalid"}`);
      if (target.hostname !== options.expectedHost) {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`Unexpected proxy target: ${target.host}`);
        return;
      }

      requestPaths.push(target.pathname);
      const sourcePath = resolveRemoteAssetSourcePath(mockCdnRoot, target.pathname);
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      const headers = {
        "content-length": String(sourceStat.size),
        "content-type": target.pathname.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      };
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const body = await readFile(sourcePath);
      const rate = archiveBytesPerSecond;
      if (target.pathname.endsWith(".json") || rate === null) {
        response.end(body);
        return;
      }
      // 限速只作用于 archive：按固定块定时写出，模拟慢网下的本机下载；客户端断开即停止。
      const transfer: RemoteAssetTransfer = {
        path: target.pathname,
        totalBytes: body.length,
        sentBytes: 0,
        completed: false,
        aborted: false,
      };
      transfers.push(transfer);
      response.once("close", () => {
        if (!transfer.completed) transfer.aborted = true;
      });
      const intervalMs = Math.max(1, Math.round((THROTTLE_CHUNK_BYTES / rate) * 1000));
      while (transfer.sentBytes < body.length && !response.destroyed) {
        const chunk = body.subarray(transfer.sentBytes, transfer.sentBytes + THROTTLE_CHUNK_BYTES);
        response.write(chunk);
        transfer.sentBytes += chunk.length;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
      }
      if (!response.destroyed) {
        transfer.completed = true;
        response.end();
      }
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    // Bug 原因：Host 的 Undici ProxyAgent 对 HTTP 也使用 CONNECT；旧桩直接断开隧道，无法验证代理下载。
    // 只允许本 case 的假 CDN，并固定转到本地 fixture server，不开放任意目标代理。
    if (request.url !== `${options.expectedHost}:80`) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = createConnection({
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
    });
    sockets.add(upstream);
    upstream.once("close", () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    socket.once("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    requestPaths,
    transfers,
    setArchiveBytesPerSecond(bytesPerSecond) {
      archiveBytesPerSecond = bytesPerSecond;
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

function resolveRemoteAssetSourcePath(mockCdnRoot: string, pathname: string): string {
  const decodedPath = decodeURIComponent(pathname).replace(/^\/+/, "");
  const relativePath = decodedPath.startsWith("components/")
    ? decodedPath
    : join("releases", decodedPath);
  const sourcePath = resolve(mockCdnRoot, relativePath);
  const escaped = relative(mockCdnRoot, sourcePath);
  if (escaped === "" || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
    throw new Error(`Invalid remote asset path: ${pathname}`);
  }
  return sourcePath;
}
