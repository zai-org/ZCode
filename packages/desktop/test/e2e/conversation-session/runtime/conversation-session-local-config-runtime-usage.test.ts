import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_MCP_SERVER_ROW,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomOpenAIChatCompletionsProvider,
} from "#e2e/helpers/custom-openai-provider";
import {
  addMarketplaceSourceThroughAgent,
  clickPluginControl,
  createPluginLifecycleFixture,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
  type UpstreamToolResultSnapshot,
} from "#e2e/helpers/conversation-session-network";
import { hasAssistantReplyForUserTurn } from "#e2e/helpers/conversation-turn-evidence";
import {
  approveV4Permission,
  clickV4Stop,
  getV4ConversationState,
  getV4Messages,
  getV4SlashOptionIds,
  hasV4PermissionDialog,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  setV4ComposerText,
  V4_MAIN_PANE_ID,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

// DSYNC-18：本机配置变更在本机会话中的生效时机，作为 DSYNC-17（远端推送）的对照。
// 每个分类单独打开一个新建任务页（预热会话建好），再按本机真实途径新建该分类：
// 子智能体、MCP、钩子、命令走设置页；技能和 inline 插件没有设置页新建入口，直接写文件；
// marketplace 插件走插件商店安装（商店主视图会卸掉会话面板，所以不测预热草稿）。
// 然后分别在该页、推送前已有的 task A 发探针；最后新建 task C 实际调用各工具。只记录事实，
// 期望由用户确认后再改为断言；task C 的可用性与 DSYNC-17-03 相同，作为断言。
const CASE_MARKER = "E2E_DSYNC_18_LOCAL_RUNTIME";
const TITLE_REQUEST = "Generate a concise title";
const MODEL_ID = "e2e-dsync-18-model";
const PROVIDER_ID = "e2e-dsync-18-provider";
const PROVIDER_NAME = "DSYNC 18 local";

const SKILL_NAME = "e2e-dsync-18-skill";
const SKILL_DESC = "E2E_DSYNC_18_SKILL_DESC";
const SKILL_BODY = "E2E_DSYNC_18_SKILL_BODY";
const AGENT_NAME = "e2e-dsync-18-agent";
const AGENT_DESC = "E2E_DSYNC_18_AGENT_DESC";
const AGENT_BODY = "E2E_DSYNC_18_AGENT_BODY";
const AGENT_DONE = "E2E_DSYNC_18_AGENT_DONE";
const COMMAND_NAME = "e2e-dsync-18-cmd";
const COMMAND_BODY = "E2E_DSYNC_18_COMMAND_BODY";
const MCP_SERVER = "e2e-dsync-18-mcp";
const MCP_TOOL = `mcp__${MCP_SERVER}__marker`;
const MCP_RESULT = "E2E_DSYNC_18_MCP_RESULT";
const INLINE_PLUGIN = "e2e-dsync-18-inline";
const INLINE_TOOL = `mcp__plugin_${INLINE_PLUGIN}_rt__marker`;
const INLINE_RESULT = "E2E_DSYNC_18_INLINE_RESULT";
const MARKET_RESULT = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`;
// 钩子在 workspace 目录（钩子的 cwd）追加标记行，不写 stdout：stdout 会进入上下文。
const HOOK_MARK = "E2E_DSYNC_18_HOOK";
const HOOK_LOG = join(DEFAULT_WORKSPACE, ".e2e-dsync-18-hooks.log");
const HOOK_FORM = '[data-testid="hooks-form"]';
const SCOPE_TRIGGER = '[data-plugin-scope-trigger="true"]';
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/dsync-18-local-runtime",
  "dsync-18",
);

interface StageFacts {
  skillListed: boolean;
  subagentListed: boolean;
  mcpTool: boolean;
  inlinePluginTool: boolean;
  marketplacePluginTool: boolean;
  hookFired: boolean;
}

interface RunOutcome {
  exposed: boolean;
  timedOut: boolean;
  result: UpstreamToolResultSnapshot | null;
}

interface LocalCliConfig {
  [key: string]: unknown;
  plugins?: { [key: string]: unknown; dirs?: string[]; enabledPlugins?: Record<string, boolean> };
}

/** 依赖为零的 stdio MCP 服务器脚本。 */
function mcpServerScript(serverName: string, result: string): string {
  return [
    'const rl = require("node:readline").createInterface({ input: process.stdin });',
    'const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");',
    'rl.on("line", (line) => {',
    "  let request;",
    "  try { request = JSON.parse(line); } catch { return; }",
    `  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(serverName)}, version: "1.0.0" } } });`,
    '  if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "marker", description: "Return the data sync runtime marker", inputSchema: { type: "object", properties: {} } }] } });',
    `  if (request.method === "tools/call") return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: ${JSON.stringify(result)} }] } });`,
    '  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });',
    "});",
  ].join("\n");
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function countHookLines(): Promise<number> {
  const text = await readFile(HOOK_LOG, "utf-8").catch(() => "");
  return text.split("\n").filter((line) => line.includes(HOOK_MARK)).length;
}

/** 本轮首个模型请求（排除标题请求）：请求体文本与工具名。 */
async function readTurnRequest(lastUserMarker: string, afterIndex: number) {
  const query = { lastUserMessageIncludes: [lastUserMarker], excludes: [TITLE_REQUEST] };
  const [request] = await getUpstreamRequestEvidence(query, { afterIndex });
  if (!request) throw new Error(`${CASE_MARKER}: 没有找到 ${lastUserMarker} 的模型请求`);
  return {
    body: JSON.stringify(request.requestJson),
    tools: await getUpstreamRequestToolNames(query),
  };
}

function factsFromRequest(
  request: { body: string; tools: string[] },
  hookFired: boolean,
): StageFacts {
  return {
    skillListed: request.body.includes(SKILL_DESC),
    subagentListed: request.body.includes(AGENT_DESC),
    mcpTool: request.tools.includes(MCP_TOOL),
    inlinePluginTool: request.tools.includes(INLINE_TOOL),
    marketplacePluginTool: request.tools.includes(PLUGIN_LIFECYCLE_MCP_TOOL_NAME),
    hookFired,
  };
}

async function waitForTurnReply(userMarker: string, reply: string): Promise<string> {
  await browser.waitUntil(
    async () => hasAssistantReplyForUserTurn(await getV4Messages(), userMarker, reply),
    { timeout: 120_000, timeoutMsg: `${CASE_MARKER}: ${userMarker} 没有收到回复 ${reply}` },
  );
  const state = await waitForV4ConversationState(
    (snapshot) =>
      Boolean(snapshot.taskId && snapshot.taskId !== "draft") &&
      snapshot.state === "idle" &&
      snapshot.queueCount === 0,
    `${CASE_MARKER}: ${userMarker} 完成后没有回到 idle`,
    120_000,
  );
  return state.taskId!;
}

/** 探针轮次：只回复固定文本，返回本轮模型请求里可见的新建内容与钩子是否执行。 */
async function sendProbe(label: string) {
  const prompt = `${CASE_MARKER}_PROBE_${label}`;
  const reply = `DSYNC_18_PROBE_${label}_REPLY`;
  const hookBefore = await countHookLines();
  const start = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${prompt}: 只回复 ${reply}`,
    prompt,
    `${CASE_MARKER}: 探针 ${label} 没有被接受`,
  );
  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [`${prompt}:`] },
    `${CASE_MARKER}: 探针 ${label} 没有到达回放`,
    120_000,
    { afterIndex: start - 1 },
  );
  const taskId = await waitForTurnReply(prompt, reply);
  const request = await readTurnRequest(`${prompt}:`, start - 1);
  return { taskId, facts: factsFromRequest(request, (await countHookLines()) > hookBefore) };
}

