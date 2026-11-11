// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_TASK_NEW_BUTTON,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { startDraftFromProject, waitForProjectRow } from "#e2e/helpers/project-sidebar";
import { ensureUpstreamProviderForE2E, selectUpstreamModel } from "#e2e/helpers/upstream-provider";
import { prepareV4ConversationE2E, startNewV4Draft } from "#e2e/helpers/v4-conversation";

vi.mock("./e2e/helpers/desktop-app.js", () => ({
  DEFAULT_WORKSPACE: "/Users/dev/e2e/ZCodeProject",
  clickTestIdByDom: vi.fn(),
  waitForDefaultWorkspaceReady: vi.fn(),
}));
vi.mock("./e2e/helpers/project-sidebar.js", () => ({
  projectNameForWorkspace: () => "ZCodeProject",
  startDraftFromProject: vi.fn(),
  waitForProjectRow: vi.fn(),
}));
vi.mock("./e2e/helpers/upstream-provider.js", () => ({
  ensureUpstreamProviderForE2E: vi.fn(),
  selectUpstreamModel: vi.fn(),
  selectUpstreamThoughtLevel: vi.fn(),
}));
vi.mock("./e2e/helpers/occupation-onboarding.js", () => ({
  skipOccupationOnboardingIfPresent: vi.fn(),
}));

function renderDraft({
  path = DEFAULT_WORKSPACE,
  project = "ZCodeProject",
  session = "draft",
  text = "",
} = {}) {
  document.body.innerHTML = `<div data-testid="${testId(TID_V4_SESSION_PANE, "workspace-main")}" data-session-id="${session}"><div data-testid="${TID_V4_COMPOSER_INPUT}" contenteditable="true">${text}</div></div><button data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}">${project}</button>`;
  vi.stubGlobal("__zcodeTabStoreE2E", { getState: () => ({ activeWorkspacePath: path }) });
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as DOMRectList);
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
    waitUntil: async (predicate: () => Promise<boolean>, options: { timeoutMsg: string }) => {
      if (!(await predicate())) throw new Error(options.timeoutMsg);
    },
  });
  // 修复原因：准备流程末尾会等待 fixture workspace 的 slash 目录写入 session store；
  // jsdom 下没有真实 store，缺这个桩时 waitUntil 会直接判定 presentation 未就绪。
  vi.stubGlobal("__zcodeSessionStoreE2E", {
    getState: () => ({ workspaces: { [DEFAULT_WORKSPACE]: { slashCommands: [{}] } } }),
  });
  vi.mocked(startDraftFromProject).mockImplementation(async () => {
    renderDraft();
  });
  vi.mocked(clickTestIdByDom).mockImplementation(async () => {
    renderDraft({ project: "" });
  });
  renderDraft();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("V4 conversation E2E preparation", () => {
  it("reuses an empty fixture project draft across repeated preparation", async () => {
    await prepareV4ConversationE2E();
    await prepareV4ConversationE2E();
    expect(startDraftFromProject).not.toHaveBeenCalled();
    expect(clickTestIdByDom).not.toHaveBeenCalled();
    expect(selectUpstreamModel).toHaveBeenCalledTimes(2);
  });

  it.each([
    { path: "/Users/dev/e2e/.zcode/workspace/generated", project: "" },
    { session: "existing-session" },
    { text: "unsent draft from previous case" },
  ])("returns to the fixture project before checking its cwd: %j", async (state) => {
    renderDraft(state);
    await prepareV4ConversationE2E();
    expect(waitForProjectRow).toHaveBeenCalledWith(DEFAULT_WORKSPACE, expect.anything());
    expect(startDraftFromProject).toHaveBeenCalledExactlyOnceWith(DEFAULT_WORKSPACE);
    expect(vi.mocked(startDraftFromProject).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(waitForDefaultWorkspaceReady).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(startDraftFromProject).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ensureUpstreamProviderForE2E).mock.invocationCallOrder[0]!,
    );
    expect(clickTestIdByDom).not.toHaveBeenCalled();
  });

  it.each(["", "Another project"])(
    "reuses an empty fixture cwd without changing its project label: %s",
    async (project) => {
      renderDraft({ project });
      await prepareV4ConversationE2E();
      expect(startDraftFromProject).not.toHaveBeenCalled();
      expect(clickTestIdByDom).not.toHaveBeenCalled();
    },
  );

  it("preserves a caller-owned workspace when shell preparation is disabled", async () => {
    renderDraft({ path: "/remote/workspace", project: "Remote project" });
    await prepareV4ConversationE2E({ skipShellReady: true });
    expect(startDraftFromProject).not.toHaveBeenCalled();
    expect(waitForProjectRow).not.toHaveBeenCalled();
    expect(waitForDefaultWorkspaceReady).not.toHaveBeenCalled();
    expect(clickTestIdByDom).not.toHaveBeenCalled();
  });

  it("keeps explicit global New Task as a real click", async () => {
    await startNewV4Draft();
    expect(clickTestIdByDom).toHaveBeenCalledWith(TID_TASK_NEW_BUTTON, expect.anything());
    expect(startDraftFromProject).not.toHaveBeenCalled();
  });
});
