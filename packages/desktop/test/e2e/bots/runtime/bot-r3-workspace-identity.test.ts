import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type IZCodeTaskService, type ISettingService } from "@zcode/services";
import {
  appSettingsSchema,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  type BotsConfigFile,
} from "@zcode/shared";
import { createBotProjectRuntime } from "../../../../../services/src/bot-project-runtime/index.js";
import { SourceServerDirectory } from "#src/host/sourceServerDirectory.js";
import { resolveBotRemoteWorkspace } from "#src/host/botRemoteWorkspaceResolver.js";
import { createWindowRemoteConnectionRegistry } from "#src/host/windowRemoteConnectionRegistry.js";
import {
  createBotModelSelectionView,
  createBotsServiceHarness,
  readBotSyntheticFixture,
} from "#e2e/bots/helpers/bots-service-harness";

it("BOT-E2E-RW-02 legacy 与 stable Bot 通过同一 Source 身份完成任务路由", async () => {
  expect(await readBotSyntheticFixture("r3-workspace-identity.json")).toMatchObject({
    caseId: "BOT-E2E-RW-02",
    classification: "synthetic",
  });
  const path = "/work/bot";
  const target = { kind: "ssh" as const, host: "synthetic.invalid", username: "dev" };
  const stable = buildServerRemoteWorkspaceIdentity({
    serverId: "a1111111-1111-4111-8111-111111111111",
    workspacePath: path,
  });
  const legacy = buildRemoteWorkspaceIdentity(path, target);
  let settings = appSettingsSchema.parse({
    sourceServerDirectoryMigrationVersion: 1,
    sourceServers: [
      {
        sourceServerId: "a1111111-1111-4111-8111-111111111111",
        displayName: "Synthetic Source",
        preferredProfileId: "b2222222-2222-4222-8222-222222222222",
      },
    ],
    connectionProfiles: [
      {
        profileId: "b2222222-2222-4222-8222-222222222222",
        sourceServerId: "a1111111-1111-4111-8111-111111111111",
        transport: "ssh",
        target,
        createdAt: 1,
      },
    ],
    lastWorkspaceSession: [
      {
        kind: "remote",
        workspacePath: path,
        workspaceIdentity: legacy,
        target,
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
      },
    ],
  });
  const settingService: ISettingService = {
    get: async () => settings,
    update: async (patch) => {
      settings = appSettingsSchema.parse({ ...settings, ...patch });
    },
    updateDataBaseDir: async () => {},
    getUserInstructions: async () => ({ content: "", filePath: "" }),
    saveUserInstructions: async () => ({ filePath: "" }),
  };
  const credentials = {
    load: async () => null,
    save: async () => {},
    delete: async () => {},
    inspectStore: async () => ({ status: "healthy" as const }),
    recoverStore: async () => ({ status: "changed" as const }),
  };
  const directory = new SourceServerDirectory({ settingService, credentialService: credentials });
  let connections = 0;
  const registry = createWindowRemoteConnectionRegistry({
    createId: () => "session-e2e",
    resolveSourceServerId: () => "a1111111-1111-4111-8111-111111111111",
    connect: async () => {
      connections += 1;
      return { services: {}, dispose() {} };
    },
  });
  await registry.connect({
    requestId: "connect-e2e",
    target,
    remoteAssets: {},
    workspacePath: path,
    workspaceIdentity: stable,
  });
  const remoteCalls: unknown[] = [];
  const remoteScopes: unknown[] = [];
  let onRemotePrompt: (() => void) | undefined;
  const view = createBotModelSelectionView();
  const selected = view.preferredSelection!;
  const taskService = {
    resumeTask: async () => ({
      taskId: "remote-task",
      title: "Remote task",
      workspacePath: path,
      workspaceIdentity: stable,
      provider: "glm",
    }),
    listTasks: async () => [
      {
        taskId: "remote-task",
        title: "Remote task",
        workspacePath: path,
        workspaceIdentity: stable,
        provider: "glm",
      },
    ],
    listDeletedTaskIds: async (input: unknown) => {
      remoteScopes.push(input);
      return [];
    },
    getTaskModelSelection: async () => selected,
    getTaskConfigOptions: async () => [],
    getTaskSnapshot: async () => null,
    sendPrompt: async (input: unknown) => {
      remoteCalls.push(input);
      onRemotePrompt?.();
    },
    onDynamicTaskEvent: () => () => ({ dispose() {} }),
    onDynamicStreamEvent: () => () => ({ dispose() {} }),
  };
  const hostId = "remote:server:a1111111-1111-4111-8111-111111111111";
  const projectSelection = JSON.stringify([hostId, "e2e-project-0"]);
  const bound: string[] = [];
  const connection = {
    owner: {},
    taskService: taskService as unknown as IZCodeTaskService,
    modelSelectionService: { getView: async () => ({ ...view, effectiveSelection: selected }) },
    agentService: { syncAppRuntimePreferences: async () => {} },
    bindWorkspace: async (workspace: { workspaceIdentity: string }) => {
      bound.push(workspace.workspaceIdentity);
    },
  };
  const bridge = {
    ...createBotProjectRuntime({
      remoteProjectService: {
        readDirectory: async () => ({
          hosts: [{ id: hostId, membershipId: "m", kind: "ssh", target, position: 0 }],
          entries: [],
        }),
        connectHost: async () => {
          throw new Error("ordinary Bot input must not create a connection");
        },
      },
      resolveOnline: (id) => (id === hostId ? connection : undefined),
      onConnectionsChanged: () => ({ dispose() {} }),
      readBoundTargets: async () => [],
      readRuntimePreferences: async () => ({ askUserQuestionAutoResolutionEnabled: false }),
      warn: () => {},
    }),
    resolveWorkspace: (workspace: { workspacePath: string; workspaceIdentity: string }) =>
      resolveBotRemoteWorkspace(workspace, "lookup", {
        directory,
        listSessions: () => registry.listSessions(),
      }),
  };
  try {
    for (const identity of [legacy, stable]) {
      const delivered = new Promise<void>((resolve) => {
        onRemotePrompt = resolve;
      });
      const config: BotsConfigFile = {
        version: 3,
        bots: [
          {
            id: "webhook-e2e",
            name: "Synthetic",
            provider: "webhook",
            enabled: true,
            providerUserId: "user-e2e",
            webhookSecretRef: "synthetic",
            allowedWorkspaces: [legacy],
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
      const harness = createBotsServiceHarness({
        config,
        remoteWorkspaceService: bridge,
        projectWorkspaces: [{ kind: "remote", workspacePath: path, workspaceIdentity: stable }],
        state: {
          version: 3,
          bots: {
            "webhook-e2e": {
              botId: "webhook-e2e",
              // hostId 是已迁移上下文的标记；旧身份夹具不能同时伪造新版字段而跳过迁移。
              ...(identity === legacy ? {} : { projectId: "e2e-project-0", hostId }),
              workspacePath: path,
              workspaceIdentity: identity,
              workspaceId: identity === legacy ? legacy : projectSelection,
              mode: "task",
              activeTaskId: "remote-task",
              updatedAt: 1,
            },
          },
        },
      });
      try {
        const replies = await harness.service.handleInboundMessage({
          botId: "webhook-e2e",
          actor: {
            provider: "webhook",
            botId: "webhook-e2e",
            providerUserId: "user-e2e",
            chatType: "private",
          },
          text: "E2E_BOT_R3_IDENTITY 检查项目",
        });
        expect(replies.map((reply) => reply.text ?? "").join("\n")).not.toMatch(
          /未连接|已不在授权范围/u,
        );
        let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            delivered,
            new Promise<never>((_resolve, reject) => {
              deliveryTimer = setTimeout(
                () => reject(new Error(`E2E_BOT_R3_IDENTITY: ${identity} 没有投递到远端 runtime`)),
                15_000,
              );
            }),
          ]);
        } finally {
          if (deliveryTimer) clearTimeout(deliveryTimer);
        }
        expect(harness.sendPromptCalls).toEqual([]);
        expect(harness.createTaskCalls).toEqual([]);
        expect(harness.readState().bots["webhook-e2e"]?.workspaceIdentity).toBe(stable);
        // 授权键属于项目选择，workspaceIdentity 才是规范化后的执行身份。
        expect((await harness.service.getConfig()).bots[0]!.allowedWorkspaces).toEqual([
          projectSelection,
        ]);
        expect(harness.readState().bots["webhook-e2e"]).toMatchObject({
          hostId,
          projectId: "e2e-project-0",
          workspaceId: projectSelection,
        });
      } finally {
        await harness.service.disposeAllAndWait();
      }
    }
    expect(remoteCalls).toHaveLength(2);
    for (const call of remoteCalls) expect(call).toMatchObject({ taskId: "remote-task" });
    expect(remoteScopes).toHaveLength(2);
    for (const scope of remoteScopes)
      expect(scope).toMatchObject({ workspacePath: path, workspaceIdentity: stable });
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every((identity) => identity === stable)).toBe(true);
    expect(connections).toBe(1);
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/bot-r3-workspace-identity",
    );
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "bot-identity.json"),
      JSON.stringify(
        {
          caseId: "BOT-E2E-RW-02",
          synthetic: true,
          stable,
          legacy,
          remotePrompts: remoteCalls.length,
          sharedHostBindings: bound.length,
          connections,
          localPrompts: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await registry.dispose();
  }
});
