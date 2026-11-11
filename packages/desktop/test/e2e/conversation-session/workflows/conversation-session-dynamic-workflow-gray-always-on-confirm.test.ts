import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
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
  countUpstreamRequests,
  countUpstreamRequestsContaining,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  type UpstreamToolResultSnapshot,
} from "#e2e/helpers/conversation-session-network";

// CreateWorkflow 确认窗的选项（docs/dynamic-workflow/launch.md「The confirmation window」：The options、
// Adjusting the settings in the window、Refine、Always allow in this session；外观见
// docs/dynamic-workflow/presentation.md「The confirmation window」）。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只固定模型的 Skill / CreateWorkflow 选择与收尾文本；真实 Skill 加载、脚本编译、
// 确认窗、应答、会话授权、设置调整、run 启动与完成通知都走产品链路。脚本不调 agent()，
// 放行后的 run 不产生子代理请求。每个 it 开一个新会话：会话授权只活在它自己的会话里。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const WORKFLOW_BLOCK = '[data-workflow-permission-block="true"]';
const REFINE_INPUT = 'textarea[data-permission-feedback-option="workflowRefine"]';
const RUN_LINE = '[data-workflow-run-line="true"]';

type OptionKind = "allowOnce" | "allowAlways" | "rejectOnce";

interface WindowOption {
  kind: string | null;
  label: string | null;
  text: string;
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

function readWindowOptions(): Promise<WindowOption[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-v4-composer-dock="true"] [role="listbox"] button[role="option"]',
      ),
    ).map((button) => ({
      kind: button.getAttribute("data-permission-option-kind"),
      label: button.getAttribute("aria-label"),
      text: button.innerText.replace(/\s+/g, " ").trim(),
    })),
  );
}

/**
 * 点某一种选项：未选中时第一次点击只选中，再点才应答（PermissionDialog 的点击语义），
 * 所以点到窗关闭为止。
 */
