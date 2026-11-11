import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { readDynamicWorkflowGrayMockStatus } from "#e2e/helpers/dynamic-workflow-gray";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  approveV4Permission,
  getV4ConfigProjection,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialogInComposerDock,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  type UpstreamToolResultSnapshot,
} from "#e2e/helpers/conversation-session-network";
import { withoutTotalTokensReminderText } from "#e2e/helpers/total-tokens-evidence";
import {
  isOutsideClosedHistory,
  openClosedHistoryFolds,
  revealOutsideClosedHistory,
} from "#e2e/helpers/v4-history-folds";

// EvalWorkflowSnippet：工作流创作的试验台（docs/dynamic-workflow/authoring.md「EvalWorkflowSnippet」
// 「The skill gate」；编译反馈卡见 docs/dynamic-workflow/presentation.md「Compiler feedback」）。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只固定模型的 Skill / EvalWorkflowSnippet 选择与收尾文本；真实 Skill 加载、技能门、
// 片段编译、沙箱执行、world 读写、确认门与工具结果都走产品链路。片段完全瞬态，不起 run。
// 每个 it 开一个新会话：技能是否加载按会话历史判定。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const OK_SNIPPET = "dwy-ok-snippet.ts";
const BAD_SNIPPET = "dwy-bad-snippet.ts";
const GATE_OUTPUT = "dwy-gate-output.txt";
const RUNNING_GATE = "dwy-gate-running";
const NOT_EXECUTED_NOTE =
  "NOTE: The snippet was NOT executed — fix the errors above and call the tool again.";

const triggerOf = (toolCallId: string) => `[data-testid="tool-summary-trigger-${toolCallId}"]`;

interface SnippetCardState {
  /** 摘要行文字（折叠动画期间 getText 可能为空，读 textContent）。 */
  row: string;
  /** 摘要行有没有展开入口：不可展开的行没有 aria-expanded。 */
  expanded: string | null;
  hasBody: boolean;
  bodyText: string;
  headings: string[];
  result: string | null;
  resultLanguage: string | null;
  runningCode: string | null;
  logs: string | null;
  hasCodeFold: boolean;
  codeText: string | null;
  feedbackCount: string | null;
  feedbackLede: string | null;
  feedbackLines: string[];
}

function readSnippetCard(toolCallId: string): Promise<SnippetCardState | null> {
  return browser.execute((selector: string) => {
    const trigger = document.querySelector<HTMLElement>(selector);
    if (!trigger) return null;
    const root = trigger.parentElement;
    const body = root?.querySelector<HTMLElement>('[data-testid="workflow-snippet-body"]') ?? null;
    // 代码块由 @pierre/diffs 画在 shadow DOM 里，textContent 读不到：连 shadow root 一起走，跳过样式节点。
    const collect = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (node.nodeName === "STYLE" || node.nodeName === "SCRIPT") return "";
      const shadow = node instanceof Element ? (node.shadowRoot?.childNodes ?? []) : [];
      return [...Array.from(shadow), ...Array.from(node.childNodes)].map(collect).join("");
    };
    const text = (element: Element | null | undefined) =>
      element ? collect(element).replace(/\s+/g, " ").trim() : null;
    const within = (testId: string) => body?.querySelector(`[data-testid="${testId}"]`) ?? null;
    const feedback = within("workflow-compiler-feedback");
    const result = within("snippet-result");
    return {
      row: text(trigger) ?? "",
      expanded: trigger.getAttribute("aria-expanded"),
      hasBody: body !== null,
      bodyText: text(body) ?? "",
      headings: Array.from(body?.querySelectorAll("h4, summary") ?? []).map(
        (element) => text(element) ?? "",
      ),
      result: text(result),
      resultLanguage:
        result?.querySelector("[data-language]")?.getAttribute("data-language") ?? null,
      runningCode: text(within("snippet-running-code")),
      logs: text(within("snippet-logs")?.querySelector("pre")),
      hasCodeFold: within("snippet-code") !== null,
      codeText: text(within("snippet-code")),
      feedbackCount: text(
        feedback?.querySelector('[data-testid="workflow-compiler-feedback-count"]'),
      ),
      feedbackLede: text(
        feedback?.querySelector('[data-testid="workflow-compiler-feedback-lede"]'),
      ),
      feedbackLines: Array.from(
        feedback?.querySelectorAll('[data-testid="workflow-compiler-feedback-line"]') ?? [],
      )
        // 坐标、正文、码是三个相邻元素：逐个读再用空格连。
        .map((line) =>
          Array.from(line.children)
            .map((part) => text(part) ?? "")
            .join(" "),
        ),
    };
  }, triggerOf(toolCallId));
}

