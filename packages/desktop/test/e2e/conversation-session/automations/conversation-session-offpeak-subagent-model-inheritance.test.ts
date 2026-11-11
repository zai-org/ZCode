import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TID_AUTOMATIONS_OPEN,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_FORM_INSTRUCTIONS,
  TID_OFFPEAK_FORM_TITLE,
  TID_OFFPEAK_TAB,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
  UPSTREAM_MODEL,
} from "#e2e/helpers/upstream-provider";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
  switchV4Mode,
} from "#e2e/helpers/v4-conversation";
import { sel } from "#e2e/helpers/selectors";

import { openFaultInjectedHostWindow, readHostBoundary } from "#e2e/helpers/subagent-host-window";

const OFFPEAK_PARENT_MARKER = "E2E_OFFPEAK_SUBAGENTS_PARENT";
const ORDINARY_PROMPT_MARKER = "E2E_OFFPEAK_SUBAGENTS_ORDINARY_PROMPT";
const ORDINARY_REPLY_TOKEN = "E2E_OFFPEAK_SUBAGENTS_ORDINARY_OK";
const EXPECTED_FOREGROUND_STAGES = [
  "child-explore",
  "child-general-purpose",
  "child-code-search",
  "child-custom-inherit",
] as const;
const EXPECTED_BACKGROUND_STAGES = ["background-explicit", "background-profile"] as const;

interface OffPeakMockRequestRecord {
  hasApiKey: boolean;
  hasAuthorization: boolean;
  hasCodingPlanApiKey: boolean;
  maxTokens?: number;
  model?: string;
  requestJson: unknown;
  stage: string;
  ticketId: string;
}

