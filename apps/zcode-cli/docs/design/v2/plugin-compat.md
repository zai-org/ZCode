# Claude Plugin Compatibility

## Goal

ZCode should load a bounded subset of Claude Code format plugins while keeping
ZCode's runtime boundaries. The plugin ecosystem remains file-compatible with
Claude Code where possible, but ZCode P0 only projects plugin-provided skills,
custom commands, MCP servers, hooks and agents into existing ZCode capability
domains. Hooks from every enabled plugin, including third-party Marketplace
plugins, are injected into the runtime. Per-plugin trust is not implemented yet;
the decision lives in `canRunPluginHooks` of the adapters plugin loader.

This feature started as first-party packaged capabilities such as the iOS
Simulator and Android Emulator plugins. Claude Code Marketplace compatibility
extends the installation and discovery model, but it is still not a new arbitrary
extension runtime. High-risk Claude plugin features are recognized and diagnosed
before ZCode grows a matching runtime.

See also `docs/claude-code-marketplace-plugin-compat.md` for the Marketplace
implementation plan and phased V1a/V1b/V1c scope.

Official plugins are built as workspace packages, including
`packages/browser-use-plugin`, `packages/ios-simulator-plugin`,
`packages/android-emulator-plugin`, and content-only packages such as
`packages/document-skills-plugin`, `packages/skill-creator-plugin`,
`packages/zcode-guide-plugin`, and `packages/restore-legacy-sessions-plugin`,
but runtime plugin loading does not execute from those workspace paths and does
not import plugin code into the ZCode app bundle. ZCode seeds first-party plugin
files into the official plugin cache under
`~/.zcode/cli/plugins/cache/zcode-plugins-official/...` and executes plugin MCP
servers from that cache. Users only enable or disable each capability.

The Android Emulator plugin P0 supports macOS and Windows only. Linux hosts are
intentionally unsupported for now; `android_preflight` must report the host OS as
unsupported instead of attempting a partial setup or emulator launch.

The Android Emulator plugin treats USB devices and emulators as Android targets.
Install, launch, screenshot, log, and UI automation tools accept a `serial` for
either target kind. `android_start_emulator` is emulator-only: it starts a new
GUI Android Emulator for the selected AVD and returns the new serial. It must not
silently reuse an existing target; follow-up operations reuse an existing USB
device or emulator by passing its `serial` directly to build, install, launch,
screenshot, log, or UI automation tools. Target tools without `serial` may pick a
ready Android target, then start a GUI Android Emulator only when no target is
ready. P0 does not expose a user-configurable UI backend; UI automation uses
Android SDK `adb` and UI Automator commands.

## Marketplace classification

The catalog's optional `publisherType` (`official` or `community`) describes who
maintains a plugin within the ZCode marketplace. It does not grant trust or
change installation identity, paths, or user/workspace configuration. Personal
marketplaces remain personal regardless of their self-declared publisher type.

Catalog `componentTypes` may advertise `ui` before installation. Installed UI
capability comes from validated manifest `ui.surfaces`, including when disabled;
`plugins/listUiSurfaces` continues to return only enabled entries. Store listing
`category` remains the independent usage category. See the market interaction
spec in the root `docs/plugins/` directory for presentation and scope semantics.

## Storage Layout

ZCode stores plugin state under the CLI storage root:

```text
~/.zcode/cli/plugins/
  installed_plugins.json
  marketplaces/
    zcode-plugins-official/
      marketplace.json
  cache/
    zcode-plugins-official/
      android-emulator/
        0.1.0/
          .zcode-plugin/plugin.json
          .claude-plugin/plugin.json
          .mcp.json
          skills/
          commands/
      ios-simulator/
        0.1.0/
          .zcode-plugin/plugin.json
          .claude-plugin/plugin.json
          .mcp.json
          skills/
          commands/
      browser-use/
        0.3.0/
          .zcode-plugin/plugin.json
          skills/
          docs/
      document-skills/
        0.1.4/
          .zcode-plugin/plugin.json
          agents/
          skills/
      skill-creator/
        0.1.0/
          .zcode-plugin/plugin.json
          skills/
      restore-legacy-sessions/
        0.1.0/
          .zcode-plugin/plugin.json
          skills/
          commands/
  data/
    android-emulator@zcode-plugins-official/
    ios-simulator@zcode-plugins-official/
    restore-legacy-sessions@zcode-plugins-official/
```

