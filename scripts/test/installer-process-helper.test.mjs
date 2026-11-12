import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveRuntimeHostBuild, verifyRuntimeHostPe } from "../build-windows-runtime-host.mjs";

const source = resolve(import.meta.dirname, "../windows-runtime-host");
const logName = "ZCode-process-cleanup.log";
const sentinel = "existing log must survive\r\n";

function launch(executable, args, options = {}) {
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20000,
    ...options,
  });
  const running = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => (running.stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (running.stderr += chunk));
  // helper 可以先终止目标；随后关闭 stdin 时的 EPIPE 不能成为未处理异常。
  child.stdin.on("error", () => {});
  let spawnError;
  child.once("error", (error) => (spawnError = error));
  running.closed = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal, error: spawnError }));
  });
  return running;
}

function diagnostic(running) {
  return `stdout:\n${running.stdout}\nstderr:\n${running.stderr}`;
}

async function expectExit(running, code) {
  const result = await running.closed;
  assert.ifError(result.error);
  assert.equal(result.signal, null, diagnostic(running));
  assert.equal(result.code, code, diagnostic(running));
}

function waitForOutput(running, pattern, from = 0) {
  return new Promise((resolveOutput, reject) => {
    const { child } = running;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", check);
      child.off("close", ended);
      child.off("error", failed);
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const check = () => {
      const match = running.stdout.slice(from).match(pattern);
      if (match) {
        cleanup();
        resolveOutput(match);
      }
    };
    const ended = () =>
      failed(new Error(`Fixture exited before ${pattern}: ${diagnostic(running)}`));
    // 此超时只限制失败用例，不用作进程就绪或状态同步。
    const timer = setTimeout(
      () => failed(new Error(`Fixture did not report ${pattern}: ${diagnostic(running)}`)),
      5000,
    );
    child.stdout.on("data", check);
    child.once("close", ended);
    child.once("error", failed);
    check();
    if (child.exitCode !== null || child.signalCode !== null) ended();
  });
}

async function startFixture(t, executable, args) {
  const running = launch(executable, args);
  t.after(async () => {
    // ACL 可以拒绝新申请的终止句柄；用已建立的 stdin 通道回收夹具。
    running.child.stdin.write("q");
    running.child.stdin.end();
    await expectExit(running, 0);
  });
  const ready = await waitForOutput(running, /ready pid=(\d+)[^\r\n]*\r?\n/);
  assert.equal(Number(ready[1]), running.child.pid);
  return running;
}

async function expectAlive(running) {
  const from = running.stdout.length;
  const alive = waitForOutput(running, new RegExp(`alive pid=${running.child.pid}\\r?\\n`), from);
  running.child.stdin.write("p");
  await alive;
  assert.equal(running.child.exitCode, null, diagnostic(running));
}

function expectStage(running, stage, pid, error = 0) {
  assert.match(
    running.stdout,
    new RegExp(`(?:^|\\n)stage=${stage} pid=${pid} win32-error=${error}\\r?\\n`),
    diagnostic(running),
  );
}

