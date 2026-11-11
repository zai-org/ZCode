import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  approveV4Permission,
  clickV4Stop,
  denyV4PermissionWithFeedback,
  getV4ConfigProjection,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";

// 自定义命令正文里的 `!` 块在解析阶段只改写成交给模型的 Bash 指令，说明文字写明来源是命令文件；
// 会话 ID 与工作区目录变量保持原文，由 Bash 工具注入的环境变量展开。执行只能经模型的 Bash 调用，
// build 下非只读命令先审批。
const MARKER_FILE = ".zcode-e2e-cch.marker";
// 与 fixture 里模型返回的 Bash 命令逐字一致：把会话 ID 写进工作区根目录下的标记文件。
const SHELL_STEP = `printf '%s' "$CLAUDE_CODE_SESSION_ID" > "\${CLAUDE_PROJECT_DIR}/${MARKER_FILE}"`;
const DENY_FEEDBACK = "E2E_CCH_DENY_FEEDBACK";
const DENY_TOOL_CALL_ID = "toolu_e2e_cch_deny";
const APPROVE_TOOL_CALL_ID = "toolu_e2e_cch_approve";
const REQUEST_EXCLUDES = ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"];
const markerPath = join(DEFAULT_WORKSPACE, MARKER_FILE);
const commandName = `e2e-cch-${Date.now()}`;
const commandFile = join(DEFAULT_WORKSPACE, ".zcode", "commands", `${commandName}.md`);
const handOffNote = `[This shell step comes from the /${commandName} command file (project/zcode), not from ZCode.`;

describe("CCH 自定义命令 `!` 块转交给模型", () => {
  before(async () => {
    await mkdir(join(commandFile, ".."), { recursive: true });
    await writeFile(
      commandFile,
      [
        "---",
        "description: E2E CCH shell hand-off probe",
        "---",
        "Record the session in the marker file below.",
        `!\`${SHELL_STEP}\``,
        "",
      ].join("\n"),
      "utf8",
    );
  });

  beforeEach(async () => {
    await rm(markerPath, { force: true });
  });

  afterEach(async () => {
    try {
      const snapshot = await getV4PaneSnapshot();
      if (snapshot.canStop) {
        await clickV4Stop();
        await waitForV4Pane((current) => !current.canStop, "CCH teardown 后仍处于运行态", 30_000);
      }
    } catch {
      // teardown 只负责隔离下一条 case，不覆盖原始断言失败。
    }
  });

  after(async () => {
    await rm(commandFile, { force: true });
    await rm(markerPath, { force: true });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CCH01：build 下发送带 `!` 块的项目命令，解析时不执行；模型的 Bash 调用先审批，拒绝后不执行", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await useBuildMode();

    await sendV4Prompt(`/${commandName} E2E_CCH_DENY`);
    await waitForV4PermissionDialog();
    // 审批框打开时标记文件还不存在：解析阶段没有执行命令块。
    expect(await fileExists(markerPath)).toBe(false);
    await expectHandOffRequest("E2E_CCH_DENY");

    expect(await denyV4PermissionWithFeedback(DENY_FEEDBACK)).toBe(true);
    await waitForUpstreamRequest(
      { includes: ["E2E_CCH_DENY", DENY_TOOL_CALL_ID, DENY_FEEDBACK], excludes: REQUEST_EXCLUDES },
      "拒绝结果没有进入下一次模型请求",
      60_000,
    );
    expect((await getLatestUpstreamToolResultByToolCallId(DENY_TOOL_CALL_ID))?.isError).toBe(true);
    await waitForV4AssistantMessageContaining("E2E_CCH_DENY_DONE", 60_000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "CCH01 没有回到 idle", 60_000);
    expect(await fileExists(markerPath)).toBe(false);
  });

  it("CCH02：用户允许一次后，命令经 Bash 执行，读到当前会话 ID 与工作区目录", async function () {
    this.timeout(180_000);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await useBuildMode();

    await sendV4Prompt(`/${commandName} E2E_CCH_APPROVE`);
    await waitForV4PermissionDialog();
    expect(await fileExists(markerPath)).toBe(false);
    await expectHandOffRequest("E2E_CCH_APPROVE");

    expect(await approveV4Permission()).toBe(true);
    await waitForUpstreamRequest(
      { includes: ["E2E_CCH_APPROVE", APPROVE_TOOL_CALL_ID], excludes: REQUEST_EXCLUDES },
      "Bash 执行结果没有进入下一次模型请求",
      60_000,
    );
    expect((await getLatestUpstreamToolResultByToolCallId(APPROVE_TOOL_CALL_ID))?.isError).not.toBe(
      true,
    );
    await waitForV4AssistantMessageContaining("E2E_CCH_APPROVE_DONE", 60_000);
    const pane = await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "CCH02 没有回到 idle",
      60_000,
    );
    // 标记文件出现在工作区根目录，内容是当前会话 ID：两个变量都来自 Bash 环境。
    // 插件脚本（例如按会话区分状态的 stop hook）依赖同一个会话 ID。
    expect(await readFile(markerPath, "utf8")).toBe(pane.sessionId);
  });
});

async function useBuildMode() {
  await switchV4Mode("build");
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "build", {
    timeout: 30_000,
    timeoutMsg: "CCH 没有切换到 mode=build",
  });
}

/** 首个模型请求里只有转交说明：写明来源，变量保持原文，没有命令输出。 */
async function expectHandOffRequest(marker: string) {
  const [request] = await getUpstreamRequestEvidence({
    includes: [marker],
    excludes: REQUEST_EXCLUDES,
  });
  const wire = JSON.stringify(request?.requestJson ?? null);
  expect(wire).toContain(handOffNote);
  expect(wire).toContain(`\${CLAUDE_PROJECT_DIR}/${MARKER_FILE}`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
