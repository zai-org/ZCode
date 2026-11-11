// 原因：本用例的回放 Provider 只声明 high/max；保留两个不同合法档位验证配置更新与隔离。
import {
  useEnglishSubagentSettings,
  finishSubagentTurn,
  waitForSubagentIdle,
  assertSubagentTurnFailed,
} from "#e2e/helpers/subagent-refresh-conversation";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { saveRefreshProfile, type RefreshProfile } from "#e2e/helpers/subagent-refresh-settings";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
} from "#e2e/helpers/upstream-provider";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  sendV4PromptAndWaitAccepted,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  readSubagentCapture,
  waitForSubagentRequest,
  assertSubagentProfile,
  readChildSessionIds,
  readSubagentId,
  failBoundaryReads,
  boundaryRpcReads,
  assertChildTrajectory,
} from "#e2e/helpers/subagent-refresh-capture";
import {
  assertProviderPrefix,
  assertRequestCacheBreakpoint,
  type CapturedPrompt,
} from "#e2e/helpers/provider-prefix";
import { exportPromptTrajectory } from "#e2e/helpers/prompt-trajectory-export";

const old: RefreshProfile = {
  name: "e2e-context-reviewer",
  description: "Context boundaries",
  prompt: "E2E_SCB_PROFILE_OLD",
  model: UPSTREAM_MODEL,
  provider: UPSTREAM_PROVIDER_ID,
  effort: "high",
  tools: ["Read"],
};
const updated: RefreshProfile = {
  ...old,
  prompt: "E2E_SCB_PROFILE_NEW",
  model: UPSTREAM_ALTERNATE_MODEL,
  provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
  effort: "max",
  tools: ["Grep"],
};
const later: RefreshProfile = { ...old, prompt: "E2E_SCB_PROFILE_LATER" };