async function answerWorkflowWindow(kind: OptionKind) {
  const clickOption = () =>
    browser.execute((optionKind: string) => {
      const option = document.querySelector<HTMLButtonElement>(
        `[data-v4-composer-dock="true"] [role="listbox"] button[role="option"][data-permission-option-kind="${optionKind}"]`,
      );
      option?.click();
      return Boolean(option);
    }, kind);
  expect(await clickOption()).toBe(true);
  await browser.waitUntil(
    async () => {
      if (!(await hasV4PermissionDialog())) return true;
      await clickOption();
      return false;
    },
    { timeout: 15000, timeoutMsg: `选了 ${kind} 后确认窗没有关闭` },
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

/** 放行的 run 跑完后，主代理读到它的 <task-notification> 并回完话，会话才回到空闲。 */
async function waitForRunNotificationConsumed(runName: string) {
  await browser.waitUntil(
    async () =>
      (await countUpstreamRequests({
        lastUserMessageIncludes: ["<task-notification>", runName],
      })) > 0,
    { timeout: 120000, timeoutMsg: `${runName} 的完成通知没有送到主代理` },
  );
  await waitForTurnIdle(`${runName} 的完成通知那一轮没有结束`);
}

describe("动态工作流 · CreateWorkflow 确认窗的选项", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWC-01 窗的形状与拒绝：三个选项加修改行；拒绝不带修改行草稿、不起 run，模型被告知未获批准，turn 收口", async function () {
    this.timeout(240000);
    expect((await readDynamicWorkflowGrayMockStatus()).scenario).toBe("alwaysOn");

    await startNewV4Draft();
    await sendV4Prompt("E2E_DWC_DENY 用工作流检查一下仓库");
    await waitForWorkflowWindow("E2E_DWC_DENY_RUN");

    // 表头问句；两项 run 设置（agent 回填了 adjustable_settings 时总画出来）。
    const block = await $(WORKFLOW_BLOCK);
    expect(await block.getText()).toContain("运行此工作流？");
    await expect(block.$('[data-testid="workflow-permission-settings-model"]')).toBeExisting();
    await expect(block.$('[data-testid="workflow-permission-settings-bound"]')).toBeExisting();

    // 选项：允许 / 本会话内始终允许 / 拒绝，第 4 项是 Refine 的修改行，不在按钮列表里。
    const options = await readWindowOptions();
    expect(options.map((option) => option.kind)).toEqual([
      "allowOnce",
      "allowAlways",
      "rejectOnce",
    ]);
    expect(options.map((option) => option.label)).toEqual(["允许", "本会话内始终允许", "拒绝"]);
    expect(options[0]?.text).toContain("仅允许这一次");
    expect(options[1]?.text).toContain("本会话内运行工作流不再询问");
    const refineInput = await $(REFINE_INPUT);
    await expect(refineInput).toBeDisplayed();
    expect(await refineInput.getAttribute("aria-label")).toBe("提出修改");
    expect(await refineInput.getAttribute("placeholder")).toBe("描述这个工作流应该怎么改…");

    // 修改行里留一段草稿再点拒绝：草稿属于 Refine，普通拒绝就是普通拒绝。
    const draft = "E2E_DWC_DENY_DRAFT 这段草稿不应发给模型";
    await refineInput.setValue(draft);
    await answerWorkflowWindow("rejectOnce");

    const result = await waitForToolResult("toolu_dwc_deny_create");
    expect(result.isError).toBe(true);
    // 普通拒绝走标准权限拒绝文案，不是 Refine 的「未获批准」+ 跟随的用户消息。
    expect(result.content).toContain("The tool use was rejected");
    expect(result.content).not.toContain("The workflow run was not approved by the user.");
    expect(result.content).not.toContain("E2E_DWC_DENY_DRAFT");
    await waitForV4AssistantMessageContaining("E2E_DWC_DENY_DONE", 60000);
    await waitForTurnIdle("拒绝后 turn 没有收口");
    expect(await countUpstreamRequestsContaining("E2E_DWC_DENY_DRAFT")).toBe(0);

    // 没有 run：卡与侧栏运行行都不出现。
    expect(await $(RUN_DIGEST).isExisting()).toBe(false);
    expect(await $(RUN_LINE).isExisting()).toBe(false);
  });

  it("DWC-02 Refine：修改意见作为真实用户消息排在工具结果之后发给模型，不起 run；模型重提后窗再次出现", async function () {
    this.timeout(240000);
    await startNewV4Draft();
    await sendV4Prompt("E2E_DWC_REFINE_START 用工作流检查一下仓库");
    await waitForWorkflowWindow("E2E_DWC_REFINE_RUN_1");

    const feedback = "E2E_DWC_REFINE_FEEDBACK 拆成两个阶段再跑";
    const refineInput = await $(REFINE_INPUT);
    await refineInput.click();
    await refineInput.setValue(feedback);
    // 修改行里回车即提交修改意见。
    await browser.keys("Enter");
    await browser.waitUntil(
      async () =>
        browser.execute(
          (selector: string, expected: string) =>
            !document.querySelector<HTMLElement>(selector)?.innerText.includes(expected),
          WORKFLOW_BLOCK,
          "E2E_DWC_REFINE_RUN_1",
        ),
      { timeout: 15000, timeoutMsg: "提交修改意见后第一个确认窗没有关闭" },
    );

    // 工具结果：运行未获批准；修改意见作为用户消息，排在 tool_result 之后。
    const result = await waitForToolResult("toolu_dwc_refine_create_1");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("The workflow run was not approved by the user.");
    expect(result.content).not.toContain("E2E_DWC_REFINE_FEEDBACK");
    const [revised] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_DWC_REFINE_FEEDBACK"],
    });
    expect(revised).toBeDefined();
    const body = JSON.stringify(revised!.requestJson);
    const toolResultAt = body.indexOf('"tool_use_id":"toolu_dwc_refine_create_1"');
    expect(toolResultAt).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("E2E_DWC_REFINE_FEEDBACK")).toBeGreaterThan(toolResultAt);

    // 模型修订重提：新窗画出修订后的名字；用数字键 3 直接拒绝。
    await waitForWorkflowWindow("E2E_DWC_REFINE_RUN_2");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.activeElement?.getAttribute("data-permission-option-kind") === "allowOnce",
        ),
      { timeout: 5000, timeoutMsg: "修订后的确认窗打开后焦点不在第一个选项上" },
    );
    await browser.keys("3");
    await browser.waitUntil(async () => !(await hasV4PermissionDialog()), {
      timeout: 15000,
      timeoutMsg: "数字键 3 没有直接拒绝",
    });
    expect((await waitForToolResult("toolu_dwc_refine_create_2")).isError).toBe(true);
    await waitForV4AssistantMessageContaining("E2E_DWC_REFINE_DONE", 60000);
    await waitForTurnIdle("修订窗被拒绝后 turn 没有收口");

    expect(await $(RUN_DIGEST).isExisting()).toBe(false);
    expect(await $(RUN_LINE).isExisting()).toBe(false);
  });

  it("DWC-03 本会话内始终允许：同一会话下一次 CreateWorkflow 不再弹窗直接起 run；新会话再次弹窗", async function () {
    this.timeout(360000);
    await startNewV4Draft();
    await sendV4Prompt("E2E_DWC_SESSION_FIRST 用工作流检查一下仓库");
    await waitForWorkflowWindow("E2E_DWC_SESSION_RUN_1");
    await answerWorkflowWindow("allowAlways");

    expect((await waitForToolResult("toolu_dwc_session_create_1")).isError).toBe(false);
    await $(RUN_DIGEST).waitForDisplayed({ timeout: 120000 });
    await waitForRunNotificationConsumed("E2E_DWC_SESSION_RUN_1");

    // 第二次调用之前装上观察器：只要确认窗出现过一次就记下来。
    await browser.execute(() => {
      const probe = window as Window & { __dwcPermissionSeen?: boolean };
      probe.__dwcPermissionSeen = false;
      const seen = () =>
        Array.from(document.querySelectorAll('[role="listbox"]')).some((element) =>
          ["Permission required", "需要权限"].includes(element.getAttribute("aria-label") ?? ""),
        );
      const observer = new MutationObserver(() => {
        if (seen()) {
          probe.__dwcPermissionSeen = true;
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await sendV4Prompt("E2E_DWC_SESSION_AGAIN 再用工作流检查一遍");
    expect((await waitForToolResult("toolu_dwc_session_create_2")).isError).toBe(false);
    await browser.waitUntil(async () => (await $$(RUN_DIGEST).length) >= 2, {
      timeout: 120000,
      timeoutMsg: "会话授权后的第二次 CreateWorkflow 没有起 run",
    });
    await waitForRunNotificationConsumed("E2E_DWC_SESSION_RUN_2");
    expect(
      await browser.execute(
        () => (window as Window & { __dwcPermissionSeen?: boolean }).__dwcPermissionSeen,
      ),
    ).toBe(false);

    // 授权只属于那个会话：新会话的 CreateWorkflow 照常弹窗。拒绝收尾。
    await startNewV4Draft();
    await sendV4Prompt("E2E_DWC_SESSION_NEW 换个会话再用工作流检查");
    await waitForWorkflowWindow("E2E_DWC_SESSION_RUN_NEW");
    await answerWorkflowWindow("rejectOnce");
    expect((await waitForToolResult("toolu_dwc_session_new_create")).isError).toBe(true);
    await waitForV4AssistantMessageContaining("E2E_DWC_SESSION_NEW_DONE", 60000);
  });

  it("DWC-04 在窗里调高并发上限：选项描述改说「按调整后的设置运行」，放行后 run 按新上限启动并告诉模型", async function () {
    this.timeout(240000);
    await startNewV4Draft();
    await sendV4Prompt("E2E_DWC_ADJUST 用工作流检查一下仓库");
    await waitForWorkflowWindow("E2E_DWC_ADJUST_RUN");

    // 调用没设 max_concurrency：步进器从默认并发起，尾巴写「= 默认」。
    const bound = await $('[data-testid="workflow-permission-settings-bound"]');
    const value = await bound.$('[data-testid="workflow-permission-settings-bound-value"]');
    const initial = Number.parseInt(await value.getValue(), 10);
    expect(Number.isFinite(initial)).toBe(true);
    expect(await bound.getAttribute("data-changed")).toBeNull();
    expect(
      await bound.$('[data-testid="workflow-permission-settings-bound-tail"]').getText(),
    ).toContain("= 默认");

    await bound.$('[data-testid="workflow-permission-settings-bound-increase"]').click();
    const adjusted = initial + 1;
    await browser.waitUntil(async () => (await value.getValue()) === String(adjusted), {
      timeout: 5000,
      timeoutMsg: "并发步进器没有加一",
    });
    expect(await bound.getAttribute("data-changed")).toBe("true");
    expect(
      await bound.$('[data-testid="workflow-permission-settings-bound-tail"]').getText(),
    ).toContain(`默认 ${initial}`);
    expect(
      await bound.$('[data-testid="workflow-permission-settings-bound-was"]').getText(),
    ).toContain(`原为 ${initial}`);

    // 改过设置后，前两个选项换描述。
    const options = await readWindowOptions();
    expect(options[0]?.text).toContain("按调整后的设置运行一次");
    expect(options[1]?.text).toContain(
      "本次按调整后的设置运行；之后的工作流不再询问，各用各的设置",
    );

    await answerWorkflowWindow("allowOnce");
    const result = await waitForToolResult("toolu_dwc_adjust_create");
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Before approving, the user adjusted the settings in the confirmation window:",
    );
    expect(result.content).toContain(
      `at most ${adjusted} subagents run at once (the default is ${initial})`,
    );
    // 模型没被告知换了模型：只说改了的那一半。
    expect(result.content).not.toContain("back on the session model");
    await $(RUN_DIGEST).waitForDisplayed({ timeout: 120000 });
    await waitForRunNotificationConsumed("E2E_DWC_ADJUST_RUN");
  });
});
