// PLM-EXT-P3C：扩展经 ctx.sessions.* 写会话（docs/plugins/extension-host.md §17.3、§17.8、§17.10 第 3 步、
// §18.1 H10）。
// 隔离 HOME：
// - 纯 JS fixture 扩展 e2e-ext-writes（test/e2e/fixtures/fs/plugins/plugin-extension-writes/）经 plugins.dirs
//   加载，清单声明 sessions.write；授权记录预先写进隔离 HOME 的 grants.json（授权流程由 PLM-EXT-P3A 覆盖）。
//   它在输入框状态栏有一个命令：每次点击读一次用例写的步骤文件，按顺序执行 ctx.sessions.* 操作，结果写日志。
// - 模型用 replay（plugin-extension-sessions-write.json）：创建、发送、换模型（只在请求体是 deepseek-v4-pro 时命中）
//   与中断（受控流闸门）各一个夹具。
// - 手机：wdio 的远控夹具起本地 Web 前端与假 relay（web-remote-control-auth-gate-fixture.ts 登记了本 spec）。
// 运行时证据：Main 日志（fixture 的 E2E_WRITES_*）、Window Host 项目树、审计文件、桌面与手机的 DOM、截图。
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import { EXTENSION_SESSION_CONSENT_REVISION } from "@zcode/shared/extension-host";
import type { ProjectTask, ProjectTree } from "@zcode/services";
import {
  TID_EXTENSION_PERMISSIONS,
  TID_EXTENSION_PERMISSIONS_ACTION,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_TASK_ITEM,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  clickSlot,
  createExtensionLog,
  waitForSlot,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import { waitForControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  ensureUpstreamModelForE2E,
} from "#e2e/helpers/upstream-provider";
import {
  prepareV4ConversationE2E,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  openInstalledPluginSettingsDetail,
  openPluginManagementSettings,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P3C";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(process.cwd(), "test/e2e/fixtures/fs/plugins/plugin-extension-writes");
const PLUGIN = "e2e-ext-writes";
const PLUGIN_ID = `${PLUGIN}@inline`;
const SLOT_ITEM = `${PLUGIN_ID}/run`;
const CREATE_PROMPT = "E2E_P3C_CREATE: reply with the create marker.";
const SEND_PROMPT = "E2E_P3C_SEND: reply with the send marker.";
const MODEL_PROMPT = "E2E_P3C_MODEL: reply with the model marker.";
const INTERRUPT_PROMPT = "E2E_P3C_INTERRUPT: start a long reply.";
const STREAM_PROMPT = "E2E_P3C_STREAM: reply in several parts.";
const STREAM_REPLY =
  "E2E_P3C_STREAM_PART_1 E2E_P3C_STREAM_PART_2 E2E_P3C_STREAM_PART_3 E2E_P3C_STREAM_DONE";
const FAIL_PROMPT = "E2E_P3C_FAIL: this request fails.";
const AFTER_DELETE_PROMPT = "E2E_P3C_AFTER_DELETE: the task is gone.";
const FORGED_TEXT = "E2E_P3C_FORGED";
const RENAMED = "E2E P3C 已改名";
const CREATE_REQUEST_ID = "e2e-p3c-create";
const SEND_REQUEST_ID = "e2e-p3c-send";
const LABEL_SELECTOR = '[data-v4-user-input-source-kind="extension"]';
const LABELS = { "zh-CN": `来自插件 ${PLUGIN}`, "en-US": `From plugin ${PLUGIN}` } as const;
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd();

interface SessionRef {
  kind: "app";
  sourceServerId: string;
  workspacePath: string;
  sessionId: string;
  workspaceIdentity?: string;
  project?: { kind: "app"; sourceServerId: string; projectId: string };
}
interface Op {
  name: string;
  input: Record<string, unknown>;
  subscribeRows?: boolean;
  /** 结果一有会话就持续订阅它的行，每个事件写一行 E2E_WRITES_WATCH。 */
  watchRows?: boolean;
}
interface OpResult {
  ok?: Record<string, unknown> & {
    session?: SessionRef;
    operation?: { commandId: string };
    requestId?: string;
  };
  error?: string;
  rows?: string;
}

const evidence: Record<string, unknown> = {};
const screenshots: string[] = [];
const log = createExtensionLog();
let seq = 0;

function fixturesDir(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-writes");
}

function extensionsDataPath(...parts: string[]): string {
  return join(resolveE2EStorageRoot(), "v2", "extensions", ...parts);
}

/** fixture 插件进 plugins.dirs 并启用；授权记录预先写好（授权流程由 PLM-EXT-P3A 覆盖）。 */
async function seedPlugin(): Promise<void> {
  const target = fixturesDir();
  await mkdir(target, { recursive: true });
  await cp(join(FIXTURE_ROOT, PLUGIN), join(target, PLUGIN), { recursive: true, force: true });
  await writePluginDirsConfig([join(target, PLUGIN)], [PLUGIN_ID]);
  await mkdir(extensionsDataPath(), { recursive: true });
  await writeFile(
    extensionsDataPath("grants.json"),
    JSON.stringify({
      version: 1,
      plugins: {
        [PLUGIN_ID]: {
          grants: ["sessions.write"],
          consentedVersion: "1.0.0",
          consentedAt: Date.now(),
          // 当前的会话档位含义（§17.12）：没有这个字段的旧记录要重新确认，迁移由 PLM-EXT-P3E 覆盖。
          consentRevision: EXTENSION_SESSION_CONSENT_REVISION,
        },
      },
    }),
  );
}

async function waitForLogAfter(
  from: number,
  predicate: (line: string) => boolean,
  message: string,
  timeout = 60000,
): Promise<string> {
  let found = "";
  await browser.waitUntil(
    async () => {
      found = (await log.lines()).slice(from).find(predicate) ?? "";
      return Boolean(found);
    },
    { timeout, interval: 300, timeoutMsg: message },
  );
  return found;
}

/** 写步骤文件，点状态栏命令，等这一步执行完，按操作序号返回结果（日志里的 JSON 与错误码）。 */
async function runStep(label: string, ops: Op[]): Promise<OpResult[]> {
  seq += 1;
  const current = seq;
  await writeFile(
    join(fixturesDir(), "e2e-ext-writes-step.json"),
    JSON.stringify({ seq: current, ops }),
  );
  const from = (await log.lines()).length;
  await waitForSlot(SLOT_ITEM, (slot) => slot.text.includes("E2E writes"), "the run slot");
  await clickSlot(SLOT_ITEM);
  await waitForLogAfter(
    from,
    (line) => line.includes(`E2E_WRITES_DONE seq=${current}`),
    `${label}: the extension should finish step ${current}`,
    120000,
  );
  const lines = (await log.lines()).slice(from);
  const results = ops.map((_op, index): OpResult => {
    const marker = `E2E_WRITES_RESULT seq=${current} index=${index} `;
    const line = lines.find((entry) => entry.includes(marker)) ?? "";
    const rows = lines.find((entry) =>
      entry.includes(`E2E_WRITES_ROWS seq=${current} index=${index} `),
    );
    const ok = /\bok=(.*)$/.exec(line)?.[1];
    const error = /\berror=(\S+)/.exec(line)?.[1];
    return {
      ...(ok !== undefined ? { ok: JSON.parse(ok) as OpResult["ok"] } : {}),
      ...(error ? { error } : {}),
      ...(rows ? { rows: rows.slice(rows.indexOf("session=")) } : {}),
    };
  });
  evidence[`step-${current}-${label}`] = results;
  return results;
}

async function readTask(id: string): Promise<ProjectTask> {
  const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
  const task = tree.tasks.find((value) => value.taskId === id);
  if (!task) throw new Error(`the product task is absent: ${id}`);
  return task;
}

async function readLabels(): Promise<string[]> {
  return browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
        (element) => element.innerText ?? "",
      ),
    LABEL_SELECTOR,
  );
}

