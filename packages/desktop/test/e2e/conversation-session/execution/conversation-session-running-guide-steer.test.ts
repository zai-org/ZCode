import { assertIncomingMessage, wireText } from "#e2e/helpers/incoming-message-evidence";
import {
  INCOMING_MESSAGE_MODES,
  prepareIncomingMessageCapability,
  switchIncomingMessageCapability,
} from "#e2e/helpers/incoming-message-capability";
import { TID_CHAT_ASSISTANT_HISTORY_TRIGGER, TID_V4_TIMELINE } from "@zcode/shared/test-ids";
import { clearAppData, readSettings, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import {
  E2E_READONLY_TOOL_FILE_CONTENT,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import { getQueueItems } from "#e2e/helpers/conversation-session-queue";
import { waitForTaskStoreSnapshot } from "#e2e/helpers/conversation-session-store";
import {
  TOTAL_TOKENS_BUDGET,
  totalTokensAfterLastAssistant,
} from "#e2e/helpers/total-tokens-evidence";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4ConversationState,
  getV4GoalProjection,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  selectV4TaskById,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const GUIDE_GOAL_SEED_REPLY = "running-guide-goal-seed-ok";

describe("会话区 Running Guide / Steer E2E", () => {
  before(async () => {
    await ensureReadonlyToolFixtureFile();
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const { label, mcs } of INCOMING_MESSAGE_MODES) {
    it(`P06 ${label}：tool-batch 与 text-only drain 后 steer 按同轮时间线顺序显示`, async function () {
      this.timeout(150000);

      // 修复原因：同一 worker 的前一条 steer/stop 会留下 completed 或 interrupted session；
      // guide、active goal 与 verifier 必须各自在新草稿中建立 owner，不能串用上一 case 的状态。
      await prepareIncomingMessageCapability(mcs);
      expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");

      const runId = Date.now();
      const baseMarker = `E2E_GUIDE_TIMELINE_BASE_${runId}`;
      const guideOneMarker = `E2E_GUIDE_TIMELINE_GUIDE_ONE_${runId}`;
      const guideTwoMarker = `E2E_GUIDE_TIMELINE_GUIDE_TWO_${runId}`;
      const middleAssistantMarker = "E2E_GUIDE_TIMELINE_MIDDLE_ASSISTANT";
      const finalAssistantMarker = "guide-timeline-final-assistant-ok";
      const requestCountBefore = await getUpstreamRequestRecordCount();
      // Bug 根因：capture 的 afterIndex 是“最后一个已消费的数组下标”，而不是记录数；
      // 记录数为 0 时直接传 0 会把本次首条 request（index 0）排除，误报 provider 未发请求。
      const lastRequestIndexBefore = requestCountBefore - 1;

      await sendV4Prompt(
        `${baseMarker}: Read the readonly fixture, then keep following both guide messages in this active turn.`,
      );
      await waitForUpstreamRequest(
        { lastUserMessageIncludes: [baseMarker] },
        "P06 首轮 provider request 没有发出",
        30000,
        { afterIndex: lastRequestIndexBefore },
      );
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "streaming",
        "P06 首轮请求没有保持 guide-1 可 admission 的 running 窗口",
        15000,
      );

      await sendV4Prompt(`${guideOneMarker}: apply the first guide after the Read result batch.`);
      await waitForGuidedPromptProjection(guideOneMarker);

      await waitForUpstreamRequest(
        {
          includes: [guideOneMarker, E2E_READONLY_TOOL_FILE_CONTENT],
          lastUserMessageIncludes: [E2E_READONLY_TOOL_FILE_CONTENT],
        },
        "P06 guide-1 没有在完整 Read result batch 后进入同一 active turn",
        30000,
        { afterIndex: lastRequestIndexBefore },
      );
      const firstEvidence = await getUpstreamRequestEvidence(
        { includes: [guideOneMarker, E2E_READONLY_TOOL_FILE_CONTENT] },
        { afterIndex: lastRequestIndexBefore },
      );
      const firstWire = await assertIncomingMessage(firstEvidence[0]!.requestJson, {
        presentation: "user_steer",
        marker: guideOneMarker,
        // guide 是中途消息：MCS 下并入 run 的 system，MCS 关时为 user reminder。
        role: mcs ? "system" : "user",
        evidenceLabel: label,
        body: `${guideOneMarker}: apply the first guide after the Read result batch.`,
      });
      expect(JSON.stringify(firstWire.messages.slice(0, firstWire.index + 1))).toContain(
        '"type":"tool_result"',
      );
      // 工具批次之后的 guide 不重新起算：提醒按 Read 响应的上下文（默认 usage 128/16）倒数，排在 guide 之后。
      expect(totalTokensAfterLastAssistant(firstEvidence[0]!.requestJson)).toEqual([
        TOTAL_TOKENS_BUDGET - 144,
      ]);
      const firstTail = JSON.stringify(
        firstWire.messages.slice(
          firstWire.messages.findLastIndex((message) => message.role === "assistant") + 1,
        ),
      );
      // 先确认 guide 在尾部：indexOf 找不到时是 -1，顺序比较会空过。
      expect(firstTail.indexOf(guideOneMarker)).toBeGreaterThanOrEqual(0);
      expect(firstTail.indexOf(guideOneMarker)).toBeLessThan(firstTail.indexOf("<total_tokens>"));
      await waitForV4UserMessageContaining(guideOneMarker);
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "streaming",
        "P06 guide-1 续跑没有保持 streaming",
        15000,
      );

      await sendV4Prompt(`${guideTwoMarker}: apply the second guide after the text-only response.`);
      await waitForGuidedPromptProjection(guideTwoMarker);

      await waitForUpstreamRequest(
        {
          includes: [guideTwoMarker, middleAssistantMarker],
          lastUserMessageIncludes: [guideTwoMarker],
        },
        "P06 guide-2 没有在 text-only assistant 完成后进入同一 active turn",
        30000,
        { afterIndex: lastRequestIndexBefore },
      );
      const secondEvidence = await getUpstreamRequestEvidence(
        { includes: [guideTwoMarker, middleAssistantMarker] },
        { afterIndex: lastRequestIndexBefore },
      );
      const secondWire = await assertIncomingMessage(secondEvidence[0]!.requestJson, {
        presentation: "user_steer",
        marker: guideTwoMarker,
        evidenceLabel: label,
        // text-only 回复之后没有 user/tool 锚点，MCS 下降级为 user reminder。
        role: "user",
        mcsFallback: mcs,
        body: `${guideTwoMarker}: apply the second guide after the text-only response.`,
      });
      expect(secondWire.messages[secondWire.index - 1]?.role).toBe("assistant");
      expect(JSON.stringify(secondWire.messages[secondWire.index - 1]?.content)).toContain(
        middleAssistantMarker,
      );
      // 纯文本回复之后取出的 guide 按用户发言处理，预算提醒重新起算。
      expect(totalTokensAfterLastAssistant(secondEvidence[0]!.requestJson)).toEqual([
        TOTAL_TOKENS_BUDGET,
      ]);
      await waitForV4UserMessageContaining(guideTwoMarker);
      await waitForV4AssistantMessageContaining(finalAssistantMarker);
      await waitForV4ConversationState(
        (snapshot) => snapshot.state !== "streaming" && snapshot.runtimeStatus !== "streaming",
        "P06 两次 guide drain 后会话没有完成",
        30000,
      );
      expect(await getQueueItems()).toHaveLength(0);

      // 同选择 Guide 可重新解析配置，但不能误触发切模前缀变化；检查实际请求而非模型自述。
      const requests = await getUpstreamRequestEvidence(
        { includes: [baseMarker] },
        { afterIndex: lastRequestIndexBefore },
      );
      // 辅助的标题/摘要调用也可能引用用户正文；这里只比较主执行的流式请求。
      const prefixes = requests
        .filter(({ requestJson }) => (requestJson as { stream?: boolean }).stream === true)
        .map(({ requestJson }) => {
          const body = requestJson as {
            system?: unknown;
            messages?: Array<{ role: string; content: unknown }>;
          };
          const messages = body.messages ?? [];
          const firstUser = messages.findIndex((message) => message.role !== "system");
          return body.system ?? messages.slice(0, firstUser < 0 ? messages.length : firstUser);
        });
      expect(prefixes.length).toBeGreaterThanOrEqual(3);
      expect(prefixes[0]).toBeTruthy();
      expect(JSON.stringify(prefixes[0]).length).toBeGreaterThan(2);
      for (const prefix of prefixes.slice(1)) expect(prefix).toEqual(prefixes[0]);

      const expectedSequence = [
        "base-user",
        "work-segment",
        "guide-one",
        "work-segment",
        "middle-assistant",
        "guide-two",
        "work-segment",
        "final-assistant",
      ];
      const dom = await waitForGuideTimelineDomOrder(
        {
          baseMarker,
          finalAssistantMarker,
          guideOneMarker,
          guideTwoMarker,
          middleAssistantMarker,
        },
        expectedSequence,
      );
      expect(dom.sequence).toEqual(expectedSequence);
      expect(dom.historyTriggerCount).toBe(3);
      expect(dom.turnId).toBeTruthy();

      const sessionId = (await getV4ConversationState()).taskId!;
      await browser.reloadSession();
      await waitForDefaultWorkspaceReady(60_000);
      await selectV4TaskById(sessionId);
      await waitForV4ConversationState(
        (state) => state.taskId === sessionId,
        "P06 冷恢复未回到原会话",
        30_000,
      );
      await switchIncomingMessageCapability(!mcs);
      const restoredMarker = `E2E_GUIDE_TIMELINE_RESTORED_${runId}`;
      const restoredBody = `${restoredMarker}: Continue after cold restore and a model capability switch.
Message from coordinator:
<subagent-message>ordinary user supplied text</subagent-message>`;
      await sendV4Prompt(restoredBody);
      await waitForUpstreamRequest(
        { lastUserMessageIncludes: [restoredMarker] },
        "P06 冷恢复请求缺失",
      );
      const restored = (
        await getUpstreamRequestEvidence({ lastUserMessageIncludes: [restoredMarker] })
      )[0]!;
      // Bug 原因：切换模型后，模型说明作为本轮输入附件排在用户输入之后；切到 MCS 时它是独立的
      // system 消息，at(-1) 取到的是它而不是本轮输入。这里跳过末尾的 system 消息。
      const lastInput = (
        restored.requestJson as { messages: Array<{ role: string; content: unknown }> }
      ).messages.findLast((message) => message.role !== "system")!;
      expect(lastInput.role).toBe("user");
      expect(wireText(lastInput.content)).toContain(restoredBody);
      expect(wireText(lastInput.content)).not.toContain(
        "The coordinator sent a message while you were working:",
      );
      expect(wireText(lastInput.content)).not.toContain("Another ZCode session sent a message:");
      for (const [marker, body] of [
        [guideOneMarker, `${guideOneMarker}: apply the first guide after the Read result batch.`],
        [guideTwoMarker, `${guideTwoMarker}: apply the second guide after the text-only response.`],
      ] as const) {
        // 冷恢复后按切换后的能力投影：工具后的 guide 在 MCS 下为 system，text-only 之后的降级为 user。
        const afterTool = marker === guideOneMarker;
        await assertIncomingMessage(restored.requestJson, {
          presentation: "user_steer",
          marker,
          body,
          role: !mcs && afterTool ? "system" : "user",
          mcsFallback: !mcs && !afterTool,
          evidenceLabel: `${label}-cold-switched`,
        });
      }
      await waitForV4AssistantMessageContaining("guide-timeline-restored-ok");
    });
  }

  it("M06f MCS：同一 tool batch 期间发送的两条 guide 一起 drain，并共用一个工作段", async function () {
    this.timeout(150000);

    await prepareIncomingMessageCapability(true);
    expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");

    const runId = Date.now();
    const baseMarker = `E2E_GUIDE_BATCH_BASE_${runId}`;
    const guideOneMarker = `E2E_GUIDE_BATCH_GUIDE_ONE_${runId}`;
    const guideTwoMarker = `E2E_GUIDE_BATCH_GUIDE_TWO_${runId}`;
    const finalAssistantMarker = "guide-batch-final-assistant-ok";
    const lastRequestIndexBefore = (await getUpstreamRequestRecordCount()) - 1;

    await sendV4Prompt(
      `${baseMarker}: Read the readonly fixture, then follow both guide messages.`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [baseMarker] },
      "M06f 首轮 provider request 没有发出",
      30000,
      { afterIndex: lastRequestIndexBefore },
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "M06f 首轮请求没有保持 guide 可 admission 的 running 窗口",
      15000,
    );

    // 两条 guide 都在 Read 的 tool batch 完成前进入等待。
    await sendV4Prompt(`${guideOneMarker}: first guide during the Read batch.`);
    await waitForGuidedPromptProjection(guideOneMarker);
    await sendV4Prompt(`${guideTwoMarker}: second guide during the Read batch.`);
    await waitForGuidedPromptProjection(guideTwoMarker);

    await waitForUpstreamRequest(
      { includes: [guideOneMarker, guideTwoMarker, E2E_READONLY_TOOL_FILE_CONTENT] },
      "M06f 两条 guide 没有在同一 Read result batch 后一起进入请求",
      30000,
      { afterIndex: lastRequestIndexBefore },
    );
    // 同一边界一次取出：带 guide-1 的主请求都同时带 guide-2，且按 admission 顺序排列。
    const guideRequests = (
      await getUpstreamRequestEvidence(
        { includes: [guideOneMarker] },
        { afterIndex: lastRequestIndexBefore },
      )
    ).filter(({ requestJson }) => (requestJson as { stream?: boolean }).stream === true);
    expect(guideRequests.length).toBeGreaterThan(0);
    for (const { requestJson } of guideRequests) {
      const body = JSON.stringify(requestJson);
      expect(body).toContain(guideTwoMarker);
      expect(body.indexOf(guideOneMarker)).toBeLessThan(body.indexOf(guideTwoMarker));
    }
    await waitForV4AssistantMessageContaining(finalAssistantMarker);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.runtimeStatus !== "streaming",
      "M06f 两条 guide drain 后会话没有完成",
      30000,
    );
    expect(await getQueueItems()).toHaveLength(0);

    const markers = {
      baseMarker,
      finalAssistantMarker,
      guideOneMarker,
      guideTwoMarker,
      middleAssistantMarker: `guide-batch-no-middle-${runId}`,
    };
    // 相邻 guide 共用第一条开启的工作段，中间不出现空的“已工作”。
    const expectedSequence = [
      "base-user",
      "work-segment",
      "guide-one",
      "guide-two",
      "work-segment",
      "final-assistant",
    ];
    expect((await waitForGuideTimelineDomOrder(markers, expectedSequence)).sequence).toEqual(
      expectedSequence,
    );

    // 冷恢复为每条 guide 各合成一个 drained 事件，工作段必须与 live 相同。
    const sessionId = (await getV4ConversationState()).taskId!;
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady(60_000);
    await selectV4TaskById(sessionId);
    await waitForV4ConversationState(
      (state) => state.taskId === sessionId,
      "M06f 冷恢复未回到原会话",
      30_000,
    );
    expect((await waitForGuideTimelineDomOrder(markers, expectedSequence)).sequence).toEqual(
      expectedSequence,
    );
  });

  it("guide 模式下 running 中发送引导消息，不得从 steer 队列和历史中消失", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");

    const runId = Date.now();
    const runningMarker = `E2E_RUNNING_GUIDE_STEER_BASE_${runId}`;
    const guidedMarker = `E2E_RUNNING_GUIDE_STEER_FOLLOWUP_${runId}`;

    const runningPrompt = `E2E_SLOW_STREAM ${runningMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(runningPrompt);
    await waitForV4ComposerText("", "running guide steer 基础消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(runningMarker);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "running guide steer 基础消息没有进入 streaming",
      30000,
    );
    await waitForUpstreamRequestContaining(runningMarker);

    const runningSnapshot = await getV4ConversationState();
    expect(runningSnapshot.taskId).toBeTruthy();
    const storeSnapshot = await waitForTaskStoreSnapshot(
      runningSnapshot.taskId!,
      (snapshot) => snapshot.workspaceKey !== null,
      "running guide steer 基础消息没有进入 task store",
    );
    expect(storeSnapshot.selectedProvider).toBe("glm");
    expect(storeSnapshot.queueCount).toBe(0);

    const guidedPrompt = `${guidedMarker}: Keep guiding the current turn and preserve this message.`;
    await sendV4Prompt(guidedPrompt);
    await waitForV4ComposerText("", "running guide steer 引导消息发送后输入框没有清空");

    await browser.waitUntil(
      () =>
        browser.execute((marker) => {
          const list = document.querySelector('[data-v4-pending-guide-list="true"]');
          const row = Array.from(list?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
            (element) => element.innerText.includes(marker),
          );
          return Boolean(row?.querySelector('[data-v4-user-input-status="true"]'));
        }, guidedMarker),
      { timeout: 15000, timeoutMsg: "引导消息没有显示等待提示，无法检查对齐" },
    );
    const alignment = await browser.execute((marker) => {
      const list = document.querySelector('[data-v4-pending-guide-list="true"]');
      const row = Array.from(list?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
        (element) => element.innerText.includes(marker),
      )!;
      const status = row.querySelector<HTMLElement>('[data-v4-user-input-status="true"]')!;
      const bubble = row.querySelector<HTMLElement>('[data-v4-user-input-bubble="true"]')!;
      const composer = document.querySelector<HTMLElement>(".chat-composer-input-surface")!;
      return {
        rowRight: row.getBoundingClientRect().right,
        statusRight: status.getBoundingClientRect().right,
        bubbleRight: bubble.getBoundingClientRect().right,
        composerRight: composer.getBoundingClientRect().right,
      };
    }, guidedMarker);
    // 回归原因：待引导列表绕过轮容器后漏掉水平留白，气泡和等待提示比输入框更靠右。
    for (const right of [alignment.rowRight, alignment.statusRight, alignment.bubbleRight]) {
      expect(Math.abs(right - alignment.composerRight)).toBeLessThanOrEqual(1);
    }

    const firstProjection = await waitForGuidedPromptProjection(guidedMarker);
    expect(firstProjection.location).not.toBe("missing");
    if (firstProjection.location === "queue") {
      // 修复原因：V4 将 guide admission 暂存在 host runtime sendText queue，
      // 旧 renderer-local DOM 才暴露 turn-steer；最终语义由 drain 后的 user row 校验。
      expect(["turn-steer", "text"]).toContain(firstProjection.kind);
      expect(["submitting", "queued"]).toContain(firstProjection.status);
    }

    // 修复原因：用户反馈的是 guide/steer 模式下消息短暂出现后丢失；
    // 因此不仅要验证入队瞬间，还要等一小段时间确认它仍在 steer 队列、
    // 已转为普通本地队列，或已经投影成 user message。
    await browser.pause(1500);
    const stableProjection = await getGuidedPromptProjection(guidedMarker);
    expect(stableProjection.location).not.toBe("missing");
  });

  it("guide 模式下 active goal 运行中发送引导消息，不得 stop active target", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");

    const runId = Date.now();
    await establishGuideGoalSession(`E2E_RUNNING_GUIDE_GOAL_SEED_ACTIVE_${runId}`);
    const goalMarker = `E2E_RUNNING_GUIDE_GOAL_ACTIVE_${runId}`;
    const guidedMarker = `E2E_RUNNING_GUIDE_GOAL_STEER_${runId}`;
    const requestCountBefore = await getUpstreamRequestRecordCount();
    const lastRequestIndexBefore = requestCountBefore - 1;

    const goalPrompt = `/goal E2E_SLOW_STREAM ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(goalPrompt);
    await waitForV4ComposerText("", "running guide goal steer 目标消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(goalMarker);
    await waitForUpstreamRequest(
      {
        includes: [goalMarker, "Continue working toward the active session goal"],
      },
      "running guide goal steer active goal continuation request 没有发出",
      30000,
      { afterIndex: lastRequestIndexBefore },
    );
    await waitForV4GoalProjection(
      goalMarker,
      ["active"],
      "running guide goal steer 没有形成 active goal 投影",
    );

    const guidedPrompt = `${guidedMarker}: Guide the active goal without stopping it.`;
    await sendV4Prompt(guidedPrompt);
    await waitForV4ComposerText("", "running guide goal steer 引导消息发送后输入框没有清空");

    const firstProjection = await waitForGuidedPromptProjection(guidedMarker);
    expect(firstProjection.location).not.toBe("missing");
    if (firstProjection.location === "queue") {
      expect(["turn-steer", "text"]).toContain(firstProjection.kind);
      expect(["submitting", "queued"]).toContain(firstProjection.status);
    }

    await waitForUpstreamRequestContaining(guidedMarker, 30000);
    const afterGuide = await getV4ConversationState();
    expect(afterGuide.stopRequested).toBe(false);
    const goalAfterGuide = await waitForV4GoalProjection(
      goalMarker,
      ["active", "verifying"],
      "running guide goal steer drain 后 active goal 投影丢失",
    );
    expect(goalAfterGuide.objective).toContain(goalMarker);

    await browser.pause(1500);
    const stableProjection = await getGuidedPromptProjection(guidedMarker);
    expect(stableProjection.location).not.toBe("missing");
    const stableSnapshot = await getV4ConversationState();
    expect(stableSnapshot.stopRequested).toBe(false);
    const stableGoal = await getV4GoalProjection();
    expect(stableGoal?.status).toBe("active");
    expect(stableGoal?.objective).toContain(goalMarker);
  });

  it("guide 模式下 goal verifier 运行中发送消息，应保留为 future queue 且不 stop active target", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");

    const runId = Date.now();
    await establishGuideGoalSession(`E2E_RUNNING_GUIDE_GOAL_SEED_VERIFY_${runId}`);
    const goalMarker = `E2E_RUNNING_GUIDE_GOAL_VERIFY_${runId}`;
    const guidedMarker = `E2E_RUNNING_GUIDE_GOAL_VERIFY_QUEUE_${runId}`;
    const requestCountBefore = await getUpstreamRequestRecordCount();
    const lastRequestIndexBefore = requestCountBefore - 1;

    const goalPrompt = `/goal ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(goalPrompt);
    await waitForV4ComposerText(
      "",
      "running guide goal verifier steer 目标消息发送后输入框没有清空",
    );
    await waitForV4UserMessageContaining(goalMarker);
    await waitForUpstreamRequest(
      {
        includes: [goalMarker, "Verify whether the active session goal"],
      },
      "running guide goal verifier steer 没有进入 verifier request",
      90000,
      { afterIndex: lastRequestIndexBefore },
    );
    await waitForV4GoalProjection(
      goalMarker,
      ["active", "verifying"],
      "running guide goal verifier steer 没有形成 verifier goal 投影",
    );

    const guidedPrompt = `${guidedMarker}: Queue guidance while the active verifier keeps running.`;
    await sendV4Prompt(guidedPrompt);
    await waitForV4ComposerText(
      "",
      "running guide goal verifier steer 引导消息发送后输入框没有清空",
    );

    const firstProjection = await waitForGuidedPromptProjection(guidedMarker);
    expect(firstProjection.location).toBe("queue");
    if (firstProjection.location !== "queue") {
      throw new Error(
        `running guide goal verifier queue 投影位置不正确: ${JSON.stringify(firstProjection)}`,
      );
    }
    expect(firstProjection.kind).toBe("text");
    expect(firstProjection.status).toBe("queued");

    const afterGuide = await getV4ConversationState();
    expect(afterGuide.stopRequested).toBe(false);
    const goalAfterGuide = await getV4GoalProjection();
    expect(["active", "verifying"]).toContain(goalAfterGuide?.status);
    expect(goalAfterGuide?.objective).toContain(goalMarker);
  });
});

async function establishGuideGoalSession(seedMarker: string) {
  // 修复原因：draft prewarm 不是 active goal/goal verifier 的产品前置态；直接把 /goal
  // 作为首条输入会把 prewarm admission 混入断言。先建立稳定 session，再验证目标链路。
  await sendV4Prompt(
    `${seedMarker}: Reply with exactly "${GUIDE_GOAL_SEED_REPLY}" and no other text.`,
  );
  await waitForV4ComposerText("", "running guide goal seed 发送后输入框没有清空");
  await waitForV4UserMessageContaining(seedMarker);
  await waitForV4AssistantMessageContaining(GUIDE_GOAL_SEED_REPLY);
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId !== null &&
      snapshot.state !== "streaming" &&
      snapshot.runtimeStatus !== "streaming",
    "running guide goal seed 没有建立稳定 session",
    30000,
  );
}

async function waitForV4GoalProjection(
  marker: string,
  statuses: readonly string[],
  timeoutMsg: string,
) {
  let latest = await getV4GoalProjection();
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4GoalProjection();
        return (
          latest?.objective?.includes(marker) === true &&
          latest.status !== null &&
          statuses.includes(latest.status)
        );
      },
      { timeout: 30000, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4GoalProjection();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, { cause: error });
  }
  if (!latest) {
    throw new Error(`${timeoutMsg}; latest=null`);
  }
  return latest;
}

type GuidedPromptProjection =
  | { location: "queue"; kind: string | null; status: string | null }
  | { location: "user-message"; id: string | null }
  | { location: "missing"; queue: unknown[]; userMessages: unknown[] };

interface GuideTimelineMarkers {
  baseMarker: string;
  finalAssistantMarker: string;
  guideOneMarker: string;
  guideTwoMarker: string;
  middleAssistantMarker: string;
}

interface GuideTimelineDomSnapshot {
  historyTriggerCount: number;
  sequence: string[];
  turnId: string | null;
}

async function waitForGuideTimelineDomOrder(
  markers: GuideTimelineMarkers,
  expectedSequence: string[],
): Promise<GuideTimelineDomSnapshot> {
  let latest: GuideTimelineDomSnapshot = {
    historyTriggerCount: 0,
    sequence: [],
    turnId: null,
  };
  try {
    await browser.waitUntil(
      async () => {
        latest = await getGuideTimelineDomSnapshot(markers);
        return JSON.stringify(latest.sequence) === JSON.stringify(expectedSequence);
      },
      {
        timeout: 30000,
        timeoutMsg: "P06 steer 与工作段没有按 CLI row 全序渲染",
      },
    );
  } catch (error) {
    latest = await getGuideTimelineDomSnapshot(markers);
    throw new Error(
      `P06 steer DOM 顺序错误; expected=${JSON.stringify(expectedSequence)}; latest=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
  return latest;
}

function getGuideTimelineDomSnapshot(
  markers: GuideTimelineMarkers,
): Promise<GuideTimelineDomSnapshot> {
  return browser.execute(
    (timelineTestId, historyTriggerPrefix, expectedMarkers) => {
      const normalizeText = (value: string) => value.replace(/\u00a0/g, " ").trim();
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const rowElements = Array.from(
        timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      );
      const baseRow = rowElements.find(
        (element) =>
          element.classList.contains("group/user-row") &&
          normalizeText(element.innerText).includes(expectedMarkers.baseMarker),
      );
      const turn = baseRow?.closest<HTMLElement>("[data-turn-id]") ?? null;
      if (!turn) {
        return { historyTriggerCount: 0, sequence: [], turnId: null };
      }

      const sequence = Array.from(
        turn.querySelectorAll<HTMLElement>(
          `[data-row-id],[data-testid^="${historyTriggerPrefix}-"]`,
        ),
      )
        .map((element) => {
          const testIdValue = element.getAttribute("data-testid") ?? "";
          if (testIdValue.startsWith(`${historyTriggerPrefix}-`)) return "work-segment";
          const text = normalizeText(element.innerText);
          if (text.includes(expectedMarkers.baseMarker)) return "base-user";
          if (text.includes(expectedMarkers.guideOneMarker)) return "guide-one";
          if (text.includes(expectedMarkers.middleAssistantMarker)) return "middle-assistant";
          if (text.includes(expectedMarkers.guideTwoMarker)) return "guide-two";
          if (text.includes(expectedMarkers.finalAssistantMarker)) return "final-assistant";
          return null;
        })
        .filter((item) => item !== null);

      return {
        historyTriggerCount: sequence.filter((item) => item === "work-segment").length,
        sequence,
        turnId: turn.getAttribute("data-turn-id"),
      };
    },
    TID_V4_TIMELINE,
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    markers,
  );
}

async function waitForGuidedPromptProjection(marker: string): Promise<GuidedPromptProjection> {
  let latest: GuidedPromptProjection = {
    location: "missing",
    queue: [],
    userMessages: [],
  };
  await browser.waitUntil(
    async () => {
      latest = await getGuidedPromptProjection(marker);
      return latest.location !== "missing";
    },
    {
      timeout: 30000,
      timeoutMsg: `running guide steer 没有观察到引导消息投影: ${marker}`,
    },
  );
  return latest;
}

async function getGuidedPromptProjection(marker: string): Promise<GuidedPromptProjection> {
  const queue = await getQueueItems();
  const queued = queue.find((item) => item.content.includes(marker));
  if (queued) {
    return {
      kind: queued.kind,
      location: "queue",
      status: queued.status,
    };
  }

  const userMessages = await getV4Messages("user");
  const message = userMessages.find((candidate) => candidate.text.includes(marker));
  if (message) {
    return {
      id: message.id,
      location: "user-message",
    };
  }

  return {
    location: "missing",
    queue,
    userMessages,
  };
}

async function stopIfBusy() {
  const snapshot = await getV4ConversationState().catch(() => null);
  // 修复原因：goal verifier 运行时 ChatView 普通消息状态可能已是 idle，
  // 但 task runtime 仍在 streaming；清理阶段必须按 runtime 状态补停。
  if (snapshot?.state !== "streaming" && snapshot?.runtimeStatus !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming" && candidate.runtimeStatus !== "streaming",
    "running guide steer 清理阶段没有退出 streaming",
    30000,
  ).catch(() => undefined);
  await getQueueItems().catch(() => []);
}
