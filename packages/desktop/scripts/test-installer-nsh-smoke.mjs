import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const workspaceDir = resolve(desktopDir, "../..");
const fixturePath = resolve(desktopDir, "test/fixtures/installer-nsh-smoke.nsi");
const installerNshPath = resolve(desktopDir, "build/installer.nsh");
const appBuilderLibDir = dirname(require.resolve("app-builder-lib/package.json"));
const { getBinFromUrl } = require(resolve(appBuilderLibDir, "out/binDownload.js"));

const NSIS_CHECKSUM =
  "VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==";
const NSIS_RESOURCES_CHECKSUM =
  "Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==";

function normalizeWindowsPath(value) {
  return resolve(value).replaceAll("/", "\\").toLowerCase();
}

function readInstallerLog(logPath) {
  const content = readFileSync(logPath);
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString("utf16le");
  }
  return content.toString("utf8");
}

function assertInstallerLog(logPath, mode, role = "outer") {
  if (!existsSync(logPath)) {
    throw new Error(`installer log was not created: ${logPath}`);
  }
  const log = readInstallerLog(logPath);
  for (const marker of [
    `installer-process-started role=${role}`,
    `installer-initialized mode=${mode}`,
    "install-started",
    "cleanup-started",
    "cleanup-completed",
    "extract-started",
    "extract-completed",
    "shortcuts-started",
    "shortcuts-completed",
    "install-finalization-started",
    "install-completed",
  ]) {
    if (!log.includes(marker)) {
      throw new Error(`installer log is missing ${marker}: ${log}`);
    }
  }
  if (!/\[pid=[1-9]\d*\]/.test(log)) {
    throw new Error(`installer log is missing a positive PID: ${log}`);
  }
}

function readShortcutProperty(shortcutPath, propertyName) {
  const propertyExpression = {
    arguments: "$shortcut.Arguments",
    targetPath: "$shortcut.TargetPath",
  }[propertyName];
  if (!propertyExpression) {
    throw new Error(`Unsupported shortcut property: ${propertyName}`);
  }

  const command = [
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($env:ZCODE_SHORTCUT_PATH)",
    `[Console]::Out.Write(${propertyExpression})`,
  ].join("; ");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf-8",
    env: { ...process.env, ZCODE_SHORTCUT_PATH: shortcutPath },
  }).trim();
}

