// 原因：本用例的回放 Provider 只声明 high/max；保留两个不同合法档位验证配置更新与隔离。
import {
  useEnglishSubagentSettings,
  finishSubagentTurn,
  waitForSubagentIdle,
} from "#e2e/helpers/subagent-refresh-conversation";
import {
  readSubagentCapture,
  waitForSubagentRequest,
  assertSubagentProfile as assertProfile,
  readSubagentRows as query,
  readChildSessionIds,
  readSubagentId,
} from "#e2e/helpers/subagent-refresh-capture";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  saveRefreshProfile,
  updateRefreshProfileField,
  type RefreshProfile,
} from "#e2e/helpers/subagent-refresh-settings";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "#e2e/helpers/upstream-provider";
import { exportPromptTrajectory } from "#e2e/helpers/prompt-trajectory-export";
import { assertParentRequestHistory, type CapturedPrompt } from "#e2e/helpers/provider-prefix";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const NAME = "e2e-profile-fields";
const ORIGINAL_PROMPT = "E2E_SPF_ORIGINAL_PROMPT";
const UPDATED_PROMPT = "E2E_SPF_UPDATED_PROMPT";

describe("Subagent 单字段更新", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SHR09: 只改 reasoning/prompt/tools，completed child resume 与 spawn 使用新配置", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E();
    await useEnglishSubagentSettings();
    const profile: RefreshProfile = {
      name: NAME,
      description: "Single-field refresh",
      prompt: ORIGINAL_PROMPT,
      provider: UPSTREAM_PROVIDER_ID,
      model: UPSTREAM_MODEL,
      effort: "high",
      tools: ["Read"],
    };
    await saveRefreshProfile(profile);
    await turn("SEED", `Launch ${NAME} with prompt E2E_SPF_SEED_CHILD.`);
    const parent = (await getV4PaneSnapshot()).sessionId!;
    const original = readChildren(parent)[0]!;
    expect(readChildren(parent)).toHaveLength(1);
    const seed = await record("spf-seed-final");
    const agentId = readSubagentId(seed);
    assertProfile(await record("spf-seed-child"), profile);
    let childCount = 1;
    let timelineCount = readHistory(original).filter(
      (p) => p.timelineType === "model_change",
    ).length;
    expect(timelineCount).toBe(1);
    let exported: Awaited<ReturnType<typeof exportPromptTrajectory>>;
    try {
      for (const field of ["effort", "prompt", "tools"] as const) {
        const stage = field.toUpperCase();
        const history = readHistory(original);
        if (field === "effort") profile.effort = "max";
        if (field === "prompt") profile.prompt = UPDATED_PROMPT;
        if (field === "tools") profile.tools = ["Grep"];
        // 只操作对应控件；不重选模型、不重启 session，不直接写文件或 runtime。
        await updateRefreshProfileField(profile, field);
        await turn(
          `${stage}_RESUME`,
          `SendMessage E2E_SPF_${stage}_RESUME_CHILD to agentId: ${agentId}.`,
        );
        await waitForV4AssistantMessageContaining(`E2E_SPF_${stage}_NOTED`, 60000);
        await idle();
        const resumed = await record(`spf-${field}-resume-child`);
        assertProfile(resumed, profile);
        expect(JSON.stringify(resumed.requestJson)).toContain("E2E_SPF_SEED_CHILD");
        expect(JSON.stringify(resumed.requestJson)).toContain(`E2E_SPF_${stage}_RESUME_CHILD`);
        if (field !== "effort")
          expect(JSON.stringify((resumed.requestJson as CapturedPrompt).system)).not.toContain(
            ORIGINAL_PROMPT,
          );
        expect(readChildren(parent)).toHaveLength(childCount);
        const after = readHistory(original);
        // 旧 part 全部按 id/正文保留，不能仅凭两段 marker 宣称历史完整。
        expect(after.filter((p) => history.some((old) => old.id === p.id))).toEqual(history);
        expect(after.filter((p) => p.timelineType === "model_change")).toHaveLength(
          timelineCount + (field === "effort" ? 1 : 0),
        );
        if (field === "effort") {
          timelineCount++;
          expect(after.filter((p) => p.timelineType === "model_change").at(-1)).toMatchObject({
            fromModelSelection: {
              providerId: profile.provider,
              modelId: profile.model,
              options: { reasoningLevel: "high" },
            },
            toModelSelection: {
              providerId: profile.provider,
              modelId: profile.model,
              options: { reasoningLevel: "max" },
            },
          });
        }
        expect(readSelection(original)).toMatchObject({
          providerId: profile.provider,
          modelId: profile.model,
          options: { reasoningLevel: profile.effort },
        });
        const continuation = (await record(`spf-${field}-resume-final`))
          .requestJson as CapturedPrompt;
        const call = continuation.messages
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .find((p) => p.id === `toolu_spf_${field}_resume`);
        expect(call?.input).toMatchObject({ to: agentId });
        await turn(`${stage}_SPAWN`, `Launch ${NAME} with prompt E2E_SPF_${stage}_SPAWN_CHILD.`);
        assertProfile(await record(`spf-${field}-spawn-child`), profile);
        expect(readChildren(parent)).toHaveLength(++childCount);
      }
      expect((await getV4PaneSnapshot()).sessionId).toBe(parent);
      const bodies = (await readSubagentCapture())
        .filter(
          (r) =>
            r.replay?.fixtureId?.startsWith("spf-") &&
            !r.replay.fixtureId.endsWith("-child") &&
            !r.replay.fixtureId.endsWith("-title"),
        )
        .map((r) => r.requestJson as CapturedPrompt);
      expect(bodies).toHaveLength(17);
      assertParentRequestHistory(bodies);
    } finally {
      exported = await exportPromptTrajectory(parent, "subagent-profile-fields-parent");
    }
    expect(exported!.trajectories).toHaveLength(1);
    expect(exported!.trajectories[0]?.requestCount).toBe(17);
  });
});

const idle = () => waitForSubagentIdle(60000);
async function turn(stage: string, instruction: string) {
  const marker = `E2E_SPF_${stage}`;
  await sendV4PromptAndWaitAccepted(`${marker}: ${instruction}`, marker, `未接收 ${marker}`);
  await finishSubagentTurn(`${marker}_DONE`, 60000);
}
function readHistory(child: string): Array<Record<string, unknown>> {
  return query(
    "SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created, id",
    child,
  ).map((r) => ({ id: String(r.id), ...JSON.parse(String(r.data)) }));
}
function readSelection(child: string) {
  return query(
    "SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection'",
    child,
  ).map((r) => JSON.parse(String(r.data)).modelSelection)[0];
}

const record = (id: string) => waitForSubagentRequest(id, 60000);
const readChildren = (parent: string) => readChildSessionIds(parent, "id");
