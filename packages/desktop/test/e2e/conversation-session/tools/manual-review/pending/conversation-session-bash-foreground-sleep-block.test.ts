// Z03 前台长 sleep 拦截（docs/conversation-session-case-catalog.md「Z」分组）。规格见
// apps/zcode-cli/docs/design/v2/tool/04-bash.md「前台 sleep 拦截」与「Prompt 约束」末尾的描述三处文字。
// 断言读上游请求体：首个请求的 Bash 描述、live continuation 与完整 CLI cold restart 后的 error tool_result。
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestToolContract,
} from "#e2e/helpers/conversation-session-network";
import {
  expandToolCallDetails,
  waitForFoldedToolCallBlockByToolCallId,
} from "#e2e/helpers/conversation-session-tool";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_BASH_SLEEP_BLOCK";
const COLD_PROMPT_MARKER = "E2E_BASH_SLEEP_BLOCK_COLD_REPLAY";
const LIVE_DONE = "E2E_BASH_SLEEP_BLOCK_LIVE_OK";
const COLD_DONE = "E2E_BASH_SLEEP_BLOCK_COLD_OK";
const TOOL_CALL_ID = "toolu_e2e_bash_sleep_block";
const BLOCKED =
  "Blocked: sleep 30 followed by: echo E2E_BASH_SLEEP_BLOCK_RAN. To wait for a condition, run an until-loop with run_in_background: true (e.g. `until <check>; do sleep 2; done`); you are notified when it exits. To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.";
const TOOL_RESULT = `<tool_use_error>${BLOCKED}</tool_use_error>`;
const DESCRIPTION_LINES = [
  "\n- `cd` carries to the next call only in the main session, if the command succeeds and ends inside the working directories. Outside them the shell returns to the start folder; otherwise it stays where it was.",
  "No `&` needed. Foreground `sleep` of 25 seconds or more is blocked; to wait on a condition, run an until-loop with `run_in_background`.\n",
  "\n- Use the `gh` CLI for GitHub operations (PRs, issues, API).\n- GitHub notifies the owner of any `@name` written in a PR, issue, or comment.",
];

describe("Z03 前台长 sleep 拦截 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("前台 sleep 30 在执行前被拒绝：工具卡显示原因，live 与 cold replay 的 error tool_result 相同", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = `${PROMPT_MARKER}_${runId}: wait for the build with the sleep fixture.`;
    await sendV4Prompt(prompt);
    await waitForUpstreamNetworkCapture(prompt);

    // 描述三处文字随 tools 段发出；旧的 cd 行不再出现。
    const bash = (await getUpstreamRequestToolContract(
      { lastUserMessageIncludes: [`${PROMPT_MARKER}_${runId}`] },
      "Bash",
    )) as { description?: string } | null;
    for (const line of DESCRIPTION_LINES) expect(bash?.description).toContain(line);
    expect(bash?.description).not.toContain("Working directory persists between calls");

    const completed = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(LIVE_DONE),
      "sleep 拦截的 continuation 没有完成",
      60000,
    );
    const sessionId = completed.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`sleep 拦截 case 缺少真实 sessionId: ${sessionId ?? "null"}`);
    }
    expect(await getLatestUpstreamToolResultByToolCallId(TOOL_CALL_ID)).toEqual({
      content: TOOL_RESULT,
      isError: true,
      toolCallId: TOOL_CALL_ID,
    });
    // 命令没有启动：后半段写的文件不存在。
    await expect(access(join(DEFAULT_WORKSPACE, "sleep-block-ran.txt"))).rejects.toThrow();

    // 工具卡是失败状态，展开后显示不带标签的原因。
    const card = await waitForFoldedToolCallBlockByToolCallId(TOOL_CALL_ID, 30000);
    expect(card.status).toBe("failed");
    await expandToolCallDetails(TOOL_CALL_ID);
    await browser.waitUntil(
      async () => {
        const text = await browser.execute(
          (id: string) => document.querySelector(`[data-tool-call-id="${id}"]`)?.textContent ?? "",
          TOOL_CALL_ID,
        );
        return text.includes("Blocked: sleep 30 followed by: echo E2E_BASH_SLEEP_BLOCK_RAN.");
      },
      { timeout: 30000, timeoutMsg: "失败工具卡没有显示拦截原因" },
    );
    const cardText = await browser.execute(
      (id: string) => document.querySelector(`[data-tool-call-id="${id}"]`)?.textContent ?? "",
      TOOL_CALL_ID,
    );
    expect(cardText).not.toContain("<tool_use_error>");

    // 完整重启 Electron、Host 与 CLI：tool_result 必须来自持久化历史。
    await reloadElectronSessionSafely(browser);
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(sessionId, 60000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      `CLI cold restart 后没有恢复 session ${sessionId}`,
      60000,
    );

    const coldPrompt = `${COLD_PROMPT_MARKER}_${runId}: reply with exactly ${COLD_DONE}.`;
    await sendV4Prompt(coldPrompt);
    const coldRequest = await waitForUpstreamNetworkCapture(coldPrompt);
    expect(coldRequest.statusCode).toBe(200);
    await waitForV4AssistantMessageContaining(COLD_DONE, 60000);
    expect(await getLatestUpstreamToolResultByToolCallId(TOOL_CALL_ID)).toEqual({
      content: TOOL_RESULT,
      isError: true,
      toolCallId: TOOL_CALL_ID,
    });
  });
});