function compileFixture({
  makensisPath,
  nsisDir,
  nsisResourcesDir,
  outputPath,
  shortcutState,
  defaultLogPath,
  elevatedLogPath,
  forceElevatedInner = false,
  buildUninstaller = false,
}) {
  const args = [
    "/V2",
    "/INPUTCHARSET",
    "UTF8",
    ...(buildUninstaller ? ["/WX", "/DBUILD_UNINSTALLER"] : []),
    `/DNSIS_INCLUDE_DIR=${resolve(nsisDir, "Include")}`,
    `/DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${resolve(appBuilderLibDir, "templates/nsis/include")}`,
    `/DNSIS_PLUGIN_DIR=${resolve(nsisResourcesDir, "plugins/x86-unicode")}`,
    `/DZCODE_INSTALLER_NSH=${installerNshPath}`,
    `/DZCODE_INSTALLER_PROCESS_HELPER=${resolve(desktopDir, `bundled-tools/win32-${process.arch}/runtime-host/zcode-installer-process-helper.exe`)}`,
    `/DFIXTURE_EXE=${process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"}`,
    `/DOUTPUT_FILE=${outputPath}`,
    `/DDEFAULT_LOG_PATH=${defaultLogPath}`,
    `/DELEVATED_LOG_PATH=${elevatedLogPath}`,
    ...(forceElevatedInner ? ["/DFORCE_ELEVATED_INNER"] : []),
    ...(shortcutState !== "deleted" ? ["/DPRECREATE_SHORTCUTS"] : []),
    ...(shortcutState === "stale" ? ["/DSTALE_SHORTCUTS"] : []),
    fixturePath,
  ];
  execFileSync(makensisPath, args, {
    cwd: workspaceDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runFixture(installerPath, installDir, customLogPath) {
  const args = ["/S"];
  if (customLogPath) args.push(`/LOG=${customLogPath}`);
  args.push(`/D=${installDir}`);
  execFileSync(installerPath, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function main() {
  if (process.platform !== "win32") {
    process.stdout.write("[installer-nsh-smoke] skipped: Windows only\n");
    return;
  }

  const [nsisDir, nsisResourcesDir] = await Promise.all([
    getBinFromUrl("nsis-3.0.4.1", "nsis-3.0.4.1.7z", NSIS_CHECKSUM),
    getBinFromUrl("nsis-resources-3.4.1", "nsis-resources-3.4.1.7z", NSIS_RESOURCES_CHECKSUM),
  ]);
  const makensisPath = resolve(nsisDir, "makensis.exe");
  const tempRoot = mkdtempSync(join(tmpdir(), "zcode-installer-nsh-smoke-"));

  try {
    const uninstallerFixturePath = join(tempRoot, "uninstaller-fixture.exe");
    compileFixture({
      makensisPath,
      nsisDir,
      nsisResourcesDir,
      outputPath: uninstallerFixturePath,
      shortcutState: "deleted",
      defaultLogPath: join(tempRoot, "uninstaller-default.log"),
      elevatedLogPath: join(tempRoot, "uninstaller-elevated.log"),
      buildUninstaller: true,
    });
    const normalUninstallDir = join(tempRoot, "normal-uninstall");
    runFixture(uninstallerFixturePath, normalUninstallDir);
    if (existsSync(normalUninstallDir)) {
      throw new Error("normal uninstall left the installation directory behind");
    }

    for (const scenario of ["preserved", "stale", "deleted"]) {
      const installerPath = join(tempRoot, `${scenario}-fixture.exe`);
      const installDir = join(tempRoot, `${scenario}-install`);
      compileFixture({
        makensisPath,
        nsisDir,
        nsisResourcesDir,
        outputPath: installerPath,
        shortcutState: scenario,
        defaultLogPath: join(tempRoot, `${scenario}-default.log`),
        elevatedLogPath: join(tempRoot, `${scenario}-elevated.log`),
      });
      const customLogPath = scenario === "stale" ? join(tempRoot, "custom.log") : undefined;
      runFixture(installerPath, installDir, customLogPath);
      assertInstallerLog(customLogPath ?? join(tempRoot, `${scenario}-default.log`), "silent");

      const appExe = join(installDir, "ZCode.exe");
      const startMenuLink = join(installDir, "start-menu.lnk");
      const desktopLink = join(installDir, "desktop.lnk");
      const launchLink = readFileSync(join(installDir, "launch-link.txt"), "utf-8");
      if (normalizeWindowsPath(launchLink) !== normalizeWindowsPath(appExe)) {
        throw new Error(`${scenario}: launchLink did not resolve to appExe`);
      }

      if (scenario !== "deleted") {
        const readShortcutTargetResult = readFileSync(
          join(installDir, "read-shortcut-target.txt"),
          "utf-8",
        );
        const expectedInitialTarget =
          scenario === "preserved" ? appExe : join(installDir, "stale-target.exe");
        if (
          normalizeWindowsPath(readShortcutTargetResult) !==
          normalizeWindowsPath(expectedInitialTarget)
        ) {
          throw new Error(
            `${scenario}: installer could not read shortcut target: ${readShortcutTargetResult}`,
          );
        }

        for (const shortcutPath of [startMenuLink, desktopLink]) {
          if (!existsSync(shortcutPath)) {
            throw new Error(`${scenario}: expected shortcut was not recreated: ${shortcutPath}`);
          }
          const target = readShortcutProperty(shortcutPath, "targetPath");
          if (normalizeWindowsPath(target) !== normalizeWindowsPath(appExe)) {
            throw new Error(`${scenario}: shortcut target mismatch: ${target}`);
          }
          const shortcutArguments = readShortcutProperty(shortcutPath, "arguments");
          const expectedArguments = scenario === "preserved" ? "--preserved" : "";
          if (shortcutArguments !== expectedArguments) {
            throw new Error(`${scenario}: shortcut arguments mismatch: ${shortcutArguments}`);
          }
        }
      } else if (existsSync(startMenuLink) || existsSync(desktopLink)) {
        throw new Error(`${scenario}: a user-deleted shortcut was recreated`);
      }
    }

    const elevatedInstallerPath = join(tempRoot, "elevated-fixture.exe");
    const elevatedInstallDir = join(tempRoot, "elevated-install");
    const elevatedLogPath = join(tempRoot, "elevated.log");
    const attackerLogPath = join(tempRoot, "attacker.log");
    writeFileSync(attackerLogPath, "canary", "utf8");
    compileFixture({
      makensisPath,
      nsisDir,
      nsisResourcesDir,
      outputPath: elevatedInstallerPath,
      shortcutState: "deleted",
      defaultLogPath: join(tempRoot, "elevated-default.log"),
      elevatedLogPath,
      forceElevatedInner: true,
    });
    runFixture(elevatedInstallerPath, elevatedInstallDir, attackerLogPath);
    if (readFileSync(attackerLogPath, "utf8") !== "canary") {
      throw new Error("elevated installer modified caller-controlled /LOG path");
    }
    assertInstallerLog(elevatedLogPath, "silent", "elevated-inner");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write("[installer-nsh-smoke] passed\n");
}

await main();
