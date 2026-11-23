import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const packages = fileURLToPath(new URL("../..", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const plugins = [
  { name: "documents", skill: "docx", variable: "DOCX_SKILL_DIR" },
  { name: "pdf", skill: "pdf", variable: "PDF_SKILL_DIR" },
  { name: "presentations", skill: "pptx", variable: "PPTX_SKILL_DIR" },
  { name: "spreadsheets", skill: "xlsx", variable: "XLSX_SKILL_DIR" },
];
const shellEntries = plugins
  .filter((plugin) => plugin.name !== "presentations")
  .flatMap((plugin) =>
    [
      "env_setup/env_check.sh",
      "env_setup/setup_mac_linux.sh",
      plugin.name === "pdf" ? "scripts/setup.sh" : "setup.sh",
    ].map((entry) => `${plugin.name}-plugin/skills/${plugin.skill}/${entry}`),
  );

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "document-python-entry-"));
  const bin = join(root, "中文 空格");
  const calls = join(root, "calls");
  await mkdir(bin);
  const interpreter = (source: string) =>
    `#!/bin/sh\nprintf '%s|%s\\n' ${quote(source)} "$*" >> ${quote(calls)}\nprintf 'Python 3.12.0\\n'\nexit "\${FAKE_PYTHON_EXIT:-0}"\n`;
  await writeFile(join(bin, "python3"), interpreter("system"), { mode: 0o755 });
  const installEntry = () =>
    writeFile(join(bin, "zcode-python"), interpreter("managed"), { mode: 0o755 });
  const env = { ...process.env, PATH: [bin, "/usr/bin", "/bin"].join(delimiter) };
  return { root, bin, calls, env, installEntry };
}

