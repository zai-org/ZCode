import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  preinstalledToolManifestSchema,
  preinstalledToolInstallationSchema,
  resolvePreinstalledToolsRelease,
} from "@zcode/shared/preinstalled-tools";
import { resolvePreinstalledToolPaths, resolvePreinstalledToolsBinDir } from "@zcode/shared/preinstalled-tools/node";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";
import type { ExecutionRequest } from "@zcode/contracts";

const resource = {
  toolId: "libreoffice", resourceId: "libreoffice-26.2.0-darwin-arm64-r1", version: "26.2.0",
  platforms: [{ platform: "darwin", arch: "arm64" }], binaryArch: "arm64",
  archive: {
    format: "tar.gz", sizeBytes: 100, sha256: "a".repeat(64),
    path: "libreoffice/libreoffice-26.2.0-darwin-arm64-r1/libreoffice-26.2.0-darwin-arm64-r1.tar.gz",
  },
  downloadUrls: ["https://cdn.example.com/libreoffice.tar.gz"], installedSizeBytes: 200,
  entries: [{ name: "zcode-soffice", target: "LibreOffice.app/Contents/MacOS/soffice", args: [], env: [] }],
  requiredFiles: ["LibreOffice.app/Contents/MacOS/soffice"],
  runtimeChecks: [{ entry: "zcode-soffice", args: ["--version"], expectedOutput: "LibreOffice 26.2.0", timeoutMs: 30000 }],
};

describe("preinstalled document tool contract", () => {
  it("accepts a complete resource and rejects missing, mistyped and unsafe values", () => {
    expect(preinstalledToolManifestSchema.parse(resource)).toEqual(resource);
    for (const patch of [
      { platforms: [{ platform: "unknown", arch: "arm64" }] },
      { binaryArch: "ia32" },
      { archive: { ...resource.archive, sizeBytes: "100" } },
      { archive: { ...resource.archive, sha256: "bad" } },
      { archive: { ...resource.archive, path: "https://cdn.example.com/libreoffice.tar.gz" } },
      { entries: [{ ...resource.entries[0], target: "../outside" }] },
      { entries: [{ ...resource.entries[0], target: "C:/outside" }] },
      { requiredFiles: [] },
      { requiredFiles: ["not-the-entry"] },
      { runtimeChecks: [] },
      { downloadUrls: [] },
    ]) expect(preinstalledToolManifestSchema.safeParse({ ...resource, ...patch }).success).toBe(false);
  });

  it("validates the fixed per-tool record and keeps releases and tools isolated", () => {
    const dataRoot = join(tmpdir(), ".zcode");
    const paths = (["production", "preview", "development"] as const).map((release) =>
      resolvePreinstalledToolPaths({ dataRoot, release, toolId: "libreoffice" }),
    );
    expect(new Set(paths.map((path) => path.rootDir)).size).toBe(3);
    expect(paths[0]?.recordPath).toBe(join(dataRoot, "preinstalled-tools", "production", "tools", "libreoffice", "installation.json"));
    const other = resolvePreinstalledToolPaths({ dataRoot, release: "production", toolId: "qpdf" });
    expect(other.recordPath).not.toBe(paths[0]?.recordPath);
    expect(other.stagingDir).not.toBe(paths[0]?.stagingDir);
    expect(other.binDir).toBe(paths[0]?.binDir);
    expect(resolvePreinstalledToolsBinDir({ dataRoot, release: "production" })).toBe(paths[0]?.binDir);
    const record = {
      schemaVersion: 1, toolId: "libreoffice", resourceId: resource.resourceId, version: resource.version,
      platform: "darwin", arch: "arm64", installationDir: join(paths[0]!.versionsDir, resource.resourceId),
      installedSizeBytes: resource.installedSizeBytes, requiredFiles: resource.requiredFiles, entries: resource.entries,
      installedAt: "2026-10-28T00:00:00.000Z",
    };
    expect(preinstalledToolInstallationSchema.safeParse(record).success).toBe(true);
    for (const patch of [
      { entries: undefined }, { requiredFiles: [] }, { installationDir: "relative" }, { platform: "plan9" },
      { installationId: "f30db43a-5d2c-434b-a2a0-8297ee2fb45f" },
    ]) expect(preinstalledToolInstallationSchema.safeParse({ ...record, ...patch }).success).toBe(false);
    expect(resolvePreinstalledToolsRelease({ runtimeEnv: "development", productFlavor: "preview" })).toBe("development");
    expect(resolvePreinstalledToolsRelease({ runtimeEnv: "production", productFlavor: "preview" })).toBe("preview");
    expect(resolvePreinstalledToolsRelease({ runtimeEnv: "production", productFlavor: "production" })).toBe("production");
  });

  it.skipIf(process.platform === "win32")(
    "finds entries published and removed after Bash snapshot creation in the same session",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-preinstalled-tools-"));
      const home = join(root, "中文 空格");
      const bin = join(home, "bin");
      await mkdir(bin, { recursive: true });
      const entry = join(bin, "zcode-soffice");
      const adapter = new NodeExecutionAdapter({ outputRootDir: root });
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const request: ExecutionRequest = {
        command: {
          mode: "shell", shellProfile: "posix-bash",
          shellOverride: { dialect: "posix", path: "/bin/bash", display: { name: "bash" }, source: "user-config" },
          command: 'printf "%s\\n%s" "$ZCODE_PREINSTALLED_TOOLS_AVAILABLE" "${PATH%%:*}"',
        },
        cwd: home,
        env: { set: { HOME: home, PATH: bin + delimiter + process.env.PATH, ZCODE_PREINSTALLED_TOOLS_AVAILABLE: "1" } },
        timeoutMs: 10000,
        trace: { sessionId: "preinstalled-tools", attributes: { toolCallId: "before-install" } },
      };
      try {
        const initial = await adapter.run(request);
        expect(initial.exitCode).toBe(0);
        expect(initial.stdout.text.trim()).toBe("1\n" + bin);
        const snapshots = await readdir(join(root, "shell-snapshots"));
        expect(snapshots.some((name) => name.endsWith(".sh"))).toBe(true);
        await writeFile(entry, '#!/bin/sh\nprintf "LibreOffice 26.8.1\\n"\n', { mode: 0o755 });
        for (const name of ["documents", "pdf", "presentations", "spreadsheets"]) {
          const helper = fileURLToPath(new URL(`../../${name}-plugin/scripts/zcode_libreoffice.py`, import.meta.url));
          const continued = await adapter.run({ ...request, command: { ...request.command,
            command: `command -v zcode-soffice; python3 ${quote(helper)} check` } });
          expect(continued.exitCode, continued.stdout.text + continued.stderr.text).toBe(0);
          expect(continued.stdout.text).toContain(entry);
          expect(JSON.parse(continued.stdout.text.split("\n").find((line) => line.startsWith("{"))!).source).toBe("managed");
        }
        await rm(entry);
        const removed = await adapter.run({ ...request, command: { ...request.command, command: 'command -v zcode-soffice || printf "ENTRY_REMOVED"' } });
        expect(removed.stdout.text.trim()).toBe("ENTRY_REMOVED");
        expect(await readdir(join(root, "shell-snapshots"))).toEqual(snapshots);
      } finally {
        await adapter.close();
        await rm(root, { force: true, recursive: true });
      }
    },
  );
});
