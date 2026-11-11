import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";

const PATCH_MARKER = "; zcode-installer-details-v1";

function optionalMacro(name) {
  return [`!ifmacrodef ${name}`, `  !insertmacro ${name}`, "!endif"].join("\n");
}

function replaceRequired(source, needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index === -1) {
    throw new Error(`electron-builder installSection.nsh 缺少预期锚点：${label}`);
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

/**
 * 给 electron-builder 的安装段补上可见阶段，并开启 NSIS 内置逐文件详情。
 *
 * 这里不复制整份上游模板，避免 electron-builder 升级时静默带入旧模板；每次打包
 * 都必须命中下面的结构锚点，模板结构变化会立即失败并提醒维护者重新对齐。
 */
export function patchNsisInstallSectionSource(source) {
  const sourceEol = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (patched.includes(PATCH_MARKER)) {
    return source;
  }

  const detailsAnchor = "${IfNot} ${Silent}\n  SetDetailsPrint none\n${endif}";
  patched = replaceRequired(
    patched,
    detailsAnchor,
    [
      PATCH_MARKER,
      "# 详情区需要同时显示 electron-builder 的 File 条目和项目阶段。",
      "${IfNot} ${Silent}",
      "  SetDetailsPrint listonly",
      "${endif}",
      optionalMacro("customInstallSectionStarted"),
    ].join("\n"),
    "SetDetailsPrint none",
  );

  const cleanupStartAnchor =
    "!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT";
  patched = replaceRequired(
    patched,
    cleanupStartAnchor,
    `${optionalMacro("customInstallCleanupStarted")}\n${cleanupStartAnchor}`,
    "SHELL_CONTEXT cleanup",
  );

  const cleanupEndAnchor =
    '${if} $installMode == "all"\n  !insertmacro uninstallOldVersion HKEY_CURRENT_USER\n  !insertmacro handleUninstallResult HKEY_CURRENT_USER\n${endIf}';
  patched = replaceRequired(
    patched,
    cleanupEndAnchor,
    `${cleanupEndAnchor}\n${optionalMacro("customInstallCleanupCompleted")}`,
    "HKEY_CURRENT_USER cleanup",
  );

  const extractAnchor = "!insertmacro installApplicationFiles";
  patched = replaceRequired(
    patched,
    extractAnchor,
    `${optionalMacro("customInstallExtractStarted")}\n${extractAnchor}\n${optionalMacro("customInstallExtractCompleted")}`,
    "application extraction",
  );

  const shortcutsAnchor =
    "!insertmacro addStartMenuLink $keepShortcuts\n!insertmacro addDesktopLink $keepShortcuts";
  patched = replaceRequired(
    patched,
    shortcutsAnchor,
    `${optionalMacro("customInstallShortcutsStarted")}\n${shortcutsAnchor}\n${optionalMacro("customInstallShortcutsCompleted")}`,
    "shortcut installation",
  );

  return sourceEol === "\r\n" ? patched.replaceAll("\n", "\r\n") : patched;
}

export async function patchNsisInstallSectionFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const patched = patchNsisInstallSectionSource(source);
  if (patched === source) {
    return { changed: false, originalSource: null };
  }

  await writeFile(filePath, patched, "utf8");
  return { changed: true, originalSource: source };
}

export function restoreNsisInstallSectionFileSync({ filePath, originalSource }) {
  if (originalSource !== null) {
    writeFileSync(filePath, originalSource, "utf8");
  }
}

export { PATCH_MARKER };

const UTIL_PATCH_MARKER = "; zcode-uninstall-recovery-v1";

export function patchNsisInstallUtilSource(source) {
  const sourceEol = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (patched.includes(UTIL_PATCH_MARKER)) return source;
  patched = replaceRequired(
    patched,
    "  # Retry counter\n  StrCpy $R5 0",
    `  ${UTIL_PATCH_MARKER}\n${optionalMacro("customOldUninstallPrepare")}\n  # Retry counter\n  StrCpy $R5 0`,
    "old uninstaller preparation",
  );
  const prompt =
    '      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt';
  patched = replaceRequired(
    patched,
    prompt,
    [
      "!ifmacrodef customOldUninstallRetryFailed",
      "      !insertmacro customOldUninstallRetryFailed",
      "!else",
      prompt,
      "!endif",
    ].join("\n"),
    "old uninstaller exhausted retries",
  );
  return sourceEol === "\r\n" ? patched.replaceAll("\n", "\r\n") : patched;
}

export async function patchNsisInstallUtilFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const patched = patchNsisInstallUtilSource(source);
  if (patched === source) return { changed: false, originalSource: null };
  await writeFile(filePath, patched, "utf8");
  return { changed: true, originalSource: source };
}
