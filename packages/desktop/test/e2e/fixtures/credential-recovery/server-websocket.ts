import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Emitter, VSBuffer, SocketProtocol, type ISocket, type IServerChannel } from "@zcode/rpc";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";

const childMode = process.argv.includes("--stdio-child");
const home = childMode
  ? process.env.ZCODE_DATA_BASE_DIR!
  : await mkdtemp(join(tmpdir(), "credential-rpc-"));
process.env.ZCODE_DATA_BASE_DIR = home;
process.env.ZCODE_DESKTOP_HOME_DIR = home;
const { createHttpServer } = await import("@zcode/server");
const { createStdioServer } = await import("@zcode/server/stdio");
const { createCoreHttpServer } =
  await import("../../../../../zcode-server-cli/src/server-core/http.js");
const { exposeWindowHostAttachmentServices } =
  await import("../../../../src/host/windowHostAttachmentRpcPolicy.js");
const { ServiceCollection, ICredentialService } = await import("@zcode/services");
const { createCredentialService } = await import("@zcode/services/node");
const { connectViaProtocol } = await import("@zcode/client");
const file = join(home, ".zcode", "v2", "credentials.json");
const raw = Buffer.from('{"unfinished":');
const token = "synthetic-ingress-token";

if (childMode) {
  console.log = (...args) => console.error(...args);
  console.info = console.log;
  const server = createStdioServer(
    new ServiceCollection().register(ICredentialService, createCredentialService()),
  );
  await once(process.stdin, "end");
  await server.stop();
  process.exit(0);
}
await mkdir(join(home, ".zcode", "v2"), { recursive: true });