/** 命令轮次：CLI 展开 /命令 时，本轮请求含命令正文与参数。 */
async function sendCommandProbe(label: string): Promise<boolean> {
  const args = `E2E_DSYNC_18_CMD_${label}`;
  const start = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `/${COMMAND_NAME} ${args}`,
    args,
    `${CASE_MARKER}: 命令 ${label} 没有被接受`,
  );
  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [args] },
    `${CASE_MARKER}: 命令 ${label} 没有到达回放`,
    120_000,
    { afterIndex: start - 1 },
  );
  await waitForTurnReply(args, `DSYNC_18_CMD_${label}_REPLY`);
  return (await readTurnRequest(args, start - 1)).body.includes(`${COMMAND_BODY} ${args}`);
}

/** 输入框的 / 菜单里是否有该命令（只读界面，不发送）。 */
async function isCommandInSlashMenu(): Promise<boolean> {
  await setV4ComposerText(`/${COMMAND_NAME}`);
  const found = await browser
    .waitUntil(async () => (await getV4SlashOptionIds()).some((id) => id.includes(COMMAND_NAME)), {
      timeout: 10_000,
      interval: 500,
    })
    .then(
      () => true,
      () => false,
    );
  await setV4ComposerText("");
  return found;
}

/** 执行轮次：回放在工具暴露时调用工具，否则回复 NOT_EXPOSED；卡住时停止本轮并继续。 */
async function runTool(key: string, instruction: string): Promise<RunOutcome> {
  // 带冒号：RUN_AGENT 是 RUN_AGENT_EXISTING 的前缀。
  const prompt = `${CASE_MARKER}_RUN_${key}:`;
  const done = `DSYNC_18_RUN_${key}_DONE`;
  const notExposed = `DSYNC_18_RUN_${key}_NOT_EXPOSED`;
  const toolCallId = `call_dsync18_${key.toLowerCase()}`;
  await sendV4PromptAndWaitAccepted(
    `${prompt} ${instruction}`,
    prompt,
    `${CASE_MARKER}: ${key} 执行轮次没有被接受`,
  );
  let reply: string | null = null;
  const settled = await browser
    .waitUntil(
      async () => {
        if (await hasV4PermissionDialog()) await approveV4Permission();
        const messages = await getV4Messages();
        reply =
          [done, notExposed].find((text) => hasAssistantReplyForUserTurn(messages, prompt, text)) ??
          null;
        return reply !== null;
      },
      { timeout: 120_000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!settled) {
    if ((await getV4ConversationState()).state === "streaming") await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      `${CASE_MARKER}: ${key} 停止后没有回到 idle`,
      120_000,
    );
    return {
      exposed: true,
      timedOut: true,
      result: await getLatestUpstreamToolResultByToolCallId(toolCallId),
    };
  }
  await waitForTurnReply(prompt, reply!);
  return {
    exposed: reply === done,
    timedOut: false,
    result: await getLatestUpstreamToolResultByToolCallId(toolCallId),
  };
}

