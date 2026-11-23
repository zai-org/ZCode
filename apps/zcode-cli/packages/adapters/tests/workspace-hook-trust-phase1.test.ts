import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConfig } from "../src/config/index.js";

async function createWorkspace(options: { git?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-phase1-"));
  if (options.git !== false) await mkdir(join(root, ".git"));
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function projectHooks(command: Record<string, unknown>, root: Record<string, unknown> = {}) {
  return {
    hooks: {
      enabled: true,
      ...root,
      events: {
        SessionStart: [{ matcher: "startup", hooks: [command] }],
      },
    },
  };
}

async function snapshotFor(
  root: string,
  value: unknown,
  options: { projectConfigPath?: string; workspaceIdentity?: string } = {},
) {
  const path = join(root, ".zcode", "config.json");
  await writeJson(path, value);
  const result = createConfig({
    env: {},
    skipUserConfig: true,
    workingDirectory: root,
    workspaceIdentity: options.workspaceIdentity,
    projectConfigPath: options.projectConfigPath,
  });
  return { path, result, snapshot: result.sources.project.workspaceHookSnapshot };
}

describe("workspace hook trust phase 1 discovery", () => {
  it("保留 immutable project candidates 和 provenance，但仍不进入 executable runtime hooks", async () => {
    const root = await createWorkspace();
    try {
      await writeJson(
        join(root, "zcode.json"),
        projectHooks({ type: "command", command: "echo ancestor", async: true }),
      );
      await writeJson(
        join(root, ".zcode", "config.json"),
        projectHooks({ type: "process", command: "node", args: ["hook.mjs"] }),
      );

      const result = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: root,
        workspaceIdentity: "workspace:test",
      });
      const snapshot = result.sources.project.workspaceHookSnapshot;

      expect(snapshot).toBeDefined();
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        // 非远程的自报 identity 不进入 Hook Trust，按执行目录计算（D23）。
        workspaceIdentity: root,
        digestAlgorithm: "sha256",
      });
      expect(snapshot?.sourceFiles).toHaveLength(2);
      expect(
        snapshot?.sourceFiles.map((source) => [source.configFileKind, source.editable]),
      ).toEqual([
        ["zcode.json", false],
        [".zcode/config.json", true],
      ]);
      expect(snapshot?.hooks).toHaveLength(2);
      expect(snapshot?.hooks[0]).toMatchObject({
        type: "command",
        command: "echo ancestor",
        async: true,
        editable: false,
      });
      expect(snapshot?.hooks[1]).toMatchObject({
        type: "process",
        command: "node",
        args: ["hook.mjs"],
        editable: true,
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot?.hooks)).toBe(true);

      expect(result.config.hooks.enabled).toBe(false);
      expect(result.config.hooks.events.SessionStart).toBeUndefined();
      expect(result.sources.project.diagnostics).toContainEqual(
        expect.objectContaining({ code: "config_project_hooks_pending_trust", path: "hooks" }),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("复用 runner timeout/max-output resolver，并规范化语义等价 timeout", async () => {
    const root = await createWorkspace();
    try {
      const first = await snapshotFor(
        root,
        projectHooks(
          { type: "command", command: "echo timeout", timeout: 30 },
          { timeoutMs: 7_000, maxOutputBytes: 4_096 },
        ),
      );
      const firstEntry = first.snapshot?.hooks[0];
      expect(firstEntry).toMatchObject({
        resolvedTimeoutMs: 30_000,
        resolvedMaxOutputBytes: 4_096,
      });

      const second = await snapshotFor(
        root,
        projectHooks(
          { type: "command", command: "echo timeout", timeoutMs: 30_000 },
          { timeoutMs: 7_000, maxOutputBytes: 4_096 },
        ),
      );
      expect(second.snapshot?.hooks[0]?.hookDeclarationDigest).toBe(
        firstEntry?.hookDeclarationDigest,
      );

      const third = await snapshotFor(
        root,
        projectHooks(
          { type: "command", command: "echo timeout" },
          { timeoutMs: 8_000, maxOutputBytes: 8_192 },
        ),
      );
      expect(third.snapshot?.hooks[0]).toMatchObject({
        resolvedTimeoutMs: 8_000,
        resolvedMaxOutputBytes: 8_192,
      });
      expect(third.snapshot?.hooks[0]?.hookDeclarationDigest).not.toBe(
        firstEntry?.hookDeclarationDigest,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("只 hash Runtime 消费字段：status/unknown 不变，async/shell 会改变 declaration digest", async () => {
    const root = await createWorkspace();
    try {
      const base = await snapshotFor(
        root,
        projectHooks({
          type: "command",
          command: "echo canonical",
          statusMessage: "one",
          futureField: "ignored-a",
        }),
      );
      const baseDigest = base.snapshot?.hooks[0]?.hookDeclarationDigest;

      const presentationOnly = await snapshotFor(
        root,
        projectHooks({
          futureField: "ignored-b",
          statusMessage: "two",
          command: "echo canonical",
          type: "command",
        }),
      );
      expect(presentationOnly.snapshot?.hooks[0]?.hookDeclarationDigest).toBe(baseDigest);

      const asyncChanged = await snapshotFor(
        root,
        projectHooks({ type: "command", command: "echo canonical", async: true }),
      );
      expect(asyncChanged.snapshot?.hooks[0]?.hookDeclarationDigest).not.toBe(baseDigest);

      const shellChanged = await snapshotFor(
        root,
        projectHooks({ type: "command", command: "echo canonical", shell: true }),
      );
      expect(shellChanged.snapshot?.hooks[0]?.hookDeclarationDigest).not.toBe(baseDigest);
      expect(shellChanged.snapshot?.hooks[0]?.hookDeclarationDigest).not.toBe(
        asyncChanged.snapshot?.hooks[0]?.hookDeclarationDigest,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("configured gates 只改变 bundle digest，且 hooks.enabled 缺省遵循 Runtime 语义", async () => {
    const root = await createWorkspace();
    try {
      const configPath = join(root, ".zcode", "config.json");
      await writeJson(configPath, {
        hooks: {
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo gate", enabled: true }] }],
          },
        },
      });
      const missingEnabled = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: root,
      });
      const missingSnapshot = missingEnabled.sources.project.workspaceHookSnapshot;
      expect(missingSnapshot?.hooks[0]).toMatchObject({
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: false,
        configuredEnabled: false,
      });

      await writeJson(configPath, {
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo gate", enabled: true }] }],
          },
        },
      });
      const enabled = createConfig({ env: {}, skipUserConfig: true, workingDirectory: root });
      const enabledSnapshot = enabled.sources.project.workspaceHookSnapshot;
      expect(enabledSnapshot?.hooks[0]).toMatchObject({
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: true,
        configuredEnabled: true,
      });
      expect(enabledSnapshot?.hooks[0]?.hookDeclarationDigest).toBe(
        missingSnapshot?.hooks[0]?.hookDeclarationDigest,
      );
      expect(enabledSnapshot?.bundleDigest).not.toBe(missingSnapshot?.bundleDigest);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("JSON 空白/key 排列不影响 digest，显式 projectConfigPath 进入 provenance", async () => {
    const root = await createWorkspace();
    try {
      const configPath = join(root, ".zcode", "config.json");
      await mkdir(join(root, ".zcode"), { recursive: true });
      await writeFile(
        configPath,
        '{"hooks":{"events":{"SessionStart":[{"hooks":[{"command":"echo stable","type":"command"}]}]},"enabled":true}}',
        "utf8",
      );
      const first = createConfig({ env: {}, skipUserConfig: true, workingDirectory: root });

      await writeFile(
        configPath,
        '{\n  "hooks": {\n    "enabled": true,\n    "events": {\n      "SessionStart": [{"hooks": [{"type": "command", "command": "echo stable"}]}]\n    }\n  }\n}\n',
        "utf8",
      );
      const second = createConfig({ env: {}, skipUserConfig: true, workingDirectory: root });
      expect(second.sources.project.workspaceHookSnapshot?.bundleDigest).toBe(
        first.sources.project.workspaceHookSnapshot?.bundleDigest,
      );

      const explicitPath = join(root, "explicit-hooks.json");
      await writeJson(explicitPath, projectHooks({ type: "command", command: "echo explicit" }));
      const explicit = createConfig({
        env: {},
        skipUserConfig: true,
        workingDirectory: root,
        projectConfigPath: explicitPath,
      });
      expect(explicit.sources.project.workspaceHookSnapshot?.sourceFiles.at(-1)).toMatchObject({
        canonicalPath: explicitPath,
        configFileKind: "explicit",
        explicitProjectConfig: true,
        editable: false,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("非 Git workspace 只扫描 cwd，不纳入父目录 project hooks", async () => {
    const parent = await createWorkspace({ git: false });
    const child = join(parent, "child");
    try {
      await mkdir(child, { recursive: true });
      await writeJson(
        join(parent, "zcode.json"),
        projectHooks({ type: "command", command: "echo parent" }),
      );
      await writeJson(
        join(child, ".zcode", "config.json"),
        projectHooks({ type: "command", command: "echo child" }),
      );

      const result = createConfig({ env: {}, skipUserConfig: true, workingDirectory: child });
      expect(result.sources.project.workspaceHookSnapshot?.hooks).toHaveLength(1);
      expect(result.sources.project.workspaceHookSnapshot?.hooks[0]?.command).toBe("echo child");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("无效 project Hook schema fail closed，不创建 snapshot", async () => {
    const root = await createWorkspace();
    try {
      const configPath = join(root, ".zcode", "config.json");
      await writeJson(configPath, projectHooks({ type: "process", command: "" }));
      const result = createConfig({ env: {}, skipUserConfig: true, workingDirectory: root });

      expect(result.sources.project.workspaceHookSnapshot).toBeUndefined();
      expect(result.sources.project.diagnostics).toContainEqual(
        expect.objectContaining({ code: "config_file_invalid", filePath: configPath }),
      );
      expect(result.config.hooks.events.SessionStart).toBeUndefined();
      await expect(readFile(configPath, "utf8")).resolves.toContain('"command": ""');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
