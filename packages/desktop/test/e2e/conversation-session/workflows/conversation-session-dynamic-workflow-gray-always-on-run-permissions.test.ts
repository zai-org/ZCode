import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  approveV4Permission,
  denyV4PermissionWithFeedback,
  getV4ConfigProjection,
  getV4PaneSnapshot,
  hasV4PermissionDialog,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";

// run 里的权限（docs/dynamic-workflow/launch.md「Permissions inside a run」）：子代理跑在发起 run 的会话的
// 权限模式上，模式在建 run 时定下（记进 run-launched 的 subagentPermissionMode），之后会话换模式不影响
// 在飞的 run。子代理的询问用父会话的 id 发出，权限窗画在父会话里，带「子智能体 · <名字> (<siteId>@<序号>)」
// 来源徽标，且不提供「完全访问」。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只决定模型调用（主代理与子代理）；真实 Skill、编译、确认窗、run 引擎、权限判定、
// Bash 执行与完成通知走产品链路。会话模式由 composer 的模式选择器设定，随下一次发送生效。
// 模式固定那条 run 用 `world.run("node", …)` 等闸文件，用例在会话换模式之后才写闸文件，不靠计时。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const DENY_FEEDBACK = "E2E_DWM_DENY_FEEDBACK 这次不要写文件";
const KEEP_GATE = "dwm-gate-keep";
const OUTPUT_FILES = ["dwm-ask.txt", "dwm-yolo.txt", "dwm-keep.txt", "dwm-keep-main.txt"];

interface SubagentAskSnapshot {
  parentSessionId: string | null;
  badgeText: string;
  badgeTitle: string;
  options: Array<{ kind: string; label: string }>;
  text: string;
}

