import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Bug 根因：Windows 上 Agent CLI 只能经过 zcode-runtime-host.exe 启动，而 E2E 只跑
// build:no-runtime-assets，CI 上没有该 exe，全部 case 报 runtime host missing / slash 目录为空。
describe("E2E Windows runtime host preflight", () => {
  it("prepareDesktopAppBuild 在复用或重建桌面产物前确保 runtime host 就绪", () => {
    const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const start = source.indexOf("\nfunction prepareDesktopAppBuild() {");
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);

    const packagedIndex = body.indexOf("E2E_PACKAGED_APP_BINARY_PATH");
    const ensureIndex = body.indexOf("ensureWindowsRuntimeHost();");
    const skipBuildIndex = body.indexOf("shouldReuseDesktopE2EBuild(");
    expect(packagedIndex).toBeGreaterThan(-1);
    expect(ensureIndex).toBeGreaterThan(packagedIndex);
    expect(skipBuildIndex).toBeGreaterThan(ensureIndex);

    expect(source).toMatch(
      /function ensureWindowsRuntimeHost\(\) \{[\s\S]*?scripts\/build-windows-runtime-host\.mjs[\s\S]*?"--if-windows"[\s\S]*?"--ensure"/,
    );
  });
});
