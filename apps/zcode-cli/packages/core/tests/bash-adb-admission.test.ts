import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CoreErrorType, createSessionId, createToolCallId, createTraceId } from "@zcode/contracts";
import type {
  BashOutput,
  ExecutionPort,
  ExecutionRequest,
  ExecutionShellSelection,
} from "@zcode/contracts";
import { NodeExecutionAdapter } from "../../adapters/src/exec/node-execution-adapter.js";
import { resolveWindowsGitBashShell } from "../../adapters/src/exec/bash-shell-provider.js";
import { PermissionService } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { bashHandler, bashToolEntry } from "../src/tool/handlers/bash.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

type Dialect = ExecutionShellSelection["dialect"];
const invocations: Array<[Dialect, string]> = [
  ["posix", "adb devices"],
  ["posix", "./adb.exe devices"],
  ["posix", "'/workspace/my tools/adb' devices"],
  ["posix", "echo before && ./adb devices"],
  ["posix", "./adb devices | cat"],
  ["posix", "echo before; adb devices"],
  ["posix", "ADB_TRACE=all adb devices"],
  ["posix", "env -u HOME adb devices"],
  ["posix", "sudo -u developer /opt/sdk/adb devices"],
  ["posix", "time -p adb devices"],
  ["posix", "command -- adb devices"],
  ["posix", "exec ./adb.exe devices"],
  ["git-bash", '"C:/project/ADB.EXE" devices'],
  ["cmd", ".\\adb.exe devices"],
  ["cmd", '"C:\\project with spaces\\AdB.ExE" devices'],
  ["cmd", "type # & .\\adb.exe devices"],
  ["cmd", "call .\\adb.cmd devices"],
  ["cmd", "a^db.exe devices"],
  ["cmd", "@adb.exe devices"],
  ["cmd", "@adb.exe devices & echo ok"],
  ["cmd", "@ adb.exe devices"],
  ["cmd", "@@ADB.EXE devices"],
  ["cmd", "@call @ adb.exe devices"],
  // legacy-shell 只是 POSIX 下的 /bin/sh 回落，Windows 不再产出，按 POSIX 语义校验工作区 adb。
  ["legacy-shell", "./adb devices"],
];
function selection(dialect: Dialect): ExecutionShellSelection {
  return { dialect, source: "user-config", display: { name: dialect } };
}
function context(executionPort: ExecutionPort, cwd: string, shell: ExecutionShellSelection) {
  return {
    toolCallId: createToolCallId("adb-admission"),
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    executionPort,
    workingDirectory: cwd,
    workspaceRoot: cwd,
    sessionId: createSessionId("adb-admission"),
    bashShellSelection: shell,
    emitEvent: async () => {},
  } satisfies ToolExecutionContext;
}
function port(result: { status: "resolved"; path: string } | { status: "workspace" | "missing" }) {
  const reached = new Error("execution reached");
  return {
    reached,
    resolveAdbExecutable: vi.fn(async () => result),
    run: vi.fn<ExecutionPort["run"]>(async () => {
      throw reached;
    }),
    runBashWithBackgroundLifecycle: vi.fn(async (_request: ExecutionRequest) => {
      throw reached;
    }),
  };
}

