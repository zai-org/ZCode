import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("pending与formal使用相同窗口，仅显式自动压缩场景使用小窗口", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../wdio.conf.ts"), "utf8");
  const file = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
  const expressions = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      expressions.set(node.name.text, node.initializer.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  const auto = expressions.get("autoCompactSpec");
  const window = expressions.get("contextWindow");
  if (!auto || !window) throw new Error("Missing real WDIO replay context configuration");
  // 执行实际配置表达式；其它专项布尔门禁均关闭，避免为测试import启动整套WDIO。
  const unrelated = [
    ...new Set([...auto.matchAll(/!([A-Za-z]+Spec)\b/gu)].map((match) => match[1]!)),
  ];
  const readWindow = new Function(
    "specs",
    "upstreamE2EContextWindowOverride",
    ...unrelated,
    `const autoCompactSpec = ${auto}; return ${window};`,
  ) as (specs: string[], override: undefined, ...flags: boolean[]) => number;
  for (const folder of ["", "manual-review/pending/"]) {
    for (const name of [
      "web-remote-unread",
      "tool-history-order",
      "model-switch-queue",
      "compact",
      "compact-actions",
      "first-send",
    ]) {
      expect(
        readWindow(
          [`./test/e2e/conversation-session/${folder}conversation-session-${name}.test.ts`],
          undefined,
          ...unrelated.map(() => false),
        ),
        name,
      ).toBe(128000);
    }
    for (const name of [
      "compact-auto",
      "compact-auto-actions",
      "goal-run-cases",
      "model-switch-auto-compact",
      "subagent-runtime-refresh",
    ]) {
      expect(
        readWindow(
          [`./test/e2e/conversation-session/${folder}conversation-session-${name}.test.ts`],
          undefined,
          ...unrelated.map(() => false),
        ),
        name,
      ).toBe(240);
    }
  }
});

it("模型配置与切换用例保留可观测的思考参数映射", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../wdio.conf.ts"), "utf8");
  const file = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
  let expression = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "exposeSubagentReasoningMetadata" &&
      node.initializer
    ) {
      expression = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const enabled = new Function(
    "specs",
    "builtInSubagentModelOverridesSpec",
    "settingsSubagentCreateEditPersistenceSpec",
    "isSubagentCodingPlanLoginCatalogStaleSpec",
    `return ${expression};`,
  ) as (specs: string[], a: boolean, b: boolean, c: () => boolean) => boolean;
  for (const folder of ["", "manual-review/pending/"]) {
    for (const name of [
      "model-config",
      "model-switch-tool-edit-fork",
      "model-switch-compact",
      "model-switch-auto-compact",
      "goal-session-model",
      "new-session-inherits-model",
      "draft-model-switch-first-send",
      "model-provider-session-isolation",
      "upstream-workspace-smoke",
      "model-switch-edit-fork",
      "model-switch-queue",
      "same-model-provider-identity",
    ]) {
      expect(
        enabled(
          [`./test/e2e/conversation-session/${folder}conversation-session-${name}.test.ts`],
          false,
          false,
          () => false,
        ),
      ).toBe(true);
    }
  }
  expect(
    enabled(
      ["./test/e2e/conversation-session/composer/conversation-session-first-send.test.ts"],
      false,
      false,
      () => false,
    ),
  ).toBe(false);
});
