import { readFile, writeFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_WORKSPACE_MORE_BUTTON,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForWorkspaceApp,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  waitForV4TimelineContaining,
  scrollV4TimelineToTop,
  getV4TimelineScrollState,
} from "#e2e/helpers/v4-conversation";
import {
  HISTORY_FIRST_SESSION,
  HISTORY_FIRST_FAILED_SESSION,
  HISTORY_FIRST_TEXT,
} from "#e2e/helpers/session-history-first-fixture";

const root = join(DEFAULT_WORKSPACE, ".zcode", "history-first-e2e");
const release = join(root, "release");
const entered = join(root, "entered");
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts");

describe("HF01：历史首帧早于 resume hook 完成", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    await browser.saveScreenshot(join(artifacts, "history-first-failure.png"));
    console.info(
      "history-first UI failure",
      await browser.execute(() => ({
        text: document.body.innerText.slice(-6000),
        dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map(
          (node) => node.textContent,
        ),
        trigger: document.querySelector('[data-testid="chat-model-select-trigger"]')?.outerHTML,
      })),
    );
  });
  after(async () => {
    await writeFile(release, "release").catch(() => undefined);
    await clearAppData();
  });

  it("可以先读历史和编辑草稿，释放初始化屏障后才可发送", async function () {
    this.timeout(180_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await prepareV4ConversationE2E();
    const openedAt = performance.now();
    await selectV4TaskById(HISTORY_FIRST_SESSION);
    await waitForV4TimelineContaining(HISTORY_FIRST_TEXT, 30_000);
    const historyVisibleMs = Math.round(performance.now() - openedAt);
    await browser.waitUntil(
      async () => (await readFile(entered, "utf8").catch(() => "")) === "entered",
      { timeout: 30_000, timeoutMsg: "resume hook 未进入屏障" },
    );
    expect(await $(`[data-testid="v4-session-initialization"]`).isExisting()).toBe(false);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_HISTORY_FIRST 保留的草稿");
    expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
    await browser.saveScreenshot(join(artifacts, "history-first-initializing.png"));
    await writeFile(release, "release");
    await browser.waitUntil(
      async () => await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled(),
      { timeout: 30_000, timeoutMsg: "初始化未收敛" },
    );
    expect(await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).getText()).toContain(
      "E2E_HISTORY_FIRST 保留的草稿",
    );
    expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(true);
    console.info("history-first timings", {
      historyVisibleMs,
      runtimeReadyMs: Math.round(performance.now() - openedAt),
    });
    await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).click();
    await waitForV4TimelineContaining("HISTORY_FIRST_OK", 30_000);
    await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
    await $('[data-testid="task-restart"]').click();
    await browser.waitUntil(
      async () => {
        const pane = $(`[data-session-id="${HISTORY_FIRST_SESSION}"]`);
        return (
          (await pane.getAttribute("data-session-lifecycle")) === "ready" &&
          Number(await pane.getAttribute("data-session-generation")) >= 2
        );
      },
      { timeout: 60_000, timeoutMsg: "旧路径会话未能在同一工作区重启" },
    );
    await waitForV4TimelineContaining("HISTORY_FIRST_OK", 30_000);
    const database = new DatabaseSync(
      join(DEFAULT_WORKSPACE, "..", ".zcode", "cli", "db", "db.sqlite"),
    );
    try {
      expect(
        database
          .prepare("SELECT directory, path FROM session WHERE id = ?")
          .get(HISTORY_FIRST_SESSION),
      ).toEqual({ directory: DEFAULT_WORKSPACE + sep, path: DEFAULT_WORKSPACE + sep });
    } finally {
      database.close();
    }
  });

  it("HF02：快照物化失败后保留历史、草稿和滚动，双击重试复用已就绪实例", async function () {
    this.timeout(120_000);
    await Promise.all([rm(release, { force: true }), rm(entered, { force: true })]);
    await selectV4TaskById(HISTORY_FIRST_FAILED_SESSION);
    await waitForV4TimelineContaining("历史段落", 30_000);
    await browser.waitUntil(
      async () => (await readFile(entered, "utf8").catch(() => "")) === "entered",
      { timeout: 30_000, timeoutMsg: "失败用例的 hook 未进入屏障" },
    );
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_HISTORY_FIRST 重试保留草稿");
    await scrollV4TimelineToTop();
    const scrollBefore = (await getV4TimelineScrollState()).scrollTop;
    const database = new DatabaseSync(
      join(DEFAULT_WORKSPACE, "..", ".zcode", "cli", "db", "db.sqlite"),
    );
    try {
      // 在 M0 已展示、hook 尚未完成时损坏会话分支字段，触发真实最终物化读取错误。
      database
        .prepare("UPDATE session SET revert = '{' WHERE id = ?")
        .run(HISTORY_FIRST_FAILED_SESSION);
      await writeFile(release, "release");
      const retry = $('[data-testid="v4-session-initialization-retry"]');
      await retry.waitForDisplayed({ timeout: 30_000 });
      await browser.saveScreenshot(join(artifacts, "history-first-retry.png"));
      expect(await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).getText()).toContain(
        "重试保留草稿",
      );
      expect(Math.abs((await getV4TimelineScrollState()).scrollTop - scrollBefore)).toBeLessThan(2);
      await waitForV4TimelineContaining(HISTORY_FIRST_TEXT);
      database
        .prepare("UPDATE session SET revert = NULL WHERE id = ?")
        .run(HISTORY_FIRST_FAILED_SESSION);
      await Promise.all([rm(release, { force: true }), rm(entered, { force: true })]);
      const attemptsBefore = (await readFile(join(root, "attempts"), "utf8"))
        .trim()
        .split("\n").length;
      const pane = $(`[data-session-id="${HISTORY_FIRST_FAILED_SESSION}"]`);
      const generationBefore = await pane.getAttribute("data-session-generation");
      // revert 损坏发生在实例已就绪后的快照物化阶段；重试应修复投影，不能重跑 hook 或替换实例。
      await retry.doubleClick();
      await browser.waitUntil(
        async () => await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled(),
        { timeout: 30_000, timeoutMsg: "重试未就绪" },
      );
      expect((await readFile(join(root, "attempts"), "utf8")).trim().split("\n").length).toBe(
        attemptsBefore,
      );
      expect(await pane.getAttribute("data-session-generation")).toBe(generationBefore);
      expect(await retry.isExisting()).toBe(false);
      expect(await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).getText()).toContain(
        "重试保留草稿",
      );
      expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(true);
      expect(Math.abs((await getV4TimelineScrollState()).scrollTop - scrollBefore)).toBeLessThan(2);
    } finally {
      database
        .prepare("UPDATE session SET revert = NULL WHERE id = ?")
        .run(HISTORY_FIRST_FAILED_SESSION);
      database.close();
    }
  });
});
