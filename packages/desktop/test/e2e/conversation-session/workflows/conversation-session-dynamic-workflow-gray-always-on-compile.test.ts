import { join } from "node:path";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { readDynamicWorkflowGrayMockStatus } from "#e2e/helpers/dynamic-workflow-gray";
import {
  hasV4PermissionDialog,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialogInComposerDock,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  type UpstreamToolResultSnapshot,
} from "#e2e/helpers/conversation-session-network";
import { isOutsideClosedHistory, openClosedHistoryFolds } from "#e2e/helpers/v4-history-folds";

// 编不过的脚本、技能门与草稿文件（docs/dynamic-workflow/launch.md「Failures that never reach the
// window」「Script files」；docs/dynamic-workflow/authoring.md「The skill gate」；外观见
// docs/dynamic-workflow/presentation.md「Compiler feedback」）。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只固定模型的 Skill / Write / Edit / CreateWorkflow 选择与收尾文本；真实 Skill
// 加载、技能门、编译、草稿落盘、草稿免确认、确认窗与应答都走产品链路。确认窗一律拒绝收尾，
// 不起 run。每个 it 开一个新会话：技能是否加载按会话历史判定。
const WORKFLOW_BLOCK = '[data-workflow-permission-block="true"]';
const RUN_DIGEST = '[data-workflow-run-digest="true"]';
// 修复原因：CLI 交给模型的草稿路径是平台原生相对路径，Windows 上为 `.zcode\workflow-drafts\…`；
// 旧常量固定用 `/`，诊断行前缀与 NOTE 在 Windows 上全部匹配不到。这里按平台分隔符拼出期望值。
const INLINE_DRAFT = join(".zcode", "workflow-drafts", "E2E_DWE_INLINE.dwf.ts");
const PATH_DRAFT = join(".zcode", "workflow-drafts", "e2e-dwe-path.dwf.ts");
const FEEDBACK_LEDE = "类型检查未通过，脚本未运行；反馈已交回模型，由它修改后重新提交。";

const triggerOf = (toolCallId: string) => `[data-testid="tool-summary-trigger-${toolCallId}"]`;

interface DraftRowState {
  text: string;
  ordinal: string | null;
  status: string | null;
  lamp: string | null;
}

interface FeedbackCardState {
  title: string;
  count: string;
  lede: string;
  lines: string[];
  hasScript: boolean;
}

/** 等确认窗进入 composer dock，且画的是这一次调用（按工作流名认）。 */
async function waitForWorkflowWindow(name: string) {
  await waitForV4PermissionDialogInComposerDock(120000);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector: string, expected: string) =>
          document.querySelector<HTMLElement>(selector)?.innerText.includes(expected) ?? false,
        WORKFLOW_BLOCK,
        name,
      ),
    { timeout: 30000, timeoutMsg: `确认窗没有画出工作流 ${name}` },
  );
}

/** 拒绝确认窗：未选中时第一次点击只选中，再点才应答，所以点到窗关闭为止。 */
async function rejectWorkflowWindow() {
  const clickReject = () =>
    browser.execute(() => {
      const option = document.querySelector<HTMLButtonElement>(
        '[data-v4-composer-dock="true"] [role="listbox"] button[role="option"][data-permission-option-kind="rejectOnce"]',
      );
      option?.click();
      return Boolean(option);
    });
  expect(await clickReject()).toBe(true);
  await browser.waitUntil(
    async () => {
      if (!(await hasV4PermissionDialog())) return true;
      await clickReject();
      return false;
    },
    { timeout: 15000, timeoutMsg: "选了拒绝后确认窗没有关闭" },
  );
}

async function waitForToolResult(toolCallId: string): Promise<UpstreamToolResultSnapshot> {
  let result: UpstreamToolResultSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      result = await getLatestUpstreamToolResultByToolCallId(toolCallId);
      return result !== null;
    },
    { timeout: 60000, timeoutMsg: `${toolCallId} 的工具结果没有回到模型请求里` },
  );
  return result as unknown as UpstreamToolResultSnapshot;
}

