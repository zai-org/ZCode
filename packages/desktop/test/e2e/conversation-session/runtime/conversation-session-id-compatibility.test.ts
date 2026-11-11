import { projectSectionSelector } from "#e2e/helpers/project-sidebar";
import { randomUUID } from "node:crypto";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { admitCreateBeforeExit } from "#e2e/helpers/session-creation-resend";
import { startE2ENetworkCaptureProxy } from "#e2e/helpers/network-capture-proxy";
import { verifySessionCreationRetries } from "#e2e/helpers/session-creation-retries";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  TID_TASK_ITEM,
  TID_PROMPT_SUGGESTION_OPTION,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared/test-ids";
import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  selectRegistryProviderModelById,
} from "#e2e/helpers/upstream-provider";
import {
  clickV4SlashOption,
  getV4ComposerText,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";

const CASE_NAME = "conversation-session-id-compatibility";
const LEGACY_IDS = [
  "session_0123456789abcdef0123456789abcdef",
  "session_12345678-1234-4234-8234-123456789abc",
];
const paths = getE2EAppDataPaths();
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? `.e2e-artifacts/${CASE_NAME}`);
let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;
const facts: Record<string, unknown> = {};

describe("SID01–SID05: 会话 ID 创建、历史引用和完整重启恢复", () => {
  before(async () => {
    replay = await startConversationModelProviderReplayServer(CASE_NAME);
  });
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "session-id-facts.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await replay?.stop();
  });

  it("新建 sess_，两种旧 ID 重启后保持身份、可引用读取和继续发送", async function () {
    this.timeout(480000);
    await mkdir(artifactDir, { recursive: true });
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: UPSTREAM_PROVIDER_ID,
      name: UPSTREAM_PROVIDER_NAME,
      apiFormat: "anthropic-messages",
      models: [UPSTREAM_MODEL],
    });
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectRegistryProviderModelById(UPSTREAM_MODEL, {
      providerId: UPSTREAM_PROVIDER_ID,
      providerName: UPSTREAM_PROVIDER_NAME,
      includePlainModelFallback: false,
    });
    await sendV4Prompt("E2E_SID_NEW: Reply E2E_SID_NEW_OK.");
    await waitForV4AssistantMessageContaining("E2E_SID_NEW_OK", 60000);
    const created = await waitForV4Pane(
      (s) => Boolean(s.sessionId && s.sessionId !== "draft") && !s.canStop,
      "新会话未完成",
      60000,
    );
    const newId = created.sessionId!;
    facts.newId = newId;
    expect(newId).toMatch(
      /^sess_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );

    // 旧格式仅播种到隔离夹具，必须等旧 Host/Agent 全部退出；产品代码不迁移任何主键。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => seedLegacySessions(newId),
    });
    facts.afterFirstRestart = readIdentityFacts(newId);
    for (const [index, id] of LEGACY_IDS.entries()) {
      await selectV4TaskById(id, 30000);
      await waitForV4TimelineContaining(`E2E_SID_HISTORY_${index}`, 30000);
      const restored = await waitForV4Pane(
        (s) => s.sessionId === id && !s.canStop,
        "旧 ID 未恢复",
        30000,
      );
      expect(restored.sessionId).toBe(id);
      await sendV4Prompt(`E2E_SID_FOLLOW_${index}: Reply E2E_SID_FOLLOW_OK_${index}.`);
      await waitForV4AssistantMessageContaining(`E2E_SID_FOLLOW_OK_${index}`, 60000);
      await waitForV4Pane((s) => s.sessionId === id && !s.canStop, "旧会话继续发送未结束", 60000);
    }

    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    for (const [index, id] of LEGACY_IDS.entries()) {
      await selectV4TaskById(id, 30000);
      await waitForV4TimelineContaining(`E2E_SID_HISTORY_${index}`, 30000);
      await waitForV4TimelineContaining(`E2E_SID_FOLLOW_OK_${index}`, 30000);
    }
    facts.afterSecondRestart = readIdentityFacts(newId);

    for (const [index, id] of LEGACY_IDS.entries()) {
      await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#");
      const option = await waitForV4MentionOptionPrefix(`session:${id}`);
      expect(option).toBe(`session:${id}`);
      expect(await clickV4SlashOption(option)).toBe(true);
      const mention = (await getV4ComposerText())!;
      expect(mention).toContain(`#${id}`);
      await sendV4Prompt(
        `E2E_SID_REFERENCE_${index}: ${mention} Read its original decision with ReadSession.`,
      );
      await waitForUpstreamRequest(
        {
          includes: [
            `E2E_SID_REFERENCE_${index}`,
            "The user referenced prior ZCode session(s)",
            id,
          ],
          excludes: ["Generate a concise title"],
        },
        "旧 ID 未进入模型引用提示",
        60000,
      );
      await waitForV4TimelineContaining(`E2E_SID_REFERENCE_OK_${index}`, 60000);
      await waitForUpstreamRequest(
        {
          includes: [`E2E_SID_REFERENCE_${index}`, `E2E_SID_HISTORY_${index}`, id],
          excludes: ["Generate a concise title"],
        },
        "旧 ID 的工具结果未进入后续模型请求",
        60000,
      );
      const sessionChip = await browser.execute(
        (label) =>
          Array.from(document.querySelectorAll("span")).some(
            (element) =>
              element.textContent?.trim() === label &&
              element.querySelector("svg.lucide-messages-square") !== null,
          ),
        `E2E SID legacy ${index}`,
      );
      expect(sessionChip).toBe(true);
      facts[`reference${index}`] = { id, mention, sessionChip };
      await browser.saveScreenshot(join(artifactDir, `legacy-reference-${index}.png`));
    }
    facts.final = readIdentityFacts(newId);
  });

  it("手机 shared-host 恢复两种旧 ID，引用发送后刷新仍保留原身份", async function () {
    this.timeout(180000);
    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint) throw new Error("SID 手机验收需要隔离 Web/relay fixture");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: "SID04",
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      for (const [index, id] of LEGACY_IDS.entries()) {
        await showMobileTaskHome(page);
        const toggles = page.getByTestId("virtual-project-toggle");
        for (let i = 0; i < (await toggles.count()); i++) {
          const toggle = toggles.nth(i);
          if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        }
        await page.getByTestId(testId(TID_TASK_ITEM, id)).first().click();
        const pane = page.locator(`[data-session-id="${id}"]`);
        await pane.getByText(`E2E_SID_FOLLOW_OK_${index}`, { exact: false }).first().waitFor();
        const composer = page.getByTestId(TID_V4_COMPOSER_INPUT);
        await composer.fill("#");
        await page.getByTestId(testId(TID_PROMPT_SUGGESTION_OPTION, `session:${id}`)).click();
        await composer.press("End");
        await composer.pressSequentially(` E2E_SID_MOBILE_${index}: acknowledge this reference.`);
        await page.getByTestId(TID_V4_COMPOSER_SEND).click();
        await pane
          .getByText(`E2E_SID_MOBILE_OK_${index}`, { exact: false })
          .first()
          .waitFor({ timeout: 60000 });
        await waitForUpstreamRequest(
          {
            includes: [`E2E_SID_MOBILE_${index}`, "The user referenced prior ZCode session(s)", id],
            excludes: ["Generate a concise title"],
          },
          "手机未透传原 ID 的引用提醒",
          30000,
        );
        await page.reload();
        await page
          .locator(`[data-session-id="${id}"]`)
          .getByText(`E2E_SID_MOBILE_OK_${index}`, { exact: false })
          .first()
          .waitFor({ timeout: 30000 });
        const chip = page
          .locator("span")
          .filter({ has: page.locator("svg.lucide-messages-square") })
          .filter({ hasText: `E2E SID legacy ${index}` });
        expect(await chip.count()).toBeGreaterThan(0);
        await page.screenshot({
          path: join(artifactDir, `mobile-legacy-${index}.png`),
          fullPage: true,
        });
        facts[`mobile${index}`] = { id, restoredAfterReload: true, sessionChip: true };
      }
    } finally {
      await chrome.close();
    }
  });
  it("SID05: 旧客户端重复、并发和 Host/CLI 重启重放", async function () {
    this.timeout(240000);
    await withRetryProxy(async () => {
      facts.retries = await verifySessionCreationRetries();
    });
  });
  for (const surface of ["desktop", "mobile"] as const) {
    it(`SID05: 已接纳首条输入在执行前退出，用户确认重发分配新 ID (${surface})`, async function () {
      this.timeout(240000);
      await prepareV4ConversationE2E({ skipProvider: true });
      await seedReplayProvider({
        id: UPSTREAM_PROVIDER_ID,
        name: UPSTREAM_PROVIDER_NAME,
        apiFormat: "anthropic-messages",
        models: [UPSTREAM_MODEL],
      });
      const oldId = `sess_${randomUUID()}`;
      const command: CommandEnvelope = {
        commandId: randomUUID(),
        clientId: `e2e-confirm-resend-${surface}`,
        sessionId: null,
        type: "createSession",
        issuedAt: Date.now(),
        payload: {
          workspaceId: DEFAULT_WORKSPACE,
          sessionId: oldId,
          firstInput: {
            text: `E2E_SID_RETRY_RESEND_${surface}`,
            modelSelection: {
              providerId: UPSTREAM_PROVIDER_ID,
              modelId: UPSTREAM_MODEL,
              // seedReplayProvider 的合成模型只声明 disabled；与真实 Composer 默认请求一致。
              options: { reasoningLevel: "disabled" },
            },
          },
        },
      };
      // 模拟 ACK 丢失窗口已有的 renderer ledger；首发 admission 由真实 Host/CLI 完成。
      if (surface === "desktop")
        await browser.execute((entry) => {
          localStorage.setItem("zcode-v4-pending-commands:v1", JSON.stringify([entry]));
        }, pendingCreateEntry(command));
      await withRetryProxy(async () => {
        await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
          afterElectronProcessExit: async () => {
            facts[`resendAdmission-${surface}`] = await admitCreateBeforeExit(
              command,
              DEFAULT_WORKSPACE,
            );
          },
        });
      });
      let newId: string;
      if (surface === "mobile") {
        newId = await resendOnMobile(command);
      } else {
        await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
        await browser.waitUntil(
          async () =>
            browser.execute(() => {
              const entries = JSON.parse(
                localStorage.getItem("zcode-v4-pending-commands:v1") ?? "[]",
              );
              return entries.some((entry: { recovery?: string }) => entry.recovery === "discarded");
            }),
          { timeout: 60000, timeoutMsg: "CLI 重启后没有确认 firstInput 被丢弃" },
        );
        const resend = await $(
          '//div[@role="status"]//button[normalize-space()="Send again" or normalize-space()="重新发送"]',
        );
        await resend.waitForDisplayed({ timeout: 30000 });
        await browser.saveScreenshot(join(artifactDir, "resend-discarded-banner.png"));
        await resend.click();
        await browser.waitUntil(
          async () =>
            browser.execute(() =>
              Boolean(
                (
                  window as unknown as { __zcodeV4CommandAcksE2E?: Array<{ type: string }> }
                ).__zcodeV4CommandAcksE2E?.some((ack) => ack.type === "createSession"),
              ),
            ),
          { timeout: 30000, timeoutMsg: "重发没有收到 createSession ACK" },
        );
        const acks = await browser.execute(
          () =>
            (
              window as unknown as {
                __zcodeV4CommandAcksE2E: Array<{
                  type: string;
                  status: string;
                  reasonCode?: string;
                }>;
              }
            ).__zcodeV4CommandAcksE2E,
        );
        facts[`resendAcks-${surface}`] = acks;
        expect(acks.filter((ack) => ack.type === "createSession").at(-1)?.status).toBe("accepted");
        await waitForV4AssistantMessageContaining("E2E_SID_RETRY_OK", 60000);
        const current = await waitForV4Pane(
          (s) => Boolean(s.sessionId && s.sessionId !== "draft") && !s.canStop,
          "重发会话未完成",
          60000,
        );
        newId = current.sessionId!;
      }
      expect(newId).not.toBe(oldId);
      expect(newId).toMatch(
        /^sess_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
      const db = new DatabaseSync(join(paths.storageRoot, "cli/db/db.sqlite"), { readOnly: true });
      try {
        const inputs = db
          .prepare(
            "SELECT id,session_id,status,status_reason,payload FROM session_input WHERE session_id IN (?,?) ORDER BY session_id",
          )
          .all(oldId, newId);
        expect(inputs).toHaveLength(2);
        expect(inputs.find((row) => row.session_id === oldId)).toMatchObject({
          status: "discarded",
          status_reason: "session_resumed",
        });
        const promoted = inputs.find((row) => row.session_id === newId)!;
        expect(promoted.status).toBe("promoted");
        expect(promoted.id).not.toBe(`queue_${command.commandId}`);
        // runtime 的 model-only 提醒也用 user role；必须按真实用户语义计数，避免把工具清单当成第二次输入。
        expect(
          db
            .prepare(
              "SELECT count(*) AS n FROM message WHERE session_id IN (?,?) AND json_extract(data,'$.semantics.origin')='real_user'",
            )
            .get(oldId, newId)?.n,
        ).toBe(1);
        facts[`confirmedResend-${surface}`] = {
          oldId,
          newId,
          inputs,
          accepted: true,
          userMessages: 1,
        };
      } finally {
        db.close();
      }
    });
  }
});

