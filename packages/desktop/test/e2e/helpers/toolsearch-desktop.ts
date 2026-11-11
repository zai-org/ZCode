import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { getE2EAppDataPaths, setInputValueByTestIdDom } from "./desktop-app.js";
import {
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
} from "./model-provider-restart.js";
import { seedPersonalProviderConfig } from "./model-provider-restart-config.js";
import { skipOccupationOnboardingIfPresent } from "./occupation-onboarding.js";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Model,
  waitForV4CompactMarker,
  waitForV4Pane,
} from "./v4-conversation.js";
import {
  readToolSearchRequests,
  toolSearchBlocks,
  TOOLSEARCH_DEFERRED_TOOL,
  TOOLSEARCH_NOTICE,
  type ToolSearchRecord,
} from "./toolsearch-provider.js";

export const TOOLSEARCH_PLAN_PROVIDER = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
export const TOOLSEARCH_PLAIN_PROVIDER = "toolsearch-anthropic-e2e";
export const TOOLSEARCH_MODEL = "GLM-5.3";

export async function setupToolSearchDesktop() {
  // 批量运行可能沿用测试账号；新 profile 的职业引导仍需通过 UI 完成。
  await skipOccupationOnboardingIfPresent();
  await prepareV4ConversationE2E({ skipProvider: true });
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
      await seedBigModelOAuthCredential();
      await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
        id: TOOLSEARCH_PLAIN_PROVIDER,
        label: "ToolSearch Plain Anthropic",
        apiFormat: "anthropic-messages",
        apiKey: "e2e-toolsearch.test-secret",
        baseURL: "https://open.bigmodel.cn/api/anthropic",
        models: [{ id: TOOLSEARCH_MODEL }],
      });
    },
  });
}

export async function newToolSearchTask() {
  // 冷恢复按项目目录读取夹具；全局新建的独立 cwd 不属于该 fixture。
  await prepareV4ConversationE2E({ skipProvider: true });
  await switchV4Model(TOOLSEARCH_PLAN_PROVIDER, TOOLSEARCH_MODEL, "");
}

export async function toolSearchTurn(prompt: string): Promise<ToolSearchRecord[]> {
  const before = (await readToolSearchRequests()).length;
  await sendV4Prompt(prompt);
  await browser.waitUntil(async () => (await readToolSearchRequests()).length > before, {
    timeout: 45_000,
    timeoutMsg: `没有捕获 ${prompt} 的主请求`,
  });
  await waitForV4Pane((s) => !s.canStop, "ToolSearch 轮未结束", 60_000);
  return (await readToolSearchRequests()).slice(before);
}

export async function compactToolSearchTask() {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", { timeout: 15_000 });
  await clickV4Send();
  await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
  await waitForV4Pane((s) => !s.canStop, "compact 未结束", 30_000);
}

export function expectToolSearchLoaded(record: ToolSearchRecord, name = TOOLSEARCH_DEFERRED_TOOL) {
  expect(record.requestJson.tools?.find((tool) => tool.name === name)?.defer_loading).toBe(true);
  expect(record.requestHeaders["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20");
}

export function expectToolSearchUnloaded(
  record: ToolSearchRecord,
  name = TOOLSEARCH_DEFERRED_TOOL,
) {
  expect(record.requestJson.tools?.some((tool) => tool.name === name)).toBe(false);
  expect(record.requestJson.tools?.some((tool) => tool.name === "ToolSearch")).toBe(true);
  expect(JSON.stringify(record.requestJson.messages)).not.toContain(`"tool_name":"${name}"`);
}

export function expectToolSearchDisabled(record: ToolSearchRecord) {
  expect(record.requestJson.tools?.some((tool) => tool.name === "ToolSearch")).toBe(false);
  expect(record.requestJson.tools?.some((tool) => tool.name === TOOLSEARCH_DEFERRED_TOOL)).toBe(
    true,
  );
  expect(record.requestJson.tools?.some((tool) => "defer_loading" in tool)).toBe(false);
  expect(record.requestHeaders["anthropic-beta"] ?? "").not.toContain("advanced-tool-use");
  expect(JSON.stringify(record.requestJson.messages)).not.toContain('"type":"tool_reference"');
  expect(JSON.stringify(record.requestJson.messages)).not.toContain(TOOLSEARCH_NOTICE);
}

export function expectOneToolSearchAnnouncement(record: ToolSearchRecord) {
  expect(JSON.stringify(record.requestJson.messages).split(TOOLSEARCH_NOTICE)).toHaveLength(2);
}

export function expectToolResultPair(record: ToolSearchRecord, id: string) {
  const blocks = toolSearchBlocks(record.requestJson);
  expect(blocks.filter((block) => block.type === "tool_use" && block.id === id)).toHaveLength(1);
  expect(
    blocks.filter((block) => block.type === "tool_result" && block.tool_use_id === id),
  ).toHaveLength(1);
}
