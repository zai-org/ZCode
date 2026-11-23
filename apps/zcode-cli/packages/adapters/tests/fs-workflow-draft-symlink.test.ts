// ZP-20261110-04：草稿目录的符号链接不得把免确认的草稿写入导向项目外。
// 运行时证据：临时目录中真实建立符号链接，断言越界写入被拒绝且项目外文件不变。

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";

const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const USER_CONFIG_TEXT = '{"hooks":{}}\n';
const EVIL_CONFIG_TEXT =
  '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"evil"}]}]}}\n';

let root: string;
let project: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-draft-symlink-"));
  project = join(root, "project");
  outside = join(root, "outside");
  await mkdir(join(project, ".zcode"), { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeTextFile symlinkFreeBase (workflow draft write guard)", () => {
  it("refuses a draft write when the drafts directory is a symlink out of the project", async () => {
    const userConfig = join(outside, "config.json");
    await writeFile(userConfig, USER_CONFIG_TEXT);
    await symlink(outside, join(project, ".zcode", "workflow-drafts"), DIRECTORY_LINK_TYPE);

    const fs = createNodeFileSystemAdapter();
    await expect(
      fs.writeTextFile({
        path: join(project, ".zcode", "workflow-drafts", "config.json"),
        content: EVIL_CONFIG_TEXT,
        createParents: true,
        atomic: true,
        symlinkFreeBase: project,
      }),
    ).rejects.toThrow(/symlink/i);

    expect(await readFile(userConfig, "utf8")).toBe(USER_CONFIG_TEXT);
  });

  it("refuses a draft write through a symlinked subdirectory of the drafts directory", async () => {
    const draftsDir = join(project, ".zcode", "workflow-drafts");
    await mkdir(draftsDir, { recursive: true });
    const userConfig = join(outside, "config.json");
    await writeFile(userConfig, USER_CONFIG_TEXT);
    await symlink(outside, join(draftsDir, "sub"), DIRECTORY_LINK_TYPE);

    const fs = createNodeFileSystemAdapter();
    await expect(
      fs.writeTextFile({
        path: join(draftsDir, "sub", "config.json"),
        content: EVIL_CONFIG_TEXT,
        createParents: true,
        atomic: true,
        symlinkFreeBase: project,
      }),
    ).rejects.toThrow(/symlink/i);

    expect(await readFile(userConfig, "utf8")).toBe(USER_CONFIG_TEXT);
  });

  it("does not create missing directories outside the project through a symlinked drafts directory", async () => {
    await symlink(outside, join(project, ".zcode", "workflow-drafts"), DIRECTORY_LINK_TYPE);

    const fs = createNodeFileSystemAdapter();
    await expect(
      fs.writeTextFile({
        path: join(project, ".zcode", "workflow-drafts", "newdir", "x.dwf.ts"),
        content: "export {};\n",
        createParents: true,
        atomic: true,
        symlinkFreeBase: project,
      }),
    ).rejects.toThrow(/symlink/i);

    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a draft write when .zcode itself is a symlink out of the project", async () => {
    await rm(join(project, ".zcode"), { recursive: true });
    await symlink(outside, join(project, ".zcode"), DIRECTORY_LINK_TYPE);

    const fs = createNodeFileSystemAdapter();
    await expect(
      fs.writeTextFile({
        path: join(project, ".zcode", "workflow-drafts", "config.json"),
        content: EVIL_CONFIG_TEXT,
        createParents: true,
        atomic: true,
        symlinkFreeBase: project,
      }),
    ).rejects.toThrow(/symlink/i);

    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a write whose target is not under symlinkFreeBase", async () => {
    const fs = createNodeFileSystemAdapter();
    await expect(
      fs.writeTextFile({
        path: join(outside, "config.json"),
        content: EVIL_CONFIG_TEXT,
        createParents: true,
        atomic: true,
        symlinkFreeBase: project,
      }),
    ).rejects.toThrow(/outside symlink-free base/i);

    expect(await readdir(outside)).toEqual([]);
  });

  it("still writes a draft file into a real drafts directory", async () => {
    const draftsDir = join(project, ".zcode", "workflow-drafts");
    const fs = createNodeFileSystemAdapter();

    await fs.writeTextFile({
      path: join(draftsDir, "nightly.dwf.ts"),
      content: "export {};\n",
      createParents: true,
      atomic: true,
      symlinkFreeBase: project,
    });

    expect(await readFile(join(draftsDir, "nightly.dwf.ts"), "utf8")).toBe("export {};\n");
  });
});
