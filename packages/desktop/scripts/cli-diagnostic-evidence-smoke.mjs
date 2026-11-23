import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import yauzl from "yauzl";

// 运行时验收仅操作独立 fixture；不注册产品退出钩子，不创建真实会话。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputRoot = resolve(
  process.argv[2] ?? join(root, "packages/desktop/.e2e-artifacts", `cli-diagnostics-${Date.now()}`),
);
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, "run-"));
const require = createRequire(join(root, "package.json"));
const runtime = process.argv[3] ?? require("electron");
const memorySource = join(root, "apps/zcode-cli/packages/adapters/src/memory-diagnostics/index.ts");
const archiveSource = join(root, "packages/services/src/feedback/feedbackLogArchive.ts");
const collectorSource = join(root, "packages/services/src/zcode-agent/agentStderrCollector.ts");
const report = { platform: process.platform, runtime, checks: [], children: [], sourceHashes: {} };
for (const path of [
  memorySource,
  archiveSource,
  collectorSource,
  join(dirname(memorySource), "recorder.ts"),
  join(root, "packages/shared/src/memoryDiagnostics.ts"),
  join(root, "packages/shared/src/feedbackPrivacy.ts"),
  join(root, "packages/shared/src/agent-crash-diagnostic/agentCrashDiagnostic.ts"),
]) {
  report.sourceHashes[path.slice(root.length + 1)] = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function bundle(source, name, minify = false) {
  const path = join(output, name);
  await build({
    stdin: { contents: source, resolveDir: root, loader: "ts" },
    outfile: path,
    platform: "node",
    format: "cjs",
    bundle: true,
    minify,
    sourcemap: false,
    logLevel: "silent",
  });
  return path;
}
const adapters = await bundle(
  `export { createFeedbackDiagnosticArchive } from ${JSON.stringify(archiveSource)};
export { AgentStderrCollector, createAgentStderrTail } from ${JSON.stringify(collectorSource)};`,
  "adapters.cjs",
);
const { createFeedbackDiagnosticArchive, AgentStderrCollector, createAgentStderrTail } =
  await import(pathToFileURL(adapters).href);
function unzip(path) {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      zip.on("error", reject);
      zip.on("entry", (entry) =>
        zip.openReadStream(entry, (readError, stream) => {
          if (readError) return reject(readError);
          const chunks = [];
          stream.on("error", reject);
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        }),
      );
      zip.on("end", () => resolveZip(files));
      zip.readEntry();
    });
  });
}
async function check(name, action) {
  try {
    const details = await action();
    report.checks.push({ name, passed: true, details });
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error) });
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.checks.at(-1)));
}
const crashMarker = "E2E_DIAGNOSTIC_FAILURE";
const secret = "E2E_PRIVATE_CONTENT";
await check("fatal-header-bounded-retention", async () => {
  const tail = createAgentStderrTail();
  tail.append(`FATAL ERROR: Reached heap limit token=${secret}`);
  for (let i = 0; i < 40; i++) tail.append(`${i}: 0x12345678 native_frame`);
  assert.equal(tail.snapshot().tail.length, 20);
  assert.match(tail.snapshot().tail[0], /^FATAL ERROR:/);
  assert.ok(!JSON.stringify(tail.snapshot()).includes(secret));
  tail.append("ordinary later warning");
  assert.ok(!tail.snapshot().tail.some((line) => line.startsWith("FATAL ERROR:")));
});
function exitLine(tail, code = 1, signal = null) {
  return `[2026-11-16 12:00:00] [error] [pid:123] [host] [zcode-agent] ZCode agent process exited unexpectedly ${JSON.stringify(
    {
      pid: 123,
      code,
      signal,
      terminationKind: "unexpected",
      stderr: { lineCount: tail.length, tail },
    },
  )}\n`;
}
async function archiveCase(name, body, budget, options = {}) {
  const directory = join(output, "logs", name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "app.log");
  await writeFile(path, body);
  if (options.yesterday) {
    const at = new Date(Date.now() - 86_400_000);
    await utimes(path, at, at);
  }
  const result = await createFeedbackDiagnosticArchive({
    sources: [{ directory, archivePrefix: "logs" }],
    outputRootDir: join(output, "archives", name),
    ...(budget ? { maxTotalBytes: budget } : {}),
  });
  return { files: await unzip(result.path), path: result.path };
}
function readCrashRecord(files) {
  const log = files.get("logs/app.log");
  assert.ok(log, "exit log missing from ZIP");
  return JSON.parse(log.slice(log.indexOf("{")));
}
for (const [format, address] of [
  ["prefixed", "0x1234abcd"],
  ["windows", "00007FF689BB5EBA"],
]) {
  for (const newline of ["\n", "\r\n"]) {
    await check(
      `native-stack-projection-${format}-${newline === "\n" ? "lf" : "crlf"}`,
      async () => {
        const frames = Array.from(
          { length: 5 },
          (_, i) =>
            ` ${i + 1}: ${address} ${format === "windows" ? `v8::internal::OOMErrorHandler${i}+878922` : `node::OOMErrorHandler${i}()`}`,
        );
        const tail = [
          `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory token=${secret}`,
          ...frames,
          `TypeError: secondary failure context: ${secret}`,
          `RangeError: final failure password="${secret}"`,
          "    at probe (zcode.cjs:7:19)",
        ];
        const { files, path } = await archiveCase(
          `native-stack-${format}-${newline.length}`,
          exitLine(
            tail.map((line, i) => (newline === "\r\n" && i < tail.length - 1 ? line + "\r" : line)),
          ),
        );
        const { agentCrash, stderr } = readCrashRecord(files);
        const lines = agentCrash.errorStack.split(/\r?\n/);
        assert.equal(agentCrash.errorCode, "ERR_OUT_OF_MEMORY");
        assert.match(lines[0], /^FATAL ERROR: Reached heap limit/);
        assert.deepEqual(lines.slice(1, 6), frames);
        assert.match(lines[6], /^TypeError: secondary failure/);
        assert.match(lines[7], /^RangeError: final failure/);
        assert.equal(lines[8], tail[8]);
        assert.equal(lines.length, tail.length);
        assert.equal(stderr, "[REDACTED]");
        assert.ok(!/token=|context:|password=/.test(agentCrash.errorStack));
        assert.ok(![...files.values()].join("\n").includes(secret));
        return { path, stackLines: lines.length, nativeFrames: frames.length };
      },
    );
  }
}
for (const [name, budget] of [["full"], ["compact", 2 * 1024 * 1024]]) {
  await check(`runtime-diagnostics-${name}`, async () => {
    const diagnostics = [
      [
        "Windows runtime host helper exit",
        {
          runId: "runtime-example",
          hostPid: 123,
          helperPid: 234,
          runtimePid: 345,
          code: 1,
          signal: null,
          rootSeen: false,
          empty: false,
          lastFrame: "started",
          closeSent: false,
          destroyReason: "none",
        },
      ],
      [
        "Windows runtime host native exit",
        {
          hostPid: 123,
          helperPid: 234,
          runtimePid: 345,
          nativeHostPid: 123,
          nativeHelperPid: 234,
          nativeRuntimePid: 345,
          reason: "control_lost",
          stage: "control_peek",
          win32Error: 109,
          running: true,
          rootExited: true,
          forced: true,
          jobEmpty: true,
        },
      ],
      ["main_schedule_delay", { pid: 123, delayedSampleCount: 2, maxDelayMs: 6000 }],
    ];
    const body =
      diagnostics
        .map(
          ([marker, fields]) =>
            `[2026-11-16 12:00:00] [warn] [pid:123] [resource] ${marker} ${JSON.stringify(fields)}\n`,
        )
        .join("") +
      `[2026-11-16 12:00:00] [info] [probe] ${JSON.stringify({ password: secret, stderr: secret })}\n`;
    const { files, path } = await archiveCase(`runtime-${name}`, body, budget);
    const lines = files.get("logs/app.log")?.trim().split("\n");
    assert.equal(lines?.length, diagnostics.length + 1);
    for (const [index, [marker, fields]] of diagnostics.entries()) {
      assert.ok(lines[index].includes(marker));
      assert.deepEqual(JSON.parse(lines[index].slice(lines[index].indexOf("{"))), fields);
    }
    assert.ok(![...files.values()].join("\n").includes(secret));
    return { path, diagnosticRecords: diagnostics.length };
  });
}
await check("error-header-leading-context", async () => {
  const { files, path } = await archiveCase(
    "leading-context",
    exitLine([
      `Error: token=${secret}`,
      `TypeError: context: ${secret}`,
      "    at probe (zcode.cjs:7:19)",
    ]),
  );
  const { agentCrash } = readCrashRecord(files);
  const lines = agentCrash.errorStack.split(/\r?\n/);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Error:[ \t]+\[REDACTED\]$/);
  assert.match(lines[1], /^TypeError:[ \t]+\[REDACTED\]$/);
  assert.equal(lines[2], "    at probe (zcode.cjs:7:19)");
  assert.ok(![...files.values()].join("\n").includes(secret));
  return { path };
});
await check("stack-frame-privacy", async () => {
  const { files, path } = await archiveCase(
    "frame-privacy",
    exitLine([
      "FATAL ERROR: Reached heap limit",
      ` 1: 0x1234abcd node::OOMErrorHandler() token=${secret}`,
      ` 3: 00007FF689BB5EBA v8::internal::OOMErrorHandler+33 token=${secret}`,
      " 4: 00007FF8A5E9CC91 RtlUserThreadStart+33",
      " 5: 123 not_a_native_address",
      " 6: deadbeefg not_a_native_address",
      " 7: 12345678901234567 not_a_native_address",
      " 2: 0x2345bcde node::Abort()",
      `    at probe (zcode.cjs:7:19) password=${secret}`,
      "    at caller (zcode.cjs:8:20)",
    ]),
  );
  const { agentCrash, stderr } = readCrashRecord(files);
  assert.match(agentCrash.errorStack, /^FATAL ERROR: Reached heap limit/m);
  assert.match(agentCrash.errorStack, /^ 2: 0x2345bcde node::Abort\(\)/m);
  assert.match(agentCrash.errorStack, /^ 4: 00007FF8A5E9CC91 RtlUserThreadStart\+33/m);
  assert.ok(!agentCrash.errorStack.includes("not_a_native_address"));
  assert.match(agentCrash.errorStack, /^    at caller \(zcode.cjs:8:20\)/m);
  assert.equal(stderr, "[REDACTED]");
  assert.ok(![...files.values()].join("\n").includes(secret));
  return { path };
});
for (const [mode, budget] of [["full"], ["compact", 2 * 1024 * 1024]]) {
  for (const newline of ["\n", "\r\n"]) {
    await check(`windows-native-frame-privacy-${mode}-${newline.length}`, async () => {
      const privateText = "SG01_PRIVATE_PLAIN_TEXT";
      const frames = [
        " 1: 00007FF689BB5EBA v8::internal::CallbackScope::~CallbackScope+33",
        " 2: 00007FF8A5E9CC91 RtlUserThreadStart+33",
        " 3: 00007FF689BB5EBA uv_run+42",
      ];
      const tail = [
        "FATAL ERROR: Reached heap limit",
        ...frames.map((frame) => `${frame} ${privateText} token=${secret}`),
        " 8: 20261120 private prompt text",
        " 9: 1380013800012345 secret words",
        ` 10: 2026112012345678 ${privateText}`,
        ` 11: 00007FF689BB5EBA ${privateText}`,
        ` 12: 00007FF689BB5EBA SymbolWithoutOffset ${privateText}`,
        ` 13: 00007FF689BB5EBA uv_run+42not_an_offset ${privateText}`,
      ];
      const { files, path } = await archiveCase(
        `windows-frame-privacy-${mode}-${newline.length}`,
        exitLine(tail.map((line) => line + (newline === "\r\n" ? "\r" : ""))),
        budget,
      );
      const { agentCrash, stderr } = readCrashRecord(files);
      assert.deepEqual(agentCrash.errorStack.split("\n"), [tail[0], ...frames]);
      assert.equal(stderr, "[REDACTED]");
      const exported = [...files.values()].join("\n");
      for (const text of [
        privateText,
        secret,
        "private prompt text",
        "secret words",
        "not_an_offset",
        "SymbolWithoutOffset",
      ])
        assert.ok(!exported.includes(text), `unexpected native frame body: ${text}`);
      return { path, nativeFrames: frames.length };
    });
  }
}
const errorLine = exitLine([
  `Error: ${crashMarker} token=${secret}`,
  "    at probe (zcode.cjs:7:19)",
  " 1: 0x1234abcd node::OOMErrorHandler()",
  " 2: 00007FF8A5E9CC91 RtlUserThreadStart+33",
  `prompt: ${secret}`,
]);
for (const [name, size, budget] of [
  ["full-large-log", 9 * 1024 * 1024],
  ["compact-large-log", 3 * 1024 * 1024, 2 * 1024 * 1024],
]) {
  await check(name, async () => {
    const routine = "[2026-11-16 12:00:00] [info] [probe] routine\n";
    const { files, path } = await archiveCase(
      name,
      routine.repeat(Math.ceil(size / routine.length)) + errorLine,
      budget,
    );
    const log = files.get("logs/app.log");
    assert.ok(log?.includes(crashMarker), "crash summary missing from ZIP");
    assert.ok(log.includes("agentCrash"));
    assert.ok(log.includes("zcode.cjs:7:19"));
    const { agentCrash } = readCrashRecord(
      new Map([["logs/app.log", log.trim().split("\n").at(-1)]]),
    );
    assert.ok(agentCrash.errorStack.includes(" 1: 0x1234abcd node::OOMErrorHandler()"));
    assert.ok(agentCrash.errorStack.includes(" 2: 00007FF8A5E9CC91 RtlUserThreadStart+33"));
    assert.ok(![...files.values()].join("\n").includes(secret));
    assert.match(files.get("about.txt"), /truncatedLogFiles: 1/);
    assert.ok(Buffer.byteLength(log) <= (budget ?? 8 * 1024 * 1024));
    return { path };
  });
}
await check("small-log-crash-projection", async () => {
  const { files, path } = await archiveCase(
    "small",
    errorLine + JSON.stringify({ event: "ordinary", stderr: secret, prompt: secret }) + "\n",
  );
  assert.ok(files.get("logs/app.log")?.includes(crashMarker));
  assert.ok(![...files.values()].join("\n").includes(secret));
  return { path };
});
await check("old-log-reason", async () => {
  const { files } = await archiveCase("old", errorLine, undefined, { yesterday: true });
  assert.ok(!files.has("logs/app.log"));
  assert.match(files.get("about.txt"), /not-current-day/);
});