async function waitForTurnIdle(timeoutMsg: string) {
  await waitForV4Pane((pane) => !pane.canStop, timeoutMsg, 60000);
}

// 「不弹确认窗」是一段时间里的否定：发送前装上观察器，数权限弹窗从无到有出现了几次，
// 不靠固定等待去抽样。Write / Edit / 编不过的提交若弹过窗，到真正的工作流确认窗时计数就不止 1。
async function watchPermissionDialogs() {
  await browser.execute(() => {
    const probe = window as Window & {
      __dweDialogs?: number;
      __dweObserver?: MutationObserver;
    };
    probe.__dweObserver?.disconnect();
    probe.__dweDialogs = 0;
    const seen = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some((element) => {
        const label = (element.getAttribute("aria-label") ?? "").trim();
        return label === "Permission required" || label === "需要权限";
      });
    let present = seen();
    const observer = new MutationObserver(() => {
      const now = seen();
      if (now && !present) probe.__dweDialogs = (probe.__dweDialogs ?? 0) + 1;
      present = now;
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    probe.__dweObserver = observer;
  });
}

function permissionDialogCount(): Promise<number> {
  return browser.execute(() => (window as Window & { __dweDialogs?: number }).__dweDialogs ?? 0);
}

// 已结束一轮的工具行收在「已处理」折叠里（默认收起），还在跑的一轮则直接画在时间线上。
// 行不在 DOM 里就展开所有收起的折叠，直到它出现。
async function revealToolRow(toolCallId: string) {
  const row = $(triggerOf(toolCallId));
  await browser.waitUntil(
    async () => {
      if (await isOutsideClosedHistory(triggerOf(toolCallId))) return true;
      await openClosedHistoryFolds();
      return false;
    },
    { timeout: 30000, timeoutMsg: `工具行没有出现：${toolCallId}` },
  );
  await browser.execute((selector: string) => {
    document.querySelector(selector)?.scrollIntoView({ block: "center" });
  }, triggerOf(toolCallId));
  return row;
}

/** 行上各槽位：折叠动画期间 getText 可能为空，一律读 textContent。 */
function readDraftRow(toolCallId: string): Promise<DraftRowState | null> {
  return browser.execute((selector: string) => {
    const trigger = document.querySelector<HTMLElement>(selector);
    if (!trigger) return null;
    const read = (testId: string) =>
      trigger.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent?.trim() ?? null;
    return {
      text: (trigger.textContent ?? "").replace(/\s+/g, " ").trim(),
      ordinal: read("workflow-draft-ordinal"),
      // 修复原因：状态槽已改为「待修正」「未运行」两个 span 以 gap-2 分隔（不再有中点），
      // textContent 会把两段直接拼接；按子节点读取并以空格连接，对应用户看到的两段文字。
      status: (() => {
        const status = trigger.querySelector<HTMLElement>('[data-testid="workflow-draft-status"]');
        if (!status) return null;
        return Array.from(status.children)
          .map((child) => child.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
      })(),
      lamp:
        trigger
          .querySelector<HTMLElement>('[data-testid="workflow-draft-lamp"]')
          ?.getAttribute("data-draft-lamp") ?? null,
    };
  }, triggerOf(toolCallId));
}

async function waitForDraftRow(
  toolCallId: string,
  accept: (row: DraftRowState) => boolean,
  timeoutMsg: string,
): Promise<DraftRowState> {
  await revealToolRow(toolCallId);
  let last: DraftRowState | null = null;
  await browser
    .waitUntil(
      async () => {
        last = await readDraftRow(toolCallId);
        return last !== null && accept(last);
      },
      { timeout: 30000 },
    )
    .catch((error: unknown) => {
      throw new Error(`${timeoutMsg}；最后读到 ${JSON.stringify(last)}`, { cause: error });
    });
  return last as unknown as DraftRowState;
}

/** 展开反馈行，读它下面的编译反馈卡。 */
async function openFeedbackCard(toolCallId: string): Promise<FeedbackCardState> {
  await revealToolRow(toolCallId);
  const readCard = () =>
    browser.execute((selector: string) => {
      const trigger = document.querySelector<HTMLElement>(selector);
      const root = trigger?.parentElement;
      const card = root?.querySelector<HTMLElement>('[data-testid="workflow-compiler-feedback"]');
      if (!trigger || !root || !card) return null;
      const read = (testId: string) =>
        card.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent?.trim() ?? "";
      return {
        title: read("workflow-compiler-feedback-title"),
        count: read("workflow-compiler-feedback-count"),
        lede: read("workflow-compiler-feedback-lede"),
        lines: Array.from(
          card.querySelectorAll<HTMLElement>('[data-testid="workflow-compiler-feedback-line"]'),
        )
          // 坐标、正文、码是三个相邻元素，textContent 会把它们粘在一起：逐个读再用空格连。
          .map((line) =>
            Array.from(line.children)
              .map((part) => (part.textContent ?? "").replace(/\s+/g, " ").trim())
              .join(" "),
          ),
        hasScript: Boolean(root.querySelector('[data-testid="workflow-script-codeblock"]')),
      };
    }, triggerOf(toolCallId));
  let card: FeedbackCardState | null = null;
  await browser.waitUntil(
    async () => {
      card = await readCard();
      if (card) return true;
      await browser.execute((selector: string) => {
        // 修复原因：轮次结束后助手历史默认收起，展开状态还会随分组 key 变化重置回默认；
        // 只在 revealToolRow 展开一次时，读卡期间分组可能再次收起（实测 open=false、工具行不在 DOM）。
        // 每轮按用户操作补开已收起的历史，再展开反馈行。
        for (const history of document.querySelectorAll<HTMLElement>(
          '[data-testid^="chat-assistant-history-trigger-"][data-history-open="false"]',
        )) {
          history.click();
        }
        const trigger = document.querySelector<HTMLElement>(selector);
        if (trigger?.getAttribute("aria-expanded") !== "true") trigger?.click();
      }, triggerOf(toolCallId));
      return false;
    },
    { timeout: 30000, timeoutMsg: `${toolCallId} 展开后没有编译反馈卡` },
  );
  return card as unknown as FeedbackCardState;
}

/** 模型面的诊断行：`{path}:L{line}:C{column} {message}`。 */
function modelDiagnosticLines(content: string, path: string): string[] {
  return content.split("\n").filter((line) => line.startsWith(`${path}:L`));
}

describe("动态工作流 · 编译反馈、技能门与草稿文件", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWE-01 内联脚本编不过：不弹窗，行显示编译反馈，诊断按草稿文件行交回模型；下一轮直接改草稿再按 path 重提，确认窗出现", async function () {
    this.timeout(300000);
    expect((await readDynamicWorkflowGrayMockStatus()).scenario).toBe("alwaysOn");

    await startNewV4Draft();
    await watchPermissionDialogs();
    await sendV4Prompt("E2E_DWE_INLINE 用工作流检查一下仓库");

    // 模型的下一次请求带着诊断：草稿已落盘，诊断行点名草稿文件，NOTE 让它改文件、按 path 重提。
    const result = await waitForToolResult("toolu_dwe_inline_create");
    const diagnostics = modelDiagnosticLines(result.content, INLINE_DRAFT);
    expect(result.content).toContain("The workflow script has errors:");
    // 三个 agent 同名：分析器在后两处各报一条 9005（TypeScript 有错时分析器规则不跑，所以脚本只犯这一类错）。
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatch(
      /:L3:C\d+ two actors are named "E2E_DWE_REVIEWER" \(the first is on line 2\)/,
    );
    expect(diagnostics[1]).toMatch(
      /:L4:C\d+ two actors are named "E2E_DWE_REVIEWER" \(the first is on line 2\)/,
    );
    expect(result.content).toContain(
      `NOTE: The workflow was NOT executed. The script is saved at ${INLINE_DRAFT}. Edit that file in place and resubmit with \`path: "${INLINE_DRAFT}"\``,
    );
    await waitForV4AssistantMessageContaining("E2E_DWE_INLINE_DONE", 60000);
    await waitForTurnIdle("编译反馈之后 turn 没有收口");

    // 编不过的脚本在任何模式下都不弹窗，也不起 run。
    expect(await permissionDialogCount()).toBe(0);
    expect(await $(RUN_DIGEST).isExisting()).toBe(false);

    // 行：种类词「工作流草稿」、第 1 稿、「n 处待修正 未运行」，最新一稿的灯是警示色（open）。
    const count = diagnostics.length;
    const row = await waitForDraftRow(
      "toolu_dwe_inline_create",
      (state) => state.status !== null,
      "编译反馈行没有画出状态词",
    );
    expect(row.text).toContain("工作流草稿");
    expect(row.text).toContain("E2E_DWE_INLINE");
    expect(row.ordinal).toBe("第 1 稿");
    expect(row.status).toBe(`${count} 处待修正 未运行`);
    expect(row.lamp).toBe("open");

    // 展开：脚本 + 编译反馈卡（标题、条数、那句话、逐条诊断；分析器自有码写「规则 n」而不是 TSn）。
    const card = await openFeedbackCard("toolu_dwe_inline_create");
    expect(card.hasScript).toBe(true);
    expect(card.title).toBe("编译反馈");
    expect(card.count).toBe(`${count} 条`);
    expect(card.lede).toBe(FEEDBACK_LEDE);
    expect(card.lines).toHaveLength(count);
    expect(card.lines[0]).toMatch(/^L3:C\d+ two actors are named "E2E_DWE_REVIEWER".*规则 9005$/);
    expect(card.lines[1]).toMatch(/^L4:C\d+ two actors are named "E2E_DWE_REVIEWER".*规则 9005$/);

    // 下一轮：模型直接 Edit 内联草稿（没有 Read），按 path 重提；第一个出现的窗就是工作流确认窗。
    await sendV4Prompt("E2E_DWE_INLINE_FIX 按反馈修改草稿后重新提交");
    await waitForWorkflowWindow("E2E_DWE_INLINE_FIXED");
    expect(await permissionDialogCount()).toBe(1);
    // 内联草稿记作模型写过的文件：Edit 不要求先 Read。
    const edit = await waitForToolResult("toolu_dwe_inline_edit");
    expect(edit.isError).toBe(false);
    expect(edit.content).toContain("E2E_DWE_INLINE.dwf.ts");

    // 同一 lineage 有了更新的一行，旧反馈行的灯褪成中性（settled），别的不变。
    const superseded = await waitForDraftRow(
      "toolu_dwe_inline_create",
      (state) => state.lamp === "settled",
      "有了更新的一稿后旧反馈行的灯没有褪色",
    );
    expect(superseded.ordinal).toBe("第 1 稿");
    expect(superseded.status).toBe(`${count} 处待修正 未运行`);

    await rejectWorkflowWindow();
    expect((await waitForToolResult("toolu_dwe_inline_resubmit")).isError).toBe(true);
    await waitForV4AssistantMessageContaining("E2E_DWE_INLINE_FIX_DONE", 60000);
    await waitForTurnIdle("重提的确认窗被拒绝后 turn 没有收口");
    expect(await $(RUN_DIGEST).isExisting()).toBe(false);
  });

  it("DWE-02 技能门：没加载 dynamic-workflows 技能时 CreateWorkflow 被拒（工具错误点名技能），不弹窗；加载技能后同样的调用打开确认窗", async function () {
    this.timeout(240000);
    await startNewV4Draft();
    await watchPermissionDialogs();
    await sendV4Prompt("E2E_DWE_GATE 用工作流检查一下仓库");

    const refused = await waitForToolResult("toolu_dwe_gate_create_1");
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain(
      "CreateWorkflow needs the `dynamic-workflows` skill loaded in this session before it accepts a script.",
    );
    expect(refused.content).toContain('Call the Skill tool with skill "dynamic-workflows" first');
    expect(refused.content).toContain("then call CreateWorkflow again. Nothing was started.");

    // 模型加载技能后重提：第一个、也是唯一一个出现的窗画的是第二次调用。
    await waitForWorkflowWindow("E2E_DWE_GATE_RUN_2");
    expect(await permissionDialogCount()).toBe(1);
    expect(
      await browser.execute(
        (selector: string) => document.querySelector<HTMLElement>(selector)?.innerText ?? "",
        WORKFLOW_BLOCK,
      ),
    ).not.toContain("E2E_DWE_GATE_RUN_1");
    expect((await waitForToolResult("toolu_dwe_gate_skill")).isError).toBe(false);

    // 被门拒绝的行没有 display：不编号、不画编译反馈。
    const gated = await waitForDraftRow(
      "toolu_dwe_gate_create_1",
      () => true,
      "被技能门拒绝的行没有画出",
    );
    expect(gated.ordinal).toBeNull();
    expect(gated.status).toBeNull();

    await rejectWorkflowWindow();
    expect((await waitForToolResult("toolu_dwe_gate_create_2")).isError).toBe(true);
    await waitForV4AssistantMessageContaining("E2E_DWE_GATE_DONE", 60000);
    await waitForTurnIdle("技能门之后的确认窗被拒绝后 turn 没有收口");
    expect(await $(RUN_DIGEST).isExisting()).toBe(false);
  });

  it("DWE-03 path 草稿：模型在草稿目录写脚本文件、按 path 提交，诊断按文件行（含元数据块）交回、卡上按正文行；改草稿免确认，重提后确认窗出现", async function () {
    this.timeout(240000);
    await startNewV4Draft();
    await watchPermissionDialogs();
    await sendV4Prompt("E2E_DWE_PATH 用工作流检查一下仓库");

    // Write → CreateWorkflow(path) 编不过 → Edit → CreateWorkflow(path)：一路只有最后的工作流确认窗。
    await waitForWorkflowWindow("E2E_DWE_PATH_RUN");
    expect(await permissionDialogCount()).toBe(1);

    expect((await waitForToolResult("toolu_dwe_path_write")).isError).toBe(false);
    // 文件前 3 行是元数据块：正文第 2 行的错误，模型读到的是文件第 5 行，能直接粘进 Edit。
    const failed = await waitForToolResult("toolu_dwe_path_create_1");
    const diagnostics = modelDiagnosticLines(failed.content, PATH_DRAFT);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(
      `${PATH_DRAFT}:L5:C7 Type 'string' is not assignable to type 'number'`,
    );
    expect(failed.content).toContain(
      `NOTE: The workflow was NOT executed. The script file is ${PATH_DRAFT}. Edit that file in place and resubmit with \`path: "${PATH_DRAFT}"\``,
    );
    expect((await waitForToolResult("toolu_dwe_path_edit")).isError).toBe(false);

    // 反馈行：第 1 稿、1 处待修正；已有更新的一稿，灯已褪色。卡上的坐标按正文行（L2）。
    const feedbackRow = await waitForDraftRow(
      "toolu_dwe_path_create_1",
      (state) => state.status !== null && state.lamp === "settled",
      "path 提交的反馈行没有画成被取代的第 1 稿",
    );
    expect(feedbackRow.ordinal).toBe("第 1 稿");
    expect(feedbackRow.status).toBe("1 处待修正 未运行");
    const card = await openFeedbackCard("toolu_dwe_path_create_1");
    expect(card.count).toBe("1 条");
    expect(card.lines).toHaveLength(1);
    expect(card.lines[0]?.startsWith("L2:C7")).toBe(true);
    expect(card.lines[0]?.endsWith("TS2322")).toBe(true);

    // 待确认的重提行：同一 turn 同一 lineage 的第 2 稿，在途时细节位写「第 2 稿」。
    const pending = await waitForDraftRow(
      "toolu_dwe_path_create_2",
      (state) => state.ordinal !== null,
      "待确认的重提行没有写稿号",
    );
    expect(pending.ordinal).toBe("第 2 稿");
    expect(pending.text).toContain("工作流待确认");
    expect(pending.status).toBeNull();

    await rejectWorkflowWindow();
    expect((await waitForToolResult("toolu_dwe_path_create_2")).isError).toBe(true);
    await waitForV4AssistantMessageContaining("E2E_DWE_PATH_DONE", 60000);
    await waitForTurnIdle("path 重提的确认窗被拒绝后 turn 没有收口");
    expect(await $(RUN_DIGEST).isExisting()).toBe(false);
  });
});
