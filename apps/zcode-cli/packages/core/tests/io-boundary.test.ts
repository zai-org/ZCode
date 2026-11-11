import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const repoRoot = join(import.meta.dirname, "..", "..", "..");

describe("core I/O boundaries", () => {
  it("keeps file tools and context assembly free of direct host I/O", async () => {
    const files = [
      "packages/core/src/runtime.ts",
      "packages/core/src/context/sections/request-user-context.ts",
      "packages/core/src/tool/handlers/read.ts",
      "packages/core/src/tool/handlers/write.ts",
      "packages/core/src/tool/handlers/edit.ts",
      "packages/core/src/tool/handlers/skill.ts",
    ];

    for (const file of files) {
      const content = await readFile(join(repoRoot, file), "utf8");
      expect(content, file).not.toMatch(
        /from\s+["'](?:node:fs|node:fs\/promises|fs\/promises)["']/,
      );
      expect(content, file).not.toMatch(/process\.(?:cwd|env|platform)/);
    }
  });
});
