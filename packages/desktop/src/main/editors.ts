/* eslint-disable max-lines -- 编辑器检测需要集中维护跨平台路径、图标解析和缓存逻辑。 */
/**
 * 编辑器检测与打开 —— 检测系统中已安装的编辑器/终端，获取图标，打开路径
 *
 * 当前支持 macOS / Windows。Linux 后续再补。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { join, win32 as pathWin32 } from "node:path";
import { app, nativeImage } from "electron";
import type { EditorInfo } from "@zcode/shared";
import { getZCodeDataRootDir } from "@zcode/services/node";
import { logger } from "./logger.js";
import {
  getFileApplicationDefs,
  matchesFileApplication,
  resolveFileApplicationPath,
} from "@desktop/main/fileApplications.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const WINDOWS_EXPLORER_PATH = pathWin32.join(process.env.WINDIR ?? "C:/Windows", "explorer.exe");

export interface EditorDef {
  id: string;
  name: string;
  /** macOS .app bundle 路径 */
  appPath: string;
  appPathCandidates?: string[];
  windowsCommandAppNames?: string[];
  /** CLI 命令名（如果有）。用于 open folder；null 则 fallback 到 `open -a` */
  command: string | null;
}

interface AppBundleInfoPlist {
  CFBundleIconFile?: string;
  CFBundleIconFiles?: string[];
  CFBundleIconName?: string;
  CFBundleIcons?: {
    CFBundlePrimaryIcon?: {
      CFBundleIconFiles?: string[];
      CFBundleIconName?: string;
    };
  };
}

interface ResolvedAppIconPath {
  candidateIconNames: string[];
  path: string | null;
  reason: "resolved" | "missing-plist" | "missing-icon-name" | "missing-icon-file";
}

interface ParsedIcnsPngCandidate {
  osType: string;
  size: number;
  image: Buffer;
}

const MAC_EDITOR_DEFS: EditorDef[] = [
  // 代码编辑器
  {
    id: "vscode",
    name: "VS Code",
    appPath: "/Applications/Visual Studio Code.app",
    command: "code",
  },
  // 这里之前只登记了稳定版 VS Code，`getInstalledEditors()` 又完全依赖这份静态白名单做 existsSync 过滤。
  // 用户安装的是 `Visual Studio Code - Insiders.app` 时，主进程根本不会把它纳入候选列表，UI 自然也就显示不出来。
  // 补上独立定义后，既能识别 Insiders，也能复用现有的 `code-insiders` CLI / `open -a` 降级打开链路。
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    appPath: "/Applications/Visual Studio Code - Insiders.app",
    command: "code-insiders",
  },
  { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app", command: "cursor" },
  { id: "trae", name: "Trae", appPath: "/Applications/Trae.app", command: null },
  { id: "zed", name: "Zed", appPath: "/Applications/Zed.app", command: "zed" },
  {
    id: "sublime",
    name: "Sublime Text",
    appPath: "/Applications/Sublime Text.app",
    command: "subl",
  },
  { id: "codebuddy", name: "CodeBuddy", appPath: "/Applications/CodeBuddy.app", command: null },
  { id: "qoder", name: "Qoder", appPath: "/Applications/Qoder.app", command: null },
  // JetBrains 系列
  {
    id: "idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
    command: "idea",
  },
  {
    id: "idea-ce",
    name: "IntelliJ IDEA CE",
    appPath: "/Applications/IntelliJ IDEA CE.app",
    command: "idea",
  },
  { id: "webstorm", name: "WebStorm", appPath: "/Applications/WebStorm.app", command: "webstorm" },
  { id: "pycharm", name: "PyCharm", appPath: "/Applications/PyCharm.app", command: "pycharm" },
  { id: "goland", name: "GoLand", appPath: "/Applications/GoLand.app", command: "goland" },
  { id: "phpstorm", name: "PhpStorm", appPath: "/Applications/PhpStorm.app", command: "phpstorm" },
  { id: "rider", name: "Rider", appPath: "/Applications/Rider.app", command: "rider" },
  { id: "clion", name: "CLion", appPath: "/Applications/CLion.app", command: "clion" },
  { id: "rubymine", name: "RubyMine", appPath: "/Applications/RubyMine.app", command: "rubymine" },
  { id: "datagrip", name: "DataGrip", appPath: "/Applications/DataGrip.app", command: "datagrip" },
  // 终端（macOS 新版系统 Terminal 在 /System/Applications 下）
  {
    id: "terminal",
    name: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    command: null,
  },
  { id: "iterm2", name: "iTerm", appPath: "/Applications/iTerm.app", command: null },
  { id: "ghostty", name: "Ghostty", appPath: "/Applications/Ghostty.app", command: null },
  { id: "warp", name: "Warp", appPath: "/Applications/Warp.app", command: null },
  // 文件管理器
  {
    id: "finder",
    name: "Finder",
    appPath: "/System/Library/CoreServices/Finder.app",
    command: null,
  },
  // 功能扩展：QSpace / QSpace Pro 是 macOS 第三方文件管理器，默认没有 CLI，复用 open -a app bundle 打开路径。
  {
    id: "qspace",
    name: "QSpace",
    appPath: "/Applications/QSpace.app",
    command: null,
  },
  {
    id: "qspace-pro",
    name: "QSpace Pro",
    appPath: "/Applications/QSpace Pro.app",
    command: null,
  },
];

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ),
  );
}

function getWindowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return uniquePaths([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]);
}

function getWindowsLocalProgramsRoot(): string {
  const systemDrive = process.env.SystemDrive || "C:";
  return pathWin32.join(
    process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`,
    "Programs",
  );
}

function windowsLocalProgramCandidate(...segments: string[]): string {
  return pathWin32.join(getWindowsLocalProgramsRoot(), ...segments);
}

function windowsProgramFilesCandidates(...segments: string[]): string[] {
  return getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, ...segments));
}

function findWindowsJetBrainsExecutableCandidates(
  productDirPrefix: string,
  executableName: string,
): string[] {
  const roots = uniquePaths([
    ...getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, "JetBrains")),
    pathWin32.join(getWindowsLocalProgramsRoot(), "JetBrains"),
  ]);
  const candidates: string[] = [];

  for (const root of roots) {
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.toLowerCase().startsWith(productDirPrefix.toLowerCase()),
        )
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));

      for (const entry of entries) {
        candidates.push(pathWin32.join(root, entry, "bin", executableName));
      }
    } catch {
      // JetBrains products are optional; missing roots are expected.
    }
  }

  return candidates;
}

function createWindowsEditorDef(
  id: string,
  name: string,
  appPathCandidates: string[],
  command: string | null = null,
  windowsCommandAppNames: string[] = [],
): EditorDef {
  const candidates = uniquePaths(appPathCandidates);
  return {
    id,
    name,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    windowsCommandAppNames,
    command,
  };
}

function resolveWindowsCommandPaths(command: string): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

function deriveWindowsAppPathsFromCommand(command: string, appNames: string[]): string[] {
  const candidates: string[] = [];

  for (const commandPath of resolveWindowsCommandPaths(command)) {
    const commandDir = pathWin32.dirname(commandPath);
    for (const appRoot of uniquePaths([commandDir, pathWin32.dirname(commandDir)])) {
      for (const appName of appNames) {
        candidates.push(pathWin32.join(appRoot, appName));
      }
    }
  }

  // Windows PATH 常见的是 bin\code.cmd 这类 shim，真实 exe 才能提供和 mac 一致的应用图标。
  return uniquePaths(candidates).filter((candidate) => existsSync(candidate));
}

const WINDOWS_EDITOR_DEFS: EditorDef[] = [
  // Workspace 顶部“Open in Editor”以前只把真正的 IDE 暴露给 UI，
  // Windows 用户缺少最基础的“在资源管理器里打开”入口，只能回到其它菜单操作。
  // 这里把系统文件管理器也作为 editor 列表的一员，让 macOS Finder / Windows 资源管理器体验对齐。
  { id: "explorer", name: "资源管理器", appPath: WINDOWS_EXPLORER_PATH, command: null },
];

const WINDOWS_ADDITIONAL_EDITOR_DEFS: EditorDef[] = [
  createWindowsEditorDef(
    "vscode",
    "VS Code",
    [
      windowsLocalProgramCandidate("Microsoft VS Code", "Code.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code", "Code.exe"),
    ],
    "code",
    ["Code.exe"],
  ),
  createWindowsEditorDef(
    "vscode-insiders",
    "VS Code Insiders",
    [
      windowsLocalProgramCandidate("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
    ],
    "code-insiders",
    ["Code - Insiders.exe"],
  ),
  createWindowsEditorDef(
    "cursor",
    "Cursor",
    [
      windowsLocalProgramCandidate("Cursor", "Cursor.exe"),
      ...windowsProgramFilesCandidates("Cursor", "Cursor.exe"),
    ],
    "cursor",
    ["Cursor.exe"],
  ),
  createWindowsEditorDef("trae", "Trae", [
    windowsLocalProgramCandidate("Trae", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae CN.exe"),
    ...windowsProgramFilesCandidates("Trae", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae CN.exe"),
  ]),
  createWindowsEditorDef("idea", "IntelliJ IDEA", [
    ...findWindowsJetBrainsExecutableCandidates("IntelliJ IDEA", "idea64.exe"),
  ]),
  createWindowsEditorDef("webstorm", "WebStorm", [
    ...findWindowsJetBrainsExecutableCandidates("WebStorm", "webstorm64.exe"),
  ]),
  createWindowsEditorDef("pycharm", "PyCharm", [
    ...findWindowsJetBrainsExecutableCandidates("PyCharm", "pycharm64.exe"),
  ]),
  createWindowsEditorDef("goland", "GoLand", [
    ...findWindowsJetBrainsExecutableCandidates("GoLand", "goland64.exe"),
  ]),
  createWindowsEditorDef("clion", "CLion", [
    ...findWindowsJetBrainsExecutableCandidates("CLion", "clion64.exe"),
  ]),
];

export function getEditorDefsForCurrentPlatform(): EditorDef[] {
  if (process.platform === "darwin") {
    return [...MAC_EDITOR_DEFS, ...getFileApplicationDefs()];
  }

  if (process.platform === "win32") {
    return [...WINDOWS_EDITOR_DEFS, ...WINDOWS_ADDITIONAL_EDITOR_DEFS, ...getFileApplicationDefs()];
  }

  return getFileApplicationDefs();
}

/** 缓存检测结果，避免重复 IO */
export function resolveEditorDefAppPath(def: EditorDef): string | null {
  const commandAppPaths =
    def.command && def.windowsCommandAppNames?.length
      ? deriveWindowsAppPathsFromCommand(def.command, def.windowsCommandAppNames)
      : [];
  const commandPaths =
    process.platform === "win32" && def.windowsCommandAppNames?.length
      ? []
      : def.command
        ? resolveWindowsCommandPaths(def.command)
        : [];
  const candidatePaths = uniquePaths([
    def.appPath,
    ...(def.appPathCandidates ?? []),
    ...commandAppPaths,
    ...commandPaths,
  ]);
  return candidatePaths.find((candidate) => existsSync(candidate)) ?? null;
}

let cachedEditors: EditorInfo[] | null = null;
let cachedIcnsModule: typeof import("@fiahfy/icns") | null | undefined;

function getIcnsModule(): typeof import("@fiahfy/icns") | null {
  if (cachedIcnsModule !== undefined) {
    return cachedIcnsModule;
  }

  try {
    cachedIcnsModule = require("@fiahfy/icns") as typeof import("@fiahfy/icns");
  } catch (error) {
    // 这里之前在模块顶层直接 require("@fiahfy/icns")。
    // 一旦安装包漏掉它的子依赖（这次是 pngjs），主进程会在文件加载阶段直接崩溃，
    // 连后面的 sips / file icon 降级路径都来不及执行。改成按需懒加载后，缺包时只降级图标解析。
    cachedIcnsModule = null;
    logger.warn("[editors] 加载 @fiahfy/icns 失败，图标解析将回退到 sips", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return cachedIcnsModule;
}

function readAppBundleInfoPlist(appPath: string): AppBundleInfoPlist | null {
  try {
    const infoPlistPath = join(appPath, "Contents", "Info.plist");
    const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlistPath], {
      encoding: "utf8",
      timeout: 3000,
    });
    return JSON.parse(raw) as AppBundleInfoPlist;
  } catch (error) {
    logger.warn("[editors] 读取 Info.plist 失败，图标将回退到 file icon", {
      appPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveAppIconPath(appPath: string): ResolvedAppIconPath {
  const plist = readAppBundleInfoPlist(appPath);
  if (!plist) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-plist",
    };
  }

  // `defaults read` 对不少第三方 .app 读不到 CFBundleIconFile，
  // 会让所有编辑器误回退到 Electron 的通用文件图标；这里改为直接解析 Info.plist。
  const iconNames = [
    plist.CFBundleIconFile,
    ...(plist.CFBundleIconFiles ?? []),
    ...(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
    plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
    plist.CFBundleIconName,
  ].filter(
    (iconName): iconName is string => typeof iconName === "string" && iconName.trim().length > 0,
  );

  if (iconNames.length === 0) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-icon-name",
    };
  }

  for (const iconName of iconNames) {
    const candidateFileNames = iconName.endsWith(".icns")
      ? [iconName]
      : [iconName, `${iconName}.icns`];

    for (const candidateFileName of candidateFileNames) {
      const candidatePath = join(appPath, "Contents", "Resources", candidateFileName);
      // Ghostty 这类应用会同时存在同名资源目录和真正的 .icns 文件。
      // 之前这里只判断 existsSync，先命中目录后就会把目录当成图标文件读，
      // 最终解析失败并退回成发白的系统 file icon。这里要求候选路径必须是文件。
      if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
        return {
          candidateIconNames: iconNames,
          path: candidatePath,
          reason: "resolved",
        };
      }
    }
  }

  return {
    candidateIconNames: iconNames,
    path: null,
    reason: "missing-icon-file",
  };
}

function loadNativeImageFromIcnsViaPackage(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const icnsModule = getIcnsModule();
  if (!icnsModule) {
    return null;
  }

  const { Icns } = icnsModule;

  try {
    const icnsBuffer = readFileSync(icnsPath);
    const icns = Icns.from(icnsBuffer);
    const pngCandidates = icns.images
      .map((image): ParsedIcnsPngCandidate | null => {
        const supportedIconType = Icns.supportedIconTypes.find(
          (iconType) => iconType.osType === image.osType,
        );
        if (!supportedIconType || supportedIconType.format !== "PNG") {
          return null;
        }
        return {
          osType: image.osType,
          size: supportedIconType.size,
          image: image.image,
        };
      })
      .filter((candidate): candidate is ParsedIcnsPngCandidate => candidate !== null)
      .sort((left, right) => right.size - left.size);

    if (pngCandidates.length === 0) {
      logger.info("[editors] @fiahfy/icns 未解析到 PNG icon，图标将回退到 sips", {
        editorId,
        appPath,
        icnsPath,
        availableIconTypes: icns.images.map((image) => image.osType),
      });
      return null;
    }

    for (const candidate of pngCandidates) {
      const icon = nativeImage.createFromBuffer(candidate.image);
      if (!icon.isEmpty()) {
        return icon;
      }
    }

    logger.warn("[editors] @fiahfy/icns 已解析到 PNG icon，但 nativeImage 仍为空", {
      editorId,
      appPath,
      icnsPath,
      pngCandidateTypes: pngCandidates.map((candidate) => `${candidate.osType}:${candidate.size}`),
    });
    return null;
  } catch (error) {
    logger.warn("[editors] @fiahfy/icns 解析失败，图标将回退到 sips", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function loadNativeImageFromIcnsViaSips(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const tempRootDir = join(getZCodeDataRootDir(), "editor-icon");
  mkdirSync(tempRootDir, { recursive: true });
  const tempDirPath = mkdtempSync(join(tempRootDir, "icon-"));
  const tempPngPath = join(tempDirPath, "icon.png");

  try {
    execFileSync("sips", ["-s", "format", "png", icnsPath, "--out", tempPngPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    const pngBuffer = readFileSync(tempPngPath);
    const icon = nativeImage.createFromBuffer(pngBuffer);
    if (icon.isEmpty()) {
      logger.warn("[editors] sips 已输出 PNG，但 nativeImage 仍为空", {
        editorId,
        appPath,
        icnsPath,
        tempPngPath,
      });
      return null;
    }
    return icon;
  } catch (error) {
    logger.warn("[editors] .icns 转 PNG 失败，图标将回退到 file icon", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    try {
      rmSync(tempDirPath, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响图标加载
    }
  }
}

function loadNativeImageFromIcns(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  // Electron 的 nativeImage 不适合直接读取 .icns，
  // 这里优先用 npm 包解析出 PNG icon，减少每个图标都起系统子进程的成本；
  // 只有遇到老格式或包解析不到的 case，才回退到 macOS 的 sips。
  return (
    loadNativeImageFromIcnsViaPackage(editorId, appPath, icnsPath) ??
    loadNativeImageFromIcnsViaSips(editorId, appPath, icnsPath)
  );
}

/** toBitmap 为 BGRA，每 4 字节最后一位是 alpha。 */
function isFullyTransparent(icon: Electron.NativeImage): boolean {
  const bitmap = icon.toBitmap();
  for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] !== 0) return false;
  return true;
}

const cachedDarwinAppIcons = new Map<string, Promise<string | null>>();

/**
 * 从 .app bundle 的 Info.plist 读取多个可能的 icon 字段，
 * 然后把 .icns 转成 PNG，再生成可用于菜单的真实图标。
 * 解析不到或只有透明占位时，用 NSWorkspace 读取（含 Assets.car），最后才用 app.getFileIcon。
 */
export function getAppIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") return getFileIconDataUrl(editorId, appPath);
  // 文件应用菜单每次查询都会为每个候选应用取图标，NSWorkspace 回退要起 osascript 子进程，
  // 所以按 bundle 路径缓存 Promise：并发查询共享同一次解析，成功结果在应用生命周期内复用；
  // 拿不到图标（null）或抛错时移除，下次查询重试。
  let pending = cachedDarwinAppIcons.get(appPath);
  if (!pending) {
    pending = resolveDarwinAppIconDataUrl(editorId, appPath);
    cachedDarwinAppIcons.set(appPath, pending);
    const evict = () => {
      if (cachedDarwinAppIcons.get(appPath) === pending) cachedDarwinAppIcons.delete(appPath);
    };
    void pending.then((iconDataUrl) => {
      if (!iconDataUrl) evict();
    }, evict);
  }
  return pending;
}

function resolveDarwinAppIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  // Step 1: 尝试从 .icns 文件加载真实 app 图标
  const resolvedIcon = resolveAppIconPath(appPath);
  if (resolvedIcon.path) {
    const icon = loadNativeImageFromIcns(editorId, appPath, resolvedIcon.path);
    if (icon && !icon.isEmpty()) {
      // 缩放到合适大小（32x32 用于菜单显示）
      const resized = icon.resize({ width: 32, height: 32 });
      // 图书等系统应用的 AppIcon.icns 只是全透明占位，真图标只在 Assets.car 里。
      // 以前只判断 isEmpty，会把透明 PNG 当成功返回，菜单 <img> 加载成功、通用兜底也不显示，
      // 结果是空白图标位。全透明时视为没有 .icns，交给下面的 NSWorkspace。
      if (!isFullyTransparent(resized))
        return Promise.resolve(`data:image/png;base64,${resized.toPNG().toString("base64")}`);
      logger.info("[editors] .icns 图标全透明，图标将回退到 NSWorkspace", {
        editorId,
        appPath,
        icnsPath: resolvedIcon.path,
      });
    }
  } else {
    logger.info("[editors] 未解析到真实 app 图标，图标将回退到 NSWorkspace", {
      editorId,
      appPath,
      reason: resolvedIcon.reason,
      candidateIconNames: resolvedIcon.candidateIconNames,
    });
  }

  // Step 2: NSWorkspace 能读 Assets.car；Electron 的 app.getFileIcon 对这类 bundle
  // 实测只返回系统通用占位图（图书），所以只在 NSWorkspace 失败时才用它。
  return getWorkspaceIconDataUrl(editorId, appPath).then(
    (iconDataUrl) => iconDataUrl ?? getFileIconDataUrl(editorId, appPath),
  );
}

/** 在 32x32 位图上绘制 NSWorkspace 图标，输出 PNG base64。 */
const MAC_WORKSPACE_ICON_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var size = 32;
  var icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}`;

async function getWorkspaceIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_WORKSPACE_ICON_SCRIPT, appPath],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const icon = nativeImage.createFromBuffer(Buffer.from(stdout.trim(), "base64"));
    if (!icon.isEmpty() && !isFullyTransparent(icon))
      return `data:image/png;base64,${icon.toPNG().toString("base64")}`;
    logger.warn("[editors] NSWorkspace 图标为空，图标将回退到 file icon", { editorId, appPath });
  } catch (error) {
    logger.warn("[editors] NSWorkspace 获取图标失败，图标将回退到 file icon", {
      editorId,
      appPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

function getFileIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  return app
    .getFileIcon(appPath, { size: "normal" })
    .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
    .catch((error) => {
      logger.warn("[editors] 获取 file icon 失败", {
        editorId,
        appPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
}

/**
 * 检测系统中已安装的编辑器/终端，返回带图标的列表。
 * 结果会被缓存（应用生命周期内不变）。
 */
async function getBaseInstalledEditors(): Promise<EditorInfo[]> {
  if (cachedEditors) {
    return cachedEditors;
  }

  const installed = getEditorDefsForCurrentPlatform()
    .filter((def) => !("fileExtensions" in def))
    .map((def) => {
      const appPath = resolveEditorDefAppPath(def);
      return appPath ? { def, appPath } : null;
    })
    .filter((entry): entry is { def: EditorDef; appPath: string } => entry !== null);

  const results = await Promise.all(
    installed.map(async ({ def, appPath }) => {
      const iconDataUrl = await getAppIconDataUrl(def.id, appPath);
      if (!iconDataUrl) {
        return null;
      }
      return { id: def.id, name: def.name, iconDataUrl };
    }),
  );

  cachedEditors = results.filter((r): r is EditorInfo => r !== null);
  return cachedEditors;
}

const cachedFileApps = new Map<string, Promise<EditorInfo | null>>();

/** 可选文件路径只扩展文件菜单，工作区编辑器列表保持原有语义。 */
export async function getInstalledEditors(filePath?: string): Promise<EditorInfo[]> {
  const base = await getBaseInstalledEditors();
  const matching = getFileApplicationDefs().filter((def) => matchesFileApplication(def, filePath));
  const applications = await Promise.all(
    matching.map((def) => {
      let pending = cachedFileApps.get(def.id);
      if (!pending) {
        pending = (async () => {
          const appPath = await resolveFileApplicationPath(def);
          if (!appPath) return null;
          const iconDataUrl = await getAppIconDataUrl(def.id, appPath);
          return iconDataUrl ? { id: def.id, name: def.name, iconDataUrl } : null;
        })();
        cachedFileApps.set(def.id, pending);
        // 未安装或图标暂不可用不能永久缓存；并发查询仍共享同一次探测。
        const evict = () => {
          if (cachedFileApps.get(def.id) === pending) cachedFileApps.delete(def.id);
        };
        void pending.then((editor) => {
          if (!editor) evict();
        }, evict);
      }
      return pending;
    }),
  );
  return [...base, ...applications.filter((entry): entry is EditorInfo => entry !== null)];
}
