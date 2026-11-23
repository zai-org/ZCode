import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { PreinstalledToolResource } from "@zcode/shared/preinstalled-tools";

type ResourceStream = {
  resource: PreinstalledToolResource;
  archivePath: string;
  prefix: Buffer;
  released: boolean;
  requests: number;
  completed: number;
  pending: Set<ServerResponse>;
};

/** 大包保留原始字节；只暂停下载边界，不替换实际应用或运行检查。 */
export async function startPreinstalledToolsRealFixture(
  artifactDirectory: string,
  artifactPaths: string | string[] | undefined = process.env.ZCODE_E2E_LIBREOFFICE_ARTIFACT,
  upgradeArtifact?: string,
) {
  const paths = typeof artifactPaths === "string" ? [artifactPaths] : artifactPaths;
  if (!paths?.length || paths.some((path) => !path.endsWith(".artifact.json")))
    throw new Error("Real fixture requires verified .artifact.json paths");
  const single = paths.length === 1 && !upgradeArtifact;
  await mkdir(artifactDirectory, { recursive: true });
  const directory = await mkdtemp(join(artifactDirectory, "real-session-"));
  const streams: ResourceStream[] = [];
  for (const artifactPath of [...paths, ...(upgradeArtifact ? [upgradeArtifact] : [])]) {
    const archivePath = artifactPath.replace(/\.artifact\.json$/, ".tar.gz");
    const { resource } = JSON.parse(await readFile(artifactPath, "utf8")) as {
      resource: PreinstalledToolResource;
    };
    const size = (await stat(archivePath)).size;
    if (size !== resource.archive.sizeBytes || size < 2)
      throw new Error("Real archive size mismatch");
    if (streams.some((item) => item.resource.resourceId === resource.resourceId))
      throw new Error("Real fixture resourceId must be unique");
    const prefix = Buffer.alloc(Math.min(65536, size - 1));
    const file = await open(archivePath, "r");
    try {
      await file.read(prefix, 0, prefix.length, 0);
    } finally {
      await file.close();
    }
    streams.push({
      resource,
      archivePath,
      prefix,
      released: false,
      requests: 0,
      completed: 0,
      pending: new Set(),
    });
  }
  const initial = streams.slice(0, paths.length);
  if (new Set(initial.map((item) => item.resource.toolId)).size !== initial.length)
    throw new Error("Real fixture initial toolId must be unique");
  const upgrade = upgradeArtifact ? streams.at(-1) : undefined;
  if (upgrade && !initial.some((item) => item.resource.toolId === upgrade.resource.toolId))
    throw new Error("Upgrade tool must exist in initial catalog");
  const activeCatalog = [...initial];
  let active = 0;
  let maxActive = 0;
  const events: Array<{
    event: string;
    at: string;
    toolId: string;
    resourceId: string;
    error?: string;
  }> = [];
  const event = (item: ResourceStream, name: string, error?: string) =>
    events.push({
      event: name,
      at: new Date().toISOString(),
      toolId: item.resource.toolId,
      resourceId: item.resource.resourceId,
      ...(error ? { error } : {}),
    });
  const finish = (item: ResourceStream, response: ServerResponse) => {
    item.pending.delete(response);
    void pipeline(
      createReadStream(item.archivePath, { start: item.prefix.length }),
      response,
    ).catch((error: Error) => event(item, "closed", error.message));
  };
  const release = (item: ResourceStream) => {
    item.released = true;
    event(item, "released");
    for (const response of item.pending) finish(item, response);
  };
  const status = () => ({
    requests: streams.reduce((sum, item) => sum + item.requests, 0),
    completed: streams.reduce((sum, item) => sum + item.completed, 0),
    held: streams.reduce((sum, item) => sum + item.pending.size, 0),
    active,
    maxActive,
    events,
    tools: Object.fromEntries(
      initial.map((item) => [
        item.resource.toolId,
        {
          requests: streams
            .filter((stream) => stream.resource.toolId === item.resource.toolId)
            .reduce((sum, stream) => sum + stream.requests, 0),
        },
      ]),
    ),
  });
  const catalogPath = join(directory, "catalog.json");
  const writeCatalog = () =>
    writeFile(
      catalogPath,
      JSON.stringify(
        activeCatalog.map((item) => ({
          toolId: item.resource.toolId,
          displayName: item.resource.toolId,
          resources: [
            {
              ...item.resource,
              archive: {
                ...item.resource.archive,
                path: single ? "archive" : `archive/${item.resource.resourceId}`,
              },
            },
          ],
        })),
      ),
    );
  const serve = async (path: string, response: ServerResponse) => {
    const item =
      single && path === "/archive"
        ? initial[0]
        : streams.find((stream) => path === `/archive/${stream.resource.resourceId}`);
    if (item) {
      item.requests += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      event(item, "requested");
      let settled = false;
      const settle = (completed: boolean) => {
        if (settled) return;
        settled = true;
        active -= 1;
        item.pending.delete(response);
        if (completed) {
          item.completed += 1;
          event(item, "completed");
        }
      };
      // pipeline还会等待源文件close；HTTP客户端已读完时不能因此仍报告未完成。
      response.once("finish", () => settle(true));
      response.once("close", () => settle(false));
      response.writeHead(200, { "content-length": item.resource.archive.sizeBytes });
      response.write(item.prefix);
      if (item.released) finish(item, response);
      else item.pending.add(response);
    } else if (path === "/release") {
      initial.forEach(release);
      response.end("released");
    } else if (path.startsWith("/release/")) {
      const selected = streams.find((stream) => path === `/release/${stream.resource.resourceId}`);
      if (!selected) {
        response.writeHead(404).end();
        return;
      }
      release(selected);
      response.end("released");
    } else if (path === "/upgrade" && upgrade) {
      activeCatalog[
        activeCatalog.findIndex((current) => current.resource.toolId === upgrade.resource.toolId)
      ] = upgrade;
      await writeCatalog();
      response.end("catalog updated");
    } else if (path === "/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(status()));
    } else response.writeHead(404).end();
  };
  const server = createServer((request, response) => {
    void serve(request.url ?? "", response).catch((error: Error) => response.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  const url = `http://127.0.0.1:${address.port}`;
  await writeCatalog();
  return {
    url,
    cdnBaseUrl: url,
    catalogPath,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await writeFile(
        join(directory, "http-events.json"),
        JSON.stringify(
          {
            ...status(),
            resources: streams.map(({ resource, archivePath }) => ({ resource, archivePath })),
          },
          null,
          2,
        ),
      );
    },
  };
}
