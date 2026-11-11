import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  selectV4TaskById,
  startNewV4Draft,
  V4_MAIN_PANE_ID,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_CONVERSATION_SHARE_LOCAL_V1";
const PREVIEW_CASE_MARKER = "E2E_CONVERSATION_SHARE_PREVIEW_V1";
const PREVIEW_CASE_ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", "conversation-share-preview");
const PREVIEW_PDF = "晨报_2026-09-08_早会版.pdf";
const PREVIEW_VIDEOS = ["condensed.mp4", "纵横四海_电影解说.mp4", "final_subtitled.mp4"] as const;

async function selectSharePermission(permission: "link-viewer" | "link-editor" | "private") {
  await $('[data-testid="conversation-share-permission-picker"] [role="combobox"]').click();
  await $(`[data-conversation-share-permission="${permission}"]`).click();
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// 有效期选项来自预检返回的服务端范围，预检完成前不渲染；先等选择器出现再操作。
async function selectShareExpiry(ttlMs: number) {
  const picker = await $('[data-testid="conversation-share-expiry-picker"]');
  await picker.waitForDisplayed({ timeout: 60_000 });
  await picker.$('[role="combobox"]').click();
  await $(`[data-conversation-share-ttl="${ttlMs}"]`).click();
}

describe(`${CASE_MARKER}: Desktop local 分享发布与导入入口`, () => {
  after(async () => {
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await clearAppData();
  });

  it("SHARE18/SHARE-E2E-01 trusted attachment 发布已完成轮次并展示成功结果操作", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${CASE_MARKER}: reply with exactly share-local-ready`);
    await waitForV4AssistantMessageContaining("share-local-ready");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "分享前会话没有进入终态",
      90_000,
    );
    await sendV4Prompt(`${CASE_MARKER}: reply with exactly share-local-ready-second`);
    await waitForV4AssistantMessageContaining("share-local-ready-second");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "第二轮分享前会话没有进入终态",
      90_000,
    );

    const shareButton = await $("[data-testid=conversation-share-trigger]");
    await shareButton.waitForClickable();
    // 回归原因：分享误用 icon-lg，导致热区及背景比相邻工具栏按钮大一圈。
    const toolbarGeometry = await browser.execute(() => {
      const measure = (selector: string) => {
        const button = document.querySelector<HTMLElement>(selector)!;
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          radius: getComputedStyle(button).borderRadius,
          iconWidth: icon.width,
          iconHeight: icon.height,
        };
      };
      return {
        share: measure('[data-testid="conversation-share-trigger"]'),
        terminal: measure('[data-testid="terminal-toggle"]'),
      };
    });
    expect(toolbarGeometry.share).toEqual(toolbarGeometry.terminal);
    await shareButton.click();
    await $("[data-testid=conversation-share-popover]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-selection-panel]").isExisting()).toBe(false);
    await $("[data-testid=conversation-share-adjust]").click();
    const selectionPanel = await $("[data-testid=conversation-share-selection-panel]");
    await selectionPanel.waitForDisplayed();
    const items = await selectionPanel.$$('[data-conversation-share-selection-item="true"]');
    await items[1]!.$('[role="checkbox"]').click();
    await $("[data-testid=conversation-share-selection-apply]").click();
    await selectionPanel.waitForDisplayed({ reverse: true });
    await selectSharePermission("link-viewer");
    // 契约 fake 默认有效期为 1 天；选 30 天才能证明用户选择真正写入发布请求。
    await selectShareExpiry(THIRTY_DAYS_MS);
    const disclosureScopeTrigger = await $(
      "[data-testid=conversation-share-disclosure-scope-trigger]",
    );
    await disclosureScopeTrigger.waitForClickable();
    await disclosureScopeTrigger.click();
    const disclosureScope = await $("[data-testid=conversation-share-disclosure-scope-content]");
    await disclosureScope.waitForDisplayed();
    expect(await disclosureScope.getText()).toMatch(/检查范围|Review scope/iu);
    await disclosureScopeTrigger.click();
    await browser.waitUntil(async () => !(await disclosureScope.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: "关闭检查范围后浮层仍可见",
    });
    const publishButton = await $("[data-testid=conversation-share-confirm]");
    expect(await publishButton.isEnabled()).toBe(true);
    await publishButton.click();
    const reviewCheckbox = await $("[data-testid=conversation-share-disclosure-checkbox]");
    expect(await reviewCheckbox.isFocused()).toBe(true);
    expect(await $("[data-testid=conversation-share-review-hint]").isExisting()).toBe(false);
    await reviewCheckbox.click();
    await publishButton.waitForClickable();
    await publishButton.click();

    const copyButton = await $(`[data-testid="conversation-share-copy-link"]`);
    await copyButton.waitForDisplayed({ timeout: 120_000 });
    expect(await copyButton.getText()).toMatch(/复制链接|Copy link/iu);
    expect(await $(`[data-testid="conversation-share-open-browser"]`).isExisting()).toBe(true);
    expect((await $$('[data-testid="conversation-share-success-actions"] button')).length).toBe(2);
    expect(await $("[data-testid=conversation-share-selection-panel]").isDisplayed()).toBe(false);
    expect(await $("[data-testid=conversation-share-success-dock]").isDisplayed()).toBe(true);

    const publishedUrl = await $(
      '[data-testid="conversation-share-success-dock"] input',
    ).getValue();
    const publishedTitle = await $('[data-testid="conversation-share-result-title"]').getText();
    // SHARE27：切换前先真实关闭成功浮窗。当前规格要求重开开始新一轮，不复用旧链接。
    await $('[data-testid="conversation-share-success-dismiss"]').click();
    await $('[data-testid="conversation-share-popover"]').waitForDisplayed({ reverse: true });
    // B 不能串用 A 的结果，重开 A 也不能清理 B 的未发布草稿。
    const sessionA = (
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle",
        "读取 Session A 分享状态失败",
      )
    ).sessionId;
    expect(sessionA).toBeTruthy();
    await startNewV4Draft();
    const sessionBMarker = `${CASE_MARKER}: session-b`;
    await sendV4Prompt(`${sessionBMarker}: reply with exactly share-session-b-ready`);
    await waitForV4AssistantMessageContaining("share-session-b-ready");
    const sessionB = (
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle",
        "Session B 分享前会话没有进入终态",
        90_000,
      )
    ).sessionId;
    expect(sessionB).toBeTruthy();
    expect(sessionB).not.toBe(sessionA);
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    await (await $("[data-testid=conversation-share-trigger]")).click();
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    await $("[data-testid=conversation-share-trigger]").click();
    await selectV4TaskById(sessionA!);
    await $("[data-testid=conversation-share-trigger]").click();
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    expect(await $("[data-testid=conversation-share-confirmation-dock] input").getValue()).toBe(
      publishedTitle,
    );
    expect(await $("[data-testid=conversation-share-permission-picker]").getText()).toMatch(
      /凭链接查看|Anyone with the link can view|View/iu,
    );
    // 新一轮分享与权限一样保留有效期选择。
    await $('[data-testid="conversation-share-expiry-picker"]').waitForDisplayed({
      timeout: 60_000,
    });
    expect(await $('[data-testid="conversation-share-expiry-picker"]').getText()).toMatch(
      /30 天|30 days/iu,
    );
    expect(
      await $("[data-testid=conversation-share-disclosure-checkbox]").getAttribute("aria-checked"),
    ).toBe("false");
    await $("[data-testid=conversation-share-adjust]").click();
    const resetSelection = $("[data-testid=conversation-share-selection-panel]");
    await resetSelection.waitForDisplayed();
    const resetRows = await resetSelection.$$(
      '[data-conversation-share-selection-item="true"] [role="checkbox"]',
    );
    expect(resetRows.length).toBe(2);
    for (const row of resetRows) expect(await row.getAttribute("aria-checked")).toBe("true");
    await $("[data-testid=conversation-share-selection-apply]").click();
    await $("[data-testid=conversation-share-trigger]").click();
    await selectV4TaskById(sessionB!);
    await $("[data-testid=conversation-share-trigger]").click();
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    expect(
      await $("[data-testid=conversation-share-confirmation-dock] input").getValue(),
    ).toContain("session-b");
    await $("[data-testid=conversation-share-trigger]").click();

    const link = new URL(publishedUrl);
    const code = link.pathname.split("/").at(-1)!;
    const preview = await fetch(`${link.origin}/api/v1/shares/${code}/preview`);
    expect(preview.status).toBe(200);
    const { data } = (await preview.json()) as {
      data: { share: { created_at: number; expires_at: number } };
    };
    // 服务端按 confirm 时刻 + ttl_ms 计算到期时间；允许 1 分钟时钟与执行误差。
    expect(Math.abs(data.share.expires_at - data.share.created_at - THIRTY_DAYS_MS)).toBeLessThan(
      60_000,
    );

    // SHARE-MG02：设置页分享管理。发布请求带上来源会话，所以本机会话 A 的分享可以跳转；
    // 预置「其他设备会话」与「旧版无来源」两条分享，它们在本机索引里查不到，不显示跳转。
    const seed = await fetch(`${link.origin}/api/v1/shares/__e2e/seed-managed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          { title: "E2E share from another device", sourceSessionId: "e2e-foreign-session" },
          { title: "E2E legacy share without source" },
        ],
      }),
    });
    expect(seed.status).toBe(200);
    const {
      data: { share_ids: seededShareIds },
    } = (await seed.json()) as { data: { share_ids: [string, string] } };

    // 已登录但列表请求认证失效：业务码 3213 走 HTTP 400，不触发 Host 全局登录失效流程，
    // 用来覆盖 signedIn 仍为 true 时页面必须有出口（重试）且重试后重新加载。
    const failNext = await fetch(`${link.origin}/api/v1/shares/__e2e/fail-next-manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 400, code: 3213, msg: "e2e auth lost" }),
    });
    expect(failNext.status).toBe(200);

    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-shares"]').click();
    await $('[data-testid="share-management"][data-state="login_required"]').waitForDisplayed({
      timeout: 30_000,
    });
    await $('[data-testid="share-management-retry"]').click();
    await $('[data-testid="share-management"][data-state="ready"]').waitForDisplayed({
      timeout: 30_000,
    });
    const readRows = () =>
      browser.execute(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="share-management-item"]')].map(
          (row) => ({
            id: row.dataset.shareId!,
            title: row.querySelector("h3")?.textContent ?? "",
            status: row.dataset.shareStatus!,
            canOpenConversation: Boolean(
              row.querySelector('[data-testid="share-management-open-conversation"]'),
            ),
          }),
        ),
      );
    // 跳转目标在列表加载后异步解析；等本机分享的跳转按钮出现再读取整表。
    await browser
      .waitUntil(
        async () =>
          (await readRows()).some((row) => row.title === publishedTitle && row.canOpenConversation),
        { timeout: 15_000 },
      )
      .catch(async () => {
        throw new Error(
          `本机会话的分享没有显示跳转对话: ${JSON.stringify({
            publishedTitle,
            sessionA,
            rows: await readRows(),
            stored: await (await fetch(`${link.origin}/api/v1/shares/__e2e/managed`)).json(),
          })}`,
        );
      });
    const rows = await readRows();
    const published = rows.find((row) => row.title === publishedTitle)!;
    expect(published.status).toBe("active");
    for (const seededId of seededShareIds) {
      expect(rows.find((row) => row.id === seededId)?.canOpenConversation).toBe(false);
    }
    // 只读：设置页不提供修改可见范围、导入权限或有效期。
    expect(await $('[data-testid="share-management"] [role="combobox"]').isExisting()).toBe(false);

    const row = (shareId: string) =>
      $(`[data-testid="share-management-item"][data-share-id="${shareId}"]`);
    // 上一个菜单的退出动画期间，新菜单会被当成外部点击立即关闭；先等旧菜单卸载再打开。
    const runMenuAction = async (shareId: string, action: string) => {
      await $('[data-testid="share-management-menu"]').waitForExist({ reverse: true });
      await row(shareId).$('[data-testid="share-management-more"]').click();
      await $(`[data-testid="share-management-${action}"]`).click();
    };
    const confirmDialog = async (kind: "revoke" | "delete") => {
      const dialog = await $(`[data-testid="share-management-confirm"][data-kind="${kind}"]`);
      await dialog.waitForDisplayed();
      await dialog.$('[data-testid="share-management-confirm-action"]').click();
      await dialog.waitForExist({ reverse: true });
    };
    const waitForStatus = (shareId: string, status: "active" | "revoked") =>
      $(
        `[data-testid="share-management-item"][data-share-id="${shareId}"][data-share-status="${status}"]`,
      ).waitForExist({ timeout: 15_000 });

    // 停止分享需要确认；停止后公开预览返回「已撤销」，恢复后重新可访问。
    await runMenuAction(published.id, "revoke");
    await confirmDialog("revoke");
    await waitForStatus(published.id, "revoked");
    expect((await fetch(`${link.origin}/api/v1/shares/${code}/preview`)).status).toBe(410);
    await runMenuAction(published.id, "restore");
    await waitForStatus(published.id, "active");
    expect((await fetch(`${link.origin}/api/v1/shares/${code}/preview`)).status).toBe(200);

    // 删除需要确认；确认后从列表移除。
    await runMenuAction(seededShareIds[1], "delete");
    await confirmDialog("delete");
    await row(seededShareIds[1]).waitForExist({ reverse: true });

    // 当前在会话 B；跳转对话离开设置页并切到发布来源会话 A。
    await row(published.id).$('[data-testid="share-management-open-conversation"]').click();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionA,
      "分享管理跳转对话后没有切到来源会话",
      30_000,
      V4_MAIN_PANE_ID,
    );
    await $('[data-testid="share-management"]').waitForExist({ reverse: true });
  });

  it("SHARE25：选择阶段检查最终预览卡片，PDF 分享、视频 warning、正文路径不入候选", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await mkdir(PREVIEW_CASE_ROOT, { recursive: true });
    await writeFile(join(PREVIEW_CASE_ROOT, PREVIEW_PDF), "%PDF-1.4\n");
    for (const video of PREVIEW_VIDEOS) {
      await writeFile(join(PREVIEW_CASE_ROOT, video), "synthetic-video");
    }

    await sendV4Prompt(
      `${PREVIEW_CASE_MARKER}: reply with the prepared preview-card paths and the plain home path.`,
    );
    await waitForV4AssistantMessageContaining(PREVIEW_PDF);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "预览卡片分享前会话没有进入终态",
      90_000,
    );

    await (await $("[data-testid=conversation-share-trigger]")).click();
    const preflightStatus = await $("[data-testid=conversation-share-selection-preflight-status]");
    await preflightStatus.waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(
      async () => (await preflightStatus.getAttribute("aria-busy")) !== "true",
      { timeout: 30_000, timeoutMsg: "分享候选预检没有完成" },
    );
    await preflightStatus.click();
    const preflightPopover = await $(
      "[data-testid=conversation-share-selection-preflight-popover]",
    );
    await preflightPopover.waitForDisplayed();
    const preflightText = await preflightPopover.getText();
    for (const video of PREVIEW_VIDEOS) expect(preflightText).toContain(video);
    expect(preflightText).not.toContain(PREVIEW_PDF);
    expect(preflightText).not.toContain("layout-review.md");
    await browser.keys("Escape");
    expect(await $("[data-testid=conversation-share-confirm]").isEnabled()).toBe(true);
    await selectSharePermission("link-viewer");
    await $("[data-testid=conversation-share-disclosure-checkbox]").click();
    await $("[data-testid=conversation-share-confirm]").click();

    const successDock = await $("[data-testid=conversation-share-success-dock]");
    await successDock.waitForDisplayed({ timeout: 120_000 });
    const successWarning = await successDock.$("[data-testid=conversation-share-success-warning]");
    await successWarning.waitForDisplayed();
    await successWarning.$("summary").click();
    const successText = await successDock.getText();
    for (const video of PREVIEW_VIDEOS) expect(successText).toContain(video);
    expect(successText).not.toContain("layout-review.md");
  });

  for (const text of ["file:///workspace/report.pdf", "data:text/plain;base64,YQ=="]) {
    it(`SHARE18/SHARE-E2E-03 URI text passes share preflight: ${text}`, async function () {
      this.timeout(150_000);
      await prepareV4ConversationE2E();
      await sendV4Prompt(`E2E_CONVERSATION_SHARE_URI_V1: reply exactly with ${text}`);
      await waitForV4AssistantMessageContaining(text);
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle",
        "分享前会话没有进入终态",
        90_000,
      );
      await $('[data-testid="conversation-share-trigger"]').click();
      await $('[data-testid="conversation-share-popover"]').waitForDisplayed();
      const confirm = await $('[data-testid="conversation-share-confirm"]');
      await browser.waitUntil(async () => await confirm.isEnabled(), { timeout: 30_000 });
      await confirm.click();
      expect(await $('[data-testid="conversation-share-disclosure-checkbox"]').isFocused()).toBe(
        true,
      );
    });
  }
});
