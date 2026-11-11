import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createSessionId,
  createToolCallId,
  type ExecutionPort,
  type ExecutionShellSelection,
  type SessionEvent,
} from "@zcode/contracts";
import {
  defaultPermissionConfig,
  PermissionService,
  type PermissionToolCapability,
} from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import {
  bashToolEntry,
  isBashInputConcurrencySafe,
  isBashInputReadOnly,
  prepareBashPermissionMatcher,
} from "../src/tool/handlers/bash.js";

describe("bash runtime permission capability", () => {
  it.each(["cmd", "legacy-shell"] as const)(
    "does not grant Bash read-only capability to %s commands",
    (dialect) => {
      const bashShellSelection: ExecutionShellSelection = {
        dialect,
        source: "legacy-fallback",
        display: { name: dialect },
      };
      for (const command of [String.raw`type # & python G:\temp\hello.py`, "type README.md"]) {
        const input = { command };
        const capability = resolveRuntimePermissionCapability(bashToolEntry, input, {
          bashShellSelection,
        });
        expect(capability).toMatchObject({ readOnly: false, needsApproval: true });
        for (const mode of ["build", "edit", "plan"] as const) {
          const decision = new PermissionService().checkPermission(
            { input, mode, riskLevel: capability.riskLevel, toolName: "Bash" },
            capability,
          );
          expect(decision.decision).toBe(mode === "plan" ? "deny" : "ask");
        }
        expect(
          new PermissionService().checkPermission(
            {
              input,
              mode: "build",
              planEnabled: true,
              riskLevel: capability.riskLevel,
              toolName: "Bash",
            },
            capability,
            { version: 1, allow: [{ toolName: "Bash", ruleContent: command }] },
          ).decision,
        ).toBe("deny");
      }
    },
  );

  it.each(["posix", "git-bash"] as const)("preserves read-only capability for %s", (dialect) => {
    expect(
      resolveRuntimePermissionCapability(
        bashToolEntry,
        { command: "cat README.md" },
        {
          bashShellSelection: { dialect, source: "legacy-fallback", display: { name: dialect } },
        },
      ),
    ).toMatchObject({ readOnly: true, needsApproval: false });
  });

  it.each(["build", "edit", "plan"] as const)(
    "never executes the CMD comment mismatch when denied in %s",
    async (mode) => {
      const registry = createToolRegistry();
      registry.register(bashToolEntry);
      const run = vi.fn<ExecutionPort["run"]>(async () => {
        throw new Error("Denied commands must not reach execution");
      });
      const requestPermission = vi.fn(async () => ({ decision: "deny" as const }));
      const executor = createToolExecutor({
        registry,
        permissionService: new PermissionService(),
        permissionBroker: { requestPermission },
        executionPort: { run },
        mode,
        emitEvent: async () => {},
        bashShellSelection: { dialect: "cmd", source: "user-config", display: { name: "CMD" } },
        workingDirectory: process.cwd(),
        sessionId: createSessionId(`cmd-${mode}`),
      });
      const result = await executor.execute({
        id: createToolCallId(`cmd-${mode}`),
        name: "Bash",
        input: { command: String.raw`type # & python G:\temp\hello.py` },
      });
      expect(result).toMatchObject({
        success: false,
        error: { type: CoreErrorType.PermissionDenied },
      });
      expect(requestPermission).toHaveBeenCalledTimes(mode === "plan" ? 0 : 1);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("keeps display classification separate from read-only and concurrency helpers", () => {
    expect(isBashInputReadOnly({ command: "ls" })).toBe(true);
    expect(isBashInputConcurrencySafe({ command: "ls" })).toBe(true);

    expect(isBashInputReadOnly({ command: "ls > out.txt" })).toBe(false);
    expect(isBashInputConcurrencySafe({ command: "ls > out.txt" })).toBe(false);
    expect(isBashInputReadOnly({ command: "find . -exec rm {} \\;" })).toBe(false);
    expect(isBashInputReadOnly({ command: "ls $(touch out.txt)" })).toBe(false);
    expect(isBashInputConcurrencySafe({ command: "ls $(touch out.txt)" })).toBe(false);
    expect(isBashInputReadOnly({ command: "ls `touch out.txt`" })).toBe(false);
  });

  it("uses command safe flags for tree read-only permission", () => {
    expect(isBashInputReadOnly({ command: "tree" })).toBe(true);
    expect(isBashInputReadOnly({ command: "tree -a" })).toBe(true);
    expect(isBashInputReadOnly({ command: "tree -L 2" })).toBe(true);
    expect(isBashInputReadOnly({ command: "tree --charset utf-8 src" })).toBe(true);

    expect(isBashInputReadOnly({ command: "tree -o out.txt" })).toBe(false);
    expect(isBashInputConcurrencySafe({ command: "tree -o out.txt" })).toBe(false);
    expect(isBashInputReadOnly({ command: "tree --bogus" })).toBe(false);
  });

  it("allows a minimal set of simple read-only file and search commands", () => {
    const service = new PermissionService();
    const commands = [
      "pwd",
      "whoami",
      "echo hello",
      "printf '%s\\n' hello",
      "cat README.md",
      "cat < README.md",
      "cat -n README.md",
      "fd --hidden foo src",
      "fdfind -e ts foo src",
      "head -n 20 README.md",
      "tail --lines=50 README.md",
      "wc -l README.md",
      "stat README.md",
      "file README.md",
      "base64 -d fixture.txt",
      "sha256sum package.json",
      "date +%F",
      "hostname -f",
      "man ls",
      "netstat -an",
      "ps -ef",
      "lsof -n -i",
      "pgrep -fl node",
      "pyright --outputjson",
      "ss -tuln",
      "test -f package.json",
      "tput cols",
      "strings fixture.bin",
      "jq '.scripts' package.json",
      "xargs grep -n foo",
      "sort README.md",
      "uniq README.md",
      "cut -d: -f1 README.md",
      "tr a-z A-Z README.md",
      "diff -u before.txt after.txt",
      "du -sh .",
      "docker ps --format '{{.Names}}'",
      "docker logs --tail 20 container",
      "gh pr view 123 --json title --repo owner/repo",
      "gh run list --limit 10 --json databaseId",
      "rg -n foo src",
      "rg --files src",
      "rg -g '*.ts' foo src",
      "grep -R -n foo src",
      "grep -R -n foo src 2>&1",
      "grep -R -n foo src 2>/dev/null",
      "grep --include '*.ts' foo src",
      "LC_ALL=C grep -R -n foo src",
      "command grep -R -n foo src",
      "noglob grep -R -n foo src",
    ];

    for (const command of commands) {
      expect(isBashInputReadOnly({ command }), command).toBe(true);
      expect(isBashInputConcurrencySafe({ command }), command).toBe(true);

      const decision = service.checkPermission(
        {
          input: { command },
          mode: "build",
          riskLevel: bashToolEntry.metadata.riskLevel,
          toolName: "Bash",
        },
        withRuntimeCapability({ command }),
      );
      expect(decision.decision, command).toBe("allow");
      expect(decision.ruleId, command).toBe("mode.build.readOnly");
    }
  });

  it("keeps risky flags, redirects, and dynamic words out of the read-only Bash allowlist", () => {
    const commands = [
      "cat README.md > out.txt",
      "rg --pre ./filter foo src",
      "rg --pre=./filter foo src",
      "grep foo src > out.txt",
      "cat < /dev/tcp/example.com/80",
      "cat < //server/share",
      "sed -n '1w out.txt' README.md",
      "jq -f filter.jq package.json",
      "jq 'env' package.json",
      "xargs rm -rf",
      "docker ps --context prod",
      "docker logs --host tcp://example.com container",
      "gh pr view 123 --repo https://example.com/repo",
      "date tomorrow",
      "lsof -iTCP@example.com",
      "man ./local.1",
      "pyright --watch",
      "ss dst example.com",
      "test -v PATH",
      "tput clear",
      "rg foo src $(touch out.txt)",
      "FOO=bar grep foo src",
    ];

    for (const command of commands) {
      expect(isBashInputReadOnly({ command }), command).toBe(false);
      expect(isBashInputConcurrencySafe({ command }), command).toBe(false);
    }
  });

  it.each([
    "sed -n '1,20p' README.md",
    "sed -n 'p' README.md",
    "sed -n '1p; 3p' README.md",
    "sed -nE '1p' README.md",
    "sed -En '1p' README.md",
    "sed --quiet '1p' README.md",
    "sed --silent '1p' README.md",
    "sed -nz '1p' README.md",
    "sed --quiet --regexp-extended --zero-terminated '1p' README.md",
    "sed --posix -n '1p' README.md",
    "sed -n -- '1p' README.md",
    "sed -n '1p' -",
    "sed 's/foo/bar/g'",
    "sed -- 's/foo/bar/g'",
    "sed -E 's/(foo)/\\1/g'",
    "sed -r 's/foo/bar/2gp'",
    "sed --posix 's/foo/bar/'",
    "sed 's/a\\/b/c/'",
    "sed 's/a/b\\/c/'",
    "sed 's/\\\\/x/'",
    "sed 's/foo/\\& bar/g'",
    "command sed -n '1p' README.md",
    "LC_ALL=C sed -n '1p' README.md",
    "cat README.md | sed -n '1p'",
    "cat README.md | sed 's/foo/bar/g'",
    "sed -n '1p' README.md && cat README.md",
  ])("allows only the bounded sed read-only grammar: %s", (command) => {
    const input = { command };
    const capability = withRuntimeCapability(input);
    const service = new PermissionService();
    expect(isBashInputReadOnly(input)).toBe(true);
    expect(isBashInputConcurrencySafe(input)).toBe(true);
    expect(capability).toMatchObject({
      readOnly: true,
      needsApproval: false,
      sideEffectScope: "none",
    });
    for (const context of [
      { mode: "plan" },
      { mode: "build", planEnabled: true },
      { mode: "yolo", planEnabled: true },
      { mode: "guarded", planEnabled: true },
      { mode: "build" },
    ] as const) {
      expect(
        service.checkPermission(
          { input, ...context, riskLevel: bashToolEntry.metadata.riskLevel, toolName: "Bash" },
          capability,
        ).decision,
      ).toBe("allow");
    }
  });

  it.each([
    "sed -n -e 'e printf sed-probe' README.md",
    "sed --expression='e printf sed-probe' README.md",
    "sed 'e printf sed-probe' README.md",
    "sed -n 's/.*/printf sed-probe/e' README.md",
    "sed -n 's/.*/probe/w out.txt' README.md",
    "sed 's/foo/printf sed-probe/e'",
    "sed 's/foo/bar/w out.txt'",
    "sed -e 's/foo/bar/' README.md",
    "sed -n -e '1p' README.md",
    "sed -ne '1p' README.md",
    "sed --expression='1p' README.md",
    "sed -f script.sed README.md",
    "sed --file=script.sed README.md",
    "sed -in '1p' README.md",
    "sed --in-place -n '1p' README.md",
    "sed -n '1p' README.md -e 'e printf sed-probe'",
    "sed -n -- '1p' -e 'e printf sed-probe'",
    "sed -n '1p' -- README.md",
    "sed -n '1p; e printf sed-probe' README.md",
    "sed -n '1p\ne printf sed-probe' README.md",
    "sed -n '1p\r' README.md",
    "sed -n '1p\0' README.md",
    "sed -n '0p' README.md",
    "sed -n '$p' README.md",
    "sed -n '/foo/p' README.md",
    "sed -n '1p;' README.md",
    "sed -n '' README.md",
    "sed -n",
    "sed -n --",
    "sed 's/foo/bar/g' README.md",
    "sed -n 's/foo/bar/p'",
    "sed -z 's/foo/bar/g'",
    "sed 's/foo/bar/10'",
    "sed 's/foo/bar/0'",
    "sed 's/foo/bar/;e printf sed-probe'",
    "sed 's/foo/bar/\ne printf sed-probe'",
    "sed 's#foo#bar#g'",
    "sed 's/foo/bar'",
    "sed 's/foo/bar\\/'",
    "sed 's/foo/\\x0a/g'",
    "sed 's/foo/\\cA/g'",
    "sed -n '1p' README.md > out.txt",
    "cat README.md | sed 'e printf sed-probe'",
    "sed -n '1p' README.md && sed 's/.*/printf sed-probe/e'",
    "sed --version",
    "/usr/bin/sed -n '1p' README.md",
  ])("rejects sed outside the bounded read-only grammar: %s", (command) => {
    const input = { command };
    const capability = withRuntimeCapability(input);
    const service = new PermissionService();

    expect(isBashInputReadOnly(input)).toBe(false);
    expect(isBashInputConcurrencySafe(input)).toBe(false);
    expect(capability.readOnly).toBe(false);

    for (const context of [
      { mode: "plan" },
      { mode: "build", planEnabled: true },
      { mode: "edit", planEnabled: true },
      { mode: "yolo", planEnabled: true },
      { mode: "guarded", planEnabled: true },
    ] as const) {
      expect(
        service.checkPermission(
          { input, ...context, riskLevel: bashToolEntry.metadata.riskLevel, toolName: "Bash" },
          capability,
        ),
      ).toMatchObject({ allowed: false, decision: "deny", ruleId: "mode.plan.nonReadOnly" });
    }

    expect(
      service.checkPermission(
        { input, mode: "build", riskLevel: bashToolEntry.metadata.riskLevel, toolName: "Bash" },
        capability,
      ).decision,
    ).toBe("ask");
  });

  it("keeps sed authorizations subject to Plan while preserving normal execution permissions", () => {
    const input = { command: "sed 'e printf sed-probe' README.md" };
    const capability = withRuntimeCapability(input);
    const service = new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(["Bash"]),
    });
    const projectRules = { version: 1 as const, allow: [{ toolName: "Bash" }] };

    for (const context of [
      { mode: "plan" },
      { mode: "build", planEnabled: true },
      { mode: "yolo", planEnabled: true },
      { mode: "guarded", planEnabled: true },
    ] as const) {
      expect(
        service.checkPermission(
          { input, ...context, riskLevel: bashToolEntry.metadata.riskLevel, toolName: "Bash" },
          capability,
          projectRules,
        ),
      ).toMatchObject({ decision: "deny", ruleId: "mode.plan.nonReadOnly" });
    }

    for (const mode of ["build", "yolo", "guarded"] as const) {
      expect(
        service.checkPermission(
          {
            input,
            mode,
            planEnabled: false,
            riskLevel: bashToolEntry.metadata.riskLevel,
            toolName: "Bash",
          },
          capability,
          projectRules,
        ).decision,
      ).toBe("allow");
    }
  });

  it("denies sed before execution and emits a denial without requesting approval", async () => {
    const registry = createToolRegistry();
    registry.register(bashToolEntry);
    const events: SessionEvent[] = [];
    const run = vi.fn<ExecutionPort["run"]>(async () => {
      throw new Error("Plan must not reach the execution port");
    });
    const requestPermission = vi.fn(async () => ({
      decision: "allow" as const,
      resolvedAt: new Date(),
    }));
    const executor = createToolExecutor({
      registry,
      permissionService: new PermissionService(),
      permissionBroker: { requestPermission },
      executionPort: { run },
      mode: "plan",
      workingDirectory: process.cwd(),
      workspaceRoot: process.cwd(),
      sessionId: createSessionId("sed-plan-denial"),
      emitEvent: async (event) => {
        events.push(event);
      },
    });
    const toolCallId = createToolCallId("sed-plan-call");

    const result = await executor.execute({
      id: toolCallId,
      name: "Bash",
      input: { command: "sed -n -e 'e printf sed-probe' README.md" },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      error: { type: CoreErrorType.PermissionDenied },
    });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.type === SessionEventType.PermissionDenied),
    ).toMatchObject([{ payload: { toolCallId, toolName: "Bash" } }]);
    expect(events.some((event) => event.type === SessionEventType.PermissionRequested)).toBe(false);
  });

  it("allows common read-only inspection Bash commands in plan mode", () => {
    const service = new PermissionService();

    const commands = [
      "rg -n foo src",
      'grep -R -n "already referenced\\|destination physical cluster" src/metaoscpp || true',
      "grep -R -n foo src | head -20",
      "grep -R -n foo src 2>/dev/null",
      "cat < README.md",
      'find src -name "*.ts" -maxdepth 3',
      "find src -type f -name '*.ts'",
      "git status --short",
      "git status --porcelain --branch --untracked-files=all",
      "git diff --name-only --",
      "git diff --exit-code -- src/index.ts",
      "git log --oneline -n 5",
      "git log --oneline -8 -- tests/xxx.ts",
      'grep -rn "minScore" /Users/xxxxx.test.ts; echo "=== check git blame for this test ==="; git log -1 --format="%H %s" -S "uses candidate score only" -- tests/xxx.test.ts',
      "git show --stat HEAD",
      "git ls-files --others --exclude-standard",
      "git rev-parse --show-toplevel",
      "git grep -n foo -- src",
      "git branch --show-current",
      'cd "/workspace/project" && grep -R -n "foo" src',
      'LC_ALL=C cd "/workspace/project" && grep -R -n "foo" src',
    ];

    for (const command of commands) {
      expect(isBashInputReadOnly({ command })).toBe(true);
      expect(isBashInputConcurrencySafe({ command })).toBe(true);

      const readOnlyDecision = service.checkPermission(
        {
          input: { command },
          mode: "plan",
          riskLevel: bashToolEntry.metadata.riskLevel,
          toolName: "Bash",
        },
        withRuntimeCapability({ command }),
      );
      expect(readOnlyDecision.decision).toBe("allow");
      expect(readOnlyDecision.ruleId).toBe("mode.plan.readOnly");
    }

    const writeDecision = service.checkPermission(
      {
        input: { command: "cat README.md > out.txt" },
        mode: "plan",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "cat README.md > out.txt" }),
    );
    expect(writeDecision.decision).toBe("deny");
    expect(writeDecision.ruleId).toBe("mode.plan.nonReadOnly");
  });

  it("allows the grep and fd readonly safe flags", () => {
    const commands = [
      "grep -c foo README.md",
      "grep --count foo README.md",
      "grep --color=never -n foo README.md",
      "grep --colour=never -n foo README.md",
      "grep --silent foo README.md",
      "grep -b foo README.md",
      "grep --byte-offset foo README.md",
      "grep --label stdin foo -",
      "grep -T foo README.md",
      "grep --initial-tab foo README.md",
      "grep -u foo README.md",
      "grep --unix-byte-offsets foo README.md",
      "grep -Z foo README.md",
      "grep --null foo README.md",
      "grep -z foo README.md",
      "grep --null-data foo README.md",
      "grep --group-separator='--' -A 1 foo README.md",
      "grep --no-group-separator -A 1 foo README.md",
      "grep -D read foo README.md",
      "grep --devices=read foo README.md",
      "grep -d skip foo README.md",
      "grep --line-buffered foo README.md",
      "grep -U foo README.md",
      "grep --binary foo README.md",
      "grep --help",
      "grep -V",
      "grep --version",
      "fd --ignore-case foo src",
      "fdfind --ignore-case foo src",
    ];

    for (const command of commands) {
      expect(isBashInputReadOnly({ command }), command).toBe(true);
      expect(isBashInputConcurrencySafe({ command }), command).toBe(true);
    }
  });

  it("allows the direct readonly argv branches", () => {
    const commands = [
      "node -v",
      "node --version",
      "python --version",
      "python3 --version",
      "ip addr",
      "history",
      "history 20",
      "arch",
      "arch --help",
      "ifconfig en0",
      "printf '%d\\n' 42",
      "printf -- '%s\\n' hello",
      "find . -name package.json",
      "find . -newer marker -type f",
      "cal -3",
      "uptime",
      "type grep",
      "unexpand README.md",
      "tsort graph.txt",
      "pr README.md",
    ];

    for (const command of commands) {
      expect(isBashInputReadOnly({ command }), command).toBe(true);
      expect(isBashInputConcurrencySafe({ command }), command).toBe(true);
    }
  });

  it("rejects direct readonly argv negative branches", () => {
    const commands = [
      "node -e 'console.log(1)'",
      "python -c 'print(1)'",
      "history abc",
      "arch -x",
      "printf -v name value",
      "printf '%d\\n' not-a-number",
      "printf '%s\\n' $(touch out.txt)",
      "find . -exec rm {} \\;",
      "find . -files0-from list",
      "ifconfig -a",
    ];

    for (const command of commands) {
      expect(isBashInputReadOnly({ command }), command).toBe(false);
      expect(isBashInputConcurrencySafe({ command }), command).toBe(false);
    }
  });

  it("requires approval for git runtime guard conditions", async () => {
    const service = new PermissionService();
    const testRoot = await mkdtemp(join(tmpdir(), "zcode-bash-git-guard-"));
    try {
      const normalRepo = join(testRoot, "normal-repo");
      await writeMinimalGitDir(normalRepo);
      expect(withRuntimeCapability({ command: "git status --short" }, normalRepo)?.readOnly).toBe(
        true,
      );

      const bareLike = join(testRoot, "bare-like");
      await writeGitIndicators(bareLike);
      expect(withRuntimeCapability({ command: "git status --short" }, bareLike).readOnly).toBe(
        false,
      );

      const redirected = join(testRoot, "redirected");
      const redirectedTarget = join(testRoot, "external.git");
      await mkdir(redirected, { recursive: true });
      await writeGitIndicators(redirectedTarget);
      await writeFile(join(redirected, ".git"), `gitdir: ${redirectedTarget}\n`);
      expect(withRuntimeCapability({ command: "git status --short" }, redirected).readOnly).toBe(
        false,
      );

      const decision = service.checkPermission(
        {
          input: { command: "git status --short" },
          mode: "plan",
          riskLevel: bashToolEntry.metadata.riskLevel,
          toolName: "Bash",
        },
        withRuntimeCapability({ command: "git status --short" }, bareLike),
      );
      expect(decision.decision).toBe("deny");
      expect(decision.ruleId).toBe("mode.plan.nonReadOnly");
    } finally {
      await rm(testRoot, { force: true, recursive: true });
    }
  });

  it("keeps mutating Bash commands denied in plan mode", () => {
    const service = new PermissionService();
    const commands = [
      "grep foo src > out.txt",
      "find . -exec rm {} \\;",
      "find . -delete",
      "find . -fprint out.txt",
      "git -c core.pager=cat status",
      "git -C . status --short",
      "git -C/tmp status --short",
      "git --exec-path=/tmp status",
      "git checkout main",
      'cd "/workspace/project" && git status --short',
      "git status && rm out.txt",
      "FOO=bar grep foo src",
    ];

    for (const command of commands) {
      const decision = service.checkPermission(
        {
          input: { command },
          mode: "plan",
          riskLevel: bashToolEntry.metadata.riskLevel,
          toolName: "Bash",
        },
        withRuntimeCapability({ command }),
      );
      expect(decision.decision, command).toBe("deny");
      expect(decision.ruleId, command).toBe("mode.plan.nonReadOnly");
    }
  });

  it("allows read-only Bash commands through the real permission policy", () => {
    const service = new PermissionService();

    const lsDecision = service.checkPermission(
      {
        input: { command: "ls" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "ls" }),
    );
    expect(lsDecision.decision).toBe("allow");
    expect(lsDecision.ruleId).toBe("mode.build.readOnly");

    const redirectDecision = service.checkPermission(
      {
        input: { command: "ls > out.txt" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "ls > out.txt" }),
    );
    expect(redirectDecision.decision).toBe("ask");

    const sedDecision = service.checkPermission(
      {
        input: { command: "sed -i 's/a/b/' file.txt" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "sed -i 's/a/b/' file.txt" }),
    );
    expect(sedDecision.decision).toBe("ask");

    const findExecDecision = service.checkPermission(
      {
        input: { command: "find . -exec rm {} \\;" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "find . -exec rm {} \\;" }),
    );
    expect(findExecDecision.decision).toBe("ask");

    const treeOutputDecision = service.checkPermission(
      {
        input: { command: "tree -o out.txt" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "tree -o out.txt" }),
    );
    expect(treeOutputDecision.decision).toBe("ask");

    const treeSafeFlagDecision = service.checkPermission(
      {
        input: { command: "tree -L 2" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "tree -L 2" }),
    );
    expect(treeSafeFlagDecision.decision).toBe("allow");
    expect(treeSafeFlagDecision.ruleId).toBe("mode.build.readOnly");

    const multilineDecision = service.checkPermission(
      {
        input: { command: "ls\nrm file.txt" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "ls\nrm file.txt" }),
    );
    expect(multilineDecision.decision).toBe("ask");

    const commandSubstitutionDecision = service.checkPermission(
      {
        input: { command: "ls $(touch out.txt)" },
        mode: "build",
        riskLevel: bashToolEntry.metadata.riskLevel,
        toolName: "Bash",
      },
      withRuntimeCapability({ command: "ls $(touch out.txt)" }),
    );
    expect(commandSubstitutionDecision.decision).toBe("ask");
  });

  it("prepares a conservative matcher when Bash security parsing is unavailable", () => {
    const envMatcher = prepareBashPermissionMatcher({
      command: "FOO=bar git push origin main",
    });
    expect(envMatcher?.("git push")).toBe(true);
    expect(envMatcher?.("git push:*")).toBe(true);
    expect(envMatcher?.("npm *")).toBe(true);

    const compoundMatcher = prepareBashPermissionMatcher({
      command: "ls && git status",
    });
    expect(compoundMatcher?.("ls")).toBe(true);
    expect(compoundMatcher?.("git status")).toBe(true);
    expect(compoundMatcher?.("git:*")).toBe(true);
    expect(compoundMatcher?.("rm *")).toBe(true);

    const commandSubstitutionMatcher = prepareBashPermissionMatcher({
      command: "ls $(touch out.txt)",
    });
    expect(commandSubstitutionMatcher?.("ls")).toBe(true);
    expect(commandSubstitutionMatcher?.("rm *")).toBe(true);

    const emptyMatcher = prepareBashPermissionMatcher({ command: "" });
    expect(emptyMatcher?.("anything")).toBe(false);
  });
});

function withRuntimeCapability(input: unknown, cwd = process.cwd()): PermissionToolCapability {
  const runtimeCapability = bashToolEntry.resolvePermissionCapability?.(input, {
    workingDirectory: cwd,
    workspaceRoot: cwd,
  } as never);
  return {
    ...bashToolEntry.metadata,
    ...runtimeCapability,
    permission: bashToolEntry.permission,
    ...(runtimeCapability?.permission
      ? { permission: { ...bashToolEntry.permission, ...runtimeCapability.permission } }
      : undefined),
  };
}

async function writeMinimalGitDir(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, ".git", "objects"), { recursive: true });
  await mkdir(join(repoPath, ".git", "refs"), { recursive: true });
  await writeFile(join(repoPath, ".git", "HEAD"), "ref: refs/heads/main\n");
}

async function writeGitIndicators(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, "objects"), { recursive: true });
  await mkdir(join(repoPath, "refs"), { recursive: true });
  await writeFile(join(repoPath, "HEAD"), "ref: refs/heads/main\n");
}