for (const encoding of ["utf8", "utf16le", "utf16be"]) {
  await check(`tail-boundary-${encoding}`, async () => {
    const raw = `prompt: ${secret}\n${secret.repeat(1000)}\n` + errorLine + `partial:${secret}`;
    let bytes = Buffer.from(raw, encoding === "utf16be" ? "utf16le" : encoding);
    if (encoding !== "utf8") {
      bytes = Buffer.concat([Buffer.from([255, 254]), bytes]);
      if (encoding === "utf16be") bytes.swap16();
    }
    const { files, path } = await archiveCase(encoding, bytes, 4097);
    assert.ok(files.get("logs/app.log")?.includes(crashMarker));
    assert.ok(![...files.values()].join("\n").includes(secret));
    return { path };
  });
}
await check("source-reservation", async () => {
  const sources = [];
  for (const name of ["host", "cli"]) {
    const directory = join(output, "logs", `reserved-${name}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "app.log"),
      "[2026-11-16 12:00:00] [info] routine\n".repeat(2000) + errorLine,
    );
    sources.push({ directory, archivePrefix: name });
  }
  const result = await createFeedbackDiagnosticArchive({
    sources,
    maxTotalBytes: 8192,
    outputRootDir: join(output, "archives", "reserved"),
  });
  const files = await unzip(result.path);
  for (const name of ["host", "cli"])
    assert.ok(files.get(`${name}/app.log`)?.includes(crashMarker));
  return { path: result.path };
});
await check("windows-native-oom-signature", async () => {
  const { files } = await archiveCase("native-oom", exitLine([], 0xe0000008));
  assert.ok(files.get("logs/app.log")?.includes("ERR_OUT_OF_MEMORY"));
});

const childPath = await bundle(
  `
import { startCliMemoryDiagnostics, createMemoryDiagnosticRecorder } from ${JSON.stringify(memorySource)};
import { performance } from 'node:perf_hooks';
async function main() {
const mode = process.argv[2], directory = process.argv[3];
console.log(JSON.stringify({event:'runtime', versions:process.versions}));
if(mode === 'pending-write') {
 const recorder = createMemoryDiagnosticRecorder({bundlePath:process.argv[1], metadata:()=>({instanceId:'00000000-0000-4000-8000-000000000000',pid:process.pid,version:'probe',commit:'probe',node:process.versions.node,v8:process.versions.v8,bundleSha256:''}),
 profiler:{start:async()=>0,read:async()=>({head:{id:1,selfSize:0,callFrame:{functionName:'',url:'',lineNumber:0,columnNumber:0},children:[]},durationMs:0}),reset:async()=>0,dispose(){}},
 readMemory:()=>({...process.memoryUsage(),heapLimit:4000000000}),readCounters:()=>({sessions:0}),write:()=>new Promise(()=>{})});
 await recorder.start(); void recorder.sample(); await Promise.resolve(); recorder.stop();
 console.log(JSON.stringify({event:'finished'}));
} else {
 const diagnostics = mode === 'off' ? undefined : startCliMemoryDiagnostics(()=>({sessions:1}),{directory});
 // 同一轮的业务计算过去被 await 计时误算为 Inspector 工作。
 const until=performance.now()+50; while(performance.now()<until) Math.sqrt(Math.random());
 if(mode === 'normal' || mode === 'off' || mode === 'storage-failure') {
   if(mode === 'storage-failure') await new Promise(resolve=>setTimeout(resolve,16000));
   diagnostics?.stop(); console.log(JSON.stringify({event:'finished'}));
 } else {
   globalThis.retained=[];
   function allocateProbe(){ for(let j=0;j<32;j++) globalThis.retained.push(Array.from({length:10000},(_,i)=>({i,label:'probe-'+j+'-'+i}))); }
   allocateProbe();
   setTimeout(()=>{
     console.log(JSON.stringify({event:'fault-start'}));
     if(mode==='oom') { while(true) globalThis.retained.push(new Array(100000).fill({value:1})); }
     else throw new Error(${JSON.stringify(crashMarker + " token=" + secret)});
   },17000);
 }
}
}
void main();
`,
  "probe-child.cjs",
  true,
);
async function runChild(mode) {
  const directory = join(output, "memory", mode);
  await mkdir(dirname(directory), { recursive: true });
  if (mode === "storage-failure") await writeFile(directory, "not a directory");
  const startedAt = Date.now();
  return new Promise((resolveChild, reject) => {
    const child = spawn(runtime, ["--max-old-space-size=128", childPath, mode, directory], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrTail = createAgentStderrTail();
    let stdout = "";
    let finishedAt;
    let watchdog;
    // 使用产品已有的 stderr 解码器。Host 日志格式由验收器复现，未启动完整 App。
    const collector = new AgentStderrCollector(child.stderr, (line) => stderrTail.append(line));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('"event":"finished"')) finishedAt ??= Date.now();
    });
    child.once("error", reject);
    // 仅测试 watchdog；产品不增加 timer、signal 或退出屏障。
    watchdog = setTimeout(() => {
      child.kill();
      reject(new Error(`${mode}: child did not exit`));
    }, 40_000);
    child.once("close", async (code, signal) => {
      clearTimeout(watchdog);
      try {
        await collector.waitForDrain();
        await writeFile(join(output, `${mode}-stdout.log`), stdout);
        const tail = stderrTail.snapshot().tail;
        await writeFile(join(output, `${mode}-stderr.log`), tail.join("\n"));
        const item = {
          mode,
          code,
          signal,
          elapsedMs: Date.now() - startedAt,
          ...(finishedAt ? { exitAfterFinishedMs: Date.now() - finishedAt } : {}),
          directory,
        };
        report.children.push(item);
        resolveChild({ ...item, tail });
      } catch (error) {
        reject(error);
      }
    });
  });
}
for (const mode of ["off", "normal", "pending-write", "storage-failure"]) {
  await check(`exit-${mode}`, async () => {
    const child = await runChild(mode);
    assert.equal(child.code, 0);
    assert.ok(child.exitAfterFinishedMs < 2000, "diagnostics kept process alive after finish");
    return { elapsedMs: child.elapsedMs, exitAfterFinishedMs: child.exitAfterFinishedMs };
  });
}
for (const mode of ["exception", "oom"]) {
  await check(`capture-${mode}`, async () => {
    const child = await runChild(mode);
    assert.ok(child.code !== 0 || child.signal);
    const names = await readdir(child.directory);
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => JSON.parse(await readFile(join(child.directory, name), "utf8"))),
    );
    const record = records.find(
      (item) => item.sampler.profileCapturedAt > 0 && item.allocations.length > 0,
    );
    assert.ok(record, `no allocation evidence: ${JSON.stringify(records.map((r) => r.sampler))}`);
    assert.equal(
      record.bundleSha256,
      createHash("sha256")
        .update(await readFile(childPath))
        .digest("hex"),
    );
    const logs = join(output, "logs", mode);
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "app.log"), exitLine(child.tail, child.code, child.signal));
    const archive = await createFeedbackDiagnosticArchive({
      sources: [
        {
          directory: child.directory,
          archivePrefix: ".zcode/cli/memory-diagnostics",
          contentPolicy: "cli-memory",
          onlyCurrentDay: false,
        },
        { directory: logs, archivePrefix: "logs" },
      ],
      outputRootDir: join(output, "archives", mode),
    });
    const files = await unzip(archive.path);
    const text = [...files.values()].join("\n");
    assert.ok(!text.includes(secret));
    assert.ok(text.includes("agentCrash"));
    assert.ok(text.includes(mode === "oom" ? "ERR_OUT_OF_MEMORY" : crashMarker));
    const { agentCrash } = readCrashRecord(files);
    if (mode === "oom") {
      assert.match(agentCrash.errorStack, /^FATAL ERROR:.*heap.*(?:limit|memory)/m);
      const nativeFrame = /^[ \t]*\d+:[ \t]*(?:0x[0-9a-f]+|[0-9a-f]{8,16})(?=[ \t]|$)/i;
      const expectedFrames = child.tail.filter((line) => nativeFrame.test(line));
      assert.ok(expectedFrames.length > 0, "runtime emitted no native OOM frames");
      assert.deepEqual(
        agentCrash.errorStack.split("\n").filter((line) => nativeFrame.test(line)),
        expectedFrames,
      );
      assert.ok(agentCrash.errorStack.split("\n").length > 1);
    } else {
      assert.match(agentCrash.errorStack, new RegExp(`^Error: ${crashMarker}`, "m"));
      assert.match(agentCrash.errorStack, /^[ \t]+at[ \t]+/m);
    }
    const exported = [...files.entries()]
      .filter(([name]) => name.includes("memory-diagnostics"))
      .map(([, body]) => JSON.parse(body));
    assert.ok(exported.some((r) => r.allocations.length > 0));
    return {
      path: archive.path,
      allocations: record.allocations.length,
      heapBytes: record.samples.at(-1).heapUsed,
      sourcePosition: record.allocations[0].stack.at(-1),
      archiveBytes: (await stat(archive.path)).size,
    };
  });
}
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`Evidence: ${output}`);
if (report.checks.some((check) => !check.passed)) process.exitCode = 1;
