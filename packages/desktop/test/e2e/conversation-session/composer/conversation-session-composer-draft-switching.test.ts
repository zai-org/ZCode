import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  getV4ConversationState,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
  setV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import { waitForVisibleAttachmentNames } from "#e2e/helpers/conversation-session-composer-prefill";
import { getV4ComposerDraftScopeSnapshot } from "#e2e/helpers/conversation-session-store";

import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

interface DraftExpectation {
  attachmentFilenames: string[];
  text: string;
}

describe("会话区 composer 草稿切换保留 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("切换 completed/running/未发送 task 时应保留输入框正文和附件", async function () {
    this.timeout(260000);

    await prepareV4ConversationE2E();
    // 本例验证同一项目内的 session/草稿附件；任务入口的换目录由 PD01/02 单独断言。
    await startDraftFromProject(DEFAULT_WORKSPACE);

    const runId = Date.now();
    const completedPrompt = `E2E_COMPOSER_DRAFT_COMPLETED_SEED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(completedPrompt);
    await waitForV4UserMessageContaining(`E2E_COMPOSER_DRAFT_COMPLETED_SEED_${runId}`);
    const completedTaskId = await waitForTaskIdle("completed seed 没有完成");

    const completedDraft = {
      text: `E2E_COMPOSER_DRAFT_COMPLETED_TEXT_${runId}`,
      attachmentFilenames: [`completed-note-${runId}.txt`, `completed-image-${runId}.png`],
    };
    await fillComposerDraft(completedTaskId, completedDraft);
    await waitForComposerDraftScope(completedTaskId, completedDraft);

    const runningPrompt = `E2E_SLOW_STREAM E2E_COMPOSER_DRAFT_RUNNING_SEED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await startNewV4Draft();
    await sendV4Prompt(runningPrompt);
    await waitForV4UserMessageContaining(`E2E_COMPOSER_DRAFT_RUNNING_SEED_${runId}`);
    const runningTaskId = await waitForTaskStreaming("running seed 没有进入 streaming");

    const runningDraft = {
      text: `E2E_COMPOSER_DRAFT_RUNNING_TEXT_${runId}`,
      attachmentFilenames: [`running-note-${runId}.txt`, `running-image-${runId}.png`],
    };
    await fillComposerDraft(runningTaskId, runningDraft);
    await waitForComposerDraftScope(runningTaskId, runningDraft);

    await startNewV4Draft();
    const unsentDraft = {
      text: `E2E_COMPOSER_DRAFT_UNSENT_TEXT_${runId}`,
      attachmentFilenames: [`unsent-note-${runId}.md`, `unsent-image-${runId}.png`],
    };
    await fillComposerDraft(null, unsentDraft);
    await waitForComposerDraftScope(null, unsentDraft);

    await selectV4TaskById(completedTaskId);
    await waitForComposerDraftVisible(completedTaskId, completedDraft);
    await assertComposerDraftScope(runningTaskId, runningDraft);

    await selectV4TaskById(runningTaskId);
    await waitForComposerDraftVisible(runningTaskId, runningDraft);
    await assertTaskStillRunningOrSettled(runningTaskId);

    await startNewV4Draft();
    await waitForComposerDraftVisible(null, unsentDraft);
    await assertComposerDraftScope(completedTaskId, completedDraft);
    await assertComposerDraftScope(runningTaskId, runningDraft);
  });
});

async function fillComposerDraft(taskId: string | null, expectation: DraftExpectation) {
  await setV4ComposerText(expectation.text);
  await seedComposerAttachmentScope(expectation.attachmentFilenames);
  await waitForComposerDraftVisibleOnCurrentScope(expectation);
}

