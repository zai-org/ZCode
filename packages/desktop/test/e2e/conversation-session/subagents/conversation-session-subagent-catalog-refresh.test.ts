// 原因：本用例的回放 Provider 只声明 high/max；保留两个不同合法档位验证配置更新与隔离。
import { readMessageTextBlocks } from "#e2e/helpers/subagent-listing-assertions";
import {
  useEnglishSubagentSettings,
  finishSubagentTurn,
} from "#e2e/helpers/subagent-refresh-conversation";
import {
  readSubagentCapture,
  waitForSubagentRequest,
  assertSubagentProfile,
  readChildSessionIds,
  readSubagentId as latestAgentId,
} from "#e2e/helpers/subagent-refresh-capture";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareIncomingMessageCapability } from "#e2e/helpers/incoming-message-capability";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
} from "#e2e/helpers/upstream-provider";
import { exportPromptTrajectory } from "#e2e/helpers/prompt-trajectory-export";
import { assertParentRequestHistory, type CapturedPrompt } from "#e2e/helpers/provider-prefix";
import {
  saveRefreshProfile,
  setRefreshProfileEnabled,
  deleteRefreshProfile,
  type RefreshProfile,
} from "#e2e/helpers/subagent-refresh-settings";
import type { E2ENetworkCaptureRecord } from "#e2e/helpers/network-capture-proxy";
import {
  getV4PaneSnapshot,
  sendV4PromptAndWaitAccepted,
  assertVisibleV4UserMessagesNotContaining,
} from "#e2e/helpers/v4-conversation";

const INITIAL = "Available agent types for the Agent tool:";
const ADDED = "New agent types are now available for the Agent tool:";
const REMOVED = "The following agent types are no longer available:";

describe("Subagent 动态目录与父请求前缀", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  for (const mode of ["user", "mcs"] as const) {
    it(`SHR04-SHR08 ${mode}: 已运行 session 增删更名、启停、完整配置更新，导出单段轨迹`, async function () {
      this.timeout(300000);
      await prepareIncomingMessageCapability(mode === "mcs");
      await useEnglishSubagentSettings();
      const a: RefreshProfile = {
        name: `e2e-refresh-a-${mode}`,
        description: "E2E_SCR_DESCRIPTION_OLD",
        prompt: "E2E_SCR_PROFILE_OLD",
        model: UPSTREAM_MODEL,
        provider: UPSTREAM_PROVIDER_ID,
        effort: "high",
        tools: ["Read"],
      };
      const b = { ...a, name: `e2e-refresh-b-${mode}` };
      const updated: RefreshProfile = {
        ...b,
        description: "E2E_SCR_DESCRIPTION_NEW",
        prompt: "E2E_SCR_PROFILE_NEW",
        model: UPSTREAM_ALTERNATE_MODEL,
        provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
        effort: "max",
        tools: ["Grep"],
      };
      await turn(mode, "seed", "Remember this conversation. Reply with the requested done marker.");
      const sessionId = (await getV4PaneSnapshot()).sessionId!;
      expect(sessionId).not.toBe("draft");
      let manifest: Awaited<ReturnType<typeof exportPromptTrajectory>>;
      try {
        const seed = await record(mode, "seed");
        expect(listings(seed).length).toBe(1);
        expect(JSON.stringify(seed.requestJson)).not.toContain(a.name);

        // SHR04：必须先完成父 turn，再经 Settings 新建，不重启 Host/CLI/session。
        await saveRefreshProfile(a);
        await turn(mode, "add", `Launch ${a.name} with prompt ${marker(mode, "add")}_CHILD.`);
        assertProfile(await record(mode, "add-child"), a);
        const added = await record(mode, "add-final");
        assertListing(added, 2, mode, [ADDED, `- ${a.name}:`]);
        const aId = latestAgentId(added);
        const afterA = children(sessionId);
        expect(afterA).toHaveLength(1);

        // SHR05：同一次父工具批次同时检查旧类型 spawn 与原 agentId 恢复，不能创建空 child。
        await saveRefreshProfile(b, a.name);
        await rejectRemoved(mode, "renamed-old", a, aId, sessionId);
        const renamed = await record(mode, "renamed-old-final");
        assertListing(renamed, 3, mode, [ADDED, `- ${b.name}:`, REMOVED, `- ${a.name}`]);
        expect(children(sessionId)).toEqual(afterA);
        await turn(
          mode,
          "renamed-new",
          `Launch ${b.name} with prompt ${marker(mode, "renamed-new")}_CHILD.`,
        );
        assertProfile(await record(mode, "renamed-new-child"), b);
        expect(children(sessionId)).toHaveLength(2);

        // SHR07：同名变更不能重写旧 listing，也不能把 description 当成需要通知的名称变化。
        await saveRefreshProfile(updated, b.name);
        await turn(mode, "update", `Launch ${b.name} with prompt ${marker(mode, "update")}_CHILD.`);
        assertProfile(await record(mode, "update-child"), updated);
        const updateFinal = await record(mode, "update-final");
        expect(listings(updateFinal)).toEqual(listings(renamed));
        expect(JSON.stringify(listings(updateFinal))).not.toContain(updated.description);
        expect(children(sessionId)).toHaveLength(3);

        // SHR06：禁用与删除都必须通过实际工具结果证明不可调用；重新启用后重新可用。
        await setRefreshProfileEnabled(b.name, false);
        await rejectRemoved(mode, "disabled", b, latestAgentId(updateFinal), sessionId);
        assertListing(await record(mode, "disabled-final"), 4, mode, [REMOVED, `- ${b.name}`]);
        await setRefreshProfileEnabled(b.name, true);
        await turn(
          mode,
          "reenabled",
          `Launch ${b.name} with prompt ${marker(mode, "reenabled")}_CHILD.`,
        );
        assertProfile(await record(mode, "reenabled-child"), updated);
        const reenabled = await record(mode, "reenabled-final");
        assertListing(reenabled, 5, mode, [ADDED, `- ${b.name}:`, updated.description]);
        expect(children(sessionId)).toHaveLength(4);
        await deleteRefreshProfile(b.name);
        await rejectRemoved(mode, "deleted", b, latestAgentId(reenabled), sessionId);
        assertListing(await record(mode, "deleted-final"), 6, mode, [REMOVED, `- ${b.name}`]);
        expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
        for (const heading of [INITIAL, ADDED, REMOVED]) {
          await assertVisibleV4UserMessagesNotContaining(heading);
        }
      } finally {
        // 包括失败运行也保留真实日志和分段结果，不能只留下通过时的截图或最后一条请求。
        manifest = await exportPromptTrajectory(sessionId, `subagent-catalog-${mode}`);
      }
      const requests = (await readSubagentCapture()).filter(
        (r) =>
          r.replay?.fixtureId?.startsWith(`scr-${mode}-`) &&
          !r.replay.fixtureId.endsWith("-child") &&
          !r.replay.fixtureId.endsWith("-title"),
      );
      expect(requests).toHaveLength(15);
      const bodies = requests.map((r) => r.requestJson as CapturedPrompt);
      assertParentRequestHistory(bodies);
      // SHR08：导出工具必须消费全部主请求；只导出最后一条也会有一段，不能据此通过。
      expect(manifest!.trajectories).toHaveLength(1);
      expect(manifest!.trajectories[0]).toMatchObject({
        reason: "initial",
        requestCount: requests.length,
      });
      expect(
        (await readSubagentCapture()).some(
          (r) =>
            JSON.stringify(r.requestJson).includes(marker(mode, "seed")) &&
            JSON.stringify(r.requestJson).includes("CRITICAL: Respond with TEXT ONLY"),
        ),
      ).toBe(false);
    });
  }
});
function marker(mode: string, stage: string) {
  return `E2E_SCR_${mode.toUpperCase()}_${stage.toUpperCase().replaceAll("-", "_")}`;
}
async function turn(mode: string, stage: string, instruction: string) {
  const token = marker(mode, stage);
  await sendV4PromptAndWaitAccepted(`${token}: ${instruction}`, token, `未接收 ${token}`);
  await finishSubagentTurn(`${token}_DONE`, 60000);
}
function listings(record: E2ENetworkCaptureRecord) {
  return readMessageTextBlocks(record.requestJson as CapturedPrompt).filter((block) =>
    [INITIAL, ADDED, REMOVED].some((heading) => block.text.includes(heading)),
  );
}
function assertListing(
  record: E2ENetworkCaptureRecord,
  count: number,
  mode: string,
  contents: string[],
) {
  const list = listings(record);
  expect(list).toHaveLength(count);
  expect(list.at(-1)?.role).toBe(mode === "mcs" ? "system" : "user");
  for (const text of contents) expect(list.at(-1)?.text).toContain(text);
}
function assertProfile(record: E2ENetworkCaptureRecord, profile: RefreshProfile) {
  expect(record.statusCode).toBe(200);
  assertSubagentProfile(record, profile);
}
const children = (sessionId: string) => readChildSessionIds(sessionId, "id");
const record = (mode: string, stage: string) =>
  waitForSubagentRequest(`scr-${mode}-${stage}`, 15000);
