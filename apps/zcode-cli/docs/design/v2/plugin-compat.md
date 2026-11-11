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

### Extension summary

Contract: root `docs/plugins/plugin-publishing.md` §4.2–4.3. The CLI passes the
data through and never judges compatibility; only the App knows its plugin API
version.

- Catalog `componentTypes` may advertise `extension`. The CLI passes it through
  to `availablePlugins[].componentTypes` exactly like `ui`. Like `ui`, it is
  only a catalog claim; installed capability comes from the installed manifest.
- A catalog entry may carry `extensionSummary: { engines: { zcode }, grants }`.
  The CLI reads it from the raw entry on every overview (old manifest caches
  need no migration). It keeps the entry only when `engines.zcode` is a
  non-empty string, keeps only string `grants` (default `[]`), and drops every
  other key. It does not validate the range syntax.
- Manifest synthesis for entries without `plugin.json`
  (`createManifestFromMarketplaceEntry`) removes `extensionSummary`, the same
  as the other Store Listing keys. A partial `extension` key must never become
  manifest content.
- Version skew: `zcodePluginStoreListingSchema` and the overview result are
  `.strict()`, and the calling services may be older or newer than the CLI.
  - `runtime/capabilities` declares `pluginExtensionSummary: true`.
  - `plugins/overview` accepts `includeExtensionSummary?: boolean`. Services
    send it only after they see the capability, because old CLIs reject the
    unknown key.
  - Only when the request has `includeExtensionSummary: true` does the CLI put
    the summary into `availablePlugins[].listing.extensionSummary` and
    `installedPlugins[].listing.extensionSummary`. For an installed plugin it
    is the summary of the latest catalog entry. Install, uninstall, update and
    `plugins/resolveSuggestedReference` results never carry it.

Tests: adapters (`parseEntryExtensionSummary`, manifest synthesis strips the
key), bootstrap (`componentTypes` passthrough, overview with and without the
flag, capability bit).

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

`plugins/list` reports this directory as the optional `dataPath` of each plugin
(the same `PluginMetadata.dataPath` that MCP servers and hooks receive as
`${ZCODE_PLUGIN_DATA}`). The App passes it to the plugin's extension as
`ctx.extension.dataPath` (docs/plugins/extension-host.md §18.1 H6) and never
derives the path itself. The CLI does not create the directory when listing;
the extension host creates it before activation.

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
   `plugins.options[id]` in the user `config.json`, and the plugin's entries in
   `plugin-secrets.json` (see Sensitive Option Storage). After uninstall there is
   no stale enable flag, saved option or secret left behind.

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

Since 2026-10-30, Protocol Agent processes do not enable the plugin startup
budget: seed and discovery run to completion, seed lock waits keep their shared
15-second budget, and the process never emits `startup/pluginsDegraded`. A cold
seed of the bundled official plugins measured about 3.0-3.1 seconds on Windows,
so a 3-second budget that includes seed degraded every first start after a
plugin version bump. The budget remains an opt-in owner option; the rest of this
section is its contract when an owner enables it. Re-enabling it in the
Protocol Agent requires moving seed out of the budget or another confirmed scope.

When enabled, the owner gives seed and discovery one shared soft budget per
in-flight batch, including admission waits. If any batch times out, the
process returns an empty plugin outcome with `plugin_startup_timeout` and stops
starting plugin scans until restart. It does not change enabled/suppressed
configuration or installed records, or scan an old cache for this fallback.
Restoring a bundled plugin after cancellation fails before changing suppression.
Existing Runtime snapshots retain their capabilities; new Runtime creation can
continue without plugin skills, commands, MCP servers or hooks.

The owner aborts further work, observes late results, and emits
`startup/pluginsDegraded` for a workspace-scoped UI warning. A directory
publication already in progress must finish or roll back before its lock is
released. The budget cannot cancel an in-flight kernel operation or guarantee
the entire App starts within the budget. Standalone management commands
without this process owner retain their existing contract.

### Android tool lookup security (0.1.1)

The Android plugin keeps the project as its MCP working directory, but that
directory is never a source of SDK tools, Java, or the Windows command interpreter.
SDK installation paths take precedence over PATH. Lookup does not execute
`where` or `which`: it enumerates absolute PATH directories, skips empty and
relative entries, and rejects both lexical paths and real paths inside the
project (including symbolic links and Windows junctions). Candidates must be
regular executable files; SDK/JDK roots must be external directories. Child
PATH entries use the same directory checks. Missing tools report an unavailable
dependency rather than falling back to a bare command name.

