// Windows 原生运行时验收。传入包含 helper、fixture、adapter.cjs 的构建目录。
// Wine 可用 Node 20 执行；仅补 Promise.withResolvers，不把它记为 Node 24 / Windows 实机证据。
Promise.withResolvers ??= function () {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const buildDir = resolve(process.argv[2]);
const { spawnWindowsRuntimeHost } = require(join(buildDir, "adapter.cjs"));
process.env.ZCODE_RUNTIME_HOST_PATH = join(buildDir, "zcode-runtime-host.exe");
const fixture = join(buildDir, "zcode-runtime-host-acceptance.exe");
async function create(mode) {
  const abort = new AbortController();
  const runtime = await spawnWindowsRuntimeHost({
    command: fixture,
    args: ["fixture", mode],
    cwd: buildDir,
    env: process.env,
    signal: abort.signal,
  });
  await runtime.ready();
  let output = "";
  runtime.child.stdout.on("data", (s) => (output += s));
  runtime.child.stderr.on("data", (s) => process.stderr.write(s));
  let root;
  runtime.onRootExit((code) => (root = code));
  return { runtime, abort, output: () => output, root: () => root };
}
(async () => {
  if (process.argv[3] === "crash-host") {
    const owned = await create("tree");
    await owned.runtime.start();
    while (!/descendant ([0-9]+)/.test(owned.output())) await delay(10);
    console.log(
      JSON.stringify([
        owned.runtime.runtimePid,
        owned.runtime.child.pid,
        Number(/descendant ([0-9]+)/.exec(owned.output())[1]),
      ]),
    );
    return;
  }

  for (const mode of ["graceful", "tree", "root-exit"]) {
    const x = await create(mode);
    assert.equal(x.output(), "");
    assert.notEqual(x.runtime.runtimePid, x.runtime.child.pid);
    await x.runtime.start();
    await delay(100);
    const begin = Date.now();
    await Promise.all([x.runtime.close(Date.now() + 3250), x.runtime.close(Date.now() + 3250)]);
    if (mode === "graceful") {
      assert.equal(x.root(), 0);
      assert.ok(Date.now() - begin >= 1400);
    }
    console.log("PASS adapter", mode, Date.now() - begin);
  }
  const late = await create("tree");
  await late.runtime.start();
  await assert.rejects(late.runtime.close(Date.now() + 50), /timed out/);
  await delay(2100);
  await late.runtime.close(Date.now() + 1000);
  console.log("PASS deadline retains Job; later close succeeds");
  const crashed = await create("tree");
  await crashed.runtime.start();
  await delay(150);
  crashed.runtime.child.kill();
  await delay(150);
  await crashed.runtime.close(Date.now() + 1500);
  console.log("PASS helper crash kernel Job probe recovery");
  const cancelled = await create("tree");
  cancelled.abort.abort();
  await assert.rejects(cancelled.runtime.start());
  await cancelled.runtime.close(Date.now() + 1500);
  assert.equal(cancelled.output(), "");
  console.log("PASS cancelled startup never executes CLI");
  const early = await spawnWindowsRuntimeHost({
    command: fixture,
    args: ["fixture", "tree"],
    cwd: buildDir,
    env: process.env,
    signal: new AbortController().signal,
  });
  await early.close(Date.now() + 2000);
  await assert.rejects(early.start());
  console.log("PASS close during startup retains and cleans owner");
  const invalid = await spawnWindowsRuntimeHost({
    command: join(buildDir, "missing-cli.exe"),
    args: [],
    cwd: buildDir,
    env: process.env,
    signal: new AbortController().signal,
  });
  invalid.child.stderr.resume();
  await assert.rejects(invalid.ready());
  await invalid.close(Date.now() + 2000);
  console.log("PASS failed CLI creation releases verified empty Job");
  const host = spawn(process.execPath, [__filename, buildDir, "crash-host"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
  });
  let hostOutput = "";
  host.stdout.on("data", (s) => (hostOutput += s));
  while (!hostOutput.includes("\n")) await delay(10);
  const pids = JSON.parse(hostOutput.trim());
  const observer = spawn(fixture, ["watch", ...pids.map(String)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const observerExit = once(observer, "exit");
  let observerOutput = "";
  observer.stdout.on("data", (s) => (observerOutput += s));
  while (!observerOutput.includes("watching")) await delay(10);
  host.kill();
  assert.equal((await observerExit)[0], 0);
  console.log("PASS Host death terminates helper, CLI and descendant handles");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
