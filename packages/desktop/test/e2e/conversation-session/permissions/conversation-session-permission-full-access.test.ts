// PA158：真实审批、风险勾选、混合 Plan 队列及队列项冻结编辑。
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  clickV4ComposerEditCancel,
  openV4QueueItemEditInComposer,
  waitForV4ComposerEditClosed,
  waitForV4QueueItemEditLock,
} from "#e2e/helpers/v4-composer-edit";
import {
  getV4ConfigProjection,
  getV4ModelConfig,
  getV4QueueItems,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4ComposerSelectionReady,
  switchV4Mode,
  waitForV4PermissionDialog,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE = "conversation-session-permission-full-access";
const DIRECTORY = resolveE2ERuntimePath(CASE);

describe("PA158 审批完全访问", () => {
  before(async () => {
    await mkdir(DIRECTORY, { recursive: true });
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(DIRECTORY, { recursive: true, force: true });
  });
  for (const target of ["guarded", "yolo"] as const)
    it(`审批切到 ${target}，队列编辑与新会话继承所选权限`, async () => {
      await rm(join(DIRECTORY, "output.txt"), { force: true });
      // 新隔离 HOME 会先进入职业引导，按真实 UI 完成准备，不能伪造业务快照。
      await browser.waitUntil(
        async () =>
          browser.execute(() =>
            Boolean(
              document.querySelector(
                '[data-testid="onboarding-page"],[data-testid="login-use-api-key-button"],[data-testid^="v4-session-pane-"]',
              ),
            ),
          ),
        { timeout: 30000 },
      );
      const onboarding = await $('[data-testid="onboarding-page"]');
      if (await onboarding.isExisting()) {
        for (let step = 0; step < 3; step += 1) {
          await $(
            '//main[@data-testid="onboarding-page"]//button[normalize-space()="Skip" or normalize-space()="跳过"]',
          ).click();
        }
        await onboarding.waitForExist({ reverse: true });
      }
      await prepareV4ConversationE2E({ skipProvider: true });
      // 同目录也可以有未归类任务；从项目入口创建，确保前后两份会话确实属于同一项目。
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await prepareV4ConversationE2E();
      await switchV4Mode("build");
      await sendV4Prompt("E2E_PA158_MAIN 执行需要确认的写文件操作");
      await waitForV4TimelineContaining("E2E_PA158_RUNNING");
      await switchV4Mode("plan");
      await sendV4Prompt("E2E_PA158_QUEUE_PLAN");
      await waitForV4QueueCount(1);
      await $('[data-testid="v4-composer-plan-marker"] button').click();
      // 菜单已隐藏 edit，旧步骤会在授权前超时；用可选的 guarded 保留混合权限和 Plan 场景。
      await switchV4Mode("guarded");
      expect(await getV4ConfigProjection()).toMatchObject({ mode: "guarded", planEnabled: false });
      await sendV4Prompt("E2E_PA158_QUEUE_GUARDED");
      await waitForV4QueueCount(2);
      const queue = await getV4QueueItems();
      await switchV4Mode("plan");
      await waitForV4PermissionDialog();
      const submitMode = await $('[data-testid="permission-allow-switch"]');
      await submitMode.waitForDisplayed();
      const picker = await $('[data-testid="permission-target-picker"]');
      expect(await picker.getAttribute("data-mode")).toBe("guarded");
      const beforeConfirmation = await getV4ModelConfig();
      const assertApprovalStillPending = async () => {
        expect(await submitMode.isDisplayed()).toBe(true);
        expect(await getV4ModelConfig()).toEqual(beforeConfirmation);
        expect(await getV4ConfigProjection()).toMatchObject({
          mode: "guarded",
          planEnabled: true,
        });
        expect(await getV4QueueItems()).toEqual(queue);
        await expect(readFile(join(DIRECTORY, "output.txt"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      };
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "permission-full-access.png"),
        );
      }
      if (target === "yolo") {
        await picker.click();
        await $('[data-testid="permission-target-yolo"]').click();
        await assertApprovalStillPending();
        await submitMode.click();
        await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed();
        expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(false);
        await $('[data-testid="yolo-confirmation-risk"]').click();
        await assertApprovalStillPending();
        await $('[data-testid="yolo-confirmation-cancel"]').click();
        await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed({ reverse: true });
        await assertApprovalStillPending();
        await submitMode.click();
        await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed();
        expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(false);
        await $('[data-testid="yolo-confirmation-risk"]').click();
        await assertApprovalStillPending();
        await $('[data-testid="yolo-confirmation-confirm"]').click();
      } else await submitMode.click();
      await waitForV4TimelineContaining("E2E_PA158_DONE");
      expect(await readFile(resolveE2ERuntimePath(CASE, "output.txt"), "utf8")).toBe(
        "E2E_PA158_TOOL_RESULT\n",
      );
      expect(await getV4QueueItems()).toEqual(queue);
      expect(await getV4ConfigProjection()).toMatchObject({ mode: target, planEnabled: true });
      // PA158-05：编辑队列项时原位冻结，工具栏载入该项记录的更新后权限与各自 Plan；
      // 取消后队列不变，工具栏恢复进入编辑态前的草稿配置。
      const draftConfig = await getV4ConfigProjection();
      await openV4QueueItemEditInComposer(queue[0]!.queueItemId);
      await waitForV4ComposerText("E2E_PA158_QUEUE_PLAN", "第一项编辑态没有载入原文");
      expect(await getV4ConfigProjection()).toMatchObject({ mode: target, planEnabled: true });
      expect(await getV4QueueItems()).toHaveLength(2);
      await clickV4ComposerEditCancel();
      await waitForV4ComposerEditClosed("第一项取消编辑后没有退出编辑态");
      await openV4QueueItemEditInComposer(queue[1]!.queueItemId);
      await waitForV4ComposerText("E2E_PA158_QUEUE_GUARDED", "第二项编辑态没有载入原文");
      expect(await getV4ConfigProjection()).toMatchObject({ mode: target, planEnabled: false });
      await clickV4ComposerEditCancel();
      await waitForV4ComposerEditClosed("第二项取消编辑后没有退出编辑态");
      // 取消后 releaseQueueItemEdit 异步回到投影；锁消失前该行仍显示「正在下方编辑」。
      await waitForV4QueueItemEditLock(
        queue[1]!.queueItemId,
        (state) => state.exists && !state.locked,
        "第二项取消编辑后锁没有释放",
      );
      expect(await getV4ConfigProjection()).toMatchObject({
        mode: draftConfig.mode,
        planEnabled: draftConfig.planEnabled,
      });
      expect(await getV4QueueItems()).toEqual(queue);
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await waitForV4ComposerSelectionReady();
      expect(await getV4ConfigProjection()).toMatchObject({ mode: target, planEnabled: false });
      expect((await getV4ModelConfig()).model).toBe(beforeConfirmation.model);
    });
});
