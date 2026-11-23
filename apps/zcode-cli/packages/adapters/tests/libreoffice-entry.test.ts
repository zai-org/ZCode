import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("../../documents-plugin/scripts", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(mode: string, systemVersion = "printf 'LibreOfficeDev 7.6.0.0\\n'") {
  const root = await mkdtemp(join(tmpdir(), "zcode-office-entry-"));
  const bin = join(root, "中文 空格");
  await mkdir(bin);
  const system = join(root, "system-office");
  const systemCalls = join(root, "system-calls");
  await writeFile(system, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(systemCalls)}\n${systemVersion}\n`, { mode: 0o755 });
  if (mode !== "missing") {
    const entry = join(bin, "zcode-soffice");
    const action = mode === "vanish" ? '/bin/rm -- "$0"; exit 0' : mode === "failure" ? 'exit 7' : 'printf "managed-output\\n"';
    await writeFile(entry, `#!/bin/sh\ncase "$*" in *--version*) printf 'LibreOffice 26.8.1\\n'; ${mode === "vanish" ? action : 'exit 0'};; esac\n${action}\n`, { mode: 0o755 });
  }
  const driver = join(root, "invoke.py");
  await writeFile(driver, `import asyncio, dataclasses, json, sys\nfrom pathlib import Path\nsys.path.insert(0, ${JSON.stringify(helper)})\nfrom zcode_libreoffice import run_libreoffice\nasync def main():\n  try:\n    recalculate = Path(sys.argv[4]) if len(sys.argv) > 4 else None\n    value = await run_libreoffice(json.loads(sys.argv[1]), environment=json.loads(sys.argv[2]), candidate_paths=[Path(p) for p in json.loads(sys.argv[3])], timeout=2, recalculate=recalculate)\n    print(json.dumps(dataclasses.asdict(value)))\n  except Exception as error:\n    print(json.dumps({'error':str(error), 'type':type(error).__name__}))\nasyncio.run(main())\n`);
  const run = async (args: string[], available = true, systemAvailable = true, recalculate?: string) => {
    const env = { PATH: bin, TMPDIR: root, ...(available ? { ZCODE_PREINSTALLED_TOOLS_AVAILABLE: "1" } : {}) };
    // -B：导入插件源码目录下的统一入口时不写 __pycache__。
    const { stdout } = await exec("python3", ["-B", driver, JSON.stringify(args), JSON.stringify(env), JSON.stringify(systemAvailable ? [system] : []), ...(recalculate ? [recalculate] : [])]);
    return JSON.parse(stdout);
  };
  return { root, bin, run, systemCalls };
}

describe.skipIf(process.platform === "win32")("LibreOffice PATH entry boundary", () => {
  it.each(["missing", "failure", "vanish"])("uses system once when managed entry is %s", async (mode) => {
    const f = await fixture(mode);
    try {
      const result = await f.run(["--convert-to", "pdf"]);
      expect(result.source).toBe("system");
      expect(result.stderr).toContain(mode === "missing" ? "未就绪或已关闭" : "运行失败");
      expect(result.notice).toMatch(new RegExp(`^Using system LibreOffice 7\\.6\\.0\\.0\\. 受管版本未使用：${mode === "missing" ? "未就绪或已关闭" : "运行失败"}`));
      expect((await readFile(f.systemCalls, "utf8")).trim().split("\n")).toHaveLength(2);
      expect((await readdir(f.root)).filter((name) => name.startsWith("zcode-libreoffice-"))).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("selects guidance from availability without reading an installation record", async () => {
    const f = await fixture("missing");
    try {
      expect((await f.run(["--version"], true, false)).error).toContain("帮助 → 预装工具");
      const standalone = await f.run(["--version"], false, false);
      expect(standalone.error).not.toContain("帮助 → 预装工具");
      expect(standalone.error).toContain("env_setup/setup.md");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects caller profile overrides without starting the system program", async () => {
    const f = await fixture("failure");
    try {
      expect((await f.run(["-env:UserInstallation=file:///tmp/override"])).error).toContain("调用参数不能覆盖");
      await expect(readFile(f.systemCalls)).rejects.toHaveProperty("code", "ENOENT");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it.each([
    ["exits non-zero", "printf 'missing libfoo.so\\n' >&2; exit 127", "missing libfoo.so"],
    ["times out", "/bin/sleep 5", "timed out"],
  ])("reports a system program that %s instead of installation guidance", async (_name, systemVersion, cause) => {
    const f = await fixture("missing", systemVersion);
    try {
      const result = await f.run(["--version"]);
      expect(result.type).toBe("LibreOfficeInvocationError");
      expect(result.error).toContain("系统 LibreOffice 无法运行");
      expect(result.error).toContain(cause);
      expect(result.error).toContain("帮助 → 预装工具");
      expect(result.error).not.toContain("LibreOffice not found");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("reports a missing recalculation input without starting any program", async () => {
    const f = await fixture("ready");
    try {
      const result = await f.run([], true, true, join(f.root, "missing.xlsx"));
      expect(result.type).toBe("LibreOfficeInvocationError");
      expect(result.error).toContain("重算输入不是文件");
      expect(result.error).not.toContain("受管版本未使用");
      expect(result.error).not.toContain("setup.md");
      await expect(readFile(f.systemCalls)).rejects.toHaveProperty("code", "ENOENT");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("does not rerun the system program after cancellation", async () => {
    const f = await fixture("ready");
    try {
      const entry = join(f.bin, "zcode-soffice");
      const driver = join(f.root, "cancel.py");
      await writeFile(entry, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('LibreOffice 26.8.1');else {process.stdout.write('started');setInterval(()=>{},1000)}\n`, { mode: 0o755 });
      await writeFile(driver, `import asyncio, sys\nsys.path.insert(0, ${JSON.stringify(helper)})\nfrom zcode_libreoffice import run_libreoffice\nfrom pathlib import Path\nasync def main():\n  task=asyncio.create_task(run_libreoffice(['--convert-to','pdf'], environment={'PATH':${JSON.stringify(f.bin)},'TMPDIR':${JSON.stringify(f.root)}}, candidate_paths=[Path(${JSON.stringify(join(f.root, 'system-office'))})]))\n  await asyncio.sleep(.2)\n  task.cancel()\n  try: await task\n  except asyncio.CancelledError: print('cancelled')\nasyncio.run(main())\n`);
      const result = await exec("python3", ["-B", driver]);
      expect(result.stdout.trim()).toBe("cancelled");
      await expect(readFile(f.systemCalls)).rejects.toHaveProperty("code", "ENOENT");
      expect((await readdir(f.root)).filter((name) => name.startsWith("zcode-libreoffice-"))).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
