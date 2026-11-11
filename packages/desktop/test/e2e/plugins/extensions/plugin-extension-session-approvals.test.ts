// PLM-EXT-P3E：插件回答审批、提问与切换权限模式（docs/plugins/extension-host.md §17.12）。
// 隔离 HOME：
// - 纯 JS fixture 扩展 e2e-ext-approvals（test/e2e/fixtures/fs/plugins/plugin-extension-approvals/）经 plugins.dirs
//   加载，清单声明 sessions.write；预先写进 grants.json 的是本阶段以前的旧格式记录（没有 consentRevision），
//   开头先验证它回到待授权、经真实授权对话框重新授权后才可用（§17.12「已有授权要重新确认」）。它在输入框状态栏
//   有一个命令：每次点击读一次用例写的步骤文件，按顺序执行 ctx.sessions.* 操作，或订阅 / 退订交互，结果写日志。
// - 模型用 replay（plugin-extension-session-approvals.json）：Write 触发审批、AskUserQuestion 触发提问；最终文本只在
//   tool_result 带对应工具 id 时命中，所以回复出现就证明批准、拒绝或答案回到了模型。
// - 后半段把清单改成申请 sessions.fullAccess，经「重新加载扩展」与真实授权对话框授予完全访问。
// 运行时证据：Main 日志（fixture 的 E2E_APPROVALS_*）、Window Host 项目树、磁盘上的文件、审计文件、对话框 DOM、截图。
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { EXTENSION_SESSION_CONSENT_REVISION } from "@zcode/shared/extension-host";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_EXTENSION_GRANT_DIALOG,
  TID_SIDE_PANE_EXTENSION_GRANT,
} from "@zcode/shared/test-ids";
import type { ProjectTree } from "@zcode/services";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimeRoot, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  clickSlot,
  createExtensionLog,
  openLauncher,
  waitForSlot,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-P3E";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-approvals",
);
const PLUGIN = "e2e-ext-approvals";
const PLUGIN_ID = `${PLUGIN}@inline`;
const SLOT_ITEM = `${PLUGIN_ID}/run`;
const PROMPTS = {
  outside: "E2E_P3E_OUTSIDE: a session the user started outside the plugin project.",
  allow: "E2E_P3E_ALLOW: write the allow file.",
  deny: "E2E_P3E_DENY: write the deny file.",
  ask: "E2E_P3E_ASK: ask me a question.",
  host: "E2E_P3E_HOST: write the host file.",
  mode: "E2E_P3E_MODE: reply with the mode marker.",
  yolo: "E2E_P3E_YOLO: reply with the yolo marker.",
  full: "E2E_P3E_FULL: write the full access file.",
} as const;
const QUESTION = "E2E_P3E_ASK_QUESTION: which answer?";
const ANSWER = "E2E_P3E_ANSWER_B";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd();

interface Op {
  name: string;
  input?: Record<string, unknown>;
}
interface OpResult {
  ok?: Record<string, unknown> & {
    status?: string;
    creation?: string;
    session?: { sessionId: string; workspacePath: string; project?: { projectId: string } };
  };
  error?: string;
}
interface InteractionLine {
  id: string;
  kind: string;
  options: string[];
}
interface InteractionsEvent {
  session: string;
  mode: string;
  interactions: InteractionLine[];
}

const evidence: Record<string, unknown> = {};
const screenshots: string[] = [];
const log = createExtensionLog();
let seq = 0;

function fixturesDir(): string {
  return join(getE2EAppDataPaths().homeDir, "fixtures", "extension-approvals");
}

function extensionsDataPath(...parts: string[]): string {
  return join(resolveE2EStorageRoot(), "v2", "extensions", ...parts);
}

function outputPath(name: string): string {
  return join(resolveE2ERuntimeRoot(), "plugin-extension-approvals", name);
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function writeManifestGrants(grants: string[]): Promise<void> {
  const path = join(fixturesDir(), PLUGIN, ".zcode-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    extension: { grants: string[] };
  };
  manifest.extension.grants = grants;
  await writeFile(path, JSON.stringify(manifest, null, 2));
}

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
        // 旧格式（P3e 以前）：没有 consentRevision，按 1 处理，要重新确认。
        [PLUGIN_ID]: {
          grants: ["sessions.write"],
          consentedVersion: "1.0.0",
          consentedAt: Date.now(),
        },
      },
    }),
  );
  await mkdir(join(resolveE2ERuntimeRoot(), "plugin-extension-approvals"), { recursive: true });
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

