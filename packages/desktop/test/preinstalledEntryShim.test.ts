import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Windows 入口 shim 的验收，对应 docs/preinstalled-tools/windows-entry-shim.md 的验收表。
 * 目标用 node.exe：它能回显收到的参数和环境，也能派生后代进程。
 */
const execFileAsync = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, "..");
const builtShim = join(
  desktopRoot,
  "bundled-tools",
  `win32-${process.arch}`,
  "preinstalled-entry-shim",
  "zcode-preinstalled-entry-shim.exe",
);
const echoProgram = [
  "process.stdout.write(JSON.stringify({",
  "argv:process.argv.slice(1),",
  "fixedDefault:process.env.SHIM_DEFAULT,",
  "fixedSet:process.env.SHIM_SET,",
  "unset:process.env.SHIM_UNSET,",
  "}));",
].join("");
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("等待条件超时");
};

describe.skipIf(process.platform !== "win32")("Windows 入口 shim", () => {
  let root: string;
  let counter = 0;

  async function entry(config: {
    target?: string;
    args?: string[];
    env?: unknown[];
    raw?: string;
    directory?: string;
  }) {
    counter += 1;
    const directory = config.directory ?? join(root, `entry-${counter}`);
    await mkdir(directory, { recursive: true });
    const exe = join(directory, "tool.exe");
    await copyFile(builtShim, exe);
    await writeFile(
      join(directory, "tool.shim"),
      config.raw ??
        JSON.stringify({
          schemaVersion: 1,
          target: config.target ?? process.execPath,
          args: config.args ?? ["-e", echoProgram],
          env: config.env ?? [],
        }),
    );
    return exe;
  }

  beforeAll(async () => {
    if (!existsSync(builtShim)) {
      const result = spawnSync(
        process.execPath,
        [join(desktopRoot, "scripts/build-windows-preinstalled-entry-shim.mjs")],
        { stdio: "inherit" },
      );
      expect(result.status).toBe(0);
    }
    root = await mkdtemp(join(tmpdir(), "shim 中文 100%-"));
  }, 180_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("参数含空格、中文、特殊字符和空字符串时，目标收到的与调用方传入的一致", async () => {
    const exe = await entry({});
    const args = [
      "带 空格",
      "中文参数",
      "100%",
      "%PATH%",
      "a^b",
      "a&b",
      'quote"inside',
      "",
      "trailing\\",
      "file:///C:/a%20b",
    ];
    const { stdout } = await execFileAsync(exe, args);
    expect(JSON.parse(stdout).argv).toEqual(args);
  });

  it("配置中的固定参数排在调用方参数之前，含引号和反斜杠时不变形", async () => {
    const fixed = ["--install=C:\\路径 含空格\\", 'a"b', ""];
    const exe = await entry({ args: ["-e", echoProgram, "--", ...fixed] });
    const { stdout } = await execFileAsync(exe, ["caller"]);
    expect(JSON.parse(stdout).argv).toEqual([...fixed, "caller"]);
  });

  it("按 set、default、unset 处理环境，default 不覆盖已有值", async () => {
    const exe = await entry({
      env: [
        { name: "SHIM_SET", action: "set", value: "配置值 100%" },
        { name: "SHIM_DEFAULT", action: "default", value: "默认值" },
        { name: "SHIM_UNSET", action: "unset" },
      ],
    });
    const env = { ...process.env, SHIM_SET: "调用方", SHIM_UNSET: "调用方" };
    const absent = JSON.parse((await execFileAsync(exe, [], { env })).stdout);
    expect(absent).toMatchObject({ fixedSet: "配置值 100%", fixedDefault: "默认值" });
    expect(absent.unset).toBeUndefined();
    const present = JSON.parse(
      (await execFileAsync(exe, [], { env: { ...env, SHIM_DEFAULT: "调用方" } })).stdout,
    );
    expect(present.fixedDefault).toBe("调用方");
  });

  it("返回目标的退出码，包含大于 INT_MAX 的值", async () => {
    for (const code of [0, 5, 3221225477]) {
      const exe = await entry({ args: ["-e", `process.exit(${code})`] });
      const result = spawnSync(exe, []);
      expect(result.status).toBe(code);
    }
  });

  it.each([
    ["配置缺失", async (exe: string) => unlink(exe.replace(/\.exe$/, ".shim"))],
    ["JSON 无效", async (exe: string) => writeFile(exe.replace(/\.exe$/, ".shim"), "{")],
    [
      "未知字段",
      async (exe: string) =>
        writeFile(
          exe.replace(/\.exe$/, ".shim"),
          '{"schemaVersion":1,"target":"x","args":[],"env":[],"extra":1}',
        ),
    ],
    [
      "版本不支持",
      async (exe: string) =>
        writeFile(
          exe.replace(/\.exe$/, ".shim"),
          '{"schemaVersion":2,"target":"x","args":[],"env":[]}',
        ),
    ],
    [
      "目标不存在",
      async (exe: string) =>
        writeFile(
          exe.replace(/\.exe$/, ".shim"),
          '{"schemaVersion":1,"target":"C:\\\\missing\\\\x.exe","args":[],"env":[]}',
        ),
    ],
  ])("%s时退出码为 127，并写明原因", async (_name, breakConfig) => {
    const exe = await entry({});
    await breakConfig(exe);
    const result = spawnSync(exe, [], { encoding: "utf8" });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("zcode-preinstalled-entry-shim:");
  });

  it("结束 shim 时，目标及其后代一起结束，版本目录可以删除", async () => {
    const version = join(root, "版本目录");
    await mkdir(version);
    const target = join(version, "target.exe");
    await copyFile(process.execPath, target);
    const pids = join(root, "kill-tree-pids.json");
    const program = [
      "const {spawn}=require('child_process'),{writeFileSync}=require('fs');",
      "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      `writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,c.pid]));`,
      "setInterval(()=>{},1000);",
    ].join("");
    const exe = await entry({ target, args: ["-e", program] });
    const shim = spawn(exe, [], { stdio: "ignore" });
    await waitFor(() => existsSync(pids));
    const [targetPid, childPid] = JSON.parse(await readFile(pids, "utf8")) as [number, number];
    expect(isAlive(targetPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);
    shim.kill();
    await once(shim, "exit");
    await waitFor(() => !isAlive(targetPid) && !isAlive(childPid));
    await rm(version, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(existsSync(version)).toBe(false);
  }, 30_000);

  it("shim 刚启动目标就被结束时，目标不残留，版本目录可以删除", async () => {
    const version = join(root, "立即结束");
    await mkdir(version);
    const target = join(version, "target.exe");
    await copyFile(process.execPath, target);
    const exe = await entry({ target, args: ["-e", "setInterval(()=>{},1000)"] });
    // 结束时机落在 shim 创建目标的毫秒级窗口内才会留下挂起的目标；定时器精度不够，用忙等按 0.25 毫秒步进扫过前 40 毫秒。
    for (let attempt = 0; attempt < 320; attempt += 1) {
      const shim = spawn(exe, [], { stdio: "ignore" });
      const killAt = performance.now() + (attempt % 160) * 0.25;
      while (performance.now() < killAt) continue;
      shim.kill();
      await once(shim, "exit");
    }
    // 残留的目标映射着 target.exe，目录删不掉。
    await rm(version, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(existsSync(version)).toBe(false);
  }, 120_000);

  it("目标正常结束时，保留它有意留在后台的后代进程", async () => {
    const pidFile = join(root, "detached-pid.txt");
    const program = [
      "const {spawn}=require('child_process'),{writeFileSync}=require('fs');",
      "const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',detached:true});",
      `writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      "c.unref();",
    ].join("");
    const exe = await entry({ args: ["-e", program] });
    await execFileAsync(exe, []);
    const pid = Number(await readFile(pidFile, "utf8"));
    try {
      expect(isAlive(pid)).toBe(true);
    } finally {
      process.kill(pid);
    }
  }, 30_000);

  it("目标运行中撤下入口：新调用找不到入口，运行中的调用返回目标的退出码", async () => {
    const exe = await entry({
      args: ["-e", "setTimeout(()=>process.exit(5),1500)"],
    });
    const running = spawn(exe, [], { stdio: "ignore" });
    await new Promise((done) => setTimeout(done, 300));
    await mkdir(join(root, "retired"), { recursive: true });
    const retired = join(root, "retired", "tool-1.exe");
    await rename(exe, retired);
    await unlink(exe.replace(/\.exe$/, ".shim"));
    expect(existsSync(exe)).toBe(false);
    const [code] = (await once(running, "exit")) as [number];
    expect(code).toBe(5);
    await rm(retired, { force: true, maxRetries: 5, retryDelay: 100 });
    expect(existsSync(retired)).toBe(false);
  }, 30_000);

  it("目标运行中替换配置和 shim：运行中的调用不受影响，新调用用新配置", async () => {
    const exe = await entry({
      args: ["-e", "setTimeout(()=>process.exit(7),1500)"],
    });
    const running = spawn(exe, [], { stdio: "ignore" });
    await new Promise((done) => setTimeout(done, 300));
    const shimConfig = exe.replace(/\.exe$/, ".shim");
    const nextConfig = `${shimConfig}.next`;
    await writeFile(
      nextConfig,
      JSON.stringify({
        schemaVersion: 1,
        target: process.execPath,
        args: ["-e", "process.exit(9)"],
        env: [],
      }),
    );
    await rename(nextConfig, shimConfig);
    const retired = `${exe}.retired`;
    await rename(exe, retired);
    await copyFile(builtShim, exe);
    expect(spawnSync(exe, []).status).toBe(9);
    const [code] = (await once(running, "exit")) as [number];
    expect(code).toBe(7);
    await rm(retired, { force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("目标是 .cmd 时也能启动（只用于小包夹具）", async () => {
    const script = join(root, "fixture.cmd");
    await writeFile(script, "@echo hello %1\r\n@exit /b 3\r\n");
    const exe = await entry({ target: script, args: [] });
    const result = spawnSync(exe, ["world"], { encoding: "utf8" });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("hello world");
  });

  it("重复构建产出相同字节，入口替换判断才可靠", async () => {
    const before = await readFile(builtShim);
    const result = spawnSync(
      process.execPath,
      [join(desktopRoot, "scripts/build-windows-preinstalled-entry-shim.mjs")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect((await readFile(builtShim)).equals(before)).toBe(true);
  }, 180_000);
});
