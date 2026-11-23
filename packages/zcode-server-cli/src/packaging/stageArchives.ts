import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { create as createTar } from "tar";
import type { ServerTarget } from "../runtime/manifest.js";
import { resolveHostTarCommand } from "./tarCommand.js";

export async function runPackagingCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  if (command === "tar") {
    const [flag, file, ...paths] = args;
    if (flag !== "-czf" || !file || paths.length === 0) {
      throw new Error("POSIX packaging requires tar -czf <archive> <paths...>");
    }
    // Windows chmod 无法保留 POSIX 执行位；必须在归档中按发行布局写权限，
    // 否则 SSH 上传成功后仍在执行 bootstrap 时以 126 失败。portable 同时排除宿主 xattr。
    await createTar(
      {
        cwd,
        file,
        gzip: true,
        portable: true,
        onWriteEntry(entry) {
          const path = entry.path
            .replaceAll("\\", "/")
            .replace(/^(?:\.\/|zcode-server-[^/]+\/)/u, "");
          const executable =
            path === "bin/zcode" ||
            path === "runtime/node" ||
            /^runtime\/tools\/(?:bfs\/bfs|ripgrep\/rg|ugrep\/ugrep)$/u.test(path) ||
            /^runtime\/node_modules\/node-pty\/prebuilds\/[^/]+\/spawn-helper$/u.test(path);
          if (executable && entry.type === "File" && entry.stat) entry.stat.mode = 0o755;
        },
      },
      paths,
    );
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // Bug 原因：Windows runner 的 PATH 可能优先命中 Git Bash GNU tar，且系统没有
    // Info-ZIP；Windows zip 继续使用 System32 bsdtar。
    const useWindowsTarForZip = command === "zip" && process.platform === "win32";
    const resolvedCommand = useWindowsTarForZip ? resolveHostTarCommand() : command;
    const commandArgs = useWindowsTarForZip ? ["-acf", ...args.slice(1)] : [...args];
    const child = spawn(resolvedCommand, commandArgs, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `${resolvedCommand} ${commandArgs.join(" ")} exited with code ${code ?? "null"}`,
          ),
        );
    });
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

export async function hashPaths(
  root: string,
  paths: readonly string[],
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(root, relativePath);
    const pathStat = await stat(absolutePath);
    const files = pathStat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const contents = await readFile(join(root, file));
      hash.update(`${file}\0`);
      hash.update(contents);
      sizeBytes += contents.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

export async function createComponentArchive(
  releaseDir: string,
  outputDir: string,
  target: ServerTarget,
  id: string,
  paths: readonly string[],
): Promise<{ archivePath: string; sha256: string; sizeBytes: number }> {
  const info = await hashPaths(releaseDir, paths);
  const componentRoot = join(outputDir, ".components", `${id}-${info.sha256.slice(0, 12)}`);
  await rm(componentRoot, { force: true, recursive: true });
  await mkdir(componentRoot, { recursive: true });
  for (const relativePath of paths) {
    const source = join(releaseDir, relativePath);
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(componentRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { recursive: true, dereference: true });
  }
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  const archivePath = join(outputDir, "components", target, `${id}-${info.sha256}.${extension}`);
  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  if (extension === "zip") {
    await runPackagingCommand("zip", ["-qr", archivePath, "."], componentRoot);
  } else {
    await runPackagingCommand("tar", ["-czf", archivePath, "."], componentRoot);
  }
  await rm(componentRoot, { force: true, recursive: true });
  return { archivePath, ...info };
}