describe("Bash adb workspace admission", () => {
  it.each(invocations)("rejects workspace resolution in %s: %s", async (dialect, command) => {
    const execution = port({ status: "workspace" });
    for (const run_in_background of [false, true]) {
      await expect(
        bashHandler(
          { command, run_in_background },
          context(execution, process.cwd(), selection(dialect)),
        ),
      ).rejects.toMatchObject({
        type: CoreErrorType.PermissionDenied,
        context: { reason: "workspace-adb-blocked" },
      });
    }
    expect(execution.resolveAdbExecutable).toHaveBeenCalled();
    expect(execution.run).not.toHaveBeenCalled();
    expect(execution.runBashWithBackgroundLifecycle).not.toHaveBeenCalled();
  });

  it.each([
    ["posix", "adb devices", "'/opt/Android SDK/adb' devices"],
    ["posix", "echo ok && '/opt/SDK/adb' devices", "echo ok && '/opt/Android SDK/adb' devices"],
    ["posix", "env ADB_TRACE=all adb devices", "env ADB_TRACE=all '/opt/Android SDK/adb' devices"],
    ["posix", "command adb -v", "command '/opt/Android SDK/adb' -v"],
    ["legacy-shell", "adb devices", "'/opt/Android SDK/adb' devices"],
    ["cmd", "@adb.exe devices & echo ok", '@"C:\\Android SDK\\adb.exe" devices & echo ok'],
    ["cmd", "@call @ adb.exe devices", '@call @ "C:\\Android SDK\\adb.exe" devices'],
    ["git-bash", '"C:/SDK/adb.exe" devices', "'C:/Android SDK/adb.exe' devices"],
  ] as const)("pins allowed %s adb without MCP: %s", async (dialect, command, expected) => {
    const path =
      dialect === "posix" || dialect === "legacy-shell"
        ? "/opt/Android SDK/adb"
        : "C:\\Android SDK\\adb.exe";
    const execution = port({ status: "resolved", path });
    for (const run_in_background of [false, true]) {
      await expect(
        bashHandler(
          { command, run_in_background },
          context(execution, process.cwd(), selection(dialect)),
        ),
      ).rejects.toBe(execution.reached);
      expect(execution.runBashWithBackgroundLifecycle.mock.lastCall?.[0]).toMatchObject({
        command: { command: expected },
      });
    }
    expect(execution.resolveAdbExecutable).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: process.cwd(), cwd: process.cwd() }),
    );
  });

  // 回归：legacy-shell 曾额外用 CMD 解析器分析同一命令，把 POSIX 引号、heredoc 里的 adb 文本当命令名改写。
  it.each(
    (["legacy-shell", "posix"] as const).flatMap((dialect) =>
      [
        "printf '%s\\n' 'a & adb shell' > note.txt",
        "cat <<'EOF' > note.txt\nadb devices\nEOF",
        'echo "x & adb devices"',
        'git commit -m "fix & adb devices"',
      ].map((command) => [dialect, command] as const),
    ),
  )("keeps quoted or heredoc adb text in %s: %s", async (dialect, command) => {
    const execution = port({ status: "resolved", path: "/opt/sdk/adb" });
    await expect(
      bashHandler({ command }, context(execution, process.cwd(), selection(dialect))),
    ).rejects.toBe(execution.reached);
    expect(execution.runBashWithBackgroundLifecycle.mock.lastCall?.[0]).toMatchObject({
      command: { command },
    });
    expect(execution.resolveAdbExecutable).not.toHaveBeenCalled();
  });

  it.each(["build", "edit", "yolo", "guarded"] as const)(
    "approval in %s cannot allow workspace adb",
    async (mode) => {
      const registry = createToolRegistry();
      registry.register(bashToolEntry);
      const execution = port({ status: "workspace" });
      const executor = createToolExecutor({
        registry,
        permissionService: new PermissionService(),
        permissionBroker: { requestPermission: async () => ({ decision: "allow" }) },
        executionPort: execution,
        mode,
        workingDirectory: process.cwd(),
        bashShellSelection: selection("cmd"),
        sessionId: createSessionId(`adb-${mode}`),
        emitEvent: async () => {},
      });
      for (const run_in_background of [false, true]) {
        const result = await executor.execute({
          id: createToolCallId(`adb-${mode}-${run_in_background}`),
          name: "Bash",
          input: { command: "@adb.exe devices", run_in_background },
        });
        expect(result).toMatchObject({
          success: false,
          error: { type: CoreErrorType.PermissionDenied },
        });
        expect(result.error?.message).not.toContain("Use the Android MCP");
      }
      expect(execution.runBashWithBackgroundLifecycle).not.toHaveBeenCalled();
    },
  );

  it("does not start an earlier segment when a later adb is workspace-controlled", async () => {
    const execution = port({ status: "resolved", path: "/sdk/adb" });
    execution.resolveAdbExecutable
      .mockResolvedValueOnce({ status: "resolved", path: "/sdk/adb" })
      .mockResolvedValueOnce({ status: "workspace" });
    await expect(
      bashHandler(
        { command: "adb devices; ./adb devices" },
        context(execution, process.cwd(), selection("posix")),
      ),
    ).rejects.toMatchObject({ context: { reason: "workspace-adb-blocked" } });
    expect(execution.runBashWithBackgroundLifecycle).not.toHaveBeenCalled();
  });

  it("reports missing SDK/PATH without requiring MCP or executing a fallback", async () => {
    const execution = port({ status: "missing" });
    await expect(
      bashHandler(
        { command: "adb devices" },
        context(execution, process.cwd(), selection("posix")),
      ),
    ).rejects.toMatchObject({
      type: CoreErrorType.ConfigurationError,
      context: { reason: "adb-not-found" },
    });
    expect(execution.runBashWithBackgroundLifecycle).not.toHaveBeenCalled();
  });

  it.each([
    ["posix", "echo adb ./adb.exe"],
    ["posix", "command -v adb"],
    ["posix", "command -V adb"],
    ["posix", "# adb devices\nprintf ok"],
    ["posix", "./gradlew assembleDebug"],
    ["posix", "pnpm build"],
    ["posix", "python scripts/build.py"],
    ["cmd", "@node scripts/build.js"],
    ["cmd", "@pnpm build"],
    ["cmd", "@call gradlew.bat assembleDebug"],
    ["cmd", "@echo @adb.exe"],
    ["cmd", '"@adb.exe" devices'],
    ["cmd", '@"@adb.exe" devices'],
    ["cmd", "^@adb.exe devices"],
    ["cmd", ".\\@adb.exe devices"],
    ["posix", "@adb.exe devices"],
    ["git-bash", "@adb.exe devices"],
  ] as const)("preserves %s command unchanged: %s", async (dialect, command) => {
    const reached = new Error("execution reached");
    const run = vi.fn<ExecutionPort["run"]>(async () => {
      throw reached;
    });
    await expect(
      bashHandler({ command }, context({ run }, process.cwd(), selection(dialect))),
    ).rejects.toBe(reached);
    expect(run.mock.calls[0]?.[0].command).toMatchObject({ mode: "shell", command });
  });
});

