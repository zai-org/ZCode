// 打包后把四个入口的导出都改成 type-only（docs/plugins/extension-host.md §17.9）。
// 修复原因：rollup 生成跨 chunk 的 `export { f as ExtensionError } from './chunk.js'` 时不带 type，
// ExtensionError 是类，包外 `new ExtensionError()` 能通过编译，但包里没有 JS，运行时才失败。
// 类型包只有类型，所以入口里的每条导出都可以是 type-only。
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ENTRIES = ["index", "manifest", "sessions", "protocol-v4"];
// 一行一条导出：`export { a as A, type B } from './x.js';` 或 `export { A, type B };`
const EXPORT_LINE = /^export \{ ([^}]*) \}( from '[^']+')?;$/gm;

for (const entry of ENTRIES) {
  const file = join(DIST, `${entry}.d.ts`);
  const source = await readFile(file, "utf8");
  const next = source.replace(EXPORT_LINE, (_line, names, from = "") => {
    const plain = names
      .split(",")
      .map((name) => name.trim().replace(/^type /, ""))
      .join(", ");
    return `export type { ${plain} }${from};`;
  });
  if (/^export (?!type \{)/m.test(next)) {
    throw new Error(`${entry}.d.ts still has a non-type export`);
  }
  await writeFile(file, next);
}
