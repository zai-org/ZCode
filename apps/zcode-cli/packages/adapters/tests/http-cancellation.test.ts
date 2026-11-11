import http from "node:http";
import https from "node:https";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import forge from "node-forge";
import { createMcpAdapter } from "../src/mcp/index.js";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";
import { createNodeHttpClientAdapter } from "../src/http/index.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const DEADLINE_MS = 1_000;

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("connection did not close")), DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function proxyFixture() {
  const server = http.createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function httpsProxyFixture(handler: http.RequestListener) {
  // 固定 TLS 私钥会进入公开源码；临时生成测试密钥，仍走真实 HTTPS 与自定义 CA 验证。
  const { publicKey, privateKey } = await promisify(generateKeyPair)("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey);
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([{ name: "commonName", value: "localhost" }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
  ]);
  certificate.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  const cert = forge.pki.certificateToPem(certificate);
  const directory = await mkdtemp(join(tmpdir(), "zcode-mcp-abort-"));
  const certPath = join(directory, "ca.pem");
  await writeFile(certPath, cert);
  const upstream = https.createServer({ cert, key: privateKey }, handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTPS address");
  const proxy = await proxyFixture();
  proxy.server.on("connect", (_request, socket, head) => {
    const remote = connect({ host: "127.0.0.1", port: address.port }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
    remote.on("error", () => socket.destroy());
  });
  return {
    url: `https://localhost:${address.port}`,
    network: { httpProxy: proxy.url, caCertFile: certPath },
    async close() {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("request cancellation owns transport lifetime", () => {
  it("keeps request errors handled when MCP closes immediately after reading an HTTPS response", async () => {
    const fixture = await httpsProxyFixture((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"error":"no permission"}');
    });
    const fetch = createNetworkProxyFetch(fixture.network);
    try {
      const controller = new AbortController();
      const response = await fetch(`${fixture.url}/mcp`, {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      });
      expect(await response.json()).toEqual({ error: "no permission" });
      // MCP 握手读到错误后在同一轮微任务内关闭 transport；不能插入等待来避开真实竞态。
      controller.abort();
      await setImmediate();
      await setImmediate();
      const next = await fetch(`${fixture.url}/next`);
      expect(await next.json()).toEqual({ error: "no permission" });
    } finally {
      await fixture.close();
    }
  });

  it("keeps a healthy MCP usable after a peer fails its HTTPS handshake", async () => {
    const fixture = await httpsProxyFixture((request, response) => {
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const message = z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string(),
          })
          .parse(JSON.parse(Buffer.concat(chunks).toString()));
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const reply =
          request.url === "/denied"
            ? { error: { code: -32001, message: "no permission" } }
            : message.method === "initialize"
              ? {
                  result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "healthy", version: "1.0.0" },
                  },
                }
              : message.method === "tools/list"
                ? { result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] } }
                : message.method === "tools/call"
                  ? { result: { content: [{ type: "text", text: "pong" }] } }
                  : { error: { code: -32601, message: "Method not found" } };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }));
      });
    });
    const adapter = createMcpAdapter({ network: fixture.network });
    try {
      const healthy = await adapter.connectServer("healthy", {
        type: "http",
        url: `${fixture.url}/healthy`,
      });
      expect(healthy.status).toBe("connected");
      const denied = await adapter.connectServer("denied", {
        type: "http",
        url: `${fixture.url}/denied`,
      });
      expect(denied).toMatchObject({
        status: "failed",
        error: expect.stringContaining("no permission"),
      });
      const result = await adapter.callTool({ serverName: "healthy", toolName: "ping" });
      expect(result.content).toEqual([{ type: "text", text: "pong" }]);
      expect(result.isError).not.toBe(true);
    } finally {
      await adapter.close();
      await fixture.close();
    }
  });

  it.each(["fetch", "http-client"] as const)(
    "%s cancels after CONNECT succeeds without an uncaught socket error",
    async (kind) => {
      const proxy = await proxyFixture();
      const tlsStarted = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      proxy.server.on("connect", (_request, socket) => {
        socket.on("close", () => closed.resolve());
        socket.on("end", () => socket.end());
        socket.once("data", () => tlsStarted.resolve());
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
      const controller = new AbortController();
      const fetch = createNetworkProxyFetch({ httpProxy: proxy.url });
      const client = createNodeHttpClientAdapter({ proxyUrl: proxy.url });
      const pending = (
        kind === "fetch"
          ? fetch("https://upstream.example/pending", { signal: controller.signal })
          : client.request(
              { url: "https://upstream.example/pending" },
              { signal: controller.signal },
            )
      ).catch((error: unknown) => error);
      try {
        await deadline(tlsStarted.promise);
        controller.abort();
        expect(await deadline(pending)).toBeInstanceOf(Error);
        await deadline(closed.promise);
      } finally {
        controller.abort();
        await proxy.close();
        await pending;
      }
    },
  );

  it.each([false, true])(
    "parent abort survives GC, response headers sent: %s",
    async (headersSent) => {
      const proxy = await proxyFixture();
      const received = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      proxy.server.on("request", (request, response) => {
        request.resume();
        response.on("close", () => closed.resolve());
        if (headersSent) {
          response.writeHead(200);
          response.write("first");
        }
        received.resolve();
      });
      const controller = new AbortController();
      const fetch = createNetworkProxyFetch({ httpProxy: proxy.url });
      const pending = fetch("http://upstream.example/stream", { signal: controller.signal })
        .then((response) => response.text())
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      try {
        await deadline(received.promise);
        // 临时 Request 已离开归一化作用域；必须在 GC 后验证真实父信号，而非只测即时 abort。
        for (let round = 0; round < 3; round++) {
          await setImmediate();
          gc();
        }
        controller.abort(new Error("caller cancelled"));
        expect(await deadline(pending)).toBeInstanceOf(Error);
        await deadline(closed.promise);
      } finally {
        await proxy.close();
        await pending;
      }
    },
  );

  it.each(["fetch", "http-client"] as const)(
    "%s closes pending CONNECT without cancelling its peer",
    async (kind) => {
      const proxy = await proxyFixture();
      const connections: Socket[] = [];
      const connected = Promise.withResolvers<void>();
      proxy.server.on("connect", (request, socket) => {
        const index = request.url === "peer-0.example:443" ? 0 : 1;
        connections[index] = socket as Socket;
        socket.resume();
        // CONNECT 升级后的服务端 socket 默认允许半关闭；收到客户端 FIN 后关闭本端。
        socket.on("end", () => socket.end());
        if (connections[0] && connections[1]) connected.resolve();
      });
      const controllers = [new AbortController(), new AbortController()];
      const fetch = createNetworkProxyFetch({ httpProxy: proxy.url });
      const client = createNodeHttpClientAdapter({ proxyUrl: proxy.url });
      const requests = controllers.map((controller, index) =>
        (kind === "fetch"
          ? fetch(`https://peer-${index}.example/pending`, { signal: controller.signal })
          : client.request(
              { url: `https://peer-${index}.example/pending` },
              { signal: controller.signal },
            )
        ).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      try {
        await deadline(connected.promise);
        const closed = connections.map((socket) => once(socket, "close"));
        controllers[0]!.abort();
        expect(await deadline(requests[0]!)).toBeInstanceOf(Error);
        await deadline(closed[0]!);
        expect(connections[1]!.destroyed).toBe(false);
        controllers[1]!.abort();
        expect(await deadline(requests[1]!)).toBeInstanceOf(Error);
        await deadline(closed[1]!);
      } finally {
        controllers.forEach((controller) => controller.abort());
        await proxy.close();
        await Promise.all(requests);
      }
    },
  );

  it("keeps a caller abort after a completed HTTP proxy response handled", async () => {
    const proxy = await proxyFixture();
    const closed = Promise.withResolvers<void>();
    proxy.server.on("request", (request, response) => {
      request.resume();
      request.socket.on("close", () => closed.resolve());
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"type":"error","error":{"type":"invalid_request_error"}}');
    });
    // 回归原因：模型流在失败的尝试结束后才 abort，此时响应已读完。代理 socket 仍绑着调用方的
    // signal，迟到的取消让它报错；ClientRequest 的 error 监听曾随请求结束被移除，agent 进程以
    // uncaughtException 退出。上方 MCP 用例覆盖 HTTPS CONNECT，这里覆盖普通 HTTP 代理。
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    const controller = new AbortController();
    const fetch = createNetworkProxyFetch({ httpProxy: proxy.url });
    try {
      const response = await fetch("http://upstream.example/v1/messages", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      });
      expect(response.status).toBe(400);
      await response.text();
      controller.abort(new Error("attempt ended after the response"));
      await deadline(closed.promise);
      await setImmediate();
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      await proxy.close();
    }
  });
});
