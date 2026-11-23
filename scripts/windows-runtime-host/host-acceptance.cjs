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
const net = require("node:net");
const connections = [];
const createServer = net.createServer;
net.createServer = (...args) => {
  const server = createServer(...args);
  server.on("connection", (connection) => connections.push(connection));
  return server;
};
const adapterLogs = [];
// 复用真实 service logger 的输出；子 Host 的 stdout 只保留原来的 PID 控制结果。
for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("[windows-runtime-host]")) {
      adapterLogs.push({ message: args[1], fields: args[2] });
      return;
    }
    original(...args);
  };
}
const nativeMarker = "[windows-runtime-host:exit] ";
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
  let stderr = "";
  runtime.child.stdout.on("data", (s) => (output += s));
  runtime.child.stderr.on("data", (s) => {
    stderr += s;
    process.stderr.write(s);
  });
  let root;
  runtime.onRootExit((code) => (root = code));
  const connection = connections.at(-1);
  const closed = Promise.all([
    once(runtime.child, "close"),
    new Promise((resolveClosed) => connection.once("close", resolveClosed)),
  ]);
  return {
    runtime,
    abort,
    connection,
    closed,
    output: () => output,
    stderr: () => stderr,
    root: () => root,
  };
}
function diagnostics(x, reason) {
  const spawned = adapterLogs.find(
    (entry) =>
      entry.message === "Windows runtime host spawned" &&
      entry.fields.helperPid === x.runtime.child.pid,
  );
  assert.ok(spawned);
  assert.match(spawned.fields.runId, /^[0-9a-f-]{36}$/);
  assert.equal(spawned.fields.hostPid, process.pid);
  const events = adapterLogs.filter((entry) => entry.fields.runId === spawned.fields.runId);
  assert.equal(
    events.filter((entry) => entry.message === "Windows runtime host helper exit").length,
    1,
  );
  const exit = events.find((entry) => entry.message === "Windows runtime host helper exit").fields;
  assert.equal(exit.helperPid, x.runtime.child.pid);
  assert.equal(exit.runtimePid, x.runtime.runtimePid);
  assert.equal(exit.code, x.runtime.child.exitCode);
  assert.equal(exit.signal, x.runtime.child.signalCode);
  const closed = events.find(
    (entry) => entry.message === "Windows runtime host control close",
  ).fields;
  assert.equal(typeof closed.hadError, "boolean");
  assert.equal(typeof closed.rootSeen, "boolean");
  assert.equal(typeof closed.empty, "boolean");
  assert.equal(typeof closed.closeSent, "boolean");
  assert.ok(["none", "ready", "started", "root", "empty"].includes(closed.lastFrame));
  assert.ok(
    [
      "none",
      "invalid_frame",
      "invalid_event",
      "start_cancelled",
      "helper_error",
      "cleanup_complete",
    ].includes(closed.destroyReason),
  );
  for (const entry of events) {
    assert.ok(
      Object.keys(entry.fields).every((key) =>
        [
          "runId",
          "hostPid",
          "helperPid",
          "runtimePid",
          "code",
          "signal",
          "errorCode",
          "errorName",
          "hadError",
          "rootSeen",
          "empty",
          "lastFrame",
          "closeSent",
          "destroyReason",
        ].includes(key),
      ),
    );
  }
  const summaries = x
    .stderr()
    .split(/\r?\n/)
    .filter((line) => line.startsWith(nativeMarker));
  if (reason === undefined) {
    assert.equal(summaries.length, 0, "externally killed helper need not emit a summary");
  } else {
    assert.equal(summaries.length, 1);
    const summary = JSON.parse(summaries[0].slice(nativeMarker.length));
    assert.deepEqual(
      Object.keys(summary).sort(),
      [
        "hostPid",
        "helperPid",
        "runtimePid",
        "reason",
        "stage",
        "win32Error",
        "running",
        "rootExited",
        "forced",
        "jobEmpty",
      ].sort(),
    );
    assert.equal(summary.reason, reason);
    assert.equal(summary.hostPid, process.pid);
    assert.equal(summary.helperPid, x.runtime.child.pid);
    assert.equal(summary.runtimePid, x.runtime.runtimePid);
    assert.equal(summary.jobEmpty, true);
    assert.equal(summary.rootExited, true);
    if (reason === "root_exited" || reason === "close_grace_elapsed") {
      assert.equal(closed.empty, true);
      assert.equal(closed.lastFrame, "empty");
      assert.equal(summary.stage, "none");
      assert.equal(summary.win32Error, 0);
    }
  }
  return events;
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
    await x.closed;
    diagnostics(x, mode === "tree" ? "close_grace_elapsed" : "root_exited");
    console.log("PASS adapter", mode, Date.now() - begin);
  }
  const lost = await create("tree");
  await lost.runtime.start();
  await delay(100);
  lost.connection.destroy();
  await lost.runtime.close(Date.now() + 2000);
  await lost.closed;
  diagnostics(lost, "control_lost");
  console.log("PASS control loss retains safe diagnostics and kernel cleanup");
  const socketError = await create("tree");
  await socketError.runtime.start();
  await delay(100);
  // 注入 Error 的正文不得进入生产诊断，只记录原有 error/close 回调的安全事实。
  socketError.connection.destroy(
    Object.assign(new Error("PRIVATE socket body"), { code: "ECONNRESET" }),
  );
  await socketError.runtime.close(Date.now() + 2000);
  await socketError.closed;
  const errorEvents = diagnostics(socketError, "control_lost");
  const errorFields = errorEvents.find(
    (entry) => entry.message === "Windows runtime host control error",
  ).fields;
  assert.equal(errorFields.errorCode, "ECONNRESET");
  assert.equal(errorFields.errorName, "Error");
  assert.equal(
    errorEvents.find((entry) => entry.message === "Windows runtime host control close").fields
      .hadError,
    true,
  );
  assert.ok(!JSON.stringify(errorEvents).includes("PRIVATE"));
  console.log("PASS socket error logs code/name without body");
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
  await crashed.closed;
  diagnostics(crashed);
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
