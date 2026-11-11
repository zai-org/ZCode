// Composer 编辑态 E2E 原语（docs/ui/composer-edit-mode.md）。
// 编辑最后一条消息与编辑排队消息都复用底部 composer：状态读 TID_V4_COMPOSER_EDIT_BAR 的 data-*，
// 原位置占位读 TID_V4_EDIT_IN_COMPOSER_HINT / TID_V4_QUEUE_ITEM_EDIT_LOCK。
// 本文件只依赖 desktop-app 与 test-ids，供 v4-conversation.ts 复用而不形成循环依赖。
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_EDIT_APPLY_QUEUE_DIALOG,
  TID_V4_COMPOSER_EDIT_BAR,
  TID_V4_COMPOSER_EDIT_CANCEL,
  TID_V4_COMPOSER_EDIT_SWITCH_DIALOG,
  TID_V4_EDIT,
  TID_V4_EDIT_IN_COMPOSER_HINT,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_EDIT_LOCK,
  TID_V4_QUEUE_ITEM_RELEASE_EDIT,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom } from "./desktop-app.js";

export type V4ComposerEditTargetKind = "userQuery" | "queueItem";

export interface V4ComposerEditState {
  kind: V4ComposerEditTargetKind | null;
  targetId: string | null;
  state: "editing" | "invalid" | null;
  invalidReason: string | null;
  text: string;
  hasCancel: boolean;
}

/** 读取 composer 编辑态状态条；不在编辑态时返回 null。 */
export function getV4ComposerEditState(): Promise<V4ComposerEditState | null> {
  return browser.execute(
    (barTestId, cancelTestId) => {
      const bar = document.querySelector<HTMLElement>(`[data-testid="${barTestId}"]`);
      if (!bar) return null;
      const kind = bar.getAttribute("data-edit-target-kind");
      const state = bar.getAttribute("data-edit-state");
      return {
        kind: kind === "userQuery" || kind === "queueItem" ? kind : null,
        targetId: bar.getAttribute("data-edit-target-id"),
        state: state === "editing" || state === "invalid" ? state : null,
        invalidReason: bar.getAttribute("data-edit-invalid-reason"),
        text: (bar.innerText || "").replace(/\u00a0/g, " ").trim(),
        hasCancel: Boolean(bar.querySelector(`[data-testid="${cancelTestId}"]`)),
      };
    },
    TID_V4_COMPOSER_EDIT_BAR,
    TID_V4_COMPOSER_EDIT_CANCEL,
  );
}

