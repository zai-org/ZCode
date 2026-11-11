#!/usr/bin/env node
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { json, fail, image } from "../lib/result.js";
import { preflight } from "../providers/preflight.js";
import { discover, create } from "../providers/project.js";
import { buildApp, buildAndRun } from "../providers/build.js";
import { listDevices } from "../providers/device.js";
import { createAvd, listAvds, startEmulator, stopEmulator } from "../providers/avd.js";
import { install, launch, openUrl, terminate } from "../providers/app.js";
import { shot } from "../providers/screenshot.js";
import { logs } from "../providers/logs.js";
import * as ui from "../providers/ui.js";

const target = {
  serial: z
    .string()
    .optional()
    .describe(
      "Android device or emulator serial number. When omitted, the plugin uses a ready device/emulator or starts one when needed.",
    ),
  avd: z
    .string()
    .optional()
    .describe("Android Virtual Device name, used when an emulator needs to be started."),
  timeoutMs: z.number().int().positive().optional().describe("Operation timeout in milliseconds."),
};

const emulatorStart = {
  avd: z.string().optional().describe("Android Virtual Device name to start."),
  timeoutMs: z.number().int().positive().optional().describe("Startup timeout in milliseconds."),
};

const build = {
  ...target,
  projectDir: z.string().optional().describe("Android Gradle project root as a relative path."),
  module: z.string().optional().describe("Gradle module. Defaults to the discovered app module."),
  variant: z.string().optional().describe("Build variant. Defaults to debug."),
  applicationId: z
    .string()
    .optional()
    .describe("applicationId override to use when automatic discovery cannot resolve the app ID."),
};

const server = new McpServer({
  name: "android-emulator",
  version: "0.1.1",
});