async function readMainPaneSessionId(): Promise<string | null> {
  return await browser.execute(
    (paneTestId) =>
      document.querySelector(`[data-testid="${paneTestId}"]`)?.getAttribute("data-session-id") ??
      null,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
  );
}

/** 在本机项目里打开新建任务页并选好模型：预热会话在这一步建好。 */
async function openLocalDraft(): Promise<void> {
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await selectUpstreamProviderModelById(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
  });
  await selectUpstreamThoughtLevelValue("disabled");
  expect(await readMainPaneSessionId()).toBe("draft");
}

// ── 设置页操作（与 DSYNC-15 的写法相同：按可见元素操作，React 受控组件用原生 setter）──

async function openSettingsSection(section: string): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有 ${section} 分区`,
  });
  // 本机项目的 tab 下默认是「本机 · 用户」。
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
            (element) => element.getClientRects().length > 0,
          )?.dataset.pluginScopeKey === "user",
        SCOPE_TRIGGER,
      ),
    { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: ${section} 页没有默认选中「本机 · 用户」` },
  );
}

async function closeSettings(): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 30_000 });
  await browser.waitUntil(
    async () => !(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 设置页没有关闭` },
  );
}

/** 点击第一个可见、可用、文案或 aria-label 匹配的按钮。 */
async function clickVisibleButton(labels: readonly string[], timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((expected) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (element) =>
            element.getClientRects().length > 0 &&
            !element.disabled &&
            (expected.includes(element.getAttribute("aria-label") ?? "") ||
              expected.includes(element.innerText.trim()) ||
              expected.includes(element.dataset.settingsCreateAction ?? "")),
        );
        button?.click();
        return Boolean(button);
      }, labels),
    { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}` },
  );
}