async function waitForLabels(count: number, message: string): Promise<string[]> {
  let labels: string[] = [];
  await browser.waitUntil(
    async () => {
      labels = await readLabels();
      return labels.length === count;
    },
    { timeout: 30000, interval: 300, timeoutMsg: message },
  );
  return labels;
}

async function capture(label: string): Promise<void> {
  screenshots.push(await capturePluginManualReview(CASE_ID, label));
}

interface PermissionsUi {
  text: string;
  actions: Array<{ capability: string; outcome: string }>;
}

async function readPermissions(): Promise<PermissionsUi | null> {
  return browser.execute(
    (sectionTestId, actionTestId, id) => {
      const section = document.querySelector<HTMLElement>(
        `[data-testid="${sectionTestId}"][data-plugin-id="${id}"]`,
      );
      if (!section) return null;
      return {
        text: section.innerText ?? "",
        actions: Array.from(
          section.querySelectorAll<HTMLElement>(`[data-testid="${actionTestId}"]`),
        ).map((row) => ({
          capability: row.dataset.capability ?? "",
          outcome: row.dataset.outcome ?? "",
        })),
      };
    },
    TID_EXTENSION_PERMISSIONS,
    TID_EXTENSION_PERMISSIONS_ACTION,
    PLUGIN_ID,
  );
}

