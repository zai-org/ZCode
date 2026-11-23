import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * 解析 Playwright 手机 Web 用例可用的本机 Chromium 内核浏览器。
 *
 * 修复原因：手机 Web 用例默认 `channel: "chrome"`，Playwright 只在当前用户
 * LOCALAPPDATA 与 Program Files 下找 Chrome。Windows CI runner 以 LocalSystem 运行，
 * 没有安装 Chrome，用例直接报 "Chromium distribution 'chrome' is not found"。
 * Windows 自带 Edge 与 Chrome 同为 Chromium 内核，可作为同等的手机 Web 宿主；
 * 只在 Windows 且未显式配置时回退，macOS/Linux 保持原有 Chrome channel。
 */
export function resolveWindowsE2EMobileBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(
    (root): root is string => Boolean(root?.trim()),
  );
  const candidates = [
    ...roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
    ...roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 手机 Web 用例 `chromium.launch` 的浏览器来源与子进程环境。
 *
 * 修复原因：wdio 把 USERPROFILE 改成隔离 HOME；Windows 版 Chrome 继承后启动即报 "DevTools remote
 * debugging requires a non-default data directory" 并退出（APD11 本地复现），而 VP13 手机用例还原
 * USERPROFILE 后可正常启动。浏览器子进程还原系统真实用户目录，其余环境不变。
 */
export function e2eMobileBrowserLaunchOptions(env: NodeJS.ProcessEnv = process.env) {
  const executablePath = env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE?.trim();
  return {
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    env: {
      ...env,
      ...(process.platform === "win32" ? { USERPROFILE: userInfo().homedir } : {}),
    } as Record<string, string>,
  };
}
