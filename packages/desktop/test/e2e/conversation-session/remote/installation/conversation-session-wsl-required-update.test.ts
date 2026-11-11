import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import {
  PlatformChannels,
  ServiceChannels,
  sourceServerManagementSnapshotSchema,
  type RemoteTarget,
} from "@zcode/shared";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_WSL_DISTRO_SELECT,
  TID_WSL_USER_INPUT,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  clearAppData,
  waitForWorkspaceApp,
  DEFAULT_WORKSPACE,
} from "#e2e/helpers/desktop-app";

import { loginWithApiKey } from "#e2e/helpers/v4-conversation";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";

const marker = "E2E_WSL_REQUIRED_UPDATE";
const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const legacyProfileId = "49ae277d-00f0-45bc-bc0e-c2097f56aac4";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const target = { kind: "wsl", distro: "Ubuntu", user: "dev" } as const;

interface WslUpdateRpcFixture {
  requests: number[][];
  respond(index: number, response: number[]): void;
  restore(): void;
}
interface WslUpdateMainFixture {
  targets: RemoteTarget[];
  confirmed: boolean[];
  defaultTarget: { kind: "wsl"; distro: string; user: string };
  resolvedTargets: RemoteTarget[];
  restore(): void;
}
declare global {
  interface Window {
    __wslUpdateRpcFixture?: WslUpdateRpcFixture;
  }
  var __wslUpdateMainFixture: WslUpdateMainFixture | undefined;
}

// 只替换远端输入：真实 Electron IPC、Root、向导、RPC 和按钮照常执行。
// 当前环境不启动 WSL；此用例证明身份交接与按钮行为，不代表真实 archive 安装。
type WslScenario = "upgrade" | "install" | "form";

