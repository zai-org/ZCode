// SHARE-MG01：先启动 pnpm dev:web-share:mock，再运行本文件；仅使用开发态 fixture。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseUrl = process.env.SHARE_E2E_BASE_URL || "http://localhost:5173";
const HOUR_MS = 60 * 60 * 1000;
const browser = await chromium.launch({ channel: "chrome", headless: true });

// main 自带 overflow-x-hidden，只看 scrollWidth 会漏掉被裁切的卡片；同时检查卡片、行内控件与展开菜单的左右边界。
async function noHorizontalOverflow(page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth <= innerWidth &&
      [
        ...document.querySelectorAll(
          "[data-share-manage-item], [data-share-manage-item] *, [data-share-manage-menu] *",
        ),
      ].every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
      }),
  );
}

try {
  for (const locale of ["cn/share", "share"]) {
    for (const width of [320, 1280]) {
      for (const theme of ["zai-light", "zai-dark"]) {
        const chinese = locale === "cn/share";
        const t = (zh, en) => (chinese ? zh : en);
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.addInitScript((value) => localStorage.setItem("zcode-theme", value), theme);
        const page = await context.newPage();

        // 未登录：管理页显示管理专用的登录卡片，而不是被当成分享码请求 preview。
        await page.goto(`${baseUrl}/${locale}/manage`);
        await page
          .getByRole("heading", {
            name: t("登录后管理分享", "Sign in to manage your shares"),
            exact: true,
          })
          .waitFor();
        await page.locator('[data-share-login-provider="zai"]').click();

        // 登录后：第一页 20 条，加载更多后共 25 条且不重复。
        const items = page.locator("[data-share-manage-item]");
        await items.first().waitFor();
        assert.equal(await items.count(), 20);
        await page.locator('[data-share-manage-load-more="true"]').click();
        await page.waitForFunction(
          () => document.querySelectorAll("[data-share-manage-item]").length === 25,
        );
        assert.equal(await page.locator('[data-share-manage-load-more="true"]').count(), 0);
        const ids = await items.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-share-manage-item")),
        );
        assert.equal(new Set(ids).size, 25);
        assert.equal(await noHorizontalOverflow(page), true);

        // 行设置收在「⋯」更多菜单里；菜单内容渲染在 portal，需从 page 定位。
        // 上一个菜单的退出动画期间仍挂载 DismissableLayer，此时点击触发器会被当成外部点击而立刻关闭新菜单；
        // 所以先等旧菜单卸载，再等 data-state=open，避免把正在关闭的旧菜单误认为已打开。
        const openMenu = async (row) => {
          await page.locator("[data-share-manage-menu]").waitFor({ state: "detached" });
          await row.locator('[data-share-manage-more="true"]').click();
          await page.locator('[data-share-manage-menu="true"][data-state="open"]').waitFor();
        };
        const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });
        const radio = (name) => page.getByRole("menuitemradio", { name, exact: true });
        const summary = (row) => row.locator("[data-share-manage-summary]");

        // share-1 是私有分享：导入权限禁用；改为公开需要确认，取消后保持私有。
        const privateRow = page.locator('[data-share-manage-item="share-1"]');
        await openMenu(privateRow);
        const importOption = page.locator(
          '[data-share-manage-import="true"] [role="menuitemradio"]',
        );
        // 菜单展开时也不能超出视口（曾用子菜单，在 320px 下被推出左侧视口）。
        assert.equal(await noHorizontalOverflow(page), true);
        assert.deepEqual(
          await importOption.evaluateAll((nodes) =>
            nodes.map((n) => n.hasAttribute("data-disabled")),
          ),
          [true, true],
        );
        await radio(t("凭链接查看", "Anyone with the link")).click();
        const publicDialog = page.locator('[data-share-manage-confirm="make_public"]');
        await publicDialog.waitFor();
        await publicDialog.getByRole("button", { name: t("取消", "Cancel"), exact: true }).click();
        await publicDialog.waitFor({ state: "detached" });
        assert.equal(
          await summary(privateRow).getAttribute("data-share-manage-summary"),
          "private",
        );

        // 确认后变为凭链接查看 + 仅查看，导入权限可用。
        await openMenu(privateRow);
        await radio(t("凭链接查看", "Anyone with the link")).click();
        await publicDialog
          .getByRole("button", { name: t("确认公开", "Make visible"), exact: true })
          .click();
        await privateRow
          .locator('[data-share-manage-summary="public_readonly"]')
          .getByText(t("仅查看", "View only"), { exact: false })
          .waitFor();
        await openMenu(privateRow);
        assert.deepEqual(
          await importOption.evaluateAll((nodes) =>
            nodes.map((n) => n.hasAttribute("data-disabled")),
          ),
          [false, false],
        );

        // 有效期选项受服务端范围约束：mock 上限 7 天，菜单不出现 30 天。
        assert.deepEqual(
          await page
            .locator("[data-share-manage-ttl]")
            .evaluateAll((nodes) =>
              nodes.map((n) => Number(n.getAttribute("data-share-manage-ttl"))),
            ),
          [HOUR_MS, 24 * HOUR_MS, 7 * 24 * HOUR_MS],
        );

        // 修改有效期：从现在起 1 小时，摘要显示剩余小时数。
        const before = Date.now();
        await page.locator(`[data-share-manage-ttl="${HOUR_MS}"]`).click();
        await page.waitForFunction(
          ({ lower, upper }) => {
            const value = Number(
              document
                .querySelector('[data-share-manage-item="share-1"] [data-share-manage-expires-at]')
                ?.getAttribute("data-share-manage-expires-at"),
            );
            return value >= lower && value <= upper;
          },
          { lower: before + HOUR_MS, upper: Date.now() + HOUR_MS + 5_000 },
        );
        await summary(privateRow)
          .getByText(t("不足 1 小时", "Less than 1 hour left"), { exact: true })
          .or(summary(privateRow).getByText(t("剩余 1 小时", "1 hour left"), { exact: true }))
          .waitFor();

        // 撤销需要确认；撤销后显示「已撤销」并可恢复。
        const activeRow = page.locator('[data-share-manage-item="share-2"]');
        await openMenu(activeRow);
        await menuItem(t("撤销", "Revoke")).click();
        const revokeDialog = page.locator('[data-share-manage-confirm="revoke"]');
        await revokeDialog.getByRole("button", { name: t("撤销", "Revoke"), exact: true }).click();
        await page
          .locator('[data-share-manage-item="share-2"][data-share-manage-status="revoked"]')
          .waitFor();
        await openMenu(activeRow);
        await menuItem(t("恢复", "Restore")).click();
        await page
          .locator('[data-share-manage-item="share-2"][data-share-manage-status="active"]')
          .waitFor();

        // 删除需要确认；确认后从列表移除。
        await openMenu(activeRow);
        await menuItem(t("删除", "Delete")).click();
        const deleteDialog = page.locator('[data-share-manage-confirm="delete"]');
        await deleteDialog.getByRole("button", { name: t("删除", "Delete"), exact: true }).click();
        await activeRow.waitFor({ state: "detached" });
        assert.equal(await items.count(), 24);
        assert.equal(await noHorizontalOverflow(page), true);

        // 撤销的分享在落地页显示「分享已撤销」，且已登录时落地页有管理入口。
        await page.goto(`${baseUrl}/${locale}/mock-revoked`);
        await page
          .getByRole("heading", { name: t("分享已撤销", "Share revoked"), exact: true })
          .waitFor();
        await page.goto(`${baseUrl}/${locale}/mock-importable`);
        const manageLink = page.locator('[data-share-manage-link="true"]');
        await manageLink.waitFor();
        assert.equal(await manageLink.getAttribute("href"), `/${locale}/manage`);

        await context.close();
        console.log(`PASS SHARE-MG01 ${locale} ${width} ${theme}`);
      }
    }
  }

  // capabilities 慢响应不阻塞列表：返回前菜单没有有效期分组，返回后分组出现。
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/cn/share/manage`);
    await page.locator('[data-share-login-provider="zai"]').click();
    await page.locator("[data-share-manage-item]").first().waitFor();
    const delayMs = 4_000;
    const startedAt = Date.now();
    await page.goto(`${baseUrl}/cn/share/manage?mockTtlDelayMs=${delayMs}`);
    await page.locator("[data-share-manage-item]").first().waitFor();
    assert.ok(Date.now() - startedAt < delayMs, "列表被 capabilities 慢响应阻塞");
    const row = page.locator('[data-share-manage-item="share-1"]');
    await row.locator('[data-share-manage-more="true"]').click();
    await page.locator('[data-share-manage-menu="true"][data-state="open"]').waitFor();
    assert.equal(await page.locator('[data-share-manage-expiry="true"]').count(), 0);
    await page.keyboard.press("Escape");
    await page.locator("[data-share-manage-menu]").waitFor({ state: "detached" });
    await page.waitForTimeout(Math.max(0, startedAt + delayMs + 500 - Date.now()));
    await row.locator('[data-share-manage-more="true"]').click();
    await page.locator('[data-share-manage-menu="true"][data-state="open"]').waitFor();
    assert.equal(await page.locator("[data-share-manage-ttl]").count(), 3);
    await context.close();
    console.log("PASS SHARE-MG01 slow capabilities");
  }

  // capabilities 先返回 401、列表迟到成功：页面停留在登录页，迟到的列表不能把旧 token 的数据显示出来。
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/cn/share/manage`);
    await page.locator('[data-share-login-provider="zai"]').click();
    await page.locator("[data-share-manage-item]").first().waitFor();
    const delayMs = 1_500;
    await page.goto(`${baseUrl}/cn/share/manage?mockTtlAuthFail=1&mockListDelayMs=${delayMs}`);
    const signIn = page.getByRole("heading", { name: "登录后管理分享", exact: true });
    await signIn.waitFor();
    await page.waitForTimeout(delayMs + 1_000);
    assert.equal(await signIn.count(), 1, "迟到的列表响应把页面改离了登录页");
    assert.equal(await page.locator("[data-share-manage-item]").count(), 0, "登录页上出现了旧列表");
    await context.close();
    console.log("PASS SHARE-MG01 capabilities 401 before late list");
  }
} finally {
  await browser.close();
}
