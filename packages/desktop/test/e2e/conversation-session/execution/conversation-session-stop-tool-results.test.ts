import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "#e2e/helpers/conversation-session-network";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  holdToolResultDatabaseWriteLock,
  readStopToolLogs,
  releaseTextBashHook,
  resetTextBashHook,
  restoreStopToolResultsFixture,
  waitForTextBashBarrier,
  waitForStopToolBarrier,
  writeStopToolEvidence,
} from "#e2e/helpers/stop-tool-results-fixture";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  getV4QueueItems,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const cases = [
  { variant: "text", marker: "E2E_STOP_RESULTS_TEXT", reply: "STOP_RESULTS_TEXT_OK" },
  { variant: "image", marker: "E2E_STOP_RESULTS_IMAGE", reply: "STOP_RESULTS_IMAGE_OK" },
] as const;

describe("B12 Stop 后 Read 结果完整性对照", () => {
  after(async () => {
    try {
      if ((await getV4PaneSnapshot()).canStop) {
        await clickV4Stop();
        await waitForV4Pane((pane) => !pane.canStop, "清理时 Stop 未完成");
      }
    } finally {
      await restoreStopToolResultsFixture();
      await browser.electron.restoreAllMocks();
      await clearAppData();
    }
  });

  for (const { variant, marker, reply } of cases) {
    it(`${variant}: 一个 Read 成功、两个挂起时 Stop，下一轮必须收到全部结果`, async function () {
      this.timeout(150000);
      await skipOccupationOnboardingIfPresent();
      await prepareV4ConversationE2E();
      const toolIds = [1, 2, 3].map((index) => `toolu_stop_results_${variant}_${index}`);
      let sessionId: string | null = null;
      let stopClickedAt: string | null = null;
      try {
        await sendV4Prompt(`${marker}_START: 按序声明三个 Read，等待工具完成。`);
        const running = await waitForV4Pane(
          (pane) => pane.canStop && Boolean(pane.sessionId) && pane.sessionId !== "draft",
          "首轮未启动",
        );
        sessionId = running.sessionId!;
        await waitForStopToolBarrier(sessionId, toolIds);
        stopClickedAt = new Date().toISOString();
        await clickV4Stop();
        await waitForV4Pane((pane) => !pane.canStop, "Stop 未收口工具轮次");
        expect(await getV4QueueItems()).toHaveLength(0);
        const stoppedLogs = await readStopToolLogs(sessionId);
        expect(
          stoppedLogs.filter(
            (record) =>
              record.module === "core.runtime" && record.event === "model.request.started",
          ),
        ).toHaveLength(1);
        // PreToolUse 尚未返回，Read 未进入 call.started，因此不会产生 call.failed 日志。
        // 取消结果的权威证据是下一条真实模型请求中的配对 tool_result。

        await sendV4Prompt(`${marker}_FOLLOWUP: 请继续回复。`);
        // 缺 result 时 SDK 在发 HTTP 之前失败；直接保留原始错误，避免伪装成 fixture miss。
        let missingResultError: string | null = null;
        await browser.waitUntil(
          async () => {
            const logs = await readStopToolLogs(sessionId!);
            const missing = logs.find((record) =>
              JSON.stringify(record).includes("AI_MissingToolResultsError"),
            );
            if (missing) {
              missingResultError = JSON.stringify(missing);
              return true;
            }
            const pane = await getV4PaneSnapshot();
            return !pane.canStop && pane.timelineText.includes(reply);
          },
          { timeout: 45000, timeoutMsg: `${variant} Stop 后下一轮没有正常完成` },
        );
        // waitUntil 会重试回调中的 throw；终态错误在轮询外抛出，避免误归类为 45 秒超时。
        if (missingResultError) throw new Error(`Stop 后历史不完整: ${missingResultError}`);

        const requests = await getUpstreamRequestEvidence({
          lastUserMessageIncludes: [`${marker}_FOLLOWUP`],
          excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.fixtureId).toBe(`stop-results-${variant}-followup`);
        expect(requests[0]!.status).toBe("complete");
        const results = assertPairedResults(requests[0]!.requestJson, toolIds);
        if (variant === "image") {
          expect(results[0]!.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "image",
                source: expect.objectContaining({
                  type: "base64",
                  data: expect.any(String),
                }),
              }),
            ]),
          );
          const image = (
            results[0]!.content as Array<{ type: string; source?: { data: string } }>
          ).find((block) => block.type === "image");
          expect(Buffer.from(image!.source!.data, "base64").length).toBeGreaterThan(0);
        } else expect(JSON.stringify(results[0]!.content)).toContain("STOP_RESULTS_TEXT_READ_OK");
        const completed = (await readStopToolLogs(sessionId)).filter(
          (record) => record.event === "tool.call.completed" && record.toolCallId === toolIds[0],
        );
        expect(completed).toHaveLength(1);
      } finally {
        await writeStopToolEvidence(variant, {
          sessionId,
          stopClickedAt,
          toolIds,
          pane: await getV4PaneSnapshot(),
          logs: sessionId ? await readStopToolLogs(sessionId) : [],
          requests: await getUpstreamRequestEvidence({ includes: [marker] }),
        });
      }
    });
  }

  for (const lockDatabase of [false, true]) {
    it(`database ${lockDatabase ? "locked" : "control"}: 纯文本 Bash 后不 Stop，续聊结果保持配对`, async function () {
      this.timeout(150000);
      await skipOccupationOnboardingIfPresent();
      await prepareV4ConversationE2E();
      await resetTextBashHook();
      const marker = "E2E_STOP_RESULTS_DB";
      const toolId = "toolu_stop_results_db_bash";
      const captureWindow = { afterIndex: (await getUpstreamRequestRecordCount()) - 1 };
      let sessionId: string | null = null;
      let releaseLock: (() => void) | undefined;
      let lockAcquiredAt: string | null = null;
      let lockReleasedAt: string | null = null;
      try {
        await sendV4Prompt(`${marker}_START: 执行一次短文本命令。`);
        const running = await waitForV4Pane(
          (pane) => pane.canStop && Boolean(pane.sessionId) && pane.sessionId !== "draft",
          "Bash 轮次未启动",
        );
        sessionId = running.sessionId!;
        await waitForTextBashBarrier(sessionId, toolId);
        if (lockDatabase) {
          releaseLock = holdToolResultDatabaseWriteLock();
          lockAcquiredAt = new Date().toISOString();
        }
        await releaseTextBashHook();
        if (lockDatabase) {
          // 进入失败收尾后不再保存本批结果；放锁只恢复存储，不直接改写模型历史。
          await browser.waitUntil(
            async () =>
              (await readStopToolLogs(sessionId!)).some(
                (record) =>
                  record.event === "session.event.persistence.started" &&
                  ["turn_error", "turn_complete"].includes(record.context?.sessionEventType ?? ""),
              ),
            { timeout: 45000, timeoutMsg: "写锁未使工具轮次进入失败收尾" },
          );
          releaseLock?.();
          lockReleasedAt = new Date().toISOString();
        }
        await waitForV4Pane((pane) => !pane.canStop, "纯文本 Bash 轮次未结束");
        const logs = await readStopToolLogs(sessionId);
        if (lockDatabase) expect(JSON.stringify(logs)).toContain("database is locked");
        else
          expect((await getV4PaneSnapshot()).timelineText).toContain("STOP_RESULTS_DB_INITIAL_OK");
        expect(await getV4QueueItems()).toHaveLength(0);

        await sendV4Prompt(`${marker}_FOLLOWUP: 继续回复。`);
        let missingResultError: string | null = null;
        await browser.waitUntil(
          async () => {
            const missing = (await readStopToolLogs(sessionId!)).find((record) =>
              JSON.stringify(record).includes("AI_MissingToolResultsError"),
            );
            if (missing) {
              missingResultError = JSON.stringify(missing);
              return true;
            }
            const pane = await getV4PaneSnapshot();
            return !pane.canStop && pane.timelineText.includes("STOP_RESULTS_DB_OK");
          },
          { timeout: 45000, timeoutMsg: "纯文本 Bash 后续聊未完成" },
        );
        if (missingResultError)
          throw new Error(`纯文本数据库故障后历史不完整: ${missingResultError}`);
        const requests = await getUpstreamRequestEvidence(
          {
            lastUserMessageIncludes: [`${marker}_FOLLOWUP`],
            excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
          },
          captureWindow,
        );
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request.fixtureId).toBe("stop-results-db-followup");
        expect(request.status).toBe("complete");
        const results = assertPairedResults(request.requestJson, [toolId]);
        expect(JSON.stringify(results[0]!.content)).toContain("E2E_STOP_RESULTS_DB_OUTPUT");
        expect(results[0]!.is_error === true).toBe(false);
        expect(
          (await readStopToolLogs(sessionId)).filter(
            (record) => record.event === "tool.call.started" && record.toolCallId === toolId,
          ),
        ).toHaveLength(1);
      } finally {
        releaseLock?.();
        await releaseTextBashHook();
        await writeStopToolEvidence(lockDatabase ? "database-locked" : "database-control", {
          sessionId,
          lockAcquiredAt,
          lockReleasedAt,
          toolId,
          pane: await getV4PaneSnapshot(),
          logs: sessionId ? await readStopToolLogs(sessionId) : [],
          requests: await getUpstreamRequestEvidence({ includes: [marker] }, captureWindow),
        });
      }
    });
  }
});

function assertPairedResults(body: unknown, toolIds: string[]) {
  const messages = (body as { messages: Array<{ content: unknown }> }).messages;
  const blocks = messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  ) as Array<{
    type: string;
    id?: string;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
  }>;
  const calls = blocks.filter(
    (block) => block.type === "tool_use" && toolIds.includes(block.id ?? ""),
  );
  const results = blocks.filter(
    (block) => block.type === "tool_result" && toolIds.includes(block.tool_use_id ?? ""),
  );
  expect(calls.map((block) => block.id)).toEqual(toolIds);
  expect(results.map((block) => block.tool_use_id)).toEqual(toolIds);
  if (toolIds.length === 3) {
    expect(results.map((block) => block.is_error === true)).toEqual([false, true, true]);
    // 用户停止时，被取消的工具统一给模型这段固定文字（工具卡片仍显示各自的取消原因）。
    for (const result of results.slice(1))
      expect(JSON.stringify(result.content)).toContain(
        "The user doesn't want to proceed with this tool use.",
      );
  }
  return results;
}