`cache` contains plugin code and static assets. It is version-scoped and can be
replaced when a plugin is updated. `data` is a persistent per-plugin directory
for MCP servers and tools. Plugin data survives cache replacement and is removed
only when the final installation is removed.

## Uninstall And Teardown

Uninstalling a plugin is a thorough teardown so that a later reinstall starts
clean. Removing a plugin by id (`<name>@<marketplace>`) tears down every piece of
durable state ZCode created for it:

1. The plugin record in `installed_plugins.json`.
2. The version-scoped cache directory at the record's `installPath`
   (`cache/<marketplace>/<name>/<version>/`).
3. The persistent per-plugin data directory `data/<sanitized-plugin-id>/`,
   including any `generated-commands/` ZCode materialized for the plugin. This is
   the "final installation is removed" case from the storage layout: data is kept
   across cache replacement on update, but uninstall deletes it.
4. The plugin's user config entries `plugins.enabledPlugins[id]` and
   `plugins.options[id]` in the user `config.json`. After uninstall there is no
   stale enable flag or saved option left behind.

Teardown is centralized so all entry points behave identically. The filesystem
deletions (record, cache, data) belong to the plugins adapter; the config-entry
deletion belongs to the config adapter. `bootstrap` orchestrates the two adapters
for one uninstall. No layer above the adapters touches the filesystem directly.

Component registration (skills, commands, hooks, MCP servers) is recomputed from
`installed_plugins.json` on every discovery pass, so removing the record plus its
directories de-registers the plugin's capabilities on the next session start.
There is no separate unregister step.

Uninstall is idempotent: removing a plugin id that is not installed is a no-op
that reports nothing was removed, rather than an error.

The built-in marketplace name is `zcode-plugins-official`.

External Claude Marketplace sources use `.claude-plugin/marketplace.json` as
their canonical manifest location. ZCode may normalize the fetched marketplace
manifest into `~/.zcode/cli/plugins/marketplaces/{marketplace}/marketplace.json`
for local bookkeeping, but add/update must read `.claude-plugin/marketplace.json`
first and only use a root `marketplace.json` fallback for local legacy data.

Startup must seed bundled official plugins before plugin discovery:

```text
packages/android-emulator-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/android-emulator/0.1.0/
packages/ios-simulator-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/ios-simulator/0.1.0/
packages/browser-use-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/0.3.0/
packages/document-skills-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/document-skills/0.1.4/
packages/restore-legacy-sessions-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/restore-legacy-sessions/0.1.0/
packages/skill-creator-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/skill-creator/0.1.0/
packages/zcode-guide-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.3.0/
```

`packages/bundled-skills/` is deliberately absent from this list: it is the CLI's
built-in skill pack, not a plugin (see `skill.md`, "bundled skill pack"). It is
never seeded into the official plugin cache, never listed in the marketplace
partition, and cannot be disabled or uninstalled.

SEA releases embed the same files as SEA assets and extract them to the same
official cache path on first startup or when the embedded plugin hash changes.
The MCP command must point at the seeded cache directory, not the source
workspace and not a module compiled into the ZCode SEA main bundle.

Seeding replaces one plugin version directory only while it holds the seed lock
for that version. It writes the new tree to a unique `<version>.tmp-*` sibling.
It moves the old target to a unique `<version>.backup-*` sibling, then renames
the temporary tree to the target, so a failed promotion can restore the old
target. A directory rename can return `EXDEV` inside one parent directory when
the old target is in a lower layer of an overlay filesystem (for example, a
container image that already contains the plugin cache). In that case, seeding
deletes the seed marker of the old target first, deletes the old target, and
then promotes the temporary tree. Because the marker goes first, an interrupted
deletion cannot leave a partial tree that looks current; the next startup seeds
it again.

A seed failure that ZCode cannot complete degrades only the affected plugin:
transient errors after the retry budget, a seed lock timeout, `ENOENT` after a
concurrent writer already promoted a current tree, and `EXDEV`. ZCode logs
`Official plugin cache operation degraded`, keeps a usable older cache when one
exists, and does not fail session startup or session resume. `EXDEV` is not
retried, because it does not go away on retry.