describe("Subagent 上下文边界与故障", () => {
  let terminalSession: string;
  let runningSession: string;
  let crossSession: string;
  after(async () => {
    await failBoundaryReads([]);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SHR10-SHR13: running 保留旧配置，读取失败结束父轮，恢复后消息和 retry/resume 正常", async function () {
    this.timeout(360000);
    await prepareV4ConversationE2E();
    await useEnglishSubagentSettings();
    await saveRefreshProfile(old);
    await turn("SEED", `Launch ${old.name} with prompt E2E_SCB_SEED_CHILD.`);
    const parent = (await getV4PaneSnapshot()).sessionId!;
    const terminal = readSubagentId(await waitForSubagentRequest("scb-seed-final"));
    terminalSession = readChildSessionIds(parent)[0]!;
    await turn("RUNNING", `Launch ${old.name} in background with prompt E2E_SCB_RUNNING_CHILD.`);
    const running = readSubagentId(await waitForSubagentRequest("scb-running-final"));
    runningSession = readChildSessionIds(parent).find((id) => id !== terminalSession)!;
    await started("E2E_SCB_RUNNING_CHILD", true);
    await saveRefreshProfile(updated, old.name);
    await failBoundaryReads([parent]);
    try {
      await sendV4Prompt(
        `E2E_SCB_FAIL_TERMINAL: Attempt Agent ${old.name} and SendMessage E2E_SCB_REJECTED to agentId: ${terminal}.`,
      );
      await assertSubagentTurnFailed("E2E_SCB_FAIL_TERMINAL:", "E2E_CONFIG_UNAVAILABLE");
      await sendV4Prompt(
        `E2E_SCB_FAIL_RUNNING: SendMessage E2E_SCB_REJECTED_MESSAGE to agentId: ${running}.`,
      );
      await assertSubagentTurnFailed("E2E_SCB_FAIL_RUNNING:", "E2E_CONFIG_UNAVAILABLE");
      expect(readChildSessionIds(parent)).toEqual([terminalSession, runningSession]);
      expect(
        (await boundaryRpcReads()).filter((r) => r.sessionId === parent && r.failed),
      ).toHaveLength(2);
    } finally {
      await failBoundaryReads([]);
    }
    // 失败轮没有执行 SendMessage；成功重新读取后正常投递，child 继续使用启动时配置。
    await turn("DELIVER_RUNNING", `SendMessage E2E_SCB_DELIVER_RECOVERED to agentId: ${running}.`);
    const recovered = await waitForSubagentRequest("scb-deliver-running-tool");
    for (const marker of ["E2E_SCB_FAIL_TERMINAL:", "E2E_SCB_FAIL_RUNNING:"])
      expect(JSON.stringify(recovered.requestJson).split(marker)).toHaveLength(2);
    // 同一个 running child 跨到成功读取 v2 的父轮；新 child 使用 v2。
    await turn(
      "CROSS",
      `SendMessage E2E_SCB_DELIVER_NEXT and spawn ${old.name} with E2E_SCB_CROSS_CHILD; agentId: ${running}.`,
    );
    assertSubagentProfile(await waitForSubagentRequest("scb-cross-child"), updated);
    crossSession = readChildSessionIds(parent).find(
      (id) => ![terminalSession, runningSession].includes(id),
    )!;
    expect(
      (await readSubagentCapture()).some((r) => r.replay?.fixtureId === "scb-running-message-next"),
    ).toBe(false);
    // 两条引导在 child 的同一个边界按 FIFO 一次取出，合进同一个后续请求。
    const delivered = await waitForSubagentRequest("scb-running-message-next");
    assertSubagentProfile(delivered, old);
    const deliveredBody = JSON.stringify(delivered.requestJson);
    expect(deliveredBody.indexOf("E2E_SCB_DELIVER_RECOVERED")).toBeGreaterThanOrEqual(0);
    expect(deliveredBody.indexOf("E2E_SCB_DELIVER_RECOVERED")).toBeLessThan(
      deliveredBody.indexOf("E2E_SCB_DELIVER_NEXT"),
    );
    expect(deliveredBody).not.toContain("E2E_SCB_REJECTED_MESSAGE");
    await waitForV4AssistantMessageContaining("E2E_SCB_BACKGROUND_NOTED", 120000);
    await idle();
    await turn(
      "RUNNING_RESUME",
      `SendMessage E2E_SCB_RUNNING_RESUME_CHILD to agentId: ${running}.`,
    );
    assertSubagentProfile(await waitForSubagentRequest("scb-running-resume-child"), updated);
    await waitForV4AssistantMessageContaining("E2E_SCB_RUNNING_RESUME_NOTED", 60000);
    await idle();

    // 首次请求延迟后返回 503；保存发生在首次请求与自动重试之前。
    await send("STABLE", `SendMessage E2E_SCB_STABLE_CHILD to agentId: ${terminal}.`);
    await started("E2E_SCB_STABLE:");
    await saveRefreshProfile(later, old.name);
    expect(
      (await readSubagentCapture()).some((r) => r.replay?.fixtureId === "scb-stable-child"),
    ).toBe(false);
    const first = await waitForSubagentRequest("scb-stable-retry");
    expect(first.statusCode).toBe(503);
    const retry = await waitForSubagentRequest("scb-stable-tool");
    expect(retry.requestJson).toEqual(first.requestJson);
    assertSubagentProfile(await waitForSubagentRequest("scb-stable-child"), updated);
    await finish("STABLE");
    await waitForV4AssistantMessageContaining("E2E_SCB_STABLE_NOTED", 60000);
    await idle();
    // 首次 provider 请求到自动重试之间没有新配置 RPC。
    const wire = await boundaryRpcReads();
    expect(
      wire.filter(
        (r) =>
          r.kind === "read" &&
          r.sessionId === parent &&
          r.time > Date.parse(first.startedAt) &&
          r.time <= Date.parse(retry.startedAt),
      ),
    ).toHaveLength(0);
    await turn("NEXT", `SendMessage E2E_SCB_NEXT_CHILD to agentId: ${terminal}.`);
    assertSubagentProfile(await waitForSubagentRequest("scb-next-child"), later);
    await waitForV4AssistantMessageContaining("E2E_SCB_NEXT_NOTED", 60000);
    await idle();
    expect(readChildSessionIds(parent)).toHaveLength(3);
    const bodies = (await readSubagentCapture())
      .filter(
        (r) =>
          r.replay?.fixtureId?.startsWith("scb-") &&
          r.replay?.fixtureId !== "scb-title" &&
          !JSON.stringify((r.requestJson as CapturedPrompt)?.system).includes("E2E_SCB_PROFILE_"),
      )
      .map((r) => r.requestJson as CapturedPrompt);
    for (let index = 1; index < bodies.length; index++)
      assertProviderPrefix(bodies[index - 1]!, bodies[index]!);
    const listing = (body: CapturedPrompt) =>
      body.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter(
          (b) => b.type === "text" && b.text.includes("Available agent types for the Agent tool:"),
        );
    expect(listing(bodies.at(-1)!)).toHaveLength(1);
    expect(JSON.stringify(bodies)).not.toContain(
      "The following agent types are no longer available:",
    );
    const exported = await exportPromptTrajectory(parent, "subagent-boundary-parent");
    expect(exported.trajectories).toHaveLength(1);
    expect(bodies).toHaveLength(19);
    // 一次 503 自动重试产生两次 wire 请求，对应同一条成功的 model-io 请求。
    expect(exported.trajectories[0]?.requestCount).toBe(18);
  });

  it("SHR15: terminal child 保留全部历史与工具配对，配置变化后轨迹仍连续单段", async () => {
    await assertChildTrajectory(terminalSession, [
      "scb-seed-child",
      "scb-seed-child-final",
      "scb-stable-child",
      "scb-next-child",
    ]);
  });

  it("SHR15: running child 在同一边界取出全部消息并在 resume 后保留完整历史", async () => {
    await assertChildTrajectory(runningSession, [
      "scb-running-child",
      "scb-running-message-next",
      "scb-running-resume-child",
    ]);
    await assertChildTrajectory(crossSession, ["scb-cross-child"]);
  });
  it("SHR15: 每个 child provider 请求保留完整对话前缀的缓存 breakpoint", async () => {
    const failures: string[] = [];
    const children = (await readSubagentCapture()).filter((r) =>
      JSON.stringify((r.requestJson as CapturedPrompt)?.system).includes("E2E_SCB_PROFILE_"),
    );
    expect(children).toHaveLength(8);
    for (const record of children) {
      try {
        assertRequestCacheBreakpoint(record.requestJson as CapturedPrompt);
      } catch (error) {
        failures.push(`${record.replay?.fixtureId}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

async function send(stage: string, instruction: string) {
  const marker = `E2E_SCB_${stage}`;
  await sendV4PromptAndWaitAccepted(`${marker}: ${instruction}`, marker, `未接收 ${marker}`);
}
const idle = () => waitForSubagentIdle(120000);
const finish = (stage: string) => finishSubagentTurn(`E2E_SCB_${stage}_DONE`, 120000);
async function turn(stage: string, instruction: string) {
  await send(stage, instruction);
  await finish(stage);
}
async function started(marker: string, child = false) {
  await browser.waitUntil(
    async () =>
      (await readSubagentCapture()).some((r) => {
        const body = r.requestJson as CapturedPrompt | undefined;
        return (
          body &&
          JSON.stringify(body.messages).includes(marker) &&
          (child
            ? JSON.stringify(body.system).includes("E2E_SCB_PROFILE_")
            : !JSON.stringify(body.system).includes("E2E_SCB_PROFILE_")) &&
          !JSON.stringify(body).includes("Generate a concise title")
        );
      }),
    { timeout: 30000, timeoutMsg: `请求未开始 ${marker}` },
  );
}