describe("闲时后台 subagent 模型继承与唤起 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OP10/IL01/IL02: foreground 与 background 继承闲时模型，主轮结束等待后台唤起，发送普通消息才切回用户模型", async function () {
    this.timeout(300000);

    const handoffFault = process.env.ZCODE_E2E_OFFPEAK_HANDOFF_FAULT === "1";
    if (handoffFault) {
      const { windowId } = await openFaultInjectedHostWindow(
        fileURLToPath(new URL("../../helpers/offpeak-host-faults.cjs", import.meta.url)),
      );
      // 只保留注入窗口，避免另一个 Host 先抢到闲时任务，使故障边界没有被执行。
      await browser.electron.execute((electron, retainedId) => {
        for (const window of electron.BrowserWindow.getAllWindows())
          if (window.id !== retainedId) window.close();
      }, windowId);
    }
    await prepareV4ConversationE2E();

    const takeover = process.env.ZCODE_E2E_OFFPEAK_TAKEOVER === "1";
    const title = `E2E_OFFPEAK_SUBAGENTS_${Date.now()}`;
    await createOffPeakTask({
      instructions: `${OFFPEAK_PARENT_MARKER}: verify the foreground subagent provider matrix.`,
      title,
    });

    let records = await waitForOffPeakScenarioCompletion();
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "闲时任务完成后无法重新打开 Automations",
    });
    await openOffPeakTab();
    await browser.waitUntil(
      async () => /Running|进行中|运行中/u.test((await readOffPeakCardText(title)) ?? ""),
      { timeout: 15000, timeoutMsg: "后台工作未结束时闲时卡应保持进行中" },
    );
    await openOffPeakTaskSession(title);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "后台屏障关闭时主轮应已自然结束",
      60000,
    );
    // 工具栏草稿选择用户模型但尚未发送，不得改变随后后台唤起使用的闲时 Selection。
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
    await recordComposerSelection("before-background-wakeup");
    if (takeover) {
      await sendV4Prompt(ORDINARY_PROMPT_MARKER);
      await waitForV4ComposerText("", "用户接管消息没有提交");
      await waitForV4AssistantMessageContaining(ORDINARY_REPLY_TOKEN);
    }
    // 主轮已结束但后台仍在等待。显式放行真实子请求，证明通知能另起续跑轮。
    const port = Number(process.env.ZCODE_OFFPEAK_MOCK_PORT ?? "45197");
    const expireOnWake = handoffFault || process.env.ZCODE_E2E_OFFPEAK_EXPIRE_WAKE === "1";
    const release = await fetch(`http://127.0.0.1:${port}/__e2e/off-peak/release-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expireOnWake }),
    });
    expect(release.ok).toBe(true);
    const bashNotification = "<tool-use-id>toolu_e2e_offpeak_bash</tool-use-id>";
    let userWakeBody: string | undefined;
    if (takeover) {
      const userWake = await waitForUpstreamNetworkCapture(bashNotification);
      assertUpstreamRequestCapture(userWake, {
        expectedText: bashNotification,
        model: UPSTREAM_MODEL,
      });
      userWakeBody = JSON.stringify(userWake.requestJson);
    } else {
      await browser.waitUntil(
        async () => {
          records = await readOffPeakMockRequests();
          return records.some((record) => record.stage === "parent-wakeup");
        },
        { timeout: 60000, timeoutMsg: "后台完成未唤起主 agent" },
      );
    }
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN);
    await openOffPeakTab();
    await waitForOffPeakCardCompleted(title);
    if (handoffFault) {
      const boundary = await readHostBoundary();
      const failed = boundary.filter((event) => event.kind === "ticket-ack-failed");
      const confirmed = boundary.filter((event) => event.kind === "ticket-ack-confirmed");
      expect(failed).toHaveLength(1);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.id).toBe(failed[0]!.id);
      expect(boundary.filter((event) => event.kind === "ticket-control")).toHaveLength(2);
    }

    records = await readOffPeakMockRequests();
    expect(records.filter((record) => record.stage === "bash-started")).toHaveLength(1);
    expect(records.filter((record) => record.stage === "parent-initial")).toHaveLength(1);
    const parentInitial = requireStage(records, "parent-initial");
    // 默认标题也属于本次闲时执行，不能只继承模型却漏掉请求票据。
    const sessionTitle = requireStage(records, "session-title");
    expect(sessionTitle.ticketId).toBe(parentInitial.ticketId);
    expect(sessionTitle.model).toBe(parentInitial.model);
    expect(sessionTitle.hasApiKey).toBe(true);
    const foregroundRecords = EXPECTED_FOREGROUND_STAGES.map((stage) =>
      requireStage(records, stage),
    );
    const parentContinuation = requireStage(records, "parent-continuation");
    const ticketIds = new Set(
      [parentInitial, ...foregroundRecords, parentContinuation].map((record) => record.ticketId),
    );

    expect(ticketIds.size).toBe(1);
    for (const record of foregroundRecords) {
      expect(record.model).toBe("GLM-5.3");
      expect(record.maxTokens).toBe(parentInitial.maxTokens);
      expect(record.hasApiKey).toBe(true);
      expect(record.hasAuthorization).toBe(true);
      expect(record.hasCodingPlanApiKey).toBe(true);
    }
    for (const stage of EXPECTED_BACKGROUND_STAGES) {
      const record = requireStage(records, stage);
      expect(record.model).toBe("GLM-5.3");
      expect(record.ticketId).toBe(parentInitial.ticketId);
      expect(record.hasCodingPlanApiKey).toBe(true);
    }

    const continuationBody = JSON.stringify(parentContinuation.requestJson);
    expect(continuationBody).not.toContain("Idle-time tasks do not support background agents.");
    let wakeBody = userWakeBody ?? "";
    if (takeover) {
      expect(records.some((record) => record.stage === "parent-wakeup")).toBe(false);
    } else {
      const wakeup = requireStage(records, "parent-wakeup");
      expect(wakeup.model).toBe("GLM-5.3");
      if (expireOnWake) {
        const expired = requireStage(records, "parent-wakeup-expired");
        expect(expired.ticketId).toBe(parentInitial.ticketId);
        expect(wakeup.ticketId).not.toBe(expired.ticketId);
        expect(
          records.some(
            (record) =>
              record.stage === "parent-wakeup" &&
              record.ticketId !== expired.ticketId &&
              JSON.stringify(record.requestJson) === JSON.stringify(expired.requestJson),
          ),
        ).toBe(true);
      } else {
        expect(wakeup.ticketId).toBe(parentInitial.ticketId);
      }
      wakeBody = JSON.stringify(wakeup.requestJson);
    }
    expect(wakeBody.includes("<tool-use-id>toolu_e2e_offpeak_bash</tool-use-id>")).toBe(true);
    const outputPath =
      /<output-file>([^<]*toolu_e2e_offpeak_bash-stdout\.log)<\/output-file>/u.exec(wakeBody)?.[1];
    expect(outputPath).toBeTruthy();
    expect(await readFile(JSON.parse(`"${outputPath!}"`) as string, "utf8")).toContain(
      "E2E_OFFPEAK_BACKGROUND_BASH_OK",
    );

    await openOffPeakTaskSession(title);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "闲时任务完成后打开 session 没有回到 idle",
      60000,
    );

    if (!takeover) {
      await recordComposerSelection("after-reopening-completed-task");
      await sendV4Prompt(ORDINARY_PROMPT_MARKER);
      await waitForV4ComposerText("", "闲时任务后的普通 prompt 没有提交");
      await waitForV4UserMessageContaining(ORDINARY_PROMPT_MARKER);
    }
    const ordinaryRecord = await waitForUpstreamNetworkCapture(ORDINARY_PROMPT_MARKER);
    assertUpstreamRequestCapture(ordinaryRecord, {
      expectedText: ORDINARY_PROMPT_MARKER,
      model: UPSTREAM_MODEL,
    });
    await waitForV4AssistantMessageContaining(ORDINARY_REPLY_TOKEN);

    const afterOrdinaryPrompt = await readOffPeakMockRequests();
    expect(
      afterOrdinaryPrompt.some((record) =>
        JSON.stringify(record.requestJson).includes(ORDINARY_PROMPT_MARKER),
      ),
    ).toBe(false);

    // F-OFFPEAK-001/F-OFFPEAK-003/F-OFFPEAK-005：闲时表单只展示隐藏
    // idle-plan 的扁平模型，不把当前 Chat 的 Start/Coding 连接泄漏进来。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "普通 prompt 完成后无法打开 Automations",
    });
    await openOffPeakTab();
    await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, {
      timeoutMsg: "闲时任务创建入口没有出现",
    });
    await waitForTestIdByDom(TID_OFFPEAK_FORM_TITLE, {
      timeout: 15000,
      timeoutMsg: "闲时任务创建页没有打开",
    });
    const modelTrigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    await modelTrigger.waitForDisplayed({ timeout: 15000 });
    expect(await modelTrigger.getAttribute("data-model-current-value")).toBe("GLM-5.3");
    await modelTrigger.click();
    const visibleModelItems = await browser.execute(
      (itemPrefix) =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((element) => element.dataset.testid ?? "")
          .filter((value) => value.startsWith(itemPrefix)),
      `${TID_CHAT_MODEL_SELECT_ITEM}-`,
    );
    expect(visibleModelItems).toEqual([testId(TID_CHAT_MODEL_SELECT_ITEM, "GLM-5.3")]);
    await browser.keys("Escape");
  });
});

/** 只读采集草稿与当前选择，区分空草稿不持久化和闲时执行覆盖普通模型。 */
async function recordComposerSelection(stage: string): Promise<void> {
  const diagnostic = await browser.execute(() => ({
    text: document.body.innerText,
    config: document.querySelector('[data-testid="v4-model-config"]')?.outerHTML,
    pane: document.querySelector('[data-testid="v4-session-pane"]')?.outerHTML.slice(0, 700),
    drafts: Object.fromEntries(
      Object.entries(localStorage).filter(([key]) => key.startsWith("zcode-v4-composer")),
    ),
  }));
  await writeFile(
    join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `offpeak-selection-${stage}.json`),
    JSON.stringify(diagnostic, null, 2),
  );
}

async function createOffPeakTask(input: { instructions: string; title: string }): Promise<void> {
  await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
    timeoutMsg: "侧栏没有出现 Automations 入口",
  });
  await openOffPeakTab();
  await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, {
    timeoutMsg: "闲时任务创建按钮没有出现",
  });
  await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, input.title, {
    timeoutMsg: "闲时任务标题输入没有出现",
  });
  await setInputValueByTestIdDom(TID_OFFPEAK_FORM_INSTRUCTIONS, input.instructions, {
    timeoutMsg: "闲时任务 instructions 输入没有出现",
  });
  // 后台 Bash 是本用例的受测行为，任务显式使用全权限，避免停在交互审批。
  await switchV4Mode("yolo");
  await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, {
    timeoutMsg: "闲时任务创建提交按钮不可点击",
  });
}

async function waitForOffPeakScenarioCompletion(): Promise<OffPeakMockRequestRecord[]> {
  let latest: OffPeakMockRequestRecord[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readOffPeakMockRequests();
      return [
        "parent-continuation",
        "background-explicit",
        "background-profile",
        "bash-started",
      ].every((stage) => latest.some((record) => record.stage === stage));
    },
    {
      interval: 1000,
      timeout: 180000,
      timeoutMsg: "闲时 mock 没有完成 foreground subagent 场景",
    },
  );
  return latest;
}

async function readOffPeakMockRequests(): Promise<OffPeakMockRequestRecord[]> {
  const port = Number(process.env.ZCODE_OFFPEAK_MOCK_PORT ?? "45197");
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__e2e/off-peak/requests`);
    if (!response.ok) return [];
    const body = (await response.json()) as {
      requests?: OffPeakMockRequestRecord[];
    };
    return Array.isArray(body.requests) ? body.requests : [];
  } catch {
    return [];
  }
}

