import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGenUiService } from "../../../../../../../packages/services/src/gen-ui/node.js";
import { buildDesktopContextSection } from "../../context/sections/desktop.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ensureGenUiOutputDirectory, resolveGenUiOutputDirectory } from "./gen-ui-output.js";

describe("Host-owned Gen UI output", () => {
  it.each([undefined, "ssh:executor:/workspace"])(
    "uses the same directory for runtime context and executor reads (%s)",
    async (workspaceIdentity) => {
      const root = await mkdtemp(join(tmpdir(), "gen-ui-context-"));
      const workspacePath = join(root, "repository");
      const outputRoot = join(root, "user-data", "visualizations");
      const service = createGenUiService({ outputRoot, stateRoot: join(root, "state") });
      await mkdir(workspacePath);
      const runtime = {
        config: {
          genUiOutputRoot: outputRoot,
          presentationSurface: "zcode_desktop",
          workspacePath,
          workspaceIdentity,
        },
        workspaceRoot: workspacePath,
        sessionId: "session",
        rootTraceContext: { traceId: "trace" },
        fileSystemPort: {
          createDirectory: ({ path }: { path: string }) => mkdir(path, { recursive: true }),
        },
      } as unknown as AgentRuntimeInternal;
      try {
        await ensureGenUiOutputDirectory(runtime);
        const directory = resolveGenUiOutputDirectory(runtime)!;
        // 目录随环境公告发送；Desktop 段只声明支持 Gen UI，不含按会话变化的路径。
        expect(buildDesktopContextSection(true).content).toContain("host supports Gen UI");
        expect(buildDesktopContextSection(true).content).not.toContain(directory);
        const path = join(directory, "chart.html");
        await writeFile(path, "<div>Outside Git</div>");
        expect(
          (
            await service.readDocument({
              workspacePath,
              workspaceIdentity,
              sessionId: "session",
              path,
            })
          ).html,
        ).toBe("<div>Outside Git</div>");
        expect(await readdir(workspacePath)).toEqual([]);
        expect(resolveGenUiOutputDirectory(runtime)).toBe(directory);
        runtime.sessionId = "other" as typeof runtime.sessionId;
        expect(resolveGenUiOutputDirectory(runtime)).not.toBe(directory);
      } finally {
        service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("does not advertise a directory without a host root, and propagates creation failure", async () => {
    const runtime = { config: { presentationSurface: "zcode_desktop" } } as AgentRuntimeInternal;
    expect(resolveGenUiOutputDirectory(runtime)).toBeUndefined();
    expect(buildDesktopContextSection().content).not.toContain("host supports Gen UI");
    runtime.config.genUiOutputRoot = join(tmpdir(), "gen-ui-output");
    runtime.workspaceRoot = join(tmpdir(), "project");
    runtime.sessionId = "session" as typeof runtime.sessionId;
    runtime.fileSystemPort = {
      createDirectory: async () => {
        throw new Error("read-only volume");
      },
    } as unknown as AgentRuntimeInternal["fileSystemPort"];
    await expect(ensureGenUiOutputDirectory(runtime)).rejects.toThrow("read-only volume");
  });
});
