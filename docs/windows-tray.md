# Windows Tray

## Scope

Windows tray support is a desktop-only entry point for the Electron main process. It does not change web, mobile remote control, ZCode Agent, task stream, protocol, relay, or shared-host attachment behavior.

Windows close-to-tray behavior is enabled by default. Users can disable `closeToTrayOnWindows` from Settings when they want the close button to exit through the existing close flow.

## Runtime Behavior

- On Windows, the tray is created after `app.whenReady()`. Linux creation follows the capability checks in [Linux close-to-tray](desktop/linux-close-to-tray.md).
- The tray instance is held by `packages/desktop/src/main/desktopTray.ts` module state so Electron does not garbage collect it.
- Left-click and double-click call `primaryWindowCoordinator.ensurePrimaryWindow("tray-show-current-window")`, reusing the current window restore/create logic.
- The context menu exposes Open ZCode, New Task, Open Workspace, Check for Updates (production only), About, Export Logs, and Quit. Export Logs replaces Clear All Data in the same position; the tray no longer exposes data deletion.
- Task and workspace commands reuse `executeDesktopCommandForApp` and existing `DesktopCommandIds`; no new IPC protocol is introduced.
- Quit calls the existing `app.quit()` path, so `before-quit` confirmation and host process cleanup stay centralized.
- Export Logs reuses `DesktopCommandIds.ExportLogs`, matching the desktop application menu's archive creation and system file reveal. The existing tray command flow restores the primary window before exporting. Labels follow the current application locale through the existing desktop menu translations.
- Windows and supported Linux desktops share this context menu, so both use the same replacement. Other data-cleanup entry points are unchanged.

```text
tray Export Logs → restore primary window → DesktopCommandIds.ExportLogs
                                                      ↓
                                        existing main exportLogs → archive / system file reveal
```

## Close To Tray

`closeToTrayOnWindows` is a Windows desktop-only app setting. It defaults to `true` for new installations.

The release that changes this default performs a one-time migration tracked by `closeToTrayOnWindowsMigrationInitialized`:

- A persisted settings file without the migration marker is treated as a pre-migration installation. Its `closeToTrayOnWindows` value is set to `true` even when the old file contains `false`, because old settings do not record whether that value came from the previous default or an explicit user action.
- The migrated settings and `closeToTrayOnWindowsMigrationInitialized: true` are persisted together. Persistence uses the setting service's serialized update path so it cannot overwrite a concurrent settings update.
- Once the marker is present, the stored `closeToTrayOnWindows` value is authoritative. If the user disables the setting after migration, later reads and upgrades preserve `false`.
- A new installation starts with close-to-tray enabled and is considered migrated. Its first settings write persists the marker together with the user's current choice.

```text
settings read
  |
  +-- migration marker missing --> force close-to-tray on --> persist marker
  |
  +-- migration marker present --> preserve stored true/false
```

When enabled:

- Clicking the Windows close button hides the current window instead of closing it.
- The close-window command and shortcut follow the same `BrowserWindow.close()` path, so they also hide the window.
- The handler does not check whether this is the last window because the current desktop product is single-window.
- Tray left-click, tray double-click, and Open ZCode call `primaryWindowCoordinator.ensurePrimaryWindow("tray-show-current-window")`, which restores hidden or minimized windows before focusing them.
- Launching a second Windows instance also calls `show()` for an existing hidden window before focusing it.
- Explicit quit paths still exit the app. Tray Quit marks an explicit quit request before `app.quit()`, so the close handler does not convert that quit into a hide.
- Auto-update install and relaunch paths keep using the existing force-quit preparation flow and are not affected by the hide setting.

The shared settings schema is the source of truth for the default and migration result. The Settings page and Electron main-process bootstrap use the same `true` fallback so the displayed toggle and close handler cannot disagree while settings are unavailable.

## Verification

- Schema tests cover the new-install default, one-time conversion of legacy `false`, preservation of migrated `false`, and preservation of migrated `true`.
- Setting service tests cover persisting the migration marker and migrated value.
- Desktop lifecycle tests continue to cover hiding only on Windows when the effective setting is enabled and preserving explicit quit behavior.
- Tray menu unit tests cover Windows/Linux, English/Chinese, the absence of Clear All Data, locale refresh, and dispatching Export Logs only after the primary window is ready.
- `feedback/logs/manual-review/pending/windows-tray-export-logs.test.ts` checks the actual Windows tray menu and invokes its native menu callback, verifying a ZIP archive and a system file reveal request. It does not automate clicking the Windows notification area itself; non-Windows hosts skip this case.

The pending case needs no model request. Run it separately with the shared replay fixture to avoid capture-mode credentials:

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/feedback/logs/manual-review/pending/windows-tray-export-logs.test.ts
```

2026-10-09 validation: 53 related unit tests passed, including Windows/Linux menu dispatch; typecheck, E2E typecheck, lint (68 existing warnings), architecture and formatting checks passed. A fresh desktop build passed all 4 macOS Preview help-menu E2E cases and generated real ZIP archives. The Windows tray callback and Windows/Linux native notification-area interaction remain unverified on devices. Export replay evidence: `packages/desktop/.e2e-artifacts/desktop-e2e-20261009044422815-p40172-3ffb6e230eb79c0a/summary.json`.

## Resources

Development reads the tray icon from `packages/desktop/build/icon.ico`.

Packaged builds copy the same ICO into Electron resources as `tray_icon.ico` through `packages/desktop/electron-builder.config.js`; main resolves it from `process.resourcesPath`.

## Compatibility

The tray and close-to-tray behavior are main-process desktop concerns. They do not change web, mobile remote control, task stream delivery, replayable snapshots, relay behavior, or shared-host attachment semantics.
