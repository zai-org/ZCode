import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inside } from "../lib/path.js";
import { ok, run } from "../lib/run.js";

type Found = {
  projects: string[];
  workspaces: string[];
  schemes: string[];
  bundleIds: string[];
};

const IDS = [
  "A10000000000000000000001",
  "A10000000000000000000002",
  "A10000000000000000000003",
  "A10000000000000000000004",
  "A10000000000000000000005",
  "A10000000000000000000006",
  "A10000000000000000000007",
  "A10000000000000000000008",
  "A10000000000000000000009",
  "A1000000000000000000000A",
  "A1000000000000000000000B",
  "A1000000000000000000000C",
  "A1000000000000000000000D",
  "A1000000000000000000000E",
  "A1000000000000000000000F",
  "A10000000000000000000010",
  "A10000000000000000000011",
  "A10000000000000000000012",
  "A10000000000000000000013",
  "A10000000000000000000014",
  "A10000000000000000000015",
  "A10000000000000000000016",
] as const;

export async function discover(dir = process.cwd()): Promise<Found> {
  const projects: string[] = [];
  const workspaces: string[] = [];
  await walk(dir, 3, (file) => {
    if (file.endsWith(".xcodeproj")) projects.push(path.relative(dir, file));
    if (file.endsWith(".xcworkspace")) workspaces.push(path.relative(dir, file));
  });
  // xcodebuild -list 也会执行 Package.swift；概览只能读取已有 scheme，不能为补齐元数据执行项目代码。
  const saved = await Promise.all(
    [...workspaces, ...projects].map((file) => savedSchemes(path.join(dir, file))),
  );
  const schemes = [...new Set(saved.flat())].sort();
  const ids = new Set<string>();
  for (const item of projects) {
    const file = path.join(dir, item, "project.pbxproj");
    const text = await readFile(file, "utf8").catch(() => "");
    for (const hit of text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g))
      ids.add(hit[1]?.replaceAll('"', "").trim() ?? "");
  }
  return { projects, workspaces, schemes, bundleIds: [...ids].filter(Boolean) };
}

async function savedSchemes(container: string): Promise<string[]> {
  const userData = path.join(container, "xcuserdata");
  const users = await readdir(userData, { withFileTypes: true }).catch(() => []);
  const directories = [
    path.join(container, "xcshareddata", "xcschemes"),
    ...users
      .filter((item) => item.isDirectory() && item.name.endsWith(".xcuserdatad"))
      .map((item) => path.join(userData, item.name, "xcschemes")),
  ];
  return (
    await Promise.all(
      directories.map(async (dir) => {
        const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
        return files
          .filter((item) => item.isFile() && item.name.endsWith(".xcscheme"))
          .map((item) => path.basename(item.name, ".xcscheme"));
      }),
    )
  ).flat();
}

async function walk(dir: string, depth: number, cb: (file: string) => void): Promise<void> {
  if (depth < 0) return;
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    items
      .filter(
        (item) =>
          !item.name.startsWith(".") && item.name !== "node_modules" && item.name !== "DerivedData",
      )
      .map(async (item) => {
        const file = path.join(dir, item.name);
        if (
          item.isDirectory() &&
          (item.name.endsWith(".xcodeproj") || item.name.endsWith(".xcworkspace"))
        ) {
          cb(file);
          return;
        }
        if (item.isDirectory()) await walk(file, depth - 1, cb);
      }),
  );
}

export async function create(input: {
  name: string;
  bundleId?: string;
  dir?: string;
  deployment?: string;
  overwrite?: boolean;
}) {
  const cwd = process.cwd();
  const name = clean(input.name);
  const root = inside(cwd, input.dir || name);
  const bundle = input.bundleId ? bundleId(input.bundleId) : `com.example.${slug(name)}`;
  const target = deployment(input.deployment || "17.0");
  const src = path.join(root, name);
  const proj = path.join(root, `${name}.xcodeproj`);
  const files = [
    path.join(src, `${name}App.swift`),
    path.join(src, "ContentView.swift"),
    path.join(proj, "project.pbxproj"),
  ];
  if (!input.overwrite) {
    const hits = await present(files);
    if (hits.length) {
      throw new Error(
        `Refusing to overwrite existing iOS app files: ${hits.map((file) => path.relative(cwd, file)).join(", ")}`,
      );
    }
  }
  await mkdir(src, { recursive: true });
  await mkdir(proj, { recursive: true });
  await writeFile(files[0], app(name), "utf8");
  await writeFile(files[1], view(), "utf8");
  await writeFile(files[2], pbx(name, bundle, target), "utf8");
  return {
    project: path.relative(cwd, proj),
    scheme: name,
    bundle,
    files: files.slice(0, 2).map((file) => path.relative(cwd, file)),
  };
}

