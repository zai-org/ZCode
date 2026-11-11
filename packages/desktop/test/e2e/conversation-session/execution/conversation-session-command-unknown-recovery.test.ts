import { clearAppData, readModelProviders, readSettings } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 120_000;
const PENDING_COMMAND_STORAGE_KEY = "zcode-v4-pending-commands:v1";
const PROMPT_MARKER = "E2E_COMMAND_UNKNOWN_RECOVERY";
const REPLY_MARKER = "COMMAND_UNKNOWN_RECOVERY_OK";
const UNKNOWN_TEXT = "E2E_UNKNOWN_COMMAND_MUST_NOT_REPLAY";
const COMPOSER_UNKNOWN_TEXT = "E2E_COMPOSER_UNKNOWN_MUST_NOT_REPLAY";
let queryProbeScriptId: string | undefined;

describe("PV4-25U：unknown command recovery 保留待确认", () => {
  after(async () => {
    if (queryProbeScriptId) {
      await browser.electron.execute(async (electron, identifier) => {
        const target = electron.BrowserWindow.getAllWindows().find((win) =>
          win.webContents.getURL().includes("/renderer/index.html"),
        );
        await target?.webContents.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", {
          identifier,
        });
      }, queryProbeScriptId);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("同一 workspace 的普通与 Composer unknown 均保留线索且不重放", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PROMPT_MARKER}: Reply with exactly "${REPLY_MARKER}" and no other text.`);
    // 提示也包含回答 marker，必须以 assistant 正文确认前置会话已完成，避免过早刷新。
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 60_000);
    const terminal = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "PV4-25U 前置 session 没有完成",
      60_000,
    );
    const sessionId = requireSessionId(terminal.sessionId);
    const commandId = `e2e-unknown-composer-${Date.now()}`;
    const plainCommandId = `${commandId}-plain`;
    const workspace = await readActiveWorkspace();

    // unknown 可能先于 Host 发送，不能再用普通记录被清除证明查询发生。
    // 在刷新前安装只观察回执的探针，确认真实查询完成后再检查两类记录。
    await seedPendingSendText(sessionId, commandId, COMPOSER_UNKNOWN_TEXT, true, workspace);
    await seedPendingSendText(sessionId, plainCommandId, UNKNOWN_TEXT, false, workspace);
    expect(await readPendingCommandIds()).toContain(commandId);
    expect(await readPendingCommandIds()).toContain(plainCommandId);
    queryProbeScriptId = await installUnknownQueryProbe([commandId, plainCommandId]);

    await browser.refresh();
    try {
      await waitForV4Pane(
        (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
        "PV4-25U unknown 刷新后没有恢复原 session",
        60_000,
      );
    } catch (cause) {
      // 正式默认轮在刷新后进入欢迎页；仅采集脱敏配置，不通过重载或重试绕过启动异常。
      const [providers, settings] = await Promise.all([readModelProviders(), readSettings()]);
      throw new Error(
        `PV4-25U 刷新恢复失败: ${JSON.stringify({
          providerFamilyDomain: settings.providerFamilyDomain,
          providers: providers.map((provider) => ({
            id: provider.id,
            enabled: provider.enabled,
            apiKeyPresent: Boolean(provider.apiKey),
            systemDisabledReason: provider.systemDisabledReason,
            models: provider.models.map((model) => ({
              id: model.id,
              disabledReason: model.disabledReason,
            })),
          })),
        })}`,
        { cause },
      );
    }

    await browser.waitUntil(
      () =>
        browser.execute(
          (commandIds) => {
            const seen = (window as Window & { __unknownQueryResults?: string[] })
              .__unknownQueryResults;
            return commandIds.every((id) => seen?.includes(id));
          },
          [commandId, plainCommandId],
        ),
      { timeout: 30_000, timeoutMsg: "未观察到普通与 Composer 命令的真实 unknown 查询回执" },
    );
    expect(await readPendingCommandIds()).toEqual(
      expect.arrayContaining([commandId, plainCommandId]),
    );

    expect(await hasPendingRecoveryBanner()).toBe(false);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain(COMPOSER_UNKNOWN_TEXT);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain(UNKNOWN_TEXT);

    await browser.execute(
      (storageKey) => window.localStorage.removeItem(storageKey),
      PENDING_COMMAND_STORAGE_KEY,
    );
  });
});

function requireSessionId(value: string | null): string {
  if (!value || value === "draft") {
    throw new Error(`PV4-25U 缺少 sessionId: ${String(value)}`);
  }
  return value;
}

async function seedPendingSendText(
  sessionId: string,
  commandId: string,
  text: string,
  withComposer = false,
  workspace?: { workspacePath: string; workspaceIdentity: string | null },
) {
  await browser.execute(
    (
      storageKey,
      currentSessionId,
      currentCommandId,
      currentText,
      now,
      includeComposer,
      currentWorkspace,
    ) => {
      const raw = window.localStorage.getItem(storageKey);
      const entries = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
      entries.push({
        commandId: currentCommandId,
        clientId: "e2e-command-recovery",
        sessionId: currentSessionId,
        issuedAt: now,
        expiresAt: now + 300_000,
        replay: {
          kind: "input",
          type: "sendText",
          payload: { text: currentText, attachments: [] },
        },
        ...(currentWorkspace ? { clientContext: { workspace: currentWorkspace } } : {}),
        ...(includeComposer
          ? {
              clientContext: {
                workspace: currentWorkspace,
                composer: {
                  scope: {
                    clientNamespace: "e2e-unknown",
                    hostId: "e2e-host",
                    projectId: null,
                  },
                  selection: {
                    modelSelection: {
                      providerId: "e2e-upstream",
                      modelId: "deepseek-v4-flash",
                    },
                    mode: "build",
                  },
                  order: now,
                  draftId: "00000000-0000-4000-8000-000000000001",
                  submittedText: currentText,
                },
              },
            }
          : {}),
      });
      window.localStorage.setItem(storageKey, JSON.stringify(entries));
    },
    PENDING_COMMAND_STORAGE_KEY,
    sessionId,
    commandId,
    text,
    Date.now(),
    withComposer,
    workspace ?? null,
  );
}

function readActiveWorkspace(): Promise<{
  workspacePath: string;
  workspaceIdentity: string | null;
}> {
  return browser.execute(() => {
    const tabs = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            activeWorkspacePath: string | null;
            activeWorkspaceIdentity: string | null;
          };
        };
      }
    ).__zcodeTabStoreE2E?.getState();
    if (!tabs?.activeWorkspacePath) throw new Error("PV4-25U 缺少活动 workspace 身份");
    return {
      workspacePath: tabs.activeWorkspacePath,
      workspaceIdentity: tabs.activeWorkspaceIdentity,
    };
  });
}

function readPendingCommandIds(): Promise<string[]> {
  return browser.execute((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    try {
      const entries = JSON.parse(raw) as Array<{ commandId?: unknown }>;
      return entries.flatMap((entry) =>
        typeof entry.commandId === "string" ? [entry.commandId] : [],
      );
    } catch {
      return ["<invalid-json>"];
    }
  }, PENDING_COMMAND_STORAGE_KEY);
}

async function installUnknownQueryProbe(commandIds: string[]): Promise<string> {
  // 只读 MessagePort 回执，不伪造 query 结果、不改变发送与恢复时序。
  const source = `(() => {
    const ids = ${JSON.stringify(commandIds)};
    const seen = window.__unknownQueryResults = [];
    const ports = new WeakSet();
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
      if (!ports.has(this)) {
        ports.add(this);
        this.addEventListener("message", event => {
          const data = event.data;
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
            : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
          if (!bytes) return;
          const wire = new TextDecoder().decode(bytes);
          if (!wire.includes('"result":"unknown"')) return;
          for (const id of ids) {
            if (wire.includes('"commandId":"' + id + '"') && !seen.includes(id)) seen.push(id);
          }
        });
      }
      return Reflect.apply(original, this, args);
    };
  })();`;
  return browser.electron.execute(async (electron, source) => {
    const target = electron.BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes("/renderer/index.html"),
    );
    if (!target) throw new Error("PV4-25U 缺少 renderer");
    const debug = target.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    await debug.sendCommand("Page.enable");
    const result = await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
    return result.identifier as string;
  }, source);
}

function hasPendingRecoveryBanner(): Promise<boolean> {
  return browser.execute(() => {
    const text = document.body.innerText;
    return (
      text.includes("CLI 重启前已提交的输入没有进入对话") ||
      text.includes("An input submitted before the CLI restarted did not reach the conversation")
    );
  });
}