/** 写步骤文件，点状态栏命令，等这一步执行完；结果按序号返回。 */
async function runStep(label: string, ops: Op[]): Promise<OpResult[]> {
  seq += 1;
  const current = seq;
  await writeFile(
    join(fixturesDir(), "e2e-ext-approvals-step.json"),
    JSON.stringify({ seq: current, ops }),
  );
  const from = (await log.lines()).length;
  await waitForSlot(SLOT_ITEM, (slot) => slot.text.includes("E2E approvals"), "the run slot");
  await clickSlot(SLOT_ITEM);
  await waitForLogAfter(
    from,
    (line) => line.includes(`E2E_APPROVALS_DONE seq=${current}`),
    `${label}: the extension should finish step ${current}`,
    120000,
  );
  const results: OpResult[] = [];
  for (const line of (await log.lines()).slice(from)) {
    const match = new RegExp(`E2E_APPROVALS_RESULT seq=${current} index=(\\d+) `).exec(line);
    if (!match) continue;
    const ok = /\bok=(.*)$/.exec(line)?.[1];
    const error = /\berror=(\S+)/.exec(line)?.[1];
    results[Number(match[1])] = {
      ...(ok !== undefined ? { ok: JSON.parse(ok) as OpResult["ok"] } : {}),
      ...(error ? { error } : {}),
    };
  }
  evidence[`step-${current}-${label}`] = results;
  return results;
}

function parseEvent(line: string): InteractionsEvent | null {
  const match = /E2E_APPROVALS_EVENT session=(\S+) mode=(\S+) interactions=(.*)$/.exec(line);
  if (!match) return null;
  return {
    session: match[1]!,
    mode: match[2]!,
    interactions: JSON.parse(match[3]!) as InteractionLine[],
  };
}

/** 等 from 行之后、这个会话满足条件的交互事件。 */
async function waitForEvent(
  from: number,
  sessionId: string,
  predicate: (event: InteractionsEvent) => boolean,
  message: string,
  timeout = 60000,
): Promise<InteractionsEvent> {
  let event: InteractionsEvent | null = null;
  await browser.waitUntil(
    async () => {
      for (const line of (await log.lines()).slice(from)) {
        const parsed = parseEvent(line);
        if (parsed?.session === sessionId && predicate(parsed)) {
          event = parsed;
          return true;
        }
      }
      return false;
    },
    { timeout, interval: 300, timeoutMsg: message },
  );
  return event!;
}

function optionId(interaction: InteractionLine, kind: string): string {
  const option = interaction.options.find((entry) => entry.startsWith(`${kind}:`));
  if (!option) throw new Error(`the interaction has no ${kind} option: ${interaction.options}`);
  return option.slice(kind.length + 1);
}

function createdSession(result: OpResult | undefined, label: string) {
  if (!result?.ok) throw new Error(`${label} failed: ${result?.error ?? "no result"}`);
  expect(result.ok).toMatchObject({ creation: "created" });
  return result.ok.session!;
}

async function hasHostPermissionDialog(): Promise<boolean> {
  return waitForV4PermissionDialog(500)
    .then(() => true)
    .catch(() => false);
}

/** 插件建一个会话、订阅它的交互、在桌面打开它，返回会话 id 与订阅开始时的日志位置。 */
async function createWatchedSession(label: string, prompt: string, mode?: string) {
  const created = await runStep(`${label}-create`, [
    { name: "createSession", input: { prompt, ...(mode ? { mode } : {}) } },
  ]);
  const session = createdSession(created[0], `${label}: createSession`);
  const from = (await log.lines()).length;
  const watched = await runStep(`${label}-watch`, [
    { name: "watch", input: { sessionId: session.sessionId } },
    { name: "openSession", input: { sessionId: session.sessionId } },
  ]);
  expect(watched[1]?.ok).toMatchObject({ status: "opened" });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === session.sessionId,
    `${label}: the desktop should open the plugin session`,
    30000,
  );
  return { session, from };
}

