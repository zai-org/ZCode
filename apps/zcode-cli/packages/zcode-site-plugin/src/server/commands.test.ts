import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseFrontmatter, readCommands } from "./commands.ts";

const pluginCommands = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../commands",
);
let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readCommands", () => {
  it("lists the plugin's own commands with descriptions and hints", async () => {
    const commands = await readCommands(pluginCommands);
    expect(commands.map((command) => command.name)).toEqual([
      "site-analytics",
      "site-badge",
      "site-deploy",
      "site-logs",
      "site-offline",
      "site-online",
      "site-status",
      "site-usage",
    ]);
    expect(
      commands.find((command) => command.name === "site-logs"),
    ).toMatchObject({
      argumentHint: "[deployment id]",
    });
    expect(commands.every((command) => command.description.length > 0)).toBe(
      true,
    );
  });

  it("skips files without a description", async () => {
    dir = await mkdtemp(join(tmpdir(), "zcode-site-commands-"));
    await writeFile(
      join(dir, "a.md"),
      "---\ndescription: 'Quoted'\r\n---\nbody",
    );
    await writeFile(join(dir, "b.md"), "no frontmatter");
    await writeFile(join(dir, "c.txt"), "---\ndescription: x\n---");
    expect(await readCommands(dir)).toEqual([
      { name: "a", description: "Quoted" },
    ]);
  });

  it("parses single-line scalars", () => {
    expect(
      parseFrontmatter(
        '---\nargument-hint: "hide | show"\nskills: site-deploy\n---',
      ),
    ).toEqual({
      "argument-hint": "hide | show",
      skills: "site-deploy",
    });
  });
});