// 已结束一轮的工具行收在「已处理」折叠里（默认收起），行不在展开处就展开所有收起的折叠直到它出现。
async function revealToolRow(toolCallId: string) {
  await revealOutsideClosedHistory(triggerOf(toolCallId), `工具行没有出现：${toolCallId}`);
  await browser.execute((selector: string) => {
    document.querySelector(selector)?.scrollIntoView({ block: "center" });
  }, triggerOf(toolCallId));
}

/** 展开片段卡并等到满足条件的内容（终态切换时卡片会换 key 重挂，不能只点一次）。 */
async function openSnippetCard(
  toolCallId: string,
  accept: (card: SnippetCardState) => boolean,
  timeoutMsg: string,
): Promise<SnippetCardState> {
  await revealToolRow(toolCallId);
  let last: SnippetCardState | null = null;
  await browser
    .waitUntil(
      async () => {
        // 轮次结束时折叠原地收起（见 helpers/v4-history-folds.ts）：收起中的卡不算，补开折叠再读。
        if (!(await isOutsideClosedHistory(triggerOf(toolCallId)))) await openClosedHistoryFolds();
        last = await readSnippetCard(toolCallId);
        if (last?.hasBody && accept(last)) return true;
        await browser.execute((selector: string) => {
          const trigger = document.querySelector<HTMLElement>(selector);
          if (trigger?.getAttribute("aria-expanded") === "false") trigger.click();
        }, triggerOf(toolCallId));
        return false;
      },
      { timeout: 30000 },
    )
    .catch((error: unknown) => {
      throw new Error(`${timeoutMsg}；最后读到 ${JSON.stringify(last)}`, { cause: error });
    });
  return last as unknown as SnippetCardState;
}

async function waitForToolResult(toolCallId: string): Promise<UpstreamToolResultSnapshot> {
  let result: UpstreamToolResultSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      result = await getLatestUpstreamToolResultByToolCallId(toolCallId);
      return result !== null;
    },
    { timeout: 90000, timeoutMsg: `${toolCallId} 的工具结果没有回到模型请求里` },
  );
  // 修复原因：工具批次后的 token 预算提醒（bef446ae1f）以 `\n\n` 段并进 tool_result，
  // 排在片段结果之后，锚定结尾的匹配与返回值的 JSON 解析都会读到它。片段的模型面只看去掉提醒后的文字。
  const snapshot = result as unknown as UpstreamToolResultSnapshot;
  return { ...snapshot, content: withoutTotalTokensReminderText(snapshot.content) };
}

/** 模型面的返回值段：序列化方式与完成通知相同（带缩进），按值比较。 */
function returnValueOf(content: string): unknown {
  const start = content.indexOf("Return value:\n") + "Return value:\n".length;
  const end = content.indexOf("\n\nLogs:\n");
  return JSON.parse(end === -1 ? content.slice(start) : content.slice(start, end));
}

async function waitForTurnIdle(timeoutMsg: string) {
  await waitForV4Pane((pane) => !pane.canStop, timeoutMsg, 60000);
}

async function startSession(mode: "build" | "yolo") {
  await startNewV4Draft();
  await switchV4Mode(mode);
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === mode, {
    timeout: 30000,
    timeoutMsg: `composer 没有切到 mode=${mode}`,
  });
  await watchPermissionDialogs();
}