function requireStage(
  records: readonly OffPeakMockRequestRecord[],
  stage: string,
): OffPeakMockRequestRecord {
  const record = records.findLast((candidate) => candidate.stage === stage);
  if (!record) {
    throw new Error(
      `闲时 mock 缺少请求阶段 ${stage}: ${JSON.stringify(
        records.map((candidate) => ({
          model: candidate.model,
          stage: candidate.stage,
        })),
      )}`,
    );
  }
  return record;
}

async function waitForOffPeakCardCompleted(title: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await readOffPeakCardText(title);
      // Bug 原因：卡片成功终态的英文产品文案是 Succeeded，旧断言只接受 Completed。
      return /Completed|Succeeded|已完成/u.test(text ?? "");
    },
    {
      interval: 1000,
      timeout: 180000,
      timeoutMsg: `闲时任务没有进入 completed: ${title}`,
    },
  );
}

async function openOffPeakTab(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((tabTestId) => {
        const tabGroup = document.querySelector<HTMLElement>(`[data-testid="${tabTestId}"]`);
        if (!tabGroup && document.querySelector('[data-testid="offpeak-create-button"]'))
          return true;
        const offPeakButton = Array.from(
          tabGroup?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => /闲时任务|Idle/u.test(button.textContent ?? ""));
        if (!offPeakButton) return false;
        offPeakButton.click();
        return true;
      }, TID_OFFPEAK_TAB),
    {
      interval: 500,
      timeout: 30000,
      timeoutMsg: "Automations 没有出现闲时任务标签",
    },
  );
}

async function readOffPeakCardText(title: string): Promise<string | null> {
  return browser.execute(
    (cardTestId, expectedTitle) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${cardTestId}"]`))
        .find((card) => card.textContent?.includes(expectedTitle))
        ?.textContent?.trim() ?? null,
    TID_OFFPEAK_CARD,
    title,
  );
}

async function openOffPeakTaskSession(title: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (cardTestId, expectedTitle) => {
          const card = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${cardTestId}"]`),
          ).find((candidate) => candidate.textContent?.includes(expectedTitle));
          const sessionButton = Array.from(
            card?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find((button) => !button.dataset.testid);
          if (!sessionButton) return false;
          sessionButton.click();
          return true;
        },
        TID_OFFPEAK_CARD,
        title,
      ),
    {
      interval: 500,
      timeout: 30000,
      timeoutMsg: `闲时任务卡片没有出现 session 跳转入口: ${title}`,
    },
  );
}
