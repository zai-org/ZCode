import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAC_ELECTRON_LANGUAGES,
  findMissingMacElectronLocales,
  resolveMacElectronFrameworkResourcesDir,
} from "../scripts/mac-electron-locales.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createPackagedApp(lprojNames: string[]) {
  const root = mkdtempSync(join(tmpdir(), "zcode-mac-locales-"));
  tempDirs.push(root);
  const appPath = join(root, "ZCode.app");
  const resourcesDir = resolveMacElectronFrameworkResourcesDir(appPath);
  mkdirSync(resourcesDir, { recursive: true });
  for (const name of lprojNames) mkdirSync(join(resourcesDir, `${name}.lproj`));
  return resourcesDir;
}

it("保留下来的 en/zh_CN lproj 通过校验", () => {
  const resourcesDir = createPackagedApp(["en", "zh_CN"]);

  expect(findMissingMacElectronLocales(resourcesDir)).toEqual([]);
});

it("lproj 被全部删掉时报出缺失的语言包", () => {
  const resourcesDir = createPackagedApp([]);

  expect(findMissingMacElectronLocales(resourcesDir)).toEqual(["en", "zh_CN"]);
});

it("白名单写成 Windows 的 pak 名时同样报缺失", () => {
  const resourcesDir = createPackagedApp(["en", "zh_CN"]);

  expect(findMissingMacElectronLocales(resourcesDir, ["en-US", "zh-CN"])).toEqual([
    "en-US",
    "zh-CN",
  ]);
});

it("白名单就是打包配置里 mac 段使用的值", async () => {
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.mac?.electronLanguages).toBe(MAC_ELECTRON_LANGUAGES);
});
