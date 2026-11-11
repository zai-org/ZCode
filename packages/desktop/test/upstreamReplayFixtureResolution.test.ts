import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { startUpstreamReplayServer } from "#e2e/helpers/upstream-replay-server";

import {
  hasUpstreamCaseLocalReplayFixtureForWorker,
  resolveUpstreamE2EHttpMode,
  resolveUpstreamE2EHttpModeForWorker,
  resolveUpstreamReplayFixturePaths,
  resolvePluginReplayFixturePaths,
} from "./e2e/helpers/upstream-replay-fixture-resolution.js";

const root = join("repo", "packages", "desktop", "test", "e2e", "fixtures");
const commonFixturePath = join(root, "upstream", "common.json");
const caseFixtureDir = join(root, "upstream", "conversation-session");
const caseManifestDir = join(root, "cases", "conversation-session");
const legacyFixturePaths = [
  join(root, "upstream", "provider-conversation-tool-cross-product.json"),
  join(root, "upstream", "provider-basic.json"),
];
const formalSpec = join(
  "repo",
  "packages",
  "desktop",
  "test",
  "e2e",
  "conversation-session",
  "conversation-session-v4-edit.test.ts",
);
const manualSpec = join(
  "repo",
  "packages",
  "desktop",
  "test",
  "e2e",
  "conversation-session",
  "manual-review",
  "pending",
  "conversation-session-agent-step-message-scope.test.ts",
);

function createOptions(existingPaths: string[]) {
  return {
    caseFixtureDir,
    caseManifestDir,
    commonFixturePath,
    configuredFixturePaths: null,
    legacyFixturePaths,
    pathExists: (path: string) => existingPaths.includes(path),
    pluginFixturePaths: [],
    specs: [formalSpec],
  };
}

