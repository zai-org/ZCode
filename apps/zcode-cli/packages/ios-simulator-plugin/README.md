# iOS Simulator Plugin

ZCode plugin for model-driven iOS app development on macOS.

The package root is the plugin root:

```bash
zcode --plugin-dir /absolute/path/to/ios-simulator-plugin
```

When enabled, ZCode loads:

- `.zcode-plugin/plugin.json` for plugin metadata and skill/command paths.
- `.mcp.json` for the stdio MCP server.
- `skills/ios-dev/SKILL.md` for the model workflow.
- `commands/ios-dev.md` as a convenience slash command.

## ZCode CLI Usage

ZCode bundles this package as the official `ios-simulator@zcode-plugins-official`
plugin. Enable the plugin to project its skill, slash command, and MCP server
into the session.
At startup ZCode copies the packaged plugin files into
`~/.zcode/cli/plugins/cache/zcode-plugins-official/ios-simulator/0.1.0/` and
runs the MCP server from that cache directory. SEA builds rewrite the official
plugin's ZCode manifest to launch the cached MCP server through ZCode's internal
plugin host, so the server uses the embedded Node.js runtime. Third-party
plugins are not rewritten automatically and keep their own declared `command`.

Example `~/.zcode/cli/config.json` entry:

```json
{
  "plugins": {
    "enabledPlugins": {
      "ios-simulator@zcode-plugins-official": true
    },
    "options": {
      "ios-simulator@zcode-plugins-official": {
        "default_device": "iPhone 16",
        "ui_backend": "auto"
      }
    }
  }
}
```

The plugin MCP server name is `ios-simulator`. ZCode normalizes that name for model-visible MCP tools, so the model sees `mcp__ios_simulator__<tool>`, for example `mcp__ios_simulator__ios_preflight`. The MCP server still implements the raw MCP tool names such as `ios_preflight`; ZCode maps between the model-visible name and the server tool name.

Use stdio for the normal local workflow. HTTP is only useful if you later wrap this package as a long-running daemon shared by multiple clients.

## MVP Scope

- Use Apple's macOS Simulator app for rendering.
- Create a minimal SwiftUI app when no Xcode project exists.
- Statically discover projects, saved schemes, and bundle identifiers without executing project code.
- Build with `xcodebuild` for iOS Simulator.
- Boot, show, install, launch, terminate, open URL, screenshot, and read logs through `simctl`.
- Expose optional UI actions through an isolated `idb` backend.

## MCP Tools

- `ios_preflight`
- `ios_list_simulators`
- `ios_boot_simulator`
- `ios_show_simulator`
- `ios_discover_project`
- `ios_create_app`
- `ios_build_app`
- `ios_build_and_run`
- `ios_install_app`
- `ios_launch_app`
- `ios_terminate_app`
- `ios_open_url`
- `ios_screenshot`
- `ios_logs`
- `ios_ui_status`
- `ios_ui_tap`
- `ios_ui_swipe`
- `ios_ui_type_text`
- `ios_ui_button`
- `ios_ui_describe`

`ios_discover_project` reads project metadata and saved shared/user `.xcscheme`
file names. It does not run Xcode or evaluate Swift package manifests. Its
`schemes` list may be empty or omit automatically generated schemes.
`ios_build_app` and `ios_build_and_run` resolve generated schemes with Xcode
when no explicit `scheme` is supplied. These build tools execute project code,
including package manifests and build scripts; do not use them just to complete
a project summary. See the [discovery contract](../../../../docs/ios-simulator-project-discovery.md).

## Requirements

- macOS.
- Full Xcode selected by `xcode-select`.
- An installed iOS Simulator runtime.
- Node.js 24.
- Optional: `idb` and `idb-companion` for tap/swipe/type/accessibility UI automation.

Run `ios_preflight` inside a model session to get precise missing setup checks.

## Development

```bash
pnpm install
pnpm --filter @zcode/ios-simulator-plugin typecheck
pnpm --filter @zcode/ios-simulator-plugin build
```

The Claude-compatible `.mcp.json` and the ZCode manifest both execute
`dist/mcp/server.js` with Node.js. Run the package build after changing
TypeScript sources.

## Extension Points

- `src/providers/ui.ts` owns UI automation backend selection. P0 uses `idb`; future implementations can add XcodeBuildMCP or native Accessibility without changing tool names.
- `src/providers/project.ts` owns project discovery and creation.
- `src/providers/build.ts` owns Xcode build/install/launch orchestration.
- `src/providers/sim.ts` owns `simctl` device operations.
