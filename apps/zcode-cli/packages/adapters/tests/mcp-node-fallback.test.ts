import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { createMcpAdapter } from "../src/mcp/index.js";
import {
  applyMcpNodeFallbackEnv,
  createMcpNodeFallbackProvider,
  ensureNodeFallbackShimDir,
  NODE_FALLBACK_EXEC_PATH_ENV_KEY,
  NODE_FALLBACK_NPM_ROOT_ENV_KEY,
  renderNodeFallbackShims,
  resolveBundledNpmRoot,
} from "../src/mcp/node-fallback.js";

const execFileAsync = promisify(execFile);
const isPosix = process.platform !== "win32";
// 测试机没有 Electron：用当前 Node 冒充“Electron 可执行文件”。shim 只关心它能执行 JS，
// ELECTRON_RUN_AS_NODE 对真实 Node 无副作用。
const fakeElectronExecPath = process.execPath;
// 模拟“用户机器没有装 Node”：PATH 只有一个不存在的目录。shim 只依赖绝对路径
// （/bin/sh、/usr/bin/env），所以 Linux CI 上即便 /usr/bin/node 存在，用例也不会误绿。
const POSIX_PATH_WITHOUT_NODE = join(tmpdir(), "zcode-node-fallback-empty-path");
const runningNodeNpmRoot = resolveRunningNodeNpmRoot();

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function createLoggerSpy() {
  const info = vi.fn();
  const warn = vi.fn();
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info,
    warn,
  } as unknown as Logger;
  return { info, logger, warn };
}

async function writeFakeNpmPackage(root: string): Promise<string> {
  const npmRoot = join(root, "npm");
  await mkdir(join(npmRoot, "bin"), { recursive: true });
  await writeFile(join(npmRoot, "bin", "npm-cli.js"), "console.log('fake npm');\n");
  await writeFile(join(npmRoot, "bin", "npx-cli.js"), "console.log('fake npx');\n");
  return npmRoot;
}

describe("renderNodeFallbackShims", () => {
  it("renders static POSIX shims that read the exec path and npm root from env", () => {
    const shims = renderNodeFallbackShims("darwin");

    expect(shims.map((shim) => shim.name)).toEqual(["node", "npm", "npx"]);
    for (const shim of shims) {
      expect(shim.executable).toBe(true);
      expect(shim.content.startsWith("#!/bin/sh\n")).toBe(true);
      expect(shim.content).toContain(NODE_FALLBACK_EXEC_PATH_ENV_KEY);
      expect(shim.content).toContain("ELECTRON_RUN_AS_NODE=1");
      expect(shim.content).toContain("exit 127");
      // 内容不能带机器路径，否则 AppImage 每次挂载点不同会生成新目录。
      expect(shim.content).not.toContain(fakeElectronExecPath);
    }
    const npx = shims.find((shim) => shim.name === "npx")!;
    expect(npx.content).toContain(NODE_FALLBACK_NPM_ROOT_ENV_KEY);
    expect(npx.content).toContain("/bin/npx-cli.js");
    expect(npx.content).toContain("npm_config_update_notifier");
    const node = shims.find((shim) => shim.name === "node")!;
    expect(node.content).not.toContain(NODE_FALLBACK_NPM_ROOT_ENV_KEY);
  });

  it("renders Windows batch shims with CRLF line endings", () => {
    const shims = renderNodeFallbackShims("win32");

    expect(shims.map((shim) => shim.name)).toEqual(["node.cmd", "npm.cmd", "npx.cmd"]);
    for (const shim of shims) {
      expect(shim.executable).toBe(false);
      expect(shim.content.startsWith("@echo off\r\n")).toBe(true);
      expect(shim.content.replaceAll("\r\n", "")).not.toContain("\n");
      expect(shim.content).toContain(`"%${NODE_FALLBACK_EXEC_PATH_ENV_KEY}%"`);
      expect(shim.content).toContain('set "ELECTRON_RUN_AS_NODE=1"');
      expect(shim.content).toContain("exit /b 127");
    }
    const npm = shims.find((shim) => shim.name === "npm.cmd")!;
    expect(npm.content).toContain(`"%${NODE_FALLBACK_NPM_ROOT_ENV_KEY}%\\bin\\npm-cli.js" %*`);
  });
});

