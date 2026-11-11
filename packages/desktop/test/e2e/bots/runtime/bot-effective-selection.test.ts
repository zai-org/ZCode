import { ZCodeAgentModelSelectionBasisUnsupportedError } from "@zcode/services";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  encodeCustomModelValue,
  type ModelSelection,
} from "@zcode/shared";
import {
  createBotModelSelectionView,
  createBotsServiceHarness,
  createFeishuConfig,
  createRecordingFeishuFetch,
  type RecordedRequest,
  readBotSyntheticFixture,
} from "#e2e/bots/helpers/bots-service-harness";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";

describe("BOT-E2E-SR99 绑定 Session 后的有效选择", () => {
  for (const available of [true, false]) {
    it(`下一条空闲输入使用 Session 原意图：${available ? "可用" : "不可用"}`, async () => {
      const original: ModelSelection = {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        modelId: "GLM-5.3",
        options: { reasoningLevel: "high" },
      };
      const effective = {
        ...original,
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      };
      const parsed: Array<ModelSelection | null | undefined> = [];
      const harness = createBotsServiceHarness({
        config: createFeishuConfig(),
        state: {
          version: 3,
          bots: {
            "feishu-e2e": {
              botId: "feishu-e2e",
              workspacePath: resolveE2ERuntimePath("bots", "e2e-bot-workspace"),
              mode: "task",
              activeTaskId: "task-e2e-bot",
              updatedAt: 1,
            },
          },
        },
        modelSelectionService: {
          getView: async (input) => {
            parsed.push(input?.selection);
            return {
              ...createBotModelSelectionView(),
              preferredSelection: effective,
              effectiveSelection: available ? effective : null,
            };
          },
        },
      });
      harness.zcodeTaskService.getTaskModelSelection = async () => original;
      try {
        const submission = harness.service.handleInboundMessage({
          botId: "feishu-e2e",
          actor: {
            provider: "feishu",
            botId: "feishu-e2e",
            providerUserId: "ou_e2e_user",
            chatType: "private",
          },
          text: "E2E_BOT_SR99_NEXT_INPUT",
        });
        if (available) {
          await submission;
          expect(harness.sendPromptCalls).toEqual([
            expect.objectContaining({ taskId: "task-e2e-bot", modelSelection: effective }),
          ]);
        } else {
          await expect(submission).rejects.toThrow("原选择已保留");
          expect(harness.sendPromptCalls).toHaveLength(0);
        }
        expect(parsed).toEqual([original]);
        expect(harness.createTaskCalls).toHaveLength(0);
        expect(harness.readState().bots["feishu-e2e"]?.draftOptions).toBeUndefined();
        expect(original.providerId).toBe(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan);
      } finally {
        harness.service.disposeAll();
      }
    });
  }
});

