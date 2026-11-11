import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnId } from "@zcode/contracts";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
} from "@zcode/provider-node";
import { modelSelectionSchema, type ModelSelection, type ZCodeModelOption } from "@zcode/shared";
import { createCommandCenter, type CommandCenterApp } from "../src/command-center.js";
import { handleModelCommand } from "../src/command-center/handlers/model.js";
import { createTuiModelAvailabilityChecker } from "../src/tui-login-state.js";
import { readTuiSessionMetadata } from "../src/tui-prompt-handler-queries.js";
import { filterModelOptions, toPromptInput } from "../../tui/src/app-input.js";
import { completeModelCommand } from "../../tui/src/app-keyboard-helpers.js";
import { resolveComposerSubmittedText } from "../../tui/src/app-submit-resolver.js";
import { submitIdleTurn } from "../../tui/src/app-submit.js";
import type { TuiPromptInput, TuiOptions, TuiSubmitPromptResult } from "../../tui/src/types.js";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import { createCliModeState } from "../src/tui-command-state.js";
import type { RunDependencies } from "../src/cli-types.js";

function model(providerId = "personal", modelId = "vendor/model$literal:free"): ZCodeModelOption {
  return {
    ref: { providerId, modelId },
    label: "Reasoning Model",
    providerLabel: "Personal Gateway",
    reasoning: {
      levels: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      defaultLevel: "high",
    },
    properties: {
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
    },
  };
}

function fixture(initial?: ModelSelection) {
  let current = initial;
  let catalog = [model()];
  const writes: ModelSelection[] = [];
  const defaultWrites: ModelSelection[] = [];
  const app: Pick<
    CommandCenterApp,
    | "sessionId"
    | "traceId"
    | "getModel"
    | "getCurrentModelOption"
    | "getThoughtLevel"
    | "getLocale"
    | "listModels"
    | "listThoughtLevels"
    | "setModel"
    | "setThoughtLevel"
  > = {
    sessionId: "test-session",
    traceId: "test-trace",
    getModel: () => (current ? `${current.providerId}/${current.modelId}` : ""),
    getCurrentModelOption: () =>
      catalog.find(
        ({ ref }) => ref.providerId === current?.providerId && ref.modelId === current?.modelId,
      ),
    getThoughtLevel: () => current?.options?.reasoningLevel,
    getLocale: () => "en-US",
    listModels: () => catalog,
    listThoughtLevels: () =>
      catalog
        .find(
          ({ ref }) => ref.providerId === current?.providerId && ref.modelId === current?.modelId,
        )
        ?.reasoning?.levels.map(({ value }) => value) ?? [],
    async setModel(value) {
      assert.notEqual(typeof value, "string", "TUI must submit the complete structured selection");
      const selection = modelSelectionSchema.parse(value);
      assert.ok(selection.options?.reasoningLevel);
      writes.push(selection);
      const previousModel = app.getModel!()!;
      current = selection;
      return {
        model: app.getModel!()!,
        previousModel,
        thoughtLevel: selection.options?.reasoningLevel,
      };
    },
    async setThoughtLevel(level) {
      assert.ok(current);
      assert.ok((await app.listThoughtLevels!()).includes(level), "Unsupported reasoning effort");
      current = { ...current, options: { reasoningLevel: level } };
      return { thoughtLevel: level };
    },
  };
  const getApp = async () => app as CommandCenterApp;
  const deps = {
    getApp,
    resumeApp: getApp,
    hasSelectableModels: createTuiModelAvailabilityChecker(getApp),
    saveDefaultModelSelection: async (selection: ModelSelection) => {
      defaultWrites.push(selection);
    },
  };
  return {
    app: app as CommandCenterApp,
    deps,
    writes,
    defaultWrites,
    setCatalog: (next: ZCodeModelOption[]) => {
      catalog = next;
    },
  };
}

test("registry refs support provider search and Tab completion without legacy IDs", () => {
  const option = model();
  assert.deepEqual(filterModelOptions("/model Personal Gateway", [option]), [option]);
  assert.deepEqual(filterModelOptions("/model list", [option]), []);
  let completed = "";
  completeModelCommand([option], { selectedIndex: 0 }, (value) => {
    completed = value;
  });
  assert.equal(completed, "/model personal/vendor/model$literal:free");
});

