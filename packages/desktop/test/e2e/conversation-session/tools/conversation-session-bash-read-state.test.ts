import {
  expandAssistantHistoriesWithContent,
  expandVisibleSummaryGroups,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
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
  countUpstreamRequests,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  listToolCallBlocks,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "bash-read-state-e2e");
const TARGET_RELATIVE_PATH = "bash-read-state-e2e/target.txt";
const FORMATTER_RELATIVE_PATH = "bash-read-state-e2e/overwrite-target.mjs";
const TARGET_PATH = join(DEFAULT_WORKSPACE, TARGET_RELATIVE_PATH);
const FORMATTER_PATH = join(DEFAULT_WORKSPACE, FORMATTER_RELATIVE_PATH);
const INITIAL_CONTENT = "alpha\nbeta\n";
const FORMATTED_CONTENT = "delta\nbeta\n";
const STALE_HINT = "Call Read before editing";
const NOT_READ_ERROR = "File has not been read yet. Read it first before writing to it.";

describe("会话区 Bash read-state E2E", () => {
  afterEach(async () => {
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(CASE_ROOT, { recursive: true, force: true });
    await clearAppData();
  });

  it("Bash cat 应允许后续 Edit，并在 formatter Bash 后向模型暴露 stale hint", async function () {
    this.timeout(180000);

    const runId = Date.now();
    const marker = `E2E_BASH_READ_STATE_${runId}`;
    await writeFixtures();
    await prepareV4ConversationE2E();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await ensureToolCrossProductFullAccessMode();

    const prompt = buildPrompt(marker);
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "Bash read-state 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);
    await waitForUpstreamRequestContaining(marker, 60000);

    await waitForToolCallBlockByToolName("Bash", 90000);
    await waitForToolCallBlockByToolName("Edit", 90000);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Bash read-state 工具链没有回到 idle",
      120000,
    );

    // 完成后历史和工具组默认收起；先展开真实内容，再逐条检查 Bash/Edit。
    await expandAssistantHistoriesWithContent();
    await browser.waitUntil(
      async () => {
        await expandVisibleSummaryGroups();
        return (
          (await listToolCallBlocks()).filter((block) => block.toolName === "Bash").length === 2
        );
      },
      { timeout: 15000, timeoutMsg: "Bash 历史未展开" },
    );
    const toolBlocks = await listToolCallBlocks();
    expect(toolBlocks.filter((block) => block.toolName === "Bash").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(toolBlocks.some((block) => block.toolName === "Edit")).toBe(true);
    expect(await readFile(TARGET_PATH, "utf-8")).toBe(FORMATTED_CONTENT);
    expect(await countUpstreamRequests({ includes: [STALE_HINT] })).toBeGreaterThan(0);
    expect(await countUpstreamRequests({ includes: [NOT_READ_ERROR] })).toBe(0);
  });
});

function buildPrompt(marker: string) {
  return [
    `${marker}: Follow these tool steps exactly.`,
    `1. Use Bash with exactly this command: cat ${TARGET_RELATIVE_PATH}`,
    `2. Use Edit on ${TARGET_PATH}; replace exactly "alpha" with "gamma".`,
    `3. Use Bash with exactly this command: node ${FORMATTER_RELATIVE_PATH} --fix`,
    `4. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    "Do not use the Read tool in this case.",
  ].join(" ");
}

async function writeFixtures() {
  await mkdir(CASE_ROOT, { recursive: true });
  await writeFile(TARGET_PATH, INITIAL_CONTENT, "utf-8");
  await writeFile(
    FORMATTER_PATH,
    [
      "import { writeFile } from 'node:fs/promises';",
      "await new Promise((resolve) => setTimeout(resolve, 30));",
      `await writeFile(${JSON.stringify(TARGET_PATH)}, ${JSON.stringify(FORMATTED_CONTENT)});`,
      "console.log('formatted target');",
      "",
    ].join("\n"),
    "utf-8",
  );
}