/** 从插件详情页回到工作区：详情页的返回先回到插件列表，再返回才离开设置页。 */
async function leaveSettings(): Promise<void> {
  await browser.waitUntil(
    async () => {
      if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting())) return true;
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 5000 }).catch(() => undefined);
      return false;
    },
    { timeout: 30000, interval: 500, timeoutMsg: "the settings page should close" },
  );
}

async function readAudit(): Promise<{ text: string; lines: Array<Record<string, unknown>> }> {
  const dir = extensionsDataPath("audit");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".jsonl"),
  );
  let text = "";
  for (const name of names.sort()) text += await readFile(join(dir, name), "utf8");
  return {
    text,
    lines: text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("PLM-EXT-P3C 扩展经 ctx.sessions.* 写会话", () => {
  let sessionId = "";
  let mobile: Browser | undefined;
  let page: Page | undefined;

  after(async () => {
    evidence.screenshots = screenshots;
    await writeFile(
      join(artifacts, "plm-ext-p3c-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await page
      ?.screenshot({ path: join(artifacts, "plm-ext-p3c-mobile-last.png") })
      .catch(() => {});
    await mobile?.close();
    await restoreHandoffProbes().catch(() => undefined);
    await clearAppData();
  });

  it("新建、立即订阅、幂等重试、换模型、中断、整理与打开；来源标识、审计与拒绝伪造来源", async function () {
    this.timeout(900000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedPlugin();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await log.mark();
      },
    });
    await prepareV4ConversationE2E();
    // H10 的目标模型：与默认模型同一个 provider，回放夹具按请求体里的模型名区分。
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    evidence.activated = await log.waitFor(
      (line) => line.includes(`E2E_WRITES_ACTIVATED plugin=${PLUGIN_ID}`),
      "the write fixture should activate",
      90000,
    );

    // (a) 默认工作区的项目。
    const [projects] = await runStep("projects", [
      { name: "listProjects", input: { query: "ZCodeProject" } },
    ]);
    const project = (
      projects!.ok as { projects: Array<{ project: NonNullable<SessionRef["project"]> }> }
    ).projects[0]!.project;
    expect(project.projectId).toBeTruthy();

    // (b) 新建会话，结果一到立即订阅行（新建后立即订阅的时序）；同一个 requestId 再建一次，得到同一个会话。
    const [created, createdAgain] = await runStep("create", [
      {
        name: "createSession",
        input: { project, prompt: CREATE_PROMPT, requestId: CREATE_REQUEST_ID },
        subscribeRows: true,
      },
      {
        name: "createSession",
        input: { project, prompt: CREATE_PROMPT, requestId: CREATE_REQUEST_ID },
      },
    ]);
    expect(created!.ok).toMatchObject({
      requestId: CREATE_REQUEST_ID,
      creation: "created",
      firstInput: "accepted",
    });
    sessionId = created!.ok!.session!.sessionId;
    expect(created!.ok!.session!.project?.projectId).toBe(project.projectId);
    expect(createdAgain!.ok?.session?.sessionId).toBe(sessionId);
    // 新建后立即订阅：第一个事件必须是 reset，不能是 unavailable。
    expect(created!.rows).toMatch(/kind=reset/);

    // (c) 打开会话：桌面切到它；用户行显示「来自插件 e2e-ext-writes」，回复来自回放夹具。
    const [opened] = await runStep("open", [{ name: "openSession", input: { sessionId } }]);
    expect(opened!.ok).toMatchObject({ status: "opened" });
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId,
      "the desktop should open the plugin session",
      30000,
    );
    await waitForV4AssistantMessageContaining("E2E_P3C_CREATE_DONE", 90000);
    expect(await waitForLabels(1, "the first user row should carry the plugin label")).toEqual([
      LABELS["zh-CN"],
    ]);
    await installHandoffRpcProbe();
    const createdTask = await readTask(sessionId);
    evidence.createdTask = { projectId: createdTask.projectId, title: createdTask.title };
    expect(createdTask.projectId).toBe(project.projectId);

    // (d) 同一个 requestId 发两次：同一个命令，只出现一条消息。
    const [sent, sentAgain] = await runStep("send", [
      {
        name: "sendToSession",
        input: { sessionId, prompt: SEND_PROMPT, requestId: SEND_REQUEST_ID },
      },
      {
        name: "sendToSession",
        input: { sessionId, prompt: SEND_PROMPT, requestId: SEND_REQUEST_ID },
      },
    ]);
    expect(sent!.ok).toMatchObject({ requestId: SEND_REQUEST_ID, admission: "accepted" });
    expect(sentAgain!.ok?.operation?.commandId).toBe(sent!.ok?.operation?.commandId);
    await waitForV4AssistantMessageContaining("E2E_P3C_SEND_DONE", 90000);
    await waitForLabels(2, "a retried send should add exactly one user row");

    // (e) H10：带 model 发送；只有请求体里的模型是 deepseek-v4-pro 时回放夹具才命中。requestId 由扩展进程补。
    const [modeled] = await runStep("model", [
      {
        name: "sendToSession",
        // 用 providerId/modelId：第一次运行只给 modelId 时报 invalid-input（唯一匹配失败），带上 provider 就是唯一的。
        input: {
          sessionId,
          prompt: MODEL_PROMPT,
          model: `${UPSTREAM_PROVIDER_ID}/${UPSTREAM_SECONDARY_MODEL}`,
        },
      },
    ]);
    expect(modeled!.ok).toMatchObject({ admission: "accepted" });
    expect(modeled!.ok?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitForV4AssistantMessageContaining("E2E_P3C_MODEL_DONE", 90000);
    await waitForLabels(3, "the model send should add one user row");

    // (f) 中断：受控流停在闸门上，读 executionId，再中断。
    const [running] = await runStep("interrupt-send", [
      { name: "sendToSession", input: { sessionId, prompt: INTERRUPT_PROMPT } },
    ]);
    expect(running!.ok).toMatchObject({ admission: "accepted" });
    await waitForControlledReplay("p3c-interrupt-target");
    const [summary] = await runStep("summary", [
      { name: "readSession", input: { sessionId, view: "summary" } },
    ]);
    const executionId = (summary!.ok as { summary: { executionId?: string; status: string } })
      .summary.executionId;
    expect(executionId).toBeTruthy();
    const [interrupted] = await runStep("interrupt", [
      { name: "interruptSession", input: { sessionId, expectedExecutionId: executionId } },
    ]);
    expect(interrupted!.ok).toMatchObject({ status: "applied" });
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "the interrupted turn should stop",
      60000,
    );

    // (g) 整理：改名、置顶、归档再取消归档、打开。
    const organized = await runStep("organize", [
      { name: "renameSession", input: { sessionId, title: RENAMED } },
      { name: "setSessionPinned", input: { sessionId, pinned: true } },
      { name: "setSessionArchived", input: { sessionId, archived: true } },
      { name: "setSessionArchived", input: { sessionId, archived: false } },
      { name: "openSession", input: { sessionId } },
    ]);
    expect(organized.slice(0, 4).map((result) => result.ok?.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
    ]);
    expect(organized[4]!.ok).toMatchObject({ status: "opened" });
    await browser.waitUntil(
      async () => {
        const task = await readTask(sessionId);
        return task.title === RENAMED && task.pinned === true && task.archived === false;
      },
      { timeout: 30000, timeoutMsg: "rename, pin and unarchive should be durable" },
    );
    evidence.organizedTask = await readTask(sessionId).then(({ title, pinned, archived }) => ({
      title,
      pinned,
      archived,
    }));

    // (h) 渲染进程伪造 extension 来源：Host 的连接作用域拒绝，会话里不多出消息。
    evidence.forged = await callHandoffHost(
      ServiceChannels.ZCodeAgent,
      "sendConversationCommandV4",
      [
        {
          workspacePath: DEFAULT_WORKSPACE,
          envelope: {
            commandId: `e2e-p3c-forged-${Date.now()}`,
            clientId: "e2e-p3c-forged",
            sessionId,
            type: "sendText",
            payload: { text: FORGED_TEXT, source: { kind: "extension", pluginId: PLUGIN_ID } },
            issuedAt: Date.now(),
          },
        },
      ],
    ).then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(String(evidence.forged)).toContain("fault.command.extensionSourceUntrusted");
    // (g) 里先归档、再取消归档、再打开，侧栏的归档清理可能在「打开」之前把会话撤出窗格，
    // 打开后窗格重新载入，载入完成前一行都没有，所以等到恰好 4 条，不只读一次。
    // 伪造的消息如果被收下会变成 5 条，照样失败。
    // 清理落在「打开」之后、窗格停在新草稿上，是侧栏用过期快照清理的产品问题，已在 useProjectTree 修复
    // （读取期间已打开的任务跳过清理），这里等不来 4 条就是回归。
    await waitForLabels(4, "the forged send should not add a user row");

    // (i) 桌面截图：四条用户行都带标识（中文浅色、英文深色）。
    await capture("labels-zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await browser.waitUntil(
      async () => (await readLabels()).every((label) => label === LABELS["en-US"]),
      { timeout: 15000, timeoutMsg: "the labels should switch to English" },
    );
    await capture("labels-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (j) 插件详情页「最近操作」：最近 10 行里有整理、打开与中断；全部成功。
    await openPluginManagementSettings();
    await openInstalledPluginSettingsDetail(PLUGIN_ID);
    let permissions: PermissionsUi | null = null;
    await browser.waitUntil(
      async () => {
        permissions = await readPermissions();
        const capabilities = permissions?.actions.map((action) => action.capability) ?? [];
        return [
          "sessions.openSession",
          "sessions.setSessionArchived",
          "sessions.setSessionPinned",
          "sessions.renameSession",
          "sessions.interruptSession",
        ].every((capability) => capabilities.includes(capability));
      },
      { timeout: 30000, interval: 300, timeoutMsg: "recent actions should list the writes" },
    );
    evidence.permissions = permissions;
    const permissionsUi = permissions as PermissionsUi | null;
    expect(permissionsUi!.actions.every((action) => action.outcome === "ok")).toBe(true);
    expect(permissionsUi!.text).toContain("重命名会话");
    await capture("recent-actions-zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await browser.waitUntil(
      async () => ((await readPermissions())?.text ?? "").includes("Renamed a session"),
      { timeout: 15000, timeoutMsg: "recent actions should switch to English" },
    );
    await capture("recent-actions-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await leaveSettings();

    // (k) 审计：每个写动作一行，带 requestId、目标与提示词长度；不含提示词正文。
    const audit = await readAudit();
    const writes = audit.lines.filter((line) => String(line.capability).startsWith("sessions."));
    evidence.audit = writes;
    expect(writes.length).toBeGreaterThanOrEqual(13);
    const createRow = writes.find(
      (line) =>
        line.capability === "sessions.createSession" && line.requestId === CREATE_REQUEST_ID,
    );
    expect(createRow).toMatchObject({
      grant: "sessions.write",
      outcome: "ok",
      promptChars: CREATE_PROMPT.length,
      target: { sessionId, projectId: project.projectId },
    });
    expect(
      writes.find(
        (line) =>
          line.capability === "sessions.sendToSession" && line.requestId === SEND_REQUEST_ID,
      ),
    ).toMatchObject({ commandId: sent!.ok?.operation?.commandId, promptChars: SEND_PROMPT.length });
    for (const marker of ["E2E_P3C_CREATE", "E2E_P3C_SEND", "E2E_P3C_MODEL", RENAMED])
      expect(audit.text).not.toContain(marker);

    // (m)–(o) 行镜像的增量、本轮失败与删除后的信号。宿主行为，以前只由示例插件用例 PLM-JARVIS-1、2 断言。
    // (m) 流式期间：回复分四段到达（夹具 p3c-stream，间隔 1.5 秒），扩展的行订阅在本轮 running 时
    // 逐段收到 rows 增量，助手文字的字数递增；结束后是 completedSuccess 与完整的回复。
    const streamFrom = (await log.lines()).length;
    const [streamed] = await runStep("stream", [
      { name: "createSession", input: { project, prompt: STREAM_PROMPT }, watchRows: true },
    ]);
    const streamId = streamed!.ok!.session!.sessionId;
    const streamDone = await waitForLogAfter(
      streamFrom,
      (line) =>
        line.includes(`E2E_WRITES_WATCH session=${streamId} `) &&
        line.includes("turns=completedSuccess"),
      "the streamed turn should complete in the rows mirror",
      90000,
    );
    const watchLines = (await log.lines())
      .slice(streamFrom)
      .filter((line) => line.includes(`E2E_WRITES_WATCH session=${streamId} `));
    evidence.streamWatch = watchLines;
    expect(Number(/replyChars=(\d+)/.exec(streamDone)?.[1])).toBe(STREAM_REPLY.length);
    const runningChars = watchLines
      .filter((line) => line.includes(" kind=rows ") && line.includes("turns=running "))
      .map((line) => Number(/replyChars=(\d+)/.exec(line)?.[1]))
      .filter((chars) => chars > 0);
    const distinctChars = [...new Set(runningChars)];
    evidence.streamRunningChars = distinctChars;
    expect(distinctChars.length).toBeGreaterThanOrEqual(2);
    expect(distinctChars).toEqual([...distinctChars].sort((a, b) => a - b));
    expect(distinctChars.at(-1)!).toBeLessThan(STREAM_REPLY.length);

    // (n) 本轮失败：服务商返回 400（夹具 p3c-fail），扩展经行镜像看到这一轮的 turnHeader 是 failed。
    const failFrom = (await log.lines()).length;
    const [failedCreate] = await runStep("fail", [
      { name: "createSession", input: { project, prompt: FAIL_PROMPT }, watchRows: true },
    ]);
    const failId = failedCreate!.ok!.session!.sessionId;
    evidence.failedTurn = await waitForLogAfter(
      failFrom,
      (line) =>
        line.includes(`E2E_WRITES_WATCH session=${failId} `) && line.includes("turns=failed "),
      "the extension should see the failed turn in the rows mirror",
      90000,
    );

    // (o) 宿主删除任务（与侧栏「删除」同一条路径）：之后 sendToSession 报 forbidden（项目树里找不到它）；
    // 已开着的行订阅不结束（会话仍在 CLI 里）。§18.3「大脑被删的信号」记的就是这个行为。
    const failTask = await readTask(failId);
    await callHandoffHost(ServiceChannels.ZCodeTask, "deleteTask", [
      {
        taskId: failId,
        workspacePath: failTask.workspacePath,
        ...(failTask.workspaceIdentity ? { workspaceIdentity: failTask.workspaceIdentity } : {}),
      },
    ]);
    const [sentAfterDelete] = await runStep("send-after-delete", [
      { name: "sendToSession", input: { sessionId: failId, prompt: AFTER_DELETE_PROMPT } },
    ]);
    evidence.sendAfterDelete = sentAfterDelete;
    expect(sentAfterDelete!.error).toBe("forbidden");
    const endedAfterDelete = (await log.lines())
      .slice(failFrom)
      .filter((line) => line.includes(`E2E_WRITES_WATCH session=${failId} ended=`));
    evidence.watchEndedAfterDelete = endedAfterDelete;
    expect(endedAfterDelete).toEqual([]);
    await runStep("unwatch", [
      { name: "unwatchRows", input: { sessionId: streamId } },
      { name: "unwatchRows", input: { sessionId: failId } },
    ]);
  });

  it("手机远控显示同样的「来自插件」标识", async function () {
    this.timeout(300000);
    requirePluginManualReview();
    expect(sessionId).toBeTruthy();
    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint) throw new Error("the mobile Web fixture is not configured for this spec");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
    });
    const context = await mobile.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(context);
    page = await context.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: artifacts,
      caseMarker: "P3C",
      phase: "pairing",
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    await showMobileTaskHome(page);
    for (const toggle of await page.getByTestId("virtual-project-toggle").all()) {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
    await page.getByTestId(testId(TID_TASK_ITEM, sessionId)).first().click();
    await page
      .locator(`[data-testid^="${TID_V4_SESSION_PANE}-"][data-session-id="${sessionId}"]`)
      .waitFor();
    await page.locator(LABEL_SELECTOR).first().waitFor();
    const mobileLabels = await page.locator(LABEL_SELECTOR).allTextContents();
    evidence.mobileLabels = mobileLabels;
    expect(mobileLabels).toEqual([
      LABELS["zh-CN"],
      LABELS["zh-CN"],
      LABELS["zh-CN"],
      LABELS["zh-CN"],
    ]);
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(layout).toEqual({ width: 390, overflow: false });
    const shot = join(artifacts, "plm-ext-p3c-mobile-labels-zh-CN-light.png");
    await page.screenshot({ path: shot });
    screenshots.push(shot);
  });
});
