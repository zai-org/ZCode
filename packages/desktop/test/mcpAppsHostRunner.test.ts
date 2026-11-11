import { describe, expect, it } from "vitest";
import {
  parseMcpAppsHostOptions,
  resolveMcpAppsHostLaunch,
} from "../scripts/mcp-apps-host-options.mjs";

describe("MCP App formal regression selection", () => {
  it("uses Xvfb and container-only Chromium flags for isolated Linux replay", () => {
    expect(
      resolveMcpAppsHostLaunch("electron", ["case.cjs"], { ZCODE_E2E_CONTAINER: "1" }),
    ).toEqual({
      command: "xvfb-run",
      args: ["--auto-servernum", "electron", "case.cjs", "--no-sandbox", "--disable-dev-shm-usage"],
    });
    expect(
      resolveMcpAppsHostLaunch("electron", ["case.cjs"], {
        ZCODE_E2E_CONTAINER: "1",
        DISPLAY: ":99",
      }).command,
    ).toBe("electron");
  });

  it("leaves native Electron launches sandboxed", () => {
    expect(resolveMcpAppsHostLaunch("electron", ["case.cjs"], {})).toEqual({
      command: "electron",
      args: ["case.cjs"],
    });
  });
  it("selects only the approved readiness case and preserves its artifact path", () => {
    expect(
      parseMcpAppsHostOptions(["--session-ready-only", "--output-dir", "path with spaces"]),
    ).toEqual({ modes: ["session-ready"], outputDir: "path with spaces", reuseAgentBuild: false });
  });

  it("keeps the existing managed regression group", () => {
    expect(parseMcpAppsHostOptions(["--managed-only", "--reuse-agent-build"])).toEqual({
      modes: ["interaction", "managed", "managed-empty"],
      outputDir: undefined,
      reuseAgentBuild: true,
    });
  });

  it.each([
    ["--session-ready-only", "--managed-only"],
    ["--session-redy-only"],
    ["--session-ready-only", "--output-dir"],
    ["--session-ready-only", "--output-dir", ""],
  ])("rejects ambiguous or invalid selection instead of running the full suite: %j", (...args) => {
    expect(() => parseMcpAppsHostOptions(args)).toThrow();
  });
});