export async function waitForV4ComposerEditState(
  predicate: (state: V4ComposerEditState | null) => boolean,
  timeoutMsg: string,
  timeout = 15000,
): Promise<V4ComposerEditState | null> {
  let latest: V4ComposerEditState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4ComposerEditState();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(latest)}`, { cause: error });
  }
  return latest;
}

/** 等待 composer 退出编辑态（状态条消失）。 */
export async function waitForV4ComposerEditClosed(timeoutMsg: string, timeout = 15000) {
  await waitForV4ComposerEditState((state) => state === null, timeoutMsg, timeout);
}

/** 点击状态条「取消」。编辑态不支持 Esc 取消，这里只走按钮。 */
export async function clickV4ComposerEditCancel() {
  await clickTestIdByDom(TID_V4_COMPOSER_EDIT_CANCEL, {
    timeout: 15000,
    timeoutMsg: "composer 编辑态没有可点击的取消按钮",
  });
}

/** 编辑中切换目标且已有改动时，确认丢弃并切换。 */
export async function confirmV4ComposerEditSwitch() {
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
    timeout: 15000,
    timeoutMsg: "composer 编辑态切换确认弹窗没有出现确认按钮",
  });
}

/** 编辑提交后「是否也应用于所有排队消息」弹窗出现，返回其可见文本。 */
export async function waitForV4ComposerEditApplyQueueDialog(timeout = 15000): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      text = await browser.execute((dialogTestId) => {
        const dialog = document.querySelector<HTMLElement>(`[data-testid="${dialogTestId}"]`);
        return dialog ? (dialog.innerText || "").trim() : "";
      }, TID_V4_COMPOSER_EDIT_APPLY_QUEUE_DIALOG);
      return text.length > 0;
    },
    { timeout, timeoutMsg: "编辑提交后没有出现「应用于所有排队消息」弹窗" },
  );
  return text;
}

/** 选「应用到排队消息」（弹窗确认按钮）。 */
export async function confirmV4ComposerEditApplyQueue() {
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
    timeout: 15000,
    timeoutMsg: "「应用于所有排队消息」弹窗没有出现确认按钮",
  });
}

export function hasV4ComposerEditSwitchDialog(): Promise<boolean> {
  return browser.execute(
    (dialogTestId) => Boolean(document.querySelector(`[data-testid="${dialogTestId}"]`)),
    TID_V4_COMPOSER_EDIT_SWITCH_DIALOG,
  );
}

/** 被编辑 user 行的占位与编辑入口状态。 */
export function getV4UserRowEditHint(
  rowId: string,
): Promise<{ hint: boolean; hintText: string; editAction: boolean }> {
  return browser.execute(
    (hintTestId, editTestId) => {
      const hint = document.querySelector<HTMLElement>(`[data-testid="${hintTestId}"]`);
      return {
        hint: Boolean(hint),
        hintText: (hint?.innerText || "").trim(),
        editAction: Boolean(document.querySelector(`[data-testid="${editTestId}"]`)),
      };
    },
    testId(TID_V4_EDIT_IN_COMPOSER_HINT, rowId),
    testId(TID_V4_EDIT, rowId),
  );
}

export async function clickV4UserRowEditHint(rowId: string) {
  await clickTestIdByDom(testId(TID_V4_EDIT_IN_COMPOSER_HINT, rowId), {
    timeout: 15000,
    timeoutMsg: `user 行没有「正在下方编辑」占位: rowId=${rowId}`,
  });
}

export interface V4QueueItemEditLockState {
  exists: boolean;
  locked: boolean;
  owner: "self" | "other" | null;
  lockText: string;
  releasable: boolean;
  editAction: boolean;
  deleteAction: boolean;
  sendNowAction: boolean;
}

/** 读取 queue 项的编辑锁投影与操作入口。 */
export function getV4QueueItemEditLock(queueItemId: string): Promise<V4QueueItemEditLockState> {
  return browser.execute(
    (id, lockTestId, releaseTestId) => {
      const item = document.querySelector<HTMLElement>(`li[data-queue-item-id="${id}"]`);
      const lock = document.querySelector<HTMLElement>(`[data-testid="${lockTestId}"]`);
      const owner = lock?.getAttribute("data-edit-lock-owner");
      const enabled = (testIdValue: string) => {
        const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testIdValue}"]`);
        return Boolean(
          button && !button.disabled && button.getAttribute("aria-disabled") !== "true",
        );
      };
      return {
        exists: Boolean(item),
        locked: item?.getAttribute("data-edit-locked") === "true",
        owner: owner === "self" || owner === "other" ? owner : null,
        lockText: (lock?.innerText || "").trim(),
        releasable: enabled(releaseTestId),
        editAction: enabled(`v4-queue-item-edit-${id}`),
        deleteAction: enabled(`v4-queue-item-delete-${id}`),
        sendNowAction: enabled(`v4-queue-item-send-now-${id}`),
      };
    },
    queueItemId,
    testId(TID_V4_QUEUE_ITEM_EDIT_LOCK, queueItemId),
    testId(TID_V4_QUEUE_ITEM_RELEASE_EDIT, queueItemId),
  );
}