For bundled official plugins only, ZCode rewrites the seeded
`.zcode-plugin/plugin.json` MCP server command at seed time. The rewritten
command launches the current ZCode executable through the hidden
`__zcode-plugin-host` entrypoint and asks it to import the cached MCP server file
and call its exported `main()` function. In a SEA build this means the official
plugin MCP servers run on the SEA-embedded Node.js runtime, but each server
module is still loaded from
`~/.zcode/cli/plugins/cache/zcode-plugins-official/...`.

The CLI main entry dispatches `__zcode-plugin-host` before importing the Agent
command runner or provider initialization. It retains environment sanitization,
SEA runtime tool preparation, product broker authorization, argument forwarding,
and the existing success/failure shutdown policy. Hosted server arguments are
not interpreted as Agent/provider options. Desktop Electron Node, ordinary Node
CLI and SEA use this same branch; no separate plugin execution engine is added.

This runtime host is not automatically projected to third-party plugins. Inline
and external plugins keep their manifest-provided `command` and `args`; if a
third-party plugin explicitly opts into the hidden host, it is treated like any
other local command in the existing plugin trust model.

## Plugin Identity

A plugin id is:

```text
<plugin-name>@<marketplace>
```

Session/local development plugin directories use the marketplace `inline`, for
example `ios-simulator@inline`. Official bundled plugins use
`zcode-plugins-official`.

The bundled official capabilities use these ids:

```text
android-emulator@zcode-plugins-official
browser-use@zcode-plugins-official
document-skills@zcode-plugins-official
ios-simulator@zcode-plugins-official
restore-legacy-sessions@zcode-plugins-official
skill-creator@zcode-plugins-official
zcode-guide@zcode-plugins-official
```

P0 enablement is config-driven:

```json
{
  "plugins": {
    "enabled": true,
    "dirs": ["/absolute/path/to/plugin"],
    "enabledPlugins": {
      "android-emulator@zcode-plugins-official": true,
      "ios-simulator@zcode-plugins-official": true,
      "restore-legacy-sessions@zcode-plugins-official": true
    },
    "options": {
      "android-emulator@zcode-plugins-official": {
        "default_avd": "medium_phone",
        "api_level": "35"
      },
      "ios-simulator@zcode-plugins-official": {
        "default_device": "iPhone 16"
      }
    }
  }
}
```

`dirs` are explicit local plugin roots and default to enabled for the current
configuration unless `enabledPlugins[id]` is `false`. Official cache plugins
default to disabled unless `enabledPlugins[id]` is `true`.

## Manifest Discovery

For a plugin root, ZCode reads the first manifest that exists:

1. `.zcode-plugin/plugin.json`
2. `.claude-plugin/plugin.json`

`.zcode-plugin/plugin.json` intentionally uses the same field names as Claude
Code. P0 supports these fields:

- `name`
- `version`
- `description`
- `author`
- `license`
- `skills`
- `commands`
- `mcpServers`
- `userConfig`

The selected manifest may contain MCP configuration directly in `mcpServers`.
This is the preferred override point when `.zcode-plugin/plugin.json` needs
ZCode-specific runtime wiring while `.claude-plugin/plugin.json` and `.mcp.json`
remain Claude-compatible.

Compatibility levels:

- `run`: projected into an existing ZCode runtime capability.
- `install-time only`: used while installing or resolving plugin state, not as a
  runtime component.
- `diagnostic only`: recognized and reported, but not executed.
- `unsupported`: recognized when possible and reported as unsupported.

Unsupported or diagnostic-only fields are ignored with diagnostics:

- `outputStyles`
- `lspServers`
- `channels`
- `settings`
- marketplace-only metadata not needed at runtime