test("CR03: process cleanup has no script compiler or shell launch dependency", async () => {
  const helper = await readFile(join(source, "installer-process-helper.cpp"), "utf8");
  assert.doesNotMatch(helper, /powershell|pwsh|Add-Type|\.ps1\b/i);
  assert.doesNotMatch(helper, /\b(?:CreateProcess\w*|ShellExecute\w*|WinExec|system|_popen)\s*\(/);
});

test(
  "Windows native installer process helper",
  { skip: process.platform !== "win32", timeout: 180000 },
  async (t) => {
    const work = await mkdtemp(join(tmpdir(), "installer-process-test-"));
    t.after(() => rm(work, { recursive: true, force: true, maxRetries: 3 }));
    const build = join(work, "build");
    const arch = process.arch;
    const plan = resolveRuntimeHostBuild(arch);
    for (const args of [
      ["-S", source, "-B", build, ...plan.configureArgs, "-DCMAKE_BUILD_TYPE=Release"],
      [
        "--build",
        build,
        "--config",
        "Release",
        "--target",
        "zcode-installer-process-helper",
        "zcode-installer-process-fixture",
      ],
    ]) {
      const cmake = launch(process.env.CMAKE || "cmake", args, { timeout: 120000 });
      cmake.child.stdin.end();
      await expectExit(cmake, 0);
    }
    const helper = join(build, "Release/zcode-installer-process-helper.exe");
    const fixture = join(build, "Release/zcode-installer-process-fixture.exe");
    for (const executable of [helper, fixture]) {
      verifyRuntimeHostPe(await readFile(executable), arch);
    }
    const emptyPath = join(work, "empty-path");
    await mkdir(emptyPath);
    const baseEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:path|temp|tmp)$/i.test(key)),
    );

    async function scenario(t) {
      const directory = await mkdtemp(join(work, "case-"));
      const targetDir = join(directory, "target install");
      const otherDir = join(directory, "other install");
      const temp = join(directory, "helper temp");
      await Promise.all([targetDir, otherDir, temp].map((path) => mkdir(path)));
      // 每例使用唯一 basename，绝不按真实产品进程名执行清理。
      const basename = `installer-test-${randomUUID()}.exe`;
      const target = join(targetDir, basename);
      const other = join(otherDir, basename);
      await Promise.all([target, other].map((path) => copyFile(fixture, path)));
      const log = join(temp, logName);
      await writeFile(log, sentinel);
      return {
        target,
        other,
        log,
        start: (executable, mode) => startFixture(t, executable, [mode]),
        run: async () => {
          assert.deepEqual(await readdir(emptyPath), []);
          // CR03：原生 helper 以绝对路径启动；PATH 和 cwd 均指向空目录。
          const running = launch(helper, [target], {
            cwd: emptyPath,
            env: { ...baseEnvironment, PATH: emptyPath, TEMP: temp, TMP: temp },
          });
          running.child.stdin.end();
          await running.closed;
          return running;
        },
      };
    }

    await t.test("CR03: empty PATH succeeds when no target is running", async (t) => {
      const context = await scenario(t);
      const result = await context.run();
      await expectExit(result, 0);
      expectStage(result, "stop-completed", 0);
    });

    await t.test("other-path same-name process denies terminate but permits query", async (t) => {
      const context = await scenario(t);
      const other = await context.start(context.other, "--restricted");
      assert.match(other.stdout, /terminate-open-error=5 query-open-error=0/);
      const result = await context.run();
      await expectExit(result, 0);
      expectStage(result, "stop-completed", 0);
      assert.doesNotMatch(result.stdout, new RegExp(`pid=${other.child.pid}\\b`));
      await expectAlive(other);
    });

    await t.test(
      "normal target terminates while the restricted other-path process survives",
      async (t) => {
        const context = await scenario(t);
        const other = await context.start(context.other, "--restricted");
        const target = await context.start(context.target, "--normal");
        const result = await context.run();
        await expectExit(result, 0);
        expectStage(result, "matched", target.child.pid);
        expectStage(result, "exited", target.child.pid);
        expectStage(result, "stop-completed", 0);
        await expectExit(target, 0);
        await expectAlive(other);
        const log = await readFile(context.log, "utf8");
        assert.ok(log.startsWith(sentinel));
        assert.ok(log.endsWith(result.stdout.replace(/\r\n/g, "\n")));
      },
    );

    for (const [mode, stage] of [
      ["--restricted", "terminate-open-failed"],
      ["--deny-query", "query-open-failed"],
    ]) {
      await t.test(`target ${mode} returns 2 with real ERROR_ACCESS_DENIED`, async (t) => {
        const context = await scenario(t);
        const target = await context.start(context.target, mode);
        assert.match(target.stdout, /terminate-open-error=5/);
        assert.match(
          target.stdout,
          new RegExp(`query-open-error=${mode === "--deny-query" ? 5 : 0}`),
        );
        const result = await context.run();
        await expectExit(result, 2);
        expectStage(result, stage, target.child.pid, 5);
        assert.doesNotMatch(result.stdout, /stage=stop-completed/);
        await expectAlive(target);
      });
    }

    for (const [mode, openError, writeError] of [
      ["--log-readonly", 5, 0],
      ["--log-exclusive", 32, 0],
      ["--log-append-failure", 0, 33],
    ]) {
      for (const restricted of [false, true]) {
        await t.test(
          `${mode} preserves ${restricted ? "failure (2)" : "success (0)"}`,
          async (t) => {
            const context = await scenario(t);
            const holder = await startFixture(t, fixture, [mode, context.log]);
            // 夹具使用与 helper 相同的打开和追加参数，证明真实 Win32 故障已生效。
            assert.match(
              holder.stdout,
              new RegExp(`log-open-error=${openError} log-write-error=${writeError}`),
            );
            const target = await context.start(
              context.target,
              restricted ? "--restricted" : "--normal",
            );
            const result = await context.run();
            await expectExit(result, restricted ? 2 : 0);
            if (restricted) {
              expectStage(result, "terminate-open-failed", target.child.pid, 5);
              assert.doesNotMatch(result.stdout, /stage=stop-completed/);
              await expectAlive(target);
            } else {
              expectStage(result, "matched", target.child.pid);
              expectStage(result, "exited", target.child.pid);
              expectStage(result, "stop-completed", 0);
              await expectExit(target, 0);
            }
            await expectAlive(holder);
            holder.child.stdin.write("q");
            holder.child.stdin.end();
            await expectExit(holder, 0);
            assert.equal(await readFile(context.log, "utf8"), sentinel);
          },
        );
      }
    }
    assert.deepEqual(await readdir(emptyPath), []);
  },
);