describe("BOT-E2E-SR87 有效选择", () => {
  it("主动 /model 保存最高档，但不自动创建任务", async () => {
    const view = createBotModelSelectionView();
    const provider = view.providers[0]!;
    const model = provider.models[0]!;
    const configuredView = {
      ...view,
      providers: [
        {
          ...provider,
          models: [
            {
              ...model,
              config: {
                ...model.config,
                optionSpecs: {
                  ...model.config.optionSpecs,
                  reasoningLevel: {
                    ...model.config.optionSpecs.reasoningLevel,
                    values: ["low", "high", "max"],
                  },
                },
              },
            },
          ],
        },
      ],
    };
    const harness = createBotsServiceHarness({
      config: createFeishuConfig(),
      state: {
        version: 3,
        bots: {
          "feishu-e2e": {
            botId: "feishu-e2e",
            workspacePath: "/workspace/e2e-bot-selection",
            mode: "draft",
            activeTaskId: null,
            updatedAt: 1,
            draftOptions: { provider: "glm" },
          },
        },
      },
      modelSelectionService: { getView: async () => configuredView },
    });
    try {
      await harness.service.handleInboundMessage({
        botId: "feishu-e2e",
        actor: {
          provider: "feishu",
          botId: "feishu-e2e",
          providerUserId: "ou_e2e_user",
          chatType: "private",
        },
        text: `/model ${encodeCustomModelValue(provider.providerId, model.modelId)}`,
      });
      expect(harness.readState().bots["feishu-e2e"]?.draftOptions?.modelSelection).toEqual({
        providerId: provider.providerId,
        modelId: model.modelId,
        options: { reasoningLevel: "max" },
      });
      expect(harness.createTaskCalls).toHaveLength(0);
    } finally {
      harness.service.disposeAll();
    }
  });

  for (const available of [true, false]) {
    it(`菜单和首次派发保留原意图：有效选择${available ? "可用" : "失效"}`, async () => {
      expect(await readBotSyntheticFixture("effective-selection.json")).toMatchObject({
        caseId: "BOT-E2E-SR87",
        classification: "synthetic",
      });
      const original: ModelSelection = {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        modelId: "GLM-5.3",
        options: { reasoningLevel: "high" },
      };
      const effective = {
        ...original,
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      };
      const base = createBotModelSelectionView();
      const provider = base.providers[0]!;
      const model = provider.models[0]!;
      const view = {
        ...base,
        preferredSelection: effective,
        providers: [
          {
            ...provider,
            providerId: effective.providerId,
            config: { ...provider.config, personalModelIds: [effective.modelId] },
            models: [
              {
                ...model,
                modelId: effective.modelId,
                config: {
                  ...model.config,
                  optionSpecs: {
                    ...model.config.optionSpecs,
                    reasoningLevel: {
                      ...model.config.optionSpecs.reasoningLevel!,
                      values: ["low", "high"],
                    },
                  },
                },
              },
            ],
          },
        ],
      };
      const harness = createBotsServiceHarness({
        config: createFeishuConfig(),
        state: {
          version: 3,
          bots: {
            "feishu-e2e": {
              botId: "feishu-e2e",
              workspacePath: "/workspace/e2e-bot-selection",
              mode: "draft",
              activeTaskId: null,
              draftOptions: { provider: "glm", modelSelection: original },
              updatedAt: 1,
            },
          },
        },
        modelSelectionService: {
          getView: async (input) => ({
            ...view,
            ...(input ? { effectiveSelection: available ? effective : null } : {}),
          }),
        },
      });
      const actor = {
        provider: "feishu" as const,
        botId: "feishu-e2e",
        providerUserId: "ou_e2e_user",
        chatType: "private" as const,
      };
      const send = (text: string) =>
        harness.service.handleInboundMessage({ botId: actor.botId, actor, text });
      try {
        const model = await send("/model");
        expect(model[0]?.selection?.currentId ?? null).toBe(
          available ? effective.providerId : null,
        );
        const thought = await send("/think");
        if (available) expect(thought[0]?.selection?.currentId).toBe("high");
        expect(harness.readState().bots[actor.botId]?.draftOptions?.modelSelection).toEqual(
          original,
        );
        if (!available) {
          await send("/think high");
          expect(harness.readState().bots[actor.botId]?.draftOptions?.modelSelection).toEqual(
            original,
          );
        }
        if (available) {
          await send("E2E_BOT_SR87_FIRST_INPUT");
          expect(harness.createTaskCalls).toHaveLength(1);
          expect(harness.createTaskCalls[0]).toMatchObject({ modelSelection: effective });
          expect(harness.sendPromptCalls).toHaveLength(1);
        } else {
          await expect(send("E2E_BOT_SR87_FIRST_INPUT")).rejects.toThrow("模型");
          expect(harness.createTaskCalls).toHaveLength(0);
          expect(harness.sendPromptCalls).toHaveLength(0);
          expect(harness.readState().bots[actor.botId]?.draftOptions?.modelSelection).toEqual(
            original,
          );
        }
      } finally {
        harness.service.disposeAll();
      }
    });
  }
});

describe("BOT-E2E-BASIS-01 旧 CLI 配置依据不降级", () => {
  it("跨 RPC 错误提示升级，不自动重发或创建替代任务", async () => {
    const requests: RecordedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createRecordingFeishuFetch(requests);
    const view = createBotModelSelectionView();
    const selection = view.preferredSelection!;
    const harness = createBotsServiceHarness({
      modelSelectionService: { getView: async () => ({ ...view, effectiveSelection: selection }) },
      config: createFeishuConfig(),
      state: {
        version: 3,
        bots: {
          "feishu-e2e": {
            botId: "feishu-e2e",
            workspacePath: resolveE2ERuntimePath("bots", "e2e-bot-workspace"),
            mode: "task",
            activeTaskId: "task-e2e-bot",
            updatedAt: 1,
          },
        },
      },
    });
    harness.zcodeTaskService.getTaskModelSelection = async () => selection;
    const calls: unknown[] = [];
    harness.zcodeTaskService.sendPrompt = async (params: unknown) => {
      calls.push(params);
      // RPC 还原后不保留原型；验证通过稳定错误身份展示，不依赖 instanceof 子类。
      const source = new ZCodeAgentModelSelectionBasisUnsupportedError();
      throw Object.assign(new Error(source.message), { name: source.name, code: source.code });
    };
    try {
      await harness.service.handleInboundMessage({
        botId: "feishu-e2e",
        text: "E2E_BOT_BASIS_UNSUPPORTED",
        attachments: [
          {
            id: "basis-attachment",
            kind: "image",
            filename: "basis.png",
            mimeType: "image/png",
            dataBase64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=",
          },
        ],
        actor: {
          provider: "feishu",
          botId: "feishu-e2e",
          providerUserId: "ou_e2e_user",
          chatType: "private",
        },
      });
      await browser.waitUntil(() => requests.some((r) => r.body?.includes("升级目标 CLI")), {
        timeout: 10000,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(
        expect.objectContaining({
          modelSelectionBasis: selection,
          attachments: expect.arrayContaining([expect.objectContaining({ filename: "basis.png" })]),
        }),
      );
      expect(harness.createTaskCalls).toHaveLength(0);
      expect(harness.readState().bots["feishu-e2e"]?.activeTaskId).toBe("task-e2e-bot");
    } finally {
      harness.service.disposeAll();
      globalThis.fetch = originalFetch;
    }
  });
});