`agents` declarations without a discovered source file, such as object metadata
or a single-file path, do not produce runtime profiles; directory support is
defined under [Agents](#agents).

`dependencies` is install-time only for Marketplace-installed plugins. It must
not be reported through the legacy `plugin_unsupported_component` warning once
the dependency resolver is enabled.

`marketplace` and `source` are separate model dimensions. `marketplace` is part
of plugin identity (`<plugin-name>@<marketplace>`). `source` describes the local
loading source (`official`, `inline`, `cache`, or a future more specific cache
source). Do not add a `marketplace` value to `PluginSource`.

Marketplace source compatibility:

- `url`, `github`, `git`, `file`, `directory`, and `settings` are recognized.
- `github` and `git` support `ref` and `path`; the default path is
  `.claude-plugin/marketplace.json`.
- `npm`, `hostPattern`, and `pathPattern` are recognized but diagnostic-only in
  P0.

Plugin entry source compatibility:

- Relative paths (`"./plugin"`) and local directory sources are installable.
- `github`, `git`, `url`, and `git-subdir` sources are installable by cloning.
  They support `ref`, `sha`, `commit` as a `sha` fallback, and entry
  `path`/subdirectory installation because the official Claude marketplace uses
  all of those shapes.
- `npm` and `pip` are recognized and diagnosed until their installer paths are
  implemented.

Marketplace source validation is intentionally lighter than plugin validation.
It parses the marketplace manifest, validates entry shape and dependencies, and
deep-scans plugin roots that are already present in the marketplace source
directory. It must not clone every remote entry while validating a marketplace
source: the official Claude marketplace contains hundreds of entries that point
at external git repositories. Remote entry roots are fetched and deep-scanned
only during install or single-plugin validate, with marketplace source validate
returning a deferred diagnostic for those entries.

## Components

### Skills

`manifest.skills` may be a relative path or an array of relative paths. Paths
resolve inside the plugin root and become `SkillRoot` entries with
`source: "plugin"`. The existing `Skill` tool is still responsible for loading
the full `SKILL.md` body on demand.

### Commands

`manifest.commands` may be a relative path or an array of relative paths. Paths
resolve inside the plugin root and become `CustomCommandRoot` entries with
`source: "plugin"`.

Claude command filenames may include `_`, `-`, `:` and nested directory
segments. ZCode keeps those names stable, for example
`commands/clean_gone.md` becomes `/clean_gone`.

P0 also supports a `skills` frontmatter field in markdown commands. When a
custom command declares `skills: ios-dev` or `skills: android-dev`, prompt
expansion tells the model to load that skill before performing the command.

### Agents

ZCode 枚举默认 `agents/*.md` 与 manifest `agents` 字符串或数组声明的插件根内目录。
组件名称优先取 frontmatter `name`，缺失时取文件名；发现结果同时保存实际源文件 `path`。
加载器只读取该路径，不从名称重新拼接文件名，也不为缺少路径的描述性组件猜测文件。
文件读取失败保留 `agent_read_failed` 诊断，不查找替代文件。

已启用插件中的 profile 以 `<plugin-name>:<agent-name>` 加载到子代理运行时；名称无冲突时
同时提供裸名别名。组件仍按名称去重：manifest 对象声明先于文件，默认目录先于额外目录，
重复声明的目录只扫描一次；首次发现的条目保留其来源。对象声明仅提供描述，无源文件路径时
不加载。目录继续使用插件根内路径校验；组件名称不作为路径输入。源路径只用于 CLI 内部，
对外组件详情仍只投影名称与描述。

插件 profile 的 frontmatter `permissionMode` 只能收紧子会话权限，官方与第三方插件同一规则：
子会话取父会话模式与声明模式中更严格的一个（从严到宽为 plan、build、edit、guarded、yolo）。
`bypassPermissions`、`dontAsk` 因此不会生效；`auto` 尚未实现，不参与比较，按继承处理。
加载器保留声明值并给 profile 打 `permissionModeRestrictOnly` 标记，派生子会话时由 core 比较。
规则与威胁边界见 [项目配置信任边界](../../../../../docs/security/deep-link-project-trust-boundary.md)。

### MCP

ZCode loads MCP server config from both:

1. plugin `.mcp.json`
2. `manifest.mcpServers`

`manifest.mcpServers` may be either an inline object or a relative path to an
MCP config file. It is valid inside `.zcode-plugin/plugin.json`, for example:

```json
{
  "name": "ios-simulator",
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "cwd": "${ZCODE_PROJECT_DIR}"
    }
  }
}
```

Manifest `mcpServers` wins on server-name collisions. That means a plugin can
keep a Claude-compatible `.mcp.json` for Claude Code and put a ZCode-specific
MCP command in `.zcode-plugin/plugin.json`.

A `.mcp.json` file may use Claude's wrapper shape:

```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"]
    }
  }
}
```

A plugin MCP server runs once per session by default. Official plugins
(`zcode-plugins-official`) may declare `"isolation": "workspace"` to share one
process among all sessions of a workspace; such a server must keep its own state
apart per session using the host's `_meta.session_id` (the document viewer
plugins do, see `docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md`
§8 in the repository root). ZCode ignores `isolation` on other plugins.

