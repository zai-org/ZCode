import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function data(...part: string[]): Promise<string> {
  const dir = path.join(
    process.env.ANDROID_PLUGIN_DATA || path.join(os.tmpdir(), "android-emulator-plugin"),
    ...part,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

export function inside(base: string, raw: string): string {
  const out = path.resolve(base, raw);
  if (out === base || out.startsWith(base + path.sep)) return out;
  throw new Error(`Path escapes project root: ${raw}`);
}

export function rel(file: string): string {
  return path.relative(process.cwd(), file) || ".";
}

export async function externalPath(
  candidate: string,
  kind: "directory" | "executable",
): Promise<string | undefined> {
  // 工具查找曾把工作区文件当成系统依赖执行；同时校验字面路径与真实路径，防止链接绕过。
  if (!path.isAbsolute(candidate)) return undefined;
  if (process.platform === "win32" && path.parse(candidate).root.length === 1) return undefined;
  const workspace = process.cwd();
  const within = (base: string, file: string) => {
    const relative = path.relative(base, file);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  if (within(workspace, path.resolve(candidate))) return undefined;
  try {
    const [root, resolved] = await Promise.all([realpath(workspace), realpath(candidate)]);
    if (within(root, resolved)) return undefined;
    const info = await stat(resolved);
    if (kind === "directory") return info.isDirectory() ? resolved : undefined;
    if (!info.isFile()) return undefined;
    await access(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}
