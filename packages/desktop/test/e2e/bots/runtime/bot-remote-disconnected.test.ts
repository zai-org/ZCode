import type { BotsConfigFile, BotsStateFile } from "@zcode/shared";

import {
  createBotsServiceHarness,
  readBotSyntheticFixture,
} from "#e2e/bots/helpers/bots-service-harness";

describe("Bot remote workspace delivery E2E", () => {
  it("BOT-E2E-RW-01 rejects a disconnected remote workspace without reconnect or local fallback", async () => {
    const fixture = await readBotSyntheticFixture("remote-workspace-disconnected.json");
    expect(fixture).toMatchObject({ caseId: "BOT-E2E-RW-01", classification: "synthetic" });
    expect(fixture.syntheticReason.length).toBeGreaterThan(20);
    const config: BotsConfigFile = {
      version: 3,
      bots: [
        {
          id: "webhook-e2e",
          name: "Webhook E2E",
          provider: "webhook",
          enabled: true,
          webhookSecretRef: "webhook-secret-e2e",
          providerUserId: "user-e2e",
          allowedWorkspaces: ["*"],
          allowedCommands: {
            status: true,
            new: true,
            workspace: true,
            model: true,
            thoughtLevel: true,
            sandboxMode: true,
            approvalPolicy: true,
            reply: true,
          },
          currentOptions: {},
          replyMode: "assistant_changes",
        },
      ],
    };
    const state: BotsStateFile = {
      version: 3,
      bots: {
        "webhook-e2e": {
          botId: "webhook-e2e",
          workspacePath: "/workspace",
          workspaceIdentity: "remote:server:e2e-host:/workspace",
          workspaceId: "remote:server:e2e-host:/workspace",
          mode: "task",
          activeTaskId: "task-remote-e2e",
          updatedAt: Date.now(),
        },
      },
    };
    let isConnectedCalls = 0;
    let ensureConnectedCalls = 0;
    let remoteTaskServiceCalls = 0;
    const harness = createBotsServiceHarness({
      config,
      state,
      projectWorkspaces: [
        {
          kind: "remote",
          workspacePath: "/workspace",
          workspaceIdentity: "remote:server:e2e-host:/workspace",
          remoteSessionId: "remote-session-e2e",
        },
      ],
      remoteWorkspaceService: {
        isConnected: async (target: unknown) => {
          isConnectedCalls += 1;
          expect(target).toEqual({
            hostId: "remote:server:e2e-host",
            workspacePath: "/workspace",
            workspaceIdentity: "remote:server:e2e-host:/workspace",
          });
          return false;
        },
        ensureConnected: async () => {
          ensureConnectedCalls += 1;
          return { ok: true };
        },
        getZCodeTaskService: async () => {
          remoteTaskServiceCalls += 1;
          return harness.zcodeTaskService;
        },
      },
    });
    try {
      const replies = await harness.service.handleInboundMessage({
        botId: "webhook-e2e",
        text: "E2E_BOT_REMOTE_DISCONNECTED 请检查当前项目",
        actor: {
          provider: "webhook",
          botId: "webhook-e2e",
          providerUserId: "user-e2e",
          chatType: "private",
        },
      });
      expect(replies.map((reply) => reply.text)).toEqual([
        "当前远端项目 /workspace 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。",
      ]);
      expect(isConnectedCalls).toBe(1);
      expect(ensureConnectedCalls).toBe(0);
      expect(remoteTaskServiceCalls).toBe(0);
      expect(harness.createTaskCalls).toEqual([]);
      expect(harness.sendPromptCalls).toEqual([]);
    } finally {
      harness.service.disposeAll();
    }
  });
});