If a server has `command` but no `type`, ZCode infers `type: "stdio"`.
Server names are normalized for model-visible tool names by replacing
non-identifier characters with underscores. A server named `ios-simulator`
therefore exposes tools such as `mcp__ios_simulator__ios_preflight`; a server
named `android-emulator` exposes tools such as
`mcp__android_emulator__android_preflight`.

## Variable Expansion

Plugin component config may reference:

```text
${CLAUDE_PLUGIN_ROOT}
${CLAUDE_PLUGIN_DATA}
${CLAUDE_PROJECT_DIR}
${ZCODE_PLUGIN_ROOT}
${ZCODE_PLUGIN_DATA}
${ZCODE_PROJECT_DIR}
${user_config.KEY}
${GITHUB_TOKEN}
${TOKEN_PLAN_API_TOKEN}
${ZCODE_SOME_ENV}
```

Claude and ZCode variable names are synonyms. MCP secret sinks (`stdio.env`,
HTTP/SSE `headers`, and OAuth `clientSecret`) expand conventional process
environment variable names such as `GITHUB_TOKEN` and `TOKEN_PLAN_API_TOKEN`.
Missing referenced values disable only the affected MCP server and produce a
`plugin_variable_missing` diagnostic instead of forwarding the unresolved
placeholder.

Arbitrary process environment variables are intentionally not expanded in
model-visible or process-list-visible fields such as `command`, `args`, `cwd`,
`url`, OAuth `clientId`, or OAuth `scope`. Existing `ZCODE_*` runtime wiring
variables remain available in those fields for backward compatibility.

`userConfig` defaults are used when no explicit plugin option exists. Sensitive
`userConfig` values follow the same sink boundary: options marked `sensitive`
may only be expanded in MCP secret sinks.

## Trust And Side Effects

Plugin loading itself only reads local files. Starting an MCP server remains a
side effect and goes through the existing MCP trust and permission system.

P0 policy:

- Explicit local plugin dirs are trusted for the current configuration.
- Official cache plugins are loaded only when enabled in config.
- Only bundled official cache plugins are automatically rewritten to the
  internal ZCode/SEA plugin host.
- Project-discovered plugin dirs are out of scope.
- Hook files from every enabled cache plugin, including non-official
  third-party Marketplace plugins, are injected into the runtime. Per-plugin
  trust is not implemented; see `canRunPluginHooks`.

## CLI Surface

P0 CLI commands:

```text
zcode plugins list
zcode plugins enable <plugin-id-or-name>
zcode plugins disable <plugin-id-or-name>
zcode plugins uninstall <plugin-id-or-name> [--force]
```

If a bare name matches exactly one discovered plugin, enable/disable/uninstall
resolves it to that plugin id. Ambiguous names require the full
`<name>@<marketplace>` id.

`uninstall` performs a thorough teardown (see "Uninstall And Teardown"). It is
destructive, so it confirms before acting:

- On an interactive TTY without `--force`, it prints the plugin id and prompts
  `Uninstall <plugin-id>? [y/N]`. Only an affirmative answer proceeds.
- When stdin is not a TTY (pipes, CI) and `--force` is absent, it refuses with a
  non-zero exit and a message telling the caller to pass `--force`. It never
  uninstalls silently in a non-interactive context.
- `--force` skips the prompt in every context, which is the scriptable path.

Uninstall removes only the explicitly named plugin. It does not cascade into
dependency plugins that were installed as part of that plugin's dependency
closure; an orphaned dependency stays installed until it is uninstalled by id.

## TUI Surface

The TUI exposes plugin enablement through the local slash command `/plugins`.
Submitting `/plugins` or `/plugins list` opens a composer selection panel with
one row per discovered plugin. Rows show the current enabled state, plugin id,
source, version, and projected skill/command/MCP counts.