async function installFixture(scenario: WslScenario = "upgrade") {
  await browser.electron.execute(
    (electron, channel, profileId, scenario) => {
      type Handler = (...args: unknown[]) => Promise<unknown>;
      const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error("ConnectRemote handler unavailable");
      const fixture: WslUpdateMainFixture = {
        targets: [],
        confirmed: [],
        defaultTarget: { kind: "wsl", distro: "Ubuntu", user: "dev" },
        resolvedTargets: [],
        restore() {
          handlers.set(channel, original);
          delete globalThis.__wslUpdateMainFixture;
        },
      };
      handlers.set(channel, async (_event, request) => {
        const input = request as { target: RemoteTarget; confirmSourceServerInstall?: boolean };
        fixture.targets.push(input.target);
        fixture.confirmed.push(input.confirmSourceServerInstall === true);
        const resolved =
          input.target.kind === "wsl"
            ? {
                kind: "wsl" as const,
                distro: input.target.distro ?? fixture.defaultTarget.distro,
                user: input.target.user ?? fixture.defaultTarget.user,
              }
            : input.target;
        fixture.resolvedTargets.push(resolved);
        if (scenario === "form" || input.confirmSourceServerInstall) {
          return {
            success: false,
            reasonCode: "remote-host-unreachable",
            error: "E2E_WSL_EXPECTED_STOP_AFTER_CONNECT",
          };
        }
        if (scenario === "install") {
          return {
            success: false,
            reasonCode: "source-server-install-required",
            error: "install required",
            profileId,
            resolvedWslTarget: resolved,
          };
        }
        return {
          success: false,
          reasonCode: "source-server-upgrade-required",
          retryable: false,
          error: "Source Server 3.12.0 must be upgraded to at least 3.15.1",
          profileId,
          ...(resolved.kind === "wsl" ? { resolvedWslTarget: resolved } : {}),
        };
      });
      globalThis.__wslUpdateMainFixture = fixture;
    },
    PlatformChannels.ConnectRemote,
    profileId,
    scenario,
  );
  await browser.execute((channel) => {
    const original = MessagePort.prototype.postMessage;
    const held = new Map<number, MessagePort>();
    const fixture: WslUpdateRpcFixture = {
      requests: [],
      respond(index, response) {
        const port = held.get(index);
        if (!port) throw new Error("Missing fixture request");
        held.delete(index);
        port.dispatchEvent(new MessageEvent("message", { data: Uint8Array.from(response) }));
      },
      restore() {
        MessagePort.prototype.postMessage = original;
        delete window.__wslUpdateRpcFixture;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (
          text.includes(channel) &&
          ["getSnapshot", "getRecentOperationLogs", "updateSource"].some((method) =>
            text.includes(method),
          )
        ) {
          held.set(fixture.requests.length, this);
          fixture.requests.push(Array.from(message));
          return;
        }
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__wslUpdateRpcFixture = fixture;
  }, ServiceChannels.SourceServerManagement);
}

function createPump(scenario: WslScenario, input: RemoteTarget, editedTarget?: RemoteTarget) {
  let consumed = 0;
  const updates: unknown[] = [];
  const pump = async () => {
    const targets = await browser.electron.execute(
      () => globalThis.__wslUpdateMainFixture!.targets,
    );
    const connected = targets.length > 0;
    const connectedTarget = editedTarget ?? (input.kind === "wsl" ? target : input);
    const snapshot = sourceServerManagementSnapshotSchema.parse({
      generation: connected ? 2 : 1,
      servers: [
        {
          sourceServerId,
          displayName: marker,
          preferredProfileId: connected ? profileId : legacyProfileId,
        },
      ],
      profiles: [
        {
          profileId: connected ? profileId : legacyProfileId,
          sourceServerId,
          transport: connected ? connectedTarget.kind : input.kind,
          target: connected ? connectedTarget : input,
          createdAt: 1,
        },
      ],
      states: connected
        ? [
            {
              profileId,
              sourceServerId,
              state:
                scenario === "install"
                  ? "needs-install"
                  : scenario === "form"
                    ? "failed"
                    : "needs-upgrade",
              ...(scenario === "install"
                ? {
                    installPreview: {
                      version: "3.15.1",
                      sizeBytes: 1048576,
                      installPath: "/home/dev/.zcode/server",
                    },
                  }
                : {}),
              ...(scenario === "upgrade"
                ? {
                    upgradeTarget: "server",
                    updateAvailability: "required",
                    currentVersion: "3.12.0",
                    availableVersion: "3.15.1",
                    minimumVersion: "3.15.1",
                  }
                : {}),
              updatedAt: 1,
            },
          ]
        : [],
      workspaceHistory: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    });
    const requests = await browser.execute(() => window.__wslUpdateRpcFixture!.requests);
    while (consumed < requests.length) {
      const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(requests[consumed]!)));
      const header = deserialize(reader) as [number, number, string, string];
      const args = deserialize(reader) as unknown[];
      expect(header[0]).toBe(100);
      if (header[3] === "updateSource") updates.push(args[0]);
      const writer = new BufferWriter();
      serialize(writer, [201, header[1]]);
      serialize(writer, header[3] === "getRecentOperationLogs" ? [] : snapshot);
      await browser.execute(
        (index, response) => window.__wslUpdateRpcFixture!.respond(index, response),
        consumed++,
        Array.from(writer.buffer.buffer),
      );
    }
    return targets;
  };
  return { pump, updates };
}

const wslInputs = [
  { kind: "wsl" },
  { kind: "wsl", distro: "Ubuntu" },
  { kind: "wsl", user: "dev" },
  target,
] as const;

async function clickWizardAction(labels: string[]) {
  const clicked = await browser.execute((labels) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
    ).find((item) => labels.includes(item.innerText.trim()) && !item.disabled);
    button?.click();
    return Boolean(button);
  }, labels);
  expect(clicked).toBe(true);
}

async function openFixtureDevice(pump: () => Promise<RemoteTarget[]>) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
  await browser.waitUntil(
    async () => {
      await pump();
      return browser.execute((marker) => {
        const card = Array.from(document.querySelectorAll("[data-source-server-card]")).find(
          (item) => item.textContent?.includes(marker),
        );
        const button = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
          (item) => /^(连接|Connect)$/u.test(item.innerText.trim()) && !item.disabled,
        );
        button?.click();
        return Boolean(button);
      }, marker);
    },
    { timeout: 30_000, timeoutMsg: "WSL 夹具连接入口未出现" },
  );
}

