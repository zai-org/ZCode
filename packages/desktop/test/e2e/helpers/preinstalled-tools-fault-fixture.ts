import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buffer } from "node:stream/consumers";
import { create as createTar, Header, Pack, ReadEntry } from "tar";
import {
  PREINSTALLED_FIXTURE_PROGRAM,
  preinstalledFixtureTarget,
  preinstalledFixtureWindowsProgram,
  startPreinstalledToolsFixture,
} from "#e2e/helpers/preinstalled-tools-fixture";
import { startPreinstalledToolsFaultServer } from "#e2e/helpers/preinstalled-tools-fault-server";
import { startE2ENetworkCaptureProxy } from "#e2e/helpers/network-capture-proxy";

const scenarios = [
  "ready",
  "network",
  "interrupted",
  "slow",
  "checksum",
  "truncated",
  "oversize",
  "extract",
  "platform",
  "missing",
  "unsafe-link",
  "runtime",
  "unsupported",
  "space",
  "fallback",
  "checksum-then-network",
  "proxy",
] as const;
type Scenario = (typeof scenarios)[number];
const isWindows = process.platform === "win32";

/**
 * 普通 Windows 用户不能在磁盘上创建符号链接；越界链接只需出现在归档里，
 * 所以直接写入 tar 条目，让安装器拿到与 POSIX 相同结构的恶意输入。
 */
async function packWithUnsafeLink(payload: string, target: string): Promise<Buffer> {
  const pack = new Pack({ gzip: true, portable: true, cwd: payload });
  const bytes = buffer(pack);
  pack.add("bin");
  pack.add("zcode-tool-resource.json");
  const link = new ReadEntry(
    new Header({
      path: target,
      type: "SymbolicLink",
      linkpath: "../../outside",
      mode: 0o777,
      size: 0,
      mtime: new Date(0),
    }),
  );
  pack.add(link);
  link.end();
  pack.end();
  return bytes;
}

const CANDIDATE_COUNT = 2;
const PROXY_HOST = "preinstall.example.test";

/**
 * 所有故障通过资源清单、HTTP 与真实文件系统产生，不修改安装 owner。
 * 下载基址在 App 启动时固定，所以主／备候选用两个基址表示；需要经代理访问的基址只用于 proxy 用例。
 */
