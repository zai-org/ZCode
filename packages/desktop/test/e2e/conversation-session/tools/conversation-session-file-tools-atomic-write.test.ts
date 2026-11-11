import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "#e2e/helpers/conversation-session-tool-cross-product";

const CASE_MARKER = "E2E_FILE_TOOLS_ATOMIC_WRITE";
const FINAL_MARKER = `${CASE_MARKER}_OK`;
const CASE_RELATIVE_ROOT = "file-tools-atomic-write-e2e";
const WRITE_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/write.sh`;
const EDIT_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/edit.sh`;
const CASE_ROOT = join(DEFAULT_WORKSPACE, CASE_RELATIVE_ROOT);
const WRITE_PATH = join(DEFAULT_WORKSPACE, WRITE_RELATIVE_PATH);
const EDIT_PATH = join(DEFAULT_WORKSPACE, EDIT_RELATIVE_PATH);
const EXECUTABLE_MODE = 0o755;

describe("会话区 file tools 原子写权限 E2E", () => {
  before(async function () {
    this.timeout(120000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
  });

  afterEach(async () => {
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Write 和 Edit 修改可执行脚本后应保留 POSIX 执行位", async function () {
    if (process.platform === "win32") {
      // Windows 不具备 POSIX 执行位语义，明确记为跳过。
      this.skip();
    }
    this.timeout(180000);

    await writeExecutableFixtures();
    const runId = Date.now();
    const sourceMarker = `${CASE_MARKER}_${runId}`;
    const prompt = [
      `${sourceMarker}: Follow these file tool steps exactly.`,
      `1. Use Read on ${WRITE_RELATIVE_PATH}.`,
      `2. Use Write on ${WRITE_RELATIVE_PATH} to replace the full content with a bash script that echoes new-write.`,
      `3. Use Read on ${EDIT_RELATIVE_PATH}.`,
      `4. Use Edit on ${EDIT_RELATIVE_PATH}; replace exactly "old-edit" with "new-edit".`,
      `5. Reply with exactly "${FINAL_MARKER}" and no other text.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "file tools atomic write: 首发后输入框没有清空");
    await waitForV4UserMessageContaining(sourceMarker);
    await waitForToolCallBlockByToolName("Write", 90000);
    await waitForToolCallBlockByToolName("Edit", 90000);
    await waitForV4AssistantMessageContaining(FINAL_MARKER);
    await waitForStableCompleted("file tools atomic write: 工具链没有回到 idle");

    await expectExecutableFile(WRITE_PATH, "#!/usr/bin/env bash\necho new-write\n");
    await expectExecutableFile(EDIT_PATH, "#!/usr/bin/env bash\necho new-edit\n");
  });
});

async function writeExecutableFixtures() {
  await rm(CASE_ROOT, { recursive: true, force: true });
  await mkdir(CASE_ROOT, { recursive: true });
  await writeFile(WRITE_PATH, "#!/usr/bin/env bash\necho old-write\n", "utf-8");
  await chmod(WRITE_PATH, EXECUTABLE_MODE);
  await writeFile(EDIT_PATH, "#!/usr/bin/env bash\necho old-edit\n", "utf-8");
  await chmod(EDIT_PATH, EXECUTABLE_MODE);
}

async function expectExecutableFile(filePath: string, expectedContent: string) {
  expect(await readFile(filePath, "utf-8")).toBe(expectedContent);
  expect((await stat(filePath)).mode & 0o777).toBe(EXECUTABLE_MODE);
}

async function waitForStableCompleted(timeoutMsg: string) {
  let latest = "not-started";
  await browser.waitUntil(
    async () => {
      await respondToToolCrossProductBlockers();
      const snapshot = await getV4ConversationState();
      latest = JSON.stringify(snapshot);
      return snapshot.state === "idle" && snapshot.queueCount === 0;
    },
    {
      timeout: 120000,
      timeoutMsg: `${timeoutMsg}; latest=${latest}`,
    },
  );
}
