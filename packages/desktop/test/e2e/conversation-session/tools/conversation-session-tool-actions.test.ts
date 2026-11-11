import { mkdir, rm, writeFile } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  expandAssistantHistoriesWithContent,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";

const TOOL_ACTION_RUNTIME_ROOT = resolveE2ERuntimePath("conversation-session-tool-actions");
const TOOL_FILE_PATH = resolveE2EToolPath(
  "conversation-session-tool-actions",
  "tool-action-guard.txt",
);

describe("会话区 Tool Action Guard E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(TOOL_ACTION_RUNTIME_ROOT, { force: true, recursive: true });
    await clearAppData();
  });

  it("tool call block 不应提供 edit 或 fork 入口", async function () {
    this.timeout(160000);

    const runId = Date.now();
    await mkdir(TOOL_ACTION_RUNTIME_ROOT, { recursive: true });
    await writeFile(TOOL_FILE_PATH, `E2E_TOOL_FILE_CONTENT_${runId}\n`, "utf-8");

    await prepareV4ConversationE2E();

    const prompt = `E2E_TOOL_ACTION_GUARD_${runId}: Read ${TOOL_FILE_PATH}, then reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "tool action guard 首发后输入框没有清空");
    await waitForV4UserMessageContaining(`E2E_TOOL_ACTION_GUARD_${runId}`);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "tool action guard 完成后会话没有回到 idle",
      90000,
    );
    // V4 将工具历史与最终正文分开；不能按正文查找旧 assistant 容器。
    await expandAssistantHistoriesWithContent();

    const toolBlock = await waitForToolCallBlockByToolName("Read");
    expect(toolBlock.exists).toBe(true);
    // 修复原因：线上 provider 会动态生成 toolCallId，Read 工具也可能被 UI
    // 聚合成带 explore 后缀的 block；tool action guard 的稳定合同是工具块本身
    // 不暴露消息级 edit/fork 入口，不能依赖固定 id。
    expect(toolBlock.toolCallId).toBeTruthy();
    expect(toolBlock.toolName).toBe("Read");
    expect(toolBlock.status).toBe("completed");
    expect(toolBlock.hasEditAction).toBe(false);
    expect(toolBlock.hasForkAction).toBe(false);
  });
});
