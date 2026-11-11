import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspaceRestoringPreferences } from "#e2e/helpers/model-provider-restart-runtime";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { sel } from "#e2e/helpers/selectors";

async function visibleNav(key: string) {
  const selector = sel(testId(TID_MODEL_PROVIDER_NAV_ITEM, key));
  await browser.waitUntil(
    async () => {
      for (const item of await $$(selector)) {
        if (await item.isDisplayed()) return true;
      }
      return false;
    },
    { timeout: 15000, timeoutMsg: `导航未出现：${key}` },
  );
  // 响应式布局保留隐藏副本，只操作当前可见导航。
  for (const item of await $$(selector)) {
    if (await item.isDisplayed()) return item;
  }
  throw new Error(`可见导航已消失：${key}`);
}

describe("套餐导航名称与身份回归", () => {
  let originalSize: Awaited<ReturnType<typeof setCurrentElectronRendererContentSize>> | undefined;
  afterEach(async () => {
    if (originalSize) await restoreElectronRendererContentSize(originalSize);
    originalSize = undefined;
  });
  after(async () => {
    await clearAppData();
  });

  for (const family of ["bigmodel", "zai"] as const) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      it(`PN-01/02: ${family} ${locale} 导航、详情及窄屏名称一致`, async function () {
        this.timeout(180000);
        await skipOccupationOnboardingIfPresent();
        await prepareV4ConversationE2E({ skipProvider: true });
        await restartIntoWorkspaceRestoringPreferences(DEFAULT_WORKSPACE, {
          afterElectronProcessExit: async () => {
            const file = join(getE2EAppDataPaths().appDataDir, "setting.json");
            const settings = JSON.parse(await readFile(file, "utf8"));
            await writeFile(
              file,
              JSON.stringify({
                ...settings,
                locale,
                localePreference: locale,
                providerFamilyDomain: family,
                providerFamilyDomainMigrated: true,
                providerFamilyConnectionSelections: {},
              }),
            );
          },
        });
        originalSize = await setCurrentElectronRendererContentSize(1280, 800);
        await browser.execute(
          (theme) => {
            const actions = (
              window as typeof window & { __testActions?: { setTheme?: (value: string) => void } }
            ).__testActions;
            if (!actions?.setTheme) throw new Error("missing setTheme action");
            actions.setTheme(theme);
          },
          locale === "zh-CN" ? "dark" : "light",
        );
        await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
        await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
        const id =
          family === "bigmodel"
            ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
            : BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan;
        const entries = [
          {
            key: `preset:${id}`,
            label: family === "bigmodel" ? "BigModel" : "Z.ai",
            title: family === "bigmodel" ? "BigModel" : "Z.ai",
          },
          {
            key: `coding-plan:${id}`,
            label: "Start Plan",
            title: "Start Plan",
          },
        ];
        for (const entry of entries) {
          const button = await visibleNav(entry.key);
          await expect(button).toHaveAttribute("aria-label", entry.label);
          await expect(button).toHaveText(entry.label);
          await button.click();
          await expect(await visibleNav(entry.key)).toHaveAttribute("aria-selected", "true");
          await browser.waitUntil(
            async () =>
              browser.execute(
                (title) =>
                  Array.from(document.querySelectorAll("h3")).some(
                    (node) =>
                      node.textContent?.trim() === title && node.getBoundingClientRect().width > 0,
                  ),
                entry.title,
              ),
            { timeout: 15000, timeoutMsg: `详情标题错误：${entry.title}` },
          );
        }
        if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, `plan-nav-${family}-${locale}-wide.png`),
          );
        }
        await setCurrentElectronRendererContentSize(600, 800);
        for (const entry of entries) {
          const button = await visibleNav(entry.key);
          await expect(button).toHaveAttribute("aria-label", entry.label);
          await browser.electron.execute((electron) => {
            electron.BrowserWindow.getAllWindows()
              .find((window) => window.isVisible())
              ?.focus();
          });
          await $("body").moveTo({ xOffset: -250, yOffset: -350 });
          await button.moveTo();
          await $('[data-slot="tooltip-content"]').waitForDisplayed({ timeout: 10000 });
          await expect($('[data-slot="tooltip-content"]')).toHaveText(entry.label);
          await browser.keys("Escape");
        }
        if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, `plan-nav-${family}-${locale}-narrow.png`),
          );
        }
      });
    }
  }
});