Java runs only through the validated JDK's absolute `bin/java` path.
Java-based SDK scripts and system Gradle also require a valid JDK before lookup,
so their own Java fallback cannot reintroduce workspace execution. Windows
batch files use the validated system directory's absolute `System32/cmd.exe`.
An explicitly requested build may still run the project's Gradle wrapper;
project scripts and host dependency discovery remain separate operations.

```text
SDK candidates → absolute PATH entries → external real path → execute
                                             ↓ invalid
                                       skip / report missing
0.1.1 bundle → versioned cache → new MCP process
                    ↓ seed failure
          Android unavailable; no older-version fallback
```

Package, manifest, Bootstrap, SEA, and MCP server versions move together to
0.1.1. Android follows the existing fail-closed cache fallback branch: a failed
update must not reactivate 0.1.0. Existing MCP processes need restarting to use
the fix. iOS behavior is outside this change.

Regression evidence covers workspace fake tools, SDK priority, relative/empty
PATH entries, external links into the workspace, SDK/JDK rejection, missing
Java, Windows interpreter selection, explicit Gradle wrapper execution, and
failed cache promotion with an older Android version present. Tests use harmless
marker files to detect execution. Native Windows validation is recorded separately
from portable path tests.

The normal seeding layout is:

```text
packages/android-emulator-plugin/
  -> ~/.zcode/cli/plugins/cache/zcode-plugins-official/android-emulator/0.1.1/
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

Discovery shares Skill file scans within one query, keyed by root and symbolic
link policy. Counts and component names retain their separate deduplication
rules. Missing materials preserve ENOENT/ENOTDIR without another read, and are
still revalidated before returning. Markdown reads run in batches of at most
four; the material-cache owner also caps active reads across queries at four.
Results keep their original order, and invalidation/disposal prevents queued
stale reads from starting. This does not defer session reference-catalog data.

Discovery 的路径检查由本次查询的 material reader 统一持有。同一路径的并发检查
共享结果，Skill 扫描复用 reader 已取得的文件类型；符号链接拒绝规则保持不变。
插件根目录清单及已读取的子目录清单可排除缺失的标准入口，缺失结论依赖相应父目录，
不再为每个缺失子路径发起独立检查。仅在名称匹配规则确定时使用该优化；大小写等价
名称保留实际路径检查，目录枚举失败也回到原有检查，不把权限错误当成缺失。
返回前仍复核实际文件和父目录；目录新增入口、文件变化或目录替换使本次结果失效，
沿用现有有界重跑。缺失结论不跨查询独立保留，不新增持久化缓存或 watcher。

Filesystem releases compare the installed seed marker's `pluginVersion` with
the official plugin definition and check the cached manifest and required entry
paths. A matching usable version is reused without enumerating or hashing the
source tree, including after a process restart. Resource changes must bump the
plugin package, manifest, official definition and applicable packaging versions.
Same-version edits are not detected automatically, including in development;
remove the corresponding cache or bump the version to rebuild it. Invalidating
the process preparation state only rechecks this contract. Old marker hashes are
ignored for filesystem sources; new filesystem markers omit the hash.
Source files are enumerated only when rebuilding, then each file is read once
for copying. Validate the staged manifest and required paths before publication.

A definition may declare `buildIdentityPath` when its build output embeds a
per-build value that does not change the plugin version. node-repl-host uses
`dist/build-identity.json`, written by its build script, because
`dist/mcp/server.js` embeds the CUA Helper build id. Source preparation reads
only that small file and stores its contents in the marker as `buildIdentity`.
A different value, or a legacy marker without the field, rebuilds the cache like
a version change. A missing source file compares as no identity and does not
block seeding.

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

内置 visualize 默认关闭，并在首次插件配置加载时将旧启用值关闭一次。
迁移完成标记与开关保存在同一配置文件；用户重新开启后不再重置。
只读配置或锁失败只输出告警，本次加载按该层关闭继续合并，不能阻断插件查询或会话装配。
用户级与项目级分别迁移，详见 [Visualize 加载边界](../../../../../docs/specs/visualize-cli-loading.md)。

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

显式声明 `skills` 时，只使用声明路径，不补充默认 `skills/`；空数组表示不加载
技能。只有未声明该字段时，才使用存在的默认 `skills/`。命令等其他组件规则不变。

每个插件技能入口若自身有可加载的 `SKILL.md`，只加载该技能，不再枚举子目录；
否则按技能集合检查一层子目录。字符串和数组均支持这两种目录布局。需要加载单技能
入口下的其他技能时，必须另行声明其路径。路径越界、符号链接拒绝和缺失声明诊断
继续生效；计数、组件详情和运行时加载使用相同规则，用户级及项目级技能扫描不变。

```text
有声明 → 仅声明路径；无声明 → 默认 skills/
入口自身有 SKILL.md → 只加载自身
入口自身无 SKILL.md → 扫描一层子目录
```

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

### External user configuration compatibility

The plugin loader normalizes external `userConfig` entries before they reach runtime
or protocol metadata. Unknown extension fields (for example `options`) are stripped
from the in-memory projection; source and installed manifest files are not rewritten.
Supported fields retain the shared protocol's type validation, including `sensitive`.
An invalid known field rejects only that plugin and emits `plugin_manifest_invalid`
with its plugin ID. Other plugins remain discoverable. App/Agent response schemas
remain strict.

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

## Sensitive Option Storage

> 状态：已实现（扩展进程 P2d，用户决策）。总设计见
> [扩展进程](../../../../../docs/plugins/extension-host.md) §14、§16.7。
> 代码：`adapters/src/config/plugin-secrets.adapter.ts`（文件 I/O 与 schema）、
> `bootstrap/src/plugin-secrets.ts`（叠加、保存、清理规则）。

### 现状与问题

敏感值（`userConfig[key].sensitive === true`）和普通值一起明文写在
`plugins.options[id]` 里：user 层是 `~/.zcode/cli/config.json`，workspace 层是
`<workspace>/.zcode/config.json`（`bootstrap/src/plugins.ts` 的
`resolvePluginConfigPath`）。

- workspace 配置可以进 Git，token 会被提交。
- user 配置常被复制、粘贴、同步，token 会被一起带出去。
- `plugins/list` 投影时已过滤敏感值（`bootstrap/src/zcode-protocol/plugins.ts`），
  但文件本身仍是明文。

### 设计

敏感值只存进一个私有文件，`config.json` 里不再写敏感值。

- 路径：`<cli storage root>/plugin-secrets.json`，即默认的
  `~/.zcode/cli/plugin-secrets.json`。远程工作区的 CLI 在远端主机上，用它自己的文件。
  文件始终与插件存储目录 `plugins/` 同级：调用方覆盖插件存储目录时（测试、嵌入），
  文件跟着放在被覆盖目录的父目录里。
- 写入：`atomicWritePrivateTextFile`（0600），在 `withFileLock` 内读改写。
  Windows 上没有 POSIX 权限位，文件留在用户目录，权限沿用用户目录的 ACL。
- 形状（zod schema 校验）：

```json
{
  "version": 1,
  "user": { "<pluginId>": { "<key>": "<value>" } },
  "workspaces": {
    "<workspace root>": { "<pluginId>": { "<key>": "<value>" } }
  }
}
```

- `<workspace root>` 是 workspace 配置所在目录的绝对路径，即项目配置文件的 baseDir
  （`<dir>/.zcode/config.json` 与 `<dir>/zcode.json` 都是 `<dir>`）。比较规则与
  `normalizePluginConfigPathForComparison` 相同；写入时键存规范化后的路径。
- 读取层与 `config.json` 一一对应：user 层随 user 配置读取（跳过 user 配置时不读）；
  每个被发现的项目配置文件是一个 workspace 层，用它的 baseDir 找私有文件里的条目。
  workspace scope 的 configure 总会写 `<workspace>/.zcode/config.json`（至少留一个空的
  `options[id]`），所以保存过的 workspace 敏感值一定有可被发现的层。

规则：

| 操作                           | 敏感键                                                                                     | 普通键                 |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------- |
| configure（写值）              | 写进私有文件的对应 scope；同一 scope 的 `config.json` 里若有同名键，同一次操作删掉（迁移） | 不变，写 `config.json` |
| configure（`clearOptionKeys`） | 私有文件与 `config.json` 两处都删                                                          | 不变                   |
| 读取（运行时与投影）           | 每个 scope 先读私有文件，再读 `config.json` 的旧明文值；私有文件优先。scope 优先级不变     | 不变                   |
| reset                          | 与 `config.json` 同语义：删除该 scope 下这个插件的条目                                     | 不变                   |
| uninstall                      | 删除 `user` 与全部 `workspaces` 下这个插件的条目                                           | 不变                   |

- **不在启动时迁移**。旧的明文值继续能读；用户下次保存这个插件的设置时，敏感键才迁进
  私有文件。理由：启动时改写 workspace 配置会在用户仓库里产生意外的 diff。
- 键是否敏感以当前清单的 `userConfig` 为准。清单把某个键改成敏感后，旧的明文值仍可读，
  下次保存时迁移。
- 「下次保存」指这个插件在该 scope 的任意一次非 `dryRun` configure：该 scope 的
  `config.json` 里所有按当前清单为敏感的旧明文键都迁走，包括这次请求没带的键。理由：
  UI 不回传敏感值，只保存普通键的请求里本来就没有已存的 secret；只迁请求里的键，旧明文会
  永远留在文件里。`clearOptionKeys` 里的键不迁，直接两处都删。
- 写入顺序：先写私有文件，再改 `config.json`。第二步失败时两处都有值，读取以私有文件为准，
  下次保存再删；不会出现两处都没有的中间态。
- 投影：`plugins/list` 的 `optionSources` 也列出私有文件里的键（scope 标记照旧），设置页的
  scope 标记与「清除」按钮因此不受迁移影响；`configuredOptions` 仍过滤敏感值。
- 私有文件损坏（JSON 或 schema 不符）：`backupCorruptFile` 备份后按空文件处理，发出诊断
  `plugin_secrets_unreadable`（`severity: error`，带文件路径，不含任何值）。受影响的
  MCP server 按现有规则报 `plugin_variable_missing`。其他读取错误（例如权限）在读取路径上
  同样按空处理并发出同一诊断，但不备份；写入路径上向上抛，不覆盖读不出的文件。
  损坏文件在下一次写入时被替换成有效内容（备份留着）。
- 日志、诊断、错误信息里只出现插件 id 与键名，不出现值。

### App 读取扩展设置

扩展进程的 `settings` 能力要拿到本插件的敏感值（用户决策：只给本插件）。
`plugins/list` 继续过滤敏感值，另加一个只读方法：

- `plugins/readUserOptions`，参数 `{ pluginId }`，返回 `{ values: Record<string, string | number | boolean> }`。
- 值是 user 层的有效值：清单默认值，再叠加 user 层选项（含敏感值）。不含 workspace 层：
  扩展只认用户级启用（扩展进程 spec §13）。
- 插件未安装返回 `-32602`（invalid params），`data.code` 为 `plugin_not_found`；旧 CLI 返回
  method-not-found，App 当作「不支持」，扩展只拿到非敏感值。
- 「已安装」指插件出现在 user 视图的插件发现结果里（inline、official、cache 都算）。
  已安装但被禁用的插件照常返回值。参数只有 `pluginId`（strict），不带 workspace：
  扩展是全局的，user 层与工作区无关。
- 只给 App 用，不进模型可见的工具，也不进 debug 日志。
- App 侧只在 Window Host 进程内持有：不挂在 `IZCodeAgentService` 上（该服务整个频道经 RPC 暴露给
  桌面 Renderer 与手机远控），由 `packages/services/src/node.ts` 的 `getPluginUserOptionsReader(services)`
  取出，作为依赖交给扩展网关；网关只把调用方自己插件的值交给它。任何 RPC 频道都调不到这个读取器。
- 收到即处理，不排在串行请求队列之后（与 `plugins/list` 同组）。

### 测试（先写测试再实现）

1. configure 敏感键：值进私有文件，文件权限 0600（非 Windows），`config.json` 里没有该键。
2. 旧明文：`config.json` 里已有的敏感值能被运行时读到；下次 configure 后移进私有文件并从
   `config.json` 删除。
3. 运行时展开：`${user_config.KEY}` 在 MCP secret sink 里读到私有文件的值；非 sink 字段
   仍拒绝。
4. workspace scope：敏感值按 workspace root 存进私有文件，`<workspace>/.zcode/config.json`
   里没有；嵌套 workspace 仍按最内层优先。
5. `plugins/list` 仍过滤敏感值；`plugins/readUserOptions` 返回含敏感值的 user 层有效值。
6. uninstall 与 reset 清掉私有文件里的对应条目。
7. 私有文件损坏：备份、按空处理、发出不含值的诊断。

## Composer Mention Items

> 状态：已实现（扩展进程 P2c）。总设计见
> [扩展进程](../../../../../docs/plugins/extension-host.md) §16.6。
> 代码：`bootstrap/src/zcode-protocol/plugin-mention-items.ts`；线格式在
> `packages/shared/src/zcode-protocol/plugin-host-queries/contract.ts`。

清单 `slots["composer.mention"]` 的 `tool` target 由 CLI 执行。Window Host 读清单、校验条目，
CLI 只负责在会话里调工具、校验结果。CLI 不解析 `slots`。

- 方法：`plugins/mentionItems`，参数 `{ sessionId, pluginId, tool, query }`（strict），
  返回 `{ items }`。`tool` 是插件 MCP server 上的原始工具名（不是模型可见的
  `mcp__…` 名）。`query` 可以是空串，最长 1000 字符。
- 只在内存里的会话上执行：不启动、不恢复会话，也不新建 MCP 连接。会话不在内存 →
  `-32004`（`zcodeProtocolErrorCodes.sessionUnavailable`）。草稿用 App 的预热会话。
- 插件身份取会话创建时冻结的 plugin catalog（`getPluginReferenceCatalog()`）。插件不在
  catalog、未启用、或与同名插件冲突（`conflictingPluginIds` 非空）→
  `plugin_mention_plugin_unavailable`。
- 找工具：按 catalog 里这个插件的 MCP server 名（已排序）依次查会话 tools/list，取第一个有
  `tool` 的 server。都没有 → `plugin_mention_tool_not_found`。工具可见性不含 `app`
  （只给模型的工具）→ `plugin_mention_tool_not_app_visible`。
- 调用：与 MCP App 页面的 `mcp/uiCallTool` 走同一条路径——session facade 的
  `callMcpToolForUi(server, tool, { query })`：工具 schema 校验 → PreToolUse hook → 权限规则 /
  审批（`ToolExecutor.authorizeAppTool`）→ 连接代际复验 → 会话现有 MCP 端口的
  `callTool`（`runtimeScope: "main"`，带会话的 trace）。不另开绕过审批的宿主调用路径。
  参数固定为 `{ query }`；服务器还没连上时按调用失败处理。超时沿用该 server 的 MCP 设置，
  CLI 不另加。不产生 transcript row。
- 审批：MCP 工具一律 `needsApproval`。会话第一次调这个工具时，可能在该会话里弹出审批，
  请求一直等到用户回应（不另设超时）；用户选「始终允许」后，同一会话后续调用不再询问。
  deny 规则、用户拒绝、hook 拒绝（授权链抛 `permission_denied`，或 `permission_escalation`）→
  `plugin_mention_tool_denied`。每次查询都会跑 PreToolUse hook。
- 结果：`isError: true` 或调用抛出其他错误 → `plugin_mention_tool_failed`。
  `structuredContent.items` 按严格 schema 校验，不符 → `plugin_mention_result_invalid`：

| 字段          | 规则                      |
| ------------- | ------------------------- |
| `items`       | 数组，最多 50 项          |
| `id`          | 必填，1–200 字符          |
| `label`       | 必填，1–120 字符          |
| `description` | 可选，最多 500 字符       |
| `icon`        | 可选，1–100 字符          |
| `insertText`  | 必填，1–4000 字符         |
| 其他字段      | 拒绝（条目对象是 strict） |

- 错误形态：`ProtocolRequestError`，`data.code` 是上面的稳定码。引用类错误
  （`plugin_unavailable`、`tool_not_found`、`tool_not_app_visible`）用 `-32602`；执行类错误
  （`tool_denied`、`tool_failed`、`result_invalid`）用 `-32000`。错误信息只含插件 id、server 名、
  工具名与 schema 路径，不含 query、拒绝原因与工具返回的内容。
- 不设计取消。App 每次查询带递增的 `seq`，只采用最新一次的结果；过期的请求照常跑完
  （等待审批的请求也照常等待，回应后按结果返回）。
- 收到即处理，不排在串行请求队列之后（与 `plugins/list` 同组）。
- 日志：每次调用一条 `debug`（插件 id、工具名、server 名、耗时、项数或错误码），不记 query
  与结果。理由：按键级频率，按根规则走 `debug`。
- 旧 CLI 返回 method-not-found，App 不显示这一组。

测试（先写测试再实现）：

1. 会话不在内存 → `-32004`，不调任何工具。
2. 插件不在 catalog、未启用、名字冲突 → `plugin_mention_plugin_unavailable`。
3. 工具不存在 → `plugin_mention_tool_not_found`；工具只给模型 →
   `plugin_mention_tool_not_app_visible`；两种情况都不调用工具。
4. 正常：在插件自己的 server 上以 `{ query }` 调用，返回校验后的 `items`。
5. `isError`、调用抛错 → `plugin_mention_tool_failed`。
6. 超过 50 项、`insertText` 超长、未知字段、缺 `structuredContent` →
   `plugin_mention_result_invalid`，错误里不含工具返回的内容。
7. 授权链拒绝 → `plugin_mention_tool_denied`，错误里不含拒绝原因。
8. 审批等待中请求不返回；批准后按结果返回。
9. facade `callMcpToolForUi`：先跑授权链再以批准后的输入调工具；授权链拒绝时不调工具。

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
