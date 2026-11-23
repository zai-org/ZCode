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
// 回放 fixture 每条只匹配一次（maxMatches: 1），本用例使用独立 marker，不与 SHARE18/SHARE25 抢录制。
const REJECT_CASE_MARKER = "E2E_CONVERSATION_SHARE_REJECT_V1";
const ARTIFACT_LIMIT_CASE_MARKER = "E2E_CONVERSATION_SHARE_ARTIFACT_LIMIT_V1";
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
    // 修复原因：勾选后面板会异步预检分享内容（“正在检查分享内容…”），期间确认按钮 disabled 且
    // pointer-events-none，点击会落到外层 div 被判定为 click intercepted；Windows 预检更慢，须等按钮可用。
    await $("[data-testid=conversation-share-selection-apply]").waitForEnabled({ timeout: 30000 });
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

  it("SHARE-E2E-04：服务端拒绝产物上传时指出文件与轮次，需取消该轮后才能重新生成", async function () {
    this.timeout(240_000);
    const mockBaseUrl = process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL?.trim();
    expect(mockBaseUrl).toBeTruthy();
    await prepareV4ConversationE2E();
    // 上一个用例的成功浮窗仍停在原会话；新建草稿保证本用例从干净会话开始。
    await startNewV4Draft();
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await mkdir(PREVIEW_CASE_ROOT, { recursive: true });
    await writeFile(join(PREVIEW_CASE_ROOT, PREVIEW_PDF), "%PDF-1.4\n");
    for (const video of PREVIEW_VIDEOS) {
      await writeFile(join(PREVIEW_CASE_ROOT, video), "synthetic-video");
    }
    // 先留一轮纯文本：取消产物所在轮后仍有可发布内容，证明“取消该轮”就是可行的修复路径。
    await sendV4Prompt(`${REJECT_CASE_MARKER}: reply with exactly share-reject-ready`);
    await waitForV4AssistantMessageContaining("share-reject-ready");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "第一轮分享前会话没有进入终态",
      90_000,
    );
    await sendV4Prompt(
      `${REJECT_CASE_MARKER}: reply with the prepared preview-card paths and the plain home path.`,
    );
    await waitForV4AssistantMessageContaining(PREVIEW_PDF);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "预览卡片分享前会话没有进入终态",
      90_000,
    );
    // 模拟服务端内容校验拒绝 PDF：只带 rule，artifact_id 由 mock 补成本次上传的产物。
    const injected = await fetch(`${mockBaseUrl}/api/v1/shares/__e2e/fail-next-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: 422,
        code: 3208,
        msg: "share artifact type not allowed",
        data: { rule: "pdf_structure_invalid" },
      }),
    });
    expect(injected.status).toBe(200);

    await (await $("[data-testid=conversation-share-trigger]")).click();
    const confirm = await $("[data-testid=conversation-share-confirm]");
    await browser.waitUntil(async () => await confirm.isEnabled(), { timeout: 60_000 });
    await selectSharePermission("link-viewer");
    await $("[data-testid=conversation-share-disclosure-checkbox]").click();
    await confirm.click();

    const errorDetails = await $("[data-testid=conversation-share-error-details]");
    await errorDetails.waitForDisplayed({ timeout: 120_000 });
    const errorText = await errorDetails.getText();
    expect(errorText).toContain(PREVIEW_PDF);
    expect(errorText).toMatch(/已损坏或格式不完整|damaged or incomplete/iu);
    // 公开投影改写了 productTurnId；轮次序号必须按本地身份换算回来，不能显示“第 — 轮”。
    expect(errorText).toMatch(/第 2 轮|turn 2/iu);
    // 服务端确定拒绝后原样重试必然失败：按钮置灰并提示先调整。
    expect(await confirm.isEnabled()).toBe(false);
    expect(await $("[data-testid=conversation-share-confirmation-actions]").getText()).toMatch(
      /取消有问题的轮次|Deselect the turns with issues/iu,
    );

    await errorDetails.$("[data-testid=conversation-share-issue-deselect]").click();
    await errorDetails.waitForExist({ reverse: true, timeout: 10_000 });
    await browser.waitUntil(async () => await confirm.isEnabled(), {
      timeout: 60_000,
      timeoutMsg: "取消问题轮次后仍不能重新生成链接",
    });
    await $("[data-testid=conversation-share-disclosure-checkbox]").click();
    await confirm.click();
    await $("[data-testid=conversation-share-success-dock]").waitForDisplayed({ timeout: 120_000 });
  });

  it("SHARE-E2E-05：产物数量上限按当前选中轮聚合，取消产物轮即解除、重新勾选即重现", async function () {
    this.timeout(240_000);
    const mockBaseUrl = process.env.ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL?.trim();
    expect(mockBaseUrl).toBeTruthy();
    const setCapabilities = async (overrides: Record<string, number>) => {
      const response = await fetch(`${mockBaseUrl}/api/v1/shares/__e2e/capabilities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides),
      });
      expect(response.status).toBe(200);
    };
    // prepareV4ConversationE2E 已回到夹具项目的新草稿；不再点侧栏“新任务”：单独运行本例时，
    // 那会落到不属于项目的草稿工作区，预览文件不在该工作区内，PDF 不会成为产物。
    await prepareV4ConversationE2E();
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await mkdir(PREVIEW_CASE_ROOT, { recursive: true });
    await writeFile(join(PREVIEW_CASE_ROOT, PREVIEW_PDF), "%PDF-1.4\n");
    for (const video of PREVIEW_VIDEOS) {
      await writeFile(join(PREVIEW_CASE_ROOT, video), "synthetic-video");
    }
    await sendV4Prompt(
      `${ARTIFACT_LIMIT_CASE_MARKER}: reply with exactly share-artifact-limit-ready`,
    );
    await waitForV4AssistantMessageContaining("share-artifact-limit-ready");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "第一轮分享前会话没有进入终态",
      90_000,
    );
    await sendV4Prompt(
      `${ARTIFACT_LIMIT_CASE_MARKER}: reply with the prepared preview-card paths and the plain home path.`,
    );
    await waitForV4AssistantMessageContaining(PREVIEW_PDF);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "预览卡片分享前会话没有进入终态",
      90_000,
    );

    // 上限设为 0：只有 PDF 轮有会上传的文件，全选必然超限，只选纯文本轮必然不超限。
    await setCapabilities({ max_artifact_count: 0 });
    try {
      const countLimitPattern = /产物数量为 1，超过上限 0|has 1 artifacts, above the limit of 0/u;
      const readPreflightPopover = async () => {
        const status = await $("[data-testid=conversation-share-selection-preflight-status]");
        await status.waitForDisplayed({ timeout: 60_000 });
        await status.click();
        const popover = await $("[data-testid=conversation-share-selection-preflight-popover]");
        await popover.waitForDisplayed();
        const text = await popover.getText();
        await browser.keys("Escape");
        await popover.waitForDisplayed({ reverse: true });
        return text;
      };
      const toggleSecondTurn = async () => {
        await $("[data-testid=conversation-share-adjust]").click();
        const panel = await $("[data-testid=conversation-share-selection-panel]");
        await panel.waitForDisplayed();
        const items = await panel.$$('[data-conversation-share-selection-item="true"]');
        expect(items.length).toBe(2);
        await items[1]!.$('[role="checkbox"]').click();
        await $("[data-testid=conversation-share-selection-apply]").click();
        await panel.waitForDisplayed({ reverse: true });
      };

      await (await $("[data-testid=conversation-share-trigger]")).click();
      await $("[data-testid=conversation-share-popover]").waitForDisplayed();
      const confirm = await $("[data-testid=conversation-share-confirm]");
      expect(await readPreflightPopover()).toMatch(countLimitPattern);
      expect(await confirm.isEnabled()).toBe(false);

      // 修复前：合计超限项挂在每一轮的缓存上，取消 PDF 轮不会重新预检，纯文本轮仍带着旧超限项。
      await toggleSecondTurn();
      await browser.waitUntil(async () => await confirm.isEnabled(), {
        timeout: 15_000,
        timeoutMsg: "取消产物所在轮后「生成链接」仍不可用",
      });
      expect(
        await $("[data-testid=conversation-share-selection-preflight-status]").isExisting(),
      ).toBe(false);

      // 重新勾选：两轮都走缓存，超限项必须按当前选择重新聚合出来。
      await toggleSecondTurn();
      await browser.waitUntil(async () => !(await confirm.isEnabled()), {
        timeout: 15_000,
        timeoutMsg: "重新勾选产物所在轮后没有恢复数量超限阻断",
      });
      expect(await readPreflightPopover()).toMatch(countLimitPattern);
    } finally {
      await setCapabilities({});
    }
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
