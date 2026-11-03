import {
  PlatformChannels,
  type FileApplicationInfo,
  type FileApplicationTarget,
} from "@zcode/shared";

type Handler = (...args: unknown[]) => unknown;
declare global {
  var __apcFileApplications:
    | {
        calls: Array<{ applicationId: string; target: FileApplicationTarget }>;
        revealCalls: string[];
        locateCalls: Array<{ editorId: string; path: string; pathKind?: string }>;
        restore(): void;
      }
    | undefined;
}

/**
 * 只在隔离 E2E 主进程替换目标文件的 IPC；不启动或安装任何真实外部应用。
 * 安装期间“在文件管理器中打开”（OpenInFileManager 打开目录、OpenInEditor 定位并选中文件）
 * 全部只记录参数，不真的拉起 Finder/资源管理器。
 */
export async function installFileApplicationMenuProbe(
  targetPath: string,
  applications: FileApplicationInfo[],
) {
  await browser.electron.execute(
    (electron, channels, targetPath, applications) => {
      if (globalThis.__apcFileApplications)
        throw new Error("File application probe already installed");
      const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers;
      const query = handlers.get(channels.GetFileApplications);
      const open = handlers.get(channels.OpenFileWithApplication);
      const reveal = handlers.get(channels.OpenInFileManager);
      const locate = handlers.get(channels.OpenInEditor);
      if (!query || !open || !reveal || !locate)
        throw new Error("File application IPC handlers unavailable");
      const probe = {
        calls: [] as Array<{ applicationId: string; target: FileApplicationTarget }>,
        revealCalls: [] as string[],
        locateCalls: [] as Array<{ editorId: string; path: string; pathKind?: string }>,
        restore() {
          handlers.set(channels.GetFileApplications, query);
          handlers.set(channels.OpenFileWithApplication, open);
          handlers.set(channels.OpenInFileManager, reveal);
          handlers.set(channels.OpenInEditor, locate);
          delete globalThis.__apcFileApplications;
        },
      };
      handlers.set(channels.GetFileApplications, (event, target) =>
        (target as FileApplicationTarget)?.path === targetPath
          ? applications
          : query(event, target),
      );
      handlers.set(channels.OpenFileWithApplication, (event, payload) => {
        const request = payload as { applicationId: string; target: FileApplicationTarget };
        if (request?.target?.path !== targetPath) return open(event, payload);
        probe.calls.push(request);
        return { success: true };
      });
      handlers.set(channels.OpenInFileManager, (_event, path) => {
        probe.revealCalls.push(path as string);
        return { success: true };
      });
      handlers.set(channels.OpenInEditor, (_event, payload) => {
        const request = payload as {
          editorId: string;
          path: string;
          options?: { pathKind?: string };
        };
        probe.locateCalls.push({
          editorId: request.editorId,
          path: request.path,
          pathKind: request.options?.pathKind,
        });
        return { success: true };
      });
      globalThis.__apcFileApplications = probe;
    },
    PlatformChannels,
    targetPath,
    applications,
  );
}

export async function readFileApplicationMenuProbe() {
  return browser.electron.execute(() => globalThis.__apcFileApplications?.calls ?? []);
}

export async function readFileManagerRevealProbe() {
  return browser.electron.execute(() => globalThis.__apcFileApplications?.revealCalls ?? []);
}

export async function readFileLocateProbe() {
  return browser.electron.execute(() => globalThis.__apcFileApplications?.locateCalls ?? []);
}

export async function restoreFileApplicationMenuProbe() {
  await browser.electron.execute(() => globalThis.__apcFileApplications?.restore());
}
