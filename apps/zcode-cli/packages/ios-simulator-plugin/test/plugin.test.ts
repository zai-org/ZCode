import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as commands from "../src/lib/run.js";
import * as simulators from "../src/providers/sim.js";
import { app, pickAppProduct } from "../src/providers/build.js";
import { create, discover, source } from "../src/providers/project.js";
import { isIosRuntime, parseSimulators } from "../src/providers/sim.js";

const found = {
  projects: ["Explicit.xcodeproj"],
  workspaces: ["Auto.xcworkspace"],
  schemes: ["AutoScheme"],
  bundleIds: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("discovery reads shared and user schemes without executing project code", async () => {
  const execute = vi.spyOn(commands, "run").mockResolvedValue({
    cmd: [],
    code: 0,
    stdout: JSON.stringify({ workspace: { schemes: ["ZCODE_ID_UID_EXECUTED"] } }),
    stderr: "",
    timed: false,
  });
  await withCwd(async () => {
    await fixtureFile(
      "Project/Probe.xcodeproj/project.pbxproj",
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.probe;",
    );
    await fixtureFile("Project/Probe.xcodeproj/xcshareddata/xcschemes/Shared.xcscheme");
    await fixtureFile(
      "Project/Probe.xcodeproj/xcuserdata/dev.xcuserdatad/xcschemes/Personal.xcscheme",
    );
    await fixtureFile("Project/Probe.xcworkspace/xcshareddata/xcschemes/Workspace.xcscheme");
    await fixtureFile("Project/Probe.xcworkspace/xcshareddata/xcschemes/Shared.xcscheme");
    await fixtureFile("Project/Probe.xcworkspace/xcshareddata/xcschemes/ignored.txt");
    await mkdir("Project/Probe.xcworkspace/xcshareddata/xcschemes/Directory.xcscheme");
    await fixtureFile(
      "Project/LocalPkg/Package.swift",
      'fatalError("discovery must not evaluate manifests")',
    );

    expect(await discover(path.join(process.cwd(), "Project"))).toEqual({
      projects: ["Probe.xcodeproj"],
      workspaces: ["Probe.xcworkspace"],
      schemes: ["Personal", "Shared", "Workspace"],
      bundleIds: ["com.example.probe"],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

test("discovery leaves generated schemes unknown and works without Xcode", async () => {
  const execute = vi.spyOn(commands, "run").mockRejectedValue(new Error("Xcode unavailable"));
  await withCwd(async () => {
    expect(await discover()).toEqual({ projects: [], workspaces: [], schemes: [], bundleIds: [] });
    await fixtureFile(
      "Probe.xcodeproj/project.pbxproj",
      "PRODUCT_BUNDLE_IDENTIFIER = com.example.probe;",
    );
    await fixtureFile(
      "LocalPkg/Package.swift",
      'fatalError("discovery must not evaluate manifests")',
    );
    expect(await discover()).toEqual({
      projects: ["Probe.xcodeproj"],
      workspaces: [],
      schemes: [],
      bundleIds: ["com.example.probe"],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

test.each([undefined, "ExplicitScheme"])(
  "build resolves schemes only when none was supplied (%s)",
  async (scheme) => {
    const execute = vi.spyOn(commands, "run").mockImplementation(async (cmd) => ({
      cmd,
      code: cmd.includes("-list") ? 0 : 1,
      stdout: cmd.includes("-list")
        ? JSON.stringify({ project: { schemes: ["GeneratedScheme"] } })
        : "build stopped by fixture",
      stderr: "",
      timed: false,
    }));
    vi.spyOn(simulators, "boot").mockResolvedValue({
      name: "Test iPhone",
      udid: "TEST",
      state: "Booted",
      runtime: "iOS",
      available: true,
    });
    await withCwd(async () => {
      vi.stubEnv("IOS_SIM_PLUGIN_DATA", path.join(process.cwd(), "plugin-data"));
      await fixtureFile("Probe.xcodeproj/project.pbxproj");
      await mkdir("Auto.xcworkspace");
      const result = await app({
        project: "Probe.xcodeproj",
        scheme,
        bundleId: "com.example.probe",
        derivedDataPath: "DerivedData",
      });
      const expectedScheme = scheme ?? "GeneratedScheme";
      expect(result.source).toEqual({
        flag: "-project",
        file: "Probe.xcodeproj",
        scheme: expectedScheme,
      });
      const listCalls = execute.mock.calls.filter(([cmd]) => cmd.includes("-list"));
      expect(listCalls).toHaveLength(scheme ? 0 : 1);
      if (!scheme)
        expect(listCalls[0]?.[0]).toEqual([
          "xcodebuild",
          "-list",
          "-json",
          "-project",
          "Probe.xcodeproj",
        ]);
      expect(execute.mock.calls.find(([cmd]) => cmd.includes("build"))?.[0]).toEqual(
        expect.arrayContaining(["-scheme", expectedScheme]),
      );
    });
  },
);

async function fixtureFile(file: string, text = "") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test.each([true, false])(
  "build resolves the auto workspace and keeps its fallback local (%s)",
  async (listed) => {
    const execute = vi.spyOn(commands, "run").mockImplementation(async (cmd) => ({
      cmd,
      code: cmd.includes("-list") && listed ? 0 : 1,
      stdout: cmd.includes("-list")
        ? JSON.stringify({ workspace: { schemes: ["WorkspaceScheme"] } })
        : "build stopped by fixture",
      stderr: "",
      timed: false,
    }));
    vi.spyOn(simulators, "boot").mockResolvedValue({
      name: "Test iPhone",
      udid: "TEST",
      state: "Booted",
      runtime: "iOS",
      available: true,
    });
    await withCwd(async () => {
      vi.stubEnv("IOS_SIM_PLUGIN_DATA", path.join(process.cwd(), "plugin-data"));
      await fixtureFile("Unrelated.xcodeproj/xcshareddata/xcschemes/Unrelated.xcscheme");
      await mkdir("Auto.xcworkspace");
      const result = await app({ bundleId: "com.example.probe", derivedDataPath: "DerivedData" });
      expect(result.source).toEqual({
        flag: "-workspace",
        file: "Auto.xcworkspace",
        scheme: listed ? "WorkspaceScheme" : "Auto",
      });
      expect(execute.mock.calls[0]?.[0]).toEqual([
        "xcodebuild",
        "-list",
        "-json",
        "-workspace",
        "Auto.xcworkspace",
      ]);
    });
  },
);

test("source prefers explicit project over auto workspace", () => {
  expect(source({ project: "Explicit.xcodeproj" }, found)).toEqual({
    flag: "-project",
    file: "Explicit.xcodeproj",
    scheme: "Explicit",
  });
});

test("create validates inputs and refuses accidental overwrites", async () => {
  await withCwd(async () => {
    const created = await create({ name: "Counter App", deployment: "17.0" });
    expect(created.project).toBe(path.join("CounterApp", "CounterApp.xcodeproj"));
    expect(created.bundle).toBe("com.example.counterapp");

    await expect(create({ name: "Counter App" })).rejects.toThrow("Refusing to overwrite");
    await expect(create({ name: "Escaped", dir: "../Escaped" })).rejects.toThrow(
      "Path escapes project root",
    );
    await expect(create({ name: "BadDeploy", deployment: "17.0; BAD=1" })).rejects.toThrow(
      "Invalid deployment",
    );
    await expect(create({ name: "BadBundle", bundleId: "com.example.bad_bundle" })).rejects.toThrow(
      "Invalid bundle id",
    );
  });
});

test("build product selection prefers the requested configuration", () => {
  const debug = path.join("DerivedData", "Build", "Products", "Debug-iphonesimulator", "Demo.app");
  const release = path.join(
    "DerivedData",
    "Build",
    "Products",
    "Release-iphonesimulator",
    "Demo.app",
  );

  expect(pickAppProduct([debug, release], "Release")).toBe(release);
  expect(pickAppProduct([debug], "Release")).toBe(debug);
});

test("runtime filtering keeps only iOS simulator runtimes", () => {
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.iOS-18-2")).toBe(true);
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.iPadOS-18-2")).toBe(true);
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-18-2")).toBe(false);
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.watchOS-11-2")).toBe(false);
  expect(isIosRuntime("com.apple.CoreSimulator.SimRuntime.visionOS-2-2")).toBe(false);
});

test("simulator parsing drops non-iOS runtimes and unavailable devices", () => {
  const sims = parseSimulators(
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.tvOS-18-2": [
          { name: "Apple TV", udid: "TV-1", state: "Shutdown", isAvailable: true },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
          { name: "iPhone 16", udid: "IOS-1", state: "Shutdown", isAvailable: true },
          {
            name: "iPhone 15",
            udid: "IOS-2",
            state: "Shutdown",
            availabilityError: "runtime unavailable",
          },
        ],
      },
    }),
  );

  expect(sims).toEqual([
    {
      name: "iPhone 16",
      udid: "IOS-1",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      available: true,
    },
    {
      name: "iPhone 15",
      udid: "IOS-2",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      available: false,
    },
  ]);
  expect(sims.filter((item) => item.available)).toHaveLength(1);
});

async function withCwd(work: () => Promise<void>) {
  const old = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), "ios-plugin-test-"));
  process.chdir(dir);
  try {
    await work();
  } finally {
    process.chdir(old);
    await rm(dir, { recursive: true, force: true });
  }
}