export async function bundle(
  flag: "-project" | "-workspace",
  file: string,
  scheme: string,
): Promise<string | undefined> {
  const out = await run(["xcodebuild", flag, file, "-scheme", scheme, "-showBuildSettings"], {
    timeout: 60_000,
  });
  if (!ok(out)) return undefined;
  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("PRODUCT_BUNDLE_IDENTIFIER = "))
    ?.replace("PRODUCT_BUNDLE_IDENTIFIER = ", "");
}

export function source(
  input: { project?: string; workspace?: string; scheme?: string },
  found: Found,
) {
  const workspace = input.workspace ? scoped(input.workspace, ".xcworkspace") : undefined;
  const project = input.project ? scoped(input.project, ".xcodeproj") : undefined;
  if (workspace)
    return { flag: "-workspace" as const, file: workspace, scheme: pick(input, found, workspace) };
  if (project)
    return { flag: "-project" as const, file: project, scheme: pick(input, found, project) };
  const auto = found.workspaces[0]
    ? { flag: "-workspace" as const, file: found.workspaces[0] }
    : found.projects[0]
      ? { flag: "-project" as const, file: found.projects[0] }
      : undefined;
  if (auto) return { ...auto, scheme: pick(input, found, auto.file) };
  throw new Error("No .xcodeproj or .xcworkspace found. Use ios_create_app first.");
}

function pick(input: { scheme?: string }, found: Found, file: string): string | undefined {
  const first = found.workspaces[0] || found.projects[0];
  return (
    input.scheme ||
    (file === first ? found.schemes[0] : undefined) ||
    path.basename(file, path.extname(file))
  );
}

async function present(files: string[]): Promise<string[]> {
  return (
    await Promise.all(
      files.map(async (file) => {
        const hit = await access(file)
          .then(() => true)
          .catch(() => false);
        return hit ? file : undefined;
      }),
    )
  ).filter((file): file is string => file !== undefined);
}

function scoped(raw: string, ext: ".xcodeproj" | ".xcworkspace"): string {
  const file = inside(process.cwd(), raw);
  if (!file.endsWith(ext)) throw new Error(`Expected ${ext} path: ${raw}`);
  return path.relative(process.cwd(), file);
}

function bundleId(value: string): string {
  const parts = value.split(".");
  const good = parts.length > 1 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(part));
  if (!good) throw new Error(`Invalid bundle id: ${value}`);
  return value;
}

function deployment(value: string): string {
  if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(value))
    throw new Error(`Invalid deployment target: ${value}`);
  return value;
}

function slug(value: string): string {
  const out = value
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (/^[0-9]/.test(out)) return `app-${out}`;
  return out || "app";
}

function clean(value: string): string {
  const out = value.replace(/[^A-Za-z0-9_]/g, "");
  if (!out) throw new Error("App name must contain letters or numbers.");
  if (/^[0-9]/.test(out)) return `App${out}`;
  return out;
}

function app(name: string): string {
  return `import SwiftUI

@main
struct ${name}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`;
}

function view(): string {
  return `import SwiftUI

struct ContentView: View {
    @State private var count = 0

    var body: some View {
        VStack(spacing: 20) {
            Text("Hello from iOS")
                .font(.largeTitle)
            Text("Count: \\(count)")
                .font(.title2)
                .accessibilityIdentifier("countLabel")
            Button("Increment") {
                count += 1
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("incrementButton")
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
`;
}