// 「不弹窗」是一段时间里的否定：发送前装上观察器，数权限弹窗从无到有出现了几次，不靠固定等待去抽样。
async function watchPermissionDialogs() {
  await browser.execute(() => {
    const probe = window as Window & {
      __dwyDialogs?: number;
      __dwyObserver?: MutationObserver;
    };
    probe.__dwyObserver?.disconnect();
    probe.__dwyDialogs = 0;
    const seen = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some((element) => {
        const label = (element.getAttribute("aria-label") ?? "").trim();
        return label === "Permission required" || label === "需要权限";
      });
    let present = seen();
    const observer = new MutationObserver(() => {
      const now = seen();
      if (now && !present) probe.__dwyDialogs = (probe.__dwyDialogs ?? 0) + 1;
      present = now;
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    probe.__dwyObserver = observer;
  });
}

function permissionDialogCount(): Promise<number> {
  return browser.execute(() => (window as Window & { __dwyDialogs?: number }).__dwyDialogs ?? 0);
}

async function writeRuntimeFile(name: string, content: string) {
  const path = resolveE2ERuntimePath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("动态工作流 · EvalWorkflowSnippet", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
    await Promise.all(
      [GATE_OUTPUT, RUNNING_GATE].map((name) => rm(resolveE2ERuntimePath(name), { force: true })),
    );
    await writeRuntimeFile(OK_SNIPPET, 'log("E2E_DWY_PATH_LOG");\nreturn "E2E_DWY_PATH_VALUE";\n');
    await writeRuntimeFile(
      BAD_SNIPPET,
      '// 第 1 行是注释\nconst broken: number = "x";\nreturn broken;\n',
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWY-01 只读片段：不弹窗不起 run；模型拿到返回值与日志；卡片只画「工作流片段 · N ms」和返回值，没有返回值的片段行不可展开", async function () {
    this.timeout(240000);
    expect((await readDynamicWorkflowGrayMockStatus()).scenario).toBe("alwaysOn");

    await startSession("build");
    await sendV4Prompt("E2E_DWY_VALUE_START 先试一段片段。");
    await waitForV4AssistantMessageContaining("E2E_DWY_VALUE_DONE", 120000);
    await waitForTurnIdle("片段那一轮没有结束");

    const value = await waitForToolResult("toolu_dwy_value_eval");
    expect(value.isError).toBe(false);
    expect(value.content).toMatch(/^The snippet completed in \d+ms\.\nReturn value:\n/);
    expect(returnValueOf(value.content)).toEqual({
      marker: "E2E_DWY_VALUE",
      sum: 3,
    });
    expect(value.content).toContain("\n\nLogs:\n- E2E_DWY_LOG_FIRST\n- E2E_DWY_LOG_SECOND");

    const empty = await waitForToolResult("toolu_dwy_value_empty");
    expect(empty.isError).toBe(false);
    expect(empty.content).toMatch(
      /^The snippet completed in \d+ms\.\nIt returned no value\.\n\nLogs:\n- E2E_DWY_LOG_ONLY$/,
    );

    // 只读片段静默放行；片段不进 run 列表。
    expect(await permissionDialogCount()).toBe(0);
    expect(await $(RUN_DIGEST).isExisting()).toBe(false);

    // 完成：只显示返回值（JSON 美化），无标题、日志与代码折叠，不重复耗时、PASS 与给模型的那段话。
    const card = await openSnippetCard(
      "toolu_dwy_value_eval",
      (state) => state.result?.includes("E2E_DWY_VALUE") === true,
      "片段卡没有画出返回值",
    );
    expect(card.row).toMatch(/工作流片段.*\d+ms/);
    expect(card.row).not.toContain("执行失败");
    expect(card.resultLanguage).toBe("json");
    expect(card.headings).toEqual([]);
    expect(card.logs).toBeNull();
    expect(card.hasCodeFold).toBe(false);
    expect(card.feedbackCount).toBeNull();
    expect(card.bodyText).not.toMatch(/E2E_DWY_LOG_|completed in|Return value:|\d+ms|PASS|通过/);

    // 没有返回值：行上只有耗时，没有展开入口，不留空面板；日志只给模型。
    await revealToolRow("toolu_dwy_value_empty");
    const emptyCard = await readSnippetCard("toolu_dwy_value_empty");
    expect(emptyCard?.row).toMatch(/工作流片段.*\d+ms/);
    expect(emptyCard?.expanded).toBeNull();
    expect(emptyCard?.hasBody).toBe(false);
  });

  it("DWY-02 失败：抛错带日志、编不过（facade 没有 agent）、返回值超限、读工作区外、墙钟超时都以结构化形式回到模型；卡片走通用失败摘要或编译反馈卡", async function () {
    this.timeout(240000);
    await startSession("build");
    await sendV4Prompt("E2E_DWY_FAIL_START 试几段会失败的片段。");
    await waitForV4AssistantMessageContaining("E2E_DWY_FAIL_DONE", 120000);
    await waitForTurnIdle("失败片段那一轮没有结束");

    const thrown = await waitForToolResult("toolu_dwy_fail_throw");
    expect(thrown.content).toMatch(/^The snippet failed \(\w+\): .*E2E_DWY_BOOM/);
    expect(thrown.content).toContain("\n\nLogs:\n- E2E_DWY_BEFORE_THROW");

    const compile = await waitForToolResult("toolu_dwy_fail_compile");
    expect(compile.content).toMatch(/^The snippet has errors:\nL2:C\d+ Cannot find name 'agent'\./);
    expect(compile.content).toContain(NOT_EXECUTED_NOTE);
    // 编不过就什么都没跑：第一行的 log 没有留下。
    expect(compile.content).not.toContain("E2E_DWY_NEVER_LOGGED");

    const large = await waitForToolResult("toolu_dwy_fail_large");
    expect(large.content).toMatch(/^The snippet failed \(ArtifactTooLarge\): /);
    expect(large.content).toContain("Return a summary");

    // 与真实 run 同一条 world 读：工作区外的路径被拒。
    const outside = await waitForToolResult("toolu_dwy_fail_outside");
    expect(outside.content).toMatch(/^The snippet failed \(\w+\): .*is outside the workspace/);

    const timedOut = await waitForToolResult("toolu_dwy_fail_timeout");
    expect(timedOut.content).toMatch(/^The snippet failed \(\w+\): .*1000ms/);

    expect(await permissionDialogCount()).toBe(0);
    expect(await $(RUN_DIGEST).isExisting()).toBe(false);

    // 抛错：通用失败摘要（不写耗时），展开依次是错误、日志、代码折叠，错误信息只出现一次。
    const thrownCard = await openSnippetCard(
      "toolu_dwy_fail_throw",
      (state) => state.result?.includes("E2E_DWY_BOOM") === true,
      "抛错的片段卡没有展开出错误",
    );
    expect(thrownCard.row).toContain("执行失败");
    expect(thrownCard.row).not.toMatch(/\d+ms/);
    expect(thrownCard.logs).toBe("E2E_DWY_BEFORE_THROW");
    expect(thrownCard.hasCodeFold).toBe(true);
    expect(thrownCard.codeText).toContain("代码");
    // 日志只在日志段：错误段里解包掉了给模型的 Logs 尾巴。
    expect(thrownCard.result).not.toContain("E2E_DWY_BEFORE_THROW");

    // 编不过：编译反馈卡（与 CreateWorkflow 同一张），诊断不再以错误文本重复一遍。
    const compileCard = await openSnippetCard(
      "toolu_dwy_fail_compile",
      (state) => state.feedbackCount !== null,
      "编不过的片段卡没有展开出编译反馈",
    );
    expect(compileCard.row).toContain("执行失败");
    expect(compileCard.feedbackCount).toBe("1 条");
    expect(compileCard.feedbackLede).toBe(
      "类型检查未通过，脚本未运行；反馈已交回模型，由它修改后重新提交。",
    );
    expect(compileCard.feedbackLines).toHaveLength(1);
    expect(compileCard.feedbackLines[0]).toMatch(/^L2:C\d+ Cannot find name 'agent'.*TS2304$/);
    expect(compileCard.result).toBeNull();
    expect(compileCard.logs).toBeNull();
    expect(compileCard.hasCodeFold).toBe(true);

    const largeCard = await openSnippetCard(
      "toolu_dwy_fail_large",
      (state) => state.result?.includes("ArtifactTooLarge") === true,
      "超限的片段卡没有展开出错误",
    );
    expect(largeCard.row).toContain("执行失败");

    const timeoutCard = await openSnippetCard(
      "toolu_dwy_fail_timeout",
      (state) => state.result?.includes("1000ms") === true,
      "超时的片段卡没有展开出错误",
    );
    expect(timeoutCard.row).toContain("执行失败");
  });

  it("DWY-03 技能门：没加载技能时片段被拒（工具错误点名技能），不弹窗、不执行；加载后同一片段带 world.run，确认门询问，批准后才执行", async function () {
    this.timeout(240000);
    await startSession("build");
    await sendV4Prompt("E2E_DWY_GATE_START 跑一段会写文件的片段。");

    const refused = await waitForToolResult("toolu_dwy_gate_eval_1");
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain(
      "EvalWorkflowSnippet needs the `dynamic-workflows` skill loaded in this session before it accepts a script.",
    );
    expect(refused.content).toContain('Call the Skill tool with skill "dynamic-workflows" first');
    expect(refused.content).toContain("then call EvalWorkflowSnippet again. Nothing was started.");

    // 模型加载技能后重发：第一个、也是唯一一个窗属于第二次调用；批准前片段没有执行。
    await waitForV4PermissionDialogInComposerDock(120000);
    expect((await waitForToolResult("toolu_dwy_gate_skill")).isError).toBe(false);
    expect(await permissionDialogCount()).toBe(1);
    await expect(readFile(resolveE2ERuntimePath(GATE_OUTPUT), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await approveV4Permission();
    const ran = await waitForToolResult("toolu_dwy_gate_eval_2");
    expect(ran.isError).toBe(false);
    expect(returnValueOf(ran.content)).toEqual({ marker: "E2E_DWY_GATE_VALUE", exitCode: 0 });
    expect(await readFile(resolveE2ERuntimePath(GATE_OUTPUT), "utf8")).toBe("ran\n");
    await waitForV4AssistantMessageContaining("E2E_DWY_GATE_DONE", 60000);
    await waitForTurnIdle("技能门那一轮没有结束");
    expect(await permissionDialogCount()).toBe(1);

    // 被门拒绝的行走通用失败摘要：展开是拒绝文本，没有日志与编译反馈。
    const refusedCard = await openSnippetCard(
      "toolu_dwy_gate_eval_1",
      (state) => state.result?.includes("dynamic-workflows") === true,
      "被技能门拒绝的行没有展开出错误",
    );
    expect(refusedCard.row).toContain("执行失败");
    expect(refusedCard.logs).toBeNull();
    expect(refusedCard.feedbackCount).toBeNull();

    const ranCard = await openSnippetCard(
      "toolu_dwy_gate_eval_2",
      (state) => state.result?.includes("E2E_DWY_GATE_VALUE") === true,
      "批准后的片段卡没有画出返回值",
    );
    expect(ranCard.row).toMatch(/工作流片段.*\d+ms/);
  });

  it("DWY-04 运行中：完全访问下带 world.run 的片段不询问；行写「正在运行工作流片段 · N s」，展开是代码；闸文件放行后变成「工作流片段 · N ms」和返回值", async function () {
    this.timeout(240000);
    await startSession("yolo");
    await sendV4Prompt("E2E_DWY_RUNNING_START 跑一段要等的片段。");

    const running = await openSnippetCard(
      "toolu_dwy_running_eval",
      (state) => state.runningCode?.includes("E2E_DWY_RUNNING_VALUE") === true,
      "运行中的片段卡展开后没有代码",
    );
    expect(running.row).toMatch(/正在运行工作流片段.*\d+s/);
    expect(running.row).not.toMatch(/\d+ms/);
    expect(running.result).toBeNull();
    expect(await getLatestUpstreamToolResultByToolCallId("toolu_dwy_running_eval")).toBeNull();

    await writeRuntimeFile(RUNNING_GATE, "open\n");
    const done = await waitForToolResult("toolu_dwy_running_eval");
    expect(done.isError).toBe(false);
    expect(returnValueOf(done.content)).toEqual({
      marker: "E2E_DWY_RUNNING_VALUE",
      out: "E2E_DWY_RUNNING_STDOUT",
      // 片段的 world.run 与 files.* 落在同一个工作区：命令写下的文件，glob 给相对路径，read 读得到。
      found: ["dwy-running.txt"],
      written: "E2E_DWY_WRITTEN",
    });
    await waitForV4AssistantMessageContaining("E2E_DWY_RUNNING_DONE", 60000);
    await waitForTurnIdle("运行中片段那一轮没有结束");
    expect(await permissionDialogCount()).toBe(0);

    const card = await openSnippetCard(
      "toolu_dwy_running_eval",
      (state) => state.result?.includes("E2E_DWY_RUNNING_STDOUT") === true,
      "片段完成后卡片没有换成返回值",
    );
    expect(card.row).toMatch(/工作流片段.*\d+ms/);
    expect(card.row).not.toContain("正在运行");
    expect(card.runningCode).toBeNull();
  });

  it("DWY-05 来源：path 读文件当片段跑，诊断按文件行且点名文件；文件读不了、code 与 path 都给、都不给各有自己的拒绝", async function () {
    this.timeout(240000);
    await startSession("build");
    await sendV4Prompt("E2E_DWY_PATH_START 按文件跑片段。");
    await waitForV4AssistantMessageContaining("E2E_DWY_PATH_DONE", 120000);
    await waitForTurnIdle("path 片段那一轮没有结束");

    const ok = await waitForToolResult("toolu_dwy_path_ok");
    expect(ok.isError).toBe(false);
    expect(ok.content).toContain("Return value:\n");
    expect(ok.content).toContain("E2E_DWY_PATH_VALUE");
    expect(ok.content).toContain("Logs:\n- E2E_DWY_PATH_LOG");

    const bad = await waitForToolResult("toolu_dwy_path_bad");
    expect(bad.content).toContain("The snippet has errors:");
    expect(bad.content).toMatch(
      new RegExp(`${BAD_SNIPPET.replace(".", "\\.")}:L2:C7 Type 'string' is not assignable`),
    );
    expect(bad.content).toContain(NOT_EXECUTED_NOTE);

    const missing = await waitForToolResult("toolu_dwy_path_missing");
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("dwy-absent.ts");
    expect(missing.content).toContain("could not be read");

    const both = await waitForToolResult("toolu_dwy_path_both");
    expect(both.isError).toBe(true);
    expect(both.content).toContain(
      "Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both is ambiguous.",
    );

    const neither = await waitForToolResult("toolu_dwy_path_neither");
    expect(neither.isError).toBe(true);
    expect(neither.content).toContain(
      "No snippet source arrived. Pass `code` for the snippet inline, or `path` for a file holding it.",
    );

    expect(await permissionDialogCount()).toBe(0);

    // path 编不过：与内联同一张编译反馈卡，坐标是文件行。
    const badCard = await openSnippetCard(
      "toolu_dwy_path_bad",
      (state) => state.feedbackCount !== null,
      "path 编不过的片段卡没有展开出编译反馈",
    );
    expect(badCard.feedbackLines[0]).toMatch(/^L2:C7 .*TS2322$/);
    // 诊断只归编译反馈卡：这里曾把给模型的全文连同本机绝对路径又画一遍。
    expect(badCard.bodyText).not.toContain("The snippet has errors");
    expect(badCard.bodyText).not.toContain(BAD_SNIPPET);
  });
});
