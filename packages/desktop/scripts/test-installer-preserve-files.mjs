import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const workspaceDir = resolve(desktopDir, "../..");
const fixturePath = resolve(desktopDir, "test/fixtures/installer-preserve-files.nsi");
const installerNshPath = resolve(desktopDir, "build/installer.nsh");
const appBuilderLibDir = dirname(require.resolve("app-builder-lib/package.json"));
const { getBinFromUrl } = require(resolve(appBuilderLibDir, "out/binDownload.js"));

const NSIS_CHECKSUM =
  "VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==";
const NSIS_RESOURCES_CHECKSUM =
  "Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==";

if (process.platform !== "win32") {
  process.stdout.write("[installer-preserve-files] skipped: Windows only\n");
} else {
  const [nsisDir, nsisResourcesDir] = await Promise.all([
    getBinFromUrl("nsis-3.0.4.1", "nsis-3.0.4.1.7z", NSIS_CHECKSUM),
    getBinFromUrl("nsis-resources-3.4.1", "nsis-resources-3.4.1.7z", NSIS_RESOURCES_CHECKSUM),
  ]);
  const tempRoot = mkdtempSync(join(tmpdir(), "zcode-preserve-files-"));
  try {
    const makensisPath = resolve(nsisDir, "makensis.exe");
    const uninstallerOutput = join(tempRoot, "uninstaller.exe");
    execFileSync(
      makensisPath,
      [
        "/V2",
        "/INPUTCHARSET",
        "UTF8",
        "/WX",
        "/DBUILD_UNINSTALLER",
        `/DNSIS_INCLUDE_DIR=${resolve(nsisDir, "Include")}`,
        `/DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${resolve(appBuilderLibDir, "templates/nsis/include")}`,
        `/DNSIS_PLUGIN_DIR=${resolve(nsisResourcesDir, "plugins/x86-unicode")}`,
        `/DZCODE_INSTALLER_NSH=${installerNshPath}`,
        `/DZCODE_INSTALLER_PROCESS_HELPER=${resolve(desktopDir, `bundled-tools/win32-${process.arch}/runtime-host/zcode-installer-process-helper.exe`)}`,
        // 夹具只校验文件字节，不执行该载荷；避免 32 位 NSIS 将 System32 重定向到 SysWOW64。
        `/DFIXTURE_EXE=${fixturePath}`,
        `/DOUTPUT_FILE=${uninstallerOutput}`,
        fixturePath,
      ],
      { cwd: workspaceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const legacySelfUninstaller = join(tempRoot, "legacy-self-uninstaller.exe");
    execFileSync(
      makensisPath,
      [
        "/V2",
        "/INPUTCHARSET",
        "UTF8",
        "/WX",
        `/DOUTPUT_FILE=${legacySelfUninstaller}`,
        resolve(desktopDir, "test/fixtures/legacy-self-manifest-uninstaller.nsi"),
      ],
      { cwd: workspaceDir, encoding: "utf8" },
    );
    for (const [scenario, omitManifest] of [
      ["manifest", false],
      ["legacy", true],
      ["self-manifest", false],
    ]) {
      const outputPath = join(tempRoot, `${scenario}.exe`);
      const installDir = join(tempRoot, scenario);
      const compileArgs = [
        "/V2",
        "/INPUTCHARSET",
        "UTF8",
        `/DNSIS_INCLUDE_DIR=${resolve(nsisDir, "Include")}`,
        `/DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${resolve(appBuilderLibDir, "templates/nsis/include")}`,
        `/DNSIS_PLUGIN_DIR=${resolve(nsisResourcesDir, "plugins/x86-unicode")}`,
        `/DZCODE_INSTALLER_NSH=${installerNshPath}`,
        `/DZCODE_INSTALLER_PROCESS_HELPER=${resolve(desktopDir, `bundled-tools/win32-${process.arch}/runtime-host/zcode-installer-process-helper.exe`)}`,
        `/DFIXTURE_EXE=${fixturePath}`,
        `/DOUTPUT_FILE=${outputPath}`,
        fixturePath,
      ];
      if (omitManifest) compileArgs.splice(-1, 0, "/DOMIT_MANIFEST");
      if (scenario === "self-manifest") compileArgs.splice(-1, 0, "/DSELF_MANIFEST");
      execFileSync(makensisPath, compileArgs, {
        cwd: workspaceDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync(outputPath, ["/S", `/D=${installDir}`], { encoding: "utf-8" });
      const ownedFileExists = existsSync(join(installDir, "owned-by-zcode.txt"));
      if (omitManifest !== ownedFileExists) {
        throw new Error(`${scenario}: ownership fallback mismatch`);
      }
      if (!existsSync(join(installDir, "user-data.txt"))) {
        throw new Error(`${scenario}: unrelated file was removed`);
      }
      if (readFileSync(join(installDir, "ZCode.exe")).length === 0) {
        throw new Error(`${scenario}: application payload was not installed`);
      }
    }
    const failureOutputPath = join(tempRoot, "failure.exe");
    const failureInstallDir = join(tempRoot, "failure");
    const failureLogPath = join(tempRoot, "failure-uninstaller.log");
    const failureCompileArgs = [
      "/V2",
      "/INPUTCHARSET",
      "UTF8",
      "/WX",
      "/DBUILD_UNINSTALLER",
      `/DNSIS_INCLUDE_DIR=${resolve(nsisDir, "Include")}`,
      `/DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${resolve(appBuilderLibDir, "templates/nsis/include")}`,
      `/DNSIS_PLUGIN_DIR=${resolve(nsisResourcesDir, "plugins/x86-unicode")}`,
      `/DZCODE_INSTALLER_NSH=${installerNshPath}`,
      `/DZCODE_INSTALLER_PROCESS_HELPER=${resolve(desktopDir, `bundled-tools/win32-${process.arch}/runtime-host/zcode-installer-process-helper.exe`)}`,
      `/DFIXTURE_EXE=${fixturePath}`,
      `/DOUTPUT_FILE=${failureOutputPath}`,
      `/DZCODE_UNINSTALLER_LOG_PATH=${failureLogPath}`,
      "/DFAIL_DELETE",
      fixturePath,
    ];
    execFileSync(makensisPath, failureCompileArgs, {
      cwd: workspaceDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failureExitCode = 0;
    try {
      execFileSync(failureOutputPath, ["/S", `/D=${failureInstallDir}`], {
        encoding: "utf-8",
      });
    } catch (error) {
      failureExitCode = error.status ?? 0;
    }
    if (failureExitCode === 0) {
      throw new Error("manifest cleanup failure unexpectedly returned success");
    }
    const failureLog = readFileSync(failureLogPath, "utf8");
    for (const marker of [
      "cleanup-started",
      "cleanup-failed reason=delete-failed path=owned-by-zcode.txt win32-error=",
    ]) {
      if (!failureLog.includes(marker)) {
        throw new Error(`uninstaller log is missing ${marker}: ${failureLog}`);
      }
    }
    if (!/\[pid=[1-9]\d*\]/.test(failureLog)) {
      throw new Error(`uninstaller log is missing a positive PID: ${failureLog}`);
    }

    if (existsSync(join(failureInstallDir, "ZCode.exe"))) {
      throw new Error("old cleanup fixture did not reproduce the deleted application");
    }
    // 真正运行旧清理进程，分别验证完整恢复、可选备份失败和成功后的新载荷写入。
    for (const scenario of [
      "recovery",
      "backup-failure",
      "backup-and-uninstall-failure",
      "restore-failure",
      "backup-delete-failure",
      "backup-delete-success",
      "self-manifest-recovery",
      "self-manifest-success",
    ]) {
      const installSucceeds = [
        "backup-failure",
        "backup-delete-success",
        "self-manifest-success",
      ].includes(scenario);
      const backupFails =
        scenario === "backup-failure" || scenario === "backup-and-uninstall-failure";
      const deleteFails =
        scenario === "backup-delete-failure" || scenario === "backup-delete-success";
      const recoveryOutputPath = join(tempRoot, `${scenario}.exe`);
      const recoveryInstallDir = join(tempRoot, scenario);
      const installerLogPath = join(tempRoot, `${scenario}-installer.log`);
      const recoveryArgs = failureCompileArgs.filter(
        (arg) =>
          arg !== "/DBUILD_UNINSTALLER" &&
          arg !== "/DFAIL_DELETE" &&
          arg !== "/WX" &&
          !arg.startsWith("/DOUTPUT_FILE=") &&
          arg !== fixturePath,
      );
      recoveryArgs.push(
        `/DOUTPUT_FILE=${recoveryOutputPath}`,
        "/DRECOVERY_TEST",
        `/DZCODE_INSTALLER_DEFAULT_LOG_PATH=${installerLogPath}`,
        `/DOLD_CLEANUP_EXE=${installSucceeds ? legacySelfUninstaller : failureOutputPath}`,
      );
      if (scenario.startsWith("self-manifest")) recoveryArgs.push("/DSELF_MANIFEST");
      if (backupFails) recoveryArgs.push("/DBACKUP_FAILURE");
      if (scenario === "restore-failure") recoveryArgs.push("/DRESTORE_FAILURE");
      if (deleteFails) recoveryArgs.push("/DBACKUP_DELETE_FAILURE");
      recoveryArgs.push(fixturePath);
      execFileSync(makensisPath, recoveryArgs, { cwd: workspaceDir, encoding: "utf8" });
      let recoveryExitCode = 0;
      try {
        execFileSync(recoveryOutputPath, ["/S", `/D=${recoveryInstallDir}`], { encoding: "utf8" });
      } catch (error) {
        recoveryExitCode = error.status ?? 0;
      }
      const expectedExitCode = installSucceeds ? 0 : 2;
      if (recoveryExitCode !== expectedExitCode)
        throw new Error(
          `${scenario}: exit code ${recoveryExitCode}, expected ${expectedExitCode}; fixture=${tempRoot}`,
        );
      const backupDirPath = join(recoveryInstallDir, "backup-dir.txt");
      if (!existsSync(backupDirPath)) {
        throw new Error(`${scenario}: backup directory marker missing`);
      }
      const backupDir = readFileSync(backupDirPath, "utf8");
      if (backupFails && backupDir !== "") {
        throw new Error(`${scenario}: partial backup is still available for recovery`);
      }
      const shouldRetainBackup = scenario === "restore-failure" || deleteFails;
      if ((backupDir !== "" && existsSync(backupDir)) !== shouldRetainBackup) {
        throw new Error(`${scenario}: wrong backup retention state`);
      }
      if (
        scenario === "restore-failure" &&
        readFileSync(join(backupDir, "ZCode.exe"), "utf8") !== "old application payload"
      ) {
        throw new Error(`${scenario}: recoverable application backup was lost`);
      }
      const installerLog = readFileSync(installerLogPath, "utf8");
      // 重试耗尽的提示按是否存在完整备份切换；recoverable 标志验证提示分支与文件状态一致。
      if (
        !installSucceeds &&
        !installerLog.includes(
          `cleanup-retries-exhausted exit-code=2 recoverable=${backupFails ? "0" : "1"}`,
        )
      ) {
        throw new Error(`${scenario}: retry prompt recoverable flag mismatch`);
      }
      if (backupFails) {
        if (
          !installerLog.includes("cleanup-backup-completed failed=1") ||
          !installerLog.includes("cleanup-backup-skipped")
        ) {
          throw new Error(`${scenario}: backup failure was not logged`);
        }
        if (installerLog.includes("cleanup-restore-completed")) {
          throw new Error(`${scenario}: attempted recovery without a complete backup`);
        }
      }
      if (deleteFails && !installerLog.includes(`cleanup-backup-delete-failed path=${backupDir}`)) {
        throw new Error(`${scenario}: cleanup failure path was not logged`);
      }
      const installMarker = join(recoveryInstallDir, "remove-result.txt");
      if (existsSync(installMarker) !== installSucceeds) {
        throw new Error(`${scenario}: wrong new-payload installation state`);
      }
      if (installSucceeds) {
        if (
          !readFileSync(join(recoveryInstallDir, "ZCode.exe")).equals(readFileSync(fixturePath)) ||
          readFileSync(installMarker, "utf8") !== "removed"
        ) {
          throw new Error(`${scenario}: new application payload was not installed after cleanup`);
        }
      } else if (scenario === "backup-and-uninstall-failure") {
        if (existsSync(join(recoveryInstallDir, "ZCode.exe"))) {
          throw new Error(`${scenario}: partial backup was incorrectly restored`);
        }
      } else if (
        scenario !== "restore-failure" &&
        readFileSync(join(recoveryInstallDir, "ZCode.exe"), "utf8") !== "old application payload"
      ) {
        throw new Error(`${scenario}: original application bytes were lost`);
      }
      if (
        scenario === "self-manifest-recovery" &&
        readFileSync(join(recoveryInstallDir, ".zcode-install-manifest"), "utf8") !==
          "ZCode.exe\r\nowned-by-zcode.txt\r\n.zcode-install-manifest\r\n..\\user-data.txt\r\n"
      ) {
        throw new Error("self-manifest-recovery: original manifest bytes changed");
      }
      if (readFileSync(join(recoveryInstallDir, "user-data.txt"), "utf8") !== "keep me") {
        throw new Error(`${scenario}: recovery changed unrelated data`);
      }
    }

    process.stdout.write("[installer-preserve-files] passed\n");
  } finally {
    if (process.env.ZCODE_KEEP_INSTALLER_FIXTURE !== "1") {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