describe("动态工作流 · run 里的权限询问", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
    await Promise.all(
      [KEEP_GATE, ...OUTPUT_FILES].map((name) => rm(resolveE2ERuntimePath(name), { force: true })),
    );
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWM-01 Build 会话起的 run：子代理的 Bash 在父会话弹出权限窗，带「子智能体 · 写手甲 (…@…)」徽标，不提供完全访问", async function () {
    this.timeout(240000);
    await useSessionMode("build");
    await sendV4Prompt("E2E_DWM_ASK_START 用工作流让一个子代理写文件。");
    await approveWorkflowWindow();
    const runId = await readLaunchedRunId("toolu_dwm_ask_create");

    const ask = await waitForSubagentAsk("E2E_DWM_ASK_OUTPUT");
    // 询问走父会话：权限窗画在发起 run 的会话的 pane 里。
    expect(ask.parentSessionId).toBe((await getV4PaneSnapshot()).sessionId);
    expect(ask.badgeText).toMatch(/^子智能体 · 写手甲 \(\S+@\d+\)$/);
    expect(ask.badgeTitle).toContain("写手甲");
    // 与普通子代理同样的选项：允许 / 拒绝，从不提供完全访问。
    const kinds = ask.options.map((option) => option.kind);
    expect(kinds).toContain("allowOnce");
    expect(kinds).toContain("rejectOnce");
    for (const option of ask.options) {
      expect(option.label).not.toMatch(/完全访问|Full access/);
    }
    // 还没答：命令没跑，run 在等。
    await expect(readFile(resolveE2ERuntimePath("dwm-ask.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await runDigest(runId).getAttribute("data-workflow-run-status")).toBe("running");
  });

  it("DWM-02 拒绝：子代理下一次请求带着拒绝的工具结果（含反馈）继续，回答后 run 完成，文件没写", async function () {
    this.timeout(240000);
    expect(await denyV4PermissionWithFeedback(DENY_FEEDBACK)).toBe(true);

    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwm_ask_agent_bash")) !== null,
      { timeout: 60000, timeoutMsg: "子代理下一次请求没有带上 Bash 的工具结果" },
    );
    const denied = await getLatestUpstreamToolResultByToolCallId("toolu_dwm_ask_agent_bash");
    expect(denied?.isError).toBe(true);
    expect(denied?.content).toContain("E2E_DWM_DENY_FEEDBACK");
    expect(denied?.content).not.toContain("E2E_DWM_ASK_OUTPUT\n");

    // 子代理照常回答，run 完成，主代理被通知唤起；通知里带子代理的回答。
    await waitForV4AssistantMessageContaining("E2E_DWM_ASK_DONE", 120000);
    const [notified] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["<task-notification>", "E2E_DWM_ASK_RESULT"],
    });
    expect(JSON.stringify(notified?.requestJson)).toContain("E2E_DWM_ASK_ANSWER");
    await waitForV4Pane((pane) => !pane.canStop, "通知那一轮没有结束", 60000);
    expect(await hasV4PermissionDialog()).toBe(false);
    await expect(readFile(resolveE2ERuntimePath("dwm-ask.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("DWM-03 完全访问会话起的 run：确认窗照样出现；子代理的 Bash 不弹权限窗直接执行", async function () {
    this.timeout(240000);
    await useSessionMode("yolo");
    await sendV4Prompt("E2E_DWM_YOLO_START 用工作流让一个子代理写文件。");
    // CreateWorkflow 声明 alwaysAsk：完全访问下也问（launch.md「Why the window always appears」）。
    await approveWorkflowWindow();
    await readLaunchedRunId("toolu_dwm_yolo_create");

    const result = await waitForToolResultWithoutAsk("toolu_dwm_yolo_agent_bash");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("E2E_DWM_YOLO_OUTPUT");
    expect(await readFile(resolveE2ERuntimePath("dwm-yolo.txt"), "utf8")).toBe(
      "E2E_DWM_YOLO_OUTPUT\n",
    );
    await waitForV4AssistantMessageContaining("E2E_DWM_YOLO_DONE", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "通知那一轮没有结束", 60000);
  });

  it("DWM-04 run 保持建 run 时的模式：Build 起的 run 停在闸上时会话换成完全访问，子代理的 Bash 仍然询问，允许一次后写入", async function () {
    this.timeout(300000);
    await useSessionMode("build");
    await sendV4Prompt("E2E_DWM_KEEP_START 用工作流让一个子代理在放行后写文件。");
    await approveWorkflowWindow();
    const runId = await readLaunchedRunId("toolu_dwm_keep_create");
    await waitForV4AssistantMessageContaining("E2E_DWM_KEEP_STARTED", 60000);
    await waitForV4Pane((pane) => !pane.canStop, "启动轮没有结束", 30000);
    expect(await runDigest(runId).getAttribute("data-workflow-run-status")).toBe("running");
    // 闸没开：子代理还没起。
    expect(await countUpstreamRequests({ lastUserMessageIncludes: ["E2E_DWM_KEEP_TASK"] })).toBe(0);

    // 会话换成完全访问并发一句话：主代理这一轮自己的 Bash 不询问，证明会话已在 YOLO。
    await useSessionMode("yolo");
    await sendV4Prompt("E2E_DWM_KEEP_SWITCH 换成完全访问后跑一条命令。");
    const mainResult = await waitForToolResultWithoutAsk("toolu_dwm_keep_main_bash");
    expect(mainResult.isError).toBe(false);
    await waitForV4AssistantMessageContaining("E2E_DWM_KEEP_SWITCHED", 60000);
    await waitForV4Pane((pane) => !pane.canStop, "换模式那一轮没有结束", 30000);

    await openGate(KEEP_GATE);
    // run 记下的是 Build：子代理照样询问。
    const ask = await waitForSubagentAsk("E2E_DWM_KEEP_OUTPUT");
    expect(ask.badgeText).toMatch(/^子智能体 · 写手丙 \(\S+@\d+\)$/);
    expect(ask.options.map((option) => option.label).join("|")).not.toMatch(/完全访问|Full access/);
    expect(await approveV4Permission()).toBe(true);

    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwm_keep_agent_bash")) !== null,
      { timeout: 60000, timeoutMsg: "子代理下一次请求没有带上 Bash 的工具结果" },
    );
    const allowed = await getLatestUpstreamToolResultByToolCallId("toolu_dwm_keep_agent_bash");
    expect(allowed?.isError).toBe(false);
    expect(allowed?.content).toContain("E2E_DWM_KEEP_OUTPUT");
    expect(await readFile(resolveE2ERuntimePath("dwm-keep.txt"), "utf8")).toBe(
      "E2E_DWM_KEEP_OUTPUT\n",
    );
    await waitForV4AssistantMessageContaining("E2E_DWM_KEEP_DONE", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "通知那一轮没有结束", 60000);
  });
});

function runDigest(runId: string) {
  return $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);
}

/** 在 composer 选择器里换模式；它只改草稿，下一次发送才把模式带给会话。 */
async function useSessionMode(mode: "build" | "yolo") {
  await switchV4Mode(mode);
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === mode, {
    timeout: 30000,
    timeoutMsg: `composer 没有切到 mode=${mode}`,
  });
}

