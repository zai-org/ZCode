import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import {
  convertToZCodeAgentMcpServer,
  type McpServerConfig as HostMcpServerConfig,
} from "@zcode/shared";
import type { McpPort } from "@zcode/contracts";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("工作区直接 MCP 不得被当作用户可信配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-mcp-trust-"));
  roots.push(root);
  await mkdir(join(root, ".zcode"));
  await writeFile(
    join(root, ".zcode/config.json"),
    JSON.stringify({
      mcp: {
        servers: {
          probe: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] },
        },
      },
    }),
  );
  // 合并后的 MCP 配置由配置源提供，runtime 配置只负责补来源标记与待信任集合。
  const configResult = createConfig({ workingDirectory: root, skipUserConfig: true, env: {} });
  const result = resolveAppRuntimeConfig({
    cliStorageRoot: join(root, "storage"),
    configResult,
    options: {},
    mcpConfiguration: configResult.config.mcp,
    subagentOutputRootDir: join(root, "output"),
    workingDirectory: root,
  });
  expect(result.untrustedProjectMcpServers.has("probe")).toBe(true);
});

import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createMcpAdapter, createMcpAdapterConnectionPool } from "@zcode/adapters/mcp";
import type { McpServerConfig } from "@zcode/contracts";
import { createWorkspaceMcpTrust } from "../src/workspace-mcp-trust/index.js";

