import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserInfo } from "../src/browser-client/index.js";
import {
  BrowserApiPolicy,
  createBrowserApiProxy,
  loadBrowserApiManifest,
} from "../src/browser-client/index.js";
import { loadBrowserDocumentation } from "../src/browser-client/documentation.js";
import { NodeReplSession } from "../src/repl/node-repl-session.js";

const docsRoot = resolve(process.cwd(), "../browser-use-plugin/docs");
const skillPath = resolve(process.cwd(), "../browser-use-plugin/skills/control-browser/SKILL.md");
const overviewPath = resolve(docsRoot, "overview.md");
const workflowPath = resolve(docsRoot, "workflow.md");
const playwrightPath = resolve(docsRoot, "playwright.md");
const testerSkillPath = resolve(
  process.cwd(),
  "../browser-use-plugin/skills/web-gui-tester/SKILL.md",
);
const iab: BrowserInfo = {
  id: "iab-runtime-1",
  generation: 3,
  type: "iab",
  name: "IAB",
  capabilities: { browser: [], tab: [{ id: "dom-cua", description: "DOM" }] },
  apiSupportOverrides: {
    "BrowserUser.claimTab": true,
    "Tabs.finalize": true,
    "Tab.markDeliverable": true,
    "Tab.markHandoff": true,
  },
};