export async function startPreinstalledToolsFaultFixture(
  directory: string,
  { proxy: viaProxy = false }: { proxy?: boolean } = {},
) {
  await mkdir(directory, { recursive: true });
  const base = await startPreinstalledToolsFixture(join(directory, "base"));
  await fetch(`${base.url}/finish-check`);
  const original = JSON.parse(await readFile(base.catalogPath, "utf8"))[0].resources[0];
  const resources: Record<string, Buffer> = {};
  const manifests: Record<string, typeof original> = {};
  for (const scenario of scenarios) {
    const payload = join(directory, scenario);
    await cp(join(dirname(base.catalogPath), "libreoffice", "payload"), payload, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const resourceId = `fixture-fault-${scenario}-${process.platform}-${process.arch}`;
    const identity = {
      schemaVersion: 1,
      tool: "libreoffice",
      resourceId,
      version: "26.8.1",
      platform:
        scenario === "platform"
          ? process.platform === "linux"
            ? "darwin"
            : "linux"
          : process.platform,
      arch: process.arch,
    };
    await writeFile(join(payload, "zcode-tool-resource.json"), JSON.stringify(identity));
    const target = preinstalledFixtureTarget("libreoffice");
    if (scenario === "missing" || scenario === "unsafe-link") await rm(join(payload, target));
    if (scenario === "unsafe-link" && !isWindows)
      await symlink("../../outside", join(payload, target));
    if (scenario === "runtime")
      await writeFile(
        join(payload, PREINSTALLED_FIXTURE_PROGRAM),
        isWindows
          ? preinstalledFixtureWindowsProgram(`${base.url}/runtime-check`, { failAfterCheck: true })
          : `#!/bin/sh\n/usr/bin/curl --silent --show-error --fail --noproxy '*' '${base.url}/runtime-check'\nexit 1\n`,
        { mode: 0o755 },
      );
    const archive = join(directory, `${scenario}.tar.gz`);
    await createTar({ gzip: true, portable: true, cwd: payload, file: archive }, [
      "bin",
      "zcode-tool-resource.json",
    ]);
    const bytes =
      scenario === "extract"
        ? Buffer.from("invalid gzip content")
        : scenario === "unsafe-link" && isWindows
          ? await packWithUnsafeLink(payload, target)
          : await readFile(archive);
    resources[scenario] = bytes;
    manifests[scenario] = {
      ...original,
      resourceId,
      archive: {
        ...original.archive,
        path: scenario,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    if (scenario === "checksum" || scenario === "checksum-then-network")
      manifests[scenario].archive.sha256 = "0".repeat(64);
    if (scenario === "unsupported")
      manifests[scenario].platforms = [
        { platform: process.platform === "linux" ? "darwin" : "linux", arch: process.arch },
      ];
    if (scenario === "space") {
      manifests[scenario].installedSizeBytes = 2 ** 40;
      // 空间检查应在下载前拒绝；归档大小须在 GB 舍入后仍可见，才能发现提示漏算。
      manifests[scenario].archive.sizeBytes = 2 ** 29;
    }
  }
  // 第二个候选默认快速失败；网络错误排在最低，不改变首个候选决定的最终错误分类。
  const candidates = Object.fromEntries(
    scenarios.map((scenario) => [
      scenario,
      scenario === "fallback" || scenario === "proxy"
        ? ["http-error", "complete"]
        : scenario === "checksum-then-network"
          ? ["complete", "http-error"]
          : [
              (
                {
                  network: "http-error",
                  interrupted: "interrupt",
                  slow: "slow",
                  truncated: "truncated",
                  oversize: "oversize",
                } as Record<string, string>
              )[scenario] ?? "complete",
              "http-error",
            ],
    ]),
  );
  const downloads = await startPreinstalledToolsFaultServer({ directory, resources, candidates });
  const candidatePaths = Array.from(
    { length: CANDIDATE_COUNT },
    (_, index) => `/candidates/${index}`,
  );
  const proxy = await startE2ENetworkCaptureProxy({
    artifactPath: join(directory, "private-proxy-capture.json"),
    caDir: join(directory, "private-ca"),
    requestRedirects: candidatePaths.map((path) => ({
      host: PROXY_HOST,
      path: `${path}/proxy`,
      targetUrl: `${downloads.url}${path}/proxy`,
    })),
  });
  const cdnBaseUrl = candidatePaths
    .map((path) => `${viaProxy ? `https://${PROXY_HOST}` : downloads.url}${path}`)
    .join(",");
  const catalogPath = join(directory, "catalog.json");
  const catalog = (resource: typeof original) => [
    { toolId: "libreoffice", displayName: "LibreOffice", resources: [resource] },
  ];
  await writeFile(
    catalogPath,
    JSON.stringify(catalog(viaProxy ? manifests.proxy : manifests.space)),
  );
  const control = createServer((request, response) => {
    void (async () => {
      const route = new URL(request.url ?? "/", "http://fixture.example.test").pathname.split("/");
      if (route[1] === "scenario" && scenarios.includes(route[2] as Scenario)) {
        await writeFile(catalogPath, JSON.stringify(catalog(manifests[route[2]!])));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(manifests[route[2]!]));
      } else if (route[1] === "status") {
        const downloadStatus = await (await fetch(`${downloads.url}/status`)).json();
        const runtime = await (await fetch(`${base.url}/status`)).json();
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ...downloadStatus,
            runtimeChecks: runtime.runtimeChecks,
            proxyUrl: proxy.proxyUrl,
            caCertPath: proxy.caCertPath,
          }),
        );
      } else if (["release", "step", "break"].includes(route[1] ?? "")) {
        const result = await fetch(`${downloads.url}/${route[1]}/${route[2]}`);
        response.writeHead(result.status).end(await result.text());
      } else response.writeHead(404).end();
    })().catch((error) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", resolve);
  });
  const address = control.address();
  if (!address || typeof address === "string") throw new Error("故障控制服务没有监听地址");
  return {
    url: `http://127.0.0.1:${address.port}`,
    cdnBaseUrl,
    catalogPath,
    stop: async () => {
      control.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        control.close((error) => (error ? reject(error) : resolve())),
      );
      await proxy.stop();
      await downloads.stop();
      await base.stop();
    },
  };
}
