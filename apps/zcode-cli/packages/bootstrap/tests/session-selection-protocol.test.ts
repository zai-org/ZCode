import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type { ZCodeApp } from "../src/app/types.js";

async function request(server: ZCodeProtocolAgentServer, method: string, params: unknown) {
  const response = await server.handleMessage({ id: 1, method, params } as ZCodeProtocolMessage);
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result;
}

describe("Session 原选择与输入协议", () => {
  it("完整配置命令保留档位，Session read 不用候选名单过滤原选择", async () => {
    let app!: ReturnType<typeof createFakeApp>;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => (app = createFakeApp(options)),
    });
    await request(server, zcodeProtocolMethods.sessionCreate, {
      workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    });
    const setModel = vi.spyOn(app, "setModel");
    const selection = {
      providerId: "glm",
      modelId: "glm-4-air",
      options: { reasoningLevel: "deep" },
    };
    const result = await request(server, zcodeProtocolMethods.sessionSetModel, {
      sessionId: app.sessionId,
      model: selection,
    });
    expect(setModel).toHaveBeenCalledWith(selection);
    expect(result).toMatchObject({ settings: { model: { current: selection } } });
    vi.spyOn(app.runtime, "getSessionModelSelection").mockReturnValue({
      ...selection,
      options: { reasoningLevel: "removed-level" },
    });
    expect(
      await request(server, zcodeProtocolMethods.sessionRead, { sessionId: app.sessionId }),
    ).toMatchObject({
      settings: {
        model: { current: { ...selection, options: { reasoningLevel: "removed-level" } } },
      },
    });
    await request(server, zcodeProtocolMethods.sessionClose, { sessionId: app.sessionId });
  });

  it("旧协议 session/send 的 Selection 不在 Registry 时在接纳前拒绝，不进入 Core 建模", async () => {
    // Bug 根因：带附件的手机远控 / Bot 输入仍走旧协议 session/send，它没有 V4 preflight；
    // 体验套餐到期后 Provider 下架，输入被接纳后才在 Core 以 Registry 内部文案失败。
    // 现在与 V4 共用 model-admission：-32031 + ZCODE_RUNTIME_MODEL_UNAVAILABLE + modelUnavailable。
    let app!: ReturnType<typeof createFakeApp>;
    const sendInput = vi.fn();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => (app = createFakeApp(options, { sendInput })),
    });
    await request(server, zcodeProtocolMethods.sessionCreate, {
      workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    });
    const explicit = await server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.sessionSend,
      params: {
        sessionId: app.sessionId,
        inputId: "stale-explicit",
        content: "hi",
        modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
      },
    } as ZCodeProtocolMessage);
    expect(explicit).toMatchObject({
      error: {
        code: -32031,
        data: { code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE", reasonCode: "modelUnavailable" },
      },
    });
    // 不带 Selection 时按会话常驻选择判定；常驻模型已被下架同样拒绝。
    vi.spyOn(app, "listModels").mockReturnValue([]);
    const resident = await server.handleMessage({
      id: 3,
      method: zcodeProtocolMethods.sessionSend,
      params: { sessionId: app.sessionId, inputId: "stale-resident", content: "hi" },
    } as ZCodeProtocolMessage);
    expect(resident).toMatchObject({
      error: { code: -32031, data: { reasonCode: "modelUnavailable" } },
    });
    expect(sendInput).not.toHaveBeenCalled();
    await request(server, zcodeProtocolMethods.sessionClose, { sessionId: app.sessionId });
  });

  it("旧协议 session/goal 的 set / replace / resume 在会话模型失效时先拒绝，不写目标、不续跑", async () => {
    // Bug 根因：模型准入曾放在续跑阶段，目标已写入 / 已改成 active 后才以 modelUnavailable 失败，
    // 调用方按失败处理而目标状态已变化、也不再广播。现在准入先于任何目标写入。
    let app!: ReturnType<typeof createFakeApp>;
    let target: Awaited<ReturnType<ZCodeApp["readTarget"]>> = null;
    const continueActiveTarget = vi.fn(async () => null);
    const setTarget = vi.fn(async (input: { objective: string; status?: string }) => {
      target = {
        objective: input.objective,
        sessionID: app.sessionId,
        status: (input.status ?? "active") as never,
        summaryTitle: null,
        targetID: "goal_1" as never,
        time: { created: 1, updated: 2 },
        tokenBudget: undefined,
        tokensUsed: 0,
      } as never;
      return target!;
    });
    const updateTargetStatus = vi.fn(async (status: string) => {
      if (!target) return null;
      target = { ...target, status } as never;
      return target;
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) =>
        (app = createFakeApp(options, {
          continueActiveTarget,
          readTarget: async () => target,
          setTarget: setTarget as never,
          updateTargetStatus: updateTargetStatus as never,
        })),
    });
    await request(server, zcodeProtocolMethods.sessionCreate, {
      workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    });
    const listModels = vi.spyOn(app, "listModels").mockReturnValue([]);
    const rejected = { error: { code: -32031, data: { reasonCode: "modelUnavailable" } } };

    // set：目标不得被写入。
    expect(
      await server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.sessionGoal,
        params: { sessionId: app.sessionId, action: "set", objective: "ship it" },
      } as ZCodeProtocolMessage),
    ).toMatchObject(rejected);
    expect(setTarget).not.toHaveBeenCalled();
    expect(target).toBeNull();

    // resume：已暂停的目标不得被改成 active。
    target = {
      objective: "paused goal",
      sessionID: app.sessionId,
      status: "paused",
      summaryTitle: null,
      targetID: "goal_0",
      time: { created: 1, updated: 1 },
      tokenBudget: undefined,
      tokensUsed: 0,
    } as never;
    expect(
      await server.handleMessage({
        id: 3,
        method: zcodeProtocolMethods.sessionGoal,
        params: { sessionId: app.sessionId, action: "resume" },
      } as ZCodeProtocolMessage),
    ).toMatchObject(rejected);
    expect(updateTargetStatus).not.toHaveBeenCalled();
    expect(target).toMatchObject({ status: "paused" });

    // replace：同样不得覆盖现有目标。
    expect(
      await server.handleMessage({
        id: 4,
        method: zcodeProtocolMethods.sessionGoal,
        params: { sessionId: app.sessionId, action: "replace", objective: "new goal" },
      } as ZCodeProtocolMessage),
    ).toMatchObject(rejected);
    expect(setTarget).not.toHaveBeenCalled();
    expect(target).toMatchObject({ objective: "paused goal", status: "paused" });
    expect(continueActiveTarget).not.toHaveBeenCalled();

    // 模型重新可用后同一命令成功：resume 改成 active 并续跑。
    listModels.mockRestore();
    const resumed = await request(server, zcodeProtocolMethods.sessionGoal, {
      sessionId: app.sessionId,
      action: "resume",
      inputId: "goal_resume_ok",
    });
    expect(resumed).toMatchObject({ startedTurn: true });
    expect(updateTargetStatus).toHaveBeenCalledWith("active");
    await vi.waitFor(() =>
      expect(continueActiveTarget).toHaveBeenCalledWith(
        expect.objectContaining({ inputId: "goal_resume_ok" }),
      ),
    );
    await request(server, zcodeProtocolMethods.sessionClose, { sessionId: app.sessionId });
  });

  it("附件 Selection 进入同一个 input intent，执行凭据只进入非持久执行依赖", async () => {
    let app!: ReturnType<typeof createFakeApp>;
    let finish!: (value: never) => void;
    const completion = new Promise<never>((resolve) => {
      finish = resolve;
    });
    const sendInput = vi.fn(async () => ({
      kind: "started_turn" as const,
      turnId: "turn" as never,
      completion,
    }));
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => (app = createFakeApp(options, { sendInput })),
    });
    await request(server, zcodeProtocolMethods.sessionCreate, {
      workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    });
    const selection = {
      providerId: "account:offpeak",
      modelId: "fixture-model",
      options: { reasoningLevel: "high" },
    };
    // 旧协议 session/send 现在与 V4 共用模型准入；执行模型必须在 Worker Registry 中才会被接纳。
    vi.spyOn(app, "listModels").mockReturnValue([
      ...app.listModels(),
      { ref: { providerId: selection.providerId, modelId: selection.modelId } } as never,
    ]);
    await request(server, zcodeProtocolMethods.sessionSend, {
      sessionId: app.sessionId,
      inputId: "attachment-input",
      content: "hi",
      attachments: [
        { kind: "image", filename: "a.png", mimeType: "image/png", dataBase64: "aGk=" },
      ],
      modelSelection: selection,
      modelExecution: {
        selectionScope: "execution",
        memoryExtraction: "skip",
        requestAuth: { headers: { "x-ticket": "fixture" } },
      },
    });
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalled());
    const [input, options] = sendInput.mock.calls[0]! as unknown as Parameters<
      typeof app.sendInput
    >;
    expect(input).toMatchObject({
      text: "hi",
      attachments: [expect.objectContaining({ type: "image" })],
    });
    expect(options).toMatchObject({
      inputId: "attachment-input",
      intent: { modelSelection: selection },
      modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
    });
    expect(JSON.stringify(options?.intent)).not.toContain("x-ticket");
    expect(
      await options?.modelExecution?.requestDependencies?.requestAuth?.source.resolve({} as never),
    ).toEqual({ headers: { "x-ticket": "fixture" } });
    expect(app.runtime.getSessionModelSelection()?.providerId).toBe("glm");
    try {
      const next = await server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: { sessionId: app.sessionId, content: "next" },
      });
      expect(next).toMatchObject({ error: { code: -32010 } });
      expect(sendInput).toHaveBeenCalledTimes(1);
    } finally {
      finish({} as never);
    }
    await request(server, zcodeProtocolMethods.sessionClose, { sessionId: app.sessionId });
  });
});