test("model list renders the current registry contract", async () => {
  const f = fixture();
  const result = await handleModelCommand("list", f.deps);
  assert.match(result.response, /personal\/vendor\/model\$literal:free/);
  assert.match(result.response, /Personal Gateway/);
  assert.doesNotMatch(result.response, /undefined|\/model lite/);
  assert.equal(result.modelOptions?.length, 1);
  assert.equal(f.defaultWrites.length, 0);
});

test("picker reference survives composer submission and selects the catalog reasoning default", async () => {
  const f = fixture();
  const option = model();
  const text = resolveComposerSubmittedText({
    modelOption: option,
    slashCommands: [],
    submittedValue: "/model Personal",
  });
  let submitted: TuiPromptInput | undefined;
  const command = createCommandCenter(f.deps);
  const noop = () => {};
  await submitIdleTurn({
    text,
    modelSelection: option.ref,
    draftAttachments: [],
    turnRef: { current: undefined },
    applyResult: noop,
    applySessionEvent: noop,
    options: {
      submitPrompt: async (input, options) => {
        submitted = input;
        return command(input, options);
      },
    } as TuiOptions,
    setBusy: noop,
    setDraftAttachments: noop,
    setDraftValue: noop,
    setLastError: noop,
    setLiveModelText: noop,
    setMessages: noop,
    setSelection: noop,
    setSlashSelection: noop,
    setStatus: noop,
    setStatusDetails: noop,
  });
  assert.deepEqual(submitted, toPromptInput(text, [], option.ref));
  assert.deepEqual(f.writes, [{ ...option.ref, options: { reasoningLevel: "high" } }]);
  assert.deepEqual(f.defaultWrites, f.writes);
});

test("literal model ID wins before parsing a manual reasoning suffix", async () => {
  const f = fixture();
  await handleModelCommand("personal/vendor/model$literal:free", f.deps);
  assert.deepEqual(f.writes[0], { ...model().ref, options: { reasoningLevel: "high" } });
  f.setCatalog([model("personal", "plain")]);
  await handleModelCommand("personal/plain$low", f.deps);
  assert.deepEqual(f.writes[1], {
    providerId: "personal",
    modelId: "plain",
    options: { reasoningLevel: "low" },
  });
});

test("invalid reasoning and removed models fail before changing selection", async () => {
  const f = fixture();
  const invalid = await handleModelCommand("display", f.deps, {
    ...model().ref,
    options: { reasoningLevel: "invalid" },
  });
  assert.match(invalid.response, /Unable to switch model/);
  f.setCatalog([]);
  const removed = await handleModelCommand("display", f.deps, model().ref);
  assert.match(removed.response, /not available/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.defaultWrites.length, 0);
});

test("effort changes persist the same literal model identity and its new reasoning level", async () => {
  const f = fixture({ ...model().ref, options: { reasoningLevel: "high" } });
  const command = createCommandCenter(f.deps);
  const options = { abortSignal: new AbortController().signal };
  await command("/effort list", options);
  assert.equal(f.defaultWrites.length, 0);
  await command("/effort low", options);
  assert.deepEqual(f.defaultWrites, [{ ...model().ref, options: { reasoningLevel: "low" } }]);
  await command("/variant high", options);
  assert.equal(f.defaultWrites.at(-1)?.options?.reasoningLevel, "high");
  const invalid = await command("/effort invalid", options);
  assert.match(invalid.response, /Unable to switch reasoning effort/);
  assert.equal(f.defaultWrites.length, 2);
});

