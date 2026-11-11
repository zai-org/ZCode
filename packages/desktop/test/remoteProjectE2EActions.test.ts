import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  connectRemoteSourceFromSettings,
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "./e2e/helpers/remote-project-actions.js";

vi.mock("./e2e/helpers/desktop-app.js", () => ({
  clickTestIdByDom: vi.fn(),
  waitForTestIdByDom: vi.fn(),
  readSettings: async () => ({
    sourceServers: [{ sourceServerId: "source-b", displayName: "device-b" }],
  }),
}));
vi.mock("./e2e/helpers/ssh-remote-p0.js", () => ({
  readRemoteTabSnapshot: async () => ({ workspacePath: "/work" }),
  waitForRemoteTab: vi.fn(),
  waitForSSHDirectoryStep: vi.fn(),
}));
vi.mock("./e2e/helpers/workspace-agent-warmup.js", () => ({ selectTaskOrganizeMode: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function install(document: object) {
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      runInNewContext(`(${fn.toString()})(...args)`, { document, args }),
    waitUntil: async (predicate: () => Promise<boolean>) => {
      if (!(await predicate())) throw new Error("入口不可用");
    },
  });
}

describe("项目导航 E2E 动作归属", () => {
  it("仅传目录时从项目行读取远端身份，等待该身份下的新草稿代次", async () => {
    const identity = "remote:server:source-b:/work";
    const workspace = { draftFocusVersion: 4 };
    const click = vi.fn(() => {
      workspace.draftFocusVersion++;
    });
    const input = { closest: () => ({ dataset: { sessionId: "draft" } }) };
    const document = {
      querySelectorAll: () => [input],
      querySelector: () => ({
        innerText: "work",
        querySelector: () => ({ click, disabled: false }),
      }),
    };
    const window = {
      __zcodeTabStoreE2E: { getState: () => ({ activeWorkspaceIdentity: identity }) },
      __zcodeSessionStoreE2E: { getState: () => ({ workspaces: { [identity]: workspace } }) },
    };
    vi.stubGlobal("$", () => ({
      waitForDisplayed: vi.fn(),
      getAttribute: async () => identity,
      moveTo: vi.fn(),
      $: () => ({ click }),
    }));
    const performActions = vi.fn();
    vi.stubGlobal("browser", {
      execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
        runInNewContext(`(${fn.toString()})(...args)`, { document, window, args }),
      waitUntil: async (predicate: () => Promise<boolean>) => {
        if (!(await predicate())) throw new Error("远端草稿代次未被识别");
      },
      performActions,
      releaseActions: vi.fn(),
    });
    await startDraftFromProject("/work");
    expect(click).toHaveBeenCalledOnce();
    // 项目详情 hover card 会盖住对话区：新建草稿后必须把指针移出项目行。
    expect(performActions).toHaveBeenCalledOnce();
    expect(workspace.draftFocusVersion).toBe(5);
  });

  it("项目视图已就绪时不再次切换菜单，避免相邻断开和重连反转菜单状态", async () => {
    const { selectTaskOrganizeMode } = await vi.importActual<
      typeof import("./e2e/helpers/workspace-agent-warmup.js")
    >("./e2e/helpers/workspace-agent-warmup.js");
    const click = vi.fn();
    vi.stubGlobal("$", (selector: string) => {
      if (selector === '[data-testid="project-section"]') return { isDisplayed: async () => true };
      return {
        click,
        waitForClickable: async () => {
          throw new Error("重复打开菜单");
        },
      };
    });
    await selectTaskOrganizeMode(["项目"]);
    expect(click).not.toHaveBeenCalled();
  });

  it("断开等待指定项目离线，不能把其它离线项目或旧设置投影当成完成", async () => {
    const identity = "remote:server:source-b:/work";
    const project = { dataset: { connectionState: "online" } };
    // RDUX-13：断开在设备行「更多」菜单里，菜单项文案带任务继续提示。
    const disconnect = {
      textContent: "断开断开后，远端任务会继续运行。",
      hasAttribute: () => false,
      click: vi.fn(),
    };
    vi.stubGlobal("$", () => ({ click: vi.fn() }));
    install({
      querySelectorAll: (selector: string) =>
        selector === '[role="menu"] [role="menuitem"]' ? [disconnect] : [],
      querySelector: (selector: string) => {
        if (selector === `[data-project-workspace-identity=${JSON.stringify(identity)}]`)
          return project;
        return { dataset: { connectionState: "offline" } };
      },
    });
    await expect(
      disconnectRemoteSource("source-b", "E2E_SCOPE", { workspaceIdentities: [identity] }),
    ).rejects.toThrow("目标项目未离线");
    expect(disconnect.click).toHaveBeenCalled();
    project.dataset.connectionState = "offline";
    await expect(
      disconnectRemoteSource("source-b", "E2E_SCOPE", { workspaceIdentities: [identity] }),
    ).resolves.toBeUndefined();
  });

  it("相同目录的新草稿只点击指定 Source 的项目，不使用全局任务入口", async () => {
    const clicks = [vi.fn(), vi.fn()];
    const identities = ["remote:server:a:/work", "remote:server:b:/work"];
    vi.stubGlobal("$", (selector: string) => {
      const index = identities.findIndex(
        (identity) => selector === `[data-project-workspace-identity=${JSON.stringify(identity)}]`,
      );
      if (index < 0) throw new Error(`未按 Source identity 定位项目：${selector}`);
      return {
        waitForDisplayed: vi.fn(),
        moveTo: vi.fn(),
        $: (action: string) => {
          expect(action).toBe('[data-testid="virtual-project-create-task"]');
          return { click: clicks[index] };
        },
      };
    });
    const performActions = vi.fn();
    vi.stubGlobal("browser", {
      execute: async () => true,
      waitUntil: async (predicate: () => Promise<boolean>) => {
        expect(await predicate()).toBe(true);
      },
      performActions,
      releaseActions: vi.fn(),
    });
    await startDraftFromProject("/work", { workspaceIdentity: identities[1] });
    expect(performActions).toHaveBeenCalledOnce();
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });

  it("断开匹配的设备，不误点先出现的其他 Source", async () => {
    const triggers: string[] = [];
    // 菜单项渲染在 Portal；归属由打开菜单的设备行决定，必须按 sourceServerId 定位触发按钮。
    vi.stubGlobal("$", (selector: string) => ({ click: async () => triggers.push(selector) }));
    const disconnect = { textContent: "断开", hasAttribute: () => false, click: vi.fn() };
    install({ querySelectorAll: () => [disconnect], querySelector: () => null });
    vi.stubGlobal("browser", {
      execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
        runInNewContext(`(${fn.toString()})(...args)`, {
          document: { querySelectorAll: () => [disconnect], querySelector: () => null },
          args,
        }),
      waitUntil: async (predicate: () => Promise<boolean>) => {
        if (!(await predicate())) throw new Error("入口不可用");
      },
      keys: vi.fn(),
    });
    await disconnectRemoteSource("source-b", "E2E_SCOPE");
    expect(triggers).toEqual([
      '[data-source-server-card="source-b"] [data-device-row-actions] button[aria-haspopup="menu"]',
    ]);
    expect(disconnect.click).toHaveBeenCalledOnce();
  });

  it("连接只点击指定 Source 设备行里的行内主操作", async () => {
    const connect = {
      innerText: "连接",
      disabled: false,
      getClientRects: () => [1],
      click: vi.fn(),
    };
    const selectors: string[] = [];
    install({
      querySelectorAll: (selector: string) => {
        selectors.push(selector);
        return selector.startsWith('[data-source-server-card="source-b"]') ? [connect] : [];
      },
    });
    await connectRemoteSourceFromSettings("source-b", "E2E_SCOPE");
    expect(selectors).toEqual([
      '[data-source-server-card="source-b"] [data-device-row-actions] button',
    ]);
    expect(connect.click).toHaveBeenCalledOnce();
  });

  it("相同路径不同 Source 的项目只重连指定 identity", async () => {
    const clicks = [vi.fn(), vi.fn()];
    let selected = -1;
    // 入口已改为真实 WebDriver 的项目菜单，夹具按权威 identity 选择行。
    vi.stubGlobal("$", (selector: string) => {
      if (selector === '[data-testid="virtual-project-connect"]')
        return { click: () => clicks[selected]() };
      const keys = ["remote:server:a:/work", "remote:server:b:/work"];
      const index = keys.findIndex(
        (key) => selector === `[data-project-workspace-identity=${JSON.stringify(key)}]`,
      );
      if (index < 0) throw new Error(`未知项目：${selector}`);
      return {
        waitForDisplayed: vi.fn(),
        moveTo: vi.fn(),
        $: (menu: string) => {
          expect(menu).toBe('[data-testid="virtual-project-menu"]');
          return {
            click: () => {
              selected = index;
            },
          };
        },
      };
    });
    await reconnectRemoteProject("remote:server:b:/work", "E2E_SCOPE");
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();
  });
});
