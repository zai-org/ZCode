import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gitBashPathToWindowsPath } from "@zcode/contracts";
import { NodeExecutionAdapterLifecycle } from "./node-execution-adapter-lifecycle.js";
import type { NodeExecutionAdapterOptions } from "./execution-adapter-types.js";
import type {
  AdbExecutableRequest,
  AdbExecutableResolution,
  ExecutionPort,
} from "@zcode/contracts";

export class NodeExecutionAdapter extends NodeExecutionAdapterLifecycle implements ExecutionPort {
  async resolveAdbExecutable(request: AdbExecutableRequest): Promise<AdbExecutableResolution> {
    const windows = this.platform === "win32";
    const paths = windows ? path.win32 : path.posix;
    const env = (name: string) =>
      this.processEnv[
        Object.keys(this.processEnv).find((key) =>
          windows ? key.toUpperCase() === name : key === name,
        ) ?? name
      ];
    const normalize = (value: string) => (windows ? gitBashPathToWindowsPath(value) : value);
    const workspace = paths.resolve(normalize(request.workspaceRoot));
    const canonicalWorkspace = await realpath(workspace);
    const inside = (root: string, candidate: string) => {
      const relative = paths.relative(root, candidate);
      return (
        relative === "" ||
        (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`))
      );
    };
    const inWorkspace = (candidate: string) =>
      inside(workspace, candidate) || inside(canonicalWorkspace, candidate);
    const check = async (candidate: string): Promise<AdbExecutableResolution> => {
      if (inWorkspace(candidate)) return { status: "workspace" };
      try {
        const canonical = await realpath(candidate);
        if (inWorkspace(canonical)) return { status: "workspace" };
        if (!(await stat(canonical)).isFile()) return { status: "missing" };
        await access(canonical, windows ? constants.F_OK : constants.X_OK);
        return { status: "resolved", path: canonical };
      } catch (error) {
        if (
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          return { status: "missing" };
        throw error;
      }
    };
    const file = normalize(request.file);
    const names =
      windows && !paths.extname(file)
        ? [file + ".exe", file + ".com", file + ".cmd", file + ".bat"]
        : [file];
    if (paths.isAbsolute(file) || paths.dirname(file) !== "." || /[/\\]/.test(file)) {
      for (const name of names) {
        const result = await check(paths.resolve(normalize(request.cwd), name));
        if (result.status !== "missing") return result;
      }
      return { status: "missing" };
    }
    const home = env(windows ? "USERPROFILE" : "HOME") || homedir();
    const sdkRoots = [
      env("ANDROID_HOME"),
      env("ANDROID_SDK_ROOT"),
      ...(windows
        ? [
            paths.join(
              env("LOCALAPPDATA") || paths.join(home, "AppData", "Local"),
              "Android",
              "Sdk",
            ),
          ]
        : [paths.join(home, "Library", "Android", "sdk"), paths.join(home, "Android", "Sdk")]),
    ];
    const directories = [
      ...sdkRoots
        .filter((root): root is string => !!root)
        .map((root) => paths.join(normalize(root), "platform-tools")),
      ...(env("PATH") ?? "").split(paths.delimiter).map((entry) => entry.replace(/^"(.*)"$/, "$1")),
    ];
    let workspaceCandidate = false;
    for (const entry of directories) {
      const directory = normalize(entry);
      // 不用 where/which，也不把空项、相对 PATH 或项目目录交给 Shell 重新查找。
      if (!paths.isAbsolute(directory)) continue;
      for (const name of names) {
        const result = await check(paths.join(directory, name));
        if (result.status === "resolved") return result;
        workspaceCandidate ||= result.status === "workspace";
      }
    }
    return { status: workspaceCandidate ? "workspace" : "missing" };
  }
}

export function createNodeExecutionAdapter(
  options: NodeExecutionAdapterOptions = {},
): ExecutionPort {
  return new NodeExecutionAdapter(options);
}
