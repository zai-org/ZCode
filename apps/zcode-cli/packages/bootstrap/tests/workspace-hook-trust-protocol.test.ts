import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import { grantWorkspaceHookTrustForProtocol } from "../src/zcode-protocol/workspace-hook-trust.js";
import { notifyWorkspaceHookTrustGrantSessions } from "../src/zcode-protocol/server.js";

const BUNDLE = "b".repeat(64);
const DIGEST = "a".repeat(64);

function userDecidesPolicyProvider(): InMemoryWorkspaceHookPolicyProvider {
  return new InMemoryWorkspaceHookPolicyProvider({
    mode: "user_decides",
    policyRevision: "test:user-decides:v1",
  });
}

describe("workspace Hook Trust protocol operation", () => {
  it("maps the trusted host workspace request to exact canonical pretrust input", async () => {
    const grant = vi.fn(async () => ({
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
      reasonCode: "workspace_hooks_trusted_persistent" as const,
      items: [
        {
          reviewItemId: "item-0",
          event: "SessionStart",
          matcher: null,
          displayCommand: "echo project",
          sourcePath: ".zcode/config.json",
          configuredEnabled: false,
          hookDeclarationDigest: DIGEST,
          trustState: "trusted_persistent" as const,
        },
      ],
    }));

    await expect(
      grantWorkspaceHookTrustForProtocol(
        {
          workspace: {
            workspacePath: "/repo",
            workspaceIdentity: "workspace:repo",
            workspaceKey: "workspace:repo",
          },
          bundleDigest: BUNDLE,
          hookDeclarationDigest: DIGEST,
        },
        { appVersion: "test", grant, policyProvider: userDecidesPolicyProvider() },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(grant).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
      hookDeclarationDigests: [DIGEST],
      appVersion: "test",
    });
  });

  it.each([
    {
      policy: {
        mode: "deny" as const,
        reason: "managed",
        policyRevision: "test:deny:v1",
      },
      reasonCode: "workspace_hooks_blocked_by_policy",
    },
    {
      policy: {
        mode: "allow_trusted_only" as const,
        policyRevision: "test:pretrust:v1",
      },
      reasonCode: "workspace_hooks_policy_requires_pretrust",
    },
  ])(
    "rejects Settings pretrust before mutation for $policy.mode",
    async ({ policy, reasonCode }) => {
      const grant = vi.fn();

      await expect(
        grantWorkspaceHookTrustForProtocol(
          {
            workspace: {
              workspacePath: "/repo",
              workspaceIdentity: "workspace:repo",
              workspaceKey: "workspace:repo",
            },
            bundleDigest: BUNDLE,
            hookDeclarationDigest: DIGEST,
          },
          {
            grant,
            policyProvider: new InMemoryWorkspaceHookPolicyProvider(policy),
          },
        ),
      ).resolves.toEqual({ accepted: false, reasonCode });
      expect(grant).not.toHaveBeenCalled();
    },
  );

  it("fails closed before mutation when the managed policy provider is unavailable", async () => {
    const grant = vi.fn();

    await expect(
      grantWorkspaceHookTrustForProtocol(
        {
          workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
          bundleDigest: BUNDLE,
          hookDeclarationDigest: DIGEST,
        },
        {
          grant,
          policyProvider: {
            getPolicy: () => {
              throw new Error("managed policy unavailable");
            },
            subscribe: () => () => undefined,
          },
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_blocked_by_policy",
    });
    expect(grant).not.toHaveBeenCalled();
  });

  it("returns a stable rejection for a known public reason code", async () => {
    await expect(
      grantWorkspaceHookTrustForProtocol(
        {
          workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
          bundleDigest: BUNDLE,
          hookDeclarationDigest: DIGEST,
        },
        {
          policyProvider: userDecidesPolicyProvider(),
          grant: vi.fn(async () => {
            throw new Error("workspace_hooks_bundle_changed");
          }),
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_bundle_changed",
    });
  });

  it("redacts absolute paths and arbitrary implementation messages from protocol reasonCode", async () => {
    const internalMessage =
      "Unable to read Workspace Hook config: /Users/alice/private/repo/.zcode/config.json";
    const result = await grantWorkspaceHookTrustForProtocol(
      {
        workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
        bundleDigest: BUNDLE,
        hookDeclarationDigest: DIGEST,
      },
      {
        policyProvider: userDecidesPolicyProvider(),
        grant: vi.fn(async () => {
          throw new Error(internalMessage);
        }),
      },
    );

    expect(result).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_config_unreadable",
    });
  });

  it("does not trust arbitrary workspace_hooks_ prefixed implementation messages", async () => {
    await expect(
      grantWorkspaceHookTrustForProtocol(
        {
          workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
          bundleDigest: BUNDLE,
          hookDeclarationDigest: DIGEST,
        },
        {
          policyProvider: userDecidesPolicyProvider(),
          grant: vi.fn(async () => {
            throw new Error("workspace_hooks_internal_path_/Users/alice");
          }),
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_config_unreadable",
    });
  });
});

// P2 回归：Settings pretrust 授权成功后，server 必须按 Trust identity（D23）通知同 workspace
// 的全部活跃 session 重载 Trust store（否则运行中 session 的 coordinator 内存镜像
// 停留旧值：已信任 Hook 继续被拒、banner pendingCount 不刷新）。
describe("notifyWorkspaceHookTrustGrantSessions fan-out", () => {
  function fakeSessionRecord(
    workspaceKey: string,
    workspacePath: string,
    workspaceIdentity?: string,
  ) {
    const reload = vi.fn(async () => undefined);
    return {
      reload,
      record: {
        app: { reloadWorkspaceHookTrust: reload },
        workspace: {
          workspaceKey,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
      } as never,
    };
  }

  it("notifies every live session of the granted workspace and skips others", async () => {
    const grantedA1 = fakeSessionRecord("workspace:repo-a", "/repo-a", "workspace:repo-a");
    const grantedA2 = fakeSessionRecord("workspace:repo-a", "/repo-a", "workspace:repo-a");
    const otherB = fakeSessionRecord("workspace:repo-b", "/repo-b", "workspace:repo-b");
    const sessions = new Map([
      ["s-a1", grantedA1.record],
      ["s-a2", grantedA2.record],
      ["s-b1", otherB.record],
    ]);

    await notifyWorkspaceHookTrustGrantSessions({
      grantedWorkspace: {
        workspaceKey: "workspace:repo-a",
        workspacePath: "/repo-a",
        workspaceIdentity: "workspace:repo-a",
      },
      sessions,
    });

    expect(grantedA1.reload).toHaveBeenCalledTimes(1);
    expect(grantedA2.reload).toHaveBeenCalledTimes(1);
    expect(otherB.reload).not.toHaveBeenCalled();
  });

  it("is a safe no-op without a granted workspace key", async () => {
    const session = fakeSessionRecord("workspace:repo-a", "/repo-a");
    await notifyWorkspaceHookTrustGrantSessions({
      grantedWorkspace: undefined,
      sessions: new Map([["s1", session.record]]),
    });
    expect(session.reload).not.toHaveBeenCalled();
  });
});