Pressing Enter on a row toggles that plugin by dispatching either
`/plugins enable <plugin-id>` or `/plugins disable <plugin-id>`. The handler
writes only `plugins.enabledPlugins` in the user config and returns a refreshed
selection panel. The current session does not hot-reload plugin-provided skills,
commands, or MCP servers; the changed capability set is picked up by the next
session startup.

`/plugins uninstall <plugin-id-or-name>` performs the same thorough teardown as
the CLI. Because the slash handler is stateless and cannot run an interactive
prompt, it gates the destructive action on an explicit `--force` token:
`/plugins uninstall <plugin> --force`. Without `--force` it returns a
confirmation message describing what will be removed and does not mutate
anything. The marketplace-installed list in the settings UI exposes the same
operation through an Uninstall control with a confirmation dialog.

## Implementation Notes

- `contracts` defines plugin metadata, diagnostics, config, and resolver output.
- `adapters` owns filesystem discovery, manifest parsing, path validation,
  variable expansion, and plugin data directory creation.
- `bootstrap` resolves plugins once per app/session startup and merges component
  roots into existing skill, command, and MCP configuration. It also exposes a
  plugin management facade for local CLI/TUI commands to list plugins and update
  user-configured enablement.
- Official plugin seeding is data-driven from the bundled plugin definition
  list. Adding another official plugin requires a workspace package with a
  `.zcode-plugin/plugin.json`, SEA asset inclusion through the same official
  plugin manifest, Electron/remote asset staging entries, and service-side
  default-enabled mirrors when the plugin is content-only and default-enabled.
  Runtime-backed plugins must also include a Node-built `dist/mcp/server.js`.
  Content-only plugins may omit the MCP runtime. `browser-use` is runtime-backed and must keep
  `dist/mcp/server.js`, `scripts/browser-client.mjs`, both shipped skills, and effective docs in all official
  plugin asset allowlists. Filesystem/SEA seed, Desktop prepare, and production/development remote deployment
  treat these as required assets rather than optional copied files, so an incomplete Browser Use package is
  rejected or redeployed before a session can load it.
- `core` does not import plugin loader code and continues to see normal skills,
  custom commands, and MCP tools.

## Tests

Minimum P0 coverage:

- Prefers `.zcode-plugin/plugin.json` over `.claude-plugin/plugin.json`.
- Loads local plugin `skills`, `commands`, and `.mcp.json`.
- Infers stdio MCP type when `command` is present.
- Expands Claude and ZCode plugin variables.
- Expands arbitrary process environment variables only in MCP secret sinks.
- Keeps arbitrary process environment placeholders unresolved in command,
  argument, working-directory, URL, and non-secret OAuth fields.
- Uses `userConfig` defaults and explicit config options.
- Disables only the affected MCP server when variable expansion fails.
- Ignores hooks with diagnostics.
- Seeds iOS Simulator and Android Emulator as disabled official plugins, then
  projects their skills, commands, MCP servers, user config defaults, and hidden
  plugin host command only after each id is enabled.
- Seeds default-enabled official plugins into CLI SEA, Electron desktop bundle, and remote agent resource layouts.
  Browser Use is runtime-backed and must include and validate `dist/mcp/server.js`,
  `scripts/browser-client.mjs`, `docs/`, and both `skills/`; Document Skills, Skill Creator, and ZCode Guide
  remain content-only.
- CLI list/enable/disable preserves unrelated config.
- CLI uninstall removes the installed record, cache directory, per-plugin data
  directory, and the plugin's `enabledPlugins`/`options` config entries while
  preserving unrelated config; it refuses without `--force` on a non-TTY and is a
  no-op for an unknown plugin id.
- TUI `/plugins` opens a selection panel and toggles plugin enablement.
- TUI `/plugins uninstall` requires `--force` and otherwise returns a
  confirmation message without mutating state.

## Plugin Creator local development marketplace

The bundled plugin-creator follows the local development lifecycle in [the creator spec](../../../../../docs/plugin-creator.md#本地-dev-市场闭环). It prepares source files and a dev marketplace catalog in the selected workspace, then guides the user to add the market, install/update the plugin and try it through the existing UI. A global CLI or Node installation is not a prerequisite. Registration and installation remain owned by the existing plugin services and Host User inventory; project scope is not a separate installation namespace. No new plugin tool, protocol or installation registry is introduced.