async function readAudit(): Promise<Array<Record<string, unknown>>> {
  const dir = extensionsDataPath("audit");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".jsonl"),
  );
  let text = "";
  for (const name of names.sort()) text += await readFile(join(dir, name), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runReloadFromCommandCenter(): Promise<void> {
  await $('[data-testid="sidebar-search-open"]').click();
  const input = $('[role="dialog"] [cmdk-input]');
  await input.waitForDisplayed({ timeout: 10000 });
  await input.setValue(">重新加载扩展");
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"] [cmdk-item]'),
        ).find((element) => /重新加载扩展|Reload extensions/.test(element.textContent ?? ""));
        if (!item) return false;
        item.click();
        return true;
      }),
    { timeout: 10000, timeoutMsg: "command center should list 重新加载扩展" },
  );
}

function grantRowSelector(): string {
  return `[data-testid="${TID_SIDE_PANE_EXTENSION_GRANT}"][data-side-pane-open-tab-item="extension-grant:${PLUGIN_ID}"]`;
}

async function readDialog(): Promise<string | null> {
  return browser.execute((id) => {
    const dialog = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return dialog ? (dialog.innerText ?? "") : null;
  }, TID_EXTENSION_GRANT_DIALOG);
}

/** 启动页「需要授权」行 → 授权对话框；返回对话框文字。 */
async function openGrantDialog(): Promise<string> {
  await openLauncher();
  await browser.waitUntil(async () => $(grantRowSelector()).isDisplayed(), {
    timeout: 60000,
    interval: 300,
    timeoutMsg: "the launcher should show the needs-consent row",
  });
  await browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    row?.scrollIntoView({ block: "center" });
    row?.click();
  }, grantRowSelector());
  let text: string | null = null;
  await browser.waitUntil(
    async () => {
      text = await readDialog();
      return Boolean(text);
    },
    { timeout: 15000, interval: 200, timeoutMsg: "the grant row should open the consent dialog" },
  );
  return text!;
}

/** 点授权对话框的确认，等它关闭。 */
async function confirmGrantDialog(): Promise<void> {
  await browser.execute(
    (id, confirmTestId) => {
      document
        .querySelector<HTMLElement>(`[data-testid="${id}"] [data-testid="${confirmTestId}"]`)
        ?.click();
    },
    TID_EXTENSION_GRANT_DIALOG,
    TID_CONFIRM_DIALOG_CONFIRM,
  );
  await browser.waitUntil(async () => (await readDialog()) === null, {
    timeout: 15000,
    timeoutMsg: "the consent dialog should close after granting",
  });
}

async function readGrantRecord(): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(extensionsDataPath("grants.json"), "utf8").catch(() => null);
  if (!text) return undefined;
  const file = JSON.parse(text) as { plugins?: Record<string, Record<string, unknown>> };
  return file.plugins?.[PLUGIN_ID];
}

