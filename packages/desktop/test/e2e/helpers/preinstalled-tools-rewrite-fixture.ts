import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { create as createTar } from "tar";

const exec = promisify(execFile);
const PREFIX = `/build/${"relocatable-prefix-".repeat(32)}`;
const SCENARIOS = [
  "plain",
  "success",
  "dir-prefix",
  "dir-prefix-too-long",
  "dir-prefix-invalid",
  "dir-prefix-binary",
  "too-long",
  "missing",
  "signing-failure",
  "cancel",
] as const;
const CANCEL_FILES = 4096;

/** 真实 Mach-O 与文本归档；只通过 catalog、HTTP、公开命令和文件系统控制验收。 */
export async function startPreinstalledToolsRewriteFixture(artifactDirectory: string) {
  if (process.platform !== "darwin") throw new Error("路径改写候选需要 macOS 原生签名工具");
  await mkdir(artifactDirectory, { recursive: true });
  // 同一报告目录可启动多轮候选，清单与归档必须各自拥有目录，不能覆盖上一轮。
  const directory = await mkdtemp(join(artifactDirectory, "session-"));
  const source = join(directory, "probe.c");
  const original = join(directory, "probe");
  await writeFile(
    source,
    `#include <stdio.h>\nstatic const char target[] = "${PREFIX}/data/value.txt";\nint main(void) { char value[4096]; FILE *file = fopen(target, "r"); if (!file) { perror(target); return 2; } if (!fgets(value, sizeof(value), file)) return 3; fclose(file); printf("rewrite-ok:%s\\n", value); return 0; }\n`,
  );
  await exec("clang", ["-O0", source, "-o", original]);
  await exec("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "example.preinstalled.rewrite",
    original,
  ]);
  const originalBinary = await readFile(original);
  const directorySource = join(directory, "directory-probe.cpp");
  const directoryProbe = join(directory, "directory-probe");
  await writeFile(
    directorySource,
    `#include <stdio.h>\n#include <string>\nstatic const char root[] = "${PREFIX}";\nint main() { std::string path(root, sizeof(root)-1); path += "/data/value.txt"; FILE *file=fopen(path.c_str(),"r"); if(!file) { perror(path.c_str()); return 2; } char value[4096]; if(!fgets(value,sizeof(value),file)) return 3; fclose(file); printf("rewrite-ok:%s\\n",value); }\n`,
  );
  await exec("clang++", ["-O2", directorySource, "-o", directoryProbe]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", directoryProbe]);
  const directoryData = Buffer.from(`${PREFIX}/one\0${PREFIX}/two\0${PREFIX}`);
  const binaryData = Buffer.from(`${PREFIX}/one:${PREFIX}/二\0tail/${PREFIX}/tail`);
  const resources = new Map<string, Buffer>();
  const manifests = new Map<string, unknown>();
  const catalogPath = join(directory, "catalog.json");
  const requests: string[] = [];
  const pending = new Map<string, Set<ServerResponse>>();
  const released = new Set<string>();
  const server = createServer((request, response) => {
    void (async () => {
      const [kind, name] = (request.url ?? "").split("/").filter(Boolean);
      if (kind === "archive" && name && resources.has(name)) {
        requests.push(name);
        const bytes = resources.get(name)!;
        response.writeHead(200, { "content-length": bytes.length });
        if (["cancel", "signing-failure"].includes(name) && !released.has(name)) {
          const waiting = pending.get(name) ?? new Set<ServerResponse>();
          pending.set(name, waiting);
          waiting.add(response);
          response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
          response.once("close", () => waiting.delete(response));
        } else response.end(bytes);
      } else if (kind === "release" && name && resources.has(name)) {
        released.add(name);
        const bytes = resources.get(name)!;
        for (const waiting of pending.get(name) ?? [])
          waiting.end(bytes.subarray(Math.floor(bytes.length / 2)));
        pending.delete(name);
        response.end("released");
      } else if (kind === "scenario" && name && manifests.has(name)) {
        await writeFile(
          catalogPath,
          JSON.stringify([
            { toolId: "qpdf", displayName: "qpdf", resources: [manifests.get(name)] },
          ]),
        );
        response.end("selected");
      } else if (kind === "status") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            requests,
            pending: [...pending].filter(([, waiting]) => waiting.size > 0).map(([name]) => name),
            binarySize: binaryData.length,
            directoryPrefixSize: directoryData.length,
            originalBinarySha256: createHash("sha256").update(originalBinary).digest("hex"),
          }),
        );
      } else response.writeHead(404).end();
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("rewrite fixture address missing");
  const url = `http://127.0.0.1:${address.port}`;
  for (const scenario of SCENARIOS) {
    const payload = join(directory, scenario);
    await mkdir(join(payload, "bin"), { recursive: true });
    await mkdir(join(payload, "data"), { recursive: true });
    await cp(original, join(payload, "bin", "probe"));
    await cp(original, join(payload, "bin", "unchanged"));
    await writeFile(join(payload, "bin", "plain"), "#!/bin/sh\nprintf 'plain-ok\\n'\n", {
      mode: 0o755,
    });
    await writeFile(join(payload, "data", "value.txt"), PREFIX);
    await writeFile(join(payload, "data", "binary.bin"), binaryData);
    await writeFile(join(payload, "data", "directory.bin"), directoryData);
    await cp(directoryProbe, join(payload, "bin", "directory-probe"));
    const rewrite = [{ path: "data/value.txt", placeholder: PREFIX, mode: "text" }];
    if (scenario === "cancel" || scenario === "signing-failure") {
      await mkdir(join(payload, "wait"));
      // 多个真实文件形成可观察的改写区间；取消由首个文件内容变化触发，不靠延时猜时序。
      for (let index = 0; index < CANCEL_FILES; index += 1) {
        const path = `wait/${index}.txt`;
        await writeFile(join(payload, path), PREFIX);
        rewrite.push({ path, placeholder: PREFIX, mode: "text" });
      }
    }
    rewrite.push({ path: "data/binary.bin", placeholder: PREFIX, mode: "binary" });
    if (scenario.startsWith("dir-prefix")) {
      rewrite.push({ path: "data/directory.bin", placeholder: PREFIX, mode: "binary-dir-prefix" });
      rewrite.push({
        path: "bin/directory-probe",
        placeholder: PREFIX,
        mode: scenario === "dir-prefix-binary" ? "binary" : "binary-dir-prefix",
      });
    }
    if (scenario === "dir-prefix-too-long") {
      await writeFile(join(payload, "data", "short-directory.bin"), "/短/suffix\0");
      rewrite.push({
        path: "data/short-directory.bin",
        placeholder: "/短",
        mode: "binary-dir-prefix",
      });
    }
    if (scenario === "dir-prefix-invalid") {
      await writeFile(join(payload, "data", "directory.bin"), `${PREFIX}/valid\0${PREFIX}Suffix`);
    }
    if (scenario === "too-long") {
      await writeFile(join(payload, "data", "short.bin"), "/short/suffix\0");
      rewrite.push({ path: "data/short.bin", placeholder: "/short", mode: "binary" });
    }
    if (scenario === "missing")
      rewrite.push({ path: "data/missing.txt", placeholder: PREFIX, mode: "text" });
    if (scenario === "signing-failure") {
      await cp(original, join(payload, "bin", "signing-probe"));
      rewrite.push({ path: "bin/signing-probe", placeholder: PREFIX, mode: "binary" });
    }
    rewrite.push({ path: "bin/probe", placeholder: PREFIX, mode: "binary" });
    rewrite.push({ path: "bin/unchanged", placeholder: `${PREFIX}-not-present`, mode: "binary" });
    const archivePath = join(directory, `${scenario}.tar.gz`);
    const roots = await readdir(payload);
    await createTar({ gzip: true, portable: true, cwd: payload, file: archivePath }, roots);
    const bytes = await readFile(archivePath);
    resources.set(scenario, bytes);
    let installedSizeBytes = 0;
    for (const path of await readdir(payload, { recursive: true })) {
      const file = await stat(join(payload, path));
      if (file.isFile()) installedSizeBytes += file.size;
    }
    const target =
      scenario === "plain"
        ? "bin/plain"
        : scenario.startsWith("dir-prefix")
          ? "bin/directory-probe"
          : "bin/probe";
    manifests.set(scenario, {
      toolId: "qpdf",
      resourceId: `rewrite-${scenario}-${process.arch}`,
      version: "1.0",
      platforms: [{ platform: process.platform, arch: process.arch }],
      binaryArch: process.arch,
      archive: {
        format: "tar.gz",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        path: `archive/${scenario}`,
      },
      installedSizeBytes,
      requiredFiles: [target, "bin/unchanged", "data/value.txt", "data/binary.bin"],
      entries: [{ name: "qpdf", target, args: [], env: [] }],
      runtimeChecks: [
        {
          entry: "qpdf",
          args: [],
          expectedOutput: scenario === "plain" ? "plain-ok" : "rewrite-ok:",
          timeoutMs: 30000,
        },
      ],
      ...(scenario === "plain" ? {} : { rewrite }),
    });
  }
  await writeFile(
    catalogPath,
    JSON.stringify([{ toolId: "qpdf", displayName: "qpdf", resources: [manifests.get("plain")] }]),
  );
  return {
    url,
    cdnBaseUrl: url,
    catalogPath,
    stop: async () => {
      await writeFile(join(directory, "requests.json"), JSON.stringify(requests));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