/**
 * 只批准工作流确认窗。通用的 approveV4Permission 在窗还开着时会再点首项，子代理的询问紧跟着弹出时
 * 会被它误批；这里只认带工作流块的那个窗。
 */
async function approveWorkflowWindow() {
  const clickAllow = () =>
    browser.execute(() => {
      const block = document.querySelector('[data-workflow-permission-block="true"]');
      const dock = block?.closest<HTMLElement>('[data-v4-composer-dock="true"]');
      const option = dock?.querySelector<HTMLButtonElement>(
        'button[role="option"][data-permission-option-kind="allowOnce"]',
      );
      option?.click();
      return Boolean(option);
    });
  await browser.waitUntil(clickAllow, { timeout: 60000, timeoutMsg: "工作流确认窗没有出现" });
  await browser.waitUntil(
    async () => {
      const open = await browser.execute(() =>
        Boolean(document.querySelector('[data-workflow-permission-block="true"]')),
      );
      if (open) await clickAllow();
      return !open;
    },
    { timeout: 15000, timeoutMsg: "工作流确认窗批准后没有关闭" },
  );
}

/** CreateWorkflow 的工具结果写着新 run 的 id。 */
async function readLaunchedRunId(toolCallId: string) {
  await browser.waitUntil(
    async () => (await getLatestUpstreamToolResultByToolCallId(toolCallId))?.isError === false,
    { timeout: 60000, timeoutMsg: `${toolCallId} 未执行成功` },
  );
  const result = await getLatestUpstreamToolResultByToolCallId(toolCallId);
  const launched = /started in the background with ID: (\S+?)\./.exec(result?.content ?? "");
  expect(launched).not.toBeNull();
  return launched![1]!;
}

/** 等父会话里出现带子代理来源徽标、且写着这条命令的权限窗。 */
async function waitForSubagentAsk(commandMarker: string): Promise<SubagentAskSnapshot> {
  let latest: SubagentAskSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readSubagentAsk();
      return Boolean(latest?.badgeText && latest.text.includes(commandMarker));
    },
    {
      timeout: 90000,
      timeoutMsg: `父会话没有出现子代理的权限窗; latest=${JSON.stringify(latest)}`,
    },
  );
  return latest!;
}

function readSubagentAsk(): Promise<SubagentAskSnapshot | null> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/ /g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (element) =>
        ["Permission required", "需要权限"].includes(normalize(element.getAttribute("aria-label"))),
    );
    const dock = listbox?.closest<HTMLElement>('[data-v4-composer-dock="true"]');
    const badge = dock?.querySelector<HTMLElement>('[data-interaction-origin-badge="subagent"]');
    if (!listbox || !dock || !badge) return null;
    return {
      parentSessionId:
        dock
          .closest<HTMLElement>('[data-testid^="v4-session-pane-"]')
          ?.getAttribute("data-session-id") ?? null,
      // 徽标按宽度截断，完整文字在 DOM 与 tooltip 里。
      badgeText: normalize(badge.textContent),
      badgeTitle: normalize(badge.getAttribute("title")),
      options: Array.from(listbox.querySelectorAll<HTMLElement>('button[role="option"]')).map(
        (option) => ({
          kind: option.getAttribute("data-permission-option-kind") ?? "",
          label: normalize(
            `${option.getAttribute("aria-label") ?? ""} ${option.textContent ?? ""}`,
          ),
        }),
      ),
      text: normalize(dock.textContent),
    };
  });
}

/** 等某个 Bash 的工具结果进入下一次请求；途中一旦出现权限窗就失败（这里不该询问）。 */
async function waitForToolResultWithoutAsk(toolCallId: string) {
  let asked = false;
  await browser.waitUntil(
    async () => {
      if (await hasV4PermissionDialog()) {
        asked = true;
        return true;
      }
      return (await getLatestUpstreamToolResultByToolCallId(toolCallId)) !== null;
    },
    { timeout: 90000, timeoutMsg: `${toolCallId} 的工具结果没有出现` },
  );
  if (asked) {
    throw new Error(
      `${toolCallId} 弹出了权限窗：完全访问下不该询问; ask=${JSON.stringify(await readSubagentAsk())}`,
    );
  }
  return (await getLatestUpstreamToolResultByToolCallId(toolCallId))!;
}

/** 写闸文件：脚本里的 `world.run("node", …)` 看到它就退出，run 往下走到子代理。 */
async function openGate(name: string) {
  const path = resolveE2ERuntimePath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "open\n");
}
