import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@zcode/adapters/config";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { Logger } from "@zcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowChildSkillPort } from "../src/app/script-workflow-child-runtime.js";
import { resolveStartupPlugins } from "../src/app/startup-marks.js";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { setZCodePluginEnabled } from "../src/plugins.js";
import { inspectZCodeSkill, listZCodeSkills } from "../src/skills.js";
import { StartupTimer } from "../src/startup-logging.js";
import { getSkillReferenceCatalog } from "../src/zcode-protocol/skill-reference-catalog.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createWorkspaceZCodeApp } from "../src/zcode-protocol/workspace-model-runtime.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

const VISUALIZE_PLUGIN_ID = "visualize@zcode-plugins-official";
const VISUALIZE_SKILL = "visualize:visualize";
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

describe("visualize protocol-only skill discovery", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-visualize-gate-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    env = { ZCODE_STORAGE_DIR: join(root, "storage") };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "loads skills with a read-only project config directory",
    async () => {
      const directory = join(root, ".zcode");
      const configPath = join(directory, "config.json");
      const original = JSON.stringify({
        plugins: { enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true } },
      });
      await mkdir(directory);
      await writeFile(configPath, original);
      await chmod(directory, 0o555);
      try {
        const result = await listZCodeSkills({
          env,
          skipUserConfig: true,
          includeVisualize: true,
          workingDirectory: root,
        });
        expect(result.skills.some((skill) => skill.pluginId === VISUALIZE_PLUGIN_ID)).toBe(false);
        expect(result.skills.some((skill) => skill.name === "pdf")).toBe(true);
        expect(await readFile(configPath, "utf8")).toBe(original);
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );

  it.each([undefined, false, true])(
    "list and inspect agree with includeVisualize=%s",
    async (includeVisualize) => {
      const userConfigPath = join(root, "config.json");
      await writeFile(
        userConfigPath,
        JSON.stringify({
          plugins: {
            visualizeDefaultOffMigrated: true,
            enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true },
          },
        }),
      );
      const options = { env, includeVisualize, userConfigPath, workingDirectory: root };
      const outcome = await listZCodeSkills(options);
      expect(outcome.skills.some((skill) => skill.pluginId === VISUALIZE_PLUGIN_ID)).toBe(
        includeVisualize === true,
      );
      expect(outcome.skills.some((skill) => skill.name === "pdf")).toBe(true);
      for (const name of ["visualize", VISUALIZE_SKILL]) {
        if (includeVisualize) {
          const result = await inspectZCodeSkill({ ...options, name });
          expect(result.skill.metadata.pluginId).toBe(VISUALIZE_PLUGIN_ID);
          expect(result.skill.content).toContain("Inline HTML output contract");
        } else {
          await expect(inspectZCodeSkill({ ...options, name })).rejects.toThrow("Skill not found:");
        }
      }
    },
  );

  it.each([undefined, false, true])(
    "startup and workflow child agree with includeVisualize=%s",
    async (includeVisualize) => {
      const configResult = createConfig({
        env,
        skipUserConfig: true,
        workingDirectory: root,
        cliOverrides: { plugins: { enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true } } },
      });
      const appOptions = { includeVisualize } as ZCodeAppOptions;
      const plugins = await resolveStartupPlugins({
        cliStorageRoot: join(root, "storage", "cli"),
        configResult,
        env,
        options: appOptions,
        startupTimer: new StartupTimer(logger, {}),
        workingDirectory: root,
      });
      const parentPort = createNodeSkillAdapter({ extraResolvedRoots: plugins.skillRoots });
      const childPort = createWorkflowChildSkillPort({
        appOptions,
        configResult,
        pluginSkillRoots: plugins.skillRoots,
      });
      for (const port of [parentPort, childPort!]) {
        const outcome = await port.discoverSkills({ workingDirectory: root });
        expect(outcome.skills.some((skill) => skill.pluginId === VISUALIZE_PLUGIN_ID)).toBe(
          includeVisualize === true,
        );
        expect(outcome.skills.some((skill) => skill.name === "pdf")).toBe(true);
      }
    },
  );

  it("keeps project skills with the same name available in CLI", async () => {
    const skillDir = join(root, ".agents", "skills", "visualize");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: visualize\ndescription: Project visualization.\n---\nProject skill.",
    );
    const result = await inspectZCodeSkill({
      env,
      skipUserConfig: true,
      workingDirectory: root,
      name: "visualize",
    });
    expect(result.skill.metadata.source).toBe("agents");
    expect(result.skill.content).toBe("Project skill.");
  });

  it("does not override explicit plugin disablement in protocol mode", async () => {
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ plugins: { enabledPlugins: { [VISUALIZE_PLUGIN_ID]: false } } }),
    );
    const options = {
      env,
      includeVisualize: true,
      userConfigPath: configPath,
      workingDirectory: root,
    };
    const outcome = await listZCodeSkills(options);
    expect(outcome.skills.some((skill) => skill.pluginId === VISUALIZE_PLUGIN_ID)).toBe(false);
    await expect(inspectZCodeSkill({ ...options, name: VISUALIZE_SKILL })).rejects.toThrow(
      "Skill not found:",
    );
  });

  it.each([
    { name: "default disabled", plugins: {}, expected: false },
    {
      name: "legacy enabled",
      plugins: { enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true } },
      expected: false,
    },
    {
      name: "explicitly enabled",
      plugins: {
        visualizeDefaultOffMigrated: true,
        enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true },
      },
      expected: true,
    },
    {
      name: "disabled",
      plugins: { enabledPlugins: { [VISUALIZE_PLUGIN_ID]: false } },
      expected: false,
    },
    {
      name: "uninstalled",
      plugins: { suppressedBuiltins: [VISUALIZE_PLUGIN_ID] },
      expected: false,
    },
    { name: "all plugins disabled", plugins: { enabled: false }, expected: false },
  ])("gates model context on the resolved plugin state: $name", async ({ plugins, expected }) => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ plugins }));
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const requests: string[] = [];
    let app: ZCodeApp | undefined;
    try {
      app = await createRegistryBackedTestApp({
        env: { ...env, ZCODE_GEN_UI_OUTPUT_ROOT: join(root, "visualizations") },
        includeVisualize: true,
        userConfigPath: configPath,
        sessionStore,
        runtimeConfig: {
          workingDirectory: root,
          presentationSurface: "zcode_desktop",
          mcp: { enabled: false },
        },
        modelExecutor: {
          async generateText(request) {
            requests.push(JSON.stringify(request.messages));
            return { text: "ok", finishReason: "stop", usage: {} };
          },
        },
      });
      await app.submitPrompt("hello");
      expect(requests).toHaveLength(1);
      const text = requests[0]!;
      expect(text.includes("### Interactive views")).toBe(expected);
      expect(text.includes("Visualization directory for this session:")).toBe(expected);
      expect(text.includes("This Desktop host supports Gen UI")).toBe(expected);
      expect(text.includes("Widget modelContent may accompany")).toBe(expected);
      expect(text).not.toContain("inline Gen UI is unavailable");
      expect(text).toContain("### Files & URLs");
      expect(text).toContain("### Inline Code Comments");
    } finally {
      await app?.close?.();
      sessionStore.close();
    }
  });

  it("keeps the built-in installed, resets old settings and retains re-enable across discovery", async () => {
    const userConfigPath = join(root, "config.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({ plugins: { enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true } } }),
    );
    const options = { env, includeVisualize: true, userConfigPath, workingDirectory: root };
    expect(
      (await listZCodeSkills(options)).skills.some(
        (skill) => skill.pluginId === VISUALIZE_PLUGIN_ID,
      ),
    ).toBe(false);
    await setZCodePluginEnabled({
      ...options,
      plugin: VISUALIZE_PLUGIN_ID,
      enabled: true,
      scope: "user",
    });
    for (let restart = 0; restart < 2; restart++) {
      expect(
        (await listZCodeSkills(options)).skills.some(
          (skill) => skill.pluginId === VISUALIZE_PLUGIN_ID,
        ),
      ).toBe(true);
    }
    expect(JSON.parse(await readFile(userConfigPath, "utf8")).plugins).toMatchObject({
      visualizeDefaultOffMigrated: true,
      enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true },
    });
  });

  it.each([false, true])(
    "keeps protocol draft discovery consistent with enabled=%s",
    async (enabled) => {
      if (enabled) {
        await mkdir(join(root, ".zcode"));
        await writeFile(
          join(root, ".zcode", "config.json"),
          JSON.stringify({
            plugins: {
              visualizeDefaultOffMigrated: true,
              enabledPlugins: { [VISUALIZE_PLUGIN_ID]: true },
            },
          }),
        );
      }
      const createZCodeApp = vi.fn(() => ({}) as ZCodeApp);
      const context = {
        deps: { createZCodeApp, env },
        sessions: new Map(),
      } as unknown as ZCodeProtocolAgentServerContext;
      const workspace = { workspacePath: root, workspaceKey: root };
      await createWorkspaceZCodeApp(context, workspace, {
        providerRuntimeHeadersPort: {} as ZCodeAppOptions["providerRuntimeHeadersPort"],
      });
      expect(createZCodeApp).toHaveBeenCalledWith(
        expect.objectContaining({ includeVisualize: true }),
      );
      const catalog = await getSkillReferenceCatalog(context, { workspace });
      expect(catalog.skills.some((skill) => skill.pluginName === "visualize")).toBe(enabled);
    },
  );
});