function readIdentityFacts(newId: string) {
  const cli = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  const host = new DatabaseSync(join(paths.appDataDir, "tasks-index.sqlite"), { readOnly: true });
  try {
    return [newId, ...LEGACY_IDS].map((id) => {
      const session = cli.prepare("select id,parent_id from session where id=?").get(id);
      const task = host.prepare("select task_id,cli_created_at from tasks where task_id=?").get(id);
      expect(session?.id).toBe(id);
      expect(task?.task_id).toBe(id);
      expect(session?.parent_id).toBeNull();
      if (id.startsWith("session_"))
        expect(
          cli.prepare("select id from session where id=?").get(id.replace(/^session_/, "sess_")),
        ).toBeUndefined();
      const messages = cli.prepare("select count(*) as n from message where session_id=?").get(id);
      expect(Number(messages?.n)).toBeGreaterThanOrEqual(2);
      return { session, task, messages };
    });
  } finally {
    cli.close();
    host.close();
  }
}

function insertRow(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  const columns = Object.keys(row);
  db.prepare(
    `insert into ${table} (${columns.join(",")}) values (${columns.map(() => "?").join(",")})`,
  ).run(...Object.values(row));
}

function seedLegacySessions(sourceId: string) {
  const cli = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"));
  const host = new DatabaseSync(join(paths.appDataDir, "tasks-index.sqlite"));
  try {
    const source = cli.prepare("select * from session where id=?").get(sourceId)!;
    const sourceTask = host.prepare("select * from tasks where task_id=?").get(sourceId)!;
    const modelEntry = cli
      .prepare("select * from session_entry where session_id=? and type='runtime/model_selection'")
      .get(sourceId)!;
    expect(source).toBeDefined();
    expect(sourceTask).toBeDefined();
    expect(modelEntry).toBeDefined();
    for (const [index, id] of LEGACY_IDS.entries()) {
      const now = Date.now() - 10000 + index;
      const title = `E2E SID legacy ${index}`;
      insertRow(cli, "session", {
        ...source,
        id,
        title,
        title_source: "custom",
        title_message_id: null,
        trace_id: `trace_e2e_sid_${index}`,
        slug: `e2e-sid-${index}`,
        time_created: now,
        time_updated: now,
      });
      insertRow(host, "tasks", {
        ...sourceTask,
        task_id: id,
        title,
        cli_title: title,
        cli_title_source: "custom",
        cli_created_at: now,
        cli_updated_at: now,
        meta_json: JSON.stringify({
          ...JSON.parse(String(sourceTask.meta_json)),
          taskId: id,
          title,
        }),
      });
      insertRow(cli, "session_entry", {
        ...modelEntry,
        id: `entry_e2e_sid_${index}`,
        session_id: id,
      });
      const userId = `msg_e2e_sid_${index}_user`;
      const assistantId = `msg_e2e_sid_${index}_assistant`;
      const user = {
        role: "user",
        time: { created: now },
        agent: "zcode-agent",
        model: { providerID: UPSTREAM_PROVIDER_ID, modelID: UPSTREAM_MODEL },
      };
      const assistant = {
        role: "assistant",
        parentID: userId,
        time: { created: now + 1, completed: now + 1 },
        modelID: UPSTREAM_MODEL,
        providerID: UPSTREAM_PROVIDER_ID,
        mode: "build",
        agent: "zcode-agent",
        path: { cwd: DEFAULT_WORKSPACE, root: DEFAULT_WORKSPACE },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      };
      for (const [messageId, data] of [
        [userId, user],
        [assistantId, assistant],
      ] as const) {
        insertRow(cli, "message", {
          id: messageId,
          session_id: id,
          time_created: now,
          time_updated: now,
          data: JSON.stringify(data),
        });
        insertRow(cli, "part", {
          id: `part_${messageId}`,
          message_id: messageId,
          session_id: id,
          time_created: now,
          time_updated: now,
          data: JSON.stringify({
            type: "text",
            text: `E2E_SID_HISTORY_${index}: keep the original session identity.`,
            time: { start: now, end: now },
          }),
        });
      }
    }
  } finally {
    cli.close();
    host.close();
  }
}

