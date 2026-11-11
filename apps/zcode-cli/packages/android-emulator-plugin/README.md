# Android Emulator Plugin

ZCode plugin for model-driven Android app development.

The package root is the plugin root:

```bash
zcode --plugin-dir /absolute/path/to/android-emulator-plugin
```

When enabled, ZCode loads:

- `.zcode-plugin/plugin.json` for plugin metadata and skill/command paths.
- `.mcp.json` for the stdio MCP server.
- `skills/android-dev/SKILL.md` for the model workflow.
- `commands/android-dev.md` as a convenience slash command.

## ZCode CLI Usage

ZCode bundles this package as the official
`android-emulator@zcode-plugins-official` plugin. Enable the plugin to project
its skill, slash command, and MCP server into the session.
At startup ZCode copies the packaged plugin files into
`~/.zcode/cli/plugins/cache/zcode-plugins-official/android-emulator/0.1.1/`
and runs the MCP server from that cache directory. SEA builds rewrite the
official plugin's ZCode manifest to launch the cached MCP server through ZCode's
internal plugin host, so the server uses the embedded Node.js runtime.
Third-party plugins are not rewritten automatically and keep their own declared
`command`.

Example `~/.zcode/cli/config.json` entry:

```json
{
  "plugins": {
    "enabledPlugins": {
      "android-emulator@zcode-plugins-official": true
    },
    "options": {
      "android-emulator@zcode-plugins-official": {
        "default_avd": "medium_phone",
        "api_level": "35"
      }
    }
  }
}
```

The plugin MCP server name is `android-emulator`. ZCode normalizes that name for
model-visible MCP tools, so the model sees `mcp__android_emulator__<tool>`, for
example `mcp__android_emulator__android_preflight`. The MCP server still
implements the raw MCP tool names such as `android_preflight`; ZCode maps
between the model-visible name and the server tool name.

Use stdio for the normal local workflow. HTTP is only useful if you later wrap
this package as a long-running daemon shared by multiple clients.

## MVP Scope

- Use Android Emulator's desktop window for rendering.
- Create a minimal Kotlin + Jetpack Compose app when no Android project exists.
- Discover Gradle roots, modules, variants, application IDs, and APK outputs.
- Build with Gradle wrapper or Gradle.
- Reuse selected Android devices or emulators by serial, start a new GUI emulator when needed, install, launch, terminate, open URL, screenshot, and read logs through Android SDK tools and ADB.
- Expose optional UI actions through Android SDK ADB and UI Automator commands.

## MCP Tools

- `android_preflight`
- `android_discover_project`
- `android_create_app`
- `android_build_app`
- `android_build_and_run`
- `android_list_devices`
- `android_list_avds`
- `android_start_emulator`
- `android_stop_emulator`
- `android_create_avd`
- `android_install_app`
- `android_launch_app`
- `android_terminate_app`
- `android_open_url`
- `android_screenshot`
- `android_logs`
- `android_ui_status`
- `android_ui_describe`
- `android_ui_resolve`
- `android_ui_tap`
- `android_ui_swipe`
- `android_ui_type_text`
- `android_ui_keyevent`

## Requirements

- macOS or Windows.
- Linux is intentionally unsupported in P0; `android_preflight` reports it as an
  unsupported host.
- Android Studio or Android command-line tools.
- Android SDK platform-tools (`adb`).
- For emulator workflows: Android SDK emulator tools and at least one Android
  Virtual Device.
- For physical-device workflows: a ready USB device with USB debugging enabled
  can be used by serial without an AVD.
- Node.js 24.
- Optional: Gradle on `PATH` so generated projects can create a Gradle wrapper when one is missing.

Use `android_preflight` for diagnostics. When setup is missing, the `android-dev` skill follows `skills/android-dev/INSTALL_ENVIRONMENT.md` for fixed macOS shell or Windows PowerShell setup procedures before returning to MCP tools.

Android SDK path, default AVD, API level, build-tools version, system image
variant/ABI, and JDK major version are configurable through plugin user config.

`android_start_emulator` starts a new GUI Android Emulator and returns its
serial. It does not reuse existing devices or emulators; pass an existing
target's serial directly to install, launch, screenshot, log, or UI tools.

## Development

```bash
pnpm install
pnpm --filter @zcode/android-emulator-plugin typecheck
pnpm --filter @zcode/android-emulator-plugin test
pnpm --filter @zcode/android-emulator-plugin build
```

The Claude-compatible `.mcp.json` and the ZCode manifest both execute
`dist/mcp/server.js` with Node.js. Run the package build after changing
TypeScript sources.

## Extension Points

- `src/providers/project.ts` owns project discovery and creation.
- `src/providers/build.ts` owns Gradle build orchestration.
- `src/providers/avd.ts` and `src/providers/device.ts` own emulator/device lifecycle.
- `src/providers/ui.ts` owns UI automation operations.
