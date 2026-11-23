---
name: android-dev
description: Build, run, inspect, and lightly automate Android apps with the android-emulator MCP tools.
---

# Android Dev

Use this skill when the user wants you to create, modify, build, run, debug, screenshot, or inspect an Android app in the desktop Android Emulator or on a USB-connected Android device.

## ZCode Tool Names

This skill assumes the MCP server is configured in zcode as `android_emulator`. In zcode, MCP tools are exposed to the model as `mcp__android_emulator__<tool>`.

If the server is configured with a different name, use the corresponding visible `mcp__<server>__...` tool names from the active zcode tool list.

## Default Workflow

For a device-list request (including "use adb to list connected devices"), use
`mcp__android_emulator__android_list_devices` or an installed SDK adb outside the
workspace through Shell. No project discovery, build, or environment installation
is needed unless the user asks for it. MCP is optional. Use `android_preflight`
for diagnostics when available. Never execute a workspace adb executable.

1. When using the MCP workflow, call `mcp__android_emulator__android_preflight` first.
   - If the required environment is not ready, follow `INSTALL_ENVIRONMENT.md` before continuing. Missing emulator-only checks do not block a selected ready USB device target.
   - Environment setup is done with the fixed macOS shell or Windows PowerShell procedure in that file; do not improvise unrelated install commands.
   - Do not accept Android SDK licenses, enter passwords, wipe emulator data, or delete AVDs on the user's behalf. Stop and ask the user for those cases.
2. Discover the project with `mcp__android_emulator__android_discover_project`.
   - If no Android project exists and the user wants a new app, call `mcp__android_emulator__android_create_app`.
   - Prefer editing Kotlin/Compose files directly after project creation.
   - `mcp__android_emulator__android_create_app` refuses to overwrite generated files by default; only pass `overwrite: true` after explicit user confirmation.
   - Read `warnings` in the discovery result before building and repair missing `gradle.properties`, `local.properties`, or Gradle wrapper issues.
3. Build and launch with `mcp__android_emulator__android_build_and_run`.
   - Pass `module`, `variant`, or `applicationId` when discovery is ambiguous.
   - Use a selected `serial` when the user wants a specific USB device or emulator. Use `mcp__android_emulator__android_start_emulator` only when a new GUI emulator is needed, then pass its returned `serial` to follow-up tools.
   - Read the returned `output` first for compile errors; use the returned log path only when more detail is needed.
4. Verify the app visually with `mcp__android_emulator__android_screenshot`.
5. For runtime checks, use `mcp__android_emulator__android_open_url`, `mcp__android_emulator__android_launch_app`, `mcp__android_emulator__android_terminate_app`, and `mcp__android_emulator__android_logs`.
6. For UI automation, call `mcp__android_emulator__android_ui_status` first.
   - Prefer `mcp__android_emulator__android_ui_describe` or `mcp__android_emulator__android_ui_resolve` before tapping coordinates.
   - `mcp__android_emulator__android_ui_tap`, `mcp__android_emulator__android_ui_swipe`, `mcp__android_emulator__android_ui_type_text`, and `mcp__android_emulator__android_ui_keyevent` use ADB/UI Automator based backends.
   - If UI automation is unavailable, continue with build/run/screenshot checks and say UI automation is unavailable.

## Tool Notes

- This MVP intentionally uses Android Emulator's own desktop window for rendering. Do not create or expect a custom emulator window.
- `mcp__android_emulator__android_preflight` is a pure diagnostic check. Use `INSTALL_ENVIRONMENT.md` for guided environment setup when it reports missing dependencies.
- The target MCP tools accept `serial` for a specific USB device or emulator and `avd` for the fallback emulator to start only when no target is ready. `mcp__android_emulator__android_start_emulator` starts a new GUI emulator and does not reuse existing targets.
- Android MCP tools provide convenient adb operations, but are optional. Shell can use an installed SDK adb outside the workspace, including operations not covered by MCP. Bash blocks workspace-controlled adb paths; never work around that check using an interpreter or a script wrapper. Normal project builds and scripts remain available.
- `mcp__android_emulator__android_create_app` generates a minimal Kotlin + Jetpack Compose app suitable for model-driven iteration.
- `mcp__android_emulator__android_build_app` only builds. `mcp__android_emulator__android_build_and_run` builds, reuses the selected Android target by serial or starts a GUI emulator when needed, installs, and launches the app.
- Android SDK path, default AVD, API level, build-tools version, system image variant/ABI, and JDK major version come from plugin user config and are exposed to the MCP server as `ANDROID_PLUGIN_*` environment variables.

## Project Requirements

When creating or repairing a project manually, make sure these files exist before building:

- `settings.gradle` or `settings.gradle.kts`
- root `build.gradle` or `build.gradle.kts`
- `app/build.gradle` or `app/build.gradle.kts`
- `gradle.properties` with `android.useAndroidX=true`
- `local.properties` with `sdk.dir=<Android SDK path>` when the SDK is not otherwise discoverable
- a Gradle wrapper (`gradlew` / `gradlew.bat`) or `gradle` available on `PATH`

## Build Troubleshooting

- If Gradle reports `android.useAndroidX property is not enabled`, create or update `gradle.properties` with `android.useAndroidX=true`.
- If `android_preflight` reports `Gradle` as `not found`, follow the quick Gradle fix in `INSTALL_ENVIRONMENT.md`; do not reinstall the Android SDK when Gradle is the only missing check.
- If `android_preflight` reports no AVDs but a USB device is ready, continue by passing that device `serial` to target tools.
- If Gradle cannot find the Android SDK, create `local.properties` in the Android Gradle root with `sdk.dir=<Android SDK path>`.
- If `./gradlew` or `gradlew.bat` is missing, install Gradle and run `gradle wrapper --gradle-version 8.9`, or let `android_build_app` attempt wrapper generation when `gradle` is available.
- If `sdkmanager` or `avdmanager` cannot find Java after installing Homebrew `openjdk@<configured JDK major>`, export the matching `JAVA_HOME` from `INSTALL_ENVIRONMENT.md` and retry. Use the optional symlink step only after user confirmation.
- On Windows, if SDK package installation fails because Android SDK licenses are not accepted, ask the user for explicit approval before running `sdkmanager.bat --licenses`, then retry the same package installation command.
- On Windows, if emulator acceleration is unavailable, ask the user to enable virtualization/WHPX or finish Android Emulator driver setup in Android Studio Device Manager, then rerun `android_preflight`.
- If system image downloads time out, prefer the `default` image first and retry the exact `sdkmanager --install` command with a longer timeout before switching to larger `google_apis` images.

## Extension Point

The Android backend is deliberately isolated. P0 uses Android SDK tools, ADB/UI Automator, and Gradle. Future backends can map the same public operations to Android Studio semantic tools, a UI Automator helper APK, Appium/uiautomator2, or another automation bridge without changing the skill workflow.