describe("ensureNodeFallbackShimDir", () => {
  it("writes the shims once and leaves identical files untouched", async () => {
    const binDir = join(await makeTempRoot("zcode-node-fallback-"), "bin");

    await ensureNodeFallbackShimDir(binDir, process.platform);
    const shims = renderNodeFallbackShims(process.platform);
    const firstStats = await Promise.all(shims.map((shim) => stat(join(binDir, shim.name))));
    await ensureNodeFallbackShimDir(binDir, process.platform);
    const secondStats = await Promise.all(shims.map((shim) => stat(join(binDir, shim.name))));

    for (const [index, shim] of shims.entries()) {
      expect(await readFile(join(binDir, shim.name), "utf8")).toBe(shim.content);
      expect(secondStats[index]!.ino).toBe(firstStats[index]!.ino);
      expect(secondStats[index]!.mtimeMs).toBe(firstStats[index]!.mtimeMs);
    }
  });

  it("repairs changed content and lost exec bits", async () => {
    const binDir = join(await makeTempRoot("zcode-node-fallback-"), "bin");
    await ensureNodeFallbackShimDir(binDir, process.platform);
    const [firstShim] = renderNodeFallbackShims(process.platform);
    const shimPath = join(binDir, firstShim!.name);
    await writeFile(shimPath, "corrupted");
    if (isPosix) await chmod(shimPath, 0o644);

    await ensureNodeFallbackShimDir(binDir, process.platform);

    expect(await readFile(shimPath, "utf8")).toBe(firstShim!.content);
    if (isPosix) expect((await stat(shimPath)).mode & 0o111).toBe(0o111);
  });

  it("is safe when several agents prepare the same directory at once", async () => {
    const binDir = join(await makeTempRoot("zcode-node-fallback-"), "bin");

    await Promise.all(
      Array.from({ length: 8 }, () => ensureNodeFallbackShimDir(binDir, process.platform)),
    );

    for (const shim of renderNodeFallbackShims(process.platform)) {
      expect(await readFile(join(binDir, shim.name), "utf8")).toBe(shim.content);
    }
  });
});

describe("resolveBundledNpmRoot", () => {
  it("returns the first candidate that has both npm entry files", async () => {
    const root = await makeTempRoot("zcode-node-fallback-npm-");
    const incomplete = join(root, "incomplete");
    await mkdir(join(incomplete, "bin"), { recursive: true });
    await writeFile(join(incomplete, "bin", "npm-cli.js"), "");
    const complete = await writeFakeNpmPackage(join(root, "complete"));
    const later = await writeFakeNpmPackage(join(root, "later"));

    await expect(
      resolveBundledNpmRoot([join(root, "missing"), incomplete, complete, later]),
    ).resolves.toBe(complete);
    await expect(resolveBundledNpmRoot([join(root, "missing"), incomplete])).resolves.toBe(
      undefined,
    );
  });
});

