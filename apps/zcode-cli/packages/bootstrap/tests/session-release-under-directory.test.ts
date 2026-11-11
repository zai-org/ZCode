// session/releaseUnderDirectory（docs/git/worktree.md §8.3）：CLI 是驻留会话及其忙闲的唯一判定者。
// Host 删除受管 worktree 前用它卸载 cwd 位于 worktree 内的全部驻留会话：任一会话忙时全部不卸载。
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const PROJECT = join("/fixture", "repo");
const WORKTREE = join("/fixture", "worktrees", "3f2a", "repo");

async function request(server: ZCodeProtocolAgentServer, method: string, params: unknown) {
  const response = await server.handleMessage({ id: 1, method, params } as ZCodeProtocolMessage);
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result;
}

/** 两个会话：一个 cwd 在 worktree 子目录中，一个在项目主目录中。 */
async function boot() {
  const apps: Array<ReturnType<typeof createFakeApp>> = [];
  const server = new ZCodeProtocolAgentServer({
    createZCodeApp: (options) => {
      const app = createFakeApp(options);
      apps.push(app);
      return app;
    },
  });
  await request(server, zcodeProtocolMethods.sessionCreate, {
    workspace: { workspacePath: join(WORKTREE, "packages", "ui"), workspaceKey: PROJECT },
  });
  await request(server, zcodeProtocolMethods.sessionCreate, {
    workspace: { workspacePath: PROJECT, workspaceKey: PROJECT },
  });
  const [inWorktree, inProject] = apps as [
    ReturnType<typeof createFakeApp>,
    ReturnType<typeof createFakeApp>,
  ];
  return { server, inWorktree, inProject };
}

describe("session/releaseUnderDirectory", () => {
  it("只卸载 cwd 位于目录内的空闲会话", async () => {
    const { server, inWorktree, inProject } = await boot();
    const closeWorktree = vi.spyOn(inWorktree, "close");
    const closeProject = vi.spyOn(inProject, "close");
    expect(
      await request(server, zcodeProtocolMethods.sessionReleaseUnderDirectory, {
        directory: WORKTREE,
      }),
    ).toEqual({ released: [inWorktree.sessionId], busy: [] });
    expect(closeWorktree).toHaveBeenCalled();
    expect(closeProject).not.toHaveBeenCalled();
  });

  it("任一会话忙时全部不卸载，返回忙的会话", async () => {
    const { server, inWorktree } = await boot();
    const close = vi.spyOn(inWorktree, "close");
    vi.spyOn(inWorktree.runtime, "hasResidencyBlockingWork").mockReturnValue(true);
    expect(
      await request(server, zcodeProtocolMethods.sessionReleaseUnderDirectory, {
        directory: WORKTREE,
      }),
    ).toEqual({ released: [], busy: [inWorktree.sessionId] });
    expect(close).not.toHaveBeenCalled();
  });

  it("目录内没有驻留会话时返回空结果", async () => {
    const { server } = await boot();
    expect(
      await request(server, zcodeProtocolMethods.sessionReleaseUnderDirectory, {
        directory: join("/fixture", "worktrees", "9999", "repo"),
      }),
    ).toEqual({ released: [], busy: [] });
  });
});