test("preference write failures keep successful model and effort changes visible", async () => {
  const f = fixture();
  const command = createCommandCenter({
    ...f.deps,
    saveDefaultModelSelection: async () => {
      throw new Error("test configuration write failure");
    },
  });
  const options = { abortSignal: new AbortController().signal };
  const selected = await command({ text: "/model selected", modelSelection: model().ref }, options);
  assert.match(selected.response, /Model switched to personal\/vendor\/model\$literal:free/);
  assert.match(
    selected.response,
    /could not be saved as the default.*test configuration write failure/,
  );
  assert.doesNotMatch(selected.response, /Unable to switch model/);
  assert.equal(selected.thoughtLevel, "high");
  const effort = await command("/effort low", options);
  assert.match(effort.response, /Reasoning effort switched to low/);
  assert.match(effort.response, /could not be saved as the default/);
  assert.doesNotMatch(effort.response, /Unable to switch reasoning effort/);
  assert.equal(effort.thoughtLevel, "low");
  assert.equal(f.app.getThoughtLevel?.(), "low");
});

test("TUI persists defaults through the shared repository across new sessions and restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-tui-model-selection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "provider_config.json");
  const seed = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  await seed.update((current) => ({ ...current, providerOrder: ["personal"] }));
  seed.dispose();
  const originalFile = JSON.parse(await readFile(filePath, "utf8"));
  const created: Array<{ options: ZCodeAppOptions; app: CommandCenterApp }> = [];
  const restoredSelection = { ...model().ref, options: { reasoningLevel: "high" } };
  let runtimeStarts = 0;
  const deps = {
    env: {},
    cwd: () => dir,
    skipUserConfig: true,
    loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
    createZCodeApp: async (options: ZCodeAppOptions) => {
      assert.equal(options.modelSelectionMode, "cli-default");
      const f = fixture(
        options.resume ? restoredSelection : options.configuredDefaultModelSelection,
      );
      f.app.resume = async () => ({
        appliedMessageCount: 0,
        directory: dir,
        interruptedToolCount: 0,
        messageCount: 0,
        partCount: 0,
      });
      f.app.forkFromCheckpoint = async () => ({ forkedSessionId: "forked", response: "Forked." });
      created.push({ options, app: f.app });
      return f.app;
    },
    startProcessProviderRegistryRuntime: async () => {
      runtimeStarts++;
      const personal = new NodePersonalProviderConfigRepository({
        filePath,
        pollingIntervalMs: false,
      });
      const repository = new NodeModelSelectionConfigRepository({ personalRepository: personal });
      return {
        runtime: { registryService: {} },
        modelSelectionConfigRepository: repository,
        configuredDefaultModelSelection: await repository.read(),
        dispose() {
          repository.dispose();
          personal.dispose();
        },
      };
    },
  } as unknown as RunDependencies;
  const options = { abortSignal: new AbortController().signal };
  const readFileConfig = async () => JSON.parse(await readFile(filePath, "utf8"));
  const handler = createTuiSubmitPrompt(deps, createCliModeState(), "test");
  try {
    await handler({ text: "/model selected", modelSelection: model().ref }, options);
    assert.deepEqual((await readFileConfig()).config.defaultModelSelection, restoredSelection);
    const activeTurnResult = await handler.sendInput!("/effort low", {});
    assert.equal(activeTurnResult.kind, "command_result");
    const expected = { ...model().ref, options: { reasoningLevel: "low" } };
    assert.deepEqual((await readFileConfig()).config.defaultModelSelection, expected);
    await handler("/new", options);
    assert.deepEqual(created.at(-1)?.options.configuredDefaultModelSelection, expected);
    assert.equal(created.at(-1)?.app.getThoughtLevel?.(), "low");
    assert.equal(
      runtimeStarts,
      1,
      "new sessions reuse the process runtime and reread its repository",
    );
    await handler("/resume historical-session", options);
    assert.equal(created.at(-1)?.options.resume, true);
    assert.equal(created.at(-1)?.options.runtimeConfig?.modelSelection, undefined);
    assert.equal(created.at(-1)?.app.getThoughtLevel?.(), "high");
    await handler("/fork", options);
    assert.equal(created.at(-1)?.options.sessionId, "forked");
    assert.deepEqual((await readFileConfig()).config.defaultModelSelection, expected);
    const { defaultModelSelection: _selection, ...preservedConfig } = (await readFileConfig())
      .config;
    assert.deepEqual(preservedConfig, originalFile.config);
  } finally {
    await handler.close?.();
  }
  const restarted = createTuiSubmitPrompt(deps, createCliModeState(), "test");
  try {
    const metadata = await restarted.getSessionMetadata!();
    assert.equal(metadata.model, "personal/vendor/model$literal:free");
    assert.equal(metadata.thoughtLevel, "low");
    assert.equal(runtimeStarts, 2, "restart opens a new repository instance");
  } finally {
    await restarted.close?.();
  }
});