describe("applyMcpNodeFallbackEnv", () => {
  const fallback = {
    binDir: "/storage/node-fallback/v1",
    env: {
      [NODE_FALLBACK_EXEC_PATH_ENV_KEY]: "/Applications/ZCode.app/Helper",
      [NODE_FALLBACK_NPM_ROOT_ENV_KEY]: "/Applications/ZCode.app/npm",
    },
  };

  it("appends the shim directory last so the user's commands win", () => {
    expect(applyMcpNodeFallbackEnv({ PATH: "/usr/bin:/bin" }, fallback, "darwin")).toEqual({
      PATH: "/usr/bin:/bin:/storage/node-fallback/v1",
      ...fallback.env,
    });
  });

  it("does not add the shim directory twice", () => {
    const env = { PATH: "/usr/bin:/storage/node-fallback/v1" };

    expect(applyMcpNodeFallbackEnv(env, fallback, "linux").PATH).toBe(env.PATH);
  });

  describe("on Windows", () => {
    const winFallback = { ...fallback, binDir: "C:\\Users\\dev\\.zcode\\node-fallback\\v1" };
    const hostPath = "C:\\Windows\\System32";

    // 复现真实链路：MCP SDK StdioClientTransport 以 `{ PATH: process.env.PATH, ...env }` spawn；
    // cross-spawn（path-key）按插入顺序取最后一个 PATH 键解析命令；Node 在 win32 上把 env 键排序后
    // 同名（大小写不敏感）只保留第一个传给子进程。两者都必须看到 shim 目录。
    function win32PathsSeenBySpawn(env: Record<string, string>) {
      const spawnEnv: Record<string, string> = { PATH: hostPath, ...env };
      const pathKeys = Object.keys(spawnEnv).filter((key) => key.toUpperCase() === "PATH");
      return {
        commandLookup: spawnEnv[pathKeys.at(-1)!],
        childProcess: spawnEnv[[...pathKeys].sort()[0]!],
      };
    }

    it("writes one PATH key so the SDK's default PATH cannot shadow the shim directory", () => {
      const env = applyMcpNodeFallbackEnv({ Path: hostPath }, winFallback, "win32");

      expect(env).toEqual({ PATH: `${hostPath};${winFallback.binDir}`, ...fallback.env });
      expect(win32PathsSeenBySpawn(env)).toEqual({
        childProcess: `${hostPath};${winFallback.binDir}`,
        commandLookup: `${hostPath};${winFallback.binDir}`,
      });
    });

    it("builds on the server's PATH when the host Path and a server PATH both exist", () => {
      const env = applyMcpNodeFallbackEnv(
        { Path: hostPath, PATH: "C:\\plugin\\bin" },
        winFallback,
        "win32",
      );

      expect(env).toEqual({ PATH: `C:\\plugin\\bin;${winFallback.binDir}`, ...fallback.env });
      expect(win32PathsSeenBySpawn(env).childProcess).toBe(`C:\\plugin\\bin;${winFallback.binDir}`);
    });

    it("compares entries case-insensitively", () => {
      expect(
        applyMcpNodeFallbackEnv(
          { Path: "c:\\users\\dev\\.zcode\\node-fallback\\v1\\" },
          winFallback,
          "win32",
        ),
      ).toEqual({ PATH: "c:\\users\\dev\\.zcode\\node-fallback\\v1\\", ...fallback.env });
    });
  });

  it("uses the shim directory as PATH when the env has none", () => {
    expect(applyMcpNodeFallbackEnv({}, fallback, "linux").PATH).toBe(fallback.binDir);
  });

  it("returns the env unchanged without a fallback", () => {
    const env = { PATH: "/usr/bin" };

    expect(applyMcpNodeFallbackEnv(env, undefined, "linux")).toBe(env);
  });
});

describe("node fallback preparation inside the connection budget", () => {
  const hungFallback = { resolve: () => new Promise<never>(() => undefined) };
  const stdioConfig = { args: ["server.js"], command: "node", type: "stdio" as const };

  it("fails the connection when preparation outlasts the connection timeout", async () => {
    const adapter = createMcpAdapter({ nodeFallback: hungFallback });

    try {
      await expect(
        adapter.connectServer("hung", { ...stdioConfig, timeoutMs: 50 }),
      ).resolves.toMatchObject({
        error: expect.stringContaining("node fallback preparation timed out"),
        status: "failed",
      });
    } finally {
      await adapter.close();
    }
  });

  // 调用方 signal 只取消自己的等待：共享连接继续准备，由它自己的预算决定成败。
  it("returns the current status when the caller cancels during preparation", async () => {
    const adapter = createMcpAdapter({ nodeFallback: hungFallback });
    const controller = new AbortController();

    try {
      const connecting = adapter.connectServer(
        "hung",
        { ...stdioConfig, timeoutMs: 60_000 },
        { signal: controller.signal },
      );
      controller.abort(new Error("cancelled by caller"));
      expect(await connecting).toMatchObject({ status: "connecting" });
      expect((await adapter.status()).hung).toMatchObject({ status: "connecting" });
    } finally {
      await adapter.close();
    }
  });
});