async function withRetryProxy<T>(run: () => Promise<T>): Promise<T> {
  // 独立 Host 使用内建 HTTPS provider；仅在本用例安装隔离代理，不访问真实上游。
  const proxy = await startE2ENetworkCaptureProxy({
    artifactPath: join(artifactDir, "session-retry-network.json"),
    caDir: join(paths.homeDir, "session-retry-ca"),
    requestRedirects: [
      {
        host: "open.bigmodel.cn",
        path: "/api/anthropic/v1/messages",
        targetUrl: `${replay.baseUrl}/messages`,
      },
    ],
    responseMocks: [
      {
        host: "open.bigmodel.cn",
        method: "POST",
        path: "/api/paas/c1f3a7e2/v2/client",
        body: JSON.stringify({ code: 500, msg: "E2E handshake unavailable" }),
      },
    ],
  });
  const previous = Object.fromEntries(Object.keys(proxy.env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, proxy.env);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await proxy.stop();
  }
}

function pendingCreateEntry(command: CommandEnvelope) {
  return {
    commandId: command.commandId,
    clientId: command.clientId,
    sessionId: null,
    issuedAt: command.issuedAt,
    expiresAt: Date.now() + 3600000,
    replay: { kind: "input", type: "createSession", payload: command.payload },
    clientContext: { workspace: { workspacePath: DEFAULT_WORKSPACE }, projectId: null },
  };
}

