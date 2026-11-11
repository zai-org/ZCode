import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ZCodeAutomationBotDeliveryTarget, ZCodeStreamEvent } from "@zcode/shared";
import { AutomationRepo, setDataBaseDir } from "@zcode/services/node";

import {
  createBotsServiceHarness,
  createFeishuCallback,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";

describe("Bot automation terminal result delivery E2E", () => {
  const originalFetch = globalThis.fetch;
  let dataDir: string | null = null;
  let repo: AutomationRepo | null = null;
  let harness: ReturnType<typeof createBotsServiceHarness> | null = null;

  afterEach(async () => {
    harness?.service.disposeAll();
    harness = null;
    repo?.close();
    repo = null;
    setDataBaseDir(null);
    globalThis.fetch = originalFetch;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
  });

  it("BOT-E2E-CR-01 persists the Bot target and delivers desktop run terminal events", async () => {
    const fixture = await readBotSyntheticFixture("automation-result-delivery.json");
    expect(fixture).toMatchObject({
      caseId: "BOT-E2E-CR-01",
      classification: "synthetic",
      timing: "controlled-stream",
    });
    expect(fixture.syntheticReason.length).toBeGreaterThan(20);

    const requests: RecordedRequest[] = [];
    globalThis.fetch = createRecordingFeishuFetch(requests);
    const config = createFeishuConfig();
    harness = createBotsServiceHarness({ config });

    const callback = await harness.service.handleProviderCallbackResponse(
      "feishu",
      createFeishuCallback("feishu-e2e", `${fixture.promptMarker} 每天九点生成日报`),
    );
    expect(callback.ok).toBe(true);
    await waitFor(() => harness?.sendPromptCalls.length === 1, "Bot prompt dispatch");
    const creationPrompt = harness.sendPromptCalls[0] as {
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
    };
    expect(creationPrompt.botDeliveryTarget).toEqual({
      provider: "feishu",
      botId: "feishu-e2e",
      providerUserId: "ou_e2e_user",
      chatType: "private",
    });

    dataDir = await mkdtemp(join(tmpdir(), "zcode-bot-automation-e2e-"));
    setDataBaseDir(dataDir);
    repo = new AutomationRepo();
    const automation = await repo.create(
      {
        title: "Bot 日报",
        cronExpr: "0 9 * * *",
        prompt: "生成日报",
        workspacePath: "/workspace",
        targetTaskId: "task-e2e-bot",
        botDeliveryTarget: creationPrompt.botDeliveryTarget,
        recurring: true,
      },
      { nextRunAt: Date.now() + 60_000 },
    );
    repo.close();
    repo = new AutomationRepo();
    const persistedTarget = await repo.getBotDeliveryTarget(
      automation.automationId,
      automation.workspaceKey,
    );
    expect(persistedTarget).toEqual(creationPrompt.botDeliveryTarget);

    const subscriptionsBeforeRun = harness.subscriptions.length;
    await expect(
      harness.service.watchAutomationRun({
        target: persistedTarget!,
        workspacePath: automation.workspacePath,
        taskId: "task-e2e-automation-complete",
      }),
    ).resolves.toBeUndefined();
    // Host 只有在 watcher 已经进入 task service 后才允许继续 sendPrompt；快速终态不会漏回推。
    expect(harness.subscriptions).toHaveLength(subscriptionsBeforeRun + 1);
    const completionListener = harness.subscriptions.at(-1)?.listener;
    expect(completionListener).toBeDefined();
    await completionListener?.(
      streamEvent({
        type: "agent_message_chunk",
        taskId: "task-e2e-automation-complete",
        traceId: "trace-e2e-automation-complete",
        content: "日报已生成。",
      }),
    );
    await completionListener?.(
      streamEvent({
        type: "task_complete",
        taskId: "task-e2e-automation-complete",
        traceId: "trace-e2e-automation-complete",
        stopReason: "end_turn",
      }),
    );
    await waitFor(
      () => requests.some((request) => request.body?.includes("日报已生成")),
      "Feishu completion delivery",
    );

    await harness.service.watchAutomationRun({
      target: creationPrompt.botDeliveryTarget!,
      taskId: "task-e2e-automation-error",
      workspacePath: automation.workspacePath,
    });
    const errorListener = harness.subscriptions.at(-1)?.listener;
    await errorListener?.(
      streamEvent({
        type: "task_error",
        taskId: "task-e2e-automation-error",
        traceId: "trace-e2e-automation-error",
        error: "automation failed",
      }),
    );
    await waitFor(
      () => requests.some((request) => request.body?.includes("automation failed")),
      "Feishu failure delivery",
    );

    const subscriptionsBeforeDisable = harness.subscriptions.length;
    config.bots = config.bots.map((bot) => ({ ...bot, enabled: false }));
    await expect(
      harness.service.watchAutomationRun({
        target: creationPrompt.botDeliveryTarget!,
        taskId: "task-e2e-automation-disabled",
        workspacePath: automation.workspacePath,
      }),
    ).resolves.toBeUndefined();
    expect(harness.subscriptions).toHaveLength(subscriptionsBeforeDisable);
  });
});

function streamEvent(event: ZCodeStreamEvent): ZCodeStreamEvent {
  return event;
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