describe("PLM-EXT-P3E 插件回答审批、提问与切换权限模式", () => {
  after(async () => {
    evidence.screenshots = screenshots;
    await writeFile(
      join(artifacts, "plm-ext-p3e-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await clearAppData();
  });

  it("插件项目里的会话：批准、拒绝、回答提问、切换模式；完全访问要申请并授权；项目外的会话 forbidden", async function () {
    this.timeout(1200000);
    requirePluginManualReview();
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await seedPlugin();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await log.mark();
      },
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    const activated = await log.waitFor(
      (line) => line.includes(`E2E_APPROVALS_ACTIVATED plugin=${PLUGIN_ID}`),
      "the approvals fixture should activate",
      90000,
    );
    const dataPath = JSON.parse(/dataPath=(".*")$/.exec(activated)![1]!) as string;
    evidence.dataPath = dataPath;
    await installHandoffRpcProbe();

    // (0) 旧授权记录（没有 consentRevision）：会话能力报 not-granted，启动页显示「需要授权」；对话框写着新增的三项能力，
    //     重新授权后记录写入当前 revision，之后的步骤（项目外 forbidden、批准、拒绝……）证明授权已生效。
    const stale = await runStep("stale-grant", [
      { name: "setPermissionMode", input: { sessionId: "missing", mode: "guarded" } },
    ]);
    expect(stale[0]?.error).toBe("not-granted");
    const reconsent = await openGrantDialog();
    evidence.reconsentDialog = reconsent;
    expect(reconsent).toContain(`允许「${PLUGIN}」读取和操作会话？`);
    expect(reconsent).toContain(
      "插件项目里的会话：插件还能替你批准或拒绝工具调用、回答 Agent 的提问、切换权限模式。",
    );
    expect(reconsent).not.toContain("完全访问：");
    screenshots.push(await capturePluginManualReview(CASE_ID, "reconsent-dialog-zh-CN-zai-light"));
    await confirmGrantDialog();
    await browser.waitUntil(
      async () => (await readGrantRecord())?.consentRevision === EXTENSION_SESSION_CONSENT_REVISION,
      { timeout: 15000, timeoutMsg: "re-granting should write the current consent revision" },
    );
    evidence.reconsentRecord = await readGrantRecord();
    await browser.waitUntil(async () => !(await $(grantRowSelector()).isExisting()), {
      timeout: 15000,
      timeoutMsg: "the needs-consent row should disappear after re-granting",
    });

    // (a) 用户在主界面建的会话（不在插件项目里）：订阅、回答、切换都 forbidden。
    await sendV4Prompt(PROMPTS.outside);
    const outside = await waitForV4Pane(
      (snapshot) =>
        Boolean(snapshot.sessionId && snapshot.sessionId !== "draft") &&
        snapshot.timelineText.includes("E2E_P3E_OUTSIDE_DONE"),
      "the user's own session should reply",
      60000,
    );
    const outsideId = outside.sessionId!;
    const outsideFrom = (await log.lines()).length;
    const outsideStep = await runStep("outside", [
      { name: "watch", input: { sessionId: outsideId } },
      {
        name: "resolveInteraction",
        input: { sessionId: outsideId, interactionId: "missing", answer: { optionId: "allow" } },
      },
      { name: "setPermissionMode", input: { sessionId: outsideId, mode: "guarded" } },
    ]);
    expect(outsideStep[1]?.error).toBe("forbidden");
    expect(outsideStep[2]?.error).toBe("forbidden");
    evidence.outsideWatchError = await waitForLogAfter(
      outsideFrom,
      (line) => line.includes(`E2E_APPROVALS_WATCH_ERROR session=${outsideId}`),
      "watching a session outside the plugin project should end with an error",
    );
    expect(String(evidence.outsideWatchError)).toContain("error=forbidden");

    // (b) 批准一次：宿主审批面板与插件看到同一个交互；插件回答后面板消失，工具执行（文件写出）。
    const allow = await createWatchedSession("allow", PROMPTS.allow);
    const allowEvent = await waitForEvent(
      allow.from,
      allow.session.sessionId,
      (event) => event.interactions.some((entry) => entry.kind === "permission"),
      "the plugin should see the Write approval",
    );
    expect(allowEvent.mode).toBe("build");
    const allowInteraction = allowEvent.interactions[0]!;
    evidence.allowInteraction = allowInteraction;
    await waitForV4PermissionDialog();
    // 行镜像里的工具行状态（宿主行为，以前只由 PLM-JARVIS-2 断言）：等审批时是 pendingApproval。
    const allowRowsFrom = (await log.lines()).length;
    await runStep("allow-rows", [
      { name: "watchRows", input: { sessionId: allow.session.sessionId } },
    ]);
    const pendingRows = await waitForLogAfter(
      allowRowsFrom,
      (line) =>
        line.includes(`E2E_APPROVALS_ROWS session=${allow.session.sessionId} `) &&
        /tools=(\S*,)?Write:pendingApproval\b/.test(line),
      "the rows mirror should show the Write tool row waiting for approval",
    );
    evidence.allowRowsPending = pendingRows;
    screenshots.push(await capturePluginManualReview(CASE_ID, "host-panel-before-zh-CN-zai-light"));
    const allowAnswer = await runStep("allow-answer", [
      {
        name: "resolveInteraction",
        input: {
          sessionId: allow.session.sessionId,
          interactionId: allowInteraction.id,
          answer: { optionId: optionId(allowInteraction, "allowOnce") },
        },
      },
    ]);
    expect(allowAnswer[0]?.ok).toEqual({ status: "accepted" });
    await waitForEvent(
      allow.from,
      allow.session.sessionId,
      (event) => event.interactions.length === 0,
      "the approval should disappear after the plugin answered",
    );
    await browser.waitUntil(async () => !(await hasHostPermissionDialog()), {
      timeout: 30000,
      interval: 300,
      timeoutMsg: "the host permission panel should disappear after the plugin answered",
    });
    await waitForV4AssistantMessageContaining("E2E_P3E_ALLOW_DONE", 90000);
    expect(await exists(outputPath("allow.txt"))).toBe(true);
    // 批准后工具执行完：同一个工具行变成 success。
    evidence.allowRowsDone = await waitForLogAfter(
      allowRowsFrom,
      (line) =>
        line.includes(`E2E_APPROVALS_ROWS session=${allow.session.sessionId} `) &&
        /tools=(\S*,)?Write:success\b/.test(line),
      "the rows mirror should show the Write tool row succeeded",
    );
    await runStep("allow-unwatch-rows", [
      { name: "unwatchRows", input: { sessionId: allow.session.sessionId } },
    ]);

    // (c) 拒绝：工具不执行（文件没有写出），模型收到拒绝结果。
    const deny = await createWatchedSession("deny", PROMPTS.deny);
    const denyEvent = await waitForEvent(
      deny.from,
      deny.session.sessionId,
      (event) => event.interactions.some((entry) => entry.kind === "permission"),
      "the plugin should see the second Write approval",
    );
    const denyInteraction = denyEvent.interactions[0]!;
    const denied = await runStep("deny-answer", [
      {
        name: "resolveInteraction",
        input: {
          sessionId: deny.session.sessionId,
          interactionId: denyInteraction.id,
          answer: { optionId: optionId(denyInteraction, "deny") },
        },
      },
    ]);
    expect(denied[0]?.ok).toEqual({ status: "accepted" });
    await waitForV4AssistantMessageContaining("E2E_P3E_DENY_DONE", 90000);
    expect(await exists(outputPath("deny.txt"))).toBe(false);

    // (d) 回答 AskUserQuestion：答案进了下一次请求（最终夹具要求请求体里有答案）。
    const ask = await createWatchedSession("ask", PROMPTS.ask);
    const askEvent = await waitForEvent(
      ask.from,
      ask.session.sessionId,
      (event) => event.interactions.some((entry) => entry.kind === "userInput"),
      "the plugin should see the AskUserQuestion interaction",
    );
    const askInteraction = askEvent.interactions[0]!;
    // 原由 PLM-JARVIS-2 断言：插件看到的提问带模型给的选项。
    expect(askInteraction.options).toEqual([
      `question:${QUESTION}`,
      "choice:E2E_P3E_ANSWER_A",
      `choice:${ANSWER}`,
    ]);
    const answered = await runStep("ask-answer", [
      {
        name: "resolveInteraction",
        input: {
          sessionId: ask.session.sessionId,
          interactionId: askInteraction.id,
          // 与宿主的回答同一种形状（ElicitationDialog 的 content：answers 按问题原文，answer_<序号>，单题时 answer）。
          answer: {
            action: "accept",
            content: { answers: { [QUESTION]: ANSWER }, answer_0: ANSWER, answer: ANSWER },
          },
        },
      },
    ]);
    expect(answered[0]?.ok).toEqual({ status: "accepted" });
    await waitForV4AssistantMessageContaining("E2E_P3E_ASK_GOT_B", 90000);

    // (e) 宿主先回答：插件之后用同一个交互回答得到 stale，不发命令。
    const host = await createWatchedSession("host", PROMPTS.host);
    const hostEvent = await waitForEvent(
      host.from,
      host.session.sessionId,
      (event) => event.interactions.some((entry) => entry.kind === "permission"),
      "the plugin should see the host-answered approval",
    );
    await approveV4Permission();
    await waitForEvent(
      host.from,
      host.session.sessionId,
      (event) => event.interactions.length === 0,
      "the approval should disappear after the host answered",
    );
    const late = await runStep("host-late-answer", [
      {
        name: "resolveInteraction",
        input: {
          sessionId: host.session.sessionId,
          interactionId: hostEvent.interactions[0]!.id,
          answer: { optionId: optionId(hostEvent.interactions[0]!, "allowOnce") },
        },
      },
    ]);
    expect(late[0]?.ok).toEqual({ status: "stale" });
    await waitForV4AssistantMessageContaining("E2E_P3E_HOST_DONE", 90000);

    // (f) 切换权限模式；没有申请完全访问时 yolo 一律 not-declared。
    const mode = await createWatchedSession("mode", PROMPTS.mode);
    // 修复原因（PLM-EXT-P3E 首跑偶发「看不到 guarded」）：已提交的输入按提交时的模式开跑，轮开始时 CLI 再应用一次
    // （turn.ts「session_persistence」→ applySubmissionExecutionState）。createSession 的首条输入按 build 提交，
    // 首轮开始前切到 guarded，轮一开始就被改回 build；两次变化落在同一帧时插件只看到最终的 build。
    // 这是 CLI 的现有语义（宿主界面相同），所以等首轮做完再切换；首轮就要别的模式用 createSession.mode。
    await waitForV4AssistantMessageContaining("E2E_P3E_MODE_DONE", 90000);
    await waitForEvent(
      mode.from,
      mode.session.sessionId,
      (event) => event.mode === "build",
      "the plugin should see the initial mode",
    );
    const switched = await runStep("mode-switch", [
      { name: "setPermissionMode", input: { sessionId: mode.session.sessionId, mode: "guarded" } },
    ]);
    expect(switched[0]?.ok).toEqual({ status: "accepted" });
    await waitForEvent(
      mode.from,
      mode.session.sessionId,
      (event) => event.mode === "guarded",
      "the plugin should see the guarded mode",
    );
    const refused = await runStep("mode-refused", [
      { name: "setPermissionMode", input: { sessionId: mode.session.sessionId, mode: "guarded" } },
      { name: "setPermissionMode", input: { sessionId: mode.session.sessionId, mode: "yolo" } },
      { name: "createSession", input: { prompt: PROMPTS.yolo, mode: "yolo" } },
    ]);
    expect(refused[0]?.ok).toEqual({ status: "unchanged" });
    expect(refused[1]?.error).toBe("not-declared");
    expect(refused[2]?.error).toBe("not-declared");

    // (g) 清单申请 sessions.fullAccess：重新加载后回到「需要授权」，授权对话框单独写完全访问一行；授权后 yolo 可用。
    await writeManifestGrants(["sessions.fullAccess"]);
    const reloadFrom = (await log.lines()).length;
    await runReloadFromCommandCenter();
    await waitForLogAfter(
      reloadFrom,
      (line) => line.includes(`E2E_APPROVALS_ACTIVATED plugin=${PLUGIN_ID}`),
      "the extension should activate again after reloading",
      90000,
    );
    const notGranted = await runStep("full-not-granted", [
      { name: "setPermissionMode", input: { sessionId: mode.session.sessionId, mode: "yolo" } },
    ]);
    expect(notGranted[0]?.error).toBe("not-granted");
    const dialog = await openGrantDialog();
    evidence.fullAccessDialog = dialog;
    expect(dialog).toContain(`允许「${PLUGIN}」读取和操作会话？`);
    expect(dialog).toContain("插件项目里的会话：插件还能替你批准或拒绝工具调用");
    expect(dialog).toContain("完全访问：插件可以把它项目里的会话切到完全访问");
    screenshots.push(
      await capturePluginManualReview(CASE_ID, "full-access-dialog-zh-CN-zai-light"),
    );
    await confirmGrantDialog();
    const grantedFrom = (await log.lines()).length;
    const granted = await runStep("full-granted", [
      { name: "watch", input: { sessionId: mode.session.sessionId } },
      { name: "setPermissionMode", input: { sessionId: mode.session.sessionId, mode: "yolo" } },
      { name: "createSession", input: { prompt: PROMPTS.yolo, mode: "yolo" } },
    ]);
    expect(granted[1]?.ok).toEqual({ status: "accepted" });
    await waitForEvent(
      grantedFrom,
      mode.session.sessionId,
      (event) => event.mode === "yolo",
      "the plugin should see full access after the grant",
    );
    const yoloSession = createdSession(granted[2], "createSession with mode yolo");
    const yoloFrom = (await log.lines()).length;
    await runStep("yolo-watch", [{ name: "watch", input: { sessionId: yoloSession.sessionId } }]);
    await waitForEvent(
      yoloFrom,
      yoloSession.sessionId,
      (event) => event.mode === "yolo",
      "a session created with mode yolo should start in full access",
    );
    // 原由 PLM-JARVIS-2 断言：完全访问之后能切回 build，插件看到 build。
    const backFrom = (await log.lines()).length;
    const back = await runStep("mode-back", [
      { name: "setPermissionMode", input: { sessionId: mode.session.sessionId, mode: "build" } },
    ]);
    expect(back[0]?.ok).toEqual({ status: "accepted" });
    await waitForEvent(
      backFrom,
      mode.session.sessionId,
      (event) => event.mode === "build",
      "the plugin should see build again after leaving full access",
    );

    // (h) 选「允许并切到完全访问」：模式变成 yolo，工具执行。
    const full = await createWatchedSession("full", PROMPTS.full);
    const fullEvent = await waitForEvent(
      full.from,
      full.session.sessionId,
      (event) =>
        event.interactions.some((entry) =>
          entry.options.some((option) => option.startsWith("fullAccess:")),
        ),
      "the approval should offer full access",
    );
    const fullInteraction = fullEvent.interactions[0]!;
    const fullAnswer = await runStep("full-answer", [
      {
        name: "resolveInteraction",
        input: {
          sessionId: full.session.sessionId,
          interactionId: fullInteraction.id,
          answer: { optionId: optionId(fullInteraction, "fullAccess") },
        },
      },
    ]);
    expect(fullAnswer[0]?.ok).toEqual({ status: "accepted" });
    await waitForEvent(
      full.from,
      full.session.sessionId,
      (event) => event.mode === "yolo" && event.interactions.length === 0,
      "answering with full access should switch the session to yolo",
    );
    await waitForV4AssistantMessageContaining("E2E_P3E_FULL_DONE", 90000);
    expect(await exists(outputPath("full.txt"))).toBe(true);
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    screenshots.push(await capturePluginManualReview(CASE_ID, "after-full-access-en-US-zai-dark"));
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // (i) 插件会话都在插件项目里；插件只看到 permission 与 userInput 两种交互。
    const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
    const workspace = normalize(join(dataPath, "workspace"));
    const projectIds = new Set(
      tree.projects
        .filter((project) => project.roots.some((root) => normalize(root.rootPath) === workspace))
        .map((project) => project.id),
    );
    for (const session of [allow, deny, ask, host, mode, full].map((entry) => entry.session))
      expect(projectIds.has(session.project!.projectId)).toBe(true);
    const kinds = new Set(
      (await log.lines())
        .map(parseEvent)
        .flatMap((event) => event?.interactions.map((entry) => entry.kind) ?? []),
    );
    evidence.interactionKinds = [...kinds];
    expect([...kinds].every((kind) => kind === "permission" || kind === "userInput")).toBe(true);

    // (j) 审计：每次回答、切换一行，有种类与选择，没有问题、答案与提示词。
    const audit = (await readAudit()).filter((row) => row.pluginId === PLUGIN_ID);
    const answers = audit.filter((row) => row.capability === "sessions.resolveInteraction");
    const switches = audit.filter((row) => row.capability === "sessions.setPermissionMode");
    evidence.auditAnswers = answers;
    evidence.auditSwitches = switches;
    expect(answers.map((row) => row.choice)).toEqual(
      expect.arrayContaining(["allowOnce", "deny", "answer", "fullAccess"]),
    );
    expect(answers.find((row) => row.choice === "answer")?.interactionKind).toBe("userInput");
    expect(answers.some((row) => row.errorCode === "result.stale")).toBe(true);
    expect(switches.some((row) => row.mode === "guarded" && row.outcome === "ok")).toBe(true);
    expect(switches.some((row) => row.errorCode === "not-declared")).toBe(true);
    expect(switches.some((row) => row.mode === "yolo" && row.outcome === "ok")).toBe(true);
    const auditText = JSON.stringify(audit);
    for (const secret of [QUESTION, ANSWER, PROMPTS.allow, PROMPTS.ask])
      expect(auditText).not.toContain(secret);
  });
});
