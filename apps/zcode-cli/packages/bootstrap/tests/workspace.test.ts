import { describe, expect, it } from "vitest";
import {
  WORKTREE_CWD_LOCAL_ONLY,
  buildWorkspaceRef,
  resolveResumeWorkspaceRef,
  resolveWorkspaceRefFromId,
  workspaceRefWithCwd,
} from "../src/zcode-protocol/workspace.js";

describe("resolveWorkspaceRefFromId", () => {
  it("带显式 user 的 WSL identity 还原真实 working directory", () => {
    const workspaceIdentity = "remote:wsl:Ubuntu-24.04:dev:/home/dev/coding/DEMO-ERP-NEW";

    expect(resolveWorkspaceRefFromId(workspaceIdentity)).toEqual({
      workspaceIdentity,
      workspaceKey: workspaceIdentity,
      workspacePath: "/home/dev/coding/DEMO-ERP-NEW",
    });
  });

  it("本地 workspacePath 保持 fallback 语义", () => {
    expect(resolveWorkspaceRefFromId("/Users/dev/workspace")).toEqual({
      workspaceIdentity: undefined,
      workspaceKey: "/Users/dev/workspace",
      workspacePath: "/Users/dev/workspace",
    });
  });

  it("非法 remote identity 不得回退为本地路径", () => {
    expect(() => resolveWorkspaceRefFromId("remote:wsl:Ubuntu-24.04")).toThrow(
      "Invalid remote workspace identity",
    );
  });
});

describe("workspaceRefWithCwd（受管 worktree：workspace key 不变，只换执行路径）", () => {
  const project = buildWorkspaceRef({ workspacePath: "/Users/dev/project" });
  const cwd = "/Users/dev/.zcode/worktrees/3f2a/project";

  it("本地 workspace：key 保持项目，workspacePath 换成 cwd", () => {
    expect(workspaceRefWithCwd(project, cwd)).toEqual({
      workspaceKey: "/Users/dev/project",
      workspacePath: cwd,
    });
  });

  it.each([
    resolveWorkspaceRefFromId("remote:ssh:example.test:22:coder:/workspace/project"),
    // 非法 remote 前缀的 key 也按 local-only 拒绝。
    { workspaceKey: "remote:wsl:Ubuntu-24.04", workspacePath: "/workspace/project" },
  ])("远程 workspace 结构化拒绝", (workspace) => {
    expect(() => workspaceRefWithCwd(workspace, cwd)).toThrow(
      expect.objectContaining({ reasonCode: WORKTREE_CWD_LOCAL_ONLY }),
    );
  });
});

describe("resolveResumeWorkspaceRef（冷恢复：身份取 Host，路径取存储 cwd）", () => {
  const stored = { directory: "/Users/dev/.zcode/worktrees/3f2a/project" };

  it("Host 携带本地 workspace：key 取请求，路径取存储目录", () => {
    expect(
      resolveResumeWorkspaceRef(buildWorkspaceRef({ workspacePath: "/Users/dev/project" }), stored),
    ).toEqual({
      workspaceIdentity: undefined,
      workspaceKey: "/Users/dev/project",
      workspacePath: stored.directory,
    });
  });

  it("没有请求 workspace：按存储重建（远端 identity 保留）", () => {
    expect(resolveResumeWorkspaceRef(undefined, stored)).toEqual(
      buildWorkspaceRef({ workspacePath: stored.directory }),
    );
    const workspaceID = "remote:ssh:example.test:22:coder:/workspace/project";
    expect(
      resolveResumeWorkspaceRef(undefined, { workspaceID, directory: "/workspace/project" }),
    ).toEqual(buildWorkspaceRef({ workspaceIdentity: workspaceID, workspacePath: "/workspace/project" }));
  });

  it("远程请求 workspace 原样使用", () => {
    const requested = resolveWorkspaceRefFromId("remote:ssh:example.test:22:coder:/workspace/project");
    expect(resolveResumeWorkspaceRef(requested, { directory: "/workspace/project" })).toBe(requested);
  });

  it("请求路径与存储目录是同一目录：沿用当前 attachment 的路径表示", () => {
    const requested = buildWorkspaceRef({ workspacePath: "/Users/dev/project/" });
    expect(resolveResumeWorkspaceRef(requested, { directory: "/Users/dev/project" })).toBe(
      requested,
    );
  });
});
