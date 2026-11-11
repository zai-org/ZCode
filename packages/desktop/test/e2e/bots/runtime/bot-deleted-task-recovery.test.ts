import { readFile } from "node:fs/promises";
import type { BotsStateFile } from "@zcode/shared";
import {
  createBotsServiceHarness,
  createFeishuCallback,
  createFeishuConfig,
  createRecordingFeishuFetch,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";

const workspacePath = resolveE2ERuntimePath("bots", "e2e-bot-workspace");

describe("BOT-E2E-DT-01 deleted task recovery", () => {
  it("replaces the hidden task and notifies once even if Feishu redelivers the message", async () => {
    const fixture = JSON.parse(
      await readFile(
        // 数据文件位置按当前 spec 计算，fixture 仍在 E2E 根目录下。
        new URL("../../fixtures/bots/bot-deleted-task-recovery.json", import.meta.url),
        "utf8",
      ),
    );
    expect(fixture.classification).toBe("synthetic");
    const requests: RecordedRequest[] = [];
    const broadcasts: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createRecordingFeishuFetch(requests);
    const botId = "feishu-deleted-e2e";
    const state: BotsStateFile = {
      version: 3,
      bots: {
        [botId]: {
          botId,
          workspacePath,
          workspaceId: workspacePath,
          mode: "task",
          activeTaskId: "task-deleted",
          pendingPermissionOptions: [],
          updatedAt: Date.now(),
        },
      },
    };
    const h = createBotsServiceHarness({
      config: createFeishuConfig("feishu", botId),
      state,
      broadcastService: {
        send: async (message) => {
          broadcasts.push(message);
        },
      },
    });
    let deletionReads = 0;
    h.zcodeTaskService.listDeletedTaskIds = async (params: unknown) => {
      expect(params).toEqual({ workspacePath, workspaceIdentity: undefined });
      deletionReads += 1;
      return ["task-deleted"];
    };
    let resumeCalls = 0;
    h.zcodeTaskService.resumeTask = async () => {
      resumeCalls += 1;
      throw new Error("deleted task must not resume");
    };
    try {
      const callback = createFeishuCallback(botId, fixture.promptMarker);
      const result = await h.service.handleProviderCallbackResponse("feishu", callback);
      expect(result.ok).toBe(true);
      const duplicate = await h.service.handleProviderCallbackResponse("feishu", callback);
      expect(duplicate.ok).toBe(true);
      // 订阅恢复与消息准入都会读删除索引；去重契约是下方的新建、派发与通知各一次。
      expect(deletionReads).toBeGreaterThan(0);
      expect(resumeCalls).toBe(0);
      expect(h.createTaskCalls).toHaveLength(1);
      expect(h.sendPromptCalls).toHaveLength(1);
      expect(h.sendPromptCalls[0]).toMatchObject({
        taskId: "task-e2e-bot",
        content: fixture.promptMarker,
      });
      expect(await h.service.getBotStates()).toEqual([
        expect.objectContaining({
          activeTaskId: "task-e2e-bot",
          workspacePath,
          pendingPermissionOptions: undefined,
        }),
      ]);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          channel: "bots:task",
          payload: expect.objectContaining({
            event: "created",
            taskId: "task-e2e-bot",
            workspacePath,
          }),
        }),
      );
      expect(h.subscriptions[0]?.params).toMatchObject({
        taskId: "task-e2e-bot",
        deliveryKind: "bot-channel-continuous",
      });
      const notices = requests.filter(
        (request) => request.method === "POST" && request.body?.includes("原任务已删除"),
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.body).toContain("不会继承原任务的对话上下文");
    } finally {
      h.service.disposeAll();
      globalThis.fetch = originalFetch;
    }
  });
});
