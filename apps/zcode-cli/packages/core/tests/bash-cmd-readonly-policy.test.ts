import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createSessionId,
  createToolCallId,
  type ExecutionShellSelection,
  type SessionEvent,
  type ToolCallStartedPayload,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { createToolRegistry } from "../src/tool/registry.js";
import {
  isCmdExecutedShellSelection,
  isDriveQualifiedWindowsPathEntry,
  setCmdReadonlyHostForTest,
} from "../src/tool/handlers/bash-cmd-readonly-policy.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

const CMD_PATH = String.raw`C:\Windows\System32\cmd.exe`;
const SYSTEM_ROOT = String.raw`C:\Windows`;
const WINDOWS_ENV = {
  ComSpec: CMD_PATH,
  SystemRoot: SYSTEM_ROOT,
  PATH: String.raw`C:\Windows\System32;C:\Program Files\Git\cmd`,
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.PY",
};

// 模拟 Windows 文件系统里 shell 相关的 realpath：键按不区分大小写匹配，值是解析后的真实路径。
const FAKE_REALPATHS = new Map(
  [
    [SYSTEM_ROOT, SYSTEM_ROOT],
    [CMD_PATH, CMD_PATH],
    [String.raw`C:\Windows\SysWOW64\cmd.exe`, String.raw`C:\Windows\SysWOW64\cmd.exe`],
    [String.raw`C:\Links\system-cmd\cmd.exe`, CMD_PATH],
    [String.raw`C:\ws\cmd.exe`, String.raw`C:\ws\cmd.exe`],
    [String.raw`C:\Links\ws-cmd\cmd.exe`, String.raw`C:\ws\cmd.exe`],
    [String.raw`C:\x\pwsh.exe`, String.raw`C:\x\pwsh.exe`],
  ].map(([path, real]) => [path!.toLowerCase(), real!]),
);

function fakeRealpath(path: string): string | undefined {
  return FAKE_REALPATHS.get(path.toLowerCase());
}

function windowsHost(env: NodeJS.ProcessEnv = {}) {
  return { platform: "win32", env: { ...WINDOWS_ENV, ...env }, realpath: fakeRealpath };
}

const CMD_SELECTION: ExecutionShellSelection = {
  dialect: "cmd",
  display: { name: "CMD" },
  id: "cmd",
  path: CMD_PATH,
  source: "user-config",
};
const LEGACY_SELECTION: ExecutionShellSelection = {
  dialect: "legacy-shell",
  display: { name: "system shell" },
  source: "legacy-fallback",
};

const READ_ONLY_COMMANDS = [
  "dir",
  "dir /b /s src",
  "DIR",
  "type README.md",
  String.raw`findstr /n /i foo src\a.ts`,
  "where node",
  "where.exe git",
  "git status",
  "git log --oneline -10",
  "git diff",
];

const NOT_READ_ONLY_COMMANDS = [
  String.raw`type # & python x.py`,
  "dir & del x",
  "dir && del x",
  "dir | findstr a",
  "findstr a b > out.txt",
  String.raw`type %USERPROFILE%\x`,
  "dir ^& calc",
  'type "a" & calc',
  String.raw`type \\server\share\x`,
  "type //server/share/x",
  String.raw`type \??\UNC\server\share\x`,
  String.raw`dir \\?\C:\x`,
  "type con",
  "TYPE Con.txt",
  String.raw`type src\nul.txt`,
  "findstr /g:con a",
  String.raw`git -C D:\x status`,
  "git --git-dir x status",
  "git -c core.pager=calc log",
  "git push",
  "git status *",
  String.raw`C:\tools\findstr.exe a b`,
  String.raw`.\findstr a b`,
  "dir\ndel x",
  "dir\r\ndel x",
  "dir\u000bx",
  "@dir",
  "dir/b",
  "dir;x",
  "dir,x",
  "dir x=y",
  "(dir)",
  "type !x!",
  "type a`b",
  "findstr ＂a＂ b",
  "where 中文",
  "del x",
  "echo hi",
  "cmd /c dir",
  "",
];

let workingDirectory: string;

beforeEach(() => {
  workingDirectory = mkdtempSync(join(tmpdir(), "zcode-cmd-readonly-"));
  setCmdReadonlyHostForTest(windowsHost());
});

afterEach(() => {
  setCmdReadonlyHostForTest(undefined);
  rmSync(workingDirectory, { force: true, recursive: true });
});

function capabilityFor(command: string, bashShellSelection: ExecutionShellSelection) {
  return resolveRuntimePermissionCapability(
    bashToolEntry,
    { command },
    { bashShellSelection, workingDirectory, workspaceRoot: workingDirectory },
  );
}

