import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const checker = resolve("scripts/check-document-python.mjs");
const selection = '"$(command -v zcode-python || command -v python3)"';

describe("document Python command gate", () => {
  it("checks all distributed plugin commands", async () => {
    await expect(exec(process.execPath, [checker])).resolves.toMatchObject({ stderr: "" });
  });

  it("accepts interpreter selection and prose but rejects a newly added bare command", async () => {
    const root = await mkdtemp(join(tmpdir(), "document-python-gate-"));
    try {
      for (const plugin of ["documents", "pdf", "presentations", "spreadsheets"]) {
        await mkdir(join(root, `${plugin}-plugin`, "skills"), { recursive: true });
        await mkdir(join(root, `${plugin}-plugin`, "scripts"));
      }
      const doc = join(root, "documents-plugin/skills/SKILL.md");
      await writeFile(
        doc,
        `Use python3 and python-docx.\npython (default): Output format.\n\n\`\`\`python\nprint('hello')\n\`\`\`\n\n\`${selection} task.py\`\nUse the class from \`"$DOCX_SCRIPTS/document.py"\`.\n`,
      );
      await writeFile(
        join(root, "documents-plugin/skills/table.md"),
        '| Command |\n| --- |\n| `"$(command -v zcode-python \\|\\| command -v python3)" task.py` |\n',
      );
      await writeFile(
        join(root, "documents-plugin/scripts/setup.ps1"),
        "$Python = Get-Command zcode-python -ErrorAction SilentlyContinue\n",
      );
      await writeFile(
        join(root, "documents-plugin/scripts/helper.py"),
        '#!/usr/bin/env python3\nimport subprocess, sys\nsubprocess.run([sys.executable, "-m", "pip", "install", "example"])\n',
      );
      await expect(exec(process.execPath, [checker, root])).resolves.toMatchObject({ stderr: "" });
      await writeFile(doc, "```bash\npython3 task.py\n```\n");
      await expect(exec(process.execPath, [checker, root])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("SKILL.md:2"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["example.md", "Run `python helper.py`."],
    ["example.sh", "result=$(python3 -c 'print(1)')"],
    ["example.sh", '"python3" -c "print(1)"'],
    ["example.py", 'print("Install: pip install example")'],
    ["example.py", 'subprocess.run(["python3", "helper.py"])'],
    // 直接执行脚本靠 shebang 落到系统 python3，同样绕过所选解释器。
    ["example.md", 'Run `"$DOCX_SCRIPTS/add_toc_placeholders.py" --auto` after generation'],
    ["table.md", '| Pivot | `"$XLSX_SKILL_DIR/xlsx.py" pivot` |'],
    ["example.sh", 'out=$("$SCRIPT_DIR/helper.py" --json)'],
  ])("rejects an unselected command in %s", async (name, content) => {
    const root = await mkdtemp(join(tmpdir(), "document-python-gate-"));
    try {
      for (const plugin of ["documents", "pdf", "presentations", "spreadsheets"]) {
        await mkdir(join(root, `${plugin}-plugin`, "skills"), { recursive: true });
        await mkdir(join(root, `${plugin}-plugin`, "scripts"));
      }
      await writeFile(join(root, "documents-plugin/scripts", name), content);
      await expect(exec(process.execPath, [checker, root])).rejects.toHaveProperty("code", 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
