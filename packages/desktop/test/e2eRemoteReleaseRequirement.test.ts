import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertRemoteReleaseStaged,
  listSpecsRequiringRemoteRelease,
  REMOTE_RELEASE_DIR_ENV,
  REMOTE_RELEASE_CONSUMER_MODULES,
} from "./e2e/helpers/e2e-remote-release-requirement.js";

let desktopDir: string;

async function writeSource(path: string, text: string) {
  await mkdir(dirname(join(desktopDir, path)), { recursive: true });
  await writeFile(join(desktopDir, path), text, "utf8");
}

beforeEach(async () => {
  desktopDir = await mkdtemp(join(tmpdir(), "zcode-remote-release-requirement-"));
  await writeSource("test/e2e/helpers/ssh-remote-p0.ts", "export const ssh = 1;\n");
  await writeSource(
    "test/e2e/helpers/ssh-remote-lifecycle.ts",
    'import { ssh } from "./ssh-remote-p0.js";\nexport const lifecycle = ssh;\n',
  );
  await writeSource(
    "test/e2e/helpers/desktop-app.ts",
    'import { lifecycle } from "#e2e/helpers/desktop-app-cycle";\nexport const app = 1;\n',
  );
  // 循环 import 不能让扫描死循环。
  await writeSource(
    "test/e2e/helpers/desktop-app-cycle.ts",
    'import { app } from "./desktop-app.js";\nexport const lifecycle = app;\n',
  );
});

afterEach(async () => {
  await rm(desktopDir, { force: true, recursive: true });
});

describe("listSpecsRequiringRemoteRelease", () => {
  it("follows #e2e aliases and relative imports transitively", async () => {
    await writeSource(
      "test/e2e/remote/direct.test.ts",
      'import { ssh } from "#e2e/helpers/ssh-remote-p0";\n',
    );
    await writeSource(
      "test/e2e/remote/transitive.test.ts",
      'import { lifecycle } from "../helpers/ssh-remote-lifecycle.js";\n',
    );
    await writeSource(
      "test/e2e/remote/dynamic.test.ts",
      'const mod = await import("#e2e/helpers/ssh-remote-p0");\n',
    );
    await writeSource(
      "test/e2e/remote/reexport.test.ts",
      'export { ssh } from "#e2e/helpers/ssh-remote-p0";\n',
    );
    // 类型 import 也计入：多准备不会出错，少准备会让用例在兜底处失败。
    await writeSource(
      "test/e2e/remote/type-only.test.ts",
      'import type { ssh } from "#e2e/helpers/ssh-remote-p0";\n',
    );
    await writeSource(
      "test/e2e/local/plain.test.ts",
      'import { app } from "#e2e/helpers/desktop-app";\nimport { x } from "@zcode/shared";\n',
    );

    const required = await listSpecsRequiringRemoteRelease({
      desktopDir,
      specFiles: [
        "test/e2e/remote/direct.test.ts",
        "test/e2e/remote/transitive.test.ts",
        "test/e2e/remote/dynamic.test.ts",
        "test/e2e/remote/reexport.test.ts",
        "test/e2e/remote/type-only.test.ts",
        "test/e2e/local/plain.test.ts",
      ],
    });

    expect(required).toEqual([
      "test/e2e/remote/direct.test.ts",
      "test/e2e/remote/transitive.test.ts",
      "test/e2e/remote/dynamic.test.ts",
      "test/e2e/remote/reexport.test.ts",
      "test/e2e/remote/type-only.test.ts",
    ]);
  });

  it("returns nothing when no scheduled spec reaches a consumer module", async () => {
    await writeSource(
      "test/e2e/local/plain.test.ts",
      'import { app } from "#e2e/helpers/desktop-app";\n',
    );
    await expect(
      listSpecsRequiringRemoteRelease({
        desktopDir,
        specFiles: ["test/e2e/local/plain.test.ts"],
      }),
    ).resolves.toEqual([]);
  });

  it("counts every module that reads the staged release as a consumer", async () => {
    for (const modulePath of REMOTE_RELEASE_CONSUMER_MODULES) {
      await writeSource(modulePath, "export {};\n");
    }
    await writeSource(
      "test/e2e/remote/update.test.ts",
      'import "#e2e/helpers/source-server-update-fixture";\n',
    );
    await expect(
      listSpecsRequiringRemoteRelease({
        desktopDir,
        specFiles: ["test/e2e/remote/update.test.ts"],
      }),
    ).resolves.toEqual(["test/e2e/remote/update.test.ts"]);
  });

  it("covers the real SSH formal specs in this repository", async () => {
    // 真实仓库回归：已知只经 ssh-remote-lifecycle 间接引用 SSH helper 的用例必须被识别。
    const realDesktopDir = fileURLToPath(new URL("..", import.meta.url));
    const spec =
      "test/e2e/conversation-session/remote/installation/conversation-session-ssh-remote-daemon-starting-reuse.test.ts";
    const plain =
      "test/e2e/conversation-session/context/conversation-session-instruction-file-delta.test.ts";
    await expect(
      listSpecsRequiringRemoteRelease({ desktopDir: realDesktopDir, specFiles: [spec, plain] }),
    ).resolves.toEqual([spec]);
  });
});

describe("assertRemoteReleaseStaged", () => {
  it("fails with a clear message when onPrepare did not stage the release", async () => {
    expect(() => assertRemoteReleaseStaged("CASE-1", {})).toThrow(
      /CASE-1.*需要 remote release.*onPrepare 没有准备/u,
    );
    expect(() =>
      assertRemoteReleaseStaged("CASE-1", { [REMOTE_RELEASE_DIR_ENV]: join(desktopDir, "nope") }),
    ).toThrow(/onPrepare 没有准备/u);
  });

  it("passes when the staged descriptor exists", async () => {
    const releaseDir = join(desktopDir, "staged");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, "source-server-release.json"), "{}", "utf8");
    expect(() =>
      assertRemoteReleaseStaged("CASE-1", { [REMOTE_RELEASE_DIR_ENV]: releaseDir }),
    ).not.toThrow();
  });

  it("skips the check for packaged apps, which never read mock-cdn", () => {
    expect(() =>
      assertRemoteReleaseStaged("CASE-1", {
        ZCODE_E2E_PACKAGED_APP_PATH: "/Applications/ZCode.app",
      }),
    ).not.toThrow();
  });
});
