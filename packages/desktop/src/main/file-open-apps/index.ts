import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize, win32 } from "node:path";
import type { FileApplicationInfo, FileApplicationTarget } from "@zcode/shared";
import type {
  FileApplicationNativeAdapter,
  FileOpenAppsContract,
  NativeFileApplication,
} from "./contract.js";
import {
  isExecutableFilePath,
  isScriptRunnerApplication,
  type ConfirmExecutableFileOpen,
} from "./executableOpenGuard.js";
import { createNativeApplicationAdapter } from "./native.js";

export {
  createExecutableFileOpenConfirmer,
  isExecutableFilePath,
  type ConfirmExecutableFileOpen,
} from "./executableOpenGuard.js";

interface Options {
  /** 启动会执行文件的组合（可执行类后缀或脚本类应用）前的用户确认。 */
  confirmExecutableOpen: ConfirmExecutableFileOpen;
  adapter?: FileApplicationNativeAdapter;
  getIcon?: (id: string, path: string) => Promise<string | null>;
  logger?: { warn: (...args: unknown[]) => void };
}

const applicationId = (app: NativeFileApplication) =>
  `file-app:${createHash("sha256").update(normalizeApplicationKey(app.key)).digest("hex")}`;

function normalizeApplicationKey(key: string): string {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(key) ? win32.normalize(key).toLowerCase() : normalize(key);
}

function applicationIdentity(app: NativeFileApplication): string {
  return app.identity?.trim() || `path:${normalizeApplicationKey(app.key)}`;
}

function installationRank(key: string): number {
  const path = key.replaceAll("\\", "/").toLowerCase();
  if (
    /^\/(?:applications|system\/applications|system\/library\/coreservices)\//.test(path) ||
    /^[a-z]:\/program files(?: \(x86\))?\//.test(path) ||
    /^\/usr\/(?:local\/)?share\/applications\//.test(path)
  )
    return 0;
  if (
    /^\/users\/[^/]+\/applications\//.test(path) ||
    path.includes("/appdata/local/programs/") ||
    path.includes("/.local/share/applications/")
  )
    return 1;
  return 2;
}

function preferApplication(left: NativeFileApplication, right: NativeFileApplication): number {
  return (
    Number(right.isDefault) - Number(left.isDefault) ||
    installationRank(left.key) - installationRank(right.key) ||
    (right.version ?? "").localeCompare(left.version ?? "", "en", { numeric: true }) ||
    normalizeApplicationKey(left.key).localeCompare(normalizeApplicationKey(right.key), "en")
  );
}

function deduplicateApplications(applications: NativeFileApplication[]): NativeFileApplication[] {
  const unique = new Map<string, NativeFileApplication>();
  for (const app of applications) {
    if (
      !app ||
      typeof app.key !== "string" ||
      !app.key ||
      typeof app.name !== "string" ||
      !app.name.trim()
    )
      continue;
    const identity = applicationIdentity(app);
    const previous = unique.get(identity);
    // 同一个 bundle 可能由多个浏览器内核目录注册；按路径去重会显示两条相同 Chromium。
    // 每次枚举使用同一选择顺序，确保菜单 id 对应打开时再次选中的真实实例。
    if (!previous || preferApplication(app, previous) < 0) unique.set(identity, app);
  }
  const names = new Map<string, number>();
  for (const app of unique.values()) {
    const name = app.name.trim().toLocaleLowerCase();
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return [...unique.values()]
    .map((app) =>
      (names.get(app.name.trim().toLocaleLowerCase()) ?? 0) > 1
        ? { ...app, name: `${app.name} (${applicationIdentity(app).replace(/^[^:]+:/, "")})` }
        : app,
    )
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

export function createFileApplicationService(options: Options): FileOpenAppsContract {
  const adapter = options.adapter ?? createNativeApplicationAdapter();
  async function validTarget(target: FileApplicationTarget): Promise<boolean> {
    // 同名远端路径即便恰好在本机存在，也不属于本机文件。IPC 入口不信任 renderer 的 pathKind。
    if (
      !target ||
      typeof target.path !== "string" ||
      target.path.includes("\0") ||
      target.pathKind !== "file" ||
      target.remoteTarget ||
      target.workspaceIdentity?.trim() ||
      !(process.platform === "win32" ? win32.isAbsolute(target.path) : isAbsolute(target.path))
    )
      return false;
    return (await stat(target.path).catch(() => null))?.isFile() === true;
  }
  async function query(
    target: FileApplicationTarget,
    includeIcons = true,
  ): Promise<NativeFileApplication[]> {
    return deduplicateApplications(await adapter.query(target.path, { includeIcons }));
  }
  return {
    async getFileApplications(target) {
      try {
        if (!(await validTarget(target))) return [];
        const applications = await query(target);
        return Promise.all(
          applications.map(async (application): Promise<FileApplicationInfo> => {
            const id = applicationId(application);
            const iconDataUrl =
              application.iconDataUrl !== undefined
                ? application.iconDataUrl
                : application.iconPath
                  ? await options.getIcon?.(id, application.iconPath).catch(() => null)
                  : null;
            return {
              id,
              name: application.name,
              isDefault: application.isDefault === true,
              ...(iconDataUrl ? { iconDataUrl } : {}),
            };
          }),
        );
      } catch (error) {
        options.logger?.warn("[file-apps] 查询系统关联失败", { error: String(error) });
        return [];
      }
    },
    async openFileWithApplication(id, target) {
      try {
        if (typeof id !== "string" || !(await validTarget(target)))
          return { success: false, error: "unsupported_file_target" };
        // 打开只需重查身份；不要把图标解码的耗时和失败引入实际启动链路。
        const application = (await query(target, false)).find((item) => applicationId(item) === id);
        if (!application) return { success: false, error: "application_not_available" };
        // 「在 终端 中打开」会执行文件内容，与后缀无关；可执行类后缀交给任何应用都需确认。取消不是失败。
        if (
          (isScriptRunnerApplication(application.identity) ||
            (await isExecutableFilePath(target.path))) &&
          !(await options.confirmExecutableOpen(target.path))
        )
          return { success: true, cancelled: true };
        await adapter.open(application, target.path);
        return { success: true };
      } catch (error) {
        options.logger?.warn("[file-apps] 系统应用打开失败", { error: String(error) });
        return { success: false, error: "application_open_failed" };
      }
    },
  };
}
