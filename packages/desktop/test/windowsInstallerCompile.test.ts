import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopDir = resolve(import.meta.dirname, "..");
const builderDir = dirname(require.resolve("app-builder-lib/package.json"));

it("compiles real UAC calls when the plugin directory follows the custom include", async (context) => {
  // NSIS 自带的 mac 编译器是 x86_64；Apple Silicon 缺少 Rosetta 时只跳过此环境不支持的编译测试。
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      await execFileAsync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (stderr.includes("Bad CPU type in executable")) {
        context.skip("NSIS x86_64 compiler requires Rosetta on Apple Silicon");
        return;
      }
      throw error;
    }
  }
  // 26.17.0 将 NSIS 下载与路径解析收口到 toolset resolver；旧 nsisUtil 私有导出已移除。
  // 测试必须复用正式构建入口，避免用另一套 compiler/include/plugin 路径掩盖兼容问题。
  const { getMakeNsisPath, getNsisPluginsPath } = require(
    resolve(builderDir, "out/toolsets/windows.js"),
  );
  const [makeNsis, pluginsDir] = await Promise.all([
    getMakeNsisPath(undefined),
    getNsisPluginsPath(undefined),
  ]);
  const nsisDir = makeNsis.env?.NSISDIR;
  if (!nsisDir) {
    throw new Error("electron-builder NSIS toolset 缺少 NSISDIR");
  }
  const compiler = makeNsis.path;
  const temp = await mkdtemp(join(tmpdir(), "zcode-nsis-compile-"));
  try {
    for (const uninstaller of [false, true]) {
      const output = join(temp, uninstaller ? "uninstaller.exe" : "installer.exe");
      // 只编译不执行：载荷复用当前文件，所有平台都能验证真实 NSIS 插件解析。
      const args = [
        "-V2",
        "-INPUTCHARSET",
        "UTF8",
        ...(uninstaller ? ["-WX", "-DBUILD_UNINSTALLER"] : []),
        `-DNSIS_INCLUDE_DIR=${join(nsisDir, "Include")}`,
        `-DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${join(builderDir, "templates/nsis/include")}`,
        `-DNSIS_PLUGIN_DIR=${join(pluginsDir, "x86-unicode")}`,
        `-DZCODE_INSTALLER_NSH=${join(desktopDir, "build/installer.nsh")}`,
        `-DFIXTURE_EXE=${import.meta.filename}`,
        `-DOUTPUT_FILE=${output}`,
        `-DDEFAULT_LOG_PATH=${join(temp, "default.log")}`,
        `-DELEVATED_LOG_PATH=${join(temp, "elevated.log")}`,
        join(desktopDir, "test/fixtures/installer-nsh-smoke.nsi"),
      ];
      const result = await execFileAsync(compiler, args, {
        env: { ...process.env, ...makeNsis.env },
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain("warning 6000");
      expect((await stat(output)).size).toBeGreaterThan(0);
    }
    // 恢复夹具必须引用新宏，避免 NSIS 裁掉未引用函数后掩盖语法或变量错误。
    for (const failureMode of [undefined, "BACKUP_FAILURE", "RESTORE_FAILURE"]) {
      const recoveryOutput = join(temp, `recovery-${failureMode ?? "normal"}.exe`);
      await execFileAsync(
        compiler,
        [
          "-V2",
          "-INPUTCHARSET",
          "UTF8",
          `-DNSIS_INCLUDE_DIR=${join(nsisDir, "Include")}`,
          `-DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${join(builderDir, "templates/nsis/include")}`,
          `-DNSIS_PLUGIN_DIR=${join(pluginsDir, "x86-unicode")}`,
          `-DZCODE_INSTALLER_NSH=${join(desktopDir, "build/installer.nsh")}`,
          `-DFIXTURE_EXE=${import.meta.filename}`,
          `-DOUTPUT_FILE=${recoveryOutput}`,
          "-DRECOVERY_TEST",
          ...(failureMode ? [`-D${failureMode}`] : []),
          `-DOLD_CLEANUP_EXE=${join(temp, "uninstaller.exe")}`,
          join(desktopDir, "test/fixtures/installer-preserve-files.nsi"),
        ],
        { env: { ...process.env, ...makeNsis.env } },
      );
      expect((await stat(recoveryOutput)).size).toBeGreaterThan(0);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);