async function snapshot() {
  return {
    bytes: (await readFile(file)).toString("base64"),
    files: await readdir(join(home, ".zcode", "v2")),
    generation: await readFile(`${file}.recovery-generation`, "utf8").catch(() => null),
  };
}
async function check(credential: import("@zcode/services").ICredentialService) {
  await writeFile(file, raw);
  const before = await snapshot();
  const denied: Record<string, string> = {};
  for (const method of ["inspectStore", "recoverStore"] as const) {
    try {
      if (method === "inspectStore") await credential.inspectStore();
      else await credential.recoverStore("0".repeat(64));
      denied[method] = "unexpected-success";
    } catch (error) {
      denied[method] =
        typeof error === "object" && error !== null && "kind" in error
          ? String(error.kind)
          : String(error);
    }
  }
  assert.deepEqual(denied, { inspectStore: "feature_disabled", recoverStore: "feature_disabled" });
  assert.deepEqual(await snapshot(), before);
  await writeFile(file, "{}");
  await credential.save("synthetic", "value");
  assert.equal(await credential.load("synthetic"), "value");
  await credential.delete("synthetic");
  assert.equal(await credential.load("synthetic"), null);
  return { denied, originalAndGenerationUnchanged: true, ordinaryReadWritePreserved: true };
}
async function connect(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (value) => data.fire(VSBuffer.wrap(Buffer.from(value as Buffer))));
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  const protocol = new SocketProtocol({
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write: (value) => ws.send(value.buffer),
    end: () => ws.close(),
    dispose: () => ws.close(),
    drain: async () => {},
  });
  const credential = connectViaProtocol(protocol).credentialService;
  await once(ws, "open");
  return { ws, credential };
}
const results = [];
try {
  for (const publisher of [
    "web-server-public",
    "web-server-authenticated",
    "source-server-core",
  ] as const) {
    const services = new ServiceCollection().register(
      ICredentialService,
      createCredentialService(),
    );
    const core =
      publisher === "source-server-core"
        ? await createCoreHttpServer(services, { host: "127.0.0.1", port: 0, ingressToken: token })
        : undefined;
    const web = !core
      ? createHttpServer(services, 0, {
          host: "127.0.0.1",
          ...(publisher === "web-server-authenticated" ? { authToken: token } : {}),
        })
      : undefined;
    if (web && !web.listening) await once(web, "listening");
    const address = web?.address();
    const port = core?.port ?? (address && typeof address !== "string" ? address.port : 0);
    const base = `http://127.0.0.1:${port}`;
    const auth = publisher === "web-server-public" ? "" : `?token=${token}`;
    const sockets: WebSocket[] = [];
    try {
      const ordinary = await connect(`${base.replace("http:", "ws:")}/ws${auth}`, {
        "x-zcode-client-mode": "desktop-continuous",
      });
      sockets.push(ordinary.ws);
      const direct = await check(ordinary.credential);
      const response = await fetch(`${base}/api/rpc-host-capability${auth}`, { method: "POST" });
      assert.equal(response.status, 200);
      const capability = (await response.json()) as { capability: string };
      const hostHeaders = { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability.capability };
      await assert.rejects(connect(`${base.replace("http:", "ws:")}/ws/host${auth}`), /401/);
      await assert.rejects(
        connect(`${base.replace("http:", "ws:")}/ws/host${auth}`, {
          [ZCODE_RPC_HOST_CAPABILITY_HEADER]: "synthetic-forged-ticket",
        }),
        /401/,
      );
      const elevated = await connect(`${base.replace("http:", "ws:")}/ws/host${auth}`, hostHeaders);
      sockets.push(elevated.ws);
      const selfIssuedCapability = await check(elevated.credential);
      await assert.rejects(
        connect(`${base.replace("http:", "ws:")}/ws/host${auth}`, hostHeaders),
        /401/,
      );
      results.push({
        publisher,
        direct,
        selfIssuedCapability,
        missingAndForgedTicketDenied: true,
        ticketReplayDenied: true,
      });
    } finally {
      sockets.forEach((socket) => socket.close());
      if (core) await core.close();
      if (web) await new Promise<void>((resolve) => web.close(() => resolve()));
    }
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--stdio-child"],
    { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let childError = "";
  child.stderr.on("data", (data) => {
    childError += String(data);
  });
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  child.stdout.on("data", (value) => data.fire(VSBuffer.wrap(value)));
  child.on("close", () => close.fire());
  const socket: ISocket = {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write: (value) => {
      child.stdin.write(value.buffer);
    },
    end: () => child.stdin.end(),
    dispose: () => child.stdin.end(),
    drain: async () => {},
  };
  try {
    results.push({
      publisher: "legacy-stdio",
      ...(await check(connectViaProtocol(new SocketProtocol(socket)).credentialService)),
    });
  } finally {
    child.stdin.end();
    const [code] = await once(child, "exit");
    assert.equal(code, 0, childError);
  }

  const local = createCredentialService();
  for (const [clientMode, kind] of [
    ["desktop-continuous", "local"],
    ["desktop-continuous", "remote"],
    ["desktop-continuous", "source-settings"],
    ["desktop-continuous", undefined],
    ["web-remote-replayable", "local"],
  ] as const) {
    const channels = new Map<string, IServerChannel<unknown>>();
    exposeWindowHostAttachmentServices({
      server: {
        registerChannel: (name, channel) => {
          channels.set(name, channel);
        },
      },
      services: new ServiceCollection().register(ICredentialService, local),
      clientMode,
      ...(kind ? { attachmentScope: { kind } } : {}),
    });
    const channel = channels.get(ICredentialService.channelName)!;
    const credential: import("@zcode/services").ICredentialService = {
      inspectStore: () => channel.call(undefined, "inspectStore", []),
      recoverStore: (fingerprint) => channel.call(undefined, "recoverStore", [fingerprint]),
      load: (key) => channel.call(undefined, "load", [key]),
      save: (key, value) => channel.call(undefined, "save", [key, value]),
      delete: (key) => channel.call(undefined, "delete", [key]),
    };
    if (clientMode === "desktop-continuous" && kind === "local") {
      await writeFile(file, raw);
      const inspection = await credential.inspectStore();
      assert.equal(inspection.status, "corrupt");
      if (inspection.status !== "corrupt") throw new Error("Expected corrupt store");
      const recovered = await credential.recoverStore(inspection.fingerprint);
      assert.equal(recovered.status, "recovered");
      if (recovered.status !== "recovered") throw new Error("Expected recovery");
      assert.deepEqual(await readFile(recovered.backupPath), raw);
      results.push({ publisher: "local-desktop-policy", recoveryPreserved: true });
    } else
      results.push({
        publisher: `attachment-${clientMode}-${kind ?? "unspecified"}`,
        ...(await check(credential)),
      });
  }
  const result = { results, realUserCredentials: false };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await rm(home, { recursive: true, force: true });
}