test("fresh metadata follows the registry without requiring Coding Plan credentials", async () => {
  const f = fixture();
  const hasModels = createTuiModelAvailabilityChecker(f.deps.getApp);
  assert.equal(await hasModels(), true);
  const ready = await readTuiSessionMetadata(f.app);
  assert.equal(ready.loginRequired, false);
  assert.equal(ready.modelOptions?.length, 1);
  f.setCatalog([]);
  assert.equal(await hasModels(), false);
  assert.deepEqual((await readTuiSessionMetadata(f.app)).modelOptions, []);
});

test("restoring incomplete reasoning does not fill a default or retain the previous effort", async () => {
  const f = fixture(model().ref);
  const metadata = await readTuiSessionMetadata(f.app);
  assert.equal(metadata.thoughtLevel, undefined);
  assert.equal(Object.hasOwn(metadata, "thoughtLevel"), true);
  assert.deepEqual(
    metadata.effortOptions?.map(({ id }) => id),
    ["low", "high"],
  );
  assert.equal(f.writes.length, 0);
});

test("personal providers can submit prompts without a Coding Plan login", async () => {
  const f = fixture();
  let submitted = false;
  f.app.submitPrompt = async () => {
    submitted = true;
    return { response: "ok" };
  };
  const result = await createCommandCenter(f.deps)("hello", {
    abortSignal: new AbortController().signal,
  });
  assert.equal(submitted, true);
  assert.equal(result.response, "ok");
});

test("active-turn model picks use the same configuration command instead of becoming model input", async () => {
  const f = fixture();
  let forwarded = false;
  f.app.sendInput = async () => {
    forwarded = true;
    throw new Error("Model command forwarded to Agent");
  };
  const deps = {
    env: {},
    cwd: () => process.cwd(),
    skipUserConfig: true,
    loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
    createZCodeApp: async () => f.app,
    startProcessProviderRegistryRuntime: async () => ({
      runtime: { registryService: {} },
      modelSelectionConfigRepository: {
        read: async () => undefined,
        saveConfiguredDefault: f.deps.saveDefaultModelSelection,
      },
      dispose() {},
    }),
  } as unknown as RunDependencies;
  const handler = createTuiSubmitPrompt(deps, createCliModeState(), "test");
  try {
    const result = await handler.sendInput!(
      { text: "/model display", modelSelection: model().ref },
      {},
    );
    assert.equal(forwarded, false);
    assert.equal(result.kind, "command_result");
    assert.deepEqual(f.writes, [{ ...model().ref, options: { reasoningLevel: "high" } }]);
    assert.deepEqual(f.defaultWrites, f.writes);
    await handler.sendInput!("/effort low", {});
    assert.equal(forwarded, false);
    assert.equal(f.app.getThoughtLevel?.(), "low");
    assert.deepEqual(f.defaultWrites.at(-1), {
      ...model().ref,
      options: { reasoningLevel: "low" },
    });
  } finally {
    await handler.close?.();
  }
});

