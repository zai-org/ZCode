import { BrowserWindow, ipcMain, webContents, type Session, type WebContents } from "electron";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
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

// 资源改由句柄读取后不再经过 net.fetch（它会按路径重新打开文件），因此自带 MIME 映射。
// 不写 charset：HTML/脚本/样式的编码仍由页面 meta 或浏览器默认决定，与原 file 协议一致。
const PREVIEW_MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".xhtml": "application/xhtml+xml",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".apng": "image/apng",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  // 以下按修复前 net.fetch(file://) 在 Electron 44 / macOS 上按扩展名返回的类型补齐，避免改为句柄读取后
  // 这些文件因回退到 octet-stream + nosniff 而无法显示或加载（!3740 评审 SG-01）。
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".vtt": "text/vtt",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".rtf": "text/rtf",
  ".zip": "application/zip",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
  ".oga": "audio/ogg",
  ".weba": "audio/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  // 修复前这三类靠内容嗅探得到 text/plain；按标准类型给出，脚本与清单可以正常加载。
  ".log": "text/plain",
  ".cjs": "text/javascript",
  ".webmanifest": "application/manifest+json",
};

// O_NONBLOCK 让 FIFO 等特殊文件的 open 立即返回，之后由 fstat 拒绝；否则 open 会阻塞 handler。
// Windows 没有该标志，也没有可放入普通目录的 FIFO，因此不加。
const PREVIEW_OPEN_FLAGS =
  constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);

/**
 * 打开预览资源并校验文件身份。通过后返回已绑定的句柄，之后的读取只使用它；拒绝时关闭句柄并返回 null。
 *
 * 根因（ZP-20261105-09）：子树内的硬链接 realpath 仍是自身，却与子树外文件共享同一 inode，
 * 纯路径前缀判断会放行，页面 JS 因此能读到子树外的 .ssh/.env 等文件。
 * 修复：
 * 1. 先 open 绑定对象，之后不再按路径二次打开，杜绝“检查通过后路径被替换”的窗口；
 * 2. 真实路径必须仍在预览根内，且它的 (dev, ino) 必须与句柄 fstat 的结果一致；
 * 3. 句柄必须是普通文件，且只有一个名字（nlink === 1）、拿得到文件索引（ino !== 0）。
 * Windows 上 Node 的 fstat/stat 由 libuv 通过 NT 接口填充 dev（卷序列号）、ino（文件索引）、nlink（NumberOfLinks），
 * 与 POSIX 使用同一套比较，不需要分平台分支。
 */
async function openPreviewFile(
  root: string,
  path: string,
  warn: (message: string) => void,
): Promise<{ handle: FileHandle; size: number } | null> {
  const handle = await open(path, PREVIEW_OPEN_FLAGS);
  let accepted = false;
  try {
    const named = await realpath(path);
    if (!isContained(root, named)) return null;
    const namedStat = await stat(named, { bigint: true });
    // fstat 放在身份比较之后，让 nlink 的最终判断尽量靠近读取动作。
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== namedStat.dev || opened.ino !== namedStat.ino) {
      warn(`[browser-local-preview] opened file identity changed: ${path}`);
      return null;
    }
    if (!opened.isFile()) return null;
    if (opened.nlink !== 1n) {
      warn(`[browser-local-preview] rejected multi-link file (nlink=${opened.nlink}): ${path}`);
      return null;
    }
    if (opened.ino === 0n) {
      warn(`[browser-local-preview] file identity unavailable: ${path}`);
      return null;
    }
    accepted = true;
    return { handle, size: Number(opened.size) };
  } finally {
    if (!accepted) await handle.close();
  }
}

export function createBrowserLocalPreview(
  warn: (message: string) => void = () => {},
): BrowserLocalPreviewContract {
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
        // file 页面原有的跨文件权限不受 sandbox 限制；预览只把通过句柄身份校验的资源交给 loader。
        const path = resolve(canonicalRoot, ...segments);
        const opened = await openPreviewFile(canonicalRoot, path, warn);
        if (!opened) return new Response(null, { status: 403 });
        const { handle, size } = opened;
        const headers = new Headers({
          "Content-Type":
            PREVIEW_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": String(size),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        if (request.method === "HEAD" || size === 0) {
          await handle.close();
          return new Response(request.method === "HEAD" ? null : new Uint8Array(0), {
            status: 200,
            headers,
          });
        }
        // 读取只走已校验的句柄；流结束或取消时由 FileHandle 自动关闭。
        // 只读到 fstat 时的长度：Content-Length 取自同一次 fstat，文件在读取中被 dev server 改写时，
        // 读到 EOF 会让实际字节数与声明不一致，Chromium 判为 ERR_CONTENT_LENGTH_MISMATCH（!3740 评审）。
        // 空文件已在上面返回，因为 end: -1 不是合法范围。
        return new Response(
          Readable.toWeb(handle.createReadStream({ start: 0, end: size - 1 })) as ReadableStream,
          { status: 200, headers },
        );
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}

export function installBrowserLocalPreview(
  browserSession: Session,
  warn?: (message: string) => void,
): void {
  // 只作用于内置浏览器 partition；先封住原始 file，初始化失败也不得退回不受限的 loader。
  browserSession.protocol.handle("file", () => Response.error());
  const preview = createBrowserLocalPreview(warn);
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