describe("createMcpNodeFallbackProvider", () => {
  it("prepares the shim directory once and reports the bundled npm", async () => {
    const root = await makeTempRoot("zcode-node-fallback-provider-");
    const npmRoot = await writeFakeNpmPackage(root);
    const { info, logger, warn } = createLoggerSpy();
    const provider = createMcpNodeFallbackProvider({
      execPath: fakeElectronExecPath,
      logger,
      npmRootCandidates: [join(root, "missing"), npmRoot],
      storageRoot: join(root, "storage"),
    });

    const [first, second] = await Promise.all([provider.resolve(), provider.resolve()]);

    expect(second).toBe(first);
    expect(first).toEqual({
      binDir: join(root, "storage", "node-fallback", "v1"),
      env: {
        [NODE_FALLBACK_EXEC_PATH_ENV_KEY]: fakeElectronExecPath,
        [NODE_FALLBACK_NPM_ROOT_ENV_KEY]: npmRoot,
      },
    });
    expect(existsSync(join(first!.binDir, isPosix ? "node" : "node.cmd"))).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "MCP node fallback ready",
      expect.objectContaining({ event: "mcp.node_fallback.ready", hasNpm: true }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("omits the npm root when no bundled npm is found", async () => {
    const root = await makeTempRoot("zcode-node-fallback-provider-");
    const provider = createMcpNodeFallbackProvider({
      execPath: fakeElectronExecPath,
      npmRootCandidates: [join(root, "missing")],
      storageRoot: root,
    });

    await expect(provider.resolve()).resolves.toEqual({
      binDir: join(root, "node-fallback", "v1"),
      env: { [NODE_FALLBACK_EXEC_PATH_ENV_KEY]: fakeElectronExecPath },
    });
  });

  it("logs one warning and disables the fallback when the directory cannot be written", async () => {
    const root = await makeTempRoot("zcode-node-fallback-provider-");
    // storageRoot 是普通文件：mkdir 必然失败。
    const blockedStorageRoot = join(root, "file");
    await writeFile(blockedStorageRoot, "");
    const { logger, warn } = createLoggerSpy();
    const provider = createMcpNodeFallbackProvider({
      execPath: fakeElectronExecPath,
      logger,
      npmRootCandidates: [],
      storageRoot: blockedStorageRoot,
    });

    await expect(provider.resolve()).resolves.toBeUndefined();
    await expect(provider.resolve()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "MCP node fallback unavailable",
      expect.objectContaining({ event: "mcp.node_fallback.unavailable" }),
    );
  });
});

describe.runIf(isPosix)("node fallback shims (real processes)", () => {
  async function prepareShims(npmRoot?: string) {
    const root = await makeTempRoot("zcode-node-fallback-run-");
    const fallback = await createMcpNodeFallbackProvider({
      execPath: fakeElectronExecPath,
      npmRootCandidates: npmRoot ? [npmRoot] : [],
      storageRoot: root,
    }).resolve();
    const env = applyMcpNodeFallbackEnv({ HOME: root, PATH: POSIX_PATH_WITHOUT_NODE }, fallback);
    return { env, root };
  }

  it("runs a node script through the shim when PATH has no node", async () => {
    const { env } = await prepareShims();

    const { stdout } = await execFileAsync(
      "node",
      ["-e", "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE + ':' + process.argv[1])", "x"],
      { env },
    );

    expect(stdout).toBe("1:x");
  });

  it("resolves #!/usr/bin/env node scripts through the shim", async () => {
    const { env, root } = await prepareShims();
    const scriptPath = join(root, "tool.js");
    await writeFile(scriptPath, "#!/usr/bin/env node\nprocess.stdout.write('shebang-ok');\n");
    await chmod(scriptPath, 0o755);

    const { stdout } = await execFileAsync(scriptPath, [], { env });

    expect(stdout).toBe("shebang-ok");
  });

  it("propagates the script exit code", async () => {
    const { env } = await prepareShims();

    await expect(execFileAsync("node", ["-e", "process.exit(7)"], { env })).rejects.toMatchObject({
      code: 7,
    });
  });

  it("exits 127 with a clear message when the exec path variable is missing", async () => {
    const { env } = await prepareShims();
    delete env[NODE_FALLBACK_EXEC_PATH_ENV_KEY];

    await expect(execFileAsync("node", ["-v"], { env })).rejects.toMatchObject({
      code: 127,
      stderr: expect.stringContaining(NODE_FALLBACK_EXEC_PATH_ENV_KEY),
    });
  });

  it("fails npx with a clear message when no bundled npm exists", async () => {
    const { env } = await prepareShims();

    await expect(execFileAsync("npx", ["--version"], { env })).rejects.toMatchObject({
      code: 127,
      stderr: expect.stringContaining(NODE_FALLBACK_NPM_ROOT_ENV_KEY),
    });
  });

  it.runIf(runningNodeNpmRoot !== undefined)(
    "runs the real npm and npx packages through the shims",
    async () => {
      const { env } = await prepareShims(runningNodeNpmRoot);

      const npm = await execFileAsync("npm", ["--version"], { env });
      const npx = await execFileAsync("npx", ["--version"], { env });

      expect(npm.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(npx.stdout.trim()).toBe(npm.stdout.trim());
    },
  );

  it("connects a stdio MCP server with command node through the fallback", async () => {
    const root = await makeTempRoot("zcode-node-fallback-mcp-");
    const serverPath = join(root, "server.mjs");
    const mcpServerModule = import.meta.resolve("@modelcontextprotocol/server");
    const stdioServerTransportModule = import.meta.resolve("@modelcontextprotocol/server/stdio");
    await writeFile(
      serverPath,
      [
        `import { McpServer } from ${JSON.stringify(mcpServerModule)};`,
        `import { StdioServerTransport } from ${JSON.stringify(stdioServerTransportModule)};`,
        "const server = new McpServer({ name: 'node-fallback-test', version: '1.0.0' });",
        "server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));",
        "await server.connect(new StdioServerTransport());",
      ].join("\n"),
    );
    const adapter = createMcpAdapter({
      env: { HOME: root, PATH: POSIX_PATH_WITHOUT_NODE },
      nodeFallback: createMcpNodeFallbackProvider({
        execPath: fakeElectronExecPath,
        npmRootCandidates: [],
        storageRoot: root,
      }),
    });

    try {
      await expect(
        adapter.connectServer("fallback", {
          args: [serverPath],
          command: "node",
          timeoutMs: 10_000,
          type: "stdio",
        }),
      ).resolves.toMatchObject({ status: "connected" });
    } finally {
      await adapter.close();
    }
  });
});

/** 当前 Node 安装自带的 npm（nvm / mise / 官方安装包布局）；没有时跳过真实 npm 用例。 */
function resolveRunningNodeNpmRoot(): string | undefined {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "..", "lib", "node_modules", "npm"),
    join(nodeDir, "node_modules", "npm"),
  ];
  return candidates.find(
    (candidate) =>
      existsSync(join(candidate, "bin", "npm-cli.js")) &&
      existsSync(join(candidate, "bin", "npx-cli.js")),
  );
}
