import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { create as createTar } from "tar";
import { preinstalledToolsCatalogSchema } from "@zcode/shared/preinstalled-tools";

const isWindows = process.platform === "win32";

/** 普通 E2E 显式保留工具卡片但移除资源，避免启动时下载正式 CDN 的大包。 */
export async function writeEmptyPreinstalledToolsCatalog(directory: string): Promise<string> {
  const catalog = preinstalledToolsCatalogSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../../../src/preinstalled-tools/catalog.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, "empty-catalog.json");
  await writeFile(
    path,
    JSON.stringify(
      catalog.map(({ toolId, displayName }) => ({ toolId, displayName, resources: [] })),
    ),
  );
  return path;
}

/** 夹具程序本体在资源内的相对路径；Windows 没有 sh，由 Node 脚本承担同样的断言与输出。 */
export const PREINSTALLED_FIXTURE_PROGRAM = isWindows ? "bin/office.mjs" : "bin/office";

/** 入口目标随平台变化：POSIX 是指向程序本体的符号链接，Windows 是一行 .cmd。 */
export function preinstalledFixtureTarget(toolId: string): string {
  const command = toolId === "libreoffice" ? "soffice" : toolId;
  return isWindows ? `bin/${command}.cmd` : `bin/${command}`;
}

/** Windows 入口目标：用 %~dp0 定位脚本、%~f0 报告自身路径，文件内容不含安装目录。 */
export function preinstalledFixtureWindowsLauncher(): string {
  return `@"${process.execPath}" "%~dp0office.mjs" "%~f0" %*\r\n`;
}

