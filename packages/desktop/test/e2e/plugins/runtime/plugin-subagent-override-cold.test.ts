import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, readAgentsState } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
} from "#e2e/helpers/upstream-provider";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import { requirePluginManualReview } from "#e2e/helpers/plugin-management-lifecycle";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  prepareV4ConversationE2E,
  switchV4Model,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

// 官方文档插件已拆分；旧 document-skills:judge 不在当前目录，不能验证模型覆盖。
const AGENT_ID = "plugin:documents@zcode-plugins-official:visual-judge";
const PARENT = "E2E_PLUGIN_OVERRIDE_COLD_PARENT";
const CHILD = "E2E_PLUGIN_OVERRIDE_COLD_CHILD";
const RESULT = "E2E_PLUGIN_OVERRIDE_COLD_RESULT";
const FINAL = "plugin-override-cold-done";

describe("PLM-LC-020 插件 Subagent 覆盖冷启动请求", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完整重启后 judge 使用已保存模型/high，父 continuation 保持原模型/max", async () => {
    requirePluginManualReview();
    await prepareV4ConversationE2E({ skipProvider: true });
    const selection = {
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      modelId: UPSTREAM_ALTERNATE_MODEL,
      options: { reasoningLevel: "high" },
    };
    // SE-04 已验证 UI 保存；这里仅构造同格式测试副本，冷启动后不再调用设置服务。
    await writeFile(
      join(resolveE2EStorageRoot(), "v2", "agents-state.json"),
      JSON.stringify({
        ...(await readAgentsState()),
        pluginAgentModelSelectionOverrides: { [AGENT_ID]: selection },
      }),
    );
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    // Recent 是下次创建偏好，不会覆盖现有草稿的 high；实际选择父配置后再验证 child 隔离。
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "max");
    await sendV4PromptAndWaitAccepted(
      `${PARENT}: Use Agent with subagent_type documents:visual-judge, then report its result.`,
      PARENT,
      "插件覆盖冷启动消息未被接受",
    );
    await waitForV4AssistantMessageContaining(FINAL);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "插件执行后未回到 idle",
      30_000,
    );
    expect((await waitForToolCallBlockByToolName("Agent")).status).toBe("completed");

    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH;
    if (!capturePath) throw new Error("缺少插件请求 capture 文件路径");
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
    // 不能只搜整份请求：父 continuation 也包含 child prompt；按最新 user block 的类型区分。
    const child = capture.records.find((record) => latestUserContains(record, "text", CHILD));
    const parent = capture.records.find((record) =>
      latestUserContains(record, "tool_result", RESULT),
    );
    if (!child || !parent) throw new Error("缺少独立 child 或父 tool_result continuation 请求");
    assertUpstreamRequestCapture(child, { expectedText: CHILD, model: UPSTREAM_ALTERNATE_MODEL });
    assertUpstreamThoughtLevelCapture(child, "high");
    assertUpstreamRequestCapture(parent, { expectedText: RESULT, model: UPSTREAM_MODEL });
    assertUpstreamThoughtLevelCapture(parent, "max");
    expect((await readAgentsState()).pluginAgentModelSelectionOverrides).toEqual({
      [AGENT_ID]: selection,
    });
  });
});

function latestUserContains(
  record: E2ENetworkCaptureRecord,
  type: string,
  marker: string,
): boolean {
  if (record.method !== "POST" || record.status !== "complete") return false;
  const request = record.requestJson as { messages?: Array<{ role?: string; content?: unknown }> };
  const content = request?.messages?.findLast((message) => message.role === "user")?.content;
  return (
    Array.isArray(content) &&
    content.some((part) => part?.type === type && JSON.stringify(part).includes(marker))
  );
}