function decisionFor(
  command: string,
  bashShellSelection: ExecutionShellSelection,
  mode: "build" | "plan",
) {
  const capability = capabilityFor(command, bashShellSelection);
  return new PermissionService().checkPermission(
    { input: { command }, mode, riskLevel: capability.riskLevel, toolName: "Bash" },
    capability,
  ).decision;
}

describe("CMD read-only Bash policy", () => {
  describe.each([
    ["cmd", CMD_SELECTION],
    ["legacy-shell on Windows", LEGACY_SELECTION],
  ] as const)("%s", (_label, selection) => {
    it.each(READ_ONLY_COMMANDS)("treats %j as read-only", (command) => {
      expect(capabilityFor(command, selection)).toMatchObject({
        needsApproval: false,
        readOnly: true,
        sideEffectScope: "none",
      });
      expect(decisionFor(command, selection, "plan")).toBe("allow");
      expect(decisionFor(command, selection, "build")).toBe("allow");
    });

    it.each(NOT_READ_ONLY_COMMANDS)("keeps %j gated", (command) => {
      expect(capabilityFor(command, selection)).toMatchObject({
        needsApproval: true,
        readOnly: false,
        sideEffectScope: "system",
      });
      expect(decisionFor(command, selection, "plan")).toBe("deny");
      expect(decisionFor(command, selection, "build")).toBe("ask");
    });
  });

  it.each([
    ["where node", "where.bat"],
    ["where node", "where.com"],
    ["where.exe git", "where.exe.bat"],
    ["git status", "git.cmd"],
    ["git status", "git.py"],
    [String.raw`findstr /n foo src\a.ts`, "findstr.exe"],
    [String.raw`findstr /n foo src\a.ts`, "findstr"],
  ])("rejects %j when the working directory contains %s", (command, fileName) => {
    expect(capabilityFor(command, CMD_SELECTION)).toMatchObject({ readOnly: true });
    writeFileSync(join(workingDirectory, fileName), "@echo off\r\ncalc\r\n");
    expect(capabilityFor(command, CMD_SELECTION)).toMatchObject({ readOnly: false });
    expect(decisionFor(command, CMD_SELECTION, "plan")).toBe("deny");
    expect(decisionFor(command, CMD_SELECTION, "build")).toBe("ask");
  });

  it("does not let same-named programs affect the CMD built-ins", () => {
    writeFileSync(join(workingDirectory, "dir.bat"), "calc\r\n");
    writeFileSync(join(workingDirectory, "type.exe"), "");
    expect(capabilityFor("dir", CMD_SELECTION)).toMatchObject({ readOnly: true });
    expect(capabilityFor("type README.md", CMD_SELECTION)).toMatchObject({ readOnly: true });
  });

  it("only looks for the program name with PATHEXT extensions and ignores directories", () => {
    mkdirSync(join(workingDirectory, "git"));
    mkdirSync(join(workingDirectory, "git.exe"));
    writeFileSync(join(workingDirectory, "git.md"), "");
    expect(capabilityFor("git status", CMD_SELECTION)).toMatchObject({ readOnly: true });
  });

  describe("PATH directories the agent can write", () => {
    let outside: string;

    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "zcode-cmd-outside-"));
    });

    afterEach(() => {
      rmSync(outside, { force: true, recursive: true });
    });

    function usePath(...entries: string[]) {
      setCmdReadonlyHostForTest(windowsHost({ PATH: [...entries, WINDOWS_ENV.PATH].join(";") }));
    }

    it("rejects a same-named program in a workspace directory on PATH", () => {
      const bin = join(workingDirectory, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      usePath(bin);
      expect(capabilityFor("git status", CMD_SELECTION)).toMatchObject({ readOnly: true });
      writeFileSync(join(bin, "git.cmd"), "@echo off\r\ncalc\r\n");
      expect(capabilityFor("git status", CMD_SELECTION)).toMatchObject({ readOnly: false });
      expect(decisionFor("git status", CMD_SELECTION, "plan")).toBe("deny");
      expect(decisionFor("git status", CMD_SELECTION, "build")).toBe("ask");
      expect(capabilityFor("where node", CMD_SELECTION)).toMatchObject({ readOnly: true });
    });

    it("checks PATH directories under the workspace root, not only under the working directory", () => {
      const scripts = join(workingDirectory, ".venv", "Scripts");
      const subdirectory = join(workingDirectory, "packages", "app");
      mkdirSync(scripts, { recursive: true });
      mkdirSync(subdirectory, { recursive: true });
      writeFileSync(join(scripts, "where.exe"), "");
      usePath(scripts);
      const capability = resolveRuntimePermissionCapability(
        bashToolEntry,
        { command: "where node" },
        {
          bashShellSelection: CMD_SELECTION,
          workingDirectory: subdirectory,
          workspaceRoot: workingDirectory,
        },
      );
      expect(capability).toMatchObject({ readOnly: false });
    });

    it("resolves links that point into the workspace", () => {
      const bin = join(workingDirectory, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "findstr.bat"), "calc\r\n");
      const link = join(outside, "linked-bin");
      symlinkSync(bin, link, "dir");
      usePath(link);
      expect(capabilityFor("findstr a b", CMD_SELECTION)).toMatchObject({ readOnly: false });
    });

    it("trusts absolute PATH directories outside the workspace", () => {
      writeFileSync(join(outside, "git.cmd"), "@echo off\r\n");
      usePath(outside);
      expect(capabilityFor("git status", CMD_SELECTION)).toMatchObject({ readOnly: true });
    });
  });

  it("rejects external programs when PATH has entries that depend on the working directory or drive", () => {
    for (const pathValue of [
      String.raw`.\bin;C:\Windows\System32`,
      "C:tools;C:\\Windows",
      // 根相对条目由 cmd.exe 按执行目录的盘符解析，可能与本进程的当前盘符不同。
      String.raw`\workspace\bin;C:\Windows\System32`,
      String.raw`%SystemRoot%\system32;C:\Windows`,
      // 双斜杠开头的条目（UNC、设备命名空间、localhost 别名）可能指回工作区，又不能为了证明不在而访问网络。
      String.raw`\\server\share\bin;C:\Windows`,
      String.raw`\\?\C:\ws\.venv\Scripts;C:\Windows`,
      String.raw`\\.\C:\ws\bin;C:\Windows`,
      String.raw`\\localhost\C$\ws\node_modules\.bin;C:\Windows`,
    ]) {
      setCmdReadonlyHostForTest({
        platform: "win32",
        env: { ComSpec: CMD_PATH, SystemRoot: SYSTEM_ROOT, Path: pathValue },
        realpath: fakeRealpath,
      });
      expect(capabilityFor("where node", CMD_SELECTION)).toMatchObject({ readOnly: false });
      expect(capabilityFor("dir", CMD_SELECTION)).toMatchObject({ readOnly: true });
    }
  });

  it("only accepts drive-qualified PATH entries", () => {
    for (const entry of [String.raw`C:\Windows`, "D:/tools"]) {
      expect(isDriveQualifiedWindowsPathEntry(entry)).toBe(true);
    }
    for (const entry of [
      String.raw`\workspace\bin`,
      "/workspace/bin",
      "C:tools",
      String.raw`.\bin`,
      "bin",
      String.raw`%SystemRoot%\system32`,
      String.raw`\\server\share\bin`,
      String.raw`\\?\C:\ws\bin`,
      String.raw`\\.\C:\ws\bin`,
      String.raw`\\localhost\C$\ws\bin`,
      "//server/share/bin",
    ]) {
      expect(isDriveQualifiedWindowsPathEntry(entry)).toBe(false);
    }
  });

  it("rejects external programs without a known working directory", () => {
    const capability = resolveRuntimePermissionCapability(
      bashToolEntry,
      { command: "where node" },
      { bashShellSelection: CMD_SELECTION },
    );
    expect(capability).toMatchObject({ readOnly: false });
  });

  it("applies the git runtime safety check", () => {
    writeFileSync(join(workingDirectory, "HEAD"), "ref: refs/heads/main\n");
    expect(capabilityFor("git status", CMD_SELECTION)).toMatchObject({ readOnly: false });
    expect(capabilityFor("dir", CMD_SELECTION)).toMatchObject({ readOnly: true });
  });

  it("only applies when the executor is the system cmd.exe", () => {
    for (const path of [
      CMD_PATH,
      String.raw`C:\WINDOWS\system32\cmd.exe`,
      String.raw`C:\Windows\SysWOW64\cmd.exe`,
      String.raw`C:\Links\system-cmd\cmd.exe`,
    ]) {
      expect(isCmdExecutedShellSelection({ ...CMD_SELECTION, path })).toBe(true);
    }
    for (const path of [
      undefined,
      // 裸名由 libuv 先在子进程 cwd（工作区）里查找。
      "cmd.exe",
      // Node 不会对正斜杠路径用 /d /s /c。
      "C:/Windows/System32/cmd.exe",
      String.raw`C:\x\pwsh.exe`,
      // 文件名是 cmd.exe，但不在系统目录，或经链接指向工作区。
      String.raw`C:\ws\cmd.exe`,
      String.raw`C:\Links\ws-cmd\cmd.exe`,
      String.raw`C:\Missing\cmd.exe`,
    ]) {
      const selection = { ...CMD_SELECTION, path };
      expect(isCmdExecutedShellSelection(selection)).toBe(false);
      expect(capabilityFor("dir", selection)).toMatchObject({ readOnly: false });
      expect(decisionFor("dir", selection, "plan")).toBe("deny");
    }

    for (const env of [
      { ComSpec: String.raw`C:\x\pwsh.exe` },
      { ComSpec: String.raw`C:\ws\cmd.exe` },
      { ComSpec: undefined },
      { SystemRoot: undefined },
      { SystemRoot: String.raw`C:\ws` },
    ]) {
      setCmdReadonlyHostForTest(windowsHost(env));
      expect(capabilityFor("dir", LEGACY_SELECTION)).toMatchObject({ readOnly: false });
    }
    setCmdReadonlyHostForTest(windowsHost({ SystemRoot: undefined, windir: SYSTEM_ROOT }));
    expect(capabilityFor("dir", LEGACY_SELECTION)).toMatchObject({ readOnly: true });
  });

  it("keeps POSIX legacy-shell (/bin/sh) without read-only grants", () => {
    setCmdReadonlyHostForTest({ platform: "linux", env: { PATH: "/usr/bin:/bin" } });
    for (const command of ["dir", "type README.md", "git status", "cat README.md", "ls"]) {
      expect(capabilityFor(command, LEGACY_SELECTION)).toMatchObject({ readOnly: false });
      expect(capabilityFor(command, CMD_SELECTION)).toMatchObject({ readOnly: false });
      expect(decisionFor(command, LEGACY_SELECTION, "plan")).toBe("deny");
    }
  });

  it.each(["posix", "git-bash"] as const)("leaves %s on the Bash AST rules", (dialect) => {
    const selection: ExecutionShellSelection = {
      dialect,
      display: { name: dialect },
      path: "/bin/bash",
      source: "auto-detected",
    };
    expect(capabilityFor("cat README.md", selection)).toMatchObject({ readOnly: true });
    expect(capabilityFor("ls -la", selection)).toMatchObject({ readOnly: true });
    expect(capabilityFor("rm -rf x", selection)).toMatchObject({ readOnly: false });
  });

  it("keeps project deny and ask rules ahead of the read-only grant", () => {
    const capability = capabilityFor("git status", CMD_SELECTION);
    for (const behavior of ["deny", "ask"] as const) {
      const decision = new PermissionService().checkPermission(
        {
          input: { command: "git status" },
          mode: "plan",
          riskLevel: capability.riskLevel,
          toolName: "Bash",
        },
        capability,
        { version: 1, [behavior]: [{ toolName: "Bash", ruleContent: "git status" }] },
      );
      expect(decision.decision).toBe(behavior);
    }
  });
});