describe(`${marker}: WSL 默认参数与连接目标`, () => {
  let originalUserAgent = "";
  before(async () => {
    originalUserAgent = await browser.execute(() => navigator.userAgent);
    // 使用 Windows UI 门禁与合成 WSL 输入，macOS 也能覆盖真实表单；不冒充原生 WSL 安装。
    await browser.electron.execute((electron, ua) => {
      const win = electron.BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().includes("/renderer/index.html"),
      );
      if (!win) throw new Error("Renderer window unavailable");
      win.webContents.setUserAgent(ua.replace(/\([^)]*\)/u, "(Windows NT 10.0; Win64; x64)"));
    }, originalUserAgent);
    await browser.refresh();
  });
  beforeEach(async () => {
    // 刷新后缓存账号可能失效并回到登录页；只在实际出现登录页时完成现有登录动作。
    try {
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    } catch (error) {
      const login = await browser.execute(() =>
        Boolean(document.querySelector('[data-testid="login-use-api-key-button"]')),
      );
      if (!login) throw error;
      await loginWithApiKey();
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    }
  });
  afterEach(async () => {
    await browser.execute(() => window.__wslUpdateRpcFixture?.restore());
    await browser.electron.execute(() => globalThis.__wslUpdateMainFixture?.restore());
    await browser.refresh();
  });
  after(async () => {
    await browser.execute(() => window.__wslUpdateRpcFixture?.restore());
    await browser.electron.execute(() => globalThis.__wslUpdateMainFixture?.restore());
    await browser.electron.execute((electron, ua) => {
      const win = electron.BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().includes("/renderer/index.html"),
      );
      win?.webContents.setUserAgent(ua);
    }, originalUserAgent);
    await clearAppData();
  });
  it("WSL-UPGRADE-01：自动更新与显式按钮都使用实际 Profile，重连固定实际用户", async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await installFixture();
    const { pump, updates } = createPump("upgrade", { kind: "wsl", distro: "Ubuntu" });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
    await browser.waitUntil(
      async () => {
        await pump();
        return browser.execute((marker) => {
          const card = Array.from(document.querySelectorAll("[data-source-server-card]")).find(
            (item) => item.textContent?.includes(marker),
          );
          const button = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
            (item) => /^(连接|Connect)$/u.test(item.innerText.trim()) && !item.disabled,
          );
          button?.click();
          return Boolean(button);
        }, marker);
      },
      { timeout: 30_000, timeoutMsg: "WSL 夹具连接入口未出现" },
    );
    await browser.waitUntil(
      async () => {
        const targets = await pump();
        return (
          targets.length === 2 &&
          browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'),
            ).some(
              (button) =>
                /^(更新远端|Update server)$/u.test(button.innerText.trim()) && !button.disabled,
            ),
          )
        );
      },
      { timeout: 30_000, timeoutMsg: "WSL 自动升级未完成一次受保护更新并提供显式入口" },
    );
    expect(updates).toEqual([{ profileId, expectedTarget: target, force: false }]);
    const clicked = await browser.execute(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'),
      ).find(
        (button) => /^(更新远端|Update server)$/u.test(button.innerText.trim()) && !button.disabled,
      );
      button?.click();
      return Boolean(button);
    });
    expect(clicked).toBe(true);
    await browser.waitUntil(async () => (await pump()).length === 3, { timeout: 30_000 });
    expect(updates).toEqual([
      { profileId, expectedTarget: target, force: false },
      { profileId, expectedTarget: target, force: false },
    ]);
    const targets = await browser.electron.execute(
      () => globalThis.__wslUpdateMainFixture!.targets,
    );
    expect(targets).toEqual([{ kind: "wsl", distro: "Ubuntu" }, target, target]);
    const artifacts = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!);
    await mkdir(artifacts, { recursive: true });
    await browser.saveScreenshot(resolve(artifacts, "wsl-required-update.png"));
    await writeFile(
      resolve(artifacts, "wsl-required-update.json"),
      JSON.stringify(
        { marker, fixture: "synthetic-wsl-connect-and-source-rpc", updates, targets },
        null,
        2,
      ),
    );
  });
  // 占位密钥也使用隔离运行目录，避免硬编码系统临时路径触发跨平台路径守卫。
  const privateKeyPath = resolveE2ERuntimePath("wsl-required-update", "probe-key");
  const editedTargets = [
    [
      { kind: "ssh", host: "a.example.com", username: "dev", privateKeyPath },
      { kind: "ssh", host: "b.example.com", username: "dev", privateKeyPath },
    ],
    [target, { kind: "wsl", distro: "Ubuntu", user: "other" }],
    [
      { kind: "docker", container: "a" },
      { kind: "docker", container: "b" },
    ],
  ] as const;
  for (const [input, edited] of editedTargets) {
    it(`REMOTE-UPGRADE-IDENTITY-01 ${input.kind}: 同 ID 改址只提供重试`, async function () {
      this.timeout(90_000);
      await installFixture("upgrade");
      const { pump, updates } = createPump("upgrade", input, edited);
      await openFixtureDevice(pump);
      await browser.waitUntil(
        async () => {
          await pump();
          return browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'),
            ).some((button) => /^(重试|Retry)$/u.test(button.innerText.trim()) && !button.disabled),
          );
        },
        { timeout: 30_000, timeoutMsg: "改址后未显示显式重试" },
      );
      expect(updates).toEqual([]);
      const targets = await browser.electron.execute(
        () => globalThis.__wslUpdateMainFixture!.targets,
      );
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject(input);
      const artifacts = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!);
      await browser.saveScreenshot(resolve(artifacts, `upgrade-target-changed-${input.kind}.png`));
      await writeFile(
        resolve(artifacts, `upgrade-target-changed-${input.kind}.json`),
        JSON.stringify({ input, edited, targets, updates }, null, 2),
      );
    });
  }
  for (const [index, input] of wslInputs.entries()) {
    it(`WSL-INSTALL-01 ${index}: 安装预览与确认绑定实际身份`, async function () {
      this.timeout(90_000);
      await installFixture("install");
      const { pump } = createPump("install", input);
      await openFixtureDevice(pump);
      await browser.waitUntil(
        async () => {
          await pump();
          return browser.execute(
            () =>
              document.querySelector('[data-testid="remote-install-path"]')?.textContent ===
              "/home/dev/.zcode/server",
          );
        },
        { timeout: 30_000, timeoutMsg: "实际安装预览未出现" },
      );
      expect(await $('[data-testid="ssh-dialog"]').getText()).toContain("WSL · Ubuntu · dev");
      await browser.electron.execute(() => {
        globalThis.__wslUpdateMainFixture!.defaultTarget = {
          kind: "wsl",
          distro: "Debian",
          user: "other",
        };
      });
      await clickWizardAction(["安装并继续", "Install and continue"]);
      await browser.waitUntil(async () => (await pump()).length === 2, { timeout: 30_000 });
      const facts = await browser.electron.execute(() => ({
        targets: globalThis.__wslUpdateMainFixture!.targets,
        resolvedTargets: globalThis.__wslUpdateMainFixture!.resolvedTargets,
        confirmed: globalThis.__wslUpdateMainFixture!.confirmed,
      }));
      expect(facts.targets).toEqual([input, target]);
      expect(facts.resolvedTargets).toEqual([target, target]);
      expect(facts.confirmed).toEqual([false, true]);
      const artifacts = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!);
      await browser.saveScreenshot(resolve(artifacts, `wsl-install-${index}.png`));
      await writeFile(
        resolve(artifacts, `wsl-install-${index}.json`),
        JSON.stringify({ input, ...facts }, null, 2),
      );
    });
    it(`WSL-FORM-01 ${index}: 返回配置与再次提交保留默认参数组合`, async function () {
      this.timeout(90_000);
      await installFixture("form");
      const { pump } = createPump("form", input);
      await openFixtureDevice(pump);
      await browser.waitUntil(
        async () => {
          await pump();
          return browser.execute(() =>
            document
              .querySelector('[data-testid="ssh-error"]')
              ?.textContent?.includes("E2E_WSL_EXPECTED_STOP_AFTER_CONNECT"),
          );
        },
        { timeout: 30_000 },
      );
      await clickWizardAction(["返回配置", "Back to configuration"]);
      const distro = $(`[data-testid="${TID_WSL_DISTRO_SELECT}"]`);
      await distro.waitForDisplayed();
      expect(await distro.getValue()).toBe("distro" in input ? input.distro : "");
      expect(await $(`[data-testid="${TID_WSL_USER_INPUT}"]`).getValue()).toBe(
        "user" in input ? input.user : "",
      );
      await $('[data-testid="ssh-dialog"] button[type="submit"]').click();
      await browser.waitUntil(async () => (await pump()).length === 2, { timeout: 30_000 });
      const targets = await browser.electron.execute(
        () => globalThis.__wslUpdateMainFixture!.targets,
      );
      expect(targets).toEqual([input, input]);
      await writeFile(
        resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `wsl-form-${index}.json`),
        JSON.stringify({ targets }, null, 2),
      );
    });
  }
});
