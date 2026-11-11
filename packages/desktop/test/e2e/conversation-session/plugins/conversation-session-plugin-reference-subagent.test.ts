// PLG16 formal E2E：Plugin 引用的 model-only system reminder 必须把该 Plugin
// 当前 Session 实际加载成功的 canonical Subagent identifier 一并发送给 provider；
// 不得注入 profile 描述、system prompt 或文件路径，也不得把 reminder 显示到时间线。
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  PLUGIN_INLINE_ID,
  PLUGIN_INLINE_SUBAGENT_NAME,
  restartPluginLifecycleApp,
  seedInlineLifecyclePlugin,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_PLUGIN_REFERENCE_SUBAGENT";
const REPLY_MARKER = "PLUGIN_REFERENCE_SUBAGENT_REPLY_OK";
const PLUGIN_REFERENCE_TAG = "<plugin_reference>";

describe("PLG16 Plugin 引用 reminder 包含对应 Subagent", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("provider 收到 live canonical Subagent identifier，UI 与 reminder 均不泄漏 profile 内容", async function () {
    this.timeout(240_000);

    await seedInlineLifecyclePlugin();
    await restartPluginLifecycleApp();
    await prepareV4ConversationE2E();
    await startNewV4Draft();

    const prompt =
      `${PROMPT_MARKER}: use [@${PLUGIN_INLINE_ID}](plugin://${PLUGIN_INLINE_ID}) ` +
      `and reply with exactly ${REPLY_MARKER}.`;
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(REPLY_MARKER, 60_000);
    await waitForV4Pane(
      (state) => !state.canStop && Boolean(state.sessionId && state.sessionId !== "draft"),
      "Plugin Subagent 引用回合没有回到 idle",
      60_000,
    );

    const capture = await waitForUpstreamNetworkCapture(PROMPT_MARKER);
    const reminderMessages = readPluginReminderMessages(capture.requestJson);
    expect(reminderMessages).toHaveLength(1);
    const reminder = reminderMessages[0]!;
    expect(reminder).toContain(PLUGIN_INLINE_ID);
    expect(reminder).toContain(`subagents: ["${PLUGIN_INLINE_SUBAGENT_NAME}"]`);
    expect(reminder).not.toContain("E2E inline Plugin reviewer profile");
    expect(reminder).not.toContain("Review the requested files");
    expect(reminder).not.toContain("inline-reviewer.md");

    const timelineHasReminder = await browser.execute(
      (tag) => (document.body.textContent ?? "").includes(tag),
      PLUGIN_REFERENCE_TAG,
    );
    expect(timelineHasReminder).toBe(false);
  });
});

function readPluginReminderMessages(requestJson: unknown): string[] {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) {
    throw new Error("Plugin Subagent provider request 不是 JSON object");
  }
  const messages = (requestJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    throw new Error("Plugin Subagent provider request 缺少 messages 数组");
  }
  // Provider 会合并相邻 user 文本；其他 reminder 的合法 Subagent catalog 描述
  // 不属于 plugin_reference。只检查该块，仍禁止 profile 内容进入插件引用元数据。
  return messages.flatMap((message) => {
    const content = message?.content;
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((block: { type?: string; text?: string }) =>
              block.type === "text" && typeof block.text === "string" ? [block.text] : [],
            )
          : [];
    return texts.flatMap((text: string) =>
      [...text.matchAll(/<plugin_reference>[\s\S]*?<\/plugin_reference>/g)].map(
        (match) => match[0],
      ),
    );
  });
}