async function fillByPlaceholder(placeholder: string, value: string): Promise<void> {
  const filled = await browser.execute(
    (expected, nextValue) => {
      const field = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
      ).find((element) => element.placeholder === expected && element.getClientRects().length > 0);
      if (!field) return false;
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, nextValue);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    placeholder,
    value,
  );
  if (!filled) throw new Error(`${CASE_MARKER}: 表单没有输入框 ${placeholder}`);
}

/** 提交含指定输入框的表单，并等表单关闭。 */
async function submitFormOf(placeholder: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((expected) => {
        const field = Array.from(
          document.querySelectorAll<HTMLInputElement>("input, textarea"),
        ).find((element) => element.placeholder === expected);
        const form = field?.closest("form");
        const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (!form || !submit || submit.disabled) return false;
        form.requestSubmit(submit);
        return true;
      }, placeholder),
    { timeout: 15_000, interval: 300, timeoutMsg: `${CASE_MARKER}: 表单 ${placeholder} 不能保存` },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (expected) =>
          !Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
            (element) => element.placeholder === expected,
          ),
        placeholder,
      ),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 保存后表单 ${placeholder} 没有关闭` },
  );
}

async function createSubagentInSettings(): Promise<void> {
  await openSettingsSection("subagents");
  await clickVisibleButton(["新建", "New"], "子智能体页没有可用的「新建」按钮");
  await fillByPlaceholder("code-reviewer", AGENT_NAME);
  await fillByPlaceholder("展示给模型的简短说明", `${AGENT_DESC} local runtime subagent`);
  await fillByPlaceholder(
    "描述这个子智能体的角色、边界和规则...",
    `${AGENT_BODY} Reply exactly as the task asks.`,
  );
  await submitFormOf("code-reviewer");
  await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, AGENT_NAME), { timeout: 30_000 });
  await closeSettings();
}

async function createMcpInSettings(serverPath: string): Promise<void> {
  await openSettingsSection("mcp");
  await clickVisibleButton(
    ["settings.mcp.create.open", "新建 MCP 服务器"],
    "MCP 页没有可用的「新建 MCP 服务器」",
  );
  await fillByPlaceholder("my-mcp-server", MCP_SERVER);
  await fillByPlaceholder("npx", "node");
  await fillByPlaceholder("-y @modelcontextprotocol/server-memory", serverPath);
  await clickVisibleButton(["保存"], "MCP 表单没有「保存」");
  await waitForTestIdByDom(testId(TID_MCP_SERVER_ROW, MCP_SERVER), { timeout: 30_000 });
  await closeSettings();
}

/** 设置页新建一条 UserPromptSubmit 的 process 钩子：/bin/sh -c 在 workspace 目录追加标记行。 */
async function createHookInSettings(): Promise<void> {
  await openSettingsSection("hooks");
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-settings-create-action="settings.hooks.add"]',
          ),
        ).find((element) => element.getClientRects().length > 0 && !element.disabled);
        button?.click();
        return Boolean(button);
      }),
    { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 没有可用的「新建钩子」` },
  );
  await $(HOOK_FORM).waitForDisplayed({ timeout: 15_000 });
  await $("#hook-event").click();
  await $('[role="option"]*=UserPromptSubmit').click();
  await browser.waitUntil(
    async () => ((await $("#hook-event").getText()) ?? "").includes("UserPromptSubmit"),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 钩子事件没有选中 UserPromptSubmit` },
  );
  for (const [id, value] of [
    ["command", "/bin/sh"],
    ["args", `-c\necho ${HOOK_MARK} >> ${HOOK_LOG}`],
  ] as const) {
    const filled = await browser.execute(
      (selector, fieldId, nextValue) => {
        const field = document
          .querySelector<HTMLElement>(selector)
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${fieldId}`);
        if (!field) return false;
        const prototype =
          field instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, nextValue);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      },
      HOOK_FORM,
      id,
      value,
    );
    if (!filled) throw new Error(`${CASE_MARKER}: 钩子表单没有输入框 #${id}`);
  }
  await browser.waitUntil(
    () =>
      browser.execute((selector) => {
        const button = Array.from(
          document
            .querySelector<HTMLElement>(selector)
            ?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((item) => /^(保存|Save)$/iu.test(item.innerText.trim()) && !item.disabled);
        button?.click();
        return Boolean(button);
      }, HOOK_FORM),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 钩子表单没有可用的保存按钮` },
  );
  await browser.waitUntil(async () => !(await $(HOOK_FORM).isExisting()), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 保存后钩子表单没有关闭`,
  });
  await closeSettings();
}