test("terminal picker refreshes an empty catalog and switches model and effort with keyboard input", async () => {
  const React = await import("react");
  const { createTestRenderer } = await import("@mbears/opentui-core/testing");
  const { createRoot } = await import("@mbears/opentui-react");
  const { TuiApp } = await import("../../tui/src/app.js");
  const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const f = fixture();
  const terminal = await createTestRenderer({
    width: 110,
    height: 32,
    targetFps: 30,
    screenMode: "alternate-screen",
    useThread: false,
  });
  const root = createRoot(terminal.renderer);
  let finishTurn: ((result: TuiSubmitPromptResult) => void) | undefined;
  const options: TuiOptions = {
    noColor: true,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    initialModel: "old/model",
    initialThoughtLevel: "low",
    locale: "en-US",
    modelOptions: [],
    listModelOptions: async () => f.app.listModels!(),
    submitPrompt: async (input, options) => {
      const text = typeof input === "string" ? input : input.text;
      if (text === "work")
        return new Promise((resolve) => {
          finishTurn = resolve;
        });
      if (text === "/resume incomplete") {
        return {
          ...(await readTuiSessionMetadata(fixture(model().ref).app)),
          response: "Restored incomplete session.",
        };
      }
      return createCommandCenter(f.deps)(input, options);
    },
    sendInput: async (input, options) => {
      const text = typeof input === "string" ? input : input.text;
      if (text.startsWith("/")) {
        return {
          kind: "command_result",
          result: await createCommandCenter(f.deps)(input, {
            ...options,
            abortSignal: options.abortSignal ?? new AbortController().signal,
          }),
        };
      }
      return {
        kind: "queued",
        pendingInputId: "queued-input",
        queueLength: 1,
        turnId: "test-turn" as TurnId,
      };
    },
  };
  const action = async (run: () => void | Promise<void>) => {
    await React.act(async () => {
      await run();
    });
    await terminal.renderOnce();
  };
  try {
    await action(() =>
      root.render(
        React.createElement(TuiApp, {
          options,
          onExit() {},
          hasCopyableSelection: () => false,
          copySelection: async () => ({ kind: "empty" as const }),
        }),
      ),
    );
    await action(() => terminal.mockInput.typeText("/model Personal Gateway"));
    assert.match(terminal.captureCharFrame(), /Reasoning Model/);
    assert.match(terminal.captureCharFrame(), /Personal Gateway/);
    await action(() => terminal.mockInput.pressEnter());
    assert.deepEqual(f.writes[0], { ...model().ref, options: { reasoningLevel: "high" } });
    assert.match(terminal.captureCharFrame(), /personal \| high/);
    await action(() => terminal.mockInput.typeText("/effort low"));
    await action(() => terminal.mockInput.pressEnter());
    assert.equal(f.app.getThoughtLevel?.(), "low");
    assert.match(terminal.captureCharFrame(), /personal \| low/);
    const replacement = {
      ...model("replacement", "next"),
      label: "Replacement Model",
      providerLabel: "Replacement Gateway",
    };
    f.setCatalog([replacement]);
    await action(() => terminal.mockInput.typeText("/model Replacement"));
    assert.match(terminal.captureCharFrame(), /Replacement Model/);
    await action(() => terminal.mockInput.pressTab());
    assert.match(terminal.captureCharFrame(), /\/model replacement\/next/);
    await action(() => terminal.mockInput.pressEnter());
    assert.deepEqual(f.writes[1], { ...replacement.ref, options: { reasoningLevel: "high" } });
    await action(() => terminal.mockInput.typeText("/resume incomplete"));
    await action(() => terminal.mockInput.pressEnter());
    assert.match(terminal.captureCharFrame(), /personal \| -/);
    await action(() => terminal.mockInput.typeText("work"));
    await action(() => terminal.mockInput.pressEnter());
    await action(() => terminal.mockInput.typeText("queued instruction"));
    await action(() => terminal.mockInput.pressEnter());
    assert.match(terminal.captureCharFrame(), /queued instruction/);
    await action(() => terminal.mockInput.typeText("/model Replacement"));
    await action(() => terminal.mockInput.pressEnter());
    assert.match(terminal.captureCharFrame(), /queued instruction/);
    assert.match(terminal.captureCharFrame(), /replacement \| high/);
    await action(() => terminal.mockInput.typeText("/effort low"));
    await action(() => terminal.mockInput.pressEnter());
    assert.match(terminal.captureCharFrame(), /queued instruction/);
    assert.match(terminal.captureCharFrame(), /replacement \| low/);
    await action(async () => {
      finishTurn?.({ response: "Work completed." });
    });
  } finally {
    await React.act(() => root.unmount());
    terminal.renderer.destroy();
    if (previousActEnvironment === undefined) delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
