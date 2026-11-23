#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root =
  process.argv[2] || fileURLToPath(new URL("../apps/zcode-cli/packages", import.meta.url));
const extensions = new Set([".md", ".sh", ".ps1", ".py", ".js", ".mjs", ".ts"]);
const selection = /\$\(command -v zcode-python \|\| command -v python3\)/g;

// 只匹配命令形态；语言名、包名、围栏标签、shebang 和字典键不是调用。
function hasBareCommand(line, extension) {
  if (line.startsWith("#!")) return false;
  // Markdown 表格里的管道符必须转义，扫描时还原呈现给 Agent 的命令。
  const command =
    extension === ".md" && line.trimStart().startsWith("|") ? line.replaceAll("\\|", "|") : line;
  const text = command.replace(selection, "SELECTED_PYTHON");
  return (
    /(?<![\w-])(["']?)python3?\b\1[ \t]+(?:-[\w-]|["'$./]|[^\s]+\.py\b|<<)/.test(text) ||
    /(?:^|[;|&`])[ \t]*(?:(?:if|then|elif|exec|sudo|!)[ \t]+)*python3?[ \t]+[^\s`(]/.test(text) ||
    /\b(?:command -v|which)[ \t]+python3?\b/.test(text) ||
    /(?<!-m )\bpip3?[ \t]+install\b/.test(text) ||
    /\b(?:spawn|execFile|run|Popen|call)\s*\(\s*\[?\s*["']python3?["']/.test(text) ||
    // 直接执行 "$DIR/x.py" 会经 shebang 落到系统 python3；只认带参数的命令位置，模块路径说明不算调用。
    /(?:^|[;|&`(])[ \t]*(?:(?:if|then|elif|exec|sudo|!)[ \t]+)*(["']?)(?:\$|\.{1,2}\/|~\/|\/)[^\s"'`]*\.py\1(?=[ \t]+[^\s`])/.test(
      text,
    )
  );
}

async function checkDirectory(directory, failures) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(path, failures);
    else if (entry.isFile() && extensions.has(extname(entry.name))) {
      const lines = (await readFile(path, "utf8")).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (hasBareCommand(line, extname(entry.name)))
          failures.push(`${path}:${index + 1}: use the selected Python interpreter`);
      }
    }
  }
}

try {
  const failures = [];
  for (const plugin of ["documents", "pdf", "presentations", "spreadsheets"]) {
    for (const directory of ["skills", "scripts"]) {
      await checkDirectory(join(root, `${plugin}-plugin`, directory), failures);
    }
  }
  if (failures.length) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Document Python commands use the selected interpreter.\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