describe("Upstream replay fixture resolution", () => {
  it.each(["plugin-mcp-skill", "plugin-management"])(
    "loads JSON files from the %s compatibility directory into a real replay server",
    async (domain) => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "plugin-replay-paths-"));
      let server: Awaited<ReturnType<typeof startUpstreamReplayServer>> | undefined;
      try {
        const directory = join(fixtureRoot, domain);
        await mkdir(join(directory, "nested.json"), { recursive: true });
        await writeFile(join(directory, "README.md"), "not a replay fixture");
        const fixture = join(directory, "response.json");
        await writeFile(
          fixture,
          JSON.stringify({
            version: 1,
            fixtures: [
              {
                id: "plugin-path",
                match: { pathIncludes: "/messages" },
                response: { statusCode: 200, body: "plugin-ready" },
              },
            ],
          }),
        );
        const fixturePaths = await resolvePluginReplayFixturePaths({
          fixtureRoot,
          specs: [`./test/e2e/conversation-session/conversation-session-${domain}-enabled.test.ts`],
        });
        server = await startUpstreamReplayServer({
          artifactPath: join(fixtureRoot, "capture.json"),
          fixturePaths,
        });
        const response = await fetch(`${server.baseUrl}/messages`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("plugin-ready");
        expect(fixturePaths).toEqual([fixture]);
        expect(await resolvePluginReplayFixturePaths({ fixtureRoot, specs: [formalSpec] })).toEqual(
          [],
        );
      } finally {
        await server?.stop();
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("keeps manual-review on capture without an explicit replay fixture", () => {
    expect(
      resolveUpstreamE2EHttpMode({
        explicitReplayFixture: false,
        manualReview: true,
      }),
    ).toBe("capture");
  });

  it("keeps formal replay and manual-review capture isolated inside one combined run", () => {
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: ["./test/e2e/conversation-session/editing/conversation-session-v4-edit.test.ts"],
      }),
    ).toBe("replay");
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: [
          "./test/e2e/conversation-session/manual-review/pending/conversation-session-example-pending.test.ts",
        ],
      }),
    ).toBe("capture");
  });

  it("keeps the real Upstream provider smoke in capture mode inside a combined run", () => {
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: ["./test/e2e/infrastructure/smoke/upstream-provider.test.ts"],
      }),
    ).toBe("capture");
  });

  it("replays a manual-review worker when its deterministic case-local fixture exists", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-agent-step-message-scope.json");
    expect(
      hasUpstreamCaseLocalReplayFixtureForWorker({
        caseFixtureDir,
        pathExists: (path) => path === caseFixture,
        specs: [manualSpec],
      }),
    ).toBe(true);
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        caseLocalReplayFixtureAvailable: true,
        explicitReplayFixture: false,
        specs: [manualSpec],
      }),
    ).toBe("replay");
  });

  it("rejects a worker that mixes formal and manual-review specs", () => {
    expect(() =>
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: [
          "./test/e2e/conversation-session/editing/conversation-session-v4-edit.test.ts",
          "./test/e2e/conversation-session/manual-review/pending/conversation-session-example-pending.test.ts",
        ],
      }),
    ).toThrow(/cannot mix replay and capture/i);
  });

  it("allows pending manual-review to replay an explicit fixture", () => {
    expect(
      resolveUpstreamE2EHttpMode({
        explicitReplayFixture: true,
        manualReview: true,
      }),
    ).toBe("replay");
  });

  it("rejects conflicting capture mode and explicit replay fixture", () => {
    expect(() =>
      resolveUpstreamE2EHttpMode({
        explicitReplayFixture: true,
        manualReview: true,
        requestedMode: "capture",
      }),
    ).toThrow(/cannot be combined/);
  });

  it.each([
    ["plugins", "plugin-management", "plugin-runtime-env-agent-projection"],
    ["ui-shell", "ui-shell", "sidebar-tooltips"],
    ["", "ui-shell", "workspace-removal-runtime-release"],
  ])(
    "loads the %s case fixture after promotion without an explicit override",
    (domain, fixtureDomain, name) => {
      const fixture = join(root, "upstream", fixtureDomain, `${name}.json`);
      const manifest = join(root, "cases", domain || "ui-shell", `${name}.json`);
      expect(
        resolveUpstreamReplayFixturePaths({
          ...createOptions([commonFixturePath, fixture, manifest]),
          mode: "strict-case-local",
          specs: [`./test/e2e/${domain ? `${domain}/` : ""}${name}.test.ts`],
        }),
      ).toEqual([commonFixturePath, fixture]);
    },
  );

  it("keeps legacy fallback in compatible mode", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const paths = resolveUpstreamReplayFixturePaths({
      ...createOptions([commonFixturePath, caseFixture]),
      mode: "compatible",
    });

    expect(paths).toEqual([commonFixturePath, caseFixture, ...legacyFixturePaths]);
  });

  it("includes an existing manual-review case-local fixture in replay paths", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-agent-step-message-scope.json");
    const paths = resolveUpstreamReplayFixturePaths({
      ...createOptions([commonFixturePath, caseFixture]),
      mode: "compatible",
      specs: [manualSpec],
    });

    expect(paths).toEqual([commonFixturePath, caseFixture, ...legacyFixturePaths]);
  });

  it("ignores plugin fixture paths in strict case-local mode", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const caseManifest = join(caseManifestDir, "conversation-session-v4-edit.json");
    const pluginFixture = join(root, "upstream", "plugin-mcp-skill");
    const paths = resolveUpstreamReplayFixturePaths({
      ...createOptions([commonFixturePath, caseFixture, caseManifest, pluginFixture]),
      mode: "strict-case-local",
      pluginFixturePaths: [pluginFixture],
    });

    expect(paths).toEqual([commonFixturePath, caseFixture]);
  });

  it.each([
    ["manifest", join(caseFixtureDir, "conversation-session-v4-edit.json")],
    ["fixture", join(caseManifestDir, "conversation-session-v4-edit.json")],
  ])("fails strict mode when the case-local %s is missing", (_label, existingCasePath) => {
    expect(() =>
      resolveUpstreamReplayFixturePaths({
        ...createOptions([commonFixturePath, existingCasePath]),
        mode: "strict-case-local",
      }),
    ).toThrow(/conversation-session-v4-edit/);
  });

  it("rejects explicit fixture overrides in strict case-local mode", () => {
    expect(() =>
      resolveUpstreamReplayFixturePaths({
        ...createOptions([commonFixturePath]),
        configuredFixturePaths: [legacyFixturePaths[1]!],
        mode: "strict-case-local",
      }),
    ).toThrow(/E2E_PROVIDER_REPLAY_FIXTURE_PATH/);
  });

  it("fails strict mode when the common fixture is missing", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const caseManifest = join(caseManifestDir, "conversation-session-v4-edit.json");

    expect(() =>
      resolveUpstreamReplayFixturePaths({
        ...createOptions([caseFixture, caseManifest]),
        mode: "strict-case-local",
      }),
    ).toThrow(/common fixture/);
  });

  it("resolves multiple Windows-style formal spec paths in strict mode", () => {
    const secondCaseName = "conversation-session-v4-goal";
    const secondSpec = formalSpec
      .replace("conversation-session-v4-edit", secondCaseName)
      .replaceAll("/", "\\");
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const caseManifest = join(caseManifestDir, "conversation-session-v4-edit.json");
    const secondFixture = join(caseFixtureDir, `${secondCaseName}.json`);
    const secondManifest = join(caseManifestDir, `${secondCaseName}.json`);

    expect(
      resolveUpstreamReplayFixturePaths({
        ...createOptions([
          commonFixturePath,
          caseFixture,
          caseManifest,
          secondFixture,
          secondManifest,
        ]),
        mode: "strict-case-local",
        specs: [formalSpec.replaceAll("/", "\\"), secondSpec],
      }),
    ).toEqual([commonFixturePath, caseFixture, secondFixture]);
  });
});
