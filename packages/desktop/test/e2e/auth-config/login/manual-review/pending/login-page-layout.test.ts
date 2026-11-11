import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  TID_LOGIN_API_KEY_CANCEL_BUTTON,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_TRIGGER,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_OAUTH_LOGIN_BUTTON,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { clearRendererViewport, setRendererViewport } from "#e2e/helpers/renderer-viewport";

const viewports = [
  [1280, 800],
  [390, 680],
  [640, 400],
] as const;

describe("Login page layout", () => {
  after(async () => {
    await clearRendererViewport();
    await clearAppData();
  });

  for (const theme of ["zai-light", "zai-dark"] as const) {
    for (const locale of ["en-US", "zh-CN"] as const) {
      it(`${theme} ${locale}: card and footer remain reachable at desktop, narrow and short sizes`, async () => {
        await browser.waitUntil(
          async () => {
            if (await $('[data-testid="onboarding-page"]').isExisting())
              await browser.keys("Escape");
            return browser.execute(() =>
              Boolean(
                document.querySelector(
                  '[data-testid="login-trigger"], [data-testid="oauth-login-button"]',
                ),
              ),
            );
          },
          { timeout: 60000 },
        );
        if (!(await $(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting())) {
          await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
          await browser.waitUntil(() =>
            browser.execute(
              (menu, login) =>
                Boolean(
                  document.querySelector(`[data-testid="${menu}"], [data-testid="${login}"]`),
                ),
              TID_LOGIN_MENU_ITEM,
              TID_OAUTH_LOGIN_BUTTON,
            ),
          );
          if (await $(`[data-testid="${TID_LOGIN_MENU_ITEM}"]`).isExisting())
            await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
        }
        await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
        await browser.execute(
          (nextTheme, nextLocale) => {
            const element = document.querySelector('[data-testid="oauth-login-button"]')!;
            const key = Object.keys(element).find((name) => name.startsWith("__reactFiber"))!;
            let fiber = (element as unknown as Record<string, any>)[key];
            let changedTheme = false;
            let changedLocale = false;
            while (fiber) {
              const value = fiber.memoizedProps?.value;
              if (!changedTheme && value?.getState?.().setTheme) {
                value.getState().setTheme(nextTheme);
                changedTheme = true;
              }
              if (!changedLocale && value?.setLocalePreference) {
                value.setLocalePreference(nextLocale);
                changedLocale = true;
              }
              fiber = fiber.return;
            }
            if (!changedTheme || !changedLocale)
              throw new Error("presentation context unavailable");
          },
          theme,
          locale,
        );
        await browser.waitUntil(() =>
          browser.execute((value) => document.documentElement.lang === value, locale),
        );
        const artifacts = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "login-layout");
        await mkdir(artifacts, { recursive: true });
        for (const [width, height] of viewports) {
          await setRendererViewport(width, height);
          for (const mode of ["login", "api-key"] as const) {
            if (mode === "api-key") await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON);
            await waitForTestIdByDom(
              mode === "api-key" ? TID_LOGIN_API_KEY_SKIP_BUTTON : TID_OAUTH_LOGIN_BUTTON,
            );
            await browser.execute(() =>
              document
                .querySelector("main")
                ?.querySelector("section")
                ?.scrollIntoView({ block: "start" }),
            );
            const metrics = await browser.execute(() => {
              const card = document.querySelector("main section")!;
              const footer = document.querySelector("main footer")!;
              const heading = card.querySelector("header")!;
              const actions = heading.nextElementSibling!;
              const bounds = card.getBoundingClientRect();
              const foot = footer.getBoundingClientRect();
              return {
                border: getComputedStyle(card).borderTopWidth,
                shadow: getComputedStyle(card).boxShadow,
                gap: actions.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
                separation: foot.top - bounds.bottom,
                cardWithinWidth: bounds.left >= 0 && bounds.right <= innerWidth,
                controlsWithinWidth: [...card.querySelectorAll("button,input")].every((node) => {
                  const rect = node.getBoundingClientRect();
                  return rect.left >= bounds.left && rect.right <= bounds.right;
                }),
              };
            });
            const name = `${theme}-${locale}-${width}x${height}-${mode}`;
            await browser.saveScreenshot(join(artifacts, `${name}.png`));
            await writeFile(join(artifacts, `${name}.json`), JSON.stringify(metrics, null, 2));
            expect(metrics).toMatchObject({
              border: "0px",
              gap: 28,
              cardWithinWidth: true,
              controlsWithinWidth: true,
            });
            expect(metrics.shadow).not.toBe("none");
            expect(metrics.separation).toBeGreaterThanOrEqual(24);
            await browser.execute(() =>
              document.querySelector("main footer")?.scrollIntoView({ block: "end" }),
            );
            expect(
              await browser.execute(() => {
                const rect = document.querySelector("main footer")!.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= innerHeight;
              }),
            ).toBe(true);
            if (mode === "api-key") await clickTestIdByDom(TID_LOGIN_API_KEY_CANCEL_BUTTON);
          }
        }
      });
    }
  }
});
