import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const CORE = "packages/session-control/src/";
const ENVIRONMENT_NAMES = new Set([
  "process",
  "window",
  "document",
  "navigator",
  "global",
  "globalThis",
  "self",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "localStorage",
  "sessionStorage",
  "Date",
  "performance",
  "crypto",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "eval",
  "Function",
  "require",
]);

/** 补上 lint 不检查的动态 import 与 globalThis 绕过；只约束本功能核心，不改变宿主 adapter。 */
export function checkSessionControlSource(file, source) {
  const normalized = file.replaceAll("\\", "/");
  if (!normalized.startsWith(CORE) || /\.(?:test|spec)\.ts$/.test(normalized)) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const diagnostics = [];
  const report = (node, message) => {
    diagnostics.push({
      file,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      message,
    });
  };
  const checkImport = (node, value) => {
    if (!ts.isStringLiteralLike(value)) {
      report(node, "Computed imports are not allowed in the control core");
      return;
    }
    const specifier = value.text;
    if (specifier === "zod") return;
    let target;
    if (specifier.startsWith("#session-control/"))
      target = `${CORE}${specifier.slice("#session-control/".length)}`;
    else if (specifier.startsWith("."))
      target = path.posix.normalize(path.posix.join(path.posix.dirname(normalized), specifier));
    else {
      report(node, `External implementation dependency is forbidden: ${specifier}`);
      return;
    }
    if (!target.startsWith(CORE)) {
      report(node, `Import escapes the control core: ${specifier}`);
      return;
    }
    const sourceSurface = normalized.match(/\/application\/(cli|app)\//)?.[1];
    // 目录入口与 index 文件具有同一依赖边界，不能用省略文件名绕过。
    const targetSurface = target.match(/\/application\/(cli|app)(?:\/|$)/)?.[1];
    if (sourceSurface && targetSurface && sourceSurface !== targetSurface)
      report(node, "CLI and App use cases cannot import one another");
    if (
      (target === `${CORE}testing` || target.startsWith(`${CORE}testing/`)) &&
      !normalized.startsWith(`${CORE}testing/`)
    )
      report(node, "Production control code cannot import testing utilities");
  };
  const isPropertyName = (node) => {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent)) &&
        parent.name === node)
    );
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      checkImport(node, node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // 核心没有延迟装载的职责，禁动态 import 避免静态依赖门禁被绕过。
      report(node, "Dynamic imports belong in host adapters");
    }
    if (ts.isImportEqualsDeclaration(node))
      report(node, "CommonJS imports belong in host adapters");
    if (ts.isIdentifier(node) && ENVIRONMENT_NAMES.has(node.text) && !isPropertyName(node))
      report(node, `Inject environment capability instead of using ${node.text}`);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      node.name.text === "random"
    )
      report(node, "Request identity must not depend on ambient randomness");
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      (!ts.isStringLiteralLike(node.argumentExpression) ||
        node.argumentExpression.text === "random")
    )
      report(node, "Computed or random Math access is forbidden in the control core");
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "Math"
    ) {
      if (
        !ts.isObjectBindingPattern(node.name) ||
        node.name.elements.some(
          (element) =>
            element.dotDotDotToken ||
            (element.propertyName ?? element.name).getText(tree) === "random",
        )
      )
        report(node, "Do not alias ambient Math randomness");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return diagnostics;
}

async function checkFiles(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return checkFiles(root, file);
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) return [];
      return checkSessionControlSource(path.relative(root, file), await readFile(file, "utf8"));
    }),
  );
  return results.flat();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, "../..");
  const diagnostics = await checkFiles(root, path.join(root, CORE));
  for (const item of diagnostics) console.error(`${item.file}:${item.line}: ${item.message}`);
  if (diagnostics.length) process.exitCode = 1;
  else console.log("session-control: isolated core dependency checks passed");
}