function pbx(name: string, bundle: string, deployment: string): string {
  return `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 56;
  objects = {
    ${IDS[0]} = {isa = PBXBuildFile; fileRef = ${IDS[1]}; };
    ${IDS[2]} = {isa = PBXBuildFile; fileRef = ${IDS[3]}; };
    ${IDS[1]} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}App.swift; sourceTree = "<group>"; };
    ${IDS[3]} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ContentView.swift; sourceTree = "<group>"; };
    ${IDS[4]} = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${name}.app; sourceTree = BUILT_PRODUCTS_DIR; };
    ${IDS[5]} = {
      isa = PBXGroup;
      children = (${IDS[6]}, ${IDS[7]});
      sourceTree = "<group>";
    };
    ${IDS[6]} = {
      isa = PBXGroup;
      children = (${IDS[1]}, ${IDS[3]});
      path = ${name};
      sourceTree = "<group>";
    };
    ${IDS[7]} = {
      isa = PBXGroup;
      children = (${IDS[4]});
      name = Products;
      sourceTree = "<group>";
    };
    ${IDS[8]} = {
      isa = PBXNativeTarget;
      buildConfigurationList = ${IDS[9]};
      buildPhases = (${IDS[10]});
      buildRules = ();
      dependencies = ();
      name = ${name};
      productName = ${name};
      productReference = ${IDS[4]};
      productType = "com.apple.product-type.application";
    };
    ${IDS[10]} = {
      isa = PBXSourcesBuildPhase;
      buildActionMask = 2147483647;
      files = (${IDS[0]}, ${IDS[2]});
      runOnlyForDeploymentPostprocessing = 0;
    };
    ${IDS[11]} = {
      isa = PBXProject;
      attributes = {BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 1500; LastUpgradeCheck = 1500; TargetAttributes = {${IDS[8]} = {CreatedOnToolsVersion = 15.0;};};};
      buildConfigurationList = ${IDS[12]};
      compatibilityVersion = "Xcode 14.0";
      developmentRegion = en;
      hasScannedForEncodings = 0;
      knownRegions = (en, Base);
      mainGroup = ${IDS[5]};
      productRefGroup = ${IDS[7]};
      projectDirPath = "";
      projectRoot = "";
      targets = (${IDS[8]});
    };
    ${IDS[13]} = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; CLANG_WARN_BLOCK_CAPTURE_AUTORELEASING = YES; CLANG_WARN_BOOL_CONVERSION = YES; CLANG_WARN_COMMA = YES; CLANG_WARN_CONSTANT_CONVERSION = YES; CLANG_WARN_DEPRECATED_OBJC_IMPLEMENTATIONS = YES; CLANG_WARN_DIRECT_OBJC_ISA_USAGE = YES_ERROR; CLANG_WARN_DOCUMENTATION_COMMENTS = YES; CLANG_WARN_EMPTY_BODY = YES; CLANG_WARN_ENUM_CONVERSION = YES; CLANG_WARN_INFINITE_RECURSION = YES; CLANG_WARN_INT_CONVERSION = YES; CLANG_WARN_NON_LITERAL_NULL_CONVERSION = YES; CLANG_WARN_OBJC_IMPLICIT_RETAIN_SELF = YES; CLANG_WARN_OBJC_LITERAL_CONVERSION = YES; CLANG_WARN_OBJC_ROOT_CLASS = YES_ERROR; CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES; CLANG_WARN_RANGE_LOOP_ANALYSIS = YES; CLANG_WARN_STRICT_PROTOTYPES = YES; CLANG_WARN_SUSPICIOUS_MOVE = YES; CLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE; CLANG_WARN_UNREACHABLE_CODE = YES; COPY_PHASE_STRIP = NO; DEBUG_INFORMATION_FORMAT = dwarf; ENABLE_STRICT_OBJC_MSGSEND = YES; ENABLE_TESTABILITY = YES; GCC_C_LANGUAGE_STANDARD = gnu17; GCC_DYNAMIC_NO_PIC = NO; GCC_NO_COMMON_BLOCKS = YES; GCC_OPTIMIZATION_LEVEL = 0; GCC_PREPROCESSOR_DEFINITIONS = ("DEBUG=1", "$(inherited)"); GCC_WARN_64_TO_32_BIT_CONVERSION = YES; GCC_WARN_ABOUT_RETURN_TYPE = YES_ERROR; GCC_WARN_UNDECLARED_SELECTOR = YES; GCC_WARN_UNINITIALIZED_AUTOS = YES_AGGRESSIVE; GCC_WARN_UNUSED_FUNCTION = YES; GCC_WARN_UNUSED_VARIABLE = YES; IPHONEOS_DEPLOYMENT_TARGET = ${deployment}; MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE; MTL_FAST_MATH = YES; ONLY_ACTIVE_ARCH = YES; SDKROOT = iphoneos; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; SWIFT_OPTIMIZATION_LEVEL = "-Onone";}; name = Debug; };
    ${IDS[14]} = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; COPY_PHASE_STRIP = NO; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; ENABLE_NS_ASSERTIONS = NO; GCC_C_LANGUAGE_STANDARD = gnu17; IPHONEOS_DEPLOYMENT_TARGET = ${deployment}; MTL_ENABLE_DEBUG_INFO = NO; MTL_FAST_MATH = YES; SDKROOT = iphoneos; SWIFT_COMPILATION_MODE = wholemodule; SWIFT_OPTIMIZATION_LEVEL = "-O"; VALIDATE_PRODUCT = YES;}; name = Release; };
    ${IDS[15]} = {isa = XCBuildConfiguration; buildSettings = {ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; DEVELOPMENT_ASSET_PATHS = ""; DEVELOPMENT_TEAM = ""; ENABLE_PREVIEWS = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundle}; PRODUCT_NAME = "$(TARGET_NAME)"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = NO; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2";}; name = Debug; };
    ${IDS[16]} = {isa = XCBuildConfiguration; buildSettings = {ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; DEVELOPMENT_ASSET_PATHS = ""; DEVELOPMENT_TEAM = ""; ENABLE_PREVIEWS = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundle}; PRODUCT_NAME = "$(TARGET_NAME)"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = NO; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2";}; name = Release; };
    ${IDS[12]} = {isa = XCConfigurationList; buildConfigurations = (${IDS[13]}, ${IDS[14]}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    ${IDS[9]} = {isa = XCConfigurationList; buildConfigurations = (${IDS[15]}, ${IDS[16]}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
  };
  rootObject = ${IDS[11]};
}
`;
}