server.registerTool(
  "android_preflight",
  {
    title: "Android Preflight",
    description:
      "Check whether the Android SDK, adb, emulator, AVDs, Java, Gradle project state, and ADB/UI Automator automation are available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await preflight())),
);

server.registerTool(
  "android_discover_project",
  {
    title: "Discover Android Project",
    description:
      "Find the Gradle root, modules, variants, app ID, manifest, and APK outputs in the current project.",
    inputSchema: {},
  },
  async () => guard(async () => json(await discover())),
);

server.registerTool(
  "android_create_app",
  {
    title: "Create Android App",
    description:
      "Create a minimal Kotlin and Jetpack Compose Android app in the current workspace.",
    inputSchema: {
      name: z.string().min(1),
      packageName: z.string().optional(),
      dir: z.string().optional(),
      minSdk: z.number().int().positive().optional(),
      compileSdk: z.number().int().positive().optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace existing generated files. Defaults to false."),
    },
  },
  async (args) => guard(async () => json(await create(args))),
);

server.registerTool(
  "android_build_app",
  {
    title: "Build Android App",
    description: "Build the current or specified Android Gradle project.",
    inputSchema: build,
  },
  async (args) => guard(async () => json(await buildApp(args))),
);

server.registerTool(
  "android_build_and_run",
  {
    title: "Build and Run Android App",
    description:
      "Build the Android app, reuse a ready device/emulator or start a GUI emulator on demand, then install and launch the app.",
    inputSchema: {
      ...build,
      launchActivity: z.string().optional(),
    },
  },
  async (args) => guard(async () => json(await buildAndRun(args))),
);

server.registerTool(
  "android_list_devices",
  {
    title: "List Android Devices",
    description: "List devices and emulators visible to adb.",
    inputSchema: {},
  },
  async () => guard(async () => json(await listDevices())),
);

server.registerTool(
  "android_list_avds",
  {
    title: "List Android Emulators",
    description: "List Android Virtual Devices visible to the emulator command.",
    inputSchema: {},
  },
  async () => guard(async () => json(await listAvds())),
);

server.registerTool(
  "android_start_emulator",
  {
    title: "Start Android Emulator",
    description:
      "Start a new GUI Android emulator for the specified AVD. To reuse an existing device or emulator, pass its serial to build, install, launch, screenshot, log, or UI tools.",
    inputSchema: emulatorStart,
  },
  async (args) => guard(async () => json(await startEmulator(args))),
);

server.registerTool(
  "android_stop_emulator",
  {
    title: "Stop Android Emulator",
    description: "Stop the selected Android emulator by serial number.",
    inputSchema: {
      serial: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await stopEmulator(args))),
);

server.registerTool(
  "android_create_avd",
  {
    title: "Create Android Emulator",
    description:
      "Create an Android Virtual Device with avdmanager. Confirm SDK package and license configuration with the user first.",
    inputSchema: {
      name: z.string().optional(),
      packageId: z.string().optional(),
      device: z.string().optional(),
      force: z.boolean().optional(),
    },
  },
  async (args) => guard(async () => json(await createAvd(args))),
);

server.registerTool(
  "android_install_app",
  {
    title: "Install Android App",
    description: "Install an APK on the selected Android device or emulator.",
    inputSchema: {
      ...target,
      apkPath: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await install(args))),
);

server.registerTool(
  "android_launch_app",
  {
    title: "Launch Android App",
    description: "Launch an installed Android app by application ID.",
    inputSchema: {
      ...target,
      applicationId: z.string().min(1),
      activity: z.string().optional(),
    },
  },
  async (args) => guard(async () => json(await launch(args))),
);

server.registerTool(
  "android_terminate_app",
  {
    title: "Stop Android App",
    description: "Force-stop an installed Android app by application ID.",
    inputSchema: {
      ...target,
      applicationId: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await terminate(args))),
);

server.registerTool(
  "android_open_url",
  {
    title: "Open URL on Android",
    description: "Open a URL on the selected Android device or emulator.",
    inputSchema: {
      ...target,
      url: z.string().min(1).max(2048),
    },
  },
  async (args) => guard(async () => json(await openUrl(args))),
);

server.registerTool(
  "android_screenshot",
  {
    title: "Capture Android Screen",
    description:
      "Capture a PNG screenshot from the selected Android device or emulator and return it as MCP image content.",
    inputSchema: {
      ...target,
      path: z.string().optional(),
    },
  },
  async (args) =>
    guard(async () => {
      const pic = await shot(args);
      return image({ device: pic.device, path: pic.path, bytes: pic.bytes }, pic.data);
    }),
);

server.registerTool(
  "android_logs",
  {
    title: "Read Android Logs",
    description: "Read recent logcat output, optionally filtered by application ID.",
    inputSchema: {
      ...target,
      applicationId: z.string().optional(),
      lines: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await logs(args))),
);

server.registerTool(
  "android_ui_status",
  {
    title: "Android UI Backend Status",
    description: "Report whether the Android UI automation backend is available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await ui.status())),
);

server.registerTool(
  "android_ui_describe",
  {
    title: "Describe Android UI",
    description: "Return a compact UI Automator element tree for the current Android screen.",
    inputSchema: target,
  },
  async (args) => guard(async () => json(await ui.describe(args))),
);

server.registerTool(
  "android_ui_resolve",
  {
    title: "Resolve Android UI Element",
    description:
      "Resolve a text, content description, resource id, or class query to screen coordinates.",
    inputSchema: {
      ...target,
      query: z.string().min(1),
    },
  },
  async (args) => guard(async () => json(await ui.resolve(args))),
);

server.registerTool(
  "android_ui_tap",
  {
    title: "Tap Android Emulator",
    description: "Tap screen coordinates using Android UI automation.",
    inputSchema: {
      ...target,
      x: z.number(),
      y: z.number(),
    },
  },
  async (args) => guard(async () => json(await ui.tap(args))),
);

server.registerTool(
  "android_ui_swipe",
  {
    title: "Swipe Android Emulator",
    description: "Swipe between screen coordinates using Android UI automation.",
    inputSchema: {
      ...target,
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      durationMs: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.swipe(args))),
);

server.registerTool(
  "android_ui_type_text",
  {
    title: "Type Text on Android",
    description: "Enter text into the currently focused Android control.",
    inputSchema: {
      ...target,
      text: z.string(),
    },
  },
  async (args) => guard(async () => json(await ui.typeText(args))),
);

server.registerTool(
  "android_ui_keyevent",
  {
    title: "Press Android Key",
    description:
      "Press BACK, HOME, ENTER, APP_SWITCH, MENU, or SEARCH on the selected Android device.",
    inputSchema: {
      ...target,
      key: z.enum(["BACK", "HOME", "ENTER", "APP_SWITCH", "MENU", "SEARCH"]),
    },
  },
  async (args) => guard(async () => json(await ui.keyevent(args))),
);

export async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  await main();
}

async function guard(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