async function fixture(exitAfterCall = false) {
  const root = await mkdtemp(join(tmpdir(), "workspace-mcp-runtime-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const userConfigPath = join(root, "user.json");
  const marker = join(root, "started");
  const script = join(root, "server.mjs");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(userConfigPath, JSON.stringify({ storage: { dir: join(root, "user-data") } }));
  await writeFile(
    script,
    `import {writeFile, appendFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
await writeFile(process.argv[2], 'started');
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line); if(r.id===undefined) continue;
 const result=r.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'local-test',version:'1'}}:
 r.method==='tools/list'?{tools:[{name:'probe',description:'local probe',inputSchema:{type:'object'}}]}:
 r.method==='tools/call'?{content:[{type:'text',text:'ok'}]}:{};
 if(r.method==='tools/call') await appendFile(process.argv[2], '\\ncall');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n', () => {
   if (${exitAfterCall} && r.method==='tools/call') process.exit(0);
 });
}`,
  );
  const config: McpServerConfig = {
    type: "stdio",
    command: process.execPath,
    args: [script, marker],
    protocolVersion: "legacy",
    source: { kind: "workspace" },
  };
  async function save(value: McpServerConfig = config) {
    const { source: _source, ...raw } = value;
    await writeFile(
      join(workspace, ".zcode/config.json"),
      JSON.stringify({ mcp: { servers: { probe: raw } } }),
    );
  }
  await save();
  const options = { workingDirectory: workspace, userConfigPath, env: {} };
  return {
    root,
    workspace,
    marker,
    config,
    options,
    save,
    authority: createWorkspaceMcpTrust(options),
  };
}

it("真实 stdio：未信任零进程，授权后握手，撤销在下次连接准入生效", async () => {
  const f = await fixture();
  let pendingCount = 0;
  f.authority = createWorkspaceMcpTrust({
    ...f.options,
    onAdmissionChanged: async (state) => {
      pendingCount = state.pendingCount;
    },
  });
  const port = f.authority.guard(createMcpAdapter());
  try {
    expect((await port.connectServer("probe", f.config)).status).toBe("untrusted");
    await expect(access(f.marker)).rejects.toThrow();
    const review = (await f.authority.inspect()).probe!;
    await f.authority.decide("probe", review.declarationDigest, true);
    expect((await port.connectServer("probe", f.config)).status).toBe("connected");
    expect(await readFile(f.marker, "utf8")).toBe("started");
    expect(await createWorkspaceMcpTrust(f.options).allows("probe", f.config)).toBe(true);
    await port.callTool({ serverName: "probe", toolName: "probe", arguments: {} });
    await f.authority.decide("probe", review.declarationDigest, false);
    await port.refreshWorkspaceTrustAdmission!();
    expect(pendingCount).toBe(1);
    await port.callTool({ serverName: "probe", toolName: "probe" });
    expect(await port.listTools()).toHaveLength(1);
    expect((await port.connectServer("probe", f.config)).status).toBe("untrusted");
    await expect(port.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
    expect(await port.listTools()).toEqual([]);
    expect(await readFile(f.marker, "utf8")).toBe("started\ncall\ncall");
  } finally {
    await port.close();
  }
});

it("连接内工具调用、状态、列表与 ping 不重复读取授权，断开后拒绝调用", async () => {
  const f = await fixture();
  await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
  const check = vi.spyOn(f.authority, "allows");
  const port = f.authority.guard(createMcpAdapter());
  try {
    await port.connectServer("probe", f.config);
    check.mockClear();
    for (let i = 0; i < 3; i++) {
      await port.callTool({ serverName: "probe", toolName: "probe" });
      expect((await port.status()).probe?.status).toBe("connected");
      expect(await port.listTools()).toHaveLength(1);
      expect(await port.pingServer!("probe")).toBe(true);
    }
    expect(check).not.toHaveBeenCalled();
    await port.disconnectServer("probe");
    await expect(port.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
    expect(await readFile(f.marker, "utf8")).toBe("started\ncall\ncall\ncall");
  } finally {
    check.mockRestore();
    await port.close();
  }
});

it("真实断线自动重连沿用会话授权，撤销后新会话准入拒绝", async () => {
  const f = await fixture(true);
  const review = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", review.declarationDigest, true);
  const raw = createMcpAdapter();
  const connects = vi.spyOn(raw, "connectServer");
  const check = vi.spyOn(f.authority, "allows");
  const port = f.authority.guard(raw);
  const restarted = createWorkspaceMcpTrust(f.options).guard(createMcpAdapter());
  try {
    await port.connectServer("probe", f.config);
    check.mockClear();
    await port.callTool({ serverName: "probe", toolName: "probe" });
    // 意外断开后由 adapter 自己恢复；恢复用尽后提交 failed，下一次执行准入再重连。
    await vi.waitFor(async () => {
      expect((await port.status()).probe?.status).toBe("failed");
    });
    await f.authority.decide("probe", review.declarationDigest, false);
    await expect(port.callTool({ serverName: "probe", toolName: "probe" })).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    // 重连由 adapter 内部完成，不再经过端口的 connectServer：按实际连上的状态取证。
    expect(connects).toHaveBeenCalledOnce();
    expect((await port.status()).probe?.status).toBe("connected");
    expect(check).not.toHaveBeenCalled();
    expect((await restarted.connectServer("probe", f.config)).status).toBe("untrusted");
    await expect(restarted.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
  } finally {
    connects.mockRestore();
    check.mockRestore();
    await port.close();
    await restarted.close();
  }
});

it.each(["changed", "removed", "disabled", "corrupt"] as const)(
  "连接后 %s 不影响已批准连接，下次连接准入拒绝",
  async (change) => {
    const f = await fixture();
    await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
    const port = f.authority.guard(createMcpAdapter());
    try {
      await port.connectServer("probe", f.config);
      if (change === "changed") await f.save({ ...f.config, env: { VERSION: "2" } });
      if (change === "disabled") await f.save({ ...f.config, enabled: false });
      if (change === "removed") await writeFile(join(f.workspace, ".zcode/config.json"), "{}");
      if (change === "corrupt")
        await writeFile(join(f.root, "user-data/security/workspace-mcp-trust-v1.json"), "invalid");
      await port.callTool({ serverName: "probe", toolName: "probe" });
      expect((await port.connectServer("probe", f.config)).status).toBe("untrusted");
      await expect(port.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
        "workspace_mcp_pending_trust",
      );
      expect(await readFile(f.marker, "utf8")).toBe("started\ncall");
    } finally {
      await port.close();
    }
  },
);

it("声明变化拒绝旧审核与旧连接配置；enabled 不扩大或清除授权", async () => {
  const f = await fixture();
  const old = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", old.declarationDigest, true);
  await f.save({ ...f.config, enabled: false });
  expect((await f.authority.inspect()).probe?.declarationDigest).toBe(old.declarationDigest);
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  await f.save({ ...f.config, env: { VERSION: "2" } });
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  await expect(f.authority.decide("probe", old.declarationDigest, true)).rejects.toThrow(
    "workspace_mcp_declaration_changed",
  );
  await writeFile(join(f.workspace, ".zcode/config.json"), "{}");
  expect(await f.authority.allows("probe", f.config)).toBe(false);
});

it("HTTP/SSE 未信任不发出任何请求；secret 不进入审核显示或存储", async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const port = f.authority.guard(createMcpAdapter());
  try {
    for (const type of ["http", "sse"] as const) {
      const config: McpServerConfig = {
        type,
        url: `http://127.0.0.1:${address.port}/mcp?token=secret-query`,
        headers: { Authorization: "secret-header" },
        source: { kind: "workspace" },
      };
      await f.save(config);
      expect((await port.connectServer("probe", config)).status).toBe("untrusted");
      const review = (await f.authority.inspect()).probe!;
      expect(review.display).not.toContain("secret");
      await f.authority.decide("probe", review.declarationDigest, true);
      const content = await readFile(
        join(f.root, "user-data/security/workspace-mcp-trust-v1.json"),
        "utf8",
      );
      expect(content).not.toContain("secret");
    }
    expect(requests).toBe(0);
  } finally {
    await port.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it("同名 server 不跨 workspaceIdentity 继承授权，包括连接池 lease 复用", async () => {
  const f = await fixture();
  const other = createWorkspaceMcpTrust({ ...f.options, workspaceIdentity: "remote:other" });
  await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
  const pool = createMcpAdapterConnectionPool({ idleGraceMs: 0 });
  const first = f.authority.guard(pool.acquireLease());
  const second = other.guard(pool.acquireLease());
  try {
    expect((await first.connectServer("probe", f.config)).status).toBe("connected");
    expect((await second.connectServer("probe", f.config)).status).toBe("untrusted");
    expect(await second.listTools()).toEqual([]);
  } finally {
    await first.close();
    await second.close();
    await pool.close();
  }
});

it("损坏授权文件拒绝执行与授权；项目 storage.dir 不改变用户域记录位置", async () => {
  const f = await fixture();
  const review = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", review.declarationDigest, true);
  await writeFile(
    join(f.root, "user-data/security/workspace-mcp-trust-v1.json"),
    '{"schemaVersion":99,"records":[]}',
  );
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  await expect(f.authority.decide("probe", review.declarationDigest, true)).rejects.toThrow();
});

it(".agents 工作区 fallback 也必须单独审核；用户和插件来源不被误拦截", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, ".zcode/config.json"), "{}");
  await mkdir(join(f.workspace, ".agents"));
  const { source: _source, ...raw } = f.config;
  await writeFile(
    join(f.workspace, ".agents/mcp.json"),
    JSON.stringify({ mcpServers: { probe: raw } }),
  );
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  expect((await f.authority.inspect()).probe?.sourcePaths).toEqual([
    join(f.workspace, ".agents/mcp.json"),
  ]);
  for (const kind of ["user", "plugin", "builtin"] as const) {
    expect(await f.authority.allows("probe", { ...f.config, source: { kind } })).toBe(true);
  }
});

it("连接使用审核时的私有配置副本，调用方修改对象不能改变实际 spawn", async () => {
  const f = await fixture();
  await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
  const port = f.authority.guard(createMcpAdapter());
  try {
    const connecting = port.connectServer("probe", f.config);
    if (f.config.type === "stdio") f.config.args = ["-e", "throw new Error('mutated')"];
    expect((await connecting).status).toBe("connected");
    expect(await readFile(f.marker, "utf8")).toBe("started");
  } finally {
    await port.close();
  }
});

it("并发进程批准不同 workspace 时不丢失记录", async () => {
  const f = await fixture();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const moduleUrl = new URL("../src/workspace-mcp-trust/index.ts", import.meta.url).href;
  const script = `const { createWorkspaceMcpTrust } = await import(process.argv[1]);
const authority = createWorkspaceMcpTrust(JSON.parse(process.argv[2]));
await authority.decide('probe', (await authority.inspect()).probe.declarationDigest, true);`;
  await Promise.all(
    ["first", "second"].map((workspaceIdentity) =>
      run(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        moduleUrl,
        JSON.stringify({ ...f.options, workspaceIdentity }),
      ]),
    ),
  );
  const store = JSON.parse(
    await readFile(join(f.root, "user-data/security/workspace-mcp-trust-v1.json"), "utf8"),
  );
  expect(
    store.records.map((record: { workspaceIdentity: string }) => record.workspaceIdentity).sort(),
  ).toEqual(["first", "second"]);
});

it("stdio 审核不显示以命令参数传入的常见密钥", async () => {
  const f = await fixture();
  if (f.config.type !== "stdio") throw new Error("expected stdio");
  await f.save({ ...f.config, args: [...f.config.args!, "--token", "secret-command-argument"] });
  expect((await f.authority.inspect()).probe!.display).not.toContain("secret-command-argument");
});

it("并发连接 mutation 串行收敛，避免新声明映射到旧连接", async () => {
  const f = await fixture();
  f.authority.allows = async () => true;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const raw = createMcpAdapter();
  raw.connectServer = async (_name, config) => {
    active++;
    peak = Math.max(peak, active);
    await barrier;
    active--;
    return {
      status: "connected",
      transport: config.type,
      toolCount: 0,
      updatedAt: new Date().toISOString(),
    };
  };
  const port = f.authority.guard(raw);
  const first = port.connectServer("probe", f.config);
  const second = port.connectServer("probe", f.config);
  await new Promise<void>((done) => setImmediate(done));
  release();
  await Promise.all([first, second]);
  expect(peak).toBe(1);
  await port.close();
});

// 回归：调用等整条变更队列（含其他 server 的连接握手），后台启动或配置热更新期间，
// 调用已连上的 A 要等最慢的 B；等待期间排进新的变更，这次调用还会以 pending_trust 失败。
it("工具调用只等进行中的准入判定，不等其他 server 的连接", async () => {
  const f = await fixture();
  const user = { ...f.config, source: { kind: "user" as const } };
  const handshake = Promise.withResolvers<void>();
  const calls: string[] = [];
  const raw = createMcpAdapter();
  raw.connectConfiguredServers = async () => {
    await handshake.promise;
    return { statuses: {}, tools: [] };
  };
  raw.callTool = async (request) => {
    calls.push(request.serverName);
    return { content: [{ type: "text", text: "ok" }] };
  };
  const port = f.authority.guard(raw);
  try {
    const startup = port.connectConfiguredServers({ fast: user, slow: user });
    await new Promise<void>((done) => setImmediate(done));
    await expect(port.callTool({ serverName: "fast", toolName: "probe" })).resolves.toBeDefined();
    // 排队中的变更不使调用失败：变更开始前调用走当前准入结果。
    const reconcile = port.connectConfiguredServers({ fast: user, slow: user, other: user });
    await expect(port.callTool({ serverName: "fast", toolName: "probe" })).resolves.toBeDefined();
    expect(calls).toEqual(["fast", "fast"]);
    handshake.resolve();
    await Promise.all([startup, reconcile]);
  } finally {
    handshake.resolve();
    await port.close();
  }
});

// 回归：reconcile 先释放工作区 server，等其他 server 握手后再重新连接。只等准入判定时，这段时间到达的
// 调用会落到已释放的连接上失败；它要等这个 server 重新连接后再执行。
it("reconcile 期间调用工作区 server，等它重新连接后执行", async () => {
  const f = await fixture();
  const review = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", review.declarationDigest, true);
  const user = { ...f.config, source: { kind: "user" as const } };
  const connected = new Set<string>();
  const calls: string[] = [];
  let handshake: Promise<void> = Promise.resolve();
  const reconcileStarted = Promise.withResolvers<void>();
  const raw = createMcpAdapter();
  raw.connectConfiguredServers = async (servers) => {
    // 与租约相同：不在新集合里的 server 立即释放，握手结束后才连上。
    for (const name of [...connected]) if (!Object.hasOwn(servers, name)) connected.delete(name);
    if (Object.hasOwn(servers, "slow")) reconcileStarted.resolve();
    await handshake;
    for (const name of Object.keys(servers)) connected.add(name);
    return { statuses: {}, tools: [] };
  };
  raw.connectServer = async (name, config) => {
    connected.add(name);
    return {
      status: "connected",
      transport: config.type,
      toolCount: 0,
      updatedAt: new Date().toISOString(),
    };
  };
  raw.callTool = async (request) => {
    if (!connected.has(request.serverName)) throw new Error(`released: ${request.serverName}`);
    calls.push(request.serverName);
    return { content: [{ type: "text", text: "ok" }] };
  };
  const port = f.authority.guard(raw);
  const gate = Promise.withResolvers<void>();
  try {
    await port.connectConfiguredServers({ probe: f.config, fast: user });
    expect([...connected].sort()).toEqual(["fast", "probe"]);
    handshake = gate.promise;
    const reconcile = port.connectConfiguredServers({ probe: f.config, fast: user, slow: user });
    await reconcileStarted.promise;
    expect(connected.has("probe")).toBe(false);
    const call = port.callTool({ serverName: "probe", toolName: "probe" });
    // 用户来源的 server 不受影响，照常执行。
    await expect(port.callTool({ serverName: "fast", toolName: "probe" })).resolves.toBeDefined();
    gate.resolve();
    await expect(call).resolves.toBeDefined();
    expect(calls).toEqual(["fast", "probe"]);
    await reconcile;
  } finally {
    gate.resolve();
    await port.close();
  }
});

it("准入判定期间到达的调用等判定结束，再按结果执行或拒绝", async () => {
  const f = await fixture();
  const decision = Promise.withResolvers<boolean>();
  vi.spyOn(f.authority, "allows").mockImplementation(() => decision.promise);
  const calls: string[] = [];
  const raw = createMcpAdapter();
  raw.connectConfiguredServers = async () => ({ statuses: {}, tools: [] });
  raw.connectServer = async (_name, config) => ({
    status: "connected",
    transport: config.type,
    toolCount: 0,
    updatedAt: new Date().toISOString(),
  });
  raw.callTool = async (request) => {
    calls.push(request.serverName);
    return { content: [{ type: "text", text: "ok" }] };
  };
  const port = f.authority.guard(raw);
  try {
    const startup = port.connectConfiguredServers({ probe: f.config });
    await new Promise<void>((done) => setImmediate(done));
    const call = port.callTool({ serverName: "probe", toolName: "probe" });
    await new Promise<void>((done) => setImmediate(done));
    expect(calls).toEqual([]);
    decision.resolve(true);
    await expect(call).resolves.toBeDefined();
    expect(calls).toEqual(["probe"]);
    await startup;
  } finally {
    decision.resolve(false);
    await port.close();
  }
});

it.each(["single", "configured"])("%s 准入未完成时，工具列表只查内存且默认拒绝", async (mode) => {
  const f = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const check = vi.spyOn(f.authority, "allows").mockImplementation(async () => {
    await barrier;
    return false;
  });
  const raw = createMcpAdapter();
  raw.listTools = async () => [{ serverName: "probe", toolName: "probe", inputSchema: {} }];
  const port = f.authority.guard(raw);
  const connecting =
    mode === "single"
      ? port.connectServer("probe", f.config)
      : port.connectConfiguredServers({ probe: f.config });
  try {
    await new Promise<void>((done) => setImmediate(done));
    const listing = port.listTools();
    await new Promise<void>((done) => setImmediate(done));
    release();
    expect(await listing).toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);
    await connecting;
  } finally {
    release();
    await connecting;
    check.mockRestore();
    await port.close();
  }
});

it.each(["single", "configured"])("关闭 lease 后，迟到的 %s 准入结果不能启动连接", async (mode) => {
  const f = await fixture();
  let resolveAllowed!: (value: boolean) => void;
  f.authority.allows = () =>
    new Promise<boolean>((resolve) => {
      resolveAllowed = resolve;
    });
  const raw = createMcpAdapter();
  let connects = 0;
  raw.connectServer = async (_name, config) => {
    connects++;
    return {
      status: "connected",
      transport: config.type,
      toolCount: 0,
      updatedAt: new Date().toISOString(),
    };
  };
  raw.connectConfiguredServers = async () => {
    connects++;
    return { statuses: {}, tools: [] };
  };
  const port = f.authority.guard(raw);
  const pending = (
    mode === "single"
      ? port.connectServer("probe", f.config)
      : port.connectConfiguredServers({ probe: f.config })
  ).catch(() => undefined);
  await new Promise<void>((done) => setImmediate(done));
  resolveAllowed(true);
  queueMicrotask(() => {
    void port.close();
  });
  await pending;
  expect(connects).toBe(0);
});

it("HTTP URL、header 与 OAuth 凭据的变化都使原授权失效", async () => {
  const f = await fixture();
  const original: McpServerConfig = {
    type: "http",
    url: "https://mcp.example.test/one",
    headers: { Authorization: "first" },
    oauth: { type: "client_credentials", clientId: "client", clientSecret: "first" },
    source: { kind: "workspace" },
  };
  await f.save(original);
  const review = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", review.declarationDigest, true);
  for (const config of [
    { ...original, url: "https://mcp.example.test/two" },
    { ...original, headers: { Authorization: "second" } },
    {
      ...original,
      oauth: { type: "client_credentials" as const, clientId: "client", clientSecret: "second" },
    },
  ]) {
    await f.save(config);
    expect((await f.authority.inspect()).probe!.declarationDigest).not.toBe(
      review.declarationDigest,
    );
    expect(await f.authority.allows("probe", config)).toBe(false);
    expect(await f.authority.allows("probe", original)).toBe(false);
  }
});

it.each(["environment", "windows-command", "isolation"])(
  "审核与 Host DTO 对 %s 使用相同执行配置，真实字段变化仍拒绝",
  async (variant) => {
    const f = await fixture();
    const raw: HostMcpServerConfig = {
      type: "stdio",
      command: variant === "windows-command" ? "cmd" : "node",
      args: variant === "windows-command" ? ["/c", "npx", "example-mcp"] : ["server.mjs"],
      ...(variant === "environment" ? { environment: { EXAMPLE_TOKEN: "fake-value" } } : {}),
      ...(variant === "isolation" ? { isolation: "session" } : {}),
    };
    await writeFile(
      join(f.workspace, ".zcode/config.json"),
      JSON.stringify({ mcp: { servers: { probe: raw } } }),
    );
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      if (variant === "windows-command")
        Object.defineProperty(process, "platform", { value: "win32" });
      const review = (await f.authority.inspect()).probe;
      expect(review).toBeDefined();
      await f.authority.decide("probe", review!.declarationDigest, true);
      const dto = convertToZCodeAgentMcpServer("probe", raw, "workspace")!;
      const runtime = protocolMcpServersToRuntimeMcpConfig([dto])!.servers.probe!;
      if (variant === "environment")
        expect(runtime).toMatchObject({ env: { EXAMPLE_TOKEN: "fake-value" } });
      if (variant === "windows-command")
        expect(runtime).toMatchObject({ command: "npx", args: ["example-mcp"] });
      expect(await f.authority.allows("probe", runtime)).toBe(true);
      expect(
        await f.authority.allows("probe", { ...runtime, command: "different" } as McpServerConfig),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);

it("空项目 MCP map 使用 fallback；坏邻项不阻止有效声明审核", async () => {
  const f = await fixture();
  await writeFile(
    join(f.workspace, ".zcode/config.json"),
    JSON.stringify({ mcp: { servers: {} } }),
  );
  await mkdir(join(f.workspace, ".agents"));
  const { source: _source, ...config } = f.config;
  await writeFile(
    join(f.workspace, ".agents/mcp.json"),
    JSON.stringify({
      mcpServers: {
        probe: config,
        invalid: { command: "fake", description: "metadata not accepted by the execution schema" },
      },
    }),
  );
  const reviews = await f.authority.inspect();
  expect(Object.keys(reviews)).toEqual(["probe"]);
  await f.authority.decide("probe", reviews.probe!.declarationDigest, true);
  expect(await f.authority.allows("probe", f.config)).toBe(true);
  expect(await f.authority.allows("invalid", { type: "stdio", command: "fake" })).toBe(false);
  await f.save();
  expect(await f.authority.allows("probe", f.config)).toBe(false);
});

it("项目配置损坏时保留 headless 用户来源，工作区声明仍拒绝", async () => {
  const f = await fixture();
  await writeFile(
    f.options.userConfigPath,
    JSON.stringify({
      storage: { dir: join(f.root, "user-data") },
      mcp: { servers: { user_probe: { type: "stdio", command: "fake" } } },
    }),
  );
  await writeFile(join(f.workspace, ".zcode/config.json"), "{broken");
  const configResult = createConfig(f.options);
  const runtime = resolveAppRuntimeConfig({
    cliStorageRoot: join(f.root, "user-data"),
    configResult,
    options: {},
    mcpConfiguration: configResult.config.mcp,
    subagentOutputRootDir: join(f.root, "output"),
    workingDirectory: f.workspace,
  });
  const configured = runtime.runtimeConfig.mcp?.servers ?? {};
  expect(configured.user_probe?.source).toEqual({ kind: "user" });
  expect(await f.authority.allows("user_probe", configured.user_probe!)).toBe(true);
  expect(await f.authority.inspect()).toEqual({});
  expect(await f.authority.allows("probe", f.config)).toBe(false);
});

it("未信任邻项和撤销均不能阻止 MCP App 订阅释放", async () => {
  const f = await fixture();
  const subscribers = new Set<string>();
  const raw = {
    async connectServer() {
      return {
        status: "connected",
        transport: "stdio",
        toolCount: 0,
        updatedAt: new Date().toISOString(),
      };
    },
    async disconnectServer() {},
    async subscribeResource(request: { subscriberKey: string }) {
      subscribers.add(request.subscriberKey);
    },
    async unsubscribeResourcesBySubscriber(prefix: string) {
      let released = 0;
      for (const key of subscribers)
        if (key.startsWith(prefix)) {
          subscribers.delete(key);
          released++;
        }
      return released;
    },
  } as unknown as McpPort;
  const port = f.authority.guard(raw);
  await port.connectServer("user", { type: "stdio", command: "fake", source: { kind: "user" } });
  await port.subscribeResource!({
    serverName: "user",
    uri: "example://resource",
    subscriberKey: "session|app|first",
  });
  await port.connectServer("probe", f.config);
  expect(await port.unsubscribeResourcesBySubscriber!("session|app|")).toBe(1);
  const digest = (await f.authority.inspect()).probe!.declarationDigest;
  await f.authority.decide("probe", digest, true);
  await port.connectServer("probe", f.config);
  await port.subscribeResource!({
    serverName: "probe",
    uri: "example://resource",
    subscriberKey: "session|app|second",
  });
  await f.authority.decide("probe", digest, false);
  expect(await port.unsubscribeResourcesBySubscriber!("session|app|")).toBe(1);
  expect(subscribers.size).toBe(0);
});

it("会话准入提示只包含启用且未信任的声明，授权与撤销刷新但不连接", async () => {
  const f = await fixture();
  const states: Array<{ pendingCount: number; bundleDigest: string; workspaceIdentity?: string }> =
    [];
  const authority = createWorkspaceMcpTrust({
    ...f.options,
    onAdmissionChanged: async (state) => {
      states.push(state);
    },
  });
  const port = authority.guard(createMcpAdapter());
  try {
    await port.refreshWorkspaceTrustAdmission!();
    await port.refreshWorkspaceTrustAdmission!();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ pendingCount: 1, workspaceIdentity: f.workspace });
    const firstDigest = states[0]!.bundleDigest;
    await port.refreshWorkspaceTrustAdmission!(true);
    expect(states).toHaveLength(2);
    await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
    await port.refreshWorkspaceTrustAdmission!();
    expect(states.at(-1)?.pendingCount).toBe(0);
    await expect(access(f.marker)).rejects.toThrow();
    await f.save({ ...f.config, env: { EXAMPLE: "changed" } });
    await port.refreshWorkspaceTrustAdmission!();
    expect(states.at(-1)?.pendingCount).toBe(1);
    expect(states.at(-1)?.bundleDigest).not.toBe(firstDigest);
    await f.save({ ...f.config, enabled: false });
    await port.refreshWorkspaceTrustAdmission!();
    expect(states.at(-1)?.pendingCount).toBe(0);
    expect(JSON.stringify(states)).not.toContain("changed");
    await port.close();
    const count = states.length;
    await port.refreshWorkspaceTrustAdmission!();
    expect(states).toHaveLength(count);
  } finally {
    await port.close();
  }
});

it("准入事件发布串行，授权后的刷新不会被旧 pending 结果覆盖", async () => {
  const f = await fixture();
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const states: number[] = [];
  const port = createWorkspaceMcpTrust({
    ...f.options,
    onAdmissionChanged: async (state) => {
      if (states.length === 0) {
        publishing.resolve();
        await release.promise;
      }
      states.push(state.pendingCount);
    },
  }).guard(createMcpAdapter());
  try {
    const first = port.refreshWorkspaceTrustAdmission!();
    await publishing.promise;
    await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
    const second = port.refreshWorkspaceTrustAdmission!();
    release.resolve();
    await Promise.all([first, second]);
    expect(states).toEqual([1, 0]);
  } finally {
    release.resolve();
    await port.close();
  }
});

import type { ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, PluginLoadOutcome } from "@zcode/contracts";
import { createAppMcpConfigurationSource } from "../src/app/dynamic-mcp-config.js";

/** 会话的实际路径：动态配置源读盘 → 工作区 guard → 真实 stdio adapter。 */
async function connectSessionSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const configResult: ConfigResult = createConfig(f.options);
  const source = await createAppMcpConfigurationSource({
    options: { env: {}, skipUserConfig: true, pluginStorageRoot: join(f.root, "plugins") },
    configResult,
    runtimeFeatures: {} as AgentRuntimeConfig["runtimeFeatures"],
    pluginOutcome: { plugins: [] } as unknown as PluginLoadOutcome,
    builtInMcpServers: {},
    cliStorageRoot: join(f.root, "user-data"),
    workingDirectory: f.workspace,
    logger: { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
  });
  const port = f.authority.guard(createMcpAdapter());
  try {
    const { servers } = source.getSnapshot();
    const { statuses } = await port.connectConfiguredServers(servers, {
      workingDirectory: f.workspace,
    });
    return { servers, statuses };
  } finally {
    source.close();
    await port.close();
  }
}

it("会话配置源里的项目 plugins.dirs 与 .agents 回退都不能绕过工作区信任", async () => {
  // 修复前：动态加载器原样合并项目 plugins.dirs，也不给磁盘 server 标来源；
  // guard 找不到项目声明时放行，未信任工作区里的命令被执行。
  const f = await fixture();
  const { source: _source, ...raw } = f.config;
  const plugin = join(f.root, "evil-plugin");
  await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(plugin, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "evil", mcpServers: { pwn: raw } }),
  );
  await writeFile(
    join(f.workspace, ".zcode/config.json"),
    JSON.stringify({ plugins: { dirs: [plugin] } }),
  );
  // zcode.json 已声明 server，guard 不把 .agents/mcp.json 计为声明；
  // 加载器仍因 .zcode/config.json 没有 server 读取这个回退。
  await writeFile(
    join(f.workspace, "zcode.json"),
    JSON.stringify({
      mcp: { servers: { benign: { type: "stdio", command: "fake", enabled: false } } },
    }),
  );
  await mkdir(join(f.workspace, ".agents"));
  await writeFile(
    join(f.workspace, ".agents/mcp.json"),
    JSON.stringify({ mcpServers: { probe: raw } }),
  );
  const { servers, statuses } = await connectSessionSnapshot(f);
  expect(servers["plugin:evil:pwn"]).toBeUndefined();
  expect(servers.probe?.source).toEqual({ kind: "workspace" });
  expect(statuses.probe?.status).toBe("untrusted");
  await expect(access(f.marker)).rejects.toThrow();
});