describe.skipIf(process.platform === "win32")("document plugin Python entry selection", () => {
  it.each(shellEntries)(
    "%s stops before downloads when desktop Python is missing",
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), "document-python-missing-"));
      const bin = join(root, "bin");
      const calls = join(root, "unexpected-calls");
      await mkdir(bin);
      // PATH 只含检测夹具，不修改或卸载宿主 Python；副作用命令只记录，绝不安装。
      for (const command of ["curl", "wget", "npm", "brew", "apt", "dnf", "sudo", "mkdir"])
        await writeFile(
          join(bin, command),
          `#!/bin/sh\nprintf '%s\\n' ${quote(command)} >> ${quote(calls)}\nexit 90\n`,
          { mode: 0o755 },
        );
      await writeFile(join(bin, "uname"), '#!/bin/sh\nprintf "Darwin\\n"\n', { mode: 0o755 });
      await symlink("/usr/bin/dirname", join(bin, "dirname"));
      try {
        await expect(
          exec("/bin/bash", [join(packages, entry)], {
            env: { PATH: bin, HOME: root, ZCODE_PREINSTALLED_TOOLS_AVAILABLE: "1" },
          }),
        ).rejects.toMatchObject({
          code: 1,
          stdout: expect.stringContaining("预装版本未就绪或已关闭，请在 帮助 → 预装工具 中查看"),
        });
        await expect(readFile(calls, "utf8")).rejects.toHaveProperty("code", "ENOENT");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(shellEntries)(
    "%s retains unmanaged guidance without desktop availability",
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), "document-python-unmanaged-"));
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "uname"), '#!/bin/sh\nprintf "Darwin\\n"\n', { mode: 0o755 });
      await symlink("/usr/bin/dirname", join(bin, "dirname"));
      try {
        const result = await exec("/bin/bash", [join(packages, entry)], {
          env: { PATH: bin, HOME: root },
        }).catch((error: { stdout: string; stderr: string }) => error);
        expect(result.stdout).not.toContain("预装版本未就绪或已关闭");
        expect(result.stdout).toContain(
          entry.endsWith("env_check.sh") ? "python3" : "brew install python3",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(plugins.filter((plugin) => plugin.name !== "presentations"))(
    "$name sourced preflight returns to the caller and accepts system Python after manual installation",
    async (plugin) => {
      const f = await fixture();
      const check = join(
        packages,
        `${plugin.name}-plugin/skills/${plugin.skill}/env_setup/env_check.sh`,
      );
      const env = { PATH: f.bin, HOME: f.root, ZCODE_PREINSTALLED_TOOLS_AVAILABLE: "1" };
      try {
        const interpreter = await readFile(join(f.bin, "python3"), "utf8");
        await rm(join(f.bin, "python3"));
        await symlink("/usr/bin/dirname", join(f.bin, "dirname"));
        await writeFile(join(f.bin, "uname"), '#!/bin/sh\nprintf "Darwin\\n"\n', { mode: 0o755 });
        await writeFile(join(f.bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const missing = await exec(
          "/bin/bash",
          ["-c", `source ${quote(check)}; printf 'CALLER_CONTINUES=%s\\n' "$?"`],
          { env },
        );
        expect(missing.stdout).toContain("预装版本未就绪或已关闭");
        expect(missing.stdout).toContain("CALLER_CONTINUES=1");
        // 模拟用户按手动步骤安装；桌面可用标记仍保留，不能再次阻塞或要求环境绕过。
        await writeFile(join(f.bin, "python3"), interpreter, { mode: 0o755 });
        await exec("/bin/bash", [check, "--quiet"], { env });
        expect(
          (await readFile(f.calls, "utf8"))
            .trim()
            .split("\n")
            .every((line) => line.startsWith("system|")),
        ).toBe(true);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each(plugins)(
    "$name documented launcher sees an entry added between commands",
    async (plugin) => {
      const f = await fixture();
      try {
        const skill = join(packages, `${plugin.name}-plugin/skills/${plugin.skill}`);
        const document = await readFile(join(skill, "SKILL.md"), "utf8");
        const command = /`([^`\n]*zcode_libreoffice\.py[^`\n]*\bcheck)`/.exec(document)?.[1];
        expect(command).toBeTruthy();
        const run = (extra: Record<string, string> = {}) =>
          exec("/bin/bash", ["--noprofile", "--norc", "-c", command!], {
            env: { ...f.env, [plugin.variable]: skill, ...extra },
          });
        await run();
        expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(1);
        expect(await readFile(f.calls, "utf8")).toMatch(/^system\|/);
        await f.installEntry();
        await run();
        expect((await readFile(f.calls, "utf8")).trim().split("\n")[1]).toMatch(/^managed\|/);
        await expect(run({ FAKE_PYTHON_EXIT: "9" })).rejects.toHaveProperty("code", 9);
        expect((await readFile(f.calls, "utf8")).trim().split("\n").slice(2)).toEqual([
          expect.stringMatching(/^managed\|/),
        ]);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each(plugins.filter((plugin) => plugin.name !== "presentations"))(
    "$name env_check selects once and never falls back after a managed failure",
    async (plugin) => {
      const f = await fixture();
      try {
        await writeFile(join(f.bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await writeFile(join(f.bin, "fc-list"), "#!/bin/sh\nprintf 'noto\\n'\n", { mode: 0o755 });
        const check = join(
          packages,
          `${plugin.name}-plugin/skills/${plugin.skill}/env_setup/env_check.sh`,
        );
        const run = (extra: Record<string, string> = {}) =>
          exec("/bin/bash", [check, "--quiet"], { env: { ...f.env, ...extra } });
        await run();
        const system = (await readFile(f.calls, "utf8")).trim().split("\n");
        expect(system.length).toBeGreaterThan(1);
        expect(system.every((line) => line.startsWith("system|"))).toBe(true);
        await writeFile(f.calls, "");
        await f.installEntry();
        await run();
        const managed = (await readFile(f.calls, "utf8")).trim().split("\n");
        expect(managed.length).toBe(system.length);
        expect(managed.every((line) => line.startsWith("managed|"))).toBe(true);
        await writeFile(f.calls, "");
        await expect(run({ FAKE_PYTHON_EXIT: "9" })).rejects.toHaveProperty("code", 1);
        expect(
          (await readFile(f.calls, "utf8"))
            .trim()
            .split("\n")
            .every((line) => line.startsWith("managed|")),
        ).toBe(true);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
});
