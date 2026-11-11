import path from "node:path";
import { brief, ok, run } from "../lib/run.js";
import { externalPath } from "../lib/path.js";
import { listAvds } from "./avd.js";
import {
  androidApiLevel,
  androidBuildToolsVersion,
  androidSystemImageAbi,
  androidSystemImageVariant,
  javaMajorVersion,
} from "./config.js";
import { type Device, listDevices } from "./device.js";
import { discover } from "./project.js";
import { androidEnv, checkTool, findTool, javaHome, sdkRoot } from "./sdk.js";

export type Check = {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
};

const ADB_DEVICES_CHECK = "ADB devices";
const READY_TARGET_OPTIONAL_CHECKS = new Set([
  "emulator",
  "avdmanager",
  "Android Virtual Devices",
  "Emulator acceleration",
]);

export function preflightOk(checks: Check[], input: { hasReadyTarget: boolean }): boolean {
  return checks.every(
    (item) =>
      item.ok ||
      item.name === ADB_DEVICES_CHECK ||
      (input.hasReadyTarget && READY_TARGET_OPTIONAL_CHECKS.has(item.name)),
  );
}

export async function preflight() {
  const checks: Check[] = [];
  checks.push({
    name: "Host OS",
    ok: process.platform === "darwin" || process.platform === "win32",
    detail: process.platform,
    fix: "Run this plugin on macOS or Windows for the desktop Android Emulator workflow.",
  });

  const root = await sdkRoot();
  checks.push({
    name: "Android SDK root",
    ok: Boolean(root),
    detail: root || "not found",
    fix: "Install Android Studio or set ANDROID_HOME/ANDROID_SDK_ROOT/ANDROID_PLUGIN_SDK_PATH.",
  });
  checks.push({
    name: "Android plugin defaults",
    ok: true,
    detail: [
      `apiLevel=${androidApiLevel()}`,
      `buildTools=${androidBuildToolsVersion()}`,
      `systemImage=${androidSystemImageVariant()}/${androidSystemImageAbi()}`,
      `jdkMajor=${javaMajorVersion()}`,
    ].join("\n"),
  });

  for (const item of [
    ["adb", ["version"]],
    ["emulator", ["-version"]],
    ["sdkmanager", ["--version"]],
    ["avdmanager", ["list", "avd"]],
  ] as const) {
    const check = await checkTool(item[0], [...item[1]]);
    checks.push({
      name: item[0],
      ok: check.ok,
      detail: check.path ? `${check.path}\n${check.detail}` : check.detail,
      fix: `Install Android SDK ${item[0]} support with Android Studio SDK Manager or command-line tools.`,
    });
  }

  const env = await androidEnv();
  const home = await javaHome();
  const javaCmd = home
    ? await externalPath(
        path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java"),
        "executable",
      )
    : undefined;
  // 缺少可信 JDK 时，裸 java 会再次从工作区解析；直接报告缺失，不尝试执行。
  const java = javaCmd ? await run([javaCmd, "-version"], { timeout: 10_000, env }) : undefined;
  checks.push({
    name: "Java",
    ok: Boolean(java && ok(java)),
    detail: java ? `${home}\n${brief(java, 1000) || "available"}` : "not found",
    fix: "Install a JDK compatible with the Android Gradle Plugin.",
  });

  const project = await discover().catch(() => undefined);
  const gradle = await findTool("gradle");
  checks.push({
    name: "Gradle",
    ok: Boolean(project?.hasWrapper || gradle),
    detail: project?.hasWrapper
      ? "Gradle wrapper found"
      : gradle
        ? `gradle at ${gradle}`
        : "not found",
    fix: "Install Gradle or generate a Gradle wrapper in the Android project root.",
  });

  const emulator = await findTool("emulator");
  if (process.platform === "win32" && emulator) {
    const accel = await run([emulator, "-accel-check"], { timeout: 10_000, env });
    checks.push({
      name: "Emulator acceleration",
      ok: ok(accel),
      detail: brief(accel, 1000) || "available",
      fix: "Enable CPU virtualization/WHPX or finish Android Emulator driver setup in Android Studio Device Manager.",
    });
  }

  const avds = await listAvds().catch((err) => err);
  checks.push({
    name: "Android Virtual Devices",
    ok: Array.isArray(avds) && avds.length > 0,
    detail: Array.isArray(avds)
      ? `${avds.length} AVD(s): ${avds.map((item) => item.name).join(", ")}`
      : String(avds),
    fix:
      "Create an emulator in Android Studio Device Manager or call android_create_avd " +
      "only when no ready USB device target is available.",
  });

  const devices = await listDevices().catch((err) => err);
  const hasReadyTarget = readyDevices(devices).length > 0;
  checks.push({
    name: ADB_DEVICES_CHECK,
    ok: hasReadyTarget,
    detail: Array.isArray(devices)
      ? `${devices.length} device(s): ${devices.map((item) => `${item.serial}:${item.state}`).join(", ")}`
      : String(devices),
    fix: "Start an Android Emulator or connect a device with USB debugging enabled.",
  });

  return {
    ok: preflightOk(checks, { hasReadyTarget }),
    backend: "sdk",
    checks,
  };
}

function readyDevices(value: Device[] | unknown): Device[] {
  return Array.isArray(value) ? value.filter((item) => item.state === "device") : [];
}