describe("CMD read-only Bash policy through the tool executor", () => {
  async function execute(command: string, mode: "build" | "plan") {
    const registry = createToolRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register({ ...bashToolEntry, handler });
    const requestPermission = vi.fn(async () => ({ decision: "deny" as const }));
    const events: SessionEvent[] = [];
    const executor = createToolExecutor({
      registry,
      permissionService: new PermissionService(),
      permissionBroker: { requestPermission },
      mode,
      emitEvent: async (event) => {
        events.push(event);
      },
      bashShellSelection: CMD_SELECTION,
      workingDirectory,
      sessionId: createSessionId(`cmd-readonly-${mode}`),
    });
    const result = await executor.execute({
      id: createToolCallId(`cmd-readonly-${mode}`),
      name: "Bash",
      input: { command },
    });
    const started = events.find((event) => event.type === SessionEventType.ToolCallStarted);
    return {
      handler,
      requestPermission,
      result,
      started: started?.payload as ToolCallStartedPayload | undefined,
    };
  }

  it.each(["build", "plan"] as const)(
    "runs read-only CMD commands without approval in %s and reports readOnly",
    async (mode) => {
      const { handler, requestPermission, started } = await execute("type README.md", mode);
      // handler 是桩，输出过不了 Bash 的输出 schema；这里只关心权限放行和能力事件。
      expect(requestPermission).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(started).toMatchObject({ readOnly: true, sideEffectScope: "none" });
    },
  );

  it.each(["build", "plan"] as const)("never runs the CMD comment mismatch in %s", async (mode) => {
    const { handler, requestPermission, result } = await execute(
      String.raw`type # & python x.py`,
      mode,
    );
    expect(result).toMatchObject({
      success: false,
      error: { type: CoreErrorType.PermissionDenied },
    });
    expect(requestPermission).toHaveBeenCalledTimes(mode === "plan" ? 0 : 1);
    expect(handler).not.toHaveBeenCalled();
  });
});