async function createCommandInSettings(): Promise<void> {
  await openSettingsSection("commands");
  await clickVisibleButton(["新建", "New"], "命令页没有可用的「新建」按钮");
  await fillByPlaceholder("my-command", COMMAND_NAME);
  await fillByPlaceholder("在命令选择器中显示的简短描述", "local runtime command");
  await fillByPlaceholder("填写调用该命令时发送的提示词...", `${COMMAND_BODY} $ARGUMENTS`);
  await submitFormOf("my-command");
  await closeSettings();
}

/** 技能没有设置页新建入口（「新建」是开一个让 Agent 写文件的任务），直接写文件。 */
async function writeSkillFile(homeDir: string): Promise<void> {
  await writeText(
    join(homeDir, ".zcode", "skills", SKILL_NAME, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESC} local runtime skill\n---\n\n${SKILL_BODY}\n`,
  );
}

/** inline 插件没有设置页添加入口，写插件目录并登记到 config.json 的 plugins.dirs。 */
async function writeInlinePlugin(homeDir: string): Promise<void> {
  const dir = join(homeDir, ".zcode", "plugins", INLINE_PLUGIN);
  await writeText(
    join(dir, ".zcode-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: INLINE_PLUGIN,
        version: "1.0.0",
        description: "local runtime inline plugin",
        mcpServers: {
          rt: { type: "stdio", command: "node", args: ["${ZCODE_PLUGIN_ROOT}/server.cjs"] },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeText(join(dir, "server.cjs"), `${mcpServerScript(INLINE_PLUGIN, INLINE_RESULT)}\n`);
  const configPath = join(homeDir, ".zcode", "cli", "config.json");
  const config = await readFile(configPath, "utf-8")
    .then((text) => JSON.parse(text) as LocalCliConfig)
    .catch((): LocalCliConfig => ({}));
  const plugins = config.plugins ?? {};
  await writeText(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        plugins: {
          ...plugins,
          dirs: [...(plugins.dirs ?? []), dir],
          enabledPlugins: { ...plugins.enabledPlugins, [`${INLINE_PLUGIN}@inline`]: true },
        },
      },
      null,
      2,
    )}\n`,
  );
}

