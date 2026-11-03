import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { getRawHeader } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { pruneIncompatiblePlatformPackages } from "../scripts/packaged-platform-dependency-prune.mjs";
import { ASAR_UNPACK_NATIVE_GLOB, replaceAppAsarFromStaging } from "../scripts/app-asar-repack.mjs";

const require = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(require.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);

function runAsar(args: string[]) {
  execFileSync(process.execPath, [asarCliPath, ...args]);
}

function nativeFilesInAsar(asarPath: string) {
  const header = getRawHeader(asarPath).header as { files: Record<string, unknown> };
  const output: string[] = [];
  const visit = (files: Record<string, unknown>, parent = "") => {
    for (const [name, value] of Object.entries(files)) {
      const path = parent ? `${parent}/${name}` : name;
      const entry = value as { files?: Record<string, unknown>; unpacked?: boolean };
      if (entry.files) visit(entry.files, path);
      else if (entry.unpacked) output.push(path);
    }
  };
  visit(header.files);
  return output;
}

describe("packaged platform dependency prune", () => {
  it("removes incompatible packages before repack and drops stale unpacked native files", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "zcode-platform-prune-"));
    try {
      const source = resolve(root, "source");
      const nodeModules = resolve(source, "node_modules/@img");
      const target = resolve(nodeModules, "sharp-win32-x64");
      const otherArch = resolve(nodeModules, "sharp-win32-ia32");
      const otherOs = resolve(nodeModules, "sharp-linux-arm");
      const unrelated = resolve(nodeModules, "colour");
      for (const directory of [target, otherArch, otherOs, unrelated]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(
        resolve(target, "package.json"),
        JSON.stringify({ name: "@img/sharp-win32-x64", os: ["win32"], cpu: ["x64"] }),
      );
      writeFileSync(resolve(target, "sharp.node"), "target-native");
      writeFileSync(
        resolve(otherArch, "package.json"),
        JSON.stringify({ name: "@img/sharp-win32-ia32", os: ["win32"], cpu: ["ia32"] }),
      );
      writeFileSync(resolve(otherArch, "sharp.node"), "wrong-arch-native");
      writeFileSync(
        resolve(otherOs, "package.json"),
        JSON.stringify({ name: "@img/sharp-linux-arm", os: ["linux"], cpu: ["arm"] }),
      );
      writeFileSync(resolve(otherOs, "libvips.dll"), "wrong-os-native");
      writeFileSync(resolve(unrelated, "package.json"), JSON.stringify({ name: "@img/colour" }));
      writeFileSync(resolve(unrelated, "index.js"), "export {};\n");

      const appAsar = resolve(root, "app.asar");
      runAsar(["pack", source, appAsar, "--unpack", ASAR_UNPACK_NATIVE_GLOB]);
      expect(nativeFilesInAsar(appAsar)).toHaveLength(3);

      runAsar(["extract", appAsar, resolve(root, "staging")]);
      const staging = resolve(root, "staging");
      const summary = await pruneIncompatiblePlatformPackages(staging, {
        os: "win32",
        arch: "x64",
      });
      expect(summary.packagesRemoved).toBe(2);
      await replaceAppAsarFromStaging({
        sourceDir: staging,
        appAsarPath: appAsar,
        targetPlatformKey: "win32-x64",
        runAsarCommand: runAsar,
      });

      expect(nativeFilesInAsar(appAsar)).toEqual(["node_modules/@img/sharp-win32-x64/sharp.node"]);
      expect(existsSync(resolve(`${appAsar}.unpacked`, "node_modules/@img/sharp-win32-ia32"))).toBe(
        false,
      );
      expect(existsSync(resolve(`${appAsar}.unpacked`, "node_modules/@img/sharp-linux-arm"))).toBe(
        false,
      );
      expect(
        execFileSync(process.execPath, [asarCliPath, "list", appAsar], {
          encoding: "utf8",
        }).replaceAll("\\", "/"),
      ).toContain("node_modules/@img/colour/index.js");
      expect(
        readFileSync(
          resolve(`${appAsar}.unpacked`, "node_modules/@img/sharp-win32-x64/sharp.node"),
          "utf8",
        ),
      ).toBe("target-native");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