export async function waitForV4QueueItemEditLock(
  queueItemId: string,
  predicate: (state: V4QueueItemEditLockState) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<V4QueueItemEditLockState> {
  let latest: V4QueueItemEditLockState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4QueueItemEditLock(queueItemId);
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(latest)}`, { cause: error });
  }
  if (!latest) throw new Error(`${timeoutMsg}: queue 项编辑锁状态为空`);
  return latest;
}

/** 其他窗口或设备持有锁时，手动「解除」。 */
export async function clickV4QueueItemReleaseEdit(queueItemId: string) {
  await clickTestIdByDom(testId(TID_V4_QUEUE_ITEM_RELEASE_EDIT, queueItemId), {
    timeout: 15000,
    timeoutMsg: `queue 项没有可点击的解除按钮: ${queueItemId}`,
  });
}

/**
 * 点击 latest user query 的编辑入口，等待 composer 进入 userQuery 编辑态，返回 rowId。
 * 修复原因（沿用行内编辑时期的根因）：compact success 会先投影成功 marker，再清理 active
 * work；两帧之间旧 edit action 可能短暂可见后被 canEdit 收口撤下。这里只在入口仍存在时
 * 重试点击，成功判据是状态条进入 editing，而不是“点到了按钮”。
 */
export async function openLatestV4UserQueryEditInComposer(timeout = 15000): Promise<string> {
  let lastClickedRowId: string | null = null;
  let lastClickedAt = 0;
  let rowId: string | null = null;
  await browser.waitUntil(
    async () => {
      const state = await getV4ComposerEditState();
      if (state?.kind === "userQuery" && state.state === "editing" && state.targetId) {
        rowId = state.targetId;
        return true;
      }
      const actionRowId = await browser.execute((editPrefix) => {
        const pattern = new RegExp(`^${editPrefix}-(\\d+)$`);
        const action = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .filter((candidate) => pattern.test(candidate.dataset.testid ?? ""))
          .at(-1);
        return pattern.exec(action?.dataset.testid ?? "")?.[1] ?? null;
      }, TID_V4_EDIT);
      if (!actionRowId) return false;
      const now = Date.now();
      if (lastClickedRowId !== actionRowId || now - lastClickedAt >= 500) {
        lastClickedRowId = actionRowId;
        lastClickedAt = now;
        await clickTestIdByDom(testId(TID_V4_EDIT, actionRowId), {
          timeout: 2000,
          timeoutMsg: `v4 编辑按钮在 projection 收口时消失: rowId=${actionRowId}`,
        }).catch(() => undefined);
      }
      return false;
    },
    { timeout, interval: 100, timeoutMsg: "latest user query 没有进入 composer 编辑态" },
  );
  if (!rowId) throw new Error("latest user query 编辑态缺少 rowId");
  return rowId;
}

/** 点击 user 行编辑入口（按 rowId），等待 composer 进入该行的编辑态。 */
export async function openV4UserQueryEditInComposer(rowId: string, timeout = 15000) {
  await clickTestIdByDom(testId(TID_V4_EDIT, rowId), {
    timeout,
    timeoutMsg: `user 行没有可点击的编辑按钮: rowId=${rowId}`,
  });
  await waitForV4ComposerEditState(
    (state) => state?.kind === "userQuery" && state.targetId === rowId && state.state === "editing",
    `user 行没有进入 composer 编辑态: rowId=${rowId}`,
    timeout,
  );
}

/** 点击 queue 项编辑入口，等待 lock accepted 后 composer 进入 queueItem 编辑态。 */
export async function openV4QueueItemEditInComposer(queueItemId: string, timeout = 30000) {
  await clickTestIdByDom(testId(TID_V4_QUEUE_ITEM_EDIT, queueItemId), {
    timeout: 15000,
    timeoutMsg: `queue 项没有可点击的编辑按钮: ${queueItemId}`,
  });
  await waitForV4ComposerEditState(
    (state) =>
      state?.kind === "queueItem" && state.targetId === queueItemId && state.state === "editing",
    `queue 项没有进入 composer 编辑态: ${queueItemId}`,
    timeout,
  );
}

/** 删除 composer 中第 index 个附件（编辑态与普通草稿共用同一附件列表）。 */
export async function removeV4ComposerAttachmentAt(index: number) {
  const removed = await browser.execute(
    (composerTestId, targetIndex) => {
      const composer = document.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`);
      const buttons = Array.from(
        composer?.querySelectorAll<HTMLButtonElement>("[data-composer-attachment-remove]") ?? [],
      );
      const button = buttons[targetIndex];
      button?.click();
      return Boolean(button);
    },
    TID_V4_COMPOSER,
    index,
  );
  if (!removed) throw new Error(`composer 没有第 ${index} 个附件删除按钮`);
}