const windows = process.platform === "win32";
const gitBash = windows ? await resolveWindowsGitBashShell(process.env) : undefined;
const shells: ExecutionShellSelection[] = windows
  ? [
      { ...selection("cmd"), path: process.env.ComSpec },
      ...(gitBash ? [{ ...selection("git-bash"), path: gitBash }] : []),
    ]
  : [{ ...selection("posix"), path: "/bin/bash" }];

it.each(shells)(
  "real $dialect: rejects workspace adb, allows SDK adb, builds and scripts",
  async (shell) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-adb-boundary-"));
    const workspace = join(root, "project with spaces");
    const sdk = join(root, "Android SDK");
    await mkdir(workspace);
    await mkdir(join(sdk, "platform-tools"), { recursive: true });
    const fake = join(workspace, windows ? "adb.exe" : "adb");
    const trusted = join(sdk, "platform-tools", windows ? "adb.exe" : "adb");
    const marker = join(root, "fake-executed");
    const preload = join(root, "marker.cjs");
    await writeFile(
      preload,
      `const p=require('node:path');if(p.basename(process.execPath).toLowerCase()==='adb.exe'){if(p.resolve(process.execPath).toLowerCase()===p.resolve(process.env.ADB_TEST_FAKE).toLowerCase())require('node:fs').writeFileSync(process.env.ADB_TEST_MARKER,'executed');else console.log('trusted-adb-ok');process.exit(0)}`,
    );
    if (windows) {
      await copyFile(process.execPath, fake);
      await copyFile(process.execPath, trusted);
    } else {
      await writeFile(fake, '#!/bin/sh\nprintf executed > "$ADB_TEST_MARKER"\n');
      await writeFile(trusted, "#!/bin/sh\nprintf trusted-adb-ok\n");
      await chmod(fake, 0o755);
      await chmod(trusted, 0o755);
    }
    const adapter = new NodeExecutionAdapter({
      outputRootDir: join(root, "output"),
      processEnv: {
        ...process.env,
        ANDROID_HOME: sdk,
        ANDROID_SDK_ROOT: sdk,
        ANDROID_PLUGIN_SDK_PATH: sdk,
        PATH: [workspace, ".", process.env.PATH ?? ""].join(delimiter),
        ADB_TEST_FAKE: fake,
        ADB_TEST_MARKER: marker,
        NODE_OPTIONS: `--require "${preload}"`,
      },
    });
    const ctx = context(adapter, workspace, shell);
    const quote = (file: string) =>
      shell.dialect === "cmd"
        ? `"${file}"`
        : `'${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    try {
      expect(
        await adapter.run({ command: { mode: "argv", file: fake }, cwd: workspace }),
      ).toMatchObject({ exitCode: 0 });
      expect(await readFile(marker, "utf8")).toBe("executed");
      await rm(marker);
      for (const command of [
        quote(fake) + " devices",
        (shell.dialect === "cmd" ? ".\\adb.exe" : windows ? "./adb.exe" : "./adb") + " devices",
        ...(shell.dialect === "cmd" ? ["@.\\adb.exe devices & echo ok"] : []),
      ]) {
        for (const run_in_background of [false, true]) {
          await expect(bashHandler({ command, run_in_background }, ctx)).rejects.toMatchObject({
            context: { reason: "workspace-adb-blocked" },
          });
          await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      for (const command of [
        quote(trusted) + " devices",
        "adb devices",
        ...(shell.dialect === "cmd" ? ["@adb.exe devices & echo ok"] : []),
      ]) {
        for (const run_in_background of [false, true]) {
          const result = (await bashHandler({ command, run_in_background }, ctx)) as BashOutput;
          if (run_in_background) {
            const completed = await adapter.waitForBackgroundTask(result.backgroundTaskId!);
            expect(completed?.result).toMatchObject({ exitCode: 0 });
            expect(completed?.result?.stdout.text).toContain("trusted-adb-ok");
          } else {
            expect(result).toMatchObject({ exitCode: 0 });
            expect(result.stdout).toContain("trusted-adb-ok");
          }
          await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      if (!windows) {
        const external = join(root, "bin");
        await mkdir(external);
        await symlink(fake, join(external, "adb"));
        await symlink(trusted, join(workspace, "sdk-adb"));
        for (const file of [join(external, "adb"), join(workspace, "sdk-adb")]) {
          expect(
            await adapter.resolveAdbExecutable({ file, cwd: workspace, workspaceRoot: workspace }),
          ).toEqual({ status: "workspace" });
        }
        await rm(join(external, "adb"));
        await symlink(trusted, join(external, "adb"));
        expect(
          await adapter.resolveAdbExecutable({
            file: join(external, "adb"),
            cwd: workspace,
            workspaceRoot: workspace,
          }),
        ).toEqual({ status: "resolved", path: await realpath(trusted) });
      }
      await writeFile(join(workspace, "script.cjs"), 'console.log("project-script-ok");');
      const node = quote(process.execPath);
      for (const prefix of shell.dialect === "cmd" ? ["", "@"] : [""]) {
        const result = (await bashHandler(
          { command: `${prefix}${node} script.cjs` },
          ctx,
        )) as BashOutput;
        expect(result).toMatchObject({ exitCode: 0 });
        expect(result.stdout).toContain("project-script-ok");
      }
      const tsc = quote(createRequire(import.meta.url).resolve("typescript/lib/tsc.js"));
      await writeFile(
        join(workspace, "main.ts"),
        'const message: string = "build-ok"; console.log(message);',
      );
      await writeFile(
        join(workspace, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { outDir: "dist", types: [] }, files: ["main.ts"] }),
      );
      const cmd = shell.dialect === "cmd";
      const wrapper = cmd ? "build.cmd" : "build.sh";
      await writeFile(
        join(workspace, wrapper),
        `${cmd ? "@echo off\r\n" : "#!/bin/sh\n"}${node} ${tsc} -p tsconfig.json\n`,
      );
      if (!cmd) await chmod(join(workspace, wrapper), 0o755);
      for (const command of shell.dialect === "cmd"
        ? [".\\build.cmd", "@call build.cmd"]
        : ["./" + wrapper]) {
        await rm(join(workspace, "dist"), { recursive: true, force: true });
        expect(await bashHandler({ command }, ctx)).toMatchObject({ exitCode: 0 });
        expect(await readFile(join(workspace, "dist", "main.js"), "utf8")).toContain("build-ok");
      }
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("resolves bare adb from absolute PATH without searching cwd or relative entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-adb-path-"));
  const workspace = join(root, "project");
  const external = join(root, "project-tools");
  const name = windows ? "adb.exe" : "adb";
  const env = {
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    PATH: ["", ".", "relative", workspace, external].join(delimiter),
  };
  const adapter = new NodeExecutionAdapter({ processEnv: env });
  const input = { file: name, cwd: workspace, workspaceRoot: workspace };
  try {
    await mkdir(join(workspace, "sub"), { recursive: true });
    await mkdir(external);
    await writeFile(join(workspace, name), "fake");
    await writeFile(join(external, name), "trusted");
    await chmod(join(external, name), 0o755);
    const expected = { status: "resolved", path: await realpath(join(external, name)) };
    expect(await adapter.resolveAdbExecutable(input)).toEqual(expected);
    // 裸命令固定到外部 PATH；显式项目路径不能被同名外部工具替换。
    expect(await adapter.resolveAdbExecutable({ ...input, file: "./" + name })).toEqual({
      status: "workspace",
    });
    expect(
      await adapter.resolveAdbExecutable({
        ...input,
        cwd: join(workspace, "sub"),
        file: "../" + name,
      }),
    ).toEqual({ status: "workspace" });
    expect(
      await adapter.resolveAdbExecutable({ ...input, file: join(external, "missing", name) }),
    ).toEqual({ status: "missing" });
    await rm(join(external, name));
    expect(await adapter.resolveAdbExecutable(input)).toEqual({ status: "workspace" });
    const noPath = new NodeExecutionAdapter({ processEnv: { ...env, PATH: "" } });
    try {
      expect(await noPath.resolveAdbExecutable(input)).toEqual({ status: "missing" });
    } finally {
      await noPath.close();
    }
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