async function seedComposerAttachmentScope(filenames: string[]) {
  const result = await browser.execute((nextFilenames) => {
    const w = window as typeof window & {
      __zcodeComposerAttachmentUploadStoreE2E?: {
        getState: () => { scopes: Record<string, unknown[]> };
        setState: (state: { scopes: Record<string, unknown[]> }) => void;
      };
      __zcodeCurrentComposerAttachmentScopeKeyE2E?: string;
    };
    const store = w.__zcodeComposerAttachmentUploadStoreE2E;
    const scopeKey = w.__zcodeCurrentComposerAttachmentScopeKeyE2E;
    if (!store || !scopeKey) return { ok: false, reason: "scope-missing" };
    store.setState({
      scopes: {
        ...store.getState().scopes,
        [scopeKey]: nextFilenames.map((filename, index) => ({
          id: `e2e-composer-draft-attachment-${index}`,
          filename,
          mimeType: filename.endsWith(".png") ? "image/png" : "text/plain",
          sizeBytes: 1,
          referenceOwnership: "composer",
          uploadStatus: "ready",
          uploadProgress: 100,
          attachmentRef: {
            ref: `/e2e/${filename}`,
            fileName: filename,
            mime: filename.endsWith(".png") ? "image/png" : "text/plain",
            bytes: 1,
          },
          operationId: `e2e-composer-draft-attachment-${index}`,
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: false,
          showComplete: false,
          localZeroCopy: false,
        })),
      },
    });
    return { ok: true };
  }, filenames);
  if (!result.ok) throw new Error(`附件 scope 写入失败: ${JSON.stringify(result)}`);
}

async function waitForComposerDraftVisibleOnCurrentScope(expectation: DraftExpectation) {
  await waitForV4ComposerText(expectation.text, `composer 没有显示草稿文本: ${expectation.text}`);
  const filenames = expectation.attachmentFilenames;
  const textFilenames = filenames.filter((filename) => !filename.endsWith(".png"));
  if (textFilenames.length > 0) {
    await waitForVisibleAttachmentNames(textFilenames);
  }
  const imageCount = filenames.filter((filename) => filename.endsWith(".png")).length;
  if (imageCount > 0) {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (expectedCount) =>
            document.querySelectorAll(
              '[data-composer-attachment-kind="image"][data-upload-status="ready"]',
            ).length >= expectedCount,
          imageCount,
        ),
      {
        timeout: 10000,
        timeoutMsg: `composer 图片附件没有显示: ${imageCount}`,
      },
    );
  }
}

async function waitForComposerDraftVisible(taskId: string | null, expectation: DraftExpectation) {
  await waitForV4ConversationState(
    (snapshot) => (taskId === null ? snapshot.taskId === null : snapshot.taskId === taskId),
    `没有切到目标 task scope: ${taskId ?? "__draft__"}`,
    30000,
  );
  await waitForComposerDraftVisibleOnCurrentScope(expectation);
  await assertComposerDraftScope(taskId, expectation);
}

async function waitForComposerDraftScope(taskId: string | null, expectation: DraftExpectation) {
  await browser.waitUntil(
    async () => {
      const snapshot = await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, taskId);
      return matchesDraftScope(snapshot, expectation);
    },
    {
      timeout: 10000,
      timeoutMsg: `composer draft scope 未保存: ${JSON.stringify({
        taskId,
        expectation,
      })}`,
    },
  );
}

async function assertComposerDraftScope(taskId: string | null, expectation: DraftExpectation) {
  const snapshot = await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, taskId);
  expect(snapshot.exists).toBe(true);
  expect(snapshot.text).toBe(expectation.text);
  expect(snapshot.mode).not.toBeNull();
}

function matchesDraftScope(
  snapshot: Awaited<ReturnType<typeof getV4ComposerDraftScopeSnapshot>>,
  expectation: DraftExpectation,
) {
  return snapshot.exists && snapshot.text === expectation.text && snapshot.mode !== null;
}

async function waitForTaskIdle(timeoutMsg: string) {
  const snapshot = await waitForV4ConversationState(
    (current) => current.state === "idle" && Boolean(current.taskId),
    timeoutMsg,
    90000,
  );
  if (!snapshot.taskId) {
    throw new Error(`${timeoutMsg}: taskId missing`);
  }
  return snapshot.taskId;
}

async function waitForTaskStreaming(timeoutMsg: string) {
  const snapshot = await waitForV4ConversationState(
    (current) => current.state === "streaming" && Boolean(current.taskId),
    timeoutMsg,
    30000,
  );
  if (!snapshot.taskId) {
    throw new Error(`${timeoutMsg}: taskId missing`);
  }
  return snapshot.taskId;
}

async function assertTaskStillRunningOrSettled(taskId: string) {
  const snapshot = await getV4ConversationState();
  expect(snapshot.taskId).toBe(taskId);
  expect(["streaming", "idle"]).toContain(snapshot.state);
}
