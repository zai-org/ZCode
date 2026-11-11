import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceHookTrustCliStatus } from "@zcode/bootstrap";
import type { RunContext } from "@zcode/shared-types";
import { run } from "../src/run.js";

type CapturedWriteStream = NodeJS.WriteStream & { output(): string };

function stream(): CapturedWriteStream {
  let output = "";
  return {
    output: () => output,
    write(chunk: string | Uint8Array): boolean {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    },
  } as CapturedWriteStream;
}

function context(argv: string[]): RunContext & {
  stdout: CapturedWriteStream;
  stderr: CapturedWriteStream;
} {
  return {
    argv,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: stream(),
    stderr: stream(),
  };
}

function status(overrides: Partial<WorkspaceHookTrustCliStatus> = {}): WorkspaceHookTrustCliStatus {
  return {
    workspacePath: "/repo",
    workspaceIdentity: "/repo",
    bundleDigest: "b".repeat(64),
    reasonCode: "workspace_hooks_pending_trust",
    items: [
      {
        reviewItemId: "item-1",
        event: "SessionStart",
        matcher: "startup",
        displayCommand: "./start.sh",
        sourcePath: ".zcode/config.json",
        configuredEnabled: true,
        hookDeclarationDigest: "a".repeat(64),
        trustState: "pending_trust",
      },
    ],
    ...overrides,
  };
}

test("hooks trust status emits stable JSON and resolves a local workspace path", async () => {
  const ctx = context(["hooks", "trust", "status", "--workspace", "./repo", "--json"]);
  const code = await run(ctx, {
    cwd: () => "/work",
    inspectWorkspaceHookTrust: async (target) => {
      assert.equal(target.workspacePath, "/work/repo");
      assert.equal(target.workspaceIdentity, undefined);
      return status({ workspacePath: "/work/repo", workspaceIdentity: "/work/repo" });
    },
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(ctx.stdout.output()).reasonCode, "workspace_hooks_pending_trust");
  assert.equal(ctx.stderr.output(), "");
});

test("hooks trust grant binds all-current to the exact bundle digest", async () => {
  const bundleDigest = "b".repeat(64);
  const ctx = context([
    "hooks",
    "trust",
    "grant",
    "--workspace",
    "/repo",
    "--all-current",
    "--bundle-digest",
    bundleDigest,
  ]);
  const code = await run(ctx, {
    grantWorkspaceHookTrust: async (input) => {
      assert.equal(input.workspacePath, "/repo");
      assert.equal(input.allCurrent, true);
      assert.equal(input.bundleDigest, bundleDigest);
      return status({ reasonCode: "workspace_hooks_trusted_persistent" });
    },
  });

  assert.equal(code, 0);
  assert.match(ctx.stdout.output(), /workspace_hooks_trusted_persistent/);
});

test("hooks trust status treats remote identity as identity and inspects the current host path", async () => {
  const ctx = context([
    "hooks",
    "trust",
    "status",
    "--workspace",
    "remote:ssh:host:/repo",
    "--json",
  ]);
  const code = await run(ctx, {
    cwd: () => "/mounted/repo",
    inspectWorkspaceHookTrust: async (target) => {
      assert.equal(target.workspacePath, "/mounted/repo");
      assert.equal(target.workspaceIdentity, "remote:ssh:host:/repo");
      return status({
        workspacePath: "/mounted/repo",
        workspaceIdentity: "remote:ssh:host:/repo",
      });
    },
  });
  assert.equal(code, 0);
});

test("hooks trust failures use structured reasonCode in JSON mode", async () => {
  const ctx = context([
    "hooks",
    "trust",
    "grant",
    "--workspace",
    "/repo",
    "--all-current",
    "--bundle-digest",
    "c".repeat(64),
    "--json",
  ]);
  const code = await run(ctx, {
    grantWorkspaceHookTrust: async () => {
      throw new Error("workspace_hooks_bundle_changed");
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(ctx.stdout.output()), {
    accepted: false,
    reasonCode: "workspace_hooks_bundle_changed",
  });
  assert.equal(ctx.stderr.output(), "");
});

test("hooks trust status 在受管 worktree 中提示命令回填当前路径，而不是源仓库 Trust identity", async () => {
  const ctx = context([
    "hooks",
    "trust",
    "status",
    "--workspace",
    "/data/.zcode/worktrees/3f2a/repo",
  ]);
  const code = await run(ctx, {
    inspectWorkspaceHookTrust: async () =>
      status({
        workspacePath: "/data/.zcode/worktrees/3f2a/repo",
        workspaceIdentity: "/projects/repo",
      }),
  });
  assert.equal(code, 0);
  const output = ctx.stdout.output();
  assert.match(output, /workspace: \/projects\/repo/);
  assert.match(output, /grant --workspace "?\/data\/\.zcode\/worktrees\/3f2a\/repo"?/);
  assert.doesNotMatch(output, /grant --workspace "?\/projects\/repo/);
});
