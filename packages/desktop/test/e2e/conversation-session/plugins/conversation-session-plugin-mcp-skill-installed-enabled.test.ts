// 状态 B：插件 MCP skill 已安装并启用。
// 证明：导入/安装并启用 e2e-plugin-mcp-ping 插件后，agent 会
// 1) 把 plugin MCP 工具注册到模型请求 tools 数组；
// 2) 允许模型在真实对话轮次里调它；
// 3) chat 出现对应 tool-call block。
// wdio 启动前已在 <E2E_HOME>/.zcode/cli/plugins/installed_plugins.json 写入带 installPath
// 的记录，并把 config.json#plugins.enabledPlugins[id] 显式置为 true。
// （安装型 plugin 的 defaultEnabled=false，所以必须显式打开才能让
// NodePluginAdapter.resolveEnabled 返回 true。）
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  PLUGIN_MCP_TOOL_NAME,
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
} from "#e2e/helpers/plugin-mcp-skill";

const INSTALLED_ENABLED_TIMEOUT_MS = 180000;

describe("会话区 插件 MCP Skill 生命周期 E2E / 已安装并启用", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("plugin 已安装并启用时：请求 tools 数组含 mcp__plugin_e2e-plugin-mcp-ping_ping__ping，chat 出现对应 tool-call block", async function () {
    this.timeout(INSTALLED_ENABLED_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await startNewV4Draft();
    // 新草稿有独立权限选择，必须在目标草稿上设置，不能沿用上一草稿。
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const marker = `E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED_${runId}`;
    const prompt = `${marker}: Call the ${PLUGIN_MCP_TOOL_NAME} tool exactly once with message "${marker}", then reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "已安装并启用 首发后输入框没有清空");
    await waitForV4UserMessageContaining(prompt);
    await waitForUpstreamRequestContaining(marker, 60000);

    const requestRecord = await findUpstreamRequestContaining(marker, 60000);
    expect(requestRecord).not.toBeNull();
    if (!requestRecord) return;
    // 强证据：模型请求的 tools 数组里必须有 plugin MCP 工具。
    expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(
      true,
    );

    // 快速完成后工具卡片会折叠，复用会展开工作记录的等待器。
    const block = await waitForToolCallBlockByToolName(PLUGIN_MCP_TOOL_NAME, 60000);
    expect(block.exists).toBe(true);
    expect(block.toolName).toBe(PLUGIN_MCP_TOOL_NAME);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "已安装并启用 完成后会话没有回到 idle",
      90000,
    );
  });
});
