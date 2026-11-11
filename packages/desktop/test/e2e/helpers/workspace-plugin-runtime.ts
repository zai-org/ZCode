import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "./conversation-session-tool-cross-product.js";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
  PLUGIN_MCP_PLUGIN_ID,
  PLUGIN_MCP_TOOL_NAME,
} from "./plugin-mcp-skill.js";
import { getE2EAppDataPaths } from "./desktop-app.js";

export async function readWorkspacePluginConfig(): Promise<Record<string, unknown>> {
  const { workspace } = getE2EAppDataPaths();
  return JSON.parse(await readFile(join(workspace, ".zcode", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

export async function readUserPluginConfig(): Promise<Record<string, unknown>> {
  const { storageRoot } = getE2EAppDataPaths();
  return JSON.parse(await readFile(join(storageRoot, "cli", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

export async function assertWorkspacePluginRuntime(marker: string): Promise<void> {
  // 工作区配置位于 fixture 项目；全局新建会切到未归类 cwd，导致验证到另一份插件配置。
  await prepareV4ConversationE2E();
  await ensureToolCrossProductFullAccessMode();
  const prompt = `${marker}: Call ${PLUGIN_MCP_TOOL_NAME} exactly once, then reply with exactly ${E2E_REPLY_TOKEN}.`;
  await sendV4Prompt(prompt);
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000, {
    advertisedToolName: PLUGIN_MCP_TOOL_NAME,
  });
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(
    true,
  );

  // 快速完成的工具会收进工作记录，等待器会展开记录，避免把折叠误判为未执行。
  await waitForToolCallBlockByToolName(PLUGIN_MCP_TOOL_NAME, 60000);
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
}

export async function assertWorkspacePluginUnavailable(marker: string): Promise<void> {
  await prepareV4ConversationE2E();
  await ensureToolCrossProductFullAccessMode();
  const prompt = `${marker}: do not call tools; reply with exactly ${E2E_REPLY_TOKEN}.`;
  await sendV4Prompt(prompt);
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000);
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(
    false,
  );
}

export function pluginConfigOptions(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const options = plugins?.options as Record<string, Record<string, unknown>> | undefined;
  return options?.[PLUGIN_MCP_PLUGIN_ID] ?? {};
}

export function pluginConfigEnabled(config: Record<string, unknown>): boolean | undefined {
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const enabled = plugins?.enabledPlugins as Record<string, boolean> | undefined;
  return enabled?.[PLUGIN_MCP_PLUGIN_ID];
}
