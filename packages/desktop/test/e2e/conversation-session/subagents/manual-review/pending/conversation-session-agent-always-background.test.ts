// AAB01–AAB02 子智能体总在后台运行开关（docs/conversation-session-case-catalog.md「子智能体总在后台运行」）。
// 规格见 apps/zcode-cli/docs/design/v2/tool/07-subagent.md「ZCode 当前实现」。
// 开关缺省开启，只在创建 runtime 时读取；wdio.conf.ts 为其他用例写入关闭，本用例不写，保留产品缺省。
// wdio 按 worker 判定是否写入，所以本用例必须独占一个 worker：和其他 spec 同组时，它们会按开启运行，回放对不上。
// 断言读取上游请求体与 Composer 的后台工作计数。不读 Agent 卡片的后台区块：V4 时间线里 Agent 有子会话时，
// 点卡片打开右侧子会话，不在行内展开（ConversationAgentToolCallRow 的 agentSummaryAction）。
import {
  TID_SETTINGS_AGENT_ALWAYS_BACKGROUND_SWITCH,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import {
  getV4ComposerBackgroundWorkCounts,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

type Block = Record<string, unknown> & { type?: string };
type Message = { role: string; content: unknown };
type Tool = { name?: string; description?: string; input_schema?: { properties?: object } };
type Request = { messages: Message[]; tools?: Tool[] };

const LAUNCH = "Async agent launched successfully.";
const ALWAYS_BACKGROUND_LINE =
  "- Subagents run in the background; you'll be notified when one completes.";
const OPTIONAL_BACKGROUND_LINE = "`run_in_background: true` runs the agent asynchronously";
const A_AGENTS = ["toolu_aab_a_plain", "toolu_aab_a_legacy"] as const;
const B_AGENT = "toolu_aab_b_plain";

describe("AAB 子智能体总在后台运行开关", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("AAB01–AAB02：缺省开启时都在后台启动；关闭后新任务回到可选前台，运行中的任务不变", async function () {
    this.timeout(600_000);
    await prepareV4ConversationE2E();

    // AAB01：wdio 不写这个键；app 启动时会按缺省把 true 写回 setting.json，所以只断言不是关闭。
    expect((await readSettings()).agentAlwaysBackgroundEnabled).not.toBe(false);
    await openSettings();
    expect(await readSwitch()).toBe(true);
    await closeSettings();

    // 一个调用没有 run_in_background，一个带遗留的 false；两个都在后台启动，A 的启动轮先结束。
    await sendV4Prompt("E2E_AAB_A1 Launch two helpers.");
    // 启动回执返回时后台任务已经登记，Composer 显示两个后台子代理。放在等收尾文字之前：子代理的
    // fixture 延迟（8 / 10 秒）从请求到达时起算，等完父会话的收尾回合再看，可用窗口会被吃掉一截。
    await browser.waitUntil(
      async () => (await getV4ComposerBackgroundWorkCounts())?.subagentCount === 2,
      { timeout: 15_000, timeoutMsg: "Composer 没有显示两个运行中的后台子代理" },
    );
    await waitForV4TimelineContaining("AAB_A_LAUNCHED", 120_000);
    const [a1, a2] = await requestsByFixture(["aab-a1", "aab-a2"]);
    expect(agentSchemaKeys(a1!)).not.toContain("run_in_background");
    expect(agentTool(a1!).description).toContain(ALWAYS_BACKGROUND_LINE);
    expect(agentTool(a1!).description).not.toContain(OPTIONAL_BACKGROUND_LINE);
    for (const toolCallId of A_AGENTS) {
      expect(toolResultText(a2!, toolCallId).startsWith(LAUNCH)).toBe(true);
    }

    // 子代理完成后，通知开启父会话新一轮；两个通知可能分两轮，也可能合为一轮。
    await browser.waitUntil(
      async () => {
        const text = (await recordsByFixture("aab-a-notify")).map(lastUserText).join("\n");
        return A_AGENTS.every((id) => text.includes(`<tool-use-id>${id}</tool-use-id>`));
      },
      { timeout: 120_000, timeoutMsg: "两个后台 Agent 没有都送回 <task-notification>" },
    );
    const taskA = await idleSessionId("A 的通知轮没有结束");

    // AAB02：关闭开关，不重启。运行中的 A 保持开启；之后新建的 B 回到可选 run_in_background。
    await openSettings();
    await setSwitch(false);
    await closeSettings(taskA);
    await sendV4Prompt("E2E_AAB_A3 Say done.");
    await waitForV4TimelineContaining("AAB_A3_DONE", 120_000);
    await idleSessionId("A 的第二轮没有结束");
    const [a3] = await requestsByFixture(["aab-a3"]);
    expect(agentSchemaKeys(a3!)).not.toContain("run_in_background");

    // 草稿在关闭开关之后创建，才会读到关闭。
    await prepareV4ConversationE2E({ skipProvider: true });
    await sendV4Prompt("E2E_AAB_B1 Run one helper.");
    await waitForV4TimelineContaining("AAB_B_DONE", 120_000);
    await idleSessionId("B 第一轮没有结束");
    const [b1, b2] = await requestsByFixture(["aab-b1", "aab-b2"]);
    expect(agentSchemaKeys(b1!)).toContain("run_in_background");
    expect(agentTool(b1!).description).toContain(OPTIONAL_BACKGROUND_LINE);
    expect(agentTool(b1!).description).not.toContain(ALWAYS_BACKGROUND_LINE);
    const foregroundResult = toolResultText(b2!, B_AGENT);
    expect(foregroundResult).toContain("E2E_AAB_CHILD_B_DONE");
    expect(foregroundResult).not.toContain(LAUNCH);
    // 前台子代理已在本轮结束，B 没有留下运行中的后台工作。
    expect(await getV4ComposerBackgroundWorkCounts()).toBeNull();
  });
});

async function idleSessionId(timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft") && !current.canStop,
    timeoutMsg,
    120_000,
  );
  return snapshot.sessionId!;
}

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (pageTestId) => Boolean(document.querySelector(`[data-testid="${pageTestId}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有行为与工具分区入口",
  });
  await browser.waitUntil(async () => (await readSwitch()) !== null, {
    timeout: 15_000,
    timeoutMsg: "行为与工具设置没有子智能体后台开关",
  });
}

async function closeSettings(expectedSessionId?: string) {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForV4Pane(
    (snapshot) =>
      expectedSessionId ? snapshot.sessionId === expectedSessionId : snapshot.sessionId !== null,
    expectedSessionId ? `返回工作区后没有恢复 Session ${expectedSessionId}` : "返回工作区失败",
    30_000,
  );
}

async function setSwitch(enabled: boolean) {
  if ((await readSwitch()) !== enabled) {
    await clickTestIdByDom(TID_SETTINGS_AGENT_ALWAYS_BACKGROUND_SWITCH, {
      timeout: 15_000,
      timeoutMsg: "子智能体后台开关不可点击",
    });
  }
  await browser.waitUntil(
    async () =>
      (await readSwitch()) === enabled &&
      (await readSettings()).agentAlwaysBackgroundEnabled === enabled,
    { timeout: 15_000, timeoutMsg: `子智能体后台设置没有保存为 ${String(enabled)}` },
  );
}

function readSwitch(): Promise<boolean | null> {
  return browser.execute((switchTestId) => {
    const control = document.querySelector<HTMLElement>(`[data-testid="${switchTestId}"]`);
    if (!control) return null;
    return (
      control.getAttribute("aria-checked") === "true" ||
      control.getAttribute("data-state") === "checked"
    );
  }, TID_SETTINGS_AGENT_ALWAYS_BACKGROUND_SWITCH);
}

async function recordsByFixture(fixtureId: string): Promise<Request[]> {
  const records = await getUpstreamRequestEvidence({});
  return records
    .filter((record) => record.fixtureId === fixtureId)
    .map((record) => record.requestJson as Request);
}

/** 按 fixture id 取上游请求；每个 fixture 取第一次匹配。 */
async function requestsByFixture(ids: string[]): Promise<Request[]> {
  const records = await getUpstreamRequestEvidence({});
  return ids.map((fixtureId) => {
    const request = records.find((item) => item.fixtureId === fixtureId)?.requestJson as
      | Request
      | undefined;
    if (!request || !Array.isArray(request.messages)) throw new Error(`${fixtureId} 没有上游请求`);
    return request;
  });
}

function agentTool(request: Request): Tool {
  const tool = request.tools?.find((item) => item.name === "Agent");
  if (!tool) throw new Error("请求的 tools 里没有 Agent");
  return tool;
}

function agentSchemaKeys(request: Request): string[] {
  return Object.keys(agentTool(request).input_schema?.properties ?? {});
}

function toolResultText(request: Request, toolUseId: string): string {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Block[]) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
        return blocksText(block.content);
      }
    }
  }
  throw new Error(`请求里没有 ${toolUseId} 的 tool_result`);
}

function lastUserText(request: Request): string {
  const last = request.messages.findLast((message) => message.role === "user");
  return last ? blocksText(last.content) : "";
}

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((block) =>
      block.type === "tool_result" ? blocksText(block.content) : String(block.text ?? ""),
    )
    .join("");
}
