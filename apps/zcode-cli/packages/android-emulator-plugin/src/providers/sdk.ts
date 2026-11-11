import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brief, ok, run } from "../lib/run.js";
import { externalPath } from "../lib/path.js";
import { javaMajorVersion } from "./config.js";

const TOOL_PATHS: Record<string, string[]> = {
  adb: ["platform-tools/adb"],
  emulator: ["emulator/emulator"],
  sdkmanager: [
    "cmdline-tools/latest/bin/sdkmanager",
    "cmdline-tools/bin/sdkmanager",
    "tools/bin/sdkmanager",
  ],
  avdmanager: [
    "cmdline-tools/latest/bin/avdmanager",
    "cmdline-tools/bin/avdmanager",
    "tools/bin/avdmanager",
  ],
  apkanalyzer: ["cmdline-tools/latest/bin/apkanalyzer", "cmdline-tools/bin/apkanalyzer"],
};
const JAVA_TOOLS = new Set(["sdkmanager", "avdmanager", "apkanalyzer", "gradle"]);

type ToolCheck = {
  name: string;
  path?: string;
  ok: boolean;
  detail: string;
};

function sdkRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = [env.ANDROID_PLUGIN_SDK_PATH, env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (item): item is string => Boolean(item && item.trim()),
  );
  return unique([
    ...configured,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    ...windowsSdkRoots(env),
    "/opt/android-sdk",
    "/usr/local/share/android-sdk",
    "/opt/homebrew/share/android-commandlinetools",
  ]);
}

export async function sdkRoot(): Promise<string | undefined> {
  for (const item of sdkRoots()) {
    const root = await externalPath(item, "directory");
    if (root) return root;
  }
  return undefined;
}

export async function findTool(name: string): Promise<string | undefined> {
  if (path.basename(name) !== name) return undefined;
  // SDK 的 Java 脚本缺少 JAVA_HOME 时也会裸跑 java；不能只修复预检自身的 Java 调用。
  if (JAVA_TOOLS.has(name) && !(await javaHome())) return undefined;
  const rels = TOOL_PATHS[name] ?? [];
  for (const item of sdkRoots()) {
    const root = await externalPath(item, "directory");
    if (!root) continue;
    for (const rel of rels) {
      for (const candidate of executableCandidates(path.join(root, rel))) {
        const found = await externalPath(candidate, "executable");
        if (found) return found;
      }
    }
  }
  // where 默认先搜当前目录，which 也可被 PATH 中的工作区劫持；查找过程不再启动子进程。
  for (const root of await pathDirectories()) {
    for (const candidate of executableCandidates(path.join(root, name))) {
      const found = await externalPath(candidate, "executable");
      if (found) return found;
    }
  }
  return undefined;
}

export async function requireTool(name: string): Promise<string> {
  const found = await findTool(name);
  if (found) return found;
  throw new Error(`Missing Android tool: ${name}. Run android_preflight for setup details.`);
}

export async function checkTool(
  name: string,
  versionArgs: string[] = ["--version"],
): Promise<ToolCheck> {
  const found = await findTool(name);
  if (!found) {
    return {
      name,
      ok: false,
      detail: "not found",
    };
  }
  const out = await run([found, ...versionArgs], { timeout: 10_000, env: await androidEnv() });
  return {
    name,
    path: found,
    ok: ok(out),
    detail: ok(out) ? brief(out, 1000) || found : brief(out, 1000),
  };
}

export async function androidEnv(): Promise<Record<string, string | undefined>> {
  const root = await sdkRoot();
  const java = await javaHome();
  const paths = [
    java ? path.join(java, "bin") : undefined,
    root ? path.join(root, "platform-tools") : undefined,
    root ? path.join(root, "emulator") : undefined,
    root ? path.join(root, "cmdline-tools", "latest", "bin") : undefined,
    root ? path.join(root, "cmdline-tools", "bin") : undefined,
    root ? path.join(root, "tools", "bin") : undefined,
    ...(await pathDirectories()),
  ].filter((item): item is string => Boolean(item));
  const safePaths = await Promise.all(paths.map((item) => externalPath(item, "directory")));
  return {
    JAVA_HOME: java,
    ANDROID_HOME: root,
    ANDROID_SDK_ROOT: root,
    PATH: unique(safePaths.filter((item): item is string => Boolean(item))).join(path.delimiter),
  };
}

export async function javaHome(): Promise<string | undefined> {
  const version = javaMajorVersion();
  const configured = process.env.JAVA_HOME?.trim();
  const configuredHome = configured ? await validJavaHome(configured) : undefined;
  if (configuredHome) return configuredHome;

  if (process.platform === "darwin") {
    const home = await run(["/usr/libexec/java_home", "-v", version], { timeout: 5000 });
    if (ok(home)) {
      const value = home.stdout.trim();
      const valid = value ? await validJavaHome(value) : undefined;
      if (valid) return valid;
    }
  }

  for (const candidate of await javaHomes(version)) {
    const valid = await validJavaHome(candidate);
    if (valid) return valid;
  }
  return undefined;
}

async function validJavaHome(candidate: string): Promise<string | undefined> {
  const root = await externalPath(candidate, "directory");
  if (!root || !(await externalPath(path.join(root, "bin", javaBin()), "executable")))
    return undefined;
  return root;
}

async function pathDirectories(): Promise<string[]> {
  const paths = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((item) =>
      process.platform === "win32" && item.startsWith('"') && item.endsWith('"')
        ? item.slice(1, -1)
        : item,
    );
  const checked = await Promise.all(paths.map((item) => externalPath(item, "directory")));
  return unique(checked.filter((item): item is string => Boolean(item)));
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!path.isAbsolute(item)) continue;
    const resolved = path.normalize(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function executableCandidates(base: string): string[] {
  if (process.platform !== "win32") return [base];
  const ext = path.extname(base);
  if (ext) return [base];
  return [".exe", ".bat", ".cmd", ""].map((suffix) => `${base}${suffix}`);
}

function javaBin(): string {
  return process.platform === "win32" ? "java.exe" : "java";
}

function windowsSdkRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"),
  ].filter((item): item is string => Boolean(item));
}

async function javaHomes(version: string): Promise<string[]> {
  const fixed = [
    `/opt/homebrew/opt/openjdk@${version}/libexec/openjdk.jdk/Contents/Home`,
    `/Library/Java/JavaVirtualMachines/openjdk-${version}.jdk/Contents/Home`,
    path.join(process.env.ProgramFiles || "", "Eclipse Adoptium", `jdk-${version}`),
    path.join(process.env.ProgramFiles || "", "Java", `jdk-${version}`),
  ].filter(Boolean);
  if (process.platform !== "win32") return fixed;
  const pattern = new RegExp(`^jdk-${escapeRegex(version)}`, "i");
  return unique([
    ...fixed,
    ...(await childDirs(path.join(process.env.ProgramFiles || "", "Eclipse Adoptium"), pattern)),
    ...(await childDirs(path.join(process.env.ProgramFiles || "", "Java"), pattern)),
  ]);
}

async function childDirs(root: string, pattern: RegExp): Promise<string[]> {
  if (!root) return [];
  const items = await readdir(root, { withFileTypes: true }).catch(() => []);
  return items
    .filter((item) => item.isDirectory() && pattern.test(item.name))
    .map((item) => path.join(root, item.name));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
