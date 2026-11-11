import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { toZhOrEnLocale, type Locale } from "@zcode/shared";

const WORKFLOW_NAME = "Open in ZCode.workflow";
const WORKFLOW_BUNDLE_ID = "dev.zcode.app.finder-open-workflow";
const WORKFLOW_VERSION = "5";
// Finder 服务菜单只内置中英；其它界面语言用英文。
const SERVICES_MENU_LABELS: Record<"zh-CN" | "en-US", string> = {
  "zh-CN": "在ZCode中打开",
  "en-US": "Open in ZCode",
};

const workflowScript = `first=""
for item in "$@"; do
  if [ -d "$item" ]; then
    first="$item"
    break
  fi
done

if [ -n "$first" ]; then
  encoded=$(/usr/bin/osascript -l JavaScript -e 'function run(argv) { return encodeURIComponent(argv[0]); }' "$first")
  /usr/bin/open "zcode://workspace/open?path=\${encoded}"
fi
`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getServicesMenuLabel(locale: Locale): string {
  return SERVICES_MENU_LABELS[toZhOrEnLocale(locale)];
}

function buildInfoPlist(locale: Locale): string {
  const servicesMenuName = escapeXml(getServicesMenuLabel(locale));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>English</string>
  <key>CFBundleExecutable</key>
  <string></string>
  <key>CFBundleIdentifier</key>
  <string>${WORKFLOW_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${servicesMenuName}</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>${WORKFLOW_VERSION}</string>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>${servicesMenuName}</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict>
        <key>NSApplicationIdentifier</key>
        <string>com.apple.finder</string>
      </dict>
      <key>NSSendFileTypes</key>
      <array>
        <string>public.folder</string>
        <string>public.directory</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
}

function buildDocumentWorkflow(): string {
  const escapedScript = escapeXml(workflowScript);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>COMMAND_STRING</key>
          <string>${escapedScript}</string>
          <key>inputMethod</key>
          <integer>1</integer>
          <key>shell</key>
          <string>/bin/zsh</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <true/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.path</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict>
          <key>CheckedForUserDefaultShell</key>
          <dict/>
          <key>COMMAND_STRING</key>
          <dict/>
          <key>inputMethod</key>
          <dict/>
          <key>shell</key>
          <dict/>
          <key>source</key>
          <dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <false/>
        <key>CanShowWhenRun</key>
        <true/>
        <key>Category</key>
        <array>
          <string>AMCategoryUtilities</string>
        </array>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>Class Name</key>
        <string>RunShellScriptAction</string>
        <key>InputUUID</key>
        <string>F477A40F-2E89-4A51-8CC1-477A68B23B20</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string>
          <string>Script</string>
        </array>
        <key>OutputUUID</key>
        <string>6F83E6AB-25DA-4FE4-8F38-F3FA66EB5821</string>
        <key>UnlocalizedApplications</key>
        <array>
          <string>Automator</string>
        </array>
        <key>UUID</key>
        <string>85496E72-E631-48B7-A8AB-4E7841D622E6</string>
      </dict>
      <key>isViewVisible</key>
      <true/>
    </dict>
  </array>
  <key>AMApplicationBuild</key>
  <string>521</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceApplicationBundleID</key>
    <string>com.apple.finder</string>
    <key>serviceApplicationPath</key>
    <string>/System/Library/CoreServices/Finder.app</string>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject.folder</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <false/>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
`;
}

function writeFileIfChanged(path: string, content: string): boolean {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === content) {
      return false;
    }
  }

  writeFileSync(path, content, "utf8");
  return true;
}

function refreshMacServicesIndex(): void {
  const pbsPath = "/System/Library/CoreServices/pbs";
  if (!existsSync(pbsPath)) {
    return;
  }

  const child = spawn(pbsPath, ["-update"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

export function installFinderOpenFolderWorkflow(options: {
  platform: NodeJS.Platform;
  locale: Locale;
  homeDir?: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  refreshServicesIndex?: () => void;
}): void {
  if (options.platform !== "darwin") {
    return;
  }

  const servicesDir = join(options.homeDir ?? homedir(), "Library", "Services");
  const workflowDir = join(servicesDir, WORKFLOW_NAME);
  const contentsDir = join(workflowDir, "Contents");
  const resourcesDir = join(contentsDir, "Resources");
  const infoPlistPath = join(contentsDir, "Info.plist");
  const documentWorkflowPath = join(contentsDir, "document.wflow");
  const resourcesDocumentWorkflowPath = join(resourcesDir, "document.wflow");

  try {
    mkdirSync(resourcesDir, { recursive: true });

    const infoChanged = writeFileIfChanged(infoPlistPath, buildInfoPlist(options.locale));
    const workflowContent = buildDocumentWorkflow();
    const workflowChanged = writeFileIfChanged(documentWorkflowPath, workflowContent);
    // 用户 Automator workflow 通常读取 Contents/document.wflow；
    // 系统内置 workflow 也存在 Resources/document.wflow 形态。两个位置都写同一份，
    // 避免 Finder 能显示服务但运行时报 “not configured correctly”。
    const resourcesWorkflowChanged = writeFileIfChanged(
      resourcesDocumentWorkflowPath,
      workflowContent,
    );

    if (infoChanged || workflowChanged || resourcesWorkflowChanged) {
      // Finder 系统服务展示名来自 workflow 的 Info.plist。
      // 语言切换后必须重写 plist 并刷新 Services 索引，否则系统菜单会继续显示旧语言。
      (options.refreshServicesIndex ?? refreshMacServicesIndex)();
      options.logger.info("[finder-open-folder] Finder 服务已安装或更新", {
        locale: options.locale,
        workflowPath: workflowDir,
      });
    }
  } catch (error) {
    options.logger.warn("[finder-open-folder] Finder 服务安装失败", {
      error: error instanceof Error ? error.message : String(error),
      workflowPath: workflowDir,
    });
  }
}
