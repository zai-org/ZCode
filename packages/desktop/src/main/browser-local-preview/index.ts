import { BrowserWindow, ipcMain, net, webContents, type Session, type WebContents } from "electron";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BROWSER_LOCAL_PREVIEW_SCHEME, PlatformChannels } from "@zcode/shared";
import type { BrowserLocalPreviewContract } from "@desktop/main/browser-local-preview/contract.js";

export const BROWSER_LOCAL_PREVIEW_PRIVILEGES = {
  scheme: BROWSER_LOCAL_PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

function isContained(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== "" && !isAbsolute(child) && child.split(sep).every((part) => !part.startsWith("."))
  );
}

export function createBrowserLocalPreview(): BrowserLocalPreviewContract {
  // 完整退出会清空浏览器标签；进程内共享签名密钥即可支持刷新和 guest 恢复，无需第二份持久化状态。
  const key = randomBytes(32);
  const sign = (rootUrl: string) => createHmac("sha256", key).update(rootUrl).digest("hex");
  return {
    async resolveNavigation(input) {
      const source = new URL(input);
      if (source.protocol !== "file:") return input;
      if (source.host || !/\.html?$/i.test(source.pathname))
        throw new Error("Only local HTML can be previewed");
      const path = fileURLToPath(source);
      const root = await realpath(dirname(path));
      const file = await realpath(path);
      if (
        dirname(root) === root ||
        basename(root).startsWith(".") ||
        !isContained(root, file) ||
        !(await stat(file)).isFile()
      ) {
        throw new Error("HTML is outside the preview directory");
      }
      const rootUrl = pathToFileURL(root + sep).href;
      // Windows junction 也可能把本地路径指向 UNC；解析后仍需拒绝网络共享授权。
      if (new URL(rootUrl).host) throw new Error("Network files cannot be previewed");
      const url = new URL(
        `${BROWSER_LOCAL_PREVIEW_SCHEME}://${sign(rootUrl)}/${encodeURIComponent(rootUrl)}/${encodeURIComponent(basename(path))}`,
      );
      url.search = source.search;
      url.hash = source.hash;
      return url.href;
    },
    async respond(request) {
      try {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response(null, { status: 405 });
        const url = new URL(request.url);
        const [, encodedRoot, ...encodedSegments] = url.pathname.split("/");
        const rootUrl = decodeURIComponent(encodedRoot ?? "");
        if (
          url.protocol !== `${BROWSER_LOCAL_PREVIEW_SCHEME}:` ||
          url.port ||
          url.username ||
          url.password ||
          !/^[a-f0-9]{64}$/.test(url.hostname) ||
          !timingSafeEqual(Buffer.from(url.hostname, "hex"), Buffer.from(sign(rootUrl), "hex"))
        ) {
          return new Response(null, { status: 403 });
        }
        const root = fileURLToPath(rootUrl);
        const canonicalRoot = await realpath(root);
        if (resolve(root) !== canonicalRoot) return new Response(null, { status: 403 });
        const segments = encodedSegments.map(decodeURIComponent);
        if (
          !segments.length ||
          segments.some(
            (part) => !part || part.startsWith(".") || part.includes("\0") || /[\\/:]/.test(part),
          )
        ) {
          return new Response(null, { status: 403 });
        }
        const file = await realpath(resolve(canonicalRoot, ...segments));
        // file 页面原有的跨文件权限不受 sandbox 限制；预览只把通过真实目录校验的资源交给 loader。
        if (!isContained(canonicalRoot, file) || !(await stat(file)).isFile())
          return new Response(null, { status: 403 });
        const response = await net.fetch(pathToFileURL(file).href, {
          method: request.method,
          bypassCustomProtocolHandlers: true,
        });
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}

export function installBrowserLocalPreview(browserSession: Session): void {
  // 只作用于内置浏览器 partition；先封住原始 file，初始化失败也不得退回不受限的 loader。
  browserSession.protocol.handle("file", () => Response.error());
  const preview = createBrowserLocalPreview();
  browserSession.protocol.handle(BROWSER_LOCAL_PREVIEW_SCHEME, (request) =>
    preview.respond(request),
  );
  const generations = new WeakMap<WebContents, number>();
  ipcMain.handle(PlatformChannels.BrowserViewLoadUrl, async (event, payload: unknown) => {
    if (
      !payload ||
      typeof payload !== "object" ||
      !("webContentsId" in payload) ||
      !("url" in payload) ||
      typeof payload.webContentsId !== "number" ||
      !Number.isSafeInteger(payload.webContentsId) ||
      typeof payload.url !== "string"
    ) {
      throw new TypeError("Invalid browser navigation");
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const guest = webContents.fromId(payload.webContentsId);
    if (
      !win ||
      win.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      !guest ||
      guest.hostWebContents !== event.sender ||
      guest.session !== browserSession
    ) {
      throw new Error("Browser navigation owner mismatch");
    }
    const protocol = new URL(payload.url).protocol;
    if (
      !["about:", "data:", "file:", "http:", "https:", `${BROWSER_LOCAL_PREVIEW_SCHEME}:`].includes(
        protocol,
      )
    )
      throw new Error("Unsupported browser URL");
    const generation = (generations.get(guest) ?? 0) + 1;
    generations.set(guest, generation);
    const isCurrent = () => !guest.isDestroyed() && generations.get(guest) === generation;
    try {
      const url = await preview.resolveNavigation(payload.url);
      // 文件 IO 可能晚于下一次导航完成，旧结果不得把用户带回旧页面。
      if (isCurrent()) await guest.loadURL(url);
    } catch (error) {
      // 被新导航取代的文件错误也不能回写 UI，避免新页面已经成功却被旧错误覆盖。
      if (isCurrent()) throw error;
    }
  });
}