describe("browser capability manifest", () => {
  it("web GUI tester stays agnostic to the browser automation tooling available in the session", () => {
    const skill = readFileSync(testerSkillPath, "utf8");

    expect(skill).toContain("whatever browser automation tooling the session actually provides");
    expect(skill).toContain("This skill defines the testing methodology only");
    expect(skill).toContain("Cross-validate code and visuals");
    expect(skill).not.toContain("browser-use:control-browser");
    expect(skill).not.toContain("agent.browsers");
    expect(skill).not.toContain("tab.playwright.domSnapshot()");
    expect(skill).not.toContain("nodeRepl.emitImage(await tab.screenshot())");
    expect(skill).not.toMatch(
      /\bpage\.(?:click|fill|goto|screenshot|evaluate|on|context|keyboard|mouse)\b/u,
    );
    expect(skill).not.toContain("page.on(");
    expect(skill).toContain("Browser screenshot saved to: <absolute path>");
  });

  it("keeps included examples executable without cross-cell Browser bindings", async () => {
    const overview = readFileSync(overviewPath, "utf8");
    const workflow = readFileSync(workflowPath, "utf8");
    const firstWorkflowCell = /```js\r?\n([\s\S]*?)\r?\n```/u.exec(workflow)?.[1];
    expect(firstWorkflowCell).toBeTruthy();
    expect(overview).not.toContain("globalThis.browser");
    expect(overview).not.toContain("globalThis.tab");
    expect(overview).toContain("fresh kernel");
    expect(workflow).not.toContain("globalThis.browser");
    expect(workflow).not.toContain("globalThis.tab");
    expect(overview).not.toContain("browser.tabs.selected()");
    expect(workflow).toMatch(/\bconst browser = await agent\.browsers/u);
    if (!firstWorkflowCell) return;

    const browser = {
      tabs: {
        list: async () => [
          {
            id: "tab-1",
            title: "Example",
            url: "https://example.com/",
            viewport: { width: 1280, height: 720 },
          },
        ],
      },
    };
    const session = new NodeReplSession({
      injectedGlobals: () => ({
        agent: { browsers: { getDefault: async () => browser } },
      }),
      protectProtocolStdio: true,
    });
    try {
      const first = await session.run(firstWorkflowCell);
      expect(first.error).toBeUndefined();
      expect(first.result).toContain('"id": "tab-1"');
    } finally {
      session.dispose();
    }
  });

  it("browser skill keeps BrowserControl continuity while rebuilding JavaScript bindings", () => {
    const skill = readFileSync(skillPath, "utf8");

    expect(skill).toContain("mcp__node_repl__js");
    expect(skill).toContain("every `js` call runs in a fresh JavaScript kernel");
    expect(skill).toContain("Persistent BrowserControl tabs are the continuity boundary");
    expect(skill).not.toContain("mcp__browser_use__");
    expect(skill).not.toContain("context_handle");
  });

  it("preserves pre-upgrade Browser Use guidance outside the fresh-kernel substitutions", () => {
    const skill = readFileSync(skillPath, "utf8");
    const bootstrapSource = /## Bootstrap[\s\S]*?```js\r?\n([\s\S]*?)\r?\n```/u.exec(skill)?.[1];

    expect(skill).toContain("The tool has no `command` parameter.");
    expect(skill).toContain("Headless is a CDP launch mode, not a backend type.");
    expect(skill).toContain("Reuse the latest relevant snapshot until it becomes stale.");
    expect(skill).toMatch(
      /An internal SDK validation or a list hidden inside the same\s+cell does not count as model inspection\./u,
    );
    expect(skill).toContain("Do not navigate to the same URL again");
    expect(skill).toMatch(
      /Do not close research\/source tabs merely because the\s+turn is ending\./u,
    );
    expect(skill).toContain(
      "If the user asked for screenshots, include the emitted images in your final response.",
    );
    expect(bootstrapSource).toBeTruthy();
    expect(bootstrapSource).not.toContain("agent.browsers.getDefault()");
    expect(bootstrapSource).not.toContain("agent.browsers.get(");
    expect(bootstrapSource).not.toContain("agent.browsers.getForUrl(");
  });

  it("executes the browser skill bootstrap with the host-provided plugin root", async () => {
    const skill = readFileSync(skillPath, "utf8");
    const bootstrapSource = /## Bootstrap[\s\S]*?```js\r?\n([\s\S]*?)\r?\n```/u.exec(skill)?.[1];
    expect(bootstrapSource).toBeTruthy();
    if (!bootstrapSource) return;

    const pluginRoot = await mkdtemp(join(tmpdir(), "zcode-browser-skill-"));
    const previousPluginRoot = process.env.ZCODE_PLUGIN_ROOT;
    let session: NodeReplSession | undefined;
    try {
      await mkdir(join(pluginRoot, "scripts"), { recursive: true });
      await writeFile(
        join(pluginRoot, "scripts", "browser-client.mjs"),
        [
          "export async function setupBrowserRuntime({ globals }) {",
          "  globals.agent = { browsers: { ready: true, getDefault: async () => ({}) } };",
          "}",
        ].join("\n"),
        "utf8",
      );
      process.env.ZCODE_PLUGIN_ROOT = pluginRoot;
      session = new NodeReplSession({ protectProtocolStdio: true });

      // 修复原因：生产 Skill 的 base directory 位于 skills/control-browser，必须证明模板只信任宿主根目录。
      const bootstrapResult = await session.run(bootstrapSource);
      expect(bootstrapResult.error).toBeUndefined();
      const readyResult = await session.run("globalThis.agent?.browsers?.ready");
      expect(readyResult.error).toBeUndefined();
      expect(readyResult.result).toBe("true");
    } finally {
      session?.dispose();
      if (previousPluginRoot === undefined) {
        delete process.env.ZCODE_PLUGIN_ROOT;
      } else {
        process.env.ZCODE_PLUGIN_ROOT = previousPluginRoot;
      }
      await rm(pluginRoot, { force: true, recursive: true });
    }
  });

  it("exposes the Playwright wait member in runtime policy and effective documentation", () => {
    const manifest = loadBrowserApiManifest(docsRoot);
    const policy = new BrowserApiPolicy(manifest, iab);
    const runtime = createBrowserApiProxy({ waitForTimeout: () => "ok" }, "PlaywrightAPI", policy);

    expect(runtime.waitForTimeout()).toBe("ok");
    expect("waitForTimeout" in runtime).toBe(true);
    const documentation = loadBrowserDocumentation(docsRoot, undefined, iab);
    expect(documentation).toContain("url(): Promise<string | undefined>");
    expect(documentation).toContain("playwright: PlaywrightAPI");
    expect(documentation).toContain("waitForTimeout(timeoutMs: number)");
    expect(documentation).toContain('waitForEvent(event: "download"');
    expect(documentation).toContain("Construct locators only from the latest relevant domSnapshot");
    expect(documentation).toContain("If the latest snapshot already contains the target");
    expect(documentation).toContain("execute JavaScript in the page context");
    expect(documentation).not.toContain("read-only evaluate");
    expect(documentation).not.toContain("Possible side-effect in debug-evaluate");
    expect(documentation).toContain("capped at 3000ms");
    expect(documentation).toContain("do not wait on that locator");
    expect(documentation).toContain("do not loop over guessed URL variants");
    expect(documentation).toContain("accepts a plain string or `RegExp`");
    expect(documentation).toContain("RegExp values created in the node_repl VM realm");
    expect(documentation).toContain("already-loaded page can satisfy that waiter");
    expect(documentation).toContain("ambient UI state, not a browser-selection instruction");
    expect(documentation).toContain("nodeRepl.emitImage(await tab.screenshot())");
    expect(documentation).toContain("Never use tab.screenshot() as the final expression");
    expect(documentation).not.toContain('waitForEvent(event: "filechooser"');
    expect(documentation).not.toContain("setFiles(files");
    expect(documentation).not.toContain("elementInfo(options:");
    expect(documentation).not.toContain("elementScreenshot(options:");
    expect(documentation).not.toContain("downloadMedia(options: CuaDownloadMediaOptions");
    expect(documentation).not.toContain("downloadMedia(options: DomDownloadMediaOptions");
  });

  it("browser skill keeps snapshot-first discovery while allowing evaluate page scripts", () => {
    const skill = readFileSync(skillPath, "utf8");

    expect(skill).toContain(
      "If that snapshot already contains the target, act from its facts directly",
    );
    expect(skill).toContain("do not write `evaluate()` code to rediscover related elements");
    expect(skill).toContain("execute JavaScript in the page context");
    expect(skill).not.toContain("read-only evaluate");
    expect(skill).not.toContain("Possible side-effect in debug-evaluate");
  });

  it("requires an explicit DOMContentLoaded wait after every new-URL goto", () => {
    const skill = readFileSync(skillPath, "utf8");
    const overview = readFileSync(overviewPath, "utf8");
    const workflow = readFileSync(workflowPath, "utf8");
    const playwright = readFileSync(playwrightPath, "utf8");
    const manifest = loadBrowserApiManifest(docsRoot);
    const documentation = loadBrowserDocumentation(docsRoot, undefined, iab);
    const fallbackDocumentation = loadBrowserDocumentation(undefined, undefined, iab);
    const requiredGuidance =
      'After every successful `tab.goto(url)`, explicitly call `await tab.playwright.waitForLoadState({ state: "domcontentloaded" })` before the first title, URL, or DOM observation.';
    const explicitWait = 'await tab.playwright.waitForLoadState({ state: "domcontentloaded" });';

    expect(manifest.semantics?.navigationWait).toContain(requiredGuidance);
    for (const guidance of [
      skill,
      overview,
      workflow,
      playwright,
      documentation,
      fallbackDocumentation,
    ]) {
      expect(guidance).toContain(requiredGuidance);
      expect(guidance).toContain("3000ms");
      expect(guidance).not.toContain(
        'tab.goto(url)` and `tab.playwright.waitForLoadState({ state: "networkidle" })',
      );
    }

    for (const example of [overview, workflow]) {
      const gotoIndex = example.indexOf('await tab.goto("https://example.com");');
      const waitIndex = example.indexOf(explicitWait, gotoIndex);
      const observationIndex = example.indexOf("await tab.playwright.domSnapshot();", waitIndex);
      expect(gotoIndex).toBeGreaterThanOrEqual(0);
      expect(waitIndex).toBeGreaterThan(gotoIndex);
      expect(observationIndex).toBeGreaterThan(waitIndex);
    }
  });

  it("browser guidance observes both tab registries in one cell before deciding a popup action effect", () => {
    const skill = readFileSync(skillPath, "utf8");
    const manifest = loadBrowserApiManifest(docsRoot);
    const documentation = loadBrowserDocumentation(docsRoot, undefined, iab);
    const fallbackDocumentation = loadBrowserDocumentation(undefined, undefined, iab);
    const troubleshootingDocumentation = loadBrowserDocumentation(
      docsRoot,
      "browser-troubleshooting",
      iab,
    );
    const tabClaimingDocumentation = loadBrowserDocumentation(docsRoot, "tab-claiming-iab", iab);

    expect(manifest.semantics?.actionResultObservation).toContain(
      "read `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell",
    );
    for (const guidance of [skill, documentation, fallbackDocumentation]) {
      expect(guidance).toContain(
        "A snapshot-proven heading or visible text does not need a `link` or `button` role to be clicked.",
      );
      expect(guidance).toContain(
        "Do not replace a snapshot-proven `heading` with a guessed `link` role.",
      );
      expect(guidance).toContain("one state-changing action per observation cycle");
      expect(guidance).toContain("An unchanged source-tab URL does not prove the click failed.");
      expect(guidance).toContain(
        "When an action may open a popup/new tab and the source tab does not show the expected effect, read `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell.",
      );
      expect(guidance).toContain(
        "Judge an action by whether its expected effect appeared, not by whether `browser.tabs.list()` is non-empty.",
      );
      expect(guidance).toContain(
        "An existing source tab or unrelated controlled tab is not an action effect.",
      );
      expect(guidance).toContain(
        "Return `{ controlledTabs, userTabs }` as that cell's final result so the model makes one decision from both lists.",
      );
      expect(guidance).toContain(
        "Do not return the controlled list first or decide whether to query user tabs from its contents.",
      );
      expect(guidance).not.toContain("Return each list in a dedicated JS call");
      expect(guidance).not.toContain("lists in separate observation calls");
      expect(guidance).not.toContain(
        "inspect `browser.tabs.list()` and then `browser.user.openTabs()` before clicking again",
      );
    }
    expect(fallbackDocumentation).toContain("every Browser Use call starts in a fresh kernel");
    expect(fallbackDocumentation).toContain("const browser = await agent.browsers.getDefault()");
    expect(fallbackDocumentation).not.toContain("globalThis.browser");
    expect(fallbackDocumentation).not.toContain("globalThis.tab");
    for (const guidance of [troubleshootingDocumentation, tabClaimingDocumentation]) {
      expect(guidance).toContain(
        "When an action may open a popup/new tab and the source tab does not show the expected effect, read",
      );
      expect(guidance).toContain(
        "`browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell.",
      );
      expect(guidance).toContain(
        "{ controlledTabs, userTabs }` as that cell's final result so the model makes one decision from both lists",
      );
      expect(guidance).not.toContain("separate observation");
    }
  });

  it("IAB effective docs include capability-gated tab lifecycle and recovery guidance", () => {
    const documentation = loadBrowserDocumentation(docsRoot, undefined, iab);

    expect(documentation).toContain("# User Tab Claiming");
    expect(documentation).toContain("# Tab Cleanup");
    expect(documentation).toContain("# Tab Lifecycle Marks");
    expect(documentation).toContain("# All-Tabs Cleanup Guidance");
    expect(documentation).toContain("browser.tabs.get(info.id)");
    expect(documentation).toContain("Before every logical tab operation batch");
    expect(documentation).toContain("dedicated JS call");
    expect(documentation).toContain("same-cell hidden list does not count as model inspection");
    expect(documentation).toContain("background session never steals the foreground UI");
    expect(documentation).toContain("active?: boolean");
    expect(documentation).toContain("viewport: BrowserViewportSize");
    expect(loadBrowserDocumentation(undefined, undefined, iab)).toContain(
      "viewport: BrowserViewportSize",
    );
    expect(documentation).toContain("validates, binds, and activates a tab");
    expect(documentation).toContain("omission from `keep` do not close a tab");
    expect(documentation).not.toContain("unlisted temporary tabs are cleaned up");
    expect(documentation).not.toContain("preserves only the final active agent tab");
    expect(documentation).not.toContain("# Browser Interaction Troubleshooting");
    expect(loadBrowserDocumentation(docsRoot, "browser-troubleshooting", iab)).toContain(
      "Do not retry the same",
    );
    expect(loadBrowserDocumentation(docsRoot, "viewport", iab)).toContain(
      "responsive mode uses DPR 1",
    );
  });

  it("non-IAB effective docs do not include IAB-only tab lifecycle documents", () => {
    const documentation = loadBrowserDocumentation(docsRoot, undefined, {
      ...iab,
      id: "extension-1",
      type: "extension",
    });

    expect(documentation).not.toContain("# User Tab Claiming");
    expect(documentation).not.toContain("# Tab Lifecycle Marks");
    expect(documentation).not.toContain("# All-Tabs Cleanup Guidance");
  });

  it("connection override can hide a common member from runtime and docs", () => {
    const manifest = loadBrowserApiManifest(docsRoot);
    const descriptor = {
      ...iab,
      apiSupportOverrides: { "PlaywrightAPI.waitForTimeout": false },
    };
    const policy = new BrowserApiPolicy(manifest, descriptor);
    const runtime = createBrowserApiProxy(
      { waitForTimeout: () => "unexpected" },
      "PlaywrightAPI",
      policy,
    );

    expect(runtime.waitForTimeout).toBeUndefined();
    expect("waitForTimeout" in runtime).toBe(false);
    expect(loadBrowserDocumentation(docsRoot, undefined, descriptor)).not.toContain(
      "waitForTimeout(timeoutMs: number)",
    );
  });

  it("hides tab lifecycle finalization from IAB and managed CDP object graphs", () => {
    const manifest = loadBrowserApiManifest(docsRoot);
    for (const type of ["iab", "cdp"] as const) {
      const policy = new BrowserApiPolicy(manifest, {
        ...iab,
        type,
        apiSupportOverrides: {},
      });
      const runtime = createBrowserApiProxy({ finalize: () => "unexpected" }, "Tab", policy);

      expect(policy.supports("Tab", "finalize")).toBe(false);
      expect(runtime.finalize).toBeUndefined();
      expect("finalize" in runtime).toBe(false);
    }
  });

  it("keeps browser and tab capability requirements isolated", () => {
    const manifest = loadBrowserApiManifest(docsRoot);
    const scopedManifest = {
      ...manifest,
      objects: {
        ...manifest.objects,
        Scoped: {
          members: [
            {
              name: "browserOnly",
              kind: "method" as const,
              signature: "browserOnly()",
              requiresCapabilities: ["browser:shared"],
            },
            {
              name: "tabOnly",
              kind: "method" as const,
              signature: "tabOnly()",
              requiresCapabilities: ["tab:shared"],
            },
          ],
        },
      },
    };
    const policy = new BrowserApiPolicy(scopedManifest, {
      ...iab,
      capabilities: { browser: [], tab: [{ id: "shared", description: "tab only" }] },
    });

    expect(policy.supports("Scoped", "browserOnly")).toBe(false);
    expect(policy.supports("Scoped", "tabOnly")).toBe(true);
  });

  it("keeps manifest command mappings inside the browser command contract", () => {
    const manifest = loadBrowserApiManifest(docsRoot);
    const knownCommands = new Set([
      "navigate",
      "back",
      "forward",
      "reload",
      "snapshot",
      "screenshot",
      "getState",
      "click",
      "type",
      "press",
      "scroll",
      "hover",
      "select",
      "check",
      "drag",
      "elementInfo",
      "evaluate",
      "getDialog",
      "handleDialog",
      "finalize",
      "close",
      "list",
      "newTab",
      "nameSession",
      "claimTab",
      "listUserTabs",
      "finalizeTabs",
      "markDeliverable",
      "markHandoff",
      "browserViewportSet",
      "browserViewportReset",
      "recordingStart",
      "recordingStatus",
      "recordingCancel",
      "playwrightWaitForTimeout",
      "playwright",
    ]);
    for (const object of Object.values(manifest.objects)) {
      for (const member of object.members) {
        if (member.command) expect(knownCommands.has(member.command), member.command).toBe(true);
      }
    }
  });

  it("manifest 枚举 common Playwright 全对象图", () => {
    const manifest = loadBrowserApiManifest(docsRoot);
    expect(manifest.version).toBe(11);
    expect(manifest.objects.PlaywrightAPI.members).toHaveLength(16);
    expect(manifest.objects.PlaywrightLocator.members).toHaveLength(32);
    expect(manifest.objects.PlaywrightFrameLocator.members).toHaveLength(7);
    expect(manifest.objects.PlaywrightDownload.members.map((member) => member.name)).toEqual([
      "path",
    ]);
    expect(manifest.objects.PlaywrightFileChooser.members.map((member) => member.name)).toEqual([
      "isMultiple",
      "setFiles",
    ]);
  });
});
