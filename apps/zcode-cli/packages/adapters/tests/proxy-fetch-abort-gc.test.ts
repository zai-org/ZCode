import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";

/** 回收轮数与间隔：让只被弱引用持有的对象真正被释放。 */
const GC_ROUNDS = 5;
const GC_ROUND_INTERVAL_MS = 20;
const SERVER_CLOSE_TIMEOUT_MS = 1_000;
const TEST_CA_PEM = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n";

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

it("closes a long-lived response stream when the caller aborts after garbage collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-proxy-fetch-gc-"));
  const certPath = join(directory, "ca.pem");
  const serverClosed = Promise.withResolvers<void>();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": ready\n\n");
    response.once("close", () => serverClosed.resolve());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    // 配置 CA 文件时请求走 Node http 实现，而不是全局 fetch。
    await writeFile(certPath, TEST_CA_PEM, "utf8");
    const fetch = createNetworkProxyFetch({ caCertFile: certPath });
    const controller = new AbortController();
    const reader = (
      await fetch(`http://127.0.0.1:${port}/stream`, { signal: controller.signal })
    ).body!.getReader();
    await reader.read();
    const pendingRead = reader.read().catch(() => undefined);
    for (let round = 0; round < GC_ROUNDS; round++) {
      collectGarbage();
      await new Promise((resolve) => setTimeout(resolve, GC_ROUND_INTERVAL_MS));
    }
    controller.abort(new Error("test abort"));
    // 修复前只监听内部 Request 的 signal；它经 WeakRef 跟随调用方 signal，
    // Request 被回收后 abort 不再传到 socket，服务端一直收不到关闭。
    const closed = await Promise.race([
      serverClosed.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), SERVER_CLOSE_TIMEOUT_MS)),
    ]);
    expect(closed).toBe(true);
    await pendingRead;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  }
});
