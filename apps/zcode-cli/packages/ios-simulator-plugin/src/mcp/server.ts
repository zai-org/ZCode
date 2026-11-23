#!/usr/bin/env node
import path from "node:path";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { json, fail, image } from "../lib/result.js";
import { inside } from "../lib/path.js";
import { preflight } from "../providers/preflight.js";
import { list, boot, show, install, launch, terminate, url } from "../providers/sim.js";
import { discover, create } from "../providers/project.js";
import { app, runApp } from "../providers/build.js";
import { shot } from "../providers/screenshot.js";
import { logs } from "../providers/logs.js";
import * as ui from "../providers/ui.js";

const target = {
  udid: z
    .string()
    .optional()
    .describe(
      "Simulator UDID. When omitted, the plugin uses a booted or default iPhone simulator.",
    ),
  device: z.string().optional().describe("Simulator device name fragment, for example iPhone 16."),
  runtime: z.string().optional().describe("Runtime name fragment, for example iOS-18."),
};

const build = {
  ...target,
  project: z.string().optional().describe(".xcodeproj path as a relative path."),
  workspace: z.string().optional().describe(".xcworkspace path as a relative path."),
  scheme: z
    .string()
    .optional()
    .describe("Xcode scheme. Automatically selected when it can be discovered."),
  configuration: z.string().optional().describe("Xcode configuration. Defaults to Debug."),
  derivedDataPath: z
    .string()
    .optional()
    .describe("DerivedData path as a relative path. Defaults to the plugin data directory."),
  bundleId: z
    .string()
    .optional()
    .describe("Override to use when build settings cannot resolve the bundle id."),
  openSimulator: z.boolean().optional().describe("Open the macOS Simulator app."),
  timeoutMs: z.number().int().positive().optional().describe("Build timeout in milliseconds."),
};

const server = new McpServer({
  name: "ios-simulator",
  version: "0.1.0",
});

