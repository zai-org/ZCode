import { describe, expect, it } from "vitest";

import {
  resolveProjectMemoryRetrievalBranch,
  type ProjectMemoryRetrievalBranch,
} from "../src/memory/project-memory-retrieval-branch.js";
import { loadProjectMemoryIndex } from "../src/runtime/methods/context.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

describe("project Memory retrieval branch", () => {
  it.each<{ enabled: boolean; expected: ProjectMemoryRetrievalBranch }>([
    { enabled: false, expected: "default-index" },
    { enabled: true, expected: "semantic-recall" },
  ])("maps $enabled to $expected", ({ enabled, expected }) => {
    expect(resolveProjectMemoryRetrievalBranch(enabled)).toBe(expected);
  });

  it("loads and seeds MEMORY.md only for the default-index branch", async () => {
    const memoryRoot = "/storage/memories/projects/project-0123456789abcdef/memory";
    const indexPath = `${memoryRoot}/MEMORY.md`;
    const content = "- [Database policy](database-policy.md) — use the real database";
    const defaultFileSystem = new MemoryFileSystem({ [indexPath]: content });
    const defaultReadFileState = new Map();
    const defaultRuntime = {
      fileSystemPort: defaultFileSystem,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      readFileState: defaultReadFileState,
    } as Parameters<typeof loadProjectMemoryIndex>[0];

    await expect(
      loadProjectMemoryIndex(defaultRuntime, memoryRoot, "default-index").then(
        (read) => read.index?.content,
      ),
    ).resolves.toBe(content);
    expect(defaultFileSystem.readRequests).toEqual([{ maxBytes: undefined, path: indexPath }]);
    expect(defaultReadFileState.size).toBe(1);

    const semanticFileSystem = new MemoryFileSystem({ [indexPath]: content });
    const semanticReadFileState = new Map();
    const semanticRuntime = {
      fileSystemPort: semanticFileSystem,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      readFileState: semanticReadFileState,
    } as Parameters<typeof loadProjectMemoryIndex>[0];

    await expect(
      loadProjectMemoryIndex(semanticRuntime, memoryRoot, "semantic-recall").then(
        (read) => read.index?.content,
      ),
    ).resolves.toBeUndefined();
    expect(semanticFileSystem.readRequests).toEqual([]);
    expect(semanticReadFileState.size).toBe(0);
  });

  it.each([
    { content: "", name: "empty" },
    { content: "---\ninternal: hidden\n---\n", name: "frontmatter-only" },
    { content: "<!-- hidden top-level comment -->\n", name: "top-level-comment-only" },
  ])("does not seed read state for $name MEMORY.md", async ({ content }) => {
    const memoryRoot = "/storage/memories/projects/project-0123456789abcdef/memory";
    const indexPath = `${memoryRoot}/MEMORY.md`;
    const fileSystem = new MemoryFileSystem({ [indexPath]: content });
    const readFileState = new Map();
    const runtime = {
      fileSystemPort: fileSystem,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      readFileState,
    } as Parameters<typeof loadProjectMemoryIndex>[0];

    await expect(
      loadProjectMemoryIndex(runtime, memoryRoot, "default-index").then(
        (read) => read.index?.content,
      ),
    ).resolves.toBeUndefined();
    expect(fileSystem.readRequests).toEqual([{ maxBytes: undefined, path: indexPath }]);
    expect(readFileState.size).toBe(0);
  });
});