async function resendOnMobile(command: CommandEnvelope): Promise<string> {
  const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
  if (!endpoint) throw new Error("SID 手机重发需要隔离 Web/relay fixture");
  const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
  const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
  const chrome = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    headless: true,
  });
  try {
    const context = await chrome.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir,
      caseMarker: "SID05",
      phase: "resend",
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    await page.evaluate(
      (entry) => localStorage.setItem("zcode-v4-pending-commands:v1", JSON.stringify([entry])),
      pendingCreateEntry(command),
    );
    await page.reload();
    await showMobileTaskHome(page);
    await page
      .locator(projectSectionSelector(DEFAULT_WORKSPACE))
      .getByTestId("virtual-project-create-task")
      .tap();
    const resend = page
      .getByRole("status")
      .getByRole("button", { name: /^(Send again|重新发送)$/ });
    await resend.waitFor({ timeout: 60000 });
    await page.screenshot({
      path: join(artifactDir, "mobile-resend-discarded-banner.png"),
      fullPage: true,
    });
    await resend.tap();
    await page.waitForFunction(() =>
      (
        window as unknown as { __zcodeV4CommandAcksE2E?: Array<{ type: string }> }
      ).__zcodeV4CommandAcksE2E?.some((ack) => ack.type === "createSession"),
    );
    const acks = await page.evaluate(
      () =>
        (
          window as unknown as {
            __zcodeV4CommandAcksE2E: Array<{ type: string; status: string; reasonCode?: string }>;
          }
        ).__zcodeV4CommandAcksE2E,
    );
    facts["resendAcks-mobile"] = acks;
    expect(acks.filter((ack) => ack.type === "createSession").at(-1)?.status).toBe("accepted");
    const answer = page.getByText("E2E_SID_RETRY_OK", { exact: true }).first();
    await answer.waitFor({ timeout: 60000 });
    const pane = page.locator('[data-session-id^="sess_"]').filter({ has: answer }).first();
    const newId = await pane.getAttribute("data-session-id");
    if (!newId) throw new Error("手机重发后没有新 sessionId");
    await page.reload();
    await page
      .locator(`[data-session-id="${newId}"]`)
      .getByText("E2E_SID_RETRY_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    return newId;
  } finally {
    await chrome.close();
  }
}
