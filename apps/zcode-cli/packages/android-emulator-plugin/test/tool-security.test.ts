import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../src/lib/run.js";
import { androidEnv, checkTool, findTool, javaHome, sdkRoot } from "../src/providers/sdk.js";
import { preflight } from "../src/providers/preflight.js";

const windows = process.platform === "win32";
const originalCwd = process.cwd();
let fixtureRoot: string | undefined;

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "android-tool-security-"));
  fixtureRoot = root;
  const workspace = path.join(root, "workspace");
  const sdk = path.join(root, "sdk");
  const bin = path.join(root, "bin");
  const marker = path.join(root, "executed.txt");
  await Promise.all([workspace, sdk, bin].map((dir) => mkdir(dir)));
  process.chdir(workspace);
  vi.spyOn(os, "homedir").mockReturnValue(root);
  for (const key of [
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "JAVA_HOME",
    "LOCALAPPDATA",
    "ProgramFiles",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("ANDROID_PLUGIN_SDK_PATH", sdk);
  vi.stubEnv("ANDROID_PLUGIN_JDK_MAJOR", "99999");
  vi.stubEnv("PATH", windows ? process.env.SystemRoot + "\\System32" : "/usr/bin:/bin");
  vi.stubEnv("ANDROID_TEST_MARKER", marker);
  if (windows) {
    const payload = path.join(root, "marker.cjs");
    await writeFile(
      payload,
      'require("node:fs").writeFileSync(process.env.ANDROID_TEST_MARKER, "executed"); process.exit(0);',
    );
    vi.stubEnv("NODE_OPTIONS", `--require "${payload}"`);
  }
  return { root, workspace, sdk, bin, marker };
}

async function fakeExecutable(stem: string) {
  const file = windows ? `${stem}.exe` : stem;
  await mkdir(path.dirname(file), { recursive: true });
  if (windows) await copyFile(process.execPath, file);
  else {
    await writeFile(
      file,
      '#!/bin/sh\nprintf executed > "$ANDROID_TEST_MARKER"\nprintf "fake version\\n"\n',
    );
    await chmod(file, 0o755);
  }
  return file;
}

async function trustedExecutable(stem: string) {
  const file = windows ? `${stem}.cmd` : stem;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    windows ? "@echo trusted-tool\r\n" : "#!/bin/sh\nprintf 'trusted-tool\\n'\n",
  );
  await chmod(file, 0o755);
  return file;
}

async function expectNotExecuted(marker: string) {
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

test("SDK tools take priority over workspace and external PATH executables", async () => {
  const { workspace, sdk, bin, marker } = await fixture();
  await fakeExecutable(path.join(workspace, "adb"));
  await fakeExecutable(path.join(bin, "adb"));
  const trusted = await trustedExecutable(path.join(sdk, "platform-tools", "adb"));
  vi.stubEnv("PATH", [".", bin, process.env.PATH].join(path.delimiter));
  const result = await checkTool("adb", ["version"]);
  await expectNotExecuted(marker);
  expect(result).toMatchObject({ ok: true, path: await realpath(trusted), detail: "trusted-tool" });
});

test("PATH lookup skips empty, relative and workspace entries without invoking a locator", async () => {
  const { workspace, bin, marker } = await fixture();
  await fakeExecutable(path.join(workspace, "where"));
  await fakeExecutable(path.join(workspace, "which"));
  await fakeExecutable(path.join(workspace, "audit-tool"));
  const trusted = await trustedExecutable(path.join(bin, "audit-tool"));
  vi.stubEnv("PATH", ["", ".", "subdir", workspace, bin, process.env.PATH].join(path.delimiter));
  const result = await checkTool("audit-tool");
  await expectNotExecuted(marker);
  expect(result.path).toBe(await realpath(trusted));
  const env = await androidEnv();
  expect(env.PATH?.split(path.delimiter)).not.toEqual(
    expect.arrayContaining(["", ".", "subdir", workspace]),
  );
});

test("an external PATH link into the project is never executed", async () => {
  const { root, workspace, marker } = await fixture();
  const fake = await fakeExecutable(path.join(workspace, "audit-tool"));
  const link = path.join(root, "linked-bin");
  if (windows) await symlink(workspace, link, "junction");
  else {
    await mkdir(link);
    await symlink(fake, path.join(link, "audit-tool"));
  }
  vi.stubEnv("PATH", [link, process.env.PATH].join(path.delimiter));
  await checkTool("audit-tool");
  await expectNotExecuted(marker);
  expect(await findTool("audit-tool")).toBeUndefined();
});

test("configured SDK and JDK inside the project are rejected", async () => {
  const { workspace, marker } = await fixture();
  await fakeExecutable(path.join(workspace, "platform-tools", "adb"));
  await fakeExecutable(path.join(workspace, "bin", "java"));
  vi.stubEnv("ANDROID_PLUGIN_SDK_PATH", workspace);
  vi.stubEnv("JAVA_HOME", workspace);
  const resolvedSdk = await sdkRoot();
  expect(resolvedSdk ? await realpath(resolvedSdk) : undefined).not.toBe(await realpath(workspace));
  expect(await javaHome()).toBeUndefined();
  await expectNotExecuted(marker);
});

test("preflight does not execute PATH Java when no valid JDK is available", async () => {
  const { workspace, sdk, marker } = await fixture();
  for (const tool of [
    "platform-tools/adb",
    "emulator/emulator",
    "cmdline-tools/latest/bin/sdkmanager",
    "cmdline-tools/latest/bin/avdmanager",
  ]) {
    await trustedExecutable(path.join(sdk, tool));
  }
  await fakeExecutable(path.join(workspace, "java"));
  vi.stubEnv("PATH", [".", process.env.PATH].join(path.delimiter));
  const result = await preflight();
  await expectNotExecuted(marker);
  expect(result.checks.find((check) => check.name === "Java")).toMatchObject({ ok: false });
});

test("explicit project scripts can still execute", async () => {
  const { workspace } = await fixture();
  const wrapper = await trustedExecutable(path.join(workspace, "gradlew"));
  expect(await run([wrapper], { cwd: workspace })).toMatchObject({
    code: 0,
    stdout: windows ? "trusted-tool\r\n" : "trusted-tool\n",
  });
});

test("Java SDK scripts require a validated JDK instead of running their Java fallback", async () => {
  const { root, workspace, sdk, marker } = await fixture();
  const tool = await trustedExecutable(
    path.join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"),
  );
  await fakeExecutable(path.join(workspace, "java"));
  vi.stubEnv("PATH", [".", process.env.PATH].join(path.delimiter));
  expect(await findTool("sdkmanager")).toBeUndefined();
  const jdk = path.join(root, "jdk");
  const java = path.join(jdk, "bin", windows ? "java.exe" : "java");
  await mkdir(path.dirname(java), { recursive: true });
  if (windows) await copyFile(process.execPath, java);
  else await trustedExecutable(java);
  vi.stubEnv("JAVA_HOME", jdk);
  expect(await javaHome()).toBe(await realpath(jdk));
  expect(await findTool("sdkmanager")).toBe(await realpath(tool));
  await expectNotExecuted(marker);
});

test.runIf(windows)("batch execution never launches workspace cmd.exe", async () => {
  const { workspace, bin, marker } = await fixture();
  await fakeExecutable(path.join(workspace, "cmd"));
  const script = await trustedExecutable(path.join(bin, "tool"));
  expect(await run([script], { cwd: workspace })).toMatchObject({
    code: 0,
    stdout: "trusted-tool\r\n",
  });
  await expectNotExecuted(marker);
});