/** Windows 夹具程序：与 POSIX sh 脚本相同的断言顺序、退出码和输出流。 */
export function preinstalledFixtureWindowsProgram(
  runtimeCheckUrl: string,
  options: { assertEntryContract?: boolean; failAfterCheck?: boolean; outputToStderr?: boolean },
): string {
  return `import { stat } from "node:fs/promises";
const [self, ...args] = process.argv.slice(2);
${
  options.assertEntryContract
    ? `if (args[0] !== \`--install=\${process.env.FIXTURE_INSTALL_DIR}\`) process.exit(2);
if (args[1]?.startsWith("--temp=")) {
  const temporary = await stat(args[1].slice("--temp=".length)).catch(() => null);
  if (!temporary?.isDirectory()) process.exit(3);
}
if (process.env.FIXTURE_DEFAULT !== "fixture-default") process.exit(4);
`
    : ""
}if (args.includes("--fixture-location")) {
  console.log(self);
  process.exit(0);
}
const response = await fetch(${JSON.stringify(runtimeCheckUrl)});
if (!response.ok) process.exit(22);
process.${options.outputToStderr ? "stderr" : "stdout"}.write(await response.text());
${options.failAfterCheck ? "process.exitCode = 1;\n" : ""}`;
}

/** 公开入口的可执行文件：Windows 上是 shim 副本 <name>.exe，其他平台是 sh 脚本。 */
export function preinstalledEntryPath(binDir: string, name: string): string {
  return join(binDir, isWindows ? `${name}.exe` : name);
}

/**
 * 入口指向的目标、参数和环境值，用于断言入口指向哪个版本。
 * Windows 上读 shim 配置并解码 JSON，避免路径中的反斜杠被转义后断言落空。
 */
export async function readPreinstalledEntryDefinition(
  binDir: string,
  name: string,
): Promise<string> {
  if (!isWindows) return readFile(join(binDir, name), "utf8");
  const config = JSON.parse(await readFile(join(binDir, `${name}.shim`), "utf8")) as {
    target: string;
    args: string[];
    env: { value?: string }[];
  };
  return [config.target, ...config.args, ...config.env.map((item) => item.value ?? "")].join("\n");
}

/** 从测试进程调用公开入口；Windows 上 shim 是普通可执行文件，与 POSIX 同样直接运行。 */
export async function executePreinstalledEntry(
  binDir: string,
  name: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(preinstalledEntryPath(binDir, name), [...args], {
    windowsHide: true,
  });
}

const lockedDirectoryModes = new Map<string, number>();

/**
 * 让目录可读不可写，制造真实的写入失败。Windows 的 chmod 限制不了目录写入，
 * 这里对当前用户加拒绝项（新建、写入、删除子项），解锁时只移除拒绝项。
 */
export async function lockPreinstalledDirectory(directory: string): Promise<void> {
  if (!isWindows) {
    lockedDirectoryModes.set(directory, (await stat(directory)).mode);
    await chmod(directory, 0o500);
    return;
  }
  await promisify(execFile)(
    "icacls",
    [directory, "/deny", `${process.env.USERNAME}:(OI)(CI)(WD,AD,DC,DE)`],
    { windowsHide: true },
  );
}

export async function unlockPreinstalledDirectory(directory: string): Promise<void> {
  if (!isWindows) {
    await chmod(directory, lockedDirectoryModes.get(directory)!);
    return;
  }
  await promisify(execFile)("icacls", [directory, "/remove:d", process.env.USERNAME!], {
    windowsHide: true,
  });
}

/** 固定发布点与资源版本无关；测试不从已发布记录反推当前目标。 */
export async function preinstalledFixtureRecordPath(
  releaseRoot: string,
  toolId = "libreoffice",
): Promise<string> {
  return join(releaseRoot, "tools", toolId, "installation.json");
}

/** 每个工具有独立 HTTP 屏障，测试显式放行而非用延时猜测串行顺序。 */
export async function startPreinstalledToolsFixture(
  artifactDirectory: string,
  toolIds = ["libreoffice"],
) {
  await mkdir(artifactDirectory, { recursive: true });
  const directory = await mkdtemp(join(artifactDirectory, "session-"));
  const tools = new Map(
    toolIds.map((toolId) => [
      toolId,
      {
        bytes: Buffer.alloc(0),
        pending: new Set<ServerResponse>(),
        downloads: new Map<number, ServerResponse>(),
        checking: new Set<ServerResponse>(),
        requests: 0,
        runtimeChecks: 0,
        lateWrites: 0,
        released: false,
        checkReleased: false,
      },
    ]),
  );
  const events: Array<{ path: string | undefined; toolId?: string; at: string }> = [];
  const snapshot = () => {
    const states = [...tools].map(
      ([toolId, tool]) =>
        [
          toolId,
          {
            requests: tool.requests,
            pending: tool.pending.size,
            runtimeChecks: tool.runtimeChecks,
            lateWrites: tool.lateWrites,
          },
        ] as const,
    );
    return {
      requests: states.reduce((sum, [, tool]) => sum + tool.requests, 0),
      pending: states.reduce((sum, [, tool]) => sum + tool.pending, 0),
      runtimeChecks: states.reduce((sum, [, tool]) => sum + tool.runtimeChecks, 0),
      lateWrites: states.reduce((sum, [, tool]) => sum + tool.lateWrites, 0),
      tools: Object.fromEntries(states),
    };
  };
  const server = createServer((req, res) => {
    const segments = (req.url ?? "").split("/").filter(Boolean);
    const toolId = tools.has(segments[0] ?? "") ? segments.shift()! : "libreoffice";
    const path = `/${segments.join("/")}`;
    const tool = tools.get(toolId);
    events.push({ path: req.url, toolId, at: new Date().toISOString() });
    if (path === "/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (!tool) {
      res.writeHead(404).end();
      return;
    }
    const output = toolId === "libreoffice" ? "LibreOffice 26.8.1\n" : `${toolId} fixture\n`;
    if (path === "/archive") {
      tool.requests += 1;
      tool.downloads.set(tool.requests, res);
      res.writeHead(200, { "content-length": tool.bytes.length });
      if (tool.released) res.end(tool.bytes);
      else {
        res.write(tool.bytes.subarray(0, Math.floor(tool.bytes.length / 2)));
        tool.pending.add(res);
        res.once("close", () => tool.pending.delete(res));
      }
    } else if (path.startsWith("/release-request/") || path.startsWith("/break-request/")) {
      const response = tool.downloads.get(Number(segments.at(-1)));
      if (!response) {
        res.writeHead(404).end();
        return;
      }
      if (path.startsWith("/break-request/")) response.destroy();
      else {
        if (response.destroyed) tool.lateWrites += 1;
        response.end(tool.bytes.subarray(Math.floor(tool.bytes.length / 2)));
      }
      tool.pending.delete(response);
      res.end("settled-one");
    } else if (path === "/release") {
      tool.released = true;
      for (const response of tool.pending)
        response.end(tool.bytes.subarray(Math.floor(tool.bytes.length / 2)));
      tool.pending.clear();
      res.end("released");
    } else if (path === "/runtime-check") {
      tool.runtimeChecks += 1;
      if (tool.checkReleased) res.end(output);
      else {
        tool.checking.add(res);
        res.once("close", () => tool.checking.delete(res));
      }
    } else if (path === "/finish-check") {
      tool.checkReleased = true;
      for (const response of tool.checking) response.end(output);
      tool.checking.clear();
      res.end("checked");
    } else if (path === "/hold-check") {
      tool.checkReleased = false;
      res.end("holding-check");
    } else if (path === "/hold") {
      tool.released = false;
      res.end("holding");
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  const url = `http://127.0.0.1:${address.port}`;
  const catalog = [];
  for (const [toolId, tool] of tools) {
    const payload = join(directory, toolId, "payload");
    await mkdir(join(payload, "bin"), { recursive: true });
    const target = preinstalledFixtureTarget(toolId);
    if (isWindows) {
      await writeFile(
        join(payload, PREINSTALLED_FIXTURE_PROGRAM),
        preinstalledFixtureWindowsProgram(`${url}/${toolId}/runtime-check`, {
          assertEntryContract: toolId === "qpdf",
          outputToStderr: toolId === "qpdf",
        }),
      );
      await writeFile(join(payload, target), preinstalledFixtureWindowsLauncher());
    } else {
      const assertions =
        toolId === "qpdf"
          ? 'test "$1" = "--install=$FIXTURE_INSTALL_DIR" || exit 2\ncase "$2" in --temp=*) [ -d "${2#--temp=}" ] || exit 3;; esac\ntest "$FIXTURE_DEFAULT" = "fixture-default" || exit 4\n'
          : "";
      await writeFile(
        join(payload, PREINSTALLED_FIXTURE_PROGRAM),
        `#!/bin/sh\n${assertions}for argument in "$@"; do\n  if [ "$argument" = "--fixture-location" ]; then printf '%s\\n' "$0"; exit 0; fi\ndone\nexec /usr/bin/curl --silent --show-error --fail --noproxy '*' '${url}/${toolId}/runtime-check'${toolId === "qpdf" ? " >&2" : ""}\n`,
        { mode: 0o755 },
      );
      await symlink("office", join(payload, target));
    }
    const archive = join(directory, toolId, "fixture.tar.gz");
    await createTar({ gzip: true, portable: true, cwd: payload, file: archive }, ["bin"]);
    tool.bytes = await readFile(archive);
    const entryName = toolId === "libreoffice" ? "zcode-soffice" : toolId;
    catalog.push({
      toolId,
      displayName: toolId === "libreoffice" ? "LibreOffice" : toolId,
      resources: [
        {
          toolId,
          resourceId: `fixture-${toolId}-26.8.1-${process.platform}-${process.arch}`,
          version: "26.8.1",
          platforms: [{ platform: process.platform, arch: process.arch }],
          binaryArch: process.arch,
          archive: {
            format: "tar.gz",
            sizeBytes: tool.bytes.length,
            sha256: createHash("sha256").update(tool.bytes).digest("hex"),
            path: `${toolId}/archive`,
          },
          installedSizeBytes: 8192,
          requiredFiles: [target, PREINSTALLED_FIXTURE_PROGRAM],
          entries: [
            {
              name: entryName,
              target,
              args: toolId === "qpdf" ? ["--install=${INSTALL_DIR}"] : [],
              env:
                toolId === "qpdf"
                  ? [
                      { name: "FIXTURE_INSTALL_DIR", action: "set", value: "${INSTALL_DIR}" },
                      { name: "FIXTURE_DEFAULT", action: "default", value: "fixture-default" },
                      { name: "FIXTURE_UNUSED", action: "unset" },
                    ]
                  : [],
            },
          ],
          runtimeChecks: Array.from({ length: toolId === "qpdf" ? 2 : 1 }, () => ({
            entry: entryName,
            args: toolId === "qpdf" ? ["--temp=${CHECK_TEMP_DIR}"] : ["--version"],
            expectedOutput: toolId === "libreoffice" ? "LibreOffice 26.8.1" : `${toolId} fixture`,
            timeoutMs: 60000,
          })),
        },
      ],
    });
  }
  const catalogPath = join(directory, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  return {
    url,
    // App 只按这个基址拼接 catalog 的 archive.path，与正式 CDN 走同一条装配规则。
    cdnBaseUrl: url,
    catalogPath,
    stop: async () => {
      await writeFile(
        join(directory, "http-events.json"),
        JSON.stringify({ events, ...snapshot() }, null, 2),
      );
      for (const tool of tools.values())
        for (const response of [...tool.pending, ...tool.checking]) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
