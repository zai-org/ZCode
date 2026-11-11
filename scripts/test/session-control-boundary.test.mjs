import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import ts from "typescript";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

async function withLintFixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-session-control-boundary-"));
  try {
    const { config } = ts.parseConfigFileTextToJson(
      ".oxlintrc.json",
      await readFile(join(root, ".oxlintrc.json"), "utf8"),
    );
    config.ignorePatterns = [];
    await writeFile(join(cwd, ".oxlintrc.json"), JSON.stringify(config));
    await run(async (file, source) => {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), source);
      const result = await exec(
        process.execPath,
        [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", file],
        { cwd },
      ).catch((error) => error);
      return JSON.parse(result.stdout).diagnostics;
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("会话控制核心拒绝环境 IO 与宿主实现依赖", async () => {
  await withLintFixture(async (lint) => {
    for (const specifier of [
      "node:fs/promises",
      "fs/promises",
      "node:child_process",
      "electron",
      "react",
      "@zcode/services",
      "@zcode/shared/zcode-protocol-v4",
      "@zcode/core",
      "../../../../services/src/node.js",
    ]) {
      const diagnostics = await lint(
        "packages/session-control/src/application/common/example.ts",
        `import { forbidden } from ${JSON.stringify(specifier)};\nexport const result = forbidden;\n`,
      );
      assert.ok(
        diagnostics.some((item) => item.code === "eslint(no-restricted-imports)"),
        `core unexpectedly allows ${specifier}`,
      );
    }
  });
});

test("会话控制核心通过注入访问时间与环境", async () => {
  await withLintFixture(async (lint) => {
    const diagnostics = await lint(
      "packages/session-control/src/domain/example.ts",
      "export const result = [process.env, window, fetch, setTimeout, setInterval, Date.now()];\n",
    );
    assert.equal(
      diagnostics.filter((item) => item.code === "eslint(no-restricted-globals)").length,
      6,
    );
  });
});

test("CLI 与 App 用例不得相互导入", async () => {
  await withLintFixture(async (lint) => {
    for (const [scope, other] of [
      ["cli", "app"],
      ["app", "cli"],
    ]) {
      for (const specifier of [
        `../${other}/index.js`,
        `@zcode/session-control/${other}`,
        `#session-control/application/${other}/index`,
      ]) {
        const diagnostics = await lint(
          `packages/session-control/src/application/${scope}/example.ts`,
          `import { forbidden } from ${JSON.stringify(specifier)};\nexport const result = forbidden;\n`,
        );
        assert.ok(
          diagnostics.some((item) => item.code === "eslint(no-restricted-imports)"),
          `${scope} unexpectedly imports ${other}: ${specifier}`,
        );
      }
    }
  });
});

test("核心隔离检查拒绝动态导入和全局环境绕过", async () => {
  const { checkSessionControlSource } =
    await import("../architecture/session-control-boundary.mjs");
  const file = "packages/session-control/src/application/cli/example.ts";
  for (const source of [
    'export const load = () => import("node:fs/promises");',
    'export const load = () => require("node:child_process");',
    'export const result = globalThis.fetch("https://example.com");',
    'export const result = globalThis["Date"].now();',
    "export const result = Math.random();",
    'export const result = Math["random"]();',
    "export const { random } = Math;",
    "export const result = globalThis.crypto.randomUUID();",
  ]) {
    assert.ok(
      checkSessionControlSource(file, source).length > 0,
      `unexpectedly allowed: ${source}`,
    );
  }
  for (const source of [
    'import { rule } from "#session-control/domain/rule"; export const result = rule;',
    "export const result = Math.max(1, 2);",
    "export const controller = new AbortController();",
  ]) {
    assert.deepEqual(checkSessionControlSource(file, source), []);
  }
});

test("核心隔离检查限制跨目录和跨用例引用", async () => {
  const { checkSessionControlSource } =
    await import("../architecture/session-control-boundary.mjs");
  for (const scope of ["cli", "app"]) {
    const other = scope === "cli" ? "app" : "cli";
    const file = `packages/session-control/src/application/${scope}/example.ts`;
    for (const specifier of [
      `#session-control/application/${other}/index`,
      `../${other}/index.js`,
      `../${other}`,
      `#session-control/application/${other}`,
      "../../testing",
      "../../../../../services/src/node.js",
      "@zcode/services",
    ]) {
      assert.ok(
        checkSessionControlSource(file, `export { value } from ${JSON.stringify(specifier)};`)
          .length > 0,
      );
    }
  }
});

test("允许核心使用契约与纯规则且不限制外部适配器 IO", async () => {
  await withLintFixture(async (lint) => {
    const core = await lint(
      "packages/session-control/src/application/cli/example.ts",
      'import { schema } from "../../contract/cli.js";\nimport { rule } from "../../domain/rule.js";\nexport const result = [schema, rule];\n',
    );
    assert.equal(core.filter((item) => item.code?.startsWith("eslint(no-restricted")).length, 0);
    const adapter = await lint(
      "packages/services/src/app-control/example.ts",
      'import { readFile } from "node:fs/promises";\nexport const result = readFile;\n',
    );
    assert.equal(adapter.filter((item) => item.code?.startsWith("eslint(no-restricted")).length, 0);
  });
});
