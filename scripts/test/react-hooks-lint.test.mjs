import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const dependenciesRule = "eslint-plugin-react-hooks(exhaustive-deps)";
const hooksRule = "eslint-plugin-react-hooks(rules-of-hooks)";

async function lint(source, file = "packages/ui/src/Example.tsx", packageDirectory = ".") {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-hooks-lint-"));
  try {
    await writeFile(join(cwd, ".oxlintrc.json"), await readFile(join(root, ".oxlintrc.json")));
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), source);
    const target = packageDirectory === "." ? file : file.slice(packageDirectory.length + 1);
    const result = await exec(
      process.execPath,
      [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", target],
      { cwd: join(cwd, packageDirectory) },
    ).catch((error) => {
      if (error.code !== 1 || !error.stdout) throw error;
      return error;
    });
    return { code: result.code ?? 0, diagnostics: JSON.parse(result.stdout).diagnostics };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("missing and unnecessary dependencies are warnings from root and package lint", async () => {
  const source = `import { useCallback } from "react";
export function useMissing(value: number) { return useCallback(() => value, []); }
export function useExtra(value: number) { return useCallback(() => 1, [value]); }`;
  for (const directory of [".", "packages/ui"]) {
    const result = await lint(source, "packages/ui/src/Example.tsx", directory);
    const diagnostics = result.diagnostics.filter((item) => item.code === dependenciesRule);
    assert.equal(diagnostics.length, 2);
    assert.ok(diagnostics.some((item) => item.message.includes("missing dependency")));
    assert.ok(diagnostics.some((item) => item.message.includes("unnecessary dependency")));
    assert.ok(diagnostics.every((item) => item.severity === "warning"));
    assert.equal(result.code, 0);
  }
});

test("conditional Hooks block new files and remain visible in an admitted legacy file", async () => {
  const source = `import { useState } from "react";
export function Example({ enabled }: { enabled: boolean }) {
  if (enabled) return useState(0)[0];
  return null;
}`;
  const regular = await lint(source);
  assert.equal(regular.code, 1);
  assert.equal(regular.diagnostics.find((item) => item.code === hooksRule)?.severity, "error");
  const legacy = await lint(source, "packages/ui/src/hooks/useZCodeAgentService.ts");
  assert.equal(legacy.code, 0);
  assert.equal(legacy.diagnostics.find((item) => item.code === hooksRule)?.severity, "warning");
});

test("precise callbacks and whole-object dependencies keep the native rule semantics", async () => {
  const result = await lint(`import { useCallback } from "react";
type Props = { onOpen: () => void; unrelated: number };
declare function open(props: Props): void;
export function usePrecise({ onOpen }: Props) { return useCallback(() => onOpen(), [onOpen]); }
export function useBroad(props: Props) { return useCallback(() => open(props), [props]); }`);
  assert.deepEqual(
    result.diagnostics.filter((item) => item.code === dependenciesRule),
    [],
  );
});

test("adding Hooks checks preserves existing plugins without enabling other React defaults", async () => {
  const result = await lint(`export const values = [...[1, 2]];
export function List({ items }: { items: string[] }) { return items.map(item => <div>{item}</div>); }`);
  assert.ok(
    result.diagnostics.some((item) => item.code === "eslint-plugin-unicorn(no-useless-spread)"),
  );
  assert.ok(!result.diagnostics.some((item) => item.code?.includes("jsx-key")));
});
