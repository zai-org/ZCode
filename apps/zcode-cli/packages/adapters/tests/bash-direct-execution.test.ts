import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import * as fsPromises from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import { OutputCollector } from "../src/exec/output-collector.js";
import { BashFileOutput } from "../src/exec/bash-file-output.js";
import * as outputEncoding from "../src/exec/outputEncoding.js";
import { resolveWindowsGitBashShell } from "../src/exec/bash-shell-provider.js";
import type { ExecutionEvent, ExecutionRequest, ExecutionShellSelection } from "@zcode/contracts";

const gitBashPath =
  process.platform === "win32" ? await resolveWindowsGitBashShell(process.env) : undefined;
const shells: ExecutionShellSelection[] =
  process.platform === "win32"
    ? [
        {
          dialect: "cmd",
          path: process.env.ComSpec ?? "cmd.exe",
          display: { name: "CMD" },
          source: "user-config",
        },
        ...(gitBashPath
          ? [
              {
                dialect: "git-bash" as const,
                path: gitBashPath,
                display: { name: "Git Bash" },
                source: "user-config" as const,
              },
            ]
          : []),
      ]
    : [{ dialect: "posix", path: "/bin/bash", display: { name: "bash" }, source: "user-config" }];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function fixture(shell: ExecutionShellSelection, code: string, useTmp = false) {
  const root = await mkdtemp(join(tmpdir(), "zcode-direct-"));
  const cwd = join(root, "中文 with spaces");
  await mkdir(cwd);
  const tempParent = join(root, "temporary-output");
  if (useTmp) await mkdir(tempParent);
  const script = join(cwd, "writer.cjs");
  const release = join(cwd, "release");
  await writeFile(script, code);
  const adapter = new NodeExecutionAdapter({
    outputRootDir: root,
    ...(useTmp ? { bashOutputTempDir: tempParent } : {}),
    progressThresholdMs: 0,
    progressIntervalMs: 20,
  });
  cleanup.push(async () => {
    await writeFile(release, "release").catch(() => undefined);
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  const request: ExecutionRequest = {
    command: {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: shell,
      command:
        shell.dialect === "cmd"
          ? '"%PROBE_NODE%" "%PROBE_SCRIPT%"'
          : '"$PROBE_NODE" "$PROBE_SCRIPT"',
    },
    cwd,
    timeoutMs: 10_000,
    env: { set: { PROBE_NODE: process.execPath, PROBE_SCRIPT: script, PROBE_RELEASE: release } },
    outputLimit: {
      maxInlineBytes: 30_000,
      maxArtifactBytes: 64 * 1024 ** 2,
      persistOutput: "always",
    },
    trace: {
      sessionId: "probe",
      attributes: { toolCallId: "direct" },
    } as ExecutionRequest["trace"],
  };
  return { adapter, request, release, tempParent, path: join(root, "probe", "direct-stdout.log") };
}

const gatedWriter = `const fs = require('node:fs');
fs.writeSync(1, 'file:' + fs.fstatSync(1).isFile() + ':' + fs.fstatSync(2).isFile() + '\\n');
fs.writeSync(2, 'stderr-first\\n');
const timer = setInterval(() => {
  if (!fs.existsSync(process.env.PROBE_RELEASE)) return;
  clearInterval(timer); fs.writeSync(1, 'last-no-newline');
}, 10);`;

describe.each(shells)("direct Bash $display.name", (shell) => {
  it.each(["foreground", "explicit", "auto_on_timeout", "start"] as const)(
    "resolves output encoding once and reuses it for output reads (%s)",
    async (mode) => {
      const resolveEncoding = vi
        .spyOn(outputEncoding, "resolveLegacyExecutionOutputEncoding")
        .mockReturnValueOnce("gb18030")
        .mockReturnValue("cp437");
      const { adapter, request, path, release } = await fixture(
        shell,
        `const fs = require('node:fs');
const text = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
fs.writeSync(1, text);
const timer = setInterval(() => {
  if (!fs.existsSync(process.env.PROBE_RELEASE)) return;
  clearInterval(timer); fs.writeSync(2, text);
}, 10);`,
      );
      if (mode === "foreground") {
        await writeFile(release, "release");
        const outcome = await adapter.runBashWithBackgroundLifecycle(request, {
          mode: "auto_on_timeout",
        });
        expect(outcome.kind).toBe("foreground");
        if (outcome.kind === "foreground") expect(outcome.result.stdout.text).toBe("中文中文");
      } else {
        request.timeoutMs = mode === "auto_on_timeout" ? 20 : 10_000;
        const outcome =
          mode === "start"
            ? { kind: "backgrounded" as const, task: await adapter.start(request) }
            : await adapter.runBashWithBackgroundLifecycle(request, { mode });
        expect(outcome.kind).toBe("backgrounded");
        if (outcome.kind !== "backgrounded") throw new Error("expected background");
        const id = outcome.task.taskId;
        await vi.waitFor(async () => expect((await readFile(path)).length).toBe(4), {
          timeout: 5_000,
        });
        expect(await adapter.readBackgroundBashOutput(id, "probe")).toMatchObject({
          kind: "output",
          status: "running",
          output: "中文",
        });
        await writeFile(release, "release");
        const completed = await adapter.waitForBackgroundTask(id);
        expect(completed?.result?.stdout.text).toBe("中文中文");
        expect(await adapter.readBackgroundBashOutput(id, "probe")).toMatchObject({
          kind: "output",
          status: "completed",
          output: "中文中文",
        });
      }
      expect(resolveEncoding.mock.calls.length).toBe(1);
    },
  );

  it("does not probe output encoding when cancelled before preparation", async () => {
    const resolveEncoding = vi.spyOn(outputEncoding, "resolveLegacyExecutionOutputEncoding");
    const { adapter, request } = await fixture(shell, gatedWriter);
    const outcome = await adapter.runBashWithBackgroundLifecycle(
      request,
      { mode: "explicit" },
      { signal: AbortSignal.abort() },
    );
    expect(outcome).toMatchObject({ kind: "foreground", result: { status: "cancelled" } });
    expect(resolveEncoding.mock.calls.length).toBe(0);
  });

  it.each(["explicit", "auto_on_timeout"] as const)(
    "reads background output live and terminal with a bounded tail (%s)",
    async (mode) => {
      const { adapter, request, path, release } = await fixture(shell, gatedWriter);
      request.timeoutMs = 50;
      const outcome = await adapter.runBashWithBackgroundLifecycle(request, { mode });
      expect(outcome.kind).toBe("backgrounded");
      if (outcome.kind !== "backgrounded") return;
      const id = outcome.task.taskId;
      await vi.waitFor(async () => expect(await readFile(path, "utf8")).toContain("stderr-first"));
      expect(await adapter.readBackgroundBashOutput(id, "other-session")).toEqual({
        kind: "unavailable",
        workId: id,
      });
      const first = await adapter.readBackgroundBashOutput(id, "probe");
      expect(first).toMatchObject({ kind: "output", status: "running", outputPath: path });
      expect(Object.keys(first).sort()).toEqual([
        "kind",
        "output",
        "outputPath",
        "status",
        "truncated",
        "workId",
      ]);
      await writeFile(path, "old-prefix" + "x".repeat(9000) + "中文\r\nNEW");
      const second = await adapter.readBackgroundBashOutput(id, "probe");
      expect(second.kind).toBe("output");
      if (second.kind === "output") {
        expect(second.output).not.toContain("old-prefix");
        expect(second.output).toContain("中文\r\nNEW");
        expect(Buffer.byteLength(second.output)).toBeLessThanOrEqual(8192);
        expect(second.truncated).toBe(true);
      }
      await writeFile(release, "release");
      await adapter.waitForBackgroundTask(id);
      expect(await adapter.readBackgroundBashOutput(id, "probe")).toMatchObject({
        kind: "output",
        status: "completed",
      });
      await rm(path);
      expect(await adapter.readBackgroundBashOutput(id, "probe")).toMatchObject({
        kind: "read_failed",
      });
      expect(await adapter.readBackgroundBashOutput("other", "probe")).toEqual({
        kind: "unavailable",
        workId: "other",
      });
    },
  );

  it("does not expose cancellation as final while output settlement is still pending", async () => {
    const { adapter, request, path } = await fixture(shell, gatedWriter);
    const outcome = await adapter.runBashWithBackgroundLifecycle(request, { mode: "explicit" });
    if (outcome.kind !== "backgrounded") throw new Error("expected background");
    await vi.waitFor(async () => expect(await readFile(path, "utf8")).toContain("stderr-first"));
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const original = BashFileOutput.prototype.result;
    vi.spyOn(BashFileOutput.prototype, "result").mockImplementation(async function (limit) {
      await gate;
      return original.call(this, limit);
    });
    try {
      await adapter.cancelBackgroundTask(outcome.task.taskId);
      expect(await adapter.readBackgroundBashOutput(outcome.task.taskId, "probe")).toMatchObject({
        kind: "output",
        status: "running",
      });
    } finally {
      releaseRead();
    }
    await vi.waitFor(async () =>
      expect(await adapter.readBackgroundBashOutput(outcome.task.taskId, "probe")).toMatchObject({
        kind: "output",
        status: "cancelled",
      }),
    );
  });

  it("rejects generic argv tasks even when the session matches", async () => {
    const { adapter, request } = await fixture(shell, gatedWriter);
    request.command = { mode: "argv", file: process.execPath, args: ["-e", gatedWriter] };
    const task = await adapter.start(request);
    expect(await adapter.readBackgroundBashOutput(task.taskId, "probe")).toEqual({
      kind: "unavailable",
      workId: task.taskId,
    });
    await adapter.cancelBackgroundTask(task.taskId);
  });

  it.each([false, true])(
    "retains more than 64 MiB with bounded head and complete tail (lifecycle=%s)",
    async (lifecycle) => {
      const { adapter, request } = await fixture(
        shell,
        `
      const fs = require('node:fs');
      fs.writeSync(1, 'HEAD');
      const chunk = Buffer.alloc(1024 * 1024, 120);
      for (let i = 0; i < 65; i++) fs.writeSync(1, chunk);
      fs.writeSync(2, 'TAIL');
    `,
      );
      const outcome = lifecycle
        ? await adapter.runBashWithBackgroundLifecycle(request, { mode: "auto_on_timeout" })
        : undefined;
      if (outcome) expect(outcome.kind).toBe("foreground");
      const result = outcome?.kind === "foreground" ? outcome.result : await adapter.run(request);
      expect(result.stdout.text).toHaveLength(30_000);
      expect(result.stdout.text.startsWith("HEAD")).toBe(true);
      expect(result.stdout).toMatchObject({
        bytes: 65 * 1024 ** 2 + 8,
        artifactBytes: 65 * 1024 ** 2 + 8,
        artifactTruncated: false,
      });
      const file = await open(result.stdout.artifactPath!, "r");
      try {
        const size = (await file.stat()).size;
        expect(size).toBe(65 * 1024 ** 2 + 8);
        const tail = Buffer.alloc(4);
        await file.read(tail, 0, 4, size - 4);
        expect(tail.toString()).toBe("TAIL");
      } finally {
        await file.close();
      }
    },
  );

  it("does not background an exited root while its result is being read", async () => {
    const { adapter, request } = await fixture(shell, "require('node:fs').writeSync(1, 'done')");
    request.timeoutMs = 1_000;
    const original = BashFileOutput.prototype.result;
    vi.spyOn(BashFileOutput.prototype, "result").mockImplementation(async function (maxBytes) {
      const result = await original.call(this, maxBytes);
      await sleep(1_100);
      return result;
    });
    const result = await adapter.runBashWithBackgroundLifecycle(request, {
      mode: "auto_on_timeout",
    });
    expect(result.kind).toBe("foreground");
    if (result.kind === "foreground") expect(result.result.stdout.text).toBe("done");
  });

  it("writes a regular file before exit without collector or chunk events", async () => {
    const { adapter, request, path, release } = await fixture(shell, gatedWriter);
    const append = vi.spyOn(OutputCollector.prototype, "append");
    const prepare = vi.spyOn(BashFileOutput.prototype, "prepare");
    const events: ExecutionEvent[] = [];
    const running = adapter.run(request, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    await vi.waitFor(
      async () => expect(await readFile(path, "utf8")).toBe("file:true:true\nstderr-first\n"),
      { timeout: 5_000 },
    );
    await vi.waitFor(
      () =>
        expect(
          events.some(
            (event) => event.type === "progress" && event.stdoutTail?.includes("stderr-first"),
          ),
        ).toBe(true),
      { timeout: 5_000 },
    );
    expect(events.some((event) => event.type === "completed")).toBe(false);
    await writeFile(release, "go");
    const result = await running;
    expect(result.stdout.text).toBe("file:true:true\nstderr-first\nlast-no-newline");
    expect(result.stderr.text).toBe("");
    expect(append).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "stdout" || event.type === "stderr")).toBe(false);
  });

  it.each(["explicit", "auto_on_timeout"] as const)(
    "keeps the same file through %s and detaches parent abort",
    async (mode) => {
      const { adapter, request, path, release } = await fixture(shell, gatedWriter);
      request.timeoutMs = 50;
      const abort = new AbortController();
      const prepare = vi.spyOn(BashFileOutput.prototype, "prepare");
      const watch = vi.spyOn(BashFileOutput.prototype, "watchLimit");
      const launch = await adapter.runBashWithBackgroundLifecycle(
        request,
        { mode },
        { signal: abort.signal },
      );
      expect(launch.kind).toBe("backgrounded");
      if (launch.kind !== "backgrounded") throw new Error("Expected background task");
      expect(launch.task.outputPath).toBe(path);
      await vi.waitFor(async () => expect(await readFile(path, "utf8")).toContain("stderr-first"), {
        timeout: 5_000,
      });
      abort.abort();
      expect((await adapter.getBackgroundTask(launch.task.taskId))?.status).toBe("running");
      await writeFile(release, "go");
      const result = await adapter.waitForBackgroundTask(launch.task.taskId);
      expect(result?.status).toBe("completed");
      expect(result?.result?.stdout.text).toContain("last-no-newline");
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(watch).toHaveBeenCalledTimes(2);
    },
  );

  it("settles at root exit and allows inherited descendants to write afterward", async () => {
    const code = `const fs = require('node:fs'), {spawn} = require('node:child_process');
fs.writeSync(1, 'root\\n');
spawn(process.execPath, ['-e', "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.env.PROBE_RELEASE)){clearInterval(t);fs.writeSync(1,'late-out\\\\n');fs.writeSync(2,'late-err\\\\n');}},10)"], {stdio:['ignore',1,2],detached:true}).unref();`;
    const { adapter, request, path, release } = await fixture(shell, code);
    const launch = await adapter.runBashWithBackgroundLifecycle(request, { mode: "explicit" });
    if (launch.kind !== "backgrounded") throw new Error("Expected background task");
    const completed = await adapter.waitForBackgroundTask(launch.task.taskId);
    expect(completed?.result?.stdout.text).toBe("root\n");
    await writeFile(release, "go");
    await vi.waitFor(
      async () => expect(await readFile(path, "utf8")).toBe("root\nlate-out\nlate-err\n"),
      { timeout: 5_000 },
    );
    expect((await adapter.getBackgroundTask(launch.task.taskId))?.result).toEqual(
      completed?.result,
    );
    await sleep(20);
  });
});

describe.each(shells)("temporary Bash output $display.name", (shell) => {
  it.each(["run", "foreground", "explicit", "auto_on_timeout", "start"] as const)(
    "publishes one prepared file across the entire execution (%s)",
    async (mode) => {
      const { adapter, request, release, tempParent, path } = await fixture(
        shell,
        gatedWriter,
        true,
      );
      const prepare = vi.spyOn(BashFileOutput.prototype, "prepare");
      const append = vi.spyOn(OutputCollector.prototype, "append");
      const watch = vi.spyOn(BashFileOutput.prototype, "watchLimit");
      const encoding = vi.spyOn(outputEncoding, "resolveLegacyExecutionOutputEncoding");
      let actualPath: string;
      if (mode === "run" || mode === "foreground") {
        await writeFile(release, "go");
        const result =
          mode === "run"
            ? await adapter.run(request)
            : await adapter
                .runBashWithBackgroundLifecycle(request, { mode: "auto_on_timeout" })
                .then((outcome) => {
                  if (outcome.kind !== "foreground") throw new Error("expected foreground");
                  return outcome.result;
                });
        expect(result.status).toBe("completed");
        actualPath = result.stdout.artifactPath!;
      } else {
        request.timeoutMs = mode === "auto_on_timeout" ? 20 : 10_000;
        const task =
          mode === "start"
            ? await adapter.start(request)
            : await adapter.runBashWithBackgroundLifecycle(request, { mode }).then((outcome) => {
                if (outcome.kind !== "backgrounded") throw new Error("expected background");
                return outcome.task;
              });
        actualPath = task.outputPath!;
        expect(task.stdoutPersistedOutputPath).toBe(actualPath);
        // Windows Git Bash 启动可能超过默认的一秒；仍以实际输出标记确认就绪。
        await vi.waitFor(
          async () => expect(await readFile(actualPath, "utf8")).toContain("stderr-first"),
          { timeout: 5_000 },
        );
        expect(await adapter.readBackgroundBashOutput(task.taskId, "probe")).toMatchObject({
          kind: "output",
          outputPath: actualPath,
          status: "running",
        });
        await writeFile(release, "go");
        const done = await adapter.waitForBackgroundTask(task.taskId);
        expect(done?.result?.stdout.artifactPath).toBe(actualPath);
      }
      expect(relative(tempParent, actualPath)).toMatch(
        /^zcode-bash-[^/\\]+[/\\]probe[/\\]direct-stdout\.log$/,
      );
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(encoding).toHaveBeenCalledTimes(1);
      expect(append).not.toHaveBeenCalled();
      expect(watch).toHaveBeenCalled();
      expect(watch.mock.instances.every((file) => file === prepare.mock.instances[0])).toBe(true);
      expect(await readFile(actualPath, "utf8")).toBe(
        "file:true:true\nstderr-first\nlast-no-newline",
      );
      await expect(fsPromises.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await adapter.close();
      expect(await readFile(actualPath, "utf8")).toContain("last-no-newline");
    },
  );

  it.each(["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR", "ENOSPC", "EDQUOT"])(
    "reuses the configured fallback after a tmp open failure (%s)",
    async (code) => {
      const { adapter, request, release, tempParent, path } = await fixture(
        shell,
        gatedWriter,
        true,
      );
      const original = BashFileOutput.prototype.prepare;
      const attempts: string[] = [];
      vi.spyOn(BashFileOutput.prototype, "prepare").mockImplementation(async function () {
        attempts.push(this.path);
        if (this.path.startsWith(tempParent))
          throw Object.assign(new Error("tmp unavailable"), { code });
        return original.call(this);
      });
      await writeFile(release, "go");
      const started = vi.fn();
      const result = await adapter.run(request, {
        onEvent: (event) => {
          if (event.type === "started") started();
        },
      });
      expect(result.status).toBe("completed");
      expect(result.stdout.artifactPath).toBe(path);
      expect(await readFile(path, "utf8")).toBe("file:true:true\nstderr-first\nlast-no-newline");
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toBe(path);
      expect(started).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["small", "large"])("preserves foreground %s output retention in tmp", async (size) => {
    const { adapter, request, release, tempParent } = await fixture(shell, gatedWriter, true);
    request.outputLimit = {
      persistOutput: "on_truncate",
      maxInlineBytes: size === "small" ? 30_000 : 16,
    };
    const prepare = vi.spyOn(BashFileOutput.prototype, "prepare");
    await writeFile(release, "go");
    const outcome = await adapter.runBashWithBackgroundLifecycle(request, {
      mode: "auto_on_timeout",
    });
    if (outcome.kind !== "foreground") throw new Error("expected foreground");
    expect(outcome.result.status).toBe("completed");
    const path = prepare.mock.instances[0]!.path;
    expect(path.startsWith(tempParent)).toBe(true);
    if (size === "small") {
      expect(outcome.result.stdout.artifactPath).toBeUndefined();
      await expect(fsPromises.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(outcome.result.stdout.artifactPath).toBe(path);
      expect(await readFile(path, "utf8")).toContain("last-no-newline");
    }
  });

  it.each(["unexpected", "both-fail"])(
    "does not spawn after preparation failure (%s)",
    async (mode) => {
      const { adapter, request, tempParent } = await fixture(shell, gatedWriter, true);
      const attempts: string[] = [];
      vi.spyOn(BashFileOutput.prototype, "prepare").mockImplementation(async function () {
        attempts.push(this.path);
        throw Object.assign(new Error("open failed"), {
          code: mode === "both-fail" && this.path.startsWith(tempParent) ? "EACCES" : "EMFILE",
        });
      });
      const events: ExecutionEvent[] = [];
      const result = await adapter.runBashWithBackgroundLifecycle(
        request,
        { mode: "explicit" },
        {
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      expect(result).toMatchObject({ kind: "foreground", result: { status: "spawn_error" } });
      expect(events.some((event) => event.type === "started")).toBe(false);
      expect(attempts).toHaveLength(mode === "both-fail" ? 2 : 1);
    },
  );

  it("does not cache a failed tmp directory creation and shares a successful directory", async () => {
    const { adapter, request, release, tempParent, path } = await fixture(shell, gatedWriter, true);
    await rm(tempParent, { recursive: true });
    await writeFile(release, "go");
    expect((await adapter.run(request)).stdout.artifactPath).toBe(path);
    await mkdir(tempParent);
    const next = () => ({
      ...request,
      trace: { ...request.trace!, attributes: { toolCallId: crypto.randomUUID() } },
    });
    const results = await Promise.all([adapter.run(next()), adapter.run(next())]);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(results[0].stdout.artifactPath!.startsWith(tempParent)).toBe(true);
    expect(dirname(results[0].stdout.artifactPath!)).toBe(dirname(results[1].stdout.artifactPath!));
    expect(await fsPromises.readdir(tempParent)).toHaveLength(1);
  });

  it("reports preparation errors through the generic background event and result paths", async () => {
    const { adapter, request } = await fixture(shell, gatedWriter, true);
    vi.spyOn(BashFileOutput.prototype, "prepare").mockRejectedValue(
      Object.assign(new Error("too many open files"), { code: "EMFILE" }),
    );
    const events: ExecutionEvent[] = [];
    const task = await adapter.start(request, {
      onEvent: (event) => {
        events.push(event);
      },
    });
    const result = await adapter.waitForBackgroundTask(task.taskId);
    expect(result?.status).toBe("spawn_error");
    expect(task.outputPath).toBeUndefined();
    expect(events.some((event) => event.type === "started")).toBe(false);
    expect(events.some((event) => event.type === "failed")).toBe(true);
  });

  it.each(["abort", "close"] as const)(
    "releases a file when %s wins during preparation",
    async (mode) => {
      const { adapter, request } = await fixture(shell, gatedWriter, true);
      const controller = new AbortController();
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const opened = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const original = BashFileOutput.prototype.prepare;
      let file!: BashFileOutput;
      vi.spyOn(BashFileOutput.prototype, "prepare").mockImplementation(async function () {
        file = this;
        await original.call(this);
        ready();
        await gate;
      });
      const events: ExecutionEvent[] = [];
      const running = adapter.runBashWithBackgroundLifecycle(
        request,
        { mode: "explicit" },
        {
          signal: controller.signal,
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      await opened;
      let closing: Promise<void> | undefined;
      try {
        if (mode === "abort") controller.abort();
        else closing = adapter.close();
      } finally {
        release();
      }
      expect(await running).toMatchObject({ kind: "foreground", result: { status: "cancelled" } });
      await closing;
      expect(events.some((event) => event.type === "started")).toBe(false);
      expect(file.fd).toBeUndefined();
      await expect(fsPromises.stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps the configured fallback when a request is reused after a tmp success", async () => {
    const { adapter, request, release, tempParent, path } = await fixture(shell, gatedWriter, true);
    await writeFile(release, "go");
    expect((await adapter.run(request)).stdout.artifactPath!.startsWith(tempParent)).toBe(true);
    const original = BashFileOutput.prototype.prepare;
    vi.spyOn(BashFileOutput.prototype, "prepare").mockImplementation(async function () {
      if (this.path.startsWith(tempParent))
        throw Object.assign(new Error("tmp denied"), { code: "EACCES" });
      return original.call(this);
    });
    expect((await adapter.run(request)).stdout.artifactPath).toBe(path);
  });
});