describe(`${CASE_MARKER}: 本机配置变更在本机会话中的生效时机`, () => {
  let taskAId = "";
  const facts: Record<string, unknown> = {};
  const record = (key: string, value: unknown) => {
    facts[key] = value;
    process.stdout.write(`[${CASE_MARKER}] ${key} ${JSON.stringify(value)}\n`);
  };

  /** 推送前已打开的新建任务页：变更后在该页发送；再到 task A 续发。 */
  async function measureStage(
    label: string,
    change: () => Promise<void>,
    options: { secondDraftTurn?: boolean } = {},
  ): Promise<void> {
    await openLocalDraft();
    await change();
    expect(await readMainPaneSessionId()).toBe("draft");
    const draft = await sendProbe(`DRAFT_${label}`);
    await selectV4TaskById(taskAId, 30_000);
    const existing = await sendProbe(`EXISTING_${label}`);
    expect(existing.taskId).toBe(taskAId);
    // 子智能体：Host 缓存靠文件监听更新，写入后约 1–1.5 秒才生效（awaitWriteFinish 1000ms）。
    // 回到草稿生成的 task 再发一轮，区分「空窗内看不到」与「这个会话一直看不到」。
    let draftSecondTurn: StageFacts | undefined;
    if (options.secondDraftTurn) {
      await selectV4TaskById(draft.taskId, 30_000);
      draftSecondTurn = (await sendProbe(`DRAFT_${label}_2`)).facts;
    }
    record(label, { draft: draft.facts, existing: existing.facts, draftSecondTurn });
  }

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "runtime-usage.json"), `${JSON.stringify(facts, null, 2)}\n`);
    await rm(HOOK_LOG, { force: true });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-18-01 本机逐类新建配置：记录推送前打开的新建任务页与已有 task 的可见内容", async function () {
    this.timeout(40 * 60_000);
    const { homeDir } = getE2EAppDataPaths();
    await rm(HOOK_LOG, { force: true });
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedCustomOpenAIChatCompletionsProvider({
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
    });
    await refreshSeededOpenAIProvidersThroughSettings([PROVIDER_NAME], {
      workspacePath: DEFAULT_WORKSPACE,
    });
    const marketplace = await createPluginLifecycleFixture("1.0.0");
    await addMarketplaceSourceThroughAgent(marketplace.marketplaceRoot);
    const mcpServerPath = join(homeDir, "e2e-dsync-18", "mcp-server.cjs");
    await writeText(mcpServerPath, `${mcpServerScript(MCP_SERVER, MCP_RESULT)}\n`);

    await openLocalDraft();
    const firstPrompt = `${CASE_MARKER}_A_FIRST_PROMPT`;
    const start = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${firstPrompt}: 只回复 DSYNC_18_LOCAL_RUNTIME_REPLY`,
      firstPrompt,
      `${CASE_MARKER}: task A 首发没有被接受`,
    );
    taskAId = await waitForTurnReply(firstPrompt, "DSYNC_18_LOCAL_RUNTIME_REPLY");
    const control = factsFromRequest(
      await readTurnRequest(firstPrompt, start - 1),
      (await countHookLines()) > 0,
    );
    record("control", control);
    expect(Object.values(control).some(Boolean)).toBe(false);

    await measureStage("SUBAGENT", createSubagentInSettings, { secondDraftTurn: true });
    await measureStage("MCP", () => createMcpInSettings(mcpServerPath));
    await measureStage("HOOK", createHookInSettings);

    // 命令：在推送前打开的新建任务页直接发 /命令；再到 task A 发。
    await openLocalDraft();
    await createCommandInSettings();
    expect(await readMainPaneSessionId()).toBe("draft");
    const slashMenuAfterSave = await isCommandInSlashMenu();
    const draftCommand = await sendCommandProbe("DRAFT");
    await selectV4TaskById(taskAId, 30_000);
    record("COMMAND", {
      slashMenuAfterSave,
      draftExpanded: draftCommand,
      existingExpanded: await sendCommandProbe("EXISTING"),
    });

    await measureStage("SKILL", () => writeSkillFile(homeDir));
    await measureStage("INLINE", () => writeInlinePlugin(homeDir));

    // marketplace 插件：插件商店主视图会卸掉会话面板（预热会话随之丢弃），只测已有 task。
    await waitUntilPluginOverview(
      (overview) => overview.availablePlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
      `${CASE_MARKER}: 本地目录 marketplace 的插件没有出现在可用列表`,
      60_000,
    );
    await openPluginSettings();
    // 本地目录添加的 marketplace 在商店的「个人」分段。
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    await selectV4TaskById(taskAId, 30_000);
    record("MARKET", { existing: (await sendProbe("EXISTING_MARKET")).facts });
  });

  it("DSYNC-18-02 已有 task：按名字调用 Skill，调用新建的子智能体", async function () {
    this.timeout(10 * 60_000);
    await selectV4TaskById(taskAId, 30_000);
    const skill = await runTool(
      "SKILL_EXISTING",
      `调用 Skill 工具加载 ${SKILL_NAME}，然后只回复 DSYNC_18_RUN_SKILL_EXISTING_DONE`,
    );
    const agent = await runTool(
      "AGENT_EXISTING",
      `用 Agent 工具运行子智能体 ${AGENT_NAME}，然后只回复 DSYNC_18_RUN_AGENT_EXISTING_DONE`,
    );
    record("existingRuns", {
      skill: { ...skill, result: null, bodyReturned: skill.result?.content.includes(SKILL_BODY) },
      agent,
    });
  });

  it("DSYNC-18-03 变更后新建 task：各类内容都可见并真正执行，钩子执行，命令展开", async function () {
    this.timeout(20 * 60_000);
    await openLocalDraft();
    const fresh = await sendProbe("NEW");
    record("newTask", fresh.facts);
    expect(fresh.facts).toEqual({
      skillListed: true,
      subagentListed: true,
      mcpTool: true,
      inlinePluginTool: true,
      marketplacePluginTool: true,
      hookFired: true,
    });
    expect(await sendCommandProbe("NEW")).toBe(true);

    const mcp = await runTool("MCP", `调用 ${MCP_TOOL} 一次，然后只回复 DSYNC_18_RUN_MCP_DONE`);
    const inline = await runTool(
      "INLINE",
      `调用 ${INLINE_TOOL} 一次，然后只回复 DSYNC_18_RUN_INLINE_DONE`,
    );
    const market = await runTool(
      "MARKET",
      `调用 ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} 一次，然后只回复 DSYNC_18_RUN_MARKET_DONE`,
    );
    const skill = await runTool(
      "SKILL_NEW",
      `调用 Skill 工具加载 ${SKILL_NAME}，然后只回复 DSYNC_18_RUN_SKILL_NEW_DONE`,
    );
    const agent = await runTool(
      "AGENT",
      `用 Agent 工具运行子智能体 ${AGENT_NAME}，然后只回复 DSYNC_18_RUN_AGENT_DONE`,
    );
    const subagentRequests = await countUpstreamRequests({ includes: [AGENT_BODY] });
    record("newTaskRuns", { mcp, inline, market, skill, agent, subagentRequests });

    for (const run of [mcp, inline, market, skill, agent]) {
      expect(run.timedOut).toBe(false);
      expect(run.exposed).toBe(true);
      expect(run.result?.isError).toBe(false);
    }
    expect(mcp.result?.content.trim()).toBe(MCP_RESULT);
    expect(inline.result?.content.trim()).toBe(INLINE_RESULT);
    expect(market.result?.content.trim()).toBe(MARKET_RESULT);
    expect(skill.result?.content).toContain(SKILL_BODY);
    expect(agent.result?.content).toContain(AGENT_DONE);
    expect(subagentRequests).toBeGreaterThan(0);
  });
});