async function rejectRemoved(
  mode: string,
  stage: string,
  profile: RefreshProfile,
  agentId: string,
  sessionId: string,
) {
  const before = children(sessionId);
  const beforeCapture = (await readSubagentCapture()).length;
  await turn(
    mode,
    stage,
    `Attempt Agent ${profile.name} and SendMessage to agentId: ${agentId}; report both errors.`,
  );
  const request = (await record(mode, `${stage}-final`)).requestJson as CapturedPrompt;
  const results = request.messages
    .flatMap((m) =>
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content)
          ? m.content
          : [],
    )
    .filter(
      (b) => b.type === "tool_result" && b.tool_use_id.startsWith(`toolu_scr_${mode}_${stage}_`),
    );
  expect(results).toHaveLength(2);
  expect(JSON.stringify(results)).toContain(`Agent type '${profile.name}' not found`);
  expect(JSON.stringify(results)).toContain(`profile ${profile.name} is unavailable`);
  // Agent 使用 is_error；SendMessage 沿用正文错误结果，不能要求两种工具改协议。
  expect(results.find((r) => r.tool_use_id.endsWith("_spawn"))?.is_error).toBe(true);
  // Anthropic 协议、MCS 关时，紧随的提醒并入最后一个 tool_result；错误正文必须在最前面。
  const resumeContent: unknown = results.find((r) => r.tool_use_id.endsWith("_resume"))?.content;
  const resumeText =
    typeof resumeContent === "string"
      ? resumeContent
      : Array.isArray(resumeContent)
        ? resumeContent.map((block: { text?: string }) => block.text ?? "").join("\n")
        : "";
  expect(
    resumeText.startsWith(
      `Cannot resume local agent ${agentId}: profile ${profile.name} is unavailable.`,
    ),
  ).toBe(true);
  expect(children(sessionId)).toEqual(before);
  expect(
    (await readSubagentCapture()).slice(beforeCapture).filter((r) => r.path.includes("/messages")),
  ).toHaveLength(2);
}