server.registerTool(
  "ios_preflight",
  {
    title: "iOS Preflight",
    description:
      "Check whether macOS, full Xcode, simctl, simulator runtimes, and optional UI backends are available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await preflight())),
);

server.registerTool(
  "ios_list_simulators",
  {
    title: "List iOS Simulators",
    description: "List simulators visible to xcrun simctl.",
    inputSchema: {},
  },
  async () => guard(async () => json(await list())),
);

server.registerTool(
  "ios_boot_simulator",
  {
    title: "Boot iOS Simulator",
    description: "Boot the selected simulator and optionally open the macOS Simulator window.",
    inputSchema: {
      ...target,
      openSimulator: z.boolean().optional(),
    },
  },
  async (args) =>
    guard(async () =>
      json(
        await boot({
          udid: args.udid,
          name: args.device,
          runtime: args.runtime,
          open: args.openSimulator ?? true,
        }),
      ),
    ),
);

server.registerTool(
  "ios_show_simulator",
  {
    title: "Show iOS Simulator",
    description: "Open the macOS Simulator app and optionally focus a specific UDID.",
    inputSchema: {
      udid: z.string().optional(),
    },
  },
  async (args) => guard(async () => json(await show(args.udid))),
);

server.registerTool(
  "ios_discover_project",
  {
    title: "Discover iOS Project",
    description:
      "Statically find .xcodeproj/.xcworkspace files, saved .xcscheme names, and bundle identifiers. Does not run Xcode or evaluate Package.swift. Generated schemes may be absent; do not build merely to complete a project summary.",
    inputSchema: {},
  },
  async () => guard(async () => json(await discover())),
);

server.registerTool(
  "ios_create_app",
  {
    title: "Create SwiftUI App",
    description: "Create a minimal SwiftUI iOS app and Xcode project in the current workspace.",
    inputSchema: {
      name: z.string().min(1),
      bundleId: z.string().optional(),
      dir: z.string().optional(),
      deployment: z.string().optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace existing generated files. Defaults to false."),
    },
  },
  async (args) => guard(async () => json(await create(args))),
);

server.registerTool(
  "ios_build_app",
  {
    title: "Build iOS App",
    description:
      "Build the current or specified Xcode project for iOS Simulator with xcodebuild. Runs project code, including Swift package manifests and build scripts. Use when the user requests building, not merely inspecting or summarizing the project.",
    inputSchema: build,
  },
  async (args) => guard(async () => json(await app(args))),
);

server.registerTool(
  "ios_build_and_run",
  {
    title: "Build and Run iOS App",
    description:
      "Build, install, launch, and show an iOS app in macOS Simulator. Runs project code, including Swift package manifests and build scripts. Use when the user requests building or running, not merely inspecting or summarizing the project.",
    inputSchema: {
      ...build,
      launchArgs: z.array(z.string()).optional(),
    },
  },
  async (args) => guard(async () => json(await runApp(args))),
);

server.registerTool(
  "ios_install_app",
  {
    title: "Install iOS App",
    description: "Install an .app bundle on the selected simulator.",
    inputSchema: {
      ...target,
      appPath: z.string().min(1),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({ udid: args.udid, name: args.device, runtime: args.runtime });
      return json(await install(sim.udid, file(args.appPath)));
    }),
);

server.registerTool(
  "ios_launch_app",
  {
    title: "Launch iOS App",
    description: "Launch an installed app on the selected simulator by bundle id.",
    inputSchema: {
      ...target,
      bundleId: z.string().min(1),
      launchArgs: z.array(z.string()).optional(),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({
        udid: args.udid,
        name: args.device,
        runtime: args.runtime,
        open: true,
      });
      return json(await launch(sim.udid, args.bundleId, args.launchArgs ?? []));
    }),
);

server.registerTool(
  "ios_terminate_app",
  {
    title: "Terminate iOS App",
    description: "Terminate an installed app on the selected simulator by bundle id.",
    inputSchema: {
      ...target,
      bundleId: z.string().min(1),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({ udid: args.udid, name: args.device, runtime: args.runtime });
      return json(await terminate(sim.udid, args.bundleId));
    }),
);

server.registerTool(
  "ios_open_url",
  {
    title: "Open URL in Simulator",
    description: "Open a URL in the selected simulator.",
    inputSchema: {
      ...target,
      url: z.string().min(1).max(2048),
    },
  },
  async (args) =>
    guard(async () => {
      const sim = await boot({
        udid: args.udid,
        name: args.device,
        runtime: args.runtime,
        open: true,
      });
      return json(await url(sim.udid, args.url));
    }),
);

server.registerTool(
  "ios_screenshot",
  {
    title: "Capture iOS Screen",
    description:
      "Capture a PNG screenshot from the selected simulator and return it as MCP image content.",
    inputSchema: {
      ...target,
      path: z.string().optional(),
      openSimulator: z.boolean().optional(),
    },
  },
  async (args) =>
    guard(async () => {
      const pic = await shot(args);
      return image({ simulator: pic.simulator, path: pic.path, bytes: pic.bytes }, pic.data);
    }),
);

server.registerTool(
  "ios_logs",
  {
    title: "Read iOS Simulator Logs",
    description: "Read recent simulator logs, optionally filtered by bundle id.",
    inputSchema: {
      ...target,
      bundleId: z.string().optional(),
      seconds: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await logs(args))),
);

server.registerTool(
  "ios_ui_status",
  {
    title: "iOS UI Backend Status",
    description:
      "Report whether the optional UI automation backend is available. P0 uses idb when available.",
    inputSchema: {},
  },
  async () => guard(async () => json(await ui.status())),
);

server.registerTool(
  "ios_ui_tap",
  {
    title: "Tap iOS Simulator",
    description: "Tap screen coordinates using the optional idb UI backend.",
    inputSchema: {
      ...target,
      x: z.number(),
      y: z.number(),
      duration: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.tap(args))),
);

server.registerTool(
  "ios_ui_swipe",
  {
    title: "Swipe iOS Simulator",
    description: "Swipe between screen coordinates using the optional idb UI backend.",
    inputSchema: {
      ...target,
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      delta: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.swipe(args))),
);

server.registerTool(
  "ios_ui_type_text",
  {
    title: "Type Text in iOS Simulator",
    description: "Enter text into the currently focused control using the optional idb UI backend.",
    inputSchema: {
      ...target,
      text: z.string(),
    },
  },
  async (args) => guard(async () => json(await ui.typeText(args))),
);

server.registerTool(
  "ios_ui_button",
  {
    title: "Press iOS Simulator Button",
    description:
      "Press HOME, LOCK, SIDE_BUTTON, SIRI, or APPLE_PAY using the optional idb UI backend.",
    inputSchema: {
      ...target,
      button: z.enum(["APPLE_PAY", "HOME", "LOCK", "SIDE_BUTTON", "SIRI"]),
      duration: z.number().positive().optional(),
    },
  },
  async (args) => guard(async () => json(await ui.button(args))),
);

server.registerTool(
  "ios_ui_describe",
  {
    title: "Describe iOS Simulator UI",
    description:
      "Return accessibility information for the current screen using the optional idb UI backend.",
    inputSchema: target,
  },
  async (args) => guard(async () => json(await ui.describe(args))),
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

function file(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  return inside(process.cwd(), raw);
}
