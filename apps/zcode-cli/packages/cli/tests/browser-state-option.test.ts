import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import {
  BROWSER_STATE_CONFLICT_ERROR,
  BROWSER_STATE_REQUIRES_HEADLESS_ERROR,
} from "../src/browser-state-option.js";
import { run } from "../src/run.js";
import type { RunDependencies } from "../src/run.js";

/**
 * `--browser-state` / `--no-browser-state` 与默认登录态文件
 * （docs/browser-use/2026-11-17-cli-browser-state-spec.md §4、§9）。
 */

type CapturedWriteStream = NodeJS.WriteStream & { output: () => string };

const BROWSER_USE_SCOPE_ERROR =
  "--browser-use=headless can only be used with --prompt, --target, or tui.";
const SECRET_COOKIE_VALUE = "secret-cookie-value";
const VALID_STATE = {
  cookies: [
    {
      name: "sid",
      value: "cookie-value",
      domain: ".example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [],
};

const createWriteStream = (): CapturedWriteStream => {
  let output = "";
  return {
    isTTY: false,
    output: () => output,
    write: (chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      (done as (() => void) | undefined)?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (argv: string[]) =>
  ({
    argv,
    stderr: createWriteStream(),
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: createWriteStream(),
  }) satisfies RunContext;

const fakeProjection = {
  contextUsed: 0,
  contextWindow: 0,
  status: "idle",
  totalTokenCount: 0,
  turnCount: 1,
};

interface Fixture {
  home: string;
  launchCwd: string;
  defaultStatePath: string;
  runtimeStatePaths: Array<string | undefined>;
  appCount: () => number;
  deps: RunDependencies;
  cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "zcode-browser-state-option-"));
  const home = join(root, "home");
  const launchCwd = join(root, "launch");
  await mkdir(home, { recursive: true });
  await mkdir(launchCwd, { recursive: true });
  const runtimeStatePaths: Array<string | undefined> = [];
  let apps = 0;
  const deps: RunDependencies = {
    cwd: () => launchCwd,
    env: { HOME: home },
    createManagedCdpBrowserRuntime: (options) => {
      runtimeStatePaths.push(options?.storageStatePath);
      return { browserControlPort: {} as never, close: async () => undefined };
    },
    createModelAdapter: () => ({}) as never,
    createZCodeApp: () => {
      apps += 1;
      return {
        getLocale: () => "en-US",
        getModel: () => "example/test-model",
        getThoughtLevel: () => "medium",
        sessionId: `session-${apps}`,
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({ dispose: () => {}, runtime: { registryService: {} } }) as never,
    skipUserConfig: true,
    listCustomCommands: async () => ({ commands: [], diagnostics: [] }) as never,
  };
  return {
    home,
    launchCwd,
    defaultStatePath: join(home, ".zcode", "cli", "browser-state.json"),
    runtimeStatePaths,
    appCount: () => apps,
    deps,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function writeDefaultState(fixture: Fixture, content: unknown): Promise<void> {
  await mkdir(join(fixture.home, ".zcode", "cli"), { recursive: true });
  await writeFile(
    fixture.defaultStatePath,
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  try {
    await body(fixture);
  } finally {
    await fixture.cleanup();
  }
}

test("does not touch any state file without --browser-use=headless", () =>
  withFixture(async (fixture) => {
    await writeDefaultState(fixture, "{");
    const ctx = createContext(["--prompt", "hello"]);

    assert.equal(await run(ctx, fixture.deps), 0);
    assert.doesNotMatch(ctx.stderr.output(), /browser state/iu);
  }));

test("rejects state flags without headless", () =>
  withFixture(async (fixture) => {
    for (const argv of [
      ["--browser-state", "state.json", "--prompt", "p"],
      ["--no-browser-state", "--prompt", "p"],
    ]) {
      const ctx = createContext(argv);
      assert.equal(await run(ctx, fixture.deps), 1);
      assert.equal(ctx.stderr.output(), `${BROWSER_STATE_REQUIRES_HEADLESS_ERROR}\n`);
    }
    assert.equal(fixture.appCount(), 0);
  }));

test("rejects both state flags together", () =>
  withFixture(async (fixture) => {
    const ctx = createContext([
      "--browser-use=headless",
      "--browser-state",
      "state.json",
      "--no-browser-state",
      "--prompt",
      "p",
    ]);

    assert.equal(await run(ctx, fixture.deps), 1);
    assert.match(ctx.stderr.output(), new RegExp(escapeRegExp(BROWSER_STATE_CONFLICT_ERROR), "u"));
    assert.equal(fixture.appCount(), 0);
  }));

test("keeps app-server rejecting headless browser flags", () =>
  withFixture(async (fixture) => {
    const invalidPath = join(fixture.launchCwd, "invalid.json");
    await writeFile(invalidPath, "{");
    const ctx = createContext([
      "app-server",
      "--browser-use=headless",
      "--browser-state",
      invalidPath,
    ]);

    assert.equal(await run(ctx, fixture.deps), 1);
    assert.match(ctx.stderr.output(), new RegExp(escapeRegExp(BROWSER_USE_SCOPE_ERROR), "u"));
    assert.doesNotMatch(ctx.stderr.output(), /Browser state/u);
  }));

test("passes no state path when the default file is absent", () =>
  withFixture(async (fixture) => {
    const ctx = createContext(["--browser-use=headless", "--prompt", "hello"]);

    assert.equal(await run(ctx, fixture.deps), 0);
    assert.deepEqual(fixture.runtimeStatePaths, [undefined]);
    assert.doesNotMatch(ctx.stderr.output(), /browser state/iu);
  }));

test("loads the default file and prints a notice", () =>
  withFixture(async (fixture) => {
    await writeDefaultState(fixture, VALID_STATE);
    await chmod(fixture.defaultStatePath, 0o600);
    const ctx = createContext(["--browser-use=headless", "--prompt", "hello"]);

    assert.equal(await run(ctx, fixture.deps), 0);
    assert.deepEqual(fixture.runtimeStatePaths, [fixture.defaultStatePath]);
    assert.match(ctx.stderr.output(), /Loaded default browser state/u);
    assert.match(ctx.stderr.output(), /--no-browser-state/u);
  }));

test("skips the default file with --no-browser-state", () =>
  withFixture(async (fixture) => {
    await writeDefaultState(fixture, "{");
    const ctx = createContext(["--browser-use=headless", "--no-browser-state", "--prompt", "hi"]);

    assert.equal(await run(ctx, fixture.deps), 0);
    assert.deepEqual(fixture.runtimeStatePaths, [undefined]);
  }));

test("resolves an explicit relative path against the launch directory", () =>
  withFixture(async (fixture) => {
    const workspace = join(fixture.home, "workspace");
    await mkdir(workspace);
    const statePath = join(fixture.launchCwd, "state.json");
    await writeFile(statePath, JSON.stringify(VALID_STATE));
    await chmod(statePath, 0o600);
    const ctx = createContext([
      "--cwd",
      workspace,
      "--browser-use=headless",
      "--browser-state",
      "./state.json",
      "--prompt",
      "hello",
    ]);

    assert.equal(await run(ctx, fixture.deps), 0);
    assert.deepEqual(fixture.runtimeStatePaths, [statePath]);
  }));

test("reports the resolved path when an explicit file is missing", () =>
  withFixture(async (fixture) => {
    const ctx = createContext([
      "--browser-use=headless",
      "--browser-state=~/missing.json",
      "--prompt",
      "hello",
    ]);

    assert.equal(await run(ctx, fixture.deps), 1);
    assert.match(
      ctx.stderr.output(),
      new RegExp(escapeRegExp(join(fixture.launchCwd, "~", "missing.json")), "u"),
    );
    assert.deepEqual(fixture.runtimeStatePaths, []);
    assert.equal(fixture.appCount(), 0);
  }));

test("fails closed when the default file is invalid", () =>
  withFixture(async (fixture) => {
    await writeDefaultState(fixture, "{");
    const ctx = createContext(["--browser-use=headless", "--prompt", "hello"]);

    assert.equal(await run(ctx, fixture.deps), 1);
    assert.match(ctx.stderr.output(), new RegExp(escapeRegExp(fixture.defaultStatePath), "u"));
    assert.match(ctx.stderr.output(), /--no-browser-state/u);
    assert.equal(fixture.appCount(), 0);
  }));

test("fails closed when the default path is a directory", () =>
  withFixture(async (fixture) => {
    await mkdir(fixture.defaultStatePath, { recursive: true });
    const ctx = createContext(["--browser-use=headless", "--prompt", "hello"]);

    assert.equal(await run(ctx, fixture.deps), 1);
    assert.match(ctx.stderr.output(), new RegExp(escapeRegExp(fixture.defaultStatePath), "u"));
    assert.match(ctx.stderr.output(), /--no-browser-state/u);
    assert.equal(fixture.appCount(), 0);
  }));

test("prints schema issues without values", () =>
  withFixture(async (fixture) => {
    const statePath = join(fixture.launchCwd, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        cookies: [{ ...VALID_STATE.cookies[0], value: SECRET_COOKIE_VALUE, sameSite: "lax" }],
      }),
    );
    const ctx = createContext([
      "--browser-use=headless",
      "--browser-state",
      statePath,
      "--prompt",
      "hello",
    ]);

    assert.equal(await run(ctx, fixture.deps), 1);
    assert.match(ctx.stderr.output(), /cookies\[0\]\.sameSite/u);
    assert.doesNotMatch(ctx.stderr.output(), new RegExp(SECRET_COOKIE_VALUE, "u"));
  }));

test("warns about unknown fields and loose permissions", () =>
  withFixture(async (fixture) => {
    const statePath = join(fixture.launchCwd, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({ ...VALID_STATE, cookies: [{ ...VALID_STATE.cookies[0], sourcePort: 443 }] }),
    );
    await chmod(statePath, 0o644);
    const ctx = createContext([
      "--browser-use=headless",
      "--browser-state",
      statePath,
      "--prompt",
      "hello",
    ]);

    assert.equal(await run(ctx, fixture.deps), 0);
    assert.match(ctx.stderr.output(), /cookies\[\]\.sourcePort/u);
    if (process.platform !== "win32") assert.match(ctx.stderr.output(), /chmod 600/u);
    assert.deepEqual(fixture.runtimeStatePaths, [statePath]);
  }));

test("passes the selection into the TUI browser runtime", () =>
  withFixture(async (fixture) => {
    const statePath = join(fixture.launchCwd, "state.json");
    await writeFile(statePath, JSON.stringify(VALID_STATE));
    await chmod(statePath, 0o600);
    const ctx = createContext(["tui", "--browser-use=headless", "--browser-state", statePath]);

    const exitCode = await run(ctx, {
      ...fixture.deps,
      runTui: async (options) => {
        await options.loadStartupOptions?.();
        return 0;
      },
    });

    assert.equal(exitCode, 0);
    assert.ok(fixture.appCount() > 0, "the TUI creates its first app at startup");
    assert.ok(fixture.runtimeStatePaths.length > 0);
    for (const path of fixture.runtimeStatePaths) assert.equal(path, statePath);
  }));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
