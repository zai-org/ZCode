import assert from "node:assert/strict";
import { test } from "node:test";

export function registerShareBoundaryTests(environment) {
  for (const theme of ["light", "dark"]) {
    test(`SHARE34 overlapping panels resize ${theme}`, async () => {
      const { browser, origin } = environment();
      const page = await browser.newPage({ viewport: { width: 680, height: 768 } });
      await page.goto(`${origin}fixture?theme=${theme}&locale=zh-CN&items=2`);
      await page.getByTestId("conversation-share-trigger").click();
      await page.getByTestId("conversation-share-adjust").click();
      const panel = page.getByTestId("conversation-share-selection-panel");
      await panel.waitFor();
      await page.waitForFunction(() => {
        const panel = document
          .querySelector('[data-testid="conversation-share-selection-panel"]')
          .getBoundingClientRect();
        const settings = document
          .querySelector('[data-testid="conversation-share-popover"]')
          .getBoundingClientRect();
        return panel.top >= settings.bottom + 7;
      });
      await panel.getByTestId("conversation-share-selection-locate").first().click();
      assert.equal(await page.getByTestId("inspected").innerText(), "1");
      await page.screenshot({ path: `/tmp/share-overlap-${theme}.png` });
      await page.setViewportSize({ width: 1200, height: 768 });
      await page.waitForFunction(() => {
        const panel = document
          .querySelector('[data-testid="conversation-share-selection-panel"]')
          .getBoundingClientRect();
        const settings = document
          .querySelector('[data-testid="conversation-share-popover"]')
          .getBoundingClientRect();
        return panel.right < settings.left && panel.top < settings.bottom;
      });
      await panel.getByTestId("conversation-share-selection-cancel").click();
      await page.close();
    });
  }
  const open = async (query = "") => {
    const { browser, origin } = environment();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`${origin}fixture?theme=light&locale=zh-CN&${query}`);
    await page.getByTestId("conversation-share-trigger").click();
    await page.getByTestId("conversation-share-adjust").click();
    const panel = page.getByTestId("conversation-share-selection-panel");
    await panel.waitFor();
    return {
      page,
      panel,
      apply: panel.getByTestId("conversation-share-selection-apply"),
      summary: panel.getByTestId("conversation-share-selection-summary"),
    };
  };
  for (const [count, limit] of [
    [499, 500],
    [500, 500],
    [501, 500],
    [251, 250],
  ]) {
    test(`SHARE34 capacity ${count}/${limit}`, async () => {
      const { page, apply, summary } = await open(`items=2&budget=${count}&limit=${limit}`);
      assert.equal(await apply.isDisabled(), count > limit);
      if (count > limit) assert.equal(await summary.innerText(), `超出上限 ${count - limit} 行`);
      else assert.equal(await summary.innerText(), "已选 2 轮");
      await page.close();
    });
  }
  for (const query of ["items=0", "items=2&running=1"]) {
    test(`SHARE34 no eligible turns ${query}`, async () => {
      const { page, panel, apply, summary } = await open(query);
      assert.equal(await panel.getByTestId("conversation-share-selection-all").isDisabled(), true);
      assert.equal(await apply.isDisabled(), true);
      assert.equal(await summary.innerText(), "已选 0 轮");
      if (query.includes("running")) {
        const toggle = panel.getByTestId("conversation-share-selection-toggle").first();
        assert.equal(await toggle.isDisabled(), true);
        await panel.getByTestId("conversation-share-selection-locate").first().click();
        assert.equal(await page.getByTestId("inspected").innerText(), "1");
        assert.equal(await summary.innerText(), "已选 0 轮");
      }
      await page.close();
    });
  }
  test("SHARE34 grouped product turns stay atomic", async () => {
    const { page, panel, summary } = await open("items=3&grouped=1");
    const toggles = panel.getByTestId("conversation-share-selection-toggle");
    const rows = panel.locator("[data-conversation-share-selection-item]");
    assert.equal(await summary.innerText(), "已选 2 轮");
    await toggles.first().press("Enter");
    assert.equal(await summary.innerText(), "已选 1 轮");
    for (const i of [0, 1])
      assert.equal(await rows.nth(i).getByRole("checkbox").isChecked(), false);
    await panel.getByTestId("conversation-share-selection-all").click();
    assert.equal(await summary.innerText(), "已选 2 轮");
    assert.equal(await rows.locator('[role="checkbox"][data-state="checked"]').count(), 3);
    await page.close();
  });
  test("SHARE34 over-limit draft cancels or commits independently", async () => {
    const { page, panel, apply, summary } = await open();
    await page.getByTestId("toggle-limit").click();
    assert.equal(await summary.innerText(), "超出上限 110 行");
    const range = page.getByTestId("conversation-share-range-summary");
    const initial = await range.innerText();
    await panel.getByTestId("conversation-share-selection-toggle").first().click();
    assert.equal(await summary.innerText(), "已选 7 轮");
    assert.equal(await range.innerText(), initial);
    await panel.getByTestId("conversation-share-selection-cancel").click();
    await page.getByTestId("conversation-share-adjust").click();
    assert.equal(await summary.innerText(), "超出上限 110 行");
    await panel.getByTestId("conversation-share-selection-toggle").first().click();
    await apply.click();
    assert.match(await range.innerText(), /7/);
    await page.getByTestId("conversation-share-adjust").click();
    assert.equal(await summary.innerText(), "已选 7 轮");
    await page.close();
  });
  test("SHARE34 resize and shorter content remove obsolete masks", async () => {
    const { page, panel } = await open("items=25");
    const viewport = panel.locator('[data-slot="scroll-area-viewport"]');
    await viewport.evaluate((node) => {
      node.scrollTop = 200;
    });
    await page.waitForFunction(() =>
      document.querySelector('[data-slot="scroll-area-viewport"]').style.maskImage.includes("32px"),
    );
    await page.setViewportSize({ width: 1100, height: 700 });
    const header = panel.getByTestId("conversation-share-selection-header");
    const footer = panel.getByTestId("conversation-share-selection-footer");
    await page.getByTestId("short-list").click();
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-slot="scroll-area-viewport"]');
      return (
        node.scrollHeight <= node.clientHeight + 1 && getComputedStyle(node).maskImage === "none"
      );
    });
    assert.equal((await header.boundingBox()).y, (await panel.boundingBox()).y);
    const p = await panel.boundingBox(),
      f = await footer.boundingBox();
    assert.ok(Math.abs(p.y + p.height - f.y - f.height) < 1);
    assert.ok(f.y + f.height <= 700);
    assert.equal(await panel.getByTestId("conversation-share-selection-apply").isVisible(), true);
    await page.close();
  });
  test("SHARE34 task drafts, failed retry and result actions", async () => {
    const { page, panel } = await open("items=3");
    await panel.getByTestId("conversation-share-selection-toggle").first().click();
    await panel.getByTestId("conversation-share-selection-apply").click();
    const popover = page.getByTestId("conversation-share-popover");
    await popover.getByRole("textbox").fill("任务 A 分享");
    await page.getByTestId("conversation-share-disclosure-checkbox").check();
    await page.getByTestId("switch").click();
    await popover.waitFor({ state: "hidden" });
    await page.getByTestId("conversation-share-trigger").click();
    assert.notEqual(await popover.getByRole("textbox").inputValue(), "任务 A 分享");
    assert.equal(
      await page.getByTestId("conversation-share-disclosure-checkbox").isChecked(),
      false,
    );
    assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /3/);
    await popover.getByRole("textbox").fill("任务 B 分享");
    await page.getByTestId("switch").click();
    assert.equal(await popover.getByRole("textbox").inputValue(), "任务 A 分享");
    assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /2/);
    assert.equal(
      await page.getByTestId("conversation-share-disclosure-checkbox").isChecked(),
      true,
    );
    await page.getByTestId("conversation-share-confirm").click();
    await page.getByTestId("advance-publish").click();
    await page.getByTestId("switch").click();
    assert.equal(await popover.getByRole("textbox").inputValue(), "任务 B 分享");
    assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
    await page.getByTestId("switch").click();
    assert.equal(
      await page
        .getByTestId("conversation-share-publish-phase-uploading")
        .getAttribute("data-phase-state"),
      "active",
    );
    await page.getByTestId("fail-publish").click();
    await page.getByTestId("conversation-share-error-details").waitFor();
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    await page.getByTestId("conversation-share-trigger").click();
    await page.getByTestId("conversation-share-error-details").waitFor();
    await page.getByTestId("conversation-share-confirm").click();
    await page.getByTestId("conversation-share-error-details").waitFor({ state: "hidden" });
    assert.match(
      await page.getByTestId("conversation-share-publish-progress").innerText(),
      /任务 A 分享/,
    );
    await page.getByTestId("resolve-publish").click();
    const url = await popover.getByRole("textbox").inputValue();
    await page.getByTestId("conversation-share-copy-link").click();
    await page.getByTestId("conversation-share-open-browser").click();
    assert.equal(await page.getByTestId("copied-url").innerText(), url);
    assert.equal(await page.getByTestId("opened-url").innerText(), url);
    await page.getByTestId("switch").click();
    assert.equal(await popover.getByRole("textbox").inputValue(), "任务 B 分享");
    assert.equal(await page.getByTestId("conversation-share-success-dock").count(), 0);
    await page.close();
  });
  test("SHARE34 preflight hint stays compact and aligned", async () => {
    const { browser, origin } = environment();
    for (const width of [390, 1200])
      for (const theme of ["light", "dark"]) {
        const locale = theme === "dark" ? "en-US" : "zh-CN";
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}&items=50&issue=1`);
        await page.getByTestId("conversation-share-trigger").click();
        const trigger = page.getByTestId("conversation-share-selection-preflight-status");
        await trigger.waitFor();
        await page.evaluate(async () => {
          await Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => {})),
          );
        });
        const metrics = await trigger.evaluate((node) => {
          const icon = node.querySelector("svg");
          const text = node.querySelector("span");
          const bounds = node.getBoundingClientRect();
          return {
            align: getComputedStyle(node).textAlign,
            height: bounds.height,
            iconWidth: icon.getBoundingClientRect().width,
            textHeight: text.getBoundingClientRect().height,
            text: text.textContent,
            overflow: node.scrollWidth > node.clientWidth,
          };
        });
        assert.equal(metrics.align, "left");
        assert.equal(metrics.iconWidth, 16);
        assert.ok(metrics.textHeight <= 20, JSON.stringify(metrics));
        assert.equal(metrics.overflow, false);
        assert.equal(
          metrics.text,
          locale === "en-US" ? "Review share issues" : "有内容无法分享，查看问题",
        );
        await page.screenshot({ path: `/tmp/share-preflight-${width}-${theme}.png` });
        await trigger.click();
        await page.getByTestId("conversation-share-selection-preflight-popover").waitFor();
        assert.equal(
          await page
            .getByTestId("conversation-share-selection-preflight-popover")
            .getByRole("button")
            .count(),
          1,
        );
        await page.close();
      }
  });
  for (const action of ["cancel", "apply"]) {
    test(`SHARE34 issue deselection respects pending ${action}`, async () => {
      const { page, panel } = await open("items=3&issue=1");
      await page.getByTestId("conversation-share-selection-preflight-status").click();
      await page
        .getByTestId("conversation-share-selection-preflight-popover")
        .getByRole("button", { name: "取消选择此轮" })
        .click();
      assert.equal(
        await panel
          .locator("[data-conversation-share-selection-item]")
          .first()
          .getByRole("checkbox")
          .isChecked(),
        false,
      );
      assert.equal(
        await panel.getByTestId("conversation-share-selection-summary").innerText(),
        "已选 2 轮",
      );
      assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /3/);
      await panel.getByTestId(`conversation-share-selection-${action}`).click();
      assert.match(
        await page.getByTestId("conversation-share-range-summary").innerText(),
        action === "apply" ? /2/ : /3/,
      );
      await page.getByTestId("conversation-share-adjust").click();
      assert.equal(
        await panel
          .locator("[data-conversation-share-selection-item]")
          .first()
          .getByRole("checkbox")
          .isChecked(),
        action === "cancel",
      );
      await page.close();
    });
  }
  for (const mode of ["reopen", "open"]) {
    test(`SHARE34 new completed content invalidates disclosure ${mode}`, async () => {
      const { page, panel } = await open();
      await panel.getByTestId("conversation-share-selection-cancel").click();
      const disclosure = page.getByTestId("conversation-share-disclosure-checkbox");
      await disclosure.check();
      if (mode === "reopen") {
        await page.keyboard.press("Escape");
        await page.getByTestId("conversation-share-popover").waitFor({ state: "hidden" });
      }
      await page.getByTestId("complete-turn").click();
      if (mode === "reopen") await page.getByTestId("conversation-share-trigger").click();
      assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /9/);
      assert.equal(await disclosure.isChecked(), false);
      await page.getByTestId("conversation-share-confirm").click();
      assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
      await disclosure.check();
      await page.getByTestId("conversation-share-confirm").click();
      await page.getByTestId("conversation-share-publish-progress").waitFor();
      await page.close();
    });
  }
}
